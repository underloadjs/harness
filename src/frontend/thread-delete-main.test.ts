// R7/R9 shell wiring: the expanded thread toolbar opens the JSON transcript and
// deletes the thread through the EXISTING `DELETE /sessions/:id/threads/:threadId`
// endpoint, then reconciles the returned snapshot (focus/tiles/transcript/roster).
//
// T26 (the swap): that ONE toolbar is also the only Delete surface. Its children are
// exactly `Delete` and `Transcript` — no `.tile-header-action` (or
// `.thread-header-action` / `.thread-focus-head-action`) exists anywhere, and the
// header's freed right edge carries the elapsed|tokens measurement line instead. Every
// Delete click here therefore goes through `.tile-transcript-action .thread-delete`.
//
// T6/R5 makes the NEXT step responsive, and it decides what every test below sees:
// jsdom has no `matchMedia`, so the board cannot prove a desktop and each press takes the
// confirmation branch — the SHARED dialog layer (`openDialog`), never an inline row in
// the bar. The desktop branch (one press, one DELETE, no layer) is pinned by stubbing the
// two media queries before the import.
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
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({ url, method });

            const response = handler(url, method);
            if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
            return response;
        }, { root: '/api' }))
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

// T6/R5: the mobile/narrow Delete confirmation is the SHARED dialog layer
// (`openDialog`, src/frontend/ui/dialog.ts). Selection is by CONTENT, because an open
// transcript is a second `.dialog` in the same document and must never answer here.
const deleteDialogs = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.dialog')).filter(
        (panel) => panel.querySelector('.thread-delete-confirm') !== null
    );

const deleteDialog = (): HTMLElement => {
    const open = deleteDialogs();
    if (open.length !== 1) throw new Error(`expected one delete dialog, found ${open.length}`);
    return open[0];
};

const deleteDialogButton = (selector: string): HTMLButtonElement => {
    const button = deleteDialog().querySelector<HTMLButtonElement>(selector);
    if (button === null) throw new Error(`missing ${selector} in the delete dialog`);
    return button;
};

// A PROVEN desktop for the board's click-time samples (ui/turns.ts
// `requiresDeleteConfirmation`): the layout query does NOT match (wide) and the primary
// pointer IS fine. Stubbed before the import so main.ts' own media samples agree with the
// board's.
const stubDesktop = (): void => {
    const answers: Record<string, boolean> = {
        '(max-width: 860px)': false,
        '(pointer: fine)': true
    };

    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            media: query,
            matches: answers[query] ?? false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            onchange: null
        }))
    );
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

    // The saved session is open, and T21 R22 leaves its turn COLLAPSED: the action bar
    // below belongs to the expanded surface, so the reader opens the card first.
    const tile = byClass('.tile', 'article');
    expect(tile.dataset.threadId).toBe('thread-a');
    expect(tile.classList.contains('is-expanded')).toBe(false);

    tile.querySelector<HTMLButtonElement>('.tile-select')?.click();
    await flush();
    expect(tile.classList.contains('is-expanded')).toBe(true);

    const bar = byClass('.tile-transcript-action', 'div');
    expect(bar.hidden).toBe(false);
    // T26 (shell wiring): the toolbar is the ONLY action surface of an expanded tile, and
    // it holds Delete first and Transcript second — no `.tile-header-action` exists
    // anywhere, and T6/R5 removed the third child (the inline confirmation row) in favour
    // of the shared dialog. R3/R4: the identity line is the badge ALONE (`IN1`) and the
    // measurement line (`34.2s | 18,654`) now shares that line at the right edge where
    // Delete used to be painted; T2 clips the state box to screen-reader-only, so no
    // `- done` suffix is painted even though the word is still in the DOM (below).
    expect(tile.querySelector('.tile-header-action')).toBeNull();
    expect([...bar.children].map((node) => node.className)).toEqual([
        'thread-delete',
        'transcript-open action-transcript'
    ]);
    // The shell DOES wire the DELETE transport, so the bar's leading action is live here
    // (unlike the standalone board) and names the conversation it destroys.
    const shellDelete = bar.querySelector<HTMLButtonElement>('.thread-delete');
    if (shellDelete === null) throw new Error('missing toolbar delete button');
    expect(shellDelete.hidden).toBe(false);
    expect(shellDelete.disabled).toBe(false);
    expect(shellDelete.getAttribute('aria-label')).toBe('Delete thread IN1');
    expect(shellDelete.title).toBe('Delete this thread permanently');
    expect(shellDelete.querySelector('.action-label')?.textContent).toBe('Delete');
    const shellTranscript = bar.querySelector<HTMLButtonElement>('.transcript-open');
    if (shellTranscript === null) throw new Error('missing toolbar transcript button');
    expect(shellTranscript.getAttribute('aria-label')).toBe('Open the JSON transcript of IN1');
    expect(shellTranscript.querySelector('.action-label')?.textContent).toBe('Transcript');
    expect(
        [...(tile.querySelectorAll<HTMLElement>('.tile-identity > *') ?? [])].map((node) => node.className)
    ).toEqual(['tile-thread']);
    // The fixture's thread is `IN1` and its turn is `done`, so the badge reads exactly
    // `IN1` (full, un-truncated text — styles.css gives the pill no cap) and the state
    // word is still the measurement line's last child as an accessible label, whatever
    // the colour rule paints (screenshot R3/T2).
    expect(tile.querySelector('.tile-thread')?.textContent).toBe('IN1');
    expect(
        [...(tile.querySelectorAll<HTMLElement>('.tile-top > *') ?? [])].map((node) => node.className)
    ).toEqual(['tile-elapsed', 'tile-tokens', 'tile-status']);
    expect(tile.querySelector('.tile-top > .tile-status > .tile-status-text')?.textContent).toBe('done');

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

    // T6/R5: the first click only CONFIRMS. jsdom has no `matchMedia`, so the board cannot
    // prove a desktop and opens the shared dialog on top of the still-open transcript
    // layer; the API is untouched. T26: the click still comes from the SAME toolbar, and
    // the bar itself gained no inline row.
    byClass('.tile-transcript-action .thread-delete', 'button').click();

    const confirmation = deleteDialog();
    expect(confirmation.getAttribute('role')).toBe('dialog');
    expect(confirmation.getAttribute('aria-modal')).toBe('true');
    expect(confirmation.querySelector<HTMLElement>('.dialog-title')?.textContent).toBe(
        'Delete thread'
    );
    expect(
        confirmation.querySelector<HTMLElement>('.thread-delete-confirm-body')?.textContent
    ).toBe('Delete thread IN1 permanently? Its turns and transcript are removed.');
    expect(
        [...confirmation.querySelectorAll<HTMLButtonElement>('.dialog-body button')].map(
            (button) => button.textContent
        )
    ).toEqual(['Delete thread', 'Cancel']);
    expect(document.querySelector('.tile-transcript-action .thread-delete-confirm')).toBeNull();
    // The two layers stack in open order (transcript underneath, confirmation on top), so
    // the reader can still Escape out of the destructive step alone.
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(2);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    deleteDialogButton('.thread-delete-confirm-delete').click();
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

    // T26: Delete is reached through the toolbar (`.tile-header-action` is gone), and
    // T6/R5: the confirmation is the shared dialog stacked on top of this transcript
    // layer — pressing Delete alone still sends nothing.
    byClass('.tile-transcript-action .thread-delete', 'button').click();
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(deleteDialogs()).toHaveLength(1);

    deleteDialogButton('.thread-delete-confirm-delete').click();
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

    // T6/R5: the same confirmation branch as every other test in this file (no
    // `matchMedia` in jsdom), because the panel reconciliation only ever runs after the
    // reader actually confirmed the destructive press.
    byClass('.tile-transcript-action .thread-delete', 'button').click();
    expect(document.querySelector('.panel[data-panel-id="thread-panel"]')).not.toBeNull();
    deleteDialogButton('.thread-delete-confirm-delete').click();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.panel[data-panel-id="thread-panel"]')).toBeNull();
});

it('deletes on ONE desktop press with no dialog and no inline row', async () => {
    const before = active();
    const after = emptyAfterDelete();
    localStorage.setItem(SESSION_KEY, 's1');

    // The waiver has to be PROVEN: a wide viewport AND a fine primary pointer.
    stubDesktop();

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

    byClass('.tile', 'article').querySelector<HTMLButtonElement>('.tile-select')?.click();
    await flush();
    expect(byClass('.tile', 'article').classList.contains('is-expanded')).toBe(true);

    byClass('.tile-transcript-action .thread-delete', 'button').click();
    await flush();

    // One press, one callback, and NOTHING stacked: no confirmation layer, and no inline
    // row left in the bar either.
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelectorAll('.thread-delete-confirm')).toHaveLength(0);
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);

    // The shell reconciled the answer exactly as the confirmed path does: the conversation
    // and its transcript surface are gone.
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('New thread');
});

it('sends nothing while the mobile confirmation is open, on Cancel or on Escape', async () => {
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

    byClass('.tile', 'article').querySelector<HTMLButtonElement>('.tile-select')?.click();
    await flush();

    const shellDelete = byClass('.tile-transcript-action .thread-delete', 'button');

    // Cancel: the layer closes, the conversation stays, and no request ever left.
    shellDelete.click();
    expect(deleteDialogs()).toHaveLength(1);
    deleteDialogButton('.thread-delete-confirm-cancel').click();

    expect(deleteDialogs()).toHaveLength(0);
    expect(document.querySelector('.dialog-overlay')).toBeNull();
    expect(document.querySelector('.tile')).not.toBeNull();
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);

    // Escape is the same "no": it closes the top layer alone and sends nothing.
    shellDelete.click();
    deleteDialog().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );

    expect(deleteDialogs()).toHaveLength(0);
    expect(document.querySelector('.tile')).not.toBeNull();
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    // Focus lands back on the control the reader pressed, so the toolbar is still usable.
    expect(document.activeElement).toBe(shellDelete);

    // And the confirmation still works when the reader means it.
    shellDelete.click();
    deleteDialogButton('.thread-delete-confirm-delete').click();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    expect(document.querySelector('.tile')).toBeNull();
});


