// fileRead — the batched read contract (T14).
//
// What this pins:
//   - ONE call reads several files and returns an ordered [{ path, content }]
//     array, in the caller's order;
//   - `path` is the ABSOLUTE resolved path, so two relative spellings of the same
//     file are still identifiable;
//   - the schema declares exactly one array property (`paths`), so the harness's
//     single-property rule hands `execute` the array itself — which is what makes
//     a direct call and a model call identical;
//   - a missing/unreadable path, a directory, a blank/NUL/non-string entry, or an
//     empty array rejects the WHOLE call: there is no partial array, because a
//     short answer that looks complete would let a model conclude a file it never
//     received is empty.
//
// Fixtures are real files under the repo-root `Temp/` (never OS temp), one unique
// directory per run, removed afterwards. Module-relative so the location does not
// depend on the cwd Vitest was started from — the same convention as
// server/environment.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { fileRead } from './fileRead';

// Repo-root Temp/ (six levels up from src/tools/files/: files -> tools -> src ->
// harness -> underload -> packages -> repo root).
const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

const seed = async (relativePath: string, content: string): Promise<string> => {
    const path = join(workdir, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
    return path;
};

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-read-'));

    // Exact contents, including a CRLF file and an empty file, so the assertions
    // below are literal rather than "whatever happened to be on disk".
    await seed('a.txt', 'alpha\n');
    await seed('b.txt', 'beta\n');
    await seed('nested/c.txt', 'gamma');
    await seed('crlf.txt', 'one\r\ntwo\r\n');
    await seed('empty.txt', '');
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('fileRead', () => {
    it('reads several files in one call, in the caller order', async () => {
        const result = await fileRead([join(workdir, 'b.txt'), join(workdir, 'a.txt')]);

        expect(result).toEqual([
            { path: join(workdir, 'b.txt'), content: 'beta\n' },
            { path: join(workdir, 'a.txt'), content: 'alpha\n' }
        ]);
    });

    it('resolves relative paths and reports the absolute path', async () => {
        const previous = process.cwd();
        process.chdir(workdir);

        try {
            await expect(fileRead(['a.txt', 'nested/c.txt'])).resolves.toEqual([
                { path: resolve('a.txt'), content: 'alpha\n' },
                { path: resolve('nested/c.txt'), content: 'gamma' }
            ]);
        } finally {
            process.chdir(previous);
        }
    });

    it('returns file text byte-for-byte, including CRLF and an empty file', async () => {
        await expect(fileRead([join(workdir, 'crlf.txt'), join(workdir, 'empty.txt')])).resolves.toEqual([
            { path: join(workdir, 'crlf.txt'), content: 'one\r\ntwo\r\n' },
            { path: join(workdir, 'empty.txt'), content: '' }
        ]);
    });

    it('rejects the whole call when a later path is missing', async () => {
        // No partial array: the first file exists, but a truncated answer that
        // looks complete would be worse than an error.
        await expect(fileRead([join(workdir, 'a.txt'), join(workdir, 'missing.txt')])).rejects.toThrow(
            /ENOENT/
        );
    });

    it('rejects a directory path', async () => {
        // A directory read fails at the filesystem layer (EISDIR on POSIX, EPERM on Windows), so the
        // whole batch is rejected rather than returning directory "content".
        await expect(fileRead([join(workdir, 'nested')])).rejects.toThrow();
    });

    it('rejects an empty array instead of answering "no files"', async () => {
        await expect(fileRead([])).rejects.toThrow(
            'fileRead received an empty paths array; pass at least one file path.'
        );
    });

    it('rejects blank, NUL, non-string, and non-array arguments', async () => {
        await expect(fileRead([''])).rejects.toThrow('fileRead paths must be non-empty strings.');
        await expect(fileRead([join(workdir, 'a.txt'), ''])).rejects.toThrow(
            'fileRead paths must be non-empty strings.'
        );
        await expect(fileRead(['a\u0000b'])).rejects.toThrow(
            'fileRead paths must not contain NUL characters.'
        );
        await expect(fileRead([7] as never)).rejects.toThrow('fileRead paths must be non-empty strings.');
        // A model that sends a bare string instead of an array is told the shape.
        await expect(fileRead('a.txt' as never)).rejects.toThrow(
            'fileRead expects an array of paths, e.g. ["package.json"].'
        );
    });

    it('declares a single "paths" array property, so the harness unwraps to the array', () => {
        expect(fileRead.parameters).toEqual({
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Files to read, absolute or relative to the working directory, in the order the results are returned.'
                }
            },
            required: ['paths'],
            additionalProperties: false
        });
        expect(toolParameterKey(fileRead.parameters)).toBe('paths');
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        await expect(fileRead.execute({ parameters: [join(workdir, 'a.txt')] })).resolves.toEqual([
            { path: join(workdir, 'a.txt'), content: 'alpha\n' }
        ]);
    });
});
