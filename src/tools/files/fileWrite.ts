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
// Every entry is validated — object shape, non-empty path, string content, no NUL,
// and UNIQUE resolved target path — before anything is written. A duplicate
// resolved path is rejected because "write it twice with different content" has no
// honest answer. Parent directories are created as needed and an existing file is
// overwritten, exactly as before.
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
// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.

import { mkdir, writeFile as writeTextFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

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
// caller. Uniqueness is by RESOLVED path, so "a.txt" and "./a.txt" collide.
const prepareWrites = (files: FileWriteParameters): PreparedWrite[] => {
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
        // file" request, so only the type is checked.
        if (typeof content !== 'string') {
            throw new HarnessError('fileWrite files require a "content" string.');
        }

        const target = resolve(path);

        // Same file twice in one batch: the second write would silently win, so
        // the batch is rejected instead of guessing an order-independent answer.
        if (seen.has(target)) {
            throw new HarnessError(
                `fileWrite received the same target path twice (${target}); write each file once per call.`
            );
        }

        seen.add(target);
        prepared.push({ target, content });
    }

    return prepared;
};

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const fileWrite = tool<FileWriteParameters, FileWriteResult>({
    ...PRESET_TOOLS.fileWrite,
    execute: async ({ parameters: files }) => {
        const prepared = prepareWrites(files);
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
