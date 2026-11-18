// R7/R9 shell wiring: the expanded thread toolbar opens the JSON transcript and
// deletes the thread through the EXISTING `DELETE /sessions/:id/threads/:threadId`
// endpoint, then reconciles the returned snapshot (focus/tiles/transcript/roster).
//
// T26 (the swap): that ONE toolbar is also the only Delete surface. Its visible children
// are `Delete` and `Transcript` — no `.tile-header-action` (or
// `.thread-header-action` / `.thread-focus-head-action`) exists anywhere, and the
// header's freed right edge carries the elapsed|tokens measurement line instead. Every
// Delete click here therefore goes through `.tile-transcript-action .thread-delete`.
// T4/R2 adds a THIRD, permanent child between them: `Resume`, which ui/turns.ts keeps
// `hidden` unless the roster row says `stopped`. The DOM order pinned below is therefore
// three children on every surface, while the two actions this fixture's threads need stay
// exactly Delete and Transcript.
//
// R3 decides what every test below sees: a Delete press PERFORMS the delete. There is no
// confirmation dialog on any surface — the board does not ask the device anything on the
// way to the DELETE — so the first click is the request and no layer is ever created. The
// `stubDesktop` / `stubPhone` pair below only pins the shell's own media-driven chrome,
// and the pair of tests that uses it proves the phone and the desktop press are one and
// the same press.
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
        entry: 'instruct',
        ranks: { instruct: 'A' },
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

// R3: a Delete press must create NO layer. Counting every panel — instead of filtering on
// the content class the removed confirmation used to carry — also catches a stray second
// dialog, so this is the assertion every test below uses.
const noDialog = (): void => {
    expect(document.querySelectorAll('.dialog')).toHaveLength(0);
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
};

// Two tests press Delete while the JSON transcript is already open, so the honest check
// there is "nothing NEW stacked": the count is taken before the press, and the transcript
// alone is what the delete's reconcile closes.
const layers = (): number => document.querySelectorAll('.dialog').length;

// `main.ts` samples these two queries for its OWN layout rules (rails, composer). The
// delete decision no longer reads them at all, so a stub here only pins the surface the
// shell paints itself — which is exactly what the desktop/phone pair below is for.
const stubMedia = (phone: boolean, fine: boolean): void => {
    const answers: Record<string, boolean> = {
        '(max-width: 860px)': phone,
        '(pointer: fine)': fine
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

const stubDesktop = (): void => stubMedia(false, true);
const stubPhone = (): void => stubMedia(true, false);

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
    // anywhere, and the confirmation step (first an inline row, then a shared dialog) is
    // gone for good: a press deletes. R3/R4: the identity line is the badge ALONE (`IN1`) and the
    // measurement line (`34.2s | 18,654`) now shares that line at the right edge where
    // Delete used to be painted; T2 clips the state box to screen-reader-only, so no
    // `- done` suffix is painted even though the word is still in the DOM (below).
    expect(tile.querySelector('.tile-header-action')).toBeNull();
    expect([...bar.children].map((node) => node.className)).toEqual([
        'thread-delete',
        // T4/R2: the permanent Resume slot, between Delete and Transcript. This fixture's
        // thread is `idle` — live but not halted — so it is in the DOM and NOT painted.
        'resume-open action-resume',
        'transcript-open action-transcript'
    ]);
    // The shell DOES wire the DELETE transport, so the bar's leading action is live here
    // (unlike the standalone board) and names the conversation it destroys.
    const shellDelete = bar.querySelector<HTMLButtonElement>('.thread-delete');
    if (shellDelete === null) throw new Error('missing toolbar delete button');
    expect(shellDelete.hidden).toBe(false);
    expect(shellDelete.disabled).toBe(false);
    expect(shellDelete.getAttribute('aria-label')).toBe('Delete thread IN1');
    expect(shellDelete.title).toBe(
        'Delete this thread: it leaves this session, and its transcript is kept until the session is deleted'
    );
    expect(shellDelete.querySelector('.action-label')?.textContent).toBe('Delete');
    const shellTranscript = bar.querySelector<HTMLButtonElement>('.transcript-open');
    if (shellTranscript === null) throw new Error('missing toolbar transcript button');
    expect(shellTranscript.getAttribute('aria-label')).toBe('Open the JSON transcript of IN1');
    expect(shellTranscript.querySelector('.action-label')?.textContent).toBe('Transcript');
    // T4/R2: the shell resolves `resumeThread` for this view exactly like it resolves
    // `deleteThread`/`stopThread`, so even an UNPAINTED Resume control states the action it
    // would perform instead of the missing-transport reason the standalone board shows.
    const shellResume = bar.querySelector<HTMLButtonElement>('.resume-open');
    if (shellResume === null) throw new Error('missing toolbar resume button');
    expect(shellResume.hidden).toBe(true);
    expect(shellResume.getAttribute('aria-label')).toBe('Resume thread IN1');
    expect(shellResume.title).toBe('Resume this stopped thread');
    expect(shellResume.querySelector('.action-label')?.textContent).toBe('Resume');
    expect(shellResume.querySelector('.action-glyph')?.textContent).toBe('▶');
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

    // R3: the first click IS the delete. Nothing new stacks on top of the still-open
    // transcript — the transcript itself is what the reconcile closes. T26: the click still
    // comes from the SAME toolbar, and the bar owns no inline row.
    const openLayers = layers();
    expect(openLayers).toBe(1);
    byClass('.tile-transcript-action .thread-delete', 'button').click();
    expect(layers()).toBe(openLayers);
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

    // T26: Delete is reached through the toolbar (`.tile-header-action` is gone), and R3:
    // the press rides straight through the DELETE route while the transcript layer sits
    // underneath — no confirmation step in between, and no extra layer joins the stack.
    const openLayers = layers();
    expect(openLayers).toBe(1);
    byClass('.tile-transcript-action .thread-delete', 'button').click();
    expect(layers()).toBe(openLayers);
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

    // R3: the press IS the request, and the panel reconciliation only runs once the DELETE
    // answer comes back — so the panel is still painted the instant after the click.
    byClass('.tile-transcript-action .thread-delete', 'button').click();
    expect(document.querySelector('.panel[data-panel-id="thread-panel"]')).not.toBeNull();
    noDialog();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.panel[data-panel-id="thread-panel"]')).toBeNull();
});

it('deletes on ONE press with no dialog and no inline row on a desktop surface', async () => {
    const before = active();
    const after = emptyAfterDelete();
    localStorage.setItem(SESSION_KEY, 's1');

    // A wide viewport with a fine pointer: the surface that used to be the ONLY one
    // allowed to delete on a single press.
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
    noDialog();

    // The shell reconciled the answer: the conversation and the surface it was open on are
    // gone and the composer fell back to a new thread.
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('New thread');
});

it('deletes on ONE press with no dialog and no inline row on a phone surface', async () => {
    // R3's whole point: the phone cell of the old matrix IS the desktop cell. Same toolbar,
    // same single press, same single DELETE, and no layer at any point.
    const before = active();
    const after = emptyAfterDelete();
    localStorage.setItem(SESSION_KEY, 's1');

    // Narrow viewport, coarse pointer — the surface that used to owe a dialog.
    stubPhone();

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

    // The bar is the same three permanent children on a phone; nothing about the toolbar
    // changes with the surface.
    const bar = byClass('.tile-transcript-action', 'div');
    expect([...bar.children].map((node) => node.className)).toEqual([
        'thread-delete',
        'resume-open action-resume',
        'transcript-open action-transcript'
    ]);

    byClass('.tile-transcript-action .thread-delete', 'button').click();
    // Asserted BEFORE the request settles: the board never grows a layer at all.
    noDialog();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    noDialog();
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('New thread');
});

it('sends exactly one DELETE however often the phone reader taps', async () => {
    const before = active();
    const after = emptyAfterDelete();
    localStorage.setItem(SESSION_KEY, 's1');

    stubPhone();

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

    // The burst a thumb on glass actually produces: the first press owns the conversation
    // and disables the control, the rest are no-ops, and not one of them opens a layer.
    shellDelete.click();
    noDialog();
    shellDelete.click();
    shellDelete.click();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }
    ]);
    expect(shellDelete.disabled).toBe(true);
    noDialog();

    await flush();
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('New thread');
});


