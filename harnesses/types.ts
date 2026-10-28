// Shared shapes for the harness catalogue.
//
// A preset is a *factory*, not a harness: a harness bakes its transport in at
// construction, so changing the endpoint (base URL, key, model) means building a
// new one. Both the CLI and the HTTP server use these factories; neither the
// published package nor the browser UI knows about them.

import type { Harness, HarnessProgress, Tool, ToolVisibility } from '../src/harness';

// The provider settings a caller can change per session.
export type RunnerSettings = {
    baseURL: string;
    apiKey: string;
    model: string;
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
    // (today: `websearch`, backed by EXA_API_KEY / TAVILY_API_KEY).
    //
    // Deliberately declarative: a descriptor must be computable without building
    // the harness (and therefore without constructing a live agent or a session),
    // so server/api.ts resolves these names against the RUNTIME tool catalogue and
    // appends only the ones with an executable definition. A keyless host adds
    // nothing, which keeps "listed" == "callable" — the preset factory itself
    // already skips registration when the key is absent (see src/harness.ts).
    // Every live preset declares `websearch`; the scripted demo and the
    // recoverable-failure example do not.
    environmentTools?: readonly string[];
    // Build a fresh harness. Progress is routed by the caller (a CLI renderer or
    // one HTTP session), which is why it is a parameter rather than a field.
    create: (settings: RunnerSettings, progress: HarnessProgress) => Harness;
};

// How a tool is grouped in the direct-call catalogue. 'Web search' is separate
// from the presets because websearch is credential-dependent and opt-in: a host
// must see at a glance whether this deployment can run it.
export type ToolGroup = 'Package presets' | 'Harness tools' | 'Web search';

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
export type CatalogueEntry = {
    name: string;
    group: ToolGroup;
    tool?: Tool;
    description: string;
    tags: readonly string[];
    visibility: ToolVisibility;
    parameters: Record<string, unknown>;
    availability?: ToolAvailability;
};
