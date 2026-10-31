// fileWrite — the batched write contract (T14).
//
// What this pins:
//   - ONE call writes several files and returns an ordered [{ path, bytes }]
//     array, in the caller's order, with the ABSOLUTE path and the UTF-8 byte size;
//   - parent directories are created and an existing file is overwritten;
//   - the schema declares exactly one array property (`files`), so the harness's
//     single-property rule hands `execute` the array itself;
//   - the WHOLE batch is validated and every target resolved (and deduplicated by
//     FILE IDENTITY — T16: Windows case aliases and symlink aliases are one file,
//     Linux `a.txt`/`A.txt` are two) BEFORE the first write, so a bad entry in the
//     last position leaves the first file untouched;
//   - a filesystem error part-way through is reported honestly: the completed paths
//     are named and there is no claim of a transaction or rollback.
//
// Fixtures are real files under the repo-root `Temp/`, one unique directory per
// run, removed afterwards (module-relative, same convention as fileRead.test.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    mkdir,
    mkdtemp,
    readFile as readTextFile,
    rm,
    symlink,
    writeFile as writeTextFile
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { fileWrite } from './fileWrite.tool';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-write-'));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('fileWrite', () => {
    it('writes several files in one call, creating parents, and reports exact bytes', async () => {
        const first = join(workdir, 'batch', 'one.txt');
        const second = join(workdir, 'batch', 'deep', 'two.md');

        const result = await fileWrite([
            { path: first, content: 'one\n' },
            { path: second, content: 'héllo' }
        ]);

        // "héllo" is 6 UTF-8 bytes (é is two), which is the point of asserting the
        // number instead of the string length.
        expect(result).toEqual([
            { path: first, bytes: 4 },
            { path: second, bytes: 6 }
        ]);
        await expect(readTextFile(first, 'utf8')).resolves.toBe('one\n');
        await expect(readTextFile(second, 'utf8')).resolves.toBe('héllo');
    });

    it('overwrites an existing file and accepts empty content as a truncation', async () => {
        const target = join(workdir, 'overwrite.txt');
        await writeTextFile(target, 'first', 'utf8');

        await expect(fileWrite([{ path: target, content: 'second' }])).resolves.toEqual([
            { path: target, bytes: 6 }
        ]);
        await expect(readTextFile(target, 'utf8')).resolves.toBe('second');

        await expect(fileWrite([{ path: target, content: '' }])).resolves.toEqual([
            { path: target, bytes: 0 }
        ]);
        await expect(readTextFile(target, 'utf8')).resolves.toBe('');
    });

    it('resolves relative paths against the working directory', async () => {
        const previous = process.cwd();
        process.chdir(workdir);

        try {
            await expect(fileWrite([{ path: 'relative.txt', content: 'x' }])).resolves.toEqual([
                { path: resolve('relative.txt'), bytes: 1 }
            ]);
            await expect(readTextFile(resolve('relative.txt'), 'utf8')).resolves.toBe('x');
        } finally {
            process.chdir(previous);
        }
    });

    it('rejects the whole batch before writing when a later entry is invalid', async () => {
        const first = join(workdir, 'preflight', 'first.txt');

        await expect(
            fileWrite([
                { path: first, content: 'should not exist' },
                { path: '', content: 'x' }
            ])
        ).rejects.toThrow('fileWrite files require a non-empty "path" string.');

        // Preflight means the valid first entry was never written.
        await expect(readTextFile(first, 'utf8')).rejects.toThrow();
    });

    it('rejects the same resolved target twice, including an aliased spelling', async () => {
        const target = join(workdir, 'duplicate.txt');

        await expect(
            fileWrite([
                { path: target, content: 'one' },
                { path: join(workdir, '.', 'duplicate.txt'), content: 'two' }
            ])
        ).rejects.toThrow(
            `fileWrite received the same target path twice (${target}); write each file once per call.`
        );

        // Nothing was written by the rejected batch.
        await expect(readTextFile(target, 'utf8')).rejects.toThrow();
    });

    it('rejects a batch whose two spellings are one file on this platform', async () => {
        // T16: uniqueness is by FILE IDENTITY, not by the resolved string. On
        // Windows "aliases.txt" and "ALIASES.TXT" are ONE file, so the batch must be
        // rejected before the first write; on Linux they are two files and the batch
        // is legitimate. The fixture is created for both cases, so each branch
        // asserts the true behaviour of this host instead of skipping.
        const lower = join(workdir, 'aliases.txt');
        const upper = join(workdir, 'ALIASES.TXT');
        await writeTextFile(lower, 'first', 'utf8');

        if (process.platform === 'win32') {
            await expect(
                fileWrite([
                    { path: lower, content: 'one' },
                    { path: upper, content: 'two' }
                ])
            ).rejects.toThrow(
                `fileWrite received the same target path twice (${upper}); write each file once per call.`
            );

            // Preflight means the first entry never ran: the file keeps its text.
            await expect(readTextFile(lower, 'utf8')).resolves.toBe('first');
            return;
        }

        // Linux: two distinct files, so both are written and both are reported.
        await expect(
            fileWrite([
                { path: lower, content: 'one' },
                { path: upper, content: 'two' }
            ])
        ).resolves.toEqual([
            { path: lower, bytes: 3 },
            { path: upper, bytes: 3 }
        ]);
        await expect(readTextFile(lower, 'utf8')).resolves.toBe('one');
        await expect(readTextFile(upper, 'utf8')).resolves.toBe('two');
    });

    it('rejects two spellings of a not-yet-created file', async () => {
        // A new target has no realpath, so the identity comes from the nearest
        // existing ancestor plus the missing segments. Both spellings below name the
        // same file on EVERY platform, so this needs no platform branch.
        const plain = join(workdir, 'fresh', 'new.txt');
        const dotted = join(workdir, 'fresh', '.', 'new.txt');

        await expect(
            fileWrite([
                { path: plain, content: 'one' },
                { path: dotted, content: 'two' }
            ])
        ).rejects.toThrow(
            `fileWrite received the same target path twice (${dotted}); write each file once per call.`
        );

        await expect(readTextFile(plain, 'utf8')).rejects.toThrow();
    });

    it('rejects a second spelling that reaches the target through a symlink', async () => {
        // A symlinked parent is a different string but the same file. Creating the
        // link is privileged on Windows (Developer Mode or elevated), so the guard
        // is the ability to create it, not the platform name.
        const real = join(workdir, 'linked', 'target.txt');
        await mkdir(join(workdir, 'linked'), { recursive: true });
        await writeTextFile(real, 'original', 'utf8');

        const alias = join(workdir, 'linked-alias');

        try {
            await symlink(join(workdir, 'linked'), alias, 'dir');
        } catch {
            // No symlink privilege on this host: nothing to prove here.
            await expect(readTextFile(real, 'utf8')).resolves.toBe('original');
            return;
        }

        const throughLink = join(alias, 'target.txt');

        await expect(
            fileWrite([
                { path: real, content: 'one' },
                { path: throughLink, content: 'two' }
            ])
        ).rejects.toThrow(
            `fileWrite received the same target path twice (${throughLink}); write each file once per call.`
        );

        await expect(readTextFile(real, 'utf8')).resolves.toBe('original');
    });

    it('rejects an empty array, a non-array, and malformed entries', async () => {
        await expect(fileWrite([])).rejects.toThrow(
            'fileWrite received an empty files array; pass at least one entry.'
        );
        await expect(fileWrite('a.txt' as never)).rejects.toThrow(
            'fileWrite expects an array of { path, content } entries, e.g. [{"path":"a.txt","content":"hi"}].'
        );
        await expect(fileWrite([null] as never)).rejects.toThrow(
            'fileWrite files must be objects with "path" and "content" strings.'
        );
        await expect(fileWrite([{ path: 'a.txt' }] as never)).rejects.toThrow(
            'fileWrite files require a "content" string.'
        );
        await expect(fileWrite([{ path: 'a\u0000b', content: 'x' }])).rejects.toThrow(
            'fileWrite paths must not contain NUL characters.'
        );
    });

    it('rejects NUL content in preflight, without creating the earlier valid entry', async () => {
        // A NUL byte is the harness's own binary marker, so a file containing one is
        // rejected by fileRead. Writing it would create an artifact this package
        // cannot read back; the whole batch is refused before the first write.
        const untouched = join(workdir, 'nul', 'first.txt');
        const rejected = join(workdir, 'nul', 'second.txt');

        await expect(
            fileWrite([
                { path: untouched, content: 'fine' },
                { path: rejected, content: 'a\u0000b' }
            ])
        ).rejects.toThrow(
            `fileWrite content must not contain NUL characters (${rejected}): the file would be unreadable by fileRead, which rejects binary content.`
        );

        // Proof that the rejection happened in preflight, not mid-batch: the valid
        // first entry was NOT written either, so no side effect exists.
        await expect(readTextFile(untouched, 'utf8')).rejects.toThrow(/ENOENT/);
        await expect(readTextFile(rejected, 'utf8')).rejects.toThrow(/ENOENT/);
    });

    it('reports the completed paths when a later write fails, with no rollback claim', async () => {
        const completed = join(workdir, 'partial', 'completed.txt');
        // A regular FILE where the second target needs a parent directory: mkdir
        // fails with ENOTDIR/EEXIST deterministically on every platform.
        const blocker = join(workdir, 'partial', 'blocker');
        await mkdir(join(workdir, 'partial'), { recursive: true });
        await writeTextFile(blocker, 'not a directory', 'utf8');

        const failing = join(blocker, 'child.txt');

        await expect(
            fileWrite([
                { path: completed, content: 'written' },
                { path: failing, content: 'never' }
            ])
        ).rejects.toThrow(
            new RegExp(
                `^fileWrite failed on ${escapeRegExp(failing)}: .* Writes already completed: ${escapeRegExp(
                    completed
                )}\\. No rollback was performed\\.$`
            )
        );

        // The first file really is on disk: the message is the truth, not a guess.
        await expect(readTextFile(completed, 'utf8')).resolves.toBe('written');
    });

    it('declares a single "files" array property of { path, content } objects', () => {
        expect(fileWrite.parameters).toEqual({
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description: 'Path to the file, absolute or relative to the working directory.'
                            },
                            content: {
                                type: 'string',
                                description: 'Full text to write. Replaces the previous contents.'
                            }
                        },
                        required: ['path', 'content'],
                        additionalProperties: false
                    },
                    description: 'Files to write, in the order the results are returned.'
                }
            },
            required: ['files'],
            additionalProperties: false
        });
        expect(toolParameterKey(fileWrite.parameters)).toBe('files');
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        const target = join(workdir, 'execute-path.txt');

        await expect(fileWrite.execute({ parameters: [{ path: target, content: 'ok' }] })).resolves.toEqual([
            { path: target, bytes: 2 }
        ]);
    });
});

// A path interpolated into a RegExp needs its Windows separators and dots escaped.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
