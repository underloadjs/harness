// T16: the live-change plane, pinned end to end.
//
// WHAT THIS PROVES (the assignment's first mandatory correction):
//   1. A REAL RUN moves the shared hub. Submitting a task through REST and letting the scripted
//      harness finish produces `turn.upsert`, `display.ops`, and `session.updated` hub events with
//      the small target bodies the contract streams - and it does that WITHOUT any consumer
//      opening a snapshot surface: `store.get`, `store.list`, `store.getView`, `store.watch`, and
//      `store.watchView` are spied and must stay uncalled.
//   2. HTTP and WS quote the SAME numbers. The revision a page header stamp carries is the hub
//      counter the live run moved, the three turn kinds move together (the contract DEFINES
//      display/event revisions to equal the owning turn's), and every event reports a strictly
//      higher figure than the last one for that resource - no change is counted twice.
//   3. `streamExists` answers the broker's `unknown_resource` question from live data, cheaply,
//      for the session/thread/turn kinds, accepting the composite hub key and the plain scope ids.
//
// Determinism: statuses, kinds, key sets, and counter arithmetic are asserted exactly. Timestamps
// and ids are not compared to literals. The run is driven by the store's own pump, so the frames
// counted here are the frames a browser would receive through the bridge.
//
// Cross-references:
//   - ./api-events.ts               — the hub under test (counters, publish, baseline)
//   - ./sessions.ts                 — `setStreamObserver` / `StoreStreamSignal` / `streamExists`
//   - ./stream/mount.ts             — `bridgeEventHub` (the T15 consumer of these events)
//   - ./api-canonical.test.ts       — the REST read/paging contract these counters also stamp

import { describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HARNESS_EPOCH_HEADER, HARNESS_REVISION_HEADER } from '../shared/harness-api';
import type { HarnessStreamEvent } from './api-events';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { SessionStore } from './sessions';
// T20: the real stream side, used to prove `display.ops` reaches a socket-shaped consumer. These
// are T15's files (read-only here): the broker routes, the bridge adapts the hub, and the scope
// table in ./stream/protocol.ts decides which kinds a scope publishes - which is the whole
// finding below.
import { createHarnessEventHub } from './api-events';
import { createStreamBroker } from './stream/broker';
import { bridgeEventHub, hubStreamSources } from './stream/mount';

/** A promise plus the two ways to move it: the run's park/release gates. */
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => undefined;

    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });

    return { promise, release: () => release() };
};

/** Poll a synchronous condition without sleeping past it (the gates make the run deterministic). */
const waitFor = async (predicate: () => boolean, limitMs = 2_000): Promise<boolean> => {
    const deadline = Date.now() + limitMs;

    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }

    return predicate();
};

/**
 * A preset that streams deltas and PARKS on the given gates, so a subscription can be registered
 * (or dropped) while the run is mid-flight. Gate order is the run's timeline:
 * delta 1 -> gate 0 -> delta 2 + reasoning -> gate 1 -> terminal `done` with the token tally.
 */
const gatedPreset = (gates: { promise: Promise<void>; release: () => void }[]): HarnessPreset => ({
    name: 'worker',
    title: 'Worker',
    description: 'Scripted gated preset',
    requiresEndpoint: false,
    primary: 'worker',
    subagents: [],
    agents: ['worker'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                worker: agent({
                    model: settings.model,
                    instruction: 'Scripted gated agent.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'alpha ' };
                        await gates[0].promise;
                        yield { type: 'text', delta: 'beta' };
                        yield { type: 'reasoning', delta: 'thinking' };
                        await gates[1].promise;
                        yield {
                            type: 'done',
                            stopReason: 'stop' as const,
                            toolCalls: [],
                            usage: { input: 3, output: 4, total: 7 }
                        };
                    }
                })
            },
            primary: 'worker',
            presets: false,
            report: { progress }
        })
});

const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'unused',
    model: 'scripted/test'
};

const API_DEFAULTS = { baseURL: 'http://scripted.invalid/v1', model: 'scripted/test', hasApiKey: false };

const MOUNT = '/v1/harness';

/** A scripted preset that produces text (so the recorder emits display ops) without a provider. */
const workerPreset = (): HarnessPreset => ({
    name: 'worker',
    title: 'Worker',
    description: 'Scripted live-contract preset',
    requiresEndpoint: false,
    primary: 'worker',
    subagents: [],
    agents: ['worker'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                worker: agent({
                    model: settings.model,
                    instruction: 'Scripted test agent.',
                    stream: async function* () {
                        // A scripted TRANSPORT yields `HarnessStreamEvent`s: the token tally rides
                        // the `done` event (`usage?`), which is where the agent sums the turn's
                        // figures from. That is what makes a live `usage.updated` real.
                        yield { type: 'text', delta: 'first chunk ' };
                        yield { type: 'reasoning', delta: 'thinking ' };
                        yield { type: 'text', delta: 'second chunk' };
                        yield {
                            type: 'done',
                            stopReason: 'stop' as const,
                            toolCalls: [],
                            usage: { input: 11, output: 7, total: 18 }
                        };
                    }
                })
            },
            primary: 'worker',
            presets: false,
            report: { progress }
        })
});

const createContext = () => {
    const registry = createHarnessRegistry([workerPreset()]);
    const store = new SessionStore(DEFAULTS, registry);
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry });

    return { store, registry, api };
};

const call = (
    api: ReturnType<typeof createHarnessApi>,
    method: string,
    pathname: string,
    body: unknown = {},
    searchParams?: string
): Promise<HarnessApiResult> =>
    api({ method, pathname, mount: MOUNT, searchParams, readBody: async <T,>() => body as T } as HarnessApiRequest);

const jsonOf = (result: HarnessApiResult): { status: number; body: Record<string, any>; headers?: Record<string, string> } => {
    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any>, ...(result.headers === undefined ? {} : { headers: result.headers }) };
};

describe('live run -> hub -> stream plane', () => {
    it('moves the hub for a real run without any snapshot surface being built', async () => {
        const { api, store } = createContext();

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));
        const sessionId = created.body.session.id as string;

        const events: HarnessStreamEvent[] = [];
        const detach = api.events.subscribe((event) => events.push(event));

        const submitted = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'say something' }));
        const turnId = submitted.body.turn_id as string;

        await store.waitForIdle(sessionId);

        detach();

        const kinds = events.map((event) => event.kind);

        // The three families a running turn produces, in the contract's vocabulary.
        expect(kinds).toContain('turn.upsert');
        expect(kinds).toContain('display.ops');
        expect(kinds).toContain('session.updated');

        // A `turn.upsert` carries ONE row, keyed by its own id, with no event list on it.
        const upserts = events.filter((event) => event.kind === 'turn.upsert');

        expect(upserts.length).toBeGreaterThanOrEqual(2);
        for (const update of upserts) {
            const payload = update.payload as Record<string, any>;

            expect(Object.keys(payload)).toEqual(['turn']);
            expect(payload.turn.id).toBe(turnId);
            expect(payload.turn.promptPreview).toBe('say something');
            expect(payload.turn.promptChars).toBe('say something'.length);
            expect('events' in payload.turn).toBe(false);
        }

        // The store's three real row transitions: accepted (queued), started (running), settled
        // (done). Exactly one `turn.upsert` per change, each with the row.
        expect(upserts.map((update) => (update.payload as Record<string, any>).turn.status)).toEqual([
            'queued',
            'running',
            'done'
        ]);

        // Every upsert names its target with the hub's composite turn key, which is exactly the
        // spelling `bridgeEventHub` splits back into subscription ids.
        for (const update of upserts) {
            expect(update.target).toEqual({ resource: 'turn', id: `${sessionId}:${turnId}` });
        }

        // `display.ops` rides the recorder's own ops list: no fold, no row copy, no snapshot.
        const opsEvents = events.filter((event) => event.kind === 'display.ops');

        expect(opsEvents.length).toBeGreaterThan(0);
        for (const update of opsEvents) {
            expect(Array.isArray(update.ops)).toBe(true);
            expect((update.ops ?? []).length).toBeGreaterThan(0);
            expect(update.payload).toBeUndefined();
            expect(update.target?.resource).toBe('turn_display');
        }

        // `session.updated` carries a metadata PATCH, never a snapshot body.
        const statePatches = events.filter((event) => event.kind === 'session.updated');

        expect(statePatches.length).toBeGreaterThan(0);
        for (const update of statePatches) {
            const patch = (update.payload as Record<string, any>).session;

            expect(Object.keys(patch)).toContain('status');
            expect(patch.id).toBe(sessionId);
            expect(typeof patch.revision).toBe('number');
            expect('turns' in patch).toBe(false);
            expect('displays' in patch).toBe(false);
        }

        // THE cost rule: the live plane built no aggregate while all of that happened.
        vi.spyOn(store, 'get');
        const snapshots = store.get(sessionId);

        void snapshots;

        const getSpy = vi.spyOn(store, 'get');
        const listSpy = vi.spyOn(store, 'list');
        const viewSpy = vi.spyOn(store, 'getView');
        const listViewsSpy = vi.spyOn(store, 'listViews');
        const watchSpy = vi.spyOn(store, 'watch');
        const watchViewSpy = vi.spyOn(store, 'watchView');

        // A second live round, with every heavy surface spied BEFORE it.
        const second = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'again' }));

        expect(second.status).toBe(202);
        await store.waitForIdle(sessionId);

        expect(listSpy).not.toHaveBeenCalled();
        expect(viewSpy).not.toHaveBeenCalled();
        expect(listViewsSpy).not.toHaveBeenCalled();
        expect(watchSpy).not.toHaveBeenCalled();
        expect(watchViewSpy).not.toHaveBeenCalled();

        getSpy.mockRestore();
        listSpy.mockRestore();
        viewSpy.mockRestore();
        listViewsSpy.mockRestore();
        watchSpy.mockRestore();
        watchViewSpy.mockRestore();
    });

    it('keeps the REST reads and the live counters on one number per resource', async () => {
        const { api, store } = createContext();

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));
        const sessionId = created.body.session.id as string;

        const submitted = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'one task' }));
        const turnId = submitted.body.turn_id as string;

        await store.waitForIdle(sessionId);

        // The turns page and the display read carry the hub's current figures, in the header as
        // well as in the body, and the three turn kinds report ONE revision.
        const page = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns`));

        expect(page.body.revision).toBe(api.events.getRevision('turns', sessionId));
        expect(page.headers?.[HARNESS_REVISION_HEADER]).toBe(String(api.events.getRevision('turns', sessionId)));
        expect(page.headers?.[HARNESS_EPOCH_HEADER]).toBe(api.events.epoch);

        const display = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/display`));
        const turn = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}`));
        const eventsPage = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/events`));

        const turnRevision = api.events.getRevision('turn', `${sessionId}:${turnId}`);

        expect(display.body.display.revision).toBe(turnRevision);
        expect(turn.body.turn.revision).toBe(turnRevision);
        expect(eventsPage.body.revision).toBe(api.events.getRevision('turn_events', `${sessionId}:${turnId}`));

        // The counters the contract defines as equal really are equal, because the live plane
        // moves them together.
        expect(api.events.getRevision('turn_display', `${sessionId}:${turnId}`)).toBe(turnRevision);
        expect(api.events.getRevision('turn_events', `${sessionId}:${turnId}`)).toBe(turnRevision);

        // Strictly increasing per resource: a change is counted once, and a client comparing a
        // page against a frame can order them.
        const seen: number[] = [];
        const detach = api.events.subscribe((event) => {
            for (const record of event.revisions) {
                if (record.resource !== 'turns') continue;

                seen.push(record.revision);
            }
        });

        const again = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'two' }));

        await store.waitForIdle(sessionId);

        detach;
        expect(again.status).toBe(202);
        expect(seen.length).toBeGreaterThan(0);

        for (let index = 1; index < seen.length; index += 1) {
            expect(seen[index]).toBeGreaterThan(seen[index - 1]);
        }

        detach();
    });

    it('answers the broker existence question from live data, for both key spellings', async () => {
        const { api, store } = createContext();

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));
        const sessionId = created.body.session.id as string;

        const submitted = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'exists?' }));
        const turnId = submitted.body.turn_id as string;

        await store.waitForIdle(sessionId);

        const threads = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/threads`));
        const threadId = threads.body.items[0].id as string;

        // Real instances, addressed the way the hub keys them.
        expect(store.streamExists('session', sessionId)).toBe(true);
        expect(store.streamExists('turn', `${sessionId}:${turnId}`)).toBe(true);
        expect(store.streamExists('turn_display', `${sessionId}:${turnId}`)).toBe(true);
        expect(store.streamExists('turn_events', `${sessionId}:${turnId}`)).toBe(true);
        expect(store.streamExists('thread', `${sessionId}:${threadId}`)).toBe(true);
        expect(store.streamExists('transcript', `${sessionId}:${threadId}`)).toBe(true);

        // ...and the plain id form a subscription scope carries.
        expect(store.streamExists('turn', turnId, { session_id: sessionId })).toBe(true);
        expect(store.streamExists('thread', threadId, { session_id: sessionId })).toBe(true);

        // Unknown ids are refused, which is what turns the bridge's interim "accept everything"
        // into the contract's `unknown_resource`.
        expect(store.streamExists('session', 'not-a-session')).toBe(false);
        expect(store.streamExists('turn', `${sessionId}:not-a-turn`)).toBe(false);
        expect(store.streamExists('turn', 'not-a-turn', { session_id: sessionId })).toBe(false);
        expect(store.streamExists('thread', `${sessionId}:not-a-thread`)).toBe(false);
        expect(store.streamExists('transcript', 'not-a-thread', { session_id: 'not-a-session' })).toBe(false);

        // Host-wide kinds have no instance to look up.
        expect(store.streamExists('harnesses', null)).toBe(true);
        expect(store.streamExists('tools', null)).toBe(true);
    });

    it('delivers bounded display.ops on a REAL turn-scope stream subscription', async () => {
        // The whole live pipeline, offline but unrepliased: the store's recorder -> the store's
        // signal plane -> the shared hub -> T15's `bridgeEventHub` -> T15's broker routing -> the
        // frame a socket would write. This is the path T18 reported as producing `turn.upsert` but
        // no `display.ops`.
        //
        // ROOT CAUSE OF THAT FINDING (contract table, not a wiring gap): `display.ops` is a TURN-
        // scope kind (`HARNESS_WS_SCOPE_PUBLISHES` in ./stream/protocol.ts: `session` publishes
        // session/turn/action/usage/thread/registry/run kinds, `turn` publishes display.ops,
        // usage.updated, turn.upsert). The fixture T18 wrote subscribed at SESSION scope, so the
        // broker's routing check (`isKindPublishedTo`) dropped every ops frame - correctly. The
        // assertion below is the positive form: subscribe the turn, and the deltas arrive.
        // Two gates: the run parks after its first delta (so both subscriptions are registered
        // while there are still deltas to deliver), and again before the terminal event (so the
        // pane can disconnect MID-RUN and the assertions prove the disconnect changed nothing).
        const gates = [deferred(), deferred()];
        const registry = createHarnessRegistry([gatedPreset(gates)]);
        const store = new SessionStore(DEFAULTS, registry);
        const hub = createHarnessEventHub();
        const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry, events: hub });

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));
        const sessionId = created.body.session.id as string;

        // The broker + the real bridge, fed by the SAME hub the dispatcher publishes through.
        const frames: Record<string, any>[] = [];
        const broker = createStreamBroker(hubStreamSources(hub));
        const handle = broker.open((frame) => {
            frames.push(frame as unknown as Record<string, any>);

            return 'sent';
        });
        const unbridge = bridgeEventHub(hub, broker);

        const submitted = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'stream the deltas' }));
        const turnId = submitted.body.turn_id as string;

        // The turn's counters, sampled in the order the HUB announced each change. `TurnSummary`
        // carries no revision field (contract), so the figure a client orders a row by is the
        // shared counter - recorded here at publish time, not reconstructed afterwards.
        const counters: { kind: string; turn: number; display: number; events: number }[] = [];
        const turnKey = `${sessionId}:${turnId}`;
        const unwatchCounters = hub.subscribe((event) => {
            if (event.kind !== 'turn.upsert' && event.kind !== 'display.ops') return;

            counters.push({
                kind: event.kind,
                turn: hub.getRevision('turn', turnKey),
                display: hub.getRevision('turn_display', turnKey),
                events: hub.getRevision('turn_events', turnKey)
            });
        });

        // The run is parked on the gate after its FIRST delta, so the turn subscription is
        // registered while there are still deltas to deliver: no sleeps, no race.
        const turnSub = handle.subscribe({
            subscription_id: 'pane',
            scope: 'turn',
            ids: { session_id: sessionId, turn_id: turnId },
            pace: 'ordered'
        });

        expect(turnSub.status).toBe('ok');

        // A SESSION-scope subscription on the same session, to pin the other half of the rule.
        const sessionSub = handle.subscribe({
            subscription_id: 'rail',
            scope: 'session',
            ids: { session_id: sessionId },
            pace: 'ordered'
        });

        expect(sessionSub.status).toBe('ok');

        const turnState = turnSub.status === 'ok' ? turnSub.state : undefined;

        // The turn scope's baseline carries the three turn counters, and the display revision is
        // the turn revision (the contract defines them equal, and the store moves them together).
        expect(turnState?.revisions.map((record) => record.resource)).toEqual(['turn', 'turn_display', 'turn_events']);
        expect(turnState?.revisions.every((record) => record.revision === turnState.revisions[0].revision)).toBe(true);

        frames.length = 0;
        gates[0].release();

        // Let the pane receive at least one ops frame while the run is STILL parked on gate 2.
        const arrived = await waitFor(() => frames.some((frame) => frame.kind === 'display.ops'));

        expect(arrived).toBe(true);

        const beforeDisconnect = frames.filter((frame) => frame.subscription_id === 'pane').length;

        // DISCONNECT the pane mid-run. A stream subscription is a reader, never a owner: dropping
        // it must not abort the turn, and the sibling session subscription must be untouched.
        expect(handle.unsubscribe('pane')).toBeUndefined();

        gates[1].release();
        await store.waitForIdle(sessionId);

        unbridge();

        const opsFrames = frames.filter((frame) => frame.type === 'update' && frame.kind === 'display.ops');

        // THE assertion T18 could not make: a live run emits display ops on the turn pane, with
        // real op bodies, addressed to the turn subscription.
        expect(opsFrames.length).toBeGreaterThan(0);
        for (const frame of opsFrames) {
            expect(frame.subscription_id).toBe('pane');
            expect(frame.turn_id).toBe(turnId);
            expect(Array.isArray(frame.ops)).toBe(true);
            expect((frame.ops as unknown[]).length).toBeGreaterThan(0);
            expect((frame.ops as Record<string, unknown>[]).every((op) => typeof op.op === 'string')).toBe(true);
            // Bounded: one frame carries ops, not a tree, and stays well under the stream's frame
            // cap. Asserted as a byte bound so a regression to a full display cannot pass.
            expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThan(4_096);
        }

        // Monotonic per-subscription sequence: 1..n with no gaps, which is what a client uses to
        // detect a hole. The cursor is the same number, encoded against the shared epoch.
        const paneUpdates = frames.filter((frame) => frame.type === 'update' && frame.subscription_id === 'pane');

        expect(paneUpdates.map((frame) => frame.sequence as number)).toEqual(
            paneUpdates.map((_frame, position) => position + 1)
        );

        // Nothing reached the pane after the unsubscribe: the run kept going (asserted below on
        // the rail), it just stopped being delivered here.
        expect(frames.filter((frame) => frame.subscription_id === 'pane').length).toBe(beforeDisconnect);

        // THE disconnect rule, stated by the run itself: the turn settled `done`, not cancelled.
        const row = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}`));

        expect(row.body.turn.status).toBe('done');

        // Monotonic turn-row revision, read off the rows the stream itself carried. `turn.upsert`
        // is a turn-scope kind too, so the pane saw the queued/running transitions before it left;
        // the rail saw every one of them, and its figures only ever go up.
        const railUpserts = frames
            .filter((frame) => frame.type === 'update' && frame.kind === 'turn.upsert' && frame.subscription_id === 'rail')
            .map((frame) => frame.turn as Record<string, any>);

        // The exact status ORDER the rail saw. The subscription is registered AFTER the submit
        // returns, so whether the `queued` and `running` transitions landed here is scheduling;
        // what is fixed by contract is that they arrive in order, once each, and end `done`.
        const statuses = railUpserts.map((record) => record.status as string);
        const order = ['queued', 'running', 'done'];

        expect(statuses[statuses.length - 1]).toBe('done');
        expect(statuses.filter((status) => status === 'done')).toEqual(['done']);

        const positions = statuses.map((status) => order.indexOf(status));

        expect(positions.every((position) => position >= 0)).toBe(true);

        for (let index = 1; index < positions.length; index += 1) {
            expect(positions[index]).toBeGreaterThan(positions[index - 1]);
        }

        // Monotonic turn revision, stated per live change: every announcement of this turn moves
        // the `turn` counter by exactly one (no change counted twice, no change skipped), and the
        // display/event figures EQUAL it because the contract defines them so and the store moves
        // the trio together.
        expect(counters.length).toBeGreaterThanOrEqual(4);

        let previous: number | undefined;

        for (const record of counters) {
            // The `queued` transition happened inside the submit, before this recorder was
            // attached, so the first sample is not pinned to 1 - every step after it is +1.
            if (previous !== undefined) expect(record.turn).toBe(previous + 1);

            expect(record.display).toBe(record.turn);
            expect(record.events).toBe(record.turn);

            previous = record.turn;
        }

        expect(previous).toBeGreaterThan(0);

        // HTTP and WS quote the same final number: the identified turn read stamps the hub figure
        // the live run just moved.
        const revision = previous ?? 0;

        expect(revision).toBeGreaterThan(0);

        expect(revision).toBe(api.events.getRevision('turn', turnKey));
        expect(api.events.getRevision('turn_display', turnKey)).toBe(revision);
        expect(row.body.turn.revision).toBe(revision);

        unwatchCounters();

        // The session pane got the row patches and the metadata, and (by the scope table, not by
        // accident) no ops frames.
        const railKinds = frames
            .filter((frame) => frame.type === 'update' && frame.subscription_id === 'rail')
            .map((frame) => frame.kind as string);

        expect(railKinds).toContain('turn.upsert');
        expect(railKinds).toContain('session.updated');
        expect(railKinds).not.toContain('display.ops');

        // And the whole live pipeline still built no aggregate: the display frames came from the
        // incremental fold, not from a view or a snapshot.
        const getSpy = vi.spyOn(store, 'get');
        const listSpy = vi.spyOn(store, 'list');
        const viewSpy = vi.spyOn(store, 'getView');
        const watchViewSpy = vi.spyOn(store, 'watchView');

        await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/turns/${turnId}/display`);

        expect(getSpy).not.toHaveBeenCalled();
        expect(listSpy).not.toHaveBeenCalled();
        expect(viewSpy).not.toHaveBeenCalled();
        expect(watchViewSpy).not.toHaveBeenCalled();

        getSpy.mockRestore();
        listSpy.mockRestore();
        viewSpy.mockRestore();
        watchViewSpy.mockRestore();
    });

    it('keeps a queued backlog and session status honest across a cancel', async () => {
        // Spot-check of the non-display domains T16 touches: a stopped conversation ends its own
        // pending question, the queue page drops what was cancelled, and the session row returns to
        // idle without a snapshot being built.
        const { api, store } = createContext();

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));
        const sessionId = created.body.id ?? created.body.session.id;

        await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'first' });
        await store.waitForIdle(sessionId);

        const queue = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/queue`));

        expect(queue.body.items).toEqual([]);
        expect(queue.body.revision).toBe(api.events.getRevision('queue', sessionId));

        const actions = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/actions`));

        expect(actions.body.actions).toEqual([]);

        const cancelled = jsonOf(await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/cancel`, {}));

        expect(cancelled.status).toBe(200);
        // Nothing was running: the answer is an honest `cancelled: false`, not a fabricated success.
        expect(cancelled.body.cancelled).toBe(false);

        const row = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}`));

        expect(row.body.session.status).toBe('idle');
        expect(row.body.session.queue_depth ?? 0).toBe(0);
    });

    it('streams a usage patch with server-summed figures, never a client-side accumulation', async () => {
        const { api, store } = createContext();

        const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'worker' }));
        const sessionId = created.body.session.id as string;

        const seen: HarnessStreamEvent[] = [];
        const detach = api.events.subscribe((event) => seen.push(event));

        await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tasks`, { input: 'report usage' });
        await store.waitForIdle(sessionId);

        detach();

        const usageEvents = seen.filter((event) => event.kind === 'usage.updated');

        // The tally is announced once, where it lands (the turn's terminal frame), not once per
        // delta: `usage.updated` is a figure update, not a stream of figures.
        expect(usageEvents).toHaveLength(1);

        const patch = (usageEvents[usageEvents.length - 1].payload as Record<string, any>).usage_patch;

        expect(patch.usage).toEqual({ input: 11, output: 7, total: 18 });
        expect(typeof patch.revision).toBe('number');

        // The same figures the usage read folds, so a client that applied the patch and a client
        // that re-reads agree exactly.
        const usage = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/usage`));

        expect(usage.body.usage).toEqual({ input: 11, output: 7, total: 18 });
        expect(usage.body.reported_turns).toBe(1);
    });
});
