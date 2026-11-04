// C5 — the shell wires the editable transcript through the REAL routes.
//
// `main.ts` boots on import, so this file stubs fetch and opens a saved session exactly
// like the real page (remembered id -> GET /sessions/:id). Two things are pinned here
// that the dialog-level tests cannot see:
//   - Save goes to `PUT /sessions/:id/threads/:threadId/transcript` with the parsed
//     editor value, and the returned `session` is applied through the shell's ordinary
//     snapshot path (the session outcome line is painted from the answer, which only
//     `applySnapshot` does);
//   - an answer whose `transcript.invalid` is set is NOT a failure: the editor keeps
//     the reader's text with the unreadable banner, and the session's `invalidThreads`
//     roster marks the conversation card — so the break is visible on the board too.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts transcript-edit-main.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
    HarnessDescriptor,
    HarnessMessage,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../server/protocol';
import { viewAwareFetch } from './view-test-support';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: ['read'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly.',
        instruction: 'Answer.',
        guidelines: []
    }
];

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const ORIGINAL: HarnessMessage[] = [
    { role: 'user', content: 'hello thread' },
    { role: 'assistant', content: 'hello answer' }
];

const REPAIRED: HarnessMessage[] = [{ role: 'user', content: 'hand edited' }];

const thread = (overrides: Partial<SessionThread> = {}): SessionThread => ({
    id: 'thread-a',
    agent: 'instruct',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    label: 'IN1',
    invocationIds: ['inv-a'],
    messages: ORIGINAL,
    ...overrides
});

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-a',
    index: 0,
    prompt: 'hello thread',
    threadId: 'thread-a',
    status: 'done',
    startedAt: T,
    updatedAt: T + 100,
    events: [
        { type: 'start', agent: 'instruct', model: 'm1' },
        { type: 'text', agent: 'instruct', delta: 'hello answer' },
        {
            type: 'done',
            agent: 'instruct',
            message: {
                role: 'assistant',
                content: 'hello answer',
                reasoning: '',
                toolCalls: [],
                model: 'm1',
                stopReason: 'stop'
            }
        }
    ],
    eventTimes: [T, T + 50, T + 100],
    ...overrides
});

const active = (): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: ORIGINAL,
        turns: [turn()],
        threads: [thread()]
    }) as SessionSnapshot;

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const bootstrap = (session: SessionSnapshot): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [session],
    agents
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

const click = (selector: string): void => {
    const node = document.querySelector<HTMLButtonElement>(selector);
    if (node === null) throw new Error(`missing button ${selector}`);
    node.click();
};

// Opens the focused thread's transcript and presses its Edit control.
const openEditor = async (): Promise<HTMLElement> => {
    click('.tile-transcript-action .transcript-open');
    await flush();
    click('.thread-transcript-edit');
    await flush();

    const panel = document.querySelector<HTMLElement>('.dialog');
    if (panel === null) throw new Error('no transcript dialog');
    return panel;
};

const typeInto = (editor: HTMLTextAreaElement, value: string): void => {
    editor.value = value;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('saves through PUT and applies the returned session through the snapshot path', async () => {
    const before = active();
    // The answer is authoritative for the session AND the transcript. `lastError` is
    // only ever painted by `applySnapshot`, so the outcome line proves the session
    // travelled the ordinary path instead of being dropped on the floor.
    const applied = {
        ...before,
        updatedAt: 30,
        status: 'error',
        lastError: 'transcript replaced',
        threads: [thread({ messages: REPAIRED })]
    } as unknown as SessionSnapshot;
    const bodies: string[] = [];

    localStorage.setItem(SESSION_KEY, 's1');
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            if (url === '/api') return json(bootstrap(before));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1/threads/thread-a/transcript' && method === 'PUT') {
                bodies.push(String(init?.body ?? ''));

                return json({
                    session: applied,
                    transcript: {
                        threadId: 'thread-a',
                        agent: 'instruct',
                        messages: REPAIRED,
                        raw: pretty(REPAIRED)
                    }
                });
            }
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: before });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();

    const panel = await openEditor();
    // The editor starts from the thread's committed messages, exactly as stored.
    const editor = panel.querySelector<HTMLTextAreaElement>('.thread-transcript-editor');
    if (editor === null) throw new Error('the shell did not open the editor');
    expect(editor.value).toBe(pretty(ORIGINAL));

    typeInto(editor, pretty(REPAIRED));
    click('.thread-transcript-save');
    await flush();

    // The wire body is the PARSED editor value, nothing else.
    expect(bodies).toEqual([JSON.stringify({ messages: REPAIRED })]);
    // The dialog left the editor for the saved document.
    expect(panel.querySelector('.thread-transcript-editor')).toBeNull();
    expect(panel.querySelector<HTMLElement>('.thread-transcript-json')?.textContent).toBe(
        pretty(REPAIRED)
    );
    // And the returned session landed in the shell's applied state.
    expect(byClass('.session-note', 'p').textContent).toBe('transcript replaced');
    expect(byClass('.session-note', 'p').hidden).toBe(false);
});

it('keeps the editor and marks the board when the saved transcript is unreadable', async () => {
    const before = active();
    const broken = { unexpected: 'shape' };
    // The write SUCCEEDED, so the session is applied with the invalid roster entry.
    const applied = {
        ...before,
        updatedAt: 40,
        threads: [thread({ messages: [] })]
    } as unknown as SessionSnapshot & {
        invalidThreads: { id: string; label: string; agent: string; error: string; messages: unknown }[];
    };
    applied.invalidThreads = [
        { id: 'thread-a', label: 'IN1', agent: 'instruct', error: 'messages is not an array', messages: broken }
    ];

    const bodies: string[] = [];
    localStorage.setItem(SESSION_KEY, 's1');
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            if (url === '/api') return json(bootstrap(before));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1/threads/thread-a/transcript' && method === 'PUT') {
                bodies.push(String(init?.body ?? ''));

                return json({
                    session: applied,
                    transcript: {
                        threadId: 'thread-a',
                        agent: 'instruct',
                        messages: [],
                        raw: pretty(broken),
                        invalid: { error: 'messages is not an array', messages: broken }
                    }
                });
            }
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: before });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();

    const panel = await openEditor();
    const editor = panel.querySelector<HTMLTextAreaElement>('.thread-transcript-editor');
    if (editor === null) throw new Error('the shell did not open the editor');

    const text = pretty(broken);
    typeInto(editor, text);
    click('.thread-transcript-save');
    await flush();

    expect(bodies).toEqual([JSON.stringify({ messages: broken })]);
    // Nothing was lost and nothing was hidden: the editor is still there, with the
    // text exactly as sent, plus the server's read failure.
    expect(panel.querySelector<HTMLTextAreaElement>('.thread-transcript-editor')?.value).toBe(text);
    expect(panel.querySelector<HTMLElement>('.thread-transcript-error')?.textContent).toBe(
        'transcript unreadable: messages is not an array'
    );
    // The applied `invalidThreads` roster reaches the board as well.
    const card = document.querySelector<HTMLElement>('.conversation[data-thread-id="thread-a"]');
    if (card === null) throw new Error('missing conversation card');
    expect(card.dataset.invalid).toBe('true');
});
