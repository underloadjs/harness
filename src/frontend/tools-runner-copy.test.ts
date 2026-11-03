// R8 — the playground runner copies EACH pane, and sends exactly what the box holds.
//
// The dialog header used to carry one Copy button that guessed which pane the reader
// meant. It is gone: the payload and the response are separate sections, each with its
// own label and its own copy control beside it, and each writes ITS OWN text verbatim.
// "Call tool" parses the edited textarea (never the preset object) and the response box
// renders the server's answer as JSON, so a failure is JSON too and the draft stays
// correctable.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts tools-runner-copy.test.ts

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: [],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

const fileReadTool: ToolDescriptor = {
    name: 'read',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files'],
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } }
    }
};

const snapshot = (): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: []
    }) as SessionSnapshot;

type Call = { url: string; method: string | undefined; body: unknown };

const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

// The response payload the stub server answers for `read`.
const READ_RESULT = { path: 'package.json', content: '{}' };

const boot = async (): Promise<Call[]> => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method: init?.method, body });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [fileReadTool],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/tools/read' && init?.method === 'POST') {
                return json({ ok: true, result: READ_RESULT, durationMs: 9 });
            }
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() }, 201);

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }))
    );

    await import('./main');
    await flush();
    await flush();

    document.querySelector<HTMLButtonElement>('.tools-toggle')?.click();
    await flush();

    return calls;
};

const openRunner = async (): Promise<void> => {
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="read"]')?.click();
    await flush();
};

const argsBox = (): HTMLTextAreaElement => {
    const found = document.querySelector<HTMLTextAreaElement>('.tool-args');
    if (found === null) throw new Error('missing runner arguments');
    return found;
};

const copyButton = (label: string): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>(`.tool-card .text-copy[aria-label="${label}"]`);

const callButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('.tool-card button.primary');

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    setClipboard(undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setClipboard(undefined);
    document.body.innerHTML = '';
});

it('names both panes and offers no whole-dialog copy', async () => {
    await boot();
    await openRunner();

    expect(document.querySelector('.dialog-title')?.textContent).toBe('read');

    // R8: the general dialog Copy control is removed for this surface. Other dialogs
    // (transcript, preview) keep theirs; the runner's panes are the only copy targets.
    expect(document.querySelectorAll('.dialog .dialog-copy')).toHaveLength(0);

    // Each pane has ONE copy control, named after that pane, sitting beside its label.
    const payload = copyButton('Copy payload');
    const response = copyButton('Copy response');
    expect(payload).not.toBeNull();
    expect(response).not.toBeNull();
    expect(payload?.parentElement?.querySelector('.tool-label')?.textContent).toBe('Payload (JSON)');
    expect(response?.parentElement?.querySelector('.tool-label')?.textContent).toBe('response');

    // The payload field is still a plain editable textarea (a preset is a starting
    // value, never a locked view of tool configuration).
    const args = argsBox();
    expect(args.readOnly).toBe(false);
    expect(args.disabled).toBe(false);
});

it('copies the payload and the response separately, and sends the edited payload verbatim', async () => {
    const calls = await boot();

    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);

    await openRunner();

    // R8: the runner starts from the tool's first named preset.
    expect(argsBox().value).toBe('[\n  "package.json"\n]');
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-preset')].map((node) => node.textContent)
    ).toEqual(['package.json', 'This UI', 'Only paths']);

    // An edit on top of the preset is what must be sent, byte for byte.
    argsBox().value = '[\n  "src/index.ts"\n]';

    callButton()?.click();
    await flush();
    await flush();

    // Direct call: no sessionId (R7 — only a session-bound tool gets the temporary one).
    expect(calls.find((call) => call.url === '/api/tools/read')).toEqual({
        url: '/api/tools/read',
        method: 'POST',
        body: { parameters: ['src/index.ts'] }
    });
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toHaveLength(0);

    // The response box is the server's answer envelope, as JSON.
    const body = document.querySelector('.tool-output .card-body')?.textContent ?? '';
    expect(JSON.parse(body)).toEqual({ ok: true, result: READ_RESULT, durationMs: 9 });
    expect(document.querySelector('.tool-output .card-label')?.textContent).toBe('response · 9ms');

    // Copy RESPONSE: the answer, with no tool identity, no label decoration and no
    // highlight spans.
    copyButton('Copy response')?.click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify({ ok: true, result: READ_RESULT, durationMs: 9 }, null, 2));

    // Copy PAYLOAD: the edited request, verbatim — not the preset it started from and
    // not re-serialized.
    copyButton('Copy payload')?.click();
    await flush();
    expect(writeText).toHaveBeenLastCalledWith('[\n  "src/index.ts"\n]');
    expect(writeText).toHaveBeenCalledTimes(2);

    // The two controls announce their own outcome, so the reader knows which pane was
    // written to the clipboard.
    expect(copyButton('Copy payload')?.querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');
});

it('pressing a preset fills the editable box without calling the server', async () => {
    const calls = await boot();
    await openRunner();

    const second = document.querySelectorAll<HTMLButtonElement>('.tool-preset')[1];
    expect(second?.textContent).toBe('This UI');
    second?.click();

    // The box holds the second preset's JSON, formatted, and it is editable from there.
    expect(argsBox().value).toBe('[\n  "src/frontend/main.ts",\n  "src/frontend/api.ts"\n]');
    expect(second?.getAttribute('aria-pressed')).toBe('true');
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-preset')].map((node) => node.getAttribute('aria-pressed'))
    ).toEqual(['false', 'true', 'false']);

    // A preset is a fill, not a call: nothing but boot traffic happened.
    // T5 R1: the catalogue embeds no conversations here, so boot also reads the compact
    // directory index (`GET /views`). The double answers that route from this test's raw
    // `/sessions` route, which is the URL its stub recorded — and no tool call was made,
    // which is what this assertion exists to pin.
    expect(calls.map((call) => call.url)).toEqual(['/api', '/api/models', '/api/sessions']);
});

it('keeps an invalid draft untouched and reports it as a structured response', async () => {
    const calls = await boot();
    await openRunner();

    const draft = '["package.json",]';
    argsBox().value = draft;
    callButton()?.click();
    await flush();
    await flush();

    // Nothing was sent: the payload never reached the server.
    expect(calls.filter((call) => call.url === '/api/tools/read')).toHaveLength(0);

    // The draft is exactly as typed, so it can be corrected and re-sent.
    expect(argsBox().value).toBe(draft);

    // The failure lives in the response pane, as JSON, naming the kind of failure.
    expect(document.querySelector('.tool-output .card-label')?.textContent).toBe('error');
    const failure = JSON.parse(document.querySelector('.tool-output .card-body')?.textContent ?? '');
    expect(failure.ok).toBe(false);
    expect(failure.error.kind).toBe('invalid_json');
    expect(String(failure.error.message)).toContain('Arguments are not valid JSON');
});
