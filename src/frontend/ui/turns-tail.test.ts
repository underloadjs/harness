// T22: the ONE current tail block (R23), the count-only caption (R24), and the
// collapsed-by-default card contract (R22) — proven on the compiled turn board.
//
// Why a separate file from `turns-context-bar.test.ts`: that one owns the STRIP (its
// segments, its geometry, the click-time detail). This one owns what the user actually
// complained about in the screenshot — the wall of stale `think` chips printed under the
// bar — and the two answers are different surfaces of the same widget.
//
// Driven the way the shell drives a tile: hand-written `TurnSummary` rows and
// `TurnDisplayOp` frames applied to a document by the SAME reducer the shell runs
// (`../view-state.applyOpToDisplay`), then routed to the tile by turn id. So every test
// here states its own frame ORDER, and the hydration tests hand the same document over in
// ONE `renderDisplay` — which is what makes "live stream, drain and reconnect agree" a
// checked claim rather than an assertion about code paths.
//
// The rules pinned here, in the user's words:
//   - ONE current tail block per rendered section, printed IN FULL at the tail of that
//     section's strip — never a pile of older chips under it (R23);
//   - only the LATEST content block prints a body: thinking while it is last, the assistant
//     reply when the reply is latest; an older thinking window or answer prints nothing and
//     stays exactly one click away on its segment (R23);
//   - a recorded CALL supersedes prose, so the previous body hides when a call lands
//     (R23: "reasoning -> tool hides previous");
//   - the designated call prints its COMPLETE recorded request, and its response once the call
//     settles, as two labelled panes inside that one body — bounded only by
//     `DISPLAY_TAIL_PAYLOAD_CHARS`, never by the step's own `argsPreview` (R23);
//   - a bounded thinking preview is labelled as one, beside the server's EXACT character
//     count — the browser never claims a 320-character preview is the whole round (R23);
//   - the visible stats line is the segment COUNT, pluralized correctly (R24);
//   - rendering the tail costs ZERO requests (R8), and
//   - hydrated/imported cards start collapsed; only a click expands one, and a reader's
//     choice survives the frames that follow (R22).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-tail.test.ts

import type {
    ContextBlock,
    TurnBlockDetail,
    TurnDisplay,
    TurnDisplayOp,
    TurnSection,
    TurnSummary
} from '../../shared/turn-display';
import type { SessionView } from '../../server/protocol';
import type { HarnessPendingTool } from '../../types';
import type { TurnBoard } from './turns';
import { createTurnBoard } from './turns';
import { applyOpsToDisplay } from '../view-state';
import { clearBlockDetailCache } from './context-detail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const summary = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
    id: 't1',
    index: 0,
    prompt: 'read the notes and tell me what changed',
    status: 'running',
    state: 'streaming',
    updatedAt: T,
    sectionCount: 1,
    stepCount: 0,
    activeAgents: ['instruct'],
    blocks: [],
    ...overrides
});

const block = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
    kind: 'tool',
    id: '0-tool-7',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'read',
    chars: 1_184,
    argsChars: 20,
    resultChars: 1_164,
    inPrompt: true,
    state: 'ok',
    eventFrom: 7,
    eventTo: 9,
    at: T,
    endedAt: T + 800,
    ...overrides
});

const promptBlock = block({
    kind: 'user',
    id: '0-user-prompt',
    name: 'prompt',
    chars: 40,
    argsChars: undefined,
    resultChars: undefined,
    state: undefined,
    eventFrom: undefined,
    eventTo: undefined,
    endedAt: undefined
});

const thinkBlock = (id: string, chars: number, sectionId = 't1:0'): ContextBlock =>
    block({
        kind: 'reasoning',
        id,
        sectionId,
        name: 'reasoning',
        chars,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        inPrompt: false,
        eventFrom: 3,
        eventTo: 4,
        endedAt: undefined
    });

const answerBlock = (id: string, chars: number, sectionId = 't1:0'): ContextBlock =>
    block({
        kind: 'assistant',
        id,
        sectionId,
        name: 'answer',
        chars,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        eventFrom: 5,
        eventTo: 6,
        endedAt: undefined
    });

const rootSection = (overrides: Partial<TurnSection> = {}): TurnSection => ({
    id: 't1:0',
    role: 'primary',
    agent: 'instruct',
    agentLabel: 'RR1',
    state: 'streaming',
    nodes: [],
    context: [promptBlock],
    ...overrides
});

const childSection = (overrides: Partial<TurnSection> = {}): TurnSection => ({
    id: 't1:1',
    parentSectionId: 't1:0',
    role: 'subagent',
    agent: 'helper',
    agentLabel: 'RH1',
    threadId: 'th-1',
    state: 'streaming',
    nodes: [],
    context: [block({ kind: 'user', id: '1-user-prompt', name: 'prompt', sectionId: 't1:1', argsChars: undefined, resultChars: undefined, state: undefined, eventFrom: undefined, eventTo: undefined, endedAt: undefined })],
    ...overrides
});

// The three node shapes the projector sends for model content. The reasoning window is
// written the way the wire writes it once it passes the cap: a bounded `text`, the EXACT
// `chars`, and `redacted: true` saying which of the two is a preview.
const PREVIEW = 'a bounded preview of the thinking';
const ANSWER = 'the complete recorded answer, every line of it';

const thinkNode = (
    id: string,
    text: string,
    figures: { chars?: number; redacted?: boolean } = {}
): TurnSection['nodes'][number] =>
    ({
        kind: 'reasoning',
        id,
        text,
        ...(figures.chars === undefined ? {} : { chars: figures.chars }),
        ...(figures.redacted === true ? { redacted: true } : {})
    }) as TurnSection['nodes'][number];

const answerNode = (id: string, text: string, committed = false): TurnSection['nodes'][number] =>
    ({ kind: 'text', id, text, chars: text.length, committed }) as TurnSection['nodes'][number];

const stepNode = (id: string, name = 'read'): TurnSection['nodes'][number] =>
    ({
        kind: 'tool',
        id,
        turnId: 't1',
        sectionId: 't1:0',
        callId: `call-${id}`,
        name,
        argsPreview: 'path=notes',
        preview: 'the file body',
        state: 'ok',
        outcome: 'completed',
        startedAt: T,
        endedAt: T + 800,
        durationMs: 800,
        detail: { stepId: id, hasResult: true, truncated: true }
    }) as TurnSection['nodes'][number];

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

const displayOf = (view: SessionView, turnId = 't1'): TurnDisplay =>
    (view.displays as Record<string, TurnDisplay>)[turnId];

const pending = new Map<string, HarnessPendingTool[]>();

/** One frame, applied exactly as `main.ts onViewItem` does: document first, then tile. */
const frame = (board: TurnBoard, view: SessionView, turnId: string, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(view, turnId, ops, pending);

    return board.applyViewOps(turnId, ops, view);
};

const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): {
    board: TurnBoard;
    tile: () => HTMLElement;
    row: () => HTMLElement | null;
} => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ ...options, empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return {
        board,
        tile: () => document.querySelector<HTMLElement>('.tile') as HTMLElement,
        row: () => document.querySelector<HTMLElement>('.thread-row')
    };
};

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The ONE tail body inside a scope, whether or not anything is currently printed in it. */
const tails = (scope: Element): HTMLElement[] =>
    Array.from(scope.querySelectorAll<HTMLElement>('.context-bar-tail'));

const tailState = (scope: Element): Record<string, unknown> | undefined => {
    const tail = tails(scope)[0];
    if (tail === undefined) return undefined;

    return {
        hidden: tail.hidden,
        kind: tail.dataset.kind,
        nodeId: tail.dataset.nodeId,
        blockId: tail.dataset.blockId,
        chars: tail.dataset.chars,
        truncated: tail.dataset.truncated,
        caption: tail.querySelector('.context-bar-tail-caption')?.textContent,
        body: tail.querySelector('.context-bar-tail-body')?.textContent
    };
};

const proseState = (scope: Element): { nodeId?: string; hidden: HTMLElement['hidden']; superseded?: string }[] =>
    Array.from(scope.querySelectorAll<HTMLElement>('.agent-text')).map((node) => ({
        nodeId: node.dataset.contextNode,
        hidden: node.hidden,
        ...(node.dataset.superseded === undefined ? {} : { superseded: node.dataset.superseded })
    }));

const segmentsIn = (scope: Element): HTMLElement[] =>
    Array.from(scope.querySelectorAll<HTMLElement>('.context-bar-segment'));

beforeEach(() => {
    pending.clear();
    clearBlockDetailCache();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// R23: the live sequence — one body, in the server's order, nothing left behind
// ---------------------------------------------------------------------------

describe('the current tail block, streamed frame by frame', () => {
    it('prints ONE thinking body at the tail of the strip, and mints no think chip', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay(displayOf(view));

        // Nothing printed, nothing fetched: the strip alone is the surface.
        expect(tails(tile())[0]?.hidden).toBe(true);

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 1_234) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', PREVIEW, { chars: 1_234, redacted: true }) }
        ]);

        // ONE body, at the tail of the strip, scoped to this section's own host.
        expect(tails(tile())).toHaveLength(1);
        expect(tailState(tile())).toEqual({
            hidden: false,
            kind: 'reasoning',
            nodeId: '3',
            // The segment this block stands for: provenance, so the reader can always get
            // the exact bytes back from the bar.
            blockId: '0-reasoning-3',
            // The EXACT recorded length (invariant 5), never the preview's length.
            chars: '1234',
            truncated: 'true',
            caption: `thinking · showing ${PREVIEW.length} of 1,234 characters — click the segment for the exact text`,
            body: PREVIEW
        });

        // The stale-chip pile this replaces: zero chips, and no tool row to hold them.
        expect(tile().querySelectorAll('.tool.think')).toHaveLength(0);
        expect(tile().querySelectorAll('.tool-group')).toHaveLength(0);
    });

    it('grows that same body as the round streams, and never adds a second one', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 13) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', 'first thought') }
        ]);

        expect(tailState(tile())).toMatchObject({ hidden: false, nodeId: '3', body: 'first thought', chars: '13', truncated: 'false' });

        frame(board, view, 't1', [
            { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: '3', delta: ' and more thought' },
            { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-reasoning-3', patch: { chars: 30 } }
        ]);

        // The SAME element, now with the cumulative text and the segment's new exact count.
        expect(tails(tile())).toHaveLength(1);
        expect(tailState(tile())).toMatchObject({
            hidden: false,
            nodeId: '3',
            body: 'first thought and more thought',
            chars: '30',
            truncated: 'false',
            caption: 'thinking · 30 characters'
        });
    });

    it('hides the previous body the moment a recorded call becomes the newest block', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 13) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', 'first thought') }
        ]);
        expect(tails(tile())[0]?.hidden).toBe(false);

        // `reasoning -> tool hides previous`: the call is a segment now, so no prose body
        // prints — and the element is HIDDEN rather than removed, which is what guarantees
        // the next round reuses it instead of stacking under the strip.
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block() },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: stepNode('7') }
        ]);

        expect(tails(tile())).toHaveLength(1);
        expect(tails(tile())[0]?.hidden).toBe(true);
        expect(tails(tile())[0]?.dataset.nodeId).toBeUndefined();
        expect(tails(tile())[0]?.querySelector('.context-bar-tail-body')?.textContent).toBe('');
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
        expect(segmentsIn(tile()).map((node) => node.dataset.blockId)).toEqual(['0-user-prompt', '0-reasoning-3', '0-tool-7']);
    });

    it('shows one body again for the next round, then lets the final answer replace it', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 13) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', 'first thought') },
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block() },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: stepNode('7') }
        ]);

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-10', 11) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('10', 'second round') }
        ]);

        // One body, and it is the NEW round's: the first window printed nothing but a segment.
        expect(tails(tile())).toHaveLength(1);
        expect(tailState(tile())).toMatchObject({ hidden: false, nodeId: '10', body: 'second round', blockId: '0-reasoning-10' });

        // The final answer: the thinking body is withdrawn and the answer's own prose block
        // — the existing full-answer surface immediately below the strip — takes its place.
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: answerBlock('0-assistant-12', ANSWER.length) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: answerNode('12', ANSWER) },
            { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: '12', patch: { committed: true } },
            { op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { answerNodeId: '12' } },
            { op: 'attempt:commit', turnId: 't1', sectionId: 't1:0' }
        ]);

        expect(tails(tile())[0]?.hidden).toBe(true);
        expect(proseState(tile())).toEqual([{ nodeId: '12', hidden: false }]);
        // The block prints the answer's EXACT bytes and nothing is withheld. The trailing
        // newline is the markdown writer's flush, the same pinned everywhere else in this
        // renderer (ui/turns-compiled.test.ts:257, ui/turns-threads.test.ts:339).
        expect(tile().querySelector('.agent-text')?.textContent).toBe(`${ANSWER}\n`);
        // Still one body element in the tile, and still no chip pile.
        expect(tails(tile())).toHaveLength(1);
        expect(tile().querySelectorAll('.tool.think')).toHaveLength(0);
    });

    it('hides an answer that a later thinking window superseded', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: answerBlock('0-assistant-5', 7) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: answerNode('5', ' interim ') },
            { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: '5', patch: { committed: true } },
            { op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { answerNodeId: '5' } }
        ]);

        expect(proseState(tile())).toEqual([{ nodeId: '5', hidden: false }]);

        // A new round of thinking is the newest block now, so the answer withdraws: R23
        // allows exactly one content body per section, whichever block is current.
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-8', 11) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('8', 'still going') }
        ]);

        expect(proseState(tile())).toEqual([{ nodeId: '5', hidden: true, superseded: 'true' }]);
        expect(tailState(tile())).toMatchObject({ hidden: false, nodeId: '8', body: 'still going' });
    });
});

// ---------------------------------------------------------------------------
// R23: hydration and reconnect land on the same single body
// ---------------------------------------------------------------------------

describe('the same document rendered at once', () => {
    /** The document the live sequence above ends on: prompt, thinking, a call, thinking,
     *  and the committed answer that replaced it. */
    const finalSection = (): TurnSection =>
        rootSection({
            answerNodeId: '12',
            context: [
                promptBlock,
                thinkBlock('0-reasoning-3', 1_234),
                block(),
                thinkBlock('0-reasoning-10', 11),
                answerBlock('0-assistant-12', ANSWER.length)
            ],
            nodes: [
                thinkNode('3', PREVIEW, { chars: 1_234, redacted: true }),
                stepNode('7'),
                thinkNode('10', 'second round'),
                answerNode('12', ANSWER, true)
            ]
        });

    it('prints the answer only, with one hidden body element and no chips', () => {
        const view = documentOf([summary()], { t1: [finalSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        expect(tails(tile())).toHaveLength(1);
        expect(tails(tile())[0]?.hidden).toBe(true);
        expect(proseState(tile())).toEqual([{ nodeId: '12', hidden: false }]);
        expect(tile().querySelectorAll('.tool.think')).toHaveLength(0);
        expect(segmentsIn(tile())).toHaveLength(5);
    });

    it('ends a thinking-last document on the same body the live stream showed', () => {
        const live = documentOf([summary()], { t1: [rootSection()] });
        const liveBoard = createTurnBoard({ empty: document.createElement('div') });
        liveBoard.bindSession('s1');
        document.body.replaceChildren(liveBoard.element);
        liveBoard.upsertView(summary(), live).renderDisplay(displayOf(live));
        frame(liveBoard, live, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 1_234) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', PREVIEW, { chars: 1_234, redacted: true }) }
        ]);
        const streamed = tailState(document.querySelector<HTMLElement>('.tile') as Element);

        // The same server state, delivered as ONE cold document (a reload, a drain frame).
        const cold = documentOf([summary()], {
            t1: [rootSection({ context: [promptBlock, thinkBlock('0-reasoning-3', 1_234)], nodes: [thinkNode('3', PREVIEW, { chars: 1_234, redacted: true })] })]
        });
        const coldBoard = createTurnBoard({ empty: document.createElement('div') });
        coldBoard.bindSession('s1');
        document.body.replaceChildren(coldBoard.element);
        coldBoard.upsertView(summary(), cold).renderDisplay(displayOf(cold));

        expect(tailState(document.querySelector<HTMLElement>('.tile') as Element)).toEqual(streamed);
    });

    it('re-derives the same body after the ops stream is dropped and re-hydrated', () => {
        const view = documentOf([summary()], { t1: [finalSection()] });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), view);

        // Cold document first, then the same document again: a reconcile must not leave a
        // second body behind, and it must not resurrect an older block's text.
        handle.renderDisplay(displayOf(view));
        handle.syncDisplay(displayOf(view));
        handle.renderDisplay(displayOf(view));

        expect(tails(tile())).toHaveLength(1);
        expect(proseState(tile())).toEqual([{ nodeId: '12', hidden: false }]);
        expect(tile().querySelectorAll('.tool.think')).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// R23: the tail is scoped to ONE section
// ---------------------------------------------------------------------------

describe('one tail per rendered section', () => {
    it('a delegated card prints its own thinking body, never its caller\'s', () => {
        const view = documentOf([summary({ sectionCount: 2 })], {
            t1: [
                rootSection({
                    context: [promptBlock, thinkBlock('0-reasoning-3', 13)],
                    nodes: [thinkNode('3', 'caller thought')]
                }),
                childSection({
                    context: [block({ kind: 'user', id: '1-user-prompt', name: 'prompt', sectionId: 't1:1', chars: 30, argsChars: undefined, resultChars: undefined, state: undefined, eventFrom: undefined, eventTo: undefined, endedAt: undefined }), thinkBlock('1-reasoning-4', 15, 't1:1')],
                    nodes: [thinkNode('4', 'callee thought')]
                })
            ]
        });
        const { board, tile, row } = mount();
        board.upsertView(summary({ sectionCount: 2 }), view).renderDisplay(displayOf(view));

        const card = row() as HTMLElement;

        // Each host carries exactly one body, and each body is its OWN section's text.
        expect(tails(tile())).toHaveLength(1);
        expect(tails(card)).toHaveLength(1);
        expect(tailState(tile())).toMatchObject({ hidden: false, nodeId: '3', body: 'caller thought', blockId: '0-reasoning-3' });
        expect(tailState(card)).toMatchObject({ hidden: false, nodeId: '4', body: 'callee thought', blockId: '1-reasoning-4' });

        // Neither section leaks into the other's tail: the strip and its body are one pair.
        expect(tile().textContent).not.toContain('callee thought');
        expect(card.textContent).not.toContain('caller thought');
        expect(card.querySelectorAll('.context-bar-host')).toHaveLength(1);
    });

    it('a section whose newest block is a call prints no body even while its caller is thinking', () => {
        const view = documentOf([summary({ sectionCount: 2 })], {
            t1: [
                rootSection({ context: [promptBlock, thinkBlock('0-reasoning-3', 13)], nodes: [thinkNode('3', 'caller thought')] }),
                childSection({
                    context: [block({ id: '1-tool-5', sectionId: 't1:1', name: 'grep' })],
                    nodes: [stepNode('5', 'grep')]
                })
            ]
        });
        const { board, tile, row } = mount();
        board.upsertView(summary({ sectionCount: 2 }), view).renderDisplay(displayOf(view));

        const card = row() as HTMLElement;

        expect(tailState(tile())).toMatchObject({ hidden: false, body: 'caller thought' });
        expect(tails(card)).toHaveLength(1);
        expect(tails(card)[0]?.hidden).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T23 (R23): the current CALL is a block like any other, so it prints in full too
// ---------------------------------------------------------------------------

describe('the current call, printed in full at the tail', () => {
    const args = '{"path":"notes.md","query":"what changed"}';
    const result = 'the whole recorded file body, every line of it';

    // The step exactly as the compact wire sends it: bounded previews, the settled state,
    // the detail pointer. The full payload is NOT on it — it rides the designation, which is
    // what keeps a 300-call turn's tree small while the ONE current call is readable.
    const callStep = (overrides: Record<string, unknown> = {}): TurnSection['nodes'][number] =>
        ({
            kind: 'tool',
            id: '7',
            turnId: 't1',
            sectionId: 't1:0',
            callId: 'call-1',
            name: 'read',
            argsPreview: `${args.slice(0, 20)}…`,
            preview: 'the whole recorded file body, every line of…',
            state: 'ok',
            outcome: 'completed',
            startedAt: T,
            endedAt: T + 800,
            durationMs: 800,
            detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: true },
            ...overrides
        }) as TurnSection['nodes'][number];

    const callBlock = (overrides: Partial<ContextBlock> = {}): ContextBlock =>
        block({
            id: '0-tool-7',
            chars: args.length + result.length,
            argsChars: args.length,
            resultChars: result.length,
            ...overrides
        });

    const callTail = (overrides: Record<string, unknown> = {}) =>
        ({
            kind: 'tool',
            nodeId: '7',
            blockId: '0-tool-7',
            chars: args.length + result.length,
            truncated: false,
            args,
            result,
            ...overrides
        }) as never;

    const pane = (scope: Element, which: string): string | undefined =>
        scope.querySelector<HTMLElement>(`.context-bar-tail-pane[data-pane="${which}"]`)?.querySelector('[data-field]')
            ?.textContent;

    const note = (scope: Element, which: string): { text?: string; note?: string } | undefined => {
        const node = scope.querySelector<HTMLElement>(`.context-bar-tail-pane[data-pane="${which}"] .context-bar-tail-pane-note`);

        return node === null || node === undefined ? undefined : { text: node.textContent ?? undefined, note: node.dataset.note };
    };

    it('prints the complete recorded request and response, with the server figures', () => {
        const loadBlockDetail = vi.fn();
        const loadStepDetail = vi.fn();
        const view = documentOf([summary()], {
            t1: [
                rootSection({
                    context: [promptBlock, callBlock()],
                    nodes: [callStep()],
                    tail: callTail()
                })
            ]
        });
        const { board, tile } = mount({ loadBlockDetail, loadStepDetail });
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        expect(tails(tile())).toHaveLength(1);
        expect(tailState(tile())).toEqual({
            hidden: false,
            kind: 'tool',
            nodeId: '7',
            blockId: '0-tool-7',
            chars: String(args.length + result.length),
            truncated: 'false',
            caption: `read · ok · 800ms · ${args.length + result.length} characters · args ${args.length} + result ${result.length}`,
            // The body element holds two labelled panes: the request first, then the
            // response, each behind its own label, byte for byte.
            body: `arguments${args}result${result}`
        });

        // The state is printed as a word and as a dataset, so the tone is never the only
        // signal, and the exact per-part figures ride the element.
        const surface = tails(tile())[0] as HTMLElement;

        expect(surface.dataset.state).toBe('ok');
        expect(surface.dataset.duration).toBe('800');
        expect(surface.dataset.argsChars).toBe(String(args.length));
        expect(surface.dataset.resultChars).toBe(String(result.length));
        expect(pane(tile(), 'args')).toBe(args);
        expect(pane(tile(), 'result')).toBe(result);

        // Nothing was fetched to draw a full call body: the frame that designated the block
        // carried it. The step route is never touched in this mode.
        expect(loadBlockDetail).not.toHaveBeenCalled();
        expect(loadStepDetail).not.toHaveBeenCalled();
        // And no second copy of the call: no card, one strip, one body.
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
        expect(segmentsIn(tile()).map((node) => node.dataset.blockId)).toEqual(['0-user-prompt', '0-tool-7']);
    });

    it('grows the SAME body when the call settles, and hides nothing on the way', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        // 1. the call opens: its request is the current block's body, immediately.
        frame(board, view, 't1', [
            {
                op: 'context:add',
                turnId: 't1',
                sectionId: 't1:0',
                block: callBlock({ state: 'running', chars: args.length, argsChars: args.length, resultChars: undefined, endedAt: undefined, durationMs: undefined })
            },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: callStep({ state: 'running', preview: undefined, outcome: undefined, endedAt: undefined, durationMs: undefined, detail: { stepId: '7', hasResult: false, truncated: false } }) },
            { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail({ result: undefined, chars: args.length }) }
        ]);

        expect(tailState(tile())).toMatchObject({
            hidden: false,
            kind: 'tool',
            body: `arguments${args}resultno result recorded for this call yet`
        });
        expect((tails(tile())[0] as HTMLElement).dataset.state).toBe('running');
        // A call with no recorded result says so instead of leaving a blank box.
        expect(note(tile(), 'result')).toEqual({ text: 'no result recorded for this call yet', note: 'no-result' });
        expect(tailState(tile())?.caption).toBe(`read · running · ${args.length} characters · args ${args.length} · no result recorded yet`);

        // 2. the result lands: the designation is re-sent with the response, and the body
        //    grows in place — one element, no new strip, no fetch.
        frame(board, view, 't1', [
            { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { state: 'ok', chars: args.length + result.length, resultChars: result.length, endedAt: T + 800, durationMs: 800, eventTo: 9 } },
            { op: 'step:set', turnId: 't1', sectionId: 't1:0', step: callStep() as never },
            { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail() }
        ]);

        expect(tails(tile())).toHaveLength(1);
        expect(tailState(tile())).toMatchObject({
            hidden: false,
            kind: 'tool',
            body: `arguments${args}result${result}`,
            caption: `read · ok · 800ms · ${args.length + result.length} characters · args ${args.length} + result ${result.length}`
        });
        expect(pane(tile(), 'result')).toBe(result);
    });

    it('withdraws the payload the moment the next thinking window takes the tail', () => {
        const view = documentOf([summary()], {
            t1: [rootSection({ context: [promptBlock, callBlock()], nodes: [callStep()], tail: callTail() })]
        });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        expect(pane(tile(), 'result')).toBe(result);

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-10', 11) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('10', 'second round') },
            { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: { kind: 'reasoning', nodeId: '10', blockId: '0-reasoning-10', chars: 11, truncated: false } }
        ]);

        // One body, and it is the new block's. The call's complete payload is gone from the
        // rendered document, exactly as the designation dropped it (R23 compactness).
        expect(tails(tile())).toHaveLength(1);
        expect(tailState(tile())).toMatchObject({ hidden: false, kind: 'reasoning', nodeId: '10', body: 'second round' });
        expect(tile().textContent).not.toContain(result);
        expect(tile().textContent).not.toContain(args);
        // The call keeps its segment, so the reader is one click from those bytes again.
        expect(segmentsIn(tile()).map((node) => node.dataset.blockId)).toContain('0-tool-7');
    });

    it('shows the failed call with its recorded error as the body', () => {
        const failure = 'ENOENT: no such file or directory: notes.md';
        const view = documentOf([summary()], {
            t1: [
                rootSection({
                    context: [promptBlock, callBlock({ state: 'error', chars: args.length + failure.length, resultChars: failure.length })],
                    nodes: [callStep({ state: 'error', outcome: 'failed', preview: failure })],
                    tail: callTail({ result: failure, chars: args.length + failure.length })
                })
            ]
        });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        expect((tails(tile())[0] as HTMLElement).dataset.state).toBe('error');
        expect(pane(tile(), 'result')).toBe(failure);
        expect(tailState(tile())?.caption).toBe(
            `read · error · 800ms · ${args.length + failure.length} characters · args ${args.length} + result ${failure.length}`
        );
    });

    it('reaches the same body whether the frames streamed or the document arrived at once', () => {
        const streamed = documentOf([summary()], { t1: [rootSection()] });
        const streamBoard = createTurnBoard({ empty: document.createElement('div') });

        streamBoard.bindSession('s1');
        document.body.replaceChildren(streamBoard.element);
        streamBoard.upsertView(summary(), streamed).renderDisplay(displayOf(streamed));
        frame(streamBoard, streamed, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: callBlock() },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: callStep() },
            { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail() }
        ]);
        const streamedState = tailState(document.querySelector<HTMLElement>('.tile') as Element);

        const cold = documentOf([summary()], {
            t1: [rootSection({ context: [promptBlock, callBlock()], nodes: [callStep()], tail: callTail() })]
        });
        const coldBoard = createTurnBoard({ empty: document.createElement('div') });

        coldBoard.bindSession('s1');
        document.body.replaceChildren(coldBoard.element);
        coldBoard.upsertView(summary(), cold).renderDisplay(displayOf(cold));

        expect(tailState(document.querySelector<HTMLElement>('.tile') as Element)).toEqual(streamedState);
    });

    it('prints a delegated call inside its own card, never in its caller’s block', () => {
        const view = documentOf([summary({ sectionCount: 2 })], {
            t1: [
                rootSection({ context: [promptBlock, thinkBlock('0-reasoning-3', 13)], nodes: [thinkNode('3', 'caller thought')] }),
                childSection({
                    context: [callBlock({ id: '1-tool-5', sectionId: 't1:1', name: 'grep' })],
                    nodes: [
                        callStep({ id: '5', name: 'grep' }),
                        ...[]
                    ],
                    tail: callTail({ nodeId: '5', blockId: '1-tool-5' })
                })
            ]
        });
        const { board, tile, row } = mount();
        board.upsertView(summary({ sectionCount: 2 }), view).renderDisplay(displayOf(view));

        const card = row() as HTMLElement;

        expect(tailState(tile())).toMatchObject({ kind: 'reasoning', body: 'caller thought' });
        expect(tailState(card)).toMatchObject({ kind: 'tool', nodeId: '5', blockId: '1-tool-5' });
        expect(pane(card, 'args')).toBe(args);
        // Neither section leaks into the other's body.
        expect(tile().textContent).not.toContain(result);
        expect(card.textContent).not.toContain('caller thought');
    });

    it('keeps a legacy section — one the server never designated — exactly as T22 left it', () => {
        // No `tail` field is the pre-T23 producer's silence. The recorded-order fallback
        // still hides the prose behind a call, and it never invents a full call body it was
        // not given (the compactness rule holds on the old wire too).
        const view = documentOf([summary()], {
            t1: [rootSection({ context: [promptBlock, thinkBlock('0-reasoning-3', 13), callBlock()], nodes: [thinkNode('3', 'first thought'), callStep()] })]
        });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        expect(tails(tile())).toHaveLength(1);
        expect(tails(tile())[0]?.hidden).toBe(true);
        expect(tile().textContent).not.toContain(args);
    });
});

// ---------------------------------------------------------------------------
// R8/R23: hidden blocks are still exact, and printing the tail costs nothing
// ---------------------------------------------------------------------------

describe('a hidden block stays one request away', () => {
    const detailFor = (blockId: string): TurnBlockDetail => {
        const source =
            blockId === '0-reasoning-3'
                ? thinkBlock('0-reasoning-3', 1_234)
                : blockId === '0-assistant-12'
                  ? answerBlock('0-assistant-12', ANSWER.length)
                  : block();

        return {
            ...source,
            sessionId: 's1',
            ...(source.kind === 'tool'
                ? { args: '{"path":"notes.md"}', result: 'the whole recorded file body' }
                : { text: 'the recorded thinking window, every character of it' })
        };
    };

    it('asks for nothing while the tail renders, and once per clicked segment', async () => {
        const loadBlockDetail = vi.fn(async (input: { blockId: string }) => detailFor(input.blockId));
        const loadStepDetail = vi.fn();
        const view = documentOf([summary()], {
            t1: [
                rootSection({
                    answerNodeId: '12',
                    context: [promptBlock, thinkBlock('0-reasoning-3', 1_234), answerBlock('0-assistant-12', ANSWER.length)],
                    nodes: [
                        thinkNode('3', PREVIEW, { chars: 1_234, redacted: true }),
                        answerNode('12', ANSWER, true)
                    ]
                })
            ]
        });
        const { board, tile } = mount({ loadBlockDetail, loadStepDetail });
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        // Rendering the tail prints text the frame ALREADY carried: no request, and the
        // step route is never touched in this mode.
        expect(loadBlockDetail).not.toHaveBeenCalled();
        expect(loadStepDetail).not.toHaveBeenCalled();

        // The hidden thinking window is still exactly one click away on its own segment.
        segmentsIn(tile())[1].click();
        await settled();

        expect(loadBlockDetail.mock.calls.map((call) => (call[0 as never] as { blockId: string }).blockId)).toEqual([
            '0-reasoning-3'
        ]);
        expect(document.querySelector<HTMLElement>('[data-pane="text"]')?.textContent).toContain(
            'the recorded thinking window, every character of it'
        );
        // The dialog states the EXACT recorded length, so a preview body on screen and the
        // full bytes in the dialog can never be confused for each other.
        expect(document.querySelector('.block-detail-fact[data-fact="chars"]')?.textContent).toBe('1,234 characters recorded');
    });
});

// ---------------------------------------------------------------------------
// R24: the visible stats line is the count
// ---------------------------------------------------------------------------

describe('the count-only caption on the board', () => {
    it('prints "1 segment" for one, "2 segments" for two, and no character totals', () => {
        const one = documentOf([summary()], { t1: [rootSection({ context: [promptBlock] })] });
        const { board, tile } = mount();
        board.upsertView(summary(), one).renderDisplay(displayOf(one));

        expect(tile().querySelector('.context-bar-caption')?.textContent).toBe('1 segment');

        frame(board, one, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 1_234) }
        ]);

        expect(tile().querySelector('.context-bar-caption')?.textContent).toBe('2 segments');
        // The figures the user called useless are gone from the printed line…
        expect(tile().querySelector('.context-bar-caption')?.textContent).not.toContain('characters');
        // …and the exact count of every segment is still one aim away.
        expect(segmentsIn(tile())[1].dataset.chars).toBe('1234');
        expect(
            (tile().querySelectorAll<HTMLElement>('.context-bar-segment')[1] as HTMLElement).getAttribute('aria-label') ?? ''
        ).toContain('1,234 characters');
    });
});

// ---------------------------------------------------------------------------
// R22: expansion is the reader's, not the projection's
// ---------------------------------------------------------------------------

describe('the collapsed-by-default card contract', () => {
    const twoSectionView = (): SessionView =>
        documentOf([summary({ sectionCount: 2 })], {
            t1: [
                rootSection({ context: [promptBlock, thinkBlock('0-reasoning-3', 13)], nodes: [thinkNode('3', 'caller thought')] }),
                childSection({
                    context: [block({ id: '1-tool-5', sectionId: 't1:1', name: 'grep' })],
                    nodes: [stepNode('5', 'grep')]
                })
            ]
        });

    it('hydrates an imported conversation with EVERY card collapsed', () => {
        const view = twoSectionView();
        const { board, tile, row } = mount();
        board.hydrateView(view);

        const card = row() as HTMLElement;

        // No thread expanded on first load: the card is a collapsed row, and the body it
        // owns (strip, tail, flow) stays hidden until the reader asks for it.
        expect(card.classList.contains('is-expanded')).toBe(false);
        expect(card.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('false');
        expect(card.querySelectorAll<HTMLElement>('.context-bar-host')[0]?.hidden).toBe(false);
        expect(tile().querySelectorAll('.thread-row.is-expanded')).toHaveLength(0);
    });

    it('streaming a new section never expands the card it belongs to', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, row } = mount();
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay(displayOf(view));
        handle.applyOps([{ op: 'turn', turnId: 't1', summary: summary({ sectionCount: 1 }) }], displayOf(view));

        frame(board, view, 't1', [
            {
                op: 'section:open',
                turnId: 't1',
                section: childSection({ context: [block({ id: '1-tool-5', sectionId: 't1:1', name: 'grep' })] })
            },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:1', node: stepNode('5', 'grep') }
        ]);

        const card = row() as HTMLElement;
        expect(card).not.toBe(null);
        expect(card.classList.contains('is-expanded')).toBe(false);
        expect(card.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps a card the reader opened expanded across the frames that follow', () => {
        const view = twoSectionView();
        const { board, row } = mount();
        const [handle] = board.hydrateView(view);

        (row() as HTMLElement).querySelector<HTMLElement>('.thread-select')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        const card = row() as HTMLElement;
        expect(card.classList.contains('is-expanded')).toBe(true);

        // An incremental ops frame must not collapse what the reader opened.
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:1', block: thinkBlock('1-reasoning-9', 12, 't1:1') },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:1', node: thinkNode('9', 'callee thought') }
        ]);

        expect(row()?.classList.contains('is-expanded')).toBe(true);
        expect(row()?.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('true');
        // …and the new thinking window prints in THAT card's tail, still one body.
        expect(tails(row() as HTMLElement)).toHaveLength(1);
        expect(tailState(row() as Element)).toMatchObject({ hidden: false, nodeId: '9', body: 'callee thought' });

        // The two whole-tree update paths are the ones a drain, a poll and a reconnect use.
        // Neither may reset an expansion the reader chose.
        handle.syncDisplay(displayOf(view));
        expect(row()?.classList.contains('is-expanded')).toBe(true);

        handle.renderDisplay(displayOf(view));
        expect(row()?.classList.contains('is-expanded')).toBe(true);

        board.reconcileView(view);

        expect(row()?.classList.contains('is-expanded')).toBe(true);
        expect(row()?.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('true');
        // Still exactly one body in this card after every one of those passes.
        expect(tails(row() as HTMLElement)).toHaveLength(1);
        expect(tailState(row() as Element)).toMatchObject({ hidden: false, nodeId: '9', body: 'callee thought' });
    });

    it('never re-opens a card the reader collapsed, even when the parent tile expands', () => {
        const view = twoSectionView();
        const { board, tile, row } = mount();
        const [handle] = board.hydrateView(view);

        const card = row() as HTMLElement;
        card.querySelector<HTMLElement>('.thread-select')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(card.classList.contains('is-expanded')).toBe(true);

        // The footer chevron is the reader's collapse of this card.
        card.querySelector<HTMLElement>('.answer-collapse')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(row()?.classList.contains('is-expanded')).toBe(false);

        // Expanding the parent tile runs the board's implicit-reveal pass. It exists so an
        // expanded exchange is not hidden inside a collapsed card — it must NOT undo the
        // collapse the reader just chose, which is the R22 defect this pins.
        board.expand(handle);
        expect(row()?.classList.contains('is-expanded')).toBe(false);

        // The tile itself is still the reader's to open, and the caller's strip still prints
        // its own single body: the collapse removed the card's BODY, never the tile's content.
        expect(tile().classList.contains('is-expanded')).toBe(true);
        expect(tailState(tile())).toMatchObject({ hidden: false, body: 'caller thought' });

        // And no later update re-forges the reveal: an ops frame, a reconcile and the
        // implicit-reveal pass that runs inside it all keep the card exactly as left.
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:1', block: thinkBlock('1-reasoning-9', 12, 't1:1') },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:1', node: thinkNode('9', 'callee thought') }
        ]);
        expect(row()?.classList.contains('is-expanded')).toBe(false);

        handle.syncDisplay(displayOf(view));
        expect(row()?.classList.contains('is-expanded')).toBe(false);

        board.expand(handle);
        expect(row()?.classList.contains('is-expanded')).toBe(false);

        board.reconcileView(view);
        expect(row()?.classList.contains('is-expanded')).toBe(false);
        expect(row()?.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('false');
        // The callee's window is still ONE body, printed inside the collapsed card's own host.
        expect(tails(row() as HTMLElement)).toHaveLength(1);
        expect(tailState(row() as Element)).toMatchObject({ hidden: false, nodeId: '9', body: 'callee thought' });
    });
});

// ---------------------------------------------------------------------------
// The compatibility rule: a section the bar never described is untouched
// ---------------------------------------------------------------------------

describe('a legacy section with no context', () => {
    it('keeps its chips and every prose block, and prints no tail body', () => {
        const view = documentOf([summary()], {
            t1: [
                rootSection({
                    // `context` ABSENT: this frame says nothing, so the strip is not the
                    // authority and the flow keeps rendering the way it always did.
                    context: undefined,
                    nodes: [
                        thinkNode('3', 'a thought worth keeping'),
                        answerNode('5', 'an answer')
                    ]
                })
            ]
        });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        expect(tile().querySelector<HTMLElement>('.context-bar-host')?.hidden).toBe(true);
        // No strip => no tail end to print a block at, so the element is not even mounted.
        expect(tails(tile())).toHaveLength(0);
        // One chip for the round (the pre-bar surface), and the answer prints.
        expect(tile().querySelectorAll('.tool.think')).toHaveLength(1);
        expect(proseState(tile())).toEqual([{ nodeId: '5', hidden: false }]);
    });
});
