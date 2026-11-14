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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolParameterKey } from '../../core';
import { write } from './write.tool';

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

        await expect(
            write([
                { path: completed, content: 'written' },
                { path: failing, content: 'never' }
            ])
        ).rejects.toThrow(
            new RegExp(
                `^write failed on ${escapeRegExp(failing)}: .* Writes already completed: ${escapeRegExp(
                    completed
                )}\\. No rollback was performed\\.$`
            )
        );

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
