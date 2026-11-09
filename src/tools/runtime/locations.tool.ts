// locations — standalone source entry; state lives in the harness record engine.
//
// Renamed from `locationManage` by the records-engine redesign (Decision K: the
// collection key is plural and IDENTICAL to the wrapper's tool name). Like its sibling
// ./profiles.tool.ts it owns only a schema and the routed call; the store, the bounds,
// the revisions and the change window all live once in ../core/records.ts.
//
// The delta against ./profiles.tool.ts is exactly one field, `traits` — the same delta
// the F1 audit measured between the two original store modules.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const LOCATIONS_NAME = 'locations';

export const LOCATIONS_METADATA: CoreToolMetadata = {
    name: LOCATIONS_NAME,
    description:
        'Manage places and settings for this harness session (the `locations` collection of the session store). Actions: "add" (requires name and description; optional notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, notes; fields you omit are unchanged), and "remove" (requires id). Ids are stable strings returned by "add", unique across every collection in the session. Omitting notes on "update" leaves them unchanged; an empty string clears them. Locations are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { locations, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, budgeted below the result cap. "get" and "add"/"update" return { location, counts } and "remove" returns { removed, counts }, with NO list. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. There are no locks and no claims - any agent on any thread may write any location - so an update or a removal from an agent MUST send `expects: [{ id, rev }]` with the rev you read; a stale rev rejects the whole call AND returns the current location, and "mergeDisjoint": true applies your update anyway when the concurrent change touched only fields you left out. Caps: 200 locations, 200-character names, 4000-character descriptions and notes. If this tool is what stops you, the same records are open through the `records` store tool (tags: records, store, collection).',
    tags: ['location', 'locations', 'place', 'places', 'setting', 'settings', 'world'],
    // Decision I: searchable (the historical row's visibility, kept on purpose).
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'get', 'update', 'remove'],
                description: 'One of: add, list, get, update, remove.'
            },
            id: {
                type: 'string',
                description: 'Location id returned by "add". Required for get/update/remove.'
            },
            name: {
                type: 'string',
                maxLength: 200,
                description:
                    'Location name for "add", or a replacement name for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            description: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Location description for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 4000 characters.'
            },
            notes: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Optional free-form notes for "add" or "update". Omitting the field leaves notes unchanged on update; an empty string clears them. Maximum 4000 characters.'
            },
            expects: {
                type: 'array',
                description:
                    'The revisions you READ, one { id, rev } per id this call updates or removes (required for those writes). A rev that no longer matches rejects the call and returns the current location.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Location id you read.' },
                        rev: {
                            type: 'integer',
                            minimum: 1,
                            description:
                                'The "rev" that record had when you read it, copied from an earlier result.'
                        }
                    },
                    required: ['id', 'rev'],
                    additionalProperties: false
                }
            },
            mergeDisjoint: {
                type: 'boolean',
                description:
                    'true applies a stale update anyway when every concurrent change since your read touched only fields your update does not set.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first location. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'For "list" only: page size, 1-100. Defaults to 20.'
            },
            // R7/T7.1 — the engine's list-read filter, forwarded by the wrapper
            // (src/core/records.ts toCollectionInput). Declared here because
            // `additionalProperties: false` would refuse the call before the engine
            // could answer it.
            where: {
                type: 'object',
                description:
                    'For "list" only: equality filter { field: value }, AND across the keys. Applied BEFORE ordering and paging, so the page and its cursors move over the matching records and "counts" - facets and total - describe the FILTERED set; an unfiltered list still counts the whole collection. Any declared field may be filtered. Values are text, integer or boolean and must match the field type.',
                additionalProperties: { type: ['string', 'integer', 'boolean'] }
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const metadata = LOCATIONS_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`: these
// fields are harness bookkeeping, not part of the Tool wire contract, so they never
// reach the schema a model sees. ../../core/tool-discovery.ts READS this literal
// through the TypeScript AST (it never executes the module), so the activation/order/
// flags here are what actually drive registration.
//
// Order 90 is the historical locationManage row, so the only listing change after the
// rename is the name itself.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 90,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('locations requires the live harness reference.'))
        : context.harness.runtime.executeRecords(LOCATIONS_NAME, context);
