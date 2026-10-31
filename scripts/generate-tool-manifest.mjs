// Regenerate the DATA-ONLY tool manifest (T19 / R8-R9).
//
// WHY A GENERATOR, NOT A HAND-WRITTEN TABLE
// ----------------------------------------
// The requirement is that `harness({})` discovers tools by SCANNING `tools/*` and
// that no tool module is statically imported to build the catalogue. A browser
// cannot scan or parse TypeScript, so the scan result has to ship as generated data.
// Generating it from the same reader the runtime uses (`src/core/tool-scan.ts`) is
// what makes the two impossible to drift: there is exactly one literal walker
// (TypeScript's own parser).
//
// WHAT IT WRITES
// --------------
//   src/core/tool-manifest.ts
//     BUILTIN_TOOL_DESCRIPTORS  — one descriptor per discovered entry, as data
//     loadDiscoveredTool(label) — one generated dynamic import per entry
//
// Both are DATA + generated `import()` calls. Neither is hand-edited: re-run this
// script after adding, removing, or re-pathing a `*.tool.ts` entry.
//
// The RENDERING lives in `./tool-manifest-render.mjs` (pure, no scan), so the parity
// test can re-render in-process without a subprocess.
//
// USAGE (from the package root; needs the dev dependency `vite-node`):
//
//   npx vite-node scripts/generate-tool-manifest.mjs
//   npx vite-node scripts/generate-tool-manifest.mjs --check
//
// `--check` exits non-zero when the committed manifest is stale.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderManifest } from './tool-manifest-render.mjs';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUTPUT = path.join(PACKAGE_ROOT, 'src', 'core', 'tool-manifest.ts');
const TOOLS_ROOT = path.join(PACKAGE_ROOT, 'src', 'tools');

// A stale or missing tools root must fail loudly rather than emit an empty manifest.
if (!fs.existsSync(TOOLS_ROOT)) {
    console.error(`tools root is missing: ${TOOLS_ROOT}`);
    process.exit(1);
}

const { scanToolMetadata } = await import(
    path.join(PACKAGE_ROOT, 'src', 'core', 'tool-scan.ts')
);

// Package entries only: a folder needs a host configuration this generator does not
// have, and the manifest is a package artifact.
//
// The scan module is used directly (`./tool-scan`, not `./tool-discovery`): discovery
// imports the manifest this script writes, so scanning through it would read the
// stale table it is about to replace.
const descriptors = scanToolMetadata({ includePresets: true }).filter(
    (descriptor) => descriptor.origin === 'package'
);
const rendered = renderManifest(descriptors);

if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';

    if (current !== rendered) {
        console.error(
            'src/core/tool-manifest.ts is stale. Regenerate with: npx vite-node scripts/generate-tool-manifest.mjs'
        );
        process.exit(1);
    }

    console.log(`tool-manifest.ts is current (${descriptors.length} descriptors).`);
} else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, rendered, 'utf8');
    console.log(`wrote ${path.relative(PACKAGE_ROOT, OUTPUT)} (${descriptors.length} descriptors)`);
}
