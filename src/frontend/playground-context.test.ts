// R7 — the Tools view is a GLOBAL playground with its own temporary context.
//
// What is pinned here (the isolation the whole request is about):
//   - a session-bound call NEVER sends the selected conversation's id, and the
//     temporary session is never adopted into it (no sessions row, no remembered
//     session id, no snapshot refresh of the chat);
//   - the temporary context is created on the harness the PLAYGROUND picked (the first
//     descriptor the server reports), so moving to another conversation changes nothing;
//   - it is preserved across playground calls (toolRequest then task see one
//     session) and deleted when the playground closes;
//   - closing while the create is still in flight is safe: the late answer is deleted
//     and the call does not run;
//   - a tool that is not session-bound still executes directly, with no sessionId key.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts playground-context.test.ts

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';
import { sessionToolReads } from './session-config-test-support';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const descriptor = (name: string, overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name,
        title: name === 'alpha' ? 'Alpha' : 'Beta',
        description: `The ${name} harness.`,
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: ['toolRequest', 'tasks'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const coreTool = (name: string, required: string[]): ToolDescriptor => ({
    name,
    group: 'Core tools',
    description: `${name} core tool`,
    tags: ['core', 'harness'],
    visibility: 'core',
    sessionBound: true,
    parameters: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        required
    }
});

const fileReadTool: ToolDescriptor = {
    name: 'read',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files'],
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths']
    }
};

const snapshot = (id: string, harness = 'alpha'): SessionSnapshot =>
    ({
        id,
        harness,
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: []
    }) as SessionSnapshot;

type Call = { url: string; method: string | undefined; body: unknown; keepalive: boolean | undefined };

// The conversation the READER owns. It exists in the roster before boot, so any
// adoption of the playground's session would be visible as a second row.
const CHAT = 'chat-1';

// The conversation the OTHER harness (beta) owns. T4 makes this fixture necessary rather than
// optional: the ⚒ pane describes a CONVERSATION, so a card move onto a harness that has none hides
// the toggle and closes the pane — and "the playground keeps running on its own harness after the
// chat moved" could no longer be reached at all.
const CHAT_B = 'chat-2';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

// A stub server with a queue of created session ids, so a test can see exactly how many
// sessions the playground made and which id each call carried.
const stubServer = (options: {
    presets: HarnessDescriptor[];
    tools: ToolDescriptor[];
    createdIds?: string[];
    holdCreate?: () => Promise<unknown>;
    // T4: give the SECOND harness a conversation of its own. The ⚒ pane describes a conversation,
    // so a card move onto a harness with none hides the toggle and closes the pane; only the
    // harness-switch case needs the beta conversation, and every other test keeps the single-row
    // directory its assertions count.
    withBeta?: boolean;
}): Call[] => {
    const calls: Call[] = [];
    const pool = [...(options.createdIds ?? ['temp-1', 'temp-2', 'temp-3'])];
    // Only the sessions this stub server actually created, so the directory answer is a
    // real roster: the playground's session appears in it while it lives, which is the
    // leak the client-side filters have to stop.
    const made: string[] = [];
    // The conversations the directory reports: `CHAT` on alpha (the reader's own, open at boot),
    // the playground's temp sessions while they live, and `CHAT_B` on beta when the fixture asks.
    const conversations = (): SessionSnapshot[] => [
        snapshot(CHAT),
        ...(options.withBeta === true ? [snapshot(CHAT_B, 'beta')] : [])
    ];
    const roster = (): SessionSnapshot[] => [...conversations(), ...made.map((id) => snapshot(id))];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body, keepalive: init?.keepalive });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: options.presets,
                    tools: options.tools,
                    defaults,
                    sessions: conversations(),
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            // T4: the ⚒ pane lists the CONVERSATION's toolbox, and each row's runner reads the
            // deployment's identified schema (a toolbox row carries none). Both answers come from
            // `options.tools`, the same list this fixture puts in its boot document, so the pane,
            // the catalogue and the runner agree by construction
            // (./session-config-test-support.ts `sessionToolReads`).
            const toolReads = sessionToolReads(options.tools, url, method);

            if (toolReads !== undefined) return toolReads;

            // The directory the rail reads.
            if (url === '/api/sessions' && method === undefined) {
                return json({ sessions: roster() });
            }

            if (url === '/api/sessions' && method === 'POST') {
                const id = pool.shift() ?? 'temp-x';
                const session = snapshot(id);
                // The race case: the answer only lands when the caller releases it.
                if (options.holdCreate !== undefined) await options.holdCreate();

                made.push(id);

                return json({ session }, 201);
            }

            if (url.startsWith('/api/sessions/') && url.endsWith('/cancel')) return json({ cancelled: false });

            if (url.match(/^\/api\/sessions\/[^/]+$/) && method === undefined) {
                const id = decodeURIComponent(url.split('/').pop() as string);
                // The roster is the authority on WHICH harness a conversation belongs to (the beta
                // card opens `CHAT_B`, not an alpha record wearing a beta id); anything else is a
                // session this stub minted on alpha.
                const record = roster().find((candidate) => candidate.id === id);

                return json({ session: record ?? snapshot(id) });
            }

            if (url.match(/^\/api\/sessions\/[^/]+$/) && method === 'DELETE') return json({ deleted: true });

            if (url === '/api/tools/toolRequest' && method === 'POST') {
                return json({ ok: true, result: { enabled: ['read'], tools: ['read'], truncated: false, remaining: 0 }, durationMs: 7 });
            }
            // `task` (R9-R11: the old todoManage) answers with the CURRENT bounded list.
            // Only the URL and the session id are asserted below, so the stub keeps the
            // documented top-level shape and no invented paging internals.
            if (url === '/api/tools/task' && method === 'POST') {
                return json({ ok: true, result: { tasks: [], counts: {}, page: {} }, durationMs: 3 });
            }
            if (url === '/api/tools/read' && method === 'POST') {
                return json({ ok: true, result: { path: 'package.json', content: '{}' }, durationMs: 2 });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    return calls;
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

const toolsToggle = (): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (found === null) throw new Error('missing global Tools toggle');
    return found;
};

const openTool = async (name: string): Promise<void> => {
    if (toolsToggle().getAttribute('aria-pressed') !== 'true') toolsToggle().click();
    await flush();

    // R1 (swap): the runner opens from the row's corner INFO mark; the tile is the enablement
    // switch, so the playground helper must not press it.
    const button = document.querySelector<HTMLButtonElement>(`.tool-tab-info[data-tool="${name}"]`);
    if (button === null) throw new Error(`missing tool entry ${name}`);
    button.click();
    await flush();
};

// T4: opening the ⚒ pane reads the conversation it describes — `GET /sessions/{id}/tools` — and
// each row's runner reads the deployment's identified schema. The toolbox read is the ONE read of
// the reader's own conversation the pane owes, so the playground claims these tests pin ("the call
// ran in its OWN session; the chat was never touched") are stated over everything except that
// route, and the route itself is pinned separately at each site.
const excludingToolbox = (entries: readonly Call[]): Call[] =>
    entries.filter((call) => /^\/api\/sessions\/[^/]+\/tools/.test(call.url) === false);

// The exact toolbox call the pane owes, so "the pane read the conversation" stays a pinned fact
// rather than a permission slip.
const TOOLBOX_CALL = (id: string): Call => ({
    url: `/api/sessions/${id}/tools?limit=25`,
    method: undefined,
    body: undefined,
    keepalive: undefined
});

const argsBox = (): HTMLTextAreaElement => {
    const found = document.querySelector<HTMLTextAreaElement>('.tool-args');
    if (found === null) throw new Error('missing runner arguments');
    return found;
};

const call = (): void => {
    const button = document.querySelector<HTMLButtonElement>('.tool-card button.primary');
    if (button === null) throw new Error('missing call button');
    button.click();
};

// T9: the directory dashboard opens from the harness title button, and that button is
// DISABLED while the tools view owns the head. Leaving the playground (close the runner,
// press the Tools toggle) is what makes the reader's directory reachable again, so this is
// how a test answers "is this conversation listed?" after a tool call.
const backToChat = async (): Promise<void> => {
    document.querySelector<HTMLButtonElement>('.dialog-close')?.click();
    await flush();

    if (toolsToggle().getAttribute('aria-pressed') === 'true') toolsToggle().click();
    await flush();
};

const responseBox = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('.tool-output .card-body');
    if (found === null) throw new Error('missing response box');
    return found;
};

// T3/R1 + T9: the directory is the Sessions dashboard of the dialog behind the harness
// title, so "is this conversation listed?" is answered by opening that layer, reading the
// pill wrappers (id on the wrapper, and on both controls inside it), and putting the layer
// away again.
const sessionPills = (): string[] => {
    const before = document.querySelector('.session-pills-bar-dialog') !== null;
    if (!before) {
        const trigger = document.querySelector<HTMLButtonElement>('.harness-title-button');
        if (trigger === null) throw new Error('missing harness title button');
        trigger.click();
    }

    const ids = [...document.querySelectorAll<HTMLElement>('.session-pill')].map(
        (node) => node.dataset.sessionId ?? ''
    );

    if (!before) document.querySelector<HTMLButtonElement>('.dialog-close')?.click();
    return ids;
};

const posts = (calls: Call[], url: string, method?: string): Call[] =>
    calls.filter((call) => call.url === url && (method === undefined || call.method === method));

const byPrefix = (calls: Call[], prefix: string, method?: string): Call[] =>
    calls.filter((call) => call.url.startsWith(prefix) && (method === undefined || call.method === method));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

it('runs a session-bound call in its own session and never adopts it into the chat', async () => {
    const calls = stubServer({
        presets: [descriptor('alpha'), descriptor('beta')],
        tools: [coreTool('toolRequest', ['tags']), fileReadTool]
    });
    await boot();
    // T21 R21: boot opened the reader's conversation, so the playground assertions below
    // measure only the traffic that follows the first load.
    const bootCalls = calls.length;

    // Boot selects the first harness, and the reader's conversation exists in the roster.
    expect(sessionPills()).toEqual([CHAT]);

    await openTool('toolRequest');
    argsBox().value = '{"tags":["web"]}';
    call();
    await flush();
    await flush();

    // The playground made its OWN session, on the harness IT picked (the first the server
    // reports) with the configured runtime defaults.
    const created = posts(calls, '/api/sessions', 'POST');
    expect(created).toHaveLength(1);
    expect(Object.keys(created[0].body as Record<string, unknown>).sort()).toEqual(['harness', 'settings']);
    expect((created[0].body as { harness: string }).harness).toBe('alpha');
    expect((created[0].body as { settings: { model: string } }).settings.model).toBe('m1');

    // The call carries the TEMPORARY id, never the reader's conversation id. `POST` is the
    // execution; the opened tool also spent one identified schema read (`GET` on the same path).
    expect(calls.find((entry) => entry.url === '/api/tools/toolRequest' && entry.method === 'POST')).toEqual({
        url: '/api/tools/toolRequest',
        method: 'POST',
        body: { parameters: { tags: ['web'] }, sessionId: 'temp-1' }
    });

    // No chat traffic from the playground: the runner re-read only its own temporary
    // session. T21 R21 opened the reader's conversation ONCE during boot (it is the newest
    // one alpha owns), so the assertion counts what happened after that.
    expect(excludingToolbox(byPrefix(calls.slice(bootCalls), '/api/sessions/chat-1'))).toEqual([]);
    // …and the toolbox read it DOES owe, stated exactly: one paged read of the conversation the
    // pane describes, made when the pane was opened, and nothing after it.
    expect(byPrefix(calls.slice(bootCalls), '/api/sessions/chat-1/tools')).toEqual([TOOLBOX_CALL(CHAT)]);

    // The temporary session is not a conversation: no row in the directory (the server's
    // list answer literally contains it), and it is not the session this browser remembers
    // — the pointer still names the conversation boot opened.
    // T9 removed the manual Refresh control, so the proof is the dashboard itself once the
    // tools view has handed the head back to the harness.
    await backToChat();
    expect(sessionPills()).toEqual([CHAT]);
    expect(localStorage.getItem('underload-harness-app:session')).toBe(CHAT);

    // The scratch board stayed untouched: a playground call paints no TOOL panels
    // anywhere. (The two live panels of T6 are always on the board for the conversation
    // on screen — they are not a playground side effect, so they are excluded here.)
    expect(
        [...document.querySelectorAll<HTMLElement>('.rail-right .panel')].filter(
            (node) => !node.classList.contains('panel-extension')
        )
    ).toHaveLength(0);
});

it('keeps the same temporary context across playground calls and stays on its own harness', async () => {
    const calls = stubServer({
        presets: [descriptor('alpha'), descriptor('beta')],
        // T4: the beta card needs a conversation of its own, or the harness switch closes the pane
        // (no conversation to describe) and `openTool` below has nothing to click.
        withBeta: true,
        tools: [coreTool('toolRequest', ['tags']), coreTool('tasks', [])]
    });
    await boot();

    await openTool('toolRequest');
    argsBox().value = '{"tags":["web"]}';
    call();
    await flush();
    await flush();

    // A SECOND tool in the same playground visit reuses the same context: discover-then-
    // use is the whole point, so one session must serve both calls.
    await openTool('tasks');
    // A merge call with NO arguments is a read of the current list (R9-R11).
    argsBox().value = '{}';
    call();
    await flush();
    await flush();

    expect(posts(calls, '/api/sessions', 'POST')).toHaveLength(1);
    expect(
        byPrefix(calls, '/api/tools/')
            .filter((entry) => entry.method === 'POST')
            .map((entry) => [
                entry.url.split('/').pop(),
                (entry.body as { sessionId?: string }).sessionId
            ])
    ).toEqual([
        ['toolRequest', 'temp-1'],
        // The tools view dials the re-keyed name (Decision J): `tasks`, not `task`.
        ['tasks', 'temp-1']
    ]);

    // The reader switches to ANOTHER conversation. That closes the tools view (and with it
    // the temporary session), and the next playground call still runs on the playground's
    // harness — NOT on the one the chat now uses.
    document.querySelector<HTMLButtonElement>('.harness-item[data-harness="beta"]')?.click();
    await flush();

    await openTool('tasks');
    // An entry with no `id` adds one task; the same call shape works in the
    // playground's fresh session because it observes the same temporary context.
    argsBox().value = '{"tasks":[{"text":"x"}]}';
    call();
    await flush();
    await flush();

    expect(
        posts(calls, '/api/sessions', 'POST').map((entry) => (entry.body as { harness: string }).harness)
    ).toEqual(['alpha', 'alpha']);
    expect(
        byPrefix(calls, '/api/tools/')
            .filter((entry) => entry.method === 'POST')
            .map((entry) => (entry.body as { sessionId?: string }).sessionId)
    ).toEqual(['temp-1', 'temp-1', 'temp-2']);

    // The closed context was deleted rather than left behind as a conversation.
    expect(byPrefix(calls, '/api/sessions/temp-1', 'DELETE')).toHaveLength(1);
});

it('deletes the temporary session when the playground closes, and starts a fresh one next visit', async () => {
    const calls = stubServer({
        presets: [descriptor('alpha')],
        tools: [coreTool('toolRequest', ['tags'])]
    });
    await boot();

    await openTool('toolRequest');
    argsBox().value = '{"tags":["web"]}';
    call();
    await flush();
    await flush();

    // Closing the tools view is the end of the context: exactly one DELETE, of the
    // temporary id only.
    toolsToggle().click();
    await flush();
    await flush();

    expect(byPrefix(calls, '/api/sessions/temp-1', 'DELETE')).toHaveLength(1);
    expect(byPrefix(calls, `/api/sessions/${CHAT}`, 'DELETE')).toEqual([]);

    // A new playground visit is a new context: the previous session is gone, so the next
    // core call creates another one (and the reader's conversation is still intact).
    await openTool('toolRequest');
    argsBox().value = '{"tags":["files"]}';
    call();
    await flush();
    await flush();

    expect(posts(calls, '/api/sessions', 'POST')).toHaveLength(2);
    expect(
        byPrefix(calls, '/api/tools/')
            .filter((entry) => entry.method === 'POST')
            .map((entry) => (entry.body as { sessionId?: string }).sessionId)
    ).toEqual(['temp-1', 'temp-2']);
    // T9: the reader's directory is only reachable from the chat view.
    await backToChat();
    expect(sessionPills()).toEqual([CHAT]);
});

it('discards a session whose create lands after the playground was closed', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });

    const calls = stubServer({
        presets: [descriptor('alpha')],
        tools: [coreTool('toolRequest', ['tags'])],
        createdIds: ['late-1'],
        holdCreate: () => held
    });
    await boot();

    await openTool('toolRequest');
    argsBox().value = '{"tags":["web"]}';

    // The create is in flight; the response box is captured because the dialog (and with
    // it the runner pane) goes away when the view closes.
    const box = responseBox();
    call();
    await flush();

    // Close the playground WHILE the create is pending.
    toolsToggle().click();
    await flush();

    // Now the server finally answers with the session it made.
    release?.();
    await flush();
    await flush();

    // The late record is removed instead of being adopted, and the call never ran. (`POST` is
    // the execution; the identified schema read the opened tool costs is not a call.)
    expect(byPrefix(calls, '/api/sessions/late-1', 'DELETE')).toHaveLength(1);
    expect(byPrefix(calls, '/api/tools/').filter((entry) => entry.method === 'POST')).toEqual([]);

    // The runner says honestly why nothing happened, as a structured response.
    expect(JSON.parse(box.textContent ?? '{}')).toEqual({
        ok: false,
        error: {
            kind: 'playground_closed',
            message:
                'The tools view was closed while the temporary session for alpha was being created, so it was discarded and this call did not run.'
        }
    });

    // The reader's conversation survived the whole race. T9: read it through the directory
    // dashboard, which needs the chat view back (the helper is a no-op if that already holds).
    await backToChat();
    expect(sessionPills()).toEqual([CHAT]);
});

it('calls a tool that needs no session directly, with no session traffic at all', async () => {
    const calls = stubServer({
        presets: [descriptor('alpha')],
        tools: [coreTool('toolRequest', ['tags']), fileReadTool]
    });
    await boot();
    // T21 R21: the first load opened the reader's conversation, so its one read is not
    // playground traffic. Everything below measures what the tool call itself caused.
    const bootCalls = calls.length;

    await openTool('read');
    argsBox().value = '["package.json"]';
    call();
    await flush();
    await flush();

    // R7: a catalogue tool stays a bare function call — the request body is byte-identical
    // to the pre-playground contract, with no `sessionId` key.
    expect(
        calls.find((entry) => entry.url === '/api/tools/read' && entry.method === 'POST')
    ).toEqual({
        url: '/api/tools/read',
        method: 'POST',
        body: { parameters: ['package.json'] }
    });
    expect(posts(calls, '/api/sessions', 'POST')).toHaveLength(0);
    // No session read, refresh or create after the boot open: the runner borrowed nothing.
    // T4: the pane's own toolbox read is the single route under `/sessions/` this visit causes;
    // the SESSION-FREE call itself adds none. Both halves are stated: what the call did not touch,
    // and the one read the pane owes.
    expect(excludingToolbox(byPrefix(calls.slice(bootCalls), '/api/sessions/'))).toEqual([]);
    expect(byPrefix(calls.slice(bootCalls), '/api/sessions/')).toEqual([TOOLBOX_CALL(CHAT)]);

    // The session line is hidden for a tool that needs no context.
    expect(document.querySelector<HTMLElement>('.tool-session')?.hidden).toBe(true);
});

it('tries to delete the temporary session when the page goes away', async () => {
    // A private id for this test: earlier tests in this file import main.ts again (each
    // with its own `pagehide` listener on the shared jsdom window), so a unique id is what
    // makes "exactly one cleanup" provable instead of accidental.
    const calls = stubServer({
        presets: [descriptor('alpha')],
        tools: [coreTool('toolRequest', ['tags'])],
        createdIds: ['unload-1']
    });
    await boot();

    await openTool('toolRequest');
    argsBox().value = '{"tags":["web"]}';
    call();
    await flush();
    await flush();

    // R7: an unload must not strand the context as a conversation the reader never
    // started. `pagehide` fires, and the only traffic for that session is the cleanup.
    window.dispatchEvent(new Event('pagehide'));
    await flush();

    const cleanup = calls.filter(
        (entry) => entry.url === '/api/sessions/unload-1' && entry.method === 'DELETE'
    );
    expect(cleanup).toHaveLength(1);
    // The unload path is the one that asks the browser to keep the request alive.
    expect(cleanup[0].keepalive).toBe(true);

    // The reader's own conversation is never unloaded with the page.
    expect(byPrefix(calls, `/api/sessions/${CHAT}`, 'DELETE')).toEqual([]);
});
