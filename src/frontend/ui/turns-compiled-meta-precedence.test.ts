// V7 — THE RENDERED PRECEDENCE OF THE COMPACT HEADER.
//
// The user's complaint was literal DOM: a completed turn whose tile header read
// `7 agents · 590 tool calls · Upstream stream terminated` — a delegated lane's provider
// failure printed as the conversation's outcome. The server-side precedence (a turn that
// settles `done` puts THE MODEL in `summary.detail`, never a lane's error text —
// ../../server/turn-projector.ts `summaryOf`, pinned by turn-projector-restart.test.ts)
// says what the ROW carries. This file pins the other half: what the TILE PRINTS.
//
//   - `setCompiledSummary` applies the row verbatim — `setState(summary.state, summary.detail)`
//     (turns.ts) — and `updateMeta` joins `agent count · tool-call count · detail`
//     into `.tile-meta`. Nothing may substitute a child's error sentence for the model.
//   - The child's failure is NOT lost: it stays in the body, in its own row, as the
//     `error`-tone notice the record gives it.
//
// The summary below is SYNTHETIC but SHAPED LIKE THE RECORDING (session
// 319cfc1c-…, root thread IT4): root flow answers, the answer COMMITS, and only after it a
// delegated lane records `Upstream stream terminated` — the frame order that, before the
// fix, left the last frame's error text in the header forever.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-compiled-meta-precedence.test.ts

import type { SessionView } from '../../server/protocol';
import type { HarnessPendingTool } from '../../types';
import type { DisplayStep, TurnDisplayOp, TurnSection, TurnSummary } from '../../shared/turn-display';
import type { TurnBoard } from './turns';
import { createTurnBoard } from './turns';
import { applyOpsToDisplay } from '../view-state';
import { beforeEach, describe, expect, it } from 'vitest';

const T = 1_700_000_000_000;

// The row, spelled like the recorded one: the root answers on `local/basalt`, and the
// row the server settles is `done` — the lane failure is NOT the turn's status.
const summary = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
    id: 't1',
    index: 0,
    prompt: 'audit the tool surface',
    status: 'running',
    state: 'streaming',
    threadId: 'thread-13',
    threadLabel: 'IT4',
    updatedAt: T,
    sectionCount: 2,
    stepCount: 1,
    activeAgents: ['instruct'],
    blocks: [],
    ...overrides
});

const rootSection = (overrides: Partial<TurnSection> = {}): TurnSection => ({
    id: 't1:0',
    role: 'primary',
    agent: 'instruct',
    agentLabel: 'IT4',
    state: 'streaming',
    nodes: [],
    ...overrides
});

const childSection = (overrides: Partial<TurnSection> = {}): TurnSection => ({
    id: 't1:1',
    parentSectionId: 't1:0',
    role: 'subagent',
    agent: 'helper',
    agentLabel: 'RH1',
    state: 'streaming',
    nodes: [],
    ...overrides
});

// The delegate call that opened the lane, settled OK — the lane ITSELF failing is the
// child row's fact; the call that spawned it returned.
const delegateStep = (): DisplayStep => ({
    kind: 'tool',
    id: '7',
    turnId: 't1',
    sectionId: 't1:0',
    callId: 'call-d1',
    name: 'delegate',
    argsPreview: 'agent=helper',
    state: 'ok',
    startedAt: T,
    endedAt: T + 200,
    durationMs: 200,
    preview: 'delegated audit',
    outcome: 'completed',
    detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: false }
});

const pending = new Map<string, HarnessPendingTool[]>();

// One frame, applied the way `main.ts onViewItem` does: the state reducer first, then the tile.
const frame = (board: TurnBoard, document: SessionView, turnId: string, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(document, turnId, ops, pending);

    return board.applyViewOps(turnId, ops, document);
};

const documentOf = (rows: TurnSummary[], sections: Record<string, TurnSection[]>): SessionView =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        createdAt: 1,
        updatedAt: T,
        turns: rows,
        displays: Object.fromEntries(
            Object.entries(sections).map(([turnId, list]) => [turnId, { turnId, sections: list }])
        )
    }) as unknown as SessionView;

const mount = (): { board: TurnBoard } => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return { board };
};

beforeEach(() => {
    pending.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

describe('the settled header of a completed turn with a failed child lane', () => {
    it('prints the answering model in the meta line, never the lane error recorded after the answer', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        // The root flow: prose, the delegate call, and the COMMITTED final answer.
        frame(board, document, 't1', [
            {
                op: 'node:insert',
                turnId: 't1',
                sectionId: 't1:0',
                node: { kind: 'text', id: 'n0', text: 'finding one\n', committed: false }
            },
            {
                op: 'node:set',
                turnId: 't1',
                sectionId: 't1:0',
                nodeId: 'n0',
                patch: { text: 'the complete answer\n', committed: true }
            },
            { op: 'step:set', turnId: 't1', sectionId: 't1:0', step: delegateStep() }
        ]);

        // AFTER the answer landed, the delegated lane records its provider failure — the
        // frame order of the recorded run. The child row settles `error`; the TURN does not.
        frame(board, document, 't1', [
            { op: 'section:open', turnId: 't1', section: childSection() },
            {
                op: 'node:insert',
                turnId: 't1',
                sectionId: 't1:1',
                node: { kind: 'notice', id: 'n8', tone: 'error', text: 'Upstream stream terminated', at: T + 300 }
            },
            { op: 'section:set', turnId: 't1', sectionId: 't1:1', patch: { state: 'error', endedAt: T + 300 } }
        ]);

        // The terminal row: `done`, and `detail` names the model that answered.
        frame(board, document, 't1', [
            {
                op: 'turn',
                turnId: 't1',
                summary: summary({
                    status: 'done',
                    state: 'done',
                    detail: 'local/basalt',
                    updatedAt: T + 400
                })
            }
        ]);
        tile.flush();

        // The header a reader sees: state `done`, and the meta line joins ONLY counts + detail.
        expect(tile.element.dataset.state).toBe('done');
        expect(tile.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        expect(tile.element.querySelector('.tile-meta')?.textContent).toBe('2 agents · 1 tool call · local/basalt');

        // The lane's error sentence appears NOWHERE in the header line or the status pill.
        const headerText = `${tile.element.querySelector('.tile-meta')?.textContent ?? ''} ${
            tile.element.querySelector('.tile-status-text')?.textContent ?? ''
        }`;

        expect(headerText).not.toContain('Upstream');
        expect(headerText).not.toContain('terminated');

        // And the failure is not lost: it lives in the child's OWN row, in the body, as its
        // `error` notice — exactly where the precedence rule promises to leave it.
        const laneRow = board.element.querySelector('.thread-row[data-thread-id="t1:1"]');

        expect(laneRow).not.toBeNull();
        expect(laneRow?.querySelector('.agent-notice[data-tone="error"]')?.textContent).toContain(
            'Upstream stream terminated'
        );
    });
});
