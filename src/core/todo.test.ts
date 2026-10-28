// todoTools — the per-harness session todo list (core/todo.ts).
//
// These are unit tests for the factory: exact result envelopes, defaults,
// validation errors, defensive copies, and reset/isolation. The harness
// integration (declaration, turns, shared agents, reserved names) lives in
// src/harness.todo.test.ts.
//
// Design notes:
//   - state lives in the factory closure, so two createTodoTool() calls (and two
//     harnesses) never share todos;
//   - ids are decimal strings, monotonic per instance, and restart at "1" after
//     reset();
//   - every returned todo is a copy.

import { describe, expect, it } from 'vitest';
import { createTodoTool } from './todo';

const empty = {
    todos: [],
    counts: { total: 0, completed: 0, remaining: 0 }
};

describe('createTodoTool', () => {
    it('exposes the exact wire name, core visibility, and todo tags', () => {
        const { tool } = createTodoTool();

        expect(tool.name).toBe('todoTools');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['todo', 'todos', 'task', 'tasks', 'checklist', 'plan']);
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['add', 'remove', 'check', 'uncheck', 'list'],
                    description: 'One of: add, remove, check, uncheck, list.'
                },
                text: {
                    type: 'string',
                    description: 'Todo text for "add". Required for that action; trimmed before storage.'
                },
                id: {
                    type: 'string',
                    description: 'Todo id returned by "add". Required for remove/check/uncheck.'
                },
                completed: {
                    type: 'boolean',
                    description:
                        'For "check" only: true (default) marks complete, false unchecks. "uncheck" is the same as false.'
                }
            },
            required: ['action'],
            additionalProperties: false
        });
    });

    it('starts empty and lists an empty snapshot', async () => {
        const { tool } = createTodoTool();

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('adds trimmed todos with monotonic string ids and useful counts', async () => {
        const { tool } = createTodoTool();

        expect(await tool({ action: 'add', text: '  Draft the plan  ' })).toEqual({
            todos: [{ id: '1', text: 'Draft the plan', completed: false }],
            todo: { id: '1', text: 'Draft the plan', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });

        expect(await tool({ action: 'add', text: 'Write tests' })).toEqual({
            todos: [
                { id: '1', text: 'Draft the plan', completed: false },
                { id: '2', text: 'Write tests', completed: false }
            ],
            todo: { id: '2', text: 'Write tests', completed: false },
            counts: { total: 2, completed: 0, remaining: 2 }
        });
    });

    it('checks by default, unchecks with completed: false, and supports the uncheck alias', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'Ship it' });

        expect(await tool({ action: 'check', id: '1' })).toEqual({
            todos: [{ id: '1', text: 'Ship it', completed: true }],
            todo: { id: '1', text: 'Ship it', completed: true },
            counts: { total: 1, completed: 1, remaining: 0 }
        });

        // `check` + completed:false is the documented alias for unchecking.
        expect(await tool({ action: 'check', id: '1', completed: false })).toEqual({
            todos: [{ id: '1', text: 'Ship it', completed: false }],
            todo: { id: '1', text: 'Ship it', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });

        await tool({ action: 'check', id: '1' });

        // The explicit alias always unchecks.
        expect(await tool({ action: 'uncheck', id: '1' })).toEqual({
            todos: [{ id: '1', text: 'Ship it', completed: false }],
            todo: { id: '1', text: 'Ship it', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('removes one todo and returns the removed item', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'Keep me' });
        await tool({ action: 'add', text: 'Remove me' });

        expect(await tool({ action: 'remove', id: '2' })).toEqual({
            todos: [{ id: '1', text: 'Keep me', completed: false }],
            removed: { id: '2', text: 'Remove me', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('rejects a non-object argument with a readable error', async () => {
        const { tool } = createTodoTool();

        await expect(tool(null as never)).rejects.toThrow(
            'todoTools expects an object with an "action" (add, remove, check, uncheck, list).'
        );
        await expect(tool([] as never)).rejects.toThrow(
            'todoTools expects an object with an "action" (add, remove, check, uncheck, list).'
        );
    });

    it('rejects a missing, unknown, or non-string action', async () => {
        const { tool } = createTodoTool();
        const message = 'todoTools requires "action" to be one of: add, remove, check, uncheck, list.';

        await expect(tool({} as never)).rejects.toThrow(message);
        await expect(tool({ action: 'archive' } as never)).rejects.toThrow(message);
        await expect(tool({ action: 1 } as never)).rejects.toThrow(message);
    });

    it('rejects a missing, blank, or non-string add text without mutating', async () => {
        const { tool } = createTodoTool();
        const message = 'todoTools "add" requires a non-empty "text" string.';

        await expect(tool({ action: 'add' })).rejects.toThrow(message);
        await expect(tool({ action: 'add', text: '   ' })).rejects.toThrow(message);
        await expect(tool({ action: 'add', text: 7 } as never)).rejects.toThrow(
            'todoTools "text" must be a string when provided.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('rejects a missing or blank id for remove/check/uncheck without mutating', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'One' });

        await expect(tool({ action: 'remove' })).rejects.toThrow(
            'todoTools "remove" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'check', id: '  ' })).rejects.toThrow(
            'todoTools "check" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'uncheck' })).rejects.toThrow(
            'todoTools "uncheck" requires a non-empty "id" string.'
        );

        expect(await tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'One', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('rejects an unknown id without mutating or recycling it', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'One' });

        await expect(tool({ action: 'check', id: '99' })).rejects.toThrow(
            'todoTools has no todo with id "99".'
        );
        await expect(tool({ action: 'remove', id: '99' })).rejects.toThrow(
            'todoTools has no todo with id "99".'
        );
        await expect(tool({ action: 'uncheck', id: '99' })).rejects.toThrow(
            'todoTools has no todo with id "99".'
        );

        expect(await tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'One', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('rejects invalid optional field types consistently across actions', async () => {
        const { tool } = createTodoTool();

        await expect(tool({ action: 'list', completed: 'yes' } as never)).rejects.toThrow(
            'todoTools "completed" must be a boolean when provided.'
        );
        await expect(tool({ action: 'remove', id: 1 } as never)).rejects.toThrow(
            'todoTools "id" must be a string when provided.'
        );
        await expect(tool({ action: 'add', text: 'One', id: 1 } as never)).rejects.toThrow(
            'todoTools "id" must be a string when provided.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('returns defensive copies of todos, todo, and removed', async () => {
        const { tool } = createTodoTool();

        const added = await tool({ action: 'add', text: 'Original' });
        added.todos[0].text = 'mutated';
        added.todo!.completed = true;

        const listed = await tool({ action: 'list' });
        listed.todos[0].completed = true;

        const checked = await tool({ action: 'check', id: '1' });
        checked.todo!.text = 'mutated again';

        expect(await tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'Original', completed: true }],
            counts: { total: 1, completed: 1, remaining: 0 }
        });

        const removed = await tool({ action: 'remove', id: '1' });
        removed.removed!.text = 'mutated removal';

        // The removed item is gone from the live list, and mutating the copy
        // could not have changed what was already returned to the caller.
        expect(removed.removed!.text).toBe('mutated removal');
        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('resets the list and the id sequence', async () => {
        const { tool, reset } = createTodoTool();
        await tool({ action: 'add', text: 'One' });
        await tool({ action: 'add', text: 'Two' });

        reset();

        expect(await tool({ action: 'list' })).toEqual(empty);
        expect(await tool({ action: 'add', text: 'Fresh' })).toEqual({
            todos: [{ id: '1', text: 'Fresh', completed: false }],
            todo: { id: '1', text: 'Fresh', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('keeps separate factory instances isolated', async () => {
        const first = createTodoTool();
        const second = createTodoTool();

        await first.tool({ action: 'add', text: 'Only in first' });

        expect(await first.tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'Only in first', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 }
        });
        expect(await second.tool({ action: 'list' })).toEqual(empty);
    });
});
