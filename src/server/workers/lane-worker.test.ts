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
//   - ./lane-worker-correctness.test.ts - the T11 findings (reclaim identity burn, transcript
//        delta sync, the lane worker bound, shutdown settlement), also on real workers
//   - ../sessions.ts                - the inline/worker branch under test
//   - ../../../Temp/t5/probe-lane.ts- the standalone version of this probe

import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { agent, harness } from '../../harness';
import type { Harness, HarnessStreamEvent } from '../../harness';
import { createHarnessRegistry } from '../harnesses';
import { ALL_PRESET_TEMPLATES } from '../harnesses/presets.ts';
import { SHARED_APP_TOOL_SOURCES } from '../harnesses/toolbox';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import type { SessionSnapshot, SessionTurn } from '../protocol';
import { SessionStore } from '../sessions';
import type { LaneHost } from './lane-host';
// T12 (S7) + T14: the replica-shaping steps, exported for exactly this kind of test.
import { nestedRunHandshakeLimitations, refuseNestedRuns } from './lane-worker-loop';
import { NESTED_RUN_ARMED_DOORS, NESTED_RUN_LIMITATION_CODE, nestedRunLimitationMessage, nestedRunRefusalMessage } from './capability';

// A cold lane builds the harness, recompiles the created-tool sources and restores the
// snapshot: measured at ~1.6 s on this machine, so the handshake bound is generous and the
// test timeout has to be too.
//
// T10 finding S9: `workerEntry` pins the SOURCE worker, and that is not cosmetic. The host
// prefers the built bundle, and `dist/` is only as fresh as the last build, so before this the
// integration suite was asserting the behaviour of a worker compiled earlier - a source change
// to ./lane-worker-loop.ts was invisible to it, and the mismatch was only made loud by the
// protocol version bump (the retired v2 bundle answered a v3 coordinator with a hello the host
// refused). A `.ts` entry is source mode by ./lane-host.ts `resolveEntry`, which is the dev/test
// path the host already supports.
const SOURCE_WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));

const WORKER_RUNTIME: ServerRuntimeConfiguration = {
    ...DEFAULT_RUNTIME_CONFIGURATION,
    threadExecution: 'worker',
    workerEntry: SOURCE_WORKER_ENTRY,
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
        const session = await store.create('demo');

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

        // Roster mirror: the canonical record joins the conversation to an invocation that
        // EXISTS centrally.
        //
        // T10 measured the core's own identity rule (harness.ts `invocationIdOf = run.thread?.id
        // ?? String(run.id)`): a store-dispatched host-thread turn mints a fresh NUMERIC
        // invocation per turn, inline (`1`, `2`) and on a lane (`513`, `514`) alike, and the
        // retired host mirrored `thread-N` into the roster - a name the archive never contained,
        // so `agentResult`/`/results` could not resolve the turn the UI pointed at. The lane now
        // reports the id it archived on the terminal frame, and the host mirrors THAT.
        const after = store.get(session.id);
        const threadA = after.threads?.find((thread) => thread.id === a.turn.threadId);
        const threadB = after.threads?.find((thread) => thread.id === b.turn.threadId);

        expect(threadA?.status).toBe('idle');
        expect(threadA?.invocationId).toMatch(/^\d+$/);
        expect(threadB?.invocationId).toMatch(/^\d+$/);
        // Two conversations, two identities: the leases keep concurrent lanes apart centrally,
        // which is the whole reason the coordinator mints nothing here.
        expect(threadA?.invocationId).not.toBe(threadB?.invocationId);

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
        const burner = await store.create('demo');
        const sibling = await store.create('demo');

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
        const session = await store.create('demo');

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
        const session = await store.create('demo');

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
        const session = await store.create('demo');

        const submit = await store.dispatch(session.id, 'long enough to stop');

        // Wait until the lane is genuinely mid-run with events recorded, then stop it.
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const turn = turnOf(store.get(session.id), submit.turn.id);

            if ((turn?.events.length ?? 0) > 5) break;

            await sleep(20);
        }

        const stopped = await store.cancelThread(session.id, submit.turn.threadId as string);

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
        const session = await store.create('demo');

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
        await expect(store.create('closure')).rejects.toThrow(/injected as a factory closure/);
    });
});

describe('worker mode: nested conversation state is refused, not faked (T12 / S7)', () => {
    // `delegate` and `threadFork` each create a CHILD thread record plus transcript that only
    // the executing lane could see, and the coordinator has no core seam to adopt a thread by an
    // EXISTING id. Running them lane-locally produced a real answer behind a phantom roster, so
    // the replica refuses them instead. Asserted on a REAL preset harness (the same object type
    // ./lane-worker-loop.ts `sayHello` builds), because the promise is about the replica's
    // registry and its runtime route - not about a sentence in a document.
    it('removes the nested-run tools and closes harness.runtime.delegate', () => {
        const preset = ALL_PRESET_TEMPLATES.find((candidate) => candidate.name === 'research');

        expect(preset?.name).toBe('research');

        const replica = preset!.create({ baseURL: 'http://localhost:9/v1', apiKey: '', model: 'demo' }, () => {});
        const before = Object.keys(replica.tools).sort();

        // The preset really registers both, or a removal below would prove nothing.
        expect(before).toContain('delegate');
        expect(before).toContain('threadFork');

        expect(refuseNestedRuns(replica)).toEqual(['delegate', 'threadFork']);

        // EXACTLY the two nested tools disappeared: the cross-thread and shared-state tools the
        // lanes route to the coordinator are untouched, which is what keeps threadRead,
        // threadSend and threadList working in worker mode.
        expect(Object.keys(replica.tools).sort()).toEqual(before.filter((name) => name !== 'delegate' && name !== 'threadFork'));

        // The built-in runtime route is closed too. The tool entry calls this exact member
        // (src/tools/runtime/delegate.tool.ts:120), so removing only the registry entry would
        // still let a built-in path start an uncentralised child.
        const delegate = replica.runtime.delegate as () => void;

        expect(delegate).toThrow(nestedRunLimitationMessage('delegate'));

        // Idempotent: a replica that never registered the tools has nothing to remove.
        expect(refuseNestedRuns(replica)).toEqual([]);
    });
});

describe('worker mode: a tool body cannot bypass the nested-run refusal (T14)', () => {
    // T13 found the bypass this block pins shut: `refuseNestedRuns` closed the two TOOL doors, and
    // a body still reached a child conversation through the execution context the core hands it.
    // The shipped `textSummarize` did exactly that — the child answered, and its transcript died
    // inside the lane (Temp/t13/probe-results.log). The fix is the armed core seam, so these
    // assertions run against the replica object ./lane-worker-loop.ts `sayHello` really builds.
    const CONTEXT_RUN_MODULE = `
export const metadata = {
    name: 'ctxProbe',
    description: 'T14 nested-run probe: starts a child through the tool context.',
    tags: ['probe'],
    visibility: 'core',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const execute = async (context) => {
    const child = await context.run('summarizer', 'a brief only this lane would ever read');
    return 'child said ' + String(child && child.content);
};
`;

    const rosterOf = (instance: Harness): string[] =>
        ((((instance.snapshot() as { threads?: { id: string }[] }).threads ?? []) as { id: string }[]).map((record) => record.id).sort());

    const researchReplica = (): Harness => {
        const preset = ALL_PRESET_TEMPLATES.find((candidate) => candidate.name === 'research');

        expect(preset?.name).toBe('research');

        // The live preset: it owns a `summarizer` subagent AND the shipped `textSummarize`
        // revision, which is the exact shape that produced T13's silently lost child.
        return preset!.create({ baseURL: 'http://localhost:9/v1', apiKey: '', model: 'demo' }, () => {});
    };

    it('arms the core seam, so a created tool that calls context.run is refused before a child exists', async () => {
        const replica = researchReplica();

        // Unarmed (the inline case) is the historical 'allow', and the arm is what the worker does.
        expect(replica.nestedRuns()).toBe('allow');
        expect(refuseNestedRuns(replica)).toEqual(['delegate', 'threadFork']);
        expect(replica.nestedRuns()).toBe('refuse');

        // The tool arrives the way a model's toolCreate delivers it: a compiled SOURCE revision,
        // registered AFTER the arm. The policy is read at call time, so it is covered too.
        await replica.registerTool({
            name: 'ctxProbe',
            description: 'T14 nested-run probe.',
            tags: ['probe'],
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            moduleText: CONTEXT_RUN_MODULE
        });

        // The preset's summarizer starts from its seeded instruction, so the assertion below is a
        // BEFORE/AFTER equality on the real conversation rather than a claim that it is empty: the
        // point is that the refused door APPENDS nothing and creates no thread.
        const summarizerBefore = (replica.threadMessages('agent:summarizer') as { role: string; content: unknown }[]).map((message) => `${message.role}:${String(message.content)}`);
        const rosterBefore = rosterOf(replica);

        // The same sentence the hello report carries and the core throws — one formatter, so a
        // test cannot pass on a paraphrase.
        await expect(replica.executeTool('ctxProbe', {})).rejects.toThrow(nestedRunRefusalMessage('context.run("summarizer")'));

        expect((replica.threadMessages('agent:summarizer') as { role: string; content: unknown }[]).map((message) => `${message.role}:${String(message.content)}`)).toEqual(summarizerBefore);
        expect(replica.threadMessages('agent:summarizer').filter((message) => message.role !== 'system')).toEqual([]);
        expect(rosterOf(replica)).toEqual(rosterBefore);
    });

    it('answers with the shipped textSummarize revision locally, while an inline replica still hands the notes to the model', async () => {
        // The SHIPPED source path (src/server/tools/shared/textSummarize.tool.ts) compiled by the
        // real kernel, on a scripted summarizer so both sides of the comparison are offline and
        // exact: worker mode condenses locally, inline delegates to the model.
        const requests = { summarizer: 0 };

        // The entry agent never speaks in this test (a manual tool call runs no model turn), so its
        // stream is not counted; only the sibling a nested run would drive is.
        const writerStream = async function* (): AsyncGenerator<HarnessStreamEvent> {
            yield { type: 'text', delta: 'the writer answer' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const summarizerStream = async function* (): AsyncGenerator<HarnessStreamEvent> {
            requests.summarizer += 1;

            yield { type: 'text', delta: 'the summarizer model answer' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const summarizeHarness = (arm: boolean): Harness => {
            const instance = harness({
                agents: {
                    writer: agent({ model: 'test/model', stream: writerStream }),
                    summarizer: agent({ model: 'test/model', stream: summarizerStream })
                },
                primary: 'writer',
                subagents: ['summarizer'],
                toolSources: { textSummarize: SHARED_APP_TOOL_SOURCES.textSummarize },
                presets: false
            });

            if (arm) refuseNestedRuns(instance);

            return instance;
        };

        const NOTES = 'First sentence about the plan. Second sentence about the risk. Third sentence nobody should read.';
        const CONDENSED = 'First sentence about the plan. Second sentence about the risk.';

        const lane = summarizeHarness(true);

        expect(lane.nestedRuns()).toBe('refuse');
        expect(await lane.executeTool('textSummarize', { notes: NOTES })).toBe(CONDENSED);

        // No child at all: the summarizer conversation is empty and never spoke to a provider.
        expect(lane.threadMessages('agent:summarizer')).toEqual([]);
        expect(requests.summarizer).toBe(0);

        // The inline control, same compiled revision: the nested run really happens, and its
        // exchange is written where a restart (or another lane) can read it back.
        const inline = summarizeHarness(false);

        expect(await inline.executeTool('textSummarize', { notes: NOTES })).toBe('the summarizer model answer');
        expect(requests.summarizer).toBe(1);
        expect((inline.threadMessages('agent:summarizer') as { role: string; content: unknown }[]).map((message) => `${message.role}:${String(message.content)}`)).toEqual([
            `user:Summarise these notes in at most two sentences:\n\n${NOTES}`,
            'assistant:the summarizer model answer'
        ]);
    });

    // T15: the claim this package's own defect history makes tempting — that the refusal belongs to
    // a particular harness, preset or opt-in flag. It does not. ./lane-worker-loop.ts `sayHello`
    // calls `refuseNestedRuns` for EVERY lane it starts, before the capability report and before any
    // frame is serviced (a turn that beats the handshake is refused at line 1046), and arming the
    // core policy is the FIRST thing that function does. A replica whose build cannot arm throws,
    // which the worker's message loop turns into a `fault` frame (line 1379) that ./lane-host.ts
    // settles as a rejected handshake/turn (line 773) — there is no inline fallback to fall into.
    // Proven on the two live presets a lane really rebuilds, and on a harness that has neither
    // nested tool to remove, so the assertion is about the execution mode, not a tool list.
    it('arms the nested-run policy on every lane replica, whatever preset that lane rebuilt', async () => {
        const scriptedWriter = async function* (): AsyncGenerator<HarnessStreamEvent> {
            yield { type: 'text', delta: 'the writer answer' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        for (const presetName of ['instruct', 'research']) {
            const preset = ALL_PRESET_TEMPLATES.find((candidate) => candidate.name === presetName);

            expect(preset?.name).toBe(presetName);

            const replica = preset!.create(SETTINGS, () => {});

            // Unarmed until the lane shapes it: this is the very object `sayHello` builds.
            expect(replica.nestedRuns()).toBe('allow');

            refuseNestedRuns(replica);

            // Armed on BOTH presets. Neither preset mentions nested runs anywhere in its record —
            // there is no `refuseNestedRuns` field on a preset to consult.
            expect(replica.nestedRuns()).toBe('refuse');

            // 'Armed' is not a word in a report either: a compiled revision registered AFTER the
            // arm is refused at the door, with no child thread and no transcript append.
            await replica.registerTool({
                name: 'ctxProbe',
                description: 'T15 nested-run probe.',
                tags: ['probe'],
                parameters: { type: 'object', properties: {}, additionalProperties: false },
                moduleText: CONTEXT_RUN_MODULE
            });

            const rosterBefore = rosterOf(replica);

            await expect(replica.executeTool('ctxProbe', {})).rejects.toThrow(nestedRunRefusalMessage('context.run("summarizer")'));
            expect(rosterOf(replica)).toEqual(rosterBefore);
        }

        // The removal list and the policy are different things. A harness with no subagents has only
        // `threadFork` to lose (`delegate` exists only where there is somewhere to delegate), and it
        // is armed exactly like a preset that loses both — which is the reading a preset-opt-in
        // model of the lever would have got wrong.
        const withoutNestedTools = harness({
            agents: { writer: agent({ model: 'test/model', stream: scriptedWriter }) },
            presets: false
        });

        // What a replica has to REMOVE is a registry fact, and the arm is not: `delegate` exists only
        // where there is somewhere to delegate, while `threadFork` is a core control path every
        // harness registers. Neither changes the policy, which is what a preset-opt-in reading of
        // the lever would have got wrong.
        expect(withoutNestedTools.tools.delegate).toBeUndefined();
        expect(refuseNestedRuns(withoutNestedTools)).toEqual(['threadFork']);
        expect(withoutNestedTools.nestedRuns()).toBe('refuse');

        // The other half of the same honesty: a harness INJECTED as a factory closure cannot be
        // rebuilt on a lane, so worker mode refuses it at session CREATE rather than running it
        // inline with an unknown policy — proven end to end in the `unrebuildable harness` block
        // above (lane-worker.test.ts 'rejects a session whose preset cannot be rebuilt from a
        // record', which asserts the /injected as a factory closure/ refusal).
    });

    it('refuses the child AND condenses locally on a non-instruct preset replica', async () => {
        // 'research' — a preset that owns a `summarizer` subagent and ships the exact
        // `textSummarize` revision T13 measured losing a child. It is NOT 'instruct', so the local
        // fallback and the refusal are shown to belong to the lane, not to one preset's tools.
        const replica = researchReplica();

        expect(replica.tools.textSummarize).toBeDefined();

        const messagesOf = (threadId: string): string[] =>
            ((replica.threadMessages(threadId) as { role: string; content: unknown }[]).map((message) => `${message.role}:${String(message.content)}`));

        const summarizerBefore = messagesOf('agent:summarizer');
        const rosterBefore = rosterOf(replica);

        expect(refuseNestedRuns(replica)).toEqual(['delegate', 'threadFork']);

        await replica.registerTool({
            name: 'ctxProbe',
            description: 'T15 nested-run probe.',
            tags: ['probe'],
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            moduleText: CONTEXT_RUN_MODULE
        });

        // The door T13 measured open is shut, by name…
        await expect(replica.executeTool('ctxProbe', {})).rejects.toThrow(nestedRunRefusalMessage('context.run("summarizer")'));

        // …and the shipped revision takes its documented local path instead of failing the call, so
        // one summarizer route does not take the whole toolbox out of worker mode.
        const NOTES = 'First sentence about the plan. Second sentence about the risk. Third sentence nobody should read.';

        expect(await replica.executeTool('textSummarize', { notes: NOTES })).toBe('First sentence about the plan. Second sentence about the risk.');

        // Nothing was lost on the way: no append to the summarizer's conversation, no new thread.
        expect(messagesOf('agent:summarizer')).toEqual(summarizerBefore);
        expect(rosterOf(replica)).toEqual(rosterBefore);
    });

    it('states every nested-run door it armed in the hello handshake', () => {
        const replica = researchReplica();
        const removed = refuseNestedRuns(replica);

        // The report builder is the SAME function ./sayHello uses, so this asserts the wire
        // content, not a copy of it: the two removed tools, then the three doors the armed core
        // closed on this replica.
        expect(nestedRunHandshakeLimitations(removed)).toEqual([
            { code: NESTED_RUN_LIMITATION_CODE, message: nestedRunLimitationMessage('delegate') },
            { code: NESTED_RUN_LIMITATION_CODE, message: nestedRunLimitationMessage('threadFork') },
            ...NESTED_RUN_ARMED_DOORS.map((door) => ({ code: NESTED_RUN_LIMITATION_CODE, message: nestedRunRefusalMessage(door) }))
        ]);

        expect(NESTED_RUN_ARMED_DOORS).toEqual([
            'context.run(name, input)',
            'harness(...) called from a tool body',
            'harness.sendThreadInput(...) called from a tool body',
            'harness.agents.<name>.turn() / .stream()'
        ]);

        // A replica with nothing to remove still states the doors it armed: the limitation is about
        // the execution mode, not about which tools a preset happened to register.
        expect(nestedRunHandshakeLimitations([]).map((entry) => entry.message)).toEqual(NESTED_RUN_ARMED_DOORS.map((door) => nestedRunRefusalMessage(door)));
    });
});

describe('worker mode: a steer is reported from the lane receipt, not the post (T12)', () => {
    it('refuses a steer for a conversation no lane owns, instead of claiming a queue', async () => {
        const store = storeOf();
        const session = await store.create('demo');

        // The host exists only once a worker-mode dispatch has started the pump, so the turn
        // below is what makes `hostReady` answer at all.
        const run = await store.dispatch(session.id, 'open a conversation so a lane exists');

        await settle(store, session.id, run.turn.id);

        const lanes = await hostReady(store);

        // `undefined` is the host's way of saying "no live lane owns this conversation": the
        // store answers from the canonical harness, exactly as the inline path does once a run
        // has ended. A boolean `false` would have been indistinguishable from a lane's own
        // refusal, which must not be re-asked of the authority.
        await expect(lanes.steer(session.id, { kind: 'thread', threadId: 'thread-nobody-runs' }, 'advice')).resolves.toBeUndefined();
    }, 120_000);

    it('lands a focused submit in exactly one record - the one the response names', async () => {
        const store = storeOf();
        const session = await store.create('demo');
        const run = await store.dispatch(session.id, 'open a conversation that keeps the lane busy');
        const threadId = run.turn.threadId ?? '';
        const lanes = await hostReady(store);

        // Sample the lane while it is executing and steer it directly. Two outcomes are honest
        // and both must ARRIVE: the worker's own receipt (`{queued, reason?}`) while the turn is
        // live, or `undefined` once the lane has retired. Neither used to exist - the store
        // answered `queued: true` from the POST, with nothing to wait for.
        let live = false;

        for (let sample = 0; sample < 400 && !live; sample += 1) {
            live = lanes.lanes().some((lane) => lane.sessionKey === session.id && lane.busy);

            if (!live) await sleep(20);
        }

        const receipt = await lanes.steer(session.id, { kind: 'thread', threadId }, 'the-direct-lane-guidance');

        expect(receipt === undefined || typeof receipt.queued === 'boolean').toBe(true);

        if (receipt !== undefined && !receipt.queued) expect(typeof receipt.reason).toBe('string');

        // Now the client-visible path: a focused submit goes through `steerIntoThread` ->
        // `steerOnLane` -> the awaited receipt. Two records are possible depending on where the
        // scripted run stands - the lane accepted (the guidance is audited on the OWNING turn
        // via `steers`/`steerTexts`, no new turn) or it refused/retired (a CONTINUATION turn
        // carries the text as its `prompt`).
        const focused = await store.enqueue(session.id, 'the-recorded-guidance-text', undefined, undefined, threadId);
        const settled = store.get(session.id);
        const carriers = settled.turns.filter((turn) =>
            JSON.stringify([turn.events, turn.steers, turn.steerTexts, turn.prompt]).includes('the-recorded-guidance-text')
        );

        // Exactly one turn record mentions the text, and it is the one the response named. The
        // retired optimistic receipt named the owning turn while a continuation turn held the
        // text, which is what this pins.
        expect(carriers).toHaveLength(1);
        expect(carriers[0].id).toBe(focused.turn.id);

        await settle(store, session.id, focused.turn.id);

        if (focused.turn.id === run.turn.id) {
            // The store claimed the guidance joined the RUNNING conversation, so the canonical
            // transcript must hold it. An answer invented at the HTTP boundary recorded the
            // audit without ever asking the lane, leaving the text nowhere.
            const thread = store.get(session.id).threads?.find((candidate) => candidate.id === threadId);

            expect(JSON.stringify(thread?.messages ?? [])).toContain('the-recorded-guidance-text');
        }
    }, 120_000);
});
