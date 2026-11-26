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
//   T-W8 (2026-11-17)  A LANE FRAME NAMES THE LANE'S PROCESS: every run identity the worker mints
//       carries `HarnessThread.epoch` (../../core/agent-limits.ts `HARNESS_PROCESS_EPOCH`), the
//       worker's OWN — the coordinator records those frames without rewriting them, so a lane and a
//       parent that both end up naming invocation `513` can never be folded into one row
//       (../turn-projector.ts `isEpochBoundary`).
//
//   #6  (stress report, 2026-11-14) A LANE-ARCHIVED RESULT BELONGS TO ITS CONVERSATION: the
//       `result:archive` operation names the conversation the lane writes, so deleting that
//       conversation purges every turn it archived — the rule the inline path always had, and
//       the last case below is the end-to-end proof of the chain.
//   #5  (review, 2026-11-14) A STOPPED LANE RUN KEEPS ITS PARTIAL: the same operation carries the
//       forensic pair `partialContent`/`cancelledAtMessage`, so a child cancelled mid-answer
//       reports what it was streaming on the canonical side too — inline already did, and the seam
//       was the only door left that lost it without a restart.
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
// T-W8: the coordinator's OWN process epoch, asserted ONLY to prove a lane frame never names it
// (../../core/agent-limits.ts `HARNESS_PROCESS_EPOCH`, stamped onto every run identity the runtime
// mints). The value is random by design, so the lane's epoch is pinned by shape + inequality, not
// by a literal.
import { HARNESS_PROCESS_EPOCH } from '../../engine/core/agent-limits';
import type { LaneAuthority } from './lane-authority';
import type { SessionSnapshot, SessionTurn } from '../protocol';
import { SessionStore } from '../sessions';
import type { LaneHost } from './lane-host';
import { startScriptedProvider } from './provider-stub.test-support';

// S9 (still true, now trivially): the pinned entry IS the source module - there is no bundle
// the host could prefer - so every assertion below is about the code under test, loaded by
// the thread through the Vite module runner (./worker-boot.mjs).
const WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));

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
// One archived row, read WHOLE. The shape is `HarnessAgentResultSnapshot` (../../types/index.ts
// :3331): the pair `partialContent`/`cancelledAtMessage` is optional and ABSENT unless the run was
// stopped with something to show, which is exactly the distinction issues 0020/0033 turn on — so
// the reader keeps the optional keys instead of projecting the row down to `content`.
type ArchivedRow = {
    invocationId: string;
    sequence: number;
    completedOrder: number;
    agent: string;
    // The agent's rank letter on the authority scale ('A' highest – 'Z' lowest). This replaces the
    // retired primary/subagent pair: `HarnessAgentResultSnapshot` (../../types/index.ts:4287) names
    // `rank`, and it is part of the archived row's content — `archiveDigestOf` digests it (./lane-commit.ts).
    rank: string;
    kind: string;
    status: string;
    content: string;
    error?: string;
    partialContent?: string;
    cancelledAtMessage?: number;
    threadId?: string;
};

const archivedRecords = (store: SessionStore, sessionId: string): ArchivedRow[] => {
    const authority = (store as unknown as { authorities?: Map<string, LaneAuthority> }).authorities?.get(sessionId);

    if (authority === undefined) throw new Error(`No lane authority exists for session ${sessionId}.`);

    return (authority.harness.snapshot() as unknown as { agentResults?: ArchivedRow[] }).agentResults ?? [];
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

    // T-W8 (2026-11-17) — THE EPOCH IS THE WORKER'S, NEVER THE COORDINATOR'S.
    //
    // `HarnessThread.epoch` (../../core/agent-limits.ts `HARNESS_PROCESS_EPOCH`) is minted once per
    // PROCESS, and a lane is a real `node:worker_threads` worker with its own module registry
    // (./lane-host.ts, ./worker-boot.mjs) — so a lane's run ids carry the LANE's epoch. That is the
    // case the fold cannot decide any other way: a lane and its parent can BOTH mint invocation id
    // `513` for different runs (the lane leases a range, the coordinator counts from 1), and
    // ./turn-projector.ts `isEpochBoundary` is what keeps those runs in separate rows.
    it('names the LANE WORKER process on every frame it records, never the coordinator (T-W8)', async () => {
        const store = storeOf();
        const session = await store.create('general');

        const submit = await store.dispatch(session.id, 'lane epoch turn');
        const turn = await settle(store, session.id, submit.turn.id);

        expect(turn.status).toBe('done');

        // The frames the store recorded, with the identity the WORKER minted: the recorder forwards
        // what the lane streamed (../sessions.ts stamps nothing — it is not a mint site).
        const frames = turn.events as unknown as { type: string; thread?: { id: string; epoch?: string } }[];
        const named = frames.filter((frame) => frame.thread !== undefined);

        // EVERY recorded frame of a lane run carries the identity, and they all name ONE run:
        // invocation `513`, the first id of the range the lane leased (see the note above
        // `archivedRecords` — the coordinator counts from `1`, the lane continues the leased range).
        expect(named).toHaveLength(frames.length);
        expect([...new Set(named.map((frame) => frame.thread?.id))]).toEqual(['513']);

        // The frame sequence that carries identity, in recorded order (the deltas in between are the
        // scripted provider's pacing, which this assertion deliberately does not pin).
        //
        // (T2) `progress` joins this list, and its presence here is the point of the
        // assertion rather than an annoyance: the heartbeat is published through the ONE
        // `emit` gate (../harness.ts:9604), which stamps `thread` exactly like every other
        // frame, so a delegated lane's tool composition carries the SAME invocation identity
        // as its text and its calls — the `named.length === frames.length` pin above is what
        // proves it, and it holds only because no frame in a lane run is identity-less. It is
        // recorded between the text deltas and the `tool_call` because that is when the model
        // was composing the call.
        expect([...new Set(named.map((frame) => frame.type))]).toEqual([
            'start',
            'text',
            'progress',
            'tool_call',
            'attempt_commit',
            'tool_result',
            'done'
        ]);

        const epochs = named.map((frame) => frame.thread?.epoch);

        // One epoch for the whole turn (one worker is one process), in the mint's own format, and
        // NOT this process's — the coordinator reads the lane's frames without rewriting them, so a
        // lane run and a coordinator run that share an id can never share a row.
        expect([...new Set(epochs)]).toHaveLength(1);
        expect(epochs[0]).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
        expect(epochs[0]).not.toBe(HARNESS_PROCESS_EPOCH);
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

// STRESS REPORT #6, WORKER MODE (2026-11-14) — ONE PURGE RULE, BOTH EXECUTION MODES.
//
// Inline, `purgeThread` (../../harness.ts) drops a conversation's agent-result records by
// matching `record.threadId`. In worker mode the canonical record is written by the AUTHORITY
// from a `result:archive` operation, and that operation carried no conversation at all — so the
// identical delete released an inline conversation's results and kept a lane conversation's,
// and `agentResult` / `agentManage` went on answering for a conversation that had left the
// roster. The lane now names the conversation it writes (./lane-worker-loop.ts
// `deriveOperations`), and this is the end-to-end proof of the whole chain: the worker sends the
// field, the authority stores the join.
//
// IT19 CHANGE (2026-11-15): the rule both modes share is now RETENTION, not purge. A thread
// delete MARKS the conversation, so the archived rows of a lane conversation survive it EXACTLY
// as they survive an inline one, and the join the whole chain exists for — `record.threadId` —
// is what keeps those retained rows addressable.
describe('worker mode: a deleted conversation keeps its lane-archived results (stress report #6)', () => {
    it('retains every lane turn of the conversation, exactly as the inline path does', async () => {
        const store = storeOf();
        const session = await store.create('general');

        const first = await store.dispatch(session.id, 'lane purge one');

        expect((await settle(store, session.id, first.turn.id)).status).toBe('done');

        const threadId = first.turn.threadId as string;
        const second = await store.dispatch(session.id, 'lane purge two', undefined, undefined, threadId);

        expect((await settle(store, session.id, second.turn.id)).status).toBe('done');

        // Two lane turns, two centrally-archived results. A lane-minted identity per turn (one
        // NEW id each turn, NOT the thread id — see the M1/M3 case above), which is exactly why
        // the roster's single invocation slot could never be the purge join on its own.
        const archived = archivedRecords(store, session.id);

        expect(archived).toHaveLength(2);
        expect(archived.map((record) => record.invocationId)).not.toContain(threadId);

        await store.deleteThread(session.id, threadId);

        // The conversation left the roster, and its rows stayed where they were.
        expect(store.get(session.id).threads).toBeUndefined();

        // The scripted provider's answer embeds the live wall clock in the tool payload, so only
        // that half is normalized; everything else below is asserted exactly.
        const withoutClock = (records: ArchivedRow[]) =>
            records.map((record) => ({
                ...record,
                content: record.content.replace(/\{"timezone":.*\}$/, '{"timezone":…}')
            }));

        // Mirrors the scripted provider's stream: one `answer<N>` token per streamed chunk, then
        // the tool result.
        const ANSWER = `${Array.from({ length: 24 }, (_, index) => `answer${index}`).join(' ')} the tool returned {"timezone":…}`;

        // Retention keeps the join: both rows still name the deleted conversation, which is how
        // `agentResult`/`agentManage` reach a resumed conversation's newest answer.
        expect(withoutClock(archivedRecords(store, session.id))).toEqual([
            {
                invocationId: '513',
                sequence: 513,
                completedOrder: 1,
                agent: 'general',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: ANSWER,
                threadId: 'thread-1',
                // W19: a lane-archived row names the ledger generation that minted its invocation id
                // (../types `HarnessAgentResultSnapshot.epoch`), so the row survives a restart that
                // re-mints `513` instead of being overwritten by it.
                epoch: HARNESS_PROCESS_EPOCH
            },
            {
                invocationId: '514',
                sequence: 514,
                completedOrder: 2,
                agent: 'general',
                rank: 'A',
                kind: 'root',
                status: 'completed',
                content: ANSWER,
                threadId: 'thread-1',
                epoch: HARNESS_PROCESS_EPOCH
            }
        ]);
    }, 300_000);
});

// REVIEW FINDING #5 (High) / ISSUES 0020 + 0033 — THE WORKER-MODE LEG.
//
// Inline, a run stopped mid-answer reports the text it was STREAMING: `runAgentCore`'s
// cancellation catch prefers `run.streamedText` over the last committed assistant text
// (../../harness.ts:11927-11938, issue 0020 AC1), `finishInvocation` records the pair on the
// terminal transition (`:3886-3893`), the snapshot projection writes it (`:12810-12813`) and
// `restore()` re-attaches it (`:13175-13180`) — pinned by `src/harness.delegation.test.ts:482`
// and `src/harness.snapshot.test.ts`.
//
// In worker mode the run happens on a lane, and the ONLY way its terminal record reaches the
// canonical harness is the `result:archive` operation (./lane-worker-loop.ts `deriveOperations`).
// That payload carried `content` and `error`, so `archiveInvocation` (../../harness.ts:7288-7299)
// forced `content: ''` for a non-completed status and never learned the partial existed: the
// caller of a cancelled lane child was told the answer was empty — WITH NO RESTART INVOLVED AT
// ALL, because the loss is in the seam, not in the persistence layer.
//
// Both directions are pinned here because they are one rule with two halves: the pair must TRAVEL
// for a stopped run, and it must stay ABSENT beside a completed answer (mutual exclusion —
// `../../core/snapshot.ts:291-298` refuses a completed row that carries it, so a lane that archived
// a stale partial next to a finished answer would archive a row the session cannot reload).
describe('worker mode: a stopped lane run archives its forensic pair (review #5, issues 0020/0033)', () => {
    it('carries partialContent and cancelledAtMessage for a run cancelled mid-stream, and neither for one that completed', async () => {
        const store = storeOf();
        const session = await store.create('general');

        // HALF ONE — the completed turn, measured first so the cancelled row below is the only
        // unfinished one in the archive and the `status` filter cannot match two rows.
        const finished = await store.dispatch(session.id, 'lane turn that completes');

        expect((await settle(store, session.id, finished.turn.id)).status).toBe('done');

        const threadId = finished.turn.threadId as string;
        const completed = archivedRecords(store, session.id);

        expect(completed).toHaveLength(1);
        expect(completed[0].status).toBe('completed');
        // The WHOLE key set, exactly: the answer rides in `content`, and neither forensic key is
        // present. A lane that archived `partialContent` beside a completed answer would produce
        // a row `readAgentResults` refuses to load (../core/snapshot.ts:291-298).
        expect(Object.keys(completed[0]).sort()).toEqual([
            'agent',
            'completedOrder',
            'content',
            // W19 (2026-11-17): the ONE key a lane-archived row gains — a plain, separate
            // ledger-generation stamp (never a composite `id\0epoch` string), and the key that lets a
            // restart keep this row beside the row of a re-minted id. It is not in `archiveDigestOf`,
            // so the lane receipt the stopped lane re-derives is byte-unchanged.
            'epoch',
            'invocationId',
            'kind',
            'rank',
            'sequence',
            'status',
            'threadId'
        ]);

        // HALF TWO — a second turn of the SAME conversation, stopped while its answer is streaming.
        const running = await store.dispatch(session.id, 'lane turn that gets stopped', undefined, undefined, threadId);

        // The precondition, not a guess: the stub streams one `text` delta per 40ms, and the
        // harness buffers a delta into `run.streamedText` BEFORE emitting it
        // (../../harness.ts:11404-11411). So the first `text` event the coordinator has recorded
        // proves the worker is holding non-blank in-flight text at the moment the stop lands —
        // which is the state that must survive the archive seam.
        let streamed = '';

        for (let attempt = 0; attempt < 600 && streamed.length === 0; attempt += 1) {
            const turn = turnOf(store.get(session.id), running.turn.id);

            streamed = turn?.events
                .filter((event) => event.type === 'text')
                .map((event) => (event.type === 'text' ? event.delta : ''))
                .join('') ?? '';

            if (streamed.length === 0) await sleep(20);
        }

        expect(streamed.startsWith('thinking0 ')).toBe(true);

        // The operator's Stop door: `cancel()` aborts this lane's controller
        // (../sessions.ts:8823-8831), and the host turns that abort into the `interrupt` frame
        // (./lane-host.ts:915-923) that stops the run inside the worker.
        expect(await store.cancel(session.id)).toBe(true);

        const stopped = await settle(store, session.id, running.turn.id, 60_000);

        expect(stopped.status).toBe('cancelled');

        const rows = archivedRecords(store, session.id);
        const cancelled = rows.filter((record) => record.status === 'cancelled');

        // One stopped row, and it is the newest turn of this conversation.
        expect(cancelled).toHaveLength(1);
        expect(rows).toHaveLength(2);

        const row = cancelled[0];

        // Mutual exclusion, the other direction: a stopped run keeps `content` EMPTY and carries
        // its text in `partialContent`, exactly as the inline record does.
        expect(row.content).toBe('');
        expect(row.error).toBeTypeOf('string');
        // The partial the caller was already shown before the seam: the words the stub streamed
        // (the first delta is `thinking0 `, then `thinking1 `, ...). Its exact length depends on
        // when the abort lands, so the pin is the deterministic prefix and the absence of anything
        // that is not answer text — the 0020 leak boundary, unchanged.
        expect(row.partialContent?.startsWith('thinking0 ')).toBe(true);
        expect(row.partialContent).not.toContain('the tool returned');
        // The pair travels together: `cancelledAtMessage` counts COMMITTED messages (issue 0022),
        // so for a run stopped inside its first request it is an integer — the exact count is a
        // scheduling fact, its PRESENCE is the contract.
        expect(Number.isInteger(row.cancelledAtMessage)).toBe(true);

        // issue 0032 (2026-11-26) — the fourth forensic member, on the SAME seam and in the same
        // breath, and this run is the ZERO-CALL case: the stub answers in prose and never emits a
        // tool call, so no tally is ever taken. The lane payload has to omit the key rather than
        // send `{ calls: 0, settled: 0, byName: [], truncated: false }` — a zero-shaped tally would
        // arrive in canonical state as a claim about a count that never existed, and the row would
        // then disagree with the inline record of the very same shape (the door above in
        // ./harness.agent-results.test.ts omits it too). Absence is asserted as a KEY check, because
        // `toBeUndefined()` cannot tell an absent key from one written as `undefined`.
        expect(Object.keys(row).includes('toolActivity')).toBe(false);
        expect(row).not.toHaveProperty('toolActivity');

        // And the completed row above stays tally-free for the stronger reason: a lane that archived
        // a tally beside a finished answer produces a row `readAgentResults` REFUSES to load
        // (../core/snapshot.ts, the completed-row rule), so the session would stop restoring.
        expect(completed[0]).not.toHaveProperty('toolActivity');

        // And the row is still the delete-cascade carrier (stress report #6, above).
        expect(row.threadId).toBe(threadId);
    }, 300_000);
});
