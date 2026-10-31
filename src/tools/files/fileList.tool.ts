// fileList — list the immediate entries of one or more directories, PAGE BY PAGE.
//
// WHY AN ARRAY (T14 batching rule, preserved)
// -------------------------------------------
// Surveying a workspace usually means "what is in src, and what is in task?".
// One call with an array answers that; two calls cost two round trips and force
// the caller to stitch the answers together. Every entry is therefore PREFIXED
// with the directory it came from, so two `index.ts` files stay distinguishable
// in one flat list:
//
//     await fileList(['src', 'task']);
//     // { entries: ['src/a.ts', 'src/nested/', 'task/b.ts'], ... }
//
// WHY PAGINATED (this revision)
// -----------------------------
// The old contract returned `string[]` for the WHOLE listing. One `node_modules`
// or build-output directory could therefore produce tens of thousands of entries in
// a single tool response, which is exactly the failure that fileRead's budget
// already prevents on the read side. Every call now returns a bounded WINDOW of the
// flat entry list:
//
//     {
//       entries: string[],      // this page, in deterministic order
//       truncated: boolean,     // more entries exist after this page
//       nextOffset: number | null, // pass as `offset` to get the next page
//       offset: number,         // the offset actually used (default 0)
//       limit: number,          // the limit actually used (default 200)
//       bytes: number,          // UTF-8 bytes of this page's entries
//       contentBudget: number   // fixed aggregate byte cap (64 KiB)
//     }
//
// The flat list — directories in caller order, each listing sorted by code point —
// is what `offset` indexes into. The sequence never depends on the page size, so
// paging with the returned `nextOffset` walks the whole tree exactly once, in order,
// with no duplicates and no gaps. `truncated` is true when entries exist beyond
// `offset + entries.length`; `nextOffset` is then exactly that sum, and null on the
// last page. Two independent bounds can end a page early, and `nextOffset` stays
// correct for both:
//
//   - `limit` entries: default FILE_LIST_DEFAULT_LIMIT (200), hard maximum
//     FILE_LIST_MAX_LIMIT (1000); larger requests are clamped, never rejected;
//   - FILE_LIST_CONTENT_BUDGET (64 KiB) of UTF-8 entry text: a page stops BEFORE the
//     entry that would cross the cap, so it is never partially reported. An entry
//     that is ITSELF bigger than the budget can never be paged at all, so the call
//     is refused with a message naming it (see paginateEntries) instead of returning
//     an empty page whose `nextOffset` never advances.
//
// ARGUMENTS (legacy and object form)
// ----------------------------------
//   fileList(['src'])                            legacy array (offset 0, limit 200)
//   fileList('src')                              legacy single directory (direct call)
//   fileList({ paths: ['src'], offset: 20, limit: 50 })   the object form
//   fileList() / fileList(null) / fileList({})   the working directory, first page
//
// Both forms normalize to one `{ directories, offset, limit }` request. The legacy
// string/array form exists because it is the documented call shape and because the
// single-property rule used to hand `execute` the array itself; it cannot express
// paging, so a caller that needs page 2 uses the object form.
//
// SCHEMA NOTE (T13): FILE_LIST_METADATA below is the authoritative schema — an
// object with three optional properties (`paths` array of strings defaulting to
// ['.'], `offset` integer minimum 0, `limit` integer 1..1000) and NO `required`
// list. ../catalogue.ts projects the same row synchronously for lazy enumeration.
// This implementation accepts that shape and also keeps accepting the legacy
// string/array form so direct callers and existing tests do not need a flag day.
//
// WHAT IS DELIBERATELY UNCHANGED (and distinct from fileGlob)
// -----------------------------------------------------------
//   - nonrecursive: only the immediate entries of each directory. Recursion is
//     fileGlob's job (`fileGlob({ patterns: ['**'] })`); this tool never walks.
//   - directories end with "/" so they are distinguishable from files.
//   - "." contributes no prefix, so the default `paths: ['.']` returns bare entry
//     names.
//   - no sandbox: each directory is resolved against the process working
//     directory and used as given.
//
// ORDERING (what makes paging deterministic)
// ------------------------------------------
// Directories are visited in the order the caller listed them (never re-sorted),
// and each directory's entries are sorted by code point. Same rationale as
// compareNames in ./glob.ts: a localeCompare sort would make the output depend on
// the host's ICU data, and a page boundary would then shift between hosts.
//
// FAILURE SEMANTICS
// -----------------
// `readdir` on a missing or unreadable directory rejects the whole call. There is
// no partial listing, because a partial list that looks complete is worse than a
// clear error. EVERY requested directory is still read, even when the page only
// covers the first one: a directory that does not exist must fail the call rather
// than be silently skipped because it happened to sit past the window. An explicit
// empty array is rejected for the same reason: `[]` would read as "the directory is
// empty".
//
// Executable on its own and registerable on a harness:
//
//     await fileList(['src']);
//     await fileList({ paths: ['.'], offset: 200, limit: 200 });

import { readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import type { PresetToolMetadata } from '../catalogue';

// Page-size and byte bounds. Exported so docs/tests can quote the same numbers the
// implementation enforces (and so a host cannot quietly disagree).
export const FILE_LIST_DEFAULT_LIMIT = 200;
export const FILE_LIST_MAX_LIMIT = 1000;
export const FILE_LIST_CONTENT_BUDGET = 64 * 1024;

// The object form of the request. `paths` keeps the string form accepted for a
// single directory, because a direct caller writes `{ paths: 'src' }` naturally;
// the model-facing schema only ever declares the array.
export type FileListQuery = {
    // Directories to list, in the order their entries are grouped. Defaults to ['.'].
    paths?: string | string[];
    // 0-based index into the deterministic flat entry list. Defaults to 0.
    offset?: number;
    // Maximum entries in this page. Defaults to 200; larger values clamp to 1000.
    limit?: number;
};

// The full argument the implementation accepts: the legacy string/array form (and
// the "no argument box" shapes) as well as the object form above.
//
// `null` and an empty object are accepted as "no preference" (see normalizeRequest):
// they are what a client sends when the argument box is empty, and the documented
// default is the working directory.
export type FileListParameters = string | string[] | FileListQuery | null | undefined;

// One page of the flat entry list.
export type FileListResult = {
    // Entries in this page, already prefixed and sorted (see ORDERING above).
    entries: string[];
    // True when entries exist beyond this page; `nextOffset` then locates them.
    truncated: boolean;
    // Offset to request next, or null when this page reached the end of the list.
    nextOffset: number | null;
    // The offset this page started at (the caller's value, default 0).
    offset: number;
    // The page size actually used (default 200, hard maximum 1000).
    limit: number;
    // UTF-8 bytes of `entries`, the amount charged against the aggregate budget.
    bytes: number;
    // The fixed aggregate content budget this call was subject to. Metadata only.
    contentBudget: number;
};

// A normalized request: everything the listing loop needs, with defaults resolved.
type FileListRequest = {
    directories: string[];
    offset: number;
    limit: number;
};

// Posix separators in every result, on every platform: the model should not have
// to care which OS the harness runs on. Same convention as fileGlob.
const toPosixPath = (value: string): string => value.split(sep).join('/');

// Code-point comparison (see the ORDERING note above). Kept local rather than
// imported from ./glob.ts, which does not export its comparator and whose walker
// this tool must not pull in.
const compareNames = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;

// Validate the directories. The shapes below all mean the same thing:
//
//   undefined  -> ['.']  (the historic default: the working directory)
//   null / {}  -> ['.']  ("no preference": an empty argument box on the wire)
//   'src'      -> ['src'] (direct-call convenience for a single directory)
//   ['src']    -> ['src']
//   []         -> HarnessError (see below)
//   ['src',''] -> HarnessError (a blank entry is a caller mistake, not a request)
//
// An explicit empty array is rejected rather than answered with no entries. A model
// that sends `{"paths": []}` almost certainly meant "no preference", and an empty
// result would let it conclude the directory is empty — a wrong answer is worse
// than an error that names the fix (omit `paths` to list the working directory).
const normalizeDirectories = (paths: unknown): string[] => {
    if (paths === undefined || paths === null) return ['.'];

    if (!Array.isArray(paths) && typeof paths !== 'string') {
        // A number, a boolean, a nested object: a caller mistake. Name the shape
        // instead of coercing it into a directory called "7".
        throw new HarnessError('fileList paths must be non-empty strings.');
    }

    const list = Array.isArray(paths) ? paths : [paths];

    if (list.length === 0) {
        throw new HarnessError(
            'fileList received an empty paths array. Omit paths to list the working directory.'
        );
    }

    for (const path of list) {
        // A non-string (e.g. a model sending 7) would reach readdir as a type
        // error with an unhelpful message; reject it here instead.
        if (typeof path !== 'string' || path.length === 0) {
            throw new HarnessError('fileList paths must be non-empty strings.');
        }

        // NUL cannot exist in a real path and would only confuse the filesystem.
        if (path.includes('\u0000')) {
            throw new HarnessError('fileList paths must not contain NUL characters.');
        }
    }

    return list;
};

// Validate a paging number.
//
// Missing (or null) means "use the default". A present value must be a finite
// number and is then floored and clamped into range rather than rejected: a limit is
// a convenience knob, and a fractional/oversized value has an obvious safe reading.
// A non-number (e.g. the string "200" coming from a query parameter) is a caller
// bug — silently treating it as the default would restart at offset 0 and loop
// forever, so it is reported instead.
const normalizePageNumber = (
    value: unknown,
    name: 'offset' | 'limit',
    fallback: number,
    clamp: (floored: number) => number
): number => {
    if (value === undefined || value === null) return fallback;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new HarnessError(`fileList ${name} must be a number when provided.`);
    }

    return clamp(Math.floor(value));
};

// Normalize every accepted argument shape into one request (see the ARGUMENTS note).
//
// The object branch is deliberately strict about property NAMES: an unknown key is
// reported rather than ignored, because `{ paths: ['src'], offest: 200 }` (a typo)
// would otherwise return page 1 forever while the caller believed it was paging.
const normalizeRequest = (value: unknown): FileListRequest => {
    if (value === undefined || value === null) {
        return { directories: ['.'], offset: 0, limit: FILE_LIST_DEFAULT_LIMIT };
    }

    if (typeof value === 'string' || Array.isArray(value)) {
        return {
            directories: normalizeDirectories(value),
            offset: 0,
            limit: FILE_LIST_DEFAULT_LIMIT
        };
    }

    if (typeof value !== 'object') {
        // A number or a boolean used to fall through the property reads and mean
        // "list the working directory"; that is a wrong answer, so it is rejected.
        throw new HarnessError('fileList expects an array of directories or an object with "paths", "offset", and "limit".');
    }

    const query = value as Record<string, unknown>;
    const keys = Object.keys(query);

    // Only an EMPTY object is a no-argument call.
    if (keys.length === 0) {
        return { directories: ['.'], offset: 0, limit: FILE_LIST_DEFAULT_LIMIT };
    }

    for (const key of keys) {
        if (key !== 'paths' && key !== 'offset' && key !== 'limit') {
            throw new HarnessError(
                'fileList accepts only "paths", "offset", and "limit" in the object form.'
            );
        }
    }

    return {
        directories: normalizeDirectories(query.paths),
        // Negative offsets clamp to 0: a caller asking for "before the start" gets
        // the first page, which is what `nextOffset` arithmetic can produce.
        offset: normalizePageNumber(query.offset, 'offset', 0, (floored) =>
            floored < 0 ? 0 : floored
        ),
        // The hard maximum is a clamp, not an error: asking for 5000 entries is a
        // request for "as much as allowed", and 1000 is the honest answer.
        limit: normalizePageNumber(query.limit, 'limit', FILE_LIST_DEFAULT_LIMIT, (floored) =>
            floored < 1 ? 1 : floored > FILE_LIST_MAX_LIMIT ? FILE_LIST_MAX_LIMIT : floored
        )
    };
};

// Apply the window and the byte budget to a FLAT entry list.
//
// Exported because it is the deterministic heart of the tool: the offset/limit and
// byte-cap arithmetic can be pinned without a filesystem whose path lengths depend
// on the platform. `execute` only builds the flat list and hands it here.
//
// `truncated` is measured against the WHOLE list, not the window: a page cut short
// by the byte budget still reports the truth, and a final page that happens to be
// exactly full reports `truncated: false`. `nextOffset` is always `offset + returned`,
// which is correct for both reasons a page can end early.
//
// IMPOSSIBLE ENTRY (why this throws instead of returning an empty page):
// an entry whose own UTF-8 size exceeds the budget can NEVER be returned, at any
// offset. Stopping the page BEFORE it would report `truncated: true` with
// `nextOffset === offset` and zero entries, i.e. a continuation that never advances —
// an infinite loop a caller cannot escape. Since no honest page can contain it, the
// call is refused and the offending entry is named; the caller can list a deeper
// directory (the prefix is what makes the entry long) or shorten its names.
export const paginateEntries = (
    entries: readonly string[],
    offset: number,
    limit: number
): FileListResult => {
    const window = entries.slice(offset, offset + limit);

    const page: string[] = [];
    let bytes = 0;

    for (const entry of window) {
        const size = Buffer.byteLength(entry, 'utf8');

        // A single entry bigger than the whole budget is unreturnable at any offset;
        // refusing is the only answer that is both bounded and true. Checked before
        // the cumulative test, because at the start of a page `bytes` is 0 and the
        // two conditions coincide.
        if (size > FILE_LIST_CONTENT_BUDGET) {
            throw new HarnessError(
                `fileList entry at offset ${offset + page.length} is ${size} UTF-8 bytes, larger than the ${FILE_LIST_CONTENT_BUDGET}-byte page budget, so it can never be returned. List a deeper directory so the entry prefix is shorter, or shorten the entry's name.`
            );
        }

        // Stop BEFORE the entry that would cross the cap: an entry is never split,
        // and `nextOffset` below resumes at exactly this entry.
        if (bytes + size > FILE_LIST_CONTENT_BUDGET) break;

        page.push(entry);
        bytes += size;
    }

    const consumed = offset + page.length;
    const truncated = consumed < entries.length;

    return {
        entries: page,
        truncated,
        nextOffset: truncated ? consumed : null,
        offset,
        limit,
        bytes,
        contentBudget: FILE_LIST_CONTENT_BUDGET
    };
};

// Authoritative registration/details for this preset (T13): the catalogue keeps
// a synchronous data projection for lazy enumeration and a consistency test
// asserts the two stay equal. Edit the metadata HERE.
export const FILE_LIST_METADATA: PresetToolMetadata = {
    name: 'fileList',
    description:
        'List the immediate entries of one or more directories, non-recursively, ONE PAGE at a time. Every entry is prefixed with the directory it came from (e.g. ["src/a.ts", "src/nested/", "task/b.ts"]), directories end with a trailing slash so they are distinguishable from files, and entries are sorted. Pass several directories to survey them in one call; the default is ["."], which returns bare entry names. The result is { entries, truncated, nextOffset, offset, limit, bytes, contentBudget }: a page holds at most 200 entries by default (maximum 1000) and at most 64 KiB of UTF-8 entry text, so when `truncated` is true pass `nextOffset` back as `offset` to read the rest. A missing or unreadable directory fails the whole call rather than returning a partial list.',
    tags: ['files', 'list', 'filesystem'],
    parameters: {
        type: 'object',
        properties: {
            paths: {
                type: 'array',
                items: { type: 'string' },
                default: ['.'],
                description:
                    'Directories to list, absolute or relative to the working directory, in the order the results are grouped. Defaults to ["."].'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based index into the flat entry list. Defaults to 0; use nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 1000,
                description: 'Maximum entries in this page, 1-1000. Defaults to 200.'
            }
        },
        additionalProperties: false
    }
};

export const fileList = tool<FileListParameters, FileListResult>({
    ...FILE_LIST_METADATA,
    execute: async ({ parameters }) => {
        const { directories, offset, limit } = normalizeRequest(parameters);
        const entries: string[] = [];

        // Sequential on purpose: the flat list is grouped by directory in the
        // caller's order, so a parallel Promise.all would buy nothing and would
        // leave earlier directories read before a later one throws.
        for (const directory of directories) {
            const listing = await readdir(resolve(directory), { withFileTypes: true });

            const names = listing
                .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
                .sort(compareNames);

            for (const name of names) {
                // join() collapses "." and "./src" to "src", keeps a trailing "/"
                // on a directory entry, and joins an absolute path unchanged — so
                // one call produces both the prefix and the entry name.
                //
                // Every entry of every directory is materialized before the window
                // is taken: the offset counts the WHOLE flat list, and reading each
                // directory is also what keeps a missing directory a hard error (see
                // FAILURE SEMANTICS in the header).
                entries.push(toPosixPath(join(directory, name)));
            }
        }

        return paginateEntries(entries, offset, limit);
    }
});
