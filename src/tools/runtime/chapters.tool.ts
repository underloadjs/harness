// chapters — standalone source entry; state lives in the harness record engine.
//
// Renamed from `chapterManage` by the records-engine redesign (Decision K: the
// collection key is plural and IDENTICAL to the wrapper's tool name). The entry holds
// no state and no logic (Decision E): a schema, the collection mapping, and the routed
// call into ../core/records.ts.
//
// The two chapter-specific behaviours are DECLARED in the collection spec
// (../core/chapter.ts), not invented here: `content` only ever rides a single-record
// `get` (lists and mutation results carry summaries), and `order` is the ascending sort
// key, so reordering a chapter is an ordinary update rather than a move action.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const CHAPTERS_NAME = 'chapters';

export const CHAPTERS_METADATA: CoreToolMetadata = {
    name: CHAPTERS_NAME,
    description:
        'Manage the chapter tracker for this harness session (the `chapters` collection of the session store). Actions: "add" (requires title and summary; optional content, status and order), "list", "get" (requires id), "update" (requires id and at least one of title, summary, content, status, order; fields you omit are unchanged), and "remove" (requires id). Status is one of planned, draft or complete and defaults to planned; ids are stable strings returned by "add"; order is an optional integer sort position - a list returns ordered chapters first (ascending) and unordered ones in insertion order, so updating "order" IS the move. Records are shared by every agent in this harness, kept across turns, and cleared by reset. LIST AND MUTATION RESULTS CARRY SUMMARIES, NEVER THE BODY: "content" appears only in "get", so ten chapters never cost ten bodies. "list" returns ONE PAGE: { chapters, counts { total, planned, draft, complete }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, budgeted below the result cap. "get" and "add"/"update" return { chapter, counts } and "remove" returns { removed, counts }, with NO list. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. There are no locks and no claims - any agent on any thread may write any chapter - so an update or a removal from an agent MUST send `expects: [{ id, rev }]` with the rev you read; a stale rev rejects the whole call AND returns the current chapter, and "mergeDisjoint": true applies your patch anyway when the concurrent change touched only fields you left out. Caps: 200 chapters, 200-character titles, 4000-character summary and content. If this tool is what stops you, the same records are open through the `records` store tool (tags: records, store, collection).',
    tags: ['chapter', 'chapters', 'story', 'outline', 'scene', 'writing'],
    // Decision I: searchable, like the other two story collections (F14's split,
    // preserved on purpose rather than by accident).
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
                description: 'Chapter id returned by "add". Required for get/update/remove.'
            },
            title: {
                type: 'string',
                maxLength: 200,
                description:
                    'Chapter title for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            summary: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Chapter summary for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 4000 characters. Lists show this, never the body.'
            },
            content: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Optional chapter body for "add" or "update". Omitting it leaves the stored body unchanged; an empty string clears it. Returned only by "get". Maximum 4000 characters.'
            },
            status: {
                type: 'string',
                enum: ['planned', 'draft', 'complete'],
                description:
                    'Lifecycle state. "add" defaults to planned; omitting it on "update" leaves the state unchanged.'
            },
            order: {
                type: 'integer',
                minimum: -1000000,
                maximum: 1000000,
                description:
                    'Optional sort position for "add" or "update"; a list sorts ordered chapters ascending, then unordered ones by insertion. There is no move action and no way to clear it - set a new value.'
            },
            expects: {
                type: 'array',
                description:
                    'The revisions you READ, one { id, rev } per id this call updates or removes (required for those writes). A rev that no longer matches rejects the call and returns the current chapter.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Chapter id you read.' },
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
                    'For "list" only: 0-based index of the first chapter. Defaults to 0; use page.nextOffset from the previous page.'
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

export const metadata = CHAPTERS_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`: these
// fields are harness bookkeeping, not part of the Tool wire contract, so they never
// reach the schema a model sees. ../../core/tool-discovery.ts READS this literal
// through the TypeScript AST (it never executes the module), so the activation/order/
// flags here are what actually drive registration.
//
// Order 80 is the historical chapterManage row, so the only listing change after the
// rename is the name itself.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 80,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('chapters requires the live harness reference.'))
        : context.harness.runtime.executeRecords(CHAPTERS_NAME, context);
