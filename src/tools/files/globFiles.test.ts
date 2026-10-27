// globFiles — path matching, skip list, ordering, and caps.
//
// Same adversarial tree as searchFiles. Assertions are full result objects so the
// lexicographic order (and therefore which items a cap keeps) is pinned.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globFiles } from './globFiles';
import { globToRegExp, matchGlob } from './glob';

let workdir: string;

const seed = async (relativePath: string, content = 'x\n'): Promise<void> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
};

beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'underload-glob-files-'));

    await seed('.git/secret.ts');
    await seed('node_modules/pkg/index.js');
    await seed('binary.bin');
    await seed('docs/readme.md');
    await seed('src/a.ts');
    await seed('src/b.ts');
    await seed('src/nested/c.js');
    await seed('src/nested/deep/d.ts');
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('globFiles', () => {
    it('finds every file for ** without entering skipped directories', async () => {
        await expect(globFiles({ pattern: '**', path: workdir })).resolves.toEqual({
            files: [
                'binary.bin',
                'docs/readme.md',
                'src/a.ts',
                'src/b.ts',
                'src/nested/c.js',
                'src/nested/deep/d.ts'
            ],
            truncated: false
        });
    });

    it('matches a pattern without a slash against file names at any depth', async () => {
        await expect(globFiles({ pattern: '*.ts', path: workdir })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts'],
            truncated: false
        });
    });

    it('matches a slash pattern against the relative path', async () => {
        await expect(globFiles({ pattern: 'src/**/*.js', path: workdir })).resolves.toEqual({
            files: ['src/nested/c.js'],
            truncated: false
        });

        await expect(globFiles({ pattern: 'src/*.ts', path: workdir })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts'],
            truncated: false
        });
    });

    it('reports paths relative to the search root', async () => {
        await expect(globFiles({ pattern: '**/*.ts', path: join(workdir, 'src') })).resolves.toEqual({
            files: ['a.ts', 'b.ts', 'nested/deep/d.ts'],
            truncated: false
        });
    });

    it('caps results in lexicographic order and flags truncation', async () => {
        await expect(globFiles({ pattern: '**', path: workdir, maxResults: 2 })).resolves.toEqual({
            files: ['binary.bin', 'docs/readme.md'],
            truncated: true
        });
    });

    it('does not claim truncation when the cap is not reached', async () => {
        await expect(globFiles({ pattern: '*.ts', path: workdir, maxResults: 3 })).resolves.toEqual({
            files: ['src/a.ts', 'src/b.ts', 'src/nested/deep/d.ts'],
            truncated: false
        });
    });

    it('surfaces a missing search root', async () => {
        await expect(globFiles({ pattern: '**', path: join(workdir, 'absent') })).rejects.toThrow();
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
