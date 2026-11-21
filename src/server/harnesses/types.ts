// Shared shapes for the harness catalogue.
//
// A preset is a *factory*, not a harness: a harness bakes its transport in at
// construction, so changing the endpoint (base URL, key, model) means building a
// new one. Both the CLI and the HTTP server use these factories; neither the
// published package nor the browser UI knows about them.

import type {
    Harness,
    HarnessCommandConfiguration,
    HarnessDiagnosticEvent,
    HarnessInteractionConfiguration,
    HarnessKnowledge,
    HarnessPlugin,
    HarnessPluginSettingsProvider,
    HarnessProgress,
    HarnessStateChangeEvent,
    HarnessToolSettingsProvider,
    Tool,
    ToolVisibility
} from '../../engine/harness';
// THE RANK MODEL (B-series): a harness definition states an ENTRY agent (routing)
// plus a RANK MAP (authority). `AgentRank` is the A–Z letter union owned by
// ../types/index.ts (`AgentRank` / `AGENT_RANKS` / `rankIndexOf` / `isLowerRank`);
// this layer only stores and projects it, never re-derives the ordering.
import type { AgentRank } from '../../engine/types';

// The provider settings a caller can change per session.
//
// (T8, AC2) The three provider TIME BOUNDS ride along with the endpoint they bound.
// They are optional and additive: absent means "this session has no opinion", and the
// transport then resolves the value itself — environment variable first, shipped
// default last (`../../transport/provider-timeouts.ts`, one parser:
// `resolveProviderTimeout`). Supplying one makes THIS session authoritative over both,
// which is the whole point: a deployment whose slow provider needs a longer head bound
// can raise it for one provider without restarting the process on an env var, and
// `0` disables that bound for that session alone. Validation (and therefore the
// 400-vs-what a client sent decision) lives in `mergeSettings` (../config.ts), so the
// REST surface and the store refuse the same bad value with the same message.
export type RunnerSettings = {
    baseURL: string;
    apiKey: string;
    model: string;
    // Bound on `fetch` resolving with response headers, in ms (`0` = off).
    responseHeadTimeoutMs?: number;
    // Bound on the FIRST streamed token after the head, in ms (`0` = off).
    firstTokenTimeoutMs?: number;
    // Bound BETWEEN consecutive reads of an open body, in ms (`0` = off).
    streamChunkTimeoutMs?: number;
    // F1 (2026-11-17): how many CONSECUTIVE network-class failures one conversation
    // tolerates before the server stops AUTO-RESUMING it. Same discipline as the three time
    // bounds above: optional and additive, absent means "no opinion" (the deployment's
    // `HARNESS_PROVIDER_NETWORK_RESUME_LIMIT`, then the shipped default of 10 — see
    // `DEFAULT_NETWORK_RESUME_LIMIT` in ../config.ts), `0` means "never auto-resume", and the
    // value is validated by `mergeSettings` so a bad one answers 400 rather than being
    // coerced into an off-by-default feature.
    //
    // It is a PROVIDER field because it bounds what a flaky provider costs: a deployment
    // whose gateway drops connections every few minutes can raise the ceiling for that one
    // provider, and a deployment that wants failures to stay visible can turn the loop off.
    networkResumeLimit?: number;
};

// THE TOOLBOX POSTURE A HOST APPLIES TO HARNESSES BUILT THROUGH ITS FACTORIES.
//
// This is the one shape shared by every place a boot-time toolbox decision is made,
// so they cannot drift:
//   - `HarnessBootConfiguration.toolbox` (./boot.ts) — the host's deployment default;
//   - `HarnessRegistryOptions.creation` (./registry.ts) — what `POST /harnesses`
//     creates and what a restored registry row rebuilds with;
//   - `HarnessPreset.creation.toolbox` (below, `HarnessPresetCreation`) — the
//     effective PER-CARD posture a compiled preset was built with, so an executable
//     registry patch or a frozen-session restore rebuilds THAT card instead of the
//     deployment-wide default.
//
// There is deliberately no `HarnessPresetReport.toolbox`: a per-build report is the
// wrong seam for a posture (a factory states its own; the registry supplies the
// defaults), and no code path ever reads one.
//
// PRECEDENCE, exactly: a factory's own field wins, then the registry/card default,
// then the historical value (`createToolboxHarness` defaults `sharedToolbox` to
// `true`). That is why the BOOT resolver must resolve `sharedToolbox` to an explicit
// boolean: a bare boot is `.toolbox.sharedToolbox === false` (the harness-owned core
// floor only), and an explicit `presets` list can opt a factory into the shared set by
// stating `true`.
//
// SERIALIZABLE BY CONSTRUCTION except `extraTools`: every member is a boolean, number,
// string, path map, or constructed `Tool` definition. That boundary is deliberate — a
// lane worker can receive everything except the constructed definitions (see the
// worker note in ../sessions.ts `blueprintFor`).
export type HarnessToolboxDefaults = {
    // Whether the shared toolbox (package presets + app tools + environment rows) is
    // registered. Absent means the CALLER's default: `true` for direct factory callers
    // and `false` at the server boot seam (./boot.ts resolves it there).
    sharedToolbox?: boolean;
    // The tool-loop budget; absent/Infinity means uncapped (the shipped posture).
    maxIterations?: number;
    // Explicit environment-row opt-ins. Each falls back to `sharedToolbox`, so a
    // toolbox that keeps only the shared file tools can still disable `fetch`/`search`.
    websearch?: boolean;
    webfetch?: boolean;
    // Extra EDITABLE tool sources, merged after the shared source map (or used alone
    // with `sharedToolbox: false`). Keys are tool names, values package-relative paths.
    extraToolSources?: Readonly<Record<string, string>>;
    // Extra constructed definitions, registered last so they win over every source.
    extraTools?: Readonly<Record<string, Tool>>;
    // Extra package-relative folders scanned during construction (the live-authoring
    // half of the tool set). Merged after the shared folder list.
    toolFolders?: readonly string[];
};

// Persistence observer the server may attach at construction (R3a/R3b). Optional
// and additive: an existing caller that passes only `(settings, progress)` keeps
// working, while the server passes `stateChange` so a completed tool call, an
// appended message, a created tool, reset(), and restore() become durable without
// waiting for session close. The callback is advisory; the harness swallows its
// exceptions (a persistence failure must not change a run's outcome).
export type HarnessPresetReport = {
    stateChange?: (event: HarnessStateChangeEvent) => void;
    // N4 owner interaction, forwarded verbatim into HarnessConfiguration.interaction
    // by the shared toolbox factory. It lives beside `stateChange` because both are
    // server/host hooks supplied at construction, and keeping it on this one
    // optional third argument is what lets every existing factory signature and
    // caller stay unchanged. A factory that ignores it (the scripted demo before
    // its N4 update, or a custom preset) simply produces a harness with no owner
    // questions rather than failing.
    interaction?: HarnessInteractionConfiguration;
    // T5 (R2/R3): the host's LIVE plugin settings provider, forwarded verbatim into
    // HarnessConfiguration.pluginSettings by the shared toolbox factory. Same optional-third
    // -argument discipline as `interaction` above, so every existing factory signature and
    // caller keeps compiling and a factory that ignores it simply produces a harness on the
    // library's declared-default provider (src/harness.ts:1080) rather than failing.
    //
    // It is a PROVIDER, not a snapshot, and that is the whole point: `harness()` stores the
    // reference and each plugin's `api.settings` re-reads it on every call
    // (src/plugin/settings.ts, src/plugin/host.ts:151), so a settings write reaches an ALREADY
    // RUNNING session on its next turn with no rebuild. R4 moved the scope of that write:
    // SessionStore passes ONE PROVIDER PER SESSION (../sessions.ts `buildHarness` receives the
    // session's own store), so `PATCH /v1/harness/sessions/{id}/plugins/{plugin_id}` moves the
    // session holding this reference, while `PATCH /v1/harness/plugins/{plugin_id}` moves only the
    // sessions created afterwards (../sessions.ts `create`, ../plugins.ts `copyPluginSettingsStore`);
    // the worker lane cannot share it either (see ../plugins.ts, "WORKER MODE").
    pluginSettings?: HarnessPluginSettingsProvider;
    // R3: the host's LIVE global tool provider (the tool names this deployment has switched
    // off for every session), forwarded verbatim into
    // `HarnessConfiguration.toolSettings` by the shared toolbox factory. Same optional-third
    // -argument discipline as `pluginSettings` above: every existing factory signature and
    // caller keeps compiling, and a factory that ignores it simply produces a harness with
    // nothing disabled globally.
    //
    // A PROVIDER, never a snapshot, for the same reason: `harness()` keeps the reference and
    // re-reads it while building each request's tool list (src/harness.ts `declared`), so
    // `PATCH /v1/harness/tools/{tool_id}` reaches an ALREADY RUNNING session on its next
    // turn. The store is process-wide (../tool-settings.ts) and `../sessions.ts`
    // `buildHarness` passes one provider for the whole runtime; the worker lane cannot
    // (../tool-settings.ts, "WORKER MODE").
    toolSettings?: HarnessToolSettingsProvider;
    // R1: "this build should START with the whole switchable toolbox enabled", forwarded by
    // the shared toolbox factory into `HarnessConfiguration.enableAllTools`. It rides this one
    // optional third argument for the identical reason `toolSettings` above does: every
    // existing factory signature and caller keeps compiling, and a factory that ignores it
    // simply produces a harness on the library default (an empty enabled set, discovery-driven).
    //
    // IT IS A BUILD DECISION, NOT A DEPLOYMENT FACT, which is why the value is per-build and
    // not a constant in the factory: `../sessions.ts` `create` sets it for a session that has
    // never run, and `../sessions.ts` `restoreSession` leaves it unset for a session whose
    // enabled set comes back from its own committed snapshot. A preset that does not build
    // through `createToolboxHarness` is free to ignore it, exactly like the other report
    // fields — nothing about that factory's behaviour changes.
    enableAllTools?: boolean;
    // THE COMPLETE PLUGIN SET this deployment applies to every harness build (R-boot).
    //
    // `undefined` means "this host has no plugin configuration" and leaves the factory's
    // own default (the generated `BUILTIN_PLUGINS`) in place — the historical behaviour for
    // a direct factory caller. An ARRAY is authoritative: `[]` registers NO plugin at all,
    // and a non-empty list registers exactly those entries, with NO implicit built-ins.
    // `createToolboxHarness` expresses that by passing `builtinPlugins: []` alongside
    // `plugins: report.plugins` into `HarnessConfiguration` (../../types, ./toolbox.ts), so
    // "omitted at the boot seam" can never silently regain the shipped three plugins.
    //
    // WHY IT RIDES THE REPORT and not the preset: plugins are a DEPLOYMENT decision (the
    // same list for every session of the process), while a preset is a reusable factory.
    // A SessionStore therefore always passes its configured list — including `[]` — so a
    // registry-created preset, a restored frozen preset and a shipped card all see one
    // answer. A custom factory that ignores the report keeps the library default; that is
    // the documented limit of every field here, and it is why the shipped factory path
    // (`createToolboxHarness`) forwards it.
    plugins?: readonly HarnessPlugin[];
    // Slash commands this deployment registers on every harness it builds, in the same
    // additive-report style. Absent means none. `createToolboxHarness` forwards the list
    // into `HarnessConfiguration.commands`, AFTER the harness's own built-in commands, so
    // a collision is construction's own duplicate-name error rather than a silent shadow.
    commands?: readonly HarnessCommandConfiguration[];
    // Plugin diagnostics (pipeline T1.5's last mile). Same optional-third-argument discipline
    // as `stateChange`, `interaction` and `pluginSettings` above, so every existing factory
    // signature and caller keeps compiling and a factory that ignores it simply produces a
    // harness with no diagnostic sink.
    //
    // WHY THIS IS HERE AT ALL: the library channel exists and IS wired —
    // `createHookBus({ onHandlerError: notifyPluginDiagnostic })` and a plugin's own
    // `api.report.diagnostic` both land on `harness({ report.diagnostic })`
    // (src/types/index.ts `HarnessDiagnosticEvent`) — but until now no server host PASSED one,
    // so a broken plugin on a durable session was still invisible: "the compactor is throwing"
    // and "the compactor decided to do nothing" read identically through `GET /sessions`. This
    // member is the one line the server needed to install a sink; the store's implementation
    // (src/server/sessions.ts `buildHarness`) journals the event on the session and logs the
    // failure kinds.
    //
    // Synchronous, advisory, and never a run failure: the harness swallows a throw from this
    // callback (the same rule as `stateChange`), so a sink that cannot allocate a string cannot
    // take a conversation down with it.
    diagnostic?: (event: HarnessDiagnosticEvent) => void;
    // T7: the host's CROSS-SESSION knowledge base, forwarded on the identical top-level rule
    // `pluginSettings` and `toolSettings` use (it is a `HarnessConfiguration` field,
    // ../types `HarnessConfiguration.knowledge`): presence means this harness writes through
    // the deployment's base, absence means the library builds its own in-memory engine.
    //
    // WHY IT RIDES THIS ARGUMENT rather than being a field of the preset: knowledge is a
    // DEPLOYMENT fact (one store per resolved database root, ./runtime.ts), while a preset is a
    // reusable FACTORY shared by every session of that deployment. Baking it into the preset
    // would put the process's store in a closure the registry copies around.
    //
    // A LIVE OBJECT CROSSING A WORKER BOUNDARY IS THE KNOWN LIMIT, and it is the same one the
    // two providers above document: a lane WORKER REPLICA cannot receive this reference through
    // `worker_threads`, so a replica runs on its own in-memory engine until a per-worker store
    // is plumbed (the blueprint would carry the ROOT and the worker would load it, exactly as
    // `laneToolSettingsProvider` rebuilds the provider from the shipped NAME LIST).
    knowledge?: HarnessKnowledge;
    // T6: THE CANONICAL HARNESS NAME this build attributes new knowledge articles to, forwarded
    // verbatim into `HarnessConfiguration.knowledgeOwner` by the shared toolbox factory (the
    // same optional-third-argument rule as every field above, so a preset that ignores it simply
    // produces an UNOWNED build rather than failing).
    //
    // WHY IT RIDES THE REPORT: the value is chosen by the host that owns the catalogue
    // (../sessions.ts `buildHarness` passes `preset.name`, the exact identity the HTTP deletion
    // guard counts sessions by), and a preset is a reusable factory with no reason to know its
    // deployment identity. A closure or preset-baked name would let two registry entries (an
    // alias, a copy) disagree about who owns what; this field has ONE source, the frozen preset
    // name, so the create-time stamp and the delete-time filter name the same harness.
    //
    // The article field remains `KnowledgeArticle.harness`; this is only the carrier that tells
    // the knowledge engine who is writing. A host that builds harnesses outside
    // `SessionStore` may omit it, and every article it creates stays unowned.
    knowledgeOwner?: string;
};

// THE CARD'S IN-MEMORY REBUILD METADATA (R-boot, B4).
//
// WHY THIS EXISTS: a preset's `create` is a closure. Before this field, an executable
// registry PATCH (`update()` on the roster/ranks/agent maps) and a frozen-session
// restore both rebuilt the factory from the DEPLOYMENT-wide creation defaults, so a
// card compiled with its own toolbox (a tool-less card, a per-card extra tool, an
// advanced host factory) silently widened to the default toolbox on the first edit or
// restart. Recording what the factory was BUILT with keeps the card's own declaration
// authoritative without widening the durable record schema (which must stay free of
// executable closures).
//
// This is INTERNAL state: it is never projected onto the wire (`presetToRecord` lists
// its fields explicitly and omits this one).
export type HarnessPresetCreation = {
    // How `create` may be reconstructed.
    //   - 'profiled' — `createProfiledHarness`/`createToolboxHarness` over `toolbox`
    //                  below; the registry CAN rebuild it from a new roster/rank/map set.
    //   - 'advanced' — a host-supplied factory (`HarnessBootPresetConfiguration.create`
    //                  or an injected `HarnessPreset`). Nothing here can reconstruct it,
    //                  so an executable patch is refused rather than silently replaced
    //                  by a profiled harness, and a frozen-session restore reuses the
    //                  still-available factory only when its executable fields match.
    factory: 'profiled' | 'advanced';
    // The EFFECTIVE per-card posture the profiled factory was compiled with. Every
    // boolean is materialized (sharedToolbox/websearch/webfetch), and an explicit empty
    // `extraToolSources`/`extraTools`/`toolFolders` stays empty — a card that cleared an
    // inherited set must not regain it on the next rebuild. Absent on 'advanced'.
    toolbox?: HarnessToolboxDefaults;
};

// One named harness in the catalogue.
export type HarnessPreset = {
    // Harness name, which is also the entry agent's name by convention (a
    // user-created harness may name its entry anything inside its own roster).
    name: string;
    // Human title shown in the UI and CLI listing.
    title: string;
    description: string;
    // Live presets need a base URL; a scripted fixture does not.
    requiresEndpoint: boolean;
    // THE ENTRY AGENT (routing, not authority): the agent an unfocused submit opens
    // a conversation for. Explicit, never inferred from key order on the WIRE, but
    // it is always a member of `agents`. It replaces the old `primary`, and it is
    // NOT an authority concept: an entry agent holds whatever rank `ranks` gives it,
    // and a harness may hold any number of Rank A agents.
    entry: string;
    // THE RANK MAP (authority): agent id → A–Z rank letter, `A` highest. Delegation
    // is derived purely from it — an agent may delegate only to a STRICTLY lower
    // rank, so a same-rank peer is not a target and an upward target is refused
    // (../types/index.ts `isLowerRank`). Keys name members, and a stored preset's map
    // covers EVERY member: ./registry.ts resolves a sparser request into this map with
    // the kernel's own fill rule (./toolbox.ts `resolveRosterRanks`), so what a card
    // advertises is exactly what the harness runs — never a subset the client happened
    // to write. There is NO `subagents` allowlist any more: the
    // allowlist was rank-derived all along, and the ranks say it outright.
    //
    // `coreTools` projects `delegate` exactly when this map holds TWO OR MORE
    // DISTINCT rank letters (./toolbox.ts `coreToolNames`), because a single-rank
    // roster has no strictly-lower target to hand work to.
    ranks: Readonly<Record<string, AgentRank>>;
    // THE ROSTER, in declaration order. ORDER IS LOAD-BEARING: the first name is
    // the entry default when `entry` is omitted on create/PATCH (./registry.ts), so
    // a roster is never an unordered bag of names. Declared for display on a
    // preset — the harness registry is the source of truth for what a session runs.
    agents: readonly string[];
    tools: readonly string[];
    // Declared tools that only exist when the host configured their credential
    // (today: `search`, backed by EXA_API_KEY / TAVILY_API_KEY).
    //
    // Deliberately declarative: a descriptor must be computable without building
    // the harness (and therefore without constructing a live agent or a session),
    // so src/server/api.ts resolves these names against the RUNTIME tool catalogue and
    // appends only the ones with an executable definition. A keyless host adds
    // nothing, which keeps "listed" == "callable" — the preset factory itself
    // already skips registration when the key is absent (see src/harness.ts).
    // Every live preset and the recoverable-failure example declare `search`
    // (all are built by createToolboxHarness, which opts in); the scripted demo
    // does not.
    environmentTools?: readonly string[];
    // Per-agent model overrides (R9): agent id → model id. A member that is absent
    // falls back to `RunnerSettings.model`, so a harness can swap the model of one
    // agent (the summarizer on a small model, the entry agent on a large one) without
    // touching the others. Only ids are overridable — never a provider, base URL,
    // or credential. Empty/absent means "the session model for every member".
    agentModels?: Readonly<Record<string, string>>;
    // Per-agent INSTRUCTION overrides (T3 editable configuration): agent id →
    // instruction text. Same replace/key-membership rules as `agentModels`, and the
    // same capture rule: the factory closure holds the map, so a later PATCH cannot
    // rewrite what an existing session was built with. A member absent from the map
    // runs the trusted `AgentProfile.instruction`; the profile itself is never
    // mutated. Since T6 the stored value IS that member's COMPLETE prompt (the UI
    // edits one box holding the full effective instruction), so `AgentProfile.guidelines`
    // are the default for an un-overridden member rather than policy appended below an
    // override. This is what makes the UI's instruction editor a REAL edit: the text
    // is validated, persisted on the registry entry, projected onto the descriptor,
    // and consumed by `agentInstruction()` when the agent is built.
    agentInstructions?: Readonly<Record<string, string>>;
    // Per-agent identity COLORS (R2): agent id → CSS hex color (`#rgb`, `#rgba`,
    // `#rrggbb`, `#rrggbbaa`, either case). Same replace/key-membership rules as
    // `agentModels`, and the same capture rule: the factory closure holds the map, so
    // a later PATCH cannot recolor what an existing session was built with.
    //
    // This one is DISPLAY-ONLY rather than prompt-shaping: nothing in the runtime or
    // the transport reads it, and it never reaches a model request. It exists so the
    // UI paints one stable, operator-chosen swatch per agent instead of hashing the
    // agent's name, and it is projected onto `HarnessDescriptor.agentColors` (and
    // therefore onto the contract's `agent_colors`) for exactly that. A member absent
    // from the map is uncolored here, which is the host's cue to fall back to its own
    // derivation; the value is validated against the hex shape at both the registry
    // edge and `agent()` construction, so a stored color is always paintable.
    agentColors?: Readonly<Record<string, string>>;
    // SESSION-DEFINED agents (R7): agent id → the BASE instruction that agent runs. Absent /
    // empty means "this template declares no custom agent", which is every harness DEFINITION
    // and every session saved before R7.
    //
    // This map is SESSION state, not definition state: only a session's own frozen preset copy
    // ever carries it (`SessionStore.addSessionAgent` writes it through `applyBindingMaps`, and
    // `HarnessRegistration`/`HarnessPatch` deliberately expose no field for it, so
    // `POST`/`PATCH /harnesses` can never declare one). A member named here is NOT a catalogue
    // profile: it has no `AgentProfile`, no guidelines, and no global override layer, so the
    // text stored here IS the whole system prompt. `agentsFromProfiles` reads this map FIRST —
    // a name listed here is built by `agentConfigurationForCustom` instead of
    // `agentConfigurationFromProfile`, which is what makes a session-scoped custom agent
    // rebuild byte-identically after a restart (see ./toolbox.ts and ./registry.ts
    // `presetFromRecord`).
    //
    // The same capture rule as the three maps above holds: the factory closure holds it, so a
    // later registry PATCH cannot add or drop one of an existing conversation's agents.
    customAgents?: Readonly<Record<string, string>>;
    // Shipped with the application (`true`) or registered by a client through
    // POST /harnesses (`false`). Informational provenance only: both are editable
    // application entries, and the registry never uses this to gate a mutation.
    builtin: boolean;
    // COMPATIBILITY ONLY (R20.1). Always true: the registry starts from
    // independent copies of the shipped templates and records every create/PATCH
    // as a new entry, so there is no read-only harness category any more. The
    // field stays on the wire so existing clients keep their shape.
    editable: boolean;
    // INTERNAL execution template — never projected onto the wire. The registry
    // uses it when a patch changes the executable team or models:
    //   - 'live'     (default) — rebuild with createProfiledHarness;
    //   - 'scripted' — the demo's offline script. A metadata-only patch keeps the
    //                  script; an executable patch upgrades it to a LIVE profiled
    //                  harness so the card stops advertising scripted behaviour;
    //   - 'flaky'    — the failure example. A metadata-only patch keeps its
    //                  factory; an executable patch rebuilds the live toolbox with
    //                  the TestFlaky extra retained.
    template?: 'live' | 'scripted' | 'flaky';
    // THE FACTORY'S REBUILD METADATA (R-boot, B4). See `HarnessPresetCreation`. Present
    // on boot-compiled presets and every registry-created entry; absent on a hand-built
    // preset (the registry then falls back to its own creation defaults, exactly as
    // before this field existed). Never on the wire and never durable.
    creation?: HarnessPresetCreation;
    // Metadata a NON-LIVE template adopts when an executable patch upgrades it and
    // the current title/description are still the shipped ones. Without this, the
    // scripted demo would keep prose claiming no endpoint after it became a live
    // harness. A user-edited title/description is never overwritten. Not on the
    // wire.
    live?: { title: string; description: string };
    // Build a fresh harness. Progress is routed by the caller (a CLI renderer or
    // one HTTP session), which is why it is a parameter rather than a field. The
    // optional third argument carries the server's persistence observer (R3b);
    // factories that ignore it stay valid and simply produce no notifications.
    create: (
        settings: RunnerSettings,
        progress: HarnessProgress,
        report?: HarnessPresetReport
    ) => Harness;
};

// How a tool is grouped in the direct-call catalogue. 'Web search' and 'Web fetch'
// are separate from the presets because they are environment-backed and opt-in: a
// host must see at a glance whether this deployment can run them. R9-R11: both are
// declared core WHEN registered, so each needs its own catalogue entry
// (src/server/harnesses/{websearch,webfetch}.ts) — that is how a preset card can
// advertise the declaration it will really make. 'Core tools' holds the
// harness-owned set (toolRequest, task, and the registered-but-searchable rest),
// which are listed for review and manual execution but only ever run inside a
// session. R18: the core FILE tools stay in 'Package presets' and are directly
// callable, because 'core' visibility does not imply a session binding.
export type ToolGroup =
    | 'Package presets'
    | 'Harness tools'
    | 'Web search'
    | 'Web fetch'
    | 'Core tools';

// Whether a catalogue entry can actually run on this host.
//
// 'unconfigured' is not an error: it is the honest answer for a tool that needs a
// credential the server does not have. `environment` names the variables that
// would enable it (names only, never values) and `hint` is a non-secret sentence
// a UI or CLI can print verbatim.
export type ToolAvailability = {
    state: 'available' | 'unconfigured';
    environment?: readonly string[];
    hint?: string;
};

// One tool the server can list and (when configured) call directly, with no
// harness and no model.
//
// Metadata is copied out of the Tool so a disabled entry still has a name,
// description, tags, and schema to render. `tool` is present exactly when the
// entry is executable: a credential-dependent tool with no key has no callable
// definition, which is what keeps "listed" from meaning "pretends to work".
//
// `sessionBound` marks the harness-owned CORE tools (R8): toolRegistry,
// toolRequest, toolCreate, task, delegate. They have no `tool` and can never be called with a
// dummy implementation: they run inside a session's harness, so the server requires
// a `sessionId` and forwards the call to `harness.executeTool`. R18 keeps the flag
// off the core file tools and search: they have real implementations and run
// statelessly. Listing the harness-owned set is what lets the UI's Tools tab show
// it and run it against the selected session.
export type CatalogueEntry = {
    name: string;
    group: ToolGroup;
    tool?: Tool;
    description: string;
    tags: readonly string[];
    visibility: ToolVisibility;
    parameters: Record<string, unknown>;
    availability?: ToolAvailability;
    sessionBound?: boolean;
};
