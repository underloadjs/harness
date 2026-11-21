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
//     { op, path | from+to, overwrite?, replaceDirectory?, recursive?, force?, offset?, limit? }
//
//   - list   : `path` (string OR string[]; default the working directory ".") +
//              optional `offset`/`limit`.
//   - move   : `from` + `to`, `overwrite` (default false), `replaceDirectory` (default
//              false — see DESTINATION POLICY; only `move` and `copy` accept it).
//   - copy   : `from` + `to`, `overwrite` (default false), `replaceDirectory` (default
//              false, same rule).
//   - delete : `path`, `recursive` (default false), `force` (default false).
//   - mkdir  : `path`. Missing parents are created. An existing directory is a
//              no-op success ("the state you asked for already holds").
//
// A field that belongs to another op is REJECTED, naming the op: the JSON Schema
// vocabulary this harness enforces has no `if`/`then` (../../core/schema-validation.ts),
// so cross-field rules are implementation-checked during preflight, and a rejected
// call touches nothing. The schema's `additionalProperties: false` property list, the
// per-op `OP_FIELDS` table and the parsing in ./prepareOperation are ONE promise written
// three times: every operation field has to appear in all three in the same change, or a
// model sends a field the runtime refuses (`replaceDirectory` was exactly that defect while
// the guard lived only in the schema) or the runtime quietly accepts one the model was
// never told about.
//
// RESULT SHAPE (one shape for every op)
// -------------------------------------
//     { results: [...ordered receipts...], bytes, contentBudget }
//
// One receipt per op, in the caller's order:
//
//     list    { op, path, entries, truncated, nextOffset, offset, limit, bytes,
//              starved?, note?, error? }
//     move    { op, path, to, kind, bytes, replaced? }
//     copy    { op, path, to, kind, bytes, replaced? }
//     delete  { op, path, removed, recursive, skipped? }
//     mkdir   { op, path, created }
//
// A receipt's `path`/`to` follow ./fileList's presentation rule rather than inventing
// one: a LIST reports the caller's own directory spelling and prefixes each entry with
// it (`.` contributes no prefix, so a default list returns bare names; `src` returns
// `src/a.ts`), while move/copy/delete/mkdir report ABSOLUTE posix paths — the same
// separator style as the listed names, so one response never mixes two. (./write and
// ./read report native absolute paths.)
//
// `kind` is 'file', 'directory', or 'symlink' — WHAT IS STANDING AT THE DESTINATION AFTER
// THE OPERATION, which is the only question a caller can act on:
//
//   - a MOVE of a symlink reports 'symlink' and 0 bytes, because `rename` never follows a
//     link: whatever the source name was (file, directory, live link, dangling link), the
//     destination name now holds a LINK, and a rename writes no payload. It used to report
//     'file' plus the size of the link's TARGET, which described the source's target rather
//     than the entry that moved;
//   - a COPY of a live link dereferences (that is what `copyFile`/the walk does), so the
//     destination holds a real file or a real directory tree and reports 'file'/'directory'
//     with the bytes written there; a copy of a DANGLING link writes a link and reports
//     'symlink' with 0 bytes;
//   - `bytes` is the payload the operation moved or wrote: a file's size, the sum of a
//     walked directory, and 0 for a directory MOVE (a rename writes no bytes) and for a
//     'symlink' receipt (a link holds no payload, and stat'ing one would report its
//     target's size — or throw outright for a dangling one). A COPY measures the DESTINATION
//     it just wrote, because that is the payload the receipt claims exists now — re-statting
//     the source would report what was intended, not what landed — and a destination that
//     cannot be measured fails the call instead of reporting 0.
//
// `replaced` is present only when `overwrite` (plus `replaceDirectory`, for a directory)
// removed an existing destination to make room, and it is the receipt's account of what was
// destroyed: `{ path, kind, entries }`, where `entries` counts the IMMEDIATE entries of a
// replaced directory — the top level of the tree that went with it — or null when that
// listing itself failed, so "unknown" is never read as "empty" (a file or a symlink
// replacement costs no tree and reports 0).
//
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
//     points at the entry that did not fit, never one that silently advances past it.
//     That empty page is ALSO marked, because `entries: []` beside `truncated: true`
//     alone reads like a listing rather than like a call that never got its turn:
//     `starved: true` says an EARLIER list op of this call charged the whole budget, and
//     `note` names that op (its path, offset and charge) plus how to get a real answer —
//     the budget stays call-wide ON PURPOSE (it is the published contract, and per-op
//     budgets let N list ops charge N x 64 KiB), so the fix is visibility, not a new cap;
//   - `truncated` is true when entries exist beyond this page and `nextOffset`
//     locates them; pass it back as that entry's `offset`. An entry whose own
//     UTF-8 size exceeds the whole budget can never be paged, so the call is
//     refused with a message naming it rather than returning a cursor that never
//     advances.
//   - `note` is the "why is this page short/empty" field, present in exactly three
//     situations (all of them previously silent):
//       1. a budget cut — the page stopped at an entry that no longer fits, and the
//          sequence is code-point SORTED, so one long name can strand usable budget
//          behind it: the note quotes that name, its size, and what was left. Paging
//          itself is unchanged (resuming in a NEW call is the remedy);
//       2. `starved: true` (the bullet above) — the note names the earlier op;
//       3. an `offset` at or past the end of the sequence — indistinguishable from an
//          exhausted listing before, so the note says plainly that the listing has N
//          entries and the empty page means "end of sequence", not a failure. It stays
//          a successful page, never an error.
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
//     invisible to the caller that has to clean it up. A failed MOVE says the matching
//     half: when `overwrite` had ALREADY removed the destination and the `rename` then
//     failed, the message names the removed entry (and its entry count) and states that
//     the source is still where it was, because "applied: none" otherwise reads as
//     "nothing happened" over a destination that no longer exists.
//     The rejection carries a machine `code` and structured `details` (the applied-ops
//     list lives there); the prose keeps the same shape it always had.
//   - a CANCELLED call — the harness's per-call `context.signal`, src/types/index.ts:2349-2356
//     — is refused the same way and with the same honesty: the signal is checked before the
//     batch and again before EVERY op, so the ops that had not started never start and the
//     rejection names the receipts the call already applied. Its `code` is `ECANCELED`, a
//     member of FILES_ERROR_CODES below, and it is never folded onto `EIO`: `EIO` is the
//     transient code a retry loop is built on, and a cancellation is permanent. The mapping
//     is shared with `read`/`write`/`edit` in ./cancellation.ts so the four cannot disagree.
//   - a failing LIST op is a per-entry `error: { code, rawCode?, message }` (ENOENT,
//     ENOTDIR, EACCES/EPERM, EIO, EXDEV), exactly like `read`, because a read-only entry
//     in a mixed batch must not throw away mutations that already succeeded. THAT set
//     (FILES_ERROR_CODES, exported so a caller can type the switch) is closed and it is
//     what `code` publishes: `filesFailureOf` folds every other raw Node errno
//     (ENAMETOOLONG, ELOOP, ERR_FS_EISDIR, ENOTEMPTY, …) onto EIO, because a caller
//     switches on `code` and cannot switch on a set the tool never promises. The true
//     errno is NOT hidden in prose any more — it is the separate `rawCode` field, present
//     whenever it differs from `code` — and `message` is one verb plus one actionable
//     remedy: Node's own message repeats the errno AND the path (`ENOENT: no such file
//     or directory, scandir '/abs'`), so the errno token and the quoted location are
//     STRIPPED and the path is named exactly once, next to the code. The old shape read
//     `EIO on /abs: ERR_FS_EISDIR: EISDIR: illegal operation on a directory, read` —
//     three codes, two paths, no instruction.
//
// DESTINATION POLICY (no platform luck)
// -------------------------------------
// `fs.rename` is atomic on one device, replaces a file silently on POSIX and fails
// on Windows, and fails on a NON-EMPTY directory everywhere. This tool removes the
// luck: without `overwrite`, an existing destination is an EEXIST error before any
// byte moves; with `overwrite`, the destination is removed first (recursively, for a
// directory) and then replaced. A cross-device move reports EXDEV as-is — the tool
// never silently turns a rename into a copy-plus-delete — and the message says what to
// do about it (`copy`, then `delete`), because an errno alone is not an instruction.
//
// A DIRECTORY DESTINATION NEEDS ITS OWN PERMISSION (`replaceDirectory`, `move`/`copy`
// only). `overwrite` says "the name at `to` may go"; it does NOT say "the TREE at `to`
// may go", and removing a directory removes everything under it. Measured before this
// rule: `move file.txt -> some-dir` with `overwrite: true` answered `{ kind: "file",
// bytes: 4 }` while `some-dir` and its whole contents had been deleted, and the same
// happened dir-onto-non-empty-dir. So now:
//
//   - source is NOT a directory, destination IS an existing directory → refused with or
//     without `overwrite`, unless `replaceDirectory: true`;
//   - source IS a directory and the destination directory is NOT EMPTY → refused the same
//     way, `replaceDirectory: true` required. An EMPTY destination directory with a
//     directory source destroys nothing, so `overwrite` alone is enough there;
//   - the refusal counts what would be destroyed and names it ("holds 7 entries"), and
//     suggests the answer the caller usually means: pass a path INSIDE the directory.
//     `entries` is the number of IMMEDIATE entries; a directory that cannot be listed is
//     treated as non-empty (the safe side) and says so instead of claiming 0;
//   - whatever was removed is reported in the receipt as `replaced: { path, kind,
//     entries }`, so the caller can see the tree it paid for after the fact;
//   - a destination that is a SYMLINK (live or dangling) is not a tree: replacing it
//     costs the link alone, exactly like `delete` on a link, so no extra permission is
//     asked for. `entries` reports 0 and `kind` reports 'symlink'.
//
// The destination is examined with `lstat` FIRST for the same reason `delete` and the
// SOURCE check are (see below): `stat` follows a symlink, so a DANGLING link destination
// read as "missing", which let a `move` replace a name that was taken without asking, and
// let a `copy` follow the link and CREATE its missing target instead of writing the
// destination the caller named.
//
// SELF AND CONTAINMENT IS REFUSED BEFORE A BYTE MOVES (both `copy` and `move`,
// whatever `overwrite` says). A destination that IS the source, that lies INSIDE it,
// or that CONTAINS it (when it exists), is a refusal naming both paths, because each
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
//   - `move/copy from tree/sub to tree` with an EXISTING destination is the mirror
//     image, and it is the one that COSTS DATA: the destination removal is
//     `rm -rf`, so it deletes the directory that HOLDS the source — all of `tree` went
//     with `tree/a.txt` and `tree/deep/…`, the syscall then failed with ENOENT, and the
//     caller was told "Operations already applied: none" about a tree it no longer owns.
//     `mv` refuses this shape without deleting anything, and so does this tool. The same
//     call with the destination ABSENT is a plain rename that CREATES `tree`, so the
//     refusal is asked where the destination is known to EXIST, not in the path
//     comparison alone — and it is asked BEFORE the "already exists, pass overwrite:
//     true" hint, because that hint used to be the answer for this shape: `move t/sub ->
//     t` without `overwrite` was told to pass a flag whose only effect is to reach a
//     DIFFERENT refusal two lines later. Ordering is containment verdicts first, then
//     exists/`overwrite`, then the `replaceDirectory` gate; every one of them happens
//     before the first `mkdir` or `rm`.
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
// SYMLINKS ARE DELIBERATELY INCONSISTENT PER VERB, AND THE RECEIPT SAYS WHAT HAPPENED.
// The per-operation rule (each one is the cheapest thing that cannot destroy data):
//
//   - `move` renames, and `rename` never follows a link, so a moved link STAYS a link
//     (live or dangling) and its target is never touched;
//   - top-level `copy` DEREFERENCES a live link (that is what `copyFile` and the tree walk
//     do — the payload under the name is what a caller copying a link-to-a-file wants) but
//     PRESERVES a dangling one, whose target is gone and therefore cannot be dereferenced
//     at all — the link is written with its stored target string, verbatim;
//   - a link INSIDE a copied tree is always preserved as a link (`readlink` → `symlink`),
//     which is what keeps the walk from following itself (see above);
//   - `delete` removes the LINK only, never the target or anything under it (`recursive`
//     included), and a dangling link is still a real, deletable entry;
//   - `list` reports a link that resolves to a directory with the walkable "/", and a
//     dangling or looping link as a plain name.
//
// So `kind` (see RESULT SHAPE) reports what stands at the destination afterwards —
// 'symlink' for a moved link and for a copied dangling one, 'file'/'directory' when the
// verb dereferenced — with `bytes: 0` for every 'symlink' receipt, because a link holds no
// payload. The receipt used to claim `kind: "file"` plus the TARGET's size for a moved
// link, which described a file the destination is not.
//
// WHAT `delete` REFUSES
// ---------------------
// A NON-EMPTY directory without `recursive` is an ENOTEMPTY error: `files` never
// deletes a tree the caller did not say it meant. An EMPTY directory needs no such
// permission — that IS what the caller asked for — so it is removed. Node's bare
// `rm`/`rmdir` pair cannot be used blindly here (`rm` answers ERR_FS_EISDIR for a
// directory of either shape, `rmdir` refuses a symlink-to-directory), so the verified
// empty case is split by what the path IS: `rmdir` for a real directory, `unlink` for a
// symlink. It used to go through `rm` with `recursive: true`, which was a harmless way to
// reach both shapes — until the emptiness check and the removal stopped being one
// atomic act: anything written into the directory between the `readdir` and the `rm` was
// deleted although the caller never asked for `recursive`. `rmdir` closes that window as
// far as it can be closed: a directory that gained an entry mid-flight answers ENOTEMPTY,
// which is the honest refusal, instead of a silent tree deletion.
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
// The same `lstat`-first reading of a path is what `copy`/`move` apply to their SOURCE and
// to their DESTINATION, and what `mkdir` now applies to the name it is asked to create: a
// dangling symlink is a real entry, so it can be moved (a rename never follows it) and
// copied as a link with its stored target string instead of being reported as a path that
// "does not exist"; a DESTINATION that is a dangling link OCCUPIES the name (so `overwrite`
// is what replaces it, and a copy does not quietly create the link's missing target); and a
// `mkdir` onto one is refused with the link and its dead target named, instead of the
// opaque `EIO … EEXIST` a followed `stat` used to produce.
//
// No sandbox: every path is resolved against the process working directory and used
// as given, exactly like the rest of ./index.ts. There is no confirmation layer
// here; a host that wants a fence wraps `execute` (or filters this tool out by
// name, which is why the destructive ops and `list` sharing one tool is a decision
// recorded in the README rather than a surprise). A MUTATION does hold the same
// per-file lock ./write and ./edit take (./lock.ts): the harness launches one
// message's calls concurrently, so a `files` move and a `write` to the SAME PATH
// serialize instead of racing, and the lock set is released when the batch ends. THAT
// promise covers the NAMED paths and nothing wider — the lock keys are the resolved
// `path`/`from`/`to` of each entry, while `delete` with `recursive` and a directory
// `copy` touch whole subtrees that are NOT individually locked. A `write` into a
// directory that a concurrent `files` call is copying, moving, or deleting recursively is
// therefore NOT serialized against it; only the entry points the call names are.
//
// Executable on its own and registerable on a harness:
//
//     await files([{ op: 'mkdir', path: 'src/nested' }]);
//
// Metadata (name, description, tags, schema) is declared below and is authoritative
// for T13. ../catalogue.ts projects the same data synchronously through the
// discovered descriptors, and a consistency test proves the two are equal.

import { copyFile, lstat, mkdir, readdir, readlink, rename, rmdir, rm, stat, symlink, unlink } from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';
import { fileCancelledError, throwIfFileCancelled } from './cancellation';
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
    // move/copy: allow replacing a destination that is a DIRECTORY, whose whole tree goes
    // with it. `overwrite` alone covers a file or a symlink at that name; a directory needs
    // this too, unless it is empty and the source is a directory (C1).
    replaceDirectory?: boolean;
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

// The CLOSED set this tool publishes (see FAILURE SEMANTICS in the header). It is exported,
// like every other bound here, so a caller can TYPE the switch it does on
// `error.code` instead of comparing against names it has to guess (EXTRA-3: the list used to
// be module-private while the numbers beside it were published). `code` is ALWAYS a member
// of this set, and an errno outside it folds onto EIO with the true name in `rawCode`.
//
// EXDEV belongs IN the set (H1): a cross-device `rename` is a routine, expected answer —
// this tool deliberately refuses to turn a move into a copy behind the caller's back — and
// folding it onto EIO made "different devices" indistinguishable from "the disk faulted",
// which is the one case a caller can actually act on.
//
// ECANCELED belongs IN the set for the same reason, with one difference a caller has to
// know: it is a CALL-level code, never a `list` receipt's. Cancellation is not a fact about
// one directory — it is the caller letting go of the whole call — so it rejects the batch
// (with the applied-ops list in `details`), while a per-entry filesystem miss stays per-entry
// exactly as before. It is enumerated here because a caller that switches on `code` must be
// able to name it (./cancellation.ts).
export type FilesErrorCode = 'ENOENT' | 'ENOTDIR' | 'EACCES' | 'EPERM' | 'ECANCELED' | 'EIO' | 'EXDEV';

export const FILES_ERROR_CODES: readonly FilesErrorCode[] = [
    'ENOENT',
    'ENOTDIR',
    'EACCES',
    'EPERM',
    'ECANCELED',
    'EIO',
    'EXDEV'
];

// The per-entry/list failure object (M10): `code` for the switch, `rawCode` for the truth
// (present only when it differs from `code`, since duplicating a published code tells
// nothing), and a `message` that states the location ONCE and ends with what to do.
export type FilesOperationError = { code: FilesErrorCode; rawCode?: string; message: string };

// What an `overwrite` (plus `replaceDirectory`, for a directory) removal DESTROYED, so the
// caller can see the price it paid after the fact instead of discovering it by listing.
// `entries` counts the IMMEDIATE entries of a replaced directory, or null when that listing
// failed — "unknown" must never read as "empty". A file or a symlink holds no tree, so it
// reports 0.
export type FilesReplacedEntry = {
    path: string;
    kind: 'file' | 'directory' | 'symlink';
    entries: number | null;
};

// One completed (or individually failed) operation, in request order.
export type FilesOperationResult = {
    op: FilesOperationKind;
    // Absolute resolved path (list reports the FIRST requested path, since a list
    // entry may name several directories).
    path?: string;
    // move/copy: absolute resolved destination.
    to?: string;
    // move/copy: what stands at the destination NOW: 'directory' for a tree, 'file' for a
    // file, and 'symlink' when the entry that moved or was written IS a link (every move of
    // a link, and a copy of a dangling one — see SYMLINKS ARE DELIBERATELY INCONSISTENT PER
    // VERB in the header).
    kind?: 'file' | 'directory' | 'symlink';
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
    // renamed one and for a 'symlink' receipt, which holds no payload). list: UTF-8 bytes
    // of this page's entry text.
    bytes?: number;
    // move/copy ONLY, and only when an existing destination was removed to make room:
    // exactly what that removal cost (see ./FilesReplacedEntry).
    replaced?: FilesReplacedEntry;
    // list ONLY: this op could not emit a single entry because an EARLIER list op of the
    // same call had already charged the whole FILES_CONTENT_BUDGET (M2). The call-wide
    // budget is the published contract, so the fix is this marker plus `note`, not a
    // per-op allowance; `truncated: true` beside a non-advancing `nextOffset` was the only
    // (weak) hint before.
    starved?: true;
    // list ONLY: why this page is short or empty when an empty page could mean several
    // different things — a budget cut that one long name caused, a starvation this call
    // caused, or an `offset` at or past the end of the sequence. Absent for a normal page.
    note?: string;
    // list only: a read-only failure is reported here and never fails the call.
    error?: FilesOperationError;
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
    // `replaceDirectory` is a move/copy permission and nothing else: `delete` already has
    // `recursive` for a tree, and `mkdir` never removes anything. Keep this table and the
    // published schema in lockstep (see the schema/validator note in the header).
    move: ['from', 'to', 'overwrite', 'replaceDirectory'],
    copy: ['from', 'to', 'overwrite', 'replaceDirectory'],
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
    // move/copy only: the extra permission a DIRECTORY destination needs (C1).
    replaceDirectory: boolean;
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
    let replaceDirectory = false;
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

    // Parsed here, not only declared in the schema: `additionalProperties: false` is what
    // a HARNESS enforces, and the runtime table above is what a direct call enforces, so a
    // field that is missing from one of the three is a promise the tool cannot keep.
    if (record.replaceDirectory !== undefined) {
        if (typeof record.replaceDirectory !== 'boolean') {
            throw new HarnessError(`files ${kind} "replaceDirectory" must be a boolean.`);
        }

        replaceDirectory = record.replaceDirectory;
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
        replaceDirectory,
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

// The path the FAILING syscall actually named (D10). Node puts it on `error.path` — the
// same string its message quotes (`scandir '<dir>'`) — so a failure deep inside a walked
// tree names the entry that broke instead of whatever path the CALLER happened to pass.
// The measured wrong shape: a copy aborted by `scandir` on `<root>/t/deep` was reported
// as `EACCES on <root>/t2`, pointing at the half-built destination while the source was
// the unreadable side. `fallback` keeps the message complete for a hand-thrown Error,
// which carries no `path`.
const failingPath = (error: unknown, fallback = ''): string =>
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { path?: unknown }).path === 'string' &&
    (error as { path: string }).path.length > 0
        ? (error as { path: string }).path
        : fallback;

// The errno name a thrown value carries, or '' for a hand-thrown Error (which has none —
// that is what the empty string MEANS here, and the renderers below branch on it).
const rawCodeOf = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';

// The machine code a caller switches on: a published name, always. Everything the kernel
// answers that this tool never promised (ENAMETOOLONG, ELOOP, ERR_FS_EISDIR, ENOTEMPTY,
// EEXIST, …) folds onto EIO — but the true errno is now a FIELD (`rawCode`), not something
// the reader has to fish out of the prose (M10).
const publishedCode = (raw: string): FilesErrorCode =>
    (FILES_ERROR_CODES as readonly string[]).includes(raw) ? (raw as FilesErrorCode) : 'EIO';

// Node's own message, reduced to the reason ALONE. Measured shapes (./Temp/orch/files
// probe against this Node):
//
//     ENOENT: no such file or directory, scandir '/abs'
//     EISDIR: illegal operation on a directory, rename '/a' -> '/b'
//     Path is a directory: rm returned EISDIR (is a directory) /abs      (ERR_FS_EISDIR)
//
// Every one of them states the errno and the location that `code` and `rawCode` already
// carry, so the composed sentence used to read `EIO on /abs: ERR_FS_EISDIR: EISDIR: illegal
// operation on a directory, read` — three codes, two paths, no instruction (M11/M10
// complaint). Stripping is exact rather than a rewrite: the leading errno token, the quoted
// `syscall '<path>'` tail (both the one-path and the rename two-path form), and the
// unquoted trailing location of the ERR_* form. The syscall NAME survives in parentheses,
// because "scandir" vs "open" is information the caller cannot get anywhere else.
const reasonOf = (error: unknown, raw: string): string => {
    let reason = error instanceof Error ? error.message : String(error);

    if (raw !== '' && reason.startsWith(`${raw}: `)) reason = reason.slice(raw.length + 2);

    // The bare errno Node wrapped inside an ERR_* code (only when the token really is an
    // errno name — `Path is a directory:` has spaces and must survive).
    reason = reason.replace(/^[A-Z][A-Z0-9_]+: /, '');

    const location = failingPath(error);

    // The closing quote of the SECOND path is part of the tail: Node writes the rename and
    // copyfile forms as `, rename '<from>' -> '<to>'` (measured — `probe-exdev` against this
    // Node, and `files.test.ts` "names EXDEV…" only exercises it when the two fixture roots
    // really are on different devices). An unterminated ` -> '<to>` here silently fails the
    // anchored match, the whole clause survives, and the sentence restates both paths a second
    // time — the exact duplication M10 removed everywhere else.
    reason = reason.replace(/, ([a-z][a-z0-9]*) '(?:[^']*)'(?: -> '(?:[^']*)')?$/, (_all, syscall: string) => ` (${syscall})`);

    // The `… (is a directory) /abs` form: the location is the last thing Node wrote, and it
    // is exactly `error.path`, so the comparison is exact rather than a guess at a pattern.
    if (location !== '' && reason.endsWith(location)) {
        reason = reason.slice(0, reason.length - location.length).trimEnd();
    }

    return reason.length === 0 ? 'the filesystem refused the call' : reason;
};

// The three parts every failure sentence is built from.
const failureParts = (error: unknown): { code: FilesErrorCode; rawCode?: string; prose: string } => {
    const raw = rawCodeOf(error);
    const code = publishedCode(raw);

    return {
        code,
        // Only when it differs: `code: 'ENOENT', rawCode: 'ENOENT'` is noise, while
        // `code: 'EIO', rawCode: 'ENAMETOOLONG'` is the whole point.
        ...(raw === '' || raw === code ? {} : { rawCode: raw }),
        prose: reasonOf(error, raw)
    };
};

// How the code half of a failure sentence is written: the published code a caller switches
// on FIRST (so `EACCES on <path>:` keeps matching), and — only when the raw errno was folded
// away from it — the true errno right behind it in parentheses. M10 asked for the raw name to
// stay in the MESSAGE and not only in `details.rawCode`, because the prose is what a model
// reads and a folded `EIO` hides the difference between "name too long", "too many links" and
// "directory not empty" — three different remedies behind one published code.
const failureCodeLabel = (code: FilesErrorCode, rawCode?: string): string =>
    rawCode === undefined ? code : `${code} (${rawCode})`;

// The self-contained form, for a receipt that has no other place to say WHERE it failed:
// `<CODE>[(<raw>)] on <path>: <reason>. <remedy>`.
export const filesFailureOf = (error: unknown, path: string, remedy?: string): FilesOperationError => {
    const { code, rawCode, prose } = failureParts(error);

    return {
        code,
        ...(rawCode === undefined ? {} : { rawCode }),
        message: `${failureCodeLabel(code, rawCode)} on ${path}: ${prose}.${
            remedy === undefined || remedy.length === 0 ? '' : ` ${remedy}`
        }`
    };
};

// The location-free form, for a throw site that already quotes the path(s) it failed
// between. Without it those sites read `files delete failed on X: EIO on X: …`, naming the
// code and the path twice (M10).
const filesFailureLine = (error: unknown, remedy?: string): string => {
    const { code, rawCode, prose } = failureParts(error);

    return `${failureCodeLabel(code, rawCode)}: ${prose}.${remedy === undefined || remedy.length === 0 ? '' : ` ${remedy}`}`;
};

// The one remedy a LIST entry can offer, chosen by the code it answers with: an errno alone
// is not an instruction, and every one of these has a next call the caller can make.
const listRemedy = (code: FilesErrorCode): string =>
    code === 'ENOENT'
        ? 'List the folder that contains it to check the spelling before assuming the path is right.'
        : code === 'ENOTDIR'
          ? 'That path is a file, not a directory; list the folder that contains it instead.'
          : code === 'EACCES' || code === 'EPERM'
            ? 'The process may not read that directory; check its mode, or list a folder above it.'
            : code === 'EXDEV'
              ? 'The paths are on different devices; use { "op": "copy" } and then { "op": "delete" }.'
              : 'The raw errno is in rawCode; list a folder above this one to see whether the whole subtree is unreadable.';

// A LIST failure, with the remedy its code implies (the only place this tool can offer one
// without throwing away the rest of the call's answer).
const listFailure = (error: unknown, path: string): FilesOperationError => {
    const { code } = failureParts(error);

    return filesFailureOf(error, path, listRemedy(code));
};

// Stable machine codes for the REFUSALS this tool throws, following the `code` + `details`
// convention of ../../util/errors.ts ("a host that catches it can classify without parsing
// prose"). The prose stays the human half and keeps the shape it always had; the code is the
// part a host switches on, and it is what ./execute re-raises with when the op fails (M11).
// They are exported so a caller can name them instead of quoting literals out of a message.
export const FILES_REFUSAL_CODES = {
    sourceMissing: 'files-source-missing',
    sourceIsDestination: 'files-source-is-destination',
    destinationInsideSource: 'files-destination-inside-source',
    destinationContainsSource: 'files-destination-contains-source',
    destinationExists: 'files-destination-exists',
    destinationDirectory: 'files-destination-directory',
    deleteMissing: 'files-delete-missing',
    deleteNonEmpty: 'files-delete-non-empty',
    mkdirNotDirectory: 'files-mkdir-not-a-directory',
    mkdirDanglingLink: 'files-mkdir-dangling-link',
    // The batch-level rejection: some ops applied, this one did not, and nothing was undone.
    operationFailed: 'files-operation-failed'
} as const;

// The `mkdir` remedy that follows from the errno. An EACCES and an ENOENT here need
// opposite answers, and neither is in Node's message.
const mkdirRemedy = (code: FilesErrorCode): string =>
    code === 'ENOENT'
        ? 'A folder along that path is missing or is not a directory, so this one cannot be created; check the spellings above the name you passed.'
        : code === 'EACCES' || code === 'EPERM'
          ? 'The process may not write in the parent folder; create the path somewhere it owns.'
          : code === 'ENOTDIR'
            ? 'A component of that path is a file, not a folder; the directory cannot be created inside it.'
            : '';

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

// L1: "they are still there" said a partial tree existed without saying WHERE it starts or
// what stands in it, and the depth refusal left a 64-level chain nobody named. This appends
// the destination root's own immediate entries (bounded, so a wide tree cannot bloat the
// message) and says plainly that the remainder is PARTIAL and stays there, because there is
// no rollback to remove it. One `readdir` on the FAILURE path only — the success path pays
// nothing — and a destination that cannot be listed reports that instead of pretending to be
// an empty partial tree.
const copyRemainderNote = async (to: string, progress: CopyProgress): Promise<string> => {
    const destination = toPosixPath(to);

    // Zero progress: ./copyProgressNote already states "Nothing had been written into …",
    // so there is nothing to add and no destination to name.
    if (progress.directories === 0 && progress.files === 0 && progress.links === 0) {
        return '';
    }

    let names: string[];

    try {
        names = (await readdir(to)).sort(compareNames);
    } catch {
        return ` The partial copy remains at "${destination}", which could not be listed — treat everything under it as partial.`;
    }

    if (names.length === 0) {
        return ` The partial copy remains at "${destination}" as empty directories only.`;
    }

    const shown = names.slice(0, 12);
    const rest = names.length - shown.length;

    return ` The partial copy remains at "${destination}"; its top-level entries are ${shown.join(', ')}${rest > 0 ? `, plus ${rest} more` : ''}.`;
};

// EXTRA-1: `overwrite` removes the destination BEFORE the syscall that replaces it, and that
// syscall can still fail (EXDEV across devices, EISDIR, EINVAL, a device that blinked). When
// it does, "Operations already applied: none" (added by ./execute) is about the OTHER entries
// of the call — the destination this call destroyed is not one of them, so the caller reads
// "none" and believes nothing happened while the name it owned is gone. ./copyProgressNote
// does the same job for a half-written copy; this does it for the removed entry. The source
// is named too, because the question a caller asks here is "what do I still have?", and for a
// MOVE the answer is the whole of it: the source is intact, the destination is not.
const replacementNote = (op: 'move' | 'copy', to: string, from: string, replaced?: FilesReplacedEntry): string =>
    replaced === undefined
        ? ''
        : ` The existing destination "${replaced.path}" (${replaced.kind}${
              replaced.entries === null
                  ? ', its contents could not be listed'
                  : `, ${replaced.entries} ${replaced.entries === 1 ? 'entry' : 'entries'}`
          }) was already removed when this ${op} failed, so that name is now free; the source "${toPosixPath(from)}" is still there. Nothing was rolled back, and re-running this ${op} after fixing the cause will not restore what the destination held.`;

// The IMMEDIATE entry count of a destination directory: the number the directory-permission
// refusal has to quote, and the number the `replaced` receipt reports. A listing that FAILS
// is not "empty" — it counts as non-empty (the safe side of the permission) and reports null,
// so both the message and the receipt say "could not be listed" rather than inventing a 0
// (same rule ./delete applies to an unreadable directory).
const directoryListing = async (path: string): Promise<{ entries: number | null; failure?: unknown }> => {
    try {
        return { entries: (await readdir(path)).length };
    } catch (error) {
        return { entries: null, failure: error };
    }
};

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

// The three situations in which a list page needs an explanation the cursor cannot carry
// (see the `note` bullet under LIST PAGING). They share one shape — a short or empty
// `entries` array — and had three DIFFERENT causes with three different remedies, all of
// them previously invisible: an earlier op of the same call ate the budget (M2), one long
// name stranded it (EXTRA-3), or the offset is past the end of the sequence (L8).
const listNote = (args: {
    offset: number;
    pageLength: number;
    windowLength: number;
    total: number;
    remainingAtStart: number;
    remainingAtCut: number;
    withheld?: { entry: string; size: number };
    consumer?: { path: string; offset: number; bytes: number };
}): string | undefined => {
    // M2 — STARVATION. Nothing of this listing could be emitted, and the reason is an
    // earlier op of THIS call, not anything about this directory. Naming that op is the
    // whole point: `entries: []` beside `truncated: true` reads like an answer.
    if (args.pageLength === 0 && args.windowLength > 0 && args.remainingAtStart === 0) {
        return args.consumer === undefined
            ? `The call's ${FILES_CONTENT_BUDGET}-byte entry budget was already spent before this list op ran, so no entry of this listing could be returned and nextOffset ${args.offset} has not advanced. Ask for this listing in a separate call, or list a narrower directory.`
            : `This list op found the call's ${FILES_CONTENT_BUDGET}-byte entry budget already spent: the list at "${args.consumer.path}" (offset ${args.consumer.offset}) charged ${args.consumer.bytes} of it, so no entry here could be returned and nextOffset ${args.offset} has not advanced. Ask for this listing in a separate call, or list a narrower directory.`;
    }

    // EXTRA-3 — the page stopped at an entry that no longer fits. Paging itself is kept
    // exactly as published (stop before the entry, never split it); only the cause of the
    // cut is disclosed, because the sequence is code-point SORTED and one long name strands
    // every usable byte behind it.
    if (args.withheld !== undefined) {
        return `This page stopped before "${args.withheld.entry}" at offset ${
            args.offset + args.pageLength
        }: that entry is ${args.withheld.size} bytes and only ${args.remainingAtCut} of the call's ${
            FILES_CONTENT_BUDGET
        }-byte entry budget was left. The listing is sorted by code point, so one long name can strand the budget that remains; pass nextOffset back in a fresh call to resume after it, or list a narrower directory.`;
    }

    // L8 — an offset at or past the end slices to `[]` and looked exactly like a listing that
    // happens to be exhausted. It stays a successful page; the note only says which it is.
    if (args.pageLength === 0 && args.windowLength === 0 && args.offset > 0) {
        return `offset ${args.offset} is at or past the end of this listing, which has ${args.total} ${
            args.total === 1 ? 'entry' : 'entries'
        }: this empty page means the sequence is exhausted, not that anything failed. Drop the offset to start over.`;
    }

    return undefined;
};

// The CALL's shared entry-text allowance, threaded through its list ops as one mutable cell
// (see LIST PAGING). `consumer` is the last op that charged it, which is what a later
// starved op has to name (M2).
type ListBudget = {
    remaining: number;
    consumer?: { path: string; offset: number; bytes: number };
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
// above the `contentBudget` printed beside it — the cap stays call-wide ON PURPOSE, so
// what a spent budget costs an unlucky op is a MARKER (`starved` + `note`), not a fresh
// allowance.
const runList = (
    request: PreparedOperation,
    budget: ListBudget
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

            // M2: what the CALL had left when THIS op started. The difference between "my
            // entries are too big" and "an earlier op of this call took everything" is only
            // knowable here, and it is the difference the caller can act on.
            const remainingAtStart = budget.remaining;

            const page: string[] = [];
            let bytes = 0;
            // EXTRA-3: the entry the budget refused, so the note can quote it (and the byte
            // count that made it not fit) instead of leaving a short page unexplained.
            let withheld: { entry: string; size: number } | undefined;

            for (const entry of window) {
                const size = Buffer.byteLength(entry, 'utf8');

                if (size > FILES_CONTENT_BUDGET) {
                    throw new HarnessError(
                        `files list entry at offset ${request.offset + page.length} is ${size} UTF-8 bytes, larger than the ${FILES_CONTENT_BUDGET}-byte budget, so it can never be returned. List a deeper directory so the entry prefix is shorter, or shorten the entry's name.`
                    );
                }

                // THE CALL's remaining allowance, not a fresh per-op budget: an entry
                // that no longer fits ends this page, and no entry is ever split.
                if (size > budget.remaining) {
                    withheld = { entry, size };
                    break;
                }

                budget.remaining -= size;
                page.push(entry);
                bytes += size;
            }

            // Bookkeeping for the starvation note: the op that last charged the allowance.
            if (bytes > 0) {
                budget.consumer = { path: toPosixPath(request.path), offset: request.offset, bytes };
            }

            const consumed = request.offset + page.length;
            const truncated = consumed < entries.length;
            const note = listNote({
                offset: request.offset,
                pageLength: page.length,
                windowLength: window.length,
                total: entries.length,
                remainingAtStart,
                remainingAtCut: budget.remaining,
                withheld,
                consumer: budget.consumer
            });
            const starved = page.length === 0 && window.length > 0 && remainingAtStart === 0;

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
                // Absent unless something made this page short or empty for a reason the
                // cursor cannot show, so a clean receipt keeps the exact shape the paging
                // tests pin (additive fields only — M2 / EXTRA-3 / L8).
                ...(starved ? { starved: true as const } : {}),
                ...(note === undefined ? {} : { note }),
                // Absent unless a directory failed.
                ...(failure === undefined ? {} : { error: listFailure(failure.cause, failure.path) })
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
                error: listFailure(error, toPosixPath(resolve(request.path)))
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

// The failure sentence for a throw site that ALREADY names the paths it failed between.
// `files delete failed on X: EIO on X: …` used to state the code and the path twice (M10);
// this drops the location clause when the site has it, and keeps it when the syscall reached
// for a DIFFERENT path (a `rm -rf` that tripped over a subdirectory, a copy walk that could
// not open one source folder) — which is the only case where quoting it is information
// rather than duplication (D10).
const failureAt = (error: unknown, named: string[], remedy?: string): string => {
    const location = failingPath(error);

    if (location === '' || named.includes(location)) return filesFailureLine(error, remedy);

    return filesFailureOf(error, toPosixPath(location), remedy).message;
};

// H1: the cross-device answer, spelled out instead of leaving `EXDEV` for the caller to
// interpret. The tool deliberately refuses to copy behind the caller's back (see DESTINATION
// POLICY), so the remedy is the CALLER making that choice in the open, with the two ops it
// has to send written out.
const crossDeviceMoveRemedy = (from: string, to: string): string =>
    `The source and the destination are on different devices, and this tool never turns a move into a copy-plus-delete behind your back. Do it in the open: { "op": "copy", "from": "${toPosixPath(from)}", "to": "${toPosixPath(to)}" }, then { "op": "delete", "path": "${toPosixPath(from)}" } — or choose a destination on the same device.`;

// The `machine triple` half of a thrown failure (the `details` convention of
// ../../util/errors.ts): the code, the raw errno when it was folded, and the path it is
// about, so a host does not have to parse the sentence it was written for.
const failureDetails = (error: unknown, path: string): Record<string, unknown> => {
    const { code, rawCode } = failureParts(error);

    return { path: toPosixPath(path), code, ...(rawCode === undefined ? {} : { rawCode }) };
};

// One mutation, executed when its turn arrives. Throwing here is what rejects the
// call; the caller names the ops that already completed.
const runMutation = async (request: PreparedOperation): Promise<FilesOperationResult> => {
    const { op, path } = request;

    if (op === 'mkdir') {
        // EXTRA-6: `lstat` FIRST — the same rule ./delete and the copy/move SOURCE check
        // already follow, and the one this op had not adopted. `stat` follows a symlink, so a
        // DANGLING link read as "nothing is here", `mkdir` then failed on a name that IS
        // taken, and the caller got `EIO … EEXIST`: three codes, no mention of the link, and
        // nothing to act on. Every shape now gets its own sentence, and the dangling one gets
        // the two remedies that actually apply.
        try {
            const entry: Stats | undefined = await lstat(path).catch(() => undefined);

            if (entry === undefined) {
                await mkdir(path, { recursive: true });

                return { op, path: toPosixPath(path), created: true };
            }

            if (entry.isDirectory()) {
                // "the state you asked for already holds" — a success, not an error.
                return { op, path: toPosixPath(path), created: false };
            }

            if (entry.isSymbolicLink()) {
                const target = await stat(path).catch(() => undefined);

                // A link that reaches a directory IS usable as one, which is the state that
                // was asked for; this is the answer it has always given.
                if (target?.isDirectory() === true) {
                    return { op, path: toPosixPath(path), created: false };
                }

                if (target === undefined) {
                    const stored = await readlink(path).catch(() => undefined);

                    throw new HarnessError(
                        `files mkdir refused: "${path}" is a symlink pointing at "${stored ?? '(unreadable target)'}", and that target does not exist, so the name is taken with no directory behind it. Pass a different "path", or delete the link ({ "op": "delete", "path": "${toPosixPath(path)}" }) and mkdir again${
                            stored === undefined ? '' : `, or mkdir the target "${toPosixPath(resolve(dirname(path), stored))}" itself`
                        }.`,
                        {
                            code: FILES_REFUSAL_CODES.mkdirDanglingLink,
                            details: { path: toPosixPath(path), kind: 'symlink', target: stored ?? null, targetExists: false }
                        }
                    );
                }

                throw new HarnessError(`files mkdir refused: "${path}" is a symlink to a file, not a directory.`, {
                    code: FILES_REFUSAL_CODES.mkdirNotDirectory,
                    details: { path: toPosixPath(path), kind: 'symlink', targetExists: true, targetIsDirectory: false }
                });
            }

            throw new HarnessError(`files mkdir refused: "${path}" is a file, not a directory.`, {
                code: FILES_REFUSAL_CODES.mkdirNotDirectory,
                details: { path: toPosixPath(path), kind: 'file' }
            });
        } catch (error) {
            // A refusal above is already the actionable sentence; only a filesystem failure
            // reaching here needs the errno rendered.
            if (error instanceof HarnessError) throw error;

            // F2 (final audit): this was the ONLY failure site in the tool that threw with no
            // `details` at all, so the folded errno survived only as prose. Measured: `mkdir`
            // on a loop ancestor answered `{ code: 'EIO' }` with `details.rawCode` absent while
            // `list` on the identical path answered `{ code: 'EIO', rawCode: 'ELOOP' }`, and
            // `read`/`write`/`edit` answer the same shape with `ELOOP` — so the one verb that
            // CREATES had the least machine-readable answer. `failureDetails` carries the raw
            // errno under the published rule (present ONLY when it differs from `code`), which
            // is what ./delete (:1657) and ./copy + ./move (:1955, :1994) already do; the
            // message is unchanged, because `filesFailureLine` already renders `EIO (ELOOP)`.
            const { code } = failureParts(error);

            throw new HarnessError(`files mkdir failed on ${path}: ${filesFailureLine(error, mkdirRemedy(code))}`, {
                code,
                cause: error,
                details: failureDetails(error, path)
            });
        }
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
                    `files delete: "${path}" does not exist. Pass force: true when "already gone" is an acceptable answer.`,
                    { code: FILES_REFUSAL_CODES.deleteMissing, details: { path: toPosixPath(path), exists: false } }
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
                // sent a caller to a flag whose removal then failed on the same EACCES. The
                // errno is rendered WITHOUT a second copy of this path (M10) — the sentence
                // already names it — and the machine triple goes in `details` for the host
                // that has to switch on it.
                const cause = filesFailureOf(listing.failure, toPosixPath(path));

                throw new HarnessError(
                    `files delete: "${path}" ${existing.isSymbolicLink() ? 'is a symlink whose directory could not be listed' : 'is a directory that could not be listed'}, so it is treated as non-empty: ${filesFailureLine(listing.failure)} Pass recursive: true to attempt the removal anyway${
                        existing.isSymbolicLink() ? ' (it removes the LINK only, never the target)' : ''
                    }.`,
                    {
                        code: cause.code,
                        details: { path: toPosixPath(path), listing: cause, entries: null, recursive: request.recursive }
                    }
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
                        : `files delete: "${path}" is a directory. Pass recursive: true to remove it and everything inside it.`,
                    {
                        code: FILES_REFUSAL_CODES.deleteNonEmpty,
                        details: {
                            path: toPosixPath(path),
                            kind: existing.isSymbolicLink() ? 'symlink' : 'directory',
                            entries: listing.entries
                        }
                    }
                );
            }
        }

        try {
            if (isDirectoryEntry && !request.recursive) {
                // THE VERIFIED-EMPTY SHAPE (EXTRA-5). Emptiness was just decided by `readdir`,
                // and the removal used to be `rm(path, { recursive: true })` — a call that
                // deletes whatever is under the name by the time it runs, so anything written
                // into the directory between the two awaits went with it although the caller
                // never asked for `recursive`. `rmdir` is exactly what was asked for: it takes
                // an EMPTY directory and answers ENOTEMPTY if the race put an entry in it, so
                // the race surfaces as a refusal instead of as a silent tree deletion.
                // `rmdir` refuses a SYMLINK with ENOTDIR, so a link goes through `unlink` —
                // also the exact operation here, because the LINK is the entry the caller named
                // and its target keeps every byte (which is what the empty-directory test
                // pins). The receipt still reports the caller's own `recursive: false`.
                if (existing.isSymbolicLink()) {
                    await unlink(path);
                } else {
                    await rmdir(path);
                }
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
            // ENOTEMPTY here is the race above, stated as such: the caller's next move is
            // `recursive: true`, and nothing in Node's message says that.
            const { code, rawCode } = failureParts(error);
            const raw = rawCode ?? code;

            throw new HarnessError(
                `files delete failed on ${path}: ${filesFailureLine(error, raw === 'ENOTEMPTY' ? 'Entries appeared in this directory after it was checked, so it is not empty any more; pass recursive: true when the whole tree may go.' : undefined)}`,
                { code, cause: error, details: { path: toPosixPath(path), code, ...(rawCode === undefined ? {} : { rawCode }) } }
            );
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
        throw new HarnessError(`files ${op}: source "${fromPath}" does not exist.`, {
            code: FILES_REFUSAL_CODES.sourceMissing,
            details: { path: toPosixPath(fromPath), exists: false }
        });
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
        // L2: `copy` gets copy's own reason instead of sharing `move`'s. "Replacing the
        // destination would delete what this operation reads from" described a rename onto a
        // removed name; a COPY removes the name first and then reads from it, so the sentence
        // has to say that the entry at risk is the one it reads from. (A no-op success here
        // would be the bigger contract change — `copy X -> X` stays a refusal.)
        const why =
            relationship === 'self'
                ? op === 'copy'
                  ? 'source and destination are the same path, so the copy would have to remove that name before writing it, which deletes the very entry it reads from'
                  : 'source and destination are the same path, so replacing the destination would delete what this operation reads from'
                : op === 'copy'
                  ? 'the destination is inside the source, so the copy would walk into its own output'
                  : 'the destination is inside the source, and a directory cannot be moved inside itself';

        throw new HarnessError(
            `files ${op} refused: ${why}. Source "${fromPath}", destination "${toPath}". Pass a "to" that is neither the source nor under it.`,
            {
                code: relationship === 'self' ? FILES_REFUSAL_CODES.sourceIsDestination : FILES_REFUSAL_CODES.destinationInsideSource,
                details: { path: toPosixPath(fromPath), to: toPosixPath(toPath), relationship }
            }
        );
    }

    // EXTRA-2: the DESTINATION is read with `lstat` first, the same rule the source check
    // above and ./delete follow. A followed `stat` calls a DANGLING symlink "missing", which
    // let a `move` replace a name that WAS taken without the caller ever saying `overwrite`,
    // and let a `copy` follow the link and CREATE its missing target instead of writing the
    // destination that was named.
    const destinationEntry: Stats | undefined = await lstat(toPath).catch(() => undefined);
    const destinationTarget: Stats | undefined = destinationEntry?.isSymbolicLink()
        ? await stat(toPath).catch(() => undefined)
        : destinationEntry;
    const destinationExists = destinationEntry !== undefined;

    // The only destination shape whose replacement destroys a TREE: a real directory standing
    // at that name. A symlink — live or dangling — costs the LINK and nothing under it (`rm`
    // and `rename` never follow it, exactly like ./delete on a link), so it needs no extra
    // permission. Counted on this path only, and BEFORE anything is removed, because the
    // refusal has to quote the number and the receipt has to report it afterwards.
    const destinationIsTree = destinationEntry?.isDirectory() === true;
    const destinationListing = destinationIsTree ? await directoryListing(toPath) : undefined;
    const destinationEntries = destinationListing?.entries ?? null;
    const sourceIsTree = sourceTarget?.isDirectory() === true;

    // THE ANCESTOR SHAPE (D1). M5 moved this verdict AHEAD of the exists/`overwrite` hint:
    // `move t/sub -> t` used to answer "already exists, pass overwrite: true", and following
    // that advice landed in a DIFFERENT refusal two lines later — advice that walks the caller
    // into a flag whose only effect here is to reach the same refusal. It is asked where the
    // destination is known to EXIST, because an absent `to` makes the same call a plain
    // rename that CREATES `t`, which is legal and has always worked. The removal this guard
    // prevents is `rm -rf` on a directory HOLDING the source: it deleted `t/a.txt`,
    // `t/deep/…` AND `t/sub/…`, then failed (ENOENT on the rename, ENOENT on `scandir` for a
    // copy) while reporting "Operations already applied: none". Still before any mutation —
    // no `mkdir`, no `rm`.
    if (relationship === 'ancestor' && destinationExists) {
        throw new HarnessError(
            `files ${op} refused: the destination contains the source, so replacing it would delete the tree this operation reads from. Source "${fromPath}", destination "${toPath}". Pass a "to" that is not an ancestor of "from". A "to" that does NOT exist yet is a different call: moving t/sub to t when t is absent is a plain rename that creates t, and that one is allowed.`,
            {
                code: FILES_REFUSAL_CODES.destinationContainsSource,
                details: {
                    path: toPosixPath(fromPath),
                    to: toPosixPath(toPath),
                    relationship: 'ancestor',
                    overwrite: request.overwrite,
                    ...(destinationEntries === null ? {} : { entries: destinationEntries })
                }
            }
        );
    }

    // C1 — the DIRECTORY PERMISSION, decided before the `overwrite` hint so the hint can
    // never be wrong advice about a shape `overwrite` alone cannot replace. `overwrite` says
    // "the NAME at `to` may go"; it does not say "the TREE at `to` may go". Measured before
    // this rule: `move file.txt -> dir` with `overwrite: true` answered
    // `{ kind: "file", bytes: 4 }` after deleting `dir` and everything under it.
    //
    // A directory replacement therefore needs `replaceDirectory: true` when EITHER side makes
    // the tree the casualty: a NON-directory source taking a directory's name, or a directory
    // source replacing a destination directory that is not empty. An EMPTY destination
    // directory with a directory source destroys nothing, so `overwrite` is enough there.
    const replacingTree = destinationIsTree && (!sourceIsTree || destinationEntries === null || destinationEntries > 0);

    if (destinationExists && replacingTree && !request.replaceDirectory) {
        throw new HarnessError(
            `files ${op} refused: destination "${toPath}" is a directory that ${
                destinationEntries === null
                    ? 'could not be listed (its entries are counted as unknown, which is treated as non-empty)'
                    : `holds ${destinationEntries} ${destinationEntries === 1 ? 'entry' : 'entries'}`
            }, and replacing it removes that WHOLE tree. ${
                sourceIsTree
                    ? 'The source is a directory too, so the call swaps one tree for the other.'
                    : `The source "${toPosixPath(fromPath)}" is not a directory, so it would take the directory's name and its contents would be gone.`
            } Pass a "to" INSIDE that directory (for example "${toPosixPath(toPath)}/${sourceIsTree ? 'inner' : 'name'}"), or pass ${
                request.overwrite ? '' : 'overwrite: true and '
            }replaceDirectory: true to remove the tree and take its name.`,
            {
                code: FILES_REFUSAL_CODES.destinationDirectory,
                details: {
                    path: toPosixPath(fromPath),
                    to: toPosixPath(toPath),
                    kind: 'directory',
                    entries: destinationEntries,
                    sourceKind: sourceIsTree ? 'directory' : 'file',
                    requiredFlags: request.overwrite ? ['replaceDirectory'] : ['overwrite', 'replaceDirectory']
                }
            }
        );
    }

    if (destinationExists && !request.overwrite) {
        // The plain EEXIST refusal: "already exists. Pass overwrite: true to replace it."
        // is the sentence the tests and the published description quote, so it stays
        // byte-compatible. The clause after it describes the SHAPE standing at that name,
        // which is what a caller acting on the advice needs — and, for a dangling symlink,
        // the whole reason the name looked free before EXTRA-2.
        const stored = destinationEntry!.isSymbolicLink() ? await readlink(toPath).catch(() => '') : '';
        const shape = destinationEntry!.isSymbolicLink()
            ? ` It is a symlink pointing at "${toPosixPath(resolve(dirname(toPath), stored))}", ${
                  destinationTarget === undefined
                      ? 'whose target does not exist: a followed stat called that name free, which is exactly how a move used to replace a taken name without asking'
                      : 'which is a live entry'
              }; overwriting it removes the LINK and never anything under the target.`
            : destinationIsTree
              ? ' It is an EMPTY directory, so replacing it destroys nothing and overwrite alone is enough for that shape.'
              : '';

        throw new HarnessError(
            `files ${op}: destination "${toPath}" already exists. Pass overwrite: true to replace it.${shape}`,
            {
                code: FILES_REFUSAL_CODES.destinationExists,
                details: {
                    path: toPosixPath(toPath),
                    kind: destinationEntry!.isSymbolicLink() ? 'symlink' : destinationIsTree ? 'directory' : 'file',
                    ...(destinationEntries === null || !destinationIsTree ? {} : { entries: destinationEntries })
                }
            }
        );
    }

    // Parents of the destination do not exist as often as they do: create them, the
    // way ./write does, rather than costing the caller a round trip.
    const toParent = dirname(toPath);

    // F1 (final audit): this syscall used to sit OUTSIDE every classifying `try`, while the
    // `rm` below it has been wrapped since EXTRA-1. So the raw Node error reached
    // ./operationFailure (:2193) with no `code` of its own, and the caller of a `copy`/`move`
    // whose destination parent could not be created got the GENERIC batch verdict —
    // `code: 'files-operation-failed'`, `details.failure.code: null`, Node's prose as the
    // message, no `rawCode` — for an EACCES this tool PUBLISHES (FILES_ERROR_CODES). Measured
    // on a `0555` parent: `copy -> ro/missing/copy.txt` was generic while `copy -> ro/copy.txt`
    // (parent already exists, so this line is a no-op and `copyFile` answers the same errno) was
    // `code: 'EACCES'` — the same errno, one call shape apart. Classifying here uses exactly the
    // sibling's shape, so ./operationFailure's envelope (`op`, `path`, `applied`, `appliedCount`,
    // `rollback: false`, `failure`) is untouched and only finally carries a real `failure.code`.
    try {
        await mkdir(toParent, { recursive: true });
    } catch (error) {
        const parts = failureParts(error);

        throw new HarnessError(
            // `failureAt` names the failing path ONLY when the sentence has not already named it
            // (M10): recursive `mkdir` puts the folder it could not create on `error.path`, which
            // is `toParent` and is already quoted here, so the errno renders in the location-free
            // form. `mkdirRemedy` is the same advice ./mkdir gives for the same errno.
            `files ${op} could not create the destination folder ${toPosixPath(toParent)} for ${toPosixPath(toPath)}: ${failureAt(error, [toParent, toPath, fromPath], mkdirRemedy(parts.code))}`,
            {
                code: parts.code,
                cause: error,
                // The triple points at the folder that refused the mkdir — the path a caller has
                // to fix — rather than at the destination that will never be built.
                details: failureDetails(error, toParent)
            }
        );
    }

    // EXTRA-1: what the `overwrite` removal DESTROYS, captured before the removal happens,
    // so both the receipt (rule 4) and a later failure can state it. The removal itself still
    // runs before the syscall that replaces it — that ordering is what makes the half-state
    // below necessary, and reporting it is what makes it survivable.
    let replaced: FilesReplacedEntry | undefined;

    if (destinationExists && request.overwrite) {
        try {
            await rm(toPath, { recursive: true, force: true });
        } catch (error) {
            throw new HarnessError(`files ${op} could not replace ${toPath}: ${failureAt(error, [toPath, fromPath])}`, {
                code: failureParts(error).code,
                cause: error,
                details: failureDetails(error, toPath)
            });
        }

        replaced = {
            path: toPosixPath(toPath),
            kind: destinationEntry!.isSymbolicLink() ? 'symlink' : destinationIsTree ? 'directory' : 'file',
            entries: destinationIsTree ? destinationEntries : 0
        };
    }

    // M6: `kind` says what stands at the DESTINATION after the operation, which is the only
    // version of the question a caller can act on. `rename` never follows a link, so a moved
    // link is still a link whatever it pointed at; a copy DEREFERENCES a live one (that is
    // what `copyFile` and the tree walk do, and the payload under the name is what a caller
    // copying a link-to-a-file wants) and PRESERVES a dangling one, which has no payload to
    // dereference. See SYMLINKS ARE DELIBERATELY INCONSISTENT PER VERB in the header.
    const kind: 'file' | 'directory' | 'symlink' =
        sourceEntry.isSymbolicLink() && (op === 'move' || sourceTarget === undefined)
            ? 'symlink'
            : sourceTarget?.isDirectory() === true
              ? 'directory'
              : 'file';

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
            // changed nothing" while a half-copied tree sits on disk (D5). L1 adds what that
            // tree IS (its top-level names) and says plainly that the remainder is PARTIAL;
            // EXTRA-1's note covers the entry `overwrite` had already removed.
            const note = `${copyProgressNote(toPath, written)}${await copyRemainderNote(toPath, written)}`;
            const destroyed = replacementNote('copy', toPath, fromPath, replaced);

            if (error instanceof HarnessError) {
                throw new HarnessError(`${error.message}${note}${destroyed}`, {
                    // The depth refusal carries no errno, so it stays the refusal it is —
                    // with this op's half-state attached to the rejection.
                    code: error.code ?? FILES_REFUSAL_CODES.operationFailed,
                    cause: error,
                    details: { path: toPosixPath(fromPath), to: toPosixPath(toPath), written, replaced: replaced ?? null }
                });
            }

            // D10: the errno names the path the FAILING syscall touched (`error.path`), not
            // the destination the caller passed — an unreadable SOURCE directory used to be
            // reported as `EACCES on <destination>`. `failureAt` adds that location ONLY when
            // it is a path this sentence has not already named (M10).
            const parts = failureParts(error);

            throw new HarnessError(
                `files copy failed on ${fromPath} -> ${toPath}: ${failureAt(error, [fromPath, toPath])}${note}${destroyed}`,
                {
                    code: parts.code,
                    cause: error,
                    details: {
                        ...failureDetails(error, failingPath(error, fromPath)),
                        path: toPosixPath(fromPath),
                        to: toPosixPath(toPath),
                        written,
                        replaced: replaced ?? null
                    }
                }
            );
        }

        return {
            op,
            path: toPosixPath(fromPath),
            to: toPosixPath(toPath),
            kind,
            bytes,
            // Rule 4 of DESTINATION POLICY: the caller sees what the replacement removed,
            // counted as it stood BEFORE the removal.
            ...(replaced === undefined ? {} : { replaced })
        };
    }

    try {
        await rename(fromPath, toPath);
    } catch (error) {
        // EXDEV (cross-device), EISDIR (a file onto a directory) and ENOTEMPTY (a directory
        // target that gained entries since it was examined) are reported as-is: this tool
        // never turns a rename into a copy-plus-delete behind the caller's back. The thrown
        // error now carries the errno's own NAME (H1: the site used to build a HarnessError
        // with no `code` at all, so `error.code` was undefined exactly where a caller has to
        // branch), and the message states what to DO, because an errno is not an instruction.
        const parts = failureParts(error);
        const raw = parts.rawCode ?? parts.code;

        const remedy =
            parts.code === 'EXDEV'
                ? crossDeviceMoveRemedy(fromPath, toPath)
                : raw === 'EISDIR'
                  ? 'A file cannot become a directory: pass a "to" INSIDE that directory, or remove it first ({ "op": "delete", "path": "<that directory>", "recursive": true }) and send overwrite: true with replaceDirectory: true.'
                  : raw === 'ENOTEMPTY'
                    ? 'The destination is a directory that is not empty any more; remove it with { "op": "delete", "path": "<the destination>", "recursive": true }, or pick a destination that is free.'
                    : '';

        throw new HarnessError(
            `files move failed on ${fromPath} -> ${toPath}: ${failureAt(error, [fromPath, toPath], remedy)}${replacementNote('move', toPath, fromPath, replaced)}`,
            {
                code: parts.code,
                cause: error,
                details: {
                    ...failureDetails(error, failingPath(error, toPath)),
                    path: toPosixPath(fromPath),
                    to: toPosixPath(toPath),
                    // EXTRA-1: the half-state as DATA, not only as prose — what the removal
                    // destroyed, and the fact that the source is still there.
                    replaced: replaced ?? null,
                    sourceStillExists: true
                }
            }
        );
    }

    return {
        op,
        path: toPosixPath(fromPath),
        to: toPosixPath(toPath),
        kind,
        // A 'symlink' receipt reports 0 BYTES (M6): a rename writes no payload, and the size
        // of a live link's TARGET described a file the destination is not. A moved directory
        // reports 0 for the same reason — the rename moved an entry, it wrote nothing.
        bytes: kind === 'directory' || kind === 'symlink' ? 0 : sourceTarget?.size ?? 0,
        ...(replaced === undefined ? {} : { replaced })
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
        'Manage files and folders: list, move, copy, delete, and mkdir in ONE call, applied in the order given. Pass an array of operations, each `{ op, ... }`: list takes `path` (one directory or several, default the working directory) plus `offset`/`limit`; move and copy take `from` and `to` plus `overwrite` (default false, so an existing destination is an EEXIST error, not a silent replace) and `replaceDirectory` (default false, move/copy only; REQUIRED whenever replacing the destination would delete a TREE - a file moved or copied onto a directory name, or a directory onto a NOT-EMPTY directory - because `overwrite` permits removing the NAME at `to`, not the contents under it, and a call that omits it is refused with the number of entries at stake and changes nothing; an EMPTY destination directory with a directory source needs only `overwrite`, and a destination that is a symlink needs only `overwrite` because the link, never anything under its target, is what goes); a destination that is the source, inside it, or an ancestor of it is refused before anything moves, and a copy stops at a depth of 64 directory levels; delete takes `path` plus `recursive` (a non-empty directory without it is refused; for a symlink it removes the link only, never the target or its contents) and `force` (a missing path becomes `removed: false, skipped: true` instead of an error); mkdir takes `path` and creates missing parents, reporting an existing directory (or a symlink that reaches one) as `created: false`, and refusing a name held by a DANGLING symlink with the remedy for that shape. Returns `{ results, bytes, contentBudget }` with ONE ordered receipt per op: list gives `{ entries, truncated, nextOffset, offset, limit, bytes }`, plus `starved: true` and a `note` when an earlier list op of the same call already spent the shared entry budget (an empty page that is NOT an answer about the directory), move/copy give `{ path, to, kind, bytes }` where `kind` is what stands at the DESTINATION afterwards - `file`, `directory`, or `symlink`: a moved link stays a link and reports 0 bytes, while a copy of a live link writes the payload under it, and a copy of a dangling one writes the link - plus `replaced: { path, kind, entries }` whenever the call removed an existing destination, so the tree it deleted is visible in the receipt rather than only in the message; delete gives `{ path, removed, recursive }`, and mkdir gives `{ path, created }`. Entry names are prefixed with the directory they came from, directories end with "/", and listings are sorted by code point, so paging is deterministic; a `note` also says when a page stopped early because one long name did not fit the remaining budget, or when an `offset` is past the end of the listing. Every entry is validated before anything runs, so a malformed call changes nothing; a failing mutation rejects the call, names the ops already applied AND states what this op left behind (a half-copied tree with its top-level entries, or a destination its own `overwrite` had already removed while the source stayed), and there is NO rollback, while a failing list entry reports its own `error: { code, rawCode?, message }` without failing the batch. A cancelled call rejects the same way with `ECANCELED`, naming the operation it stopped on and the ops already applied. Cross-device moves report `EXDEV` rather than copying behind your back, and the message names the two calls to send instead ({ "op": "copy" }, then { "op": "delete" }). Symlinks are handled differently per verb, on purpose: move renames the link, top-level copy dereferences a live link and preserves a dangling one, links inside a copied tree are preserved, delete removes the link only, and each result says which happened. Use read/write/edit for content and glob/grep for searching.',
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
                                'move/copy: the destination. Parent directories are created. An existing destination needs overwrite: true, and an existing destination DIRECTORY needs replaceDirectory: true as well whenever the replacement would remove a tree (a non-directory source taking the name, or a non-empty destination directory). A "to" that names a directory is NOT treated as "put it inside that directory": pass the full destination path.'
                        },
                        overwrite: {
                            type: 'boolean',
                            description:
                                'move/copy: replace an existing destination instead of failing on it. For a destination that is a FILE or a SYMLINK that is the whole permission (a symlink replacement costs the link, never anything under its target). For a destination that is a DIRECTORY it is not enough on its own - see replaceDirectory. Defaults to false.'
                        },
                        replaceDirectory: {
                            type: 'boolean',
                            description:
                                'move/copy only: also allow removing a destination DIRECTORY together with the whole tree under it. Required whenever `overwrite` would delete a tree: a non-directory source taking a directory name, or a directory source replacing a destination directory that is not empty. An empty destination directory with a directory source needs only `overwrite`. The removal is refused WITHOUT it - nothing is deleted, and the refusal counts the entries that were at stake - and every replacement this flag allows is reported in the receipt as `replaced: { path, kind, entries }`. Defaults to false.'
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

// The ONE batch-level rejection: the ops that already produced receipts, the op that did
// not, and the fact that nothing was undone. Extracted from ./execute's catch because TWO
// paths need the same sentence and the same `details` byte-identically:
//
//   - a mutation whose syscall failed, and
//   - a call whose abort signal had already fired when this op's turn came (the per-op check
//     in ./execute) — the case where "Operations already applied" matters MOST, because the
//     caller is looking at a half-run batch it cancelled and has to know what is on disk.
//
// M11 is why the applied list travels as DATA as well as prose: the message is the half a
// model reads, `code` + `details` are the half a program switches on. The `code` is the inner
// refusal's own when it has one (`EXDEV`, `files-destination-directory`, `ECANCELED`) and the
// generic batch name otherwise.
const operationFailure = (
    operation: PreparedOperation,
    results: readonly FilesOperationResult[],
    error: unknown
): HarnessError => {
    const appliedReceipts = results.map((entry) => `${entry.op} ${entry.path ?? ''}`.trim());
    const applied = appliedReceipts.length === 0 ? 'none' : appliedReceipts.join(', ');

    const reason = error instanceof Error ? error.message : String(error);

    const inner = error instanceof HarnessError ? error : undefined;
    const innerDetails = inner?.details;

    return new HarnessError(
        `files failed on ${operation.op} ${operation.path}: ${reason} Operations already applied: ${applied}. No rollback was performed.`,
        {
            code: typeof inner?.code === 'string' && inner.code.length > 0
                ? inner.code
                : FILES_REFUSAL_CODES.operationFailed,
            cause: error,
            details: {
                op: operation.op,
                path: toPosixPath(operation.path),
                applied: appliedReceipts,
                appliedCount: results.length,
                rollback: false,
                // The half-state the failing op reported (`written`, `replaced`,
                // `sourceStillExists`, the errno triple) is carried through
                // rather than flattened into the sentence above.
                failure: {
                    code: inner?.code ?? null,
                    ...(innerDetails === undefined ? {} : { details: innerDetails })
                }
            }
        }
    );
};

export const files = tool<FilesParameters, FilesResult>({
    ...FILES_METADATA,
    execute: async ({ parameters, signal }) => {
        // Cancellation before ANY work, including the preflight (which resolves every
        // identity to lock): an aborted call has no consumer for the locks or the ops
        // (./cancellation.ts). Nothing has run yet, so `details` says so in the same shape
        // the batch-level rejection uses, and the per-op check below covers a cancel that
        // lands after this point.
        throwIfFileCancelled('files', signal, 'before any operation ran', {
            applied: [],
            appliedCount: 0,
            rollback: false
        });

        const prepared = await prepareOperations(parameters);

        // D4 (./lock.ts): the harness launches every tool call of one assistant
        // message CONCURRENTLY, so a `files` mutation and a `write`/`edit` on the same
        // path can overlap. Hold the same per-file locks ./write and ./edit take —
        // by real identity, so a Windows case alias shares the key — across the whole
        // batch. A list op reads and needs none.
        //
        // EXTRA-7: these are the locks there ARE, which is the NAMED paths of every
        // mutation in the batch — `path` (the source for a move/copy) and `to`. A
        // recursive `delete` and a directory `copy` reach whole subtrees that are NOT
        // locked, because one lock per walked entry would hold the batch for the length
        // of the walk and still miss a path the caller never named. So "files serializes
        // against write/edit" means "on the paths it names", nothing wider (the header
        // states the same bound).
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
            // `consumer` (see ./ListBudget) is what lets a LATER op name the earlier one that
            // starved it instead of answering `entries: []` and leaving the caller to guess.
            const budget: ListBudget = { remaining: FILES_CONTENT_BUDGET };

            for (const operation of prepared) {
                // CANCELLATION is checked before EVERY op — a `list` included, because an
                // aborted call has no consumer for another page of entries either
                // (src/types/index.ts:2356-2357). The throw goes through `operationFailure`
                // below so the caller still gets the receipts this call already produced:
                // a cancelled batch is the one case that is knowingly left half-run, so the
                // applied list is the most load-bearing data it reports (./cancellation.ts).
                if (signal?.aborted === true) {
                    throw operationFailure(
                        operation,
                        results,
                        fileCancelledError('files', 'before this operation', { reason: signal.reason })
                    );
                }

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
                    // already happened, and claim no rollback that does not exist. The
                    // sentence AND the machine-readable half are built by `operationFailure`
                    // (see above), which is also the path a cancelled call takes.
                    throw operationFailure(operation, results, error);
                }
            }

            return { results, bytes, contentBudget: FILES_CONTENT_BUDGET };
        });
    }
});
