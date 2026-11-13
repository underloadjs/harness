// Shared shapes for the harness catalogue.
//
// A preset is a *factory*, not a harness: a harness bakes its transport in at
// construction, so changing the endpoint (base URL, key, model) means building a
// new one. Both the CLI and the HTTP server use these factories; neither the
// published package nor the browser UI knows about them.

import type {
    Harness,
    HarnessDiagnosticEvent,
    HarnessInteractionConfiguration,
    HarnessPluginSettingsProvider,
    HarnessProgress,
    HarnessStateChangeEvent,
    HarnessToolSettingsProvider,
    Tool,
    ToolVisibility
} from '../../harness';

// The provider settings a caller can change per session.
export type RunnerSettings = {
    baseURL: string;
    apiKey: string;
    model: string;
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
};

// One named harness in the catalogue.
export type HarnessPreset = {
    // Harness name, which is also the entry agent's name.
    name: string;
    // Human title shown in the UI and CLI listing.
    title: string;
    description: string;
    // Live presets need a base URL; the scripted demo does not.
    requiresEndpoint: boolean;
    // The entry agent (explicit, never inferred from key order).
    primary: string;
    // The delegation allowlist. Empty for a single-agent harness; Research names
    // `summarizer`. This is exposed so a descriptor can report the actual core
    // tool set (delegate exists only when there is somewhere to delegate).
    subagents: readonly string[];
    // Declared for display only — the harness registry is the source of truth.
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
    // agent (the summarizer on a small model, the primary on a large one) without
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
