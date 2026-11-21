// T13 — a PROVIDER-CLASSIFIED retry on the live compiled plane.
//
// WHY THESE TESTS EXIST. The live WebSocket plane carries `TurnDisplayOp`s only
// (`ViewStreamItem` = view | ops | thread | header | failed); a raw `HarnessEvent` never
// crosses `harness.v1`. So the `retry` frame's `provider` block (../types/index.ts
// `HarnessProviderAttemptDiagnostics`, T6) — the one part of a retry a reader can act on —
// could not reach the browser while the 11-attempt ladder burned: the raw watcher prints it
// (../frontend/ui/turns.ts:9338-9374, T9) and the live board showed a bare spinner. The
// projector now mints an `error`-tone notice for it, and these tests pin every consequence.
//
// What each group is accountable for:
//   AC1  the emitted node (exact tone, id, text, `at`) and the FIXED frontend selector it
//        feeds — `paintCompiledNotice` (../frontend/ui/turns.ts:7836-7877) renders
//        `.agent-notice[data-tone=error][data-provider=<class>]` with `<class>` as the
//        label span, and it recovers that class from the node TEXT via `providerFailureOf`
//        (../frontend/provider-diagnostics.ts:222-238). The class is therefore asserted
//        with a local mirror of that message fallback (the UI package is not published,
//        so the server suite cannot import it).
//   AC2  an UNCLASSIFIED retry (`provider` absent) projects the byte-identical node
//        sequence it had before this handler existed — asserted against the pre-change op
//        arrays copied from the T16/R16a block in ./turn-projector.test.ts:767-776.
//   AC3  node identity/order under replay, restore and reconnect: the same event sequence
//        folded twice answers identical ops and an identical tree, and a cold fold
//        (`projectTurn`/`refoldTurn`, what a reload and a resync serve) equals the live
//        tree with exactly one notice per retry frame.
//
// Tone evidence (why `error`, never `retry`): the renderer suppresses ONLY
// `tone === 'retry'` (../frontend/ui/turns.ts:7840), and `error` is the single tone whose
// provider rendering exists on the compiled plane (../frontend/ui/turns.ts:7858). A new
// `provider` tone would be a wire change: `DisplayNode.tone` is a CLOSED enum of the six
// documented tones (../shared/harness-api.ts:3378, generated from
// ../harness-server.swagger.yaml), so it is not available without a contract edit.
//
// Run: yarn vitest run src/server/turn-projector-provider-retry.test.ts   (cwd packages/underload/harness)
// Frontend regression for the consumer side:
//   yarn vitest run --config src/frontend/vitest.config.ts src/frontend/ui/provider-tile-diagnostics.test.ts

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../engine/harness';
import type { DisplayNoticeNode, DisplayProjectContext } from '../engine/shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn, refoldTurn, providerRetryNoticeText } from './turn-projector';

// Local mirror of the frontend's `providerFailureOf` message fallback (the class is read from
// the notice text). The UI package is not published, so the server suite cannot import it; the
// server sentence is what this suite pins, and the UI package owns its classifier tests.
const providerLabelOf = (message: string): string | undefined => {
    if (message.includes('provider-timeout')) return 'provider-timeout';
    if (message.includes('provider-connection')) return 'provider-connection';
    return undefined;
};

const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'do the thing',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: [],
    ...overrides
});

const CONTEXT: DisplayProjectContext = { entry: 'one' };

// One recorded event per 10 ms, so every `at` is an exact number (same rule as
// ./turn-projector.test.ts:46, which keeps the two files' timestamps comparable).
const timeOf = (index: number): number => 1_000 + index * 10;

const timesOf = (events: HarnessEvent[]): number[] => events.map((_event, index) => timeOf(index));

type Folded = {
    per: ReturnType<ReturnType<typeof createTurnProjector>['apply']>[];
    display: () => ReturnType<ReturnType<typeof createTurnProjector>['display']>;
    summary: () => ReturnType<ReturnType<typeof createTurnProjector>['summary']>;
    settle: (status: 'done' | 'error' | 'cancelled') => void;
};

// The live path: push the record, then fold it — the store recorder's own order
// (./sessions.ts), and the reason a passing fold here is also a parity result.
const fold = (events: HarnessEvent[], turn: SessionTurn = turnOf(), context = CONTEXT): Folded => {
    const projector = createTurnProjector(turn, context);
    const per: Folded['per'] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        turn.eventTimes?.push(timeOf(index));

        per.push(projector.apply(event, timeOf(index), index));
    });

    return {
        per,
        display: () => projector.display(),
        summary: () => projector.summary(),
        settle: (status) => {
            projector.settle(status, 5_000);
        }
    };
};

// Every notice the compiled surface holds, in section order (same accessor as
// ./turn-projector.test.ts:755).
const noticesOf = (display: ReturnType<typeof projectTurn>['display']): DisplayNoticeNode[] =>
    display.sections.flatMap((section) => section.nodes).filter((node) => node.kind === 'notice') as DisplayNoticeNode[];

const idsOf = (display: ReturnType<typeof projectTurn>['display']): string[] =>
    display.sections.flatMap((section) => section.nodes.map((node) => node.id));

// ---------------------------------------------------------------------------
// The frames under test
// ---------------------------------------------------------------------------

// The stuck-run frame T9 pinned on the RAW plane, at
// ../frontend/ui/provider-tile-diagnostics.test.ts:45-53 — the same facts, so the two
// render paths must state the same sentence.
const PROVIDER_URL = 'http://localhost:5500/providers/private/v1';

const connectionRetry = (): HarnessEvent =>
    ({
        type: 'retry',
        agent: 'one',
        attempt: 6,
        maxAttempts: 11,
        delayMs: 32_000,
        error: { message: 'fetch failed' },
        provider: { errorClass: 'provider-connection', url: PROVIDER_URL, port: 5500, errno: 'ECONNREFUSED' }
    }) as HarnessEvent;

// The same request one attempt later: a TIMEOUT class, which names a bound and a phase
// instead of an errno.
const timeoutRetry = (): HarnessEvent =>
    ({
        type: 'retry',
        agent: 'one',
        attempt: 7,
        maxAttempts: 11,
        delayMs: 45_000,
        error: { message: 'first token bound expired' },
        provider: { errorClass: 'provider-timeout', url: PROVIDER_URL, port: 5500, phase: 'first-token', timeoutMs: 30_000 }
    }) as HarnessEvent;

// The line the frontend prints, verbatim from the node text (its text span is verbatim by
// contract, ../frontend/ui/turns.ts:7862).
const CONNECTION_LINE = `provider-connection: attempt 6 of 11 failed \u00b7 retrying in 32.0s \u00b7 ECONNREFUSED \u00b7 ${PROVIDER_URL}`;
const TIMEOUT_LINE = `provider-timeout: attempt 7 of 11 failed \u00b7 retrying in 45.0s \u00b7 first token bound expired \u00b7 ${PROVIDER_URL}`;

// One request through two provider failures into the answer that commits.
const providerLadder = (): HarnessEvent[] => [
    { type: 'start', agent: 'one', model: 'gpt-x' },
    { type: 'text', agent: 'one', delta: 'partial one' },
    connectionRetry(),
    { type: 'text', agent: 'one', delta: 'partial two' },
    timeoutRetry(),
    { type: 'text', agent: 'one', delta: 'the answer' },
    { type: 'attempt_commit', agent: 'one', attempt: 8, maxAttempts: 11 } as HarnessEvent
];

// The SAME run with an ordinary (HTTP 5xx) failure: no `provider` block, so nothing new
// may appear anywhere.
const ordinaryLadder = (): HarnessEvent[] => [
    { type: 'start', agent: 'one', model: 'gpt-x' },
    { type: 'text', agent: 'one', delta: 'partial one' },
    { type: 'retry', agent: 'one', attempt: 1, maxAttempts: 11, delayMs: 1_000, error: { message: 'Request failed: HTTP 500' } } as HarnessEvent,
    { type: 'text', agent: 'one', delta: 'partial two' },
    { type: 'retry', agent: 'one', attempt: 2, maxAttempts: 11, delayMs: 2_000, error: { message: 'Request failed: HTTP 502' } } as HarnessEvent,
    { type: 'text', agent: 'one', delta: 'the answer' },
    { type: 'attempt_commit', agent: 'one', attempt: 3, maxAttempts: 11 } as HarnessEvent,
    { type: 'error', agent: 'one', error: { message: 'Request failed: HTTP 503' } } as HarnessEvent
];

// ---------------------------------------------------------------------------
// AC1 — the notice reaches the compiled plane, in a tone the board prints
// ---------------------------------------------------------------------------

describe('a provider-classified retry mints a compiled notice (T13, AC1)', () => {
    it('emits the notice in the same frame, after the discard it describes', () => {
        const result = fold(providerLadder().slice(0, 3));

        // The exact op list of the retry frame. Order is load-bearing: `attempt:discard`
        // removes the failed attempt's rows FIRST, then the line naming that attempt joins
        // the end, then the tail pass reports the section has no content block left. The
        // notice is not attempt-owned (`noticeNode` passes `attemptOwned: false`), so the
        // very discard beside it can never remove it.
        expect(result.per[2]).toEqual([
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-1' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n1'] },
            {
                op: 'node:insert',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                node: { kind: 'notice', id: 'n2', tone: 'error', text: CONNECTION_LINE, at: 1_020 }
            },
            { op: 'tail:clear', turnId: 'turn-1', sectionId: 'turn-1:0' }
        ]);

        // The cold tree carries the same node, so a reload shows what the stream showed.
        expect(noticesOf(result.display())).toEqual([
            { kind: 'notice', id: 'n2', tone: 'error', text: CONNECTION_LINE, at: 1_020 }
        ]);
    });

    it('feeds the fixed frontend selector: data-tone=error, data-provider=<class>, label=<class>', () => {
        const result = fold(providerLadder().slice(0, 3));
        const [notice] = noticesOf(result.display());

        // `paintCompiledNotice` sets `line.dataset.tone = node.tone` and suppresses only
        // `retry` (../frontend/ui/turns.ts:7840,7850) — so `error` paints, and the selector
        // the provider line matches is `.agent-notice[data-tone=error][data-provider=…]`.
        expect(notice.tone).toBe('error');

        // The class is what the frontend recovers FROM THE TEXT (../frontend/ui/turns.ts:7858
        // calls `providerFailureOf({ message: node.text })`), and its `label` becomes both
        // `data-provider` and the `.agent-notice-label` span. Asserted with the local mirror,
        // so the server sentence still carries the token that classifier keys on.
        expect(providerLabelOf(notice.text)).toBe('provider-connection');

        // A provider-classified timeout is labelled with ITS class — the sentence names it.
        const timedOut = fold(providerLadder().slice(0, 5));
        const timeoutNotice = noticesOf(timedOut.display())[1];

        expect(timeoutNotice.text).toBe(TIMEOUT_LINE);
        expect(providerLabelOf(timeoutNotice.text)).toBe('provider-timeout');

        // And the class token is load-bearing, not decoration: strip it and the same
        // sentence is no longer a provider line, which is why the server states it.
        expect(providerLabelOf('attempt 6 of 11 failed \u00b7 retrying in 32.0s \u00b7 ECONNREFUSED')).toBeUndefined();
    });

    it('keeps the turn running: no error state and no turn-level error detail', () => {
        const result = fold(providerLadder().slice(0, 5));

        // A retry is the server still working, so ONLY the notice node changes. The section
        // stays `streaming` (the tile's status source, ../frontend/ui/turns.ts:5376) and the
        // row keeps `status: running` with no failure `detail` — the real failure, if the
        // budget runs out, is still the terminal `error` frame's own notice.
        expect(result.display().sections.map((section) => [section.id, section.state])).toEqual([['turn-1:0', 'streaming']]);
        expect(result.summary()).toMatchObject({ status: 'running', state: 'streaming', stepCount: 0, activeAgents: ['one'] });
        expect(result.summary().detail).toBeUndefined();

        // Two provider failures, two lines, in stream order — and the run is still open, so
        // these two notices are the section's ONLY nodes (the failed attempts' prose is gone
        // with them; the full ladder, including the answer, is pinned in the AC3 group).
        expect(idsOf(result.display())).toEqual(['n2', 'n4']);
    });
});

// ---------------------------------------------------------------------------
// AC2 — an unclassified retry is untouched, byte for byte
// ---------------------------------------------------------------------------

describe('a retry WITHOUT provider is byte-identical to before (T13, AC2)', () => {
    it('sends exactly the pre-change op sequence for each ordinary retry frame', () => {
        const result = fold(ordinaryLadder().slice(0, 5));

        // These two arrays are the PRE-CHANGE expectations, copied verbatim from the
        // T16/R16a block of ./turn-projector.test.ts:767-776. Nothing is added, removed or
        // reordered: `provider` absent means this handler does only what it did before.
        expect(result.per[2]).toEqual([
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-1' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n1'] },
            { op: 'tail:clear', turnId: 'turn-1', sectionId: 'turn-1:0' }
        ]);
        expect(result.per[4]).toEqual([
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-3' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n3'] },
            { op: 'tail:clear', turnId: 'turn-1', sectionId: 'turn-1:0' }
        ]);

        expect(noticesOf(result.display())).toEqual([]);
    });

    it('leaves one notice in the whole exhausted 11-attempt ladder: the terminal error', () => {
        const sequence = ordinaryLadder();
        const live = fold(sequence);

        live.settle('error');

        // Mirrors ./turn-projector.test.ts:807-821: the silence is still total for an
        // unclassified run, and the ONLY notice is the turn's own failure.
        expect(noticesOf(live.display())).toEqual([
            { kind: 'notice', id: 'n7', tone: 'error', text: 'Request failed: HTTP 503', at: 1_070 }
        ]);

        const cold = projectTurn(turnOf({ status: 'error', updatedAt: 5_000, events: [...sequence], eventTimes: timesOf(sequence) }), CONTEXT);

        expect(cold.display).toEqual(live.display());
        expect(JSON.stringify(cold.display)).not.toContain('retry');
    });

    it('stays silent when provider is present but the frame numbers are unusable', () => {
        // The raw plane prints nothing for this frame either (`providerRetryNote`,
        // ../frontend/provider-diagnostics.ts:194-198), so the compiled plane must not
        // invent a ladder count out of a NaN.
        const broken = (): HarnessEvent =>
            ({
                type: 'retry',
                agent: 'one',
                attempt: 1,
                maxAttempts: 11,
                delayMs: Number.NaN,
                error: { message: 'fetch failed' },
                provider: { errorClass: 'provider-connection', url: PROVIDER_URL, port: 5500 }
            }) as unknown as HarnessEvent;

        const result = fold([
            { type: 'start', agent: 'one', model: 'gpt-x' },
            { type: 'text', agent: 'one', delta: 'partial one' },
            broken()
        ]);

        expect(result.per[2]).toEqual([
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:0', blockId: '0-assistant-1' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:0', nodeIds: ['n1'] },
            { op: 'tail:clear', turnId: 'turn-1', sectionId: 'turn-1:0' }
        ]);
        expect(noticesOf(result.display())).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// AC3 — identity under replay, restore and reconnect
// ---------------------------------------------------------------------------

describe('the provider notice survives replay, restore and reconnect (T13, AC3)', () => {
    it('folds the same sequence twice to identical ops and an identical tree', () => {
        const sequence = providerLadder();
        const first = fold(sequence);
        const second = fold(sequence);

        // Two independent live passes over the same records: the ops are equal frame by
        // frame, so a client that missed nothing and a client that resynced both land on the
        // same board, and no provider line is sent twice.
        expect(second.per).toEqual(first.per);
        expect(second.display()).toEqual(first.display());

        // One notice per retry frame, at the frame's own event index, in stream order.
        expect(noticesOf(first.display())).toEqual([
            { kind: 'notice', id: 'n2', tone: 'error', text: CONNECTION_LINE, at: 1_020 },
            { kind: 'notice', id: 'n4', tone: 'error', text: TIMEOUT_LINE, at: 1_040 }
        ]);
        expect(idsOf(first.display())).toEqual(['n2', 'n4', 'n5']);
    });

    it('answers a reload and a reconnect with that same tree, without duplicating a line', () => {
        const sequence = providerLadder();
        const live = fold(sequence);
        const stored = turnOf({ events: [...sequence], eventTimes: timesOf(sequence) });

        // Reload (`getView`) and reconnect (the store refolds the cache) are cold folds of
        // the SAME record, twice over. Each must equal the live tree exactly — the identity
        // rule at the top of ./turn-projector.ts, now covering the provider line too.
        const reloaded = projectTurn(stored, CONTEXT);
        const resynced = refoldTurn(stored, CONTEXT);

        expect(reloaded.display).toEqual(live.display());
        expect(resynced.display()).toEqual(live.display());
        expect(reloaded.summary).toEqual(live.summary());

        // A partial live run resumed by a full cold fold (the resync_required path: the
        // client restarts from REST reads) still holds exactly two lines, not four.
        const partial = fold(sequence.slice(0, 5));
        const resumed = refoldTurn(
            turnOf({ events: [...sequence], eventTimes: timesOf(sequence) }),
            CONTEXT
        );

        expect(noticesOf(resumed.display())).toEqual(noticesOf(live.display()));
        expect(noticesOf(partial.display()).map((node) => node.id)).toEqual(['n2', 'n4']);
    });

    it('settles a turn that ended after a provider retry without touching its lines', () => {
        const sequence = providerLadder();
        const live = fold(sequence);

        live.settle('done');

        // `settle` closes sections; it mints no notice of its own, so a turn that answered
        // after the ladder keeps exactly the two provider lines it streamed.
        expect(noticesOf(live.display()).map((node) => node.id)).toEqual(['n2', 'n4']);
        expect(live.display().sections.map((section) => section.state)).toEqual(['done']);
    });
});

// ---------------------------------------------------------------------------
// The sentence itself (the frontend prints this text verbatim, so every segment is pinned)
// ---------------------------------------------------------------------------

describe('providerRetryNoticeText states only what the frame carried', () => {
    it('mirrors the raw plane sentence, class-prefixed, with the frame numbers and target', () => {
        expect(providerRetryNoticeText({
            attempt: 6,
            maxAttempts: 11,
            delayMs: 32_000,
            error: { message: 'fetch failed' },
            provider: { errorClass: 'provider-connection', url: PROVIDER_URL, port: 5500, errno: 'ECONNREFUSED' }
        })).toBe(CONNECTION_LINE);
    });

    it('states the bare port when the frame has no url, and no target when it has neither', () => {
        expect(providerRetryNoticeText({
            attempt: 1,
            maxAttempts: 3,
            delayMs: 1_000,
            error: { message: '' },
            provider: { errorClass: 'provider-timeout', url: '', port: 5500, phase: 'first-token', timeoutMs: 30_000 }
        })).toBe('provider-timeout: attempt 1 of 3 failed \u00b7 retrying in 1.0s \u00b7 port 5500');

        expect(providerRetryNoticeText({
            attempt: 1,
            maxAttempts: 2,
            delayMs: 2_000,
            error: { message: 'boom' },
            provider: { errorClass: 'provider-connection', url: '' }
        })).toBe('provider-connection: attempt 1 of 2 failed \u00b7 retrying in 2.0s \u00b7 boom');
    });

    it('falls back to the error message when the frame names no errno', () => {
        expect(providerRetryNoticeText({
            attempt: 2,
            maxAttempts: 3,
            delayMs: 0,
            error: { message: 'socket hung up' },
            provider: { errorClass: 'provider-timeout', url: 'http://localhost:5500/v1', timeoutMs: 30_000 }
        })).toBe('provider-timeout: attempt 2 of 3 failed \u00b7 retrying in 0ms \u00b7 socket hung up \u00b7 http://localhost:5500/v1');
    });

    it('prints an unknown class verbatim rather than relabelling it (../frontend/provider-diagnostics.ts:41-45)', () => {
        expect(providerRetryNoticeText({
            attempt: 2,
            maxAttempts: 3,
            delayMs: 500,
            error: { message: 'x' },
            provider: { errorClass: 'provider-weird', url: 'http://h:1/' }
        })).toBe('provider-weird: attempt 2 of 3 failed \u00b7 retrying in 500ms \u00b7 x \u00b7 http://h:1/');
    });

    it('answers undefined for no provider block, and for an unusable attempt, max or delay', () => {
        expect(providerRetryNoticeText({ attempt: 1, maxAttempts: 2, delayMs: 1, error: { message: 'x' } })).toBeUndefined();

        expect(providerRetryNoticeText({
            attempt: Number.NaN,
            maxAttempts: 2,
            delayMs: 1,
            error: { message: 'x' },
            provider: { errorClass: 'provider-timeout', url: 'u' }
        })).toBeUndefined();

        expect(providerRetryNoticeText({
            attempt: 1,
            maxAttempts: 2,
            delayMs: -1,
            error: { message: 'x' },
            provider: { errorClass: 'provider-timeout', url: 'u' }
        })).toBeUndefined();

        expect(providerRetryNoticeText({
            attempt: 1,
            maxAttempts: 2,
            delayMs: 1,
            error: { message: 'x' },
            provider: null
        })).toBeUndefined();
    });
});
