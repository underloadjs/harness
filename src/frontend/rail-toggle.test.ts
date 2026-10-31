// R1/R2/R4: phone rails start collapsed, the harness listing opens as a drawer
// from the "Harness UI" brand, and legacy topbar toggles remain available.
//
// Three contracts, all pinned here:
//   - DOM/state: two independent ICON-ONLY toggles exist in the topbar, both rails
//     start collapsed, one rail opens at a time, the toggle they own reports
//     `aria-expanded`, and Escape, the backdrop, the drawer close control or picking
//     a harness collapse without removing the rails from the DOM;
//   - R2: the brand is a real button whose accessible name is "Harness UI"; clicking
//     it opens the harness listing as an off-canvas sidebar and the sidebar exposes
//     an accessible close control;
//   - R3: above 860px the permanently visible rail means the brand must NOT be a
//     tabbable no-op or claim `aria-expanded=false`; it is natively disabled with no
//     disclosure ARIA, and resize transitions restore/remove that semantics;
//   - CSS: the collapse and the drawer only exist inside the <=860px media query, so
//     the desktop and tablet layouts keep both rails; the harness drawer is fixed
//     and full-height instead of an in-flow strip, while the right rail keeps its
//     existing in-flow placement. jsdom cannot compute media queries, so the
//     stylesheet source is read the same way the other style tests do.
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
            coreTools: ['toolRequest', 'toolCreate', 'todoManage'],
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

const toggles = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('.rail-toggle')
];
// R1: only the RIGHT rail has a topbar/title-row toggle, so this is a one-element
// list (the left rail is opened by the brand button).
const expanded = (): (string | null)[] => toggles().map((button) => button.getAttribute('aria-expanded'));

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

it('keeps one phone rail toggle, on the harness title row, and toggles the right rail', async () => {
    const shell = await boot();

    // R1: the topbar no longer repeats the harness-listing trigger — the brand button
    // opens that rail — so exactly ONE rail toggle remains, and it is the scratch/
    // sessions control.
    const toggles = [...document.querySelectorAll<HTMLButtonElement>('.rail-toggle')];
    expect(toggles).toHaveLength(1);
    const [right] = toggles;
    expect(toggles.map((button) => button.getAttribute('aria-controls'))).toEqual(['rail-right']);
    expect(toggles.map((button) => button.getAttribute('aria-label'))).toEqual([
        'Scratch board and sessions panel'
    ]);
    expect(toggles.map((button) => button.title)).toEqual([
        'Show or hide the scratch board and sessions rail'
    ]);
    // R4: icon-only. The toggle's entire content is ONE decorative glyph; the
    // accessible name above is the only human-readable label.
    expect(toggles.map((button) => button.textContent)).toEqual(['▤']);
    expect(toggles.map((button) => button.children.length)).toEqual([1]);
    expect(toggles.map((button) => button.firstElementChild?.getAttribute('aria-hidden'))).toEqual([
        'true'
    ]);

    // R1: the toggle sits on the harness title row, to the RIGHT of the title, not in
    // the topbar. The row's `margin-left: auto` places it at the far right on a phone.
    const row = document.querySelector<HTMLElement>('.harness-title-row');
    if (row === null) throw new Error('missing harness title row');
    expect(row.contains(right)).toBe(true);
    expect(right.parentElement?.className).toBe('rail-toggles');
    expect(document.querySelector('.topbar')?.contains(right)).toBe(false);
    const rowChildren = [...row.children].map((child) => child.className);
    expect(rowChildren).toEqual(['main-title', 'harness-id', 'rail-toggles']);

    // Collapsed by default: no data state, `aria-expanded` false.
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(right.getAttribute('aria-expanded')).toBe('false');

    // Both rails are in the DOM (CSS, not JS, collapses them) and carry the ids the
    // controls point at.
    expect(document.querySelector('#rail-left')?.className).toBe('rail rail-left');
    expect(document.querySelector('#rail-right')?.className).toBe('rail rail-right');

    // Open right: it becomes the only open rail and reports it.
    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    expect(right.getAttribute('aria-expanded')).toBe('true');

    // Pressing the same toggle again collapses it and removes the data state.
    right.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(right.getAttribute('aria-expanded')).toBe('false');

    // The rails survive every toggle: the collapse is presentational only.
    expect(document.querySelector('#rail-left')).not.toBeNull();
    expect(document.querySelector('#rail-right')).not.toBeNull();
});

it('opens the harness sidebar from the Harness UI brand and closes it from the drawer control', async () => {
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

    // The drawer's own close control is button-labelled, not a glyph-only target.
    const close = document.querySelector<HTMLButtonElement>('.rail-close');
    if (close === null) throw new Error('missing drawer close button');
    expect(close.tagName).toBe('BUTTON');
    expect(close.type).toBe('button');
    expect(close.textContent).toBe('×');
    expect(close.getAttribute('aria-label')).toBe('Close harnesses panel');

    // Opening from the brand is the same state as the (removed) hamburger: the left
    // rail opens, the brand reports it, the right toggle stays collapsed, and the
    // listing stays in the DOM. Focus moves into the drawer so keyboard users can
    // Escape or dismiss immediately.
    brand.focus();
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(brand.getAttribute('aria-expanded')).toBe('true');
    expect(expanded()).toEqual(['false']);
    expect(document.querySelector('#rail-left .harness-list')).not.toBeNull();
    expect(document.activeElement).toBe(close);

    // Closing hands focus back to the trigger; the drawer is hidden (CSS) but its
    // DOM and selection state are untouched.
    close.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(expanded()).toEqual(['false']);
    expect(document.activeElement).toBe(brand);
    expect(document.querySelector('#rail-left')).not.toBeNull();

    // Brand is a toggle: a second press closes the sidebar it opened.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    brand.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.getAttribute('aria-expanded')).toBe('false');
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

    // A programmatic click cannot open a phone rail on desktop; the permanently
    // visible rail itself is still present in the DOM (CSS owns its display).
    brand.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(document.querySelector('#rail-left')).not.toBeNull();

    // Enter the phone breakpoint: the brand becomes the real harness-drawer toggle.
    media.setMatches(true);
    expect(brand.disabled).toBe(false);
    expect(brand.getAttribute('aria-controls')).toBe('rail-left');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
    expect(brand.title).toBe('Show or hide harnesses');

    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(brand.getAttribute('aria-expanded')).toBe('true');

    // Leave the phone breakpoint while the drawer is open: the rail state is reset
    // and the desktop semantics come back, with no false collapsed ARIA state.
    media.setMatches(false);
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(brand.disabled).toBe(true);
    expect(brand.hasAttribute('aria-controls')).toBe(false);
    expect(brand.hasAttribute('aria-expanded')).toBe(false);
    expect(brand.title).toBe('');

    // Re-entering the phone breakpoint starts from the clean collapsed state, rather
    // than resurrecting the rail the resize dismissed.
    media.setMatches(true);
    expect(brand.disabled).toBe(false);
    expect(brand.getAttribute('aria-controls')).toBe('rail-left');
    expect(brand.getAttribute('aria-expanded')).toBe('false');
});

it('dismisses an open rail with Escape and with the backdrop', async () => {
    const shell = await boot();
    const backdrop = document.querySelector<HTMLElement>('.rail-backdrop');
    if (backdrop === null) throw new Error('missing backdrop');
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');

    const brand = document.querySelector<HTMLButtonElement>('.brand');
    if (brand === null) throw new Error('missing brand trigger');

    // Escape closes the harness drawer opened from the brand.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false']);

    // The backdrop is the pointer dismiss for the right rail too.
    toggles()[0].click();
    expect(shell.dataset.railOpen).toBe('right');
    backdrop.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false']);

    // Picking a harness from the open rail is also a dismissal: the chat should be
    // visible immediately, not hidden behind a rail the reader has finished with.
    brand.click();
    expect(shell.dataset.railOpen).toBe('left');
    document.querySelector<HTMLButtonElement>('.harness-item')?.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false']);
});

// --- stylesheet contract ---------------------------------------------------

// Mirror ui/activity-style.test.ts: resolve the stylesheet from the package root
// (`npm test`) or the frontend root (vitest.config.ts `root`).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

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

it('collapses both rails only inside the phone breakpoint', () => {
    const phone = blockOf('@media (max-width: 860px)');

    // The toggle is phone-only; its base rule hides it everywhere else.
    expect(blockOf('.rail-toggles {')).toContain('display: none');
    expect(phone).toContain('.rail-toggles {\n        display: flex;\n    }');
    // R1: it belongs to the harness title row, pushed to the far right of that row.
    expect(blockOf('.rail-toggles {')).toContain('margin-left: auto');
    expect(phone).toContain('.harness-title-row {\n        align-items: center;\n    }');

    // Default collapsed: neither rail is displayed without an open state.
    expect(phone).toContain('.rail-left,\n    .rail-right {\n        display: none;\n    }');

    // The chat keeps the content row when both rails are collapsed (`display:none`
    // rails are not auto-placed, so the row placement must be explicit).
    expect(phone).toContain('.center {\n        grid-row: 1;\n    }');

    // R2: the harness listing opens as a dashboard-style off-canvas sidebar. It is
    // FIXED to the viewport and full height, rather than an in-flow strip that steals
    // a grid row from the conversation.
    const drawer = ".shell[data-rail-open='left'] .rail-left {";
    expect(phone).toContain(drawer);
    expect(phone).not.toContain(
        ".shell[data-rail-open='left'] {\n        grid-template-rows: auto minmax(0, 1fr);\n    }"
    );
    expect(phone).not.toContain(".shell[data-rail-open='left'] .center");
    expect(phone).toContain('position: fixed');
    expect(phone).toContain('inset: 0 auto 0 0');
    expect(phone).toContain('width: min(86vw, 320px)');
    expect(phone).toContain('max-height: none');
    expect(phone).toContain('z-index: 3');

    // The brand is the human-readable trigger, and the drawer has its own visible
    // close control at phone widths (hidden at wider widths, where rails are fixed).
    expect(phone).toContain('.brand {\n        cursor: pointer;\n    }');
    expect(blockOf('.rail-close {')).toContain('display: none');
    expect(phone).toContain('.rail-close {\n        display: inline-flex;\n    }');

    // The right rail keeps the existing in-flow strip below the chat: only the
    // harness listing moved into the overlay sidebar.
    expect(phone).toContain(
        ".shell[data-rail-open='right'] {\n        grid-template-rows: minmax(0, 1fr) auto;\n    }"
    );
    expect(phone).toContain(
        ".shell[data-rail-open='right'] .rail-right {\n        display: grid;\n        grid-template-columns: minmax(0, 1fr);\n        grid-row: 2;"
    );

    // Backdrop: hidden by default, a fixed full-viewport layer while open, below the
    // drawer it dismisses (2) and above the in-flow right strip.
    expect(blockOf('.rail-backdrop {')).toContain('display: none');
    expect(phone).toContain('.shell[data-rail-open] .rail-backdrop {\n        display: block;');
    expect(phone).toContain('position: fixed');
    expect(phone).toContain('z-index: 2');
    expect(phone).toContain('z-index: 3');
});

it('leaves the tablet and desktop shells untouched', () => {
    // The 1180px block still lays the right rail out as a two-section strip; it must
    // not hide either rail (that is phone-only).
    const tablet = blockOf('@media (max-width: 1180px)');
    expect(tablet).toContain('.rail-right {\n        grid-column: 1 / -1;');
    expect(tablet).not.toContain('display: none');

    // Base shell is still the three-column grid, so a closed phone state cannot
    // leak into a desktop layout.
    expect(blockOf('.shell {')).toContain('grid-template-columns: 248px minmax(0, 1fr) 320px');
});
