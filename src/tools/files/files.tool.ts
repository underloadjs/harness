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
// walked directory, and 0 for a directory MOVE (a rename writes no bytes).
//
// LIST PAGING (inherited verbatim from `fileList`)
// ------------------------------------------------
// Each list op is its own bounded window over a deterministic flat sequence:
// directories in the caller's order, each listing sorted by code point, every entry
// prefixed with the directory it came from, directories ending in "/".
//
//   - `limit` entries: default 200 (FILES_LIST_DEFAULT_LIMIT), hard maximum 1000
//     (FILES_LIST_MAX_LIMIT) — larger values are clamped, never rejected;
//   - FILES_CONTENT_BUDGET (64 KiB) of UTF-8 entry text is an AGGREGATE budget
//     shared by every list op in the call (`bytes` reports what the call consumed,
//     `contentBudget` the fixed cap). A page stops BEFORE the entry that would
//     cross it, so no entry is ever split;
//   - `truncated` is true when entries exist beyond this page and `nextOffset`
//     locates them; pass it back as that entry's `offset`. An entry whose own
//     UTF-8 size exceeds the whole budget can never be paged, so the call is
//     refused with a message naming it rather than returning a cursor that never
//     advances.
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
//   - a failing LIST op is a per-entry `error: { code, message }` (ENOENT, ENOTDIR,
//     EACCES/EPERM, EIO), exactly like `read`, because a read-only entry in a mixed
//     batch must not throw away mutations that already succeeded.
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
// WHAT `delete` REFUSES
// ---------------------
// A non-empty directory without `recursive` is an ENOTEMPTY error: `files` never
// deletes a tree the caller did not say it meant. A missing path is an ENOENT error
// unless `force: true`, which reports the receipt as `removed: false, skipped: true`
// — cancellation-style idempotence, "already deleted" is a success, not a surprise.
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

import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
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
    // list: maximum entries in this page (1-1000, default 200).
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
    // list: this page of entries, prefixed and sorted.
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

// Validate the whole batch before the first filesystem call.
const prepareOperations = (ops: FilesParameters): PreparedOperation[] => {
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

    return ops.map((entry, index) => prepareOperation(entry, index));
};

// Map a Node filesystem error onto the small code set this tool publishes.
const failureOf = (error: unknown, path: string): { code: string; message: string } => {
    const reason = error instanceof Error ? error.message : String(error);
    const code =
        typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'EIO';

    return { code, message: `${code} on ${path}: ${reason}` };
};

// Size of a regular file, 0 when the stat fails (the caller's own stat decides
// whether that is an error worth reporting).
const sizeOf = async (path: string): Promise<number> => {
    try {
        const info = await stat(path);
        return info.isFile() ? info.size : 0;
    } catch {
        return 0;
    }
};

// Recursive copy walk. Returns the total bytes of file payloads written, which is
// what a copied directory reports as `bytes` (a moved directory renames and writes
// nothing, so it reports 0).
const copyDirectory = async (from: string, to: string): Promise<number> => {
    await mkdir(to, { recursive: true });

    const listing = await readdir(from, { withFileTypes: true });
    let bytes = 0;

    for (const entry of listing) {
        const source = join(from, entry.name);
        const target = join(to, entry.name);

        if (entry.isDirectory()) {
            bytes += await copyDirectory(source, target);
        } else if (entry.isFile()) {
            await copyFile(source, target);
            // Measured on the source, which is what was just written byte-for-byte.
            bytes += await sizeOf(source);
        } else {
            // A symlink or a socket inside a copied tree is reported, never
            // silently skipped or followed into someone else's directory.
            throw new HarnessError(
                `files copy does not follow special entries: "${toPosixPath(source)}" is neither a file nor a directory.`
            );
        }
    }

    return bytes;
};

// A list failure carries the directory that actually failed, resolved. `fileList`
// rejected the whole call in this situation; `files` answers per entry (./read's rule),
// and the entry it answers must name the path it tried to read — the caller's spelling
// alone ("src") is not enough when the working directory is not the caller's.
class ListFailure extends Error {
    constructor(
        readonly cause: unknown,
        readonly path: string
    ) {
        super('files list failed');
    }
}

// The one list operation: build the flat sequence, then window it.
//
// Every requested directory is read even when the window covers only the first one,
// which is what makes a missing directory visible (as this entry's own error) rather
// than silently absent.
const runList = (request: PreparedOperation): Promise<FilesOperationResult> => {
    const collect = async (): Promise<string[]> => {
        const entries: string[] = [];

        for (const directory of request.paths) {
            // READ the resolved path, PREFIX with the caller's spelling: `fileList`'s
            // presentation rule, so `.` contributes no prefix and a default list returns
            // bare entry names, while `src` returns `src/a.ts` (never an absolute path).
            const target = resolve(directory);
            let listing: Dirent[];

            try {
                listing = await readdir(target, { withFileTypes: true });
            } catch (error) {
                throw new ListFailure(error, toPosixPath(target));
            }

            const names = listing
                .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
                .sort(compareNames);

            for (const name of names) {
                entries.push(toPosixPath(join(directory, name)));
            }
        }

        return entries;
    };

    return collect()
        .then((entries) => {
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

                if (bytes + size > FILES_CONTENT_BUDGET) break;

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
                nextOffset: truncated ? consumed : null,
                offset: request.offset,
                limit: request.limit,
                bytes
            };
        })
        .catch((error: unknown) => {
            // An oversized entry is a refusal, not a read failure: it must still
            // fail the call, because its cursor can never advance.
            if (error instanceof HarnessError) throw error;

            // A read-only failure belongs to its own entry (see FAILURE SEMANTICS):
            // it must not throw away mutations an earlier entry already applied.
            const source = error instanceof ListFailure ? error.cause : error;
            const where = error instanceof ListFailure ? error.path : toPosixPath(request.path);

            return {
                op: 'list' as const,
                path: toPosixPath(request.path),
                entries: [] as string[],
                truncated: false,
                nextOffset: null,
                offset: request.offset,
                limit: request.limit,
                bytes: 0,
                error: failureOf(source, where)
            };
        });
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
        const existing = await stat(path).catch(() => undefined);

        if (existing === undefined) {
            if (!request.force) {
                throw new HarnessError(
                    `files delete: "${path}" does not exist. Pass force: true when "already gone" is an acceptable answer.`
                );
            }

            return { op, path: toPosixPath(path), removed: false, skipped: true, recursive: request.recursive };
        }

        if (existing.isDirectory() && !request.recursive) {
            // Checked explicitly so the error says what to do, rather than reporting
            // Node's ENOTEMPTY with no instruction.
            throw new HarnessError(
                `files delete: "${path}" is a directory. Pass recursive: true to remove it and everything inside it.`
            );
        }

        try {
            await rm(path, { recursive: request.recursive, force: false });
        } catch (error) {
            throw new HarnessError(`files delete failed on ${path}: ${failureOf(error, path).message}`);
        }

        return { op, path: toPosixPath(path), removed: true, recursive: request.recursive };
    }

    // move | copy
    const fromPath = request.from ?? path;
    const toPath = request.to ?? resolve('.');

    const source = await stat(fromPath).catch(() => undefined);

    if (source === undefined) {
        throw new HarnessError(`files ${op}: source "${fromPath}" does not exist.`);
    }

    const destination = await stat(toPath).catch(() => undefined);

    if (destination !== undefined && !request.overwrite) {
        throw new HarnessError(
            `files ${op}: destination "${toPath}" already exists. Pass overwrite: true to replace it.`
        );
    }

    // Parents of the destination do not exist as often as they do: create them, the
    // way ./write does, rather than costing the caller a round trip.
    await mkdir(dirname(toPath), { recursive: true });

    if (destination !== undefined && request.overwrite) {
        try {
            await rm(toPath, { recursive: true, force: true });
        } catch (error) {
            throw new HarnessError(`files ${op} could not replace ${toPath}: ${failureOf(error, toPath).message}`);
        }
    }

    const kind: 'file' | 'directory' = source.isDirectory() ? 'directory' : 'file';

    if (op === 'copy') {
        let bytes = 0;

        try {
            bytes = kind === 'directory' ? await copyDirectory(fromPath, toPath) : await copyFileWithSize(fromPath, toPath);
        } catch (error) {
            if (error instanceof HarnessError) throw error;

            throw new HarnessError(`files copy failed on ${fromPath} -> ${toPath}: ${failureOf(error, toPath).message}`);
        }

        return { op, path: toPosixPath(fromPath), to: toPosixPath(toPath), kind, bytes };
    }

    try {
        await rename(fromPath, toPath);
    } catch (error) {
        // EXDEV (cross-device) and ENOTEMPTY (a non-empty directory target racing an
        // earlier op) are reported as-is: this tool never turns a rename into a
        // copy-plus-delete behind the caller's back.
        throw new HarnessError(`files move failed on ${fromPath} -> ${toPath}: ${failureOf(error, toPath).message}`);
    }

    return {
        op,
        path: toPosixPath(fromPath),
        to: toPosixPath(toPath),
        kind,
        bytes: kind === 'directory' ? 0 : source.size
    };
};

// Copy one file and report its size, in a single place so the receipt never lies.
const copyFileWithSize = async (fromPath: string, toPath: string): Promise<number> => {
    await copyFile(fromPath, toPath);

    return sizeOf(toPath);
};

// Authoritative registration/details for this preset (T13). ../catalogue projects
// the same data synchronously through the discovered descriptors, and the
// consistency test asserts the two stay equal. Edit the metadata HERE.
export const FILES_METADATA: PresetToolMetadata = {
    name: 'files',
    description:
        'Manage files and folders: list, move, copy, delete, and mkdir in ONE call, applied in the order given. Pass an array of operations, each `{ op, ... }`: list takes `path` (one directory or several, default the working directory) plus `offset`/`limit`; move and copy take `from` and `to` plus `overwrite` (default false, so an existing destination is an EEXIST error, not a silent replace); delete takes `path` plus `recursive` (a non-empty directory without it is refused) and `force` (a missing path becomes `removed: false, skipped: true` instead of an error); mkdir takes `path` and creates missing parents, reporting an existing directory as `created: false`. Returns `{ results, bytes, contentBudget }` with ONE ordered receipt per op: list gives `{ entries, truncated, nextOffset, offset, limit, bytes }` (a page holds at most 200 entries by default, 1000 maximum, and 64 KiB of entry text across the whole call, so pass `nextOffset` back as that entry\'s `offset` for more), move/copy give `{ path, to, kind, bytes }`, delete gives `{ path, removed, recursive }`, and mkdir gives `{ path, created }`. Entry names are prefixed with the directory they came from, directories end with "/", and listings are sorted by code point, so paging is deterministic. Every entry is validated before anything runs, so a malformed call changes nothing; a failing mutation names the ops already applied and there is NO rollback, while a failing list entry reports its own `error: { code, message }` without failing the batch. Cross-device moves report EXDEV rather than copying behind your back. Use read/write/edit for content and glob/grep for searching.',
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
                            description: 'delete: remove a directory and everything under it. Defaults to false.'
                        },
                        force: {
                            type: 'boolean',
                            description:
                                'delete: treat a missing path as done (removed: false, skipped: true) instead of an error. Defaults to false.'
                        },
                        offset: {
                            type: 'integer',
                            minimum: 0,
                            description:
                                'list: 0-based index into the flat entry list. Defaults to 0; pass the previous nextOffset here.'
                        },
                        limit: {
                            type: 'integer',
                            minimum: 1,
                            maximum: 1000,
                            description: 'list: maximum entries in this page, 1-1000. Defaults to 200.'
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
        const prepared = prepareOperations(parameters);

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

            for (const operation of prepared) {
                if (operation.op === 'list') {
                    const listed = await runList(operation);

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
