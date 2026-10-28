// tools/files/identity — one canonical key per real file (T16).
//
// This helper is the fix for three defects that all came from comparing resolved
// PATH STRINGS instead of file identity:
//   - fileWrite/fileEdit accepted a batch that wrote one file twice under two
//     spellings (Windows case aliases, symlink aliases);
//   - fileGlob walked the same tree twice for aliased roots and listed every file
//     twice.
//
// The rules pinned here:
//   - an existing path is identified by realpath (symlinks resolve);
//   - a path that does not exist yet is identified by the nearest existing
//     ancestor's realpath plus the missing segments, so two spellings of a
//     not-yet-created file collide too;
//   - case is folded ONLY on win32: NTFS is case-insensitive, Linux keeps `a.ts`
//     and `A.ts` as distinct files, so folding there would merge unrelated targets.
//
// Fixtures are real entries under the repo-root `Temp/` (never OS temp), one unique
// directory per run, removed afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile as writeTextFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPathKey, fileIdentity } from './identity';

const TEMP_ROOT = fileURLToPath(new URL('../../../../../../Temp', import.meta.url));

// Only NTFS folds case. Every case assertion below is written for both worlds
// instead of being skipped, so a Linux run still proves the distinctness.
const WINDOWS = process.platform === 'win32';

let workdir: string;
// A directory symlink is privileged on Windows (Developer Mode or elevated); the
// symlink assertions run only when the host let us create one.
let symlinkAlias: string | undefined;

beforeAll(async () => {
    await mkdir(TEMP_ROOT, { recursive: true });
    workdir = await mkdtemp(join(TEMP_ROOT, 'harness-identity-'));

    await mkdir(join(workdir, 'nested'), { recursive: true });
    await writeTextFile(join(workdir, 'nested', 'real.txt'), 'real\n', 'utf8');
    await writeTextFile(join(workdir, 'Notes.TXT'), 'notes\n', 'utf8');

    try {
        await symlink(join(workdir, 'nested'), join(workdir, 'alias'), 'dir');
        symlinkAlias = join(workdir, 'alias');
    } catch {
        // Windows without Developer Mode: EPERM. The alias assertions are portable
        // but the privilege is not, so they are skipped rather than failed.
        symlinkAlias = undefined;
    }
});

afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
});

describe('fileIdentity', () => {
    it('collapses relative, absolute, and "." spellings of one existing file', async () => {
        const absolute = join(workdir, 'nested', 'real.txt');
        const expected = await fileIdentity(absolute);

        await expect(fileIdentity(join(workdir, 'nested', '.', 'real.txt'))).resolves.toBe(expected);
        await expect(fileIdentity(join(workdir, 'nested', '..', 'nested', 'real.txt'))).resolves.toBe(
            expected
        );
    });

    it('identifies a file that does not exist yet by its nearest real ancestor', async () => {
        // Same file, two spellings, neither created: the keys must already agree so
        // a batch can be rejected BEFORE anything is written.
        const plain = join(workdir, 'nested', 'future.txt');
        const aliased = join(workdir, 'nested', 'deep', '..', 'future.txt');

        const key = await fileIdentity(plain);

        await expect(fileIdentity(aliased)).resolves.toBe(key);
        // The key is a real path, so it ends with the missing segment itself.
        expect(key.endsWith('future.txt')).toBe(true);
    });

    it('separates two files that only differ by case on Linux and merges them on Windows', async () => {
        const upper = await fileIdentity(join(workdir, 'Notes.TXT'));
        const lower = await fileIdentity(join(workdir, 'notes.txt'));

        if (WINDOWS) {
            // One NTFS file: "notes.txt" IS "Notes.TXT", so one key.
            expect(lower).toBe(upper);
        } else {
            // Two distinct files: folding case here would reject a legitimate batch.
            expect(lower).not.toBe(upper);
        }
    });

    it('resolves a symlink alias onto its target when the host allows symlinks', async () => {
        if (symlinkAlias === undefined) return;

        const target = join(workdir, 'nested', 'real.txt');
        const throughLink = join(symlinkAlias, 'real.txt');

        await expect(fileIdentity(throughLink)).resolves.toBe(await fileIdentity(target));
    });
});

describe('canonicalPathKey', () => {
    it('folds case only on Windows and always normalizes "." segments', () => {
        const absolute = join(workdir, 'nested', 'real.txt');
        const dotted = join(workdir, 'nested', '.', 'real.txt');

        expect(canonicalPathKey(dotted)).toBe(canonicalPathKey(absolute));
        expect(canonicalPathKey(absolute)).toBe(
            WINDOWS ? absolute.toLowerCase() : absolute
        );
    });
});
