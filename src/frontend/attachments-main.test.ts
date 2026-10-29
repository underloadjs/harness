// Composer attachment flow (T5 clip/attach) in the live shell.
//
// Pins the user-visible contract end to end:
//   - a pasted clipboard File inserts its typed marker at the captured caret while
//     normal text paste is untouched;
//   - multi-file reads keep clipboard order and per-kind numbering;
//   - an attachment-only (image-only) turn is submittable and the POST body carries
//     `{ input, attachments }` with raw base64;
//   - send is gated while a read is in flight;
//   - a rejected batch keeps the draft intact; a failed read removes only its own
//     marker/chip and reports why;
//   - a replayed turn renders filename/type chips (never base64 text) with no remove
//     control.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts attachments-main.test.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import type { HarnessAttachment } from '../types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

// Canonical base64 of a 12-byte PNG header: enough for the shared validator's
// magic-signature check and exactly what FileReader returns for the bytes below.
const PNG_BASE64 = 'iVBORw0KGgoAAAAA';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'todoManage'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
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

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: 'task',
        status: 'running',
        startedAt: T,
        updatedAt: T,
        events: [],
        ...overrides
    }) as SessionTurn;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    // Real FileReader callbacks land on a later macrotask; two rounds cover the
    // read plus the submit response.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
};

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents: [],
    ...overrides
});

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

type Call = { url: string; method: string | undefined; body: unknown };

// The server surface the page needs plus a recording of every /tasks body.
const stubServer = (restored?: SessionSnapshot, taskError?: string): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            if (url === '/api') return json(bootstrap(restored === undefined ? {} : { sessions: [restored] }));
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() }, 201);

            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                if (taskError !== undefined) return json({ error: { message: taskError } }, 500);

                const request = body as { input: string; attachments?: HarnessAttachment[] };
                const opening = turn({
                    prompt: request.input,
                    ...(request.attachments === undefined ? {} : { attachments: request.attachments })
                });
                return json(
                    { session: snapshot({ status: 'running', turns: [opening] }), turn: opening },
                    202
                );
            }

            if (url === '/api/sessions/s1/events') {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start() {
                            // Never emits: the POST answer owns the pending state.
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            if (url === '/api/sessions/s1' && method === undefined) {
                if (restored !== undefined) return json({ session: restored });
                return json({ session: snapshot({ status: 'running', turns: [turn()] }) });
            }

            if (url === '/api/sessions' && method === undefined) {
                if (restored !== undefined) return json({ sessions: [restored] });
                return json({ sessions: [] });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        })
    );

    return calls;
};

const mount = async (): Promise<void> => {
    await import('./main');
    await flush();
};

// Dispatch a real-looking clipboard paste. jsdom has no ClipboardEvent payload, so
// the DataTransfer shape the handler reads is defined directly on the event.
const pasteFiles = (input: HTMLTextAreaElement, files: File[]): Event => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
            files
        }
    });
    input.dispatchEvent(event);
    return event;
};

const submit = (): void => {
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

const taskBodies = (calls: Call[]): unknown[] =>
    calls.filter((call) => call.url === '/api/sessions/s1/tasks' && call.method === 'POST').map((call) => call.body);

const composerChips = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('.composer-input [data-chip="attachment"]')
];

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('inserts "[Image 1]" at the caret on paste and sends the bytes separately', async () => {
    const calls = stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'Check this image for me ';
    input.setSelectionRange(24, 24);

    const file = new File([PNG_BYTES], 'shot.png', { type: 'image/png' });
    const event = pasteFiles(input, [file]);

    // The marker appears synchronously at the captured caret (trailing space is
    // not doubled), and the chip is visible but still reading.
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('Check this image for me [Image 1]');
    expect(input.selectionStart).toBe(33);
    expect(composerChips().map((chip) => chip.dataset.kind)).toEqual(['image']);
    expect(composerChips()[0]?.dataset.state).toBe('reading');
    expect(composerChips()[0]?.dataset.attachmentName).toBe('shot.png');
    const action = byClass('.composer-action', 'button');
    expect(action.dataset.action).toBe('submit');
    expect(action.disabled).toBe(true);

    await flush();

    // Read finished: the chip is ready and submit is enabled.
    expect(composerChips()[0]?.dataset.state).toBeUndefined();
    expect(action.disabled).toBe(false);

    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        {
            input: 'Check this image for me [Image 1]',
            attachments: [
                {
                    id: 'attach-1',
                    kind: 'image',
                    marker: '[Image 1]',
                    name: 'shot.png',
                    mime: 'image/png',
                    size: 12,
                    data: PNG_BASE64
                }
            ]
        }
    ]);

    // Success consumes the draft: the field and the chip strip are empty again.
    expect(input.value).toBe('');
    expect(composerChips()).toEqual([]);
});

it('restores the prompt and keeps the chip when the send itself fails', async () => {
    stubServer(undefined, 'submit rejected');
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'send me ';
    input.setSelectionRange(8, 8);
    pasteFiles(input, [new File([PNG_BYTES], 'keep.png', { type: 'image/png' })]);
    await flush();

    submit();
    await flush();
    await flush();

    // The draft survives a rejected submit: text (with its marker) and the chip.
    expect(input.value).toBe('send me [Image 1]');
    expect(composerChips()).toHaveLength(1);
    expect(composerChips()[0]?.dataset.attachmentName).toBe('keep.png');
    expect(document.querySelector('.log .notice')?.textContent).toBe('task failed: submit rejected');
});

it('always prevents native paste and inserts nothing for an empty payload', async () => {
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'plain';
    const event = pasteFiles(input, []);

    // The native paste is always intercepted; with no text/plain there is simply
    // nothing to insert.
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('plain');
    expect(composerChips()).toEqual([]);
});

it('accepts the file-chooser alternative and the same gate', async () => {
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'choose ';
    input.setSelectionRange(7, 7);

    const fileInput = byClass('.composer-file', 'input');
    const file = new File([PNG_BYTES], 'chosen.png', { type: 'image/png' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    expect(input.value).toBe('choose [Image 1]');
    expect(composerChips()).toHaveLength(1);
    expect(byClass('.composer-attach', 'button').getAttribute('aria-label')).toBe('Attach files');

    await flush();
    expect(composerChips()[0]?.dataset.state).toBeUndefined();
});

it('accepts dropped files and prevents a text/empty drop natively', async () => {
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'drop ';

    const composer = byClass('.composer', 'form');
    const file = new File([PNG_BYTES], 'dropped.png', { type: 'image/png' });

    const textDrag = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(textDrag, 'dataTransfer', {
        value: { items: [{ kind: 'string', getAsFile: () => null }], files: [] }
    });
    composer.dispatchEvent(textDrag);
    // Every native drop is intercepted; a payload with no files/text inserts nothing.
    expect(textDrag.defaultPrevented).toBe(true);
    expect(input.value).toBe('drop ');

    const fileDrop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(fileDrop, 'dataTransfer', {
        value: { items: [{ kind: 'file', getAsFile: () => file }], files: [file] }
    });
    composer.dispatchEvent(fileDrop);

    expect(fileDrop.defaultPrevented).toBe(true);
    expect(input.value).toBe('drop [Image 1]');
    expect(composerChips()).toHaveLength(1);

    await flush();
});

it('sends an attachment-only turn with an empty prompt', async () => {
    const calls = stubServer();
    await mount();

    const input = byClass('.composer-input', 'div');
    pasteFiles(input, [new File([PNG_BYTES], 'shot.png', { type: 'image/png' })]);
    await flush();

    const action = byClass('.composer-action', 'button');
    expect(input.value).toBe('[Image 1]');
    expect(action.dataset.action).toBe('submit');
    expect(action.hidden).toBe(false);
    expect(action.disabled).toBe(false);

    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        {
            input: '[Image 1]',
            attachments: [
                {
                    id: 'attach-1',
                    kind: 'image',
                    marker: '[Image 1]',
                    name: 'shot.png',
                    mime: 'image/png',
                    size: 12,
                    data: PNG_BASE64
                }
            ]
        }
    ]);
});

it('blocks submit while a file is still being read', async () => {
    const calls = stubServer();
    await mount();

    const releases: Array<() => void> = [];

    // A controllable FileReader: the read does not complete until the test says so.
    class SlowFileReader {
        result: string | null = null;
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        readAsDataURL(file: File): void {
            releases.push(() => {
                this.result = `data:${file.type};base64,${PNG_BASE64}`;
                this.onload?.();
            });
        }
    }

    vi.stubGlobal('FileReader', SlowFileReader);

    const input = byClass('.composer-input', 'textarea');
    input.value = 'read me ';
    pasteFiles(input, [new File([PNG_BYTES], 'slow.png', { type: 'image/png' })]);

    const action = byClass('.composer-action', 'button');
    expect(action.disabled).toBe(true);
    expect(action.title).toBe('Reading the attached file…');

    submit();
    await flush();
    expect(taskBodies(calls)).toEqual([]);

    // Release the read: the same submit now leaves with the payload.
    releases[0]?.();
    await flush();
    expect(action.disabled).toBe(false);

    submit();
    await flush();
    expect(taskBodies(calls)).toHaveLength(1);
});

it('keeps the draft and reports a rejected batch before any read', async () => {
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'keep this ';
    const oversized = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });

    pasteFiles(input, [oversized]);

    // Atomic rejection: text untouched, no marker, no chip, actionable error.
    expect(input.value).toBe('keep this ');
    expect(composerChips()).toEqual([]);
    const error = byClass('.composer-attachment-error', 'p');
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('"big.png" is 4 MiB, above the 4 MiB per-file limit.');

    // A fifth file is rejected the same way once four are attached.
    const four = Array.from(
        { length: 4 },
        (_, index) => new File([PNG_BYTES], `f${index}.png`, { type: 'image/png' })
    );
    pasteFiles(input, four);
    await flush();
    expect(composerChips()).toHaveLength(4);

    input.setSelectionRange(input.value.length, input.value.length);
    pasteFiles(input, [new File([new Uint8Array([1])], 'fifth.png', { type: 'image/png' })]);
    expect(error.textContent).toBe('At most 4 files can be attached to one message (4 already attached).');
    expect(composerChips()).toHaveLength(4);
});

it('removes only the failed chip/marker when one read cannot be validated', async () => {
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    const good = new File([PNG_BYTES], 'good.png', { type: 'image/png' });
    // Declared PNG but carries no PNG signature: the shared validator rejects it.
    const bad = new File([new Uint8Array([0, 0, 0, 0])], 'bad.png', { type: 'image/png' });

    pasteFiles(input, [good, bad]);
    expect(input.value).toBe('[Image 1] [Image 2]');
    expect(composerChips()).toHaveLength(2);

    await flush();

    // Only the failed attachment is gone; the good one keeps its marker number.
    expect(composerChips().map((chip) => chip.dataset.kind)).toEqual(['image']);
    expect(composerChips()[0]?.dataset.chipLabel).toBe('[Image 1]');
    expect(input.value).toBe('[Image 1]');
    expect(byClass('.composer-attachment-error', 'p').textContent).toContain(
        'Could not attach "bad.png":'
    );
});

it('removes the associated first marker when a chip is removed', async () => {
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'one ';
    pasteFiles(input, [new File([PNG_BYTES], 'first.png', { type: 'image/png' })]);
    await flush();

    // Insert a second image after the first chip.
    input.setSelectionRange(input.value.length, input.value.length);
    pasteFiles(input, [new File([PNG_BYTES], 'second.png', { type: 'image/png' })]);
    await flush();

    expect(input.value).toBe('one [Image 1] [Image 2]');
    const firstChip = composerChips()[0];
    expect(firstChip?.dataset.chipLabel).toBe('[Image 1]');

    firstChip?.querySelector<HTMLButtonElement>('.composer-chip-remove')?.click();

    expect(input.value).toBe('one [Image 2]');
    expect(composerChips().map((chip) => chip.dataset.chipLabel)).toEqual([
        '[Image 2]'
    ]);

    // Counters are not reused: a new image continues at 3.
    input.setSelectionRange(input.value.length, input.value.length);
    pasteFiles(input, [new File([PNG_BYTES], 'third.png', { type: 'image/png' })]);
    await flush();
    expect(composerChips().map((chip) => chip.dataset.chipLabel)).toEqual([
        '[Image 2]',
        '[Image 3]'
    ]);
});

it('synchronizes the draft when an inline chip is deleted atomically', async () => {
    const calls = stubServer();
    await mount();

    const input = byClass('.composer-input', 'div');
    pasteFiles(input, [new File([PNG_BYTES], 'gone.png', { type: 'image/png' })]);
    await flush();

    expect(composerChips()).toHaveLength(1);
    expect(byClass('.composer-action', 'button').dataset.action).toBe('submit');

    // Backspace/Delete removes the chip inside the browser's editing machinery;
    // the observer must drop the draft bytes with it.
    composerChips()[0]?.remove();
    await flush();

    expect(input.value).toBe('');
    expect(composerChips()).toEqual([]);
    expect(byClass('.composer-action', 'button').hidden).toBe(true);
    expect(byClass('.composer-action', 'button').dataset.action).toBe('none');

    // A later text-only submit carries no stale attachment payload.
    input.value = 'text only';
    submit();
    await flush();
    expect(taskBodies(calls)).toEqual([{ input: 'text only' }]);
});

it('renders recorded attachments as filename/type chips, never as base64 text', async () => {
    const recorded: HarnessAttachment = {
        id: 'a1',
        kind: 'image',
        marker: '[Image 1]',
        name: 'holiday.png',
        mime: 'image/png',
        size: 12,
        data: PNG_BASE64
    };
    const restored = snapshot({
        turns: [
            turn({
                prompt: 'look at [Image 1]',
                status: 'done',
                // Attachments are read structurally by ui/turns.ts; the protocol
                // field is optional and absent for text-only turns.
                ...({ attachments: [recorded] } as Record<string, unknown>)
            })
        ]
    });

    localStorage.setItem(SESSION_KEY, 's1');
    stubServer(restored);
    await mount();

    const tile = byClass('.tile', 'article');
    const host = tile.querySelector<HTMLElement>('.turn-attachments');
    expect(host?.hidden).toBe(false);
    expect(host?.querySelectorAll('.attachment-chip')).toHaveLength(1);
    expect(host?.querySelector('.attachment-kind')?.textContent).toBe('Image');
    expect(host?.querySelector('.attachment-marker')?.textContent).toBe('[Image 1]');
    expect(host?.querySelector('.attachment-name')?.textContent).toBe('holiday.png');
    expect(host?.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${PNG_BASE64}`);
    // History is read-only: no remove affordance on a recorded turn.
    expect(host?.querySelector('.attachment-remove')).toBeNull();
    // The payload never becomes visible text.
    expect(document.body.textContent).not.toContain(PNG_BASE64);
});

it('shows no attachment strip for a text-only recorded turn', async () => {
    const restored = snapshot({
        turns: [turn({ prompt: 'just text', status: 'done' })]
    });

    localStorage.setItem(SESSION_KEY, 's1');
    stubServer(restored);
    await mount();

    const host = document.querySelector<HTMLElement>('.tile .turn-attachments');
    expect(host?.hidden).toBe(true);
    expect(host?.children).toHaveLength(0);
});

it('renders the ack record attachments once, without duplicating the strip', async () => {
    // The queue observer may deliver the same recorded turn before the POST answer;
    // chips must be idempotent across `merge` (one strip, not a second one).
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'see ';
    pasteFiles(input, [new File([PNG_BYTES], 'shot.png', { type: 'image/png' })]);
    await flush();

    expect(composerChips()).toHaveLength(1);
    submit();
    await flush();

    const hosts = document.querySelectorAll('.turn-attachments');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.querySelectorAll('.attachment-chip')).toHaveLength(1);
    expect(hosts[0]?.querySelector('.attachment-remove')).toBeNull();
    expect(hosts[0]?.querySelector('.attachment-name')?.textContent).toBe('shot.png');
});
