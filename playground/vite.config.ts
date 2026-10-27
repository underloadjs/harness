// Vite config for the harness playground — the visual harness tester.
//
// Separate from `../vite.config.ts`, which builds the publishable library. This
// config builds a browser app only: nothing here reaches npm, because
// package.json ships `dist/` and this output lands in `playground/dist/`.
//
// Two aliases make the package source runnable in a browser:
//   - `@underload/harness` resolves to `../src/harness.ts`, mirroring the vitest
//     alias, so the playground always exercises source and never a stale build;
//   - every `node:` specifier resolves to `./src/node-stub.ts`. The barrel
//     re-exports the preset tools, which statically import Node built-ins;
//     stubbing keeps the graph loadable, and calling one of those tools in a
//     browser throws a plain error the harness reports as a tool result.
//
// `base` comes from PLAYGROUND_BASE so the same config deploys under any GitHub
// Pages path (workflow: `actions/configure-pages` → base_path).
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const packageEntry = fileURLToPath(new URL('../src/harness.ts', import.meta.url));
const nodeStub = fileURLToPath(new URL('./src/node-stub.ts', import.meta.url));

// Alias entries only replace the matched text, so a `/^node:/` alias would turn
// `node:fs/promises` into `<stub>/fs/promises`. Resolve every `node:` specifier to
// the stub outright instead, which also covers imports added later.
const nodeStubPlugin: Plugin = {
    name: 'playground-node-stub',
    enforce: 'pre',
    resolveId(source) {
        if (source.startsWith('node:')) return nodeStub;
        return undefined;
    }
};

// GitHub Pages serves project sites from /<repo>/ and user sites from /. The
// action emits either '' or '/<repo>', so normalize to a leading+trailing slash.
const normalizeBase = (value: string | undefined): string => {
    if (value === undefined) return '/harness/';

    const trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
    return trimmed.length === 0 ? '/' : `/${trimmed}/`;
};

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: normalizeBase(process.env.PLAYGROUND_BASE),
    plugins: [nodeStubPlugin],
    resolve: {
        alias: [{ find: /^@underload\/harness$/, replacement: packageEntry }]
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true
    },
    server: {
        port: 5180
    },
    preview: {
        port: 5180
    }
});
