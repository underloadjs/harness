// @underload/harness tools/catalogue — the static half of every preset, DERIVED.
//
// WHY THIS FILE EXISTS
// --------------------
// A harness can be created (and a model prompted) without ever needing a tool's
// implementation. The interesting metadata — name, description, tags, schema — must
// therefore be readable without importing `node:fs`, `node:child_process`, or any
// other preset body. That is the whole point of R1b: keep the catalogue cheap to
// enumerate and load the body on first execution.
//
// DERIVED, NOT MAINTAINED (T21 → T24)
// -----------------------------------
// This module used to carry a hand-written `PRESET_TOOLS` projection of every
// `*.tool.ts` metadata constant plus a per-name `loadPresetTool` import switch.
// Both were a second inventory that had to be edited whenever a tool was added, and
// the projection could silently drift from the entries it claimed to mirror.
//
// The inventory is now discovered, reached through `./descriptors`:
//
//   PRESET_DESCRIPTORS   — one row per discovered `src/tools/**/*.tool.ts` entry
//   descriptorMetadata() — that entry's declarative half (a detached copy)
//   loadPresetTool()     — generated `import()` when the manifest knows the entry,
//                          runtime source compilation when it does not
//
// T24: `./descriptors` takes a LIVE scan on Node (the same reader `harness({})`
// uses) and only falls back to the GENERATED manifest in a browser or a
// scanner-less build. So a new entry appears here on the next cold start without
// regenerating anything; the manifest is a browser artifact, not the Node truth.
//
// So adding a tool means adding one `.tool.ts` file; nothing in this file names a
// tool. The only names spelled out in the package are the public NAMED EXPORTS in
// `./index` (an API surface, not an inventory).
//
// NAMING (T14): every wire name is `<namespace><action>` — fileRead, fileWrite,
// fileEdit, fileList, fileGlob, commandRun, gitDiff, syntaxCheck. There are no
// compatibility aliases, because a catalogue with two names for one tool makes
// discovery ambiguous.
//
// Cross-references:
//   - ./descriptors  — the single seam onto the discovered catalogue + loader
//   - ./lazy         — the callable proxy built from one row's metadata
//   - ./index        — the named exports + `presetTools` table
//   - ../core/tool   — normalizes tags and defines the Tool contract

import type { Tool } from '../types';
import {
    PRESET_DESCRIPTORS,
    descriptorMetadata,
    loadPresetTool as loadDiscoveredPresetTool
} from './descriptors';
import type { DescriptorMetadata } from './descriptors';

// The metadata every preset must publish eagerly. Deliberately a subset of
// ToolConfiguration: `execute` is the only field that requires the implementation.
// Kept as the historical name because the shipped `*.tool.ts` entries annotate
// their local metadata constant with it (a type-only import, erased at compile).
export type PresetToolMetadata = DescriptorMetadata;

// The catalogue, keyed by wire name in descriptor (scan) order. Each row is a
// DETACHED copy of the entry's own metadata (see descriptors.descriptorMetadata) —
// no projection to keep in sync, no implementation import, and a consumer that
// mutates a row cannot corrupt the process catalogue.
export const PRESET_TOOLS: Record<string, PresetToolMetadata> = Object.fromEntries(
    PRESET_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptorMetadata(descriptor.name)])
);

// Every preset's name, in catalogue order. Used by tests and by tooling that only
// needs the list; `presetTools` in ./index is built in this same order.
export const PRESET_TOOL_NAMES: string[] = PRESET_DESCRIPTORS.map((descriptor) => descriptor.name);

// Wire name of a preset row. Kept as a string alias (not a literal union) because
// the set is discovered at runtime: a literal union would have to be
// hand-maintained, which is exactly what T21 removed.
export type PresetToolName = string;

// Load one implementation through the descriptor seam. This module no longer names
// a single implementation file: a manifest-known entry resolves through generated
// `import()` code (so evaluating this module still evaluates none of them), and a
// freshly discovered entry is compiled from its editable source on first use (T24).
//
// Vite/Rollup turn each generated `import()` into its own chunk; the built package
// must ship those chunks alongside `dist/underload-harness.mjs` (they live in
// `dist/`, which package.json already includes). Turning on `inlineDynamicImports`
// would undo the split and hoist the Node built-in imports back to the entry, so
// don't.
export const loadPresetTool = (name: PresetToolName): Promise<Tool> =>
    loadDiscoveredPresetTool(name);
