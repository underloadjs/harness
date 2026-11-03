// R1/R2/R4 (plus T3/R3): phone rails start collapsed, the harness listing opens as a
// drawer from the "Harness UI" brand, the drawer's own "Harnesses" heading is the toggle
// that closes it again, and the SCRATCH board opens from a floating action button above
// the composer as a right-side drawer.
//
// Four contracts, all pinned here:
//   - DOM/state: the right rail's ONLY disclosure trigger is `.scratch-fab` (the header
//     `.rail-toggles` control is gone with the session directory), both rails start
//     collapsed, one rail opens at a time, the trigger reports `aria-expanded`, and
//     Escape, the backdrop, the drawer heading or picking a harness collapse without
//     removing the rails from the DOM; focus returns to the control that opened a drawer;
//   - R2/R4: the brand is a real button whose accessible name is "Harness UI"; clicking
//     it opens the harness listing as an off-canvas sidebar, and the sidebar's
//     "Harnesses" heading is a disclosure toggle for the same rail (focus lands on it);
//   - R3: above 860px the permanently visible rail means the brand must NOT be a
//     tabbable no-op or claim `aria-expanded=false`; it is natively disabled with no
//     disclosure ARIA, and resize transitions restore/remove that semantics;
//   - CSS: the collapse, both drawers and the floating button only exist inside the
//     <=860px media query, so the desktop and tablet layouts keep both rails. The scratch
//     drawer is fixed to the RIGHT edge and slides in from the right (it used to be an
//     in-flow strip), the button is pinned above the composer with the `--composer-height`
//     variable the app writes, and reduced motion turns the slide off. The header session
//     strip is hidden at phone widths because the Instruct dialog carries it instead.
//     jsdom cannot compute media queries, so the stylesheet source is read the same way
//     the other style tests do.
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

    // Opening the scratch drawer closes the harness drawer: the phone has one at a time.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(right.getAttribute('aria-expanded')).toBe('true');

    // Escape is the keyboard dismiss for either rail, and focus returns to the control
    // that opened the drawer being closed.
    right.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(right.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(right);

    // The backdrop is the pointer dismiss for the scratch drawer too, and because the
    // button sits BELOW the backdrop (z-index 1 vs 2) a press there closes the drawer
    // rather than re-opening it under the overlay.
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
    // Below the backdrop (2) and the drawer (3), so an outside press dismisses.
    expect(raised).toContain('z-index: 1');
    expect(raised).toContain('width: 44px');
    expect(raised).toContain('height: 44px');
    expect(raised).toContain('border-radius: 999px');
    expect(raised).toContain('cursor: pointer');
    expect(blockOf('.scratch-fab:focus-visible {')).toContain('outline: 2px solid var(--accent)');
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
    // from the conversation. UNCHANGED by T3 (the left drawer was not part of the ask).
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

    // R3 (T3): the scratch board mirrors it on the RIGHT edge. The old in-flow strip is
    // gone — no extra grid row, no `max-height` cap on the rail.
    const rightDrawer = ".shell[data-rail-open='right'] .rail-right {";
    expect(phone).toContain(rightDrawer);
    const rightBody = blockOf(rightDrawer);
    expect(rightBody).toContain('display: flex');
    expect(rightBody).toContain('position: fixed');
    expect(rightBody).toContain('inset: 0 0 0 auto');
    expect(rightBody).toContain('z-index: 3');
    expect(rightBody).toContain('width: min(86vw, 320px)');
    expect(rightBody).toContain('max-height: none');
    expect(rightBody).toContain('border-left: 1px solid var(--border)');
    expect(rightBody).toContain('animation: rail-slide-in-right 160ms ease-out');
    expect(phone).not.toContain(".shell[data-rail-open='right'] {\n        grid-template-rows: minmax(0, 1fr) auto;\n    }");
    expect(phone).not.toContain('.rail-right {\n        max-height: 38vh;\n    }');

    // ...and the slide comes from the right, matching the edge it opens from.
    const keyframes = blockOf('@keyframes rail-slide-in-right');
    expect(keyframes).toContain('transform: translateX(100%)');
    expect(keyframes).toContain('transform: translateX(0)');

    // Backdrop: hidden by default, a fixed full-viewport layer while open, below both
    // drawers (3) and above the floating button (1).
    expect(blockOf('.rail-backdrop {')).toContain('display: none');
    expect(phone).toContain('.shell[data-rail-open] .rail-backdrop {\n        display: block;');
    expect(phone).toContain('position: fixed');
    expect(phone).toContain('z-index: 2');
    expect(phone).toContain('z-index: 3');
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
