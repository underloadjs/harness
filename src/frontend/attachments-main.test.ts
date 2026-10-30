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
//   - a replayed turn renders the marker as an INLINE filename/type chip in the
//     prompt (never base64 text, no duplicate chip row, no remove control), and
//     clicking it opens the shared preview dialog.
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

// A server whose FIRST POST /tasks stays open until the test releases it, so the
// short enqueue freeze (`submitting`) is observable deterministically. Later task
// POSTs answer immediately so a retry / next message can be asserted.
const gatedServer = (): { calls: Call[]; release: (response: Response) => void } => {
    const calls: Call[] = [];
    const state: { gated: boolean; release?: (response: Response) => void } = { gated: false };

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() }, 201);

            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                const request = body as { input: string; attachments?: HarnessAttachment[] };
                const opening = turn({
                    prompt: request.input,
                    ...(request.attachments === undefined ? {} : { attachments: request.attachments })
                });
                const answer = (): Response =>
                    json({ session: snapshot({ status: 'running', turns: [opening] }), turn: opening }, 202);

                if (!state.gated) {
                    state.gated = true;
                    return new Promise<Response>((resolve) => {
                        state.release = resolve;
                    });
                }

                return answer();
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
                return json({ session: snapshot({ status: 'running', turns: [turn()] }) });
            }

            if (url === '/api/sessions' && method === undefined) return json({ sessions: [] });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        })
    );

    return {
        calls,
        release: (response) => state.release?.(response)
    };
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

// Chromium hands out a FRESH File object from `getAsFile()` and from `files` for
// the SAME clipboard entry. The old helper above reuses one object on both sides,
// which hid the duplicate; these helpers use two distinct objects with identical
// facts (name/MIME/size/lastModified), exactly like a real browser clipboard.
const CLIPBOARD_STAMP = 1_700_000_000_000;

const clipboardFile = (name: string, type: string): File =>
    new File([PNG_BYTES], name, { type, lastModified: CLIPBOARD_STAMP });

const pasteClipboard = (input: HTMLElement, items: File[], files: File[]): Event => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            items: items.map((file) => ({ kind: 'file', getAsFile: () => file })),
            files
        }
    });
    input.dispatchEvent(event);
    return event;
};

const pressDelete = (input: HTMLElement, key: 'Backspace' | 'Delete'): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event;
};

// The composer field is a contentEditable <div>; ui/editor.ts installs the
// textarea-compatible accessors (`value`, `selectionStart/End`,
// `setSelectionRange`) this contract is written against.
type ComposerField = HTMLDivElement & {
    value: string;
    selectionStart: number;
    selectionEnd: number;
    setSelectionRange: (start: number, end?: number) => void;
};

const composerField = (): ComposerField => {
    const element = byClass('.composer-input', 'div') as ComposerField;
    return element;
};

// The preview object URL is created from a `File`, so the test owns both halves of
// the lifecycle. Originals are restored in afterEach.
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const stubObjectUrls = (): string[] => {
    const revoked: string[] = [];
    let created = 0;

    URL.createObjectURL = () => {
        created += 1;
        return `blob:preview-${created}`;
    };
    URL.revokeObjectURL = (url: string) => {
        revoked.push(url);
    };

    return revoked;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // `URL.createObjectURL` does not exist in jsdom by default: delete whatever is
    // left rather than restoring a method that was never there.
    if (originalCreateObjectURL === undefined) Reflect.deleteProperty(URL, 'createObjectURL');
    else URL.createObjectURL = originalCreateObjectURL;
    if (originalRevokeObjectURL === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL');
    else URL.revokeObjectURL = originalRevokeObjectURL;
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

it('renders no attachment chooser and still attaches through paste and drop', async () => {
    stubServer();
    await mount();

    // R6/T15: the "+" chooser button and its hidden file input are removed from the
    // DOM (not merely hidden), so nothing in the composer promises a file picker.
    expect(document.querySelector('.composer-attach')).toBeNull();
    expect(document.querySelector('.composer-file')).toBeNull();
    expect(document.querySelector('.composer input[type="file"]')).toBeNull();
    // The composer is one field column: no accessory beside it and no dead tab stop.
    expect(byClass('.composer', 'form').children).toHaveLength(1);

    // Paste remains the primary attachment path: the chip lands at the caret.
    const input = composerField();
    input.value = 'paste ';
    input.setSelectionRange(6, 6);
    pasteClipboard(
        input,
        [clipboardFile('pasted.png', 'image/png')],
        [clipboardFile('pasted.png', 'image/png')]
    );
    await flush();
    expect(input.value).toBe('paste [Image 1]');

    // Drop still attaches its files at the stored caret, now with no chooser beside it.
    const composer = byClass('.composer', 'form');
    const dropped = clipboardFile('dropped.png', 'image/png');
    const fileDrop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(fileDrop, 'dataTransfer', {
        value: { items: [{ kind: 'file', getAsFile: () => dropped }], files: [dropped] }
    });
    composer.dispatchEvent(fileDrop);
    await flush();

    expect(fileDrop.defaultPrevented).toBe(true);
    expect(input.value).toBe('paste [Image 1] [Image 2]');
    expect(composerChips().map((chip) => chip.dataset.attachmentName)).toEqual([
        'pasted.png',
        'dropped.png'
    ]);
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

    const input = composerField();
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

    const input = composerField();
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

it('renders recorded attachments as inline filename/type chips, never as base64 text', async () => {
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
    // R10: the marker itself is the chip, in the prompt flow. There is no
    // separate attachment strip and therefore no duplicate rendering.
    expect(tile.querySelector('.turn-attachments')).toBeNull();
    const chips = [...tile.querySelectorAll<HTMLButtonElement>('.turn-prompt .attachment-inline')];
    expect(chips).toHaveLength(1);
    expect(chips[0]?.dataset.kind).toBe('image');
    expect(chips[0]?.dataset.marker).toBe('[Image 1]');
    expect(chips[0]?.querySelector('.attachment-kind')?.textContent).toBe('Image');
    expect(chips[0]?.querySelector('.attachment-marker')?.textContent).toBe('[Image 1]');
    expect(chips[0]?.querySelector('.attachment-name')?.textContent).toBe('holiday.png');
    expect(chips[0]?.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${PNG_BASE64}`);
    // History is read-only: no remove affordance on a recorded turn.
    expect(tile.querySelector('.attachment-remove')).toBeNull();
    // The surrounding prose is preserved around the chip.
    expect(tile.querySelector('.turn-prompt')?.textContent).toBe('look at Image[Image 1]holiday.png\n');
    // The payload never becomes visible text.
    expect(document.body.textContent).not.toContain(PNG_BASE64);

    // Clicking the inline chip opens the reusable dialog with the fitted image.
    chips[0]?.click();
    const dialog = byClass('.dialog', 'div');
    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('holiday.png');
    const image = dialog.querySelector<HTMLImageElement>('.preview-image img');
    expect(image?.src).toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(image?.alt).toBe('holiday.png');
    expect(dialog.textContent).not.toContain(PNG_BASE64);
});

it('shows no attachment chip or strip for a text-only recorded turn', async () => {
    const restored = snapshot({
        turns: [turn({ prompt: 'just text', status: 'done' })]
    });

    localStorage.setItem(SESSION_KEY, 's1');
    stubServer(restored);
    await mount();

    expect(document.querySelector('.tile .turn-attachments')).toBeNull();
    expect(document.querySelector('.tile .attachment-inline')).toBeNull();
});

it('renders the ack record attachments once, in the prompt', async () => {
    // The queue observer may deliver the same recorded turn before the POST answer;
    // chips must be idempotent across `merge` (one inline chip, no second row).
    stubServer();
    await mount();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'see ';
    pasteFiles(input, [new File([PNG_BYTES], 'shot.png', { type: 'image/png' })]);
    await flush();

    expect(composerChips()).toHaveLength(1);
    submit();
    await flush();

    expect(document.querySelectorAll('.turn-attachments')).toHaveLength(0);
    const chips = [...document.querySelectorAll<HTMLElement>('.tile .turn-prompt .attachment-inline')];
    expect(chips).toHaveLength(1);
    expect(chips[0]?.querySelector('.attachment-remove')).toBeNull();
    expect(chips[0]?.querySelector('.attachment-name')?.textContent).toBe('shot.png');
});

// --- R4/R5: one image = one chip, and Backspace/Delete are atomic ------------
//
// The mock helper above reuses one File object on both clipboard paths, which is
// what a browser does NOT do; the realistic payload has two distinct objects for
// one clipboard entry (see `pasteClipboard`).

it('attaches a real browser clipboard image exactly once', async () => {
    const calls = stubServer();
    await mount();

    const input = composerField();
    const event = pasteClipboard(
        input,
        [clipboardFile('image.png', 'image/png')],
        [clipboardFile('image.png', 'image/png')]
    );

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('[Image 1]');
    expect(composerChips()).toHaveLength(1);
    expect(composerChips()[0]?.dataset.chipLabel).toBe('[Image 1]');

    await flush();
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
                    name: 'image.png',
                    mime: 'image/png',
                    size: 12,
                    data: PNG_BASE64
                }
            ]
        }
    ]);
});

it('keeps distinct files while deduping the repeated clipboard representation', async () => {
    stubServer();
    await mount();

    const input = composerField();
    pasteClipboard(
        input,
        [clipboardFile('one.png', 'image/png'), clipboardFile('two.png', 'image/png')],
        [
            clipboardFile('one.png', 'image/png'),
            clipboardFile('two.png', 'image/png'),
            clipboardFile('notes.txt', 'text/plain')
        ]
    );

    // Clipboard order: the two item entries, then the files-only attachment.
    expect(input.value).toBe('[Image 1] [Image 2] [File 1]');
    expect(composerChips().map((chip) => chip.dataset.attachmentName)).toEqual([
        'one.png',
        'two.png',
        'notes.txt'
    ]);

    await flush();
});

it('removes a chip with Backspace, including its preview URL and payload', async () => {
    const calls = stubServer();
    const revoked = stubObjectUrls();
    await mount();

    const input = composerField();
    pasteClipboard(
        input,
        [clipboardFile('image.png', 'image/png')],
        [clipboardFile('image.png', 'image/png')]
    );
    await flush();

    expect(composerChips()).toHaveLength(1);
    expect(composerChips()[0]?.querySelector('img')?.getAttribute('src')).toBe('blob:preview-1');

    // Caret sits after the freshly inserted chip: Backspace must remove the token
    // atomically instead of deleting a neighbouring text character.
    const event = pressDelete(input, 'Backspace');
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(composerChips()).toEqual([]);
    expect(revoked).toEqual(['blob:preview-1']);
    expect(byClass('.composer-action', 'button').hidden).toBe(true);

    // No stale bytes can leave with a later text-only submit.
    input.value = 'text only';
    submit();
    await flush();
    expect(taskBodies(calls)).toEqual([{ input: 'text only' }]);
});

it('removes a chip covered by a selection on one keystroke', async () => {
    stubServer();
    await mount();

    const input = composerField();
    input.value = 'a b';
    input.setSelectionRange(2, 2);
    pasteClipboard(
        input,
        [clipboardFile('image.png', 'image/png')],
        [clipboardFile('image.png', 'image/png')]
    );
    await flush();
    expect(input.value).toBe('a [Image 1] b');

    // Select exactly the chip, then delete the selection.
    input.setSelectionRange(2, 11);
    const event = pressDelete(input, 'Backspace');

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('a b');
    expect(composerChips()).toEqual([]);
});

it('never resurrects a chip deleted while its read is still in flight', async () => {
    stubServer();
    await mount();

    const releases: Array<() => void> = [];

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

    const input = composerField();
    pasteClipboard(
        input,
        [clipboardFile('slow.png', 'image/png')],
        [clipboardFile('slow.png', 'image/png')]
    );

    expect(composerChips()).toHaveLength(1);
    expect(composerChips()[0]?.dataset.state).toBe('reading');

    // Deleted while reading: the late read completion must not repaint a chip.
    expect(pressDelete(input, 'Backspace').defaultPrevented).toBe(true);
    expect(composerChips()).toEqual([]);

    releases[0]?.();
    await flush();

    expect(composerChips()).toEqual([]);
    expect(input.value).toBe('');
    expect(byClass('.composer-action', 'button').hidden).toBe(true);
    expect(byClass('.composer-attachment-error', 'p').hidden).toBe(true);
});

it('treats two separate pastes of the same image as two attachments', async () => {
    stubServer();
    await mount();

    const input = composerField();
    pasteClipboard(
        input,
        [clipboardFile('image.png', 'image/png')],
        [clipboardFile('image.png', 'image/png')]
    );
    pasteClipboard(
        input,
        [clipboardFile('image.png', 'image/png')],
        [clipboardFile('image.png', 'image/png')]
    );

    expect(input.value).toBe('[Image 1] [Image 2]');
    expect(composerChips().map((chip) => chip.dataset.chipLabel)).toEqual([
        '[Image 1]',
        '[Image 2]'
    ]);

    await flush();
});

// --- freeze-window reconciliation (T14) -------------------------------------
//
// While a submit owns the enqueue window (`submitting`), paste/drop are still
// intercepted and the keydown chip delete / chip observer both skip that state.
// Anything that could still add or lose a draft entry in that window must therefore
// be closed here: no new chip may appear, and a failed turn may not leave bytes whose
// marker is not in the prompt. (The chooser that used to be disabled here is gone
// entirely - R6/T15.)

it('ignores paste and drop during the submit freeze', async () => {
    const { calls, release } = gatedServer();
    await mount();

    const input = composerField();
    input.value = 'first';
    pasteClipboard(
        input,
        [clipboardFile('one.png', 'image/png')],
        [clipboardFile('one.png', 'image/png')]
    );
    await flush();
    expect(composerChips()).toHaveLength(1);

    submit();
    await flush();
    // Freeze window open: the field was cleared and the POST is still in flight.
    expect(input.value).toBe('');
    expect(composerChips()).toEqual([]);

    // Paste: still intercepted (the native paste must never run), but discarded.
    const paste = pasteClipboard(
        input,
        [clipboardFile('two.png', 'image/png')],
        [clipboardFile('two.png', 'image/png')]
    );
    expect(paste.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(composerChips()).toEqual([]);

    // Drop: same contract on the composer.
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
        value: {
            items: [{ kind: 'file', getAsFile: () => clipboardFile('three.png', 'image/png') }],
            files: [clipboardFile('three.png', 'image/png')]
        }
    });
    byClass('.composer', 'form').dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
    expect(composerChips()).toEqual([]);

    // Let the enqueue settle: only the sent draft existed, so the next text-only
    // submit must carry no attachment at all.
    release(json({ session: snapshot({ status: 'running' }), turn: turn() }, 202));
    await flush();
    await flush();

    input.value = 'text only';
    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        {
            input: 'first [Image 1]',
            attachments: [
                {
                    id: 'attach-1',
                    kind: 'image',
                    marker: '[Image 1]',
                    name: 'one.png',
                    mime: 'image/png',
                    size: 12,
                    data: PNG_BASE64
                }
            ]
        },
        { input: 'text only' }
    ]);
});

it('drops the failed turn bytes when the reader typed the next message', async () => {
    const { calls, release } = gatedServer();
    const revoked = stubObjectUrls();
    await mount();

    const input = composerField();
    input.value = 'keep this prompt';
    pasteClipboard(
        input,
        [clipboardFile('one.png', 'image/png')],
        [clipboardFile('one.png', 'image/png')]
    );
    await flush();
    expect(composerChips()).toHaveLength(1);

    submit();
    await flush();
    expect(input.value).toBe('');

    // The reader starts the next message while the enqueue is still in flight.
    input.value = 'next message';

    release(json({ error: { message: 'submit rejected' } }, 500));
    await flush();
    await flush();

    // The typed message survives (the failed snapshot is NOT restored over it), and
    // the failed turn's bytes/object URL are gone with its chips.
    expect(input.value).toBe('next message');
    expect(composerChips()).toEqual([]);
    expect(revoked).toEqual(['blob:preview-1']);

    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        {
            input: 'keep this prompt [Image 1]',
            attachments: [
                {
                    id: 'attach-1',
                    kind: 'image',
                    marker: '[Image 1]',
                    name: 'one.png',
                    mime: 'image/png',
                    size: 12,
                    data: PNG_BASE64
                }
            ]
        },
        { input: 'next message' }
    ]);
});

it('restores an attachment-only draft when the send itself fails', async () => {
    const calls = stubServer(undefined, 'submit rejected');
    await mount();

    const input = composerField();
    pasteClipboard(
        input,
        [clipboardFile('only.png', 'image/png')],
        [clipboardFile('only.png', 'image/png')]
    );
    await flush();
    expect(input.value).toBe('[Image 1]');

    submit();
    await flush();
    await flush();

    // Empty prompt + cleared field: the snapshot (chip + marker) comes back rather
    // than leaving the bytes stranded without a marker.
    expect(input.value).toBe('[Image 1]');
    expect(composerChips()).toHaveLength(1);
    expect(composerChips()[0]?.dataset.attachmentName).toBe('only.png');

    // A retry therefore sends the same single attachment, still one record.
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
                    name: 'only.png',
                    mime: 'image/png',
                    size: 12,
                    data: PNG_BASE64
                }
            ]
        },
        {
            input: '[Image 1]',
            attachments: [
                {
                    id: 'attach-1',
                    kind: 'image',
                    marker: '[Image 1]',
                    name: 'only.png',
                    mime: 'image/png',
                    size: 12,
                    data: PNG_BASE64
                }
            ]
        }
    ]);
});

it('sends the restorable failed draft with its attachment marker exactly once', async () => {
    const calls = stubServer(undefined, 'submit rejected');
    await mount();

    const input = composerField();
    input.value = 'send me ';
    input.setSelectionRange(8, 8);
    pasteClipboard(
        input,
        [clipboardFile('keep.png', 'image/png')],
        [clipboardFile('keep.png', 'image/png')]
    );
    await flush();

    submit();
    await flush();
    await flush();
    expect(input.value).toBe('send me [Image 1]');
    expect(composerChips()).toHaveLength(1);

    // The restored draft keeps the same draft entry, so the retry payload is the
    // identical single record (no duplicate from the failed attempt).
    submit();
    await flush();

    const expected = {
        input: 'send me [Image 1]',
        attachments: [
            {
                id: 'attach-1',
                kind: 'image',
                marker: '[Image 1]',
                name: 'keep.png',
                mime: 'image/png',
                size: 12,
                data: PNG_BASE64
            }
        ]
    };
    expect(taskBodies(calls)).toEqual([expected, expected]);
});
