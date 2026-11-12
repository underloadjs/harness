// The context bar INSIDE the compiled turn board (T11: R7/R8/R3, per-section since T19: R17).
//
// This file is the acceptance evidence for "one horizontal separated segmented bar instead
// of a wall of tool chips", and it is deliberately driven the way the shell drives a tile:
// hand-written `TurnSummary` rows and `TurnDisplayOp` frames, applied to a document by the
// SAME reducer the shell runs (`../view-state.applyOpToDisplay`), then routed to the tile by
// turn id. No `HarnessEvent`, no raw snapshot, no projector — so what it proves is that the
// DOM comes from the server's ADDRESSED context metadata and nothing else.
//
// The things that matter and are pinned here:
//   - ONE bar per SECTION: the turn's own strip describes the ROOT section, and every
//     delegated conversation carries its own strip inside its own card (T19 R17 replaced the
//     single aggregate that folded a delegation's calls into its caller's block);
//   - the user's prompt and the section's current answer stay in full, so the bar is a
//     summary surface, not a deletion of the transcript;
//   - NOTHING is fetched to render a turn: the block route fires on a segment click, once,
//     for that block, and the step route is never touched in this mode.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-context-bar.test.ts

import type { SessionView } from '../../server/protocol';
import type { HarnessPendingTool } from '../../types';
import type {
    ContextBlock,
    TurnBlockDetail,
    TurnDisplay,
    TurnDisplayOp,
    TurnSection,
    TurnSummary
} from '../../shared/turn-display';
import type { TurnBoard } from './turns';
import { createTurnBoard } from './turns';
import { applyOpsToDisplay } from '../view-state';
import { clearBlockDetailCache } from './context-detail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Hand-written compiled fixtures
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
    chars: 28,
    argsChars: 10,
    resultChars: 18,
    inPrompt: true,
    state: 'ok',
    eventFrom: 7,
    eventTo: 9,
    at: T,
    endedAt: T + 800,
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

const toolStep = (overrides: Partial<TurnSection['nodes'][number]> = {}): TurnSection['nodes'][number] =>
    ({
        kind: 'tool',
        id: '7',
        turnId: 't1',
        sectionId: 't1:0',
        callId: 'call-1',
        name: 'read',
        argsPreview: 'path=notes',
        preview: 'the file body',
        state: 'ok',
        outcome: 'completed',
        startedAt: T,
        endedAt: T + 800,
        durationMs: 800,
        detail: { stepId: '7', hasResult: true, truncated: true },
        ...overrides
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

const pending = new Map<string, HarnessPendingTool[]>();

/** Apply one frame exactly as `main.ts onViewItem` does: state first, then the tile. */
const frame = (board: TurnBoard, document: SessionView, turnId: string, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(document, turnId, ops, pending);

    return board.applyViewOps(turnId, ops, document);
};

const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): { board: TurnBoard; tile: () => HTMLElement } => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ ...options, empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return {
        board,
        tile: () => document.querySelector<HTMLElement>('.tile') as HTMLElement
    };
};

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// A turn whose context the server has described: prompt, instructions, thinking, a settled
// tool, a failed tool, and the current answer.
const CONTEXT = [
    block({ kind: 'user', id: '0-user-prompt', name: 'prompt', chars: 40, argsChars: undefined, resultChars: undefined, state: undefined, eventFrom: undefined, eventTo: undefined, endedAt: undefined }),
    block({ kind: 'system', id: '0-system-instructions', name: 'instructions', chars: 60, argsChars: undefined, resultChars: undefined, state: undefined, eventFrom: undefined, eventTo: undefined, endedAt: undefined }),
    block({ kind: 'reasoning', id: '0-reasoning-3', name: 'reasoning', chars: 200, argsChars: undefined, resultChars: undefined, state: undefined, inPrompt: false }),
    block({ kind: 'tool', id: '0-tool-7', name: 'read', chars: 1184 }),
    block({ kind: 'tool', id: '0-tool-12', name: 'bash', chars: 90, state: 'error', argsChars: 30, resultChars: 60 })
];

const blocksOf = (tile: HTMLElement): HTMLElement[] =>
    Array.from(tile.querySelectorAll<HTMLElement>('.context-bar-segment'));

// The block route's answer for the fixtures: the segment's metadata plus its two recorded
// halves (../shared/turn-display.ts:524).
const blockDetail = (overrides: Partial<TurnBlockDetail> = {}): TurnBlockDetail => ({
    ...block(),
    sessionId: 's1',
    args: '{"path":"notes.md"}',
    result: 'the whole recorded file body',
    ...overrides
});

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
// R7: ONE bar, in section order, and no wall of chips
// ---------------------------------------------------------------------------

describe('one bar per turn', () => {
    it('paints a single bar from the sections context and no tool card at all', () => {
        const view = documentOf([summary()], {
            t1: [rootSection({ context: CONTEXT, nodes: [toolStep({ id: '7' }), toolStep({ id: '12', callId: 'call-2', name: 'bash' })] })]
        });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(tile().querySelectorAll('.context-bar')).toHaveLength(1);
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
        expect(tile().querySelectorAll('.tool-group')).toHaveLength(0);

        const segments = blocksOf(tile());
        expect(segments.map((node) => node.dataset.blockId)).toEqual(CONTEXT.map((entry) => entry.id));
        expect(segments.map((node) => node.dataset.tone)).toEqual(['neutral', 'neutral', 'reasoning', 'ok', 'error']);
        expect(segments.map((node) => node.dataset.chars)).toEqual(['40', '60', '200', '1184', '90']);
        expect(segments.map((node) => node.dataset.kind)).toEqual(['user', 'system', 'reasoning', 'tool', 'tool']);
        expect(tile().querySelector('.context-bar-host')?.hidden).toBe(false);
    });

    it('sizes each segment by its recorded TIME and each bar by its characters (R27)', () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: CONTEXT })] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        const segments = blocksOf(tile());
        const weights = segments.map((node) => Number(node.style.flexGrow));

        // The two prompt-ish blocks were never bracketed, so they hold the honest BASELINE and
        // never a share of the timeline; the three 800ms blocks divide what is left equally.
        // The numbers are the model's shares of the fallback track (640px, 2px gaps = 632px
        // usable) scaled to flex units: 8/632 -> 127, and (616/3)/632 -> 3249.
        expect(weights).toEqual([127, 127, 3249, 3249, 3249]);
        expect(segments.map((node) => node.dataset.durationKnown)).toEqual(['false', 'false', 'true', 'true', 'true']);
        // The WIDEST bar by characters (1,184) is NOT the widest segment any more — the axis
        // changed, and this is the assertion that pins which axis drives which direction.
        expect(segments.map((node) => node.dataset.heightPx)).toEqual(['3', '3', '6', '36', '3']);
        expect(segments.map((node) => node.style.height)).toEqual(['3px', '3px', '6px', '36px', '3px']);
        // Every weight is at least 1 flex unit: a recorded block never disappears.
        expect(weights.every((weight) => weight >= 1)).toBe(true);
        // The gap is the model's, and CSS keeps it (see ui/context-bar-style.test.ts).
        expect(tile().querySelector('.context-bar')?.getAttribute('data-mode')).toBe('dom');
        expect(tile().querySelector('.context-bar')?.querySelectorAll('.context-bar-segment')).toHaveLength(5);
        expect(tile().querySelector('.context-bar')?.getAttribute('data-gap-px')).toBe('2');
        expect(tile().querySelector('.context-bar')?.getAttribute('data-unknown-durations')).toBe('2');
        expect(tile().querySelector('.context-bar')?.getAttribute('data-total-duration-ms')).toBe('2400');
        expect(tile().querySelector('.context-bar')?.getAttribute('data-max-chars')).toBe('1184');
    });

    it('stacks one row per lane when the turn spans lanes, and stays one row when it does not (C2)', () => {
        // The same five blocks the test above draws, with the server's lane assignment on them:
        // the prompt, the instructions and the thinking belong to the FIRST request (lane 0) and
        // the two calls were issued after a compaction (lane 1). Nothing else about the turn
        // changes, so this is the end-to-end half of the parity promise — the tile hands the bar
        // exactly the blocks the section carried, and the bar decides the rows.
        const laned: ContextBlock[] = CONTEXT.map((entry, position) => ({ ...entry, lane: position < 3 ? 0 : 1 }));
        const view = documentOf([summary()], { t1: [rootSection({ context: laned })] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        const bar = tile().querySelector('.context-bar') as HTMLElement;
        const segmentsOf = (row: Element): HTMLElement[] => Array.from(row.querySelectorAll<HTMLElement>('.context-bar-segment'));
        const rows = Array.from(bar.querySelectorAll<HTMLElement>('.context-bar-rows > .context-bar-segments'));

        // Lane 0 topmost, ascending downward, and only the lanes the blocks occupy.
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.dataset.row)).toEqual(['0', '1']);
        expect(rows.map((row) => row.dataset.lane)).toEqual(['0', '1']);
        expect(rows.map((row) => segmentsOf(row).map((node) => node.dataset.blockId))).toEqual([
            ['0-user-prompt', '0-system-instructions', '0-reasoning-3'],
            ['0-tool-7', '0-tool-12']
        ]);

        // EACH ROW IS ITS OWN GRAPH. Both rows are 36px because each lane has its own biggest
        // block (200 chars in row 0, 1,184 in row 1) — row 0 is not squashed to share the strip
        // with row 1, and the 200-char bar is 36px here where the flat bar above drew it at 6px.
        expect(rows.map((row) => row.style.height)).toEqual(['36px', '36px']);
        expect(segmentsOf(rows[0]).map((node) => node.style.height)).toEqual(['7px', '11px', '36px']);
        expect(segmentsOf(rows[1]).map((node) => node.style.height)).toEqual(['36px', '3px']);
        // The width axis is per-row too: row 0's three segments water-fill their own track
        // (8px baselines for the two unbracketed blocks, the timed 800ms block taking the rest),
        // and row 1's two equal 800ms calls split theirs exactly in half.
        expect(segmentsOf(rows[0]).map((node) => node.style.flexGrow)).toEqual(['126', '126', '9748']);
        expect(segmentsOf(rows[1]).map((node) => node.style.flexGrow)).toEqual(['5000', '5000']);
        expect(rows.map((row) => row.style.gap)).toEqual(['2px', '2px']);

        // Rows announce the lane they are, once there is more than one to tell apart.
        expect(rows.map((row) => row.getAttribute('role'))).toEqual(['group', 'group']);
        expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['context bar lane 0', 'context bar lane 1']);

        // Bar-level figures: the STACK's box, the lanes it stacks, and every row's band origin.
        expect(bar.getAttribute('data-lanes')).toBe('2');
        expect(bar.getAttribute('data-lane-tags')).toBe('true');
        expect(bar.getAttribute('data-row-offsets')).toBe('0,38');
        expect(bar.getAttribute('data-height-px')).toBe('74');
        // A figure that is a sum or a maximum stays bar-wide, not per-row: the character ceiling
        // is the biggest block ANYWHERE in the bar.
        expect(bar.getAttribute('data-max-chars')).toBe('1184');
        expect(bar.getAttribute('data-total-duration-ms')).toBe('2400');
        expect(bar.getAttribute('data-unknown-durations')).toBe('2');

        // THE CUE: a reader who sees two rows is TOLD the turn spans two lanes — once in the
        // figures line, and once per row as a tag the eye and the screen reader share.
        expect(bar.querySelector('.context-bar-caption')?.textContent).toBe('5 segments · 2 lanes');

        const tags = Array.from(bar.querySelectorAll<HTMLElement>('.context-bar-lane'));

        expect(tags.map((tag) => tag.textContent)).toEqual(['L0', 'L1']);
        expect(tags.map((tag) => tag.style.top)).toEqual(['0px', '38px']);
        expect(tags.map((tag) => tag.style.height)).toEqual(['36px', '36px']);
        expect(tags.map((tag) => tag.getAttribute('aria-label'))).toEqual(['context bar lane 0', 'context bar lane 1']);

        // PARITY: the identical five blocks with NO published lane are the bar this board printed
        // before lanes existed — one row, no group semantics, no tags, no lane clause.
        const flatView = documentOf([summary()], { t1: [rootSection({ context: CONTEXT })] });
        const flatMount = mount();
        flatMount.board.upsertView(summary(), flatView).renderDisplay((flatView.displays as Record<string, TurnDisplay>).t1);

        const flatBar = flatMount.tile().querySelector('.context-bar') as HTMLElement;
        const flatRows = Array.from(flatBar.querySelectorAll<HTMLElement>('.context-bar-rows > .context-bar-segments'));

        expect(flatRows).toHaveLength(1);
        expect(flatRows[0].dataset.row).toBe('0');
        expect(flatRows[0].dataset.lane).toBe('0');
        expect(flatRows[0].getAttribute('role')).toBeNull();
        expect(flatRows[0].hasAttribute('aria-label')).toBe(false);
        expect(flatRows[0].style.height).toBe('36px');
        expect(flatRows[0].style.gap).toBe('2px');
        // The flat geometry is exactly what the two tests above pin for these fixtures, which is
        // the hard parity rule stated as data: the per-row normalization collapses to the strip's.
        expect(segmentsOf(flatRows[0]).map((node) => node.dataset.blockId)).toEqual(CONTEXT.map((entry) => entry.id));
        expect(segmentsOf(flatRows[0]).map((node) => node.style.height)).toEqual(['3px', '3px', '6px', '36px', '3px']);
        expect(segmentsOf(flatRows[0]).map((node) => node.style.flexGrow)).toEqual(['127', '127', '3249', '3249', '3249']);
        expect(flatBar.getAttribute('data-lanes')).toBe('1');
        expect(flatBar.getAttribute('data-lane-tags')).toBe('false');
        expect(flatBar.getAttribute('data-row-offsets')).toBe('0');
        expect(flatBar.getAttribute('data-height-px')).toBe('36');
        // The overlay is always in the DOM (one shape in both modes) but contributes nothing here.
        expect(flatBar.querySelectorAll('.context-bar-lane')).toHaveLength(0);
        expect(flatBar.querySelector('.context-bar-lanes')?.hasAttribute('hidden')).toBe(true);
        expect(flatBar.querySelector('.context-bar-caption')?.textContent).toBe('5 segments');
    });

    it('gives the root strip only its own segments, and the delegated card its own strip', () => {
        const view = documentOf([summary()], {
            t1: [
                rootSection({ context: [block({ kind: 'user', id: '0-user-prompt', name: 'prompt', argsChars: undefined, resultChars: undefined, state: undefined }), block({ id: '0-tool-7' })], nodes: [toolStep()] }),
                childSection({ context: [block({ id: '1-tool-4', sectionId: 't1:1', name: 'grep', chars: 500, argsChars: 100, resultChars: 400 })], nodes: [toolStep({ id: '4', sectionId: 't1:1', name: 'grep', callId: 'call-9' })] })
            ]
        });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        // T19 (R17): ONE bar per SECTION. The tile's strip is the turn's own (root) section's
        // distribution — the delegates are no longer aggregated into it, which is what left a
        // delegated conversation with no bar of its own.
        expect(tile().querySelectorAll('.context-bar')).toHaveLength(1);
        expect(blocksOf(tile()).map((node) => node.dataset.blockId)).toEqual(['0-user-prompt', '0-tool-7']);
        expect(tile().querySelector<HTMLElement>('.context-bar-host')?.dataset.sectionId).toBe('t1:0');
        expect(tile().querySelector<HTMLElement>('.context-bar-host')?.dataset.turnId).toBe('t1');

        // The delegated conversation carries its OWN strip, inside its own card, and the card
        // is not inside the tile at all (R18).
        const row = document.querySelector<HTMLElement>('.thread-row') as HTMLElement;
        expect(row).not.toBe(null);
        expect(tile().contains(row)).toBe(false);
        expect(row.querySelectorAll('.context-bar')).toHaveLength(1);
        expect(blocksOf(row).map((node) => node.dataset.blockId)).toEqual(['1-tool-4']);
        expect(row.querySelector<HTMLElement>('.context-bar-host')?.dataset.sectionId).toBe('t1:1');
        expect(row.querySelector<HTMLElement>('.context-bar-host')?.dataset.turnId).toBe('t1');

        // Neither strip repeats the other's segment: each answers for exactly one section.
        expect(tile().querySelectorAll('.context-bar-segment[data-block-id="1-tool-4"]')).toHaveLength(0);
        expect(row.querySelectorAll('.context-bar-segment[data-block-id="0-tool-7"]')).toHaveLength(0);
        // And each section's recorded call is a segment of ITS bar, not a card — the suppression
        // is per section, not tile-wide.
        expect(row.querySelectorAll('.thread-row .tool')).toHaveLength(0);
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
    });

    it('keeps the prompt and the current answer in full while it summarizes the rest', () => {
        const view = documentOf([summary()], {
            t1: [
                rootSection({
                    context: CONTEXT,
                    answerNodeId: '5',
                    nodes: [
                        { kind: 'reasoning', id: '3', text: 'a bounded preview of the thinking', chars: 900, redacted: true } as never,
                        { kind: 'text', id: '5', text: 'the complete recorded answer, every line of it', committed: true } as never
                    ]
                })
            ]
        });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(tile().querySelector('.tile-prompt')?.textContent).toBe('read the notes and tell me what changed');
        expect(tile().querySelector('.turn-prompt')?.textContent).toContain('read the notes and tell me what changed');
        // The designated full-text node is printed whole, exactly as the wire sent it: the
        // CURRENT answer is the section's one content body, immediately below the strip.
        expect(tile().querySelector('.agent-text')?.textContent).toContain('the complete recorded answer, every line of it');
        expect(tile().querySelector<HTMLElement>('.agent-text')?.hidden).toBe(false);
        // T22 (R23): the superseded thinking window prints NO body. It is the amber segment
        // of the strip, and its exact bytes arrive on the click — which is what the wall of
        // stale `think` chips in the user's screenshot used to print instead.
        expect(tile().querySelectorAll('.tool.think')).toHaveLength(0);
        expect(tile().querySelectorAll('.context-bar-tail')).toHaveLength(1);
        // One body per section, and it is the strip's own tail: the answer printed below is
        // the ONLY content surface on screen, so the tail element is hidden, not deleted —
        // the element is reused, which is how a long run cannot accumulate bodies.
        expect(tile().querySelector<HTMLElement>('.context-bar-tail')?.hidden).toBe(true);
        // T27 (R2): while it prints NOTHING the reused element stays parked in the strip's host,
        // which is what keeps the surface's teardown in charge of removing it.
        expect(
            tile().querySelector<HTMLElement>('.context-bar-tail')?.parentElement?.classList.contains('context-bar-host')
        ).toBe(true);
        // The user's prompt is preserved on its own surface, never folded into the bar.
        expect(tile().querySelector('.context-bar-host')?.contains(tile().querySelector('.turn-prompt') as Node)).toBe(false);
    });

    it('mounts the one tail block in the SECTION flow, and leaves only the strip in the host (R2)', () => {
        const view = documentOf([summary()], {
            t1: [
                rootSection({
                    context: CONTEXT,
                    nodes: [
                        toolStep(),
                        { kind: 'reasoning', id: '3', text: 'the thinking window that owns the body', chars: 40 } as never
                    ],
                    // Designated producer: the server names the thinking window the current
                    // block, so its body prints while a newer response arrives afterwards.
                    tail: { kind: 'reasoning', nodeId: '3', blockId: '0-reasoning-3', chars: 200, truncated: false } as never
                })
            ]
        });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        const host = tile().querySelector<HTMLElement>('.context-bar-host') as HTMLElement;
        const flow = tile().querySelector<HTMLElement>('.agent-flow') as HTMLElement;
        const tail = tile().querySelector<HTMLElement>('.context-bar-tail') as HTMLElement;

        // The strip never moves: its host carries the bar and nothing else (R2 kept the strip
        // where T11 mounted it and moved only the body).
        expect(host.querySelectorAll('.context-bar')).toHaveLength(1);
        expect(host.querySelectorAll('.context-bar-tail')).toHaveLength(0);
        // The body is the section flow's LAST child, so it reads BELOW the flow's prose.
        expect(flow.lastElementChild).toBe(tail);
        expect(tail.dataset.kind).toBe('reasoning');
        // Still exactly one body in the whole tile.
        expect(tile().querySelectorAll('.context-bar-tail')).toHaveLength(1);

        // A later frame that appends prose only (the thinking block it prints does not change,
        // so the content pass early-returns) has to move the SAME element below the new reply.
        frame(board, view, 't1', [
            {
                op: 'node:insert',
                turnId: 't1',
                sectionId: 't1:0',
                node: { kind: 'text', id: '5', text: 'the newest response', chars: 19 } as never
            }
        ]);

        expect(tail.parentElement).toBe(flow);
        expect(flow.lastElementChild).toBe(tail);
        expect(tile().querySelectorAll('.context-bar-tail')).toHaveLength(1);
        expect(tile().querySelector<HTMLElement>('.agent-text')?.hidden).toBe(false);

        // And when the designation finally moves to that response, the block withdraws and the
        // reused element parks back in the strip's host: the answer text in the flow is the
        // only content surface, still ONE tail element.
        frame(board, view, 't1', [
            {
                op: 'tail:set',
                turnId: 't1',
                sectionId: 't1:0',
                tail: { kind: 'assistant', nodeId: '5', chars: 19, truncated: false } as never
            }
        ]);

        expect(tail.parentElement).toBe(host);
        expect(tail.hidden).toBe(true);
        expect(tile().querySelectorAll('.context-bar-tail')).toHaveLength(1);
        expect(tile().querySelector<HTMLElement>('.agent-text')?.hidden).toBe(false);
    });

    it('draws hundreds of segments and still asks the server for nothing', () => {
        const hundreds = Array.from({ length: 300 }, (_, index) => block({ id: `0-tool-${index}`, name: `call-${index}`, chars: index + 1 }));
        const view = documentOf([summary()], {
            t1: [rootSection({ context: hundreds, nodes: hundreds.map((_, index) => toolStep({ id: String(index) })) })]
        });
        const loadBlockDetail = vi.fn(async () => blockDetail());
        const loadStepDetail = vi.fn();
        const { board, tile } = mount({ loadBlockDetail, loadStepDetail });
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(blocksOf(tile())).toHaveLength(300);
        expect(tile().querySelector('.context-bar')?.getAttribute('data-segments')).toBe('300');
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
        expect(loadBlockDetail).not.toHaveBeenCalled();
        expect(loadStepDetail).not.toHaveBeenCalled();
    });

    it('names the unit on the bar, so a character strip is never read as a token gauge', () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: CONTEXT })] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        const bar = tile().querySelector('.context-bar') as HTMLElement;

        // T16 (R16b): the visible line is the FIGURES (`5 segments · 1,574 characters …`),
        // right-aligned under the track, and the phrase that used to lead it is only the
        // accessible name. The unit still has to be spelled out, so a reader can never
        // mistake this strip for a context-window gauge.
        // The TRAILING clause names the thinking POLICY rather than an absolute (uplift F8/H5):
        // all 200 un-in-prompt characters here belong to the `reasoning` block, and the bar
        // re-words that one count because `trimThoughts` + `thoughtTurns` decide it per ENTRY while the
        // projector marks the whole class — ./context-bar.ts `contextBarAccessibleNameOf`.
        expect(bar.getAttribute('aria-label')).toBe(
            'context bar: width is time taken, height is recorded characters · 5 segments · 1,574 characters' +
                ' · 2.4s of recorded time · 2 segments have no recorded time · 200 characters\' replay decided by the thinking policy'
        );
        expect(bar.querySelector('.context-bar-caption')?.textContent).toBe('5 segments');
        // T22 (R24): count only on the printed line. The label phrase that used to head it,
        // and the character totals that used to follow it, are both off the visible surface —
        // the phrase because it repeated above every turn, the totals because a reader never
        // acted on them. Both stay in the ACCESSIBLE name above, and every segment still
        // states its own exact figures, so the strip can never read as a token gauge.
        expect(bar.querySelector('.context-bar-caption')?.textContent).not.toContain('characters');
        expect(bar.querySelector('.context-bar-caption')?.textContent).not.toContain('context bar: width is time taken');
        expect(bar.querySelectorAll<HTMLElement>('.context-bar-segment')[3].title).toContain('1,184 characters');
        expect(bar.textContent).not.toMatch(/token/i);
    });
});

// ---------------------------------------------------------------------------
// R3: the request belongs to the click
// ---------------------------------------------------------------------------

describe('a segment click, and only a segment click', () => {
    // The route's answer embeds the segment's OWN metadata by value, so the loader echoes
    // the block it is answering: a fingerprint that disagreed would be a cache miss, and the
    // fixture would be testing its own inconsistency instead of the cache.
    const detailFor = (blockId: string): TurnBlockDetail => {
        const source = CONTEXT.find((entry) => entry.id === blockId) ?? block();

        return {
            ...source,
            sessionId: 's1',
            ...(source.kind === 'tool'
                ? { args: '{"path":"notes.md"}', result: 'the whole recorded file body' }
                : { text: 'the recorded reasoning window, in full' })
        };
    };

    it('loads the full detail of the segment that was clicked, exactly once', async () => {
        const calls: { turnId: string; blockId: string; sessionId?: string }[] = [];
        const loadBlockDetail = vi.fn(async (input: { turnId: string; blockId: string; sessionId?: string }) => {
            calls.push(input);

            return detailFor(input.blockId);
        });

        const view = documentOf([summary()], { t1: [rootSection({ context: CONTEXT })] });
        const { board, tile } = mount({ loadBlockDetail });
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(document.querySelectorAll('.dialog')).toHaveLength(0);

        blocksOf(tile())[3].click();
        await settled();

        expect(calls).toEqual([{ sessionId: 's1', turnId: 't1', blockId: '0-tool-7' }]);
        expect(document.querySelector('.dialog-title')?.textContent).toBe('read · tool · ok');
        expect(document.querySelector('.block-detail')?.getAttribute('data-kind')).toBe('tool');
        expect(document.querySelector<HTMLElement>('[data-pane="args"]')?.textContent).toContain('{"path":"notes.md"}');
        expect(document.querySelector<HTMLElement>('[data-pane="result"]')?.textContent).toContain('the whole recorded file body');

        // A second click is served from the detail cache, not from the network again.
        blocksOf(tile())[3].click();
        await settled();
        expect(calls).toHaveLength(1);
        expect(document.querySelector('.block-detail')?.getAttribute('data-status')).toBe('cached');

        // A different segment is a different block, so it costs its own one request.
        blocksOf(tile())[2].click();
        await settled();
        expect(calls).toHaveLength(2);
        expect(calls[1].blockId).toBe('0-reasoning-3');
        expect(document.querySelector('.block-detail')?.getAttribute('data-kind')).toBe('reasoning');
        expect(document.querySelector<HTMLElement>('[data-pane="text"]')?.textContent).toContain('the recorded reasoning window, in full');
    });

    it('opens an unwired segment with a stated answer instead of an invented one', () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: CONTEXT })] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        blocksOf(tile())[0].click();

        expect(document.querySelector('.block-detail-note')?.textContent).toBe('this board has no block detail route');
        expect(document.querySelector('.block-detail')?.getAttribute('data-status')).toBe('unwired');
        // The metadata line still answers the question the reader had.
        expect(document.querySelector('.block-detail-fact[data-fact="chars"]')?.textContent).toBe('40 characters recorded');
    });

    it('closes the open segment dialog when the block leaves the turn', async () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: [block({ id: '0-tool-7' })] })] });
        const { board, tile } = mount({ loadBlockDetail: async () => blockDetail() });
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        blocksOf(tile())[0].click();
        await settled();
        expect(document.querySelector('.dialog')).not.toBeNull();

        frame(board, view, 't1', [{ op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7' }]);

        expect(document.querySelector('.dialog')).toBeNull();
        expect(blocksOf(tile())).toHaveLength(0);
    });

    it('refreshes an open segment when its metadata moves, without a second request for a settled block', async () => {
        const calls: string[] = [];
        const loadBlockDetail = vi.fn(async (input: { blockId: string }) => {
            calls.push(input.blockId);

            return blockDetail();
        });

        const view = documentOf([summary()], { t1: [rootSection({ context: [block()] })] });
        const { board, tile } = mount({ loadBlockDetail });
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        blocksOf(tile())[0].click();
        await settled();
        expect(calls).toEqual(['0-tool-7']);

        // The route renamed the tool (a settled re-stamp), so the dialog follows the metadata.
        frame(board, view, 't1', [{ op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { name: 'read_file' } }]);

        expect(calls).toEqual(['0-tool-7']);
        expect(document.querySelector('.dialog-title')?.textContent).toBe('read_file · tool · ok');
        expect(blocksOf(tile())[0].dataset.blockId).toBe('0-tool-7');
    });
});

// ---------------------------------------------------------------------------
// The live path: segments appear, settle and move with the ops
// ---------------------------------------------------------------------------

describe('a running turn', () => {
    it('grows one bar from context:add and recolors it when the call settles', () => {
        const view = documentOf([summary()], { t1: [rootSection()] });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        frame(board, view, 't1', [
            { op: 'section:open', turnId: 't1', section: rootSection({ context: [] }) },
            { op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block({ state: 'running', chars: 10, resultChars: undefined, endedAt: undefined, eventTo: 7 }) },
            { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: toolStep({ state: 'running', endedAt: undefined, durationMs: undefined, detail: { stepId: '7', hasResult: false, truncated: true } }) }
        ]);

        let segments = blocksOf(tile());
        expect(segments).toHaveLength(1);
        expect(segments[0].dataset.tone).toBe('running');
        expect(segments[0].dataset.chars).toBe('10');
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);

        frame(board, view, 't1', [
            { op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { state: 'error', chars: 90, resultChars: 80, endedAt: T + 900, eventTo: 9 } },
            { op: 'step:set', turnId: 't1', sectionId: 't1:0', step: toolStep({ state: 'error', outcome: 'failed' }) as never }
        ]);

        segments = blocksOf(tile());
        expect(segments).toHaveLength(1);
        expect(segments[0].dataset.tone).toBe('error');
        expect(segments[0].dataset.chars).toBe('90');
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
    });

    it('dims and un-dims a segment on a frame that moves only `included` (R7)', () => {
        // THE LIVE HALF. A reader excluding the block in the segment dialog, or a plugin writing
        // `turn.before setIncluded`, sends a `context:set` naming ONE field on a segment that is
        // already on screen: view-state.ts applies it, the tile re-syncs, and the bar's DOM hook
        // follows — no re-mint, no remove+add, no second bar. A dim state that only appeared on a
        // fresh `context:add` would never move while the reader watched.
        const view = documentOf([summary()], { t1: [rootSection({ context: [block()] })] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        // Nothing published inclusion yet, so the segment carries the UNKNOWN spelling and CSS
        // dims nothing (`[data-included='false']` is the only dimming selector).
        expect(blocksOf(tile()).map((node) => node.dataset.included)).toEqual(['']);

        frame(board, view, 't1', [{ op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { included: false } }]);

        const dimmed = blocksOf(tile())[0];

        expect(dimmed.dataset.included).toBe('false');
        expect(dimmed.dataset.blockId).toBe('0-tool-7');
        // The dim is ALL that moved: same tone, same characters, same tab stop, same bar.
        expect(dimmed.dataset.tone).toBe('ok');
        expect(dimmed.dataset.chars).toBe('28');
        expect(dimmed.tabIndex).toBe(0);
        expect(tile().querySelectorAll('.context-bar')).toHaveLength(1);
        // ...and the words follow the transparency, in the tile's own rendering.
        expect(dimmed.title).toBe('read · tool · ok · 28 characters · args 10 + result 18 · 800ms · not replayed into the prompt');

        // Including it again clears the hook, so `[data-included='false']` stops matching.
        frame(board, view, 't1', [{ op: 'context:set', turnId: 't1', sectionId: 't1:0', blockId: '0-tool-7', patch: { included: true } }]);

        const lit = blocksOf(tile())[0];

        expect(lit.dataset.included).toBe('true');
        expect(lit.title).toBe('read · tool · ok · 28 characters · args 10 + result 18 · 800ms');
        expect(tile().querySelectorAll('.context-bar')).toHaveLength(1);
    });

    it('converts a tile that had already painted cards into the bar exactly once', () => {
        // A legacy-compatible frame arrives first (no context anywhere), so the tile drew
        // step cards; the next frame carries the metadata.
        const view = documentOf([summary()], { t1: [rootSection({ nodes: [toolStep()] })] });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(tile().querySelectorAll('.tool')).toHaveLength(1);
        expect(tile().querySelectorAll('.context-bar')).toHaveLength(0);
        expect(tile().querySelector('.context-bar-host')?.hidden).toBe(true);

        frame(board, view, 't1', [{ op: 'context:add', turnId: 't1', sectionId: 't1:0', block: block() }]);

        // Same call, ONE surface now: the card is gone rather than duplicated beside the bar.
        expect(tile().querySelectorAll('.tool')).toHaveLength(0);
        expect(tile().querySelectorAll('.context-bar')).toHaveLength(1);
        expect(blocksOf(tile()).map((node) => node.dataset.blockId)).toEqual(['0-tool-7']);
        expect(tile().querySelector('.context-bar-host')?.hidden).toBe(false);
    });

    it('gives the cards back when a reconcile stops carrying context', () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: [block()], nodes: [toolStep()] })] });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(tile().querySelectorAll('.tool')).toHaveLength(0);

        const legacy = documentOf([summary()], { t1: [rootSection({ nodes: [toolStep()] })] });
        handle.syncDisplay((legacy.displays as Record<string, TurnDisplay>).t1);

        expect(tile().querySelectorAll('.context-bar')).toHaveLength(0);
        expect(tile().querySelectorAll('.tool')).toHaveLength(1);
    });

    it('leaves an authoritative empty bar without hiding the calls it cannot describe', () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: [], nodes: [toolStep()] })] });
        const { board, tile } = mount();
        board.upsertView(summary(), view).renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(tile().querySelector('.context-bar')?.getAttribute('data-empty')).toBe('true');
        // T16 (R16b): the visible line states the state, not the bar's name — the phrase
        // lives on in `aria-label` only.
        expect(tile().querySelector('.context-bar-caption')?.textContent).toBe('no recorded context');
        expect(tile().querySelector('.context-bar')?.getAttribute('aria-label')).toBe(
            'context bar: width is time taken, height is recorded characters · no recorded context'
        );
        // A bar with nothing in it does not get to swallow three hundred recorded calls.
        expect(tile().querySelectorAll('.tool')).toHaveLength(1);
    });

    it('keeps a discarded attempts segment out of the bar', () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: [block({ id: 'keep' }), block({ id: 'drop' })] })] });
        const { board, tile } = mount();
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        expect(blocksOf(tile())).toHaveLength(2);

        frame(board, view, 't1', [{ op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: 'drop' }]);
        expect(blocksOf(tile()).map((node) => node.dataset.blockId)).toEqual(['keep']);

        // T19 (R17/R18): a delegated section owns its own strip, so a section the server
        // discards takes THAT strip (and its row) with it — the caller's bar never held the
        // child's segments, so it cannot lose them either.
        const document2 = documentOf([summary()], {
            t1: [rootSection({ context: [block({ id: 'keep' })] }), childSection({ context: [block({ id: 'child', sectionId: 't1:1' })], nodes: [] })]
        });
        const second = mount();
        second.board.upsertView(summary(), document2).renderDisplay((document2.displays as Record<string, TurnDisplay>).t1);
        expect(blocksOf(second.tile()).map((node) => node.dataset.blockId)).toEqual(['keep']);

        const childRow = document.querySelector<HTMLElement>('.thread-row') as HTMLElement;
        expect(blocksOf(childRow).map((node) => node.dataset.blockId)).toEqual(['child']);

        frame(second.board, document2, 't1', [{ op: 'section:remove', turnId: 't1', sectionId: 't1:1' }]);
        expect(blocksOf(second.tile()).map((node) => node.dataset.blockId)).toEqual(['keep']);
        // The dropped card is gone, and so is the only strip that ever carried its segment.
        expect(document.querySelectorAll('.thread-row')).toHaveLength(0);
        expect(document.querySelectorAll('.context-bar')).toHaveLength(1);
        expect(document.querySelector('.context-bar-segment[data-block-id="child"]')).toBeNull();
    });

    it('closes the dialog and stops the observer when the board is torn down', async () => {
        const view = documentOf([summary()], { t1: [rootSection({ context: [block()] })] });
        const { board, tile } = mount({ loadBlockDetail: async () => blockDetail() });
        const handle = board.upsertView(summary(), view);
        handle.renderDisplay((view.displays as Record<string, TurnDisplay>).t1);

        blocksOf(tile())[0].click();
        await settled();
        expect(document.querySelector('.dialog')).not.toBeNull();

        board.clear();

        expect(document.querySelector('.dialog')).toBeNull();
        expect(document.body.style.overflow).not.toBe('hidden');
    });
});
