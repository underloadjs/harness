// Scoped tests for the stream broker: counters, atomic registration, routing, filters, replay,
// resync, ack pacing, and the drop-then-resync rule.
//
// Every source here is a FAKE, deliberately tiny: a counter map, an id set, and a clock. That is the
// point of the broker's callback contract — the store/registry owner (T13) plugs in the same three
// functions, and nothing in the broker needs a session, a projector, or `store.watchView` (which
// opens with a full compiled view and is exactly what the stream must never do).
//
// Payload objects are cast through `unknown` because the broker copies a payload verbatim into the
// frame: only the fields routing and filtering READ (an id, a `status`, an `ops` array) have to
// exist for these assertions. The full `TurnSummary`/`SessionStatePatch` shapes are the projector's
// contract, asserted in the REST owner's suite, not here.

import { describe, expect, it } from 'vitest';
import type { TurnSummary, WsSubscriptionScope, WsRevisionRecord, WsServerMessage, WsUpdate } from '../../shared/harness-stream';
import { createStreamBroker, type StreamEvent, type StreamSink } from './broker';
import { decodeStreamCursor, encodeStreamCursor, HARNESS_WS_SCOPE_BASELINES } from './protocol';

const EPOCH = '9f2c17a4';

// A mutable clock, because replay retention is stated in BOTH frames and seconds and the age bound
// has to be provable without waiting 60 seconds.
const createClock = (start = 1_762_250_000_000): { now: () => number; advance: (ms: number) => void } => {
    let current = start;
    return { now: () => current, advance: (ms) => (current += ms) };
};

type Harness = ReturnType<typeof createStreamBroker>;

type Fixture = {
    broker: Harness;
    frames: WsServerMessage[];
    delivered: () => WsServerMessage[];
    sink: StreamSink;
    clock: { now: () => number; advance: (ms: number) => void };
    known: Set<string>;
    counters: Map<string, number>;
};

const makeFixture = (options: { limits?: Partial<ReturnType<Harness['limits']>>; known?: Set<string> } = {}): Fixture => {
    const clock = createClock();
    const known = options.known ?? new Set(['session:session-1', 'session:other', 'thread:thread-1', 'turn:turn-1']);
    const counters = new Map<string, number>();
    const frames: WsServerMessage[] = [];

    const broker = createStreamBroker({
        epoch: EPOCH,
        clock: clock.now,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        // Existence answers from a Set of `kind:id` pairs, so `unknown_resource` is provable
        // without a store.
        exists: (resource, id) => (id === null ? true : known.has(`${resource}:${id}`)),
        // Counters come from a plain map: the shape a store-side baseline callback must return.
        baseline: (scope, ids) =>
            HARNESS_WS_SCOPE_BASELINES[scope].map((resource) => ({
                resource,
                id:
                    resource === 'thread' || resource === 'transcript'
                        ? ids.thread_id ?? null
                        : resource === 'turn' || resource === 'turn_display' || resource === 'turn_events'
                          ? ids.turn_id ?? null
                          : resource === 'harnesses' || resource === 'agents' || resource === 'tools' || resource === 'config'
                            ? null
                            : ids.session_id ?? null,
                revision: counters.get(`${resource}:${ids.session_id ?? ids.thread_id ?? ids.turn_id ?? ''}`) ?? 7,
                epoch: 'stale-epoch-must-be-overwritten'
            }))
    });

    return {
        broker,
        frames,
        delivered: () => frames,
        sink: (frame) => {
            frames.push(frame);
            return 'sent';
        },
        clock,
        known,
        counters
    };
};

const openSession = (fixture: Fixture) => fixture.broker.open(fixture.sink);

describe('stream cursors', () => {
    it('encodes the contract example exactly: base64url(epoch:sequence)', () => {
        // The spec's own example pair (swagger `x-websocket.examples`: epoch `9f2c17a4`, cursor
        // `OWYyYzE3YTQ6MQ`) must round-trip, or every retained cursor in the docs is wrong.
        expect(encodeStreamCursor('9f2c17a4', 1)).toBe('OWYyYzE3YTQ6MQ');
        expect(decodeStreamCursor('OWYyYzE3YTQ6MQ')).toEqual({ epoch: '9f2c17a4', sequence: 1 });
    });

    it('refuses anything it did not mint instead of guessing', () => {
        expect(decodeStreamCursor(undefined)).toBeUndefined();
        expect(decodeStreamCursor('')).toBeUndefined();
        expect(decodeStreamCursor('not a cursor')).toBeUndefined();
        expect(decodeStreamCursor(Buffer.from('nonsense', 'utf8').toString('base64url'))).toBeUndefined();
    });
});

describe('revision counters', () => {
    it('starts at 0, moves by one, and never moves backwards on a mirrored write', () => {
        const { broker } = makeFixture();

        expect(broker.revision('turns', 'session-1')).toBe(0);
        expect(broker.bump('turns', 'session-1')).toBe(1);
        expect(broker.bump('turns', 'session-1')).toBe(2);

        // A REST write may report a HIGHER revision; a later duplicate must never lower it, because
        // a revision is only ever compared within one epoch.
        expect(broker.setRevision('turns', 'session-1', 9)).toBe(9);
        expect(broker.setRevision('turns', 'session-1', 4)).toBe(9);
        expect(broker.revision('turns', 'session-1')).toBe(9);
    });

    it('keeps counters separate per kind and per id', () => {
        const { broker } = makeFixture();

        broker.bump('turns', 'session-1');
        broker.bump('turns', 'session-2');

        expect(broker.revision('turns', 'session-1')).toBe(1);
        expect(broker.revision('turns', 'session-2')).toBe(1);
        expect(broker.revision('turns', null)).toBe(0);
    });
});

describe('subscribe registration', () => {
    it('answers subscription_state at sequence 0 with the per-scope baseline, epoch-stamped', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        const outcome = session.subscribe({
            subscription_id: 's1',
            scope: 'session',
            ids: { session_id: 'session-1' },
            pace: 'ordered'
        });

        expect(outcome.status).toBe('ok');

        if (outcome.status !== 'ok') return;

        expect(outcome.state).toEqual({
            type: 'subscription_state',
            subscription_id: 's1',
            scope: 'session',
            epoch: EPOCH,
            sequence: 0,
            cursor: encodeStreamCursor(EPOCH, 0),
            // The fake baseline returns revision 7 for every kind, and the broker MUST overwrite the
            // record epoch with its own (a foreign epoch in a baseline would break every comparison).
            revisions: HARNESS_WS_SCOPE_BASELINES.session.map((resource) => ({
                resource,
                id: 'session-1',
                revision: 7,
                epoch: EPOCH
            })),
            publishes: [
                'session.updated',
                'turn.upsert',
                'turn.removed',
                'action.opened',
                'action.closed',
                'usage.updated',
                // T4: the record store's wake-up kind, in the position `HARNESS_WS_SCOPE_PUBLISHES.session`
                // (src/server/stream/protocol.ts) puts it, which is the yaml's
                // `subscription_scopes[].publishes` order.
                'records.updated',
                'thread.upsert',
                'thread.removed',
                'tool.registry_updated',
                'agent.registry_updated',
                'run.event'
            ]
        });
        expect(outcome.replay).toEqual([]);
    });

    it('advertises the scope publish set and records the filters it accepted', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        const outcome = session.subscribe({
            subscription_id: 's1',
            scope: 'session',
            ids: { session_id: 'session-1' },
            filters: { status: 'running' },
            pace: 'ordered'
        });

        expect(outcome.status === 'ok' && outcome.state.publishes).toEqual([
            'session.updated',
            'turn.upsert',
            'turn.removed',
            'action.opened',
            'action.closed',
            'usage.updated',
            'records.updated',
            'thread.upsert',
            'thread.removed',
            'tool.registry_updated',
            'agent.registry_updated',
            'run.event'
        ]);
        expect(outcome.status === 'ok' && outcome.state.filters_applied).toEqual({ status: 'running' });
    });

    it('uses a host baseline callback and caps the list at revision_records_per_state', () => {
        const clock = createClock();
        const long: WsRevisionRecord[] = Array.from({ length: 25 }, (_, index) => ({
            resource: 'config',
            id: null,
            revision: index,
            epoch: 'other'
        }));

        const broker = createStreamBroker({
            epoch: EPOCH,
            clock: clock.now,
            baseline: () => long
        });

        const outcome = broker.open(() => 'sent').subscribe({
            subscription_id: 's1',
            scope: 'session',
            ids: { session_id: 'session-1' },
            pace: 'ordered'
        });

        // The cap IS `revision_records_per_state` (21 — one record per `StreamResourceKind`,
        // src/server/harness.swagger.yaml `x-websocket.limits`), so a 25-record host baseline
        // must be truncated to exactly that many, in the host's order.
        expect(outcome.status === 'ok' && outcome.state.revisions.length).toBe(21);
        expect(outcome.status === 'ok' && outcome.state.revisions[0]).toEqual({ resource: 'config', id: null, revision: 0, epoch: EPOCH });
    });

    it('refuses a subscription id already in use on this connection', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        const request = { subscription_id: 'dup', scope: 'global' as WsSubscriptionScope, ids: {}, pace: 'ordered' as const };

        expect(session.subscribe(request).status).toBe('ok');
        expect(session.subscribe(request)).toEqual({
            status: 'rejected',
            failure: {
                code: 'invalid_payload',
                message: 'subscription_id dup is already in use on this connection.',
                subscription_id: 'dup'
            }
        });
    });

    it('reports unknown_resource ahead of filter and budget conditions', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        expect(
            session.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'gone' }, pace: 'ordered' })
        ).toEqual({
            status: 'rejected',
            failure: { code: 'unknown_resource', message: 'No session matches gone.', subscription_id: 's1' }
        });
    });

    it('reports a filter the scope does not publish as unsupported_filter for that subscription only', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 'ok', scope: 'global', ids: {}, pace: 'ordered' });

        expect(
            session.subscribe({
                subscription_id: 's2',
                scope: 'thread',
                ids: { session_id: 'session-1', thread_id: 'thread-1' },
                filters: { events: true },
                pace: 'ordered'
            })
        ).toEqual({
            status: 'rejected',
            failure: { code: 'unsupported_filter', message: 'thread does not publish events.', subscription_id: 's2' }
        });

        // The connection keeps working: only the offending subscription was refused.
        expect(session.subscriptionCount).toBe(1);
    });

    it('refuses the 65th subscription with too_many_subscriptions and close code 4401', () => {
        const fixture = makeFixture({ limits: { subscriptions_per_connection: 2 } });
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 'a', scope: 'global', ids: {}, pace: 'ordered' });
        session.subscribe({ subscription_id: 'b', scope: 'global', ids: {}, pace: 'ordered' });

        expect(
            session.subscribe({ subscription_id: 'c', scope: 'global', ids: {}, pace: 'ordered' })
        ).toEqual({
            status: 'rejected',
            failure: {
                code: 'too_many_subscriptions',
                message: 'A connection carries at most 2 subscriptions.',
                subscription_id: 'c',
                close_code: 4401
            }
        });
    });
});

describe('publish fan-out', () => {
    const turnUpsert = (id: string, status: string, threadId?: string): StreamEvent => ({
        kind: 'turn.upsert',
        session_id: 'session-1',
        ...(threadId === undefined ? {} : { thread_id: threadId }),
        turn_id: id,
        at: 1_762_250_000_100,
        payload: { turn: { id, status } as unknown as TurnSummary }
    });

    it('mints a monotonic sequence and cursor per subscription', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        fixture.frames.length = 0;

        fixture.broker.publish(turnUpsert('turn-1', 'running'));
        fixture.broker.publish(turnUpsert('turn-2', 'done'));

        expect(fixture.frames.length).toBe(2);

        // Exact frames, not fuzzy shape checks: a wrong sequence, a wrong cursor, or a stray payload
        // field must fail here rather than in a browser.
        expect(fixture.frames[0]).toEqual({
            type: 'update',
            subscription_id: 's1',
            sequence: 1,
            cursor: encodeStreamCursor(EPOCH, 1),
            kind: 'turn.upsert',
            at: 1_762_250_000_100,
            turn: { id: 'turn-1', status: 'running' }
        });
        expect(fixture.frames[1]).toEqual({
            type: 'update',
            subscription_id: 's1',
            sequence: 2,
            cursor: encodeStreamCursor(EPOCH, 2),
            kind: 'turn.upsert',
            at: 1_762_250_000_100,
            turn: { id: 'turn-2', status: 'done' }
        });
    });

    it('moves the counters it is documented to move, before fan-out', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });

        // `turns` is the collection counter for a turn row; `run.event` moves nothing.
        expect(fixture.broker.revision('turns', 'session-1')).toBe(0);
        fixture.broker.publish(turnUpsert('turn-1', 'running'));
        expect(fixture.broker.revision('turns', 'session-1')).toBe(1);

        fixture.broker.publish({
            kind: 'run.event',
            session_id: 'session-1',
            turn_id: 'turn-1',
            payload: { turn_id: 'turn-1', events: [] }
        });
        expect(fixture.broker.revision('turns', 'session-1')).toBe(1);
    });

    it('derives the catalogue counter from the payload field', () => {
        const fixture = makeFixture();

        fixture.broker.publish({ kind: 'catalogue.updated', payload: { catalogue: 'tools', ids: ['grep'] } });
        fixture.broker.publish({ kind: 'catalogue.updated', payload: { catalogue: 'harnesses', ids: ['instruct'] } });

        expect(fixture.broker.revision('tools', null)).toBe(1);
        expect(fixture.broker.revision('harnesses', null)).toBe(1);
        expect(fixture.broker.revision('agents', null)).toBe(0);
    });

    it('routes by scope and ids: a global subscription never sees session frames', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 'g', scope: 'global', ids: {}, pace: 'ordered' });
        session.subscribe({ subscription_id: 's', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        session.subscribe({ subscription_id: 't', scope: 'session', ids: { session_id: 'other' }, pace: 'ordered' });
        fixture.frames.length = 0;

        fixture.broker.publish(turnUpsert('turn-1', 'running'));
        fixture.broker.publish({ kind: 'config.updated', payload: {} });

        expect(fixture.frames.map((frame) => ('subscription_id' in frame ? `${frame.subscription_id}:${frame.type}:${'kind' in frame ? frame.kind : ''}` : frame.type))).toEqual([
            's:update:turn.upsert',
            'g:update:config.updated'
        ]);
    });

    it('gates run.event behind the events filter', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 'plain', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        session.subscribe({
            subscription_id: 'raw',
            scope: 'session',
            ids: { session_id: 'session-1' },
            filters: { events: true },
            pace: 'ordered'
        });
        fixture.frames.length = 0;

        const affected = fixture.broker.publish({
            kind: 'run.event',
            session_id: 'session-1',
            turn_id: 'turn-1',
            payload: { turn_id: 'turn-1', events: [{ index: 0, event: { type: 'text', text: 'hi' } }] } as never
        });

        expect(affected).toBe(1);
        expect(fixture.frames.map((frame) => (frame as { subscription_id?: string }).subscription_id)).toEqual(['raw']);
    });

    it('narrows turn rows with the status filter and threads with the thread_id filter', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({
            subscription_id: 'running',
            scope: 'session',
            ids: { session_id: 'session-1' },
            filters: { status: 'running' },
            pace: 'ordered'
        });
        session.subscribe({
            subscription_id: 'threaded',
            scope: 'session',
            ids: { session_id: 'session-1' },
            filters: { thread_id: 'thread-1' },
            pace: 'ordered'
        });
        fixture.frames.length = 0;

        fixture.broker.publish(turnUpsert('turn-1', 'running', 'thread-1'));
        fixture.broker.publish(turnUpsert('turn-2', 'done', 'thread-1'));
        fixture.broker.publish(turnUpsert('turn-3', 'running', 'thread-9'));
        // A session-level patch carries no thread, so a thread filter must NOT starve it.
        fixture.broker.publish({ kind: 'session.updated', session_id: 'session-1', payload: { session: { status: 'idle' } } as never });

        expect(
            fixture.frames.flatMap((frame) =>
                frame.type === 'update' ? [`${frame.subscription_id}:${frame.kind}:${'turn' in frame ? frame.turn.id : 'session'}`] : []
            )
        ).toEqual([
            'running:turn.upsert:turn-1',
            'threaded:turn.upsert:turn-1',
            // `done` fails the `status` filter but not the `thread_id` filter, so exactly one of the
            // two subscriptions sees it — the filters are independent narrowings.
            'threaded:turn.upsert:turn-2',
            'running:turn.upsert:turn-3',
            'running:session.updated:session',
            'threaded:session.updated:session'
        ]);
    });

    it('strips node/step bodies with sections:false and drops context ops with context:false', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({
            subscription_id: 'meta',
            scope: 'turn',
            ids: { session_id: 'session-1', turn_id: 'turn-1' },
            filters: { sections: false, context: false },
            pace: 'ordered'
        });
        fixture.frames.length = 0;

        fixture.broker.publish({
            kind: 'display.ops',
            session_id: 'session-1',
            turn_id: 'turn-1',
            payload: {
                turn_id: 'turn-1',
                ops: [
                    { op: 'node:insert', node: { id: 'n1' } },
                    { op: 'context:add', block: { id: 'b1' } },
                    { op: 'step:set', step: { id: 's1' }, stepId: 's1' }
                ]
            } as never
        });

        expect(fixture.frames).toEqual([
            {
                type: 'update',
                subscription_id: 'meta',
                sequence: 1,
                cursor: encodeStreamCursor(EPOCH, 1),
                kind: 'display.ops',
                at: 1_762_250_000_000,
                turn_id: 'turn-1',
                // `context:add` is gone entirely, and the surviving ops keep their ids but lose the
                // section bodies — narrowing removes frames, it never widens a payload.
                ops: [{ op: 'node:insert' }, { op: 'step:set', stepId: 's1' }]
            }
        ]);
    });

    it('drops a display.ops frame whose ops were ALL filtered away', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({
            subscription_id: 'meta',
            scope: 'turn',
            ids: { session_id: 'session-1', turn_id: 'turn-1' },
            filters: { context: false },
            pace: 'ordered'
        });
        fixture.frames.length = 0;

        const affected = fixture.broker.publish({
            kind: 'display.ops',
            session_id: 'session-1',
            turn_id: 'turn-1',
            payload: { turn_id: 'turn-1', ops: [{ op: 'context:set', blockId: 'b1' }] } as never
        });

        expect(affected).toBe(0);
        expect(fixture.frames).toEqual([]);
    });

    it('splits more than ops_per_update_frame ops into MORE frames, never a bigger one', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 's1', scope: 'turn', ids: { session_id: 'session-1', turn_id: 'turn-1' }, pace: 'ordered' });
        fixture.frames.length = 0;

        const ops = Array.from({ length: 40 }, (_, index) => ({ op: 'node:append', nodeId: `n${index}`, delta: 'x' }));

        fixture.broker.publish({ kind: 'display.ops', session_id: 'session-1', turn_id: 'turn-1', payload: { turn_id: 'turn-1', ops } as never });

        const updates = fixture.frames.filter((frame) => frame.type === 'update');

        expect(updates.length).toBe(2);
        expect(updates.map((frame) => (frame as WsUpdate & { ops: unknown[] }).ops.length)).toEqual([32, 8]);
        expect(updates.map((frame) => (frame as { sequence: number }).sequence)).toEqual([1, 2]);
        // Both chunks carry the mutation's clock time, not the send time.
        expect(updates.map((frame) => (frame as { at: number }).at)).toEqual([1_762_250_000_000, 1_762_250_000_000]);
    });
});

describe('replay and resync', () => {
    // `session.updated` is the kind a `session` scope publishes, so these tests exercise a real
    // fan-out; `config.updated` belongs to `global` only and would silently publish nothing.
    const patch = (): StreamEvent => ({ kind: 'session.updated', session_id: 'session-1', payload: { session: { status: 'idle' } } as never });

    it('replays retained frames above the cursor and reports how many', () => {
        const fixture = makeFixture();
        const first = openSession(fixture);

        first.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });

        fixture.broker.publish(patch());
        const resumeCursor = (fixture.frames[0] as { cursor: string }).cursor;

        fixture.broker.publish(patch());
        fixture.broker.publish(patch());

        // The peer dies; the parked window is what a reconnect resumes from.
        first.release();

        const second = openSession(fixture);
        const outcome = second.subscribe({
            subscription_id: 's1',
            scope: 'session',
            ids: { session_id: 'session-1' },
            pace: 'ordered',
            cursor: resumeCursor
        });

        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;

        expect(outcome.state.sequence).toBe(3);
        expect(outcome.state.cursor).toBe(encodeStreamCursor(EPOCH, 3));
        expect(outcome.state.replayed_frames).toBe(2);
        expect(outcome.replay.map((frame) => (frame as { sequence: number }).sequence)).toEqual([2, 3]);
    });

    it('answers epoch_mismatch for a cursor from another process', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        const outcome = session.subscribe({
            subscription_id: 's1',
            scope: 'session',
            ids: { session_id: 'session-1' },
            pace: 'ordered',
            cursor: encodeStreamCursor('deadbeef', 12)
        });

        expect(outcome.status).toBe('resync');
        if (outcome.status !== 'resync') return;

        expect(outcome.resync.type).toBe('resync_required');
        expect(outcome.resync.reason).toBe('epoch_mismatch');
        expect(outcome.resync.epoch).toBe(EPOCH);
        expect(outcome.resync.resources.map((resource) => resource.resource)).toEqual(HARNESS_WS_SCOPE_BASELINES.session);
        // The links name bounded reads, not the resource itself.
        expect(outcome.resync.resources[0].link).toBe('/v1/harness/sessions/session-1');
    });

    it('answers cursor_expired once the 60 second window closes', () => {
        const fixture = makeFixture();
        const first = openSession(fixture);

        first.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        fixture.broker.publish(patch());

        const resumeCursor = (fixture.frames[fixture.frames.length - 1] as { cursor: string }).cursor;
        first.release();

        // The parked window expires outright once the retention age passes.
        fixture.clock.advance(60_001);

        const second = openSession(fixture);
        const outcome = second.subscribe({
            subscription_id: 's1',
            scope: 'session',
            ids: { session_id: 'session-1' },
            pace: 'ordered',
            cursor: resumeCursor
        });

        // With no window left to compare against, the only honest answer is a floor-below resync.
        expect(outcome.status).toBe('resync');
        if (outcome.status !== 'resync') return;
        expect(outcome.resync.reason).toBe('cursor_expired');
    });

    it('reports frames_dropped when the connection drops a frame, and never consumes a sequence', () => {
        const frames: WsServerMessage[] = [];
        const clock = createClock();
        let deliver = true;

        const broker = createStreamBroker({ epoch: EPOCH, clock: clock.now });
        const session = broker.open((frame) => {
            frames.push(frame);
            if (frame.type === 'update' && !deliver) return 'dropped';
            return 'sent';
        });

        // `subscribe` RETURNS the state frame (the connection sends it), so the sink only ever sees
        // updates and resyncs — which is what makes the sequence arithmetic below exact.
        session.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        expect(frames).toEqual([]);

        deliver = false;
        broker.publish(patch());

        expect(frames.map((frame) => frame.type)).toEqual(['update', 'resync_required']);

        const resync = frames[1] as { reason: string; lost_frames?: number; sequence?: number };
        expect(resync.reason).toBe('frames_dropped');
        expect(resync.lost_frames).toBe(1);
        // A resync frame is out-of-band: the next update must continue at sequence 2, not 3.
        expect(resync.sequence).toBeUndefined();

        frames.length = 0;
        deliver = true;
        broker.publish(patch());

        expect((frames[0] as { sequence: number }).sequence).toBe(2);
    });

    it('starts fresh with no cursor, at the server position', () => {
        const fixture = makeFixture();
        const first = openSession(fixture);

        first.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        fixture.broker.publish(patch());
        first.release();

        const second = openSession(fixture);
        const outcome = second.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });

        expect(outcome.status === 'ok' ? { sequence: outcome.state.sequence, replayed: outcome.state.replayed_frames } : outcome.status).toEqual({
            sequence: 0,
            replayed: undefined
        });
    });
});

describe('ack pacing', () => {
    it('holds everything after one unacknowledged frame and releases on ack', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 'ack', scope: 'turn', ids: { session_id: 'session-1', turn_id: 'turn-1' }, pace: 'ack' });
        fixture.frames.length = 0;

        for (let index = 0; index < 3; index += 1) {
            fixture.broker.publish({
                kind: 'turn.upsert',
                session_id: 'session-1',
                turn_id: 'turn-1',
                payload: { turn: { id: `turn-${index}` } as unknown as TurnSummary }
            });
        }

        expect(fixture.frames.map((frame) => (frame as { sequence?: number }).sequence)).toEqual([1]);

        session.acknowledge('ack', 1);

        expect(fixture.frames.map((frame) => (frame as { sequence?: number }).sequence)).toEqual([1, 2, 3]);
    });

    it('ignores an ack on an unpaced subscription instead of erroring', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 'free', scope: 'global', ids: {}, pace: 'ordered' });
        expect(session.acknowledge('free', 5)).toBeUndefined();
        expect(session.acknowledge('nope', 5)).toEqual({
            code: 'unknown_subscription',
            message: 'No subscription nope is open on this connection.',
            subscription_id: 'nope'
        });
    });
});

describe('connection release', () => {
    it('releases every subscription but keeps a resumable window', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        expect(fixture.broker.subscriptions()).toBe(1);

        session.release();
        expect(fixture.broker.subscriptions()).toBe(0);

        // A second release is a no-op rather than a double park.
        session.release();
        expect(fixture.broker.subscriptions()).toBe(0);
    });

    it('closes live connections through the sink with the host close code', () => {
        const fixture = makeFixture();
        const session = openSession(fixture);

        session.subscribe({ subscription_id: 's1', scope: 'global', ids: {}, pace: 'ordered' });
        fixture.broker.close(1012);

        expect(fixture.frames[fixture.frames.length - 1]).toEqual({
            type: 'error',
            code: 'internal',
            message: 'The stream is closing (code 1012).',
            retryable: false,
            close_code: 1012
        });
        expect(fixture.broker.subscriptions()).toBe(0);
    });
});
