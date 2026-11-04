// The cross-owner seam, tested: T13's epoch/revision hub (`src/server/api-events.ts`) feeding T15's
// stream broker (`./broker.ts`). This is the ONLY place the two owners' code meet, and it is where a
// double-counted revision or a divergent epoch would first show up.
//
// What the bridge guarantees:
//   - one epoch: the broker reports the hub's `HARNESS_RUNTIME_EPOCH`, never its own mint;
//   - one counter per resource: the hub has already moved it, so the broker MIRRORS
//     (`setRevision`, max-wins) rather than bumping â€” a REST `X-Harness-Revision` and the
//     `subscription_state` record for the same resource are the same number;
//   - exactly one fan-out per hub event, with the composite `session:child` hub key split back into
//     the plain ids a subscription addresses.

import { describe, expect, it } from 'vitest';
import { HARNESS_RUNTIME_EPOCH, createHarnessEventHub, resourceKeyOf } from '../api-events';
import type { WsServerMessage } from '../../shared/harness-stream';
import { createStreamBroker } from './broker';
import { bridgeEventHub, createHarnessStreamMount, hubResourceId, hubStreamSources } from './mount';
import { HARNESS_WS_STREAM_PATH, encodeStreamCursor } from './protocol';

describe('epoch and revision hub bridge', () => {
    it('reports the hub epoch, not a minted one', () => {
        const mount = createHarnessStreamMount({});

        expect(mount.broker.epoch()).toBe(HARNESS_RUNTIME_EPOCH);
        expect(mount.path).toBe(HARNESS_WS_STREAM_PATH);
    });

    it('mirrors hub counters into the subscription baseline', () => {
        const hub = createHarnessEventHub();
        const session = 'session-1';

        // A REST write moved the sessions collection counter.
        hub.bumpRevision('turns', session);
        hub.bumpRevision('turns', session);

        const broker = createStreamBroker(hubStreamSources(hub));
        const frames: WsServerMessage[] = [];
        const handle = broker.open((frame) => {
            frames.push(frame);
            return 'sent';
        });

        const outcome = handle.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: session }, pace: 'ordered' });

        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;

        const turns = outcome.state.revisions.find((record) => record.resource === 'turns');

        expect(turns).toEqual({ resource: 'turns', id: session, revision: 2, epoch: HARNESS_RUNTIME_EPOCH });
        expect(outcome.state.epoch).toBe(HARNESS_RUNTIME_EPOCH);
    });

    it('turns one hub publish into exactly one bounded stream frame, without moving a counter twice', () => {
        const hub = createHarnessEventHub();
        const broker = createStreamBroker(hubStreamSources(hub));
        const frames: WsServerMessage[] = [];

        const handle = broker.open((frame) => {
            frames.push(frame);
            return 'sent';
        });

        const detach = bridgeEventHub(hub, broker);

        handle.subscribe({ subscription_id: 's1', scope: 'session', ids: { session_id: 'session-1' }, pace: 'ordered' });
        frames.length = 0;

        // A REST write moves the collection counter, then publishes. `hub.publish` REPORTS the
        // listed counters as they stand (it does not bump them), so the number the stream mirrors is
        // exactly the number the REST response carried in `X-Harness-Revision`.
        hub.bumpRevision('turns', 'session-1');

        const event = hub.publish({
            kind: 'turn.upsert',
            resources: [resourceKeyOf('turns', 'session-1')],
            target: resourceKeyOf('turn', 'session-1:turn-9'),
            payload: { turn: { id: 'turn-9', status: 'running' } }
        });

        const updates = frames.filter((frame) => frame.type === 'update');

        expect(updates.length).toBe(1);
        expect(updates[0]).toEqual({
            type: 'update',
            subscription_id: 's1',
            sequence: 1,
            cursor: encodeStreamCursor(HARNESS_RUNTIME_EPOCH, 1),
            kind: 'turn.upsert',
            at: event.at,
            // The payload is copied verbatim: the stream ships the row, never a tree.
            turn: { id: 'turn-9', status: 'running' }
        });

        // The counters the hub moved are the counters the stream reports â€” mirrored, not re-bumped.
        expect(broker.revision('turns', 'session-1')).toBe(hub.getRevision('turns', 'session-1'));
        expect(broker.revision('turns', 'session-1')).toBe(1);

        // A detached bridge stops the fan-out, which is what a disposable runtime needs.
        detach();
        hub.publish({ kind: 'session.updated', resources: [resourceKeyOf('session', 'session-1')], payload: { session: {} } });
        expect(frames.filter((frame) => frame.type === 'update').length).toBe(1);
    });

    it('keys the composite hub id so a turn frame routes to the turn subscription', () => {
        const hub = createHarnessEventHub();
        const broker = createStreamBroker(hubStreamSources(hub));
        const frames: WsServerMessage[] = [];

        const handle = broker.open((frame) => {
            frames.push(frame);
            return 'sent';
        });

        bridgeEventHub(hub, broker);

        // A `turn` scope subscription addresses (session, turn); the hub keys the same resource as
        // `session:turn`, and the bridge must split it or the frame would silently go nowhere.
        handle.subscribe({ subscription_id: 't', scope: 'turn', ids: { session_id: 'session-1', turn_id: 'turn-9' }, pace: 'ordered' });
        frames.length = 0;

        hub.publish({
            kind: 'display.ops',
            resources: [resourceKeyOf('turn', 'session-1:turn-9')],
            target: resourceKeyOf('turn', 'session-1:turn-9'),
            ops: [{ op: 'node:append', nodeId: 'n1', delta: 'hello' }]
        });

        const updates = frames.filter((frame) => frame.type === 'update');

        expect(updates.length).toBe(1);
        expect((updates[0] as { ops: unknown[] }).ops).toEqual([{ op: 'node:append', nodeId: 'n1', delta: 'hello' }]);
        expect((updates[0] as { turn_id: string }).turn_id).toBe('turn-9');
    });

    it('maps a resource kind to the hub id spelling', () => {
        expect(hubResourceId('turn', { session_id: 's', turn_id: 't' })).toBe('s:t');
        expect(hubResourceId('transcript', { session_id: 's', thread_id: 'h' })).toBe('s:h');
        expect(hubResourceId('turns', { session_id: 's' })).toBe('s');
        expect(hubResourceId('config', {})).toBeNull();
        // A turn kind with no session half cannot be keyed, and must not guess a bare turn id.
        expect(hubResourceId('turn_display', { turn_id: 't' })).toBeNull();
    });
});
