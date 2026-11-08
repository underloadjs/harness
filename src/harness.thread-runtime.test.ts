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
//       attributes the message to the runtime-derived sender and delivers it to
//       the target (appended when idle, queued at the next boundary when running).
//   R5  Steering never interrupts an in-flight request: queued text becomes a
//       user message at the loop boundary, in receipt order.
//   R6  stopThread aborts one conversation (and owner-linked children) and marks
//       it stopped; stopAllThreads aborts every active run; deleteThread purges a
//       terminal host conversation plus its invocation lookups.
//
// Clock policy: the CLOCK is pinned (see EPOCH_MS below), the SCHEDULER is not.
// Every task-store timestamp (`updatedAt`, the change-feed `at`, a claim's
// `leaseUntil`) comes from Date in src/core/task.ts, so pinning Date gives each of
// them ONE exact expected value. `toFake: ['Date']` leaves setTimeout and the
// microtask queue real, which the gated transports and `flush()` here depend on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import { TASK_DEFAULT_LEASE_MS } from './core/task';
import type {
    Agent,
    Harness,
    HarnessAssistantMessage,
    HarnessSnapshot,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    TaskChange,
    TaskChangeOp,
    TaskItem,
    TaskResult
} from '@underload/harness';

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
const LEASE_UNTIL = EPOCH_MS + TASK_DEFAULT_LEASE_MS;
const LEASE_ISO = new Date(LEASE_UNTIL).toISOString();

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
    ((await writer.executeTool('task', {})) as TaskResult).tasks;

// The whole recorded history of one store (`since: 0`).
const changeFeed = async (writer: Harness): Promise<TaskChange[]> =>
    ((await writer.executeTool('task', { since: 0 })) as { changes: TaskChange[] }).changes;

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
                    callTool('c1', 'task', '{"tasks":[{"text":"Shared plan"}]}'),
                    answer('added')
                ]),
                'list it': scripted([
                    callTool('c2', 'task', '{}'),
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
        expect(pageOf(toolResultsOf(writer.threadMessages(planner.id))[0])).toEqual(
            pageOf(toolMessage.content)
        );
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
        expect(writer.threadMessages(thread.id)).toEqual([{ role: 'user', content: 'start' }]);

        turn.open();
        const result: HarnessAssistantMessage = await running;
        expect(result.content).toBe('steered answer');

        // Both steers became user messages, in order, before the second request.
        expect(writer.threadMessages(thread.id)).toEqual([
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
    it('blocks a foreign thread while a live claim holds the record and clears it on stop', async () => {
        const stream = routed(
            {
                // A reserves the record from ITS conversation, then walks away.
                'claim it': scripted([
                    callTool('c1', 'task', '{"claim":["1"]}'),
                    answer('claimed')
                ]),
                // B tries once while the claim is live (refused) and once after A is
                // stopped (applies). One route serves both turns because `scripted`
                // replays its list per REQUEST, and routing keys on the conversation's
                // FIRST prompt.
                'try it': scripted([
                    callTool('c2', 'task', '{"tasks":[{"id":"1","completed":true}],"expects":[{"id":"1","rev":1}]}'),
                    answer('refused'),
                    callTool('c3', 'task', '{"tasks":[{"id":"1","completed":true}],"expects":[{"id":"1","rev":1}]}'),
                    answer('applied')
                ])
            },
            scripted([answer('unused')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });

        // The record exists before either conversation touches it. The host door
        // writes as the primary with NO thread, so it is not a holder of anything.
        await writer.executeTool('task', { tasks: [{ text: 'Edit the router' }] });

        const holder = writer.createThread('writer');
        const other = writer.createThread('writer');

        await writer.sendThreadInput(holder.id, 'claim it');

        // THE CLAIM: holder pair (writer, holder.id) and a default lease; `rev` stays
        // 1, so no other reader's CAS token moved. The claim is also the latest
        // write, so attribution follows the claiming conversation.
        const claimed = task('1', 'Edit the router', {
            by: 'writer',
            threadId: holder.id,
            owner: 'writer',
            ownerThreadId: holder.id,
            leaseUntil: LEASE_UNTIL
        });

        expect(await storedTasks(writer)).toEqual([claimed]);

        // WHILE IT IS LIVE: a different conversation of the SAME agent is a
        // different holder, so its guarded content write is refused — and the whole
        // call is atomic, so the record and the log are untouched.
        await writer.sendThreadInput(other.id, 'try it');

        const refused = `Tool "task" failed: task "1" is claimed by "writer" until ${LEASE_ISO}; release it or take it over first.`;
        const firstTurn = writer.threadMessages(other.id);

        expect(toolResultsOf(firstTurn)[0]).toBe(refused);
        expect(await storedTasks(writer)).toEqual([claimed]);

        // The operator door is a foreign holder too: `executeCommand`/`executeTool`
        // carry the primary with no threadId, so `/task complete` reports the same
        // refusal instead of stomping the conversation that is mid-edit.
        expect(await writer.executeCommand('/task complete 1')).toEqual({
            content: `/task complete: task "1" is claimed by "writer" until ${LEASE_ISO}; release it or take it over first.`,
            isError: true
        });
        expect(await changeFeed(writer)).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'claim', { by: 'writer', threadId: holder.id })
        ]);

        // STOP: the conversation is marked stopped, so it can no longer finish the
        // edit it reserved, and its claim goes with it. `stopThread` returns false
        // here because no RUN was live — the release happens either way.
        expect(writer.stopThread(holder.id, 'done here')).toBe(false);
        expect(writer.thread(holder.id)?.status).toBe('stopped');

        // The holder pair and the lease are GONE (deleted, not nulled, so a snapshot
        // never carries an empty owner), `rev` and the writer's attribution are
        // untouched, and the release is its own recorded event.
        expect(await storedTasks(writer)).toEqual([
            task('1', 'Edit the router', { by: 'writer', threadId: holder.id })
        ]);
        expect(await changeFeed(writer)).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'claim', { by: 'writer', threadId: holder.id }),
            event(3, '1', 'release', { threadId: holder.id })
        ]);

        // THE RECORD IS FREE AGAIN: the sibling's retry applies on the token it
        // already holds (rev 1 — a claim never moved it), and the operator's command
        // would apply too.
        await writer.sendThreadInput(other.id, 'try again');

        const messages = writer.threadMessages(other.id);
        const results = toolResultsOf(messages);

        expect(pageOf(results[1])).toEqual({
            // `rev` moved by exactly one: this is a real content change, and the
            // token the retry carried (rev 1) is what the CAS accepted.
            tasks: [
                task('1', 'Edit the router', {
                    completed: true,
                    rev: 2,
                    by: 'writer',
                    threadId: other.id
                })
            ],
            counts: { total: 1, completed: 1, pending: 0 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 4
        });
        expect(textOf(messages)).toEqual([
            'try it',
            '',
            refused,
            'refused',
            'try again',
            '',
            results[1],
            'applied'
        ]);
    });

    it('releases an owner-stopped child conversation with its own claims', async () => {
        const stream = routed(
            {
                'claim it': scripted([callTool('c1', 'task', '{"claim":["1","2"]}'), answer('claimed')])
            },
            scripted([answer('unused')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        await writer.executeTool('task', { tasks: [{ text: 'One' }, { text: 'Two' }] });

        const parent = writer.createThread('writer', { label: 'parent' });
        const child = writer.createThread('writer', { ownerThreadId: parent.id });

        await writer.sendThreadInput(child.id, 'claim it');
        expect((await storedTasks(writer)).map((item) => item.ownerThreadId)).toEqual([
            child.id,
            child.id
        ]);

        // Stopping the OWNER cascades to the linked child (src/harness.ts
        // `stopThread` -> `ownersOf`), and the cascade releases the CHILD's claims
        // because the release lives in `stopThreadState`, once per conversation.
        writer.stopThread(parent.id, 'shutdown');

        expect(writer.thread(parent.id)?.status).toBe('stopped');
        expect(writer.thread(child.id)?.status).toBe('stopped');
        expect((await storedTasks(writer)).map((item) => item.owner)).toEqual([
            undefined,
            undefined
        ]);
        // Content revisions did not move, so any reader's token is still valid.
        expect((await storedTasks(writer)).map((item) => item.rev)).toEqual([1, 1]);
        expect(await changeFeed(writer)).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '2', 'add', { by: 'writer', itemRev: 1 }),
            event(3, '1', 'claim', { by: 'writer', threadId: child.id }),
            event(4, '2', 'claim', { by: 'writer', threadId: child.id }),
            event(5, '1', 'release', { threadId: child.id }),
            event(6, '2', 'release', { threadId: child.id })
        ]);

        // And the records are writable again for anybody.
        const after = (await writer.executeTool('task', {
            tasks: [{ id: '1', completed: true }],
            expects: [{ id: '1', rev: 1 }]
        })) as TaskResult;

        expect(after.tasks.map((item) => item.completed)).toEqual([true, false]);
        expect(after.tasks[0].rev).toBe(2);
    });

    it('releases every stopped conversation claim under stopAllThreads, but not an unthreaded one', async () => {
        const stream = routed(
            {
                'claim one': scripted([callTool('c1', 'task', '{"claim":["1"]}'), answer('claimed')]),
                // A second route, so two conversations hold two DIFFERENT records:
                // one live claim would refuse the other claim outright.
                'claim two': scripted([callTool('c2', 'task', '{"claim":["2"]}'), answer('claimed')])
            },
            scripted([answer('unused')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        await writer.executeTool('task', {
            tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }]
        });

        const first = writer.createThread('writer');
        const second = writer.createThread('writer');

        await writer.sendThreadInput(first.id, 'claim one');
        await writer.sendThreadInput(second.id, 'claim two');

        // A claim taken through the host door belongs to no conversation, and
        // `stopAllThreads` stops conversations — so it stays. That is the boundary
        // of the hook: it clears `ownerThreadId`, never a bare `owner`.
        await writer.executeTool('task', { claim: ['3'] });
        expect((await storedTasks(writer)).map((item) => item.ownerThreadId)).toEqual([
            first.id,
            second.id,
            undefined
        ]);

        // Both runs had already settled, so nothing was ABORTED; every conversation
        // — the two host threads and each agent's default conversation — is stopped,
        // and each stopped conversation's claims go with it.
        expect(writer.stopAllThreads('all stop')).toBe(0);
        expect(writer.thread(first.id)?.status).toBe('stopped');
        expect(writer.thread(second.id)?.status).toBe('stopped');
        expect(writer.thread('agent:writer')?.status).toBe('stopped');

        expect(await storedTasks(writer)).toEqual([
            task('1', 'One', { by: 'writer', threadId: first.id }),
            task('2', 'Two', { by: 'writer', threadId: second.id }),
            task('3', 'Three', { by: 'writer', owner: 'writer', leaseUntil: LEASE_UNTIL })
        ]);
        expect(await changeFeed(writer)).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '2', 'add', { by: 'writer', itemRev: 1 }),
            event(3, '3', 'add', { by: 'writer', itemRev: 1 }),
            event(4, '1', 'claim', { by: 'writer', threadId: first.id }),
            event(5, '2', 'claim', { by: 'writer', threadId: second.id }),
            event(6, '3', 'claim', { by: 'writer' }),
            event(7, '1', 'release', { threadId: first.id }),
            event(8, '2', 'release', { threadId: second.id })
        ]);
    });

    it('releases the claims of a deleted conversation and leaves its sibling alone', async () => {
        // One route PER conversation: `routed` builds one `scripted` closure per
        // route and that closure advances per model REQUEST, so two conversations
        // sharing a route would get different turns. Each prompt below is claimed by
        // exactly one conversation.
        const stream = routed(
            {
                'doomed claims': scripted([callTool('c1', 'task', '{"claim":["1"]}'), answer('locked')]),
                'survivor claims': scripted([callTool('c2', 'task', '{"claim":["2"]}'), answer('locked')]),
                'child claims': scripted([callTool('c3', 'task', '{"claim":["1"]}'), answer('locked')])
            },
            scripted([answer('unused')])
        );

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        await writer.executeTool('task', { tasks: [{ text: 'One' }, { text: 'Two' }] });

        const doomed = writer.createThread('writer');
        const survivor = writer.createThread('writer');

        await writer.sendThreadInput(doomed.id, 'doomed claims');
        await writer.sendThreadInput(survivor.id, 'survivor claims');

        // Deleting a conversation is the other half of the story: the record can
        // never release anything again, so `purgeThread` lifts its claims — and only
        // its own, so the sibling keeps its lock.
        writer.deleteThread(doomed.id);

        expect(writer.thread(doomed.id)).toBeUndefined();
        expect(await storedTasks(writer)).toEqual([
            task('1', 'One', { by: 'writer', threadId: doomed.id }),
            task('2', 'Two', {
                by: 'writer',
                threadId: survivor.id,
                owner: 'writer',
                ownerThreadId: survivor.id,
                leaseUntil: LEASE_UNTIL
            })
        ]);

        // The freed record is claimable by a NEW conversation, and deleting its OWNER
        // purges the child through the same helper — so the cascade releases the
        // child's claim too, while the untouched sibling stays locked.
        const parent = writer.createThread('writer', { label: 'parent' });
        const child = writer.createThread('writer', { ownerThreadId: parent.id });

        await writer.sendThreadInput(child.id, 'child claims');
        expect((await storedTasks(writer))[0].ownerThreadId).toBe(child.id);

        writer.deleteThread(parent.id);

        expect(writer.thread(child.id)).toBeUndefined();
        expect(await storedTasks(writer)).toEqual([
            task('1', 'One', { by: 'writer', threadId: child.id }),
            task('2', 'Two', {
                by: 'writer',
                threadId: survivor.id,
                owner: 'writer',
                ownerThreadId: survivor.id,
                leaseUntil: LEASE_UNTIL
            })
        ]);
        expect(await changeFeed(writer)).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '2', 'add', { by: 'writer', itemRev: 1 }),
            event(3, '1', 'claim', { by: 'writer', threadId: doomed.id }),
            event(4, '2', 'claim', { by: 'writer', threadId: survivor.id }),
            event(5, '1', 'release', { threadId: doomed.id }),
            event(6, '1', 'claim', { by: 'writer', threadId: child.id }),
            event(7, '1', 'release', { threadId: child.id })
        ]);
    });

    it('drops a restored claim whose conversation the snapshot does not carry', async () => {
        const stream = async function* (): AsyncIterable<HarnessStreamEvent> {
            yield { type: 'text', delta: 'idle' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const source = harness({ agents: { writer: brain(stream) }, presets: false });
        await source.executeTool('task', { tasks: [{ text: 'Edit the router' }] });

        // A claim for a thread the snapshot does not carry. Every in-process
        // stop/delete path releases BEFORE it snapshots, so this is the hand-edited
        // or externally produced file — and in both cases the resumed session has
        // nobody left to lift the lock. Round-tripped through JSON so the test edits
        // the persisted shape, not a live object.
        const snapshot = JSON.parse(JSON.stringify(source.snapshot())) as HarnessSnapshot;

        snapshot.records.todos.items[0] = {
            ...snapshot.records.todos.items[0],
            owner: 'writer',
            ownerThreadId: 'thread-9'
        };

        const target = harness({ agents: { writer: brain(stream) }, presets: false });
        target.restore(snapshot);

        // The orphan is gone, the content is exactly what the file said, and the
        // release is recorded so a reader polling `since` sees the lock lift. The
        // sweep runs before `notifyStateChange('restore')`, so the snapshot the host
        // persists next already matches memory.
        expect(target.snapshot().records.todos.items).toEqual([
            task('1', 'Edit the router', { by: 'writer' })
        ]);
        expect(target.snapshot().records.todos.storeRev).toBe(2);
        expect((target.snapshot().records.todos.changes ?? []).slice(-1)).toEqual([
            event(2, '1', 'release', { threadId: 'thread-9' })
        ]);
    });

    it('releases the default-conversation claim of a detached agent', async () => {
        const stream = routed(
            {
                'claim it': scripted([callTool('c1', 'task', '{"claim":["1"]}'), answer('claimed')])
            },
            scripted([answer('unused')])
        );

        const writer = harness({
            agents: { writer: brain(stream), helper: brain(stream) },
            presets: false
        });
        await writer.executeTool('task', { tasks: [{ text: 'Edit the router' }] });

        // A run in an agent's OWN conversation — the shape a delegation or a host
        // turn on `agent:<name>` takes — claims as (writer, 'agent:helper').
        await writer.sendThreadInput('agent:helper', 'claim it');
        expect((await storedTasks(writer))[0].ownerThreadId).toBe('agent:helper');

        // `removeAgent` drops that conversation WITHOUT `purgeThread`, so it needs
        // its own release: after the roster entry and its thread record are gone,
        // nothing could ever lift the lease.
        writer.removeAgent('helper');

        expect(writer.thread('agent:helper')).toBeUndefined();
        // The holder pair is cleared; the attribution stays where the claim left it,
        // because `releaseThread` is an ownership change and never rewrites a writer.
        expect(await storedTasks(writer)).toEqual([
            task('1', 'Edit the router', { by: 'helper', threadId: 'agent:helper' })
        ]);
        expect(await changeFeed(writer)).toEqual([
            event(1, '1', 'add', { by: 'writer', itemRev: 1 }),
            event(2, '1', 'claim', { by: 'helper', threadId: 'agent:helper' }),
            event(3, '1', 'release', { threadId: 'agent:helper' })
        ]);
    });
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
                },
                {
                    id: second.id,
                    agent: 'writer',
                    origin: 'host',
                    status: 'idle',
                    sequence: 3,
                    label: 'later'
                }
            ]
        });

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
        let requests = 0;
        const seen: HarnessStreamRequest[] = [];

        const stream: HarnessStream = async function* (request) {
            seen.push(request);
            requests += 1;

            if (requests === 1) {
                // The tool schema has no sender field: identity comes from the run.
                for (const frame of callTool(
                    'c1',
                    'threadSend',
                    JSON.stringify({ thread: 'thread-2', message: 'hello from alpha' })
                )) {
                    yield frame;
                }
                return;
            }

            yield { type: 'text', delta: 'alpha sent' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });

        // createThread registers the conditional core tool, so the very next
        // request declares it.
        const alpha = writer.createThread('writer');
        const beta = writer.createThread('writer');

        const result = await writer.sendThreadInput(alpha.id, 'talk to beta');
        expect(result.content).toBe('alpha sent');
        // R9-R11: the demoted runtime rows are searchable, so the declared set is
        // the bootstrap pair plus the three thread controls this harness just
        // registered (roster first, then the transcript reader, then the sender —
        // descending `order` inside the 'threads' activation group).
        expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual([
            'toolRequest',
            'task',
            'threadList',
            'threadRead',
            'threadSend'
        ]);

        // The tool result reports the delivery and the REAL sender.
        const toolMessage = writer
            .threadMessages(alpha.id)
            .find((message) => message.role === 'tool') as { content: string };
        expect(JSON.parse(toolMessage.content)).toEqual({
            threadId: beta.id,
            delivered: 'appended',
            sender: 'writer',
            senderThreadId: alpha.id
        });

        // Idle target: the attributed message is already in beta's transcript.
        expect(writer.threadMessages(beta.id)).toEqual([
            {
                role: 'user',
                content: 'from agent "writer" (thread thread-1):\nhello from alpha'
            }
        ]);
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
        expect(writer.threadMessages(target.id)).toEqual([{ role: 'user', content: 'work' }]);

        turn.open();
        await running;

        expect(writer.threadMessages(target.id)).toEqual([
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
        expect(helper.messages).toEqual([
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
        expect(snapshot.threads).toEqual([
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

        expect(target.thread('thread-1')).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 2,
            label: 'kept',
            invocationId: '1'
        });
        expect(target.threadMessages('thread-1')).toEqual([
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

        expect(writer.threadMessages(thread.id)).toEqual([
            { role: 'system', content: 'seed' },
            { role: 'user', content: 'rewritten' }
        ]);

        // The snapshot sees it, so the next save of this harness IS the new truth.
        expect(writer.snapshot().threads).toEqual([
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
        expect(restored.threadMessages('thread-1')).toEqual([
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
        expect(writer.agents.writer.messages).toEqual([{ role: 'user', content: 'kept' }]);
        // The default conversation and the registry transcript are one and the
        // same thing, which is why an in-place write matters here.
        expect(writer.threadMessages('agent:writer')).toEqual([{ role: 'user', content: 'kept' }]);
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

        expect(writer.threadMessages(thread.id)).toEqual([{ role: 'user', content: 'one' }]);

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
        expect(writer.threadMessages(thread.id)).toEqual([{ role: 'user', content: 'start' }]);

        slow.ready.open();
        expect(running.status).toBe('pending');
        const answerMessage = await pending;
        expect(answerMessage.content).toBe('late');

        // Settled: the same write now lands and replaces EVERYTHING, including the
        // transcript the run just committed.
        expect(writer.threadMessages(thread.id)).toEqual([
            { role: 'user', content: 'start' },
            { role: 'assistant', content: 'late' }
        ]);

        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'after the run' }]);
        expect(writer.threadMessages(thread.id)).toEqual([{ role: 'user', content: 'after the run' }]);

        // A STOPPED conversation stays editable — repairing a broken transcript on
        // a stopped thread is the recovery path the visualiser needs.
        writer.stopThread(thread.id);
        expect(writer.thread(thread.id)?.status).toBe('stopped');

        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'repaired while stopped' }]);
        expect(writer.threadMessages(thread.id)).toEqual([
            { role: 'user', content: 'repaired while stopped' }
        ]);
    });
});
