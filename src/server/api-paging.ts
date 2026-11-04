// T13: the one paging helper every paginated canonical route shares.
//
// WHY (spec `components.parameters.Limit` / `.Cursor`, src/server/harness.swagger.yaml:2887):
//   - the SAME default (25) and maximum (100) apply to every paginated route, so one
//     clamp is the contract, not a per-route invention (`HARNESS_PAGE_LIMIT` is the
//     generated constant the client also uses);
//   - a page that returns exactly `limit` items ALWAYS carries `next_cursor`, "possibly
//     to an empty page" - that is how the end is detected without a total;
//   - a cursor is OPAQUE, issued by the route that accepts it, and an unrecognised or
//     stale one answers 400 naming the parameter, after which the client restarts from
//     the first page.
//
// CURSOR SHAPE (server-private, never a published format):
//   base64url(`<epoch>.<ordinal>`)
//   - `epoch` makes staleness DECIDABLE for free: a cursor carried across a restart is
//     refused with the required 400 instead of silently re-reading page one, which matches
//     the contract's rule that a revision/cursor is only comparable inside one epoch;
//   - `ordinal` is the number of entries already served, which is what every collection
//     here can supply without a total (turn index, roster sequence, message position,
//     event index, catalogue insertion order).
//
// Cross-references:
//   - ../shared/harness-api.ts  — HARNESS_PAGE_LIMIT, PageMeta
//   - ./api-events.ts           — HARNESS_RUNTIME_EPOCH (the epoch half of the token)

import { HARNESS_PAGE_LIMIT } from '../shared/harness-api';
import { HARNESS_RUNTIME_EPOCH } from './api-events';
import { HttpError } from './api-errors';

/** Node-free base64url encode (Buffer is available on every server runtime here). */
const encode = (text: string): string =>
    Buffer.from(text, 'utf8').toString('base64url');

const decode = (token: string): string | undefined => {
    try {
        return Buffer.from(token, 'base64url').toString('utf8');
    } catch {
        // `Buffer.from` rarely throws; a malformed token must become the 400 below.
        return undefined;
    }
};

/** Issue the cursor that addresses "everything before `ordinal` has been served". */
export const encodeCursor = (ordinal: number): string =>
    encode(`${HARNESS_RUNTIME_EPOCH}.${ordinal}`);

/**
 * Resolve a caller-supplied cursor into an ordinal.
 *
 * `cursor` absent/empty means the first page (0). Anything the server did not issue in
 * THIS epoch is a 400 naming `cursor`, exactly as the spec requires: a silent restart on
 * page one would make a client's `next_cursor` loop forever without ever saying why.
 */
export const decodeCursor = (cursor: unknown): number => {
    if (cursor === undefined || cursor === null) return 0;

    if (typeof cursor !== 'string') throw new HttpError(400, 'Query parameter "cursor" must be a string.');

    // The spec caps a cursor at 256 characters; a longer token was not issued here.
    if (cursor.length === 0) return 0;
    if (cursor.length > 256) {
        throw new HttpError(400, 'Query parameter "cursor" is not a cursor this server issued.');
    }

    const text = decode(cursor);

    if (text === undefined) {
        throw new HttpError(400, 'Query parameter "cursor" is not a cursor this server issued.');
    }

    const separator = text.lastIndexOf('.');
    const epoch = separator < 0 ? '' : text.slice(0, separator);
    const ordinalText = separator < 0 ? '' : text.slice(separator + 1);
    const ordinal = Number(ordinalText);

    // Stale (previous epoch), foreign (not our encoding), or negative are one answer:
    // the caller restarts from the first page.
    if (
        epoch !== HARNESS_RUNTIME_EPOCH ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0
    ) {
        throw new HttpError(400, 'Query parameter "cursor" is stale or foreign; restart from the first page.');
    }

    return ordinal;
};

/**
 * Resolve `limit` for any paginated route. An absent limit is the contract default; a
 * non-integer, zero, or over-max value is a 400 naming the parameter (the spec bounds the
 * schema at 1..100, and a schema violation is a 400 on every other surface too).
 */
export const resolveLimit = (limit: unknown): number => {
    if (limit === undefined || limit === null) return HARNESS_PAGE_LIMIT.default;

    if (typeof limit !== 'string' && typeof limit !== 'number') {
        throw new HttpError(400, 'Query parameter "limit" must be an integer between 1 and 100.');
    }

    const value = Number(limit);

    if (!Number.isSafeInteger(value) || value < HARNESS_PAGE_LIMIT.min || value > HARNESS_PAGE_LIMIT.max) {
        throw new HttpError(400, 'Query parameter "limit" must be an integer between 1 and 100.');
    }

    return value;
};

/** A bounded slice: the entries for this page plus whether a next page exists. */
export type PagedSlice<T> = {
    items: T[];
    /** Ordinal of the first entry of the NEXT page, or null when this page ended the collection. */
    next: number | null;
};

/**
 * Slice `[cursor, cursor+limit)` out of an already-materialized ordered list.
 *
 * `total` may be unknown (`-1`), which is the case for the collections that must not be
 * fully counted here; then a page of exactly `limit` items always continues, matching the
 * spec's end-of-collection rule.
 */
export const slicePage = <T>(
    entries: readonly T[],
    cursor: number,
    limit: number,
    total: number = -1
): PagedSlice<T> => {
    const known = total >= 0 ? total : entries.length;
    const items = entries.slice(cursor, cursor + limit);
    const served = cursor + items.length;

    // Exactly-full page => always advertise a next page (the contract's rule), unless the
    // total is known and already reached.
    const hasMore = items.length === limit && (total < 0 || served < known);

    return { items, next: hasMore ? served : null };
};

/** The `PageMeta` every page carries, stamped from the hub revision of that collection. */
export const pageMeta = <T>(
    slice: PagedSlice<T>,
    revision: number
): { limit: number; next_cursor: string | null; observed_at: number; revision: number; items: T[] } => ({
    // `limit` echoes the EFFECTIVE page size (what this page actually carries), which is
    // how a client detects a short final page without comparing against its request.
    limit: slice.items.length,
    next_cursor: slice.next === null ? null : encodeCursor(slice.next),
    observed_at: Date.now(),
    revision,
    items: slice.items
});
