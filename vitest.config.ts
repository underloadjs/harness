import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Library/server/shared specifiers resolve to their source entries, so `vitest run`
// is build-free and a test can never drift into reaching for `dist/`.
//
// The library root (`@underload/harness`) deliberately stays aliased to
// `src/harness.ts`: that is the stable published library entry the existing tests
// import, and the application layers (`src/server`, `src/frontend`) are tested
// through their own specifiers below.
const packageEntry = fileURLToPath(new URL('./src/harness.ts', import.meta.url));
const nodeRoot = fileURLToPath(new URL('./src/index.ts', import.meta.url));
const serverEntry = fileURLToPath(new URL('./src/server/index.ts', import.meta.url));
const frontendEntry = fileURLToPath(new URL('./src/frontend/index.ts', import.meta.url));
const sharedEntry = fileURLToPath(new URL('./src/shared/index.ts', import.meta.url));

// Node environment: the harness builds and executes underload programs, and the
// preset tools touch the filesystem and spawn processes, so tests exercise real
// Node APIs rather than a DOM. The browser client has its own jsdom config at
// src/frontend/vitest.config.ts and is excluded here.
export default defineConfig({
    resolve: {
        alias: [
            { find: /^@underload\/harness$/, replacement: packageEntry },
            // The Node root and the subpaths a consumer would import.
            { find: /^@underload\/harness\/root$/, replacement: nodeRoot },
            { find: /^@underload\/harness\/server$/, replacement: serverEntry },
            { find: /^@underload\/harness\/frontend$/, replacement: frontendEntry },
            { find: /^@underload\/harness\/shared$/, replacement: sharedEntry }
        ]
    },
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
