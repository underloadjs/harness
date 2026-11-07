// Vite's ambient types: stylesheet imports, `import.meta.env`, asset modules.
// The package tsconfig restricts `types`, so this reference is what makes the
// frontend's CSS import (and any future asset import) typecheck.
/// <reference types="vite/client" />

// Composed at BUILD time by src/frontend/vite.config.ts (`define`) from
// package.json's version and the build machine's date, e.g.
// "Harness UI v2.3.0(261108)". Nobody assigns it: it is a literal substitution.
//
// `undefined` under vitest, whose config does not define it, so main.ts falls
// back to the bare "Harness UI" name there. See src/frontend/build-label.ts.
declare const __HARNESS_UI_LABEL__: string | undefined;
