// Focused tests for the published-shape helper.
//
// Run with:
//     node --test scripts/package-files.test.mjs
//
// They use a synthetic package fixture so the assertions are exact and do not
// drift when the real source tree grows (the kernel is actively adding tool
// sources). The real manifest is exercised by check-package-types.mjs and
// check-package-runtime.mjs against the repository package itself.
//
// Scratch lives under the repository-root Temp/ (root AGENTS.md). The fixture is
// removed after each test.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyPublishedPackage, isPublished, publishedFiles } from './package-files.mjs';
import { findWorkspaceRoot, resolveScratchRoot } from './scratch.mjs';

const scratchRoot = resolveScratchRoot({ kind: 'package-files-test' });
mkdirSync(scratchRoot, { recursive: true });

const createFixture = (t) => {
    const root = mkdtempSync(path.join(scratchRoot, 'run-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const write = (relative) => {
        const destination = path.join(root, relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, relative, 'utf8');
    };

    for (const file of [
        'dist/index.mjs',
        'src/index.ts',
        'src/tools/a.ts',
        'src/tools/a.test.ts',
        'src/tools/deep/b.ts',
        'src/tools/deep/b.spec.tsx',
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
            'dist',
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

test('publishedFiles applies positive roots and every negation pattern', (t) => {
    const { root, manifest } = createFixture(t);

    assert.deepEqual(publishedFiles({ root, manifest }), [
        'dist/index.mjs',
        'src/index.ts',
        'src/tools/a.ts',
        'src/tools/deep/b.ts'
    ]);
});

test('isPublished answers export-target allow-list questions', (t) => {
    const { root, manifest } = createFixture(t);

    assert.equal(isPublished('./dist/index.mjs', { root, manifest }), true);
    assert.equal(isPublished('src/tools/a.ts', { root, manifest }), true);
    assert.equal(isPublished('src/tools/a.test.ts', { root, manifest }), false);
    assert.equal(isPublished('src/tools/deep/b.spec.tsx', { root, manifest }), false);
    assert.equal(isPublished('src/frontend/dist/index.html', { root, manifest }), false);
    assert.equal(isPublished('README.md', { root, manifest }), false);
});

test('copyPublishedPackage materialises exactly the published files', (t) => {
    const { root, manifest } = createFixture(t);
    const targetRoot = path.join(root, 'published');

    const copied = copyPublishedPackage({ sourceRoot: root, targetRoot, manifest });

    assert.deepEqual(copied, ['dist/index.mjs', 'src/index.ts', 'src/tools/a.ts', 'src/tools/deep/b.ts']);
    assert.deepEqual(readdirSync(targetRoot).sort(), ['dist', 'src']);

    const sourceFiles = [];
    const walk = (directory, relative) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const child = path.join(directory, entry.name);
            const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`;
            if (entry.isDirectory()) walk(child, childRelative);
            else sourceFiles.push(childRelative);
        }
    };
    walk(path.join(targetRoot, 'src'), 'src');
    walk(path.join(targetRoot, 'dist'), 'dist');

    assert.deepEqual(sourceFiles.sort(), ['dist/index.mjs', 'src/index.ts', 'src/tools/a.ts', 'src/tools/deep/b.ts']);
    assert.equal(existsSync(path.join(targetRoot, 'src/frontend/dist/index.html')), false);
});

test('scratch defaults to the workspace Temp directory', () => {
    const expected = path.join(findWorkspaceRoot(), 'Temp', 'underload-harness', 'probe');
    assert.equal(resolveScratchRoot({ kind: 'probe' }), expected);
    assert.equal(resolveScratchRoot({ kind: 'probe', argv: ['node', 'x', '--scratch', 'relative/dir'] }), path.resolve('relative/dir'));
});
