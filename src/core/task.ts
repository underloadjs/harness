// task — the harness session task list (the tool renamed from `todoManage`).
//
// This is a harness-specific store, not a port of OpenCode's `todowrite`. The
// differences are deliberate and documented in README.md / knowledge.md:
//   - ONE call shape (a patch) instead of an action enum: `tasks` carries entries
//     to add or patch, `remove` carries ids to delete, and no arguments at all is
//     a read of the current page;
//   - stable per-session string ids, so the model can refer to one item across
//     turns without repeating its text;
//   - the list lives in this closure, not in the transcript, so a read is cheap
//     and the result carries counts.
//
// R9 (tool audit) — bounded results (unchanged by the rename):
//   - at most TASK_MAX_RECORDS (200) tasks may be stored; a patch that would grow
//     the store past the cap is an actionable error, never a silent drop;
//   - `text` is capped at TASK_MAX_TEXT (4000) characters; an oversized write is
//     rejected with the actual length so the model can shorten and retry;
//   - every result is ONE bounded page: `offset` defaults to 0, `limit` defaults
//     to 20 and is hard-capped at 100, and the page also stops before the UTF-8
//     payload exceeds TASK_RESPONSE_BUDGET_BYTES (64 KiB) so 100 * 4 KB can never
//     flood the context window. `page.hasMore` / `page.nextOffset` let a caller
//     walk every record without gaps;
//   - there is no action wrapper: a read, an add, a patch and a removal all
//     return the SAME `{ tasks, counts, page }` current state, which is what makes
//     "mutate and instantly return the list" one round trip.
//
// PATCH SEMANTICS (R9-R11 approved wire design)
// ---------------------------------------------
//   - no arguments / `{}` / `undefined`  → read only, nothing changes;
//   - an entry WITHOUT `id`              → a new task; `text` is required;
//   - an entry WITH an existing `id`     → a partial patch; a field you omit
//     keeps its stored value (`{ id: "3", completed: true }` never touches text);
//   - an `id` that is not stored         → rejection, the store is untouched;
//   - `remove`                           → exact ids; an unknown id is a rejection;
//   - rejected as conflicting: the same id patched twice, the same id removed
//     twice, or one id in both `tasks` and `remove`;
//   - the WHOLE patch is validated before the first mutation, so a rejected call
//     leaves every record AND the id counter exactly as they were (atomic).
//
// Why a factory instead of a module-level tool: state must be per harness (and
// therefore per server session), shared by every agent in that harness, and
// cleared by `harness.reset()`. A module singleton would leak tasks between
// sessions. `createTaskTool()` builds a closed-over list and returns both the
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
//   - ../types                        — TaskItem, TaskInput, TaskCounts, TaskParameters, Tool
//   - ./tool                          — the factory every tool uses
//   - ../tools/runtime/task.tool.ts   — TASK_NAME / TASK_METADATA (description + JSON Schema)
//   - ./metadata.ts                   — the manifest projection the factory builds from
//   - ../harness.ts                   — registers task as core and calls reset() with its own handle
//   - ./snapshot.ts                   — persists this store under the historical `records.todos`
//
// Result contract (ONE shape for every success, mutations included):
//   task()                    → { tasks, counts, page }   read
//   task({ tasks: [...] })    → { tasks, counts, page }   add/patch, then read
//   task({ remove: [...] })   → { tasks, counts, page }   remove, then read

import { HarnessError } from '../util';
import type { TaskCounts, TaskItem, TaskParameters, TaskStoreState, Tool } from '../types';
import { TASK_METADATA } from './metadata';
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

// R9 bounds. Exported so tests (and any UI) can assert the exact limits instead
// of hard-coding numbers a second time. The NUMBERS are unchanged by the rename:
// 200 records, 4000 characters, a 20/100 page, and a 64 KiB serialized budget.
export const TASK_MAX_RECORDS = 200;
export const TASK_MAX_TEXT = 4000;
export const TASK_LIST_DEFAULT_LIMIT = 20;
export const TASK_LIST_MAX_LIMIT = 100;
export const TASK_RESPONSE_BUDGET_BYTES = 64 * 1024;

// One page cursor. `nextOffset` is present only when `hasMore`, so a caller loops
// `while (page.hasMore) { task({ offset: page.nextOffset }) }` and never has to
// guess whether "offset + limit" skipped records trimmed by the budget.
export type TaskPageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
};

// THE result: the requested page of the current store, the derived counts, and
// the page cursor. Every successful call returns exactly this shape — there is no
// separate mutation result any more.
export type TaskResult = {
    tasks: TaskItem[];
    counts: TaskCounts;
    page: TaskPageInfo;
};

// What createTaskTool() returns. Declared here (rather than in ../types) because
// the bounded result shape is owned by this module while ../types is shared with
// units editing that file at the same time; ../types re-exports these.
//
// `snapshot`/`restore` (R3a) are the persistence hooks: a JSON-shaped copy out and
// a fully validated replacement in. They never expose the live arrays.
export type TaskToolset = {
    tool: Tool<TaskParameters, TaskResult>;
    reset: () => void;
    snapshot: () => TaskStoreState;
    restore: (state: unknown) => void;
};

// Type guard for the argument object. Arrays are rejected: `[1,2]` is valid
// JSON but cannot carry a patch, and accepting it would make the error less
// specific than the schema suggests.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Copy on the way out, always. A caller or model-visible result must never hold a
// reference into the live list, or `result.tasks[0].completed = true` in a UI
// would mutate session state behind the tool's back.
const copyItem = (item: TaskItem): TaskItem => ({
    id: item.id,
    text: item.text,
    completed: item.completed
});

// Counts are always derived from the whole store, never from the page: a caller
// listing page 2 must still see how many tasks exist in total. `pending` is the
// complement of `completed` (the wire design renamed it from `remaining`; the
// meaning — records not yet complete — is identical).
const countsOf = (items: readonly TaskItem[]): TaskCounts => {
    const completed = items.filter((item) => item.completed).length;

    return {
        total: items.length,
        completed,
        pending: items.length - completed
    };
};

// Read `offset` once, for every call (matching the up-front field checks below):
// a negative or fractional cursor is a validation error, not a clamp.
const readOffset = (value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new HarnessError('task "offset" must be a non-negative integer when provided.');
    }

    return value as number;
};

// Read `limit` once, for every call. 1..TASK_LIST_MAX_LIMIT; a bigger limit is
// rejected (not clamped) so the caller knows its page was not silently shrunk.
const readLimit = (value: unknown): number => {
    if (value === undefined) return TASK_LIST_DEFAULT_LIMIT;

    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > TASK_LIST_MAX_LIMIT
    ) {
        throw new HarnessError(
            `task "limit" must be an integer between 1 and ${TASK_LIST_MAX_LIMIT} when provided.`
        );
    }

    return value as number;
};

// Read one trimmed, non-empty id out of a patch entry or a `remove` slot. A
// missing, non-string, or blank id is reported before the lookup, so "not found"
// can never be confused with "you sent nothing".
const readId = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HarnessError(`task ${label} must be a non-empty task id string.`);
    }

    return value.trim();
};

// Read an optional `text` write. Present-but-blank is rejected rather than
// treated as "clear the text", because a stored task with no text is meaningless,
// and silently slicing an oversized write would store something the caller never
// wrote.
const readText = (value: unknown, label: string): string => {
    if (typeof value !== 'string') {
        throw new HarnessError('task "text" must be a string when provided.');
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
        throw new HarnessError(`task ${label} requires a non-empty "text" string.`);
    }

    if (trimmed.length > TASK_MAX_TEXT) {
        throw new HarnessError(
            `task "text" is ${trimmed.length} characters; the limit is ${TASK_MAX_TEXT}. Shorten it and retry.`
        );
    }

    return trimmed;
};

// One validated patch entry. `id` is undefined for a NEW task; `text` and
// `completed` are undefined when the caller omitted them, which means "leave the
// stored value alone" on a patch. `index` is kept so a rejection can name the
// offending slot of a batch.
type ResolvedEntry = {
    index: number;
    id?: string;
    text?: string;
    completed?: boolean;
};

const readEntry = (value: unknown, index: number): ResolvedEntry => {
    const label = `"tasks[${index}]"`;

    if (!isRecord(value)) {
        throw new HarnessError(
            `task ${label} must be an object with an optional "id", "text", and "completed".`
        );
    }

    const rawId = value.id;
    const rawText = value.text;
    const rawCompleted = value.completed;

    // The id label quotes the whole field path, so a message stays readable when
    // it names a nested slot (`"tasks[0].id"`) instead of an unbalanced quote.
    const idLabel = `"${label.slice(1, -1)}.id"`;

    // An explicit `id: null` is a type error, not "no id": only an ABSENT id means
    // "create a new task", so a caller cannot accidentally duplicate a row.
    if (rawId !== undefined && typeof rawId !== 'string') {
        throw new HarnessError(`task ${idLabel} must be a string when provided.`);
    }

    if (rawCompleted !== undefined && typeof rawCompleted !== 'boolean') {
        throw new HarnessError('task "completed" must be a boolean when provided.');
    }

    const id = rawId === undefined ? undefined : readId(rawId, idLabel);
    const text = rawText === undefined ? undefined : readText(rawText, label);

    // A new task (no id) must say what it is: `completed` alone cannot create a
    // record, and `text` alone is not enough for one either.
    if (id === undefined && text === undefined) {
        throw new HarnessError(
            `task ${label} needs "text" to add a task, or an existing "id" to change one.`
        );
    }

    // Unknown keys are the entry schema's job (`additionalProperties: false` is
    // enforced by core/schema-validation.ts on every model and manual call), so
    // the reader here only ignores what it does not know.
    return {
        index,
        ...(id === undefined ? {} : { id }),
        ...(text === undefined ? {} : { text }),
        ...(rawCompleted === undefined ? {} : { completed: rawCompleted as boolean })
    };
};

// The validated, ordered plan one invocation produces. Nothing has touched the
// store yet: applying this plan is the only mutating step.
type TaskPatch = {
    // Existing items to patch, in caller order.
    patches: ResolvedEntry[];
    // New tasks to append, in caller order (text already trimmed and bounded).
    additions: { text: string; completed: boolean }[];
    // Ids to delete, in caller order (all known to exist, no duplicates).
    removals: string[];
};

// Validate the WHOLE invocation into a plan before anything is mutated. Every
// rejection lives here: types, unknown ids, duplicates, the conflicting `tasks`
// / `remove` overlap, and the record cap. `store` supplies the two reads the
// planner needs (lookup by id, current length) instead of the array itself, so
// two harnesses in one process can never see each other's list.
const readPatch = (
    raw: Record<string, unknown>,
    store: { find: (id: string) => TaskItem | undefined; length: () => number }
): TaskPatch => {
    const rawTasks = raw.tasks;
    const rawRemove = raw.remove;

    if (rawTasks !== undefined && !Array.isArray(rawTasks)) {
        throw new HarnessError('task "tasks" must be an array of task objects when provided.');
    }

    if (rawRemove !== undefined && !Array.isArray(rawRemove)) {
        throw new HarnessError('task "remove" must be an array of task id strings when provided.');
    }

    const entries = (rawTasks === undefined ? [] : (rawTasks as unknown[])).map(readEntry);

    // Id conflicts inside `tasks`: one id may be patched at most once per call,
    // otherwise the last write would silently win over the first.
    const patchedIds = new Set<string>();
    const patches: ResolvedEntry[] = [];
    const additions: TaskPatch['additions'] = [];

    for (const entry of entries) {
        if (entry.id === undefined) {
            additions.push({ text: entry.text as string, completed: entry.completed ?? false });
            continue;
        }

        if (patchedIds.has(entry.id)) {
            throw new HarnessError(
                `task "tasks" changes id "${entry.id}" more than once; send one entry per id.`
            );
        }

        patchedIds.add(entry.id);

        if (store.find(entry.id) === undefined) {
            throw new HarnessError(`task has no task with id "${entry.id}".`);
        }

        patches.push(entry);
    }

    // Id conflicts inside and across `remove`: a duplicate removal is ambiguous,
    // and patch-plus-remove of the same id is a contradiction the caller must fix.
    const removedIds = new Set<string>();
    const removals: string[] = [];

    for (const [index, value] of (rawRemove === undefined
        ? []
        : (rawRemove as unknown[])
    ).entries()) {
        const id = readId(value, `"remove[${index}]"`);

        if (removedIds.has(id)) {
            throw new HarnessError(`task "remove" lists id "${id}" more than once.`);
        }

        if (patchedIds.has(id)) {
            throw new HarnessError(
                `task id "${id}" appears in both "tasks" and "remove"; change it or remove it, not both.`
            );
        }

        if (store.find(id) === undefined) {
            throw new HarnessError(`task has no task with id "${id}".`);
        }

        removedIds.add(id);
        removals.push(id);
    }

    // Capacity is checked once, after field validation and before any id is
    // consumed: an over-cap batch is an actionable error, and a rejected call
    // never burns an id from the monotonic counter. Removals ARE netted off,
    // because they are applied before the additions (see the apply order in the
    // execute below), so a caller may restate a full section in one call.
    const resulting = store.length() - removals.length + additions.length;

    if (resulting > TASK_MAX_RECORDS) {
        throw new HarnessError(
            `task would hold ${resulting} tasks; the maximum is ${TASK_MAX_RECORDS}. Remove one before adding another.`
        );
    }

    return { patches, additions, removals };
};

// The per-harness task list. IDs are decimal strings, monotonic for the life of
// this instance, and restart at "1" after reset() (a reset is a clean start: the
// conversation and every id referring to it are gone too).
export const createTaskTool = (): TaskToolset => {
    const items: TaskItem[] = [];
    let nextId = 1;

    const findItem = (id: string): TaskItem | undefined =>
        items.find((candidate) => candidate.id === id);

    // Build one budgeted page of the CURRENT store:
    //   - items are copied first, so the live store is never handed out;
    //   - they are added while the serialized UTF-8 size stays inside
    //     TASK_RESPONSE_BUDGET_BYTES (a comma per item is counted too);
    //   - the first item of a non-empty page is always included: one record can be
    //     at most ~4 KB, so this cannot blow the budget, and it guarantees
    //     `nextOffset` always advances (no stall, no gaps);
    //   - `hasMore` is computed against the full ordered length, so a
    //     budget-truncated page reports the cursor of its last included item
    //     rather than offset + limit.
    // The read path and every mutation result both go through here, which is what
    // makes the response shape identical in every case.
    const project = (offset: number, limit: number): TaskResult => {
        const tasks: TaskItem[] = [];
        let bytes = 0;

        for (const item of items.slice(offset, offset + limit)) {
            const copy = copyItem(item);
            const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

            if (tasks.length > 0 && bytes + size > TASK_RESPONSE_BUDGET_BYTES) break;

            tasks.push(copy);
            bytes += size;
        }

        const consumed = offset + tasks.length;
        const page: TaskPageInfo = {
            offset,
            limit,
            hasMore: consumed < items.length
        };

        if (page.hasMore) page.nextOffset = consumed;

        return { tasks, counts: countsOf(items), page };
    };

    const implementation = tool<TaskParameters, TaskResult>({
        name: TASK_METADATA.name,
        description: TASK_METADATA.description,
        tags: TASK_METADATA.tags,
        visibility: TASK_METADATA.visibility,
        parameters: TASK_METADATA.parameters,
        execute: ({ parameters }) => {
            // A model can pass anything. "No arguments" (undefined, or a JSON null
            // body) is the documented READ; anything else that is not a record is
            // one readable error, so everything below can assume a record.
            const raw: Record<string, unknown> = isRecord(parameters) ? parameters : {};

            if (parameters !== undefined && parameters !== null && !isRecord(parameters)) {
                throw new HarnessError(
                    'task expects an object with optional "tasks" and "remove" arrays.'
                );
            }

            // The pagination cursor is validated for every call, so a stray
            // `limit: 500` beside a patch is reported instead of ignored.
            const offset = readOffset(raw.offset);
            const limit = readLimit(raw.limit);

            // Validate everything, then mutate. Nothing between this line and the
            // application loops below can throw, so the store is never half-patched.
            const patch = readPatch(raw, { find: findItem, length: () => items.length });

            // Patches first: an existing item keeps its position and its id, and
            // only the fields the caller named change.
            for (const entry of patch.patches) {
                const item = findItem(entry.id as string) as TaskItem;

                if (entry.text !== undefined) item.text = entry.text;
                if (entry.completed !== undefined) item.completed = entry.completed;
            }

            // Removals next, so a caller can restate a section in one call: the
            // freed slots do not shift the additions, which stay appended last.
            for (const id of patch.removals) {
                const index = items.findIndex((candidate) => candidate.id === id);

                if (index !== -1) items.splice(index, 1);
            }

            // Additions last, in caller order, taking ids from the monotonic
            // counter (a removed id is never reused within this instance).
            for (const addition of patch.additions) {
                items.push({
                    id: String(nextId),
                    text: addition.text,
                    completed: addition.completed
                });
                nextId++;
            }

            return project(offset, limit);
        }
    });

    return {
        tool: implementation,
        // Clear both the list and the id counter: reset() is "start over", so the
        // next session-shaped conversation sees the same ids a new harness would.
        // No persistence, no shared module state.
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
        // The records are already copies from readTaskStoreState, so the live store
        // is not aliased either.
        restore: (state: unknown) => {
            const restored = readTaskStoreState(state);

            items.splice(0, items.length, ...restored.items);
            nextId = restored.nextId;
        }
    };
};

// Validate one persisted task store and return a DEEP COPY. This is the pure half
// of restore: the harness calls it while preparing a snapshot, and
// createTaskTool.restore calls it again before touching the closure, so a bad file
// can never leave a half-restored list.
//
// The persisted block is STILL `records.todos` with `{ items, nextId }` records, so
// snapshot version 1 keeps its exact on-disk shape and an older session restores
// unchanged. That is why the diagnostic labels below keep saying "todo state": they
// name the persisted field, not the renamed tool.
//
// Invariants mirror the mutations above: ids are unique decimal strings, text is
// non-empty and inside TASK_MAX_TEXT, the record cap holds, and nextId is greater
// than every stored id (so the next add cannot collide).
export const readTaskStoreState = (value: unknown): TaskStoreState => {
    const root = readSnapshotRecord(value, 'todo state');
    readSnapshotKeys(root, ['items', 'nextId'], 'todo state');

    const entries = readSnapshotArray(root.items, 'todo state.items');

    if (entries.length > TASK_MAX_RECORDS) {
        throw new HarnessError(
            `todo state holds ${entries.length} todos; the maximum is ${TASK_MAX_RECORDS}.`
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
                max: TASK_MAX_TEXT
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
