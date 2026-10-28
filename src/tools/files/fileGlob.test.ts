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
//     semantics, caps, and truncation;
//   - argument validation: non-empty `patterns`/`paths` arrays, string `content`,
//     and the documented defaults.
//
// The fixture tree is the process cwd for this file, so roots are relative and the
// results are the documented root-prefixed relative paths (the same presentation
// fileList uses: "." contributes no prefix). Fixtures live under the repo-root
// `Temp/`, one unique directory per run, removed afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, matchGlob } from './glob';
import { fileGlob } from './fileGlob';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;

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
                'docs/readme.md',
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
});

describe('fileGlob — content mode', () => {
    it('returns every non-skipped match in walk order', async () => {
        await expect(fileGlob({ content: 'TODO' })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four' },
                { path: 'root.txt', line: 1, text: 'TODO: six' },
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/b.ts', line: 1, text: '// TODO: two' },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three' },
                { path: 'task/e.ts', line: 1, text: '// TODO: five' }
            ],
            truncated: false
        });
    });

    it('restricts the content search to files matching the patterns', async () => {
        await expect(fileGlob({ patterns: ['*.ts'], content: 'TODO' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/b.ts', line: 1, text: '// TODO: two' },
                { path: 'task/e.ts', line: 1, text: '// TODO: five' }
            ],
            truncated: false
        });
    });

    it('treats content as a JavaScript regular expression', async () => {
        await expect(fileGlob({ content: 'TODO: (one|three)' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three' }
            ],
            truncated: false
        });
    });

    it('caps matches globally and flags truncation', async () => {
        await expect(fileGlob({ content: 'TODO', maxResults: 2 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four' },
                { path: 'root.txt', line: 1, text: 'TODO: six' }
            ],
            truncated: true
        });
    });

    it('clamps maxResults to the hard cap without claiming truncation', async () => {
        // 6 matches exist; asking for 1_000 must not exceed the documented cap and
        // must not claim truncation when everything fits.
        await expect(fileGlob({ content: 'TODO', maxResults: 1000 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four' },
                { path: 'root.txt', line: 1, text: 'TODO: six' },
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/b.ts', line: 1, text: '// TODO: two' },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three' },
                { path: 'task/e.ts', line: 1, text: '// TODO: five' }
            ],
            truncated: false
        });
    });

    it('returns an empty match list when nothing matches', async () => {
        await expect(fileGlob({ content: 'ZZZ' })).resolves.toEqual({
            matches: [],
            truncated: false
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
            matches: [{ path: 'src/a.ts', line: 2, text: '// TODO: one' }],
            truncated: false
        });

        // The same request rooted at "." alone produces the identical path, which is
        // what makes the dedupe invisible to a caller that lists one root.
        await expect(fileGlob({ content: 'TODO: one', paths: ['.'] })).resolves.toEqual({
            matches: [{ path: 'src/a.ts', line: 2, text: '// TODO: one' }],
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
