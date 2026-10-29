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
import {
    composerActionOf,
    composerFieldHeight,
    composerLineHeight,
    composerMaxHeight,
    composerMaxLines
} from './composer';

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

describe('composerMaxLines', () => {
    // R5: 3 text lines on the phone viewport, 5 on desktop. 860 is the SAME width the
    // shell's own `@media (max-width: 860px)` layout query switches at, so the cap and
    // the layout never disagree about what a "phone" is.
    it('gives phones 3 lines and desktop 5 lines at the shell breakpoint', () => {
        expect(composerMaxLines(320)).toBe(3);
        expect(composerMaxLines(600)).toBe(3);
        expect(composerMaxLines(860)).toBe(3);
        expect(composerMaxLines(861)).toBe(5);
        expect(composerMaxLines(1024)).toBe(5);
        expect(composerMaxLines(2560)).toBe(5);
    });

    // A width the browser cannot state (detached/embedded document) takes the roomier
    // desktop budget rather than silently clipping a draft to 3 lines.
    it('falls back to the desktop budget for non-finite widths', () => {
        expect(composerMaxLines(Number.NaN)).toBe(5);
        expect(composerMaxLines(Number.POSITIVE_INFINITY)).toBe(5);
    });
});

describe('composerLineHeight', () => {
    // A real browser resolves line-height to px, so that value is used verbatim.
    it('uses a resolved pixel line-height verbatim', () => {
        expect(composerLineHeight('20px', '13.5px')).toBe(20);
        expect(composerLineHeight('19.575px', '13.5px')).toBe(19.575);
        expect(composerLineHeight(24, 16)).toBe(24);
    });

    // `line-height: normal` is NOT resolved by getComputedStyle (jsdom reports it, and
    // a browser can too before layout). The stylesheet's own 1.45 ratio is the fallback
    // so the cap keeps matching the rendered line box instead of an invented number.
    it('derives the line box from font-size * 1.45 when line-height is unresolved', () => {
        expect(composerLineHeight('normal', '13.5px')).toBe(19.575);
        expect(composerLineHeight('normal', '14px')).toBe(20.3);
        expect(composerLineHeight('normal', 20)).toBe(29);
    });

    // jsdom's untouched computed style reports `normal` / `medium`: both fall through
    // to the stylesheet's 13.5px * 1.45 = 19.575px, never to NaN or 0.
    it('falls back to the stylesheet font-size when the size is unreadable', () => {
        expect(composerLineHeight('normal', 'medium')).toBe(19.575);
        expect(composerLineHeight('', '')).toBe(19.575);
        expect(composerLineHeight('0px', '0px')).toBe(19.575);
        expect(composerLineHeight('normal', '-4px')).toBe(19.575);
    });
});

describe('composerMaxHeight', () => {
    // The cap is the OUTER height of N readable lines in a border-box textarea:
    // N * line-height + vertical padding + the caller's summed vertical borders.
    it('caps desktop at 5 text lines plus padding and borders', () => {
        expect(
            composerMaxHeight({
                viewportWidth: 1024,
                lineHeight: '20px',
                fontSize: '13.5px',
                paddingTop: '10px',
                paddingBottom: '10px',
                borders: 2
            })
        ).toBe(122);
        // Exactly at the breakpoint the phone budget applies; one pixel wider is 5.
        expect(
            composerMaxHeight({
                viewportWidth: 860,
                lineHeight: 20,
                fontSize: 13.5,
                paddingTop: 10,
                paddingBottom: 10,
                borders: 2
            })
        ).toBe(82);
        expect(
            composerMaxHeight({
                viewportWidth: 861,
                lineHeight: 20,
                fontSize: 13.5,
                paddingTop: 10,
                paddingBottom: 10,
                borders: 2
            })
        ).toBe(122);
    });

    // The shipped font/line-height (13.5px * 1.45 = 19.575px) is fractional; rounding
    // UP keeps the last line whole instead of clipping its bottom pixel row.
    it('rounds a fractional line box up, never truncating the last line', () => {
        expect(
            composerMaxHeight({
                viewportWidth: 1024,
                lineHeight: '19.575px',
                fontSize: '13.5px',
                paddingTop: '10px',
                paddingBottom: '10px',
                borders: 2
            })
        ).toBe(120);
        expect(
            composerMaxHeight({
                viewportWidth: 320,
                lineHeight: '19.575px',
                fontSize: '13.5px',
                paddingTop: '10px',
                paddingBottom: '10px',
                borders: 2
            })
        ).toBe(81);
    });

    // jsdom's untouched computed style is `line-height: normal`, `font-size: medium`,
    // `padding: 0`, `border-width: medium`: the cap must still be a stable number.
    it('stays a real number when the computed metrics are unreadable', () => {
        expect(
            composerMaxHeight({
                viewportWidth: 1024,
                lineHeight: 'normal',
                fontSize: 'medium',
                paddingTop: '0',
                paddingBottom: '0',
                borders: Number.NaN
            })
        ).toBe(98);
        expect(
            composerMaxHeight({
                viewportWidth: 600,
                lineHeight: 'normal',
                fontSize: 'medium',
                paddingTop: '0',
                paddingBottom: '0',
                borders: Number.NaN
            })
        ).toBe(59);
    });

    // The horizontal padding (the 52px right gutter that keeps text off the action)
    // must NOT count against the vertical budget; only top/bottom do.
    it('counts only vertical padding and borders', () => {
        expect(
            composerMaxHeight({
                viewportWidth: 1024,
                lineHeight: '20px',
                fontSize: '13.5px',
                paddingTop: '10px',
                paddingBottom: '10px',
                borders: 0
            })
        ).toBe(120);
    });
});
