import { defineConfig } from 'vitest/config';

// Node environment: the harness builds and executes underload programs, so
// tests exercise real Node APIs rather than a DOM.
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        exclude: ['**/node_modules/**', '**/dist/**'],
        passWithNoTests: true,
        testTimeout: 15000
    }
});
