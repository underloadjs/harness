// R7/R9 shell wiring: the expanded thread toolbar opens the JSON transcript and
// deletes the thread through the EXISTING `DELETE /sessions/:id/threads/:threadId`
// endpoint, then reconciles the returned snapshot (focus/tiles/transcript/roster).
//
// `main.ts` boots on import, so this file stubs fetch and opens a saved session
// exactly like the real page (remembered id -> GET /sessions/:id). No server and no
// provider are involved; the DELETE answer is the fixture's authoritative snapshot.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts thread-delete-main.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
    HarnessDescriptor,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../server/protocol';

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
        coreTools: ['fileRead'],
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

const thread = (overrides: Partial<SessionThread> = {}): SessionThread => ({
    id: 'thread-a',
    agent: 'instruct',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    label: 'IN1',
    invocationIds: ['inv-a'],
    messages: [
        { role: 'user', content: 'hello thread' },
        { role: 'assistant', content: 'hello answer' }
    ],
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
        messages: [],
        turns: [turn()],
        threads: [thread()]
    }) as SessionSnapshot;

const emptyAfterDelete = (): SessionSnapshot =>
    ({
        ...active(),
        updatedAt: 20,
        turns: [],
        threads: []
    }) as SessionSnapshot;

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

type Call = { url: string; method: string | undefined };

const stubFetch = (
    handler: (url: string, method: string | undefined) => Response | undefined
): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({ url, method });

            const response = handler(url, method);
            if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
            return response;
        })
    );

    return calls;
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// Submit through the real composer path so the shell's own `run()` teardown is
// exercised (not a direct API call).
const submit = (text: string): void => {
    const input = byClass('.composer-input', 'div');
    input.textContent = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('opens the JSON transcript and deletes a thread through the existing endpoint', async () => {
    const before = active();
    const after = emptyAfterDelete();
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap(before));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: before });
        if (url === '/api/sessions/s1/threads/thread-a' && method === 'DELETE') {
            return json({ deleted: true, session: after });
        }
        return undefined;
    });

    await import('./main');
    await flush();

    // The saved session is open and its one turn is the expanded surface.
    const tile = byClass('.tile', 'article');
    expect(tile.dataset.threadId).toBe('thread-a');
    const bar = byClass('.tile-transcript-action', 'div');
    expect(bar.hidden).toBe(false);

    // R7: the explicit open fetches the same session once and renders pretty JSON.
    byClass('.tile-transcript-action .transcript-open', 'button').click();
    await flush();

    const pre = document.querySelector<HTMLElement>('.thread-transcript-json');
    expect(pre).not.toBeNull();
    const parsed = JSON.parse(pre?.textContent ?? '{}') as {
        session: { id: string };
        thread: { id: string };
        turns: { id: string }[];
    };
    expect(parsed.session.id).toBe('s1');
    expect(parsed.thread.id).toBe('thread-a');
    expect(parsed.turns.map((entry) => entry.id)).toEqual(['turn-a']);
    expect(pre?.textContent).toContain('"hello thread"');
    expect(pre?.textContent).toContain('"hello answer"');

    // R9: first click only opens the inline confirmation; the API is untouched.
    byClass('.tile-transcript-action .thread-delete', 'button').click();
    expect(byClass('.tile-transcript-action .thread-delete-confirm', 'div').hidden).toBe(false);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    byClass('.thread-delete-confirm-delete', 'button').click();
    await flush();

    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(deletes).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);

    // The returned snapshot is authoritative: the tile, roster row and open JSON
    // dialog are gone; the composer falls back to "New thread".
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.thread-transcript-json')).toBeNull();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('New thread');
});

it('reconciles the DELETE result even when the snapshot is stale for the watermark', async () => {
    const before = active();
    // Deliberately OLDER than the applied snapshot mark: `applySnapshot` would
    // reject it as a late answer, but a confirmed DELETE is authoritative for its
    // thread. The shell must still tombstone/filter/reconcile it.
    const staleAfter = { ...emptyAfterDelete(), updatedAt: 1 } as SessionSnapshot;
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap(before));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: before });
        if (url === '/api/sessions/s1/threads/thread-a' && method === 'DELETE') {
            return json({ deleted: true, session: staleAfter });
        }
        return undefined;
    });

    await import('./main');
    await flush();

    byClass('.tile-transcript-action .transcript-open', 'button').click();
    await flush();
    expect(document.querySelector('.thread-transcript-json')).not.toBeNull();

    byClass('.tile-transcript-action .thread-delete', 'button').click();
    byClass('.thread-delete-confirm-delete', 'button').click();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.thread-transcript-json')).toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('New thread');
});

it('closes and invalidates the transcript when the session disappears during an operation', async () => {
    let sessionExists = true;
    const before = active();
    localStorage.setItem(SESSION_KEY, 's1');

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap(before));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) {
            return sessionExists
                ? json({ session: before })
                : json({ error: { message: 'Unknown session "s1".' } }, 404);
        }
        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json({ error: { message: 'Unknown session "s1".' } }, 404);
        }
        return undefined;
    });

    await import('./main');
    await flush();

    const staleButton = byClass('.tile-transcript-action .transcript-open', 'button');
    staleButton.click();
    await flush();
    expect(document.querySelector('.thread-transcript-json')).not.toBeNull();

    // The server restarted and no longer holds s1. A task submit now reports it.
    sessionExists = false;
    submit('after the restart');
    await flush();
    await flush();

    // The open dialog is closed and its authority cleared; the old control cannot
    // rebuild it from the board's stale roster/tile fallback.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.thread-transcript-json')).toBeNull();
    const bar = staleButton.closest<HTMLElement>('.tile-transcript-action');
    expect(bar?.hidden).toBe(true);
    staleButton.click();
    await flush();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.thread-transcript-json')).toBeNull();
});

it('recomputes tool panels from surviving records on a stale DELETE answer', async () => {
    const staleAfter = { ...emptyAfterDelete(), updatedAt: 1 } as SessionSnapshot;
    const withPanel: SessionSnapshot = {
        ...active(),
        turns: [
            turn({
                events: [
                    { type: 'start', agent: 'instruct', model: 'm1' },
                    {
                        type: 'tool_result',
                        agent: 'instruct',
                        name: 'statusTool',
                        content: 'ok',
                        isError: false,
                        ui: [
                            {
                                id: 'thread-panel',
                                slot: 'scratch',
                                title: 'Thread panel',
                                blocks: [{ type: 'text', text: 'only-thread' }]
                            }
                        ]
                    },
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
                ]
            })
        ]
    } as SessionSnapshot;
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap(withPanel));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: withPanel });
        if (url === '/api/sessions/s1/threads/thread-a' && method === 'DELETE') {
            return json({ deleted: true, session: staleAfter });
        }
        return undefined;
    });

    await import('./main');
    await flush();

    expect(document.querySelector('.panel[data-panel-id="thread-panel"]')).not.toBeNull();

    byClass('.tile-transcript-action .thread-delete', 'button').click();
    byClass('.thread-delete-confirm-delete', 'button').click();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.panel[data-panel-id="thread-panel"]')).toBeNull();
});
