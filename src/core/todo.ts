// todoTools — the harness session todo list.
//
// This is a harness-specific core tool, not a port of OpenCode's `todowrite`.
// The differences are deliberate and documented in README.md / knowledge.md:
//   - incremental actions (add/remove/check/uncheck/list) instead of replacing
//     the whole list on every call;
//   - stable per-session string ids, so the model can refer to one item across
//     turns without repeating its text;
//   - the list lives in this closure, not in the transcript, so a `list` call is
//     cheap and the result carries counts.
//
// Why a factory instead of a module-level tool: state must be per harness (and
// therefore per server session), shared by every agent in that harness, and
// cleared by `harness.reset()`. A module singleton would leak todos between
// sessions. `createTodoTool()` builds a closed-over list and returns both the
// tool and the reset hook the harness stores with its own handle.
//
// OpenCode reference (dev HEAD fd8268e, 2026-10-27):
//   - https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/todo.ts
//   - https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/todowrite.txt
//   - https://github.com/anomalyco/opencode/blob/dev/packages/core/test/tool-todo.test.ts
// `todowrite` is experimental, takes `{ todos: [{ content, status }] }` and
// replaces the full list; it has no ids, priorities, or server-side state.
//
// Cross-references:
//   - ../types      — TodoAction, TodoItem, TodoParameters, TodoResult, TodoToolset
//   - ./tool        — the factory every tool uses
//   - ../harness    — registers todoTools as core and calls reset() with its own

import { HarnessError } from '../util';
import type { TodoAction, TodoItem, TodoParameters, TodoResult, TodoToolset } from '../types';
import { TODO_TOOLS_METADATA } from './metadata';
import { tool } from './tool';

// The accepted actions, in the order the error message and schema advertise
// them. `uncheck` is an explicit alias for `check` with `completed: false`.
const ACTIONS: readonly TodoAction[] = ['add', 'remove', 'check', 'uncheck', 'list'];

const ACTION_HINT = ACTIONS.join(', ');

// Type guard for the argument object. Arrays are rejected: `[1,2]` is valid
// JSON but cannot carry an `action`, and accepting it would make the error less
// specific than the schema suggests.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Copy on the way out, always. A caller or model-visible result must never hold
// a reference into the live list, or `todo.todos[0].completed = true` in a UI
// would mutate session state behind the tool's back.
const copyItem = (item: TodoItem): TodoItem => ({
    id: item.id,
    text: item.text,
    completed: item.completed
});

// The result envelope every action returns. `todo` is present for add/check/
// uncheck; `removed` for remove; `list` carries only `todos` and `counts`.
const compose = (
    items: readonly TodoItem[],
    extra: { todo?: TodoItem; removed?: TodoItem } = {}
): TodoResult => {
    const completed = items.filter((item) => item.completed).length;

    const result: TodoResult = {
        todos: items.map(copyItem),
        counts: {
            total: items.length,
            completed,
            remaining: items.length - completed
        }
    };

    if (extra.todo) result.todo = copyItem(extra.todo);
    if (extra.removed) result.removed = copyItem(extra.removed);

    return result;
};

// The per-harness todo list. IDs are decimal strings, monotonic for the life of
// this instance, and restart at "1" after reset() (a reset is a clean start:
// the conversation and every id referring to it are gone too).
export const createTodoTool = (): TodoToolset => {
    const items: TodoItem[] = [];
    let nextId = 1;

    // Resolve an id for every action that names one. A missing, non-string, or
    // blank id is reported before the lookup, so "not found" can never be
    // confused with "you sent nothing".
    const requireId = (input: Record<string, unknown>, action: TodoAction): string => {
        const id = input.id;

        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new HarnessError(`todoTools "${action}" requires a non-empty "id" string.`);
        }

        return id;
    };

    // Look up one item without mutating anything. An unknown id throws, which
    // the harness turns into a readable tool result; the list stays untouched.
    const requireItem = (id: string): TodoItem => {
        const item = items.find((candidate) => candidate.id === id);

        if (!item) {
            throw new HarnessError(`todoTools has no todo with id "${id}".`);
        }

        return item;
    };

    // The name, description, tags, schema, and visibility come from the shared
    // metadata module (./metadata.ts): the server describes this same tool in its
    // catalogue from that one copy, so a runtime registration and a descriptor can
    // never disagree. Core on purpose: a session todo list is useless if the model
    // has to discover it before its first plan.
    const implementation = tool<TodoParameters, TodoResult>({
        name: TODO_TOOLS_METADATA.name,
        description: TODO_TOOLS_METADATA.description,
        tags: TODO_TOOLS_METADATA.tags,
        visibility: TODO_TOOLS_METADATA.visibility,
        parameters: TODO_TOOLS_METADATA.parameters,
        execute: ({ parameters }) => {
            // A model can pass anything. Keep one readable error for "not an
            // object" so every action below can assume a record.
            if (!isRecord(parameters)) {
                throw new HarnessError(
                    `todoTools expects an object with an "action" (${ACTION_HINT}).`
                );
            }

            const action = parameters.action;

            if (typeof action !== 'string' || !ACTIONS.includes(action as TodoAction)) {
                throw new HarnessError(`todoTools requires "action" to be one of: ${ACTION_HINT}.`);
            }

            const resolvedAction = action as TodoAction;

            // Validate optional field types up front, for every action. That
            // keeps `completed: "yes"` or `id: 7` as a type error rather than
            // silently ignoring the wrong field on list/add.
            if (parameters.text !== undefined && typeof parameters.text !== 'string') {
                throw new HarnessError('todoTools "text" must be a string when provided.');
            }

            if (parameters.completed !== undefined && typeof parameters.completed !== 'boolean') {
                throw new HarnessError('todoTools "completed" must be a boolean when provided.');
            }

            if (parameters.id !== undefined && typeof parameters.id !== 'string') {
                throw new HarnessError('todoTools "id" must be a string when provided.');
            }

            switch (resolvedAction) {
                case 'add': {
                    const text = parameters.text;

                    if (typeof text !== 'string' || text.trim().length === 0) {
                        throw new HarnessError('todoTools "add" requires a non-empty "text" string.');
                    }

                    const item: TodoItem = {
                        id: String(nextId),
                        text: text.trim(),
                        completed: false
                    };

                    nextId++;
                    items.push(item);

                    return compose(items, { todo: item });
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`todoTools has no todo with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return compose(items, { removed });
                }

                case 'check': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // `check` defaults to complete; `completed: false` is the
                    // supported "I meant to uncheck" path. `uncheck` below is
                    // the explicit alias.
                    item.completed = parameters.completed ?? true;

                    return compose(items, { todo: item });
                }

                case 'uncheck': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // Always false: `uncheck` is the alias, not another way to
                    // pass `completed`. Contradictory input (`uncheck` +
                    // completed: true) stays an uncheck and is documented.
                    item.completed = false;

                    return compose(items, { todo: item });
                }

                case 'list':
                    return compose(items);
            }
        }
    });

    return {
        tool: implementation,
        // Clear both the list and the id counter: reset() is "start over", so
        // the next session-shaped conversation sees the same ids a new harness
        // would. No persistence, no shared module state.
        reset: () => {
            items.splice(0, items.length);
            nextId = 1;
        }
    };
};

