// Plugins catalogue + settings editor (T7 / R2-R3).
//
// R2 asked for a Plugins button NEXT TO the tools icon that lists what the server ships;
// R3 makes the shipped Context Compaction plugin's `contextLimit` editable there. What
// this file pins:
//
//   topbar (R2)
//     - `.plugins-toggle` is the tools toggle's IMMEDIATE next sibling and the
//       `.topbar-right` cluster's last child, with the same accessible-name /
//       `aria-pressed` / `aria-controls` contract as the tools control;
//     - it is disabled before boot has answered and after the server is lost, exactly
//       like the tools toggle;
//   view switching (R2)
//     - the Plugins pane replaces the centre column, the composer and the agent control
//       are hidden while it owns it, and a second press restores the chat whole;
//     - the two catalogues are mutually exclusive in BOTH directions: opening Plugins
//       closes Tools, opening Tools closes Plugins (main.ts `setPluginsView` /
//       `setToolsView`), and at most one toggle is ever `aria-pressed="true"`;
//   the catalogue read (R2/R3)
//     - `GET /plugins` is dialled on the FIRST open and never at boot, then cached: a
//       second open costs no traffic, and `.plugins-refresh` is the explicit re-read;
//     - a failed read renders the server's sentence plus a Retry that re-dials;
//     - every row carries its title, registry name, description, hook count, settings
//       badge and its effective settings line;
//   the detail dialog (R3)
//     - Context Compaction opens the shared modal with a numeric Context limit input
//       defaulted to 100000 and carrying the declared `min`/`step` (no ceiling);
//     - editing to 150000 and pressing Save sends EXACTLY
//       `PATCH /plugins/context-compaction` `{ settings: { contextLimit: 150000 } }`
//       (changed keys only), the answer is merged into the cache, the row's settings line
//       moves with it, and reopening shows 150000 with no extra read;
//     - a refusal shows the server's message verbatim, keeps the typed value, and re-arms
//       the write control;
//     - a plugin with no declared settings renders read-only: no control, no Save.
//
// R2 (this pass) FLIPPED the enablement half of that memo: there IS one toggle per row,
// and this file pins it end to end —
//   - every row carries a `role="switch"` beside the dialog trigger (a SIBLING inside
//     `.plugin-tab-row`: a `<button>` cannot contain a control), painted from the
//     TOP-LEVEL `PluginSummary.enabled` and never from `values.enabled` (which carries
//     declared settings only, so an undeclared plugin would read as off);
//   - one click sends `PATCH /plugins/{id}` `{ settings: { enabled: <next> } }` (the
//     framework's reserved key, accepted for every plugin) and repaints that ONE row from
//     the row the server answered, with no second catalogue read;
//   - a refusal prints the server's sentence in the pane's own live line and leaves the
//     row's state exactly as the server has it;
//   - R1: the pane, its rows and its switches are usable WHILE A RUN IS PENDING, and a
//     run that settles underneath the open pane neither throws nor tears the pane down.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts src/frontend/plugins-tab.test.ts

import type { HarnessDescriptor, SessionSnapshot, SessionStreamItem, ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// `bumpFixtureEpoch` is the double's documented "the record moved OUTSIDE the request
// stream" signal: it drops the adapter's memoized GET answers, which is what makes a
// Retry/reload actually reach the fixture instead of re-reading the cached answer.
import { bumpFixtureEpoch, viewAwareFetch } from './view-test-support';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: ['toolRequest'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

// A catalogue row WITH the enablement pair (R3). `ToolDescriptor`
// (../server/protocol.ts:414) predates those fields, so the fixture states them the way
// `GET /tools` does and `toolRowOf` maps them through
// (./api.ts:1492-1520) — a row without them would render NO switch.
const fileReadTool: ToolDescriptor & { enabled: boolean; protected: boolean } = {
    name: 'read',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files', 'read'],
    visibility: 'searchable',
    enabled: true,
    protected: false,
    parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths']
    }
};

const bootstrap = (fixture: Fixture = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: fixture.presets ?? [descriptor()],
    tools: [fileReadTool],
    defaults,
    // R1: the RUNNING conversation the catalogue gates used to hide behind.
    sessions: fixture.running ? [runningSession()] : [],
    agents: []
});

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

// The rows `GET /plugins` serves, in the contract's wire spelling. `async-ping` is the
// real shipped row (src/plugins/async-ping.plugin.ts) so every figure asserted for it is
// the real one. `context-compaction` is the shipped plugin TRIMMED to the one setting the
// R3 request is about: the real descriptor declares seven
// (contextLimit/gapTokens/modelLimits/enabled/minTokens/safetyTurns/mode — pinned against
// the generated catalogue in src/plugin/manifest.test.ts and src/server/plugins.test.ts),
// and a seven-control form is not what this pane's contract is about. The third declares
// nothing, which is the read-only case, and the fourth carries a boolean + a string so
// both remaining control types are pinned.
//
// `enabled` is the TOP-LEVEL row field R2's switch paints from (../shared/harness-api.ts
// `PluginSummary`:676-689). `values` carries DECLARED settings only, so a row that does
// not declare `enabled` has no such key in the map while its switch is still stated —
// which is exactly why the pane must never read `values.enabled`.
type Row = {
    name: string;
    title: string;
    description: string;
    version: string;
    tags: string[];
    hooks: string[];
    builtin: boolean;
    enabled: boolean;
    settings: Record<string, unknown>[];
    values: Record<string, unknown>;
};

const asyncPingRow = (): Row => ({
    name: 'async-ping',
    title: 'Background Ping',
    description:
        'Keeps a conversation waiting on background tool work moving by emitting a periodic ping with the calls that are still running, replacing the fixed scheduler heartbeat.',
    version: '1.0.0',
    tags: ['background', 'async', 'lifecycle'],
    hooks: ['async.pending', 'async.drained', 'run.failed', 'thread.stopped', 'thread.deleted', 'harness.dispose'],
    builtin: true,
    // R2: the shipped row's switch state. `async-ping` declares NO `enabled` setting, so
    // the top-level field is the ONLY place this figure exists for it.
    enabled: true,
    settings: [
        {
            key: 'intervalMs',
            label: 'Ping interval (ms)',
            type: 'number',
            default: 600000,
            min: 1000,
            step: 1000,
            description: 'How often a still-running background tool is reported while work is pending.'
        }
    ],
    values: { intervalMs: 600000 }
});

const compactionRow = (): Row => ({
    name: 'context-compaction',
    title: 'Context Compaction',
    description:
        'Watches each agent conversation against a context limit and, when the limit is reached, compacts the transcript at the turn boundary before the next model request is sent.',
    version: '1.0.0',
    tags: ['context', 'compaction', 'lifecycle'],
    hooks: ['turn.before'],
    builtin: true,
    enabled: true,
    settings: [
        {
            key: 'contextLimit',
            label: 'Context limit (tokens)',
            type: 'number',
            default: 100000,
            min: 1000,
            step: 1000,
            description:
                'Estimated tokens a conversation may reach before this plugin compacts it. Measured with the ~4 characters/token estimate the UI context bar uses, anchored on the reported prompt size of the last request that reported usage — so after the first report it can differ from the bar by whatever the tool schemas and message framing actually cost.'
        }
    ],
    values: { contextLimit: 100000 }
});

const quietRow = (): Row => ({
    name: 'quiet-observer',
    title: 'Quiet Observer',
    description: 'Counts turns for the log and declares nothing to edit.',
    version: '0.2.0',
    tags: ['telemetry'],
    hooks: ['turn.after'],
    builtin: true,
    // OFF, and with NO declared setting: the switch still works, because `enabled` is the
    // framework's reserved key and the row's own field (../server/plugins.ts).
    enabled: false,
    settings: [],
    values: {}
});

// Mixed-type rows for the control-by-type rule: the shipped set declares numbers only.
const mixedRow = (): Row => ({
    name: 'extras',
    title: 'Extras',
    description: 'A host plugin that declares a boolean and a string setting.',
    version: '2.1.0',
    tags: ['extras'],
    hooks: ['turn.after'],
    builtin: true,
    enabled: true,
    settings: [
        { key: 'verbose', label: 'Verbose logging', type: 'boolean', default: false },
        {
            key: 'prefix',
            label: 'Log prefix',
            type: 'string',
            default: 'run',
            description: 'Prefix every line this plugin writes.'
        }
    ],
    values: { verbose: false, prefix: 'run' }
});

// Realistic epoch stamps (the same reason main.test.ts:73-75 states them): the UI formats
// server milliseconds, and a tiny value would read like a clock-skew bug.
const T = 1_700_000_000_000;

// One recorded turn of a conversation, in the shape the raw fixture double folds.
const runningTurn = () =>
    ({
        id: 't1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 2_000,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    }) as unknown as Record<string, unknown>;

// The RUNNING conversation R1 is about: boot embeds it, so the shell opens it and the
// whole shell enters its pending state (`running === true`) before anything is clicked.
const runningSession = () =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: T,
        updatedAt: T + 2_000,
        messages: [],
        turns: [runningTurn()],
        harnessDefinition: descriptor()
    }) as unknown as Record<string, unknown>;

// The SAME conversation after its work settled — the record the bounded fallback refresh
// brings back while a catalogue owns the centre column (A5). The shell paints it into the
// transcript pane even though that pane is off screen, and returning to the chat must
// show the settled tile rather than a frozen one.
const settledSession = () =>
    ({
        ...runningSession(),
        status: 'idle',
        updatedAt: 3,
        turns: [
            {
                ...runningTurn(),
                status: 'done',
                updatedAt: 1_700_000_004_000,
                // The recorded shape of a finished answer, exactly as main.test.ts states
                // it: the `done` frame carries the assistant MESSAGE (the projector reads
                // `event.message.content`), not a bare stop reason.
                events: [
                    { type: 'start', agent: 'instruct', model: 'm1' },
                    { type: 'text', agent: 'instruct', delta: 'all done' },
                    {
                        type: 'done',
                        agent: 'instruct',
                        message: {
                            role: 'assistant',
                            content: 'all done',
                            reasoning: '',
                            toolCalls: [],
                            model: 'm1',
                            stopReason: 'stop'
                        }
                    }
                ]
            }
        ]
    }) as unknown as Record<string, unknown>;

type Call = { url: string; method: string | undefined; body: unknown };

type Fixture = {
    // The harness roster the boot document reports (one by default).
    presets?: HarnessDescriptor[];
    // The rows `GET /plugins` answers, in page order.
    rows?: () => Row[];
    // Fail the first N catalogue reads with this server sentence.
    readFailures?: number;
    readMessage?: string;
    // Refuse every settings write with this message/status instead of applying it.
    patchMessage?: string;
    patchStatus?: number;
    // R1: boot with a conversation that is STILL RUNNING, so every assertion in the test
    // is made with the shell's pending lock held — the state the catalogues used to hide
    // themselves in.
    running?: boolean;
};

// The plugin half of the server: `GET /plugins` answers the whole page (descriptor plus
// effective values) and `PATCH /plugins/{id}` applies the settings map and returns the
// row — exactly the two routes T5 publishes (`../shared/harness-api.ts`
// `PluginSummaryPage` / `PluginDetailResponse`).
const pluginRoutes = (
    fixture: Fixture,
    calls: Call[],
    state: { reads: number }
): ((url: string, method: string | undefined, body: unknown) => Response | undefined) => {
    // A MUTABLE store, so a saved value is what the next read answers as well (the server
    // persists overrides; the client normally never re-reads them, but a Retry must see
    // them). Row objects are cloned so a write cannot leak into another test's fixture.
    let store: Row[] = (fixture.rows ?? (() => [asyncPingRow(), compactionRow(), quietRow()]))().map((row) => ({
        ...row,
        values: { ...row.values }
    }));

    return (url, method, body) => {
        // A GET arrives with the method OMITTED (this double's convention).
        if (url === '/api/plugins' && method === undefined) {
            state.reads += 1;
            calls.push({ url, method, body });

            if (fixture.readFailures !== undefined && state.reads <= fixture.readFailures) {
                return json({ error: { message: fixture.readMessage ?? 'The plugin catalogue is unavailable.' } }, 500);
            }

            return json({ items: store, limit: 25, next_cursor: null, observed_at: state.reads, revision: state.reads });
        }

        const patch = url.match(/^\/api\/plugins\/([^/]+)$/);

        if (patch !== null && method === 'PATCH') {
            calls.push({ url, method, body });

            const name = decodeURIComponent(patch[1]);
            const row = store.find((candidate) => candidate.name === name);

            if (row === undefined) return json({ error: { message: `Unknown plugin ${name}` } }, 404);

            if (fixture.patchMessage !== undefined) {
                return json({ error: { message: fixture.patchMessage } }, fixture.patchStatus ?? 400);
            }

            const settings = (body as { settings: Record<string, unknown> }).settings;

            // R2: the framework's RESERVED `enabled` key is a write on the TOP LEVEL of the
            // row, not another entry in `values` — `values` reports DECLARED settings only
            // (../server/plugins.ts:47-50, and the same rule the shipped `GET /plugins`
            // answers by). Every other key is an ordinary settings override.
            const { enabled, ...declared } = settings;

            if (enabled !== undefined) row.enabled = enabled === true;
            Object.assign(row.values, declared);
            store = store.map((candidate) => (candidate.name === name ? row : candidate));

            return json({ plugin: row });
        }

        return undefined;
    };
};

// Boot routes plus the plugin routes, with BOTH request logs: `calls` is what the fixture
// answered (with parsed bodies), and `dialed` is what the BROWSER sent — the canonical
// `/v1/harness/*` urls, which is the half that proves "exactly one catalogue read".
const stub = (fixture: Fixture = {}): { calls: Call[]; dialed: string[]; settleRun: () => void } => {
    const calls: Call[] = [];
    const dialed: string[] = [];
    // `settled` is A5's knob: the bounded fallback refresh answers with the terminal
    // record once the test flips it, which is the run completing WHILE the pane is open.
    const state = { reads: 0, settled: false };
    const plugins = pluginRoutes(fixture, calls, state);

    const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response | undefined> => {
        const url = String(input);
        const method = init?.method;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));

        if (url === '/api') return json(bootstrap(fixture));
        if (url === '/api/models') return json({ models: ['m1'] });

        // R1: the conversation the shell opens on boot when the fixture asks for a run.
        // Every canonical read (`/views/:id`, the row page, the definition, the metadata
        // refresh) is COMPOSED by the shared double from this one raw record, which is why
        // the running case declares exactly one route.
        if (fixture.running === true) {
            // The double's memo is per EPOCH, so a record that moves needs the documented
            // bump (`settleRun` below does both) — otherwise a refresh re-reads the cached
            // running document and A5 would never exercise the settling path.
            if (url === '/api/sessions/s1' && method === undefined) {
                return json({ session: state.settled ? settledSession() : runningSession() });
            }

            if (url === '/api/sessions' && method === undefined) {
                return json({ sessions: [state.settled ? settledSession() : runningSession()] });
            }
        }

        const answered = plugins(url, method, body);

        if (answered !== undefined) return answered;

        // A route nobody declared is a FAILURE, not an empty pane: the shell's every
        // "no extra traffic" count depends on the double being strict.
        throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
    };

    const adapter = viewAwareFetch(raw, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            dialed.push(`${init?.method ?? 'GET'} ${String(input)}`);

            const answer = adapter(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    return {
        calls,
        dialed,
        // The test's statement that the SERVER's record moved: flip the record and drop the
        // double's memoized reads, which is what lets the bounded refresh see the terminal
        // document (./view-test-support `bumpFixtureEpoch`).
        settleRun: () => {
            state.settled = true;
            bumpFixtureEpoch();
        }
    };
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);

    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

const toolsToggle = (): HTMLButtonElement => byClass('.tools-toggle', 'button');
const pluginsToggle = (): HTMLButtonElement => byClass('.plugins-toggle', 'button');

const openPlugins = (): void => {
    if (pluginsToggle().getAttribute('aria-pressed') !== 'true') pluginsToggle().click();
};

const openTools = (): void => {
    if (toolsToggle().getAttribute('aria-pressed') !== 'true') toolsToggle().click();
};

const pluginRow = (name: string): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>(`.plugin-tab-button[data-plugin="${name}"]`);

    if (found === null) throw new Error(`missing plugin row ${name}`);

    return found;
};

// The rows the pane is showing, in server order — stated as the rows' own keys rather
// than as their rendered text.
const pluginNames = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('.plugin-tab-button')].map((node) => node.dataset.plugin ?? '');

const texts = (selector: string): string[] =>
    [...document.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? '');

const pluginCountReads = (dialed: readonly string[]): number =>
    dialed.filter((line) => line.startsWith('GET /v1/harness/plugins')).length;

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// --- the topbar control (R2) --------------------------------------------------

it('places the Plugins toggle immediately after the Tools toggle with the same contract', async () => {
    stub();
    await boot();

    const toggle = pluginsToggle();

    // The cluster is status, tools, plugins — and the plugin icon is the tools icon's
    // IMMEDIATE next sibling, which is the placement the request asked for.
    expect([...byClass('.topbar-right', 'div').children]).toEqual([
        byClass('.status-button', 'button'),
        toolsToggle(),
        toggle
    ]);
    expect(toolsToggle().nextElementSibling).toBe(toggle);
    expect(toggle.parentElement?.className).toBe('topbar-right');
    expect(byClass('.topbar', 'header').contains(toggle)).toBe(true);

    // Icon-only toggle with an accessible name: a decorative glyph, `aria-pressed` for
    // the closed view, and `aria-controls` naming the centre region it replaces.
    expect(toggle.type).toBe('button');
    expect(toggle.id).toBe('plugins-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Plugins');
    expect(toggle.getAttribute('aria-controls')).toBe('harness-stage');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.title).toBe('Show the plugin catalogue');
    expect(toggle.textContent).toBe('⚙');
    expect(toggle.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚙');
    expect(byClass('.stage', 'div').id).toBe('harness-stage');

    // Boot reached a selected harness, so both catalogue controls are usable — and the
    // chat still owns the stage: nothing was opened and the tools view is untouched.
    expect(toggle.disabled).toBe(false);
    expect(toolsToggle().disabled).toBe(false);
    expect(toolsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.agent-slot', 'div').hidden).toBe(false);
});

it('keeps both catalogue toggles disabled while the server is unreachable', async () => {
    // No route answers at all, so boot lands on the offline pane.
    vi.stubGlobal(
        'fetch',
        vi.fn(
            viewAwareFetch(async (input: RequestInfo | URL) => {
                throw new Error(`unexpected request: ${String(input)}`);
            }, { root: '/api' })
        )
    );

    await boot();

    expect(document.querySelector('.empty-title')?.textContent).toBe('Harness server unavailable');
    expect(pluginsToggle().disabled).toBe(true);
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(toolsToggle().disabled).toBe(true);

    // A programmatic press of a disabled control still opens nothing.
    pluginsToggle().click();
    await flush();

    expect(document.querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
});

// --- the pane and its catalogue read -----------------------------------------

it('opens the pane from the toggle, reads the catalogue on first open, and lists every plugin', async () => {
    const { dialed } = stub();
    await boot();

    // No plugin traffic before the reader asks for it: this view adds NOTHING to boot.
    expect(dialed.filter((line) => line.includes('/plugins'))).toEqual([]);

    openPlugins();

    // The loading state lands with the swap, before the answer does.
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(byClass('.plugins-loading', 'p').textContent).toBe('Reading the plugin catalogue…');

    await flush();

    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(dialed.filter((line) => line.startsWith('GET /v1/harness/plugins'))).toEqual([
        'GET /v1/harness/plugins?limit=25'
    ]);

    // The head describes the catalogue, not the selected harness.
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.harness-id', 'span').textContent).toBe('built-ins');
    expect(byClass('.harness-id', 'span').hidden).toBe(false);
    expect(byClass('.harness-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save on the harness server'
    );
    expect(byClass('.plugins-tab-title', 'h2').textContent).toBe('Plugins');
    // R2: the copy that used to promise "read-only enablement … nothing to enable or
    // disable here" is GONE — the pane now says what the switch does and how far it
    // reaches (every conversation, from its next turn), and keeps the auto-scanned fact.
    const hint = byClass('.plugins-tab-hint', 'p').textContent ?? '';

    expect(hint).toContain('Auto-scanned · one-click enable/disable');
    expect(hint).toContain('turns that plugin on or off for EVERY conversation');
    expect(hint).toContain('from its next turn');
    expect(hint).toContain('the plugin stays loaded and listed either way');
    expect(hint).not.toContain('read-only enablement');
    expect(hint).not.toContain('nothing to enable or disable');
    // The pane note and the head note state the same figure (one writer, no drift).
    expect(byClass('.plugins-tab-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save on the harness server'
    );
    expect(byClass('.plugins-refresh', 'button').textContent).toBe('Reload plugins');

    // Every shipped plugin is a row, in the page order the server sent.
    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    expect(texts('.plugin-tab-title')).toEqual(['Background Ping', 'Context Compaction', 'Quiet Observer']);

    // Title, registry name, description, hook count + settings badge, and the effective
    // settings line the Context Compaction request is about.
    const compaction = pluginRow('context-compaction');

    expect(compaction.querySelector('.plugin-tab-name')?.textContent).toBe('context-compaction');
    expect(compaction.querySelector('.plugin-tab-desc')?.textContent).toBe(compactionRow().description);
    expect(compaction.querySelector('.plugin-tab-meta')?.textContent).toBe('1 hook · 1 setting · built-in');
    expect(compaction.querySelector('.plugin-tab-values')?.textContent).toBe('contextLimit: 100000');
    expect(compaction.getAttribute('aria-haspopup')).toBe('dialog');
    expect(compaction.getAttribute('aria-pressed')).toBe('false');
    expect(compaction.disabled).toBe(false);

    expect(pluginRow('async-ping').querySelector('.plugin-tab-meta')?.textContent).toBe(
        '6 hooks · 1 setting · built-in'
    );
    expect(pluginRow('async-ping').querySelector('.plugin-tab-values')?.textContent).toBe('intervalMs: 600000');
    // R3: a settings-free built-in is labelled read-only in the LIST, not only in its dialog.
    expect(pluginRow('quiet-observer').querySelector('.plugin-tab-meta')?.textContent).toBe(
        '1 hook · read-only · built-in'
    );
    expect(pluginRow('quiet-observer').querySelector('.plugin-tab-values')?.textContent).toBe('no settings');

    // R2: every row carries its switch BESIDE the trigger (the row is a `.plugin-tab-row`
    // wrapper: a `<button>` cannot contain a control). `enabled` is the TOP-LEVEL row
    // field, and quiet-observer is the row the server reports as OFF — its settings map is
    // empty, so a painter that read `values.enabled` would paint this row on by accident.
    expect(pluginRow('context-compaction').parentElement?.className).toBe('plugin-tab-row');
    expect(pluginRow('context-compaction').nextElementSibling?.className).toBe('plugin-tab-toggle is-on');
    expect(pluginRow('context-compaction').dataset.enabled).toBe('true');

    const compactionSwitch = byClass('.plugin-tab-toggle[data-plugin="context-compaction"]', 'button');

    expect(compactionSwitch.type).toBe('button');
    expect(compactionSwitch.getAttribute('role')).toBe('switch');
    expect(compactionSwitch.getAttribute('aria-checked')).toBe('true');
    expect(compactionSwitch.textContent).toBe('on');
    expect(compactionSwitch.getAttribute('aria-label')).toBe(
        'Disable Context Compaction for every conversation'
    );
    expect(compactionSwitch.disabled).toBe(false);
    expect(compactionSwitch.closest('.plugin-tab-row')?.contains(compactionSwitch)).toBe(true);

    // The OFF row states OFF, and no row is ever nested in another control.
    const quietSwitch = byClass('.plugin-tab-toggle[data-plugin="quiet-observer"]', 'button');

    expect(quietSwitch.getAttribute('aria-checked')).toBe('false');
    expect(quietSwitch.textContent).toBe('off');
    expect(quietSwitch.getAttribute('aria-label')).toBe('Enable Quiet Observer for every conversation');
    expect(pluginRow('quiet-observer').dataset.enabled).toBe('false');
    expect(document.querySelector('.plugin-tab-button .plugin-tab-button')).toBeNull();
    expect(document.querySelectorAll('.plugin-tab-toggle')).toHaveLength(3);

    // The composer and the agent control are hidden while the pane owns the column.
    expect(byClass('.composer', 'form').hidden).toBe(true);
    expect(byClass('.agent-slot', 'div').hidden).toBe(true);

    // Second press closes it, and the chat comes back whole.
    pluginsToggle().click();
    await flush();

    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.agent-slot', 'div').hidden).toBe(false);
    expect(byClass('.main-title', 'h1').textContent).toBe('Instruct');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);

    // Reopening paints from the cache: still exactly ONE catalogue read for the visit.
    openPlugins();
    await flush();

    expect(pluginNames()).toHaveLength(3);
    expect(pluginCountReads(dialed)).toBe(1);
});

it('keeps the plugins view and the tools view mutually exclusive in both directions', async () => {
    const { dialed } = stub();
    await boot();

    // Tools first.
    openTools();
    await flush();

    expect(toolsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();

    // Plugins wins the column and Tools reports closed: one centre view, one owner.
    openPlugins();
    await flush();

    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(toolsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).toBeNull();
    expect(document.querySelector('.tool-tab-button')).toBeNull();
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.composer', 'form').hidden).toBe(true);

    // And the way back: Tools closes Plugins rather than stacking a second catalogue.
    openTools();
    await flush();

    expect(toolsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.main-title', 'h1').textContent).toBe('Tools');

    // Closing Tools from its own toggle returns the chat, not the plugin pane.
    toolsToggle().click();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.tools-pane')).toBeNull();
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.main-title', 'h1').textContent).toBe('Instruct');

    // The whole dance cost one plugin read: the pane was opened once, and the tools view
    // never dialled it.
    expect(pluginCountReads(dialed)).toBe(1);
});

// --- the row switch (R2) ------------------------------------------------------

it('switches a plugin off and back on with one click, and repaints the row from the server answer', async () => {
    const { calls, dialed } = stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');
    const control = byClass('.plugin-tab-toggle[data-plugin="context-compaction"]', 'button');

    control.click();

    // In flight: the control is locked (one PATCH per press), and it says so on itself.
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-busy')).toBe('true');

    await flush();
    await flush();

    // Exactly one write, and it carries the reserved key as the whole settings map: the
    // framework accepts `enabled` for every plugin (../shared/harness-api.ts
    // `PluginSettingsUpdate`), and an omitted key is no change.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/plugins/context-compaction', method: 'PATCH', body: { settings: { enabled: false } } }
    ]);
    expect(dialed.filter((line) => line === 'PATCH /v1/harness/plugins/context-compaction')).toHaveLength(1);

    // The answer IS the new state: the SAME nodes are repainted in place (the row stays
    // the trigger the dialog would hand focus back to), and the switch now reads off.
    expect(pluginRow('context-compaction')).toBe(row);
    expect(row.dataset.enabled).toBe('false');
    expect(byClass('.plugin-tab-toggle[data-plugin="context-compaction"]', 'button')).toBe(control);
    expect(control.className).toBe('plugin-tab-toggle is-off');
    expect(control.textContent).toBe('off');
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.getAttribute('aria-label')).toBe('Enable Context Compaction for every conversation');
    expect(control.disabled).toBe(false);
    expect(control.getAttribute('aria-busy')).toBe('false');

    // The switch line states the accepted figure, the COUNT line keeps counting, and the
    // other rows were not touched.
    expect(byClass('.plugins-tab-status', 'p').textContent).toBe(
        'Context Compaction is now disabled for every conversation.'
    );
    expect(byClass('.plugins-tab-status', 'p').hidden).toBe(false);
    expect(byClass('.plugins-tab-status', 'p').className).toBe('plugins-tab-status field-hint');
    expect(byClass('.plugins-tab-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save on the harness server'
    );
    expect(pluginRow('async-ping').dataset.enabled).toBe('true');
    expect(byClass('.status-text', 'span').textContent).toBe('idle');

    // The cache took the answer, so a reopen shows the server's state and the visit still
    // costs exactly ONE catalogue read.
    row.click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(pluginCountReads(dialed)).toBe(1);

    // A second press inverts what the SERVER last reported, not what this list frame was
    // built from: the round trip goes back on.
    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'PATCH')[1]).toEqual({
        url: '/api/plugins/context-compaction',
        method: 'PATCH',
        body: { settings: { enabled: true } }
    });
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(row.dataset.enabled).toBe('true');
});

it('states a refused switch with the server sentence and leaves the row exactly as the server has it', async () => {
    // The shipped row is enabled, and this refusal is the settings save's own shape: the
    // server's sentence verbatim, nothing reset, and the control re-armed.
    const message = 'context-compaction cannot be switched off while a run is held.';
    const { calls, dialed } = stub({ patchMessage: message, patchStatus: 403 });

    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');
    const control = byClass('.plugin-tab-toggle[data-plugin="context-compaction"]', 'button');

    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/plugins/context-compaction', method: 'PATCH', body: { settings: { enabled: false } } }
    ]);

    // Nothing moved: the row and its switch still state the figure the server has, and the
    // refusal is on the switch line, classed as a failure as well as coloured.
    expect(byClass('.plugins-tab-status', 'p').textContent).toBe(message);
    expect(byClass('.plugins-tab-status', 'p').className).toBe('plugins-tab-status plugins-tab-status-error');
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.textContent).toBe('on');
    expect(control.disabled).toBe(false);
    expect(row.dataset.enabled).toBe('true');
    // The cache was not touched, so the count line still describes the same three rows.
    expect(byClass('.plugins-tab-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save on the harness server'
    );
    expect(byClass('.status-text', 'span').textContent).toBe('error');

    // And the failed write is not memoized: the next press dials again.
    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(pluginCountReads(dialed)).toBe(1);
});

// --- R1: the catalogues are always reachable ---------------------------------

it('keeps the plugins and tools pages, their rows and their switches usable while a run is pending', async () => {
    const { dialed } = stub({ running: true });
    await boot();
    await flush();

    // The conversation the shell opened on boot still holds work, so the shell IS in its
    // pending state — the state that used to hide both catalogues.
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');

    // The chat's own protections stay locked: a new conversation cannot start and the
    // header cycler cannot move while the queue works (these are the gates R1 KEEPS).
    expect(byClass('.new-session', 'button').disabled).toBe(true);
    expect(byClass('.session-cycle', 'button').disabled).toBe(true);

    // The two catalogue controls answer only to `booted`, and boot has answered.
    expect(pluginsToggle().disabled).toBe(false);
    expect(toolsToggle().disabled).toBe(false);

    openPlugins();
    await flush();

    // The pane took the centre column mid-run, with its rows and switches live.
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    expect(pluginRow('context-compaction').disabled).toBe(false);
    expect(byClass('.plugin-tab-toggle[data-plugin="context-compaction"]', 'button').disabled).toBe(false);

    // A row is clickable mid-run: its detail dialog opens over the list.
    pluginRow('context-compaction').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')?.isConnected).toBe(true);

    // And the global switch WRITES mid-run — the server's route has no idle window, and
    // the answer repaints the row.
    byClass('.plugin-tab-toggle[data-plugin="context-compaction"]', 'button').click();
    await flush();
    await flush();

    expect(
        dialed.filter((line) => line === 'PATCH /v1/harness/plugins/context-compaction')
    ).toHaveLength(1);
    expect(byClass('.plugin-tab-toggle[data-plugin="context-compaction"]', 'button').getAttribute('aria-checked')).toBe(
        'false'
    );

    // The other catalogue is reachable from here too: Tools closes Plugins (the exclusive
    // centre column survives R1), its rows are clickable and its switch is live.
    openTools();
    await flush();

    expect(toolsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').disabled).toBe(false);

    const toolSwitch = byClass('.tool-tab-toggle[data-tool="read"]', 'button');

    expect(toolSwitch.disabled).toBe(false);
    expect(toolSwitch.getAttribute('aria-checked')).toBe('true');

    // A tool row opens its runner mid-run as well.
    byClass('.tool-tab-button[data-tool="read"]', 'button').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('read');
    byClass('.dialog-close', 'button').click();
    await flush();
});

it('lets a pending run settle underneath the open plugins pane without disturbing it', async () => {
    // The live plane is the canonical `harness.v1` socket, so this case installs the shared
    // double (./view-test-support `installHarnessStream`) BEFORE the shell boots, and drives
    // the run's end with the same terminal `snapshot` frame the server sends when the queue
    // drains. That is the path R1 made reachable: the run completes while the plugin
    // catalogue owns the centre column, so every transcript painter runs against a pane that
    // is OFF the document.
    // The socket double is installed BEFORE the shell boots: `harnessStream()` caches the
    // client built from the first configured factory, so the shell must dial THIS socket
    // (main.test.ts:238-252). `host` is the one record both surfaces read, so the wire and
    // a REST re-read can never disagree about what the conversation is.
    const support = await import('./view-test-support');

    let host = runningSession() as unknown as SessionSnapshot;
    const live = support.installHarnessStream({
        sessionId: 's1',
        snapshot: () => host,
        record: () => host
    });

    const { settleRun } = stub({ running: true });

    await boot();
    await flush();

    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');

    openPlugins();
    await flush();

    const stage = byClass('.stage', 'div');

    expect(stage.querySelector('.plugins-pane')).not.toBeNull();
    // The transcript pane is OFF the document while the catalogue owns the column, which is
    // exactly the state the stream painters used never to see.
    expect(stage.querySelector('.log-wrap')).toBeNull();

    // The queue drains: the terminal snapshot frame lands with the pane still open. The
    // REST record moves with it (`settleRun`), which is what a `turn.removed`/re-read the
    // frame can trigger has to agree with.
    host = settledSession() as unknown as SessionSnapshot;
    settleRun();

    const frame: SessionStreamItem[] = [{ type: 'snapshot', session: host }];

    live.push(frame);

    await flush();
    await flush();

    // The run settled with the pane still on screen: nothing threw, nothing navigated, and
    // the catalogue kept its rows, its switches and its head.
    expect(byClass('.composer-action', 'button').dataset.action).not.toBe('stop');
    expect(stage.querySelector('.plugins-pane')?.isConnected).toBe(true);
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    expect(byClass('.composer', 'form').hidden).toBe(true);

    // Back to the chat: the transcript was painted the whole time — the settled tile is
    // there, so the off-screen painters ran against the live document and did not throw.
    pluginsToggle().click();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(byClass('.tile', 'article').dataset.state).toBe('done');
    expect(byClass('.composer', 'form').hidden).toBe(false);
});

// --- the detail dialog (R3) ---------------------------------------------------

it('opens the Context Compaction dialog with the declared hooks and a numeric limit', async () => {
    stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');

    row.click();

    // The shared modal, named after the plugin's own title.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog', 'div').getAttribute('role')).toBe('dialog');
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    expect(row.getAttribute('aria-pressed')).toBe('true');

    // Identity facts plus the declared hooks: existing metadata only.
    expect(byClass('.plugin-detail-description', 'p').textContent).toBe(compactionRow().description);
    expect(texts('.plugin-detail-fact')).toEqual([
        'context-compaction',
        'v1.0.0',
        'built-in',
        'tags: context, compaction, lifecycle'
    ]);
    expect(texts('.plugin-hook-chip')).toEqual(['turn.before']);
    expect(texts('.plugin-detail-section-title')).toEqual(['Hooks', 'Settings']);

    // The head names the plugin whose layer is open — the contract the tool runner has.
    expect(byClass('.main-title', 'h1').textContent).toBe('Context Compaction');
    expect(byClass('.harness-id', 'span').textContent).toBe('context-compaction');
    expect(byClass('.harness-note', 'p').textContent).toBe('v1.0.0 · 1 hook · 1 setting · built-in');

    // R3: the editable figure. A number box holding the effective value, with the shipped
    // floor (1000) and cadence (1000) as the declared hints; the manifest states no ceiling.
    const input = byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input');

    expect(input.type).toBe('number');
    expect(input.value).toBe('100000');
    expect(input.min).toBe('1000');
    expect(input.step).toBe('1000');
    expect(input.getAttribute('max')).toBeNull();
    expect(input.id).toBe('plugin-setting-context-compaction-contextLimit');
    expect(input.disabled).toBe(false);

    const label = byClass('.plugin-setting-label', 'label');

    expect(label.textContent).toBe('Context limit (tokens)');
    expect(label.htmlFor).toBe(input.id);
    expect(byClass('.plugin-setting-hint', 'p').textContent).toBe(compactionRow().settings[0]?.description);

    // The write control exists but is honest: nothing is dirty on the first frame.
    expect(byClass('.plugin-setting-save', 'button').textContent).toBe('Save');
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(true);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('');

    // Escape dismisses the layer, resets the row, re-describes the catalogue, and hands
    // focus back to the row that opened it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.dialog')).toBeNull();
    expect(row.getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.harness-id', 'span').textContent).toBe('built-ins');
    expect(document.activeElement).toBe(row);
    // The list stayed on the stage the whole time: one modal over one list.
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')?.isConnected).toBe(true);
});

it('saves only the changed key, repaints from the server row, and reopens with the saved figure', async () => {
    const { calls, dialed } = stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('context-compaction');

    row.click();

    const input = byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input');

    input.value = '150000';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // The dirty state is what arms the write control.
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);
    byClass('.plugin-setting-save', 'button').click();

    // In flight: the control is locked, so a double press cannot send two patches.
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(true);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saving…');

    await flush();
    await flush();

    // Exactly one write, and it carries ONLY the changed key: an omitted key is documented
    // as "no change" (../shared/harness-api.ts `PluginSettingsUpdate`), so untouched
    // settings are never rewritten by an unrelated save.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/plugins/context-compaction', method: 'PATCH', body: { settings: { contextLimit: 150000 } } }
    ]);
    expect(
        dialed.filter((line) => line === 'PATCH /v1/harness/plugins/context-compaction')
    ).toHaveLength(1);

    // The answer IS the new state: the form takes the server's figure, the row's settings
    // line moves with it, and the dialog says so and clears the dirty state.
    expect(input.value).toBe('150000');
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(byClass('.plugin-setting-status', 'p').className).toBe('plugin-setting-status field-hint');
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(true);
    expect(pluginRow('context-compaction').querySelector('.plugin-tab-values')?.textContent).toBe(
        'contextLimit: 150000'
    );
    // The row button was repainted in place, so it is still the SAME node — a rebuilt list
    // would replace the trigger the dialog hands focus back to.
    expect(pluginRow('context-compaction')).toBe(row);
    expect(byClass('.status-text', 'span').textContent).toBe('idle');

    // Close and reopen: the merged cache row is what the form shows, so a reopen answers
    // 150000 with NO extra traffic.
    byClass('.dialog-close', 'button').click();
    pluginRow('context-compaction').click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Context Compaction');
    expect(byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input').value).toBe('150000');
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(true);
    expect(pluginCountReads(dialed)).toBe(1);
});

it('keeps the typed value editable and states the server refusal verbatim', async () => {
    // The server validator's own sentence (a value under the declared `min`).
    const message = 'contextLimit must be at least 1000.';
    const { calls, dialed } = stub({ patchMessage: message, patchStatus: 400 });

    await boot();
    openPlugins();
    await flush();

    pluginRow('context-compaction').click();

    const input = byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input');

    input.value = '500';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.plugin-setting-save', 'button').click();
    await flush();
    await flush();

    // The refusal is the server's text, not a client guess, and it is marked as a failure
    // by class as well as by colour.
    const status = byClass('.plugin-setting-status', 'p');

    expect(status.textContent).toBe(message);
    expect(status.className).toBe('plugin-setting-status plugin-setting-status-error');

    // Nothing was reset: the reader fixes the number they typed, and Save is armed again.
    expect(input.value).toBe('500');
    expect(input.disabled).toBe(false);
    expect(byClass('.plugin-setting-save', 'button').disabled).toBe(false);

    // The cache is untouched, so the list still states the last figure the server had.
    expect(pluginRow('context-compaction').querySelector('.plugin-tab-values')?.textContent).toBe(
        'contextLimit: 100000'
    );
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(pluginCountReads(dialed)).toBe(1);

    // The topbar pill reports the failed config write, and the form is still on screen.
    expect(byClass('.status-text', 'span').textContent).toBe('error');
    expect(document.querySelector('.dialog')).not.toBeNull();
});

it('renders a plugin with no declared settings read-only, with no write control', async () => {
    const { calls } = stub();
    await boot();
    openPlugins();
    await flush();

    const row = pluginRow('quiet-observer');

    expect(row.querySelector('.plugin-tab-values')?.textContent).toBe('no settings');

    row.click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('Quiet Observer');
    // No control and no Save: an action that could only ever send an empty patch.
    expect(document.querySelectorAll('.dialog .plugin-setting-input')).toHaveLength(0);
    expect(document.querySelector('.dialog .plugin-setting-save')).toBeNull();
    expect(document.querySelector('.dialog .plugin-settings-form')).toBeNull();
    expect(texts('.dialog .plugin-detail-empty')).toEqual(['This plugin declares no settings · read-only.']);
    // The declared hooks still render: read-only covers SETTINGS, not the facts.
    expect(texts('.plugin-hook-chip')).toEqual(['turn.after']);
    expect(byClass('.main-title', 'h1').textContent).toBe('Quiet Observer');
    expect(byClass('.harness-note', 'p').textContent).toBe('v0.2.0 · 1 hook · read-only · built-in');

    byClass('.dialog-close', 'button').click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.activeElement).toBe(row);
});

it('renders each declared setting as its own control and sends only the changed one', async () => {
    // The shipped set declares numbers only, so the boolean/string branches are pinned
    // against a row that declares both types.
    const { calls } = stub({ rows: () => [mixedRow()] });
    await boot();
    openPlugins();
    await flush();

    expect(pluginNames()).toEqual(['extras']);
    pluginRow('extras').click();

    const verbose = byClass('.plugin-setting-input[data-setting="verbose"]', 'input');
    const prefix = byClass('.plugin-setting-input[data-setting="prefix"]', 'input');

    expect(verbose.type).toBe('checkbox');
    expect(verbose.checked).toBe(false);
    expect(prefix.type).toBe('text');
    expect(prefix.value).toBe('run');
    expect(texts('.plugin-setting-label')).toEqual(['Verbose logging', 'Log prefix']);
    expect(texts('.plugin-setting-hint')).toEqual(['Prefix every line this plugin writes.']);

    verbose.checked = true;
    verbose.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.plugin-setting-save', 'button').click();
    await flush();
    await flush();

    // The checkbox became `true` and the untouched text setting is NOT in the patch.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/plugins/extras', method: 'PATCH', body: { settings: { verbose: true } } }
    ]);
    expect(byClass('.plugin-setting-status', 'p').textContent).toBe('Saved');
    expect(byClass('.plugin-setting-input[data-setting="verbose"]', 'input').checked).toBe(true);
    expect(byClass('.plugin-setting-input[data-setting="prefix"]', 'input').value).toBe('run');
    expect(pluginRow('extras').querySelector('.plugin-tab-values')?.textContent).toBe(
        'verbose: true · prefix: run'
    );
});

it('replaces the open detail when another row is activated instead of stacking a second dialog', async () => {
    stub();
    await boot();
    openPlugins();
    await flush();

    const compaction = pluginRow('context-compaction');
    const ping = pluginRow('async-ping');

    compaction.click();
    ping.click();

    // One layer, and it describes the row that was pressed LAST (the catalogue's own
    // replacement rule, the same one the tool runner follows).
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog-title', 'h2').textContent).toBe('Background Ping');
    expect(compaction.getAttribute('aria-pressed')).toBe('false');
    expect(ping.getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.main-title', 'h1').textContent).toBe('Background Ping');
    expect(byClass('.harness-note', 'p').textContent).toBe('v1.0.0 · 6 hooks · 1 setting · built-in');

    // Dismissing the replacement lands on the row that opened it, and the head returns to
    // the catalogue.
    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(ping.getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.main-title', 'h1').textContent).toBe('Plugins');
    expect(byClass('.harness-id', 'span').textContent).toBe('built-ins');
    expect(document.activeElement).toBe(ping);
});

it('leaves the plugins pane when the reader selects another harness', async () => {
    // Two harnesses, so the switch is a real selection and not a repaint of the same one.
    const { dialed } = stub({
        presets: [descriptor(), descriptor({ name: 'research', title: 'Research', agents: ['research'], primary: 'research' })]
    });

    await boot();

    openPlugins();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).not.toBeNull();
    expect(pluginCountReads(dialed)).toBe(1);

    const rows = document.querySelectorAll<HTMLElement>('.harness-item');

    expect(rows).toHaveLength(2);
    rows[1]?.click();
    await flush();

    // The chat owns the column again, with the NEW harness's head, and the toggle reports
    // the closed view (`selectHarness` closes every catalogue).
    expect(byClass('.stage', 'div').querySelector('.plugins-pane')).toBeNull();
    expect(pluginsToggle().getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.main-title', 'h1').textContent).toBe('Research');
    expect(byClass('.composer', 'form').hidden).toBe(false);
    expect(byClass('.agent-slot', 'div').hidden).toBe(false);

    // The cache survives the switch: re-entering the pane paints the rows without a second
    // read, because the catalogue is server-wide rather than per harness.
    openPlugins();
    await flush();

    expect(pluginNames()).toHaveLength(3);
    expect(pluginCountReads(dialed)).toBe(1);
});

// --- the read failure, the retry, and the refresh ----------------------------

it('states a failed catalogue read with the server sentence and reloads on Retry', async () => {
    const message = 'The plugin service is not responding.';
    const { calls, dialed } = stub({ readFailures: 1, readMessage: message });

    await boot();
    openPlugins();
    await flush();

    // A failure is a real state: the server's own sentence plus the one action that can
    // fix it, and no rows pretending the read succeeded.
    expect(byClass('.plugins-error', 'p').textContent).toBe(message);
    expect(byClass('.plugins-tab-note', 'p').textContent).toBe(
        `The plugin catalogue could not be read: ${message}`
    );
    expect(byClass('.harness-note', 'p').textContent).toBe(
        `The plugin catalogue could not be read: ${message}`
    );
    expect(byClass('.plugins-retry', 'button').textContent).toBe('Retry');
    expect(pluginNames()).toEqual([]);

    // A failed read is NOT cached: Retry re-dials, and the rows land this time. (The
    // fixture epoch bump is the double's own "the record moved" signal.)
    bumpFixtureEpoch();
    byClass('.plugins-retry', 'button').click();
    await flush();
    await flush();

    expect(pluginNames()).toEqual(['async-ping', 'context-compaction', 'quiet-observer']);
    expect(byClass('.plugins-tab-note', 'p').textContent).toBe(
        '3 plugins · auto-scanned · settings save on the harness server'
    );
    expect(document.querySelector('.plugins-error')).toBeNull();
    expect(calls.filter((call) => call.url === '/api/plugins')).toHaveLength(2);
    expect(pluginCountReads(dialed)).toBe(2);
});

it('re-reads the catalogue from the pane control instead of trusting the cache', async () => {
    const { calls, dialed } = stub();
    await boot();
    openPlugins();
    await flush();

    expect(pluginCountReads(dialed)).toBe(1);

    bumpFixtureEpoch();
    byClass('.plugins-refresh', 'button').click();
    await flush();
    await flush();

    // The explicit refresh is the only way a second read leaves the browser, and the rows
    // are repainted from the fresh page (still wired afterwards).
    expect(pluginCountReads(dialed)).toBe(2);
    expect(calls.filter((call) => call.url === '/api/plugins')).toHaveLength(2);
    expect(pluginNames()).toHaveLength(3);

    pluginRow('context-compaction').click();
    expect(byClass('.plugin-setting-input[data-setting="contextLimit"]', 'input').value).toBe('100000');
});
