// Shared shapes for the harness catalogue.
//
// A preset is a *factory*, not a harness: a harness bakes its transport in at
// construction, so changing the endpoint (base URL, key, model) means building a
// new one. Both the CLI and the HTTP server use these factories; neither the
// published package nor the browser UI knows about them.

import type { Harness, HarnessProgress, Tool } from '../src/harness';

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
    // Declared for display only — the harness registry is the source of truth.
    agents: readonly string[];
    tools: readonly string[];
    // Build a fresh harness. Progress is routed by the caller (a CLI renderer or
    // one HTTP session), which is why it is a parameter rather than a field.
    create: (settings: RunnerSettings, progress: HarnessProgress) => Harness;
};

// How a tool is grouped in the direct-call catalogue.
export type ToolGroup = 'Package presets' | 'Harness tools';

// One tool the server can call directly, with no harness and no model.
export type CatalogueEntry = {
    name: string;
    tool: Tool;
    group: ToolGroup;
};
