import { defineConfig } from 'vitest/config';

// Resolution contract (why there is no `resolve.alias` block here):
//
// `@underload/harness` and every published subpath resolve through the package
// manifest, because ../package.json maps the `development` condition (the one
// Vite/Vitest/vite-node select in dev + test mode) onto the raw TypeScript entries
// under src/. `dist/` is the npm distribution bundle only, so a test can never
// drift into asserting a stale build — the same specifier a consumer writes,
// evaluated against the source that is actually being edited.
//
// Aliasing them here instead would shadow that map and let the manifest and the
// suite drift apart (the aliases used to point the bare name at `src/harness.ts`
// while the published root is the Node root `src/index.ts`). The mirrors of this
// map are: ../package.json `exports.development`, and ../tsconfig.json `paths` for
// editors/`tsc`. src/structure.test.ts pins all three.
//
// Node environment: the harness builds and executes underload programs, and the
// preset tools touch the filesystem and spawn processes, so tests exercise real
// Node APIs rather than a DOM. The browser client has its own jsdom config at
// src/frontend/vitest.config.ts and is excluded here.
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        // jsdom-only client tests live under src/frontend and run with
        // `yarn test:frontend` (src/frontend/vitest.config.ts).
        exclude: ['**/node_modules/**', '**/dist/**', 'src/frontend/**'],
        passWithNoTests: true,
        testTimeout: 15000
    }
});
