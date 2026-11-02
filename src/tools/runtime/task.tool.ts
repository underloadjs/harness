// task — standalone source entry; state lives in the harness record store.
//
// This is the renamed `todoManage` entry (R9-R11). The wire NAME changes; the
// persisted store does not (the harness still saves `records.todos`), and neither
// do the bounds. Historical transcripts that name `todoManage` keep their text:
// restore reads the records, not the old tool name.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const TASK_NAME = 'task';

// Session tasks (R1/R2, renamed and reshaped by R9-R11). Session state, not
// catalogue state, which is why it is a factory closure (../core/task.ts) rather
// than a module singleton - but its public description and schema are stable, so
// they are authoritative HERE. The argument shape below must match the patch
// semantics ../core/task.ts implements and validates (entries with no id add,
// entries with a known id patch, `remove` deletes, and everything is validated
// before the first mutation); keep the two in step when the contract changes.
export const TASK_METADATA: CoreToolMetadata = {
    name: TASK_NAME,
    description:
        'Maintain the task list for this harness session. Call with NO arguments (or {}) to read it. `tasks` is a list of changes: an entry with no "id" ADDS a task and must carry "text"; an entry with a known "id" PATCHES that task and every field it omits stays unchanged. `remove` is a list of task ids to delete. Unknown ids are invalid, an id may not appear twice in `tasks` or in both `tasks` and `remove`, and the whole call is validated before anything changes - so a rejected call leaves the list exactly as it was. Ids are stable strings returned by earlier calls. The list is shared by every agent in this harness, kept across turns, and cleared by reset. EVERY successful call returns the SAME bounded page of the current list: { tasks, counts { total, completed, pending }, page { offset, limit, hasMore, nextOffset? } } - 20 items by default, at most 100, and a 64 KiB serialized page budget, so pass page.nextOffset back as `offset` while page.hasMore, or set `offset`/`limit` to choose the page. Caps: 200 tasks, 4000 characters of text each.',
    tags: ['task', 'tasks', 'todo', 'todos', 'checklist', 'plan'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            tasks: {
                type: 'array',
                description:
                    'Changes to apply, in order. Omit "id" to add a task (its "text" is required); give a known "id" to patch that task, leaving omitted fields unchanged. An empty list is a read.',
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
                    'Exact task ids to delete. Every id must exist; an id may not also appear in "tasks".'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based index of the first returned task. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'Page size, 1-100. Defaults to 20.'
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
