// Leaf type for a harness-owned core tool's declarative half.
//
// WHY THIS IS A LEAF MODULE (T13)
// -------------------------------
// The metadata for each core tool lives in that tool's own
// `runtime-tools/<name>.tool.ts` entry. Those entries are compiled as editable
// source at harness startup, so they must not import the compatibility aggregator
// `./metadata.ts`: that aggregator re-exports the entries themselves, and a runtime
// import back into it would create a module cycle.
//
// Entries annotate their local metadata with this type through a TYPE-ONLY import
// of `../core` (erased at transpile, resolved to the live core namespace), which
// keeps their captured revisions at `dependencies: []` — the shipped packaging
// contract in scripts/check-package-tools.mjs. This module is therefore the single
// declaration of the shape, re-exported by both `./metadata.ts` and `core/index.ts`.
//
// Cross-references:
//   - ./metadata.ts — re-exports this type for the public `@underload/harness`
//                     compatibility surface (core/index.ts also re-exports it)
//   - ../runtime-tools/*.tool.ts — the authoritative metadata owners
//   - ../types — ToolVisibility

import type { ToolVisibility } from '../types';

// One core tool's declarative half: everything a request declaration or a server
// catalogue needs, and nothing that could execute.
export type CoreToolMetadata = {
    name: string;
    description: string;
    tags: readonly string[];
    parameters: Record<string, unknown>;
    // Always 'core': every entry is declared on every request. Typed rather than
    // literal so a catalogue entry can copy it without a widening cast.
    visibility: ToolVisibility;
};
