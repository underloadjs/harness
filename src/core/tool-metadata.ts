// Leaf type module for a tool's declarative half, plus the discovery descriptor.
//
// WHY THIS IS A LEAF MODULE (T13 / R7-R9)
// --------------------------------------
// The metadata for every tool lives in that tool's own `*.tool.ts` entry:
//
//   tools/runtime/<name>.tool.ts   harness-owned core tools (moved here by R7)
//   tools/<capability>/<name>.tool.ts   package presets
//
// Those entries are compiled as editable source at harness startup, so they must
// not import the compatibility aggregator `./metadata.ts`: that aggregator
// projects the generated manifest, and a value import back into it would create a
// module cycle. Entries annotate their local metadata with this type through a
// TYPE-ONLY import of `../../core` (erased at transpile, resolved to the live core
// namespace), which keeps their captured revisions at `dependencies: []` — the
// shipped packaging contract in scripts/check-package-tools.mjs.
//
// This module therefore declares every shape exactly once and imports nothing but
// the `ToolVisibility` union (also type-only). It is safe for both the Node and
// the browser graph.
//
// Cross-references:
//   - ./tool-discovery.ts        — reads these literals off disk via the TS AST
//   - ./tool-manifest.ts         — GENERATED data-only descriptor table
//   - ./metadata.ts              — compatibility facade projecting the manifest
//   - ../tools/**/*.tool.ts      — the authoritative metadata owners
//   - ../types                   — ToolVisibility

import type { ToolVisibility } from '../types';

// One tool's declarative half: everything a request declaration, a discovery
// descriptor, or a server catalogue needs, and nothing that could execute.
//
// `visibility` is optional because a preset's row omits it to mean the tool()
// default ('searchable'); a core entry always states it explicitly.
export type ToolMetadata = {
    name: string;
    description: string;
    tags: readonly string[];
    parameters: Record<string, unknown>;
    visibility?: ToolVisibility;
};

// A core tool's metadata, where `visibility` is stated rather than defaulted.
// Typed rather than literal so a catalogue entry can copy it without a widening
// cast. Historical name: the server catalogue and core/index.ts both import it.
export type CoreToolMetadata = ToolMetadata & { visibility: ToolVisibility };

// Which folder family an entry came from. `external` is a host-configured
// `toolFolders` entry; the two package families are the harness-owned runtime
// tools and the shipped presets.
export type ToolGroup = 'runtime' | 'preset' | 'external';

// Where an entry was found. `package` means inside the installed package source
// tree; `folder` means a host-configured `toolFolders` directory.
export type ToolOrigin = 'package' | 'folder';

// WHEN the harness registers the entry. This is the historical conditional-policy
// vocabulary, preserved verbatim through the descriptor so an integrating caller
// can reproduce the exact registration condition without re-deriving it:
//
//   always       — registered on every harness construction
//   creation     — registered unless `toolCreation: false`
//   subagents    — registered only when the harness has an allowlist
//   interaction  — registered only when an owner answerer is configured
//   forks        — registered only when `forks.enabled`
//   threads      — registered once the session owns an independent thread
//   websearch    — registered only when a search provider key resolved
//   webfetch     — registered only when `webfetch` is configured
export type ToolActivation =
    | 'always'
    | 'creation'
    | 'subagents'
    | 'interaction'
    | 'forks'
    | 'threads'
    | 'websearch'
    | 'webfetch';

// The runtime-only controls the harness dispatches to a special handler instead
// of an ordinary tool invocation. A replacement definition drops the marker.
export type ToolControl = 'cancel' | 'fork' | 'action';

// The discovery-policy literal every package entry exports as `registration`.
//
// It is a SEPARATE export from `metadata` on purpose: these fields are harness
// policy, not part of the Tool wire contract, and `metadata` is what a
// registration candidate may override. Keeping them apart means the Tool schema
// stays free of harness bookkeeping.
export type ToolRegistration = {
    group: ToolGroup;
    activation: ToolActivation;
    // Historical registration order. Lower first; ties break on the label. The
    // numeric gaps are deliberate so a new entry can be slotted in without
    // renumbering every file.
    order: number;
    // Declared only while the calling agent has work in flight (toolCancel).
    pendingOnly?: boolean;
    // Dispatched by the owning run rather than executed as an ordinary tool.
    control?: ToolControl;
    // Not declared to subagents; a guessed call is rejected (agentDelegate).
    primaryOnly?: boolean;
    // Answer extraction belongs to the baseline delegation definition (T2/R1).
    answerExtraction?: boolean;
    // Needs a live session harness; the server gates manual calls on a sessionId.
    sessionBound?: boolean;
    // Appears in the server's direct-call tool catalogue.
    listed?: boolean;
    // Member of the always-declared core projection (coreToolMetadata()). This is
    // a DECLARATION classification, not a registration condition: toolCreate is
    // declared always but only registered under a creation policy, and toolRegistry
    // is registered always but kept out of the projection because it IS the
    // registration surface.
    alwaysDeclared?: boolean;
};

// One fully resolved discovery result. Every field the runtime needs to register
// the tool is present here; nothing has to be re-derived from the file name.
export type DiscoveredTool = {
    // Wire name, from the entry's `metadata.name`.
    name: string;
    metadata: ToolMetadata;
    // Package-relative POSIX label for a package entry (e.g.
    // `tools/runtime/toolRequest.tool.ts`); absolute POSIX path for a folder entry.
    sourcePath: string;
    // Stable identity used by the generated lazy loader and by diagnostics.
    label: string;
    origin: ToolOrigin;
    group: ToolGroup;
    activation: ToolActivation;
    order: number;
    pendingOnly?: boolean;
    control?: ToolControl;
    primaryOnly?: boolean;
    answerExtraction?: boolean;
    sessionBound?: boolean;
    listed?: boolean;
    alwaysDeclared?: boolean;
};

// A descriptor that ships inside the package. `origin` is fixed so the generated
// manifest cannot claim a folder origin. `group` stays the full union on purpose:
// a projection can ask "is this row external?" without a narrowing cast, even though
// the generator never emits one.
export type BuiltinToolDescriptor = DiscoveredTool & { origin: 'package' };

// Options for discoverToolMetadata(). `includePresets` defaults to true because a
// default harness preloads the preset catalogue; `folders` appends host-configured
// directories AFTER the package entries so a folder wins a name collision, exactly
// like the startup registration order.
export type DiscoveredToolOptions = {
    includePresets?: boolean;
    folders?: readonly string[];
};
