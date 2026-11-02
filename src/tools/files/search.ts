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
//     glob  ({ patterns?, paths?, maxResults? })          -> { files, truncated }
//     grep  ({ pattern, patterns?, paths?, maxResults? })  -> { matches, truncated, bytes, contentBudget }
//
// Both walk the SAME tree with the SAME rules, and that shared half lives here so the
// two entries cannot drift: pattern compilation, the "no slash also matches the file
// name" rule, root identity + file identity dedupe, and the argument-validation wording
// are defined once. Each `*.tool.ts` entry keeps only its own verdict step (list the
// path, or read the file and match its lines).
//
// WALKER RULES (unchanged; owned by ./glob.ts and documented there)
// ----------------------------------------------------------------
//   - patterns are matched against each file's path RELATIVE TO THE ROOT that found
//     it, never against an absolute path, and every result is prefixed with that root;
//   - a pattern with no "/" additionally matches the bare file name at any depth;
//   - .git, node_modules and symlinks are never entered; .gitignore is not consulted;
//   - the walk is depth-first over name-sorted entries, so a capped result is a
//     deterministic prefix of the tree.
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
// Cross-references:
//   - ./glob.tool.ts    — filename search (this module's only list-paths caller)
//   - ./grep.tool.ts    — content search (this module's only read-lines caller)
//   - ./glob.ts         — the walker, the matcher and the size/binary helpers
//   - ./identity.ts     — the canonical per-root / per-file comparison keys
//   - ./bounded-regex.ts— the time-bounded regex grep runs inside `node:vm`

import { join, resolve } from 'node:path';
import { HarnessError } from '../../util';
import { canonicalPathKey, fileIdentity } from './identity';
import { globToRegExp, toPosixPath, walkFiles } from './glob';

// One compiled pattern plus the "slashless patterns also match the name" flag. This
// is also where that rule is decided, so both search tools apply it identically.
export type CompiledPattern = {
    matcher: RegExp;
    // True when the pattern contains no "/", so it may also be tested against the
    // bare file name (the ripgrep `-g '*.ts'` behaviour).
    namesOnly: boolean;
};

// Compile every pattern ONCE per call. Compiling per file would be correct but
// wasteful, and the caps in ./glob.ts make one compile pass per call the honest
// shape. An invalid glob never throws here: ./glob.ts treats an unterminated
// character class as a literal, so a typo yields a search with no matches.
export const compilePatterns = (patterns: readonly string[]): CompiledPattern[] =>
    patterns.map((pattern) => ({
        matcher: globToRegExp(pattern),
        namesOnly: !pattern.includes('/')
    }));

// Does one root-relative path match ANY of the compiled patterns?
export const matchesAnyPattern = (
    compiled: readonly CompiledPattern[],
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
export type SearchCandidate = {
    // Canonical file key; the dedupe key (one file, one entry). See ./identity.
    identity: string;
    // Root-prefixed posix path, exactly the presentation fileList uses.
    display: string;
    // Absolute path for a content read.
    absolute: string;
};

// Walk every root in caller order and yield the files matching any pattern.
//
// Deduplication happens here rather than per root, because overlapping roots are the
// reason it is needed at all: the first root that reaches a file wins, which is what
// makes the caller's root order meaningful. A root that resolves to a directory
// already walked (a symlink alias, or 'src' and 'SRC' on Windows) is skipped
// entirely. Both tools stream this generator, so a capped search stops walking
// instead of materializing the whole tree.
export async function* collectCandidates(
    roots: readonly string[],
    compiled: readonly CompiledPattern[]
): AsyncGenerator<SearchCandidate> {
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

        for await (const relativePath of walkFiles(absoluteRoot)) {
            if (!matchesAnyPattern(compiled, relativePath)) continue;

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
