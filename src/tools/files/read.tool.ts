// read — read a BOUNDED window of one or more UTF-8 text files.
//
// WHY BOUNDED BY DEFAULT
// ----------------------
// Reading every requested file in full is unsafe as a model-facing default: one
// minified bundle or log file can consume the entire context window, and the
// harness only caps the SERIALIZED result after the fact (see
// ../../core/result-budget.ts). This implementation bounds its own work:
//
//   - a 1-based line window per file: `startLine` (default 1) plus `maxLines`
//     (default 5000, hard maximum 20000);
//   - an aggregate budget of 256 KiB of SERIALIZED JSON across the whole batch
//     (`FILE_READ_WIRE_BUDGET`), allocated by demand rather than by headcount;
//   - a streaming read chunk and a hard stop as soon as the allowance is reached,
//     so a single huge file or line is never pulled into memory wholesale;
//   - at most 100 paths per call, so thousands of empty files cannot inflate the
//     metadata side of the response;
//   - explicit binary rejection (NUL bytes or invalid UTF-8) for every byte
//     DECODED WHILE STREAMING, because replacing binary bytes with U+FFFD would be
//     a silently wrong answer. This is not whole-file validation: bytes after the
//     last read chunk (or after an early stop) are never inspected. The consequence
//     is deliberate and is stated in the tool description — a file whose NUL sits
//     past the requested window reads as TEXT for that window and as EBINARY for a
//     wider one. Rejecting the file outright would mean reading all of it to decide,
//     which is exactly the unbounded work this tool exists to avoid, and the bytes
//     the caller asked for are genuinely valid text either way.
//
// THE BUDGET IS WIRE BYTES, NOT CONTENT BYTES
// -------------------------------------------
// The previous contract budgeted 64 KiB of raw UTF-8 CONTENT and the harness then
// capped the SERIALIZED result at the same 64 KiB. Those are different numbers for
// the same response: `JSON.stringify` escapes `\n`, `"`, `\` and control
// characters, so a result that exactly filled the content budget was ALWAYS over
// the wire budget. The harness then cut it mid-string and replaced the whole object
// with its own envelope, destroying every field a caller needs in order to continue
// — `nextLine`, `nextColumn`, the per-entry `truncated` — so the agent could not
// resume. Measured escape overhead: 2.1% on realistic source, 15.2% on
// quote/backslash-heavy code.
//
// So the budget here is charged against the SERIALIZED form. Each character costs
// its escaped UTF-8 length (`\n` is two bytes, an emoji four), and the fixed JSON
// scaffolding of each entry (keys, braces, the resolved path) is reserved up front.
// `bytes` still reports RAW content bytes, because that is what a caller compares
// against a file; `wireBytes` reports the exact serialized length of what was
// produced. The result therefore fits the envelope it is delivered in.
//
// WHY ONE ARRAY PROPERTY (T14 batching rule, preserved)
// ------------------------------------------------------
// Reading several files is one intent, not several round trips. The schema still
// declares exactly ONE property, `paths`, so the single-property rule (see
// ../../core/tool.ts) hands `execute` the array itself:
//
//     read(['a.ts', 'b.ts'])
//     read([{ path: 'a.ts', startLine: 10, maxLines: 20 }])
//
// A model call carries `{ "paths": [...] }` and reaches this same code. Each item
// is either a path string (defaults: startLine 1, maxLines 5000) or a range object
// `{ path, startLine?, startColumn?, startByte?, maxLines? }`. Keeping the range on
// the item — rather than adding top-level properties — is deliberate: a second
// top-level property would disable the single-property rule and break every
// existing paths-only call.
//
// ALLOCATION IS BY DEMAND, NOT BY HEADCOUNT
// -----------------------------------------
// The old split was `budget / numberOfFiles`. One small file beside one large one
// therefore wasted the small file's whole share, and a batch of 100 tiny files
// starved the one file that mattered down to 655 bytes — 6.4% of the budget used.
// Allocation is now water-filling: every file gets an equal share, files that need
// less than their share hand the difference back, and the surplus is offered to the
// files that were actually cut. A 40 KiB file beside 99 36-byte files returns in
// full; 100 equal large files still split evenly.
//
// This terminates. Each pass either leaves no file truncated (done) or satisfies at
// least one file, and a satisfied file's allowance never shrinks: the remaining
// budget divided among the still-truncated files is at least the previous share,
// because the satisfied files took no more than their share. Passes are also capped
// (ALLOCATION_PASSES) so the re-scan work stays bounded on a pathological batch.
//
// RESULT SHAPE
// ------------
//     {
//       files: [{ path, content, startLine, endLine, truncated, nextLine,
//                  nextColumn, nextByte, bytes, sizeBytes, error? }],
//       truncated: boolean,          // any file truncated
//       bytes: number,               // total RAW content bytes returned
//       wireBytes: number,           // serialized bytes the budget is charged on
//       contentBudget: number,       // the wire budget this call was subject to
//       skipped: number              // entries that reported an error, not content
//     }
//
// `path` is the ABSOLUTE resolved path. `content` is raw text: line 1 of `content`
// corresponds to file line `startLine`, so line numbering is METADATA rather than
// prefixes inside the copied text. `endLine` is the last line represented (it may
// equal startLine for a partial line, and is startLine - 1 when nothing was
// returned). `sizeBytes` is the whole file's size, so a caller can judge how much
// is left without paying for another read.
//
// `error` is present on a per-entry failure (see FAILURE SEMANTICS): it carries
// `{ code, message }` and the entry's metadata is the same empty-window shape an
// empty file would produce. Every other entry has no `error` property at all, so an
// existing caller that compares whole entries is unaffected.
//
// CONTINUATION
// ------------
// `truncated` means "more file content exists after this window". When true:
//   - `nextLine` is the 1-based line to request next;
//   - `nextColumn` is the 0-based UTF-8 BYTE offset within that line (0 at a line
//     boundary). A giant single line is the only reason this is non-zero: the
//     window was cut mid-line, and `{ path, startLine: nextLine,
//     startColumn: nextColumn }` resumes exactly where it stopped, at a code-point
//     boundary. Repeating the request pages through a line of any size;
//   - `nextByte` is the ABSOLUTE file offset of the first unread byte, always exact.
//     Passing it back as `startByte` resumes by SEEKING, with no line counting, so a
//     large file can be walked in O(window) per call instead of O(file). When
//     `startByte` is supplied, `nextColumn` is measured from `startByte` rather than
//     from the physical line start; `nextByte` and `nextLine` stay exact.
// When false, `nextLine`, `nextColumn` and `nextByte` are null and the window
// reached the end of the file.
//
// FAILURE SEMANTICS (per-entry; only a malformed request rejects the call)
// ------------------------------------------------------------------------
// A path that cannot be read does NOT fail the call. Every requested path keeps its
// ordered position and an unreadable one becomes an entry with empty `content`,
// `bytes` 0 and a structured `error`. This covers ENOENT, a directory, a permission
// denial, and BINARY CONTENT — the last three of which previously rejected the
// whole batch and destroyed the content of every other file in it. A failed entry
// consumes no content budget, so the readable files in the same call keep their
// full share.
//
// Only a malformed REQUEST still rejects the whole call, before any disk access: a
// non-array argument, an empty array, too many paths, a blank/NUL/non-string path,
// or an invalid range value. Those are caller bugs rather than file outcomes, and
// answering them per-entry would let a broken request look like a successful read.
//
// BINARY DETECTION IS WINDOW-SCOPED, NOT WHOLE-FILE
// -------------------------------------------------
// A file is called binary by the bytes this call actually decoded. A text file with
// one stray NUL far past the requested window therefore reads as text for the window
// and as EBINARY for a wider one (measured: a 100 KB file whose NUL sits at byte
// 100,001 returns line 1 fine and fails a whole-file read). That is the honest answer
// — the bytes you asked for ARE valid text — and the only alternative, scanning the
// entire file to classify it, would charge every small read for the largest file in
// the batch. `sizeBytes` is always reported, so a caller that needs a whole-file
// verdict can page to the end.
//
// COST OF RANGES
// --------------
// A window at line N with no `startByte` requires counting from byte 0, so it
// rescans the skipped prefix; memory stays bounded by the allowance and the chunk
// size. `startByte` skips counting entirely. There is deliberately no shared
// line-index cache: it would be process-global mutable state whose lifetime is
// unbounded, and `startByte` already gives a caller the O(1) resume without that
// complexity or any staleness risk.
//
// No sandbox: paths are resolved against the process working directory and used as
// given. Run the harness under whatever process boundary the host provides (a
// container, a worktree, a scoped cwd), or wrap `execute`.
//
// Executable on its own and registerable on a harness:
//
//     await read(['package.json']);
//     await read([{ path: 'README.md', startLine: 20, maxLines: 40 }]);
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';

// Default and hard limits. These are exported so docs/tests can quote the same
// numbers the implementation enforces (and so a host cannot quietly disagree).
//
// WHY THE DEFAULT IS 5000 LINES AND NOT 200 OR 1200
// -------------------------------------------------
// The wire budget, not the line count, is the real limit, so the default must be
// high enough for a default read to REACH it. Measured on this repository's own
// source (mean 55 bytes/line): a 200-line default used 14.2% of the budget and a
// 1200-line default used 22.7% (59,386 of 262,144 bytes), so the tool spent a full
// round trip to deliver a fifth of what it was allowed to return, and the agent paid
// another round trip for the next fifth. At 5000 lines the budget binds first for
// typical source (5000 x 55 = 275 KB > 256 KiB), so one call returns as much as the
// envelope can hold.
//
// The honest cost: a default read of a LARGE file now commits up to the whole budget
// rather than a quarter of it, so a careless default read costs more tokens per call.
// That is the intended direction — the budget is the documented governor, `maxLines`
// is the guard for files whose lines are short — and 5000 still leaves a quarter of
// the 20000-line hard maximum for a caller who asks for more.
export const FILE_READ_DEFAULT_MAX_LINES = 5000;
export const FILE_READ_MAX_LINES = 20_000;

// The aggregate budget, charged against the SERIALIZED JSON of the result rather
// than raw content. 256 KiB is roughly 64k tokens of English prose.
//
// The old bug was two independent constants — read's content budget and the
// harness's wire cap — both set to 64 KiB while describing the SAME response, so a
// full-budget read was always over the cap and got destroyed. The fix is that read
// now measures its own budget on the serialized form.
//
// The value is written out rather than imported from ../../core/result-budget on
// purpose: a relative import becomes a CAPTURED SOURCE DEPENDENCY of the compiled
// tool (see harness.self-modifying.test.ts and toolbox-sources.test.ts, which pin
// that shipped presets compile with `dependencies: []`), and it would make read
// non-self-contained against its own "executable on its own" contract. The two
// numbers are kept equal by an assertion in read.test.ts instead, which catches the
// drift without changing how the tool compiles.
export const FILE_READ_WIRE_BUDGET = 256 * 1024;

// Back-compat alias for the aggregate budget's historical name. It now denotes
// WIRE bytes; the result still reports it as `contentBudget` so existing callers
// keep a number they can compare against.
export const FILE_READ_CONTENT_BUDGET = FILE_READ_WIRE_BUDGET;

// A batch cap as well as a content cap: without it, thousands of empty files
// would still return thousands of metadata entries and blow the response up.
export const FILE_READ_MAX_TARGETS = 100;

// Read this many bytes at a time. Large enough to amortize syscalls, small enough
// that a huge single line cannot be pulled into memory before the allowance stops
// it.
const READ_CHUNK_BYTES = 64 * 1024;

// Upper bound on reallocation passes. Convergence is guaranteed (see the
// water-filling note above); this only bounds the re-scan work when a batch is
// adversarial, and two passes already handle every realistic case.
const ALLOCATION_PASSES = 4;

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
          // Absolute 0-based UTF-8 byte offset to seek to, skipping line counting.
          // Feed back the `nextByte` of a previous window. `startLine` remains the
          // line number reported for the first returned line, so threading
          // nextByte/nextLine through together keeps numbering correct for free.
          startByte?: number;
          // Maximum lines to return. Defaults to 5000, hard maximum 20000.
          maxLines?: number;
      };

// A per-entry failure that is REPORTED, not thrown: anything the caller named that
// cannot be read as text. `code` lets a caller branch on it; `message` is the
// human-readable sentence, naming the requested path.
export type FileReadErrorCode = 'ENOENT' | 'EISDIR' | 'EACCES' | 'EPERM' | 'EBINARY' | 'EIO';

export type FileReadEntryError = {
    code: FileReadErrorCode;
    message: string;
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
    // Absolute 0-based byte offset of the first unread byte, or null when not
    // truncated. Pass it back as `startByte` to continue without rescanning.
    nextByte: number | null;
    // UTF-8 bytes in `content` (raw, as they exist in the file).
    bytes: number;
    // Total size of the whole file in bytes, or null when the entry failed.
    sizeBytes: number | null;
    // Present ONLY when this path could not be read (missing, directory, permission
    // denial, or binary content). The entry then carries empty content, bytes 0 and
    // an empty-window range; the call itself succeeds and the other entries are
    // unaffected. Absent for every readable file.
    error?: FileReadEntryError;
};

// The ordered batch result. `files` has exactly one entry per requested path.
export type FileReadResult = {
    files: FileReadEntry[];
    // True when at least one entry is truncated (line limit or content budget).
    truncated: boolean;
    // Total RAW UTF-8 content bytes returned across `files`.
    bytes: number;
    // Serialized bytes this response costs — the figure the budget governs, measured
    // on the real output rather than estimated.
    wireBytes: number;
    // The aggregate wire budget this call was subject to.
    contentBudget: number;
    // How many entries reported an `error` instead of content.
    skipped: number;
};

// The value `execute` receives: the `paths` array itself (single-property rule).
export type FileReadParameters = FileReadTarget[];

// A validated request, with every default resolved.
type NormalizedTarget = {
    path: string;
    startLine: number;
    startColumn: number;
    startByte: number | null;
    maxLines: number;
};

// One file's place in the allocation. `entry` stays null until a pass scans it, and
// a failed open fills it immediately so the file never takes part in the split.
type ScanSlot = {
    request: NormalizedTarget;
    handle: FileHandle | null;
    sizeBytes: number;
    entry: FileReadEntry | null;
    // JSON scaffolding this entry costs regardless of how much content it returns.
    overhead: number;
    // True when the LAST scan of this slot stopped because of the byte allowance
    // rather than `maxLines` or EOF. Only such a slot is a candidate for surplus.
    cutByBudget: boolean;
};

// The serialized cost of one character inside a JSON string. This is what the
// budget is charged against, and it is what makes the result fit the envelope the
// harness delivers it in.
//
// `JSON.stringify` escapes exactly these single-character forms in ordinary text:
// `"`, `\`, and the control characters. Node emits `\n`, `\r`, `\t`, `\b`, `\f` as
// two-character escapes and every other control character as a six-character
// `\u00XX`. Everything else — including U+2028/U+2029, which `JSON.stringify` leaves
// literal — costs its UTF-8 length.
const escapedCharBytes = (char: string, utf8Bytes: number): number => {
    const code = char.codePointAt(0);

    if (code === undefined) return utf8Bytes;
    if (code === 0x22 || code === 0x5c) return 2; // " and backslash
    if (code === 0x0a || code === 0x0d || code === 0x09) return 2; // \n \r \t
    if (code === 0x08 || code === 0x0c) return 2; // \b \f
    if (code < 0x20) return 6; // \u00XX

    return utf8Bytes;
};

// The escaped length of a content string, computed exactly as the scanner charges
// it. Used to account for entries already scanned in an earlier pass.
const contentWireBytes = (content: string): number => {
    let bytes = 0;
    for (const char of content) bytes += escapedCharBytes(char, Buffer.byteLength(char, 'utf8'));
    return bytes;
};

// The JSON scaffolding of one entry, measured on a real entry shape rather than
// guessed: the braces, every `"key":`, the separators, and the quoted path. Field
// names are fixed so their cost is fixed; only the path varies.
const ENTRY_SHELL = JSON.stringify({
    path: '',
    content: '',
    startLine: 0,
    endLine: 0,
    truncated: false,
    nextLine: 0,
    nextColumn: 0,
    nextByte: 0,
    bytes: 0,
    sizeBytes: 0
});

// Allowance for the numeric/boolean values growing beyond the single digits used in
// ENTRY_SHELL: a `startLine` of 199990 costs six bytes rather than one, and there
// are seven such fields. It does NOT cover an `error` object, whose message is
// measured exactly instead (see entryOverhead) — reserving a flat 400 bytes for all
// 100 slots would have wasted 15% of the budget on the common no-error path.
const ENTRY_VALUE_RESERVE = 160;

// The JSON cost of one entry's `error` object, measured on the real message. A
// failed entry is known before scanning starts, so there is no need to guess.
const entryErrorWire = (code: string, message: string): number =>
    JSON.stringify({ error: { code, message } }).length - 1; // -1: the leading comma

const entryOverhead = (path: string, error?: { code: string; message: string }): number =>
    ENTRY_SHELL.length + (JSON.stringify(path).length - 2) + ENTRY_VALUE_RESERVE +
    (error === undefined ? 0 : entryErrorWire(error.code, error.message));

// The fixed cost of the result object around the array: `files`, the four summary
// fields, and their separators. Measured, not guessed.
const RESULT_SHELL = JSON.stringify({
    files: [],
    truncated: false,
    bytes: 0,
    wireBytes: 0,
    contentBudget: 0,
    skipped: 0
});

// The ordered entry a failed path produces. It is shaped exactly like an empty
// window (empty content, endLine = startLine - 1, no continuation, zero bytes), so
// a caller's range arithmetic still holds, plus a structured `error` naming the
// requested path. `bytes: 0` is what keeps a failed entry out of the content split.
const failedEntry = (
    request: NormalizedTarget,
    code: FileReadErrorCode,
    message: string,
    sizeBytes: number | null = null
): FileReadEntry => ({
    path: resolve(request.path),
    content: '',
    startLine: request.startLine,
    endLine: request.startLine - 1,
    truncated: false,
    nextLine: null,
    nextColumn: null,
    nextByte: null,
    bytes: 0,
    sizeBytes,
    error: { code, message }
});

// Close best-effort, ignoring a handle that is already closed. Used on every
// failure path so a batch never leaks an open descriptor.
const closeQuietly = async (handles: Iterable<FileHandle>): Promise<void> => {
    for (const handle of handles) {
        try {
            await handle.close();
        } catch {
            // Nothing actionable: the call is already failing, or the handle was
            // closed by the scanner's own finally block.
        }
    }
};

// The binary rejection shared by the NUL and invalid-UTF-8 paths so the message
// (and therefore a test's expectation) cannot drift between them.
const binaryMessage = (path: string): string =>
    `read refused "${path}": the file contains binary data (NUL bytes or invalid UTF-8). read reads UTF-8 text only.`;

const directoryMessage = (path: string): string =>
    `read cannot read "${path}": it is a directory, not a file. Use fileList to list its entries, or glob to find files inside it.`;

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
            `read ${field} must be an integer between ${minimum} and ${maximum}; received ${String(value)}.`
        );
    }

    return value as number;
};

// `startByte` is the only nullable range field: absent means "count lines", present
// means "seek here". It must be a non-negative integer when supplied.
const readByte = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;

    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new HarnessError(`read startByte must be a non-negative integer or null; received ${String(value)}.`);
    }

    return value as number;
};

// A path must be a non-empty string with no NUL. NUL cannot exist in a real path
// and a non-string (e.g. a model sending 7) would reach the filesystem as an
// unhelpful type error.
const validatePath = (path: unknown): string => {
    if (typeof path !== 'string' || path.length === 0) {
        throw new HarnessError('read paths must be non-empty strings.');
    }

    if (path.includes('\u0000')) {
        throw new HarnessError('read paths must not contain NUL characters.');
    }

    return path;
};

// Validate every target BEFORE touching disk, so a typo in the last entry cannot
// produce a misleading partial answer (and so an invalid range never opens a file).
const normalizeTargets = (paths: FileReadParameters): NormalizedTarget[] => {
    if (!Array.isArray(paths)) {
        throw new HarnessError(
            'read expects an array of paths (strings or { path, startLine, startColumn, startByte, maxLines } objects), e.g. ["package.json"].'
        );
    }

    if (paths.length === 0) {
        throw new HarnessError('read received an empty paths array; pass at least one file path.');
    }

    if (paths.length > FILE_READ_MAX_TARGETS) {
        throw new HarnessError(
            `read accepts at most ${FILE_READ_MAX_TARGETS} paths per call; received ${paths.length}. Split the batch.`
        );
    }

    return paths.map((target) => {
        // A bare string is the historical shape: whole file, bounded by defaults.
        if (typeof target === 'string') {
            return {
                path: validatePath(target),
                startLine: 1,
                startColumn: 0,
                startByte: null,
                maxLines: FILE_READ_DEFAULT_MAX_LINES
            };
        }

        // A range object must carry a usable path. Arrays/null/non-objects are
        // rejected with the same shape guidance as a non-array argument.
        if (target === null || typeof target !== 'object' || Array.isArray(target)) {
            throw new HarnessError(
                'read paths must be strings or { path, startLine, startColumn, startByte, maxLines } objects.'
            );
        }

        return {
            path: validatePath(target.path),
            startLine: readInteger(target.startLine, 'startLine', 1, 1, Number.MAX_SAFE_INTEGER),
            startColumn: readInteger(target.startColumn, 'startColumn', 0, 0, Number.MAX_SAFE_INTEGER),
            startByte: readByte(target.startByte),
            maxLines: readInteger(target.maxLines, 'maxLines', FILE_READ_DEFAULT_MAX_LINES, 1, FILE_READ_MAX_LINES)
        };
    });
};

// The mutable scanner state for one file. Kept explicit so the streaming loop can
// stop at an exact character boundary and report where the next window starts.
type ScanState = {
    target: string;
    // Absolute file offset of the character currently being scanned. Deliberately
    // separate from the READ cursor: a streaming TextDecoder holds back a trailing
    // partial code point and emits it with the next chunk, so offsets are counted
    // per character and can never drift out of step with the decoded text.
    scanOffset: number;
    startLine: number;
    startColumn: number;
    maxLines: number;
    budget: number;
    lineNumber: number; // 1-based line currently being scanned
    lineOffset: number; // UTF-8 bytes consumed in the current line
    content: string;
    contentBytes: number;
    wireBytes: number;
    endLine: number;
    emittedLines: number;
    truncated: boolean;
    nextLine: number | null;
    nextColumn: number | null;
    nextByte: number | null;
    limitReached: boolean; // maxLines lines have been finalized
    stopped: boolean;
    // WHY the window stopped, because it decides whether more budget would help: a
    // file cut by the ALLOWANCE is worth re-scanning with a larger one, while a file
    // cut by `maxLines` is already complete for this request and would absorb
    // surplus it can never use.
    cutByBudget: boolean;
};

// Record the truncation point at the current character, so a continuation resumes
// exactly here rather than skipping or repeating it.
const stopAt = (state: ScanState, line: number, column: number, byBudget: boolean): true => {
    state.truncated = true;
    state.nextLine = line;
    state.nextColumn = column;
    state.nextByte = state.scanOffset;
    state.cutByBudget = byBudget;
    return true;
};

// Process one decoded chunk. Returns true when the scanner is done (line limit
// followed by one more character, or the allowance exhausted).
//
// The character loop is the heart of the bounded contract:
//   1. `limitReached` — once maxLines is finalized, the NEXT character proves there
//      is more content, so the window is truncated (even if that character is a
//      newline: the next line is just empty). EOF means not truncated.
//   2. lines before startLine are skipped without retaining text.
//   3. the first startColumn bytes of the first requested line are skipped, rounded
//      UP to a code-point boundary (an offset is only ever produced by this tool at
//      such a boundary).
//   4. a character that would exceed the allowance truncates at this exact
//      character, so a giant line can be paged through without arbitrary omission.
//   5. only then is the character appended and counted, in BOTH raw bytes (what
//      `bytes` reports) and escaped bytes (what the allowance is charged against).
const consumeText = (state: ScanState, text: string): boolean => {
    // Decoding is fatal, so this only catches NULs (which are valid UTF-8). A NUL
    // is the cheapest strong signal that the file is not text.
    if (text.includes('\u0000')) {
        throw new HarnessError(binaryMessage(state.target));
    }

    for (const char of text) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        const isNewline = char === '\n';

        // 1. Line limit already reached: any further character means more content.
        if (state.limitReached) {
            return stopAt(state, state.lineNumber, 0, false);
        }

        // 2. Still before the requested range: count newlines but retain nothing.
        if (state.lineNumber < state.startLine) {
            state.scanOffset += charBytes;
            if (isNewline) {
                state.lineNumber += 1;
                state.lineOffset = 0;
            }
            continue;
        }

        // 3. Skip the requested byte column within the FIRST requested line only.
        // The lineNumber guard is essential: lineOffset resets to 0 at every
        // newline, so without it the skip would reapply to later lines and silently
        // drop their prefixes (F1 regression).
        if (state.lineNumber === state.startLine && state.lineOffset < state.startColumn) {
            state.lineOffset += charBytes;
            state.scanOffset += charBytes;
            if (isNewline) {
                state.lineNumber += 1;
                state.lineOffset = 0;
            }
            continue;
        }

        // 4. Allowance check, against the ESCAPED cost of this character. The
        // newline counts too: it is content, and it costs two bytes once escaped.
        const wireCost = escapedCharBytes(char, charBytes);
        if (state.wireBytes + wireCost > state.budget) {
            return stopAt(state, state.lineNumber, state.lineOffset, true);
        }

        // 5. Emit this character. `endLine` advances with every emitted character,
        // so a partial giant line reports the line it was cut inside.
        state.content += char;
        state.contentBytes += charBytes;
        state.wireBytes += wireCost;
        state.lineOffset += charBytes;
        state.scanOffset += charBytes;
        state.endLine = state.lineNumber;

        if (isNewline) {
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

// Stream one file, retaining only the requested window.
//
// `seekTo` is the byte offset to read from: 0 when the caller gave no `startByte`,
// otherwise the absolute offset it supplied. `lineAtSeek` is the 1-based line at
// that offset, so the scanner reports correct line numbers without recounting the
// skipped prefix. With `startByte` the read is therefore O(window); without it,
// line numbers force a count from byte 0.
const scanFile = async (
    handle: FileHandle,
    request: NormalizedTarget,
    allowance: number,
    seekTo: number,
    lineAtSeek: number
): Promise<{ entry: FileReadEntry; cutByBudget: boolean }> => {
    const state: ScanState = {
        target: request.path,
        scanOffset: seekTo,
        startLine: request.startLine,
        startColumn: request.startColumn,
        maxLines: request.maxLines,
        budget: allowance,
        lineNumber: lineAtSeek,
        lineOffset: 0,
        content: '',
        contentBytes: 0,
        wireBytes: 0,
        endLine: request.startLine - 1,
        emittedLines: 0,
        truncated: false,
        nextLine: null,
        nextColumn: null,
        nextByte: null,
        limitReached: false,
        stopped: false,
        cutByBudget: false
    };

    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let readOffset = seekTo;

    while (!state.stopped) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
        if (bytesRead === 0) break;

        readOffset += bytesRead;

        let text: string;
        try {
            text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        } catch {
            throw new HarnessError(binaryMessage(request.path));
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
            throw new HarnessError(binaryMessage(request.path));
        }

        if (tail.length > 0) state.stopped = consumeText(state, tail);
    }

    // A file ending without a newline still contributes an unterminated line, but
    // there is nothing after it, so no truncation flag is added here. `endLine`
    // already tracks every emitted character.
    const entry: FileReadEntry = {
        path: resolve(request.path),
        content: state.content,
        startLine: request.startLine,
        endLine: state.endLine,
        truncated: state.truncated,
        nextLine: state.truncated ? state.nextLine : null,
        nextColumn: state.truncated ? state.nextColumn : null,
        nextByte: state.truncated ? state.nextByte : null,
        bytes: state.contentBytes,
        sizeBytes: null
    };

    // `cutByBudget` is not part of the public entry: it only tells the allocator
    // whether a larger allowance would have helped, so a `maxLines` cut is never
    // offered surplus it cannot use.
    return { entry, cutByBudget: state.cutByBudget };
};

// Scan one slot, translating the scanner's binary throw into a per-entry EBINARY
// result. A binary file is a FILE outcome, not a broken request, so it must not
// destroy the rest of the batch.
const scanSafely = async (slot: ScanSlot, allowance: number): Promise<FileReadEntry> => {
    const { request, handle, sizeBytes } = slot;
    if (handle === null) return failedEntry(request, 'EIO', `read failed to read "${request.path}".`, sizeBytes);

    const seekTo = request.startByte ?? 0;
    // With an explicit byte the caller is responsible for the line number it wants
    // reported; without one, counting starts at line 1 as always.
    const lineAtSeek = request.startByte === null ? 1 : request.startLine;

    try {
        const { entry, cutByBudget } = await scanFile(handle, request, allowance, seekTo, lineAtSeek);
        slot.cutByBudget = cutByBudget;
        return { ...entry, sizeBytes };
    } catch (error) {
        if (error instanceof HarnessError) {
            slot.cutByBudget = false;
            return failedEntry(request, 'EBINARY', error.message, sizeBytes);
        }
        throw error;
    }
};

// Classify one filesystem failure into a per-entry error. Every case names the
// requested path and says what to do instead, because a model reads this and acts
// on it; a bare errno does not.
//
// A directory is NOT a permission problem and NOT a generic I/O failure, so it gets
// its own message naming the tool that can help. Windows reports EPERM for a
// directory read, which by code alone is indistinguishable from a real denial — so
// only in that case (and only after the failure) one narrow stat decides. A failed
// stat keeps the original classification, so an actual EPERM is never relabelled.
const errorCodeOf = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
};

const classifyFailure = async (
    request: NormalizedTarget,
    error: unknown
): Promise<{ code: FileReadErrorCode; message: string }> => {
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCodeOf(error);

    if (code === 'ENOENT') {
        // The one outcome that is a plain lookup result rather than a failure to
        // read something that exists; kept word-for-word from the previous contract
        // so existing callers and tests see the same sentence.
        return {
            code: 'ENOENT',
            message: `read could not find "${request.path}": no such file or directory (ENOENT).`
        };
    }

    if (code === 'EISDIR') return { code: 'EISDIR', message: directoryMessage(request.path) };

    // Windows reports EPERM for a directory read. One narrow stat decides, and only
    // after the failure, so a genuine denial keeps permission wording.
    if (code === 'EPERM' && (await isDirectory(request.path))) {
        return { code: 'EISDIR', message: directoryMessage(request.path) };
    }

    if (code === 'EACCES' || code === 'EPERM') {
        return {
            code: code as FileReadErrorCode,
            message: `read was denied permission to read "${request.path}": ${message}. This is a filesystem permission problem, not a missing path or a directory read.`
        };
    }

    return {
        code: (code === undefined ? 'EIO' : code) as FileReadErrorCode,
        message: `read failed to read "${request.path}": ${message}`
    };
};

// Decide the one ambiguity Windows leaves: EPERM means either "this is a
// directory" or "you may not read it". Only called after an EPERM, and a failed
// stat answers false, so a real denial is never relabelled as a directory.
const isDirectory = async (path: string): Promise<boolean> => {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const FILE_READ_METADATA: PresetToolMetadata = {
    name: 'read',
    description:
        'Read a BOUNDED window of one or more UTF-8 text files. Each `paths` item is either a path string (defaults below) or { path, startLine, startColumn, startByte, maxLines }. Returns { files: [{ path, content, startLine, endLine, truncated, nextLine, nextColumn, nextByte, bytes, sizeBytes, error? }], truncated, bytes, wireBytes, contentBudget, skipped }. Defaults: startLine 1, startColumn 0, startByte null, maxLines 5000 (hard maximum 20000). `content` is raw text whose first line is file line `startLine`, so line numbering is metadata rather than prefixes. When an entry is truncated, pass startByte = nextByte to resume by SEEKING (no rescanned prefix) — that is how a large file should be walked; or use { startLine: nextLine, startColumn: nextColumn }, where nextColumn is 0 at a line boundary and non-zero only when a single huge line was cut mid-line. The whole batch shares a 256 KiB budget measured on the SERIALIZED JSON (escaping included), allocated by demand: files that need less hand their surplus back to files that were cut, instead of splitting evenly by headcount. A call accepts at most 100 paths. A path that cannot be read is reported IN PLACE as its own ordered entry with empty `content`, `bytes` 0, and `error: { code, message }` - codes are ENOENT, EISDIR (a directory: use fileList or glob), EACCES/EPERM (a real denial), EBINARY (NUL bytes or invalid UTF-8), or EIO - and it consumes no budget, so the other files in the same call are still read in full. Only a malformed request (bad path, bad range, empty or oversized array) rejects the whole call. A window at a deep line without startByte rescans from the start to count lines. Binary detection is WINDOW-SCOPED, not whole-file: a NUL past the requested window is not reported, so one file can read as text for a narrow window and as EBINARY for a wide one. Paths are absolute or relative to the working directory.',
    tags: ['files', 'read', 'filesystem'],
    // R18: everyday file access is core — always declared, never discovered.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            paths: {
                type: 'array',
                maxItems: 100,
                items: {
                    oneOf: [
                        { type: 'string' },
                        {
                            type: 'object',
                            properties: {
                                path: {
                                    type: 'string',
                                    description:
                                        'File to read, absolute or relative to the working directory.'
                                },
                                startLine: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: '1-based first line to return. Defaults to 1.'
                                },
                                startColumn: {
                                    type: 'integer',
                                    minimum: 0,
                                    description:
                                        '0-based UTF-8 byte offset within startLine, for continuing a giant line. Defaults to 0.'
                                },
                                startByte: {
                                    type: 'integer',
                                    minimum: 0,
                                    description:
                                        'Absolute 0-based UTF-8 byte offset to seek to, skipping the line count. Feed back a previous nextByte. Defaults to null (count from the start).'
                                },
                                maxLines: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 20_000,
                                    description: 'Maximum lines to return. Defaults to 5000 and is capped at 20000.'
                                }
                            },
                            required: ['path'],
                            additionalProperties: false
                        }
                    ]
                },
                description:
                    'Files to read, in the order the results are returned. A string reads a default window; an object selects a line/byte range.'
            }
        },
        required: ['paths'],
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = FILE_READ_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    // T2/R2: reading is cheap and the model needs the bytes before it can act on
    // them, so a read completion does not start a turn of its own - the whole sync
    // batch of this message settles first. Same value as the `tool({ mode })`
    // declaration below; this literal is what discovery and the generated manifest
    // report.
    mode: 'sync',
    order: 170,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const read = tool<FileReadParameters, FileReadResult>({
    ...FILE_READ_METADATA,
    // T2/R2: the DECLARED turn policy, mirrored from `registration` above so the
    // standalone callable, a host-registered `tools: { read }`, and the harness's
    // descriptor-bound registration all resolve the same effective mode.
    mode: 'sync',
    execute: async ({ parameters: paths }) => {
        const requested = normalizeTargets(paths);

        // PHASE 1 — open every path and turn every unreadable one into a failed
        // entry, preserving the caller's order. Opening first is what lets PHASE 2
        // split the budget only across files that can actually be read: a missing,
        // directory, permission-denied or binary path never reserves a share it
        // cannot use. A directory is detected on the handle's stat rather than on a
        // read error, because Windows lets a directory open and fails only later.
        const slots: ScanSlot[] = [];
        const openHandles = new Set<FileHandle>();

        try {
            for (const request of requested) {
                const absolute = resolve(request.path);

                try {
                    const handle = await open(request.path, 'r');
                    openHandles.add(handle);
                    const info = await handle.stat();

                    // A directory is detected here rather than from a read error:
                    // Windows opens one successfully and fails only later, and the
                    // stat is free next to an open we already paid for.
                    if (info.isDirectory()) {
                        await closeQuietly([handle]);
                        openHandles.delete(handle);
                        const message = directoryMessage(request.path);
                        slots.push({
                            request,
                            handle: null,
                            sizeBytes: info.size,
                            overhead: entryOverhead(absolute, { code: 'EISDIR', message }),
                            entry: failedEntry(request, 'EISDIR', message, info.size),
                            cutByBudget: false
                        });
                        continue;
                    }

                    slots.push({
                        request,
                        handle,
                        sizeBytes: info.size,
                        overhead: entryOverhead(absolute),
                        entry: null,
                        cutByBudget: false
                    });
                } catch (error) {
                    const { code, message } = await classifyFailure(request, error);
                    slots.push({
                        request,
                        handle: null,
                        sizeBytes: 0,
                        overhead: entryOverhead(absolute, { code, message }),
                        entry: failedEntry(request, code, message),
                        cutByBudget: false
                    });
                }
            }
        } catch (error) {
            // Do not leak handles opened before the failing target.
            await closeQuietly(openHandles);
            throw error;
        }

        // PHASE 2 — water-fill the budget across the readable files.
        //
        // Reserve the scaffolding of EVERY entry first, including the failed ones: an
        // error message is part of the response and costs wire bytes too. What is
        // left is content.
        let reserved = RESULT_SHELL.length;
        for (const slot of slots) reserved += slot.overhead;

        const contentBudget = Math.max(0, FILE_READ_WIRE_BUDGET - reserved);
        const readable = slots.filter((slot) => slot.entry === null);

        try {
            let pending = readable;
            let allowance = pending.length > 0 ? Math.floor(contentBudget / pending.length) : 0;

            for (let pass = 0; pass < ALLOCATION_PASSES && pending.length > 0 && allowance > 0; pass += 1) {
                // A cut file must be RE-SCANNED from the start on the next pass, so
                // the handle stays open until the allocation is final. Closing it
                // here would force a re-open per pass.
                for (const slot of pending) {
                    slot.entry = await scanSafely(slot, allowance);
                }

                // Who was satisfied, and how much of their share did they leave?
                let surplus = 0;
                const cut: ScanSlot[] = [];

                for (const slot of pending) {
                    const entry = slot.entry;
                    if (entry === null) continue;

                    // Only a BUDGET cut is worth re-scanning. A file cut by `maxLines`
                    // returned everything the caller asked for, so counting its
                    // unused share as surplus would let it be re-offered (and
                    // re-cut) on every pass without ever freeing anything.
                    if (slot.cutByBudget) cut.push(slot);
                    else surplus += Math.max(0, allowance - contentWireBytes(entry.content));
                }

                // Everything fits, or there is nothing to give. Either way the
                // allocation is final.
                if (cut.length === 0 || surplus === 0) break;

                // Offer the surplus to the files that were cut. This is exactly
                // (remaining budget) / (cut files): the satisfied files took u_i of
                // an equal share A, so what is left is surplus + cut.length * A.
                // The new allowance is therefore never smaller than the old one, a
                // satisfied file cannot regress, and `pending` strictly shrinks
                // whenever the allowance grows — which is what makes the loop end.
                allowance += Math.floor(surplus / cut.length);
                pending = cut;
            }
        } finally {
            // Whatever is still open closes here: a file that never entered a pass
            // (allowance 0) or a throw part-way through.
            await closeQuietly(openHandles);
            openHandles.clear();
        }

        const files = slots.map(
            (slot) => slot.entry ?? failedEntry(slot.request, 'EIO', `read failed to read "${slot.request.path}".`)
        );

        const bytes = files.reduce((total, entry) => total + entry.bytes, 0);
        const truncated = files.some((entry) => entry.truncated);
        const skipped = files.filter((entry) => entry.error !== undefined).length;

        // Measure the real serialized length rather than trusting the reserve: this
        // is the exact number the harness compares against its own cap, so a caller
        // can rely on `wireBytes <= contentBudget`.
        //
        // Iterate to a fixed point, because `wireBytes` is itself part of what is
        // measured: reporting a length that assumed a 1-byte placeholder would
        // understate the real response by the digits of the number itself. The
        // measurement is monotone in the inserted value and the value's digit count
        // stabilises after one refinement, so the loop settles immediately; the cap
        // just guarantees termination for any input.
        const shape = (wire: number) =>
            Buffer.byteLength(
                JSON.stringify({
                    files,
                    truncated,
                    bytes,
                    wireBytes: wire,
                    contentBudget: FILE_READ_WIRE_BUDGET,
                    skipped
                }),
                'utf8'
            );

        // `shape(w) = base + digits(w)` is non-decreasing in `w`, so this climbs to a
        // fixed point (or, at a digit boundary, a 2-cycle). Keeping the LARGEST value
        // seen makes the result an upper bound on the real serialized length, which is
        // the safe direction: `wireBytes <= contentBudget` then genuinely implies the
        // harness envelope will not truncate.
        let wireBytes = shape(0);
        for (let i = 0; i < 8; i += 1) {
            const next = shape(wireBytes);
            if (next <= wireBytes) break;
            wireBytes = next;
        }

        return { files, truncated, bytes, wireBytes, contentBudget: FILE_READ_WIRE_BUDGET, skipped };
    }
});
