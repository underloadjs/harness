// fileList — the directory-array contract (T12, renamed in T14).
//
// What this pins:
//   - one call lists several directories, grouped in the CALLER's order;
//   - every result is prefixed with the directory it came from, so two `index.ts`
//     files in one flat list stay distinguishable;
//   - directories keep the trailing "/" and each listing is sorted by code point
//     (locale-independent), which is why "B.ts" sorts before "a.ts";
//   - "." adds no prefix, so the default `["."]` still returns bare entry names;
//   - an explicit empty array is rejected instead of answering `[]` (an empty
//     result would read as "the directory is empty");
//   - the traversal stays NON-recursive: a child directory appears as "child/",
//     never as its contents. Recursion is fileGlob's job;
//   - a missing directory rejects the whole call instead of returning a partial
//     list, and blank/NUL/non-string entries are rejected before touching disk.
//
// Fixtures are real directories under the repo-root `Temp/` (never OS temp), one
// unique directory per run, removed afterwards. Module-relative so the location
// does not depend on the cwd Vitest was started from — the same convention as
// server/environment.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { fileList } from './fileList';

// Repo-root Temp/ (six levels up from src/tools/files/).
const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;

// Every fixture is seeded once in beforeAll, so each expected array below is a
// fixed literal rather than "whatever readdir happened to return".
const seed = async (relativePath: string, content = 'x\n'): Promise<void> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
};

beforeAll(async () => {
    previousCwd = process.cwd();
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-list-'));
    // chdir keeps the relative-directory assertions (and the default paths) about
    // the fixture tree, never about the repository.
    process.chdir(workdir);

    // Two sibling roots, each with a child directory so the trailing-slash
    // convention is visible next to a file entry.
    await seed('src/a.ts');
    await seed('src/B.ts');
    await seed('src/nested/deep/c.ts');
    await seed('task/b.ts');
    await seed('task/work/notes.md');
    await seed('root.txt');
});

afterAll(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
});

describe('fileList', () => {
    it('lists several directories in one call, prefixed and grouped', async () => {
        // Code-point order: "B.ts" < "a.ts" < "nested/" (uppercase first), and the
        // second directory's entries follow the first directory's whole listing.
        await expect(fileList(['src', 'task'])).resolves.toEqual([
            'src/B.ts',
            'src/a.ts',
            'src/nested/',
            'task/b.ts',
            'task/work/'
        ]);
    });

    it('follows the caller order rather than sorting the directories', async () => {
        await expect(fileList(['task', 'src'])).resolves.toEqual([
            'task/b.ts',
            'task/work/',
            'src/B.ts',
            'src/a.ts',
            'src/nested/'
        ]);
    });

    it('stays non-recursive: a child directory is one entry, not a walk', async () => {
        const entries = await fileList(['src']);

        expect(entries).toEqual(['src/B.ts', 'src/a.ts', 'src/nested/']);
        // The grandchild file under src/nested/deep is never listed.
        expect(entries).not.toContain('src/nested/deep/');
        expect(entries).not.toContain('src/nested/deep/c.ts');
    });

    it('defaults to the working directory and adds no prefix for "."', async () => {
        await expect(fileList(undefined)).resolves.toEqual(['root.txt', 'src/', 'task/']);
        // Omitted and explicit ["."] are the same request.
        await expect(fileList(['.'])).resolves.toEqual(['root.txt', 'src/', 'task/']);
    });

    it('normalizes a redundant "./" and a trailing slash on the requested directory', async () => {
        // join() collapses both forms, so the prefix never doubles a separator.
        await expect(fileList(['./task'])).resolves.toEqual(['task/b.ts', 'task/work/']);
        await expect(fileList(['task/'])).resolves.toEqual(['task/b.ts', 'task/work/']);
    });

    it('accepts a bare string for a single directory (direct-call convenience)', async () => {
        await expect(fileList('task')).resolves.toEqual(['task/b.ts', 'task/work/']);
    });

    it('rejects an explicit empty array instead of answering "nothing here"', async () => {
        // An empty result would read as "the directory is empty"; the error names
        // the fix (omit `paths` to list the working directory).
        await expect(fileList([])).rejects.toThrow(
            'fileList received an empty paths array. Omit paths to list the working directory.'
        );
    });

    it('rejects the whole call when one directory is missing', async () => {
        // No partial listing: the first directory exists, but a truncated answer
        // that looks complete would be worse than an error.
        await expect(fileList(['src', 'missing'])).rejects.toThrow(/ENOENT/);
    });

    it('rejects blank, NUL, and non-string entries before touching disk', async () => {
        await expect(fileList([''])).rejects.toThrow('fileList paths must be non-empty strings.');
        await expect(fileList(['src', ''])).rejects.toThrow('fileList paths must be non-empty strings.');
        await expect(fileList(['sr\u0000c'])).rejects.toThrow(
            'fileList paths must not contain NUL characters.'
        );
        await expect(fileList([7] as never)).rejects.toThrow('fileList paths must be non-empty strings.');
    });

    it('declares a single "paths" array property, so the harness unwraps to the array', () => {
        // The model sends {"paths": ["src","task"]}; the single-property rule hands
        // execute the array itself, which is exactly what a direct call passes.
        expect(fileList.parameters).toEqual({
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Directories to list, absolute or relative to the working directory, in the order the results are grouped. Defaults to ["."].'
                }
            },
            additionalProperties: false
        });
        expect(toolParameterKey(fileList.parameters)).toBe('paths');
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        await expect(fileList.execute({ parameters: ['src'] })).resolves.toEqual([
            'src/B.ts',
            'src/a.ts',
            'src/nested/'
        ]);
    });
});
