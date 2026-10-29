import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// UI-only test config for the harness frontend.
//
// The package's own `vitest.config.ts` covers the library and the server and
// deliberately EXCLUDES src/frontend (the client is not part of the node surface).
// The UI has real logic worth testing — Markdown sanitizing, tool-card state,
// turn-tile expansion — so it gets its own scoped config instead of widening the
// shared one:
//
//     npx vitest run --config src/frontend/vitest.config.ts
//
// jsdom is a workspace devDependency; the UI is DOM code, so it needs a DOM.
export default defineConfig({
    // Root is this folder, so `include` is relative to src/frontend and the
    // CSS-contract tests resolve styles.css from here.
    root: fileURLToPath(new URL('.', import.meta.url)),
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['**/*.test.ts'],
        exclude: ['**/node_modules/**', '**/dist/**']
    }
});
