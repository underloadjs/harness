// @underload/harness tools/files/atomic-publish — the ONE staged publish `write` and
// `edit` share.
//
// WHY THIS IS A SEPARATE MODULE (and why it is NOT named `*.tool.ts`)
// -------------------------------------------------------------------
// `write` published atomically (see ./write.tool.ts, the "EACH FILE IS PUBLISHED
// ATOMICALLY" section) while `edit` published IN PLACE with `writeFile`, i.e.
// `O_WRONLY|O_TRUNC` on the target's own inode: the old bytes were gone at OPEN, before
// a single byte of the new text had arrived, so a reader inside the window saw a
// truncated file and an ENOSPC/EPERM/a kill in it left the file truncated with nothing to
// roll back to. The fix is the same publish, so it has to be the same CODE: a forked copy
// of "stage beside the resolved target, copy the mode, rename" is how the two tools would
// drift apart, and the two properties that make it correct are exactly the ones a copy
// loses first — following a symlink to the REAL file (a rename replaces a NAME, so
// renaming onto the link path would delete the link) and carrying the mode across the
// inode swap (a 0755 script that came back 0644 is a silent regression).
//
// The file deliberately does not end in `.tool.ts`: ../../core/tool-discovery.ts and
// ../../../scripts/generate-tool-manifest.ts AST-scan `*.tool.ts` for `metadata` and
// `registration` literals, so a helper with that suffix would be read as a new tool.
// Same convention as ./identity.ts, ./lock.ts, ./search.ts, ./gitignore.ts and
// ./bounded-regex.ts.
//
// WHAT THE PUBLISH GUARANTEES
// ---------------------------
//   - the payload lands on a fresh staging file in the SAME directory as the file the
//     rename replaces, so a concurrent open() sees the whole previous file or the whole
//     new one, never a prefix;
//   - a failure before the rename (ENOSPC, EACCES, a signal, a kill) leaves the target
//     exactly as it was — its previous content, its own inode, its mode — and removes the
//     half-written staging file, so a failed call cannot leave litter behind;
//   - the target's mode travels with it (chmod before the rename);
//   - a symlink is written THROUGH: the link survives, the file it names is the one that
//     changes, and the staging file sits in that file's own directory so the rename cannot
//     turn into a cross-device copy.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM
// -----------------------------------
//   - no fsync, so the durability boundary on power loss is unchanged;
//   - the target gets a NEW inode: an already-open handle, a hard link, `uid`/`gid` and
//     xattrs keep describing the old file. The mode travels, ownership does not;
//   - a read-only target FILE (0444) becomes writable, because only the DIRECTORY's
//     permissions gate the rename. A read-only directory still refuses outright;
//   - a non-regular target is REFUSED rather than written (see
//     `nonRegularTargetMessage`): the in-place write streamed through a FIFO or a device
//     node, while a publish would silently replace that node with a regular file, which is
//     a worse surprise than an error that names the remedy;
//   - the lock the callers hold around this (./lock.ts) is per-PROCESS, and this module
//     adds no coordination of its own.
//
// MACHINE CODES
// -------------
// A publish failure carries a stable `code` from the published set below: the raw errno
// when it is one a caller can act on, otherwise `EIO` with the true errno kept in
// `rawCode` (same convention as ./files.tool.ts's `PUBLISHED_ERROR_CODES` fold and
// ./read.tool.ts's per-entry `error.code`). The published sets the two tools export
// (./write.tool.ts, ./edit.tool.ts) both include this list, so a caller can enumerate one
// per tool and still see every code this publish can raise.
//
// Two codes in that set are SYNTHESIZED rather than answered by a syscall, because the
// alternative is a syscall that would have "succeeded" by doing the wrong thing: `EISDIR`
// and `EOPNOTSUPP` for a non-regular landing (see `nonRegularTargetMessage`), and
// `ECANCELED` for a call whose abort signal had already fired when this entry's turn came
// (./cancellation.ts). `ECANCELED` is checked BEFORE any syscall, so a cancelled batch
// stops at the next file instead of writing files nobody asked for; the two tools'
// wrappers then report it with the same `failedPath` / `completedPaths` details they use
// for every other partial failure. It deliberately is NOT folded into `EIO`, which is the
// transient code a caller is told to retry, and a cancelled call never becomes un-cancelled
// by a retry.

import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
    chmod,
    lstat,
    mkdir,
    readlink,
    realpath,
    rename,
    rm,
    stat,
    writeFile as writeTextFile
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { HarnessError } from '../../util';
import { throwIfFileCancelled } from './cancellation';

// The errnos one staged publish can surface, and the three codes it synthesizes itself
// (`EISDIR` for a directory target, `EOPNOTSUPP` for any other non-regular target, which
// are refusals rather than syscall results — the syscalls below would have "succeeded" by
// replacing the node — and `ECANCELED` for an abort that landed before this entry's turn,
// which the syscalls would have "answered" by writing files the caller had just cancelled).
// Anything else folds to `EIO`.
export const FILE_PUBLISH_ERROR_CODES = [
    'EACCES',
    'EBADF',
    'EBUSY',
    // Synthesized by the pre-flight cancellation guard below (./cancellation.ts), and part
    // of this list because `FILE_WRITE_ERROR_CODES` and `FILE_EDIT_ERROR_CODES` both spread
    // it — the two tools publish exactly what this publish can raise.
    'ECANCELED',
    'EDQUOT',
    'EEXIST',
    'EIO',
    'EISDIR',
    'ELOOP',
    'EMFILE',
    'ENAMETOOLONG',
    'ENFILE',
    'ENODEV',
    'ENOENT',
    'ENOSPC',
    'ENOTDIR',
    'ENOTEMPTY',
    'EOPNOTSUPP',
    'EPERM',
    'EROFS',
    'ETXTBSY',
    'EXDEV'
] as const;

export type FilePublishErrorCode = (typeof FILE_PUBLISH_ERROR_CODES)[number];

// The staging-file marker. One directory listing filtered on this substring is the test
// for "no litter after a success or a failure", so the pattern is published here rather
// than duplicated per test file.
export const STAGING_MARKER = '.tmp-';

// Unique staging-file token: `<base36 pid>-<48-bit hex>`.
//
// The rename is only safe while one staging name belongs to exactly one writer. Two
// collision sources exist: two PROCESSES in the same directory (the per-file lock in
// ./lock.ts is per-process, so they really do race) and two writes in the SAME process
// that overlap across their awaits. The pid covers the first, 6 random bytes cover the
// second, and the staging open uses `wx` below, so a collision that still happens (about
// 1 in 2^48 per process) surfaces as an honest write error instead of silently truncating
// a neighbour's payload. Same shape of reasoning as the `<file>.<pid>.<n>.tmp` staging
// names in ../../server/persistence.ts.
const stagingToken = (): string => `${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;

// How many links one path may walk before the publish calls it a cycle. Linux caps link
// resolution at MAXSYMLINKS = 40 and Node reports ELOOP past that; the same order of
// magnitude here keeps the hand-rolled walk below finite without ever refusing a chain a
// real filesystem would have followed.
const SYMLINK_FOLLOW_LIMIT = 40;

// The path the rename must land on: `target` with its symlinks followed.
//
// Both tools have always written THROUGH a symlink, because open() follows it, and the
// contract (and ./identity.ts, which keys duplicates by realpath) depends on the link
// surviving while its target is updated. A rename is different: it replaces the NAME, so
// renaming onto the link path would delete the link and leave a regular file behind.
// Resolving first makes the rename land on the real file, and puts the staging file in
// that file's own directory, which is what keeps the rename on one device.
//
// Anything that does not resolve is written at its own spelling: the usual case is a
// target that does not exist yet (`write` creates files; `edit` fails later, on its read),
// or a missing ancestor, and creating it where the caller asked is the whole point. A
// symlinked ANCESTOR needs no special case either — creating and renaming inside a
// symlinked directory both follow that link onto the same real directory, so the rename
// stays same-device.
//
// A DANGLING symlink is the one spelling that looks "missing" to `realpath` but is a real
// entry, and it is not written at its own spelling: an in-place write followed the link and
// CREATED THE FILE THE LINK NAMES, keeping the link, and that is the behavior the live-link
// contract already promises. `realpath` cannot walk past the missing end, so the chain is
// walked by hand below (D7a): land on the missing end, create its parent, stage beside it,
// rename onto it. The link is never touched, and the staging file sits in the landing's own
// directory, so the publish is still a same-directory rename.
//
// `label` is the calling tool's wire name, so the one error this walk raises (a symlink
// loop) names the tool the caller actually called.
export const realWriteTarget = async (label: string, target: string): Promise<string> => {
    try {
        return await realpath(target);
    } catch {
        // ENOENT / ENOTDIR: there is nothing to resolve yet. Expected, never surfaced;
        // an actually unusable path fails a syscall below with a real message.
    }

    // Walk the chain by hand. Only `lstat` sees a link without following it, which is the
    // only way to tell "a name with nothing behind it" from "a link whose end is missing".
    let landing = target;
    // Did the landing move away from the caller's spelling? Only then can its parent be a
    // directory the caller's write loop has not created yet (see the mkdir in
    // ./write.tool.ts, and why `edit` never needs one: its read already required a file).
    let followed = false;

    for (let hop = 0; hop < SYMLINK_FOLLOW_LIMIT; hop += 1) {
        let text: string | undefined;

        try {
            const info = await lstat(landing);
            // A regular file or directory at this name is a landing too — reachable only if
            // the link chain closed on an existing entry after realpath already failed.
            text = info.isSymbolicLink() ? await readlink(landing) : undefined;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;

            // ENOENT / ENOTDIR is the end of the chain: that missing name IS the landing,
            // and it is either a dangling end or a plain path that does not exist yet.
            if (code === 'ENOENT' || code === 'ENOTDIR') break;

            // Anything else (EACCES on an ancestor) is a real failure. Surfacing it beats
            // the alternative of quietly renaming onto the LINK path, which would delete
            // a link both tools have always written through.
            throw error;
        }

        // Not a link (a real entry, or the missing end handled above by break): landed.
        if (text === undefined) break;

        // A link's text is relative to the LINK's own directory, not to the working
        // directory, and `resolve` also normalizes `.`/`..` and honours a text that is
        // absolute on its own — one call covers both spellings.
        landing = resolve(dirname(landing), text);
        followed = true;

        // The hop budget ran out while still on links: the chain closed on itself. `open()`
        // used to fail this path with ELOOP; failing here is the same honest answer, and
        // quietly renaming onto the link path would not be.
        //
        // THE CODE IS NOT OPTIONAL. `publishErrorCode` (below) reads `error.code` to decide
        // what the tool reports, and a throw with no code folds to `EIO` — the harness's
        // TRANSIENT code, the one the descriptions teach a model to retry. A symlink loop is
        // permanent: retrying it is a loop of its own. Measured before the code was attached,
        // on one self-referential link `l -> l`:
        //
        //     edit   -> { code: 'ELOOP', rawCode: 'ELOOP' }   (its own readFile errno)
        //     files  -> ELOOP                                  (copy/delete classify it)
        //     write  -> { code: 'EIO',   rawCode: null }       <- the defect
        //
        // `ELOOP` is already a member of `FILE_PUBLISH_ERROR_CODES` above, so the fix is to
        // carry it, not to widen the set. `rawCode` stays absent: the rule is that it appears
        // only when it differs from `code` (./read.tool.ts, ./files.tool.ts), and here the
        // published code IS the real one.
        if (hop === SYMLINK_FOLLOW_LIMIT - 1) {
            throw new HarnessError(
                `${label} cannot resolve the symlink at ${target}: too many levels of symbolic links (over ${SYMLINK_FOLLOW_LIMIT} hops).`,
                { code: 'ELOOP' }
            );
        }
    }

    if (followed) {
        // A dangling link can name a directory the caller never mentioned (`link.txt ->
        // missing/deep/target.txt`), and `write`'s loop only created the parent of the
        // CALLER's spelling. Create the landing's own parent here so the staging file has
        // a directory to be created in — the same directory the rename publishes into, so
        // the rename stays on one device. A parent that cannot be created (EACCES, a file
        // in the middle of the path) fails the write outright rather than degrading to the
        // link path, which would silently change which file the caller's content landed in.
        await mkdir(dirname(landing), { recursive: true });
    }

    return landing;
};

// What one existing entry is when it is NOT a regular file: the code the refusal carries
// and the two pieces of the sentence a caller needs (WHAT the node is, and why replacing
// it is not what the caller wanted). Exported so `edit`, which stats the target for its own
// size bound, classifies a non-regular target with the SAME words rather than a re-worded
// copy (L5).
export type NonRegularTarget = {
    code: 'EISDIR' | 'EOPNOTSUPP';
    kind: string;
    remedy: string;
};

// `undefined` for a regular file (and for anything `stat` answered for a symlink, since
// `stat` follows links and the resolved entry is what reaches this).
export const nonRegularTargetOf = (info: Stats): NonRegularTarget | undefined => {
    if (info.isFile()) return undefined;

    // A directory is the common case and has its own code and remedy; everything else
    // (FIFO, character or block device, socket) shares the "a publish would replace the
    // node" answer.
    if (info.isDirectory()) {
        return {
            code: 'EISDIR',
            kind: 'a directory',
            remedy: 'pass a path INSIDE it: this tool replaces a file\'s contents, and publishing atomically into a directory would have to replace the directory itself.'
        };
    }

    const kind = info.isFIFO()
        ? 'a FIFO (named pipe)'
        : info.isCharacterDevice()
          ? 'a character device'
          : info.isBlockDevice()
            ? 'a block device'
            : info.isSocket()
              ? 'a socket'
              // An entry with no type this host can name still is "not a regular file".
              : 'not a regular file';

    return {
        code: 'EOPNOTSUPP',
        kind,
        remedy: 'publishing atomically creates a REGULAR file and renames it into place, which would replace that node and leave a reader holding the old one with no way to see the bytes: write to a different path, or stream to the device outside this tool.'
    };
};

// The refusal for a non-regular target, spelled in ONE place because `write` and `edit`
// owe the caller the same sentence about the same bytes. The tool-level wrapper names the
// path the caller passed; this names the RESOLVED entry, because that is the node that
// would have been replaced.
export const nonRegularTargetMessage = (
    label: string,
    resolved: string,
    target: NonRegularTarget
): string => `${label} refused ${resolved}: the target is ${target.kind}, not a regular file. ${target.remedy}`;

// What one existing entry is, for the publish: the low permission bits to preserve, plus
// the node classification when the entry is not a regular file.
type PublishTarget = {
    // The permission bits of an EXISTING target, or undefined when there is no mode to
    // preserve. `mode` also carries the file-type bits (0o100644 for a regular file);
    // chmod() consumes only the low 12, and masking keeps exactly the bits an in-place
    // write inherited, setuid/setgid/sticky included.
    mode?: number;
    // Set only when the resolved entry exists and is not a regular file, so the publish
    // can refuse instead of replacing the node.
    nonRegular?: NonRegularTarget;
};

const statPublishTarget = async (path: string): Promise<PublishTarget> => {
    let info;

    try {
        info = await stat(path);
    } catch (error) {
        // "There is no file here" is the ONLY reason not to preserve a mode. Any other
        // failure (EACCES, an unreadable ancestor) would otherwise publish the default
        // 0666&~umask file over one that had, say, 0755 — a silent mode change on the very
        // path the caller cannot see — so it surfaces like any other write error.
        const code = (error as NodeJS.ErrnoException | undefined)?.code;

        if (code === 'ENOENT' || code === 'ENOTDIR') return {};

        throw error;
    }

    const nonRegular = nonRegularTargetOf(info);

    if (nonRegular === undefined) return { mode: info.mode & 0o7777 };

    // No mode is reported for a non-regular entry, because it is never published over.
    return { nonRegular };
};

// Publish ONE file atomically: staging file in the target's own directory, mode copied
// over, then a same-directory rename. See this file's header for the guarantee and for the
// semantics the trade buys away.
//
// `label` is the calling tool's wire name ('write' or 'edit'), so a refusal says which tool
// refused without either tool re-wording the shared rules.
//
// `signal` is the CALL's abort signal (./cancellation.ts). It is checked here rather than in
// either tool's loop because this is the last point before the side effect: the rename. A
// batch of 60 files whose run is cancelled at file 12 therefore stops at file 12 — files
// 1-11 are on disk and named in the caller's `completedPaths`, 12-60 were never touched —
// and the throw carries `ECANCELED`, not the platform `AbortError` whose `code` is the number
// 20 and whose meaning no published set contains.
export const publishAtomically = async (
    label: string,
    target: string,
    content: string,
    signal?: AbortSignal
): Promise<void> => {
    // Cancellation first, BEFORE any syscall: an already-cancelled call has no consumer for
    // its result (src/types/index.ts:2356-2357 — the harness discards a late one), so the
    // work it has not started is work it must not start.
    throwIfFileCancelled(label, signal, `before publishing "${target}"`);

    // Resolve before staging: the staging file has to sit next to the file the rename
    // replaces, not next to the link that names it.
    const real = await realWriteTarget(label, target);
    // Read the mode AND the node type before anything is created, so a refusal below cannot
    // have changed the target between the read and the rename, and so a non-regular target
    // never pays for a staging file it will not use.
    const info = await statPublishTarget(real);

    if (info.nonRegular !== undefined) {
        throw new HarnessError(
            nonRegularTargetMessage(label, real, info.nonRegular),
            { code: info.nonRegular.code }
        );
    }

    const staging = join(dirname(real), `${basename(real)}${STAGING_MARKER}${stagingToken()}`);
    // What separates "the rename swapped it into place" from "it is still litter": the
    // staging file is removed on every path that did not publish it.
    let published = false;

    try {
        // `wx` (O_CREAT|O_EXCL): the unique token above makes a collision vanishingly
        // rare, and this is the flag that makes a collision an error instead of a
        // truncated neighbour. The payload lands here, never on the target's inode.
        await writeTextFile(staging, content, { encoding: 'utf8', flag: 'wx' });

        if (info.mode !== undefined) {
            // The rename swaps the inode, so the mode has to travel with it: a script that
            // silently lost its 0755 is a regression against in-place writing. A chmod that
            // cannot run surfaces as a write error rather than publishing a mode nobody
            // asked for.
            await chmod(staging, info.mode);
        }

        // The publish. Same directory, so this replaces the directory entry atomically: a
        // concurrent open() sees the old inode or the new one, never a mix.
        await rename(staging, real);
        published = true;
    } finally {
        if (!published) {
            // Best effort and never throwing: the error already propagating is the
            // actionable one, and a leftover temp file must not replace it. `force`
            // swallows the ENOENT case where the failure happened before the create.
            await rm(staging, { force: true }).catch(() => undefined);
        }
    }
};

// The machine code for a failed publish, plus the raw errno when the fold hid it.
//
// The thrown value is either a Node errno (`EACCES: permission denied, open '...'`) or a
// HarnessError this module already coded (a non-regular refusal, or a cancellation from
// ./cancellation.ts). All three carry the answer in `code`; anything outside the published
// set still folds to `EIO` with the true value in `rawCode`, so a caller never has to parse
// prose to learn the failure was not one of the documented ones — and a code that IS
// published, `ECANCELED` included, comes back with NO `rawCode`, because duplicating the
// published name tells a caller nothing.
export const publishErrorCode = (error: unknown): { code: FilePublishErrorCode; rawCode?: string } => {
    const raw = (error as { code?: unknown } | undefined)?.code;
    const rawCode = typeof raw === 'string' && raw.length > 0 ? raw : undefined;

    if (rawCode !== undefined && (FILE_PUBLISH_ERROR_CODES as readonly string[]).includes(rawCode)) {
        return { code: rawCode as FilePublishErrorCode };
    }

    return rawCode === undefined ? { code: 'EIO' } : { code: 'EIO', rawCode };
};
