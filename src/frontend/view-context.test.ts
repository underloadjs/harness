// The context bar's MODEL and GEOMETRY, tested as pure data (T11: R6/R7; T26: R26/R27).
//
// Why a separate file: the bar's riskiest rules are arithmetic, not DOM — the WIDTH floor,
// the two axes (width = recorded time taken, height = recorded characters, capped at two
// line-heights) and the tone mapping. All of them must hold for a turn with THREE HUNDRED
// segments as exactly as they do for three, and none of them is testable through pixels.
// Every fixture here is a hand-written `ContextBlock` (../shared/turn-display.ts:381) spelled
// out field by field, so a contract change in the frozen type fails this file rather than a
// mock.
//
// The expected values are exact, not ranges: `toEqual` on the whole layout object, on the
// whole label string, and on the whole share array. A width of 99px is asserted as 99px, a
// bar of 24px as 24px, and a preview window as the exact string it paints.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-context.test.ts

import type { ContextBlock, TurnDisplay } from '../shared/turn-display';
import {
    CONTEXT_BAR_FALLBACK_WIDTH,
    CONTEXT_BAR_GAP_PX,
    CONTEXT_BAR_LABEL,
    CONTEXT_BAR_LINE_HEIGHT_PX,
    CONTEXT_BAR_MAX_HEIGHT_LINES,
    CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_PX,
    CONTEXT_BAR_TONE_STYLES,
    CONTEXT_BAR_TRACK_HEIGHT_PX,
    CONTEXT_BAR_UNKNOWN_DURATION_PX,
    CONTEXT_TEXT_ELLIPSIS,
    CONTEXT_TAIL_PREVIEW_CHARS,
    contextBarDurationSharesOf,
    contextBarFiguresOf,
    contextBarHeightsOf,
    contextBarOf,
    contextBarReplacesChips,
    contextBarSegmentAt,
    contextBarSharesOf,
    contextBarStatsOf,
    contextBarSummaryOf,
    contextBarToneOf,
    contextBlockCharsOf,
    contextBlockDurationOf,
    contextSegmentLabelOf,
    contextSegmentTitleOf,
    contextTailCaptionOf,
    contextTailLabelOf,
    contextTailOf,
    contextTailShowsProse,
    contextTextSuffixOf,
    formatContextCharCount,
    layoutContextBar
} from './view-context';
import { describe, expect, it } from 'vitest';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Hand-written segments (the frozen contract, spelled out)
// ---------------------------------------------------------------------------

const tool = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
    kind: 'tool',
    id: '0-tool-7',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'read',
    chars: 1204,
    argsChars: 20,
    resultChars: 1184,
    inPrompt: true,
    state: 'ok',
    eventFrom: 7,
    eventTo: 9,
    at: T,
    endedAt: T + 800,
    ...overrides
});

const prompt = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
    kind: 'user',
    id: '0-user-prompt',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'prompt',
    chars: 42,
    inPrompt: true,
    at: T - 5000,
    ...overrides
});

const think = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
    kind: 'reasoning',
    id: '0-reasoning-3',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'reasoning',
    chars: 300,
    inPrompt: false,
    eventFrom: 3,
    eventTo: 4,
    at: T,
    endedAt: T + 1200,
    ...overrides
});

const displayOf = (sections: TurnDisplay['sections']): TurnDisplay => ({ turnId: 't1', sections });

const section = (id: string, context: ContextBlock[] | undefined): TurnDisplay['sections'][number] =>
    ({
        id,
        role: id === 't1:0' ? 'primary' : 'subagent',
        agent: 'instruct',
        agentLabel: 'RR1',
        state: 'done',
        nodes: [],
        ...(context === undefined ? {} : { context })
    }) as TurnDisplay['sections'][number];

// ---------------------------------------------------------------------------
// Assembly: the server ordered it, the renderer repeats it
// ---------------------------------------------------------------------------

describe('contextBarOf', () => {
    it('concatenates every section in document order and every block in section order', () => {
        // A NESTED section listed FIRST is still first: the projector's `sections` order is
        // the transcript's order, and a bar that sorted by id or by kind would reorder the
        // conversation (turn-display.ts:334 — "a renderer never sorts").
        const model = contextBarOf(
            displayOf([
                section('t1:1', [tool({ id: '1-tool-2', sectionId: 't1:1' }), tool({ id: '1-tool-9', sectionId: 't1:1', state: 'error' })]),
                section('t1:0', [prompt(), think(), tool({ id: '0-tool-7' })])
            ])
        );

        expect(model.blocks.map((block) => block.id)).toEqual([
            '1-tool-2',
            '1-tool-9',
            '0-user-prompt',
            '0-reasoning-3',
            '0-tool-7'
        ]);
        expect(model.turnId).toBe('t1');
        expect(model.available).toBe(true);
    });

    it('totals the exact characters per kind, and separates what the prompt never carried', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));

        expect(model.totalChars).toBe(1546);
        // 300 characters of thinking are recorded but never replayed (inPrompt false).
        expect(model.unpromptedChars).toBe(300);
        expect(model.counts).toEqual({ user: 1, system: 0, reasoning: 1, assistant: 0, tool: 1 });
        expect(model.charsByKind).toEqual({ user: 42, system: 0, reasoning: 300, assistant: 0, tool: 1204 });
    });

    it('keeps ABSENT context and an EMPTY bar as different answers', () => {
        // A pre-T9 record / a frame that says nothing: no bar, keep the chips.
        const legacy = contextBarOf(displayOf([section('t1:0', undefined), section('t1:1', undefined)]));
        expect(legacy.available).toBe(false);
        expect(legacy.blocks).toEqual([]);
        expect(contextBarReplacesChips(legacy)).toBe(false);

        // `[]` is the server's authoritative "this section recorded no context".
        const empty = contextBarOf(displayOf([section('t1:0', [])]));
        expect(empty.available).toBe(true);
        expect(empty.blocks).toEqual([]);
        // An empty bar never replaces real chips: it has nothing to stand in for.
        expect(contextBarReplacesChips(empty)).toBe(false);

        expect(contextBarReplacesChips(contextBarOf(displayOf([section('t1:0', [tool()])])))).toBe(true);
    });

    it('answers an absent tree as nothing-to-show, never as an empty bar', () => {
        const model = contextBarOf(undefined);

        expect(model).toEqual({
            turnId: '',
            available: false,
            blocks: [],
            totalChars: 0,
            unpromptedChars: 0,
            counts: { user: 0, system: 0, reasoning: 0, assistant: 0, tool: 0 },
            charsByKind: { user: 0, system: 0, reasoning: 0, assistant: 0, tool: 0 },
            // T26 (R27): no segments means no time figure at all — NOT `0ms`, which would be
            // a claim about the turn rather than the absence of one.
            totalDurationMs: undefined,
            durationsUnknown: 0
        });
    });

    it('totals the recorded spans for the horizontal axis and counts the unmeasured ones', () => {
        // 1,200ms of thinking + 800ms of tool, and a prompt the record never bracketed: the
        // strip's width axis has one total (2,000ms) and one honest exception (1 segment).
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));

        expect(model.totalDurationMs).toBe(2_000);
        expect(model.durationsUnknown).toBe(1);

        // Every span 0ms IS data: the total is exactly 0, and nothing is "unknown".
        const instant = contextBarOf(displayOf([section('t1:0', [tool({ endedAt: T }), tool({ endedAt: T })])]));

        expect(instant.totalDurationMs).toBe(0);
        expect(instant.durationsUnknown).toBe(0);

        // And a turn made only of unbracketed blocks reports undefined, not a fabricated 0.
        const unbracketed = contextBarOf(displayOf([section('t1:0', [prompt(), prompt({ id: 'p2' })])]));

        expect(unbracketed.totalDurationMs).toBeUndefined();
        expect(unbracketed.durationsUnknown).toBe(2);
    });

    it('drops a duplicated section+id rather than counting one block twice', () => {
        // Ids are unique within a turn by contract; a replayed/malformed frame that repeats
        // one must not double its characters or mint a second segment.
        const model = contextBarOf(displayOf([section('t1:0', [tool(), tool(), think()])]));

        expect(model.blocks.map((block) => block.id)).toEqual(['0-tool-7', '0-reasoning-3']);
        expect(model.totalChars).toBe(1504);
    });

    it('separates the same block id in two different sections', () => {
        const model = contextBarOf(
            displayOf([section('t1:0', [tool({ id: 'x' })]), section('t1:1', [tool({ id: 'x', sectionId: 't1:1' })])])
        );

        expect(model.blocks).toHaveLength(2);
        expect(model.totalChars).toBe(2408);
    });
});

// ---------------------------------------------------------------------------
// Counts and spans: the server's figures, never a measurement of a preview
// ---------------------------------------------------------------------------

describe('contextBlockCharsOf', () => {
    it('reads the exact figure, and only falls back to the two parts it is made of', () => {
        expect(contextBlockCharsOf(tool({ chars: 0, argsChars: 0, resultChars: 0 }))).toBe(0);
        expect(contextBlockCharsOf(tool({ chars: 12_004 }))).toBe(12_004);

        // A malformed frame (no `chars`): the fallback is the OTHER exact server figures,
        // never a length the client measured off a bounded preview.
        expect(contextBlockCharsOf({ ...tool(), chars: undefined } as unknown as ContextBlock)).toBe(1204);
        expect(contextBlockCharsOf({ ...tool(), chars: Number.NaN } as unknown as ContextBlock)).toBe(1204);
        // A negative figure is malformed, and the two named parts are the better answer —
        // they are what `chars` is defined as for a tool, so the bar keeps its proportion
        // instead of collapsing the segment to nothing.
        expect(contextBlockCharsOf({ ...tool(), chars: -8 } as unknown as ContextBlock)).toBe(1204);
    });
});

describe('contextBlockDurationOf', () => {
    it('prefers the server measured span over the stamp arithmetic', () => {
        // `durationMs` is the projector's own measurement; `endedAt - at` is its fallback.
        expect(contextBlockDurationOf({ ...tool(), durationMs: 900 } as ContextBlock)).toBe(900);
        expect(contextBlockDurationOf(tool())).toBe(800);
    });

    it('reports nothing rather than inventing a span', () => {
        expect(contextBlockDurationOf(tool({ endedAt: undefined }))).toBeUndefined();
        expect(contextBlockDurationOf(tool({ at: undefined }))).toBeUndefined();
        // A clock that went backwards is not a duration.
        expect(contextBlockDurationOf(tool({ at: T, endedAt: T - 10 }))).toBeUndefined();
        // A junk measured figure falls through to the stamps, not to 0.
        expect(contextBlockDurationOf({ ...tool(), durationMs: Number.NaN } as ContextBlock)).toBe(800);
        expect(contextBlockDurationOf({ ...tool(), durationMs: -5 } as ContextBlock)).toBe(800);
    });
});

describe('formatContextCharCount', () => {
    it('groups with the pinned en-US separator and never rounds up', () => {
        expect(formatContextCharCount(0)).toBe('0');
        expect(formatContextCharCount(999)).toBe('999');
        expect(formatContextCharCount(1204)).toBe('1,204');
        expect(formatContextCharCount(1_234_567)).toBe('1,234,567');
        expect(formatContextCharCount(-5)).toBe('0');
        expect(formatContextCharCount(Number.NaN)).toBe('0');
        expect(formatContextCharCount(12.7)).toBe('12');
    });
});

// ---------------------------------------------------------------------------
// Tone: the server decided kind/state, the renderer only colours
// ---------------------------------------------------------------------------

describe('contextBarToneOf', () => {
    it('maps every kind/state pair in the contract exactly once', () => {
        expect(contextBarToneOf(tool({ state: 'ok' }))).toBe('ok');
        expect(contextBarToneOf(tool({ state: 'error' }))).toBe('error');
        expect(contextBarToneOf(tool({ state: 'cancelled' }))).toBe('error');
        expect(contextBarToneOf(tool({ state: 'running' }))).toBe('running');
        // An absent state is "not settled yet" (turn-display.ts:456), never a re-derivation.
        expect(contextBarToneOf(tool({ state: undefined }))).toBe('running');

        expect(contextBarToneOf(think())).toBe('reasoning');
        // Thinking stays amber even when it belongs to a failed round: only a TOOL settles red.
        expect(contextBarToneOf(think({ state: 'error' }))).toBe('reasoning');

        expect(contextBarToneOf(prompt())).toBe('neutral');
        expect(contextBarToneOf(tool({ kind: 'system', name: 'instructions', state: 'error' }))).toBe('neutral');
        expect(contextBarToneOf(tool({ kind: 'assistant', name: 'answer', state: 'error' }))).toBe('neutral');
    });

    it('paints each tone with the palette styles.css declares', () => {
        // The canvas cannot read a class, so these hexes are the `:root` values duplicated
        // on purpose — and `context-bar-style.test.ts` pins the same pairs in the sheet,
        // which is what makes the two surfaces unable to drift.
        expect(CONTEXT_BAR_TONE_STYLES).toEqual({
            ok: { color: '#4ade80', cssVar: '--ok', alpha: 1 },
            error: { color: '#f87171', cssVar: '--danger', alpha: 1 },
            running: { color: '#4ade80', cssVar: '--ok', alpha: 0.45 },
            reasoning: { color: '#fbbf24', cssVar: '--warn', alpha: 1 },
            neutral: { color: '#d8deea', cssVar: '--text', alpha: 1 }
        });
    });
});

// ---------------------------------------------------------------------------
// Labels: name, type, time taken, character count — and never the word "token"
// ---------------------------------------------------------------------------

describe('contextSegmentTitleOf', () => {
    it('states every metadata field the segment carries', () => {
        expect(contextSegmentTitleOf(tool())).toBe(
            'read · tool · ok · 1,204 characters · args 20 + result 1,184 · 800ms'
        );
        // T26 (R27): the prompt has no recorded span, and the tooltip SAYS so — the baseline
        // width it paints would otherwise read as a measurement of something.
        expect(contextSegmentTitleOf(prompt())).toBe('prompt · user · 42 characters · time not recorded');
        expect(contextSegmentTitleOf(think())).toBe(
            'reasoning · reasoning · 300 characters · 1.2s · not replayed into the prompt'
        );
        expect(contextSegmentTitleOf(tool({ state: 'error', name: 'bash' }))).toBe(
            'bash · tool · error · 1,204 characters · args 20 + result 1,184 · 800ms'
        );
        // A call still streaming: `chars` is every argument byte recorded SO FAR
        // (turn-display.ts:433), so the server's own figure is 20, there is no result half
        // to name, and there is no settle stamp to build a span from.
        expect(
            contextSegmentTitleOf(tool({ state: 'running', chars: 20, resultChars: undefined, endedAt: undefined, name: 'write' }))
        ).toBe('write · tool · running · 20 characters · args 20, no result recorded · time not recorded');
        // A result-only recording names the part it does hold.
        expect(contextSegmentTitleOf(tool({ argsChars: undefined }))).toBe(
            'read · tool · ok · 1,204 characters · result 1,184 · 800ms'
        );
        // A non-tool block marked not-in-prompt still gets the honest note.
        expect(contextSegmentTitleOf(prompt({ inPrompt: false }))).toBe(
            'prompt · user · 42 characters · time not recorded · not replayed into the prompt'
        );
    });

    it('prints a measured 0ms as data, never as "time not recorded"', () => {
        // R27: an instant call is a REAL measurement. Only the absence of one is labelled.
        expect(contextSegmentTitleOf(tool({ at: T, endedAt: T }))).toBe(
            'read · tool · ok · 1,204 characters · args 20 + result 1,184 · 0ms'
        );
        expect(contextSegmentTitleOf(tool({ at: T, endedAt: undefined, durationMs: 0 }))).toBe(
            'read · tool · ok · 1,204 characters · args 20 + result 1,184 · 0ms'
        );
    });

    it('numbers the segment for the accessible name without changing the figures', () => {
        expect(contextSegmentLabelOf(tool(), 1, 3)).toBe(
            '2 of 3 · read · tool · ok · 1,204 characters · args 20 + result 1,184 · 800ms'
        );
    });
});

describe('contextBarSummaryOf', () => {
    it('explains both axes, names the unit, and totals the recorded time', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));

        expect(contextBarSummaryOf(model)).toBe(
            `${CONTEXT_BAR_LABEL} · 3 segments · 1,546 characters · 2.0s of recorded time` +
                ` · 1 segment has no recorded time · 300 characters not replayed into the prompt`
        );

        // No reasoning share => no trailing clause, and ONE segment says "segment". The
        // prompt's unbracketed span still gets its own honest clause.
        expect(contextBarSummaryOf(contextBarOf(displayOf([section('t1:0', [prompt()])])))).toBe(
            `${CONTEXT_BAR_LABEL} · 1 segment · 42 characters · 1 segment has no recorded time`
        );

        // The authoritative empty bar says so in the same voice.
        expect(contextBarSummaryOf(contextBarOf(displayOf([section('t1:0', [])])))).toBe(
            `${CONTEXT_BAR_LABEL} · no recorded context`
        );
        expect(contextBarSummaryOf(contextBarOf(undefined))).toBe(`${CONTEXT_BAR_LABEL} · no recorded context`);
    });

    it('states the axes in words, because the visible caption no longer does', () => {
        // R27: the strip is two-dimensional, and a reader who cannot see it has to be told
        // which way each dimension runs. The words are on the group's accessible name.
        expect(CONTEXT_BAR_LABEL).toContain('width is time taken');
        expect(CONTEXT_BAR_LABEL).toContain('height is recorded characters');
        // R24 keeps the UNIT in the wording: a character strip must never be mistaken for a
        // token counter or a context-window gauge.
        expect(CONTEXT_BAR_LABEL).toContain('characters');
    });

    it('never calls a character count a token count', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));
        const text = `${contextBarSummaryOf(model)} ${contextSegmentTitleOf(model.blocks[2])}`;

        expect(text).not.toMatch(/token/i);
    });
});

describe('contextBarStatsOf', () => {
    // T22 (R24): this is the ONLY bar text the reader sees, and since R24 it is the segment
    // COUNT only. The character totals a long session printed under every turn were numbers
    // nobody acted on; they live on the tooltip, the segment detail and the accessible name
    // (`contextBarFiguresOf`), which is why a screen reader has lost nothing.
    it('prints the count with no label wording and no character totals', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));

        expect(contextBarStatsOf(model)).toBe('3 segments');

        // ONE segment says "segment" — the singular is a stated requirement, not an accident.
        expect(contextBarStatsOf(contextBarOf(displayOf([section('t1:0', [prompt()])])))).toBe('1 segment');

        // 2 and 12 both pluralize, and grouping never leaks into a count.
        expect(contextBarStatsOf(contextBarOf(displayOf([section('t1:0', [prompt(), think()])])))).toBe('2 segments');
        expect(
            contextBarStatsOf(
                contextBarOf(
                    displayOf([
                        section(
                            't1:0',
                            Array.from({ length: 12 }, (_, index) => tool({ id: `0-tool-${index}`, chars: index + 1 }))
                        )
                    ])
                )
            )
        ).toBe('12 segments');

        // The authoritative empty bar, and a tree with nothing in it at all.
        expect(contextBarStatsOf(contextBarOf(displayOf([section('t1:0', [])])))).toBe('no recorded context');
        expect(contextBarStatsOf(contextBarOf(undefined))).toBe('no recorded context');
    });

    it('keeps the label phrase and the character figures out of the visible line', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));
        const stats = contextBarStatsOf(model);

        // The count is the whole line: no heading, no totals, and never the word "token".
        expect(stats).toBe('3 segments');
        expect(stats).not.toContain('characters');
        expect(stats).not.toContain(CONTEXT_BAR_LABEL);
        expect(stats).not.toMatch(/token/i);
    });
});

describe('contextBarFiguresOf', () => {
    // R24 moved these figures off the visible line, and they are still the ACCESSIBLE
    // name's content: `contextBarSummaryOf` is the label phrase plus exactly this string,
    // so the unit ("characters", never tokens), the recorded TIME total and the not-replayed
    // note survive. T26 (R27) added the two time clauses, because the horizontal axis is the
    // one a reader cannot infer from a picture they cannot see.
    it('states the count, the exact character total, the recorded time and the thinking share', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));

        expect(contextBarFiguresOf(model)).toBe(
            '3 segments · 1,546 characters · 2.0s of recorded time · 1 segment has no recorded time' +
                ' · 300 characters not replayed into the prompt'
        );

        // A strip where EVERY span was recorded says the total and never the exception.
        expect(
            contextBarFiguresOf(contextBarOf(displayOf([section('t1:0', [think(), tool()])])))
        ).toBe('2 segments · 1,504 characters · 2.0s of recorded time · 300 characters not replayed into the prompt');

        // One segment pluralizes as "segment", and no unprompted characters => no clause.
        expect(contextBarFiguresOf(contextBarOf(displayOf([section('t1:0', [prompt()])])))).toBe(
            '1 segment · 42 characters · 1 segment has no recorded time'
        );

        // Several unbracketed segments pluralize the same way.
        expect(
            contextBarFiguresOf(contextBarOf(displayOf([section('t1:0', [prompt(), prompt({ id: 'p2' })])])))
        ).toBe('2 segments · 84 characters · 2 segments have no recorded time');

        // The empty bar keeps the same wording the caption uses, so the two never disagree.
        expect(contextBarFiguresOf(contextBarOf(displayOf([section('t1:0', [])])))).toBe('no recorded context');
        expect(contextBarFiguresOf(contextBarOf(undefined))).toBe('no recorded context');
    });

    it('is the accessible name with the label phrase in front, and nothing else added', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));

        expect(contextBarSummaryOf(model)).toBe(`${CONTEXT_BAR_LABEL} · ${contextBarFiguresOf(model)}`);
        expect(contextBarSummaryOf(model)).not.toMatch(/token/i);
    });
});

// ---------------------------------------------------------------------------
// The ONE current tail block (T22, R23)
// ---------------------------------------------------------------------------

describe('contextTailOf', () => {
    // Hand-written `DisplayNode`s in the shape the projector emits: a reasoning window whose
    // wire text is bounded at DISPLAY_NODE_PREVIEW_CHARS with the exact `chars` beside it
    // (`redacted: true` states that it is a preview), and the current answer, which the wire
    // carries IN FULL because `TurnSection.answerNodeId` designates it
    // (src/shared/turn-display.ts:776-817).
    const preview = 'a bounded preview of the thinking window';
    const answerText = 'the complete recorded answer, every line of it';

    const thinking = () =>
        ({ kind: 'reasoning', id: '3', text: preview, chars: 1_234, redacted: true, share: 4.2 }) as never;

    const answer = (overrides: Record<string, unknown> = {}) =>
        ({
            kind: 'text',
            id: '5',
            text: answerText,
            chars: answerText.length,
            committed: true,
            ...overrides
        }) as never;

    const step = () =>
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
            detail: { stepId: '7', hasResult: true, truncated: true }
        }) as never;

    const notice = () =>
        ({ kind: 'notice', id: '9', tone: 'wake', text: 'pending tools finished · continuing' }) as never;

    const flowOf = (
        nodes: never[],
        context: ContextBlock[] | undefined,
        overrides: Record<string, unknown> = {}
    ) => ({ ...section('t1:0', context), nodes, ...overrides }) as never;

    const answerBlock = (chars: number) =>
        prompt({ id: '0-assistant-5', kind: 'assistant', name: 'answer', chars, at: undefined });

    it('names the last reasoning window as the tail and marks the wire text as a preview', () => {
        // Thinking IS the newest block, so it is the one body the section prints. This
        // fixture sends NO `section.tail`, which is the pre-T23 producer: the fallback reads
        // the recorded order itself and reports `designated: false`.
        expect(contextTailOf(flowOf([thinking()], [prompt()]))).toEqual({
            kind: 'reasoning',
            nodeId: '3',
            // No `reasoning` segment in this list => the figure comes from the node's own
            // exact `chars`, which is the same invariant-5 number.
            blockId: undefined,
            text: preview,
            // T26 (R26): 40 characters fit the window, so the painted body is the wire text
            // verbatim — the suffix rule adds no marker to a body it did not have to cut.
            renderText: preview,
            shownChars: preview.length,
            chars: 1_234,
            truncated: true,
            designated: false
        });
    });

    it('paints the LATEST window of a prose body longer than the bound (R26)', () => {
        // A designated carrier streams the WHOLE text, so this is exactly what a live thinking
        // window looks like: 530 recorded characters, 320 of them painted, and the 320 are the
        // NEWEST. The old behaviour kept the first 320, which is the static-text complaint.
        const streamed = `${'head-'.repeat(10)}${'t'.repeat(480)}`;

        expect(streamed.length).toBe(530);

        const tail = contextTailOf(
            flowOf([{ kind: 'reasoning', id: '3', text: streamed, chars: streamed.length } as never], [think({ chars: streamed.length })])
        );

        expect(tail?.truncated).toBe(false);
        expect(tail?.chars).toBe(530);
        expect(tail?.shownChars).toBe(CONTEXT_TAIL_PREVIEW_CHARS);
        // The painted string is the marker plus the last `CONTEXT_TAIL_PREVIEW_CHARS` units.
        expect(tail?.renderText).toBe(`${CONTEXT_TEXT_ELLIPSIS}${streamed.slice(-CONTEXT_TAIL_PREVIEW_CHARS)}`);
        expect(tail?.text).toBe(streamed);
        // And the caption states the window, not the whole.
        expect(contextTailCaptionOf(tail!)).toBe(
            `thinking · showing ${CONTEXT_TAIL_PREVIEW_CHARS} of 530 characters — click the segment for the exact text`
        );
    });

    it('takes the exact figure and the provenance id from the section context list', () => {
        const tail = contextTailOf(flowOf([thinking()], [prompt(), think({ chars: 2_048 })]));

        expect(tail?.blockId).toBe('0-reasoning-3');
        expect(tail?.chars).toBe(2_048);
        expect(tail?.truncated).toBe(true);
    });

    it('names the current answer as the assistant tail and says it is whole', () => {
        const tail = contextTailOf(
            flowOf([thinking(), answer()], [prompt(), think(), answerBlock(answerText.length)])
        );

        // The newest content block is the answer, so the thinking window is history (R23).
        expect(tail).toEqual({
            kind: 'assistant',
            nodeId: '5',
            blockId: '0-assistant-5',
            text: answerText,
            renderText: answerText,
            shownChars: answerText.length,
            chars: answerText.length,
            truncated: false,
            designated: false
        });
    });

    it('hides the body entirely once a recorded call is the newest block', () => {
        // LEGACY wire only: a producer that named no tail also sent no full call payload, so
        // the strip stays the way a call is shown and the block before it prints nothing.
        expect(contextTailOf(flowOf([thinking(), step()], [prompt(), think()]))).toBeUndefined();
        expect(contextTailOf(flowOf([answer(), step()], [prompt(), answerBlock(answerText.length)]))).toBeUndefined();
    });

    it('lets a notice or an owner question sit after the tail without erasing it', () => {
        // Neither is model content: a wake line or an open owner question must not delete
        // the block the reader is looking at.
        expect(contextTailOf(flowOf([thinking(), notice()], [think()]))?.nodeId).toBe('3');
        expect(contextTailOf(flowOf([answer(), notice()], []))?.nodeId).toBe('5');
    });

    it('reports no tail for an empty flow, a notice-only flow or no section at all', () => {
        expect(contextTailOf(flowOf([], []))).toBeUndefined();
        expect(contextTailOf(flowOf([notice()], []))).toBeUndefined();
        expect(contextTailOf(undefined)).toBeUndefined();
    });

    it('treats a superseded answer the wire bounded as a preview, not as full text', () => {
        // Defensive: the projector redacts a SUPERSEDED node, and a newer block then hides
        // it. A frame that states it the other way is still reported honestly.
        const tail = contextTailOf(flowOf([answer({ redacted: true, chars: 900, text: 'first 320 characters' })], []));

        expect(tail?.truncated).toBe(true);
        expect(tail?.chars).toBe(900);
    });

    it('never fetches, and never measures a preview as the whole block', () => {
        // The figure printed for a bounded round is the server's `chars`, and `text` stays
        // what the wire carried: a 40-character preview of a 1,234-character window.
        const tail = contextTailOf(flowOf([thinking()], [prompt(), think({ chars: 1_234 })]));

        expect(tail?.text).toBe(preview);
        expect(tail?.text.length).toBe(40);
        expect(tail?.chars).toBe(1_234);
    });
});

// ---------------------------------------------------------------------------
// The tail the SERVER designated (T23, R23)
// ---------------------------------------------------------------------------

describe('contextTailOf, from the server designation', () => {
    // The same fixture builder the fallback block uses: one section, its recorded node
    // order, its segments, and here ALSO its `tail` designation — the field the server
    // started sending for R23.
    const flowOf = (
        nodes: never[],
        context: ContextBlock[] | undefined,
        overrides: Record<string, unknown> = {}
    ) => ({ ...section('t1:0', context), nodes, ...overrides }) as never;

    const callArgs = '{"path":"notes.md","query":"what changed"}';
    const callResult = 'the whole recorded file body, every line of it';

    // The step node exactly as the compact wire sends it: bounded previews, the settled
    // state, and the detail pointer. The full payload is NOT here — it rides the
    // designation, which is the whole point of the one-block rule.
    const callNode = (overrides: Record<string, unknown> = {}) =>
        ({
            kind: 'tool',
            id: '7',
            turnId: 't1',
            sectionId: 't1:0',
            callId: 'call-1',
            name: 'read',
            argsPreview: `${callArgs.slice(0, 20)}…`,
            preview: 'a bounded one-line result',
            state: 'ok',
            outcome: 'completed',
            startedAt: T,
            endedAt: T + 800,
            durationMs: 800,
            panels: [{ id: 'p0', slot: 'right', title: 'Matches', blocks: [], truncated: true, totalPanels: 2 }],
            media: [{ id: 'm0', kind: 'image', name: 'chart.png', mime: 'image/png', size: 1200 }],
            detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: true },
            ...overrides
        }) as never;

    const callBlock = (overrides: Partial<ContextBlock> = {}) =>
        tool({ id: '0-tool-7', chars: callArgs.length + callResult.length, argsChars: callArgs.length, resultChars: callResult.length, ...overrides });

    const designation = (overrides: Record<string, unknown> = {}) =>
        ({
            kind: 'tool',
            nodeId: '7',
            blockId: '0-tool-7',
            chars: callArgs.length + callResult.length,
            truncated: false,
            args: callArgs,
            result: callResult,
            ...overrides
        }) as never;

    it('applies the designation instead of reading the order itself', () => {
        const tail = contextTailOf(
            flowOf([callNode()], [prompt(), callBlock()], { tail: designation() })
        );

        expect(tail).toEqual({
            kind: 'tool',
            nodeId: '7',
            blockId: '0-tool-7',
            // The exact recorded figures come from the SEGMENT (invariant 5); the designation
            // decides which block prints, not what the numbers say.
            text: '',
            // T26 (R26): a recorded CALL keeps its bytes whole (T25), so the painted length is
            // the payload length and `renderText` is unused — the suffix window is a prose rule.
            renderText: '',
            shownChars: callArgs.length + callResult.length,
            chars: callArgs.length + callResult.length,
            truncated: false,
            designated: true,
            tool: {
                name: 'read',
                state: 'ok',
                args: callArgs,
                result: callResult,
                durationMs: 800,
                argsChars: callArgs.length,
                resultChars: callResult.length,
                panelCount: 1,
                mediaCount: 1,
                hasResult: true
            }
        });
        // The tile's Copy pointer and the strip's segment both still resolve: the body was
        // addressed by id, never matched by name or position.
        expect(contextTailLabelOf(tail as never)).toBe('read');
        expect(contextTailCaptionOf(tail as never)).toBe(
            `read · ok · 800ms · ${callArgs.length + callResult.length} characters` +
                ` · args ${callArgs.length} + result ${callResult.length} · 1 panel · 1 media`
        );
    });

    it('honours a designation that is NOT the last node, because the server decided it', () => {
        // The projector may legitimately designate an older node (a discarded attempt handed
        // the tail back). The client applies the name, it does not re-derive "the last one".
        const tail = contextTailOf(
            flowOf(
                [{ kind: 'text', id: '5', text: 'the answer', chars: 10, committed: true } as never, callNode()],
                [prompt(), answerish(), callBlock()],
                { tail: { kind: 'assistant', nodeId: '5', blockId: '0-assistant-5', chars: 10, truncated: false } }
            )
        );

        expect(tail).toMatchObject({ kind: 'assistant', nodeId: '5', designated: true, text: 'the answer', chars: 10 });
        // ...and with no designation the same document resolves by order, with no call body.
        expect(contextTailOf(flowOf([callNode()], [prompt(), callBlock()]))).toBeUndefined();
    });

    it('shows a running call with its request only, and never a duration it does not have', () => {
        const tail = contextTailOf(
            flowOf(
                [callNode({ state: 'running', outcome: undefined, endedAt: undefined, durationMs: undefined, preview: undefined, panels: undefined, media: undefined, detail: { stepId: '7', hasResult: false, truncated: false } })],
                [prompt(), callBlock({ state: 'running', chars: callArgs.length, argsChars: callArgs.length, resultChars: undefined, endedAt: undefined, durationMs: undefined })],
                { tail: designation({ result: undefined, chars: callArgs.length }) }
            )
        );

        expect(tail?.tool).toMatchObject({
            state: 'running',
            args: callArgs,
            result: undefined,
            durationMs: undefined,
            argsChars: callArgs.length,
            resultChars: undefined,
            hasResult: false
        });
        expect(contextTailCaptionOf(tail as never)).toBe(
            // R27: a call that has not settled has no span yet, and the caption says so in
            // words instead of leaving the reader to infer it from a baseline-width segment.
            `read · running · time not recorded · ${callArgs.length} characters · args ${callArgs.length} · no result recorded yet`
        );
    });

    it('states the payload cap beside the exact recorded length', () => {
        const tail = contextTailOf(
            flowOf([callNode()], [prompt(), callBlock()], {
                tail: designation({ truncated: true, args: callArgs, result: callResult.slice(0, 10) })
            })
        );

        // The designation says the wire carries less than the record holds. The figure stays
        // the EXACT one, so the reader is told how much is missing instead of trusting a
        // prefix (and the segment's click still answers with every byte).
        expect(tail?.truncated).toBe(true);
        expect(tail?.chars).toBe(callArgs.length + callResult.length);
        expect(contextTailCaptionOf(tail as never)).toBe(
            `read · ok · 800ms · showing ${callArgs.length + 10} of ${callArgs.length + callResult.length} characters` +
                ' · 1 panel · 1 media'
        );
    });

    it('carries a designated thinking window whole, and a designated answer as prose', () => {
        const whole = 'every character of this thinking window, streamed in full';

        expect(
            contextTailOf(
                flowOf(
                    [{ kind: 'reasoning', id: '3', text: whole, chars: whole.length } as never],
                    [prompt(), think({ id: '0-reasoning-3', chars: whole.length })],
                    { tail: { kind: 'reasoning', nodeId: '3', blockId: '0-reasoning-3', chars: whole.length, truncated: false } }
                )
            )
        ).toEqual({
            kind: 'reasoning',
            nodeId: '3',
            blockId: '0-reasoning-3',
            text: whole,
            renderText: whole,
            shownChars: whole.length,
            chars: whole.length,
            truncated: false,
            designated: true
        });

        // A prose designation whose node the wire bounded is still reported honestly: the
        // server's marker wins, because that is what the bytes on screen ARE.
        const bounded = contextTailOf(
            flowOf(
                [{ kind: 'reasoning', id: '3', text: 'a preview', chars: 900, redacted: true } as never],
                [prompt(), think({ id: '0-reasoning-3', chars: 900 })],
                { tail: { kind: 'reasoning', nodeId: '3', blockId: '0-reasoning-3', chars: 900, truncated: false } }
            )
        );

        expect(bounded).toMatchObject({ truncated: true, chars: 900, designated: true });
    });

    it('falls back to the recorded order when the designation names a node that is gone', () => {
        // Defensive: an out-of-order or stale frame cannot strand the body. The order rule
        // reproduces T22's answer, and it never claims a call payload it was not given.
        const tail = contextTailOf(
            flowOf(
                [{ kind: 'reasoning', id: '3', text: 'a thought', chars: 9 } as never],
                [prompt(), think({ id: '0-reasoning-3', chars: 9 })],
                { tail: { kind: 'reasoning', nodeId: 'gone', blockId: '0-reasoning-3', chars: 9, truncated: false } }
            )
        );

        expect(tail).toMatchObject({ kind: 'reasoning', nodeId: '3', designated: false });
    });

    const answerish = () =>
        prompt({ id: '0-assistant-5', kind: 'assistant', name: 'answer', chars: 10, at: undefined });

    it('never designates the prompt or the instructions, so they never print at the tail', () => {
        // The two stated exceptions (R23): a section whose only recorded text is the prompt
        // and its instructions has NO body at all, however long either one is.
        expect(contextTailOf(flowOf([], [prompt({ chars: 90_000 }), prompt({ id: '0-system-instructions', kind: 'system', name: 'instructions', chars: 4_000 })]))).toBeUndefined();
        // And the prose of a designated answer still owns the flow block, not this body.
        const tail = contextTailOf(
            flowOf([{ kind: 'text', id: '5', text: 'the answer', chars: 10, committed: true } as never], [prompt()], {
                tail: { kind: 'assistant', nodeId: '5', chars: 10, truncated: false }
            })
        );

        expect(contextTailShowsProse(tail, '5')).toBe(true);
        expect(contextTailShowsProse(tail, '3')).toBe(false);
    });
});

describe('contextTailCaptionOf', () => {
    // A hand-written tail now states BOTH figures, which is exactly the pair the caption
    // reports (T26, R26): `chars` is the invariant-5 recorded length, `shownChars` is the
    // length the PANE paints — whether the wire bounded it or the render window did.
    const preview = 'a bounded preview of the thinking window';
    const wholeText = 'every character of this window, streamed in full';

    const tailOf = (overrides: Record<string, unknown> = {}) =>
        ({
            kind: 'reasoning',
            nodeId: '3',
            blockId: '0-reasoning-3',
            text: preview,
            renderText: `${CONTEXT_TEXT_ELLIPSIS}${preview}`,
            shownChars: preview.length,
            chars: 1_234,
            truncated: true,
            ...overrides
        }) as never;

    const whole = (chars: number) => ({
        truncated: false,
        chars,
        text: 'w'.repeat(chars),
        renderText: 'w'.repeat(chars),
        shownChars: chars
    });

    it('states the exact length, and how much of a bounded round is on screen', () => {
        expect(contextTailCaptionOf(tailOf())).toBe(
            'thinking · showing 40 of 1,234 characters — click the segment for the exact text'
        );

        // The designated carrier needs no hedge: what prints IS the whole block.
        expect(contextTailCaptionOf(tailOf(whole(1_234)))).toBe('thinking · 1,234 characters');
        expect(contextTailCaptionOf(tailOf({ kind: 'assistant', ...whole(46) }))).toBe('answer · 46 characters');
    });

    it('reports the render WINDOW as a preview, even when the wire sent the whole body', () => {
        // R26: the pane caps a long streaming window at `CONTEXT_TAIL_PREVIEW_CHARS` so the
        // reader sees the newest lines. The caption follows the painted text, never the wire,
        // so a windowed body can never claim to be whole.
        const streamed = 's'.repeat(530);

        expect(
            contextTailCaptionOf(
                tailOf({
                    truncated: false,
                    chars: 530,
                    text: streamed,
                    renderText: `${CONTEXT_TEXT_ELLIPSIS}${streamed.slice(-CONTEXT_TAIL_PREVIEW_CHARS)}`,
                    shownChars: CONTEXT_TAIL_PREVIEW_CHARS
                })
            )
        ).toBe(
            `thinking · showing ${CONTEXT_TAIL_PREVIEW_CHARS} of 530 characters — click the segment for the exact text`
        );
    });

    it('never calls a character count a token count, and never claims a preview is whole', () => {
        const bounded = contextTailCaptionOf(tailOf());

        expect(bounded).not.toMatch(/token/i);
        expect(bounded).toContain('showing 40 of 1,234');
        expect(bounded).not.toBe('thinking · 1,234 characters');
    });
});

describe('contextTailShowsProse', () => {
    it('prints the tail answer and nothing else, while an undefined tail prints nothing', () => {
        const tail = contextTailOf({
            ...section('t1:0', [prompt()]),
            nodes: [{ kind: 'text', id: '5', text: 'a', chars: 1, committed: true }]
        } as never);

        expect(contextTailShowsProse(tail, '5')).toBe(true);
        // An earlier window of the SAME section is a segment now (R23).
        expect(contextTailShowsProse(tail, '2')).toBe(false);
        // A thinking tail owns the body, so no prose block prints beside it.
        expect(contextTailShowsProse(undefined, '5')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Geometry: WIDTH from the recorded time, HEIGHT from the recorded characters,
// each with an honest display floor (T26, R27)
// ---------------------------------------------------------------------------

describe('contextBarSharesOf', () => {
    it('divides by the exact weights when every segment clears the floor', () => {
        // The generic water-fill keeps its own contract (it is what sizes the TIME axis):
        // exact proportions, summing to exactly 1.
        expect(contextBarSharesOf([100, 200, 300], 0)).toEqual([1 / 6, 1 / 3, 1 / 2]);
        expect(contextBarSharesOf([100, 200, 300], 8 / 596)).toEqual([1 / 6, 1 / 3, 1 / 2]);
    });

    it('lifts a thin segment to the floor and pays for it out of the fat ones', () => {
        // 8/42 of the track is the floor; the four 1-character calls cannot be seen below
        // it, so the 1,000-character call gives up exactly that much of the bar.
        const shares = contextBarSharesOf([1000, 1, 1, 1, 1], 8 / 42);
        const floor = 8 / 42;

        expect(shares).toEqual([1 - floor * 4, floor, floor, floor, floor]);
        expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12);
    });

    it('splits equally when nothing is proportional, and caps a floor that cannot fit', () => {
        expect(contextBarSharesOf([0, 0, 0], 0.2)).toEqual([1 / 3, 1 / 3, 1 / 3]);
        expect(contextBarSharesOf([0, 5, 0], 0)).toEqual([0, 1, 0]);
        // A floor above 1/n would make the floors sum past the whole track.
        expect(contextBarSharesOf([1, 1, 1], 0.5)).toEqual([1 / 3, 1 / 3, 1 / 3]);
        expect(contextBarSharesOf([], 0.2)).toEqual([]);
        expect(contextBarSharesOf([7], 0.2)).toEqual([1]);
        // A junk weight is a 0-weight segment, not a NaN bar.
        expect(contextBarSharesOf([Number.NaN, 10], 0)).toEqual([0, 1]);
    });
});

describe('layoutContextBar', () => {
    it('sizes WIDTH from the recorded time and HEIGHT from the recorded characters (R27)', () => {
        // Deliberately crossed: the FIRST block is the biggest by characters and the shortest
        // by time. A width that came from `chars`, or a height that came from the span, fails
        // this fixture in a different way — which is the point of writing it this way.
        const layout = layoutContextBar(
            [
                tool({ chars: 300, at: T, endedAt: T + 1_000 }),
                tool({ id: 'b', chars: 200, at: T, endedAt: T + 2_000 }),
                tool({ id: 'c', chars: 100, at: T, endedAt: T + 7_000 })
            ],
            600
        );

        expect(layout.width).toBe(600);
        expect(layout.gapPx).toBe(CONTEXT_BAR_GAP_PX);
        expect(layout.trackPx).toBe(596);
        expect(layout.minSegmentPx).toBe(CONTEXT_BAR_MIN_SEGMENT_PX);
        // The strip's own axis figures: 1,000 + 2,000 + 7,000 ms, no unmeasured segment, and
        // a height denominator of 300 characters.
        expect(layout.totalDurationMs).toBe(10_000);
        expect(layout.durationsUnknown).toBe(0);
        expect(layout.maxChars).toBe(300);
        // The vertical band: one line-height, the two-line ceiling, the legible floor, and
        // the box the strip paints into (its tallest bar).
        expect(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX).toBe(CONTEXT_BAR_LINE_HEIGHT_PX * CONTEXT_BAR_MAX_HEIGHT_LINES);
        expect(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX).toBe(36);
        expect(layout.lineHeightPx).toBe(CONTEXT_BAR_LINE_HEIGHT_PX);
        expect(layout.maxHeightPx).toBe(36);
        expect(layout.minSegmentHeightPx).toBe(CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX);
        expect(layout.heightPx).toBe(36);
        expect(layout.rightEdge).toBe(600);

        // Widths follow the SPAN (10% / 20% / 70%), heights follow the CHARACTERS
        // (36 / 24 / 12 of the 36px ceiling), and every bar sits on the bottom edge.
        expect(layout.segments).toEqual([
            {
                index: 0,
                block: expect.objectContaining({ id: '0-tool-7' }),
                chars: 300,
                durationMs: 1_000,
                durationKnown: true,
                share: 0.1,
                x: 0,
                width: 60,
                heightShare: 1,
                heightPx: 36
            },
            {
                index: 1,
                block: expect.objectContaining({ id: 'b' }),
                chars: 200,
                durationMs: 2_000,
                durationKnown: true,
                share: 0.2,
                x: 62,
                width: 119,
                heightShare: 2 / 3,
                heightPx: 24
            },
            {
                index: 2,
                block: expect.objectContaining({ id: 'c' }),
                chars: 100,
                durationMs: 7_000,
                durationKnown: true,
                share: 0.7,
                x: 183,
                width: 417,
                heightShare: 1 / 3,
                heightPx: 12
            }
        ]);
        expect(layout.segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1, 12);
    });

    it('honors the width floor for a span the data would have made invisible', () => {
        // 1ms beside two 80s calls: the 1ms bar would be 0.01px, so it keeps the 8px aim floor
        // and the two measured calls pay for it out of their own widths.
        const layout = layoutContextBar(
            [
                tool({ chars: 1_000_000, at: T, endedAt: T + 1 }),
                tool({ id: 'b', chars: 5, at: T, endedAt: T + 80_000 }),
                tool({ id: 'c', chars: 5, at: T, endedAt: T + 80_000 })
            ],
            600
        );

        expect(layout.segments.map((segment) => [segment.x, segment.width])).toEqual([
            [0, 8],
            [10, 294],
            [306, 294]
        ]);
        expect(layout.totalDurationMs).toBe(160_001);
        expect(layout.rightEdge).toBe(600);

        // And the vertical floor for a 5-character block beside a 1,000,000-character one:
        // proportional would be 0.0002px, so the small bar keeps 3 legible pixels and its
        // tooltip still states the exact figure.
        expect(layout.segments.map((segment) => segment.heightPx)).toEqual([36, 3, 3]);
        expect(layout.segments.map((segment) => segment.heightShare)).toEqual([1, 0.000005, 0.000005]);
    });

    it('gives an UNMEASURED span the honest baseline width, never a fabricated timing (R27)', () => {
        // A prompt and an instruction block have no settle stamp; two calls have 2s and 6s.
        // The unmeasured bars get exactly `CONTEXT_BAR_UNKNOWN_DURATION_PX`, the measured ones
        // divide what is left in their real 1:3 proportion, and the counts are reported so the
        // accessible name can say how many segments are baselines.
        const layout = layoutContextBar(
            [
                tool({ id: 'u', kind: 'user', name: 'prompt', endedAt: undefined }),
                tool({ id: 'a', at: T, endedAt: T + 2_000 }),
                tool({ id: 'v', kind: 'system', name: 'instructions', endedAt: undefined }),
                tool({ id: 'z', at: T, endedAt: T + 6_000 })
            ],
            600
        );

        expect(layout.trackPx).toBe(594);
        expect(layout.unknownDurationPx).toBe(CONTEXT_BAR_UNKNOWN_DURATION_PX);
        expect(layout.durationsUnknown).toBe(2);
        // 2,000 + 6,000 of RECORDED time — the baselines contribute nothing to it.
        expect(layout.totalDurationMs).toBe(8_000);
        expect(layout.segments.map((segment) => [segment.durationKnown, segment.x, segment.width])).toEqual([
            [false, 0, 8],
            [true, 10, 145],
            [false, 157, 8],
            [true, 167, 433]
        ]);
        expect(layout.segments.map((segment) => segment.durationMs)).toEqual([undefined, 2_000, undefined, 6_000]);
        expect(layout.rightEdge).toBe(600);

        // A strip where NOTHING was bracketed splits equally: a list of unmeasured blocks is
        // not a timeline, and inventing proportions would be the lie.
        const allUnknown = layoutContextBar([tool({ id: 'u', endedAt: undefined }), tool({ id: 'v', endedAt: undefined })], 100);

        expect(allUnknown.durationsUnknown).toBe(2);
        expect(allUnknown.totalDurationMs).toBeUndefined();
        expect(allUnknown.segments.map((segment) => [segment.x, segment.width])).toEqual([
            [0, 49],
            [51, 49]
        ]);

        // A 0ms span IS a measurement, so it shares the strip equally with the other 0ms spans
        // rather than dropping to the unmeasured baseline, and the total stays exactly 0.
        const allZero = layoutContextBar([tool({ id: 'a', at: T, endedAt: T }), tool({ id: 'b', at: T, endedAt: T })], 100);

        expect(allZero.durationsUnknown).toBe(0);
        expect(allZero.totalDurationMs).toBe(0);
        expect(allZero.segments.map((segment) => [segment.durationMs, segment.x, segment.width])).toEqual([
            [0, 0, 49],
            [0, 51, 49]
        ]);
    });

    it('shrinks the gap and the floor before it ever overflows the track', () => {
        // 6px for 3 segments: gaps fall to 1px, the floor falls to a third of the track,
        // and the three segments still fill exactly 6px with none of them at 0.
        const layout = layoutContextBar([tool(), tool({ id: 'b' }), tool({ id: 'c' })], 6);

        expect(layout.gapPx).toBe(1);
        expect(layout.trackPx).toBe(4);
        expect(layout.unknownDurationPx).toBeLessThanOrEqual(layout.trackPx / 3);
        expect(layout.segments.map((segment) => [segment.x, segment.width])).toEqual([
            [0, 1],
            [2, 2],
            [5, 1]
        ]);
        expect(layout.rightEdge).toBe(6);

        // 300 segments in 300px: the gap collapses to 0, the display floor falls to whatever
        // the track can still afford, and no recorded call loses its last pixel.
        const many = layoutContextBar(Array.from({ length: 300 }, (_, i) => tool({ id: `t${i}` })), 300);
        expect(many.gapPx).toBe(0);
        expect(many.trackPx).toBe(300);
        expect(many.segments).toHaveLength(300);
        expect(many.segments.every((segment) => segment.width >= 1)).toBe(true);
        expect(Math.max(...many.segments.map((segment) => segment.width))).toBe(1);
        expect(many.rightEdge).toBe(300);
    });

    it('caps the tallest bar at two line-heights of the HOST scale, not a hardcoded 36 (R27)', () => {
        // A theme that sets `--context-bar-line-height: 22px` (or a bigger font) gets a 44px
        // ceiling — the same two text lines, because the number is counted, not copied.
        const layout = layoutContextBar([tool({ chars: 10 }), tool({ id: 'b', chars: 40_000 })], 600, { lineHeightPx: 22 });

        expect(layout.lineHeightPx).toBe(22);
        expect(layout.maxHeightPx).toBe(44);
        expect(layout.heightPx).toBe(44);
        expect(layout.segments.map((segment) => segment.heightPx)).toEqual([3, 44]);

        // And a caller may name the ceiling directly, which is what the painter does with the
        // values it resolves from the document.
        expect(layoutContextBar([tool({ chars: 10 }), tool({ id: 'b', chars: 40_000 })], 600, { maxHeightPx: 20 }).segments.map((s) => s.heightPx)).toEqual([
            3, 20
        ]);
    });

    it('splits a bar whose every segment recorded zero characters', () => {
        // The widths are still proportional (both spans are 800ms), but the strip has no
        // vertical story to tell: every bar is the minimum, and the strip's BOX is the minimum
        // too, rather than 36px of blank space over a hairline.
        const layout = layoutContextBar([tool({ chars: 0 }), tool({ id: 'b', chars: 0 })], 100);

        expect(layout.trackPx).toBe(98);
        expect(layout.maxChars).toBe(0);
        expect(layout.heightPx).toBe(CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX);
        expect(layout.segments).toEqual([
            {
                index: 0,
                block: expect.objectContaining({ id: '0-tool-7' }),
                chars: 0,
                durationMs: 800,
                durationKnown: true,
                share: 0.5,
                x: 0,
                width: 49,
                heightShare: 0,
                heightPx: CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX
            },
            {
                index: 1,
                block: expect.objectContaining({ id: 'b' }),
                chars: 0,
                durationMs: 800,
                durationKnown: true,
                share: 0.5,
                x: 51,
                width: 49,
                heightShare: 0,
                heightPx: CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX
            }
        ]);
        expect(layout.rightEdge).toBe(100);
    });

    it('falls back to the documented width when the host has none', () => {
        expect(layoutContextBar([tool()], 0).width).toBe(CONTEXT_BAR_FALLBACK_WIDTH);
        expect(layoutContextBar([tool()], Number.NaN).width).toBe(CONTEXT_BAR_FALLBACK_WIDTH);
    });

    it('describes an empty bar without inventing a segment', () => {
        const layout = layoutContextBar([], 600);

        expect(layout).toEqual({
            width: 600,
            gapPx: 0,
            trackPx: 600,
            minSegmentPx: 0,
            unknownDurationPx: 0,
            durationsUnknown: 0,
            totalDurationMs: undefined,
            lineHeightPx: CONTEXT_BAR_LINE_HEIGHT_PX,
            maxHeightPx: CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
            minSegmentHeightPx: CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
            maxChars: 0,
            // The base box, which is the rectangle the dashed "nothing recorded" state draws.
            heightPx: CONTEXT_BAR_TRACK_HEIGHT_PX,
            segments: [],
            rightEdge: 0
        });
    });

    it('keeps the widths of a 300-segment turn total, ordered and non-overlapping', () => {
        // Every span different, so no two shares are equal and the sequential layout is the
        // thing under test: segment after segment, never an absolute overlapping timeline.
        const blocks = Array.from({ length: 300 }, (_, i) => tool({ id: `s${i}`, chars: i + 1, at: T, endedAt: T + i * 7 }));
        const layout = layoutContextBar(blocks, 900);

        let cursor = 0;
        for (const segment of layout.segments) {
            expect(segment.x).toBeGreaterThanOrEqual(cursor);
            expect(segment.width).toBeGreaterThanOrEqual(1);
            cursor = segment.x + segment.width + layout.gapPx;
        }

        // The last segment ends exactly at the width the painter was given.
        expect(layout.rightEdge).toBe(900);
        expect(layout.segments[299].x + layout.segments[299].width).toBe(900);
        expect(layout.totalDurationMs).toBe(313_950);
    });
});

describe('contextBarDurationSharesOf', () => {
    it('divides the track by the recorded spans exactly', () => {
        expect(contextBarDurationSharesOf([1_000, 2_000, 7_000], { trackPx: 596 })).toEqual([0.1, 0.2, 0.7]);
        // A single segment owns the track whatever its span.
        expect(contextBarDurationSharesOf([5], { trackPx: 100 })).toEqual([1]);
        expect(contextBarDurationSharesOf([], { trackPx: 100 })).toEqual([]);
    });

    it('gives an unmeasured segment its baseline and re-divides the rest', () => {
        // track 596, two unmeasured bars at 8px each, and the 2s:6s pair splits the 580 left.
        expect(contextBarDurationSharesOf([undefined, 2_000, undefined, 6_000], { trackPx: 596, minSegmentPx: 8, unknownDurationPx: 8 })).toEqual([
            8 / 596,
            0.24328859060402686,
            8 / 596,
            0.7298657718120806
        ]);
    });

    it('never lets the baselines steal more than a fair share of the strip', () => {
        // 100px, 50 segments, one of them unmeasured: `track / n` is 2px, so the baseline
        // falls to 2px instead of a 200-segment strip of unknowns eating the measured bars.
        const durations = Array.from({ length: 50 }, (_, index) => (index === 0 ? undefined : 1_000));
        const shares = contextBarDurationSharesOf(durations, { trackPx: 100, minSegmentPx: 8, unknownDurationPx: 8 });

        expect(shares[0]).toBeCloseTo(2 / 100, 12);
        expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 12);
    });

    it('answers the nothing-is-proportional cases by splitting equally', () => {
        expect(contextBarDurationSharesOf([undefined, undefined], { trackPx: 98 })).toEqual([0.5, 0.5]);
        // Every span is 0ms: real data, and still nothing to be proportional about.
        expect(contextBarDurationSharesOf([0, 0, 0], { trackPx: 100 })).toEqual([1 / 3, 1 / 3, 1 / 3]);
        // A junk figure (NaN, negative) is "the record cannot say", never a coerced 0 — so it
        // takes the baseline rather than collapsing the bar.
        expect(contextBarDurationSharesOf([Number.NaN, 10], { trackPx: 100 })).toEqual([0.08, 0.92]);
        expect(contextBarDurationSharesOf([-5, 10], { trackPx: 100, unknownDurationPx: 0 })).toEqual([0, 1]);
    });
});

describe('contextBarHeightsOf', () => {
    it('normalizes to the largest characters in the SAME strip and clamps the band', () => {
        expect(contextBarHeightsOf([300, 200, 100, 0], { maxHeightPx: 36, minSegmentHeightPx: 3 })).toEqual([36, 24, 12, 3]);
        // A 1-character block beside a 40,000-character one is a 3px bar, not a 0px one.
        expect(contextBarHeightsOf([1, 40_000], { maxHeightPx: 36 })).toEqual([3, 36]);
        // The ceiling is the ceiling: nothing exceeds it, whatever the ratio.
        expect(contextBarHeightsOf([9, 9, 9], { maxHeightPx: 18 })).toEqual([18, 18, 18]);
        // No characters anywhere: a row of minimum bars.
        expect(contextBarHeightsOf([0, 0], { maxHeightPx: 36 })).toEqual([3, 3]);
        expect(contextBarHeightsOf([], { maxHeightPx: 36 })).toEqual([]);
        // A floor above the ceiling cannot win — two line-heights is the rule the reader sees.
        expect(contextBarHeightsOf([5, 10], { maxHeightPx: 10, minSegmentHeightPx: 40 })).toEqual([10, 10]);
        // A junk character figure is a 0-height weight, not a NaN bar.
        expect(contextBarHeightsOf([Number.NaN, 100], { maxHeightPx: 36 })).toEqual([3, 36]);
    });
});

describe('contextTextSuffixOf', () => {
    // T26 (R26): the preview window keeps the END of a body. Every case here is an exact
    // string, because "shows the latest text" is only a fact if the bytes are pinned.
    it('keeps a short body whole, with no marker and no claim', () => {
        expect(contextTextSuffixOf('short')).toEqual({ text: 'short', shown: 5, omitted: 0, bounded: false });
        expect(contextTextSuffixOf('')).toEqual({ text: '', shown: 0, omitted: 0, bounded: false });
        expect(contextTextSuffixOf(undefined)).toEqual({ text: '', shown: 0, omitted: 0, bounded: false });

        // Exactly at the bound is not over the bound: the whole body prints, unsullied.
        const at = 'y'.repeat(CONTEXT_TAIL_PREVIEW_CHARS);

        expect(contextTextSuffixOf(at)).toEqual({ text: at, shown: CONTEXT_TAIL_PREVIEW_CHARS, omitted: 0, bounded: false });
    });

    it('cuts the FRONT and keeps the latest characters behind a marker', () => {
        const body = 'head-'.repeat(100); // 500 characters

        // The cut lands on a fresh `h` (500 - 10 is a multiple of the 5-character period), so
        // the window is the last 10 characters exactly and `omitted` accounts for the rest.
        expect(contextTextSuffixOf(body, 10)).toEqual({ text: `${CONTEXT_TEXT_ELLIPSIS}head-head-`, shown: 10, omitted: 490, bounded: true });
    });

    it('uses the bound the display contract already publishes', () => {
        // No new arbitrary number: the render window is `DISPLAY_NODE_PREVIEW_CHARS`, the same
        // figure a bounded wire node uses (../shared/turn-display.ts:135).
        expect(CONTEXT_TAIL_PREVIEW_CHARS).toBe(320);

        const body = '0123456789'.repeat(50); // 500

        expect(contextTextSuffixOf(body)).toEqual({
            text: `${CONTEXT_TEXT_ELLIPSIS}${body.slice(-320)}`,
            shown: 320,
            omitted: 180,
            bounded: true
        });
    });

    it('never splits a code point, an emoji sequence or a combining mark', () => {
        // The cut lands mid-astral-pair by arithmetic; the kept suffix must still start on a
        // whole code point, which is what "Unicode safe" means here.
        const astral = 'a'.repeat(321) + '\u{1F468}';

        const split = contextTextSuffixOf(astral, 2);

        expect(split.text).toBe(`${CONTEXT_TEXT_ELLIPSIS}\u{1F468}`);
        expect(split.shown).toBe(2);
        expect(split.omitted).toBe(321);
        // No lone surrogate anywhere in the painted string.
        expect(split.text.slice(1)).toBe(astral.slice(321));

        // A combining mark may never open the window: the cut advances past it, so the base
        // letter and its accent stay together.
        const marks = 'prelude ' + 'e\u0301'.repeat(4);

        const kept = contextTextSuffixOf(marks, 6);

        expect(kept.text).toBe(`${CONTEXT_TEXT_ELLIPSIS}e\u0301e\u0301e\u0301`);
        expect(kept.omitted).toBe(10);
        expect(kept.shown).toBe(6);

        // A ZWJ family emoji: the window opens on a whole joined member rather than on a
        // dangling joiner or half a surrogate pair.
        const family = 'a'.repeat(319) + '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

        const joined = contextTextSuffixOf(family, 4);

        expect(family.length).toBe(327);
        expect(joined.text).toBe(`${CONTEXT_TEXT_ELLIPSIS}\u{1F467}`);
        expect(joined.shown).toBe(2);
        expect(joined.omitted).toBe(325);
    });

    it('honors a zero bound as an empty window that still says so', () => {
        expect(contextTextSuffixOf('abc', 0)).toEqual({ text: CONTEXT_TEXT_ELLIPSIS, shown: 0, omitted: 3, bounded: true });
        // A junk bound (NaN, negative) is the same "no room" answer, never an unbounded copy.
        expect(contextTextSuffixOf('abc', Number.NaN).shown).toBe(0);
        expect(contextTextSuffixOf('abc', -8).shown).toBe(0);
    });
});

describe('contextBarSegmentAt', () => {
    // Three blocks with the SAME 800ms span (equal widths) and different `chars` (different
    // heights), so the hit test is exercised on a strip whose bars are NOT all the same
    // picture: the column is the target, the bar is only what the eye sees (T26, R27/R28).
    const layout = layoutContextBar([tool({ chars: 100 }), tool({ id: 'b', chars: 200 }), tool({ id: 'c', chars: 300 })], 600);

    it('resolves a point to the segment it is on', () => {
        expect(layout.segments.map((segment) => [segment.x, segment.width])).toEqual([
            [0, 199],
            [201, 198],
            [401, 199]
        ]);

        expect(contextBarSegmentAt(layout, 0)).toBe(0);
        expect(contextBarSegmentAt(layout, 50)).toBe(0);
        expect(contextBarSegmentAt(layout, 150)).toBe(0);
        expect(contextBarSegmentAt(layout, 250)).toBe(1);
        expect(contextBarSegmentAt(layout, 400)).toBe(1);
        expect(contextBarSegmentAt(layout, 500)).toBe(2);
        // The final pixel of the bar belongs to the final segment.
        expect(contextBarSegmentAt(layout, 600)).toBe(2);
    });

    it('gives a point in a visible gap to the nearer segment', () => {
        // The 2px gap is styling, not a dead zone between controls.
        expect(contextBarSegmentAt(layout, 200)).toBe(0);
        expect(contextBarSegmentAt(layout, 400)).toBe(1);
    });

    it('keeps the whole COLUMN as the target, whatever the bar height is (R27/R28)', () => {
        // The shortest bar in this strip is 12px of a 36px box. A pointer 30px "above" it is
        // still inside its column, and the documented policy is that the column answers: a
        // hairline bar would otherwise be a target nobody could hit.
        const heights = layout.segments.map((segment) => segment.heightPx);

        expect(heights).toEqual([12, 24, 36]);
        expect(layout.heightPx).toBe(36);
        expect(contextBarSegmentAt(layout, 10)).toBe(0);
        expect(contextBarSegmentAt(layout, 300)).toBe(1);
    });

    it('misses outside the painted track and for an empty bar', () => {
        expect(contextBarSegmentAt(layout, -1)).toBe(-1);
        expect(contextBarSegmentAt(layout, 601)).toBe(-1);
        expect(contextBarSegmentAt(layout, Number.NaN)).toBe(-1);
        expect(contextBarSegmentAt(layoutContextBar([], 600), 10)).toBe(-1);
    });
});
