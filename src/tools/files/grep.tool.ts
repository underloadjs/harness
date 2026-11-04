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
//     grep({ pattern: 'TODO' })                             -> every matching line
//     grep({ pattern: 'TODO', patterns: ['*.ts'], maxResults: 20 })
//     grep({ pattern: 'TODO', output: 'files' })            -> which files, no lines
//
// The mode is now an EXPLICIT argument (`output`) that the result echoes, not a
// property-presence rule, and it exists because a survey question ("where is
// `HarnessError` referenced?") used to cost 7+ round trips: the 100-match cap was
// consumed by 17 hits in one file, and every hit needed a follow-up `read` to be
// understood.
//
// ARGUMENTS
// ---------
//   pattern    Required JavaScript regular-expression SOURCE (no delimiters). Flags
//              come from `flags`, not from the source: `(?i)foo` is a JavaScript
//              "Invalid group", while `{ pattern: 'foo', flags: 'i' }` is what a
//              ripgrep-trained caller means. Invalid source throws with the parser's
//              own message, which is the useful answer, not "no matches". Matching is
//              BOUNDED: see ./bounded-regex.
//   flags      JavaScript flag letters (default ""). "i" is the one that matters.
//   patterns   Glob filter for which files to read, OR-ed, default ['**/*'] (every
//              file). `{a,b}` expands; a leading `!` excludes. Same matcher and same
//              root-relative rules as ./glob.tool.
//   paths      Directories to walk, in caller order. Default ['.']. A FILE is also
//              accepted and means "search just that file" (./search `collectCandidates`).
//   output     'content' (default) | 'files' | 'count'.
//   context    0-10 lines before and after each hit (content mode only). Without it
//              every hit costs a follow-up `read` to understand.
//   offset     0-based index into the result sequence; pages a capped search the way
//              read and fileList do. The walk is a deterministic prefix, which is what
//              makes this well defined.
//   maxResults Requested cap, clamped to 1-1000, applied GLOBALLY across every root,
//              pattern and file — not a per-file budget.
//
// RESULT (one shape, the echoed mode, and an explanation of everything withheld)
// -----------------------------------------------------------------------------
//   {
//     output, matches, truncated, offset, limit, nextOffset,
//     bytes, contentBudget, partial, stopReason,
//     searched, skipped, excluded, patterns, note?
//   }
//
// `matches` holds one entry per result UNIT, where a unit is a matching LINE in
// `content` mode and a matching FILE in `files`/`count` mode:
//
//   - content: { path, line, text, textTruncated, bytes } (+ `before`/`after` when
//     `context` is set);
//   - files:   { path, matchCount: null } — one entry per file, and the scan of that
//     file stops at its first matching line;
//   - count:   { path, matchCount: n }   — the exact number of matching lines.
//
// THE HONESTY FIELDS (this revision). A search used to be able to say "no matches"
// when in fact it had skipped every file that could have contained one: a 1.07 MB
// bundle, a 1.37 MB pdf worker, and 10,223 EPERM files all vanished without a trace.
// So every reason a candidate did not reach the result is now counted:
//
//   - `skipped`  — files in scope that were not searched: `tooLarge` (over
//     MAX_SEARCH_FILE_BYTES), `binary`, `unreadable` (could not be opened);
//   - `excluded` — what the WALK did not yield: files an ignore rule excluded,
//     directories pruned by a rule or by name, directories `readdir` could not open,
//     symlinks, and whether the .gitignore caps dropped rules;
//   - `searched` — files actually scanned and roots walked, so an empty result reads
//     as "scanned 1643 files, none matched" rather than "nothing here";
//   - `partial`  — the scope was NOT fully covered (the search budget ran out, or a
//     directory or file could not be read). `truncated` alone never means this;
//   - `stopReason` — 'complete' | 'resultCap' | 'contentBudget' | 'searchBudget':
//     which bound actually closed the window, in the caller's own terms;
//   - `note` — present only when one of the above needs a sentence to be actionable.
//
// CONTENT BOUNDS
// --------------
// A content search used to copy each matching LINE in full, so one match on a
// minified bundle (a single multi-megabyte line) could blow up the whole response.
// Every unit is bounded twice:
//
//   - SNIPPET: at most FILE_GREP_MATCH_TEXT_BYTES (1 KiB) of UTF-8 per match. The cut
//     is made on a code-point boundary (`for...of` iterates code points, so a
//     surrogate pair is never split). A cut snippet is flagged with `textTruncated:
//     true` on that match — the omission is explicit, never silent. Context lines go
//     through the same cap and are flagged with `contextTruncated`.
//   - AGGREGATE: at most FILE_GREP_CONTENT_BUDGET (64 KiB) of UTF-8 returned text per
//     call, the same budget read uses. In `content` mode the charge is the snippet
//     plus its context lines; in `files`/`count` mode it is the path text, so one rule
//     holds in every mode. When the next unit would cross it the search stops and
//     `truncated: true` is reported, because a unit that exists was NOT returned.
//
// `bytes` is the total charged against the budget; an entry's own `bytes` is its
// snippet only, so with `context` the two differ by the context text. `line` is
// always the ORIGINAL 1-based line number, even when the snippet was cut.
//
// TWO TIME BOUNDS, TWO HONEST OUTCOMES (the defect this revision fixes)
// ---------------------------------------------------------------------
// The old implementation ran ONE absolute deadline from the first match, so time
// spent walking and reading consumed a "matching" budget and a repo-wide grep of a
// LITERAL pattern failed with "simplify the pattern: nested quantifiers can
// backtrack" — a wrong diagnosis for a pattern that cannot backtrack, and one that
// passed on a rerun. Now:
//
//   1. REGEX EXECUTION gets MAX_CONTENT_MATCH_MILLIS (30s), charged only by the
//      measured duration of each `runInContext` batch (./bounded-regex). Exhausting
//      it is unambiguously the pattern's fault, so it throws `patternBudgetError`.
//   2. THE WHOLE SEARCH gets MAX_SEARCH_MILLIS (30s) of wall clock, and exhausting it
//      is the TREE's fault, so it returns what it has with `partial: true`,
//      `stopReason: 'searchBudget'`, and a note that says to narrow `paths`/`patterns`.
//
// A big search is therefore a partial answer, and an expensive pattern is an error.
// Neither is ever reported as the other.
//
// EFFICIENCY
// ----------
//   - one `open` + `fstat` + `read` + `close` per candidate (./glob.ts
//     `readSearchableFile`). The previous shape was a separate `stat` and then a whole
//     `readFile`, i.e. two opens and two stats per file, on a walk whose cost IS
//     syscalls;
//   - the binary verdict is taken from the raw Buffer BEFORE decoding, so a 1 MiB
//     minified asset that turns out to be binary never pays for a UTF-8 decode;
//   - file reads overlap (GREP_READ_CONCURRENCY in flight, results yielded in walk
//     order by ./search `mapConcurrent`), while matching stays synchronous and in
//     order — so the result sequence is identical to the serial one, only faster;
//   - the in-context loop stops at the number of indices the caller can still use, and
//     `files` mode stops at a file's first matching line instead of scanning all of it;
//   - the walk stops the moment the window is full and truncation is proven, so a
//     capped search never enumerates the rest of the tree.
//
// SKIPS AND FAILURES
// ------------------
//   - a file over 1 MiB is not read, and a file containing a NUL byte is treated as
//     binary and skipped — both counted in `skipped`, never silently;
//   - .git and symlinks are never entered; node_modules is, unless the search is rooted
//     inside it (naming a directory is how a caller asks for it);
//   - `.gitignore` files AT OR BELOW each root are consulted (./gitignore.ts): a path an
//     ignore rule excludes is never opened, while a root named explicitly is still
//     searched even when a .gitignore above it ignores that directory;
//   - a root that cannot be walked throws a HarnessError naming the path and the fix
//     (a missing path, a file where a directory was meant, a permission denial),
//     instead of an `ENOENT/ENOTDIR ... scandir` string;
//   - a file that cannot be read mid-walk is a race, not a failure: it is counted and
//     the search continues;
//   - no sandbox: roots are resolved against the process working directory.
//
// Executable on its own and registerable on a harness:
//
//     await grep({ pattern: 'TODO|FIXME', patterns: ['*.ts'], maxResults: 20 });
//     await grep({ pattern: 'HarnessError', output: 'count' });
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import {
    createBoundedLineMatcher,
    isPatternBudgetError,
    MAX_CONTENT_MATCH_MILLIS
} from './bounded-regex';
import { clampMaxResults, clampOffset, MAX_SEARCH_FILE_BYTES, readSearchableFile } from './glob';
import type { SearchFileRead } from './glob';
import {
    collectCandidates,
    compilePatterns,
    createSearchStats,
    mapConcurrent,
    normalizeObjectArgument,
    normalizeStringList,
    truncateSnippet
} from './search';
import type { PatternSet, SearchCandidate } from './search';

// Maximum UTF-8 bytes of ONE matching line returned as `text`. A longer line is cut
// on a code-point boundary and flagged with `textTruncated: true`.
export const FILE_GREP_MATCH_TEXT_BYTES = 1024;

// Maximum UTF-8 bytes of returned text across the whole call (the same 64 KiB budget
// read uses). Reaching it ends the search with `truncated: true`.
export const FILE_GREP_CONTENT_BUDGET = 64 * 1024;

// Wall-clock bound on one whole search — walk, reads and matching together. This is
// the bound a LARGE TREE hits, and it produces a partial result rather than an error
// (see the two-bounds note above). The number is the one the previous revision
// published as its "matching" budget, so the published ceiling has not quietly moved;
// only what happens when it is reached has changed.
export const MAX_SEARCH_MILLIS = 30_000;

// File reads in flight at once. Reading is the part of a content search that waits on
// the OS; 8 hides most of that latency without exhausting descriptors or drowning the
// event loop. Matching stays serial, which is what keeps the vm matcher single-threaded
// and the result order identical to the serial walk.
export const GREP_READ_CONCURRENCY = 8;

// Context lines a caller may ask for on either side of a hit. Bounded because the
// feature exists to make a hit readable in one call, not to return the file.
export const MAX_GREP_CONTEXT_LINES = 10;

// Which verdict the caller wants. `files` and `count` are the two survey questions
// that used to cost a round trip each, per file.
export type FileGrepOutput = 'content' | 'files' | 'count';
export const GREP_OUTPUTS: readonly FileGrepOutput[] = ['content', 'files', 'count'];

// One matching LINE (`content` mode).
export type FileGrepLine = {
    // Root-prefixed path, posix-style on every platform.
    path: string;
    // 1-based line number IN THE FILE (unchanged by snippet truncation).
    line: number;
    // The line, without its terminator, cut to FILE_GREP_MATCH_TEXT_BYTES at most.
    text: string;
    // True when the line was longer than the snippet cap, so `text` is a PREFIX and
    // the rest of that line was not returned. Explicit, never a silent omission.
    textTruncated: boolean;
    // UTF-8 bytes of `text` (the snippet). The aggregate `bytes` also charges context
    // lines, so the two differ when `context` is set.
    bytes: number;
    // Up to `context` lines before and after the hit. Present ONLY when the caller
    // asked for context, so the default entry shape is unchanged. Each line is cut to
    // the same 1 KiB snippet cap as `text` (see `contextTruncated`).
    before?: string[];
    after?: string[];
    // Present (and true) only when at least one context line was cut to the snippet
    // cap. A minified file with `context: 10` would otherwise charge up to 20 MiB for
    // ONE hit, which is both an oversized result and — because no page could ever hold
    // it — a `nextOffset` that never advances.
    contextTruncated?: boolean;
};

// One matching FILE (`files` and `count` modes).
export type FileGrepFile = {
    path: string;
    // `count` mode: the exact number of matching lines. `files` mode: always null, and
    // deliberately not 1 — the scan stops at the first match, so the number was never
    // established and a `1` would read as one that was counted. A `count` result never
    // carries null: a file whose count was not taken is one the window had no room for,
    // and it is dropped rather than returned with a placeholder.
    matchCount: number | null;
};

export type FileGrepMatch = FileGrepLine | FileGrepFile;

// Which bound closed the window.
export type FileGrepStopReason = 'complete' | 'resultCap' | 'contentBudget' | 'searchBudget';

// Files in scope that were never searched, and why.
export type FileGrepSkipped = {
    tooLarge: number;
    binary: number;
    unreadable: number;
};

// What the walk did not yield.
export type FileGrepExcluded = {
    ignoredFiles: number;
    prunedDirectories: number;
    skippedDirectories: number;
    unreadableDirectories: number;
    symlinks: number;
    // `.gitignore` files actually parsed. Together with `ignoreRulesTruncated` this says
    // how much of the repository's rule set was in force for this answer.
    ignoreFilesParsed: number;
    ignoreRulesTruncated: boolean;
};

// The result shape.
export type FileGrepResult = {
    // The mode this call answered, echoed so a caller never has to remember which
    // shape it asked for.
    output: FileGrepOutput;
    matches: FileGrepMatch[];
    // True when a unit EXISTS beyond this window and was not returned — proven by
    // finding one, never guessed. `nextOffset` then says where to resume.
    truncated: boolean;
    // The offset actually used (the caller's, default 0).
    offset: number;
    // The cap actually used after clamping, so a request for 5000 knows it got 1000.
    limit: number;
    // Pass as `offset` for the next page, or null when this is the last page.
    nextOffset: number | null;
    // Total UTF-8 bytes charged against the budget (snippets, context lines, and path
    // text in files/count modes).
    bytes: number;
    // The fixed aggregate content budget this call was subject to. Metadata only.
    contentBudget: number;
    // True when the scope was NOT fully covered: the search budget ran out, or a
    // directory or file could not be read. Distinct from `truncated`, which only says
    // the WINDOW closed while more results were provably waiting.
    partial: boolean;
    stopReason: FileGrepStopReason;
    // Coverage of the search itself, in nested scopes so an empty result can be read
    // without guessing:
    //   - `inScope` — files the WALK yielded, i.e. everything that survived the ignore
    //     rules and the skip list and could have been selected. It counts what the walk
    //     produced, which the overlapping read pipeline can leave slightly ahead of what
    //     the consumer processed; `scanned` and `skipped` are the consumer-side numbers and
    //     always add up to what was actually handled;
    //   - `scanned` — of those, the files whose CONTENTS were actually matched (a file
    //     the pattern filter rejected, or one skipped as binary/oversized, is not here);
    //   - `roots` — roots walked (a duplicate or alias root is skipped, so this is not
    //     `paths.length`).
    searched: { inScope: number; scanned: number; roots: number };
    skipped: FileGrepSkipped;
    excluded: FileGrepExcluded;
    // The patterns actually compiled, after `{a,b}` expansion and with `!` prefixes
    // kept, so a caller can see whether its request was understood.
    patterns: string[];
    // Present only when something was withheld for a reason the caller should act on.
    note?: string;
};

// The validated request.
export type FileGrepParameters = {
    // Regular-expression source to match inside each candidate file. Required.
    pattern: string;
    // Glob filter for which files to read. Defaults to ['**/*'].
    patterns?: string[];
    // Directories (or single files) to walk, in caller order. Defaults to ['.'].
    paths?: string[];
    // Requested cap; clamped to 1-1000 and applied globally across all roots.
    maxResults?: number;
    // 0-based index into the result sequence. Defaults to 0.
    offset?: number;
    // JavaScript flag letters. Defaults to '' (no flags).
    flags?: string;
    // Which verdict to return. Defaults to 'content'.
    output?: FileGrepOutput;
    // Context lines on each side of a hit, 0-10. Defaults to 0.
    context?: number;
};

// A normalized request: everything the search loop needs, defaults resolved.
export type FileGrepRequest = {
    source: string;
    flags: string;
    output: FileGrepOutput;
    context: number;
    offset: number;
    limit: number;
    roots: string[];
};

// Message for a non-object argument; the exact text is a published contract.
const ARGUMENT_SHAPE_ERROR =
    'grep expects an object with "pattern" and optional "patterns", "paths", "maxResults", "offset", "flags", "output", and "context" properties, e.g. {"pattern":"TODO","patterns":["**/*.ts"]}.';

// Message for a missing/empty pattern; also a published contract.
const PATTERN_REQUIRED_ERROR =
    'grep requires a non-empty "pattern" regular-expression string, e.g. {"pattern":"TODO"}.';

// Monotonic milliseconds for the wall-clock search bound.
const nowMs = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

// Validate the `output` knob. Unlike `maxResults`, a wrong value here changes the
// SHAPE of the answer, so guessing the documented default would answer a different
// question than the one asked — the same rule that rejects a stale `content` property.
const normalizeOutput = (value: unknown): FileGrepOutput => {
    if (value === undefined || value === null) return 'content';

    if (typeof value !== 'string' || !(GREP_OUTPUTS as readonly string[]).includes(value)) {
        throw new HarnessError(
            `grep output must be one of ${GREP_OUTPUTS.map((name) => `"${name}"`).join(', ')}; got ${
                typeof value === 'string' ? `"${value}"` : typeof value
            }.`
        );
    }

    return value as FileGrepOutput;
};

// Validate `context`. A knob, so it clamps rather than throwing: asking for 50 lines
// plainly means "as many as allowed". A non-number is reported, not defaulted, because
// silently ignoring it would return a context-free answer the caller believes has
// context.
const normalizeContext = (value: unknown): number => {
    if (value === undefined || value === null) return 0;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new HarnessError(
            `grep context must be a number of lines between 0 and ${MAX_GREP_CONTEXT_LINES}.`
        );
    }

    const floored = Math.floor(value);

    return floored < 0 ? 0 : floored > MAX_GREP_CONTEXT_LINES ? MAX_GREP_CONTEXT_LINES : floored;
};

// Validate `flags`. Absent means "no flags", exactly as before; anything outside the
// JavaScript flag letters is reported by ./bounded-regex with the allowed set, because
// `new RegExp` alone blames "Invalid flags" without naming the argument — and
// `(?i)foo`, the ripgrep spelling a caller reaches for first, is "Invalid group".
const normalizeFlags = (value: unknown): string => {
    if (value === undefined || value === null) return '';

    if (typeof value !== 'string') {
        throw new HarnessError('grep flags must be a string of JavaScript flag letters, e.g. "i".');
    }

    return value;
};

// Normalize the whole argument object. Exported so the entry stays a thin shell and a
// host can validate a request without walking anything.
export const normalizeGrepRequest = (parameters: unknown): FileGrepRequest => {
    const input = normalizeObjectArgument(parameters, ARGUMENT_SHAPE_ERROR);

    const source = input.pattern;

    if (typeof source !== 'string' || source.length === 0) {
        throw new HarnessError(PATTERN_REQUIRED_ERROR);
    }

    return {
        source,
        flags: normalizeFlags(input.flags),
        output: normalizeOutput(input.output),
        context: normalizeContext(input.context),
        offset: clampOffset(input.offset),
        limit: clampMaxResults(input.maxResults as number | undefined),
        roots: normalizeStringList('grep', input.paths, 'paths', ['.'])
    };
};

// One result unit plus the bytes it charges against the aggregate budget.
//
// The charge is decided with the unit rather than at push time, because in `content`
// mode with `context` the amount to charge is the snippet PLUS its context lines, and
// only the code that built the entry knows that.
type GrepUnit = { unit: FileGrepMatch; bytes: number };

// What one file contributes, and whether MORE exists beyond that.
//
// A unit is a THUNK. A file that matches 100,000 lines while the caller pages at
// `offset: 50000` must not build 50,000 entries (each with up to 20 context lines) just
// to step over them: the indices are cheap numbers, and only a unit that can actually
// land in the window is materialized. The one exception is deliberate and bounded — the
// single unit built to prove that the byte budget is what stopped the page.
type FileVerdict = {
    units: Array<() => GrepUnit>;
    // True when this file provably holds another unit beyond `units`.
    more: boolean;
};

const NO_MATCH: FileVerdict = { units: [], more: false };

// A verdict whose one and only unit is already built (files/count modes: one per file).
const oneUnit = (unit: GrepUnit): FileVerdict => ({ units: [() => unit], more: false });

// How many of a file's units the caller can still use, and whether any of them will
// actually be returned.
type VerdictWindow = {
    // Units stepped over to reach `offset`.
    skip: number;
    // Units that still fit in the window (cap and budget aside).
    window: number;
};

// Decide one file's verdict from its already-read content.
//
// The in-context loop is asked for exactly `skip + window + 1` indices: the units the
// caller can use, plus ONE more to prove that truncation is real rather than
// suspected. Once the window is full that collapses to a single "is there another
// match?" probe, which is the cheapest question a search can ask.
const verdictFor = (
    candidate: SearchCandidate,
    content: string,
    output: FileGrepOutput,
    context: number,
    window: VerdictWindow,
    matcher: ReturnType<typeof createBoundedLineMatcher>
): FileVerdict => {
    const pathBytes = Buffer.byteLength(candidate.display, 'utf8');

    // Split on both terminators so a CRLF file reports clean line text.
    const lines = content.split(/\r?\n/);

    if (output === 'count') {
        // A file whose single unit cannot be returned (the window is full, or it is
        // being skipped over) only has to prove EXISTENCE. Counting its lines would
        // scan the whole file for a number nobody reads — and the placeholder `null`
        // below never reaches a caller, because a unit in this branch is always dropped
        // by the cap or by the offset counter.
        if (window.window === 0 || window.skip > 0) {
            return matcher.testLines(lines, 1).length > 0
                ? oneUnit({ unit: { path: candidate.display, matchCount: null }, bytes: pathBytes })
                : NO_MATCH;
        }

        const count = matcher.countLines(lines);

        return count === 0
            ? NO_MATCH
            : oneUnit({ unit: { path: candidate.display, matchCount: count }, bytes: pathBytes });
    }

    if (output === 'files') {
        // One index is the whole question. Scanning the rest of the file would spend
        // matching time on information the caller did not ask for.
        return matcher.testLines(lines, 1).length > 0
            ? oneUnit({ unit: { path: candidate.display, matchCount: null }, bytes: pathBytes })
            : NO_MATCH;
    }

    const probe = window.skip + window.window + 1;
    const indices = matcher.testLines(lines, probe);

    // Build one entry from one line index; called only for a unit the caller can reach.
    const build = (index: number): GrepUnit => {
        const snippet = truncateSnippet(lines[index], FILE_GREP_MATCH_TEXT_BYTES);

        const entry: FileGrepLine = {
            path: candidate.display,
            line: index + 1,
            text: snippet.text,
            textTruncated: snippet.textTruncated,
            bytes: snippet.bytes
        };

        let bytes = snippet.bytes;

        // Context is opt-in, so the default entry keeps its exact published shape.
        if (context > 0) {
            let contextTruncated = false;

            // Each neighbour line goes through the SAME snippet cap as the hit itself.
            // `truncateSnippet` returns the original string instance when the line
            // already fits, so an ordinary file pays nothing but the byteLength call.
            const cut = (line: string): string => {
                const neighbour = truncateSnippet(line, FILE_GREP_MATCH_TEXT_BYTES);

                if (neighbour.textTruncated) contextTruncated = true;
                bytes += neighbour.bytes;

                return neighbour.text;
            };

            entry.before = lines.slice(Math.max(0, index - context), index).map(cut);
            entry.after = lines.slice(index + 1, index + 1 + context).map(cut);

            if (contextTruncated) entry.contextTruncated = true;
        }

        return { unit: entry, bytes };
    };

    // Each thunk carries its own line index, so ascending order and the deterministic
    // prefix survive however late a unit is built.
    const units = indices.map((index) => () => build(index));

    // Asking for `probe` and getting `probe` back means the file holds at least one
    // more match than the caller could use: the loop stopped on the limit, not at the
    // end of the array.
    return { units, more: indices.length >= probe };
};

// Build the caller-facing note. Every clause names something the caller can act on, so
// an all-clean search gets no note at all and its absence is information too.
//
// `matchingMs` is the measured regex time (./bounded-regex `elapsed`). It is quoted in
// the search-budget clause because it is the evidence that settles the question the
// previous revision got wrong: 30s of wall clock with 900ms of matching means the TREE
// cost the time, and the caller should narrow `paths`, not rewrite the pattern.
const buildNote = (
    stopReason: FileGrepStopReason,
    examinedFiles: number,
    matchingMs: number,
    searchBudgetMs: number,
    skipped: FileGrepSkipped,
    excluded: FileGrepExcluded
): string | undefined => {
    const parts: string[] = [];

    if (stopReason === 'searchBudget') {
        // "examined", not "scanned": the budget can expire while the search is walking
        // past oversized or unreadable files it never opened, and a count of files
        // MATCHED would then read as "0 files looked at", which is not the truth the
        // caller needs in order to decide how much to narrow.
        parts.push(
            `the search stopped after its ${searchBudgetMs}ms wall-clock budget having examined ${examinedFiles} candidate file(s), of which only ${Math.round(
                matchingMs
            )}ms was regex matching - so the tree, not the pattern, cost the time: narrow "paths" or "patterns" to cover the rest`
        );
    }

    if (skipped.tooLarge > 0) {
        parts.push(`${skipped.tooLarge} file(s) larger than ${MAX_SEARCH_FILE_BYTES} bytes were not searched`);
    }

    if (skipped.binary > 0) parts.push(`${skipped.binary} binary file(s) were not searched`);

    if (skipped.unreadable > 0) {
        parts.push(`${skipped.unreadable} file(s) could not be opened (permission denied, or deleted mid-walk)`);
    }

    if (excluded.unreadableDirectories > 0) {
        parts.push(
            `${excluded.unreadableDirectories} director${excluded.unreadableDirectories === 1 ? 'y' : 'ies'} could not be read, so their contents were never examined`
        );
    }

    if (excluded.ignoreRulesTruncated) {
        parts.push('the .gitignore rule set hit its per-walk cap, so some ignored paths may have been searched');
    }

    if (excluded.ignoredFiles > 0 || excluded.prunedDirectories > 0) {
        parts.push(
            `${excluded.ignoredFiles} file(s) and ${excluded.prunedDirectories} ignored director${
                excluded.prunedDirectories === 1 ? 'y' : 'ies'
            } were excluded by .gitignore rules - name such a directory as a root to search it anyway`
        );
    }

    return parts.length === 0 ? undefined : parts.join('; ');
};

// The two time bounds, injectable. They are parameters rather than reads of the
// constants so BOTH outcomes can be proven in a test without waiting 30 seconds. The
// previous revision could only prove its single budget by mocking `Date.now` to jump
// per read, which pinned the bug (I/O charging a matching budget) instead of catching
// it. Production callers pass nothing and get the published ceilings.
export type FileGrepLimits = {
    matchBudgetMs: number;
    searchBudgetMs: number;
};

export const DEFAULT_GREP_LIMITS: FileGrepLimits = {
    matchBudgetMs: MAX_CONTENT_MATCH_MILLIS,
    searchBudgetMs: MAX_SEARCH_MILLIS
};

// Content search: read each candidate, skip binary/oversized files, and report every
// matching line (or file, or count). Both the unit cap and the aggregate byte budget
// are global across roots and patterns.
export const searchContents = async (
    request: FileGrepRequest,
    set: PatternSet,
    limits: FileGrepLimits = DEFAULT_GREP_LIMITS
): Promise<FileGrepResult> => {
    // Built once per search: compiling the pattern validates it (a SyntaxError is the
    // caller's regex being wrong and propagates so the model sees the parser message),
    // and one vm context plus one measured matching budget cover every file.
    const matcher = createBoundedLineMatcher(request.source, limits.matchBudgetMs, request.flags);

    const stats = createSearchStats();
    const startedAt = nowMs();

    const matches: FileGrepMatch[] = [];
    let bytes = 0;
    let scanned = 0;
    const skipped: FileGrepSkipped = { tooLarge: 0, binary: 0, unreadable: 0 };

    // Paging state. `skipRemaining` is how many units are still being stepped over to
    // reach `offset`; `returned` counts units inside the window.
    let skipRemaining = request.offset;
    let returned = 0;
    // Candidates examined, whether or not they were searchable. It is what lets the first
    // one always be examined before the search budget can fire.
    let iterations = 0;
    // A unit that exists was withheld (proven, never guessed).
    let more = false;
    let budgetStopped = false;
    let searchBudgetHit = false;

    // The candidate stream, with reads overlapped. `mapConcurrent` preserves order, so
    // the unit sequence is exactly the serial one.
    const source = collectCandidates(request.roots, set, { tool: 'grep', stats });
    const reading = mapConcurrent(source, GREP_READ_CONCURRENCY, async (candidate) => ({
        candidate,
        read: await readSearchableFile(candidate.absolute)
    }));

    try {
        for await (const { candidate, read } of reading) {
            // Wall-clock bound on the whole search, checked at the TOP of every iteration
            // — including the iterations that only count a skip. Placed after the skip
            // `continue`s (as it was first), a tree of ten thousand oversized or
            // unreadable files would never reach the check at all: the walk would run to
            // the end of the tree whatever the clock said, which is the same class of bug
            // this revision set out to fix. `iterations > 0` keeps the first candidate
            // always examined, so a search never answers "I stopped before looking at
            // anything".
            if (iterations > 0 && nowMs() - startedAt > limits.searchBudgetMs) {
                searchBudgetHit = true;
                break;
            }

            iterations += 1;

            if (read.status === 'tooLarge') {
                skipped.tooLarge += 1;
                continue;
            }

            if (read.status === 'binary') {
                skipped.binary += 1;
                continue;
            }

            if (read.status === 'unreadable') {
                skipped.unreadable += 1;
                continue;
            }

            scanned += 1;

            let verdict: FileVerdict;

            try {
                verdict = verdictFor(
                    candidate,
                    read.content,
                    request.output,
                    request.context,
                    { skip: skipRemaining, window: Math.max(0, request.limit - returned) },
                    matcher
                );
            } catch (error) {
                // The pattern ran out of MATCHING time. The message from
                // ./bounded-regex is already the right diagnosis; all this adds is the
                // file it happened in, which is the thing a caller then wants to open.
                // Anything else (a realm failure, an out-of-memory) propagates as it
                // is, because reinterpreting an unknown error is how a wrong message
                // gets written.
                if (!isPatternBudgetError(error)) throw error;

                throw new HarnessError(`${(error as Error).message} Stopped while scanning "${candidate.display}" after ${scanned} file(s).`, {
                    cause: error
                });
            }

            for (const makeUnit of verdict.units) {
                // Skipping is a pure counter and the THUNK IS NEVER CALLED: stepping over
                // 50,000 units costs 50,000 decrements, not 50,000 entries.
                if (skipRemaining > 0) {
                    skipRemaining -= 1;
                    continue;
                }

                // The cap is tested BEFORE building: a full window only needs proof that
                // one more unit exists, not another materialized entry.
                if (returned >= request.limit) {
                    more = true;
                    break;
                }

                const { unit, bytes: unitBytes } = makeUnit();

                // The budget has to be tested against the BUILT unit, because only the
                // entry knows its own size. This is the one unit built and then withheld,
                // and it is at most one per call — which is what makes `truncated` a
                // proven fact rather than a guess. An exact fit is NOT truncation.
                if (bytes + unitBytes > FILE_GREP_CONTENT_BUDGET) {
                    more = true;
                    budgetStopped = true;
                    break;
                }

                matches.push(unit);
                bytes += unitBytes;
                returned += 1;
            }

            if (verdict.more) more = true;

            // The window is full AND a further unit is proven: nothing left to learn,
            // so stop walking. This is what keeps a capped search from enumerating the
            // rest of the tree.
            if (more) break;
        }
    } finally {
        // Abandoning the read pipeline must abandon the walk too. `mapConcurrent` does
        // that itself when the loop breaks; this covers the case where the loop body
        // threw (a pattern over budget), where the generator is closed by `return()`
        // rather than by the for-await's implicit call.
        await reading.return(undefined).catch(() => undefined);
    }

    const stopReason: FileGrepStopReason = more
        ? budgetStopped
            ? 'contentBudget'
            : 'resultCap'
        : searchBudgetHit
          ? 'searchBudget'
          : 'complete';

    const excluded: FileGrepExcluded = {
        ignoredFiles: stats.ignoredFiles,
        prunedDirectories: stats.prunedDirectories,
        skippedDirectories: stats.skippedDirectories,
        unreadableDirectories: stats.unreadableDirectories,
        symlinks: stats.symlinks,
        ignoreFilesParsed: stats.ignoreFilesParsed,
        ignoreRulesTruncated: stats.ignoreRulesTruncated
    };

    // `partial` answers a question `truncated` cannot: was the SCOPE covered? A closed
    // window with more results waiting is `truncated`; a scope that was never fully
    // read is `partial`. Both can be true at once, and they mean different things.
    const partial =
        stopReason === 'searchBudget' || excluded.unreadableDirectories > 0 || skipped.unreadable > 0;

    const note = buildNote(stopReason, iterations, matcher.elapsed(), limits.searchBudgetMs, skipped, excluded);

    // KEY ORDER IS NOT COSMETIC. The harness caps a serialized tool result at 64 KiB of
    // text (core/result-budget.ts) and keeps the BEGINNING when it has to cut, and this
    // call's own budget is the same 64 KiB — of match TEXT, not of JSON. A full page of
    // 1 KiB snippets therefore serializes past the wire cap (per-entry `{path, line,
    // ...}` overhead is real), and whatever sits after `matches` would be what gets cut.
    // `matches` goes LAST so an envelope truncation costs the tail of the result list and
    // never the explanation of why the list is short.
    return {
        output: request.output,
        truncated: more,
        offset: request.offset,
        limit: request.limit,
        // Only a window that closed early has a page to resume. A search that ran out
        // of SCOPE cannot promise one: resuming at `offset + returned` might stop
        // before reaching it again, so the note's advice (narrow the roots) is the only
        // advice that is always true.
        nextOffset: more ? request.offset + returned : null,
        bytes,
        contentBudget: FILE_GREP_CONTENT_BUDGET,
        partial,
        stopReason,
        searched: { inScope: stats.candidates, scanned, roots: stats.roots },
        skipped,
        excluded,
        patterns: set.effective,
        ...(note === undefined ? {} : { note }),
        matches
    };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const GREP_METADATA: PresetToolMetadata = {
    name: 'grep',
    description:
        'Search file CONTENTS with a regular expression and return the matching lines. `pattern` (required) is JavaScript regular-expression SOURCE with no delimiters and no inline flags - pass flags in `flags` (flag letters, "i" for case-insensitive), because `(?i)foo` is a JavaScript "Invalid group"; invalid source is an error naming the parser message, never "no matches". `patterns` (default ["**/*"]) filters which files to read - same matcher as glob: *, ?, **, [abc] classes, {a,b} alternatives, a leading ! to exclude, a slashless pattern also matching file names at any depth, and paths matched RELATIVE TO THE ROOT that found them. `paths` (default ["."]) lists roots in order and accepts a FILE to search just that file; overlapping roots are deduplicated by real file identity, so each file is searched once under the first root that reached it. `output` picks the verdict: "content" (default) one entry per matching line, "files" one entry per matching file, "count" the exact number of matching lines per file - the last two answer a survey question in one call. `context` (0-10) adds `before`/`after` neighbour lines so a hit needs no follow-up read. Each hit is { path, line, text, textTruncated, bytes }: `line` is the 1-based line number and `text` is at most a 1024-byte UTF-8 snippet (`textTruncated` says when it was cut). The result is { "matches": [...], "truncated": boolean, "bytes": number, "contentBudget": number } plus output, offset, limit, nextOffset, partial, stopReason, searched, skipped, excluded, patterns, note. `truncated` is true only when a result that exists was withheld by the cap (maxResults, default 100, clamped to 1-1000) or the 64 KiB budget, and `nextOffset` resumes the same deterministic sequence as `offset`; `partial` means the SCOPE was not fully covered; `stopReason` says which bound closed the window ("resultCap", "contentBudget", "searchBudget", "complete"). Nothing is silently dropped: `skipped` counts files not searched (over 1 MiB, binary, unreadable), `excluded` counts what the walk did not yield (ignored files, pruned and unreadable directories, symlinks, .gitignore cap), `searched` reports { inScope, scanned, roots }, and `note` explains what is worth acting on. Time is bounded twice and never confused: 30s of regex execution throws (only a pattern can exhaust it), 30s of wall clock returns a partial result with stopReason "searchBudget" (only a big tree can). Matching is per line - a pattern cannot span lines, so use `context` for neighbours. Skips .git, symlinks, binary files, and files larger than 1 MiB, and skips node_modules unless a root is placed inside it. Reads .gitignore files at or below each root, so an ignored path is never opened - while a root you name explicitly is searched even when an enclosing .gitignore ignores it. Does not list file names (use glob for that).',
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
                    'JavaScript regular-expression source to match inside each file, e.g. "TODO|FIXME". No delimiters and no flags - pass flags with `flags` instead.'
            },
            patterns: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Glob patterns selecting which files to read, OR-ed together and matched against each file path relative to its root, e.g. ["**/*.test.ts"] or ["**/*.{ts,tsx}"]; a leading ! excludes, e.g. ["**/*.ts", "!**/*.test.ts"]. Defaults to ["**/*"].'
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Roots to walk, absolute or relative to the working directory, in the order they are visited. A directory is searched recursively; a FILE is searched on its own. Results are prefixed with the root that found them. A root you name explicitly is searched even when a .gitignore above it ignores that directory. Defaults to ["."].'
            },
            maxResults: {
                type: 'number',
                description:
                    'Maximum result units to return across all roots (matching lines in "content" mode, files in "files"/"count" mode). Defaults to 100 and is clamped to 1-1000.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based index into the result sequence. Defaults to 0; pass nextOffset from the previous page to read the rest of a truncated search.'
            },
            flags: {
                type: 'string',
                description:
                    'JavaScript regular-expression flag letters, e.g. "i" for case-insensitive or "m" for multiline anchors. Defaults to "" (no flags); the source itself must not carry (?i)-style flags.'
            },
            output: {
                type: 'string',
                enum: ['content', 'files', 'count'],
                description:
                    '"content" returns one entry per matching line (default). "files" returns one entry per matching file and stops scanning each file at its first match. "count" returns the exact number of matching lines per file.'
            },
            context: {
                type: 'integer',
                minimum: 0,
                maximum: MAX_GREP_CONTEXT_LINES,
                description:
                    'Lines of context to include before and after each hit (content mode only), so a match can be understood without a follow-up read. 0-10, default 0.'
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
        // Eight properties, so `parameters` is the whole object. `pattern` is required,
        // and the schema enforces that; a direct caller bypasses the schema, so the
        // same rule is checked inside `normalizeGrepRequest`.
        const request = normalizeGrepRequest(parameters);

        const input = normalizeObjectArgument(parameters, ARGUMENT_SHAPE_ERROR);
        const patterns = normalizeStringList('grep', input.patterns, 'patterns', ['**/*']);

        return searchContents(request, compilePatterns(patterns));
    }
});
