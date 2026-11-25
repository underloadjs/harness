// write — the batched write contract (T14).
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
//     are named and there is no claim of a transaction or rollback;
//   - F9: the case where a target's PARENT path runs through an existing FILE is coded
//     `ENOTDIR` with the remedy `read` and `files` already give for that state (folded
//     from mkdir's raw EEXIST/ENOTDIR), inside that same partial-failure wrapper;
//   - M10 (atomic publish): each file is staged in its own directory and renamed into
//     place, so a concurrent reader never observes a partial file, a FAILED entry
//     leaves its own target with its previous content, the file mode survives the
//     inode swap, a symlink still writes through to its target, and no `<name>.tmp-*`
//     staging entry survives a success or a failure;
//   - D7a: a DANGLING symlink is honored the same way — the link is preserved, the
//     file the link NAMES is created (in a directory that may not exist yet, possibly
//     outside the directory the caller named), and the publish stays a same-directory
//     rename beside that file;
//   - D7b: the publish swaps the target's NAME, so a hard link to it keeps the previous
//     bytes under the sibling name — the consequence the published description now
//     discloses.
//
// Fixtures are real files under the repo-root `Temp/`, one unique directory per
// run, removed afterwards (module-relative, same convention as read.test.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    chmod,
    link as hardLink,
    lstat,
    mkdir,
    mkdtemp,
    readFile as readTextFile,
    readFile as readBytes,
    readlink,
    readdir,
    rm,
    stat,
    symlink,
    writeFile as writeTextFile
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { HarnessError } from '../../util';
import { write, FILE_WRITE_ERROR_CODES, WRITE_METADATA } from './write.tool';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

let workdir: string;

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-file-write-'));
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('write', () => {
    it('writes several files in one call, creating parents, and reports exact bytes', async () => {
        const first = join(workdir, 'batch', 'one.txt');
        const second = join(workdir, 'batch', 'deep', 'two.md');

        const result = await write([
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

        await expect(write([{ path: target, content: 'second' }])).resolves.toEqual([
            { path: target, bytes: 6 }
        ]);
        await expect(readTextFile(target, 'utf8')).resolves.toBe('second');

        await expect(write([{ path: target, content: '' }])).resolves.toEqual([
            { path: target, bytes: 0 }
        ]);
        await expect(readTextFile(target, 'utf8')).resolves.toBe('');
    });

    it('publishes through a staging file in the target directory and leaves none behind', async () => {
        // M10. `writeFile` opened the TARGET with O_TRUNC, so the old content was gone
        // before a single byte of the new payload had arrived. The fix stages the payload
        // in a sibling `<name>.tmp-<token>` file and renames it onto the target, so two
        // things are observable and both are pinned here: while the call is in flight a
        // staging entry exists AND the target still holds its full previous text, and
        // once the call settles nothing is left behind. Against the in-place write the
        // first half is impossible (no staging entry ever exists) and the second half of
        // the window shows an empty/partial target instead of `PREVIOUS`.
        const dir = join(workdir, 'staging');
        const target = join(dir, 'payload.txt');
        await mkdir(dir, { recursive: true });
        await writeTextFile(target, 'PREVIOUS', 'utf8');

        // 8 MB of ASCII: the write window is wide enough that the poll below observes the
        // staging entry without any sleep to tune, on any host.
        const payload = 'N'.repeat(8 * 1024 * 1024);
        const pending = write([{ path: target, content: payload }]);

        let stagingSeen = false;
        let targetDuringStaging: string | undefined;

        for (let attempt = 0; attempt < 400 && !stagingSeen; attempt += 1) {
            const staging = await stagingEntries(dir);

            if (staging.length > 0) {
                stagingSeen = true;
                // One writer per call means exactly one staging entry, and the target it
                // is racing has not been touched yet: the rename is the publish point.
                expect(staging).toHaveLength(1);
                targetDuringStaging = await readTextFile(target, 'utf8');
            }
        }

        expect(stagingSeen).toBe(true);
        expect(targetDuringStaging).toBe('PREVIOUS');
        expect(await pending).toEqual([{ path: target, bytes: payload.length }]);
        await expect(readTextFile(target, 'utf8')).resolves.toBe(payload);
        await expect(stagingEntries(dir)).resolves.toEqual([]);
    });

    it('never exposes a partial file to concurrent readers', async () => {
        // M10, the report's own probe: 200 reads racing a 2 MB write produced 3 PREFIXES
        // of the new text, because O_TRUNC emptied the file at open. A rename cannot
        // publish an in-between state — an open() lands on the old inode or the new one —
        // so every observation must be byte-for-byte one of the two complete files.
        // Complete-file equality (not "length is plausible") is what makes this exact:
        // any other size is recorded as `partial:<n>` and fails the assertion.
        const dir = join(workdir, 'concurrent');
        const target = join(dir, 'large.txt');
        await mkdir(dir, { recursive: true });

        const previousBytes = Buffer.from('P'.repeat(2 * 1024 * 1024), 'utf8');
        const nextText = `${'N'.repeat(2 * 1024 * 1024)}-TAIL`;
        const nextBytes = Buffer.from(nextText, 'utf8');
        await writeTextFile(target, previousBytes);

        const pending = write([{ path: target, content: nextText }]);
        const observations = await Promise.all(
            Array.from({ length: 200 }, async () => {
                try {
                    const bytes = await readBytes(target);

                    if (bytes.equals(previousBytes)) return 'previous';
                    if (bytes.equals(nextBytes)) return 'next';

                    return `partial:${bytes.length}`;
                } catch (error) {
                    // A missing target would mean the publish unlinked the file before
                    // renaming, i.e. a window no caller asked for. Named, not swallowed.
                    return `missing:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`;
                }
            })
        );

        // Nothing may sit between the two complete states.
        expect(observations.filter((kind) => kind !== 'previous' && kind !== 'next')).toEqual([]);
        expect(await pending).toEqual([{ path: target, bytes: nextBytes.length }]);
        await expect(readTextFile(target, 'utf8')).resolves.toBe(nextText);
        await expect(stagingEntries(dir)).resolves.toEqual([]);
    });

    it('leaves the failed entry with its previous content and no staging leftovers', async () => {
        // M10, deterministic stand-in for "ENOSPC or a kill mid-write": the target's
        // directory is made read-only AFTER the target exists, so the staging file cannot
        // be created and the call must fail before it can publish. Note this fixture only
        // fails with the fix — the in-place write opened the target's own inode, which a
        // DIRECTORY permission does not gate, so that call wrote straight through. What
        // is pinned is the promise the error message makes: the earlier file really is on
        // disk complete, and the file that failed really still holds what it had.
        const dir = join(workdir, 'failed-entry');
        const locked = join(dir, 'locked');
        const writable = join(dir, 'writable');
        await mkdir(locked, { recursive: true });
        await mkdir(writable, { recursive: true });

        // Capability probe, in the style of the symlink guards below: `root` ignores the
        // directory write bit and Windows has no such bit, and on those hosts there is no
        // failure to construct, so the case is skipped openly instead of being weakened.
        await chmod(locked, 0o500);

        let createBlocked = false;

        try {
            await writeTextFile(join(locked, 'probe.txt'), 'x', 'utf8');
        } catch {
            createBlocked = true;
        }

        if (!createBlocked) {
            await rm(join(locked, 'probe.txt'), { force: true });
            await chmod(locked, 0o700);

            return;
        }

        const failing = join(locked, 'target.txt');
        await chmod(locked, 0o700);
        await writeTextFile(failing, 'PREVIOUS', 'utf8');
        await chmod(locked, 0o500);

        const completed = join(writable, 'done.txt');

        try {
            await expect(
                write([
                    { path: completed, content: 'written' },
                    { path: failing, content: 'NEVER WRITTEN' }
                ])
            ).rejects.toThrow(
                new RegExp(
                    `^write failed on ${escapeRegExp(failing)}: (EACCES|EPERM|EROFS).* Writes already completed: ${escapeRegExp(
                        completed
                    )}\\. No rollback was performed\\.$`
                )
            );

            await expect(readTextFile(completed, 'utf8')).resolves.toBe('written');
            // The entry the message only names in its prefix is the one the fix keeps
            // whole: byte-for-byte the previous text, not a prefix of the rejected one.
            await expect(readTextFile(failing, 'utf8')).resolves.toBe('PREVIOUS');
            // And the rejected payload left no litter in the read-only directory.
            await expect(stagingEntries(locked)).resolves.toEqual([]);
        } finally {
            // The fixture directory has to be writable again for the suite cleanup.
            await chmod(locked, 0o700);
        }
    });

    it('keeps the file mode when it replaces an existing file', async () => {
        // M10 traded an inode swap for atomicity, and an inode swap loses the mode unless
        // it is copied onto the staging file: a 0755 script that came back 0644 would
        // silently stop being executable, which is exactly what in-place writing kept.
        const target = join(workdir, 'mode.txt');
        await writeTextFile(target, '#!/bin/sh\n', 'utf8');
        await chmod(target, 0o755);
        const before = (await stat(target)).mode & 0o7777;

        // The contract is "unchanged by the write", and it has to be checked against a
        // mode that is worth losing: on POSIX that is the 0755 just set (Windows chmod
        // only models the read-only flag, so it asserts the equality alone).
        if (process.platform !== 'win32') expect(before).toBe(0o755);

        await expect(write([{ path: target, content: '#!/bin/sh\n# v2\n' }])).resolves.toEqual([
            { path: target, bytes: 15 }
        ]);

        const after = await stat(target);
        expect(after.mode & 0o7777).toBe(before);
        expect(after.isFile()).toBe(true);
    });

    it('writes through a symlink and keeps the link itself', async () => {
        // A rename replaces a NAME, so renaming onto the LINK path would delete the link
        // and leave a regular file where an alias used to be. The staging file and the
        // rename therefore go to the RESOLVED target, which is also what keeps the rename
        // on one device and what ./identity.ts (duplicate-target preflight) assumes.
        const dir = join(workdir, 'symlink');
        const real = join(dir, 'real.txt');
        await mkdir(dir, { recursive: true });
        await writeTextFile(real, 'original', 'utf8');

        const link = join(dir, 'alias.txt');

        try {
            await symlink(real, link, 'file');
        } catch {
            // Link creation is privileged on Windows: nothing to prove on this host.
            await expect(readTextFile(real, 'utf8')).resolves.toBe('original');

            return;
        }

        // The reported path is the spelling the caller asked for, not the resolved file.
        await expect(write([{ path: link, content: 'updated' }])).resolves.toEqual([
            { path: link, bytes: 7 }
        ]);

        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        await expect(readTextFile(real, 'utf8')).resolves.toBe('updated');
        // The directory holds exactly the link and its target: no staging entry beside
        // either of them.
        expect((await readdir(dir)).sort()).toEqual(['alias.txt', 'real.txt']);
    });

    it('writes through a dangling symlink, keeping the link and creating its target', async () => {
        // D7a. `realpath` cannot walk past the missing end of a dangling link, so the staged
        // publish used to rename onto the LINK path: `lstat(path).isFile()` came back true,
        // the name the link pointed at was STILL missing, and the receipt reported success as
        // if nothing had changed — while the pre-fix in-place write had created the target and
        // kept the link. Landing on the end of the chain is what honors a dangling link the
        // way a live one is already honored: same link inode, same readlink, and the payload
        // in the file the link names.
        const dir = join(workdir, 'dangling-target');
        const link = join(dir, 'dangling.txt');
        const real = join(dir, 'target.txt');
        await mkdir(dir, { recursive: true });

        try {
            // Absolute link text whose target does not exist: a dangling link.
            await symlink(real, link, 'file');
        } catch {
            // Link creation is privileged on Windows: nothing to prove on this host.
            await expect(stagingEntries(dir)).resolves.toEqual([]);

            return;
        }

        const linkInode = (await lstat(link)).ino;
        // 'dangling ✓' is 11 characters but 12 UTF-8 BYTES (✓ is 3), so the number below is
        // the real payload size rather than the string length the pre-fix receipt also was.
        const content = 'dangling ✓';

        // The reported path is still the spelling the caller asked for.
        await expect(write([{ path: link, content }])).resolves.toEqual([{ path: link, bytes: 12 }]);

        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect((await lstat(link)).ino).toBe(linkInode);
        await expect(readlink(link)).resolves.toBe(real);
        // The name the link named is the entry that exists now, with the whole payload.
        await expect(readTextFile(real, 'utf8')).resolves.toBe(content);
        // Exactly the link and its target: the staging file sat in this same directory (one
        // device, so the rename was atomic) and is gone.
        expect((await readdir(dir)).sort()).toEqual(['dangling.txt', 'target.txt']);
        await expect(stagingEntries(dir)).resolves.toEqual([]);
    });

    it('creates the missing parent of a dangling symlink target, relative to the link', async () => {
        // D7a, the probe's `dangling.txt -> missing/deep/target.txt` shape with a RELATIVE
        // link text. Two things are pinned: a link's text is relative to the LINK's own
        // directory (not to `process.cwd()`), and the landing's parent is created on demand —
        // the write loop only ever creates the parent of the CALLER's spelling, which already
        // exists because that is where the link lives.
        const dir = join(workdir, 'dangling-parent');
        const link = join(dir, 'dangling.txt');
        const relative = join('missing', 'deep', 'target.txt');
        const real = join(dir, relative);
        await mkdir(dir, { recursive: true });

        try {
            await symlink(relative, link, 'file');
        } catch {
            await expect(stagingEntries(dir)).resolves.toEqual([]);

            return;
        }

        await expect(write([{ path: link, content: 'deep\n' }])).resolves.toEqual([
            { path: link, bytes: 5 }
        ]);

        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        await expect(readlink(link)).resolves.toBe(relative);
        await expect(readTextFile(real, 'utf8')).resolves.toBe('deep\n');
        // `missing/` was created INSIDE the link's own directory, and nothing was created in
        // the working directory under the relative spelling.
        expect((await readdir(dir)).sort()).toEqual(['dangling.txt', 'missing']);
        expect((await readdir(join(dir, 'missing', 'deep'))).sort()).toEqual(['target.txt']);
        await expect(stagingEntries(dir)).resolves.toEqual([]);
    });

    it('honors a dangling symlink whose target lives in another directory, leaving no temp file', async () => {
        // D7a, the cross-directory shape: the link lives in `links/` and names a missing file
        // under `elsewhere/nested/`. The staging file therefore goes in the TARGET's new
        // directory — the same one the rename publishes into, which is what keeps the publish
        // a same-directory rename — and neither directory keeps a `<name>.tmp-*` entry, nor a
        // stray file that never got renamed.
        const base = join(workdir, 'dangling-outside');
        const linkDir = join(base, 'links');
        const targetDir = join(base, 'elsewhere', 'nested');
        const link = join(linkDir, 'alias.txt');
        const real = join(targetDir, 'real.txt');
        await mkdir(linkDir, { recursive: true });
        // `elsewhere/` exists; `nested/` does not, and only the write creates it.
        await mkdir(join(base, 'elsewhere'), { recursive: true });

        try {
            await symlink(real, link, 'file');
        } catch {
            await expect(stagingEntries(linkDir)).resolves.toEqual([]);

            return;
        }

        await expect(write([{ path: link, content: 'out\n' }])).resolves.toEqual([
            { path: link, bytes: 4 }
        ]);

        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        await expect(readlink(link)).resolves.toBe(real);
        await expect(readTextFile(real, 'utf8')).resolves.toBe('out\n');
        // Each directory holds exactly the one entry the write was asked to produce: no
        // staging leftover beside the link AND none beside the freshly created target.
        expect((await readdir(linkDir)).sort()).toEqual(['alias.txt']);
        expect((await readdir(targetDir)).sort()).toEqual(['real.txt']);
        await expect(stagingEntries(linkDir)).resolves.toEqual([]);
        await expect(stagingEntries(targetDir)).resolves.toEqual([]);
    });

    it('leaves a hard-link sibling with the previous bytes when the target is rewritten', async () => {
        // D7b. The publish renames a NEW inode onto the name, so a sibling name sharing the
        // OLD inode keeps the OLD content byte for byte: `a.txt` and `b.txt` are one file
        // before the call and two files after it. That is inherent to a rename (the caller
        // named one path, and rewriting both would edit a file nobody asked about), and it is
        // now disclosed in the published description — pinned here so the disclosure cannot
        // drift away from the behavior.
        const dir = join(workdir, 'hardlink');
        const first = join(dir, 'a.txt');
        const sibling = join(dir, 'b.txt');
        await mkdir(dir, { recursive: true });
        await writeTextFile(first, 'shared\n', 'utf8');

        try {
            await hardLink(first, sibling);
        } catch {
            // Hard links are privileged on Windows without Developer Mode: nothing to prove.
            await expect(readTextFile(first, 'utf8')).resolves.toBe('shared\n');

            return;
        }

        const sharedInode = (await stat(sibling)).ino;

        await expect(write([{ path: first, content: 'rewritten\n' }])).resolves.toEqual([
            { path: first, bytes: 10 }
        ]);

        await expect(readTextFile(first, 'utf8')).resolves.toBe('rewritten\n');
        await expect(readTextFile(sibling, 'utf8')).resolves.toBe('shared\n');
        // The sibling is still the OLD inode holding the old file; the target moved to a new
        // one, which is exactly the trade the atomic publish buys.
        expect((await stat(sibling)).ino).toBe(sharedInode);
        expect((await stat(first)).ino).not.toBe(sharedInode);
        await expect(stagingEntries(dir)).resolves.toEqual([]);
    });

    it('fails on a target that is a directory without leaving a staging file inside it', async () => {
        // The one failure path that really does have a temp file to clean up: the target
        // directory is writable, so the staging file is created (and its mode copied) and
        // only the rename onto the directory fails. The directory keeps its children and
        // ends with exactly one entry.
        const dir = join(workdir, 'is-dir');
        await mkdir(dir, { recursive: true });
        await writeTextFile(join(dir, 'keep.txt'), 'keep', 'utf8');

        await expect(write([{ path: dir, content: 'nope' }])).rejects.toThrow(
            new RegExp(
                `^write failed on ${escapeRegExp(dir)}: .* Writes already completed: none\\. No rollback was performed\\.$`
            )
        );

        await expect(readTextFile(join(dir, 'keep.txt'), 'utf8')).resolves.toBe('keep');
        expect((await readdir(dir)).sort()).toEqual(['keep.txt']);
    });

    it('resolves relative paths against the working directory', async () => {
        const previous = process.cwd();
        process.chdir(workdir);

        try {
            await expect(write([{ path: 'relative.txt', content: 'x' }])).resolves.toEqual([
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
            write([
                { path: first, content: 'should not exist' },
                { path: '', content: 'x' }
            ])
        ).rejects.toThrow('write files require a non-empty "path" string.');

        // Preflight means the valid first entry was never written.
        await expect(readTextFile(first, 'utf8')).rejects.toThrow();
    });

    it('rejects the same resolved target twice, including an aliased spelling', async () => {
        const target = join(workdir, 'duplicate.txt');

        await expect(
            write([
                { path: target, content: 'one' },
                { path: join(workdir, '.', 'duplicate.txt'), content: 'two' }
            ])
        ).rejects.toThrow(
            `write received the same target path twice (${target}); write each file once per call.`
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
                write([
                    { path: lower, content: 'one' },
                    { path: upper, content: 'two' }
                ])
            ).rejects.toThrow(
                `write received the same target path twice (${upper}); write each file once per call.`
            );

            // Preflight means the first entry never ran: the file keeps its text.
            await expect(readTextFile(lower, 'utf8')).resolves.toBe('first');
            return;
        }

        // Linux: two distinct files, so both are written and both are reported.
        await expect(
            write([
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
            write([
                { path: plain, content: 'one' },
                { path: dotted, content: 'two' }
            ])
        ).rejects.toThrow(
            `write received the same target path twice (${dotted}); write each file once per call.`
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
            write([
                { path: real, content: 'one' },
                { path: throughLink, content: 'two' }
            ])
        ).rejects.toThrow(
            `write received the same target path twice (${throughLink}); write each file once per call.`
        );

        await expect(readTextFile(real, 'utf8')).resolves.toBe('original');
    });

    it('rejects an empty array, a non-array, and malformed entries', async () => {
        await expect(write([])).rejects.toThrow(
            'write received an empty files array; pass at least one entry.'
        );
        await expect(write('a.txt' as never)).rejects.toThrow(
            'write expects an array of { path, content } entries, e.g. [{"path":"a.txt","content":"hi"}].'
        );
        await expect(write([null] as never)).rejects.toThrow(
            'write files must be objects with "path" and "content" strings.'
        );
        await expect(write([{ path: 'a.txt' }] as never)).rejects.toThrow(
            'write files require a "content" string.'
        );
        await expect(write([{ path: 'a\u0000b', content: 'x' }])).rejects.toThrow(
            'write paths must not contain NUL characters.'
        );
    });

    it('rejects NUL content in preflight, without creating the earlier valid entry', async () => {
        // A NUL byte is the harness's own binary marker, so a file containing one is
        // rejected by read. Writing it would create an artifact this package
        // cannot read back; the whole batch is refused before the first write.
        const untouched = join(workdir, 'nul', 'first.txt');
        const rejected = join(workdir, 'nul', 'second.txt');

        await expect(
            write([
                { path: untouched, content: 'fine' },
                { path: rejected, content: 'a\u0000b' }
            ])
        ).rejects.toThrow(
            `write content must not contain NUL characters (${rejected}): the file would be unreadable by read, which rejects binary content.`
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

        const failure = await failureOf(() =>
            write([
                { path: completed, content: 'written' },
                { path: failing, content: 'never' }
            ])
        );

        // The wrapper contract, unchanged by the F9 fold below: failed target, the list of
        // writes that really landed, and the explicit no-rollback claim.
        expect(failure.message).toMatch(
            new RegExp(
                `^write failed on ${escapeRegExp(failing)}: .* Writes already completed: ${escapeRegExp(
                    completed
                )}\\. No rollback was performed\\.$`
            )
        );

        // F9: the `.*` above used to hide Node's raw `EEXIST: file already exists, mkdir
        // '<x>'` with no next step, while `read` (./read.tool.ts:4532-4536) and `files`
        // (./files.tool.ts:978-987) answer this same state with ENOTDIR plus a remedy.
        // Pinned in full now — the mkdir target here is `blocker` ITSELF (the parent of
        // `failing`), and mkdir of an existing regular file answers EEXIST on every
        // platform, so the folded label, the reason and the remedy are all exact.
        expect(failure.code).toBe('ENOTDIR');
        expect(failure.name).toBe('ENOTDIR');
        expect(failure.message).toBe(
            `write failed on ${failing}: ENOTDIR (EEXIST): file already exists (mkdir). ` +
                'A component of that path is a file, not a folder; the directory cannot be created inside it. ' +
                'Delete that file, or write the target under a path whose parents are folders. ' +
                `Writes already completed: ${completed}. No rollback was performed.`
        );
        // `rawCode` is present because the fold moved away from it (EEXIST -> ENOTDIR), and
        // `failedPath`/`completedPaths` keep the shape M11 published.
        expect(failure.details).toEqual({ failedPath: failing, completedPaths: [completed], rawCode: 'EEXIST' });

        // The first file really is on disk: the message is the truth, not a guess.
        await expect(readTextFile(completed, 'utf8')).resolves.toBe('written');
    });

    it('rejects a batch larger than the published cap, before writing anything', async () => {
        // D9. `read` refused more than 100 paths but `write` accepted 400 — and write is
        // the file tool that carries unbounded PAYLOAD, since every entry holds a whole
        // file's text. One call could therefore create an arbitrary number of files of
        // an arbitrary size with no budget anywhere in the path.
        const tooMany = Array.from({ length: 101 }, (_, index) => ({
            path: join(workdir, 'cap', `${index}.txt`),
            content: 'x'
        }));

        await expect(write(tooMany)).rejects.toThrow(
            'write accepts at most 100 files per call; received 101. Split the batch.'
        );
        // Rejected in preflight, so the batch that was refused wrote nothing at all.
        await expect(readTextFile(join(workdir, 'cap', '0.txt'), 'utf8')).rejects.toThrow(/ENOENT/);

        // Exactly at the cap is accepted.
        const atCap = Array.from({ length: 100 }, (_, index) => ({
            path: join(workdir, 'cap-ok', `${index}.txt`),
            content: 'x'
        }));
        expect((await write(atCap)).length).toBe(100);
    });

    it('creates one directory once, however many files name it', async () => {
        // D9. Sixty files in one new directory used to mean sixty `mkdir` calls: measured
        // at 85 ms to write 60 bytes in total, so the bookkeeping cost more than the
        // content. Deduplicating by directory must not change what gets created — every
        // file still exists, including in a directory named for the first time by a later
        // entry — it only removes repeat syscalls.
        const first = join(workdir, 'mkdir-dedupe', 'shared');
        const entries = [
            ...Array.from({ length: 30 }, (_, index) => ({ path: join(first, `${index}.txt`), content: `f${index}` })),
            // A second directory, named only by the last entries, still gets created.
            ...Array.from({ length: 5 }, (_, index) => ({
                path: join(workdir, 'mkdir-dedupe', 'other', `${index}.txt`),
                content: `o${index}`
            }))
        ];

        const result = await write(entries);

        expect(result).toHaveLength(35);
        await expect(readTextFile(join(first, '29.txt'), 'utf8')).resolves.toBe('f29');
        await expect(readTextFile(join(workdir, 'mkdir-dedupe', 'other', '4.txt'), 'utf8')).resolves.toBe('o4');
        // The reported byte sizes are still per file, not per directory.
        expect(result[0]).toEqual({ path: join(first, '0.txt'), bytes: 2 }); // 'f0'
        expect(result[30]).toEqual({ path: join(workdir, 'mkdir-dedupe', 'other', '0.txt'), bytes: 2 }); // 'o0'
    });

    it('declares a single "files" array property of { path, content } objects', () => {
        expect(write.parameters).toEqual({
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    maxItems: 100,
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
        expect(toolParameterKey(write.parameters)).toBe('files');
    });

    it('runs through the execute path with the array a harness would pass', async () => {
        const target = join(workdir, 'execute-path.txt');

        await expect(write.execute({ parameters: [{ path: target, content: 'ok' }] })).resolves.toEqual([
            { path: target, bytes: 2 }
        ]);
    });
});

// A path interpolated into a RegExp needs its Windows separators and dots escaped.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The staging entries of one directory: the fix publishes through a sibling
// `<name>.tmp-<token>` file, so during a write exactly one of these exists, and after
// either a success or a failure the list is empty. Sorted so a comparison is stable.
const stagingEntries = async (dir: string): Promise<string[]> =>
    (await readdir(dir)).filter((name) => name.includes('.tmp-')).sort();

// The thrown failure as a VALUE, so `code` and `details` (M11) can be asserted next to the
// sentence. `toThrow(errorInstance)` compares the message and nothing machine-readable.
const failureOf = async (call: () => Promise<unknown>): Promise<HarnessError> => {
    const failure = await call().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HarnessError);

    return failure as HarnessError;
};

// A FIFO (named pipe) at `path`, false when this host has no `mkfifo`. L5's fixture: a pipe
// is a perfectly creatable name that is not a file, and the publish would rename a regular
// file on top of it, leaving a reader holding a node nobody asked to replace.
const makeFifo = (path: string): boolean => spawnSync('mkfifo', [path]).status === 0;

describe('write - the published refusals and disclosures (L5, L6, M9, M11, H6)', () => {
    it('refuses a FIFO instead of renaming a regular file onto it', async () => {
        const dir = join(workdir, 'l5-fifo');
        const fifo = join(dir, 'pipe.txt');
        await mkdir(dir, { recursive: true });

        if (!makeFifo(fifo)) {
            await expect(readdir(dir)).resolves.toEqual([]);

            return;
        }

        const startedAt = Date.now();
        const failure = await failureOf(() => write([{ path: fifo, content: 'nope' }]));
        const elapsedMs = Date.now() - startedAt;

        expect(failure.code).toBe('EOPNOTSUPP');
        expect(failure.name).toBe('EOPNOTSUPP');
        // The refusal sentence is the shared one from ./atomic-publish.ts, inside this tool's
        // batch-failure wrapper, so `write` and `edit` cannot disagree about what a file is.
        expect(
            failure.message.startsWith(
                `write failed on ${fifo}: write refused ${fifo}: the target is a FIFO (named pipe), not a regular file. `
            )
        ).toBe(true);
        expect(failure.message.endsWith(' Writes already completed: none. No rollback was performed.')).toBe(true);
        // Refused BEFORE any staging file existed, so the pipe's directory is untouched.
        await expect(stagingEntries(dir)).resolves.toEqual([]);
        expect((await lstat(fifo)).isFIFO()).toBe(true);
        expect(elapsedMs).toBeLessThan(5_000);
    });

    it('refuses a character device instead of writing through it', async () => {
        // `/dev/null` used to be happily "written": the in-place open succeeded, the bytes
        // vanished, and the receipt reported success with a byte count for a file that cannot
        // hold any. Staging cannot create a sibling in /dev for an unprivileged process at
        // all, so both halves of that answer are gone — the target is refused for what it is.
        let isCharDevice = false;

        try {
            isCharDevice = (await lstat('/dev/null')).isCharacterDevice();
        } catch {
            isCharDevice = false;
        }

        if (!isCharDevice) return;

        const failure = await failureOf(() => write([{ path: '/dev/null', content: 'x' }]));

        expect(['EOPNOTSUPP', 'EACCES']).toContain(failure.code);
        expect(failure.message).toContain('Writes already completed: none. No rollback was performed.');
    });

    it('refuses a directory with the node type in the published code', async () => {
        // The sentence is pinned by the test above; what this adds is the machine-readable
        // half (M11) — EISDIR, not a prose guess — and the fact that no staging file was
        // created inside the directory on the way to that answer.
        const dir = join(workdir, 'l5-dir-code');
        await mkdir(dir, { recursive: true });
        await writeTextFile(join(dir, 'keep.txt'), 'keep', 'utf8');

        const failure = await failureOf(() => write([{ path: dir, content: 'nope' }]));

        expect(failure.code).toBe('EISDIR');
        expect(failure.name).toBe('EISDIR');
        expect((await readdir(dir)).sort()).toEqual(['keep.txt']);
    });

    it('carries a 0000 mode onto the file it publishes', async () => {
        // The mode-preservation claim is about ANY existing mode, not just the executable one
        // the test above pins: the publish copies the low permission bits onto the staging
        // file, so a 0000 target comes back 0000 (and NOT the 0600 a fresh create would have
        // picked). Asserted through `stat`, because on an unprivileged host the file cannot be
        // read back at that mode — the size and the code are the observable halves.
        const path = join(workdir, 'mode-0000.txt');
        await writeTextFile(path, 'PREVIOUS', 'utf8');
        await chmod(path, 0o000);

        await expect(write([{ path, content: 'replaced' }])).resolves.toEqual([{ path, bytes: 8 }]);

        const after = await stat(path);
        expect(after.isFile()).toBe(true);
        expect(after.size).toBe(8);
        if (process.platform !== 'win32') expect(after.mode & 0o777).toBe(0);
    });

    it('refuses an unknown field by name instead of ignoring it', async () => {
        // M9. The schema says `additionalProperties: false`, but the direct call path never
        // sees the schema, and an unknown key used to be destructured away: `{ path, content,
        // overwrite: false }` wrote straight through the flag the caller thought they set.
        const path = join(workdir, 'm9-unknown-field.txt');

        const failure = await failureOf(() =>
            write([{ path, content: 'x', overwrite: true } as never])
        );

        expect(failure.message).toBe(
            'write files entries do not accept "overwrite". Allowed fields: path, content.'
        );

        const exists = await stat(path).then(
            () => true,
            () => false
        );
        expect(exists).toBe(false);
    });

    it('discloses an unpaired surrogate as lossy, with the exact bytes that landed', async () => {
        // L6. A lone surrogate has no UTF-8 encoding, so the encoder substitutes U+FFFD and
        // the original code point is GONE: re-reading the file cannot reveal it, and the
        // byte count the receipt reports is not the caller's string length. This call is the
        // only place that fact can be said, so `lossy: true` is the disclosure.
        const path = join(workdir, 'l6-lone-surrogate.txt');
        const content = 'a\uD800b';

        await expect(write([{ path, content }])).resolves.toEqual([
            { path, bytes: Buffer.byteLength(content, 'utf8'), lossy: true }
        ]);

        // 'a', U+FFFD (ef bf bd), 'b' — five bytes, and the surrogate is unrecoverable.
        await expect(readBytes(path)).resolves.toEqual(Buffer.from([0x61, 0xef, 0xbf, 0xbd, 0x62]));
        expect(Buffer.byteLength(content, 'utf8')).toBe(5);
    });

    it('does not flag a paired astral character as lossy', async () => {
        // The other side of the flag: a real surrogate PAIR encodes fine, so a test that only
        // asserted the lossy case would pass even if every write were flagged. No `lossy`
        // key at all — the exact receipt shape.
        const path = join(workdir, 'l6-paired.txt');

        await expect(write([{ path, content: 'a😀b' }])).resolves.toEqual([
            { path, bytes: 6 }
        ]);

        await expect(readBytes(path)).resolves.toEqual(
            Buffer.from([0x61, 0xf0, 0x9f, 0x98, 0x80, 0x62])
        );
    });

    it('reports the failing path and the completed paths as data, not only as prose', async () => {
        // M11, on the same fixture the sentence-level test above uses: the OS error is also a
        // code from the published set, and the completed list is a field a caller can switch
        // on instead of parsing out of a sentence.
        const dir = join(workdir, 'm11-partial');
        const locked = join(dir, 'locked');
        const writable = join(dir, 'writable');
        await mkdir(locked, { recursive: true });
        await mkdir(writable, { recursive: true });

        await chmod(locked, 0o500);

        let createBlocked = false;

        try {
            await writeTextFile(join(locked, 'probe.txt'), 'x', 'utf8');
        } catch {
            createBlocked = true;
        }

        if (!createBlocked) {
            await rm(join(locked, 'probe.txt'), { force: true });
            await chmod(locked, 0o700);

            return;
        }

        const failing = join(locked, 'target.txt');
        await chmod(locked, 0o700);
        await writeTextFile(failing, 'PREVIOUS', 'utf8');
        await chmod(locked, 0o500);

        const completed = join(writable, 'done.txt');

        try {
            const failure = await failureOf(() =>
                write([
                    { path: completed, content: 'written' },
                    { path: failing, content: 'NEVER WRITTEN' }
                ])
            );

            expect(['EACCES', 'EPERM', 'EROFS']).toContain(failure.code);
            expect(FILE_WRITE_ERROR_CODES).toContain(failure.code);
            expect((failure.details as { failedPath: string }).failedPath).toBe(failing);
            expect((failure.details as { completedPaths: string[] }).completedPaths).toEqual([completed]);

            await expect(readTextFile(completed, 'utf8')).resolves.toBe('written');
            await expect(readTextFile(failing, 'utf8')).resolves.toBe('PREVIOUS');
            await expect(stagingEntries(locked)).resolves.toEqual([]);
        } finally {
            await chmod(locked, 0o700);
        }
    });

    it('publishes the per-process qualifier and the new disclosures (H6, C2, L5, L6)', async () => {
        // The description IS the contract a model reads, so each of these clauses is the
        // published form of a behavior pinned by a test in this file. The lock qualifier is
        // the H6 fix: ./lock.ts is one Map on one event loop, and a worker-thread lane has
        // its own (../../server/config.ts), so an unqualified promise was false on the
        // configuration the server can be configured onto.
        const description = WRITE_METADATA.description;

        expect(description).toContain(
            'serialized per file (in this process only - a second harness process or a worker-thread lane keeps its own locks)'
        );
        expect(description).toContain('this write wins and that change is gone');
        expect(description).toContain('never a partial write');
        expect(description).toContain('a hard link to it keeps the previous bytes');
        expect(description).toContain('a read-only existing file can still be overwritten');
        expect(description).toContain(
            'a target that is not a regular file (a directory, a FIFO, a device) is refused instead of silently replaced'
        );
        expect(description).toContain('so that entry says `lossy: true`');
        expect(description).toContain(
            'an entry naming any field other than `path` or `content` is rejected rather than ignored'
        );
        // T14: a cancelled call now refuses with the published `ECANCELED` (./cancellation.ts),
        // and the sentence the model reads says so — a code that lives only in the exported set
        // is a code the model cannot branch on. It was paid for INSIDE the existing failure
        // sentence instead of appended as a new one, so the description grew by one clause and
        // no ceiling moved.
        expect(description).toContain(
            'a cancelled call rejects with `ECANCELED` naming the files already written: there is no rollback'
        );
    });

    it('reports a symlink loop as ELOOP, never as the transient EIO', async () => {
        // A publish that cannot resolve its target raises this from ./atomic-publish.ts's
        // hand-rolled link walk (`realWriteTarget`), and that throw has to CARRY its code:
        // `publishErrorCode` reads `error.code`, and a throw with no code folds to `EIO`.
        // `EIO` is the harness's TRANSIENT code — the one the description teaches a model to
        // retry — so an uncoded loop turned a permanent condition into a retry loop. Measured
        // on the same self-referential link, `edit` and `files` both answered ELOOP while
        // `write` answered `{ code: 'EIO', rawCode: null }`; these are the pins that were
        // missing on the `write` side.
        const loop = join(workdir, 'loop-ELOOP.txt');

        try {
            await symlink('loop-ELOOP.txt', loop, 'file');
        } catch {
            // Link creation is privileged on Windows: nothing to prove on this host.
            return;
        }

        const failure = await failureOf(() => write([{ path: loop, content: 'x' }]));

        // `code` AND `name` carry it (src/util/errors.ts: the code is the machine name and
        // `name` is set to the same value), and `ELOOP` is a published member.
        expect(failure.code).toBe('ELOOP');
        expect(failure.name).toBe('ELOOP');
        expect(FILE_WRITE_ERROR_CODES).toContain('ELOOP');
        // The whole defect: `EIO` is what the caller used to see.
        expect(failure.code).not.toBe('EIO');

        // `rawCode` follows the published rule — present ONLY when it differs from `code`.
        // Here the published code IS the real errno, so the key is absent entirely.
        expect(failure.details).toEqual({ failedPath: loop, completedPaths: [] });
        expect((failure.details as { rawCode?: string }).rawCode).toBeUndefined();
        expect(failure.message).toContain('too many levels of symbolic links');

        // The link survived the refusal, and no staging entry was left next to it. `lstat`
        // (not `stat`) is what proves it: the loop still resolves to itself.
        const loopStats = await lstat(loop);
        expect(loopStats.isSymbolicLink()).toBe(true);
        await expect(stagingEntries(workdir)).resolves.toEqual([]);
    });

    it.runIf(process.platform !== 'win32')(
        'answers a file in a PARENT path as ENOTDIR, with no folded rawCode',
        async () => {
            // F9, one level DEEPER than the batch test above: the mkdir target is
            // `blocker/deep`, whose PARENT component is the file, so Node reports the raw
            // errno as ENOTDIR rather than EEXIST (measured on this host with
            // Temp/toolfix-writedit/probe-mkdir.ts and probe-f9.ts). `code` IS the real errno
            // there, so `rawCode` is absent — the published rule the ELOOP test above pins,
            // shown from the other side of the fold, and the remedy sentence is identical
            // either way.
            //
            // Windows is excluded because a recursive mkdir reports that shape as ENOENT
            // there, where `files`' ENOENT advice (./files.tool.ts:978-987) is the applicable
            // sentence and no fold applies — the fold keys on an EEXIST/ENOTDIR from `mkdir`.
            const dir = join(workdir, 'parent-is-file');
            const blocker = join(dir, 'blocker');
            await mkdir(dir, { recursive: true });
            await writeTextFile(blocker, 'not a directory', 'utf8');

            const failing = join(blocker, 'deep', 'child.txt');
            const failure = await failureOf(() => write([{ path: failing, content: 'never' }]));

            expect(failure.code).toBe('ENOTDIR');
            expect(failure.name).toBe('ENOTDIR');
            expect(failure.message).toBe(
                `write failed on ${failing}: ENOTDIR: not a directory (mkdir). ` +
                    'A component of that path is a file, not a folder; the directory cannot be created inside it. ' +
                    'Delete that file, or write the target under a path whose parents are folders. ' +
                    'Writes already completed: none. No rollback was performed.'
            );
            expect(failure.details).toEqual({ failedPath: failing, completedPaths: [] });
            expect((failure.details as { rawCode?: string }).rawCode).toBeUndefined();

            // The file that blocked the mkdir is untouched and nothing was staged next to it.
            await expect(readTextFile(blocker, 'utf8')).resolves.toBe('not a directory');
            await expect(stagingEntries(dir)).resolves.toEqual([]);
        }
    );

    it('refuses a cancelled call with ECANCELED before touching the filesystem', async () => {
        // Cancellation used to be invisible to this tool: `context.signal` was never read, so
        // an aborted call wrote its files anyway and reported success. It now refuses with the
        // published `ECANCELED` (./cancellation.ts), with the applied-ops facts in `details`
        // like every other partial failure, and with the host's own abort reason kept as
        // `cause` (harness.ts prefers a tool's own explanation of a cancellation, so the
        // reason has to survive the substitution somewhere).
        const target = join(workdir, 'cancelled-write.txt');
        const controller = new AbortController();
        controller.abort();

        const failure = await failureOf(() =>
            write.execute({ parameters: [{ path: target, content: 'x' }], signal: controller.signal })
        );

        expect(failure.code).toBe('ECANCELED');
        expect(failure.name).toBe('ECANCELED');
        expect(FILE_WRITE_ERROR_CODES).toContain('ECANCELED');
        expect(failure.code).not.toBe('EIO');
        expect(failure.details).toEqual({ rawCode: 'AbortError', completedPaths: [] });
        // `cause` is not a declared field of `HarnessError` (src/util/errors.ts assigns it
        // through a cast because the package does not pull in lib es2022.error), so tests
        // reach it through the same cast, as ./glob.test.ts and ./grep.test.ts do.
        const cause = (failure as { cause?: { name?: string } }).cause;
        expect(cause?.name).toBe('AbortError');

        // Nothing ran: no file, no staging litter.
        const exists = await stat(target).then(
            () => true,
            () => false
        );
        expect(exists).toBe(false);
        await expect(stagingEntries(workdir)).resolves.toEqual([]);
    });

    it('stops a cancelled batch at the next file and names the failing target', async () => {
        // The per-entry check lives inside the shared publish (./atomic-publish.ts), which is
        // where the abort lands when the call had already started: the abort below is issued
        // synchronously after `execute` is invoked, so it always arrives after the top-of-call
        // check and before the first entry's publish — the deterministic middle case between
        // "cancelled before the call" and "cancelled after one file landed".
        const first = join(workdir, 'cancel-mid-1.txt');
        const second = join(workdir, 'cancel-mid-2.txt');
        const controller = new AbortController();

        const pending = write.execute({
            parameters: [
                { path: first, content: 'one' },
                { path: second, content: 'two' }
            ],
            signal: controller.signal
        });

        controller.abort();

        const failure = await failureOf(() => pending);

        expect(failure.code).toBe('ECANCELED');
        // The wrapper's own shape, so a caller cannot tell a cancellation from any other
        // partial failure by the DETAILS alone — it switches on `code`.
        expect(failure.details).toEqual({ failedPath: first, completedPaths: [] });
        expect(failure.message).toContain(`write failed on ${first}:`);
        expect(failure.message).toContain('was cancelled (ECANCELED)');
        expect(failure.message).toContain('Writes already completed: none.');

        for (const path of [first, second]) {
            const exists = await stat(path).then(
                () => true,
                () => false
            );
            expect(exists).toBe(false);
        }

        await expect(stagingEntries(workdir)).resolves.toEqual([]);
    });
});
