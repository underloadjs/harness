// T4 (data plane) — the stream tables the `records.updated` kind depends on.
//
// WHY THIS FILE EXISTS. `./protocol.ts` is the hand-written mirror of the contract's
// `x-websocket` extension in ../harness.swagger.yaml: three tables (which kinds a scope
// publishes, which counters a subscription bootstraps against, which counters one kind
// moves) plus the two link builders that tell a client WHERE to re-read. The rest of the
// stream suite tests the broker's behavior; nothing pinned the tables themselves, and the
// record store's first change to this file exposed that — adding a `StreamResourceKind`
// moves `revision_records_per_state`, which is the frame-size bound the whole protocol
// rests on.
//
// THE COUPLING WORTH LOCKING: `x-websocket.limits.revision_records_per_state` (yaml:3116)
// is "one revision record per publishable resource kind", so the session baseline set can
// never exceed it, and the limit can never disagree with `HARNESS_STREAM_RESOURCE_KINDS`
// (which ../harness-api.test.ts pins to the kind count). Those two facts together are why
// `records` moving the limit from 20 to 21 is a deliberate contract change rather than a
// stray number.
//
// Cross-references:
//   - ./protocol.ts                   — the tables under test
//   - ./mount.ts                      — `hubResourceId` (the hub's id for a resource kind)
//   - ../api-events.ts                — `resourceBaselineLink` (the link a resync hands out)
//   - ../harness.swagger.yaml         — `WsUpdateKind`, `StreamResourceKind`,
//                                       `subscription_scopes[].publishes`, `x-websocket.limits`

import { describe, expect, it } from 'vitest';
import {
    HARNESS_WS_KIND_RESOURCES,
    HARNESS_WS_SCOPE_BASELINES,
    HARNESS_WS_SCOPE_PUBLISHES,
    defaultStreamLink,
    isKindPublishedTo,
    streamResourceIdFor
} from './protocol';
import { hubResourceId } from './mount';
import { resourceBaselineLink } from '../api-events';
import { HARNESS_STREAM_RESOURCE_KINDS, HARNESS_WS_STREAM_LIMITS, HARNESS_WS_UPDATE_KINDS } from '../../shared/harness-stream';

describe('the records scope tables', () => {
    it('publishes records.updated to the session scope, at the contract position', () => {
        // Verbatim from `x-websocket.subscription_scopes[scope=session].publishes`
        // (../harness.swagger.yaml:3013). Order matters here because this array IS the answer a
        // `subscription_state` frame carries in `publishes`.
        expect(HARNESS_WS_SCOPE_PUBLISHES.session).toEqual([
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

        // Records belong to a session and nowhere else: a thread pane or a turn pane that started
        // receiving store watermarks would be rendering state it cannot address.
        expect(HARNESS_WS_SCOPE_PUBLISHES.global).toEqual(['catalogue.updated', 'config.updated']);
        expect(HARNESS_WS_SCOPE_PUBLISHES.thread).toEqual(['transcript.updated', 'thread.upsert']);
        expect(HARNESS_WS_SCOPE_PUBLISHES.turn).toEqual(['display.ops', 'usage.updated', 'turn.upsert']);

        expect(isKindPublishedTo('session', 'records.updated')).toBe(true);
        expect(isKindPublishedTo('thread', 'records.updated')).toBe(false);
        expect(isKindPublishedTo('turn', 'records.updated')).toBe(false);
        expect(isKindPublishedTo('global', 'records.updated')).toBe(false);
    });

    it('bootstraps a session subscription against a baseline that includes the record store', () => {
        // The session baseline is the closed set the subscribe answer reports, so a records panel
        // learns its starting position from the frame that confirms the subscription — no extra
        // read, and no gap between "subscribed" and "knows where the store is".
        expect(HARNESS_WS_SCOPE_BASELINES.session).toEqual([
            'session',
            'definition',
            'turns',
            'queue',
            'actions',
            'usage',
            'threads',
            'session_agents',
            'session_tools',
            'commands',
            'records'
        ]);
        expect(HARNESS_WS_SCOPE_BASELINES.global).toEqual(['harnesses', 'agents', 'tools', 'config']);
        expect(HARNESS_WS_SCOPE_BASELINES.thread).toEqual(['thread', 'transcript']);
        expect(HARNESS_WS_SCOPE_BASELINES.turn).toEqual(['turn', 'turn_display', 'turn_events']);

        // THE bound: every scope's baseline must fit in one `subscription_state` frame, and the
        // limit is defined as the number of published resource kinds.
        for (const scope of ['global', 'session', 'thread', 'turn'] as const) {
            expect(HARNESS_WS_SCOPE_BASELINES[scope].length).toBeLessThanOrEqual(
                HARNESS_WS_STREAM_LIMITS.revision_records_per_state
            );
        }
        expect(HARNESS_WS_STREAM_LIMITS.revision_records_per_state).toBe(HARNESS_STREAM_RESOURCE_KINDS.length);
        expect(HARNESS_WS_STREAM_LIMITS.revision_records_per_state).toBe(21);
    });

    it('moves exactly the records counter, and no other kind moves it', () => {
        // `records` is ONE counter domain: whatever the mutation touched, a panel's question is
        // "is my projection current". Every other kind keeps its own counters untouched, which is
        // what stops a record edit from invalidating a turn pane's cached rows.
        expect(HARNESS_WS_KIND_RESOURCES['records.updated']).toEqual(['records']);

        for (const kind of HARNESS_WS_UPDATE_KINDS) {
            if (kind === 'records.updated') continue;

            expect(HARNESS_WS_KIND_RESOURCES[kind]).not.toContain('records');
        }
    });

    it('links the records resource at its canonical read, with no invented page size', () => {
        // Two builders, one truth: the broker's default link and the hub's baseline link must be
        // byte-identical, or a client that re-reads after a resync and a client that re-reads after
        // `resync_required` would land on different shapes of the same resource.
        expect(defaultStreamLink('records', { session_id: 's1', thread_id: 't1', turn_id: 'u1' })).toBe(
            '/v1/harness/sessions/s1/records'
        );
        expect(resourceBaselineLink('records', 's1')).toBe('/v1/harness/sessions/s1/records');
        // No `?limit`: the snapshot is bounded by the engine's own caps and its continuation
        // cursor is `?since=`, a store position an offset could not express.
        expect(defaultStreamLink('records', { session_id: 's1' }).includes('?')).toBe(false);

        // A missing session id degrades to the root path, like every other session-scoped kind —
        // an unresolvable baseline is "restart from REST", never a crash.
        expect(defaultStreamLink('records', {})).toBe('/v1/harness/sessions//records');
    });

    it('addresses the records counter by the session id, in both id resolvers', () => {
        // The broker routes on plain scope ids and the hub keys resources the same way, so a
        // published `records` counter and a session subscription must land on one key. A composite
        // id here would strand every frame.
        expect(streamResourceIdFor('records', { session_id: 's1', thread_id: 't1', turn_id: 'u1' })).toBe('s1');
        expect(hubResourceId('records', { session_id: 's1' })).toBe('s1');
        expect(hubResourceId('records', {})).toBeNull();
    });
});
