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
// Unicode escapes the caller built by hand, still writes — but a LONE SURROGATE does not
// survive the encoding: Node substitutes U+FFFD for an unpaired surrogate (documented
// behavior of the encoding, not a NUL binary marker), and the substitution is permanent
// and invisible on re-read. The entry therefore says `lossy: true` whenever the content
// carried one, because the file on disk is NOT the string the caller passed and only this
// call knows it.
//
// ONE CRITICAL SECTION PER FILE (D4: no torn state, no lost edit-vs-edit update)
// ------------------------------------------------------------------------------
// A write racing a concurrent `edit` on the same path used to interleave: the edit
// read the pre-write text, matched, and wrote it back over the write's content (or
// vice versa), and BOTH calls reported success. Each write therefore runs under the
// same per-file lock `edit` takes (./lock.ts), keyed by FILE IDENTITY so a Windows
// case alias or a symlink alias queues behind the real file rather than racing it.
// Locks for a multi-file batch are taken in sorted identity order, so two overlapping
// batches cannot deadlock.
//
// WHAT THE LOCK DOES BUY, AND WHAT IT DOES NOT (H6). It orders the critical sections,
// so (a) no reader can observe a torn or interleaved file, and (b) two concurrent
// `edit`s cannot both claim success against text the other one overwrote — the later
// one sees the earlier one's text and fails honestly with "no match". A full-content
// `write` is DIFFERENT by design: it replaces whatever text is current (see "Replaces
// the previous contents" on FileWriteEntry), and the rename never re-stats or
// version-checks the destination, because ./lock.ts rejects compare-and-swap outright
// ("WHY A MUTEX AND NOT AN mtime/hash CHECK": a CAS reopens the window the mutex
// closes and pushes a retry loop onto the caller). So a `write` that runs after a
// concurrent `edit` on the same path wins the content, and the edit's change is gone
// with nothing but the ordering to explain it. Last-writer-wins on a whole-file write
// is the documented semantics, not an accident of the lock.
//
// ONE PROCESS ONLY (EXTRA-7). `withFileLocks` is a Map on THIS event loop. Under
// `threadExecution: 'worker'` (../../server/config.ts) every lane worker has its OWN
// lock map, so two lanes naming one file are not serialized at all — nor is any other
// process, or an editor outside the harness. The default is 'inline', which is the
// single-loop case the guarantee holds for, and the published description says the
// same thing so a caller does not have to read ./lock.ts to learn the bound.
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
// The publish itself lives in ./atomic-publish.ts, because `edit` now uses the SAME one
// (C2): a tool whose whole job is changing one line had no business being the only file
// writer in the package that could expose a half-written file, and a copy of this
// sequence in ./edit.tool.ts is how the symlink-following and mode-carrying rules would
// have drifted apart. `edit`'s header owes its own version of the trade; this file and
// that one describe the same code, so keep the two honest together.
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
//   - a target that is NOT a regular file is REFUSED (L5), not written. The in-place
//     write streamed through an existing FIFO or device node; this publish creates a
//     regular file and renames it into place, so it would (a) need create permission in
//     that directory — an incidental EACCES on /dev/null for a caller who only wanted to
//     discard bytes — and (b) succeed by REPLACING the node with an ordinary file, which
//     is a worse surprise than an error naming the target type and the remedy. A
//     directory gets EISDIR, every other non-regular entry EOPNOTSUPP. A direct-write
//     path for devices was considered and rejected: it forks the publish and reopens the
//     hole C2 closed for `edit`. Everything this tool is for — source, config, notes — is
//     a regular file or does not exist yet.
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
// The throw also carries machine-readable data (M11), which the prose never gave a
// caller that has to recover: `code` is the errno from the published
// FILE_WRITE_ERROR_CODES list (EIO when it is not one of those, with the true errno in
// `details.rawCode`), and `details` is { failedPath, completedPaths } so the completed
// list does not have to be parsed out of the sentence. The message keeps naming both,
// because the message is the half that reaches a model.
//
// ONE failure is a STABLE state rather than a fault, and is coded as such (F9): when a
// component of a target's PARENT path is an existing file, the parent mkdir cannot
// succeed at any retry rate. That case is folded to `ENOTDIR` with the remedy `files`
// gives for the identical syscall — see `parentMkdirRefusal` below — instead of the raw
// EEXIST/ENOTDIR prose with no next step.
//
// CANCELLATION IS A CODED REFUSAL, NOT A SILENT WRITE
// ---------------------------------------------------
// `context.signal` (src/types/index.ts:2349-2364) is observed: once at the top of the call
// and once per entry inside ./atomic-publish.ts. A cancelled `write` therefore REFUSES with
// `ECANCELED` + { completedPaths } instead of performing the side effects of a call nobody
// is waiting for, and a batch cancelled at file 12 of 60 reports files 1-11 as completed and
// 12-60 as never touched. `ECANCELED` is in FILE_WRITE_ERROR_CODES because
// FILE_PUBLISH_ERROR_CODES carries it, and it is NOT folded into `EIO`: `EIO` is the
// transient code this tool's own description teaches a caller to retry, and a cancellation
// is permanent. The host's own abort reason survives as the error's `cause`. The mapping and
// its reasoning live in ./cancellation.ts, shared with `read`, `edit` and `files`.
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

import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import {
    FILE_PUBLISH_ERROR_CODES,
    publishAtomically,
    publishErrorCode
} from './atomic-publish';
import { throwIfFileCancelled } from './cancellation';
import { fileIdentity } from './identity';
import { withFileLocks } from './lock';

// How many files one `write` call may create. `read` caps a batch at 100 paths and
// `edit` had no cap either, but write is the one that carries unbounded PAYLOAD: every
// entry holds a whole file's text, so 400 entries meant 400 files and an arbitrary
// number of bytes in a single call, with no budget anywhere in the path. The cap bounds
// the response (one entry per file) and the number of sequential writes; content size is
// still the caller's responsibility, and is reported per file in `bytes`.
export const FILE_WRITE_MAX_TARGETS = 100;

// Every machine code a `write` failure can carry, published so a caller enumerates it
// instead of parsing prose (the same convention as ./read.tool.ts's `FileReadErrorCode`
// and ./files.tool.ts's `PUBLISHED_ERROR_CODES` fold). It is the shared publish list:
// `write` synthesizes no codes of its own, because the only failures past the preflight
// checks come from the staging create, the chmod, the rename, or the cancellation guard
// that runs before them (`ECANCELED`, ./cancellation.ts).
export const FILE_WRITE_ERROR_CODES = [...FILE_PUBLISH_ERROR_CODES];

export type FileWriteErrorCode = (typeof FILE_WRITE_ERROR_CODES)[number];

// One file to write.
export type FileWriteEntry = {
    // Path to write, absolute or relative to the working directory.
    path: string;
    // Full text to write. Replaces the previous contents.
    content: string;
};

// The value `execute` receives: the `files` array itself (single-property rule).
export type FileWriteParameters = FileWriteEntry[];

// The fields one `files` entry may name. Enforced at runtime as well as in the schema,
// because the DIRECT call path hands the tool its argument untouched
// (../../core/tool.ts: "The argument IS the parameter value, so it is handed to `execute`
// untouched") — a typo'd key would otherwise be dropped silently, which for a knob like
// `overwrite` means the caller believes it asked for something it did not get. Same rule
// ./files.tool.ts already enforces per operation.
const FILE_WRITE_FIELDS = ['path', 'content'] as const;

// One completed write, in request order.
export type FileWriteResultEntry = {
    // The absolute path that was written.
    path: string;
    // Size of the written UTF-8 payload, in bytes. NOTE: this is the size of the bytes
    // that landed, which for a `lossy` entry is NOT the size of the string the caller
    // passed — each unpaired surrogate became the three bytes of U+FFFD.
    bytes: number;
    // L6, present ONLY when the content carried an unpaired surrogate: UTF-8 cannot hold
    // one, so Node substituted U+FFFD and the file on disk is not the string that was
    // passed. The substitution is permanent and re-reading cannot show it (the replacement
    // character is valid text on its own), so this call is the only place that can say so.
    // `read` publishes the same flag name for the same fact on the way back in.
    lossy?: true;
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
    // L6: whether the payload contains an unpaired surrogate, i.e. whether the bytes that
    // land are U+FFFD instead of the code unit the caller passed. Computed once, in the
    // preflight, so the receipt cannot forget the disclosure.
    lossy: boolean;
};

// L6 — does `text` contain a code unit UTF-8 cannot encode?
//
// A surrogate PAIR (high D800..DBFF followed by low DC00..DFFF) is one astral code point
// and encodes to four bytes; any other arrangement is a lone surrogate, and Node's
// encoder substitutes U+FFFD for it (lossy, and permanent: the replacement character is
// ordinary text on re-read, so nothing downstream can spot it).
//
// ONE forward pass over the code units, and a high surrogate that is correctly paired is
// skipped with its partner rather than rescanned, so the cost is proportional to the
// payload exactly once per write — the same order as the `Buffer.byteLength` the receipt
// already pays for. `charCodeAt` on a UTF-16 string yields code units, which is precisely
// what the encoder works from, so this asks the same question the encoder does.
const hasUnpairedSurrogate = (text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);

        if (code < 0xd800 || code > 0xdfff) continue;

        if (code <= 0xdbff) {
            // A high surrogate: paired only when the NEXT code unit is a low one. At the
            // end of the string there is no next unit, so it is lone by definition.
            const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;

            if (next < 0xdc00 || next > 0xdfff) return true;

            // The pair is fine and encodes as one code point; step over the partner.
            index += 1;
            continue;
        }

        // A low surrogate reached outside a pair (the loop above skips every paired one).
        return true;
    }

    return false;
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

        const record = entry as Record<string, unknown>;

        // M9. The schema says `additionalProperties: false`, but the direct call path
        // bypasses schema validation entirely, so an unknown key had to be DESTRUCTURED
        // away to be noticed — and it was not. Naming the key and the allowed list is what
        // turns "my overwrite flag did nothing" into one round trip. Checked before the
        // field types, because a misspelled `path` is the case where "there is no path" is
        // the least useful answer.
        for (const key of Object.keys(record)) {
            if (!(FILE_WRITE_FIELDS as readonly string[]).includes(key)) {
                throw new HarnessError(
                    `write files entries do not accept "${key}". Allowed fields: ${FILE_WRITE_FIELDS.join(', ')}.`
                );
            }
        }

        const { path, content } = record as Partial<FileWriteEntry>;

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
        // L6: decided during the preflight, next to the other content checks, so the write
        // loop cannot report a success without the disclosure it owes.
        prepared.push({ target, identity, content, lossy: hasUnpairedSurrogate(content) });
    }

    return prepared;
};

// F9 — the parent-mkdir failure whose cause is a FILE standing where a folder has to be.
//
// `mkdir(parent, { recursive: true })` in the write loop is the one syscall there whose
// failure can be a STABLE state: if any component of the parent path is an existing
// regular file, no retry and no `recursive` flag can create a directory inside it.
// Measured against this Node (Temp/toolfix-writedit/probe-mkdir.ts): a parent component
// that is a file answers `ENOTDIR: not a directory, mkdir '<x>'`, and a path whose LEAF
// is an existing file answers `EEXIST: file already exists, mkdir '<x>'`; the EEXIST form
// is also what other platforms answer for the parent-component case. Both state the same
// fact, so both get the same answer here.
//
// Uncoded, that state reached the caller as Node's prose inside the per-target envelope
// ("write failed on <x>: EEXIST: file already exists, mkdir '<x>'. Writes already
// completed: …") with NO next step, while the two tools that can observe the identical
// state already advise: `files` routes its mkdir failures through `mkdirRemedy`
// (./files.tool.ts:978-987, rendered by `filesFailureLine` at ./files.tool.ts:1585) and
// `read` answers ENOTDIR with a remedy of its own (./read.tool.ts:4532-4536). `write` is
// the tool literally creating a directory inside that path, so it takes `files`' sentence
// verbatim — it is advice about exactly this syscall — and adds the action this tool
// offers. `read`/`files`/`write` now answer one state with one code and one remedy.
//
// The fold is deliberately narrow: only a `syscall === 'mkdir'` errno of EEXIST or
// ENOTDIR is re-coded, so a staging-create, chmod, rename or cancellation failure keeps
// the classification `publishErrorCode` gives it (./atomic-publish.ts:433-442). `ENOTDIR`
// is already in FILE_WRITE_ERROR_CODES because FILE_PUBLISH_ERROR_CODES carries it
// (./atomic-publish.ts:94-120) — no new code is published — and `rawCode` follows the
// package rule of naming the raw errno ONLY when the fold moved away from it, which is
// also how `files` renders that pairing in prose via `failureCodeLabel`
// (./files.tool.ts:909-910).
// The remedy text: `files`' ENOTDIR mkdir sentence verbatim (./files.tool.ts:985), plus the
// one action this tool can offer that `files` cannot (it has no target path to move).
const PARENT_MKDIR_REMEDY =
    'A component of that path is a file, not a folder; the directory cannot be created inside it. Delete that file, or write the target under a path whose parents are folders';

// Returns the coded refusal for that mkdir state, or `undefined` for every other failure
// (which keeps the existing `publishErrorCode` fold). The caller feeds the three fields
// straight into the per-target envelope, so the "Writes already completed: …" contract
// (write.test.ts:651-676) is untouched by this classification.
const parentMkdirRefusal = (
    error: unknown
): { code: FileWriteErrorCode; rawCode?: string; reason: string } | undefined => {
    const errno = error as { code?: unknown; syscall?: unknown } | undefined;
    const raw = typeof errno?.code === 'string' ? errno.code : '';
    const syscall = typeof errno?.syscall === 'string' ? errno.syscall : '';

    if (syscall !== 'mkdir' || (raw !== 'EEXIST' && raw !== 'ENOTDIR')) return undefined;

    // Node's message already states the errno and the location that `code`/`rawCode`
    // carry, so only the reason survives — the same reduction ./files.tool.ts's
    // `reasonOf` makes (./files.tool.ts:861-887), keeping the syscall NAME in parentheses
    // because "mkdir" is not inferable from the code. A path containing a single quote
    // defeats the anchored match and keeps Node's tail: degraded, still accurate.
    let prose = error instanceof Error ? error.message : String(error);
    if (prose.startsWith(`${raw}: `)) prose = prose.slice(raw.length + 2);
    prose = prose.replace(/, mkdir '(?:[^']*)'$/, ' (mkdir)');

    // `code` first (so a caller that greps for `ENOTDIR on` keeps matching) and the folded
    // errno in parentheses right behind it, exactly as `files` composes its failure lines.
    const code: FileWriteErrorCode = 'ENOTDIR';
    const label = raw === code ? code : `${code} (${raw})`;

    return {
        code,
        ...(raw === code ? {} : { rawCode: raw }),
        reason: `${label}: ${prose}. ${PARENT_MKDIR_REMEDY}`
    };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
//
// WHAT THIS DESCRIPTION OWES A CALLER, and where each sentence came from:
//   - the concurrency sentence (H6) used to claim "neither can silently overwrite the
//     other", which is only true of edit-vs-edit: a full-content write replaces whatever
//     text is current and the rename never version-checks the destination, so a write that
//     runs after a concurrent edit DOES remove that edit. It also now names the bound
//     ./lock.ts has always had (EXTRA-7): serialization is per-PROCESS, and a
//     worker-thread lane has its own lock map;
//   - the atomic-publish sentence carries the D7b trade (a hard link keeps the previous
//     bytes; a 0444 file is overwritable because only the DIRECTORY gates the rename) and
//     the L5 rule (a non-regular target is refused rather than replaced by a regular file);
//   - `lossy` (L6) is disclosed because the corruption is permanent and cannot be spotted
//     on re-read, so this call is the only place that can say it.
//
// The schema's field descriptions are NOT touched: ../../catalogue.test.ts pins the whole
// `parameters` object by value, and none of the changes below alter what a caller may send.
export const WRITE_METADATA: PresetToolMetadata = {
    name: 'write',
    description:
        'Write one or more UTF-8 text files, creating parent directories as needed and overwriting existing files. Pass an array of { path, content } entries and get an ordered array of { path, bytes } in the same order. A call accepts at most 100 files; split a larger batch. Every entry is validated before anything is written, an entry naming any field other than `path` or `content` is rejected rather than ignored, and the same target path twice is rejected. Calls that name the same file are serialized per file (in this process only - a second harness process or a worker-thread lane keeps its own locks), so a concurrent write and edit never interleave into a torn file and a concurrent edit cannot silently clobber another edit. A write replaces the WHOLE text by design and never checks what is currently in the file, so if a concurrent call changed it first, this write wins and that change is gone. Each file is published atomically, so a reader sees either its previous content or its new content, never a partial write, and a failed write leaves that file exactly as it was; the publish replaces the file, so a hard link to it keeps the previous bytes and a read-only existing file can still be overwritten, while a target that is not a regular file (a directory, a FIFO, a device) is refused instead of silently replaced. An unpaired surrogate in the content becomes U+FFFD on disk - permanently, and invisible when the file is read back - so that entry says `lossy: true`. A write error part-way through is reported with the paths already completed, and a cancelled call rejects with `ECANCELED` naming the files already written: there is no rollback.',
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
    execute: async ({ parameters: files, signal }) => {
        // Cancellation before ANY work, including the preflight: `prepareWrites` resolves
        // every target and stats every identity, and a cancelled call has no consumer for
        // any of it (src/types/index.ts:2356-2357 — the harness discards a late result).
        // `ECANCELED`, not the platform AbortError, so the caller sees a code from
        // FILE_WRITE_ERROR_CODES (./cancellation.ts).
        throwIfFileCancelled('write', signal, 'before any file was written', {
            completedPaths: []
        });

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

                for (const { target, content, lossy } of prepared) {
                    try {
                        // Agents write into directories that do not exist yet far more
                        // often than not; failing on that wastes a round trip.
                        const parent = dirname(target);
                        if (!made.has(parent)) {
                            await mkdir(parent, { recursive: true });
                            made.add(parent);
                        }

                        // M10: staged + renamed, not `writeFile(target)` — the SAME publish
                        // `edit` now uses (./atomic-publish.ts). The target is never emptied
                        // in place, so a concurrent reader, an ENOSPC, or a kill cannot
                        // leave — or report — a partial file. `signal` rides along because
                        // that publish is where the per-entry cancellation check lives for
                        // BOTH tools: a batch cancelled at entry 12 stops there and reports
                        // 1-11 as completed (./cancellation.ts).
                        await publishAtomically('write', target, content, signal);
                    } catch (error) {
                        // Partial success is reported honestly: the completed paths are
                        // named so the caller can tell what exists now, and there is no
                        // claim of a transaction or rollback (there is neither).
                        // The failed target is deliberately NOT listed: it still holds the
                        // text it had before (or does not exist yet), which the staged
                        // publish above is what guarantees.
                        //
                        // M11: the completed list goes in `details` as well as in the
                        // sentence, because prose is the half that reaches a model and a
                        // caller that has to recover switches on `code` + `details`.
                        // `reason` is separated from the next sentence by `. ` after a
                        // trailing-period strip — Node's errno messages have NO trailing
                        // period, so the old interpolation glued the two sentences together
                        // ("...open '/x' Writes already completed: none.").
                        const completedPaths = written.map((entry) => entry.path);
                        // F9: a parent mkdir that failed because a path component is a FILE
                        // gets its own code + remedy (see `parentMkdirRefusal`); everything
                        // else — a staging create, chmod, rename, or a cancellation — keeps
                        // the shared publish fold exactly as it was.
                        const refusal = parentMkdirRefusal(error);
                        const { code, rawCode } = refusal ?? publishErrorCode(error);
                        // A classified refusal brings its own composed reason (code, folded
                        // errno in parentheses, remedy); anything else is Node's bare message
                        // with the trailing-period strip described above.
                        const reason =
                            refusal?.reason ??
                            (error instanceof Error ? error.message : String(error)).replace(/[\s.]+$/, '');
                        const where = completedPaths.length === 0 ? 'none' : completedPaths.join(', ');

                        throw new HarnessError(
                            `write failed on ${target}: ${reason}. Writes already completed: ${where}. No rollback was performed.`,
                            {
                                code,
                                details: {
                                    failedPath: target,
                                    completedPaths,
                                    ...(rawCode === undefined ? {} : { rawCode })
                                }
                            }
                        );
                    }

                    // `bytes` is the size of the payload that LANDED. For a `lossy` entry
                    // that is not the length of the caller's string in UTF-8 code units —
                    // each lone surrogate became the three bytes of U+FFFD — which is one
                    // more reason the flag has to be visible next to the number.
                    const entry: FileWriteResultEntry = {
                        path: target,
                        bytes: Buffer.byteLength(content, 'utf8')
                    };

                    // Additive, and present only when it is true, so every pre-existing
                    // `{ path, bytes }` receipt (and the tests pinning them) is unchanged.
                    if (lossy) entry.lossy = true;

                    written.push(entry);
                }

                return written;
            }
        );
    }
});
