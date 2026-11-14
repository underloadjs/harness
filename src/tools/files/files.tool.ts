// files — manage files and folders: list, move, copy, delete, mkdir.
//
// WHY THIS NAME (and why the old rule about it is gone)
// -----------------------------------------------------
// `files` REPLACES `fileList`, and it is named for what it is best at: the whole
// set of file and folder operations that are NOT the everyday verbs (`read`,
// `write`, `edit`, `glob`, `grep` stay exactly where they are). The catalogue used
// to demand an action verb per wire name; that rule was wrong here, because a tool
// whose job is a NOUN DOMAIN is more findable under the domain name than under any
// one of its five operations. See ../catalogue.ts for the rewritten rule.
//
// There is NO `fileList` alias on the wire (../catalogue.ts: two names for one tool
// makes discovery ambiguous), so `fileList` is listed as a retired name in
// ../catalogue.test.ts and every consumer calls `files`.
//
// WHY ONE TOOL FOR FIVE OPERATIONS
// --------------------------------
// The operations are one family: they all take paths, all run against the same
// directory, and a refactor routinely wants two of them IN ONE ORDER ("rename this,
// then delete the old one"). The harness LAUNCHES EVERY TOOL CALL OF ONE ASSISTANT
// MESSAGE CONCURRENTLY (../../harness.ts, "Launch every requested call; they run
// concurrently"), so separate `move` + `delete` calls have no order between them and
// cost an extra turn to sequence. Inside one `ops` array the order IS the contract.
//
// This is NOT the mode switch that `fileGlob` was split for (see ./index.ts): there
// the mode was IMPLICIT, derived from whether `content` was present. Here `op` is an
// explicit required discriminator, every op shares ONE result envelope (an ordered
// `results` array), and paging state lives inside the list result that owns it —
// which also removes the one exception the catalogue had to carve out to the
// single-array-property batching rule (`fileList` needed `offset`/`limit` beside
// `paths`; `files` declares exactly ONE property, `ops`).
//
// ARGUMENTS (one array property, so the single-property rule applies)
// ------------------------------------------------------------------
//     await files([{ op: 'list', path: 'src' }]);
//     await files([{ op: 'move', from: 'a.ts', to: 'b/a.ts' }, { op: 'delete', path: 'a.ts' }]);
//
// A model sends `{ "ops": [ ... ] }` and reaches the same array. Every entry:
//
//     { op, path | from+to, overwrite?, recursive?, force?, offset?, limit? }
//
//   - list   : `path` (string OR string[]; default the working directory ".") +
//              optional `offset`/`limit`.
//   - move   : `from` + `to`, `overwrite` (default false).
//   - copy   : `from` + `to`, `overwrite` (default false).
//   - delete : `path`, `recursive` (default false), `force` (default false).
//   - mkdir  : `path`. Missing parents are created. An existing directory is a
//              no-op success ("the state you asked for already holds").
//
// A field that belongs to another op is REJECTED, naming the op: the JSON Schema
// vocabulary this harness enforces has no `if`/`then` (../../core/schema-validation.ts),
// so cross-field rules are implementation-checked during preflight, and a rejected
// call touches nothing.
//
// RESULT SHAPE (one shape for every op)
// -------------------------------------
//     { results: [...ordered receipts...], bytes, contentBudget }
//
// One receipt per op, in the caller's order:
//
//     list    { op, path, entries, truncated, nextOffset, offset, limit, bytes, error? }
//     move    { op, path, to, kind, bytes }
//     copy    { op, path, to, kind, bytes }
//     delete  { op, path, removed, recursive, skipped? }
//     mkdir   { op, path, created }
//
// A receipt's `path`/`to` follow ./fileList's presentation rule rather than inventing
// one: a LIST reports the caller's own directory spelling and prefixes each entry with
// it (`.` contributes no prefix, so a default list returns bare names; `src` returns
// `src/a.ts`), while move/copy/delete/mkdir report ABSOLUTE posix paths — the same
// separator style as the listed names, so one response never mixes two. (./write and
// ./read report native absolute paths.) `kind` is 'file' or 'directory', and
// `bytes` is the payload the operation moved or wrote: a file's size, the sum of a
// walked directory, and 0 for a directory MOVE (a rename writes no bytes). A COPY
// measures the DESTINATION it just wrote, because that is the payload the receipt
// claims exists now — re-statting the source would report what was intended, not what
// landed — and a destination that cannot be measured fails the call instead of
// reporting 0. A copied SYMLINK contributes 0: a link holds no payload, and stat'ing it
// would report its target's size (or throw outright for a dangling one).
//
// LIST PAGING (the `fileList` window, with the two rules its header promised and its
// code did not enforce: the byte budget is CALL-wide, and one unreadable directory does
// not void the listings of the others)
// ------------------------------------------------
// Each list op is its own bounded window over a deterministic flat sequence:
// directories in the caller's order, each listing sorted by code point, every entry
// prefixed with the directory it came from, directories ending in "/" — including a
// SYMLINK that resolves to a directory, because "walkable" is what the slash means to
// a caller, and the walk does follow it. Only symlinks are stat'ed for that, and a
// link whose target is gone or looping keeps the plain name (never a throw).
//
//   - `limit` entries: default 200 (FILES_LIST_DEFAULT_LIMIT), hard maximum 1000
//     (FILES_LIST_MAX_LIMIT) — larger values are clamped, never rejected. THAT is why
//     the published JSON Schema carries NO `minimum`/`maximum` for `offset`/`limit`:
//     this harness validates a model's arguments BEFORE `execute`
//     (../../core/schema-validation.ts), so bounds written in the schema would reject
//     the oversized value first and turn the clamp below into a dead branch — the
//     promise would only hold for a host calling the tool object directly;
//   - FILES_CONTENT_BUDGET (64 KiB) of UTF-8 entry text is an AGGREGATE budget
//     shared by every list op in the CALL (`bytes` reports what the call consumed,
//     `contentBudget` the fixed cap). It is threaded through the ops as one mutable
//     `{ remaining }`, so the second op in a call starts where the first one stopped.
//     A page stops BEFORE the entry that would cross it, so no entry is ever split,
//     and an op whose turn arrives with the budget already spent answers
//     `entries: []`, `truncated: true`, `nextOffset: <its own offset>` — a cursor that
//     points at the entry that did not fit, never one that silently advances past it;
//   - `truncated` is true when entries exist beyond this page and `nextOffset`
//     locates them; pass it back as that entry's `offset`. An entry whose own
//     UTF-8 size exceeds the whole budget can never be paged, so the call is
//     refused with a message naming it rather than returning a cursor that never
//     advances.
//   - a `path` array may name the SAME directory twice (`src`, `./src`, or a symlinked
//     alias). Duplicates are dropped, first spelling wins, compared by real identity
//     (./identity.ts) for the reason ./search.ts:316-322 gives for its roots: a second
//     pass over one directory duplicates every entry AND shifts `offset` underneath a
//     caller that is paging.
//   - ONE unreadable directory does NOT void the readable ones. Each directory is
//     collected in its own try/catch: the entries already gathered survive, the window
//     is computed over that surviving sequence, and the failure becomes this entry's
//     `error` naming the directory it actually tried to read. Answering `entries: []`
//     with `truncated: false` would claim a COMPLETE listing of a directory the tool
//     never managed to open.
//
// Mutations never stop because of the budget: their receipts are tiny, and a
// half-applied refactor is not a paging problem.
//
// FAILURE SEMANTICS (the read/write asymmetry, deliberately inherited)
// -------------------------------------------------------------------
//   - PREFLIGHT, before anything is touched: the array, the entry shapes, the op
//     names, path strings (non-empty, no NUL), and which fields an op is allowed to
//     carry. One malformed entry rejects the whole call and NO file changes.
//   - FILESYSTEM STATE is checked when an op's turn arrives, never earlier, so a
//     chain reads reality at each step: `{move a→b}` then `{delete b}` works, while
//     a pre-flight stat of `b` would have called the delete a missing path.
//   - a failing MUTATION rejects the call and names the ops already applied. There
//     is NO transaction and NO rollback — the same honest statement `write` makes.
//     A failed directory COPY says more, because "Operations already applied: none"
//     is about the OTHER entries in the call and reads as "nothing happened": the
//     message also counts what THIS op left in the destination — the directories,
//     files, bytes and links it wrote before failing — so a half-built tree is never
//     invisible to the caller that has to clean it up.
//   - a failing LIST op is a per-entry `error: { code, message }` (ENOENT, ENOTDIR,
//     EACCES/EPERM, EIO), exactly like `read`, because a read-only entry in a mixed
//     batch must not throw away mutations that already succeeded. THAT set is closed
//     and it is what `code` publishes: `failureOf` folds every other raw Node errno
//     (ENAMETOOLONG, ELOOP, ERR_FS_EISDIR, ENOTEMPTY, EXDEV, …) onto EIO, because a
//     caller switches on `code` and cannot switch on a set the tool never promises.
//     The raw errno stays in `message`, where the human reading it needs it.
//
// DESTINATION POLICY (no platform luck)
// -------------------------------------
// `fs.rename` is atomic on one device, replaces a file silently on POSIX and fails
// on Windows, and fails on a NON-EMPTY directory everywhere. This tool removes the
// luck: without `overwrite`, an existing destination is an EEXIST error before any
// byte moves; with `overwrite`, the destination is removed first (recursively, for a
// directory) and then replaced. A cross-device move reports EXDEV as-is — the tool
// never silently turns a rename into a copy-plus-delete.
//
// SELF AND CONTAINMENT IS REFUSED BEFORE A BYTE MOVES (both `copy` and `move`,
// whatever `overwrite` says). A destination that IS the source, that lies INSIDE it,
// or that CONTAINS it under `overwrite`, is a refusal naming both paths, because each
// shape destroys the call:
//
//   - `copy from tree to tree` with `overwrite` removes the destination — which is the
//     source — and then copies nothing onto it: the tree is gone and the receipt says
//     success;
//   - `copy from tree to tree/copy` walks into its own freshly written output, and
//     each level re-enters the one above it, until the path overflows
//     (ENAMETOOLONG/ENOSPC after hundreds of levels) with a half-built garbage tree and
//     no rollback;
//   - `move from tree to tree/inside` is the same impossibility in one syscall
//     (POSIX `rename` answers EINVAL, and only after the destination was removed);
//   - `move/copy from tree/sub to tree` with `overwrite` and an EXISTING destination is
//     the mirror image, and it is the one that COSTS DATA: the destination removal is
//     `rm -rf`, so it deletes the directory that HOLDS the source — all of `tree` went
//     with `tree/a.txt` and `tree/deep/…`, the syscall then failed with ENOENT, and the
//     caller was told "Operations already applied: none" about a tree it no longer owns.
//     `mv` refuses this shape without deleting anything, and so does this tool. The same
//     call with the destination ABSENT is a plain rename that CREATES `tree`, so the
//     refusal is asked where the destination is known to exist and to be replaced, not
//     in the path comparison alone.
//
// The check is TEXT where text is sound (`to === from` needs no filesystem access at
// all) and otherwise by REAL IDENTITY (./identity.ts), which settles both directions in
// one pair of `realpath` calls: a symlinked alias of the source is caught as the
// self-overwrite it really is, AND a destination that is textually "inside" the source
// while reaching it through a symlink that ESCAPES the tree (`copy t -> t/dir/out/inner`
// with `t/dir/out -> <elsewhere>`) is NOT refused — the walk never enters that
// directory, and the plain spelling of that same destination (`t -> <elsewhere>/inner`)
// has always worked, so two spellings of one directory must not disagree. Nothing on
// the filesystem is touched before the guard passes — `copyDirectory` additionally
// refuses past FILES_COPY_MAX_DEPTH directory LEVELS below the copy root, which is the
// belt behind those braces: no source that passes the guard should reach it, and one
// that does names the root, the exact level, and the offending path instead of
// overflowing the stack. A symlink inside a copied tree is copied as a symlink
// (`readlink` → `symlink`, target string verbatim), which is also what keeps a link
// pointing at an ancestor from being dereferenced into an infinite walk, and what lets a
// DANGLING link be copied at all (its `stat` is a missing path — see the `lstat`-first
// rule under WHAT `delete` REFUSES, which the `copy`/`move` SOURCE check now shares).
//
// A moved SYMLINK's `bytes` echoes the source `stat`, i.e. the size of the file the link
// points at (a dangling one has no target, so it reports 0) — not the link's own `lstat`
// size, which is the length of its stored target string. Deliberate: the receipt describes
// the payload reachable under that name, and a rename moved exactly that entry.
//
// WHAT `delete` REFUSES
// ---------------------
// A NON-EMPTY directory without `recursive` is an ENOTEMPTY error: `files` never
// deletes a tree the caller did not say it meant. An EMPTY directory needs no such
// permission — that IS what the caller asked for — so it is removed; Node's bare
// `rm`/`rmdir` pair cannot be used blindly here (`rm` answers ERR_FS_EISDIR for a
// directory of either shape, `rmdir` refuses a symlink-to-directory), so the empty
// case goes through `rm` with `recursive: true`, which is only ever a "may remove a
// directory" signal once emptiness has been verified.
//
// The path is examined with `lstat` FIRST and only followed with `stat` when it is a
// symlink, so a DANGLING symlink — `stat` calls it missing, because what it points at
// is gone — stays a real, deletable entry with or without `force`. A missing path is
// an ENOENT error unless `force: true`, which reports the receipt as
// `removed: false, skipped: true` — cancellation-style idempotence, "already deleted"
// is a success, not a surprise.
//
// `recursive` gates CONTENTS, and it is worth exactly what the path ITSELF is: for a
// real directory it takes the whole tree, for a SYMLINK it takes the LINK and never a
// byte under the target (removing the target's contents would delete something the
// caller did not name). The refusal therefore says "symlink to a non-empty directory"
// and "recursive removes the link" — "remove it and everything inside it" promised a
// tree deletion that this shape never performs. A directory whose LISTING fails (mode
// `000`, EACCES on `readdir`) is treated as non-empty as well, and its message names
// the listing failure rather than hiding it behind "is a directory".
//
// The same `lstat`-first reading of a path is what `copy`/`move` now apply to their
// SOURCE: a dangling symlink is a real entry, so it can be moved (a rename never
// follows it) and copied as a link with its stored target string, instead of being
// reported as a source that "does not exist".
//
// No sandbox: every path is resolved against the process working directory and used
// as given, exactly like the rest of ./index.ts. There is no confirmation layer
// here; a host that wants a fence wraps `execute` (or filters this tool out by
// name, which is why the destructive ops and `list` sharing one tool is a decision
// recorded in the README rather than a surprise). A MUTATION does hold the same
// per-file lock ./write and ./edit take (./lock.ts): the harness launches one
// message's calls concurrently, so a `files` move and a `write` to the same path
// serialize instead of racing, and the lock set is released when the batch ends.
//
// Executable on its own and registerable on a harness:
//
//     await files([{ op: 'mkdir', path: 'src/nested' }]);
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue.ts projects the same data synchronously through the
// discovered descriptors, and a consistency test proves the two are equal.

import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, stat, symlink } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { fileIdentity } from './identity';
import { withFileLocks } from './lock';

// Page-size and byte bounds, exported so docs/tests quote the numbers the
// implementation enforces (same convention ./fileList used).
export const FILES_LIST_DEFAULT_LIMIT = 200;
export const FILES_LIST_MAX_LIMIT = 1000;
export const FILES_CONTENT_BUDGET = 64 * 1024;

// How deep `copy` will follow a directory tree. The walk starts at depth 0 = the source
// root itself, so the deepest directory it will CREATE is 64 levels below that root and
// level 65 is the refusal — the refusal message states both numbers, because "stopped at
// 64 levels" alone read as the depth actually reached (it understated it).
//
// The self/containment guard below should make any real source fit in a handful of
// levels; this bound is what turns a source that still slips through it (a link alias
// that only exists mid-walk, a pathological export from another tool) into a named
// refusal instead of a stack overflow, and it is far above any tree a person writes by
// hand. Exported so the test quotes the number the implementation enforces.
export const FILES_COPY_MAX_DEPTH = 64;

// Ops per call. Same ceiling read puts on `paths`, so one tool response can never
// grow without bound no matter how many operations a caller batches.
export const FILES_MAX_OPS = 100;

export type FilesOperationKind = 'list' | 'move' | 'copy' | 'delete' | 'mkdir';

// One operation. Fields an op does not use are rejected at run time, naming the op.
export type FilesOperation = {
    // Which operation this entry is. The one always-required field.
    op: FilesOperationKind;
    // list: one directory or several (paged as ONE flat sequence). delete/mkdir: one path.
    path?: string | string[];
    // move/copy: source.
    from?: string;
    // move/copy: destination.
    to?: string;
    // move/copy: replace an existing destination instead of failing on it.
    overwrite?: boolean;
    // delete: remove a directory and its contents.
    recursive?: boolean;
    // delete: a missing path is a no-op success.
    force?: boolean;
    // list: 0-based index into the deterministic flat entry list.
    offset?: number;
    // list: maximum entries in this page (default 200; clamped into 1-1000, never
    // rejected for being out of range).
    limit?: number;
};

// The value `execute` receives: the `ops` array itself (single-property rule).
export type FilesParameters = FilesOperation[];

// One completed (or individually failed) operation, in request order.
export type FilesOperationResult = {
    op: FilesOperationKind;
    // Absolute resolved path (list reports the FIRST requested path, since a list
    // entry may name several directories).
    path?: string;
    // move/copy: absolute resolved destination.
    to?: string;
    // move/copy: what was moved.
    kind?: 'file' | 'directory';
    // list: this page of entries, prefixed and sorted. A directory (or a symlink that
    // resolves to one) carries the trailing "/".
    entries?: string[];
    // list: more entries exist past this page.
    truncated?: boolean;
    // list: offset to pass back for the next page, or null at the end.
    nextOffset?: number | null;
    // list: the offset and limit actually used.
    offset?: number;
    limit?: number;
    // delete: the path existed and was removed.
    removed?: boolean;
    // delete: the caller asked for a recursive removal.
    recursive?: boolean;
    // delete: `force` on a missing path, so nothing was removed.
    skipped?: boolean;
    // mkdir: the directory did not exist and was created.
    created?: boolean;
    // move/copy: bytes moved (file size, walked sum for a copied directory, 0 for a
    // renamed one). list: UTF-8 bytes of this page's entry text.
    bytes?: number;
    // list only: a read-only failure is reported here and never fails the call.
    error?: { code: string; message: string };
};

// The ordered result. `bytes` is what the call charged against the shared list
// budget; `contentBudget` is the fixed cap it was subject to.
export type FilesResult = {
    results: FilesOperationResult[];
    bytes: number;
    contentBudget: number;
};

// Posix separators in every result, on every platform (./fileList's convention).
const toPosixPath = (value: string): string => value.split(sep).join('/');

// Code-point comparison, never localeCompare: a locale-dependent sort would shift a
// page boundary between hosts (same rationale ./fileList recorded).
const compareNames = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

// Fields each op is allowed to carry, `op` itself excluded. Anything else is a
// caller mistake: silently ignoring `{ op: 'delete', to: 'x' }` would delete a file
// the caller believed it was renaming.
const OP_FIELDS: Record<FilesOperationKind, readonly string[]> = {
    list: ['path', 'offset', 'limit'],
    move: ['from', 'to', 'overwrite'],
    copy: ['from', 'to', 'overwrite'],
    delete: ['path', 'recursive', 'force'],
    mkdir: ['path']
};

const OP_NAMES: readonly FilesOperationKind[] = ['list', 'move', 'copy', 'delete', 'mkdir'];

// A path string, validated the way ./write and ./fileList validate theirs.
const requirePath = (value: unknown, name: string, op: FilesOperationKind): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw new HarnessError(`files ${op} requires a non-empty "${name}" string.`);
    }

    if (value.includes('\u0000')) {
        throw new HarnessError(`files ${op} "${name}" must not contain NUL characters.`);
    }

    return value;
};

// A whole entry, validated once, before the first op runs. Returns everything the
// execution loop needs, so the loop itself never re-checks shape.
type PreparedOperation = {
    op: FilesOperationKind;
    path: string;
    // list only: every directory it walks, in order.
    paths: string[];
    from?: string;
    to?: string;
    overwrite: boolean;
    recursive: boolean;
    force: boolean;
    offset: number;
    limit: number;
};

const prepareOperation = (entry: unknown, index: number): PreparedOperation => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new HarnessError(`files ops[${index}] must be an object with an "op" field.`);
    }

    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    const op = record.op;

    if (typeof op !== 'string' || !OP_NAMES.includes(op as FilesOperationKind)) {
        throw new HarnessError(
            `files ops[${index}] needs "op" as one of: ${OP_NAMES.join(', ')}. Received ${JSON.stringify(op)}.`
        );
    }

    const kind = op as FilesOperationKind;
    const allowed = ['op', ...OP_FIELDS[kind]];

    for (const key of keys) {
        if (!allowed.includes(key)) {
            throw new HarnessError(`files ${kind} does not accept "${key}". Allowed fields: ${allowed.join(', ')}.`);
        }
    }

    // Defaults first: an absent knob means the documented default, never 0 or 1.
    let overwrite = false;
    let recursive = false;
    let force = false;
    let offset = 0;
    let limit = FILES_LIST_DEFAULT_LIMIT;

    if (record.overwrite !== undefined) {
        if (typeof record.overwrite !== 'boolean') {
            throw new HarnessError(`files ${kind} "overwrite" must be a boolean.`);
        }

        overwrite = record.overwrite;
    }

    if (record.recursive !== undefined) {
        if (typeof record.recursive !== 'boolean') {
            throw new HarnessError(`files ${kind} "recursive" must be a boolean.`);
        }

        recursive = record.recursive;
    }

    if (record.force !== undefined) {
        if (typeof record.force !== 'boolean') {
            throw new HarnessError(`files ${kind} "force" must be a boolean.`);
        }

        force = record.force;
    }

    // ./fileList's paging arithmetic, kept identical: a number is floored and
    // clamped, a non-number is an error (silently defaulting would restart page 1
    // and loop forever), and an oversized limit is "as much as allowed".
    const pageField = (value: unknown, name: 'offset' | 'limit', fallback: number, clamp: (n: number) => number) => {
        if (value === undefined || value === null) return fallback;

        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new HarnessError(`files ${kind} "${name}" must be a number when provided.`);
        }

        return clamp(Math.floor(value));
    };

    let path = '';
    let paths: string[] = [];
    let from: string | undefined;
    let to: string | undefined;

    if (kind === 'list') {
        const rawPaths = record.path;

        if (rawPaths === undefined || rawPaths === null) {
            // The documented default: the working directory, as `fileList` had it.
            paths = ['.'];
        } else if (Array.isArray(rawPaths)) {
            // An explicit empty array is rejected rather than answered with nothing:
            // `[]` would read as "this directory is empty".
            if (rawPaths.length === 0) {
                throw new HarnessError(
                    `files list received an empty "path" array. Omit "path" to list the working directory.`
                );
            }

            paths = rawPaths.map((value) => requirePath(value, 'path', kind));
        } else {
            paths = [requirePath(rawPaths, 'path', kind)];
        }

        // The receipt reports the caller's own spelling (see ./fileList's presentation
        // rule); the listing is READ from the resolved path below.
        path = paths[0]!;
        offset = pageField(record.offset, 'offset', 0, (floored) => (floored < 0 ? 0 : floored));
        limit = pageField(record.limit, 'limit', FILES_LIST_DEFAULT_LIMIT, (floored) =>
            floored < 1 ? 1 : floored > FILES_LIST_MAX_LIMIT ? FILES_LIST_MAX_LIMIT : floored
        );
    } else if (kind === 'move' || kind === 'copy') {
        from = requirePath(record.from, 'from', kind);
        to = requirePath(record.to, 'to', kind);
        path = resolve(from);
    } else {
        path = resolve(requirePath(record.path, 'path', kind));
    }

    return {
        op: kind,
        path,
        // list keeps its own resolved list so a directory typo cannot leak.
        paths: kind === 'list' ? paths : [path],
        from: from === undefined ? undefined : resolve(from),
        to: to === undefined ? undefined : resolve(to),
        overwrite,
        recursive,
        force,
        offset,
        limit
    };
};

// The directories one list op walks, with a directory named several ways kept ONCE,
// in the FIRST spelling's form. Two spellings of one directory otherwise duplicate
// every entry of that directory and move `offset` underneath a caller that is paging,
// which is the same reason ./search.ts:316-322 dedupes its roots by `fileIdentity`
// rather than by `resolve`: a symlinked alias survives `resolve` as new text.
const dedupePaths = async (paths: string[]): Promise<string[]> => {
    if (paths.length < 2) return paths;

    const seen = new Set<string>();
    const kept: string[] = [];

    for (const path of paths) {
        const key = await fileIdentity(path);
        if (seen.has(key)) continue;

        seen.add(key);
        kept.push(path);
    }

    return kept;
};

// Validate the whole batch before the first filesystem call.
//
// Async for one reason: a `list` op's `path` array is deduped by REAL identity
// (./identity.ts), and identity needs `realpath`. Nothing is created, removed or
// written here — the preflight stays read-only, so a later malformed entry still
// cannot leave a half-applied refactor.
const prepareOperations = async (ops: FilesParameters): Promise<PreparedOperation[]> => {
    if (!Array.isArray(ops)) {
        throw new HarnessError(
            'files expects an array of { op, ... } entries, e.g. [{"op":"list","path":"src"}].'
        );
    }

    if (ops.length === 0) {
        throw new HarnessError('files received an empty ops array; pass at least one operation.');
    }

    if (ops.length > FILES_MAX_OPS) {
        throw new HarnessError(
            `files accepts at most ${FILES_MAX_OPS} operations per call. Received ${ops.length}.`
        );
    }

    const prepared: PreparedOperation[] = [];

    for (let index = 0; index < ops.length; index += 1) {
        prepared.push(prepareOperation(ops[index], index));
    }

    for (const operation of prepared) {
        if (operation.op !== 'list') continue;

        operation.paths = await dedupePaths(operation.paths);
    }

    return prepared;
};

// The CLOSED set this tool publishes (see FAILURE SEMANTICS in the header). It is the
// machine-readable half of a list receipt, so a caller can switch on it; every other
// errno the kernel can answer is not a name it could plan for.
const PUBLISHED_ERROR_CODES: readonly string[] = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EIO'];

// Map a Node filesystem error onto that set. `code` is normalized (ENAMETOOLONG,
// ELOOP, ERR_FS_EISDIR, ENOTEMPTY, EXDEV and anything else unknown all answer EIO)
// while `message` keeps the raw errno, because the person reading the receipt needs
// the real reason and the code is only ever a switch target.
const failureOf = (error: unknown, path: string): { code: string; message: string } => {
    const reason = error instanceof Error ? error.message : String(error);
    // The raw errno, when the thrown value carries one. Absent for a hand-thrown
    // Error, which is why the empty string means "no errno" below.
    const raw =
        typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : '';

    const code = PUBLISHED_ERROR_CODES.includes(raw) ? raw : 'EIO';
    // Keep the raw name visible: Node usually opens its message with it ("ELOOP: too
    // many symbolic links…"), but the ERR_* codes and a hand-thrown Error do not
    // guarantee it, and the caller is reading this once `code` has been folded to EIO.
    const detail = raw === code || raw === '' || reason.startsWith(`${raw}:`) ? reason : `${raw}: ${reason}`;

    return { code, message: `${code} on ${path}: ${detail}` };
};

// The path the FAILING syscall actually named (D10). Node puts it on `error.path` — the
// same string its message quotes (`scandir '<dir>'`) — so a failure deep inside a walked
// tree names the entry that broke instead of whatever path the CALLER happened to pass.
// The measured wrong shape: a copy aborted by `scandir` on `<root>/t/deep` was reported
// as `EACCES on <root>/t2`, pointing at the half-built destination while the source was
// the unreadable side. `fallback` keeps the message complete for a hand-thrown Error,
// which carries no `path`.
const failingPath = (error: unknown, fallback: string): string =>
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { path?: unknown }).path === 'string' &&
    (error as { path: string }).path.length > 0
        ? (error as { path: string }).path
        : fallback;

// What a copy has ALREADY put into the destination, counted during the walk so a failure
// can quantify the half-built tree (D5). `bytes` is file payload only — a symlink holds
// none — and `directories` counts every directory this call created, including the
// destination root, because a walk aborted on an unreadable SOURCE subdirectory still
// left the parent chain standing. One mutable cell is threaded through the recursion, so
// the counts survive the throw that unwinds the walk to the caller that reports them.
type CopyProgress = { files: number; bytes: number; links: number; directories: number };

// The sentence a failed copy appends. "Operations already applied: none" (added by
// ./execute) is literally about the OTHER entries of the call, and a caller that reads it
// as "nothing happened" leaves the destination believing it is untouched while half a tree
// sits on disk — so the message names this op's own state, the way ./write.tool.ts:118-127
// makes its failed entry's state explicit. A flat tally (dir/file/link counts plus bytes)
// is exact without quoting a list that can be hundreds of names long.
const copyProgressNote = (to: string, progress: CopyProgress): string =>
    progress.directories === 0 && progress.files === 0 && progress.links === 0
        ? ` Nothing had been written into "${toPosixPath(to)}" when this copy failed.`
        : ` Before it failed, this copy had already put ${progress.directories} dir(s), ${progress.files} file(s) (${progress.bytes} byte(s)) and ${progress.links} link(s) into "${toPosixPath(to)}"; they are still there.`;

// Size of a file the caller has just written, measured on the path handed in.
//
// A copy reports the bytes it PUT ON DISK, so it measures the destination rather than
// re-reading the source and trusting the write to have been byte-exact. A failed stat
// is NOT folded into a silent 0 the way a caller-side probe might allow: the copy
// already reported success, so a destination that cannot be measured is an error the
// caller hears about, not a receipt that quietly lies.
const sizeOfCopiedFile = async (path: string): Promise<number> => (await stat(path)).size;

// Recursive copy walk. Returns the total bytes of file payloads written, which is
// what a copied directory reports as `bytes` (a moved directory renames and writes
// nothing, so it reports 0). `root` is the directory the call started from, so the
// depth refusal can name it, and `depth` is how many directories deep this level is
// (0 = the root itself, so the deepest directory written is `depth`
// FILES_COPY_MAX_DEPTH and FILES_COPY_MAX_DEPTH + 1 is the refusal). `progress` is the
// CALL's mutable tally of what has landed in the destination; it is threaded down and
// read by the caller on failure, because the walk aborts by throwing and the counts have
// to survive that unwind (D5).
const copyDirectory = async (
    from: string,
    to: string,
    root: string = from,
    depth = 0,
    progress: CopyProgress = { files: 0, bytes: 0, links: 0, directories: 0 }
): Promise<number> => {
    // Defense in depth behind the self/containment guard in ./runMutation: a source
    // that reaches this bound by some route the guard did not anticipate is refused by
    // name instead of overflowing the stack inside a half-copied tree. The exact level is
    // stated next to the bound it crossed, because "stopped at 64 levels" read as the
    // depth reached when the offending path is 65 levels down.
    if (depth > FILES_COPY_MAX_DEPTH) {
        throw new HarnessError(
            `files copy stopped at ${FILES_COPY_MAX_DEPTH} levels of nesting: "${toPosixPath(from)}" is ${depth} levels below the copy root "${toPosixPath(root)}". Refusing to go deeper.`
        );
    }

    await mkdir(to, { recursive: true });
    // One new directory per level of the walk (the recursion creates the tree one level at
    // a time, so this count is exact), and the reason the depth refusal below can say what
    // it left behind rather than "nothing".
    progress.directories += 1;

    const listing = await readdir(from, { withFileTypes: true });
    let bytes = 0;

    for (const entry of listing) {
        const source = join(from, entry.name);
        const target = join(to, entry.name);

        if (entry.isDirectory()) {
            bytes += await copyDirectory(source, target, root, depth + 1, progress);
        } else if (entry.isFile()) {
            await copyFile(source, target);

            const size = await sizeOfCopiedFile(target);

            bytes += size;
            // Counted as it lands, so a later entry's failure reports the truth about the
            // entries before it (see ./copyProgressNote).
            progress.files += 1;
            progress.bytes += size;
        } else if (entry.isSymbolicLink()) {
            // A symlink is copied AS a symlink: `readlink` returns the stored target
            // string, so a relative link keeps its meaning inside the copy and a link
            // pointing at an ancestor is never dereferenced into an endless walk. If the
            // platform refuses the link (Windows without privilege) the raw error
            // surfaces through the caller's `files copy failed on …` message rather than
            // silently becoming a dereferenced copy. A link holds no payload, so it adds
            // 0 bytes; stat'ing it would report its TARGET's size and throw outright for
            // a dangling one.
            await symlink(await readlink(source), target);
            progress.links += 1;
        } else {
            // A socket, fifo or device inside a copied tree is reported, never silently
            // skipped or followed into someone else's directory.
            throw new HarnessError(
                `files copy does not follow special entries: "${toPosixPath(source)}" is neither a file, a directory, nor a symlink.`
            );
        }
    }

    return bytes;
};

// The one list operation: build the flat sequence, then window it.
//
// Every requested directory is read even when the window covers only the first one,
// which is what makes a missing directory visible (as this entry's own error) rather
// than silently absent — and a directory that CANNOT be read stays a visible error
// without voiding the directories that could be.
//
// `budget` is the CALL's shared UTF-8 allowance (one mutable cell created in ./execute
// and handed to every list op in order), so FILES_CONTENT_BUDGET means "64 KiB across
// the whole call", which is what the description promises. Charging it per op instead
// let a call of N list ops return N x 64 KiB of entry text and report a `bytes` total
// above the `contentBudget` printed beside it.
const runList = (
    request: PreparedOperation,
    budget: { remaining: number }
): Promise<FilesOperationResult> => {
    // The label an entry gets: directories end in "/", everything else is the bare
    // name. "Walkable" is what the slash means, and a symlink that resolves to a
    // directory IS walkable, so it gets one too. Only symlinked entries are stat'ed, so
    // a normal directory pays no extra syscall, and a link that cannot be followed
    // (dangling, or a loop) keeps the plain name rather than failing the listing.
    const entryLabel = async (directory: string, entry: Dirent): Promise<string> => {
        if (entry.isDirectory()) return `${entry.name}/`;

        if (entry.isSymbolicLink()) {
            try {
                if ((await stat(join(directory, entry.name))).isDirectory()) return `${entry.name}/`;
            } catch {
                // Nothing to follow: report the link itself. A listing of the readable
                // entries is worth more than one entry's missing target.
            }
        }

        return entry.name;
    };

    const collect = async (): Promise<{ entries: string[]; failure?: { cause: unknown; path: string } }> => {
        const entries: string[] = [];
        // The FIRST directory that could not be read, kept instead of thrown: one bad
        // path must cost the caller that path, not the entries collected from the others.
        // Returning `entries: [], truncated: false` on a failure also claims the listing
        // COMPLETED, which is the loudest part of the bug.
        let failure: { cause: unknown; path: string } | undefined;

        for (const directory of request.paths) {
            // READ the resolved path, PREFIX with the caller's spelling: `fileList`'s
            // presentation rule, so `.` contributes no prefix and a default list returns
            // bare entry names, while `src` returns `src/a.ts` (never an absolute path).
            const target = resolve(directory);

            try {
                const listing = await readdir(target, { withFileTypes: true });
                const names: string[] = [];

                for (const entry of listing) {
                    names.push(await entryLabel(target, entry));
                }

                names.sort(compareNames);

                for (const name of names) {
                    entries.push(toPosixPath(join(directory, name)));
                }
            } catch (error) {
                // The RESOLVED path goes into the receipt: the caller's spelling alone
                // ("src") is not enough to debug when the working directory is not the
                // caller's, so the failed directory is named as the tool read it.
                failure ??= { cause: error, path: toPosixPath(target) };
            }
        }

        return { entries, failure };
    };

    return collect()
        .then(({ entries, failure }) => {
            const window = entries.slice(request.offset, request.offset + request.limit);

            const page: string[] = [];
            let bytes = 0;

            for (const entry of window) {
                const size = Buffer.byteLength(entry, 'utf8');

                if (size > FILES_CONTENT_BUDGET) {
                    throw new HarnessError(
                        `files list entry at offset ${request.offset + page.length} is ${size} UTF-8 bytes, larger than the ${FILES_CONTENT_BUDGET}-byte budget, so it can never be returned. List a deeper directory so the entry prefix is shorter, or shorten the entry's name.`
                    );
                }

                // THE CALL's remaining allowance, not a fresh per-op budget: an entry
                // that no longer fits ends this page, and no entry is ever split.
                if (size > budget.remaining) break;

                budget.remaining -= size;
                page.push(entry);
                bytes += size;
            }

            const consumed = request.offset + page.length;
            const truncated = consumed < entries.length;

            return {
                op: 'list' as const,
                path: toPosixPath(request.path),
                entries: page,
                truncated,
                // An op that arrives to a spent budget answers an EMPTY page pointing at
                // its own offset: the entry that did not fit is still the next one, so a
                // caller that frees budget (or pages a smaller path) can ask again.
                nextOffset: truncated ? consumed : null,
                offset: request.offset,
                limit: request.limit,
                bytes,
                // Absent unless a directory failed, so a clean receipt keeps the exact
                // shape the paging tests pin.
                ...(failure === undefined ? {} : { error: failureOf(failure.cause, failure.path) })
            };
        })
        .catch((error: unknown) => {
            // An oversized entry is a refusal, not a read failure: it must still
            // fail the call, because its cursor can never advance.
            if (error instanceof HarnessError) throw error;

            // Unreachable in practice — ./collect catches every read failure of every
            // requested directory — but a list entry reports its own failure rather than
            // throwing (see FAILURE SEMANTICS), so an unexpected one still lands there
            // instead of throwing away mutations an earlier entry already applied.
            return {
                op: 'list' as const,
                path: toPosixPath(request.path),
                entries: [] as string[],
                truncated: false,
                nextOffset: null,
                offset: request.offset,
                limit: request.limit,
                bytes: 0,
                error: failureOf(error, toPosixPath(resolve(request.path)))
            };
        });
};

// Why `to` cannot hold a copy or move of `from`, or `undefined` when it can.
//
// 'self'     — one and the same path, so the `overwrite` removal would delete the source;
// 'inside'   — `to` lies under `from`, so a copy feeds its own output and a move asks
//              POSIX to put a directory inside itself;
// 'ancestor' — `from` lies under `to`. Legal on its own (`move t/sub -> t` with `t`
//              ABSENT is a plain rename that creates `t`), fatal exactly when the
//              destination EXISTS and `overwrite` asks for it: the removal there is
//              `rm -rf` on a directory that CONTAINS the source, which deletes the very
//              subtree the operation is reading. ./runMutation decides that case, because
//              it is the only one holding the destination's state.
//
// TEXT answers where text is sound (`to === from` needs no filesystem access at all);
// every other verdict comes from REAL IDENTITY (./identity.ts), which is why one pair of
// `realpath` calls settles both directions. The measured reason text is NOT sound enough
// to refuse on: a destination can be textually under the source while reaching it through
// a symlink INSIDE the tree that escapes it — `t/dir/out -> <root>/outside`, so
// `copy t -> t/dir/out/inner` lands in `<root>/outside/inner`, outside everything the walk
// touches — while the plain spelling of the SAME directory (`t -> <root>/outside/inner`)
// was accepted. Two spellings of one destination agreeing is a `realpath` question, not a
// string one. Identity catches the opposite alias as well: `link -> tree` copied onto
// `tree` is the self-overwrite it really is, and `t -> alias/new` with `alias -> t` IS
// inside the source however the destination is spelled.
type SourceRelationship = 'self' | 'inside' | 'ancestor';

const selfOrContained = async (from: string, to: string): Promise<SourceRelationship | undefined> => {
    // `resolve` leaves a trailing separator only on a filesystem root, hence the guard
    // before building the "everything strictly under this path" prefix.
    const contains = (parent: string, child: string): boolean =>
        child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

    // The one text answer that needs no confirmation: both sides arrive `resolve`d, so
    // `tree`, `./tree` and `x/../tree` are already one string, and that fast path keeps a
    // plain self-call at zero syscalls.
    if (to === from) return 'self';

    // Real identity for everything else. The guard already paid these two `realpath` calls
    // for every destination that was not textually self/inside, so the ordinary
    // (`t -> t2`) call costs exactly what it cost before.
    const fromIdentity = await fileIdentity(from);

    // The destination's spelling names the source's REAL directory: `from` is a symlinked
    // alias of it, or the source itself is one.
    if (to === fromIdentity) return 'self';

    const toIdentity = await fileIdentity(to);

    if (toIdentity === fromIdentity) return 'self';

    // 'inside' — asked REAL to REAL, which is what lets an escaping-symlink destination
    // through while still refusing the genuinely contained spellings (`t -> t/sub`,
    // `t-link -> t/deep`, and `t -> alias/new` / `t -> alias/exists` with `alias -> t`,
    // whose identities come back under the source either way).
    if (contains(fromIdentity, toIdentity)) return 'inside';

    // 'ancestor' — the destination's real location holds the source's real location, so
    // replacing it would delete the source's tree (see the verdict table above).
    return contains(toIdentity, fromIdentity) ? 'ancestor' : undefined;
};

// One mutation, executed when its turn arrives. Throwing here is what rejects the
// call; the caller names the ops that already completed.
const runMutation = async (request: PreparedOperation): Promise<FilesOperationResult> => {
    const { op, path } = request;

    if (op === 'mkdir') {
        try {
            const existing = await stat(path).catch(() => undefined);

            if (existing?.isDirectory()) {
                return { op, path: toPosixPath(path), created: false };
            }

            if (existing?.isFile()) {
                throw new HarnessError(`files mkdir refused: "${path}" is a file, not a directory.`);
            }

            await mkdir(path, { recursive: true });
        } catch (error) {
            if (error instanceof HarnessError) throw error;

            throw new HarnessError(`files mkdir failed on ${path}: ${failureOf(error, path).message}`);
        }

        return { op, path: toPosixPath(path), created: true };
    }

    if (op === 'delete') {
        // WHAT the path ITSELF is, from `lstat`. `stat` follows a symlink, so a link
        // whose target is gone looks exactly like a path that never existed — which made
        // a dangling symlink impossible to delete, however often the caller asked. The
        // link is a real entry, and removing it is what the caller named.
        const existing: Stats | undefined = await lstat(path).catch(() => undefined);

        if (existing === undefined) {
            if (!request.force) {
                throw new HarnessError(
                    `files delete: "${path}" does not exist. Pass force: true when "already gone" is an acceptable answer.`
                );
            }

            return { op, path: toPosixPath(path), removed: false, skipped: true, recursive: request.recursive };
        }

        // What the path POINTS AT, for the directory question only: a real directory is
        // its own target, a symlink is followed, and a dangling link has no target at all
        // (so it is removed as the entry it is, never refused as a directory).
        const target: Stats | undefined = existing.isSymbolicLink()
            ? await stat(path).catch(() => undefined)
            : existing;

        const isDirectoryEntry = target?.isDirectory() === true;

        if (isDirectoryEntry && !request.recursive) {
            // Only a NON-EMPTY tree needs the caller's permission. An empty directory is
            // exactly what the caller asked for and is removed below; emptiness is
            // decided by `readdir`, and a directory that cannot be listed is treated as
            // non-empty, because refusing with an actionable message beats deleting a
            // tree nobody could enumerate. The FAILURE of the listing is kept apart from
            // a real "it has entries" answer, because the two need different remedies and
            // folding them together hid an EACCES behind "is a directory".
            const listing: { entries: number; failure: unknown } = await readdir(path).then(
                (names) => ({ entries: names.length, failure: undefined }),
                (error: unknown) => ({ entries: 0, failure: error })
            );

            if (listing.failure !== undefined) {
                // The real cause is quoted, not swallowed: "is a directory. Pass recursive"
                // sent a caller to a flag whose removal then failed on the same EACCES.
                throw new HarnessError(
                    `files delete: "${path}" ${existing.isSymbolicLink() ? 'is a symlink whose directory could not be listed' : 'is a directory that could not be listed'}, so it is treated as non-empty: ${failureOf(listing.failure, path).message} Pass recursive: true to attempt the removal anyway${
                        existing.isSymbolicLink() ? ' (it removes the LINK only, never the target)' : ''
                    }.`
                );
            }

            if (listing.entries > 0) {
                // Checked explicitly so the error says what to do, rather than reporting
                // Node's ENOTEMPTY with no instruction. The two shapes need different
                // words, because `recursive` means different things for each of them: a
                // REAL directory loses its whole tree, a SYMLINK loses the LINK and keeps
                // every byte under the target (./delete examines the path with `lstat`
                // first for exactly that reason — the link is the entry the caller named).
                // Saying "remove it and everything inside it" about a link promised a tree
                // deletion the flag never performs.
                throw new HarnessError(
                    existing.isSymbolicLink()
                        ? `files delete: "${path}" is a symlink to a non-empty directory. Pass recursive: true to remove the LINK; the directory it points at, and everything inside it, stay.`
                        : `files delete: "${path}" is a directory. Pass recursive: true to remove it and everything inside it.`
                );
            }
        }

        try {
            if (isDirectoryEntry && !request.recursive) {
                // The verified-empty shape. `rm(path, { recursive: false })` answers
                // ERR_FS_EISDIR for ANY directory and `rmdir` refuses a
                // symlink-to-directory with ENOTDIR, so `recursive: true` here is not a
                // promise about contents (emptiness was just checked, and a link is
                // removed without following it) — it is the one call that removes both
                // shapes. The receipt still reports the caller's own `recursive: false`.
                await rm(path, { recursive: true, force: false });
            } else {
                // A file, or a symlink with or without a live target: one unlink.
                //
                // `force` stays out of this call on purpose: `force: true` is documented
                // as the ANSWER to a missing path (the skipped receipt above), and
                // forwarding it to `rm` would let a path that vanished between the stat
                // and the unlink report success as if it had been removed here.
                await rm(path, { recursive: request.recursive, force: false });
            }
        } catch (error) {
            throw new HarnessError(`files delete failed on ${path}: ${failureOf(error, path).message}`);
        }

        return { op, path: toPosixPath(path), removed: true, recursive: request.recursive };
    }

    // move | copy
    const fromPath = request.from ?? path;
    const toPath = request.to ?? resolve('.');

    // WHAT the source ITSELF is, from `lstat` — the same first check ./delete adopted
    // above. `stat` follows a symlink, so a DANGLING link looked exactly like a path that
    // never existed, even though `rename` moves it without ever following it and the
    // in-tree walk copies it as a link: `copy t/dangling -> d2` answered "source does not
    // exist" for an entry `delete` removes in the same call.
    const sourceEntry: Stats | undefined = await lstat(fromPath).catch(() => undefined);

    if (sourceEntry === undefined) {
        throw new HarnessError(`files ${op}: source "${fromPath}" does not exist.`);
    }

    // What the source POINTS AT, for the directory question only: a real directory is its
    // own target, a live symlink is followed (that is the tree a copy of `link-to-dir`
    // walks), and a dangling link has no target at all — so it stays the link-shaped entry
    // it is, never a directory and never a missing path.
    const sourceTarget: Stats | undefined = sourceEntry.isSymbolicLink()
        ? await stat(fromPath).catch(() => undefined)
        : sourceEntry;

    // SELF AND CONTAINMENT (see DESTINATION POLICY): asked here, before the destination
    // parents are created and long before the `overwrite` removal, so a refusal leaves
    // the filesystem exactly as it was. `self` and `inside` destroy the call outright:
    // `copy X -> X` replaces the source with itself and reports a success that deleted the
    // tree, and `copy X -> X/inside` walks into its own output.
    const relationship = await selfOrContained(fromPath, toPath);

    if (relationship === 'self' || relationship === 'inside') {
        const why =
            relationship === 'self'
                ? 'source and destination are the same path, so replacing the destination would delete what this operation reads from'
                : op === 'copy'
                  ? 'the destination is inside the source, so the copy would walk into its own output'
                  : 'the destination is inside the source, and a directory cannot be moved inside itself';

        throw new HarnessError(
            `files ${op} refused: ${why}. Source "${fromPath}", destination "${toPath}". Pass a "to" that is neither the source nor under it.`
        );
    }

    const destination = await stat(toPath).catch(() => undefined);

    if (destination !== undefined && !request.overwrite) {
        throw new HarnessError(
            `files ${op}: destination "${toPath}" already exists. Pass overwrite: true to replace it.`
        );
    }

    // THE ANCESTOR SHAPE (D1). Asked HERE, once the destination is known to exist, because
    // that is the only case that costs data: an absent `to` makes `move t/sub -> t` a plain
    // rename that CREATES `t`, and without `overwrite` the EEXIST refusal above already
    // answered. With both, the removal below is `rm -rf` on a directory holding the source,
    // which deleted `t/a.txt`, `t/deep/…` AND `t/sub/…`, then failed (ENOENT for the rename,
    // ENOENT for `scandir` on the copy) while reporting "Operations already applied: none".
    // Still before any mutation — no `mkdir`, no `rm`.
    if (relationship === 'ancestor' && destination !== undefined && request.overwrite) {
        throw new HarnessError(
            `files ${op} refused: the destination contains the source, so replacing it would delete the tree this operation reads from. Source "${fromPath}", destination "${toPath}". Pass a "to" that is not an ancestor of "from".`
        );
    }

    // Parents of the destination do not exist as often as they do: create them, the
    // way ./write does, rather than costing the caller a round trip.
    await mkdir(dirname(toPath), { recursive: true });

    if (destination !== undefined && request.overwrite) {
        try {
            await rm(toPath, { recursive: true, force: true });
        } catch (error) {
            throw new HarnessError(
                `files ${op} could not replace ${toPath}: ${failureOf(error, failingPath(error, toPath)).message}`
            );
        }
    }

    const kind: 'file' | 'directory' = sourceTarget?.isDirectory() === true ? 'directory' : 'file';

    if (op === 'copy') {
        let bytes = 0;
        // Tally of what lands in the destination, read back if the walk aborts (D5).
        const written: CopyProgress = { files: 0, bytes: 0, links: 0, directories: 0 };

        try {
            bytes =
                kind === 'directory'
                    ? await copyDirectory(fromPath, toPath, fromPath, 0, written)
                    : sourceTarget === undefined
                      // A DANGLING symlink source has no payload to copy, so the LINK is the
                      // entry: `readlink` + `symlink` puts the stored target string there
                      // verbatim, matching what the in-tree symlink copy does. Copying it as
                      // a file was impossible anyway (`copyFile` follows the link and fails
                      // ENOENT), which is why this shape used to be refused outright.
                      ? await copySymlinkEntry(fromPath, toPath, written)
                      : await copyFileWithSize(fromPath, toPath, written);
        } catch (error) {
            // The destination's own state comes out before anything else, because
            // "Operations already applied: none" (added by ./execute) reads as "this call
            // changed nothing" while a half-copied tree sits on disk (D5).
            const note = copyProgressNote(toPath, written);

            if (error instanceof HarnessError) throw new HarnessError(`${error.message}${note}`);

            // D10: the errno names the path the syscall touched (`error.path`), not the
            // destination the caller passed — an unreadable SOURCE directory used to be
            // reported as `EACCES on <destination>`.
            throw new HarnessError(
                `files copy failed on ${fromPath} -> ${toPath}: ${failureOf(error, failingPath(error, fromPath)).message}${note}`
            );
        }

        return { op, path: toPosixPath(fromPath), to: toPosixPath(toPath), kind, bytes };
    }

    try {
        await rename(fromPath, toPath);
    } catch (error) {
        // EXDEV (cross-device) and ENOTEMPTY (a non-empty directory target racing an
        // earlier op) are reported as-is: this tool never turns a rename into a
        // copy-plus-delete behind the caller's back. `error.path` names the side the
        // syscall reached for (D10); the message text already quotes both sides.
        throw new HarnessError(
            `files move failed on ${fromPath} -> ${toPath}: ${failureOf(error, failingPath(error, toPath)).message}`
        );
    }

    return {
        op,
        path: toPosixPath(fromPath),
        to: toPosixPath(toPath),
        kind,
        // A moved symlink reports its TARGET's size, from the `stat` above — not the
        // link's own `lstat` size (the length of its stored target string), and 0 for a
        // dangling link, whose target is gone. Documented in the header: the receipt
        // describes the payload reachable under the name that moved.
        bytes: kind === 'directory' ? 0 : sourceTarget?.size ?? 0
    };
};

// Copy ONE symlink as a symlink: the stored target string, verbatim, so the destination
// means exactly what the source meant (a dangling one stays dangling). It holds no
// payload, so it adds 0 bytes to the copy's total — stat'ing it would report its target's
// size, or throw outright when there is no target.
const copySymlinkEntry = async (fromPath: string, toPath: string, progress: CopyProgress): Promise<number> => {
    await symlink(await readlink(fromPath), toPath);
    progress.links += 1;

    return 0;
};

// Copy one file and report its size, in a single place so the receipt never lies.
// The size is read back from the DESTINATION (see ./sizeOfCopiedFile), and counted into
// `progress` so a later failure can name what this copy already wrote.
const copyFileWithSize = async (fromPath: string, toPath: string, progress: CopyProgress): Promise<number> => {
    await copyFile(fromPath, toPath);

    const bytes = await sizeOfCopiedFile(toPath);

    progress.files += 1;
    progress.bytes += bytes;

    return bytes;
};

// Authoritative registration/details for this preset (T13). ../catalogue projects
// the same data synchronously through the discovered descriptors, and the
// consistency test asserts the two stay equal. Edit the metadata HERE.
export const FILES_METADATA: PresetToolMetadata = {
    name: 'files',
    description:
        'Manage files and folders: list, move, copy, delete, and mkdir in ONE call, applied in the order given. Pass an array of operations, each `{ op, ... }`: list takes `path` (one directory or several, default the working directory) plus `offset`/`limit`; move and copy take `from` and `to` plus `overwrite` (default false, so an existing destination is an EEXIST error, not a silent replace; a destination that is the source, inside it, or an ancestor of it is refused before anything moves, and a copy stops at a depth of 64 directory levels); delete takes `path` plus `recursive` (a non-empty directory without it is refused; for a symlink it removes the link only, never the target or its contents) and `force` (a missing path becomes `removed: false, skipped: true` instead of an error); mkdir takes `path` and creates missing parents, reporting an existing directory as `created: false`. Returns `{ results, bytes, contentBudget }` with ONE ordered receipt per op: list gives `{ entries, truncated, nextOffset, offset, limit, bytes }` (a page holds at most 200 entries by default, 1000 maximum, larger values being clamped rather than rejected, and the entry text of the WHOLE call shares one 64 KiB budget, so pass `nextOffset` back as that entry\'s `offset` for more), move/copy give `{ path, to, kind, bytes }`, delete gives `{ path, removed, recursive }`, and mkdir gives `{ path, created }`. Entry names are prefixed with the directory they came from, directories end with "/", and listings are sorted by code point, so paging is deterministic. Every entry is validated before anything runs, so a malformed call changes nothing; a failing mutation names the ops already applied and there is NO rollback, while a failing list entry reports its own `error: { code, message }` without failing the batch. Cross-device moves report EXDEV rather than copying behind your back. Use read/write/edit for content and glob/grep for searching.',
    tags: [
        'files',
        'list',
        'filesystem',
        'folder',
        'directory',
        'move',
        'rename',
        'copy',
        'delete',
        'remove',
        'mkdir'
    ],
    parameters: {
        type: 'object',
        properties: {
            ops: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        op: {
                            type: 'string',
                            enum: ['list', 'move', 'copy', 'delete', 'mkdir'],
                            description:
                                'The operation this entry performs. Required, and it decides which other fields are allowed.'
                        },
                        path: {
                            oneOf: [
                                { type: 'string' },
                                { type: 'array', items: { type: 'string' } }
                            ],
                            description:
                                'list: one directory or several, paged as one flat sequence (default the working directory). delete/mkdir: the one path. Absolute or relative to the working directory.'
                        },
                        from: {
                            type: 'string',
                            description: 'move/copy: the existing path to move or copy.'
                        },
                        to: {
                            type: 'string',
                            description:
                                'move/copy: the destination. Parent directories are created. Existing destinations need overwrite: true.'
                        },
                        overwrite: {
                            type: 'boolean',
                            description:
                                'move/copy: replace an existing destination (recursively, when it is a directory) instead of failing on it. Defaults to false.'
                        },
                        recursive: {
                            type: 'boolean',
                            description:
                                'delete: allow removing a real directory that is not empty, together with everything under it. For a symlink it removes the LINK only — the directory it points at and its contents always stay. Defaults to false.'
                        },
                        force: {
                            type: 'boolean',
                            description:
                                'delete: treat a missing path as done (removed: false, skipped: true) instead of an error. Defaults to false.'
                        },
                        offset: {
                            type: 'integer',
                            // NO `minimum` on purpose: a bound HERE would be enforced
                            // before `execute` (../../core/schema-validation.ts) and the
                            // runtime clamp in ./prepareOperation would never run. The
                            // clamp owns this field, so the promise ("never rejected")
                            // holds on a harness call as well as a direct one.
                            description:
                                'list: 0-based index into the flat entry list. Defaults to 0; pass the previous nextOffset here. A negative value is clamped to 0.'
                        },
                        limit: {
                            type: 'integer',
                            // As above, no `minimum`/`maximum`: 0 or 5000 is a clamp, not
                            // a rejection, and the schema must not reject what the tool
                            // promises to accept.
                            description:
                                'list: maximum entries in this page. Defaults to 200; values above 1000 are clamped to 1000 and values below 1 to 1, so an oversized page is never rejected.'
                        }
                    },
                    required: ['op'],
                    additionalProperties: false
                },
                maxItems: FILES_MAX_OPS,
                description:
                    'Operations to perform, in the order they are applied and the order the receipts come back. A later entry sees what an earlier one did, so a rename followed by a delete works; at most 100 per call.'
            }
        },
        required: ['ops'],
        additionalProperties: false
    }
};
// Canonical discovery export (T19 / R9): a same-file alias of the literal above, so
// the constant stays the single place this metadata is authored.
export const metadata = FILES_METADATA;

// Harness registration policy (T19 / R9). Bookkeeping, not part of the Tool wire
// contract. `order: 200` keeps ./fileList's catalogue slot, so descriptor order
// (and every derived "core first, then searchable" projection) is unchanged.
export const registration = {
    group: 'preset',
    activation: 'always',
    order: 200,
    sessionBound: false,
    alwaysDeclared: false,
    listed: false
} as const;

export const files = tool<FilesParameters, FilesResult>({
    ...FILES_METADATA,
    execute: async ({ parameters }) => {
        const prepared = await prepareOperations(parameters);

        // D4 (./lock.ts): the harness launches every tool call of one assistant
        // message CONCURRENTLY, so a `files` mutation and a `write`/`edit` on the same
        // path can overlap. Hold the same per-file locks ./write and ./edit take —
        // by real identity, so a Windows case alias shares the key — across the whole
        // batch. A list op reads and needs none.
        const identities: string[] = [];

        for (const operation of prepared) {
            if (operation.op === 'list') continue;

            identities.push(await fileIdentity(operation.path));

            if (operation.to !== undefined) {
                identities.push(await fileIdentity(operation.to));
            }
        }

        return withFileLocks(identities, async () => {
            const results: FilesOperationResult[] = [];
            let bytes = 0;

            // ONE allowance for the WHOLE call, handed to every list op in order and
            // decremented as each page fills (see LIST PAGING). A per-op budget let N list
            // ops charge N x 64 KiB while the envelope still printed `contentBudget: 65536`
            // beside a larger `bytes`, which is the promise the description does not make.
            const budget = { remaining: FILES_CONTENT_BUDGET };

            for (const operation of prepared) {
                if (operation.op === 'list') {
                    const listed = await runList(operation, budget);

                    bytes += listed.bytes ?? 0;
                    results.push(listed);
                    continue;
                }

                try {
                    results.push(await runMutation(operation));
                } catch (error) {
                    // Partial success is reported the way ./write reports it: name what
                    // already happened, and claim no rollback that does not exist.
                    const applied =
                        results.length === 0
                            ? 'none'
                            : results.map((entry) => `${entry.op} ${entry.path ?? ''}`.trim()).join(', ');

                    const reason = error instanceof Error ? error.message : String(error);

                    throw new HarnessError(
                        `files failed on ${operation.op} ${operation.path}: ${reason} Operations already applied: ${applied}. No rollback was performed.`
                    );
                }
            }

            return { results, bytes, contentBudget: FILES_CONTENT_BUDGET };
        });
    }
});
