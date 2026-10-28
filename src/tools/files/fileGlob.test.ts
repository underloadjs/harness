// fileGlob — the unified glob/content search contract (T14).
//
// fileGlob replaces the old globFiles + searchFiles pair. Its MODE is decided by
// the presence of `content`, which is the documented contract (and is asserted in
// the catalogue test too, because the model reads the description, not this file):
//
//   no `content`  -> { files: string[], truncated: boolean }
//   `content`     -> { matches: { path, line, text }[], truncated: boolean }
//
// What this pins:
//   - filename mode: glob matching, name-at-any-depth for slashless patterns,
//     root-prefixed presentation, caller root order, dedupe across overlapping
//     roots/patterns, and one GLOBAL cap;
//   - content mode: one match per line with a 1-based line number, the same
//     adversarial skip list (.git, node_modules, binary, symlinks), regex
//     semantics, caps, truncation, and the T16 matching BUDGET that stops a
//     catastrophic pattern instead of hanging;
//   - T16 argument rules: a non-object argument (string, array) is rejected rather
//     than defaulted to "every file", and patterns are matched relative to EACH
//     root (results are root-prefixed);
//   - T16 root identity: roots that are ONE directory (a case alias on Windows, a
//     symlink alias anywhere) are walked once, so files are never listed twice;
//   - argument validation: non-empty `patterns`/`paths` arrays, string `content`,
//     and the documented defaults.
//
// The fixture tree is the process cwd for this file, so roots are relative and the
// results are the documented root-prefixed relative paths (the same presentation
// fileList uses: "." contributes no prefix). Fixtures live under the repo-root
// `Temp/`, one unique directory per run, removed afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, matchGlob } from './glob';
import { FILE_GLOB_CONTENT_BUDGET, FILE_GLOB_MATCH_TEXT_BYTES, fileGlob } from './fileGlob';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;
// A directory symlink is privileged on Windows (Developer Mode or elevated); the
// alias assertions run only when the host let us create one.
let rootAlias: string | undefined;

const seed = async (relativePath: string, content = 'x\n'): Promise<void> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
};

beforeAll(async () => {
    previousCwd = process.cwd();
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-glob-'));
    process.chdir(workdir);

    // Skipped by the walker, in BOTH modes.
    await seed('.git/secret.ts', '// TODO: hidden\n');
    await seed('node_modules/pkg/index.js', '// TODO: ignored\n');

    // Skipped in content mode only (a NUL byte makes it "binary").
    await seed('binary.bin', 'TODO\u0000binary\n');

    // The searchable tree.
    await seed('docs/readme.md', 'TODO: four\n');
    await seed('src/a.ts', 'const x = 1;\n// TODO: one\n');
    await seed('src/b.ts', '// TODO: two\n');
    await seed('src/nested/c.js', 'TODO: three\n');
    await seed('src/nested/deep/d.ts', 'no match here\n');
    await seed('task/e.ts', '// TODO: five\n');
    await seed('root.txt', 'TODO: six\n');

    // The budget fixture: 31 bytes that make `(a+)+$` backtrack catastrophically.
    await seed('evil/line.txt', `${'a'.repeat(31)}b\n`);

    // Content-bound fixtures, use the unique token NEEDLE so the TODO
    // expectations below stay untouched:
    //   - a 2000-character ASCII line (cut at 1024 bytes on a code-point boundary),
    //   - a line of 300 four-byte emoji (a naive UTF-16 slice would split a pair),
    //   - 70 lines of exactly 1024 bytes each: 64 fit the 64 KiB aggregate budget
    //     EXACTLY and the 65th proves truncation.
    await seed('huge/ascii.txt', `NEEDLE ${'a'.repeat(2000)}\n`);
    await seed('huge/emoji.txt', `NEEDLE ${'😀'.repeat(300)}\n`);
    await seed('budget/lines.txt', `${`${'Q'.repeat(1024)}\n`.repeat(70)}`);

    try {
        await symlink(join(workdir, 'src'), join(workdir, 'src-alias'), 'dir');
        rootAlias = 'src-alias';
    } catch {
        rootAlias = undefined;
    }
});

afterAll(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
});

describe('fileGlob — filename mode', () => {
    it('lists every file for the default pattern without entering skipped directories', async () => {
        // `fileGlob({})` is the documented "every file under '.'" request, and "."
        // contributes no prefix.
        await expect(fileGlob({})).resolves.toEqual({
            files: [
                'binary.bin',
                'budget/lines.txt',
                'docs/readme.md',
                'evil/line.txt',
                'huge/ascii.txt',
                'huge/emoji.txt',
                'root.txt',
                'src/a.ts',
                'src/b.ts',
                'src/nested/c.js',
                'src/nested/deep/d.ts',
                'task/e.ts'
            ],
            truncated: false
        });
    });

    it('matches a pattern without a slash against file names at any depth', async () => {
        await expect(fileGlob({ patterns: ['*.ts'] })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts', 'task/e.ts'],
            truncated: false
        });
    });

    it('matches a slash pattern against the root-relative path', async () => {
        await expect(fileGlob({ patterns: ['src/**/*.js'] })).resolves.toEqual({
            files: ['src/nested/c.js'],
            truncated: false
        });

        await expect(fileGlob({ patterns: ['src/*.ts'] })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts'],
            truncated: false
        });
    });

    it('ORs several patterns together', async () => {
        await expect(fileGlob({ patterns: ['*.md', 'src/*.ts'] })).resolves.toEqual({
            files: ['docs/readme.md', 'src/a.ts', 'src/b.ts'],
            truncated: false
        });
    });

    it('prefixes results with the requested root and follows the caller root order', async () => {
        // Each root contributes its own prefix, and the roots are visited in the
        // caller's order — never sorted.
        await expect(fileGlob({ patterns: ['*.ts'], paths: ['task', 'src'] })).resolves.toEqual({
            files: ['task/e.ts', 'src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts'],
            truncated: false
        });
    });

    it('deduplicates overlapping roots by file identity, keeping the first prefix', async () => {
        // ['src', '.'] both reach src/a.ts. The FIRST root wins the presentation, so
        // the file appears once — as "src/a.ts", not also as "src/src/a.ts" or
        // "src/a.ts" twice.
        await expect(fileGlob({ patterns: ['src/*.ts'], paths: ['src', '.'] })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts'],
            truncated: false
        });
    });

    it('caps results globally across roots and flags truncation', async () => {
        await expect(fileGlob({ patterns: ['*.ts'], paths: ['.'], maxResults: 2 })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts'],
            truncated: true
        });
    });

    it('does not claim truncation when the cap is not reached', async () => {
        await expect(fileGlob({ patterns: ['*.md'], maxResults: 100 })).resolves.toEqual({
            files: ['docs/readme.md'],
            truncated: false
        });
    });

    it('surfaces a missing search root', async () => {
        await expect(fileGlob({ patterns: ['**/*'], paths: ['absent'] })).rejects.toThrow(/ENOENT/);
    });

    it('rejects an empty patterns or paths array instead of matching nothing', async () => {
        await expect(fileGlob({ patterns: [] })).rejects.toThrow(
            'fileGlob received an empty patterns array. Omit patterns to use the default ("**/*").'
        );
        await expect(fileGlob({ paths: [] })).rejects.toThrow(
            'fileGlob received an empty paths array. Omit paths to use the default (".").'
        );
    });

    it('rejects malformed pattern/path entries and a non-string content', async () => {
        await expect(fileGlob({ patterns: [''] })).rejects.toThrow(
            'fileGlob patterns must be non-empty strings.'
        );
        await expect(fileGlob({ paths: [''] })).rejects.toThrow('fileGlob paths must be non-empty strings.');
        await expect(fileGlob({ patterns: ['a\u0000b'] })).rejects.toThrow(
            'fileGlob patterns must not contain NUL characters.'
        );
        await expect(fileGlob({ paths: ['a\u0000b'] })).rejects.toThrow(
            'fileGlob paths must not contain NUL characters.'
        );
        await expect(fileGlob({ patterns: 'x' } as never)).rejects.toThrow(
            'fileGlob patterns must be an array of strings.'
        );
        await expect(fileGlob({ content: 7 } as never)).rejects.toThrow(
            'fileGlob content must be a regular-expression string when provided.'
        );
    });

    it('rejects a non-object argument instead of defaulting to every file', async () => {
        // T16: a string or an array used to slip past the property reads and mean
        // "use every default" — i.e. list the whole tree. A wrong answer that looks
        // complete is worse than an error, so the shape is checked first.
        const message =
            'fileGlob expects an object with optional "patterns", "paths", "content", and "maxResults" properties, e.g. {"patterns":["**/*.ts"]}.';

        await expect(fileGlob('*.ts' as never)).rejects.toThrow(message);
        await expect(fileGlob(['**/*.ts'] as never)).rejects.toThrow(message);
        await expect(fileGlob(7 as never)).rejects.toThrow(message);

        // `null` and `undefined` are "no argument at all", which is a legitimate
        // documented request: every file under ".".
        await expect(fileGlob(undefined as never)).resolves.toEqual({
            files: [
                'binary.bin',
                'budget/lines.txt',
                'docs/readme.md',
                'evil/line.txt',
                'huge/ascii.txt',
                'huge/emoji.txt',
                'root.txt',
                'src/a.ts',
                'src/b.ts',
                'src/nested/c.js',
                'src/nested/deep/d.ts',
                'task/e.ts'
            ],
            truncated: false
        });
    });

    it('matches patterns relative to each root and prefixes results with it', async () => {
        // The documented contract: a pattern is never matched against the absolute
        // path or against the root's own name, only against the path of the file
        // relative to the root that found it.
        await expect(fileGlob({ paths: ['src'], patterns: ['**/*.ts'] })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts'],
            truncated: false
        });

        // "src/*.ts" therefore matches NOTHING when "src" is the root (the relative
        // paths are "a.ts", "b.ts", …), even though it matches two files when "."
        // is the root. This is the exact confusion the docs now spell out.
        await expect(fileGlob({ paths: ['src'], patterns: ['src/*.ts'] })).resolves.toEqual({
            files: [],
            truncated: false
        });
        await expect(fileGlob({ paths: ['.'], patterns: ['src/*.ts'] })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts'],
            truncated: false
        });

        // Two roots keep two prefixes, and each root is matched on its own paths.
        await expect(fileGlob({ paths: ['task', 'src'], patterns: ['**/*.ts'] })).resolves.toEqual({
            files: ['task/e.ts', 'src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts'],
            truncated: false
        });
    });
});

describe('fileGlob — content mode', () => {
    it('returns every non-skipped match in walk order', async () => {
        await expect(fileGlob({ content: 'TODO' })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
                { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 },
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 67,
            contentBudget: 65536
        });
    });

    it('restricts the content search to files matching the patterns', async () => {
        await expect(fileGlob({ patterns: ['*.ts'], content: 'TODO' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 37,
            contentBudget: 65536
        });
    });

    it('treats content as a JavaScript regular expression', async () => {
        await expect(fileGlob({ content: 'TODO: (one|three)' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 }
            ],
            truncated: false,
            bytes: 23,
            contentBudget: 65536
        });
    });

    it('caps matches globally and flags truncation', async () => {
        await expect(fileGlob({ content: 'TODO', maxResults: 2 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
                { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 }
            ],
            truncated: true,
            bytes: 19,
            contentBudget: 65536
        });
    });

    it('clamps maxResults to the hard cap without claiming truncation', async () => {
        // 6 matches exist; asking for 1_000 must not exceed the documented cap and
        // must not claim truncation when everything fits.
        await expect(fileGlob({ content: 'TODO', maxResults: 1000 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four', textTruncated: false, bytes: 10 },
                { path: 'root.txt', line: 1, text: 'TODO: six', textTruncated: false, bytes: 9 },
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three', textTruncated: false, bytes: 11 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 67,
            contentBudget: 65536
        });
    });

    it('returns an empty match list when nothing matches', async () => {
        await expect(fileGlob({ content: 'ZZZ' })).resolves.toEqual({
            matches: [],
            truncated: false,
            bytes: 0,
            contentBudget: 65536
        });
    });

    it('surfaces an invalid regular expression', async () => {
        await expect(fileGlob({ content: '[' })).rejects.toThrow(SyntaxError);
    });

    it('surfaces a missing search root', async () => {
        await expect(fileGlob({ content: 'TODO', paths: ['absent'] })).rejects.toThrow(/ENOENT/);
    });

    it('reports paths relative to a nested root and deduplicates overlapping roots', async () => {
        // Root 'src' + '.' both reach src/a.ts. Every result is root-prefixed (the
        // same presentation fileList uses), and the FIRST root wins, so the file is
        // reported once as "src/a.ts" — never twice, and never "src/src/a.ts".
        await expect(fileGlob({ content: 'TODO: one', paths: ['src', '.'] })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 }
            ],
            truncated: false,
            bytes: 12,
            contentBudget: 65536
        });

        // The same request rooted at "." alone produces the identical path, which is
        // what makes the dedupe invisible to a caller that lists one root.
        await expect(fileGlob({ content: 'TODO: one', paths: ['.'] })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 }
            ],
            truncated: false,
            bytes: 12,
            contentBudget: 65536
        });
    });

    it('stops a catastrophic pattern instead of hanging, with a clear error', async () => {
        // T16 regression: `(a+)+$` against 31 "a"s and a "b" used to block the whole
        // process for seconds. It now runs inside a vm with the documented cumulative
        // budget, so the call fails instead of freezing the harness. Restricted to
        // the one file, so no other fixture is scanned before the stop.
        await expect(
            fileGlob({ patterns: ['line.txt'], content: '(a+)+$' })
        ).rejects.toThrow(
            'fileGlob content pattern did not finish within its 2000ms matching budget and was stopped. Simplify the pattern: nested quantifiers such as "(a+)+" can backtrack exponentially.'
        );
    });

    it('keeps ordinary content searches unaffected by the budget', async () => {
        // The same fixture set as before, with the vm-backed matcher: same matches,
        // same order, same line numbers.
        await expect(fileGlob({ patterns: ['*.ts'], content: 'TODO' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one', textTruncated: false, bytes: 12 },
                { path: 'src/b.ts', line: 1, text: '// TODO: two', textTruncated: false, bytes: 12 },
                { path: 'task/e.ts', line: 1, text: '// TODO: five', textTruncated: false, bytes: 13 }
            ],
            truncated: false,
            bytes: 37,
            contentBudget: 65536
        });
    });

    // R4: one match on a giant line used to copy the WHOLE line. The snippet cap
    // cuts it on a code-point boundary and says so per match.
    it('cuts a giant ASCII line to the 1 KiB snippet cap and flags it, keeping the line number', async () => {
        await expect(fileGlob({ patterns: ['ascii.txt'], content: 'NEEDLE' })).resolves.toEqual({
            matches: [
                {
                    path: 'huge/ascii.txt',
                    line: 1,
                    // Exactly 1024 bytes: 7 for "NEEDLE " plus 1017 "a"s.
                    text: `NEEDLE ${'a'.repeat(1017)}`,
                    textTruncated: true,
                    bytes: 1024
                }
            ],
            truncated: false,
            bytes: 1024,
            contentBudget: 65536
        });
    });

    it('never splits a surrogate pair when cutting a giant non-ASCII line', async () => {
        // The fixture is "NEEDLE " (7 bytes) plus 300 four-byte emoji. 7 + 4 * 254 =
        // 1023 bytes fit; the 255th emoji would take it to 1027, so the cut lands
        // BEFORE it. A UTF-16 slice at 1024 units would have produced a lone
        // surrogate, i.e. a character that is not in the file.
        await expect(fileGlob({ patterns: ['emoji.txt'], content: 'NEEDLE' })).resolves.toEqual({
            matches: [
                {
                    path: 'huge/emoji.txt',
                    line: 1,
                    text: `NEEDLE ${'😀'.repeat(254)}`,
                    textTruncated: true,
                    bytes: 1023
                }
            ],
            truncated: false,
            bytes: 1023,
            contentBudget: 65536
        });
    });

    it('stops at the aggregate 64 KiB budget and reports truncation instead of dropping matches silently', async () => {
        // budget/lines.txt has 70 matching lines of exactly 1024 bytes. 64 matches
        // charge 64 * 1024 = 65536 bytes — the budget EXACTLY — so all 64 are
        // returned; the 65th match is the one that cannot fit, which is what makes
        // `truncated: true` a proven fact rather than a guess.
        const expectedBudgetMatches = Array.from({ length: 64 }, (_unused, index) => ({
            path: 'budget/lines.txt',
            line: index + 1,
            text: 'Q'.repeat(1024),
            textTruncated: false,
            bytes: 1024
        }));

        await expect(fileGlob({ patterns: ['lines.txt'], content: 'Q' })).resolves.toEqual({
            matches: expectedBudgetMatches,
            truncated: true,
            bytes: 65536,
            contentBudget: 65536
        });
    });

    it('reports the byte budget it enforces as exported constants', async () => {
        // The numbers a caller reads in the result must be the numbers the module
        // documents, so a host cannot quietly widen them.
        expect(FILE_GLOB_MATCH_TEXT_BYTES).toBe(1024);
        expect(FILE_GLOB_CONTENT_BUDGET).toBe(65536);
    });
});

// T16: two roots that are ONE directory must be walked once. Both cases are about
// file identity rather than spelling, which is what the old `resolve()`-based
// dedupe missed.
describe('fileGlob — aliased roots', () => {
    it('walks a case-aliased root once on Windows and keeps it distinct on Linux', async () => {
        // NTFS is case-insensitive, so 'src' and 'SRC' are the same directory and a
        // second pass would list every file twice under a second prefix. Linux has no
        // 'SRC' at all, so that spelling is a missing root — asserted as its own
        // truth instead of being skipped.
        if (process.platform === 'win32') {
            await expect(fileGlob({ paths: ['src', 'SRC'], patterns: ['**/*.ts'] })).resolves.toEqual({
                files: ['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts'],
                truncated: false
            });
            return;
        }

        await expect(fileGlob({ paths: ['src', 'SRC'], patterns: ['**/*.ts'] })).rejects.toThrow(
            /ENOENT/
        );
    });

    it('walks a symlinked root once when the host allows symlinks', async () => {
        if (rootAlias === undefined) return;

        // 'src-alias' resolves to 'src', so the second root contributes only
        // duplicates. The first root wins the prefix, exactly like overlapping roots.
        await expect(
            fileGlob({ paths: ['src', rootAlias], patterns: ['**/*.ts'] })
        ).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts'],
            truncated: false
        });

        // Reverse order: the alias is walked first, so its prefix is the one kept.
        await expect(
            fileGlob({ paths: [rootAlias, 'src'], patterns: ['**/*.ts'] })
        ).resolves.toEqual({
            files: ['src-alias/a.ts', 'src-alias/b.ts', 'src-alias/nested/deep/d.ts'],
            truncated: false
        });
    });
});

describe('glob matching rules', () => {
    it('anchors patterns and keeps * inside one segment', () => {
        expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
        expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
        expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
        expect(globToRegExp('a?.ts').test('a.ts')).toBe(false);
    });

    it('lets **/ match zero directories', () => {
        expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
        expect(globToRegExp('**/*.ts').test('src/nested/a.ts')).toBe(true);
    });

    it('supports character classes, including negation', () => {
        expect(matchGlob('file[0-9].ts', 'file7.ts')).toBe(true);
        expect(matchGlob('file[!0-9].ts', 'file7.ts')).toBe(false);
        expect(matchGlob('file[!0-9].ts', 'filex.ts')).toBe(true);
    });

    it('falls back to the file name only when the pattern has no slash', () => {
        expect(matchGlob('*.md', 'docs/readme.md')).toBe(true);
        expect(matchGlob('docs/*.md', 'docs/readme.md')).toBe(true);
        expect(matchGlob('docs/*.md', 'other/docs/readme.md')).toBe(false);
    });

    it('treats an unterminated class as a literal bracket', () => {
        expect(matchGlob('file[.ts', 'file[.ts')).toBe(true);
    });
});
