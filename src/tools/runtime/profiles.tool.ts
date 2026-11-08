// profiles — standalone source entry; state lives in the harness record engine.
//
// Renamed from `profileManage` by the records-engine redesign (Decision K: the
// collection key is plural and IDENTICAL to the wrapper's tool name). The entry owns a
// schema and the routed call only — Decision E keeps a wrapper stateless and logic-free,
// which is what makes escalating to `records` an escalation in FREEDOM rather than a
// change of behaviour.
//
// The delta against ./locations.tool.ts is exactly one field, `traits` — the same delta
// the F1 audit measured between the two original store modules.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const PROFILES_NAME = 'profiles';

export const PROFILES_METADATA: CoreToolMetadata = {
    name: PROFILES_NAME,
    description:
        'Manage character and people profiles for this harness session (the `profiles` collection of the session store). Actions: "add" (requires name and description; optional traits and notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, traits, notes; fields you omit are unchanged), and "remove" (requires id). Traits are trimmed and deduplicated, and an empty string clears notes. Ids are stable strings returned by "add", unique across every collection in the session. Profiles are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { profiles, counts { total }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, budgeted below the result cap. "get" and "add"/"update" return { profile, counts } and "remove" returns { removed, counts }, with NO list. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. There are no locks and no claims - any agent on any thread may write any profile - so an update or a removal from an agent MUST send `expects: [{ id, rev }]` with the rev you read; a stale rev rejects the whole call AND returns the current profile, and "mergeDisjoint": true applies your update anyway when the concurrent change touched only fields you left out. Caps: 200 profiles, 200-character names, 4000-character descriptions and notes, up to 32 traits of 200 characters each. If this tool is what stops you, the same records are open through the `records` store tool (tags: records, store, collection).',
    tags: ['profile', 'profiles', 'character', 'characters', 'person', 'people'],
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
                description: 'Profile id returned by "add". Required for get/update/remove.'
            },
            name: {
                type: 'string',
                maxLength: 200,
                description:
                    'Profile name for "add", or a replacement name for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            description: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Profile description for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 4000 characters.'
            },
            traits: {
                type: 'array',
                items: { type: 'string', maxLength: 200 },
                maxItems: 32,
                description:
                    'Optional traits for "add" or "update", e.g. ["brave", "loyal"]. Entries are trimmed and deduplicated; omitting the field leaves traits unchanged on update. At most 32 traits of 200 characters each.'
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
                    'The revisions you READ, one { id, rev } per id this call updates or removes (required for those writes). A rev that no longer matches rejects the call and returns the current profile.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Profile id you read.' },
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
                    'For "list" only: 0-based index of the first profile. Defaults to 0; use page.nextOffset from the previous page.'
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

export const metadata = PROFILES_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`: these
// fields are harness bookkeeping, not part of the Tool wire contract, so they never
// reach the schema a model sees. ../../core/tool-discovery.ts READS this literal
// through the TypeScript AST (it never executes the module), so the activation/order/
// flags here are what actually drive registration.
//
// Order 70 is the historical profileManage row, so the only listing change after the
// rename is the name itself.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 70,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('profiles requires the live harness reference.'))
        : context.harness.runtime.executeRecords(PROFILES_NAME, context);
