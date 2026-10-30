// One-card-per-thread CSS contract (R1/R2/R3).
//
// The DOM projection is pinned in ui/thread-conversation.test.ts; jsdom cannot
// compute paint, so — like turn-tile-style.test.ts — this reads the stylesheet and
// pins the properties that make ONE thread read as ONE block:
//   - R2: the `.conversation` container carries the frame (border, radius, surface,
//     agent outline) and the exchanges inside it carry NONE, so a follow-up appended
//     to a focused thread never looks like a second card;
//   - R2: exchanges are separated by a hairline, not by a card gap;
//   - R3: a nested child-conversation row (a distinct thread) KEEPS its framed tile;
//   - R1: the persistent-thread badge leads the header (`order: 0`, identity) while
//     `.tile-top` stays the right-aligned measurement cluster.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// `import.meta.url` is not a file: URL under jsdom. Resolve the stylesheet from the
// package root (`npm test`) or the frontend root (vitest.config.ts `root`).
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

it('draws the card on the conversation container, not on each exchange', () => {
    const card = blockOf('.conversation {');

    // The frame that used to sit on every run's `.tile`.
    expect(card).toContain('border: 1px solid var(--border)');
    expect(card).toContain('border-radius: var(--radius)');
    expect(card).toContain('background: var(--bg-elevated)');
    // Identity is the same outline treatment as a single tile (painted per thread).
    expect(card).toContain('outline: 1px solid var(--agent-line)');
    expect(card).toContain('outline-offset: -2px');
    // Rounded corners must actually clip the inner exchanges.
    expect(card).toContain('overflow: hidden');

    // The exchanges inside the card are frameless: no second border, no second
    // outline, no surface of their own.
    const exchanges = blockOf(
        '.conversation > .turn-row:not([data-child-thread]) > .tile,\n.thread-flow > .turn-row > .tile {'
    );
    expect(exchanges).toContain('border: 0');
    expect(exchanges).toContain('border-radius: 0');
    expect(exchanges).toContain('outline: 0');
    expect(exchanges).toContain('background: transparent');

    // Sequential messages, not stacked cards: a hairline separator.
    expect(blockOf('.conversation .turn-row + .turn-row {')).toContain('border-top: 1px solid var(--border)');
});

it('keeps a distinct child thread card framed inside the owner', () => {
    // The frameless rule is scoped to exchanges of the SAME thread; the nested
    // `[data-child-thread]` row (a child without its own invocation card) keeps the
    // `.tile` frame it inherits, so two agent threads never collapse into one block.
    expect(css).toContain('.conversation > .turn-row:not([data-child-thread]) > .tile,');
    expect(blockOf('.conversation .turn-row[data-child-thread] {')).toContain('margin-left: 14px');

    // A resumed child appends into its own card: the card header names the identity,
    // so the exchange must not repeat it.
    expect(blockOf('.thread-flow > .turn-row :is(.tile-thread, .tile-agent) {')).toContain('display: none');
});

it('places the thread identity left of the header measurements (R1)', () => {
    // The badge shares the identity slot with `.tile-agent` / `.thread-name`.
    expect(blockOf('.tile-thread {')).toContain('order: 0');
    // `.tile-top` remains the right-aligned measurement cluster, so the badge cannot
    // drift back next to the clock/tokens.
    expect(blockOf('.tile:not(.is-expanded) .tile-top {')).toContain('margin-left: auto');
    // The expanded header stacks as a column: the pill must not stretch full width.
    expect(blockOf('.tile.is-expanded .tile-thread {')).toContain('align-self: flex-start');
});
