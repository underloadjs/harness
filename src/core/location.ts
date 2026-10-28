// locationManage — the harness session locations/places tracker.
//
// Same lifecycle as todoManage (./todo.ts) and profileManage (./profile.ts):
// factory closure per harness, shared by every agent, stable decimal string ids,
// full validation before any mutation, defensive copies, cleared by reset().
//
// A location is deliberately small (name, description, optional notes), so every
// result carries the full record; there is no summary/body split like chapters.
//
// ACTIONS (shared by profile/chapter/location):
//   add     — requires name + description; notes optional (defaults to '').
//   list    — the full snapshot, in insertion order.
//   get     — one record by id.
//   update  — partial: only the fields present in the arguments change.
//             name/description must stay non-empty; notes may be cleared to ''.
//   remove  — one record by id, returned as `removed`.
//
// Cross-references:
//   - ../types   — RecordAction, LocationItem, LocationParameters,
//                  LocationResult, LocationToolset
//   - ./metadata — LOCATION_MANAGE_METADATA (name, description, tags, schema)
//   - ./todo     — the template this factory follows
//   - ../harness — registers the tool as core, reserves the name, resets it

import { HarnessError } from '../util';
import type {
    LocationItem,
    LocationParameters,
    LocationResult,
    LocationToolset,
    RecordAction
} from '../types';
import { LOCATION_MANAGE_METADATA } from './metadata';
import { tool } from './tool';

// The accepted actions, in the order the error messages and schema advertise
// them. Identical for all three record tools.
const ACTIONS: readonly RecordAction[] = ['add', 'list', 'get', 'update', 'remove'];

const ACTION_HINT = ACTIONS.join(', ');

// The mutable fields an `update` may carry; used to reject an empty update.
const UPDATE_FIELDS = ['name', 'description', 'notes'] as const;

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

// The result envelope every action returns. `locations` is always the current
// snapshot; `location` is present for add/get/update and `removed` for remove.
const compose = (
    items: readonly LocationItem[],
    extra: { location?: LocationItem; removed?: LocationItem } = {}
): LocationResult => {
    const result: LocationResult = {
        locations: items.map(copyLocation),
        counts: { total: items.length }
    };

    if (extra.location) result.location = copyLocation(extra.location);
    if (extra.removed) result.removed = copyLocation(extra.removed);

    return result;
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

    // A required text field, trimmed. Missing/blank is reported against the
    // action ("add" or "update") that needed it.
    const requireText = (value: unknown, action: RecordAction, field: string): string => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new HarnessError(
                `locationManage "${action}" requires a non-empty "${field}" string.`
            );
        }

        return value.trim();
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

            switch (resolvedAction) {
                case 'add': {
                    // Build the whole record before touching the store: any
                    // invalid field means nothing is created and the id is not
                    // consumed.
                    const item: LocationItem = {
                        id: String(nextId),
                        name: requireText(parameters.name, 'add', 'name'),
                        description: requireText(parameters.description, 'add', 'description'),
                        notes:
                            parameters.notes === undefined ? '' : String(parameters.notes).trim()
                    };

                    nextId++;
                    items.push(item);

                    return compose(items, { location: item });
                }

                case 'list':
                    return compose(items);

                case 'get': {
                    const item = requireItem(requireId(parameters, resolvedAction));

                    return compose(items, { location: item });
                }

                case 'update': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // Partial update into a patch first, so a later invalid
                    // field cannot leave earlier ones applied.
                    const patch: Partial<LocationItem> = {};

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

                    // Notes may be cleared to "": empty is a valid state.
                    if (parameters.notes !== undefined) {
                        patch.notes = String(parameters.notes).trim();
                    }

                    if (Object.keys(patch).length === 0) {
                        throw new HarnessError(
                            `locationManage "update" requires at least one of: ${UPDATE_FIELDS.join(', ')}.`
                        );
                    }

                    Object.assign(item, patch);

                    return compose(items, { location: item });
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`locationManage has no location with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return compose(items, { removed });
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
        }
    };
};
