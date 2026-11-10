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
//   - ONE current tail block per rendered section, printed IN FULL as the LAST block of that
//     section's own flow — never a pile of older chips under the strip (R23, repositioned by
//     T27 R2 so it sits below the response that came before it);
//   - the tail block prints only the block the SERVER designated: an older thinking window or
//     call prints nothing and stays exactly one click away on its segment (R23);
//   - the newest assistant RESPONSE stays printed while it is the newest response, whichever
//     block owns the tail, and every older one withdraws (T27, R2) — this is the half of R23
//     that changed: a recorded CALL no longer hides the reply that preceded it;
//   - the designated call prints its COMPLETE recorded request, and its response once the call
//     settles, as two labelled panes inside that one body — the exact recorded bytes, capped
//     by nothing in the display contract (T25) and never by the step's own `argsPreview` (R23);
//   - a thinking body is windowed by NOTHING: every character the wire delivered is in the DOM
//     inside a scroll box of the SAME height the call's two panes get (T27, R1a/R1b). On the
//     whole-body path the caption states the server's EXACT character count with no "showing X
//     of Y" clause; on a path where the PRODUCER itself sent fewer bytes than the record, the
//     figures stay honest and the clause stays (T27 review, P2);
//   - the visible stats line is the segment COUNT, pluralized correctly (R24);
//   - rendering the tail costs ZERO requests (R8), and
//   - hydrated/imported cards start collapsed; only a click expands one, and a reader's
//     choice survives the frames that follow (R22).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-tail.test.ts

import type {
    ContextBlock,
    DisplayStep,
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

    const body = tail.querySelector<HTMLElement>('.context-bar-tail-body');

    return {
        hidden: tail.hidden,
        kind: tail.dataset.kind,
        nodeId: tail.dataset.nodeId,
        blockId: tail.dataset.blockId,
        chars: tail.dataset.chars,
        truncated: tail.dataset.truncated,
        // T26 (R26): the WIRE's truncation state above, and the PANE's below — how many
        // recorded characters are on screen, whether that is fewer than the record, and the
        // scroll policy the clipped box declares. `follow` is asserted rather than `scrollTop`
        // because jsdom has no layout: the intent is the testable fact, the pixel is not. A
        // prose body follows on its own box; a call's panes follow on each payload box.
        shownChars: tail.dataset.shownChars,
        renderBounded: tail.dataset.renderBounded,
        follow:
            body?.dataset.follow ??
            body?.querySelector('pre[data-field]')?.getAttribute('data-follow') ??
            undefined,
        caption: tail.querySelector('.context-bar-tail-caption')?.textContent,
        body: body?.textContent
    };
};

const proseState = (scope: Element): { nodeId?: string; hidden: HTMLElement['hidden']; superseded?: string }[] =>
    Array.from(scope.querySelectorAll<HTMLElement>('.agent-text')).map((node) => ({
        nodeId: node.dataset.contextNode,
        hidden: node.hidden,
        ...(node.dataset.superseded === undefined ? {} : { superseded: node.dataset.superseded })
    }));

/**
 * One section flow, read as an ORDER (T27, R2).
 *
 * Document order IS visual order in this renderer, so "the assistant response stays above the
 * tool call or reasoning block" is a fact about sibling order, not about CSS. Each entry names
 * what the element is and which recorded node it stands for; `tail` is the reused
 * `.context-bar-tail` element, wherever the surface happens to be holding it.
 */
const flowChildren = (scope: Element): { kind: string; nodeId?: string }[] => {
    const flow = scope.querySelector('.agent-flow');

    return Array.from(flow?.children ?? []).map((node) => {
        const element = node as HTMLElement;

        if (element.classList.contains('context-bar-tail'))
            return { kind: 'tail', ...(element.dataset.nodeId === undefined ? {} : { nodeId: element.dataset.nodeId }) };

        if (element.classList.contains('agent-text'))
            return { kind: 'prose', ...(element.dataset.contextNode === undefined ? {} : { nodeId: element.dataset.contextNode }) };

        return { kind: (element.className.split(/\s+/)[0] ?? 'unknown') };
    });
};

/** Where the reused tail element currently lives (R2): the strip's host, or the section's flow. */
const tailParent = (scope: Element): string | undefined => {
    const parent = scope.querySelector<HTMLElement>('.context-bar-tail')?.parentElement;

    if (parent === null || parent === undefined) return undefined;

    return parent.classList.contains('context-bar-host') ? 'host' : 'flow';
};

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
    it('prints ONE thinking body in the section flow, and mints no think chip', () => {
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

        // ONE body, and it is this section's own: the reused tail element, printed at the end of
        // the section's flow (R2) rather than as a chip under the strip.
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
            // T27 (R1b + review P2): this producer sent a 33-character `redacted` preview of a
            // 1,234-character round. The thinking box paints those 33 WHOLE — no render window
            // and no `…` of our own — and states the shortfall honestly, which is what keeps the
            // segment pointer where it is owed. A body the wire sent whole reports
            // `truncated: 'false'`, `shownChars === chars` and the plain length line: see
            // `paints the WHOLE long body in its scroll box…` below, and the designated-carrier
            // cases in view-context.test.ts / turns-tail-server.test.ts.
            truncated: 'true',
            shownChars: String(PREVIEW.length),
            renderBounded: 'true',
            follow: 'latest',
            caption: `thinking · showing ${PREVIEW.length} of 1,234 characters — click the segment for the exact text`,
            // The wire's own bytes, verbatim, from the first character of the preview.
            body: PREVIEW
        });
        // The block sits in the section's flow, not under the strip (T27, R2).
        expect(tailParent(tile())).toBe('flow');

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

    it('paints the WHOLE long body in its scroll box and follows the newest byte (R1b)', () => {
        // The requirement in one test, in the user's words: "Thought should no longer truncate
        // (i.e. showing x of y...), but display everything for user to see in a scrollable box."
        // The pane used to keep only the newest 320 characters of a streaming round behind a `…`;
        // now the full text is in the DOM and styles.css bounds the box (`--context-tail-height`
        // on `.context-bar-tail`, 12 text line boxes outer, leaves this scroll viewport the
        // remainder), with `data-follow='latest'` still aiming it at the newest byte — the T26
        // (R26) behaviour that survives the change.
        const first = `HEAD-${'x'.repeat(380)}`; // 385 characters, over the old 320 bound
        const more = `-TAIL-${'y'.repeat(200)}`; // 206 more
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', first.length) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', first, { chars: first.length }) }
        ]);

        const state = tailState(tile()) as Record<string, string | boolean>;

        // Every character the wire delivered, from the first `HEAD-` on, with no marker.
        expect(state.body).toBe(first);
        expect(String(state.body)).toContain('HEAD-');
        expect(String(state.body)).not.toContain('…');
        // `data-chars` is the whole recorded length and `data-shown-chars` now agrees with it.
        expect(state.chars).toBe('385');
        expect(state.shownChars).toBe('385');
        expect(state.renderBounded).toBe('false');
        expect(state.truncated).toBe('false');
        expect(state.follow).toBe('latest');
        expect(state.caption).toBe('thinking · 385 characters');
        expect(state.caption).not.toContain('showing');

        // The next delta: the SAME element, longer, and the scroll policy still aims it at the
        // newest byte — the "I can see it move" half of R26, now over the whole body.
        frame(board, view, 't1', [
            { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: '3', delta: more },
            { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-reasoning-3', patch: { chars: first.length + more.length } }
        ]);

        const grown = tailState(tile()) as Record<string, string | boolean>;

        expect(grown.body).toBe(`${first}${more}`);
        expect(grown.body).not.toBe(state.body);
        expect(grown.chars).toBe('591');
        expect(grown.shownChars).toBe('591');
        expect(grown.caption).toBe('thinking · 591 characters');

        // A short body reads the same way it always did: whole, with no marker and no hedge.
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-9', 15) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('9', 'a short thought') }
        ]);

        const short = tailState(tile()) as Record<string, string | boolean>;

        expect(short.body).toBe('a short thought');
        expect(short.shownChars).toBe('15');
        expect(short.renderBounded).toBe('false');
        expect(short.caption).toBe('thinking · 15 characters');
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

    it('keeps the answer printed ABOVE a later thinking window (R2)', () => {
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

        // A new round of thinking is the newest BLOCK now, and it owns the tail body — but the
        // response that came before it is the newest RESPONSE, so R2 keeps it printed and puts
        // the thinking block underneath it. (R23's "the tail hides every older block" survives
        // for blocks older than this reply; only the newest reply stays in the flow.)
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-8', 11) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('8', 'still going') }
        ]);

        expect(proseState(tile())).toEqual([{ nodeId: '5', hidden: false }]);
        expect(tailState(tile())).toMatchObject({ hidden: false, nodeId: '8', body: 'still going' });
        // Document order IS visual order: the reply first, then the block that followed it.
        expect(flowChildren(tile())).toEqual([
            { kind: 'prose', nodeId: '5' },
            { kind: 'tail', nodeId: '8' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// T27 (R2): the newest assistant response stays ABOVE the tool/thinking block
// ---------------------------------------------------------------------------

describe('the newest response, printed above the one tail block', () => {
    // The call body needs a DESIGNATION to print at all (a legacy producer never sent the
    // payload), and the designation is what R23 made the tail. These two fixtures are the
    // smallest honest pair for that: a segment figure and the carrier that names the bytes.
    const args = '{"path":"notes.md"}';
    const result = 'the recorded result';

    const callBlock = (): ContextBlock =>
        block({ id: '0-tool-7', chars: args.length + result.length, argsChars: args.length, resultChars: result.length });

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

    /** A committed intermediate response: the shape R2 is about, not the final answer. */
    const respond = (id: string, text: string): never[] =>
        [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: answerBlock(`0-assistant-${id}`, text.length) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: answerNode(id, text) },
            { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: id, patch: { committed: true } },
            { op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { answerNodeId: id } }
        ] as never[];

    it('prints a response above the call body the designation put in the same flow', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', respond('1', 'first reply'));

        expect(flowChildren(tile())).toEqual([{ kind: 'prose', nodeId: '1' }]);

        // The call takes the tail. Its body prints WHOLE, below the reply that came before it,
        // and the reply is still the newest RESPONSE so it stays visible (R2).
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: callBlock() },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: stepNode('7') },
            { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail() }
        ]);

        expect(proseState(tile())).toEqual([{ nodeId: '1', hidden: false }]);
        expect(tailState(tile())).toMatchObject({ hidden: false, kind: 'tool', nodeId: '7', body: `arguments${args}result${result}` });
        expect(flowChildren(tile())).toEqual([
            { kind: 'prose', nodeId: '1' },
            { kind: 'tail', nodeId: '7' }
        ]);
        // One reused element, in the flow, and the strip's host kept its own place.
        expect(tailParent(tile())).toBe('flow');
        expect(tile().querySelectorAll('.context-bar-host')).toHaveLength(1);
        expect(tile().querySelectorAll('.context-bar-tail')).toHaveLength(1);
    });

    it('moves the block below a later response even when its own content did not change', () => {
        // The regression this exists for: `paintTail` early-returns when the printed block is
        // unchanged, so a reposition wired to the CONTENT pass would leave the call body stuck
        // ABOVE the reply that follows it. `applyEntryContent` re-asserts the position on every
        // pass precisely because the content pass may do nothing.
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', respond('1', 'first reply'));
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: callBlock() },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: stepNode('7') },
            { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail() }
        ]);

        const before = tails(tile())[0] as HTMLElement;
        expect(before.parentElement?.className).toContain('agent-flow');

        // A newer response lands while the designation still names the call (the projector
        // re-designates on its own frame; the tile must not depend on that ordering).
        frame(board, view, 't1', respond('9', 'second'));

        // The older reply withdraws, the newest one prints, and the SAME tail element — same
        // `tailKey`, same bytes — has moved below it.
        expect(proseState(tile())).toEqual([
            { nodeId: '1', hidden: true, superseded: 'true' },
            { nodeId: '9', hidden: false }
        ]);
        expect(tailState(tile())).toMatchObject({ hidden: false, kind: 'tool', nodeId: '7' });
        expect(flowChildren(tile())).toEqual([
            { kind: 'prose', nodeId: '1' },
            { kind: 'prose', nodeId: '9' },
            { kind: 'tail', nodeId: '7' }
        ]);
        expect(tails(tile())[0]).toBe(before);
        expect(tails(tile())).toHaveLength(1);
    });

    it('seats the block above the pending status line, and leaves it untouched on a pending refresh (P3)', async () => {
        // `renderPending` re-appends `.agent-pending` as the flow's LAST child on every snapshot
        // (turns.ts:4856-4865), so a "tail is the last child" rule would win the slot back from
        // the status line every frame — and because a status-only frame does not change the
        // printed block, `paintTail` early-returns on the same `tailKey` and `followLatest` never
        // runs again, so that detach/re-append is what throws the reader back to the top of a
        // result they were reading mid-call. The tail's seat is therefore immediately BEFORE the
        // pending line, and the position guard recognises that seat.
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', respond('1', 'first reply'));
        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: callBlock() },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: stepNode('7') },
            { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail() }
        ]);

        frame(board, view, 't1', [
            {
                op: 'pending:set',
                turnId: 't1',
                sectionId: 't1:0',
                pending: [{ callId: 'call-1', name: 'read', elapsedMs: 1_200 }]
            }
        ]);

        const flow = tile().querySelector<HTMLElement>('.agent-flow') as HTMLElement;
        const tailEl = tails(tile())[0] as HTMLElement;
        const status = tile().querySelector<HTMLElement>('.agent-pending');

        expect(status).not.toBe(null);
        expect(flowChildren(tile())).toEqual([
            { kind: 'prose', nodeId: '1' },
            { kind: 'tail', nodeId: '7' },
            { kind: 'agent-pending' }
        ]);
        // The status line ends the flow, with the ONE tail block immediately before it.
        expect(status!.previousElementSibling).toBe(tailEl);
        expect(tailEl.parentElement).toBe(flow);

        // A second snapshot, same printed bytes. The status line legitimately moves; the tail
        // must not be detached or re-inserted at all, which is the scroll-preserving half of the
        // requirement (`followLatest` will not run again on this frame).
        const records: MutationRecord[] = [];
        const observer = new MutationObserver((list) => records.push(...list));

        observer.observe(flow, { childList: true });

        frame(board, view, 't1', [
            {
                op: 'pending:set',
                turnId: 't1',
                sectionId: 't1:0',
                pending: [{ callId: 'call-1', name: 'read', elapsedMs: 1_500 }]
            }
        ]);

        await settled();
        observer.disconnect();

        expect(records.some((record) => Array.from(record.addedNodes).includes(tailEl))).toBe(false);
        expect(records.some((record) => Array.from(record.removedNodes).includes(tailEl))).toBe(false);
        expect(tails(tile())).toHaveLength(1);
        expect(tails(tile())[0]).toBe(tailEl);
        expect(tile().querySelector<HTMLElement>('.agent-pending')?.previousElementSibling).toBe(tailEl);
        // The frame really did arrive, so the two `false`s above are not an empty test.
        expect(tile().querySelector('.agent-pending')?.textContent).toBe('pending · read 1.5s');
    });

    it('keeps that order through a thinking tail, a drain frame and a cold reload', () => {
        // 1. cold hydration: the same document, painted once, ends in the same order.
        const cold = documentOf([summary()], {
            t1: [
                rootSection({
                    answerNodeId: '1',
                    context: [promptBlock, answerBlock('0-assistant-1', 11), thinkBlock('0-reasoning-4', 11)],
                    nodes: [answerNode('1', 'first reply', true), thinkNode('4', 'still going')],
                    tail: { kind: 'reasoning', nodeId: '4', blockId: '0-reasoning-4', chars: 11, truncated: false } as never
                })
            ]
        });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), cold);
        handle.renderDisplay(displayOf(cold));

        expect(proseState(tile())).toEqual([{ nodeId: '1', hidden: false }]);
        expect(tailState(tile())).toMatchObject({ hidden: false, kind: 'reasoning', nodeId: '4', body: 'still going' });
        expect(flowChildren(tile())).toEqual([
            { kind: 'prose', nodeId: '1' },
            { kind: 'tail', nodeId: '4' }
        ]);

        // 2. a whole-tree reconcile (`syncDisplay`) and a rebuild (`renderDisplay`) re-assert it.
        handle.syncDisplay(displayOf(cold));
        expect(flowChildren(tile())).toEqual([
            { kind: 'prose', nodeId: '1' },
            { kind: 'tail', nodeId: '4' }
        ]);
        expect(tails(tile())).toHaveLength(1);

        handle.renderDisplay(displayOf(cold));
        expect(flowChildren(tile())).toEqual([
            { kind: 'prose', nodeId: '1' },
            { kind: 'tail', nodeId: '4' }
        ]);
        expect(tails(tile())).toHaveLength(1);
    });

    it('keeps the order inside a delegated card, not only in the tile', () => {
        const view = documentOf([summary({ sectionCount: 2 })], {
            t1: [
                rootSection({ context: [promptBlock, thinkBlock('0-reasoning-3', 13)], nodes: [thinkNode('3', 'caller thought')] }),
                childSection({
                    answerNodeId: '2',
                    context: [thinkBlock('1-reasoning-4', 12, 't1:1'), answerBlock('1-assistant-2', 12, 't1:1')],
                    nodes: [answerNode('2', 'child reply', true), thinkNode('4', 'child thinking')],
                    tail: { kind: 'reasoning', nodeId: '4', blockId: '1-reasoning-4', chars: 12, truncated: false }
                })
            ]
        });
        const { board, tile, row } = mount();
        board.upsertView(summary({ sectionCount: 2 }), view).renderDisplay(displayOf(view));

        const card = row() as HTMLElement;

        // The delegated section's reply sits in ITS OWN flow, above its own tail block, and the
        // caller's strip/flow keeps its own pair: no section borrows another's tail.
        expect(proseState(card)).toEqual([{ nodeId: '2', hidden: false }]);
        expect(tailState(card)).toMatchObject({ hidden: false, kind: 'reasoning', nodeId: '4', body: 'child thinking' });
        expect(flowChildren(card)).toEqual([
            { kind: 'prose', nodeId: '2' },
            { kind: 'tail', nodeId: '4' }
        ]);
        expect(tailParent(card)).toBe('flow');
        expect(tails(card)).toHaveLength(1);
        expect(flowChildren(tile())).toEqual([{ kind: 'tail', nodeId: '3' }]);
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
            // A recorded CALL is windowed by nothing: the panes print the bytes whole, so the
            // painted length equals the recorded one (T25 kept that, T26 only follows the end).
            shownChars: String(args.length + result.length),
            renderBounded: 'false',
            follow: 'latest',
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
        expect(tailState(tile())?.caption).toBe(
            // R27: an unsettled call has no span, and the caption says so out loud.
            `read · running · time not recorded · ${args.length} characters · args ${args.length} · no result recorded yet`
        );

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

// ---------------------------------------------------------------------------
// R5 — the streaming preview box never moves the reader's scroll against their will.
// ---------------------------------------------------------------------------
//
// The user report these tests pin: "the thinking block constantly dragged the scrolling bar to
// the bottom of the page, which prevented reading the thought as it output". The thinking body
// is the WHOLE thought inside a clipped box (T27 R1b, styles.css `.context-bar-tail-body` =
// `overflow: auto`), and every frame of the round wrote `scrollTop = scrollHeight`
// (`followLatest`), so a reader who scrolled up inside that box to read the thought as it
// streamed was yanked back to its end within one frame — and with the box pinned at its end,
// scroll chaining handed their wheel to the page.
//
// jsdom has no layout, so these tests GIVE the box fake layout. Two properties make the fake
// honest rather than convenient:
//   - the height DERIVES from the element's own text, so the box grows at the moment the code
//     under test writes the bytes — exactly when a browser's layout grows. A pre-arranged
//     height would instead claim the box was already tall before the paint, which is a state no
//     real frame ever passes through, and it would test the wrong pre-paint reading;
//   - a scroll write is CLAMPED to `scrollHeight - clientHeight`, as a browser clamps it, so
//     "at the live edge" and "followed to the bottom" are measured figures here;
//   - metrics only exist for an element that is IN the document, and a move throws the scroll
//     position away — both are what CSSOM View does and what the fakes below model, because
//     jsdom does neither. Without the connection rule a pane minted DETACHED (the args/result
//     panes) would report a scroll box it cannot have in a browser, which is exactly how the
//     pre-fix aim hid behind these tests.
// The `data-follow` attribute is asserted beside every figure: it is the half of the policy a
// host with no layout at all can still report (./turns.ts `followLatest` docs).

describe('the streaming preview box follows only at the live edge (R5)', () => {
    // A box whose height grows with its bytes: 8px per character inside a fixed viewport.
    const PX_PER_CHAR = 8;

    /**
     * Fake layout on ONE box (a stable element, e.g. a thinking body). `top()` reads back what
     * the code under test actually left there — clamped the way a browser clamps it — and takes
     * an argument when the test wants to BE the reader scrolling.
     */
    const fakeLayout = (
        box: HTMLElement,
        view: number
    ): { top: (next?: number) => number; zero: () => void } => {
        let top = 0;

        const heightOf = (): number => view + (box.textContent ?? '').length * PX_PER_CHAR;

        Object.defineProperty(box, 'scrollHeight', {
            configurable: true,
            get: () => (box.isConnected ? heightOf() : 0)
        });
        Object.defineProperty(box, 'clientHeight', {
            configurable: true,
            get: () => (box.isConnected ? view : 0)
        });
        Object.defineProperty(box, 'scrollTop', {
            configurable: true,
            // A detached element has no scroll box: the read is 0 and the write is a no-op
            // (CSSOM View; ../extensions/records-dom.ts:367-371 states it for this repo). Without
            // this the fake gives metrics to an element the browser would not, which is exactly
            // how the D1 detached-aim defect hid behind these tests.
            get: () => (box.isConnected ? top : 0),
            set: (next: number) => {
                if (!box.isConnected) return;

                top = Math.max(0, Math.min(next, heightOf() - view));
            }
        });

        return {
            top: (next?: number) => {
                if (next !== undefined) box.scrollTop = next;

                return top;
            },
            // A browser throws a scroll position away when the element is removed and put back
            // (the moved subtree has no layout in between); jsdom keeps it. A test that wants the
            // honest pre-state of a MOVE calls this where the re-insertion happens.
            zero: (): void => {
                top = 0;
            }
        };
    };

    /**
     * Model the browser's scroll reset on a MOVE: every mutation of `parent` that (re-)inserts a
     * subtree containing `box` throws that subtree's scroll position away. Returns the restore —
     * these are instance patches, and a leaked one outlives the assertion.
     */
    const fakeScrollResetOnMove = (
        parent: HTMLElement,
        box: HTMLElement,
        zero: () => void
    ): (() => void) => {
        const names = ['insertBefore', 'appendChild', 'append', 'prepend', 'replaceChildren'] as const;
        const held = new Map<string, (...args: unknown[]) => unknown>();

        for (const name of names) {
            const original = (parent as unknown as Record<string, (...args: unknown[]) => unknown>)[name];

            held.set(name, original);

            (parent as unknown as Record<string, (...args: unknown[]) => unknown>)[name] = (
                ...args: unknown[]
            ): unknown => {
                const moved = args.find((arg) => arg instanceof Node && (arg === box || arg.contains(box)));

                // BEFORE the insertion: the reset is the first thing a frame does to a moved
                // subtree, and the code under test is expected to re-aim after it.
                if (moved !== undefined) zero();

                return original.apply(parent, args);
            };
        }

        return () => {
            for (const [name, original] of held) {
                (parent as unknown as Record<string, (...args: unknown[]) => unknown>)[name] = original;
            }
        };
    };

    /**
     * Fake layout on EVERY element. The tool-call tail needs this: `paintTail` MINTS the
     * args/result panes again on every content pass (`replaceChildren(createTailPane(...))`), so
     * a stub attached to one pane would be thrown away with the element it described. The payload
     * of a recorded call is written once per event, so a fixed height states the truth here.
     *
     * `isConnected` decides everything, exactly as it does in a browser (D1's whole point): a
     * pane that has not been put in the document yet reports no metrics and takes no write, so a
     * test can only pass when the code aims at a box that EXISTS. Returns the restore: a
     * prototype patch outlives an assertion.
     */
    const fakeDocumentLayout = (metrics: { height: number; view: number }): (() => void) => {
        const held = {
            scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop'),
            scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
            clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')
        };
        const tops = new WeakMap<Element, number>();

        Object.defineProperty(Element.prototype, 'scrollHeight', {
            configurable: true,
            get(this: Element) {
                return this.isConnected ? metrics.height : 0;
            }
        });
        Object.defineProperty(Element.prototype, 'clientHeight', {
            configurable: true,
            get(this: Element) {
                return this.isConnected ? metrics.view : 0;
            }
        });
        Object.defineProperty(Element.prototype, 'scrollTop', {
            configurable: true,
            get(this: Element) {
                return this.isConnected ? tops.get(this) ?? 0 : 0;
            },
            set(this: Element, next: number) {
                if (!this.isConnected) return;

                tops.set(this, Math.max(0, Math.min(next, metrics.height - metrics.view)));
            }
        });

        return () => {
            const proto = Element.prototype as unknown as Record<string, PropertyDescriptor | undefined>;

            for (const [name, descriptor] of Object.entries(held)) {
                if (descriptor === undefined) delete proto[name];
                else Object.defineProperty(Element.prototype, name, descriptor);
            }
        };
    };

    // One streaming thinking round, in the frame order the projector really sends: a designated
    // block, its first bytes, then an appended delta with the segment's new exact count.
    const streaming = (): {
        box: HTMLElement;
        layout: { top: (next?: number) => number; zero: () => void };
        tile: () => HTMLElement;
        grow: (delta: string, chars: number) => void;
        clear: () => void;
    } => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();

        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 13) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', 'first thought') }
        ]);

        // `?? null` on purpose: the optional chain can also give `undefined` (no tail mounted),
        // and `=== undefined` would not narrow the `HTMLElement | null` that `querySelector`
        // returns, which is how this line failed a strict typecheck of the test block (D5).
        const box = tails(tile())[0]?.querySelector<HTMLElement>('.context-bar-tail-body') ?? null;

        if (box === null) throw new Error('the thinking body was never printed');

        // 400px of visible thought: enough scroll range that "at the edge" and "scrolled up"
        // are far apart, and one appended sentence is a third of the box.
        const layout = fakeLayout(box, 400);

        return {
            box,
            layout,
            tile,
            grow: (delta: string, chars: number): void => {
                frame(board, view, 't1', [
                    { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: '3', delta },
                    { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-reasoning-3', patch: { chars } }
                ]);
            },
            // The block leaves the section: its node is withdrawn, so nothing is eligible to
            // print and the tile has to blank the box. (`tail:clear` alone does NOT blank it —
            // ../frontend/view-context.ts:975 falls back to `legacyTailOf` whenever the
            // designation is absent, so a cleared designation re-derives the same block from
            // `section.nodes`. Reported as a finding; not this task's scope to change.)
            clear: (): void => {
                frame(board, view, 't1', [{ op: 'node:remove', turnId: 't1', sectionId: 't1:0', nodeId: '3' }]);
            }
        };
    };

    it('follows the newest byte while the reader is at the live edge (R5.1)', () => {
        const { box, layout, tile, grow } = streaming();

        // Where a first paint leaves the reader: the bottom of 13 characters (13 * 8 = 104).
        layout.top(104);

        grow(' and more thought', 30);

        // Followed to the new bottom (30 * 8 = 240), so the bytes that just arrived are ON
        // SCREEN — the "static text" half of the complaint stays fixed.
        expect(layout.top()).toBe(240);
        expect(box.textContent).toBe('first thought and more thought');
        expect(box.dataset.follow).toBe('latest');
        expect(tailState(tile())?.body).toBe('first thought and more thought');

        // And still followed for the next frame of the same round (52 * 8 = 416).
        grow(' and even more thought', 52);

        expect(layout.top()).toBe(416);
        expect(box.textContent).toBe('first thought and more thought and even more thought');
        expect(box.dataset.follow).toBe('latest');
    });

    it('leaves a scrolled-up reader exactly where they are while the bytes keep arriving (R5.2)', () => {
        const { box, layout, tile, grow } = streaming();

        // The reader drags the box up to re-read the opening of the thought.
        layout.top(20);

        grow(' and more thought', 30);

        // Their offset is exactly where they left it — the box was never re-aimed — while the
        // growth still appended at the END of the body, below what they are looking at. The
        // thinking body prints the whole text (T27 R1b), so nothing they can see is rewritten or
        // evicted under them while they are away from the edge.
        expect(layout.top()).toBe(20);
        expect(box.textContent).toBe('first thought and more thought');
        expect(tailState(tile())?.body).toBe('first thought and more thought');
        // The stated policy matches what happened: paused, not silently 'latest'.
        expect(box.dataset.follow).toBe('paused');

        // It holds for every later frame of the same block, however far the body grows.
        grow(' and even more thought', 52);

        expect(layout.top()).toBe(20);
        expect(box.textContent).toBe('first thought and more thought and even more thought');
        expect(box.dataset.follow).toBe('paused');
    });

    it('resumes following on the next frame once the reader scrolls back to the bottom (R5.3)', () => {
        const { box, layout, grow } = streaming();

        layout.top(20);
        grow(' and more thought', 30);

        expect(layout.top()).toBe(20);
        expect(box.dataset.follow).toBe('paused');

        // The reader drags back to the live edge. A real `scroll` event is what a user drag
        // fires, and it is the only thing that ever changes the policy — no button, no reload.
        // (The write clamps to the bottom of the 30 characters now on screen: 240.)
        layout.top(1_000);
        box.dispatchEvent(new Event('scroll'));

        expect(layout.top()).toBe(240);
        expect(box.dataset.follow).toBe('latest');

        grow(' and even more thought', 52);

        expect(layout.top()).toBe(416);
        expect(box.dataset.follow).toBe('latest');
    });

    it('re-aims the box after a frame that only MOVES the block (D2)', () => {
        // The one frame that paints NOTHING: the printed block is unchanged (`paintTail`
        // early-returns on the same `tailKey`), yet `placeTail` moves the block because a newer
        // response took the prose seat above it (see the move test above). Re-insertion resets
        // `scrollTop` to 0 in a browser, so without a re-assert the reader spends that frame at
        // the top of the bytes they were reading. The fake MODELS that reset, because jsdom does
        // not (see `fakeScrollResetOnMove`).
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();

        board.upsertView(summary(), view).renderDisplay(displayOf(view));

        frame(board, view, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: thinkBlock('0-reasoning-3', 13) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: thinkNode('3', 'first thought') },
            // The designation is EXPLICIT: without it the legacy fallback would hand the tail to
            // the newer answer below and the body would disappear — a CONTENT change, not the
            // pure move this test is about.
            {
                op: 'tail:set',
                turnId: 't1',
                sectionId: 't1:0',
                tail: { kind: 'reasoning', nodeId: '3', blockId: '0-reasoning-3', chars: 13, truncated: false } as never
            }
        ]);

        const box = tails(tile())[0]?.querySelector<HTMLElement>('.context-bar-tail-body') ?? null;

        if (box === null) throw new Error('the thinking body was never printed');

        const flow = tile().querySelector<HTMLElement>('.agent-flow') ?? null;

        if (flow === null) throw new Error('the section flow was never mounted');

        const layout = fakeLayout(box, 400);
        const restoreMove = fakeScrollResetOnMove(flow, box, layout.zero);

        // The response frames used for the move: a newer answer is recorded and the projector has
        // NOT re-designated the tail (no `tail:set`), so the block prints the same bytes and only
        // its seat moves.
        const reply = (id: string, text: string): void => {
            frame(board, view, 't1', [
                { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: answerBlock(`0-assistant-${id}`, text.length) },
                { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: answerNode(id, text) },
                { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: id, patch: { committed: true } },
                { op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { answerNodeId: id } }
            ]);
        };

        try {
            // Where a pinned first paint leaves the reader: the bottom of the 13 recorded
            // characters (13 * 8 = 104). The fake went on after that paint, exactly as in the
            // R5.1 test, so the starting offset is stated rather than measured.
            layout.top(104);

            // The reader scrolls up and keeps reading — a real scroll event, which is also what
            // records the offset the re-assert has to restore.
            layout.top(20);
            box.dispatchEvent(new Event('scroll'));

            expect(layout.top()).toBe(20);
            expect(box.dataset.follow).toBe('paused');

            reply('9', 'second');

            // The block moved below the new response (the seat proves it), the move threw the
            // offset away, and the policy put the reader BACK on the byte they held. NOT the
            // bottom: they are away from the edge, so nothing may drag them there.
            expect(flowChildren(tile())).toEqual([
                { kind: 'prose', nodeId: '9' },
                { kind: 'tail', nodeId: '3' }
            ]);
            expect(layout.top()).toBe(20);
            expect(box.dataset.follow).toBe('paused');
            // The bytes themselves are untouched by the move.
            expect(box.textContent).toBe('first thought');

            // The same reader back at the live edge: the next move lands on the newest byte,
            // which is the follower's half of the same re-assert.
            layout.top(1_000);
            box.dispatchEvent(new Event('scroll'));

            expect(box.dataset.follow).toBe('latest');

            reply('11', 'third');

            expect(layout.top()).toBe(104);   // 400 + 13 * 8, clamped to the bottom
            expect(box.dataset.follow).toBe('latest');
        } finally {
            restoreMove();
        }
    });

    it('leaves NO follow state on a cleared seat', () => {
        // The other half of the attribute contract (./turns.ts `clearTail`): a body that prints
        // nothing describes NOTHING, the policy included. Leaving `data-follow` behind would make
        // a cold-rendered section and a live-cleared one report different state for the same "no
        // body" answer, and a stale 'paused' would claim a reader is holding a box that is empty.
        const { box, layout, tile, grow, clear } = streaming();

        layout.top(20);
        grow(' and more thought', 30);

        // Paused FIRST, so this proves the policy is withdrawn rather than merely never written.
        expect(box.dataset.follow).toBe('paused');

        clear();

        expect(box.textContent).toBe('');
        // The element is reused, not recreated, so this is a real leftover check on the very node
        // that carried the policy.
        expect(box.dataset.follow).toBeUndefined();
        expect(
            Array.from(box.querySelectorAll('[data-follow]')).map((node) => node.getAttribute('data-follow'))
        ).toEqual([]);
        // And the aggregate the suite reads agrees with it: `tailState().follow` is undefined, not
        // a stale 'latest'/'paused'.
        expect(tailState(tile())).toMatchObject({ hidden: true, follow: undefined, body: '' });
    });

    it('carries a scrolled-up reader across the result pane being minted again, and still follows at the edge', () => {
        // The current call is the same mechanism in its harder shape: the pane the reader
        // scrolled inside does NOT survive the frame, so the policy is keyed per pane and the
        // offset is carried onto the replacement element.
        const args = '{"path":"notes.md","query":"what changed"}';
        const result = 'the whole recorded file body, every line of it';

        const callBlock = (overrides: Record<string, unknown> = {}): ContextBlock =>
            block({
                chars: args.length + result.length,
                argsChars: args.length,
                resultChars: result.length,
                ...overrides,
                id: '0-tool-7'
            });

        // Typed as the exact node type it builds (D5): a bare `TurnSection['nodes'][number]`
        // annotation erases the union into `DisplayNode`, and the `step:set` op below takes a
        // `DisplayStep`, so the union had to be narrowed by hand. `satisfies` checks the fixture
        // against the real shape and keeps the narrow type, so a wrong field fails here instead
        // of at the call site.
        const callStep = (overrides: Partial<DisplayStep> = {}): DisplayStep =>
            ({
                kind: 'tool',
                id: '7',
                turnId: 't1',
                sectionId: 't1:0',
                callId: 'call-1',
                name: 'read',
                argsPreview: `${args.slice(0, 20)}…`,
                state: 'running',
                startedAt: T,
                detail: { stepId: '7', hasResult: false, truncated: false },
                ...overrides
            }) satisfies DisplayStep;

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

        // 200px of a 900px payload: the edge is at 700.
        const restore = fakeDocumentLayout({ height: 900, view: 200 });

        try {
            const view = documentOf([summary()], { t1: [rootSection()] });
            const { board, tile } = mount();

            board.upsertView(summary(), view).renderDisplay(displayOf(view));

            frame(board, view, 't1', [
                { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: callBlock({ state: 'running', chars: args.length, argsChars: args.length, resultChars: undefined, endedAt: undefined }) },
                { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: callStep() },
                { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail({ result: undefined, chars: args.length }) }
            ]);

            const argsPane = (): HTMLElement | null =>
                tile().querySelector<HTMLElement>('.context-bar-tail-pane-body[data-field="args"]');

            const first = argsPane();

            if (first === null) throw new Error('the arguments pane was never printed');

            // A pane nobody has scrolled follows: the bottom of the recorded request.
            expect(first.scrollTop).toBe(700);
            expect(first.dataset.follow).toBe('latest');
            expect(first.textContent).toBe(args);

            // The reader scrolls up inside the request and keeps reading it.
            first.scrollTop = 240;
            first.dispatchEvent(new Event('scroll'));

            expect(first.dataset.follow).toBe('paused');

            // The call SETTLES: the result bytes arrive and both panes are minted again.
            frame(board, view, 't1', [
                { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { state: 'ok', chars: args.length + result.length, resultChars: result.length, endedAt: T + 800, durationMs: 800, eventTo: 9 } },
                { op: 'step:set', turnId: 't1', sectionId: 't1:0', step: callStep({ state: 'ok', outcome: 'completed', endedAt: T + 800, durationMs: 800, detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: true } }) },
                { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail() }
            ]);

            const second = argsPane();

            if (second === null) throw new Error('the arguments pane vanished on the settle frame');

            // The element really was replaced — and the reader still holds the byte of the SAME
            // recorded request they were reading, with the payload itself intact.
            expect(second).not.toBe(first);
            expect(second.textContent).toBe(args);
            expect(second.scrollTop).toBe(240);
            expect(second.dataset.follow).toBe('paused');

            // The same reader now drags that pane to the bottom: following resumes, and the next
            // rebuilt pane is aimed at the newest byte again — the gate is per reader position,
            // never a blanket freeze.
            second.scrollTop = 900;
            second.dispatchEvent(new Event('scroll'));

            expect(second.dataset.follow).toBe('latest');

            frame(board, view, 't1', [
                { op: 'tail:set', turnId: 't1', sectionId: 't1:0', tail: callTail({ result: `${result}, plus a longer ending` }) }
            ]);

            const third = argsPane();

            if (third === null) throw new Error('the arguments pane vanished on the follow-up frame');

            expect(third.scrollTop).toBe(700);   // clamped to the bottom, exactly as before R5
            expect(third.dataset.follow).toBe('latest');
        } finally {
            restore();
        }
    });
});
