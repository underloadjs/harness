// edit — exact, batched replacement semantics (T14).
//
// Runs against real files in a temporary directory under the repo-root `Temp/`,
// using absolute paths so it never chdir's. Every assertion is the full result
// array or the exact resulting file text: the tool's value is the guarantee that
// an ambiguous edit cannot happen and that a bad entry in a batch changes nothing,
// so a partial assert would test nothing.
//
// The batch guarantees are the new part:
//   - every edit is validated (shape, non-empty oldString, distinct strings, no NUL)
//     BEFORE any read;
//   - entries are grouped by FILE IDENTITY (./identity.ts), so several entries may
//     name one file — the same path twice, two case spellings on Windows, or a
//     symlink alias on any platform. They are applied in ARRAY order, each matched
//     against the text the previous one produced;
//   - every file is then read and match-checked BEFORE the first write, so a
//     failure on the LAST entry leaves the FIRST file untouched, and each distinct
//     file is written exactly ONCE with its final text;
//   - the result is one entry per requested edit, in request order, naming the path
//     that entry asked for and reporting replacements + the file's final byte size
//     (entries sharing a file therefore report the same size).

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
import { edit } from './edit.tool';

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

describe('edit', () => {
    it('replaces a unique match in one entry and reports the exact result', async () => {
        const path = await seed('unique.txt', 'x alpha y\n');

        const result = await edit([{ path, oldString: 'alpha', newString: 'beta' }]);

        expect(result).toEqual([{ path, replacements: 1, bytes: Buffer.byteLength('x beta y\n', 'utf8') }]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('x beta y\n');
    });

    it('applies several edits in one call, in the caller order', async () => {
        const first = await seed('batch/a.txt', 'one\n');
        const second = await seed('batch/b.txt', 'two\n');

        const result = await edit([
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

        await expect(edit([{ path, oldString: 'a', newString: 'b' }])).rejects.toThrow(
            new HarnessError(
                `edit found 3 matches for oldString in ${path} (lines 1, 1, 1). Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('a a a\n');
    });

    it('replaces every occurrence when replaceAll is set', async () => {
        const path = await seed('all.txt', 'a a a\n');

        const result = await edit([{ path, oldString: 'a', newString: 'bb', replaceAll: true }]);

        expect(result).toEqual([
            { path, replacements: 3, bytes: Buffer.byteLength('bb bb bb\n', 'utf8') }
        ]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('bb bb bb\n');
    });

    it('deletes text when newString is empty', async () => {
        const path = await seed('delete.txt', 'keep REMOVE keep\n');

        const result = await edit([{ path, oldString: ' REMOVE', newString: '' }]);

        expect(result).toEqual([
            { path, replacements: 1, bytes: Buffer.byteLength('keep keep\n', 'utf8') }
        ]);
        await expect(readTextFile(path, 'utf8')).resolves.toBe('keep keep\n');
    });

    it('writes replacement text literally, without $-substitution', async () => {
        const path = await seed('literal.txt', 'price 10\n');

        await edit([{ path, oldString: '10', newString: '$& $1 $`' }]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('price $& $1 $`\n');
    });

    it('rejects a missing match', async () => {
        const path = await seed('missing.txt', 'nothing here\n');

        await expect(edit([{ path, oldString: 'absent', newString: 'x' }])).rejects.toThrow(
            new HarnessError(
                `edit found no match for oldString in ${path}. Read the file first and copy the text exactly, including indentation.`
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
            edit([
                { path: first, oldString: 'alpha', newString: 'ALPHA' },
                { path: second, oldString: 'absent', newString: 'x' }
            ])
        ).rejects.toThrow(new RegExp(`edit found no match for oldString in ${escapeRegExp(second)}`));

        await expect(readTextFile(first, 'utf8')).resolves.toBe('alpha\n');
        await expect(readTextFile(second, 'utf8')).resolves.toBe('beta\n');
    });

    it('applies several entries that name one file, in array order', async () => {
        // CURRENT contract: one edit per file is no longer a rule. Two entries may name
        // the same file, they are applied in ARRAY order, each matched against the text
        // the previous one produced, and the file is written ONCE with the final text.
        // (Aligned with the shipped implementation; an earlier revision rejected the
        // batch outright.)
        const path = await seed('duplicate.txt', 'alpha\nbeta\n');

        await expect(
            edit([
                { path, oldString: 'alpha', newString: 'one' },
                { path: join(workdir, '.', 'duplicate.txt'), oldString: 'beta', newString: 'two' }
            ])
        // `bytes` is reported per file IDENTITY (the file's size once the batch ran),
        // so both entries naming one file carry the same count.
        ).resolves.toEqual([
            { path, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') },
            { path, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') }
        ]);

        await expect(readTextFile(path, 'utf8')).resolves.toBe('one\ntwo\n');
    });

    it('treats two spellings of one file as one file, judged by this platform', async () => {
        // T16 judged duplicitous spellings by FILE IDENTITY. CURRENT contract keeps that
        // identity judgement but no longer rejects the batch: on Windows
        // "alias.txt"/"ALIAS.TXT" are the SAME file, so both entries are applied to it in
        // array order (each result naming the path that entry asked for), while on Linux
        // they are two files and both edits apply.
        const lower = await seed('alias.txt', 'alpha\nbeta\n');
        const upper = join(workdir, 'ALIAS.TXT');

        if (process.platform === 'win32') {
            await expect(
                edit([
                    { path: lower, oldString: 'alpha', newString: 'one' },
                    { path: upper, oldString: 'beta', newString: 'two' }
                ])
            ).resolves.toEqual([
                // Same file, so the same final byte count on both entries; each still
                // names the path that entry asked for.
                { path: lower, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') },
                { path: upper, replacements: 1, bytes: Buffer.byteLength('one\ntwo\n', 'utf8') }
            ]);

            await expect(readTextFile(lower, 'utf8')).resolves.toBe('one\ntwo\n');
            return;
        }

        // Linux keeps the two spellings apart, so `other` below is a SECOND file: both
        // entries then name different identities and each result reports the bytes of
        // the file that entry named. `lower` still holds the text seeded above, so its
        // oldString comes from that text.
        const other = await seed('ALIAS.TXT', 'other\n');

        await expect(
            edit([
                { path: lower, oldString: 'alpha', newString: 'one' },
                { path: other, oldString: 'other', newString: 'two' }
            ])
        ).resolves.toEqual([
            { path: lower, replacements: 1, bytes: Buffer.byteLength('one\nbeta\n', 'utf8') },
            { path: other, replacements: 1, bytes: Buffer.byteLength('two\n', 'utf8') }
        ]);
        await expect(readTextFile(lower, 'utf8')).resolves.toBe('one\nbeta\n');
        await expect(readTextFile(other, 'utf8')).resolves.toBe('two\n');
    });

    it('applies two spellings that reach one file through a symlink as one file', async () => {
        // Creating a symlink is privileged on Windows (Developer Mode or elevated),
        // so the guard is "could we create it", not the platform name. Where the link
        // cannot be created there is nothing to prove, so the fixture is asserted
        // untouched and the case ends.
        //
        // CURRENT contract (T20): a symlink alias is no longer a rejected duplicate.
        // realpath() collapses `linked/target.txt` and `linked-alias/target.txt` onto
        // one identity (./identity.ts), so both entries are ONE file, applied in array
        // order, written once.
        const real = await seed('linked/target.txt', 'alpha\nbeta\n');
        const alias = join(workdir, 'linked-alias');

        try {
            await symlink(join(workdir, 'linked'), alias, 'dir');
        } catch {
            await expect(readTextFile(real, 'utf8')).resolves.toBe('alpha\nbeta\n');
            return;
        }

        const throughLink = join(alias, 'target.txt');

        await expect(
            edit([
                { path: real, oldString: 'alpha', newString: 'one' },
                // 'one\nbeta' exists only in the text the FIRST entry produced, so
                // matching it through the alias proves the two spellings are one file
                // with a defined order rather than two independent writes.
                { path: throughLink, oldString: 'one\nbeta', newString: 'two' }
            ])
        ).resolves.toEqual([
            // One identity, so one final byte count carried by both entries; each entry
            // still names the path it asked for (identity is for comparing, never for
            // reporting).
            { path: real, replacements: 1, bytes: Buffer.byteLength('two\n', 'utf8') },
            { path: throughLink, replacements: 1, bytes: Buffer.byteLength('two\n', 'utf8') }
        ]);

        // Written exactly once, through the first-appearance spelling; reading through
        // the alias shows the same bytes, so no second file appeared beside it.
        await expect(readTextFile(real, 'utf8')).resolves.toBe('two\n');
        await expect(readTextFile(throughLink, 'utf8')).resolves.toBe('two\n');
    });

    it('rejects an empty oldString, a no-op edit, and a non-boolean replaceAll', async () => {
        const path = await seed('validation.txt', 'text\n');

        await expect(edit([{ path, oldString: '', newString: 'x' }])).rejects.toThrow(
            new HarnessError('edit requires a non-empty oldString.')
        );
        await expect(edit([{ path, oldString: 'text', newString: 'text' }])).rejects.toThrow(
            new HarnessError('edit did not change the file: oldString and newString are identical.')
        );
        await expect(
            edit([{ path, oldString: 'text', newString: 'x', replaceAll: 'yes' as never }])
        ).rejects.toThrow(new HarnessError('edit replaceAll must be a boolean when provided.'));
        await expect(readTextFile(path, 'utf8')).resolves.toBe('text\n');
    });

    it('rejects an empty array, a non-array, and malformed entries', async () => {
        await expect(edit([])).rejects.toThrow(
            'edit received an empty edits array; pass at least one edit.'
        );
        await expect(edit('a.txt' as never)).rejects.toThrow(
            'edit expects an array of { path, oldString, newString } entries, e.g. [{"path":"a.txt","oldString":"a","newString":"b"}].'
        );
        await expect(edit([null] as never)).rejects.toThrow(
            'edit edits must be objects with "path", "oldString", and "newString" strings.'
        );
        await expect(edit([{ path: 'a.txt', oldString: 'a' }] as never)).rejects.toThrow(
            'edit requires a "newString" string.'
        );
        await expect(
            edit([{ path: 'a\u0000b', oldString: 'a', newString: 'b' }])
        ).rejects.toThrow('edit paths must not contain NUL characters.');
        await expect(edit([{ path: '', oldString: 'a', newString: 'b' }])).rejects.toThrow(
            'edit edits require a non-empty "path" string.'
        );
    });

    it('does not create a file that is missing', async () => {
        const path = join(workdir, 'absent', 'new.txt');

        await expect(edit([{ path, oldString: 'a', newString: 'b' }])).rejects.toThrow();
        await expect(readTextFile(path, 'utf8')).rejects.toThrow();
    });

    it('declares a single "edits" array property of { path, oldString, newString, replaceAll? }', () => {
        expect(edit.parameters).toEqual({
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
                    description:
                        'Edits to apply, in the order the results are returned. Several entries may name the same file; they are applied in array order.'
                }
            },
            required: ['edits'],
            additionalProperties: false
        });
        expect(toolParameterKey(edit.parameters)).toBe('edits');
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        const path = await seed('execute-path.txt', 'before\n');

        await expect(
            edit.execute({ parameters: [{ path, oldString: 'before', newString: 'after' }] })
        ).resolves.toEqual([{ path, replacements: 1, bytes: Buffer.byteLength('after\n', 'utf8') }]);
    });
});

// A path interpolated into a RegExp needs its Windows separators and dots escaped.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
