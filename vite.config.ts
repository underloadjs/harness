// Vite config for the @underload/harness npm build.
// - Library mode, ESM-only output `dist/underload-harness.mjs` - matches the
//   `exports.import` condition in package.json.
// - Entry is `src/harness.ts`: src/ holds only that file, and it re-exports the
//   public surface from the role folders (core/, transport/, util/, types/).
// - Node built-ins stay external so the bundle runs under Node without
//   polyfills.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    build: {
        lib: {
            entry: fileURLToPath(new URL('./src/harness.ts', import.meta.url)),
            name: 'underload-harness',
            formats: ['es'],
            fileName: () => 'underload-harness.mjs'
        },
        rollupOptions: {
            external: [/^node:/],
            output: {
                globals: {},
                // Presets load their implementation through `import()` (see
                // src/tools/catalogue.ts). Those must stay deferred chunks: inlining
                // them would hoist every `node:fs`/`child_process`/`vm` import into
                // the entry and make importing the package pay for all ten tools.
                // The default is already false; stating it makes the requirement
                // explicit for anyone changing the build.
                inlineDynamicImports: false
            }
        },
        sourcemap: true,
        emptyOutDir: true
    }
});
