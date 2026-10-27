// editFile — exact replacement semantics.
//
// Runs against real files in a temporary directory, using absolute paths so it
// never chdir's (other test files may run in the same process). Every assertion is
// the full result object or the exact resulting file text: the tool's value is the
// guarantee that an ambiguous edit cannot happen, so a partial assert would test
// nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile as readTextFile, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFile } from './editFile';
import { HarnessError } from '../../util';

let workdir: string;

beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'underload-edit-file-'));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('editFile', () => {
    it('replaces a unique match and reports the exact result', async () => {
        const path = join(workdir, 'unique.txt');
        await writeTextFile(path, 'x alpha y\n', 'utf8');

        const result = await editFile({ path, oldString: 'alpha', newString: 'beta' });

        expect(result).toEqual({
            path,
            replacements: 1,
            bytes: Buffer.byteLength('x beta y\n', 'utf8')
        });
        await expect(readTextFile(path, 'utf8')).resolves.toBe('x beta y\n');
    });

    it('refuses an ambiguous match and leaves the file untouched', async () => {
        const path = join(workdir, 'ambiguous.txt');
        await writeTextFile(path, 'a a a\n', 'utf8');

        await expect(editFile({ path, oldString: 'a', newString: 'b' })).rejects.toThrow(
            new HarnessError(
                `editFile found 3 matches for oldString in ${path}. Include more surrounding text to make it unique, or pass replaceAll: true to change every match.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('a a a\n');
    });

    it('replaces every occurrence when replaceAll is set', async () => {
        const path = join(workdir, 'all.txt');
        await writeTextFile(path, 'a a a\n', 'utf8');

        const result = await editFile({ path, oldString: 'a', newString: 'bb', replaceAll: true });

        expect(result).toEqual({ path, replacements: 3, bytes: Buffer.byteLength('bb bb bb\n', 'utf8') });
        await expect(readTextFile(path, 'utf8')).resolves.toBe('bb bb bb\n');
    });

    it('deletes text when newString is empty', async () => {
        const path = join(workdir, 'delete.txt');
        await writeTextFile(path, 'keep REMOVE keep\n', 'utf8');

        const result = await editFile({ path, oldString: ' REMOVE', newString: '' });

        expect(result).toEqual({ path, replacements: 1, bytes: Buffer.byteLength('keep keep\n', 'utf8') });
        await expect(readTextFile(path, 'utf8')).resolves.toBe('keep keep\n');
    });

    it('writes replacement text literally, without $-substitution', async () => {
        const path = join(workdir, 'literal.txt');
        await writeTextFile(path, 'price 10\n', 'utf8');

        await editFile({ path, oldString: '10', newString: '$& $1 $`' });

        await expect(readTextFile(path, 'utf8')).resolves.toBe('price $& $1 $`\n');
    });

    it('rejects a missing match', async () => {
        const path = join(workdir, 'missing.txt');
        await writeTextFile(path, 'nothing here\n', 'utf8');

        await expect(editFile({ path, oldString: 'absent', newString: 'x' })).rejects.toThrow(
            new HarnessError(
                `editFile found no match for oldString in ${path}. Read the file first and copy the text exactly, including indentation.`
            )
        );
        await expect(readTextFile(path, 'utf8')).resolves.toBe('nothing here\n');
    });

    it('rejects an empty oldString', async () => {
        const path = join(workdir, 'empty-old.txt');
        await writeTextFile(path, 'text\n', 'utf8');

        await expect(editFile({ path, oldString: '', newString: 'x' })).rejects.toThrow(
            new HarnessError('editFile requires a non-empty oldString.')
        );
    });

    it('rejects a no-op edit', async () => {
        const path = join(workdir, 'noop.txt');
        await writeTextFile(path, 'same\n', 'utf8');

        await expect(editFile({ path, oldString: 'same', newString: 'same' })).rejects.toThrow(
            new HarnessError('editFile did not change the file: oldString and newString are identical.')
        );
    });

    it('does not create a file that is missing', async () => {
        const path = join(workdir, 'absent', 'new.txt');

        await expect(editFile({ path, oldString: 'a', newString: 'b' })).rejects.toThrow();
        await expect(readTextFile(path, 'utf8')).rejects.toThrow();
    });
});
