// fileGlob — find files by glob pattern, optionally searching their contents.
//
// WHY ONE TOOL (T14 unification)
// ------------------------------
// The old catalogue had two tools over the same walker: globFiles (file names) and
// searchFiles (file contents). They differed only in the last step, and a model
// asking "where is TODO defined in the .ts files?" had to call both. fileGlob is
// the single entry point:
//
//     filename mode  fileGlob({ patterns: ['**/*.ts'] })
//     content mode   fileGlob({ patterns: ['**/*.ts'], content: 'TODO' })
//
// MODE DISCRIMINATION (documented contract, not a guess)
// ------------------------------------------------------
// The MODE is chosen by the presence of the `content` property:
//   - absent  -> { files: string[], truncated: boolean }
//   - present -> { matches: { path, line, text }[], truncated: boolean }
// A caller must check for `content` in the request (or `matches` in the result) to
// know which shape it got. There is no mixed shape: a content search never returns
// bare paths, and a filename search never returns matches.
//
// ARGUMENTS
// ---------
//   patterns   Glob patterns, OR-ed. Default ['**/*']. A pattern with no "/" also
//              matches the file name at any depth, so '*.ts' finds src/a.ts.
//   paths      Directories to walk, in caller order. Default ['.'].
//   content    Optional JavaScript regular-expression SOURCE. When present, only
//              files matching `patterns` are read, and each line that matches is
//              reported. Invalid source throws (the parser's message is the useful
//              answer, not "no matches"). Matching is BOUNDED: see ./bounded-regex,
//              a catastrophic pattern is stopped by a timeout instead of hanging
//              the harness.
//   maxResults Requested cap, clamped to 1-100. ONE global cap across every root
//              and pattern, not a per-root budget.
//
// CONTENT BOUNDS (this revision)
// ------------------------------
// A content search used to copy each matching LINE in full, so one match on a
// minified bundle (a single multi-megabyte line) could blow up the whole response.
// Every match is now bounded twice:
//
//   - SNIPPET: at most FILE_GLOB_MATCH_TEXT_BYTES (1 KiB) of UTF-8 per match. The
//     cut is made on a code-point boundary (`for...of` iterates code points, so a
//     surrogate pair is never split). A cut snippet is flagged with
//     `textTruncated: true` on that match — the omission is explicit, never silent.
//   - AGGREGATE: at most FILE_GLOB_CONTENT_BUDGET (64 KiB) of UTF-8 match text per
//     call, the same budget fileRead uses. When the next match would cross it the
//     search stops and `truncated: true` is reported, because a match that exists
//     was NOT returned. The returned matches stay a genuine prefix of the walk, so
//     re-running with a narrower pattern is the honest way to see the rest.
//
// `line` is always the ORIGINAL 1-based line number, even when the snippet was cut;
// `bytes` is the UTF-8 size of the returned snippet (not of the whole line). The
// result reports `bytes` (charged against the budget) and `contentBudget` (the cap
// itself) so a caller can see the policy it is subject to. Only CONTENT mode is
// byte-bounded: filename mode returns short paths capped by maxResults, and its
// `{ files, truncated }` shape is unchanged.
//
// PATTERNS ARE RELATIVE TO EACH ROOT
// ----------------------------------
// A pattern is matched against the path of a file RELATIVE TO THE ROOT that found
// it, and results are prefixed with that root. So
//
//     fileGlob({ paths: ['src'], patterns: ['**/*.ts'] })
//
// returns ['src/a.ts', 'src/nested/b.ts'], and the same patterns rooted at '.'
// return the same files with their paths from '.'. A pattern is never matched
// against the absolute path, and the roots are never OR-ed into one pattern space.
//
// PATHS
// -----
// Results are root-prefixed and posix-style, exactly like fileList: walking '.' and
// 'src' yields 'a.ts' and 'src/b.ts'. Overlapping roots (['src', '.'] or
// patterns that both match one file) are deduplicated by RESOLVED FILE IDENTITY, so
// a file appears once, under the FIRST root that reached it. A root that resolves to
// a directory already walked (a symlink alias, or 'src' and 'SRC' on Windows) is
// skipped entirely. Root order and the depth-first name-sorted walk are both stable,
// so the capped set is deterministic.
//
// PRESERVED POLICY (unchanged from the two old tools)
// ---------------------------------------------------
//   - .git, node_modules, and symlinks are never entered;
//   - .gitignore is NOT consulted;
//   - content mode skips files over 1 MiB and files containing a NUL byte;
//   - a root that cannot be listed throws; unreadable subtrees/files are skipped;
//   - no sandbox: roots are resolved against the process working directory.
//
// Executable on its own and registerable on a harness:
//
//     await fileGlob({ patterns: ['**/*.test.ts'] });
//     await fileGlob({ patterns: ['*.ts'], content: 'TODO', maxResults: 20 });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { readFile as readTextFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { createBoundedLineMatcher } from './bounded-regex';
import { canonicalPathKey, fileIdentity } from './identity';
import {
    clampMaxResults,
    globToRegExp,
    isSearchableFileSize,
    looksBinary,
    toPosixPath,
    walkFiles
} from './glob';

// Maximum UTF-8 bytes of ONE matching line returned as `text`. A longer line is cut
// on a code-point boundary and flagged with `textTruncated: true`.
export const FILE_GLOB_MATCH_TEXT_BYTES = 1024;

// Maximum UTF-8 bytes of match text across the whole call (the same 64 KiB budget
// fileRead uses). Reaching it ends the search with `truncated: true`.
export const FILE_GLOB_CONTENT_BUDGET = 64 * 1024;

export type FileGlobParameters = {
    // Glob patterns, OR-ed. Defaults to ['**/*'] (every file).
    patterns?: string[];
    // Directories to walk, in caller order. Defaults to ['.'].
    paths?: string[];
    // Regular-expression source; its presence switches the tool to content mode.
    content?: string;
    // Requested cap; clamped to 1-100 and applied globally across all roots.
    maxResults?: number;
};

// One matching line, in content mode.
export type FileGlobMatch = {
    // Root-prefixed path, posix-style on every platform.
    path: string;
    // 1-based line number IN THE FILE (unchanged by snippet truncation).
    line: number;
    // The line, without its terminator, cut to FILE_GLOB_MATCH_TEXT_BYTES at most.
    text: string;
    // True when the line was longer than the snippet cap, so `text` is a PREFIX and
    // the rest of that line was not returned. Explicit, never a silent omission.
    textTruncated: boolean;
    // UTF-8 bytes in `text` (the snippet), charged against the aggregate budget.
    bytes: number;
};

// Filename-mode result.
export type FileGlobFilesResult = {
    // Matching paths, in walk order, deduplicated, capped.
    files: string[];
    // True when the cap was hit and more matches exist beyond the returned set.
    truncated: boolean;
};

// Content-mode result.
export type FileGlobMatchesResult = {
    matches: FileGlobMatch[];
    // True when the cap OR the byte budget stopped the search and more matches
    // exist beyond the returned set. A genuinely complete result is false.
    truncated: boolean;
    // Total UTF-8 bytes of match text returned across `matches`.
    bytes: number;
    // The fixed aggregate content budget this call was subject to. Metadata only.
    contentBudget: number;
};

// The discriminated union a caller gets back.
export type FileGlobResult = FileGlobFilesResult | FileGlobMatchesResult;

// Validate the whole argument object.
//
// `parameters` may be absent (a direct `fileGlob()` call, the documented "every
// file under '.'" request) or a plain object. Anything else — a string, an array, a
// number — used to slip through the property reads below and silently mean "use
// every default", i.e. list every file in the tree. That is a wrong answer, not a
// convenience, so it is rejected instead.
const normalizeInput = (value: unknown): FileGlobParameters => {
    if (value === undefined || value === null) return {};

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new HarnessError(
            'fileGlob expects an object with optional "patterns", "paths", "content", and "maxResults" properties, e.g. {"patterns":["**/*.ts"]}.'
        );
    }

    return value as FileGlobParameters;
};

// Validate one string-array argument (patterns or paths).
//
// An explicitly empty array is rejected instead of defaulted: `{"patterns": []}`
// reads as "match nothing", which would make a model conclude a file does not
// exist. Omitting the property is how a caller asks for the documented default.
const normalizeList = (value: unknown, name: 'patterns' | 'paths', fallback: readonly string[]): string[] => {
    if (value === undefined) return [...fallback];

    if (!Array.isArray(value)) {
        throw new HarnessError(`fileGlob ${name} must be an array of strings.`);
    }

    if (value.length === 0) {
        throw new HarnessError(
            `fileGlob received an empty ${name} array. Omit ${name} to use the default (${fallback
                .map((entry) => `"${entry}"`)
                .join(', ')}).`
        );
    }

    for (const entry of value) {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new HarnessError(`fileGlob ${name} must be non-empty strings.`);
        }

        // NUL cannot exist in a real path or pattern and would only confuse the
        // filesystem or the matcher.
        if (entry.includes('\u0000')) {
            throw new HarnessError(`fileGlob ${name} must not contain NUL characters.`);
        }
    }

    return [...value];
};

// Compile the patterns ONCE. Compiling per file would be correct but wasteful, and
// this is also where the "no slash means match the file name too" rule lives (the
// same rule ./glob.ts documents for matchGlob).
const compilePatterns = (patterns: readonly string[]): { matcher: RegExp; namesOnly: boolean }[] =>
    patterns.map((pattern) => ({
        matcher: globToRegExp(pattern),
        // A pattern with no "/" additionally matches against the bare file name.
        namesOnly: !pattern.includes('/')
    }));

// Does one root-relative path match any pattern?
const matchesAny = (
    compiled: ReturnType<typeof compilePatterns>,
    relativePath: string
): boolean => {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);

    for (const { matcher, namesOnly } of compiled) {
        if (matcher.test(relativePath)) return true;
        if (namesOnly && matcher.test(name)) return true;
    }

    return false;
};

// A candidate file: its dedupe identity, the path shown to the caller, and the
// absolute path used to read it.
type Candidate = {
    // Canonical file key; the dedupe key (one file, one entry). See ./identity.
    identity: string;
    // Root-prefixed posix path, exactly the presentation fileList uses.
    display: string;
    // Absolute path for a content read.
    absolute: string;
};

// Walk every root in caller order and yield the files matching any pattern.
//
// Deduplication happens here rather than per root, because overlapping roots are
// the reason it is needed at all: the first root that reaches a file wins, which is
// what makes the caller's root order meaningful. The walk itself is already
// deterministic (depth-first, name-sorted, see ./glob.ts).
//
// Two levels of dedupe, because `resolve()` alone sees neither:
//   - ROOT identity (realpath, case-folded on Windows) — so `src` and `SRC`, or a
//     symlinked alias of a root, walk the tree once instead of listing every file
//     twice under two prefixes;
//   - FILE identity — the walker never follows symlinks, so once the root is
//     resolved every yielded file is its own real path; a resolved key is enough
//     and costs no extra stat per file.
const collect = async function* (
    roots: readonly string[],
    compiled: ReturnType<typeof compilePatterns>
): AsyncGenerator<Candidate> {
    const seenFiles = new Set<string>();
    const seenRoots = new Set<string>();

    for (const root of roots) {
        // resolve() gives the read path; join() with the ORIGINAL root gives the
        // presentation, so "." stays prefix-free.
        const absoluteRoot = resolve(root);

        // A root that is the same directory as one already walked contributes only
        // duplicates. Compared by real identity (./identity.ts) so a symlink alias
        // cannot smuggle in a second pass; this is one realpath per root, not per
        // file.
        const rootIdentity = await fileIdentity(absoluteRoot);
        if (seenRoots.has(rootIdentity)) continue;
        seenRoots.add(rootIdentity);

        for await (const relativePath of walkFiles(absoluteRoot)) {
            if (!matchesAny(compiled, relativePath)) continue;

            const absolute = join(absoluteRoot, relativePath);
            const fileKey = canonicalPathKey(absolute);

            if (seenFiles.has(fileKey)) continue;
            seenFiles.add(fileKey);

            yield {
                identity: fileKey,
                // join() collapses "./src" to "src" and "." to a bare name, so the
                // display path is root-prefixed without ever doubling a separator.
                // toPosixPath keeps the separator convention of every other result.
                display: toPosixPath(join(root, relativePath)),
                absolute
            };
        }
    }
};

// Filename mode: collect capped paths and prove truncation by one extra match.
const listMatchingFiles = async (
    roots: readonly string[],
    compiled: ReturnType<typeof compilePatterns>,
    limit: number
): Promise<FileGlobFilesResult> => {
    const files: string[] = [];
    let truncated = false;

    for await (const candidate of collect(roots, compiled)) {
        files.push(candidate.display);

        // One past the cap proves truncation; the extra entry is dropped.
        if (files.length > limit) {
            truncated = true;
            break;
        }
    }

    return { files: truncated ? files.slice(0, limit) : files, truncated };
};

// Cut one matching line down to the snippet cap WITHOUT splitting a code point.
//
// `for...of` over a string iterates code points, so a surrogate pair (an emoji, an
// astral character) contributes its whole 4-byte sequence or nothing. Measuring in
// UTF-8 bytes rather than UTF-16 units is what makes the cap match what the caller
// actually receives on the wire. A line that already fits is returned untouched
// (same string instance), so the common case allocates nothing.
const truncateSnippet = (
    line: string,
    maxBytes: number
): { text: string; bytes: number; textTruncated: boolean } => {
    const bytes = Buffer.byteLength(line, 'utf8');

    if (bytes <= maxBytes) return { text: line, bytes, textTruncated: false };

    let used = 0;
    let text = '';

    for (const character of line) {
        const size = Buffer.byteLength(character, 'utf8');

        // Stop BEFORE the character that would cross the cap: the snippet is a
        // prefix of the line, never a re-encoded fragment.
        if (used + size > maxBytes) break;

        text += character;
        used += size;
    }

    return { text, bytes: used, textTruncated: true };
};

// Content mode: read each candidate, skip binary/oversized files, and report every
// matching line. Both the match cap and the aggregate byte budget are global across
// roots and patterns.
const searchContents = async (
    roots: readonly string[],
    compiled: ReturnType<typeof compilePatterns>,
    limit: number,
    source: string
): Promise<FileGlobMatchesResult> => {
    // Built once per search: compiling the pattern validates it (a SyntaxError is
    // the caller's regex being wrong and propagates so the model sees the parser
    // message) and one vm context plus one deadline cover every file.
    const matcher = createBoundedLineMatcher(source);

    const matches: FileGlobMatch[] = [];
    let bytes = 0;
    let truncated = false;

    for await (const candidate of collect(roots, compiled)) {
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

        // One bounded call per FILE (not per line): the vm boundary is crossed
        // once, and a catastrophic pattern is stopped by the cumulative deadline.
        for (const index of matcher.testLines(lines)) {
            const snippet = truncateSnippet(lines[index], FILE_GLOB_MATCH_TEXT_BYTES);

            // The cap and the budget are checked against a match that EXISTS but
            // cannot be returned, which is exactly what makes `truncated` truthful:
            // there is provably more result beyond the window. An exact fit (cap or
            // budget reached on the last match) is NOT truncation.
            if (matches.length >= limit || bytes + snippet.bytes > FILE_GLOB_CONTENT_BUDGET) {
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

    return { matches, truncated, bytes, contentBudget: FILE_GLOB_CONTENT_BUDGET };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const FILE_GLOB_METADATA: PresetToolMetadata = {
    name: 'fileGlob',
    description:
        'Find files by glob pattern, and optionally search their contents in the same call. `patterns` (default ["**/*"]) supports *, ?, **, and [abc] classes; a pattern with no slash also matches file names at any depth. Patterns are matched against each file\'s path RELATIVE TO THE ROOT that found it, never against an absolute path, and every result is prefixed with that root: { "paths": ["src"], "patterns": ["**/*.ts"] } returns "src/a.ts" and "src/nested/b.ts". `paths` (default ["."]) lists the roots to walk, in order; overlapping roots and patterns are deduplicated by real file identity (a symlink alias or a case-alias root is walked once), so a file is reported once, under the first root that reached it. WITHOUT `content` the result is { files, truncated }. WITH `content` (a JavaScript regular expression) every file matching the patterns is read and each matching line is returned as { matches: [{ path, line, text, textTruncated, bytes }], truncated, bytes, contentBudget }; a pattern that backtracks past the 30-second matching budget is stopped with an error rather than allowed to hang. A matched line is reported as a 1024-byte UTF-8 snippet (that match carries `textTruncated` when the line was cut, and its `bytes` is the returned snippet size), and the whole content result shares a 64 KiB aggregate budget (top-level `bytes` / `contentBudget`). Content mode skips .git, node_modules, symlinks, binary files, and files larger than 1 MiB. Results are capped (100 by default) across all roots. Does not read .gitignore files.',
    tags: ['files', 'glob', 'search', 'grep', 'find', 'content', 'filesystem'],
    // R18: fileGlob is core because it is the ONE search surface (filename and
    // content). There is deliberately no fileSearch alias/tool: the previous
    // consolidation stays, and its functionality is now always declared.
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
            content: {
                type: 'string',
                description:
                    'JavaScript regular expression to match inside each file, e.g. "TODO|FIXME". Providing it switches the result from file paths to matching lines. Matching is time-bounded.'
            },
            maxResults: {
                type: 'number',
                description:
                    'Maximum files or matches to return across all roots. Defaults to 100 and is clamped to 1-100.'
            }
        },
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = FILE_GLOB_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    order: 210,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const fileGlob = tool<FileGlobParameters, FileGlobResult>({
    ...FILE_GLOB_METADATA,
    execute: async ({ parameters }) => {
        // The schema declares four properties, so `parameters` is the whole object
        // (the single-property rule does not apply). A direct caller may still pass
        // nothing at all, which is the documented "every file under '.'" request; a
        // string or an array is a caller mistake and is rejected, not defaulted.
        const input = normalizeInput(parameters);

        const patterns = normalizeList(input.patterns, 'patterns', ['**/*']);
        const roots = normalizeList(input.paths, 'paths', ['.']);
        const limit = clampMaxResults(input.maxResults);

        // `content` is validated for type even when it is not used, so a model that
        // sends `{"content": 7}` is told the truth instead of silently getting a
        // filename listing.
        if (input.content !== undefined && typeof input.content !== 'string') {
            throw new HarnessError('fileGlob content must be a regular-expression string when provided.');
        }

        const compiled = compilePatterns(patterns);

        return input.content === undefined
            ? listMatchingFiles(roots, compiled, limit)
            : searchContents(roots, compiled, limit, input.content);
    }
});
