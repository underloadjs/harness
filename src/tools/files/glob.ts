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
//   A pattern with no "/" additionally matches against the file name alone, so
//   "*.ts" behaves like ripgrep's -g '*.ts' rather than requiring "**/*.ts".
//
// Deliberate limits (reported, not claimed away):
//   - no brace expansion ({a,b}) and no extglob;
//   - the walker itself does not read `.gitignore`: the caller passes a matcher built by
//     ./gitignore.ts, which is what lets `glob`/`grep` honor the repository's ignore
//     rules while a bare `walkFiles(root)` keeps its original "everything reachable"
//     meaning;
//   - symlinks are skipped while walking, so traversal cannot loop or escape the
//     root through a link;
//   - paths are posix-style ("a/b.ts") on every platform, because the model should
//     not have to care which OS the harness runs on.
//
// No sandbox: the root is resolved against the process working directory and
// walked as given. Run the harness under the process boundary you trust.

import { readdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
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
export const DEFAULT_MAX_RESULTS = 100;
export const MAX_RESULTS_LIMIT = 100;

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

// Convert a path to the posix separators used in every tool result.
export const toPosixPath = (value: string): string => value.split(sep).join('/');

// Escape the regex metacharacters that are literal in a glob. "*", "?" and "["
// are handled by the loop in globToRegExp before this is reached.
const escapeRegexLiteral = (character: string): string =>
    /[\\^$.()+|{}\]]/.test(character) ? `\\${character}` : character;

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
};

// Yield every regular file under `root`, as posix paths relative to `root`.
//
// Traversal is depth-first over name-sorted entries, so the sequence is fully
// lexicographic and stable across runs and platforms. Unreadable directories and
// entries are skipped: a search should not fail because one subtree is not
// readable. A root that cannot be listed does throw — that is a caller mistake,
// not noise.
export async function* walkFiles(
    root: string,
    options: WalkOptions = {}
): AsyncGenerator<string> {
    const absoluteRoot = resolve(root);
    const skipDirectories = options.skipDirectories ?? SKIPPED_DIRECTORIES;
    const { ignores } = options;

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
            return;
        }

        // Rules are picked up per directory that is actually listed. That is what keeps
        // "an ignored directory is never inspected" true, and it is also why a
        // .gitignore ABOVE the root never applies: it is simply never loaded.
        if (ignores) await ignores.load(directory, relativeDirectory);

        entries.sort((left, right) => compareNames(left.name, right.name));

        for (const entry of entries) {
            // Symlinks are skipped: they can point outside the root and create
            // cycles, neither of which is worth the convenience.
            if (entry.isSymbolicLink()) continue;

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
            if (ignores && ignores.isIgnored(relativePath, entry.isDirectory())) continue;

            if (entry.isDirectory()) {
                if (skipDirectories.includes(entry.name)) continue;
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

// Whether a file is small enough for grep to read. A stat
// failure is treated as "skip" for the same reason unreadable directories are
// skipped.
export const isSearchableFileSize = async (path: string): Promise<boolean> => {
    try {
        const info = await stat(path);
        return info.size <= MAX_SEARCH_FILE_BYTES;
    } catch {
        return false;
    }
};

// A NUL byte in the first chunk means the file is binary (the same heuristic git
// uses). Reading it would only produce noise matches in a model's context.
export const looksBinary = (content: string): boolean => content.includes('\u0000');
