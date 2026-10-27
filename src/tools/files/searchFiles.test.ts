// searchFiles — bounded, regex-based content search.
//
// The fixture tree is deliberately adversarial: a .git directory, a node_modules
// package, a binary file, and nested sources all contain the needle. Only the
// regular source/doc files may appear, and the assertions are the full result
// object, including walk order, so a skip-list regression fails loudly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchFiles } from './searchFiles';

let workdir: string;

const seed = async (relativePath: string, content: string): Promise<void> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
};

beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'underload-search-files-'));

    // Skipped by the walker.
    await seed('.git/secret.ts', '// TODO: hidden\n');
    await seed('node_modules/pkg/index.js', '// TODO: ignored\n');

    // Skipped as binary (contains a NUL byte).
    await seed('binary.bin', 'TODO\u0000binary\n');

    // Searchable.
    await seed('docs/readme.md', 'TODO: four\n');
    await seed('src/a.ts', 'const x = 1;\n// TODO: one\n');
    await seed('src/b.ts', '// TODO: two\n');
    await seed('src/nested/c.js', 'TODO: three\n');
    await seed('src/nested/deep/d.ts', 'no match here\n');
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('searchFiles', () => {
    it('returns every non-skipped match in lexicographic walk order', async () => {
        const result = await searchFiles({ pattern: 'TODO', path: workdir });

        expect(result).toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four' },
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/b.ts', line: 1, text: '// TODO: two' },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three' }
            ],
            truncated: false
        });
    });

    it('honours the include glob against paths and file names', async () => {
        await expect(searchFiles({ pattern: 'TODO', path: workdir, include: '*.ts' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/b.ts', line: 1, text: '// TODO: two' }
            ],
            truncated: false
        });

        await expect(searchFiles({ pattern: 'TODO', path: workdir, include: 'src/**/*.ts' })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/b.ts', line: 1, text: '// TODO: two' }
            ],
            truncated: false
        });
    });

    it('reports paths relative to the search root', async () => {
        await expect(searchFiles({ pattern: 'TODO', path: join(workdir, 'src') })).resolves.toEqual({
            matches: [
                { path: 'a.ts', line: 2, text: '// TODO: one' },
                { path: 'b.ts', line: 1, text: '// TODO: two' },
                { path: 'nested/c.js', line: 1, text: 'TODO: three' }
            ],
            truncated: false
        });
    });

    it('treats the pattern as a regular expression', async () => {
        await expect(searchFiles({ pattern: 'TODO: (one|three)', path: workdir })).resolves.toEqual({
            matches: [
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three' }
            ],
            truncated: false
        });
    });

    it('caps results and flags truncation', async () => {
        await expect(searchFiles({ pattern: 'TODO', path: workdir, maxResults: 2 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four' },
                { path: 'src/a.ts', line: 2, text: '// TODO: one' }
            ],
            truncated: true
        });
    });

    it('clamps maxResults to the hard cap', async () => {
        // 4 matches exist; asking for 1_000 must not exceed the documented cap and
        // must not claim truncation when everything fits.
        await expect(searchFiles({ pattern: 'TODO', path: workdir, maxResults: 1000 })).resolves.toEqual({
            matches: [
                { path: 'docs/readme.md', line: 1, text: 'TODO: four' },
                { path: 'src/a.ts', line: 2, text: '// TODO: one' },
                { path: 'src/b.ts', line: 1, text: '// TODO: two' },
                { path: 'src/nested/c.js', line: 1, text: 'TODO: three' }
            ],
            truncated: false
        });
    });

    it('returns an empty result when nothing matches', async () => {
        await expect(searchFiles({ pattern: 'ZZZ', path: workdir })).resolves.toEqual({
            matches: [],
            truncated: false
        });
    });

    it('surfaces an invalid regular expression', async () => {
        await expect(searchFiles({ pattern: '[', path: workdir })).rejects.toThrow(SyntaxError);
    });

    it('surfaces a missing search root', async () => {
        await expect(searchFiles({ pattern: 'TODO', path: join(workdir, 'absent') })).rejects.toThrow();
    });
});
