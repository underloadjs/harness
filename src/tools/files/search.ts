// @underload/harness tools/files/search — the plumbing shared by the two search presets.
//
// WHY THIS EXISTS
// ---------------
// `fileGlob` used to be ONE tool with TWO modes, discriminated by whether the caller
// sent `content` (see the history in ../README). A caller then had to inspect the
// request (or the result shape) to know which contract it was answering, and the
// model could not ask for "just file names" and "just matching lines" with different
// names. The rename splits those responsibilities:
//
//     glob  ({ patterns?, paths?, maxResults?, offset? }) -> { files, truncated, offset, limit, nextOffset, bytes, contentBudget, excluded }
//     grep  ({ pattern, patterns?, paths?, maxResults?, offset?, flags?, output?, context? })
//                                                        -> { matches, truncated, offset, limit, nextOffset, bytes, contentBudget, searched, skipped, excluded }
//
// Both walk the SAME tree with the SAME rules, and that shared half lives here so the
// two entries cannot drift: pattern compilation (brace expansion and `!` negation), the
// "no slash also matches the file name" rule, root identity + file identity dedupe, the
// per-root coverage counters, the root error boundary, and the argument-validation
// wording are defined once. Each `*.tool.ts` entry keeps only its own verdict step
// (list the path, or read the file and match its lines).
//
// WALKER RULES (owned by ./glob.ts and ./gitignore.ts, documented there)
// ----------------------------------------------------------------
//   - patterns are matched against each file's path RELATIVE TO THE ROOT that found
//     it, never against an absolute path, and every result is prefixed with that root;
//   - a pattern with no "/" additionally matches the bare file name at any depth;
//   - `{a,b}` is expanded into one pattern per alternative, and a leading `!` excludes
//     (see `compilePatterns` below — both used to be silent wrong answers);
//   - .git and symlinks are never entered; node_modules is skipped unless the caller
//     roots the search inside it;
//   - `.gitignore` files AT OR BELOW each root are honored (./gitignore.ts): an ignored
//     path is neither listed nor read, while a root named explicitly is still walked even
//     when a .gitignore above it ignores it. No rule from above a root reaches into it,
//     which is what makes `paths: ['Temp']` answer for a directory the repo ignores;
//   - the walk is depth-first over name-sorted entries, so a capped result is a
//     deterministic prefix of the tree — which is exactly the precondition for paging.
//
// DEDUPE (why two levels, and why `resolve()` alone is not enough)
// ---------------------------------------------------------------
//   - ROOT identity (`./identity.ts` realpath, case-folded on win32): `src` and `SRC`,
//     or a symlinked alias of a root, would otherwise walk one tree twice and list
//     every file under two prefixes;
//   - FILE identity: overlapping roots and overlapping patterns still reach one file
//     more than once, and the FIRST root wins the presentation. The walker never
//     enters a symlink, so once the root is resolved a resolved path is a sufficient
//     per-file key and costs no extra stat.
//
// THE ROOT ERROR BOUNDARY (this revision)
// ---------------------------------------
// A root that cannot be opened used to surface the raw OS string: `ENOTDIR: not a
// directory, scandir '…/glob.ts'` for the single most natural mistake in a search tool
// (naming a FILE as a root), and `ENOENT … scandir` for a typo. Both are things a model
// does by accident, both are inside a tool family where read/edit accept files, and
// neither string says what to type instead. `collectCandidates` therefore stats each root
// once: a FILE root becomes one candidate (search just that file), and anything the stat
// cannot open becomes a HarnessError from `rootErrorMessage` naming the path and the fix.
// A root whose own `readdir` still fails — the case a stat can miss, e.g. a path that is
// a file for `stat` but not for `readdir` on this platform — is caught by the same
// function around the walk, so there is one error surface for roots, not two.
//
// COVERAGE COUNTERS (why "no matches" is now explainable)
// ------------------------------------------------------
// `SearchStats` is the answer to the question an empty result cannot ask on its own:
// "was there nothing, or did the policy hide something?" Files an ignore rule excluded,
// directories pruned by rule or by name, directories that could not be read, symlinks
// skipped, and the number of files actually examined are all counted per walk and
// published by both presets. They are counts, not paths, so they cost integer increments
// and no memory, and they stay meaningful when the caller stops the generator early.
//
// Cross-references:
//   - ./glob.tool.ts    — filename search (this module's only list-paths caller)
//   - ./grep.tool.ts    — content search (this module's only read-lines caller)
//   - ./glob.ts         — the walker, the matcher and the size/binary helpers
//   - ./gitignore.ts    — the per-root .gitignore matcher this module creates per root
//   - ./identity.ts     — the canonical per-root / per-file comparison keys
//   - ./bounded-regex.ts— the time-bounded regex grep runs inside `node:vm`

import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HarnessError } from '../../util';
import { canonicalPathKey, fileIdentity } from './identity';
import {
    ALWAYS_SKIPPED_DIRECTORIES,
    SKIPPED_DIRECTORIES,
    createWalkStats,
    errorCode,
    expandBraces,
    globToRegExp,
    rootTargetsSkippedDirectory,
    toPosixPath,
    walkFiles
} from './glob';
import type { WalkStats } from './glob';
import { createGitignoreMatcher } from './gitignore';

// One compiled pattern plus the "slashless patterns also match the name" flag. This
// is also where that rule is decided, so both search tools apply it identically.
export type CompiledPattern = {
    matcher: RegExp;
    // True when the pattern contains no "/", so it may also be tested against the
    // bare file name (the ripgrep `-g '*.ts'` behaviour).
    namesOnly: boolean;
};

// A whole pattern list, split into what includes and what excludes.
export type PatternSet = {
    // Patterns a path must match. EMPTY means "everything" (the caller only sent
    // exclusions, which is how .gitignore semantics work).
    include: CompiledPattern[];
    // Patterns that veto a path. Checked FIRST, so an exclusion always wins over an
    // inclusion — the documented rule, and the one a caller assumes.
    exclude: CompiledPattern[];
    // The patterns actually compiled, after brace expansion, in caller order.
    // Echoed in the result: `{a,b}` becomes two entries here, so a caller can see the
    // request it made was understood rather than matched literally.
    effective: string[];
    // True when the caller sent at least one `!` pattern.
    negated: boolean;
};

// Compile every pattern ONCE per call, expanding braces and splitting off negations.
//
// Compiling per file would be correct but wasteful, and the caps in ./glob.ts make one
// compile pass per call the honest shape. Two behaviours were missing and both produced
// a WRONG answer that looked like a complete one:
//
//   - `**/*.{ts,tsx}` matched nothing, because `{` and `}` are literal characters in
//     this matcher. It is now expanded into two patterns (./glob.ts `expandBraces`).
//   - `['**/*', '!**/*.test.ts']` returned the test files, because there was no way to
//     exclude. A leading `!` now vetoes, and a list of ONLY negations means "everything
//     except" rather than "nothing" — `['!**/*.ts']` used to answer `[]`.
//
// An invalid glob never throws here: ./glob.ts treats an unterminated character class
// as a literal, so a typo yields a search with no matches.
export const compilePatterns = (patterns: readonly string[]): PatternSet => {
    const include: CompiledPattern[] = [];
    const exclude: CompiledPattern[] = [];
    const effective: string[] = [];

    for (const pattern of patterns) {
        const negated = pattern.startsWith('!');
        const body = negated ? pattern.slice(1) : pattern;

        // A lone "!" is not a pattern. Treat it as the literal name, the way git does
        // with a lone "!" in an ignore file, rather than meaning "exclude everything".
        if (body.length === 0) {
            include.push({ matcher: globToRegExp('!'), namesOnly: true });
            effective.push('!');
            continue;
        }

        for (const expanded of expandBraces(body)) {
            const compiled = { matcher: globToRegExp(expanded), namesOnly: !expanded.includes('/') };

            if (negated) exclude.push(compiled);
            else include.push(compiled);

            effective.push(negated ? `!${expanded}` : expanded);
        }
    }

    return { include, exclude, effective, negated: exclude.length > 0 };
};

// Does one root-relative path survive the pattern set?
//
// Exclusions are tested before inclusions, so `['**/*.ts', '!**/*.test.ts']` is
// unambiguous no matter what order the caller wrote them in.
export const matchesPatterns = (set: PatternSet, relativePath: string): boolean => {
    const name = relativePath.slice(relativePath.lastIndexOf('/') + 1);

    for (const { matcher, namesOnly } of set.exclude) {
        if (matcher.test(relativePath)) return false;
        if (namesOnly && matcher.test(name)) return false;
    }

    // Only exclusions: everything else is included.
    if (set.include.length === 0) return true;

    for (const { matcher, namesOnly } of set.include) {
        if (matcher.test(relativePath)) return true;
        if (namesOnly && matcher.test(name)) return true;
    }

    return false;
};

// `matchesAnyPattern` is gone: with exclusions in the picture, "matches ANY pattern"
// is no longer the question the tools ask, and keeping the older name beside the newer
// one invites a caller to use the version that ignores `!`.

// A candidate file: its dedupe identity, the path shown to the caller, and the
// absolute path used to read it.
export type SearchCandidate = {
    // Canonical file key; the dedupe key (one file, one entry). See ./identity.
    identity: string;
    // Root-prefixed posix path, exactly the presentation fileList uses.
    display: string;
    // Absolute path for a content read.
    absolute: string;
};

// Everything one walk (across all its roots) dropped, and why.
export type SearchStats = {
    // Files the walk yielded, i.e. files that survived the ignore rules and the skip
    // list and were therefore candidates for the caller's patterns. This is the number
    // a content search charges its reads against, and the number that turns an empty
    // result into "looked at N files, none matched".
    candidates: number;
    // Files an ignore rule excluded.
    ignoredFiles: number;
    // DIRECTORIES an ignore rule pruned (counted once each, not per file inside).
    prunedDirectories: number;
    // DIRECTORIES dropped by the name skip list (`.git`, `node_modules`).
    skippedDirectories: number;
    // DIRECTORIES `readdir` could not open. These are the only entries that make a
    // result incomplete for a reason that is not policy.
    unreadableDirectories: number;
    // Symlinked entries never followed.
    symlinks: number;
    // `.gitignore` files actually parsed across all roots. This is the number the
    // MAX_GITIGNORE_FILES cap bounds, so it is the one that explains a verdict: "the
    // rules came from these many files", not "these many directories were looked at".
    // Counted by the WALKER (which knows whether the file exists) rather than by the
    // loader's dedupe set, so a directory whose file was already loaded still counts once
    // and a directory with no file never counts.
    ignoreFilesParsed: number;
    // True when a per-walk gitignore cap (MAX_GITIGNORE_FILES or MAX_GITIGNORE_BYTES)
    // dropped rules, so the ignore verdicts below are a subset of the repository's.
    ignoreRulesTruncated: boolean;
    // Roots actually walked. A duplicate/alias root is skipped, and a root that is a
    // FILE contributes one candidate, so this is not `paths.length`.
    roots: number;
};

// A zeroed counter set.
export const createSearchStats = (): SearchStats => ({
    candidates: 0,
    ignoredFiles: 0,
    prunedDirectories: 0,
    skippedDirectories: 0,
    unreadableDirectories: 0,
    symlinks: 0,
    ignoreFilesParsed: 0,
    ignoreRulesTruncated: false,
    roots: 0
});

// The message for a root that is not a directory. The shapes differ by cause, because the
// causes have different fixes and one shared string would send the caller the wrong way:
// "does not exist" for a typo, "is not a directory" for a file passed where a directory
// was meant, "permission denied" for a root the process cannot open.
const rootErrorMessage = (tool: string, root: string, code: string, cwd: string): string => {
    if (code === 'ENOENT') {
        return (
            `${tool} path "${root}" does not exist. Roots are resolved against the working directory (${toPosixPath(
                cwd
            )}); check the spelling, or list the parent with fileList to see what is there.`
        );
    }

    if (code === 'ENOTDIR') {
        return (
            `${tool} path "${root}" is not a directory: a component of it is a file. Pass the file itself as the root to search just that file, or the directory that contains it.`
        );
    }

    if (code === 'EPERM' || code === 'EACCES') {
        return `${tool} path "${root}" could not be read (${code}: permission denied). Narrow the search to a directory this process can open.`;
    }

    return `${tool} path "${root}" could not be walked (${code}).`;
};

// Walk every root in caller order and yield the files matching any pattern.
//
// Deduplication happens here rather than per root, because overlapping roots are the
// reason it is needed at all: the first root that reaches a file wins, which is what
// makes the caller's root order meaningful. A root that resolves to a directory
// already walked (a symlink alias, or 'src' and 'SRC' on Windows) is skipped
// entirely. Both tools stream this generator, so a capped search stops walking
// instead of materializing the whole tree.
//
// Each root gets its OWN gitignore matcher (./gitignore.ts): rules learned under 'src'
// must not decide what is visible under 'packages/other', and a matcher is the only
// place that knows which directory a rule was read from. The skip list is chosen per root
// as well, so a caller that names an otherwise-skipped directory ('node_modules', or a
// path under it) still gets it walked — the same "explicit path wins" rule gitignore
// scoping already gives an ignored directory.
//
// `stats` is optional and caller-owned: a walk that is abandoned part-way (the caller
// hit its cap) has already incremented everything it saw, which is what makes the
// counters describe the SEARCH rather than the RESULT.
export async function* collectCandidates(
    roots: readonly string[],
    patterns: PatternSet | readonly CompiledPattern[],
    options: { tool?: string; stats?: SearchStats } = {}
): AsyncGenerator<SearchCandidate> {
    const tool = options.tool ?? 'search';

    // Discriminated on a property rather than on `Array.isArray`: the guard does not
    // narrow a `readonly T[]` member of a union (a readonly array is not assignable to
    // `any[]`), which would leave the union in scope and force a cast.
    const set: PatternSet = 'include' in patterns
        ? patterns
        : { include: [...patterns], exclude: [], effective: [], negated: false };

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
        const rootKey = await fileIdentity(absoluteRoot);
        if (seenRoots.has(rootKey)) continue;
        seenRoots.add(rootKey);

        // THE ROOT ERROR BOUNDARY. One stat per root, and it decides the three cases
        // the raw OS strings used to blur together: a file (search it), a missing path
        // (say so), and a path whose parent is a file (say which part is wrong).
        let rootIsFile = false;

        try {
            const info = await stat(absoluteRoot);
            rootIsFile = info.isFile();
        } catch (error) {
            throw new HarnessError(
                rootErrorMessage(tool, root, errorCode(error), process.cwd()),
                { cause: error }
            );
        }

        if (options.stats) options.stats.roots += 1;

        if (rootIsFile) {
            // "Search this file" is a legitimate request, and read/edit accept a file
            // everywhere else in this family. One candidate, presented exactly as the
            // caller named it, so `paths: ['src/a.ts']` answers about `src/a.ts`.
            //
            // The pattern filter still applies, tested against BOTH the bare name and
            // the caller's own spelling: a file root has no root-relative path, and
            // either reading is one the caller could reasonably have meant. Counting the
            // candidate before the filter is what lets a result say "1 file was in
            // scope, the pattern excluded it" instead of "0 files".
            const fileKey = canonicalPathKey(absoluteRoot);
            const display = toPosixPath(root);
            const name = display.slice(display.lastIndexOf('/') + 1);

            if (options.stats) options.stats.candidates += 1;

            if (seenFiles.has(fileKey)) continue;
            if (!matchesPatterns(set, name) && !matchesPatterns(set, display)) continue;

            seenFiles.add(fileKey);

            yield { identity: fileKey, display, absolute: absoluteRoot };
            continue;
        }

        const ignores = createGitignoreMatcher();
        const skipDirectories = rootTargetsSkippedDirectory(absoluteRoot)
            ? ALWAYS_SKIPPED_DIRECTORIES
            : SKIPPED_DIRECTORIES;

        const walkStats: WalkStats | undefined = options.stats ? createWalkStats() : undefined;

        try {
            for await (const relativePath of walkFiles(absoluteRoot, {
                ignores,
                skipDirectories,
                stats: walkStats
            })) {
                if (options.stats) options.stats.candidates += 1;

                if (!matchesPatterns(set, relativePath)) continue;

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
        } catch (error) {
            // Only the root's own `readdir` throws (the walker swallows everything
            // deeper), and the OS string for it names `scandir`, not the path the
            // caller typed.
            const code = errorCode(error);

            throw new HarnessError(
                code === 'ENOTDIR'
                    ? `${tool} path "${root}" is not a directory. Pass the file itself as the root to search just that file, or the directory that contains it.`
                    : rootErrorMessage(tool, root, code, process.cwd()),
                { cause: error }
            );
        } finally {
            // The counters and the gitignore accounting are read whether the walk
            // finished, stopped early, or threw — a partial walk still has to report
            // what it covered.
            if (options.stats && walkStats) {
                options.stats.ignoredFiles += walkStats.ignoredFiles;
                options.stats.prunedDirectories += walkStats.ignoredDirectories;
                options.stats.skippedDirectories += walkStats.skippedDirectories;
                options.stats.unreadableDirectories += walkStats.unreadableDirectories;
                options.stats.symlinks += walkStats.symlinks;
                options.stats.ignoreFilesParsed += walkStats.ignoreFilesParsed;
            }

            if (options.stats) {
                // Only the truncation verdict comes from the matcher: `files` there counts
                // registered BASES, which is the cap's own bookkeeping, not the number of
                // files this walk read.
                options.stats.ignoreRulesTruncated =
                    options.stats.ignoreRulesTruncated || ignores.stats().truncated;
            }
        }
    }
}

// Run `mapper` over an async source with at most `concurrency` in flight, preserving
// ORDER in what it yields.
//
// Why this exists: a content search is I/O-bound, and the previous shape was strictly
// serial — walk one file, stat it, open it, read it, match it, repeat. On a tree of
// 16k searchable files that is one syscall round trip at a time, which is most of the
// 15-30s a repo-wide grep used to cost. Reads overlap (they are the part of the loop
// that waits on the OS), while the walk and the matching stay in order, so the result
// sequence is IDENTICAL to the serial one and only the wall clock changes.
//
// Two properties the caller depends on:
//   - ORDER: a page of results is still the deterministic prefix of the walk, so
//     `offset`/`nextOffset` arithmetic stays correct;
//   - CANCELLATION: when the consumer stops early it calls `source.return()`, which
//     stops the walk and lets the in-flight reads finish into nothing. A search that
//     found its last match does not keep walking the tree.
export async function* mapConcurrent<T, R>(
    source: AsyncGenerator<T>,
    concurrency: number,
    mapper: (value: T) => Promise<R>
): AsyncGenerator<R> {
    const limit = Math.max(1, Math.floor(concurrency));

    // Every slot carries its verdict, so a mapper that legitimately resolves to
    // `undefined` is still yielded, and a rejection is re-thrown at its own position
    // instead of becoming an unhandled rejection while a sibling is awaited.
    type Settled = { ok: true; value: R } | { ok: false; error: unknown };

    const inFlight: Promise<Settled>[] = [];
    let exhausted = false;

    // Pull the source forward, keeping at most `limit` mapper promises queued.
    const fill = async (): Promise<void> => {
        while (!exhausted && inFlight.length < limit) {
            const next = await source.next();

            if (next.done) {
                exhausted = true;
                return;
            }

            inFlight.push(
                Promise.resolve().then(() => mapper(next.value)).then(
                    (value) => ({ ok: true, value }) as Settled,
                    (error: unknown) => ({ ok: false, error }) as Settled
                )
            );
        }
    };

    try {
        await fill();

        while (inFlight.length > 0) {
            const settled = await (inFlight.shift() as Promise<Settled>);

            if (!settled.ok) throw settled.error;

            yield settled.value;

            await fill();
        }
    } finally {
        // Whatever is still queued was abandoned by the consumer, so its verdict is never
        // read. Detaching the rejections keeps an abandoned read from becoming an
        // unhandledRejection (which Node treats as a fatal error by default) after the
        // search already finished.
        for (const pending of inFlight) pending.catch(() => undefined);
        inFlight.length = 0;

        // Abandoning the generator must abandon the walk too, or a capped search still
        // enumerates every directory it could reach.
        await source.return(undefined).catch(() => undefined);
    }
}

// Validate the whole argument object of a multi-property search tool.
//
// `value` may be absent (a direct `glob()` call, the documented "every file under
// '.'" request) or a plain object. Anything else — a string, an array, a number —
// used to slip through the property reads and silently mean "use every default",
// i.e. list every file in the tree. That is a wrong answer, not a convenience, so
// it is rejected. `message` is supplied by the calling tool because the wording
// names that tool's own properties, and the exact text is a published contract.
export const normalizeObjectArgument = (value: unknown, message: string): Record<string, unknown> => {
    if (value === undefined || value === null) return {};

    if (typeof value !== 'object' || Array.isArray(value)) throw new HarnessError(message);

    return value as Record<string, unknown>;
};

// Validate one string-array argument (patterns or paths).
//
// `name` is the property, `tool` names the preset in the message (a model that
// mistypes `grep`'s arguments must not be told about `glob`), and `fallback` is the
// documented default the caller should have omitted the property for.
//
// An explicitly empty array is rejected instead of defaulted: `{"patterns": []}`
// reads as "match nothing", which would make a model conclude a file does not
// exist. Omitting the property is how a caller asks for the documented default.
export const normalizeStringList = (
    tool: string,
    value: unknown,
    name: 'patterns' | 'paths',
    fallback: readonly string[]
): string[] => {
    if (value === undefined) return [...fallback];

    if (!Array.isArray(value)) {
        throw new HarnessError(`${tool} ${name} must be an array of strings.`);
    }

    if (value.length === 0) {
        throw new HarnessError(
            `${tool} received an empty ${name} array. Omit ${name} to use the default (${fallback
                .map((entry) => `"${entry}"`)
                .join(', ')}).`
        );
    }

    for (const entry of value) {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new HarnessError(`${tool} ${name} must be non-empty strings.`);
        }

        // NUL cannot exist in a real path or pattern and would only confuse the
        // filesystem or the matcher.
        if (entry.includes('\u0000')) {
            throw new HarnessError(`${tool} ${name} must not contain NUL characters.`);
        }
    }

    return [...value];
};

// Cut one matching line down to a snippet cap WITHOUT splitting a code point.
//
// `for...of` over a string iterates code points, so a surrogate pair (an emoji, an
// astral character) contributes its whole 4-byte sequence or nothing. Measuring in
// UTF-8 bytes rather than UTF-16 units is what makes the cap match what the caller
// actually receives on the wire. A line that already fits is returned untouched
// (same string instance), so the common case allocates nothing.
export const truncateSnippet = (
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
