// R6 — per-harness delete in the left sidebar.
//
// The contracts pinned here are the ones that make a durable removal safe to expose on
// a row the reader is aiming at with the mouse:
//   - the row is a wrapper: the select button and the delete control are SIBLINGS, so
//     pressing delete can never also select the harness;
//   - confirmation is two-step (first press arms, second press sends exactly one
//     DELETE, and a control outside the row cannot leave a stale arm);
//   - success removes the row, reselects another harness when the deleted one was
//     selected, and never sends a session delete (saved sessions are preserved);
//   - a 404 ("already gone") still clears the row, and any other failure keeps the row
//     and says what happened in the status pill;
//   - an empty roster does not crash the shell, and the playground's temporary session
//     that belonged to the deleted harness is released with it.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts harness-delete-main.test.ts

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const descriptor = (name: string): HarnessDescriptor =>
    ({
        name,
        title: name === 'alpha' ? 'Alpha' : 'Beta',
        description: `The ${name} harness.`,
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: ['toolRequest'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

const coreTool: ToolDescriptor = {
    name: 'toolRequest',
    group: 'Core tools',
    description: 'toolRequest core tool',
    tags: ['core', 'harness'],
    visibility: 'core',
    sessionBound: true,
    parameters: {
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
        required: ['tags']
    }
};

const snapshot = (
    id: string,
    harness: string,
    overrides: Record<string, unknown> = {}
): SessionSnapshot =>
    ({
        id,
        harness,
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

// A recorded turn, so an archived conversation has something to render when it is
// reopened (same record shape main.test.ts uses: `status`/`events`/`eventTimes`).
const turn = (prompt: string): Record<string, unknown> => ({
    id: `t-${prompt.length}`,
    index: 0,
    prompt,
    status: 'done',
    startedAt: 1,
    updatedAt: 2,
    events: [
        {
            type: 'done',
            agent: 'instruct',
            message: { role: 'assistant', content: `Answer to ${prompt}.` }
        }
    ],
    eventTimes: [2]
});

type Call = { url: string; method: string | undefined };

// `notFoundFor` answers a DELETE with 404 (unknown harness), and `failFor` answers 500,
// so the two failure shapes of the accepted backend contract are both exercisable.
// `records` backs GET /api/sessions/:id, which is how a session is (re)opened.
const stubServer = (options: {
    presets: HarnessDescriptor[];
    tools?: ToolDescriptor[];
    sessions?: SessionSnapshot[];
    records?: Record<string, SessionSnapshot>;
    notFoundFor?: string;
    failFor?: string;
    holdDelete?: () => Promise<unknown>;
}): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            calls.push({ url, method });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: options.presets,
                    tools: options.tools ?? [],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: options.sessions ?? [],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/tools/toolRequest' && method === 'POST') {
                return json({ ok: true, result: { enabled: [], tools: [], truncated: false, remaining: 0 }, durationMs: 4 });
            }
            if (url === '/api/sessions' && method === 'POST') {
                return json({ session: snapshot('temp-1', options.presets[0].name) }, 201);
            }

            // A saved conversation is authoritative on its own: it carries the definition
            // it froze at creation, whether or not its harness still exists.
            if (url.startsWith('/api/sessions/') && method === undefined) {
                const id = decodeURIComponent(url.split('/').pop() as string);
                const record = options.records?.[id] ?? (options.sessions ?? []).find((s) => s.id === id);

                if (record === undefined) return json({ error: { message: `Unknown session ${id}` } }, 404);

                return json({ session: record });
            }

            if (url.startsWith('/api/sessions/') && method === 'DELETE') return json({ deleted: true });

            // R6: the harness delete route, with the shapes the backend worker agreed to.
            if (url.startsWith('/api/harnesses/') && method === 'DELETE') {
                const name = decodeURIComponent(url.split('/').pop() as string);

                // The busy-state contract: while ONE delete is in flight, no other delete
                // may start (main.ts locks the whole roster).
                if (options.holdDelete !== undefined) await options.holdDelete();

                if (name === options.notFoundFor) {
                    return json({ error: { message: `Unknown harness ${name}` } }, 404);
                }
                if (name === options.failFor) {
                    return json({ error: { message: 'The registry could not be written' } }, 500);
                }

                return json({ deleted: true });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }))
    );

    return calls;
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

const rowFor = (name: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(`.harness-row[data-harness="${name}"]`);
    if (found === null) throw new Error(`missing harness row ${name}`);
    return found;
};

const selectFor = (name: string): HTMLButtonElement => {
    const found = rowFor(name).querySelector<HTMLButtonElement>('.harness-item');
    if (found === null) throw new Error(`missing select button ${name}`);
    return found;
};

const deleteFor = (name: string): HTMLButtonElement => {
    const found = rowFor(name).querySelector<HTMLButtonElement>('.harness-delete');
    if (found === null) throw new Error(`missing delete control ${name}`);
    return found;
};

// First press arms, second press deletes: one helper for the confirmed path.
const deleteHarnessRow = async (name: string): Promise<void> => {
    deleteFor(name).click();
    await flush();
    deleteFor(name).click();
    await flush();
    await flush();
};

const pressedHarnesses = (): (string | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.harness-item')]
        .filter((node) => node.getAttribute('aria-pressed') === 'true')
        .map((node) => node.dataset.harness);

const statusState = (): string | null => document.querySelector<HTMLElement>('.status')?.dataset.state ?? null;
const statusDetail = (): string => document.querySelector('.status-detail')?.textContent ?? '';

const deletes = (calls: Call[], url: string): Call[] =>
    calls.filter((call) => call.url === url && call.method === 'DELETE');

// T9: the session directory (live AND archived pills) is the Sessions dashboard behind the
// harness title, so "is this conversation listed?" means "open that layer". `dashboard()`
// opens it when it is closed and returns the strip; `closeDashboard()` puts the layer away
// again so a later rail gesture is not reading a modal page.
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

// Scoped to the SESSION layer: a deck dialog can be stacked on top, and a document-wide
// `.dialog-close` would then dismiss the wrong one.
const closeDashboard = (): void => {
    const panel = document.querySelector('.session-pills-bar-dialog')?.closest('.dialog');
    panel?.querySelector<HTMLButtonElement>('.dialog-close')?.click();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

it('offers an accessible delete control beside each row without selecting the harness', async () => {
    stubServer({ presets: [descriptor('alpha'), descriptor('beta')] });
    await boot();

    const row = rowFor('beta');

    // Buttons cannot nest, so the delete control is a SIBLING of the select button.
    expect(selectFor('beta').parentElement).toBe(row);
    expect(deleteFor('beta').parentElement).toBe(row);
    expect(row.contains(selectFor('beta'))).toBe(true);

    // A real button with a name that says what it does and which row it belongs to.
    expect(deleteFor('beta').type).toBe('button');
    expect(deleteFor('beta').disabled).toBe(false);
    expect(deleteFor('beta').getAttribute('aria-label')).toBe('Delete harness beta');
    expect(deleteFor('beta').title).toBe('Delete Beta (beta) permanently. Its saved sessions stay.');

    // Pressing delete must not move the selection: the first press only arms.
    expect(pressedHarnesses()).toEqual(['alpha']);
    const before = document.querySelector('.main-title')?.textContent;
    deleteFor('beta').click();
    await flush();

    expect(pressedHarnesses()).toEqual(['alpha']);
    expect(document.querySelector('.main-title')?.textContent).toBe(before);

    // The armed row is unmistakable: the control asks, and a text line names the
    // consequence. No request went out for the arm. (`rowFor` re-queries: arming
    // rebuilds the rail, so the row node captured before the click is detached.)
    const armed = rowFor('beta');
    expect(armed.dataset.armed).toBe('true');
    expect(deleteFor('beta').textContent).toBe('Delete?');
    expect(deleteFor('beta').getAttribute('aria-label')).toBe('Confirm delete harness beta');
    expect(armed.querySelector('.harness-delete-hint')?.textContent).toBe(
        'Delete “Beta” (beta) permanently? Its saved sessions stay, and this cannot be undone from the UI.'
    );
    expect(deleteFor('beta').getAttribute('aria-describedby')).toBe('harness-delete-hint-beta');
    expect(armed.contains(deleteFor('beta'))).toBe(true);

    // Arming ANOTHER row moves the confirmation instead of stacking a second one.
    deleteFor('alpha').click();
    await flush();
    expect(rowFor('beta').dataset.armed).toBeUndefined();
    expect(rowFor('alpha').dataset.armed).toBe('true');

    // Escape abandons it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flush();
    expect(rowFor('alpha').dataset.armed).toBeUndefined();
});

it('deletes the selected harness after the second press and reselects another one', async () => {
    const calls = stubServer({
        presets: [descriptor('alpha'), descriptor('beta')],
        sessions: [snapshot('chat-a', 'alpha'), snapshot('chat-b', 'beta')]
    });
    await boot();

    // alpha is selected by boot; delete it and the shell must land somewhere sensible.
    await deleteHarnessRow('alpha');

    expect(deletes(calls, '/api/harnesses/alpha')).toHaveLength(1);
    expect(document.querySelectorAll('.harness-row[data-harness="alpha"]')).toHaveLength(0);

    // Reselect sensibly: the remaining production harness is now the selected one.
    expect(pressedHarnesses()).toEqual(['beta']);
    expect(document.querySelector('.main-title')?.textContent).toBe('Beta');
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    expect(selectFor('beta').disabled).toBe(false);

    // R6: a harness delete never removes conversations. Only the harness route was hit.
    expect(calls.filter((call) => call.method === 'DELETE' && call.url.startsWith('/api/sessions/'))).toEqual([]);

    // The surviving harness still lists its own session, and the deleted harness's
    // conversation stays reachable in the SAME directory (T3/R1 + T9: the dashboard behind
    // the title) — as a `data-archived` pill instead of a rail group with its own heading.
    const bar = dashboard();
    expect(
        [...bar.querySelectorAll<HTMLElement>('.session-pill[data-archived=false]')].map(
            (node) => node.dataset.sessionId
        )
    ).toEqual(['chat-b']);
    expect(
        [...bar.querySelectorAll<HTMLElement>('.session-pill[data-archived=true]')].map(
            (node) => node.dataset.sessionId
        )
    ).toEqual(['chat-a']);
    closeDashboard();

    expect(statusState()).toBe('idle');
    expect(statusDetail()).toBe('deleted alpha');
});

it('treats a 404 as already gone and keeps every other failure actionable', async () => {
    const missing = stubServer({ presets: [descriptor('alpha'), descriptor('beta')], notFoundFor: 'beta' });
    await boot();
    await deleteHarnessRow('beta');

    // The desired end state is "no row": an already-gone harness clears it without an
    // error, and says so in the status line.
    expect(deletes(missing, '/api/harnesses/beta')).toHaveLength(1);
    expect(document.querySelectorAll('.harness-row[data-harness="beta"]')).toHaveLength(0);
    expect(statusState()).toBe('idle');
    expect(statusDetail()).toBe('beta was already gone');
    expect(pressedHarnesses()).toEqual(['alpha']);

    vi.unstubAllGlobals();

    // A real failure keeps the row, reports the server's message, and leaves no stale
    // confirmation waiting on the control.
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';

    const failing = stubServer({ presets: [descriptor('alpha'), descriptor('beta')], failFor: 'beta' });
    await boot();

    deleteFor('beta').click();
    await flush();
    // The arm is visible on the ROW, and the failure path must not leave it armed.
    expect(rowFor('beta').dataset.armed).toBe('true');
    deleteFor('beta').click();
    await flush();
    await flush();

    expect(deletes(failing, '/api/harnesses/beta')).toHaveLength(1);
    expect(document.querySelectorAll('.harness-row[data-harness="beta"]')).toHaveLength(1);
    expect(statusState()).toBe('error');
    expect(statusDetail()).toBe('delete harness: The registry could not be written');
    expect(rowFor('beta').dataset.armed).toBeUndefined();
    expect(document.querySelector('.main-title')?.textContent).toBe('Alpha');
});

it('sends one delete for a double press and preserves the selection of another harness', async () => {
    const calls = stubServer({ presets: [descriptor('alpha'), descriptor('beta')] });
    await boot();

    // Arm, then release the press twice as fast as any reader: the arm is consumed by the
    // first DELETE, so the extra press cannot send a second one.
    deleteFor('beta').click();
    await flush();
    deleteFor('beta').click();
    deleteFor('beta').click();
    await flush();
    await flush();

    expect(deletes(calls, '/api/harnesses/beta')).toHaveLength(1);

    // Deleting a harness the reader is NOT looking at leaves the conversation alone.
    expect(pressedHarnesses()).toEqual(['alpha']);
    expect(document.querySelector('.main-title')?.textContent).toBe('Alpha');
    expect(rowFor('alpha').contains(selectFor('alpha'))).toBe(true);
});

it('survives an empty roster and releases the playground session bound to the deleted harness', async () => {
    const calls = stubServer({ presets: [descriptor('alpha')], tools: [coreTool] });
    await boot();

    // Build a playground context first: a session-bound call creates the temporary
    // session (R7), on the same harness that is about to disappear.
    document.querySelector<HTMLButtonElement>('.tools-toggle')?.click();
    await flush();
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="toolRequest"]')?.click();
    await flush();
    document.querySelector<HTMLTextAreaElement>('.tool-args')!.value = '{"tags":["web"]}';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    expect(posts(calls, '/api/sessions', 'POST')).toHaveLength(1);

    await deleteHarnessRow('alpha');

    // The roster is empty: the rail says so instead of crashing. The tools view keeps the
    // centre column (the playground is still useful), so no dead transcript is left
    // showing a harness that no longer exists.
    expect(document.querySelectorAll('.harness-row')).toHaveLength(0);
    expect(document.querySelector('.harness-list .field-hint')?.textContent).toBe(
        'No harnesses reported by the server yet.'
    );
    expect(pressedHarnesses()).toEqual([]);
    expect(document.querySelector('.stage .tools-pane')).not.toBeNull();
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');

    // R7: the temporary session belonged to that harness, so it goes with it.
    expect(deletes(calls, '/api/sessions/temp-1')).toHaveLength(1);

    // The playground note is honest about having no context, and a session-bound call
    // answers with an actionable error instead of silently requiring a conversation.
    expect(document.querySelector('.tools-session-note')?.textContent).toBe(
        'No harness is reported by this server, so session-bound tools have no context to run in. Create a harness first; every other tool can still be called directly.'
    );

    const toolCallsBefore = byPrefix(calls, '/api/tools/').length;
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    expect(byPrefix(calls, '/api/tools/')).toHaveLength(toolCallsBefore);
    expect(JSON.parse(document.querySelector('.tool-output .card-body')?.textContent ?? '{}')).toEqual({
        ok: false,
        error: {
            kind: 'no_harness',
            message:
                'This server reports no harness, so this core tool has no session to run in. Create a harness in the sidebar, then call again.'
        }
    });
});

it('replaces the chat column with guidance when the last harness is deleted outside the tools view', async () => {
    stubServer({ presets: [descriptor('alpha')], sessions: [snapshot('chat-a', 'alpha')] });
    await boot();

    // The chat owns the centre column here (the tools view was never opened).
    expect(document.querySelector('.stage .tools-pane')).toBeNull();

    await deleteHarnessRow('alpha');

    // No crash and no stale conversation: the column names the way back, the composer is
    // out of the way, and the sessions dashboard falls back to its "select a harness" hint.
    expect(document.querySelector('.empty .field-hint')?.textContent).toBe(
        'No harness is available. Create one with “+ New” in the harnesses panel.'
    );
    expect(document.querySelectorAll('.harness-row')).toHaveLength(0);
    expect(pressedHarnesses()).toEqual([]);
    // T3/R1 + T9: the dashboard carries no "select a harness" hint here, because the deleted
    // harness's conversation is still listed (R6: losing the definition must not orphan the
    // record). The rail's `.sessions-scope` sentence is gone with the rail.
    expect(document.querySelector('.sessions-scope')).toBeNull();
    const bar = dashboard();
    expect(bar.querySelector('.session-pills-empty')).toBeNull();
    expect([...bar.querySelectorAll<HTMLElement>('.session-pill')].map((node) => node.dataset.sessionId)).toEqual([
        'chat-a'
    ]);
    closeDashboard();
    expect((document.querySelector('.composer') as HTMLFormElement | null)?.hidden).toBe(true);
    expect((document.querySelector('.agent-slot') as HTMLElement | null)?.hidden).toBe(true);
});

it('locks every delete control while one delete is in flight', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });

    const calls = stubServer({
        presets: [descriptor('alpha'), descriptor('beta')],
        holdDelete: () => held
    });
    await boot();

    // Arm, then confirm: the DELETE leaves and stays unanswered.
    deleteFor('beta').click();
    await flush();
    deleteFor('beta').click();
    await flush();

    expect(deletes(calls, '/api/harnesses/beta')).toHaveLength(1);

    // Busy state: the in-flight row AND the other row are both locked, so a reader cannot
    // race a second registry write (and the armed control is no longer armed).
    expect(deleteFor('beta').disabled).toBe(true);
    expect(deleteFor('alpha').disabled).toBe(true);
    expect(rowFor('beta').dataset.armed).toBeUndefined();

    // A press in that window is refused by the handler too, not only by the disabled
    // control, so the request count cannot grow.
    deleteFor('beta').click();
    await flush();
    expect(deletes(calls, '/api/harnesses/beta')).toHaveLength(1);

    // The delete then commits normally.
    release?.();
    await flush();
    await flush();

    expect(document.querySelectorAll('.harness-row[data-harness="beta"]')).toHaveLength(0);
    expect(deleteFor('alpha').disabled).toBe(false);
    expect(pressedHarnesses()).toEqual(['alpha']);
});

// ---------------------------------------------------------------------------
// R6: a deleted harness keeps its saved conversations reachable.
// ---------------------------------------------------------------------------
//
// The harness delete removes the DEFINITION only. The rail is scoped to the selected
// harness and a deleted harness has no row to select, so without an explicit archived
// group those records would become unreachable until the exact name was recreated. These
// tests pin the archived group, the reopen from the record's FROZEN definition, and the
// rule that nothing is ever written back to the registry.
const frozenAlpha = (): HarnessDescriptor => ({
    ...descriptor('alpha'),
    // Distinct on purpose: the reopened chat must render THIS definition (the one the
    // session froze), never a live or re-created one.
    title: 'Alpha (frozen)',
    description: 'The definition alpha ran with when the session started.'
});

const archivedRecord = (): SessionSnapshot =>
    snapshot('chat-a', 'alpha', {
        harnessDefinition: frozenAlpha(),
        turns: [turn('Plan the release')]
    });

it('keeps a deleted harness session reachable as an archived pill and reopens it from its frozen definition', async () => {
    const calls = stubServer({
        presets: [descriptor('alpha'), descriptor('beta')],
        sessions: [archivedRecord()]
    });
    await boot();

    // Before the delete the conversation is an ordinary pill of the selected harness
    // (T9: read it in the dashboard behind the title, then put the layer away).
    const before = dashboard();
    expect(before.querySelector('.session-archived')).toBeNull();
    expect(
        before.querySelectorAll('.session-pill[data-archived=false][data-session-id="chat-a"]')
    ).toHaveLength(1);
    closeDashboard();

    await deleteHarnessRow('alpha');

    // beta is now selected, and alpha's conversation is still reachable (R6): it stays in
    // the same directory, flagged `data-archived`. T3/R1 dropped the labelled rail group and
    // its explanatory hint — the dashed/muted pill frame and the harness in the tooltip
    // carry the same fact one line lower.
    const pill = dashboard().querySelector<HTMLElement>('.session-pill[data-session-id="chat-a"]');
    expect(pill?.dataset.archived).toBe('true');
    expect(pill?.dataset.status).toBe('idle');
    const select = pill?.querySelector<HTMLElement>('.session-pill-select');
    // Only the eight-character prefix is visible; the harness the record belongs to is in
    // the tooltip, which is what replaces the old `.session-harness` line.
    expect(select?.textContent).toBe('chat-a');
    expect(select?.title).toBe('alpha · idle · chat-a');

    // Opening it is the normal path: one GET of the record, nothing else.
    pill?.querySelector<HTMLButtonElement>('.session-pill-select')?.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/sessions/chat-a' && call.method === undefined)).toHaveLength(1);

    // The chat renders the FROZEN definition, and says what the harness no longer is.
    expect(document.querySelector('.main-title')?.textContent).toBe('Alpha (frozen)');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'Deleted harness · saved session kept and reopened from its frozen definition'
    );

    // The conversation really reopened (its recorded prompt is on screen). The pill is now
    // the ACTIVE one and still appears exactly once — the archived pass must never
    // duplicate a conversation the selected (deleted) harness already owns.
    expect(document.querySelector('.stage')?.textContent).toContain('Plan the release');
    const bar = dashboard();
    expect(bar.querySelectorAll('.session-pill[data-session-id="chat-a"]')).toHaveLength(1);
    // T9: reopening the dashboard BUILDS a new strip from the projection, so the row the
    // reader pressed is a stale node and the live list holds exactly one fresh one — proof
    // the directory is re-projected rather than appended to (the old rail could duplicate a
    // row).
    const opened = bar.querySelector<HTMLElement>('.session-pill[data-session-id="chat-a"]');
    expect(opened).not.toBe(pill);
    expect(opened?.parentElement).not.toBe(pill?.parentElement);
    expect(opened?.getAttribute('data-active')).toBe('true');
    expect(opened?.getAttribute('data-archived')).toBe('true');

    // NO registry resurrection: the rail still shows only the surviving harness, nothing
    // was POSTed to /harnesses, and a new session cannot start on a harness that is gone.
    expect(document.querySelectorAll('.harness-row')).toHaveLength(1);
    expect(document.querySelector('.harness-row[data-harness="beta"]')).not.toBeNull();
    expect(calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/harnesses'))).toEqual([]);
    expect(pressedHarnesses()).toEqual([]);
    // R6: the header `+` refuses to start a session on a harness that is gone (the archived
    // record stays readable, but `POST /sessions` would only error).
    expect((document.querySelector('.harness-title-row .new-session') as HTMLButtonElement | null)?.disabled).toBe(
        true
    );

    // The saved record itself is untouched: no session delete was sent for it.
    expect(calls.filter((call) => call.url === '/api/sessions/chat-a' && call.method === 'DELETE')).toEqual([]);
});

it('reopens an archived conversation even when no harness is left at all', async () => {
    const calls = stubServer({ presets: [descriptor('alpha')], sessions: [archivedRecord()] });
    await boot();

    await deleteHarnessRow('alpha');

    // Empty roster: there is no harness row to select, but the conversation is still
    // offered — losing the definition must not orphan the record.
    expect(document.querySelectorAll('.harness-row')).toHaveLength(0);
    const bar = dashboard();
    // T4: this is the Sessions-only layer. Its accessible name says exactly that (the head
    // still names the harness that was just deleted, so reusing that title would claim a
    // definition the roster no longer has), and NOTHING below the dashboard is stale: the
    // description, the `harnessMeta` line, the repeated note and the aggregate totals all
    // describe a harness that is gone.
    const panel = document.querySelector('.dialog');
    expect(panel?.querySelector('.dialog-title')?.textContent).toBe('Sessions');
    expect(panel?.querySelector('.harness-details-description')).toBeNull();
    expect(panel?.querySelector('.harness-details-meta')).toBeNull();
    expect(panel?.querySelector('.harness-details-note')).toBeNull();
    expect(panel?.querySelector('.harness-details-stats')).toBeNull();
    // The dashboard itself is intact: one archived pill for the deleted harness's record.
    expect(bar.querySelectorAll('.session-pill[data-archived=true][data-session-id="chat-a"]')).toHaveLength(1);
    closeDashboard();

    // Reopening the layer is how the reader reaches the record: one press on the archived
    // pill opens it and dismisses the dialog.
    dashboard()
        .querySelector<HTMLElement>('.session-pill[data-session-id="chat-a"]')
        ?.querySelector<HTMLButtonElement>('.session-pill-select')
        ?.click();
    await flush();
    await flush();

    expect(document.querySelector('.main-title')?.textContent).toBe('Alpha (frozen)');
    expect(document.querySelector('.stage')?.textContent).toContain('Plan the release');

    // Nothing was written to the registry, so `alpha` cannot have been re-created by
    // reading one of its conversations.
    expect(
        calls.filter(
            (call) =>
                call.url.startsWith('/api/harnesses') &&
                (call.method === 'POST' || call.method === 'PATCH' || call.method === 'PUT')
        )
    ).toEqual([]);
    expect(document.querySelectorAll('.harness-row')).toHaveLength(0);
});

it('refuses an archived record with no frozen definition instead of inventing a harness', async () => {
    const legacy = snapshot('chat-l', 'alpha', { turns: [] });
    stubServer({
        presets: [descriptor('alpha'), descriptor('beta')],
        sessions: [legacy],
        records: { 'chat-l': legacy }
    });
    await boot();

    await deleteHarnessRow('alpha');

    // T9: the archived conversation is offered in the dashboard behind the title.
    dashboard()
        .querySelector<HTMLElement>('.session-pill[data-session-id="chat-l"]')
        ?.querySelector<HTMLButtonElement>('.session-pill-select')
        ?.click();
    await flush();
    await flush();

    // No `harnessDefinition` to rebuild from, so the honest answer is an error and the
    // selection stays where it was.
    expect(statusState()).toBe('error');
    expect(statusDetail()).toBe('unknown harness "alpha"');
    expect(document.querySelector('.main-title')?.textContent).toBe('Beta');
    expect(pressedHarnesses()).toEqual(['beta']);
});

const posts = (calls: Call[], url: string, method: string): Call[] =>
    calls.filter((call) => call.url === url && call.method === method);

const byPrefix = (calls: Call[], prefix: string): Call[] =>
    calls.filter((call) => call.url.startsWith(prefix));
