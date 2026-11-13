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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, harness } from '../../harness';
import type { Harness, HarnessMessage, HarnessStreamEvent } from '../../harness';
import { createHarnessRegistry } from '../harnesses';
// The built-in task collection SPEC, which a persisted collection block carries beside its
// entries (Decision M) — so the expectation below names it instead of spelling it out.
import { TASKS_COLLECTION } from '../../core';
import { PRODUCTION_WITH_FIXTURES } from '../harnesses/fixture-presets.test-support';
import { SHARED_APP_TOOL_SOURCES } from '../harnesses/toolbox';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import type { SessionSnapshot, SessionTurn } from '../protocol';
import { SessionStore } from '../sessions';
import type { LaneHost } from './lane-host';
// T12 (S7) + T14: the replica-shaping steps, exported for exactly this kind of test.
// `installAuthorityRuntime` is the classification gate itself: the loop that refuses a
// runtime member nobody routed or declared local (records-engine T1).
import { installAuthorityRuntime, nestedRunHandshakeLimitations, refuseNestedRuns } from './lane-worker-loop';
// T4.1: the worker's OWN op derivation, exported for the same reason — it is the one piece of the
// lane that can be pinned without spawning a thread, and it reads the replica through a structural
// view (`ReplicaReadView`) precisely so a test can hand it one.
import { committedDigestOf, deriveOperations } from './lane-worker-loop';
import type { LaneWorkerState, ReplicaReadView } from './lane-worker-loop';
// The projection BOTH sides of the archive seam digest. The cases below gate a derived op on it, so
// the expectation names the writer's own rule (./lane-commit.ts) instead of trusting the receipt.
import { archiveDigestOf } from './lane-commit';
import type { HarnessAgentResultSnapshot } from '../../types';
import { digestMemoryValue } from './lane-memory';
import type { LaneAuthority } from './lane-authority';
import { HarnessPersistence } from '../persistence';
import {
    AUTHORITY_RUNTIME_METHODS,
    LOCAL_RUNTIME_METHODS,
    NESTED_RUN_ARMED_DOORS,
    NESTED_RUN_LIMITATION_CODE,
    ROUTED_RUNTIME_METHODS,
    nestedRunLimitationMessage,
    nestedRunRefusalMessage
} from './capability';
import { startScriptedProvider } from './provider-stub.test-support';
import { harnessRunnerServerStarted } from './worker-runner';

// A cold lane builds the harness, recompiles the created-tool sources and restores the
// snapshot: measured at ~1.6 s on this machine, so the handshake bound is generous and the
// test timeout has to be too.
//
// T10 finding S9: `workerEntry` pins the worker module by path, and that is not cosmetic. The
// entry IS the source (`./lane-worker.ts`), loaded through the Vite module runner
// (./worker-boot.mjs), so the suite always asserts the behaviour of the code under test -
// there is no bundle that could be staler than the sources.
const WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));

const WORKER_RUNTIME: ServerRuntimeConfiguration = {
    ...DEFAULT_RUNTIME_CONFIGURATION,
    threadExecution: 'worker',
    workerEntry: WORKER_ENTRY,
    // 0 keeps a lane alive for the whole test, so a second tool call does not pay a second
    // cold start (reclaim is exercised separately in ./lane-host tests).
    workerIdleMs: 0,
    maxLaneWorkers: 8,
    workerHandshakeMs: 120_000
};

// WHY A PROVIDER IS NEEDED HERE NOW: a lane rebuilds the session's harness from the preset
// RECORD, which works only for a template-backed factory. The scripted fixture's factory is a
// closure over a stream function and cannot cross `worker_threads`, so this suite runs a LIVE
// preset (`general`) against a loopback provider that answers like the old script — a tool
// round, then an answer quoting the tool result. See ./provider-stub.test-support.ts for why the
// pacing of that stub is load-bearing rather than cosmetic.
const provider = await startScriptedProvider();

const SETTINGS = { baseURL: `${provider.origin}/v1`, apiKey: '', model: 'stub/model' };

const stores: SessionStore[] = [];

// A durable root for the T4.1 restart case, under the repo's `Temp/` — the same convention
// ../persistence.test.ts uses (`tempRoot`), so a crashed run leaves an inspectable document rather
// than a directory in the OS temp that nobody can find afterwards.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TEMP_ROOT = path.join(path.resolve(PACKAGE_ROOT, '../../..'), 'Temp');
const roots: string[] = [];

const tempRoot = (label: string): string => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });

    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-lane-${label}-`));

    roots.push(root);

    return root;
};

const storeOf = (): SessionStore => {
    // `general` is a shipped LIVE preset: its durable template record is what a worker rebuilds
    // (`presetFromRecord`), which is the whole point of the capability gate. The turns below are
    // deterministic because the provider above is scripted.
    const store = new SessionStore(
        SETTINGS,
        createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never),
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

    await provider.close();

    // The T4.1 durable roots are disposable once the stores that wrote them are closed.
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
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

// How many frames a turn has recorded so far, read through the same client snapshot `settle`
// polls. A frame only reaches this process on the host relay FROM a lane, so "more than zero"
// is the cheap, load-free proof that a lane is mid-run — which is what the warm-up gates below
// wait on before any lag is sampled (see the two concurrency tests).
const framesOf = (store: SessionStore, id: string, turnId: string): number =>
    turnOf(store.get(id), turnId)?.events.length ?? 0;

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
        const session = await store.create('general');

        // THE COLD-START SAMPLER (`boot`) IS ARMED BEFORE THE FIRST DISPATCH, i.e. before any of
        // the lane work can start, so the boot window stays sampled rather than going dark: worker
        // spawn, `environment.init()` and the shared parent Vite server (./worker-runner.ts:74-129,
        // :159-171) all do real CPU work in THIS process, plus one transform per module answered
        // through `environment.fetchModule`. That work legitimately blocks the loop, so it is
        // measured against its own generous bound (`bootWorst` below) instead of the 150 ms
        // steady-state bar - which is the only part of the run R1's promise is actually about.
        const boot = sampleLag();

        const a = await store.dispatch(session.id, 'what time is it?');
        const b = await store.dispatch(session.id, 'and once more');

        expect(a.turn.threadId).toBeDefined();
        expect(b.turn.threadId).toBeDefined();
        expect(a.turn.threadId).not.toBe(b.turn.threadId);

        // `startedAt` stays where the wall-clock bound wants it - both turns accepted - so
        // `elapsed` below still prices the WHOLE concurrent window, cold starts included. Only the
        // responsiveness sampler moved (see the warm-up gate).
        const startedAt = Date.now();

        // Observe the overlap directly rather than timing the wall clock: both lanes must be
        // reported busy by the host at the same instant, which is only possible if two workers
        // are executing. A serial execution would never show two busy lanes.
        //
        // The watch now runs for as long as an overlap is POSSIBLE - host exists until both turns
        // settle - instead of a fixed 400-sample budget. `busy` is only set once a lane's
        // handshake lands (./lane-host.ts:869-886 sets it AFTER `await lane.ready`), so on a
        // starved machine two cold boots outlast any fixed budget: at load 44 the old budget
        // expired at 9.6 s with neither lane ever reported busy while both turns then settled
        // together at 13.0 s, i.e. they did run concurrently and the watch had merely stopped
        // early. The predicate is untouched; only the arbitrary budget was replaced by the end of
        // the run, which makes the observation strictly longer and therefore stronger.
        let overlapped = false;
        let turnsSettled = false;
        const lanes = await hostReady(store);

        const watching = (async (): Promise<void> => {
            // 5000 x 20 ms is a HANG GUARD, not a measurement window: `settle` is itself bounded
            // at 90 s and the test at 180 s, and `turnsSettled` releases this loop the instant an
            // overlap can no longer happen.
            for (let sample = 0; sample < 5000 && !overlapped && !turnsSettled; sample += 1) {
                const live = lanes.lanes().filter((lane) => lane.sessionKey === session.id);

                if (live.length >= 2 && live.every((lane) => lane.busy)) overlapped = true;

                await sleep(20);
            }
        })();

        // WARM-UP GATE - the same move the sibling `burns CPU on one lane` test already makes at
        // :427-439 (comment there: "so what is measured afterwards is a running conversation, not
        // a cold start"). Both lanes are spawned and each conversation has recorded its FIRST
        // frame before the strict sampler is armed. Without this, the sampler's window contains
        // the cold lane boot (~1.6 s of real coordinator CPU per lane, :71-73) and the assertion
        // measures module loading under turbo contention instead of the coordinator's freedom
        // while lanes work: it failed at 179 ms and 206 ms for exactly that reason.
        //
        // The bound is 2000 samples - >= 40 s of wall clock even once `sleep(20)` drifts under
        // load - so the loop can only end early because the frames arrived. A cold boot measured
        // at 9.7 s on a 3x-oversubscribed machine would have expired the old 500-sample bound, and
        // expiring is not "the lane never started": that is what the exact assertions below decide.
        for (let attempt = 0; attempt < 2000; attempt += 1) {
            if (framesOf(store, session.id, a.turn.id) > 0 && framesOf(store, session.id, b.turn.id) > 0) break;

            await sleep(20);
        }

        const warmA = framesOf(store, session.id, a.turn.id);
        const warmB = framesOf(store, session.id, b.turn.id);

        // The gate really was satisfied: two lanes are mid-run and streaming, so the window below
        // is steady-state work. A zero here means a lane never started, which invalidates every
        // measurement in this test and is therefore a failure, not a skip.
        expect(warmA).toBeGreaterThan(0);
        expect(warmB).toBeGreaterThan(0);

        const bootWorst = boot.stop();

        // Cold-start bound: 1000 ms. Justification - the worst inter-tick gap this window has ever
        // MEASURED here is 366 ms (a full package run) / 292 ms (under `turbo --concurrency=4`),
        // ~5x below this bound, a cold lane's ~1.6 s is spread over many async hops rather than one
        // spin, and the failure mode the requirement forbids is lane work running on THIS loop,
        // which parks it for whole seconds. So the bound survives arbitrary load while staying far
        // tighter than the multi-second stall that would make worker mode a lie.
        expect(bootWorst).toBeLessThan(1000);

        const lag = sampleLag();

        // Settlement starts BEFORE the sampler stops, and its completion is what releases the
        // overlap watch (once both turns have settled, no overlap is possible any more).
        const settling = Promise.all([settle(store, session.id, a.turn.id), settle(store, session.id, b.turn.id)]);

        // Released on EITHER outcome: `.then(f, g)` handles a rejection locally (so it creates no
        // unhandled rejection) and stops the watch from spinning on after a failed settle, while
        // the promise awaited below still carries that failure to the test.
        settling.then(
            () => {
                turnsSettled = true;
            },
            () => {
                turnsSettled = true;
            }
        );

        const [turnA, turnB] = await settling;

        await watching;

        const worst = lag.stop();

        expect(overlapped).toBe(true);

        // The lanes above really ran the TypeScript entry through Vite's module runner:
        // `entry()` names the module the thread imported (a `.ts` file raw Node cannot parse
        // at all), and the shared runner server is created ONLY by ./worker-runner.ts
        // `openHarnessWorkerSession`. A silent fallback to some other loader would leave that
        // flag false while everything else here still passed.
        expect(lanes.entry().path).toBe(WORKER_ENTRY);
        expect(WORKER_ENTRY.endsWith('.ts')).toBe(true);
        expect(harnessRunnerServerStarted()).toBe(true);

        // Both turns ran to completion, and each produced its own recorded event stream:
        // events arrive through the host relay, so a recorded frame is proof the lane ran.
        expect([turnA.status, turnB.status]).toEqual(['done', 'done']);
        expect(turnA.events.length).toBeGreaterThan(0);
        expect(turnB.events.length).toBeGreaterThan(0);

        // Both turns really did work: two stubbed turns each stream a full discovery +
        // tool + answer loop, and the wall clock stayed in the same order as ONE turn plus
        // cold starts (a serial pair would be roughly double).
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(20_000);
        expect(turnA.events.length + turnB.events.length).toBeGreaterThan(20);

        // R1, measured on the STEADY-STATE window only: the sampler ran from the moment BOTH
        // conversations had recorded a frame until BOTH turns settled, so every sample below was
        // taken while two real lanes were the busy parties. The cold-start half of the run is
        // sampled separately above (`bootWorst`), which is why the bar here is still the original
        // 150 ms: the inline path parks this loop for multi-hundred milliseconds on a CPU burn,
        // and steady-state lane work must never do that. Threshold unchanged on purpose - the
        // looseness that used to make this flaky was in the WINDOW, not in the bar.
        expect(worst).toBeLessThan(150);

        // Anti-vacuity guard for the reorder: the steady-state window has to be long enough to
        // mean something. `sampleLag` ticks at 10 ms, so 20 ticks is ~200 ms of sampled steady
        // state; the real number is hundreds, because a stubbed turn streams a full discovery +
        // tool + answer loop for seconds. If this ever drops to ~20 the assertion above is
        // measuring almost nothing and the warm-up gate moved too far.
        expect(lag.ticks()).toBeGreaterThan(20);

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
        const burner = await store.create('general');
        const sibling = await store.create('general');

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
    // One page of the canonical task store, as a routed call answers it. T1 put a
    // content revision, an attribution and a store revision into every answer, and the
    // worker boundary must not lose any of them: the WRITE happens at the authority
    // (../../lane-authority.ts `executeRecords`), so the record a lane receives IS
    // the canonical one.
    type TaskPageShape = {
        tasks?: Array<Record<string, unknown>>;
        counts?: { total: number; completed: number; pending: number };
        page?: { offset: number; limit: number; hasMore: boolean };
        storeRev?: number;
        // R1/T1.1 — the one record a single-record call affected, when there is one.
        entry?: Record<string, unknown>;
    };

    // `updatedAt` (and the change-feed `at`) is the coordinator's wall-clock instant,
    // and THIS process cannot fake the clock across the worker boundary without
    // disturbing the lane handshake. It is therefore read out and named, so every
    // OTHER key of the record and of the persisted block stays an exact assertion.
    const stampOf = (record: Record<string, unknown> | undefined): string => {
        const value = record?.updatedAt;

        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
            throw new Error(`the canonical task record carried no ISO updatedAt: ${JSON.stringify(record)}`);
        }

        return value;
    };

    it('writes a task through one lane and reads it back on a rebuilt lane', async () => {
        const store = storeOf();
        const session = await store.create('general');

        const added = (await store.callTool(session.id, 'tasks', {
            tasks: [{ text: 'written from a lane' }]
        })) as TaskPageShape;

        // The id was minted by the CORE store on the coordinator, and the answer came back
        // through the lane: that is the central mutation the requirement asks for. The T1
        // shape arrives with it - content rev 1, the primary agent as the writer (a manual
        // call carries no conversation), and `storeRev` 1 for the one recorded event.
        expect(added).toEqual({
            tasks: [
                {
                    id: '1',
                    text: 'written from a lane',
                    completed: false,
                    rev: 1,
                    updatedBy: 'general',
                    updatedAt: stampOf(added?.tasks?.[0])
                }
            ],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1,
            // R1/T1.1 — the lane's add affected exactly ONE record, so the coordinator
            // answers through the lane with that record as `entry` too.
            entry: {
                id: '1',
                text: 'written from a lane',
                completed: false,
                rev: 1,
                updatedBy: 'general',
                updatedAt: stampOf(added?.tasks?.[0])
            }
        });

        const stamp = stampOf(added?.tasks?.[0]);

        // Reclaim EVERY worker of this session, then read again: the NEXT call spawns a fresh
        // lane, rebuilt from the authority's committed state, and it must see the record. A
        // replica-local write would have disappeared here - exactly the retired merge's
        // failure mode.
        hostOf(store).closeSession(session.id, 'test reclaim');

        const reread = (await store.callTool(session.id, 'tasks', {})) as TaskPageShape;

        // Byte-identical to the first answer, stamp included: the rebuilt replica re-read
        // the canonical store rather than restamping or re-adding anything.
        //
        // R1/T1.1 adds the ONE per-CALL key: `entry` names the record the ADD affected,
        // and a plain read affects none, so the re-read carries no `entry`. Dropping that
        // one key from the first answer keeps this an exact comparison of everything the
        // STORE holds — record, counts, page and stamp — without hiding a difference.
        const addedPage: TaskPageShape = { ...added };

        delete addedPage.entry;
        expect(reread).toEqual(addedPage);

        // A new worker really was created for the read (nothing survived the reclaim).
        expect((await hostReady(store)).lanes().filter((lane) => lane.sessionKey === session.id)).toHaveLength(1);

        // The durable document also carries it: the store snapshots the canonical harness on
        // every state change, and a lane commit IS a state change. Read the persisted core
        // rather than the client snapshot, because the todo list is harness state and the
        // client snapshot deliberately does not expose it. The whole T1 block is pinned -
        // revision, attribution, `storeRev` and the change feed - because a session that
        // restored only `{ items, nextId }` would silently drop the concurrency contract.
        const core = (
            store as unknown as {
                sessions: Map<string, { core?: { records?: { collections?: Record<string, unknown>; nextId?: number } } }>;
            }
        ).sessions.get(session.id);

        expect(core?.core?.records?.collections?.tasks).toEqual({
            definition: TASKS_COLLECTION,
            items: [
                {
                    id: '1',
                    text: 'written from a lane',
                    completed: false,
                    rev: 1,
                    updatedBy: 'general',
                    updatedAt: stamp
                }
            ],
            storeRev: 1,
            changes: [{ rev: 1, id: '1', op: 'add', by: 'general', at: stamp, itemRev: 1 }]
        });
        // The id counter is the STORE's, not the collection's (F3): one range mints ids
        // for every collection, so it lives beside the map rather than inside it.
        expect(core?.core?.records?.nextId).toBe(2);
    }, 180_000);

    it('sends across threads from a lane and reads the roster from the authority', async () => {
        const store = storeOf();
        const session = await store.create('general');

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

        // STATE-AWARE delivery (delegate-stress T3.2/T3.6): the target had settled,
        // so the send STARTS a turn in it at the authority and reports `started`
        // rather than the old inert `appended`. Routing and non-blocking behaviour are
        // unchanged, which is what keeps `threadSend` an authority-routed operation
        // instead of a nested-run door (./capability.ts).
        expect(sent).toEqual({ threadId: target, delivered: 'started', sender: 'general' });

        const roster = (await store.callTool(session.id, 'threadList', {})) as {
            threads: { id: string; origin?: string; status: string }[];
        };

        expect(roster.threads.map((thread) => thread.id)).toContain(target);
        expect(roster.threads.some((thread) => thread.origin === 'agent')).toBe(true);

        // The message is in the TARGET conversation, read from the canonical harness - the
        // append happened at the authority, not inside the calling replica. Because the send
        // started a turn there (T3.2) without waiting for it, the prompt is committed by that
        // run, so this is one bounded wait for settled canonical state - not a race.
        let transcript = store.threadTranscript(session.id, target);

        for (
            let attempt = 0;
            attempt < 50 && !JSON.stringify(transcript).includes('hello from the operator lane');
            attempt += 1
        ) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            transcript = store.threadTranscript(session.id, target);
        }

        expect(JSON.stringify(transcript)).toContain('hello from the operator lane');
    }, 180_000);
});

describe('worker mode: stop and crash have no late effects', () => {
    it('settles a cancelled lane run as cancelled and stops recording', async () => {
        const store = storeOf();
        const session = await store.create('general');

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
        const session = await store.create('general');

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

describe('worker mode: a stopped conversation resumes IN PLACE', () => {
    // R1 (revised) measured against a REAL lane. Two worker-mode facts make this shape worth
    // pinning, and one of them chooses the setup:
    //
    //   - a lane run that SETTLES mirrors its conversation back to `idle` on the authority
    //     (./lane-host.ts `mirrorThreadStatus`, :905-916), so a stop taken while a run is in
    //     flight is undone by that run's own settlement - `resumeThread` then correctly reports
    //     the conversation `idle` rather than `stopped`. The resumable state in worker mode is
    //     therefore a stop that drops work the lane never started: a queued backlog row.
    //   - reusing the interrupted turn's id on a lane is safe, because the host releases its
    //     slot BY TURN ID at settle (./lane-host.ts:920) and the store's recorder relays into
    //     the same row object the requeue put back on the lane.
    //
    // The session's exclusive gate is what parks the lane: a manual core call takes it in BOTH
    // modes (../sessions.ts `busyOrPending`/:3579), so the submit below stays `queued` and its
    // stop is a pure backlog drop with no run to mirror the status away again.
    it('re-runs the interrupted row on a lane under the SAME turn id, with no second row', async () => {
        const store = storeOf();
        const session = await store.create('general');

        // Hold the gate first (a cold operator lane makes this window comfortably long), then
        // submit: the row is accepted, queued in its own lane, and never starts.
        const gateHeld = store.callTool(session.id, 'tasks', {});
        const submit = await store.dispatch(session.id, 'stop me and resume me');
        const target = submit.turn.threadId as string;

        // PROVE the lane is parked before stopping it (that is what makes this a pure backlog
        // drop with no run to mirror the conversation's status away later). The manual call
        // takes the session's gate synchronously, so the submit stays `queued` behind it.
        await sleep(50);

        expect(turnOf(store.get(session.id), submit.turn.id)?.status).toBe('queued');
        expect(store.get(session.id).queueDepth).toBe(1);

        const stopped = await store.cancelThread(session.id, target);

        // The stop dropped accepted-but-unstarted work (that is what `cancelled` reports), and
        // with no lane run for this conversation the `stopped` state SURVIVES settlement.
        expect(stopped.cancelled).toBe(true);
        await gateHeld;

        const interrupted = await settle(store, session.id, submit.turn.id);

        expect(interrupted.status).toBe('cancelled');
        expect(store.get(session.id).turns).toHaveLength(1);
        expect(store.get(session.id).threads!.find((thread) => thread.id === target)!.status).toBe('stopped');

        const resumed = await store.resumeThread(session.id, target);

        // SAME ROW, `queued`, and still exactly ONE row for this prompt: no continuation record,
        // no duplicate prompt. `startedAt` is cleared for the lane run to restamp it.
        expect(resumed.turn.id).toBe(submit.turn.id);
        expect(resumed.turn.index).toBe(submit.turn.index);
        expect(resumed.turn.threadId).toBe(target);
        expect(resumed.turn.status).toBe('queued');
        expect(resumed.turn.startedAt).toBeUndefined();
        expect(resumed.turn.events).toEqual([]);
        expect(store.get(session.id).turns).toHaveLength(1);

        // The requeued row really runs ON A LANE (role == the conversation), which is the only
        // way this assertion distinguishes worker mode from a silent inline fallback.
        const lanes = await hostReady(store);
        let sawLaneRun = false;

        for (let attempt = 0; attempt < 400 && !sawLaneRun; attempt += 1) {
            sawLaneRun = lanes.lanes().some((lane) => lane.role === target && lane.busy);

            if (!sawLaneRun) await sleep(20);
        }

        expect(sawLaneRun).toBe(true);

        const settled = await settle(store, session.id, submit.turn.id);

        expect(settled.status).toBe('done');

        // ONE answered row, under the id the stop left behind, and the conversation took input
        // again on a lane (the runtime's host-revival path, `sendThreadInput`).
        expect(store.get(session.id).turns).toHaveLength(1);
        expect(store.get(session.id).turns[0]!.id).toBe(submit.turn.id);
        expect(store.get(session.id).turns[0]!.index).toBe(submit.turn.index);
        expect(store.get(session.id).threads!.find((thread) => thread.id === target)!.status).toBe('idle');

        // The resumed attempt is the record now: the row carries a full answer and none of the
        // stop's bookkeeping.
        expect(settled.events.some((event) => event.type === 'error')).toBe(false);
        expect(settled.events.some((event) => event.type === 'done')).toBe(true);
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
        const preset = PRODUCTION_WITH_FIXTURES.find((candidate) => candidate.name === 'research');

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
        const preset = PRODUCTION_WITH_FIXTURES.find((candidate) => candidate.name === 'research');

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
            const preset = PRODUCTION_WITH_FIXTURES.find((candidate) => candidate.name === presetName);

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
        const session = await store.create('general');

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
        const session = await store.create('general');
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

// ---------------------------------------------------------------------------
// T4.1 — the derivation the WORKER owns, pinned where the rule is decided.
//
// `deriveOperations` is exported with a STRUCTURAL read view (`ReplicaReadView`) precisely so this
// rule can be asserted without a provider, a thread, or a mock of either (see the type's own
// comment: "a test or probe can hand over the same three members without a harness"). The real
// threads above prove the frames and the receipts move; this block pins the ONE condition finding
// F6 named — an in-place write to an already-committed entry changes no length, so the append test
// (`transcript.length > committedLength`) was blind to it and the change died with the process.
// ---------------------------------------------------------------------------
describe('worker mode: an IN-PLACE change to the committed prefix is an operation the lane owes (T4.1 / F6)', () => {
    // The smallest conversation that can carry both kinds of in-place write: a question and its
    // answer, already committed, with the addresses the core minted for them.
    const conversation = (): HarnessMessage[] => [
        { role: 'user', content: 'question', messageId: 'msg-1' },
        { role: 'assistant', content: 'answer', messageId: 'msg-2' }
    ];

    const replicaView = (messages: HarnessMessage[]): ReplicaReadView => ({
        threadMessages: () => messages,
        memory: { has: () => false, get: () => undefined },
        snapshot: () => ({})
    });

    // The lane's base at a commit boundary: what its last receipt / last sync ADOPTED, which is
    // exactly the pair the derivation diffs against — the length (T10 M4) and, since T4.1, the
    // content of that same prefix.
    const laneOf = (committedLength: number, committedDigest: string): LaneWorkerState =>
        ({
            epoch: 7,
            targetId: 'thread-1',
            committedLength,
            committedDigest,
            readDigests: {},
            declaredKeys: [],
            archived: new Map(),
            identities: {}
        }) as unknown as LaneWorkerState;

    it('owes NOTHING while the replica matches its base, and a patch the moment a committed flag moves', () => {
        const base = conversation();
        const digest = digestMemoryValue(base);

        // The hot path: nothing changed, so a boundary owes no transcript operation at all. This
        // is the case every tool result crosses, which is why the digest comparison is the only
        // work it may cost (pipeline F8).
        expect(deriveOperations(laneOf(base.length, digest), replicaView(base))).toEqual([]);

        // `setIncluded(entry, false)`: the `included` key appears and the LENGTH does not move —
        // the exact write the retired condition could not see.
        const flagged = [{ ...base[0], included: false }, base[1]];

        expect(deriveOperations(laneOf(base.length, digest), replicaView(flagged))).toEqual([
            {
                kind: 'transcript:patch',
                threadId: 'thread-1',
                expectedLength: 2,
                expects: digest,
                messages: flagged
            }
        ]);

        // And adoption terminates the argument: once the lane has re-based on the content it
        // published, the same replica derives NOTHING again. Without that, a plugin's single
        // decision would be re-pushed at every boundary for the life of the process.
        expect(deriveOperations(laneOf(base.length, digestMemoryValue(flagged)), replicaView(flagged))).toEqual([]);
    });

    it('owes a patch for a TEXT edit as well, and the patch BEFORE the append when the turn also grew', () => {
        const base = conversation();
        const digest = digestMemoryValue(base);

        // `edit(entry, { content })` — the other in-place mutation T3 shipped, same class, same op.
        const edited = [base[0], { ...base[1], content: 'answer, rewritten by the plugin' }];

        expect(deriveOperations(laneOf(base.length, digest), replicaView(edited))).toEqual([
            {
                kind: 'transcript:patch',
                threadId: 'thread-1',
                expectedLength: 2,
                expects: digest,
                messages: edited
            }
        ]);

        // A compactor's real turn: it disabled an older unit AND answered the prompt. Both facts
        // belong to one boundary, and the ORDER matters — the fold applies a group in sequence, so
        // the prefix is rewritten before the new tail is appended at it.
        const grown = [...edited.map((message, index) => (index === 0 ? { ...message, included: false } : message)), {
            role: 'user',
            content: 'the next prompt',
            messageId: 'msg-3'
        }];

        expect(deriveOperations(laneOf(base.length, digest), replicaView(grown)).map((op) => op.kind)).toEqual([
            'transcript:patch',
            'transcript:append'
        ]);

        // An UNPUBLISHED tail edit is not an in-place change at all: the entry still lives below
        // the base, so the append already carries it. Deriving a patch there would double-write.
        const tailEdited = [...base, { role: 'user', content: 'mine, edited before it shipped', messageId: 'msg-3' }];

        expect(deriveOperations(laneOf(base.length, digest), replicaView(tailEdited))).toEqual([
            {
                kind: 'transcript:append',
                threadId: 'thread-1',
                fromLength: 2,
                messages: [tailEdited[2]]
            }
        ]);
    });

    it("adopts the content base as the digest of the prefix it holds, and only that prefix's", () => {
        const base = conversation();

        // The rule `adoptCommittedBase` follows, pinned: the digest of `threadMessages[0..length]`,
        // which is what `transcript:sync` answers at the same length and what the patch CASes with.
        expect(committedDigestOf(replicaView(base), { targetId: 'thread-1', committedLength: 2 })).toBe(digestMemoryValue(base));
        expect(committedDigestOf(replicaView(base), { targetId: 'thread-1', committedLength: 1 })).toBe(digestMemoryValue([base[0]]));

        // A base of ZERO is the digest of an EMPTY transcript, not `ABSENT_DIGEST`: "this
        // conversation has nothing yet" is a state both sides can compare, while "this key never
        // existed" is a memory-axis fact with a different meaning (./lane-memory.ts).
        expect(committedDigestOf(replicaView([]), { targetId: 'thread-1', committedLength: 0 })).toBe(digestMemoryValue([]));
    });
});

// ---------------------------------------------------------------------------
// Review finding #5 / issues 0020 + 0033 (2026-11-14) — the archive op the WORKER derives.
//
// A stopped lane run has always known what it said: `finishInvocation` writes
// `partialContent`/`cancelledAtMessage` on the terminal transition (src/harness.ts:3886-3898) and
// the worker's own snapshot projection carries both. The archive PAYLOAD named neither, so a
// lane-archived cancellation landed as `content: ''` with no partial — issue 0020's "significant
// cancelled child reports no partial content", with no restart involved. These cases pin the writer
// end of that seam on the structural read view (no thread, no provider): the op names the pair, the
// digest skip only skips a row that already holds THAT pair, and a completed record sends neither
// field. The end-to-end version, on a real worker thread and a real session, is in
// ./lane-worker-correctness.test.ts.
// ---------------------------------------------------------------------------
describe('worker mode: the derived archive op carries the forensic pair of a stopped run (review #5)', () => {
    // The terminal row a cancelled lane turn leaves on its own replica.
    const cancelledRow = {
        invocationId: '513',
        sequence: 3,
        completedOrder: 1,
        agent: 'research',
        role: 'subagent',
        kind: 'delegation',
        status: 'cancelled',
        content: '',
        error: 'The run was cancelled.',
        partialContent: 'thinking0 I will read the file',
        cancelledAtMessage: 2,
        threadId: 'thread-1'
    } satisfies HarnessAgentResultSnapshot;

    // The row the SAME lane archived BEFORE the pair crossed the seam: same identity, same status,
    // and no forensics at all. Held separately rather than derived by `delete`, so the two digests
    // below are both written out and a field added to one shape cannot silently appear in the other.
    const archivedEmptyRow = {
        invocationId: '513',
        sequence: 3,
        completedOrder: 1,
        agent: 'research',
        role: 'subagent',
        kind: 'delegation',
        status: 'cancelled',
        content: '',
        error: 'The run was cancelled.',
        threadId: 'thread-1'
    } satisfies HarnessAgentResultSnapshot;

    // The op that row must produce, in full. `threadId` is stated by the lane from its own target
    // (issue 0033/0024's owner rule) and `completedOrder` travels as the replica's local counter,
    // which the authority then re-mints.
    const stoppedOp = {
        kind: 'result:archive',
        invocationId: '513',
        sequence: 3,
        completedOrder: 1,
        agent: 'research',
        role: 'subagent',
        runKind: 'delegation',
        status: 'cancelled',
        content: '',
        error: 'The run was cancelled.',
        partialContent: 'thinking0 I will read the file',
        cancelledAtMessage: 2,
        threadId: 'thread-1'
    };

    const viewWith = (results: HarnessAgentResultSnapshot[]): ReplicaReadView => ({
        threadMessages: () => [],
        memory: { has: () => false, get: () => undefined },
        snapshot: () => ({ agentResults: results })
    });

    // A lane whose transcript base is already adopted (an empty conversation at an empty digest), so
    // the ONLY operation it can owe is the archive, and `archived` is the only state that decides.
    const laneWithArchived = (archived: Array<[string, string]>): LaneWorkerState =>
        ({
            epoch: 7,
            targetId: 'thread-1',
            committedLength: 0,
            committedDigest: digestMemoryValue([]),
            readDigests: {},
            declaredKeys: [],
            archived: new Map(archived),
            identities: {}
        }) as unknown as LaneWorkerState;

    it('names the pair on the op, so canonical state learns what the stopped run said', () => {
        expect(deriveOperations(laneWithArchived([]), viewWith([cancelledRow]))).toEqual([stoppedOp]);
    });

    it('skips a row whose canonical digest already covers that pair, and owes one that does not', () => {
        // The op landed and the receipt digest was adopted: the next boundary owes nothing, which is
        // the idempotence the digest exists to provide.
        expect(deriveOperations(laneWithArchived([['513', archiveDigestOf(cancelledRow)]]), viewWith([cancelledRow]))).toEqual([]);

        // THE REGRESSION THIS FINDING IS ABOUT. While the pair was outside `archiveDigestOf`, the
        // digest of the empty row EQUALLED the digest of the row with the pair, so a lane whose
        // earlier boundary archived `content: ''` skipped the only op that could have carried the
        // forensics — the writer's own skip test suppressed the fix, and no amount of re-deriving
        // would have sent it. A digest that cannot SEE a field cannot gate the write of that field.
        expect(archiveDigestOf(archivedEmptyRow)).not.toBe(archiveDigestOf(cancelledRow));
        expect(deriveOperations(laneWithArchived([['513', archiveDigestOf(archivedEmptyRow)]]), viewWith([cancelledRow]))).toEqual([
            stoppedOp
        ]);
    });

    it('sends neither field for a completed record, which is what keeps the row reloadable', () => {
        // The ordinary path: `finishInvocation` drops the pair on a completed transition, so nothing
        // extra travels, and the archived row stays one ../core/snapshot.ts can read back.
        const completedRow = {
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'research',
            role: 'subagent',
            kind: 'delegation',
            status: 'completed',
            content: 'the finished answer',
            threadId: 'thread-1'
        } satisfies HarnessAgentResultSnapshot;

        expect(deriveOperations(laneWithArchived([]), viewWith([completedRow]))).toEqual([
            {
                kind: 'result:archive',
                invocationId: '513',
                sequence: 3,
                completedOrder: 1,
                agent: 'research',
                role: 'subagent',
                runKind: 'delegation',
                status: 'completed',
                content: 'the finished answer',
                threadId: 'thread-1'
            }
        ]);
    });
});

// ---------------------------------------------------------------------------
// T4.1 / context-inclusion T3 — the durability claim itself, end to end on a REAL session.
//
// What is real here: a real lane worker runs the turn (the block above this one), the commit is
// made by the SESSION's own authority on the lane's OWN epoch under the writer lease that lane
// holds, the canonical transcript is the coordinator's harness, `state.json` is the store's
// document, and the restart is a second store over the same root.
//
// What is simulated, stated plainly: the `transcript:patch` OPERATION is submitted by the test
// rather than by the worker's own commit loop, because a HOST plugin cannot be installed inside a
// replica — a preset factory closure cannot cross `worker_threads`, so a `turn.before` handler
// that calls `setIncluded`/`edit` has no way to run on a lane today (finding F5, and T4.4 owns
// loading plugins there). The derivation that produces this exact op is pinned above, and the
// receipt path that adopts its effect is the same one every append already exercises here.
// ---------------------------------------------------------------------------
describe('worker mode: an in-place lane commit becomes canonical state, is saved, and survives a restart (T4.1)', () => {
    it('lands a flag and a text edit on the authority, writes them to the durable document, and reads them back after a restart', async () => {
        const root = tempRoot('inplace-sync');
        // NOTE the argument order: the THIRD positional is the harness describer (an injected
        // `describeHarness`), and persistence is an OPTION (../sessions.ts
        // `SessionStoreOptions.persistence`) — ../persistence.test.ts uses the same shape.
        const store = new SessionStore(SETTINGS, createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never), undefined, {
            persistence: new HarnessPersistence(root),
            runtime: WORKER_RUNTIME
        });

        stores.push(store);

        const session = await store.create('general');
        const run = await store.dispatch(session.id, 'the turn that will be edited later');
        const turn = await settle(store, session.id, run.turn.id);

        expect(turn.status).toBe('done');

        const threadId = turn.threadId as string;
        // The conversation as the COORDINATOR now holds it — the prefix a lane would have adopted.
        const canonical = store.threadTranscript(session.id, threadId).messages;

        expect(canonical.length).toBeGreaterThan(1);

        const lanes = await hostReady(store);
        const authority = (store as unknown as { authorities?: Map<string, LaneAuthority> }).authorities?.get(session.id);
        const live = lanes.lanes().find((lane) => lane.sessionKey === session.id);

        if (authority === undefined || live === undefined) {
            throw new Error(`No live lane authority for session ${session.id}.`);
        }

        // The write one plugin round produces: the first committed entry disabled (history kept,
        // only hidden — the standing product rule), and the last entry's text rewritten.
        const patched = canonical.map((message, index) => {
            if (index === 0) return { ...message, included: false };
            if (index === canonical.length - 1) return { ...message, content: `${String(message.content)} — edited on the lane` } as HarnessMessage;

            return message;
        });

        const outcome = authority.commit(live.epoch, {
            laneEpoch: live.epoch,
            // One past what this lane's own commits settled: the journal is what orders a lane's
            // groups, and a test that invented a seq would not be exercising the real base.
            seq: authority.journal.appliedThrough(live.epoch) + 1,
            ops: [
                {
                    kind: 'transcript:patch',
                    threadId,
                    expectedLength: canonical.length,
                    expects: digestMemoryValue(canonical),
                    messages: patched
                }
            ]
        });

        // The lane's OWN epoch, the writer lease it holds for this conversation, and the CAS all
        // accepted it. A `not-writer` here would mean the test invented an identity, not that the
        // protocol is broken, so the receipt is named rather than asserted away.
        expect(outcome.receipts[0].rejection).toBeUndefined();
        expect(outcome.complete).toBe(true);

        // 1. THE AUTHORITY's transcript — not the replica's. `included: false` on entry 0, the new
        //    text on the last, and every address preserved exactly where it was.
        expect(store.threadTranscript(session.id, threadId).messages).toEqual(patched);
        expect(store.threadTranscript(session.id, threadId).messages[0].included).toBe(false);

        // 2. The DURABLE plane: the store writes on the `agent_message` notification the same seam
        //    an inline transcript write reports, so the document on disk carries both changes.
        const persisted = new HarnessPersistence(root).load();
        const record = persisted?.sessions.find((entry) => entry.id === session.id);

        expect(record).toBeDefined();
        expect(JSON.stringify((record as { core: unknown }).core)).toContain('"included":false');
        expect(JSON.stringify(record)).toContain('edited on the lane');

        // 3. THE RESTART: a second store over the same root — no plugin, no lane, no memory of the
        //    process that wrote it. This is the sentence src/types/index.ts used to disclaim.
        // 3. THE RESTART: a second store over the same root — no plugin, no lane, no memory of the
        //    process that wrote it. A store does not read its own document by itself (the host
        //    loads and validates it, then hands it in as `options.database`, which is what
        //    ./runtime.ts does on boot), so the restart is spelled the same way here.
        const restarted = new SessionStore(SETTINGS, createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never), undefined, {
            persistence: new HarnessPersistence(root),
            database: new HarnessPersistence(root).load() ?? undefined,
            runtime: WORKER_RUNTIME
        });

        stores.push(restarted);

        const restored = restarted.get(session.id);

        expect(restored).toBeDefined();
        expect(
            restarted
                .threadTranscript(session.id, threadId)
                .messages.map((message) => ({ role: message.role, content: message.content, included: message.included }))
        ).toEqual(
            patched.map((message) => ({ role: message.role, content: message.content, included: message.included }))
        );

        restarted.dispose();
        store.dispose();
    }, 180_000);


});

// ---------------------------------------------------------------------------
// records-engine T1/T7 — the worker-mode half of "shared state has one writer".
//
// The record store IS session state, so in worker mode a wrapper write must be ANSWERED
// BY THE AUTHORITY. Two halves, both cheap to pin and both load-bearing:
//   1. every record surface — the four wrappers plus `records` itself — goes out through
//      `runtime.executeRecords`, and what comes back is the canonical record: the lane
//      replica keeps nothing, which is exactly the failure the retired merge had;
//   2. the classification loop in ./lane-worker-loop.ts is still exhaustive. An
//      unregistered runtime member is a hello-time throw, because a member nobody
//      classified is precisely how a private write would sneak back in.
// ---------------------------------------------------------------------------
describe('worker mode: the record route is the only door (T1/T7)', () => {
    // One persisted collection block, as the coordinator's own document holds it.
    type CanonicalBlock = { items: Array<Record<string, unknown>>; storeRev: number; changes: unknown[] };
    const canonicalStore = (store: SessionStore, sessionId: string) =>
        (
            store as unknown as {
                sessions: Map<
                    string,
                    { core?: { records?: { nextId?: number; collections?: Record<string, CanonicalBlock> } } }
                >;
            }
        ).sessions.get(sessionId)?.core?.records;

    it('writes through every record surface and reads the canonical store back', async () => {
        const store = storeOf();
        const session = await store.create('general');

        const CASES: Array<{ tool: string; parameters: Record<string, unknown>; key: string }> = [
            { tool: 'tasks', parameters: { tasks: [{ text: 'from the plan' }] }, key: 'tasks' },
            {
                tool: 'profiles',
                parameters: { action: 'add', name: 'Elena', description: 'A cartographer.' },
                key: 'profile'
            },
            { tool: 'chapters', parameters: { action: 'add', title: 'Arrival', summary: 'They land.' }, key: 'chapter' },
            { tool: 'locations', parameters: { action: 'add', name: 'Harbour', description: 'A port.' }, key: 'location' },
            // The low-level surface names its own collection: same route, same authority.
            {
                tool: 'records',
                parameters: { collection: 'tasks', entries: [{ text: 'through the engine' }] },
                key: 'entry'
            }
        ];

        for (const { tool: toolName, parameters, key } of CASES) {
            const answer = (await store.callTool(session.id, toolName, parameters)) as Record<string, unknown>;

            // The wrapper's OWN envelope comes back — the authority's answer, with the id
            // the core minted. A receipt for a replica-local write has no such page.
            expect(Object.keys(answer)).toContain(key);
        }

        const canonical = canonicalStore(store, session.id);

        // ONE store with ONE counter (F3): five writes across four collections, numbered
        // 1..5 in call order. A replica-local write would have left this map empty.
        expect(canonical?.nextId).toBe(6);
        expect(Object.keys(canonical?.collections ?? {}).sort()).toEqual(['chapters', 'locations', 'profiles', 'tasks']);
        expect((canonical?.collections.tasks.items ?? []).map((item) => item.id)).toEqual(['1', '5']);
        expect((canonical?.collections.profiles.items ?? []).map((item) => item.id)).toEqual(['2']);
        expect((canonical?.collections.chapters.items ?? []).map((item) => item.id)).toEqual(['3']);
        expect((canonical?.collections.locations.items ?? []).map((item) => item.id)).toEqual(['4']);

        // Attribution is the coordinator's answer too: a manual call carries the session's
        // primary and no conversation, so the record names `general` and carries no thread.
        expect(canonical?.collections.tasks.items[0]).toMatchObject({ updatedBy: 'general' });
        expect('updatedThreadId' in (canonical?.collections.tasks.items[0] ?? {})).toBe(false);
    }, 180_000);

    it('classifies every runtime member a live harness exposes', () => {
        const replica = harness({
            agents: { writer: agent({ model: 'test/model', provider: { baseURL: 'http://provider.test/v1' } }) },
            presets: false
        });
        const unclassified = Object.keys(replica.runtime).filter(
            (key) =>
                !(ROUTED_RUNTIME_METHODS as readonly string[]).includes(key) &&
                !(LOCAL_RUNTIME_METHODS as readonly string[]).includes(key)
        );

        expect(unclassified).toEqual([]);
        // The record door is routed, and it serves all five tools by name (Decision A).
        expect(ROUTED_RUNTIME_METHODS).toContain('executeRecords');
        expect(AUTHORITY_RUNTIME_METHODS.executeRecords).toBe('records | tasks | chapters | profiles | locations');
    });

    it('refuses to install an authority runtime for an unregistered member', () => {
        const replica = harness({
            agents: { writer: agent({ model: 'test/model', provider: { baseURL: 'http://provider.test/v1' } }) },
            presets: false
        });

        // Every live member is classified, so the install itself is the clean case.
        expect(() => installAuthorityRuntime(replica)).not.toThrow();

        // One unclassified member is enough to lose the guarantee: a lane could write to it
        // locally and the coordinator would never see the change, so the build says so at
        // install time instead of running with a private writer.
        (replica.runtime as unknown as Record<string, unknown>).mintRecordLocally = () => undefined;

        expect(() => installAuthorityRuntime(replica)).toThrow(
            'harness.runtime.mintRecordLocally is neither routed to the authority nor declared local, so this build cannot guarantee that shared state has one writer.'
        );
    });
});
