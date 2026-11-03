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
// outside the in-field action, and that the keyboard matrix keeps the exact submission
// semantics the old buttons had. T1 splits the bare Enter by INPUT DEVICE, and T3
// claims the send half only on a POSITIVELY detected fine pointer:
//
//   (pointer: fine)                     -> Enter SENDS; Shift+Enter / Alt+Enter newline
//   (pointer: coarse)                   -> Enter is a native NEWLINE, send = button
//   (pointer: none) / no matchMedia      -> NEWLINE: an undetected device never sends
//   Ctrl/Cmd+Enter                      -> sends on every device (unchanged, R3)
//   IME Enter (isComposing / keyCode 229) -> ignored everywhere (unchanged)
//   Enter on a focused chip x           -> left to native button activation (T3/D1): the
//                                          field claims nothing, so no whole-draft send
// T15/R6: the composer has NO attachment accessory. Clipboard paste, drag/drop and
// @ file lookup are the whole attachment surface, and the inline chips are pinned in
// attachments-main.test.ts / ui/attachments.test.ts. This file only proves the
// chooser button and its hidden input are gone from the rendered shell.
//
// The field's growth math is unit-tested in ui/composer.test.ts; here the textarea's
// `scrollHeight` is stubbed because jsdom has no layout.

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

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
        coreTools: ['toolRequest', 'toolCreate', 'task', 'delegate'],
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
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        }))
    );

    return server;
};

// --- T1/T3: device stub -----------------------------------------------------------
//
// `main.ts` creates its MediaQueryLists ONCE at module scope, so the stub must be
// installed before `mount()` (and `vi.resetModules()` in beforeEach re-imports the
// module, so each test gets a fresh pair). Keying by query string keeps the two axes
// independent exactly like a browser evaluates them:
//   `(max-width: 860px)`  -> layout only (rails, line cap);
//   `(pointer: fine)`     -> the POSITIVE fine-pointer claim that gates Enter-to-send.
// T3 hardened the policy from "not coarse" to "positively fine", so ONE boolean covers
// every newline device: a phone (`coarse`), a keyboard-only / assistive setup (`none`)
// and an engine without `matchMedia` all report `fine: false`. Only `fine: true` may
// send. An unknown query throws, so a new media axis in main.ts must be pinned here
// instead of silently reading as a desktop default. `setFine` fires the change
// listeners, which is what a real device switch looks like to the page.
type MediaListener = (event: { matches: boolean }) => void;

type MediaStub = {
    matches: boolean;
    media: string;
    addEventListener: (type: string, listener: MediaListener) => void;
    removeEventListener: (type: string, listener: MediaListener) => void;
};

const stubMedia = (
    options: { fine?: boolean; phone?: boolean } = {}
): { setFine(next: boolean): void } => {
    const entries = new Map<string, { stub: MediaStub; listeners: Set<MediaListener> }>();

    const create = (media: string, matches: boolean): void => {
        const listeners = new Set<MediaListener>();
        const stub: MediaStub = {
            matches,
            media,
            addEventListener: (_type: string, listener: MediaListener): void => {
                listeners.add(listener);
            },
            removeEventListener: (_type: string, listener: MediaListener): void => {
                listeners.delete(listener);
            }
        };

        entries.set(media, { stub, listeners });
    };

    create('(pointer: fine)', options.fine ?? false);
    create('(max-width: 860px)', options.phone ?? false);

    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => {
            const entry = entries.get(query);
            if (entry === undefined) throw new Error(`unexpected media query: ${query}`);

            return entry.stub;
        })
    );

    return {
        setFine(next: boolean): void {
            const entry = entries.get('(pointer: fine)');
            if (entry === undefined) return;

            entry.stub.matches = next;
            for (const listener of [...entry.listeners]) listener({ matches: next });
        }
    };
};

// --- T3/D1: attachment-chip fixture ----------------------------------------------
//
// The only interactive control inside the contentEditable field is a chip's x remove
// button (ui/editor.ts:380-386), so these tests need a real chip rather than a synthetic
// one. A clipboard paste is the field's own entry point for that (the paste handler reads
// the `clipboardData` shape defined here, because jsdom has no ClipboardEvent payload).
// `ui/attachments.ts` skips the thumbnail when `URL.createObjectURL` is missing, which
// jsdom is, so no object-URL stub is needed for the chip to exist.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const pasteFiles = (field: HTMLElement, files: File[]): void => {
    const event = new Event('paste', { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'clipboardData', {
        value: {
            items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
            files
        }
    });

    field.dispatchEvent(event);
};

const composerChips = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('.composer-input [data-chip="attachment"]')
];

// One text node + one READY attachment chip: "keep me [Image 1]". Two flush rounds let
// the real FileReader finish, so a later "nothing was sent" assertion cannot pass merely
// because an in-flight read blocked `run()`.
const pasteDraft = async (field: HTMLTextAreaElement): Promise<void> => {
    field.value = 'keep me ';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    pasteFiles(field, [new File([PNG_BYTES], 'shot.png', { type: 'image/png' })]);
    await flush();
    await flush();
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
    // A hardware keyboard: the send hint must name the real shortcut (T1/R2).
    stubMedia({ fine: true });
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
    // T1/R2: on a hardware-keyboard device the title advertises the real shortcut —
    // a bare Enter sends.
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

// --- T1: the Enter policy follows the INPUT DEVICE, not the viewport -----------
//
// Each test pins ONE device. `defaultPrevented` is what separates the two halves of
// the matrix: the harness prevents the default ONLY when it sends, so
//   `defaultPrevented === false` -> the browser owns the keystroke, i.e. a native
//                                    newline. jsdom has no editing engine, so the line
//                                    break itself cannot be observed here — the
//                                    un-prevented event is the whole proof;
//   `defaultPrevented === true`  -> the harness took the keystroke and sent.
// `server.tasks` counts POST /sessions/:id/tasks, i.e. "did it really send".
//
// The device axis is the positive `(pointer: fine)` claim; the `(max-width: 860px)`
// layout query is stubbed independently to prove the two never leak into each other.

it('sends on a bare Enter with a hardware keyboard, keeping Shift+Enter and Alt+Enter as newlines', async () => {
    const server = stubServer();
    // A positively fine primary pointer: the desktop case, whatever the width is.
    stubMedia({ fine: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    // R2: the hint names the shortcut this device actually has.
    expect(action.title).toBe('Send (Enter)');

    input.value = 'first line';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // R2: a bare Enter SENDS — the default is taken from the browser (no stray line
    // break), exactly one task is POSTed, and the field clears.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();
    await flush();

    expect(enter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
    expect(action.dataset.action).toBe('stop');

    // R2: Shift+Enter is the explicit "give me a line break". Not prevented (the
    // browser inserts it), nothing POSTed, and the draft is untouched.
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
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('second line');

    // R3: Ctrl+Shift+Enter keeps its old meaning (content modifier wins over the send
    // modifier), so it is still a newline.
    const ctrlShiftEnter = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(ctrlShiftEnter);
    await flush();

    expect(ctrlShiftEnter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('second line');

    // R3: the explicit Ctrl+Enter shortcut is unchanged on this device.
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
    expect(server.tasks).toBe(2);
    expect(input.value).toBe('');

    // Cmd+Enter (macOS) is the same shortcut; while the first task still runs it
    // queues rather than replacing (R4).
    input.value = 'third';
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    expect(server.tasks).toBe(3);
    expect(input.value).toBe('');
});

it('keeps every existing send guard on the Enter path, so an unsendable draft is refused', async () => {
    const server = stubServer();
    stubMedia({ fine: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    // Whitespace-only draft: `run()` trims it and refuses, so the Enter that the
    // hardware-keyboard policy claims must NOT create a task. The default is still
    // prevented — the keystroke belongs to the send, so no blank line is inserted.
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.dataset.action).toBe('none');

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();
    await flush();

    expect(enter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('   ');
});

it('never sends while the suggestion list owns Enter, even with a hardware keyboard', async () => {
    const server = stubServer();
    stubMedia({ fine: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const popup = byClass('.composer-popup', 'div');

    // A `#` trigger with nothing referenceable: the popup is open (and says why) but
    // there is no row to pick. R3 leaves that keystroke with the popup, so the T1 send
    // cannot fire in the middle of a mention.
    input.value = 'ask #';
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(popup.hidden).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();

    expect(enter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('ask #');

    // R3: Ctrl/Cmd+Enter still overrides the open popup — the explicit shortcut is the
    // reader saying "send anyway", on every device.
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
});

it('ignores an IME Enter on a hardware keyboard, ahead of the Enter-to-send policy', async () => {
    const server = stubServer();
    stubMedia({ fine: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');

    input.value = 'ime text';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // R3: the composition guard runs first, so the candidate-confirming Enter neither
    // submits nor is prevented — the input method still owns the event. This is the
    // regression that matters most now that a bare Enter can send.
    const composing = new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(composing);
    await flush();

    expect(composing.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('ime text');

    // Older engines only report the legacy marker (keyCode 229): same outcome.
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    input.dispatchEvent(legacy);
    await flush();

    expect(legacy.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('ime text');

    // A composing Ctrl/Cmd+Enter is still composition, not the shortcut.
    const composingShortcut = new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true
    });
    input.dispatchEvent(composingShortcut);
    await flush();

    expect(composingShortcut.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('ime text');
});

it('keeps Enter a newline on a touch keyboard and sends through the button or Ctrl+Enter', async () => {
    const server = stubServer();
    // No fine pointer (a coarse one): the phone/tablet case (R1).
    stubMedia({ fine: false });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    // R1: there is no Enter shortcut to advertise here, so the hint names the button
    // only; the accessible name is unchanged.
    expect(action.title).toBe('Send');

    input.value = 'first line';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // R1: a bare Enter is a NEWLINE — not prevented, nothing POSTed, text still there,
    // and the send control is still offered.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();

    expect(enter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('first line');
    expect(action.dataset.action).toBe('submit');

    // Shift+Enter is a newline here as well.
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

    // R1: the explicit Send button is the touch send path — one POST, field cleared.
    expect(action.getAttribute('aria-label')).toBe('Send task');
    expect(action.disabled).toBe(false);
    action.click();
    await flush();
    await flush();

    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
    expect(action.dataset.action).toBe('stop');

    // R3: Ctrl+Enter remains the keyboard send on a touch device too (it queues).
    input.value = 'queued';
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    expect(server.tasks).toBe(2);
    expect(input.value).toBe('');
});

it('sends on Enter in a phone-width desktop window, because width is not the input device', async () => {
    const server = stubServer();
    // The 860px LAYOUT query matches (a shrunk desktop window) while the primary
    // pointer is still fine, so the composer must keep Enter-to-send.
    stubMedia({ fine: true, phone: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    expect(input.value).toBe('');
    expect(action.title).toBe('Send (Enter)');

    input.value = 'narrow desktop';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();
    await flush();

    expect(enter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
});

it('keeps Enter a newline on a wide touch device, because width is not the input device', async () => {
    const server = stubServer();
    // The 860px LAYOUT query does not match (a tablet in landscape) while no fine
    // pointer is reported, so Enter must stay a newline.
    stubMedia({ fine: false, phone: false });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    expect(action.title).toBe('Send');

    input.value = 'wide tablet';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();

    expect(enter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('wide tablet');
});

it('falls back to the newline policy when the environment cannot report a pointer type', async () => {
    const server = stubServer();
    // No `stubMedia` call: jsdom has no `matchMedia`, so the pointer type is UNKNOWN
    // (same for engines old enough to lack it). Sending is the irreversible half of the
    // matrix, so an unknown device keeps the pre-T1 newline contract and advertises no
    // Enter shortcut.
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    expect(action.title).toBe('Send');

    input.value = 'unknown device';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();

    expect(enter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('unknown device');
});

it('follows a mid-session input-device change in both the hint and the Enter policy', async () => {
    const server = stubServer();
    const media = stubMedia({ fine: false });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    // Touch device, draft ready: Enter is a newline and the hint says nothing about it.
    input.value = 'draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(action.title).toBe('Send');

    const touchEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(touchEnter);
    await flush();

    expect(touchEnter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);

    // A hardware keyboard is attached: the repaint fires from the same change event a
    // browser dispatches, so the hint and the keystroke policy move together.
    media.setFine(true);
    expect(action.title).toBe('Send (Enter)');

    const desktopEnter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(desktopEnter);
    await flush();
    await flush();

    expect(desktopEnter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
});

// --- T3/D1: a focused chip x owns its own Enter -----------------------------------
//
// The x button lives INSIDE the field, so its keydown bubbles through the field's
// listener. Before T3 the T1 desktop policy claimed that bubbled Enter: it prevented the
// default (killing the browser's button activation) and sent the WHOLE draft, so a
// keyboard reader trying to drop one chip instead posted a task and lost nothing.

it('leaves a bare Enter on a focused chip remove button to the button instead of sending', async () => {
    const server = stubServer();
    stubMedia({ fine: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const action = byClass('.composer-action', 'button');

    await pasteDraft(input);

    // Precondition, so the zero-request assertion below is meaningful: the draft is text
    // PLUS one READY chip, the send control is enabled (the attachment read finished, so
    // `run()` is not merely blocked), and a plain Enter in the FIELD does send here.
    expect(input.value).toBe('keep me [Image 1]');
    expect(action.dataset.action).toBe('submit');
    expect(action.disabled).toBe(false);

    const chips = composerChips();
    expect(chips).toHaveLength(1);

    const remove = chips[0]?.querySelector<HTMLButtonElement>('.composer-chip-remove');
    if (remove === undefined) throw new Error('missing .composer-chip-remove');

    remove.focus();
    expect(document.activeElement).toBe(remove);

    // D1: the keystroke belongs to the focused <button>, so it is neither prevented (the
    // browser activates it and removes exactly that chip) nor turned into a send.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    remove.dispatchEvent(enter);
    await flush();
    await flush();

    expect(enter.defaultPrevented).toBe(false);
    expect(server.tasks).toBe(0);
    expect(input.value).toBe('keep me [Image 1]');
    expect(composerChips()).toHaveLength(1);
});

it('leaves every modified Enter on a focused chip remove button alone as well', async () => {
    const server = stubServer();
    stubMedia({ fine: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    await pasteDraft(input);
    expect(composerChips()).toHaveLength(1);

    const remove = composerChips()[0]?.querySelector<HTMLButtonElement>('.composer-chip-remove');
    if (remove === undefined) throw new Error('missing .composer-chip-remove');

    remove.focus();

    // Conservative ownership: Ctrl/Cmd still send from the FIELD, but while the chip's x
    // has focus every Enter variant is the button's, so no modifier combination can post
    // an unintended task on the reader's way to removing a chip.
    for (const modifiers of [
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true },
        { altKey: true }
    ]) {
        const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            ...modifiers,
            bubbles: true,
            cancelable: true
        });

        remove.dispatchEvent(event);
        await flush();

        expect(event.defaultPrevented).toBe(false);
        expect(server.tasks).toBe(0);
    }

    expect(input.value).toBe('keep me [Image 1]');
    expect(composerChips()).toHaveLength(1);
});

it('keeps the chip remove click path and the field Enter send independent of that guard', async () => {
    const server = stubServer();
    stubMedia({ fine: true });
    await mount();

    const input = byClass('.composer-input', 'textarea');
    await pasteDraft(input);

    const remove = composerChips()[0]?.querySelector<HTMLButtonElement>('.composer-chip-remove');
    if (remove === undefined) throw new Error('missing .composer-chip-remove');

    // The affordance the Enter guard defers to: activating the button removes exactly that
    // chip, drops its marker text, and makes no request of its own.
    remove.click();
    await flush();

    // The marker AND the spacing the paste inserted around it go together
    // (ui/attachments.ts removes the padding it added), so the draft text is back to the
    // typed words without the trailing space.
    expect(composerChips()).toHaveLength(0);
    expect(input.value).toBe('keep me');
    expect(server.tasks).toBe(0);

    // With the chip gone, the SAME Enter in the field does send: proof that the guard
    // above declined a keystroke which would otherwise have produced a task.
    input.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await flush();
    await flush();

    expect(enter.defaultPrevented).toBe(true);
    expect(server.tasks).toBe(1);
    expect(input.value).toBe('');
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
