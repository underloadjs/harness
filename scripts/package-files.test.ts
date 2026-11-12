// Focused tests for the published-shape helper.
//
// Run with:
//     yarn vitest run scripts/package-files.test.ts
//
// They use a synthetic package fixture so the assertions are exact and do not
// drift when the real source tree grows (the kernel is actively adding tool
// sources). The real manifest is exercised by check-package-types.ts and
// check-package-runtime.ts against the repository package itself.
//
// Ported from `node:test` to vitest (root AGENTS.md: tests use vitest, never
// `node --test`). Every case and every exact assertion survived the port 1:1:
// `assert.deepEqual` -> `toEqual`, strict `assert.equal` -> `toBe`, and
// `t.after(cleanup)` -> a module-level `afterEach` that removes exactly the
// fixture roots the tests created.
//
// Scratch lives under the repository-root Temp/ (root AGENTS.md). The fixture is
// removed after each test.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyPublishedPackage, isPublished, publishedFiles } from './package-files.ts';
import { findWorkspaceRoot, resolveScratchRoot } from './scratch.ts';

const scratchRoot = resolveScratchRoot({ kind: 'package-files-test' });
mkdirSync(scratchRoot, { recursive: true });

// Every fixture root this file creates, drained by `afterEach`. `t.after` in the
// node:test original registered the hook per test; collecting the roots here keeps
// the same "remove the fixture after each test" lifecycle under vitest without
// depending on the task context API.
const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const createFixture = () => {
    const root = mkdtempSync(path.join(scratchRoot, 'run-'));
    fixtureRoots.push(root);

    const write = (relative: string) => {
        const destination = path.join(root, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, relative, 'utf8');
    };

    for (const file of [
        'src/index.ts',
        'src/tools/a.ts',
        'src/tools/a.test.ts',
        'src/tools/deep/b.ts',
        'src/tools/deep/b.spec.tsx',
        'src/server/workers/worker-boot.mjs',
        'src/frontend/dist/index.html',
        'src/frontend/node_modules/cache.ts',
        'src/frontend/.vite/cache.ts',
        'src/snapshots/__snapshots__/a.ts',
        'README.md'
    ]) {
        write(file);
    }

    const manifest = {
        files: [
            'src',
            '!src/**/*.test.ts',
            '!src/**/*.test.tsx',
            '!src/**/*.spec.ts',
            '!src/**/*.spec.tsx',
            '!src/**/__snapshots__/**',
            '!src/frontend/dist/**',
            '!src/**/node_modules/**',
            '!src/**/.vite/**'
        ]
    };

    return { root, manifest };
};

describe('publishedFiles / isPublished / copyPublishedPackage', () => {
    it('applies positive roots and every negation pattern', () => {
        const { root, manifest } = createFixture();

        // The published payload is the source tree alone (the real manifest has no
        // `dist` root either); the app build output under `src/frontend/dist` is
        // negated, and the one permitted `.mjs` ships with the source.
        expect(publishedFiles({ root, manifest })).toEqual([
            'src/index.ts',
            'src/server/workers/worker-boot.mjs',
            'src/tools/a.ts',
            'src/tools/deep/b.ts'
        ]);
    });

    it('answers export-target allow-list questions', () => {
        const { root, manifest } = createFixture();

        expect(isPublished('./src/index.ts', { root, manifest })).toBe(true);
        expect(isPublished('src/tools/a.ts', { root, manifest })).toBe(true);
        expect(isPublished('src/server/workers/worker-boot.mjs', { root, manifest })).toBe(true);
        expect(isPublished('src/tools/a.test.ts', { root, manifest })).toBe(false);
        expect(isPublished('src/tools/deep/b.spec.tsx', { root, manifest })).toBe(false);
        expect(isPublished('src/frontend/dist/index.html', { root, manifest })).toBe(false);
        // A build root that no longer exists is not inside `files`: this is the
        // assertion that fails the moment a `dist/` artifact re-enters the manifest.
        expect(isPublished('./dist/index.mjs', { root, manifest })).toBe(false);
        expect(isPublished('README.md', { root, manifest })).toBe(false);
    });

    it('materialises exactly the published files', () => {
        const { root, manifest } = createFixture();
        const targetRoot = path.join(root, 'published');

        const copied = copyPublishedPackage({ sourceRoot: root, targetRoot, manifest });

        expect(copied).toEqual([
            'src/index.ts',
            'src/server/workers/worker-boot.mjs',
            'src/tools/a.ts',
            'src/tools/deep/b.ts'
        ]);
        expect(readdirSync(targetRoot).sort()).toEqual(['src']);

        const sourceFiles: string[] = [];
        const walk = (directory: string, relative: string) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const child = path.join(directory, entry.name);
                const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
                if (entry.isDirectory()) walk(child, childRelative);
                else sourceFiles.push(childRelative);
            }
        };
        walk(path.join(targetRoot, 'src'), 'src');

        expect(sourceFiles.sort()).toEqual([
            'src/index.ts',
            'src/server/workers/worker-boot.mjs',
            'src/tools/a.ts',
            'src/tools/deep/b.ts'
        ]);
        // The negated `!src/frontend/dist/**` root must not be materialised at all.
        expect(existsSync(path.join(targetRoot, 'src/frontend/dist/index.html'))).toBe(false);
    });
});

describe('scratch root', () => {
    it('defaults to the workspace Temp directory', () => {
        // `findWorkspaceRoot()` only answers undefined above the filesystem root, so
        // a missing workspace is itself the failure this case is about.
        const workspaceRoot = findWorkspaceRoot();
        if (workspaceRoot === undefined) {
            throw new Error('no workspace root carries both AGENTS.md and Temp/');
        }

        const expected = path.join(workspaceRoot, 'Temp', 'underload-harness', 'probe');
        expect(resolveScratchRoot({ kind: 'probe' })).toBe(expected);
        // argv[0] is inert filler here: `resolveScratchRoot` only reads `--scratch`.
        expect(resolveScratchRoot({ kind: 'probe', argv: ['vite-node', 'x', '--scratch', 'relative/dir'] })).toBe(
            path.resolve('relative/dir')
        );
    });
});
