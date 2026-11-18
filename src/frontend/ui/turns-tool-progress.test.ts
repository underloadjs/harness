// T4 — THE TOOL-COMPOSITION LINE: "composing 4 tool calls · 6,512 chars".
//
// The incident, from the other side: the primary agent said it was launching four
// delegates, then the transcript stopped moving for 62 s and the reader aborted. T1
// proved the run was alive; T2 put the transport's counters on the wire as
// `TurnSection.toolProgress` (../../shared/turn-display.ts:1154) and the projector writes
// them with ONE `section:set` per change (../../server/turn-projector.ts:1926); T3 taught
// the tile to admit a silence. This file pins the renderer in between (ui/turns.ts
// `compositionClauseOf` / `composingProgressOf` / `updateMeta`):
//
//   1. the clause comes ONLY from the journaled field — never from a clock, a node count,
//      or an inference about what the model "must" be doing;
//   2. it may say COMPOSING and nothing stronger: partial arguments are never executed
//      (knowledge.md:5864-5865), so no launched/queued/running wording is allowed;
//   3. `idle` and ABSENT both paint nothing, and a settled turn never shows the line;
//   4. it COMPLEMENTS T3's quiet clause instead of doubling up on it — while progress
//      frames flow the line reads "composing" and never "quiet", and when a relay
//      withholds the whole tool region (zero frames, no progress) the quiet clause still
//      carries the tile;
//   5. live and reload print the same clause for the same journal, because both read the
//      same journaled section.
//
// Every expected string is a literal: the meta line is `parts.join(' · ')` (turns.ts
// `updateMeta`) and the character figure is the grouped `formatContextCharCount`
// (../view-context.ts:542), so there is nothing fuzzy to assert.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-tool-progress.test.ts

import type { SessionView } from '../../server/protocol';
import type { HarnessPendingTool, HarnessToolCallProgress } from '../../types';
import type { TurnDisplayOp, TurnSection, TurnSummary } from '../../shared/turn-display';
import type { TurnBoard } from './turns';
import { createTurnBoard } from './turns';
import { applyOpsToDisplay } from '../view-state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;

// The running row, spelled like the wire: `state` is the projector's own
// `running -> streaming` mapping (../../server/turn-projector.ts `summaryOf`).
const summary = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
    id: 't1',
    index: 0,
    prompt: 'launch four delegates',
    status: 'running',
    state: 'streaming',
    threadId: 'thread-1',
    threadLabel: 'IT4',
    startedAt: T,
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
    agentLabel: 'IT4',
    state: 'streaming',
    startedAt: T,
    nodes: [],
    ...overrides
});

// The counters exactly as the transport aggregates them (../../transport/openai.ts
// `progressSampleOf`): a slot per call the provider opened, and the summed argument text.
const composing = (toolCallSlots: number, argumentChars: number): HarnessToolCallProgress => ({
    phase: 'tool-composition',
    toolCallSlots,
    argumentChars
});

// The cleared value the projector sends at retry / commit / done / error
// (../../server/turn-projector.ts:374 `IDLE_TOOL_PROGRESS`).
const idle = (): HarnessToolCallProgress => ({ phase: 'idle', toolCallSlots: 0, argumentChars: 0 });

const progressPatch = (toolProgress: HarnessToolCallProgress): TurnDisplayOp => ({
    op: 'section:set',
    turnId: 't1',
    sectionId: 't1:0',
    patch: { toolProgress }
});

const pending = new Map<string, HarnessPendingTool[]>();

// One ops frame, applied in the order `main.ts onViewItem` applies it: the state reducer
// first, then the tile.
const frame = (board: TurnBoard, document: SessionView, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(document, 't1', ops, pending);

    return board.applyViewOps('t1', ops, document);
};

const documentOf = (rows: TurnSummary[], sections: TurnSection[]): SessionView =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        createdAt: 1,
        updatedAt: T,
        turns: rows,
        displays: { t1: { turnId: 't1', sections } }
    }) as unknown as SessionView;

const mount = (): { board: TurnBoard } => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return { board };
};

const metaOf = (tile: { element: HTMLElement }): string =>
    tile.element.querySelector('.tile-meta')?.textContent ?? '';

// `getAttribute`, not the `.title` property: the "no explanation attached" pins must
// assert an ABSENT attribute rather than an empty string.
const titleOf = (tile: { element: HTMLElement }): string | null =>
    tile.element.querySelector('.tile-meta')?.getAttribute('title') ?? null;

beforeEach(() => {
    pending.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the tool-composition clause', () => {
    it('prints the journaled counters verbatim, and nothing else', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const document = documentOf([summary()], [rootSection()]);
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        // Nothing reported composition yet: the line is the plain agent count. Absent is
        // NOT "idle" and never an elapsed figure — this is a pre-T2 journal's shape.
        expect(metaOf(tile)).toBe('1 agent');
        expect(titleOf(tile)).toBeNull();

        frame(board, document, [progressPatch(composing(4, 6512))]);

        // Exact grouped characters (`formatContextCharCount`), exact slot count, and the
        // ONLY verb: composing. The clause sits before the quiet clause because a
        // composition IS a frame, and after every count the tile already owns.
        expect(metaOf(tile)).toBe('1 agent · composing 4 tool calls · 6,512 chars');
        expect(titleOf(tile)).toContain('None of them has launched, been queued or started running');

        // The counters move with the next frame; the clause is one line, never a second
        // one, because the projector coalesces the whole stream into this one field.
        frame(board, document, [progressPatch(composing(4, 6640))]);
        expect(metaOf(tile)).toBe('1 agent · composing 4 tool calls · 6,640 chars');

        vi.useRealTimers();
    });

    it('is singular for one call, and never claims a call launched, queued or ran', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const document = documentOf([summary()], [rootSection()]);
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, [progressPatch(composing(1, 512))]);
        expect(metaOf(tile)).toBe('1 agent · composing 1 tool call · 512 chars');

        // The claim this line must never make: a slot is a call the provider OPENED, and
        // partial arguments are never executed (knowledge.md:5864-5865). Counting calls
        // with a launch verb was the incident's own wrong sentence.
        const line = metaOf(tile).toLowerCase();
        for (const forbidden of ['launch', 'queued', 'queue', 'running', 'started', 'execut']) {
            expect(line).not.toContain(forbidden);
        }

        // The explanation repeats the same bound, so a hover cannot talk the reader into
        // the misreading the text avoids.
        expect(titleOf(tile)).toContain('this is progress on the request, not progress on the work');

        vi.useRealTimers();
    });

    it('draws nothing for `idle`, nothing for absent, and nothing on a settled turn', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const document = documentOf([summary()], [rootSection()]);
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        frame(board, document, [progressPatch(composing(3, 1024))]);
        expect(metaOf(tile)).toBe('1 agent · composing 3 tool calls · 1,024 chars');

        // `idle` is the SERVER clearing the line (a commit / retry / done / error landed,
        // turn-projector.ts:3245/3363/3378/3439). The clause goes; no "finished composing"
        // sentence replaces it, because the field says only that the line came down.
        frame(board, document, [progressPatch(idle())]);
        expect(metaOf(tile)).toBe('1 agent');
        expect(titleOf(tile)).toBeNull();

        vi.useRealTimers();
    });

    it('keeps a present-tense claim off a settled turn even if the field never cleared', () => {
        // The documented cut: a section that still carries a live `toolProgress` while the
        // TURN is terminal (a pre-clearing journal, or a document taken between the clear
        // op and the row op). The projector always clears first, so this is defensive —
        // and it is the exact case in which "composing … right now" would be a lie.
        const document = documentOf(
            [summary({ status: 'done', state: 'done', detail: 'local/basalt', updatedAt: T + 400 })],
            [
                rootSection({
                    state: 'done',
                    endedAt: T + 400,
                    toolProgress: composing(4, 6512)
                })
            ]
        );
        const { board } = mount();
        const [tile] = board.hydrateView(document);

        expect(metaOf(tile)).toBe('1 agent · local/basalt');
        expect(metaOf(tile)).not.toContain('composing');
        expect(titleOf(tile)).toBeNull();
    });

    it('paints the identical clause live and on a reload of the same journal', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        // The live door: a row, an open section, then one progress patch.
        const liveDocument = documentOf([summary()], [rootSection()]);
        const live = mount();
        const liveTile = live.board.upsertView(summary(), liveDocument);
        frame(live.board, liveDocument, [progressPatch(composing(4, 6512))]);

        // The reload door: the SAME journal — the section already carries the field,
        // because the ops fold wrote it into journaled section state (../view-state.ts:429).
        const reloadDocument = documentOf([summary()], [rootSection({ toolProgress: composing(4, 6512) })]);
        const reload = mount();
        const [reloadTile] = reload.board.hydrateView(reloadDocument);

        expect(metaOf(reloadTile)).toBe(metaOf(liveTile));
        expect(metaOf(reloadTile)).toBe('1 agent · composing 4 tool calls · 6,512 chars');

        vi.useRealTimers();
    });

    it('takes the clause from a delegated section when the root has nothing to say', () => {
        // The counters are per SECTION (the projector writes them on the record that owns
        // the event), and `.tile-meta` is one line for the whole turn. A root that has
        // committed and a lane that is composing must still print the fact — and it must
        // print THAT lane's numbers, not an invented sum.
        const child: TurnSection = {
            id: 't1:1',
            parentSectionId: 't1:0',
            rank: 'B',
            agent: 'helper',
            agentLabel: 'RH1',
            state: 'streaming',
            startedAt: T,
            nodes: [],
            toolProgress: composing(2, 940)
        };
        const document = documentOf([summary({ sectionCount: 2 })], [rootSection()]);
        const { board } = mount();
        const tile = board.upsertView(summary({ sectionCount: 2 }), document);

        frame(board, document, [{ op: 'section:open', turnId: 't1', section: child }]);

        expect(metaOf(tile)).toBe('2 agents · composing 2 tool calls · 940 chars');

        // The root section's own line wins whenever it carries one — the tile line speaks
        // about the conversation, so its own agent is the first subject.
        frame(board, document, [progressPatch(composing(4, 6512))]);
        expect(metaOf(tile)).toBe('2 agents · composing 4 tool calls · 6,512 chars');
    });
});

describe('the composition line and the quiet line, together', () => {
    it('reads "composing", never "quiet", while progress frames flow', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const document = documentOf([summary()], [rootSection()]);
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        // The transport throttles to one frame per 500 ms (../../transport/openai.ts:1092),
        // so 6 s of composition is a dozen patches — each one an addressed op, each one a
        // frame that reached THIS view (`applyCompiledOps` notes it, turns.ts:9541). The
        // silence line measures exactly that, so it cannot fire while this stream lives.
        for (let attempt = 0; attempt < 12; attempt += 1) {
            vi.advanceTimersByTime(500);
            frame(board, document, [progressPatch(composing(4, 1_000 + attempt * 500))]);

            const line = metaOf(tile);

            expect(line).toContain('composing 4 tool calls ·');
            expect(line).not.toContain('quiet');
            expect(tile.element.dataset.quiet).toBeUndefined();
            expect(titleOf(tile)).not.toContain('no frame has reached this view');
        }

        // 6 s total: past QUIET_AFTER_MS on the wall clock, and the tile still reads live —
        // correctly, because frames are arriving. The final figure is the last frame's.
        expect(metaOf(tile)).toBe('1 agent · composing 4 tool calls · 6,500 chars');

        vi.useRealTimers();
    });

    it('lets the quiet line carry the tile when a relay withholds the whole tool region', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        // The other half of the incident: the relay in front of the workspace buffers the
        // tool region and delivers nothing at all, so no progress op EVER arrives. Absent
        // means "this producer never reported composition" (turn-display.ts:1147) — the
        // tile must invent no clause, and T3's quiet line is what keeps the run honest.
        const document = documentOf([summary()], [rootSection()]);
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        vi.advanceTimersByTime(4_750);
        expect(metaOf(tile)).toBe('1 agent');

        vi.advanceTimersByTime(250);
        expect(metaOf(tile)).toBe('1 agent · still generating · quiet for 5.0s');
        expect(metaOf(tile)).not.toContain('composing');
        expect(tile.element.dataset.quiet).toBe('quiet');
        expect(titleOf(tile)).toContain('no frame has reached this view');

        vi.useRealTimers();
    });

    it('keeps both facts when the composition stops delivering frames, and explains both', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const document = documentOf([summary()], [rootSection()]);
        const { board } = mount();
        const tile = board.upsertView(summary(), document);

        // One progress frame — the single line a flushing relay costs — then the stream
        // stops. The counters are still the last thing the server reported, and the
        // silence since is a separate fact that is ALSO true; dropping either half would
        // restore the picture that got this run aborted.
        frame(board, document, [progressPatch(composing(4, 6512))]);
        vi.advanceTimersByTime(5_000);

        expect(metaOf(tile)).toBe(
            '1 agent · composing 4 tool calls · 6,512 chars · still generating · quiet for 5.0s'
        );
        // The hover answers both questions at once rather than leaving the newer clause
        // unexplained.
        expect(titleOf(tile)).toContain('None of them has launched, been queued or started running');
        expect(titleOf(tile)).toContain('no frame has reached this view');

        // And a frame lands: the quiet line goes on the next paint, the counters advance.
        frame(board, document, [progressPatch(composing(4, 7100))]);
        expect(metaOf(tile)).toBe('1 agent · composing 4 tool calls · 7,100 chars');
        expect(tile.element.dataset.quiet).toBeUndefined();

        vi.useRealTimers();
    });
});
