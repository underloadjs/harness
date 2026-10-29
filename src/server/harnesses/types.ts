// Shared shapes for the harness catalogue.
//
// A preset is a *factory*, not a harness: a harness bakes its transport in at
// construction, so changing the endpoint (base URL, key, model) means building a
// new one. Both the CLI and the HTTP server use these factories; neither the
// published package nor the browser UI knows about them.

import type {
    Harness,
    HarnessProgress,
    HarnessStateChangeEvent,
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
    // tool set (agentDelegate exists only when there is somewhere to delegate).
    subagents: readonly string[];
    // Declared for display only — the harness registry is the source of truth.
    agents: readonly string[];
    tools: readonly string[];
    // Declared tools that only exist when the host configured their credential
    // (today: `webSearch`, backed by EXA_API_KEY / TAVILY_API_KEY).
    //
    // Deliberately declarative: a descriptor must be computable without building
    // the harness (and therefore without constructing a live agent or a session),
    // so src/server/api.ts resolves these names against the RUNTIME tool catalogue and
    // appends only the ones with an executable definition. A keyless host adds
    // nothing, which keeps "listed" == "callable" — the preset factory itself
    // already skips registration when the key is absent (see src/harness.ts).
    // Every live preset and the recoverable-failure example declare `webSearch`
    // (all are built by createToolboxHarness, which opts in); the scripted demo
    // does not.
    environmentTools?: readonly string[];
    // Per-agent model overrides (R9): agent id → model id. A member that is absent
    // falls back to `RunnerSettings.model`, so a harness can swap the model of one
    // agent (the summarizer on a small model, the primary on a large one) without
    // touching the others. Only ids are overridable — never a provider, base URL,
    // or credential. Empty/absent means "the session model for every member".
    agentModels?: Readonly<Record<string, string>>;
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

// How a tool is grouped in the direct-call catalogue. 'Web search' is separate
// from the presets because webSearch is credential-dependent and opt-in: a host
// must see at a glance whether this deployment can run it. 'Core tools' holds the
// harness-owned set (toolRequest, toolCreate, todoManage, agentDelegate), which are
// listed for review and manual execution but only ever run inside a session. R18:
// the core FILE tools stay in 'Package presets' and are directly callable, because
// 'core' visibility does not imply a session binding.
export type ToolGroup = 'Package presets' | 'Harness tools' | 'Web search' | 'Core tools';

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
// `sessionBound` marks the harness-owned CORE tools (R8): toolRequest, toolCreate,
// todoManage, agentDelegate. They have no `tool` and can never be called with a
// dummy implementation: they run inside a session's harness, so the server requires
// a `sessionId` and forwards the call to `harness.executeTool`. R18 keeps the flag
// off the core file tools and webSearch: they have real implementations and run
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
