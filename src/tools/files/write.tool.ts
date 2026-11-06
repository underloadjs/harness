// write — write one or more UTF-8 text files in a single call.
//
// WHY THIS NAME (T-rename): the wire name is `write`, not `fileWrite`. The file
// namespace is already implied by the tool's own `files` tag and by the `paths` /
// `files` / `edits` arguments, and the catalogue now pairs `read`/`write`/`edit`
// with `glob`/`grep`/`files`. There is NO `fileWrite` alias on the wire: two names
// for one tool makes discovery ambiguous (see ../catalogue). The exported TypeScript
// type names (`FileWriteEntry`, `FileWriteParameters`, `FileWriteResult`) keep their
// historical spelling so a consumer's imports do not break over a wire rename.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// A single edit usually spans several files (a module, its barrel, its test). The
// schema declares ONE property, `files`, so the single-property rule (see
// ../core/tool.ts) hands `execute` the array itself — `write([{ path, content }])`
// — while a model call carries `{ "files": [...] }` and reaches the same code.
//
// RESULT SHAPE
// ------------
// Always an ordered array of `{ path, bytes }`, one entry per requested file, in
// the caller's order. `path` is the ABSOLUTE resolved path and `bytes` is the size
// of the UTF-8 payload actually written.
//
// BATCH CAP
// ---------
// At most FILE_WRITE_MAX_TARGETS (100) files per call, enforced in the implementation
// as well as the schema. `write` is the file tool that carries unbounded PAYLOAD —
// every entry holds a whole file's text — so an uncapped batch meant an arbitrary
// number of files and bytes in one call with no budget anywhere in the path, while
// `read` already refused more than 100 paths. The cap bounds the response (one entry
// per file) and the number of sequential writes; content size remains the caller's
// responsibility and is reported per file in `bytes`.
//
// PREFLIGHT (before the first byte hits disk)
// -------------------------------------------
// Every entry is validated — object shape, non-empty path, string content, no NUL
// in the path OR THE CONTENT, and UNIQUE resolved target file — before anything is
// written. A duplicate target is rejected because "write it twice with different
// content" has no honest answer. Uniqueness is by FILE IDENTITY (./identity.ts),
// not by spelling: on Windows `notes.txt`/`NOTES.TXT` and a symlink alias are the
// same file, so a batch that names it twice is rejected before any write. Parent
// directories are created as needed and an existing file is overwritten, exactly as
// before.
//
// WHY NUL CONTENT IS REJECTED (binary consistency)
// ------------------------------------------------
// This tool advertises UTF-8 TEXT: the description says text, the encoding is utf8,
// and the only reader in the package (read) treats a NUL byte as binary and
// refuses the file outright (see read's binary rejection). Writing a NUL
// therefore produces a file that the harness itself cannot read back — a write that
// silently breaks the read side. There is no binary write API here to opt into, so
// the content is rejected during preflight, before any file is touched, rather than
// creating an unreadable artifact. Every other character, including invalid
// Unicode escapes the caller built by hand, still writes (Node substitutes U+FFFD
// for lone surrogates; that is documented behavior of the encoding, not a NUL
// binary marker).
//
// ONE CRITICAL SECTION PER FILE (D4: no lost update)
// --------------------------------------------------
// A write racing a concurrent `edit` on the same path used to interleave: the edit
// read the pre-write text, matched, and wrote it back over the write's content (or
// vice versa), and BOTH calls reported success. Each write therefore runs under the
// same per-file lock `edit` takes (./lock.ts), keyed by FILE IDENTITY so a Windows
// case alias or a symlink alias queues behind the real file rather than racing it.
// Locks for a multi-file batch are taken in sorted identity order, so two overlapping
// batches cannot deadlock. This orders calls inside ONE process; it makes no claim
// about another process or another worker thread, and never did.
//
// FAILURE SEMANTICS (honest, not transactional)
// ---------------------------------------------
// Writes are sequential. A filesystem error on file N may leave files 1..N-1
// written: there is NO transaction and NO rollback, and the error says so by
// naming the completed paths and the path that failed. Pretending otherwise would
// be a lie a model could act on.
//
// ONE mkdir PER DISTINCT DIRECTORY
// --------------------------------
// Parent directories are created at most once per distinct directory name per call.
// Sixty files in one new directory used to cost sixty `mkdir` syscalls; `recursive:
// true` made a repeat harmless but never free, and the first call already created
// every ancestor. Measured on that exact batch (60 files, 60 bytes total): 37.8 ms ->
// 32.1 ms for the write loop, about 6 ms off an 85 ms call. Honest about the size of
// the win: it is real but modest, and it is NOT what makes that batch slow. The
// dominant cost is the per-entry `fileIdentity` (realpath) lookup, measured at 23.8 ms
// for the same 60 entries — needed for correctness, since two spellings of one file
// must share one lock and one duplicate check. It is named here so the next reader
// does not chase the wrong constant.
//
// No sandbox: paths are resolved against the process working directory and used as
// given.
//
// Executable on its own and registerable on a harness:
//
//     await write([{ path: 'notes.md', content: '# Notes' }]);
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { mkdir, writeFile as writeTextFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { fileIdentity } from './identity';
import { withFileLocks } from './lock';

// How many files one `write` call may create. `read` caps a batch at 100 paths and
// `edit` had no cap either, but write is the one that carries unbounded PAYLOAD: every
// entry holds a whole file's text, so 400 entries meant 400 files and an arbitrary
// number of bytes in a single call, with no budget anywhere in the path. The cap bounds
// the response (one entry per file) and the number of sequential writes; content size is
// still the caller's responsibility, and is reported per file in `bytes`.
export const FILE_WRITE_MAX_TARGETS = 100;

// One file to write.
export type FileWriteEntry = {
    // Path to write, absolute or relative to the working directory.
    path: string;
    // Full text to write. Replaces the previous contents.
    content: string;
};

// The value `execute` receives: the `files` array itself (single-property rule).
export type FileWriteParameters = FileWriteEntry[];

// One completed write, in request order.
export type FileWriteResultEntry = {
    // The absolute path that was written.
    path: string;
    // Size of the written UTF-8 payload, in bytes.
    bytes: number;
};

// The ordered result: one entry per requested file, never a subset.
export type FileWriteResult = FileWriteResultEntry[];

// A validated entry plus its resolved target, so the preflight decides everything
// the write loop needs and the loop itself cannot fail on shape.
type PreparedWrite = {
    target: string;
    // Canonical identity (./identity.ts), kept so the lock key matches the one `edit`
    // takes for the same file — two spellings of one file must share one lock.
    identity: string;
    content: string;
};

// Validate the whole batch and resolve every target BEFORE the first write.
//
// Ordering is preserved: the result array and the write order both follow the
// caller. Uniqueness is by FILE IDENTITY (./identity.ts), so "a.txt" and "./a.txt"
// collide, and so do two spellings of one file that only the filesystem considers
// equal (Windows case aliases, symlink aliases). The identity lookup is a read
// (`realpath` on the nearest existing ancestor); nothing is created here.
const prepareWrites = async (files: FileWriteParameters): Promise<PreparedWrite[]> => {
    if (!Array.isArray(files)) {
        throw new HarnessError(
            'write expects an array of { path, content } entries, e.g. [{"path":"a.txt","content":"hi"}].'
        );
    }

    if (files.length === 0) {
        throw new HarnessError('write received an empty files array; pass at least one entry.');
    }

    // Rejected before any validation or filesystem work, like read's batch cap: a
    // caller that sends 400 entries needs to split the batch, not to have the first 100
    // written and the rest silently dropped.
    if (files.length > FILE_WRITE_MAX_TARGETS) {
        throw new HarnessError(
            `write accepts at most ${FILE_WRITE_MAX_TARGETS} files per call; received ${files.length}. Split the batch.`
        );
    }

    const prepared: PreparedWrite[] = [];
    const seen = new Set<string>();

    for (const entry of files) {
        // A model can pass anything: a string, a null, an array. Name the shape
        // rather than failing on a property read.
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new HarnessError('write files must be objects with "path" and "content" strings.');
        }

        const { path, content } = entry as Partial<FileWriteEntry>;

        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('write files require a non-empty "path" string.');
        }

        // NUL cannot exist in a real path and would only confuse the filesystem.
        if (path.includes('\u0000')) {
            throw new HarnessError('write paths must not contain NUL characters.');
        }

        // Content is required, and an empty string is a legitimate "truncate the
        // file" request, so only the type and the binary marker are checked.
        if (typeof content !== 'string') {
            throw new HarnessError('write files require a "content" string.');
        }

        // A NUL byte is the harness's own binary marker (read rejects it), so
        // writing one creates a file this package cannot read back. Rejected in
        // preflight — before any write — so nothing is created meanwhile.
        const target = resolve(path);

        if (content.includes('\u0000')) {
            throw new HarnessError(
                `write content must not contain NUL characters (${target}): the file would be unreadable by read, which rejects binary content.`
            );
        }

        // Same file twice in one batch: the second write would silently win, so
        // the batch is rejected instead of guessing an order-independent answer.
        // The message names the resolved path (what a caller can act on) while the
        // comparison uses the real file identity.
        const identity = await fileIdentity(target);

        if (seen.has(identity)) {
            throw new HarnessError(
                `write received the same target path twice (${target}); write each file once per call.`
            );
        }

        seen.add(identity);
        prepared.push({ target, identity, content });
    }

    return prepared;
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const WRITE_METADATA: PresetToolMetadata = {
    name: 'write',
    description:
        'Write one or more UTF-8 text files, creating parent directories as needed and overwriting existing files. Pass an array of { path, content } entries and get an ordered array of { path, bytes } in the same order. A call accepts at most 100 files; split a larger batch. Every entry is validated before anything is written, and the same target path twice is rejected. Writes are serialized per file against concurrent edit calls on the same path, so neither can silently overwrite the other. A write error part-way through is reported with the paths already completed: there is no rollback.',
    tags: ['files', 'write', 'filesystem'],
    // R18: writing files is core, like the rest of the everyday file set.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            files: {
                type: 'array',
                maxItems: 100,
                items: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description:
                                'Path to the file, absolute or relative to the working directory.'
                        },
                        content: {
                            type: 'string',
                            description: 'Full text to write. Replaces the previous contents.'
                        }
                    },
                    required: ['path', 'content'],
                    additionalProperties: false
                },
                description: 'Files to write, in the order the results are returned.'
            }
        },
        required: ['files'],
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = WRITE_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    order: 180,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const write = tool<FileWriteParameters, FileWriteResult>({
    ...WRITE_METADATA,
    execute: async ({ parameters: files }) => {
        const prepared = await prepareWrites(files);

        // D4: hold every target's lock across the whole batch, in sorted identity
        // order (./lock.ts deduplicates and sorts), so a concurrent `edit` on any of
        // these files cannot read a half-updated view of one of them.
        return withFileLocks(
            prepared.map((entry) => entry.identity),
            async () => {
                const written: FileWriteResultEntry[] = [];

                // Parent directories are created at most ONCE per distinct directory.
                // Sixty files in one new directory used to mean sixty `mkdir` calls.
                // `recursive: true` makes a repeat harmless but never free, and the first
                // call already created every ancestor, so a directory seen twice needs no
                // second call at all. Worth about 6 ms of an 85 ms 60-file batch — see the
                // header for the measurement and for what actually dominates that call.
                const made = new Set<string>();

                for (const { target, content } of prepared) {
                    try {
                        // Agents write into directories that do not exist yet far more
                        // often than not; failing on that wastes a round trip.
                        const parent = dirname(target);
                        if (!made.has(parent)) {
                            await mkdir(parent, { recursive: true });
                            made.add(parent);
                        }

                        await writeTextFile(target, content, 'utf8');
                    } catch (error) {
                        // Partial success is reported honestly: the completed paths are
                        // named so the caller can tell what exists now, and there is no
                        // claim of a transaction or rollback (there is neither).
                        const completed =
                            written.length === 0 ? 'none' : written.map((entry) => entry.path).join(', ');
                        const reason = error instanceof Error ? error.message : String(error);

                        throw new HarnessError(
                            `write failed on ${target}: ${reason} Writes already completed: ${completed}. No rollback was performed.`
                        );
                    }

                    written.push({ path: target, bytes: Buffer.byteLength(content, 'utf8') });
                }

                return written;
            }
        );
    }
});
