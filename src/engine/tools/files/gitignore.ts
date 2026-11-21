// @underload/harness tools/files/gitignore — dependency-free `.gitignore` matching.
//
// WHY THIS EXISTS
// ---------------
// `glob` and `grep` used to walk every directory they could reach, with only the fixed
// name list in ./glob.ts (`SKIPPED_DIRECTORIES`) keeping a tree readable. That made the
// two tools answer questions about generated and scratch trees the enclosing repository
// has already declared irrelevant (`dist/`, `Temp/`, a lockfile directory), and it made
// a capped search return 100 minified bundles instead of the 4 source files the caller
// meant. This module reads the `.gitignore` files a walk actually reaches and applies
// them, so the harness tools answer the same question `git status` would.
//
// SCOPE: THE SEARCH ROOT, NOT THE REPOSITORY ROOT
// -----------------------------------------------
// Rules are collected ONLY from `.gitignore` files at or below the directory being
// walked. No `.gitignore` above the search root is read. That one choice is what makes
// an ignored directory searchable on purpose, exactly like ripgrep/OpenCode:
//
//     paths: ['.']     -> `/Temp/` in the repo .gitignore prunes Temp   (not listed)
//     paths: ['Temp']  -> the enclosing .gitignore is above the root, so Temp IS walked
//
// Nested `.gitignore` files below the root therefore still apply, inside their own
// subtree only (a rule found in `a/.gitignore` can never affect `b/`).
//
// MATCHING RULES (the gitignore(5) subset this package commits to)
// ---------------------------------------------------------------
//   #lead          comment line, skipped; a `\#` escape makes a literal leading '#'
//   blank          skipped
//   !lead          negation: re-includes a path an earlier rule excluded
//   trailing /     the rule matches directories only
//   leading /      anchored to the directory owning the .gitignore
//   inner /        any pattern containing a '/' (other than the trailing one) is anchored
//   no /           matches at any depth, like `*.log` ignoring `a/b/c.log`
//   *              any run of characters inside ONE path segment
//   ?              one character inside one path segment
//   **/            zero or more leading or interior directories
//   /**            everything INSIDE the matched directory (not the directory itself)
//   bare **        any characters, including '/'
//   [abc] / [!abc] character class (an unterminated '[' is a literal, as in ./glob.ts)
//   \x             backslash escapes the next character
//
// Deliberate limits (reported here rather than claimed away):
//   - an ignored DIRECTORY is pruned, so a `.gitignore` inside it is never read and a
//     negation in the root file cannot re-include a file under an excluded directory —
//     the same limitation git itself documents;
//   - `.git/info/exclude` and the global `core.excludesFile` are NOT read: this package
//     does not locate a repository and spawns no `git`;
//   - matching is case-sensitive, like `SKIPPED_DIRECTORIES` and the walker's sort;
//   - at most MAX_GITIGNORE_FILES files are parsed per walk, and each file only up to
//     MAX_GITIGNORE_BYTES (measured in bytes, so a UTF-8 ignore file is cut where the
//     bound says, not where a character count would put it); one line longer than
//     MAX_GITIGNORE_LINE_CHARS is dropped instead of compiled. All three bounds are
//     observable through `stats()` so a caller can tell a full rule set from a capped
//     one instead of guessing.
//
// Cross-references:
//   - ./glob.ts      — the walker that feeds this matcher (load per directory, prune per entry)
//   - ./search.ts    — creates one matcher per search root
//   - ./glob.tool.ts / ./grep.tool.ts — the published descriptions of this behaviour
//   - ../../../../service/src/utility/endpoints.ts — the same idea in the service package,
//     directory-only; not reusable here because it is in another package and takes a
//     fixed pattern list rather than a walk-scoped matcher.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The per-directory file this module reads. `.gitignore` is also a normal search result
// (glob lists it); it is only ever treated as a rule source by the loader below.
export const GITIGNORE_FILE_NAME = '.gitignore';

// One `.gitignore` larger than this is parsed only up to this bound. A real ignore file
// is a few hundred bytes; the bound keeps a pathological file from costing a read.
export const MAX_GITIGNORE_BYTES = 256 * 1024;

// How many `.gitignore` files one walk parses. The cap exists so a generated tree of
// copied packages cannot turn the walk into an unbounded read storm.
//
// It bounds FILES PARSED, not directories visited: the walker already knows from its own
// `readdir` entries whether the file exists, so a directory without one costs no open and
// no budget (./glob.ts). That distinction is why the number could go up. At 512 the cap
// fired on this very repository — a repo-wide walk visits well over 512 directories and
// reported `truncated: true` while parsing only seven real files, which made the honest
// "some rules were dropped" warning into noise. 2048 real parses is still a storm bound
// and is above what any hand-maintained tree reaches.
export const MAX_GITIGNORE_FILES = 2048;

// One ignore line longer than this is not a hand-written pattern — it is a minified
// one-liner, a corrupted file, or a `cat` of some other format. The line is skipped,
// because V8 is happy to CONSTRUCT a RegExp from a 250 KiB literal and then throw
// "Regular expression too large" on the first `test()`. That lazy failure would surface
// inside `isIgnored`, i.e. in the middle of a walk, and would cost the whole search;
// dropping one absurd rule costs nothing.
export const MAX_GITIGNORE_LINE_CHARS = 1024;

// One parsed rule, already compiled. `base` is the posix directory that owns the file,
// relative to the search root ('' means the search root itself).
export type GitignoreRule = {
    base: string;
    // '!' prefix: a match RE-includes the path instead of excluding it.
    negation: boolean;
    // trailing '/': only a directory can match.
    directoryOnly: boolean;
    // the pattern is anchored to `base` (leading '/', or a '/' inside the body).
    anchored: boolean;
    // matcher for the path relative to `base`.
    source: RegExp;
};

// A compiled pattern: the anchored flag is decided while compiling, because anchoring
// depends on whether a '/' appears in the body (the trailing '/' is stripped first).
export type CompiledGitignorePattern = {
    anchored: boolean;
    source: RegExp;
};

// Escape the regex metacharacters that are literal inside a gitignore pattern.
// '*', '?', '[' and '\' are handled by the compiler loop before this is reached.
const escapeRegexLiteral = (character: string): string =>
    /[\\^$.+|{}()\[\]]/.test(character) ? `\\${character}` : character;

// Compile one gitignore pattern body (already stripped of '!', the leading '/', the
// trailing '/', and trailing spaces) into an anchored RegExp plus the anchoring verdict.
//
// The result is matched against a posix path relative to the rule's own directory, so
// `base` is not part of the regex — it is checked separately by the matcher, which is how
// one rule set can be reused for every descendant path.
export const compileGitignorePattern = (pattern: string): CompiledGitignorePattern => {
    let source = '';
    let anchored = false;

    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];

        // A backslash escapes the next character, so `\#`, `\!` and `\*` stay literal.
        // A dangling backslash is the literal itself rather than a throw.
        if (character === '\\') {
            const next = pattern[index + 1];

            if (next === undefined) {
                source += '\\\\';
                continue;
            }

            source += escapeRegexLiteral(next);
            index++;
            continue;
        }

        // Any '/' inside the body anchors the rule to the directory that owns the
        // .gitignore (the trailing '/' was removed by the caller, so it does not count).
        if (character === '/') {
            anchored = true;
            source += '/';
            continue;
        }

        if (character === '*') {
            // Collapse a run of stars so "***" behaves like "**" instead of throwing.
            let end = index + 1;
            while (pattern[end] === '*') end++;

            // Only TWO OR MORE stars are the cross-directory operator. A single '*' is
            // one path segment, exactly like ./glob.ts compiles it: 'src/*.ts' must not
            // reach 'src/nested/a.ts', and git documents the same difference.
            if (end - index < 2) {
                source += '[^/]*';
                continue;
            }

            if (pattern[end] === '/') {
                // "**/" is zero or more directories: "**/tmp/x" matches "tmp/x" itself,
                // and "a/**/b" matches "a/b". The '/' is consumed here so it does not
                // flip `anchored` for a leading "**/".
                source += '(?:[^/]*/)*';
                index = end;
                continue;
            }

            // Trailing "**" ("dist/**") or a bare "**": any characters, including '/'.
            source += '.*';
            index = end - 1;
            continue;
        }

        if (character === '?') {
            source += '[^/]';
            continue;
        }

        if (character === '[') {
            const end = pattern.indexOf(']', index + 1);

            // Unterminated class: literal '[', matching ./glob.ts so both matchers treat
            // a typo the same way (a search with fewer matches, never an exception).
            if (end === -1) {
                source += '\\[';
                continue;
            }

            const body = pattern.slice(index + 1, end);
            const negated = body.startsWith('!') ? `^${body.slice(1)}` : body;

            source += `[${negated.split('\\').join('\\\\')}]`;
            index = end;
            continue;
        }

        source += escapeRegexLiteral(character);
    }

    // An unanchored pattern matches at any depth, which is exactly a leading
    // "zero or more directories" group.
    const prefix = anchored ? '' : '(?:[^/]*/)*';

    return { anchored, source: new RegExp(`^${prefix}${source}$`) };
};

// Parse one `.gitignore` document into compiled rules scoped to `base`.
//
// `base` is the posix directory owning the file, relative to the search root ('' for the
// root itself). Never throws: an unreadable or malformed file costs rules, not the walk.
export const parseGitignore = (content: string, base = ''): GitignoreRule[] => {
    const rules: GitignoreRule[] = [];

    for (const rawLine of content.split(/\r?\n/)) {
        let line = rawLine;

        // Trailing spaces are insignificant unless escaped ("trailing\ "). Walking the
        // line backwards keeps an escaped space in place.
        while (line.endsWith(' ') && !line.endsWith('\\ ')) line = line.slice(0, -1);

        // Blank lines and comments carry no rule.
        if (line.length === 0 || line.startsWith('#')) continue;

        let negation = false;

        if (line.startsWith('!')) {
            negation = true;
            line = line.slice(1);
        }

        let directoryOnly = false;

        // A trailing '/' restricts the rule to directories. Stripping it BEFORE compiling
        // matters: git does not treat the trailing slash as an anchoring '/'.
        if (line.endsWith('/') && !line.endsWith('\\/')) {
            directoryOnly = true;
            line = line.slice(0, -1);
        }

        // A leading '/' anchors the rule to the owning directory and is NOT part of the
        // path, so it is removed here; leaving it in would compile to `^/Temp$` and never
        // match the root-relative path 'Temp'.
        let explicitlyAnchored = false;

        if (line.startsWith('/')) {
            explicitlyAnchored = true;
            line = line.slice(1);
        }

        // "!" or "/" on their own are not patterns.
        if (line.length === 0) continue;

        // A monster line is dropped rather than compiled (see MAX_GITIGNORE_LINE_CHARS).
        if (line.length > MAX_GITIGNORE_LINE_CHARS) continue;

        let compiled: CompiledGitignorePattern;

        try {
            compiled = compileGitignorePattern(line);

            // The warm-up `test` exists because V8 reports an oversized pattern lazily,
            // on first use rather than at construction. Failing HERE drops one rule;
            // failing later would throw from inside `isIgnored`, mid-walk, and lose the
            // whole `glob`/`grep` result.
            compiled.source.test('');
        } catch {
            continue;
        }

        rules.push({
            base,
            negation,
            directoryOnly,
            anchored: explicitlyAnchored || compiled.anchored,
            source: compiled.source
        });
    }

    return rules;
};

// The path `relativePath` has when written relative to `base`, or undefined when it is
// outside that subtree. '' is the search root, so it scopes every path under it.
const scopeRelativePath = (base: string, relativePath: string): string[] | undefined => {
    const segments = relativePath.split('/');

    if (base.length === 0) return segments;

    const baseSegments = base.split('/');

    if (segments.length <= baseSegments.length) return undefined;

    for (let index = 0; index < baseSegments.length; index++) {
        if (segments[index] !== baseSegments[index]) return undefined;
    }

    return segments.slice(baseSegments.length);
};

// The walk-scoped view of every rule set loaded so far.
export type GitignoreMatcher = {
    // Read `<absoluteDirectory>/.gitignore` if it exists and register its rules under
    // `relativeDirectory` (posix, relative to the search root; '' for the root itself).
    // Called once per directory the walker actually lists, so an ignored directory's
    // own .gitignore is never read — the same consequence git's pruning has.
    //
    // `options.present` is the walker's answer to "does this directory contain the
    // file?", taken from the `readdir` entries it already has. Passing `false` skips the
    // open entirely — a repo-wide walk used to pay one failed `open` per directory, which
    // is hundreds of syscalls for information the walk had already paid for — and the
    // directory is then counted as CHECKED without consuming the MAX_GITIGNORE_FILES
    // budget, which bounds FILES PARSED, not directories visited. Omitting the option
    // keeps the original behaviour (attempt the read, register the base) for callers that
    // have no entry list.
    load: (
        absoluteDirectory: string,
        relativeDirectory: string,
        options?: { present?: boolean }
    ) => Promise<void>;
    // Whether `relativePath` (posix, relative to the search root) is excluded.
    // `isDirectory` decides whether a "directory only" rule may match it.
    isIgnored: (relativePath: string, isDirectory: boolean) => boolean;
    // `files` is how many `.gitignore` files were registered (capped by
    // MAX_GITIGNORE_FILES); `directories` is how many were checked, including the ones
    // with no file at all. `truncated` says whether either cap cut the rule set. Exposed
    // so a test — and a future diagnostic — can tell a complete rule set from a truncated
    // one instead of guessing.
    stats: () => { files: number; directories: number; truncated: boolean };
};

// Create one matcher for one search root. Fresh per root on purpose: rules from one root
// must not leak into another root's walk (./search.ts walks several roots per call).
export const createGitignoreMatcher = (): GitignoreMatcher => {
    // Flat, in LOAD order. For any walked path the loader has visited its ancestors
    // first (depth-first walk), so "later entry wins" is the same statement as git's
    // "the innermost .gitignore has the final say".
    const rules: GitignoreRule[] = [];
    const loadedBases = new Set<string>();
    let checkedDirectories = 0;
    let truncated = false;

    const load = async (
        absoluteDirectory: string,
        relativeDirectory: string,
        options?: { present?: boolean }
    ): Promise<void> => {
        // The walker knows from its own `readdir` entries whether the file is there. When
        // it says no, there is nothing to read and nothing to register — and the cap must
        // not be charged, because it bounds parsed files, not visited directories.
        if (options?.present === false) {
            checkedDirectories += 1;
            return;
        }

        // The same directory loaded twice (a caller that re-walks a base) already
        // counted its check; counting again would make the number describe the calls
        // rather than the tree.
        if (loadedBases.has(relativeDirectory)) return;

        if (loadedBases.size >= MAX_GITIGNORE_FILES) {
            truncated = true;
            return;
        }

        loadedBases.add(relativeDirectory);
        checkedDirectories += 1;

        // Read as a Buffer so the bound is measured in BYTES: a UTF-16 `string.slice`
        // would cut a different (larger) amount of file whenever the ignore text carries
        // non-ASCII characters. A partial multi-byte sequence at the cut decodes to U+FFFD
        // on the last line, which can only ever cost that one rule.
        let bytes: Buffer;

        try {
            bytes = await readFile(join(absoluteDirectory, GITIGNORE_FILE_NAME));
        } catch {
            // Missing (the common case), unreadable, or a directory named .gitignore:
            // a walk with fewer rules beats a search that fails.
            return;
        }

        // A bound, not a rejection: past it the file is parsed as far as the bound, so
        // the rules that matter (they come first in practice) still apply.
        if (bytes.byteLength > MAX_GITIGNORE_BYTES) {
            truncated = true;
            bytes = bytes.subarray(0, MAX_GITIGNORE_BYTES);
        }

        for (const rule of parseGitignore(bytes.toString('utf8'), relativeDirectory)) {
            rules.push(rule);
        }
    };

    const isIgnored = (relativePath: string, isDirectory: boolean): boolean => {
        if (rules.length === 0) return false;

        // The number of path segments decides how deep a rule can reach; a rule is
        // allowed to match the path itself or any of its ancestors, because a file under
        // an excluded directory is excluded with it (`dist/` covers `dist/app.js`, and
        // `dist/**` covers it without the ancestor step).
        const depth = relativePath.split('/').length;
        let ignored = false;

        for (const rule of rules) {
            const scoped = scopeRelativePath(rule.base, relativePath);
            if (scoped === undefined) continue;

            for (let level = 1; level <= depth; level++) {
                const candidate = scoped.slice(0, level).join('/');

                // Everything above the final segment is a directory whatever we were
                // asked about; the final segment is a directory only when the caller
                // said so. A "directory only" rule can therefore match an ancestor of a
                // file ("dist/" excludes dist/app.js through the 'dist' level).
                const candidateIsDirectory = isDirectory || level < depth;

                if (rule.directoryOnly && !candidateIsDirectory) continue;

                if (!rule.source.test(candidate)) continue;

                // Last match wins, in load order (outer .gitignore first, inner last).
                ignored = !rule.negation;
            }
        }

        return ignored;
    };

    return {
        load,
        isIgnored,
        stats: () => ({ files: loadedBases.size, directories: checkedDirectories, truncated })
    };
};
