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
// outside the in-field action, and that Enter (native newline) / Ctrl+Cmd+Enter
// (send) / Shift+Alt+Enter (newline) / IME Enter (ignored) / clicking keep the
// exact submission semantics the old buttons had.
//
// T15/R6: the composer has NO attachment accessory. Clipboard paste, drag/drop and
// @ file lookup are the whole attachment surface, and the inline chips are pinned in
// attachments-main.test.ts / ui/attachments.test.ts. This file only proves the
// chooser button and its hidden input are gone from the rendered shell.
//
// The field's growth math is unit-tested in ui/composer.test.ts; here the textarea's
// `scrollHeight` is stubbed because jsdom has no layout.

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';
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

const bootstrap = (restored?: SessionSnapshot): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: restored === undefined ? [] : [restored],
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
// `taskError` makes the task POST fail (500) so the send-failure path is observable.
type Server = { tasks: number; cancels: unknown[]; cancelled: boolean };

const stubServer = (taskError?: string, restored?: SessionSnapshot): Server => {
    const server: Server = { tasks: 0, cancels: [], cancelled: false };

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;

            if (url === '/api') return json(bootstrap(restored));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() }, 201);

            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                server.tasks += 1;
                if (taskError !== undefined) return json({ error: { message: taskError } }, 500);

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
    const input = byClass('.composer-input', 'div');
    const action = byClass('.composer-action', 'button');

    // R9/R2/T5: ONE-row contentEditable field (autoGrow owns the inline height from
    // here on), with real textbox semantics and an accessible name rather than
    // relying on the placeholder. The compact UI deliberately carries NO placeholder:
    // it is not a label, it disappears on the first keystroke, and its keyboard hints
    // were guidance the composer does not need.
    expect(input.getAttribute('contenteditable')).toBe('true');
    expect(input.getAttribute('role')).toBe('textbox');
    expect(input.getAttribute('aria-multiline')).toBe('true');
    expect(input.getAttribute('aria-label')).toBe('Task message');
    expect(input.getAttribute('placeholder')).toBeNull();

    // R10/R11 (T5): the field wrapper is the INPUT FRAME. It holds the text column
    // and one control row (`agent`, stop-all, send) INSIDE the same border; the
    // composer body is the only text column and the composer's only child.
    expect(input.parentElement).toBe(field);
    expect(action.parentElement?.className).toBe('composer-controls');
    expect(field.parentElement?.className).toBe('composer-body');
    expect([...composer.children].map((child) => child.className)).toEqual(['composer-body']);
    expect(composer.querySelector('.composer-attach')).toBeNull();
    expect(composer.querySelector('.composer-file')).toBeNull();
    expect(composer.querySelector('input[type="file"]')).toBeNull();
    // R5/R7: the control row has exactly THREE controls — the agent button that
    // opens the shared dialog, the separate session-wide stop-all (hidden unless work
    // is pending while a draft exists) and the in-field send/stop. No chooser, and
    // no legacy Run/Stop/Reset controls.
    expect([...field.querySelectorAll('button')].map((button) => button.className)).toEqual([
        'agent-control-button',
        'composer-stop',
        'composer-action'
    ]);
    expect(byClass('.composer-stop', 'button').hidden).toBe(true);
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
    // R1: the title advertises the real shortcut — plain Enter is a newline now.
    expect(action.title).toBe('Send (Ctrl/Cmd+Enter)');

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
    // Still one ACTION: the control changed meaning, not identity (the attach
    // accessory is a separate button and is not part of this matrix).
    expect(composer.querySelectorAll('.composer-action')).toHaveLength(1);

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

it('sends only on Ctrl/Cmd+Enter and the button, keeping Enter, Shift+Alt+Enter and IME Enter native', async () => {
    const server = stubServer();
    await mount();

    const composer = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    // R1: a bare Enter is a NEWLINE. Nothing is prevented (the browser inserts the
    // line break) and nothing is POSTed; the typed text stays in the field.
    input.value = 'first line';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(enter);
    await flush();

    expect(enter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('first line');
    expect(action.dataset.action).toBe('submit');

    // Shift+Enter stays a newline: not prevented, not submitted.
    const shiftEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(shiftEnter);
    await flush();

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('first line');

    // Alt+Enter is a newline too: Alt is a content modifier, not a send modifier.
    const altEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(altEnter);
    await flush();

    expect(altEnter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('first line');

    // Ctrl+Enter is the explicit send shortcut: exactly one POST, field cleared, and
    // the same control turns into stop while the first task runs.
    const ctrlEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(ctrlEnter);
    await flush();
    await flush();

    expect(ctrlEnter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
    expect(action.dataset.action).toBe('stop');
    expect(action.hidden).toBe(false);

    // An IME confirmation Enter must do nothing: not prevented (the input method
    // owns the event) and not submitted, with the half-typed text preserved.
    input.value = 'ime text';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const imeEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(imeEnter);
    await flush();

    expect(imeEnter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('ime text');

    // Older engines only report the legacy composition marker (keyCode 229): the same
    // guard applies, so this Enter is ignored as well.
    const legacyImeEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
    });
    Object.defineProperty(legacyImeEnter, 'keyCode', { value: 229 });
    input.dispatchEvent(legacyImeEnter);
    await flush();

    expect(legacyImeEnter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('ime text');

    // Cmd+Enter (macOS) is the same shortcut: one more POST while the first runs, so
    // the task queues instead of replacing (R4).
    const metaEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(metaEnter);
    await flush();
    await flush();

    expect(metaEnter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(2);
    expect(input.value).toBe('');

    // The submit icon is live while tasks run (R4): clicking it queues another task
    // through the form's own submit path.
    input.value = 'third';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.dataset.action).toBe('submit');
    expect(action.disabled).toBe(false);
    action.click();
    await flush();
    await flush();

    expect(server.tasks).toBe(3);
    expect(input.value).toBe('');
    // Empty + still pending: the action is the stop X again.
    expect(action.dataset.action).toBe('stop');
    expect(action.hidden).toBe(false);
});

it('caps growth at 3 text lines on a phone and 5 on desktop, scrolling past the cap', async () => {
    stubServer();
    await mount();

    const composer = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // jsdom has no layout: `scrollHeight` is the one metric the field reads, so the
    // test supplies it. The cap math reads the same computed metrics a browser would,
    // so they are pinned inline here (the .composer-input box: 20px line, 10px top +
    // bottom padding, 1px border each side => 2px of vertical border).
    let measured = 40;
    Object.defineProperty(input, 'scrollHeight', {
        configurable: true,
        get: () => measured
    });
    input.style.lineHeight = '20px';
    input.style.fontSize = '13.5px';
    input.style.paddingTop = '10px';
    input.style.paddingBottom = '10px';
    input.style.borderTopWidth = '1px';
    input.style.borderBottomWidth = '1px';

    // No inline height before the first keystroke: the CSS one-row default applies.
    expect(window.innerWidth).toBe(1024);
    expect(input.style.height).toBe('');

    // One row -> three rows: the height follows the content exactly.
    input.value = 'one';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('42px');

    measured = 100;
    input.value = 'one\ntwo\nthree';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('102px');

    // Desktop cap (R5): 5 lines * 20px + 20px padding + 2px border = 122px.
    measured = 122;
    input.value = 'one\ntwo\nthree\nfour\nfive';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('122px');

    // Past the cap: it clamps and the stylesheet's overflow-y takes over.
    measured = 400;
    input.value = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('122px');

    // Phone (R5): the 860px breakpoint shrinks the budget to 3 lines => 3 * 20px +
    // 20px padding + 2px border = 82px, re-measured by the same resize listener the
    // browser fires when the viewport crosses the breakpoint.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    window.dispatchEvent(new Event('resize'));
    expect(input.style.height).toBe('82px');

    measured = 60;
    input.value = 'one\ntwo';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('62px');

    // Back to desktop: the cap widens again without a keystroke.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    window.dispatchEvent(new Event('resize'));
    expect(input.style.height).toBe('62px');

    measured = 400;
    input.value = 'one\ntwo\nthree\nfour\nfive\nsix';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(input.style.height).toBe('122px');

    // Sending clears the text and remeasures immediately (back to one row), so the
    // empty field never keeps the tall height of the submitted draft.
    measured = 40;
    composer.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(input.value).toBe('');
    expect(input.style.height).toBe('42px');
    await flush();
    await flush();
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
});

// --- R8/T15: the composer is never focused programmatically -------------------
//
// The field used to receive focus on boot, on New session, and in the send
// `finally` block. R8 makes the user the only one who can enter it: no lifecycle
// event may move focus into the composer, and a send must not pull it back from the
// control that invoked it. These tests pin `document.activeElement` exactly.

it('never autofocuses the composer on load, including a restored session', async () => {
    // A remembered session is restored during boot: the path that used to end with
    // `input.focus()` after opening the conversation.
    localStorage.setItem(SESSION_KEY, 's1');
    stubServer(undefined, snapshot({ status: 'running', turns: [turn()] }));
    await mount();

    const input = byClass('.composer-input', 'div');

    // Boot restored the session but left focus on the document: the composer
    // subtree contains no focused node.
    expect(document.activeElement).toBe(document.body);
    expect(input.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).not.toBe(input);

    // A user click is the only way in; once focused the editor is fully editable.
    input.focus();
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('contenteditable')).toBe('true');

    input.value = 'typed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(byClass('.composer-action', 'button').dataset.action).toBe('submit');
});

it('keeps focus where the user put it when a new session starts', async () => {
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'div');
    const newSession = byClass('.new-session', 'button');

    // The user is mid-draft in the field, then activates New session from the rail.
    input.focus();
    input.value = 'draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    newSession.focus();
    newSession.click();
    await flush();

    // The reset repaints the conversation but does not pull focus back into the
    // composer; the invoking control keeps it.
    expect(document.activeElement).toBe(newSession);
    expect(document.activeElement).not.toBe(input);
    // The draft is module-scoped, so it is still there and typing remains possible
    // only after the user chooses to return to the field.
    expect(input.value).toBe('draft');
    input.focus();
    expect(document.activeElement).toBe(input);
});

it('never refocuses the composer after a successful send', async () => {
    const server = stubServer();
    await mount();

    const input = byClass('.composer-input', 'div');
    const action = byClass('.composer-action', 'button');

    input.value = 'send me';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // The in-field send control is the invoking control: it owns focus when clicked.
    action.focus();
    action.click();
    await flush();
    await flush();

    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
    // R8: the send `finally` block no longer calls input.focus().
    expect(document.activeElement).toBe(action);
    expect(document.activeElement).not.toBe(input);
});

it('never refocuses the composer after a failed send', async () => {
    stubServer('submit rejected');
    await mount();

    const input = byClass('.composer-input', 'div');
    const action = byClass('.composer-action', 'button');

    input.value = 'keep this';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    action.focus();
    action.click();
    await flush();
    await flush();

    // The failed turn restores the draft but leaves focus on the invoking control.
    expect(input.value).toBe('keep this');
    expect(document.querySelector('.log .notice')?.textContent).toBe('task failed: submit rejected');
    expect(document.activeElement).toBe(action);
    expect(document.activeElement).not.toBe(input);
});
