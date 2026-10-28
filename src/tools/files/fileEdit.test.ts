// fileEdit — exact, batched replacement semantics (T14).
//
// Runs against real files in a temporary directory under the repo-root `Temp/`,
// using absolute paths so it never chdir's. Every assertion is the full result
// array or the exact resulting file text: the tool's value is the guarantee that
// an ambiguous edit cannot happen and that a bad entry in a batch changes nothing,
// so a partial assert would test nothing.
//
// The batch guarantees are the new part:
//   - all edits are validated and every resolved target must be unique BEFORE any
//     read;
//   - every file is then read and match-checked BEFORE the first write, so a
//     failure on the LAST entry leaves the FIRST file untouched;
//   - the result is ordered and reports replacements + resulting byte size.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    mkdir,
    mkdtemp,
    readFile as readTextFile,
    rm,
    symlink,
    writeFile as writeTextFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { HarnessError } from '../../util';
import { fileEdit } from './fileEdit';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

const seed = async (name: string, content: string): Promise<string> => {
    const path = join(workdir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeTextFile(path, content, 'utf8');
    return path;
};

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-edit-'));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('fileEdit', () => {
    it('replaces a unique match in one entry and reports the exact result', async () => {
        const path = await seed('unique.txt', 'x alpha y\n');

        const result = await fileEdit([{ path, oldString: 'alpha', newString: 'beta' }]);

        expect(result).toEqual([{ path, replacements: 1, bytes: Buffer.byteLength('x beta y\n', 'utf8') }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('x beta y\n');
    });

    it('applies several edits in one call, in the caller order', async () => {
        const first = await seed('batch/a.txt', 'one\n');
        const second = await seed('batch/b.txt', 'two\n');

        const result = await fileEdit([
            { path: second, oldString: 'two', newString: 'TWO' },
            { path: first, oldString: 'one', newString: 'ONE' }
        ]);

        expect(result).toEqual([
            { path: second, replacements: 1, bytes: Buffer.byteLength('TWO\n', 'utf8') },
            { path: first, replacements: 1, bytes: Buffer.byteLength('ONE\n', 'utf8') }
        ]);
        await expect(readTextFile(first, 'utf8')).resolves.toBe('ONE\n');
        await expect(readTextFile(second, 'utf8')).resolves.toBe('TWO\n');
    });

    it('refuses an ambiguous match and leaves the file untouched', async () => {
        const path = await seed('ambiguous.txt', 'a a a\n');

        await expect(fileEdit([{ path, oldString: 'a', newString: 'b' }])).rejects.toThrow(
            new HarnessError(
                `fileEdit found 3 matches for oldString in ${path}. Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('a a a\n');
    });

    it('replaces every occurrence when replaceAll is set', async () => {
        const path = await seed('all.txt', 'a a a\n');

        const result = await fileEdit([{ path, oldString: 'a', newString: 'bb', replaceAll: true }]);

        expect(result).toEqual([
            { path, replacements: 3, bytes: Buffer.byteLength('bb bb bb\n', 'utf8') }
        ]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('bb bb bb\n');
    });

    it('deletes text when newString is empty', async () => {
        const path = await seed('delete.txt', 'keep REMOVE keep\n');

        const result = await fileEdit([{ path, oldString: ' REMOVE', newString: '' }]);

        expect(result).toEqual([
            { path, replacements: 1, bytes: Buffer.byteLength('keep keep\n', 'utf8') }
        ]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('keep keep\n');
    });

    it('writes replacement text literally, without $-substitution', async () => {
        const path = await seed('literal.txt', 'price 10\n');

        await fileEdit([{ path, oldString: '10', newString: '$& $1 $`' }]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('price $& $1 $`\n');
    });

    it('rejects a missing match', async () => {
        const path = await seed('missing.txt', 'nothing here\n');

        await expect(fileEdit([{ path, oldString: 'absent', newString: 'x' }])).rejects.toThrow(
            new HarnessError(
                `fileEdit found no match for oldString in ${path}. Read the file first and copy the text exactly, including indentation.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('nothing here\n');
    });

    it('leaves every earlier file untouched when a later edit does not match', async () => {
        // This is the whole reason batching is safe: the preflight reads and
        // match-checks ALL entries before the first write.
        const first = await seed('preflight/a.txt', 'alpha\n');
        const second = await seed('preflight/b.txt', 'beta\n');

        await expect(
            fileEdit([
                { path: first, oldString: 'alpha', newString: 'ALPHA' },
                { path: second, oldString: 'absent', newString: 'x' }
            ])
        ).rejects.toThrow(new RegExp(`fileEdit found no match for oldString in ${escapeRegExp(second)}`));

        await expect(readTextFile(first, 'utf8')).resolves.toBe('alpha\n');
        await expect(readTextFile(second, 'utf8')).resolves.toBe('beta\n');
    });

    it('rejects the same resolved target twice before reading anything', async () => {
        const path = await seed('duplicate.txt', 'same\n');

        await expect(
            fileEdit([
                { path, oldString: 'same', newString: 'one' },
                { path: join(workdir, '.', 'duplicate.txt'), oldString: 'same', newString: 'two' }
            ])
        ).rejects.toThrow(
            `fileEdit received the same target path twice (${path}); make one edit per file per call.`
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('same\n');
    });

    it('rejects two spellings of one file, judged by this platform', async () => {
        // T16: the duplicate check uses FILE IDENTITY, so on Windows
        // "alias.txt"/"ALIAS.TXT" are one file and the batch is rejected before the
        // file is even read; on Linux they are two files and both edits apply.
        const lower = await seed('alias.txt', 'same\n');
        const upper = join(workdir, 'ALIAS.TXT');

        if (process.platform === 'win32') {
            await expect(
                fileEdit([
                    { path: lower, oldString: 'same', newString: 'one' },
                    { path: upper, oldString: 'same', newString: 'two' }
                ])
            ).rejects.toThrow(
                `fileEdit received the same target path twice (${upper}); make one edit per file per call.`
            );

            await expect(readTextFile(lower, 'utf8')).resolves.toBe('same\n');
            return;
        }

        const other = await seed('ALIAS.TXT', 'other\n');

        await expect(
            fileEdit([
                { path: lower, oldString: 'same', newString: 'one' },
                { path: other, oldString: 'other', newString: 'two' }
            ])
        ).resolves.toEqual([
            { path: lower, replacements: 1, bytes: Buffer.byteLength('one\n', 'utf8') },
            { path: other, replacements: 1, bytes: Buffer.byteLength('two\n', 'utf8') }
        ]);
        await expect(readTextFile(lower, 'utf8')).resolves.toBe('one\n');
        await expect(readTextFile(other, 'utf8')).resolves.toBe('two\n');
    });

    it('rejects a second spelling that reaches the file through a symlink', async () => {
        // Creating a symlink is privileged on Windows (Developer Mode or elevated),
        // so the guard is "could we create it", not the platform name.
        const real = await seed('linked/target.txt', 'original\n');
        const alias = join(workdir, 'linked-alias');

        try {
            await symlink(join(workdir, 'linked'), alias, 'dir');
        } catch {
            await expect(readTextFile(real, 'utf8')).resolves.toBe('original\n');
            return;
        }

        const throughLink = join(alias, 'target.txt');

        await expect(
            fileEdit([
                { path: real, oldString: 'original', newString: 'one' },
                { path: throughLink, oldString: 'original', newString: 'two' }
            ])
        ).rejects.toThrow(
            `fileEdit received the same target path twice (${throughLink}); make one edit per file per call.`
        );

        await expect(readTextFile(real, 'utf8')).resolves.toBe('original\n');
    });

    it('rejects an empty oldString, a no-op edit, and a non-boolean replaceAll', async () => {
        const path = await seed('validation.txt', 'text\n');

        await expect(fileEdit([{ path, oldString: '', newString: 'x' }])).rejects.toThrow(
            new HarnessError('fileEdit requires a non-empty oldString.')
        );
        await expect(fileEdit([{ path, oldString: 'text', newString: 'text' }])).rejects.toThrow(
            new HarnessError('fileEdit did not change the file: oldString and newString are identical.')
        );
        await expect(
            fileEdit([{ path, oldString: 'text', newString: 'x', replaceAll: 'yes' as never }])
        ).rejects.toThrow(new HarnessError('fileEdit replaceAll must be a boolean when provided.'));
        await expect(readTextFile(path, 'utf8')).resolves.toBe('text\n');
    });

    it('rejects an empty array, a non-array, and malformed entries', async () => {
        await expect(fileEdit([])).rejects.toThrow(
            'fileEdit received an empty edits array; pass at least one edit.'
        );
        await expect(fileEdit('a.txt' as never)).rejects.toThrow(
            'fileEdit expects an array of { path, oldString, newString } entries, e.g. [{"path":"a.txt","oldString":"a","newString":"b"}].'
        );
        await expect(fileEdit([null] as never)).rejects.toThrow(
            'fileEdit edits must be objects with "path", "oldString", and "newString" strings.'
        );
        await expect(fileEdit([{ path: 'a.txt', oldString: 'a' }] as never)).rejects.toThrow(
            'fileEdit requires a "newString" string.'
        );
        await expect(
            fileEdit([{ path: 'a\u0000b', oldString: 'a', newString: 'b' }])
        ).rejects.toThrow('fileEdit paths must not contain NUL characters.');
        await expect(fileEdit([{ path: '', oldString: 'a', newString: 'b' }])).rejects.toThrow(
            'fileEdit edits require a non-empty "path" string.'
        );
    });

    it('does not create a file that is missing', async () => {
        const path = join(workdir, 'absent', 'new.txt');

        await expect(fileEdit([{ path, oldString: 'a', newString: 'b' }])).rejects.toThrow();
        await expect(readTextFile(path, 'utf8')).rejects.toThrow();
    });

    it('declares a single "edits" array property of { path, oldString, newString, replaceAll? }', () => {
        expect(fileEdit.parameters).toEqual({
            type: 'object',
            properties: {
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description:
                                    'Path to an existing file, absolute or relative to the working directory.'
                            },
                            oldString: {
                                type: 'string',
                                description: 'Exact text to replace. Must be unique unless replaceAll is true.'
                            },
                            newString: {
                                type: 'string',
                                description: 'Replacement text. May be empty to delete the matched text.'
                            },
                            replaceAll: {
                                type: 'boolean',
                                description:
                                    'Replace every occurrence instead of requiring oldString to be unique. Defaults to false.'
                            }
                        },
                        required: ['path', 'oldString', 'newString'],
                        additionalProperties: false
                    },
                    description: 'Edits to apply, one per file, in the order the results are returned.'
                }
            },
            required: ['edits'],
            additionalProperties: false
        });
        expect(toolParameterKey(fileEdit.parameters)).toBe('edits');
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        const path = await seed('execute-path.txt', 'before\n');

        await expect(
            fileEdit.execute({ parameters: [{ path, oldString: 'before', newString: 'after' }] })
        ).resolves.toEqual([{ path, replacements: 1, bytes: Buffer.byteLength('after\n', 'utf8') }]);
    });
});

// A path interpolated into a RegExp needs its Windows separators and dots escaped.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
