// profileManage — the harness session character/people profiles.
//
// Same lifecycle as todoManage (./todo.ts), deliberately:
//   - the store lives in this factory closure, so it is per harness (and
//     therefore per server session), shared by every agent in that harness, and
//     cleared by harness.reset();
//   - actions mutate one record at a time through stable, monotonic decimal
//     string ids, so the model can refer to a profile across turns;
//   - every returned value (the list, the record, the removed record, and the
//     record's traits array) is a defensive copy;
//   - every input problem throws HarnessError before any mutation, so a rejected
//     call is non-destructive and the harness can feed the message back to the
//     model as a recoverable tool result.
//
// ACTIONS (shared by profile/chapter/location):
//   add     — requires name + description; traits/notes optional.
//   list    — the full snapshot, in insertion order.
//   get     — one record by id.
//   update  — partial: only the fields present in the arguments change.
//   remove  — one record by id, returned as `removed`.
//
// Cross-references:
//   - ../types   — ProfileAction/RecordAction, ProfileItem, ProfileParameters,
//                  ProfileResult, ProfileToolset
//   - ./metadata — PROFILE_MANAGE_METADATA (name, description, tags, schema)
//   - ./todo     — the template this factory follows
//   - ../harness — registers the tool as core, reserves the name, resets it

import { HarnessError } from '../util';
import type {
    ProfileItem,
    ProfileParameters,
    ProfileResult,
    ProfileToolset,
    RecordAction
} from '../types';
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

// The result envelope every action returns. `profiles` is always the current
// snapshot; `profile` is present for add/get/update and `removed` for remove.
const compose = (
    items: readonly ProfileItem[],
    extra: { profile?: ProfileItem; removed?: ProfileItem } = {}
): ProfileResult => {
    const result: ProfileResult = {
        profiles: items.map(copyProfile),
        counts: { total: items.length }
    };

    if (extra.profile) result.profile = copyProfile(extra.profile);
    if (extra.removed) result.removed = copyProfile(extra.removed);

    return result;
};

// Read `traits` once, for every action: a wrong type is a validation error even
// on `list`, matching todoManage's up-front field checks. Entries are trimmed,
// deduplicated, and must be non-empty - silently dropping a blank trait would
// make the stored profile differ from what the model sent. `undefined` means the
// caller omitted the field (add defaults to [], update leaves it unchanged).
const readTraits = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;

    if (!Array.isArray(value)) {
        throw new HarnessError(
            'profileManage "traits" must be an array of non-empty strings when provided.'
        );
    }

    const traits: string[] = [];

    for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
            throw new HarnessError(
                'profileManage "traits" must be an array of non-empty strings when provided.'
            );
        }

        const trait = entry.trim();
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

    // A required text field, trimmed. Missing/blank is reported against the
    // action ("add" or "update") that needed it.
    const requireText = (value: unknown, action: RecordAction, field: string): string => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new HarnessError(
                `profileManage "${action}" requires a non-empty "${field}" string.`
            );
        }

        return value.trim();
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

            switch (resolvedAction) {
                case 'add': {
                    // Build the whole record before touching the store: if any
                    // field is invalid, nothing is created and the id is not
                    // consumed.
                    const item: ProfileItem = {
                        id: String(nextId),
                        name: requireText(parameters.name, 'add', 'name'),
                        description: requireText(parameters.description, 'add', 'description'),
                        traits: traits ?? [],
                        notes:
                            parameters.notes === undefined ? '' : String(parameters.notes).trim()
                    };

                    nextId++;
                    items.push(item);

                    return compose(items, { profile: item });
                }

                case 'list':
                    return compose(items);

                case 'get': {
                    const item = requireItem(requireId(parameters, resolvedAction));

                    return compose(items, { profile: item });
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
                        patch.name = requireText(parameters.name, 'update', 'name');
                    }

                    if (parameters.description !== undefined) {
                        patch.description = requireText(
                            parameters.description,
                            'update',
                            'description'
                        );
                    }

                    if (traits !== undefined) patch.traits = traits;

                    if (parameters.notes !== undefined) {
                        patch.notes = String(parameters.notes).trim();
                    }

                    if (Object.keys(patch).length === 0) {
                        throw new HarnessError(
                            `profileManage "update" requires at least one of: ${UPDATE_FIELDS.join(', ')}.`
                        );
                    }

                    Object.assign(item, patch);

                    return compose(items, { profile: item });
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`profileManage has no profile with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return compose(items, { removed });
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
