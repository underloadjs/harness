// searchFiles — grep file contents with a JavaScript regular expression.
//
// The content-search counterpart to globFiles: one match per line, with the path
// and a 1-based line number, so a model can quote and edit what it found. Both
// walkers come from ./glob and therefore share the same skip list and caps.
//
// Bounds are part of the contract, because an unbounded grep is a way to flood a
// tool response:
//   - results are capped (default 100, hard cap 100) with a `truncated` flag;
//   - files over 1 MiB and files containing NUL bytes are skipped;
//   - .git, node_modules, and symlinks are never entered.
//
// NOT implemented (do not claim otherwise): .gitignore is not consulted, and there
// is no sandbox — `path` is resolved against the process working directory.
//
// Executable on its own and registerable on a harness:
//
//     await searchFiles({ pattern: 'TODO', include: '*.ts' });
//
// Metadata comes from ../catalogue so descriptions and schemas cannot drift.

import { readFile as readTextFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tool } from '../../core';
import { PRESET_TOOLS } from '../catalogue';
import {
    clampMaxResults,
    isSearchableFileSize,
    looksBinary,
    matchGlob,
    walkFiles
} from './glob';

export type SearchFilesParameters = {
    // JavaScript regular expression source. Invalid patterns throw.
    pattern: string;
    // Directory to search. Defaults to ".".
    path?: string;
    // Glob limiting which file paths are read.
    include?: string;
    // Requested cap; clamped to 1–100.
    maxResults?: number;
};

export type SearchFilesMatch = {
    // Path relative to the search root, posix-style on every platform.
    path: string;
    // 1-based line number.
    line: number;
    // The full line, without its terminator.
    text: string;
};

export type SearchFilesResult = {
    matches: SearchFilesMatch[];
    // True when the cap was hit and more matches exist beyond the returned set.
    truncated: boolean;
};

export const searchFiles = tool<SearchFilesParameters, SearchFilesResult>({
    ...PRESET_TOOLS.searchFiles,
    execute: async ({ parameters: { pattern, path, include, maxResults } }) => {
        const root = resolve(path ?? '.');
        const limit = clampMaxResults(maxResults);

        // Compile once. A SyntaxError here is the caller's regex being wrong; it
        // propagates so the model sees the parser message instead of "no matches".
        const matcher = new RegExp(pattern);

        const matches: SearchFilesMatch[] = [];
        let truncated = false;

        for await (const relativePath of walkFiles(root)) {
            // `include` is a path filter, not a content filter: it keeps the walk
            // from reading files the caller does not care about.
            if (include !== undefined && !matchGlob(include, relativePath)) continue;

            const fullPath = join(root, relativePath);

            // Size is checked before reading, so a stray bundle cannot stall grep.
            if (!(await isSearchableFileSize(fullPath))) continue;

            let content: string;

            try {
                content = await readTextFile(fullPath, 'utf8');
            } catch {
                // Races (deleted mid-walk) and permission errors are noise here:
                // the caller asked for matches, not for a file-access report.
                continue;
            }

            if (looksBinary(content)) continue;

            // Split on both terminators so a CRLF file reports clean line text.
            const lines = content.split(/\r?\n/);

            for (let index = 0; index < lines.length; index++) {
                const line = lines[index];
                if (!matcher.test(line)) continue;

                matches.push({ path: relativePath, line: index + 1, text: line });

                // Collect one past the cap: that extra match is how we know the
                // result is genuinely truncated rather than exactly full.
                if (matches.length > limit) {
                    truncated = true;
                    break;
                }
            }

            if (truncated) break;
        }

        return { matches: truncated ? matches.slice(0, limit) : matches, truncated };
    }
});
