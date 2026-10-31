// locationManage — standalone source entry; state lives in the harness record store.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const LOCATION_MANAGE_NAME = 'locationManage';

// Session locations/places. Deliberately small: every result carries the whole
// record, so there is no summary/body split.
export const LOCATION_MANAGE_METADATA: CoreToolMetadata = {
    name: LOCATION_MANAGE_NAME,
    description:
        'Manage locations for this harness session. Actions: "add" (requires name and description; optional notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, notes; fields you omit are unchanged), and "remove" (requires id). Ids are stable strings returned by "add". Locations are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { locations, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { location, counts }; "add"/"update" return { location, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 locations, 200-character names, 4000-character descriptions and notes.',
    tags: ['location', 'locations', 'place', 'places', 'setting', 'world'],
    visibility: 'core',
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
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const metadata = LOCATION_MANAGE_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 90,
    sessionBound: true,
    alwaysDeclared: true,
    listed: true
} as const;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('locationManage requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('locationManage', context);
