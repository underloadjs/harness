// T23 (R23): the WHOLE tail chain — the real server projector, the real browser reducer,
// and the real turn tile — in one file, so "the server compiled the current block and the
// board printed it" is a checked end-to-end claim rather than three unit tests that happen
// to agree.
//
// Nothing here hand-writes a `tail` descriptor or a display node: every frame is what
// `createTurnProjector().apply()` actually emits for an actually recorded `HarnessEvent`,
// applied by `applyOpsToDisplay` exactly as the shell applies it (document first, then the
// tile), and asserted from the DOM the tile builds. The last test folds the SAME record
// through `projectTurn()` — the cold path a reload and a restart take — and requires the
// identical rendered result.
//
// The rules pinned here, in order:
//   1. a thinking window streams IN FULL on the wire while it is the newest block, however far
//      past `DISPLAY_NODE_PREVIEW_CHARS` it runs (the requirement the old server-side 320 bound
//      left unmet), and the PANE paints its LATEST `CONTEXT_TAIL_PREVIEW_CHARS` characters, so
//      the reader watches the newest text move instead of a static opening line (T26, R26);
//      the caption states the exact recorded length beside how much of it is on screen;
//   2. the call that follows becomes the tail: its complete recorded arguments print, the
//      thinking window is withdrawn, and the bytes are the ones the step's own bounded
//      `argsPreview` cannot hold;
//   3. when the call settles, its complete recorded response joins that same body;
//   4. the next thinking window takes the tail back and the call's payload is GONE from the
//      rendered document — one full block per section, not one per round;
//   5. the final answer replaces the body at the tail, in the existing answer surface;
//   6. none of this costs a request: the lazy step and block routes stay untouched, while a
//      hidden historical window stays exactly one click away;
//   7. a cold document of the same record paints the same single body.
//   8. T25: a payload BIGGER than any display bound is printed whole, live and on a reload —
//      the tail quotes the record byte for byte, and the display contract caps nothing of
//      its own (`tool_call.arguments` has no runtime cap at all).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-tail-server.test.ts

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { HarnessEvent } from '../../harness';
import { DISPLAY_ARGS_PREVIEW_CHARS, DISPLAY_NODE_PREVIEW_CHARS, DISPLAY_PREVIEW_CHARS } from '../../shared/turn-display';
import type { TurnDisplayOp } from '../../shared/turn-display';
import type { SessionTurn, SessionView } from '../../server/protocol';
import { createTurnProjector, projectTurn } from '../../server/turn-projector';
import type { HarnessPendingTool } from '../../types';
import { createTurnBoard } from './turns';
import type { TurnBoard } from './turns';
import { applyOpsToDisplay } from '../view-state';
import { clearBlockDetailCache } from './context-detail';

const T = 1_700_000_000_000;
const AGENT = 'instruct';

// One recorded event per 10 ms, so every duration below is an exact number.
const timeOf = (index: number): number => T + index * 10;

// A recorded argument list far longer than the step's own `argsPreview`, with the marker in
// the MIDDLE: a head-truncated preview can never contain it, so "the tail printed the real
// payload" is a real assertion and not an artifact of a short call fitting anyway.
const CALL_ARGS = `{"path":"notes.md","query":"${'filler-'.repeat(40)}ARGS-MIDDLE-4c1d${'-tail'.repeat(40)}"}`;
const CALL_RESULT = `${'body-'.repeat(60)}RESULT-MIDDLE-9f3c${'-end'.repeat(60)}`;

const events = (): HarnessEvent[] => [
    { type: 'start', agent: AGENT, model: 'scripted/test' },
    { type: 'reasoning', agent: AGENT, delta: 'a'.repeat(DISPLAY_NODE_PREVIEW_CHARS + 90) },
    { type: 'reasoning', agent: AGENT, delta: 'b'.repeat(120) },
    { type: 'tool_call', agent: AGENT, call: { id: 'call-1', name: 'read', arguments: CALL_ARGS } },
    {
        type: 'tool_result',
        agent: AGENT,
        name: 'read',
        callId: 'call-1',
        content: CALL_RESULT,
        isError: false,
        outcome: 'completed',
        durationMs: 1_300
    },
    { type: 'reasoning', agent: AGENT, delta: 'second round of thinking' },
    { type: 'text', agent: AGENT, delta: 'the final answer, in full' },
    { type: 'attempt_commit', agent: AGENT, attempt: 2, maxAttempts: 3 } as HarnessEvent
];

const recordOf = (turnEvents: HarnessEvent[], overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'read the notes and tell me what changed',
    status: 'running',
    startedAt: T,
    updatedAt: T,
    ...overrides,
    // The two parallel arrays are always THIS turn's own record. An override moves the row's
    // status and stamps (that is what the settled cold fold needs), never its events.
    events: [...turnEvents],
    eventTimes: turnEvents.map((_event, index) => timeOf(index))
});

// The store's own display context: one recorded instruction source, so the `system` segment
// exists and the "system is never the tail" rule is exercised against a real segment.
const CONTEXT = {
    primary: AGENT,
    instructionSourcesOf: () => [{ agent: AGENT, instructions: ['Read the notes, then answer.'] }]
};

const pending = new Map<string, HarnessPendingTool[]>();

const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): {
    board: TurnBoard;
    view: SessionView;
    tile: () => HTMLElement;
} => {
    const empty = document.createElement('div');
    const board = createTurnBoard({ ...options, empty });

    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    const view = {
        id: 's1',
        harness: AGENT,
        status: 'running',
        model: 'scripted/test',
        createdAt: T,
        updatedAt: T,
        turns: [],
        // An EMPTY tree: the ops frames below build it, exactly as a live run does. A cold
        // document is the other path, and the last test proves both end in the same DOM.
        displays: { t1: { turnId: 't1', sections: [] } }
    } as unknown as SessionView;

    return {
        board,
        view,
        tile: () => document.querySelector<HTMLElement>('.tile') as HTMLElement
    };
};

/**
 * One frame, applied in the order the shell applies it: document, then tile.
 *
 * The SAME array goes to both consumers, exactly as `view-api.ts` hands one parsed frame to
 * `applyOpsToDisplay` and then to `TurnBoard.applyViewOps`. Nothing clones it here on purpose:
 * the tile must read a `node:insert` payload the document reducer has not rewritten, which is
 * what `view-state.ts` `insertNode` guarantees by taking its own copy. A clone in this helper
 * would hide that contract.
 */
const frame = (board: TurnBoard, view: SessionView, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(view, 't1', ops, pending);

    return board.applyViewOps('t1', ops, view);
};

const tails = (scope: Element): HTMLElement[] => Array.from(scope.querySelectorAll<HTMLElement>('.context-bar-tail'));

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
        // T26 (R26): the WIRE's state (`truncated`, from the server designation) and the
        // PANE's state (`shownChars` / `renderBounded`) are different facts, and this file
        // proves the live path keeps them different: the wire carries the whole streamed
        // window, while the pane paints its latest `CONTEXT_TAIL_PREVIEW_CHARS`.
        shownChars: tail.dataset.shownChars,
        renderBounded: tail.dataset.renderBounded,
        state: tail.dataset.state,
        duration: tail.dataset.duration,
        follow:
            tail.querySelector<HTMLElement>('.context-bar-tail-body')?.dataset.follow ??
            tail.querySelector('pre[data-field]')?.getAttribute('data-follow') ??
            undefined,
        caption: tail.querySelector('.context-bar-tail-caption')?.textContent,
        body: tail.querySelector('.context-bar-tail-body')?.textContent
    };
};

const pane = (scope: Element, which: string): string | undefined =>
    scope.querySelector<HTMLElement>(`.context-bar-tail-pane[data-pane="${which}"]`)?.querySelector('[data-field]')
        ?.textContent;

const proseState = (scope: Element): { nodeId?: string; hidden: HTMLElement['hidden'] }[] =>
    Array.from(scope.querySelectorAll<HTMLElement>('.agent-text')).map((node) => ({
        nodeId: node.dataset.contextNode,
        hidden: node.hidden
    }));

/** Runs the whole live sequence, one projector frame per recorded event, then settles. */
const stream = (options: Parameters<typeof createTurnBoard>[0] = {}) => {
    const turn = recordOf(events());
    const projector = createTurnProjector(turn, CONTEXT);
    const { board, view, tile } = mount(options);

    // The row first, exactly as a submit's 202 body delivers it, then every frame the
    // recorder emits for the events it stored.
    board.upsertView(projector.summary(), view);

    for (let index = 0; index < turn.events.length; index += 1) {
        frame(board, view, projector.apply(turn.events[index], timeOf(index), index));
    }

    frame(board, view, projector.settle('done', T + 9_000));

    return { board, view, tile, projector, turn };
};

/**
 * Everything the board drew for one turn's BODY: the single printed content block, the prose
 * blocks and their visibility, the strip's segments, and the flow's text.
 *
 * The tile HEADER is deliberately not in here. It prints a live elapsed clock (`0ms` while the
 * run streams, the server's figure once it settles) and an agent label this file allocates per
 * board, and those two differ between a live run and a reload by design — R23 is about the body
 * the reader reads, so the comparison is scoped to exactly that.
 */
const boardSnapshot = (scope: Element): Record<string, unknown> => ({
    tail: tailState(scope),
    prose: proseState(scope),
    panes: { args: pane(scope, 'args'), result: pane(scope, 'result') },
    segments: Array.from(scope.querySelectorAll<HTMLElement>('.context-bar-segment')).map((node) => [
        node.dataset.blockId,
        node.dataset.kind,
        node.dataset.chars
    ]),
    flow: scope.querySelector('.agent-flow')?.textContent ?? ''
});

beforeEach(() => {
    pending.clear();
    clearBlockDetailCache();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
});

describe('the server-designated tail, rendered by the real tile', () => {
    it('streams a thinking window past the node bound and shows its LATEST lines (R26)', () => {
        // The loaders are spies, so "printing the current block costs nothing" is measured,
        // not assumed.
        const loadBlockDetail = vi.fn();
        const loadStepDetail = vi.fn();
        const turn = recordOf(events());
        const projector = createTurnProjector(turn, CONTEXT);
        const { board, view, tile } = mount({ loadBlockDetail, loadStepDetail });

        const opened = projector.apply(turn.events[0], timeOf(0), 0);

        board.upsertView(projector.summary(), view);
        frame(board, view, opened);

        // delta 1: 410 characters, one `tail:set`, and the WIRE carries every one of them.
        frame(board, view, projector.apply(turn.events[1], timeOf(1), 1));

        const thinkingChars = DISPLAY_NODE_PREVIEW_CHARS + 90;
        const windowChars = 320;

        expect(tailState(tile())).toMatchObject({
            hidden: false,
            kind: 'reasoning',
            // The wire body is whole (T23/T25), and the PANE is still a window (T26): the two
            // facts are stated separately rather than one of them silently overriding the other.
            truncated: 'false',
            chars: String(thinkingChars),
            shownChars: String(windowChars),
            renderBounded: 'true',
            follow: 'latest',
            caption: `thinking · showing ${windowChars} of ${thinkingChars.toLocaleString('en-US')} characters — click the segment for the exact text`
        });
        expect(tails(tile())).toHaveLength(1);
        // The LAST 320 characters of what the model streamed — not a 320-character stub of its
        // opening, which is exactly the body that used to sit there unchanged.
        expect((tailState(tile()) as { body: string }).body).toBe(`…${'a'.repeat(windowChars)}`);
        expect(tile().querySelectorAll('.tool.think')).toHaveLength(0);

        // delta 2: the SAME element grows, the designation is not re-sent per token, and the
        // painted text MOVES — the newest byte is always on screen.
        const grown = projector.apply(turn.events[2], timeOf(2), 2);

        expect(grown.filter((op) => op.op === 'tail:set')).toHaveLength(0);
        frame(board, view, grown);

        expect((tailState(tile()) as { body: string }).body).toBe(`…${'a'.repeat(200)}${'b'.repeat(120)}`);
        expect(tailState(tile())).toMatchObject({
            chars: String(thinkingChars + 120),
            shownChars: String(windowChars),
            renderBounded: 'true'
        });

        expect(loadBlockDetail).not.toHaveBeenCalled();
        expect(loadStepDetail).not.toHaveBeenCalled();
    });

    it('hands the tail to the call, prints its complete recorded request, and withdraws the thinking', () => {
        const turn = recordOf(events());
        const projector = createTurnProjector(turn, CONTEXT);
        const { board, view, tile } = mount();

        board.upsertView(projector.summary(), view);

        for (let index = 0; index <= 2; index += 1) frame(board, view, projector.apply(turn.events[index], timeOf(index), index));

        expect((tailState(tile()) as { body: string }).body).toContain('a'.repeat(50));

        frame(board, view, projector.apply(turn.events[3], timeOf(3), 3));

        // One body, and it is the call's now. The step's own preview could not have carried
        // this: the marker sits far past `DISPLAY_ARGS_PREVIEW_CHARS` inside the arguments.
        expect(tails(tile())).toHaveLength(1);
        expect(tailState(tile())).toMatchObject({
            hidden: false,
            kind: 'tool',
            nodeId: '3',
            blockId: '0-tool-3',
            state: 'running',
            truncated: 'false',
            chars: String(CALL_ARGS.length)
        });
        expect(CALL_ARGS.length).toBeGreaterThan(DISPLAY_ARGS_PREVIEW_CHARS);
        expect(pane(tile(), 'args')).toBe(CALL_ARGS);
        expect(tile().textContent).toContain('ARGS-MIDDLE-4c1d');
        // The thinking window is history: its body is gone, its segment stays.
        expect((tailState(tile()) as { body: string }).body).not.toContain('a'.repeat(200));
        expect(
            Array.from(tile().querySelectorAll<HTMLElement>('.context-bar-segment')).map((node) => node.dataset.blockId)
        ).toEqual(['0-system-instructions', '0-user-prompt', '0-reasoning-1', '0-tool-3']);
    });

    it('adds the complete recorded response to the same body when the call settles', () => {
        const turn = recordOf(events());
        const projector = createTurnProjector(turn, CONTEXT);
        const { board, view, tile } = mount();

        board.upsertView(projector.summary(), view);

        for (let index = 0; index <= 3; index += 1) frame(board, view, projector.apply(turn.events[index], timeOf(index), index));

        expect(pane(tile(), 'result')).toBeUndefined();

        frame(board, view, projector.apply(turn.events[4], timeOf(4), 4));

        expect(CALL_RESULT.length).toBeGreaterThan(DISPLAY_PREVIEW_CHARS);
        expect(pane(tile(), 'result')).toBe(CALL_RESULT);
        expect(tailState(tile())).toMatchObject({
            kind: 'tool',
            state: 'ok',
            duration: '1300',
            chars: String(CALL_ARGS.length + CALL_RESULT.length),
            truncated: 'false'
        });
        expect(tailState(tile())?.caption).toBe(
            `read · ok · 1.3s · ${(CALL_ARGS.length + CALL_RESULT.length).toLocaleString('en-US')} characters` +
                ` · args ${CALL_ARGS.length} + result ${CALL_RESULT.length}`
        );
        // Still one body element, still no card, still no request.
        expect(tails(tile())).toHaveLength(1);
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
    });

    it('takes the tail back for the next window and drops the call payload from the document', () => {
        const turn = recordOf(events());
        const projector = createTurnProjector(turn, CONTEXT);
        const { board, view, tile } = mount();

        board.upsertView(projector.summary(), view);

        for (let index = 0; index <= 4; index += 1) frame(board, view, projector.apply(turn.events[index], timeOf(index), index));

        expect(tile().textContent).toContain('RESULT-MIDDLE-9f3c');

        frame(board, view, projector.apply(turn.events[5], timeOf(5), 5));

        // R23 compactness, on the rendered surface: the superseded payload is not left in the
        // DOM (hidden or otherwise); only the CURRENT block is whole, and the call stays where
        // it belongs — a segment one click from its exact bytes.
        expect(tailState(tile())).toMatchObject({ kind: 'reasoning', nodeId: 'n5', body: 'second round of thinking' });
        expect(tile().textContent).not.toContain('RESULT-MIDDLE-9f3c');
        expect(tile().textContent).not.toContain('ARGS-MIDDLE-4c1d');
        expect(
            Array.from(tile().querySelectorAll<HTMLElement>('.context-bar-segment')).map((node) => node.dataset.blockId)
        ).toContain('0-tool-3');
    });

    it('lets the final answer take over the body, in the existing answer surface', () => {
        const turn = recordOf(events());
        const projector = createTurnProjector(turn, CONTEXT);
        const { board, view, tile } = mount();

        board.upsertView(projector.summary(), view);

        for (let index = 0; index <= 6; index += 1) frame(board, view, projector.apply(turn.events[index], timeOf(index), index));
        frame(board, view, projector.apply(turn.events[7], timeOf(7), 7));
        const settled = projector.settle('done', T + 9_000);

        frame(board, view, settled);

        // The answer is prose, so its full text is the flow's `.agent-text` block immediately
        // under the strip, and the strip's own body element withdraws — one body per section,
        // never the same answer printed twice.
        expect(tailState(tile())).toMatchObject({ hidden: true, kind: undefined, nodeId: undefined });
        expect(proseState(tile())).toEqual([{ nodeId: 'n6', hidden: false }]);
        expect(tile().querySelector('.agent-text')?.textContent).toBe('the final answer, in full\n');
        expect(tails(tile())).toHaveLength(1);
        // And every earlier window stayed compact in the same document the stream produced.
        expect(tile().textContent).not.toContain('RESULT-MIDDLE-9f3c');
    });

    it('paints the same board from the cold document a reload receives', () => {
        const live = stream();
        const streamed = boardSnapshot(live.tile());

        // The same durable record, folded the way a restore and every `getView` fold it.
        const cold = projectTurn(recordOf(events(), { status: 'done', updatedAt: T + 9_000 }), CONTEXT);
        const coldView = {
            id: 's1',
            harness: AGENT,
            status: 'idle',
            model: 'scripted/test',
            createdAt: T,
            updatedAt: T + 9_000,
            turns: [cold.summary],
            displays: { t1: cold.display }
        } as unknown as SessionView;

        const empty = document.createElement('div');
        const coldBoard = createTurnBoard({ empty });

        coldBoard.bindSession('s1');
        document.body.replaceChildren(coldBoard.element);
        coldBoard.upsertView(cold.summary, coldView).renderDisplay(cold.display);

        // The streamed board and the reloaded board are one and the same picture: same body,
        // same prose blocks, same segments, same text. No "live-only" tail and no reload-only
        // tail — one compiled state, rendered by one painter.
        expect(boardSnapshot(document.querySelector<HTMLElement>('.tile') as Element)).toEqual(streamed);
        expect(live.view.displays.t1.sections.map((section) => section.tail)).toEqual(cold.display.sections.map((section) => section.tail));
    });
});

// ---------------------------------------------------------------------------
// T25 (R23): an OVERSIZED block, printed exactly
// ---------------------------------------------------------------------------
//
// The rule this pins down is the one a size-capped tail used to break: `tool_call.arguments`
// has NO runtime cap (only a model-facing result does, ../core/result-budget.ts:42), so a
// 70 KiB write call is what the record holds — and "the current block in full" has to mean
// those bytes, not the first 64 KiB of them. The markers sit in the MIDDLE of both payloads,
// so "the whole payload arrived" and "the whole payload left again" are each a real
// assertion: a head-truncated `preview`/`argsPreview` can never contain one.
const BIG_ARGS = `{"path":"big.md","content":"${'w'.repeat(35 * 1024)}BIG-ARGS-CENTER-7k1m${'w'.repeat(35 * 1024)}"}`;
const BIG_RESULT = `${'r'.repeat(33 * 1024)}BIG-RESULT-CENTER-7k1m${'r'.repeat(33 * 1024)}`;

const bigEvents = (): HarnessEvent[] => [
    { type: 'start', agent: AGENT, model: 'scripted/test' },
    { type: 'tool_call', agent: AGENT, call: { id: 'call-1', name: 'write', arguments: BIG_ARGS } },
    {
        type: 'tool_result',
        agent: AGENT,
        name: 'write',
        callId: 'call-1',
        content: BIG_RESULT,
        isError: false,
        outcome: 'completed',
        durationMs: 250
    },
    { type: 'reasoning', agent: AGENT, delta: 'now the round is over' },
    { type: 'attempt_commit', agent: AGENT, attempt: 1, maxAttempts: 2 } as HarnessEvent
];

/** The same live sequence as `stream`, for the oversized record. */
const streamBig = () => {
    const turn = recordOf(bigEvents());
    const projector = createTurnProjector(turn, CONTEXT);
    const { board, view, tile } = mount();

    board.upsertView(projector.summary(), view);

    for (let index = 0; index < turn.events.length; index += 1) {
        frame(board, view, projector.apply(turn.events[index], timeOf(index), index));
    }

    frame(board, view, projector.settle('done', T + 9_000));

    return { board, view, tile, projector, turn };
};

describe('a current block larger than any display bound', () => {
    it('prints the whole recorded request, then the whole recorded response, live', () => {
        const turn = recordOf(bigEvents());
        const projector = createTurnProjector(turn, CONTEXT);
        const { board, view, tile } = mount();

        board.upsertView(projector.summary(), view);
        frame(board, view, projector.apply(turn.events[0], timeOf(0), 0));

        // Past the cap the contract used to impose on itself, so this round is the case that
        // used to lose bytes silently.
        expect(BIG_ARGS.length).toBeGreaterThan(64 * 1024);

        frame(board, view, projector.apply(turn.events[1], timeOf(1), 1));

        // Byte for byte: the printed pane IS the recorded string, not a prefix of it.
        expect(pane(tile(), 'args')).toBe(BIG_ARGS);
        expect(tile().textContent).toContain('BIG-ARGS-CENTER-7k1m');
        expect(tailState(tile())).toMatchObject({
            hidden: false,
            kind: 'tool',
            nodeId: '1',
            blockId: '0-tool-1',
            state: 'running',
            truncated: 'false',
            chars: String(BIG_ARGS.length)
        });
        // The per-part figures are the segment's exact recorded counts, printed beside a
        // body that holds every one of those bytes (invariant 5, and the point of T25).
        expect(tails(tile())[0]?.dataset.argsChars).toBe(String(BIG_ARGS.length));
        expect(tails(tile())[0]?.dataset.resultChars).toBeUndefined();
        expect(tailState(tile())?.caption).toContain('no result recorded yet');

        frame(board, view, projector.apply(turn.events[2], timeOf(2), 2));

        // The settled response joins the SAME body, whole, and the honest caption figures
        // match the recorded lengths — no "showing X of Y" hedge on a body that is complete.
        expect(pane(tile(), 'args')).toBe(BIG_ARGS);
        expect(pane(tile(), 'result')).toBe(BIG_RESULT);
        expect(tailState(tile())).toMatchObject({
            kind: 'tool',
            state: 'ok',
            duration: '250',
            truncated: 'false',
            chars: String(BIG_ARGS.length + BIG_RESULT.length)
        });
        expect(tails(tile())[0]?.dataset.argsChars).toBe(String(BIG_ARGS.length));
        expect(tails(tile())[0]?.dataset.resultChars).toBe(String(BIG_RESULT.length));
        expect(tailState(tile())?.caption).not.toContain('showing');
    });

    it('reloads to the identical board, and keeps the oversized payload out of the history', () => {
        const live = streamBig();
        const streamed = boardSnapshot(live.tile());

        // The thinking window that took the tail is the one body left: the 138 KiB of request
        // and response the round printed a moment ago is gone from the rendered document, and
        // the segment that owns them stays one click away.
        expect(streamed.tail).toMatchObject({ kind: 'reasoning', nodeId: 'n3', body: 'now the round is over' });
        expect(String(streamed.flow)).not.toContain('BIG-ARGS-CENTER-7k1m');
        expect(String(streamed.flow)).not.toContain('BIG-RESULT-CENTER-7k1m');
        expect((streamed.panes as { args: string | undefined; result: string | undefined }).args).toBeUndefined();

        const cold = projectTurn(recordOf(bigEvents(), { status: 'done', updatedAt: T + 9_000 }), CONTEXT);
        const coldView = {
            id: 's1',
            harness: AGENT,
            status: 'idle',
            model: 'scripted/test',
            createdAt: T,
            updatedAt: T + 9_000,
            turns: [cold.summary],
            displays: { t1: cold.display }
        } as unknown as SessionView;

        const empty = document.createElement('div');
        const coldBoard = createTurnBoard({ empty });

        coldBoard.bindSession('s1');
        document.body.replaceChildren(coldBoard.element);
        coldBoard.upsertView(cold.summary, coldView).renderDisplay(cold.display);

        // Same single body, same segments, same flow — a reload that switches the tail to a
        // different block than the live stream showed is the failure this file exists for.
        expect(boardSnapshot(document.querySelector<HTMLElement>('.tile') as Element)).toEqual(streamed);
        // The cold fold designates the block the stream ended on, and the superseded call
        // keeps ONLY its own bounded previews: while that call was current the document held
        // all 138 KiB of it, and now it holds none of the markers — one full block per
        // section is the whole rule, in both directions and on both paths.
        expect(cold.display.sections[0].tail).toMatchObject({ kind: 'reasoning', nodeId: 'n3', truncated: false });
        expect(JSON.stringify(cold.display)).not.toContain('BIG-ARGS-CENTER-7k1m');
        expect(
            (cold.display.sections[0].nodes.find((node) => node.id === '1') as { preview?: string }).preview
        ).toHaveLength(DISPLAY_PREVIEW_CHARS);
    });
});
