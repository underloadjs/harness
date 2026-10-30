// T12b — shell-level conversation grouping.
//
// The pure board projection is pinned in ui/thread-conversation.test.ts. This file
// drives the REAL shell (`main.ts`) through the same composer paths a user takes:
//   - open RR2 and submit while idle -> the new run must appear INSIDE the single
//     RR2 conversation root, after the original prompt/response, not as a second
//     top-level tile;
//   - submit while RR2 is running -> the steered user text appears in that same
//     RR2 conversation;
//   - an unfocused submit opens a separate conversation (RR4), never nested under
//     the previously focused one;
//   - a host-thread root is never an indented `.thread-row`.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts thread-conversation-shell.test.ts

import type { HarnessDescriptor, HarnessEvent, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'researcher',
        title: 'Researcher',
        description: '',
        requiresEndpoint: true,
        agents: ['researcher'],
        tools: [],
        coreTools: [],
        primary: 'researcher',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

type ThreadFixture = {
    id: string;
    agent: string;
    origin: 'host';
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
    invocationId?: string;
    // The server's persisted invocation roster (oldest first), the authoritative
    // join for a card whose original invocation id the single slot no longer names.
    invocationIds?: string[];
    // A runtime CHILD thread names the conversation that owns it.
    ownerThreadId?: string;
};

const message = (agent: string, content: string) => ({
    role: 'assistant' as const,
    content,
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop' as const
});

const turn = (overrides: Partial<SessionTurn> & { id: string; index: number }): SessionTurn => ({
    prompt: 'go',
    status: 'done',
    startedAt: T,
    updatedAt: T,
    events: [],
    ...overrides
});

const snapshot = (
    options: { status?: SessionSnapshot['status']; turns?: SessionTurn[]; threads?: ThreadFixture[] } = {}
): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'researcher',
        status: options.status ?? 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: options.turns ?? [],
        ...(options.threads === undefined ? {} : { threads: options.threads })
    }) as unknown as SessionSnapshot;

// A host-thread run's recorded frames: metadata-only thread identity, exactly the
// shape the runtime emits (no parent/callId/kind/branch).
const hostEvents = (invocation: string, input: string, answer: string, agent = 'researcher'): HarnessEvent[] => [
    { type: 'start', agent, model: 'm1', thread: { id: invocation, input } } as HarnessEvent,
    { type: 'text', agent, delta: answer, thread: { id: invocation } } as HarnessEvent,
    {
        type: 'done',
        agent,
        message: message(agent, answer),
        thread: { id: invocation }
    } as HarnessEvent
];

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

const conversations = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('.turns > .conversation')
];

const composerSubmit = (text: string): void => {
    const input = byClass('.composer-input', 'div');
    input.textContent = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

// Minimal live-shell stub. `submit` decides what POST /tasks answers; the session
// remains the authoritative projection for the following snapshot.
const stubServer = (
    initial: SessionSnapshot,
    submit: (body: Record<string, unknown>) => { session: SessionSnapshot; turn: SessionTurn }
): { initial: SessionSnapshot; submit: typeof submit } => {
    const stub = { initial, submit };
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [stub.initial],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                const answer = stub.submit(body);
                stub.initial = answer.session;
                return json(answer, 202);
            }

            if (url === '/api/sessions/s1/events') {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            stream = controller;
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            if (url === '/api/sessions/s1') return json({ session: stub.initial });
            if (url === '/api/sessions') return json({ sessions: [stub.initial] });

            // The shell may probe thread routes only on explicit actions.
            void stream;
            throw new Error(`unexpected request: ${method} ${url}`);
        })
    );

    return stub;
};

const mount = async (): Promise<void> => {
    await import('./main');
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(SESSION_KEY, 's1');
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('keeps an idle submission INSIDE the open RR2 conversation', async () => {
    const first = turn({
        id: 'turn-1',
        index: 0,
        prompt: 'first prompt',
        threadId: 'thread-1',
        threadLabel: 'RR2',
        events: hostEvents('inv-1', 'first prompt', 'first answer')
    });
    const second = turn({
        id: 'turn-2',
        index: 1,
        prompt: 'test',
        threadId: 'thread-1',
        threadLabel: 'RR2',
        events: hostEvents('inv-2', 'test', 'second answer')
    });

    const stub = stubServer(
        snapshot({
            turns: [first],
            threads: [
                {
                    id: 'thread-1',
                    agent: 'researcher',
                    origin: 'host',
                    status: 'idle',
                    sequence: 1,
                    label: 'RR2',
                    invocationId: 'inv-1'
                }
            ]
        }),
        () => ({ session: snapshot({ turns: [first, second] }), turn: second })
    );

    await mount();
    expect(conversations()).toHaveLength(1);
    expect(conversations()[0].dataset.threadId).toBe('thread-1');

    composerSubmit('test');
    await flush();
    await flush();

    expect(stub.initial.turns.map((entry) => entry.id)).toEqual(['turn-1', 'turn-2']);
    // STILL one top-level conversation: both prompts and both answers are inside it.
    const roots = conversations();
    expect(roots).toHaveLength(1);
    expect(roots[0].querySelectorAll(':scope > .turn-row')).toHaveLength(2);
    expect(
        [...roots[0].querySelectorAll<HTMLElement>('.turn-prompt')].map((node) => node.textContent?.trim())
    ).toEqual(['first prompt', 'test']);
    // R2: ONE card. The container is the visible block (styles.css keeps the frame
    // there and drops it from the exchanges); the first exchange is the header and
    // the follow-up is an ordered continuation of it.
    expect(roots[0].querySelectorAll(':scope > .turn-row > .tile')).toHaveLength(2);
    expect(
        [...roots[0].querySelectorAll<HTMLElement>(':scope > .turn-row')].map((row) =>
            row.classList.contains('is-continuation')
        )
    ).toEqual([false, true]);
    // R1: the thread identity leads the header of the card.
    expect(roots[0].querySelector('.tile-select')?.firstElementChild?.className).toBe('tile-thread');
    expect([...roots[0].querySelectorAll<HTMLElement>('.agent-text')].map((node) => node.textContent)).toEqual([
        'first answer\n',
        'second answer\n'
    ]);
    // The host root is a conversation exchange, never an indented child row.
    expect(document.querySelectorAll('.thread-row')).toHaveLength(0);
});

it('shows a running steer inside RR2 without creating a second row', async () => {
    const owner = turn({
        id: 'turn-1',
        index: 0,
        prompt: 'first prompt',
        status: 'running',
        threadId: 'thread-1',
        threadLabel: 'RR2',
        events: hostEvents('inv-1', 'first prompt', 'working')
    });

    const stub = stubServer(
        snapshot({
            status: 'running',
            turns: [owner],
            threads: [
                {
                    id: 'thread-1',
                    agent: 'researcher',
                    origin: 'host',
                    status: 'running',
                    sequence: 1,
                    label: 'RR2',
                    invocationId: 'inv-1'
                }
            ]
        }),
        () => {
            const steered = {
                ...owner,
                updatedAt: T + 10,
                steers: [{ at: T + 5, prompt: 'test' }],
                status: 'running' as const
            };
            return { session: snapshot({ status: 'running', turns: [steered] }), turn: steered };
        }
    );

    await mount();
    composerSubmit('test');
    await flush();
    await flush();

    expect(stub.initial.turns).toHaveLength(1);
    expect(conversations()).toHaveLength(1);
    expect(conversations()[0].querySelectorAll(':scope > .turn-row')).toHaveLength(1);
    expect(conversations()[0].querySelector('.turn-steer-text')?.textContent).toBe('test\n');
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
});

it('opens a new unfocused submit as an independent RR4 conversation', async () => {
    const turns = [0, 1, 2].map((index) =>
        turn({
            id: `turn-${index + 1}`,
            index,
            prompt: `prompt ${index + 1}`,
            threadId: `thread-${index + 1}`,
            threadLabel: `RR${index + 1}`,
            events: hostEvents(`inv-${index + 1}`, `prompt ${index + 1}`, `answer ${index + 1}`)
        })
    );
    const fourth = turn({
        id: 'turn-4',
        index: 3,
        prompt: 'new conversation',
        threadId: 'thread-4',
        threadLabel: 'RR4',
        events: hostEvents('inv-4', 'new conversation', 'fourth answer')
    });

    const stub = stubServer(
        snapshot({
            turns,
            threads: turns.map((entry, index) => ({
                id: `thread-${index + 1}`,
                agent: 'researcher',
                origin: 'host' as const,
                status: 'idle' as const,
                sequence: index + 1,
                label: `RR${index + 1}`,
                invocationId: `inv-${index + 1}`
            }))
        }),
        () => ({ session: snapshot({ turns: [...turns, fourth] }), turn: fourth })
    );

    await mount();
    expect(conversations().map((host) => host.dataset.threadId)).toEqual([
        'thread-1',
        'thread-2',
        'thread-3'
    ]);

    // Explicit unfocus. The `.thread-strip-unfocus` band is gone (ui/threads.ts no
    // longer builds `.thread-strip*`), so the remaining "New thread" gesture is the
    // tile-header collapse: clicking `.tile-select` of the ALREADY-EXPANDED tile runs
    // ui/turns.ts `collapse` (line ~1527), which sets `explicitUnfocus = true`.
    const expanded = document.querySelector<HTMLElement>('.tile.is-expanded');
    if (expanded === null) throw new Error('missing element .tile.is-expanded');
    const unfocus = expanded.querySelector<HTMLButtonElement>('.tile-select');
    if (unfocus === null) throw new Error('missing element .tile-select');
    unfocus.click();
    await flush();
    // The visible statement of "unfocused": the routing line offers a new thread.
    expect(byClass('.composer-target', 'p').textContent).toBe('New thread');
    composerSubmit('new conversation');
    await flush();
    await flush();

    expect(stub.initial.turns).toHaveLength(4);
    expect(conversations().map((host) => host.dataset.threadId)).toEqual([
        'thread-1',
        'thread-2',
        'thread-3',
        'thread-4'
    ]);
    const rr4 = conversations()[3];
    expect(rr4.querySelector('.tile-thread')?.textContent).toBe('RR4');
    expect(rr4.querySelectorAll(':scope > .turn-row')).toHaveLength(1);
});

it('keeps a focused CHILD follow-up inside that child card', async () => {
    // Owner run delegates to `helper` (runtime invocation `inv-child`, joined by the
    // roster to the persistent conversation `thread-child`).
    const owner = turn({
        id: 'turn-1',
        index: 0,
        prompt: 'owner',
        status: 'running',
        threadId: 'thread-1',
        threadLabel: 'RR1',
        events: [
            { type: 'start', agent: 'researcher', model: 'm1', thread: { id: 'inv-1', input: 'owner' } },
            {
                type: 'tool_call',
                agent: 'researcher',
                call: {
                    id: 'd1',
                    name: 'agentDelegate',
                    arguments: JSON.stringify({ agent: 'helper', input: 'child task' })
                }
            },
            {
                type: 'start',
                agent: 'helper',
                model: 'm1',
                thread: { id: 'inv-child', parentId: 'inv-1', callId: 'd1', input: 'child task' }
            }
        ] as HarnessEvent[]
    });
    const childFollowUp = turn({
        id: 'turn-2',
        index: 1,
        prompt: 'child follow-up',
        status: 'running',
        threadId: 'thread-child',
        threadLabel: 'HL1',
        events: hostEvents('inv-child-2', 'child follow-up', 'child answer', 'helper')
    });

    // The roster is part of EVERY session snapshot (the server reports it with the
    // turn list), and it carries the invocation → persistent-thread join the board
    // needs to place the child's own card.
    const threads: ThreadFixture[] = [
        {
            id: 'thread-1',
            agent: 'researcher',
            origin: 'host',
            status: 'running',
            sequence: 1,
            label: 'RR1',
            invocationId: 'inv-1'
        },
        {
            id: 'thread-child',
            agent: 'helper',
            origin: 'host',
            status: 'idle',
            sequence: 2,
            label: 'HL1',
            ownerThreadId: 'thread-1',
            invocationId: 'inv-child',
            // The server's persisted invocation roster for this conversation. It is
            // what keeps the card joined once the single slot advances.
            invocationIds: ['inv-child']
        }
    ];

    const stub = stubServer(
        snapshot({ status: 'running', turns: [owner], threads }),
        () => ({
            // The POST answer reports the state AFTER the child ran: the runtime moves
            // `invocationId` to the continuation run (src/harness.ts:4536), so the
            // original delegated `inv-child` is no longer the current slot. It survives
            // in the roster's historical `invocationIds` (src/server/sessions.ts
            // `invocationIdsOf`), which is the authoritative join the refresh must use —
            // otherwise the follow-up is ejected out of the card.
            session: snapshot({
                status: 'running',
                turns: [owner, childFollowUp],
                threads: threads.map((entry) =>
                    entry.id === 'thread-child'
                        ? { ...entry, invocationId: 'inv-child-2', invocationIds: ['inv-child', 'inv-child-2'] }
                        : entry
                )
            }),
            turn: childFollowUp
        })
    );

    await mount();

    // Focus the child through its nested card, then submit: the shell sends the
    // child's persistent id, so the server records a REAL turn of that thread.
    const childCard = document.querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
    childCard?.querySelector<HTMLButtonElement>('.thread-select')?.click();
    await flush();
    composerSubmit('child follow-up');
    await flush();
    await flush();

    expect(stub.initial.turns.map((entry) => entry.id)).toEqual(['turn-1', 'turn-2']);

    // ONE top-level card (the owner) and ONE child card — no second `.turn-row`
    // under the owner for the child's follow-up.
    const cards = conversations();
    expect(cards).toHaveLength(1);
    expect(cards[0].dataset.threadId).toBe('thread-1');
    expect(cards[0].querySelectorAll(':scope > .turn-row')).toHaveLength(1);
    expect(cards[0].querySelector('.tile-prompt')?.textContent).toBe('owner');
    expect(document.querySelectorAll('.thread-row')).toHaveLength(1);
    expect(cards[0].querySelector('.turn-row[data-child-thread]')).toBeNull();

    // The follow-up is an exchange INSIDE the child's own card, with its answer.
    const exchanges = [...document.querySelectorAll<HTMLElement>('.thread-flow > .turn-row')];
    expect(
        exchanges.map((row) => [row.dataset.threadExchange, row.querySelector('.tile-prompt')?.textContent])
    ).toEqual([['thread-child', 'child follow-up']]);
    expect(exchanges[0].querySelector('.agent-text')?.textContent).toBe('child answer\n');
    // Focus stays on the child conversation it continued.
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing HL1');
});
