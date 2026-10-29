// Declaration build for the published `dist/` tree.
//
// Three steps, in this order (see tsconfig.entries.json for the why):
//
//   1. `tsc -p tsconfig.build.json`             inner tree, WITHOUT the root entries
//   2. `tsc -p tsconfig.entries.json`           the two root entries, into `.entries`
//   3. copy `index.d.ts` + `browser.d.ts` in, then run the specifier fixer
//
// Why two emits: a single program makes tsc reference inferred types through the
// shortest re-export path, which for anything under `src/` is the Node root
// (`src/index.ts`). That single indirection put `dist/server/**` — and therefore
// `node:http` — into the library and browser declaration graphs. Emitting the inner
// tree without the entries makes tsc reference the declaring module instead; the
// entries are pure re-export barrels, so emitting them separately cannot reintroduce
// the dependency.
//
// The final step (./fix-declaration-specifiers.mjs) makes the emitted specifiers
// NodeNext-clean. `yarn build` runs this via `build:types`; `test:package`
// (./check-package-types.mjs) verifies the result with real consumers.
//
// Cross-references:
//   - ../tsconfig.build.json          — inner emit (excludes src/index.ts, src/browser.ts)
//   - ../tsconfig.entries.json        — root entries emit into `.entries/`
//   - ./fix-declaration-specifiers.mjs — relative specifier post-process
//   - ../package.json                 — `build`, `build:types`

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixDeclarationSpecifiers } from './fix-declaration-specifiers.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ENTRIES_STAGE = path.join(PACKAGE_ROOT, '.entries');

// The declaration files this build owns as entry points (one per published `types`).
const ENTRIES = ['index.d.ts', 'browser.d.ts'];

// Resolve the TypeScript CLI without assuming where the workspace installed it.
const resolveTsc = () => {
    const candidates = [
        path.join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        ...Array.from({ length: 4 }, (_, index) =>
            path.join(
                PACKAGE_ROOT,
                ...Array.from({ length: index + 1 }, () => '..'),
                'node_modules',
                'typescript',
                'bin',
                'tsc'
            )
        )
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }

    try {
        return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    } catch {
        console.error('declarations: typescript is not installed; run the package install first.');
        process.exit(1);
    }
};

const tsc = resolveTsc();

// Run one `tsc -p <config>` and fail the whole build on a non-zero exit.
const emit = (config) => {
    const result = spawnSync(process.execPath, [tsc, '-p', path.join(PACKAGE_ROOT, config)], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
        console.error(`declarations: tsc -p ${config} failed\n${output}`);
        process.exit(1);
    }
};

// 1. Inner tree: library + server + frontend + shared, without the root entries.
emit('tsconfig.build.json');

// 2. Root entries, staged separately so they cannot influence step 1's emit.
if (existsSync(ENTRIES_STAGE)) rmSync(ENTRIES_STAGE, { recursive: true, force: true });
emit('tsconfig.entries.json');

// 3. Publish the entry declarations, then make every relative specifier NodeNext-clean.
for (const entry of ENTRIES) {
    const staged = path.join(ENTRIES_STAGE, entry);
    if (!existsSync(staged)) {
        console.error(`declarations: ${entry} was not emitted by tsconfig.entries.json`);
        process.exit(1);
    }
    copyFileSync(staged, path.join(PACKAGE_ROOT, 'dist', entry));
}
rmSync(ENTRIES_STAGE, { recursive: true, force: true });

const fixed = fixDeclarationSpecifiers({ directory: path.join(PACKAGE_ROOT, 'dist') });

if (fixed.unresolved.length > 0) {
    for (const item of fixed.unresolved) {
        console.error(`declarations: unresolved specifier '${item.specifier}' in ${item.file}`);
    }
    process.exit(1);
}

console.log(`declarations: ${fixed.scanned} file(s) emitted, ${fixed.rewritten.length} fixed for NodeNext`);
