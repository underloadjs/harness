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
//     getting a fresh 64 KiB. Paging itself is unchanged; what the page cannot show is
//     DISCLOSED: `starved: true` plus the op that spent the allowance, a `note` naming the
//     entry a long name stranded, and a `note` for an `offset` at or past the end, so an
//     empty page can never be read as "this folder is empty". F1 widened that marker to the
//     NEAR MISS as well (a remainder too small to buy the next entry is the same stranded
//     page as a spent budget) and made the note state the bytes actually left;
//   - the envelope's `bytes` counts ONLY this call's list entry text (F10): a move/copy
//     receipt carries its own `bytes`, in file PAYLOAD units, and is deliberately never summed
//     into that total, because one number in two units cannot be read — the published
//     description states the unit, and the pin keeps description and code together. The
//     description likewise publishes the delete rule the refusal has always enforced (F4: a
//     symlink to a NON-EMPTY directory is refused without `recursive`, because `recursive`
//     then removes the LINK and leaves the tree);
//   - a list path naming one directory several ways walks it ONCE (compared by real
//     identity, ./identity.ts), and one directory that cannot be read costs only itself:
//     the listings already collected survive, and the failure is that entry's own
//     `error` naming the directory it tried to read (read's rule);
//   - the machine `code` of a failure is from the published set (FILES_ERROR_CODES, which
//     now includes EXDEV because a cross-device move is a routine answer, not a fault); any
//     other raw errno (ENAMETOOLONG, ELOOP, ERR_FS_EISDIR, ENOTEMPTY) folds onto EIO and
//     keeps its true name BOTH in the message and in `rawCode`, and the path a failure
//     happened on is named exactly once;
//   - a mutation is refused BEFORE it touches anything when the destination is the
//     source, sits inside it, or CONTAINS it, and a copy refuses a
//     tree deeper than its bound: `copy X -> X` used to delete the tree and report
//     success, `copy X -> X/inside` used to walk into its own output, and
//     `move/copy X/sub -> X` with `overwrite` used to `rm -rf` the directory HOLDING the
//     source and then report failure with the tree gone. The ancestor verdict answers
//     whether or not `overwrite` was passed, because the hint it used to give
//     ("pass overwrite: true") leads into that very destruction;
//   - that guard answers by REAL location, not by text: a destination that only LOOKS
//     contained because its path passes through a symlink inside the source that escapes
//     it is accepted (the two spellings of one directory must agree), while every
//     genuinely contained spelling is still refused;
//   - a failed copy quantifies the half-built tree it left in the destination, NAMES its
//     top-level entries, and says plainly that the remainder is partial; the depth refusal
//     names the exact level it stopped at, because "Operations already applied: none" is
//     about the OTHER operations of the call, not about this one;
//   - a dangling symlink is a real entry on BOTH sides of an operation: `copy` writes it as
//     a link and `move` renames it instead of reporting a path that "does not exist", and a
//     destination whose name a dangling link holds is a TAKEN name (the followed `stat` that
//     called it free let a move replace it without `overwrite`). `kind` reports what stands
//     at the DESTINATION, so a moved link — live or dangling — says `symlink` with 0 bytes;
//   - a failing MUTATION rejects the call and names the operations already applied — no
//     rollback is claimed, because there is none. The rejection also carries the op's own
//     code and `applied[]`/`appliedCount`/`rollback`/`failure` as DATA, and what THIS op
//     left behind (a half-copied tree, or the destination its own `overwrite` had already
//     removed while the source stayed) both in the message and in `details`;
//   - destination policy is decided by the tool, not by the platform: `overwrite`
//     gates replace-vs-EEXIST, `replaceDirectory` gates removing a destination DIRECTORY
//     and the tree under it (a file taking a directory name, or a directory replacing a
//     NON-EMPTY one; an empty destination with a directory source, and any symlink
//     destination, still need only `overwrite`, while a FILE onto an empty destination
//     directory still needs `replaceDirectory` and — F5 — now says so without claiming a
//     WHOLE tree is at stake), `recursive` gates a NON-EMPTY directory (an empty one, and
//     a dangling symlink, delete without either flag), and `force` turns a missing delete
//     into a reported no-op. The refusal names the SHAPE it refused, because `recursive`
//     does different things to each: a real directory loses its whole tree, a symlink
//     loses the LINK and keeps every byte under its target, and a directory whose LISTING
//     failed (mode `000`) is refused for the listing failure, not as a plain directory;
//   - a replacement says what it destroyed: the receipt carries
//     `replaced: { path, kind, entries }`, counted as the destination stood BEFORE the
//     removal;
//   - an empty-directory `delete` removes the name with `rmdir` (verified empty by
//     `readdir`), not with a recursive `rm`, so an entry that appears in the race between
//     the two answers ENOTEMPTY instead of being deleted silently — the syscall name in the
//     failure is the proof, and `mkdir` likewise refuses a name held by a symlink (a live
//     link to a file, or a dangling link, each with its own remedy);
//   - operations run IN CALLER ORDER against the filesystem as each one finds it, so a
//     rename followed by a delete of the new name works (state is checked at the op's
//     turn, not in a pre-flight sweep);
//   - mutations take the same per-file locks ./lock.ts gives ./write and ./edit, so a
//     concurrent write cannot be clobbered by a delete of the same path. The lock set is
//     what a mutation NAMES (`path`, plus `to` for move/copy); a recursive `delete` and a
//     directory `copy` walk subtrees they do NOT lock, because one lock per walked entry
//     would hold the batch for the length of the walk — so "serialized against write/edit"
//     means "on the paths it names", nothing wider.
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
// `mkdtempSync`/`statSync` are for the cross-device EXDEV fixture, which has to live on a
// DIFFERENT filesystem than the workdir (see that test); the sync form is deliberate there
// because the device check decides whether the test runs at all. That check reads `TMPDIR`
// through `os.tmpdir()`: pointing `TMPDIR` at the repo `Temp/` the workdir is under makes both
// roots share a device and the test returns early, so the EXDEV assertions only run when
// `TMPDIR` really is elsewhere (`yarn vitest run src/tools/files/files.test.ts` with `TMPDIR`
// unset is the configuration that actually executes them).
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey, validateSchemaValue } from '../../core';
import { fileLockCount } from './lock';
import {
    FILES_CONTENT_BUDGET,
    FILES_COPY_MAX_DEPTH,
    FILES_ERROR_CODES,
    FILES_LIST_DEFAULT_LIMIT,
    FILES_MAX_OPS,
    FILES_REFUSAL_CODES,
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

// The REJECTED CALL as data, for the assertions that are about `code` and `details` rather
// than about the sentence (M11: a rejection whose machine parts are missing forces the caller
// to parse prose, which is exactly what ../../util/errors.ts exists to avoid). Like
// ./rejectionMessage, this fails the test when the call resolved.
// The batch-level `details` ./execute attaches to a rejected call (M11). Typed, so the
// assertions below can reach `failure.details` without casts; `[key: string]` stays open
// because the op's own half-state (`written`, `replaced`, `sourceStillExists`) varies by op.
type FilesRejectionDetails = {
    op?: string;
    path?: string;
    applied?: string[];
    appliedCount?: number;
    rollback?: boolean;
    failure?: { code?: string | null; details?: Record<string, unknown> };
    [key: string]: unknown;
};

const rejectionOf = async (call: Promise<unknown>): Promise<FilesRejectionDetails & { message: string; code?: string }> => {
    try {
        await call;
    } catch (error: unknown) {
        const failure = error as { message?: string; code?: string; details?: FilesRejectionDetails };

        return {
            message: failure?.message ?? String(error),
            ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
            ...(failure?.details === undefined ? {} : { details: failure.details })
        };
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
        // F4: the description's delete sentence stated the link-only rule but not the GATE in
        // front of it, so a model reading only the description had no way to predict that
        // deleting a symlink to a NON-EMPTY directory is refused at all (./delete refuses it
        // precisely because `recursive` then removes the link and leaves the tree). The
        // `recursive` parameter and the file header already carried the rule; the published
        // description is the half a model actually reads.
        expect(metadata.description as string).toContain(
            'a symlink to a NON-EMPTY directory is refused without it too - `recursive` then removes the LINK and leaves that tree exactly as it was'
        );
    });

    it('publishes replaceDirectory in the schema, the runtime field list, and the description together', async () => {
        // C1's field is a promise in THREE places: the JSON schema a harness enforces, the
        // runtime table a DIRECT call enforces (./prepareOperation rejects what the schema does
        // not list, and vice versa), and the published description a model plans with. One of
        // them drifting is a contract the tool cannot keep, so all three are pinned together.
        const properties = metadata.parameters.properties as {
            ops: { items: { properties: Record<string, { type?: string; description: string }> } };
        };

        expect(properties.ops.items.properties.replaceDirectory).toEqual({
            type: 'boolean',
            description:
                'move/copy only: also allow removing a destination DIRECTORY together with the whole tree under it. Required whenever `overwrite` would delete a tree: a non-directory source taking a directory name, or a directory source replacing a destination directory that is not empty. An empty destination directory with a directory source needs only `overwrite`. The removal is refused WITHOUT it - nothing is deleted, and the refusal counts the entries that were at stake - and every replacement this flag allows is reported in the receipt as `replaced: { path, kind, entries }`. Defaults to false.'
        });
        // `overwrite` now DEFERS to the new flag for a directory. Left as it was, the two
        // descriptions would have contradicted each other about what one flag is enough for.
        expect(properties.ops.items.properties.overwrite).toEqual({
            type: 'boolean',
            description:
                'move/copy: replace an existing destination instead of failing on it. For a destination that is a FILE or a SYMLINK that is the whole permission (a symlink replacement costs the link, never anything under its target). For a destination that is a DIRECTORY it is not enough on its own - see replaceDirectory. Defaults to false.'
        });
        expect(properties.ops.items.properties.to.description).toContain(
            'an existing destination DIRECTORY needs replaceDirectory: true as well whenever the replacement would remove a tree'
        );

        // The runtime field list agrees with the schema for the op that got the flag and for the
        // ones that must NOT accept it.
        const misplaced = await rejectionMessage(files([{ op: 'list', path: 'x', replaceDirectory: true }]));

        expect(misplaced).toBe('files list does not accept "replaceDirectory". Allowed fields: op, path, offset, limit.');

        // The prose carries the same rule, including the two shapes that still need only
        // `overwrite` — a model that reads only the description must not over-ask for the flag.
        const description = metadata.description as string;

        expect(description).toContain(
            'and `replaceDirectory` (default false, move/copy only; REQUIRED whenever replacing the destination would delete a TREE'
        );
        expect(description).toContain(
            'an EMPTY destination directory with a directory source needs only `overwrite`, and a destination that is a symlink needs only `overwrite`'
        );
        expect(description).toContain('plus `replaced: { path, kind, entries }` whenever the call removed an existing destination');
        // M6: `kind` is the DESTINATION's shape, and the description says so because the receipt
        // answer used to describe the source.
        expect(description).toContain('`kind` is what stands at the DESTINATION afterwards - `file`, `directory`, or `symlink`');
        // M2 / EXTRA-3 / L8: the three receipt fields that exist to stop an empty page from being
        // misread are part of the published contract, not implementation detail.
        // F1: the published gate has to cover the NEAR MISS as well — a budget with 10 bytes
        // left strands a page exactly like a spent one — otherwise the prose is narrower than
        // the flag, which is the defect.
        expect(description).toContain(
            'plus `starved: true` and a `note` when an earlier list op of the same call already spent the shared entry budget, or left less of it than one entry costs'
        );
        expect(description).toContain('and the note states the bytes that were left');
        // F10: `bytes` is ONE unit (list entry text), and a caller that is not told so reads a
        // copy's payload bytes as if they had been charged against `contentBudget`.
        expect(description).toContain(
            '`bytes` counts the list entry text this call returned, while mutation receipts carry their own `bytes` and are not summed into it'
        );
        expect(description).toContain(
            'a `note` also says when a page stopped early because one long name did not fit the remaining budget, or when an `offset` is past the end of the listing'
        );
        // H1: `EXDEV` is in the published code set, and the remedy is the two calls it replaces.
        expect(description).toContain('Cross-device moves report `EXDEV`');
        // The cancellation code joins the set (./cancellation.ts): a cancelled call has always
        // been refused, but it was refused with whatever the host's `AbortSignal` happened to
        // carry (measured: a DOMException named `AbortError` whose `code` is the NUMBER 20),
        // which is not a member of any published set and cannot be branched on.
        expect(FILES_ERROR_CODES).toEqual(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ECANCELED', 'EIO', 'EXDEV']);
        // And the set stays honest: a model that is not told a code exists cannot branch on one.
        // Unlike `read`, this description names only the codes that change the caller's NEXT
        // call, and a cancellation is one: it is the difference between "retry later" and
        // "nothing happened", so the clause below is the published half of ./cancellation.ts.
        expect(description).toContain(
            'A cancelled call rejects the same way with `ECANCELED`, naming the operation it stopped on and the ops already applied'
        );
        // The refusal codes are exported so a caller names them instead of quoting literals out
        // of a message; the two new shapes are part of that set.
        expect(FILES_REFUSAL_CODES.destinationDirectory).toBe('files-destination-directory');
        expect(FILES_REFUSAL_CODES.mkdirDanglingLink).toBe('files-mkdir-dangling-link');
        expect(FILES_REFUSAL_CODES.operationFailed).toBe('files-operation-failed');
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
        //
        // EXTRA-3 pin (this wave): the cut now EXPLAINS itself. `truncated: true` plus a
        // cursor could not distinguish "stopped because the sequence ends" from "stopped
        // because one 1024-byte name did not fit the 0 bytes left", and this fixture is that
        // exact case: entries sort by code point, so the long names are all the same length
        // and a caller with 200 entries of `limit` still stopped at 64. The note names the
        // withheld entry, its size, and the bytes that were left.
        expect(result.results[0]).toEqual({
            op: 'list',
            path: `shared/a/${chain}`,
            entries: pageOf('shared/a', 64),
            truncated: true,
            nextOffset: 64,
            offset: 0,
            limit: 200,
            bytes: FILES_CONTENT_BUDGET,
            note: `This page stopped before "${pageOf('shared/a', 65)[64]}" at offset 64: that entry is 1024 bytes and only 0 of the call's ${
                FILES_CONTENT_BUDGET
            }-byte entry budget was left. The listing is sorted by code point, so one long name can strand the budget that remains; pass nextOffset back in a fresh call to resume after it, or list a narrower directory.`
        });
        // The SECOND op starts with the budget already spent, so it answers an EMPTY page —
        // and still reports `truncated: true` with its own offset, because the entry that
        // did not fit is the next one. A per-op budget gave it a fresh 64 KiB instead, and
        // an envelope `bytes` above the `contentBudget` printed beside it.
        //
        // M2 pin (this wave): an empty page that is NOT an answer about this directory is
        // marked `starved: true`, and the note names the op that spent the allowance, so the
        // caller does not read "no entries" as "this folder is empty".
        //
        // F1 reword (kept pin, same scenario, same `starved: true`): the note now states the
        // remainder that was ACTUALLY left — 0 here — instead of only claiming "already
        // spent", because the same sentence has to stay true for the near-miss case below.
        expect(result.results[1]).toEqual({
            op: 'list',
            path: `shared/b/${chain}`,
            entries: [],
            truncated: true,
            nextOffset: 0,
            offset: 0,
            limit: 200,
            bytes: 0,
            starved: true,
            note: `This list op could not take an entry from the call's ${FILES_CONTENT_BUDGET}-byte entry budget: the list at "shared/a/${chain}" (offset 0) had already charged ${FILES_CONTENT_BUDGET} of it, leaving 0 — less than one entry's cost — so no entry here could be returned and nextOffset 0 has not advanced. Ask for this listing in a separate call, or list a narrower directory.`
        });
        // The envelope is the sum of what the ops charged, and can never exceed the cap.
        expect(result.bytes).toBe(FILES_CONTENT_BUDGET);
        expect(result.bytes).toBe(result.results.reduce((total, entry) => total + (entry.bytes ?? 0), 0));
        expect(result.contentBudget).toBe(FILES_CONTENT_BUDGET);
    });

    // F1 (this wave): the gate was `remainingAtStart === 0`, which describes only one shape of
    // a stranded page. An entry costs its whole prefixed name (here 1024 bytes), so the
    // ORDINARY end of a nearly-full budget is a handful of bytes left that cannot buy the next
    // entry either — and that case answered `entries: [], truncated: true` with NO marker, the
    // exact false "this folder is empty" the marker exists to prevent. The gate is now "the
    // budget could not afford the next entry", and the note states the remainder instead of
    // claiming the budget was fully spent (which was untrue for the near miss).
    it('marks an empty page starved when what is left cannot buy the next entry, not only at zero', async () => {
        // Provable arithmetic, same construction as the pin above: `near/a` (6) + eight
        // 100-character levels (8 x 101) + '/' = 815 bytes of prefix, so a 209-character leaf
        // is exactly a 1024-byte entry, 199 is 1014, and 208 is 1023. 63 x 1024 + 1014 =
        // 65,526 leaves 10; 63 x 1024 + 1023 = 65,535 leaves 1.
        const chain = [0, 1, 2, 3, 4, 5, 6, 7]
            .map((level) => `d${level}`.padEnd(100, 'z'))
            .join('/');
        const leaf = (index: number, length: number): string =>
            `n${String(index).padStart(3, '0')}${'y'.repeat(length - 4)}`;
        const pageOf = (side: string, count: number, length: number): string[] =>
            Array.from({ length: count }, (_, index) => `near/${side}/${chain}/${leaf(index, length)}`);
        const seedSide = async (side: string, count: number, length: number): Promise<void> => {
            for (const entry of pageOf(side, count, length)) await seed(entry, 'x');
        };

        // The 64th entry of each side is the short one, and code-point order puts `n063`
        // after `n062`, so it is the LAST entry the first page emits.
        const shortA = `near/a/${chain}/${leaf(63, 199)}`;
        const shortC = `near/c/${chain}/${leaf(63, 208)}`;

        await seedSide('a', 63, 209);
        await seed(shortA, 'x');
        await seedSide('b', 2, 209);
        await seedSide('c', 63, 209);
        await seed(shortC, 'x');
        await seedSide('d', 2, 209);
        // A short name for the gate's OTHER side: 10 bytes left is starvation only relative to
        // the entry this op was about to emit, never an absolute "the budget is gone".
        await seed('e/f', 'x');

        const charged = 63 * 1024 + 1014;

        expect(charged).toBe(FILES_CONTENT_BUDGET - 10);

        // 1. Ten bytes left — the near miss the old gate let through.
        const near = await files([
            { op: 'list', path: `near/a/${chain}` },
            { op: 'list', path: `near/b/${chain}` }
        ]);

        // The first page is CLEAN (every entry fit, nothing was withheld), so the remainder it
        // leaves is the second op's whole story.
        expect(near.results[0]).toEqual({
            op: 'list',
            path: `near/a/${chain}`,
            entries: [...pageOf('a', 63, 209), shortA],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: charged
        });
        expect(near.results[1]).toEqual({
            op: 'list',
            path: `near/b/${chain}`,
            entries: [],
            truncated: true,
            nextOffset: 0,
            offset: 0,
            limit: 200,
            bytes: 0,
            starved: true,
            note: `This list op could not take an entry from the call's ${FILES_CONTENT_BUDGET}-byte entry budget: the list at "near/a/${chain}" (offset 0) had already charged ${charged} of it, leaving 10 — less than one entry's cost — so no entry here could be returned and nextOffset 0 has not advanced. Ask for this listing in a separate call, or list a narrower directory.`
        });
        // The remainder the note quotes is the caller's own arithmetic (`contentBudget -
        // bytes`), so the sentence can be checked against the envelope it arrived in.
        expect(near.bytes).toBe(charged);
        expect(near.contentBudget).toBe(FILES_CONTENT_BUDGET);

        // 2. One byte left — the last entry of the first page DID fit, and the next page is
        // still stranded. This is the boundary of the widened gate: `remaining < nextEntry`.
        const last = await files([
            { op: 'list', path: `near/c/${chain}` },
            { op: 'list', path: `near/d/${chain}` }
        ]);

        expect(last.results[0]).toMatchObject({
            entries: [...pageOf('c', 63, 209), shortC],
            truncated: false,
            bytes: FILES_CONTENT_BUDGET - 1
        });
        expect(last.results[1]).toEqual({
            op: 'list',
            path: `near/d/${chain}`,
            entries: [],
            truncated: true,
            nextOffset: 0,
            offset: 0,
            limit: 200,
            bytes: 0,
            starved: true,
            note: `This list op could not take an entry from the call's ${FILES_CONTENT_BUDGET}-byte entry budget: the list at "near/c/${chain}" (offset 0) had already charged ${FILES_CONTENT_BUDGET - 1} of it, leaving 1 — less than one entry's cost — so no entry here could be returned and nextOffset 0 has not advanced. Ask for this listing in a separate call, or list a narrower directory.`
        });

        // 3. The same 10 bytes left, against an entry they can buy: the page is returned, and
        // stays the exact clean receipt shape — no `starved`, no `note`.
        const fits = await files([
            { op: 'list', path: `near/a/${chain}` },
            { op: 'list', path: 'e' }
        ]);

        expect(fits.results[1]).toEqual({
            op: 'list',
            path: 'e',
            entries: ['e/f'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 'e/f'.length
        });
        expect(fits.bytes).toBe(charged + 'e/f'.length);
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
        // M10 pin (this wave): the true errno is DATA on the receipt, not only prose. Before
        // the fix `error.rawCode` did not exist, so a caller switching on `code` could not
        // tell ENAMETOOLONG (name too long) from ELOOP (symlink loop) from ENOTEMPTY — three
        // different remedies behind one published `EIO`.
        expect(long.results[0].error?.rawCode).toBe('ENAMETOOLONG');
        expect(long.results[0].error?.message).toContain('ENAMETOOLONG');
        expect(long.results[0].error?.message).toContain(tooLong);

        if (!symlinksAvailable) return;

        // A self-referential symlink is ELOOP, folded the same way (and the slash probe in
        // the test above swallows this errno rather than failing the listing).
        await symlink('loop-self', join(workdir, 'loop-self'));

        const loop = await files([{ op: 'list', path: 'loop-self' }]);

        expect(loop.results[0].error?.code).toBe('EIO');
        expect(loop.results[0].error?.rawCode).toBe('ELOOP');
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

    it('says which kind of empty page an offset past the end is', async () => {
        await seed('past/a.txt', 'a');
        await seed('past/b.txt', 'b');

        // L8: an offset at or past the last entry slices to `[]` and looked exactly like a
        // listing that had run out — `truncated: false`, `nextOffset: null`, no note, and a
        // caller paging with a stale cursor could not tell "keep going" from "you overshot" from
        // "this folder is empty". It is still a SUCCESSFUL page; only the disclosure changes.
        const result = await files([{ op: 'list', path: 'past', offset: 5 }]);

        expect(result.results[0]).toEqual({
            op: 'list',
            path: 'past',
            entries: [],
            truncated: false,
            nextOffset: null,
            offset: 5,
            limit: FILES_LIST_DEFAULT_LIMIT,
            bytes: 0,
            note: `offset 5 is at or past the end of this listing, which has 2 entries: this empty page means the sequence is exhausted, not that anything failed. Drop the offset to start over.`
        });

        // The exact end of the sequence is the same answer with the last entry included, and a
        // page that is simply full gets NO note — the field is additive, so the clean receipts
        // keep the shape the paging tests above pin.
        const exact = await files([{ op: 'list', path: 'past', offset: 2 }]);

        expect(exact.results[0]).toMatchObject({
            entries: [],
            truncated: false,
            nextOffset: null,
            offset: 2
        });
        expect(exact.results[0]).not.toHaveProperty('starved');
        expect(exact.results[0].note).toContain('offset 2 is at or past the end');

        const full = await files([{ op: 'list', path: 'past', limit: 1 }]);

        expect(full.results[0].note).toBeUndefined();
        expect(full.results[0]).toMatchObject({ entries: ['past/a.txt'], truncated: true, nextOffset: 1, bytes: 10 });
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

    it('refuses a name held by a symlink, live or dangling, as the shape it is', async () => {
        if (!symlinksAvailable) return;

        await seed('mkjs/target.txt', 'x');
        await symlink('target.txt', join(workdir, 'mkjs/to-file'));
        await symlink('nowhere.txt', join(workdir, 'mkjs/dangling'));

        const toFilePath = posix(join(workdir, 'mkjs/to-file'));
        const danglingPath = posix(join(workdir, 'mkjs/dangling'));

        // EXTRA-6: a link to a FILE is a name that cannot become a directory, and the refusal
        // says so with a machine code and `details` — the site used to answer the same sentence
        // with no `code`, so a caller had the prose and nothing to switch on.
        const toFile = await rejectionOf(files([{ op: 'mkdir', path: 'mkjs/to-file' }]));

        expect(toFile.code).toBe(FILES_REFUSAL_CODES.mkdirNotDirectory);
        expect(toFile.message).toBe(
            `files failed on mkdir ${toFilePath}: files mkdir refused: "${toFilePath}" is a symlink to a file, not a directory. Operations already applied: none. No rollback was performed.`
        );
        expect(toFile.details?.failure?.details).toEqual({
            path: toFilePath,
            kind: 'symlink',
            targetExists: true,
            targetIsDirectory: false
        });

        // THE DANGLING SHAPE is the defect: `stat` followed the link, saw nothing, and handed
        // `mkdir` a name that IS taken. Measured before the fix, the caller got `EIO … EEXIST`
        // with no mention of the link — three codes and nothing to act on. The refusal now
        // quotes the stored target and offers both remedies that actually apply: move off the
        // name, remove the link, or create the target itself.
        const dangling = await rejectionOf(files([{ op: 'mkdir', path: 'mkjs/dangling' }]));

        expect(dangling.code).toBe(FILES_REFUSAL_CODES.mkdirDanglingLink);
        expect(dangling.details?.failure?.code).toBe(FILES_REFUSAL_CODES.mkdirDanglingLink);
        expect(dangling.details?.failure?.details).toEqual({
            path: danglingPath,
            kind: 'symlink',
            target: 'nowhere.txt',
            targetExists: false
        });
        expect(dangling.message).toBe(
            `files failed on mkdir ${danglingPath}: files mkdir refused: "${danglingPath}" is a symlink pointing at "nowhere.txt", and that target does not exist, so the name is taken with no directory behind it. ` +
                `Pass a different "path", or delete the link ({ "op": "delete", "path": "${danglingPath}" }) and mkdir again, or mkdir the target "${posix(join(workdir, 'mkjs/nowhere.txt'))}" itself. ` +
                `Operations already applied: none. No rollback was performed.`
        );
        // The refusal touched the link and its absence: both still exactly as seeded.
        expect(await readlink(join(workdir, 'mkjs/dangling'))).toBe('nowhere.txt');
        expect((await lstat(join(workdir, 'mkjs/target.txt'))).isFile()).toBe(true);
    });

    it('keeps the errno it folds away as rawCode, so mkdir answers like every other verb', async () => {
        // F2: ./mkdir was the ONLY failure site in this tool that threw with no `details`, so a
        // folded errno survived only as prose. Measured before the fix: `mkdir` answered
        // `{ code: 'EIO' }` with `rawCode` absent — while `list` on the identical path answered
        // `{ code: 'EIO', rawCode: 'ELOOP' }` and `read`/`write`/`edit` answer `ELOOP` outright.
        // The two shapes below are the two the review measured.
        //
        // A 300-character name is under PATH_MAX but over NAME_MAX, so the kernel answers
        // ENAMETOOLONG — an errno outside FILES_ERROR_CODES, hence the published `EIO` with the
        // true name beside it (`rawCode` is present ONLY because it differs from `code`).
        const tooLong = 'x'.repeat(300);

        const long = await rejectionOf(files([{ op: 'mkdir', path: tooLong }]));

        expect(long.code).toBe('EIO');
        expect(long.details?.failure?.code).toBe('EIO');
        expect(long.details?.failure?.details).toEqual({
            path: posix(join(workdir, tooLong)),
            code: 'EIO',
            rawCode: 'ENAMETOOLONG'
        });
        // The prose keeps the folded name too (M10), because the sentence is what a model reads.
        expect(long.message).toContain('files mkdir failed on');
        expect(long.message).toContain('EIO (ENAMETOOLONG)');

        if (!symlinksAvailable) return;

        // A self-referential link used as a path COMPONENT is ELOOP. (The link named AS the
        // mkdir target is the EXTRA-6 dangling-link refusal above, where `stat` and `readlink`
        // answer before any syscall fails — which is why the loop sits one level above the name
        // being created here.)
        await dir('mkloop');
        await symlink('loop-self', join(workdir, 'mkloop/loop-self'));

        const loop = await rejectionOf(files([{ op: 'mkdir', path: 'mkloop/loop-self/inner' }]));

        expect(loop.code).toBe('EIO');
        expect(loop.details?.failure?.code).toBe('EIO');
        expect(loop.details?.failure?.details).toEqual({
            path: posix(join(workdir, 'mkloop/loop-self/inner')),
            code: 'EIO',
            rawCode: 'ELOOP'
        });
        expect(loop.message).toContain('EIO (ELOOP)');
        // Nothing was created under the loop: the failure is the whole answer.
        expect(await readdir(join(workdir, 'mkloop'))).toEqual(['loop-self']);
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

    it('answers an unwritable destination parent with the published errno, not the generic batch code', async () => {
        // The destination-parent creation used to sit OUTSIDE every classifying `try`, so the
        // raw Node error reached ./operationFailure with no `code` of its own and the caller got
        // `code: 'files-operation-failed'` with `details.failure.code: null` and Node's prose as
        // the message — for an EACCES this tool PUBLISHES. Measured on a `0555` parent as a
        // non-root uid: `copy -> ro/missing/copy.txt` was generic while `copy -> ro/copy.txt`
        // (parent already exists, so that line is a no-op and `copyFile` answers the SAME errno)
        // was `code: 'EACCES'`. Both legs are pinned here: the fixed shape and the untouched one.
        if (!permissionsBind) return;

        await seed('rodest/copy-source.txt', 'payload');
        await seed('rodest/move-source.txt', 'payload');

        const parent = await dir('rodest/ro');

        // The folder the tool tries to CREATE is one level below the read-only one, and that is
        // the path the failing syscall names — so it is the path the message and the `details`
        // triple carry, while `parent` is only the mode the fixture sets.
        const missing = posix(join(parent, 'missing'));

        await chmod(parent, 0o500);

        try {
            for (const op of ['copy', 'move'] as const) {
                const destination = posix(join(parent, 'missing', `${op}.txt`));
                const rejection = await rejectionOf(
                    files([{ op, from: `rodest/${op}-source.txt`, to: `rodest/ro/missing/${op}.txt` }])
                );

                // EACCES is what a `0555` folder answers for a non-root process; EPERM is what
                // some hosts answer instead (an ACL, a read-only mount). Both are PUBLISHED
                // codes, and the pin is that the caller gets one of them rather than the batch
                // fallback, whatever the host's flavor.
                expect(['EACCES', 'EPERM']).toContain(rejection.code);
                expect(rejection.code).not.toBe(FILES_REFUSAL_CODES.operationFailed);
                // The SYSCALL NAME is the proof that the failure is the parent creation and not
                // the later `copyFile`/`rename`: `mkdir` is the only call that can fail here.
                // Both paths are stated ONCE (M10), so the errno renders in the location-free
                // form next to the reason.
                expect(rejection.message).toContain(`files ${op} could not create the destination folder ${missing} for ${destination}`);
                // Node's own reason, spelled the way THIS errno spells it, so the assertion is
                // exact on a host that answers EPERM instead of EACCES.
                const prose = rejection.code === 'EPERM' ? 'operation not permitted' : 'permission denied';

                expect(rejection.message).toContain(`${rejection.code}: ${prose} (mkdir).`);
                expect(rejection.message).toContain('The process may not write in the parent folder');
                expect(rejection.message).toContain('Operations already applied: none. No rollback was performed.');

                // M11: the machine half, byte-for-byte. `rawCode` is ABSENT because EACCES/EPERM
                // are published codes and nothing was folded — the same triple ./delete (:1657)
                // and ./copy + ./move (:1955, :1994) publish for the same errno.
                expect(rejection.details).toEqual({
                    op,
                    // A move/copy rejection is named by its SOURCE, as every other test here pins.
                    path: posix(join(workdir, `rodest/${op}-source.txt`)),
                    applied: [],
                    appliedCount: 0,
                    rollback: false,
                    failure: { code: rejection.code, details: { path: missing, code: rejection.code } }
                });
            }

            // The leg that already answered correctly must keep answering exactly the same way:
            // the parent exists, so the mkdir is a no-op and the errno comes from the syscall
            // that writes the entry. Nothing about the fix may reach this shape.
            const insideParent = await rejectionOf(files([{ op: 'copy', from: 'rodest/copy-source.txt', to: 'rodest/ro/copy.txt' }]));

            expect(['EACCES', 'EPERM']).toContain(insideParent.code);
            expect(insideParent.details?.failure?.code).toBe(insideParent.code);
            expect(insideParent.message).toContain('files copy failed on');

            // Nothing was created and nothing moved: the refusal is the whole answer, and the
            // read-only folder is still empty.
            expect(await readdir(parent)).toEqual([]);
            expect((await readdir(join(workdir, 'rodest'))).sort()).toEqual(['copy-source.txt', 'move-source.txt', 'ro']);
        } finally {
            // Restored in `finally` so a failing assertion cannot strand a read-only folder for
            // the rest of the run or for ./afterAll's cleanup.
            await chmod(parent, 0o755);
        }
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

    // F10 (this wave): the envelope's `bytes` counts ONLY this call's list entry text — a
    // move/copy receipt carries a `bytes` of its own (file PAYLOAD), and one number holding
    // both units is unreadable whichever way it is read. The published description now defines
    // it; this pins that the definition describes the code, in both directions: a mutation-only
    // call totals 0 against `contentBudget`, and a mixed call totals exactly the list receipt.
    it('totals the envelope bytes in list-entry units, never mixing in a mutation payload', async () => {
        await seed('bytesum/payload.txt', 'payload');

        const copyOnly = await files([{ op: 'copy', from: 'bytesum/payload.txt', to: 'bytesum/copy.txt' }]);

        // The receipt still reports the 7 bytes it wrote, and the envelope reports no entry
        // text at all — `contentBudget` printed beside it is the LIST cap, and nothing in this
        // call charged it.
        expect(copyOnly.results[0]).toMatchObject({ op: 'copy', bytes: 7 });
        expect(copyOnly.bytes).toBe(0);
        expect(copyOnly.contentBudget).toBe(FILES_CONTENT_BUDGET);

        await rm(join(workdir, 'bytesum/copy.txt'), { force: true });

        const mixed = await files([
            { op: 'copy', from: 'bytesum/payload.txt', to: 'bytesum/copy.txt' },
            { op: 'list', path: 'bytesum' }
        ]);

        expect(mixed.results[1]).toEqual({
            op: 'list',
            path: 'bytesum',
            entries: ['bytesum/copy.txt', 'bytesum/payload.txt'],
            truncated: false,
            nextOffset: null,
            offset: 0,
            limit: 200,
            bytes: 'bytesum/copy.txt'.length + 'bytesum/payload.txt'.length
        });
        // 35, not 42: the copy's 7 payload bytes stay out of this total on purpose, which is
        // exactly the sentence the description now carries.
        expect(mixed.bytes).toBe('bytesum/copy.txt'.length + 'bytesum/payload.txt'.length);
        expect(mixed.bytes).toBe((mixed.results[1] as { bytes: number }).bytes);
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

            // M5 (this wave) CHANGED this expectation: the same call WITHOUT `overwrite` used
            // to answer the plain EEXIST sentence ("already exists. Pass overwrite: true"),
            // which was advice that destroys the source — taking that flag here runs the
            // recursive removal of the directory HOLDING `anc/sub`, which is the tree the
            // refusal exists to protect. The ancestor verdict now wins whenever the
            // destination EXISTS, so both calls answer the same sentence, and that sentence
            // is the only one whose remedy cannot eat the caller's data.
            const bare = await rejectionMessage(files([{ op, from: 'anc/sub', to: 'anc' }]));

            expect(bare).toContain(`files ${op} refused: the destination contains the source`);
            expect(bare).not.toContain('Pass overwrite: true');
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
            // M6 (this wave) CHANGED this expectation: `kind` describes what stands at the
            // DESTINATION, and this receipt writes a LINK there (`readlink` + `symlink`, the
            // proof below). Reporting `file` for an entry that is not a file was the defect —
            // a caller that branches on `kind` to decide whether to `read` the result reads a
            // lie either way, because the name is a link pointing at something absent.
            kind: 'symlink',
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
            // M6, same rule: `rename` never follows a link, so the entry under `to` is the
            // link this call moved (a LIVE link moved the same way also reports 'symlink',
            // which is what the new `move of a live link` test below pins).
            kind: 'symlink',
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
        //
        // M10 (this wave) CHANGED the second half of this expectation: the path is now named
        // ONCE, by the code-prefixed location this tool composes, and the syscall NAME
        // survives in parentheses. Repeating Node's quoted `scandir '<path>'` location
        // alongside it printed the same absolute path twice in one sentence (three codes and
        // two paths, the M11 complaint), and the location is already exact because it comes
        // from `error.path` rather than from parsing the message.
        expect(message).toContain(`EACCES on ${posix(blocked)}`);
        expect(message).toContain('permission denied (scandir)');
        expect(message).not.toContain(`scandir '${posix(blocked)}'`);

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

        // L1 (this wave): the tally says HOW MUCH half a tree is left; it never said WHICH names
        // a caller could pick up, and the destination is now a partial copy that looks complete.
        // The sentence names its top-level entries, and those names have to agree with the disk —
        // `readdir` order decides which siblings landed, so the expectation is read back too.
        const remaining = (await readdir(destination)).sort();

        expect(remaining.length).toBeLessThanOrEqual(12);
        expect(message).toContain(
            `The partial copy remains at "${posix(destination)}"; its top-level entries are ${remaining.join(', ')}.`
        );
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

    it('refuses to replace a destination directory tree until replaceDirectory says so', async () => {
        // C1. `overwrite` used to be the WHOLE permission, so `move one.txt -> many` with the
        // flag deleted `many/` and everything under it and answered an ordinary rename receipt.
        // `overwrite` means "the NAME at `to` may go"; the TREE under it needs its own flag, and
        // the refusal has to count the casualty and advise only the flags still missing.
        await seed('treec1/one.txt', 'aaa');
        await seed('treec1/many/a.txt', 'a');
        await seed('treec1/many/b/c.txt', 'cc');
        await seed('treec1/newer/x.txt', 'x');

        const sourcePath = posix(join(workdir, 'treec1/one.txt'));
        const many = join(workdir, 'treec1/many');
        const manyPath = posix(many);

        const refusalFor = async (overwrite: boolean) =>
            rejectionOf(
                files([
                    {
                        op: 'move',
                        from: 'treec1/one.txt',
                        to: 'treec1/many',
                        ...(overwrite ? { overwrite: true } : {})
                    }
                ])
            );

        const bare = await refusalFor(false);
        const flagged = await refusalFor(true);

        // Same verdict with and without `overwrite`: the flag on its own cannot authorize a tree,
        // so the hint cannot be allowed to promise what the flag does not deliver.
        expect(bare.code).toBe(FILES_REFUSAL_CODES.destinationDirectory);
        expect(flagged.code).toBe(FILES_REFUSAL_CODES.destinationDirectory);
        // The machine half names the shape, the number at stake, and the EXACT flags that would
        // have authorized the call — `overwrite: true` is not re-advised to a caller that passed it.
        expect(bare.details?.failure?.details).toEqual({
            path: sourcePath,
            to: manyPath,
            kind: 'directory',
            entries: 2,
            sourceKind: 'file',
            requiredFlags: ['overwrite', 'replaceDirectory']
        });
        expect(flagged.details?.failure?.details).toEqual({
            path: sourcePath,
            to: manyPath,
            kind: 'directory',
            entries: 2,
            sourceKind: 'file',
            requiredFlags: ['replaceDirectory']
        });
        expect(bare.message).toContain(
            `files move refused: destination "${manyPath}" is a directory that holds 2 entries, and replacing it removes that WHOLE tree. ` +
                `The source "${sourcePath}" is not a directory, so it would take the directory's name and its contents would be gone. ` +
                `Pass a "to" INSIDE that directory (for example "${manyPath}/name"), or pass overwrite: true and replaceDirectory: true to remove the tree and take its name.`
        );
        expect(flagged.message).toContain(
            `or pass replaceDirectory: true to remove the tree and take its name.`
        );
        expect(flagged.message).not.toContain('overwrite: true and replaceDirectory');
        // Nothing was removed by either refusal, at any depth.
        expect((await readdir(many)).sort()).toEqual(['a.txt', 'b']);
        expect(await readTextFile(join(many, 'b/c.txt'), 'utf8')).toBe('cc');
        expect(await readTextFile(join(workdir, 'treec1/one.txt'), 'utf8')).toBe('aaa');

        // A DIRECTORY source onto a NOT-EMPTY destination directory is the same permission —
        // one tree for the other — and says so differently, because nothing outside the two
        // trees is at risk.
        const swap = await rejectionOf(files([{ op: 'copy', from: 'treec1/newer', to: 'treec1/many' }]));

        expect(swap.code).toBe(FILES_REFUSAL_CODES.destinationDirectory);
        expect(swap.details?.failure?.details).toEqual({
            path: posix(join(workdir, 'treec1/newer')),
            to: manyPath,
            kind: 'directory',
            entries: 2,
            sourceKind: 'directory',
            requiredFlags: ['overwrite', 'replaceDirectory']
        });
        expect(swap.message).toContain('The source is a directory too, so the call swaps one tree for the other.');

        if (!permissionsBind) return;

        // An UNLISTABLE destination directory is counted as non-empty and says the count is
        // unknown: a `000` mode must never read as "empty, so `overwrite` is enough".
        await chmod(many, 0o000);

        const blind = await (async () => {
            try {
                return await rejectionOf(files([{ op: 'move', from: 'treec1/one.txt', to: 'treec1/many', overwrite: true }]));
            } finally {
                await chmod(many, 0o755);
            }
        })();

        expect(blind.code).toBe(FILES_REFUSAL_CODES.destinationDirectory);
        expect(blind.details?.failure?.details).toMatchObject({ entries: null, requiredFlags: ['replaceDirectory'] });
        expect(blind.message).toContain(
            `destination "${manyPath}" is a directory that could not be listed (its entries are counted as unknown, which is treated as non-empty)`
        );
        expect((await readdir(many)).sort()).toEqual(['a.txt', 'b']);
    });

    // F5 (this wave): the same refusal said "holds 0 entries … and replacing it removes that
    // WHOLE tree" for an EMPTY destination directory. The gate is right — a non-directory
    // source taking a directory's name still needs `replaceDirectory` — but the sentence
    // exaggerated the casualty (an empty directory holds no tree), which is the failure mode
    // this file keeps hitting: a caller that is told a tree is at stake starts doubting whether
    // one has already been deleted. The `> 0` and unlistable branches above keep the alarming
    // wording byte-for-byte, because there a tree really is the casualty.
    it('refuses a file onto an EMPTY destination directory without inventing a tree to lose', async () => {
        await seed('empty5/one.txt', 'aaa');
        await dir('empty5/empty');

        const fromPath = posix(join(workdir, 'empty5/one.txt'));
        const toPath = posix(join(workdir, 'empty5/empty'));

        const refusalFor = async (overwrite: boolean) =>
            rejectionOf(
                files([
                    {
                        op: 'move',
                        from: 'empty5/one.txt',
                        to: 'empty5/empty',
                        ...(overwrite ? { overwrite: true } : {})
                    }
                ])
            );

        const bare = await refusalFor(false);
        const flagged = await refusalFor(true);

        // The machine half is unchanged by the wording fix: same code, the count it measured
        // (0, not null), and only the flags still missing.
        expect(bare.code).toBe(FILES_REFUSAL_CODES.destinationDirectory);
        expect(bare.details?.failure?.details).toEqual({
            path: fromPath,
            to: toPath,
            kind: 'directory',
            entries: 0,
            sourceKind: 'file',
            requiredFlags: ['overwrite', 'replaceDirectory']
        });
        expect(flagged.details?.failure?.details).toEqual({
            path: fromPath,
            to: toPath,
            kind: 'directory',
            entries: 0,
            sourceKind: 'file',
            requiredFlags: ['replaceDirectory']
        });
        expect(bare.message).toContain(
            `files move refused: destination "${toPath}" is an EMPTY directory, so nothing under it is at stake - only its own name, which the source "${fromPath}" would take because it is not a directory. ` +
                `Pass a "to" INSIDE it (for example "${toPath}/name"), or pass overwrite: true and replaceDirectory: true to take the name and remove the empty directory.`
        );
        expect(flagged.message).toContain(
            'or pass replaceDirectory: true to take the name and remove the empty directory.'
        );
        expect(flagged.message).not.toContain('overwrite: true and replaceDirectory');
        // The overstatement itself is what is pinned absent: nothing here holds a tree, and the
        // non-empty branch above still owns that sentence.
        expect(bare.message).not.toContain('WHOLE tree');
        expect(bare.message).not.toContain('holds 0 entries');
        // Both refusals changed nothing: the file is still a file, the directory is still empty.
        expect(await readTextFile(join(workdir, 'empty5/one.txt'), 'utf8')).toBe('aaa');
        expect(await readdir(join(workdir, 'empty5/empty'))).toEqual([]);

        // The advice the new sentence gives is real: with the flags it names, the call is
        // accepted, and the receipt still reports the empty directory it removed.
        const accepted = await files([
            { op: 'move', from: 'empty5/one.txt', to: 'empty5/empty', overwrite: true, replaceDirectory: true }
        ]);

        expect(accepted.results[0]).toEqual({
            op: 'move',
            path: fromPath,
            to: toPath,
            kind: 'file',
            bytes: 3,
            replaced: { path: toPath, kind: 'directory', entries: 0 }
        });
        expect(await readTextFile(join(workdir, 'empty5/empty'), 'utf8')).toBe('aaa');
    });

    it('reports what an overwrite replacement removed', async () => {
        await seed('repl/one.txt', 'aaa');
        await seed('repl/two.txt', 'bb');
        await seed('repl/many/a.txt', 'a');
        await seed('repl/many/b/c.txt', 'cc');
        await seed('repl/tree/x.txt', 'x');
        await seed('repl/target/x.txt', 'xx');
        await mkdir(join(workdir, 'repl/empty'), { recursive: true });

        // Authorized by BOTH flags: the tree goes, and the receipt says what it was, counted as
        // it stood before the removal. Without `replaced` the caller learns the price only by
        // listing a directory it just lost.
        const asFile = await files([
            { op: 'move', from: 'repl/one.txt', to: 'repl/many', overwrite: true, replaceDirectory: true }
        ]);

        expect(asFile.results[0]).toEqual({
            op: 'move',
            path: posix(join(workdir, 'repl/one.txt')),
            to: posix(join(workdir, 'repl/many')),
            kind: 'file',
            bytes: 3,
            replaced: { path: posix(join(workdir, 'repl/many')), kind: 'directory', entries: 2 }
        });
        // The name is a file now: `many/b/c.txt` is really gone, not hidden.
        expect((await lstat(join(workdir, 'repl/many'))).isFile()).toBe(true);

        // An EMPTY destination directory with a DIRECTORY source destroys nothing, so `overwrite`
        // alone is still enough — the flag is a permission for a tree, not a tax on every rename
        // onto a directory name.
        const intoEmpty = await files([{ op: 'copy', from: 'repl/tree', to: 'repl/empty', overwrite: true }]);

        expect(intoEmpty.results[0]).toEqual({
            op: 'copy',
            path: posix(join(workdir, 'repl/tree')),
            to: posix(join(workdir, 'repl/empty')),
            kind: 'directory',
            bytes: 1,
            replaced: { path: posix(join(workdir, 'repl/empty')), kind: 'directory', entries: 0 }
        });
        expect(await readdir(join(workdir, 'repl/empty'))).toEqual(['x.txt']);

        if (!symlinksAvailable) return;

        // A destination that is a SYMLINK costs the LINK and nothing under its target (`rm` and
        // `rename` never follow it), so `overwrite` is the whole permission there — and the
        // receipt records `kind: 'symlink'` for what it removed.
        await symlink('target', join(workdir, 'repl/link'));

        const ontoLink = await files([{ op: 'move', from: 'repl/two.txt', to: 'repl/link', overwrite: true }]);

        expect(ontoLink.results[0]).toEqual({
            op: 'move',
            path: posix(join(workdir, 'repl/two.txt')),
            to: posix(join(workdir, 'repl/link')),
            kind: 'file',
            bytes: 2,
            replaced: { path: posix(join(workdir, 'repl/link')), kind: 'symlink', entries: 0 }
        });
        expect((await lstat(join(workdir, 'repl/link'))).isSymbolicLink()).toBe(false);
        // The target directory kept every byte: replacing a link never reaches through it.
        expect(await readdir(join(workdir, 'repl/target'))).toEqual(['x.txt']);
        expect(await readTextFile(join(workdir, 'repl/target/x.txt'), 'utf8')).toBe('xx');
    });

    it('refuses a destination whose name is held by a dangling symlink', async () => {
        if (!symlinksAvailable) return;

        await seed('dlink/taken.txt', 'aaa');
        await symlink('missing.txt', join(workdir, 'dlink/dangling'));

        const targetPath = posix(join(workdir, 'dlink/dangling'));

        // EXTRA-2: the destination was examined with `stat`, which follows the link and answers
        // "nothing here" for a dangling one. A `move` therefore REPLACED a taken name without the
        // caller ever saying `overwrite`, and a `copy` followed the link and created its missing
        // target instead of writing the destination that was named.
        const rejection = await rejectionOf(files([{ op: 'move', from: 'dlink/taken.txt', to: 'dlink/dangling' }]));

        expect(rejection.code).toBe(FILES_REFUSAL_CODES.destinationExists);
        expect(rejection.details?.failure?.details).toEqual({ path: targetPath, kind: 'symlink' });
        expect(rejection.message).toContain(
            `files move: destination "${targetPath}" already exists. Pass overwrite: true to replace it. ` +
                `It is a symlink pointing at "${posix(join(workdir, 'dlink/missing.txt'))}", whose target does not exist: ` +
                `a followed stat called that name free, which is exactly how a move used to replace a taken name without asking; ` +
                `overwriting it removes the LINK and never anything under the target.`
        );
        expect(await readlink(join(workdir, 'dlink/dangling'))).toBe('missing.txt');
        expect(await readTextFile(join(workdir, 'dlink/taken.txt'), 'utf8')).toBe('aaa');

        // With the flag, the link is what goes — the entry the caller named, and nothing else.
        const forced = await files([{ op: 'move', from: 'dlink/taken.txt', to: 'dlink/dangling', overwrite: true }]);

        expect(forced.results[0]).toEqual({
            op: 'move',
            path: posix(join(workdir, 'dlink/taken.txt')),
            to: targetPath,
            kind: 'file',
            bytes: 3,
            replaced: { path: targetPath, kind: 'symlink', entries: 0 }
        });
        expect((await lstat(join(workdir, 'dlink/dangling'))).isFile()).toBe(true);
    });

    it('names EXDEV and the two calls that replace a cross-device move', async () => {
        // H1. A cross-device `rename` is a routine answer, not a disk fault, and this tool
        // refuses to turn the move into a copy behind the caller's back. Measured before the fix,
        // the site threw a HarnessError with NO `code` — so `error.code` was undefined exactly
        // where a caller has to branch, and EXDEV folded onto EIO like any unknown errno.
        const other = mkdtempSync(join(tmpdir(), 'harness-files-exdev-'));

        try {
            // No second device, no EXDEV: skip rather than assert a rename that would succeed.
            if (statSync(other).dev === statSync(workdir).dev) return;

            await seed('exdev/source.txt', 'aaa');

            const destination = join(other, 'moved.txt');
            const destinationPath = posix(destination);
            const sourcePath = posix(join(workdir, 'exdev/source.txt'));

            // The destination EXISTS and `overwrite` removes it first, so this one call exercises
            // the EXDEV code AND the EXTRA-1 half-state: the removal already destroyed the
            // destination's content when the rename failed, and nothing is rolled back.
            writeFileSync(destination, 'was here');

            const rejection = await rejectionOf(
                files([{ op: 'move', from: 'exdev/source.txt', to: destinationPath, overwrite: true }])
            );

            expect(rejection.code).toBe('EXDEV');
            // The batch wrapper's published sentence is the one that rejects the CALL, so it is
            // pinned first: `files failed on <op> <path>: <the op's own refusal> Operations
            // already applied: <ops>. No rollback was performed.` (./files.tool.ts:2180).
            expect(rejection.message).toContain(`files failed on move ${sourcePath}: `);
            // Then the refusal the wrapper re-quotes verbatim: the site prefix, the code
            // UNFOLDED (no `(RAW)` next to it, no EIO anywhere), and the reason reduced to
            // `cross-device link not permitted (rename)` — `reasonOf` (./files.tool.ts:823)
            // strips Node's `, rename '<from>' -> '<to>'` tail, so each path is named once by
            // the site instead of twice (M10). Pinned as a substring, not as the whole message,
            // so the batch tail above and the remedy below stay separate assertions.
            expect(rejection.message).toContain(
                `files move failed on ${sourcePath} -> ${destinationPath}: EXDEV: cross-device link not permitted (rename).`
            );
            // The strip is the point: the raw two-path clause must not come back, or the
            // sentence restates a location the caller was just given.
            expect(rejection.message).not.toContain(", rename '");
            expect(rejection.message).not.toContain('(EXDEV)');
            expect(rejection.message).not.toContain('EIO');
            // The remedy is the two calls, written out — an errno is not an instruction.
            expect(rejection.message).toContain(
                `{ "op": "copy", "from": "${sourcePath}", "to": "${destinationPath}" }, then { "op": "delete", "path": "${sourcePath}" }`
            );
            // EXTRA-1: the destroyed destination is stated AND carried as data, because
            // "Operations already applied: none" is about the OTHER entries of the call.
            expect(rejection.message).toContain(
                `The existing destination "${destinationPath}" (file, 0 entries) was already removed when this move failed, ` +
                    `so that name is now free; the source "${sourcePath}" is still there. Nothing was rolled back, ` +
                    `and re-running this move after fixing the cause will not restore what the destination held.`
            );
            expect(rejection.details?.failure?.details).toEqual({
                path: sourcePath,
                to: destinationPath,
                code: 'EXDEV',
                replaced: { path: destinationPath, kind: 'file', entries: 0 },
                sourceStillExists: true
            });
            expect(rejection.details?.rollback).toBe(false);
            expect(await readTextFile(join(workdir, 'exdev/source.txt'), 'utf8')).toBe('aaa');
            // The destination's old content is gone: that removal is not undone by the refusal.
            await expect(readTextFile(destination, 'utf8')).rejects.toThrow();
        } finally {
            rmSync(other, { recursive: true, force: true });
        }
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
        // verifies emptiness with `readdir` and then removes the name with `rmdir` (EXTRA-5 —
        // see the test below for why that removal is not a `rm`).
        expect(result.results[0]).toEqual({
            op: 'delete',
            path: posix(join(workdir, 'vacant')),
            removed: true,
            recursive: false
        });
        expect(await lstat(join(workdir, 'vacant')).catch(() => undefined)).toBeUndefined();
    });

    it('removes a verified-empty directory with rmdir, so a race cannot delete a tree nobody asked for', async () => {
        if (!permissionsBind) return;

        await dir('race/empty');

        // EXTRA-5: emptiness is decided by `readdir`, but the removal used to be
        // `rm(path, { recursive: true })` — which deletes whatever stands under the name BY THE
        // TIME IT RUNS, so anything a concurrent writer put in the directory between the two
        // awaits went with it although the caller never passed `recursive`. `rmdir` is the exact
        // operation: it takes an EMPTY directory and answers ENOTEMPTY when the race filled it,
        // so the race surfaces as a refusal instead of as a silent tree deletion.
        //
        // The proof is the SYSCALL NAME. The parent is read-only, so the removal itself is what
        // fails, and the failing syscall is in the message: `rm` reaches the name through
        // `unlinkat`, this path has to reach it through `rmdir`. The path is named ONCE (M10) —
        // the sentence already carries it, so the errno is rendered in the location-free form.
        const parent = join(workdir, 'race');

        await chmod(parent, 0o500);

        const rejection = await (async () => {
            try {
                return await rejectionOf(files([{ op: 'delete', path: 'race/empty' }]));
            } finally {
                // Restored in `finally` so a failing assertion cannot strand a read-only
                // directory for the rest of the run or for ./afterAll's cleanup.
                await chmod(parent, 0o755);
            }
        })();

        const emptyPath = posix(join(workdir, 'race/empty'));

        expect(rejection.code).toBe('EACCES');
        expect(rejection.message).toContain(`files delete failed on ${emptyPath}: EACCES: permission denied (rmdir).`);
        expect(rejection.message).not.toContain('unlinkat');
        // EACCES is a PUBLISHED code, so nothing was folded and `rawCode` is absent: the triple
        // in `details` is the machine half a host switches on.
        expect(rejection.details?.failure?.details).toEqual({ path: emptyPath, code: 'EACCES' });
        expect(rejection.message).toContain('Operations already applied: none. No rollback was performed.');
        // The directory is still standing: the failure removed nothing.
        expect((await lstat(join(workdir, 'race/empty'))).isDirectory()).toBe(true);
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
        //
        // M10 (this wave) CHANGED the middle expectation: this sentence already names the
        // path it failed on, so the failure renders in the location-FREE form
        // (`EACCES: permission denied (scandir)`) instead of the self-contained one that
        // prefixes `<CODE> on <path>:`. The old text named the code and the same absolute
        // path twice in one sentence.
        expect(message).toContain('is a directory that could not be listed, so it is treated as non-empty');
        expect(message).toContain('EACCES: permission denied (scandir)');
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

    it('carries the failing op code and the applied list as data on the rejection', async () => {
        await seed('batch/keep.txt', 'aaa');

        const rejection = await rejectionOf(
            files([
                { op: 'move', from: 'batch/keep.txt', to: 'batch/moved.txt' },
                { op: 'delete', path: 'batch/gone.txt' }
            ])
        );

        // M11: the message keeps the shape it always had — it is what the model reads — but the
        // parts a HOST acts on used to exist only inside that sentence. The rejection now
        // re-raises the failing op's own refusal code, and names the applied ops as an array.
        expect(rejection.code).toBe(FILES_REFUSAL_CODES.deleteMissing);
        expect(rejection.message).toContain('Operations already applied: ');
        expect(rejection.message).toContain('No rollback was performed.');
        expect(rejection.details).toEqual({
            op: 'delete',
            path: posix(join(workdir, 'batch/gone.txt')),
            // `path` is the receipt's own path, so a move is named by its SOURCE — the entry the
            // caller has to look for if it wants to undo the batch by hand.
            applied: [`move ${posix(join(workdir, 'batch/keep.txt'))}`],
            appliedCount: 1,
            rollback: false,
            failure: {
                code: FILES_REFUSAL_CODES.deleteMissing,
                // The op's half-state is carried through rather than flattened into the prose,
                // so a caller does not re-parse the sentence to learn what the op reported.
                details: { path: posix(join(workdir, 'batch/gone.txt')), exists: false }
            }
        });
        // The batch is not all-or-nothing: the move really did happen, and nothing undid it.
        expect((await readdir(join(workdir, 'batch'))).sort()).toEqual(['moved.txt']);
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

describe('files cancellation (ECANCELED)', () => {
    // A cancelled call used to be invisible to this tool: `operations` ran to the end and the
    // result said success, so the caller that walked away mid-call was told the batch had
    // applied. It now refuses with the published `ECANCELED` (./cancellation.ts) — one
    // `HarnessError` whose `details` say where work stopped and what already landed, exactly
    // like every other refused mutation here. The channel is the CALL for both op kinds:
    // cancellation is not a fact about one entry (./cancellation.ts's header gives the reason),
    // and this is the one case where a `list` op does NOT report a per-entry `error`.
    const absent = async (path: string): Promise<boolean> =>
        lstat(path).then(
            () => false,
            () => true
        );

    it('refuses a cancelled call with ECANCELED before any operation runs', async () => {
        const made = join(workdir, 'cancel-pre-mkdir');
        const controller = new AbortController();
        controller.abort();

        const rejection = await rejectionOf(
            files.execute({ parameters: [{ op: 'mkdir', path: made }], signal: controller.signal })
        );

        expect(rejection.code).toBe('ECANCELED');
        expect(rejection.message).toBe(
            'files was cancelled (ECANCELED) before any operation ran: the caller\'s abort signal fired, so nothing further ran. Re-run the call if the cancellation was not intended.'
        );
        expect(rejection.details).toEqual({
            rawCode: 'AbortError',
            applied: [],
            appliedCount: 0,
            rollback: false
        });
        // Nothing ran, so nothing exists.
        expect(await absent(made)).toBe(true);
    });

    it('stops a cancelled batch at the next mutation and keeps the applied-ops facts', async () => {
        // The abort below is issued synchronously after `execute`, so it arrives after the
        // top-of-call check and before the first op's own check: the deterministic middle case.
        // The applied-ops list survives the cancellation, which is the whole point of refusing
        // with structured `details` — the caller can tell "nothing applied" from "half applied"
        // without parsing the sentence.
        const first = join(workdir, 'cancel-mid-mkdir-a');
        const second = join(workdir, 'cancel-mid-mkdir-b');
        const controller = new AbortController();

        const pending = files.execute({
            parameters: [
                { op: 'mkdir', path: first },
                { op: 'mkdir', path: second }
            ],
            signal: controller.signal
        });

        controller.abort();

        const rejection = await rejectionOf(pending);

        expect(rejection.code).toBe('ECANCELED');
        expect(rejection.message).toBe(
            `files failed on mkdir ${first}: files was cancelled (ECANCELED) before this operation: the caller's abort signal fired, so nothing further ran. Re-run the call if the cancellation was not intended. Operations already applied: none. No rollback was performed.`
        );
        expect(rejection.details).toEqual({
            op: 'mkdir',
            path: first,
            applied: [],
            appliedCount: 0,
            rollback: false,
            failure: { code: 'ECANCELED', details: { rawCode: 'AbortError' } }
        });
        // Neither directory landed: the batch stopped on its way into op one.
        expect([await absent(first), await absent(second)]).toEqual([true, true]);
    });

    it('refuses a cancelled list op as the call, not as that entry\'s error', async () => {
        // The asymmetry worth a test: a `list` op that FAILS reports `error` inside its own
        // entry and leaves the batch alone, but a cancelled one rejects the whole call, because
        // a cancelled call has no consumer left for a result. `rejectionOf` fails the test if
        // the call resolves, so this cannot pass by falling back to the entry-error channel.
        const controller = new AbortController();

        const pending = files.execute({
            parameters: [
                { op: 'list', path: workdir },
                { op: 'list', path: workdir }
            ],
            signal: controller.signal
        });

        controller.abort();

        const rejection = await rejectionOf(pending);

        expect(rejection.code).toBe('ECANCELED');
        expect(rejection.details?.op).toBe('list');
        expect(rejection.details?.path).toBe(workdir);
        expect(rejection.details?.failure).toEqual({ code: 'ECANCELED', details: { rawCode: 'AbortError' } });
        expect(rejection.message).toContain('files failed on list ');
    });

    it('reports the host\'s own abort reason as rawCode and keeps it as the cause', async () => {
        // `rawCode` keeps its published meaning — present ONLY when it differs from `code`, and
        // then it is the NAME of whatever the host passed to `abort()`. Aborting with an Error
        // therefore reports `Error`, never the fallback `AbortError`, and the host's own object
        // survives as `cause` (src/util/errors.ts assigns `cause` through a cast, so the cast
        // below is how a test reaches it).
        const reason = new Error('host said stop');
        const controller = new AbortController();
        controller.abort(reason);

        const made = join(workdir, 'cancel-reason-mkdir');
        const pending = files.execute({
            parameters: [{ op: 'mkdir', path: made }],
            signal: controller.signal
        });

        const rejection = await rejectionOf(pending);

        expect(rejection.code).toBe('ECANCELED');
        expect(rejection.details).toEqual({
            rawCode: 'Error',
            applied: [],
            appliedCount: 0,
            rollback: false
        });

        const thrown = await pending.catch((error: unknown) => error as { cause?: unknown });
        expect((thrown as { cause?: unknown }).cause).toBe(reason);
        expect(await absent(made)).toBe(true);
    });
});
