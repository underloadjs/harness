/**
 * Records wake broker tests (records-wake.ts).
 *
 * Pins the isolation contract the two scratch-board panels rest on: ONE session
 * registration no matter how many panels attach, frames fanned to every attached
 * panel, a refusal or an absent plane told to all of them, and the registration
 * retired when the last panel lets go (or when the shell tears down). The budget is
 * real — 64 registrations per connection and a reconnect that replays the whole map
 * (../server/stream/broker.ts, ./stream.ts) — so a leak here is a product bug, not a
 * style preference.
 *
 * Run: npx vitest run --config src/frontend/vitest.config.ts
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { RecordsSignal } from '../../shared/harness-api';
import type {
    WsResyncRequired,
    WsSubscriptionState,
    WsUpdateRecords,
    WsUpdateSession
} from '../../shared/harness-stream';
import type { PanelSubscriptionSpec, PanelSubscribe } from './context';
import {
    attachRecordsWake,
    createRecordsWakeBroker,
    releaseRecordsWake,
    type RecordsWakeHandlers
} from './records-wake';

// -----------------------------------------------------------------------------
// Wire fixtures
// -----------------------------------------------------------------------------

const SIGNAL: RecordsSignal = { store_rev: 7, collections_rev: 3 };

const RECORDS_FRAME: WsUpdateRecords = {
    type: 'update',
    subscription_id: 'sub_1',
    sequence: 4,
    cursor: 'cursor-4',
    kind: 'records.updated',
    at: 1_794_300_000_000,
    records: SIGNAL
};

// A frame of another kind, to prove the fan-out is filtered rather than broadcast.
const SESSION_FRAME: WsUpdateSession = {
    type: 'update',
    subscription_id: 'sub_1',
    sequence: 5,
    cursor: 'cursor-5',
    kind: 'session.updated',
    at: 1_794_300_000_001,
    session: { revision: 12 }
};

const BASELINE: WsSubscriptionState = {
    type: 'subscription_state',
    subscription_id: 'sub_1',
    scope: 'session',
    epoch: 'epoch-1',
    sequence: 3,
    cursor: 'cursor-3',
    revisions: [{ resource: 'records', id: 'sess_a', revision: 7, epoch: 'epoch-1', link: '/v1/harness/sessions/sess_a/records' }],
    replayed_frames: 2,
    publishes: ['records.updated']
};

const GAP: WsResyncRequired = {
    type: 'resync_required',
    subscription_id: 'sub_1',
    reason: 'frames_dropped',
    epoch: 'epoch-2',
    cursor: 'cursor-9',
    lost_frames: 4,
    resources: [{ resource: 'records', id: 'sess_a', revision: 9, epoch: 'epoch-2', link: '/v1/harness/sessions/sess_a/records' }]
};

// -----------------------------------------------------------------------------
// The plane double
// -----------------------------------------------------------------------------

type Plane = {
    /** The seam to hand the broker. */
    seam: PanelSubscribe;
    /** Every spec the broker dialled, in order. */
    specs: PanelSubscriptionSpec[];
    /** The ids whose `unsubscribe()` ran, in order. */
    unsubscribed: string[];
    /** The callbacks the broker passed to the i-th registration. */
    callbacksOf: (index: number) => PanelSubscriptionSpec;
};

type PlaneAnswers = {
    /** The plane hands back no subscription (a host with no realtime client). */
    none?: boolean;
    /** The plane throws on `subscribe` (a socket that refused the registration). */
    throws?: string;
};

const createPlane = (answers: PlaneAnswers = {}): Plane => {
    const specs: PanelSubscriptionSpec[] = [];
    const unsubscribed: string[] = [];

    const seam: PanelSubscribe = (spec) => {
        specs.push(spec);

        if (answers.throws !== undefined) throw new Error(answers.throws);
        if (answers.none === true) return undefined;

        // The id is captured AT SUBSCRIBE TIME, so an unsubscribe is attributable.
        const id = `sub_${specs.length}`;

        return {
            id,
            spec,
            cursor: null,
            sequence: 0,
            unsubscribe: () => {
                unsubscribed.push(id);
            }
        };
    };

    return {
        seam,
        specs,
        unsubscribed,
        callbacksOf: (index) => {
            const spec = specs[index];
            if (spec === undefined) throw new Error(`registration ${index} was never dialled`);

            return spec;
        }
    };
};

// A broker over a recording plane, for the tests that only need channels.
const brokerOf = (answers: PlaneAnswers = {}) => {
    const plane = createPlane(answers);

    return { plane, broker: createRecordsWakeBroker((spec) => plane.seam(spec)) };
};

/**
 * Two panel-shaped listeners, recorded PER handler rather than aggregated, so fan-out
 * is provable for each attached panel instead of inferred from a shared counter.
 */
const listeners = () => {
    const seen: Record<'a' | 'b', string[]> = { a: [], b: [] };
    const received = { signals: [] as RecordsSignal[], baselines: [] as WsSubscriptionState[], gaps: [] as WsResyncRequired[] };

    const handler = (which: 'a' | 'b'): RecordsWakeHandlers => ({
        onSignal: (signal) => {
            seen[which].push('signal');
            received.signals.push(signal);
        },
        onBaseline: (state) => {
            seen[which].push('baseline');
            received.baselines.push(state);
        },
        onGap: (frame) => {
            seen[which].push('gap');
            received.gaps.push(frame);
        },
        onRefused: (message) => {
            seen[which].push(`refused:${message}`);
        },
        onUnavailable: (message) => {
            seen[which].push(`unavailable:${message}`);
        },
        onReleased: () => {
            seen[which].push('released');
        }
    });

    return { seen, received, a: handler('a'), b: handler('b') };
};

afterEach(() => {
    // The module keeps a process-wide broker for `attachRecordsWake`; every test that
    // touched it leaves it retired, so the next one never inherits a live slot.
    releaseRecordsWake();
});

describe('records wake broker — one registration per conversation', () => {
    it('dials nothing until a panel attaches, and dials once for two panels', () => {
        const { plane, broker } = brokerOf();
        const channel = broker.channel('sess_a');

        // Naming a conversation is not listening to it: a paint that mounts no panel
        // must not hold a slot on the plane.
        expect(plane.specs).toEqual([]);
        expect(broker.size()).toBe(1);
        expect(channel.live()).toBe(false);
        expect(channel.attached()).toBe(0);
        expect(channel.frames()).toBe(0);

        const both = listeners();
        channel.attach(both.a);
        channel.attach(both.b);

        expect(plane.specs).toHaveLength(1);
        // A session-scoped registration with NO filters: `records` is part of the
        // session baseline, and the contract accepts filters only for
        // status/threads/events/sections. Exact keys, so a stray filter is a failure.
        expect(plane.specs[0]).toEqual({
            scope: 'session',
            sessionId: 'sess_a',
            onState: expect.any(Function),
            onUpdate: expect.any(Function),
            onResync: expect.any(Function),
            onError: expect.any(Function)
        });
        expect(channel.live()).toBe(true);
        expect(channel.attached()).toBe(2);
        expect(channel.sessionId()).toBe('sess_a');
    });

    it('keeps the registration while one panel remains and retires it when the last lets go', () => {
        const { plane, broker } = brokerOf();
        const channel = broker.channel('sess_a');
        const both = listeners();

        const releaseA = channel.attach(both.a);
        const releaseB = channel.attach(both.b);

        releaseA();
        expect(plane.unsubscribed).toEqual([]);
        expect(channel.live()).toBe(true);
        expect(channel.attached()).toBe(1);

        releaseB();
        // The last panel detached itself, so it is not ALSO told the channel is gone;
        // what is retired is the registration.
        expect(plane.unsubscribed).toEqual(['sub_1']);
        expect(seenOf(both, 'a')).toEqual([]);
        expect(seenOf(both, 'b')).toEqual([]);
        expect(channel.live()).toBe(false);
        expect(broker.size()).toBe(0);
    });

    it('tells every attached panel when the shell retires the channel, and never strands the registration', () => {
        const { plane, broker } = brokerOf();
        const channel = broker.channel('sess_a');
        const both = listeners();

        channel.attach(both.a);
        channel.attach(both.b);
        channel.dispose();

        expect(seenOf(both, 'a')).toEqual(['released']);
        expect(seenOf(both, 'b')).toEqual(['released']);
        expect(plane.unsubscribed).toEqual(['sub_1']);
        expect(broker.size()).toBe(0);

        // Safe twice: a second teardown changes nothing.
        channel.dispose();
        expect(plane.unsubscribed).toEqual(['sub_1']);
    });

    it('a listener that throws on release never blocks its peers or the unsubscribe', () => {
        const { plane, broker } = brokerOf();
        const channel = broker.channel('sess_a');
        const both = listeners();

        channel.attach({
            ...both.a,
            onReleased: () => {
                throw new Error('panel exploded');
            }
        });
        const releaseB = channel.attach(both.b);

        channel.dispose();

        expect(seenOf(both, 'b')).toEqual(['released']);
        expect(plane.unsubscribed).toEqual(['sub_1']);

        // The channel is gone, so a late detach is inert rather than fatal.
        releaseB();
        expect(plane.unsubscribed).toEqual(['sub_1']);
    });

    it('answers a late attach to a retired channel instead of leaving the panel frozen', () => {
        const { plane, broker } = brokerOf();
        const channel = broker.channel('sess_a');

        channel.attach(listeners().a);
        channel.dispose();

        const late = listeners();
        const detach = channel.attach(late.b);

        // Told through the same channel its peers used: it will never be woken.
        expect(seenOf(late, 'b')).toEqual(['released']);
        expect(plane.specs).toHaveLength(1);
        expect(channel.live()).toBe(false);

        detach();
        expect(plane.unsubscribed).toEqual(['sub_1']);
    });

    it('gives each conversation its own registration and never crosses their frames', () => {
        const { plane, broker } = brokerOf();
        const a = broker.channel('sess_a');
        const b = broker.channel('sess_b');
        const both = listeners();

        a.attach(both.a);
        b.attach(both.b);

        expect(plane.specs.map((spec) => spec.sessionId)).toEqual(['sess_a', 'sess_b']);
        expect(broker.size()).toBe(2);

        plane.callbacksOf(1).onUpdate?.(RECORDS_FRAME);

        expect(seenOf(both, 'a')).toEqual([]);
        expect(seenOf(both, 'b')).toEqual(['signal']);
        expect(a.frames()).toBe(0);
        expect(b.frames()).toBe(1);

        broker.disposeAll();

        expect(plane.unsubscribed).toEqual(['sub_1', 'sub_2']);
        expect(broker.size()).toBe(0);
    });
});

describe('records wake broker — fan-out', () => {
    it('delivers a records.updated frame to every attached panel, and only that kind', () => {
        const { plane, broker } = brokerOf();
        const channel = broker.channel('sess_a');
        const both = listeners();

        channel.attach(both.a);
        channel.attach(both.b);

        const onUpdate = plane.callbacksOf(0).onUpdate;
        onUpdate?.(SESSION_FRAME);
        expect(seenOf(both, 'a')).toEqual([]);
        expect(channel.frames()).toBe(0);

        onUpdate?.(RECORDS_FRAME);

        expect(seenOf(both, 'a')).toEqual(['signal']);
        expect(seenOf(both, 'b')).toEqual(['signal']);
        // The same watermark object for both: the broker copies nothing, rewrites nothing.
        expect(both.received.signals).toEqual([SIGNAL, SIGNAL]);
        expect(both.received.signals[0]).toBe(SIGNAL);
        expect(channel.frames()).toBe(1);
    });

    it('broadcasts the baseline, the gap and the refusal to every attached panel', () => {
        const { plane, broker } = brokerOf();
        const channel = broker.channel('sess_a');
        const both = listeners();

        channel.attach(both.a);
        channel.attach(both.b);

        const callbacks = plane.callbacksOf(0);
        callbacks.onState?.(BASELINE);
        callbacks.onResync?.(GAP);

        expect(seenOf(both, 'a')).toEqual(['baseline', 'gap']);
        expect(seenOf(both, 'b')).toEqual(['baseline', 'gap']);
        expect(both.received.baselines).toEqual([BASELINE, BASELINE]);
        expect(both.received.gaps).toEqual([GAP, GAP]);

        callbacks.onError?.({
            type: 'error',
            code: 'unknown_resource',
            message: 'unknown resource records:3f2a9c1b-7788-4a11-9d22-112233445566',
            retryable: false
        });

        // The uuid is shortened exactly as the client clips it, so a transport error
        // cannot wrap a 36-char id into a 320px rail.
        expect(seenOf(both, 'a')).toEqual(['baseline', 'gap', 'refused:unknown resource records:3f2a9c1b']);
        expect(seenOf(both, 'b')).toEqual(['baseline', 'gap', 'refused:unknown resource records:3f2a9c1b']);
    });

    it('reports a host with no realtime plane through onUnavailable, once per attached panel', () => {
        const { plane, broker } = brokerOf({ none: true });
        const channel = broker.channel('sess_a');
        const both = listeners();

        channel.attach(both.a);

        expect(seenOf(both, 'a')).toEqual(['unavailable:This host has no realtime plane for record updates.']);
        expect(channel.live()).toBe(false);

        // A second panel attaches to the same dead channel and is told the same thing.
        channel.attach(both.b);
        expect(seenOf(both, 'b')).toEqual(['unavailable:This host has no realtime plane for record updates.']);
        expect(plane.specs).toHaveLength(1);
    });

    it('reports a plane that throws, with the message clipped and no registration held', () => {
        const { plane, broker } = brokerOf({ throws: 'socket refused: 3f2a9c1b-7788-4a11-9d22-112233445566' });
        const channel = broker.channel('sess_a');
        const solo = listeners();

        const detach = channel.attach(solo.a);

        expect(seenOf(solo, 'a')).toEqual(['unavailable:socket refused: 3f2a9c1b']);
        expect(channel.live()).toBe(false);

        detach();
        expect(plane.unsubscribed).toEqual([]);
    });

    it('re-dials nothing after the plane refused, because that answer is final for this page', () => {
        const { plane, broker } = brokerOf({ none: true });
        const channel = broker.channel('sess_a');
        const both = listeners();

        channel.attach(both.a);
        channel.attach(both.b);

        expect(plane.specs).toHaveLength(1);
        expect(channel.attached()).toBe(2);
    });
});

describe('records wake broker — the shared instance behind attachRecordsWake', () => {
    it('puts two panels of one host on one channel and one registration', () => {
        const host = createPlane();
        const both = listeners();

        const tasks = attachRecordsWake('sess_a', both.a, host.seam);
        const records = attachRecordsWake('sess_a', both.b, host.seam);

        expect(tasks.channel).toBe(records.channel);
        expect(host.specs).toHaveLength(1);

        host.callbacksOf(0).onUpdate?.(RECORDS_FRAME);

        expect(seenOf(both, 'a')).toEqual(['signal']);
        expect(seenOf(both, 'b')).toEqual(['signal']);

        tasks.release();
        expect(host.unsubscribed).toEqual([]);

        records.release();
        expect(host.unsubscribed).toEqual(['sub_1']);
    });

    it('retires the previous broker when the seam moves to another plane, instead of orphaning it', () => {
        const hostA = createPlane();
        const hostB = createPlane();
        const both = listeners();

        const a = attachRecordsWake('sess_a', both.a, hostA.seam);
        const b = attachRecordsWake('sess_a', both.b, hostB.seam);

        expect(a.channel).not.toBe(b.channel);
        // A is retired by the seam move: its slot is released and its panel is told.
        expect(hostA.specs).toHaveLength(1);
        expect(hostA.unsubscribed).toEqual(['sub_1']);
        expect(seenOf(both, 'a')).toEqual(['released']);
        // B's plane holds the one live registration, and its frames reach B only.
        expect(hostB.specs).toHaveLength(1);

        hostB.callbacksOf(0).onUpdate?.(RECORDS_FRAME);
        expect(seenOf(both, 'a')).toEqual(['released']);
        expect(seenOf(both, 'b')).toEqual(['signal']);

        b.release();
        expect(hostB.unsubscribed).toEqual(['sub_1']);
    });

    it('releaseRecordsWake retires everything, and a later attach dials a fresh channel', () => {
        const host = createPlane();
        const first = listeners();
        const second = listeners();

        attachRecordsWake('sess_a', first.a, host.seam);

        releaseRecordsWake();

        expect(host.unsubscribed).toEqual(['sub_1']);
        expect(seenOf(first, 'a')).toEqual(['released']);

        const again = attachRecordsWake('sess_a', second.a, host.seam);

        expect(host.specs).toHaveLength(2);
        expect(seenOf(second, 'a')).toEqual([]);
        expect(again.channel.attached()).toBe(1);

        again.release();
        expect(host.unsubscribed).toEqual(['sub_1', 'sub_2']);
    });
});

// The per-listener log, read through the handler identity the fixture handed out.
const seenOf = (fixture: ReturnType<typeof listeners>, which: 'a' | 'b'): string[] => fixture.seen[which];
