// @underload/harness tools/files/glob — dependency-free glob matching and walking.
//
// Shared by searchFiles and globFiles. Kept in one file so both tools agree on
// what "include" means and on which directories a walk never enters.
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
//   - `.gitignore` is NOT consulted — only the fixed skip list below is;
//   - symlinks are skipped while walking, so traversal cannot loop or escape the
//     root through a link;
//   - paths are posix-style ("a/b.ts") on every platform, because the model should
//     not have to care which OS the harness runs on.
//
// No sandbox: the root is resolved against the process working directory and
// walked as given. Run the harness under the process boundary you trust.

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

// Directories that are never useful search results and would dominate a walk.
// Matched by entry name at any depth, deliberately case-sensitive.
export const SKIPPED_DIRECTORIES: readonly string[] = ['.git', 'node_modules'];

// A file larger than this is not read by searchFiles. Generated bundles and data
// dumps would otherwise turn one grep into a multi-second read.
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

// Default and hard cap for both tools. Discovery already caps what a model sees;
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

// Yield every regular file under `root`, as posix paths relative to `root`.
//
// Traversal is depth-first over name-sorted entries, so the sequence is fully
// lexicographic and stable across runs and platforms. Unreadable directories and
// entries are skipped: a search should not fail because one subtree is not
// readable. A root that cannot be listed does throw — that is a caller mistake,
// not noise.
export async function* walkFiles(root: string): AsyncGenerator<string> {
    const absoluteRoot = resolve(root);

    // Recursive generator: `yield*` keeps the depth-first order obvious, and the
    // recursion depth is bounded by the directory depth rather than the file count.
    const walk = async function* (directory: string): AsyncGenerator<string> {
        let entries;

        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            // The root itself must exist and be a directory; anything deeper is
            // skipped so one permission error cannot abort the walk.
            if (directory === absoluteRoot) throw error;
            return;
        }

        entries.sort((left, right) => compareNames(left.name, right.name));

        for (const entry of entries) {
            // Symlinks are skipped: they can point outside the root and create
            // cycles, neither of which is worth the convenience.
            if (entry.isSymbolicLink()) continue;

            const fullPath = join(directory, entry.name);

            if (entry.isDirectory()) {
                if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
                yield* walk(fullPath);
                continue;
            }

            if (entry.isFile()) {
                yield toPosixPath(relative(absoluteRoot, fullPath));
            }
        }
    };

    yield* walk(absoluteRoot);
}

// Whether a file is small enough for searchFiles to read. A stat failure is
// treated as "skip" for the same reason unreadable directories are skipped.
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
