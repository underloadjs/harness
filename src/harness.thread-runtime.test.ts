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
// Clock policy: no fake timers. The transports are scripted/gated, so every
// assertion is on exact values rather than elapsed time.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessAssistantMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
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

const brain = (stream: HarnessStream): Agent => agent({ model: 'merge/ds4-flash', stream });

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

    it('shares session todos across threads without sharing transcripts', async () => {
        const stream = routed(
            {
                // Thread one adds a todo, thread two lists it from the same session.
                plan: scripted([
                    callTool('c1', 'todoManage', '{"action":"add","text":"Shared plan"}'),
                    answer('added')
                ]),
                'list it': scripted([
                    callTool('c2', 'todoManage', '{"action":"list"}'),
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

        // The second conversation's tool result is the FIRST conversation's todo:
        // the store is session state, shared by every thread.
        const toolMessage = writer
            .threadMessages(lister.id)
            .find((message) => message.role === 'tool') as { role: string; content: string };
        expect(toolMessage.role).toBe('tool');
        expect(toolMessage.content).toBe(
            '{"todos":[{"id":"1","text":"Shared plan","completed":false}],"counts":{"total":1,"completed":0,"remaining":1},"page":{"offset":0,"limit":20,"hasMore":false}}'
        );

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
        expect(textOf(writer.threadMessages(planner.id))).toEqual([
            'plan',
            '',
            '{"todo":{"id":"1","text":"Shared plan","completed":false},"counts":{"total":1,"completed":0,"remaining":1}}',
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
                    callTool('d1', 'agentDelegate', JSON.stringify({ agent: 'helper', input: `child ${prefix}` })),
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
        expect(alphaTool.content).toBe('{"agent":"helper","content":"alpha facts"}');
        expect(betaTool.content).toBe('{"agent":"helper","content":"beta facts"}');

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
                                'agentDelegate',
                                JSON.stringify({ agent: 'helper', input: 'child one' })
                            ),
                            answer('first done')
                        ]),
                        continue: scripted([
                            callTool(
                                'd2',
                                'agentDelegate',
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

        expect(alphaTool.content).toBe('Tool "agentDelegate" failed: child stopped');
        expect(betaTool.content).toBe('{"agent":"helper","content":"beta facts"}');

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
        expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'threadList',
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
                callTool('c1', 'agentDelegate', '{"agent":"helper","input":"find facts"}'),
                answer('lead done'),
                callTool('c2', 'agentDelegate', '{"agent":"helper","input":"more facts"}'),
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
            'Tool "agentDelegate" failed: Thread "agent:helper" is stopped; a host must resume it before it can run.'
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
                callTool('d1', 'agentDelegate', JSON.stringify({ agent: 'helper', input: 'find' })),
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
                        callTool('d1', 'agentDelegate', JSON.stringify({ agent: 'helper', input: 'find' })),
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
                yield { type: 'error', message: 'boom' };
                return;
            }

            yield { type: 'text', delta: 'recovered' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({
            agents: { writer: brain(stream) },
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
