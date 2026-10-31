// Renderer for the generated tool manifest (T19 / R8-R9).
//
// WHY THIS IS A SEPARATE, PURE MODULE
// ----------------------------------
// `scripts/generate-tool-manifest.mjs` scans the tools tree and writes
// `src/core/tool-manifest.ts`. The parity test (`src/core/tool-discovery.test.ts`)
// must prove the COMMITTED BYTES are current, and the cheapest honest way to do
// that is to render the expected text in-process and compare it with the file. That
// requires the renderer to be importable without running the scan (which needs the
// TypeScript compiler through vite-node).
//
// So: this file is a pure string function over descriptors. No filesystem, no
// compiler, no dynamic import. The generator and the test both call `renderManifest`
// with the SAME descriptor list, which is what makes the check meaningful.
//
// Cross-references:
//   - ../scripts/generate-tool-manifest.mjs — writes the rendered text
//   - ../src/core/tool-manifest.ts          — the generated artifact
//   - ../src/core/tool-discovery.test.ts    — the parity assertion

// The generated module must not import the discovery reader (that would drag the
// TypeScript compiler into the browser graph); it imports only the SHAPE type.
export const MANIFEST_HEADER = `// GENERATED FILE — DO NOT EDIT (T19 / R8-R9).
//
// Regenerate with:
//
//   npx vite-node scripts/generate-tool-manifest.mjs
//
// WHY THIS FILE EXISTS
// --------------------
// \`harness({})\` discovers tools by scanning \`src/tools/**/*.tool.ts\` and reading each
// entry's exported \`metadata\` + \`registration\` literals through the TypeScript AST
// (src/core/tool-scan.ts). A browser cannot read files or parse TypeScript, and the
// compatibility facade must not import a \`.tool\` module either — so the scan result
// ships here as pure DATA, produced by that same reader.
//
// There is no hand-maintained tool inventory anywhere: this table is generated from
// the entries themselves, and \`src/core/tool-discovery.test.ts\` fails when the
// committed bytes are stale (it re-renders from a fresh scan and compares).
//
// \`loadDiscoveredTool(label)\` is the OTHER generated half: one \`import()\` per entry,
// keyed by the descriptor's package-relative label. Dynamic imports are what keep
// \`node:fs\`/\`node:child_process\` out of the graph until a tool body is actually
// needed, and generating them is what removes the hand-written import switch.
//
// Cross-references:
//   - ../tools/**/*.tool.ts              — the authoritative metadata owners
//   - ./tool-scan.ts                     — the AST reader that produced this file
//   - ./metadata.ts                      — compatibility facade projecting this table
//   - ../../scripts/generate-tool-manifest.mjs — the generator
//   - ../../scripts/tool-manifest-render.mjs   — this renderer
//   - ../../tools/descriptors.ts         — the preset/runtime projections

import type { BuiltinToolDescriptor } from './tool-metadata';

`;

// Deterministic JSON with 4-space indentation, matching the package's formatting.
// Bare identifier keys are unquoted so the output reads like authored TypeScript.
const renderValue = (value) =>
    JSON.stringify(value, null, 4).replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, '$1:');

const renderDescriptor = (descriptor) => `{
${Object.entries(descriptor)
    .map(([key, value]) => `    ${key}: ${renderValue(value).replace(/\n/g, '\n    ')}`)
    .join(',\n')}
}`;

// `../tools/runtime/toolRequest.tool` from `tools/runtime/toolRequest.tool.ts`. The
// label is package-relative on purpose; the loader is generated in src/core/, so the
// specifier only has to be right relative to THAT file.
export const specifierOf = (label) => `../tools/${label.replace(/^tools\//, '')}`;

// Render the whole generated module. `descriptors` must already be filtered to
// package rows and sorted in registration order (the caller's scan does that).
export const renderManifest = (descriptors) => {
    const rows = descriptors.map(renderDescriptor).join(',\n');

    const loaderRows = descriptors
        .map(
            (descriptor) =>
                `        case ${JSON.stringify(descriptor.label)}:\n            return import(${JSON.stringify(
                    specifierOf(descriptor.label)
                )});`
        )
        .join('\n');

    return `${MANIFEST_HEADER}// One descriptor per discovered package entry, in registration order
// (\`order\` ascending, then label). \`origin\` is always 'package': the generated
// manifest cannot describe a host-configured folder, which only a Node scan can see.
export const BUILTIN_TOOL_DESCRIPTORS: readonly BuiltinToolDescriptor[] = [
${rows}
];

// Load one implementation by descriptor label. Every branch is a dynamic import, so
// evaluating this module evaluates NO tool body and imports no Node built-in.
//
// An unknown label is a programming error, not a model input: the caller always
// starts from a descriptor this table produced.
export const loadDiscoveredTool = (label: string): Promise<unknown> => {
    switch (label) {
${loaderRows}
        default:
            return Promise.reject(
                new Error(\`No generated tool loader for "\${label}". Regenerate with: npx vite-node scripts/generate-tool-manifest.mjs\`)
            );
    }
};
`;
};
