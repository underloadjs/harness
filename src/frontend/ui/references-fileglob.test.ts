// Real fileGlob schema check for the @ mention patterns (T8).
//
// The composer calls the REAL `/tools/fileGlob` tool. Mocking the pattern string is
// not enough: `**/src/frontend*` looks plausible but matches no descendant file
// because `*` never crosses `/`. This test runs the actual tool against a
// disposable tree under the repo-root Temp directory and asserts the exact files.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/references-fileglob.test.ts

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { fileGlob } from '../../tools/files/fileGlob';
import { fileGlobPattern } from './references';

// Locate the repo root regardless of whether vitest runs from the package root
// (npm run test:frontend) or the workspace root. Scratch always stays in root Temp.
const REPO_ROOT =
    [
        process.cwd(),
        resolve(process.cwd(), '../../..'),
        resolve(process.cwd(), '../../../..'),
        resolve(process.cwd(), '../../../../..')
    ].find((candidate) => existsSync(join(candidate, 'packages', 'underload', 'harness', 'package.json'))) ??
    process.cwd();
const TEMP_ROOT = join(REPO_ROOT, 'Temp');

let root: string;

const relativeFiles = (files: readonly string[]): string[] =>
    files.map((file) => relative(root, file).replace(/\\/g, '/')).sort();

beforeEach(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    root = await mkdtemp(join(TEMP_ROOT, 't8-fileglob-'));

    const files = [
        'README.md',
        'src/backend/private.ts',
        'src/frontend/main.ts',
        'src/frontend/ui/deep.ts',
        'src/frontend-extra/other.ts'
    ];

    for (const path of files) {
        const full = join(root, ...path.split('/'));
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, 'x', 'utf8');
    }
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

it('matches descendants of a path-prefix directory with the real fileGlob', async () => {
    const expected = [
        'src/frontend-extra/other.ts',
        'src/frontend/main.ts',
        'src/frontend/ui/deep.ts'
    ];

    const result = await fileGlob({
        patterns: fileGlobPattern('src/frontend'),
        paths: [root],
        maxResults: 100
    });
    expect(relativeFiles(result.files)).toEqual(expected);
    expect(result.truncated).toBe(false);

    // The typed forms `@./src/frontend` and `@.\src\frontend` produce the SAME walk.
    for (const query of ['./src/frontend', '.\\src\\frontend']) {
        const normalized = await fileGlob({
            patterns: fileGlobPattern(query),
            paths: [root],
            maxResults: 100
        });
        expect(relativeFiles(normalized.files)).toEqual(expected);
    }
});

it('still searches by basename and matches the empty overview', async () => {
    const byName = await fileGlob({
        patterns: fileGlobPattern('main'),
        paths: [root],
        maxResults: 100
    });
    expect(relativeFiles(byName.files)).toEqual(['src/frontend/main.ts']);

    const overview = await fileGlob({
        patterns: fileGlobPattern(''),
        paths: [root],
        maxResults: 100
    });
    expect(relativeFiles(overview.files)).toEqual([
        'README.md',
        'src/backend/private.ts',
        'src/frontend-extra/other.ts',
        'src/frontend/main.ts',
        'src/frontend/ui/deep.ts'
    ]);
});
