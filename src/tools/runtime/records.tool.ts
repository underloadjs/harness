// records — the unified session store, standalone source entry (records-engine T2/T3).
//
// The engine lives in ../core/records.ts; this file owns only what a MODEL sees: the
// wire name, the description, the JSON Schema and the registration policy. The entry
// ends by routing the call to the authority through
// `context.harness.runtime.executeRecords(...)` — the ONE way a record tool writes
// (Decision A), because a lane replica's `harness.runtime` is intercepted and answered
// on the canonical harness, so no wrapper body can perform a shared write against a
// private copy of the session (F5's lost-write failure).
//
// WHY THIS TOOL EXISTS AT ALL (R4/R6): `tasks`/`chapters`/`profiles`/`locations` are
// the ergonomic doors — one collection each, their own caps. `records` is the
// escalation surface: any collection, an entry per collection's own field spec, and
// the ability to register a NEW collection with `define`. Anything a wrapper's schema
// refuses, `records` accepts; that is the documented escape hatch, not a workaround.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const RECORDS_NAME = 'records';

// The low-level surface needs a description that teaches three things a wrapper does
// not (T6): what the collections are, that a bad collection name is a LOUD ERROR
// (discovery fuzzing rescues tool names, never parameter values — Decision C), and
// that access to this tool is transient: it is searchable, so the `maxEnabledTools`
// cap can evict it between turns and re-enabling costs nothing (F10).
//
// It must also state the CONFLICT RULE in one line and must NOT advertise claim verbs:
// Decision P deleted the lock, and an agent that reads a description listing locks
// will try to take one.
export const RECORDS_METADATA: CoreToolMetadata = {
    name: RECORDS_NAME,
    description:
        'The one session store: every record the session keeps, in named collections. Built in: tasks, chapters, profiles, locations. Actions are ONE batch per call, in this fixed apply order: patches, then removals, then additions. `collection` names which collection to operate on and MUST be one that exists - an unknown name is an ERROR naming the defined collections, never an empty list, so a typo cannot read as "nothing stored". `entries` is the batch: an entry with no "id" ADDS a record (every field the collection marks required must be present) and an entry with a known "id" PATCHES it, leaving every field it omits unchanged; `remove` is a list of ids to delete; `ids` reads specific records; with no batch at all the call reads the current page. Pass `define` { name, fields: [{ key, type, ... }] } on its own to register a NEW collection - a name that already exists is refused rather than merged, `define`d collections are dropped only when empty, and definitions persist across a restart. Pass `drop: true` with a `collection` to remove a `define`d one. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. EVERY PATCH IS ACCEPTED UNLESS IT IS STALE: there are no locks and no claims, so any agent on any thread may write any record, and the only conflict control is `expects: [{ id, rev }]` with the rev you READ - a call that has an agent identity must send it for every record it patches or removes. A stale token rejects the WHOLE call atomically and returns the CURRENT RECORD in the refusal, so you never re-read to recover; when the concurrent change touched only fields your patch leaves out, `mergeDisjoint: true` applies your patch anyway. EVERY success answers with the same envelope: { entries | entry | removed, counts, page { offset, limit, hasMore, nextOffset? or afterId?/nextAfterId? }, storeRev } - 20 per page by default, at most 100, budgeted well below the result cap. Page by `offset`/`limit`, or by `afterId` (the last id of the previous page) when records may be removed mid-walk; ids are unique across ALL collections. Pass `since: storeRev` to also get `changes`, `changesHasMore` and `changesTruncated`: that collection\'s events since a revision (add/update/remove) instead of re-reading it. Caps: 200 records per collection, 4000 characters per text field, 32 array entries. This tool is searchable: it can be evicted from your enabled set between turns by the session\'s tool cap, which costs you nothing - call toolRequest with tags like records, store or collection to bring it back. Prefer the named wrappers (tasks, chapters, profiles, locations) when one fits: they cost less context. Use records when a wrapper\'s schema is what stops you.',
    // Narrowed deliberately (round 8, after harness.records.test.ts pinned a
    // 'profile' query enabling `records`): the collection words — tasks/chapters/
    // profiles/locations and their shapes — are the WRAPPERS' tags, and a wrapper is
    // the door an agent walks through for one store. `records` is the escalation
    // surface, reached by the words that describe the ENGINE: the store, a record, an
    // entry, a defined collection. Adding collection nouns here would shadow every
    // wrapper's tag set and pull the low-level engine into requests that never need it.
    tags: ['records', 'record', 'store', 'entries', 'define'],
    // R4: searchable, not core. The powerful low-level surface costs context only for
    // an agent that asks for it, while the ergonomic wrappers stay in the bootstrap.
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            collection: {
                type: 'string',
                description:
                    'The collection to operate on: tasks, chapters, profiles, locations, or any collection this session defined. A string, not an enum, so a defined collection is reachable; the engine validates it BEFORE dispatch and refuses an unknown name naming what exists.'
            },
            entries: {
                type: 'array',
                description:
                    'The batch: an entry with no "id" adds, an entry with a known "id" patches that record and every field it omits stays unchanged. Fields come from the collection\'s spec, so any field name is allowed here.',
                items: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description:
                                'Existing record id to patch. Omit it to add a new record. Unknown ids are rejected.'
                        }
                    },
                    // The field set belongs to the COLLECTION, not to this schema - and
                    // an unknown field is refused engine-side, where the collection spec
                    // is known (../core/records.ts readEntryInput).
                    required: [],
                    additionalProperties: true
                }
            },
            remove: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Exact record ids to delete. Every id must exist, and an id may not also appear in "entries". A deletion needs its "expects" token.'
            },
            ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Record ids to read. One id answers with "entry" and includes fields a page withholds (a chapter body); several answer with "entries".'
            },
            expects: {
                type: 'array',
                description:
                    'The revisions you READ, one { id, rev } per id this call patches or removes (required for those writes whenever you have an agent identity). A rev that no longer matches rejects the whole call AND returns the current record.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Record id you read.' },
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
            since: {
                type: 'integer',
                minimum: 0,
                description:
                    'Asks for that collection\'s change log after this revision: the result also carries "changes" (at most 50 entries, oldest first) with "changesHasMore" and "changesTruncated". Pass the "storeRev" of your last read. Each collection keeps its own revision and its own window, so a task reader is never woken by chapter edits. Must not be ahead of the store.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based index of the first returned record. Defaults to 0; use page.nextOffset from the previous page. Cannot be combined with "afterId".'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'Page size, 1-100. Defaults to 20.'
            },
            afterId: {
                type: 'string',
                pattern: '^[0-9]+$',
                description:
                    'Keyset cursor: the last id of the previous page. Returns the records of THAT collection with a higher id, which cannot skip or repeat one when another agent deletes a record mid-walk, unlike "offset". Sets page.nextAfterId while page.hasMore.'
            },
            mergeDisjoint: {
                type: 'boolean',
                description:
                    'true applies a stale content patch anyway when every concurrent change since your read touched only fields your patch does not set; an overlapping field still rejects. Never merges a removal.'
            },
            define: {
                type: 'object',
                description:
                    'Registers a NEW collection, on its own (no other field). `name` is taken verbatim - plural is recommended, not enforced. `fields` declares each field in the order a page emits it; caps and types are enforced engine-side. A name that already exists is an error, never a redefinition.',
                properties: {
                    name: {
                        type: 'string',
                        maxLength: 200,
                        description: 'The collection name, e.g. "notes" or "locations".'
                    },
                    fields: {
                        type: 'array',
                        maxItems: 16,
                        description:
                            'The field spec, in canonical order. At least one field.',
                        items: {
                            type: 'object',
                            properties: {
                                key: {
                                    type: 'string',
                                    description:
                                        'Field name. Never id, rev, updatedBy, updatedThreadId or updatedAt - the entry owns those.'
                                },
                                type: {
                                    type: 'string',
                                    enum: ['text', 'boolean', 'integer', 'enum', 'strings'],
                                    description: 'The value type this field holds.'
                                },
                                required: {
                                    type: 'boolean',
                                    description:
                                        'true means an ADD must supply it (non-empty for text).'
                                },
                                maxLength: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 4000,
                                    description:
                                        'Character cap for a text field, or per entry for a strings field.'
                                },
                                maxItems: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 32,
                                    description: 'How many entries a strings array may carry.'
                                },
                                values: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'For an enum: the allowed values, in count order.'
                                },
                                max: {
                                    type: 'integer',
                                    minimum: 1,
                                    description: 'For an integer: the inclusive magnitude bound.'
                                },
                                default: {
                                    description:
                                        'The value an ADD stores when the caller omits the field.'
                                },
                                getOnly: {
                                    type: 'boolean',
                                    description:
                                        'true withholds the field from pages and mutation results; only a single-record read returns it (a chapter body).'
                                },
                                sortable: {
                                    type: 'boolean',
                                    description:
                                        'true on an integer field makes it the collection\'s ascending sort key.'
                                },
                                count: {
                                    description:
                                        'Count facets derived from the whole collection: true on an enum (one count per value), or { key, complement } on a boolean.'
                                }
                            },
                            required: ['key', 'type'],
                            additionalProperties: false
                        }
                    },
                    maxRecords: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 200,
                        description:
                            'Store bound for the collection. Defaults to 200; a larger number is refused, not clamped.'
                    }
                },
                required: ['name', 'fields'],
                additionalProperties: false
            },
            drop: {
                type: 'boolean',
                description:
                    'true with a "collection" removes that collection - only if it is empty and only if an agent defined it. A built-in collection and a non-empty one are refused, because dropping them would delete history.'
            }
        },
        additionalProperties: false
    }
};

export const metadata = RECORDS_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`: these
// fields are harness bookkeeping, not part of the Tool wire contract, so they never
// reach the schema a model sees. ../../core/tool-discovery.ts READS this literal
// through the TypeScript AST (it never executes the module), so the activation/order/
// flags here are what actually drive registration.
//
// Order 55 puts the engine just ahead of its wrappers in the inventory, which is the
// reading an operator wants when listing /tools: the store first, then the doors.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 55,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

// The routed write (Decision A). `records` names its own collection in its arguments,
// so the engine's dispatch is a plain pass-through of this context - and in worker mode
// the AUTHORITY performs the call, resolving the caller from the name the lane reported.
export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('records requires the live harness reference.'))
        : context.harness.runtime.executeRecords(RECORDS_NAME, context);
