// @underload/harness tools/files/identity — one canonical key per real file.
//
// WHY THIS EXISTS (T16)
// ---------------------
// Duplicate-target detection used `resolve(path)`, which only normalizes "." and
// "..". It cannot see that on Windows `notes.txt` and `NOTES.TXT` are ONE file, or
// that `link.ts` and `real.ts` are one file through a symlink. Consequences that
// were real:
//
//   - fileWrite/fileEdit accepted a batch that wrote the same file twice under two
//     spellings, so the second write silently won (fileWrite.ts, fileEdit.ts);
//   - fileGlob walked the same tree twice for roots `src` and `SRC` (or a symlinked
//     root) and listed every file twice (fileGlob.ts `collect`).
//
// THE RULE (documented, not guessed)
// ----------------------------------
//   - an EXISTING path is identified by `realpath()`: symlinks and case aliases
//     collapse onto the same key on every platform;
//   - a NEW path (fileWrite creates files) is identified by the nearest existing
//     ancestor's realpath plus the segments that are still missing, so two
//     spellings of one not-yet-created file collide as well. Nothing is created or
//     probed destructively: only `realpath` (a read) is used, and a missing target
//     is expected rather than reported;
//   - the key is lowercased ONLY on win32. NTFS is case-insensitive and
//     case-preserving, so `A.txt` and `a.txt` are one file there; Linux treats them
//     as distinct files, so lowercasing there would merge unrelated targets. macOS
//     is deliberately not guessed at (it is usually case-insensitive, but the
//     volume decides, and a wrong merge is worse than a missed duplicate).
//
// The key is for COMPARISON only. Every tool keeps reporting `resolve(path)` (or
// the caller's root-prefixed path) so results and messages stay exactly what they
// were.
//
// Cross-references:
//   - ./fileWrite   — duplicate targets in one batch
//   - ./fileEdit    — duplicate targets in one batch
//   - ./fileGlob    — root aliases that walk one tree twice

import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

// Case folding is a filesystem property, not a language one. Only win32 folds:
// Linux must keep `a.ts` and `A.ts` distinct (they are different files).
const CASE_INSENSITIVE_FILESYSTEM = process.platform === 'win32';

// Fold the canonical path when the host filesystem ignores case.
const canonical = (value: string): string =>
    CASE_INSENSITIVE_FILESYSTEM ? value.toLowerCase() : value;

// realpath() or undefined. A failure here is expected (the target may not exist
// yet, or an ancestor may be unreadable) and is never surfaced on its own: the
// tool that asked has its own error for a genuinely unusable path.
const tryRealpath = async (path: string): Promise<string | undefined> => {
    try {
        return await realpath(path);
    } catch {
        return undefined;
    }
};

// Cheap comparison key for a path that is already known to exist (or whose real
// identity is not in question): resolve() normalizes "." and "..", and win32 folds
// case. No filesystem access, so it is safe to call per walked file.
//
// fileGlob uses this for its per-file dedupe: the walker never enters a symlink, so
// every file it yields is its own real path once the ROOT identity has been
// resolved (see fileIdentity below).
export const canonicalPathKey = (path: string): string => canonical(resolve(path));

// Canonical comparison key for `path`, existing or not.
export const fileIdentity = async (path: string): Promise<string> => {
    const absolute = resolve(path);

    // The common case: the file exists (fileEdit, fileGlob, an overwrite).
    const direct = await tryRealpath(absolute);
    if (direct !== undefined) return canonical(direct);

    // The target does not exist yet. Walk up until something does exist, then
    // re-append the missing segments in order, so
    // `<real parent>/notes.txt` and `<real parent>/NOTES.TXT` share one key on
    // win32 while remaining distinct on Linux.
    const missing: string[] = [];
    let current = absolute;

    for (;;) {
        const parent = dirname(current);

        // Reached the filesystem root without finding anything real: fall back to
        // the resolved spelling. Nothing can be canonicalized, and refusing here
        // would turn "unwritable path" into a confusing preflight failure.
        if (parent === current) return canonical(absolute);

        missing.unshift(basename(current));
        current = parent;

        const real = await tryRealpath(current);
        if (real !== undefined) return canonical(join(real, ...missing));
    }
};
