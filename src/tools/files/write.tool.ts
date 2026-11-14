// write — write one or more UTF-8 text files in a single call.
//
// WHY THIS NAME (T-rename): the wire name is `write`, not `fileWrite`. The file
// namespace is already implied by the tool's own `files` tag and by the `paths` /
// `files` / `edits` arguments, and the catalogue now pairs `read`/`write`/`edit`
// with `glob`/`grep`/`files`. There is NO `fileWrite` alias on the wire: two names
// for one tool makes discovery ambiguous (see ../catalogue). The exported TypeScript
// type names (`FileWriteEntry`, `FileWriteParameters`, `FileWriteResult`) keep their
// historical spelling so a consumer's imports do not break over a wire rename.
//
// WHY AN ARRAY (T14 batching rule)
// --------------------------------
// A single edit usually spans several files (a module, its barrel, its test). The
// schema declares ONE property, `files`, so the single-property rule (see
// ../core/tool.ts) hands `execute` the array itself — `write([{ path, content }])`
// — while a model call carries `{ "files": [...] }` and reaches the same code.
//
// RESULT SHAPE
// ------------
// Always an ordered array of `{ path, bytes }`, one entry per requested file, in
// the caller's order. `path` is the ABSOLUTE resolved path and `bytes` is the size
// of the UTF-8 payload actually written.
//
// BATCH CAP
// ---------
// At most FILE_WRITE_MAX_TARGETS (100) files per call, enforced in the implementation
// as well as the schema. `write` is the file tool that carries unbounded PAYLOAD —
// every entry holds a whole file's text — so an uncapped batch meant an arbitrary
// number of files and bytes in one call with no budget anywhere in the path, while
// `read` already refused more than 100 paths. The cap bounds the response (one entry
// per file) and the number of sequential writes; content size remains the caller's
// responsibility and is reported per file in `bytes`.
//
// PREFLIGHT (before the first byte hits disk)
// -------------------------------------------
// Every entry is validated — object shape, non-empty path, string content, no NUL
// in the path OR THE CONTENT, and UNIQUE resolved target file — before anything is
// written. A duplicate target is rejected because "write it twice with different
// content" has no honest answer. Uniqueness is by FILE IDENTITY (./identity.ts),
// not by spelling: on Windows `notes.txt`/`NOTES.TXT` and a symlink alias are the
// same file, so a batch that names it twice is rejected before any write. Parent
// directories are created as needed and an existing file is overwritten, exactly as
// before.
//
// WHY NUL CONTENT IS REJECTED (binary consistency)
// ------------------------------------------------
// This tool advertises UTF-8 TEXT: the description says text, the encoding is utf8,
// and the only reader in the package (read) treats a NUL byte as binary and
// refuses the file outright (see read's binary rejection). Writing a NUL
// therefore produces a file that the harness itself cannot read back — a write that
// silently breaks the read side. There is no binary write API here to opt into, so
// the content is rejected during preflight, before any file is touched, rather than
// creating an unreadable artifact. Every other character, including invalid
// Unicode escapes the caller built by hand, still writes (Node substitutes U+FFFD
// for lone surrogates; that is documented behavior of the encoding, not a NUL
// binary marker).
//
// ONE CRITICAL SECTION PER FILE (D4: no lost update)
// --------------------------------------------------
// A write racing a concurrent `edit` on the same path used to interleave: the edit
// read the pre-write text, matched, and wrote it back over the write's content (or
// vice versa), and BOTH calls reported success. Each write therefore runs under the
// same per-file lock `edit` takes (./lock.ts), keyed by FILE IDENTITY so a Windows
// case alias or a symlink alias queues behind the real file rather than racing it.
// Locks for a multi-file batch are taken in sorted identity order, so two overlapping
// batches cannot deadlock. This orders calls inside ONE process; it makes no claim
// about another process or another worker thread, and never did.
//
// EACH FILE IS PUBLISHED ATOMICALLY (M10)
// ---------------------------------------
// Each file is written to a STAGING file in the same directory as the target and then
// renamed over it, so the directory ENTRY is swapped instead of the bytes being
// rewritten in place. A reader that opens the target during a write therefore sees the
// whole previous file or the whole new file, never a prefix, and a failure before the
// rename (ENOSPC, EACCES, a signal, a kill) leaves the target exactly as it was, with
// the half-written staging file removed.
//
// `writeFile` alone could not make that claim: its default 'w' flag is
// O_WRONLY|O_TRUNC, which empties the file at OPEN, before a single byte of the new
// payload has arrived. Every reader inside the write window and every crash in it used
// to see — and keep — a truncated file. A stress probe (200 concurrent reads of a 2 MB
// write) measured 3 such partial observations.
//
// The same DIRECTORY is the whole guarantee, which is why the staging file is created
// next to the RESOLVED target rather than next to the spelling the caller passed: a
// symlink can name another device, and a cross-device rename is a copy, not a publish.
// The target's mode is copied onto the staging file because a rename swaps the inode —
// in-place writing had kept 0755-style bits for free, and the fix must not lose them.
//
// What it does NOT claim, stated plainly:
//   - no fsync is added, so the durability boundary on power loss is the one in-place
//     writing already had. Fixed here is the state a reader can observe and the outcome
//     of a PROCESS-level failure, which is what the stress report measured;
//   - the target gets a NEW inode, so an already-open handle, a hard link, `uid`/`gid`,
//     and xattrs keep describing the old file. The mode travels, ownership does not;
//   - a read-only target FILE (0444) can now be overwritten, because the write goes to
//     a fresh staging file and only the DIRECTORY's permissions gate the rename. The
//     published file still carries the 0444 mode, and a read-only directory still
//     refuses the write outright;
//   - a DANGLING symlink is still honored the way a live one is: the link is followed to
//     the name it names (that name's parent is created when missing), the staging file is
//     created in THAT directory, and the rename lands on the name the link points at — so
//     the link survives and the file the link names is the one that appears. A symlink
//     chain that loops is refused with an ELOOP-style error instead of replacing the link,
//     which is what the in-place write hit through open() anyway;
//   - the publish is a NAME swap, so a hard link to the target keeps the previous bytes
//     under the sibling name: `a.txt` and `b.txt` share an inode before the write and
//     diverge after it. Nothing here can update both, because the caller named one;
//   - the target is handled as a NAME in a directory, so a target that is not a regular
//     file (a FIFO, a character device) now needs create permission in that directory
//     and has its node replaced, where the in-place write streamed through the existing
//     node. Everything this tool is for — source, config, notes — is a regular file or
//     does not exist yet.
//
// It is per-file atomicity, not a batch transaction — see FAILURE SEMANTICS below.
//
// FAILURE SEMANTICS (honest, not transactional)
// ---------------------------------------------
// Writes are sequential. A filesystem error on file N may leave files 1..N-1
// written: there is NO transaction and NO rollback, and the error says so by
// naming the completed paths and the path that failed. Pretending otherwise would
// be a lie a model could act on.
//
// What file N itself looks like IS defined, and the atomic publish above is what makes
// that honest: a failed write leaves its own target with its PREVIOUS content (or not
// created at all, when it did not exist), never a partial prefix, and its staging file
// is gone — so the message can name only 1..N-1 under "already completed" without
// implying N is half-written. The raw reason may still quote the staging path, which
// no longer exists by the time the caller reads it.
//
// ONE mkdir PER DISTINCT DIRECTORY
// --------------------------------
// Parent directories are created at most once per distinct directory name per call.
// Sixty files in one new directory used to cost sixty `mkdir` syscalls; `recursive:
// true` made a repeat harmless but never free, and the first call already created
// every ancestor. Measured on that exact batch (60 files, 60 bytes total): 37.8 ms ->
// 32.1 ms for the write loop, about 6 ms off an 85 ms call. Honest about the size of
// the win: it is real but modest, and it is NOT what makes that batch slow. The
// dominant cost is the per-entry `fileIdentity` (realpath) lookup, measured at 23.8 ms
// for the same 60 entries — needed for correctness, since two spellings of one file
// must share one lock and one duplicate check. It is named here so the next reader
// does not chase the wrong constant.
//
// No sandbox: paths are resolved against the process working directory and used as
// given.
//
// Executable on its own and registerable on a harness:
//
//     await write([{ path: 'notes.md', content: '# Notes' }]);
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue projects the same data synchronously for lazy enumeration
// and a consistency test proves the projection equal.

import { randomBytes } from 'node:crypto';
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
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { fileIdentity } from './identity';
import { withFileLocks } from './lock';

// How many files one `write` call may create. `read` caps a batch at 100 paths and
// `edit` had no cap either, but write is the one that carries unbounded PAYLOAD: every
// entry holds a whole file's text, so 400 entries meant 400 files and an arbitrary
// number of bytes in a single call, with no budget anywhere in the path. The cap bounds
// the response (one entry per file) and the number of sequential writes; content size is
// still the caller's responsibility, and is reported per file in `bytes`.
export const FILE_WRITE_MAX_TARGETS = 100;

// One file to write.
export type FileWriteEntry = {
    // Path to write, absolute or relative to the working directory.
    path: string;
    // Full text to write. Replaces the previous contents.
    content: string;
};

// The value `execute` receives: the `files` array itself (single-property rule).
export type FileWriteParameters = FileWriteEntry[];

// One completed write, in request order.
export type FileWriteResultEntry = {
    // The absolute path that was written.
    path: string;
    // Size of the written UTF-8 payload, in bytes.
    bytes: number;
};

// The ordered result: one entry per requested file, never a subset.
export type FileWriteResult = FileWriteResultEntry[];

// A validated entry plus its resolved target, so the preflight decides everything
// the write loop needs and the loop itself cannot fail on shape.
type PreparedWrite = {
    target: string;
    // Canonical identity (./identity.ts), kept so the lock key matches the one `edit`
    // takes for the same file — two spellings of one file must share one lock.
    identity: string;
    content: string;
};

// Unique staging-file token: `<base36 pid>-<48-bit hex>`.
//
// The rename below is only safe while one staging name belongs to exactly one writer.
// Two collision sources exist: two PROCESSES in the same directory (the per-file lock in
// ./lock.ts is per-process, so they really do race) and two writes in the SAME process
// that overlap across their awaits. The pid covers the first, 6 random bytes cover the
// second, and the staging open uses `wx` below, so a collision that still happens (about
// 1 in 2^48 per process) surfaces as an honest write error instead of silently
// truncating a neighbour's payload. Same shape of reasoning as the `<file>.<pid>.<n>.tmp`
// staging names in ../../server/persistence.ts.
const stagingToken = (): string => `${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`;

// How many links one path may walk before `write` calls it a cycle. Linux caps link
// resolution at MAXSYMLINKS = 40 and Node reports ELOOP past that; the same order of
// magnitude here keeps the hand-rolled walk below finite without ever refusing a chain a
// real filesystem would have followed.
const SYMLINK_FOLLOW_LIMIT = 40;

// The path the rename must land on: `target` with its symlinks followed.
//
// `write` has always written THROUGH a symlink, because open() follows it, and the
// contract (and ./identity.ts, which keys duplicates by realpath) depends on the link
// surviving while its target is updated. A rename is different: it replaces the NAME, so
// renaming onto the link path would delete the link and leave a regular file behind.
// Resolving first makes the rename land on the real file, and puts the staging file in
// that file's own directory, which is what keeps the rename on one device.
//
// Anything that does not resolve is written at its own spelling: the usual case is a
// target that does not exist yet (this tool creates files) or a missing ancestor, and
// creating it where the caller asked is the whole point. A symlinked ANCESTOR needs no
// special case either — creating and renaming inside a symlinked directory both follow
// that link onto the same real directory, so the rename stays same-device.
//
// A DANGLING symlink is the one spelling that looks "missing" to `realpath` but is a real
// entry, and it is not written at its own spelling: an in-place write followed the link and
// CREATED THE FILE THE LINK NAMES, keeping the link, and that is the behavior the live-link
// contract already promises. `realpath` cannot walk past the missing end, so the chain is
// walked by hand below (D7a): land on the missing end, create its parent, stage beside it,
// rename onto it. The link is never touched, and the staging file sits in the landing's own
// directory, so the publish is still a same-directory rename.
const realWriteTarget = async (target: string): Promise<string> => {
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
    // directory the write loop has not created yet (see the mkdir below).
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
            // a link this tool has always written through.
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
        if (hop === SYMLINK_FOLLOW_LIMIT - 1) {
            throw new HarnessError(
                `write cannot resolve the symlink at ${target}: too many levels of symbolic links (over ${SYMLINK_FOLLOW_LIMIT} hops).`
            );
        }
    }

    if (followed) {
        // A dangling link can name a directory the caller never mentioned (`link.txt ->
        // missing/deep/target.txt`), and the write loop only created the parent of the
        // CALLER's spelling. Create the landing's own parent here so the staging file has
        // a directory to be created in — the same directory the rename publishes into, so
        // the rename stays on one device. A parent that cannot be created (EACCES, a file
        // in the middle of the path) fails the write outright rather than degrading to the
        // link path, which would silently change which file the caller's content landed in.
        await mkdir(dirname(landing), { recursive: true });
    }

    return landing;
};

// The permission bits of an EXISTING target, or undefined when there is no mode to
// preserve.
const existingMode = async (path: string): Promise<number | undefined> => {
    try {
        // `mode` also carries the file-type bits (0o100644 for a regular file); chmod()
        // consumes only the low 12, and masking keeps exactly the bits an in-place write
        // inherited, setuid/setgid/sticky included.
        return (await stat(path)).mode & 0o7777;
    } catch (error) {
        // "There is no file here" is the ONLY reason not to preserve a mode. Any other
        // failure (EACCES, an unreadable ancestor) would otherwise publish the default
        // 0666&~umask file over one that had, say, 0755 — a silent mode change on the
        // very path the caller cannot see, so it surfaces like any other write error.
        const code = (error as NodeJS.ErrnoException | undefined)?.code;

        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;

        throw error;
    }
};

// Publish ONE file atomically: staging file in the target's own directory, mode copied
// over, then a same-directory rename. See the M10 section of this file's header for the
// guarantee and for the semantics the trade buys away.
const writeAtomically = async (target: string, content: string): Promise<void> => {
    // Resolve before staging: the staging file has to sit next to the file the rename
    // replaces, not next to the link that names it.
    const real = await realWriteTarget(target);
    const staging = join(dirname(real), `${basename(real)}.tmp-${stagingToken()}`);
    // Read the mode before anything is created, so a failure below cannot have changed
    // the target between the read and the rename.
    const mode = await existingMode(real);
    // What separates "the rename swapped it into place" from "it is still litter":
    // the staging file is removed on every path that did not publish it.
    let published = false;

    try {
        // `wx` (O_CREAT|O_EXCL): the unique token above makes a collision vanishingly
        // rare, and this is the flag that makes a collision an error instead of a
        // truncated neighbour. The payload lands here, never on the target's inode.
        await writeTextFile(staging, content, { encoding: 'utf8', flag: 'wx' });

        if (mode !== undefined) {
            // The rename swaps the inode, so the mode has to travel with it: a script
            // that silently lost its 0755 is a regression against in-place writing. A
            // chmod that cannot run surfaces as a write error rather than publishing a
            // mode nobody asked for.
            await chmod(staging, mode);
        }

        // The publish. Same directory, so this replaces the directory entry atomically:
        // a concurrent open() sees the old inode or the new one, never a mix.
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

// Validate the whole batch and resolve every target BEFORE the first write.
//
// Ordering is preserved: the result array and the write order both follow the
// caller. Uniqueness is by FILE IDENTITY (./identity.ts), so "a.txt" and "./a.txt"
// collide, and so do two spellings of one file that only the filesystem considers
// equal (Windows case aliases, symlink aliases). The identity lookup is a read
// (`realpath` on the nearest existing ancestor); nothing is created here.
const prepareWrites = async (files: FileWriteParameters): Promise<PreparedWrite[]> => {
    if (!Array.isArray(files)) {
        throw new HarnessError(
            'write expects an array of { path, content } entries, e.g. [{"path":"a.txt","content":"hi"}].'
        );
    }

    if (files.length === 0) {
        throw new HarnessError('write received an empty files array; pass at least one entry.');
    }

    // Rejected before any validation or filesystem work, like read's batch cap: a
    // caller that sends 400 entries needs to split the batch, not to have the first 100
    // written and the rest silently dropped.
    if (files.length > FILE_WRITE_MAX_TARGETS) {
        throw new HarnessError(
            `write accepts at most ${FILE_WRITE_MAX_TARGETS} files per call; received ${files.length}. Split the batch.`
        );
    }

    const prepared: PreparedWrite[] = [];
    const seen = new Set<string>();

    for (const entry of files) {
        // A model can pass anything: a string, a null, an array. Name the shape
        // rather than failing on a property read.
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new HarnessError('write files must be objects with "path" and "content" strings.');
        }

        const { path, content } = entry as Partial<FileWriteEntry>;

        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('write files require a non-empty "path" string.');
        }

        // NUL cannot exist in a real path and would only confuse the filesystem.
        if (path.includes('\u0000')) {
            throw new HarnessError('write paths must not contain NUL characters.');
        }

        // Content is required, and an empty string is a legitimate "truncate the
        // file" request, so only the type and the binary marker are checked.
        if (typeof content !== 'string') {
            throw new HarnessError('write files require a "content" string.');
        }

        // A NUL byte is the harness's own binary marker (read rejects it), so
        // writing one creates a file this package cannot read back. Rejected in
        // preflight — before any write — so nothing is created meanwhile.
        const target = resolve(path);

        if (content.includes('\u0000')) {
            throw new HarnessError(
                `write content must not contain NUL characters (${target}): the file would be unreadable by read, which rejects binary content.`
            );
        }

        // Same file twice in one batch: the second write would silently win, so
        // the batch is rejected instead of guessing an order-independent answer.
        // The message names the resolved path (what a caller can act on) while the
        // comparison uses the real file identity.
        const identity = await fileIdentity(target);

        if (seen.has(identity)) {
            throw new HarnessError(
                `write received the same target path twice (${target}); write each file once per call.`
            );
        }

        seen.add(identity);
        prepared.push({ target, identity, content });
    }

    return prepared;
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
//
// The added clause at the end of the atomic-publish sentence is the D7b disclosure: that
// publish swaps the target's NAME, so a hard link to it keeps the previous bytes under the
// sibling name, and a 0444 existing file is overwritable because only the DIRECTORY's
// permissions gate the rename. Both are inherent to the rename (see the M10 section of this
// header) and neither is guessable by a caller, so they are published, not left in the
// source comments.
export const WRITE_METADATA: PresetToolMetadata = {
    name: 'write',
    description:
        'Write one or more UTF-8 text files, creating parent directories as needed and overwriting existing files. Pass an array of { path, content } entries and get an ordered array of { path, bytes } in the same order. A call accepts at most 100 files; split a larger batch. Every entry is validated before anything is written, and the same target path twice is rejected. Writes are serialized per file against concurrent edit calls on the same path, so neither can silently overwrite the other. Each file is published atomically, so a reader sees either its previous content or its new content, never a partial write, and a failed write leaves that file untouched; the publish replaces the file, so a hard link to it keeps the previous bytes and a read-only existing file can still be overwritten. A write error part-way through is reported with the paths already completed: there is no rollback.',
    tags: ['files', 'write', 'filesystem'],
    // R18: writing files is core, like the rest of the everyday file set.
    visibility: 'core',
    parameters: {
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
                            description:
                                'Path to the file, absolute or relative to the working directory.'
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
    }
};
// Canonical discovery export (T19 / R9). A same-file alias of the literal above:
// `../../core/tool-discovery.ts` follows the alias through the TypeScript AST, so
// the constant above stays the single place this metadata is authored.
export const metadata = WRITE_METADATA;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract.
export const registration = {
    group: 'preset',
    activation: 'always',
    order: 180,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const write = tool<FileWriteParameters, FileWriteResult>({
    ...WRITE_METADATA,
    execute: async ({ parameters: files }) => {
        const prepared = await prepareWrites(files);

        // D4: hold every target's lock across the whole batch, in sorted identity
        // order (./lock.ts deduplicates and sorts), so a concurrent `edit` on any of
        // these files cannot read a half-updated view of one of them.
        return withFileLocks(
            prepared.map((entry) => entry.identity),
            async () => {
                const written: FileWriteResultEntry[] = [];

                // Parent directories are created at most ONCE per distinct directory.
                // Sixty files in one new directory used to mean sixty `mkdir` calls.
                // `recursive: true` makes a repeat harmless but never free, and the first
                // call already created every ancestor, so a directory seen twice needs no
                // second call at all. Worth about 6 ms of an 85 ms 60-file batch — see the
                // header for the measurement and for what actually dominates that call.
                const made = new Set<string>();

                for (const { target, content } of prepared) {
                    try {
                        // Agents write into directories that do not exist yet far more
                        // often than not; failing on that wastes a round trip.
                        const parent = dirname(target);
                        if (!made.has(parent)) {
                            await mkdir(parent, { recursive: true });
                            made.add(parent);
                        }

                        // M10: staged + renamed, not `writeFile(target)`. The target is
                        // never emptied in place, so a concurrent reader, an ENOSPC, or a
                        // kill cannot leave — or report — a partial file.
                        await writeAtomically(target, content);
                    } catch (error) {
                        // Partial success is reported honestly: the completed paths are
                        // named so the caller can tell what exists now, and there is no
                        // claim of a transaction or rollback (there is neither).
                        // The failed target is deliberately NOT listed: it still holds the
                        // text it had before (or does not exist yet), which the staged
                        // publish above is what guarantees.
                        const completed =
                            written.length === 0 ? 'none' : written.map((entry) => entry.path).join(', ');
                        const reason = error instanceof Error ? error.message : String(error);

                        throw new HarnessError(
                            `write failed on ${target}: ${reason} Writes already completed: ${completed}. No rollback was performed.`
                        );
                    }

                    written.push({ path: target, bytes: Buffer.byteLength(content, 'utf8') });
                }

                return written;
            }
        );
    }
});
