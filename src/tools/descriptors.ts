// @underload/harness tools/descriptors — the single seam onto the discovered tool
// catalogue (T19 → T24).
//
// WHY THIS FILE EXISTS
// --------------------
// The preset surface used to be hand-maintained twice: `./catalogue` held a
// metadata projection of every `*.tool.ts` entry, and `./catalogue.loadPresetTool`
// held a per-name dynamic-import switch. Both duplicated an inventory the
// filesystem already knows, so a brand-new `.tool.ts` needed edits in two places
// before it could be listed, declared, or loaded.
//
// T19 replaced that with the DATA-ONLY generated manifest produced by scanning
// `tools/**/*.tool.ts`:
//
//   BUILTIN_TOOL_DESCRIPTORS — one descriptor per discovered entry:
//     { name, metadata, sourcePath, label, origin, group, activation, order,
//       pendingOnly?, control?, primaryOnly?, answerExtraction?, sessionBound?,
//       listed?, alwaysDeclared? }
//   loadDiscoveredTool(label) — generated dynamic import per entry. The imports
//     live in generated code, never in a hand-written switch, and none of them is
//     evaluated until a tool body is actually needed.
//
// T24 FIX: THE NODE CATALOGUE IS DERIVED LIVE, NOT FROM THE GENERATED FALLBACK
// ---------------------------------------------------------------------------
// The generated manifest is a BUILD ARTIFACT. Reading it unconditionally meant the
// library harness (which scans `discoverToolMetadata()` on every construction) and
// the catalogue surface (`presetTools`, `PRESET_TOOLS`, the server's shared
// catalogue via PRESET_DESCRIPTORS/RUNTIME_DESCRIPTORS) could disagree: a new
// `.tool.ts` was registered by `harness({})` but stayed invisible in the catalogue
// until someone ran `npm run tools:manifest`. T22 reproduced exactly that: Node
// served the stale generated rows while the library scanned.
//
// So this module now derives ONE process-level snapshot from the SAME reader the
// harness uses (`../core/tool-scan`, the leaf scanner — see the cycle note below):
//
//   - Node (scanner available): a LIVE scan of `tools/**/*.tool.ts`, so a cold
//     process after adding a file already lists it — no manifest generation;
//   - browser (or a Node build without the scanner): the GENERATED manifest, which
//     is the only inventory a browser can have.
//
// Scope of the snapshot: it is taken ONCE, at module (process) initialisation. That
// is deliberate — "catalogue as of cold start" — and it is NOT a cache for the
// harness: `harness({})` still calls `discoverToolMetadata()` on every
// construction, so a file added while the process runs is picked up by the next
// harness. Do not turn this into a re-scan-per-call cache; it would only move the
// same work around and would hide later file additions from the harness instead.
//
// LOADING (T24 → T27): the generated loader only knows the labels it was generated
// from. T24 therefore compiled freshly discovered entries from source and kept the
// generated `import()` for every label the manifest knew — which left ONE row
// described by two different revisions: metadata from the live scan, body from the
// built chunk. Editing a shipped preset's `.tool.ts` without rebuilding served the
// old body until `npm run tools:manifest` + `vite build` ran again.
//
// T27 corrects that: on Node the body ALWAYS comes from the descriptor's editable
// `sourcePath`, compiled with `prepareToolCandidate` (the same kernel path startup
// registration uses), so catalogue metadata and executable code are the same source
// revision for every label — known or new. The generated `import()` is reached only
// where the catalogue IS the generated manifest (browser / scanner-less build), which
// is the one case where those rows and that body agree. No `.tool` module is ever
// imported statically here, and nothing is cached across calls: a cold process after
// a source edit always compiles the bytes on disk (see `loadPresetTool`).
//
// NO CYCLE (why `../core/tool-scan`, and why the compiler is a DYNAMIC import)
// ---------------------------------------------------------------------------
// `../core/tool-source` imports `../tools/catalogue` (it resolves preset entries'
// `tools/catalogue` specifier to the LIVE namespace). A static
// `descriptors → tool-source` edge would close the cycle
// `catalogue → descriptors → tool-source → catalogue`, and `tool-source` carries a
// top-level await, so that cycle is exactly the kind that can deadlock a bundle.
//
//   - metadata comes from `../core/tool-scan`, a LEAF (it imports only `../util`
//     and the shape types), so the scan never reaches the compiler or the manifest
//     it feeds;
//   - the compiler is reached with `await import('../core')` inside the loader, so
//     the edge exists only at CALL time, after every module has initialised. The
//     barrel is used (not `../core/tool-source`) because the browser build's alias
//     only rewrites the specifier `./tool-source` written inside `src/core/`;
//     importing the compiler module directly from `src/tools/` would drag
//     `node:fs`/TypeScript into the browser graph.
//
// Verified against a real isolated browser build (Temp/, T24): the browser entry
// still contains no static `node:fs`/`node:path`/`typescript` import, and the only
// `node:fs` mention is the scanner's pre-existing `/* @vite-ignore */` dynamic
// import string, which never executes in a browser (`supportsToolScan` is false).
//
// MUTATION ISOLATION (T24): the snapshot is private and never handed out. Every
// exported row/accessor returns a DETACHED copy (tags array + JSON schema clone),
// because catalogue consumers spread metadata into their own declarations and a
// mutation there must not corrupt the process catalogue.
//
// WHAT `listed` MEANS HERE (important)
// ------------------------------------
// The generated flag is the SERVER's "appears in the direct-call tool catalogue"
// rule, and every shipped PRESET sets it to false (a preset is reached through a
// harness or the preset table, never through `POST /tools/:name`). It is therefore
// applied to the RUNTIME group only. Presets are filtered by group alone; otherwise
// every preset would silently disappear from the package catalogue.
//
// Cross-references:
//   - ../core/tool-metadata.ts — DiscoveredTool / BuiltinToolDescriptor (the shape)
//   - ../core/tool-scan.ts     — the LEAF AST scanner this snapshot comes from
//   - ../core/tool-manifest.ts — the GENERATED fallback table + generated loader
//   - ../core/tool-source.ts   — prepareToolCandidate (runtime source compile)
//   - ./catalogue     — PRESET_TOOLS / PRESET_TOOL_NAMES derived from here
//   - ./lazy          — callable proxy built from a descriptor's metadata
//   - ./index         — `presetTools` + named exports, both descriptor-driven
//   - ../../server/harnesses/core.ts    — runtime (session-bound) projection
//   - ../../server/harnesses/toolbox.ts — shared source map + core name lists

import { BUILTIN_TOOL_DESCRIPTORS, loadDiscoveredTool } from '../core/tool-manifest';
import { scanToolMetadata, supportsToolScan } from '../core/tool-scan';
import type {
    BuiltinToolDescriptor,
    ToolActivation,
    ToolControl,
    ToolGroup,
    ToolMetadata
} from '../core/tool-metadata';
import type { Tool } from '../types';

// The declarative half of a discovered entry. Re-exported so consumers keep a
// single import path for "what a catalogue row needs" without reaching into core.
export type DescriptorMetadata = ToolMetadata;

// Where a descriptor came from. `preset` = the shipped package tools under
// src/tools/<capability>; `runtime` = the harness-owned core entries under
// src/tools/runtime; `external` = host/example entries registered by configuration
// rather than shipped as package presets.
export type DescriptorGroup = ToolGroup;

// One descriptor row, exactly as discovered. Aliased (not re-declared) so the
// manifest/discovery shapes stay the single definition of the row.
export type ToolDescriptor = BuiltinToolDescriptor;

// Activation values a preset/capability row can carry. `always` and `creation` are
// the two that make a runtime entry part of the always-declared core set; the rest
// are capability-by-configuration (subagents, interaction, forks, threads, web).
const CORE_DECLARED_ACTIVATIONS: ReadonlySet<ToolActivation> = new Set<ToolActivation>([
    'always',
    'creation'
]);

// Detached metadata copy. Tags are a fresh array and the schema is JSON-cloned, so
// a consumer that spreads or edits the row cannot reach the process snapshot. The
// `visibility` key stays ABSENT when the entry omits it (preset rows rely on the
// tool() default), which is why it is spread conditionally rather than set to
// undefined.
const cloneMetadata = (metadata: ToolMetadata): ToolMetadata => ({
    name: metadata.name,
    description: metadata.description,
    tags: [...metadata.tags],
    parameters: JSON.parse(JSON.stringify(metadata.parameters)) as Record<string, unknown>,
    ...(metadata.visibility === undefined ? {} : { visibility: metadata.visibility })
});

// Detached row copy: metadata via cloneMetadata, every policy flag copied by value
// (all of them are primitives), so the returned row shares no mutable state.
const cloneDescriptor = (descriptor: ToolDescriptor): ToolDescriptor => ({
    name: descriptor.name,
    metadata: cloneMetadata(descriptor.metadata),
    sourcePath: descriptor.sourcePath,
    label: descriptor.label,
    origin: descriptor.origin,
    group: descriptor.group,
    activation: descriptor.activation,
    order: descriptor.order,
    ...(descriptor.pendingOnly === undefined ? {} : { pendingOnly: descriptor.pendingOnly }),
    ...(descriptor.control === undefined ? {} : { control: descriptor.control }),
    ...(descriptor.primaryOnly === undefined ? {} : { primaryOnly: descriptor.primaryOnly }),
    ...(descriptor.answerExtraction === undefined
        ? {}
        : { answerExtraction: descriptor.answerExtraction }),
    ...(descriptor.sessionBound === undefined ? {} : { sessionBound: descriptor.sessionBound }),
    ...(descriptor.listed === undefined ? {} : { listed: descriptor.listed }),
    ...(descriptor.alwaysDeclared === undefined
        ? {}
        : { alwaysDeclared: descriptor.alwaysDeclared })
});

// Read the PACKAGE catalogue for this process.
//
// Node: scan the entries themselves (the same reader the manifest generator and
// `discoverToolMetadata` use), then keep package rows only — a host folder needs a
// harness configuration this module does not have, exactly like the generator.
//
// Browser (or a Node install without `node:fs`/TypeScript): the generated manifest
// IS the inventory.
//
// The narrow fallback below exists for exactly ONE case: a copy where the editable
// tools tree is not beside the package manifest (a dist-only deployment, a host
// bundle that relocated `dist/`). Importing the library must not fail just because
// a catalogue is unavailable, so those two location errors fall back to the
// generated rows. Every OTHER scan failure — an invalid entry, an unreadable
// metadata literal, a bad registration — is RETHROWN: the harness scans the same
// tree and would fail on construction, so silently publishing stale rows here
// would reintroduce exactly the catalogue/harness disagreement T24 fixed.
const TOOLS_ROOT_UNAVAILABLE = [
    'could not locate the @underload/harness package root',
    'could not find a tools root beside'
] as const;

const isToolsRootUnavailable = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return TOOLS_ROOT_UNAVAILABLE.some((fragment) => message.includes(fragment));
};

// The result of reading the inventory, plus WHERE it came from. `sourceBacked`
// answers exactly one question for `loadPresetTool`: can this process compile the
// entry bytes the rows describe? When the rows came from the live scan the answer is
// yes, and the body must be compiled from the same file. When they came from the
// generated manifest (browser, or a relocated dist with no tools tree) the answer is
// no, and the generated `import()` is the only — and then consistent — body source.
// Deriving both from ONE read is what keeps the catalogue and the loader from
// disagreeing (the T27 bug: live metadata + generated body).
type CatalogueScan = {
    descriptors: readonly BuiltinToolDescriptor[];
    sourceBacked: boolean;
};

const scanPackageDescriptors = (): CatalogueScan => {
    if (!supportsToolScan) {
        return { descriptors: BUILTIN_TOOL_DESCRIPTORS, sourceBacked: false };
    }

    try {
        return {
            descriptors: scanToolMetadata({ includePresets: true })
                .filter((descriptor) => descriptor.origin === 'package')
                .map(
                    (descriptor) =>
                        ({
                            ...descriptor,
                            // The scanner already reports 'package' for these rows; the
                            // literal keeps the generated-row type honest.
                            origin: 'package'
                        }) as BuiltinToolDescriptor
                ),
            sourceBacked: true
        };
    } catch (error) {
        if (!isToolsRootUnavailable(error)) throw error;

        // A relocated/`dist`-only copy: no editable tree to compile from, so the
        // generated rows and the generated bodies are the honest pair.
        return { descriptors: BUILTIN_TOOL_DESCRIPTORS, sourceBacked: false };
    }
};

// One sorted snapshot of this process's catalogue. Sorting here (rather than in
// each projection) keeps the scan order authoritative and every derived list stable.
// PRIVATE: nothing outside this module may hold a snapshot row (see cloneDescriptor).
const CATALOGUE_SCAN: CatalogueScan = scanPackageDescriptors();

const SNAPSHOT_DESCRIPTORS: readonly ToolDescriptor[] = [...CATALOGUE_SCAN.descriptors].sort(
    (left, right) => left.order - right.order
);

// Every row, as detached copies, in registration order.
export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = SNAPSHOT_DESCRIPTORS.map(cloneDescriptor);

// Name index over the PRIVATE snapshot: descriptor lookups happen for every preset
// proxy and every catalogue entry, so a linear scan per call would be needless work.
const DESCRIPTOR_BY_NAME: ReadonlyMap<string, ToolDescriptor> = new Map(
    SNAPSHOT_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor])
);

// True when this process's rows came from the LIVE scan of `tools/**/*.tool.ts`, so
// every row's `sourcePath` is a file that exists and can be compiled. False for the
// browser/scanner-less build, where the generated manifest is the only inventory.
const SOURCE_BACKED: boolean = CATALOGUE_SCAN.sourceBacked;

// The package presets (src/tools/<capability>/*.tool.ts), in registration order.
// This is what `presetTools`, the server's 'Package presets' group and the shared
// source map are built from. No `listed` filter: that flag is the server direct-call
// rule and every preset legitimately sets it false (see the header).
//
// Built from the PRIVATE snapshot with a fresh clone per row: the exported lists
// must not alias each other (a host editing `PRESET_DESCRIPTORS[0]` cannot reach
// `RUNTIME_DESCRIPTORS` or the snapshot itself).
export const PRESET_DESCRIPTORS: readonly ToolDescriptor[] = SNAPSHOT_DESCRIPTORS.filter(
    (descriptor) => descriptor.group === 'preset'
).map(cloneDescriptor);

// The harness-owned core entries the server LISTS for review/manual execution:
// `group === 'runtime'` and `listed !== false`. That excludes the session-only
// capability rows the server deliberately does not advertise in its global
// catalogue (webSearch/webFetch are listed separately by their own factories;
// toolCancel/threadSend/threadList only exist inside a live session), while keeping
// the conditional-but-listable set (agentDelegate, actionRequest, threadFork).
//
// ORDER: baseline rows (always/creation) keep descriptor order, because that is the
// kernel's registration order and a catalogue must not disagree with the runtime.
// Capability rows are ordered by the ACTIVATION VOCABULARY — the union declared in
// core/tool-metadata.ts: always, creation, subagents, interaction, forks, threads,
// websearch, webfetch. That reproduces the historical catalogue sequence
// (agentDelegate → actionRequest → threadFork) from DATA instead of a name list, so
// adding a capability row needs no edit here and no test rewrite: the position
// follows its declared activation.
const ACTIVATION_ORDER: readonly ToolActivation[] = [
    'always',
    'creation',
    'subagents',
    'interaction',
    'forks',
    'threads',
    'websearch',
    'webfetch'
];

const activationRank = (descriptor: ToolDescriptor): number => {
    const index = ACTIVATION_ORDER.indexOf(descriptor.activation);
    return index === -1 ? ACTIVATION_ORDER.length : index;
};

// True for a row registered unconditionally at startup. Those keep `order`; every
// other row is a capability and sorts by activation vocabulary.
const isBaseline = (descriptor: ToolDescriptor): boolean =>
    descriptor.activation === 'always' || descriptor.activation === 'creation';

export const RUNTIME_DESCRIPTORS: readonly ToolDescriptor[] = SNAPSHOT_DESCRIPTORS.filter(
    (descriptor) => descriptor.group === 'runtime' && descriptor.listed !== false
)
    .map(cloneDescriptor)
    .sort((left, right) => {
        const leftBaseline = isBaseline(left);
        const rightBaseline = isBaseline(right);

        // Baseline block first (in registration order), then capability rows.
        if (leftBaseline !== rightBaseline) return leftBaseline ? -1 : 1;
        if (leftBaseline) return left.order - right.order;

        return activationRank(left) - activationRank(right) || left.order - right.order;
    });

// Host/example entries (server/tools/examples/*.tool.ts). They are not package
// presets: a library harness must not gain server-only tools just because they live
// in this repository, so they stay an explicit host configuration. A package
// manifest cannot emit this group (BuiltinToolDescriptor excludes it), so the list
// is empty by construction and exists for symmetry/documentation.
export const EXTERNAL_DESCRIPTORS: readonly ToolDescriptor[] = SNAPSHOT_DESCRIPTORS.filter(
    (descriptor) => descriptor.group === 'external' && descriptor.listed !== false
).map(cloneDescriptor);

// Lookup by wire name, or undefined for a name this build never discovered. Returns
// a DETACHED row (see cloneDescriptor) so a caller cannot edit the snapshot.
export const descriptorOf = (name: string): ToolDescriptor | undefined => {
    const descriptor = DESCRIPTOR_BY_NAME.get(name);
    return descriptor === undefined ? undefined : cloneDescriptor(descriptor);
};

// The metadata row for one discovered name. Throws for an unknown name so a typo in
// a projection fails loudly instead of publishing an empty tool. Always a detached
// copy: this is the object a preset proxy/catalogue row is built from.
export const descriptorMetadata = (name: string): DescriptorMetadata => {
    const descriptor = DESCRIPTOR_BY_NAME.get(name);

    if (descriptor === undefined) {
        throw new Error(`No tool descriptor was generated for "${name}".`);
    }

    return cloneMetadata(descriptor.metadata);
};

// The editable source entry for one discovered name (undefined when unknown).
export const descriptorSourcePath = (name: string): string | undefined =>
    DESCRIPTOR_BY_NAME.get(name)?.sourcePath;

// True when the descriptor belongs in the always-DECLARED core projection
// (`coreToolMetadata()` in core/metadata.ts). That is a declaration classification,
// not a registration condition: toolCreate is declared always but only registered
// under a creation policy, and toolRegistry is registered always but kept OUT of the
// projection because it IS the registration surface. The row states
// `alwaysDeclared` per entry, so this module never re-derives it.
export const isAlwaysDeclared = (descriptor: ToolDescriptor): boolean =>
    descriptor.alwaysDeclared === true;

// True when a runtime row is part of the harness's unconditional core set: declared
// on every request, registered at startup under either policy. Capability rows
// (subagents/interaction/forks/threads/web) are excluded, which is what keeps a
// single-agent preset from advertising a delegation tool it would never declare.
export const isCoreRegistered = (descriptor: ToolDescriptor): boolean =>
    descriptor.group === 'runtime' &&
    descriptor.listed !== false &&
    descriptor.control === undefined &&
    CORE_DECLARED_ACTIVATIONS.has(descriptor.activation);

// The control marker a runtime entry carries when the harness dispatches it to a
// special handler instead of an ordinary invocation ('cancel' | 'fork' | 'action'),
// or undefined for an ordinary tool.
export const controlOf = (descriptor: ToolDescriptor): ToolControl | undefined =>
    descriptor.control;

// Load one implementation. No hand-written switch either way:
//
//   - a SOURCE-BACKED catalogue (Node with a scanner) resolves EVERY label — the
//     ones the generated manifest knows and freshly discovered ones alike — by
//     compiling the descriptor's editable `sourcePath` with the runtime compiler.
//     The catalogue row and the executable body therefore always describe the same
//     revision: editing a shipped `.tool.ts` is visible to the next call without
//     `npm run tools:manifest` or a rebuild (T27);
//   - a GENERATED catalogue (browser / relocated dist, no scanner) resolves through
//     the generated loader, which is the only inventory and the only body source
//     that can exist there. Rows and bodies then come from the same build artifact.
//
// Why compile the KNOWN labels too, instead of keeping their generated `import()`:
// a generated chunk is a BUILD ARTIFACT of an older revision. Pairing live metadata
// with that chunk produced exactly the incoherence T27 removes — the catalogue said
// one thing and the body did another until someone rebuilt. Correctness of the
// source-backed lifecycle outranks the per-entry lazy chunk; the work is still
// deferred to the first call, and `./lazy` still caches the successful resolve.
//
// Nothing here caches compiled bodies across calls: `prepareToolCandidate` builds a
// fresh module graph every time (core/tool-source.ts), so a cold process after an
// edit compiles the bytes currently on disk, never a retained obsolete body.
//
// The generated loader resolves the whole MODULE namespace (it must stay data-only
// and cannot know which binding is the tool), so the tool is selected here:
//
//   - `module[descriptor.name]` — the canonical `export const fileRead = tool({...})`
//     shape every shipped entry uses;
//   - `module.default` - the `export default` shape a host-authored entry may use
//     instead (server/tools/**/*.tool.ts and toolFolders entries);
//   - `module.tool` — the remaining historical shape.
//
// A module that exposes none of them is a contract failure, reported as such rather
// than surfacing as "undefined is not a function" at the call site.
export const loadPresetTool = async (name: string): Promise<Tool> => {
    const descriptor = DESCRIPTOR_BY_NAME.get(name);

    if (descriptor === undefined) {
        throw new Error(`No tool descriptor was generated for "${name}".`);
    }

    // Source-backed (Node) catalogue: compile the entry the row was scanned from.
    // This is the same kernel path startup registration uses, so the catalogue row,
    // the harness and a direct `presetTools[name]()` call all run one source
    // revision. `expectedName` pins the export selection to this row.
    if (SOURCE_BACKED) {
        // Dynamic on purpose: a static edge here would close the
        // catalogue → descriptors → tool-source → catalogue cycle (see the header),
        // and the barrel keeps the browser build's `./tool-source` alias in play.
        const { prepareToolCandidate } = await import('../core');
        const prepared = prepareToolCandidate(
            { sourcePath: descriptor.sourcePath },
            { expectedName: descriptor.name }
        );

        return prepared.tool;
    }

    // Generated catalogue (browser / scanner-less build): the generated `import()`
    // is the only body source available, and it belongs to the same artifact the
    // rows came from.
    const module = (await loadDiscoveredTool(descriptor.label)) as Record<string, unknown>;
    const candidate =
        module[descriptor.name] ?? module.default ?? (module as { tool?: unknown }).tool;

    if (typeof candidate !== 'function') {
        throw new Error(
            `Tool entry "${descriptor.label}" exports no callable tool under "${descriptor.name}", "default", or "tool".`
        );
    }

    return candidate as Tool;
};
