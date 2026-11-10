/**
 * Live records panels CSS contract (the T6 section of styles.css).
 *
 * The behaviour half of these two panels lives in ./extensions/records-panels.ts and its
 * test; this file pins the CSS half, so a future style edit cannot silently:
 *   - hide the live region with `display: none`, which would take it out of the
 *     accessibility tree and stop every announcement (R2);
 *   - drop a `data-phase` rule, leaving one of the five states visually identical to
 *     another (R1);
 *   - make `line-through` the only mark of a completed task (R3);
 *   - turn the task row back into a list of words: the collapsed row is a tick-or-cross
 *     mark and its text, the state's colour comes from the same `data-completed` the
 *     glyph shape comes from, and the only word left is the clipped one that carries
 *     the button's accessible name;
 *   - hide the row's detail area (or the state word) with `display: none` in a way that
 *     costs the disclosure or the accessible name;
 *   - leave an animation running under `prefers-reduced-motion` (R3);
 *   - style a class the panels no longer paint, or paint a class nobody styles, which is
 *     how a skeleton quietly becomes invisible;
 *   - reach outside the `.panel-tasks-*` / `.panel-records-*` namespaces, which is what
 *     keeps one panel's rules from ever touching the other.
 *
 * It holds no import of the panels, so it stays runnable while behaviour changes.
 *
 * Run: npx vitest run --config src/frontend/vitest.config.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Same resolution as the other CSS-source tests: package root (`yarn test:frontend`) or
// the frontend root (vitest.config.ts `root`).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));

if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// The live-panel rules are ONE section, appended at the end (the task's rule: nothing in
// the existing stylesheet is edited, so nothing existing can regress). Everything here
// reads that section only.
const MARKER = 'the live shell panels';
const markerIndex = css.indexOf(MARKER);

if (markerIndex < 0) throw new Error('the live shell panel section is missing from styles.css');

// The slice starts at the section's OWN opening `/*` so the header comment — which NAMES
// old selectors — is stripped along with the rest. Comments NAME selectors, so the "must
// be gone" assertions read the stripped text (see composer-style.test.ts).
const section = css.slice(css.lastIndexOf('/*', markerIndex)).replace(/\/\*[\s\S]*?\*\//g, '');

// The two TS files whose class names these rules bind. Reading them as text (rather than
// importing) keeps this file free of jsdom and of the panels' own module graph.
const panelSources = ['src/frontend/extensions/records-panels.ts', 'src/frontend/extensions/records-dom.ts']
    .map((candidate) => readFileSync(resolve(process.cwd(), candidate), 'utf8'))
    .join('\n');

// Brace-matched slice, so a nested `@media` body is never cut at the first `}`.
const blockOf = (selector: string, source = section): string => {
    const start = source.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = source.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
};

// Every `.panel*` class the section draws rules for.
const styledClasses = (): Set<string> =>
    new Set([...section.matchAll(/\.panel[a-z0-9-]*/g)].map((match) => match[0].slice(1)));

// The classes the panels actually paint: every string literal that starts with `panel`,
// plus the skeleton rows and cells ./records-dom.ts builds by suffixing the wrapper's own
// class name (`${className}-row`).
const paintedClasses = (): Set<string> => {
    const found = new Set<string>();

    for (const match of panelSources.matchAll(/'((?:panel[\w -]*)+)'/g)) {
        for (const name of match[1].split(' ')) found.add(name);
    }

    // `recordsSkeletonOf('panel-tasks-skeleton', …)` and its records twin.
    for (const match of panelSources.matchAll(/'panel-(tasks|records)-skeleton'/g)) {
        found.add(`panel-${match[1]}-skeleton-row`);
        found.add(`panel-${match[1]}-skeleton-cell`);
    }

    // `recordsStateOf('panel-tasks-error', …)` appends `-action` to the class it is
    // given, and only the error note is ever given a button.
    for (const match of panelSources.matchAll(/'panel-(tasks|records)-error'/g)) {
        found.add(`panel-${match[1]}-error-action`);
    }

    return found;
};

describe('the live panel stylesheet', () => {
    it('appends one clearly marked section at the very end of the stylesheet', () => {
        // One marker, and the section is the tail of the file: nothing is inserted above
        // it, so no pre-existing rule of the shell can be restated or overridden.
        expect(css.slice(markerIndex).split(MARKER)).toHaveLength(2);

        for (const earlier of ['.composer-field {', '.block-detail-retry {', '.panel-title {']) {
            expect(css.indexOf(earlier)).toBeLessThan(markerIndex);
        }

        // The live panels' own names appear NOWHERE above the section — the whole surface
        // is additive.
        const before = css.slice(0, css.lastIndexOf('/*', markerIndex));

        expect(before.match(/panel-tasks|panel-records|panel-new-pill|panel-live/g)).toBeNull();

        // It runs to EOF: the last bytes of the stylesheet are the section's last rule.
        expect(css.trimEnd().endsWith('}')).toBe(true);
        expect(section.trimEnd().endsWith('}')).toBe(true);
        expect(section).toContain('@media (forced-colors: active) {');
    });

    it('keeps every selector inside its own namespace', () => {
        // The shared names are the ones BOTH panels draw, and they are few on purpose:
        // a rule for one feed must never reach the other (see the section's own header).
        const shared = new Set([
            'panel-actor',
            'panel-expand',
            'panel-history',
            'panel-history-actor',
            'panel-history-stamp',
            'panel-history-verb',
            'panel-live',
            'panel-live-line',
            'panel-new-pill',
            'panel-skeleton',
            'panel-skeleton-cell',
            'panel-skeleton-row',
            'panel-stamp',
            'panel-state'
        ]);

        for (const name of styledClasses()) {
            const inNamespace = name.startsWith('panel-tasks-') || name.startsWith('panel-records-');

            expect(inNamespace || shared.has(name), name).toBe(true);
        }

        // And no selector reaches outside `.panel*` (a `time`/`li`/`button` tag rule here
        // would style the whole document's elements of that kind). Only a rule that starts
        // at column 0 is a selector; an indented `from {` is a keyframe step.
        const selectors = section
            .split('\n')
            .filter((line) => /^[^\s}]/.test(line) && line.trim().endsWith('{'));

        for (const line of selectors) {
            const selector = line.trim();

            expect(selector.startsWith('.panel') || selector.startsWith('@'), selector).toBe(true);
        }

        // The card frame itself belongs to the pre-existing `.panel` rules above.
        expect(section).not.toContain('.panel {');
        expect(section).not.toContain('.panel-title {');
        expect(section).not.toContain('.panel-blocks {');
    });

    it('styles every class the panels paint', () => {
        // Structural hooks that carry layout from their PARENT (the scroller's flex
        // column) or sit as a flex item inside an already-styled row. Each is a wrapper
        // or a text span, never the thing the reader looks at.
        const structural = new Set([
            'panel-history-fields',
            'panel-records-skeleton',
            'panel-records-states',
            'panel-tasks-group',
            'panel-tasks-lists',
            'panel-tasks-skeleton',
            'panel-tasks-states'
        ]);

        const styled = styledClasses();
        const missing = [...paintedClasses()].filter((name) => !styled.has(name) && !structural.has(name));

        // A new painted class has to appear here (with a rule) or above (with a reason).
        expect(missing).toEqual([]);
    });
});

describe('the five states', () => {
    it('draws loading, stale and error for BOTH panels from data-phase alone', () => {
        // LOADING keeps the chrome and dims the list: the card must not resize when the
        // data lands.
        const loading = blockOf("[data-phase='loading']");
        expect(loading).toContain('opacity: 0.6');
        expect(section).toContain(".panel-tasks-body[data-phase='loading'] .panel-tasks-progress");
        expect(section).toContain(".panel-records-body[data-phase='loading'] .panel-records-filters");

        // STALE and ERROR each get their own edge, and the colour is never the only
        // signal — the sync line and the note say the words.
        const stale = blockOf("[data-phase='stale'],");
        expect(stale).toContain('border-left: 2px dashed var(--warn)');

        const error = blockOf("[data-phase='error'],");
        expect(error).toContain('border-left: 2px solid var(--danger)');

        for (const state of ['loading', 'stale', 'error']) {
            expect(section).toContain(`.panel-tasks-body[data-phase='${state}']`);
            expect(section).toContain(`.panel-records-body[data-phase='${state}']`);
        }
    });

    it('colours the sync line and the state note from the same attribute the TS sets', () => {
        // `dataset.state` in ./records-dom.ts `recordsStateOf` / the sync rail; the copy
        // and the colour cannot drift apart because both read one attribute.
        const staleLine = blockOf("[data-state='stale'],");
        expect(staleLine).toContain('color: var(--warn)');

        const errorLine = blockOf("[data-state='error'],");
        expect(errorLine).toContain('color: var(--danger)');

        // The ERROR note overrides the shared dashed box. The anchor is the whole
        // selector pair because both names appear in the shared rule above as well.
        const errorNote = blockOf('.panel-tasks-error,\n.panel-records-error {');
        expect(errorNote).toContain('border-color: var(--danger)');
        expect(errorNote).toContain('border-style: solid');
        expect(errorNote).toContain('color: var(--text)');
    });

    it('gives the empty state a box and the error state a Retry that is really pressable', () => {
        const note = blockOf('.panel-state,');
        expect(note).toContain('display: flex');
        expect(note).toContain('flex-wrap: wrap');
        expect(note).toContain('border: 1px dashed var(--border)');

        for (const action of ['.panel-tasks-error-action,', '.panel-records-error-action']) {
            const block = blockOf(action);
            expect(block).toContain('cursor: pointer');
            expect(block).toContain('font: inherit');
        }

        // The button label is the only text; `font: inherit` keeps it at the note's size.
        expect(blockOf('.panel-tasks-error-action,')).toContain('color: var(--accent)');
    });
});

describe('the motion contract', () => {
    it('marks a row that just landed with an attribute, and a colour that is not the only cue', () => {
        const fresh = blockOf("[data-fresh='true'],");
        expect(fresh).toContain('border-left-color: var(--accent)');
        expect(fresh).toContain('animation: records-land 1.5s ease-out');

        // The border survives when the tint is dropped (forced colours) or faded out.
        expect(section).toContain('.panel-tasks-row[data-fresh');
        expect(section).toContain('.panel-records-row[data-fresh');

        const keyframes = blockOf('@keyframes records-land {');
        expect(keyframes).toContain('background-color: color-mix(in srgb, var(--accent) 28%, transparent)');
        expect(keyframes).toContain('background-color: transparent');
    });

    it('keeps the FLIP transform available to the animator without painting anything itself', () => {
        // The animator writes `transform`/`transition` inline; the attribute is the
        // durable fact, and this rule only hints the compositor.
        const flip = blockOf("[data-flip],");
        expect(flip).toContain('will-change: transform');
        expect(section).toContain('.panel-tasks-row[data-flip]');
        expect(section).toContain('.panel-records-row[data-flip]');
    });

    it('shimmers only a skeleton that is actually on screen, and mirrors the row layout', () => {
        const cell = blockOf('.panel-skeleton-cell,');
        expect(cell).toContain('animation: records-skeleton-shimmer 1.2s linear infinite');

        // ./records-dom.ts `recordsSkeletonOf` suffixes the wrapper's class name, so both
        // panels' rows and cells have their OWN names — and both must be styled here or
        // the skeleton collapses into an invisible box.
        const row = blockOf('.panel-skeleton-row,');
        for (const name of ['panel-tasks-skeleton-row', 'panel-records-skeleton-row']) {
            expect(section).toContain(`.${name}`);
        }
        for (const name of ['panel-tasks-skeleton-cell', 'panel-records-skeleton-cell']) {
            expect(section).toContain(`.${name}`);
        }
        expect(row).toContain('min-height: 18px');

        const keyframes = blockOf('@keyframes records-skeleton-shimmer {');
        expect(keyframes).toContain('background-position: 120% 0');
        expect(keyframes).toContain('background-position: -120% 0');
    });

    it('stops every animation under prefers-reduced-motion, and keeps every fact', () => {
        const reduced = blockOf('@media (prefers-reduced-motion: reduce) {');

        // The two animations die; the highlight's BORDER and tint do not, because
        // `data-fresh` is a fact about the row a reader still deserves to see.
        expect(reduced).toContain('animation: none !important');
        expect(reduced).toContain('.panel-skeleton-cell');
        expect(reduced).toContain(".panel-tasks-row[data-fresh='true']");
        expect(reduced).toContain(".panel-records-row[data-fresh='true']");
        expect(reduced).toContain('transition: none');
        expect(reduced).toContain('.panel-new-pill');
        expect(reduced).toContain('.panel-expand');
        expect(reduced).toContain('will-change: auto');

        // Nothing outside that media block animates a panel.
        const outside = section.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/, '');
        const animated = outside
            .split('\n')
            .filter((line) => /^\s*animation(-name)?:\s*records-/.test(line));

        expect(animated.map((line) => line.trim())).toEqual([
            'animation: records-skeleton-shimmer 1.2s linear infinite;',
            'animation: records-land 1.5s ease-out;'
        ]);
    });
});

describe('the reading position', () => {
    it('makes one thing scroll: the feed, never the rail', () => {
        // The follow controller reads `scrollTop`/`clientHeight`/`scrollHeight` off this
        // element, so a panel that scrolled the whole page instead would silently stop
        // following (./records-dom.ts `createRecordsFollowController`).
        const scroller = blockOf('.panel-tasks-scroller,');
        expect(scroller).toContain('overflow-y: auto');
        expect(scroller).toContain('min-height: 0');
        expect(scroller).toContain('overscroll-behavior: contain');
        expect(scroller).toContain('max-height:');
        expect(section).toContain('.panel-records-scroller');

        // The body is the positioning context the pill pins itself to.
        const body = blockOf('.panel-tasks-body,');
        expect(body).toContain('position: relative');
        expect(body).toContain('flex-direction: column');
        expect(body).toContain('min-width: 0');
    });

    it('floats the "N new" pill over the scroller and removes it with hidden', () => {
        const pill = blockOf('.panel-new-pill {');
        expect(pill).toContain('position: absolute');
        expect(pill).toContain('transform: translateX(-50%)');
        expect(pill).toContain('cursor: pointer');

        // `hidden` is the only state change the pill needs, and it has to be a real
        // removal — an opacity change would leave a click target over the rows.
        expect(blockOf('.panel-new-pill[hidden]')).toContain('display: none');
    });
});

describe('the accessibility furniture', () => {
    it('clips the live region instead of hiding it', () => {
        // `display: none` or `visibility: hidden` would take the region out of the
        // accessibility tree, and then nothing the panels announce is announced.
        const live = blockOf('.panel-live {');
        expect(live).toContain('position: absolute');
        expect(live).toContain('clip-path: inset(50%)');
        expect(live).toContain('overflow: hidden');
        expect(live).toContain('white-space: nowrap');
        expect(live).not.toContain('display: none');
        expect(live).not.toContain('visibility: hidden');

        expect(blockOf('.panel-live-line')).toContain('display: block');
    });

    it('never makes a strike the only mark of a completed task', () => {
        expect(section).not.toContain('line-through');

        // The row dims its text; the glyph is a MARK (a tick or a cross) and the state
        // word is clipped rather than shown. The row itself carries `data-completed` for
        // the tests and the CSS alike, and the group heading says the same thing in
        // words, so nothing here leans on colour alone.
        const completed = blockOf("[data-completed='true'] .panel-tasks-row-text {");
        expect(completed).toContain('color: var(--muted)');
        expect(completed).toContain('opacity: 0.82');

        expect(blockOf('.panel-tasks-glyph[data-completed')).toContain('color: var(--ok)');
    });

    it('draws the row state from one attribute, in a shape and in a colour', () => {
        // Both facts about a row's state come from the SAME `data-completed` the TS sets
        // (./records-panels.ts `renderRow`), so the mark, the edge and the wash cannot
        // drift apart from the row they describe.
        const done = blockOf(".panel-tasks-row[data-completed='true'] {");

        expect(done).toContain('border-left-color: var(--ok-line)');
        expect(done).toContain('background: var(--ok-wash)');

        const open = blockOf(".panel-tasks-row[data-completed='false'] {");

        expect(open).toContain('border-left-color: var(--warn)');
        expect(open).toContain('color-mix(in srgb, var(--warn) 10%, transparent)');
        // An open task is unfinished, not wrong: the row never borrows the danger red.
        expect(open).not.toContain('--danger');
        expect(blockOf('.panel-tasks-glyph {')).toContain('color: var(--warn)');
        expect(blockOf('.panel-tasks-glyph {')).not.toContain('--danger');

        // The fresh marker is the one exception, and it is an ORDER fact: the accent
        // edge rule is written after the two status rules, at equal specificity.
        const status = section.indexOf(".panel-tasks-row[data-completed='true'] {");
        const fresh = section.indexOf("[data-fresh='true'],");

        expect(status).toBeLessThan(fresh);
    });

    it('makes the whole collapsed row the control, and hides its detail with `hidden`', () => {
        // The row is a real `<button>`, so the browser supplies Enter, Space and the
        // focus ring; the reset is what stops it drawing its own chrome and centreing a
        // sentence. `.panel-tasks-detail[hidden]` has to win over the flex rule below it,
        // for the same reason `.panel-new-pill[hidden]` does.
        const head = blockOf('.panel-tasks-row-head {');

        expect(head).toContain('cursor: pointer');
        expect(head).toContain('text-align: left');
        expect(head).toContain('background: none');
        expect(head).toContain('border: 0');
        expect(head).toContain('width: 100%');
        expect(blockOf('.panel-tasks-row-head:focus-visible')).toContain('outline: 1px solid var(--accent)');

        const detail = blockOf('.panel-tasks-detail {');

        expect(detail).toContain('display: flex');
        expect(detail).toContain('flex-direction: column');
        expect(blockOf('.panel-tasks-detail[hidden]')).toContain('display: none');
        expect(blockOf('.panel-tasks-detail-text')).toContain('overflow-wrap: anywhere');
        expect(blockOf('.panel-tasks-detail-meta')).toContain('flex-wrap: wrap');
    });

    it('keeps the state word in the accessible name, clipped rather than hidden', () => {
        // `display: none` would take "completed"/"open" out of the button's accessible
        // name, and a tick is not a word: the row would then say its state in shape and
        // colour only. Same clip recipe as `.panel-live`.
        const state = blockOf('.panel-tasks-row-state {');

        expect(state).toContain('clip-path: inset(50%)');
        expect(state).toContain('overflow: hidden');
        expect(state).not.toContain('display: none');
        expect(state).not.toContain('visibility: hidden');
    });

    it('draws the progress bar from the same figure the accessibility tree reads', () => {
        const bar = blockOf('.panel-tasks-bar {');
        expect(bar).toContain('background-size: var(--records-progress, 0%) 100%');

        // The TS writes the custom property and `aria-valuenow` from ONE calculation
        // (./records-panels.ts), so the rail and the reader cannot disagree.
        expect(panelSources).toContain('--records-progress');
        expect(panelSources).toMatch(/aria-valuenow|ariaValueNow/);
    });

    it('keeps the state in forced-colours mode, where the tints are dropped', () => {
        const forced = blockOf('@media (forced-colors: active) {');
        expect(forced).toContain('border-left-color: Highlight');
        expect(forced).toContain('background: Canvas');
        expect(forced).toContain(".panel-tasks-row[data-fresh='true']");
        expect(forced).toContain(".panel-records-row[data-fresh='true']");
        expect(forced).toContain(".panel-records-chip[data-active='true']");

        // Both task states are listed by name, so losing the wash still leaves an edge
        // per state — and the glyph's shape and the clipped word say it regardless.
        expect(forced).toContain(".panel-tasks-row[data-completed='true']");
        expect(forced).toContain(".panel-tasks-row[data-completed='false']");

        // The status edges are written BEFORE the fresh rule, again so "just landed"
        // outranks "which group" for its ~1.5s in this mode too.
        expect(forced.indexOf(".panel-tasks-row[data-completed='true']")).toBeLessThan(
            forced.indexOf(".panel-tasks-row[data-fresh='true']")
        );
    });

    it('labels the feed filter group so the chips are not a mystery row', () => {
        const filters = blockOf('.panel-records-filters {');
        expect(filters).toContain('display: flex');
        expect(filters).toContain('flex-wrap: wrap');

        // The active chip is the one the reader is ON: pressed styling plus the count in
        // its own label, never colour alone.
        const active = blockOf("[data-active='true']");
        expect(active).toContain('border-color: var(--accent)');
        expect(active).toContain('color: var(--accent)');
    });
});
