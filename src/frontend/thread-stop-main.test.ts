// R1 shell wiring: the transcript bar's destructive action is STOP while the conversation
// has live work, and it rides the EXISTING
// `POST /sessions/{id}/threads/{tid}/cancel` route with NO confirmation dialog.
//
// This is the wiring proof that the standalone board tests cannot give:
//   - `main.ts` passes `stopThread` into the board (mirroring how `deleteThread` reaches
//     it), so a live conversation's bar leads with `Stop` rather than a disabled `Delete`;
//   - one press sends exactly ONE cancel for the pressed thread, and no DELETE and no
//     dialog layer ever appear (the delete waiver in ui/turns.ts is irrelevant here — this
//     jsdom cannot prove a desktop, and Delete below still confirms);
//   - the control flips back to `Delete` from the ROSTER the shell re-reads after the stop
//     (`cancelViewThread` -> `refreshRoster` -> `applyView`), not from a local flag;
//   - and the Delete that follows is the untouched existing flow: confirmation on this
//     surface, then `DELETE .../threads/{tid}`, then the snapshot reconcile.
//
// `main.ts` boots on import, so (exactly like thread-delete-main.test.ts) the fixture stubs
// fetch and opens a saved session through the raw routes; `viewAwareFetch` compiles the
// answers into the display wire. The extra `/events` route the sibling file never needs is
// here because a RUNNING conversation makes the shell subscribe to its flow.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts thread-stop-main.test.ts

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
    status: 'running',
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
    status: 'running',
    startedAt: T,
    updatedAt: T + 100,
    events: [
        { type: 'start', agent: 'instruct', model: 'm1' },
        { type: 'text', agent: 'instruct', delta: 'hello answer' }
    ],
    eventTimes: [T, T + 50],
    ...overrides
});

// The conversation as the server holds it while the thread is mid-run.
const running = (): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [turn()],
        threads: [thread()]
    }) as SessionSnapshot;

// What the roster re-read answers once the cancel landed: the SAME conversation, thread
// `stopped`, its turn `cancelled`. Newer `updatedAt`, or `applyView` would reject it.
const stopped = (): SessionSnapshot =>
    ({
        ...running(),
        status: 'idle',
        updatedAt: 20,
        turns: [turn({ status: 'cancelled', updatedAt: T + 200 })],
        threads: [thread({ status: 'stopped' })]
    }) as SessionSnapshot;

const emptyAfterDelete = (from: SessionSnapshot): SessionSnapshot =>
    ({ ...from, updatedAt: 30, turns: [], threads: [] }) as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
};

type Call = { url: string; method: string | undefined };

// The fixture server. `current` mutates as writes land, so a roster re-read after the stop
// answers the STOPPED document rather than the one the conversation opened with.
type Fixture = {
    calls: Call[];
};

const stubServer = (initial: SessionSnapshot): Fixture => {
    const calls: Call[] = [];
    let current = initial;

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({ url, method });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [current],
                    agents
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            // The per-thread cancel already exists server-side; the Stop control must be
            // the thing that dials it.
            if (url === '/api/sessions/s1/threads/thread-a/cancel' && method === 'POST') {
                current = stopped();

                return json({ cancelled: true });
            }

            if (url === '/api/sessions/s1/threads/thread-a' && method === 'DELETE') {
                current = emptyAfterDelete(current);

                return json({ deleted: true, session: current });
            }

            // A running conversation makes the shell subscribe to its flow. An empty, open
            // stream is enough: every transition in this file comes from the re-read the
            // mutation performs, not from a pushed frame.
            if (url === '/api/sessions/s1/events') {
                return new Response(new ReadableStream<Uint8Array>(), {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' }
                });
            }

            if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    return { calls };
};

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// The shared delete-confirmation layer, selected by CONTENT (an open transcript is another
// `.dialog`), exactly as thread-delete-main.test.ts does.
const deleteDialogs = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.dialog')).filter(
        (panel) => panel.querySelector('.thread-delete-confirm') !== null
    );

// The bar's ONE destructive control, in whichever meaning it currently has.
const actionOf = (): HTMLButtonElement =>
    byClass('.tile-transcript-action .thread-delete', 'button');

const expandOnlyTile = async (): Promise<HTMLElement> => {
    const tile = byClass('.tile', 'article');
    if (!tile.classList.contains('is-expanded')) {
        tile.querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();
    }
    expect(tile.classList.contains('is-expanded')).toBe(true);

    return tile;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('shows Stop for a running thread and cancels it with one press and no dialog', async () => {
    localStorage.setItem(SESSION_KEY, 's1');
    const fixture = stubServer(running());

    await import('./main');
    await flush();

    const tile = await expandOnlyTile();
    expect(tile.dataset.threadId).toBe('thread-a');

    const bar = byClass('.tile-transcript-action', 'div');
    expect([...bar.children].map((node) => node.className)).toEqual([
        'thread-delete thread-stop',
        // T4/R2: the third child is the permanent Resume slot; this thread is `running`,
        // not `stopped`, so it is unpainted and the Stop/Transcript pair is still what the
        // reader sees.
        'resume-open action-resume',
        'transcript-open action-transcript'
    ]);
    expect(bar.querySelector<HTMLElement>('.resume-open')?.hidden).toBe(true);

    const button = actionOf();
    expect(button.hidden).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.querySelector('.action-label')?.textContent).toBe('Stop');
    expect(button.getAttribute('aria-label')).toBe('Stop thread IN1');
    expect(button.title).toBe('Stop this thread');

    button.click();
    await flush();
    await flush();

    // The existing cancel route, exactly once, and nothing destructive: no DELETE and no
    // confirmation layer anywhere — this jsdom cannot prove a desktop, which is precisely
    // the surface where a DELETE would have asked.
    expect(
        fixture.calls.filter((call) => call.url.endsWith('/threads/thread-a/cancel'))
    ).toEqual([{ url: '/api/sessions/s1/threads/thread-a/cancel', method: 'POST' }]);
    expect(fixture.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
    expect(deleteDialogs()).toHaveLength(0);

    // The stop does not destroy the conversation: the tile and its focus survive.
    expect(document.querySelector('.tile')).not.toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('Continuing IN1');
});

it('turns the same control back into Delete once the stopped roster lands, and the delete still works', async () => {
    localStorage.setItem(SESSION_KEY, 's1');
    const fixture = stubServer(running());

    await import('./main');
    await flush();

    await expandOnlyTile();
    expect(actionOf().querySelector('.action-label')?.textContent).toBe('Stop');

    actionOf().click();
    await flush();
    await flush();

    // The roster the shell re-read after the cancel is what flips the control back: the
    // thread is `stopped` and its turn is terminal, so the same button is a Delete again.
    const button = actionOf();
    expect(button.classList.contains('thread-stop')).toBe(false);
    expect(button.className).toBe('thread-delete');
    expect(button.querySelector('.action-label')?.textContent).toBe('Delete');
    expect(button.querySelector('.action-glyph')?.textContent).toBe('X');
    expect(button.getAttribute('aria-label')).toBe('Delete thread IN1');
    expect(button.title).toBe('Delete this thread permanently');
    expect(button.disabled).toBe(false);

    // And the delete behaves exactly as it did before R1 on this surface: the shared
    // confirmation first, then the existing DELETE route.
    button.click();
    expect(deleteDialogs()).toHaveLength(1);
    expect(
        deleteDialogs()[0]?.querySelector<HTMLElement>('.thread-delete-confirm-body')?.textContent
    ).toBe('Delete thread IN1 permanently? Its turns and transcript are removed.');

    const confirm = deleteDialogs()[0]?.querySelector<HTMLButtonElement>(
        '.thread-delete-confirm-delete'
    );
    if (confirm === undefined) throw new Error('missing the confirm action');
    confirm.click();
    await flush();
    await flush();

    expect(
        fixture.calls.filter((call) => call.method === 'DELETE')
    ).toEqual([{ url: '/api/sessions/s1/threads/thread-a', method: 'DELETE' }]);
    expect(document.querySelector('.tile')).toBeNull();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.composer-target')?.textContent).toBe('New thread');
});
