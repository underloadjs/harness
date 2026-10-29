// Composer control behavior (R9/R10) in the live shell.
//
// The request is the opposite of the old three-button footer: ONE field, one row by
// default, with ONE action that lives inside the box in the same spot:
//
//   text present (idle or running)  -> submit chevron/play  (queues while running)
//   empty + pending work            -> stop X
//   empty + idle                    -> nothing at all
//
// Reset is gone; this file proves no `.run` / `.stop` / `.reset` control survives
// outside the in-field action, and that Enter / Shift+Enter / clicking keep the
// exact submission semantics the old buttons had.
//
// The field's growth math is unit-tested in ui/composer.test.ts; here the textarea's
// `scrollHeight` is stubbed because jsdom has no layout.

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'todoManage', 'agentDelegate'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'running',
    startedAt: T,
    updatedAt: T,
    events: [],
    ...overrides
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const bootstrap = (): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents: []
});

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// The whole server surface this page needs. `tasks` counts POST /sessions/:id/tasks;
// `cancels` records every cancel body. GET /sessions/s1 answers a RUNNING snapshot
// until a cancel lands, then a terminal one, which is what drives pending -> false.
type Server = { tasks: number; cancels: unknown[]; cancelled: boolean };

const stubServer = (): Server => {
    const server: Server = { tasks: 0, cancels: [], cancelled: false };

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() }, 201);

            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                server.tasks += 1;
                const opening = turn({ prompt: `task ${server.tasks}` });
                return json(
                    { session: snapshot({ status: 'running', turns: [opening] }), turn: opening },
                    202
                );
            }

            if (url === '/api/sessions/s1/events') {
                // A live stream that never emits: the POST answers above own the
                // pending state for this test, and no frame can settle it behind us.
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start() {
                            // Intentionally empty: the test drives every transition.
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            if (url === '/api/sessions/s1/cancel' && method === 'POST') {
                server.cancels.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
                server.cancelled = true;
                return json({ cancelled: true });
            }

            if (url === '/api/sessions/s1' && method === undefined) {
                return json({
                    session: server.cancelled
                        ? snapshot({
                              status: 'idle',
                              turns: [turn({ prompt: 'task 1', status: 'cancelled' })]
                          })
                        : snapshot({ status: 'running', turns: [turn()] })
                });
            }

            if (url === '/api/sessions' && method === undefined) {
                return json({ sessions: [snapshot({ status: 'running', turns: [turn()] })] });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        })
    );

    return server;
};

const mount = async (): Promise<void> => {
    await import('./main');
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('paints the single in-field action for every state and never renders old controls', async () => {
    const server = stubServer();
    await mount();

    const composer = byClass('.composer', 'form');
    const field = byClass('.composer-field', 'div');
    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    // R9: ONE row by default (autoGrow owns the inline height from here on), with a
    // real accessible name rather than relying on the placeholder.
    expect(input.rows).toBe(1);
    expect(input.getAttribute('aria-label')).toBe('Task message');

    // R10: the action is a child of the field wrapper, which is the composer's only
    // content — no sibling action column, no Run/Stop/Reset trio.
    expect(input.parentElement).toBe(field);
    expect(action.parentElement).toBe(field);
    expect(composer.children).toHaveLength(1);
    expect(composer.querySelectorAll('button')).toHaveLength(1);
    expect(composer.querySelector('.run')).toBeNull();
    expect(composer.querySelector('.stop')).toBeNull();
    expect(composer.querySelector('.reset')).toBeNull();
    expect(composer.querySelector('.composer-actions')).toBeNull();

    // IDLE + EMPTY: nothing running, nothing typed -> no control at all.
    expect(action.hidden).toBe(true);
    expect(action.dataset.action).toBe('none');

    // WHITESPACE is empty: it must not paint submit, and a submit must not POST.
    input.value = '   \n\t ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.hidden).toBe(true);
    expect(action.dataset.action).toBe('none');
    composer.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(server.tasks).toBe(0);

    // TEXT + IDLE: submit icon, in the same spot, enabled.
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.hidden).toBe(false);
    expect(action.dataset.action).toBe('submit');
    expect(action.type).toBe('submit');
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe('▶');
    expect(action.getAttribute('aria-label')).toBe('Send task');
    expect(action.title).toBe('Send (Enter)');

    // Submit -> the field clears and the SAME control becomes STOP while pending.
    composer.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
    expect(action.hidden).toBe(false);
    expect(action.dataset.action).toBe('stop');
    expect(action.type).toBe('button');
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe('×');
    expect(action.getAttribute('aria-label')).toBe('Stop the running task');
    expect(action.title).toBe('Stop');
    // Still one button: the control changed meaning, not identity.
    expect(composer.querySelectorAll('button')).toHaveLength(1);

    // TEXT + RUNNING: text wins, so the same spot is an enabled submit (queueing).
    input.value = 'queued';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.dataset.action).toBe('submit');
    expect(action.disabled).toBe(false);
    expect(action.textContent).toBe('▶');

    // WHITESPACE + RUNNING is still empty: it must keep the stop X, not offer a
    // submit that run() would refuse.
    input.value = '   \n\t';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.dataset.action).toBe('stop');
    expect(action.textContent).toBe('×');

    // Clicking stop X cancels the whole queue and returns to "no control".
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.dataset.action).toBe('stop');
    action.click();
    await flush();
    await flush();

    expect(server.cancels).toEqual([{ all: true }]);
    expect(action.hidden).toBe(true);
    expect(action.dataset.action).toBe('none');
});

it('submits on Enter and click, keeps Shift+Enter a newline, and queues while running', async () => {
    const server = stubServer();
    await mount();

    const composer = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    // Enter (no shift) submits exactly like the old Run button.
    input.value = 'first';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(enter);
    await flush();
    await flush();

    expect(enter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
    expect(action.dataset.action).toBe('stop');

    // Shift+Enter is a newline: nothing is prevented and nothing is submitted.
    input.value = 'second line';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const shiftEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(shiftEnter);
    await flush();

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('second line');

    // The submit icon is live while the first task runs (R4): clicking it queues the
    // second task through the form's own submit path.
    expect(action.dataset.action).toBe('submit');
    expect(action.disabled).toBe(false);
    action.click();
    await flush();
    await flush();

    expect(server.tasks).toBe(2);
    expect(input.value).toBe('');
    // Empty + still pending: the action is the stop X again.
    expect(action.dataset.action).toBe('stop');
    expect(action.hidden).toBe(false);
});

it('grows with its content up to the cap and shrinks back to one row after sending', async () => {
    stubServer();
    await mount();

    const composer = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // jsdom has no layout: `scrollHeight` is the one metric the field reads, so the
    // test supplies it. The cap is the same declaration the stylesheet ships.
    let measured = 40;
    Object.defineProperty(input, 'scrollHeight', {
        configurable: true,
        get: () => measured
    });
    input.style.maxHeight = '200px';

    // No inline height before the first keystroke: the CSS one-row default applies.
    expect(input.style.height).toBe('');

    // One row -> three rows: the height follows the content exactly.
    input.value = 'one';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('40px');

    measured = 120;
    input.value = 'one\ntwo\nthree';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('120px');

    // Past the cap: it clamps and the stylesheet's overflow-y takes over.
    measured = 400;
    input.value = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('200px');

    // Sending clears the text and remeasures immediately (back to one row), so the
    // empty field never keeps the tall height of the submitted draft.
    measured = 40;
    composer.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(input.value).toBe('');
    expect(input.style.height).toBe('40px');
    await flush();
    await flush();
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
});
