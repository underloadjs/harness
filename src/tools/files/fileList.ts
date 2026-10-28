// fileList — list the immediate entries of one or more directories.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// Surveying a workspace usually means "what is in src, and what is in task?".
// One call with an array answers that; two calls cost two round trips and force
// the caller to stitch the answers together. Every entry is therefore PREFIXED
// with the directory it came from, so two `index.ts` files stay distinguishable
// in one flat list:
//
//     await fileList(['src', 'task']);
//     // ['src/a.ts', 'src/nested/', 'task/b.ts', ...]
//
// The schema declares ONE property, `paths`, so the single-property rule (see
// ../core/tool.ts) hands `execute` the array itself; a model call carries
// `{ "paths": ["src", "task"] }` and reaches the same code.
//
// WHAT IS DELIBERATELY UNCHANGED (and distinct from fileGlob)
// -----------------------------------------------------------
//   - nonrecursive: only the immediate entries of each directory. Recursion is
//     fileGlob's job (`fileGlob({ patterns: ['**'] })`); this tool never walks.
//   - directories end with "/" so they are distinguishable from files.
//   - "." contributes no prefix, so the default `paths: ['.']` returns bare entry
//     names.
//   - no sandbox: each directory is resolved against the process working
//     directory and used as given.
//
// ORDERING
// --------
// Deterministic and locale-independent: directories are visited in the order the
// caller listed them (never re-sorted), and each directory's entries are sorted by
// code point. Same rationale as compareNames in ./glob.ts: a localeCompare sort
// would make the output depend on the host's ICU data.
//
// FAILURE SEMANTICS
// -----------------
// `readdir` on a missing or unreadable directory rejects the whole call. There is
// no partial listing, because a partial list that looks complete is worse than a
// clear error. An explicit empty array is rejected for the same reason: `[]` would
// read as "the directory is empty".
//
// Executable on its own and registerable on a harness:
//
//     await fileList(['src']);
//     await fileList();            // the working directory, bare entry names

import { readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

// The argument the implementation accepts. The model-facing schema (see
// ../catalogue) declares the array form; a bare string stays accepted because a
// one-directory call is the common case and the single-property rule hands this
// value to `execute` untouched, with no schema lookup to normalize it.
//
// `null` and an empty object are accepted as "no preference" (see normalizePaths):
// they are what a client sends when the argument box is empty, and the documented
// default is the working directory.
export type FileListParameters = string | string[] | null | undefined;

// Posix separators in every result, on every platform: the model should not have
// to care which OS the harness runs on. Same convention as fileGlob.
const toPosixPath = (value: string): string => value.split(sep).join('/');

// Code-point comparison (see the ORDERING note above). Kept local rather than
// imported from ./glob.ts, which does not export its comparator and whose walker
// this tool must not pull in.
const compareNames = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;

// Normalize the argument into the directories to list, in caller order.
//
//   undefined  -> ['.']  (the historic default: the working directory)
//   null / {}  -> ['.']  ("no preference": an empty argument box on the wire)
//   'src'      -> ['src'] (direct-call convenience for a single directory)
//   ['src']    -> ['src']
//   { paths }  -> the wrapped array (the parameter object the server's direct-call
//                 route passes through without unwrapping it)
//   []         -> HarnessError (see below)
//   ['src',''] -> HarnessError (a blank entry is a caller mistake, not a request)
//
// An explicit empty array is rejected rather than answered with []. A model that
// sends `{"paths": []}` almost certainly meant "no preference", and an empty
// result would let it conclude the directory is empty — a wrong answer is worse
// than an error that names the fix (omit `paths` to list the working directory).
//
// WHY THE DEFAULTS LIVE HERE AND NOT IN THE SERVER (T16): both entry points reach
// `execute` with the property VALUE when their own unwrapping applies, but the
// server's direct-call route hands over the `parameters` object as-is (`{}` for an
// empty box, or `{ "paths": [...] }` for a model-shaped body). Accepting those here
// keeps the API free of per-tool defaulting and keeps one documented contract.
const normalizePaths = (paths: FileListParameters | Record<string, unknown>): string[] => {
    // `null` and `{}` are the two shapes of "the caller expressed no preference".
    if (paths === undefined || paths === null) return ['.'];

    if (!Array.isArray(paths) && typeof paths === 'object') {
        const keys = Object.keys(paths);

        // Only an EMPTY object is a no-argument call. Any other object is malformed
        // for this tool and is reported rather than guessed at.
        if (keys.length === 0) return ['.'];

        const wrapped = (paths as { paths?: unknown }).paths;
        if (keys.length === 1 && keys[0] === 'paths') {
            return normalizePaths(wrapped as FileListParameters);
        }

        throw new HarnessError('fileList paths must be non-empty strings.');
    }

    const list = Array.isArray(paths) ? paths : [paths as string];

    if (list.length === 0) {
        throw new HarnessError(
            'fileList received an empty paths array. Omit paths to list the working directory.'
        );
    }

    for (const path of list) {
        // A non-string (e.g. a model sending 7) would reach readdir as a type
        // error with an unhelpful message; reject it here instead.
        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('fileList paths must be non-empty strings.');
        }

        // NUL cannot exist in a real path and would only confuse the filesystem.
        if (path.includes('\u0000')) {
            throw new HarnessError('fileList paths must not contain NUL characters.');
        }
    }

    return list;
};

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const fileList = tool<FileListParameters, string[]>({
    ...PRESET_TOOLS.fileList,
    execute: async ({ parameters: paths }) => {
        const directories = normalizePaths(paths);
        const entries: string[] = [];

        // Sequential on purpose: the output is grouped by directory in the
        // caller's order, so a parallel Promise.all would buy nothing and would
        // leave earlier directories read before a later one throws.
        for (const directory of directories) {
            const listing = await readdir(resolve(directory), { withFileTypes: true });

            const names = listing
                .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
                .sort(compareNames);

            for (const name of names) {
                // join() collapses "." and "./src" to "src", keeps a trailing "/"
                // on a directory entry, and joins an absolute path unchanged — so
                // one call produces both the prefix and the entry name.
                entries.push(toPosixPath(join(directory, name)));
            }
        }

        return entries;
    }
});
