// GENERATED FILE — DO NOT EDIT.
//
// Regenerate with:
//
//   node scripts/generate-plugin-manifest.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// `harness()` auto-loads every built-in plugin discovered by scanning
// `src/plugins/**/*.plugin.ts`. A browser cannot read files, so the scan result ships
// here as generated wiring. The metadata object itself is imported from the plugin
// file, never duplicated, so the plugin remains the single owner of its own description
// (name, title, settings, hooks) and the manifest cannot drift from it.
//
// There is no hand-maintained plugin inventory anywhere in the package.
//
// Cross-references:
//   - ../plugins/**/*.plugin.ts                     — the authoritative metadata owners
//   - ../../scripts/generate-plugin-manifest.mjs    — the scanner/generator
//   - ../../scripts/plugin-manifest-render.mjs      — this renderer
//   - ../plugin/host.ts                             — applies BUILTIN_PLUGINS first


import type { HarnessPlugin, HarnessPluginMetadata } from '../types';

import { metadata as asyncPingMetadata, setup as asyncPingSetup } from '../plugins/async-ping.plugin';
import { metadata as contextCompactionMetadata, setup as contextCompactionSetup } from '../plugins/context-compaction.plugin';

// Every discovered built-in's declared metadata, in scan order (path ascending). This
// is the catalogue the server hands the UI's Plugins pane; a plugin that registers no
// hooks still appears here, because an operator must be able to SEE it.
export const BUILTIN_PLUGIN_DESCRIPTORS: readonly HarnessPluginMetadata[] = [
    asyncPingMetadata,
    contextCompactionMetadata
];

// The same entries as runnable plugins. `runPlugins` applies these BEFORE
// `configuration.plugins`, so a programmatic plugin that names a built-in replaces it
// instead of colliding with it.
export const BUILTIN_PLUGINS: readonly HarnessPlugin[] = [
    {
        name: asyncPingMetadata.name,
        metadata: asyncPingMetadata,
        setup: asyncPingSetup
    },
    {
        name: contextCompactionMetadata.name,
        metadata: contextCompactionMetadata,
        setup: contextCompactionSetup
    }
];
