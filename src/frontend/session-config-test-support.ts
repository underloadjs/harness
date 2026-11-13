// Test support for the SESSION-scoped configuration panes (T4). Production code never imports this file.
//
// Why it exists
// -------------
// The ⚒ tools and ⚙ plugins panes now read and write the CURRENT SESSION's toolbox, not the
// deployment's (`src/frontend/main.ts` `loadSessionTools`/`setToolEnabled`/`loadPlugins`/
// `setPluginEnabled`). A shell fixture that opens either pane therefore has to answer two routes
// it never had before, with two payloads whose shape is easy to get subtly wrong:
//
//   GET   {root}/sessions/{id}/tools            -> `SessionToolPage`  (rows + budget)
//   PATCH {root}/sessions/{id}/tools/{tool}     -> `{ registration }` (a registration envelope)
//   GET   {root}/sessions/{id}/plugins          -> `PluginSummaryPage`
//   PATCH {root}/sessions/{id}/plugins/{plugin} -> `{ plugin }`        (the WHOLE row, like the global route)
//
// `./view-test-support.ts` offers every canonical route to the fixture's own handler first (its
// `offer()` helper, prefixed with the fixture's `root`), so a fixture declares these exactly the
// way it declares `/api/sessions/s1/turns`: `<VERB> <root>/sessions/s1/tools`. This module builds
// the answers; it does not install a fetch double.
//
// Why the doubles below are not a second opinion
// ----------------------------------------------
// The row semantics are the SERVER's: `sessionToolRowsOf` (src/server/api-reads.ts:959-994) says
// `protected = isCoreToolName(name) || the frozen definition declares it`, `enabled` is membership
// in the live enabled set, and `origin` is `created | discovered | catalogue`. The same rules are
// encoded here — a protected row refuses an `enabled` write with 403 (src/server/api-session-tool-
// writes.ts), an accepted write mutates the stored row so the NEXT read shows the new figure, and
// a plugin write answers with the whole row (src/shared/harness-api.ts `PluginDetailResponse`).
// Where a fixture needs a refusal the double does not model (409 while the conversation runs, a
// 400 on a bad setting), it passes `toolPatchStatus`/`pluginPatchStatus` instead.
import type {
    PageMeta,
    PluginSummary,
    PluginSummaryPage,
    SessionToolPage,
    SessionToolSummary,
    UpdateSessionToolRequest
} from '../shared/harness-api';
import { HARNESS_API_ROOT } from '../shared/harness-api';
import { HARNESS_CORE_TOOL_NAMES } from './contract';

// A row the caller describes in the few fields the panes actually read; everything else is the
// shape a catalogue projection carries anyway, so the defaults keep the payload legal.
export type SessionToolRowSeed = Partial<Omit<SessionToolSummary, 'name'>> & { name: string };

// The page fields every collection read carries. Fixed figures on purpose: a test that pinned an
// `observed_at` would be pinning a clock.
const pageMeta = (rows: readonly unknown[]): PageMeta => ({
    limit: rows.length,
    next_cursor: null,
    observed_at: 0,
    revision: 1
});

// One session tool row. `declared`/`protected` move together by the server's rule unless the
// fixture overrides one of them, and a core name is protected whatever the definition says.
export const sessionToolRow = (seed: SessionToolRowSeed, sessionId = 's1'): SessionToolSummary => {
    const declared = seed.declared ?? false;

    return {
        name: seed.name,
        group: seed.group ?? 'Story tools',
        description: seed.description ?? `${seed.name} tool`,
        tags: seed.tags ?? [],
        visibility: seed.visibility ?? 'searchable',
        session_bound: seed.session_bound ?? false,
        ...(seed.availability === undefined ? {} : { availability: seed.availability }),
        // The catalogue half of the row keeps the GLOBAL switch true: the pane never reads it, and
        // a row that reported it false would imply the deployment had disabled the name.
        enabled: seed.enabled ?? true,
        session_id: seed.session_id ?? sessionId,
        declared,
        origin: seed.origin ?? (declared ? 'catalogue' : 'discovered'),
        protected: seed.protected ?? (HARNESS_CORE_TOOL_NAMES.includes(seed.name as never) || declared),
        source_available: seed.source_available ?? false,
        ...(seed.source_revision === undefined ? {} : { source_revision: seed.source_revision })
    };
};

// The `GET {root}/sessions/{id}/tools` body: rows plus the created-tool budget (the client reads
// the rows and ignores the budget, but the schema requires it).
export const sessionToolPage = (rows: readonly SessionToolSummary[]): SessionToolPage => ({
    ...pageMeta(rows),
    items: [...rows],
    budget: { used: 0, limit: 12 }
});

// The `GET {root}/sessions/{id}/plugins` body. The rows are already `PluginSummary` values, which
// is why the plugin seed type is the row type: the session read returns the SAME schema with this
// session's `enabled`/`values`.
export const sessionPluginPage = (rows: readonly PluginSummary[]): PluginSummaryPage => ({
    ...pageMeta(rows),
    items: [...rows]
});

// What a fixture wants to see after its own write: the request bodies, in order.
export type SessionConfigCall = { name: string; body: Record<string, unknown> };

export type SessionConfigDoubleOptions = {
    // The conversation the panes are scoped to. Every fixture that binds a session at boot uses
    // `s1`, so that is the default.
    sessionId?: string;
    // The session's toolbox. A getter is how a fixture makes its OWN write visible on the next
    // read; the double also applies accepted writes to its copy, so a plain array works too.
    tools?: readonly SessionToolRowSeed[] | (() => readonly SessionToolRowSeed[]);
    // The plugin rows, this session's `enabled`/`values` already resolved.
    plugins?: readonly PluginSummary[] | (() => readonly PluginSummary[]);
    // Refuse every tool switch: the fixture's statement that the conversation is running (the
    // server answers 409 for ANY session tool write outside an idle window) or that the write
    // failed some other way. The sentence is what the pane prints verbatim.
    toolPatchStatus?: number;
    toolPatchMessage?: string;
    // Refuse only some tool switches (the protected rows), answering the default envelope for the
    // rest. Omit it and the double applies the server's own rule: a protected row refuses.
    toolPatchGuard?: (name: string) => boolean;
    // Refuse every plugin write (the settings dialog pins a 400 the tool gate never produces).
    pluginPatchStatus?: number;
    pluginPatchMessage?: string;
};

export type SessionConfigDouble = {
    // The double's answer for a route it owns, or `undefined` for a route the fixture keeps.
    // Compose it as the LAST branch of a fixture's own handler, or read `routes` for the
    // route-table form.
    respond: (url: string, method?: string, body?: unknown) => Response | undefined;
    // The same answers as `<VERB> <path>` entries, for a fixture that dispatches on a route table.
    routes: Record<string, () => Response>;
    // Every accepted/rejected write body, in order, so a test can pin "no global PATCH" by
    // checking these are the ONLY config writes it logged.
    toolWrites: SessionConfigCall[];
    pluginWrites: SessionConfigCall[];
    // The stored rows, after any accepted write — which is what the next read serves, and what a
    // test asserts the pane repainted from.
    toolRows: () => SessionToolSummary[];
    pluginRows: () => PluginSummary[];
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

// The server's one error envelope (src/shared/harness-api.ts `ErrorBody`): the client prints
// `error.message`, so a refusal without it would paint `HTTP 409`.
const failure = (message: string, status: number): Response => json({ error: { message } }, status);

// A fixture declares routes under whatever mount it picked (`/api`, or the canonical
// `/v1/harness`), while the browser always asks the canonical root. Stripping either prefix keeps
// one matcher for both spellings.
const routePath = (url: string): { path: string; query: string } => {
    const withoutOrigin = url.startsWith('http') ? new URL(url).pathname : url;
    const [pathPart, query = ''] = withoutOrigin.split('?');
    const path = pathPart.endsWith('/') && pathPart !== '/' ? pathPart.slice(0, -1) : pathPart;

    for (const mount of [HARNESS_API_ROOT, '/api']) {
        if (path === mount) return { path: '', query };
        if (path.startsWith(`${mount}/`)) return { path: path.slice(mount.length), query };
    }

    return { path, query };
};

// The double itself. It answers ONLY the four session-config routes and returns `undefined` for
// everything else, so a fixture keeps ownership of its boot, view and runner routes.
export const sessionConfigDouble = (options: SessionConfigDoubleOptions = {}): SessionConfigDouble => {
    const sessionId = options.sessionId ?? 's1';
    const toolsOf = (): SessionToolSummary[] =>
        (typeof options.tools === 'function' ? options.tools() : options.tools ?? []).map((seed) => sessionToolRow(seed, sessionId));
    const pluginsOf = (): PluginSummary[] => [
        ...(typeof options.plugins === 'function' ? options.plugins() : options.plugins ?? [])
    ];

    // Accepted writes land here, so a re-read shows the new figure the way the server's stored
    // state does. A fixture that instead drives rows through a getter keeps authority: the store
    // starts empty and every read re-runs its getter.
    const overrides = new Map<string, { enabled: boolean }>();

    const toolRows = (): SessionToolSummary[] =>
        toolsOf().map((row) => (overrides.has(row.name) ? { ...row, enabled: Boolean(overrides.get(row.name)?.enabled) } : row));

    const pluginStore = pluginsOf();

    const toolWrites: SessionConfigCall[] = [];
    const pluginWrites: SessionConfigCall[] = [];

    const settingsOf = (body: unknown): Record<string, unknown> => {
        const settings = (body as { settings?: Record<string, unknown> } | undefined)?.settings;

        return settings ?? {};
    };

    // `PATCH {root}/sessions/{id}/tools/{tool}`. The client sends `enabled` only and IGNORES the
    // answer (it re-reads the rows), but the route's real reply is a registration envelope, so
    // that is what the double sends.
    const patchTool = (name: string, body: unknown): Response => {
        const settings = (body as UpdateSessionToolRequest | undefined) ?? {};

        toolWrites.push({ name, body: settings as Record<string, unknown> });

        if (options.toolPatchStatus !== undefined) {
            return failure(options.toolPatchMessage ?? `HTTP ${options.toolPatchStatus}`, options.toolPatchStatus);
        }

        const row = toolRows().find((candidate) => candidate.name === name);
        const refuses = options.toolPatchGuard ?? ((tool: string) => Boolean(toolRows().find((r) => r.name === tool)?.protected));

        if (row === undefined) return failure(`unknown tool '${name}'`, 404);
        // 403 is the server's answer for the control plane: harness-owned core tools and names the
        // frozen definition declares (src/server/api-reads.ts:959-994 `protected`).
        if (settings.enabled !== undefined && refuses(name) && row.protected) {
            return failure(`the tool '${name}' is part of this session's control plane`, 403);
        }

        if (settings.enabled !== undefined) overrides.set(name, { enabled: Boolean(settings.enabled) });

        return json({ registration: { name, session_id: sessionId, enabled: Boolean(settings.enabled ?? row.enabled) } });
    };

    // `PATCH {root}/sessions/{id}/plugins/{plugin}` — the WHOLE row back, with the write applied.
    const patchPlugin = (name: string, body: unknown): Response => {
        const settings = settingsOf(body);

        pluginWrites.push({ name, body: { settings } });

        if (options.pluginPatchStatus !== undefined) {
            return failure(options.pluginPatchMessage ?? `HTTP ${options.pluginPatchStatus}`, options.pluginPatchStatus);
        }

        const index = pluginStore.findIndex((row) => row.name === name);

        if (index < 0) return failure(`unknown plugin '${name}'`, 404);

        const current = pluginStore[index];
        const values = { ...(current.values ?? {}) };

        for (const [key, value] of Object.entries(settings)) {
            // The reserved `enabled` key is the switch; every other key is a setting, and `null`
            // clears an override back to the declared default.
            if (key === 'enabled') continue;
            if (value === null) delete values[key];
            else values[key] = value as number | string | boolean;
        }

        const updated: PluginSummary = {
            ...current,
            enabled: settings.enabled === undefined ? current.enabled : Boolean(settings.enabled),
            values
        };

        pluginStore[index] = updated;

        return json({ plugin: updated });
    };

    const respond = (url: string, method?: string, body?: unknown): Response | undefined => {
        const { path } = routePath(url);
        const verb = (method ?? 'GET').toUpperCase();
        const tools = path === `/sessions/${sessionId}/tools`;
        const toolOne = path.startsWith(`/sessions/${sessionId}/tools/`);
        const plugins = path === `/sessions/${sessionId}/plugins`;
        const pluginOne = path.startsWith(`/sessions/${sessionId}/plugins/`);

        if (tools) return verb === 'GET' ? json(sessionToolPage(toolRows())) : undefined;
        if (toolOne) return verb === 'PATCH' ? patchTool(decodeURIComponent(path.slice(`/sessions/${sessionId}/tools/`.length)), body) : undefined;
        if (plugins) return verb === 'GET' ? json(sessionPluginPage(pluginStore)) : undefined;
        if (pluginOne)
            return verb === 'PATCH'
                ? patchPlugin(decodeURIComponent(path.slice(`/sessions/${sessionId}/plugins/`.length)), body)
                : undefined;

        return undefined;
    };

    // The route-table form: keys are the path a fixture sees from its own stub (`<root>/sessions/
    // s1/tools`), and the fixture supplies its own prefix. Keeping the keys PREFIX-free would
    // couple this file to a mount the fixture chose, so the table is exposed as a `respond`
    // wrapper per verb instead.
    const routes: Record<string, () => Response> = {};

    return { respond, routes, toolWrites, pluginWrites, toolRows, pluginRows: () => [...pluginStore] };
};

// The `{ enabled }` body the tools pane sends, spelled out so a test's expectation reads like the
// contract rather than like a literal.
export const sessionToolEnabledBody = (enabled: boolean): UpdateSessionToolRequest => ({ enabled });

// ---------------------------------------------------------------------------
// The two reads a BOUND conversation adds to a shell fixture
// ---------------------------------------------------------------------------
//
// The moment a fixture binds a conversation, its ⚒ pane dials a route it never dialled before
// (`GET {root}/sessions/{id}/tools`), and the manual runner behind every row dials the identified
// schema read (`GET {root}/tools/{name}`) — because a toolbox row carries NO argument schema
// (../shared/harness-api.ts `SessionToolSummary` states parameters nowhere, and `src/server/api-reads.ts`
// projects only the catalogue half). Both answers come out of the SAME descriptor list a fixture
// already puts in its boot document, so the catalogue, the pane and the runner cannot disagree
// about what the server ships: change `tools`, and all three change together.
//
// `undefined` means "not my route", which leaves the fixture authoritative everywhere else and
// keeps its strict `unexpected request` guard intact — the property every "exactly N requests"
// count in these files depends on.
// The shape a fixture describes ONE catalogue tool with. It is deliberately the STRUCTURAL subset
// the two answers below actually read, rather than `ToolDescriptor`: a fixture's own literal list
// infers `visibility: string` and would not satisfy the protocol's literal union, and the pane
// cares about neither the parameter schema (a toolbox row never carries one) nor anything beyond
// these fields.
export type CatalogueToolSeed = {
    name: string;
    group?: string;
    description?: string;
    tags?: readonly string[];
    visibility?: string;
    // The credential-gated availability figure (./contract.ts `ToolAvailability`), which the row
    // carries through so the pane can still say "not configured on this server".
    availability?: SessionToolSummary['availability'];
    // The harness-owned core tools, which have no standalone implementation: a manual call has to
    // carry a session id (./api.ts `getTool`'s `execution.scope`).
    sessionBound?: boolean;
    // The SAME figure in the contract's snake_case spelling, which is how a fixture that copies the
    // wire descriptor states it (./catalogue.test.ts).
    session_bound?: boolean;
};

// The routes that make a conversation the subject of the two configuration panes: the roster that
// names it, the view open that pointer triggers, and the toolbox + identified-schema reads. The
// verb is normalized, so a fixture whose double spells GET as `'GET'` (./endpoint-dialog.test.ts)
// and one that leaves it `undefined` (every other file) both work.
export const sessionToolReads = (
    tools: readonly CatalogueToolSeed[],
    url: string,
    method?: string
): Response | undefined => {
    const verb = (method ?? 'GET').toUpperCase();
    // A paged read arrives with `?limit=25` (./api.ts `pageParams`); `routePath` splits it off and
    // strips whichever mount the fixture declared (`/api`, or the canonical `/v1/harness`).
    const { path } = routePath(url);

    if (path.match(/^\/sessions\/[^/]+\/tools$/) !== null && verb === 'GET') {
        return json(
            sessionToolPage(
                tools.map((tool) =>
                    sessionToolRow({
                        name: tool.name,
                        group: tool.group,
                        description: tool.description,
                        tags: [...(tool.tags ?? [])],
                        // Only the CORE flag changes anything downstream (it is what makes the
                        // runner ask for a session); any other spelling is an ordinary listing.
                        visibility: tool.visibility === 'core' ? 'core' : 'searchable',
                        // The credential gate rides through untouched: the pane's `data-availability`
                        // figure and its warning line come from the row, and a row that reports
                        // nothing renders neither.
                        ...(tool.availability === undefined ? {} : { availability: tool.availability }),
                        // Every tool this server ships is callable in the fixture's conversation, so
                        // the figure is ON. A core name is still protected — by the server's rule
                        // inside `sessionToolRow`, not by anything the fixture has to remember.
                        enabled: true
                    })
                )
            )
        );
    }

    const detail = /^\/tools\/([^/]+)$/.exec(path);

    if (detail === null || verb !== 'GET') return undefined;

    const name = decodeURIComponent(detail[1]);
    const tool = tools.find((candidate) => candidate.name === name);

    if (tool === undefined) return undefined;

    // The identified detail envelope `getTool` (./api.ts) parses, with the execution figure that
    // decides whether the runner asks for a playground session at all. T4 left EXECUTION on the
    // deployment path: the row's own conversation is never the one a manual call runs in.
    return json({
        tool: {
            ...tool,
            session_bound: tool.sessionBound ?? false,
            execution: { scope: tool.visibility === 'core' ? 'session_required' : 'global', manual: true }
        }
    });
};
