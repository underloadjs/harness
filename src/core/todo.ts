// todoManage — the harness session todo list.
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
// R9 (tool audit) — bounded results:
//   - at most TODO_MAX_RECORDS (200) todos may be stored; `add` past the cap is
//     an actionable error, never a silent drop of stored data;
//   - `text` is capped at TODO_MAX_TEXT (4000) characters; an oversized write is
//     rejected with the actual length so the model can shorten and retry;
//   - `list` is paginated: `offset` defaults to 0, `limit` defaults to 20 and is
//     hard-capped at 100, and the page also stops before the UTF-8 payload
//     exceeds TODO_RESPONSE_BUDGET_BYTES (64 KiB) so 100 * 4 KB can never flood
//     the context window. `page.hasMore` / `page.nextOffset` let a caller walk
//     every record without gaps;
//   - mutation results (add/remove/check/uncheck) return only the changed item
//     and the counts, never the whole store.
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
//   - ../types      — TodoAction, TodoCounts, TodoItem, TodoParameters, Tool
//   - ./tool        — the factory every tool uses
//   - ./metadata    — TODO_MANAGE_METADATA (description + JSON Schema)
//   - ../harness    — registers todoManage as core and calls reset() with its own
//
// Result contracts (all list-shaped results carry `page`, mutations do not):
//   list                          → { todos, counts, page }
//   add | check | uncheck         → { todo, counts }
//   remove                        → { removed, counts }

import { HarnessError } from '../util';
import type { TodoAction, TodoCounts, TodoItem, TodoParameters, TodoStoreState, Tool } from '../types';
import { TODO_MANAGE_METADATA } from './metadata';
import { tool } from './tool';
import {
    readSnapshotArray,
    readSnapshotBoolean,
    readSnapshotId,
    readSnapshotIdCounter,
    readSnapshotKeys,
    readSnapshotRecord,
    readSnapshotString
} from './snapshot-validation';

// The accepted actions, in the order the error message and schema advertise
// them. `uncheck` is an explicit alias for `check` with `completed: false`.
const ACTIONS: readonly TodoAction[] = ['add', 'remove', 'check', 'uncheck', 'list'];

const ACTION_HINT = ACTIONS.join(', ');

// R9 bounds. Exported so tests (and any UI) can assert the exact limits instead
// of hard-coding numbers a second time.
export const TODO_MAX_RECORDS = 200;
export const TODO_MAX_TEXT = 4000;
export const TODO_LIST_DEFAULT_LIMIT = 20;
export const TODO_LIST_MAX_LIMIT = 100;
export const TODO_RESPONSE_BUDGET_BYTES = 64 * 1024;

// One page of a bounded list. `nextOffset` is present only when `hasMore`, so a
// caller loops `while (page.hasMore) { list(offset: page.nextOffset) }` and never
// has to guess whether "offset + limit" skipped records trimmed by the budget.
export type TodoPageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
};

// `list` result: the requested page (not a snapshot of the store), the derived
// counts, and the page cursor.
export type TodoListResult = {
    todos: TodoItem[];
    counts: TodoCounts;
    page: TodoPageInfo;
};

// Mutation result: the changed item and the counts. No `todos` array — a model
// that needs the list calls `list` and pays for one bounded page.
export type TodoChangeResult = {
    todo?: TodoItem;
    removed?: TodoItem;
    counts: TodoCounts;
};

export type TodoResult = TodoListResult | TodoChangeResult;

// What createTodoTool() returns. Declared here (rather than in ../types) because
// the R9 bounded shape is owned by this module while ../types is shared with
// units still editing the same file; see the final report for the migration.
//
// `snapshot`/`restore` (R3a) are the persistence hooks: a JSON-shaped copy out and
// a fully validated replacement in. They never expose the live arrays.
export type TodoToolset = {
    tool: Tool<TodoParameters, TodoResult>;
    reset: () => void;
    snapshot: () => TodoStoreState;
    restore: (state: unknown) => void;
};

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

// Counts are always derived from the whole store, never from the page: a caller
// listing page 2 must still see how many todos exist in total.
const countsOf = (items: readonly TodoItem[]): TodoCounts => {
    const completed = items.filter((item) => item.completed).length;

    return {
        total: items.length,
        completed,
        remaining: items.length - completed
    };
};

// Read `offset` once, for every action (matching the up-front field checks
// below): a negative or fractional cursor is a validation error, not a clamp.
const readOffset = (value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new HarnessError(
            'todoManage "offset" must be a non-negative integer when provided.'
        );
    }

    return value as number;
};

// Read `limit` once, for every action. 1..TODO_LIST_MAX_LIMIT; a bigger limit is
// rejected (not clamped) so the caller knows its page was not silently shrunk.
const readLimit = (value: unknown): number => {
    if (value === undefined) return TODO_LIST_DEFAULT_LIMIT;

    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > TODO_LIST_MAX_LIMIT
    ) {
        throw new HarnessError(
            `todoManage "limit" must be an integer between 1 and ${TODO_LIST_MAX_LIMIT} when provided.`
        );
    }

    return value as number;
};

// Build one budgeted page from an ordered view of the store:
//   - items are copied first, so the live store is never handed out;
//   - they are added while the serialized UTF-8 size stays inside
//     TODO_RESPONSE_BUDGET_BYTES (a comma per item is counted too);
//   - the first item of a non-empty page is always included: one record can be
//     at most ~4 KB, so this cannot blow the budget, and it guarantees
//     `nextOffset` always advances (no stall, no gaps).
// `hasMore` is computed against the full ordered length, so a budget-truncated
// page reports the cursor of its last included item rather than offset + limit.
const paginate = (
    ordered: readonly TodoItem[],
    offset: number,
    limit: number
): { todos: TodoItem[]; page: TodoPageInfo } => {
    const todos: TodoItem[] = [];
    let bytes = 0;

    for (const item of ordered.slice(offset, offset + limit)) {
        const copy = copyItem(item);
        const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

        if (todos.length > 0 && bytes + size > TODO_RESPONSE_BUDGET_BYTES) break;

        todos.push(copy);
        bytes += size;
    }

    const consumed = offset + todos.length;
    const page: TodoPageInfo = {
        offset,
        limit,
        hasMore: consumed < ordered.length
    };

    if (page.hasMore) page.nextOffset = consumed;

    return { todos, page };
};

// Validate one persisted todo store and return a DEEP COPY. This is the pure
// half of restore: the harness calls it while preparing a snapshot, and
// createTodoTool.restore calls it again before touching the closure, so a bad
// file can never leave a half-restored list.
//
// Invariants mirror the mutations above: ids are unique decimal strings, text is
// non-empty and inside TODO_MAX_TEXT, the record cap holds, and nextId is greater
// than every stored id (so the next `add` cannot collide).
export const readTodoStoreState = (value: unknown): TodoStoreState => {
    const root = readSnapshotRecord(value, 'todo state');
    readSnapshotKeys(root, ['items', 'nextId'], 'todo state');

    const entries = readSnapshotArray(root.items, 'todo state.items');

    if (entries.length > TODO_MAX_RECORDS) {
        throw new HarnessError(
            `todo state holds ${entries.length} todos; the maximum is ${TODO_MAX_RECORDS}.`
        );
    }

    const items = entries.map((entry, index) => {
        const label = `todo state.items[${index}]`;
        const record = readSnapshotRecord(entry, label);
        readSnapshotKeys(record, ['id', 'text', 'completed'], label);

        return {
            id: readSnapshotId(record.id, `${label}.id`),
            text: readSnapshotString(record.text, `${label}.text`, {
                min: 1,
                max: TODO_MAX_TEXT
            }),
            completed: readSnapshotBoolean(record.completed, `${label}.completed`)
        };
    });

    const nextId = readSnapshotIdCounter(
        items.map((item) => item.id),
        root.nextId,
        'todo state'
    );

    return { items, nextId };
};

// The per-harness todo list. IDs are decimal strings, monotonic for the life of
// this instance, and restart at "1" after reset() (a reset is a clean start:
// the conversation and every id referring to it are gone too).
export const createTodoTool = (): TodoToolset => {    const items: TodoItem[] = [];
    let nextId = 1;

    // Resolve an id for every action that names one. A missing, non-string, or
    // blank id is reported before the lookup, so "not found" can never be
    // confused with "you sent nothing".
    const requireId = (input: Record<string, unknown>, action: TodoAction): string => {
        const id = input.id;

        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new HarnessError(`todoManage "${action}" requires a non-empty "id" string.`);
        }

        return id;
    };

    // Look up one item without mutating anything. An unknown id throws, which
    // the harness turns into a readable tool result; the list stays untouched.
    const requireItem = (id: string): TodoItem => {
        const item = items.find((candidate) => candidate.id === id);

        if (!item) {
            throw new HarnessError(`todoManage has no todo with id "${id}".`);
        }

        return item;
    };

    // The name, description, tags, schema, and visibility come from the shared
    // metadata module (./metadata.ts): the server describes this same tool in its
    // catalogue from that one copy, so a runtime registration and a descriptor can
    // never disagree. Core on purpose: a session todo list is useless if the model
    // has to discover it before its first plan.
    const implementation = tool<TodoParameters, TodoResult>({
        name: TODO_MANAGE_METADATA.name,
        description: TODO_MANAGE_METADATA.description,
        tags: TODO_MANAGE_METADATA.tags,
        visibility: TODO_MANAGE_METADATA.visibility,
        parameters: TODO_MANAGE_METADATA.parameters,
        execute: ({ parameters }) => {
            // A model can pass anything. Keep one readable error for "not an
            // object" so every action below can assume a record.
            if (!isRecord(parameters)) {
                throw new HarnessError(
                    `todoManage expects an object with an "action" (${ACTION_HINT}).`
                );
            }

            const action = parameters.action;

            if (typeof action !== 'string' || !ACTIONS.includes(action as TodoAction)) {
                throw new HarnessError(`todoManage requires "action" to be one of: ${ACTION_HINT}.`);
            }

            const resolvedAction = action as TodoAction;

            // Validate optional field types up front, for every action. That
            // keeps `completed: "yes"` or `id: 7` as a type error rather than
            // silently ignoring the wrong field on list/add.
            if (parameters.text !== undefined && typeof parameters.text !== 'string') {
                throw new HarnessError('todoManage "text" must be a string when provided.');
            }

            if (parameters.completed !== undefined && typeof parameters.completed !== 'boolean') {
                throw new HarnessError('todoManage "completed" must be a boolean when provided.');
            }

            if (parameters.id !== undefined && typeof parameters.id !== 'string') {
                throw new HarnessError('todoManage "id" must be a string when provided.');
            }

            // The pagination cursor is validated for every action too, so a
            // stray `limit: 500` on `add` is reported instead of ignored. The
            // schema declares offset/limit (see ./metadata.ts); TodoParameters
            // is read through a raw record because this module's bounded result
            // contract is declared locally (see TodoToolset above).
            const raw = parameters as unknown as Record<string, unknown>;
            const offset = readOffset(raw.offset);
            const limit = readLimit(raw.limit);

            switch (resolvedAction) {
                case 'add': {
                    const text = parameters.text;

                    if (typeof text !== 'string' || text.trim().length === 0) {
                        throw new HarnessError('todoManage "add" requires a non-empty "text" string.');
                    }

                    const trimmed = text.trim();

                    // Reject instead of truncating: silently slicing the text
                    // would store something the model never wrote.
                    if (trimmed.length > TODO_MAX_TEXT) {
                        throw new HarnessError(
                            `todoManage "text" is ${trimmed.length} characters; the limit is ${TODO_MAX_TEXT}. Shorten it and retry.`
                        );
                    }

                    // Capacity is checked after field validation but before the
                    // id is consumed: a full store is an actionable error, and a
                    // failed add never burns an id.
                    if (items.length >= TODO_MAX_RECORDS) {
                        throw new HarnessError(
                            `todoManage already holds the maximum of ${TODO_MAX_RECORDS} todos; remove one before adding another.`
                        );
                    }

                    const item: TodoItem = {
                        id: String(nextId),
                        text: trimmed,
                        completed: false
                    };

                    nextId++;
                    items.push(item);

                    return { todo: copyItem(item), counts: countsOf(items) };
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`todoManage has no todo with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return { removed: copyItem(removed), counts: countsOf(items) };
                }

                case 'check': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // `check` defaults to complete; `completed: false` is the
                    // supported "I meant to uncheck" path. `uncheck` below is
                    // the explicit alias.
                    item.completed = parameters.completed ?? true;

                    return { todo: copyItem(item), counts: countsOf(items) };
                }

                case 'uncheck': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // Always false: `uncheck` is the alias, not another way to
                    // pass `completed`. Contradictory input (`uncheck` +
                    // completed: true) stays an uncheck and is documented.
                    item.completed = false;

                    return { todo: copyItem(item), counts: countsOf(items) };
                }

                case 'list': {
                    const { todos, page } = paginate(items, offset, limit);

                    return { todos, counts: countsOf(items), page };
                }
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
        },
        // Copy out: a snapshot must never alias the live list, or a caller could
        // mutate session state by editing a saved object.
        snapshot: () => ({
            items: items.map(copyItem),
            nextId
        }),
        // Validate into a copy first, then replace the closure state in one step.
        // The records are already copies from readTodoStoreState, so the live
        // store is not aliased either.
        restore: (state: unknown) => {
            const restored = readTodoStoreState(state);

            items.splice(0, items.length, ...restored.items);
            nextId = restored.nextId;
        }
    };
};
