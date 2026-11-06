// files — the path-level manager: list, move, copy, delete, mkdir.
//
// What this pins:
//   - the SCHEMA is one array property (`ops`) whose items carry an explicit `op`
//     discriminator — the batching rule holds, and the mode is a required field, never
//     the presence of a property (that was the `fileGlob` mistake);
//   - LIST keeps `fileList`'s presentation contract exactly: caller-prefixed entries,
//     "/" on directories, code-point order, a bounded page resumable by `nextOffset`,
//     and one shared 64 KiB entry-text budget ACROSS the call's list operations;
//   - a list failure is that entry's own `error` (read's rule), while a failing
//     MUTATION rejects the call and names the operations already applied — no rollback
//     is claimed, because there is none;
//   - destination policy is decided by the tool, not by the platform: `overwrite`
//     gates replace-vs-EEXIST, `recursive` gates a non-empty directory, and `force`
//     turns a missing delete into a reported no-op;
//   - operations run IN CALLER ORDER against the filesystem as each one finds it, so a
//     rename followed by a delete of the new name works (state is checked at the op's
//     turn, not in a pre-flight sweep);
//   - mutations take the same per-file locks ./lock.ts gives ./write and ./edit, so a
//     concurrent write cannot be clobbered by a delete of the same path.
//
// Fixtures are real files under the repo-root `Temp/`, one unique directory per run,
// removed afterwards (module-relative, same convention as ./write.test.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile as readTextFile, readdir, rm, writeFile as writeTextFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { fileLockCount } from './lock';
import { FILES_CONTENT_BUDGET, FILES_MAX_OPS, files, metadata, registration } from './files.tool';
import { edit } from './edit.tool';
import { write } from './write.tool';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;

// Receipts report posix separators on every platform (./fileList's rule), so a fixture
// path is compared in that same form.
const posix = (value: string): string => value.split(sep).join('/');

const seed = async (path: string, content: string): Promise<string> => {
    const target = join(workdir, path);

    await mkdir(join(target, '..'), { recursive: true });
    await writeTextFile(target, content, 'utf8');

    return target;
};

const dir = async (path: string): Promise<string> => {
    const target = join(workdir, path);

    await mkdir(target, { recursive: true });

    return target;
};

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-files-'));
    // The tool resolves every path against the process working directory (no sandbox,
    // same as ./write and ./list), so the relative spellings this suite pins are read
    // relative to the fixture, not to the package source tree.
    previousCwd = process.cwd();
    process.chdir(workdir);
});

afterAll(async () => {
    process.chdir(previousCwd);
    await rm(workdir, { recursive: true, force: true });
});

describe('files metadata', () => {
    it('publishes the wire name, the single ops property, and fileList catalogue slot', () => {
        expect(metadata.name).toBe('files');
        expect(metadata.parameters.type).toBe('object');
        expect(Object.keys((metadata.parameters.properties ?? {}) as object)).toEqual(['ops']);
        expect(metadata.parameters.required).toEqual(['ops']);
        expect(metadata.parameters.additionalProperties).toBe(false);
        // One array property => the single-property rule hands `execute` the array.
        expect(toolParameterKey(metadata.parameters)).toBe('ops');
        // ./fileList's order 200 is inherited, so descriptor order (and every derived
        // core/searchable projection) is unchanged by the replacement.
        expect(registration).toMatchObject({ group: 'preset', activation: 'always', order: 200 });
        // Searchable, like the listing it replaced: never declared, always discoverable.
        expect('visibility' in metadata).toBe(false);
        expect(files.visibility).toBe('searchable');
        expect(files.name).toBe('files');
    });

    it('names every operation in the discriminator, and nothing else', () => {
        const properties = metadata.parameters.properties as {
            ops: { maxItems: number; items: { required: string[]; properties: Record<string, { enum?: string[] }> } };
        };

        expect(properties.ops.maxItems).toBe(FILES_MAX_OPS);
        expect(properties.ops.items.required).toEqual(['op']);
        expect(properties.ops.items.properties.op.enum).toEqual(['list', 'move', 'copy', 'delete', 'mkdir']);
    });

    it('publishes the operations as tags so toolRequest answers a move/delete query', () => {
        // The tool is found by the capability words a caller reaches for, and still by
        // the `files`/`list` tags `fileList` was found by.
        for (const tag of ['files', 'list', 'filesystem', 'move', 'rename', 'copy', 'delete', 'remove', 'mkdir']) {
            expect(files.tags).toContain(tag);
        }
    });
});

describe('files list', () => {
    it('answers one bounded page with fileList presentation rules', async () => {
        await dir('listing');
        await seed('listing/b.txt', 'b');
        await seed('listing/a.txt', 'a');
        await dir('listing/zeta');

        const result = await files([{ op: 'list', path: 'listing' }]);

        // Prefixed with the caller's own spelling, directories end with "/", and the
        // sort is by code point (a deterministic page boundary, not a locale one).
        expect(result.results[0]).toEqual({
            op: 'list',
            path: 'listing',
            entries: ['listing/a.txt', 'listing/b.txt', 'listing/zeta/'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 'listing/a.txt'.length + 'listing/b.txt'.length + 'listing/zeta/'.length
        });
        // The envelope totals what the call charged against the shared budget.
        expect(result).toEqual({
            results: [result.results[0]],
            bytes: (result.results[0] as { bytes: number }).bytes,
            contentBudget: FILES_CONTENT_BUDGET
        });
    });

    it('defaults to the working directory and contributes no prefix', async () => {
        const empty = await dir('default-empty');
        const previous = process.cwd();
        process.chdir(empty);

        try {
            await writeTextFile('marker.txt', 'm', 'utf8');

            const omitted = await files([{ op: 'list' }]);
            const explicit = await files([{ op: 'list', path: '.' }]);

            expect(omitted.results[0].path).toBe('.');
            expect(omitted.results[0].entries).toEqual(['marker.txt']);
            // Omitted and explicit "." are the same request.
            expect(explicit).toEqual(omitted);
        } finally {
            process.chdir(previous);
        }
    });

    it('pages a flat sequence with no gaps and no duplicates', async () => {
        await dir('paged');

        for (let index = 0; index < 10; index += 1) {
            await seed(`paged/file-${index}.txt`, 'x');
        }

        const first = await files([{ op: 'list', path: 'paged', limit: 4 }]);
        const second = await files([{ op: 'list', path: 'paged', offset: first.results[0].nextOffset as number, limit: 4 }]);
        const third = await files([{ op: 'list', path: 'paged', offset: second.results[0].nextOffset as number, limit: 4 }]);

        expect(first.results[0].entries).toHaveLength(4);
        expect(first.results[0].truncated).toBe(true);
        expect(first.results[0].nextOffset).toBe(4);
        expect(second.results[0].nextOffset).toBe(8);
        // The last page is short and says the sequence ended, so a caller can stop.
        expect(third.results[0].entries).toHaveLength(2);
        expect(third.results[0].truncated).toBe(false);
        expect(third.results[0].nextOffset).toBeNull();

        const walked = [...first.results[0].entries!, ...second.results[0].entries!, ...third.results[0].entries!];

        expect(new Set(walked).size).toBe(10);
        expect(walked[0]).toBe('paged/file-0.txt');
    });

    it('lists several directories as one sequence, grouped in caller order', async () => {
        await seed('group-b/second.txt', 'b');
        await seed('group-a/first.txt', 'a');

        const result = await files([{ op: 'list', path: ['group-b', 'group-a'] }]);

        // Directories are never re-sorted: the grouping the caller asked for IS the order,
        // which is what makes `offset` mean the same thing on every page.
        expect(result.results[0].entries).toEqual(['group-b/second.txt', 'group-a/first.txt']);
        expect(result.results[0].path).toBe('group-b');
    });

    it('shares one byte budget across the list operations of a call', async () => {
        await dir('budget/a');
        await dir('budget/b');
        await seed('budget/a/file.txt', 'a');
        await seed('budget/b/file.txt', 'b');

        const result = await files([
            { op: 'list', path: 'budget/a' },
            { op: 'list', path: 'budget/b' }
        ]);

        // Both pages fit, so both are reported; the envelope totals the bytes charged.
        expect(result.results.map((entry) => entry.entries)).toEqual([['budget/a/file.txt'], ['budget/b/file.txt']]);
        expect(result.bytes).toBe(result.results.reduce((total, entry) => total + (entry.bytes ?? 0), 0));
        expect(result.contentBudget).toBe(FILES_CONTENT_BUDGET);
    });

    it('reports a missing directory as that entry error and keeps the other answers', async () => {
        await seed('present/one.txt', 'x');

        const result = await files([
            { op: 'list', path: 'present' },
            { op: 'list', path: 'no-such-directory' }
        ]);

        expect(result.results[0].entries).toEqual(['present/one.txt']);
        expect(result.results[1].error?.code).toBe('ENOENT');
        // A read-only miss must not throw away the rest of the call's answer.
        expect(result.results[1].entries).toEqual([]);
    });

    it('reports a file named to list as an ENOTDIR entry error', async () => {
        const target = await seed('not-a-dir.txt', 'x');

        const result = await files([{ op: 'list', path: 'not-a-dir.txt' }]);

        expect(result.results[0].error?.code).toBe('ENOTDIR');
        // The message names the path it tried to read, so the fix is obvious.
        expect(result.results[0].error?.message).toContain(posix(target));
    });

    it('refuses a list path array that is empty instead of answering with nothing', async () => {
        // `[]` would read as "this directory is empty"; the default is the caller's cwd.
        await expect(files([{ op: 'list', path: [] }])).rejects.toThrow(/empty "path" array/);
    });
});

describe('files mkdir', () => {
    it('creates missing parents and reports the second call as already done', async () => {
        const result = await files([{ op: 'mkdir', path: 'deep/a/b' }, { op: 'mkdir', path: 'deep/a/b' }]);

        expect(result.results[0]).toEqual({ op: 'mkdir', path: posix(join(workdir, 'deep/a/b')), created: true });
        // "The state you asked for already holds" is a success, not an error.
        expect(result.results[1].created).toBe(false);

        const entries = await readdir(join(workdir, 'deep/a'));

        expect(entries).toEqual(['b']);
    });

    it('refuses to mkdir over an existing file', async () => {
        await seed('occupied.txt', 'x');

        await expect(files([{ op: 'mkdir', path: 'occupied.txt' }])).rejects.toThrow(/is a file, not a directory/);
    });
});

describe('files move and copy', () => {
    it('renames a file, creates the destination parents, and reports both paths', async () => {
        await seed('rename/source.txt', 'hello');

        const result = await files([{ op: 'move', from: 'rename/source.txt', to: 'rename/nested/target.txt' }]);

        expect(result.results[0]).toEqual({
            op: 'move',
            path: posix(join(workdir, 'rename/source.txt')),
            to: posix(join(workdir, 'rename/nested/target.txt')),
            kind: 'file',
            bytes: 5
        });
        expect(await readdir(join(workdir, 'rename'))).toEqual(['nested']);
        expect(await readTextFile(join(workdir, 'rename/nested/target.txt'), 'utf8')).toBe('hello');
    });

    it('refuses an existing destination unless overwrite is set, and reports what ran', async () => {
        await seed('clash/free.txt', 'new');
        await seed('clash/taken.txt', 'old');

        await expect(files([{ op: 'move', from: 'clash/free.txt', to: 'clash/taken.txt' }])).rejects.toThrow(
            /already exists\. Pass overwrite: true/
        );
        // The refusal is honest about the partial batch it did not undo.
        await expect(files([
            { op: 'mkdir', path: 'clash/made' },
            { op: 'move', from: 'clash/free.txt', to: 'clash/taken.txt' }
        ])).rejects.toThrow(/Operations already applied: mkdir .*clash\/made\. No rollback was performed\./);

        // Nothing moved: the source is still where the caller left it. (readdir order is
        // not specified, so the comparison sorts.)
        expect((await readdir(join(workdir, 'clash'))).sort()).toEqual(['free.txt', 'made', 'taken.txt']);

        const forced = await files([{ op: 'move', from: 'clash/free.txt', to: 'clash/taken.txt', overwrite: true }]);

        expect(forced.results[0].to).toBe(posix(join(workdir, 'clash/taken.txt')));
        expect(await readTextFile(join(workdir, 'clash/taken.txt'), 'utf8')).toBe('new');
    });

    it('copies a file and leaves the source alone', async () => {
        await seed('copy/source.txt', 'payload');

        const result = await files([{ op: 'copy', from: 'copy/source.txt', to: 'copy/copy.txt' }]);

        expect(result.results[0]).toEqual({
            op: 'copy',
            path: posix(join(workdir, 'copy/source.txt')),
            to: posix(join(workdir, 'copy/copy.txt')),
            kind: 'file',
            bytes: 7
        });
        expect((await readdir(join(workdir, 'copy'))).sort()).toEqual(['copy.txt', 'source.txt']);
    });

    it('copies a directory tree and reports the bytes it wrote', async () => {
        await seed('tree/a.txt', 'aaa');
        await seed('tree/nested/b.txt', 'bb');

        const result = await files([{ op: 'copy', from: 'tree', to: 'tree-copy' }]);

        expect(result.results[0].kind).toBe('directory');
        // A copy writes bytes, so the number is the walked sum (3 + 2).
        expect(result.results[0].bytes).toBe(5);
        expect(await readTextFile(join(workdir, 'tree-copy/nested/b.txt'), 'utf8')).toBe('bb');

        // A directory MOVE is a rename: nothing is written, so it says so.
        const moved = await files([{ op: 'move', from: 'tree-copy', to: 'tree-moved' }]);

        expect(moved.results[0]).toMatchObject({ kind: 'directory', bytes: 0 });
        expect((await readdir(join(workdir, 'tree-moved'))).sort()).toEqual(['a.txt', 'nested']);
    });

    it('refuses to copy a missing source', async () => {
        await expect(files([{ op: 'copy', from: 'nowhere.txt', to: 'somewhere.txt' }])).rejects.toThrow(
            /source .* does not exist/
        );
    });
});

describe('files delete', () => {
    it('removes a file', async () => {
        await seed('drop/gone.txt', 'x');

        const result = await files([{ op: 'delete', path: 'drop/gone.txt' }]);

        expect(result.results[0]).toEqual({
            op: 'delete',
            path: posix(join(workdir, 'drop/gone.txt')),
            removed: true,
            recursive: false
        });
        expect(await readdir(join(workdir, 'drop'))).toEqual([]);
    });

    it('refuses a missing path, and answers force with a reported no-op', async () => {
        await expect(files([{ op: 'delete', path: 'never-existed.txt' }])).rejects.toThrow(
            /does not exist\. Pass force: true/
        );

        const forced = await files([{ op: 'delete', path: 'never-existed.txt', force: true }]);

        expect(forced.results[0]).toMatchObject({ removed: false, skipped: true });
    });

    it('refuses a non-empty directory without recursive, and takes the tree with it', async () => {
        await seed('whole/inner.txt', 'x');

        await expect(files([{ op: 'delete', path: 'whole' }])).rejects.toThrow(
            /is a directory\. Pass recursive: true/
        );

        const removed = await files([{ op: 'delete', path: 'whole', recursive: true }]);

        expect(removed.results[0]).toMatchObject({ removed: true, recursive: true });
        expect(await readdir(join(workdir, 'whole')).catch(() => [])).toEqual([]);
    });
});

describe('files ordering and failure domain', () => {
    it('applies operations in caller order against the state each one finds', async () => {
        await seed('chain/original.txt', 'chained');

        const result = await files([
            { op: 'move', from: 'chain/original.txt', to: 'chain/renamed.txt' },
            { op: 'delete', path: 'chain/renamed.txt' }
        ]);

        // A pre-flight existence sweep would have called the delete a missing path. The
        // harness runs one message's tool calls CONCURRENTLY, so this in-call order is
        // the only place a rename-then-delete can be sequenced.
        expect(result.results.map((entry) => entry.op)).toEqual(['move', 'delete']);
        expect(result.results[1].removed).toBe(true);
        expect(await readdir(join(workdir, 'chain'))).toEqual([]);
    });

    it('rejects the whole call before touching anything when an entry is malformed', async () => {
        await seed('preflight/keep.txt', 'untouched');

        await expect(
            files([{ op: 'delete', path: 'preflight/keep.txt' }, { op: 'move', from: 'preflight/keep.txt' }])
        ).rejects.toThrow(/move requires a non-empty "to"/);

        // Nothing ran: a bad entry cannot leave a half-applied refactor.
        expect(await readdir(join(workdir, 'preflight'))).toEqual(['keep.txt']);
    });

    it('rejects fields that belong to another operation', async () => {
        // Silently ignoring `{ op: 'delete', to: 'x' }` would delete a file the caller
        // believed it was renaming.
        await expect(files([{ op: 'delete', path: 'preflight/keep.txt', to: 'somewhere' }])).rejects.toThrow(
            /delete does not accept "to"/
        );
    });

    it('rejects a request that is not a usable array of operations', async () => {
        await expect(files([] as never)).rejects.toThrow(/empty ops array/);
        await expect(files('listing' as never)).rejects.toThrow(/expects an array/);
        await expect(
            files(Array.from({ length: FILES_MAX_OPS + 1 }, () => ({ op: 'mkdir' as const, path: 'x' })) as never)
        ).rejects.toThrow(/at most 100 operations/);
        await expect(files([{ op: 'list', limit: '20' } as never])).rejects.toThrow(/"limit" must be a number/);
        await expect(files([{ op: 'list', path: 'a\u0000b' }])).rejects.toThrow(/NUL/);
    });

    it('clamps an oversized page limit instead of rejecting it', async () => {
        await dir('clamp');

        const result = await files([{ op: 'list', path: 'clamp', limit: 5000 }]);

        // Asking for 5000 entries means "as much as allowed"; 1000 is the honest answer.
        expect(result.results[0].limit).toBe(1000);
    });
});

describe('files with the other write-side tools', () => {
    it('never leaves a file lock behind', async () => {
        await seed('lock/a.txt', 'x');
        await files([{ op: 'list', path: 'lock' }, { op: 'move', from: 'lock/a.txt', to: 'lock/b.txt' }]);

        // ./lock.ts drops the map entry once the last holder releases it; a leak here
        // would mean this tool queues behind work that already finished.
        expect(fileLockCount()).toBe(0);
    });

    it('serializes against a concurrent write and edit of the same path', async () => {
        const target = await seed('race/target.txt', 'R0');
        const copy = join(workdir, 'race/copy.txt');

        // Three callers, one file, launched at once: exactly what one assistant message
        // with several tool calls does (../../harness.ts launches the batch CONCURRENTLY,
        // so there is no order between separate calls to rely on).
        const outcomes = await Promise.allSettled([
            write([{ path: target, content: 'R1' }]),
            edit([{ path: target, oldString: 'R1', newString: 'R2' }]),
            files([{ op: 'copy', from: target, to: copy, overwrite: true }])
        ]);

        // Whichever order the event loop chose, the three critical sections never
        // overlapped. `write` always lands, so the file ends in one of the two COMPLETE
        // states it can hold — never a torn or lost value.
        expect(outcomes[0].status).toBe('fulfilled');

        const final = await readTextFile(target, 'utf8');
        const copied = await readTextFile(copy, 'utf8');

        expect(['R1', 'R2']).toContain(final);
        // The copy may have run before or after the write, but it always saw ONE whole
        // state, which is the D4 guarantee this lock exists to provide.
        expect(['R0', 'R1', 'R2']).toContain(copied);

        // An `edit` that queued behind the write sees 'R1' and succeeds; one that ran
        // first fails honestly ("no match") instead of clobbering a change it never saw.
        if (outcomes[1].status === 'fulfilled') {
            expect(final).toBe('R2');
        }

        expect(fileLockCount()).toBe(0);
    });
});
