// Pure renderer for the generated plugin manifest (T-R2/R3).
//
// Split out of `generate-plugin-manifest.mjs` for the same reason the tool renderer
// is: a test can re-render in-process and compare bytes against the committed file
// without spawning a subprocess or touching the filesystem scan.
//
// WHAT IT WRITES
// --------------
//   src/plugin/manifest.ts
//     BUILTIN_PLUGIN_DESCRIPTORS — one metadata object per discovered plugin
//     BUILTIN_PLUGINS            — one HarnessPlugin per discovered plugin
//
// WHY STATIC IMPORTS HERE (and dynamic ones in the TOOL manifest)
// --------------------------------------------------------------
// A tool body may need `node:fs`, a child process, or a 100 KB source module, so the
// tool manifest loads entries lazily with `import()`. A plugin is different: the
// harness APPLIES every built-in during construction, so the module is needed anyway
// on every path, and a static import keeps `harness()` synchronous (a dynamic import
// would force an await inside the plugin phase, which is the one shape constraint the
// plugin host has always had).
//
// The metadata object is IMPORTED, never copied into the manifest, so there is no
// second source of truth to drift: the plugin file owns it. The generated file is
// therefore data + wiring, with no hand-maintained inventory anywhere.
//
// Cross-references:
//   - ./generate-plugin-manifest.mjs  — the scanner that produces the input list
//   - ../src/plugin/manifest.ts       — this renderer's output
//   - ../src/plugin/host.ts           — the consumer (applies BUILTIN_PLUGINS first)

// `import` is a reserved word, so a file named `import.plugin.ts` still needs a safe
// local identifier.
const RESERVED = new Set(['import', 'default', 'class', 'function', 'return', 'typeof', 'new']);

// `context-compaction` -> `contextCompaction`, with a `_` suffix for the reserved
// words above. Deterministic: the same path always renders the same identifiers, so
// the committed manifest only changes when the plugin SET changes.
export const identifierOf = (relativePath) => {
    const stem = relativePath.replace(/\.plugin\.ts$/, '');
    const parts = stem.split(/[/._-]+/).filter(Boolean);
    const camel = parts
        .map((part, index) =>
            index === 0
                ? part.replace(/[^a-z0-9]/gi, '')
                : part.charAt(0).toUpperCase() + part.slice(1).replace(/[^a-z0-9]/gi, '')
        )
        .join('');
    const safe = /^[a-z_$]/i.test(camel) ? camel : `_${camel}`;
    return RESERVED.has(safe) ? `${safe}_` : safe;
};

// One-line JSDoc-ish comment per entry, so the generated file stays readable.
const header = `// GENERATED FILE — DO NOT EDIT.
//
// Regenerate with:
//
//   node scripts/generate-plugin-manifest.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// \`harness()\` auto-loads every built-in plugin discovered by scanning
// \`src/plugins/**/*.plugin.ts\`. A browser cannot read files, so the scan result ships
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
`;

// Renders the whole manifest file for `entries` (already in final order).
export const renderManifest = (entries) => {
    const imports = entries
        .map(
            (entry) =>
                `import { metadata as ${entry.identifier}Metadata, setup as ${entry.identifier}Setup } from '${entry.importPath}';`
        )
        .join('\n');

    const descriptors = entries
        .map((entry) => `    ${entry.identifier}Metadata`)
        .join(',\n');

    const plugins = entries
        .map(
            (entry) =>
                `    {\n        name: ${entry.identifier}Metadata.name,\n        metadata: ${entry.identifier}Metadata,\n        setup: ${entry.identifier}Setup\n    }`
        )
        .join(',\n');

    const body = `
import type { HarnessPlugin, HarnessPluginMetadata } from '../types';

${imports}

// Every discovered built-in's declared metadata, in scan order (path ascending). This
// is the catalogue the server hands the UI's Plugins pane; a plugin that registers no
// hooks still appears here, because an operator must be able to SEE it.
export const BUILTIN_PLUGIN_DESCRIPTORS: readonly HarnessPluginMetadata[] = [
${descriptors.length === 0 ? '' : `${descriptors}\n`}];

// The same entries as runnable plugins. \`runPlugins\` applies these BEFORE
// \`configuration.plugins\`, so a programmatic plugin that names a built-in replaces it
// instead of colliding with it.
export const BUILTIN_PLUGINS: readonly HarnessPlugin[] = [
${plugins.length === 0 ? '' : `${plugins}\n`}];
`;

    return `${header}\n${body}`;
};
