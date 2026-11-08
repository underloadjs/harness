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
    description:
        'Maintain the task list for this harness session (the `tasks` collection of the session store). Call with NO arguments (or {}) to read it. `tasks` is a list of changes: an entry with no "id" ADDS a task and must carry "text"; an entry with a known "id" PATCHES that task and every field it omits stays unchanged. `remove` is a list of task ids to delete; `ids` reads specific tasks. Unknown ids are invalid, one id may appear in only ONE of `tasks`/`remove`/`ids` per call, and the whole call is validated before anything changes - a rejected call leaves the list exactly as it was. Ids are stable strings returned by earlier calls, and unique across every collection in the session. THE LIST IS SHARED: every agent and thread in this harness writes the same records, and another agent may change one while you work. There are no locks and no claims: any thread may write any task at any time. Each record carries `rev`, its content revision (starts at 1; only a real text/completed change bumps it), plus who last edited it and when. Send `expects: [{ id, rev }]` with the rev you READ for every id you patch or remove - a call from an agent must send it, or the write is refused as a guarded write. If the rev moved, the WHOLE call is rejected AND the refusal returns the CURRENT TASK (its fields and values), so you can retry in one step instead of re-reading; when the concurrent change touched only fields your patch leaves out, pass `mergeDisjoint: true` and your patch applies anyway. EVERY successful call returns the SAME bounded page: { tasks, counts { total, completed, pending }, page { offset, limit, hasMore, nextOffset? or afterId?/nextAfterId? }, storeRev } - 20 items by default, at most 100, and a serialized page budget below the result cap. Page by `offset`/`limit`, or by `afterId` (the last id of the previous page) when tasks may be removed mid-walk. Pass `since: storeRev` to also get `changes` with `changesHasMore`/`changesTruncated`: the task events since that revision (add/update/remove) instead of re-reading the list. Caps: 200 tasks, 4000 characters of text. If this tool is what stops you - a field you cannot name, a cap you need to escape - the same records are open through the `records` store tool (tags: records, store, collection) with no field-level restriction at all.',
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
                description:
                    'Asks for the task change log after this revision: the result also carries "changes" (at most 50 entries, oldest first) with "changesHasMore" and "changesTruncated". Pass the "storeRev" of your last read. Must not be ahead of the store.'
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
                description: 'Page size, 1-100. Defaults to 20.'
            },
            afterId: {
                type: 'string',
                pattern: '^[0-9]+$',
                description:
                    'Keyset cursor: the last id of the previous page. Returns the tasks with a higher id, which cannot skip or repeat one when another agent deletes a record mid-walk, unlike "offset". Sets page.nextAfterId while page.hasMore.'
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
