// glob — find files by glob pattern. FILE NAMES ONLY.
//
// WHAT CHANGED (rename + split)
// -----------------------------
// This entry used to be `fileGlob`, one tool with two modes: filename matching, plus
// an optional `content` regex that switched the result to matching lines. The mode
// switch is gone. Content search is now its own tool, `grep` (./grep.tool.ts), so a
// caller asks for the capability it actually wants by NAME instead of by the presence
// of a property:
//
//     glob({ patterns: ['**/*.ts'] })                 -> { files, truncated }
//     grep({ pattern: 'TODO', patterns: ['*.ts'] })   -> { matches, truncated, bytes, contentBudget }
//
// There is deliberately no `content` property left here, and no old wire alias: a
// request that still sends `content` is rejected as an unknown property
// (`additionalProperties: false`), because silently ignoring it would answer a
// question the caller did not get an answer to.
//
// ARGUMENTS
// ---------
//   patterns   Glob patterns, OR-ed. Default ['**/*']. A pattern with no "/" also
//              matches the file name at any depth, so '*.ts' finds src/a.ts.
//   paths      Directories to walk, in caller order. Default ['.'].
//   maxResults Requested cap, clamped to 1-100. ONE global cap across every root
//              and pattern, not a per-root budget.
//
// RESULT
// ------
// `{ files: string[], truncated: boolean }` — matching paths in walk order,
// deduplicated, capped. `truncated` is proven by one extra match beyond the cap, so a
// short list never claims to be complete. This mode is not byte-bounded: paths are
// short strings capped by `maxResults` (the byte budget belongs to grep, where a
// matched LINE can be megabytes long).
//
// PATTERNS ARE RELATIVE TO EACH ROOT
// ----------------------------------
// A pattern is matched against the path of a file RELATIVE TO THE ROOT that found it,
// and results are prefixed with that root. So
//
//     glob({ paths: ['src'], patterns: ['**/*.ts'] })
//
// returns ['src/a.ts', 'src/nested/b.ts'], and the same patterns rooted at '.' return
// the same files with their paths from '.'. Note the consequence a caller has to know:
// `paths: ['src']` with `patterns: ['src/*.ts']` matches NOTHING, because the relative
// paths under that root are 'a.ts' and 'b.ts'.
//
// PATHS
// -----
// Results are root-prefixed and posix-style, exactly like fileList: walking '.' and
// 'src' yields 'a.ts' and 'src/b.ts'. Overlapping roots (['src', '.'] or patterns that
// both match one file) are deduplicated by RESOLVED FILE IDENTITY, so a file appears
// once, under the FIRST root that reached it. A root that resolves to a directory
// already walked (a symlink alias, or 'src' and 'SRC' on Windows) is skipped entirely.
// Root order and the depth-first name-sorted walk are both stable, so the capped set is
// deterministic.
//
// PRESERVED POLICY (unchanged from fileGlob's filename mode)
// ----------------------------------------------------------
//   - .git, node_modules, and symlinks are never entered;
//   - .gitignore is NOT consulted;
//   - a root that cannot be listed throws; unreadable subtrees are skipped;
//   - no sandbox: roots are resolved against the process working directory.
//
// Executable on its own and registerable on a harness:
//
//     await glob({ patterns: ['**/*.test.ts'] });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { clampMaxResults } from './glob';
import {
    collectCandidates,
    compilePatterns,
    normalizeObjectArgument,
    normalizeStringList
} from './search';
import type { CompiledPattern } from './search';

// The whole argument object (this tool declares three properties, so the
// single-property rule does not apply).
export type FileGlobParameters = {
    // Glob patterns, OR-ed. Defaults to ['**/*'] (every file).
    patterns?: string[];
    // Directories to walk, in caller order. Defaults to ['.'].
    paths?: string[];
    // Requested cap; clamped to 1-100 and applied globally across all roots.
    maxResults?: number;
};

// The result: matching paths plus an honest truncation flag.
export type FileGlobResult = {
    // Matching paths, in walk order, deduplicated, capped.
    files: string[];
    // True when the cap was hit and more matches exist beyond the returned set.
    truncated: boolean;
};

// Message for a non-object argument, kept as one constant because the exact text is
// the published contract (a focused test asserts it verbatim).
const ARGUMENT_SHAPE_ERROR =
    'glob expects an object with optional "patterns", "paths", and "maxResults" properties, e.g. {"patterns":["**/*.ts"]}.';

// Filename mode: collect capped paths and prove truncation by one extra match.
//
// The generator stops at the first entry past the cap, so `glob` never materializes a
// whole tree it was only going to throw away.
const listMatchingFiles = async (
    roots: readonly string[],
    compiled: readonly CompiledPattern[],
    limit: number
): Promise<FileGlobResult> => {
    const files: string[] = [];
    let truncated = false;

    for await (const candidate of collectCandidates(roots, compiled)) {
        files.push(candidate.display);

        // One past the cap proves truncation; the extra entry is dropped.
        if (files.length > limit) {
            truncated = true;
            break;
        }
    }

    return { files: truncated ? files.slice(0, limit) : files, truncated };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const GLOB_METADATA: PresetToolMetadata = {
    name: 'glob',
    description:
        'Find FILES by glob pattern: names only, never file contents (use grep for that). `patterns` (default ["**/*"]) supports *, ?, **, and [abc] classes; a pattern with no slash also matches file names at any depth. Patterns are matched against each file\'s path RELATIVE TO THE ROOT that found it, never against an absolute path, and every result is prefixed with that root: { "paths": ["src"], "patterns": ["**/*.ts"] } returns "src/a.ts" and "src/nested/b.ts" - so the same root with "src/*.ts" matches nothing. `paths` (default ["."]) lists the roots to walk, in order; overlapping roots and patterns are deduplicated by real file identity (a symlink alias or a case-alias root is walked once), so a file is reported once, under the first root that reached it. The result is { files, truncated }, with `truncated` true only when the cap was reached and more matches exist. Skips .git, node_modules and symlinks. Results are capped (100 by default) across all roots. Does not read .gitignore files, and does not search text.',
    tags: ['files', 'glob', 'find', 'paths', 'filesystem'],
    // R18: glob is core: naming a file is the everyday first step of any code task,
    // and there is deliberately no old `fileGlob` alias and no `content` property.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            patterns: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Glob patterns, OR-ed together and matched against each file path relative to its root, e.g. ["**/*.test.ts"] or ["*.md", "*.txt"]. Defaults to ["**/*"].'
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Root directories to walk, absolute or relative to the working directory, in the order they are visited. Results are prefixed with the root that found them. Defaults to ["."].'
            },
            maxResults: {
                type: 'number',
                description: 'Maximum files to return across all roots. Defaults to 100 and is clamped to 1-100.'
            }
        },
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = GLOB_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    // Keeps fileGlob's slot: 210 is the filename search, 215 is grep beside it.
    order: 210,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const glob = tool<FileGlobParameters, FileGlobResult>({
    ...GLOB_METADATA,
    execute: async ({ parameters }) => {
        // The schema declares three properties, so `parameters` is the whole object
        // (the single-property rule does not apply). A direct caller may still pass
        // nothing at all, which is the documented "every file under '.'" request; a
        // string or an array is a caller mistake and is rejected, not defaulted.
        const input = normalizeObjectArgument(parameters, ARGUMENT_SHAPE_ERROR);

        const patterns = normalizeStringList('glob', input.patterns, 'patterns', ['**/*']);
        const roots = normalizeStringList('glob', input.paths, 'paths', ['.']);

        // `maxResults` is a convenience knob, so a non-number is clamped to the
        // documented default instead of failing the call (see ./glob clampMaxResults).
        const limit = clampMaxResults(input.maxResults as number | undefined);

        return listMatchingFiles(roots, compilePatterns(patterns), limit);
    }
});
