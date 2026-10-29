// The package root, resolved without assuming a build layout.
//
// WHY THIS EXISTS (and why not `new URL('../.env', import.meta.url)`):
// Vite's asset plugin statically rewrites `new URL('<literal neighbouring file>',
// import.meta.url)` at build time. When the neighbouring path is the package `.env`,
// that rewrite INLINES the file into the published bundle as a data URL — which
// leaked real provider keys into `dist/`. A module-relative depth is also wrong
// after bundling: the same module evaluates from `src/server/` in the source tree
// but from a shared chunk in `dist/`.
//
// So the root is discovered by walking up from this module until a directory holds
// `package.json`. That answer is identical in both layouts:
//   - source tree: harness/src/server/ -> harness/
//   - bundle:      harness/dist/<chunk>.js -> harness/
// and it never names a data file, so no build plugin can inline one.
//
// Cost: a few `existsSync` calls once per process, when a Node entry is imported
// (never from the library graph). The walk is bounded by the filesystem root and
// falls back to the starting directory if `package.json` is absent (a moved or
// partially copied tree), so it cannot loop or throw.
//
// Cross-references:
//   - ./environment.ts — package-root `.env` (never inlined; see above)
//   - ./start.ts       — default static root for the built UI
//   - ./dev.ts — standalone API launcher (never part of a bundle; the Vite
//     frontend launcher is a separate `yarn dev:frontend` process)

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const findPackageRoot = (start: string): string => {
    let directory = start;

    for (;;) {
        if (existsSync(path.join(directory, 'package.json'))) return directory;

        const parent = path.dirname(directory);
        // Root of the filesystem (or a directory that is its own parent).
        if (parent === directory) return start;

        directory = parent;
    }
};

// The directory holding this module (`src/server` in the tree, `dist` when bundled).
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// Package root: the nearest ancestor with a `package.json`.
export const PACKAGE_ROOT = findPackageRoot(MODULE_DIRECTORY);

// Join a package-relative path (e.g. '.env', 'src/frontend/dist').
export const packagePath = (...segments: string[]): string => path.join(PACKAGE_ROOT, ...segments);
