// profileManage — the harness session character/people profiles.
//
// Same lifecycle as todoManage (./todo.ts), deliberately:
//   - the store lives in this factory closure, so it is per harness (and
//     therefore per server session), shared by every agent in that harness, and
//     cleared by harness.reset();
//   - actions mutate one record at a time through stable, monotonic decimal
//     string ids, so the model can refer to a profile across turns;
//   - every returned value (the page, the record, the removed record, and the
//     record's traits array) is a defensive copy;
//   - every input problem throws HarnessError before any mutation, so a rejected
//     call is non-destructive and the harness can feed the message back to the
//     model as a recoverable tool result.
//
// R9 (tool audit) — bounded results, identical policy in profile/chapter/location:
//   - at most PROFILE_MAX_RECORDS (200) profiles may be stored; `add` past the
//     cap is an actionable error, never a silent drop of stored data;
//   - per-field caps: name PROFILE_MAX_NAME (200), description/notes
//     PROFILE_MAX_TEXT (4000) characters, traits PROFILE_MAX_TRAITS (32) entries
//     of at most PROFILE_MAX_TRAIT (200) characters. Oversized writes are
//     rejected with the actual size so the model can shorten and retry;
//   - `list` is paginated: `offset` defaults to 0, `limit` defaults to 20 and is
//     hard-capped at 100, and the page also stops before the UTF-8 payload
//     exceeds PROFILE_RESPONSE_BUDGET_BYTES (64 KiB). `page.hasMore` /
//     `page.nextOffset` walk every record without gaps;
//   - mutation results return only the changed record and the counts, never the
//     whole store.
//
// ACTIONS (shared by profile/chapter/location):
//   add     — requires name + description; traits/notes optional.
//   list    — one bounded page, in insertion order.
//   get     — one record by id.
//   update  — partial: only the fields present in the arguments change.
//   remove  — one record by id, returned as `removed`.
//
// Cross-references:
//   - ../types   — ProfileItem, ProfileParameters, Tool, RecordAction
//   - ./metadata — PROFILE_MANAGE_METADATA (name, description, tags, schema)
//   - ./todo     — the template this factory follows
//   - ../harness — registers the tool as core, reserves the name, resets it
//
// Result contracts (all list-shaped results carry `page`, mutations do not):
//   list                 → { profiles, counts, page }
//   add | get | update   → { profile, counts }
//   remove               → { removed, counts }

import { HarnessError } from '../util';
import type { ProfileItem, ProfileParameters, RecordAction, Tool } from '../types';
import { PROFILE_MANAGE_METADATA } from './metadata';
import { tool } from './tool';

// The accepted actions, in the order the error messages and schema advertise
// them. Identical for all three record tools.
const ACTIONS: readonly RecordAction[] = ['add', 'list', 'get', 'update', 'remove'];

const ACTION_HINT = ACTIONS.join(', ');

// The mutable text fields an `update` may carry. Used to reject an update that
// names no field at all, so "I forgot the field" is an error rather than a
// no-op the model might believe changed something.
const UPDATE_FIELDS = ['name', 'description', 'traits', 'notes'] as const;

// R9 bounds. Exported so tests (and any UI) assert the exact limits.
export const PROFILE_MAX_RECORDS = 200;
export const PROFILE_MAX_NAME = 200;
export const PROFILE_MAX_TEXT = 4000;
export const PROFILE_MAX_TRAITS = 32;
export const PROFILE_MAX_TRAIT = 200;
export const PROFILE_LIST_DEFAULT_LIMIT = 20;
export const PROFILE_LIST_MAX_LIMIT = 100;
export const PROFILE_RESPONSE_BUDGET_BYTES = 64 * 1024;

// One page of a bounded list. `nextOffset` is present only when `hasMore`, so a
// caller loops `while (page.hasMore) { list(offset: page.nextOffset) }` and never
// skips records trimmed by the byte budget.
export type ProfilePageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
};

// Counts are always derived from the whole store, never from the page.
export type ProfileCounts = {
    total: number;
};

// `list` result: the requested page (not a snapshot of the store).
export type ProfileListResult = {
    profiles: ProfileItem[];
    counts: ProfileCounts;
    page: ProfilePageInfo;
};

// Mutation result: the changed record and the counts. No `profiles` array.
export type ProfileChangeResult = {
    profile?: ProfileItem;
    removed?: ProfileItem;
    counts: ProfileCounts;
};

export type ProfileResult = ProfileListResult | ProfileChangeResult;

// What createProfileTool() returns. Declared here (rather than in ../types)
// because the R9 bounded shape is owned by this module while ../types is shared
// with units still editing the same file; see the final report for the migration.
export type ProfileToolset = {
    tool: Tool<ProfileParameters, ProfileResult>;
    reset: () => void;
};

// Arrays are rejected: valid JSON, but it cannot carry an `action`, so accepting
// it would make the error less specific than the schema suggests.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Copy on the way out, always. `traits` is copied too: a caller mutating
// `profile.traits.push(...)` must not reach the live store.
const copyProfile = (item: ProfileItem): ProfileItem => ({
    id: item.id,
    name: item.name,
    description: item.description,
    traits: [...item.traits],
    notes: item.notes
});

const countsOf = (items: readonly ProfileItem[]): ProfileCounts => ({ total: items.length });

// Read `offset` once, for every action: a negative or fractional cursor is a
// validation error, not a clamp.
const readOffset = (value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new HarnessError(
            'profileManage "offset" must be a non-negative integer when provided.'
        );
    }

    return value as number;
};

// Read `limit` once, for every action. 1..PROFILE_LIST_MAX_LIMIT; a bigger limit
// is rejected (not clamped) so the caller knows its page was not silently shrunk.
const readLimit = (value: unknown): number => {
    if (value === undefined) return PROFILE_LIST_DEFAULT_LIMIT;

    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > PROFILE_LIST_MAX_LIMIT
    ) {
        throw new HarnessError(
            `profileManage "limit" must be an integer between 1 and ${PROFILE_LIST_MAX_LIMIT} when provided.`
        );
    }

    return value as number;
};

// Build one budgeted page from an ordered view of the store:
//   - records are copied first, so the live store is never handed out;
//   - they are added while the serialized UTF-8 size stays inside
//     PROFILE_RESPONSE_BUDGET_BYTES (a comma per record is counted too);
//   - the first record of a non-empty page is always included, so `nextOffset`
//     always advances (no stall, no gaps).
// `hasMore` is computed against the full store length, so a budget-truncated
// page reports the cursor of its last included record rather than offset + limit.
const paginate = (
    items: readonly ProfileItem[],
    offset: number,
    limit: number
): { profiles: ProfileItem[]; page: ProfilePageInfo } => {
    const profiles: ProfileItem[] = [];
    let bytes = 0;

    for (const item of items.slice(offset, offset + limit)) {
        const copy = copyProfile(item);
        const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

        if (profiles.length > 0 && bytes + size > PROFILE_RESPONSE_BUDGET_BYTES) break;

        profiles.push(copy);
        bytes += size;
    }

    const consumed = offset + profiles.length;
    const page: ProfilePageInfo = {
        offset,
        limit,
        hasMore: consumed < items.length
    };

    if (page.hasMore) page.nextOffset = consumed;

    return { profiles, page };
};

// Read `traits` once, for every action: a wrong type is a validation error even
// on `list`, matching todoManage's up-front field checks. Entries are trimmed,
// deduplicated, and must be non-empty - silently dropping a blank trait would
// make the stored profile differ from what the model sent. `undefined` means the
// caller omitted the field (add defaults to [], update leaves it unchanged).
//
// R9 caps: at most PROFILE_MAX_TRAITS entries (checked on the raw array, before
// deduplication, so a flood of duplicates is rejected too) and each trait at
// most PROFILE_MAX_TRAIT characters. Oversized input is rejected, never trimmed.
const readTraits = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;

    if (!Array.isArray(value)) {
        throw new HarnessError(
            'profileManage "traits" must be an array of non-empty strings when provided.'
        );
    }

    if (value.length > PROFILE_MAX_TRAITS) {
        throw new HarnessError(
            `profileManage "traits" has ${value.length} entries; the limit is ${PROFILE_MAX_TRAITS}.`
        );
    }

    const traits: string[] = [];

    for (const [index, entry] of value.entries()) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
            throw new HarnessError(
                'profileManage "traits" must be an array of non-empty strings when provided.'
            );
        }

        const trait = entry.trim();

        if (trait.length > PROFILE_MAX_TRAIT) {
            throw new HarnessError(
                `profileManage "traits" entry ${index + 1} is ${trait.length} characters; the limit is ${PROFILE_MAX_TRAIT}.`
            );
        }

        if (!traits.includes(trait)) traits.push(trait);
    }

    return traits;
};

// The per-harness profile list. Ids are decimal strings, monotonic for the life
// of this instance, and restart at "1" after reset().
export const createProfileTool = (): ProfileToolset => {
    const items: ProfileItem[] = [];
    let nextId = 1;

    // Resolve an id for every action that names one. A missing, non-string, or
    // blank id is reported before the lookup, so "not found" can never be
    // confused with "you sent nothing".
    const requireId = (input: Record<string, unknown>, action: RecordAction): string => {
        const id = input.id;

        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new HarnessError(`profileManage "${action}" requires a non-empty "id" string.`);
        }

        return id;
    };

    // Look up one record without mutating anything. An unknown id throws; the
    // list stays untouched.
    const requireItem = (id: string): ProfileItem => {
        const item = items.find((candidate) => candidate.id === id);

        if (!item) {
            throw new HarnessError(`profileManage has no profile with id "${id}".`);
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
                `profileManage "${action}" requires a non-empty "${field}" string.`
            );
        }

        const text = value.trim();

        if (text.length > max) {
            throw new HarnessError(
                `profileManage "${field}" is ${text.length} characters; the limit is ${max}. Shorten it and retry.`
            );
        }

        return text;
    };

    // An optional text field: absent (or `undefined`) becomes '', otherwise the
    // trimmed value, still under the same character cap so an update cannot
    // bypass the limit a required field enforces.
    const optionalText = (value: unknown, field: string, max: number): string => {
        const text = typeof value === 'string' ? value.trim() : '';

        if (text.length > max) {
            throw new HarnessError(
                `profileManage "${field}" is ${text.length} characters; the limit is ${max}. Shorten it and retry.`
            );
        }

        return text;
    };

    // Name, description, tags, schema, and visibility come from the shared
    // metadata module so a runtime registration and a catalogue descriptor can
    // never disagree. Core on purpose: profile state is useless if the model has
    // to discover it before its first plan.
    const implementation = tool<ProfileParameters, ProfileResult>({
        name: PROFILE_MANAGE_METADATA.name,
        description: PROFILE_MANAGE_METADATA.description,
        tags: PROFILE_MANAGE_METADATA.tags,
        visibility: PROFILE_MANAGE_METADATA.visibility,
        parameters: PROFILE_MANAGE_METADATA.parameters,
        execute: ({ parameters }) => {
            // A model can pass anything. Keep one readable error for "not an
            // object" so every action below can assume a record.
            if (!isRecord(parameters)) {
                throw new HarnessError(
                    `profileManage expects an object with an "action" (${ACTION_HINT}).`
                );
            }

            const action = parameters.action;

            if (typeof action !== 'string' || !ACTIONS.includes(action as RecordAction)) {
                throw new HarnessError(
                    `profileManage requires "action" to be one of: ${ACTION_HINT}.`
                );
            }

            const resolvedAction = action as RecordAction;

            // Field types are validated once, for every action: `notes: 7` or
            // `id: 1` is a type error even on `list`, rather than a silently
            // ignored field.
            if (parameters.id !== undefined && typeof parameters.id !== 'string') {
                throw new HarnessError('profileManage "id" must be a string when provided.');
            }

            if (parameters.name !== undefined && typeof parameters.name !== 'string') {
                throw new HarnessError('profileManage "name" must be a string when provided.');
            }

            if (parameters.description !== undefined && typeof parameters.description !== 'string') {
                throw new HarnessError(
                    'profileManage "description" must be a string when provided.'
                );
            }

            if (parameters.notes !== undefined && typeof parameters.notes !== 'string') {
                throw new HarnessError('profileManage "notes" must be a string when provided.');
            }

            // Validates the array AND returns the normalized copy used by
            // add/update.
            const traits = readTraits(parameters.traits);

            // The pagination cursor is validated for every action too, so a
            // stray `limit: 500` on `add` is reported instead of ignored. The
            // schema declares offset/limit (see ./metadata.ts); ProfileParameters
            // is read through a raw record because this module's bounded result
            // contract is declared locally (see ProfileToolset above).
            const raw = parameters as unknown as Record<string, unknown>;
            const offset = readOffset(raw.offset);
            const limit = readLimit(raw.limit);

            switch (resolvedAction) {
                case 'add': {
                    // Build the whole record before touching the store: if any
                    // field is invalid, nothing is created and the id is not
                    // consumed.
                    const item: ProfileItem = {
                        id: String(nextId),
                        name: requireText(parameters.name, 'add', 'name', PROFILE_MAX_NAME),
                        description: requireText(
                            parameters.description,
                            'add',
                            'description',
                            PROFILE_MAX_TEXT
                        ),
                        traits: traits ?? [],
                        notes: optionalText(parameters.notes, 'notes', PROFILE_MAX_TEXT)
                    };

                    // Capacity is checked before the id is consumed: a full store
                    // is an actionable error, and a failed add never burns an id.
                    if (items.length >= PROFILE_MAX_RECORDS) {
                        throw new HarnessError(
                            `profileManage already holds the maximum of ${PROFILE_MAX_RECORDS} profiles; remove one before adding another.`
                        );
                    }

                    nextId++;
                    items.push(item);

                    return { profile: copyProfile(item), counts: countsOf(items) };
                }

                case 'list': {
                    const { profiles, page } = paginate(items, offset, limit);

                    return { profiles, counts: countsOf(items), page };
                }

                case 'get': {
                    const item = requireItem(requireId(parameters, resolvedAction));

                    return { profile: copyProfile(item), counts: countsOf(items) };
                }

                case 'update': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // Partial update: only the supplied fields appear in the
                    // patch. Validating into a patch object first keeps the
                    // update atomic - a later field that fails cannot leave the
                    // earlier ones applied.
                    const patch: Partial<ProfileItem> = {};

                    if (parameters.name !== undefined) {
                        patch.name = requireText(
                            parameters.name,
                            'update',
                            'name',
                            PROFILE_MAX_NAME
                        );
                    }

                    if (parameters.description !== undefined) {
                        patch.description = requireText(
                            parameters.description,
                            'update',
                            'description',
                            PROFILE_MAX_TEXT
                        );
                    }

                    if (traits !== undefined) patch.traits = traits;

                    if (parameters.notes !== undefined) {
                        patch.notes = optionalText(parameters.notes, 'notes', PROFILE_MAX_TEXT);
                    }

                    if (Object.keys(patch).length === 0) {
                        throw new HarnessError(
                            `profileManage "update" requires at least one of: ${UPDATE_FIELDS.join(', ')}.`
                        );
                    }

                    Object.assign(item, patch);

                    return { profile: copyProfile(item), counts: countsOf(items) };
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`profileManage has no profile with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return { removed: copyProfile(removed), counts: countsOf(items) };
                }
            }
        }
    });

    return {
        tool: implementation,
        // "Start over": clear the records and restart the id sequence, matching
        // harness.reset()'s contract and todoManage's reset.
        reset: () => {
            items.splice(0, items.length);
            nextId = 1;
        }
    };
};
