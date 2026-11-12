import { defineConfig } from 'vitest/config';

// Resolution contract (why there is no `resolve.alias` block here):
//
// `@underload/harness` and every published subpath resolve through the package
// manifest, because ../package.json names the raw TypeScript entries under src/ for
// EVERY condition of every subpath — `types` and `default` alike, plus the
// browser-safe root under the root `browser` group. There is no `development`
// condition to depend on and no `dist/` target to drift into: the package is
// published as source, so the same specifier a consumer writes is evaluated against
// the source that is actually being edited.
//
// Aliasing them here instead would shadow that map and let the manifest and the
// suite drift apart (the aliases used to point the bare name at `src/harness.ts`
// while the published root is the Node root `src/index.ts`). The mirrors of this
// map are: ../package.json `exports.*.default`, and ../tsconfig.json `paths` for
// editors/`tsc`. src/structure.test.ts pins all three.
//
// Node environment: the harness builds and executes underload programs, and the
// preset tools touch the filesystem and spawn processes, so tests exercise real
// Node APIs rather than a DOM. The browser client has its own jsdom config at
// src/frontend/vitest.config.ts and is excluded here.
//
// `scripts/**` is in scope on purpose: the packaging helpers and the contract
// generator ship as TypeScript under scripts/, and their suites run here instead
// of the retired `node --test` runner (root AGENTS.md bans `node --test`, so a
// test under scripts/ has to be collected by this config). The glob is deliberately
// narrow — only `*.test|spec.{ts,tsx}` under scripts/, never scripts/** wholesale —
// so the generator modules themselves are not mistaken for suites. `environment`
// stays `node` for both trees: `environment: 'node'` above is config-wide, not
// per-include, so the script suites get the same real-Node world they had under
// `node --test`.
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.{test,spec}.{ts,tsx}'],
        // jsdom-only client tests live under src/frontend and run with
        // `yarn test:frontend` (src/frontend/vitest.config.ts).
        exclude: ['**/node_modules/**', '**/dist/**', 'src/frontend/**'],
        passWithNoTests: true,
        testTimeout: 15000
    }
});
