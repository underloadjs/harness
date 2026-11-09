// T24: the LAZY DISPLAY PLANE and the focused-turn flow subscription, wired into the
// real shell (./main.ts), against the canonical mocks.
//
// What this file pins is the payload policy the shell is now responsible for — the
// previous passes built the primitives (`createDisplayLoader`, `createDisplayPlane`,
// the `turn`-scope client) but never attached them to the DOM, so a session open left
// every row outside the fetched tail blank and no `display.ops` frame could reach an
// opened tile at all:
//
//   1. A session open costs 25 ROWS plus the tail trees the open policy allows (10);
//      every other tree is a user action, and the rows that ARE on screen must all get
//      one (no blank history inside the loaded window).
//   2. The plane never exceeds 4 identified reads at once, however many rows are asked
//      for at once (the fan-out cap the loader documents, ./view-api.ts:592).
//   3. History grows ONLY from the button, exactly one issued cursor per press. Boot
//      does not walk it.
//   4. The conversation the reader OPENED is the conversation whose streamed text is
//      followed, on the `turn` scope — the only scope that publishes `display.ops`
//      (../shared/harness-stream.ts:201, harness.swagger.yaml:2429) — and leaving that
//      tile leaves the subscription behind.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts main-lazy-display.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { viewAwareFetch } from './view-test-support';
import { resetHarnessStream } from './stream';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: [],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const turn = (id: string, index: number): SessionTurn =>
    ({
        id,
        index,
        prompt: `task ${index}`,
        status: 'done',
        startedAt: T + index,
        updatedAt: T + index + 1,
        threadId: 'th-a',
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'stop', agent: 'instruct' }
        ]
    }) as SessionTurn;

// A conversation with more turns than one row page, so the difference between "the
// window I loaded" and "the whole history" is observable rather than theoretical.
const conversation = (total: number, actions: readonly unknown[] = []): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: T,
        revision: 4,
        messages: [],
        turns: Array.from({ length: total }, (_, i) => turn(`t${i}`, i)),
        // The owner questions this conversation is still waiting on. The canonical
        // double publishes them as `GET /sessions/{id}/actions`, which is the source
        // the shell's `actionRequestFor` reads.
        actions,
        threads: [
            {
                id: 'th-a',
                agent: 'instruct',
                origin: 'agent',
                status: 'idle',
                sequence: 1,
                messages: [],
                root: true
            }
        ]
    }) as SessionSnapshot;

const bootstrap = (): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents: [{ name: 'instruct', title: 'Instruct', description: '', instruction: '', guidelines: [] }]
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

type DisplayGate = {
    // Every display route the shell asked for, in the order it asked.
    reads: string[];
    // Reads currently held open by the gate.
    inflight(): number;
    // Release the oldest held read (its answer comes from the canonical double).
    release(): void;
};

let gate: DisplayGate | undefined;
let displayRequests: string[] = [];
let turnsRequests: string[] = [];
let stepRequests: string[] = [];

// The one owner question these fixtures publish. `requestId` matches the `callId` the
// compact step carries, which is how the card and the pending action find each other.
const actionRequest = {
    requestId: 'act-1',
    question: 'Pick a lane',
    recommended: 'left',
    options: [
        { id: 'left', label: 'Take the left path' },
        { id: 'right', label: 'Take the right path' }
    ],
    allowCustom: true
};

type ServeOptions = {
    // The tree carries ONE action step with no `action` summary — exactly what the
    // canonical compact wire publishes (`DisplayStep`'s required set is
    // kind/id/turnId/sectionId/name/state, harness.swagger.yaml:6253).
    action?: boolean;
    // The live pending questions this session answers.
    actions?: unknown[];
};

let serveOptions: ServeOptions = {};

// The canonical answer surface, driven off a `SessionSnapshot` fixture exactly like
// the other shell suites: `viewAwareFetch` composes the row pages, the display trees
// and the roster, so every request below is a real `/v1/harness` read.
//
// The recorder wraps the double (rather than sitting inside it) because the double
// answers the row page itself and never consults the stub for it — the outer pass
// sees EVERY URL the shell asks for, which is what makes "one page per press" and
// "no eager traversal" provable.
//
// The display gate holds tree answers open so the CONCURRENCY cap is provable rather
// than incidental: the first `free` answers resolve at once (that half is the open
// policy's own tail), and the rest wait for the test to release them.
const serve = (total: number, free = Number.POSITIVE_INFINITY, options: ServeOptions = {}): void => {
    displayRequests = [];
    turnsRequests = [];
    stepRequests = [];
    serveOptions = options;

    let held: (() => void)[] = [];

    gate = {
        reads: displayRequests,
        inflight: () => held.length,
        release: () => {
            const next = held.shift();
            next?.();
        }
    };

    const fixture = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const bare = url.split('?')[0] ?? url;
        const method = init?.method;

        // The tree route is answered by the stub (not the double) so the held half of
        // the gate has an answer to release, and so one fixture fold cannot dominate
        // the run: `displayOfTurn` re-projects the whole conversation per request.
        if (bare.endsWith('/display') && method === undefined) {
            if (displayRequests.length > free) {
                return new Promise<Response>((resolve) => {
                    held.push(() => resolve(treeOf(bare)));
                });
            }

            return treeOf(bare);
        }

        // The SECOND source: one step detail, answering with the verbatim
        // `action_request` opening event the recorded turn holds. (The live pending
        // questions come from the double itself, which publishes the fixture's
        // `actions` array as `GET /sessions/{id}/actions`.)
        if (/\/turns\/[^/]+\/steps\/[^/]+$/.test(bare) && method === undefined) {
            const [turnId] = bare.split('/turns/')[1]?.split('/') ?? [];

            return json({
                detail: {
                    turnId,
                    stepId: bare.split('/steps/')[1] ?? '7',
                    callId: 'act-1',
                    opening: {
                        index: 7,
                        at: T,
                        event: { type: 'action_request', agent: 'instruct', callId: 'act-1', request: actionRequest }
                    }
                }
            });
        }

        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === undefined) {
            return json({ sessions: [conversation(total, serveOptions.actions ?? [])] });
        }
        if (url === '/api/sessions/s1' && method === undefined) {
            return json({ session: conversation(total, serveOptions.actions ?? []) });
        }

        return undefined;
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const bare = url.split('?')[0] ?? url;

            if (bare.endsWith('/display') && init?.method === undefined) displayRequests.push(bare);

            // The row page is answered here (see `rowsPage`), and the turn/detail routes
            // below are the stub's too; everything else falls through to the double.
            if (bare === '/v1/harness/sessions/s1/turns' && init?.method === undefined) {
                turnsRequests.push(url);

                return rowsPage(url, total);
            }

            if (/\/turns\/[^/]+\/steps\/[^/]+$/.test(bare) && init?.method === undefined) stepRequests.push(bare);

            const answer = fixture(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );
};

// One turn's display tree, in the WIRE spelling the projector reads (`turnId`,
// `sections`, `agentLabel` — ../shared/harness-api.ts display subtree, projected by
// ./display-project.ts:333). The gate answers the held reads itself so a release does
// not need the fixture again.
//
// In `action` mode the section also carries ONE action step, and deliberately NOT its
// `action` summary: that is the canonical compact shape, and it is why the shell has to
// supply the choices from the pending list or the recorded opening event.
const treeOf = (displayRoute: string): Response => {
    const turnId = displayRoute.split('/turns/')[1]?.split('/')[0] ?? 't0';

    return json({
        display: {
            turnId,
            revision: 4,
            sections: [
                {
                    id: `${turnId}:0`,
                    role: 'primary',
                    agent: 'instruct',
                    agentLabel: 'IN',
                    state: 'done',
                    nodes: [{ kind: 'text', id: `${turnId}:n1`, text: `answer ${turnId}`, committed: true }],
                    ...(serveOptions.action === true
                        ? {
                            steps: [
                                {
                                    kind: 'action',
                                    id: '7',
                                    turnId,
                                    sectionId: `${turnId}:0`,
                                    name: 'Pick a lane',
                                    state: 'running',
                                    callId: 'act-1'
                                }
                            ]
                        }
                        : {})
                }
            ]
        }
    });
};

// The row page, answered by the stub instead of the double: `viewOf`/`hostEx` re-projects
// the whole fixture on every session read, and a 26-turn conversation folded twice per
// test was the slowest thing in these suites. The shape is the contract's own row
// (`TurnSummary`): `promptPreview` + `promptChars`, no verbatim prompt, no display subtree
// — which is also what makes "a rows page never carries trees" observable here.
const wireRow = (id: string, index: number): Record<string, unknown> => ({
    id,
    index,
    promptPreview: `task ${index}`,
    promptChars: `task ${index}`.length,
    status: 'done',
    state: 'done',
    updatedAt: T + index,
    threadId: 'th-a',
    sectionCount: 1,
    stepCount: 0,
    activeAgents: [],
    blocks: []
});

// Page 1 (`?limit=25&order=desc`) answers the NEWEST `limit` rows and issues the cursor;
// the cursor page answers what is left and ends the history. Ids are `t{index}`, so the
// newest page is `t{total-1} … t{total-limit}` and the older page is below it.
const rowsPage = (url: string, total: number): Response => {
    const query = new URL(url, 'http://localhost').searchParams;
    const limit = Number(query.get('limit') ?? 25);
    const cursor = query.get('cursor');
    const all = Array.from({ length: total }, (_, index) => wireRow(`t${index}`, index)).reverse();

    const window = cursor === null ? all.slice(0, limit) : all.slice(limit, limit * 2);

    return json({
        items: window,
        limit,
        next_cursor: cursor === null && all.length > limit ? 'older-cursor' : null,
        observed_at: T,
        revision: 4
    });
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

const tiles = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.tile')];

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(SESSION_KEY, 's1');
    document.body.innerHTML = '<div id="app"></div>';
    gate = undefined;
});

afterEach(() => {
    vi.unstubAllGlobals();
    resetHarnessStream();
});

describe('the shell opens a conversation without downloading it', () => {
    it('gives every rendered row inside the loaded window a tree', async () => {
        serve(12);

        await import('./main');
        await flush();
        await flush();

        // One row page. The beginning of history is a CLICK, not a boot behaviour.
        expect(turnsRequests).toEqual(['/v1/harness/sessions/s1/turns?limit=25&order=desc']);

        // 12 rows are on screen, and every one of them has a display tree: 10 from the
        // open policy's own tail and the rest through the plane's visibility pump.
        expect(tiles()).toHaveLength(12);
        expect(displayRequests).toHaveLength(12);
        expect(new Set(displayRequests).size).toBe(12);

        // Each tree is addressed to the session that owns it (no session-less turn route).
        expect(displayRequests.every((route) => route.startsWith('/v1/harness/sessions/s1/turns/'))).toBe(true);
    }, 20_000);

    it('never runs more than four identified tree reads at once', async () => {
        // The first 10 answers resolve on their own — that half is the open policy's
        // tail — and every later read is parked until the test lets it go.
        serve(26, 10);

        await import('./main');
        await flush();
        await flush();

        // The open tail is settled (10 routes), and the pump has admitted exactly the
        // cap for the remaining rows — never all 15 at once.
        expect(displayRequests.slice(0, 10)).toHaveLength(10);
        expect(gate?.inflight()).toBe(4);

        // Releasing one admits exactly one more: the queue drains, it does not fan out.
        gate?.release();
        await flush();

        expect(gate?.inflight()).toBe(4);
    });

    it('asks for nothing older than the window until the reader presses the control', async () => {
        // 26 turns: one full row page (25) plus exactly one row that only a cursor walk
        // can reach — the smallest fixture that can distinguish "the window I loaded"
        // from "the whole history", which keeps the fold cheap under a parallel run.
        serve(26);

        await import('./main');
        await flush();
        await flush();

        expect(turnsRequests).toHaveLength(1);

        const older = byClass('.load-older', 'button');
        expect(older.hidden).toBe(false);
        expect(older.textContent).toBe('Load older messages');

        older.click();
        await flush();

        // What the press bought: EXACTLY one walk of the cursor the server issued, in
        // the spelling the client is allowed to send (`limit`, then the cursor, then the
        // order), and nothing else. The window half of the rule — the prepend keeps
        // recorded order and a spent cursor retires the affordance — is pinned on the
        // plane itself in `lazy-display-main.test.ts`; this file pins the request
        // discipline the shell is responsible for, which is where an eager traversal
        // would show up.
        expect(turnsRequests).toEqual([
            '/v1/harness/sessions/s1/turns?limit=25&order=desc',
            '/v1/harness/sessions/s1/turns?limit=25&cursor=older-cursor&order=desc'
        ]);

        // The older page's rows reached THIS board: the fixture's oldest turn is now one
        // of the rendered rows, and the press cost no third page.
        expect(tiles().some((tile) => tile.dataset.turnId === 't0')).toBe(true);
        expect(turnsRequests).toHaveLength(2);
    }, 60_000);
});

describe('an owner question answers with its recorded choices', () => {
    // The options a card actually offers, in paint order, scoped to the transcript. A
    // read-only card lists them in `.action-options-static`, an answerable one offers
    // radios in `.action-options` (`ui/action-request.ts`) — both spellings use
    // `.action-option-label`, so this reads whatever the card really mounted.
    const optionLabels = (): string[] =>
        [...document.querySelectorAll<HTMLElement>('.tile .action-option-label')].map(
            (node) => node.textContent ?? ''
        );

    it('takes the choices of a live question from the pending actions, with no detail read', async () => {
        serve(1, Number.POSITIVE_INFINITY, {
            action: true,
            actions: [{ request: actionRequest, turn_id: 't0', agent: 'instruct', received_at: T }]
        });

        await import('./main');
        await flush();
        await flush();

        // A loaded conversation starts collapsed; opening the tile is what paints the
        // question card that the reader is now looking at.
        byClass('.tile', 'article').querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();
        await flush();

        // The question the agent asked, and the choices it recorded — verbatim, in the
        // recommended-first order the card owns, with the always-present free-text path.
        expect(document.querySelector('.tile .action-request .action-question')?.textContent).toBe('Pick a lane');
        expect(optionLabels()).toEqual(['Take the left path', 'Take the right path']);

        // Nothing was fetched for a question the session is still waiting on: the live
        // pending list IS the authority, and a settled card is the only lazy reader.
        expect(stepRequests).toEqual([]);
    }, 20_000);

    it('hydrates a settled card from exactly one step-detail read', async () => {
        serve(1, Number.POSITIVE_INFINITY, { action: true, actions: [] });

        await import('./main');
        await flush();
        await flush();

        byClass('.tile', 'article').querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();
        await flush();

        // One read of THIS step, addressed to the session and the step the card came
        // from: the settled question's choices are fetched, never invented.
        expect(stepRequests).toEqual(['/v1/harness/sessions/s1/turns/t0/steps/7']);

        // The read's answer is what the card then offers, without the reader touching
        // anything: the shell's `onActionHydrated` repaint re-paints THIS tile from the
        // compiled document, and the board's stable `turnId|stepId` hydration key means
        // the cached request is still the one this card asks for. The two recorded
        // labels, and nothing the client invented.
        await flush();

        // POSITIVE half of the fix: the card is now built from the RECORDED request —
        // its id is the agent's, its question is the recorded one, and the two recorded
        // choices are on screen, not merely fetched into the board's cache.
        const card = document.querySelector<HTMLElement>('.tile .action-request');

        expect(card?.dataset.requestId).toBe('act-1');
        expect(card?.querySelector('.action-question')?.textContent).toBe('Pick a lane');
        expect(optionLabels()).toEqual(['Take the left path', 'Take the right path']);

        // Every later repaint re-reads NOTHING: the board keeps the hydrated request,
        // and the shell never spends a second detail read on one card.
        stepRequests = [];
        byClass('.tile', 'article').querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();
        byClass('.tile', 'article').querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();

        expect(stepRequests).toEqual([]);
        expect(optionLabels()).toEqual(['Take the left path', 'Take the right path']);
    }, 20_000);
});

describe('the opened tile is the streamed tile', () => {
    // T3: the socket double records SUBSCRIBE frames by id, and an `unsubscribe` frame
    // names only its `subscription_id` — so "which scope was released" is answered by
    // joining the two. Sorted, because the order the shell releases the turn flow and the
    // thread following in is not part of the contract.
    const threadSubscriptions = (stream: { subscriptions: Record<string, unknown>[] }): Record<string, unknown>[] =>
        stream.subscriptions.filter((sub) => sub.scope === 'thread');

    const unsubscribedScopes = (stream: {
        subscriptions: Record<string, unknown>[];
        sent: Record<string, unknown>[];
    }): string[] => {
        const scopeOf = new Map<string, string>(
            stream.subscriptions.map((sub) => [String(sub.subscription_id), String(sub.scope)])
        );

        return stream.sent
            .filter((frame) => frame.type === 'unsubscribe')
            .map((frame) => scopeOf.get(String(frame.subscription_id)) ?? 'unknown')
            .sort();
    };

    it('subscribes to the expanded turn on the turn scope and leaves it on the next expansion', async () => {
        // The socket double and the shell must resolve the SAME `./stream` module
        // instance: `vi.resetModules()` cleared the registry, so a static import would
        // configure the previous instance while `main.ts` dials a fresh one.
        const { installHarnessStream: install } = await import('./view-test-support');
        const stream = install({ sessionId: 's1', snapshot: () => conversation(4) });
        serve(4);

        await import('./main');
        await flush();
        await flush();

        // A LOADED conversation starts collapsed (T21 R22), so nothing is streaming:
        // a fresh `turn` subscription would be the shell guessing at what is read.
        expect(stream.subscriptions.filter((sub) => sub.scope === 'turn')).toHaveLength(0);

        // The row this board paints first, and the row it paints last: the fixture's
        // newest and oldest turn, whichever end of the window each landed on.
        const openedId = tiles()[0]?.dataset.turnId;
        const otherId = tiles()[tiles().length - 1]?.dataset.turnId;

        byClass('.tile', 'article').querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();

        const turnSubs = stream.subscriptions.filter((sub) => sub.scope === 'turn');

        // The contract publishes `display.ops` on the `turn` scope only, so the tile the
        // reader opened is the conversation the shell follows, addressed by both ids.
        expect(turnSubs).toHaveLength(1);
        expect(turnSubs[0]).toMatchObject({ scope: 'turn', session_id: 's1', turn_id: openedId });

        // Closing THAT tile closes its flow: an unsubscribe frame on the same socket,
        // and no second subscription while nothing is expanded. The reader is not
        // watching a collapsed row, so its streamed text is not worth a connection.
        //
        // T3 (R3): collapsing also stops FOLLOWING the conversation itself, so the
        // `thread`-scope registration the expand created is released in the same gesture.
        // Unsubscribe frames name only a `subscription_id`, so the scope is resolved from
        // the subscribe that opened it.
        tiles()[0]?.querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();

        expect(stream.subscriptions.filter((sub) => sub.scope === 'turn')).toHaveLength(1);
        expect(unsubscribedScopes(stream)).toEqual(['thread', 'turn']);

        // T3 (R2): the expanded conversation was followed while it was open, and the
        // collapse released it — the pair below is the whole of that statement.
        expect(threadSubscriptions(stream).map((sub) => sub.thread_id)).toEqual(['th-a']);

        // Opening a different tile moves the subscription to it — exactly one more
        // `turn` subscription, addressed to the row the reader chose. The CONVERSATION is
        // the same one (`th-a`), so following it is re-established once, not duplicated.
        tiles()[tiles().length - 1]?.querySelector<HTMLButtonElement>('.tile-select')?.click();
        await flush();

        expect(stream.subscriptions.filter((sub) => sub.scope === 'turn').map((sub) => sub.turn_id)).toEqual([
            openedId,
            otherId
        ]);
        expect(threadSubscriptions(stream).map((sub) => sub.thread_id)).toEqual(['th-a', 'th-a']);

        // Nothing is released by this gesture: the conversation was collapsed first, so
        // the reader is OPENING, not moving. The two releases above are the whole of it.
        expect(unsubscribedScopes(stream)).toEqual(['thread', 'turn']);
    }, 20_000);
});
