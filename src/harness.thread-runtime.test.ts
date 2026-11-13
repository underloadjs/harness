// Persistent agent threads (R2) + cross-thread chat (R4) + steering (R5) +
// selective stop/delete (R6).
//
// Contract pinned here (see src/types/index.ts and src/harness.ts):
//   R2  Every configured agent owns `agent:<name>` (its registry transcript); a
//       host thread (`createThread`) is an INDEPENDENT conversation of the same
//       agent. Two threads of one agent run concurrently, serialize WITHIN
//       themselves, and share this harness's stores (todos) — the session's
//       shared memory, not its conversations.
//   R4  A delegation links the child's default thread to the caller; `threadSend`
//       attributes the message to the runtime-derived sender and delivers it
//       STATE-AWARE: steered into the live run at its next boundary while the
//       target is running (`queued`), and a dormant target is STARTED with the
//       message as its prompt (`started`) — see the delegate-stress T3 group at
//       the end of this file.
//   R5  Steering never interrupts an in-flight request: queued text becomes a
//       user message at the loop boundary, in receipt order.
//   R6  stopThread aborts one conversation (and owner-linked children) and marks
//       it stopped; stopAllThreads aborts every active run; deleteThread purges a
//       terminal host conversation plus its invocation and branch lookups, and the
//       receipt NAMES what it purged (see the stress-report group below).
//   B3/B4/B5 (2026-11-13, thread-tools wave) The THREAD FAMILY is the visibility
//       unit: a caller that names a thread (`callerThreadId` on `harness.thread` /
//       `harness.threadMessages`, the tool context of `threadRead`/`threadSend`/
//       `threadDelete`) sees itself, its ancestors, its descendants, and the
//       DEFAULT conversations of exactly those agents — siblings are refused with
//       `threadNotVisibleError`, and `deleteThread` narrows that to strict
//       descendants only. A threadless caller (the host, `api.threads.*`, a
//       context-less `executeTool`) stays UNSCOPED: the full roster, no send
//       guards, no read gate. `threadSend` into another agent's DEFAULT
//       conversation still lands, but answers with a `note` naming the live thread
//       to address instead, and `deleteThread` returns a
//       `HarnessThreadDeleteResult` receipt (`deleted` + `removedThreadIds` +
//       `removedInvocationIds` + `removedBranchIds`) so a cascade is observable —
//       see the group of the same name at the end of this file.
//   STRESS REPORT #4/#5 (2026-11-14) The family rules and the visible/invisible
//       VERDICTS are frozen; three refusals were given truthful, actionable text:
//       a BRANCH id on a delete door (`branch-N` is a fork record, not an unknown
//       conversation — src/harness.fork.test.ts), and a DEFAULT conversation that
//       left the family (the cause, plus the `delegate` that re-admits it — the
//       #5 case below). A non-default out-of-family id keeps its old sentence byte
//       for byte.
//
// Clock policy: the CLOCK is pinned (see EPOCH_MS below), the SCHEDULER is not.
// Every task-store timestamp (`updatedAt`, the change-feed `at`, a claim's
// `leaseUntil`) comes from Date in src/core/task.ts, so pinning Date gives each of
// them ONE exact expected value. `toFake: ['Date']` leaves setTimeout and the
// microtask queue real, which the gated transports and `flush()` here depend on.
// The 2026-11-09 policy test *a host turn has no wall-clock bound* uses exactly that
// split: moving Date with no fake timers is the probe for a deadline-style bound,
// while the timer-style half is covered in src/harness.fork.test.ts.

// `node:fs` here serves the parity pin in the last group below, which compares the refusal
// wording ACROSS production source files. Reading source text in a test weakens nothing: the
// package's lazy/browser contract is asserted separately (src/core/tool-discovery.test.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    Harness,
    HarnessAssistantMessage,
    HarnessSnapshot,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessThreadRecord,
    TaskChange,
    TaskChangeOp,
    TaskItem,
    TaskResult
} from '@underload/harness';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

// Replay scripted frames, one list per request; the last list repeats.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}): Agent =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

const quiet = (entry: Agent, tools: Record<string, any> = {}) =>
    harness({ agents: { writer: entry }, tools, presets: false });

// Drain microtasks and a zero-delay timer so the harness chain reaches its next
// resting point without depending on wall-clock time.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let pass = 0; pass < 16; pass += 1) await Promise.resolve();
};

// Join a run the harness started FIRE-AND-FORGET. A `threadSend` into a dormant
// conversation returns its receipt WITHOUT awaiting the answer (T3.2), so no caller
// holds that promise and a test that asserts the answer has to wait for the
// conversation to come back to 'idle'. The bound is a failure, not a hang: a run
// that never settles breaks this assertion instead of the test timeout.
const settleThread = async (host: Harness, threadId: string): Promise<void> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await flush();
        if (host.thread(threadId)?.status === 'idle') return;
    }

    throw new Error(`Thread "${threadId}" never returned to idle after a detached run.`);
};

type Gate = {
    promise: Promise<void>;
    open: () => void;
};

const gate = (): Gate => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
};

// A transport that records how many requests arrived, waits for the gate, then
// answers with one text frame. `arrivals` is what proves two threads ran at once.
const gatedAnswer = (text: string) => {
    const ready = gate();
    let arrivals = 0;
    const stream: HarnessStream = async function* () {
        arrivals += 1;
        await ready.promise;
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };
    return { stream, ready, arrivals: () => arrivals };
};

// One configured agent whose transport dispatches on the prompt, so several
// threads (which all derive from the same agent factory) can have independent
// scripts inside one harness.
const routed = (routes: Record<string, HarnessStream>, fallback: HarnessStream): HarnessStream =>
    async function* (request) {
        // Route on the thread's FIRST user prompt: later tool-result turns keep
        // the same conversation, so the last message is not a stable key.
        const prompt = request.messages.find((message) => message.role === 'user') as
            | { content?: string }
            | undefined;
        const chosen = routes[prompt?.content ?? ''] ?? fallback;
        yield* chosen(request);
    };

// Attach handlers immediately so a cancellation rejection is never unhandled.
const probe = <T>(promise: Promise<T>) => {
    const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
        status: 'pending'
    };
    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error) => {
            state.status = 'rejected';
            state.error = error;
        }
    );
    return state;
};

const roles = (messages: { role: string }[]): string[] => messages.map((message) => message.role);

const textOf = (messages: { content?: string }[]): string[] =>
    messages.map((message) => message.content ?? '');

// T28: a delegate result is an ENVELOPE (identity + paged content), not the old
// `{ agent, content }` pair. These tests are about which answer crossed back and which
// conversation it belongs to, so they project the fields they mean.
const delegationOf = (message: { content: string }): Record<string, any> =>
    JSON.parse(message.content) as Record<string, any>;

// ---------------------------------------------------------------------------
// T1 (Phase 2) task-claim fixtures
// ---------------------------------------------------------------------------

// THE FROZEN CLOCK, and the expiry of a claim taken at that instant (the tool's
// default lease, src/core/task.ts TASK_DEFAULT_LEASE_MS).
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);

beforeEach(() => {
    // Date only: the transports, the scheduler and `flush()` keep real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EPOCH_MS);
});

afterEach(() => {
    vi.useRealTimers();
});

type RecordShape = {
    completed?: boolean;
    rev?: number;
    // The WRITER's identity (attribution), and the HOLDER's pair (the claim). They
    // are separate facts: a lifecycle release clears the holder and keeps the
    // writer, and an ownership action never moves `rev`.
    by?: string;
    threadId?: string;
    owner?: string;
    ownerThreadId?: string;
    leaseUntil?: number;
};

// One stored record in the exact key set src/core/task.ts `copyItem` produces.
// `updatedAt` is always present here because every write in this file has an
// identity (a run, or a manual executeTool call as the primary).
const task = (id: string, text: string, shape: RecordShape = {}): TaskItem => ({
    id,
    text,
    completed: shape.completed ?? false,
    rev: shape.rev ?? 1,
    ...(shape.by === undefined ? {} : { updatedBy: shape.by }),
    ...(shape.threadId === undefined ? {} : { updatedThreadId: shape.threadId }),
    updatedAt: EPOCH_ISO,
    ...(shape.owner === undefined ? {} : { owner: shape.owner }),
    ...(shape.ownerThreadId === undefined ? {} : { ownerThreadId: shape.ownerThreadId }),
    ...(shape.leaseUntil === undefined ? {} : { leaseUntil: shape.leaseUntil })
});

// One change-feed entry, in the canonical key order (`rev, id, op, by, threadId,
// at, fields, itemRev`). A lifecycle release (`releaseThread`) is recognisable
// because it names a `threadId` and carries NO `by`, unlike a voluntary one.
const event = (
    rev: number,
    id: string,
    op: TaskChangeOp,
    shape: {
        by?: string;
        threadId?: string;
        fields?: Array<'text' | 'completed'>;
        itemRev?: number;
    } = {}
): TaskChange => ({
    rev,
    id,
    op,
    ...(shape.by === undefined ? {} : { by: shape.by }),
    ...(shape.threadId === undefined ? {} : { threadId: shape.threadId }),
    at: EPOCH_ISO,
    ...(shape.fields === undefined ? {} : { fields: shape.fields }),
    ...(shape.itemRev === undefined ? {} : { itemRev: shape.itemRev })
});

// The live store, read through the host door (identity: the primary, unthreaded).
const storedTasks = async (writer: Harness): Promise<TaskItem[]> =>
    ((await writer.executeTool('tasks', {})) as TaskResult).tasks;

// The whole recorded history of one store (`since: 0`).
const changeFeed = async (writer: Harness): Promise<TaskChange[]> =>
    ((await writer.executeTool('tasks', { since: 0 })) as { changes: TaskChange[] }).changes;

// The recorded tool results of one conversation, in order. A failed call is stored
// as `Tool "<name>" failed: <message>` (src/harness.ts), which is how a refusal
// reaches the model — and how these tests read one.
const toolResultsOf = (messages: { role: string; content?: string }[]): string[] =>
    messages.filter((message) => message.role === 'tool').map((message) => message.content ?? '');

// A recorded task page, parsed: the assertion names the exact page without
// depending on key order in the serialized string.
const pageOf = (content: string): unknown => JSON.parse(content);

describe('persistent agent threads (R2)', () => {
    it('exposes one default conversation per agent and independent host threads', () => {
        const writer = quiet(brain(scripted([answer('unused')])));

        // Default conversations exist before any run, in configuration order.
        expect(writer.threads()).toEqual([
            {
                id: 'agent:writer',
                agent: 'writer',
                origin: 'agent',
                status: 'idle',
                sequence: 1
            }
        ]);
        expect(writer.thread('agent:writer')?.origin).toBe('agent');

        const first = writer.createThread('writer', { label: '  Research  ' });
        const second = writer.createThread('writer');

        expect(first).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 2,
            label: 'Research'
        });
        expect(second.id).toBe('thread-2');
        expect(writer.threads().map((record) => record.id)).toEqual([
            'agent:writer',
            'thread-1',
            'thread-2'
        ]);

        // A read is a detached copy: mutating it never touches live state.
        const copy = writer.thread('thread-1')!;
        copy.status = 'stopped';
        expect(writer.thread('thread-1')?.status).toBe('idle');

        // Unknown ids are honest errors, and the default conversation cannot be
        // deleted (it is the session's own agent history).
        expect(() => writer.threadMessages('thread-99')).toThrow(
            'Thread "thread-99" is not available in this harness; it was never created, or it was deleted.'
        );
        expect(() => writer.deleteThread('agent:writer')).toThrow(
            'Thread "agent:writer" is the agent\'s own conversation and cannot be deleted; use reset() to clear the session.'
        );
        expect(() => writer.createThread('nobody')).toThrow(
            'Agent "nobody" is not registered. Configured agents: writer.'
        );
        expect(() => writer.createThread('writer', { label: '   ' })).toThrow(
            'A thread label must not be blank.'
        );
    });

    it('runs two threads of the same agent concurrently with isolated transcripts', async () => {
        // Concurrency counter: both requests must be in flight at the same time.
        let active = 0;
        let maxActive = 0;
        const seen: string[] = [];

        const stream: HarnessStream = async function* (request) {
            const last = request.messages[request.messages.length - 1] as { content?: string };
            seen.push(last.content ?? '');
            active += 1;
            maxActive = Math.max(maxActive, active);
            // Yield control so a serialized implementation would show active = 1.
            await Promise.resolve();
            yield { type: 'text', delta: `echo:${last.content ?? ''}` };
            active -= 1;
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const a = writer.createThread('writer');
        const b = writer.createThread('writer');

        const [firstAnswer, secondAnswer] = await Promise.all([
            writer.sendThreadInput(a.id, 'alpha'),
            writer.sendThreadInput(b.id, 'beta')
        ]);

        expect(firstAnswer.content).toBe('echo:alpha');
        expect(secondAnswer.content).toBe('echo:beta');
        expect(maxActive).toBe(2);
        expect([...seen].sort()).toEqual(['alpha', 'beta']);

        expect(roles(writer.threadMessages(a.id))).toEqual(['user', 'assistant']);
        expect(textOf(writer.threadMessages(a.id))).toEqual(['alpha', 'echo:alpha']);
        expect(textOf(writer.threadMessages(b.id))).toEqual(['beta', 'echo:beta']);

        // The configured agent's own conversation was not touched.
        expect(writer.agent.messages).toEqual([]);
    });

    it('serializes two turns inside one thread', async () => {
        const first = gatedAnswer('one');
        let requests = 0;

        const stream: HarnessStream = async function* (request) {
            requests += 1;

            if (requests === 1) {
                // Hold the first turn until the queued second input exists.
                yield* first.stream(request);
                return;
            }

            const last = request.messages[request.messages.length - 1] as { content?: string };
            yield { type: 'text', delta: `reply:${last.content ?? ''}` };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');

        const runningPromise = writer.sendThreadInput(thread.id, 'first');
        const running = probe(runningPromise);
        await flush();
        expect(running.status).toBe('pending');
        expect(first.arrivals()).toBe(1);
        expect(writer.thread(thread.id)?.status).toBe('running');

        const queuedPromise = writer.sendThreadInput(thread.id, 'second');
        const queued = probe(queuedPromise);
        await flush();
        // The second turn has NOT started: one thread never executes twice at once.
        expect(first.arrivals()).toBe(1);
        expect(queued.status).toBe('pending');

        first.ready.open();
        await Promise.all([runningPromise, queuedPromise]);

        expect(requests).toBe(2);
        expect(textOf(writer.threadMessages(thread.id))).toEqual([
            'first',
            'one',
            'second',
            'reply:second'
        ]);
    });

    it('follows the owning agent model on each thread run', async () => {
        const models: string[] = [];
        const stream: HarnessStream = async function* (request) {
            models.push(request.model);
            yield { type: 'text', delta: `answer ${models.length}` };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');

        await writer.sendThreadInput(thread.id, 'one');
        // Provenance is the OWNING agent: a host thread is a conversation of that
        // agent, so a model change reaches every live thread on its next run.
        writer.agents.writer.model('second/model');
        await writer.sendThreadInput(thread.id, 'two');
        await writer('three');

        expect(models).toEqual(['merge/ds4-flash', 'second/model', 'second/model']);
        expect(textOf(writer.threadMessages(thread.id))).toEqual([
            'one',
            'answer 1',
            'two',
            'answer 2'
        ]);
    });

    it('shares session tasks across threads without sharing transcripts', async () => {
        const stream = routed(
            {
                // Thread one adds a task, thread two lists it from the same session.
                plan: scripted([
                    callTool('c1', 'tasks', '{"tasks":[{"text":"Shared plan"}]}'),
                    answer('added')
                ]),
                'list it': scripted([
                    callTool('c2', 'tasks', '{}'),
                    answer('listed')
                ])
            },
            scripted([answer('unused')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const planner = writer.createThread('writer');
        const lister = writer.createThread('writer');

        await writer.sendThreadInput(planner.id, 'plan');
        await writer.sendThreadInput(lister.id, 'list it');

        // The second conversation's tool result is the FIRST conversation's task:
        // the store is session state, shared by every thread. T1 adds attribution to
        // every record (`rev`, `updatedBy`, `updatedThreadId`, `updatedAt`) and
        // `storeRev` to every page, and the writer recorded is the conversation that
        // wrote — the same fact a claim is keyed on.
        const toolMessage = writer
            .threadMessages(lister.id)
            .find((message) => message.role === 'tool') as { role: string; content: string };
        expect(toolMessage.role).toBe('tool');
        expect(pageOf(toolMessage.content)).toEqual({
            tasks: [task('1', 'Shared plan', { by: 'writer', threadId: planner.id })],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1
            // R1/T1.1: NO `entry` here on purpose — this is the SECOND conversation's
            // plain read, and a read affects no record. The `entry` the ADD produced is
            // asserted in the cross-conversation comparison further below.
        });

        // Transcripts stay separate.
        expect(roles(writer.threadMessages(lister.id))).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
        expect(textOf(writer.threadMessages(lister.id))).toEqual([
            'list it',
            '',
            toolMessage.content,
            'listed'
        ]);
        expect(roles(writer.threadMessages(planner.id))).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
        // R9-R11: every successful task call answers with the same bounded list, so
        // both conversations recorded the SAME page (one store, one revision).
        //
        // R1/T1.1 — the two answers now differ by exactly ONE per-CALL key: the
        // planner's ADD affected a single record and answers with that record as
        // `entry`, while the lister's plain read affected none. Naming the difference
        // here keeps the comparison exact instead of loosening it into a subset check.
        expect(pageOf(toolResultsOf(writer.threadMessages(planner.id))[0])).toEqual({
            ...(pageOf(toolMessage.content) as Record<string, unknown>),
            entry: task('1', 'Shared plan', { by: 'writer', threadId: planner.id })
        });
        expect(textOf(writer.threadMessages(planner.id))).toEqual([
            'plan',
            '',
            toolResultsOf(writer.threadMessages(planner.id))[0],
            'added'
        ]);
    });
});

describe('steering (R5)', () => {
    it('queues steering at the next safe boundary, in receipt order', async () => {
        const turn = gate();
        const seen: HarnessStreamRequest[] = [];
        let requests = 0;

        const stream: HarnessStream = async function* (request) {
            seen.push(request);
            requests += 1;

            if (requests === 1) {
                await turn.promise;
                yield { type: 'text', delta: 'first answer' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            yield { type: 'text', delta: 'steered answer' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');

        const running = writer.sendThreadInput(thread.id, 'start');
        await flush();
        expect(requests).toBe(1);

        // Both steers are accepted while the first request is still in flight.
        expect(writer.steerThread(thread.id, 'focus one')).toEqual({
            threadId: thread.id,
            queued: true
        });
        expect(writer.steerThread(thread.id, 'focus two')).toEqual({
            threadId: thread.id,
            queued: true
        });

        // Nothing is inserted into the transcript mid-request.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([{ role: 'user', content: 'start' }]);

        turn.open();
        const result: HarnessAssistantMessage = await running;
        expect(result.content).toBe('steered answer');

        // Both steers became user messages, in order, before the second request.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: 'start' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'focus one' },
            { role: 'user', content: 'focus two' },
            { role: 'assistant', content: 'steered answer' }
        ]);
        expect(textOf(seen[1]!.messages)).toEqual([
            'start',
            'first answer',
            'focus one',
            'focus two'
        ]);
    });

    it('steers the callable root through the primary default conversation', async () => {
        const turn = gate();
        let requests = 0;

        const stream: HarnessStream = async function* () {
            requests += 1;

            if (requests === 1) {
                await turn.promise;
                yield { type: 'text', delta: 'root first' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            yield { type: 'text', delta: 'root steered' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });

        const running = writer('brief');
        await flush();
        // The root run owns the primary's default conversation while it executes.
        expect(writer.thread('agent:writer')).toEqual({
            id: 'agent:writer',
            agent: 'writer',
            origin: 'agent',
            status: 'running',
            sequence: 1,
            invocationId: '1'
        });

        expect(writer.steerThread('agent:writer', 'focus root')).toEqual({
            threadId: 'agent:writer',
            queued: true
        });

        turn.open();
        const result = await running;
        expect(result.content).toBe('root steered');
        expect(textOf(writer.threadMessages('agent:writer'))).toEqual([
            'brief',
            'root first',
            'focus root',
            'root steered'
        ]);
        expect(writer.thread('agent:writer')?.status).toBe('idle');
    });

    it('refuses to steer an idle or stopped conversation', () => {
        const writer = quiet(brain(scripted([answer('done')])));
        const thread = writer.createThread('writer');

        expect(writer.steerThread(thread.id, 'later')).toEqual({
            threadId: thread.id,
            queued: false,
            reason: `Thread "${thread.id}" is idle; use sendThreadInput to start a turn.`
        });

        writer.stopThread(thread.id);
        expect(writer.steerThread(thread.id, 'never')).toEqual({
            threadId: thread.id,
            queued: false,
            reason: `Thread "${thread.id}" is stopped; a host must resume it before steering.`
        });
        expect(() => writer.stopThread('thread-404')).toThrow(
            'Thread "thread-404" is not available in this harness; it was never created, or it was deleted.'
        );
    });
});

describe('selective cancellation (R6)', () => {
    it('stops one running thread and leaves its sibling executing', async () => {
        const left = gatedAnswer('left done');
        const right = gatedAnswer('right done');

        const stream = routed(
            { 'left task': left.stream, 'right task': right.stream },
            scripted([answer('unused')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const a = writer.createThread('writer');
        const b = writer.createThread('writer');

        const runningA = probe(writer.sendThreadInput(a.id, 'left task'));
        const runningB = probe(writer.sendThreadInput(b.id, 'right task'));
        await flush();

        expect(left.arrivals()).toBe(1);
        expect(right.arrivals()).toBe(1);
        expect(writer.thread(a.id)?.status).toBe('running');
        expect(writer.thread(b.id)?.status).toBe('running');

        expect(writer.stopThread(a.id, 'stop it')).toBe(true);

        await flush();
        expect(runningA.status).toBe('rejected');
        expect((runningA.error as Error).message).toBe('stop it');
        // A stopped run rolls its prompt back: the conversation keeps no partial turn.
        expect(writer.threadMessages(a.id)).toEqual([]);
        expect(writer.thread(a.id)?.status).toBe('stopped');

        // The sibling is untouched and completes normally.
        expect(runningB.status).toBe('pending');
        right.ready.open();
        await flush();
        expect(runningB.status).toBe('resolved');
        expect(runningB.value?.content).toBe('right done');
        expect(writer.thread(b.id)?.status).toBe('idle');
    });

    it('stops every active run and marks owner-linked children stopped', async () => {
        const one = gatedAnswer('one');
        const two = gatedAnswer('two');

        const stream = routed(
            { one: one.stream, two: two.stream },
            scripted([answer('unused')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const parent = writer.createThread('writer', { label: 'parent' });
        const child = writer.createThread('writer', { ownerThreadId: parent.id });
        const third = writer.createThread('writer');

        const p = probe(writer.sendThreadInput(parent.id, 'one'));
        const t = probe(writer.sendThreadInput(third.id, 'two'));
        await flush();
        expect(one.arrivals()).toBe(1);
        expect(two.arrivals()).toBe(1);

        expect(writer.stopAllThreads('all stop')).toBe(2);
        await flush();

        expect(p.status).toBe('rejected');
        expect(t.status).toBe('rejected');
        expect(writer.thread(parent.id)?.status).toBe('stopped');
        expect(writer.thread(third.id)?.status).toBe('stopped');
        // Owner-linked children are stopped even though they had no active run.
        expect(writer.thread(child.id)?.status).toBe('stopped');
        expect(writer.thread('agent:writer')?.status).toBe('stopped');

        // Let the detached providers settle, then revive one conversation as the
        // host. A host turn is the only path that clears "stopped".
        one.ready.open();
        two.ready.open();
        await writer.sendThreadInput(parent.id, 'one');
        expect(writer.thread(parent.id)?.status).toBe('idle');
        expect(writer.thread(third.id)?.status).toBe('stopped');
    });
});

// ---------------------------------------------------------------------------
// T1 (Phase 2) — a task claim belongs to a conversation, and the conversation's
// lifecycle owns the claim.
// ---------------------------------------------------------------------------
//
// A holder is the pair (owner, ownerThreadId) plus a lease (src/core/task.ts). A
// stopped or deleted conversation can never release or renew what it reserved, so
// `harness` lifts those claims at the boundary itself: `stopThreadState` (the one
// call site every stop path passes: stopThread, its owner cascade, stopAllThreads),
// `purgeThread` (deleteThread and its cascade), `removeAgent` (the default
// conversation it drops without a purge), and `restore` (a snapshot that carries a
// claim for a thread the snapshot does not). Each release is one recorded
// `release` event with the thread id and NO `by`, so the feed says who lifted it.
describe('task claim ownership across the thread lifecycle', () => {





});

// Poll a predicate with microtask/timer flushes until it holds or the bound is
// exhausted. The gates keep the conditions stable, so this waits for scheduling
// progress rather than for a timeout to guess.
const until = async (predicate: () => boolean, detail?: () => unknown): Promise<void> => {
    for (let pass = 0; pass < 50; pass += 1) {
        if (predicate()) return;
        await flush();
    }
    if (!predicate()) {
        throw new Error(`until: condition not reached: ${JSON.stringify(detail?.() ?? null)}`);
    }
};

describe('host-parent delegation (R4)', () => {
    // A lead agent that delegates the prompt-derived task to `helper` and then
    // answers. The FIRST user prompt routes the whole conversation, so the
    // post-tool-result request reuses the same script.
    const leadStream = (prefix: string) =>
        routed(
            {
                [`${prefix} task`]: scripted([
                    callTool('d1', 'delegate', JSON.stringify({ agent: 'helper', input: `child ${prefix}` })),
                    answer('parent done')
                ])
            },
            scripted([answer('unused')])
        );

    const build = () => {
        const alphaChild = gatedAnswer('alpha facts');
        const betaChild = gatedAnswer('beta facts');
        const helper = brain(
            routed(
                { 'child alpha': alphaChild.stream, 'child beta': betaChild.stream },
                scripted([answer('unused')])
            )
        );
        const lead = brain(
            routed(
                {
                    'alpha task': leadStream('alpha'),
                    'beta task': leadStream('beta')
                },
                scripted([answer('unused')])
            )
        );

        const writer = harness({
            agents: { lead, helper },
            primary: 'lead',
            subagents: ['helper'],
            presets: false
        });

        return { writer, helper, alphaChild, betaChild };
    };

    it('gives concurrent host parents independent child conversations', async () => {
        const { writer, helper, alphaChild, betaChild } = build();

        const alpha = writer.createThread('lead');
        const beta = writer.createThread('lead');

        const alphaRun = writer.sendThreadInput(alpha.id, 'alpha task');
        const betaRun = writer.sendThreadInput(beta.id, 'beta task');

        // Both delegations are in flight AT THE SAME TIME (each child thread has
        // its own actor slot), which a shared default conversation could not do.
        await until(
            () =>
                writer.threads().filter((record) => record.agent === 'helper' && record.origin === 'host').length === 2 &&
                alphaChild.arrivals() === 1 &&
                betaChild.arrivals() === 1,
            () => ({
                threads: writer.threads(),
                arrivals: [alphaChild.arrivals(), betaChild.arrivals()],
                alpha: textOf(writer.threadMessages(alpha.id)),
                beta: textOf(writer.threadMessages(beta.id))
            })
        );

        const children = writer.threads().filter((record) => record.agent === 'helper' && record.origin === 'host');
        expect(children.map((record) => record.id).sort()).toEqual(['thread-3', 'thread-4']);
        expect(children.map((record) => record.ownerThreadId).sort()).toEqual([
            alpha.id,
            beta.id
        ]);
        expect(children.every((record) => record.status === 'running')).toBe(true);

        alphaChild.ready.open();
        betaChild.ready.open();
        const [alphaAnswer, betaAnswer] = await Promise.all([alphaRun, betaRun]);
        expect(alphaAnswer.content).toBe('parent done');
        expect(betaAnswer.content).toBe('parent done');

        // The child agent's DEFAULT conversation is untouched: host delegations
        // never fall back to a shared transcript.
        expect(helper.messages).toEqual([]);
        expect(writer.threadMessages('agent:helper')).toEqual([]);

        // Each child owns only its own prompt/answer, matched through its parent.
        const byId = new Map(children.map((record) => [record.id, record]));
        const alphaChildRecord = children.find((record) => record.ownerThreadId === alpha.id)!;
        const betaChildRecord = children.find((record) => record.ownerThreadId === beta.id)!;
        expect(byId.get(alphaChildRecord.id)?.agent).toBe('helper');
        expect(textOf(writer.threadMessages(alphaChildRecord.id))).toEqual([
            'child alpha',
            'alpha facts'
        ]);
        expect(textOf(writer.threadMessages(betaChildRecord.id))).toEqual([
            'child beta',
            'beta facts'
        ]);

        // The answers crossed back as ordinary delegation results.
        const alphaTool = writer
            .threadMessages(alpha.id)
            .find((message) => message.role === 'tool') as { content: string };
        const betaTool = writer
            .threadMessages(beta.id)
            .find((message) => message.role === 'tool') as { content: string };
        expect(delegationOf(alphaTool)).toMatchObject({
            agent: 'helper',
            content: 'alpha facts',
            status: 'completed'
        });
        expect(delegationOf(betaTool)).toMatchObject({
            agent: 'helper',
            content: 'beta facts',
            status: 'completed'
        });

        // Ownership and status are persisted, so a restore keeps the same tree.
        const snapshot = writer.snapshot();
        const persistedChildren = (snapshot.threads ?? []).filter(
            (record) => record.agent === 'helper'
        );
        expect(persistedChildren.map((record) => record.ownerThreadId).sort()).toEqual([
            alpha.id,
            beta.id
        ]);
        expect(persistedChildren.every((record) => record.status === 'idle')).toBe(true);

        const restored = harness({
            agents: {
                lead: brain(scripted([answer('unused')])),
                helper: brain(scripted([answer('unused')]))
            },
            primary: 'lead',
            subagents: ['helper'],
            presets: false
        });
        restored.restore(snapshot);

        for (const child of children) {
            expect(restored.thread(child.id)?.ownerThreadId).toBe(child.ownerThreadId);
            expect(textOf(restored.threadMessages(child.id))).toEqual(
                textOf(writer.threadMessages(child.id))
            );
        }
    });

    // R3 IDENTITY: a focused child is RESUMED in place — the same persistent id and
    // owner, the same transcript — and never replaced by a fresh conversation. A
    // SEPARATE delegation invocation from the same parent is a new conversation
    // (distinct id, untouched history), and a restore keeps every id/owner/routing.
    it('resumes a focused child in place and keeps its id, owner, and history across restore', async () => {
        // Routes on the LAST user message: the lead's second turn continues the
        // SAME parent conversation, so its FIRST user prompt is still the earlier
        // task and would select the wrong script.
        const routedLast = (
            routes: Record<string, HarnessStream>,
            fallback: HarnessStream
        ): HarnessStream =>
            async function* (request) {
                const users = request.messages.filter((message) => message.role === 'user') as {
                    content?: string;
                }[];
                const last = users[users.length - 1];
                yield* (routes[last?.content ?? ''] ?? fallback)(request);
            };

        const buildIdentity = () => {
            const helper = brain(
                routedLast(
                    {
                        'child one': scripted([answer('one facts')]),
                        'child two': scripted([answer('two facts')]),
                        'child follow': scripted([answer('follow facts')])
                    },
                    scripted([answer('unused')])
                )
            );
            // Distinct tool-call ids per parent turn: the harness rejects a call id
            // reused from an earlier turn of the same conversation.
            const lead = brain(
                routedLast(
                    {
                        first: scripted([
                            callTool(
                                'd1',
                                'delegate',
                                JSON.stringify({ agent: 'helper', input: 'child one' })
                            ),
                            answer('first done')
                        ]),
                        continue: scripted([
                            callTool(
                                'd2',
                                'delegate',
                                JSON.stringify({ agent: 'helper', input: 'child two' })
                            ),
                            answer('second done')
                        ])
                    },
                    scripted([answer('unused')])
                )
            );

            return harness({
                agents: { lead, helper },
                primary: 'lead',
                subagents: ['helper'],
                presets: false
            });
        };

        const writer = buildIdentity();
        const parent = writer.createThread('lead');
        expect(parent.id).toBe('thread-1');

        // First delegation: the child gets its OWN host conversation, linked to the
        // parent. `helper`'s default conversation stays untouched.
        await writer.sendThreadInput(parent.id, 'first');
        expect(writer.threads()).toEqual([
            { id: 'agent:lead', agent: 'lead', origin: 'agent', status: 'idle', sequence: 1 },
            { id: 'agent:helper', agent: 'helper', origin: 'agent', status: 'idle', sequence: 2 },
            {
                id: 'thread-1',
                agent: 'lead',
                origin: 'host',
                status: 'idle',
                sequence: 3,
                invocationId: '1'
            },
            {
                id: 'thread-2',
                agent: 'helper',
                origin: 'host',
                status: 'idle',
                sequence: 4,
                ownerThreadId: 'thread-1',
                invocationId: '2'
            }
        ]);
        expect(textOf(writer.threadMessages('thread-2'))).toEqual(['child one', 'one facts']);
        expect(writer.threadMessages('agent:helper')).toEqual([]);

        // Resume the child: SAME record (id/owner/sequence), new invocation id, and
        // the follow-up accumulates in its own transcript.
        await writer.sendThreadInput('thread-2', 'child follow');
        expect(writer.thread('thread-2')).toEqual({
            id: 'thread-2',
            agent: 'helper',
            origin: 'host',
            status: 'idle',
            sequence: 4,
            ownerThreadId: 'thread-1',
            invocationId: '3'
        });
        expect(textOf(writer.threadMessages('thread-2'))).toEqual([
            'child one',
            'one facts',
            'child follow',
            'follow facts'
        ]);
        // No extra conversation was minted by the resume.
        expect(writer.threads().map((record) => record.id)).toEqual([
            'agent:lead',
            'agent:helper',
            'thread-1',
            'thread-2'
        ]);

        // A SEPARATE delegation invocation is a NEW child conversation: sibling
        // identity stays distinct and the resumed child is not appended to.
        await writer.sendThreadInput('thread-1', 'continue');
        expect(
            writer.threads().map((record) => [record.id, record.ownerThreadId, record.invocationId])
        ).toEqual([
            ['agent:lead', undefined, undefined],
            ['agent:helper', undefined, undefined],
            ['thread-1', undefined, '4'],
            ['thread-2', 'thread-1', '3'],
            ['thread-3', 'thread-1', '5']
        ]);
        expect(textOf(writer.threadMessages('thread-2'))).toEqual([
            'child one',
            'one facts',
            'child follow',
            'follow facts'
        ]);
        expect(textOf(writer.threadMessages('thread-3'))).toEqual(['child two', 'two facts']);
        // The parent conversation grew only by its own turns, never the child's.
        expect(roles(writer.threadMessages('thread-1'))).toEqual([
            'user',
            'assistant',
            'tool',
            'assistant',
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);

        // Snapshot persists every host conversation with its owner and invocation.
        const snapshot = writer.snapshot();
        expect(
            (snapshot.threads ?? []).map((entry) => [
                entry.id,
                entry.agent,
                entry.status,
                entry.sequence,
                entry.ownerThreadId,
                entry.invocationId
            ])
        ).toEqual([
            ['thread-1', 'lead', 'idle', 3, undefined, '4'],
            ['thread-2', 'helper', 'idle', 4, 'thread-1', '3'],
            ['thread-3', 'helper', 'idle', 5, 'thread-1', '5']
        ]);

        // Restore then resume the SAME child: id, owner, and transcript are kept
        // (the counter continues after every archived invocation).
        const restored = buildIdentity();
        restored.restore(snapshot);

        expect(restored.thread('thread-2')).toEqual({
            id: 'thread-2',
            agent: 'helper',
            origin: 'host',
            status: 'idle',
            sequence: 4,
            ownerThreadId: 'thread-1',
            invocationId: '3'
        });
        expect(textOf(restored.threadMessages('thread-2'))).toEqual([
            'child one',
            'one facts',
            'child follow',
            'follow facts'
        ]);

        await restored.sendThreadInput('thread-2', 'child follow');
        expect(restored.thread('thread-2')).toEqual({
            id: 'thread-2',
            agent: 'helper',
            origin: 'host',
            status: 'idle',
            sequence: 4,
            ownerThreadId: 'thread-1',
            invocationId: '6'
        });
        expect(textOf(restored.threadMessages('thread-2'))).toEqual([
            'child one',
            'one facts',
            'child follow',
            'follow facts',
            'child follow',
            'follow facts'
        ]);
        // The restored sibling conversations are neither replaced nor extended.
        expect(restored.threads().map((record) => record.id)).toEqual([
            'agent:lead',
            'agent:helper',
            'thread-1',
            'thread-2',
            'thread-3'
        ]);
        expect(textOf(restored.threadMessages('thread-3'))).toEqual(['child two', 'two facts']);
    });

    it('stops one child conversation without disturbing its sibling or either parent', async () => {
        const { writer, alphaChild, betaChild } = build();

        const alpha = writer.createThread('lead');
        const beta = writer.createThread('lead');

        const alphaRun = probe(writer.sendThreadInput(alpha.id, 'alpha task'));
        const betaRun = probe(writer.sendThreadInput(beta.id, 'beta task'));

        await until(
            () =>
                writer.threads().filter((record) => record.agent === 'helper' && record.origin === 'host').length === 2 &&
                alphaChild.arrivals() === 1 &&
                betaChild.arrivals() === 1,
            () => ({
                threads: writer.threads(),
                arrivals: [alphaChild.arrivals(), betaChild.arrivals()],
                alpha: textOf(writer.threadMessages(alpha.id)),
                beta: textOf(writer.threadMessages(beta.id))
            })
        );

        const children = writer.threads().filter((record) => record.agent === 'helper' && record.origin === 'host');
        const alphaChildRecord = children.find((record) => record.ownerThreadId === alpha.id)!;
        const betaChildRecord = children.find((record) => record.ownerThreadId === beta.id)!;

        // Targeted stop: exactly the alpha child, with a caller-visible reason.
        expect(writer.stopThread(alphaChildRecord.id, 'child stopped')).toBe(true);
        await flush();

        expect(writer.thread(alphaChildRecord.id)?.status).toBe('stopped');
        // A stopped child rolls its in-flight prompt back.
        expect(writer.threadMessages(alphaChildRecord.id)).toEqual([]);
        // The sibling is still executing and unaffected.
        expect(writer.thread(betaChildRecord.id)?.status).toBe('running');

        betaChild.ready.open();
        await until(() => alphaRun.status === 'resolved' && betaRun.status === 'resolved');

        // The parent observes a NORMAL failed tool call and recovers.
        expect(alphaRun.value?.content).toBe('parent done');
        expect(betaRun.value?.content).toBe('parent done');

        const alphaTool = writer
            .threadMessages(alpha.id)
            .find((message) => message.role === 'tool') as { content: string };
        const betaTool = writer
            .threadMessages(beta.id)
            .find((message) => message.role === 'tool') as { content: string };

        // T28: a stopped child is a CANCELLED run, not a bare tool failure. The parent
        // still observes a normal tool result it can read and recover from, and that
        // result now carries the child's identity plus how far it got — the forensic
        // record the transcript rollback used to erase.
        expect(delegationOf(alphaTool)).toMatchObject({
            agent: 'helper',
            content: '',
            status: 'cancelled',
            error: 'child stopped',
            cancelledAtMessage: 1
        });
        expect(delegationOf(betaTool)).toMatchObject({
            agent: 'helper',
            content: 'beta facts',
            status: 'completed'
        });

        // The unrelated child completed, and both parents are idle and resumable.
        expect(textOf(writer.threadMessages(betaChildRecord.id))).toEqual([
            'child beta',
            'beta facts'
        ]);
        expect(writer.thread(alpha.id)?.status).toBe('idle');
        expect(writer.thread(beta.id)?.status).toBe('idle');
        expect(writer.thread(betaChildRecord.id)?.status).toBe('idle');
    });

    it('lists live conversations for agents and hides deleted threads and results', async () => {
        // A model that reads the roster, then answers.
        const rosterStream: HarnessStream = async function* (request) {
            const seenTool = request.messages.some((message) => message.role === 'tool');

            if (!seenTool) {
                for (const frame of callTool('l1', 'threadList', '{}')) yield frame;
                return;
            }

            yield { type: 'text', delta: 'roster read' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(rosterStream) }, presets: false });
        const first = writer.createThread('writer');
        const second = writer.createThread('writer', { label: 'later' });

        await writer.sendThreadInput(first.id, 'read the roster');

        const toolMessage = writer
            .threadMessages(first.id)
            .find((message) => message.role === 'tool') as { content: string };
        // THE ROSTER IS A FAMILY (2026-11-13, B3). From inside `first` the caller sees its
        // own thread, its ancestors/descendants, and the DEFAULT conversations of the
        // agents in that family — NOT a sibling host thread it did not create. `second`
        // is exactly such a sibling, so it is absent here while the threadless host view
        // below still lists it: the roster is the address book for threadSend/threadRead/
        // threadDelete, and those refuse everything a scoped caller cannot see.
        expect(JSON.parse(toolMessage.content)).toEqual({
            currentThreadId: first.id,
            threads: [
                {
                    id: 'agent:writer',
                    agent: 'writer',
                    origin: 'agent',
                    status: 'idle',
                    sequence: 1
                },
                {
                    id: first.id,
                    agent: 'writer',
                    origin: 'host',
                    status: 'running',
                    sequence: 2,
                    invocationId: '1'
                }
            ]
        });

        // A CALLER WITH NO THREAD IS UNSCOPED: the host (here, the manual executeTool with
        // no thread) still gets every live conversation, including the sibling.
        const scopedOutRoster = (await writer.executeTool('threadList', {})) as {
            currentThreadId?: string;
            threads: { id: string }[];
        };
        expect(scopedOutRoster.currentThreadId).toBeUndefined();
        expect(scopedOutRoster.threads.map((record) => record.id)).toEqual([
            'agent:writer',
            first.id,
            second.id
        ]);

        // Deletion removes the record, the roster entry, and the result lookup.
        writer.deleteThread(second.id);
        expect(writer.thread(second.id)).toBeUndefined();
        expect(writer.threads().map((record) => record.id)).toEqual(['agent:writer', first.id]);

        const manualRoster = (await writer.executeTool('threadList', {})) as {
            currentThreadId?: string;
            threads: { id: string }[];
        };
        expect(manualRoster.currentThreadId).toBeUndefined();
        expect(manualRoster.threads.map((record) => record.id)).toEqual([
            'agent:writer',
            first.id
        ]);

        const snapshot = writer.snapshot();
        expect((snapshot.threads ?? []).map((record) => record.id)).toEqual([first.id]);
        expect(snapshot.threadSequence).toBe(2);

        writer.deleteThread(first.id);
        expect(writer.threads().map((record) => record.id)).toEqual(['agent:writer']);
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '1' })
        ).rejects.toThrow('No result "1" is available for agent "writer".');
    });
});

describe('cross-thread chat and delegation links (R4)', () => {
    it('delivers a threadSend message with runtime-derived sender attribution', async () => {
        const seen: HarnessStreamRequest[] = [];

        // One script per conversation, keyed on its FIRST prompt (see `routed`). The
        // target's first prompt is the ATTRIBUTED MESSAGE itself, because an idle
        // target is now started with it (delegate-stress T3.2) instead of having it
        // parked in its transcript.
        const stream = routed(
            {
                'talk to beta': scripted(
                    [
                        // The tool schema has no sender field: identity comes from the run.
                        callTool(
                            'c1',
                            'threadSend',
                            JSON.stringify({ thread: 'thread-2', message: 'hello from alpha' })
                        ),
                        answer('alpha sent')
                    ],
                    seen
                ),
                'from agent "writer" (thread thread-1):\nhello from alpha': scripted([
                    answer('beta heard you')
                ])
            },
            scripted([answer('unexpected')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });

        // createThread registers the conditional core tool, so the very next
        // request declares it.
        const alpha = writer.createThread('writer');
        // LINEAGE (2026-11-13): alpha may only write into its own lineage, so beta is
        // created as alpha's child rather than as its sibling. A sibling send is a
        // refusal, and that case has its own test below; this test is about the
        // runtime-derived SENDER on a delivery that is allowed.
        const beta = writer.createThread('writer', { ownerThreadId: alpha.id });

        const result = await writer.sendThreadInput(alpha.id, 'talk to beta');
        expect(result.content).toBe('alpha sent');
        // R9-R11: the demoted runtime rows are searchable, so the declared set is
        // the bootstrap pair plus the four thread controls this harness just
        // registered (roster first, then the transcript reader, then the sender, then
        // the deleter — descending `order` inside the 'threads' activation group).
        expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual([
            'toolRequest',
            'tasks',
            'threadList',
            'threadRead',
            'threadSend',
            'threadDelete'
        ]);

        // The tool result reports the delivery and the REAL sender: a dormant target
        // is reported as `started`, the value the ambiguity this finding was built on
        // used to hide behind the bare word `appended` (T3.6).
        const toolMessage = writer
            .threadMessages(alpha.id)
            .find((message) => message.role === 'tool') as { content: string };
        expect(JSON.parse(toolMessage.content)).toEqual({
            threadId: beta.id,
            delivered: 'started',
            sender: 'writer',
            senderThreadId: alpha.id
        });

        // THE WOKEN CONVERSATION: the attributed message is the prompt of a run that
        // answered it, not a line waiting for some unrelated turn to read it.
        await settleThread(writer, beta.id);

        expect(withoutIds(writer.threadMessages(beta.id))).toEqual([
            {
                role: 'user',
                content: 'from agent "writer" (thread thread-1):\nhello from alpha'
            },
            { role: 'assistant', content: 'beta heard you' }
        ]);
        expect(writer.thread(beta.id)?.status).toBe('idle');
    });

    it('cannot spoof a sender: identity is not part of the tool schema', async () => {
        let requests = 0;
        const stream: HarnessStream = async function* () {
            requests += 1;

            if (requests === 1) {
                for (const frame of callTool(
                    'c1',
                    'threadSend',
                    JSON.stringify({ thread: 'thread-2', message: 'hi', sender: 'lead' })
                )) {
                    yield frame;
                }
                return;
            }

            yield { type: 'text', delta: 'done' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const alpha = writer.createThread('writer');
        const beta = writer.createThread('writer');
        await writer.sendThreadInput(alpha.id, 'try to spoof');

        const toolMessage = writer
            .threadMessages(alpha.id)
            .find((message) => message.role === 'tool') as { content: string };
        expect(toolMessage.content).toBe(
            'Tool "threadSend" received arguments that do not match its schema: $ must not include the additional property "sender".'
        );
        // The rejected call delivered nothing.
        expect(writer.threadMessages(beta.id)).toEqual([]);
    });

    it('queues a chat message into a running thread at its next boundary', async () => {
        const turn = gate();
        let requests = 0;
        const seen: HarnessStreamRequest[] = [];

        const stream: HarnessStream = async function* (request) {
            seen.push(request);
            requests += 1;

            if (requests === 1) {
                await turn.promise;
                yield { type: 'text', delta: 'busy' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            yield { type: 'text', delta: 'after chat' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const target = writer.createThread('writer');
        const running = writer.sendThreadInput(target.id, 'work');
        await flush();
        expect(requests).toBe(1);

        // The manual path has no run identity, so the sender is the primary agent
        // and no sender thread is claimed.
        await expect(
            writer.executeTool('threadSend', { thread: target.id, message: 'ping' })
        ).resolves.toEqual({
            threadId: target.id,
            delivered: 'queued',
            sender: 'writer'
        });

        // Nothing landed mid-request.
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([{ role: 'user', content: 'work' }]);

        turn.open();
        await running;

        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'work' },
            { role: 'assistant', content: 'busy' },
            { role: 'user', content: 'from agent "writer":\nping' },
            { role: 'assistant', content: 'after chat' }
        ]);
        expect(textOf(seen[1]!.messages)).toEqual(['work', 'busy', 'from agent "writer":\nping']);
    });

    it('links a delegated child conversation to its caller and refuses a stopped one', async () => {
        const helper = brain(scripted([answer('the facts')]));
        const lead = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"helper","input":"find facts"}'),
                answer('lead done'),
                callTool('c2', 'delegate', '{"agent":"helper","input":"more facts"}'),
                answer('lead done again')
            ])
        );

        const writer = harness({
            agents: { lead, helper },
            primary: 'lead',
            subagents: ['helper'],
            presets: false
        });

        await writer('go');

        // Legacy accumulation is preserved: the child's default conversation is the
        // configured Agent's transcript.
        expect(writer.threadMessages('agent:helper')).toEqual(helper.messages);
        expect(roles(writer.threadMessages('agent:helper'))).toEqual(['user', 'assistant']);
        expect(writer.thread('agent:helper')).toEqual({
            id: 'agent:helper',
            agent: 'helper',
            origin: 'agent',
            status: 'idle',
            sequence: 2,
            ownerThreadId: 'agent:lead',
            invocationId: '2'
        });
        expect(writer.thread('agent:lead')?.invocationId).toBe('1');

        // Model-driven work must respect a host stop: the next delegation is an
        // honest tool result, not a resurrected conversation.
        writer.stopThread('agent:helper', 'no more');
        await writer('again');

        const toolMessages = lead.messages.filter((message) => message.role === 'tool');
        expect((toolMessages.at(-1) as { content: string }).content).toBe(
            'Tool "delegate" failed: Thread "agent:helper" is stopped; a host must resume it before it can run.'
        );
        expect(withoutIds(helper.messages)).toEqual([
            { role: 'user', content: 'find facts' },
            { role: 'assistant', content: 'the facts' }
        ]);
    });
});

describe('delete purge and snapshot durability', () => {
    it('purges a terminal host thread, its transcript, and its invocation lookup', async () => {
        let requests = 0;
        const stream: HarnessStream = async function* () {
            requests += 1;
            yield { type: 'text', delta: `answer ${requests}` };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');
        await writer.sendThreadInput(thread.id, 'hello');

        expect(writer.thread(thread.id)?.invocationId).toBe('1');
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '1' })
        ).resolves.toMatchObject({ invocationId: '1', content: 'answer 1' });

        // A running thread cannot be deleted.
        const running = writer.sendThreadInput(thread.id, 'again');
        expect(() => writer.deleteThread(thread.id)).toThrow(
            `Thread "${thread.id}" is running; stop it before deleting it.`
        );
        await running;

        writer.deleteThread(thread.id);

        expect(writer.thread(thread.id)).toBeUndefined();
        expect(writer.threads().map((record) => record.id)).toEqual(['agent:writer']);
        expect(() => writer.threadMessages(thread.id)).toThrow(
            `Thread "${thread.id}" is not available in this harness; it was never created, or it was deleted.`
        );
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '1' })
        ).rejects.toThrow('No result "1" is available for agent "writer".');
        // A deleted thread cannot receive chat either (registered by createThread).
        await expect(
            writer.executeTool('threadSend', { thread: thread.id, message: 'ping' })
        ).rejects.toThrow(
            `Thread "${thread.id}" is not available in this harness; it was never created, or it was deleted.`
        );

        // The id high-water mark survives deletion, and no host thread is persisted.
        expect(writer.snapshot().threads).toEqual([]);
        expect(writer.snapshot().threadSequence).toBe(1);
        expect(writer.createThread('writer').id).toBe('thread-2');
    });

    it('round-trips host threads through snapshot/restore', async () => {
        const stream: HarnessStream = async function* () {
            yield { type: 'text', delta: 'stored' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const source = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = source.createThread('writer', { label: 'kept' });
        await source.sendThreadInput(thread.id, 'remember this');

        const snapshot = source.snapshot();
        expect(withoutIds(snapshot.threads)).toEqual([
            {
                id: 'thread-1',
                agent: 'writer',
                status: 'idle',
                sequence: 2,
                label: 'kept',
                invocationId: '1',
                messages: [
                    { role: 'user', content: 'remember this' },
                    { role: 'assistant', content: 'stored' }
                ]
            }
        ]);
        expect(snapshot.threadSequence).toBe(1);

        // A default-only snapshot keeps the pre-thread shape: the field pair is
        // absent rather than an empty array.
        const plain = harness({ agents: { writer: brain(stream) }, presets: false });
        expect('threads' in plain.snapshot()).toBe(false);
        expect('threadSequence' in plain.snapshot()).toBe(false);

        const target = harness({ agents: { writer: brain(stream) }, presets: false });
        target.restore(snapshot);

        expect(withoutIds(target.thread('thread-1'))).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 2,
            label: 'kept',
            invocationId: '1'
        });
        expect(withoutIds(target.threadMessages('thread-1'))).toEqual([
            { role: 'user', content: 'remember this' },
            { role: 'assistant', content: 'stored' }
        ]);
        // The tool came back with the restored thread.
        expect(target.tools.threadSend).toBeDefined();

        // Resuming appends to the restored conversation only.
        await target.sendThreadInput('thread-1', 'continue');
        expect(textOf(target.threadMessages('thread-1'))).toEqual([
            'remember this',
            'stored',
            'continue',
            'stored'
        ]);
        // The default conversation stayed empty, as the source snapshot said.
        expect(target.threadMessages('agent:writer')).toEqual([]);
    });
});

describe('review corrections (H1/M1/M2/L2 + steering preservation)', () => {
    it('rejects a default conversation as thread owner (H1)', () => {
        const writer = quiet(brain(scripted([answer('unused')])));

        expect(() => writer.createThread('writer', { ownerThreadId: 'agent:writer' })).toThrow(
            'Thread "agent:writer" is an agent\'s default conversation; only an independent host thread can own another thread.'
        );

        // The accepted owner states still round-trip: none, and a HOST parent.
        const parent = writer.createThread('writer');
        const child = writer.createThread('writer', { ownerThreadId: parent.id });
        const bare = writer.createThread('writer');
        const snapshot = writer.snapshot();

        expect(snapshot.threads?.map((entry) => entry.ownerThreadId)).toEqual([
            undefined,
            parent.id,
            undefined
        ]);

        const target = quiet(brain(scripted([answer('unused')])));
        target.restore(snapshot);

        expect(target.thread(child.id)?.ownerThreadId).toBe(parent.id);
        expect(target.thread(bare.id)?.ownerThreadId).toBeUndefined();
        expect(target.thread(parent.id)).toEqual(parent);
    });

    it('rejects host turns queued before a stop; a new send is the only revival (M1)', async () => {
        const first = gatedAnswer('one');
        let requests = 0;

        const stream: HarnessStream = async function* (request) {
            requests += 1;
            if (requests === 1) {
                for await (const frame of first.stream(request)) yield frame;
                return;
            }
            yield { type: 'text', delta: 'after stop' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');

        const running = probe(writer.sendThreadInput(thread.id, 'one'));
        await flush();
        expect(running.status).toBe('pending');
        expect(first.arrivals()).toBe(1);

        const queued = probe(writer.sendThreadInput(thread.id, 'two'));
        await flush();
        expect(queued.status).toBe('pending');

        expect(writer.stopThread(thread.id, 'host stop')).toBe(true);
        first.ready.open();
        await flush();

        expect(running.status).toBe('rejected');
        expect((running.error as Error).message).toBe('host stop');
        expect(queued.status).toBe('rejected');
        expect((queued.error as Error).message).toBe(
            `Thread "${thread.id}" was stopped while this turn was queued; the turn was not started.`
        );

        // The queued turn never reached the model, the status stayed stopped, and
        // the aborted prompt rolled back.
        expect(requests).toBe(1);
        expect(writer.thread(thread.id)?.status).toBe('stopped');
        expect(writer.threadMessages(thread.id)).toEqual([]);

        // A NEW host send after the stop is the one legal revival path.
        const revived = await writer.sendThreadInput(thread.id, 'three');
        expect(revived.content).toBe('after stop');
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(textOf(writer.threadMessages(thread.id))).toEqual(['three', 'after stop']);
        expect(requests).toBe(2);
    });

    it('applies the same queued rejection under stopAllThreads', async () => {
        const first = gatedAnswer('one');
        let requests = 0;

        const stream: HarnessStream = async function* (request) {
            requests += 1;
            if (requests === 1) {
                for await (const frame of first.stream(request)) yield frame;
                return;
            }
            yield { type: 'text', delta: 'late' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');

        const running = probe(writer.sendThreadInput(thread.id, 'one'));
        await flush();
        const queued = probe(writer.sendThreadInput(thread.id, 'two'));
        await flush();

        expect(writer.stopAllThreads('all stop')).toBe(1);
        first.ready.open();
        await flush();

        expect(running.status).toBe('rejected');
        expect((running.error as Error).message).toBe('all stop');
        expect(queued.status).toBe('rejected');
        expect((queued.error as Error).message).toBe(
            `Thread "${thread.id}" was stopped while this turn was queued; the turn was not started.`
        );
        expect(requests).toBe(1);
        expect(writer.thread(thread.id)?.status).toBe('stopped');
    });

    it('purges thread-owned branches and their results on delete (M2)', async () => {
        let requests = 0;

        const stream: HarnessStream = async function* () {
            requests += 1;
            if (requests === 1) {
                for (const frame of callTool('f1', 'threadFork', '{"input":"look into it"}')) {
                    yield frame;
                }
                return;
            }
            yield { type: 'text', delta: 'ok' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({
            agents: { writer: brain(stream) },
            presets: false,
            forks: { enabled: true }
        });
        const thread = writer.createThread('writer');
        await writer.sendThreadInput(thread.id, 'start');

        expect(
            writer.branches().map((record) => [record.branchId, record.kind, record.threadId, record.status])
        ).toEqual([['branch-1', 'fork', thread.id, 'completed']]);
        expect(writer.branch('branch-1')).toBeDefined();
        // A branch is an INVOCATION, never a user thread.
        expect(writer.threads().map((record) => record.id)).toEqual(['agent:writer', thread.id]);
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: 'branch-1' })
        ).resolves.toMatchObject({ invocationId: 'branch-1' });

        writer.deleteThread(thread.id);

        expect(writer.branches()).toEqual([]);
        expect(writer.branch('branch-1')).toBeUndefined();
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: 'branch-1' })
        ).rejects.toThrow('No result "branch-1" is available for agent "writer".');
    });

    // STRESS REPORT #6 (2026-11-14) — THE PURGE IS NO LONGER SILENT.
    //
    // Deleting a conversation drops its agent-result records and its branch lookups, which the
    // caller otherwise experienced as `agentManage` shrinking and `agentResult(id)` starting to
    // throw with no stated reason. `purgeThread` always computed those exact sets and threw them
    // away; `deleteThread` now folds them into the receipt (owner first, then cascade children),
    // so the state the caller caused is the state it can report.
    //
    // The branch id is taken from the ledger rather than written out: the branch counter is not
    // per-harness, and this file's M2 case already pinned `branch-1` for ITS harness.
    it('reports on the receipt which invocations and branches the delete purged (M2 + stress report #6)', async () => {
        let requests = 0;

        const stream: HarnessStream = async function* () {
            requests += 1;
            if (requests === 1) {
                for (const frame of callTool('f1', 'threadFork', '{"input":"look into it"}')) {
                    yield frame;
                }
                return;
            }
            yield { type: 'text', delta: 'ok' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({
            agents: { writer: brain(stream) },
            presets: false,
            forks: { enabled: true }
        });
        const thread = writer.createThread('writer');
        await writer.sendThreadInput(thread.id, 'start');

        const branchId = writer.branches()[0].branchId;

        // Two terminal lookups exist before the delete: the conversation's own turn ('1') and
        // the fork's branch invocation, both owned by `thread`.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '1' })
        ).resolves.toMatchObject({ invocationId: '1' });
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: branchId })
        ).resolves.toMatchObject({ invocationId: branchId });

        expect(writer.deleteThread(thread.id)).toEqual({
            deleted: thread.id,
            removedThreadIds: [thread.id],
            // Registry insertion order: the conversation's run registered first, the branch's
            // run second.
            removedInvocationIds: ['1', branchId],
            removedBranchIds: [branchId]
        });

        // The receipt is the truth: both lookups are gone on the next call.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '1' })
        ).rejects.toThrow('No result "1" is available for agent "writer".');
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: branchId })
        ).rejects.toThrow(`No result "${branchId}" is available for agent "writer".`);
    });

    it('clears the runtime-only default owner link on reset and restore (L2)', async () => {
        const helper = brain(scripted([answer('facts')]));
        const lead = brain(
            scripted([
                callTool('d1', 'delegate', JSON.stringify({ agent: 'helper', input: 'find' })),
                answer('lead done')
            ])
        );
        const writer = harness({
            agents: { lead, helper },
            primary: 'lead',
            subagents: ['helper'],
            presets: false
        });

        await writer('go');
        const afterRun = writer.thread('agent:helper')?.ownerThreadId;
        expect(afterRun).toBe('agent:lead');

        writer.reset();
        expect(writer.thread('agent:helper')?.ownerThreadId).toBeUndefined();

        await writer('go');
        const snapshot = writer.snapshot();

        // Restore onto a harness that currently carries a stale link.
        const target = harness({
            agents: {
                lead: brain(
                    scripted([
                        callTool('d1', 'delegate', JSON.stringify({ agent: 'helper', input: 'find' })),
                        answer('lead done')
                    ])
                ),
                helper: brain(scripted([answer('facts')]))
            },
            primary: 'lead',
            subagents: ['helper'],
            presets: false
        });
        await target('go');
        expect(target.thread('agent:helper')?.ownerThreadId).toBe('agent:lead');

        target.restore(snapshot);
        expect(target.thread('agent:helper')?.ownerThreadId).toBeUndefined();
    });

    it('preserves steering for the next host turn when a run fails without a stop', async () => {
        const hold = gate();
        let requests = 0;

        const holdTool = tool({
            description: 'Hold until released.',
            tags: ['test'],
            visibility: 'core',
            // T2/R2: async — the run must keep taking requests (pause, then a failing
            // attempt) while this call is outstanding, which is the async contract.
            mode: 'async',
            execute: () => hold.promise
        });

        const stream: HarnessStream = async function* () {
            requests += 1;

            if (requests === 1) {
                for (const frame of callTool('h1', 'hold', '{}')) yield frame;
                return;
            }

            if (requests === 2) {
                yield { type: 'text', delta: 'paused' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            if (requests === 3) {
                yield { type: 'text', delta: 'partial' };
                // R1: one attempt — this pins the failed-run steering preservation,
                // so the retry backoff must not sit between the two requests.
                yield { type: 'error', message: 'boom' };
                return;
            }

            yield { type: 'text', delta: 'recovered' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({
            agents: { writer: brain(stream, { retry: false }) },
            tools: { hold: holdTool },
            presets: false
        });
        const thread = writer.createThread('writer');

        const running = probe(writer.sendThreadInput(thread.id, 'start'));
        await flush();
        expect(requests).toBe(2);

        // The paused run accepts guidance; it wakes, drains the steering into
        // the transcript, and then that REQUEST fails.
        expect(writer.steerThread(thread.id, 'focus')).toEqual({ threadId: thread.id, queued: true });
        await flush();

        expect(running.status).toBe('rejected');
        expect((running.error as Error).message).toBe('boom');
        expect(writer.thread(thread.id)?.status).toBe('idle');
        expect(writer.threadMessages(thread.id)).toEqual([]);

        // The next host turn retries the preserved steering, in order.
        const retried = await writer.sendThreadInput(thread.id, 'retry');
        expect(retried.content).toBe('recovered');
        expect(textOf(writer.threadMessages(thread.id))).toEqual(['retry', 'focus', 'recovered']);
        expect(requests).toBe(4);
    });
});

// ---------------------------------------------------------------------------
// C4: `setThreadMessages` — the wholesale transcript REPLACEMENT primitive the
// server's transcript editor (GET/PUT .../threads/:id/transcript) is built on.
//
// Pinned here (implementation: setThreadMessages in src/harness.ts):
//   - validation uses the SAME reader snapshot()/restore() enforce, so a write
//     this harness accepts can never produce a snapshot its own restore refuses;
//   - a refused write mutates NOTHING (validate before mutate);
//   - replacement is IN PLACE, so a caller holding `agent.messages` (the run loop,
//     the server roster) keeps seeing the current transcript;
//   - live work is refused; a STOPPED conversation is writable — that is exactly
//     the repair path a broken transcript needs;
//   - the submitted array is copied (detached), and persistence is notified with
//     the existing `agent_message` reason while NO progress event is emitted.
// ---------------------------------------------------------------------------
describe('thread transcript replacement (C4 setThreadMessages)', () => {
    it('replaces a host transcript wholesale and reports it to persistence only', () => {
        const changes: { type: string; reason?: string; agent?: string }[] = [];
        const progress: unknown[] = [];

        const writer = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false,
            report: {
                // Contextually typed by HarnessConfiguration, so the event shapes
                // stay the compiler's business, not this file's.
                progress: (event) => {
                    progress.push(event);
                },
                stateChange: (event) => {
                    changes.push(event);
                }
            }
        });

        const thread = writer.createThread('writer', { label: 'Editor' });
        // A thread of an instruction-less agent starts empty: every expectation
        // below is therefore about THIS write, not about a seed.
        expect(writer.threadMessages(thread.id)).toEqual([]);

        // `createThread` notified the roster first (`reason: 'thread'`). The
        // recording window below starts at the write under test, so its assertion
        // is about exactly one operation.
        expect(changes).toEqual([{ type: 'state_change', reason: 'thread' }]);
        changes.length = 0;
        progress.length = 0;

        writer.setThreadMessages(thread.id, [
            { role: 'system', content: 'seed' },
            { role: 'user', content: 'rewritten' }
        ]);

        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'system', content: 'seed' },
            { role: 'user', content: 'rewritten' }
        ]);

        // The snapshot sees it, so the next save of this harness IS the new truth.
        expect(withoutIds(writer.snapshot().threads)).toEqual([
            {
                id: 'thread-1',
                agent: 'writer',
                status: 'idle',
                sequence: 2,
                label: 'Editor',
                messages: [
                    { role: 'system', content: 'seed' },
                    { role: 'user', content: 'rewritten' }
                ]
            }
        ]);

        // Persistence is notified once, with the EXISTING reason and the owning
        // agent. The write is a host edit, not model output, so nothing streamed.
        expect(changes).toEqual([{ type: 'state_change', reason: 'agent_message', agent: 'writer' }]);
        expect(progress).toEqual([]);

        // Round-trip: a snapshot of this harness restores the replaced transcript.
        const restored = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        restored.restore(writer.snapshot());
        expect(withoutIds(restored.threadMessages('thread-1'))).toEqual([
            { role: 'system', content: 'seed' },
            { role: 'user', content: 'rewritten' }
        ]);
    });

    it('replaces the live array in place, so an existing reference keeps working', () => {
        const entry = brain(scripted([answer('unused')]));
        const writer = quiet(entry);

        // `agent.messages` is the LIVE array the run loop appends to (restore()
        // mutates it the same way). The primitive must not swap the reference.
        const live = writer.agents.writer.messages;
        expect(live).toEqual([]);

        writer.setThreadMessages('agent:writer', [{ role: 'user', content: 'kept' }]);

        expect(writer.agents.writer.messages).toBe(live);
        expect(withoutIds(writer.agents.writer.messages)).toEqual([{ role: 'user', content: 'kept' }]);
        // The default conversation and the registry transcript are one and the
        // same thing, which is why an in-place write matters here.
        expect(withoutIds(writer.threadMessages('agent:writer'))).toEqual([{ role: 'user', content: 'kept' }]);
    });

    it('detaches the submitted value, validates it, and mutates nothing on refusal', () => {
        const writer = quiet(brain(scripted([answer('unused')])));
        const thread = writer.createThread('writer');

        // An unknown id is the same honest error every thread operation throws.
        expect(() => writer.setThreadMessages('thread-99', [{ role: 'user', content: 'x' }])).toThrow(
            'Thread "thread-99" is not available in this harness; it was never created, or it was deleted.'
        );

        // Bad role / non-array / missing field: the shared reader's own wording,
        // labelled with the thread it belongs to.
        expect(() => writer.setThreadMessages(thread.id, [{ role: 'bogus', content: 'x' } as never])).toThrow(
            'thread "thread-1" messages[0].role must be one of: system, user, assistant, tool.'
        );
        expect(() => writer.setThreadMessages(thread.id, { not: 'an array' } as never)).toThrow(
            'thread "thread-1" messages must be an array.'
        );
        expect(() => writer.setThreadMessages(thread.id, [{ role: 'user' } as never])).toThrow(
            'thread "thread-1" messages[0] is missing the field "content".'
        );

        // A refused write left the conversation exactly as it was.
        expect(writer.threadMessages(thread.id)).toEqual([]);

        // The accepted write is COPIED: mutating the caller's array afterwards
        // cannot rewrite the stored transcript (restore's detachment rule).
        const submitted = [{ role: 'user' as const, content: 'one' }];
        writer.setThreadMessages(thread.id, submitted);
        submitted[0].content = 'mutated';
        submitted.push({ role: 'user', content: 'appended' });

        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([{ role: 'user', content: 'one' }]);

        // An empty transcript is legal (the editor's "clear" action).
        writer.setThreadMessages(thread.id, []);
        expect(writer.threadMessages(thread.id)).toEqual([]);
        expect(writer.snapshot().threads?.[0]?.messages).toEqual([]);
    });

    it('refuses a running conversation and accepts a stopped or settled one', async () => {
        const slow = gatedAnswer('late');
        const writer = quiet(brain(slow.stream));
        const thread = writer.createThread('writer');

        const pending = writer.sendThreadInput(thread.id, 'start');
        const running = probe(pending);
        await flush();

        expect(writer.thread(thread.id)?.status).toBe('running');
        expect(() => writer.setThreadMessages(thread.id, [{ role: 'user', content: 'too late' }])).toThrow(
            'Thread "thread-1" is running; stop it before replacing its transcript.'
        );
        // The refusal left the run's own transcript alone.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([{ role: 'user', content: 'start' }]);

        slow.ready.open();
        expect(running.status).toBe('pending');
        const answerMessage = await pending;
        expect(answerMessage.content).toBe('late');

        // Settled: the same write now lands and replaces EVERYTHING, including the
        // transcript the run just committed.
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: 'start' },
            { role: 'assistant', content: 'late' }
        ]);

        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'after the run' }]);
        expect(withoutIds(writer.threadMessages(thread.id))).toEqual([
            { role: 'user', content: 'after the run' }
        ]);

        // A STOPPED conversation stays editable — repairing a broken transcript on
        // a stopped thread is the recovery path the visualiser needs.
        writer.stopThread(thread.id);
        expect(writer.thread(thread.id)?.status).toBe('stopped');

        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'repaired while stopped' }]);
        expect(writer.threadMessages(thread.id)).toEqual([
            // A replaced transcript is a NEW conversation state, so the reader mints its
            // addresses from the top of the new list (context T1.3) — the id is pinned
            // exactly here because this write is one of the entry points that backfills.
            { role: 'user', content: 'repaired while stopped', messageId: 'msg-1' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// Policy 2026-11-09 (docs/tasks/2026-11-09-thread-timeout-policy.md) —
//   T5.3  no thread other than a delegated child has EVER had a clock, and the
//         host thread is the second half of that regression guard (the fork half
//         is in src/harness.fork.test.ts);
//   T6    "a stopped thread restarts when a new prompt is sent" (R3) means the
//         HOST prompt. The host (operator/server) owns stopping AND reviving; an
//         agent message never revives a stopped conversation. That is the reading
//         both task docs now record, and it is what the sibling entry's T3.3 keeps.
// ---------------------------------------------------------------------------

describe('a host turn has no wall-clock bound (policy 2026-11-09 T5.3)', () => {
    it('keeps a host turn in flight past the bound a delegated child used to get, and answers on its own', async () => {
        const model = gatedAnswer('the late answer');
        const writer = quiet(brain(model.stream));
        const thread = writer.createThread('writer', { label: 'Long' });

        const running = probe(writer.sendThreadInput(thread.id, 'take your time'));
        await flush();

        expect(model.arrivals()).toBe(1);
        expect(writer.thread(thread.id)?.status).toBe('running');

        // THE ELAPSED-TIME JUMP. This file fakes Date ONLY (see the clock policy at
        // the top: real timers are what the gated transports need), so a fake-timer
        // callback cannot fire here and nothing in the harness may consult a clock
        // for a turn deadline. What this rules out is the OTHER shape a thread limit
        // takes — `Date.now() - startedAt > bound` checked at a loop boundary. The
        // timer-shaped bound is ruled out for the fork path in
        // src/harness.fork.test.ts, where fake timers own setTimeout as well.
        vi.setSystemTime(new Date(EPOCH_MS + 300_001));
        await flush();
        expect(running.status).toBe('pending');
        expect(writer.thread(thread.id)?.status).toBe('running');

        // Two and a half more minutes of elapsed time: still nothing to time out.
        vi.setSystemTime(new Date(EPOCH_MS + 300_001 + 1_200_000));
        await flush();
        expect(running.status).toBe('pending');
        expect(writer.thread(thread.id)?.status).toBe('running');
        expect(model.arrivals()).toBe(1);

        // It finishes because the provider answered, not because a deadline passed.
        model.ready.open();
        await flush();

        expect(running.status).toBe('resolved');
        expect(running.value?.content).toBe('the late answer');
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });
});

describe('a stopped thread is revived by a host only (policy 2026-11-09 T6)', () => {
    it('refuses an agent message, stays stopped, and accepts the next host turn', async () => {
        const writer = quiet(brain(scripted([answer('host resumed')])));
        const thread = writer.createThread('writer', { label: 'Stopped' });

        // The thread tools are conditional; owning an independent thread is what
        // registers `threadSend`, so the agent-facing door under test exists here.
        expect(writer.tools.threadSend).toBeDefined();

        writer.stopThread(thread.id, 'operator stop');
        expect(writer.thread(thread.id)?.status).toBe('stopped');

        // THE REFUSAL. `threadSend` is an agent talking to another conversation, not
        // the host, so a stopped thread cannot receive it. This is deliberate
        // (src/harness.ts `postThreadMessage`, and the comment on `sendThreadInput`
        // that only an explicit HOST turn revives a stopped conversation): folding
        // `stopped` into an auto-restart would silently undo a user's Stop.
        await expect(
            writer.executeTool('threadSend', { thread: thread.id, message: 'agent ping' })
        ).rejects.toThrow(
            `Thread "${thread.id}" is stopped; it cannot receive messages until a host resumes or deletes it.`
        );

        // The refusal changes nothing: no revival, and no text parked in the
        // transcript to be read by some later turn.
        expect(writer.thread(thread.id)?.status).toBe('stopped');
        expect(writer.threadMessages(thread.id)).toEqual([]);

        // THE OWNER. R3 ("a stopped thread can always be restarted by sending it a
        // new prompt") is the HOST path, and this is the surface that implements it.
        const message = await writer.sendThreadInput(thread.id, 'host resumes');

        expect(message.content).toBe('host resumed');
        expect(writer.thread(thread.id)?.status).toBe('idle');
    });
});

// ---------------------------------------------------------------------------
// delegate-stress 2026-11-08, finding 3 (docs/tasks/2026-11-08-delegate-stress-
// test.md T3.1–T3.6) — `threadSend` is ONE state-aware operation, decided by the
// RUNTIME (src/harness.ts `postThreadMessage`) rather than by the HTTP layer that
// used to own it (`src/server/sessions.ts` `steerIntoThread`):
//
//   running → STEER  (`delivered: 'queued'`)  — drained into the live run
//   idle    → START  (`delivered: 'started'`) — the message is the new prompt
//   paused  → QUEUE  (`delivered: 'queued'`)  — the park SURVIVES the message (T8: the
//             holder owns `resume`; only a host `sendThreadInput` lifts a park)
//   stopped → the same throw (T3.3 — the host owns stopping and reviving)
//
// The rest of the finding's checks are pinned where they already live:
//   T3.4 — src/server/workers/capability.test.ts, unchanged: `threadSend` stays in
//          `AUTHORITY_RUNTIME_METHODS` and out of `NESTED_RUN_ARMED_DOORS`, because
//          the merge never awaits the answer (non-blocking is what keeps a chat
//          primitive from becoming a nested run);
//   T3.5 — the `steerThread`/`sendThreadInput` tests above, whose signatures and
//          return types (`HarnessThreadSteerReceipt`, `HarnessAssistantMessage`) the
//          merge deliberately did not touch;
//   T3.6 — `delivered` is now `'queued' | 'started'`, and every value below is the
//          reachability proof for one of them. `'appended'` is retired: with a
//          dormant target now started, nothing is ever parked unread.
// ---------------------------------------------------------------------------

describe('threadSend is state-aware (delegate-stress T3.1–T3.6)', () => {
    // T3.1 — THE LOAD-BEARING UNCERTAINTY of the finding: the interrupt path was
    // read from source and never observed, because the one live attempt landed after
    // the child had already finished. Here the target is PROVABLY mid-request (its
    // first answer is held behind a gate) when the send lands, and the assertion is
    // about the child's ANSWER: the model restates the steered text, which an inert
    // append could never produce.
    it('steers a genuinely running conversation and its next turn reflects the message (T3.1)', async () => {
        const heldAnswer = gate();
        const seen: HarnessStreamRequest[] = [];
        let targetRequests = 0;

        const stream = routed(
            {
                // The sender is a model in a live run of its own, so the call goes
                // through the real tool path (runtime-derived sender + senderThreadId).
                'tell beta to stop': scripted([
                    callTool(
                        'c1',
                        'threadSend',
                        JSON.stringify({
                            thread: 'thread-2',
                            message: 'count to 30, not 120'
                        })
                    ),
                    answer('alpha told beta')
                ]),
                // The target: request 1 is held so the run is genuinely in flight;
                // request 2 answers FROM THE TRANSCRIPT, which is what proves the
                // steer reached the model rather than only the history.
                'count to 120': async function* (request) {
                    seen.push(request);
                    targetRequests += 1;

                    if (targetRequests === 1) {
                        await heldAnswer.promise;
                        yield { type: 'text', delta: 'REACHED: 120' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        return;
                    }

                    const users = request.messages.filter(
                        (message) => message.role === 'user'
                    ) as { content?: string }[];
                    yield {
                        type: 'text',
                        delta: `last instruction: ${users[users.length - 1]?.content ?? 'none'}`
                    };
                    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                }
            },
            scripted([answer('unexpected')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const alpha = writer.createThread('writer');
        // LINEAGE (2026-11-13): beta is alpha's CHILD, not its sibling, so alpha's model
        // may steer it (a sibling send is refused — pinned in its own test below).
        const beta = writer.createThread('writer', { ownerThreadId: alpha.id });

        const running = writer.sendThreadInput(beta.id, 'count to 120');
        await flush();

        // The target is in flight: one request has arrived and no answer exists yet.
        expect(targetRequests).toBe(1);
        expect(writer.thread(beta.id)?.status).toBe('running');

        // THE SEND ITSELF. The sender's own turn COMPLETES while beta's request is
        // still held — that is the non-blocking half of T3.2 on the running branch.
        const sender = await writer.sendThreadInput(alpha.id, 'tell beta to stop');
        expect(sender.content).toBe('alpha told beta');
        expect(targetRequests).toBe(1);
        expect(writer.thread(beta.id)?.status).toBe('running');

        expect(JSON.parse(toolResultsOf(writer.threadMessages(alpha.id))[0]!)).toEqual({
            threadId: beta.id,
            delivered: 'queued',
            sender: 'writer',
            senderThreadId: alpha.id
        });

        // Nothing landed inside the request that was already in flight (R5).
        expect(withoutIds(writer.threadMessages(beta.id))).toEqual([
            { role: 'user', content: 'count to 120' }
        ]);

        heldAnswer.open();
        await running;

        // THE ANSWER CHANGED. The steered text became a user message at the boundary
        // and the very next turn answered to it: 120 is what the first request was
        // working on, and the restated instruction is what the steer produced.
        expect(withoutIds(writer.threadMessages(beta.id))).toEqual([
            { role: 'user', content: 'count to 120' },
            { role: 'assistant', content: 'REACHED: 120' },
            {
                role: 'user',
                content: 'from agent "writer" (thread thread-1):\ncount to 30, not 120'
            },
            {
                role: 'assistant',
                content:
                    'last instruction: from agent "writer" (thread thread-1):\ncount to 30, not 120'
            }
        ]);
        expect(textOf(seen[1]!.messages)).toEqual([
            'count to 120',
            'REACHED: 120',
            'from agent "writer" (thread thread-1):\ncount to 30, not 120'
        ]);
        expect(writer.thread(beta.id)?.status).toBe('idle');
    });

    // T3.2 + T3.6 — an idle conversation is no longer a parking lot for a message:
    // the send starts a run, and the receipt says so without waiting for the answer.
    it('starts a run in an idle conversation and returns before the answer exists (T3.2, T3.6)', async () => {
        const model = gatedAnswer('the late answer');
        const writer = quiet(brain(model.stream));
        const target = writer.createThread('writer', { label: 'Idle' });

        expect(writer.thread(target.id)?.status).toBe('idle');

        const receipt = probe(
            writer.executeTool('threadSend', { thread: target.id, message: 'wake up' })
        );
        await flush();

        // The receipt is in, and the run it promised is live but UNANSWERED: the
        // provider has been reached and the reply is still behind the gate. A send
        // that awaited the answer could not report both of these facts at once.
        expect(receipt.status).toBe('resolved');
        expect(receipt.value).toEqual({
            threadId: target.id,
            delivered: 'started',
            sender: 'writer'
        });
        expect(model.arrivals()).toBe(1);
        expect(writer.thread(target.id)?.status).toBe('running');

        model.ready.open();
        await settleThread(writer, target.id);

        // The attributed message IS the run's prompt, and the answer is its own.
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'from agent "writer":\nwake up' },
            { role: 'assistant', content: 'the late answer' }
        ]);
        expect(writer.thread(target.id)?.status).toBe('idle');
    });

    // T3.2 — the `paused` gap, REVISED by compaction T8 (2026-11-10). This case used to
    // pin "lift the park, then start a turn"; T8 retired that because a message that
    // merely ARRIVES at a parked conversation was stealing the turn of whoever parked it
    // (the compaction holder). A `turn.before` hook still parks the conversation and
    // never resumes it, so the park outlives the run exactly as
    // src/harness.plugin.test.ts pins — and the send now queues.
    it('queues into a plugin park and leaves the parked conversation alone (T3.2, T8)', async () => {
        const observed: string[] = [];
        let parkOnce = true;

        const writer = harness({
            agents: {
                writer: brain(scripted([answer('first answer'), answer('second answer')]))
            },
            plugins: [
                {
                    name: 'parker',
                    setup: (api) => {
                        api.on('thread.resumed', (payload) => {
                            observed.push(`resumed:${payload.status}`);
                        });
                        api.on('turn.before', async (payload) => {
                            if (!parkOnce) return;
                            parkOnce = false;
                            // Parked, and deliberately never resumed by the plugin.
                            await payload.pause();
                        });
                    }
                }
            ],
            presets: false
        });

        const target = writer.createThread('writer', { label: 'Parked' });
        await writer.sendThreadInput(target.id, 'first turn');

        expect(writer.thread(target.id)?.status).toBe('paused');
        expect(observed).toEqual([]);

        await expect(
            writer.executeTool('threadSend', { thread: target.id, message: 'carry on' })
        ).resolves.toEqual({
            threadId: target.id,
            delivered: 'queued',
            sender: 'writer'
        });

        // THE PARK IS NOT LIFTED: no `thread.resumed` for the plugin that parked it, the
        // record is still `paused`, and the attributed text has not reached the
        // transcript — it sits in the thread's queue until a boundary drains it.
        expect(observed).toEqual([]);
        expect(writer.thread(target.id)?.status).toBe('paused');
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first answer' }
        ]);

        // A HOST turn remains the revival path (unchanged; pinned from the plugin side in
        // src/harness.thread-park-queue.test.ts). Un-parking returns the record to the
        // status the run loop would give it — `idle`, because the parked run had already
        // ended — and the queued message then becomes a user turn at the new run's FIRST
        // boundary, after that run's own prompt (`drainThreadQueue`).
        await writer.sendThreadInput(target.id, 'host turn');

        expect(observed).toEqual(['resumed:idle']);
        expect(withoutIds(writer.threadMessages(target.id))).toEqual([
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'host turn' },
            { role: 'user', content: 'from agent "writer":\ncarry on' },
            { role: 'assistant', content: 'second answer' }
        ]);
        expect(writer.thread(target.id)?.status).toBe('idle');
    });

    // T3.3 — the merge covers idle and paused, NOT stopped. Pinned here from a real
    // model-driven call (the sibling T6 test above pins the manual host door); the
    // throw must survive as an ordinary failed tool result, so the caller learns the
    // refusal instead of quietly resurrecting a conversation the operator stopped.
    it('leaves a stopped conversation untouched when a model sends into it (T3.3)', async () => {
        const writer = harness({
            agents: {
                writer: brain(
                    scripted([
                        callTool(
                            'c1',
                            'threadSend',
                            JSON.stringify({ thread: 'thread-2', message: 'agent ping' })
                        ),
                        answer('alpha read the refusal')
                    ])
                )
            },
            presets: false
        });

        const alpha = writer.createThread('writer');
        const beta = writer.createThread('writer');

        writer.stopThread(beta.id, 'operator stop');

        const message = await writer.sendThreadInput(alpha.id, 'ping the stopped one');
        expect(message.content).toBe('alpha read the refusal');

        expect(toolResultsOf(writer.threadMessages(alpha.id))).toEqual([
            `Tool "threadSend" failed: Thread "${beta.id}" is stopped; it cannot receive messages until a host resumes or deletes it.`
        ]);

        // Nothing moved: no revival, no queued guidance, no text in the transcript.
        expect(writer.thread(beta.id)).toEqual({
            id: beta.id,
            agent: 'writer',
            origin: 'host',
            status: 'stopped',
            sequence: 3
        });
        expect(writer.threadMessages(beta.id)).toEqual([]);
    });
});
// ---------------------------------------------------------------------------
// B3 / B4 / B5 (2026-11-13) — the thread family is the address space
// ---------------------------------------------------------------------------
//
// Before this, EVERY thread id was a global id: `threadList` printed the session, and
// `threadSend`/`threadRead`/`threadDelete` accepted any id it printed. In a fan-out
// session (issue 0027: one parent, nineteen delegated children) a settled child could
// therefore post into a sibling subtree it had never spoken to, read a conversation nobody
// pointed it at, and drown in roster rows it could not act on. The three findings are one
// rule seen from three doors:
//
//   B3 the roster (`threadList`) and the two reads (`harness.thread`,
//      `harness.threadMessages`, the `threadRead` tool) see the caller's THREAD FAMILY —
//      itself, its ancestors, its descendants however deep, and the DEFAULT conversations
//      of the agents that family spans. A sibling is NOT in the family: it shares an
//      ancestor, and this caller did not create it.
//   B4 `threadSend` accepts exactly the ids B3 makes visible, and a caller may not START a
//      conversation it is already standing in (its own thread, or this agent's idle
//      default) — starting those is a nested run with worse manners, not a chat.
//   B5 `threadDelete` is the NARROWEST door: strict descendants only, and its receipt
//      names every conversation that actually left, cascade included.
//
// A CALLER WITH NO THREAD (the host, a plugin outside any conversation, a manual
// `executeTool`) stays UNSCOPED everywhere, and that is pinned once per group: the host is
// the one party allowed to address any conversation, and the server's thread surfaces
// depend on it staying true.
//
// The model-facing refusals go through REAL TURNS, because `executeTool(name, parameters)`
// takes no caller thread — it is the unscoped host door by construction and cannot
// exhibit a guard. One thread therefore runs one scripted SEQUENCE of door calls, one per
// turn; `routed` keys on a thread's first prompt, so a thread with several turns cannot
// also be several scenarios.
describe('thread family visibility, send policy, and release (B3/B4/B5)', () => {
    // One thread calling thread doors once per turn, then answering. The arguments are
    // THUNKS because the ids they name do not exist until the fixture has created the
    // threads, and a route table is declared before that.
    const modelDoors = (
        calls: Array<{ name: string; args: () => Record<string, unknown> }>,
        reply: string
    ): HarnessStream => {
        let turn = 0;

        return async function* stream() {
            const call = calls[turn];
            turn += 1;

            const frames =
                call === undefined
                    ? answer(reply)
                    : callTool(`m${turn}`, call.name, JSON.stringify(call.args()));

            for (const frame of frames) yield frame;
        };
    };

    // The SAME doors, one per HOST TURN. Every call is followed by an answer step, which
    // ENDS that run: a harness keeps taking model turns while the model calls tools, so
    // without the answer step a list of calls all lands inside ONE run — and these cases
    // are about a LATER turn of the conversation, after the situation changed.
    const modelTurns = (
        calls: Array<{ name: string; args: () => Record<string, unknown> }>,
        reply: string
    ): HarnessStream => {
        let step = 0;

        return async function* stream() {
            const index = step;
            step += 1;

            const call = calls[Math.floor(index / 2)];
            const frames =
                call === undefined || index % 2 === 1
                    ? answer(reply)
                    : callTool(
                          `m${Math.floor(index / 2) + 1}`,
                          call.name,
                          JSON.stringify(call.args())
                      );

            for (const frame of frames) yield frame;
        };
    };

    // The single-call form, which is most of these cases.
    const modelDoor = (
        name: string,
        args: () => Record<string, unknown>,
        reply: string
    ): HarnessStream => modelDoors([{ name, args }], reply);

    // Every recorded tool result of one conversation, in call order. A refusal reaches the
    // model as `Tool "<name>" failed: <message>` (src/harness.ts), which is exactly what
    // these assertions read back out of the sender's transcript.
    const doorResults = (host: Harness, threadId: string): string[] =>
        toolResultsOf(host.threadMessages(threadId));

    const firstResult = (host: Harness, threadId: string): string => doorResults(host, threadId)[0] ?? '';

    // A conversation tree the HOST opened, spanning two agents:
    //   parent (writer)  <- child (writer)  <- borrowed (scout)
    //   sibling (writer) — no owner, so OUTSIDE child's family
    // plus the two default conversations `agent:writer` and `agent:scout`.
    const lineage = (
        routes: Record<string, HarnessStream>,
        scoutRoutes: Record<string, HarnessStream> = {}
    ) => {
        const writer = harness({
            agents: {
                writer: brain(routed(routes, scripted([answer('writer answers')]))),
                scout: brain(routed(scoutRoutes, scripted([answer('scout answers')])))
            },
            presets: false
        });

        const parent = writer.createThread('writer');
        const child = writer.createThread('writer', { ownerThreadId: parent.id });
        const sibling = writer.createThread('writer');
        const borrowed = writer.createThread('scout', { ownerThreadId: child.id });

        return { writer, parent, child, sibling, borrowed };
    };

    // The family of `child`, in roster order (sequence, which is creation order). The two
    // defaults come first because the harness mints one per agent up front.
    const childFamily = (ids: { parent: string; child: string; borrowed: string }): string[] => [
        'agent:writer',
        'agent:scout',
        ids.parent,
        ids.child,
        ids.borrowed
    ];

    it('a scoped roster is the family of the caller, and the host roster stays session-wide (B3)', async () => {
        const { writer, parent, child, sibling, borrowed } = lineage({
            'who can I see?': modelDoor('threadList', () => ({}), 'roster read')
        });

        await writer.sendThreadInput(child.id, 'who can I see?');

        const roster = JSON.parse(firstResult(writer, child.id)) as {
            currentThreadId?: string;
            threads: Record<string, unknown>[];
        };

        // The caller is named, and the rows are ITS family: the ancestor, the conversation
        // two levels down (a scout thread, because the family spans agents), and the
        // default conversations of the agents in that family. `sibling` is absent — the
        // roster is the address book for the doors below, and this caller cannot walk
        // through that row.
        expect(roster.currentThreadId).toBe(child.id);
        expect(roster.threads).toEqual([
            { id: 'agent:writer', agent: 'writer', origin: 'agent', status: 'idle', sequence: 1 },
            { id: 'agent:scout', agent: 'scout', origin: 'agent', status: 'idle', sequence: 2 },
            { id: parent.id, agent: 'writer', origin: 'host', status: 'idle', sequence: 3 },
            {
                id: child.id,
                agent: 'writer',
                origin: 'host',
                status: 'running',
                sequence: 4,
                ownerThreadId: parent.id,
                invocationId: '1'
            },
            {
                id: borrowed.id,
                agent: 'scout',
                origin: 'host',
                status: 'idle',
                sequence: 6,
                ownerThreadId: child.id
            }
        ]);

        expect(roster.threads.map((record) => record.id)).not.toContain(sibling.id);

        // UNSCOPED stays UNSCOPED: the same tool with no caller thread (a manual
        // executeTool is an operator action) is the session-wide host view — sibling
        // included, `currentThreadId` absent, the pre-B3 shape unchanged.
        const hostRoster = (await writer.executeTool('threadList', {})) as {
            currentThreadId?: string;
            threads: { id: string }[];
        };

        expect(hostRoster.currentThreadId).toBeUndefined();
        expect(hostRoster.threads.map((record) => record.id)).toEqual([
            'agent:writer',
            'agent:scout',
            parent.id,
            child.id,
            sibling.id,
            borrowed.id
        ]);
    });

    it('the two host read seams reach the family and refuse a sibling by name (B3)', () => {
        const { writer, parent, child, sibling, borrowed } = lineage({});
        const notVisible = (target: string): string =>
            `Thread "${target}" is not visible to thread "${child.id}": a read reaches your own thread, an ` +
            'ancestor, one of your descendants, or a default conversation (agent:<name>) your roster lists (see ' +
            'threadList). The id exists — it is simply outside your lineage.';

        // Every family member reads with `child` as the caller — the ancestor, its own
        // thread, a descendant two levels down, and BOTH defaults (including the scout's,
        // because a scout conversation hangs inside this family).
        for (const id of childFamily({ parent: parent.id, child: child.id, borrowed: borrowed.id })) {
            expect(writer.thread(id, child.id)?.id).toBe(id);
            expect(writer.threadMessages(id, child.id)).toEqual([]);
        }

        // A SIBLING exists, so the answer is the lineage sentence rather than the
        // not-found sentence: "re-read your roster" and "typo or released conversation" are
        // different facts for a caller choosing its next call. The check sits in front of
        // the branch-ledger fallback so a live thread is never mistaken for an unknown id.
        expect(() => writer.thread(sibling.id, child.id)).toThrow(notVisible(sibling.id));
        expect(() => writer.threadMessages(sibling.id, child.id)).toThrow(notVisible(sibling.id));

        // An id that resolves for NOBODY keeps `threadStateOf`'s canonical sentence, and the
        // two seams differ in their honest way of saying it: `thread` answers `undefined`
        // (its contract is a record or nothing), `threadMessages` throws. Neither one turns a
        // typo into a lineage lesson, with a caller present or not.
        const unknown = 'Thread "thread-99" is not available in this harness; it was never created, or it was deleted.';

        expect(writer.thread('thread-99', child.id)).toBeUndefined();
        expect(writer.thread('thread-99')).toBeUndefined();
        expect(() => writer.threadMessages('thread-99', child.id)).toThrow(unknown);
        expect(() => writer.threadMessages('thread-99')).toThrow(unknown);

        // Without a caller both seams are the host view, so the sibling reads fine: this is
        // what keeps the server and every host surface behaving exactly as before B3.
        expect(writer.thread(sibling.id)?.id).toBe(sibling.id);
        expect(writer.threadMessages(sibling.id)).toEqual([]);
    });

    // STRESS REPORT #5 (2026-11-14) — A REFUSAL THAT IS TRUE BUT USELESS.
    //
    // A default conversation is in a family through the conversations of that agent the family
    // spans (`threadFamilyOf` step 4), so releasing the last one of them quietly drops
    // `agent:<name>` out of the roster — and both doors then answered only "the id exists, it is
    // outside your lineage", which names no cause and no way back. The FAMILY RULE AND THE
    // VERDICT ARE UNCHANGED here (issue 0027's narrowing stands, and widening the family to all
    // configured agents was reviewed and rejected: a default is the agent's standing transcript
    // and would leak other callers' content across families). What changed is the sentence, for
    // a default target only.
    it('a default conversation that left the family names the cause and the remedy (stress report #5)', async () => {
        const { writer, child, sibling, borrowed } = lineage({
            'ask my family': modelDoors(
                [
                    { name: 'threadRead', args: () => ({ thread: 'agent:scout' }) },
                    { name: 'threadSend', args: () => ({ thread: 'agent:scout', message: 'still there?' }) },
                    // The control: a NON-default address outside the family (a sibling) has no
                    // remedy, and its sentence must not gain one.
                    { name: 'threadSend', args: () => ({ thread: sibling.id, message: 'unsolicited' }) }
                ],
                'all refused'
            )
        });

        // BEFORE the release: the scout thread is in this family, so its agent's default is
        // addressable, and the roster says so. Pinning the visible state first is what makes the
        // AFTER assertions about the sentence rather than about the verdict.
        expect(writer.thread('agent:scout', child.id)?.id).toBe('agent:scout');
        expect(writer.threadMessages('agent:scout', child.id)).toEqual([]);

        // Releasing the last scout conversation of the family. This delete purged nothing else,
        // which is the other half of the receipt contract (stress report #6): empty arrays, not
        // missing fields.
        expect(writer.deleteThread(borrowed.id)).toEqual({
            deleted: borrowed.id,
            removedThreadIds: [borrowed.id],
            removedInvocationIds: [],
            removedBranchIds: []
        });

        const base = (target: string): string =>
            `Thread "${target}" is not visible to thread "${child.id}": a read reaches your own thread, an ` +
            'ancestor, one of your descendants, or a default conversation (agent:<name>) your roster lists (see ' +
            'threadList). The id exists — it is simply outside your lineage.';

        // C2 (2026-11-14, independent review): the CAUSE is hedged — this clause fires for any
        // out-of-family `agent:<name>`, and a caller that never delegated to `scout` never had
        // its default in its lineage. It must not assert a delete the caller did not perform.
        // The REMEDY is unconditional, because re-delegating admits the address under either cause.
        const defaultClause =
            ` The cause is specific: "agent:scout" is agent "scout"'s default conversation, so either it was ` +
            'never in your lineage or it left when the last of your conversations running "scout" was ' +
            'deleted. Delegate to "scout" again — the conversation it mints re-admits this address, and ' +
            'threadRead/threadSend reach it from then on.';

        // STILL INVISIBLE — the verdict is untouched (AC6): the record simply is not in this
        // caller's family, and now the refusal says why and how to get it back.
        expect(() => writer.thread('agent:scout', child.id)).toThrow(base('agent:scout') + defaultClause);
        expect(() => writer.threadMessages('agent:scout', child.id)).toThrow(
            base('agent:scout') + defaultClause
        );

        // THE MODEL FEELS BOTH DOORS. One run of `child`, three calls: the read refusal, the
        // send refusal for the same default (the send sentence is a different base, and it carries
        // the same clause), and the send refusal for a sibling — which keeps the old text byte for
        // byte, with no clause appended.
        await writer.sendThreadInput(child.id, 'ask my family');

        expect(doorResults(writer, child.id)).toEqual([
            `Tool "threadRead" failed: ${base('agent:scout')}${defaultClause}`,
            `Tool "threadSend" failed: Thread "agent:scout" is not one thread "${child.id}" can address: ` +
                "threadSend reaches your own thread, an ancestor, one of your descendants, or a default " +
                'conversation (agent:<name>) your roster lists (see threadList). The id exists — it is simply ' +
                'outside your lineage.' +
                defaultClause,
            `Tool "threadSend" failed: Thread "${sibling.id}" is not one thread "${child.id}" can address: ` +
                "threadSend reaches your own thread, an ancestor, one of your descendants, or a default " +
                'conversation (agent:<name>) your roster lists (see threadList). The id exists — it is simply ' +
                'outside your lineage.'
        ]);
    });

    it('threadSend reaches an ancestor, a descendant, and the default of another agent (B4)', async () => {
        const { writer, parent, child, borrowed } = lineage({
            // ONE call per thread: a thread routes on its first prompt, so several
            // scenarios need several conversations.
            'tell my parent': modelDoor(
                'threadSend',
                () => ({ thread: parent.id, message: 'the child is reporting' }),
                'parent told'
            ),
            'tell my grandchild and the scout': modelDoors(
                [
                    { name: 'threadSend', args: () => ({ thread: borrowed.id, message: 'the parent is asking' }) },
                    { name: 'threadSend', args: () => ({ thread: 'agent:scout', message: 'a writer thread is asking' }) }
                ],
                'both told'
            )
        });

        // The PARENT speaks first, and its own conversation is the caller for two
        // addresses: a DESCENDANT two levels down — another agent's host thread, but one
        // this family minted — and that other agent's DEFAULT conversation, which stays
        // addressable because the family spans the agents in it, not only the threads.
        // (`modelDoors` is one door per turn of one conversation, so both calls happen in
        // the same run of the parent.)
        await writer.sendThreadInput(parent.id, 'tell my grandchild and the scout');
        expect(doorResults(writer, parent.id).map((content) => JSON.parse(content))).toEqual([
            {
                threadId: borrowed.id,
                delivered: 'started',
                sender: 'writer',
                senderThreadId: parent.id
            },
            {
                threadId: 'agent:scout',
                delivered: 'started',
                sender: 'writer',
                senderThreadId: parent.id,
                // The `note` is present HERE, and its presence is the point: the first send
                // of this same run started `borrowed`, a scout conversation that is still
                // in flight while the second send lands. `agent:scout` therefore reads as
                // an ambiguous address, and the receipt names the live thread instead of
                // letting the caller assume the default is where the agent is working.
                note:
                    '"agent:scout" is scout\'s default conversation, and this message went there. ' +
                    `The live scout conversation is thread "${borrowed.id}"; address that id to reach the turn in flight.`
            }
        ]);

        await settleThread(writer, borrowed.id);
        expect(textOf(writer.threadMessages(borrowed.id))).toEqual([
            `from agent "writer" (thread ${parent.id}):\nthe parent is asking`,
            'scout answers'
        ]);

        // The cross-agent chat is the historical behaviour B4 keeps: no `note` here,
        // because no scout turn was in flight, so the address is not ambiguous.
        await settleThread(writer, 'agent:scout');
        expect(textOf(writer.threadMessages('agent:scout'))).toEqual([
            `from agent "writer" (thread ${parent.id}):\na writer thread is asking`,
            'scout answers'
        ]);

        // An ANCESTOR, dormant: the message becomes its new prompt (`started`), and the
        // receipt names the sender's thread so the target can address IT back. The last
        // two entries of the parent's transcript are the attributed message and the turn
        // it started.
        await writer.sendThreadInput(child.id, 'tell my parent');
        expect(JSON.parse(firstResult(writer, child.id))).toEqual({
            threadId: parent.id,
            delivered: 'started',
            sender: 'writer',
            senderThreadId: child.id
        });

        await settleThread(writer, parent.id);
        expect(textOf(writer.threadMessages(parent.id)).slice(-2)).toEqual([
            `from agent "writer" (thread ${child.id}):\nthe child is reporting`,
            'both told'
        ]);
    });

    it('threadSend refuses a sibling, and never starts the conversation it is standing in (B4)', async () => {
        const { writer, parent, child, sibling } = lineage({
            'tell my sibling': modelDoor(
                'threadSend',
                () => ({ thread: sibling.id, message: 'unsolicited' }),
                'sibling refused'
            ),
            'my own doors': modelDoors(
                [
                    // its own thread, dormant
                    { name: 'threadSend', args: () => ({ thread: parent.id, message: 'thinking aloud' }) },
                    // this agent's own default, idle
                    { name: 'threadSend', args: () => ({ thread: 'agent:writer', message: 'standing order' }) },
                    // a dormant thread it minted: allowed, and the point of the pair
                    { name: 'threadSend', args: () => ({ thread: child.id, message: 'do the work' }) }
                ],
                'own doors answered'
            )
        });

        // A SIBLING is neither visible nor writable, and the sentence points at the roster
        // because the caller's next move is a roster read.
        await writer.sendThreadInput(child.id, 'tell my sibling');
        expect(firstResult(writer, child.id)).toBe(
            `Tool "threadSend" failed: Thread "${sibling.id}" is not one thread "${child.id}" can address: ` +
                "threadSend reaches your own thread, an ancestor, one of your descendants, or a default " +
                'conversation (agent:<name>) your roster lists (see threadList). The id exists — it is simply outside your lineage.'
        );
        expect(writer.threadMessages(sibling.id)).toEqual([]);

        // ITS OWN THREAD (dormant): the answer is THIS turn, not a second turn. A message
        // into yourself queues behind the turn that is asking it, which is how "I messaged
        // myself" becomes a lost round-trip.
        // THIS AGENT'S OWN DEFAULT (idle): the same trap one step away — `agent:writer`
        // looks like "the conversation this agent is having", and a message into it starts
        // a second turn of the agent that is asking.
        await writer.sendThreadInput(parent.id, 'my own doors');
        // ITS OWN THREAD: a caller standing in a turn can only STEER that turn, and that is
        // exactly what the send becomes — the next-boundary queue of the run that is
        // asking. (The dormant variant of this address has its own refusal sentence, "is the
        // conversation this message comes from", which no live run can reach: while a
        // thread's model is calling the tool, its own thread is by definition running. That
        // sentence is for a caller whose thread has been released around it.)
        expect(JSON.parse(doorResults(writer, parent.id)[0])).toEqual({
            threadId: parent.id,
            delivered: 'queued',
            sender: 'writer',
            senderThreadId: parent.id
        });
        expect(doorResults(writer, parent.id)[1]).toBe(
            `Tool "threadSend" failed: "agent:writer" is agent "writer"'s own conversation and is idle: a ` +
                'message into it would start a second turn of the agent that is asking. Use this turn, or ' +
                'address a thread you created (see threadList).'
        );

        // The rule does NOT reach down: a parent still wakes a dormant thread it minted —
        // that is how a fan-out parent drives its one-shot children.
        expect(JSON.parse(doorResults(writer, parent.id)[2])).toEqual({
            threadId: child.id,
            delivered: 'started',
            sender: 'writer',
            senderThreadId: parent.id
        });

        await settleThread(writer, child.id);
        // The woken conversation is the SECOND run of `child` (its first run was the
        // sibling send), so the attributed message and the turn it started are the last
        // two entries — the message IS the new prompt, appended by that run itself.
        expect(textOf(writer.threadMessages(child.id)).slice(-2)).toEqual([
            `from agent "writer" (thread ${parent.id}):\ndo the work`,
            'sibling refused'
        ]);

        // The RUNNING branch (steer rather than start) is unchanged by B4 and is pinned
        // with a genuinely mid-request target in `threadSend is state-aware
        // (delegate-stress T3.1-T3.6)` above.
    });

    it('a send addressed at a default conversation names the thread already in flight (B4/C1)', async () => {
        const slow = gatedAnswer('slow writer turn');

        const { writer, parent, borrowed } = lineage(
            { 'slow work': slow.stream },
            {
                'tell the writers': modelDoor(
                    'threadSend',
                    () => ({ thread: 'agent:writer', message: 'a scout thread is asking' }),
                    'default told'
                )
            }
        );

        // A writer turn genuinely in flight, created BY THE SENDER so it sits inside the
        // sender's family rather than beside it (T5/#2, 2026-11-14 — `note` may only name an
        // id the caller can actually use; the sibling shape is pinned one test below, where
        // the same live thread is out of reach and the note is withheld).
        const worker = writer.createThread('writer', { ownerThreadId: borrowed.id });
        const running = writer.sendThreadInput(worker.id, 'slow work');
        await flush();
        expect(writer.thread(worker.id)?.status).toBe('running');

        // The sender is a SCOUT thread, so `agent:writer` is not its own conversation and
        // the send is legal. The address is still ambiguous: the message lands in the
        // writer DEFAULT conversation while the turn a reader cares about is `worker`. The
        // receipt stays honest about where the message went (`threadId` is the truth), and
        // `note` names the live thread so the caller can address the turn instead — the
        // confusion this field exists for, reported instead of inferred.
        await writer.sendThreadInput(borrowed.id, 'tell the writers');
        expect(JSON.parse(firstResult(writer, borrowed.id))).toEqual({
            threadId: 'agent:writer',
            delivered: 'started',
            sender: 'scout',
            senderThreadId: borrowed.id,
            note:
                '"agent:writer" is writer\'s default conversation, and this message went there. ' +
                `The live writer conversation is thread "${worker.id}"; address that id to reach the turn in flight.`
        });

        await settleThread(writer, 'agent:writer');
        expect(textOf(writer.threadMessages('agent:writer'))).toEqual([
            `from agent "scout" (thread ${borrowed.id}):\na scout thread is asking`,
            'writer answers'
        ]);

        slow.ready.open();
        await running;
        expect(writer.thread(worker.id)?.status).toBe('idle');
    });

    it('the threadless host door keeps sending across the whole session (B4)', async () => {
        const { writer, child, sibling } = lineage({});

        // A manual `executeTool` has no caller thread, so it is the HOST speaking: the
        // sibling send a scoped model turn cannot make still works, and the receipt carries
        // no `senderThreadId` because the host stands in no conversation.
        const receipt = (await writer.executeTool('threadSend', {
            thread: sibling.id,
            message: 'host note'
        })) as Record<string, unknown>;

        expect(receipt).toEqual({ threadId: sibling.id, delivered: 'started', sender: 'writer' });

        await settleThread(writer, sibling.id);
        expect(textOf(writer.threadMessages(sibling.id))).toEqual([
            'from agent "writer":\nhost note',
            'writer answers'
        ]);

        // A family member is equally reachable from the host.
        await writer.executeTool('threadSend', { thread: child.id, message: 'host note 2' });
        await settleThread(writer, child.id);
        expect(textOf(writer.threadMessages(child.id))).toEqual([
            'from agent "writer":\nhost note 2',
            'writer answers'
        ]);
    });

    it('deleteThread reports every conversation it released, cascade included (B5)', () => {
        const { writer, parent, child, sibling, borrowed } = lineage({});

        // The receipt is the state the caller CAUSED: the id it named, plus everything that
        // actually went — the M2 cascade of settled descendants, in creation order. `parent`
        // owns `child`, which owns `borrowed`, so one call releases three conversations and
        // a reaping parent can PROVE what it freed.
        expect(writer.deleteThread(parent.id)).toEqual({
            deleted: parent.id,
            removedThreadIds: [parent.id, child.id, borrowed.id],
            // Nothing ran in this lineage, so the purge took no lookups — and the receipt says
            // so with EMPTY arrays rather than omitting the fields (stress report #6).
            removedInvocationIds: [],
            removedBranchIds: []
        });

        expect(writer.threads().map((record) => record.id)).toEqual([
            'agent:writer',
            'agent:scout',
            sibling.id
        ]);

        // A leaf release reports exactly one id, and the host door is UNSCOPED: it may close
        // a terminal conversation anywhere in the session, including a sibling — the very
        // target a model turn would be refused.
        expect(writer.deleteThread(sibling.id)).toEqual({
            deleted: sibling.id,
            removedThreadIds: [sibling.id],
            removedInvocationIds: [],
            removedBranchIds: []
        });
        expect(writer.threads().map((record) => record.id)).toEqual(['agent:writer', 'agent:scout']);

        // The default conversations are not a delete door at all; that refusal predates B5
        // and the receipt did not change it.
        expect(() => writer.deleteThread('agent:writer')).toThrow(
            `Thread "agent:writer" is the agent's own conversation and cannot be deleted; use reset() to clear the session.`
        );
    });

    it('threadDelete is a descendant door: a parent reaps its child, and nothing else (B5)', async () => {
        const { writer, parent, child, sibling, borrowed } = lineage({
            'reap what is not mine': modelDoors(
                [
                    { name: 'threadDelete', args: () => ({ thread: parent.id }) },
                    { name: 'threadDelete', args: () => ({ thread: sibling.id }) }
                ],
                'both refused'
            ),
            'reap what is mine': modelDoors(
                [
                    { name: 'threadDelete', args: () => ({ thread: borrowed.id }) },
                    { name: 'threadDelete', args: () => ({ thread: child.id }) }
                ],
                'both reaped'
            )
        });

        // UP and SIDEWAYS are refused, and the sentence names every address this door will
        // not take. The lineage check runs BEFORE the running check, so a thread the caller
        // could not delete anyway is never reported as "still running".
        const lineageRefusal = (target: string): string =>
            `Tool "threadDelete" failed: Thread "${target}" is not one of the conversations "${child.id}" created; ` +
            'threadDelete releases your own descendants (see threadList) — never your current thread, an ' +
            "ancestor, a sibling, or another agent's conversation.";

        await writer.sendThreadInput(child.id, 'reap what is not mine');
        expect(doorResults(writer, child.id)).toEqual([lineageRefusal(parent.id), lineageRefusal(sibling.id)]);
        expect(writer.thread(sibling.id)).toBeDefined();

        // DOWN is the caller's, however deep: a grandchild minted two levels away releases
        // on its own, and the receipt shrinks to what is actually released — which is what
        // makes a reaping loop auditable instead of a guess.
        await writer.sendThreadInput(parent.id, 'reap what is mine');
        expect(doorResults(writer, parent.id).map((content) => JSON.parse(content))).toEqual([
            // The grandchild never ran a turn, so its release purges no lookup; the child DID
            // (it ran 'reap what is not mine', invocation `1`), and the receipt names the id the
            // caller would otherwise only find missing from `agentManage` afterwards.
            {
                deleted: borrowed.id,
                removedThreadIds: [borrowed.id],
                removedInvocationIds: [],
                removedBranchIds: []
            },
            {
                deleted: child.id,
                removedThreadIds: [child.id],
                removedInvocationIds: ['1'],
                removedBranchIds: []
            }
        ]);

        expect(writer.threads().map((record) => record.id)).toEqual([
            'agent:writer',
            'agent:scout',
            parent.id,
            sibling.id
        ]);
    });

    it('a running descendant still refuses the delete, and a released one is unknown afterwards (B5)', async () => {
        const held = gatedAnswer('child at work');

        const { writer, parent, child, borrowed } = lineage({
            'start work': held.stream,
            // One door per HOST TURN (see `modelTurns`): the state under test changes
            // between turns, so all three calls must land in three separate runs of the
            // parent conversation.
            'reap the worker': modelTurns(
                [
                    { name: 'threadDelete', args: () => ({ thread: child.id }) },
                    { name: 'threadDelete', args: () => ({ thread: child.id }) },
                    { name: 'threadDelete', args: () => ({ thread: child.id }) }
                ],
                'done reaping'
            )
        });

        // The child is genuinely mid-run: its answer is behind the gate.
        const running = writer.sendThreadInput(child.id, 'start work');
        await flush();
        expect(writer.thread(child.id)?.status).toBe('running');

        // TURN 1, while the run is live. B2 made a FINISHED conversation deletable from
        // inside its own `run.finished` hook; it did not loosen this. A live run still owns
        // its thread, so the refusal is the running sentence and the receipt never claims a
        // release that did not happen.
        await writer.sendThreadInput(parent.id, 'reap the worker');
        expect(doorResults(writer, parent.id)).toEqual([
            `Tool "threadDelete" failed: Thread "${child.id}" is running; stop it before deleting it.`
        ]);
        expect(writer.thread(child.id)).toBeDefined();

        held.ready.open();
        await running;
        expect(writer.thread(child.id)?.status).toBe('idle');

        // TURN 2, the same conversation on a later turn of the same route: the release is
        // accepted, and the receipt names the cascade this caller caused — `borrowed` is the
        // child's own conversation, and a released parent never leaves a live child behind.
        await writer.sendThreadInput(parent.id, 'reap the worker again');
        expect(doorResults(writer, parent.id)[1]).toBeDefined();
        expect(JSON.parse(doorResults(writer, parent.id)[1] ?? '{}')).toEqual({
            deleted: child.id,
            removedThreadIds: [child.id, borrowed.id],
            // The child's own turn is the one lookup that goes; `borrowed` never ran, and the
            // cascade adds nothing to the set.
            removedInvocationIds: ['1'],
            removedBranchIds: []
        });

        // TURN 3: a SECOND delete of the same id is the canonical unknown-thread refusal.
        // A released conversation is indistinguishable from one that never existed, which is
        // what makes a reaping retry safe rather than destructive.
        await writer.sendThreadInput(parent.id, 'reap the worker again');
        expect(doorResults(writer, parent.id)[2]).toBe(
            `Tool "threadDelete" failed: Thread "${child.id}" is not available in this harness; it was never created, or it was deleted.`
        );
        expect(doorResults(writer, parent.id)).toHaveLength(3);
    });

    // ---------------------------------------------------------------------------
    // T5 (2026-11-14, stress report) — THE REPLY ROUTE A STARTED RUN NEEDS.
    //
    // A `threadSend` into a DORMANT DEFAULT conversation has no parent, so nothing ever
    // writes an `ownerThreadId` for it: steps 2-4 of `threadFamilyOf` (src/harness.ts)
    // compute a SINGLETON family, and the turn that was just woken could not answer the
    // party that woke it — every `threadSend`/`threadRead` back at the sender's id was
    // refused "outside your lineage", which is the one sentence that is wrong for the
    // conversation that received the message. The fix is step 5: the run attached to a
    // default conversation folds its own REPLY TARGET (`RunState.replyThreadId`, written
    // only by `postThreadMessage`'s dormant-start branch) into that conversation's family
    // — the SENDER'S ID ONLY, for the LIFE OF THE RUN.
    //
    // This group pins all four properties of that rule: the route exists (AC1/AC2), it is
    // exactly one id and nothing else (AC2's roster), it reverts when the run releases
    // (AC3), and nothing is persisted to make it work (AC4). A nested `describe` because
    // the fixtures it needs (`modelDoors`, `doorResults`, `lineage`) are this group's.
    // ---------------------------------------------------------------------------
    describe('a started default conversation can answer the thread that woke it (T5)', () => {
        // A door list that does not move until the test opens the gate. Determinism, not
        // theatre: the started run must reach its tool calls only AFTER the sender's run
        // has released, or the reply's `delivered` would race between 'started' (sender
        // idle) and 'steered' (sender still running) and every exact pin below would be a
        // coin flip.
        const gatedDoors = (
            ready: Gate,
            calls: Array<{ name: string; args: () => Record<string, unknown> }>,
            reply: string
        ): HarnessStream => {
            const doors = modelDoors(calls, reply);

            return async function* stream(request) {
                await ready.promise;
                yield* doors(request);
            };
        };

        // The fixture for the case: one writer HOST thread that wakes the scout DEFAULT
        // conversation through a `threadSend`, and a scout door list that holds at its gate
        // until the test opens it. The thread ids do not exist until the harness has built
        // them, so every door argument is a THUNK (the same rule `modelDoors` follows).
        const replyFixture = (
            ready: Gate
        ): { writer: Harness; parent: HarnessThreadRecord; scouted: HarnessThreadRecord } => {
            const writer = harness({
                agents: {
                    writer: brain(
                        routed(
                            {
                                'wake the scout': modelDoor(
                                    'threadSend',
                                    () => ({ thread: 'agent:scout', message: 'please report' }),
                                    'writer done'
                                )
                            },
                            scripted([answer('writer answers')])
                        )
                    ),
                    // Three doors inside ONE run of the started turn: the roster (what may
                    // this turn see), the read (may it see the sender's transcript), and the
                    // reply (may it write back to the sender).
                    scout: brain(
                        gatedDoors(
                            ready,
                            [
                                { name: 'threadList', args: () => ({}) },
                                { name: 'threadRead', args: () => ({ thread: parent.id }) },
                                {
                                    name: 'threadSend',
                                    args: () => ({ thread: parent.id, message: 'thanks for the wake' })
                                }
                            ],
                            'scout done'
                        )
                    )
                },
                presets: false
            });

            const parent = writer.createThread('writer');

            // A scout conversation INSIDE the sender's family: the family rule admits
            // `agent:<name>` only when the family spans that agent (step 4), and this host
            // thread is what makes the scout's default addressable from `parent` at all —
            // exactly the shape the B4/C1 case above builds.
            const scouted = writer.createThread('scout', { ownerThreadId: parent.id });

            return { writer, parent, scouted };
        };

        it('the woken turn lists, reads and answers its sender, and the route reverts (T5 AC1-AC4)', async () => {
            const ready = gate();
            const { writer, parent } = replyFixture(ready);

            // AC1 — the writer turn wakes the scout DEFAULT conversation. The receipt is
            // 'started' (a dormant conversation is started, never queued and never
            // refused), and it carries NO `note`: no scout conversation was in flight, so
            // `agent:scout` is not an ambiguous address (that case is the C1 pin above).
            await writer.sendThreadInput(parent.id, 'wake the scout');
            expect(JSON.parse(firstResult(writer, parent.id))).toEqual({
                threadId: 'agent:scout',
                delivered: 'started',
                sender: 'writer',
                senderThreadId: parent.id
            });

            // The started run is in flight and holding at its gate; the sender's own run
            // has released, which is what makes the reply below 'started' rather than a
            // steer.
            expect(writer.thread('agent:scout')?.status).toBe('running');

            ready.open();
            await settleThread(writer, 'agent:scout');

            const results = doorResults(writer, 'agent:scout');

            // AC2, part 1 — THE ROSTER. Exactly two entries in sequence order: the scout's
            // own (default) conversation and the sender's thread. `agent:writer` is absent
            // even though it is in scope for a send: step 4 computes the spanned AGENTS
            // before step 5 folds the sender in, so the fold adds one id and nothing else —
            // no pull of the sender's subtree (a `child` of the parent would have leaked in
            // had the fold run earlier), and no other agent's standing transcript.
            const roster = pageOf(results[0] ?? '') as {
                currentThreadId?: string;
                threads: unknown[];
            };

            expect(roster.currentThreadId).toBe('agent:scout');
            expect(roster.threads).toEqual([
                {
                    id: 'agent:scout',
                    agent: 'scout',
                    origin: 'agent',
                    status: 'running',
                    sequence: 2,
                    invocationId: '2'
                },
                {
                    id: parent.id,
                    agent: 'writer',
                    origin: 'host',
                    status: 'idle',
                    sequence: 3,
                    invocationId: '1'
                }
            ]);

            // AC2, part 2 — the read. The started turn reads the transcript of the thread
            // that woke it: the sender's whole turn, including the recorded receipt of the
            // very send that started this run. Projected to role+content because the paged
            // view's offsets are not the subject.
            const read = pageOf(results[1] ?? '') as { messages: { role: string; content: string }[] };

            expect(read.messages.map(({ role, content }) => ({ role, content }))).toEqual([
                { role: 'user', content: 'wake the scout' },
                { role: 'assistant', content: '' },
                {
                    role: 'tool',
                    content:
                        `{"threadId":"agent:scout","delivered":"started","sender":"writer",` +
                        `"senderThreadId":"${parent.id}"}`
                },
                { role: 'assistant', content: 'writer done' }
            ]);

            // AC1, part 2 — THE REPLY. Addressing the sender's id is accepted (this is the
            // call the unfixed harness refused), and the target is idle, so the message
            // STARTS a turn there.
            expect(JSON.parse(results[2] ?? '')).toEqual({
                threadId: parent.id,
                delivered: 'started',
                sender: 'scout',
                senderThreadId: 'agent:scout'
            });

            await settleThread(writer, parent.id);
            // The reply became the sender's new prompt, and that turn answered on the SAME
            // route: `routed` dispatches on the conversation's FIRST user message, so a
            // thread keeps its script across turns (the door list is spent, hence the
            // answer-only frame set).
            expect(textOf(writer.threadMessages(parent.id)).slice(-2)).toEqual([
                `from agent "scout" (thread agent:scout):\nthanks for the wake`,
                'writer done'
            ]);

            // AC3 — the route is TRANSIENT. Once the scout's run has released, its family
            // is the singleton again, so the same read that succeeded inside the run is now
            // the ordinary out-of-family refusal.
            const notVisible =
                `Thread "${parent.id}" is not visible to thread "agent:scout": a read reaches your own thread, an ` +
                'ancestor, one of your descendants, or a default conversation (agent:<name>) your roster lists (see ' +
                'threadList). The id exists — it is simply outside your lineage.';

            expect(() => writer.threadMessages(parent.id, 'agent:scout')).toThrow(notVisible);
            expect(() => writer.thread(parent.id, 'agent:scout')).toThrow(notVisible);

            // AC4 — nothing was PERSISTED to buy the route. The default conversation never
            // adopted the sender as its owner (the first-wins `ownerThreadId` link stays
            // absent, so a later caller from another family is not silently locked out), and
            // the sender never adopted the default either.
            expect(writer.thread('agent:scout')?.ownerThreadId).toBeUndefined();
            expect(writer.thread(parent.id)?.ownerThreadId).toBeUndefined();
        });

        it('the ambiguity note is withheld when the live conversation is out of reach (T5 AC5)', async () => {
            const slow = gatedAnswer('slow writer turn');

            const { writer, parent, borrowed } = lineage(
                { 'slow work': slow.stream },
                {
                    'tell the writers': modelDoor(
                        'threadSend',
                        () => ({ thread: 'agent:writer', message: 'a scout thread is asking' }),
                        'default told'
                    )
                }
            );

            // The live writer conversation is one an ANCESTOR of the sender created. The
            // sender is `borrowed`, a scout thread under `child`, and `worker` is a writer
            // thread under `parent` — a sibling's shape, and a sibling is deliberately NOT
            // in the family (0027). So the caller may not address it.
            const worker = writer.createThread('writer', { ownerThreadId: parent.id });
            const running = writer.sendThreadInput(worker.id, 'slow work');
            await flush();
            expect(writer.thread(worker.id)?.status).toBe('running');

            // The address IS still ambiguous — a writer turn is in flight somewhere — but
            // naming `worker` would have said "address that id" and handed back a refusal.
            // The receipt is the pre-C1 shape exactly: where the message went, nothing more.
            await writer.sendThreadInput(borrowed.id, 'tell the writers');
            expect(JSON.parse(firstResult(writer, borrowed.id))).toEqual({
                threadId: 'agent:writer',
                delivered: 'started',
                sender: 'scout',
                senderThreadId: borrowed.id
            });

            // Nothing about the delivery changed with the filter: the message landed in the
            // default conversation and started a turn there.
            await settleThread(writer, 'agent:writer');
            expect(textOf(writer.threadMessages('agent:writer'))).toEqual([
                `from agent "scout" (thread ${borrowed.id}):\na scout thread is asking`,
                'writer answers'
            ]);

            slow.ready.open();
            await running;
            expect(writer.thread(worker.id)?.status).toBe('idle');
        });

        // The invocation ledger has no host read seam (`invocationRecords` is internal), so
        // this pins the two OBSERVABLE consequences of the guard: the conversation comes
        // back to 'idle', and its next turn is accepted. A run stranded by an escape would
        // report `running` and refuse the follow-up. The failure-path commit inside the same
        // `try` is pinned by the run-failure suites (e.g. src/harness.agent-results.test.ts).
        it('a run-start hook failure strands neither the conversation nor its next turn (T5 AC7)', async () => {
            const dropped: unknown[] = [];
            const lifecycle: string[] = [];

            const writer = harness({
                agents: { writer: brain(scripted([answer('first turn'), answer('second turn')])) },
                report: { diagnostic: (event) => void dropped.push(event) },
                plugins: [
                    {
                        name: 'hostile',
                        setup: (api) => {
                            // A handler that THROWS is dropped by the fail-open bus, and the
                            // widened settle guard must not change that: the run still starts,
                            // answers, and settles. The guard's job is the case the bus does
                            // NOT swallow, so what these assertions pin is the run coming back
                            // to rest whichever way the round went.
                            api.on('run.started', () => {
                                throw new Error('policy unavailable');
                            });
                            api.on('run.finished', () => void lifecycle.push('run.finished'));
                            api.on('run.failed', () => void lifecycle.push('run.failed'));
                        }
                    }
                ],
                presets: false
            });

            const thread = writer.createThread('writer');

            expect((await writer.sendThreadInput(thread.id, 'work')).content).toBe('first turn');
            expect(lifecycle).toEqual(['run.finished']);

            // The drop is still VISIBLE to the host (fail-open WITH a reporter, hooks.ts rule
            // 8), and it is the only diagnostic this run produced.
            expect(dropped).toEqual([
                {
                    type: 'plugin_diagnostic',
                    kind: 'handler-threw',
                    event: 'run.started',
                    owner: 'hostile',
                    message: 'policy unavailable'
                }
            ]);

            // AC7 — the conversation is RELEASED and its invocation settled: a stranded run
            // would report `running` here and refuse the next turn. The follow-up send is
            // the proof, and it also pins that the guard's `finally` released the actor.
            expect(writer.thread(thread.id)?.status).toBe('idle');
            expect((await writer.sendThreadInput(thread.id, 'again')).content).toBe('second turn');
            expect(lifecycle).toEqual(['run.finished', 'run.finished']);
            expect(writer.thread(thread.id)?.status).toBe('idle');
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE FACT, ONE SENTENCE (issue 0034, F2)
//
// Three doors raise the missing-thread refusal: the core's `threadStateOf` (every inline
// thread operation), `createLaneAuthority`'s `thread:read` answer (routed over a lane),
// and the `threadRead` handler's record tail (the model-facing door). Before this fix each
// had written its own head — "is not available in this harness", "has no record in this
// session", "has no record in this harness" — so an operator comparing an inline answer
// with a routed one reasonably concluded that two DIFFERENT things had happened. The head
// is not cosmetic: on the routed door the refusal crosses the lane boundary as MESSAGE TEXT
// alone (the worker answers a rejected route with `error: <message>`, nothing else), so the
// sentence is the whole record of the fact on that side, and a log that reads differently
// per door cannot be grepped for.
//
// The unified head is the core's, because it is the only one true in both execution modes:
// in worker mode the answer comes from the CANONICAL harness object, in inline mode from
// the harness the host is holding, and in both cases it is the harness that has no such
// record. "Session" is not an object an inline caller has, and a lane holds none at all.
//
// Why this file, and why partly as source text: each individual door already had a pin of
// its own (see src/harness.thread-read.test.ts, src/harness.thread-park-queue.test.ts and
// src/tools/runtime/threadDelete.test.ts) — what was missing was a test that could see the
// three together, which is exactly how they drifted. A behaviour test can only look through
// one door at a time, so the parity itself is pinned against the files.
// ─────────────────────────────────────────────────────────────────────────────
describe('the missing-thread refusal is one sentence, not three (issue 0034, F2)', () => {
    /** The sentence's signature: head plus reason, present in every door that raises it. */
    const SENTENCE = 'is not available in this harness; it was never created';

    /** The whole refusal for one id, spelled the one legal way. */
    const missingThread = (threadId: string): string =>
        `Thread "${threadId}" is not available in this harness; it was never created, or it was deleted.`;

    const srcDir = dirname(fileURLToPath(import.meta.url));
    const CORE = readFileSync(join(srcDir, 'harness.ts'), 'utf8');
    const AUTHORITY = readFileSync(join(srcDir, 'server/workers/lane-authority.ts'), 'utf8');
    const READ_TOOL = readFileSync(join(srcDir, 'tools/runtime/threadRead.tool.ts'), 'utf8');

    /** Every non-test `.ts` under `src/`, as paths relative to it, sorted. */
    const productionSources = (): string[] => {
        const files: string[] = [];
        const collect = (absolute: string, relative: string): void => {
            for (const entry of readdirSync(absolute, { withFileTypes: true })) {
                const next = relative ? `${relative}/${entry.name}` : entry.name;
                if (entry.isDirectory()) collect(join(absolute, entry.name), next);
                else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(next);
            }
        };
        collect(srcDir, '');
        return files.sort();
    };

    /** How many copies of the sentence one file spells, labelled so a failure names the file. */
    const spellings = (file: string, source: string): { copies: number; file: string } => ({
        copies: source.split(SENTENCE).length - 1,
        file,
    });

    /** Runs a call (sync or async) that must refuse, and returns the refusal's words. */
    const refusal = async (call: () => unknown): Promise<string> => {
        try {
            await call();
        } catch (error) {
            return (error as Error).message;
        }
        throw new Error('expected the call to refuse');
    };

    it('answers one unknown id with one sentence at every inline door that refuses', async () => {
        const writer = quiet(brain(scripted([answer('unused')])));
        // The thread trio registers with the FIRST thread of a harness (which is why
        // src/harness.thread-read.test.ts:326 creates one before calling the reader), so this
        // harness needs a thread before the two model-facing doors exist. The id handed to
        // them below is still the unknown one.
        writer.createThread('writer');
        const missing = 'thread-99';

        // The transcript door, the transcript WRITE door, and the two model-facing doors all
        // fall through to the same guard by different routes: `threadMessages` resolves the id
        // directly, `setThreadMessages` resolves it as step 1 of its order, and the tools reach
        // it through `harness.thread(...)`'s missing record.
        const doors: [string, Promise<string>][] = [
            ['threadMessages', refusal(() => writer.threadMessages(missing))],
            ['setThreadMessages', refusal(() => writer.setThreadMessages(missing, [{ role: 'user', content: 'x' }]))],
            ['executeTool threadRead', refusal(() => writer.executeTool('threadRead', { thread: missing }))],
            ['executeTool threadSend', refusal(() => writer.executeTool('threadSend', { thread: missing, message: 'ping' }))]
        ];
        expect(Object.fromEntries(await Promise.all(doors.map(async ([name, promise]) => [name, await promise])))).toEqual({
            'executeTool threadRead': missingThread(missing),
            'executeTool threadSend': missingThread(missing),
            setThreadMessages: missingThread(missing),
            threadMessages: missingThread(missing)
        });

        // The RECORD door is the one seam that answers nothing instead of refusing: its
        // contract is "a record or undefined", and the pin here is that it does not grow a
        // sentence of its own for the same fact (the caller that needs a reason reads
        // `threadMessages`).
        expect(writer.thread(missing)).toBeUndefined();
    });

    it('refuses an id that stopped existing, and an id from another harness, with the same words', async () => {
        const writer = quiet(brain(scripted([answer('unused')])));
        const other = quiet(brain(scripted([answer('unused')])));
        const deleted = writer.createThread('writer');
        const foreign = other.createThread('writer');

        // "Never created", "deleted", and "created in a DIFFERENT harness" are three facts the
        // caller can tell apart from its own history — and one record-shaped absence to the
        // harness. The foreign id is the realistic one: a host restoring a session and passing
        // an id from the generation before.
        expect(() => other.threadMessages(foreign.id)).not.toThrow();
        writer.deleteThread(deleted.id);
        expect(writer.thread(deleted.id)).toBeUndefined();

        expect(await refusal(() => writer.threadMessages(deleted.id))).toBe(missingThread(deleted.id));
        expect(await refusal(() => writer.threadMessages(foreign.id))).toBe(missingThread(foreign.id));
        expect(await refusal(() => writer.setThreadMessages(foreign.id, []))).toBe(missingThread(foreign.id));

        // The two sentences differ only in the id: no door adds a clause about WHY the id is
        // gone, which is what would make a grep for one case miss the other.
        expect(missingThread(deleted.id).replace(deleted.id, 'X')).toBe(missingThread(foreign.id).replace(foreign.id, 'X'));
    });

    it('raises that sentence from the routed door too, where the message is the whole record', async () => {
        const { createLaneAuthority } = await import('./server/workers/lane-authority');
        const laneEpoch = 1;
        const missing = 'thread-999';
        // An id no conversation lane has ever created, answered from an authority opened the
        // way ./lane-host.ts opens one. A lane holds no thread registry of its own: the
        // canonical harness is the only thing that can answer, which is what made the
        // session-phrased head wrong at this door.
        const core = quiet(brain(scripted([answer('unused')])));
        const authority = createLaneAuthority({ harness: core });
        authority.openLane(laneEpoch);
        const rejection = (await authority
            .answer(laneEpoch, { op: 'thread:read', threadId: missing, identity: {} })
            .catch((error: unknown) => error)) as Error;

        // Exact string, not a loose fragment of one variant. The id has to be inside the
        // sentence: a lane rejection crosses the boundary as `error: <message>` text alone
        // (./lane-worker-loop.ts, the reply that stringifies an Error), so NOTHING else
        // survives the hop to say which thread was refused. That is why unifying the wording
        // is not cosmetic — the message is the entire record of the fact on this door.
        expect(rejection.message).toBe(missingThread(missing));
    });

    it('leaves exactly three production sources able to write the sentence, each exactly once', () => {
        // One sentence means one wording, and the files allowed to spell it out are exactly
        // the three doors. A fourth file is a drift that has started; a second copy inside one
        // file means a call site stopped routing through the copy that file already has.
        expect(productionSources().filter((file) => readFileSync(join(srcDir, file), 'utf8').includes(SENTENCE))).toEqual([
            'harness.ts',
            'server/workers/lane-authority.ts',
            'tools/runtime/threadRead.tool.ts'
        ]);
        expect([spellings('harness.ts', CORE), spellings('lane-authority.ts', AUTHORITY), spellings('threadRead.tool.ts', READ_TOOL)]).toEqual([
            { copies: 1, file: 'harness.ts' },
            { copies: 1, file: 'lane-authority.ts' },
            { copies: 1, file: 'threadRead.tool.ts' }
        ]);

        // WHERE each copy lives is part of the contract: the core keeps its sentence in
        // `threadStateOf`, the guard every inline thread operation resolves the id through,
        // the routed door restates it because a worker module has no core import to borrow
        // from, and the model-facing door raises it from its missing-RECORD tail — which only
        // runs after the visibility answer has already been given, so a wrong-but-visible id
        // never reaches it.
        expect(CORE).toMatch(/const threadStateOf = \(threadId: string\): ThreadState => \{/);
        expect(CORE).toMatch(/throw new HarnessError\(\s*.Thread "\$\{threadId\}" is not available in this harness/);
        expect(AUTHORITY).toMatch(/throw new Error\(`Thread "\$\{request\.threadId\}" is not available in this harness/);
        expect(READ_TOOL).toMatch(/if \(record === undefined\) \{/);
        expect(READ_TOOL).toMatch(/throw new Error\(\s*.Thread "\$\{threadId\}" is not available in this harness/);
    });
});
