// The ONE context bar SURFACE, in both of its modes (T11: R7/R8).
//
// Two modes, one contract, and this file proves both halves of that sentence:
//
//   - DOM mode is what jsdom gets (`getContext('2d')` answers null without the `canvas`
//     package, which is exactly the guard ./context-bar.ts documents). It pins the element
//     vocabulary a screen reader and the stylesheet read: one lightweight button per
//     segment, carrying the kind/tone/state/character figures the model decided, weighted
//     by the model's flex share, with the model's exact label text.
//   - Canvas mode is what a browser gets, and it is pinned through a RECORDING fake context
//     rather than pixels: the assertions are the exact `fillRect` rectangles, fill styles and
//     alphas the geometry produced, so a change to the width math or the tone table fails
//     here with numbers, not a screenshot.
//
// Both halves also pin the rule the whole feature exists for: NOTHING is fetched by
// rendering. The bar calls its `onActivate` callback and stops; the request belongs to the
// dialog (./context-detail.test.ts) and to the tile (../ui/turns-context-bar.test.ts).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/context-bar.test.ts

import type { ContextBlock } from '../../shared/turn-display';
import type { ContextBarModel } from '../view-context';
import { CONTEXT_BAR_TRACK_HEIGHT_PX, contextBarOf, layoutContextBar } from '../view-context';
import type { ContextBarActivateInput } from './context-bar';
import { CONTEXT_BAR_DOM_LABEL_LIMIT, CONTEXT_BAR_ON_SEGMENT_TEXT, mountContextBar } from './context-bar';
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
    charsByKind: { user: 0, system: 0, reasoning: 0, assistant: 0, tool: 0 }
};

// The three-segment fixture whose pixel geometry is asserted throughout: 100/200/300
// characters in a 600px track is 0+99, 101+199 and 302+298 with the model's 2px gap.
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
        // The flex weights ARE the layout shares, so both modes are sized by one arithmetic.
        expect(Array.from(segments).map((button) => button.style.flexGrow)).toEqual(['1667', '3333', '5000']);
        expect(Array.from(segments).map((button) => button.style.flexBasis)).toEqual(['0%', '0%', '0%']);
    });

    it('carries the exact hover and accessible text for every segment', () => {
        const bar = mount(THREE);
        const [first, second, third] = Array.from(bar.element.querySelectorAll<HTMLButtonElement>('.context-bar-segment'));

        expect(first.title).toBe('prompt · user · 100 characters');
        expect(first.getAttribute('aria-label')).toBe('1 of 3 · prompt · user · 100 characters');
        expect(second.title).toBe('reasoning · reasoning · 200 characters · 800ms · not replayed into the prompt');
        expect(third.title).toBe('bash · tool · error · 300 characters · args 20 + result 1,184 · 800ms');
    });

    it('labels the segments only while the bar is uncrowded', () => {
        // Under the limit a name is worth a text node; at hundreds it is clipped noise and
        // real layout cost, and the colour plus the tooltip carry the segment instead.
        const few = mount(THREE);
        expect(few.element.querySelectorAll('.context-bar-segment-name')).toHaveLength(3);
        expect(few.element.querySelector('.context-bar-segment-name')?.textContent).toBe('prompt');

        const many = mount(Array.from({ length: CONTEXT_BAR_DOM_LABEL_LIMIT + 1 }, (_, index) => block({ id: `b${index}` })));
        expect(many.element.querySelectorAll('.context-bar-segment')).toHaveLength(CONTEXT_BAR_DOM_LABEL_LIMIT + 1);
        expect(many.element.querySelectorAll('.context-bar-segment-name')).toHaveLength(0);
    });

    it('names the unit on the group and puts only the count on the caption', () => {
        const bar = mount(THREE);

        // TWO audiences, one set of figures. The ACCESSIBLE name keeps the label phrase AND
        // the character totals, so a screen reader still hears what the strip is and how
        // large it is; the VISIBLE line is the segment COUNT only (T22/R24) — the totals it
        // used to print under every turn were numbers the reader never acted on, and they
        // remain one aim away on the segment they describe.
        expect(bar.element.getAttribute('role')).toBe('group');
        expect(bar.element.getAttribute('aria-label')).toBe(
            'context character distribution · 3 segments · 600 characters · 200 characters not replayed into the prompt'
        );
        expect(bar.element.querySelector('.context-bar-caption')?.textContent).toBe('3 segments');
        // The banned-on-screen wording (the user's screenshot): the visible line never
        // repeats the bar's name, and since R24 it prints no character totals either.
        expect(bar.element.querySelector('.context-bar-caption')?.textContent ?? '').not.toContain('context character distribution');
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
        // Same split as above: the phrase stays in the accessible name only.
        expect(bar.element.getAttribute('aria-label')).toBe('context character distribution · no recorded context');
        expect(bar.element.querySelector('.context-bar-caption')?.textContent).toBe('no recorded context');
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
            { x: 0, y: 0, width: 99, height: CONTEXT_BAR_TRACK_HEIGHT_PX, fill: '#d8deea', alpha: 1 },
            { x: 101, y: 0, width: 199, height: CONTEXT_BAR_TRACK_HEIGHT_PX, fill: '#fbbf24', alpha: 1 },
            { x: 302, y: 0, width: 298, height: CONTEXT_BAR_TRACK_HEIGHT_PX, fill: '#f87171', alpha: 1 }
        ]);
        // A label is painted only where the segment can hold it, and the three here can:
        // `prompt` (54px of text) in 99px, `reasoning` (75px) in 199px, `bash` (40px) in
        // 298px. The x is the segment's left edge plus the painter's 6px inset, and the y is
        // the middle of the track.
        expect(fake.texts).toEqual([
            ['prompt', 6, CONTEXT_BAR_TRACK_HEIGHT_PX / 2],
            ['reasoning', 107, CONTEXT_BAR_TRACK_HEIGHT_PX / 2],
            ['bash', 308, CONTEXT_BAR_TRACK_HEIGHT_PX / 2]
        ]);
        expect(fake.outlines).toEqual([]);
    });

    it('fades a running call without changing its hue', () => {
        const fake = stubCanvas();
        mount([block({ state: 'running' })]);

        expect(fake.paints).toEqual([
            { x: 0, y: 0, width: 600, height: CONTEXT_BAR_TRACK_HEIGHT_PX, fill: '#4ade80', alpha: 0.45 }
        ]);
    });

    it('scales the backing store by the device ratio and paints in CSS pixels', () => {
        const fake = stubCanvas();
        Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });

        const bar = mount(THREE);
        const canvas = bar.element.querySelector('canvas') as HTMLCanvasElement;

        expect(canvas.width).toBe(1200);
        expect(canvas.height).toBe(CONTEXT_BAR_TRACK_HEIGHT_PX * 2);
        expect(canvas.style.height).toBe(`${CONTEXT_BAR_TRACK_HEIGHT_PX}px`);
        expect(fake.transforms).toEqual([[2, 0, 0, 2, 0, 0]]);
        // The rects stay in CSS pixels because the transform does the scaling.
        expect(fake.paints[0]).toEqual({ x: 0, y: 0, width: 99, height: CONTEXT_BAR_TRACK_HEIGHT_PX, fill: '#d8deea', alpha: 1 });
    });

    it('labels a segment only where the label fits', () => {
        const fake = stubCanvas();
        // One 1,204-character segment owns the whole 600px track.
        mount([block()]);
        expect(fake.texts).toEqual([['read', 6, CONTEXT_BAR_TRACK_HEIGHT_PX / 2]]);

        // A 12-segment bar gives each segment ~48px: `bash` (4 chars) still fits, but the
        // boundary is the model's, so an exact-width assertion pins it.
        const narrow = stubCanvas();
        mount(Array.from({ length: 12 }, (_, index) => block({ id: `b${index}`, name: 'delegate' })));
        expect(narrow.texts).toEqual([]);
    });

    it('outlines the focused segment and states it in the live region', () => {
        const fake = stubCanvas();
        const bar = mount(THREE);

        bar.setFocused(1);

        expect(fake.outlines).toEqual([[102, 1, 197, CONTEXT_BAR_TRACK_HEIGHT_PX - 2]]);
        expect(bar.element.querySelector('.context-bar-live')?.textContent).toBe(
            '2 of 3 · reasoning · reasoning · 200 characters · 800ms · not replayed into the prompt'
        );
        expect(bar.element.title).toBe('reasoning · reasoning · 200 characters · 800ms · not replayed into the prompt');

        bar.setFocused(-1);
        expect(bar.element.querySelector('.context-bar-live')?.textContent).toBe('');
    });

    it('gives a screen reader every segment as text, and stops above the documented limit', () => {
        const stub = stubCanvas();
        const bar = mount(THREE);
        void stub;

        expect(Array.from(bar.element.querySelectorAll('.context-bar-option')).map((node) => node.textContent)).toEqual([
            '1 of 3 · prompt · user · 100 characters',
            '2 of 3 · reasoning · reasoning · 200 characters · 800ms · not replayed into the prompt',
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
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 100, bubbles: true }));
        expect(activated[1]).toEqual({ block: THREE[0], index: 0, total: 3, source: 'pointer' });

        // Past the painted edge is a miss: an empty click must not open a dialog.
        canvas.dispatchEvent(new MouseEvent('click', { clientX: 601, bubbles: true }));
        expect(activated).toHaveLength(2);

        // Hover moves the current segment (and the highlight) without activating.
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 150, bubbles: true }));
        expect(bar.focused()).toBe(1);
        expect(activated).toHaveLength(2);
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
        expect(fake.texts).toEqual([['read', 6, CONTEXT_BAR_TRACK_HEIGHT_PX / 2]]);
        expect(CONTEXT_BAR_ON_SEGMENT_TEXT).toBe('#0b0d12');
    });
});
