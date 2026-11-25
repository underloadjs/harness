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
    // T2.2 SWEEP — the paging sentence used to call `afterId` "the last id of the
    // previous page", which contradicted the reworded param below (`:136`): a keyset
    // walk runs in ID ORDER, which on a `sortable` collection is NOT the page order, and
    // one walk may not mix `offset` and `afterId`. Only that clause changed; everything
    // else in this description is regenerated verbatim into core/tool-manifest.ts and is
    // matched by src/harness.test.ts:264/501 (`stringContaining('The one session store'`),
    // so a reword here has to be followed by `npm run tools:manifest`.
    description:
        'The one session store: every record the session keeps, in named collections. Built in: tasks, chapters, profiles, locations. Actions are ONE batch per call, in this fixed apply order: patches, then removals, then additions. `collection` names which collection to operate on and MUST be one that exists - an unknown name is an ERROR naming the defined collections, never an empty list, so a typo cannot read as "nothing stored". `entries` is the batch: an entry with no "id" ADDS a record (every field the collection marks required must be present) and an entry with a known "id" PATCHES it, leaving every field it omits unchanged; `remove` is a list of ids to delete; `ids` reads specific records - a repeated id is read once, `offset`/`limit` page that list rather than the collection, and the bodies it names are charged to the response budget like a page, so a cut `ids` read continues at `offset: page.nextOffset`; with no batch at all the call reads the current page. Pass `define` { name, fields: [{ key, type, ... }] } on its own to register a NEW collection - `define` beside a `collection` is an ERROR, never a merge that discards your `collection`, and a name that already exists is refused rather than merged, `define`d collections are dropped only when empty, and definitions persist across a restart; the answer echoes the spec the engine ACCEPTED as `definition` - validated, with the engine defaults you omitted filled in - so the caps a collection was born with are readable at birth. Pass `drop: true` with a `collection` to remove a `define`d one; the answer confirms it with `dropped: true`, because an empty page alone cannot tell a dropped collection from an empty one. Pass `describe: true` with a `collection` to read that collection\'s OWN definition back - every field with its type, caps, values, default, getOnly, sortable and count facet, plus maxRecords and the page budget - because a `define`d spec is otherwise invisible to the agent that wrote it. With NO `collection` the call lists every defined collection name, so discovery no longer has to trip the unknown-collection error. Every record carries `rev`, its content revision (starts at 1, bumps only when a field actually changes), plus who last edited it and when. EVERY PATCH IS ACCEPTED UNLESS IT IS STALE: there are no locks and no claims, so any agent on any thread may write any record, and the only conflict control is `expects: [{ id, rev }]` with the rev you READ - a call that has an agent identity must send it for every record it patches or removes. It guards a WRITE, so a token for an id the call neither patches nor removes is REFUSED, never ignored, and a read takes none. A stale token rejects the WHOLE call atomically and returns the CURRENT RECORD in the refusal, so you never re-read to recover; when the concurrent change touched only fields your patch leaves out, `mergeDisjoint: true` applies your patch anyway. EVERY success answers with the same envelope: { entries | entry | removed, counts, page { offset, limit, hasMore, nextOffset? or afterId?/nextAfterId?, budgetTruncated? only when the byte budget cut the page short of "limit" }, storeRev, plus the batch receipts `addedIds` / `changedIds` / `noopIds` naming every id the call minted / really patched / no-op patched - each appears whenever the call did that kind of write, at any count, so a one-add-plus-one-patch batch names BOTH ids, and beside the envelope `budgetTruncated: true` whenever the byte budget withheld ANYTHING from this answer rather than only the page - a write echo collapses to `{ id, rev }` and an `ids` read answers with the bodies that fit plus `page.nextOffset`, and a body that is WITHHELD is ABSENT, never emptied, so a record you were not given is not a record that was cleared, and `droppedEntries` { field: count } when an accepted write normalized `strings` input down (entries the caller sent that did not store) } - 20 per page by default, at most 100, charged against the collection\'s own `responseBudgetBytes` in one pass over the whole answer (the page first, then the write echoes). A SEPARATE bound caps what the harness can deliver: one tool result is held to 32,768 bytes of payload whatever your budget says, and an over-cap answer is trimmed at the delivery seam at a whole-record boundary rather than DISCARDED as a document (the generic truncator throws the whole document away instead of cutting it, which would cost you the cursor along with the body), so it still arrives with `page.hasMore` and `page.nextOffset`/`page.nextAfterId` pointing at the first row the cap withheld, `page.budgetTruncated`, `deliveryBudgetBytes: 32768` naming the CAP as the bound that fired, and `fieldsWithheld` { id: [keys] } naming every field key cut out of the one row too big to carry whole. Raising `responseBudgetBytes` cannot lift that cap - only a smaller `limit` can. Page by `offset`/`limit`, or by `afterId` (an id cursor - the walk runs in ID order, which on a collection with a sortable field is NOT the page order) when records may be removed mid-walk, and never mix the two modes inside one walk; ids are unique across ALL collections. Pass `since: storeRev` to also get `changes`, `changesHasMore`, `changesTruncated`, `oldestAvailableRev` and `droppedEvents`: that collection\'s events since a revision (add/update/remove) - an EVENT envelope of ids, field NAMES, revisions and who/when, with no field VALUES, so it replaces the poll for what changed but never the read of what they now say (the values still come from `entries`/`ids`); it also reports the oldest revision its retained 200-event window still holds and exactly how many events between your revision and that floor are gone for good - so a feed that reports `changesTruncated: true` says where the reader can resume AND how much it lost, instead of forcing a full re-read. Caps: 200 records per collection, 4000 characters per text field (counted as UTF-16 code units, so one astral emoji is 2 of them), 32 array entries. A cap the value breaks is named, not guessed at: `field-too-long` for text and for one over-long array entry, `field-too-many-items` for an array whose entries are too many AFTER trimming and de-duplication, and `field-out-of-range` for an integer past its `max`. In a `define` field spec, every option belongs to exactly one type and an option the type cannot use is REFUSED at `define` rather than stored and ignored: `maxLength` is for text and strings, `maxItems` for strings, `max` for integer, `values` for enum, and `sortable` is allowed on one field per collection. This tool is searchable: it can be evicted from your enabled set between turns by the session\'s tool cap, which costs you nothing - call toolRequest with tags like records, store or collection to bring it back. Prefer the named wrappers (tasks, chapters, profiles, locations) when one fits: they cost less context. Use records when a wrapper\'s schema is what stops you.',
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
                    'Record ids to read. One id answers with "entry" and includes fields a page withholds (a chapter body); several answer with "entries". A repeated id is read ONCE, so `["1","1"]` is one record and not two. `offset` and `limit` page THIS list, not the collection: an explicit `limit` caps how many of the ids you named this call answers with, and with no `limit` the whole list is in scope. A multi-id read is charged to the same byte budget as a page, so when the budget cannot pay for every body the answer carries the bodies that fit, `page.hasMore: true`, `page.budgetTruncated: true` and `page.nextOffset` - continue with the SAME call at `offset: page.nextOffset`, which indexes this deduplicated list in the order you named it. A single-id read is never cut by the byte budget, because the first record always fits. One record larger than the 32,768-byte ceiling the harness applies to one tool result - reachable on a `define`d collection: 16 fields at 4,000 characters each is past it - still arrives, with its trailing fields withheld and every withheld key named in `fieldsWithheld` rather than reading as cleared.'
            },
            expects: {
                type: 'array',
                description:
                    'The revisions you READ, one { id, rev } per id this call patches or removes (required for those writes whenever you have an agent identity). A rev that no longer matches rejects the whole call AND returns the current record. Two different facts come back, and only one of them is a conflict: a rev the record has MOVED PAST says "changed since revision N (now M)", names the fields that moved and offers `mergeDisjoint`; a rev HIGHER than the record has ever reached says the record is at revision N and nothing has changed since you read it, because that revision was never reached - re-read the record and send the `rev` you are offered rather than merging.',
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
                // 0011 — `changesTruncated` told a poller THAT it had lost events and
                // nothing about WHERE the retained window starts, so the reader had to know
                // `RECORD_MAX_CHANGES` out of band (and an empty feed said nothing at all).
                // The engine now answers `oldestAvailableRev` beside every feed; the
                // description has to name it or the model cannot use it.
                description:
                    'Asks for that collection\'s change log after this revision: the result also carries "changes" (at most 50 entries, oldest first) with "changesHasMore", "changesTruncated", "oldestAvailableRev" and "droppedEvents" - the oldest revision that collection\'s retained 200-event window still holds, and exactly how many events between your revision and that floor were trimmed away for good. Each entry is an EVENT ENVELOPE, not a diff: `{ rev, id, op, by?, threadId?, at, fields?, itemRev? }` - an `update` names WHICH fields moved in `fields` and never their VALUES, and an `add` or `remove` names nothing beyond the id - so the feed tells you what to re-read, and the values come from the read. There is no separate gap field, by design: `droppedEvents` (what you lost) beside `oldestAvailableRev` (where you resume) IS the disclosure, and a `since` the window still covers reports `droppedEvents: 0` with `changesTruncated: false`. `changesHasMore` is a DIFFERENT flag - the feed was cut at 50 entries or by the page budget, which withholds later events but loses nothing you were owed. (Beside a plain read of one collection, which carries `oldestAvailableRev` but no feed, `droppedEvents` is absent - there is no gap without a `since`.) Pass the "storeRev" of your last read. Each collection keeps its own revision and its own window, so a task reader is never woken by chapter edits - and the token you poll with must therefore come from a read of THIS collection; one copied from another is refused only when it happens to be higher, and otherwise silently reads the wrong window. Must not be ahead of the store. `since` always returns a page beside the feed, so poll cheaply with `{ since, limit: 1 }`; the feed itself is unfiltered and can be combined with `ids` but not with `where`.'
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
                // M1 — every success echoes a page, a mutation included, and `limit` is
                // what bounds that echo; not saying so cost a live session ~3,000 chars
                // for a one-field patch that needed ~430.
                //
                // 0008 — the sentence used to END by telling the caller NOT to shrink
                // `limit` for a batch, because nothing in the answer named what the batch
                // had written. The engine now answers the three id lists
                // (`addedIds`/`changedIds`/`removedIds`) whatever `limit` says, so the
                // cheap `limit: 1` recipe is now the right call for a batch too, and the
                // description says which key carries which ids.
                description:
                    'Page size, 1-100. Defaults to 20. This caps the page EVERY successful call echoes - a mutation included, not just a read - so pass `limit: 1` on any add, patch or remove whose list you do not need: a record the call changed arrives in `entry` whatever `limit` you sent when exactly ONE changed, and EVERY record it deleted arrives in the `removed` array. A batch that changed SEVERAL records answers with the page instead of `entry`, and it names what it wrote with three id lists that ignore `limit` entirely: `addedIds` for every id it minted, `changedIds` for every id it really patched, and `noopIds` for every id whose patch wrote nothing. Each list appears whenever the call did that kind of write, AT ANY COUNT and independently of the others, so a batch of one add plus one patch names BOTH ids - and an id that appears only in `noopIds` wrote nothing and bumped no `rev`. (`removedIds` is the `tasks` wrapper\'s key, not this surface\'s, and keeps its own rule: two or more deletions, where a singular `removed` could not name them all.) So `limit: 1` stays the cheap call even for a batch - the ids of your own write arrive whatever the page says, and you never re-read the collection to confirm the write landed.'
            },
            afterId: {
                type: 'string',
                pattern: '^[0-9]+$',
                // R2/T2.2 — same trap as the `tasks` schema, and the engine surface is
                // the one a caller reaches when it is paging a `define`d collection with
                // a sortable field, i.e. exactly where the two orders diverge.
                description:
                    'Keyset cursor: an id, and the walk it drives runs in ID ORDER - not the page order, which on a collection with a sortable field is a different order. Returns the records of THAT collection with a higher id, which cannot skip or repeat one when another agent deletes a record mid-walk, unlike "offset". Never mix the two modes inside one walk: switching from "offset" to "afterId" part-way (or back) can skip or repeat records, so follow one cursor throughout; if you do switch, the only safe cursor is the page.nextAfterId an offset page of a sortable collection sets to the LARGEST id it returned. Walking "afterId" from below the smallest id is the complete walk - ids start at 1, so `afterId: "0"` is that sentinel and walks every record. Sets page.nextAfterId while page.hasMore. The `page.offset` a keyset page echoes is the EFFECTIVE index, informational only: it is not a cursor you can send back beside "afterId".'
            },
            // R7/T7.1 — the engine accepts a filter on any list read, and the wrapper
            // schema must say so or `additionalProperties: false` refuses the call
            // before the engine ever sees it. The value type is checked engine-side
            // against the DECLARED field, which is why the schema keeps the key open: a
            // `define`d collection's fields are not knowable here.
            where: {
                type: 'object',
                description:
                    'Equality filter for a list read: { field: value }, AND across the keys. Applied BEFORE ordering and paging, so the page and its cursors move over the matching records and "counts" - facets and total - describe the FILTERED set; an unfiltered read still counts the whole collection. Any declared field may be filtered, including a getOnly field a page withholds. Values are text, integer or boolean; an enum value must be one the field declares; a strings field cannot be filtered. Cannot be combined with "since", because the change feed is the unfiltered log of the whole collection, nor with "ids", which answers with the records it names rather than a filtered page.',
                additionalProperties: { type: ['string', 'integer', 'boolean'] }
            },
            // R6/T6.1 — the introspection verb, on the engine surface only: a wrapper
            // already knows its own collection, while `records` is the door an agent
            // walks through for a collection it defined and can no longer describe.
            //
            // Review F5 — "on its own" now means what it says. The engine guard
            // (src/core/records.ts:2928-2959) refuses the three batch keys AND every read
            // control, because a `describe` answer carries the spec and an empty page: a
            // `since`/`offset`/`limit`/`afterId`/`where` beside it was ignored without being
            // validated, so `describe: true, since: 999` used to look like a success.
            describe: {
                type: 'boolean',
                description:
                    'true with a "collection" and nothing else returns that collection\'s own definition: every field with key, type, required, maxLength, maxItems, values, max, default, getOnly, sortable and count, plus maxRecords and responseBudgetBytes. It is the same `definition` object a `define` answer echoes - `describe` is how you read back a collection you registered in an earlier turn. Read on its own - it takes no "entries", "remove", "ids", "since", "offset", "limit", "afterId" or "where" - and it never writes.'
            },
            mergeDisjoint: {
                type: 'boolean',
                description:
                    'true applies a stale content patch anyway when every concurrent change since your read touched only fields your patch does not set; an overlapping field still rejects. Never merges a removal, and it belongs to a PATCH: a call that sends no patch - an `ids` read, a removal, an addition - is refused rather than accepted and ignored, because the flag would be guarding nothing.'
            },
            define: {
                type: 'object',
                description:
                    'Registers a NEW collection, on its own (no other field): a "collection" beside it is an error, never a merge that discards the collection you named. `name` is taken verbatim - plural is recommended, not enforced. `fields` declares each field in the order a page emits it; caps and types are enforced engine-side. A name that already exists is an error, never a redefinition. The answer echoes the spec the engine ACCEPTED as `definition` - validated, with the engine defaults you omitted (`maxRecords`, `responseBudgetBytes`) filled in - so the caps you just created are readable without a second call.',
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
                                        'Character cap for a text field, or per entry for a strings field, counted as UTF-16 CODE UNITS: one astral-plane emoji is 2 of them, so a 4000-unit body holds 2000 emoji. Only valid on a text or strings field - a boolean or enum with `maxLength` is refused at define, not ignored.'
                                },
                                maxItems: {
                                    type: 'integer',
                                    minimum: 1,
                                    maximum: 32,
                                    description:
                                        'How many entries a strings array may carry, counted AFTER trimming and de-duplication - so `["x","x","  x  "]` is 1 entry, and an accepted write that dropped entries reports it as `droppedEntries`. A blank or whitespace-only entry is REFUSED outright (`invalid-field`), never silently dropped or counted. Only valid on a strings field.'
                                },
                                values: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description:
                                        'For an enum: the allowed values, in count order. Only valid on an enum field - `values` beside an integer or text field is refused at define rather than dropped.'
                                },
                                max: {
                                    type: 'integer',
                                    minimum: 1,
                                    description:
                                        'For an integer: the inclusive magnitude bound, checked on the signed value (a `max: 10` field refuses both 99 and -99 with `field-out-of-range`). Only valid on an integer field.'
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
                                        'true on an integer field makes it the collection\'s ascending sort key. At most ONE field per collection may carry it: a second is refused at define naming the field that already holds it, because two sort keys would leave the page order (and every `offset` cursor over it) undefined.'
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
                    },
                    // M10 companion. `describe` REPORTED this number and the snapshot
                    // loader VALIDATED it, but `define` refused it — so the budget that
                    // decides when a page starts dropping records (and when
                    // `page.budgetTruncated` appears) was readable and not writable. Now
                    // settable in the same range a restore must satisfy.
                    // THE LADDER, exactly as the engine implements it (F7-4 restated here,
                    // 2026-11-25, after the text below claimed a relation to the delivery
                    // cap that the numbers do not have):
                    //   1. SETTABLE RANGE 1,024..65,536 — `RECORD_MIN_RESPONSE_BUDGET_BYTES`
                    //      / `RECORD_MAX_RESPONSE_BUDGET_BYTES`, core/records.ts:223-224.
                    //      This schema's `minimum`/`maximum` are those two numbers as
                    //      literals, because this schema IS the wire contract; a number
                    //      outside them is refused by validation, never clamped.
                    //   2. DEFAULT 65,536 — `RECORD_RESPONSE_BUDGET_BYTES` = the max,
                    //      core/records.ts:231. A `define` that names no budget asks for
                    //      64 KiB, and all four built-in collections declare the same.
                    //   3. THE 32,768-BYTE CAP IS A DIFFERENT BOUND, enforced at SERVE TIME,
                    //      not here: `clampToDeliveryCap` (core/records.ts:739) runs on the
                    //      finished answer inside `runCall` (core/records.ts:4953) and trims
                    //      an over-cap answer at a whole-record boundary, recomputing the
                    //      page cursor and marking it `deliveryBudgetBytes: 32768`. The cap
                    //      is `RECORD_DELIVERY_CAP_BYTES` = `MODEL_TOOL_RESULT_BUDGET_BYTES`
                    //      (core/records.ts:236), imported so clamp and guard cannot drift.
                    // F1-6 had LOWERED the ceiling and default to 24,576 to seat them under
                    // that cap; F7-4 restored 65,536 because lowering it refused `define`s
                    // that used to work and rewrote persisted 65,536 documents, and because
                    // a producer-side ceiling cannot substitute for a serve-time cap. The
                    // literals here must keep tracking those three engine constants.
                    responseBudgetBytes: {
                        type: 'integer',
                        minimum: 1024,
                        // F7-4 (2026-11-25): the ceiling is back to the 65,536 this engine
                        // shipped with, so no `define` that used to work is refused and no
                        // persisted 65,536 needs rewriting. Paired with the description text
                        // below, which now states the 65,536 ceiling and the serve-time cap
                        // as the two separate bounds they are.
                        maximum: 65536,
                        description:
                            'Byte allowance for ONE response of this collection, in bytes, charged in one pass over the whole answer rather than per key: the projected page pays first, then the bodies this call echoes back - a singular `entry`, the `removed` bodies, and the records an `ids` read names - so a 1,024-byte budget cannot answer with a page of the same record repeated. Whatever no longer fits is WITHHELD, not truncated: an echo collapses to `{ id, rev }`, an `ids` read stops at the last whole body and hands back `page.nextOffset`, and the answer carries `budgetTruncated: true` beside the envelope plus `page.budgetTruncated` on the page. The FIRST record of each kind always fits, so a budget never returns an empty page or a write with no content. The page alone is measured on its records (the fixed keys of the envelope - `counts`, cursors, `storeRev` - are absorbed by its first-row allowance), while the echoes are charged against the answer as it already stands, page and "since" change feed included, so the two never pay for one record twice. A feed is budgeted inside the page step, which is why a feed-bearing answer can come back a little over this number. Defaults to 65536; outside 1024-65536 is refused, not clamped. The ceiling deliberately sits ABOVE the 32,768 payload bytes the harness delivers for one tool result: this budget is what the store pages by, and an answer still over the cap is trimmed at the delivery seam at a whole-record boundary, so a page sized by a 64 KiB budget still arrives - with `page.hasMore`, `page.nextOffset`/`page.nextAfterId` pointing at the first row it withheld, `page.budgetTruncated`, and `deliveryBudgetBytes: 32768` saying the CAP, not your budget, did the cutting. Raising this number cannot lift the cap; only a smaller `limit` can. A single record larger than the cap arrives with its leading fields and every withheld field key named in `fieldsWithheld`, never as an empty page.'
                    }
                },
                required: ['name', 'fields'],
                additionalProperties: false
            },
            drop: {
                type: 'boolean',
                description:
                    'true with a "collection" removes that collection - only if it is empty and only if an agent defined it. A built-in collection and a non-empty one are refused, because dropping them would delete history. The answer confirms the drop with `dropped: true`, because an empty page alone could not be told from a read of an empty collection.'
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
