// R1: phone rails start collapsed and are opened from the topbar.
//
// Two contracts, both pinned here:
//   - DOM/state: two independent toggles exist in the topbar, both rails start
//     collapsed, one rail opens at a time, the toggle they own reports
//     `aria-expanded`, and Escape or the backdrop collapses without removing the
//     rails from the DOM;
//   - CSS: the collapse only exists inside the <=860px media query, so the desktop
//     and tablet layouts keep both rails. jsdom cannot compute media queries, so the
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
const expanded = (): (string | null)[] => toggles().map((button) => button.getAttribute('aria-expanded'));

it('starts both phone rails collapsed and toggles them one at a time', async () => {
    const shell = await boot();

    const [left, right] = toggles();
    expect(toggles()).toHaveLength(2);
    expect(toggles().map((button) => button.getAttribute('aria-controls'))).toEqual([
        'rail-left',
        'rail-right'
    ]);
    expect(toggles().map((button) => button.getAttribute('aria-label'))).toEqual([
        'Harnesses panel',
        'Scratch board and sessions panel'
    ]);
    // Collapsed by default: no data state, both `aria-expanded` false.
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false', 'false']);

    // Both rails are in the DOM (CSS, not JS, collapses them) and carry the ids the
    // toggles point at.
    expect(document.querySelector('#rail-left')?.className).toBe('rail rail-left');
    expect(document.querySelector('#rail-right')?.className).toBe('rail rail-right');

    // Open left: it becomes the only open rail.
    left.click();
    expect(shell.dataset.railOpen).toBe('left');
    expect(expanded()).toEqual(['true', 'false']);

    // Opening right closes left (exclusive, one rail at a time).
    right.click();
    expect(shell.dataset.railOpen).toBe('right');
    expect(expanded()).toEqual(['false', 'true']);

    // Pressing the same toggle again collapses it and removes the data state.
    right.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false', 'false']);

    // The rails survive every toggle: the collapse is presentational only.
    expect(document.querySelector('#rail-left')).not.toBeNull();
    expect(document.querySelector('#rail-right')).not.toBeNull();
});

it('dismisses an open rail with Escape and with the backdrop', async () => {
    const shell = await boot();
    const backdrop = document.querySelector<HTMLElement>('.rail-backdrop');
    if (backdrop === null) throw new Error('missing backdrop');
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');

    // Escape closes whichever rail is open.
    toggles()[0].click();
    expect(shell.dataset.railOpen).toBe('left');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false', 'false']);

    // The backdrop is the pointer dismiss.
    toggles()[1].click();
    expect(shell.dataset.railOpen).toBe('right');
    backdrop.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false', 'false']);

    // Picking a harness from the open rail is also a dismissal: the chat should be
    // visible immediately, not hidden behind a rail the reader has finished with.
    toggles()[0].click();
    expect(shell.dataset.railOpen).toBe('left');
    document.querySelector<HTMLButtonElement>('.harness-item')?.click();
    expect(shell.dataset.railOpen).toBeUndefined();
    expect(expanded()).toEqual(['false', 'false']);
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

    // The toggles are phone-only; their base rule hides them everywhere else.
    expect(blockOf('.rail-toggles {')).toContain('display: none');
    expect(phone).toContain('.rail-toggles {\n        display: flex;\n    }');

    // Default collapsed: neither rail is displayed without an open state.
    expect(phone).toContain('.rail-left,\n    .rail-right {\n        display: none;\n    }');

    // The chat keeps the content row when both rails are collapsed (`display:none`
    // rails are not auto-placed, so the row placement must be explicit).
    expect(phone).toContain('.center {\n        grid-row: 1;\n    }');

    // Each open state restores its OWN display type: the left rail is a flex
    // column, the right rail a grid of sections at this width; each adds one row and
    // keeps the chat in the remaining 1fr row.
    expect(phone).toContain(
        ".shell[data-rail-open='left'] {\n        grid-template-rows: auto minmax(0, 1fr);\n    }"
    );
    expect(phone).toContain(
        ".shell[data-rail-open='left'] .rail-left {\n        display: flex;\n        grid-row: 1;\n    }"
    );
    expect(phone).toContain(
        ".shell[data-rail-open='left'] .center {\n        grid-row: 2;\n    }"
    );
    expect(phone).toContain(
        ".shell[data-rail-open='right'] {\n        grid-template-rows: minmax(0, 1fr) auto;\n    }"
    );
    expect(phone).toContain(
        ".shell[data-rail-open='right'] .rail-right {\n        display: grid;\n        grid-template-columns: minmax(0, 1fr);\n        grid-row: 2;\n    }"
    );

    // Backdrop: hidden by default, a fixed full-viewport layer while open, below the
    // rail it dismisses.
    expect(blockOf('.rail-backdrop {')).toContain('display: none');
    expect(phone).toContain('.shell[data-rail-open] .rail-backdrop {\n        display: block;');
    expect(phone).toContain('position: fixed');
    expect(phone).toContain('z-index: 1');
    expect(phone).toContain('z-index: 2');
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
