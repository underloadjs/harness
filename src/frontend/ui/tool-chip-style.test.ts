// Tool-chip CSS contract.
//
// jsdom cannot lay out flex rows or resolve the chip visibility, so this test
// reads stylesheet source and pins the rules the compact tool UI relies on:
//   - consecutive calls live in a wrapping flex row (`.tool-group`);
//   - the chip keeps its compact intrinsic width; the detail body is dialog
//     content (R12) and never an inline panel;
//   - the state word and the argument preview stay hidden while the chip is
//     closed, but the duration label does not (R2/T2): every chip carries its own
//     measured span INLINE after the name, so the collapsed chip reads
//     `[Search 1.3s]` at exactly its content width. The label used to be an
//     absolutely positioned corner pill, and the summary had to reserve ~76px of
//     dead space for it — that reservation is what stretched every chip, so the
//     contract below pins that it is GONE, not merely different;
//   - an unknown span stays hidden through `[hidden]` so no empty pill is painted
//     and no space is taken for it;
//   - NO disclosure chevron anywhere on the chip (R: "the user knows clicking opens a
//     dialog"). The chip's painted parts are exactly the state glyph, the name and the
//     duration pill, and the marker removal is a BASE-ELEMENT `summary` rule so every
//     future chip inherits it instead of re-declaring it;
//   - the tool name is green on success and red on failure, neutral otherwise.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Mirror activity-style.test.ts: resolve from the package root (`npm test`) or
// the frontend root (vitest frontend config sets `root` to frontend/).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Comments NAME the removed rules ("there is deliberately NO width reservation"), so
// "this rule is gone" assertions must run against the stylesheet with comments
// stripped, otherwise the documentation itself fails the test.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

// The selector list of a rule (everything before its `{`). The duration badge has
// to be ABSENT from the collapsed-hide list, and `blockOf` only returns the
// declarations, so the selector itself is what this reads.
const selectorListOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    return css.slice(start, open);
};

// The FULL body of an `@media` block, brace-matched. `blockOf` stops at the first `}`,
// which inside an at-rule is the end of the FIRST nested rule — and the chevron's
// `transition` lived in the second one, so a nested-aware reader is what pins its
// removal from the motion list.
const mediaBlockOf = (atRule: string): string => {
    const start = rules.indexOf(atRule);
    if (start < 0) throw new Error(`missing at-rule ${atRule}`);

    const open = rules.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < rules.length; index += 1) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') {
            depth -= 1;
            if (depth === 0) return rules.slice(open + 1, index);
        }
    }
    throw new Error(`unterminated at-rule ${atRule}`);
};

// Every rule in the stylesheet (comment-stripped) as `[selectorList, declarations]`.
// Used to prove a generated glyph belongs to ONE surface: a `::before` chevron on a chip
// is exactly what the base `summary` reset exists to make unnecessary.
const ruleList = [...rules.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((rule) => [
    rule[1].trim(),
    rule[2]
]);

it('flows consecutive chips horizontally and wraps them', () => {
    const group = blockOf('.tool-group {');
    expect(group).toContain('display: flex');
    expect(group).toContain('flex-wrap: wrap');
    expect(group).toContain('align-items: flex-start');
    expect(group).toContain('gap: 4px');

    // Chips shrink to their content; `.tool` never grows into a card-width block
    // on its own, which is what keeps a fresh call compact.
    expect(blockOf('.tool {')).toContain('flex: 0 1 auto');
    expect(blockOf('.tool {')).toContain('max-width: 100%');
});

it('hides verbose summary pieces but keeps the duration badge while the chip is closed', () => {
    // One rule hides the state word and the argument preview. R12 keeps the
    // `<details>` closed forever (the body moves into the modal when opened), so
    // this is the permanent chip state; the accessible `aria-label` carries the
    // state text.
    const hidden = blockOf('.tool:not([open]) .tool-state,');
    expect(hidden).toContain('display: none');

    expect(css).toContain('.tool:not([open]) .tool-peek {');

    // R2: the measured span has to be readable without opening anything, so
    // `.tool-duration` is NOT part of that selector list (the stale expectation that
    // the closed chip hides the span is what this test used to pin). Pinning the list
    // is the only way to catch a rule that re-adds it.
    const hiddenSelectors = selectorListOf('.tool:not([open]) .tool-state,');
    expect(hiddenSelectors.replace(/\s+/g, ' ').trim()).toBe(
        '.tool:not([open]) .tool-state, .tool:not([open]) .tool-peek'
    );
    expect(hiddenSelectors).not.toContain('.tool-duration');

    // The shared detail body keeps its section layout when the dialog adopts it,
    // so arguments/result stay stacked and readable inside `.dialog-body`.
    expect(blockOf('.tool-body {')).toContain('flex-direction: column');
    expect(blockOf('.tool-body {')).toContain('gap: 8px');
});

it('flows each chip with its own measured span so the chip is content-width', () => {
    // R2/T2: the collapsed chip is `[Search 1.3s]` — THREE painted parts, the state
    // glyph, the name and the duration pill, with nothing else between them. The old
    // leading `▸` is not a part of the chip any more (see the chevron contract at the end
    // of this test), so the width is exactly glyph + name + pill + one flex gap.
    // The span is a label IN FLOW, after the name, so the chip's width IS its content:
    // nothing on the chip may reserve space for a label that is not there, and nothing may
    // take the label out of flow (an overlay is precisely what needed the ~76px reservation
    // below).
    expect(blockOf('.tool {')).toContain('position: relative');
    expect(blockOf('.tool {')).toContain('flex: 0 1 auto');
    expect(blockOf('.tool {')).not.toContain('min-width');

    // The pill vocabulary is unchanged (existing tokens only — no component library and
    // no new dependency), only its position in the layout. T26: the box is now SHARED with
    // the think chip's figure (`:is(.tool-duration, .think-count)`), so the chip contract
    // is read off that one list; a second standalone `.tool-duration` rule would let the
    // two chips drift apart.
    const badge = blockOf(':is(.tool-duration, .think-count) {');
    expect(badge).not.toContain('position: absolute');
    expect(badge).not.toContain('z-index');
    expect(badge).not.toContain('top:');
    expect(badge).not.toContain('right:');
    // Out-of-flow leftovers: `pointer-events: none` existed so clicking the OVERLAY was
    // still clicking the disclosure. In flow the label is a descendant of the summary, so
    // its clicks already bubble there, and `none` would only block selecting the figure.
    expect(badge).not.toContain('pointer-events');
    // A max-width on the label would let the span itself be cut; the NAME is the item
    // that truncates (asserted in the name test below).
    expect(badge).not.toContain('max-width');
    expect(badge).toContain('display: inline-flex');
    expect(badge).toContain('flex: 0 0 auto');
    expect(badge).toContain('border: 1px solid var(--border-strong)');
    expect(badge).toContain('border-radius: 999px');
    expect(badge).toContain('background: var(--bg-input)');
    expect(badge).toContain('color: var(--muted)');
    expect(badge).toContain('font-variant-numeric: tabular-nums');
    expect(badge).toContain('white-space: nowrap');
    expect(css).not.toContain('.tool-duration:not(:empty)::before');
    // The standalone pill selectors are gone (grouped into the `:is()` list above).
    expect(rules).not.toMatch(/^\s*\.tool-duration\s*\{/m);
    expect(rules).not.toMatch(/^\s*\.tool-duration\[hidden\]\s*\{/m);

    // The row's separation is the summary's own flex gap — one value, applied between
    // the glyph, the name and the label, and NOT a per-side padding trick that re-introduces
    // slack. With the chevron gone that gap is the ONLY horizontal decoration there is.
    const summary = blockOf('.tool-summary {');
    expect(summary).toContain('display: flex');
    expect(summary).toContain('gap: 5px');
    expect(summary).toContain('padding: 3px 8px');
    // The summary generates nothing of its own: no `content`, so no arrow is painted
    // before or after the label.
    expect(summary).not.toContain('content:');

    // THE STRETCH REGRESSION: the corner reservation must stay gone. `.tool:has()` was
    // the if-exists check and `padding-right: calc(8ch + 22px)` (~76px) was the dead
    // space; either one coming back re-stretches every chip in the transcript.
    expect(rules).not.toContain('.tool:has(.tool-duration');
    expect(summary).not.toContain('padding-right');
    // The reservation itself, in any form: the 8-character budget is what made a 4-char
    // `0.8s` chip the width of a 12-char one.
    expect(rules).not.toContain('padding-right: calc(8ch');

    // Not clipped: the pill sits inside the chip's border box in flow, and nothing on
    // the chip, its summary or the wrapping row may cut it off.
    expect(blockOf('.tool {')).not.toContain('overflow: hidden');
    expect(blockOf('.tool-summary {')).not.toContain('overflow: hidden');
    expect(blockOf('.tool-group {')).not.toContain('overflow: hidden');

    // `[hidden]` is the only suppression path (an unknown span), and it has to win
    // over the label's own `display` above — otherwise an empty pill would paint AND
    // take up its slot in the in-flow chip. T26: one grouped rule covers both chip kinds,
    // so a think chip with no context denominator disappears the same way.
    expect(blockOf(':is(.tool-duration, .think-count)[hidden] {')).toContain('display: none');

    // No plain pill rule may hide it: the phone breakpoint keeps the label and drops only
    // `.tool-peek`, so the span stays visible at every width. (The `[hidden]` rules above
    // are the only `display: none` these class names get.)
    for (const pattern of [/\.tool-duration\s*\{[^}]*\}/g, /\.think-count\s*\{[^}]*\}/g]) {
        expect([...css.matchAll(pattern)].filter((rule) => rule[0].includes('display: none'))).toEqual([]);
    }

    // The label carries the call's state colour, like the name and the glyph do.
    expect(blockOf(".tool[data-state='ok'] .tool-duration {")).toContain('color: var(--ok)');
    expect(blockOf(".tool[data-state='error'] .tool-duration {")).toContain('color: var(--danger)');

    // --- No disclosure chevron, on this chip or on any future one ---------------------
    // The arrow was `content: '▸'` painted by `.tool-summary::before`, rotated 90deg when
    // the card opened. A chip row of identical triangles restates what the click already
    // proves, so the whole vocabulary is gone: the chip's painted parts are the state
    // glyph, the name and the duration pill, each with its own rule.
    expect(rules).toContain('.tool-glyph {');
    expect(rules).toContain('.tool-name {');
    expect(rules).not.toContain('.tool-summary::before');
    expect(rules).not.toContain('.tool[open] > .tool-summary::before');
    expect(rules).not.toContain('.tool-summary::-webkit-details-marker');

    // Every rule that still names `.tool-summary`, exactly: three layout/hover rules, and
    // none of them generates content (a fourth one with a `::before` is what would put the
    // arrow back).
    const summaryRules = ruleList.filter(([selector]) => selector.includes('.tool-summary'));
    expect(summaryRules.map(([selector]) => selector)).toEqual([
        '.tool-summary',
        '.tool[open] > .tool-summary',
        '.tool-summary:focus-visible'
    ]);
    for (const [, declarations] of summaryRules) {
        expect(declarations).not.toContain('content:');
    }

    // T4/R4: no triangle is painted ANYWHERE in the sheet. The endpoint accordion used to
    // own the last one (`.endpoint-summary::before`), and it left with the rail
    // disclosure — the settings open from the top-right status pill now, so the dialog
    // TITLE is the label and there is nothing to arrow. Zero rules is the invariant that
    // replaces "one rule, one surface".
    expect(ruleList.filter(([, d]) => d.includes("content: '▸'")).map(([s]) => s)).toEqual([]);
    expect(rules).not.toContain('.endpoint-summary');
    expect(rules).not.toContain('.endpoint[open]');

    // THE inheritable half: the marker reset is written on the ELEMENT, so a chip added
    // tomorrow is arrow-free without declaring anything. `list-style: none` is the Gecko
    // marker, `::-webkit-details-marker` the Blink/WebKit one. Line-anchored so an
    // indented `.tool-summary {` can never satisfy them by accident.
    expect(rules).toMatch(/^summary \{\s*list-style: none;\s*\}/m);
    expect(rules).toMatch(/^summary::-webkit-details-marker \{\s*display: none;\s*\}/m);
    // Base layer, not a component rule: both reset lines precede the topbar, and therefore
    // every chip, in the cascade.
    expect(rules.indexOf('summary {') < rules.indexOf('.topbar {')).toBe(true);
    expect(rules.indexOf('summary::-webkit-details-marker {') < rules.indexOf('.topbar {')).toBe(true);
    // `.tool-summary` keeps its own `list-style: none` (harmless duplication of the base
    // rule, asserted above next to the gap/padding it shares a block with).
    expect(summary).toContain('list-style: none');

    // The arrow's rotation and its motion opt-out left together: reduced motion no longer
    // has a `.tool-summary` transition to freeze, and T4/R4 removed the endpoint
    // accordion's one as well — no disclosure triangle survives in either layer.
    const reduced = mediaBlockOf('@media (prefers-reduced-motion: reduce) {');
    expect(reduced).not.toContain('tool-summary');
    expect(reduced).not.toContain('endpoint-summary');
});

it('fills the dialog height with the result pane instead of leaving a blank tail', () => {
    // R12 dialog sizing: the shell is content-sized with a viewport cap, and the
    // tool body is the flex chain that distributes that height. `min-height: 0`
    // lets each level shrink so the result block scrolls internally rather than
    // keeping the card's fixed 300px and exposing empty space beneath it.
    const body = blockOf('.dialog-body > .tool-body {');
    expect(body).toContain('flex: 1 1 auto');
    expect(body).toContain('min-height: 0');
    expect(body).toContain('padding: 0');

    // Arguments are capped relative to the viewport and do not shrink: a long
    // result must not collapse this pane below its label.
    const argsSection = blockOf('.dialog-body > .tool-body > .tool-section:first-child {');
    expect(argsSection).toContain('flex: 0 0 auto');
    expect(blockOf('.dialog-body > .tool-body > .tool-section:first-child > .code-block {')).toContain(
        'max-height: min(32vh, 280px)'
    );

    // The result section and its code block take the remaining height. The
    // `max-height: none` is the dialog-only override of `.tool-result .code-block`.
    const resultSection = blockOf('.dialog-body > .tool-body > .tool-section:last-child {');
    expect(resultSection).toContain('flex: 1 1 auto');
    // A short viewport scrolls `.dialog-body` rather than collapsing the result.
    expect(resultSection).toContain('min-height: 96px');
    expect(blockOf('.dialog-body > .tool-body > .tool-section:last-child > .tool-result {')).toContain(
        'flex-direction: column'
    );
    const result = blockOf('.dialog-body > .tool-body > .tool-section:last-child > .tool-result > .code-block {');
    expect(result).toContain('flex: 1 1 auto');
    expect(result).toContain('min-height: 0');
    expect(result).toContain('max-height: none');
});

it('sizes the ACTUAL manual-runner dialog chain, not the chip body path', () => {
    // F3: the manual runner is built by main.ts as
    //   .dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card
    // and has NO `.tool-body` child. Its own chain must fill the dialog and let
    // `.tool-output > .card-body` take the remaining height.
    const wrap = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap {'
    );
    expect(wrap).toContain('display: flex');
    expect(wrap).toContain('flex: 1 1 auto');
    expect(wrap).toContain('min-height: 0');
    expect(wrap).toContain('padding: 0');

    const log = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log {'
    );
    expect(log).toContain('display: flex');
    expect(log).toContain('flex-direction: column');
    expect(log).toContain('max-width: none');

    const card = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card {'
    );
    expect(card).toContain('flex: 1 1 auto');
    expect(card).toContain('min-height: 0');

    // Only the result grows; the notes/schema/arguments/Call controls keep their
    // intrinsic height.
    expect(
        blockOf(
            '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card > :not(.tool-output) {'
        )
    ).toContain('flex: 0 0 auto');

    const output = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card > .tool-output {'
    );
    expect(output).toContain('display: flex');
    expect(output).toContain('flex: 1 1 auto');
    expect(output).toContain('min-height: 96px');

    const body = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card > .tool-output > .card-body {'
    );
    expect(body).toContain('flex: 1 1 auto');
    expect(body).toContain('min-height: 0');
    expect(body).toContain('max-height: none');
});

it('colours the tool name by state, keeping running neutral', () => {
    expect(blockOf('.tool-name {')).toContain('color: var(--text)');
    expect(blockOf(".tool[data-state='ok'] .tool-name {")).toContain('color: var(--ok)');
    expect(blockOf(".tool[data-state='error'] .tool-name {")).toContain('color: var(--danger)');
    // A long name is ellipsized in the chip but shown in full once expanded.
    expect(blockOf('.tool[open] .tool-name {')).toContain('max-width: none');
});

it('mutes an interrupted call instead of painting it as success or failure', () => {
    // R6: pending work is interrupted, not failed. The chip and its state word drop
    // to the muted colour so a settled tile never reads as red (tool error) or as a
    // live call (the default running style).
    expect(blockOf(".tool[data-state='cancelled'] .tool-name {")).toContain('color: var(--muted)');
    expect(blockOf(".tool[data-state='cancelled'] .tool-state {")).toContain('color: var(--muted)');
    expect(blockOf(".tool[data-state='cancelled'] .tool-glyph {")).toContain('color: var(--muted)');
});
