// The provider diagnostics ON THE TILE (T9 / AC2 + AC3).
//
// Two render paths, one rule: a provider-CLASSIFIED frame gets a line the reader can act
// on, and an unclassified frame renders exactly what it rendered before.
//
//   1. the RAW event fold (`tile.apply(event)`) — the frontend's own reducer, which is where
//      a `retry` frame's `provider` block (../types/index.ts:3337-3350, T6) lands:
//        retry + provider   → `provider · attempt 6 of 11 failed · retrying in 32.0s · ECONNREFUSED · http://localhost:5500/providers/private/v1`
//        retry, no provider → NOTHING (the T19/R19 silence ui/turns-retry.test.ts pins);
//        error  + class     → the red block, labelled with the CLASS and pointing at the address;
//        error, no class    → `error` + the message, byte-identical to before.
//   2. the COMPILED path (`board.applyViewOps`) — the live browser plane, whose terminal
//      failure is an `error`-tone notice node whose TEXT is the server's own sentence. There
//      the class moves into the label and `data-provider`; the text stays verbatim, because
//      the sentence is the diagnosis and its host:port is already inside it.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts src/frontend/ui/provider-tile-diagnostics.test.ts

import type { SessionView } from '../../server/protocol';
import type { HarnessEvent } from '../../types';
import type { TurnDisplayOp, TurnSection, TurnSummary } from '../../shared/turn-display';
import type { TurnBoard } from './turns';
import { createTurnBoard } from './turns';
import { applyOpsToDisplay } from '../view-state';

const T = 1_700_000_000_000;
const STUCK_URL = 'http://localhost:5500/providers/private/v1';

// ---------------------------------------------------------------------------
// Raw fold fixtures (same shape ui/turns-retry.test.ts uses)
// ---------------------------------------------------------------------------

const mountRaw = (): TurnBoard => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    document.body.replaceChildren(board.element);
    return board;
};

const start = (): HarnessEvent => ({ type: 'start', agent: 'writer', model: 'm1' });
const text = (delta: string): HarnessEvent => ({ type: 'text', agent: 'writer', delta });

// A classified provider retry: the recorded stuck-run frame, `provider` included.
const providerRetry = (): HarnessEvent =>
    ({
        type: 'retry',
        agent: 'writer',
        attempt: 6,
        maxAttempts: 11,
        delayMs: 32_000,
        error: { message: `Request to ${STUCK_URL}/chat/completions failed: fetch failed` },
        provider: { errorClass: 'provider-connection', url: STUCK_URL, port: 5500, errno: 'ECONNREFUSED' }
    }) as unknown as HarnessEvent;

// The same frame WITHOUT the diagnostics block — an ordinary retried request.
const plainRetry = (): HarnessEvent =>
    ({
        type: 'retry',
        agent: 'writer',
        attempt: 1,
        maxAttempts: 11,
        delayMs: 1_000,
        error: { message: 'HTTP 500: overloaded' }
    }) as unknown as HarnessEvent;

// ---------------------------------------------------------------------------
// Compiled fixtures (same shape ui/turns-compiled.test.ts spells out)
// ---------------------------------------------------------------------------

const summary = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
    id: 't1',
    index: 0,
    prompt: 'read the notes',
    status: 'running',
    state: 'streaming',
    updatedAt: T,
    sectionCount: 1,
    stepCount: 0,
    activeAgents: ['instruct'],
    blocks: [],
    ...overrides
});

const rootSection = (overrides: Partial<TurnSection> = {}): TurnSection => ({
    id: 't1:0',
    rank: 'A',
    agent: 'instruct',
    agentLabel: 'RR1',
    state: 'streaming',
    nodes: [],
    ...overrides
});

const documentOf = (rows: TurnSummary[], sections: Record<string, TurnSection[]>): SessionView =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: 1,
        updatedAt: T,
        turns: rows,
        displays: Object.fromEntries(Object.entries(sections).map(([turnId, list]) => [turnId, { turnId, sections: list }]))
    }) as unknown as SessionView;

const pending = new Map<string, unknown[]>();

const frame = (board: TurnBoard, document: SessionView, turnId: string, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(document, turnId, ops, pending as never);
    return board.applyViewOps(turnId, ops, document);
};

// ---------------------------------------------------------------------------
// AC2 — the retry line
// ---------------------------------------------------------------------------

describe('the provider retry line on the running tile (AC2)', () => {
    it('renders attempt, budget, backoff, errno and the dialled url', () => {
        const board = mountRaw();
        const tile = board.begin('ask');

        tile.apply(start());
        tile.apply(text('partial draft'));
        tile.apply(providerRetry());
        tile.flush();

        const lines = tile.element.querySelectorAll('.agent-notice');

        expect(lines).toHaveLength(1);
        expect(lines[0].dataset.tone).toBe('provider');
        expect(lines[0].querySelector('.agent-notice-label')?.textContent).toBe('provider');
        expect(lines[0].querySelector('.agent-notice-text')?.textContent).toBe(
            'attempt 6 of 11 failed · retrying in 32.0s · ECONNREFUSED · http://localhost:5500/providers/private/v1'
        );
        // The abandoned attempt's prose is still discarded: the notice REPLACES nothing,
        // it does not undo R19's discard of the failed answer.
        expect(tile.element.textContent ?? '').not.toContain('partial draft');
        // A retry is still a RUNNING tile: the ladder has not ended the turn.
        expect(tile.state()).toBe('streaming');
    });

    it('stays silent for a retry WITHOUT provider — the pre-T9 rendering is unchanged', () => {
        const board = mountRaw();
        const tile = board.begin('ask');

        tile.apply(start());
        tile.apply(text('partial draft'));
        tile.apply(plainRetry());
        tile.flush();

        expect(tile.element.querySelectorAll('.agent-notice')).toHaveLength(0);
        expect(tile.element.querySelectorAll('.agent-retry')).toHaveLength(0);
        expect(tile.element.textContent ?? '').not.toMatch(/retry/i);
        expect(tile.element.textContent ?? '').not.toMatch(/attempt \d+ of \d+/);
        expect(tile.state()).toBe('streaming');
    });
});

// ---------------------------------------------------------------------------
// AC3 — the terminal failure
// ---------------------------------------------------------------------------

describe('the terminal provider failure on the tile (AC3)', () => {
    it('labels a provider-connection with the class and points at the provider address', () => {
        const board = mountRaw();
        const tile = board.begin('ask');

        tile.apply(start());
        tile.apply({
            type: 'error',
            agent: 'writer',
            error: {
                message: `Request to ${STUCK_URL}/chat/completions failed: fetch failed`,
                code: 'provider-connection'
            }
        } as unknown as HarnessEvent);
        tile.flush();

        const block = tile.element.querySelector('.agent-error');

        expect(block?.dataset.provider).toBe('provider-connection');
        expect(block?.querySelector('.agent-error-label')?.textContent).toBe('provider-connection');
        expect(block?.querySelector('.agent-error-text')?.textContent).toBe(
            // No `provider` block rides a terminal frame, so the address is the host:port the
            // server's own sentence names — echoed, never expanded into the full URL.
            `dialled localhost:5500 · Request to ${STUCK_URL}/chat/completions failed: fetch failed · this is the provider address, set in Endpoint & model settings`
        );
    });

    it('labels a provider-timeout with its phase and bound', () => {
        const board = mountRaw();
        const tile = board.begin('ask');

        tile.apply(start());
        tile.apply({
            type: 'error',
            agent: 'writer',
            error: {
                // T6's terminal sentence: the class, the phase and the bound it expired on.
                message:
                    'provider-timeout: the response-head bound 30s expired before the first byte (raise HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS)',
                code: 'provider-timeout'
            }
        } as unknown as HarnessEvent);
        tile.flush();

        const block = tile.element.querySelector('.agent-error');

        expect(block?.dataset.provider).toBe('provider-timeout');
        // No `provider` block rides a terminal frame, so the phase and the bound are read
        // out of the server's own sentence — an echo of what it states, never a default.
        expect(block?.querySelector('.agent-error-label')?.textContent).toBe('provider-timeout');
        expect(block?.querySelector('.agent-error-text')?.textContent).toBe(
            'response-head · bound 30s · provider-timeout: the response-head bound 30s expired before the first byte (raise HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS)'
        );
        // A classified failure never claims a dialled address it was not given.
        expect(block?.querySelector('.agent-error-text')?.textContent).not.toContain('dialled');
    });

    it('keeps the generic error block for an unclassified failure', () => {
        const board = mountRaw();
        const tile = board.begin('ask');

        tile.apply(start());
        tile.apply({ type: 'error', agent: 'writer', error: { message: 'context window exceeded' } } as unknown as HarnessEvent);
        tile.flush();

        const block = tile.element.querySelector('.agent-error');

        expect(block?.dataset.provider).toBeUndefined();
        expect(block?.querySelector('.agent-error-label')?.textContent).toBe('error');
        expect(block?.querySelector('.agent-error-text')?.textContent).toBe('context window exceeded');
    });
});

describe('the terminal provider failure in a compiled notice (AC3, live plane)', () => {
    const noticeTile = (nodeText: string) => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const empty = document.createElement('div');
        empty.className = 'empty';
        const board = createTurnBoard({ empty });
        board.bindSession('s1');
        document.body.replaceChildren(board.element);

        const tile = board.upsertView(summary(), view);

        frame(board, view, 't1', [
            {
                op: 'node:insert',
                turnId: 't1',
                sectionId: 't1:0',
                node: { kind: 'notice', id: 'n1', tone: 'error', text: nodeText, at: T }
            }
        ]);
        tile.flush();

        return tile.element.querySelector('.agent-notice');
    };

    it('relabels a classified error notice with its class and marks it in data', () => {
        const line = noticeTile(
            'provider-connection: nothing answered http://localhost:5500/providers/private/v1 (ECONNREFUSED); raise HARNESS_PROVIDER_CONNECTION_ATTEMPTS to wait longer'
        );

        expect(line?.dataset.tone).toBe('error');
        expect(line?.dataset.provider).toBe('provider-connection');
        expect(line?.querySelector('.agent-notice-label')?.textContent).toBe('provider-connection');
        // The text is the server's sentence VERBATIM — the host:port in it is the frame's.
        expect(line?.querySelector('.agent-notice-text')?.textContent).toBe(
            'provider-connection: nothing answered http://localhost:5500/providers/private/v1 (ECONNREFUSED); raise HARNESS_PROVIDER_CONNECTION_ATTEMPTS to wait longer'
        );
    });

    it('keeps the tone as the label for an ordinary error notice', () => {
        const line = noticeTile('Request failed: HTTP 503');

        expect(line?.dataset.provider).toBeUndefined();
        expect(line?.querySelector('.agent-notice-label')?.textContent).toBe('error');
        expect(line?.querySelector('.agent-notice-text')?.textContent).toBe('Request failed: HTTP 503');
    });
});
