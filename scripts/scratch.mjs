// Scratch-root policy for the packaging checks.
//
// Root AGENTS.md requires all throwaway work to live under the repository-root
// `Temp/` directory and child processes to inherit TEMP/TMP/TMPDIR pointed there.
// The previous defaults wrote to `<package>/node_modules/.harness-package-*`,
// which violates that rule and can be deleted by any dependency install.
//
// This module resolves one scratch root per check:
//   1. explicit `--scratch <dir>` (resolved from the caller's cwd, as before);
//   2. otherwise `<workspace>/Temp/underload-harness/<kind>` when the package is
//      developed inside the noobscript workspace (an ancestor with AGENTS.md and
//      Temp/);
//   3. otherwise `<package>/Temp/<kind>` for the standalone GitHub checkout
//      (`packages/underload/harness/.gitignore` ignores `/Temp/`).
//
// `applyScratchEnvironment()` redirects this process and, therefore, every child
// spawned afterwards (notably `tsc` from check-package-types.mjs). It never
// touches machine-global environment settings.
//
// Cross-references:
//   - ../../../../AGENTS.md     — repository scratch policy
//   - ./package-files.mjs       — published-shape helper
//   - ./check-package-types.mjs, ./check-package-runtime.mjs — consumers

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The workspace root is the nearest ancestor that carries BOTH the shared agent
// rules and the Temp directory they mandate. The package root itself has a Temp
// directory but no AGENTS.md, so it is not mistaken for the workspace.
export const findWorkspaceRoot = (start = PACKAGE_ROOT) => {
    let current = path.resolve(start);

    while (true) {
        if (existsSync(path.join(current, 'AGENTS.md')) && existsSync(path.join(current, 'Temp'))) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) return undefined;
        current = parent;
    }
};

/**
 * Resolve and create the scratch root for one packaging check.
 *
 * @param {{ kind: string, argv?: string[], packageRoot?: string }} options
 * @returns {string} absolute scratch root
 */
export const resolveScratchRoot = ({ kind, argv = process.argv, packageRoot = PACKAGE_ROOT }) => {
    const scratchArgument = argv.indexOf('--scratch');
    if (scratchArgument > 0 && argv[scratchArgument + 1] !== undefined) {
        return path.resolve(argv[scratchArgument + 1]);
    }

    const workspaceRoot = findWorkspaceRoot(packageRoot);
    return workspaceRoot === undefined
        ? path.join(packageRoot, 'Temp', kind)
        : path.join(workspaceRoot, 'Temp', 'underload-harness', kind);
};

// Redirect temp variables for this process and its children. There is deliberately
// no restore: the script is the process, and any spawned `tsc` must inherit the
// repository Temp location too.
export const applyScratchEnvironment = (scratchRoot) => {
    mkdirSync(scratchRoot, { recursive: true });
    process.env.TEMP = scratchRoot;
    process.env.TMP = scratchRoot;
    process.env.TMPDIR = scratchRoot;
    return scratchRoot;
};
