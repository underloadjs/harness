// The composer's agent CYCLE (T1) in the live shell: which member of the team the next
// message runs, how the reader changes it on each device, and how the choice reaches the
// server.
//
// `composer-agent-control.test.ts` owns the chip's OTHER press (it opens the shared
// dialog) and `ui/agent-control.test.ts` / `ui/press-hold.test.ts` own the control and the
// gesture machine in isolation. This file owns what only the shell can prove:
//
//   1. `Tab` / `Shift+Tab` in the field walk the SESSION ROSTER in server-declared order
//      (`primary` first, then `subagents`), wrap around at both ends, repaint the chip AND
//      the routing label, announce the change, and cost ZERO requests — the choice is
//      pending, not applied (D1/D2/D5);
//   2. a locked roster (one member) leaves `Tab` to the browser and states why in the
//      accessible name, and an open modal dialog keeps its own `Tab` trap (D6);
//   3. on a positively-detected touch device a TAP cycles and a PRESS-AND-HOLD opens the
//      dialog, with the synthesised click swallowed exactly once (D7/D8);
//   4. the pending selection commits AT SEND on the wire that already exists:
//      `POST /sessions/:id/threads {agent}` THEN `POST /sessions/:id/tasks {thread_id}` —
//      in that order, one thread per cycle, and an entry-agent send still costs no thread
//      request at all (D3);
//   5. a focused conversation outranks the composer's choice, and selecting deliberately
//      drops that focus so the choice is never silently discarded (D5);
//   6. the correction round's findings, each pinned by the case that fails without it: a
//      choice made WHILE a send is in flight survives the receipt (F1), the routing line
//      cannot promise a destination the request will not use (F2), a focused conversation a
//      partial roster does not describe outranks a pending choice instead of being abandoned
//      for a stray thread (F3), and the live region is never left holding a sentence the chip
//      no longer matches (F4) — plus the device repaint (G4), the new-session invalidation
//      (G6), the retry that re-creates the conversation (G8), and the `#` list that answers
//      `Tab` while a choice is pending (the tab-owner rule G7 cannot pin on its one-agent
//      team).
//
// Every live-region claim asserts the WHOLE sentence including the roster position
// (`… Researcher (2 of 3).`), because the position is what makes two announcements of
// same-looking members byte-distinguishable for assistive tech (F4).
//
// The team is a 3-member harness (`instruct` primary, `research` + `workspace` subagents),
// because the ORDER of the cycle is the assertion: it must follow the definition's own
// order, not alphabetical order and not the dialog's tab order.
//
// Device stubs: `main.ts` builds its MediaQueryLists at module scope, so `stubMedia` runs
// BEFORE `await import('./main')` in every case that needs a device (the compact fixture's
// `stubMedia` in composer-control.test.ts:205-241 is copied verbatim — it throws on an
// unknown query, so a new media axis in main.ts surfaces here instead of reading as a
// desktop default).
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts composer-agent-cycle.test.ts

import type { AgentDescriptor, HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

// The cycle order the server declares: `membersOf` puts `primary` first and then the
// subagents in the order the definition lists them. A cycle that walked `agents` instead
// would be the same list HERE, which is why the descriptor below deliberately lists
// `agents` as primary-first too and the assertion names the three titles in order.
const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct', 'research', 'workspace'],
        tools: [],
        coreTools: [],
        entry: 'instruct',
        ranks: { instruct: 'A', research: 'B', workspace: 'B' },
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents: AgentDescriptor[] = [
    { name: 'instruct', title: 'Instruct', description: 'General agent.', instruction: 'Answer.', guidelines: [] },
    { name: 'research', title: 'Researcher', description: 'Investigates.', instruction: 'Investigate.', guidelines: [] },
    { name: 'workspace', title: 'Coder', description: 'Writes code.', instruction: 'Write code.', guidelines: [] }
];

type ThreadFixture = {
    id: string;
    agent: string;
    origin: 'host';
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
};

// `events` defaults to a settled ANSWER, not an empty list, because the board's BLOCKS are
// what `#` references bind to (ui/references.ts:44): a turn with no events paints a row with
// no referenceable block, so the `#` popup would open EMPTY and the popup-vs-cycle case below
// could not be pinned on this fixture. An explicit `events: []` still overrides it.
const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
    ({
        id: 'turn-1',
        index: 0,
        prompt: 'first question',
        threadId: 'thread-1',
        status: 'done',
        startedAt: T,
        updatedAt: T,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'text', agent: 'instruct', delta: 'first answer' }
        ],
        ...overrides
    }) as SessionTurn;

const snapshot = (
    options: { threads?: ThreadFixture[]; turns?: SessionTurn[]; id?: string } = {}
): SessionSnapshot =>
    ({
        id: options.id ?? 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: options.turns ?? [],
        ...(options.threads === undefined ? {} : { threads: options.threads })
    }) as unknown as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (count = 2): Promise<void> => {
    for (let index = 0; index < count; index += 1) await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

// The three surfaces a cycle touches, read as the reader/AT gets them.
const chip = (): HTMLButtonElement => byClass('.agent-control-button', 'button');
// The identity attribute lives on the WRAPPER: ui/agent-color.ts `paintAgentColor` writes
// the tone AND `data-agent` there, so the name, the compact code and ui/activity.ts's
// ring all come from one paint (and one rebuild cannot desynchronise them).
const chipAgent = (): string | undefined => byClass('.agent-control', 'div').dataset.agent;
const chipName = (): string => chip().querySelector<HTMLElement>('.agent-control-name')?.textContent ?? '';
const live = (): HTMLElement => byClass('.agent-control-live', 'p');
const liveText = (): string => live().textContent ?? '';
const field = (): HTMLElement => byClass('.composer-input', 'div');
const targetText = (): string => byClass('.composer-target', 'p').textContent ?? '';

// `Tab` exactly as a keyboard produces it: the reader is IN the field (a contentEditable
// element is a real focus target), and the event is cancelable, because the browser's
// default (move focus to the next control) is the thing the shell has to call
// `preventDefault` on when the keystroke cycled instead.
const pressTab = (shift = false): KeyboardEvent => {
    field().focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
    field().dispatchEvent(event);

    return event;
};

type Call = { url: string; method: string; body: unknown };

// A WRITE, as the reader would count them. `POST /v1/harness/models` is the model
// catalogue query (a read that wears the POST verb, `api.ts:1272`) and every fixture pays
// it at boot, so it is excluded here — otherwise "a cycle costs nothing" would be a claim
// about the boot traffic rather than about the keystroke.
const writesOf = (calls: readonly Call[]): string[] =>
    calls
        .filter((call) => (call.method === 'POST' || call.method === 'PATCH') && call.url !== '/v1/harness/models')
        .map((call) => `${call.method} ${call.url}`);

type Server = {
    /** EVERY request, in order, on the URL the CLIENT asked for. */
    calls: Call[];
    /** Bodies of the canonical thread creates (`POST /sessions/:id/threads`). */
    created: Array<Record<string, unknown>>;
    /** Bodies of the task submits, as the canonical route hands them over. */
    tasks: Array<Record<string, unknown>>;
    /** Swaps the thread create's answer for a refusal. */
    failThreads: string | undefined;
    /** Park the task POST in flight (F1); `releaseTasks()` then answers it. */
    holdTasks: boolean;
    releaseTasks: (() => void) | undefined;
};

// The canonical thread-create route, spelled the way the CLIENT spells it
// (`HARNESS_ROUTES.sessionsBySessionIdThreads`), because the recorder below sits OUTSIDE
// `viewAwareFetch` and the acceptance evidence is about the wire the shell actually dials.
const THREADS_CANON = '/v1/harness/sessions/s1/threads';
const TASKS_CANON = '/v1/harness/sessions/s1/tasks';

// The shell's whole server surface. It is recorded OUTSIDE the display adapter (the same
// discipline `agent-instructions-main.test.ts:205-214` uses for its canonical recorder):
// inside the adapter the tasks POST arrives as the legacy `/api/...` path, which would make
// the ORDER evidence in criterion 4 about the adapter rather than about the shell.
//
// `session` undefined is the fresh-card case: a harness with a team and no conversation,
// which is what a pure cycle test needs (no threads, so no thread can outrank the choice).
const stubServer = (
    options: { session?: SessionSnapshot; taskError?: string; single?: boolean } = {}
): Server => {
    const server: Server = { calls: [], created: [], tasks: [], failThreads: undefined, holdTasks: false, releaseTasks: undefined };
    const session = options.session;

    const inner = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = init?.method;

        if (url === '/api') {
            return json({
                rootPath: '/api',
                // `single` is the locked-roster case (D6): a team with one member has
                // nothing to cycle between.
                presets: [options.single === true ? descriptor({ agents: ['instruct'], ranks: { }}) : descriptor()],
                tools: [],
                defaults,
                sessions: session === undefined ? [] : [session],
                agents: options.single === true ? [agents[0]] : agents
            });
        }
        if (url === '/api/models') return json({ models: ['m1'] });

        // The fresh card's first send creates the conversation (main.ts `ensureSession`).
        if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() }, 201);
        if (url === '/api/sessions' && method === undefined) {
            return json({ sessions: session === undefined ? [] : [session] });
        }

        if (url === '/api/sessions/s1' && (method === undefined || method === 'GET')) {
            return json({ session: session ?? snapshot() });
        }

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            server.tasks.push(body);

            // The answer, built per request (a `Response` body is single-use).
            const respond = (): Response => {
                if (options.taskError !== undefined) return json({ error: { message: options.taskError } }, 500);

                const threadId = String(body.thread_id ?? 'thread-1');
                const opening = turn({
                    id: `turn-new-${server.tasks.length}`,
                    prompt: String(body.input ?? ''),
                    status: 'running',
                    threadId
                });

                // The conversation the message landed in, DESCRIBED the way a real receipt's
                // document describes it: a thread the shell just created for a cycled agent
                // runs THAT agent, and a thread-less submit opens one for the team's entry
                // agent (src/server/sessions.ts:9379-9385). Without the entry this fixture
                // answers a legacy/partial roster, and the focused conversation then outranks
                // the pending choice for the reason F3's own case pins — which would make
                // F1's "the NEXT message runs the cycled agent" evidence about the fixture
                // rather than about the shell.
                const known = session?.threads ?? [];
                const threads = known.some((entry) => entry.id === threadId)
                    ? known
                    : [
                          ...known,
                          {
                              id: threadId,
                              agent:
                                  body.thread_id === undefined || server.created.length === 0
                                      ? 'instruct'
                                      : String(server.created[server.created.length - 1].agent ?? 'instruct'),
                              origin: 'host' as const,
                              status: 'running' as const,
                              sequence: known.length + 1,
                              label: `T${known.length + 1}`
                          }
                      ];

                return json(
                    { session: snapshot({ threads, turns: [...(session?.turns ?? []), opening] }), turn: opening },
                    202
                );
            };

            // F1: `holdTasks` parks the submit IN FLIGHT — the exact window main.ts opens at
            // :15583 (`submitting = true`) and closes at :15771, which covers session create,
            // the optional thread create and this POST. A keystroke during that window is the
            // reader addressing the NEXT message, and the test releases the receipt only after
            // pressing it.
            if (server.holdTasks) {
                return await new Promise<Response>((resolve) => {
                    server.releaseTasks = (): void => {
                        server.holdTasks = false;
                        server.releaseTasks = undefined;
                        resolve(respond());
                    };
                });
            }

            return respond();
        }

        // A submit makes the conversation run, and a running conversation opens the flow.
        // An empty, open stream is enough: every transition here comes from the submit's own
        // answer, never from a pushed frame.
        if (url === '/api/sessions/s1/events') {
            return new Response(new ReadableStream<Uint8Array>(), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        }

        throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
    };

    const adapted = viewAwareFetch(inner, { root: '/api' });

    const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : init?.body;

        server.calls.push({ url, method, body });

        // The thread create is NOT offered by the display adapter (its threads route is
        // GET-only), so the fixture answers it itself — and answers it with the contract's
        // own shape: `201 { thread: { id, agent, … } }`, never a document.
        if (url === THREADS_CANON && method === 'POST') {
            server.created.push(body ?? {});
            if (server.failThreads !== undefined) return json({ error: { message: server.failThreads } }, 409);

            const agent = String((body ?? {}).agent ?? '');
            // One DISTINCT conversation per create (`created` is pushed above, so the first is
            // `thread-agent-1`). A fixed id would let a second commit hide behind the first
            // conversation's id, and F1's "the next send still targets the cycled agent" needs
            // the second thread to be visibly its own.
            const sequence = server.created.length;

            return json({ thread: { id: `thread-agent-${sequence}`, session_id: 's1', agent, origin: 'host', status: 'idle', sequence, label: `AG${sequence}`, messages: [] } }, 201);
        }

        return adapted(input, init);
    };

    vi.stubGlobal('fetch', vi.fn(transport));

    return server;
};

// --- device stub (verbatim from composer-control.test.ts:205-241) -----------------
//
// `main.ts` creates its MediaQueryLists ONCE at module scope, so the stub must be
// installed before `await import('./main')`. Keying by query string keeps the two axes
// independent exactly like a browser evaluates them: `(max-width: 860px)` is layout only,
// `(pointer: fine)` is the shell's single input-device axis (T1/D7: the agent gestures
// ride THAT axis, no second media query is allowed).
type MediaListener = (event: { matches: boolean }) => void;

type MediaStub = {
    matches: boolean;
    media: string;
    addEventListener: (type: string, listener: MediaListener) => void;
    removeEventListener: (type: string, listener: MediaListener) => void;
};

const stubMedia = (options: { fine?: boolean; phone?: boolean } = {}): { setFine: (matches: boolean) => void } => {
    const entries = new Map<string, { stub: MediaStub; listeners: Set<MediaListener> }>();

    const create = (media: string, matches: boolean): void => {
        const listeners = new Set<MediaListener>();
        const stub: MediaStub = {
            matches,
            media,
            addEventListener: (_type: string, listener: MediaListener): void => {
                listeners.add(listener);
            },
            removeEventListener: (_type: string, listener: MediaListener): void => {
                listeners.delete(listener);
            }
        };

        entries.set(media, { stub, listeners });
    };

    create('(pointer: fine)', options.fine ?? false);
    create('(max-width: 860px)', options.phone ?? false);

    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => {
            const entry = entries.get(query);
            if (entry === undefined) throw new Error(`unexpected media query: ${query}`);

            return entry.stub;
        })
    );

    // What a real device switch does: flip `matches` on the ONE input-device axis and notify
    // the listeners the shell registered on it (main.ts:5688 repaints the composer, and T1
    // repaints the chip's press promise, from that callback).
    return {
        setFine: (matches: boolean): void => {
            const entry = entries.get('(pointer: fine)');
            if (entry === undefined) return;
            entry.stub.matches = matches;

            for (const listener of entry.listeners) listener({ matches });
        }
    };
};

// The touch sequence a finger produces. `pointerType: 'touch'` is what arms the gesture
// machine at all (D7: a mouse pointer on a touch-capable machine keeps the desktop
// contract), and jsdom 29 builds real PointerEvents with it.
const FINGER = { pointerId: 7, pointerType: 'touch' as const, clientX: 40, clientY: 22 };

const pointer = (type: string, init: PointerEventInit): PointerEvent =>
    new PointerEvent(type, { bubbles: true, cancelable: true, ...init });

const touchDown = (target: HTMLElement): void => {
    target.dispatchEvent(pointer('pointerdown', { button: 0, ...FINGER }));
};

const touchUp = (): void => {
    document.dispatchEvent(pointer('pointerup', FINGER));
};

// A real browser synthesises `click` after `pointerup`; the page has to live with that,
// so the test replays it in the same order rather than pretending it does not happen.
const synthClick = (target: HTMLElement): void => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush(3);
};

const submit = async (text: string): Promise<void> => {
    const input = field();
    input.textContent = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush(4);
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

// `afterEach` closes any dialog a case left open. The dialog's Tab trap runs on the
// SHARED `document` in capture phase (ui/dialog.ts:612) and the shell module is torn down by
// the next case's `vi.resetModules()`, so an open dialog would keep consuming every later
// `Tab` in this file — the same discipline `composer-agent-control.test.ts:142-151` follows.
afterEach(async () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
        button.click();
    }
    await flush(1);
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// --- 1 + 2: the desktop cycle -----------------------------------------------------

it('walks the team in roster order on Tab and Shift+Tab, repainting chip and label, at zero requests', async () => {
    stubMedia({ fine: true });
    const server = stubServer();

    await boot();

    // The chip starts at the team's ENTRY agent, and the live region starts silent: an
    // announcement is a CYCLE event, not a repaint (D10).
    expect(chipName()).toBe('Instruct');
    expect(chipAgent()).toBe('instruct');
    expect(liveText()).toBe('');

    // Every request so far is a read. The whole D2 promise lives in this assertion: a
    // cycle is a local choice, so NOTHING may be written — no PATCH on the harness or the
    // session, no POST, no promote of the team's entry agent.
    expect(writesOf(server.calls)).toEqual([]);

    // Forward walk, in the order the DEFINITION declares the team.
    pressTab();
    expect(chipName()).toBe('Researcher');
    expect(chipAgent()).toBe('research');
    // The chip's own name is not a live region, so the shell says the change out loud
    // beside it (D10). The sentence carries the ROSTER POSITION (F4): two members whose
    // catalogue title is missing both read the neutral word `Agent`, so a title-only
    // sentence could repeat byte-for-byte and some assistive tech would stay silent.
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');

    pressTab();
    expect(chipName()).toBe('Coder');
    expect(chipAgent()).toBe('workspace');
    expect(liveText()).toBe('Agent for the next message: Coder (3 of 3).');

    // Wrap-around at the end of the roster, then back through the middle.
    pressTab();
    expect(chipName()).toBe('Instruct');
    expect(chipAgent()).toBe('instruct');
    expect(liveText()).toBe('Agent for the next message: Instruct (1 of 3).');

    pressTab(true);
    expect(chipName()).toBe('Coder');
    expect(liveText()).toBe('Agent for the next message: Coder (3 of 3).');

    const backToResearcher = pressTab(true);
    expect(chipName()).toBe('Researcher');

    // Still zero writes after five cycles, and the keystroke was CONSUMED — a `Tab` that
    // cycled must not also move focus out of the field. `defaultPrevented` is the claim:
    // a synthetic keydown cannot change `document.activeElement` in jsdom, so asserting the
    // focus (as this case used to) could never fail whatever the shell did.
    expect(writesOf(server.calls)).toEqual([]);
    expect(backToResearcher.defaultPrevented).toBe(true);

    // A cycle is not a send: the routing line still describes what WOULD happen (a new
    // conversation on a card with no threads), and no dialog opened on the way.
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
});

it('leaves Tab to the browser on a one-agent team, and states the reason in the accessible name', async () => {
    stubMedia({ fine: true });
    // A locked roster (D6): nothing to switch between, so `Tab` keeps doing what a browser
    // does with it and the control says WHY instead of being a dead button.
    const server = stubServer({ single: true });

    await boot();

    expect(chipName()).toBe('Instruct');
    // The reason is IN the name, so the fall-through is not a silent dead control (D6).
    expect(chip().getAttribute('aria-label')).toBe(
        'Agent: Instruct. This team has one agent, so there is nothing to switch between. Open agent settings.'
    );

    const event = pressTab();

    expect(chipName()).toBe('Instruct');
    expect(liveText()).toBe('');
    expect(writesOf(server.calls)).toEqual([]);
    // The composer did NOT claim the keystroke: `defaultPrevented` stays false, which is
    // exactly the browser's own focus move.
    expect(event.defaultPrevented).toBe(false);
});

it('leaves Tab to the dialog trap while the agent settings dialog is open', async () => {
    stubMedia({ fine: true });
    stubServer();

    await boot();

    chip().click();
    await flush();
    expect(document.querySelector('.dialog')).not.toBeNull();

    // The dialog owns `Tab` (ui/dialog.ts:551-570, attached on `document` in CAPTURE phase
    // at :612, and every branch of that trap calls `preventDefault`). Capture runs before
    // the target phase, so by the time the keystroke reaches the composer's field listener
    // the dialog has already consumed it and moved focus to the next control inside itself.
    // Cycling an agent on top of that would change the app while the reader is filling the
    // modal.
    //
    // G1: the event ORIGINATES AT THE FIELD, because that is the only way it reaches the
    // listener under test (`input.addEventListener('keydown', …)`, main.ts:15840) — a Tab
    // dispatched on `document` never runs that handler at all, so the old version of this
    // case passed even with the `defaultPrevented` bail deleted. The field is deliberately
    // NOT focused here: a modal keeps the focus, and the dialog's trap reads
    // `document.activeElement` to compute its cycle, exactly as it does for a real press.
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    field().dispatchEvent(event);
    await flush();

    // BOTH halves of the claim, or the case proves nothing:
    //   1. the dialog really did consume the keystroke (the bail's trigger condition), and
    //   2. the composer therefore did NOT cycle — delete `if (event.defaultPrevented)
    //      return;` (main.ts:15940) and the chip moves to `Researcher` here.
    expect(event.defaultPrevented).toBe(true);
    expect(chipName()).toBe('Instruct');
    expect(chipAgent()).toBe('instruct');
    expect(liveText()).toBe('');
    expect(document.querySelector('.dialog')).not.toBeNull();
    // Focus stayed inside the panel: the trap, not the composer, answered the keystroke.
    expect(document.querySelector('.dialog')?.contains(document.activeElement ?? null)).toBe(true);
});

// --- 3: the touch device ----------------------------------------------------------

it('cycles on a tap and opens the settings on a press-and-hold, and the synthesised click fires nothing twice', async () => {
    stubMedia({ fine: false });
    const server = stubServer();

    await boot();

    // The name carries BOTH presses on a touch device, because there is no hover tooltip
    // and no keyboard `Tab` there (D10).
    expect(chip().getAttribute('aria-label')).toBe(
        'Agent: Instruct. Tap to switch agent, press and hold for settings.'
    );
    // `aria-haspopup="dialog"` is gone: a plain press does NOT open a dialog on this
    // device, so advertising one would be a lie.
    expect(chip().getAttribute('aria-haspopup')).toBeNull();
    // The tooltip keeps the settings sentence AND adds the two presses, joined as
    // sentences (D10).
    expect(chip().title).toBe(
        'Edits here change the harness template used by new sessions. Tap to switch agent; press and hold to open agent settings.'
    );

    // TAP: down and up well inside the hold threshold, then the click the browser
    // synthesises. One cycle, no dialog.
    touchDown(chip());
    expect(chip().dataset.hold).toBe('armed');
    touchUp();
    expect(chip().dataset.hold).toBeUndefined();
    expect(chipName()).toBe('Researcher');
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');

    synthClick(chip());
    await flush();
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
    expect(chipName()).toBe('Researcher');

    // HOLD: the affordance appears while the finger is down, the dialog opens when the
    // threshold passes, and the state survives until release (D8). Fake timers only from
    // here: the boot above already ran on the real clock, and the hold's own work is
    // synchronous.
    vi.useFakeTimers();
    touchDown(chip());
    expect(chip().dataset.hold).toBe('armed');
    vi.advanceTimersByTime(499);
    expect(chip().dataset.hold).toBe('armed');
    vi.advanceTimersByTime(1);
    expect(chip().dataset.hold).toBe('held');
    expect(chipName()).toBe('Researcher');

    document.dispatchEvent(pointer('pointerup', FINGER));
    vi.useRealTimers();
    expect(chip().dataset.hold).toBeUndefined();

    // The hold's synthesised click is swallowed by the same guard, so the dialog is not
    // re-opened and the agent did not ALSO cycle.
    synthClick(chip());
    await flush();
    expect(chipName()).toBe('Researcher');
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(1);

    // Two gestures, zero writes.
    expect(writesOf(server.calls)).toEqual([]);
});

it('opens the settings on a plain activation of the touch chip, and cycles on the desktop click without opening it', async () => {
    stubMedia({ fine: false });
    stubServer();

    await boot();

    // Keyboard / assistive activation on a touch device produces a click with NO pointer
    // events at all. The gesture machine never armed, so the chip keeps the desktop
    // promise: that press opens the dialog rather than guessing at a cycle.
    chip().click();
    await flush();
    expect(document.querySelector('.dialog')).not.toBeNull();
});

it('opens the settings from a desktop click, and leaves the selection where it was', async () => {
    stubMedia({ fine: true });
    stubServer();

    await boot();

    // The fine-pointer half of D7, pinned on a team that CAN cycle: the desktop click is
    // unchanged by the feature, and a cycle is not a side effect of it.
    pressTab();
    expect(chipName()).toBe('Researcher');

    chip().click();
    await flush();
    expect(document.querySelector('.dialog')).not.toBeNull();
    expect(chipName()).toBe('Researcher');
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');
});

// --- 4: the commit at send -------------------------------------------------------

it('commits a cycled agent at send as one thread create plus that thread task, in that order', async () => {
    stubMedia({ fine: true });
    const server = stubServer({ session: snapshot() });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    expect(chipName()).toBe('Instruct');
    expect(targetText()).toBe('New thread');

    pressTab();
    expect(chipName()).toBe('Researcher');
    // Pending, not applied: the routing line names a NEW conversation, because the choice
    // has not been committed to a thread yet.
    expect(targetText()).toBe('New thread');
    expect(server.created).toEqual([]);

    await submit('second question');

    // THE CONTRACT, in order: a conversation OWNED by the selected agent, then the message
    // INTO it. Threads never change owner, so the create is the whole commit — no new
    // route, no `agent` field on the task.
    expect(server.created).toEqual([{ agent: 'research' }]);
    expect(server.tasks).toHaveLength(1);
    expect(server.tasks[0]).toEqual({ input: 'second question', thread_id: 'thread-agent-1' });

    // The full write log for the send: TWO posts, in this order. (`POST /models` is the
    // catalogue query the shell runs at boot — a read wearing the POST verb — so it is not
    // part of what a send costs.)
    expect(writesOf(server.calls)).toEqual([`POST ${THREADS_CANON}`, `POST ${TASKS_CANON}`]);

    // The chip falls back to the entry agent once the choice is spent: the next message
    // goes to the team's entry agent unless the reader cycles again.
    expect(chipName()).toBe('Instruct');
});

it('sends an entry-agent message with no thread request at all', async () => {
    stubMedia({ fine: true });
    const server = stubServer({ session: snapshot() });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    await submit('first question');

    expect(server.tasks).toEqual([{ input: 'first question' }]);
    expect(server.created).toEqual([]);
    expect(writesOf(server.calls)).toEqual([`POST ${TASKS_CANON}`]);
});

it('restores the draft and names the refusal when the thread create fails, and submits no task', async () => {
    stubMedia({ fine: true });
    const server = stubServer({ session: snapshot() });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    pressTab();
    expect(chipName()).toBe('Researcher');

    server.failThreads = 'Unknown agent "research".';

    await submit('second question');

    // No message was sent as some other agent behind the reader's back, and nothing was
    // lost: the draft is back in the field for a retry.
    expect(server.tasks).toEqual([]);
    expect(field().textContent).toBe('second question');
    expect(chipName()).toBe('Researcher');

    // The refusal rides the shell's EXISTING submit-failure surface (the optimistic tile
    // goes `error`, this notice states the server's own sentence): the thread create is
    // part of the submit, so a failure is reported exactly where a failed task is, and the
    // reader is never left with a silent downgrade to another agent.
    const notices = [...document.querySelectorAll<HTMLElement>('.log .notice')].map(
        (node) => [node.dataset.tone, node.textContent]
    );
    expect(notices).toEqual([['error', 'task failed: Unknown agent "research".']]);

    // And the failed attempt left exactly one thread request: no task, no retry storm.
    expect(server.created).toEqual([{ agent: 'research' }]);

    // G8: the retained choice is not decoration — a retry re-creates the conversation and runs
    // as the SAME agent. The refused attempt is not reused either: the shell asked for a new
    // conversation and the server answered with its own id, so `thread-agent-2` is the one the
    // message goes into, and the chip still names the researcher up to that point.
    server.failThreads = undefined;

    await submit('second question');

    expect(server.created).toEqual([{ agent: 'research' }, { agent: 'research' }]);
    expect(server.tasks).toEqual([{ input: 'second question', thread_id: 'thread-agent-2' }]);
    expect(chipName()).toBe('Instruct');
});

// --- 5: focus outranks the choice ------------------------------------------------

it('drops the focused conversation when the reader picks another agent, and runs the next message as that agent', async () => {
    stubMedia({ fine: true });
    const server = stubServer({
        session: snapshot({
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'IN1' }],
            turns: [turn()]
        })
    });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    // Focus conversation IN1 the way a reader does (ui/turns.ts `expand`). A focused
    // conversation OWNS the next message: it continues IN1, which runs as Instruct.
    byClass('.tile[data-turn-id="turn-1"] .tile-select', 'button').click();
    await flush();
    expect(targetText()).toBe('Continuing IN1');

    pressTab();

    // D5: selecting deliberately releases the focus — keeping it would have discarded the
    // choice silently, and a released focus is fully reversible (clicking the tile again
    // re-focuses it).
    expect(targetText()).toBe('New thread');
    expect(document.querySelector('.tile.is-expanded')).toBeNull();
    expect(chipName()).toBe('Researcher');

    await submit('third question');

    // The choice is what ran: a thread owned by the selected agent, then the message into
    // it — the same two requests the unfocused case spends.
    expect(server.created).toEqual([{ agent: 'research' }]);
    expect(server.tasks[0]).toEqual({ input: 'third question', thread_id: 'thread-agent-1' });
});

// --- 6: a cycle during the flight, and the promise the routing line makes ----------
//
// The correction round's findings, each pinned by the case that fails without it.

it('keeps a choice made while a send is in flight, and runs the NEXT message as that agent', async () => {
    stubMedia({ fine: true });
    const server = stubServer({ session: snapshot() });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    // The submit goes out and stays IN FLIGHT: main.ts holds `submitting` from :15583 until
    // :15771, covering session create, the optional thread create and this POST. That window
    // is where a `Tab` (or, on a phone, a tap — the only way to do it there) belongs to the
    // NEXT message, not to the one already on the wire.
    server.holdTasks = true;
    await submit('first question');
    expect(server.tasks).toEqual([{ input: 'first question' }]);
    expect(server.created).toEqual([]);

    const tab = pressTab();

    // The keystroke is claimed, the chip moved, and the cycle still costs nothing mid-flight.
    expect(tab.defaultPrevented).toBe(true);
    expect(chipName()).toBe('Researcher');
    expect(chipAgent()).toBe('research');
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');
    expect(server.created).toEqual([]);

    // The receipt lands. F1: the choice that was SPENT is the one this send carried (none),
    // so the fresh one survives — delete the `instance.agentSelection === spentAgent` gate
    // (main.ts:15610) and the chip reverts to `Instruct` here with nothing said about it,
    // which makes the announcement above a lie.
    server.releaseTasks?.();
    await flush(4);

    expect(chipName()).toBe('Researcher');
    expect(chipAgent()).toBe('research');
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');

    // The board follows the active row, so the receipt brought the conversation that RECEIVED
    // message 1 into view. This fixture never describes that conversation in its roster (on the
    // real wire the id and its agent arrive on the stream's `turn.upsert`, not on the receipt),
    // and a focused conversation the roster cannot describe outranks a pending choice:
    // `resolveSubmitTarget` keeps continuing it, and `defaultAgentOf` refuses to invent an agent
    // for it — the F3 rule, pinned by its own case below. So the line honestly promises THAT
    // continuation for as long as the tile is open, and the tap becomes the destination when
    // the reader addresses it: collapsing the tile is the reader's own deliberate unfocus
    // (ui/turns.ts `collapse`), the same release D5 performs when a cycle and a focus conflict.
    expect(targetText()).toBe('Continuing thread');

    byClass('.tile[data-turn-id="turn-new-1"] .tile-select', 'button').click();
    await flush();
    expect(targetText()).toBe('New thread');

    // And the survivor is REAL: the next send pays for a conversation the researcher owns and
    // posts into it, rather than running as the entry agent the reader had just rejected.
    await submit('second question');

    expect(server.created).toEqual([{ agent: 'research' }]);
    expect(server.tasks[1]).toEqual({ input: 'second question', thread_id: 'thread-agent-1' });

    // A spent choice still cannot leak: this send consumed the survivor, so a THIRD message
    // costs no thread request at all. It goes to the conversation now in view (the one message
    // 2 landed in, which the board followed), exactly as an untouched composer always has —
    // the point is that no agent choice is left behind to mint another conversation.
    expect(chipName()).toBe('Instruct');
    await submit('third question');
    expect(server.created).toEqual([{ agent: 'research' }]);
    expect(server.tasks[2]).toEqual({ input: 'third question', thread_id: 'thread-agent-1' });
});

it('promises the conversation the send will actually use when a choice and a focus disagree', async () => {
    stubMedia({ fine: true });
    const server = stubServer({
        session: snapshot({
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'IN1' }],
            turns: [turn()]
        })
    });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    // Cycle to the researcher with NOTHING focused, then open IN1 again. The choice is still
    // pending, and IN1 belongs to `instruct`, so the send must mint a fresh conversation for
    // the researcher (D3). F2: the routing line said "Continuing IN1" while that happened —
    // the one reachable path where the painted promise and the POST disagreed.
    pressTab();
    expect(chipName()).toBe('Researcher');

    byClass('.tile[data-turn-id="turn-1"] .tile-select', 'button').click();
    await flush();

    const label = byClass('.composer-target', 'p');
    expect(label.textContent).toBe('New thread');
    expect(label.dataset.mode).toBe('new');

    await submit('fourth question');

    // The request matches what the line said: a thread for the selected agent, and the message
    // into THAT thread — IN1 was not continued.
    expect(server.created).toEqual([{ agent: 'research' }]);
    expect(server.tasks[0]).toEqual({ input: 'fourth question', thread_id: 'thread-agent-1' });
});

it('promises the continuation when the pending choice already matches the focused conversation', async () => {
    stubMedia({ fine: true });
    const server = stubServer({
        session: snapshot({
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, label: 'IN1' }],
            turns: [turn()]
        })
    });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    // The other side of F2, so the fix cannot just be "a pending choice always means a new
    // thread": walk the whole roster back to the ENTRY agent (`research` → `workspace` →
    // `instruct`), then focus IN1. The focused conversation already runs the selected agent,
    // so the line must keep promising it and the send must cost nothing extra.
    pressTab();
    pressTab();
    pressTab();
    expect(chipAgent()).toBe('instruct');

    byClass('.tile[data-turn-id="turn-1"] .tile-select', 'button').click();
    await flush();

    expect(targetText()).toBe('Continuing IN1');

    await submit('fifth question');

    expect(server.created).toEqual([]);
    expect(server.tasks[0]).toEqual({ input: 'fifth question', thread_id: 'thread-1' });
});

it('continues a focused conversation the roster does not describe instead of minting a stray thread', async () => {
    stubMedia({ fine: true });
    // A partial/legacy snapshot: the turn names `thread-9` and the document carries no thread
    // roster at all. `resolveSubmitTarget` (ui/threads.ts:632-683) continues that id anyway,
    // because the id came from a turn record this session produced.
    const server = stubServer({ session: snapshot({ turns: [turn({ threadId: 'thread-9' })] }) });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    pressTab();
    expect(chipAgent()).toBe('research');

    byClass('.tile[data-turn-id="turn-1"] .tile-select', 'button').click();
    await flush();

    // F3: whose agent that conversation runs is not knowable from this snapshot, so it is not
    // the browser's to choose. Before the fix `defaultAgentOf` answered with the ENTRY agent,
    // `commitAgent` came out true, and the send abandoned the focused conversation for a rival
    // thread. The line and the request now agree on continuing it.
    expect(targetText()).toBe('Continuing thread');

    await submit('sixth question');

    expect(server.created).toEqual([]);
    expect(server.tasks[0]).toEqual({ input: 'sixth question', thread_id: 'thread-9' });
});

it('speaks the fallback when the choice is spent, so the region is never stale', async () => {
    stubMedia({ fine: true });
    const server = stubServer({ session: snapshot() });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    pressTab();
    const cycled = liveText();
    expect(cycled).toBe('Agent for the next message: Researcher (2 of 3).');

    await submit('second question');

    // F4: the chip fell back to the entry agent, and the sentence fell back with it. Left as
    // it was, the region would still read "Researcher" next time the reader's focus passed it,
    // and cycling back to the researcher would hand the region a string it had already spoken.
    expect(chipName()).toBe('Instruct');
    expect(liveText()).toBe('Agent for the next message: Instruct (1 of 3).');
    expect(liveText()).not.toBe(cycled);

    // So the repeat cycle IS a change: a different sentence, and the same one after that is
    // again different from what precedes it.
    pressTab();
    expect(liveText()).toBe(cycled);
    pressTab(true);
    expect(liveText()).toBe('Agent for the next message: Instruct (1 of 3).');
});

it('un-says the announcement when a new conversation makes the choice meaningless', async () => {
    stubMedia({ fine: true });
    const server = stubServer({ session: snapshot() });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    pressTab();
    expect(chipAgent()).toBe('research');
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');

    // G6: `+ New session` starts a different conversation, and the agent picked for the one
    // being left says nothing about it (D5). The choice is dropped WITHOUT announcing a
    // replacement — nothing was cycled.
    byClass('.new-session', 'button').click();
    await flush(3);

    expect(chipAgent()).toBe('instruct');
    expect(liveText()).toBe('');
    // No send, no conversation minted by the navigation alone.
    expect(server.created).toEqual([]);
    expect(server.tasks).toEqual([]);
});

it('keeps the pending choice across a device repaint, and repaints the press promise with it', async () => {
    const media = stubMedia({ fine: true });
    const server = stubServer({ session: snapshot() });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    pressTab();
    expect(chipAgent()).toBe('research');

    // G4: a pointer-device switch repaints the composer (main.ts:5688's `change` listener,
    // which T1 extends with the chip-only `paintAgentSlot`). The choice is STATE, not paint,
    // so it survives the rebuild — while the control's PROMISE does follow the axis, or a
    // tablet plugged into a keyboard would keep advertising a keystroke its reader cannot
    // press, and a phone would keep advertising `Tab`.
    media.setFine(false);
    await flush();

    expect(chipAgent()).toBe('research');
    expect(chipName()).toBe('Researcher');
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');
    expect(chip().getAttribute('aria-label')).toBe(
        'Agent: Researcher. Tap to switch agent, press and hold for settings.'
    );
    // Still a local choice: a repaint, like a cycle, writes nothing.
    expect(writesOf(server.calls)).toEqual([]);

    // And the survivor is still what the next send commits.
    await submit('seventh question');
    expect(server.created).toEqual([{ agent: 'research' }]);
    expect(server.tasks[0]).toEqual({ input: 'seventh question', thread_id: 'thread-agent-1' });
});

it('lets the open reference list answer Tab while the chip keeps the pending choice', async () => {
    stubMedia({ fine: true });
    const server = stubServer({ session: snapshot({ turns: [turn()] }) });
    localStorage.setItem(SESSION_KEY, 's1');

    await boot();

    // A pending choice AND an open `#` list — the only state in which the two Tab owners can
    // actually collide, and the state composer-control.test.ts cannot build (its team has one
    // agent, so the cycle leg can never answer there and its Tab cases cannot see a cycle).
    pressTab();
    expect(chipAgent()).toBe('research');

    // The field's `value`/`setSelectionRange` are the textarea-compatibility façade
    // ui/editor.ts:756-800 installs on the contentEditable surface (main.ts:4399).
    const draft = field() as HTMLElement & { value: string; setSelectionRange: (start: number, end?: number) => void };
    draft.value = 'ask #';
    draft.setSelectionRange(5, 5);
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    const popup = byClass('.composer-popup', 'div');
    expect(popup.hidden).toBe(false);
    expect(draft.getAttribute('aria-activedescendant')).toBe('composer-option-0');

    const tab = pressTab();

    // The LIST owns the keystroke (main.ts:15906-15923): it picks its active row, consumes the
    // event, and RETURNS before the cycle leg — delete that `return` and the chip moves to
    // `workspace` here, i.e. the reader's mention would silently re-address the next message.
    expect(tab.defaultPrevented).toBe(true);
    expect(popup.hidden).toBe(true);
    expect(chipAgent()).toBe('research');
    expect(chipName()).toBe('Researcher');
    // The sentence is the cycle's, and a Tab the list consumed is not a cycle: unchanged.
    expect(liveText()).toBe('Agent for the next message: Researcher (2 of 3).');
    // The mention became a real binding, and nothing was sent.
    expect(draft.value).toBe('ask #IT1');
    const binding = draft.querySelector<HTMLElement>('[data-chip="reference"]');
    expect(binding?.dataset.referenceTurn).toBe('turn-1');
    expect(server.tasks).toEqual([]);
    // And the choice is untouched, so the next send still commits the researcher.
    await submit('eighth question');
    expect(server.created).toEqual([{ agent: 'research' }]);
    expect(server.tasks[0]).toEqual({ input: 'eighth question', thread_id: 'thread-agent-1' });
});
