// R7 — server lifecycle with BACKGROUND work.
//
// Scope (orchestrator-managed, test-only; this file is the ONLY file this task
// owns). It pins the server contracts the background runtime relies on and
// deliberately does NOT test the runtime's tool scheduling, its provider-safe
// placeholder projection, or its wake cadence — src/harness.background.test.ts
// owns those, and src/server/queue.test.ts already owns the plain queue contract.
//
// What is pinned here (acceptance evidence for R7):
//   1. an early `done` whose `pending` list is non-empty does NOT terminalize the
//      turn, does NOT release the single-flight gate, and does NOT start the queued
//      next task;
//   2. a `wakeup` heartbeat and a partial `tool_result` (with `durationMs` and the
//      remaining `pending` list) are retained verbatim by the store, and detaching
//      the GET-events watcher is not a cancellation;
//   3. the terminal transition happens only after the LAST completion AND the final
//      answer, and the queue then advances FIFO with a complete terminal snapshot;
//   4. a root cancel settles a background turn, the next task runs, and an
//      uncooperative late completion cannot leak into the next turn's record;
//   5. a restart while background work is in flight restores the turn as
//      interrupted (never replayed), repairs the canonical transcript, and the
//      preserved queue still drains.
//
// WHY A SCRIPTED CALLABLE OVER A REAL HARNESS HANDLE
// --------------------------------------------------
// The whole server contract is expressed at ONE boundary: `session.harness(...)`
// stays unresolved until the agent answered AND every background call drained
// (sessions.ts executeTurn awaits it at ~1375 and only then clears the sink and the
// busy gate in the `finally` at ~1386-1400). This file therefore replaces only the
// harness CALLABLE of an otherwise REAL handle: agents/snapshot/restore/reset are
// the real core objects, so `stateChange` persistence, `harness.snapshot()`, and
// `repairInterruptedToolCalls` all run for real.
//
// Every value the fixture emits is a member of the real `HarnessEvent` union
// (types/index.ts) built from `HarnessPendingTool`/`HarnessAssistantMessage`, so
// the assertions cannot drift from the wire contract. The script is driven by the
// PROMPT and by what it already committed (transcript state), so no assertion
// depends on a hardcoded serial event order across tasks.
//
// The clock is pinned (Date.now spy), so every timestamp, `durationMs`, and
// `elapsedMs` below is an exact number rather than a tolerance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type {
    Harness,
    HarnessAssistantMessage,
    HarnessMessage,
    HarnessPendingTool,
    HarnessRunOptions,
    HarnessStreamEvent,
    HarnessToolCall
} from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import type { HarnessRuntime } from './runtime';
import { createHarnessRuntime } from './runtime';
import { SessionStore } from './sessions';
import type { SessionStreamItem } from './protocol';
import { INTERRUPTED_TOOL_RESULT_TEXT } from './persistence';

// ---------------------------------------------------------------------------
// Deterministic scaffolding
// ---------------------------------------------------------------------------

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const DEFAULTS = {
    baseURL: SETTINGS.baseURL,
    model: SETTINGS.model,
    hasApiKey: true
};

// One agent, one model, one instruction: every expected message below is exact.
const NAME = 'background';
const MODEL = SETTINGS.model;
const PROBE = 'slowProbe';
const INSTRUCTION = 'Background lifecycle probe.';

// The abort wording the fixture throws. The server replaces it with its own
// "The run was cancelled." failure, so this string only reaches the log.
const ABORTED = 'The run was aborted.';

// sessions.ts:187 (INTERRUPTED_MESSAGE is module-private; the literal is repeated
// here on purpose so a wording change fails this test loudly).
const INTERRUPTED_MESSAGE =
    'The previous run was interrupted by a server restart; it was not replayed. Review the recorded events before continuing.';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

// A durable root for the restart scenario only. Nothing else here touches disk.
fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-background-${label}-`));
    roots.push(root);
    return root;
};

afterAll(() => {
    // Best effort. A locked file (Windows) simply leaves a disposable Temp/ dir.
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

// Pin the server clock; `setClock(next)` changes what Date.now() returns until the
// afterEach restore. Pinned timestamps make startedAt/updatedAt/eventTimes and the
// runtime-reported duration/elapsed figures exact.
const pinClock = (initial: number): ((next: number) => void) => {
    let value = initial;
    vi.spyOn(Date, 'now').mockImplementation(() => value);

    return (next: number) => {
        value = next;
    };
};

afterEach(() => {
    vi.restoreAllMocks();
});

// Poll a condition instead of depending on a particular number of microtasks: the
// queue pump, the async sink (which persists per non-delta event) and the watch
// writer settle across ticks. A macrotask turn keeps this from starving them.
const waitUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('condition was not met in time');
};

// One macrotask turn, to let any leaked progress call land before asserting.
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

const presetOf = (name: string, create: HarnessPreset['create']): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: name,
    subagents: [],
    agents: [name],
    tools: [],
    builtin: true,
    editable: true,
    create
});

const createStore = (presets: HarnessPreset[]): SessionStore =>
    new SessionStore(SETTINGS, createHarnessRegistry(presets));

const createRuntime = (root: string, presets: HarnessPreset[]): HarnessRuntime =>
    createHarnessRuntime({
        root,
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry(presets),
        loadEnvironment: false
    });

// One stream frame reduced to what the ordering contract is about: turn upserts by
// status+prompt, events by type+turnId, and the plain snapshot frame.
const frameKey = (item: SessionStreamItem): string => {
    if (item.type === 'turn') return `turn:${item.turn.status}:${item.turn.prompt}`;
    if (item.type === 'event') return `event:${item.event.type}:${item.turnId}`;

    return item.type;
};

// Assistant messages carry everything a client prints; `reasoning` is always
// present (empty for these stubs) and `stopReason` follows whether tools were asked.
const assistantMessage = (
    content: string,
    toolCalls: HarnessToolCall[] = []
): HarnessAssistantMessage => ({
    role: 'assistant',
    content,
    reasoning: '',
    toolCalls,
    model: MODEL,
    stopReason: toolCalls.length === 0 ? 'stop' : 'tool_calls'
});

const probeCalls = (prompt: string, ids: readonly string[]): HarnessToolCall[] =>
    ids.map((id) => ({ id, name: PROBE, arguments: JSON.stringify({ prompt }) }));

const pendingOf = (calls: readonly HarnessToolCall[], elapsedMs: number): HarnessPendingTool[] =>
    calls.map((call) => ({ callId: call.id, name: call.name, elapsedMs }));

// ---------------------------------------------------------------------------
// Lifecycle fixture: the real handle, a scripted callable
// ---------------------------------------------------------------------------

type Plan =
    | { kind: 'answer'; hold: boolean }
    | { kind: 'tools'; calls: readonly string[]; wake: boolean };

// Prompt -> plan. Plans are per task, never a shared serial script: the fixture
// looks at the prompt it was handed and at what it already committed.
const PLANS: Record<string, Plan> = {
    // Two deferred tool calls: the early-`done` and completion scenarios.
    bg: { kind: 'tools', calls: ['call-1', 'call-2'], wake: false },
    // One deferred call plus a wake heartbeat before it completes.
    heartbeat: { kind: 'tools', calls: ['call-h'], wake: true },
    // Root-cancel scenario (the late completion is forced after the cancel).
    'bg-cancel': { kind: 'tools', calls: ['call-1', 'call-2'], wake: false },
    // Restart scenario (call-2 is still in flight when the crash is simulated).
    'bg-restore': { kind: 'tools', calls: ['call-1', 'call-2'], wake: false },
    // Answers, but only when the test releases it: that keeps the NEXT turn active
    // while a stale background completion is forced.
    after: { kind: 'answer', hold: true }
};

const planOf = (prompt: string): Plan => PLANS[prompt] ?? { kind: 'answer', hold: false };

type Gate = { promise: Promise<void>; resolve: () => void };

// Every harness member except the CALLABLE is forwarded from the real core handle.
const FORWARDED_MEMBERS = [
    'name',
    'agent',
    'agents',
    'subagents',
    'tools',
    'plugins',
    'createTool',
    'executeTool',
    'snapshot',
    'restore',
    'reset',
    'discoveredTools'
] as const satisfies readonly (keyof Harness)[];

type LifecycleFixture = {
    preset: HarnessPreset;
    // Chronological facts about what the fixture was asked to do. Used to prove the
    // pump never starts the next task early and that a late completion really
    // happened (a leak assertion is otherwise vacuous).
    log: string[];
    complete: (prompt: string, callId: string) => void;
    wake: (prompt: string) => void;
    answer: (prompt: string) => void;
};

const createLifecycleFixture = (): LifecycleFixture => {
    const log: string[] = [];
    const gates = new Map<string, Gate>();

    // Gates are created on demand and keyed by the exact thing being released, so a
    // test releases ONE call/answer/wake and the script can never depend on order.
    const gateOf = (key: string): Gate => {
        const existing = gates.get(key);
        if (existing !== undefined) return existing;

        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
            resolve = done;
        });
        const created = { promise, resolve };
        gates.set(key, created);

        return created;
    };

    const release = (key: string): void => {
        gateOf(key).resolve();
    };

    // Abort-aware wait. The harness never preempts a tool, but a run-level abort
    // must SETTLE the turn (the server's gate depends on it), so the wait rejects.
    const hold = (gate: Gate, signal: AbortSignal | undefined): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            if (signal?.aborted === true) {
                reject(new Error(ABORTED));
                return;
            }

            signal?.addEventListener('abort', () => reject(new Error(ABORTED)), { once: true });
            gate.promise.then(resolve, reject);
        });

    const preset = presetOf(NAME, (settings, progress, report) => {
        // The REAL handle. The callable below replaces only the run entry point, so
        // snapshot/restore/reset/agents stay core implementations.
        const core = harness({
            agents: {
                [NAME]: agent({
                    model: settings.model,
                    instruction: INSTRUCTION,
                    // Never called (the hybrid overrides the callable). Present so the
                    // agent is built by the real factory and needs no provider.
                    stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: NAME,
            presets: false
        });

        // Canonical transcript per prompt. A prompt starts from the harness's
        // CURRENT committed history (transcript/state driven: a restored
        // conversation keeps its repaired messages) and every commit rewrites that
        // transcript into the real agent's live messages array.
        const transcripts = new Map<string, HarnessMessage[]>();

        const transcriptFor = (prompt: string): HarnessMessage[] => {
            const existing = transcripts.get(prompt);
            if (existing !== undefined) return existing;

            const seeded = core.agent.messages.map((message) => ({ ...message }));
            transcripts.set(prompt, seeded);

            return seeded;
        };

        // Write the canonical transcript into the real agent, then fire the core
        // state-change observer exactly like the real harness does after a commit.
        // The server turns that into `session.core = harness.snapshot()` (so a
        // completed background tool is durable BEFORE its event is recorded).
        const sync = (prompt: string): void => {
            const target = core.agent.messages as HarnessMessage[];
            const next = transcriptFor(prompt);

            target.length = next.length;
            next.forEach((message, index) => {
                target[index] = { ...message };
            });

            report?.stateChange?.({ type: 'state_change', reason: 'agent_message', agent: NAME });
        };

        const commit = (prompt: string, message: HarnessMessage): void => {
            transcriptFor(prompt).push(message);
            sync(prompt);
        };

        const script = async (prompt: string, signal?: AbortSignal): Promise<HarnessAssistantMessage> => {
            const plan = planOf(prompt);
            log.push(`start:${prompt}`);

            // The user task lands in the transcript first, so every later commit has
            // a coherent canonical history (system, user, assistant tool_calls, tools).
            commit(prompt, { role: 'user', content: prompt });

            if (plan.kind === 'answer') {
                await progress({ type: 'start', agent: NAME, model: MODEL });

                const text = `answer:${prompt}`;
                await progress({ type: 'text', agent: NAME, delta: text });

                if (plan.hold) await hold(gateOf(`answer:${prompt}`), signal);

                const message = assistantMessage(text);
                commit(prompt, { role: 'assistant', content: text, toolCalls: [] });
                await progress({ type: 'done', agent: NAME, message });
                log.push(`end:${prompt}`);

                return message;
            }

            // Background plan: the model asks for calls that OUTLIVE its request.
            await progress({ type: 'start', agent: NAME, model: MODEL });

            const calls = probeCalls(prompt, plan.calls);
            for (const call of calls) await progress({ type: 'tool_call', agent: NAME, call });

            const launchedAt = new Map<string, number>();
            const completed = new Set<string>();

            for (const call of calls) {
                // Launch time is stamped where the runtime starts the call, so every
                // elapsed/duration figure below is server-visible fact.
                launchedAt.set(call.id, Date.now());
                gateOf(`call:${prompt}:${call.id}`);
            }

            const pendingNow = (): HarnessPendingTool[] =>
                calls
                    .filter((call) => !completed.has(call.id))
                    .map((call) => ({
                        callId: call.id,
                        name: call.name,
                        elapsedMs: Date.now() - (launchedAt.get(call.id) ?? Date.now())
                    }));

            // The EARLY model response: `pending` is non-empty, so the run is not
            // terminal. The server must keep the turn running and the gate held.
            commit(prompt, { role: 'assistant', content: '', toolCalls: calls });
            await progress({
                type: 'done',
                agent: NAME,
                message: assistantMessage('', calls),
                pending: pendingNow()
            });

            let aborted = false;
            const onAbort = (): void => {
                aborted = true;
            };
            signal?.addEventListener('abort', onAbort, { once: true });

            try {
                if (plan.wake) {
                    await hold(gateOf(`wake:${prompt}`), signal);
                    await progress({
                        type: 'wakeup',
                        agent: NAME,
                        reason: 'pending-tools',
                        pending: pendingNow()
                    });
                }

                for (const call of calls) {
                    await hold(gateOf(`call:${prompt}:${call.id}`), signal);

                    completed.add(call.id);

                    const content = `result:${call.id}`;
                    const remaining = pendingNow();
                    const durationMs = Date.now() - (launchedAt.get(call.id) ?? Date.now());

                    // The completed tool's canonical message is committed BEFORE the
                    // event, exactly like the runtime: the server can persist the pair
                    // even though the turn is still open.
                    commit(prompt, {
                        role: 'tool',
                        content,
                        toolCallId: call.id,
                        name: call.name
                    });

                    await progress({
                        type: 'tool_result',
                        agent: NAME,
                        name: call.name,
                        callId: call.id,
                        content,
                        isError: false,
                        durationMs,
                        ...(remaining.length === 0 ? {} : { pending: remaining })
                    });
                }

                // Immediate continuation: the agent answers once nothing is pending.
                // The harness promise resolves only after this, which is the boundary
                // the server's busy/sink lifetime depends on.
                const text = `final:${prompt}`;
                await progress({ type: 'text', agent: NAME, delta: text });

                const message = assistantMessage(text);
                commit(prompt, { role: 'assistant', content: text, toolCalls: [] });
                await progress({ type: 'done', agent: NAME, message });
                log.push(`end:${prompt}`);

                return message;
            } catch (error) {
                // A run-level abort reaches every call. A call that IGNORES the signal
                // still finishes later: record that it did (so a "no leak" assertion
                // is never vacuous) and emit NOTHING for it — the runtime's rule that
                // a late result is discarded is what the server then relies on.
                log.push(`abort:${prompt}`);

                for (const call of calls) {
                    if (completed.has(call.id)) continue;

                    void gateOf(`call:${prompt}:${call.id}`).promise.then(() => {
                        if (aborted) log.push(`late:${call.id}`);
                    });
                }

                throw error;
            } finally {
                signal?.removeEventListener('abort', onAbort);
            }
        };

        // Hybrid handle: scripted callable + the real core members (forwarded by
        // descriptor, so `discoveredTools` stays a live getter).
        const hybrid = ((input: string, options?: HarnessRunOptions) =>
            script(input, options?.signal)) as unknown as Harness;

        const descriptors = Object.getOwnPropertyDescriptors(core);
        const forwarded: PropertyDescriptorMap = {};

        for (const member of FORWARDED_MEMBERS) {
            const descriptor = descriptors[member];
            if (descriptor !== undefined) forwarded[member] = descriptor;
        }

        Object.defineProperties(hybrid, forwarded);

        return hybrid;
    });

    return {
        preset,
        log,
        complete: (prompt, callId) => release(`call:${prompt}:${callId}`),
        wake: (prompt) => release(`wake:${prompt}`),
        answer: (prompt) => release(`answer:${prompt}`)
    };
};

// ---------------------------------------------------------------------------
// 1. Early `done` with pending work is not a terminal turn
// ---------------------------------------------------------------------------

describe('background run — the turn stays open while tools are pending', () => {
    it('keeps the turn running after the model done event and holds the next task queued', async () => {
        const setClock = pinClock(1_000);
        const fixture = createLifecycleFixture();
        const store = createStore([fixture.preset]);
        const created = store.create(NAME);

        setClock(2_000);

        const frames: SessionStreamItem[] = [];
        const watched = store.watch(created.id, async (item) => {
            frames.push(item);
        });
        expect(watched.snapshot.turns).toEqual([]);

        const first = store.enqueue(created.id, 'bg');

        // 202-shaped acceptance: stable id/index, trimmed prompt, queued, no
        // startedAt before execution.
        expect(first.turn).toEqual({
            id: first.turn.id,
            index: 0,
            prompt: 'bg',
            status: 'queued',
            updatedAt: 2_000,
            events: [],
            eventTimes: []
        });
        expect(first.session.queueDepth).toBe(1);

        // start, tool_call x2, then the model's `done` — which still lists both calls
        // as pending. Nothing terminal may follow from that event.
        await waitUntil(() => store.get(created.id).turns[0].events.length === 4);

        const turnId = first.turn.id;
        const calls = probeCalls('bg', ['call-1', 'call-2']);
        const running = store.get(created.id);

        expect(running.status).toBe('running');
        expect(running.turns[0]).toEqual({
            id: turnId,
            index: 0,
            prompt: 'bg',
            status: 'running',
            startedAt: 2_000,
            updatedAt: 2_000,
            events: [
                { type: 'start', agent: NAME, model: MODEL },
                { type: 'tool_call', agent: NAME, call: calls[0] },
                { type: 'tool_call', agent: NAME, call: calls[1] },
                {
                    type: 'done',
                    agent: NAME,
                    message: assistantMessage('', calls),
                    pending: pendingOf(calls, 0)
                }
            ],
            eventTimes: [2_000, 2_000, 2_000, 2_000]
        });

        // The single-flight gate is still held by the unfinished turn, so legacy
        // work and manual mutations stay refused (existing contract, unchanged).
        expect(() => store.assertRunnable(created.id)).toThrow(
            'A task is already running in this session.'
        );

        // A second task is accepted as backlog and does NOT start.
        setClock(3_000);
        const second = store.enqueue(created.id, 'after');
        expect(second.turn).toEqual({
            id: second.turn.id,
            index: 1,
            prompt: 'after',
            status: 'queued',
            updatedAt: 3_000,
            events: [],
            eventTimes: []
        });
        expect(store.get(created.id).queueDepth).toBe(1);
        expect(store.get(created.id).turns.map((turn) => turn.status)).toEqual([
            'running',
            'queued'
        ]);
        expect(fixture.log).toEqual(['start:bg']);

        // The queue cannot be considered idle while background work is outstanding.
        let idle = false;
        void store.waitForIdle(created.id).then(() => {
            idle = true;
        });
        await settle();
        expect(idle).toBe(false);

        expect(frames.map(frameKey)).toEqual([
            'turn:queued:bg',
            'turn:running:bg',
            `event:start:${turnId}`,
            `event:tool_call:${turnId}`,
            `event:tool_call:${turnId}`,
            `event:done:${turnId}`,
            'turn:queued:after'
        ]);

        // Leave no parked run behind: stop-all aborts the active turn and drops the
        // backlog; the pending gates are never resolved (an unresolved promise keeps
        // no handle open).
        store.cancel(created.id, { all: true });
        await store.waitForIdle(created.id);
        expect(store.get(created.id).turns.map((turn) => turn.status)).toEqual([
            'cancelled',
            'cancelled'
        ]);
    });

    // ---------------------------------------------------------------------
    // 2. Wake heartbeat + first completion are retained, stream detach is safe
    // ---------------------------------------------------------------------

    it('records a wakeup heartbeat and a partial completion without terminalizing the turn', async () => {
        const setClock = pinClock(1_000);
        const fixture = createLifecycleFixture();
        const store = createStore([fixture.preset]);
        const created = store.create(NAME);

        setClock(2_000);

        const frames: SessionStreamItem[] = [];
        const watched = store.watch(created.id, async (item) => {
            frames.push(item);
        });

        const task = store.enqueue(created.id, 'heartbeat');
        const turnId = task.turn.id;
        const calls = probeCalls('heartbeat', ['call-h']);

        // start, tool_call, done(pending) — the run is parked on its call.
        await waitUntil(() => store.get(created.id).turns[0].events.length === 3);

        // Ten minutes later the harness wakes the model with the pending list.
        setClock(600_000);
        fixture.wake('heartbeat');
        await waitUntil(() => store.get(created.id).turns[0].events.length === 4);

        expect(store.get(created.id).turns[0].events[3]).toEqual({
            type: 'wakeup',
            agent: NAME,
            reason: 'pending-tools',
            pending: [{ callId: 'call-h', name: PROBE, elapsedMs: 598_000 }]
        });
        expect(store.get(created.id).status).toBe('running');
        expect(store.get(created.id).turns[0].status).toBe('running');

        // Detaching the GET-events watcher is NOT a cancellation: the pump owns the
        // work, not the stream.
        const attached = frames.length;
        watched.unsubscribe();
        expect(attached).toBe(6);

        setClock(601_000);
        fixture.complete('heartbeat', 'call-h');
        await waitUntil(() => store.get(created.id).turns[0].status === 'done');
        await store.waitForIdle(created.id);

        const final = store.get(created.id);

        // The completion is recorded with its measured duration and (for the last
        // pending call) no `pending` key at all: the historical shape is preserved.
        expect(final.turns[0]).toEqual({
            id: turnId,
            index: 0,
            prompt: 'heartbeat',
            status: 'done',
            startedAt: 2_000,
            updatedAt: 601_000,
            events: [
                { type: 'start', agent: NAME, model: MODEL },
                { type: 'tool_call', agent: NAME, call: calls[0] },
                {
                    type: 'done',
                    agent: NAME,
                    message: assistantMessage('', calls),
                    pending: [{ callId: 'call-h', name: PROBE, elapsedMs: 0 }]
                },
                {
                    type: 'wakeup',
                    agent: NAME,
                    reason: 'pending-tools',
                    pending: [{ callId: 'call-h', name: PROBE, elapsedMs: 598_000 }]
                },
                {
                    type: 'tool_result',
                    agent: NAME,
                    name: PROBE,
                    callId: 'call-h',
                    content: 'result:call-h',
                    isError: false,
                    durationMs: 599_000
                },
                { type: 'text', agent: NAME, delta: 'final:heartbeat' },
                { type: 'done', agent: NAME, message: assistantMessage('final:heartbeat') }
            ],
            eventTimes: [2_000, 2_000, 2_000, 600_000, 601_000, 601_000, 601_000]
        });

        // The run survived the detach and drained normally.
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();
        expect(final.queueDepth).toBeUndefined();

        // No frame was published after the watcher detached.
        expect(frames.map(frameKey)).toEqual([
            'turn:queued:heartbeat',
            'turn:running:heartbeat',
            `event:start:${turnId}`,
            `event:tool_call:${turnId}`,
            `event:done:${turnId}`,
            `event:wakeup:${turnId}`
        ]);
    });
});

// ---------------------------------------------------------------------------
// 3. Terminal transition + FIFO advance
// ---------------------------------------------------------------------------

describe('background run — completion order and queue advance', () => {
    it('terminalizes after the last completion and the final answer, then runs the queued task', async () => {
        const setClock = pinClock(1_000);
        const fixture = createLifecycleFixture();
        const store = createStore([fixture.preset]);
        const created = store.create(NAME);

        setClock(2_000);

        const frames: SessionStreamItem[] = [];
        store.watch(created.id, async (item) => {
            frames.push(item);
        });

        const first = store.enqueue(created.id, 'bg');
        const calls = probeCalls('bg', ['call-1', 'call-2']);

        await waitUntil(() => store.get(created.id).turns[0].events.length === 4);

        // A second task arrives while the background run is still open.
        setClock(3_000);
        const second = store.enqueue(created.id, 'next');
        expect(store.get(created.id).queueDepth).toBe(1);

        // First of two completions: recorded, with the remaining call still pending.
        // The turn is STILL running and the next task has NOT started.
        setClock(4_000);
        fixture.complete('bg', 'call-1');
        await waitUntil(() => store.get(created.id).turns[0].events.length === 5);

        expect(store.get(created.id).turns[0].events[4]).toEqual({
            type: 'tool_result',
            agent: NAME,
            name: PROBE,
            callId: 'call-1',
            content: 'result:call-1',
            isError: false,
            durationMs: 2_000,
            pending: [{ callId: 'call-2', name: PROBE, elapsedMs: 2_000 }]
        });
        expect(store.get(created.id).turns[0].status).toBe('running');
        expect(store.get(created.id).status).toBe('running');
        expect(store.get(created.id).turns[1].status).toBe('queued');
        expect(fixture.log).toEqual(['start:bg']);

        // Last completion, then the immediate continuation answer: only now may the
        // turn become terminal and the pump advance.
        setClock(5_000);
        fixture.complete('bg', 'call-2');
        await waitUntil(
            () => store.get(created.id).turns.map((turn) => turn.status).join() === 'done,done'
        );
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();
        expect(final.queueDepth).toBeUndefined();

        expect(final.turns).toEqual([
            {
                id: first.turn.id,
                index: 0,
                prompt: 'bg',
                status: 'done',
                startedAt: 2_000,
                updatedAt: 5_000,
                events: [
                    { type: 'start', agent: NAME, model: MODEL },
                    { type: 'tool_call', agent: NAME, call: calls[0] },
                    { type: 'tool_call', agent: NAME, call: calls[1] },
                    {
                        type: 'done',
                        agent: NAME,
                        message: assistantMessage('', calls),
                        pending: pendingOf(calls, 0)
                    },
                    {
                        type: 'tool_result',
                        agent: NAME,
                        name: PROBE,
                        callId: 'call-1',
                        content: 'result:call-1',
                        isError: false,
                        durationMs: 2_000,
                        pending: [{ callId: 'call-2', name: PROBE, elapsedMs: 2_000 }]
                    },
                    {
                        type: 'tool_result',
                        agent: NAME,
                        name: PROBE,
                        callId: 'call-2',
                        content: 'result:call-2',
                        isError: false,
                        durationMs: 3_000
                    },
                    { type: 'text', agent: NAME, delta: 'final:bg' },
                    { type: 'done', agent: NAME, message: assistantMessage('final:bg') }
                ],
                eventTimes: [2_000, 2_000, 2_000, 2_000, 4_000, 5_000, 5_000, 5_000]
            },
            {
                id: second.turn.id,
                index: 1,
                prompt: 'next',
                status: 'done',
                startedAt: 5_000,
                updatedAt: 5_000,
                events: [
                    { type: 'start', agent: NAME, model: MODEL },
                    { type: 'text', agent: NAME, delta: 'answer:next' },
                    { type: 'done', agent: NAME, message: assistantMessage('answer:next') }
                ],
                eventTimes: [5_000, 5_000, 5_000]
            }
        ]);

        // FIFO: the background task fully drained before the queued one started.
        expect(fixture.log).toEqual(['start:bg', 'end:bg', 'start:next', 'end:next']);

        expect(frames.map(frameKey)).toEqual([
            'turn:queued:bg',
            'turn:running:bg',
            `event:start:${first.turn.id}`,
            `event:tool_call:${first.turn.id}`,
            `event:tool_call:${first.turn.id}`,
            `event:done:${first.turn.id}`,
            'turn:queued:next',
            `event:tool_result:${first.turn.id}`,
            `event:tool_result:${first.turn.id}`,
            `event:text:${first.turn.id}`,
            `event:done:${first.turn.id}`,
            'turn:done:bg',
            'turn:running:next',
            `event:start:${second.turn.id}`,
            `event:text:${second.turn.id}`,
            `event:done:${second.turn.id}`,
            'turn:done:next',
            'snapshot'
        ]);
    });
});

// ---------------------------------------------------------------------------
// 4. Root cancel + late uncooperative completion
// ---------------------------------------------------------------------------

describe('background run — cancellation', () => {
    it('settles a cancelled background turn, runs the next task, and ignores a late completion', async () => {
        const setClock = pinClock(1_000);
        const fixture = createLifecycleFixture();
        const store = createStore([fixture.preset]);
        const created = store.create(NAME);

        setClock(2_000);
        const task = store.enqueue(created.id, 'bg-cancel');
        const turnId = task.turn.id;
        const calls = probeCalls('bg-cancel', ['call-1', 'call-2']);

        await waitUntil(() => store.get(created.id).turns[0].events.length === 4);

        // Root cancel: the active turn only (the legacy default shape).
        setClock(3_000);
        expect(store.cancel(created.id)).toBe(true);
        await waitUntil(() => store.get(created.id).turns[0].status === 'cancelled');

        expect(store.get(created.id).status).toBe('error');
        expect(store.get(created.id).lastError).toBe('The run was cancelled.');
        expect(store.get(created.id).turns[0]).toEqual({
            id: turnId,
            index: 0,
            prompt: 'bg-cancel',
            status: 'cancelled',
            startedAt: 2_000,
            updatedAt: 3_000,
            events: [
                { type: 'start', agent: NAME, model: MODEL },
                { type: 'tool_call', agent: NAME, call: calls[0] },
                { type: 'tool_call', agent: NAME, call: calls[1] },
                {
                    type: 'done',
                    agent: NAME,
                    message: assistantMessage('', calls),
                    pending: pendingOf(calls, 0)
                }
            ],
            eventTimes: [2_000, 2_000, 2_000, 2_000]
        });

        // The abort reached the run; neither pending call completed.
        expect(fixture.log).toEqual(['start:bg-cancel', 'abort:bg-cancel']);

        // A safe subsequent task: the cancelled background turn released the gate.
        setClock(4_000);
        const next = store.enqueue(created.id, 'after');
        expect(next.turn.status).toBe('queued');
        await waitUntil(() => store.get(created.id).turns[1]?.events.length === 2);

        expect(store.get(created.id).status).toBe('running');
        expect(store.get(created.id).turns[1].events).toEqual([
            { type: 'start', agent: NAME, model: MODEL },
            { type: 'text', agent: NAME, delta: 'answer:after' }
        ]);

        // The tool that ignored the abort finishes NOW, while the next turn is the
        // active sink. Its completion must not be recorded anywhere.
        setClock(5_000);
        fixture.complete('bg-cancel', 'call-1');
        await waitUntil(() => fixture.log.includes('late:call-1'));
        await settle();

        expect(store.get(created.id).turns[1].events).toEqual([
            { type: 'start', agent: NAME, model: MODEL },
            { type: 'text', agent: NAME, delta: 'answer:after' }
        ]);
        expect(store.get(created.id).turns[1].status).toBe('running');
        expect(store.get(created.id).turns[0].events).toHaveLength(4);

        // Finish the next turn normally.
        setClock(6_000);
        fixture.answer('after');
        await waitUntil(() => store.get(created.id).turns[1].status === 'done');
        await store.waitForIdle(created.id);

        const final = store.get(created.id);
        expect(final.status).toBe('idle');
        expect(final.lastError).toBeUndefined();
        expect(final.turns.map((turn) => `${turn.index}:${turn.status}`)).toEqual([
            '0:cancelled',
            '1:done'
        ]);
        expect(final.turns[1]).toEqual({
            id: next.turn.id,
            index: 1,
            prompt: 'after',
            status: 'done',
            startedAt: 4_000,
            updatedAt: 6_000,
            events: [
                { type: 'start', agent: NAME, model: MODEL },
                { type: 'text', agent: NAME, delta: 'answer:after' },
                { type: 'done', agent: NAME, message: assistantMessage('answer:after') }
            ],
            eventTimes: [4_000, 4_000, 6_000]
        });

        // The late completion really happened, and the record shows no trace of it.
        expect(fixture.log).toEqual([
            'start:bg-cancel',
            'abort:bg-cancel',
            'start:after',
            'late:call-1',
            'end:after'
        ]);
    });
});

// ---------------------------------------------------------------------------
// 5. Restart while background work is in flight
// ---------------------------------------------------------------------------

describe('background run — restart and restore', () => {
    it('restores the interrupted turn as error, repairs the transcript, and drains the queue', async () => {
        const setClock = pinClock(1_000);
        const fixture = createLifecycleFixture();
        const root = tempRoot('restore');

        const first = createRuntime(root, [fixture.preset]);

        try {
            const created = first.store.create(NAME);
            const id = created.id;

            setClock(2_000);
            first.store.enqueue(id, 'bg-restore');

            await waitUntil(() => first.store.get(id).turns[0].events.length === 4);

            // One background call completes before the crash: its canonical pair is
            // evidence and must survive, while the other call is still in flight.
            setClock(3_000);
            fixture.complete('bg-restore', 'call-1');
            await waitUntil(() => first.store.get(id).turns[0].events.length === 5);

            setClock(4_000);
            first.store.enqueue(id, 'next');
            expect(first.store.get(id).queueDepth).toBe(1);

            // Crash: a FRESH runtime over the SAME root while call-2 is still running.
            // No dispose and no terminal write on the first store.
            const second = createRuntime(root, [fixture.preset]);

            try {
                const restored = second.store.get(id);

                // Recovery policy: interrupted, never replayed.
                expect(restored.status).toBe('error');
                expect(restored.lastError).toBe(INTERRUPTED_MESSAGE);
                expect(
                    restored.turns.map((turn) => `${turn.index}:${turn.status}:${turn.prompt}`)
                ).toEqual(['0:error:bg-restore', '1:queued:next']);

                // Recorded events survive verbatim, including the partial completion.
                expect(restored.turns[0].events.map((event) => event.type)).toEqual([
                    'start',
                    'tool_call',
                    'tool_call',
                    'done',
                    'tool_result'
                ]);
                expect(restored.turns[0].eventTimes).toEqual([2_000, 2_000, 2_000, 2_000, 3_000]);
                expect(restored.turns[1].startedAt).toBeUndefined();
                expect(restored.turns[1].events).toEqual([]);
                expect(restored.queueDepth).toBe(1);

                // Canonical repair: the completed call keeps its real tool message and
                // the originating assistant tool_calls; the unfinished call gets ONE
                // explicit synthetic result (never a replay, never a silent pairing).
                const calls = probeCalls('bg-restore', ['call-1', 'call-2']);

                expect(restored.messages).toEqual([
                    { role: 'system', content: INSTRUCTION },
                    { role: 'user', content: 'bg-restore' },
                    { role: 'assistant', content: '', toolCalls: calls },
                    { role: 'tool', content: 'result:call-1', toolCallId: 'call-1', name: PROBE },
                    {
                        role: 'tool',
                        content: INTERRUPTED_TOOL_RESULT_TEXT,
                        toolCallId: 'call-2',
                        name: PROBE
                    }
                ]);

                // No automatic replay: the queue stays paused until an explicit submit.
                await settle();
                expect(second.store.get(id).turns.map((turn) => turn.status)).toEqual([
                    'error',
                    'queued'
                ]);

                // The preserved backlog still drains FIFO on the repaired harness, in
                // order, after one new submit starts the pump.
                setClock(5_000);
                second.store.enqueue(id, 'tail');
                await second.store.waitForIdle(id);

                const drained = second.store.get(id);
                expect(drained.status).toBe('idle');
                expect(
                    drained.turns.map((turn) => `${turn.index}:${turn.status}:${turn.prompt}`)
                ).toEqual(['0:error:bg-restore', '1:done:next', '2:done:tail']);
            } finally {
                // Ends the restored store's own parked work (none) and its file handle.
                second.store.dispose();
            }
        } finally {
            // Aborts the first store's still-running background turn so no promise is
            // left parked, then drops the in-memory sessions.
            first.store.dispose();
        }
    });
});
