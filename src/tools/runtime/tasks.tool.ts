// tasks — standalone source entry; state lives in the harness record engine.
//
// Renamed from `task` by the records-engine redesign (Decision J): the TOOL is plural
// because it manages a collection, while the slash command stays singular `/task`
// because the act is one task at a time ("I'm adding a task, not a bunch of tasks").
// The command is a SEPARATE literal in ../core/command-builtins.ts and is NOT renamed.
//
// This entry is the ergonomic door onto the `tasks` collection of the unified store
// (../core/records.ts). It holds no state and no logic of its own (Decision E): a
// schema, the collection mapping, and the routed call. Its historical patch design —
// `tasks[]` mixing adds and patches, `remove[]`, one page back — is the engine's batch
// design, so this wrapper's contract is the engine envelope under the `tasks` key.
//
// Decision P removed `claim`/`release`/`takeover`/`leaseMs`: the lock is gone, every
// patch is accepted unless it is stale, and a stale rejection carries the current
// record. Do not restore those four params.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const TASKS_NAME = 'tasks';

export const TASKS_METADATA: CoreToolMetadata = {
    name: TASKS_NAME,
    // T2.2 SWEEP — same fix as records.tool.ts:32. The paging sentence called `afterId`
    // "the last id of the previous page", which contradicted the reworded param below
    // (`:127`): a keyset walk runs in ID ORDER, which on a `sortable` collection is NOT
    // the page order, and one walk may not mix `offset` and `afterId`. Only that clause
    // changed — `:77`'s ids/`entry` sentence and every other sentence stay verbatim, and
    // this text is pinned by harness.metadata.test.ts and regenerated into
    // core/tool-manifest.ts.
    //
    // Review F2 — that same description stopped short of the two keys the batch projection
    // now answers (R1/T1.1 and its extension, src/core/records.ts:3260-3261): it enumerated
    // `{ tasks, counts, page, storeRev }` and never said `entry`/`removed` exist. Only that
    // envelope clause grew, mirroring `records.tool.ts`'s `entries | entry | removed`; the
    // ids sentence below is still byte-identical (stop-condition 1).
    description:
        'Maintain the task list for this harness session (the `tasks` collection of the session store). Call with NO arguments (or {}) to read it. `tasks` is a list of changes: an entry with no "id" ADDS a task and must carry "text"; an entry with a known "id" PATCHES that task and every field it omits stays unchanged. `remove` is a list of task ids to delete; `ids` reads specific tasks. Unknown ids are invalid, one id may appear in only ONE of `tasks`/`remove`/`ids` per call, and the whole call is validated before anything changes - a rejected call leaves the list exactly as it was. Ids are stable strings returned by earlier calls, and unique across every collection in the session. THE LIST IS SHARED: every agent and thread in this harness writes the same records, and another agent may change one while you work. There are no locks and no claims: any thread may write any task at any time. Each record carries `rev`, its content revision (starts at 1; only a real text/completed change bumps it), plus who last edited it and when. Send `expects: [{ id, rev }]` with the rev you READ for every id you patch or remove - a call from an agent must send it, or the write is refused as a guarded write. If the rev moved, the WHOLE call is rejected AND the refusal returns the CURRENT TASK (its fields and values), so you can retry in one step instead of re-reading; when the concurrent change touched only fields your patch leaves out, pass `mergeDisjoint: true` and your patch applies anyway. EVERY successful call returns the SAME bounded page: { tasks, counts { total, completed, pending }, page { offset, limit, hasMore, nextOffset? or afterId?/nextAfterId?, budgetTruncated? only when the byte budget cut the page short of "limit" }, storeRev, entry? when one record answers, removed? when exactly one record was deleted, removedIds? when two or more were deleted, addedIds? when two or more were created and changedIds? when two or more were changed } - 20 items by default, at most 100, and a serialized page budget below the result cap. Page by `offset`/`limit`, or by `afterId` (an id cursor - the walk runs in ID order, which on a sortable collection is NOT the page order) when tasks may be removed mid-walk, and never mix the two modes inside one walk. Pass `since: storeRev` to also get `changes` with `changesHasMore`/`changesTruncated`/`oldestAvailableRev`: the task events since that revision (add/update/remove) instead of re-reading the list, and the oldest revision the retained window still holds so a truncated feed says where you can resume. Caps: 200 tasks, 4000 characters of text. If this tool is what stops you - a field you cannot name, a cap you need to escape - the same records are open through the `records` store tool (tags: records, store, collection) with no field-level restriction at all.',
    tags: ['task', 'tasks', 'todo', 'todos', 'checklist', 'plan'],
    // Decision I: `tasks` stays CORE. A session plan is useless if the model has to
    // discover its task list before the first turn, so this is the one store tool the
    // demotion list keeps declared (the other three wrappers are searchable).
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            tasks: {
                type: 'array',
                description:
                    'Changes to apply, in order. Omit "id" to add a task (its "text" is required); give a known "id" to patch that task, leaving omitted fields unchanged. An empty list is a read. A patch of an existing id needs its "expects" token.',
                items: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description:
                                'Existing task id to patch. Omit it to add a new task. Unknown ids are rejected.'
                        },
                        text: {
                            type: 'string',
                            description:
                                'Task text: required to add, and an optional rename when patching an "id". Trimmed, maximum 4000 characters, never blank.'
                        },
                        completed: {
                            type: 'boolean',
                            description:
                                'true marks the task done, false reopens it. Omitted leaves the stored flag unchanged.'
                        }
                    },
                    additionalProperties: false
                }
            },
            remove: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Exact task ids to delete. Every id must exist; an id may not also appear in "tasks". A deletion needs its "expects" token.'
            },
            ids: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Task ids to read, for when you want one record rather than a page. One id answers with "entry", several with "entries".'
            },
            expects: {
                type: 'array',
                description:
                    'The revisions you READ, one { id, rev } per id this call patches or removes (required for those writes). A rev that no longer matches rejects the whole call AND returns the current task, so you re-read in the same step rather than overwriting their work; or pass `mergeDisjoint: true` when the concurrent change touched only fields your patch leaves out. An id may carry at most one token.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Task id you read.' },
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
                // M5 — `records.tool.ts` said this and `tasks` did not, so a `storeRev`
                // copied from another collection tripped "ahead of the store" with no hint
                // why. M6 — the cheap poll was undiscoverable: `since` always drags a page,
                // and only `limit` makes it small.
                //
                // 0011 — `changesTruncated` says a gap happened and nothing about where the
                // retained window starts, so the poller had to know the 200-event cap out of
                // band. The engine answers `oldestAvailableRev` beside every feed, and this
                // description has to name it for a model to be able to use it.
                description:
                    'Asks for the task change log after this revision: the result also carries "changes" (at most 50 entries, oldest first) with "changesHasMore", "changesTruncated" and "oldestAvailableRev" - the oldest revision the retained 200-event window still holds. Pass the "storeRev" of your last read. Must not be ahead of the store. `storeRev` is PER COLLECTION - the token you poll with must come from a `tasks` read, never from another collection\'s. `since` always returns a page beside the feed, so poll cheaply with `{ since, limit: 1 }`; the feed itself is unfiltered and can be combined with `ids` but not with `where`.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based index of the first returned task. Defaults to 0; use page.nextOffset from the previous page. Cannot be combined with "afterId".'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                // M1 — the single highest-leverage fact about this tool's cost, and it was
                // not stated: EVERY success echoes a page, a mutation included, and `limit`
                // is what bounds that echo. A rename sent without `limit` returned 20 records
                // (~3,000 chars) where the same rename with `limit: 1` returned ~430.
                // 0008 — the twin of the `records.tool.ts` sentence: the wrapper now
                // answers `addedIds`/`changedIds`/`removedIds` whatever `limit` says
                // (src/core/records.ts, `executeCollection` + the batch projection in
                // `toWrapperResult`), so a multi-record batch no longer has to trade its
                // ids for a small page.
                description:
                    'Page size, 1-100. Defaults to 20. This caps the page EVERY successful call echoes - a mutation included, not just a read - so pass `limit: 1` on any add, patch or remove whose list you do not need: when the call changed exactly ONE record it also arrives in `entry` (a deletion in `removed`) whatever `limit` you sent. A batch that changed SEVERAL records answers with the page instead of `entry`, and it names what it wrote with three id lists that ignore `limit` entirely: `addedIds` for every id it minted, `changedIds` for every id it patched, and `removedIds` for every id it deleted. So `limit: 1` stays the cheap call even for a batch - the ids of your own write arrive whatever the page says, and you never re-read the list to confirm the write landed.'
            },
            afterId: {
                type: 'string',
                pattern: '^[0-9]+$',
                // R2/T2.2 — the old sentence ("the last id of the previous page",
                // "cannot skip or repeat one") is what cost a live session two records:
                // both halves are true only of a page that came FROM keyset mode, and a
                // sortable collection's id order is not its page order. The reworded
                // text states the order the cursor walks, forbids mixing the modes in
                // one walk, and names the complete walk. The trailing sentence is the
                // one the engine already honoured and is kept verbatim.
                description:
                    'Keyset cursor: an id, and the walk it drives runs in ID ORDER - not the page order, which on a collection with a sortable field is a different order. Returns the tasks with a higher id, which cannot skip or repeat one when another agent deletes a record mid-walk, unlike "offset". Never mix the two modes inside one walk: switching from "offset" to "afterId" part-way (or back) can skip or repeat records, so follow one cursor throughout; if you do switch, the only safe cursor is the page.nextAfterId an offset page of a sortable collection sets to the LARGEST id it returned. Walking "afterId" from below the smallest id is the complete walk - ids start at 1, so `afterId: "0"` is that sentinel and walks every task. Sets page.nextAfterId while page.hasMore. The `page.offset` a keyset page echoes is the EFFECTIVE index, informational only: it is not a cursor you can send back beside "afterId".'
            },
            // R7/T7.1 — the engine's list-read filter. Declared here as well because
            // `additionalProperties: false` would otherwise refuse the call before the
            // engine could answer it; the key set stays open because the fields belong to
            // the collection, not to this schema.
            where: {
                type: 'object',
                description:
                    'Equality filter for a list read: { field: value }, AND across the keys. Applied BEFORE ordering and paging, so the page and its cursors move over the matching records and "counts" - facets and total - describe the FILTERED set; an unfiltered read still counts the whole collection. Values are text, integer or boolean; a strings field cannot be filtered. Cannot be combined with "since", because the change feed is the unfiltered log, nor with "ids", which answers with the records it names rather than a filtered page.',
                additionalProperties: { type: ['string', 'integer', 'boolean'] }
            },
            mergeDisjoint: {
                type: 'boolean',
                description:
                    'true applies a stale content patch anyway when every concurrent change since your read touched only fields your patch does not set; an overlapping field still rejects. Never merges a removal.'
            }
        },
        additionalProperties: false
    }
};

export const metadata = TASKS_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`: these
// fields are harness bookkeeping, not part of the Tool wire contract, so they never
// reach the schema a model sees. ../../core/tool-discovery.ts READS this literal
// through the TypeScript AST (it never executes the module), so the activation/order/
// flags here are what actually drive registration.
//
// Still core and still always-declared, and still order 60: the registration and
// declaration sequence stays exactly where `task`'s was, so CORE_ORDER in
// src/harness.records.test.ts changes only in spelling (Decision I).
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 60,
    sessionBound: true,
    alwaysDeclared: true,
    listed: true
} as const;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('tasks requires the live harness reference.'))
        : context.harness.runtime.executeRecords(TASKS_NAME, context);
