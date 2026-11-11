# 0002 — Standalone tool-source compile/validate is not on the published surface

> **Status:** Fixed — 2026-11-11 (the compile entry is published from the root with both evaluate modes; see **Fixed (2026-11-11)** below)
> **Severity:** Significant
> **Area:** `src/core/tool-source.ts`, `src/core/index.ts`, `src/harness.ts`, `package.json` exports
> **Date opened:** 2026-11-02

## Context

A distribution building its own endpoint on the kit (`distribution/chat-assistant`)
keeps a user-authored tool registry: one row is a name plus, for a custom tool,
`language: 'javascript' | 'typescript'` and source text
(`distribution/chat-assistant/src/agents/index.ts:45-60`). Its editor wants to
answer "is this tool definition valid?" — compile it, check the contract and the
argument schema — **before** anything is registered, and to reuse an already
compiled revision when many conversations install the same tool.

## Gap

A published consumer cannot compile or validate TypeScript tool source without
first constructing a harness, and cannot reuse a compilation:

- the compiler/validator (`prepareToolCandidate`) and the supports flag
  (`supportsToolCompilation`) are exported from the **internal** core barrel but
  are not re-exported from the package root, and there is no `./core` subpath;
- the only published paths are `harness.toolCreate({ source })` — a JavaScript
  async function body, not a TypeScript module — and
  `harness.registerTool({ moduleText })`, which both compiles **and** publishes
  into that one instance's registry;
- so "validate without publishing" — an explicitly stated intent in the source —
  is available to the package's own tests but not to a published consumer;
- nothing is cached **across registrations or instances**: each construction re-transpiles and
  re-evaluates the same bytes, and top-level evaluation is a real side effect. (Within one
  registration the module graph is evaluated once, which is not the reuse this issue asks
  for.)

## Why it is the way it is

The single compile/load/validate/register operation is deliberately the only
publish path, and the harness owns it: `src/types/index.ts:3282-3291`
("`registerTool` … Publication is therefore a completion barrier"),
`src/core/index.ts:75-77` ("Exported for focused tests and for a host that wants
to validate a candidate **without publishing it**; the harness owns the only
publish path"). The validator's own limits are documented honestly:
`ts.transpileModule` is syntax-only, not semantic type checking, and loading a
candidate evaluates its top-level code (`docs/runtime-tools.md:34-51`).

None of that argues against publishing a read-only compile — it argues for
naming its limits, which the code already does.

## Evidence

| Fact | Source |
|---|---|
| `prepareToolCandidate` and `supportsToolCompilation` are exported from the core barrel, with the stated "validate without publishing" intent | `src/core/index.ts:74-90` |
| The read-only result type already exists and is documented as "a compiled candidate that has NOT been published" | `src/core/tool-source.ts:181-189` (`PreparedTool`) |
| The root barrel re-exports only `compileToolSource` and `createDynamicTool` from core | `src/harness.ts:11988-12004` (`compileToolSource` `:11993`, `createDynamicTool` `:11994`) |
| `compileToolSource` / `createDynamicTool` compile a **function body** (`Function` constructor), not a module | `src/core/creation.ts:96` (`new AsyncFunction`), `:110` (`createDynamicTool`) |
| Module compilation + candidate preparation live in the Node-only source module | `src/core/tool-source.ts` (`prepareToolCandidate`, `supportsToolCompilation`) |
| Accepted module export shapes (so a wrapper is trivial): named tool, default export, named `tool`, or `metadata` + `execute` | `src/core/tool-source.ts:1426-1432` (`selectToolExport`) |
| Published entry points are only `.`, `./server`, `./worker`, `./io-worker`, `./frontend`, `./shared`, `./package.json` | `package.json:9-58` |
| Host-side registration surface: `toolCreate` (legacy body) and `registerTool` (candidate, publishes) | `src/types/index.ts:3277-3294` |
| A revision is already content-addressed over the entry plus its local helpers | `src/types/index.ts:839-851` |
| Compilation needs `typescript` and Node built-ins; the browser has no source compiler | `src/core/tool-source.ts:14-16`, `:240`; `src/types/index.ts:3166-3169` |

## Proposal

**Preferred:** add a read-only compile to the root barrel, with the contract
`prepareToolCandidate` already implements:

```ts
compileToolSourceModule(candidate, options?) => {
  name, description, tags, parameters, visibility,
  revision,            // the existing content-addressed revision
  checks,              // the existing explicit list of what WAS checked
  definition           // a callable Tool, not registered anywhere
}
```

Rules:

- the returned `checks` list stays the honesty mechanism (`checks: readonly
  string[]`, `src/types/index.ts:848-850`); the doc must repeat that it never
  claims semantic type checking;
- evaluating candidate top-level code must be **opt-out**: a
  `evaluate: 'syntax' | 'load'` (or `dryRun`) mode so a validation endpoint can
  answer without running untrusted module top-level code, because today a failed
  registration cannot roll back those side effects
  (`docs/runtime-tools.md:48-51`);
- add `supportsToolCompilation` to the root barrel so a host can branch
  Node/browser without probing an error string;
- optional, and the cheaper half of the value: a **process-level compile cache**
  keyed by the existing `revision`. It is a pure function of the captured bytes
  plus dependencies, so the cache is safe, and it removes the per-conversation
  re-transpile that makes item 0003 expensive.

**Alternative considered:** publish a `./core` subpath and let hosts reach
`prepareToolCandidate` there. Rejected as the primary answer because it would
also expose roughly thirty internal names at once (`src/core/index.ts` is a
test-facing barrel), and because the name does not say what it returns. A named
root export is a smaller contract.

**Alternative considered:** keep requiring a harness instance. Rejected for the
validate-only case: constructing a harness to *check* a definition also builds
agents and a transport, and any throw becomes an ambiguous "construction
failed".

## Acceptance criteria

1. A published consumer can compile and validate a TypeScript tool module from
   source text and get metadata + revision + a callable definition **without**
   constructing a harness and without touching any registry.
2. The same call can answer "syntax and schema only" without evaluating
   candidate top-level code.
3. `supportsToolCompilation` is importable from the package root.
4. Enabling the compile cache changes no observable registration semantics
   (replacements still change `revision`; `toolSource()`/`toolSources()` still
   report the installed revision — `src/types/index.ts:3295-3300`).
5. `README.md` "External tool folders and `*.tool.ts`" and `docs/runtime-tools.md`
   name the published entry and restate the syntax-only limit.

## Tests to add

- `src/core/tool-source.test.ts` — compile-without-publish; both `evaluate`
  modes; a candidate whose top-level code throws is still reported as a
  validation failure, not a registry change; cache hit returns the same revision
  and does not re-evaluate (assert with a side-effecting probe).
- `src/core/tool.test.ts` / `src/harness.ts` structure test — the new names are
  present in the root barrel, and the browser declaration graph still never
  reaches the Node compiler (`README.md:276-287`, `README.md:305-320`,
  `scripts/check-package-types.mjs`).
- `scripts/test:package:files` fixture — the new export ships in `dist`.

## Out of scope

- Semantic type checking of user source, or a language-service-backed
  diagnostics surface.
- Sandboxing/isolation (tracked separately, `docs/runtime-tools.md:52-53`).
- Any change to what `registerTool` publishes.

## Update (2026-11-11)

- **Anchors re-grounded** against the current tree; the gap and every claim are
  unchanged, and status stays **Open** (no reduction).
- Re-checked anchors: the root public-surface block is now
  `src/harness.ts:11988-12004` (`compileToolSource` `:11993`,
  `createDynamicTool` `:11994`), the registration surface is
  `src/types/index.ts:3277-3294`, the content-addressed source record is
  `:839-851`, `selectToolExport` is `src/core/tool-source.ts:1426-1432`, and the
  Node-only-compilation note in configuration is `src/types/index.ts:3166-3169`.
- README cites follow the 2026-11-11 README realignment (`:276-287` runtime
  import split, `:305-320` the declaration split and the `check-package-types`
  guarantee).
- Still true on re-check: `prepareToolCandidate` and `supportsToolCompilation`
  are exported only from the internal core barrel (`src/core/index.ts:74-90`)
  with the "validate without publishing" intent stated there, and the published
  entry points are still `.`, `./server`, `./worker`, `./io-worker`,
  `./frontend`, `./shared`, `./package.json` (`package.json:9-58`) — no `./core`.

## Fixed (2026-11-11)

- **What shipped.** `compileToolSourceModule(candidate, options?)` is published from the
  package ROOT (`src/harness.ts:12150`, re-exported from the internal core barrel at
  `src/core/index.ts:90`, implemented at `src/core/tool-source.ts:2430`) with
  `supportsToolCompilation` beside it as the flag a host branches on instead of probing an
  error string. The result vocabulary is nameable from the root — `CompiledToolSourceModule`,
  `ToolCompileCandidate`, `ToolSourceCompileOptions`, `ToolSourceEvaluateMode`,
  `ToolSourceRecord`, `ToolSourceDependency`, `ToolSourceLiveDependency`
  (`src/harness.ts:12151-12161`). NO `./core` subpath was added: the exhaustive subpath list
  is pinned at `src/structure.test.ts:329-336` and the missing `./core` explicitly at
  `:338-344`.
- **The candidate and the two modes.** `ToolCompileCandidate` is the kernel's own candidate
  shape plus an optional `definition` (`src/core/tool-source.ts:213-215`), so a host can also
  validate a definition it constructed. `evaluate: 'load'` (default) is the registration
  path's own operation — transpile, resolve the static graph, EVALUATE, contract-check — and
  reports `['transpile:syntax','load:module','contract:tool','schema:json']`. `evaluate:
  'syntax'` stops after the transpile and the declared-schema check: candidate top-level code
  never runs, the metadata reported is the CANDIDATE's (a module cannot describe itself without
  loading it), there is no `definition` key at all, and `checks` is
  `['transpile:syntax']` plus `'schema:json'` only when the candidate declared a schema. A
  candidate that cannot name itself in that mode is refused with the three ways out
  (`src/core/tool-source.ts:2227`). A supplied `definition` selects the no-load path in
  EITHER mode and is returned by identity, never re-evaluated.
- **A process-level compile cache that changes no registration semantics.** Keyed on the
  caller's own input set — mode, entry text, supplied helper bytes, metadata identity —
  computed BEFORE any transpile or evaluation (`compileCacheKeyOf`,
  `src/core/tool-source.ts:2145`). Only `moduleText` candidates are cacheable, because an
  edited helper would move the revision under unchanged entry bytes; failures are never cached,
  so a validation endpoint cannot be served a stale refusal; the map is a bounded FIFO of 128
  (`COMPILE_CACHE_LIMIT`, `:2116`); `{ cache: false }` re-evaluates. `prepareToolCandidate`
  never consults it, so acceptance 4 ("registration semantics unchanged") holds by construction
  rather than by test — and the replacement cases in `src/harness.tool-catalogue.test.ts` pin
  that the revisions the two surfaces report still agree.
- **Documentation.** `docs/runtime-tools.md:238-286` gained
  `### Compile a candidate without touching the registry`: both modes, the exact check
  vocabulary per mode, the cache rules, the platform flag, and the restatement that this is
  SYNTAX-only (`ts.transpileModule`, never a semantic type check) and that `'load'` runs
  candidate top-level code. `README.md:729-739` names the entry inside
  "External tool folders and `*.tool.ts`" with the same limit and the shared-catalogue shape.
- **Tests.** `src/core/tool-source.test.ts:533` (9 new cases: the load-mode result and its
  checks, both syntax-mode check lists, the name-less refusal, the throwing-top-level probe in
  each mode, cache hit / `cache: false` / failure-not-cached / mode-keyed, the transpile
  diagnostic in both modes, and definition identity with `prepareToolSourceRecord` revision
  agreement). The registry-facing half — "compiling publishes nothing" and "a throwing top
  level is a validation failure, not a registry change" — needs a registry to look at, so it
  lives in `src/harness.tool-catalogue.test.ts:79` (first two cases).
- **Verification.** Focused: `npx vitest run src/core/tool-source.test.ts
  src/harness.tool-catalogue.test.ts` → **31 passed**; the 12-file set that also covers
  registration (`harness.self-modifying`, `harness.tool-folders`, `harness.creation-policy`,
  `harness.creation`, `harness.missing-source`, `harness.browser-fallback`), the root surface
  (`structure`), records and the web tools → **148 passed**. Full package, run from
  `packages/underload/harness` after the last source and test edit of this pass:
  `npx vitest run` → **187 files / 3559 tests passed, 2 skipped, exit 0**.
  `yarn workspace @underload/harness run typecheck` → **exit 0**, re-run after the final
  test edit (its `tsc --noEmit` covers `**/*.ts`, so the test files are typechecked too).
- **Not claimed.** No semantic type checking, no sandboxing, and no behaviour/validation
  guarantee beyond what `checks` lists — `'load'` still evaluates candidate top-level code,
  with the side-effect cost `docs/runtime-tools.md` already states.
