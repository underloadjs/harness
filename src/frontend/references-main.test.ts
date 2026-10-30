// Composer @ file mentions and # block references in the live shell (T5 R1/R2).
//
// Pins the end-to-end contract:
//   - `#` popup lists the REAL root+nested blocks from the board, and a pick
//     inserts an atomic chip carrying the exact turn/thread binding;
//   - labels are conversation-scoped: one label names one block (R5/R6), so the
//     popup and the server's plain-text resolution cannot disagree;
//   - `@` lookup uses the query-aware fileGlob call and inserts a path token (no
//     bytes);
//   - submitting sends `references` alongside the unchanged prompt text, including
//     while the previous task is still running (the queued state);
//   - pasted HTML is inserted as plain text, never parsed.
//   - the @ / # list is PLACED against the caret: it stays below the caret when
//     the viewport has room, flips above it when the composer is docked at the
//     bottom edge (the list would otherwise be clipped off the window), and is
//     clamped inside the field horizontally.
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

// Two turns: the roots are IT1 (t1) and IT2 (t2) because the numbering continues
// across the conversation, plus one nested research invocation in t2 (RH1). The #
// popup must list each label exactly once, and a label names exactly one block.
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

// Extra knobs for the FOLDER half of the @ lookup. `fileList` reads exactly ONE
// directory (src/frontend/main.ts:2245 `scheduleFileLookup`) and is the only source
// of folder rows — `fileGlob` recurses past directories — so a test must be able to
// both feed it entries and make it fail independently of the glob (which alone owns
// the popup's error note).
type StubFilesOptions = {
    // Entries answered by POST /api/tools/fileList, in tool order. Directories carry
    // the tool's trailing "/" and files do not.
    entries?: readonly string[];
    // When set, fileList answers `ok: false` with this message while the glob still
    // succeeds: the failed folder read must only drop the folder rows.
    fileListError?: string;
};

const stubServer = (
    session: SessionSnapshot,
    files: readonly string[] = [],
    lookupError?: string,
    options: StubFilesOptions = {}
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

            // The parallel directory read that supplies the folder rows. The reply
            // mirrors the real tool envelope (result.entries + paging/budget
            // bookkeeping the picker ignores today); the default `entries: []` keeps
            // every pre-folder test seeing zero folder rows.
            if (url === '/api/tools/fileList' && method === 'POST') {
                if (options.fileListError !== undefined) {
                    return json({ ok: false, error: { message: options.fileListError }, durationMs: 1 });
                }

                return json({
                    ok: true,
                    result: {
                        entries: options.entries ?? [],
                        truncated: false,
                        nextOffset: null,
                        offset: 0,
                        limit: 200,
                        bytes: 0,
                        contentBudget: 65536
                    },
                    durationMs: 1
                });
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

// The row labels (agent name for # rows, path for @ rows) in paint order.
const popupNames = (): (string | null | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.composer-popup-name')].map((node) => node.textContent);

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

it('lists real root+nested blocks and binds the block a label names', async () => {
    const calls = stubServer(restored());
    await mount();

    const input = composer();
    input.value = 'use #';
    input.setSelectionRange(6, 6);

    const popup = byClass('.composer-popup', 'div');
    expect(popup.hidden).toBe(false);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // Conversation-scoped labels: t1's root is IT1, t2's root is IT2 (never a
    // second IT1), and t2's nested research is RH1. Each label appears once.
    expect(popupTokens()).toEqual(['#IT1', '#IT2', '#RH1']);
    expect([...document.querySelectorAll<HTMLElement>('.composer-popup-name')].map((node) => node.textContent)).toEqual([
        'instruct',
        'instruct',
        'research'
    ]);
    expect(input.getAttribute('aria-activedescendant')).toBe('composer-option-0');

    press('Enter');

    expect(popup.hidden).toBe(true);
    expect(input.value).toBe('use #IT1');
    const chip = document.querySelector<HTMLElement>('.composer-input [data-chip="reference"]');
    expect(chip?.dataset.referenceTurn).toBe('t1');
    expect(chip?.dataset.referenceLabel).toBe('IT1');
    expect(chip?.hasAttribute('data-reference-thread')).toBe(false);

    submit();
    await flush();

    expect(taskBodies(calls)).toEqual([
        {
            input: 'use #IT1',
            references: [{ turnId: 't1', label: 'IT1' }]
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

    // The failed and cancelled roots allocate IT1/IT2, but only the third (running)
    // block is referenceable: a failed block never hides an earlier completed one,
    // and it is never offered itself.
    expect(popupTokens()).toEqual(['#IT3']);
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

// --- @ folder rows (folders first, then files) -------------------------------
//
// `fileGlob` recurses PAST directories (tools/files/glob.ts `walkFiles`), so the
// picker could never offer a folder. A SECOND request now runs in parallel after the
// same 160ms debounce: `fileList` reads the typed scope's directory and its entries
// ending in "/" become folder rows (ui/references.ts `folderPathsOf`), placed BEFORE
// every file hit so browsing reads top-down. A picked folder is plain `@dir/` text,
// not a chip, which re-opens the picker scoped to that directory.
it('lists folders above files for an empty @ query', async () => {
    const calls = stubServer(restored(), ['README.md', 'src/main.ts'], undefined, {
        entries: ['src/', 'dist/', 'a.md']
    });
    await mount();

    const input = composer();
    input.value = '@';
    input.setSelectionRange(1, 1);

    // Both reads share the one 160ms debounce; wait past that window.
    await new Promise((resolve) => setTimeout(resolve, 220));

    // FOLDER ROWS FIRST: `src/` then `dist/` (the tool's own order) precede every
    // file hit; `a.md` is a file entry and therefore contributes no folder row.
    expect(popupNames()).toEqual(['src/', 'dist/', 'README.md', 'src/main.ts']);
    // File and folder rows share the "@" token so the list reads as one surface.
    expect(popupTokens()).toEqual(['@', '@', '@', '@']);

    // Only the two directory rows carry the folder marker (styles.css bolds those);
    // a file row leaves `dataset.folder` unset.
    const rows = [...document.querySelectorAll<HTMLElement>('.composer-popup-option')];
    expect(rows.map((row) => row.dataset.folder)).toEqual(['true', 'true', undefined, undefined]);

    // An empty "@" asks fileList for the root ('.' with no name prefix) and the glob
    // for the repository overview.
    expect(calls.filter((call) => call.url === '/api/tools/fileList').map((call) => call.body)).toEqual([
        { parameters: { paths: ['.'], limit: 200 } }
    ]);
    expect(calls.filter((call) => call.url === '/api/tools/fileGlob').map((call) => call.body)).toEqual([
        { parameters: { patterns: ['**/*'], paths: ['.'], maxResults: 100 } }
    ]);
});

it('drills into a picked folder and re-scopes both lookups', async () => {
    const calls = stubServer(restored(), ['README.md', 'src/main.ts'], undefined, {
        entries: ['src/', 'dist/', 'a.md']
    });
    await mount();

    const input = composer();
    input.value = '@';
    input.setSelectionRange(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 220));

    // The first row is the `src/` folder (folders come first).
    [...document.querySelectorAll<HTMLElement>('.composer-popup-option')][0]?.click();

    // A folder pick TYPES `@src/` as PLAIN text (no chip) and immediately re-opens
    // the picker: the trailing slash is what makes the next scope a directory read.
    expect(input.value).toBe('@src/');
    expect(document.querySelector('.composer-input [data-chip="file"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('true');

    // The re-scoped lookup is debounced again; wait past the 160ms window.
    await new Promise((resolve) => setTimeout(resolve, 220));

    // `@src/` reads src ITSELF (paths ['src'], no name prefix) and globs only its
    // descendants (`**/src/**`), never files NAMED *src*.
    expect(calls.filter((call) => call.url === '/api/tools/fileList').map((call) => call.body)).toEqual([
        { parameters: { paths: ['.'], limit: 200 } },
        { parameters: { paths: ['src'], limit: 200 } }
    ]);
    expect(calls.filter((call) => call.url === '/api/tools/fileGlob').map((call) => call.body)).toEqual([
        { parameters: { patterns: ['**/*'], paths: ['.'], maxResults: 100 } },
        { parameters: { patterns: ['**/src/**'], paths: ['.'], maxResults: 100 } }
    ]);
});

it('drops only the folder rows when the directory read fails', async () => {
    const calls = stubServer(restored(), ['README.md'], undefined, { fileListError: 'fileList exploded' });
    await mount();

    const input = composer();
    input.value = '@';
    input.setSelectionRange(1, 1);
    await new Promise((resolve) => setTimeout(resolve, 220));

    // A refused folder read contributes NO folder rows and NEVER an error note: the
    // glob keeps ownership of the error state, so a half-typed directory (or an
    // unconfigured fileList) must not break @ browsing.
    expect(popupNames()).toEqual(['README.md']);
    expect(document.querySelector('.composer-popup-error')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('true');

    // The read really was attempted for the root scope; only its answer was refused.
    expect(calls.filter((call) => call.url === '/api/tools/fileList').map((call) => call.body)).toEqual([
        { parameters: { paths: ['.'], limit: 200 } }
    ]);
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

// --- @ / # popup placement (bottom-docked composer) -------------------------
//
// `.composer` is the LAST row of the pane column (styles.css: `.log-wrap` flex:1,
// `.composer` last), so anchoring the suggestion list strictly BELOW the caret
// painted it past the window's bottom edge — the list was clipped and unreachable.
// `placeComposerPopup` (main.ts:2105) therefore:
//   - defaults to `cursorLine.bottom + 4` inside `.composer-field` coordinates;
//   - flips the list ABOVE the caret line when the caret has less room below than
//     above (`roomBelow = innerHeight - rect.bottom - gap`,
//     `roomAbove = rect.top - gap`);
//   - caps `max-height` inline only when the resolved stylesheet cap is smaller
//     than the chosen side (never grows it, so a tall list cannot paint over the
//     transcript);
//   - clamps `left` inside the field so a caret near the right edge does not push
//     the box out of the composer.
//
// jsdom computes no layout at all (every Element rect is zero and `Range` has no
// `getBoundingClientRect` — main.ts:2114 guards on exactly that), so each case
// below stubs the three inputs the placement math reads: the caret rect (defined
// on the Range prototype, because jsdom does not implement it), the field rect
// (per-element own property) and the popup's offset box, plus `window.innerHeight`.
describe('composer popup placement', () => {
    // Undo callbacks for stubs that are NOT scoped to an element. Every test
    // re-imports main.ts (vi.resetModules in the outer beforeEach), so the popup
    // and field elements are fresh instances and their own properties die with
    // them; only the Range prototype and `window.innerHeight` outlive a test.
    const restores: (() => void)[] = [];
    // jsdom's default viewport height (768); restored after every placement test
    // so later/earlier suites keep jsdom's own value.
    const originalInnerHeight = window.innerHeight;

    afterEach(() => {
        while (restores.length > 0) restores.pop()?.();
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight });
    });

    // The collapsed caret's viewport rect. `placeComposerPopup` only reads top,
    // bottom and left, but a full DOMRect shape keeps the stub honest.
    const stubCaretRect = (top: number, bottom: number, left: number): void => {
        const prototype = Object.getPrototypeOf(document.createRange()) as Record<string, unknown>;
        const rect = {
            top,
            bottom,
            left,
            right: left,
            width: 0,
            height: bottom - top,
            x: left,
            y: top,
            toJSON: () => ({})
        } as DOMRect;

        // jsdom's Range prototype has NO getBoundingClientRect (verified: the
        // property is absent, not merely zero-returning), so this defines one and
        // the restore deletes it again to re-create the no-layout environment.
        Object.defineProperty(prototype, 'getBoundingClientRect', {
            configurable: true,
            writable: true,
            value: () => rect
        });
        restores.push(() => {
            delete prototype.getBoundingClientRect;
        });
    };

    // The field's viewport rect, used for both the vertical offset (rect.top) and
    // the horizontal clamp (left/width). Height stays a plausible 40px; only
    // top/left/width take part in the placement math.
    const stubFieldRect = (top: number, left: number, width: number): void => {
        const field = byClass('.composer-field', 'div');
        Object.defineProperty(field, 'getBoundingClientRect', {
            configurable: true,
            value: () =>
                ({
                    top,
                    bottom: top + 40,
                    left,
                    right: left + width,
                    width,
                    height: 40,
                    x: left,
                    y: top,
                    toJSON: () => ({})
                }) as DOMRect
        });
    };

    // The rendered list's box. jsdom reports 0 for both because nothing is laid
    // out; the real element's size is what decides the flip and the clamp.
    const stubPopupBox = (width: number, height: number): void => {
        const popup = byClass('.composer-popup', 'div');
        Object.defineProperty(popup, 'offsetWidth', { configurable: true, value: width });
        Object.defineProperty(popup, 'offsetHeight', { configurable: true, value: height });
    };

    const stubViewportHeight = (height: number): void => {
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    };

    // Paint the popup from a `#` keystroke. The `value` setter dispatches `input`
    // (installEditorAccessors, ui/editor.ts:761), and main.ts:2466 turns that into
    // `updateComposerPopup` -> `paintComposerPopup` -> `placeComposerPopup`, so
    // EVERY geometry stub above must already be in place when this runs.
    const openReferencePopup = (): HTMLElement => {
        const input = composer();
        input.value = '#';
        input.setSelectionRange(1, 1);
        return byClass('.composer-popup', 'div');
    };

    it('keeps the list below the caret when the viewport has room below', async () => {
        stubServer(restored());
        await mount();

        // Caret line sits at 600..620 with the field starting at 590: 176px of
        // room below (800 - 620 - 4) and 596px above, and the 120px list fits
        // below, so no flip is needed.
        stubCaretRect(600, 620, 40);
        stubFieldRect(590, 20, 600);
        stubPopupBox(240, 120);
        stubViewportHeight(800);

        const popup = openReferencePopup();

        // 620 - 590 + 4 = 34 (just under the caret line); 40 - 20 = 20.
        expect(popup.style.top).toBe('34px');
        expect(popup.style.left).toBe('20px');
        // 176px of room below is MORE than the 120px list, so no inline cap is
        // written and the stylesheet's own cap stays in charge.
        expect(popup.style.maxHeight).toBe('');
    });

    it('flips the list above the caret when the bottom edge leaves no room', async () => {
        stubServer(restored());
        await mount();

        // The bottom-docked case: only 16px below the caret (640 - 620 - 4) versus
        // 596px above (600 - 4), so the 120px list would be clipped off the window
        // if it opened downward.
        stubCaretRect(600, 620, 40);
        stubFieldRect(590, 20, 600);
        stubPopupBox(240, 120);
        stubViewportHeight(640);

        const popup = openReferencePopup();

        // Above the caret line, bottom edge 4px from it: 600 - 590 - 120 - 4.
        expect(popup.style.top).toBe('-114px');
        expect(popup.style.left).toBe('20px');
        // The flipped side (596px) is far taller than the 120px list, so nothing
        // shrinks the stylesheet cap here either (jsdom resolves no CSS cap, so
        // `cssCap` is NaN and the inline value stays empty).
        expect(popup.style.maxHeight).toBe('');
    });

    it('clamps a right-edge caret inside the field', async () => {
        stubServer(restored());
        await mount();

        // Caret at 260 is 240px into a 300px field; a 220px list would end at 460
        // and spill 160px out of the composer (over the right rail).
        stubCaretRect(600, 620, 260);
        stubFieldRect(590, 20, 300);
        stubPopupBox(220, 120);
        stubViewportHeight(800);

        const popup = openReferencePopup();

        // Clamped to the field's right edge: 300 - 220 = 80 (never 240).
        expect(popup.style.left).toBe('80px');
        expect(popup.style.top).toBe('34px');
    });
});
