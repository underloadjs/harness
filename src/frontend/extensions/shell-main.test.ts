// The app shell painting THROUGH the extension registry (T5/R1).
//
// Two boots of the SAME fixture, the only difference being one `registerShellPanel`
// call:
//
//   1. nothing registered BY THIS TEST -> the scratch board's tool card is the
//      byte-for-byte card the shell has always rendered (the string `TOOL_CARD` below,
//      which is also what the untouched ./../scratch-board.test.ts pins). "Nothing
//      registered" is the seam's own view: `main.ts` does register the two live panels
//      of T6 at boot, and those nodes are excluded by id here so the claim stays
//      "the tool card did not move", which is what this file is about;
//   2. one live panel registered -> that exact card, unchanged, with the extension's
//      element after it, and the panel mounted for the conversation on screen.
//
// The second case then follows the reader: switching conversations, starting a new
// one, and reopening the first must dispose and re-create the instance, because the
// panel holds a listener and a timer that belong to one conversation. That is the
// lifecycle proven against the REAL session pointers of `main.ts`, not a fake paint.
//
// The last three cases are T5/R3 and they pin the OTHER signal the same `paintPanels()`
// call carries: `openRail`, the breakpoint and `scratchRailVisible()` reaching a scratch
// slot's panels through `PanelPaintInput.visibility` — shut on a phone boot, open on a
// drawer press, silent at desktop width, and flipped by crossing the media query.
//
// The phone case also follows that signal all the way ONTO THE WIRE. With the shell's own
// stream replaced by a double (`installLiveStream`), it pins what the board puts on the
// connection because of the rail state: an open board whose cards are shut dials NOTHING,
// the press that opens the Tasks card dials exactly one `session`-scope `records.updated`
// registration for the conversation on screen (the shared channel of
// ./extensions/records-wake.ts, through ./extensions/context.ts `defaultPanelSubscribe` —
// no seam double anywhere on the path), a frame on that registration makes the card read
// again, and the press that shuts the drawer releases it. Those assertions are the shell's
// share of the record-channel coverage: the panel suite proves the same wiring against an
// injected seam, and only THIS file can see a wrong scope, an undialled channel or a release
// that never went out.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from '../view-test-support';
// Types only (see the dynamic-import note on `installLiveStream` below).
import type { HarnessStreamOptions, StreamDouble } from '../view-test-support';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        entry: 'instruct',
        ranks: { instruct: 'A' },
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly.',
        instruction: 'Answer the request.',
        guidelines: []
    }
];

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const turn = (overrides: Partial<SessionTurn>): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'done',
    startedAt: T,
    updatedAt: T + 1000,
    events: [],
    ...overrides
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const stubFetch = (
    handler: (url: string, method: string | undefined) => Response | undefined
): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const response = handler(String(input), init?.method);
            if (response === undefined) throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${input}`);

            return response;
        }, { root: '/api' }))
    );
};

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents,
    ...overrides
});

// ---------------------------------------------------------------------------
// The page's own realtime plane, replaced by a double
// ---------------------------------------------------------------------------

// `installHarnessStream` (../view-test-support.ts:3339) configures the process-wide stream
// singleton, so the double is resolved through a DYNAMIC import and never through the static
// `viewAwareFetch` import above: `beforeEach` calls `vi.resetModules()`, which clears the
// registry, so the statically imported copy of the support module would configure the
// PREVIOUS `../stream` instance while `../main` — imported after the reset — dials a fresh
// singleton that has no factory at all. That mismatch is indistinguishable from "the shell
// never subscribed", which is exactly what the drawer case below asserts (the same discipline
// ../canonical-directory-live-main.test.ts:56-74 documents). The TYPES are static: they are
// erased at compile time, so they cannot pin a stale instance.
const installLiveStream = (options: HarnessStreamOptions = {}): Promise<StreamDouble> =>
    import('../view-test-support').then((support) => support.installHarnessStream(options));

// The twin of that import: the singleton is process-wide, so the double has to be released
// through the SAME module instance the shell used, or the next test file's boot inherits a
// socket that was never its own.
const releaseLiveStream = async (): Promise<void> => {
    const { resetHarnessStream } = await import('../stream');

    resetHarnessStream();
};

// Every `subscribe` frame the page put on the wire, as `<scope>:<session_id>:<id>` in dial
// order. The shared record channel of ./records-wake.ts is a `session`-scope registration, so
// this list is the evidence of WHO is on the plane and WHAT scope they asked for — a channel
// dialled against the wrong scope lands in this list with the wrong first segment, and a
// channel that was never dialled is missing from it. The list is CUMULATIVE (one entry per
// subscribe the page ever made), which is why `unsubscriptionsOnWire` is its pair.
const subscriptionsOnWire = (stream: StreamDouble): string[] =>
    stream.subscriptions.map((sub) => `${String(sub.scope)}:${String(sub.session_id ?? '')}:${String(sub.subscription_id)}`);

// The ids the client said goodbye to, in the order the goodbyes went out. An id that is in
// `subscriptionsOnWire` and never here is an ORPHAN: a registration the page still holds on
// the plane with nothing listening to it.
const unsubscriptionsOnWire = (stream: StreamDouble): string[] =>
    stream.sent
        .filter((frame) => frame.type === 'unsubscribe')
        .map((frame) => String(frame.subscription_id));

// ---------------------------------------------------------------------------
// The record store the two built-in live panels read
// ---------------------------------------------------------------------------

// The Tasks card's boot read (./records-panels.ts reads through `panelApi.readRecordsSnapshot`
// → ../view-api.ts → `GET /sessions/:id/records`). Two tasks, so the card paints rows and a
// painted row is visible proof the read landed through the REAL shell wiring.
const recordsStore = {
    session_id: 's1',
    revision: 2,
    store_rev: 2,
    collections_rev: 1,
    collections: [
        {
            name: 'tasks',
            store_rev: 2,
            count: 2,
            fields: [
                { key: 'text', type: 'text' as const, required: true },
                { key: 'completed', type: 'boolean' as const, required: true }
            ],
            entries: [
                { id: 'rec_b', rev: 0, text: 'Write the tests', completed: false, updated_at: '2026-11-10T09:00:00.000Z' },
                { id: 'rec_a', rev: 1, text: 'Ship it', completed: true, updated_at: '2026-11-10T09:00:00.000Z' }
            ]
        }
    ],
    changes: []
};

// The delta form (`?since=N`) of the same route: the read a `records.updated` wake causes. It
// answers with the feed rows after that position — none here — and states the store's CURRENT
// position (3), which is the cursor the client then holds. `collections_rev` stays at 1, the
// position the snapshot stated: a wake that named no define/drop must not be answered with one
// moved, or the client is entitled to re-boot with a snapshot (./records-client.ts) and the
// read this case counts stops being a delta. Nothing here asserts the rows; what it asserts is
// WHICH read a frame caused, and `serve` counts the two forms apart.
const recordsDelta = {
    session_id: 's1',
    revision: 3,
    store_rev: 3,
    collections_rev: 1,
    changes: [],
    reset: false
};

// Counted by `serve` below, so a case can pin WHICH read a wire frame caused. `beforeEach`
// re-installs `serve`, and `serve` resets this with it. `recordUrls` keeps the record-route
// urls in the order the page asked for them, so an assertion can name the exact reads a frame
// produced (the snapshot form and the `?since=` delta form are different reads).
const served = { recordsReads: 0, deltaReads: 0, recordUrls: [] as string[] };

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

const scratchHost = (): HTMLElement => byClass('.panel-host[data-slot="scratch"]', 'div');

// The board's two conversations. s1 carries the one recorded panel this file is
// written around; s2 carries a different one, so a leak across a switch is visible.
const first = snapshot({
    id: 's1',
    createdAt: T,
    updatedAt: T + 5_000,
    turns: [
        turn({
            events: [
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'statusTool',
                    content: 'ok',
                    isError: false,
                    ui: [
                        {
                            id: 'status',
                            slot: 'scratch',
                            title: 'Status',
                            blocks: [{ type: 'text', text: 'ready' }]
                        }
                    ]
                }
            ]
        })
    ]
});

const second = snapshot({
    id: 's2',
    turns: [
        turn({
            id: 't2',
            events: [
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'statusTool',
                    content: 'ok',
                    isError: false,
                    ui: [
                        {
                            id: 'other',
                            slot: 'scratch',
                            title: 'Other',
                            blocks: [{ type: 'text', text: 'elsewhere' }]
                        }
                    ]
                }
            ]
        })
    ]
});

const serve = (): void => {
    let made = 0;

    served.recordsReads = 0;
    served.deltaReads = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [first, second] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: first });
        if (url === '/api/sessions/s2' && method === undefined) return json({ session: second });

        // The record store the built-in live panels read (../view-api.ts
        // `readRecordsSnapshot` → `GET /sessions/:id/records`). The `?since=` form is the
        // DELTA read a `records.updated` frame triggers, so the two are counted separately:
        // a case that pushes a frame on the wire asserts on `served.deltaReads`.
        const [recordPath, query = ''] = url.split('?');

        // Every record read the page attempts is recorded, whatever the answer turns out to
        // be, so a case can NAME the reads a wire frame produced rather than guess at them.
        if (url.includes('/records')) served.recordUrls.push(url);

        if (recordPath === '/api/sessions/s1/records' && method === undefined) {
            if (query.startsWith('since=')) {
                served.deltaReads += 1;

                return json(recordsDelta);
            }

            served.recordsReads += 1;

            return json(recordsStore);
        }

        // T3 (R1): the header `+` CREATES a conversation. A POST on the directory's own path,
        // answered with a fresh 0-turn record under the harness the BODY names — the created
        // row is what the live panel below re-mounts for, so the fixture has to serve it.
        if (url === '/api/sessions' && method === 'POST') {
            made += 1;

            return json({ session: snapshot({ id: `made-${made}`, createdAt: 900, updatedAt: 900 }) }, 201);
        }
        if (url === '/api/sessions/made-1' && method === undefined)
            return json({ session: snapshot({ id: 'made-1', createdAt: 900, updatedAt: 900 }) });

        return undefined;
    });
};

// A live panel: one listener (released by the context's signal), one interval
// (released by an explicit disposer) and a mount log labelled per instance, so a
// disposal is an OBSERVED effect rather than a call count.
const mountLog: string[] = [];

const installLivePanel = async (): Promise<void> => {
    // `vi.resetModules()` gives `../main` a FRESH copy of this subsystem, so the
    // registry a statically imported handle would write into is not the one the shell
    // reads (the same discipline ./scratch-board.test.ts:20-31 describes for the
    // stream double). Import the seam AFTER the reset, through the same specifier the
    // shell uses.
    const extensions = await import('./index');
    let instances = 0;

    extensions.registerShellPanel({
        id: 'tasks',
        title: 'Tasks',
        mount: (context) => {
            instances += 1;
            const self = instances;
            mountLog.push(`mount:${self}:${context.sessionId ?? 'none'}`);

            window.addEventListener('resize', () => mountLog.push(`resize:${self}`), { signal: context.signal });

            const timer = window.setInterval(() => mountLog.push(`tick:${self}`), 1_000);
            context.onDispose(() => {
                window.clearInterval(timer);
                mountLog.push(`dispose:${self}`);
            });
        }
    });
};

const openSession = async (id: string): Promise<void> => {
    byClass('.harness-title-button', 'button').click();
    byClass(`.session-pills-bar-dialog .session-pill-select[data-session-id="${id}"]`, 'button').click();
    await flush();
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    mountLog.length = 0;
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    localStorage.setItem(SESSION_KEY, 's1');
    serve();
});

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // The stream singleton is process-wide (../stream.ts:647): a double left configured here
    // would be the next case's socket too, and only the drawer case installs one today.
    await releaseLiveStream();
});

// The card the shell draws for `first`'s recorded panel: the COMPACT summary card
// (state, shape list, disclosure note and expand action), exactly as the untouched
// ../scratch-board.test.ts pins it. Both tests below compare against this one string,
// which is what makes "a registered panel changed nothing" a checkable claim.
const TOOL_CARD =
    '<article class="panel" data-panel-id="status" data-panel-slot="scratch" data-panel-state="summary" ' +
    'data-panel-tool="statusTool"><h3 class="panel-title">Status</h3>' +
    '<div class="panel-blocks"><p class="panel-text">ready</p>' +
    '<dl class="panel-kv" data-block="keyValue"><dt class="panel-kv-label">text</dt>' +
    '<dd class="panel-kv-value">5 characters</dd></dl></div>' +
    '<p class="panel-note" title="This card is the compact view. Use Open the full panel for the recorded ' +
    'content.">compact view · preview only</p><div class="panel-actions">' +
    '<button class="button small panel-expand" type="button">Open the full panel</button></div></article>';

// The two live panels `main.ts` registers at boot (T6: ./extensions/records-panels.ts).
// Both tests below pin the TOOL card and ONE named test panel, so the built-ins are
// excluded by class — `panel-extension` is what the runtime stamps on an extension node
// (./runtime.ts:104) and never on a tool card — and by id, so the assertion still names
// the panel it is about.
const BUILTIN_PANEL_IDS = ['harness.tasks', 'harness.records'];

const toolCardsIn = (): HTMLElement[] =>
    [...scratchHost().querySelectorAll<HTMLElement>('.panel')].filter(
        (node) => !node.classList.contains('panel-extension')
    );

const extensionNodesIn = (): HTMLElement[] =>
    [...scratchHost().querySelectorAll<HTMLElement>('.panel-extension')].filter(
        (node) => !BUILTIN_PANEL_IDS.includes(node.dataset.panelExtension ?? '')
    );

it('paints the scratch board unchanged with an empty registry', async () => {
    await import('../main');
    await flush();
    await flush();

    // The rail section is still head, note, host. What the host holds is the tool card
    // BYTE-FOR-BYTE, plus the two live panels the shell itself registers at boot — the
    // seam adds nodes and changes nothing about a card it already drew, which is the
    // claim this test exists to pin.
    expect(document.querySelector('.rail-right > .rail-section')?.className).toBe('rail-section scratch-section');
    expect(scratchHost().previousElementSibling?.className).toBe('field-hint scratch-note');
    expect(document.querySelector('.scratch-note')?.textContent).toBe('1 tool panel for instruct.');
    expect(toolCardsIn().map((node) => node.outerHTML)).toEqual([TOOL_CARD]);
    expect(scratchHost().querySelectorAll('.panel-extension')).toHaveLength(2);
    expect(
        [...scratchHost().querySelectorAll<HTMLElement>('.panel-extension')].map((node) => node.dataset.panelExtension)
    ).toEqual(BUILTIN_PANEL_IDS);
    expect(scratchHost().hidden).toBe(false);
});

it('mounts, switches and disposes a registered live panel without touching the tool card', async () => {
    await installLivePanel();
    await import('../main');
    await flush();
    await flush();

    // Mounted EXACTLY once, for the conversation on screen (the boot paint runs before
    // the remembered session is read, and a session-scoped panel waits for it), and
    // after the tool card — which is the byte-for-byte card of the empty-registry boot.
    expect(mountLog).toEqual(['mount:1:s1']);
    expect(toolCardsIn().map((node) => node.outerHTML)).toEqual([TOOL_CARD]);
    expect(extensionNodesIn().map((node) => node.outerHTML)).toEqual([
        '<div class="panel panel-extension" data-panel-extension="tasks" data-panel-slot="scratch">' +
            '<h3 class="panel-title">Tasks</h3></div>'
    ]);

    // The note still counts TOOL panels: a registered live panel cannot rewrite the
    // rail's copy, which is what the pre-existing scratch-board assertions pin.
    expect(document.querySelector('.scratch-note')?.textContent).toBe('1 tool panel for instruct.');

    // The listener belongs to the mounted instance and answers while it lives.
    window.dispatchEvent(new Event('resize'));
    expect(mountLog).toEqual(['mount:1:s1', 'resize:1']);

    // A session SWITCH disposes instance 1 and mounts instance 2 for s2's conversation
    // — one element, no residue from the previous chat.
    await openSession('s2');

    expect(mountLog).toEqual(['mount:1:s1', 'resize:1', 'dispose:1', 'mount:2:s2']);

    window.dispatchEvent(new Event('resize'));
    expect(mountLog).toEqual(['mount:1:s1', 'resize:1', 'dispose:1', 'mount:2:s2', 'resize:2']);

    expect(extensionNodesIn()).toHaveLength(1);
    // The card the TOOL pipeline drew for s2 is still the first card in the host — a
    // live panel is appended after the tool cards, never between them.
    expect(scratchHost().querySelector('.panel')?.getAttribute('data-panel-id')).toBe('other');

    // New session: the conversation the panel was mounted for is gone, so that instance is
    // disposed and a FRESH one is mounted for the conversation the create opened — T3 (R1)
    // means the press now lands on a real 0-turn record (`made-1`), and a session-scoped
    // panel re-mounts for it, exactly as it does for a pill switch. The listener of the old
    // instance stops answering; the new one's does.
    byClass('.harness-title-row .new-session', 'button').click();
    await flush();
    await flush();

    expect(mountLog).toEqual([
        'mount:1:s1',
        'resize:1',
        'dispose:1',
        'mount:2:s2',
        'resize:2',
        'dispose:2',
        'mount:3:made-1'
    ]);

    window.dispatchEvent(new Event('resize'));
    expect(mountLog[7]).toBe('resize:3');
    // The TOOL pipeline has nothing to draw for a conversation with no turns, so the board's
    // only nodes are the live panels — the test's `tasks` panel and the two the shell
    // registers — and the rail's copy says so.
    expect(toolCardsIn()).toHaveLength(0);
    expect(extensionNodesIn().map((node) => node.outerHTML)).toEqual([
        '<div class="panel panel-extension" data-panel-extension="tasks" data-panel-slot="scratch">' +
            '<h3 class="panel-title">Tasks</h3></div>'
    ]);
    expect(document.querySelector('.scratch-note')?.textContent).toBe(
        'No tool panels yet. A tool that publishes ui/panels lands here.'
    );

    // Reopening s1 is a fresh instance, scoped to the conversation it now reads.
    await openSession('s1');

    expect(mountLog.slice(7)).toEqual(['resize:3', 'dispose:3', 'mount:4:s1']);
    expect(extensionNodesIn()).toHaveLength(1);
    expect(scratchHost().querySelector('.panel')?.getAttribute('data-panel-id')).toBe('status');
});

// ---------------------------------------------------------------------------
// T5/R3 — the shell's rail state IS board visibility
// ---------------------------------------------------------------------------

// `main.ts` samples `window.matchMedia` ONCE at module init (./main.ts:5609), so the stub
// has to be in place before `await import('../main')`; its `change` listeners are how a
// breakpoint crossing reaches the shell. Copied from the same file-local stand-in
// ../rail-toggle.test.ts:142-164 uses rather than inventing a second harness.
type MediaListener = (event: { matches: boolean }) => void;

const stubMedia = (matches: boolean): { setMatches(next: boolean): void } => {
    const listeners = new Set<MediaListener>();
    const media = {
        matches,
        media: '(max-width: 860px)',
        addEventListener: (_type: string, listener: MediaListener): void => {
            listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: MediaListener): void => {
            listeners.delete(listener);
        }
    };

    vi.stubGlobal('matchMedia', vi.fn(() => media));

    return {
        setMatches(next: boolean): void {
            media.matches = next;
            for (const listener of [...listeners]) listener({ matches: next });
        }
    };
};

// A scratch-slot panel that logs the visibility signal the shell publishes, labelled per
// instance so a delivery to a dead instance can never be read as one to the live one. It
// also paints one node, checked for IDENTITY across the toggle: the rail's contract is that
// a closed drawer keeps its content and state (./main.ts `setRailOpen`), so a hidden board
// is a SUSPENDED board and a re-mounted one is a bug.
//
// `mount` reports what the callback itself saw — the context default, `true` — because
// ./runtime.ts:201-213 publishes the slot's value only AFTER `panel.mount()` returns.
const installVisibilityPanel = async (): Promise<string[]> => {
    const extensions = await import('./index');
    const log: string[] = [];
    let instances = 0;

    extensions.registerShellPanel({
        id: 'board',
        title: 'Board',
        mount: (context) => {
            instances += 1;
            const self = instances;

            log.push(`mount:${self}:${context.visible}`);
            context.onVisibility((visible) => log.push(`visibility:${self}:${visible}`));
            context.onDispose(() => log.push(`dispose:${self}`));

            const line = document.createElement('p');

            line.textContent = `state:${self}`;
            context.element.append(line);
        }
    });

    return log;
};

const extensionElement = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-panel-extension="board"]');

const fabOf = (): HTMLButtonElement => byClass('.scratch-fab', 'button');

it('tells a scratch panel the phone board is shut, and re-tells it on every drawer press', async () => {
    // No `matchMedia` in jsdom, so `main.ts` falls back to phone layout with the right rail
    // closed (./main.ts:5609-5610): the boot paint already carries `scratch: false`, and a
    // panel mounted by the paint that lands the remembered session is BORN hidden.
    //
    // The page's own realtime plane is a double here (see `installLiveStream` above), because
    // the second half of this case is not about the visibility signal — it is about what the
    // board PUTS ON THE WIRE because of that signal: the shared `records.updated`
    // registration of ./extensions/records-wake.ts, dialled by a card the reader opened and
    // released by the drawer that hides it. `first` is an IDLE conversation, so nothing else
    // on this page holds a session-scope registration: every entry in the two wire lists
    // below belongs to the record channel, which is what makes "exactly one" checkable.
    const stream = await installLiveStream({ sessionId: 's1' });
    const log = await installVisibilityPanel();
    await import('../main');
    await flush();
    await flush();

    expect(log).toEqual(['mount:1:true', 'visibility:1:false']);

    const element = extensionElement();

    if (element === null) throw new Error('the scratch panel was not mounted');

    const painted = element.querySelector('p');

    expect(painted?.textContent).toBe('state:1');

    // THE BOARD IS SHUT, SO THE PLANE IS EMPTY. Both built-in cards ship collapsed (R1) and
    // the phone drawer is shut (R3), so no live panel on this page reads or registers: an
    // empty list here is the baseline every assertion below is measured against, and a card
    // that booted at mount would put the record channel on the wire right now.
    expect(subscriptionsOnWire(stream)).toEqual([]);

    // --- the press that opens the drawer ------------------------------------
    const fab = fabOf();

    expect(fab.getAttribute('aria-expanded')).toBe('false');
    fab.click();

    expect(log).toEqual(['mount:1:true', 'visibility:1:false', 'visibility:1:true']);
    expect(fab.getAttribute('aria-expanded')).toBe('true');

    // AN OPEN BOARD WITH SHUT CARDS STILL DIALS NOTHING — the drawer press moves visibility,
    // and a collapsed card has no engine to attach to the shared channel (R2).
    expect(subscriptionsOnWire(stream)).toEqual([]);

    // --- the press that opens a CARD ----------------------------------------
    // The Tasks card's own heading is its toggle (./records-panels.ts `titleToggleOf`), inside
    // the node the runtime stamped for the built-in panel. This is the shell's real wiring end
    // to end: the card, the context's `subscribe`, ./extensions/context.ts
    // `defaultPanelSubscribe` and the page's stream client — no seam double anywhere between
    // the press and the frame the browser would have put on the socket.
    const tasksTitle = document.querySelector<HTMLButtonElement>(
        '[data-panel-extension="harness.tasks"] button[data-panel-toggle="tasks"]'
    );

    if (tasksTitle === null) throw new Error('the built-in Tasks card has no title toggle');

    const snapshotReadsBefore = served.recordsReads;

    tasksTitle.click();
    await flush();

    // The press boots the card: one snapshot read through the shell's own record route, and
    // two rows on screen.
    expect(served.recordsReads).toBe(snapshotReadsBefore + 1);
    expect(
        scratchHost().querySelectorAll('[data-panel-extension="harness.tasks"] li.panel-tasks-row')
    ).toHaveLength(2);

    // ONE registration, on the SESSION scope, addressed at the conversation on screen — and
    // addressed with NO filters, because `records` is a baseline resource of the session scope
    // (../../shared/harness-stream.ts). The whole frame is asserted, so a channel dialled on
    // another scope, against another conversation, or with a filter this contract refuses
    // fails here rather than reading as a pass.
    //
    // The id is `s2`, and that is not an accident of this fixture: the client mints one id per
    // `subscribe` from a page-wide counter (../stream.ts:716-719), and the boot's display read
    // of `t1` consumed `s1` (`observeTurn`; ../canonical-directory-live-main.test.ts:1040-1042
    // names those same display-channel ids). That registration was released BEFORE this socket
    // opened, and an id the server never acknowledged is dropped WITHOUT a goodbye
    // (../stream.ts:744) — which is precisely why the wire lists nothing until the card is
    // pressed, while the counter is already past `s1`. What this case pins is the SCOPE, the
    // conversation and the release; the number itself is the counter's own.
    expect(subscriptionsOnWire(stream)).toEqual(['session:s1:s2']);
    expect(stream.subscriptions).toEqual([
        { type: 'subscribe', subscription_id: 's2', scope: 'session', session_id: 's1', pace: 'ordered' }
    ]);
    expect(unsubscriptionsOnWire(stream)).toEqual([]);

    // THE REGISTRATION IS THIS CARD'S WAKE, not just an entry on a socket: one
    // `records.updated` frame on the id the page holds makes the CARD read again. The frame has
    // to move a watermark this client can act on: `collections_rev` unchanged (a move there is
    // a define/drop and re-boots with a SNAPSHOT instead) and `store_rev` strictly past the
    // position its last read stated (./records-client.ts:963-981). The boot snapshot stated
    // `store_rev: 2 / collections_rev: 1`, so the frame below names 3 at the same collections
    // position — and the read it causes is a DELTA anchored at exactly the cursor that snapshot
    // left. A channel dialled with a detached handler, or one that never reached the panel's
    // client, would leave this list at the one boot read it started from.
    stream.push({ kind: 'records.updated', records: { store_rev: 3, collections_rev: 1 } });
    await flush();

    expect(served.recordUrls).toEqual(['/api/sessions/s1/records', '/api/sessions/s1/records?since=2']);
    expect(served.deltaReads).toBe(1);

    // --- the press that closes it -------------------------------------------
    fab.click();

    expect(log).toEqual([
        'mount:1:true',
        'visibility:1:false',
        'visibility:1:true',
        'visibility:1:false'
    ]);
    // Suspension, in the real shell: no dispose, no second instance, and the node the panel
    // painted is still the node that is there — same element, same child.
    expect(log.filter((entry) => entry.startsWith('dispose:'))).toEqual([]);
    expect(extensionElement()).toBe(element);
    expect(element.querySelector('p')).toBe(painted);

    // THE DRAWER CLOSE RELEASES THE CHANNEL. The Tasks card is still EXPANDED — closing the
    // rail is a suspension, not a wipe — and a card nobody can look at holds no registration
    // and no client. The goodbye for `s2` is the only honest evidence of that: a release
    // attached to the wrong signal, an `onDispose` the context never ran, or a wake that keeps
    // its registration after the last panel lets go all leave this list EMPTY while every DOM
    // assertion above still passes.
    expect(unsubscriptionsOnWire(stream)).toEqual(['s2']);

    // The seam is change-only: opening and closing again without a real move in the rail
    // state adds nothing to what the panel was told.
    fab.click();
    fab.click();
    expect(log.slice(4)).toEqual(['visibility:1:true', 'visibility:1:false']);

    // THE SECOND CYCLE IS CLEAN TOO. The re-open re-boots the card with a FRESH registration
    // (`s3`, not the released `s2` — re-using it would mean the plane had never let go), and
    // the press that shut the board released that one as well. Read the two lists together:
    // every id this page ever dialled is also in the goodbye list, so nothing is left on the
    // plane held by a card the reader cannot see.
    expect(subscriptionsOnWire(stream)).toEqual(['session:s1:s2', 'session:s1:s3']);
    expect(unsubscriptionsOnWire(stream)).toEqual(['s2', 's3']);
});

it('keeps the board visible at desktop width whatever the drawer state says', async () => {
    // 861px and up: the right rail is laid out, so `scratchRailVisible()` is true and the
    // panel is never told a word — a host that reports no change owes the panel no call.
    stubMedia(false);

    const log = await installVisibilityPanel();
    await import('../main');
    await flush();
    await flush();

    expect(log).toEqual(['mount:1:true']);

    // The FAB still drives `openRail` on a wide window (it is the rail's disclosure control,
    // and the drawer state is phone-only decoration), and every paint it adds delivers
    // nothing: the slot's value never moved.
    fabOf().click();
    expect(log).toEqual(['mount:1:true']);

    fabOf().click();
    expect(log).toEqual(['mount:1:true']);

    expect(document.querySelectorAll('[data-panel-extension="board"]')).toHaveLength(1);
});

it('flips the board signal when the window crosses the phone breakpoint', async () => {
    const media = stubMedia(true);
    const log = await installVisibilityPanel();
    await import('../main');
    await flush();
    await flush();

    // Phone, drawer shut.
    expect(log).toEqual(['mount:1:true', 'visibility:1:false']);

    // Growing past 860px lays the board out again: one delivery, and no re-mount to get it.
    media.setMatches(false);

    expect(log).toEqual(['mount:1:true', 'visibility:1:false', 'visibility:1:true']);
    expect(document.querySelectorAll('[data-panel-extension="board"]')).toHaveLength(1);

    // Shrinking back under it hides the board on its own — the drawer state is closed, and
    // the breakpoint handler paints even though it touches no rail (./main.ts:5823-5836).
    media.setMatches(true);

    expect(log).toEqual([
        'mount:1:true',
        'visibility:1:false',
        'visibility:1:true',
        'visibility:1:false'
    ]);

    // And the drawer press still reaches the same instance.
    fabOf().click();

    expect(log).toEqual([
        'mount:1:true',
        'visibility:1:false',
        'visibility:1:true',
        'visibility:1:false',
        'visibility:1:true'
    ]);
});
