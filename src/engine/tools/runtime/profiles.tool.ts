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
    // F9 (2026-11-25) — the page-budget sentence used to end "and still capped by the
    // harness's 32,768-byte limit when a tool result is delivered", which named the delivery
    // cap as if it were a SECOND producer-side budget. F7-4 makes it a serve-time clamp at a
    // whole-record boundary (`clampToDeliveryCap`, ../../core/records.ts:739, called from
    // `runCall` at :4953), so the sentence now states BOTH bounds and names the keys that say
    // which one fired (`deliveryBudgetBytes` beside `page.hasMore`/`page.nextOffset`), matching
    // the wording ../tools/runtime/records.tool.ts already carries. Description prose only — no
    // constant, schema entry or behaviour moved here.
    //
    // The sentence also stays free of the substring "time" on purpose: the discovery scorer
    // charges a >=3-char NAME/DESCRIPTION substring as a capability-tag hit
    // (../../core/discovery.ts:128-141) and ../../harness.tool-list.test.ts:640-726 pins that
    // rule, so "SERVE-TIME" would have made this row answer the `time` tag.
    description:
        'Manage character and people profiles for this harness session (the `profiles` collection of the session store). Actions: "add" (requires name and description; optional traits and notes), "list", "get" (requires id), "update" (requires id and at least one of name, description, traits, notes; fields you omit are unchanged), and "remove" (requires id). Traits are trimmed and deduplicated, and an empty string clears notes. Ids are stable strings returned by "add", unique across every collection in the session. Profiles are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { profiles, counts { total }, page { offset, limit, hasMore, nextOffset?, budgetTruncated? only when the byte budget cut the page short of "limit" } } - 20 by default, at most 100, charged against the collection\'s own response budget in one pass over the whole answer, and a SEPARATE bound caps what the harness can deliver: one tool result is held to 32,768 bytes of payload whatever the budget says, so an over-cap answer is trimmed at the delivery seam at a whole-record boundary rather than DISCARDED as a document - it still arrives with `page.hasMore` and `page.nextOffset` pointing at its first withheld row, `page.budgetTruncated`, and `deliveryBudgetBytes: 32768` naming the cap that fired. Raising the response budget cannot lift that cap - only a smaller `limit` can. "get" and "add"/"update" return { profile, counts } and "remove" returns { removed, counts }, with NO list. Any of those answers can also carry `budgetTruncated: true`: the byte budget withholds a BODY rather than truncating one, so a written profile that came back as `{ id, rev }` is a profile this answer had no budget left to echo - not a profile whose fields were cleared - while `get`, the one read that pays for the body, keeps whatever fits the 32,768-byte ceiling the harness applies to one answer: a profile with 32 traits of 200 characters plus two full 4,000-character texts passes that, and then its trailing fields are withheld and named in `fieldsWithheld` - never an empty entry. `traits` is the strings field here: entries that trim onto an earlier entry store once, and an accepted write that dropped entries says how many as `droppedEntries: { traits: N }`. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. There are no locks and no claims - any agent on any thread may write any profile - so an update or a removal from an agent MUST send `expects: [{ id, rev }]` with the rev you read; a stale rev rejects the whole call AND returns the current profile, and "mergeDisjoint": true applies your update anyway when the concurrent change touched only fields you left out. Caps: 200 profiles, 200-character names, 4000-character descriptions and notes, up to 32 traits of 200 characters each (lengths counted as UTF-16 code units, so one astral emoji is 2 of them). If this tool is what stops you, the same records are open through the `records` store tool (tags: records, store, collection).',
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
                    'true applies a stale update anyway when every concurrent change since your read touched only fields your update does not set. It belongs to a PATCH: beside an action that sends none - "list", "get", "remove", or an "add" - the call is refused rather than accepting the flag and doing nothing with it.'
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
            },
            // R7/T7.1 — the engine's list-read filter, forwarded by the wrapper
            // (src/core/records.ts toCollectionInput). Declared here because
            // `additionalProperties: false` would refuse the call before the engine
            // could answer it.
            where: {
                type: 'object',
                description:
                    'For "list" only: equality filter { field: value }, AND across the keys. Applied BEFORE ordering and paging, so the page and its cursors move over the matching records and "counts" - facets and total - describe the FILTERED set; an unfiltered list still counts the whole collection. Any declared field may be filtered. Values are text, integer or boolean and must match the field type; a strings field cannot be filtered.',
                additionalProperties: { type: ['string', 'integer', 'boolean'] }
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
