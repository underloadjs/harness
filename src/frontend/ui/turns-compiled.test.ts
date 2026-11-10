// The COMPILED board path: this tile renderer is driven ONLY by hand-written
// `TurnDisplayOp` frames and `TurnSummary` rows — no `HarnessEvent`, no raw snapshot, and
// no raw→display test double anywhere in the file.
//
// Why that matters (R1/R2/R3):
//   - the shell's end-to-end tests answer `/views` routes from RAW fixtures through
//     `view-test-support.ts`, which is the server's own projector. Excellent evidence
//     about the wire, but it cannot show that the DOM is built from ADDRESSED state:
//     a renderer that quietly re-derived the transcript from events would still pass.
//   - every assertion here is against an op the server would have sent (`section:open`,
//     `node:insert`, `node:append`, `node:set {text}`, `step:set`, `section:remove`,
//     `attempt:*`), applied to a document advanced by the SAME reducer the shell runs
//     first (`view-state.applyOpsToDisplay`, exactly `main.ts onViewItem` step 1), then
//     routed to the tile by turn id (step 3).
//   - R2's one-click rule lives here too: the detail loader is a board OPTION, so the
//     tests can count requests — none while the board renders, one on the reader's click,
//     none ever again for that step, and the panes then carry the recorded pair verbatim.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-compiled.test.ts

import type { SessionView } from '../../server/protocol';
import type { HarnessPendingTool } from '../../types';
import type { TurnDisplayOp, TurnSummary, DisplayStep, TurnSection, TurnDisplay, DisplayTextNode } from '../../shared/turn-display';
import type { TurnStepDetail } from '../../shared/turn-display';
import type { TurnBoard } from './turns';
import { createTurnBoard } from './turns';
import { applyOpsToDisplay } from '../view-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Hand-written compiled fixtures (src/shared/turn-display.ts, spelled out)
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
    role: 'primary',
    agent: 'instruct',
    agentLabel: 'RR1',
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

const toolStep = (overrides: Partial<DisplayStep> = {}): DisplayStep => ({
    kind: 'tool',
    id: '7',
    turnId: 't1',
    sectionId: 't1:0',
    callId: 'call-1',
    name: 'read',
    argsPreview: 'path=notes',
    state: 'running',
    startedAt: T,
    detail: { stepId: '7', hasResult: false, truncated: true },
    ...overrides
});

// A document whose trees are advanced by the real reducer, exactly as the shell does
// before it routes a frame: a hand-painted tree would let renderer and state drift apart
// without any test noticing.
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

const pending = new Map<string, HarnessPendingTool[]>();

// Apply one frame the way `main.ts onViewItem` does: state first, then the tile.
const frame = (board: TurnBoard, document: SessionView, turnId: string, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(document, turnId, ops, pending);

    return board.applyViewOps(turnId, ops, document);
};

// Text rendering is scheduled on an animation frame (one Markdown parse per paint); a
// tile's `flush()` is the documented synchronous point.
const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): { board: TurnBoard } => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ ...options, empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return { board };
};

// The recorded pair one click buys (R2): the opening event's arguments and the settled
// event's content, VERBATIM and both in one answer.
const recordedPair = (): TurnStepDetail =>
    ({
        sessionId: 's1',
        turnId: 't1',
        stepId: '7',
        sectionId: 't1:0',
        callId: 'call-1',
        opening: {
            index: 7,
            at: T,
            event: { type: 'tool_call', agent: 'instruct', call: { id: 'call-1', name: 'read', arguments: 'path=notes.md mode=full' } }
        },
        result: {
            index: 9,
            at: T + 800,
            event: {
                type: 'tool_result',
                agent: 'instruct',
                callId: 'call-1',
                name: 'read',
                content: 'the whole file body, every line of it',
                isError: false,
                outcome: 'completed',
                durationMs: 800
            }
        }
    }) as unknown as TurnStepDetail;

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    pending.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// R1 — the row and the flow, with no event list in sight
// ---------------------------------------------------------------------------

describe('the compact row', () => {
    it('paints a tile from a TurnSummary alone, with no tree and no event', () => {
        const { board } = mount();
        const tile = board.upsertView(summary({ status: 'done', state: 'done', detail: 'm1' }), documentOf([], {}));

        expect(tile.compiled()).toBe(true);
        expect(tile.element.dataset.state).toBe('done');
        expect(tile.element.dataset.turnId).toBe('t1');
        expect(tile.element.querySelector('.tile-prompt')?.textContent).toBe('read the notes');
        expect(tile.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        // No trees in the document, so no flow was invented: an empty document paints an
        // empty flow, never a placeholder block.
        expect(tile.element.querySelectorAll('.agent-text')).toHaveLength(0);
    });

    it('patches the tile header from a turn upsert that rode inside an ops frame', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        expect(tile.element.dataset.state).toBe('streaming');

        frame(board, document, 't1', [
            {
                op: 'turn',
                turnId: 't1',
                summary: summary({ status: 'done', state: 'done', detail: 'm1', updatedAt: T + 400, usage: { input: 150, cached: 40, output: 12 } })
            }
        ]);

        expect(tile.element.dataset.state).toBe('done');
        expect(tile.element.querySelector('.tile-status-text')?.textContent).toBe('done');
    });
});

describe('the compiled flow', () => {
    it('streams prose from addressed ops into ONE block that accumulates', () => {
        const document = documentOf([summary()], { t1: [] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [{ op: 'section:open', turnId: 't1', section: rootSection() }]);
        frame(board, document, 't1', [{ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'text', id: 'n0', text: 'Hello', committed: false } }]);
        frame(board, document, 't1', [
            { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: ' **world**' },
            { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: '!' }
        ]);
        tile.flush();

        const blocks = tile.element.querySelectorAll('.agent-text');
        expect(blocks).toHaveLength(1);
        // One parse of the CUMULATIVE node text — the reason a reconnect cannot duplicate
        // streamed bytes.
        expect(blocks[0].textContent).toBe('Hello world!\n');
        expect(tile.element.querySelector('.tile-flow')?.contains(blocks[0])).toBe(true);
    });

    it('routes a nested invocation to its own row, and detaches that row on section:remove', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [
            // The root section's own prose, so "separation" is a real claim: both surfaces
            // have content, and neither one can absorb the other's.
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'text', id: 'n0', text: 'root answer', committed: false } },
            { op: 'section:open', turnId: 't1', section: childSection() },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:1', node: { kind: 'text', id: 'n5', text: 'delegated answer', committed: false } }
        ]);
        tile.flush();

        const row = board.element.querySelector<HTMLElement>('.thread-row[data-thread-id="t1:1"]');
        expect(row).not.toBeNull();
        // The nested invocation's surfaces live in the `.thread-children` host, a SIBLING of
        // the card (turns.ts:2615-2618) — the turn's own flow never moves, which is also why
        // `tile.element` (the card) can never contain a delegated block.
        expect(row?.parentElement?.className).toBe('thread-children');
        expect(row?.querySelector('.agent-text')?.textContent).toBe('delegated answer\n');

        // Two surfaces, one per section, with no bleed in either direction.
        const own = tile.element.querySelectorAll('.tile-flow .agent-text');
        expect(own).toHaveLength(1);
        expect(own[0].textContent).toBe('root answer\n');
        expect(board.element.querySelectorAll('.agent-text')).toHaveLength(2);

        // A placeholder section that never produced a node is discarded by id
        // (turn-projector.ts:1567); its row must go with it, and the turn's own prose stays.
        frame(board, document, 't1', [{ op: 'section:remove', turnId: 't1', sectionId: 't1:1' }]);

        expect(board.element.querySelectorAll('.thread-row')).toHaveLength(0);
        expect(board.element.querySelectorAll('.agent-text')).toHaveLength(1);
        expect(tile.element.querySelector('.tile-flow .agent-text')?.textContent).toBe('root answer\n');
    });

    it('rewrites a pending status line IN PLACE on a node:set {text} patch', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'notice', id: 'pending', tone: 'info', text: 'pending \u00b7 read 1.2s' } }
        ]);
        frame(board, document, 't1', [
            { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'pending', patch: { text: 'pending \u00b7 read 2.4s' } }
        ]);

        const lines = tile.element.querySelectorAll('.agent-notice');
        // One line, rewritten — not a second row appended on every tick of the status.
        expect(lines).toHaveLength(1);
        expect(lines[0].querySelector('.agent-notice-text')?.textContent).toBe('pending \u00b7 read 2.4s');
    });

    // T13: `node:set {text}` is the server REPLACING one prose node's bytes, and the
    // compiled row must show the replacement. Two producers send it — a think window whose
    // wire text stopped at the cap, and an answer a newer one superseded
    // (../server/turn-projector.ts `redactSuperseded`) — and the tree a reload receives
    // carries the same string, so a live board that kept the pre-redaction copy would be
    // showing a document the server never sent. Rendering an addressed patch is rendering
    // server state; it compiles no events and fetches nothing.
    it('replaces a superseded answer with its preview in place, leaving the current one alone', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [{ op: 'section:open', turnId: 't1', section: rootSection() }]);
        frame(board, document, 't1', [
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'text', id: 'n0', text: 'first answer whole', committed: false } }
        ]);
        // The commit closes this window, so the next node opens a block of its own.
        frame(board, document, 't1', [{ op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', patch: { committed: true } }]);
        frame(board, document, 't1', [
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'text', id: 'n1', text: 'latest answer', committed: false } }
        ]);
        tile.flush();

        const before = tile.element.querySelectorAll('.agent-text');
        expect(before).toHaveLength(2);
        expect(before[0].textContent).toBe('first answer whole\n');
        expect(before[1].textContent).toBe('latest answer\n');

        // The exact patch the fold sends for a 400-character answer it has just superseded.
        frame(board, document, 't1', [
            {
                op: 'node:set',
                turnId: 't1',
                sectionId: 't1:0',
                nodeId: 'n0',
                patch: { text: 'first answer\u2026', chars: 400, redacted: true }
            }
        ]);
        tile.flush();

        const after = tile.element.querySelectorAll('.agent-text');
        // Repainted IN PLACE: same node, same position in the flow, no duplicate block, and
        // the reader's current answer untouched.
        expect(after).toHaveLength(2);
        expect(after[0]).toBe(before[0]);
        expect(after[0].textContent).toBe('first answer\u2026\n');
        expect(after[1].textContent).toBe('latest answer\n');
    });

    it('replaces a think chip\u2019s body on a text patch and prints the server\u2019s exact length', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [{ op: 'section:open', turnId: 't1', section: rootSection() }]);
        frame(board, document, 't1', [
            {
                op: 'node:insert',
                turnId: 't1',
                sectionId: 't1:0',
                // A window the wire delivered bounded: 320 preview characters beside the
                // EXACT 515-character count (`DisplayReasoningNode`, turn-display.ts:673).
                node: { kind: 'reasoning', id: 'r0', text: 'x'.repeat(313) + '\u2026', share: 12, chars: 515, redacted: true }
            }
        ]);
        tile.flush();

        const chip = tile.element.querySelector('details.tool.think');
        expect(chip).not.toBeNull();
        const summaryElement = chip?.querySelector('summary');
        // The chip's figure is the recorded length, never the preview's 320.
        expect(summaryElement?.getAttribute('title')).toContain('515 characters');
        expect(chip?.textContent).toContain('x'.repeat(20));

        // The growth patch the fold sends after the cap: the count moves, the body does not.
        frame(board, document, 't1', [{ op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'r0', patch: { chars: 900 } }]);
        expect(tile.element.querySelector('details.tool.think summary')?.getAttribute('title')).toContain('900 characters');

        // And a later replacement patch moves the BODY too — the reason a live chip cannot be
        // left with an empty or stale think body while the reload shows the preview.
        frame(board, document, 't1', [
            { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'r0', patch: { text: 'bounded preview\u2026', chars: 1_024, redacted: true } }
        ]);
        tile.flush();

        expect(tile.element.querySelector('details.tool.think')?.textContent).toContain('bounded preview\u2026');
        expect(tile.element.querySelector('details.tool.think summary')?.getAttribute('title')).toContain('1,024 characters');
    });

    it('replaces the tool chip on a step:set instead of appending a second one', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [{ op: 'step:set', turnId: 't1', sectionId: 't1:0', step: toolStep() }]);
        expect(tile.element.querySelectorAll('details.tool:not(.think)')).toHaveLength(1);
        expect(tile.element.querySelector<HTMLElement>('.tool')?.dataset.state).toBe('running');

        // The settled row arrives WHOLE (no field merge), so one chip advances in place.
        frame(board, document, 't1', [
            {
                op: 'step:set',
                turnId: 't1',
                sectionId: 't1:0',
                step: toolStep({
                    state: 'ok',
                    outcome: 'completed',
                    preview: 'ok',
                    durationMs: 800,
                    endedAt: T + 800,
                    detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: false }
                })
            }
        ]);

        const chips = tile.element.querySelectorAll('details.tool:not(.think)');
        expect(chips).toHaveLength(1);
        expect(chips[0].dataset.state).toBe('ok');
        expect(chips[0].querySelector('.tool-name')?.textContent).toBe('read');
        // The server-measured span, not a wall-clock guess.
        expect(chips[0].querySelector('.tool-duration')?.textContent).toBe('0.8s');
    });

    it('refuses a frame whose turn this board does not hold, and leaves the DOM alone', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        const foreign: TurnDisplayOp[] = [{ op: 'node:insert', turnId: 't9', sectionId: 't9:0', node: { kind: 'text', id: 'n0', text: 'elsewhere', committed: false } }];

        expect(frame(board, document, 't9', foreign)).toBe(false);
        expect(board.find('t9')).toBeUndefined();
        expect(tile.element.querySelectorAll('.agent-text')).toHaveLength(0);

        expect(frame(board, document, 't1', [{ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'text', id: 'n0', text: 'mine', committed: false } }])).toBe(true);
        tile.flush();
        expect(tile.element.querySelectorAll('.agent-text')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// R2 — the lazy detail: absent until the click, once, exact, and recoverable
// ---------------------------------------------------------------------------

describe('the lazy step detail', () => {
    // The board renders a compact chip whose full payloads live behind ONE route.
    const withChip = (loadStepDetail: (input: { turnId: string; stepId: string; sessionId?: string }) => Promise<TurnStepDetail>) => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount({ loadStepDetail });
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [{ op: 'step:set', turnId: 't1', sectionId: 't1:0', step: toolStep() }]);

        return { board, document, tile, chip: tile.element.querySelector<HTMLElement>('.tool') as HTMLElement };
    };

    it('sends no detail request while the board renders, and exactly one on the click', async () => {
        const load = vi.fn(async () => recordedPair());
        const { chip } = withChip(load);

        // R3: nothing about a tool call's payload moves before the reader asks.
        expect(load).not.toHaveBeenCalled();

        chip.querySelector<HTMLElement>('.tool-summary')?.click();
        await settled();

        expect(load).toHaveBeenCalledTimes(1);
        // Addressed by the server's own ids, with the board's bound session — never by
        // name, never by position.
        expect(load.mock.calls[0]?.[0]).toEqual({ sessionId: 's1', turnId: 't1', stepId: '7' });

        // A reopen is free: the pair is already here, so the route is not asked twice.
        chip.querySelector<HTMLElement>('.tool-summary')?.click();
        await settled();
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('paints the exact recorded request and response into the open dialog', async () => {
        const load = vi.fn(async () => recordedPair());
        const { chip } = withChip(load);

        chip.querySelector<HTMLElement>('.tool-summary')?.click();
        await settled();

        const dialog = document.querySelector('.dialog');
        expect(dialog).not.toBeNull();

        // The two panes hold the recorded strings verbatim — the arguments exactly as the
        // model sent them, the whole result content, neither truncated nor re-projected.
        // (`:first-child` would miss: the dialog wraps the body in `.dialog-body`.)
        const panes = dialog?.querySelectorAll<HTMLElement>('.tool-section') ?? [];
        expect(panes).toHaveLength(2);

        expect(panes[0].querySelector('.code-block code')?.textContent).toBe('path=notes.md mode=full');
        expect(panes[1].querySelector('.tool-result .code-block code')?.textContent).toBe('the whole file body, every line of it');
        // The pane headings name the server's outcome, not a client guess.
        expect(panes[0].querySelector('.tool-label')?.textContent).toBe('arguments');
        expect(panes[1].querySelector('.tool-label')?.textContent).toBe('result');
        // The compact placeholders are gone from both panes: no `open for the full result`
        // and no `loading the recorded request…` left behind.
        expect(dialog?.querySelectorAll('.tool-pending')).toHaveLength(0);
    });

    it('keeps the previews, says what failed, and retries on request', async () => {
        const pair = recordedPair();
        // First click fails, the retry succeeds: the same loader, re-armed by the dialog.
        const load = vi
            .fn()
            .mockRejectedValueOnce(new Error('detail unavailable'))
            .mockResolvedValue(pair);
        const { chip } = withChip(load);

        chip.querySelector<HTMLElement>('.tool-summary')?.click();
        await settled();

        const dialog = document.querySelector('.dialog');
        const failure = dialog?.querySelector<HTMLElement>('.tool-pending[data-detail="error"]');
        expect(failure?.textContent).toContain('the recorded request and response could not be loaded');
        expect(failure?.textContent).toContain('detail unavailable');

        // A dropped detail must never read as "this tool returned nothing": the Retry
        // control re-arms THE SAME loader, addressed the same way.
        const retry = dialog?.querySelector<HTMLButtonElement>('.tool-retry');
        expect(retry).not.toBeNull();
        retry?.click();
        await settled();

        expect(load).toHaveBeenCalledTimes(2);
        expect(document.querySelector('.dialog')?.querySelector('.tool-pending')).toBeNull();
        expect(document.querySelector('.dialog')?.querySelector('.tool-result .code-block code')?.textContent).toBe(
            'the whole file body, every line of it'
        );
    });

    it('issues no request at all when the embedding wired no detail route', () => {
        // `view`, not `document`: the local raw view would otherwise shadow the global
        // `document` this test needs for the DOM below.
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), view);

        frame(board, view, 't1', [{ op: 'step:set', turnId: 't1', sectionId: 't1:0', step: toolStep() }]);
        tile.element.querySelector<HTMLElement>('.tool-summary')?.click();

        // The chip still opens and still shows its bounded previews: an unwired embed does
        // not pretend to have the payload.
        expect(document.querySelector('.dialog')).not.toBeNull();
        expect(document.querySelector('.tool-peek')?.textContent).toBe('path=notes');
    });
});

// ---------------------------------------------------------------------------
// T16 (R16a) — a transient retry is server-internal: no line, status unchanged
// ---------------------------------------------------------------------------

// The whole browser-visible surface of ONE failed model attempt, exactly as the fold
// sends it (../server/turn-projector.ts `case 'retry'`, values captured from the real
// projector): the abandoned attempt's bar segment and its nodes go, and NOTHING is
// inserted. The `attempt N of M failed · retrying in Xs · <error>` line the fold used to
// mint is gone, because the server retries the same request internally and eleven lines
// of it read like eleven failures.
const abandonedAttempt = (nodes: string[]): TurnDisplayOp[] => [
    { op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: '0-assistant-0' },
    { op: 'attempt:discard', turnId: 't1', sectionId: 't1:0', nodeIds: nodes }
];

describe('a retry the reader never sees (T16, R16a)', () => {
    it('discards the attempt with no notice line and keeps the tile streaming', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        // The abandoned attempt streamed prose, exactly as the fold sends it: an empty
        // `node:insert`, then one `node:append` per delta, each in its own frame.
        frame(board, document, 't1', [
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'text', id: 'n0', text: '', committed: false } }
        ]);
        frame(board, document, 't1', [{ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: 'half a sentence' }]);
        tile.flush();

        expect(tile.element.querySelector('.agent-text')?.textContent).toBe('half a sentence\n');

        frame(board, document, 't1', abandonedAttempt(['n0']));
        tile.flush();

        // The abandoned prose is gone AND nothing replaced it: no notice line, and the
        // words that used to make one appear nowhere in the tile.
        expect(tile.element.querySelectorAll('.agent-text')).toHaveLength(0);
        expect(tile.element.querySelectorAll('.agent-notice')).toHaveLength(0);
        expect(tile.element.textContent ?? '').not.toContain('half a sentence');
        expect(tile.element.textContent ?? '').not.toMatch(/retry/i);

        // R16a's other half: the status is a SERVER section state, and a retry moves none
        // of it, so the run still reads as streaming while the backoff waits.
        expect(tile.state()).toBe('streaming');
        expect(tile.element.dataset.state).toBe('streaming');
    });

    it('replays the same silence from the compiled document a reload receives', () => {
        // The tree the fold hands a reload after two abandoned attempts: the surviving
        // answer only. There is no notice node in it, so the reload path cannot print one.
        const reloaded = documentOf([summary()], {
            t1: [rootSection({ nodes: [{ kind: 'text', id: 'n5', text: 'the answer', committed: true }] })]
        });
        const { board } = mount();
        const tile = board.reconcileView(reloaded)[0];

        tile.flush();

        expect(tile.element.querySelectorAll('.agent-text')).toHaveLength(1);
        expect(tile.element.querySelector('.agent-text')?.textContent).toBe('the answer\n');
        expect(tile.element.querySelectorAll('.agent-notice')).toHaveLength(0);
        expect(tile.element.textContent ?? '').not.toMatch(/retry/i);
        expect(tile.state()).toBe('streaming');
    });

    it('still prints the terminal failure once the retries run out', () => {
        // What the fold sends when the budget is exhausted: an `error`-tone notice with
        // the LAST attempt's own message (../core/agent.ts:604-605 throws it, and the
        // harness reports it as the turn's `error` event), then the row settling. Dropping
        // the per-attempt lines must not drop this one — it is the outcome the reader acts
        // on.
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', abandonedAttempt(['n0']));
        frame(board, document, 't1', [
            {
                op: 'node:insert',
                turnId: 't1',
                sectionId: 't1:0',
                node: { kind: 'notice', id: 'n7', tone: 'error', text: 'Request failed: HTTP 503', at: T }
            }
        ]);
        frame(board, document, 't1', [
            { op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { state: 'error', endedAt: T + 100 } },
            { op: 'turn', turnId: 't1', summary: summary({ status: 'error', state: 'error', detail: 'Request failed: HTTP 503' }) }
        ]);
        tile.flush();

        const lines = tile.element.querySelectorAll('.agent-notice');

        expect(lines).toHaveLength(1);
        expect(lines[0].dataset.tone).toBe('error');
        expect(lines[0].querySelector('.agent-notice-text')?.textContent).toBe('Request failed: HTTP 503');
        expect(tile.state()).toBe('error');
    });
});

// ---------------------------------------------------------------------------
// R3 — the terminal document reconciles what a partial connection missed
// ---------------------------------------------------------------------------

describe('reconciling a reconnect', () => {
    it('keeps streamed text once, advances the chip, and drops a node the record no longer names', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        // Half a live connection: prose, a discarded retry attempt's notice node, one chip.
        // The notice is what an OLDER recording carries (T16 stopped the server minting one);
        // R19/T19 keeps the browser from printing it, so this reconciles the same tree the
        // reconnect path has to tolerate.
        frame(board, document, 't1', [
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'text', id: 'n0', text: 'Hal', committed: false } },
            { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: 'lo' },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: { kind: 'notice', id: 'n1', tone: 'retry', text: 'attempt 1 of 3 failed' } },
            { op: 'step:set', turnId: 't1', sectionId: 't1:0', step: toolStep() }
        ]);
        tile.flush();
        // T19 (R19): the retry-tone node painted NOTHING, and no handle exists for it either —
        // the prose and the chip are the whole document so far.
        expect(tile.element.querySelectorAll('.agent-notice')).toHaveLength(0);
        expect(tile.element.textContent ?? '').not.toMatch(/retry/i);

        // The drain frame: the same tree as the server holds it now — the prose
        // committed, the retry notice gone, the chip settled. Nothing is appended twice.
        const drained = documentOf([summary({ status: 'done', state: 'done' })], {
            t1: [
                rootSection({
                    state: 'done',
                    nodes: [
                        { kind: 'text', id: 'n0', text: 'Hello', committed: true },
                        {
                            kind: 'tool',
                            id: '7',
                            turnId: 't1',
                            sectionId: 't1:0',
                            callId: 'call-1',
                            name: 'read',
                            argsPreview: 'path=notes',
                            state: 'ok',
                            outcome: 'completed',
                            preview: 'ok',
                            durationMs: 800,
                            startedAt: T,
                            endedAt: T + 800,
                            detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: false }
                        }
                    ]
                })
            ]
        });

        const handles = board.reconcileView(drained);
        tile.flush();

        expect(handles).toHaveLength(1);
        expect(handles[0]).toBe(tile);
        expect(tile.element.querySelectorAll('.agent-text')).toHaveLength(1);
        expect(tile.element.querySelector('.agent-text')?.textContent).toBe('Hello\n');
        expect(tile.element.querySelectorAll('.agent-notice')).toHaveLength(0);
        expect(tile.element.querySelectorAll('details.tool:not(.think)')).toHaveLength(1);
        expect(tile.element.querySelector<HTMLElement>('.tool')?.dataset.state).toBe('ok');
        // The tile is the SAME element: no rebuild, so an open dialog or a reader's
        // scroll position survives the reconnect.
        expect(tile.element.isConnected).toBe(true);
    });

    it('never lets a late, older row regress a tile the stream already advanced', () => {
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        // The observer moved the row to `done` (newer stamp)…
        frame(board, document, 't1', [
            { op: 'turn', turnId: 't1', summary: summary({ status: 'done', state: 'done', updatedAt: T + 400 }) }
        ]);
        expect(tile.element.dataset.state).toBe('done');

        // …then the POST /tasks answer, captured while the task was still queued, lands.
        board.upsertView(summary({ status: 'queued', state: 'queued', updatedAt: T + 10 }), documentOf([summary({ status: 'queued', state: 'queued', updatedAt: T + 10 })], {}));

        expect(tile.element.dataset.state).toBe('done');
        expect(tile.element.querySelector('.tile-status-text')?.textContent).toBe('done');
    });
});

// ---------------------------------------------------------------------------
// R2 — the header's LATEST-request context survives completion and a replay
// ---------------------------------------------------------------------------
//
// The compact header prints TWO scopes on purpose (ui/tokens.ts): the primary figure
// is the LATEST model request's input (a context gauge, bounded by the model's window)
// and the bracket is the turn's cumulative cached input. The cumulative `usage.input`
// — every re-sent transcript added up (../server/sessions.ts `addUsage`) — is only ever
// the conservative fallback for a record whose latest request is unknowable.
//
// What this pins, because it is what broke (T2): a run paints the latest request while
// it streams (the projector's `usage` op for `sectionId: 'turn'` carries it), but the
// frame that ENDS the run — the terminal snapshot `sessions.ts` `mirrorView` publishes
// as `{ type: 'view' }`, and every reload's `hydrateView` — repaints the tile from the
// compiled document. That rebuild drops the event-derived figures
// (`resetCompiled` -> `blockMeta.clearUsage()`) and nothing restored them from the row,
// so the header fell back to the cumulative sum: a 133-minute task printed 76,645,165
// beside a 512k context window, and every nested row lost its tally outright.
//
//   row (the turn-level authority):   usage.input 410,000 · latestInput 200,000 · cached 330,000
//   correct header:                   "200,000 (330,000)"
//   the regression this pins:         "410,000 (330,000)"  (the sum, not the context)
describe('the latest-request context through a document paint', () => {
    // The row a completed run carries: the cumulative tally stays on `usage` (accounting,
    // untouched by this fix) while `latestInput` is the last request's context.
    const TALLY = { input: 410_000, output: 45, total: 410_045, cached: 330_000 };
    const LATEST = 200_000;

    const figures = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
        ...summary(overrides),
        usage: TALLY,
        latestInput: LATEST,
        cachedInput: TALLY.cached
    });

    // The live frame for the final request: the emitting section first, then the
    // turn-level pair (../server/turn-projector.ts:2240 and :2247).
    const liveUsageOps = (sectionId: string, latestInput: number, cachedInput: number): TurnDisplayOp[] => [
        { op: 'usage', turnId: 't1', sectionId, latestInput, cachedInput },
        { op: 'usage', turnId: 't1', sectionId: 'turn', latestInput, usage: TALLY }
    ];

    it('keeps the latest request on the header after the terminal document frame', () => {
        const document = documentOf([figures()], {
            t1: [rootSection({ latestInput: LATEST, cachedInput: 250_000 })]
        });
        const { board } = mount();
        const tile = board.upsertView(figures({ status: 'running', state: 'streaming' }), document);

        frame(board, document, 't1', liveUsageOps('t1:0', LATEST, 250_000));

        expect(tile.tokens()).toBe('200,000 (330,000)');

        // The end of the run: the drain/terminal frame replaces the row AND repaints the
        // whole tree. The header figure must not move to the cumulative tally.
        const settled = documentOf([figures({ status: 'done', state: 'done', updatedAt: T + 5_000 })], {
            t1: [rootSection({ state: 'done', latestInput: LATEST, cachedInput: 250_000 })]
        });
        const handles = board.reconcileView(settled);

        expect(handles).toHaveLength(1);
        expect(handles[0]).toBe(tile);
        expect(tile.tokens()).toBe('200,000 (330,000)');
        expect(tile.tokens()).not.toBe('410,000 (330,000)');

        // The scope the title declares is part of the contract: the fallback reads
        // "Cumulative input (latest request not recorded)", and after this frame the
        // number IS the latest request.
        expect(tile.element.querySelector('.tile-tokens')?.getAttribute('title')).toBe(
            'Latest request context: 200,000 input tokens · Total cached input sent: 330,000 tokens'
        );
    });

    it('paints the latest request on a cold open of a document with no per-section figures', () => {
        // A tree whose sections carry no token figures at all (an older compiled document —
        // this is exactly what `display()` used to publish): the ROW still knows the latest
        // request, and that is what the header prints instead of the cumulative sum.
        const reloaded = documentOf([figures({ status: 'done', state: 'done', updatedAt: T + 5_000 })], {
            t1: [rootSection({ state: 'done' })]
        });
        const { board } = mount();
        const [tile] = board.hydrateView(reloaded);

        tile.flush();

        expect(tile.tokens()).toBe('200,000 (330,000)');
    });

    it('paints the pair the ROOT section carries when the row that opened the tile carries none', () => {
        // T47, the other half of the same parity rule. A submit paints its tile from the
        // receipt row (`view-api.ts:258 rowFromReceipt`), which states identity, status and
        // placement and NOTHING else — no `usage`, no `latestInput`, no `cachedInput`. The
        // display tree the shell fetches for that same turn carries the pair on its root
        // section TODAY (../server/turn-projector.ts:2247-2248, the wire's
        // `TurnSection.latestInput`/`cachedInput`). Before this, only a DELEGATED row read
        // its section's pair (`entry.meta` is undefined for the root, whose figures live on
        // the tile's own `blockMeta`), so the tile stayed blank until a stamped row or a
        // `usage` op happened to arrive — the live view and a reload disagreed.
        const receipt = summary({ status: 'running', state: 'streaming' });
        const opened = documentOf([receipt], {
            t1: [rootSection({ state: 'streaming', model: 'm1', latestInput: 48, cachedInput: 0 })]
        });
        const { board } = mount();
        const [tile] = board.hydrateView(opened);

        tile.flush();

        // EXACT: the section's own latest request, with the honest zero cache — the same
        // string `main.test.ts` pins for the live tile at this point in a run.
        expect(tile.tokens()).toBe('48 (0)');
        expect(tile.element.querySelector('.tile-tokens')?.hidden).toBe(false);
    });

    it('lets the first stamped row replace a receipt row whose local stamp runs ahead', () => {
        // T47, the clock-skew half. The receipt is stamped with `accepted_at` — the LOCAL
        // clock — so on a machine running ahead of the server the tile's own monotonic guard
        // (`setCompiledSummary`, which mirrors `view-state.ts:730 upsertSummary`) reads the
        // FIRST authoritative row as late and drops it: the tile keeps the receipt's figures
        // forever, prints no tally, and never leaves `queued`. A stamped row for the same id
        // always replaces an optimistic one.
        const { board } = mount();

        const receipt = {
            ...summary({ status: 'running', state: 'queued', updatedAt: T + 9_000_000 }),
            optimistic: true
        } as TurnSummary;

        const handle = board.upsertView(receipt, documentOf([receipt], {}));

        // Precondition: the optimistic tile really is the queued receipt with no figures.
        expect(handle.element.dataset.state).toBe('queued');
        expect(handle.tokens()).toBe('');

        const authoritative = figures({ status: 'done', state: 'done', updatedAt: T + 3_600 });

        board.upsertView(authoritative, documentOf([authoritative], {}));

        expect(handle.element.dataset.state).toBe('done');
        expect(handle.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        expect(handle.tokens()).toBe('200,000 (330,000)');
    });

    it('restores each delegated row from the figures the document carries', () => {
        // A nested invocation prints its OWN pair (R1): the child's latest request and the
        // child's own cumulative cached, never the turn's. The projector mirrors both onto
        // the section so a full-document read can repaint them.
        const reloaded = documentOf([figures({ status: 'done', state: 'done', updatedAt: T + 5_000 })], {
            t1: [
                rootSection({ state: 'done', latestInput: LATEST, cachedInput: 250_000 }),
                childSection({
                    state: 'done',
                    latestInput: 90_000,
                    cachedInput: 80_000,
                    nodes: [{ kind: 'text', id: 'n5', text: 'delegated answer', committed: true }]
                })
            ]
        });
        const { board } = mount();
        const [tile] = board.hydrateView(reloaded);

        tile.flush();

        // The delegated row is a SIBLING of the card (`thread-children`), so it is read
        // from the board, not from `tile.element`.
        const row = board.element.querySelector<HTMLElement>('.thread-row[data-thread-id="t1:1"]');

        expect(row).not.toBeNull();
        expect(row?.querySelector('.thread-tokens')?.textContent).toBe('90,000 (80,000)');
        expect(tile.tokens()).toBe('200,000 (330,000)');
    });

    // T3 (user-reported display bug): with the projector publishing the turn-level PRIMARY
    // figure from the turn's OWN section only (../server/turn-projector.ts `rootLatestInput`),
    // a task part that only DELEGATED arrives with the turn tally and NO `latestInput`. The
    // header then prints nothing rather than `usage.input` — that sum folds every child AND
    // every re-sent transcript, so printing it as a context gauge would fabricate a request
    // the parent never made (the reported symptom was a parent row reading its child's
    // 100,666 beside a 27,668,349 bracket).
    it('hides the primary figure when only a delegated child reported a context', () => {
        const noOwnRequest: TurnSummary = {
            ...summary({ status: 'done', state: 'done', updatedAt: T + 5_000 }),
            usage: TALLY,
            cachedInput: TALLY.cached
            // NO `latestInput`: the turn's own flow made no model request.
        };

        const reloaded = documentOf([noOwnRequest], {
            t1: [
                rootSection({ state: 'done' }),
                childSection({
                    state: 'done',
                    latestInput: 90_000,
                    cachedInput: 80_000,
                    nodes: [{ kind: 'text', id: 'n5', text: 'delegated answer', committed: true }]
                })
            ]
        });
        const { board } = mount();
        const [tile] = board.hydrateView(reloaded);

        tile.flush();

        // Nothing fabricated: no primary figure, and `formatTokens` hides the whole label
        // rather than printing an empty bracket (../ui/tokens.ts).
        expect(tile.tokens()).toBe('');
        expect(tile.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(true);
        expect(tile.tokens()).not.toBe('410,000 (330,000)');

        // The child row keeps its own figure — the scope restriction never travels DOWN.
        const row = board.element.querySelector<HTMLElement>('.thread-row[data-thread-id="t1:1"]');

        expect(row?.querySelector('.thread-tokens')?.textContent).toBe('90,000 (80,000)');
    });

    it('hides then restores the primary figure as the live turn-level usage ops arrive', () => {
        // The live frame of the same rule: the child's `usage` op emits a `sectionId:'turn'`
        // op with the tally and no figure (the root has not reported yet), and the root's own
        // request re-arms the header the moment it lands.
        const document = documentOf([summary()], { t1: [rootSection()] });
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, 't1', [{ op: 'usage', turnId: 't1', sectionId: 'turn', usage: TALLY }]);

        expect(tile.tokens()).toBe('');

        frame(board, document, 't1', [
            { op: 'usage', turnId: 't1', sectionId: 'turn', latestInput: LATEST, usage: TALLY }
        ]);

        expect(tile.tokens()).toBe('200,000 (330,000)');
    });
});

// ---------------------------------------------------------------------------
// R9 — the delegated row's elapsed figure (user-reported: "Time for
// subagent/delegates is missing completely", with a screenshot of five delegate rows
// that each printed `35,736 (319,929)` and no duration).
//
// The row's measurement line is `[elapsed | tokens]` (turns.ts:4858-4888), and the `|`
// is NOT text: styles.css:3094-3096 emits `content: ' | '` from
// `.thread-elapsed:not([hidden]) + .thread-tokens:not([hidden])::before`, so the
// separator exists exactly while BOTH labels are visible. jsdom never loads that
// stylesheet, so the `hidden` attribute below is the observable that arms it, and the
// text is what the reader actually sees on the line (`1.8s | 35,736 (319,929)`).
// ---------------------------------------------------------------------------

describe('the delegated row clock (R9)', () => {
    const rowOf = (board: TurnBoard, sectionId: string): HTMLElement | null =>
        board.element.querySelector<HTMLElement>(`.thread-row[data-thread-id="${sectionId}"]`);

    // The whole measurement line in one EXACT tuple: elapsed text + hidden, then the
    // tally + hidden. A row that shows one figure and hides the other is the reported
    // bug, so both halves are pinned together.
    const lineOf = (row: HTMLElement | null): [string, boolean, string, boolean] => [
        row?.querySelector<HTMLElement>('.thread-elapsed')?.textContent ?? '',
        row?.querySelector<HTMLElement>('.thread-elapsed')?.hidden ?? true,
        row?.querySelector<HTMLElement>('.thread-tokens')?.textContent ?? '',
        row?.querySelector<HTMLElement>('.thread-tokens')?.hidden ?? true
    ];

    it('shows the recorded span on a settled delegated row, beside its own tally', () => {
        // Exactly the screenshot's row: a delegated task that ran 1.8s, spent 35,736 on
        // its latest request and 319,929 cached. The server stamps BOTH endpoints on the
        // section (`bindSectionStart` in ../server/turn-projector.ts, then the terminal
        // patch) and `paintCompiledSection` settles the row's meta with the pair.
        const reloaded = documentOf([summary({ status: 'done', state: 'done', updatedAt: T + 1_800 })], {
            t1: [
                rootSection({ state: 'done' }),
                childSection({
                    state: 'done',
                    startedAt: T,
                    endedAt: T + 1_800,
                    latestInput: 35_736,
                    cachedInput: 319_929,
                    nodes: [{ kind: 'text', id: 'n5', text: 'delegated answer', committed: true }]
                })
            ]
        });
        const { board } = mount();
        const [tile] = board.hydrateView(reloaded);

        tile.flush();

        expect(lineOf(rowOf(board, 't1:1'))).toEqual(['1.8s', false, '35,736 (319,929)', false]);
    });

    it('hides the clock for a section with no recorded start, and for an end-only section', () => {
        const doneRow = summary({ status: 'done', state: 'done', updatedAt: T + 1_800 });

        // (a) No endpoints at all (an imported/legacy compiled document): the tally is
        // still the recorded pair — that half was never broken — while the clock has
        // nothing honest to say, so the label AND the generated separator stay hidden.
        const unstamped = documentOf([doneRow], {
            t1: [rootSection({ state: 'done' }), childSection({ state: 'done', latestInput: 35_736, cachedInput: 319_929 })]
        });
        const first = mount();
        const [firstTile] = first.board.hydrateView(unstamped);
        firstTile.flush();

        expect(lineOf(rowOf(first.board, 't1:1'))).toEqual(['', true, '35,736 (319,929)', false]);

        // (b) An END with no START: `elapsedBetween` refuses one-ended arithmetic
        // (ui/time.ts:36), so nothing prints — in particular NOT a fabricated `0ms` and
        // NOT the record's wall-clock age, the replay rule the raw path pins at
        // turns-threads.test.ts:1216-1247 and that stays untouched here.
        const endOnly = documentOf([doneRow], {
            t1: [rootSection({ state: 'done' }), childSection({ state: 'done', endedAt: T + 1_800, latestInput: 35_736, cachedInput: 319_929 })]
        });
        const second = mount();
        const [secondTile] = second.board.hydrateView(endOnly);
        secondTile.flush();

        expect(lineOf(rowOf(second.board, 't1:1'))).toEqual(['', true, '35,736 (319,929)', false]);
    });

    it('counts a running delegated row from the server start and freezes it at the terminal patch', () => {
        // R11: the compiled path already runs through `settle`, which starts the 250 ms
        // tick whenever an end is missing (turns.ts:1014), so a stamped running row is
        // live exactly as the raw path's `bindStart` row is — no new tick machinery, and
        // the injected clock keeps the assertion exact.
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T + 2_500));

        try {
            const document = documentOf([summary()], { t1: [rootSection()] });
            const { board } = mount();
            const tile = board.upsertView(summary(), document);

            frame(board, document, 't1', [{ op: 'section:open', turnId: 't1', section: childSection({ startedAt: T }) }]);

            const row = rowOf(board, 't1:1');

            expect(row?.querySelector<HTMLElement>('.thread-elapsed')?.hidden).toBe(false);
            // 2.5s = the injected now minus the recorded start.
            expect(row?.querySelector('.thread-elapsed')?.textContent).toBe('2.5s');

            // The terminal patch carries the RECORDED end: the live reading is replaced,
            // and the start the row already bound survives an end-only patch.
            frame(board, document, 't1', [
                { op: 'section:set', turnId: 't1', sectionId: 't1:1', patch: { state: 'done', endedAt: T + 4_000 } }
            ]);

            expect(row?.querySelector('.thread-elapsed')?.textContent).toBe('4.0s');
            expect(row?.querySelector<HTMLElement>('.thread-status')?.dataset.state).toBe('done');
            // The delegated row's state never travels up to the turn tile.
            expect(tile.element.dataset.state).toBe('streaming');
        } finally {
            vi.useRealTimers();
        }
    });
});

// ---------------------------------------------------------------------------
// V1 — an applied document that changed NOTHING must not re-render anything.
// ---------------------------------------------------------------------------
//
// What this pins (review finding V1, the last R4 design bullet): every applied document hands
// each loaded tile its display tree again (`reconcileView` → `syncDisplay`, turns.ts:9739), and
// the poll carry (./main.ts `carryDisplays`) re-applies an UNCHANGED tree once a second while
// work is pending. That node-level reconcile is idempotent but not free: a COMMITTED text node
// takes the ungated branch of `syncCompiledNode` (turns.ts:7966) → `renderText` → `paintProse`
// (turns.ts:5472) → `replaceChildren(markdownFragment(text))`. Before the fingerprint gate
// (turns.ts:779 `displaySignatureOf`) a polling session re-parsed every loaded tile's Markdown
// every second, and the reader's live text selection died with each replaced fragment.
//
// Both directions are pinned, in order: the skip must FIRE for an unchanged tree, and it must
// never fire for a changed one — including a tree that was mutated IN PLACE, which is exactly
// what a stream frame does to this very object (../view-state.ts:396 `sections.push`, :443
// `node.text += op.delta`, :509 `sections.splice`). That is why the gate is structural and not
// a reference check.

describe('an unchanged applied tree does not re-render (V1)', () => {
    it('keeps every parsed Markdown node for an unchanged tree, and re-renders as soon as the tree moves', () => {
        // One committed prose node, painted through the real Markdown path, so the parsed
        // <strong> is an object whose identity answers "did `paintProse` run again?".
        const node: DisplayTextNode = { kind: 'text', id: 'n0', text: 'first **answer**', committed: true };
        const section = rootSection({ state: 'done', nodes: [node] });
        const row = summary({ status: 'done', state: 'done', updatedAt: T + 1000 });
        const view = documentOf([row], { t1: [section] });
        const { board } = mount();
        const tile = board.upsertView(row, view);

        tile.flush();

        const prose = tile.element.querySelector<HTMLElement>('.agent-text');

        if (prose === null) throw new Error('the committed prose node was never painted');

        const strong = prose.querySelector('strong');

        expect(strong).not.toBeNull();
        // The block renderer ends a paragraph with a recorded newline (the same figure the
        // live-path assertions in this file pin, e.g. 'root answer\n' at :257).
        expect(prose.textContent).toBe('first answer\n');

        // --- phase 1: the steady-state poll tick --------------------------------------
        // The same document, re-applied: the same rows and the same tree, which is what
        // `carryDisplays` hands the board on every tick of a conversation that has not moved.
        board.reconcileView(view);
        tile.flush();

        // Identity, not content: the element the first parse created is still the element on
        // screen. If the node-level pass had run, `paintProse` would have replaced the whole
        // fragment and this reference would name a different object.
        expect(prose.querySelector('strong')).toBe(strong);
        expect(prose.textContent).toBe('first answer\n');
        expect(tile.element.querySelector('.tile-status-text')?.textContent).toBe('done');

        // --- phase 2: the tree moved IN PLACE -----------------------------------------
        // A stream frame mutating the painted object (../view-state.ts:443). A reference
        // skip would freeze the tile right here; the fingerprint sees the new bytes.
        node.text = 'first **answer** **again**';
        board.reconcileView(view);
        tile.flush();

        expect(prose.querySelector('strong')).not.toBe(strong);
        expect(prose.textContent).toBe('first answer again\n');

        // --- phase 3: a FRESH tree object for the same turn ----------------------------
        // The plane's re-read path (./view-shell.ts `ensureVisible` installs a new object):
        // different reference AND different content, so the tile advances while the block's
        // own DOM survives — a re-render is not a rebuild.
        const fresh = documentOf([row], {
            t1: [rootSection({ state: 'done', nodes: [{ kind: 'text', id: 'n0', text: 'a **different** answer', committed: true }] })]
        });

        board.reconcileView(fresh);
        tile.flush();

        expect(tile.element.querySelector('.agent-text')).toBe(prose);
        expect(prose.textContent).toBe('a different answer\n');
    });
});
