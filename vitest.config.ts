import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The package entry: src/ holds harness.ts at its root and everything else is
// barrelled from a role folder, so this one file is the whole public surface.
const packageEntry = fileURLToPath(new URL('./src/harness.ts', import.meta.url));

// Node environment: the harness builds and executes underload programs, and the
// preset tools touch the filesystem and spawn processes, so tests exercise real
// Node APIs rather than a DOM.
export default defineConfig({
    resolve: {
        alias: [
            // Tests import the package by name, exactly as a consumer does, so a
            // test can never drift into reaching for an internal file. Aliasing
            // the name at the source entry keeps `vitest run` build-free; without
            // it the name would resolve through package.json to dist/.
            { find: /^@underload\/harness$/, replacement: packageEntry }
        ]
    },
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        exclude: ['**/node_modules/**', '**/dist/**'],
        passWithNoTests: true,
        testTimeout: 15000
    }
});
