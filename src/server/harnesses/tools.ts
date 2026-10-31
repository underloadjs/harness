// Harness-level app tools — the server's own tool catalogue, derived from FILES.
//
// WHY THIS MODULE EXISTS (T25)
// ----------------------------
// The six app tools used to be statically imported from ./tool-sources and composed
// by hand — the last place in `src/` where a tool definition was pulled in as a real
// import. The architecture rule is "every tool definition lives in a tools folder
// and is read metadata-first; only tests import tool modules", so the definitions now
// live in a DEDICATED, OPT-IN tools directory and everything below is DERIVED:
//
//     src/server/tools/shared/*.tool.ts    the five shared app tools
//     src/server/tools/examples/*.tool.ts  example-only tools (testFlaky)
//
// That directory is deliberately OUTSIDE the package's default tools root
// (`src/tools`), so the LIBRARY harness never discovers it: `harness()` scans
// `src/tools` only, and only the server opts in (./toolbox.ts compiles the shared
// entries from this module's discovered source map). A library consumer therefore
// still cannot gain the server example tools by accident.
//
// Everything below comes from `discoverToolMetadata({ folders })`, which reads each
// entry's `metadata` + `registration` literals through the TypeScript AST and never
// imports or evaluates a tool module. Consequences:
//   - a brand-new `*.tool.ts` dropped into either folder is catalogued, compiled and
//     callable with NO edit to this file (cold startup included);
//   - names, descriptions, tags, schemas, source paths and ordering all come from
//     the files themselves (`registration.order`);
//   - the catalogue entries are LAZY proxies: metadata is eager (it is data), the
//     implementation module is compiled by the shared kernel on first execution.
//
// WHY TWO FOLDERS
// ---------------
// The shared toolbox is "the same tools for every live harness", so the example
// tool must not be in it. The registration schema has no "not part of the shared
// set" flag (see core/tool-metadata.ts ToolRegistration), and adding one would mean
// editing the T24 discovery/scanner contract. A separate subfolder expresses the
// same policy structurally: the shared folder is the shared set, and only the
// recoverable-failure example opts into the examples folder. No name-based filter
// anywhere.
//
// ORDER
// -----
// `registration.order` in each file preserves the historical order
// (timeNow, textCount, diceRoll, noteSearch, textSummarize, testFlaky). Discovery
// sorts a folder's entries by that value, which is why the source map below is in
// registration order even though the files sort alphabetically by name.
//
// WHY THE MAP, NOT `toolFolders`
// ------------------------------
// `harness()` registers configured folders in PATH order (see
// core/tool-source.ts#discoverToolFolderSources), which would reorder the app tools
// alphabetically and break the declared toolbox order. The folder is still the
// authority — this module scans it — but startup registers the discovered entries
// through `toolSources`, which the kernel commits in the order given here. Changing
// the harness's folder ordering is a T24/core concern and is not touched.
//
// Cross-references:
//   - ./toolbox.ts        — SHARED_TOOL_SOURCES / SHARED_TOOL_FOLDERS / names
//   - ./index.ts          — createToolCatalogue() groups these as 'Harness tools'
//   - ../../core/tool-discovery.ts — discoverToolMetadata (metadata-first scan)
//   - ../../core/tool-source.ts    — prepareToolCandidate (compile on first use)
//   - ../package-root.ts  — PACKAGE_ROOT (folder paths are absolute)

import path from 'node:path';
import { normalizeTags, prepareToolCandidate, TOOL_SOURCE_ROOTS, discoverToolMetadata } from '../../core';
import type { DiscoveredTool } from '../../core';
// `Tool` is the public contract and lives in the type module, not in `core` (which
// re-exports only its own shapes).
import type { Tool } from '../../types';
import { packagePath } from '../package-root';

// The dedicated server tools directory, package-relative. Its two subfolders are the
// whole contract: `shared` is the shared toolbox, `examples` is opt-in per harness.
export const SERVER_TOOLS_DIRECTORY = 'server/tools';

// Absolute folder paths. The compiler and `discoverToolMetadata` both want a real
// directory; the package root is resolved the same way the rest of the server
// resolves its files (../package-root.ts), so `src/` and a deployed copy agree.
export const SHARED_APP_TOOL_FOLDER = packagePath('src', SERVER_TOOLS_DIRECTORY, 'shared');
export const EXAMPLE_APP_TOOL_FOLDER = packagePath('src', SERVER_TOOLS_DIRECTORY, 'examples');

// Both folders, shared first. This is the CATALOGUE order source: the server lists
// every app tool it ships, including the example-only one (it is directly callable
// through POST /tools/:name, exactly like before the move).
export const APP_TOOL_FOLDERS: readonly string[] = Object.freeze([
    SHARED_APP_TOOL_FOLDER,
    EXAMPLE_APP_TOOL_FOLDER
]);

// A package-relative POSIX label for an absolute folder entry, mirroring the
// compiler's own `labelOf` rule: the first source root that contains the file wins,
// otherwise the absolute path is kept. Using the exported source roots (rather than
// string surgery on PACKAGE_ROOT) keeps this identical to the label the harness
// records in `toolSource(name).sourcePath`.
const packageRelativeSourcePath = (absolute: string): string => {
    for (const root of TOOL_SOURCE_ROOTS) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');

        if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return relative;
        }
    }

    return absolute;
};

// One scan of the server tools folders. `origin === 'folder'` filters out the
// package rows the same call also returns (discovery always scans the package's
// default tools root); those are the library presets and belong to `presetTools`.
export const scanAppToolDescriptors = (folders: readonly string[] = APP_TOOL_FOLDERS): DiscoveredTool[] =>
    discoverToolMetadata({ folders: [...folders] }).filter(
        (descriptor) => descriptor.origin === 'folder'
    );

// The scan result, in registration order (folder order, then `registration.order`).
//
// COLD STARTUP (T25): this runs when the module is first evaluated, i.e. at process
// start, so a `*.tool.ts` added to either folder is catalogued, compiled and
// registered by the next startup with NO edit to this file or to any map. The result
// is kept for the life of the process: every export below is derived from this ONE
// scan, so the catalogue, the names, and the harness source map cannot disagree.
// (A mid-process folder change is therefore picked up by the next process, not by
// the next harness — the same rule the package's own descriptor manifest follows.)
const appToolDescriptors: readonly DiscoveredTool[] = scanAppToolDescriptors();

// True when a descriptor's source file lives directly in `folder`. Compared on the
// POSIX form because folder discovery reports absolute POSIX paths, and with a
// trailing separator stripped so a caller may pass either spelling.
const isInFolder = (descriptor: DiscoveredTool, folder: string): boolean => {
    const root = folder.split(path.sep).join('/').replace(/\/+$/, '');

    return descriptor.sourcePath.startsWith(`${root}/`);
};

// The harness-registration source map for one folder, in registration order:
// wire name → package-relative path. `createToolboxHarness` consumes the shipped
// folders through this, so the compiled set, the declared toolbox order and the
// editable file an agent inspects are all projections of the same scan.
//
// Pure over an explicit descriptor list so the derivation can be exercised against
// any folder (a test fixture, a deployed copy) without touching the shipped set.
export const appToolSourcesFrom = (
    descriptors: readonly DiscoveredTool[],
    folder: string
): Readonly<Record<string, string>> =>
    Object.freeze(
        Object.fromEntries(
            descriptors
                .filter((descriptor) => isInFolder(descriptor, folder))
                .map((descriptor) => [descriptor.name, packageRelativeSourcePath(descriptor.sourcePath)])
        )
    );

// Build the callable proxy for one discovered entry.
//
// Metadata is applied eagerly because it is DATA (the AST already read it): a
// catalogue row, a toolRequest tag match, or a descriptor needs no module load. The
// implementation is compiled through the SAME kernel operation startup/runtime
// replacements use (`prepareToolCandidate`), so `harness.toolSource(name)` reports a
// real content-addressed revision once the harness registers the same file.
//
// Shape compatibility with ../tools/lazy.ts is deliberate: callable, `execute`, and
// a writable enumerable `name`, so the harness can rename the tool to its registry
// key and a direct call works without a harness.
const lazyAppTool = (descriptor: DiscoveredTool): Tool => {
    const metadata = descriptor.metadata;

    // One compile per name. Cleared on failure so a retry can succeed instead of
    // replaying the same rejection forever.
    let loading: Promise<Tool> | undefined;

    const resolve = (): Promise<Tool> => {
        if (loading !== undefined) return loading;

        loading = Promise.resolve()
            .then(
                () =>
                    prepareToolCandidate({
                        name: descriptor.name,
                        sourcePath: descriptor.sourcePath
                    }).tool
            )
            .catch((error: unknown) => {
                loading = undefined;
                throw error;
            });

        return loading;
    };

    const callable = ((parameters: unknown) =>
        resolve().then((tool) => tool(parameters))) as Tool;

    Object.defineProperty(callable, 'name', {
        value: metadata.name,
        writable: true,
        enumerable: true,
        configurable: true
    });

    callable.description = metadata.description;
    callable.tags = normalizeTags(metadata.tags);
    callable.visibility = metadata.visibility ?? 'searchable';
    callable.parameters = metadata.parameters;

    // The harness executes through this property, not through the callable, so it
    // has to defer as well.
    callable.execute = (context) => resolve().then((tool) => tool.execute(context));

    return callable;
};

// The scan result, in registration order (folder order, then `registration.order`).
// Every app tool, keyed by wire name, in catalogue order. `testFlaky` is included
// here (the server lists and can call it directly); it is EXCLUDED from the shared
// toolbox by living in the examples folder, not by a name filter — see SHARED_APP_TOOLS.
// Frozen: the catalogue is a projection of the scan, and a caller must not be able to
// add a row the folders do not contain.
export const harnessTools: Readonly<Record<string, Tool>> = Object.freeze(
    Object.fromEntries(appToolDescriptors.map((descriptor) => [descriptor.name, lazyAppTool(descriptor)]))
);

// The SHARED subset: only entries discovered in the shared folder. Derived from the
// folder each descriptor came from, so a new shared entry joins the toolbox and a new
// example does not.
const sharedDescriptors: readonly DiscoveredTool[] = appToolDescriptors.filter((descriptor) =>
    isInFolder(descriptor, SHARED_APP_TOOL_FOLDER)
);

// The shared app tools, keyed by wire name, in registration order.
export const SHARED_APP_TOOLS: Readonly<Record<string, Tool>> = Object.freeze(
    Object.fromEntries(sharedDescriptors.map((descriptor) => [descriptor.name, harnessTools[descriptor.name]]))
);

// The shared app tool NAMES, in registration order. Frozen because the preset
// metadata shares this array: a caller must not be able to mutate one preset's
// advertised toolbox at runtime.
export const SHARED_APP_TOOL_NAMES: readonly string[] = Object.freeze(
    sharedDescriptors.map((descriptor) => descriptor.name)
);

// The editable source entry for every shared app tool, package-relative so a
// descriptor/test can quote a stable path on any platform.
export const SHARED_APP_TOOL_SOURCES: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(
        sharedDescriptors.map((descriptor) => [
            descriptor.name,
            packageRelativeSourcePath(descriptor.sourcePath)
        ])
    )
);

// The example-only source entries, same shape. Only the recoverable-failure example
// registers these (./presets.ts + ./registry.ts), which is what keeps `testFlaky`
// out of every real harness while still compiling it from its own editable file.
export const EXAMPLE_APP_TOOL_SOURCES: Readonly<Record<string, string>> = Object.freeze(
    Object.fromEntries(
        appToolDescriptors
            .filter((descriptor) => SHARED_APP_TOOLS[descriptor.name] === undefined)
            .map((descriptor) => [descriptor.name, packageRelativeSourcePath(descriptor.sourcePath)])
    )
);
