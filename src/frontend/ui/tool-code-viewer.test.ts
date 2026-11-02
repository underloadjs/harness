// R4 — the tool pane code viewer.
//
// Two halves, both pinned exactly:
//   1. the DOM ui/tools.ts builds for an arguments/result pane: one `.code-line`
//      element per LOGICAL line, joined by `.code-break` separators that carry the
//      payload's own '\n' so `code.textContent` stays byte-identical to the payload
//      (every consumer and the Copy button depend on that); the visible line numbers
//      are CSS generated content, so they are NEVER in the DOM text;
//   2. the stylesheet contract for those classes: the pane soft-wraps long lines and
//      URLs with no horizontal scrollbar (which is what `.tool-code` exists for), the
//      gutter numbers one row per logical line no matter how many visual rows it
//      wraps into, and the SHARED `.code-block` keeps its sideways scroll so no
//      Markdown fence changes behaviour.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/tool-code-viewer.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderResultBlock, createToolCallCard } from './tools';

// Mirror tool-chip-style.test.ts: resolve from the package root (`npm test`) or the
// frontend root (the frontend vitest config sets `root` to src/frontend/).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

// The arguments pane of a fresh card is the smallest complete view of the builder:
// no dialog, no result round-trip, and the payload is known character for character.
const argumentsPane = (rawArguments: string): HTMLElement => {
    const card = createToolCallCard('read', rawArguments);
    const pane = card.element.querySelector<HTMLElement>('.tool-section:first-child .code-block');
    if (pane === null) throw new Error('missing arguments pane');
    return pane;
};

const rowsOf = (pane: Element): HTMLElement[] =>
    Array.from(pane.querySelectorAll<HTMLElement>('.code-line'));

const breaksOf = (pane: Element): HTMLElement[] =>
    Array.from(pane.querySelectorAll<HTMLElement>('.code-break'));

describe('tool pane line layout', () => {
    it('numbers one row per logical line of a pretty-printed payload', () => {
        const pane = argumentsPane('{"paths":["a.ts"],"limit":12}');
        const code = pane.querySelector('code');
        const expected = '{\n  "paths": [\n    "a.ts"\n  ],\n  "limit": 12\n}';

        expect(pane.getAttribute('data-code-lines')).toBe('6');
        expect(rowsOf(pane)).toHaveLength(6);
        // 6 rows need 5 separators, and every separator is exactly one '\n'.
        expect(breaksOf(pane).map((node) => node.textContent)).toEqual([
            '\n',
            '\n',
            '\n',
            '\n',
            '\n'
        ]);
        // The exact payload, newlines included — the numbering and the wrapping did
        // not touch the text.
        expect(code?.textContent).toBe(expected);
        // And no row text carries a number: the gutter lives in CSS `content`, so
        // neither `textContent` nor a selection nor the Copy button can pick it up.
        expect(rowsOf(pane).map((row) => row.textContent)).toEqual([
            '{',
            '  "paths": [',
            '    "a.ts"',
            '  ],',
            '  "limit": 12',
            '}'
        ]);
    });

    it('keeps blank and trailing lines as their own rows', () => {
        const pane = argumentsPane('one\n\nthree\n');
        const code = pane.querySelector('code');

        // 'one' / '' / 'three' / '' after the final newline.
        expect(pane.getAttribute('data-code-lines')).toBe('4');
        expect(rowsOf(pane).map((row) => row.textContent)).toEqual(['one', '', 'three', '']);
        expect(code?.textContent).toBe('one\n\nthree\n');
    });

    it('leaves a single-line payload as one row with one number', () => {
        // The whole point of the row model: this line is far wider than the pane and
        // MUST soft-wrap, yet it is still one logical line and gets one number.
        const url = `https://example.com/${'segment/'.repeat(60)}`;
        const pane = argumentsPane(url);

        expect(pane.getAttribute('data-code-lines')).toBe('1');
        expect(rowsOf(pane)).toHaveLength(1);
        expect(breaksOf(pane)).toHaveLength(0);
        expect(rowsOf(pane)[0]?.textContent).toBe(url);
    });

    it('re-opens a highlight token that spans lines inside every row it touches', () => {
        // highlight.js emits ONE `hljs-comment` span across all three lines. Leaving
        // it open across row boundaries would break the wrap and the counter, so each
        // row owns a balanced copy and the concatenation is still the payload.
        const raw = '/* one\ntwo\nthree */';
        const pane = argumentsPane(raw);
        const rows = rowsOf(pane);

        expect(pane.getAttribute('data-code-lines')).toBe('3');
        expect(rows.map((row) => row.textContent)).toEqual(['/* one', 'two', 'three */']);
        const expected = ['/* one', 'two', 'three */'];
        rows.forEach((row, index) => {
            const comment = row.querySelector('span.hljs-comment');
            // Re-opened INSIDE the row and closed again: the subtree is balanced, so
            // the soft wrap and the counter both stay correct.
            expect(comment?.parentElement).toBe(row);
            expect(comment?.textContent).toBe(expected[index]);
            expect(row.innerHTML).toBe(`<span class="hljs-comment">${expected[index]}</span>`);
        });
        expect(pane.querySelector('code')?.textContent).toBe(raw);
    });

    it('sizes the gutter from the row count so numbers never shift the text column', () => {
        expect(argumentsPane('a\nb').querySelector('code')?.getAttribute('style')).toBe(
            '--code-gutter: 2ch;'
        );

        const many = Array.from({ length: 120 }, (unused, index) => `line ${index}`).join('\n');
        const pane = argumentsPane(many);
        expect(pane.getAttribute('data-code-lines')).toBe('120');
        expect(pane.querySelector('code')?.getAttribute('style')).toBe('--code-gutter: 3ch;');
    });

    it('keeps model-written markup inert inside the rows', () => {
        // The viewer is createElement/createTextNode only: no HTML parse path is
        // added to the (already escaped) highlighter output.
        const pane = argumentsPane('{"html":"<img src=x onerror=\\"pwned\\">"}');

        expect(pane.querySelector('img')).toBeNull();
        expect(pane.querySelector('script')).toBeNull();
        expect(pane.querySelector('code')?.textContent).toBe(
            '{\n  "html": "<img src=x onerror=\\"pwned\\">"\n}'
        );
    });

    it('wraps the direct-call runner result in the same viewer', () => {
        // `renderResultBlock` shares the builder, so the manual runner gets the
        // framed, numbered, wrapped pane too — and keeps its truncation note.
        const block = renderResultBlock({ ok: true }, false);
        const pane = block.querySelector('.code-block');

        expect(pane?.className).toBe('code-block tool-code');
        expect(pane?.getAttribute('data-code-lines')).toBe('3');
        expect(pane?.querySelector('code')?.textContent).toBe('{\n  "ok": true\n}');
        expect(block.querySelector('.tool-note-inline')).toBeNull();
    });
});

describe('tool pane viewer stylesheet', () => {
    it('turns the pane into a wrapped, vertically scrollable frame', () => {
        // `.tool-code.code-block` (two classes) is not decoration: ui/dialog.css
        // sets `.dialog-body pre { white-space: pre; overflow: auto }`, and a single
        // class would lose to it.
        const pane = blockOf('.tool-code.code-block {');
        expect(pane).toContain('overflow-x: hidden');
        expect(pane).toContain('overflow-y: auto');
        expect(pane).toContain('white-space: normal');
        expect(pane).toContain('border: 1px solid var(--border-strong)');
        expect(pane).toContain('border-radius: 8px');
        expect(pane).not.toContain('overflow: auto');
        expect(pane).not.toContain('white-space: pre');

        expect(blockOf('.tool-code code {')).toContain('display: block');
        expect(blockOf('.tool-code code {')).toContain('counter-reset: code-line');
        expect(blockOf('.tool-code code {')).toContain('white-space: normal');
    });

    it('wraps every row and indents it clear of the number column', () => {
        const row = blockOf('.code-line {');
        expect(row).toContain('display: block');
        expect(row).toContain('position: relative');
        // `pre-wrap` keeps the payload's own indentation; `anywhere` is what breaks a
        // 200-character URL that has no break opportunity at all.
        expect(row).toContain('white-space: pre-wrap');
        expect(row).toContain('overflow-wrap: anywhere');
        expect(row).toContain('counter-increment: code-line');
        expect(row).toContain('var(--code-gutter');
        expect(row).not.toContain('white-space: pre;');

        // The separator exists for text fidelity only.
        expect(blockOf('.code-break {')).toContain('display: none');

        // A blank source line still needs a line box, or the number collapses.
        expect(blockOf('.code-line:empty::after {')).toContain("content: '\\00a0'");
    });

    it('prints the numbers as generated content that cannot be copied', () => {
        const gutter = blockOf('.code-line::before {');
        // Generated content, so no text node anywhere carries a number.
        expect(gutter).toContain('content: counter(code-line)');
        // Pinned to the row's FIRST visual line; wrapped continuations stay in the
        // text column because the gutter lives in the row's padding.
        expect(gutter).toContain('position: absolute');
        expect(gutter).toContain('top: 0');
        expect(gutter).toContain('width: var(--code-gutter, 2ch)');
        expect(gutter).toContain('text-align: right');
        expect(gutter).toContain('user-select: none');
    });

    it('leaves the shared Markdown fence behaviour alone', () => {
        // The base block still scrolls sideways, and inline/fenced code still
        // preserves whitespace: only `.tool-code` opts out.
        const base = blockOf('.code-block {\n    max-height: 420px;');
        expect(base).toContain('overflow: auto');
        expect(base).toContain('padding: 10px 12px');
        expect(blockOf('.code-block code {')).toContain('white-space: pre');
        expect(css).toContain('.markdown .code-block[data-language]::before {');

        // Nothing may re-add a hard `pre` to the tool rows.
        expect(blockOf('.tool-code.code-block {')).not.toMatch(/white-space:\s*pre(?!-wrap)/);
        expect(blockOf('.code-line {')).not.toMatch(/white-space:\s*pre(?!-wrap)/);
    });

    it('lays each pane heading out as label plus its own copy icon', () => {
        const heading = blockOf('.tool-heading {');
        expect(heading).toContain('display: flex');
        expect(heading).toContain('align-items: center');

        // A caption-sized borderless icon, distinct from the boxed 28px header Copy.
        const control = blockOf('.tool-copy {');
        expect(control).toContain('width: 18px');
        expect(control).toContain('height: 18px');
        expect(control).toContain('background: transparent');
        expect(blockOf('.tool-copy .dialog-copy-icon {')).toContain('width: 12px');
        expect(blockOf('.tool-copy:hover {')).toContain('border-color: var(--border-strong)');
        expect(blockOf('.tool-copy:focus-visible {')).toContain('outline: 2px solid var(--accent)');
        // The glyph (and the live word) carry success/failure; colour only reinforces.
        expect(blockOf(".tool-copy[data-state='success'] {")).toContain('color: var(--ok)');
        expect(blockOf(".tool-copy[data-state='error'] {")).toContain('color: var(--danger)');

        // The label is a sibling that ellipsizes, so its text is never polluted by
        // the control and a long state suffix cannot push the icon out of the pane.
        expect(blockOf('.tool-heading > .tool-label {')).toContain('text-overflow: ellipsis');
    });
});
