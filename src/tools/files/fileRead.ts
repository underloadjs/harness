// fileRead — read a BOUNDED window of one or more UTF-8 text files.
//
// WHY BOUNDED BY DEFAULT (this revision)
// --------------------------------------
// The old contract read every requested file in full and returned the whole text.
// That is unsafe as a model-facing default: one minified bundle or log file can
// consume the entire context window, and the harness serializes tool results with
// no output cap of its own (see ../types/index.ts and harness.ts `serialize`).
// This implementation therefore enforces:
//
//   - a 1-based line window per file: `startLine` (default 1) plus `maxLines`
//     (default 200, hard maximum 5000);
//   - a fixed aggregate CONTENT budget of 64 KiB across the whole batch
//     (`FILE_READ_CONTENT_BUDGET`), split fairly between the remaining files;
//   - a 64 KiB streaming read chunk and a hard stop as soon as the budget is
//     reached, so a single huge file/line is never read wholesale;
//   - at most 100 paths per call, so thousands of empty files cannot inflate the
//     metadata side of the response;
//   - explicit binary rejection (NUL bytes or invalid UTF-8) for every byte
//     DECODED WHILE STREAMING, because replacing binary bytes with U+FFFD would be
//     a silently wrong answer. This is not whole-file validation: bytes after the
//     last read chunk (or after an early stop) are never inspected.
//
// The budget is CONTENT bytes (UTF-8, before JSON escaping), not the serialized
// JSON envelope. `contentBudget` is reported in the result so a caller can see the
// policy it is subject to; `bytes` reports exactly what this response consumed.
//
// WHY ONE ARRAY PROPERTY (T14 batching rule, preserved)
// ------------------------------------------------------
// Reading several files is one intent, not several round trips. The schema still
// declares exactly ONE property, `paths`, so the single-property rule (see
// ../core/tool.ts) hands `execute` the array itself:
//
//     fileRead(['a.ts', 'b.ts'])
//     fileRead([{ path: 'a.ts', startLine: 10, maxLines: 20 }])
//
// A model call carries `{ "paths": [...] }` and reaches this same code. Each item
// is either a path string (defaults: startLine 1, maxLines 200) or a range object
// `{ path, startLine?, startColumn?, maxLines? }`. Keeping the range on the item —
// rather than adding top-level properties — is deliberate: a second top-level
// property would disable the single-property rule and break every existing
// paths-only call.
//
// RESULT SHAPE
// ------------
//     {
//       files: [{ path, content, startLine, endLine, truncated,
//                 nextLine, nextColumn, bytes }],
//       truncated: boolean,          // any file truncated
//       bytes: number,               // total content bytes returned
//       contentBudget: number        // fixed aggregate content cap (64 KiB)
//     }
//
// `path` is the ABSOLUTE resolved path. `content` is raw text: line 1 of `content`
// corresponds to file line `startLine`, so line numbering is METADATA rather than
// prefixes inside the copied text. `endLine` is the last line represented (it may
// equal startLine for a partial line, and is startLine - 1 when nothing was
// returned).
//
// CONTINUATION
// ------------
// `truncated` means "more file content exists after this window". When true:
//   - `nextLine` is the 1-based line to request next;
//   - `nextColumn` is the 0-based UTF-8 BYTE offset within that line (0 at a line
//     boundary). A giant single line is the only reason this is non-zero: the
//     window was cut mid-line, and `{ path, startLine: nextLine,
//     startColumn: nextColumn }` resumes exactly where it stopped, at a code-point
//     boundary. Repeating the request pages through a line of any size.
// When false, `nextLine` and `nextColumn` are null and the window reached the end
// of the file.
//
// FAILURE SEMANTICS (all-or-nothing)
// ----------------------------------
// A blank/NUL/non-string path, an invalid range value, a directory, a missing
// file, or binary bytes ENCOUNTERED WHILE READING rejects the WHOLE call. There is
// no partial array: a short answer that looks complete would let a model conclude a
// file it never received is empty. Every filesystem error names the requested path.
//
// COST OF RANGES / CONTINUATIONS
// ------------------------------
// Line numbers require counting from the beginning, so a window at line N rescans
// the file from byte 0 and retains only the window. Memory stays bounded by the
// budget and chunk size, but a very deep startLine/startColumn costs time
// proportional to the skipped prefix on every request.
//
// No sandbox: paths are resolved against the process working directory and used as
// given. Run the harness under whatever process boundary the host provides (a
// container, a worktree, a scoped cwd), or wrap `execute`.
//
// Executable on its own and registerable on a harness:
//
//     await fileRead(['package.json']);
//     await fileRead([{ path: 'README.md', startLine: 20, maxLines: 40 }]);
//
// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.

import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

// Default and hard limits. These are exported so docs/tests can quote the same
// numbers the implementation enforces (and so a host cannot quietly disagree).
export const FILE_READ_DEFAULT_MAX_LINES = 200;
export const FILE_READ_MAX_LINES = 5000;
export const FILE_READ_CONTENT_BUDGET = 64 * 1024;
// A batch cap as well as a content cap: without it, thousands of empty files
// would still return thousands of metadata entries and blow the response up.
export const FILE_READ_MAX_TARGETS = 100;

// Read this many bytes at a time. Large enough to amortize syscalls, small enough
// that a huge single line cannot be pulled into memory before the budget stops it.
const READ_CHUNK_BYTES = 64 * 1024;

// Per-path request: a bare path keeps the old call shape, an object selects a
// window. All range fields are optional so `{ path }` is valid too.
export type FileReadTarget =
    | string
    | {
          // Path to read, absolute or relative to the process working directory.
          path: string;
          // 1-based first line to return. Defaults to 1.
          startLine?: number;
          // 0-based UTF-8 byte offset within startLine. Defaults to 0. This is the
          // continuation value reported as `nextColumn` for a giant line.
          startColumn?: number;
          // Maximum lines to return. Defaults to 200, hard maximum 5000.
          maxLines?: number;
      };

// One file's bounded window, in request order.
export type FileReadEntry = {
    // The absolute path that was read.
    path: string;
    // Raw UTF-8 text of the returned window. Line 1 is file line `startLine`.
    content: string;
    // 1-based line number of the first line represented by `content`.
    startLine: number;
    // 1-based line number of the last line represented by `content`. Equals
    // `startLine - 1` when no line was returned (empty file or EOF before the
    // requested range).
    endLine: number;
    // True when more file content exists after this window. See nextLine/nextColumn.
    truncated: boolean;
    // 1-based line to request next, or null when the window reached EOF.
    nextLine: number | null;
    // 0-based UTF-8 byte offset within nextLine, or null when not truncated.
    nextColumn: number | null;
    // UTF-8 bytes in `content`, the amount charged against the aggregate budget.
    bytes: number;
};

// The ordered batch result. `files` has exactly one entry per requested path.
export type FileReadResult = {
    files: FileReadEntry[];
    // True when at least one entry is truncated (line limit or content budget).
    truncated: boolean;
    // Total UTF-8 content bytes returned across `files`.
    bytes: number;
    // The fixed aggregate content budget this call was subject to. Metadata only:
    // it is not JSON-envelope aware (see the header comment).
    contentBudget: number;
};

// The value `execute` receives: the `paths` array itself (single-property rule).
export type FileReadParameters = FileReadTarget[];

// A validated request, with every default resolved.
type NormalizedTarget = {
    path: string;
    startLine: number;
    startColumn: number;
    maxLines: number;
};

// The binary rejection shared by the NUL and invalid-UTF-8 paths so the message
// (and therefore a test's expectation) cannot drift between them.
const binaryError = (path: string): HarnessError =>
    new HarnessError(
        `fileRead refused "${path}": the file contains binary data (NUL bytes or invalid UTF-8). fileRead reads UTF-8 text only.`
    );

// Validate one non-negative integer range field. `undefined` takes the default;
// anything else must be an integer in [minimum, maximum].
const readInteger = (
    value: unknown,
    field: string,
    defaultValue: number,
    minimum: number,
    maximum: number
): number => {
    if (value === undefined) return defaultValue;

    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
        throw new HarnessError(
            `fileRead ${field} must be an integer between ${minimum} and ${maximum}; received ${String(value)}.`
        );
    }

    return value as number;
};

// Validate every target BEFORE touching disk, so a typo in the last entry cannot
// produce a misleading partial answer (and so an invalid range never opens a file).
const normalizeTargets = (paths: FileReadParameters): NormalizedTarget[] => {
    if (!Array.isArray(paths)) {
        throw new HarnessError(
            'fileRead expects an array of paths (strings or { path, startLine, startColumn, maxLines } objects), e.g. ["package.json"].'
        );
    }

    if (paths.length === 0) {
        throw new HarnessError('fileRead received an empty paths array; pass at least one file path.');
    }

    if (paths.length > FILE_READ_MAX_TARGETS) {
        throw new HarnessError(
            `fileRead accepts at most ${FILE_READ_MAX_TARGETS} paths per call; received ${paths.length}. Split the batch.`
        );
    }

    return paths.map((target) => {
        // A bare string is the historical shape: whole file, bounded by defaults.
        if (typeof target === 'string') {
            return {
                path: validatePath(target),
                startLine: 1,
                startColumn: 0,
                maxLines: FILE_READ_DEFAULT_MAX_LINES
            };
        }

        // A range object must carry a usable path. Arrays/null/non-objects are
        // rejected with the same shape guidance as a non-array argument.
        if (target === null || typeof target !== 'object' || Array.isArray(target)) {
            throw new HarnessError(
                'fileRead paths must be strings or { path, startLine, startColumn, maxLines } objects.'
            );
        }

        return {
            path: validatePath(target.path),
            startLine: readInteger(target.startLine, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER),
            startColumn: readInteger(target.startColumn, 'startColumn', 0, 0, Number.MAX_SAFE_INTEGER),
            maxLines: readInteger(target.maxLines, 'maxLines', FILE_READ_DEFAULT_MAX_LINES, 1, FILE_READ_MAX_LINES)
        };
    });
};

// A path must be a non-empty string with no NUL. NUL cannot exist in a real path
// and a non-string (e.g. a model sending 7) would reach the filesystem as an
// unhelpful type error.
const validatePath = (path: unknown): string => {
    if (typeof path !== 'string' || path.length === 0) {
        throw new HarnessError('fileRead paths must be non-empty strings.');
    }

    if (path.includes('\u0000')) {
        throw new HarnessError('fileRead paths must not contain NUL characters.');
    }

    return path;
};

// The mutable scanner state for one file. Kept explicit so the streaming loop can
// stop at an exact character boundary and report where the next window starts.
type ScanState = {
    target: string;
    startLine: number;
    startColumn: number;
    maxLines: number;
    budget: number;
    lineNumber: number; // 1-based line currently being scanned
    lineOffset: number; // UTF-8 bytes consumed in the current line
    content: string;
    contentBytes: number;
    endLine: number;
    emittedLines: number;
    truncated: boolean;
    nextLine: number | null;
    nextColumn: number | null;
    limitReached: boolean; // maxLines lines have been finalized
    stopped: boolean;
};

// Process one decoded chunk. Returns true when the scanner is done (line limit
// followed by one more character, or byte budget exhausted).
//
// The character loop is the heart of the bounded contract:
//   1. `limitReached` — once maxLines is finalized, the NEXT character proves
//      there is more content, so the window is truncated (even if that character
//      is a newline: the next line is just empty). EOF means not truncated.
//   2. lines before startLine are skipped without retaining text.
//   3. the first startColumn bytes of the first requested line are skipped, rounded
//      UP to a code-point boundary (an offset is only ever produced by this tool
//      at such a boundary).
//   4. a character that would exceed the budget truncates at this exact character:
//      nextLine is the current line and nextColumn is its byte offset, so a giant
//      line can be paged through without arbitrary omission.
//   5. only then is the character appended and counted.
const consumeText = (state: ScanState, text: string): boolean => {
    // Decoding is fatal, so this only catches NULs (which are valid UTF-8). A NUL
    // is the cheapest strong signal that the file is not text.
    if (text.includes('\u0000')) {
        throw binaryError(state.target);
    }

    for (const char of text) {
        // 1. Line limit already reached: any further character means more content.
        if (state.limitReached) {
            state.truncated = true;
            state.nextLine = state.lineNumber;
            state.nextColumn = 0;
            return true;
        }

        // 2. Still before the requested range: count newlines but retain nothing.
        if (state.lineNumber < state.startLine) {
            if (char === '\n') {
                state.lineNumber += 1;
                state.lineOffset = 0;
            }
            continue;
        }

        const charBytes = Buffer.byteLength(char, 'utf8');

        // 3. Skip the requested byte column within the FIRST requested line only.
        // The lineNumber guard is essential: lineOffset resets to 0 at every
        // newline, so without it the skip would reapply to later lines and silently
        // drop their prefixes (F1 regression).
        if (state.lineNumber === state.startLine && state.lineOffset < state.startColumn) {
            state.lineOffset += charBytes;
            if (char === '\n') {
                state.lineNumber += 1;
                state.lineOffset = 0;
            }
            continue;
        }

        // 4. Budget check. The newline counts too (it is content bytes).
        if (state.contentBytes + charBytes > state.budget) {
            state.truncated = true;
            state.nextLine = state.lineNumber;
            state.nextColumn = state.lineOffset;
            return true;
        }

        // 5. Emit this character. `endLine` advances with every emitted character;
        // a partial giant line therefore reports the line it cut inside.
        state.content += char;
        state.contentBytes += charBytes;
        state.lineOffset += charBytes;
        state.endLine = state.lineNumber;

        if (char === '\n') {
            state.emittedLines += 1;
            state.lineNumber += 1;
            state.lineOffset = 0;
            if (state.emittedLines >= state.maxLines) {
                state.limitReached = true;
            }
        }
    }

    return false;
};

// Stream one file from the start, retaining only the requested window. Reading is
// sequential because line numbers require counting from the beginning; the chunk
// size and the early stop keep memory bounded for huge files and giant lines.
const scanFile = async (handle: FileHandle, request: NormalizedTarget, budget: number): Promise<FileReadEntry> => {
    const state: ScanState = {
        target: request.path,
        startLine: request.startLine,
        startColumn: request.startColumn,
        maxLines: request.maxLines,
        budget,
        lineNumber: 1,
        lineOffset: 0,
        content: '',
        contentBytes: 0,
        endLine: request.startLine - 1,
        emittedLines: 0,
        truncated: false,
        nextLine: null,
        nextColumn: null,
        limitReached: false,
        stopped: false
    };

    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);

    while (!state.stopped) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;

        let text: string;
        try {
            text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        } catch {
            throw binaryError(request.path);
        }

        state.stopped = consumeText(state, text);
    }

    // Only flush at EOF: flushing after an early stop would reject a trailing
    // partial code point in bytes we deliberately never needed to read.
    if (!state.stopped) {
        let tail: string;
        try {
            tail = decoder.decode();
        } catch {
            throw binaryError(request.path);
        }

        if (tail.length > 0) {
            state.stopped = consumeText(state, tail);
        }
    }

    // A file ending without a newline still contributes an unterminated line, but
    // there is nothing after it, so no truncation flag is added here. `endLine`
    // already tracks every emitted character.
    return {
        path: resolve(request.path),
        content: state.content,
        startLine: request.startLine,
        endLine: state.endLine,
        truncated: state.truncated,
        nextLine: state.truncated ? state.nextLine : null,
        nextColumn: state.truncated ? state.nextColumn : null,
        bytes: state.contentBytes
    };
};

// Filesystem errors already name the operation but not consistently the target
// (Windows EISDIR on a directory read is the usual offender). Wrap them with the
// requested path so every failure is equally actionable; a HarnessError from the
// scanner (binary content) is already path-aware and passes through untouched.
const fileError = (path: string, error: unknown): HarnessError => {
    const message = error instanceof Error ? error.message : String(error);
    return new HarnessError(`fileRead failed to read "${path}": ${message}`);
};

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const fileRead = tool<FileReadParameters, FileReadResult>({
    ...PRESET_TOOLS.fileRead,
    execute: async ({ parameters: paths }) => {
        const requested = normalizeTargets(paths);

        // Sequential and ordered on purpose: the result mirrors the request, and a
        // later failure rejects the whole call rather than returning a prefix.
        const files: FileReadEntry[] = [];
        let remainingBudget = FILE_READ_CONTENT_BUDGET;

        for (let index = 0; index < requested.length; index += 1) {
            // Fair share of what is left: one file may use the whole budget, two
            // files split it, and so on. A file that returns fewer bytes leaves the
            // remainder for the files after it.
            const remainingFiles = requested.length - index;
            const allowance = Math.floor(remainingBudget / remainingFiles);

            // `open` is also what surfaces ENOENT/EISDIR/EPERM for the whole batch.
            let handle: FileHandle;
            try {
                handle = await open(requested[index].path, 'r');
            } catch (error) {
                throw fileError(requested[index].path, error);
            }

            let entry: FileReadEntry;
            try {
                entry = await scanFile(handle, requested[index], allowance);
            } catch (error) {
                // Binary errors are already HarnessError with the path; only wrap
                // raw filesystem/decoder failures.
                if (error instanceof HarnessError) throw error;
                throw fileError(requested[index].path, error);
            } finally {
                await handle.close();
            }

            remainingBudget -= entry.bytes;
            files.push(entry);
        }

        return {
            files,
            truncated: files.some((file) => file.truncated),
            bytes: FILE_READ_CONTENT_BUDGET - remainingBudget,
            contentBudget: FILE_READ_CONTENT_BUDGET
        };
    }
});
