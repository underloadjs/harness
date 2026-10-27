// globFiles — find files by glob pattern.
//
// The path-search counterpart to searchFiles: same walker, same skip list, same
// caps, no content reads. Results are the files a model would then read or edit,
// so they are relative to the search root and posix-style on every platform.
//
// A pattern with no "/" matches the file name at any depth ("*.ts" finds
// src/index.ts), which mirrors the way people type globs. "./glob.ts" documents
// the full matching rules and the deliberate omissions (no braces, no .gitignore).
//
// Executable on its own and registerable on a harness:
//
//     await globFiles({ pattern: '**/*.test.ts' });
//
// Metadata comes from ../catalogue so descriptions and schemas cannot drift.

import { resolve } from 'node:path';
import { tool } from '../../core';
import { PRESET_TOOLS } from '../catalogue';
import { clampMaxResults, matchGlob, walkFiles } from './glob';

export type GlobFilesParameters = {
    pattern: string;
    // Directory to search. Defaults to ".".
    path?: string;
    // Requested cap; clamped to 1–100.
    maxResults?: number;
};

export type GlobFilesResult = {
    // Matching paths, relative to the search root, in lexicographic order.
    files: string[];
    // True when the cap was hit and more matches exist beyond the returned set.
    truncated: boolean;
};

export const globFiles = tool<GlobFilesParameters, GlobFilesResult>({
    ...PRESET_TOOLS.globFiles,
    execute: async ({ parameters: { pattern, path, maxResults } }) => {
        const root = resolve(path ?? '.');
        const limit = clampMaxResults(maxResults);

        const files: string[] = [];
        let truncated = false;

        // walkFiles is already lexicographic, so no post-sort is needed and the
        // capped set is the first N in that order.
        for await (const relativePath of walkFiles(root)) {
            if (!matchGlob(pattern, relativePath)) continue;

            files.push(relativePath);

            // One past the cap proves truncation; the extra entry is dropped.
            if (files.length > limit) {
                truncated = true;
                break;
            }
        }

        return { files: truncated ? files.slice(0, limit) : files, truncated };
    }
});
