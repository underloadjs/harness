// Composer state helpers (R9/R10).
//
// These are the two decisions main.ts delegates to this module:
//   - which SINGLE action the field shows (submit / stop / none);
//   - how tall the auto-grown textarea is (one row, capped, scroll past the cap).
//
// The DOM wiring and the visual contract are pinned in composer-control.test.ts;
// this file pins the pure math so every state of the matrix is exact rather than
// "looks about right".

import { describe, expect, it } from 'vitest';
import { composerActionOf, composerFieldHeight } from './composer';

describe('composerActionOf', () => {
    // R10 matrix: text present (idle OR running) => submit; empty + running => stop;
    // empty + idle => none. Text wins over pending so a running session can queue.
    it.each([
        ['text, idle', 'hello', false, 'submit'],
        ['text, running', 'hello', true, 'submit'],
        ['text with surrounding spaces, running', '  hello  ', true, 'submit'],
        ['empty, idle', '', false, 'none'],
        ['empty, running', '', true, 'stop'],
        // Whitespace is not submittable (run() trims), so it must behave as empty.
        ['spaces, idle', '   ', false, 'none'],
        ['spaces, running', '   ', true, 'stop'],
        ['newlines and tabs, idle', '\n\t \n', false, 'none'],
        ['newlines and tabs, running', '\n\t \n', true, 'stop']
    ] as const)('returns %s', (_label, value, pending, expected) => {
        expect(composerActionOf(value, pending)).toBe(expected);
    });
});

describe('composerFieldHeight', () => {
    // scrollHeight 0 is the "no layout information" signal (jsdom/detached node):
    // the caller keeps the stylesheet's one-row default instead of collapsing.
    it('reports 0 when there is no measurement', () => {
        expect(composerFieldHeight(0, 2, 200)).toBe(0);
        expect(composerFieldHeight(-4, 2, 200)).toBe(0);
        expect(composerFieldHeight(Number.NaN, 2, 200)).toBe(0);
    });

    // border-box: scrollHeight excludes the border, so it is added back exactly once.
    it('adds the vertical borders to the measured content', () => {
        expect(composerFieldHeight(40, 2, 200)).toBe(42);
        expect(composerFieldHeight(120, 2, 200)).toBe(122);
        // Missing/nonsense border metrics never subtract or corrupt the height.
        expect(composerFieldHeight(40, 0, 200)).toBe(40);
        expect(composerFieldHeight(40, Number.NaN, 200)).toBe(40);
        expect(composerFieldHeight(40, -2, 200)).toBe(40);
    });

    // Grow freely until the cap, then clamp: styles.css turns the overflowing
    // content into a scroller at exactly this height.
    it('grows to the content and clamps at the cap', () => {
        expect(composerFieldHeight(119, 2, 200)).toBe(121);
        expect(composerFieldHeight(198, 2, 200)).toBe(200);
        expect(composerFieldHeight(199, 2, 200)).toBe(200);
        expect(composerFieldHeight(400, 2, 200)).toBe(200);
        // A missing cap (`max-height: none` parses to NaN) means no clamp at all.
        expect(composerFieldHeight(400, 2, 0)).toBe(402);
        expect(composerFieldHeight(400, 2, Number.NaN)).toBe(402);
    });
});
