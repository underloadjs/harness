// files — the path-level manager: list, move, copy, delete, mkdir.
//
// What this pins:
//   - the SCHEMA is one array property (`ops`) whose items carry an explicit `op`
//     discriminator — the batching rule holds, and the mode is a required field, never
//     the presence of a property (that was the `fileGlob` mistake);
//   - LIST keeps `fileList`'s presentation contract exactly: caller-prefixed entries,
//     "/" on directories (including a symlink that resolves to one), code-point order, a
//     bounded page resumable by `nextOffset`, and one shared 64 KiB entry-text budget
//     ACROSS the call's list operations — charged from one mutable allowance, so a later
//     op is cut (down to an empty page that still reports its own cursor) rather than
//     getting a fresh 64 KiB;
//   - a list path naming one directory several ways walks it ONCE (compared by real
//     identity, ./identity.ts), and one directory that cannot be read costs only itself:
//     the listings already collected survive, and the failure is that entry's own
//     `error` naming the directory it tried to read (read's rule);
//   - the machine `code` of a list error is from the published set only; any other raw
//     errno (ENAMETOOLONG, ELOOP, …) folds to EIO while the message keeps the real one;
//   - a mutation is refused BEFORE it touches anything when the destination is the
//     source, sits inside it, or (under `overwrite`) CONTAINS it, and a copy refuses a
//     tree deeper than its bound: `copy X -> X` used to delete the tree and report
//     success, `copy X -> X/inside` used to walk into its own output, and
//     `move/copy X/sub -> X` with `overwrite` used to `rm -rf` the directory HOLDING the
//     source and then report failure with the tree gone;
//   - that guard answers by REAL location, not by text: a destination that only LOOKS
//     contained because its path passes through a symlink inside the source that escapes
//     it is accepted (the two spellings of one directory must agree), while every
//     genuinely contained spelling is still refused;
//   - a failed copy quantifies the half-built tree it left in the destination, and the
//     depth refusal names the exact level it stopped at, because "Operations already
//     applied: none" is about the OTHER operations of the call, not about this one;
//   - a dangling symlink is a real source: `copy` moves it as a link and `move` renames
//     it, instead of reporting a path that "does not exist";
//   - a failing MUTATION rejects the call and names the operations already applied — no
//     rollback is claimed, because there is none;
//   - destination policy is decided by the tool, not by the platform: `overwrite`
//     gates replace-vs-EEXIST, `recursive` gates a NON-EMPTY directory (an empty one, and
//     a dangling symlink, delete without either flag), and `force` turns a missing delete
//     into a reported no-op. The refusal names the SHAPE it refused, because `recursive`
//     does different things to each: a real directory loses its whole tree, a symlink
//     loses the LINK and keeps every byte under its target, and a directory whose LISTING
//     failed (mode `000`) is refused for the listing failure, not as a plain directory;
//   - operations run IN CALLER ORDER against the filesystem as each one finds it, so a
//     rename followed by a delete of the new name works (state is checked at the op's
//     turn, not in a pre-flight sweep);
//   - mutations take the same per-file locks ./lock.ts gives ./write and ./edit, so a
//     concurrent write cannot be clobbered by a delete of the same path.
//
// Fixtures are real files under the repo-root `Temp/`, one unique directory per run,
// removed afterwards (module-relative, same convention as ./write.test.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile as readTextFile,
    readdir,
    readlink,
    rm,
    symlink,
    writeFile as writeTextFile
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey, validateSchemaValue } from '../../core';
import { fileLockCount } from './lock';
import {
    FILES_CONTENT_BUDGET,
    FILES_COPY_MAX_DEPTH,
    FILES_MAX_OPS,
    files,
    metadata,
    registration
} from './files.tool';
import { edit } from './edit.tool';
import { write } from './write.tool';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;
let previousCwd: string;

// A symlink is privileged on Windows (Developer Mode or elevation), so the
// symlink-backed assertions run only when this host let us create one — the same
// concession ./identity.test.ts:46-53 makes. Linux and macOS always create them, so the
// assertions this guards are never silently skipped where the defects were reported.
let symlinksAvailable = false;

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

// The message a rejected call carries. A refusal that has to name BOTH of the paths it
// refused between is only provable against the message, and this fails the test (rather
// than passing vacuously) when the call resolved instead of rejecting.
const rejectionMessage = async (call: Promise<unknown>): Promise<string> => {
    try {
        await call;
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }

    throw new Error('expected the files call to reject, but it resolved.');
};

// A recursive description of a tree, one sorted line per entry, in the style the review
// probes used: a refusal that promises "the filesystem is exactly as it was" is only
// provable by comparing whole trees, and a `readdir` of the top level alone cannot see the
// `deep/nested` subtree a `rm -rf` quietly eats.
const treeState = async (root: string): Promise<string[]> => {
    const lines: string[] = [];

    const walk = async (directory: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const path = join(directory, entry.name);

            if (entry.isSymbolicLink()) lines.push(`${posix(path)} :: link -> ${await readlink(path)}`);
            else if (entry.isDirectory()) {
                lines.push(`${posix(path)} :: dir`);
                await walk(path);
            } else lines.push(`${posix(path)} :: file ${(await lstat(path)).size}B`);
        }
    };

    await walk(root);

    return lines;
};

// `chmod 000` is not a barrier for root, which reads any mode, so the two assertions that
// depend on a directory refusing to be LISTED are pinned only on a host where the mode
// binds. Same concession ./write.test.ts makes for permission-driven behavior.
const permissionsBind = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;

// Counts what a directory really holds, excluding the root itself, in the four numbers a
// failed copy quotes (D5). Measured rather than hard-coded because `readdir`'s unspecified
// order decides which siblings landed before the walk hit the unreadable directory — the
// assertion is then "the message AGREES with the tree on disk", which stays exact.
const countTree = async (root: string): Promise<{ directories: number; files: number; bytes: number; links: number }> => {
    const tally = { directories: 0, files: 0, bytes: 0, links: 0 };

    const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);

            if (entry.isSymbolicLink()) tally.links += 1;
            else if (entry.isDirectory()) {
                tally.directories += 1;
                await walk(path);
            } else {
                tally.files += 1;
                tally.bytes += (await lstat(path)).size;
            }
        }
    };

    await walk(root);

    return tally;
};

// A symlink whose TARGET lives outside the tree it sits in — the shape that made the
// containment guard answer the text instead of the directory, and refused a destination
// the walk never touches.
const escapeLink = async (linkPath: string, targetDir: string): Promise<void> => {
    await mkdir(targetDir, { recursive: true });
    await symlink(targetDir, linkPath);
};

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-files-'));
    // The tool resolves every path against the process working directory (no sandbox,
    // same as ./write and ./list), so the relative spellings this suite pins are read
    // relative to the fixture, not to the package source tree.
    previousCwd = process.cwd();
    process.chdir(workdir);

    // Probe once: create and remove a link, and record whether the host allowed it.
    try {
        await symlink('probe-target', join(workdir, 'symlink-probe'));
        await rm(join(workdir, 'symlink-probe'), { force: true });
        symlinksAvailable = true;
    } catch {
        symlinksAvailable = false;
    }
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

    it('declares no numeric bounds for the paging fields, because the runtime clamp owns them', () => {
        const properties = metadata.parameters.properties as {
            ops: { items: { properties: Record<string, unknown> } };
        };

        // ../../core/schema-validation.ts enforces `minimum`/`maximum` BEFORE `execute`
        // (../../core/tool.ts:155-157 is the only path that skips validation, and it is
        // the one the old test happened to use). Bounds HERE therefore rejected a model
        // asking for `limit: 5000` even though the tool promises to clamp it, so the
        // exact-shape assertions below are the whole point: NO `minimum`, NO `maximum`.
        expect(properties.ops.items.properties.limit).toEqual({
            type: 'integer',
            description:
                'list: maximum entries in this page. Defaults to 200; values above 1000 are clamped to 1000 and values below 1 to 1, so an oversized page is never rejected.'
        });
        expect(properties.ops.items.properties.offset).toEqual({
            type: 'integer',
            description:
                'list: 0-based index into the flat entry list. Defaults to 0; pass the previous nextOffset here. A negative value is clamped to 0.'
        });
        // The shared argument gate now accepts exactly the values the clamp handles; the
        // "clamps an oversized page limit" test below pins what the call answers with them.
        expect(validateSchemaValue(properties.ops.items.properties.limit, 5000, '$.limit')).toEqual({ valid: true });
        expect(validateSchemaValue(properties.ops.items.properties.offset, -5, '$.offset')).toEqual({ valid: true });
    });

    it('publishes the operations as tags so toolRequest answers a move/delete query', () => {
        // The tool is found by the capability words a caller reaches for, and still by
        // the `files`/`list` tags `fileList` was found by.
        for (const tag of ['files', 'list', 'filesystem', 'move', 'rename', 'copy', 'delete', 'remove', 'mkdir']) {
            expect(files.tags).toContain(tag);
        }
    });

    it('publishes the copy depth bound and the link-only meaning of recursive, where callers read them', () => {
        // D6: a limit that lives only in the implementation is a limit a model cannot plan
        // around, and the keyword audit of the published text found `depth` missing while the
        // refusal quoted the number. The clause is here so the refusal and the description
        // carry the same figure.
        expect((metadata.description as string)).toContain(`a copy stops at a depth of ${FILES_COPY_MAX_DEPTH} directory levels`);
        // D3: `recursive` means different things for the two shapes it gates, and the
        // published text said "a directory and everything under it" for both — the shape a
        // symlink actually removes (the link, never the target) was invisible.
        const properties = metadata.parameters.properties as {
            ops: { items: { properties: Record<string, { description: string }> } };
        };

        expect(properties.ops.items.properties.recursive).toEqual({
            type: 'boolean',
            description:
                'delete: allow removing a real directory that is not empty, together with everything under it. For a symlink it removes the LINK only — the directory it points at and its contents always stay. Defaults to false.'
        });
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

    it('shares one 64 KiB entry-text budget across the list operations of a call', async () => {
        // Every entry is exactly 1024 UTF-8 bytes: 'shared/a' (8) + eight 100-character
        // directory names (8 x 101) + '/' + a 207-character name = 1024, so 64 entries are
        // exactly FILES_CONTENT_BUDGET and the cut point is provable, not approximate. The
        // length has to come from the prefix because NAME_MAX is 255.
        const chain = [0, 1, 2, 3, 4, 5, 6, 7]
            .map((level) => `d${level}`.padEnd(100, 'z'))
            .join('/');
        const leaf = (index: number): string => `n${String(index).padStart(3, '0')}${'y'.repeat(203)}`;
        const pageOf = (root: string, count: number): string[] =>
            Array.from({ length: count }, (_, index) => `${root}/${chain}/${leaf(index)}`);

        for (let index = 0; index < 70; index += 1) await seed(`shared/a/${chain}/${leaf(index)}`, 'x');
        for (let index = 0; index < 2; index += 1) await seed(`shared/b/${chain}/${leaf(index)}`, 'y');

        const result = await files([
            { op: 'list', path: `shared/a/${chain}` },
            { op: 'list', path: `shared/b/${chain}` }
        ]);

        // The FIRST op fills the CALL's budget exactly and stops before the 65th entry,
        // which no longer fits in what is left (0 bytes).
        expect(result.results[0]).toEqual({
            op: 'list',
            path: `shared/a/${chain}`,
            entries: pageOf('shared/a', 64),
            truncated: true,
            nextOffset: 64,
            offset: 0,
            limit: 200,
            bytes: FILES_CONTENT_BUDGET
        });
        // The SECOND op starts with the budget already spent, so it answers an EMPTY page —
        // and still reports `truncated: true` with its own offset, because the entry that
        // did not fit is the next one. A per-op budget gave it a fresh 64 KiB instead, and
        // an envelope `bytes` above the `contentBudget` printed beside it.
        expect(result.results[1]).toEqual({
            op: 'list',
            path: `shared/b/${chain}`,
            entries: [],
            truncated: true,
            nextOffset: 0,
            offset: 0,
            limit: 200,
            bytes: 0
        });
        // The envelope is the sum of what the ops charged, and can never exceed the cap.
        expect(result.bytes).toBe(FILES_CONTENT_BUDGET);
        expect(result.bytes).toBe(result.results.reduce((total, entry) => total + (entry.bytes ?? 0), 0));
        expect(result.contentBudget).toBe(FILES_CONTENT_BUDGET);
    });

    it('keeps the listings it did get when one requested directory cannot be read', async () => {
        await seed('tolerate-a/one.txt', '1');
        await seed('tolerate-b/two.txt', '2');

        const middle = await files([{ op: 'list', path: ['tolerate-a', 'tolerate-missing', 'tolerate-b'] }]);

        // The readable directories still answer, grouped in caller order, and the window is
        // computed over that surviving sequence — while the unreadable one stays this
        // entry's own error, naming the directory it actually tried to read. Discarding the
        // good listings AND answering `truncated: false, nextOffset: null` reported a
        // COMPLETE listing of a directory the tool never managed to open.
        expect(middle.results[0]).toEqual({
            op: 'list',
            path: 'tolerate-a',
            entries: ['tolerate-a/one.txt', 'tolerate-b/two.txt'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 'tolerate-a/one.txt'.length + 'tolerate-b/two.txt'.length,
            error: {
                code: 'ENOENT',
                message: expect.stringContaining(posix(join(workdir, 'tolerate-missing')))
            }
        });

        // A failure in the FIRST position must not cost the later directories either.
        const first = await files([{ op: 'list', path: ['tolerate-missing', 'tolerate-a'] }]);

        expect(first.results[0].entries).toEqual(['tolerate-a/one.txt']);
        expect(first.results[0].error?.code).toBe('ENOENT');
    });

    it('walks one directory once when a list path names it several ways', async () => {
        await seed('dedupe/one.txt', '1');
        await seed('dedupe/two.txt', '2');

        const result = await files([{ op: 'list', path: ['dedupe', './dedupe', 'dedupe/.'] }]);

        // Three spellings of ONE directory produce one flat sequence. A second walk
        // duplicated every entry and moved `offset` underneath a caller that is paging.
        expect(result.results[0]).toEqual({
            op: 'list',
            path: 'dedupe',
            entries: ['dedupe/one.txt', 'dedupe/two.txt'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 'dedupe/one.txt'.length + 'dedupe/two.txt'.length
        });

        if (!symlinksAvailable) return;

        // `resolve()` cannot see through a symlink, so the alias is the case that proves
        // the comparison is by real identity (./identity.ts) and not by text. The FIRST
        // spelling wins, prefix included.
        await symlink(join(workdir, 'dedupe'), join(workdir, 'dedupe-alias'), 'dir');

        const aliased = await files([{ op: 'list', path: ['dedupe-alias', 'dedupe', 'dedupe-alias'] }]);

        expect(aliased.results[0]).toEqual({
            op: 'list',
            path: 'dedupe-alias',
            entries: ['dedupe-alias/one.txt', 'dedupe-alias/two.txt'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 'dedupe-alias/one.txt'.length + 'dedupe-alias/two.txt'.length
        });
    });

    it('marks a symlink that resolves to a directory with the directory slash', async () => {
        if (!symlinksAvailable) return;

        await dir('slash/sub');
        await seed('slash/plain.txt', 'p');
        await seed('slash/sub/inner.txt', 'i');
        await symlink('sub', join(workdir, 'slash/dir-link'), 'dir');
        await symlink('plain.txt', join(workdir, 'slash/file-link.txt'));
        // A link whose target is gone has nothing to call a directory, and a listing must
        // not fail because of it: it keeps the plain name and no error.
        await symlink('gone.txt', join(workdir, 'slash/dangling.txt'));

        const result = await files([{ op: 'list', path: 'slash' }]);

        // 18 + 15 + 19 + 15 + 10 UTF-8 bytes. The slash is what "walkable" means to a
        // caller, and `dir-link` IS walkable — the walk follows it.
        expect(result.results[0]).toEqual({
            op: 'list',
            path: 'slash',
            entries: [
                'slash/dangling.txt',
                'slash/dir-link/',
                'slash/file-link.txt',
                'slash/plain.txt',
                'slash/sub/'
            ],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 77
        });
    });

    it('folds an errno outside the published set onto EIO and keeps the raw one in the message', async () => {
        // A 300-character name is under PATH_MAX but over NAME_MAX, so the kernel answers
        // ENAMETOOLONG — an errno the tool never promised. The receipt's machine code is
        // the documented EIO so a caller can switch on it; the message keeps the real name
        // for the human reading it.
        const tooLong = 'x'.repeat(300);
        const long = await files([{ op: 'list', path: tooLong }]);

        expect(long.results[0].entries).toEqual([]);
        expect(long.results[0].error?.code).toBe('EIO');
        expect(long.results[0].error?.message).toContain('ENAMETOOLONG');
        expect(long.results[0].error?.message).toContain(tooLong);

        if (!symlinksAvailable) return;

        // A self-referential symlink is ELOOP, folded the same way (and the slash probe in
        // the test above swallows this errno rather than failing the listing).
        await symlink('loop-self', join(workdir, 'loop-self'));

        const loop = await files([{ op: 'list', path: 'loop-self' }]);

        expect(loop.results[0].error?.code).toBe('EIO');
        expect(loop.results[0].error?.message).toContain('ELOOP');
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

    it('refuses to copy or move a path onto itself instead of deleting the source', async () => {
        await seed('self/a.txt', 'aaa');
        await seed('self/nested/b.txt', 'bb');

        // `overwrite` removed the destination — which IS the source — and the receipt then
        // claimed a copy that had deleted the whole tree.
        await expect(files([{ op: 'copy', from: 'self', to: 'self', overwrite: true }])).rejects.toThrow(
            /files copy refused: source and destination are the same path/
        );
        expect((await readdir(join(workdir, 'self'))).sort()).toEqual(['a.txt', 'nested']);

        // A MOVE went further: it deleted the source, then failed with ENOENT, so the call
        // reported failure AND the tree was gone.
        await expect(files([{ op: 'move', from: 'self', to: 'self', overwrite: true }])).rejects.toThrow(
            /files move refused: source and destination are the same path/
        );
        expect((await readdir(join(workdir, 'self'))).sort()).toEqual(['a.txt', 'nested']);

        // The message names BOTH paths as the tool resolved them, because "which two are
        // colliding?" is the first question a caller of a batch asks.
        const message = await rejectionMessage(files([{ op: 'copy', from: 'self', to: './self', overwrite: true }]));

        expect(message).toContain('files copy refused: source and destination are the same path');
        expect(message).toContain(`Source "${posix(join(workdir, 'self'))}"`);
        expect(message).toContain(`destination "${posix(join(workdir, 'self'))}"`);
        expect((await readdir(join(workdir, 'self'))).sort()).toEqual(['a.txt', 'nested']);

        if (!symlinksAvailable) return;

        // A symlinked alias defeats text comparison: only realpath shows these are one
        // directory, and the copy would still have destroyed it.
        await symlink(join(workdir, 'self'), join(workdir, 'self-alias'), 'dir');

        const aliased = await rejectionMessage(files([{ op: 'copy', from: 'self-alias', to: 'self', overwrite: true }]));

        expect(aliased).toContain('files copy refused: source and destination are the same path');
        expect(aliased).toContain(posix(join(workdir, 'self-alias')));
        expect((await readdir(join(workdir, 'self'))).sort()).toEqual(['a.txt', 'nested']);
    });

    it('refuses a destination inside the source instead of copying into its own output', async () => {
        await seed('inside/x.txt', 'xx');

        // `copy tree -> tree/copy` used to recurse into its own freshly written output:
        // each level re-entered the one above it until the path overflowed
        // (ENAMETOOLONG after hundreds of levels), with a garbage tree half-built and no
        // rollback. The refusal happens before a single directory is created.
        const copy = await rejectionMessage(files([{ op: 'copy', from: 'inside', to: 'inside/copy' }]));

        expect(copy).toContain('the destination is inside the source');
        expect(copy).toContain(posix(join(workdir, 'inside/copy')));
        expect(await readdir(join(workdir, 'inside'))).toEqual(['x.txt']);

        // The same impossibility for a directory MOVE: the tool says it in its own words,
        // before removing anything, instead of whatever `rename` decided afterwards.
        const move = await rejectionMessage(files([{ op: 'move', from: 'inside', to: 'inside/under' }]));

        expect(move).toContain('a directory cannot be moved inside itself');
        expect(await readdir(join(workdir, 'inside'))).toEqual(['x.txt']);

        // A FILE source with a destination "inside" it is ENOTDIR territory; the guard
        // refuses it with the same words and without touching the filesystem.
        await seed('infile.txt', 'x');

        await expect(files([{ op: 'copy', from: 'infile.txt', to: 'infile.txt/next.txt' }])).rejects.toThrow(
            /the destination is inside the source/
        );
        expect(await readdir(join(workdir, 'infile.txt')).catch(() => 'unreadable')).toBe('unreadable');
    });

    it('refuses a destination that CONTAINS the source instead of removing it with the source inside', async () => {
        await seed('anc/a.txt', 'aaa');
        await seed('anc/deep/nested/c.txt', 'ccc');
        await seed('anc/sub/b.txt', 'bb');

        // Every level of the tree, so "the refusal touched nothing" cannot be satisfied by a
        // top-level `readdir` that is blind to `deep/nested` — the entries the destination
        // removal ate.
        const intact = await treeState(join(workdir, 'anc'));
        const ancestor = posix(join(workdir, 'anc'));

        for (const op of ['move', 'copy'] as const) {
            // `overwrite` removes the destination recursively, and here the destination is
            // the directory HOLDING the source. Measured before the fix: the whole of `anc`
            // (a.txt, deep/nested/c.txt and sub itself) was gone, the syscall then failed
            // (ENOENT on `rename` for the move, ENOENT on `scandir` for the copy, which had
            // already recreated an empty `anc`), and the caller was told "Operations already
            // applied: none" about data it no longer owned.
            const message = await rejectionMessage(files([{ op, from: 'anc/sub', to: 'anc', overwrite: true }]));

            expect(message).toContain(`files ${op} refused: the destination contains the source`);
            expect(message).toContain(`Source "${posix(join(workdir, 'anc/sub'))}"`);
            expect(message).toContain(`destination "${ancestor}"`);
            // Refused before any mutation: no `rm`, and not even the destination's parents
            // were created.
            expect(await treeState(join(workdir, 'anc'))).toEqual(intact);

            // The same call WITHOUT `overwrite` is still the plain EEXIST refusal: nothing
            // has to be removed there, so asking for the flag is the honest answer, and the
            // ancestor verdict must not overwrite that message.
            await expect(files([{ op, from: 'anc/sub', to: 'anc' }])).rejects.toThrow(
                /already exists\. Pass overwrite: true/
            );
            expect(await treeState(join(workdir, 'anc'))).toEqual(intact);
        }

        if (!symlinksAvailable) return;

        // The verdict is about the directory on disk, so an alias of the ancestor is the
        // same refusal (the guard confirms through ./identity.ts rather than trusting that
        // the destination was spelled as the path it resolves to).
        await symlink(join(workdir, 'anc'), join(workdir, 'anc-link'), 'dir');

        const aliased = await rejectionMessage(files([{ op: 'move', from: 'anc/sub', to: 'anc-link', overwrite: true }]));

        expect(aliased).toContain('the destination contains the source');
        expect(aliased).toContain(`destination "${posix(join(workdir, 'anc-link'))}"`);
        expect(await treeState(join(workdir, 'anc'))).toEqual(intact);
        expect(await readlink(join(workdir, 'anc-link'))).toBe(join(workdir, 'anc'));
    });

    it('accepts a destination that only LOOKS contained, through a symlink that escapes the source', async () => {
        if (!symlinksAvailable) return;

        // `t/dir/out` points OUT of the tree, so `t/dir/out/inner` is a directory the walk
        // never enters. Answering the TEXT refused this copy (it worked at HEAD) while the
        // plain spelling of that very directory — `<workdir>/esc/outside/inner` — was
        // accepted: one destination, two answers depending on how it was typed.
        await seed('esc/t/a.txt', 'alpha\n'); // 6 B
        await seed('esc/t/dir/b.txt', 'beta\n'); // 5 B
        await escapeLink(join(workdir, 'esc/t/dir/out'), join(workdir, 'esc/outside'));

        const result = await files([{ op: 'copy', from: 'esc/t', to: 'esc/t/dir/out/inner' }]);

        expect(result.results[0]).toEqual({
            op: 'copy',
            path: posix(join(workdir, 'esc/t')),
            to: posix(join(workdir, 'esc/t/dir/out/inner')),
            kind: 'directory',
            // 6 + 5 of payload; the escaping link lands AS a link (0 bytes), which is also
            // what keeps the walk from following itself into the output it is writing.
            bytes: 11
        });
        // It really did land outside the source, in the link's own directory.
        expect((await readdir(join(workdir, 'esc/outside/inner'))).sort()).toEqual(['a.txt', 'dir']);
        expect(await readlink(join(workdir, 'esc/outside/inner/dir/out'))).toBe(join(workdir, 'esc/outside'));

        // The same shape for a MOVE: the rename moves the whole tree into the escaped
        // directory, which is what the plain spelling has always done.
        await seed('esc2/t/a.txt', 'alpha\n');
        await seed('esc2/t/dir/b.txt', 'beta\n');
        await escapeLink(join(workdir, 'esc2/t/dir/out'), join(workdir, 'esc2/outside'));

        const moved = await files([{ op: 'move', from: 'esc2/t', to: 'esc2/t/dir/out/moved' }]);

        expect(moved.results[0]).toEqual({
            op: 'move',
            path: posix(join(workdir, 'esc2/t')),
            to: posix(join(workdir, 'esc2/t/dir/out/moved')),
            kind: 'directory',
            bytes: 0
        });
        // `t` is gone from its own parent and now lives under `outside`.
        expect((await readdir(join(workdir, 'esc2'))).sort()).toEqual(['outside']);
        expect((await readdir(join(workdir, 'esc2/outside'))).sort()).toEqual(['moved']);
        expect((await readdir(join(workdir, 'esc2/outside/moved'))).sort()).toEqual(['a.txt', 'dir']);
    });

    it('still refuses every spelling that really is contained', async () => {
        if (!symlinksAvailable) return;

        // The control for the test above: confirming the containment verdict by real path
        // must not let the genuine shapes through.
        await seed('contained/t/a.txt', 'aaa');
        await seed('contained/t/deep/x.txt', 'x');
        await dir('contained/t/exists');
        await symlink(join(workdir, 'contained/t'), join(workdir, 'contained/t-link'), 'dir');
        await symlink(join(workdir, 'contained/t'), join(workdir, 'contained/alias'), 'dir');

        const intact = await treeState(join(workdir, 'contained'));

        for (const call of [
            // Text containment, and the real path agrees (`copy t -> t/sub`).
            { from: 'contained/t', to: 'contained/t/sub' },
            // An alias SOURCE whose real directory holds the destination.
            { from: 'contained/t-link', to: 'contained/t/deep' },
            // A destination inside the source THROUGH an alias of it — unborn, then born.
            { from: 'contained/t', to: 'contained/alias/new' },
            { from: 'contained/t', to: 'contained/alias/exists' }
        ]) {
            const message = await rejectionMessage(files([{ op: 'copy', ...call, overwrite: true }]));

            expect(message).toContain('the destination is inside the source');
            expect(message).toContain(`destination "${posix(join(workdir, call.to))}"`);
        }

        // Every refusal happened before the first `mkdir`, so not even the two unborn
        // destinations left a directory behind.
        expect(await treeState(join(workdir, 'contained'))).toEqual(intact);
    });

    it('copies and moves a dangling symlink as the link it is', async () => {
        if (!symlinksAvailable) return;

        await seed('dangling2/t/a.txt', 'aaa');
        await symlink('gone.txt', join(workdir, 'dangling2/t/dangling'));

        // The source check used `stat`, which follows the link and reports a dangling entry
        // as missing — while `delete` removed the same link, `rename` never follows it, and
        // the in-tree walk copies it as a link. Existence is `lstat` now; only the directory
        // question follows.
        const copied = await files([{ op: 'copy', from: 'dangling2/t/dangling', to: 'dangling2/d2' }]);

        expect(copied.results[0]).toEqual({
            op: 'copy',
            path: posix(join(workdir, 'dangling2/t/dangling')),
            to: posix(join(workdir, 'dangling2/d2')),
            kind: 'file',
            // A link holds no payload and `stat`ing this one throws, so 0 — the same number
            // an in-tree symlink contributes to a copied directory.
            bytes: 0
        });
        // The stored target string, verbatim: not resolved, not skipped, not fatal.
        expect(await readlink(join(workdir, 'dangling2/d2'))).toBe('gone.txt');
        expect((await lstat(join(workdir, 'dangling2/d2'))).isSymbolicLink()).toBe(true);
        expect(await readlink(join(workdir, 'dangling2/t/dangling'))).toBe('gone.txt');

        const moved = await files([{ op: 'move', from: 'dangling2/t/dangling', to: 'dangling2/d3' }]);

        expect(moved.results[0]).toEqual({
            op: 'move',
            path: posix(join(workdir, 'dangling2/t/dangling')),
            to: posix(join(workdir, 'dangling2/d3')),
            kind: 'file',
            // A dangling link has no reachable target, so there is no payload size to echo.
            bytes: 0
        });
        expect(await readlink(join(workdir, 'dangling2/d3'))).toBe('gone.txt');
        expect(await lstat(join(workdir, 'dangling2/t/dangling')).catch(() => undefined)).toBeUndefined();
    });

    it('quantifies the half-built tree a failed copy left in the destination', async () => {
        if (!permissionsBind) return;

        await seed('half/a.txt', 'aaa'); // 3 B
        await seed('half/deep/inner.txt', 'inner');

        const blocked = join(workdir, 'half/deep');

        await chmod(blocked, 0o000);

        // The unreadable directory is restored in `finally` so a failing assertion cannot
        // leave it unreadable for the next test or for ./afterAll's cleanup.
        const message = await (async () => {
            try {
                return await rejectionMessage(files([{ op: 'copy', from: 'half', to: 'half-copy' }]));
            } finally {
                await chmod(blocked, 0o755);
            }
        })();

        const destination = join(workdir, 'half-copy');

        // The errno names the path the FAILING syscall touched — the SOURCE directory
        // `scandir` could not open. The measured message reported `EACCES on
        // <destination>` while quoting `scandir '<source>/deep'`, pointing the caller at the
        // tree it should keep instead of the one it should fix.
        expect(message).toContain(`EACCES on ${posix(blocked)}`);
        expect(message).toContain(`scandir '${posix(blocked)}'`);

        // "Operations already applied: none" is about the OTHER entries of the call, and the
        // destination already held a tree when the call rejected. The message counts it —
        // dir/file/link counts plus bytes — and those numbers have to agree with the disk,
        // since `readdir` order decides whether `a.txt` landed before the walk reached the
        // unreadable directory.
        const landed = await countTree(destination);

        expect(landed.directories).toBeGreaterThanOrEqual(1);
        expect(message).toContain(
            // `+ 1` is the destination root: the copy created it, and `countTree` walks the
            // tree it is handed rather than counting the root as one of its entries.
            `Before it failed, this copy had already put ${landed.directories + 1} dir(s), ${landed.files} file(s) (${landed.bytes} byte(s)) and ${landed.links} link(s) into "${posix(destination)}"; they are still there.`
        );
        // The tree really is still there (no rollback exists to remove it).
        expect((await readdir(destination)).sort()).toContain('deep');
    });

    it('names the exact level the copy depth bound stopped at', async () => {
        const levels = (count: number): string => Array.from({ length: count }, (_, index) => `n${index}`).join('/');

        // The bound counts directory LEVELS below the source root (the root is level 0), so
        // exactly FILES_COPY_MAX_DEPTH levels copy…
        await seed(`depth-fit/${levels(FILES_COPY_MAX_DEPTH)}/leaf.txt`, 'deep');

        const fit = await files([{ op: 'copy', from: 'depth-fit', to: 'depth-fit-copy' }]);

        expect(fit.results[0]).toMatchObject({ kind: 'directory', bytes: 4 });

        // …and one more is refused, naming the level it reached. The old wording ("stopped at
        // 64 levels of nesting on <path>") read as the depth reached while the named path was
        // already one deeper.
        const reached = FILES_COPY_MAX_DEPTH + 1;

        await seed(`depth-stop/${levels(reached)}/leaf.txt`, 'deep');

        const message = await rejectionMessage(files([{ op: 'copy', from: 'depth-stop', to: 'depth-stop-copy' }]));
        const root = posix(join(workdir, 'depth-stop'));

        expect(message).toContain(
            `files copy stopped at ${FILES_COPY_MAX_DEPTH} levels of nesting: "${root}/${levels(reached)}" is ${reached} levels below the copy root "${root}".`
        );
        // The same disclosure a filesystem failure gets: this refusal happens deep inside a
        // half-built destination, and the message says what is standing there.
        expect(message).toContain(
            `this copy had already put ${FILES_COPY_MAX_DEPTH + 1} dir(s), 0 file(s) (0 byte(s)) and 0 link(s) into "${posix(join(workdir, 'depth-stop-copy'))}"`
        );
        expect((await readdir(join(workdir, 'depth-stop-copy'))).sort()).toEqual(['n0']);
    });

    it('copies symlinks as symlinks and reports the bytes the destination holds', async () => {
        if (!symlinksAvailable) return;

        await dir('treelink/sub');
        await seed('treelink/plain.txt', 'p'); // 1 byte
        await seed('treelink/sub/inner.txt', 'inner'); // 5 bytes
        await symlink('sub', join(workdir, 'treelink/dir-link'), 'dir');
        await symlink('plain.txt', join(workdir, 'treelink/file-link.txt'));
        await symlink('gone.txt', join(workdir, 'treelink/dangling.txt'));

        const result = await files([{ op: 'copy', from: 'treelink', to: 'treelink-copy' }]);

        // This used to be REFUSED mid-walk ("does not follow special entries") after a
        // partial tree had already been written, with no rollback to undo it.
        expect(result.results[0]).toEqual({
            op: 'copy',
            path: posix(join(workdir, 'treelink')),
            to: posix(join(workdir, 'treelink-copy')),
            kind: 'directory',
            // 1 + 5, measured on the DESTINATION after the write: that is the payload the
            // receipt claims exists. A link contributes 0 because a link holds no payload —
            // stat'ing one would report its TARGET's size, and throw outright for a dangling
            // link (which is how a source-side sum could also silently disagree).
            bytes: 6
        });

        // Each link is copied VERBATIM: the stored target string, not a resolved absolute
        // path, so the copy means exactly what the source meant.
        expect(await readlink(join(workdir, 'treelink-copy/dir-link'))).toBe('sub');
        expect(await readlink(join(workdir, 'treelink-copy/file-link.txt'))).toBe('plain.txt');
        expect(await readlink(join(workdir, 'treelink-copy/dangling.txt'))).toBe('gone.txt');
        // The dangling link is copied as a link — not resolved, not skipped, not fatal.
        expect((await lstat(join(workdir, 'treelink-copy/dangling.txt'))).isSymbolicLink()).toBe(true);
        // The payload bytes themselves are in the destination, which is what `bytes: 6`
        // was measured from.
        expect(await readTextFile(join(workdir, 'treelink-copy/plain.txt'), 'utf8')).toBe('p');
        expect(await readTextFile(join(workdir, 'treelink-copy/sub/inner.txt'), 'utf8')).toBe('inner');
    });

    it('refuses a tree deeper than the copy bound, naming the root and the level', async () => {
        // Defense in depth behind the containment guard, so the fixture has to reach the
        // bound deliberately: FILES_COPY_MAX_DEPTH + 2 nested directories. (`deep-tree`,
        // not `deep`: the mkdir test at the top of this file already owns `deep/a/b`.)
        const levels = Array.from({ length: FILES_COPY_MAX_DEPTH + 2 }, (_, index) => `l${index}`).join('/');

        await seed(`deep-tree/${levels}/leaf.txt`, 'deep');

        const message = await rejectionMessage(files([{ op: 'copy', from: 'deep-tree', to: 'deep-copy' }]));

        expect(message).toContain(`files copy stopped at ${FILES_COPY_MAX_DEPTH} levels of nesting`);
        // Both the offending path and the root of the copy are named, so the caller knows
        // which subtree to flatten.
        expect(message).toContain(`${posix(join(workdir, 'deep-tree'))}/l0/l1`);
        // And, like every other mutation failure, it says what it did NOT undo: the
        // destination holds the levels it reached before the refusal.
        expect(await readdir(join(workdir, 'deep-copy'))).toEqual(['l0']);
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

    it('deletes an empty directory without recursive, which is exactly what was asked', async () => {
        await dir('vacant');

        const result = await files([{ op: 'delete', path: 'vacant' }]);

        // The contract refuses a NON-EMPTY directory without `recursive`. An empty one has
        // nothing to lose, and Node cannot answer it with the plain call: `rm(path,
        // { recursive: false })` reports ERR_FS_EISDIR for ANY directory, so the tool
        // verifies emptiness with `readdir` and then removes it.
        expect(result.results[0]).toEqual({
            op: 'delete',
            path: posix(join(workdir, 'vacant')),
            removed: true,
            recursive: false
        });
        expect(await lstat(join(workdir, 'vacant')).catch(() => undefined)).toBeUndefined();
    });

    it('deletes a symlink to an empty directory without touching the target', async () => {
        if (!symlinksAvailable) return;

        await dir('still-here');
        await symlink('still-here', join(workdir, 'link-to-vacant'));

        const result = await files([{ op: 'delete', path: 'link-to-vacant' }]);

        // `rmdir` — the other half of the empty-directory case — refuses a symlink with
        // ENOTDIR, so the empty case has to go through `rm`. Only the LINK goes; the
        // (empty) target stays.
        expect(result.results[0]).toEqual({
            op: 'delete',
            path: posix(join(workdir, 'link-to-vacant')),
            removed: true,
            recursive: false
        });
        expect(await lstat(join(workdir, 'link-to-vacant')).catch(() => undefined)).toBeUndefined();
        expect(await readdir(join(workdir, 'still-here'))).toEqual([]);
    });

    it('deletes a dangling symlink, which `stat` reports as a missing path', async () => {
        if (!symlinksAvailable) return;

        await dir('dangling');
        const target = join(workdir, 'dangling/gone.txt');

        await symlink('nowhere.txt', target);

        // `stat` follows the link, finds nothing, and the delete used to answer "does not
        // exist. Pass force: true" — for a path that IS there, and removable. `lstat` is
        // what proves the entry exists, and removing it is one unlink.
        const result = await files([{ op: 'delete', path: 'dangling/gone.txt' }]);

        expect(result.results[0]).toEqual({
            op: 'delete',
            path: posix(target),
            removed: true,
            recursive: false
        });
        expect(await lstat(target).catch(() => undefined)).toBeUndefined();

        // `force: true` means "already gone is an acceptable answer", not "report a skip
        // when something is actually here": the link was removed, so the receipt says so.
        await symlink('nowhere-else.txt', join(workdir, 'dangling/forced.txt'));

        const forced = await files([{ op: 'delete', path: 'dangling/forced.txt', force: true }]);

        expect(forced.results[0]).toEqual({
            op: 'delete',
            path: posix(join(workdir, 'dangling/forced.txt')),
            removed: true,
            recursive: false
        });
        expect(await lstat(join(workdir, 'dangling/forced.txt')).catch(() => undefined)).toBeUndefined();
    });

    it('refuses a symlink to a non-empty directory as a SYMLINK, and recursive takes the link only', async () => {
        if (!symlinksAvailable) return;

        await seed('linkdir/target/inner/x.txt', 'x');
        await symlink('target', join(workdir, 'linkdir/link'));

        // The words ARE the contract here. The refusal said "is a directory. Pass recursive:
        // true to remove it and everything inside it", and `recursive: true` then removed
        // ONLY THE LINK — the target tree survived, every byte of it (./delete examines the
        // path with `lstat` first: the link is the entry the caller named). A model that
        // followed the advice believed a tree was gone.
        const refused = await rejectionMessage(files([{ op: 'delete', path: 'linkdir/link' }]));

        expect(refused).toContain('is a symlink to a non-empty directory');
        expect(refused).toContain('Pass recursive: true to remove the LINK');
        expect(refused).toContain('the directory it points at, and everything inside it, stay');
        // The refusal changed nothing: link and target both intact.
        expect(await readlink(join(workdir, 'linkdir/link'))).toBe('target');
        expect(await readdir(join(workdir, 'linkdir/target'))).toEqual(['inner']);

        const removed = await files([{ op: 'delete', path: 'linkdir/link', recursive: true }]);

        // The receipt is the shape it always was — behavior unchanged, wording fixed — and it
        // is the LINK that goes.
        expect(removed.results[0]).toEqual({
            op: 'delete',
            path: posix(join(workdir, 'linkdir/link')),
            removed: true,
            recursive: true
        });
        expect(await lstat(join(workdir, 'linkdir/link')).catch(() => undefined)).toBeUndefined();
        expect(await readdir(join(workdir, 'linkdir/target'))).toEqual(['inner']);
        expect(await readTextFile(join(workdir, 'linkdir/target/inner/x.txt'), 'utf8')).toBe('x');
    });

    it('names the listing failure of an unreadable directory instead of hiding it behind the directory advice', async () => {
        if (!permissionsBind) return;

        await seed('secret/inner/x.txt', 'x');

        const blocked = join(workdir, 'secret');

        await chmod(blocked, 0o000);

        const message = await (async () => {
            try {
                return await rejectionMessage(files([{ op: 'delete', path: 'secret' }]));
            } finally {
                await chmod(blocked, 0o755);
            }
        })();

        // Emptiness is decided by `readdir`, so an unreadable directory is treated as
        // non-empty — but it was then reported as a plain non-empty directory, whose remedy
        // (`recursive: true`) dies on the same EACCES. The refusal keeps the safe verdict and
        // states the real cause.
        expect(message).toContain('is a directory that could not be listed, so it is treated as non-empty');
        expect(message).toContain(`EACCES on ${posix(blocked)}`);
        expect(message).toContain('Pass recursive: true to attempt the removal anyway.');
        // Nothing was removed (the tree is back to listable and intact).
        expect(await readdir(join(workdir, 'secret'))).toEqual(['inner']);
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
