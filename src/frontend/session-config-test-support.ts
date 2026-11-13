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
// The row semantics are the SERVER's, figure for figure (`sessionToolRowsOf`,
// src/server/api-reads.ts — T5/T6 own that projection, and this file follows it):
//   - `declared`  — membership in the FROZEN definition's `coreTools`. It states HOW the name got
//                   in; it is not a switch figure and it never enters `protected`;
//   - `protected` — the UNREGISTER axis: the name cannot be REMOVED from this conversation's
//                   registry (`visibility: 'core'`, or a pending-only control such as `toolCancel`,
//                   is what the kernel refuses to unregister). R5 repurposed this field: it is no
//                   longer a reason to refuse an `enabled` write, so the Tools pane reads nothing
//                   off it and a protected row is togglable like any other;
//   - `enabled`   — whether an agent in THIS conversation may call the name, from its next turn on.
//                   A registered name is ON unless something made it false, and there are exactly
//                   two such flavors: the conversation WITHHELD it (someone switched it off — the
//                   tile's own write, or an agent), or the capped toolbox has NO FREE SLOT for it.
//                   Both answer `enabled: false`, the wire has no field that tells them apart, and
//                   the switch behaves the same for either — which is why the pane paints one
//                   figure and its tooltip names both possibilities;
//   - `origin`    — `created | discovered | catalogue`, with `discovered` = enabled and not declared.
// The write rules are the server's too, post-R5: an `enabled`-only PATCH is answered 200 for EVERY
// registered name — a core name and a pending-only control included — and never with a 403 (the
// old protected-name refusal) or a 409 (the old idle-window refusal), because the switch is
// agent-facing and is meant to land WHILE a thread runs. The double stores an accepted write so the
// NEXT read shows the new figure, and a plugin write answers with the whole row
// (src/shared/harness-api.ts `PluginDetailResponse`). A fixture that still wants to model a
// refusal — an older build, or a route it is pinning the failure mark on — passes
// `toolPatchStatus`/`toolPatchGuard`/`pluginPatchStatus` instead; those are the fixture's opinion,
// never the current route's rule.
import type {
    PageMeta,
    PluginSummary,
    PluginSummaryPage,
    SessionToolPage,
    SessionToolSummary,
    UpdateSessionToolRequest
} from '../shared/harness-api';
import { HARNESS_API_ROOT } from '../shared/harness-api';

// A row the caller describes in the few fields the panes actually read; everything else is the
// shape a catalogue projection carries anyway, so the defaults keep the payload legal.
//
// `pendingOnly`, `created`, `withheld` and `beyondCap` are NOT wire fields — they are the KERNEL
// facts the wire row is only ever a consequence of, and a fixture has to state them to drive the
// server's derivations:
//   - `pendingOnly` — the registration is declared only while it is actionable (the
//     `pendingOnlyDefinitions` set, src/harness.ts, filled from `descriptor.pendingOnly`).
//     `toolCancel` is the live example: its manifest visibility is demoted to `searchable`, yet the
//     kernel still refuses to unregister it, so its row is `protected`.
//   - `created` — `record.core.createdTools` carries the name (src/server/api-reads.ts), i.e. this
//     session registered it and owns its source revision + budget slot. `origin` reads it first,
//     ahead of `discovered`/`catalogue`.
//   - `withheld` — this conversation's enablement gate holds the name OUT: somebody (the reader, an
//     agent, a REST caller) switched it off. This is the ONLY flavor of `enabled: false` a fixture
//     can reach with a PATCH, and it is what a protected/core name now shows once its tile is
//     pressed.
//   - `beyondCap` — the capped toolbox has no free slot for the name, so it is reported off without
//     anybody having switched it off. The other flavor of `enabled: false`, and the one a NEW
//     conversation can ship on its own. The wire states no field for the difference.
// `withheld` and `beyondCap` are deliberately two spellings of one wire figure: a fixture that
// wants the row to READ off picks either, and the pane cannot tell them apart — exactly as on the
// server.
export type SessionToolRowSeed = Partial<Omit<SessionToolSummary, 'name'>> & {
    name: string;
    pendingOnly?: boolean;
    created?: boolean;
    withheld?: boolean;
    beyondCap?: boolean;
};

// The page fields every collection read carries. Fixed figures on purpose: a test that pinned an
// `observed_at` would be pinning a clock.
const pageMeta = (rows: readonly unknown[]): PageMeta => ({
    limit: rows.length,
    next_cursor: null,
    observed_at: 0,
    revision: 1
});

// One session tool row, derived by the SERVER's rules from the kernel facts a fixture states.
// `unregisterable` is the kernel's unregister answer (src/harness.ts, the predicate behind
// `harness.isToolSwitchable`) restated over the seed: a name is unregisterable while it has a
// definition that is `visibility: 'core'` or is pending-only. Everything else follows from that one
// figure and the two enablement flavors, exactly as it does on the server post-R5:
//   - `protected` IS that figure — "cannot be unregistered" — and `declared` does NOT enter it (the
//     old rule `isCoreToolName(name) || declared` is what this double used to get wrong in BOTH
//     directions). It is NOT a switch reason any more: every registered name toggles, so a
//     protected row is clickable, its PATCH answers 200, and nothing in the Tools pane reads this
//     field;
//   - `enabled` defaults to ON for EVERY registered name, protected included: a session the server
//     created NEW seeds its gate with every globally-enabled registration. It is false only when
//     the seed states one of the two flavors — `withheld` (this conversation switched it off) or
//     `beyondCap` (the capped toolbox had no free slot). The old "a protected name is reported off
//     because it never holds a slot" rule is GONE, and a fixture that still derives `enabled` from
//     `visibility: 'core'` is re-asserting the contract this pass removed;
//   - `origin` is `created` when this session registered the name, else `discovered` when it is
//     enabled without being declared, else `catalogue`.
// A fixture that wants a NON-seeded figure overrides `enabled`/`protected` directly — the override
// is honoured, the derivation only fills what the seed leaves unstated.
export const sessionToolRow = (seed: SessionToolRowSeed, sessionId = 's1'): SessionToolSummary => {
    const declared = seed.declared ?? false;
    // The UNREGISTER axis (`true` for a `visibility: 'core'` name and for a pending-only control
    // such as `toolCancel`), NOT the toggle axis: both of those are switchable now.
    const unregisterable = (seed.visibility ?? 'searchable') === 'core' || seed.pendingOnly === true;
    const isProtected = seed.protected ?? unregisterable;
    // Registered means ON by default; only the two false-flavors the kernel can produce make it
    // false, and a seed that states `enabled` wins over both.
    const enabled = seed.enabled ?? !(seed.withheld === true || seed.beyondCap === true);

    return {
        name: seed.name,
        group: seed.group ?? 'Story tools',
        description: seed.description ?? `${seed.name} tool`,
        tags: seed.tags ?? [],
        visibility: seed.visibility ?? 'searchable',
        session_bound: seed.session_bound ?? false,
        ...(seed.availability === undefined ? {} : { availability: seed.availability }),
        // The session's live enabled figure: whether an agent in THIS conversation may call the
        // name (../shared/harness-api.ts `SessionToolSummary`), not the deployment's global switch.
        // The pane reads it and paints the tile from it, in both directions.
        enabled,
        session_id: seed.session_id ?? sessionId,
        declared,
        origin: seed.origin ?? (seed.created === true ? 'created' : !declared && enabled ? 'discovered' : 'catalogue'),
        protected: isProtected,
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
    // Refuse every tool switch: a fixture's own statement that the write fails (the CURRENT route
    // has no such refusal — an `enabled`-only PATCH answers 200 for every registered name, idle or
    // running — so this option models an older build, a dropped session, or a deliberate refusal the
    // failure-mark tests need). The sentence is what the pane prints verbatim.
    toolPatchStatus?: number;
    toolPatchMessage?: string;
    // Refuse ONLY some tool switches, answering the default envelope for the rest. There is NO
    // default: R5 removed the rule this used to carry ("a protected row refuses with 403"), so the
    // double accepts every `enabled` write unless a fixture opts into a refusal here.
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
    const seedsOf = (): SessionToolRowSeed[] => [
        ...(typeof options.tools === 'function' ? options.tools() : options.tools ?? [])
    ];
    const pluginsOf = (): PluginSummary[] => [
        ...(typeof options.plugins === 'function' ? options.plugins() : options.plugins ?? [])
    ];

    // Accepted writes land here, so a re-read shows the new figure the way the server's stored
    // state does. A fixture that instead drives rows through a getter keeps authority: the store
    // starts empty and every read re-runs its getter.
    const overrides = new Map<string, { enabled: boolean }>();

    // The row is projected from the seed + the accepted writes, on EVERY read — which is what the
    // server does too (`sessionToolRowsOf` re-reads the live enabled set per request). The write
    // therefore moves `enabled` AND everything derived from it: a name the conversation just
    // switched off stops reporting `origin: 'discovered'`, because `discovered` is an ENABLED name
    // this session did not declare. Patching the built row instead would leave a stale `origin`
    // beside a fresh `enabled`, i.e. a pair the server cannot send.
    const toolRows = (): SessionToolSummary[] =>
        seedsOf().map((seed) => sessionToolRow({ ...seed, enabled: overrides.get(seed.name)?.enabled ?? seed.enabled }, sessionId));

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

        if (row === undefined) return failure(`unknown tool '${name}'`, 404);

        // R5: this route has NO built-in refusal left. `protected` is the unregister axis, so a
        // `visibility: 'core'` name (`write`) and a pending-only control (`toolCancel`) answer 200
        // like every other registered name, and so does a conversation with work queued — the switch
        // is agent-facing and lands on the agents' next turn. The 403 this double used to answer for
        // a protected row, and the blanket 409 its `toolPatchStatus` doc used to describe, are both
        // gone from the RULE; a fixture that still wants a refusal opts into it per name
        // (`toolPatchGuard`) or outright (`toolPatchStatus`), and the pane paints whatever sentence
        // comes back without judging the status code.
        const refuses = options.toolPatchGuard;

        if (settings.enabled !== undefined && refuses !== undefined && refuses(name)) {
            return failure(`Tool "${name}" could not be switched in session "${sessionId}".`, 403);
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
    // The kernel fact behind a pending-only registration (`toolCancel`): the UNREGISTER rule refuses
    // it even though its manifest visibility reads `searchable`. Forwarded to `sessionToolRow`,
    // which is where that rule is restated. It is NOT a switch fact — the row is togglable.
    pendingOnly?: boolean;
    // This session registered the name (`record.core.createdTools`), which is the first branch of
    // the server's `origin` rule.
    created?: boolean;
    // The two flavors of `enabled: false` (see `SessionToolRowSeed`): this conversation withheld the
    // name, or its capped toolbox has no free slot for it. A fixture that states NEITHER gets the
    // fresh-conversation figure, which is ON for every registered name — `visibility: 'core'`
    // included, because R5 ended the "a core name is reported off" rule.
    withheld?: boolean;
    beyondCap?: boolean;
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
                        // The two kernel facts the seed may state, forwarded untouched so a fixture
                        // can describe a `toolCancel` (pending-only) or a created row at all.
                        ...(tool.pendingOnly === undefined ? {} : { pendingOnly: tool.pendingOnly }),
                        ...(tool.created === undefined ? {} : { created: tool.created }),
                        // The two flavors of an OFF row, forwarded the same way. Without them the
                        // row gets the fresh-conversation figure — ON for EVERY registered name,
                        // `visibility: 'core'` included, because the core flag is the UNREGISTER
                        // axis now and not a reason to report a name as off. That is the figure
                        // main.ts paints its tile from.
                        ...(tool.withheld === undefined ? {} : { withheld: tool.withheld }),
                        ...(tool.beyondCap === undefined ? {} : { beyondCap: tool.beyondCap })
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
