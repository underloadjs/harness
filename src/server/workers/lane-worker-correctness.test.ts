// T11 correctness integration: the findings from the independent review (Temp/t10), measured
// against REAL `node:worker_threads` lanes and the canonical session state - not against the
// pure fold. Each test names the finding it exists to disprove.
//
//   M1  an identity space is bounded by the LIVE records, not by the ids a lane leases on every
//       spawn: eight re-spawns of ONE conversation (the normal lifecycle) used to throw on the
//       eighth with zero threads created;
//   M3  a host conversation's invocation id is its thread id, so its second turn must REPLACE
//       its archived result instead of being refused;
//   M4  a message a sibling lane sent into this conversation is canonical state the replica has
//       never seen: length alone dropped the lane's own next turn;
//   M8  host shutdown settles an in-flight turn instead of leaving the caller hanging;
//   M9  `maxLaneWorkers` is enforced, not advertised;
//   S9  these assertions run against the SOURCE worker, never a stale `dist/` bundle.
//
// Cross-references:
//   - ./lane-host.ts            - spawn/reclaim/bound/shutdown (M1 M8 M9)
//   - ./lane-worker-loop.ts     - the delta sync and the per-receipt re-base (M3 M4)
//   - ./lane-authority.ts       - `transcript:sync`, the archive owner rule
//   - ../sessions.ts            - the store under test (dispatch / threadTranscript / callTool)
//   - ../../../Temp/t10/        - the probes that found these defects

import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHarnessRegistry } from '../harnesses';
import { PRODUCTION_WITH_FIXTURES } from '../harnesses/fixture-presets.test-support';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import type { LaneAuthority } from './lane-authority';
import type { SessionSnapshot, SessionTurn } from '../protocol';
import { SessionStore } from '../sessions';
import type { LaneHost } from './lane-host';
import { buildTestWorkerEntry } from './worker-test-build.test-support';
import { startScriptedProvider } from './provider-stub.test-support';

// S9: a `.ts` entry is source mode (./lane-host.ts `resolveEntry`). Without this the host
// prefers `dist/underload-harness.worker.mjs`, and every assertion below would be about a
// bundle built before the fix it is checking.
const SOURCE_WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));

// Source mode needs Node's own TypeScript transform. On a Node build without it, Vite
// builds the CURRENT entry into Temp instead: the tests still run the code under test,
// not the stale `dist/` bundle.
const SOURCE_WORKER_SUPPORTED = (process.features as { typescript?: string | false }).typescript !== false;
const BUILT_TEST_WORKER = SOURCE_WORKER_SUPPORTED ? undefined : await buildTestWorkerEntry(SOURCE_WORKER_ENTRY);
const WORKER_ENTRY = BUILT_TEST_WORKER?.entry ?? SOURCE_WORKER_ENTRY;

const WORKER_RUNTIME: ServerRuntimeConfiguration = {
    ...DEFAULT_RUNTIME_CONFIGURATION,
    threadExecution: 'worker',
    workerEntry: WORKER_ENTRY,
    // Lanes survive a turn here; reclaim is driven explicitly by the tests that need it.
    workerIdleMs: 0,
    maxLaneWorkers: 8,
    workerHandshakeMs: 120_000
};

// WHY A PROVIDER IS NEEDED HERE NOW: a lane rebuilds the session's harness from the preset
// RECORD, which works only for a template-backed factory. The scripted fixture's factory is a
// closure over a stream function and cannot cross `worker_threads`, so the lane suites run a
// LIVE preset (`general`) against a loopback provider that answers like the old script — a tool
// round, then an answer quoting the tool result. See ./provider-stub.test-support.ts for why the
// pacing of that stub is load-bearing rather than cosmetic.
const provider = await startScriptedProvider();

const SETTINGS = { baseURL: `${provider.origin}/v1`, apiKey: '', model: 'stub/model' };

const stores: SessionStore[] = [];

// `general` is a shipped LIVE preset: its durable template record is what a worker rebuilds, so
// every turn below is a real lane turn, and its answer is deterministic because the provider
// above is scripted.
const storeOf = (overrides: Partial<ServerRuntimeConfiguration> = {}): SessionStore => {
    const store = new SessionStore(
        SETTINGS,
        createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never),
        undefined,
        { runtime: { ...WORKER_RUNTIME, ...overrides } }
    );

    stores.push(store);

    return store;
};

afterAll(async () => {
    for (const store of stores) store.dispose();

    await new Promise((resolve) => setTimeout(resolve, 250));

    await provider.close();

    BUILT_TEST_WORKER?.dispose();
});

const hostOf = (store: SessionStore): LaneHost | undefined => (store as unknown as { host?: LaneHost }).host;

// The host is created lazily by the store on the first worker-mode dispatch, so a test that
// needs to CLOSE it waits for the same field the store's shutdown path uses.
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

const settle = async (store: SessionStore, id: string, turnId: string, limitMs = 120_000): Promise<SessionTurn> => {
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

// The canonical transcript of one conversation, read on the COORDINATOR. A lane's own replica is
// never the measuring stick here: the claim under test is what central state contains.
const userTurns = (store: SessionStore, sessionId: string, threadId: string): string[] =>
    store
        .threadTranscript(sessionId, threadId)
        .messages.filter((message) => message.role === 'user')
        .map((message) => String(message.content));

const lastAssistant = (store: SessionStore, sessionId: string, threadId: string): string | undefined => {
    const messages = store.threadTranscript(sessionId, threadId).messages;
    const reversed = [...messages].reverse().find((message) => message.role === 'assistant');

    return reversed === undefined ? undefined : String(reversed.content);
};

// The archived invocations held by the AUTHORITY's canonical harness. The probe
// (Temp/t11/probe-archive.ts) measured what the core actually mints for a host-thread turn:
// inline the results are `1`, `2`, ... and on a lane the same counter continues from the leased
// range (`513`, `514`, ...), i.e. one NEW id per turn - NOT the thread id. What must hold in
// both modes is that every turn's result is centrally addressable, the newest answer wins, and
// the roster names an invocation that exists.
const archivedRecords = (store: SessionStore, sessionId: string): { invocationId: string; content: string }[] => {
    const authority = (store as unknown as { authorities?: Map<string, LaneAuthority> }).authorities?.get(sessionId);

    if (authority === undefined) throw new Error(`No lane authority exists for session ${sessionId}.`);

    return (authority.harness.snapshot() as unknown as { agentResults?: { invocationId: string; content: string }[] }).agentResults ?? [];
};

// The roster's own view of the conversation, read on the coordinator.
const rosterInvocation = (store: SessionStore, sessionId: string, threadId: string): string | undefined => {
    const authority = (store as unknown as { authorities?: Map<string, LaneAuthority> }).authorities?.get(sessionId);

    return authority?.harness.thread(threadId)?.invocationId;
};

// Wait for a conversation the AUTHORITY itself is running to settle.
//
// WHY A WORKER TEST NEEDS THIS AT ALL: `threadSend` into a dormant thread now STARTS a
// turn there (delegate-stress 2026-11-08 T3.2) instead of parking text, and that run is
// fire-and-forget — it has no SessionTurn of its own. While it is live, a focused submit
// into the same conversation takes the server's steer path, and `SessionStore.enqueue`
// refuses it with 409 "Thread is running but no recorded turn owns it"
// (../sessions.ts `steerIntoThread`, the `owningTurnOf` miss). A delegated child escapes
// that because its owner chain names a turn; a top-level thread has no chain. Waiting is
// therefore what an operator would do — and it keeps the M4 claim (a lane re-syncing onto
// canonical state) the thing under test.
const waitAuthorityIdle = async (
    store: SessionStore,
    sessionId: string,
    threadId: string,
    limitMs = 120_000
): Promise<void> => {
    const started = Date.now();

    for (;;) {
        const authority = (store as unknown as { authorities?: Map<string, LaneAuthority> }).authorities?.get(sessionId);

        if (authority?.harness.thread(threadId)?.status !== 'running') return;

        if (Date.now() - started > limitMs) {
            throw new Error(`Thread ${threadId} stayed running for more than ${limitMs}ms.`);
        }

        await sleep(25);
    }
};

describe('worker mode: one conversation across re-spawns (T10 M1/M3/M4)', () => {
    it('runs eight turns of one conversation, reclaiming its lane every time, and centralises all of them', async () => {
        const store = storeOf();
        const session = await store.create('general');

        let threadId: string | undefined;

        for (let cycle = 0; cycle < 8; cycle += 1) {
            const submit = await store.dispatch(session.id, `reclaim cycle ${cycle}`, undefined, undefined, threadId);
            const settled = await settle(store, session.id, submit.turn.id);

            expect(settled.status, `cycle ${cycle}`).toBe('done');

            threadId = submit.turn.threadId as string;

            // The reclaim lifecycle: `workerIdleMs` would do this on a timer in production. Each
            // cycle takes a fresh 32-id thread lease and a fresh 512-id run lease; the retired
            // cap refused the EIGHTH spawn ("The thread identity space holds at most 256 ids")
            // with no thread created at all.
            hostOf(store)?.closeSession(session.id, `reclaim ${cycle}`);
        }

        // Nothing was dropped and nothing was duplicated across eight rebuilt replicas: the
        // transcript holds every prompt, in order, exactly once.
        expect(userTurns(store, session.id, threadId as string)).toEqual([
            'reclaim cycle 0',
            'reclaim cycle 1',
            'reclaim cycle 2',
            'reclaim cycle 3',
            'reclaim cycle 4',
            'reclaim cycle 5',
            'reclaim cycle 6',
            'reclaim cycle 7'
        ]);

        // Every turn of that conversation is centrally addressable: eight terminal results, eight
        // distinct identities, the newest answer last. (Measured truth from
        // Temp/t11/probe-archive.ts: a host-thread turn mints a NEW invocation id each time,
        // inline and on a lane alike, so "one slot per conversation" is not the shape - the
        // shape that matters is that central state has each turn's answer and nothing stale.)
        const archived = archivedRecords(store, session.id);

        expect(archived).toHaveLength(8);
        expect(new Set(archived.map((record) => record.invocationId)).size).toBe(8);
        expect(archived[archived.length - 1].content).toBe(lastAssistant(store, session.id, threadId as string));

        // The roster join: the conversation's `invocationId` names an invocation that EXISTS in
        // the central archive. The retired host mirrored `thread-N` there, which the archive
        // never contained, so `agentResult`/the UI could not resolve the turn it pointed at.
        const roster = rosterInvocation(store, session.id, threadId as string);

        expect(archived.map((record) => record.invocationId)).toContain(roster);
    }, 300_000);

    it('picks up a message another lane sent while this conversation was idle (T10 M4)', async () => {
        const store = storeOf();
        const session = await store.create('general');

        const first = await store.dispatch(session.id, 'first correctness turn');
        const threadId = first.turn.threadId as string;

        expect((await settle(store, session.id, first.turn.id)).status).toBe('done');

        const beforeForeign = userTurns(store, session.id, threadId);

        // A send from the operator lane lands on the COORDINATOR. The lane that runs this
        // conversation next is a replica that never saw it, so its adopted prefix is behind
        // canonical by exactly one message.
        const sent = (await store.callTool(session.id, 'threadSend', {
            thread: threadId,
            message: 'a sibling sent this'
        })) as { delivered?: string };

        // STATE-AWARE delivery (delegate-stress T3.2/T3.6): an idle target is no
        // longer an inert append — the authority STARTS a turn with the message, and
        // the receipt says `started`. Still non-blocking, still routed to the
        // canonical harness (the send is answered at the coordinator, never in this
        // replica), which is what keeps `threadSend` out of the nested-run doors.
        expect(sent?.delivered).toBe('started');

        // `threadSend` records the SENDER inside the delivered text (`from agent "general": ...`),
        // so the sibling entry is matched by its payload; the lane's own prompts are matched
        // exactly. What matters here is that canonical ran ahead of the replica by exactly one
        // USER message while the lane was idle — the answer of the turn that message started
        // (T3.2) is an assistant turn and is not counted here.
        const afterForeign = userTurns(store, session.id, threadId);

        expect(afterForeign).toHaveLength(beforeForeign.length + 1);
        expect(afterForeign[afterForeign.length - 1]).toContain('a sibling sent this');

        // The send started a turn at the authority (T3.2). Let it settle before the
        // focused submit: the server refuses a submit into a conversation that is
        // running with no recorded turn of its own (see `waitAuthorityIdle`), and the
        // M4 claim below is about the LANE re-syncing onto canonical state, which is
        // the same claim whichever order the authority finished in.
        await waitAuthorityIdle(store, session.id, threadId as string);

        const second = await store.dispatch(session.id, 'second correctness turn', undefined, undefined, threadId);

        expect((await settle(store, session.id, second.turn.id)).status).toBe('done');

        // The probe measured the opposite: the host shipped only the canonical LENGTH, so the
        // lane's own next message sat below that base and was skipped - the turn answered and
        // committed NOTHING. Canonical order is preserved too: the foreign message is already
        // in place, and the lane appends after it.
        const afterSecond = userTurns(store, session.id, threadId);

        expect(afterSecond).toHaveLength(beforeForeign.length + 2);
        expect(afterSecond.slice(0, beforeForeign.length)).toEqual(beforeForeign);
        expect(afterSecond[beforeForeign.length]).toContain('a sibling sent this');
        expect(afterSecond[beforeForeign.length + 1]).toBe('second correctness turn');

        // And the conversation's newest answer is the one central state carries, addressed by an
        // invocation the roster can name (T10 M3's roster half).
        const archived = archivedRecords(store, session.id);

        expect(archived[archived.length - 1].content).toBe(lastAssistant(store, session.id, threadId));
        expect(archived.map((record) => record.invocationId)).toContain(rosterInvocation(store, session.id, threadId));
    }, 300_000);

    it('answers a cross-thread read from canonical state the lane never created (T10 S1)', async () => {
        const store = storeOf();
        const session = await store.create('general');

        const submit = await store.dispatch(session.id, 'reader turn');
        const ownThread = submit.turn.threadId as string;

        expect((await settle(store, session.id, submit.turn.id)).status).toBe('done');

        // A SECOND conversation, created after this session's lane replica was built, holding a
        // message its own lane has never seen. A direct handle read on the replica answers
        // "no such thread"; a routed read answers from the canonical harness.
        const other = await store.dispatch(session.id, 'the other conversation');
        const otherThread = other.turn.threadId as string;

        expect((await settle(store, session.id, other.turn.id)).status).toBe('done');

        const read = (await store.callTool(session.id, 'threadRead', { thread: otherThread })) as {
            thread?: { id: string };
            total?: number;
            messages?: { content: string }[];
        };

        expect(read?.thread?.id).toBe(otherThread);
        expect(read?.messages?.some((message) => message.content.includes('the other conversation'))).toBe(true);
        expect((read?.total ?? 0)).toBeGreaterThan(0);

        // The calling lane's own conversation remains readable too (the routed read is only for
        // state this lane does not own).
        const own = (await store.callTool(session.id, 'threadRead', { thread: ownThread })) as { thread?: { id: string } };

        expect(own?.thread?.id).toBe(ownThread);
    }, 300_000);
});

describe('worker mode: the lane worker bound and shutdown (T10 M8/M9)', () => {
    it('never runs more live lane workers than maxLaneWorkers, and the evicted lane still works', async () => {
        const store = storeOf({ maxLaneWorkers: 1 });
        const first = await store.create('general');
        const second = await store.create('general');

        const firstTurn = await store.dispatch(first.id, 'bounded turn one');

        expect((await settle(store, first.id, firstTurn.turn.id)).status).toBe('done');
        expect((hostOf(store)?.lanes() ?? []).filter((lane) => lane.sessionKey === first.id)).toHaveLength(1);

        // The bound: this spawn has to make room. The only lane is idle, so it is reclaimed -
        // safe by construction, because the next turn rebuilds from committed state.
        const secondTurn = await store.dispatch(second.id, 'bounded turn two');

        expect((await settle(store, second.id, secondTurn.turn.id)).status).toBe('done');

        const lanes = hostOf(store)?.lanes() ?? [];

        expect(lanes).toHaveLength(1);
        expect(lanes[0].sessionKey).toBe(second.id);

        // The evicted session's conversation continues on a rebuilt lane, transcript intact.
        const threadId = firstTurn.turn.threadId as string;
        const third = await store.dispatch(first.id, 'bounded turn three', undefined, undefined, threadId);

        expect((await settle(store, first.id, third.turn.id)).status).toBe('done');
        expect(userTurns(store, first.id, threadId)).toEqual(['bounded turn one', 'bounded turn three']);
    }, 300_000);

    it('settles an in-flight turn when the host closes, instead of hanging (T10 M8)', async () => {
        const store = storeOf();
        const session = await store.create('general');

        const submit = await store.dispatch(session.id, 'turn closed mid-flight');

        // Wait until the lane is genuinely mid-run, then shut the host down underneath it.
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const turn = turnOf(store.get(session.id), submit.turn.id);

            if ((turn?.events.length ?? 0) > 2) break;

            await sleep(20);
        }

        const host = await hostReady(store);

        await host.close('test shutdown');

        // The retired close() marked the lane closed and awaited terminate() only, so the
        // promise that was waiting on `turn-done` was never settled and this wait timed out.
        const settled = await settle(store, session.id, submit.turn.id, 15_000);

        expect(settled.status).not.toBe('running');
        expect(['done', 'error', 'cancelled']).toContain(settled.status);
        expect(host.lanes()).toHaveLength(0);
    }, 300_000);
});
