// The ONE context bar SURFACE, in both of its modes (T11: R7/R8; T26: R26/R27/R28).
//
// Two modes, one contract, and this file proves both halves of that sentence:
//
//   - DOM mode is what jsdom gets (`getContext('2d')` answers null without the `canvas`
//     package, which is exactly the guard ./context-bar.ts documents). It pins the element
//     vocabulary a screen reader and the stylesheet read: one lightweight button per
//     segment, carrying the kind/tone/state/character/span figures the model decided,
//     weighted by the model's flex share AND sized by the model's bar height.
//   - Canvas mode is what a browser gets, and it is pinned through a RECORDING fake context
//     rather than pixels: the assertions are the exact `fillRect` rectangles, fill styles and
//     alphas the geometry produced, so a change to the width math, the height band or the tone
//     table fails here with numbers, not a screenshot.
//
// PARITY (T26, R28) is proven by feeding BOTH modes the same fixture and asserting they
// report the same rectangles: the canvas' `fillRect` numbers and the DOM's inline heights and
// flex weights come from one `layoutContextBar` result, and the aim target is the segment's
// COLUMN in both modes — including the blank area above a short bar.
//
// Both halves also pin the rule the whole feature exists for: NOTHING is fetched by
// rendering. The bar calls its `onActivate` callback and stops; the request belongs to the
// dialog (./context-detail.test.ts) and to the tile (../ui/turns-context-bar.test.ts).
//
// F8 / uplift H5 pins the WORDING SPLIT on the un-in-prompt clause: a REASONING segment says
// `replay decided by the thinking policy` (the projector marks that whole class
// `inPrompt: false` per KIND, while `dropOldThoughts` decides per ENTRY), and every other
// un-in-prompt segment keeps the model's absolute byte-for-byte. ./context-bar.ts carries the
// argument for why the bar cannot resolve a per-entry verdict; the pins below are the exact
// strings, both modes.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/context-bar.test.ts

import type { ContextBlock } from '../../shared/turn-display';
import type { ContextBarModel } from '../view-context';
import {
    CONTEXT_BAR_GAP_PX,
    CONTEXT_BAR_LINE_HEIGHT_PX,
    CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_PX,
    CONTEXT_BAR_TRACK_HEIGHT_PX,
    CONTEXT_BAR_UNKNOWN_DURATION_PX,
    contextBarOf,
    layoutContextBar
} from '../view-context';
import type { ContextBarActivateInput } from './context-bar';
import {
    CONTEXT_BAR_DOM_LABEL_LIMIT,
    CONTEXT_BAR_ON_SEGMENT_TEXT,
    CONTEXT_BAR_THINKING_NOTE,
    mountContextBar,
    resolveContextBarTrackHeights
} from './context-bar';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fixtures: hand-written segments, hand-computed geometry
// ---------------------------------------------------------------------------

const block = (overrides: Partial<ContextBlock> = {}): ContextBlock => ({
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

const modelOf = (blocks: ContextBlock[]): ContextBarModel =>
    contextBarOf({ turnId: 't1', sections: [{ id: 't1:0', context: blocks } as never] });

const EMPTY_MODEL: ContextBarModel = {
    turnId: 't1',
    available: true,
    blocks: [],
    totalChars: 0,
    unpromptedChars: 0,
    counts: { user: 0, system: 0, reasoning: 0, assistant: 0, tool: 0 },
    charsByKind: { user: 0, system: 0, reasoning: 0, assistant: 0, tool: 0 },
    totalDurationMs: undefined,
    durationsUnknown: 0
};

// The three-segment fixture whose pixel geometry is asserted throughout. T26 (R27) made it a
// two-axis fixture on purpose: 100/200/300 CHARACTERS (the heights: 12/24/36 of a 36px box)
// over two 800ms spans plus one UNMEASURED prompt (the widths: the 8px baseline, then 294 and
// 294), with the model's 2px gaps at 10 and 306. In a 600px track that is
// 0+8, 10+294 and 306+294, and the right edge is exactly 600.
const THREE = [
    block({
        id: '0-user-prompt',
        kind: 'user',
        name: 'prompt',
        chars: 100,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        endedAt: undefined,
        eventFrom: undefined,
        eventTo: undefined
    }),
    block({
        id: '0-reasoning-3',
        kind: 'reasoning',
        name: 'reasoning',
        chars: 200,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        inPrompt: false
    }),
    block({ id: '0-tool-9', kind: 'tool', name: 'bash', chars: 300, state: 'error' })
];

const mount = (blocks: ContextBlock[] | undefined, options: Parameters<typeof mountContextBar>[0] = {}) => {
    const bar = mountContextBar({ width: 600, ...options });
    document.body.replaceChildren(bar.element);
    if (blocks !== undefined) bar.setModel(modelOf(blocks));

    return bar;
};

// ---------------------------------------------------------------------------
// The recording canvas context (the fake stands in for what jsdom cannot do)
// ---------------------------------------------------------------------------

type Paint = { x: number; y: number; width: number; height: number; fill: string; alpha: number };

const fakeContext = (): { context: CanvasRenderingContext2D; paints: Paint[]; texts: unknown[]; outlines: unknown[]; transforms: unknown[] } => {
    const paints: Paint[] = [];
    const texts: unknown[] = [];
    const outlines: unknown[] = [];
    const transforms: unknown[] = [];

    const context = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        globalAlpha: 1,
        font: '',
        textBaseline: '',
        // A repaint STARTS at `setTransform`, so each recorded frame is one repaint: an
        // assertion then reads exactly what is on screen, not everything ever painted.
        setTransform: (...args: unknown[]) => {
            paints.length = 0;
            texts.length = 0;
            outlines.length = 0;
            transforms.length = 0;
            transforms.push(args);
        },
        clearRect: () => undefined,
        fillRect: (x: number, y: number, width: number, height: number) => {
            paints.push({ x, y, width, height, fill: String(context.fillStyle), alpha: context.globalAlpha });
        },
        strokeRect: (...args: unknown[]) => outlines.push(args),
        fillText: (...args: unknown[]) => texts.push(args)
    } as unknown as CanvasRenderingContext2D;

    return { context, paints, texts, outlines, transforms };
};

const stubCanvas = (): ReturnType<typeof fakeContext> => {
    const fake = fakeContext();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => fake.context
    );

    return fake;
};

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete (window as { devicePixelRatio?: number }).devicePixelRatio;
});

// ---------------------------------------------------------------------------
// DOM mode (what a canvas-less host gets)
// ---------------------------------------------------------------------------

describe('context bar, DOM mode', () => {
    it('paints one lightweight button per segment with the model figures', () => {
        const bar = mount(THREE);
        expect(bar.mode()).toBe('dom');

        const segments = bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment');
        expect(segments).toHaveLength(3);
        expect(Array.from(segments).map((button) => button.dataset.index)).toEqual(['0', '1', '2']);
        expect(Array.from(segments).map((button) => button.dataset.blockId)).toEqual(['0-user-prompt', '0-reasoning-3', '0-tool-9']);
        expect(Array.from(segments).map((button) => button.dataset.kind)).toEqual(['user', 'reasoning', 'tool']);
        // Tone from kind/state only: neutral, amber, red.
        expect(Array.from(segments).map((button) => button.dataset.tone)).toEqual(['neutral', 'reasoning', 'error']);
        expect(Array.from(segments).map((button) => button.dataset.chars)).toEqual(['100', '200', '300']);
        expect(Array.from(segments).map((button) => button.dataset.state)).toEqual(['', '', 'error']);
        // T26 (R27): the SPAN, not the characters, is what the weight encodes. The prompt was
        // never bracketed, so it sits at the honest baseline and says so in its own data.
        expect(Array.from(segments).map((button) => button.dataset.durationMs)).toEqual(['', '800', '800']);
        expect(Array.from(segments).map((button) => button.dataset.durationKnown)).toEqual(['false', 'true', 'true']);
        // The flex weights ARE the layout shares, so both modes are sized by one arithmetic.
        expect(Array.from(segments).map((button) => button.style.flexGrow)).toEqual(['134', '4933', '4933']);
        expect(Array.from(segments).map((button) => button.style.flexBasis)).toEqual(['0%', '0%', '0%']);
        // ...and the inline heights ARE the layout heights: 100/200/300 characters of a
        // 300-character maximum is 12/24/36 pixels of a 36-pixel (2 line-height) box.
        expect(Array.from(segments).map((button) => button.style.height)).toEqual(['12px', '24px', '36px']);
        expect(Array.from(segments).map((button) => button.dataset.heightPx)).toEqual(['12', '24', '36']);
        expect(Array.from(segments).map((button) => button.dataset.heightShare)).toEqual(['0.3333', '0.6667', '1']);
        // The row reserves exactly the strip's own box, which is what seats the bars.
        expect(bar.element.querySelector('.context-bar-segments')?.style.height).toBe(`${CONTEXT_BAR_MAX_TRACK_HEIGHT_PX}px`);
    });

    it('carries the exact hover and accessible text for every segment', () => {
        const bar = mount(THREE);
        const [first, second, third] = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));

        // R27: a segment with no recorded span says so in the tooltip as plainly as the bar
        // says it in pixels.
        expect(first.title).toBe('prompt · user · 100 characters · time not recorded');
        expect(first.getAttribute('aria-label')).toBe('1 of 3 · prompt · user · 100 characters · time not recorded');
        expect(second.title).toBe('reasoning · reasoning · 200 characters · 800ms · replay decided by the thinking policy');
        expect(third.title).toBe('bash · tool · error · 300 characters · args 20 + result 1,184 · 800ms');
    });

    it('says the thinking POLICY on a thinking segment, and keeps the absolute everywhere else (uplift F8 / H5)', () => {
        // WHY THIS IS THE PIN. `../view-context.ts` prints one clause for EVERY block the server
        // marks `inPrompt !== true`, and `../server/turn-projector.ts` mints that flag for the
        // whole REASONING CLASS. Once `dropOldThoughts` exists (shipped default `turn`, which
        // replays the OPEN turn's thinking) that clause is no longer a property of the class,
        // and the bar has no per-entry verdict to read — only the block-detail route can name
        // the entry behind a segment. So the bar states the policy for thinking, and keeps the
        // fact for every segment that is un-in-prompt for a real reason.
        expect(CONTEXT_BAR_THINKING_NOTE).toBe('replay decided by the thinking policy');

        const bar = mount([
            // A thinking segment, `inPrompt: false` by KIND: the policy note, not the absolute.
            block({ id: '0-reasoning-a', kind: 'reasoning', name: 'reasoning', chars: 100, inPrompt: false }),
            // A thinking segment the server marks IN the prompt: the model's string, clause-free.
            // The substitution tracks the verdict, never the kind.
            block({ id: '0-reasoning-b', kind: 'reasoning', name: 'thought', chars: 50, inPrompt: true }),
            // A NON-thinking segment with the same flag: there the sentence is a fact, so it
            // stays byte-identical to what the model prints.
            block({ id: '0-user-prompt', kind: 'user', name: 'prompt', chars: 40, inPrompt: false })
        ]);

        const [withheld, replayed, prompt] = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));

        expect(withheld.title).toBe('reasoning · reasoning · 100 characters · 800ms · replay decided by the thinking policy');
        expect(replayed.title).toBe('thought · reasoning · 50 characters · 800ms');
        expect(prompt.title).toBe('prompt · user · 40 characters · 800ms · not replayed into the prompt');
        expect(withheld.getAttribute('aria-label')).toBe('1 of 3 · reasoning · reasoning · 100 characters · 800ms · replay decided by the thinking policy');
        // The absolute is gone from the thinking segment, and the bar does not over-correct into
        // an "always"/"never" claim of its own (acceptance H5 asks for exactly that).
        expect(withheld.title).not.toContain('not replayed');
        expect(withheld.title).not.toContain('never');
        // THE AGGREGATE, same rule: 140 un-in-prompt characters here, 40 of them NOT thinking, so
        // the model's literal count stands — zeroing it out would hide a real omission.
        expect(bar.element.getAttribute('aria-label')).toBe(
            'context bar: width is time taken, height is recorded characters · 3 segments · 190 characters' +
                ' · 2.4s of recorded time · 140 characters not replayed into the prompt'
        );
    });

    it('labels the segments only where the bar is big enough to hold a name', () => {
        // Three gates, all the model's: under the crowding limit, wide enough for the glyphs,
        // and one line-height tall enough for the text. The prompt bar is 8px wide and 12px
        // tall, so it carries no name — and the canvas mode skips the same segment (R28).
        const few = mount(THREE);

        expect(Array.from(few.element.querySelectorAll('.context-bar-segment-name')).map((node) => node.textContent)).toEqual([
            'reasoning',
            'bash'
        ]);

        const many = mount(Array.from({ length: CONTEXT_BAR_DOM_LABEL_LIMIT + 1 }, (_, index) => block({ id: `b${index}` })));
        expect(many.element.querySelectorAll('.context-bar-segment')).toHaveLength(CONTEXT_BAR_DOM_LABEL_LIMIT + 1);
        expect(many.element.querySelectorAll('.context-bar-segment-name')).toHaveLength(0);
    });

    it('explains both axes on the group and puts only the count on the caption', () => {
        const bar = mount(THREE);

        // TWO audiences, one set of figures. The ACCESSIBLE name keeps the label phrase AND
        // the character totals, so a screen reader still hears what the strip is and how
        // large it is; the VISIBLE line is the segment COUNT only (T22/R24) — the totals it
        // used to print under every turn were numbers the reader never acted on, and they
        // remain one aim away on the segment they describe.
        expect(bar.element.getAttribute('role')).toBe('group');
        expect(bar.element.getAttribute('aria-label')).toBe(
            'context bar: width is time taken, height is recorded characters · 3 segments · 600 characters' +
                ' · 1.6s of recorded time · 1 segment has no recorded time · 200 characters\' replay decided by the thinking policy'
        );
        expect(bar.element.querySelector('.context-bar-caption')?.textContent).toBe('3 segments');
        // The banned-on-screen wording (the user's screenshot): the visible line never
        // repeats the bar's name, and since R24 it prints no character totals either.
        expect(bar.element.querySelector('.context-bar-caption')?.textContent ?? '').not.toContain('context bar');
        expect(bar.element.querySelector('.context-bar-caption')?.textContent ?? '').not.toContain('characters');
        // The unit is still stated where the figure is read: the segment's own accessible
        // name, so the strip can never be mistaken for a token/context-window gauge.
        expect(
            bar.element.querySelectorAll<HTMLElement>('.context-bar-segment')[0].getAttribute('aria-label') ?? ''
        ).toContain('characters');
        expect(bar.element.dataset.segments).toBe('3');
        expect(bar.element.dataset.chars).toBe('600');
        expect(bar.element.dataset.empty).toBe('false');
        expect(bar.element.dataset.width).toBe('600');
        expect(bar.element.dataset.gapPx).toBe('2');
        // T26 (R27): both axes' geometry is readable off the element without a layout pass —
        // the strip's box, the ceiling it was capped to, the line-height that ceiling was
        // counted from, the height denominator, and how many bars are unmeasured baselines.
        expect(bar.element.dataset.heightPx).toBe('36');
        expect(bar.element.dataset.maxHeightPx).toBe(String(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX));
        expect(bar.element.dataset.lineHeightPx).toBe(String(CONTEXT_BAR_LINE_HEIGHT_PX));
        expect(bar.element.dataset.minHeightPx).toBe(String(CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX));
        expect(bar.element.dataset.maxChars).toBe('300');
        expect(bar.element.dataset.unknownDurations).toBe('1');
        expect(bar.element.dataset.totalDurationMs).toBe('1600');
        expect(bar.element.dataset.minSegmentPx).toBe(String(CONTEXT_BAR_MIN_SEGMENT_PX));
    });

    it('pluralizes the count exactly, and never says "1 segments"', () => {
        const one = mountContextBar({ width: 600 });
        document.body.replaceChildren(one.element);
        one.setModel(modelOf([THREE[0]]));
        expect(one.element.querySelector('.context-bar-caption')?.textContent).toBe('1 segment');

        const two = mountContextBar({ width: 600 });
        document.body.replaceChildren(two.element);
        two.setModel(modelOf(THREE.slice(0, 2)));
        expect(two.element.querySelector('.context-bar-caption')?.textContent).toBe('2 segments');

        one.destroy();
        two.destroy();
    });

    it('says so for an authoritative empty bar, in both text and data', () => {
        const bar = mountContextBar({ width: 600 });
        document.body.replaceChildren(bar.element);
        bar.setModel(EMPTY_MODEL);

        expect(bar.element.dataset.empty).toBe('true');
        expect(bar.element.dataset.segments).toBe('0');
        expect(bar.element.querySelectorAll('.context-bar-segment')).toHaveLength(0);
        // Same split as above: the phrase stays in the accessible name only, and an empty
        // strip still reserves the base box (the dashed "nothing recorded" state).
        expect(bar.element.getAttribute('aria-label')).toBe(
            'context bar: width is time taken, height is recorded characters · no recorded context'
        );
        expect(bar.element.querySelector('.context-bar-caption')?.textContent).toBe('no recorded context');
        expect(bar.element.dataset.heightPx).toBe(String(CONTEXT_BAR_TRACK_HEIGHT_PX));
        expect(bar.element.dataset.unknownDurations).toBe('0');
        expect(bar.element.dataset.totalDurationMs).toBe('');
    });

    it('activates exactly the segment the reader aimed at, and nothing else', () => {
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(THREE, { onActivate: (input) => activated.push(input) });
        document.body.replaceChildren(bar.element);

        const [, second] = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));
        second.click();
        second.click();

        expect(activated).toHaveLength(2);
        expect(activated[0]).toEqual({ block: THREE[1], index: 1, total: 3, source: 'pointer' });
        expect(bar.focused()).toBe(1);
        // Only the bar is a control: no card, no dialog, no nested button.
        expect(bar.element.querySelectorAll('button')).toHaveLength(3);
    });

    it('aims by the same column rule as the canvas when the click misses the buttons (R28)', () => {
        // The blank space above a short bar belongs to its column in BOTH modes. In DOM mode
        // the click lands on the row, so the fallback maps the pointer's x to the segment that
        // column stands for — and a click past the last column stays a click on nothing.
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(THREE, { onActivate: (input) => activated.push(input) });
        const rows = bar.element.querySelector('.context-bar-segments') as HTMLElement;

        // x=4 is inside segment 0's column (0+8), well above its 12px bar.
        rows.dispatchEvent(new MouseEvent('click', { clientX: 4, bubbles: true }));
        expect(activated).toEqual([{ block: THREE[0], index: 0, total: 3, source: 'pointer' }]);

        // x=400 is inside segment 2's column.
        rows.dispatchEvent(new MouseEvent('click', { clientX: 400, bubbles: true }));
        expect(activated[1]).toEqual({ block: THREE[2], index: 2, total: 3, source: 'pointer' });

        // And past the painted right edge: no segment, no request, no dialog.
        rows.dispatchEvent(new MouseEvent('click', { clientX: 601, bubbles: true }));
        expect(activated).toHaveLength(2);
    });

    it('activates the EXACT segment among hundreds, with its own provenance (R28)', () => {
        // 300 bars in a 600px track, every span and every character count different: each one
        // is ~1px wide, and what makes a click answerable is the model's `data-*` pair — the
        // block id and section the detail route needs, never a position the painter drifted.
        const many = Array.from({ length: 300 }, (_, index) =>
            block({ id: `b${index}`, sectionId: index % 2 === 0 ? 't1:0' : 't1:1', chars: index + 1, at: T, endedAt: T + 100 + index })
        );
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(many, { onActivate: (input) => activated.push(input) });
        const buttons = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));

        expect(buttons).toHaveLength(300);

        buttons[147].click();

        expect(activated).toHaveLength(1);
        expect(activated[0]).toEqual({ block: many[147], index: 147, total: 300, source: 'pointer' });
        expect(bar.element.dataset.segments).toBe('300');
        expect(bar.element.dataset.unknownDurations).toBe('0');
        // Every bar keeps a legible height and a pixel box, and the strip never overflows.
        expect(bar.layout().rightEdge).toBe(600);
        expect(buttons.every((button) => Number(button.dataset.heightPx) >= CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX)).toBe(true);
        expect(buttons.every((button) => Number(button.dataset.heightPx) <= CONTEXT_BAR_MAX_TRACK_HEIGHT_PX)).toBe(true);
        expect(buttons[0].style.height).toBe(`${CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX}px`);
        expect(buttons[299].style.height).toBe(`${CONTEXT_BAR_MAX_TRACK_HEIGHT_PX}px`);
    });

    it('renders the row gap the MODEL decided, so hundreds of bars cannot overflow the strip (R28)', () => {
        // The stylesheet ships the model gap (`gap: 2px` === `CONTEXT_BAR_GAP_PX`), which is what
        // the geometry divides the track by AS LONG AS IT FITS. `layoutContextBar` shrinks it when
        // the segments cannot afford it — 300 bars in 600px drop to 1px, 600 bars to 0 — and the
        // canvas paints the shrunk gaps. A flex row still paying 2px between items would need
        // 300 + 299*2 = 898px at n=300: `overflow: hidden` then cut away the third of the strip
        // the canvas paints, and `nearestIndex` aimed at columns the browser never laid out.
        const few = mount(THREE);

        expect(few.layout().gapPx).toBe(CONTEXT_BAR_GAP_PX);
        expect((few.element.querySelector('.context-bar-segments') as HTMLElement).style.gap).toBe('2px');

        const wide = mount(Array.from({ length: 600 }, (_, index) => block({ id: `b${index}` })));
        const wideRows = wide.element.querySelector('.context-bar-segments') as HTMLElement;

        // Every bar now fits the measured strip: painted widths + the gaps between them ARE the
        // width, which is the same invariant the canvas paints to (`rightEdge`).
        expect(wide.layout().gapPx).toBe(0);
        expect(wideRows.style.gap).toBe('0px');
        expect(wide.layout().segments.reduce((sum, segment) => sum + segment.width, 0)).toBe(wide.layout().trackPx);
        expect(wide.layout().rightEdge).toBe(600);

        const many = mount(Array.from({ length: 300 }, (_, index) => block({ id: `b${index}`, chars: index + 1, at: T, endedAt: T + 100 + index })));

        expect(many.layout().gapPx).toBe(1);
        expect((many.element.querySelector('.context-bar-segments') as HTMLElement).style.gap).toBe('1px');
        expect(many.layout().segments.reduce((sum, segment) => sum + segment.width + many.layout().gapPx, 0) - many.layout().gapPx).toBe(600);
    });

    it('moves the current segment with the keyboard and activates on Enter', () => {
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(THREE, { onActivate: (input) => activated.push(input) });
        const buttons = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));

        // Roving tabindex: Tab enters the bar ONCE, arrows walk it.
        expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1]);

        buttons[0].focus();
        expect(bar.focused()).toBe(0);

        buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(bar.focused()).toBe(1);
        expect(document.activeElement).toBe(buttons[1]);

        buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(document.activeElement).toBe(buttons[2]);
        expect(buttons[2].tabIndex).toBe(0);

        buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(bar.focused()).toBe(0);

        buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(activated).toEqual([{ block: THREE[0], index: 0, total: 3, source: 'keyboard' }]);

        buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(bar.focused()).toBe(0);
    });

    it('re-aims its geometry on a real width change', () => {
        // jsdom has no ResizeObserver, which is what the window-resize fallback is for.
        const bar = mount(THREE);
        expect(bar.layout().width).toBe(600);

        Object.defineProperty(bar.element, 'clientWidth', { configurable: true, get: () => 300 });
        window.dispatchEvent(new Event('resize'));

        expect(bar.layout().width).toBe(300);
        expect(bar.layout().trackPx).toBe(296);
        expect(bar.focused()).toBe(-1);
    });

    it('keeps the keyboard on the same SEGMENT while a live turn appends one', () => {
        const bar = mount([block({ id: 'a' }), block({ id: 'b' })]);
        const buttons = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));
        buttons[1].focus();
        expect(bar.focused()).toBe(1);

        // A new call at the END: the focused segment is still index 1, same id.
        bar.setModel(modelOf([block({ id: 'a' }), block({ id: 'b' }), block({ id: 'c' })]));
        expect(bar.focused()).toBe(1);

        // A block inserted BEFORE it: the index moves, the segment does not.
        bar.setModel(modelOf([block({ id: 'z' }), block({ id: 'a' }), block({ id: 'b' }), block({ id: 'c' })]));
        expect(bar.focused()).toBe(2);
        expect(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment')[2].dataset.blockId).toBe('b');

        // A block REMOVED under the reader: focus is gone rather than borrowed.
        bar.setModel(modelOf([block({ id: 'z' }), block({ id: 'a' })]));
        expect(bar.focused()).toBe(-1);
    });

    it('stops painting and reacting once destroyed', () => {
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(THREE, { onActivate: (input) => activated.push(input) });
        const before = bar.element.querySelectorAll('.context-bar-segment').length;

        bar.destroy();

        expect(bar.element.querySelectorAll('.context-bar-segment')).toHaveLength(0);
        expect(before).toBe(3);

        bar.setModel(modelOf(THREE));
        bar.setWidth(400);
        expect(bar.element.querySelectorAll('.context-bar-segment')).toHaveLength(0);

        // A late resize after teardown cannot resurrect the geometry.
        window.dispatchEvent(new Event('resize'));
        expect(bar.layout().segments).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Canvas mode (what a browser gets): the geometry, proven as recorded calls
// ---------------------------------------------------------------------------

describe('context bar, canvas mode', () => {
    it('paints exactly the model geometry, in the model tone colours', () => {
        const fake = stubCanvas();
        const bar = mount(THREE);

        expect(bar.mode()).toBe('canvas');
        expect(bar.element.dataset.mode).toBe('canvas');
        expect(bar.element.querySelectorAll('.context-bar-segment')).toHaveLength(0);
        expect(fake.paints).toEqual([
            { x: 0, y: 24, width: 8, height: 12, fill: '#d8deea', alpha: 1 },
            { x: 10, y: 12, width: 294, height: 24, fill: '#fbbf24', alpha: 1 },
            { x: 306, y: 0, width: 294, height: 36, fill: '#f87171', alpha: 1 }
        ]);
        // A label is painted only where the segment can hold it BOTH ways: wide enough for the
        // glyphs and one line-height tall for the text. The 8px-wide/12px-tall prompt bar fails
        // both, so the colour and the tooltip carry it; `reasoning` sits at the middle of its
        // own bar (y = 36 - 24/2 = 24) and `bash` at the middle of the full-height one.
        expect(fake.texts).toEqual([
            ['reasoning', 16, 24],
            ['bash', 312, 18]
        ]);
        expect(fake.outlines).toEqual([]);
    });

    it('seats every bar on the strip floor and caps the tallest at 2 line-heights (R27)', () => {
        const fake = stubCanvas();
        const bar = mount(THREE);

        // 36px is the ceiling (two 18px line-heights), and the tallest bar in a strip that
        // recorded 300 characters exactly reaches it; nothing exceeds it whatever the data.
        expect(bar.layout().heightPx).toBe(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX);
        expect(fake.paints.every((paint) => paint.y + paint.height === CONTEXT_BAR_MAX_TRACK_HEIGHT_PX)).toBe(true);
        expect(fake.paints.every((paint) => paint.height <= CONTEXT_BAR_MAX_TRACK_HEIGHT_PX)).toBe(true);

        // A strip with no characters at all is a row of minimum bars, and its BOX shrinks to
        // match rather than leaving 36px of blank space over a hairline.
        const blank = stubCanvas();
        const thin = mount([block({ chars: 0, id: 'a' }), block({ chars: 0, id: 'b' })]);

        expect(thin.layout().heightPx).toBe(CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX);
        expect(blank.paints.map((paint) => [paint.y, paint.height])).toEqual([
            [0, CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX],
            [0, CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX]
        ]);
    });

    it('scales the strip with the host line-height, not a hardcoded 36 (R27)', () => {
        // The painter resolves the vertical band from the DOCUMENT, so a host that declares
        // `--context-bar-line-height: 22px` gets 44px of ceiling: the same two text lines at
        // that host's scale. jsdom resolves nothing, which is why the fallback path below is
        // pinned too.
        const original = window.getComputedStyle;
        vi.spyOn(window, 'getComputedStyle').mockImplementation(
            () =>
                ({
                    getPropertyValue: (name: string) =>
                        name === '--context-bar-line-height' ? '22px' : name === '--context-bar-min-height' ? '6px' : ''
                }) as unknown as CSSStyleDeclaration
        );
        void original;

        const fake = stubCanvas();
        const bar = mount(THREE);
        const canvas = bar.element.querySelector('canvas') as HTMLCanvasElement;

        expect(bar.layout().lineHeightPx).toBe(22);
        expect(bar.layout().maxHeightPx).toBe(44);
        expect(bar.element.dataset.maxHeightPx).toBe('44');
        expect(canvas.style.height).toBe('44px');
        // 100/200/300 characters of a 300 maximum, on a 44px ceiling with a 6px floor.
        expect(fake.paints.map((paint) => [paint.height, paint.y])).toEqual([
            [15, 29],
            [29, 15],
            [44, 0]
        ]);

        // The pure resolver, pinned directly: tokens win, then nothing else in jsdom.
        expect(resolveContextBarTrackHeights(document.createElement('div'))).toEqual({
            lineHeightPx: 22,
            maxHeightPx: 44,
            minSegmentHeightPx: 6
        });

        vi.restoreAllMocks();

        expect(resolveContextBarTrackHeights(document.createElement('div'))).toEqual({
            lineHeightPx: CONTEXT_BAR_LINE_HEIGHT_PX,
            maxHeightPx: CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
            minSegmentHeightPx: CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX
        });
    });

    it('fades a running call without changing its hue', () => {
        const fake = stubCanvas();
        mount([block({ state: 'running' })]);

        expect(fake.paints).toEqual([
            { x: 0, y: 0, width: 600, height: CONTEXT_BAR_MAX_TRACK_HEIGHT_PX, fill: '#4ade80', alpha: 0.45 }
        ]);
    });

    it('scales the backing store by the device ratio and paints in CSS pixels', () => {
        const fake = stubCanvas();
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });

        const bar = mount(THREE);
        const canvas = bar.element.querySelector('canvas') as HTMLCanvasElement;

        // The BACKING STORE doubles; the CSS box and every rectangle stay in CSS pixels, which
        // is why "2 line-heights" is the same physical height at 1x and 2x (R27/R28).
        expect(canvas.width).toBe(1200);
        expect(canvas.height).toBe(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX * 2);
        expect(canvas.style.height).toBe(`${CONTEXT_BAR_MAX_TRACK_HEIGHT_PX}px`);
        expect(fake.transforms).toEqual([[2, 0, 0, 2, 0, 0]]);
        // The rects stay in CSS pixels because the transform does the scaling.
        expect(fake.paints[0]).toEqual({ x: 0, y: 24, width: 8, height: 12, fill: '#d8deea', alpha: 1 });
    });

    it('labels a segment only where the label fits', () => {
        const fake = stubCanvas();
        // One 1,204-character segment owns the whole 600px track and the full 36px height.
        mount([block()]);
        expect(fake.texts).toEqual([['read', 6, CONTEXT_BAR_MAX_TRACK_HEIGHT_PX / 2]]);

        // A 12-segment bar gives each segment ~48px: `delegate` (8 chars) needs 68px of the
        // model's 7px-per-glyph estimate, so nothing is labelled — the boundary is the model's.
        const narrow = stubCanvas();
        mount(Array.from({ length: 12 }, (_, index) => block({ id: `b${index}`, name: 'delegate' })));
        expect(narrow.texts).toEqual([]);
    });

    it('outlines the focused segment and states it in the live region', () => {
        const fake = stubCanvas();
        const bar = mount(THREE);

        bar.setFocused(1);

        // The ring hugs the PAINTED bar (x+1, top+1, w-2, h-2), not the whole column: that is
        // the thing the reader is looking at.
        expect(fake.outlines).toEqual([[11, 13, 292, 22]]);
        expect(bar.element.querySelector('.context-bar-live')?.textContent).toBe(
            '2 of 3 · reasoning · reasoning · 200 characters · 800ms · replay decided by the thinking policy'
        );
        expect(bar.element.title).toBe('reasoning · reasoning · 200 characters · 800ms · replay decided by the thinking policy');

        bar.setFocused(-1);
        expect(bar.element.querySelector('.context-bar-live')?.textContent).toBe('');
    });

    it('gives a screen reader every segment as text, and stops above the documented limit', () => {
        const stub = stubCanvas();
        const bar = mount(THREE);
        void stub;

        expect(Array.from(bar.element.querySelectorAll('.context-bar-option')).map((node) => node.textContent)).toEqual([
            '1 of 3 · prompt · user · 100 characters · time not recorded',
            '2 of 3 · reasoning · reasoning · 200 characters · 800ms · replay decided by the thinking policy',
            '3 of 3 · bash · tool · error · 300 characters · args 20 + result 1,184 · 800ms'
        ]);
        expect(bar.element.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');

        // 601 segments: the option list would cost more than it tells, so the live region
        // and the caption become the contract (documented in ./context-bar.ts).
        const many = mount(Array.from({ length: 601 }, (_, index) => block({ id: `b${index}` })));
        expect(many.element.querySelectorAll('.context-bar-option')).toHaveLength(0);
        many.setFocused(600);
        expect(many.element.querySelector('.context-bar-live')?.textContent).toContain('601 of 601');
    });

    it('hit-tests a pointer against the painted track', () => {
        const activated: ContextBarActivateInput[] = [];
        const fake = stubCanvas();
        const bar = mount(THREE, { onActivate: (input) => activated.push(input) });
        void fake;

        const canvas = bar.element.querySelector('canvas') as HTMLCanvasElement;
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 400, bubbles: true }));
        expect(activated).toEqual([{ block: THREE[2], index: 2, total: 3, source: 'pointer' }]);

        // A point in the 2px gap belongs to the nearer segment, not to nobody.
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 9, bubbles: true }));
        expect(activated[1]).toEqual({ block: THREE[0], index: 0, total: 3, source: 'pointer' });

        // Past the painted edge is a miss: an empty click must not open a dialog.
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 601, bubbles: true }));
        expect(activated).toHaveLength(2);

        // Hover moves the current segment (and the highlight) without activating.
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, bubbles: true }));
        expect(bar.focused()).toBe(1);
        expect(activated).toHaveLength(2);
    });

    it('hit-tests the COLUMN above a short bar, not the painted pixels (R27/R28)', () => {
        // The first bar is 8px wide and 12px tall inside a 36px box: a pointer level with the
        // TOP of the strip is still inside its column, and the documented policy is that the
        // column answers — the same x rule the DOM fallback reproduces (R28).
        const activated: ContextBarActivateInput[] = [];
        stubCanvas();
        const bar = mount(THREE, { onActivate: (input) => activated.push(input) });
        const canvas = bar.element.querySelector('canvas') as HTMLCanvasElement;

        expect(bar.layout().segments[0].heightPx).toBe(12);
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 4, bubbles: true }));
        expect(activated).toEqual([{ block: THREE[0], index: 0, total: 3, source: 'pointer' }]);
    });

    it('walks the segments from the keyboard and activates on Space', () => {
        const activated: ContextBarActivateInput[] = [];
        stubCanvas();
        const bar = mount(THREE, { onActivate: (input) => activated.push(input) });

        // Canvas mode has one focusable element for the whole strip.
        expect(bar.element.tabIndex).toBe(0);

        bar.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(bar.focused()).toBe(0);
        bar.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(bar.focused()).toBe(1);
        bar.element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

        expect(activated).toEqual([{ block: THREE[1], index: 1, total: 3, source: 'keyboard' }]);
    });

    it('paints hundreds of segments into one element', () => {
        const fake = stubCanvas();
        const blocks = Array.from({ length: 300 }, (_, index) => block({ id: `b${index}`, chars: index + 1 }));
        const bar = mount(blocks);
        const geometry = layoutContextBar(blocks, 600);

        expect(fake.paints).toHaveLength(300);
        expect(fake.paints.map((paint) => [paint.x, paint.width])).toEqual(geometry.segments.map((segment) => [segment.x, segment.width]));
        expect(bar.element.querySelectorAll('canvas')).toHaveLength(1);
        expect(bar.element.querySelectorAll('button')).toHaveLength(0);
        expect(fake.paints.at(-1)?.x).toBeLessThan(600);
    });

    it('clears the track and stops painting when the bar is cleared or destroyed', () => {
        const fake = stubCanvas();
        const bar = mount(THREE);
        const before = fake.paints.length;

        bar.clear();
        expect(fake.paints).toHaveLength(0);

        bar.setModel(modelOf(THREE));
        expect(fake.paints).toHaveLength(3);

        bar.destroy();
        bar.setModel(modelOf(THREE));
        expect(fake.paints).toHaveLength(3);
        expect(before).toBe(3);
    });

    it('reads its colours from the host theme when one declares them', () => {
        // A themed host wins over the palette constant, which is what lets a future
        // light theme restyle the bar without touching the painter.
        const original = window.getComputedStyle;
        vi.spyOn(window, 'getComputedStyle').mockImplementation(
            () => ({ getPropertyValue: (name: string) => (name === '--ok' ? 'rgb(1, 2, 3)' : '') }) as unknown as CSSStyleDeclaration
        );
        void original;

        const fake = stubCanvas();
        mount([block({ state: 'ok' })]);

        expect(fake.paints[0].fill).toBe('rgb(1, 2, 3)');
        expect(fake.paints[0].alpha).toBe(1);
    });

    it('keeps its in-segment label in the track colour, not the tone', () => {
        const fake = stubCanvas();
        mount([block()]);

        // The segment IS the background, so the text is the dark track constant.
        expect(fake.texts).toEqual([['read', 6, CONTEXT_BAR_MAX_TRACK_HEIGHT_PX / 2]]);
        expect(CONTEXT_BAR_ON_SEGMENT_TEXT).toBe('#0b0d12');
    });

    it('sizes its geometry from the painted canvas box, never the padded wrapper (T27 parity)', () => {
        // `.context-bar` carries `padding: 4px`, so `element.clientWidth` is 8px WIDER than the
        // surface the geometry is painted into (the canvas is `width: 100%` of the content box).
        // Sizing from the wrapper squeezed every bar by that ratio and drifted the pointer
        // mapping, which measures the canvas' own rect — and it stays drifted in a host with no
        // `ResizeObserver` to correct it. The painted surface is the track; the wrapper is not.
        stubCanvas();
        const bar = mount(THREE);
        const canvas = bar.element.querySelector('canvas') as HTMLCanvasElement;

        Object.defineProperty(canvas, 'clientWidth', { configurable: true, get: () => 596 });
        Object.defineProperty(bar.element, 'clientWidth', { configurable: true, get: () => 604 });
        window.dispatchEvent(new Event('resize'));

        expect(bar.layout().width).toBe(596);
        expect(bar.element.dataset.width).toBe('596');
        // No phantom 8px of track: the segments end on the measured edge, and a click at the far
        // right of the painted canvas hits the last bar rather than landing beyond it.
        expect(bar.layout().rightEdge).toBe(596);

        const activated: ContextBarActivateInput[] = [];
        bar.setActivate((input) => activated.push(input));
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 595, bubbles: true }));
        expect(activated).toEqual([{ block: THREE[2], index: 2, total: 3, source: 'pointer' }]);
    });

    it('paints exactly what the layout says, bottom-aligned, at any segment count (R27/R28)', () => {
        // Hundreds of segments, mixed spans (some unmeasured) and mixed characters: every
        // painted rectangle must equal the model's, seated on the strip's floor. The DOM mode
        // asserts the SAME layout numbers off its inline styles (above), which is what makes
        // the two renderers one widget rather than two pictures.
        const fake = stubCanvas();
        const blocks = Array.from({ length: 200 }, (_, index) =>
            block({ id: `b${index}`, chars: index * 37, ...(index % 3 === 0 ? { endedAt: undefined } : { endedAt: T + index * 11 }) })
        );
        const bar = mount(blocks);
        const layout = bar.layout();

        expect(fake.paints).toHaveLength(200);
        expect(fake.paints.map((paint) => [paint.x, paint.y, paint.width, paint.height])).toEqual(
            layout.segments.map((segment) => [segment.x, layout.heightPx - segment.heightPx, segment.width, segment.heightPx])
        );
        // Nothing overflows the box or exceeds the 2-line ceiling, and EVERY unmeasured segment
        // paints at the same baseline width — one constant, not an invented per-call span.
        expect(fake.paints.every((paint) => paint.y + paint.height === layout.heightPx)).toBe(true);
        expect(layout.maxHeightPx).toBe(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX);
        expect(layout.durationsUnknown).toBe(67);

        const unknownShares = layout.segments.filter((segment) => !segment.durationKnown).map((segment) => segment.share);

        // The MODEL is exact: every unmeasured segment holds the identical baseline share. The
        // painted pixels then round the cumulative cursor, which can alternate a 2.98px share
        // between 2px and 3px — a stated 1px rounding artifact, never a different measurement.
        expect(unknownShares.every((share) => share === unknownShares[0])).toBe(true);
        expect(unknownShares[0]).toBeCloseTo(layout.unknownDurationPx / layout.trackPx, 12);

        const unknownWidths = layout.segments.filter((segment) => !segment.durationKnown).map((segment) => segment.width);

        expect(Math.max(...unknownWidths) - Math.min(...unknownWidths)).toBeLessThanOrEqual(1);
        expect(unknownWidths.every((width) => width >= 1)).toBe(true);
        expect(layout.segments.filter((segment) => segment.durationKnown).every((segment) => segment.durationMs !== undefined)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// C2 — LANES: one stacked row per lane, in both renderers
// ---------------------------------------------------------------------------

// The fixture: lane 0 holds the prompt (unmeasured, 100 chars) and one 800ms call (300 chars);
// lane 1 — the row a compaction minted — holds a 1.6s call (40 chars) and a 400ms thinking
// window (20 chars). Every number below is that bar's geometry at 600px:
//
//   row 0 (offsetY 0,  heightPx 36): prompt 0+8 (12px tall, the 8px honest baseline),
//                                    read  10+590 (36px tall, 300 chars is this row's maximum)
//   seam                                2px, `CONTEXT_BAR_ROW_GAP_PX`
//   row 1 (offsetY 38, heightPx 36): bash       0+478 (36px, this ROW's maximum is 40 chars)
//                                    reasoning 480+120 (18px, half of 40)
//   the bar's box                      36 + 2 + 36 = 74
//
// The heights are the whole point: lane 1's 40-character block reaches the ceiling while lane 0's
// 300-character block is 36 and its 100-character prompt is 12 — each row normalizes against its
// OWN biggest block, so a second row is as readable as the first.
const LANED = [
    block({
        id: '0-user-prompt',
        kind: 'user',
        name: 'prompt',
        chars: 100,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        endedAt: undefined,
        eventFrom: undefined,
        eventTo: undefined
    }),
    block({ id: '0-tool-7', name: 'read', chars: 300 }),
    block({ id: '2-tool-9', name: 'bash', chars: 40, at: T, endedAt: T + 1_600, lane: 1 }),
    block({
        id: '2-reasoning-4',
        kind: 'reasoning',
        name: 'reasoning',
        chars: 20,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        at: T,
        endedAt: T + 400,
        lane: 1
    })
];

describe('context bar, multi-lane (C2)', () => {
    it('stacks one DOM row per lane, each sized and gapped by its OWN row', () => {
        const bar = mount(LANED);

        expect(bar.mode()).toBe('dom');
        expect(bar.element.querySelectorAll('.context-bar-rows')).toHaveLength(1);

        const rows = Array.from(bar.element.querySelectorAll<HTMLElement>('.context-bar-segments'));

        expect(rows).toHaveLength(2);
        // Rows are the model's rows, topmost first, and each says which lane it is.
        expect(rows.map((row) => [row.dataset.row, row.dataset.lane])).toEqual([
            ['0', '0'],
            ['1', '1']
        ]);
        // Each row reserves its OWN band (36px, its tallest bar), not the stack's 74px, and each
        // renders the gap ITS own geometry could afford.
        expect(rows.map((row) => row.style.height)).toEqual(['36px', '36px']);
        expect(rows.map((row) => row.style.gap)).toEqual(['2px', '2px']);

        // The buttons are the same widgets as ever — flat `data-index`, block id, flex weight and
        // inline height from the model — only now they live in their lane's row. Row 1's 20-char
        // thinking window is an 18px bar because 20 is half of 40, this row's maximum, while row
        // 0's 100-char prompt is a 12px bar. One shared denominator would have flattened lane 1.
        expect(
            rows.map((row) =>
                Array.from(row.querySelectorAll<HTMLButtonElement>('.context-bar-segment')).map((button) => [
                    button.dataset.index,
                    button.dataset.blockId,
                    button.style.height,
                    button.style.flexGrow,
                    button.dataset.heightPx
                ])
            )
        ).toEqual([
            [
                ['0', '0-user-prompt', '12px', '134', '12'],
                ['1', '0-tool-7', '36px', '9866', '36']
            ],
            [
                ['2', '2-tool-9', '36px', '8000', '36'],
                ['3', '2-reasoning-4', '18px', '2000', '18']
            ]
        ]);
    });

    it('publishes the lanes on the element and states them in the caption', () => {
        const bar = mount(LANED);

        expect(bar.element.dataset.segments).toBe('4');
        expect(bar.element.dataset.lanes).toBe('2');
        expect(bar.element.dataset.laneTags).toBe('true');
        // The bands, readable without a layout pass: 0 and 38 inside a 74px box.
        expect(bar.element.dataset.rowOffsets).toBe('0,38');
        expect(bar.element.dataset.heightPx).toBe('74');
        // The bar-wide figures are sums/maxima across rows: 2.8s of recorded time, one unmeasured
        // segment (the prompt), and the biggest block ANYWHERE in the bar (300 characters).
        expect(bar.element.dataset.totalDurationMs).toBe('2800');
        expect(bar.element.dataset.unknownDurations).toBe('1');
        expect(bar.element.dataset.maxChars).toBe('300');
        // The compaction is visible in words too (T22/R24 kept the caption minimal; this is the
        // one figure the row stack genuinely added).
        expect(bar.element.querySelector('.context-bar-caption')?.textContent).toBe('4 segments · 2 lanes');

        // A11y: each row announces its lane, so a reader who cannot see the tags still knows which
        // lane a segment belongs to.
        const rows = Array.from(bar.element.querySelectorAll<HTMLElement>('.context-bar-segments'));

        expect(rows.map((row) => [row.getAttribute('role'), row.getAttribute('aria-label')])).toEqual([
            ['group', 'context bar lane 0'],
            ['group', 'context bar lane 1']
        ]);
    });

    it('tags the rows only when the reader could misread the bar', () => {
        const laned = mount(LANED);

        // The tags are DOM text in both modes, positioned into the band they name.
        expect(
            Array.from(laned.element.querySelectorAll<HTMLElement>('.context-bar-lane')).map((tag) => [
                tag.textContent,
                tag.dataset.lane,
                tag.dataset.row,
                tag.style.top,
                tag.style.height,
                tag.getAttribute('aria-label')
            ])
        ).toEqual([
            ['L0', '0', '0', '0px', '36px', 'context bar lane 0'],
            ['L1', '1', '1', '38px', '36px', 'context bar lane 1']
        ]);

        // PARITY: a lane-absent bar shows NO cue at all — no tag, no row role, no row label, and
        // the same caption it always had. The wrapper is the only structural change it sees.
        const flat = mount(THREE);

        expect(flat.element.querySelectorAll('.context-bar-lane')).toHaveLength(0);
        expect(flat.element.querySelector('.context-bar-lanes')?.hidden).toBe(true);
        expect(flat.element.dataset.lanes).toBe('1');
        expect(flat.element.dataset.laneTags).toBe('false');
        expect(flat.element.dataset.rowOffsets).toBe('0');

        const single = flat.element.querySelector<HTMLElement>('.context-bar-segments') as HTMLElement;

        expect(flat.element.querySelectorAll('.context-bar-segments')).toHaveLength(1);
        expect(single.dataset.row).toBe('0');
        expect(single.dataset.lane).toBe('0');
        expect(single.getAttribute('role')).toBeNull();
        expect(single.getAttribute('aria-label')).toBeNull();
        expect(single.style.height).toBe(`${CONTEXT_BAR_MAX_TRACK_HEIGHT_PX}px`);
        expect(flat.element.querySelector('.context-bar-caption')?.textContent).toBe('3 segments');

        // One row, but NOT lane 0: its lane-0 blocks are gone, and a reader who cannot see the row
        // would otherwise assume an ordinary strip. The tag appears; the caption still says nothing.
        const second = mount([block({ id: 'a', chars: 100, lane: 2 }), block({ id: 'b', chars: 50, lane: 2 })]);

        expect(
            Array.from(second.element.querySelectorAll<HTMLElement>('.context-bar-lane')).map((tag) => [tag.textContent, tag.style.top])
        ).toEqual([['L2', '0px']]);
        expect(second.element.querySelector('.context-bar-caption')?.textContent).toBe('2 segments');
    });

    it('tabs into the top row and walks the flat cross-row sequence', () => {
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(LANED, { onActivate: (input) => activated.push(input) });
        const buttons = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));

        // Tab enters ONCE, at the first segment of the TOP row; everything else is -1.
        expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1]);

        buttons[1].focus();
        expect(bar.focused()).toBe(1);

        // ArrowRight at the END of row 0 crosses into row 1 — the reader follows the rows in the
        // order they are stacked, which is the flat order for a bar whose lanes are monotonic.
        buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(bar.focused()).toBe(2);
        expect(document.activeElement).toBe(buttons[2]);

        buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        expect(bar.focused()).toBe(1);
        expect(document.activeElement).toBe(buttons[1]);

        // Home/End name the ends of the WHOLE bar, not of one row, and the tab stop follows.
        buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        expect(bar.focused()).toBe(3);
        expect(buttons[3].tabIndex).toBe(0);

        buttons[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        expect(bar.focused()).toBe(0);

        buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(activated).toEqual([{ block: LANED[0], index: 0, total: 4, source: 'keyboard' }]);
    });

    it('activates the row a click landed in, and the column inside that row', () => {
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(LANED, { onActivate: (input) => activated.push(input) });
        const rows = Array.from(bar.element.querySelectorAll<HTMLElement>('.context-bar-segments'));

        // The same x means different things per row: row 0's columns are 0+8 and 10+590, row 1's
        // are 0+478 and 480+120. A click above a short bar still activates that bar's COLUMN, in
        // its own row (R27/R28 taken across the rows).
        rows[1].dispatchEvent(new MouseEvent('click', { clientX: 10, bubbles: true }));
        expect(activated).toEqual([{ block: LANED[2], index: 2, total: 4, source: 'pointer' }]);

        rows[0].dispatchEvent(new MouseEvent('click', { clientX: 10, bubbles: true }));
        expect(activated[1]).toEqual({ block: LANED[1], index: 1, total: 4, source: 'pointer' });

        rows[1].dispatchEvent(new MouseEvent('click', { clientX: 500, bubbles: true }));
        expect(activated[2]).toEqual({ block: LANED[3], index: 3, total: 4, source: 'pointer' });

        // Past THAT row's right edge is a miss, whatever a wider row elsewhere in the bar does.
        rows[1].dispatchEvent(new MouseEvent('click', { clientX: 601, bubbles: true }));
        expect(activated).toHaveLength(3);

        // A click straight on a button still activates exactly that segment, lane notwithstanding.
        const second = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'))[3];
        second.click();
        expect(activated[3]).toEqual({ block: LANED[3], index: 3, total: 4, source: 'pointer' });
    });

    it('paints every row into one taller canvas, at that row offset', () => {
        const fake = stubCanvas();
        const activated: ContextBarActivateInput[] = [];
        const bar = mount(LANED, { onActivate: (input) => activated.push(input) });

        expect(bar.mode()).toBe('canvas');
        // ONE element for the whole stack, 74px tall.
        expect(bar.element.querySelectorAll('canvas')).toHaveLength(1);
        expect(bar.element.querySelectorAll('.context-bar-segment')).toHaveLength(0);
        expect((bar.element.querySelector('.context-bar-canvas') as HTMLCanvasElement).style.height).toBe('74px');

        // Row 0's rectangles are the ones this fixture paints as a single strip (y = 36 - height);
        // row 1's are the SAME arithmetic offset by its band origin, 38.
        expect(fake.paints).toEqual([
            { x: 0, y: 24, width: 8, height: 12, fill: '#d8deea', alpha: 1 },
            { x: 10, y: 0, width: 590, height: 36, fill: '#4ade80', alpha: 1 },
            { x: 0, y: 38, width: 478, height: 36, fill: '#4ade80', alpha: 1 },
            { x: 480, y: 56, width: 120, height: 18, fill: '#fbbf24', alpha: 1 }
        ]);

        // In-segment labels sit at the middle of their OWN bar, so a row-1 label is 38px lower
        // than the same bar would be in row 0.
        expect(fake.texts).toEqual([
            ['read', 16, 18],
            ['bash', 6, 56],
            ['reasoning', 486, 65]
        ]);

        // The focus ring hugs the painted bar of the row it is on.
        bar.setFocused(3);
        expect(fake.outlines).toEqual([[481, 57, 118, 16]]);

        // Pointer aim: the same x in two rows answers twice, because y picks the band first.
        const canvas = bar.element.querySelector('canvas') as HTMLCanvasElement;

        canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 10, bubbles: true }));
        expect(bar.focused()).toBe(1);

        canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 10, clientY: 50, bubbles: true }));
        expect(bar.focused()).toBe(2);

        canvas.dispatchEvent(new MouseEvent('click', { clientX: 500, clientY: 50, bubbles: true }));
        expect(activated).toEqual([{ block: LANED[3], index: 3, total: 4, source: 'pointer' }]);
    });

    it('is the same stack in both modes (R28 parity, extended to rows)', () => {
        const dom = mount(LANED);
        const fake = stubCanvas();
        const canvasBar = mount(LANED);
        const bands = canvasBar.layout().rows.map((row) => [row.offsetY, row.heightPx]);

        expect(bands).toEqual([
            [0, 36],
            [38, 36]
        ]);

        // Each DOM row reserves exactly the band the canvas paints into...
        expect(Array.from(dom.element.querySelectorAll<HTMLElement>('.context-bar-segments')).map((row) => row.style.height)).toEqual([
            '36px',
            '36px'
        ]);
        // ...every painted bar stays inside its own band...
        for (const paint of fake.paints) {
            const band = canvasBar.layout().rows.find((row) => paint.y >= row.offsetY && paint.y + paint.height <= row.offsetY + row.heightPx);

            expect(band).toBeDefined();
        }
        // ...and the two renderers agree on every bar height and every x, segment by segment, in
        // row order. One arithmetic, one tab order, one picture.
        expect(Array.from(dom.element.querySelectorAll<HTMLElement>('.context-bar-segment')).map((button) => button.dataset.heightPx)).toEqual(
            fake.paints.map((paint) => String(paint.height))
        );
        expect(Array.from(dom.element.querySelectorAll<HTMLElement>('.context-bar-segment')).map((button) => button.dataset.index)).toEqual([
            '0', '1', '2', '3'
        ]);
    });

    it('keeps exactly one dashed row for an authoritative empty bar', () => {
        // An empty bar has NO lane — nothing claimed one — but it still needs one band, because
        // that is the box the dashed "nothing recorded" affordance draws in both modes.
        const bar = mountContextBar({ width: 600 });
        document.body.replaceChildren(bar.element);
        bar.setModel(EMPTY_MODEL);

        expect(bar.element.dataset.lanes).toBe('0');
        expect(bar.element.dataset.laneTags).toBe('false');
        expect(bar.element.dataset.heightPx).toBe(String(CONTEXT_BAR_TRACK_HEIGHT_PX));

        const rows = Array.from(bar.element.querySelectorAll<HTMLElement>('.context-bar-segments'));

        expect(rows).toHaveLength(1);
        expect(rows[0].dataset.row).toBe('0');
        expect(rows[0].dataset.lane).toBe('0');
        expect(rows[0].querySelectorAll('.context-bar-segment')).toHaveLength(0);
        expect(bar.element.querySelectorAll('.context-bar-lane')).toHaveLength(0);
        expect(bar.element.querySelector('.context-bar-caption')?.textContent).toBe('no recorded context');

        bar.destroy();
    });
});
