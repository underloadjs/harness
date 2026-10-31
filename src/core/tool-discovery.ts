// Tool discovery — the public metadata API over the AST scan.
//
// WHAT THIS MODULE IS FOR (T19 / R8-R9)
// ------------------------------------
// The harness must know every tool's name, description, tags, schema, and
// registration policy WITHOUT importing a single tool module. Importing a
// `.tool.ts` entry evaluates it: a preset pulls in `node:fs`/`node:child_process`,
// a runtime entry touches `context.harness`, and any of them may have top-level
// side effects. The requirement is therefore metadata-FIRST:
//
//     1. read the entry's source TEXT;
//     2. parse it with the TypeScript parser;
//     3. lift the exported `metadata` and `registration` object literals;
//     4. only then, if a definition is actually needed, import/compile the file.
//
// The AST half lives in `./tool-scan` (a leaf, so the manifest generator can scan
// without loading this module or the manifest it produces). This module adds the
// two things that DO depend on the rest of the harness:
//
//   - the browser fallback: no filesystem, no parser, so the GENERATED manifest
//     (`./tool-manifest`) is returned as the catalogue;
//   - the configured-folder scan, which reuses `./tool-source`'s fence and
//     deterministic ordering.
//
// TWO CANONICAL EXPORTS PER ENTRY
// -------------------------------
//   export const metadata     = { name, description, tags, parameters, visibility }
//   export const registration = { group, activation, order, ...flags }
//
// `metadata` is the Tool wire contract and may be aliased to a same-file literal
// (`export const metadata = FILE_READ_METADATA;`) so the historical `*_METADATA`
// names keep working. `registration` is harness policy and is deliberately a
// SEPARATE literal: those fields must never leak into the Tool schema a model sees.
// Both are read with the same literal walker, which rejects anything that is not a
// literal — no calls, no template interpolation, no spreads, no cross-file
// identifiers — so "discovery" can never become "evaluation" by accident.
//
// SCAN POLICY (R8)
// ----------------
//   - package entries: every `*.tool.ts` under the installed package's tools root
//     (`<package>/src/tools`, or `<package>/tool-sources/tools` in a deployed
//     copy), recursively, in byte-wise POSIX path order;
//   - configured `toolFolders` are scanned AFTER the package entries, in
//     configuration order, so a folder entry wins a name collision exactly like
//     the startup registration order it feeds.
//
// BROWSER BEHAVIOUR
// -----------------
// A browser cannot read files or parse TypeScript. When the source compiler is
// unavailable (`supportsToolCompilation === false`, the aliased browser build)
// this module returns the generated manifest instead of scanning, so a browser host
// still gets the full descriptor set as data. Asking for extra `folders` there is a
// clear capability error, never a silent empty scan.
//
// Cross-references:
//   - ./tool-scan.ts      — the AST reader (leaf, no manifest dependency)
//   - ./tool-metadata.ts  — ToolMetadata / ToolRegistration / DiscoveredTool
//   - ./tool-manifest.ts  — GENERATED descriptor table (browser + compatibility)
//   - ./tool-source.ts    — folder resolution/scan policy reused here
//   - ../tools/**/*.tool.ts — the authoritative metadata owners
//   - ../../scripts/generate-tool-manifest.mjs — regenerates the manifest

import { HarnessError } from '../util';
import { BUILTIN_TOOL_DESCRIPTORS } from './tool-manifest';
import { scanToolMetadata, supportsToolScan } from './tool-scan';
import { discoverToolFolderSources, resolveToolFolders, supportsToolCompilation } from './tool-source';
import type { DiscoveredTool, DiscoveredToolOptions, ToolMetadata } from './tool-metadata';

// The entry extension is pure data; re-exported so a consumer has one import path
// for "what counts as a tool entry".
export { TOOL_ENTRY_EXTENSION, supportsToolScan } from './tool-scan';

// Detached copies. Callers (and the compatibility facade) get a fresh object graph
// so mutating a descriptor cannot edit the generated manifest.
const cloneMetadata = (metadata: ToolMetadata): ToolMetadata => ({
    name: metadata.name,
    description: metadata.description,
    tags: [...metadata.tags],
    parameters: JSON.parse(JSON.stringify(metadata.parameters)) as Record<string, unknown>,
    ...(metadata.visibility === undefined ? {} : { visibility: metadata.visibility })
});

const cloneDescriptor = (descriptor: DiscoveredTool): DiscoveredTool => ({
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

// Discover every tool descriptor this installation can see.
//
// `includePresets` defaults to true because a default harness preloads the preset
// catalogue. `folders` appends host-configured directories AFTER the package
// entries so a folder wins a name collision, exactly like startup registration.
export const discoverToolMetadata = (options: DiscoveredToolOptions = {}): DiscoveredTool[] => {
    const includePresets = options.includePresets ?? true;
    const folders = options.folders ?? [];

    // Browser (or any build without the source compiler): the generated manifest
    // IS the catalogue. A host that asks for extra folders gets an honest
    // capability error instead of an empty scan.
    if (!supportsToolCompilation || !supportsToolScan) {
        if (folders.length > 0) {
            throw new HarnessError(
                'discoverToolMetadata cannot scan tool folders in this build: the browser root exposes prebuilt descriptors only. Construct the harness on Node to scan *.tool.ts folders.'
            );
        }

        return BUILTIN_TOOL_DESCRIPTORS.filter(
            (descriptor) => includePresets || descriptor.group !== 'preset'
        ).map(cloneDescriptor);
    }

    const folderScan =
        folders.length === 0
            ? undefined
            : {
                  roots: resolveToolFolders(folders),
                  sources: discoverToolFolderSources(folders)
              };

    return scanToolMetadata({ includePresets }, folderScan).map(cloneDescriptor);
};

export type {
    BuiltinToolDescriptor,
    DiscoveredTool,
    DiscoveredToolOptions,
    ToolActivation,
    ToolGroup,
    ToolMetadata,
    ToolOrigin,
    ToolRegistration
} from './tool-metadata';
