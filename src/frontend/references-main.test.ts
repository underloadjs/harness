// Composer @ file mentions and # block references in the live shell (T5 R1/R2).
//
// Pins the end-to-end contract:
//   - `#` popup lists the REAL root+nested blocks from the board, and a pick
//     inserts an atomic chip carrying the exact turn/thread binding;
//   - the LATEST matching label wins across turns (the server's plain-text rule);
//   - `@` lookup uses the query-aware fileGlob call and inserts a path token (no
//     bytes);
//   - submitting sends `references` alongside the unchanged prompt text, including
//     while the previous task is still running (the queued state);
//   - pasted HTML is inserted as plain text, never parsed.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts references-main.test.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

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

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: 'task',
        status: 'done',
        startedAt: T,
        updatedAt: T,
        events: [],
        ...overrides
    }) as SessionTurn;

// Two turns that BOTH allocate `IT1` plus one nested research invocation in t2.
// The # popup must list IT1 once (latest = t2) and RH1 once (nested t2).
const restored = (): SessionSnapshot => ({
    id: 's1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    turns: [
        turn({
            id: 't1',
            index: 0,
            prompt: 'first',
            events: [
                { type: 'start', agent: 'instruct', model: 'm1' },
                { type: 'text', agent: 'instruct', delta: 'first answer' }
            ]
        }),
        turn({
            id: 't2',
            index: 1,
            prompt: 'second',
            events: [
                { type: 'start', agent: 'instruct', model: 'm1' },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    call: { id: 'd1', name: 'agentDelegate', arguments: '{}' }
                },
                { type: 'start', agent: 'research', model: 'm1' },
                { type: 'text', agent: 'research', delta: 'nested answer' },
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'agentDelegate',
                    content: 'ok',
                    isError: false,
                    callId: 'd1'
                }
            ]
        })
    ]
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 20));
};

const bootstrap = (session: SessionSnapshot): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [session],
    agents: []
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

const stubServer = (
    session: SessionSnapshot,
    files: readonly string[] = [],
    lookupError?: string
): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            if (url === '/api') return json(bootstrap(session));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === 'POST') return json({ session }, 201);

            if (url === '/api/tools/fileGlob' && method === 'POST') {
                if (lookupError !== undefined) {
                    return json({ ok: false, error: { message: lookupError }, durationMs: 1 });
                }

                return json({ ok: true, result: { files, truncated: false }, durationMs: 1 });
            }

            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                const request = body as { input: string };
                // A queued record: the previous task is still running, so the server
                // retains this one and answers 202 immediately.
                const opening = turn({ id: 't3', index: 2, prompt: request.input, status: 'queued' });
                return json(
                    {
                        session: { ...session, status: 'running', turns: [...session.turns, opening] },
                        turn: opening
                    },
                    202
                );
            }

            if (url === '/api/sessions/s1/events') {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start() {
                            // Never emits: the 202 answer owns the queued state.
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            if (url === '/api/sessions/s1' && method === undefined) return json({ session });
            if (url === '/api/sessions' && method === undefined) return json({ sessions: [session] });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        })
    );

    return calls;
};

const mount = async (): Promise<void> => {
    await import('./main');
    await flush();
};

const taskBodies = (calls: Call[]): unknown[] =>
    calls.filter((call) => call.url === '/api/sessions/s1/tasks' && call.method === 'POST').map((call) => call.body);

const composer = (): HTMLDivElement & { value: string; setSelectionRange: (start: number, end?: number) => void } =>
    byClass('.composer-input', 'div') as HTMLDivElement & {
        value: string;
        setSelectionRange: (start: number, end?: number) => void;
    };

const submit = (): void => {
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

const popupTokens = (): (string | null | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.composer-popup-token')].map((node) => node.textContent);

const press = (key: string): void => {
    composer().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(SESSION_KEY, 's1');
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('lists real root+nested blocks and binds the latest matching label', async () => {
    const calls = stubServer(restored());
    await mount();

    const input = composer();
    input.value = 'use #';
    input.setSelectionRange(6, 6);

    const popup = byClass('.composer-popup', 'div');
    expect(popup.hidden).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // One IT1 (latest t2) and the nested t2 RH1; no duplicate root labels.
    expect(popupTokens()).toEqual(['#IT1', '#RH1']);
    expect([...document.querySelectorAll<HTMLElement>('.composer-popup-name')].map((node) => node.textContent)).toEqual([
        'instruct',
        'research'
    ]);
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-option-0');

    press('Enter');

    expect(popup.hidden).toBe(true);
    expect(input.value).toBe('use #IT1');
    const chip = document.querySelector<HTMLElement>('.composer-input [data-chip="reference"]');
    expect(chip?.dataset.referenceTurn).toBe('t2');
    expect(chip?.dataset.referenceLabel).toBe('IT1');
    expect(chip?.hasAttribute('data-reference-thread')).toBe(false);

    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        {
            input: 'use #IT1',
            references: [{ turnId: 't2', label: 'IT1' }]
        }
    ]);
});

it('filters # to a nested block and submits its exact thread binding', async () => {
    const calls = stubServer(restored());
    await mount();

    const input = composer();
    input.value = 'ask #RH';
    input.setSelectionRange(8, 8);

    expect(popupTokens()).toEqual(['#RH1']);
    press('Enter');

    expect(input.value).toBe('ask #RH1');
    const chip = document.querySelector<HTMLElement>('.composer-input [data-chip="reference"]');
    expect(chip?.dataset.referenceTurn).toBe('t2');
    expect(chip?.dataset.referenceThread).toBe('inline:research');
    expect(chip?.dataset.referenceLabel).toBe('RH1');

    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        {
            input: 'ask #RH1',
            references: [{ turnId: 't2', threadId: 'inline:research', label: 'RH1' }]
        }
    ]);
});

it('looks up files with a query-aware glob and inserts a pointer token', async () => {
    const calls = stubServer(restored(), ['src/frontend/main.ts', 'src/frontend/ui/editor.ts']);
    await mount();

    const input = composer();
    input.value = '@main';
    input.setSelectionRange(5, 5);

    // The lookup is debounced; wait past the 160ms window.
    await new Promise((resolve) => setTimeout(resolve, 220));

    const lookup = calls.find((call) => call.url === '/api/tools/fileGlob');
    expect(lookup?.body).toEqual({
        parameters: { patterns: ['**/*main*'], paths: ['.'], maxResults: 100 }
    });
    expect(popupTokens()).toEqual(['@']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.composer-popup-name')].map((node) => node.textContent)
    ).toEqual(['src/frontend/main.ts']);

    press('Enter');

    expect(input.value).toBe('@src/frontend/main.ts');
    const chip = document.querySelector<HTMLElement>('.composer-input [data-chip="file"]');
    expect(chip?.dataset.chipLabel).toBe('@src/frontend/main.ts');

    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([{ input: '@src/frontend/main.ts' }]);
});

it('sends a reference while the previous task is still running (queued state)', async () => {
    const running = restored();
    running.status = 'running';
    running.turns = [turn({ id: 't1', index: 0, status: 'running', events: [
        { type: 'start', agent: 'instruct', model: 'm1' },
        { type: 'text', agent: 'instruct', delta: 'working' }
    ] })];
    const calls = stubServer(running);
    await mount();

    const input = composer();
    input.value = 'next #IT1';
    input.setSelectionRange(9, 9);
    press('Enter');

    expect(input.value).toBe('next #IT1');
    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        { input: 'next #IT1', references: [{ turnId: 't1', label: 'IT1' }] }
    ]);
    // The queued tile sits behind the running one; the reference itself did not
    // wait for the previous run to finish.
    const tiles = [...document.querySelectorAll<HTMLElement>('.tile')];
    expect(tiles).toHaveLength(2);
    expect(tiles.map((tile) => tile.dataset.state)).toEqual(['streaming', 'queued']);
});

it('offers only referenceable blocks (done/running), never failed or cancelled', async () => {
    const failed = restored();
    failed.turns = [
        turn({
            id: 'f1',
            index: 0,
            status: 'error',
            events: [
                { type: 'start', agent: 'instruct', model: 'm1' },
                { type: 'error', agent: 'instruct', error: { message: 'boom' } }
            ]
        }),
        turn({
            id: 'c1',
            index: 1,
            status: 'cancelled',
            events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
        }),
        turn({
            id: 'r1',
            index: 2,
            status: 'running',
            events: [
                { type: 'start', agent: 'instruct', model: 'm1' },
                { type: 'text', agent: 'instruct', delta: 'still working' }
            ]
        })
    ];
    stubServer(failed);
    await mount();

    const input = composer();
    input.value = '#';
    input.setSelectionRange(1, 1);

    // The failed and cancelled roots allocate IT1 too, but only the running block
    // is referenceable; a failed latest block must not be offered.
    expect(popupTokens()).toEqual(['#IT1']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.composer-popup-state')].map((node) => node.textContent)
    ).toEqual(['running']);

    press('Enter');
    const chip = document.querySelector<HTMLElement>('.composer-input [data-chip="reference"]');
    expect(chip?.dataset.referenceTurn).toBe('r1');
});

it('does not offer a failed legacy inline block in the # popup', async () => {
    const legacy = restored();
    legacy.turns = [
        turn({
            id: 'l1',
            index: 0,
            prompt: 'legacy',
            status: 'done',
            events: [
                { type: 'start', agent: 'instruct', model: 'm1' },
                { type: 'text', agent: 'instruct', delta: 'root answer' },
                { type: 'start', agent: 'research', model: 'm1' },
                { type: 'text', agent: 'research', delta: 'partial child' },
                { type: 'error', agent: 'research', error: { message: 'child exploded' } },
                { type: 'done', agent: 'instruct', message: {
                    role: 'assistant',
                    content: 'root answer',
                    reasoning: '',
                    toolCalls: [],
                    model: 'm1',
                    stopReason: 'stop'
                } }
            ]
        })
    ];
    stubServer(legacy);
    await mount();

    const input = composer();
    input.value = '#';
    input.setSelectionRange(1, 1);

    // The row-less `inline:research` child errored; only the completed root offers
    // a referenceable block.
    expect(popupTokens()).toEqual(['#IT1']);

    press('Enter');
    const chip = document.querySelector<HTMLElement>('.composer-input [data-chip="reference"]');
    expect(chip?.dataset.referenceLabel).toBe('IT1');
    expect(chip?.hasAttribute('data-reference-thread')).toBe(false);
});

it('normalizes ./ and backslash path queries for both lookup and filtering', async () => {
    const calls = stubServer(restored(), ['src/frontend/main.ts', 'src/backend/x.ts']);
    await mount();

    const input = composer();
    input.value = '@./src/frontend';
    input.setSelectionRange(15, 15);

    await new Promise((resolve) => setTimeout(resolve, 220));

    const lookup = calls.find((call) => call.url === '/api/tools/fileGlob');
    expect(lookup?.body).toEqual({
        parameters: { patterns: ['**/src/frontend*/**', '**/src/frontend*'], paths: ['.'], maxResults: 100 }
    });
    // The returned posix path survives the raw `./`-prefixed query filter.
    expect(
        [...document.querySelectorAll<HTMLElement>('.composer-popup-name')].map((node) => node.textContent)
    ).toEqual(['src/frontend/main.ts']);

    input.value = '@.\\src\\frontend';
    input.setSelectionRange(15, 15);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(
        [...document.querySelectorAll<HTMLElement>('.composer-popup-name')].map((node) => node.textContent)
    ).toEqual(['src/frontend/main.ts']);
});

it('does not offer cancelled legacy inline blocks in the # popup', async () => {
    const legacy = restored();
    legacy.turns = [
        turn({
            id: 'c1',
            index: 0,
            prompt: 'cancelled',
            status: 'cancelled',
            events: [
                { type: 'start', agent: 'instruct', model: 'm1' },
                { type: 'start', agent: 'research', model: 'm1' }
            ]
        })
    ];
    stubServer(legacy);
    await mount();

    const input = composer();
    input.value = '#';
    input.setSelectionRange(1, 1);

    expect(popupTokens()).toEqual([]);
    expect(document.querySelector('.composer-popup-note')?.textContent).toBe('No referenceable agent blocks');
});

it('shows an explicit error when the file lookup fails', async () => {
    stubServer(restored(), [], 'fileGlob exploded');
    await mount();

    const input = composer();
    input.value = '@ma';
    input.setSelectionRange(3, 3);

    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(document.querySelector('.composer-popup-error')?.textContent).toBe('fileGlob exploded');
    expect(popupTokens()).toEqual([]);
});

it('keeps a typed plain #LABEL as text without inventing reference metadata', async () => {
    const calls = stubServer(restored());
    await mount();

    const input = composer();
    input.value = 'check #IT1 yourself';

    submit();
    await flush();

    // The server resolves the latest matching label for a plain token; the client
    // must not claim a binding the reader did not pick.
    expect(taskBodies(calls)).toEqual([{ input: 'check #IT1 yourself' }]);
});

it('prevents native HTML-only paste and drop payloads without inserting markup', async () => {
    stubServer(restored());
    await mount();

    const input = composer();
    input.value = 'keep';

    const htmlOnly = (type: string): string =>
        type === 'text/html' ? '<img src="x" onerror="alert(1)"><b>bold</b>' : '';

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
        value: { files: [], getData: htmlOnly }
    });
    input.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(input.value).toBe('keep');
    expect(input.querySelector('img')).toBeNull();
    expect(input.querySelector('b')).toBeNull();

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
        value: { files: [], items: [], getData: htmlOnly }
    });
    byClass('.composer', 'form').dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(input.value).toBe('keep');
    expect(input.querySelector('img')).toBeNull();
    expect(document.querySelector('.composer-input img')).toBeNull();

    // A plain-text drop is still inserted, at the caret, as text.
    const textDrop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(textDrop, 'dataTransfer', {
        value: { files: [], items: [], getData: (type: string) => (type === 'text/plain' ? ' dropped' : '') }
    });
    input.setSelectionRange(4, 4);
    byClass('.composer', 'form').dispatchEvent(textDrop);

    expect(textDrop.defaultPrevented).toBe(true);
    expect(input.value).toBe('keep dropped');
});

it('pastes HTML as plain text instead of parsing it', async () => {
    stubServer(restored());
    await mount();

    const input = composer();
    input.value = 'start ';

    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
        value: { files: [], getData: (type: string) => (type === 'text/plain' ? '<b>bold</b>' : '') }
    });
    input.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(input.value).toBe('start <b>bold</b>');
    expect(input.querySelector('b')).toBeNull();
});
