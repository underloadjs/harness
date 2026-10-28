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
//              answer, not "no matches").
//   maxResults Requested cap, clamped to 1-100. ONE global cap across every root
//              and pattern, not a per-root budget.
//
// PATHS
// -----
// Results are root-prefixed and posix-style, exactly like fileList: walking '.' and
// 'src' yields 'a.ts' and 'src/b.ts'. Overlapping roots (['src', '.'] or
// patterns that both match one file) are deduplicated by RESOLVED FILE IDENTITY, so
// a file appears once, under the FIRST root that reached it. Root order and the
// depth-first name-sorted walk are both stable, so the capped set is deterministic.
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
// Metadata comes from ../catalogue so descriptions and schemas cannot drift.

import { readFile as readTextFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';
import {
    clampMaxResults,
    globToRegExp,
    isSearchableFileSize,
    looksBinary,
    toPosixPath,
    walkFiles
} from './glob';

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
    // 1-based line number.
    line: number;
    // The full line, without its terminator.
    text: string;
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
    // True when the cap was hit and more matches exist beyond the returned set.
    truncated: boolean;
};

// The discriminated union a caller gets back.
export type FileGlobResult = FileGlobFilesResult | FileGlobMatchesResult;

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
    // Resolved absolute path; the dedupe key (one file, one entry).
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
const collect = async function* (
    roots: readonly string[],
    compiled: ReturnType<typeof compilePatterns>
): AsyncGenerator<Candidate> {
    const seen = new Set<string>();

    for (const root of roots) {
        // resolve() gives the dedupe identity and the read path; join() with the
        // ORIGINAL root gives the presentation, so "." stays prefix-free.
        const absoluteRoot = resolve(root);

        for await (const relativePath of walkFiles(absoluteRoot)) {
            if (!matchesAny(compiled, relativePath)) continue;

            const absolute = join(absoluteRoot, relativePath);

            if (seen.has(absolute)) continue;
            seen.add(absolute);

            yield {
                identity: absolute,
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

// Content mode: read each candidate, skip binary/oversized files, and report every
// matching line. The cap is global across roots and patterns.
const searchContents = async (
    roots: readonly string[],
    compiled: ReturnType<typeof compilePatterns>,
    limit: number,
    source: string
): Promise<FileGlobMatchesResult> => {
    // Compile once. A SyntaxError here is the caller's regex being wrong; it
    // propagates so the model sees the parser message instead of "no matches".
    const matcher = new RegExp(source);

    const matches: FileGlobMatch[] = [];
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

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];

            // A caller-supplied source cannot carry a flag, but resetting lastIndex
            // defensively keeps a stateful RegExp (if one ever reaches here) from
            // skipping lines after a match.
            matcher.lastIndex = 0;
            if (!matcher.test(line)) continue;

            matches.push({ path: candidate.display, line: index + 1, text: line });

            // Collect one past the cap: that extra match is how we know the result
            // is genuinely truncated rather than exactly full.
            if (matches.length > limit) {
                truncated = true;
                break;
            }
        }

        if (truncated) break;
    }

    return { matches: truncated ? matches.slice(0, limit) : matches, truncated };
};

export const fileGlob = tool<FileGlobParameters, FileGlobResult>({
    ...PRESET_TOOLS.fileGlob,
    execute: async ({ parameters }) => {
        // The schema declares four properties, so `parameters` is the whole object
        // (the single-property rule does not apply). A direct caller may still pass
        // nothing at all, which is the documented "every file under '.'" request.
        const input = (parameters ?? {}) as FileGlobParameters;

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
