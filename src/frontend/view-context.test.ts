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
    CONTEXT_BAR_EXCLUDED_ALPHA,
    CONTEXT_BAR_FALLBACK_WIDTH,
    CONTEXT_BAR_GAP_PX,
    CONTEXT_BAR_LABEL,
    CONTEXT_BAR_LINE_HEIGHT_PX,
    CONTEXT_BAR_MAX_HEIGHT_LINES,
    CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_PX,
    CONTEXT_BAR_ROW_GAP_PX,
    CONTEXT_BAR_TONE_STYLES,
    CONTEXT_BAR_TRACK_HEIGHT_PX,
    CONTEXT_BAR_UNKNOWN_DURATION_PX,
    CONTEXT_TEXT_ELLIPSIS,
    CONTEXT_TAIL_PREVIEW_CHARS,
    contextBarDurationSharesOf,
    contextBarFiguresOf,
    contextBarLaneLabelOf,
    contextBarLaneTagOf,
    contextBarLanesOf,
    contextBarHeightsOf,
    contextBarOf,
    contextBarReplacesChips,
    contextBarRowAt,
    contextBarSegmentAlphaOf,
    contextBarSegmentAt,
    contextBarSharesOf,
    contextBarShowsLaneTagsOf,
    contextBarStatsOf,
    contextBarSummaryOf,
    contextBarToneOf,
    contextBlockCharsOf,
    contextBlockDurationOf,
    contextBlockIsExcluded,
    contextLatestTextNodeIdOf,
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
// C2: the multi-lane layout type, needed to state the parity comparison as data (the geometry a
// bar publishes, with the block payloads stripped out).
import type { ContextBarLayout } from './view-context';
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
// THE DIM STATE (R7 / T4a) — `included` is the reader-facing inclusion axis
// ---------------------------------------------------------------------------

describe('the dim state (R7)', () => {
    it('reads the tri-state strictly, so only a published `false` is ever an exclusion', () => {
        // THE WHOLE DECISION, in one helper both renderers and the tooltip read.
        //   false  -> the axis this segment resolves to is switched OFF -> dim;
        //   true   -> switched on (and what lets the dialog offer the toggle BACK);
        //   ABSENT -> the producer could not name the transcript entry behind the segment
        //             (../shared/turn-display.ts:588-593). That is UNKNOWN, not excluded —
        //             defaulting it would dim every bar the trimmer never touched.
        expect(contextBlockIsExcluded(tool({ included: false }))).toBe(true);
        expect(contextBlockIsExcluded(tool({ included: true }))).toBe(false);
        expect(contextBlockIsExcluded(tool())).toBe(false);
        expect(contextBlockIsExcluded(tool({ included: undefined }))).toBe(false);

        // Every kind answers the same way: the axis is the FIELD's, not the kind's.
        expect(contextBlockIsExcluded(think({ included: false }))).toBe(true);
        expect(contextBlockIsExcluded(prompt({ included: false }))).toBe(true);

        // A running call the server has not settled is NOT thereby excluded, and an error is
        // not either: the tone table owns those two readings, the dim state owns this one.
        expect(contextBlockIsExcluded(tool({ state: 'running', resultChars: undefined }))).toBe(false);
        expect(contextBlockIsExcluded(tool({ state: 'error' }))).toBe(false);
    });

    it('dims to exactly 0.2 and never touches the tone alphas', () => {
        // The user's "80% opacity, almost transparent" resolves to 0.2, and it is ONE number:
        // `ui/context-bar-style.test.ts` pins `styles.css`
        // `.context-bar-segment[data-included='false'] { opacity: 0.2 }` against this constant,
        // so DOM mode and canvas mode cannot drift (the T27/R28 parity rule).
        expect(CONTEXT_BAR_EXCLUDED_ALPHA).toBe(0.2);

        // Opaque exactly as before, per tone: 1 for everything but a call that has not settled.
        expect(contextBarSegmentAlphaOf(tool())).toBe(1);
        expect(contextBarSegmentAlphaOf(tool({ state: 'error' }))).toBe(1);
        expect(contextBarSegmentAlphaOf(think())).toBe(1);
        expect(contextBarSegmentAlphaOf(prompt())).toBe(1);
        expect(contextBarSegmentAlphaOf(tool({ state: 'running', resultChars: undefined }))).toBe(0.45);

        // Dimmed: every tone lands on 0.2 — the figure DOM mode resolves, not a product of the
        // two, because CSS cannot multiply opacities on ONE element and the canvas must agree.
        expect(contextBarSegmentAlphaOf(tool({ included: false }))).toBe(0.2);
        expect(contextBarSegmentAlphaOf(tool({ state: 'error', included: false }))).toBe(0.2);
        expect(contextBarSegmentAlphaOf(think({ included: false }))).toBe(0.2);
        expect(contextBarSegmentAlphaOf(prompt({ included: false }))).toBe(0.2);
        // The running tone is the one tone whose own alpha (0.45) is BELOW 1, and a dimmed
        // running call still lands on 0.2: the dim CAPS, so both renderers say one number.
        expect(contextBarSegmentAlphaOf(tool({ state: 'running', resultChars: undefined, included: false }))).toBe(0.2);

        // `true` restores the tone alpha exactly — the dim comes back off when a reader
        // re-includes the block, and no tone alpha is permanently lost on the way.
        expect(contextBarSegmentAlphaOf(tool({ state: 'running', resultChars: undefined, included: true }))).toBe(0.45);

        // The dim is strictly fainter than every tone, which is what makes it readable as a
        // change rather than as a fourth colour.
        for (const style of Object.values(CONTEXT_BAR_TONE_STYLES)) expect(CONTEXT_BAR_EXCLUDED_ALPHA).toBeLessThan(style.alpha);
    });

    it('folds the withheld total from BOTH authorities, the same pair the segments state (R5 review, FIX A)', () => {
        const model = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool(), tool({ id: '0-tool-9', included: false })])]));

        expect(model.totalChars).toBe(1546 + 1204);
        // THE TOTAL IS THE SEGMENTS THAT SAY SO, and both authorities count: the thinking window
        // on the PROJECTOR's static claim (`inPrompt: false`, 300) and the switched-off tool on the
        // ENTRY's live verdict (`included: false`, 1,204). The old expectation here was 300 with the
        // comment "the withheld figure is a per-segment fact, not a strip-level total" — that
        // reasoning is what FIX A retired, because the same 1,204 bytes were simultaneously being
        // announced by the segment's own tooltip as `not replayed into the prompt` while the strip's
        // sentence left them out of its arithmetic. One predicate
        // (`contextBlockIsWithheld`, used by `contextBarOf` AND by `contextSegmentTitleOf`) now
        // decides both, so the tooltip and the total cannot disagree by construction.
        expect(model.unpromptedChars).toBe(300 + 1204);
        expect(model.counts).toEqual({ user: 1, system: 0, reasoning: 1, assistant: 0, tool: 2 });
        expect(model.charsByKind).toEqual({ user: 42, system: 0, reasoning: 300, assistant: 0, tool: 1204 + 1204 });

        // THE SWITCH IS WHAT MOVES IT. The same four blocks with the tool's inclusion left unnamed
        // by the server total 300 again: `undefined` is "no verdict", never "excluded", so the
        // static authority alone is what remains (../shared/turn-display.ts `ContextBlock.included`,
        // and the single client rule `contextBlockIsExcluded` the dim follows).
        const unnamed = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool(), tool({ id: '0-tool-9' })])]));

        expect(unnamed.totalChars).toBe(model.totalChars);
        expect(unnamed.unpromptedChars).toBe(300);

        // A `true` restores it exactly as it restores the pixels: an entry the server names as
        // travelling contributes nothing to the withheld total, whatever its kind.
        expect(contextBarOf(displayOf([section('t1:0', [tool({ id: '0-tool-9', included: true })])])).unpromptedChars).toBe(0);

        // AND THE KEY SET DID NOT MOVE. FIX A deliberately widened the MEANING of
        // `unpromptedChars` rather than minting a second figure beside it, so every consumer that
        // pins this model's shape — the closed-key-set pins in this file and the display-project
        // copies in ./display-project-blocks.test.ts — keeps its exact key set.
        expect(Object.keys(model)).toEqual([
            'turnId',
            'available',
            'blocks',
            'totalChars',
            'unpromptedChars',
            'counts',
            'charsByKind',
            'totalDurationMs',
            'durationsUnknown'
        ]);
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

    it('says the same words for a segment the reader withheld (R7) — once, either authority', () => {
        // THE POINT OF THIS PIN. `included: false` is the LIVE verdict that names THIS entry
        // (../shared/turn-display.ts:567-600), and a tool unit excluded for the next request
        // carries `inPrompt: true`, because the projector's static rule cannot see the
        // exclusion. A bar that only read `inPrompt` would paint a withheld call exactly like a
        // replayed one. The wording is the model's OWN clause — no new phrasing to drift.
        expect(contextSegmentTitleOf(tool({ included: false }))).toBe(
            'read · tool · ok · 1,204 characters · args 20 + result 1,184 · 800ms · not replayed into the prompt'
        );
        expect(contextSegmentTitleOf(prompt({ included: false }))).toBe(
            'prompt · user · 42 characters · time not recorded · not replayed into the prompt'
        );

        // A segment the server named and switched ON says nothing: `true` is not a verdict
        // about absence, and an absent field is not one either (the cases above).
        expect(contextSegmentTitleOf(tool({ included: true }))).toBe(
            'read · tool · ok · 1,204 characters · args 20 + result 1,184 · 800ms'
        );

        // BOTH authorities at once still print the clause ONCE — the model has exactly one
        // trailing clause and the two conditions are joined, not concatenated.
        expect(contextSegmentTitleOf(think({ included: false }))).toBe(
            'reasoning · reasoning · 300 characters · 1.2s · not replayed into the prompt'
        );
        expect(contextSegmentTitleOf(think({ inPrompt: true, included: false }))).toBe(
            'reasoning · reasoning · 300 characters · 1.2s · not replayed into the prompt'
        );

        // The accessible name carries it too, because it is the model's string with a position
        // prefix (`ui/context-bar.ts` adds nothing to it).
        expect(contextSegmentLabelOf(tool({ included: false }), 0, 3)).toBe(
            '1 of 3 · read · tool · ok · 1,204 characters · args 20 + result 1,184 · 800ms · not replayed into the prompt'
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

    it('names the LANES once a bar spans more than one (C2)', () => {
        // One compaction mints a lane, and the caption is where the reader learns the strip
        // stacked rather than scrolling past one short row. The suffix appears ONLY past one
        // lane, and it counts LANES — never "compactions" or "turns", because the lane number is
        // opaque UI metadata the renderer is not allowed to interpret
        // (../shared/turn-display.ts:487-489).
        const oneRow = contextBarOf(displayOf([section('t1:0', [prompt(), think(), tool()])]));
        const twoRows = contextBarOf(displayOf([section('t1:0', [prompt(), think({ lane: 1 }), tool()])]));

        expect(contextBarStatsOf(oneRow)).toBe('3 segments');
        expect(contextBarStatsOf(twoRows)).toBe('3 segments · 2 lanes');

        // A bar whose only lane is NOT lane 0 still prints the count alone: the sentence carries
        // how many rows there are, and one row needs no sentence. The per-row tag is where a lone
        // non-zero lane shows (see `contextBarShowsLaneTagsOf`).
        expect(contextBarStatsOf(contextBarOf(displayOf([section('t1:0', [tool({ id: 'b', lane: 4 })])])))).toBe('1 segment');

        // Four lanes pluralize and count exactly, gaps included; and the empty bar has no lane to
        // mention at all.
        expect(
            contextBarStatsOf(
                contextBarOf(
                    displayOf([
                        section('t1:0', [tool({ id: 'a' }), tool({ id: 'b', lane: 1 }), tool({ id: 'c', lane: 2 }), tool({ id: 'd', lane: 3 })])
                    ])
                )
            )
        ).toBe('4 segments · 4 lanes');
        expect(contextBarStatsOf(contextBarOf(displayOf([section('t1:0', [])])))).toBe('no recorded context');

        // The ACCESSIBLE figures keep their exact wording: the lane suffix belongs to the visible
        // caption, and the row itself is what announces a lane to a screen reader.
        expect(contextBarFiguresOf(twoRows)).not.toContain('lane');
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

    it('paints a thinking tail from the WHOLE wire text, and states a bounded body honestly (R1b)', () => {
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
            // T27 (R1b): the thinking pane is a scroll box, so it paints the body the wire
            // delivered with NO render-side window and NO leading `…` of our own. This producer
            // bounded the wire itself (40 characters of a 1,234-character round, `redacted`),
            // and T27 (review, P2) keeps the pair honest rather than claiming the record: the
            // pane shows 40, the block is 1,234, and the caption says so and points at the
            // segment. The whole-text case — the one the live server produces — is the test
            // below, where the two figures agree and the clause disappears.
            renderText: preview,
            shownChars: preview.length,
            chars: 1_234,
            truncated: true,
            designated: false
        });

        // The pointer clause survives exactly where it is owed: nothing about the R1b box may
        // let a 40-character body read as a 1,234-character one.
        expect(contextTailCaptionOf(contextTailOf(flowOf([thinking()], [prompt()]))!)).toBe(
            `thinking · showing ${preview.length} of 1,234 characters — click the segment for the exact text`
        );
    });

    it('paints the LATEST window of an ANSWER body longer than the bound (R26 kept)', () => {
        // The rule R26 established survives on the surface it was always about: an answer
        // prints INLINE in the flow, so an over-long one keeps its newest 320 characters and
        // its caption admits the cut. T27 (R1b) moved only the thinking body, which now lives
        // in a scroll box and is windowed by nothing (see the pair of tests below).
        const streamed = `${'head-'.repeat(10)}${'t'.repeat(480)}`;

        expect(streamed.length).toBe(530);

        const tail = contextTailOf(
            flowOf([{ kind: 'text', id: '5', text: streamed, chars: streamed.length, committed: true } as never], [think({ chars: streamed.length })])
        );

        expect(tail?.kind).toBe('assistant');
        expect(tail?.truncated).toBe(false);
        expect(tail?.chars).toBe(530);
        expect(tail?.shownChars).toBe(CONTEXT_TAIL_PREVIEW_CHARS);
        // The painted string is the marker plus the last `CONTEXT_TAIL_PREVIEW_CHARS` units.
        expect(tail?.renderText).toBe(`${CONTEXT_TEXT_ELLIPSIS}${streamed.slice(-CONTEXT_TAIL_PREVIEW_CHARS)}`);
        expect(tail?.text).toBe(streamed);
        // And the caption states the window, not the whole.
        expect(contextTailCaptionOf(tail!)).toBe(
            `answer · showing ${CONTEXT_TAIL_PREVIEW_CHARS} of 530 characters — click the segment for the exact text`
        );
    });

    it('paints a thinking body past the bound WHOLE, with no marker and no window (R1b)', () => {
        // The exact 530-character case above, as THINKING: nothing is cut, so the pane shows
        // the opening `head-` the R26 window used to drop, `shownChars` equals the recorded
        // `chars`, and the caption states the length alone — the user's "showing x of y"
        // complaint, answered at the model layer rather than in the stylesheet.
        const streamed = `${'head-'.repeat(10)}${'t'.repeat(480)}`;

        const tail = contextTailOf(
            flowOf([{ kind: 'reasoning', id: '3', text: streamed, chars: streamed.length } as never], [think({ chars: streamed.length })])
        );

        expect(tail).toEqual({
            kind: 'reasoning',
            nodeId: '3',
            blockId: '0-reasoning-3',
            text: streamed,
            renderText: streamed,
            shownChars: 530,
            chars: 530,
            truncated: false,
            designated: false
        });
        expect(tail?.renderText).toContain('head-');
        expect(tail?.renderText).not.toContain(CONTEXT_TEXT_ELLIPSIS);
        expect(contextTailCaptionOf(tail!)).toBe('thinking · 530 characters');
    });

    it('takes the exact figure and the provenance id from the section context list', () => {
        const tail = contextTailOf(flowOf([thinking()], [prompt(), think({ chars: 2_048 })]));

        expect(tail?.blockId).toBe('0-reasoning-3');
        expect(tail?.chars).toBe(2_048);
        // `truncated` is the WIRE's fact (T27 review, P2): this producer sent a 40-character
        // preview of a 2,048-character window and marked it `redacted`, so the box holds fewer
        // characters than the record and the tail says so. R1b removed only the renderer's OWN
        // window — it never let the pane claim bytes that did not arrive.
        expect(tail?.truncated).toBe(true);
        expect(tail?.shownChars).toBe(preview.length);
        expect(tail?.renderText).toBe(preview);
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

        // A prose designation whose node the wire bounded is still painted from the wire's own
        // bytes with no render window of ours on top (T27, R1b) — and the figures stay honest
        // about how much that was (T27 review, P2): 9 characters painted of a recorded 900,
        // `truncated` true, so the caption keeps its segment pointer.
        const bounded = contextTailOf(
            flowOf(
                [{ kind: 'reasoning', id: '3', text: 'a preview', chars: 900, redacted: true } as never],
                [prompt(), think({ id: '0-reasoning-3', chars: 900 })],
                { tail: { kind: 'reasoning', nodeId: '3', blockId: '0-reasoning-3', chars: 900, truncated: false } }
            )
        );

        expect(bounded).toMatchObject({
            truncated: true,
            chars: 900,
            shownChars: 9,
            renderText: 'a preview',
            designated: true
        });
        expect(contextTailCaptionOf(bounded as never)).toBe(
            'thinking · showing 9 of 900 characters — click the segment for the exact text'
        );

        // The same shortness WITHOUT the wire's own marker: a `chars` figure bigger than the
        // text the producer sent is the same fact stated differently, and it reads the same
        // way. A WHOLE body — the case above, and every designated carrier the live server
        // sends — still reports `truncated: false`, `shownChars === chars`, and no clause.
        const shortWithoutMarker = contextTailOf(
            flowOf(
                [{ kind: 'reasoning', id: '3', text: 'a preview', chars: 900 } as never],
                [prompt(), think({ id: '0-reasoning-3', chars: 900 })],
                { tail: { kind: 'reasoning', nodeId: '3', blockId: '0-reasoning-3', chars: 900, truncated: false } }
            )
        );

        expect(shortWithoutMarker).toMatchObject({ truncated: true, chars: 900, shownChars: 9, renderText: 'a preview' });
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
        // And the prose of a designated answer still owns the flow block, not this body. R2
        // states the rule by POSITION, not by designation: the section's newest response is
        // the one that prints, whatever block the tail currently paints.
        const answerSection = flowOf(
            [{ kind: 'text', id: '5', text: 'the answer', chars: 10, committed: true } as never],
            [prompt()],
            { tail: { kind: 'assistant', nodeId: '5', chars: 10, truncated: false } }
        );

        expect(contextTailShowsProse(answerSection, '5')).toBe(true);
        expect(contextTailShowsProse(answerSection, '3')).toBe(false);
    });
});

describe('contextTailCaptionOf', () => {
    // A hand-written tail now states BOTH figures, which is exactly the pair the caption
    // reports (T26, R26): `chars` is the invariant-5 recorded length, `shownChars` is the
    // length the PANE paints — whether the wire bounded it or the render window did.
    //
    // T27 (R1b + review P2) note: these fixtures are hand-built and the caption function itself
    // is unchanged, so a `reasoning` tail here may state any pair. What `contextTailOf` can
    // actually PRODUCE for a thinking tail is pinned in its own describes above: a whole
    // (designated-carrier) body gives `shownChars === chars`, `truncated: false` and the plain
    // `thinking · N characters` line, and a body the PRODUCER bounded gives
    // `shownChars = text.length < chars`, `truncated: true` and the clause below — because the
    // scroll box cannot paint bytes that never arrived.
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
    // T27 (R2): the rule is POSITIONAL now. The section's NEWEST `kind: 'text'` node prints —
    // whether the tail is an answer, a thinking window or a recorded call — and every older
    // response prints nothing. `contextTailOf` no longer decides it, which is why the argument
    // is the section rather than the tail.
    const flowOf = (nodes: never[], overrides: Record<string, unknown> = {}) =>
        ({ ...section('t1:0', [prompt()]), nodes, ...overrides }) as never;

    const text = (id: string): never =>
        ({ kind: 'text', id, text: 'a', chars: 1, committed: true }) as never;

    const reasoning = (id: string): never => ({ kind: 'reasoning', id, text: 't', chars: 1 }) as never;

    const step = (id: string): never =>
        ({ kind: 'tool', id, turnId: 't1', sectionId: 't1:0', callId: `call-${id}`, name: 'read', state: 'ok', detail: { stepId: id, hasResult: true, truncated: true } }) as never;

    it('names the section\'s newest text node, and nothing else', () => {
        expect(contextLatestTextNodeIdOf(flowOf([reasoning('3'), text('5'), text('7')]))).toBe('7');
        // A notice or a recorded call after it does not move the answer: neither is a response.
        expect(contextLatestTextNodeIdOf(flowOf([text('5'), step('7'), reasoning('8')]))).toBe('5');
        expect(contextLatestTextNodeIdOf(flowOf([reasoning('3'), step('7')]))).toBeUndefined();
        expect(contextLatestTextNodeIdOf(flowOf([]))).toBeUndefined();
        expect(contextLatestTextNodeIdOf(undefined)).toBeUndefined();
    });

    it('keeps the newest response printed while an older one withdraws', () => {
        const flow = flowOf([text('2'), reasoning('3'), text('5')]);

        expect(contextTailShowsProse(flow, '5')).toBe(true);
        // An earlier response of the SAME section is a segment now (R23 kept this half).
        expect(contextTailShowsProse(flow, '2')).toBe(false);
        // A reasoning node is never addressed this way: its body is the tail block.
        expect(contextTailShowsProse(flow, '3')).toBe(false);
    });

    it('prints the intermediate response above a thinking or call tail (R2)', () => {
        // The defect this replaced: R23 hid the reply the moment a newer block took the tail,
        // so a running turn read as a bare strip over a tool pane with no reply above it.
        const thinkingTail = flowOf([text('5'), reasoning('8')], {
            tail: { kind: 'reasoning', nodeId: '8', blockId: '0-reasoning-8', chars: 1, truncated: false }
        });

        expect(contextTailShowsProse(thinkingTail, '5')).toBe(true);

        const callTail = flowOf([text('5'), step('7')], {
            tail: { kind: 'tool', nodeId: '7', blockId: '0-tool-7', chars: 4, truncated: false, args: 'args', result: 'here' }
        });

        expect(contextTailShowsProse(callTail, '5')).toBe(true);
        // And the answer is still the newest response when the designation names an older one.
        expect(contextTailShowsProse(flowOf([text('5'), text('9')]), '9')).toBe(true);
    });

    it('prints nothing for a section with no response, or no section at all', () => {
        expect(contextTailShowsProse(flowOf([reasoning('3')]), '5')).toBe(false);
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
        //
        // C2 adds exactly two fields to every segment — `lane` (the lane this block belongs to)
        // and `row` (which row that lane draws) — and both are the defaults for a lane-absent
        // bar. Every geometry figure below is the number this fixture produced before lanes
        // existed: that is the parity proof, not a loosened assertion.
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
                heightPx: 36,
                lane: 0,
                row: 0
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
                heightPx: 24,
                lane: 0,
                row: 0
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
                heightPx: 12,
                lane: 0,
                row: 0
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
        // C2: `lane`/`row` are the only additions, and both are the single-lane defaults; the
        // widths, heights and the minimum-height box are the figures this fixture had.
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
                heightPx: CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
                lane: 0,
                row: 0
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
                heightPx: CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
                lane: 0,
                row: 0
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

        // C2: the flat figures are byte for byte what an empty strip reported before lanes. The
        // two new bar-level fields (`lanes`, `rowGapPx`) and the `rows` list are additive: an
        // empty bar has NO lane — no block claimed one — and still exactly ONE row, because the
        // dashed "nothing recorded" box needs a band to draw, and that row's figures are the
        // flat ones. Nothing was invented and nothing moved.
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
            lanes: [],
            rowGapPx: CONTEXT_BAR_ROW_GAP_PX,
            rows: [
                {
                    lane: 0,
                    row: 0,
                    offsetY: 0,
                    heightPx: CONTEXT_BAR_TRACK_HEIGHT_PX,
                    gapPx: 0,
                    trackPx: 600,
                    minSegmentPx: 0,
                    unknownDurationPx: 0,
                    rightEdge: 0,
                    maxChars: 0,
                    durationsUnknown: 0,
                    totalDurationMs: undefined,
                    segments: []
                }
            ],
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

// ---------------------------------------------------------------------------
// C2 — LANES: one row per lane, each row its own graph
// ---------------------------------------------------------------------------

describe('contextBarLanesOf / contextBlockLaneOf', () => {
    it('lists every lane the blocks occupy, ascending, with gaps skipped', () => {
        // The renderer draws a row per lane PRESENT, not per lane NUMBERED: a bar that jumps
        // from lane 0 to lane 4 is two rows, because an empty band would read as a compaction
        // that never happened.
        expect(contextBarLanesOf([tool({ id: 'c', lane: 4 }), tool({ id: 'a' }), tool({ id: 'b', lane: 1 })])).toEqual([0, 1, 4]);
        expect(contextBarLanesOf([tool({ id: 'a', lane: 2 }), tool({ id: 'b', lane: 2 })])).toEqual([2]);
        expect(contextBarLanesOf([])).toEqual([]);
    });

    it('reads a lane the contract forbids as the contract default, lane 0', () => {
        // `lane` is absent-or-integer->=0 (../shared/turn-display.ts:474-491). A float, a
        // negative and a string are all "the producer said nothing usable", and the honest
        // answer is the contract's own default — never a row that cannot be labelled.
        expect(contextBarLanesOf([tool({ id: 'a', lane: 2.5 }), tool({ id: 'b', lane: -1 }), tool({ id: 'c', lane: 'x' as unknown as number })])).toEqual([0]);
        expect(contextBarLanesOf([tool({ id: 'a', lane: Number.NaN })])).toEqual([0]);
    });

    it('shows the lane cue exactly when the reader could misread the bar', () => {
        // One row on lane 0: every bar the board drew before compaction, and it says nothing new.
        expect(contextBarShowsLaneTagsOf([])).toBe(false);
        expect(contextBarShowsLaneTagsOf([0])).toBe(false);
        // A bar whose ONLY lane is not lane 0 (its lane-0 blocks are gone) is still a stacked
        // bar that got there, so it labels its row; and more than one row always labels them all.
        expect(contextBarShowsLaneTagsOf([1])).toBe(true);
        expect(contextBarShowsLaneTagsOf([0, 1])).toBe(true);
        // The tag text and the words a screen reader hears for the same row.
        expect(contextBarLaneTagOf(0)).toBe('L0');
        expect(contextBarLaneTagOf(3)).toBe('L3');
        expect(contextBarLaneLabelOf(3)).toBe('context bar lane 3');
    });
});

describe('layoutContextBar, multi-lane (C2)', () => {
    it('stacks one row per lane, lane 0 topmost, gaps skipped, in-lane order kept', () => {
        // Three lanes with ONE block each in a 100px track. Each row is a strip of one, so each
        // bar owns its whole row: x 0, width 100, and its own 36px box (the tallest bar a row of
        // one can paint). The bands stack with the model's 2px seam: 0, 38, 76, and the bar's box
        // is 3 * 36 + 2 * 2 = 112.
        const layout = layoutContextBar(
            [tool({ id: 'a', chars: 100 }), tool({ id: 'b', chars: 100, lane: 1 }), tool({ id: 'c', chars: 100, lane: 3 })],
            100
        );

        expect(layout.lanes).toEqual([0, 1, 3]);
        expect(layout.rowGapPx).toBe(CONTEXT_BAR_ROW_GAP_PX);
        expect(layout.rows.map((row) => [row.lane, row.row, row.offsetY, row.heightPx])).toEqual([
            [0, 0, 0, 36],
            [1, 1, 38, 36],
            [3, 2, 76, 36]
        ]);
        expect(layout.heightPx).toBe(112);
        // Every row is its own strip: full width, no gap to shrink, and its own 100-character
        // denominator — none of it borrowed from its neighbours.
        expect(layout.rows.map((row) => [row.gapPx, row.trackPx, row.rightEdge, row.maxChars])).toEqual([
            [0, 100, 100, 100],
            [0, 100, 100, 100],
            [0, 100, 100, 100]
        ]);
        // Each segment carries the lane it belongs to, the row that lane draws, and the FLAT
        // index the tile activates by — which is what keeps one click pointing at one block.
        expect(layout.segments.map((s) => [s.index, s.lane, s.row, s.x, s.width, s.heightPx])).toEqual([
            [0, 0, 0, 0, 100, 36],
            [1, 1, 1, 0, 100, 36],
            [2, 3, 2, 0, 100, 36]
        ]);
    });

    it('groups interleaved lanes without renumbering a segment', () => {
        // Lanes are assigned at MINT time, so a real bar is monotonic; interleaving anyway is
        // what proves the grouping is a grouping and not a sort. Blocks arrive 0,1,0,1 by lane:
        // row 0 is blocks 0 and 2, row 1 is blocks 1 and 3, each row lays out its own pair, and
        // the tab order is row-grouped (0, 2, then 1, 3).
        const layout = layoutContextBar(
            [
                tool({ id: 'a', chars: 100, at: T, endedAt: T + 1_000 }),
                tool({ id: 'b', chars: 100, lane: 1, at: T, endedAt: T + 1_000 }),
                tool({ id: 'c', chars: 100, at: T, endedAt: T + 1_000 }),
                tool({ id: 'd', chars: 100, lane: 1, at: T, endedAt: T + 1_000 })
            ],
            100
        );

        expect(layout.rows.map((row) => row.segments.map((s) => s.index))).toEqual([[0, 2], [1, 3]]);
        expect(layout.segments.map((s) => s.index)).toEqual([0, 2, 1, 3]);
        // Two equal spans in a row of two: the 2px seam, then 49/49 — the same arithmetic the
        // flat strip has always run, now per row.
        expect(layout.rows.map((row) => row.segments.map((s) => [s.x, s.width]))).toEqual([
            [[0, 49], [51, 49]],
            [[0, 49], [51, 49]]
        ]);
        expect(layout.rows.map((row) => [row.offsetY, row.heightPx])).toEqual([
            [0, 36],
            [38, 36]
        ]);
        expect(layout.heightPx).toBe(74);
    });

    it('normalizes HEIGHT per row, so a compaction row is as readable as the first', () => {
        // THE point of lanes. Lane 0 holds a 1,000-character block, so ITS 100-character block
        // is a 4px bar. Lane 1 holds a 10-character block, so its 5-character block is an 18px
        // bar — bigger than the lane-0 block that is twenty times its size. One shared
        // denominator would have flattened the whole second row to the floor, and the reader
        // would see nothing but the fact that a second row exists.
        const layout = layoutContextBar(
            [
                tool({ id: 'big', chars: 1_000, at: T, endedAt: T + 1_000 }),
                tool({ id: 'mid', chars: 100, at: T, endedAt: T + 1_000 }),
                tool({ id: 'small', chars: 10, lane: 1, at: T, endedAt: T + 1_000 }),
                tool({ id: 'tiny', chars: 5, lane: 1, at: T, endedAt: T + 1_000 })
            ],
            600
        );

        expect(layout.rows.map((row) => row.maxChars)).toEqual([1_000, 10]);
        expect(layout.rows[0].segments.map((s) => [s.heightPx, s.heightShare])).toEqual([
            [36, 1],
            [4, 0.1]
        ]);
        expect(layout.rows[1].segments.map((s) => [s.heightPx, s.heightShare])).toEqual([
            [36, 1],
            [18, 0.5]
        ]);
        // The bar-level figure is the biggest of the denominators (a host reads it off
        // `data-max-chars`); the per-row authorities are on the rows themselves.
        expect(layout.maxChars).toBe(1_000);
    });

    it('divides WIDTH per row, so one row never shrinks another', () => {
        // Five blocks in lane 0 and ONE in lane 1, in a 100px track. Lane 0 shrinks its gap to 2
        // and splits 92px five ways; lane 1 has a single segment, so it keeps the whole 100px and
        // needs no gap at all. A shared track would have made the lone block a 20px bar beside
        // four 18px ones — the same "one row's data decides another row's picture" bug, sideways.
        const layout = layoutContextBar(
            [
                ...Array.from({ length: 5 }, (_, index) => tool({ id: `l0-${index}`, chars: 10, at: T, endedAt: T + 1_000 })),
                tool({ id: 'alone', chars: 10, lane: 1, at: T, endedAt: T + 1_000 })
            ],
            100
        );

        expect(layout.rows.map((row) => [row.gapPx, row.trackPx, row.rightEdge])).toEqual([
            [2, 92, 100],
            [0, 100, 100]
        ]);
        expect(layout.rows[0].segments.map((s) => [s.x, s.width])).toEqual([
            [0, 18],
            [20, 19],
            [41, 18],
            [61, 19],
            [82, 18]
        ]);
        expect(layout.rows[1].segments.map((s) => [s.x, s.width])).toEqual([[0, 100]]);
        // Bar-level figures are the TOP row's (documented on `ContextBarLayout`), because the
        // seam is where the reader's eye enters the bar.
        expect([layout.gapPx, layout.trackPx]).toEqual([2, 92]);
    });

    it('sums the bar-wide figures across rows and keeps the per-row ones separate', () => {
        // The accessible name and the caption speak for the WHOLE bar, so the two figures they
        // print are sums; the per-row figures stay on the rows that own them.
        const layout = layoutContextBar(
            [
                tool({ id: 'a', kind: 'user', name: 'prompt', endedAt: undefined, chars: 10 }),
                tool({ id: 'b', chars: 10, lane: 1, at: T, endedAt: T + 500 })
            ],
            200
        );

        expect(layout.durationsUnknown).toBe(1);
        expect(layout.totalDurationMs).toBe(500);
        expect(layout.rows.map((row) => [row.durationsUnknown, row.totalDurationMs])).toEqual([
            [1, undefined],
            [0, 500]
        ]);
    });

    it('is byte for byte the single-lane strip when no block names a lane', () => {
        // THE PARITY PROOF. The same two blocks with NO `lane` and with an explicit `lane: 0`
        // produce the same GEOMETRY, field for field, and that geometry has one row at offset 0
        // whose box IS the bar's box (no seam is reserved above or below it). The block payloads
        // are compared separately below: `lane` absent vs present is a fact about what the server
        // SENT, and it must not leak into one pixel of what the reader gets.
        const absent = [tool({ id: 'a', chars: 300 }), tool({ id: 'b', chars: 100 })];
        const explicit = [tool({ id: 'a', chars: 300, lane: 0 }), tool({ id: 'b', chars: 100, lane: 0 })];

        const baseline = layoutContextBar(absent, 600);
        const written = layoutContextBar(explicit, 600);

        // Everything but the block references: every number, both axes, plus the row table.
        const geometry = (layout: ContextBarLayout) => ({
            ...layout,
            segments: layout.segments.map(({ block: _block, ...rest }) => rest),
            rows: layout.rows.map((row) => ({ ...row, segments: row.segments.map(({ block: _block, ...rest }) => rest) }))
        });

        expect(geometry(written)).toEqual(geometry(baseline));
        // The only difference between the two bars is the byte the server did or did not send.
        expect('lane' in baseline.segments[0].block).toBe(false);
        expect(written.segments[0].block.lane).toBe(0);
        expect(written.segments[1].block.lane).toBe(0);
        expect(baseline.lanes).toEqual(written.lanes);
        expect(baseline.lanes).toEqual([0]);
        expect(baseline.rows).toHaveLength(1);
        expect(baseline.rows[0].offsetY).toBe(0);
        // No second row means no seam, so the stacked total is exactly the strip's old box: the
        // canvas and the DOM row still reserve the same 36px they reserved before lanes.
        expect(baseline.heightPx).toBe(baseline.rows[0].heightPx);
        expect(baseline.heightPx).toBe(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX);
        // ...and every flat figure a lane-absent bar has ever published.
        expect([baseline.width, baseline.gapPx, baseline.trackPx, baseline.rightEdge, baseline.maxChars, baseline.heightPx]).toEqual([
            600,
            2,
            598,
            600,
            300,
            36
        ]);
        expect(baseline.segments.map((s) => [s.x, s.width, s.heightPx, s.lane, s.row])).toEqual([
            [0, 299, 36, 0, 0],
            [301, 299, 12, 0, 0]
        ]);
        // The top-level figures ARE the row's, which is what makes the per-row generalization a
        // no-op for a one-lane bar.
        expect([baseline.gapPx, baseline.trackPx, baseline.rightEdge, baseline.maxChars]).toEqual([
            baseline.rows[0].gapPx,
            baseline.rows[0].trackPx,
            baseline.rows[0].rightEdge,
            baseline.rows[0].maxChars
        ]);
        // ...and a one-lane bar shows no lane cue at all.
        expect(contextBarShowsLaneTagsOf(baseline.lanes)).toBe(false);
    });
});

describe('contextBarRowAt (C2 bands)', () => {
    // Two rows, one block each, 100px wide: row 0 occupies y 0..36, the seam is 36..38, and row 1
    // occupies 38..74. Both rows are one full-width bar, so any answer below is about the ROW.
    const stacked = layoutContextBar([tool({ id: 'a', chars: 100 }), tool({ id: 'b', chars: 100, lane: 1 })], 100);

    it('splits a seam at its midpoint and clamps the ends', () => {
        expect(stacked.rows.map((row) => [row.offsetY, row.heightPx])).toEqual([
            [0, 36],
            [38, 36]
        ]);

        expect([0, 10, 36].map((y) => contextBarRowAt(stacked, y))).toEqual([0, 0, 0]);
        // The seam itself is 36..38 and its midpoint 37 is the tie, resolved to the row ABOVE.
        expect([37, 37.5, 38].map((y) => contextBarRowAt(stacked, y))).toEqual([0, 1, 1]);
        // Inside row 1, and past the bottom of the bar: the last row owns the remainder, exactly
        // as the last segment owns the remainder of its row.
        expect([73, 74, 200].map((y) => contextBarRowAt(stacked, y))).toEqual([1, 1, 1]);
        // No number, or a negative one, is the TOP of the bar — never a guess at a band.
        expect([Number.NaN, -5].map((y) => contextBarRowAt(stacked, y))).toEqual([0, 0]);
    });

    it('answers 0 for a single-row bar whatever the y is', () => {
        const flat = layoutContextBar([tool({ id: 'a', chars: 100 })], 100);

        expect([0, 10, 36, 900].map((y) => contextBarRowAt(flat, y))).toEqual([0, 0, 0, 0]);
    });
});

describe('contextBarSegmentAt, across rows (C2)', () => {
    // Lane 0 is ONE bar 100px wide with no gap; lane 1 is two (25px + 2px + 73px). So the same x
    // answers differently by row, and the gap that exists on one row does not exist on the other.
    const stacked = layoutContextBar(
        [
            tool({ id: 'a', chars: 100 }),
            tool({ id: 'b', chars: 100, lane: 1, at: T, endedAt: T + 1_000 }),
            tool({ id: 'c', chars: 100, lane: 1, at: T, endedAt: T + 3_000 })
        ],
        100
    );

    it('aims inside the row the pointer is on', () => {
        expect(stacked.rows.map((row) => row.segments.map((s) => [s.x, s.width]))).toEqual([
            [[0, 100]],
            [[0, 25], [27, 73]]
        ]);

        // y in row 0 -> the only block there; y in row 1 -> that row's columns.
        expect(contextBarSegmentAt(stacked, 25, 0)).toBe(0);
        expect(contextBarSegmentAt(stacked, 25, 38)).toBe(1);
        expect(contextBarSegmentAt(stacked, 26.5, 38)).toBe(2);
        // The gap between two row-1 columns still belongs to the NEARER column, and a tie goes
        // to the one on the LEFT.
        expect([25, 26].map((x) => contextBarSegmentAt(stacked, x, 38))).toEqual([1, 1]);
        // A y below the bar still resolves to the last row, whose columns it then aims inside.
        expect(contextBarSegmentAt(stacked, 60, 200)).toBe(2);
        // Omitting y asks for the top of the bar — the row a single-lane bar has.
        expect(contextBarSegmentAt(stacked, 25)).toBe(0);
    });

    it('bounds a miss by the resolved row, not by the widest row in the bar', () => {
        // Both rows are 100 wide here, so anything past 100 is a miss in either band, and a
        // negative x never resolves to a row at all.
        expect(contextBarSegmentAt(stacked, 101, 38)).toBe(-1);
        expect(contextBarSegmentAt(stacked, 101, 0)).toBe(-1);
        expect(contextBarSegmentAt(stacked, -1, 38)).toBe(-1);
        expect(contextBarSegmentAt(layoutContextBar([], 100), 10, 0)).toBe(-1);
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
