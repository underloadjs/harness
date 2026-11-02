// grep — search file CONTENTS for a regular expression, with bounded output.
//
// WHY THIS TOOL EXISTS (the split half of fileGlob)
// -------------------------------------------------
// `fileGlob` used to answer both "which files match this name?" and "which lines
// match this text?" from one entry, discriminated by whether the caller sent a
// `content` property. A caller therefore had to know the mode rule to interpret the
// result shape. `grep` is the content half under its own name, with the file filter
// kept as a normal glob argument:
//
//     grep({ pattern: 'TODO' })                                  -> every matching line
//     grep({ pattern: 'TODO', patterns: ['*.ts'], maxResults: 20 })
//
// The result is always `{ matches, truncated, bytes, contentBudget }`. There is no
// mode switch and no second shape.
//
// ARGUMENTS
// ---------
//   pattern    Required JavaScript regular-expression SOURCE (no delimiters, no
//              flags). Invalid source throws with the parser's own message, which is
//              the useful answer, not "no matches". Matching is BOUNDED: see
//              ./bounded-regex — a catastrophic pattern is stopped by a deadline
//              instead of hanging the harness.
//   patterns   Glob filter for which files to read, OR-ed, default ['**/*'] (every
//              file). Same matcher and same root-relative rules as ./glob.tool.
//   paths      Directories to walk, in caller order. Default ['.'].
//   maxResults Requested cap, clamped to 1-100, applied GLOBALLY across every root,
//              pattern and file — not a per-file budget.
//
// CONTENT BOUNDS (inherited from fileGlob's content mode, unchanged)
// ------------------------------------------------------------------
// A content search used to copy each matching LINE in full, so one match on a
// minified bundle (a single multi-megabyte line) could blow up the whole response.
// Every match is bounded twice:
//
//   - SNIPPET: at most FILE_GREP_MATCH_TEXT_BYTES (1 KiB) of UTF-8 per match. The cut
//     is made on a code-point boundary (`for...of` iterates code points, so a
//     surrogate pair is never split). A cut snippet is flagged with `textTruncated:
//     true` on that match — the omission is explicit, never silent.
//   - AGGREGATE: at most FILE_GREP_CONTENT_BUDGET (64 KiB) of UTF-8 match text per
//     call, the same budget read uses. When the next match would cross it the search
//     stops and `truncated: true` is reported, because a match that exists was NOT
//     returned. The returned matches stay a genuine prefix of the walk, so re-running
//     with a narrower pattern is the honest way to see the rest.
//
// `line` is always the ORIGINAL 1-based line number, even when the snippet was cut;
// `bytes` is the UTF-8 size of the returned snippet (not of the whole line). The
// result reports `bytes` (charged against the budget) and `contentBudget` (the cap
// itself) so a caller can see the policy it is subject to.
//
// SKIPS AND FAILURES (same policy as before the split)
// ----------------------------------------------------
//   - a file over 1 MiB is not read, and a file containing a NUL byte is treated as
//     binary and skipped;
//   - .git, node_modules and symlinks are never entered; .gitignore is NOT consulted;
//   - a root that cannot be listed throws, while an unreadable file or subtree is
//     skipped (a race with a delete is noise, not an answer the caller needs);
//   - no sandbox: roots are resolved against the process working directory.
//
// Executable on its own and registerable on a harness:
//
//     await grep({ pattern: 'TODO|FIXME', patterns: ['*.ts'], maxResults: 20 });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { readFile as readTextFile } from 'node:fs/promises';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { createBoundedLineMatcher } from './bounded-regex';
import { clampMaxResults, isSearchableFileSize, looksBinary } from './glob';
import {
    collectCandidates,
    compilePatterns,
    normalizeObjectArgument,
    normalizeStringList,
    truncateSnippet
} from './search';
import type { CompiledPattern } from './search';

// Maximum UTF-8 bytes of ONE matching line returned as `text`. A longer line is cut
// on a code-point boundary and flagged with `textTruncated: true`.
export const FILE_GREP_MATCH_TEXT_BYTES = 1024;

// Maximum UTF-8 bytes of match text across the whole call (the same 64 KiB budget
// read uses). Reaching it ends the search with `truncated: true`.
export const FILE_GREP_CONTENT_BUDGET = 64 * 1024;

// The whole argument object (four properties, so the single-property rule does not
// apply and `execute` receives the object a direct call passes).
export type FileGrepParameters = {
    // Regular-expression source to match inside each candidate file. Required.
    pattern: string;
    // Glob filter for which files to read. Defaults to ['**/*'].
    patterns?: string[];
    // Directories to walk, in caller order. Defaults to ['.'].
    paths?: string[];
    // Requested cap; clamped to 1-100 and applied globally across all roots.
    maxResults?: number;
};

// One matching line.
export type FileGrepMatch = {
    // Root-prefixed path, posix-style on every platform.
    path: string;
    // 1-based line number IN THE FILE (unchanged by snippet truncation).
    line: number;
    // The line, without its terminator, cut to FILE_GREP_MATCH_TEXT_BYTES at most.
    text: string;
    // True when the line was longer than the snippet cap, so `text` is a PREFIX and
    // the rest of that line was not returned. Explicit, never a silent omission.
    textTruncated: boolean;
    // UTF-8 bytes in `text` (the snippet), charged against the aggregate budget.
    bytes: number;
};

// The result shape.
export type FileGrepResult = {
    matches: FileGrepMatch[];
    // True when the cap OR the byte budget stopped the search and more matches exist
    // beyond the returned set. A genuinely complete result is false.
    truncated: boolean;
    // Total UTF-8 bytes of match text returned across `matches`.
    bytes: number;
    // The fixed aggregate content budget this call was subject to. Metadata only.
    contentBudget: number;
};

// Message for a non-object argument; the exact text is a published contract.
const ARGUMENT_SHAPE_ERROR =
    'grep expects an object with "pattern" and optional "patterns", "paths", and "maxResults" properties, e.g. {"pattern":"TODO","patterns":["**/*.ts"]}.';

// Content search: read each candidate, skip binary/oversized files, and report every
// matching line. Both the match cap and the aggregate byte budget are global across
// roots and patterns.
const searchContents = async (
    roots: readonly string[],
    compiled: readonly CompiledPattern[],
    limit: number,
    source: string
): Promise<FileGrepResult> => {
    // Built once per search: compiling the pattern validates it (a SyntaxError is the
    // caller's regex being wrong and propagates so the model sees the parser message)
    // and one vm context plus one deadline cover every file.
    const matcher = createBoundedLineMatcher(source);

    const matches: FileGrepMatch[] = [];
    let bytes = 0;
    let truncated = false;

    for await (const candidate of collectCandidates(roots, compiled)) {
        // Size is checked before reading, so a stray bundle cannot stall the search.
        if (!(await isSearchableFileSize(candidate.absolute))) continue;

        let content: string;

        try {
            content = await readTextFile(candidate.absolute, 'utf8');
        } catch {
            // Races (deleted mid-walk) and permission errors are noise here: the
            // caller asked for matches, not for a file-access report.
            continue;
        }

        if (looksBinary(content)) continue;

        // Split on both terminators so a CRLF file reports clean line text.
        const lines = content.split(/\r?\n/);

        // One bounded call per FILE (not per line): the vm boundary is crossed once,
        // and a catastrophic pattern is stopped by the cumulative deadline.
        for (const index of matcher.testLines(lines)) {
            const snippet = truncateSnippet(lines[index], FILE_GREP_MATCH_TEXT_BYTES);

            // The cap and the budget are checked against a match that EXISTS but
            // cannot be returned, which is exactly what makes `truncated` truthful:
            // there is provably more result beyond the window. An exact fit (cap or
            // budget reached on the last match) is NOT truncation.
            if (matches.length >= limit || bytes + snippet.bytes > FILE_GREP_CONTENT_BUDGET) {
                truncated = true;
                break;
            }

            matches.push({
                path: candidate.display,
                line: index + 1,
                text: snippet.text,
                textTruncated: snippet.textTruncated,
                bytes: snippet.bytes
            });
            bytes += snippet.bytes;
        }

        if (truncated) break;
    }

    return { matches, truncated, bytes, contentBudget: FILE_GREP_CONTENT_BUDGET };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const GREP_METADATA: PresetToolMetadata = {
    name: 'grep',
    description:
        'Search file CONTENTS with a regular expression and return the matching lines. `pattern` (required) is JavaScript regular-expression SOURCE without delimiters or flags, e.g. "TODO|FIXME"; invalid source is an error naming the parser message, never "no matches". `patterns` (default ["**/*"]) is the glob filter for which files to read - same matcher as glob: *, ?, **, and [abc] classes, a pattern with no slash also matches file names at any depth, and patterns are matched against each path RELATIVE TO THE ROOT that found it. `paths` (default ["."]) lists the roots to walk in order; overlapping roots and patterns are deduplicated by real file identity, so a file is searched once, under the first root that reached it. Each hit is { path, line, text, textTruncated, bytes }: `line` is the 1-based line number in the file, `text` is at most a 1024-byte UTF-8 snippet (`textTruncated` says when the line was cut), and the whole result shares a 64 KiB aggregate budget reported as `bytes` / `contentBudget`. { "matches": [...], "truncated": boolean, "bytes": number, "contentBudget": number } - `truncated` is true only when the 100-match cap or the byte budget stopped the search, so a narrow rerun is the way to see the rest. Matching is time-bounded: a pattern that backtracks past the 30-second budget is stopped with an error rather than allowed to hang. Skips .git, node_modules, symlinks, binary files, and files larger than 1 MiB. Does not read .gitignore files, and does not list file names (use glob for that).',
    tags: ['files', 'grep', 'search', 'content', 'regex', 'filesystem'],
    // R18: grep is core because content search is the single most common way a coding
    // agent locates code. It replaces fileGlob's `content` mode; that property no
    // longer exists anywhere, and there is no `fileSearch` alias.
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                minLength: 1,
                description:
                    'JavaScript regular-expression source to match inside each file, e.g. "TODO|FIXME". No delimiters and no flags.'
            },
            patterns: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Glob patterns selecting which files to read, OR-ed together and matched against each file path relative to its root, e.g. ["**/*.test.ts"]. Defaults to ["**/*"].'
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Root directories to walk, absolute or relative to the working directory, in the order they are visited. Results are prefixed with the root that found them. Defaults to ["."].'
            },
            maxResults: {
                type: 'number',
                description:
                    'Maximum matching lines to return across all roots. Defaults to 100 and is clamped to 1-100.'
            }
        },
        required: ['pattern'],
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = GREP_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    // Sits directly beside glob (210) so the two search presets enumerate together.
    order: 215,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const grep = tool<FileGrepParameters, FileGrepResult>({
    ...GREP_METADATA,
    execute: async ({ parameters }) => {
        // Four properties, so `parameters` is the whole object. `pattern` is required,
        // and the schema enforces that; a direct caller bypasses the schema, so the
        // same rule is checked here rather than handing `undefined` to `new RegExp`.
        const input = normalizeObjectArgument(parameters, ARGUMENT_SHAPE_ERROR);

        const source = input.pattern;

        if (typeof source !== 'string' || source.length === 0) {
            throw new HarnessError(
                'grep requires a non-empty "pattern" regular-expression string, e.g. {"pattern":"TODO"}.'
            );
        }

        const patterns = normalizeStringList('grep', input.patterns, 'patterns', ['**/*']);
        const roots = normalizeStringList('grep', input.paths, 'paths', ['.']);
        const limit = clampMaxResults(input.maxResults as number | undefined);

        return searchContents(roots, compilePatterns(patterns), limit, source);
    }
});
