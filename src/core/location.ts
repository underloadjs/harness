// locationManage — the harness session locations/places tracker.
//
// Same lifecycle as todoManage (./todo.ts) and profileManage (./profile.ts):
// factory closure per harness, shared by every agent, stable decimal string ids,
// full validation before any mutation, defensive copies, cleared by reset().
//
// A location is deliberately small (name, description, optional notes), so every
// result carries the full record; there is no summary/body split like chapters.
//
// R9 (tool audit) — bounded results, identical policy in profile/chapter/location:
//   - at most LOCATION_MAX_RECORDS (200) locations may be stored; `add` past the
//     cap is an actionable error, never a silent drop of stored data;
//   - per-field caps: name LOCATION_MAX_NAME (200), description/notes
//     LOCATION_MAX_TEXT (4000) characters. Oversized writes are rejected with the
//     actual size so the model can shorten and retry;
//   - `list` is paginated: `offset` defaults to 0, `limit` defaults to 20 and is
//     hard-capped at 100, and the page stops before the UTF-8 payload exceeds
//     LOCATION_RESPONSE_BUDGET_BYTES (64 KiB). `page.hasMore` /
//     `page.nextOffset` walk every record without gaps;
//   - mutation results return only the changed record and the counts, never the
//     whole store.
//
// ACTIONS (shared by profile/chapter/location):
//   add     — requires name + description; notes optional (defaults to '').
//   list    — one bounded page, in insertion order.
//   get     — one record by id.
//   update  — partial: only the fields present in the arguments change.
//             name/description must stay non-empty; notes may be cleared to ''.
//   remove  — one record by id, returned as `removed`.
//
// Cross-references:
//   - ../types   — LocationItem, LocationParameters, Tool, RecordAction
//   - ./metadata — LOCATION_MANAGE_METADATA (name, description, tags, schema)
//   - ./todo     — the template this factory follows
//   - ../harness — registers the tool as core, reserves the name, resets it
//
// Result contracts (all list-shaped results carry `page`, mutations do not):
//   list                 → { locations, counts, page }
//   add | get | update   → { location, counts }
//   remove               → { removed, counts }

import { HarnessError } from '../util';
import type {
    LocationItem,
    LocationParameters,
    LocationStoreState,
    RecordAction,
    Tool
} from '../types';
import { LOCATION_MANAGE_METADATA } from './metadata';
import { tool } from './tool';
import {
    readSnapshotArray,
    readSnapshotId,
    readSnapshotIdCounter,
    readSnapshotKeys,
    readSnapshotRecord,
    readSnapshotString
} from './snapshot-validation';

// The accepted actions, in the order the error messages and schema advertise
// them. Identical for all three record tools.
const ACTIONS: readonly RecordAction[] = ['add', 'list', 'get', 'update', 'remove'];

const ACTION_HINT = ACTIONS.join(', ');

// The mutable fields an `update` may carry; used to reject an empty update.
const UPDATE_FIELDS = ['name', 'description', 'notes'] as const;

// R9 bounds. Exported so tests (and any UI) assert the exact limits.
export const LOCATION_MAX_RECORDS = 200;
export const LOCATION_MAX_NAME = 200;
export const LOCATION_MAX_TEXT = 4000;
export const LOCATION_LIST_DEFAULT_LIMIT = 20;
export const LOCATION_LIST_MAX_LIMIT = 100;
export const LOCATION_RESPONSE_BUDGET_BYTES = 64 * 1024;

// One page of a bounded list. `nextOffset` is present only when `hasMore`, so a
// caller loops `while (page.hasMore) { list(offset: page.nextOffset) }` and never
// skips records trimmed by the byte budget.
export type LocationPageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
};

// Counts are always derived from the whole store, never from the page.
export type LocationCounts = {
    total: number;
};

// `list` result: the requested page (not a snapshot of the store).
export type LocationListResult = {
    locations: LocationItem[];
    counts: LocationCounts;
    page: LocationPageInfo;
};

// Mutation result: the changed record and the counts. No `locations` array.
export type LocationChangeResult = {
    location?: LocationItem;
    removed?: LocationItem;
    counts: LocationCounts;
};

export type LocationResult = LocationListResult | LocationChangeResult;

// What createLocationTool() returns. Declared here (rather than in ../types)
// because the R9 bounded shape is owned by this module while ../types is shared
// with units still editing the same file; see the final report for the migration.
//
// `snapshot`/`restore` (R3a) are the persistence hooks: a JSON-shaped copy out and
// a fully validated replacement in. They never expose the live arrays.
export type LocationToolset = {
    tool: Tool<LocationParameters, LocationResult>;
    reset: () => void;
    snapshot: () => LocationStoreState;
    restore: (state: unknown) => void;
};

// Arrays are rejected: valid JSON, but it cannot carry an `action`.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Copy on the way out: a caller must never hold a reference into the live list.
const copyLocation = (item: LocationItem): LocationItem => ({
    id: item.id,
    name: item.name,
    description: item.description,
    notes: item.notes
});

const countsOf = (items: readonly LocationItem[]): LocationCounts => ({ total: items.length });

// Read `offset` once, for every action: a negative or fractional cursor is a
// validation error, not a clamp.
const readOffset = (value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new HarnessError(
            'locationManage "offset" must be a non-negative integer when provided.'
        );
    }

    return value as number;
};

// Read `limit` once, for every action. 1..LOCATION_LIST_MAX_LIMIT; a bigger limit
// is rejected (not clamped) so the caller knows its page was not silently shrunk.
const readLimit = (value: unknown): number => {
    if (value === undefined) return LOCATION_LIST_DEFAULT_LIMIT;

    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > LOCATION_LIST_MAX_LIMIT
    ) {
        throw new HarnessError(
            `locationManage "limit" must be an integer between 1 and ${LOCATION_LIST_MAX_LIMIT} when provided.`
        );
    }

    return value as number;
};

// Build one budgeted page from an ordered view of the store:
//   - records are copied first, so the live store is never handed out;
//   - they are added while the serialized UTF-8 size stays inside
//     LOCATION_RESPONSE_BUDGET_BYTES (a comma per record is counted too);
//   - the first record of a non-empty page is always included, so `nextOffset`
//     always advances (no stall, no gaps).
// `hasMore` is computed against the full store length, so a budget-truncated
// page reports the cursor of its last included record rather than offset + limit.
const paginate = (
    items: readonly LocationItem[],
    offset: number,
    limit: number
): { locations: LocationItem[]; page: LocationPageInfo } => {
    const locations: LocationItem[] = [];
    let bytes = 0;

    for (const item of items.slice(offset, offset + limit)) {
        const copy = copyLocation(item);
        const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

        if (locations.length > 0 && bytes + size > LOCATION_RESPONSE_BUDGET_BYTES) break;

        locations.push(copy);
        bytes += size;
    }

    const consumed = offset + locations.length;
    const page: LocationPageInfo = {
        offset,
        limit,
        hasMore: consumed < items.length
    };

    if (page.hasMore) page.nextOffset = consumed;

    return { locations, page };
};

// Validate one persisted location store and return a DEEP COPY. Mirrors
// readTodoStoreState: ids are unique decimal strings, name/description stay
// non-empty, notes may be empty, the record cap holds, and nextId cannot collide.
export const readLocationStoreState = (value: unknown): LocationStoreState => {
    const root = readSnapshotRecord(value, 'location state');
    readSnapshotKeys(root, ['items', 'nextId'], 'location state');

    const entries = readSnapshotArray(root.items, 'location state.items');

    if (entries.length > LOCATION_MAX_RECORDS) {
        throw new HarnessError(
            `location state holds ${entries.length} locations; the maximum is ${LOCATION_MAX_RECORDS}.`
        );
    }

    const items = entries.map((entry, index) => {
        const label = `location state.items[${index}]`;
        const record = readSnapshotRecord(entry, label);
        readSnapshotKeys(record, ['id', 'name', 'description', 'notes'], label);

        return {
            id: readSnapshotId(record.id, `${label}.id`),
            name: readSnapshotString(record.name, `${label}.name`, {
                min: 1,
                max: LOCATION_MAX_NAME
            }),
            description: readSnapshotString(record.description, `${label}.description`, {
                min: 1,
                max: LOCATION_MAX_TEXT
            }),
            notes: readSnapshotString(record.notes, `${label}.notes`, {
                max: LOCATION_MAX_TEXT
            })
        };
    });

    const nextId = readSnapshotIdCounter(
        items.map((item) => item.id),
        root.nextId,
        'location state'
    );

    return { items, nextId };
};

// The per-harness location list. Ids are decimal strings, monotonic for the life
// of this instance, and restart at "1" after reset().
export const createLocationTool = (): LocationToolset => {
    const items: LocationItem[] = [];
    let nextId = 1;

    // Resolve an id for every action that names one, before the lookup, so a
    // missing id is not reported as "not found".
    const requireId = (input: Record<string, unknown>, action: RecordAction): string => {
        const id = input.id;

        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new HarnessError(`locationManage "${action}" requires a non-empty "id" string.`);
        }

        return id;
    };

    // Look up one record without mutating anything.
    const requireItem = (id: string): LocationItem => {
        const item = items.find((candidate) => candidate.id === id);

        if (!item) {
            throw new HarnessError(`locationManage has no location with id "${id}".`);
        }

        return item;
    };

    // A required text field, trimmed, non-empty, and within `max` characters.
    // Missing/blank is reported against the action ("add" or "update") that
    // needed it; an oversized value reports both the length and the limit.
    const requireText = (
        value: unknown,
        action: RecordAction,
        field: string,
        max: number
    ): string => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new HarnessError(
                `locationManage "${action}" requires a non-empty "${field}" string.`
            );
        }

        const text = value.trim();

        if (text.length > max) {
            throw new HarnessError(
                `locationManage "${field}" is ${text.length} characters; the limit is ${max}. Shorten it and retry.`
            );
        }

        return text;
    };

    // An optional text field: absent becomes '', otherwise the trimmed value,
    // still under the same character cap. Notes may be cleared to "".
    const optionalText = (value: unknown, field: string, max: number): string => {
        const text = typeof value === 'string' ? value.trim() : '';

        if (text.length > max) {
            throw new HarnessError(
                `locationManage "${field}" is ${text.length} characters; the limit is ${max}. Shorten it and retry.`
            );
        }

        return text;
    };

    // Name, description, tags, schema, and visibility come from the shared
    // metadata module. Core on purpose, like todoManage.
    const implementation = tool<LocationParameters, LocationResult>({
        name: LOCATION_MANAGE_METADATA.name,
        description: LOCATION_MANAGE_METADATA.description,
        tags: LOCATION_MANAGE_METADATA.tags,
        visibility: LOCATION_MANAGE_METADATA.visibility,
        parameters: LOCATION_MANAGE_METADATA.parameters,
        execute: ({ parameters }) => {
            // A model can pass anything. One readable error for "not an object"
            // lets every action below assume a record.
            if (!isRecord(parameters)) {
                throw new HarnessError(
                    `locationManage expects an object with an "action" (${ACTION_HINT}).`
                );
            }

            const action = parameters.action;

            if (typeof action !== 'string' || !ACTIONS.includes(action as RecordAction)) {
                throw new HarnessError(
                    `locationManage requires "action" to be one of: ${ACTION_HINT}.`
                );
            }

            const resolvedAction = action as RecordAction;

            // Field types are validated once, for every action; wrong types are
            // errors even on list rather than silently ignored fields.
            if (parameters.id !== undefined && typeof parameters.id !== 'string') {
                throw new HarnessError('locationManage "id" must be a string when provided.');
            }

            if (parameters.name !== undefined && typeof parameters.name !== 'string') {
                throw new HarnessError('locationManage "name" must be a string when provided.');
            }

            if (parameters.description !== undefined && typeof parameters.description !== 'string') {
                throw new HarnessError(
                    'locationManage "description" must be a string when provided.'
                );
            }

            if (parameters.notes !== undefined && typeof parameters.notes !== 'string') {
                throw new HarnessError('locationManage "notes" must be a string when provided.');
            }

            // The pagination cursor is validated for every action too, so a
            // stray `limit: 500` on `add` is reported instead of ignored. The
            // schema declares offset/limit (see ./metadata.ts); LocationParameters
            // is read through a raw record because this module's bounded result
            // contract is declared locally (see LocationToolset above).
            const raw = parameters as unknown as Record<string, unknown>;
            const offset = readOffset(raw.offset);
            const limit = readLimit(raw.limit);

            switch (resolvedAction) {
                case 'add': {
                    // Build the whole record before touching the store: any
                    // invalid field means nothing is created and the id is not
                    // consumed.
                    const item: LocationItem = {
                        id: String(nextId),
                        name: requireText(parameters.name, 'add', 'name', LOCATION_MAX_NAME),
                        description: requireText(
                            parameters.description,
                            'add',
                            'description',
                            LOCATION_MAX_TEXT
                        ),
                        notes: optionalText(parameters.notes, 'notes', LOCATION_MAX_TEXT)
                    };

                    // Capacity is checked before the id is consumed: a full store
                    // is an actionable error, and a failed add never burns an id.
                    if (items.length >= LOCATION_MAX_RECORDS) {
                        throw new HarnessError(
                            `locationManage already holds the maximum of ${LOCATION_MAX_RECORDS} locations; remove one before adding another.`
                        );
                    }

                    nextId++;
                    items.push(item);

                    return { location: copyLocation(item), counts: countsOf(items) };
                }

                case 'list': {
                    const { locations, page } = paginate(items, offset, limit);

                    return { locations, counts: countsOf(items), page };
                }

                case 'get': {
                    const item = requireItem(requireId(parameters, resolvedAction));

                    return { location: copyLocation(item), counts: countsOf(items) };
                }

                case 'update': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // Partial update into a patch first, so a later invalid
                    // field cannot leave earlier ones applied.
                    const patch: Partial<LocationItem> = {};

                    if (parameters.name !== undefined) {
                        patch.name = requireText(
                            parameters.name,
                            'update',
                            'name',
                            LOCATION_MAX_NAME
                        );
                    }

                    if (parameters.description !== undefined) {
                        patch.description = requireText(
                            parameters.description,
                            'update',
                            'description',
                            LOCATION_MAX_TEXT
                        );
                    }

                    // Notes may be cleared to "": empty is a valid state.
                    if (parameters.notes !== undefined) {
                        patch.notes = optionalText(parameters.notes, 'notes', LOCATION_MAX_TEXT);
                    }

                    if (Object.keys(patch).length === 0) {
                        throw new HarnessError(
                            `locationManage "update" requires at least one of: ${UPDATE_FIELDS.join(', ')}.`
                        );
                    }

                    Object.assign(item, patch);

                    return { location: copyLocation(item), counts: countsOf(items) };
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`locationManage has no location with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return { removed: copyLocation(removed), counts: countsOf(items) };
                }
            }
        }
    });

    return {
        tool: implementation,
        // Clear the records and restart the id sequence with harness.reset().
        reset: () => {
            items.splice(0, items.length);
            nextId = 1;
        },
        // Copy out so a snapshot never aliases live state.
        snapshot: () => ({
            items: items.map(copyLocation),
            nextId
        }),
        // Validate into copies first, then replace the closure state in one step.
        restore: (state: unknown) => {
            const restored = readLocationStoreState(state);

            items.splice(0, items.length, ...restored.items);
            nextId = restored.nextId;
        }
    };
};
