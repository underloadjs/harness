// glob — find files by glob pattern. FILE NAMES ONLY.
//
// WHAT CHANGED (rename + split, then this revision)
// --------------------------------------------------
// This entry used to be `fileGlob`, one tool with two modes: filename matching, plus
// an optional `content` regex that switched the result to matching lines. The mode
// switch is gone. Content search is its own tool, `grep` (./grep.tool.ts), so a
// caller asks for the capability it actually wants by NAME instead of by the presence
// of a property:
//
//     glob({ patterns: ['**/*.ts'] })                 -> { files, truncated, ... }
//     grep({ pattern: 'TODO', patterns: ['*.ts'] })   -> { matches, truncated, ... }
//
// There is deliberately no `content` property left here, and no old wire alias: a
// request that still sends `content` is rejected as an unknown property
// (`additionalProperties: false`), because silently ignoring it would answer a
// question the caller did not get an answer to.
//
// What THIS revision adds is the half that was missing rather than wrong: a way to
// page a capped answer, and a way to tell "nothing matched" from "something was
// withheld".
//
// ARGUMENTS
// ---------
//   patterns   Glob patterns, OR-ed. Default ['**/*']. A pattern with no "/" also
//              matches the file name at any depth, so '*.ts' finds src/a.ts.
//              `{a,b}` expands to one pattern per alternative, and a leading `!`
//              excludes — both used to be silent wrong answers (see ./search
//              `compilePatterns`).
//   paths      Directories to walk, in caller order. Default ['.']. A FILE is also
//              accepted and means "just that file".
//   offset     0-based index into the deterministic result sequence. Default 0.
//   maxResults Requested cap, clamped to 1-1000. ONE global cap across every root
//              and pattern, not a per-root budget.
//
// RESULT
// ------
//   {
//     files, truncated, offset, limit, nextOffset,
//     bytes, contentBudget, patterns, excluded, note?
//   }
//
// Matching paths in walk order, deduplicated, capped, and now PAGEABLE: the walk is
// depth-first over name-sorted entries, so a capped result is a deterministic prefix
// of the tree — exactly the precondition `offset`/`nextOffset` need. `read` and
// `files` already paged; a search that could not was the asymmetry that left a
// caller guessing a narrower pattern.
//
// Two bounds can close a page, and `nextOffset` is correct for both:
//   - `limit` entries (default 100, hard maximum 1000 — raised from 100, which made a
//     369-file question unanswerable and never echoed the cap it had applied);
//   - FILE_GLOB_CONTENT_BUDGET (64 KiB) of UTF-8 path text, the same budget read,
//     files and grep enforce. A page stops BEFORE the entry that would cross it.
//
// `truncated` is proven by one extra match beyond the window, never guessed, and
// `stopReason` says which bound did it. `excluded` reports what the WALK did not
// yield — files an ignore rule excluded, directories pruned by a rule or by name,
// directories that could not be read, symlinks, and whether the .gitignore caps
// dropped rules — so `files: []` is now explainable: 369 `.min.js` files under a
// pruned `node_modules` and genuinely absent files produce different numbers.
// `partial` is true when the scope itself was incomplete (an unreadable directory),
// which `truncated` deliberately does not claim.
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
// Results are root-prefixed and posix-style, exactly like files: walking '.' and
// 'src' yields 'a.ts' and 'src/b.ts'. Overlapping roots (['src', '.'] or patterns that
// both match one file) are deduplicated by RESOLVED FILE IDENTITY, so a file appears
// once, under the FIRST root that reached it. A root that resolves to a directory
// already walked (a symlink alias, or 'src' and 'SRC' on Windows) is skipped entirely.
// Root order and the depth-first name-sorted walk are both stable, so the capped set is
// deterministic.
//
// PRESERVED POLICY
// ----------------
//   - .git and symlinks are never entered; node_modules is, unless the search is rooted
//     inside it (naming a directory is how a caller asks for it);
//   - `.gitignore` files AT OR BELOW each root are consulted (./gitignore.ts): a path an
//     ignore rule excludes is not listed. No rule from ABOVE a root applies, so
//     `paths: ['Temp']` still answers for a directory the enclosing repo ignores;
//   - a root that cannot be walked throws a HarnessError naming the path and the fix
//     (missing, not a directory, permission), instead of a raw ENOENT/ENOTDIR string;
//     unreadable subtrees deeper in the walk are skipped and COUNTED;
//   - no sandbox: roots are resolved against the process working directory.
//
// Executable on its own and registerable on a harness:
//
//     await glob({ patterns: ['**/*.test.ts'] });
//     await glob({ patterns: ['**/*.test.ts'], offset: 100 });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { clampMaxResults, clampOffset } from './glob';
import {
    collectCandidates,
    compilePatterns,
    createSearchStats,
    normalizeObjectArgument,
    normalizeStringList
} from './search';
import type { PatternSet, SearchStats } from './search';

// Maximum UTF-8 bytes of path text across the whole call — the same 64 KiB budget
// read, files and grep enforce. Paths are short strings, so in practice the entry
// cap binds first; the budget is what makes that true by construction rather than by
// luck (1000 entries of a 300-character Windows path is 300 KiB).
export const FILE_GLOB_CONTENT_BUDGET = 64 * 1024;

// The whole argument object (this tool declares four properties, so the
// single-property rule does not apply).
export type FileGlobParameters = {
    // Glob patterns, OR-ed. Defaults to ['**/*'] (every file).
    patterns?: string[];
    // Directories (or single files) to walk, in caller order. Defaults to ['.'].
    paths?: string[];
    // Requested cap; clamped to 1-1000 and applied globally across all roots.
    maxResults?: number;
    // 0-based index into the deterministic result sequence. Defaults to 0.
    offset?: number;
};

// Which bound closed the page.
export type FileGlobStopReason = 'complete' | 'resultCap' | 'contentBudget';

// What the walk did not yield.
export type FileGlobExcluded = {
    ignoredFiles: number;
    prunedDirectories: number;
    skippedDirectories: number;
    unreadableDirectories: number;
    symlinks: number;
    // `.gitignore` files actually parsed; see grep.tool.ts `FileGrepExcluded`.
    ignoreFilesParsed: number;
    ignoreRulesTruncated: boolean;
};

// The result: matching paths, the paging window, and the coverage accounting.
export type FileGlobResult = {
    // Matching paths, in walk order, deduplicated, capped.
    files: string[];
    // True when a path EXISTS beyond this page and was not returned. Proven by
    // finding one, never guessed.
    truncated: boolean;
    // The offset actually used (the caller's, default 0).
    offset: number;
    // The cap actually used after clamping, so a request for 5000 knows it got 1000.
    limit: number;
    // Pass as `offset` for the next page, or null when this is the last page.
    nextOffset: number | null;
    // UTF-8 bytes of `files`, the amount charged against the aggregate budget.
    bytes: number;
    // The fixed aggregate content budget this call was subject to. Metadata only.
    contentBudget: number;
    stopReason: FileGlobStopReason;
    // True when the SCOPE was not fully covered (a directory could not be read).
    // `truncated` says the window closed; this says the walk itself was incomplete.
    partial: boolean;
    // Coverage, in nested scopes: `inScope` is every file that survived the ignore rules
    // and the skip list (what the patterns could have selected), `roots` is how many
    // roots were walked (an alias root is skipped, so this is not `paths.length`). The
    // number of paths actually returned is `files.length`; the difference between
    // `inScope` and the returned count is the pattern filter plus the window, which is
    // what `truncated` and `excluded` separate for the caller. glob walks serially, so
    // `inScope` here is exactly the number of candidates the walk reached before it
    // stopped (grep's can run slightly ahead, because its reads overlap).
    searched: { inScope: number; roots: number };
    excluded: FileGlobExcluded;
    // The patterns actually compiled, after `{a,b}` expansion and with `!` prefixes
    // kept, so a caller can see whether its request was understood.
    patterns: string[];
    // Present only when something was withheld for a reason the caller should act on.
    note?: string;
};

// Message for a non-object argument, kept as one constant because the exact text is
// the published contract (a focused test asserts it verbatim).
const ARGUMENT_SHAPE_ERROR =
    'glob expects an object with optional "patterns", "paths", "maxResults", and "offset" properties, e.g. {"patterns":["**/*.ts"]}.';

// The note is the sentence an empty or partial listing cannot produce on its own.
// Every clause names something the caller can act on, so an all-clean listing gets no
// note at all and its absence is information too.
const buildNote = (stats: SearchStats, stopReason: FileGlobStopReason): string | undefined => {
    const parts: string[] = [];

    if (stopReason === 'contentBudget') {
        parts.push(
            `the page stopped at the ${FILE_GLOB_CONTENT_BUDGET}-byte path-text budget, not at the entry cap; resume with "offset"`
        );
    }

    if (stats.unreadableDirectories > 0) {
        parts.push(
            `${stats.unreadableDirectories} director${stats.unreadableDirectories === 1 ? 'y' : 'ies'} could not be read, so their contents were never listed`
        );
    }

    if (stats.ignoreRulesTruncated) {
        parts.push('the .gitignore rule set hit its per-walk cap, so some ignored paths may have been listed');
    }

    if (stats.ignoredFiles > 0 || stats.prunedDirectories > 0) {
        parts.push(
            `${stats.ignoredFiles} file(s) and ${stats.prunedDirectories} ignored director${
                stats.prunedDirectories === 1 ? 'y' : 'ies'
            } were excluded by .gitignore rules - name such a directory as a root to list it anyway`
        );
    }

    if (stats.skippedDirectories > 0) {
        parts.push(
            `${stats.skippedDirectories} director${
                stats.skippedDirectories === 1 ? 'y was' : 'ies were'
            } skipped by name (.git, node_modules) - root the search inside one to walk it`
        );
    }

    return parts.length === 0 ? undefined : parts.join('; ');
};

// Filename mode: page through the walk, cap the page, prove truncation by one extra
// match, and account for everything the walk dropped.
//
// The generator stops at the first entry past the window, so `glob` never materializes
// a whole tree it was only going to throw away.
const listMatchingFiles = async (
    roots: readonly string[],
    set: PatternSet,
    limit: number,
    offset: number
): Promise<FileGlobResult> => {
    const stats = createSearchStats();
    const files: string[] = [];

    let bytes = 0;
    // Units stepped over to reach `offset`.
    let skipRemaining = offset;
    let truncated = false;
    let budgetStopped = false;

    for await (const candidate of collectCandidates(roots, set, { tool: 'glob', stats })) {
        if (skipRemaining > 0) {
            skipRemaining -= 1;
            continue;
        }

        const size = Buffer.byteLength(candidate.display, 'utf8');

        // The cap first, and BEFORE the impossible-entry test: a page that is already
        // full stops here, so an oversized path further along the walk never has to be
        // returned. The caller resuming at `nextOffset` is the one that meets it, and the
        // error reaches it then — which is the honest position, not a failure reported
        // for an entry that was never going to be in this page.
        if (files.length >= limit) {
            truncated = true;
            break;
        }

        // GUARD, not a reachable outcome: no filesystem this harness runs on can name a
        // file with a 64 KiB path (Linux PATH_MAX is 4096, Windows long paths stop near
        // 32 767), so in practice the cumulative test below is the one that fires. It is
        // kept because the loop is streaming and a single unreturnable entry would
        // otherwise report `truncated: true` with `nextOffset === offset` — a page that
        // never advances — and a caller cannot escape an answer that repeats itself.
        //
        // It must be tested BEFORE the cumulative one: at the start of a page `bytes` is
        // 0 and the two conditions coincide, so the cumulative reading would call the
        // entry a budget stop, promise a resume, and meet it again at the same offset.
        // files orders the two the same way, for the same reason.
        if (size > FILE_GLOB_CONTENT_BUDGET) {
            throw new HarnessError(
                `glob entry "${candidate.display.slice(0, 200)}" is ${size} UTF-8 bytes, larger than the ${FILE_GLOB_CONTENT_BUDGET}-byte page budget, so it can never be returned. Walk a deeper directory so the prefix is shorter.`
            );
        }

        if (bytes + size > FILE_GLOB_CONTENT_BUDGET) {
            truncated = true;
            budgetStopped = true;
            break;
        }

        files.push(candidate.display);
        bytes += size;
    }

    const excluded: FileGlobExcluded = {
        ignoredFiles: stats.ignoredFiles,
        prunedDirectories: stats.prunedDirectories,
        skippedDirectories: stats.skippedDirectories,
        unreadableDirectories: stats.unreadableDirectories,
        symlinks: stats.symlinks,
        ignoreFilesParsed: stats.ignoreFilesParsed,
        ignoreRulesTruncated: stats.ignoreRulesTruncated
    };

    const stopReason: FileGlobStopReason = truncated
        ? budgetStopped
            ? 'contentBudget'
            : 'resultCap'
        : 'complete';

    const note = buildNote(stats, stopReason);

    // `files` goes LAST for the reason grep documents at its return: the harness keeps
    // the beginning of an over-budget serialized result, and the coverage fields are the
    // part a caller needs in order to read a short list correctly.
    return {
        truncated,
        offset,
        limit,
        nextOffset: truncated ? offset + files.length : null,
        bytes,
        contentBudget: FILE_GLOB_CONTENT_BUDGET,
        stopReason,
        // A listing is incomplete in the scope sense only when the walk could not read
        // something; a closed window is `truncated`, not `partial`.
        partial: excluded.unreadableDirectories > 0,
        searched: { inScope: stats.candidates, roots: stats.roots },
        excluded,
        patterns: set.effective,
        // The key is absent, not `undefined`, so a caller can read `note === undefined`
        // as "nothing needed explaining" and a JSON round trip cannot invent a key.
        ...(note === undefined ? {} : { note }),
        files
    };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const GLOB_METADATA: PresetToolMetadata = {
    name: 'glob',
    description:
        'Find FILES by glob pattern: names only, never file contents (use grep for that). `patterns` (default ["**/*"]) supports *, ?, **, [abc] classes and {a,b} alternatives; a pattern with no slash also matches file names at any depth, and a leading ! excludes (a list of only ! patterns means "everything except"). Patterns match each file\'s path RELATIVE TO THE ROOT that found it, never an absolute path, and results are prefixed with that root: { "paths": ["src"], "patterns": ["**/*.ts"] } returns "src/a.ts" and "src/nested/b.ts" - so the same root with "src/*.ts" matches nothing. `paths` (default ["."]) lists roots in order and accepts a FILE meaning "just that file"; overlapping roots and patterns are deduplicated by real file identity (a symlink or case-alias root is walked once), so a file is reported once under the first root that reached it. The result is { files, truncated, offset, limit, nextOffset, bytes, contentBudget, stopReason, partial, searched, excluded, patterns, note }: `truncated` is true only when a path that exists was withheld by the entry cap (maxResults, default 100, clamped to 1-1000) or the 64 KiB path-text budget, `limit` echoes the cap actually applied, and `nextOffset` resumes the same deterministic sequence when passed back as `offset`. Nothing is silently dropped: `excluded` counts what the walk did not yield (ignored files, pruned and unreadable directories, name-skipped directories, symlinks, .gitignore cap), `searched` counts what it did, and `note` explains what is worth acting on - so an empty `files` array can be told from a withheld one. Skips .git and symlinks, and skips node_modules unless a root is placed inside it. Reads .gitignore files at or below each root, so an ignored path is not listed - while a root you name explicitly is walked even when an enclosing .gitignore ignores it. Search root and .gitignore: rules are read only at or below the root, so naming a subdirectory as the root deliberately bypasses the ignores above it (a `dist/` under it is walked) and `excluded.ignoreFilesParsed` reports how many rule files were parsed - search from the directory that owns the .gitignore to prune build output. Matching is case-sensitive on every platform, so "*.TS" does not match a.ts. Does not search text.',
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
                    'Glob patterns, OR-ed together and matched against each file path relative to its root, e.g. ["**/*.test.ts"] or ["*.md", "*.txt"] or ["**/*.{ts,tsx}"]; a leading ! excludes, e.g. ["**/*", "!**/*.test.ts"]. A pattern is relative to its root, so ["**/name.ts"] finds that file at any depth instead of descending one directory at a time. Defaults to ["**/*"].'
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Roots to walk, absolute or relative to the working directory, in the order they are visited. A directory is walked recursively; a FILE is listed on its own. Results are prefixed with the root that found them. A root you name explicitly is walked even when a .gitignore above it ignores that directory. Defaults to ["."].'
            },
            maxResults: {
                type: 'number',
                description:
                    'Maximum files to return across all roots. Defaults to 100 and is clamped to 1-1000; the effective cap is echoed as `limit`.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based index into the deterministic result sequence. Defaults to 0; pass nextOffset from the previous page to read the rest of a truncated listing.'
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
        // The schema declares four properties, so `parameters` is the whole object
        // (the single-property rule does not apply). A direct caller may still pass
        // nothing at all, which is the documented "every file under '.'" request; a
        // string or an array is a caller mistake and is rejected, not defaulted.
        const input = normalizeObjectArgument(parameters, ARGUMENT_SHAPE_ERROR);

        const patterns = normalizeStringList('glob', input.patterns, 'patterns', ['**/*']);
        const roots = normalizeStringList('glob', input.paths, 'paths', ['.']);

        // `maxResults` and `offset` are convenience knobs, so a non-number is clamped
        // to the documented default instead of failing the call (see ./glob).
        const limit = clampMaxResults(input.maxResults as number | undefined);
        const offset = clampOffset(input.offset);

        return listMatchingFiles(roots, compilePatterns(patterns), limit, offset);
    }
});
