// T38: the four behaviours the canonical directory + live surface must actually deliver.
//
// These are the product rules the shell had broken while the wire moved from the one legacy
// boot document to the composed canonical surface:
//
//   1. BOOT PICKS THE NEWEST CONVERSATION. `GET /sessions` answers `SessionSummary` rows —
//      snake_case stamps, NO turns (../shared/harness-api.ts:807-825). The shell ranks
//      "latest" with `recencyOf` (./main.ts:6809) on `updatedAt`/`createdAt`; those fields
//      only exist after the row is normalized, so an embedded row that was cast instead of
//      mapped ranked every conversation at recency 0 and the page's LAST row won.
//   2. A RESTORED RUNNING CONVERSATION IS WATCHED. `pendingOf` (./main.ts:7350) decides
//      whether `openSession` starts the observer, and the canonical live surface is the
//      `harness.v1` WebSocket (./view-shell.ts `observeView`; ./stream.ts:40-43 states there
//      is no SSE fallback). A row whose `queue_depth` never became `queueDepth` left the
//      session unwatched, which is what "reloaded a running chat and nothing streams" meant.
//   3. THE LIVE FRAME RELEASES THE PENDING LOCK. While work is pending the composer offers
//      STOP; the `session.updated` patch a settled snapshot produces is what clears it. The
//      SESSION SURFACE is deliberately not part of that lock — `+ New session`, the header
//      cycler and the strip pills stay live while the queue works, because leaving a running
//      conversation only unsubscribes the observer (R4); the last case below pins that, and
//      re-attaches the observer on the way back. The case also pins the agent dialog's
//      lifecycle rule the old SSE-shaped fixture could never reach: starting a new conversation
//      dismisses the dialog instead of carrying it into an empty session.
//   4. THE AGENT WRITE USES THE CONTRACT'S FIELD NAMES. `UpdateHarnessRequest`
//      (../shared/harness-api.ts:488-499) is a CLOSED object whose maps are `agent_models`
//      and `agent_instructions`. Test 4 therefore bypasses the view adapter entirely: it
//      asserts the bytes the browser put on the wire, in the contract's own mount and
//      spelling, against an answer shaped like the server's.
//
// The switch block at the end of the directory cases adds the two rules that only a PARKED
// read can prove, because both are about an answer that arrives after the reader moved on:
//
//   5. THE CENTRE COLUMN HAS ONE OWNER: THE NEWEST GESTURE. `openSession`'s record read is
//      async, and the window `+ New session` opens clears the card's pointer and holds it
//      clear until the create answers — the state `applyView` ADOPTS a document in (the
//      remembered-pointer boot needs exactly that). Without the navigation-intent guard
//      (./main.ts `navigationIntent`) a conversation left mid-read re-binds the card from its
//      own late answer: transcript back, pending figure restored, and the pointer overwritten
//      — under T3 that pointer is the id the CREATE was about to install, so the guard now
//      protects an adoption as well as an emptiness. The cases park the browser's own record
//      read (the view adapter answers every other route) so the stale answer can be delivered
//      last.
//   6. A THREAD ID IS ONLY UNIQUE INSIDE ITS CONVERSATION. The runtime mints thread ids per
//      session, so the conversation being LEFT and the one being ENTERED can carry the same
//      id. The last case gives both `thread-1` and asserts that nothing of the first survives
//      into the second — rows, tiles, or the marks that gate a live patch — and that the live
//      plane resumes on the way back.
//
// Run (focused):
//   npx vitest run --config src/frontend/vitest.config.ts canonical-directory-live-main.test.ts

import type { HarnessDescriptor, HarnessEvent, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

// T38: the stream double is resolved by a DYNAMIC import inside each live case, never
// statically. `vi.resetModules()` clears the registry, so a static import would configure the
// PREVIOUS `./stream` module instance while `main.ts` — imported after the reset — dials a
// fresh singleton that has no factory at all. That mismatch is indistinguishable from "the
// shell never subscribed", which is exactly the behaviour these cases assert (the same
// discipline `main-lazy-display.test.ts:521-525` documents). The TYPES are static: they are
// erased at compile time, so they cannot pin a stale instance.
import type { HarnessStreamOptions, StreamDouble } from './view-test-support';

const installLiveStream = (options: HarnessStreamOptions): Promise<StreamDouble> =>
    import('./view-test-support').then((support) => support.installHarnessStream(options));

// The twin of that import: the singleton is process-wide, so the double is released through
// the SAME module instance the shell used, or it leaks into the next file's boot.
const releaseLiveStream = async (): Promise<void> => {
    const { resetHarnessStream } = await import('./stream');

    resetHarnessStream();
};

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };
const SESSION_KEY = 'underload-harness-app:session';
// A fixed stamp for the recorded turns below: the row's elapsed figure is derived from these
// two fields, and a fixed pair keeps it (and therefore the rendered row) deterministic.
const T = 1_700_000_000_000;

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct', 'summarizer'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'tasks', 'delegate'],
        primary: 'instruct',
        subagents: ['summarizer'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents = [
    { name: 'instruct', title: 'Instruct', description: 'General agent.', instruction: 'Answer directly.', guidelines: [] },
    { name: 'summarizer', title: 'Summarizer', description: 'Compresses notes.', instruction: 'Compress notes.', guidelines: [] }
];

// A raw conversation record, in the shape the stubbed server's OWN route answers it; the
// adapter re-expresses it as the compiled document the shell consumes.
const snapshot = (id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id,
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        harnessDefinition: descriptor(),
        ...overrides
    }) as SessionSnapshot;

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

const newSessionButton = (): HTMLButtonElement => byClass('.new-session', 'button');

// One composer send, typed the way the shell's editor is filled (a contenteditable field whose
// `input` event is what the shell reads) and submitted the way a keyboard send does. Used by the
// switch cases to grow a conversation's queue while a record read is parked.
const composerSubmit = (text: string): void => {
    const input = byClass('.composer-input', 'div');

    input.textContent = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

// The Sessions strip of the dialog behind the harness title — the only place the pill strip
// exists (T9/R3), so "does the directory agree with the header?" means "open that layer".
const dashboard = (): HTMLElement => {
    const open = document.querySelector<HTMLElement>('.session-pills-bar-dialog');
    if (open !== null) return open;

    const trigger = document.querySelector<HTMLButtonElement>('.harness-title-button');
    if (trigger === null) throw new Error('missing harness title button');
    trigger.click();

    const bar = document.querySelector<HTMLElement>('.session-pills-bar-dialog');
    if (bar === null) throw new Error('missing session dashboard');

    return bar;
};

const closeDashboard = (): void => {
    const panel = document.querySelector('.session-pills-bar-dialog')?.closest('.dialog');
    panel?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
};

// The session-scope registrations the shell holds on the socket, as `<session_id>:<id>` in the
// order the client dialed them. `s1`/`s2` are the observer and the shared record channel of the
// FIRST open; a second pair after a switch back is what "the observer was re-attached" looks
// like on the wire (./stream.ts mints one id per `subscribe`).
const sessionSubscriptions = (stream: StreamDouble): string[] =>
    stream.subscriptions
        .filter((sub) => sub.scope === 'session')
        .map((sub) => `${String(sub.session_id)}:${String(sub.subscription_id)}`);

// The ids the client explicitly released — an abort of the observer is ONLY this frame (R4),
// which is what distinguishes "left the conversation" from "cancelled the run". SORTED: which of
// the two registrations for a conversation lets go first is an internal ordering detail, while
// WHICH ones went is the fact this test pins.
const unsubscriptions = (stream: StreamDouble): string[] =>
    stream.sent
        .filter((frame) => frame.type === 'unsubscribe')
        .map((frame) => String(frame.subscription_id))
        .sort();

// Every conversation RECORD read (one per `openSession`), in order. The unqualified canonical
// path is what keeps subresources (`/turns`, `/threads`, `/turns/:id/display`, the `?limit=`
// directory page) out of the list.
const CONVERSATION_ROW = /^\/v1\/harness\/sessions\/([^/?]+)$/;
const conversationReads = (calls: { url: string; method: string | undefined }[]): string[] =>
    calls
        .filter((call) => call.method === undefined)
        .map((call) => CONVERSATION_ROW.exec(call.url)?.[1])
        .filter((id): id is string => id !== undefined);

// Session-wide cancellation is the ONE write that stops a run (`POST …/cancel{all}`). If this
// list is empty, nothing on this page cancelled anything.
const cancellations = (calls: { url: string; method: string | undefined }[]): { url: string; method: string | undefined }[] =>
    calls.filter((call) => call.method === 'POST' && call.url.includes('cancel'));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
    // The stream singleton is process-wide (./stream.ts:647): leaving this file's double
    // configured hands the next test file's shell a socket that was never its own.
    await releaseLiveStream();
});

describe('the canonical directory', () => {
    it('opens the conversation the rows say is newest, not the row the page put last', async () => {
        // Three conversations, deliberately out of stamp order: the NEWEST is `s-newest`,
        // while the directory's own order ends on `s-oldest`. A row that was cast into the
        // shell's record instead of normalized ranks 0 (no camel stamps), and a rank-0 walk
        // with `>=` lands on the LAST row — the bug this test exists to keep fixed.
        const rows = [
            snapshot('s-middle', { updatedAt: 200, createdAt: 40 }),
            snapshot('s-newest', { updatedAt: 300, createdAt: 10 }),
            snapshot('s-oldest', { updatedAt: 100, createdAt: 5 })
        ];
        const opened: string[] = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(
                viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const url = String(input);

                    if (url === '/api') {
                        return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: rows, agents });
                    }
                    if (url === '/api/models') return json({ models: ['m1'] });

                    for (const row of rows) {
                        if (url === `/api/sessions/${row.id}`) {
                            opened.push(row.id);

                            return json({ session: row });
                        }
                    }

                    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
                }, { root: '/api' })
            )
        );

        await import('./main');
        await flush();
        await flush();

        // The newest conversation is the one the shell opened — first, and only.
        expect(opened[0]).toBe('s-newest');
        expect([...new Set(opened)]).toEqual(['s-newest']);
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-newest');
    });

    it('watches a restored conversation that is still running, over the canonical stream', async () => {
        const running = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });
        localStorage.setItem(SESSION_KEY, 's-live');
        // The live surface is the `harness.v1` socket; the double records exactly what the
        // shell subscribed to and folds any frame it is given through the server's projector.
        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => running });

        vi.stubGlobal(
            'fetch',
            vi.fn(
                viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const url = String(input);

                    if (url === '/api') {
                        return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: [running], agents });
                    }
                    if (url === '/api/models') return json({ models: ['m1'] });
                    if (url === '/api/sessions/s-live') return json({ session: running });

                    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
                }, { root: '/api' })
            )
        );

        await import('./main');
        await flush();
        await flush();
        await flush();

        // TWO session-scoped subscriptions, both addressed to THIS conversation: the
        // shell's observer, and the ONE shared record-update channel the live panels of
        // T6 register together (./extensions/records-wake.ts) — two panels, one
        // registration, which is the point of the broker. An unnormalized row left
        // `pendingOf` false and the shell never dialed at all.
        expect(stream.subscriptions).toHaveLength(2);
        expect(stream.subscriptions.map((sub) => sub.scope).sort()).toEqual(['session', 'session']);
        expect(stream.subscriptions.every((sub) => sub.session_id === 's-live')).toBe(true);
        expect(stream.status()).toBe('open');

        // The run does NOT lock the session surface: `+ New session` stays live while this
        // conversation works, because starting a second conversation tears down no queue (R4).
        // What the pending state still paints is this conversation's own STOP action.
        expect(newSessionButton().disabled).toBe(false);
        expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
    });

    it('releases the composer pending state on the live frame that settles the run', async () => {
        // The conversation as the SERVER holds it. A settled frame is followed by a header
        // re-read (`session.updated` reconciles through `GET /sessions/:id`,
        // ./view-shell.ts:515-529), so the document and the frame have to move together —
        // exactly what a real server does, and what makes "pending cleared" a fact about the
        // shell rather than about a fixture that never changed its answer.
        let current = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });
        localStorage.setItem(SESSION_KEY, 's-live');
        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => current });
        // T3 (R1): the `+` near the bottom of this case CREATES a conversation, so the fixture
        // answers the create (and the new row) instead of letting the press fail.
        const made = snapshot('made-1', { updatedAt: 900, createdAt: 900, turns: [] });

        vi.stubGlobal(
            'fetch',
            vi.fn(
                viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                    const url = String(input);

                    if (url === '/api') {
                        return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: [current], agents });
                    }
                    if (url === '/api/models') return json({ models: ['m1'] });
                    if (url === '/api/sessions/s-live') return json({ session: current });
                    if (url === '/api/sessions' && init?.method === 'POST')
                        return json({ session: made }, 201);
                    if (url === '/api/sessions/made-1') return json({ session: made });

                    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
                }, { root: '/api' })
            )
        );

        await import('./main');
        await flush();
        await flush();
        await flush();

        // The pending state is THIS conversation's STOP action. `+ New session` is live from
        // the first paint and stays live right up to the settled frame below (R4).
        expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
        expect(newSessionButton().disabled).toBe(false);

        // The settled document: the same conversation, now idle. The double turns that raw
        // frame into the `session.updated` patch the real server puts on the wire, and the
        // header re-read that follows answers from the document the server now holds.
        current = snapshot('s-live', { status: 'idle', updatedAt: 900, createdAt: 1, turns: [] });
        stream.push([{ type: 'snapshot', session: current }]);
        await flush();
        await flush();

        // The settled frame releases the composer's stop state — the pending figure is still
        // derived from THIS conversation, which is the lock that remains. `+ New session` was
        // live throughout, and the agent dialog that belongs to the conversation being left is
        // dismissed by starting a fresh one.
        expect(byClass('.composer-action', 'button').dataset.action).toBe('none');
        expect(newSessionButton().disabled).toBe(false);

        byClass('.agent-control-button', 'button').click();
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);

        newSessionButton().click();
        await flush();

        expect(document.querySelector('.dialog')).toBeNull();
    });

    // R1/R2/R3 of "sessions are independent": a run in ONE conversation must not lock the
    // session surface, and leaving a working conversation must be a pure view change.
    it('switches away from a running conversation without cancelling it, and re-attaches the observer on the way back', async () => {
        // Two conversations of the SAME harness: `s-live` holds work, `s-idle` holds none. The
        // directory order IS the header cycler's walk, so the route this test drives is exactly
        // s-live → s-idle → s-live (the list wraps), starting from the remembered pointer.
        let live = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });
        const idle = snapshot('s-idle', { updatedAt: 400, createdAt: 2, turns: [] });

        localStorage.setItem(SESSION_KEY, 's-live');

        // The socket double answers for `s-live` only; `s-idle` is idle, so the shell never
        // dials an observer for it and the double records exactly what was (un)subscribed.
        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => live });

        // The log is taken OUTSIDE the adapter (the browser's own URL), so "no cancellation
        // left this page" is a statement about the wire the client produced.
        const answer = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') {
                return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: [live, idle], agents });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [live, idle] });
            if (url === '/api/sessions/s-live') return json({ session: live });
            if (url === '/api/sessions/s-idle') return json({ session: idle });

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' });

        const calls: { url: string; method: string | undefined }[] = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                calls.push({ url: String(input), method: init?.method });

                return answer(input, init);
            })
        );

        await import('./main');
        await flush();
        await flush();
        await flush();

        const cycle = byClass('.session-cycle', 'button');
        const action = byClass('.composer-action', 'button');

        // 1. The pending state that REMAINS is the running conversation's own: the composer
        //    offers STOP, and the observer is open on the socket (one session-scope
        //    registration for the shell's observer, one for the shared record channel).
        expect(cycle.dataset.sessionId).toBe('s-live');
        expect(action.dataset.action).toBe('stop');
        expect(sessionSubscriptions(stream)).toEqual(['s-live:s1', 's-live:s2']);

        // 2. R1/R2: a run locks NONE of the session controls. The cycler is enabled and its
        //    tooltip offers the switch rather than blaming the run; so are BOTH dashboard pills
        //    and the header `+`.
        expect(cycle.disabled).toBe(false);
        expect(cycle.title).toBe('instruct · running · s-live · click to switch');
        expect(newSessionButton().disabled).toBe(false);

        const strip = dashboard();
        expect(strip.querySelector<HTMLElement>('.session-pill-select[data-session-id="s-live"]')?.disabled).toBe(false);
        expect(strip.querySelector<HTMLElement>('.session-pill-select[data-session-id="s-idle"]')?.disabled).toBe(false);
        closeDashboard();

        // 3. R1: the press really switches — one record read, the pointer moves, and the
        //    conversation on screen is the idle one.
        cycle.click();
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('s-idle');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-idle');
        expect(conversationReads(calls)).toEqual(['s-live', 's-idle']);

        // 4. R3: the pending figure is derived from the SELECTED conversation, so an idle one
        //    leaves the composer fully usable — no STOP action and no stop-all button.
        expect(action.dataset.action).toBe('none');
        expect(byClass('.composer-stop', 'button').hidden).toBe(true);

        // 5. R3: leaving was an UNSUBSCRIBE and nothing else. Both registrations for `s-live`
        //    said goodbye on the socket, no `POST …/cancel` was sent, and the directory still
        //    states that conversation as running (it was never touched).
        expect(unsubscriptions(stream)).toEqual(['s1', 's2']);
        expect(cancellations(calls)).toEqual([]);
        expect(dashboard().querySelector<HTMLElement>('.session-pill[data-session-id="s-live"]')?.dataset.status).toBe(
            'running'
        );
        closeDashboard();

        // 6. R3: coming back re-attaches. The walk wraps to `s-live`, its live state is painted
        //    again (STOP), and the observer is dialled a SECOND time on the same socket. The
        //    registration the idle conversation needed (`s-idle:s3`) sits between the two pairs:
        //    a conversation with no queue gets the record channel only, never an observer.
        cycle.click();
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('s-live');
        expect(action.dataset.action).toBe('stop');
        expect(sessionSubscriptions(stream)).toEqual([
            's-live:s1',
            's-live:s2',
            's-idle:s3',
            's-live:s4',
            's-live:s5'
        ]);
        // Everything the idle conversation held was released on the way back out of it.
        expect(unsubscriptions(stream)).toEqual(['s1', 's2', 's3']);

        // The re-opened observer is LIVE, not merely present: the settled document pushed now
        // lands in the reopened conversation and releases its stop state.
        live = snapshot('s-live', { status: 'idle', updatedAt: 900, createdAt: 1, turns: [] });
        expect(stream.push([{ type: 'snapshot', session: live }])).toBe(true);
        await flush();
        await flush();

        expect(action.dataset.action).toBe('none');
        // Through the whole walk the run was never cancelled.
        expect(cancellations(calls)).toEqual([]);
    });

    // R2 of "sessions are independent": the header `+` is the other half of the lock that
    // was removed. It must be clickable while a run is live, and it must actually PROCEED —
    // the old code answered this gesture with a pane notice telling the reader to cancel their
    // own task first. T3 (R1) changed what "proceed" means: the press now CREATES a server
    // record and adopts it, so the new conversation is on screen with its own id, the run that
    // was left is still uncancelled on the wire, and a late frame for it cannot resurrect it.
    it('creates a fresh conversation while another is still running, without cancelling it or a notice', async () => {
        let live = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });

        localStorage.setItem(SESSION_KEY, 's-live');

        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => live });

        // The created record joins the readable set, exactly as a real server's new row does.
        const records = [live];
        const creates: { url: string; harness: unknown; settings: unknown }[] = [];

        const answer = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') {
                return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: records, agents });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: records });
            if (url === '/api/sessions/s-live') return json({ session: live });

            // T3: the create. A POST on the DIRECTORY path, answered with a fresh id and no
            // turns — and the method is the only thing distinguishing it from the list read.
            if (url === '/api/sessions' && init?.method === 'POST') {
                const body = init.body === undefined ? {} : JSON.parse(String(init.body));

                creates.push({
                    url: '/api/sessions',
                    harness: (body as { harness?: unknown }).harness,
                    settings: (body as { settings?: unknown }).settings
                });
                const created = snapshot('made-1', { updatedAt: 900, createdAt: 900, turns: [] });
                records.push(created);

                return json({ session: created }, 201);
            }
            if (url === '/api/sessions/made-1') {
                const created = records.find((row) => row.id === 'made-1');

                return created === undefined
                    ? json({ error: { message: 'unknown session' } }, 404)
                    : json({ session: created });
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' });

        const calls: { url: string; method: string | undefined }[] = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                calls.push({ url: String(input), method: init?.method });

                return answer(input, init);
            })
        );

        await import('./main');
        await flush();
        await flush();
        await flush();

        // The conversation is on screen, working, and its composer says so. The create control
        // next to the cycler is enabled anyway.
        expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
        expect(newSessionButton().disabled).toBe(false);

        newSessionButton().click();
        await flush();
        await flush();

        // T3 (R1): it PROCEEDED by CREATING. Exactly one conversation write, addressed to the
        // collection route, carrying the harness and the current endpoint settings — which is
        // why the create is eager at all: the record exists (and is configurable) before the
        // first task.
        expect(creates).toEqual([
            {
                url: '/api/sessions',
                harness: 'instruct',
                settings: { base_url: 'http://provider/v1', api_key: '', model: 'm1' }
            }
        ]);
        // The card adopted the SERVER-assigned id: the cycler names it, and it is the pointer.
        expect(byClass('.session-cycle', 'button').hidden).toBe(false);
        expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('made-1');
        expect(localStorage.getItem(SESSION_KEY)).toBe('made-1');
        // The pending figure was released with the conversation that owned it: a fresh 0-turn
        // record has no work, so the composer is back to SEND.
        expect(byClass('.composer-action', 'button').dataset.action).toBe('none');
        expect(byClass('.composer-stop', 'button').hidden).toBe(true);
        // The `+` stays live for a second fresh conversation, and the archived-harness rule
        // below it is untouched (the harness is registered, so nothing dims).
        expect(newSessionButton().disabled).toBe(false);

        // The refusal notice the removed guard used to paint is NOT on screen: an empty session
        // has no outcome to report, so the note stays hidden.
        expect(document.querySelector('.session-note')?.hasAttribute('hidden')).toBe(true);

        // Leaving was still an unsubscribe only: no cancellation on the wire, the shared socket
        // stayed open, and the conversation the reader left is still listed as running.
        expect(cancellations(calls)).toEqual([]);
        expect(unsubscriptions(stream)).toEqual(['s1', 's2']);
        expect(stream.status()).toBe('open');
        expect(dashboard().querySelector<HTMLElement>('.session-pill[data-session-id="s-live"]')?.dataset.status).toBe(
            'running'
        );
        // T3: the directory shows BOTH conversations now, and the ACTIVE one is the record the
        // create made — the run that is still going is merely listed.
        expect(dashboard().querySelectorAll('.session-pill')).toHaveLength(2);
        expect(
            dashboard().querySelector('.session-pill[data-session-id="made-1"] .session-pill-select')
                ?.dataset.active
        ).toBe('true');
        closeDashboard();

        // And the run is still live on the socket: a frame pushed after the new session lands
        // must not resurrect the conversation that was left (no STOP reappearing) and must not
        // move the card off the conversation its reader created.
        live = snapshot('s-live', { status: 'idle', updatedAt: 900, createdAt: 1, turns: [] });
        expect(stream.push([{ type: 'snapshot', session: live }])).toBe(true);
        await flush();
        await flush();

        expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('made-1');
        expect(localStorage.getItem(SESSION_KEY)).toBe('made-1');
        expect(byClass('.composer-action', 'button').dataset.action).toBe('none');
    });
});

describe('the conversation switch', () => {
    // A parked `GET /v1/harness/sessions/:id` is the only way to observe the window an open
    // runs in: every case below is about an answer that arrives AFTER the reader's newest
    // gesture. The park is installed on the BROWSER url, before the view adapter translates
    // it, so the fixture stays the plain raw-snapshot server the other cases use.
    const parkedRead = (): { response: Promise<Response>; release: (body: Response) => void } => {
        let release!: (body: Response) => void;
        const response = new Promise<Response>((resolve) => {
            release = resolve;
        });

        return { response, release };
    };

    // The rows the transcript ACTUALLY shows, as the pair of ids the row is keyed by plus the
    // prompt it prints. Turn ids are unique per conversation; thread ids are NOT, because a
    // thread id is minted per session and the next conversation may hand out the same one —
    // that asymmetry is what the switch has to survive (R3).
    const transcriptRows = (): { id: string; thread: string | undefined; prompt: string | null }[] =>
        [...document.querySelectorAll<HTMLElement>('.turns .tile')].map((tile) => ({
            id: String(tile.dataset.turnId),
            thread: tile.dataset.threadId,
            prompt: tile.querySelector('.tile-prompt')?.textContent ?? null
        }));

    // The prose rendered in the transcript column (`div.stage`, the surface `selectHarness`
    // fills with the selected conversation's view). Used only for presence/absence of a
    // conversation's OWN answer text, which is the fact a switch has to get right.
    const stageText = (): string => byClass('div.stage', 'div').textContent ?? '';

    // A recorded run in the shape the runtime persists it: `threadId` is the PERSISTENT
    // conversation the turn executed in, minted per session, so two different sessions can
    // carry the SAME thread id while their turn ids differ. That collision is what the switch
    // has to survive; the root `start` frame names the same conversation for the fold.
    const recordedTurn = (
        id: string,
        prompt: string,
        answer: string,
        status: 'running' | 'done',
        threadId: string
    ): SessionTurn => {
        const events: HarnessEvent[] = [
            { type: 'start', agent: 'instruct', model: 'm1', thread: { id: threadId, input: prompt } } as HarnessEvent,
            { type: 'text', agent: 'instruct', delta: answer, thread: { id: threadId } } as HarnessEvent
        ];

        if (status === 'done') {
            events.push({
                type: 'done',
                agent: 'instruct',
                message: {
                    role: 'assistant',
                    content: answer,
                    reasoning: '',
                    toolCalls: [],
                    model: 'm1',
                    stopReason: 'stop'
                },
                thread: { id: threadId }
            } as HarnessEvent);
        }

        return { id, index: 0, prompt, status, threadId, startedAt: T, updatedAt: T, events };
    };

    // The one fetch double these cases share: the raw documents, every route answered, and a
    // log of the BROWSER urls so a case can name the reads the shell itself dialled. `park`
    // names the conversation whose record read must not answer yet, and `extra` answers the
    // writes a case needs beyond the plain read surface (a task receipt, a cancel).
    //
    // T3 (R1): the `+` is one of those writes now, so the double answers `POST /sessions`
    // itself with a fresh 0-turn record under the harness the BODY names (`made-1`, `made-2`,
    // …) and joins it to the readable set. `creates` is the log the `+` cases assert — the
    // create is a POST on the directory's OWN path, so only the method tells them apart.
    const serve = (
        rows: SessionSnapshot[],
        park: string | undefined,
        extra?: (url: string, init?: RequestInit) => Response | undefined
    ): {
        response: Promise<Response>;
        release: (body: Response) => void;
        calls: { url: string; method: string | undefined }[];
        creates: { url: string; harness: unknown }[];
    } => {
        const parked = parkedRead();
        const records = [...rows];
        const creates: { url: string; harness: unknown }[] = [];
        let made = 0;

        const answer = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            const handled = extra?.(url, init);
            if (handled !== undefined) return handled;

            if (url === '/api') {
                return json({ rootPath: '/api', presets: [descriptor()], tools: [], defaults, sessions: records, agents });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: records });

            if (url === '/api/sessions' && init?.method === 'POST') {
                const body = init.body === undefined ? {} : JSON.parse(String(init.body));
                const harness = String((body as { harness?: unknown }).harness ?? '');
                made += 1;
                creates.push({ url: '/api/sessions', harness });
                const created = snapshot(`made-${made}`, { harness, updatedAt: 900, createdAt: 900, turns: [] });
                records.push(created);

                return json({ session: created }, 201);
            }

            for (const row of records) {
                if (url === `/api/sessions/${row.id}`) return json({ session: row });
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' });

        const calls: { url: string; method: string | undefined }[] = [];

        // ONE-SHOT on purpose: a `Response` body is single-use, so the parked answer is spent
        // on the read the case releases. Every later read of that row goes back to the fixture,
        // which is what lets a case press the same pill a second time and expect the SECOND
        // open to really bind.
        let parking = park;

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);

                calls.push({ url, method: init?.method });

                if (parking !== undefined && url === `/v1/harness/sessions/${parking}`) {
                    parking = undefined;

                    return parked.response;
                }

                return answer(input, init);
            })
        );

        return { ...parked, calls, creates };
    };

    // R3: an open that is still in flight when the reader presses `+` must be DROPPED, not
    // painted. This is the race the removed run lock used to hide by accident, re-derived for
    // the eager create (T3): `newSession` clears the card's pointer and holds it clear for the
    // whole window the create request is open, and a document that arrives for a pointer-free
    // card is ADOPTED — transcript back, pending figure restored, and the pointer written back
    // over the one the create is about to install. The guard has to win twice over: against
    // the released conversation, and against the record the `+` adopted AFTER that open was
    // already superseded.
    it('drops the conversation a released card answers with after the reader pressed `+`', async () => {
        const live = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });
        const parkedRow = snapshot('s-parked', { updatedAt: 400, createdAt: 2, turns: [] });

        localStorage.setItem(SESSION_KEY, 's-live');

        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => live });
        const { response, release, calls, creates } = serve([live, parkedRow], 's-parked');

        await import('./main');
        await flush();
        await flush();
        await flush();

        const cycle = byClass('.session-cycle', 'button');
        const action = byClass('.composer-action', 'button');

        // The running conversation is on screen: STOP is its own action, and the observer is
        // dialled (one registration for the shell, one for the shared record channel).
        expect(cycle.dataset.sessionId).toBe('s-live');
        expect(action.dataset.action).toBe('stop');
        expect(sessionSubscriptions(stream)).toEqual(['s-live:s1', 's-live:s2']);

        // 1. The pill press dials the record read, and that read stays unserved. A run locks
        //    no session control, so the `+` the next step needs is enabled RIGHT NOW.
        dashboard().querySelector<HTMLElement>('.session-pill-select[data-session-id="s-parked"]')?.click();
        closeDashboard();
        await flush();

        expect(conversationReads(calls)).toEqual(['s-live', 's-parked']);
        // Nothing painted from the parked read: the card still names `s-live`.
        expect(cycle.dataset.sessionId).toBe('s-live');
        expect(newSessionButton().disabled).toBe(false);

        // 2. T3 (R1): the reader presses `+`, and the press CREATES a conversation — one POST,
        //    and the card adopts the id the server assigned. The superseded `s-parked` open is
        //    still unserved at this moment, which is the whole point of the case.
        creates.length = 0;
        newSessionButton().click();
        await flush();
        await flush();

        expect(creates).toEqual([{ url: '/api/sessions', harness: 'instruct' }]);
        expect(cycle.dataset.sessionId).toBe('made-1');
        expect(localStorage.getItem(SESSION_KEY)).toBe('made-1');
        // An empty conversation has no pending work, so the STOP of the conversation the reader
        // left is gone with it (R4: leaving is an unsubscribe, never a cancellation).
        expect(action.dataset.action).toBe('none');
        // The create is a POST on the directory's own path, so the READ count must not move:
        // only the method distinguishes them, and `conversationReads` names it.
        expect(conversationReads(calls)).toEqual(['s-live', 's-parked']);

        // 3. NOW the parked answer lands — the oldest gesture on the page. It is discarded:
        //    the card keeps the conversation the `+` created, and the pointer the create
        //    installed is never written back with the conversation the reader let go.
        release(json({ session: parkedRow }));
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('made-1');
        expect(localStorage.getItem(SESSION_KEY)).toBe('made-1');
        expect(action.dataset.action).toBe('none');
        // The open never bound anything: no registration for `s-parked` was ever dialled. The
        // only session-scope facts on the socket are the two `s-live` ones `+` had already
        // released (an unsubscribe, not a cancel) plus the record channel of the conversation
        // the create adopted — which `+` had already released with an unsubscribe, not a cancel.
        expect(sessionSubscriptions(stream)).toEqual(['s-live:s1', 's-live:s2', 'made-1:s3']);
        expect(unsubscriptions(stream)).toEqual(['s1', 's2']);
        expect(cancellations(calls)).toEqual([]);

        // 4. The guard is not sticky: the same pill press after the drop really does open it.
        dashboard().querySelector<HTMLElement>('.session-pill-select[data-session-id="s-parked"]')?.click();
        closeDashboard();
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('s-parked');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-parked');
        // An idle conversation gets the record channel only, never an observer. The log is the
        // registrations this page has ever dialled, so the create's `made-1` channel is still
        // named in it (released, not erased) — and `s-parked` is the newest one.
        expect(sessionSubscriptions(stream)).toEqual(['s-live:s1', 's-live:s2', 'made-1:s3', 's-parked:s4']);
    });

    // R3: two rapid conversation clicks resolve by the LAST CLICK, not by the last ANSWER. The
    // reader pressed s-second, then s-third; the first press's record read is the one still
    // parked, so it is the one that arrives last and would otherwise repaint the card.
    it('keeps the last conversation click when an older open answers after it', async () => {
        const first = snapshot('s-first', {
            updatedAt: 300,
            createdAt: 1,
            turns: [recordedTurn('t-first', 'first prompt', 'first answer', 'done', 'thread-1')]
        });
        const second = snapshot('s-second', {
            updatedAt: 200,
            createdAt: 2,
            turns: [recordedTurn('t-second', 'second prompt', 'second answer', 'done', 'thread-1')]
        });
        const third = snapshot('s-third', {
            updatedAt: 100,
            createdAt: 3,
            turns: [recordedTurn('t-third', 'third prompt', 'third answer', 'done', 'thread-1')]
        });

        // `s-second` is the press that gets parked; `s-third` is the press that follows it.
        const { response, release, calls } = serve([first, second, third], 's-second');

        await import('./main');
        await flush();
        await flush();
        await flush();

        const cycle = byClass('.session-cycle', 'button');

        // Boot picks the newest conversation, and its row is the only one on screen.
        expect(cycle.dataset.sessionId).toBe('s-first');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-first');
        expect(transcriptRows()).toEqual([{ id: 't-first', thread: 'thread-1', prompt: 'first prompt' }]);
        expect(stageText()).toContain('first answer');

        dashboard().querySelector<HTMLElement>('.session-pill-select[data-session-id="s-second"]')?.click();
        closeDashboard();
        await flush();

        dashboard().querySelector<HTMLElement>('.session-pill-select[data-session-id="s-third"]')?.click();
        closeDashboard();
        await flush();
        await flush();

        // The second press won the card, in click order, with its OWN single row.
        expect(conversationReads(calls)).toEqual(['s-first', 's-second', 's-third']);
        expect(cycle.dataset.sessionId).toBe('s-third');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-third');
        expect(transcriptRows()).toEqual([{ id: 't-third', thread: 'thread-1', prompt: 'third prompt' }]);
        expect(stageText()).toContain('third answer');
        expect(stageText()).not.toContain('first answer');

        // The parked answer arrives LAST and is older than the click that beat it, so it never
        // touches the card: no `t-second` row, and the pointer still names `s-third`.
        release(json({ session: second }));
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('s-third');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-third');
        expect(transcriptRows()).toEqual([{ id: 't-third', thread: 'thread-1', prompt: 'third prompt' }]);
        expect(stageText()).not.toContain('second answer');
    });

    // R3: re-pointing the observer is housekeeping, NOT a navigation gesture, so it must not
    // supersede an open the reader is waiting for. The reachable shape of that race: a pill press
    // parks on its record read (and its own teardown releases the conversation's observer), then a
    // submit for the conversation still on screen is accepted and its receipt re-dials that
    // observer through `startWatching` — an internal socket move that used to raise a navigation
    // intent and silently drop the parked open.
    it('lets the in-flight open land when a submit re-points the observer underneath it', async () => {
        // The working conversation owns the observer and starts with no rows; the OTHER one
        // carries a row of its own, so "the open landed" is a fact about the transcript and not
        // only about a pointer.
        const live = snapshot('s-live', { status: 'running', updatedAt: 500, createdAt: 1, turns: [] });
        const target = snapshot('s-target', {
            updatedAt: 400,
            createdAt: 2,
            turns: [recordedTurn('t-target', 'target prompt', 'target answer', 'done', 'thread-1')]
        });
        // The task this submit gets accepted: a second turn of the SAME running conversation,
        // which is how the queue grows. Its thread id is deliberately NOT the one `s-target`
        // mints, so a leaked row from either side is visible in the row list.
        const queued = recordedTurn('t-queued', 'another task', 'working', 'running', 'thread-9');

        localStorage.setItem(SESSION_KEY, 's-live');

        const stream = await installLiveStream({ sessionId: 's-live', snapshot: () => live });
        const { release, calls } = serve([live, target], 's-target', (url, init) =>
            url === '/api/sessions/s-live/tasks' && init?.method === 'POST'
                ? json({ session: live, turn: queued }, 202)
                : undefined
        );

        await import('./main');
        await flush();
        await flush();
        await flush();

        const cycle = byClass('.session-cycle', 'button');
        const action = byClass('.composer-action', 'button');

        // The running conversation is on screen with its observer open, and it has no rows yet.
        // `s1` is the record channel the open view keeps while its conversation is on screen and
        // `s2` is that conversation's observer (`startWatching`), so this is the state an ordinary
        // mid-run screen is in. The list a `StreamDouble` keeps is CUMULATIVE: it names every
        // registration this page ever made, and `unsubscriptions` below names which went.
        expect(cycle.dataset.sessionId).toBe('s-live');
        expect(action.dataset.action).toBe('stop');
        expect(transcriptRows()).toEqual([]);
        expect(sessionSubscriptions(stream)).toEqual(['s-live:s1', 's-live:s2']);

        // 1. The pill press parks on the record read, so the card is still `s-live`'s. The open's
        //    own teardown released the observer, which is what leaves the conversation in the state
        //    the submit below finds: work pending, no observer, so the receipt has to re-dial one.
        dashboard().querySelector<HTMLElement>('.session-pill-select[data-session-id="s-target"]')?.click();
        closeDashboard();
        await flush();

        expect(conversationReads(calls)).toEqual(['s-live', 's-target']);
        expect(cycle.dataset.sessionId).toBe('s-live');
        expect(unsubscriptions(stream)).toEqual(['s2']);

        // 2. A submit goes to the conversation still on screen (its queue is what grows), and its
        //    receipt re-dials that conversation's stream — the internal re-point this case is about.
        composerSubmit('another task');
        await flush();
        await flush();

        // One observer, not two: `s4` is the re-dialled session registration for `s-live`, and the
        // accepted task's display channel took `s3`, which is why the session-scope ids are not
        // consecutive. The re-point had nothing of its own to release (the parked open had already
        // released `s2`), so the release list is unchanged — no subscription was dropped and none
        // was left open twice.
        expect(sessionSubscriptions(stream)).toEqual(['s-live:s1', 's-live:s2', 's-live:s4']);
        expect(unsubscriptions(stream)).toEqual(['s2']);
        // The submitted row is on screen, and the parked read has still painted nothing.
        expect(cycle.dataset.sessionId).toBe('s-live');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-live');
        expect(stageText()).toContain('another task');

        // 3. The parked answer arrives. The re-point recorded no intent, so the reader's click
        //    still wins: the pointer moves, the clicked conversation's row is the ONLY row, and
        //    the submitted row went with the conversation it belongs to.
        release(json({ session: target }));
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('s-target');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-target');
        expect(transcriptRows()).toEqual([{ id: 't-target', thread: 'thread-1', prompt: 'target prompt' }]);
        expect(stageText()).toContain('target answer');
        expect(stageText()).not.toContain('another task');
        expect(action.dataset.action).toBe('none');
        // Nothing was left subscribed behind the switch. Every registration made for `s-live` is
        // released — `s1`/`s2` (the boot pair), `s3` (the queued task's display channel) and `s4`
        // (the observer the submit re-dialled) — and the only session registration still open belongs
        // to the conversation now on screen. `s6`/`s7` are the display channels this read opened for
        // the queued task and then for the newest recorded turn; both were released as their display
        // ended, and nothing on this page cancelled a run.
        expect(sessionSubscriptions(stream)).toEqual(['s-live:s1', 's-live:s2', 's-live:s4', 's-target:s5']);
        expect(unsubscriptions(stream)).toEqual(['s1', 's2', 's3', 's4', 's6', 's7']);
        expect(cancellations(calls)).toEqual([]);
    });

    // R3 (the gap this rule exists to close): thread ids are minted per conversation, so the
    // conversation the reader is LEAVING and the one they are entering can name the SAME
    // thread. Nothing of the first may survive into the second — rows, tiles, marks — and the
    // observer must resume on the way back.
    it('replaces every row of the conversation it left when both conversations mint the same thread id', async () => {
        // Both conversations mint `thread-1`; only their turn ids and their prose differ. The
        // first one is WORKING, so it is the conversation the observer belongs to.
        let live = snapshot('s-busy', {
            status: 'running',
            updatedAt: 500,
            createdAt: 1,
            turns: [recordedTurn('t-busy', 'prompt alpha', 'answer alpha', 'running', 'thread-1')]
        });
        const quiet = snapshot('s-quiet', {
            updatedAt: 400,
            createdAt: 2,
            turns: [recordedTurn('t-quiet', 'prompt bravo', 'answer bravo', 'done', 'thread-1')]
        });

        localStorage.setItem(SESSION_KEY, 's-busy');

        const stream = await installLiveStream({ sessionId: 's-busy', snapshot: () => live });
        const { calls } = serve([live, quiet], undefined);

        await import('./main');
        await flush();
        await flush();
        await flush();

        const cycle = byClass('.session-cycle', 'button');
        const action = byClass('.composer-action', 'button');

        // A. The working conversation owns the card: one row, its own; its answer on screen;
        //    nothing of the conversation that was never opened.
        expect(cycle.dataset.sessionId).toBe('s-busy');
        expect(action.dataset.action).toBe('stop');
        expect(transcriptRows()).toEqual([{ id: 't-busy', thread: 'thread-1', prompt: 'prompt alpha' }]);
        expect(stageText()).toContain('answer alpha');
        expect(stageText()).not.toContain('answer bravo');
        expect(sessionSubscriptions(stream)).toEqual(['s-busy:s1', 's-busy:s3']);

        // B. Away: the OTHER conversation mints the SAME thread id, and it is the only thing
        //    the transcript now holds. The pending figure moves with the selection, so an idle
        //    conversation leaves no STOP.
        dashboard().querySelector<HTMLElement>('.session-pill-select[data-session-id="s-quiet"]')?.click();
        closeDashboard();
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('s-quiet');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-quiet');
        expect(transcriptRows()).toEqual([{ id: 't-quiet', thread: 'thread-1', prompt: 'prompt bravo' }]);
        expect(stageText()).toContain('answer bravo');
        expect(stageText()).not.toContain('answer alpha');
        expect(action.dataset.action).toBe('none');
        expect(unsubscriptions(stream)).toEqual(['s1', 's3']);

        // C. Back: every row of `s-quiet` is gone — the shared thread id must not have let the
        //    idle conversation's row or marks survive under `s-busy` — and the working
        //    conversation is working again, on a SECOND pair of registrations.
        dashboard().querySelector<HTMLElement>('.session-pill-select[data-session-id="s-busy"]')?.click();
        closeDashboard();
        await flush();
        await flush();

        expect(cycle.dataset.sessionId).toBe('s-busy');
        expect(localStorage.getItem(SESSION_KEY)).toBe('s-busy');
        expect(transcriptRows()).toEqual([{ id: 't-busy', thread: 'thread-1', prompt: 'prompt alpha' }]);
        expect(stageText()).toContain('answer alpha');
        expect(stageText()).not.toContain('answer bravo');
        expect(action.dataset.action).toBe('stop');
        expect(sessionSubscriptions(stream)).toEqual(['s-busy:s1', 's-busy:s3', 's-quiet:s4', 's-busy:s5', 's-busy:s6']);

        // D. The re-opened observer is LIVE: a frame for the running turn reaches the row that
        //    carries the reused thread id, which is exactly what a mark left behind by
        //    `s-quiet` would have refused.
        expect(
            stream.push([
                {
                    type: 'event',
                    turnId: 't-busy',
                    event: { type: 'text', agent: 'instruct', delta: ' · still streaming', thread: { id: 'thread-1' } }
                }
            ])
        ).toBe(true);
        await flush();
        await flush();

        expect(stageText()).toContain('answer alpha · still streaming');
        // Through the whole walk nothing was cancelled.
        expect(cancellations(calls)).toEqual([]);
    });
});

describe('the harness agent write', () => {
    it('PATCHes the definition with the contract field names, in the contract mount', async () => {
        const stored = descriptor({
            agentModels: { instruct: 'm2' },
            agentInstructions: { summarizer: 'Compress into one paragraph.' }
        }) as unknown as Record<string, unknown>;

        const calls: { url: string; method?: string; body: Record<string, unknown> }[] = [];

        // NO view adapter here on purpose: this is the byte-level contract check, so the
        // assertion sees the URL and body the browser itself produced.
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);

                calls.push({ url, method: init?.method, body });

                if (url === '/v1/harness') {
                    return json({
                        api_root: '/v1/harness',
                        service: 'harness',
                        api_version: 'v1',
                        server_time: 1,
                        epoch: 'e1',
                        capabilities: {},
                        limits: { page_limit: { default: 25, max: 100 } },
                        links: {}
                    });
                }
                if (url === '/v1/harness/config') {
                    return json({ defaults: { base_url: '', model: 'm1', has_api_key: false }, writable_fields: [], revision: 1 });
                }
                if (url.startsWith('/v1/harness/harnesses?')) return json({ items: [harnessCard(stored)], total: 1, has_more: false, next_cursor: null, revision: 1 });
                if (url.startsWith('/v1/harness/tools?')) return json({ items: [], total: 0, has_more: false, next_cursor: null, revision: 1 });
                if (url.startsWith('/v1/harness/agents?')) {
                    return json({
                        items: agents.map((agent) => ({ ...agent, has_instruction_override: false, has_global_override: false })),
                        total: agents.length,
                        has_more: false,
                        next_cursor: null,
                        revision: 1
                    });
                }
                if (url.startsWith('/v1/harness/sessions?')) return json({ items: [], total: 0, has_more: false, next_cursor: null, revision: 1 });
                if (url === '/v1/harness/models') return json({ models: ['m1', 'm2', 'm3'] });
                if (url === '/v1/harness/harnesses/instruct' && init?.method === undefined) {
                    return json({ harness: harnessDefinition(stored) });
                }
                if (url === '/v1/harness/harnesses/instruct/instructions/summarizer') {
                    return json({
                        harness_name: 'instruct',
                        agent: 'summarizer',
                        source: 'harness',
                        instruction: 'Compress into one paragraph.',
                        guidelines: [],
                        chars: 31
                    });
                }
                if (url === '/v1/harness/harnesses/instruct' && init?.method === 'PATCH') {
                    // The server replaces both maps wholesale, so the answer restates them.
                    return json({ harness: harnessDefinition({ ...stored, agentModels: { instruct: 'm3' } }, body) });
                }

                throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
            })
        );

        await import('./main');
        await flush();
        await flush();

        byClass('.agent-control-button', 'button').click();
        await flush();

        const select = byClass<HTMLSelectElement>('.agent-model-select[aria-label="Model for Instruct"]', 'select');
        // The stored override arrives from the identified read, not from the card.
        expect(select.value).toBe('m2');

        select.value = 'm3';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        byClass('.agent-dialog-apply', 'button').click();
        await flush();
        await flush();

        const writes = calls.filter((call) => call.method === 'PATCH');

        // ONE write, to the contract's own resource...
        expect(writes).toHaveLength(1);
        expect(writes[0]?.url).toBe('/v1/harness/harnesses/instruct');
        // ...and its body carries the contract's names, with the team restated and every
        // stored override kept (the server replaces the map, it does not merge it).
        expect(writes[0]?.body).toEqual({
            primary: 'instruct',
            subagents: ['summarizer'],
            agent_models: { instruct: 'm3' },
            agent_instructions: { summarizer: 'Compress into one paragraph.' }
        });

        byClass('.dialog-close', 'button').click();
    });
});

// A definition CARD, in the contract's snake_case spelling: identity, membership and the
// resolved tool set, and deliberately NOT `agent_models` / instruction text
// (../shared/harness-api.ts:418-433).
function harnessCard(definition: Record<string, unknown>): Record<string, unknown> {
    return {
        name: definition.name,
        title: definition.title,
        description: definition.description,
        requires_endpoint: definition.requiresEndpoint,
        primary: definition.primary,
        subagents: definition.subagents,
        agents: definition.agents,
        tools: definition.tools,
        builtin: definition.builtin,
        definition_revision: 1
    };
}

// The identified read of the same definition: the card plus the model map, the resolved
// core tools, and the instruction SUMMARY (provenance + length, never the text —
// ../shared/harness-api.ts:449-460), which is what tells the client whose prompt to fetch.
function harnessDefinition(definition: Record<string, unknown>, patch?: Record<string, unknown>): Record<string, unknown> {
    const models = (patch?.agent_models ?? definition.agentModels) as Record<string, string> | undefined;
    const instructions = (patch?.agent_instructions ?? definition.agentInstructions) as Record<string, string> | undefined;
    const members = (patch?.subagents ? [String(patch.primary), ...(patch.subagents as string[])] : (definition.agents as string[]));

    return {
        ...harnessCard({ ...definition, ...(patch === undefined ? {} : { agents: members }) }),
        core_tools: (definition.coreTools as string[]) ?? [],
        ...(models === undefined || Object.keys(models).length === 0 ? {} : { agent_models: models }),
        instruction_summary: members.map((agent: string) => {
            const override = instructions?.[agent];

            return {
                agent,
                source: override === undefined ? 'catalogue' : 'harness',
                overridden: override !== undefined,
                chars: (override ?? (agents.find((entry) => entry.name === agent)?.instruction ?? '')).length
            };
        })
    };
}
