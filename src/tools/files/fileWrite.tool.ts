// fileWrite — write one or more UTF-8 text files in a single call.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// A single edit usually spans several files (a module, its barrel, its test). The
// schema declares ONE property, `files`, so the single-property rule (see
// ../core/tool.ts) hands `execute` the array itself — `fileWrite([{ path, content }])`
// — while a model call carries `{ "files": [...] }` and reaches the same code.
//
// RESULT SHAPE
// ------------
// Always an ordered array of `{ path, bytes }`, one entry per requested file, in
// the caller's order. `path` is the ABSOLUTE resolved path and `bytes` is the size
// of the UTF-8 payload actually written.
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
// and the only reader in the package (fileRead) treats a NUL byte as binary and
// refuses the file outright (see fileRead's binary rejection). Writing a NUL
// therefore produces a file that the harness itself cannot read back — a write that
// silently breaks the read side. There is no binary write API here to opt into, so
// the content is rejected during preflight, before any file is touched, rather than
// creating an unreadable artifact. Every other character, including invalid
// Unicode escapes the caller built by hand, still writes (Node substitutes U+FFFD
// for lone surrogates; that is documented behavior of the encoding, not a NUL
// binary marker).
//
// FAILURE SEMANTICS (honest, not transactional)
// ---------------------------------------------
// Writes are sequential. A filesystem error on file N may leave files 1..N-1
// written: there is NO transaction and NO rollback, and the error says so by
// naming the completed paths and the path that failed. Pretending otherwise would
// be a lie a model could act on.
//
// No sandbox: paths are resolved against the process working directory and used as
// given.
//
// Executable on its own and registerable on a harness:
//
//     await fileWrite([{ path: 'notes.md', content: '# Notes' }]);
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
            'fileWrite expects an array of { path, content } entries, e.g. [{"path":"a.txt","content":"hi"}].'
        );
    }

    if (files.length === 0) {
        throw new HarnessError('fileWrite received an empty files array; pass at least one entry.');
    }

    const prepared: PreparedWrite[] = [];
    const seen = new Set<string>();

    for (const entry of files) {
        // A model can pass anything: a string, a null, an array. Name the shape
        // rather than failing on a property read.
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new HarnessError('fileWrite files must be objects with "path" and "content" strings.');
        }

        const { path, content } = entry as Partial<FileWriteEntry>;

        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('fileWrite files require a non-empty "path" string.');
        }

        // NUL cannot exist in a real path and would only confuse the filesystem.
        if (path.includes('\u0000')) {
            throw new HarnessError('fileWrite paths must not contain NUL characters.');
        }

        // Content is required, and an empty string is a legitimate "truncate the
        // file" request, so only the type and the binary marker are checked.
        if (typeof content !== 'string') {
            throw new HarnessError('fileWrite files require a "content" string.');
        }

        // A NUL byte is the harness's own binary marker (fileRead rejects it), so
        // writing one creates a file this package cannot read back. Rejected in
        // preflight — before any write — so nothing is created meanwhile.
        const target = resolve(path);

        if (content.includes('\u0000')) {
            throw new HarnessError(
                `fileWrite content must not contain NUL characters (${target}): the file would be unreadable by fileRead, which rejects binary content.`
            );
        }

        // Same file twice in one batch: the second write would silently win, so
        // the batch is rejected instead of guessing an order-independent answer.
        // The message names the resolved path (what a caller can act on) while the
        // comparison uses the real file identity.
        const identity = await fileIdentity(target);

        if (seen.has(identity)) {
            throw new HarnessError(
                `fileWrite received the same target path twice (${target}); write each file once per call.`
            );
        }

        seen.add(identity);
        prepared.push({ target, content });
    }

    return prepared;
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const FILE_WRITE_METADATA: PresetToolMetadata = {
    name: 'fileWrite',
    description:
        'Write one or more UTF-8 text files, creating parent directories as needed and overwriting existing files. Pass an array of { path, content } entries and get an ordered array of { path, bytes } in the same order. Every entry is validated before anything is written, and the same target path twice is rejected. A write error part-way through is reported with the paths already completed: there is no rollback.',
    tags: ['files', 'write', 'filesystem'],
    // R18: writing files is core, like the rest of the everyday file set.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            files: {
                type: 'array',
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
export const metadata = FILE_WRITE_METADATA;

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

export const fileWrite = tool<FileWriteParameters, FileWriteResult>({
    ...FILE_WRITE_METADATA,
    execute: async ({ parameters: files }) => {
        const prepared = await prepareWrites(files);
        const written: FileWriteResultEntry[] = [];

        for (const { target, content } of prepared) {
            try {
                // Agents write into directories that do not exist yet far more
                // often than not; failing on that wastes a round trip.
                await mkdir(dirname(target), { recursive: true });
                await writeTextFile(target, content, 'utf8');
            } catch (error) {
                // Partial success is reported honestly: the completed paths are
                // named so the caller can tell what exists now, and there is no
                // claim of a transaction or rollback (there is neither).
                const completed = written.length === 0 ? 'none' : written.map((entry) => entry.path).join(', ');
                const reason = error instanceof Error ? error.message : String(error);

                throw new HarnessError(
                    `fileWrite failed on ${target}: ${reason} Writes already completed: ${completed}. No rollback was performed.`
                );
            }

            written.push({ path: target, bytes: Buffer.byteLength(content, 'utf8') });
        }

        return written;
    }
});
