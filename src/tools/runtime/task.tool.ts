// task — standalone source entry; state lives in the harness record store.
//
// This is the renamed `todoManage` entry (R9-R11). The wire NAME changes; the
// persisted store does not (the harness still saves `records.todos`), and neither
// do the bounds. Historical transcripts that name `todoManage` keep their text:
// restore reads the records, not the old tool name.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const TASK_NAME = 'task';

// Session tasks (R1/R2, renamed and reshaped by R9-R11; concurrency added by T1).
// Session state, not catalogue state, which is why it is a factory closure
// (../core/task.ts) rather than a module singleton - but its public description
// and schema are stable, so they are authoritative HERE. The argument shape below
// must match the semantics ../core/task.ts implements and validates (entries with
// no id add, entries with a known id patch, `remove` deletes, `claim`/`release`/
// `takeover` move a lease, `expects` is the compare-and-swap token for a guarded
// write, `since` asks for the change feed, `afterId` pages by id, and everything
// is validated before the first mutation); keep the two in step when the contract
// changes. Note that `pattern` on "afterId" is DECLARATIVE: the runtime validator
// (../core/schema-validation.ts) implements type/minimum/maximum/additionalProperties
// but not regex, so ../core/task.ts re-checks the decimal-id rule itself.
export const TASK_METADATA: CoreToolMetadata = {
    name: TASK_NAME,
    description:
        'Maintain the task list for this harness session. Call with NO arguments (or {}) to read it. `tasks` is a list of changes: an entry with no "id" ADDS a task and must carry "text"; an entry with a known "id" PATCHES that task and every field it omits stays unchanged. `remove` is a list of task ids to delete. Unknown ids are invalid, one id may appear in only ONE of `tasks`/`remove`/`claim`/`release`/`takeover` per call, and the whole call is validated before anything changes - a rejected call leaves the list exactly as it was. Ids are stable strings returned by earlier calls. THE LIST IS SHARED: every agent and thread in this harness writes the same records, and another agent may change one while you work. Each record carries `rev`, its content revision (starts at 1; only a real text/completed change bumps it), and who last edited it. Send `expects: [{ id, rev }]` with the rev you READ for every id you patch or remove; if it moved on the WHOLE call is rejected with the current rev and the last editor, so you re-read and retry instead of overwriting their work, or pass `mergeDisjoint: true` when the concurrent change touched only fields your patch leaves out. `claim`/`release`/`takeover` reserve a record while you edit it (`leaseMs`, default 15 minutes): a claimed record refuses other agents\' writes until it is released, taken over, or the lease expires, and claiming never changes `rev`. EVERY successful call returns the SAME bounded page: { tasks, counts { total, completed, pending }, page { offset, limit, hasMore, nextOffset? or afterId?/nextAfterId? }, storeRev } - 20 items by default, at most 100, and a 64 KiB serialized page budget. Page by `offset`/`limit`, or by `afterId` (the last id of the previous page) when records may be removed mid-walk. Pass `since: storeRev` to also get `changes` with `changesHasMore`/`changesTruncated`: the store events since that revision (add/update/remove/claim/release) instead of re-reading the list. Caps: 200 tasks, 4000 characters of text each.',
    tags: ['task', 'tasks', 'todo', 'todos', 'checklist', 'plan'],
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
            expects: {
                type: 'array',
                description:
                    'The revisions you READ, one { id, rev } per id this call patches or removes (required for those writes, optional for "claim"/"release"/"takeover"). A rev that no longer matches rejects the whole call rather than silently dropping the concurrent edit. An id may carry at most one token.',
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
            claim: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Ids to claim for you (your agent + thread) while you work on them. An unowned or expired claim is taken with a lease; re-claiming one you already hold only renews the lease; a live claim by somebody else is rejected. Claims never change "rev".'
            },
            release: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Ids to give back: clears your claim, or an expired claim. An unowned id is a no-op success; another agent\'s live claim is rejected.'
            },
            takeover: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Ids to seize from whoever holds them, live lease or not - the deliberate override, for when the holder is gone. Sets the lease to you.'
            },
            leaseMs: {
                type: 'integer',
                minimum: 60_000,
                maximum: 86_400_000,
                description:
                    'Lease length for "claim"/"takeover", 60000-86400000 ms. Defaults to 900000 (15 minutes).'
            },
            since: {
                type: 'integer',
                minimum: 0,
                description:
                    'Asks for the store change log after this revision: the result also carries "changes" (at most 50 entries, oldest first) with "changesHasMore" and "changesTruncated". Pass the "storeRev" of your last read. Must not be ahead of the store.'
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
                    'Keyset cursor: the last id of the previous page. Returns the records with a higher id, which cannot skip or repeat one when another agent deletes a record mid-walk, unlike "offset". Sets page.nextAfterId while page.hasMore.'
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

export const metadata = TASK_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
//
// Still core and still always-declared (R9-R11): a session plan is useless if the
// model has to discover it before its first turn, and `task` is the one core
// runtime tool the demotion list keeps declared. Order 60 is unchanged, so the
// registration and declaration sequence stays exactly where todoManage's was.
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
        ? Promise.reject(new Error('task requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('task', context);
