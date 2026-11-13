// The lane-worker wire contract: frame vocabulary, envelope validation, the identity
// constants both sides must agree on, and the transferability guard.
//
// The constants are asserted as exact values on purpose: they ARE the contract. A
// silent change to the event window, the reclaim timer or the protocol version changes
// how a real deployment behaves (backpressure depth, cold-start patience, worker
// fan-out, and whether a built bundle is accepted at all).
//
// Cross-references:
//   - ./protocol.ts   - the implementation
//   - ./lane-commit.ts - MutationGroup / GroupOutcome carried by `mutation` / receipt
//   - ../config.ts    - the runtime configuration these defaults must match

import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNTIME_CONFIGURATION, MAX_LANE_WORKERS_LIMIT, WORKER_HANDSHAKE_MS_MIN } from '../config';
// The command UNION, imported as a type so the `satisfies LaneCommand` pin below is checked by
// the compiler: the frame's payload field names ARE the wire contract, and a union member nobody
// constructs cannot drift silently.
import type { LaneCommand } from './protocol';
import {
    LANE_EVENT_WINDOW,
    LANE_HANDSHAKE_MS,
    LANE_IDLE_MS,
    LANE_MAX_FRAME_BYTES,
    LANE_MAX_WORKERS,
    LANE_PROTOCOL_VERSION,
    createSequence,
    describeEnvelope,
    frameByteLength,
    isLaneCommandKind,
    isLaneEnvelope,
    isLaneReplyKind,
    isTransferableFrame
} from './protocol';

describe('lane protocol constants', () => {
    it('pins the contract a built worker bundle is checked against', () => {
        // Version 2 replaced the snapshot-sync frames with operation/receipt frames
        // (T3 findings F7-F10). Version 3 is the T10 correctness round: a partial commit
        // group now rolls EVERY operation back, `transcript:sync` / `thread:read` requests
        // exist, a transcript delta may be pushed to a live lane, a steering refusal is its
        // own non-terminal reply, and a registry broadcast carries the module revision in its
        // own field. A v2 worker answers none of that correctly, so it must be refused here
        // rather than run a turn on frames it half-understands.
        expect(LANE_PROTOCOL_VERSION).toBe(3);
        expect(LANE_EVENT_WINDOW).toBe(32);
        expect(LANE_IDLE_MS).toBe(120_000);
        expect(LANE_MAX_WORKERS).toBe(16);
        expect(LANE_HANDSHAKE_MS).toBe(60_000);
        expect(LANE_MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
    });

    it('keeps the protocol defaults identical to the runtime configuration defaults', () => {
        // The two layers must agree, or a built bundle would reclaim lanes on a timer
        // the server never advertises and HARNESS_WORKER_IDLE_MS would be a no-op.
        expect(LANE_IDLE_MS).toBe(DEFAULT_RUNTIME_CONFIGURATION.workerIdleMs);
        expect(LANE_MAX_WORKERS).toBe(DEFAULT_RUNTIME_CONFIGURATION.maxLaneWorkers);
        expect(LANE_HANDSHAKE_MS).toBe(DEFAULT_RUNTIME_CONFIGURATION.workerHandshakeMs);
        expect(LANE_MAX_WORKERS).toBeLessThanOrEqual(MAX_LANE_WORKERS_LIMIT);
        expect(LANE_HANDSHAKE_MS).toBeGreaterThanOrEqual(WORKER_HANDSHAKE_MS_MIN);
        expect(LANE_EVENT_WINDOW).toBeGreaterThan(1);
    });
});

describe('frame vocabulary', () => {
    it('names the coordinator commands, with no snapshot-sync frame left', () => {
        for (const kind of [
            'turn',
            'steer',
            'interrupt',
            'lease.grant',
            'request.reply',
            'mutation.receipt',
            'event.ack',
            'broadcast.registry',
            'sync.memory',
            // T10 finding M4: "canonical moved in the conversation you own - come and get the
            // messages you are missing". A pointer, not a state document.
            'sync.transcript',
            // R5b: "the session's tool switches moved - set your copy to these two lists".
            // The one WHOLESALE frame in the protocol, and the only one that exists because a
            // replica cannot derive the value itself: the switch lives on the coordinator's
            // harness, a closure cannot cross `worker_threads`, and until this frame nothing in
            // the vocabulary could TAKE a name away from a warm lane (the `sync.enabled` replay
            // in ./lane-worker-loop.ts is additive). ./protocol.ts:272-300 states why the
            // payload is two lists and why there is no receipt.
            'sync.tools',
            'dispose'
        ]) {
            expect(isLaneCommandKind(kind)).toBe(true);
            expect(isLaneReplyKind(kind)).toBe(false);
        }

        // `hello` is the one kind that exists in BOTH directions: the coordinator
        // sends the blueprint and the worker answers with its capability report.
        expect(isLaneCommandKind('hello')).toBe(true);
        expect(isLaneReplyKind('hello')).toBe(true);

        // `sync` (a whole-state frame) was the shape that let a replica believe it had
        // authoritative state; only the bounded memory window may be pushed now.
        expect(isLaneCommandKind('sync')).toBe(false);
        expect(isLaneReplyKind('sync')).toBe(false);
    });

    it('names the worker replies', () => {
        for (const kind of ['event', 'mutation', 'request', 'turn-done', 'aborted', 'steer.result', 'fault']) {
            expect(isLaneReplyKind(kind)).toBe(true);
            expect(isLaneCommandKind(kind)).toBe(false);
        }

        // The worker never acks its own mutation: that is the coordinator's frame.
        expect(isLaneReplyKind('mutation.receipt')).toBe(false);
        expect(isLaneReplyKind('event.ack')).toBe(false);

        // T10 finding M6: a steering refusal is a reply of its own, NOT a fault. A fault ends
        // the live turn at the host, and guidance that arrived at an unsteerable moment must
        // not destroy the run that is still executing.
        expect(isLaneReplyKind('steer.result')).toBe(true);
    });
});

describe('sync.tools — the R5b tool-state reconcile frame', () => {
    it('is a one-way command carrying exactly the two canonical lists', () => {
        // The frame AS THE HOST POSTS IT (./lane-host.ts `broadcastTools`, fed by
        // ./lane-authority.ts `toolStateNow`). `satisfies LaneCommand` is the load-bearing part
        // of this assertion: the payload field names are the wire contract, and a rename on
        // either side stops compiling here rather than arriving as a silently empty reconcile.
        const frame = {
            kind: 'sync.tools',
            laneEpoch: 7,
            tools: { enabled: ['timeNow'], withheld: ['glob'] }
        } satisfies LaneCommand;

        expect(isLaneEnvelope(frame)).toBe(true);
        expect(isLaneCommandKind(frame.kind)).toBe(true);
        // Coordinator -> worker ONLY. A worker that answered this frame would be a second
        // writer of the enabled set, which is the invariant ./lane-commit.ts protects.
        expect(isLaneReplyKind(frame.kind)).toBe(false);
        // ONE-WAY by construction: no `callId`, no `seq`, no `streamSeq` - there is no reply to
        // correlate and no receipt to advance a committed base. The envelope carries the epoch
        // and the state, and the state is complete, which is what makes a duplicate or a late
        // frame land the same set instead of corrupting it.
        expect(Object.keys(frame)).toEqual(['kind', 'laneEpoch', 'tools']);
        expect(Object.keys(frame.tools)).toEqual(['enabled', 'withheld']);
        // Both lists are plain string arrays: nothing in this frame can fail `postMessage`.
        expect(isTransferableFrame(frame)).toBe(true);
        // A frame for a lane that no longer exists is still a VALID envelope - the host and the
        // worker's own epoch guard decide what to do with it, the vocabulary does not.
        expect(isLaneEnvelope({ ...frame, laneEpoch: 0 })).toBe(true);
        expect(isLaneEnvelope({ ...frame, laneEpoch: -1 })).toBe(false);
        // An EMPTY reconcile is a real answer ("nothing enabled, nothing switched off"), not an
        // absent frame, so it must stay accepted: the applier prunes and withdraws accordingly.
        expect(isLaneEnvelope({ kind: 'sync.tools', laneEpoch: 1, tools: { enabled: [], withheld: [] } })).toBe(true);
    });
});

describe('isLaneEnvelope', () => {
    it('accepts a well-formed command and reply', () => {
        const hello = { kind: 'hello', laneEpoch: 3, blueprint: { identities: {}, memoryKeys: [] } };
        const event = { kind: 'event', laneEpoch: 3, turnId: 'turn-1', streamSeq: 1, event: { type: 'start' } };
        const receipt = { kind: 'mutation.receipt', laneEpoch: 3, seq: 1, outcome: { seq: 1, status: 'applied', receipts: [], complete: true } };

        expect(isLaneEnvelope(hello)).toBe(true);
        expect(isLaneEnvelope(event)).toBe(true);
        expect(isLaneEnvelope(receipt)).toBe(true);
    });

    it('rejects a frame with no kind, a bad epoch, or an unknown kind', () => {
        expect(isLaneEnvelope(undefined)).toBe(false);
        expect(isLaneEnvelope(null)).toBe(false);
        expect(isLaneEnvelope('hello')).toBe(false);
        expect(isLaneEnvelope({ laneEpoch: 1 })).toBe(false);
        expect(isLaneEnvelope({ kind: 'hello' })).toBe(false);
        expect(isLaneEnvelope({ kind: 'hello', laneEpoch: '3' })).toBe(false);
        expect(isLaneEnvelope({ kind: 'hello', laneEpoch: 1.5 })).toBe(false);
        // A negative epoch is not a minted one: the coordinator starts at 0.
        expect(isLaneEnvelope({ kind: 'dispose', laneEpoch: -1 })).toBe(false);
        expect(isLaneEnvelope({ kind: 'sync', laneEpoch: 1 })).toBe(false);
        expect(isLaneEnvelope({ kind: 'teleport', laneEpoch: 1 })).toBe(false);
    });

    it('accepts epoch 0, the first epoch a lane ever sees', () => {
        expect(isLaneEnvelope({ kind: 'dispose', laneEpoch: 0 })).toBe(true);
    });
});

describe('describeEnvelope', () => {
    it('names the offender without echoing a payload', () => {
        expect(
            describeEnvelope({ kind: 'teleport', laneEpoch: 4, event: { type: 'text', delta: 'x'.repeat(5000) } })
        ).toBe('kind="teleport" laneEpoch=4');
        expect(describeEnvelope(undefined)).toBe('undefined');
        expect(describeEnvelope(7)).toBe('number');
    });
});

describe('frame transferability', () => {
    it('accepts plain data and refuses a live closure', () => {
        expect(isTransferableFrame({ kind: 'event', laneEpoch: 1, event: { type: 'done' } })).toBe(true);
        expect(isTransferableFrame({ kind: 'event', map: new Map([['k', 1]]), when: new Date(0), big: 1n })).toBe(true);
        expect(isTransferableFrame({ kind: 'event', handler: () => 'live' })).toBe(false);
    });

    it('proves why cancellation is a FRAME and never a transferred signal (F9)', () => {
        // A structured clone does not carry an AbortSignal at all: on Node 24 it
        // arrives as an EMPTY OBJECT, so the run's cancellation state is silently gone.
        // Transferability alone is therefore not enough - the protocol refuses to ship
        // signals and carries `interrupt` instead.
        const controller = new AbortController();

        controller.abort();

        const transferred = structuredClone({ signal: controller.signal }) as { signal: { aborted?: boolean } };

        expect(transferred.signal).toEqual({});
        expect(transferred.signal.aborted).toBeUndefined();
        // The frame check passes, which is exactly why the rule has to be explicit.
        expect(isTransferableFrame(transferred)).toBe(true);
    });

    it('measures a payload and refuses to measure an un-clonable one', () => {
        const size = frameByteLength({ kind: 'mutation', laneEpoch: 1, group: { seq: 1, laneEpoch: 1, ops: [] } });

        expect(typeof size).toBe('number');
        expect(size).toBeGreaterThan(0);
        expect(size).toBeLessThan(LANE_MAX_FRAME_BYTES);
        expect(frameByteLength({ kind: 'mutation', handler: () => 1 })).toBeUndefined();
    });
});

describe('createSequence', () => {
    it('starts at 1 so 0 always means "nothing has been sent yet"', () => {
        const next = createSequence();

        expect([next(), next(), next()]).toEqual([1, 2, 3]);
        expect(createSequence(9)()).toBe(9);
    });

    it('gives independent counters to independent callers', () => {
        const events = createSequence();
        const calls = createSequence();

        events();
        events();

        expect(calls()).toBe(1);
        expect(events()).toBe(3);
    });
});
