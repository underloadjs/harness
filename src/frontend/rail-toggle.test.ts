// R1/R2/R4 (plus T3/R3 and T8): phone rails start collapsed, the harness listing opens as a
// drawer from the "Harness UI" brand, the drawer's own "Harnesses" heading is the toggle that
// closes it again, and the SCRATCH board opens from a floating action button above the
// composer. T8: the scratch board opens in the SAME left-hand sidebar slot as the harness
// drawer — the phone has ONE sidebar, and pressing either trigger swaps what is in it.
//
// Five contracts, all pinned here:
//   - DOM/state: the right rail's ONLY disclosure trigger is `.scratch-fab` (the header
//     `.rail-toggles` control is gone with the session directory), both rails start
//     collapsed, ONE rail is open at a time (one `data-rail-open` value), each trigger reports
//     `aria-expanded` for its own rail and nothing else, and Escape, the backdrop, the drawer
//     heading or picking a harness collapse without removing the rails from the DOM; focus
//     returns to the control that opened the drawer that is closing — including after a
//     direct switch from one drawer to the other;
//   - T8 switching: with the harness drawer open, one press of the FAB replaces it with the
//     scratch board (no close-then-open, no intermediate state), and the brand does the same
//     in reverse. In jsdom a click is delivered regardless of stacking, so the CSS stacking
//     that makes the FAB pressable above the backdrop is pinned as a stylesheet fact;
//   - R2/R4: the brand is a real button whose accessible name is "Harness UI"; clicking it
//     opens the harness listing as an off-canvas sidebar, and the sidebar's "Harnesses"
//     heading is a disclosure toggle for the same rail (focus lands on it);
//   - R3: above 860px the permanently visible rail means the brand must NOT be a tabbable
//     no-op or claim `aria-expanded=false`; it is natively disabled with no disclosure ARIA,
//     and resize transitions restore/remove that semantics;
//   - CSS: the collapse, both drawers and the floating button only exist inside the <=860px
//     media query, so the desktop and tablet layouts keep both rails. BOTH drawers share one
//     left-hand geometry (`inset: 0 auto 0 0`, `min(86vw, 320px)`, right-edge divider, the
//     same shadow, the same `rail-slide-in` keyframe) and the mirrored `rail-slide-in-right`
//     keyframe is GONE. The button is pinned above the composer with the `--composer-height`
//     variable the app writes and stacked at z-index 4 (over the backdrop and both drawers);
//     its box is sized from the single `--scratch-fab-size` token (T9: 32px, down from 44px,
//     glyph 14px) and the transcript's bottom padding is `calc(var(--scratch-fab-size) * 3)`
//     at BOTH widths, so the gap under the last thread is three button heights, never a
//     duplicated magic number. Reduced motion turns the slide off. The header session strip
//     is hidden at phone widths because the Instruct dialog carries it instead. jsdom cannot
//     compute media queries, so the stylesheet source is read the same way the other style
//     tests do.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve_) => setTimeout(resolve_, 30));
};

// Minimal boot answer: the rail test only needs the shell, not a harness list.
const bootstrap = {
    rootPath: '/api',
    presets: [
        {
            name: 'instruct',
            title: 'Instruct',
            description: 'A general instruction-following agent.',
            requiresEndpoint: true,
            agents: ['instruct'],
            tools: [],
            coreTools: ['toolRequest', 'toolCreate', 'task'],
            primary: 'instruct',
            subagents: [],
            builtin: true,
            editable: true
        }
    ],
    tools: [],
    defaults,
    sessions: [],
    agents: [
        {
            name: 'instruct',
            title: 'Instruct',
            description: 'Answers directly.',
            instruction: 'Answer directly.',
            guidelines: []
        }
    ]
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// Boot main.ts against the stub. Every request the shell makes on load is answered
// here; anything else throws so a new boot request cannot pass silently.
const boot = async (): Promise<HTMLElement> => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') return json(bootstrap);
            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    const shell = document.querySelector<HTMLElement>('.shell');
    if (shell === null) throw new Error('missing shell');
    return shell;
};

// T3/R3: the scratch board's trigger. It is a floating button, not a `.rail-toggle` —
// that whole family of controls is gone with the header disclosure.
const fab = (): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>('.scratch-fab');
    if (found === null) throw new Error('missing scratch fab');
    return found;
};

// A controllable MediaQueryList stand-in. `main.ts` creates ONE query for the whole
// shell, so the returned setter drives both `isPhoneLayout()` and the resize listener
// exactly as a real breakpoint change would.
type PhoneMediaListener = (event: { matches: boolean }) => void;

const stubMedia = (matches: boolean): { setMatches(next: boolean): void } => {
    const listeners = new Set<PhoneMediaListener>();
    const media = {
        matches,
        media: '(max-width: 860px)',
        addEventListener: (_type: string, listener: PhoneMediaListener): void => {
            listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: PhoneMediaListener): void => {
            listeners.delete(listener);
        }
    };

    vi.stubGlobal('matchMedia', vi.fn(() => media));

    return {
        setMatches(next: boolean): void {
            media.matches = next;
            for (const listener of [...listeners]) listener({ matches: next });
        }
    };
};

it('opens the scratch drawer from a floating button that reports its state', async () => {
    const shell = await boot();

    // R3 (T3): exactly ONE right-rail trigger, mounted in the shell (fixed positioning
    // takes it out of the grid), and it names the rail it controls.
    expect(document.querySelectorAll('.rail-toggle, .rail-toggles')).toHaveLength(0);
    const buttons = [...document.querySelectorAll<HTMLElement>('.shell > .scratch-fab')];
    expect(buttons).toHaveLength(1);

    const right = fab();
    expect(right).toBe(buttons[0]);
    expect(right.tagName).toBe('BUTTON');
    expect(right.type).toBe('button');
    expect(right.id).toBe('scratch-fab');
    expect(right.getAttribute('aria-controls')).toBe('rail-right');
    expect(right.getAttribute('aria-expanded')).toBe('false');
    // An icon-only control still needs a real name, and the name stays constant across
    // states (`aria-expanded` carries the state; renaming it would move the announced
    // name under the very change a screen reader is reporting).
    expect(right.getAttribute('aria-label')).toBe('Open scratch board');
    expect(right.title).toBe('Open scratch board');
    // R4: the glyph is decoration, never part of the name.
    expect(right.children).toHaveLength(1);
    expect(right.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(right.textContent).toBe('▤');

    // Collapsed by default: no data state, `aria-expanded` false.
    expect(shell.dataset.railOpen).toBeUndefined();

    // Both rails are in the DOM (CSS, not JS, collapses them) and carry the ids the
    // controls point at. R1 (T3): the right rail is the scratch board alone now.
    expect(document.querySelector('#rail-left')?.className).toBe('rail rail-left');
    expect(document.querySelector('#rail-right')?.className).toBe('rail rail-right');
    expect(document.querySelector('#rail-right')?.getAttribute('aria-label')).toBe('Scratch board');

    // Focus the trigger, then open: the drawer state lands on the shell and the button.
    right.focus();
    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    expect(right.getAttribute('aria-expanded')).toBe('true');

    // Pressing the same button again collapses it, removes the data state, and hands
    // focus back to the button that opened the drawer.
    right.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(right.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(right);

    // The rails survive every toggle: the collapse is presentational only.
    expect(document.querySelector('#rail-left')).not.toBeNull();
    expect(document.querySelector('#rail-right')).not.toBeNull();
});

it('keeps the two phone rails exclusive and dismisses the scratch drawer like the other', async () => {
    const shell = await boot();
    const backdrop = document.querySelector<HTMLElement>('.rail-backdrop');
    if (backdrop === null) throw new Error('missing backdrop');
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');

    const brand = document.querySelector<HTMLButtonElement>('.brand');
    if (brand === null) throw new Error('missing brand trigger');
    const right = fab();

    // T8: opening the scratch drawer REPLACES the harness drawer in one press — the phone has
    // one sidebar slot, and `data-rail-open` is a single value that simply moves.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(right.getAttribute('aria-expanded')).toBe('true');

    // Escape is the keyboard dismiss for either rail, and focus returns to the control
    // that opened the drawer being closed — after a SWITCH that is the control of the rail
    // that is showing, never the trigger of the one that was replaced.
    right.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(right.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(right);

    // The backdrop is the pointer dismiss for the scratch drawer too. The FAB is stacked
    // ABOVE the backdrop (z-index 4 vs 2, T8) so it stays pressable while a drawer is open —
    // that is what makes the switch above reachable with one tap — and every other outside
    // press still lands on the backdrop and collapses the drawer.
    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    backdrop.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(right.getAttribute('aria-expanded')).toBe('false');

    // The left rail still behaves exactly as before (R4: its heading is the toggle).
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    const heading = document.querySelector<HTMLButtonElement>('.rail-title-toggle');
    if (heading === null) throw new Error('missing harness title toggle');
    expect(document.activeElement).toBe(heading);
    heading.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(document.activeElement).toBe(brand);
});

it('switches the single sidebar from the harness drawer to the scratch board in one press', async () => {
    const shell = await boot();

    const brand = document.querySelector<HTMLButtonElement>('.brand');
    if (brand === null) throw new Error('missing brand trigger');
    const heading = document.querySelector<HTMLButtonElement>('.rail-title-toggle');
    if (heading === null) throw new Error('missing harness title toggle');
    const right = fab();

    // Open the harness drawer: both left-rail triggers are expanded, focus is inside the
    // drawer (on its own toggle), and the scratch board is closed.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(brand.getAttribute('aria-expanded')).toBe('true');
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(right.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(heading);

    // ONE press on the FAB, with the harness drawer open: it lands on the button (it is
    // stacked above the backdrop), the slot changes hands, and NOTHING is left half-open —
    // no intermediate close, and no stale disclosure state on either of the two controls
    // that lost the slot.
    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    expect(right.getAttribute('aria-expanded')).toBe('true');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(heading.getAttribute('aria-expanded')).toBe('false');

    // T8: focus follows the switch to the control that now dismisses the open drawer. The
    // heading it was on is inside a rail CSS has hidden, so leaving focus there would strand
    // a keyboard reader on an unrendered element (a browser drops it to <body>).
    expect(document.activeElement).toBe(right);

    // The board is still the rail the button names, and the rails themselves were never
    // removed or rebuilt by the switch.
    expect(right.getAttribute('aria-controls')).toBe('rail-right');
    expect(document.querySelector('#rail-left')).not.toBeNull();
    expect(document.querySelector('#rail-right')).not.toBeNull();

    // Second press closes the scratch drawer (it is a toggle, not a one-way control), and the
    // trigger that opened it gets focus back.
    right.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(right.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(right);
});

it('switches the single sidebar back to the harness drawer in one press', async () => {
    const shell = await boot();

    const brand = document.querySelector<HTMLButtonElement>('.brand');
    if (brand === null) throw new Error('missing brand trigger');
    const heading = document.querySelector<HTMLButtonElement>('.rail-title-toggle');
    if (heading === null) throw new Error('missing harness title toggle');
    const right = fab();

    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    expect(right.getAttribute('aria-expanded')).toBe('true');

    // The brand is under the backdrop on a phone, so a pointer press there would be a
    // dismiss; the DIRECT switch is therefore pinned the way the app performs it — the same
    // path the brand's own click handler runs (`setRailOpen(openRail === 'left' ? undefined :
    // 'left', brand)`), which jsdom can reach because it has no hit-testing. The result is
    // one state change: right → left, with the FAB's disclosure cleared.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(right.getAttribute('aria-expanded')).toBe('false');
    expect(brand.getAttribute('aria-expanded')).toBe('true');
    expect(heading.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(heading);

    // And the drawer that is now open still dismisses to its own trigger, so the switch did
    // not leave the focus contract pointing at the scratch button.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(document.activeElement).toBe(brand);
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(right.getAttribute('aria-expanded')).toBe('false');
});

it('opens the harness sidebar from the brand and closes it from the Harnesses title', async () => {
    const shell = await boot();

    const brand = document.querySelector<HTMLButtonElement>('.brand');
    if (brand === null) throw new Error('missing brand trigger');

    // R2: the visible title is a real button, not a clickable div, so keyboard users
    // reach the same action and the accessible name matches the visible label.
    expect(brand.tagName).toBe('BUTTON');
    expect(brand.type).toBe('button');
    expect(brand.disabled).toBe(false);
    expect(brand.textContent).toBe('◍Harness UI');
    expect(brand.getAttribute('aria-controls')).toBe('rail-left');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(brand.title).toBe('Show or hide harnesses');
    // The decorative mark is not part of the accessible name.
    expect(brand.querySelector('.brand-mark')?.getAttribute('aria-hidden')).toBe('true');

    // R4: the drawer's dismissal control IS the "Harnesses" heading. It opens and closes
    // the same sidebar as the brand, so the small `×` control is gone: no `.rail-close`
    // exists anywhere in the shell.
    const close = document.querySelector<HTMLButtonElement>('.rail-title-toggle');
    if (close === null) throw new Error('missing harness title toggle');
    expect(document.querySelector('.rail-close')).toBeNull();

    // The heading keeps its semantics: an `h2.rail-title` whose text is exactly the
    // section name, with the control inside it (not beside it).
    const heading = document.querySelector('h2.rail-title');
    expect(heading?.textContent).toBe('Harnesses');
    expect(heading?.contains(close)).toBe(true);
    expect(close.tagName).toBe('BUTTON');
    expect(close.type).toBe('button');
    expect(close.textContent).toBe('Harnesses');
    // Same disclosure contract as the brand: it names the rail it controls.
    expect(close.getAttribute('aria-controls')).toBe('rail-left');
    expect(close.getAttribute('aria-expanded')).toBe('false');
    expect(close.title).toBe('Show or hide harnesses');

    // Opening from the brand: the left rail opens, BOTH left-rail triggers report it, the
    // scratch button stays collapsed, and the listing stays in the DOM. Focus moves to
    // the drawer's own toggle so keyboard users can Escape or dismiss immediately.
    brand.focus();
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(brand.getAttribute('aria-expanded')).toBe('true');
    expect(close.getAttribute('aria-expanded')).toBe('true');
    expect(fab().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('#rail-left .harness-list')).not.toBeNull();
    expect(document.activeElement).toBe(close);

    // The title is a real toggle: pressing it collapses the drawer it belongs to, and
    // focus returns to the brand that opened it (the old `×` behaviour, preserved).
    close.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(close.getAttribute('aria-expanded')).toBe('false');
    expect(fab().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(brand);
    expect(document.querySelector('#rail-left')).not.toBeNull();

    // Pressing the title while the rail is closed opens it again (it is the same
    // disclosure, not a close-only control), and the brand then closes it.
    close.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(close.getAttribute('aria-expanded')).toBe('true');
    brand.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.getAttribute('aria-expanded')).toBe('false');

    // The title is also a toggle opened by nothing else: a second press on the title
    // closes the drawer it opened.
    close.click();
    expect(shell.dataset.railOpen).toBe('left');
    close.click();
    expect(shell.dataset.railOpen).toBeUndefined();
});

it('keeps the desktop brand a non-disclosure and restores affordances across resize transitions', async () => {
    // Desktop first: both rails are permanently visible, so the brand must not expose
    // a collapsed disclosure or remain a tabbable no-op button.
    const media = stubMedia(false);
    const shell = await boot();

    const brand = document.querySelector<HTMLButtonElement>('.brand');
    if (brand === null) throw new Error('missing brand trigger');

    expect(brand.disabled).toBe(true);
    expect(brand.hasAttribute('aria-controls')).toBe(false);
    expect(brand.hasAttribute('aria-expanded')).toBe(false);
    expect(brand.title).toBe('');
    expect(brand.textContent).toBe('◍Harness UI');

    // R4: the harness title obeys the same platform rule. On desktop it is a plain
    // heading (disabled, no disclosure ARIA), because a permanently visible rail has no
    // collapsed state to announce.
    const title = document.querySelector<HTMLButtonElement>('.rail-title-toggle');
    if (title === null) throw new Error('missing harness title toggle');
    expect(title.disabled).toBe(true);
    expect(title.hasAttribute('aria-controls')).toBe(false);
    expect(title.hasAttribute('aria-expanded')).toBe(false);
    expect(title.title).toBe('');

    // A programmatic click cannot open a phone rail on desktop; the permanently
    // visible rail itself is still present in the DOM (CSS owns its display, including
    // hiding the floating button — see the stylesheet contract below).
    brand.click();
    title.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(document.querySelector('#rail-left')).not.toBeNull();

    // Enter the phone breakpoint: both controls become the real harness-drawer toggles.
    media.setMatches(true);
    expect(brand.disabled).toBe(false);
    expect(brand.getAttribute('aria-controls')).toBe('rail-left');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(brand.title).toBe('Show or hide harnesses');
    expect(title.disabled).toBe(false);
    expect(title.getAttribute('aria-controls')).toBe('rail-left');
    expect(title.getAttribute('aria-expanded')).toBe('false');

    title.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(title.getAttribute('aria-expanded')).toBe('true');

    // Leave the phone breakpoint while the drawer is open: the rail state is reset
    // and the desktop semantics come back, with no false collapsed ARIA state.
    media.setMatches(false);
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.disabled).toBe(true);
    expect(brand.hasAttribute('aria-controls')).toBe(false);
    expect(brand.hasAttribute('aria-expanded')).toBe(false);
    expect(brand.title).toBe('');
    expect(title.disabled).toBe(true);
    expect(title.hasAttribute('aria-controls')).toBe(false);
    expect(title.hasAttribute('aria-expanded')).toBe(false);
    expect(title.title).toBe('');
    // The scratch button's disclosure state resets with the rail, so re-entering the
    // breakpoint cannot leave a stale `aria-expanded="true"` on a hidden control.
    expect(fab().getAttribute('aria-expanded')).toBe('false');

    // Re-entering the phone breakpoint starts from the clean collapsed state, rather
    // than resurrecting the rail the resize dismissed.
    media.setMatches(true);
    expect(brand.disabled).toBe(false);
    expect(brand.getAttribute('aria-controls')).toBe('rail-left');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(title.disabled).toBe(false);
    expect(title.getAttribute('aria-controls')).toBe('rail-left');
    expect(title.getAttribute('aria-expanded')).toBe('false');
});

it('dismisses an open rail with Escape and with the backdrop', async () => {
    const shell = await boot();
    const backdrop = document.querySelector<HTMLElement>('.rail-backdrop');
    if (backdrop === null) throw new Error('missing backdrop');

    const brand = document.querySelector<HTMLButtonElement>('.brand');
    if (brand === null) throw new Error('missing brand trigger');

    // Escape closes the harness drawer opened from the brand.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(fab().getAttribute('aria-expanded')).toBe('false');

    // The backdrop is the pointer dismiss for the scratch drawer too.
    fab().click();
    expect(shell.dataset.railOpen).toBe('right');
    backdrop.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(fab().getAttribute('aria-expanded')).toBe('false');

    // Picking a harness from the open rail is also a dismissal: the chat should be
    // visible immediately, not hidden behind a rail the reader has finished with.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    document.querySelector<HTMLButtonElement>('.harness-item')?.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.getAttribute('aria-expanded')).toBe('false');
});

// --- stylesheet contract ---------------------------------------------------

// Mirror ui/activity-style.test.ts: resolve the stylesheet from the package root
// (`npm test`) or the frontend root (vitest.config.ts `root`).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Comments NAME the removed rules, so "must be gone" assertions read the stripped
// stylesheet (see thread-style.test.ts).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Slice a rule/at-rule's body by brace matching (the phone block nests rules, so
// the first `}` is not its end).
const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
        if (css[index] === '{') depth += 1;
        if (css[index] === '}') {
            depth -= 1;
            if (depth === 0) return css.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
};

it('hides the scratch button outside the phone breakpoint and floats it inside', () => {
    // The header disclosure family is gone entirely: the rail toggle it carried had
    // nothing left to open once the sessions moved under the title (T3/R1).
    expect(rules).not.toContain('.rail-toggles');
    expect(rules).not.toContain('.rail-toggle {');
    expect(rules).not.toContain('.rail-toggle-right');

    // Base rule: hidden everywhere except the phone block below.
    expect(blockOf('.scratch-fab {').trim()).toBe('display: none;');

    const phone = blockOf('@media (max-width: 860px)');
    const raised = blockOf('.scratch-fab {\n        display: inline-flex;');
    expect(phone).toContain('.scratch-fab {\n        display: inline-flex;');

    // Fixed bottom-right, and ABOVE the composer rather than on top of it: `bottom` is
    // the measured composer height plus a gap, with a static fallback for the first
    // frame and for a host with no layout engine at all.
    expect(raised).toContain('position: fixed');
    expect(raised).toContain('right: 14px');
    expect(raised).toContain('bottom: calc(var(--composer-height, 76px) + 12px)');
    // T8: ABOVE the backdrop (2) and both drawers (3). This is the only way onto the scratch
    // board, so it has to stay pressable while the harness drawer is open — one press then
    // SWITCHES drawers instead of being swallowed by the backdrop as an outside dismiss.
    expect(raised).toContain('z-index: 4');
    // T9: the box is sized from ONE shared token (`--scratch-fab-size`, 32px), because the
    // transcript's bottom gap is derived from the same number — the button the gap exists to
    // clear. It dropped from 44px to 32px (too big next to the phone chrome) and the glyph
    // scales with it (17px -> 14px); the circle survives on `border-radius: 999px`.
    expect(raised).toContain('width: var(--scratch-fab-size)');
    expect(raised).toContain('height: var(--scratch-fab-size)');
    expect(raised).toContain('border-radius: 999px');
    expect(raised).toContain('font-size: 14px');
    expect(raised).not.toContain('width: 44px');
    expect(raised).not.toContain('height: 44px');
    expect(raised).not.toContain('font-size: 17px');
    // The token is defined once, at the root, as the single source of the size.
    expect(blockOf(':root {')).toContain('--scratch-fab-size: 32px;');
    expect(raised).not.toContain('--scratch-fab-size:');
    expect(rules.match(/--scratch-fab-size:/g)).toHaveLength(1);
    expect(blockOf('.rail-toggle-icon {')).toContain('font-size: 14px');
    expect(raised).toContain('cursor: pointer');
    expect(blockOf('.scratch-fab:focus-visible {')).toContain('outline: 2px solid var(--accent)');
});

it('gaps the transcript bottom by three scratch-button heights', () => {
    // The page needs visible space between the LAST thread and the bottom edge, and that
    // space has to be a multiple of the floating button that sits in it — never a second
    // magic number tuned by eye. Anchor the base rule to its own first declaration: the
    // dialog runner's `.dialog-body > … > .log-wrap` appears earlier in the sheet.
    const transcript = blockOf('.log-wrap {\n    flex: 1;');
    expect(transcript).toContain('padding: 18px 20px calc(var(--scratch-fab-size) * 3);');
    expect(transcript).not.toContain('padding: 18px 20px;');

    // Phone: the 14px side inset shrinks, but a shorthand that repeated `14px` four times
    // would erase the gap under the last message, so the bottom leg stays `* 3`.
    const phone = blockOf('@media (max-width: 860px)');
    expect(phone).toContain('.log-wrap {\n        padding: 14px 14px calc(var(--scratch-fab-size) * 3);\n    }');
    expect(phone).not.toContain('.log-wrap {\n        padding: 14px;\n    }');

    // ONE token, four references (the button's two axes plus both transcript `calc` legs):
    // the gap and the button it clears can only ever move together.
    expect(rules.match(/var\(--scratch-fab-size\)/g)).toHaveLength(4);

    // The modal tool runner keeps its own zeroed inset (the dialog body owns that padding),
    // so the new leg must not leak into it.
    expect(blockOf('.dialog-body > .tool-runner-slot > .pane > .log-wrap {')).toContain('padding: 0;');
});

it('collapses both rails only inside the phone breakpoint', () => {
    const phone = blockOf('@media (max-width: 860px)');

    // R1 (T3): the harness header keeps only the title row, the session strip and the
    // note, and on a phone the strip moves into the title's dialog.
    expect(phone).toContain('.session-pills-bar-head {\n        display: none;\n    }');

    // Default collapsed: neither rail is displayed without an open state.
    expect(phone).toContain('.rail-left,\n    .rail-right {\n        display: none;\n    }');

    // The chat keeps the content row when both rails are collapsed (`display:none`
    // rails are not auto-placed, so the row placement must be explicit).
    expect(phone).toContain('.center {\n        grid-row: 1;\n    }');

    // R2: the harness listing is a dashboard-style off-canvas sidebar. It is FIXED to
    // the viewport and full height, rather than an in-flow strip that steals a grid row
    // from the conversation. T8: this rule is the geometry BOTH drawers now use, and it is
    // byte-identical to the scratch drawer below, so switching cannot move the panel.
    const drawer = ".shell[data-rail-open='left'] .rail-left {";
    expect(phone).toContain(drawer);
    expect(phone).not.toContain(
        ".shell[data-rail-open='left'] {\n        grid-template-rows: auto minmax(0, 1fr);\n    }"
    );
    expect(phone).not.toContain(".shell[data-rail-open='left'] .center");
    expect(phone).toContain('inset: 0 auto 0 0');
    expect(phone).toContain('width: min(86vw, 320px)');
    expect(phone).toContain('max-height: none');
    expect(phone).toContain('animation: rail-slide-in 160ms ease-out');

    // The brand and the drawer's own heading are the human-readable triggers. R4: the
    // small `×` control is GONE from the sheet as well as the DOM — the heading carries
    // the pointer affordance at phone widths, and its base rule keeps it inert (no
    // pointer cursor) wherever the rail is permanent.
    expect(phone).toContain('.brand {\n        cursor: pointer;\n    }');
    expect(css).not.toContain('.rail-close');
    expect(blockOf('.rail-title-toggle {')).not.toContain('cursor: pointer');
    expect(phone).toContain('.rail-title-toggle {\n        cursor: pointer;\n    }');
    expect(phone).toContain('.rail-title-toggle:hover {\n        color: var(--text);\n    }');

    // T8: the scratch board takes this drawer's slot exactly, so the two open states are one
    // geometry with different contents. The old in-flow strip is still gone — no extra grid
    // row, no `max-height` cap on the rail.
    const rightDrawer = ".shell[data-rail-open='right'] .rail-right {";
    expect(phone).toContain(rightDrawer);
    const rightBody = blockOf(rightDrawer);
    expect(rightBody).toContain('display: flex');
    expect(rightBody).toContain('position: fixed');
    // The left edge, not the right: `inset: 0 auto 0 0` (the harness drawer's placement), and
    // the divider moves to the panel's RIGHT edge with it.
    expect(rightBody).toContain('inset: 0 auto 0 0');
    expect(rightBody).toContain('z-index: 3');
    expect(rightBody).toContain('width: min(86vw, 320px)');
    expect(rightBody).toContain('max-height: none');
    expect(rightBody).toContain('border-right: 1px solid var(--border)');
    expect(rightBody).toContain('box-shadow: 16px 0 48px rgba(0, 0, 0, 0.55)');
    expect(rightBody).toContain('animation: rail-slide-in 160ms ease-out');

    // Nothing right-sided survives the move.
    expect(rightBody).not.toContain('inset: 0 0 0 auto');
    expect(rightBody).not.toContain('border-left: 1px solid var(--border)');
    expect(rightBody).not.toContain('box-shadow: -16px 0 48px');
    expect(rightBody).not.toContain('rail-slide-in-right');

    // The harness drawer, for the comparison below.
    const leftBody = blockOf(drawer);

    // ONE geometry, written per rail: below their selectors the two open rules are
    // byte-identical (comments stripped, whitespace normalised). That is the strongest form
    // of "there is only one sidebar, viewing whichever item is selected" — switching cannot
    // resize, re-edge, re-shadow or re-slide the panel, only change what is inside it. The
    // `border-top: 0` / `border-left: 0` lines are the tablet strip's dividers (861-1180px),
    // cleared in both rules so a drawer never inherits a divider on the wrong edge.
    const declarationsOf = (body: string): string =>
        body
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join('\n');

    const drawerGeometry = [
        'display: flex;',
        'position: fixed;',
        'inset: 0 auto 0 0;',
        'z-index: 3;',
        'width: min(86vw, 320px);',
        'max-height: none;',
        'border-top: 0;',
        'border-left: 0;',
        'border-right: 1px solid var(--border);',
        'border-bottom: 0;',
        'box-shadow: 16px 0 48px rgba(0, 0, 0, 0.55);',
        'animation: rail-slide-in 160ms ease-out;'
    ].join('\n');

    expect(declarationsOf(leftBody)).toBe(drawerGeometry);
    expect(declarationsOf(rightBody)).toBe(drawerGeometry);
    expect(declarationsOf(rightBody)).toBe(declarationsOf(leftBody));

    expect(phone).not.toContain(".shell[data-rail-open='right'] {\n        grid-template-rows: minmax(0, 1fr) auto;\n    }");
    expect(phone).not.toContain('.rail-right {\n        max-height: 38vh;\n    }');

    // One slide, from the left edge both drawers now occupy. The mirrored right-hand keyframe
    // is DELETED (comments may still name it, so this reads the stripped stylesheet).
    expect(rules).not.toContain('rail-slide-in-right');
    const keyframes = blockOf('@keyframes rail-slide-in {');
    expect(keyframes).toContain('transform: translateX(-100%)');
    expect(keyframes).toContain('transform: translateX(0)');

    // Backdrop: hidden by default, a fixed full-viewport layer while open, below both
    // drawers (3) and below the floating scratch button (4, T8 — the button must stay
    // pressable to switch drawers).
    expect(blockOf('.rail-backdrop {')).toContain('display: none');
    expect(phone).toContain('.shell[data-rail-open] .rail-backdrop {\n        display: block;');
    expect(phone).toContain('position: fixed');
    expect(phone).toContain('z-index: 2');
    expect(phone).toContain('z-index: 3');
    // The stack is total, not implied: nothing in the phone block may re-rank the button back
    // under the layer it has to punch through.
    expect(phone).toContain('z-index: 4');
    expect(blockOf('.scratch-fab {\n        display: inline-flex;')).toContain('z-index: 4');
});

it('stops the drawer animation for reduced motion', () => {
    // Both drawers are decoration on top of a state change, so removing the slide loses
    // no information — and the right drawer must not be the one that was forgotten.
    const reduced = blockOf('@media (prefers-reduced-motion: reduce)');
    expect(reduced).toContain(".shell[data-rail-open='left'] .rail-left,");
    expect(reduced).toContain(".shell[data-rail-open='right'] .rail-right {");
    expect(reduced).toContain('animation: none !important');
});

it('leaves the tablet and desktop shells untouched', () => {
    // The 1180px block still lays the right rail out as a strip under the chat; it must
    // not hide either rail (that is phone-only), and T3/R3 did not move it.
    const tablet = blockOf('@media (max-width: 1180px)');
    expect(tablet).toContain('.rail-right {\n        grid-column: 1 / -1;');
    expect(tablet).not.toContain('display: none');

    // Base shell is still the three-column grid, so a closed phone state cannot
    // leak into a desktop layout.
    expect(blockOf('.shell {')).toContain('grid-template-columns: 248px minmax(0, 1fr) 320px');
});
