// todoManage — standalone source entry; state lives in the harness record store.
import type { CoreToolMetadata } from '../core';
import type { ToolContext } from '../types';

export const TODO_MANAGE_NAME = 'todoManage';

// Session todos (R1/R2). Session state, not catalogue state, which is why it is a
// factory closure (../core/todo.ts) rather than a module singleton - but its
// public description and schema are stable, so they are authoritative HERE. The
// `action` enum repeats ../core/todo.ts's ACTIONS list (that module validates and owns
// the order); keep the two in step when adding an action.
export const TODO_MANAGE_METADATA: CoreToolMetadata = {
    name: TODO_MANAGE_NAME,
    description:
        'Manage the todo list for this harness session. Actions: "add" (requires text), "remove" (requires id), "check" (requires id; completed defaults to true, false unchecks), "uncheck" (requires id), and "list". Ids are stable strings returned by "add". The list is shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { todos, counts { total, completed, remaining }, page { offset, limit, hasMore, nextOffset? } } - 20 items by default, at most 100, and a 64 KiB serialized page budget, so pass page.nextOffset back as offset while page.hasMore. Every mutation returns { todo|removed, counts } with NO list, so call "list" to read it. Caps: 200 todos, 4000 characters of text each.',
    tags: ['todo', 'todos', 'task', 'tasks', 'checklist', 'plan'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'remove', 'check', 'uncheck', 'list'],
                description: 'One of: add, remove, check, uncheck, list.'
            },
            text: {
                type: 'string',
                description:
                    'Todo text for "add". Required for that action; trimmed. Maximum 4000 characters.'
            },
            id: {
                type: 'string',
                description: 'Todo id returned by "add". Required for remove/check/uncheck.'
            },
            completed: {
                type: 'boolean',
                description:
                    'For "check" only: true (default) marks complete, false unchecks. "uncheck" is the same as false.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first item. Defaults to 0; use page.nextOffset from the previous page.'
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

export const metadata = TODO_MANAGE_METADATA;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('todoManage requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('todoManage', context);
