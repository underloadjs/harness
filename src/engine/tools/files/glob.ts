// @underload/harness tools/files/glob — dependency-free glob matching and walking.
//
// Shared by glob (file names) and grep (file contents), and it is the reason both
// presets answer the same question about the same tree. Kept in one file so the
// matcher, the skip list, and the caps have exactly one definition.
//
// Matching rules (documented in the tool descriptions so the model and a caller
// see the same contract):
//   *       any run of characters inside one path segment
//   ?       one character inside one path segment
//   **      any run of characters including "/"
//   **/     zero or more leading directories (so "**/*.ts" also matches "a.ts")
//   [abc]   one character from the set; [!abc] excludes the set
//   {a,b}   either alternative (expanded to one pattern per alternative; `\{` is a
//           literal brace, and a group with no comma stays literal too)
//   !lead   on a PATTERN list (not here, see ./search.ts): excludes what it matches
//   A pattern with no "/" additionally matches against the file name alone, so
//   "*.ts" behaves like ripgrep's -g '*.ts' rather than requiring "**/*.ts".
//
// MATCHING IS CASE-SENSITIVE, on every platform. That is deliberate and it is the
// one asymmetry a caller has to know: ./identity.ts folds case when comparing paths
// for DEDUPE because NTFS is case-insensitive, while the MATCHER keeps case because
// `*.TS` naming a `foo.ts` file is a typo the caller should see, not a silent hit.
// Use `flags: "i"` on grep for case-insensitive CONTENT search.
//
// Deliberate limits (reported, not claimed away):
//   - no extglob (`@(a|b)`) and no character-class ranges beyond `[a-z]`;
//   - the walker itself does not read `.gitignore`: the caller passes a matcher built by
//     ./gitignore.ts, which is what lets `glob`/`grep` honor the repository's ignore
//     rules while a bare `walkFiles(root)` keeps its original "everything reachable"
//     meaning;
//   - symlinks are skipped while walking, so traversal cannot loop or escape the
//     root through a link;
//   - paths are posix-style ("a/b.ts") on every platform, because the model should
//     not have to care which OS the harness runs on.
//
// WHY THE WALKER REPORTS WHAT IT DROPPED (this revision)
// ------------------------------------------------------
// A walk used to be silent about everything it did not yield: an ignored subtree, a
// directory pruned by name, a directory it could not read. `matches: []` and
// "the tree is unreadable in places" were therefore the same answer. `walkFiles` now
// accumulates counters into a caller-owned `WalkStats` object, which both presets
// publish. The counters are deliberately coarse (counts, not paths) so they cost a
// few integer increments and no memory, and they stay correct when the caller stops
// the generator early — they describe what was walked, not what was returned.
//
// No sandbox: the root is resolved against the process working directory and
// walked as given. Run the harness under the process boundary you trust.

import { open, readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { GITIGNORE_FILE_NAME } from './gitignore';
import type { GitignoreMatcher } from './gitignore';

// Directories that are never useful search results and would dominate a walk.
// Matched by entry name at any depth, deliberately case-sensitive.
//
// This is a floor, not a law: a caller that deliberately roots a search inside one of
// these names (paths: ['node_modules']) gets it walked — see
// `rootTargetsSkippedDirectory` and `ALWAYS_SKIPPED_DIRECTORIES` below. It matches how
// ripgrep behaves, where `node_modules/` is skipped because a .gitignore says so and an
// explicitly named path overrides the ignore rules.
export const SKIPPED_DIRECTORIES: readonly string[] = ['.git', 'node_modules'];

// Names that stay skipped even for a deliberately chosen root. `.git` holds object
// stores, packfiles and hooks; nothing a source question is answered by, and a root
// inside it gains nothing from being descended into.
export const ALWAYS_SKIPPED_DIRECTORIES: readonly string[] = ['.git'];

// Whether the caller rooted the search inside a SKIPPED_DIRECTORIES name.
//
// Checked on the RESOLVED absolute root, because that is the only form in which '.'
// and an absolute path agree. A drive prefix ('C:') or a UNC host can never equal one of
// the names, so a plain segment scan is enough and stays consistent with the
// case-sensitive matching used everywhere else in this module.
export const rootTargetsSkippedDirectory = (absoluteRoot: string): boolean =>
    toPosixPath(absoluteRoot).split('/').some((segment) => SKIPPED_DIRECTORIES.includes(segment));

// A file larger than this is not read by grep. Generated bundles and data dumps
// would otherwise turn one content search into a multi-second read.
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

// Default and hard cap for glob and grep. Discovery already caps what a model sees;
// the same reasoning applies to a search result that would flood a tool response.
//
// The hard cap used to be 100, which made a survey question unanswerable: 738 matching
// lines in 68 files came back as "100, truncated", with no way forward but to guess a
// narrower pattern. 1000 is the same number files settled on for the same reason, and
// the aggregate BYTE budget (not the count) is what actually protects the response.
export const DEFAULT_MAX_RESULTS = 100;
export const MAX_RESULTS_LIMIT = 1000;

// Clamp a caller-supplied cap into [1, MAX_RESULTS_LIMIT], defaulting when absent.
// Non-finite and fractional values are made safe rather than rejected: this is a
// convenience knob, not a contract worth failing a call over.
export const clampMaxResults = (value: number | undefined): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_RESULTS;

    const floored = Math.floor(value);
    if (floored < 1) return 1;
    if (floored > MAX_RESULTS_LIMIT) return MAX_RESULTS_LIMIT;
    return floored;
};

// A `offset` is a plain index into the deterministic result sequence, so it is
// clamped rather than rejected: a negative offset means "from the start", and a
// non-number means "the caller did not page". Same leniency as `maxResults`, for the
// same reason — this is a convenience knob, and a wrong answer here (offset 0) is the
// documented default rather than a silent reinterpretation of a real request.
export const clampOffset = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;

    const floored = Math.floor(value);
    return floored < 0 ? 0 : floored;
};

// Convert a path to the posix separators used in every tool result.
export const toPosixPath = (value: string): string => value.split(sep).join('/');

// Escape the regex metacharacters that are literal in a glob. "*", "?" and "["
// are handled by the loop in globToRegExp before this is reached.
const escapeRegexLiteral = (character: string): string =>
    /[\\^$.()+|{}\]]/.test(character) ? `\\${character}` : character;

// How many patterns one brace-heavy pattern may expand to. `{a,b}` twice is 4; ten
// such groups are 1024. The cap exists because expansion is a string operation the
// caller cannot see, and a pattern like `{1..9}` written as nine alternatives nine
// times over would otherwise compile thousands of RegExps per call.
export const MAX_GLOB_ALTERNATIVES = 256;

// Expand `{a,b}` groups into one pattern per alternative.
//
// Why here rather than in the compiler: `globToRegExp` escapes `{` and `}` as
// literals, so an unexpanded group silently matches nothing — `**/*.{ts,tsx}` returned
// `[]` and looked like "no such file", which is the misleading failure this fixes. One
// expansion pass keeps the compiler a pure character-class translator and makes the
// alternative count visible to the caller (it is what `patterns` in the result echoes).
//
// Rules, chosen to match what a caller expects from a shell/ripgrep pattern:
//   - a `}` inside `[...]` does not close a group;
//   - a group with no top-level comma (`{dist}`) is left literal, as git does — which is
//     also how a file actually NAMED `{solo}.ts` stays reachable;
//   - groups nest: `a{b,{c,d}}e` -> abe, ace, ade;
//   - an unterminated `{` is literal, so a typo costs matches, never a throw;
//   - a backslash is a PATH SEPARATOR, never an escape. `globToRegExp` normalizes `\` to
//     `/`, so treating it as an escape here would make `src\{a,b}` mean something
//     different from `src/{a,b}` for no reason a caller could predict.
export const expandBraces = (pattern: string): string[] => {
    const expand = (value: string, depth: number): string[] => {
        if (depth > 8) return [value];

        // Find the first unescaped, top-level `{` that has a matching `}`.
        let open = -1;
        let close = -1;
        let nesting = 0;
        let inClass = false;

        for (let index = 0; index < value.length; index++) {
            const character = value[index];

            if (character === '[' && inClass === false) {
                inClass = true;
                continue;
            }

            if (inClass) {
                if (character === ']') inClass = false;
                continue;
            }

            if (character === '{') {
                if (nesting === 0) open = index;
                nesting++;
                continue;
            }

            if (character === '}' && nesting > 0) {
                nesting--;

                if (nesting === 0) {
                    close = index;
                    break;
                }
            }
        }

        if (open === -1 || close === -1) return [value];

        const body = value.slice(open + 1, close);

        // Split the group body on its top-level commas.
        const alternatives: string[] = [];
        let current = '';
        let depthInside = 0;
        let classInside = false;

        for (let index = 0; index < body.length; index++) {
            const character = body[index];

            if (character === '[' && !classInside) {
                classInside = true;
                current += character;
                continue;
            }

            if (classInside) {
                if (character === ']') classInside = false;
                current += character;
                continue;
            }

            if (character === '{') {
                depthInside++;
                current += character;
                continue;
            }

            if (character === '}') {
                depthInside--;
                current += character;
                continue;
            }

            if (character === ',' && depthInside === 0) {
                alternatives.push(current);
                current = '';
                continue;
            }

            current += character;
        }

        alternatives.push(current);

        // `{dist}` — one alternative, no comma — is not a choice. Keep the braces as
        // literal characters and carry on looking further along the pattern.
        if (alternatives.length < 2) {
            const rest = expand(value.slice(close + 1), depth + 1);

            return rest.map((tail) => `${value.slice(0, close + 1)}${tail}`);
        }

        const prefix = value.slice(0, open);
        const suffix = value.slice(close + 1);
        const expanded: string[] = [];

        for (const alternative of alternatives) {
            for (const tail of expand(`${alternative}${suffix}`, depth + 1)) {
                expanded.push(`${prefix}${tail}`);

                if (expanded.length > MAX_GLOB_ALTERNATIVES) return expanded;
            }
        }

        return expanded;
    };

    return expand(pattern, 0);
};

// Compile one glob pattern into an anchored RegExp. The pattern is normalized to
// forward slashes first, so a Windows-style pattern still reads as one language.
export const globToRegExp = (pattern: string): RegExp => {
    const normalized = pattern.split('\\').join('/');
    let source = '';

    for (let index = 0; index < normalized.length; index++) {
        const character = normalized[index];

        if (character === '*') {
            if (normalized[index + 1] === '*') {
                index++;

                // "**/" can consume no directory at all, which is what makes
                // "**/*.ts" match a file at the root.
                if (normalized[index + 1] === '/') {
                    index++;
                    source += '(?:.*/)?';
                } else {
                    source += '.*';
                }
            } else {
                source += '[^/]*';
            }

            continue;
        }

        if (character === '?') {
            source += '[^/]';
            continue;
        }

        if (character === '[') {
            const end = normalized.indexOf(']', index + 1);

            // Unterminated class: treat "[" as the literal character instead of
            // throwing, so a typo produces a search with no matches.
            if (end === -1) {
                source += '\\[';
                continue;
            }

            const body = normalized.slice(index + 1, end);
            const negated = body.startsWith('!') ? `^${body.slice(1)}` : body;

            source += `[${negated.split('\\').join('\\\\')}]`;
            index = end;
            continue;
        }

        source += escapeRegexLiteral(character);
    }

    return new RegExp(`^${source}$`);
};

// Test one posix relative path against a glob. Recompiling per path is cheap at
// the caps above and keeps the API honest for one-off calls; callers that test
// thousands of paths compile once via globToRegExp.
export const matchGlob = (pattern: string, path: string): boolean => {
    const matcher = globToRegExp(pattern);

    if (matcher.test(path)) return true;

    // No slash means "any file with this name", at any depth.
    if (!pattern.includes('/')) {
        const name = path.slice(path.lastIndexOf('/') + 1);
        return matcher.test(name);
    }

    return false;
};

// Code-point comparison instead of localeCompare: a locale-aware sort would make
// result order (and therefore a capped result set) depend on the host's ICU data.
const compareNames = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

// What a walk dropped, and why. Owned by the caller (created before the walk, read
// after), because a walk that is abandoned mid-way still has to report what it saw.
export type WalkStats = {
    // Files an ignore rule excluded. Counted per file, because the walker saw each one
    // as an entry and decided not to yield it.
    ignoredFiles: number;
    // DIRECTORIES an ignore rule pruned. Counted once per directory, NOT per file
    // inside it: the walker never entered them, so it never counted their contents.
    // A caller comparing this against a file count has to know the difference, which is
    // why the field is named "directories" here and published as `prunedDirectories`.
    ignoredDirectories: number;
    // Directories dropped by the name skip list (`.git`, `node_modules`), same
    // once-per-directory accounting.
    skippedDirectories: number;
    // Directories `readdir` could not open (permission, or deleted mid-walk). These are
    // the entries that make a result genuinely incomplete rather than policy-filtered.
    unreadableDirectories: number;
    // Symlinked entries of any kind, which are never followed.
    symlinks: number;
    // `.gitignore` files actually read and parsed. The walker knows from its own entry
    // list whether the file exists, so this counts real parses rather than the hundreds of
    // "no such file" probes a repo-wide walk used to make — and it is the number the
    // loader's MAX_GITIGNORE_FILES cap bounds.
    ignoreFilesParsed: number;
};

// A zeroed counter set. Exported so a caller does not have to know the fields.
export const createWalkStats = (): WalkStats => ({
    ignoredFiles: 0,
    ignoredDirectories: 0,
    skippedDirectories: 0,
    unreadableDirectories: 0,
    symlinks: 0,
    ignoreFilesParsed: 0
});

// What a walk may be told to care about. Both options are optional by design: a bare
// `walkFiles(root)` behaves exactly as it always did — every reachable regular file, the
// fixed skip list pruned, and no `.gitignore` involved. `./search.ts` is the caller that
// opts into the ignore-aware walk for `glob` and `grep`.
export type WalkOptions = {
    // Ignore matcher for this root (./gitignore.ts). The walker feeds it one directory at
    // a time as it descends, so rules are discovered in the order the walk reaches them
    // and an ignored directory's own .gitignore is never read.
    ignores?: GitignoreMatcher;
    // Directory names pruned by entry name. Defaults to SKIPPED_DIRECTORIES; a caller
    // that deliberately rooted the search inside one of them passes
    // ALWAYS_SKIPPED_DIRECTORIES so nested copies stay reachable.
    skipDirectories?: readonly string[];
    // Counter set the walker increments. Absent means "do not count", which is what a
    // bare `walkFiles` caller gets — no allocation, no behaviour change.
    stats?: WalkStats;
};

// Yield every regular file under `root`, as posix paths relative to `root`.
//
// Traversal is depth-first over name-sorted entries, so the sequence is fully
// lexicographic and stable across runs and platforms. Unreadable directories and
// entries are skipped: a search should not fail because one subtree is not
// readable. A root that cannot be listed does throw — that is a caller mistake,
// not noise.
//
// A root that is a FILE is yielded as its own basename. That is not a convenience
// bolted on afterwards: "search this file" is the most natural call a caller makes
// (`grep({ pattern, paths: ['src/a.ts'] })`), and before this it failed with a raw
// `ENOTDIR ... scandir` from the middle of the tool family that accepts files
// everywhere else (read, edit).
export async function* walkFiles(
    root: string,
    options: WalkOptions = {}
): AsyncGenerator<string> {
    const absoluteRoot = resolve(root);
    const skipDirectories = options.skipDirectories ?? SKIPPED_DIRECTORIES;
    const { ignores, stats } = options;

    // The file-root case, decided once per root rather than per entry.
    try {
        const info = await stat(absoluteRoot);

        if (info.isFile()) {
            yield absoluteRoot.split(sep).pop() ?? absoluteRoot;
            return;
        }
    } catch {
        // No stat, or a directory: either way `readdir` below is the authority, and
        // its error is the one worth reporting (a missing root, not a missing stat).
    }

    // Recursive generator: `yield*` keeps the depth-first order obvious, and the
    // recursion depth is bounded by the directory depth rather than the file count.
    const walk = async function* (
        directory: string,
        relativeDirectory: string
    ): AsyncGenerator<string> {
        let entries;

        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            // The root itself must exist and be a directory; anything deeper is
            // skipped so one permission error cannot abort the walk.
            if (directory === absoluteRoot) throw error;
            if (stats) stats.unreadableDirectories += 1;
            return;
        }

        // Rules are picked up per directory that is actually listed. That is what keeps
        // "an ignored directory is never inspected" true, and it is also why a
        // .gitignore ABOVE the root never applies: it is simply never loaded.
        //
        // The walker already has the entry list, so it says whether the file is there
        // instead of letting the loader discover it with a failed `open`. On a repo-wide
        // walk that is one avoided syscall per directory — hundreds to thousands of them
        // for information that was already paid for — and it keeps the loader's
        // MAX_GITIGNORE_FILES cap charging FILES PARSED rather than directories visited.
        let ignoreFilePresent = false;

        if (ignores) {
            ignoreFilePresent = entries.some(
                (entry) => entry.name === GITIGNORE_FILE_NAME && entry.isFile()
            );
            await ignores.load(directory, relativeDirectory, { present: ignoreFilePresent });
            if (stats && ignoreFilePresent) stats.ignoreFilesParsed += 1;
        }

        entries.sort((left, right) => compareNames(left.name, right.name));

        for (const entry of entries) {
            // Symlinks are skipped: they can point outside the root and create
            // cycles, neither of which is worth the convenience.
            if (entry.isSymbolicLink()) {
                if (stats) stats.symlinks += 1;
                continue;
            }

            const fullPath = join(directory, entry.name);

            // Built once per entry and already posix, so a yielded path never needs a
            // second relative()/toPosixPath() pass.
            const relativePath =
                relativeDirectory.length === 0
                    ? entry.name
                    : `${relativeDirectory}/${entry.name}`;

            // An excluded directory is pruned rather than descended into, and an excluded
            // file is simply never yielded. A '!' rule is decided inside the matcher, not
            // here, so the walk has exactly one ignore verdict to respect.
            if (ignores && ignores.isIgnored(relativePath, entry.isDirectory())) {
                if (stats) {
                    if (entry.isDirectory()) stats.ignoredDirectories += 1;
                    else stats.ignoredFiles += 1;
                }
                continue;
            }

            if (entry.isDirectory()) {
                if (skipDirectories.includes(entry.name)) {
                    if (stats) stats.skippedDirectories += 1;
                    continue;
                }
                yield* walk(fullPath, relativePath);
                continue;
            }

            if (entry.isFile()) yield relativePath;
        }
    };

    // The root's own name is never tested against the skip list or the ignore rules:
    // naming a directory IS the caller saying "search here on purpose".
    yield* walk(absoluteRoot, '');
}

// The first bytes scanned for the binary verdict. A NUL this early is enough to call
// a file binary, and checking the Buffer (rather than a decoded string) means a
// 1 MiB minified asset that turns out to be binary never gets decoded to UTF-16.
export const BINARY_SNIFF_BYTES = 8 * 1024;

// One file's read outcome, decided by a single open.
export type SearchFileRead =
    // Small enough, and text: `content` is the decoded file.
    | { status: 'read'; content: string }
    // Larger than MAX_SEARCH_FILE_BYTES. Reported, not silently dropped.
    | { status: 'tooLarge'; size: number }
    // A NUL in the first chunk: reading it would only produce noise matches.
    | { status: 'binary' }
    // Could not be opened or read (missing, EPERM, a directory, an I/O error).
    | { status: 'unreadable'; code: string };

// Open a file ONCE and decide all three of its bounds from that one handle.
//
// The previous shape was `isSearchableFileSize(path)` (a stat) followed by
// `readFile(path)` (which opens, stats, reads and closes again): two opens and two
// stats per candidate, on a walk whose whole cost IS syscalls. Here the size comes
// from the handle that is about to read the bytes, so one candidate costs
// open + fstat + read + close — the same syscalls `readFile` makes internally, minus
// the duplicate pair. On the measured tree that is the difference between a repo-wide
// grep and a repo-wide grep that times out.
//
// Every failure is a RESULT, never a throw: a file deleted between the walk and the
// read is a race, and a race must not cost the caller the matches it already has.
export const readSearchableFile = async (path: string): Promise<SearchFileRead> => {
    let handle;

    try {
        handle = await open(path, 'r');
    } catch (error) {
        return { status: 'unreadable', code: errorCode(error) };
    }

    try {
        const info = await handle.stat();

        // A directory opened for reading stats fine and then fails to read, so say so
        // here rather than reporting an I/O mystery.
        if (!info.isFile()) return { status: 'unreadable', code: 'EISDIR' };

        if (info.size > MAX_SEARCH_FILE_BYTES) return { status: 'tooLarge', size: info.size };

        const buffer = await handle.readFile();

        // Binary verdict BEFORE decoding: `buffer.subarray` is a view, so the sniff
        // costs nothing, and a binary file never pays for a UTF-8 decode.
        if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { status: 'binary' };

        return { status: 'read', content: buffer.toString('utf8') };
    } catch (error) {
        return { status: 'unreadable', code: errorCode(error) };
    } finally {
        // The handle must close even when the read threw, or a long walk leaks one
        // descriptor per failed file and dies on EMFILE instead of on the budget.
        await handle.close().catch(() => undefined);
    }
};

// The `code` of an unknown error, without trusting a getter that might throw.
export const errorCode = (error: unknown): string => {
    try {
        const code = (error as { code?: unknown } | null | undefined)?.code;
        return typeof code === 'string' ? code : 'UNKNOWN';
    } catch {
        return 'UNKNOWN';
    }
};

// `isSearchableFileSize` and `looksBinary` are gone rather than kept "for callers": the
// one open in `readSearchableFile` decides both, so a caller that asked either question
// separately would be paying for a second syscall to learn something the read already
// answered. Dead exports in a helper module are a second opinion nobody has to agree
// with, and the second opinion here was the slower one.
