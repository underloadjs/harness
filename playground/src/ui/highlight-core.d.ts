// Ambient types for the modular highlight.js entry point.
//
// `highlight.js` ships one `types/index.d.ts` that declares the root module and
// a wildcard for `highlight.js/lib/languages/*`, but the `exports` map has no
// "types" condition for `./lib/core`, so TypeScript cannot see the API through
// the import condition. Declaring it here keeps the playground typed without a
// dependency on the full `highlight.js` bundle (which registers every language).
//
// Cross-reference: node_modules/highlight.js/types/index.d.ts:270 already
// declares the per-language wildcard, which is why only core needs a shim.
declare module 'highlight.js/lib/core' {
    import type { HLJSApi } from 'highlight.js';

    const hljs: HLJSApi;
    export default hljs;
}
