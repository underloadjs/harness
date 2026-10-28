// fileRead — read one or more UTF-8 text files in a single call.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// Reading is the most common multi-step thing an agent does: "show me these three
// files" is one intent, not three round trips. The schema declares ONE property,
// `paths`, so the single-property rule (see ../core/tool.ts) hands `execute` the
// array itself — `fileRead(['a.ts', 'b.ts'])` — while a model call carries
// `{ "paths": ["a.ts", "b.ts"] }` and reaches the same code.
//
// RESULT SHAPE
// ------------
// Always an ordered array of `{ path, content }`, one entry per requested path, in
// the caller's order. `path` is the ABSOLUTE resolved path, so two relative
// spellings of the same file are still identifiable.
//
// FAILURE SEMANTICS (all-or-nothing)
// ----------------------------------
// A blank/NUL/non-string path, a directory, or a missing file rejects the WHOLE
// call. There is no partial array: a short answer that looks complete would let a
// model conclude a file it never received is empty.
//
// No sandbox: paths are resolved against the process working directory and used as
// given. Run the harness under whatever process boundary the host provides (a
// container, a worktree, a scoped cwd), or wrap `execute`.
//
// Executable on its own and registerable on a harness:
//
//     await fileRead(['package.json', 'README.md']);
//
// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.

import { readFile as readTextFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

// One file's content, in request order.
export type FileReadEntry = {
    // The absolute path that was read.
    path: string;
    // The file's UTF-8 text, byte-for-byte.
    content: string;
};

// The ordered result: one entry per requested path, never a subset.
export type FileReadResult = FileReadEntry[];

// The value `execute` receives: the `paths` array itself (single-property rule).
export type FileReadParameters = string[];

// Validate the batch before touching disk, so a typo in the last entry cannot
// produce a misleading partial answer.
const normalizePaths = (paths: FileReadParameters): string[] => {
    if (!Array.isArray(paths)) {
        throw new HarnessError('fileRead expects an array of paths, e.g. ["package.json"].');
    }

    if (paths.length === 0) {
        throw new HarnessError('fileRead received an empty paths array; pass at least one file path.');
    }

    for (const path of paths) {
        // A non-string (e.g. a model sending 7) would reach the filesystem as a
        // type error with an unhelpful message; reject it here instead.
        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('fileRead paths must be non-empty strings.');
        }

        // NUL cannot exist in a real path and would only confuse the filesystem.
        if (path.includes('\u0000')) {
            throw new HarnessError('fileRead paths must not contain NUL characters.');
        }
    }

    return paths;
};

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const fileRead = tool<FileReadParameters, FileReadResult>({
    ...PRESET_TOOLS.fileRead,
    execute: async ({ parameters: paths }) => {
        const requested = normalizePaths(paths);

        // Sequential and ordered on purpose: the result mirrors the request, and a
        // later failure rejects the whole call rather than returning a prefix.
        const entries: FileReadEntry[] = [];

        for (const path of requested) {
            const target = resolve(path);
            entries.push({ path: target, content: await readTextFile(target, 'utf8') });
        }

        return entries;
    }
});
