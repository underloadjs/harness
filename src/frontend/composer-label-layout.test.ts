// Composer label + button layout (T7 R14/R15/R16).
//
// Two contracts are pinned here:
//   - R14: the routing line ("New thread" / "Continuing …" / "Steering …") is a
//     FLOATING notched label on the composer frame's top border, not a separate row
//     above it. It stays the same `<p class="composer-target">` node (text and
//     `data-mode` keep their behavior in thread-routing.test.ts), and the field
//     describes itself with it only while it is visible.
//   - R16: the single agent button sits on the LEFT edge of the same frame and is
//     seamless (transparent background/border), while stop/send stay on the right.
//
// The CSS half is read from the stylesheet source because jsdom does not run layout;
// the DOM half mounts the live shell so the wiring (which element is where, and the
// `data-target`/`aria-describedby` state) is proven, not just declared in CSS.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts composer-label-layout.test.ts

import type { HarnessDescriptor, SessionSnapshot } from '../server/protocol';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const SESSION_KEY = 'underload-harness-app:session';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: ['toolRequest'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

type ThreadFixture = {
    id: string;
    agent: string;
    origin: 'host';
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
};

const snapshot = (options: { threads?: ThreadFixture[] } = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...(options.threads === undefined ? {} : { threads: options.threads })
    }) as unknown as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// Mounts the shell with a SAVED session so `paintComposerTarget` runs against a real
// snapshot (a brand-new session has no threads, which is the hidden-label case).
const mount = async (session: SessionSnapshot): Promise<void> => {
    localStorage.setItem(SESSION_KEY, 's1');
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [session],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions') return json({ sessions: [session] });
            if (url === '/api/sessions/s1') return json({ session });
            if (url === '/api/sessions/s1/events') {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            // The test only needs the observer to attach; no frames.
                            void controller;
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            throw new Error(`unexpected request: ${url}`);
        }))
    );

    await import('./main');
    await flush();
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// --- live shell wiring ------------------------------------------------------

it('floats the routing label on the frame and puts the agent button on its left', async () => {
    await mount(
        snapshot({
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'One' }
            ]
        })
    );

    const field = byClass('.composer-field', 'div');
    // R14: the label is a CHILD of the frame (not of `.composer-body`), so the
    // stylesheet can position it over the frame's own top border.
    expect(
        [...field.children].map((child) => child.className)
    ).toEqual(['composer-target', 'agent-slot', 'input composer-input', 'composer-popup', 'composer-controls']);
    expect(byClass('.composer-target', 'p').parentElement).toBe(field);
    // The body column holds only the (hidden unless a batch was rejected) error line
    // and the frame; the label no longer adds a row between them.
    expect(
        [...byClass('.composer-body', 'div').children].map((child) => child.className)
    ).toEqual(['composer-attachment-error', 'composer-field']);

    const label = byClass('.composer-target', 'p');
    expect(label.id).toBe('composer-target');
    expect(label.textContent).toBe('New thread');
    expect(label.hidden).toBe(false);
    // The frame reserves the notch padding only while the label is painted.
    expect(field.dataset.target).toBe('true');
    // R14 accessibility: the visible routing promise also describes the field.
    expect(byClass('.composer-input', 'div').getAttribute('aria-describedby')).toBe('composer-target');

    // R16: agent (left) → text → stop/send (right), all inside the same frame.
    const input = byClass('.composer-input', 'div');
    const agent = byClass('.agent-control-button', 'button');
    const controls = byClass('.composer-controls', 'div');
    expect(agent.closest('.composer-field')).toBe(field);
    expect(agent.closest('.composer-controls')).toBeNull();
    expect(
        agent.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
        input.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect([...controls.children].map((child) => child.className)).toEqual([
        'composer-stop',
        'composer-action'
    ]);
});

it('hides the label and its notch padding when a session has nothing to distinguish', async () => {
    await mount(snapshot());

    const field = byClass('.composer-field', 'div');
    const label = byClass('.composer-target', 'p');
    const input = byClass('.composer-input', 'div');

    // R15: no label row and no reserved notch => the idle frame is one input line.
    expect(label.hidden).toBe(true);
    expect(label.textContent).toBe('New thread');
    expect(field.dataset.target).toBe('false');
    // A description that pointed at a display:none node would be dropped by AT; the
    // attribute is removed instead so the field's accessible name is just its label.
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.getAttribute('aria-label')).toBe('Task message');

    // R16 is width-independent: the agent button is still the frame's first control.
    const agent = byClass('.agent-control-button', 'button');
    expect(agent.closest('.composer-field')).toBe(field);
    expect(agent.closest('.composer-controls')).toBeNull();
});

// --- Issue B: the notch label's TEXT starts on the caret ---------------------

it('measures the notched label onto the input text column', async () => {
    await mount(
        snapshot({
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'One' }
            ]
        })
    );

    const label = byClass('.composer-target', 'p');
    const input = byClass('.composer-input', 'div');

    // The mount-time paint runs with no layout available (`offsetLeft` 0), so the label
    // lands on the stylesheet's floor. Asserting it first is what makes the measured
    // value below provably a MEASUREMENT and not just the fallback repeated.
    expect(label.style.left).toBe('10px');

    // jsdom has no layout engine: `offsetLeft` is a prototype getter that always reads
    // 0, and the stylesheet is not applied, so BOTH inputs of the measurement are
    // pinned on the element. 80px is the desktop geometry — 1px frame border + 2px field
    // padding + the agent button's box — and the padding is pinned inline so the
    // expected number cannot depend on which stylesheet the host happens to load.
    Object.defineProperty(input, 'offsetLeft', { value: 80, configurable: true });
    input.style.paddingLeft = '8px';

    // The 860px media query swaps the pill from the full agent name to its short code
    // with NO DOM change, so a resize is the only signal the label has to re-measure.
    // Driving the listener pins the wiring and the arithmetic in one step.
    window.dispatchEvent(new Event('resize'));

    // offsetLeft (80, already relative to `.composer-field`, the label's own containing
    // block) + the input's text inset (8) - the label's own `padding: 0 5px` (5), which
    // is what puts the label's TEXT — not its background box — on the caret.
    expect(label.style.left).toBe('83px');
});

it('clears the measured left when the label is hidden', async () => {
    await mount(snapshot());

    const label = byClass('.composer-target', 'p');
    const input = byClass('.composer-input', 'div');

    // A measurement left over from a LABELED state must not survive into the hidden
    // one: `[hidden]` is `display: none`, so `offsetLeft` reads 0 while hidden and the
    // next painted label would otherwise start from a stale x instead of the fallback.
    Object.defineProperty(input, 'offsetLeft', { value: 80, configurable: true });
    input.style.paddingLeft = '8px';
    label.style.left = '83px';

    window.dispatchEvent(new Event('resize'));

    expect(label.hidden).toBe(true);
    expect(label.style.left).toBe('');
});

// --- stylesheet contract ----------------------------------------------------

const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

// Comments NAME old selectors, so assertions read the stripped stylesheet.
const rules = readFileSync(stylesheet, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const blockOf = (selector: string): string => {
    const start = rules.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = rules.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < rules.length; index += 1) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') {
            depth -= 1;
            if (depth === 0) return rules.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
};

it('styles the routing line as a notched label and reserves space only when painted', () => {
    const label = blockOf('.composer-target {');
    // R14: out of flow on the frame's top border, masking it with the COMPOSER
    // surface (the frame itself is `--bg-input`).
    expect(label).toContain('position: absolute');
    expect(label).toContain('top: 0');
    expect(label).toContain('left: 10px');
    expect(label).toContain('transform: translateY(-50%)');
    expect(label).toContain('background: var(--bg-bar)');
    expect(label).toContain('pointer-events: none');
    // The old separate row (margin/gap above the field) is gone.
    expect(label).not.toContain('margin: 0 0 4px');
    expect(label).not.toContain('line-height: 1.4');

    // R15: the notch clearance exists only in the labeled state.
    expect(blockOf(".composer-field[data-target='true'] {")).toContain('padding-top: 8px');

    // Hidden is a real removal, not a transparent overlay.
    expect(blockOf('.composer-target[hidden] {')).toContain('display: none');
});

it('makes the left agent button seamless and keeps the right control row compact', () => {
    const button = blockOf('.agent-control-button {');
    // R16: no standalone border/background box inside the input frame.
    expect(button).toContain('border: 1px solid transparent');
    expect(button).toContain('background: transparent');
    // Geometry (and therefore hover/focus rings and the compact code swap) is kept.
    expect(button).toContain('height: 32px');
    expect(button).toContain('border-radius: var(--radius-sm)');
    expect(button).toContain('max-width: 180px');

    // R15: the right row's padding no longer exceeds the text's own 32px line box,
    // so stop/send do not make the idle frame taller than one input line.
    expect(blockOf('.composer-controls {')).toContain('padding: 2px 2px 2px 0');
});
