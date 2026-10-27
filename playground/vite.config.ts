// Vite config for the harness UI.
//
// The UI is a browser client only: it calls `/api`, and the server owns every
// harness. `playground/dev.ts` starts the standalone server and points Vite's
// proxy at it; `yarn serve` serves the built bundle and the API from one origin.
// `vite preview` serves the built bundle, so it proxies `/api` to a `yarn serve`
// process.
//
// `base` comes from PLAYGROUND_BASE so the same build can be mounted under a
// subpath. The UI is normally served by the harness server, which mounts the
// build at `/`.

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Normalize a deployment subpath to a leading+trailing slash. The default is
// root, which is where the harness server mounts the build.
const normalizeBase = (value: string | undefined): string => {
    if (value === undefined) return '/';

    const trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
    return trimmed.length === 0 ? '/' : `/${trimmed}/`;
};

const previewProxy = {
    '/api': {
        target: 'http://127.0.0.1:5181',
        changeOrigin: true
    }
};

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: normalizeBase(process.env.PLAYGROUND_BASE),
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true
    },
    server: {
        port: 5180
    },
    preview: {
        port: 5180,
        proxy: previewProxy
    }
});
