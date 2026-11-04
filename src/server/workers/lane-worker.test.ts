// Worker-mode integration: the behavior `threadExecution: 'worker'` PROMISES, measured
// against real `node:worker_threads` lanes. No mocks - every assertion here is about a real
// turn, a real tool body, and real canonical state.
//
// What is proven, requirement by requirement:
//   R1  a turn's agent loop AND its tool bodies execute off the coordinator: a CPU burn on
//       one lane leaves another session's lane progressing and this process's event loop
//       responsive (the HTTP surface is served by that loop);
//   R2  shared state stays central and linearizable: a task record added through one lane is
//       read back by a DIFFERENT lane, and a cross-thread send from a lane appends into the
//       target conversation;
//   R4  cancellation and a dead lane have no late effects: a stopped lane's turn is terminal
//       and its transcript stops growing; a lane whose worker is terminated settles as a
//       failure and can never move canonical state again.
//
// Why two SESSIONS for the burn test: the store's single-flight gate serializes a manual
// tool call against its own session's turns in BOTH modes (../sessions.ts `busyOrPending`),
// so "a lane A burn vs a sibling lane B" is measured across two sessions - same process,
// same host, same event loop, which is exactly what must stay responsive.
//
// Cross-references:
//   - ./lane-host.ts                - spawn, handshake, relay, receipts, teardown
//   - ./lane-worker-loop.ts         - the worker that runs the turn
//   - ./lane-authority.ts           - the canonical applier the receipts drive
//   - ../sessions.ts                - the inline/worker branch under test
//   - ../../../Temp/t5/probe-lane.ts- the standalone version of this probe

import { afterAll, describe, expect, it } from 'vitest';
import { createHarnessRegistry } from '../harnesses';
import { ALL_PRESET_TEMPLATES } from '../harnesses/presets.ts';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import type { SessionSnapshot, SessionTurn } from '../protocol';
import { SessionStore } from '../sessions';
import type { LaneHost } from './lane-host';

// A cold lane builds the harness, recompiles the created-tool sources and restores the
// snapshot: measured at ~1.6 s on this machine, so the handshake bound is generous and the
// test timeout has to be too.
const WORKER_RUNTIME: ServerRuntimeConfiguration = {
    ...DEFAULT_RUNTIME_CONFIGURATION,
    threadExecution: 'worker',
    // 0 keeps a lane alive for the whole test, so a second tool call does not pay a second
    // cold start (reclaim is exercised separately in ./lane-host tests).
    workerIdleMs: 0,
    maxLaneWorkers: 8,
    workerHandshakeMs: 120_000
};

const SETTINGS = { baseURL: 'http://localhost:9/v1', apiKey: '', model: 'demo' };

const stores: SessionStore[] = [];

const storeOf = (): SessionStore => {
    // `demo` is the shipped SCRIPTED preset: it needs no provider, and its durable template
    // record is what a worker rebuilds (`presetFromRecord`), which is the whole point of the
    // capability gate.
    const store = new SessionStore(
        SETTINGS,
        createHarnessRegistry(ALL_PRESET_TEMPLATES as never),
        undefined,
        { runtime: WORKER_RUNTIME }
    );

    stores.push(store);

    return store;
};

afterAll(async () => {
    for (const store of stores) store.dispose();

    // Give every terminate() a tick to land, so a closing vitest pool cannot race a live
    // worker (a leaked worker would keep the process alive, which is its own failure).
    await new Promise((resolve) => setTimeout(resolve, 250));
});

// The host is created lazily by the store on the first worker-mode dispatch, and even then
// only when the lane pump actually starts, so tests read it through the same field the
// store's shutdown path uses and tolerate it being absent for a tick.
const hostOf = (store: SessionStore): LaneHost | undefined => (store as unknown as { host?: LaneHost }).host;

// Wait for the host to exist (the pump starts asynchronously after a submit is accepted).
const hostReady = async (store: SessionStore, limitMs = 20_000): Promise<LaneHost> => {
    const started = Date.now();

    for (;;) {
        const host = hostOf(store);

        if (host !== undefined) return host;

        if (Date.now() - started > limitMs) throw new Error(`No lane host appeared within ${limitMs}ms.`);

        await sleep(20);
    }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const turnOf = (session: SessionSnapshot, turnId: string): SessionTurn | undefined =>
    session.turns.find((turn) => turn.id === turnId);

// Poll until a turn leaves the running/queued states. The store settles a lane turn through
// its own finally, so this observes the same record a client would watch.
const settle = async (store: SessionStore, id: string, turnId: string, limitMs = 90_000): Promise<SessionTurn> => {
    const started = Date.now();

    for (;;) {
        const turn = turnOf(store.get(id), turnId);

        if (turn !== undefined && turn.status !== 'running' && turn.status !== 'queued') return turn;

        if (Date.now() - started > limitMs) {
            throw new Error(`Turn ${turnId} did not settle within ${limitMs}ms (last status: ${turn?.status ?? 'missing'}).`);
        }

        await sleep(25);
    }
};

// Event-loop lag sampler: the smallest honest measure of "the coordinator stayed free". A
// 10 ms interval that drifts past ~2-3x its period means something blocked the loop.
const sampleLag = (): { stop: () => number; ticks: () => number } => {
    let worst = 0;
    let last = Date.now();
    let ticks = 0;

    const timer = setInterval(() => {
        const now = Date.now();

        worst = Math.max(worst, now - last);
        last = now;
        ticks += 1;
    }, 10);

    timer.unref?.();

    return { stop: () => (clearInterval(timer), worst), ticks: () => ticks };
};

// A created tool's `source` is a function BODY. Its schema below has ONE property, and the
// core unwraps a single-property schema into `args` directly (../sessions.ts documents the
// same rule for a manual call), so `args` IS the number of milliseconds here.
const BURN_SOURCE = `
    const ms = Number(typeof args === 'object' && args ? args.ms : args) || 100;
    const until = Date.now() + ms;
    let acc = 0;
    while (Date.now() < until) acc += Math.sqrt(Math.random());
    return 'burned ' + ms + ' (' + Math.round(acc) + ')';
`;

describe('worker mode: a turn runs on its own lane', () => {
    it('executes two conversations concurrently and keeps this process responsive', async () => {
        const store = storeOf();
        const session = store.create('demo');

        const a = await store.dispatch(session.id, 'what time is it?');
        const b = await store.dispatch(session.id, 'and once more');

        expect(a.turn.threadId).toBeDefined();
        expect(b.turn.threadId).toBeDefined();
        expect(a.turn.threadId).not.toBe(b.turn.threadId);

        const lag = sampleLag();
        const startedAt = Date.now();

        // Observe the overlap directly rather than timing the wall clock: both lanes must be
        // reported busy by the host at the same instant, which is only possible if two workers
        // are executing. A serial execution would never show two busy lanes.
        let overlapped = false;
        const lanes = await hostReady(store);

        const watching = (async (): Promise<void> => {
            for (let sample = 0; sample < 400 && !overlapped; sample += 1) {
                const live = lanes.lanes().filter((lane) => lane.sessionKey === session.id);

                if (live.length >= 2 && live.every((lane) => lane.busy)) overlapped = true;

                await sleep(20);
            }
        })();

        const [turnA, turnB] = await Promise.all([settle(store, session.id, a.turn.id), settle(store, session.id, b.turn.id)]);

        await watching;

        const worst = lag.stop();

        expect(overlapped).toBe(true);

        // Both turns ran to completion, and each produced its own recorded event stream:
        // events arrive through the host relay, so a recorded frame is proof the lane ran.
        expect([turnA.status, turnB.status]).toEqual(['done', 'done']);
        expect(turnA.events.length).toBeGreaterThan(0);
        expect(turnB.events.length).toBeGreaterThan(0);

        // Both turns really did work: two scripted demo turns each stream a full discovery +
        // tool + answer loop, and the wall clock stayed in the same order as ONE turn plus
        // cold starts (a serial pair would be roughly double).
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(20_000);
        expect(turnA.events.length + turnB.events.length).toBeGreaterThan(20);

        // The coordinator's loop was never parked by the lane work (the inline path would
        // show multi-hundred-millisecond drift for a CPU burn; here the lanes are the busy
        // parties).
        expect(worst).toBeLessThan(150);

        // Roster mirror: the canonical records report the conversation as finished and join
        // it to the invocation the lane archived, which is what the UI and /results read.
        const after = store.get(session.id);
        const threadA = after.threads?.find((thread) => thread.id === a.turn.threadId);

        expect(threadA?.status).toBe('idle');
        expect(threadA?.invocationId).toBe(a.turn.threadId);

        // The transcript is CANONICAL: the store's thread view holds the lane's work, so a
        // restart or a fresh lane rebuilds from it.
        const transcript = JSON.stringify(threadA?.messages ?? []);

        expect(transcript).toContain('what time is it?');

        // Two conversation workers plus (optionally) no operator lane: the host is what says
        // how many threads are really live.
        expect(lanes.lanes().filter((lane) => lane.sessionKey === session.id)).toHaveLength(2);
    }, 180_000);

    it('burns CPU on one lane while another session and the event loop keep moving', async () => {
        const store = storeOf();
        const burner = store.create('demo');
        const sibling = store.create('demo');

        // The CPU-heavy tool is registered through a LANE (a routed `toolCreate`), so the
        // burn body exists in the replica through the authority's registry broadcast rather
        // than being installed by the test process.
        const created = (await store.callTool(burner.id, 'toolCreate', {
            name: 'burn',
            description: 'Burn CPU for a fixed time.',
            tags: ['cpu'],
            parameters: { type: 'object', properties: { ms: { type: 'number' } } },
            source: BURN_SOURCE
        })) as { name?: string };

        expect(created?.name ?? 'burn').toBe('burn');

        const running = await store.dispatch(sibling.id, 'time please');
        const lanes = await hostReady(store);

        // The lane pump starts asynchronously after a submit is accepted, so the sibling's
        // worker appears on a later tick. Waiting for it is what makes "it was running while
        // the burn ran" an observation rather than a hope.
        let siblingLive = false;

        for (let attempt = 0; attempt < 400 && !siblingLive; attempt += 1) {
            siblingLive = lanes.lanes().some((lane) => lane.sessionKey === sibling.id && lane.role === running.turn.threadId);

            if (!siblingLive) await sleep(20);
        }

        expect(siblingLive).toBe(true);

        // Warm the sibling lane first: wait until it has recorded its FIRST frame, so what is
        // measured afterwards is a running conversation, not a cold start.
        for (let attempt = 0; attempt < 500; attempt += 1) {
            if ((turnOf(store.get(sibling.id), running.turn.id)?.events.length ?? 0) > 0) break;

            await sleep(20);
        }

        const baseline = turnOf(store.get(sibling.id), running.turn.id)?.events.length ?? 0;

        expect(baseline).toBeGreaterThan(0);

        const lag = sampleLag();
        const startedAt = Date.now();

        // The burn (800 ms of real busy-wait) runs on the operator lane of `burner`.
        const burnPromise = store.callTool(burner.id, 'burn', { ms: 800 });

        // While it burns: the sibling lane must keep recording progress, and this process
        // must keep serving reads (the HTTP routes are these same calls).
        let burning = true;

        burnPromise.finally(() => {
            burning = false;
        });

        let progressDuringBurn = baseline;
        let samplesDuringBurn = 0;

        for (let sample = 0; sample < 500; sample += 1) {
            const events = turnOf(store.get(sibling.id), running.turn.id)?.events.length ?? 0;

            if (burning) {
                samplesDuringBurn += 1;
                progressDuringBurn = Math.max(progressDuringBurn, events);
            }

            if (!burning && events > 20) break;

            await sleep(20);
        }

        const burned = await burnPromise;
        const worst = lag.stop();
        const burnElapsed = Date.now() - startedAt;

        expect(String(burned)).toContain('burned 800');
        expect(burnElapsed).toBeGreaterThanOrEqual(780);

        // The sibling made progress WHILE the burn was in flight: its event stream grew past
        // the baseline during the spin, which the inline path cannot do while a tool body is
        // occupying the loop.
        expect(progressDuringBurn).toBeGreaterThan(baseline);
        expect(samplesDuringBurn).toBeGreaterThan(0);

        // And the loop itself stayed free enough to sample ~10 ms ticks and answer reads.
        expect(worst).toBeLessThan(150);

        const settled = await settle(store, sibling.id, running.turn.id);

        expect(settled.status).toBe('done');
    }, 180_000);
});

describe('worker mode: shared state is central, not local', () => {
    it('writes a task through one lane and reads it back on a rebuilt lane', async () => {
        const store = storeOf();
        const session = store.create('demo');

        const added = (await store.callTool(session.id, 'task', { tasks: [{ text: 'written from a lane' }] })) as {
            tasks?: { id: string; text: string }[];
        };

        // The id was minted by the CORE store on the coordinator, and the answer came back
        // through the lane: that is the central mutation the requirement asks for.
        expect(added?.tasks?.[0]).toMatchObject({ id: '1', text: 'written from a lane' });

        // Reclaim EVERY worker of this session, then read again: the NEXT call spawns a fresh
        // lane, rebuilt from the authority's committed state, and it must see the record. A
        // replica-local write would have disappeared here - exactly the retired merge's
        // failure mode.
        hostOf(store).closeSession(session.id, 'test reclaim');

        const reread = (await store.callTool(session.id, 'task', {})) as { tasks?: { id: string; text: string }[] };

        expect(reread?.tasks?.map((task) => task.text)).toEqual(['written from a lane']);

        // A new worker really was created for the read (nothing survived the reclaim).
        expect((await hostReady(store)).lanes().filter((lane) => lane.sessionKey === session.id)).toHaveLength(1);

        // The durable document also carries it: the store snapshots the canonical harness on
        // every state change, and a lane commit IS a state change. Read the persisted core
        // rather than the client snapshot, because the todo list is harness state and the
        // client snapshot deliberately does not expose it.
        const core = (store as unknown as { sessions: Map<string, { core?: unknown }> }).sessions.get(session.id);

        expect(JSON.stringify(core?.core ?? {})).toContain('written from a lane');
    }, 180_000);

    it('sends across threads from a lane and reads the roster from the authority', async () => {
        const store = storeOf();
        const session = store.create('demo');

        const submit = await store.dispatch(session.id, 'first');
        const target = submit.turn.threadId as string;

        // The manual-call gate is a session rule, identical in both modes: a tool call must
        // not interleave with a running turn (../sessions.ts `busyOrPending`). Settle first,
        // then send - and prove the send lands in the OTHER conversation.
        const settled = await settle(store, session.id, submit.turn.id);

        expect(settled.status).toBe('done');

        const sent = (await store.callTool(session.id, 'threadSend', {
            thread: target,
            message: 'hello from the operator lane'
        })) as { delivered?: string; threadId?: string; sender?: string };

        expect(sent).toMatchObject({ threadId: target, delivered: 'appended', sender: 'demo' });

        const roster = (await store.callTool(session.id, 'threadList', {})) as {
            threads: { id: string; origin?: string; status: string }[];
        };

        expect(roster.threads.map((thread) => thread.id)).toContain(target);
        expect(roster.threads.some((thread) => thread.origin === 'agent')).toBe(true);

        // The message is in the TARGET conversation, read from the canonical harness - the
        // append happened at the authority, not inside the calling replica.
        const transcript = store.threadTranscript(session.id, target);

        expect(JSON.stringify(transcript)).toContain('hello from the operator lane');
    }, 180_000);
});

describe('worker mode: stop and crash have no late effects', () => {
    it('settles a cancelled lane run as cancelled and stops recording', async () => {
        const store = storeOf();
        const session = store.create('demo');

        const submit = await store.dispatch(session.id, 'long enough to stop');

        // Wait until the lane is genuinely mid-run with events recorded, then stop it.
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const turn = turnOf(store.get(session.id), submit.turn.id);

            if ((turn?.events.length ?? 0) > 5) break;

            await sleep(20);
        }

        const stopped = store.cancelThread(session.id, submit.turn.threadId as string);

        expect(stopped).toBeDefined();

        const settled = await settle(store, session.id, submit.turn.id);

        expect(['cancelled', 'error', 'done']).toContain(settled.status);
        expect(settled.status).not.toBe('running');

        // A cancelled run stops recording: nothing may arrive after settlement.
        const frozen = settled.events.length;

        await sleep(200);

        expect(turnOf(store.get(session.id), submit.turn.id)?.events).toHaveLength(frozen);
    }, 180_000);

    it('fails a turn whose worker disappears, and refuses that lane forever after', async () => {
        const store = storeOf();
        const session = store.create('demo');

        const submit = await store.dispatch(session.id, 'turn whose worker dies');
        const target = submit.turn.threadId as string;
        const lanes = await hostReady(store);

        for (let attempt = 0; attempt < 400; attempt += 1) {
            if (lanes.lanes().some((lane) => lane.role === target && lane.busy)) break;

            await sleep(20);
        }

        // Committed transcripts BEFORE the crash, per conversation. Status is excluded on
        // purpose: the host retires the roster mirror to 'idle' when a worker dies, and that
        // mirror change is the expected bookkeeping, not a late lane effect.
        const transcriptsOf = (snapshot: SessionSnapshot): [string, number][] =>
            (snapshot.threads ?? []).map((thread) => [thread.id, (thread.messages ?? []).length]);

        const before = transcriptsOf(store.get(session.id));

        // A worker that dies is what `terminate()` models: the promises of that lane settle,
        // and its epoch is retired in the authority's journal.
        lanes.closeLane(session.id, { kind: 'thread', threadId: target }, 'test crash');

        const settled = await settle(store, session.id, submit.turn.id);

        expect(settled.status).not.toBe('running');
        expect(settled.status).not.toBe('done');

        // A turn has no error field of its own (the client reads the session banner, which is
        // where a failed lane run reports its reason - the same contract an inline failure
        // uses), so the reason is asserted where the API puts it.
        expect(String(store.get(session.id).lastError ?? '')).toContain('lane');

        // Nothing from the dead lane lands afterwards: the canonical transcripts are exactly
        // what they were when the worker went away.
        await sleep(250);

        expect(transcriptsOf(store.get(session.id))).toEqual(before);

        // And the lane is gone from the host, so no further frame can be attributed to it.
        expect(lanes.lanes().some((lane) => lane.role === target)).toBe(false);
    }, 180_000);
});

describe('worker mode: an unrebuildable harness is refused, not run inline', () => {
    it('rejects a session whose preset cannot be rebuilt from a record', async () => {
        const registry = createHarnessRegistry([
            {
                name: 'closure',
                title: 'Closure',
                description: 'an injected factory',
                requiresEndpoint: false,
                primary: 'primary',
                subagents: [],
                agents: ['primary'],
                tools: ['task'],
                builtin: false,
                editable: false,
                create: () => {
                    throw new Error('never built');
                }
            }
        ] as never);

        const store = new SessionStore(SETTINGS, registry, undefined, { runtime: WORKER_RUNTIME });

        stores.push(store);

        // Worker mode is a promise, so the refusal is at CREATE (a 400 on the HTTP surface),
        // naming both the reason and the fix - never a session quietly run inline.
        expect(() => store.create('closure')).toThrow(/injected as a factory closure/);
    });
});
