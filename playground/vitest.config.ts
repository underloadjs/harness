import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// UI-only test config for the harness playground.
//
// The package's own `vitest.config.ts` covers the library, server and CLI and
// deliberately excludes the playground (it is not part of the published
// package). The UI has real logic worth testing — Markdown sanitizing, tool-card
// state, turn-tile expansion — so it gets its own scoped config instead of
// widening the shared one:
//
//     npx vitest run --config playground/vitest.config.ts
//
// jsdom is a workspace devDependency; the UI is DOM code, so it needs a DOM.
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**']
    }
});
