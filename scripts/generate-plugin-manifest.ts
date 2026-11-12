// Regenerate the auto-discovered built-in PLUGIN manifest (R2/R3/R4).
//
// WHY A GENERATOR
// ---------------
// Plugins, like tools, are discovered by SCANNING a folder instead of a
// hand-maintained list. A browser cannot read files, so the scan result ships as
// generated wiring in `src/plugin/manifest.ts`.
//
// This file is deliberately THIN: the discovery rules and the rendering live in
// `./plugin-manifest-scan.ts` and `./plugin-manifest-render.ts`, both pure, so the
// runtime test (`src/plugin/manifest.test.ts`) can re-run the exact same scanner and
// compare bytes without spawning a subprocess. Duplicating the rules here is how a
// generator and its parity test start to disagree.
//
// USAGE (from the package root):
//
//   yarn vite-node scripts/generate-plugin-manifest.ts
//   yarn vite-node scripts/generate-plugin-manifest.ts --check
//
// `--check` exits non-zero when the committed manifest is stale. It is wired into
// `npm test` and `npm run typecheck`, exactly like `tools:manifest:check`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPluginEntries, PluginScanError } from './plugin-manifest-scan.ts';
import { renderManifest } from './plugin-manifest-render.ts';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUTPUT = path.join(PACKAGE_ROOT, 'src', 'plugin', 'manifest.ts');
const PLUGIN_ROOT = path.join(PACKAGE_ROOT, 'src', 'plugins');

let entries;

try {
    // The generated file sits at src/plugin/manifest.ts, hence the default `../plugins`
    // specifier prefix the scanner applies.
    entries = discoverPluginEntries({ pluginsRoot: PLUGIN_ROOT });
} catch (error) {
    // A scan problem is a message, not a stack: the author needs to know which file
    // broke which rule. Anything else IS a stack, because it is a generator bug.
    console.error(error instanceof PluginScanError ? error.message : error);
    process.exit(1);
}

const rendered = renderManifest(entries);

if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';

    if (current !== rendered) {
        console.error(
            'src/plugin/manifest.ts is stale. Regenerate with: yarn vite-node scripts/generate-plugin-manifest.ts'
        );
        process.exit(1);
    }

    console.log(`plugin-manifest.ts is current (${entries.length} plugins).`);
} else {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, rendered, 'utf8');
    console.log(`wrote ${path.relative(PACKAGE_ROOT, OUTPUT)} (${entries.length} plugins)`);
}
