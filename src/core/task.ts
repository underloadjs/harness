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
// CONCURRENCY (T1) — WHY `rev`, `expects`, CLAIMS AND A CHANGE LOG EXIST
// ----------------------------------------------------------------------
// There is ONE store per harness (../harness.ts) and every agent on every thread
// shares it, so a caller can read a record, work on it, and write it back after
// somebody else already changed it. Before T1 the last write silently won and the
// other agent's edit was gone. Now:
//   - every record carries `rev`, a CONTENT revision: 1 on add, +1 ONLY when
//     `text` (post-trim, compared to the stored value) or `completed` actually
//     changes. Claiming, releasing, taking over and renewing a lease never bump
//     it, so an ownership action can never invalidate another agent's CAS token;
//   - every write is attributed to `updatedBy` / `updatedThreadId` / `updatedAt`,
//     read from the ToolContext (`agent?.name`, `threadId`) and never from tool
//     arguments, so the model cannot forge who edited what;
//   - every recorded event appends one `TaskChange` to a bounded FIFO log
//     (TASK_MAX_CHANGES) and advances the monotonic store `storeRev`;
//   - a call that HAS an agent identity must pass `expects: [{ id, rev }]` for
//     every record it patches or removes. A mismatch rejects the WHOLE call
//     atomically and names the current rev, the last editor, and (when the log
//     covers the gap) the fields that changed. A token that names a record the
//     store no longer has rejects with `was removed since revision <n>` INSTEAD of
//     the plain `no task with id` lookup, whichever half of the call named that id
//     (a `tasks` patch, a `remove`, or the token alone) — that is the race the
//     caller actually hit. An identity-less call — a direct `tool()` / driver call
//     — may still write blind, which is the pre-T1 behaviour hosts and tests rely
//     on;
//   - `claim` / `release` / `takeover` hold a record for a lease
//     (TASK_DEFAULT_LEASE_MS, clamped into TASK_MIN_LEASE_MS..TASK_MAX_LEASE_MS)
//     so a long edit is not stomped. A holder is the exact pair
//     `(owner, ownerThreadId)`; `leaseUntil` absent means an indefinite claim. A
//     non-holder may not change content while a claim is unexpired; once it has
//     expired the next writer clears it (and logs that clear) and proceeds.
//     `takeover` is the deliberate override of a live claim;
//   - `since` returns just the events a caller missed, and `afterId` pages by id
//     (keyset) so a concurrent removal cannot make a walk skip or repeat a record;
//   - `mergeDisjoint` is the single opt-in escape from a stale rejection: the
//     patch still applies when the change log PROVES every concurrent content
//     change touched fields this patch does not set (see mergeConcurrentFields).
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
//   - ../types                        — TaskItem, TaskInput, TaskCounts, TaskExpect,
//                                       TaskChange, TaskParameters, TaskStoreState, Tool
//   - ./tool                          — the factory every tool uses
//   - ../tools/runtime/task.tool.ts   — TASK_NAME / TASK_METADATA (description + JSON Schema)
//   - ./metadata.ts                   — the manifest projection the factory builds from
//   - ../harness.ts                   — registers task as core, calls reset(), and persists
//                                       snapshot()/restore() under `records.todos`
//   - ./snapshot.ts                   — persists this store under the historical `records.todos`
//   - ../server/workers/lane-commit.ts — the lane fold revalidates a store through
//                                       readTaskStoreState (the `stale-record` pattern)
//
// Result contract (ONE shape for every success, mutations included):
//   task()                    → { tasks, counts, page, storeRev }            read
//   task({ tasks: [...] })    → { tasks, counts, page, storeRev }            add/patch, then read
//   task({ remove: [...] })   → { tasks, counts, page, storeRev }            remove, then read
//   task({ since: 4 })        → the same, plus changes/changesHasMore/changesTruncated

import { HarnessError } from '../util';
import type {
    TaskChange,
    TaskChangeOp,
    TaskCounts,
    TaskItem,
    TaskParameters,
    TaskStoreState,
    Tool
} from '../types';
import { TASK_METADATA } from './metadata';
import { tool } from './tool';
import {
    readSnapshotArray,
    readSnapshotBoolean,
    readSnapshotId,
    readSnapshotIdCounter,
    readSnapshotInteger,
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

// T1 lease bounds. A lease exists to protect ONE in-flight edit, so the default is
// a generous quarter hour; the floor stops a 1 ms heartbeat from turning the claim
// back into a race, and the ceiling guarantees an abandoned claim stops blocking
// within a day even if nobody ever calls releaseThread(). Values outside the range
// are CLAMPED (a direct call is not schema-gated), never rejected.
export const TASK_DEFAULT_LEASE_MS = 15 * 60_000;
export const TASK_MIN_LEASE_MS = 60_000;
export const TASK_MAX_LEASE_MS = 24 * 60 * 60_000;

// T1 change-log bounds. The log is what makes `since` cheap and a disjoint merge
// provable, so it must outlive a normal working burst without holding memory
// hostage: 200 retained events, at most 50 handed back per call. Both are FIFO —
// a store older than the window says so through `changesTruncated` instead of
// pretending the list was complete.
export const TASK_MAX_CHANGES = 200;
export const TASK_MAX_CHANGES_IN_RESULT = 50;

// The only content fields a `TaskChange.fields` entry can name, in the ONE order
// every `fields` array and every stale-error hint uses. Stable ordering is what
// lets a caller (and a test) compare change entries without sorting them.
type ContentField = 'text' | 'completed';

const TASK_CONTENT_FIELDS: readonly ContentField[] = ['text', 'completed'];

// The five recorded events, in wire order (../types TaskChangeOp).
const TASK_CHANGE_OPS: readonly TaskChangeOp[] = ['add', 'update', 'remove', 'claim', 'release'];

// One page cursor. Offset mode keeps `nextOffset`; keyset mode (`afterId`) echoes
// the cursor and answers with `nextAfterId`, because a numeric-id cursor survives
// another agent removing a record mid-walk while an index cannot.
export type TaskPageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    // Offset mode only: the offset to pass back while hasMore.
    nextOffset?: number;
    // Keyset mode only: the cursor this page was taken after.
    afterId?: string;
    // Keyset mode only, when hasMore: the id to pass back as `afterId`.
    nextAfterId?: string;
};

// THE result: the requested page of the current store, the derived counts, the
// page cursor, and the store revision. Every successful call returns exactly this
// shape — there is no separate mutation result any more. `storeRev` lets a reader
// poll `since: storeRev` next time and get only what it missed. The three change
// keys appear ONLY when the call passed `since`.
export type TaskResult = {
    tasks: TaskItem[];
    counts: TaskCounts;
    page: TaskPageInfo;
    storeRev: number;
    changes?: TaskChange[];
    changesHasMore?: boolean;
    changesTruncated?: boolean;
};

// What createTaskTool() returns. Declared here (rather than in ../types) because
// the bounded result shape is owned by this module while ../types is shared with
// units editing that file at the same time; ../types re-exports these.
//
// `snapshot`/`restore` (R3a) are the persistence hooks: a JSON-shaped copy out and
// a fully validated replacement in. They never expose the live arrays.
//
// `releaseThread` (T1) is the lifecycle hook: when a thread stops or is deleted its
// claims must not keep blocking the rest of the session, so the harness clears
// every claim tagged with that thread id. It returns how many it cleared.
export type TaskToolset = {
    tool: Tool<TaskParameters, TaskResult>;
    reset: () => void;
    snapshot: () => TaskStoreState;
    restore: (state: unknown) => void;
    releaseThread: (threadId: string) => number;
};

// Type guard for the argument object. Arrays are rejected: `[1,2]` is valid
// JSON but cannot carry a patch, and accepting it would make the error less
// specific than the schema suggests.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// Copy on the way out, always. A caller or model-visible result must never hold a
// reference into the live list, or `result.tasks[0].completed = true` in a UI
// would mutate session state behind the tool's back.
//
// The optional T1 fields are spread conditionally, never assigned as `undefined`:
// a key that exists with value `undefined` serializes as a MISSING key but still
// breaks a deep-equal comparison, and the byte budget below measures the real
// serialized shape. Key order is fixed here and in readTaskStoreState so the same
// store always serializes to the same size.
const copyItem = (item: TaskItem): TaskItem => ({
    id: item.id,
    text: item.text,
    completed: item.completed,
    rev: item.rev,
    ...(item.updatedBy === undefined ? {} : { updatedBy: item.updatedBy }),
    ...(item.updatedThreadId === undefined ? {} : { updatedThreadId: item.updatedThreadId }),
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
    ...(item.owner === undefined ? {} : { owner: item.owner }),
    ...(item.ownerThreadId === undefined ? {} : { ownerThreadId: item.ownerThreadId }),
    ...(item.leaseUntil === undefined ? {} : { leaseUntil: item.leaseUntil })
});

// Same rule for a change entry: detached copy, defined keys only, canonical order
// (`rev, id, op, by, threadId, at, fields, itemRev`) and a copied `fields` array
// so a caller cannot push into the log through a result.
const copyChange = (change: TaskChange): TaskChange => ({
    rev: change.rev,
    id: change.id,
    op: change.op,
    ...(change.by === undefined ? {} : { by: change.by }),
    ...(change.threadId === undefined ? {} : { threadId: change.threadId }),
    at: change.at,
    ...(change.fields === undefined ? {} : { fields: [...change.fields] }),
    ...(change.itemRev === undefined ? {} : { itemRev: change.itemRev })
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

// Read the keyset cursor. It is a DECIMAL ID, not an index: ids are monotonic and
// never reused inside an instance, so "everything after id 7" is stable under
// concurrent removals while "everything after position 7" is not. Same shape rule
// as the persisted ids (readSnapshotId), so a cursor copied out of a page always
// parses.
const readAfterId = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;

    if (typeof value !== 'string' || !/^[0-9]+$/.test(value.trim())) {
        throw new HarnessError('task "afterId" must be a decimal task id string when provided.');
    }

    const id = value.trim();

    if (!Number.isSafeInteger(Number(id))) {
        throw new HarnessError('task "afterId" is larger than a safe integer.');
    }

    return id;
};

// Read the change-feed watermark. The `since > storeRev` bound is checked by the
// caller because only the closure knows the current revision.
const readSince = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new HarnessError('task "since" must be a non-negative integer when provided.');
    }

    return value as number;
};

// Read the lease length. Anything finite and positive is accepted and CLAMPED
// into TASK_MIN_LEASE_MS..TASK_MAX_LEASE_MS; a fractional request floors to ms.
// The clamp is reachable through a SCHEMA-LESS call — a direct `tool()` / driver
// call bypasses ./metadata.ts, so this reader is the only gate it has. A schema-
// validated harness call never reaches the clamp with an out-of-range value: the
// JSON Schema `minimum`/`maximum` (../tools/runtime/task.tool.ts `leaseMs`) reject
// it first, so clamping there would be dead code.
const readLeaseMs = (value: unknown): number => {
    if (value === undefined) return TASK_DEFAULT_LEASE_MS;

    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new HarnessError(
            'task "leaseMs" must be a positive finite number of milliseconds when provided.'
        );
    }

    return Math.min(TASK_MAX_LEASE_MS, Math.max(TASK_MIN_LEASE_MS, Math.floor(value)));
};

// Read the opt-in disjoint merge flag.
const readMergeDisjoint = (value: unknown): boolean => {
    if (value === undefined) return false;

    if (typeof value !== 'boolean') {
        throw new HarnessError('task "mergeDisjoint" must be a boolean when provided.');
    }

    return value;
};

// Read one trimmed, non-empty id out of a patch entry, a `remove`/`claim`/
// `release`/`takeover` slot, or an `expects` entry. A missing, non-string, or
// blank id is reported before the lookup, so "not found" can never be confused
// with "you sent nothing".
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

// One validated CAS precondition list. The pair (id, rev) is the caller's proof of
// what it read; an id may be named at most once, and `rev` is the revision shape
// the reader saw (>= 1, matching TaskItem.rev).
const readExpects = (value: unknown): Map<string, number> => {
    if (value === undefined) return new Map();

    if (!Array.isArray(value)) {
        throw new HarnessError('task "expects" must be an array of { id, rev } objects when provided.');
    }

    const expects = new Map<string, number>();

    for (const [index, entry] of (value as unknown[]).entries()) {
        const label = `"expects[${index}]"`;

        if (!isRecord(entry)) {
            throw new HarnessError(`task ${label} must be an object with an "id" and a "rev".`);
        }

        const id = readId(entry.id, `"${label.slice(1, -1)}.id"`);

        if (!Number.isSafeInteger(entry.rev) || (entry.rev as number) < 1) {
            throw new HarnessError(
                `task "${label.slice(1, -1)}.rev" must be a positive integer (the revision you read).`
            );
        }

        if (expects.has(id)) {
            throw new HarnessError(`task "expects" lists id "${id}" more than once.`);
        }

        expects.set(id, entry.rev as number);
    }

    return expects;
};

// The store reads the planner needs. `now` is captured ONCE per call so lease
// expiry, lease checks and timestamps all agree (a claim cannot be "live" in the
// validation pass and "expired" in the apply pass because a millisecond passed).
// `by`/`threadId` are the CALLER identity from the ToolContext; `mergeDisjoint`
// is NOT part of this view because the planner reads it (and every other model
// argument) straight out of the validated `raw` call object.
type StoreView = {
    find: (id: string) => TaskItem | undefined;
    length: () => number;
    changes: () => readonly TaskChange[];
    now: number;
    by?: string;
    threadId?: string;
};

// The validated, ordered plan one invocation produces. Nothing has touched the
// store yet: applying this plan is the only mutating step. Apply order is
// claim → release → takeover → expired-claim clears → patches → removals →
// additions, which is also the order the change entries are logged in.
type TaskPatch = {
    // Ids to claim, in caller order (all known to exist, no duplicates).
    claims: string[];
    // Ids to release, in caller order.
    releases: string[];
    // Ids to take over (the deliberate override), in caller order.
    takeovers: string[];
    // Existing items to patch, in caller order.
    patches: ResolvedEntry[];
    // New tasks to append, in caller order (text already trimmed and bounded).
    additions: { text: string; completed: boolean }[];
    // Ids to delete, in caller order (all known to exist, no duplicates).
    removals: string[];
    // CAS preconditions by id (empty when the caller sent none).
    expects: Map<string, number>;
    // Clamped lease length for claims/takeovers of this call.
    leaseMs: number;
    // Ids whose FOREIGN claim had expired: cleared (and logged as a release) right
    // before the patch/removal that unlocked them.
    expired: string[];
};

// Holder identity is the EXACT pair `(owner, ownerThreadId)`. Two agents with the
// same name on different threads are different holders, and a threaded holder and
// an unthreaded one are different holders too — that is what makes a claim mean
// "this specific in-flight edit", not "somebody called coder".
const isHolder = (item: TaskItem, by: string | undefined, threadId: string | undefined): boolean =>
    item.owner !== undefined && item.owner === by && item.ownerThreadId === threadId;

// A claim is expired only when it carries a lease that has passed. An `owner`
// without `leaseUntil` is INDEFINITE and never auto-expires (it only appears in a
// hand-edited or externally restored store, because every claim this tool makes
// carries a lease).
const isExpired = (item: TaskItem, now: number): boolean =>
    item.leaseUntil !== undefined && item.leaseUntil <= now;

// The one message every blocked write and every blocked claim shows. An
// indefinite claim has no ISO expiry to name, so it says "forever" instead of
// inventing a timestamp.
//
// It RETURNS A HarnessError (not a bare string) because every other rejection in
// this tool does: a host that catches by type — or a lane that classifies the
// failure — sees the same shape for a blocked claim as for a stale write. The
// message text is a wire value (harness.ts renders it as
// `Tool "task" failed: <message>`), so only the thrown TYPE changes here.
const claimMessage = (item: TaskItem): HarnessError => {
    const until = item.leaseUntil === undefined ? 'forever' : `until ${new Date(item.leaseUntil).toISOString()}`;

    return new HarnessError(
        `task "${item.id}" is claimed by "${item.owner as string}" ${until}; release it or take it over first.`
    );
};

// The actionable message for an identity-carrying write that skipped its CAS token.
const guardedWriteMessage = (id: string): HarnessError =>
    new HarnessError(`guarded write: pass expects [{ id, rev }] for task "${id}" (read it first).`);

// Which content fields the log says changed on `id` after revision `expected`.
// Used for the stale-error hint only, so it is deliberately lenient: whatever the
// log shows is named, and NOTHING is named when the log cannot show an update.
const changedFieldsSince = (
    changes: readonly TaskChange[],
    id: string,
    expected: number
): ContentField[] | undefined => {
    const seen = new Set<ContentField>();

    for (const change of changes) {
        if (change.id !== id || change.op !== 'update') continue;
        if (change.itemRev === undefined || change.itemRev <= expected) continue;

        for (const field of change.fields ?? []) seen.add(field);
    }

    if (seen.size === 0) return undefined;

    // Canonical order, never insertion order.
    return TASK_CONTENT_FIELDS.filter((field) => seen.has(field));
};

// The stale-write message: current revision, last editor, and the fields the log
// can attribute to the gap. `; changed fields: ...` is spliced BEFORE the final
// period so the sentence stays readable when the hint is present and the message
// is byte-identical to the documented base when it is not.
const staleMessage = (item: TaskItem, expected: number, changes: readonly TaskChange[]): string => {
    const fields = changedFieldsSince(changes, item.id, expected);
    const hint = fields === undefined ? '' : `; changed fields: ${fields.join(', ')}`;

    return (
        `task "${item.id}" changed since revision ${expected} ` +
        `(now ${item.rev}, last edited by "${item.updatedBy ?? 'unknown'}"); re-read and retry${hint}.`
    );
};

// Proves a stale content patch is still SAFE to apply (opt-in `mergeDisjoint`).
// Returns the union of the fields every concurrent content change touched, or
// `undefined` when the merge must be refused because coverage is unknown:
//   - the log must contain one update per revision from expected+1 UP TO the
//     record's current rev, with no gap and no duplicate (a FIFO-trimmed window
//     that dropped one of them fails exactly this test);
//   - any logged `remove` of the id means the record was deleted and re-created
//     (a restore can bring an id back), so the live record is not the one the
//     caller read and field-level merging is meaningless;
//   - `add`/`claim`/`release` entries never break coverage: an add is the
//     creation the caller already saw, and ownership events do not move `rev`.
const mergeConcurrentFields = (
    changes: readonly TaskChange[],
    id: string,
    expected: number,
    current: number
): Set<ContentField> | undefined => {
    const union = new Set<ContentField>();
    let covered = 0;

    for (const change of changes) {
        if (change.id !== id) continue;
        if (change.op === 'remove') return undefined;
        if (change.op !== 'update') continue;
        if (change.itemRev === undefined || change.itemRev <= expected) continue;

        // The log is append-only and ascending, so the covered revisions must walk
        // expected+1, expected+2, ... with no hole.
        if (change.itemRev !== expected + covered + 1) return undefined;

        covered += 1;
        for (const field of change.fields ?? []) union.add(field);
    }

    // Anything short of the current revision means the tail is outside the window.
    if (covered !== current - expected) return undefined;

    return union;
};

// Registers one id against the list that named it and rejects a duplicate or a
// cross-list conflict. One id may be touched by exactly ONE operation per call,
// otherwise the last writer would silently win and the model would have no way to
// tell which of its own instructions ran.
const touchId = (touched: Map<string, string>, id: string, list: string): void => {
    const prior = touched.get(id);

    if (prior === undefined) {
        touched.set(id, list);
        return;
    }

    if (prior === list) {
        throw new HarnessError(
            list === 'tasks'
                ? `task "tasks" changes id "${id}" more than once; send one entry per id.`
                : `task "${list}" lists id "${id}" more than once.`
        );
    }

    if (
        (prior === 'tasks' && list === 'remove') ||
        (prior === 'remove' && list === 'tasks')
    ) {
        throw new HarnessError(
            `task id "${id}" appears in both "tasks" and "remove"; change it or remove it, not both.`
        );
    }

    throw new HarnessError(
        `task id "${id}" appears in both "${prior}" and "${list}"; one operation per id per call.`
    );
};

// Reads one of the three id-only ownership lists (`claim`, `release`, `takeover`).
// Same shape rules and the same unknown-id message as `remove`, because a stale
// cursor is the same mistake whichever verb it belongs to.
//
// T1 precedence fix: existence is NOT checked here. The caller defers it to the
// lookup pass (see readPatch) so a `expects` token naming a record another agent
// deleted answers with the removal it actually hit. This helper only does the
// per-element shape checks and registers the id against its list.
const readIdList = (
    value: unknown,
    list: string,
    touched: Map<string, string>,
    lookups: string[]
): string[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw new HarnessError(`task "${list}" must be an array of task id strings when provided.`);
    }

    const ids: string[] = [];

    for (const [index, raw] of (value as unknown[]).entries()) {
        const id = readId(raw, `"${list}[${index}]"`);

        touchId(touched, id, list);
        lookups.push(id);
        ids.push(id);
    }

    return ids;
};

// Validate the WHOLE invocation into a plan before anything is mutated. Every
// rejection lives here: types, unknown ids, duplicates, the conflicting
// `tasks`/`remove`/`claim`/`release`/`takeover` overlap, the guarded-write and CAS
// (stale) rules, the ownership rules, and the record cap. `store` supplies the
// reads the planner needs (lookup by id, current length, the change log, the
// store revision, the caller identity and one frozen `now`) instead of the array
// itself, so two harnesses in one process can never see each other's list.
//
// PASS ORDER IS PART OF THE CONTRACT (T1 review):
//   1. shape      — every argument is type-checked with NO store read at all, so a
//                   malformed call reports its malformed field instead of an id;
//   2. register   — each id is claimed for exactly one list, so the duplicate and
//                   cross-list conflicts are structural and also fire with no store
//                   read. Existence is NOT checked here; it is queued in `lookups`
//                   in caller order (tasks, then remove, then claim/release/takeover);
//   3. removed    — a token whose record is gone answers
//                   `task "<id>" was removed since revision <n>; re-read the list.`
//                   This runs BEFORE the plain lookup, so a `tasks` patch, a
//                   `remove` or a `claim` of an id another agent deleted names the
//                   race the caller actually hit instead of the generic
//                   "no task with id";
//   4. lookup     — an id this call touches that the store does not have (and that
//                   no token names) is `task has no task with id "<id>".`;
//   5. guards     — the lease/identity preconditions, the "token must name an id
//                   this call changes" coverage rule, guarded writes, the CAS
//                   comparison, the claim rules and the record cap.
// Steps 1-5 only read the store, so a rejection anywhere in them leaves items,
// nextId, storeRev and the change log exactly as they were.
const readPatch = (raw: Record<string, unknown>, store: StoreView): TaskPatch => {
    const rawTasks = raw.tasks;
    const rawRemove = raw.remove;

    if (rawTasks !== undefined && !Array.isArray(rawTasks)) {
        throw new HarnessError('task "tasks" must be an array of task objects when provided.');
    }

    if (rawRemove !== undefined && !Array.isArray(rawRemove)) {
        throw new HarnessError('task "remove" must be an array of task id strings when provided.');
    }

    const mergeDisjoint = readMergeDisjoint(raw.mergeDisjoint);
    const leaseMs = readLeaseMs(raw.leaseMs);
    const entries = (rawTasks === undefined ? [] : (rawTasks as unknown[])).map(readEntry);

    // STEP 1 — the CAS tokens are part of the argument shape. Their id/rev checks
    // run here, before any store read, so a malformed token is reported as the
    // typo it is rather than as a lookup result.
    const expects = readExpects(raw.expects);

    // STEP 2 — registration. One id may be touched by exactly one operation: a
    // duplicate inside `tasks` would let the last write win silently, and the same
    // id in `tasks` and `remove` (or in two ownership lists) is a contradiction.
    const touched = new Map<string, string>();
    // Existence checks queued for step 4, in the order they must be reported.
    const lookups: string[] = [];
    const patches: ResolvedEntry[] = [];
    const additions: TaskPatch['additions'] = [];

    for (const entry of entries) {
        if (entry.id === undefined) {
            additions.push({ text: entry.text as string, completed: entry.completed ?? false });
            continue;
        }

        touchId(touched, entry.id, 'tasks');
        lookups.push(entry.id);
        patches.push(entry);
    }

    // Id conflicts inside and across `remove`: a duplicate removal is ambiguous,
    // and patch-plus-remove of the same id is a contradiction the caller must fix.
    const removals: string[] = [];

    for (const [index, value] of (rawRemove === undefined
        ? []
        : (rawRemove as unknown[])
    ).entries()) {
        const id = readId(value, `"remove[${index}]"`);

        touchId(touched, id, 'remove');
        lookups.push(id);
        removals.push(id);
    }

    // The ownership verbs are just as exclusive as everything else: one id, one
    // operation. They run BEFORE the content phases, so a call may claim a record
    // and patch a DIFFERENT one in the same breath.
    const claims = readIdList(raw.claim, 'claim', touched, lookups);
    const releases = readIdList(raw.release, 'release', touched, lookups);
    const takeovers = readIdList(raw.takeover, 'takeover', touched, lookups);

    // STEP 3 — removed-since. Every token is compared against the live store
    // BEFORE any id is looked up for the caller's own sake: an id the store no
    // longer has is the removal the caller hit, whichever half of the call named
    // it (a `tasks` patch, a `remove`, an ownership verb, or the token alone).
    for (const [id, rev] of expects) {
        if (store.find(id) === undefined) {
            throw new HarnessError(`task "${id}" was removed since revision ${rev}; re-read the list.`);
        }
    }

    // STEP 4 — existence. Unchanged contract for a call that sent no token: an id
    // the store does not have is `task has no task with id "<id>".`, reported in
    // the order the lists named it.
    for (const id of lookups) {
        if (store.find(id) === undefined) {
            throw new HarnessError(`task has no task with id "${id}".`);
        }
    }

    // A lease length with nothing to lease it on is a caller mistake (the flag
    // would otherwise silently apply to whoever claims next).
    if (raw.leaseMs !== undefined && claims.length === 0 && takeovers.length === 0) {
        throw new HarnessError('task "leaseMs" needs a "claim" or "takeover" id to apply to.');
    }

    // Ownership needs somebody to own the record. A direct call has no agent, so
    // it cannot claim, release, or take over — that is an explicit error rather
    // than a silent no-op with an empty owner.
    if (
        store.by === undefined &&
        (claims.length > 0 || releases.length > 0 || takeovers.length > 0)
    ) {
        throw new HarnessError(
            'task "claim", "release" and "takeover" need an agent identity; call the tool through a harness.'
        );
    }

    // STEP 5 — coverage. A token for a LIVE record nobody touches guards nothing,
    // so it is rejected rather than ignored (a removed token was already answered
    // by step 3, which runs first precisely because that is the race in the field).
    for (const id of expects.keys()) {
        if (!touched.has(id)) {
            throw new HarnessError(`task "expects" names id "${id}", which this call does not change.`);
        }
    }

    // GUARDED WRITES. A call with an agent identity (model, manual, worker) may
    // only patch or remove a record it has read: the token is the proof. An
    // identity-less direct/driver call keeps the pre-T1 blind-write behaviour.
    if (store.by !== undefined) {
        for (const entry of patches) {
            if (!expects.has(entry.id as string)) throw guardedWriteMessage(entry.id as string);
        }

        for (const id of removals) {
            if (!expects.has(id)) throw guardedWriteMessage(id);
        }
    }

    // COMPARE-AND-SWAP. A token that does not match the stored content revision
    // means somebody else got there first. Only `mergeDisjoint` can rescue it, and
    // only for a content patch whose fields provably do not collide.
    const patchById = new Map<string, ResolvedEntry>();

    for (const entry of patches) patchById.set(entry.id as string, entry);

    for (const [id, expected] of expects) {
        const item = store.find(id) as TaskItem;

        if (item.rev === expected) continue;

        const entry = patchById.get(id);

        if (mergeDisjoint && entry !== undefined) {
            const concurrent = mergeConcurrentFields(store.changes(), id, expected, item.rev);

            if (concurrent !== undefined) {
                const clash = TASK_CONTENT_FIELDS.filter(
                    (field) =>
                        (field === 'text' ? entry.text !== undefined : entry.completed !== undefined) &&
                        concurrent.has(field)
                );

                // Disjoint: the patch applies as-is, and the fields the caller left
                // out keep whatever the concurrent writer stored.
                if (clash.length === 0) continue;

                throw new HarnessError(
                    `task "${id}" changed since revision ${expected} (now ${item.rev}, last edited by ` +
                        `"${item.updatedBy ?? 'unknown'}"); "mergeDisjoint" cannot merge ${clash
                            .map((field) => `"${field}"`)
                            .join(' and ')} because this patch sets it too.`
                );
            }
        }

        throw new HarnessError(staleMessage(item, expected, store.changes()));
    }

    // OWNERSHIP. Claims block foreign CONTENT writes while they are unexpired; an
    // expired claim stops blocking and is cleared (and logged) by whoever writes
    // next. `takeover` is exempt by design — it is the override. An identity-less
    // call is exempt too: it cannot release or take over, so blocking it would
    // lock a driver out of the store until the lease happens to expire.
    const expired: string[] = [];

    if (store.by !== undefined) {
        for (const id of claims) {
            const item = store.find(id) as TaskItem;

            if (isHolder(item, store.by, store.threadId)) continue;
            if (item.owner !== undefined && !isExpired(item, store.now)) throw claimMessage(item);
        }

        for (const id of releases) {
            const item = store.find(id) as TaskItem;

            if (item.owner === undefined || isHolder(item, store.by, store.threadId)) continue;
            if (!isExpired(item, store.now)) throw claimMessage(item);
        }

        for (const id of [...patches.map((entry) => entry.id as string), ...removals]) {
            const item = store.find(id) as TaskItem;

            if (item.owner === undefined || isHolder(item, store.by, store.threadId)) continue;
            if (!isExpired(item, store.now)) throw claimMessage(item);

            // Expired foreign claim: the write clears it. `expired` keeps insertion
            // order, which is also the order the release entries get logged in.
            if (!expired.includes(id)) expired.push(id);
        }
    }

    // Capacity is checked once, after field validation and before any id is
    // consumed: an over-cap batch is an actionable error, and a rejected call
    // never burns an id from the monotonic counter. Removals ARE netted off,
    // because they are applied before the additions (see the apply order below),
    // so a caller may restate a full section in one call.
    const resulting = store.length() - removals.length + additions.length;

    if (resulting > TASK_MAX_RECORDS) {
        throw new HarnessError(
            `task would hold ${resulting} tasks; the maximum is ${TASK_MAX_RECORDS}. Remove one before adding another.`
        );
    }

    return { claims, releases, takeovers, patches, additions, removals, expects, leaseMs, expired };
};

// The per-harness task list. IDs are decimal strings, monotonic for the life of
// this instance, and restart at "1" after reset() (a reset is a clean start: the
// conversation and every id referring to it are gone too).
export const createTaskTool = (): TaskToolset => {
    const items: TaskItem[] = [];
    const changes: TaskChange[] = [];
    let nextId = 1;
    let storeRev = 0;

    const findItem = (id: string): TaskItem | undefined =>
        items.find((candidate) => candidate.id === id);

    // Records one accepted store event: bump the revision, append the entry with
    // that revision, and keep the window bounded. `entry` carries everything but
    // `rev`, so no caller can log an event with a hand-picked revision.
    const pushChange = (entry: Omit<TaskChange, 'rev'>): void => {
        storeRev += 1;
        changes.push({ rev: storeRev, ...entry });

        if (changes.length > TASK_MAX_CHANGES) {
            changes.splice(0, changes.length - TASK_MAX_CHANGES);
        }
    };

    // Index of the first record whose numeric id is strictly greater than the
    // cursor. The source is a numeric-sorted COPY: a normal store is already in
    // that order, but a restored or hand-edited one may not be, and keyset paging
    // is only correct over a stable order.
    const firstIndexAfter = (ordered: readonly TaskItem[], afterId: number): number => {
        let index = 0;

        while (index < ordered.length && Number(ordered[index].id) <= afterId) index += 1;

        return index;
    };

    // Build one budgeted page of the CURRENT store, plus the store revision and,
    // when `since` was asked for, the change feed:
    //   - items are copied first, so the live store is never handed out;
    //   - they are added while the serialized UTF-8 size stays inside
    //     TASK_RESPONSE_BUDGET_BYTES (a comma per item is counted too);
    //   - the first item of a non-empty page is always included: one record can be
    //     at most ~4 KB, so this cannot blow the budget, and it guarantees the
    //     cursor always advances (no stall, no gaps);
    //   - `hasMore` is computed against the full ordered length, so a
    //     budget-truncated page reports the cursor of its last included item
    //     rather than offset + limit;
    //   - changes are the LAST thing added to the budget: the page the caller
    //     asked for is authoritative, and a trimmed feed says so via
    //     `changesHasMore`.
    // The read path and every mutation result both go through here, which is what
    // makes the response shape identical in every case.
    const project = (request: {
        offset: number;
        limit: number;
        afterId?: string;
        since?: number;
    }): TaskResult => {
        const keyset = request.afterId !== undefined;
        const ordered: readonly TaskItem[] = keyset
            ? [...items].sort((left, right) => Number(left.id) - Number(right.id))
            : items;
        const start = keyset
            ? firstIndexAfter(ordered, Number(request.afterId))
            : request.offset;

        const tasks: TaskItem[] = [];
        let bytes = 0;

        for (const item of ordered.slice(start, start + request.limit)) {
            const copy = copyItem(item);
            const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

            if (tasks.length > 0 && bytes + size > TASK_RESPONSE_BUDGET_BYTES) break;

            tasks.push(copy);
            bytes += size;
        }

        const consumed = start + tasks.length;
        const page: TaskPageInfo = {
            // Keyset mode reports the EFFECTIVE index of the first included record
            // (an empty page reports the ordered length, i.e. "nothing after the
            // cursor"); offset mode echoes the cursor the caller asked for.
            offset: keyset && tasks.length === 0 ? ordered.length : start,
            limit: request.limit,
            hasMore: consumed < ordered.length
        };

        if (keyset) page.afterId = request.afterId as string;

        if (page.hasMore) {
            if (keyset) page.nextAfterId = tasks[tasks.length - 1].id;
            else page.nextOffset = consumed;
        }

        const result: TaskResult = { tasks, counts: countsOf(items), page, storeRev };

        // Copy the watermark into a const so the narrowing survives into the filter
        // callback (a property access is not narrowed inside a closure).
        const since = request.since;

        if (since === undefined) return result;

        const feed = changes.filter((change) => change.rev > since);
        const limited = feed.slice(0, TASK_MAX_CHANGES_IN_RESULT);

        // The window is FIFO-trimmed, so a reader that fell behind the oldest
        // retained event never sees the whole gap. Say so, rather than handing back
        // a short list that looks complete.
        const truncated =
            since < storeRev && (changes.length === 0 || changes[0].rev > since + 1);

        // Same first-entry-always-fits rule as the page: a change entry is ~100
        // bytes, so one can never blow the budget, and a feed that only reports
        // "more exist" after every 4 KB page would be useless.
        let used = Buffer.byteLength(JSON.stringify(result), 'utf8');
        const kept: TaskChange[] = [];

        for (const change of limited) {
            const copy = copyChange(change);
            const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

            if (kept.length > 0 && used + size > TASK_RESPONSE_BUDGET_BYTES) break;

            kept.push(copy);
            used += size;
        }

        result.changes = kept;
        // Covers BOTH ways the feed gets cut: the entry cap and the byte budget.
        result.changesHasMore = kept.length < feed.length;
        result.changesTruncated = truncated;

        return result;
    };

    const implementation = tool<TaskParameters, TaskResult>({
        name: TASK_METADATA.name,
        description: TASK_METADATA.description,
        tags: TASK_METADATA.tags,
        visibility: TASK_METADATA.visibility,
        parameters: TASK_METADATA.parameters,
        execute: ({ parameters, agent, threadId }) => {
            // A model can pass anything. "No arguments" (undefined, or a JSON null
            // body) is the documented READ; anything else that is not a record is
            // one readable error, so everything below can assume a record.
            const raw: Record<string, unknown> = isRecord(parameters) ? parameters : {};

            if (parameters !== undefined && parameters !== null && !isRecord(parameters)) {
                throw new HarnessError(
                    'task expects an object with optional "tasks" and "remove" arrays.'
                );
            }

            // Identity comes from the context, never from the arguments. `by` is
            // what makes a write guarded, an owner, or attributed. `Agent.name` is
            // a required field, so "an agent is present" and "a name is present" are
            // the same test; the optional chain only covers a context with NO agent
            // at all (a direct tool()/driver call).
            const by = agent?.name;
            const now = Date.now();

            // The pagination cursor is validated for every call, so a stray
            // `limit: 500` beside a patch is reported instead of ignored.
            const offset = readOffset(raw.offset);
            const limit = readLimit(raw.limit);
            const afterId = readAfterId(raw.afterId);
            const since = readSince(raw.since);

            // The two cursors mean different things (an index vs. an id) and a
            // caller that sends both has not decided which page it wants.
            if (afterId !== undefined && raw.offset !== undefined) {
                throw new HarnessError('task "afterId" and "offset" cannot be combined.');
            }

            // Asking for events the store has not produced yet is a bug, not an
            // empty answer: it usually means the caller sent a page revision.
            if (since !== undefined && since > storeRev) {
                throw new HarnessError(
                    `task "since" is revision ${since}, ahead of the store (storeRev ${storeRev}); read the list first.`
                );
            }

            // Validate everything, then mutate. Nothing between this line and the
            // application loops below can throw, so the store is never half-patched
            // — including a rejected CAS, which leaves items, nextId, storeRev and
            // the change log exactly as they were.
            const plan = readPatch(raw, {
                find: findItem,
                length: () => items.length,
                changes: () => changes,
                now,
                ...(by === undefined ? {} : { by }),
                ...(threadId === undefined ? {} : { threadId })
            });

            // -----------------------------------------------------------------
            // APPLY — the only mutating step. One timestamp for the whole call, so
            // every attribution and every change entry of one call agrees.
            // -----------------------------------------------------------------
            const at = new Date(now).toISOString();

            // Attribution and change-entry identity only name the fields that are
            // actually present: an identity-less call must not write `undefined`
            // keys into a store that later has to serialize and revalidate them.
            const identity = by === undefined ? {} : { by };
            const sourceThread = threadId === undefined ? {} : { threadId };

            const writeAttribution = (item: TaskItem): void => {
                // `updatedAt` is a fact about this write and always moves; who did
                // it is only knowable when the caller had an identity.
                item.updatedAt = at;
                if (by !== undefined) item.updatedBy = by;
                if (threadId !== undefined) item.updatedThreadId = threadId;
            };

            const setClaim = (item: TaskItem): void => {
                item.owner = by as string;

                // The holder pair must be EXACT: a claim from an unthreaded caller
                // clears a previous thread tag rather than keeping it.
                if (threadId === undefined) delete item.ownerThreadId;
                else item.ownerThreadId = threadId;

                item.leaseUntil = now + plan.leaseMs;
            };

            // Clearing a claim is the only ownership action that is always logged:
            // a reader polling `since` must be able to tell "the lock lifted" from
            // "nothing happened".
            const clearClaim = (item: TaskItem): void => {
                delete item.owner;
                delete item.ownerThreadId;
                delete item.leaseUntil;

                writeAttribution(item);
                pushChange({ id: item.id, op: 'release', ...identity, ...sourceThread, at });
            };

            // 1. Claims. A renewal by the same holder changes NOTHING observable
            //    except `leaseUntil` — no content rev, no storeRev, no change entry
            //    — because a heartbeat must not invalidate anybody's CAS token.
            for (const id of plan.claims) {
                const item = findItem(id) as TaskItem;

                if (isHolder(item, by, threadId)) {
                    item.leaseUntil = now + plan.leaseMs;
                    continue;
                }

                setClaim(item);
                writeAttribution(item);
                pushChange({ id, op: 'claim', ...identity, ...sourceThread, at });
            }

            // 2. Releases. Unowned is a no-op success (nothing to lift, so nothing
            //    to log). A foreign claim only reaches here when it has expired, and
            //    clearing it is still worth a change entry.
            for (const id of plan.releases) {
                const item = findItem(id) as TaskItem;

                if (item.owner === undefined) continue;

                clearClaim(item);
            }

            // 3. Takeovers — the deliberate override of a live claim. Logged as a
            //    `claim` because from the reader's side it is one: the holder changed.
            for (const id of plan.takeovers) {
                const item = findItem(id) as TaskItem;

                if (isHolder(item, by, threadId)) {
                    item.leaseUntil = now + plan.leaseMs;
                    continue;
                }

                setClaim(item);
                writeAttribution(item);
                pushChange({ id, op: 'claim', ...identity, ...sourceThread, at });
            }

            // 4. Expired foreign claims on records this call is about to change.
            for (const id of plan.expired) {
                clearClaim(findItem(id) as TaskItem);
            }

            // 5. Patches: an existing item keeps its position and its id, and only
            //    the fields the caller named change. A patch whose named fields
            //    already hold those values is a SUCCESS with no event — no rev bump,
            //    no attribution, no log entry — so re-sending the same list cannot
            //    flood the change log or knock every reader off its revision.
            for (const entry of plan.patches) {
                const item = findItem(entry.id as string) as TaskItem;
                const fields: ContentField[] = [];

                if (entry.text !== undefined && entry.text !== item.text) fields.push('text');
                if (entry.completed !== undefined && entry.completed !== item.completed) {
                    fields.push('completed');
                }

                if (fields.length === 0) continue;

                item.rev += 1;

                if (fields.includes('text')) item.text = entry.text as string;
                if (fields.includes('completed')) item.completed = entry.completed as boolean;

                writeAttribution(item);
                pushChange({
                    id: item.id,
                    op: 'update',
                    ...identity,
                    ...sourceThread,
                    at,
                    fields,
                    itemRev: item.rev
                });
            }

            // 6. Removals, so a caller can restate a section in one call: the
            //    freed slots do not shift the additions, which stay appended last.
            for (const id of plan.removals) {
                const index = items.findIndex((candidate) => candidate.id === id);

                if (index === -1) continue;

                items.splice(index, 1);
                pushChange({ id, op: 'remove', ...identity, ...sourceThread, at });
            }

            // 7. Additions last, in caller order, taking ids from the monotonic
            //    counter (a removed id is never reused within this instance). A new
            //    record starts at content rev 1, attributed when the caller has an
            //    identity.
            for (const addition of plan.additions) {
                const id = String(nextId);
                const item: TaskItem = {
                    id,
                    text: addition.text,
                    completed: addition.completed,
                    rev: 1
                };

                writeAttribution(item);
                items.push(item);
                nextId += 1;

                pushChange({ id, op: 'add', ...identity, ...sourceThread, at, itemRev: 1 });
            }

            return project({ offset, limit, ...(afterId === undefined ? {} : { afterId }), ...(since === undefined ? {} : { since }) });
        }
    });

    return {
        tool: implementation,
        // Clear the list, the id counter, the revision and the log: reset() is
        // "start over", so the next session-shaped conversation sees the same ids
        // AND the same storeRev 0 a new harness would. No persistence, no shared
        // module state.
        reset: () => {
            items.splice(0, items.length);
            nextId = 1;
            storeRev = 0;
            changes.splice(0, changes.length);
        },
        // Copy out: a snapshot must never alias the live list, or a caller could
        // mutate session state by editing a saved object. The T1 fields are part of
        // the copy, so a restore brings back the claims and the feed window too.
        snapshot: () => ({
            items: items.map(copyItem),
            nextId,
            storeRev,
            changes: changes.map(copyChange)
        }),
        // Validate into a copy first, then replace the closure state in one step.
        // The records are already copies from readTaskStoreState, so the live store
        // is not aliased either.
        restore: (state: unknown) => {
            const restored = readTaskStoreState(state);

            items.splice(0, items.length, ...restored.items);
            nextId = restored.nextId;
            storeRev = restored.storeRev ?? 0;
            changes.splice(0, changes.length, ...(restored.changes ?? []));
        },
        // Lifecycle hook: a stopped or deleted thread must not keep the shared list
        // locked. Clears every claim tagged with this thread id — no agent name is
        // implied, so the change entries carry only the thread id — and reports how
        // many records it freed. Content revisions stay untouched.
        releaseThread: (threadId: string): number => {
            if (typeof threadId !== 'string' || threadId.length === 0) {
                throw new HarnessError('task releaseThread requires a non-empty thread id string.');
            }

            const at = new Date().toISOString();
            let released = 0;

            for (const item of items) {
                if (item.ownerThreadId !== threadId) continue;

                delete item.owner;
                delete item.ownerThreadId;
                delete item.leaseUntil;

                pushChange({ id: item.id, op: 'release', threadId, at });
                released += 1;
            }

            return released;
        }
    };
};

// ---------------------------------------------------------------------------
// Snapshot validation (R3a + T1)
// ---------------------------------------------------------------------------
//
// Exact-key lists. `optional` keys may be absent (a pre-T1 record has none of
// them) but are still the only other keys permitted, so a typo in a persisted
// field is data loss that gets reported instead of dropped.
const ITEM_KEYS = [
    'id',
    'text',
    'completed',
    'rev',
    'updatedBy',
    'updatedThreadId',
    'updatedAt',
    'owner',
    'ownerThreadId',
    'leaseUntil'
] as const;

const ITEM_OPTIONAL = [
    'rev',
    'updatedBy',
    'updatedThreadId',
    'updatedAt',
    'owner',
    'ownerThreadId',
    'leaseUntil'
] as const;

const CHANGE_KEYS = ['rev', 'id', 'op', 'by', 'threadId', 'at', 'fields', 'itemRev'] as const;

const CHANGE_OPTIONAL = ['by', 'threadId', 'fields', 'itemRev'] as const;

// `leaseUntil` is an epoch-ms instant, not a counter, so it is validated as a
// finite POSITIVE NUMBER rather than through readSnapshotInteger (a sub-second
// lease or an externally produced timestamp must not fail a restore).
const readSnapshotNumber = (value: unknown, label: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new HarnessError(`${label} must be a finite positive number.`);
    }

    return value;
};

// One change op, checked against the union rather than accepted as any string, so
// a log written by a newer build fails loudly instead of replaying as garbage.
const readSnapshotChangeOp = (value: unknown, label: string): TaskChangeOp => {
    const op = readSnapshotString(value, label, { min: 1 });

    if (!TASK_CHANGE_OPS.includes(op as TaskChangeOp)) {
        throw new HarnessError(`${label} must be one of: ${TASK_CHANGE_OPS.join(', ')}.`);
    }

    return op as TaskChangeOp;
};

// The changed-field list of an `update`: unique, drawn from the two content
// fields, and normalized into the canonical order so a restored log compares
// equal to a live one.
const readSnapshotChangeFields = (value: unknown, label: string): ContentField[] => {
    const entries = readSnapshotArray(value, label);

    if (entries.length > TASK_CONTENT_FIELDS.length) {
        throw new HarnessError(`${label} must list at most ${TASK_CONTENT_FIELDS.length} fields.`);
    }

    const seen = new Set<string>();

    for (const entry of entries) {
        const field = readSnapshotString(entry, label, { min: 1 });

        if (!TASK_CONTENT_FIELDS.includes(field as ContentField)) {
            throw new HarnessError(`${label} entries must be one of: ${TASK_CONTENT_FIELDS.join(', ')}.`);
        }

        if (seen.has(field)) throw new HarnessError(`${label} lists "${field}" more than once.`);

        seen.add(field);
    }

    return TASK_CONTENT_FIELDS.filter((field) => seen.has(field as ContentField));
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
// T1 keeps that promise: `storeRev` and `changes` are OPTIONAL keys and default to
// 0 / [], and a record without `rev` defaults to 1 — the revision it was created
// with. Everything else is checked, because the invariants below mirror the
// mutations above: ids are unique decimal strings, text is non-empty and inside
// TASK_MAX_TEXT, the record cap holds, nextId is greater than every stored id (so
// the next add cannot collide), a lease only exists under a holder, the change
// window is bounded and ascending, and storeRev is never behind its newest event.
export const readTaskStoreState = (value: unknown): TaskStoreState => {
    const root = readSnapshotRecord(value, 'todo state');
    readSnapshotKeys(root, ['items', 'nextId', 'storeRev', 'changes'], 'todo state', [
        'storeRev',
        'changes'
    ]);

    const entries = readSnapshotArray(root.items, 'todo state.items');

    if (entries.length > TASK_MAX_RECORDS) {
        throw new HarnessError(
            `todo state holds ${entries.length} todos; the maximum is ${TASK_MAX_RECORDS}.`
        );
    }

    const items = entries.map((entry, index) => {
        const label = `todo state.items[${index}]`;
        const record = readSnapshotRecord(entry, label);
        readSnapshotKeys(record, ITEM_KEYS, label, ITEM_OPTIONAL);

        const item: TaskItem = {
            id: readSnapshotId(record.id, `${label}.id`),
            text: readSnapshotString(record.text, `${label}.text`, {
                min: 1,
                max: TASK_MAX_TEXT
            }),
            completed: readSnapshotBoolean(record.completed, `${label}.completed`),
            rev:
                record.rev === undefined
                    ? 1
                    : readSnapshotInteger(record.rev, `${label}.rev`, { min: 1 })
        };

        // Optional fields are only copied when PRESENT, so a restored pre-T1 record
        // stays byte-identical to what this tool would have written for it.
        if (record.updatedBy !== undefined) {
            item.updatedBy = readSnapshotString(record.updatedBy, `${label}.updatedBy`, { min: 1 });
        }

        if (record.updatedThreadId !== undefined) {
            item.updatedThreadId = readSnapshotString(record.updatedThreadId, `${label}.updatedThreadId`, {
                min: 1
            });
        }

        if (record.updatedAt !== undefined) {
            item.updatedAt = readSnapshotString(record.updatedAt, `${label}.updatedAt`, { min: 1, max: 64 });
        }

        // `leaseUntil` is read BEFORE `owner` so the pair can be cross-checked, but
        // inserted after it to keep the canonical key order of the copy.
        const leaseUntil =
            record.leaseUntil === undefined
                ? undefined
                : readSnapshotNumber(record.leaseUntil, `${label}.leaseUntil`);

        if (record.owner !== undefined) {
            item.owner = readSnapshotString(record.owner, `${label}.owner`, { min: 1 });
        }

        if (record.ownerThreadId !== undefined) {
            item.ownerThreadId = readSnapshotString(record.ownerThreadId, `${label}.ownerThreadId`, {
                min: 1
            });
        }

        if (leaseUntil !== undefined) item.leaseUntil = leaseUntil;

        // An expiry with no holder protects nothing, and an indefinite holder whose
        // thread tag vanished would rename the holder pair: both are rejected rather
        // than silently normalized, because either way the claim a lane restored is
        // not the claim the session wrote.
        if (item.leaseUntil !== undefined && item.owner === undefined) {
            throw new HarnessError(`${label}.leaseUntil needs "owner".`);
        }

        return item;
    });

    const nextId = readSnapshotIdCounter(
        items.map((item) => item.id),
        root.nextId,
        'todo state'
    );

    const storeRev =
        root.storeRev === undefined
            ? 0
            : readSnapshotInteger(root.storeRev, 'todo state.storeRev', { min: 0 });

    const changeEntries =
        root.changes === undefined
            ? []
            : readSnapshotArray(root.changes, 'todo state.changes');

    if (changeEntries.length > TASK_MAX_CHANGES) {
        throw new HarnessError(
            `todo state.changes holds ${changeEntries.length} changes; the maximum is ${TASK_MAX_CHANGES}.`
        );
    }

    const changeList = changeEntries.map((entry, index): TaskChange => {
        const label = `todo state.changes[${index}]`;
        const record = readSnapshotRecord(entry, label);
        readSnapshotKeys(record, CHANGE_KEYS, label, CHANGE_OPTIONAL);

        return {
            // Bounded by storeRev: an event cannot be newer than the store that
            // claims to have recorded it.
            rev: readSnapshotInteger(record.rev, `${label}.rev`, { min: 1, max: storeRev }),
            id: readSnapshotId(record.id, `${label}.id`),
            op: readSnapshotChangeOp(record.op, `${label}.op`),
            ...(record.by === undefined
                ? {}
                : { by: readSnapshotString(record.by, `${label}.by`, { min: 1 }) }),
            ...(record.threadId === undefined
                ? {}
                : { threadId: readSnapshotString(record.threadId, `${label}.threadId`, { min: 1 }) }),
            at: readSnapshotString(record.at, `${label}.at`, { min: 1, max: 64 }),
            ...(record.fields === undefined
                ? {}
                : { fields: readSnapshotChangeFields(record.fields, `${label}.fields`) }),
            ...(record.itemRev === undefined
                ? {}
                : { itemRev: readSnapshotInteger(record.itemRev, `${label}.itemRev`, { min: 1 }) })
        };
    });

    // The log is append-only, so its revisions strictly rise and can never
    // overtake the store revision they were assigned under.
    let previousRev = 0;

    for (const change of changeList) {
        if (change.rev <= previousRev) {
            throw new HarnessError(
                `todo state.changes must be ordered by a rising rev; ${change.rev} follows ${previousRev}.`
            );
        }

        previousRev = change.rev;
    }

    if (storeRev < previousRev) {
        throw new HarnessError(
            `todo state.storeRev must be at least the newest change revision (${previousRev}); received ${storeRev}.`
        );
    }

    return { items, nextId, storeRev, changes: changeList };
};
