# 0018 — Three display-lane follow-ups the C1 wave left open: worker mode never sees a bump, no store-level lane test, and no forced-colors rule for the lane chip

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11, fix)** at the bottom; item 1 closed
> on the issue's own documented-limitation route, and the op-set route it names is reported
> there with the files and the shape it needs)
> **Severity:** Minor (ergonomics and drift risk — none of the three breaks the shipped
> inline-mode feature, and each one is a gap a later change can walk into unnoticed)
> **Area:** `src/server/sessions.ts` + `src/server/workers` (item 1),
> `src/server/threads.test.ts` + `src/plugin/context-compaction.test.ts` (item 2),
> `src/frontend/styles.css` + `src/frontend/ui/context-bar.ts` (item 3)
> **Date opened:** 2026-11-11
> **Reduced 2026-11-11:** the contract-generator record (was item 2: an `anyOf` body with
> sibling `properties` rendered as `unknown | unknown`, and no per-property prose) is
> **Fixed** and deleted outright from the sections below per the log rule; see the
> `## Update (2026-11-11 — the contract-generator record is Fixed)` section for its evidence.
> The three surviving
> records are renumbered old 1 → 1 (worker mode), old 3 → 2 (the joined test),
> old 4 → 3 (the forced-colors chip).

## Context

The C1 wave shipped the display lane: a summarize compaction raises its conversation's
`contextLane`, the session recorder stamps that number onto every event it records, the
projector folds the stamps into stacked `ContextBlock.lane` rows, and the browser stacks the
context bar's rows from them. The wave was reviewed end to end (server + frontend) and the
lane itself is sound; these three records are what that review found **outside** the change's
declared scope — a deployment shape the tests never exercise, a test seam neither existing file
reaches, and one CSS state the new chip never got a rule for.

## Gap

What a maintainer cannot do today:

1. **run the lane feature with worker thread execution.** With `threadExecution: 'worker'`
   the lane a plugin raises on the worker-side harness has no route back to the record the
   server reads, so the bar stays one row and the compaction boundary is invisible — while
   the same session on the default `inline` engine paints two rows. Nothing in the product
   states this to the operator who flips the setting;
2. **see the whole lane path in one test.** The producer half is tested against a real harness
   with the shipped plugin, and the store half is tested against a real store with a
   hand-written lane writer; no test runs the shipped compaction plugin through a store run
   and reads the two-row bar out of the projector, so the join between them is pinned only by
   reading both files;
3. **read the lane chip in a forced-colors mode.** The chip is quiet ink on a translucent
   panel, which is exactly the combination forced-colors collapses, and it is the only cue
   that names which stacked row a segment belongs to.

## Why it is the way it is

All three are staged or documented omissions, not defects:

1. The lane is harness-record state and its only writer is the plugin api
   (`src/harness.ts` `setThreadContextLane`); `setContextLane` appears nowhere under
   `src/server/workers`, and the lane-commit op set has no lane key at all —
   `src/server/workers/lane-commit.ts:685` digests `{ status, label }` for `thread:status`,
   so a worker-side bump cannot reach the canonical record the server read walks. The read
   side says so out loud (`src/server/sessions.ts:2736-2744`, inside `contextLaneOf`), and
   the default engine is `inline` (`src/server/config.ts:42`, `:118`
   `DEFAULT_THREAD_EXECUTION`), so the shipped default is the covered shape;
2. The two halves exist and are individually strict: the compaction cases drive the shipped
   plugin through a real harness and sample the lane from inside each provider request
   (`src/plugin/context-compaction.test.ts:2437-2522`), and the store cases drive a real
   `SessionStore` and read the folded bar back out of `getView`
   (`src/server/threads.test.ts:4124-4182`). They are separate because the store fixture's
   writer bumps the lane at a controllable instant mid-stream
   (`src/server/threads.test.ts:286-340`), which is what puts the boundary inside one turn;
   wiring the shipped compactor into a store fixture means a settings provider, a transcript
   long enough to cross the trigger, the pass's own extra model request, and the
   fire-and-forget continuation turn the pass ends with, none of which exists today;
3. Forced-colors rules are per-component by convention (`.context-bar-segment` has one at
   `src/frontend/styles.css:8013-8019`, and `src/frontend/records-style.test.ts:122`,
   `:508` pin that other sections carry one). The new chip
   (`src/frontend/styles.css:7643-7656`, painted at `src/frontend/ui/context-bar.ts:571-583`)
   was added without joining that convention; its accessible name
   (`contextBarLaneLabelOf`, `:581`) still states the fact in words, which is why this is a
   rendering gap and not an accessibility one.

## Evidence

| Fact | Where |
|---|---|
| The lane read the bar uses comes off the canonical harness record, re-read per event | `src/server/sessions.ts:2745` (`contextLaneOf`), `:7934` (model-run recorder), `:6983` (command recorder) |
| The lane write has no worker-side route: no `setContextLane` under `src/server/workers`, and the `thread:status` commit digests only `status` + `label` | `src/server/workers/lane-commit.ts:685`, op set in the same file; `grep setContextLane src/server/workers` is empty |
| Worker mode is the untested deployment shape and the default is inline | `src/server/sessions.ts:2736-2744` (the comment inside `contextLaneOf`), `src/server/config.ts:42` (`ThreadExecutionMode`), `:118` (`DEFAULT_THREAD_EXECUTION = 'inline'`) |
| Producer half, no store: shipped plugin, real harness, lane sampled per request | `src/plugin/context-compaction.test.ts:2437-2522` (`lanes` sampled inside the stream, `expect(lanes).toEqual(['1', '1'])`), bump site `src/plugins/context-compaction.plugin.ts:1199-1203` |
| Store half, no shipped plugin: hand-written bump between two recorded events, folded bar asserted | `src/server/threads.test.ts:286-340` (`laneFixture`), `:4124-4182` (`describe('display lane (C1)')` opens at `:4124`; its `store.getView(...).displays[turn.id]` two-row expectation closes the block at `:4182`) |
| The chip's colors and the missing forced-colors rule | `src/frontend/styles.css:7643-7656` (`background: color-mix(... --bg-deep 78%, transparent)`, `color: var(--muted)`, no border), versus `:8013-8019` for `.context-bar-segment`; painted at `src/frontend/ui/context-bar.ts:571-583` |

## Proposal

Per item, smallest change first, alternatives noted:

1. **Worker mode.** Either extend the lane-commit op set so a worker-side bump lands on the
   canonical record (add `contextLane` to the `thread:status` digest pair, and a lane key on
   the commit the way `label` has one), or publish the limitation where an operator will meet
   it (a `threadExecution: 'worker'` note in the server docs plus one line in the capability
   assessment). Rejected: making the bar read the lane from the worker's own replica — the
   recorder re-reads the canonical record per event, and two sources for one number is how a
   bar starts lying;
2. **The joined test.** Add one store case that mounts the shipped `context-compaction`
   plugin: a settings provider with a low `contextLimit`, one submit whose prompt crosses the
   trigger, and assertions on `store.getView(...).displays[turn.id]` for the boundary turn
   (two rows) and on the continuation turn (one row, on the raised lane). Both fixtures
   already exist; the new part is the fixture that combines them;
3. **The chip.** Add the `@media (forced-colors: active)` rule for `.context-bar-lane`
   (`forced-color-adjust: none` plus a `CanvasText` border/outline, matching what
   `.context-bar-segment` does at `:8013`), and pin it the way the other style tests pin
   forced-colors rules.

## Acceptance criteria

- With `threadExecution: 'worker'`, either a compaction bump reaches
  `contextLaneOf` and the bar shows two rows, or the limitation is stated in the operator-
  facing config/capability surface — not only in a source comment;
- one test drives the shipped compaction plugin through a store run and asserts the folded
  two-row bar from `getView`, with the continuation turn asserted as one row;
- `src/frontend/styles.css` carries a forced-colors rule for `.context-bar-lane`, asserted by
  the context-bar style test.

## Tests to add

- `src/server/workers/*` (or the lane test suite in `src/server/threads.test.ts`): a lane bump
  committed from a lane worker reaches the server-side read — or the capability refusal that
  replaces it;
- `src/server/threads.test.ts`: the plugin→store→projector case described in **Proposal 2**
  (the compile-time guard that keeps those two contract types reachable already lives in
  `src/shared/harness-api.test.ts`);
- `src/frontend/ui/context-bar-style.test.ts`: the forced-colors block for the lane chip.

## Out of scope

- No lane arithmetic outside the summarize pass, and no lane REST route (0017 keeps both out);
- no change to what a lane means or to the two-source fold rule — these three items must not
  become a lane redesign;
- no forced-colors audit of the rest of the frontend: only the chip this wave added is
  recorded here;
- no re-running of the contract generator as part of closing the two remaining records: the
  regenerated contract (`src/shared/harness-api.ts`, `src/shared/harness-stream.ts`) is a shared
  artifact, and the `--check` guard — never a hand edit — is the only way it changes.

## Update (2026-11-11)

- **Re-anchored** — this issue was filed today, so almost nothing had moved: three cites, each by
  a few lines. The store-half block is `src/server/threads.test.ts:4124-4182` (the Evidence row
  said `:4125`, and `describe('display lane (C1)')` opens at `:4124`); the generator's `jsdoc`
  helper is `scripts/generate-harness-contract.mjs:227` (the Why section said `:228` and the
  Evidence row said `:222+`, which is the blank line above the `File writers` banner).
- **Re-verified exact, no edit needed**: `src/server/sessions.ts:2745` (`contextLaneOf`) with the
  worker-mode caveat at `:2736-2744` and the two stamp sites at `:7934` / `:6983`;
  `src/server/workers/lane-commit.ts:685` (`case 'thread:status': {`) — the comment inside
  `contextLaneOf` cross-references that same line and both are current;
  `grep -rn setContextLane src/server/workers` is still empty; `src/server/config.ts:42`
  (`ThreadExecutionMode`) and `:118` (`DEFAULT_THREAD_EXECUTION = 'inline'`);
  `scripts/generate-harness-contract.mjs:141-142` (`const variants = node.oneOf ?? node.anyOf;`)
  against the `allOf` branch at `:144-150` that does fold sibling `properties`, the `unknown`
  fallback at `:183`, and `objectBody` at `:188-217`; the spec body at
  `src/server/harness.swagger.yaml:8417-8420` (the `anyOf` pair, `properties:` at `:8420`) and the
  dropped prose at `:8458-8470`; `src/server/api.ts:4602-4620` (the two `body.<axis>` reads) and
  `:4715-4727` (the `TurnBlockWriteReceipt` it builds); `src/shared/harness-api.ts:1-3` (the
  do-not-edit header); `src/plugin/context-compaction.test.ts:2437-2522` (the assertion is at
  `:2521`) and the bump site `src/plugins/context-compaction.plugin.ts:1199-1203`;
  `laneFixture` at `src/server/threads.test.ts:286-340`; the chip at
  `src/frontend/styles.css:7643-7656` versus the `.context-bar-segment` rule at `:8013-8019`, and
  the paint at `src/frontend/ui/context-bar.ts:571-583` (the accessible name is `:581`);
  `src/frontend/records-style.test.ts:122`, `:508`.
- **One claim re-measured, fresh today**: `node scripts/generate-harness-contract.mjs --check`
  still answers `harness contract types are stale: src/shared/harness-api.ts` and exits 1, so item
  2's "red at HEAD" is still the state of the tree. The check is read-only — the writer only
  touches the file when `--check` is absent (`scripts/generate-harness-contract.mjs:627`) — so
  re-running it changed nothing.
- **Left as recorded, not re-run**: the `PatchTurnBlockRequest = unknown | unknown` collapse and
  the 13 `typecheck` errors. Reproducing them means running the generator WITHOUT `--check`, which
  overwrites `src/shared/harness-api.ts` — out of bounds for a documentation pass. The hand-
  restored state the issue describes is still visible: `PatchTurnBlockRequest` at
  `src/shared/harness-api.ts:2222` carries the per-property doc blocks the generator cannot emit.
- **Cross-reference for whoever picks item 2 up**: 0017's update records that the Rust port now
  carries the lane everywhere except the published contract field, and that field comes from this
  same spec (`src/server/harness.swagger.yaml:8122`). Fixing the `anyOf` / `description` renderer
  is what makes `ContextBlock.lane` land through a regeneration instead of by hand, so the two
  issues should close in that order.
- Status stays **Open**.

## Update (2026-11-11 — the contract-generator record is Fixed)

The renderer gap is closed and its records were deleted from the sections above; this section is
the evidence for that one fix, and the header records the reduction and the renumbering.

- **Baseline re-measured first**, before anything was touched: `node scripts/generate-harness-contract.mjs
  --check` → `harness contract types are stale: src/shared/harness-api.ts`, **exit 1**. The stream
  file was already byte-current, so only the REST file was stale — and reading the two files side
  by side confirmed why: a regeneration against the UNFIXED renderer differs from the shipped file
  in exactly two places, the `PatchTurnBlockRequest` block (collapses to
  `export type PatchTurnBlockRequest = | unknown | unknown;` and loses its closed-object note) and
  the two property doc blocks of `TurnBlockWriteReceipt`. The rest of the 2 446 lines matched
  byte-for-byte, so the "generated" file was in fact generated-plus-hand-patched, exactly as filed.
- **The generator rules that changed** (`scripts/generate-harness-contract.mjs`):
  `carriesType()` separates a member that carries a TYPE (`$ref`, `type`, `enum`, `properties`,
  `additionalProperties`, `items`, or a nested composite) from one that carries only a CONSTRAINT
  (`required` alone, the OpenAPI spelling of "at least ONE of these fields"). The `oneOf`/`anyOf`
  branch then folds the sibling `properties` the way `allOf` already did: constraint-only members
  leave the field map as the whole type, typed members render as a parenthesised union
  INTERSECTED with that field map (`(A | B) & { … }`, never `A | (B & { … })`). A schema whose union
  members are all constraints stays an `interface`, so the "at least one" rule stays normative
  prose in the description block rather than becoming a narrowing union — that is the shape
  `src/server/api.ts:4600-4662` reads `body.included` / `body.reasoningIncluded` off.
  `objectBody()` now emits each property's `description` as a JSDoc block at the property's column,
  and `jsdoc()` takes an `indent` (the 110-column budget is measured on the block's TEXT lines, so
  every schema-level block in both files stays byte-identical). One guard rides along: an
  INTERSECTION body is no longer fed to the top-level "` | ` → one-per-line" re-split, which
  silently re-associated `(A | B) & C`; that guard reformatted 5 existing `allOf` declarations
  (`ToolDetail`, `SessionResource`, `SessionToolSummary`, `TranscriptMessagePage`, and their nested
  union-typed property lines) with no change to any type.
- **The regeneration, verified rather than assumed:** with comments stripped, the pre-fix shipped
  `src/shared/harness-api.ts` and the regenerated one are **identical** — the hand patches are now
  reproduced by the generator itself, which is what acceptance asked for. `PatchTurnBlockRequest`
  regenerates as `export interface PatchTurnBlockRequest { included?: boolean;
  reasoningIncluded?: boolean }` with the closed-object note and both spec property blocks, and
  `TurnBlockWriteReceipt` regains `block_id` / `included` / `reasoning_included` prose. The only
  wording delta left is that the two hand-paraphrased blocks now carry the spec's prose verbatim —
  the spec is the single source of truth, so the paraphrase is gone and every fact it stated
  survives (it states MORE: `TurnBlockWriteReceipt.block_id` never had a doc line before).
  Sizes: `harness-api.ts` 2 446 → 3 825 lines, `harness-stream.ts` 858 → 1 009 (property prose
  across the whole 457-described-property spec, both files). Both are generator output — no block in
  either file is hand-written any more, which is what makes the "Do not edit by hand" header true.
- **Offline evidence:** `node scripts/generate-harness-contract.mjs --check` → `harness contract
  types are up to date`, **exit 0**; `yarn workspace @underload/harness run typecheck` → **exit 0**,
  no `tsc` errors anywhere, so the 13 block-write-route errors the issue measured are gone;
  `npx vitest run src/shared/harness-api.test.ts src/server/api.test.ts` → **86/86**, exit 0
  (including "keeps the block-detail write body and receipt reachable through their declared
  keys", the guard that fails to compile on the collapse).
- **Test added** (`scripts/generate-harness-contract.test.mjs`, `node --test`, following the
  `scripts/package-files.test.mjs` precedent): seven tests with exact expected strings — the
  `anyOf`-of-`required`-members fixture renders the folded interface (no `unknown | unknown`), the
  typed-union fixture renders `(WsWelcome | WsError) & { … }`, a described property renders its
  JSDoc at the property column and inside an inline object body, a schema-level block stays
  byte-identical while a property block keeps the same right edge, the `carriesType` truth table,
  the SHIPPED `PatchTurnBlockRequest` renders both axes (its code lines asserted exactly, and the
  `unknown` collapse asserted as an absence), and the `--check` guard runs as a subprocess (exit 0
  plus exact stdout). **7/7 pass**, and `eslint` on both script files is clean. Mid-fix, with the
  fixed renderer in place but the regenerated files not yet written, the same run failed on the
  `--check` test alone — `harness contract types are stale: src/shared/harness-api.ts,
  src/shared/harness-stream.ts` — so the red-to-green step is pinned by the suite, not by this note.
- **Drift this fix caused:** none in the files the three surviving records cite — this fix touches
  the generator, the two generated files, and its own test, so `src/server/sessions.ts`,
  `src/server/workers/lane-commit.ts`, `src/server/config.ts`, `src/server/threads.test.ts`,
  `src/plugin/context-compaction.test.ts`, `src/frontend/styles.css` and
  `src/frontend/ui/context-bar.ts` all keep their cited line numbers. Inside the generator the old
  cites (`:141-142`, `:144-150`, `:183`, `:188-217`, `:227`) moved with the fix, which is why the
  deleted records' line references are not worth re-anchoring.
- **Not covered / left for the owner:** the new test file is a `node --test` suite and
  `vitest.config.ts` includes only `src/**`, so `npm test` does not run it — wiring it needs a
  `package.json` script (mirroring `test:package:files`), outside this fix's file set. The
  historical rationale comment at `src/shared/harness-api.test.ts:566-575` still narrates the
  collapse in the past tense (it is why that guard exists) and was left alone — the test file is
  not this fix's. One PRE-EXISTING `tsc` error is unrelated to this fix and was left for its owner:
  `src/shared/harness-api.test.ts:482` builds a `PluginSummary` fixture without `enabled`, which the
  same interface already required at HEAD (`PluginSummary.enabled: boolean`), and `tsconfig.json`
  excludes `**/*.test.ts` so `run typecheck` never sees it.
- **Cross-reference for 0017:** `ContextBlock.lane` (spec `src/server/harness.swagger.yaml:8122`)
  can now land in the published contract through a regeneration rather than by hand, so the order
  0018's previous update asked for is met: this record first, then the Rust port's contract field.
- Status stays **Open** for the three surviving records.

## Update (2026-11-11, fix)

All three surviving records are closed: item 3 with the rule the Proposal named, item 2 with the
joined case the Proposal named, and item 1 on the Proposal's **other** allowed route — publish
the limitation where the operator meets the switch — because the op-set route turned out to need
a harness-handle seam in two files this wave assigns elsewhere. The sections above are left as
filed: the log rule deletes a record when it closes, and with the whole issue now closed the
file's own deletion is the owner's step (kept for review, like 0001 and 0008/0011-0016).

- **Baseline re-measured first.** `npx vitest run src/server/threads.test.ts
  src/plugin/context-compaction.test.ts` → **130/130**, exit 0. Both halves were green before
  anything was touched, so the join is a genuine untested seam rather than a broken tree.
- **Re-anchored, and one claim measured fresh.** Every cited line still holds: `grep -rn
  setContextLane src/server/workers` is empty; `./workers/lane-commit.ts:685` still digests
  `{ status, label }` and nothing else (`:690`, `:703`); the read is `./sessions.ts:2745` →
  now `:2758` (its comment grew, see below); the chip is still `../frontend/styles.css:7643-
  7656` and the segment's forced-colors rule still opens at `:8013`. **New fact, and it is why
  item 1 is not a one-line op change:** `thread:status` is declared and folded but never SENT —
  `grep -rn "thread:status" src/` returns only the op type (`./workers/lane-commit.ts:208`), the
  lease scope (`:418`), the two handlers (`:685`, `./workers/lane-authority.ts:942`) and this
  file's cites. Nothing in the lane loop emits it, and a status transition happens once per turn
  while the pass raises the lane mid-run, so a lane key riding on `thread:status` could not move
  a bar even if it were sent: the boundary needs its own commit at a commit boundary, the way
  `transcript:patch` does (`./workers/lane-commit.ts:239-251`).
- **Item 1 — published, in the capability assessment (the operator-facing surface).**
  `./workers/capability.ts:75-83` adds one note to `WORKER_MODE_NOTES`, the list
  `assessLaneWorkerCapability` returns and `./sessions.ts:2346` reads at create and at restore:
  `LIMITATION (display lane, not routed): … one-row context bars … every event stamped lane 0 …
  the value is not deferred`. It is a **note, not a reason** — worker mode still runs the session
  and the compaction, so no preset turns into the 400 at `./sessions.ts:2349`.
  Pinned by `./workers/capability.test.ts:152-172` (`it('states the display-lane limitation
  where the operator meets the switch (0018 item 1)')` — the whole sentence by `toBe`, plus
  `supported: true` / `reasons: []` so the note cannot quietly become a refusal) and by the
  verbatim contract list at `:75-79` with the count now `toHaveLength(11)` (`:148`).
  `./sessions.ts:2746-2757` — the comment inside `contextLaneOf` now cross-references the
  published note and records what a real fix requires, so the next reader does not re-derive it.
- **Item 1 — what the op-set route needs, precisely (reported, not started).** The write has to
  land on the canonical harness, and every other commit op reaches it through a handle seam:
  `./workers/lane-authority.ts:882` `appendThreadMessages`, `:923` `patchThreadMessages`, `:944`
  `setThreadStatus`. There is **no lane-shaped member on the handle**: `setThreadContextLane`
  exists only as the plugin-api member (`../harness.ts:5781`, wired at `:1564`), and the `Harness`
  contract declares the T5 seams without it (`../types/index.ts:3716`-`:3760`). Both files belong to
  another worker this wave — `../types/index.ts` is a declared do-not-touch here — so the route
  stalls at exactly two files, and the rest is this subsystem's own:
  1. `../harness.ts` — expose the lane write on the handle beside `setThreadStatus` (`:11852`),
     as the same validate-and-write the plugin member performs (it already notifies `thread`,
     `:5807`);
  2. `../types/index.ts` — its `Harness` declaration, next to `setThreadStatus` (`:3760`);
  3. `./workers/lane-commit.ts` — `CanonicalThread.contextLane` (`:82`), the op (`:203-208`), its
     lease scope (`leaseScopeOf`, `:403-423`), the fold case and its digest;
  4. `./workers/lane-authority.ts` — copy the lane into the fold view (`threadsOf`, `:295-325`;
     the snapshot already carries it, `../harness.ts:10639`/`:10980`), the live replay, and its
     `liveRejectionCodeOf` code;
  5. `./workers/lane-worker-loop.ts` — a lane read on `ReplicaReadView` (`:690`) plus the base it
     compares against in `deriveOperations` (`:729`), adopted from the receipt like
     `committedLength` is.
  Reading the lane off the worker's own replica stays rejected, as this issue ruled.
- **Item 1 — README line for the owner** (`README.md` is another worker's this wave; the switch
  is documented at `:3138`, "Per-thread CPU isolation (`threadExecution: 'worker'`)"):
  *A compaction boundary is invisible in worker mode.* The display lane the context bar stacks
  its rows by is raised mid-run by the `context-compaction` summarize pass, and that bump has no
  route from a lane replica back to the canonical record the server records events from — so a
  session on `threadExecution: 'worker'` keeps **one-row** context bars where the same session on
  the default `inline` engine paints the boundary as two stacked rows. The compaction itself is
  unaffected. `assessLaneWorkerCapability` states the same fact as the capability note
  `LIMITATION (display lane, not routed)`.
- **Item 2 — the join, in one store case.** `src/server/threads.test.ts:352-429` is
  `compactionFixture`: the store's scripted preset with the SHIPPED pass mounted by settings
  alone — `context-compaction` is a built-in (`src/plugin/manifest.ts`), so nothing here imports
  or re-implements it — at `contextLimit: 250`, `minTokens: 0`, `mode: 'summarize'`, with
  `context-trimmer.enabled: false` for the same isolation the producer half uses. The trigger is
  derived before the run, not read off it: the estimator is `ceil(chars / 4)`
  (`src/core/context-estimate.ts`), so the 1 200-character prompt is 300 tokens plus the
  3-character `sys` instruction — over 250 at the first boundary, and the retained head the pass
  leaves is far under it, which is what makes "exactly one pass" a provable expectation.
  The case itself is `:4268-4404` (`it('paints a real summarize compaction as two stacked rows,
  and the next turn as one')`, inside `describe('display lane (C1)')`):
  - the boundary turn's six frames as exact `[type, delta, lane]` triples: `start` unlaned, then
    `answer:1` / `done` / the continuation's `start` / `answer:2` / `done` all at lane 1;
  - **the pass named by its own bytes**: the transport logs the last user turn of every request
    and it must equal `[COMPACTION_INSTRUCTION, CONTINUATION_NUDGE, 'again']` — constants
    imported from `src/plugins/context-compaction.plugin.ts:495`/`:504`, which nothing but the
    shipped plugin can put on the wire, so the case cannot pass on a hand-performed bump;
  - `store.getView(...).displays[boundary.id]` asserted block by block as
    `[id, name, lane, chars]` — instructions 3 and the 1 200-character prompt on lane `undefined`,
    both eight-character answers on lane 1 — then grouped into `[0, 1]` by `lanesOf`, the case's
    local copy of the browser's own rule (`src/frontend/view-context.ts:436`/`:449`), restated
    because the node config excludes `src/frontend` (`./vitest.config.ts`);
  - the continuation submit: `turn.lane === 1`, three frames all at 1, three blocks all at 1,
    grouped `[1]` — **one row** — with its prompt block at 5 characters, i.e. the compacted head
    rather than the oversized prompt.
- **Item 2 — one recorded shape discovered and pinned, not assumed.** The pass's fire-and-forget
  continuation run is recorded INTO THE SAME TURN the pass fired in (its three frames are numbers
  4-6, with invocation id `2`), because the recorder is bound to the run's async context
  (`./sessions.ts:7920`-`:7960`), not to the queue entry. The case therefore waits on the exact
  frame count (`waitUntil(() => … events.length === 6)`, helper at `:438`) rather than sleeping,
  so a missing continuation fails loudly instead of showing up as a three-block bar.
- **Item 3 — the chip.** `../frontend/styles.css:8024-8028`:
  `.context-bar-lane { forced-color-adjust: none; outline: 1px solid CanvasText;
  outline-offset: -1px; }`, written inside the section's one forced-colors at-rule (now
  `:8013-8037`) directly after `.context-bar-segment`'s pair, which is the convention the issue
  named. `../frontend/ui/context-bar-style.test.ts:462-490`
  (`it('keeps the per-row lane chip bounded under forced colors (0018 item 3)')`) slices the
  chip's rule out of `atRulesOf('@media (forced-colors: active)')` and asserts it **whole**,
  whitespace-normalised — a declaration drifting into the segment rule cannot stay green — and
  asserts the base chip's `color-mix(in srgb, var(--bg-deep) 78%, transparent)` + `--muted` as
  the reason the rule exists. `ui/context-bar.ts` is untouched on purpose: the accessible name
  (`contextBarLaneLabelOf`, `:581`) already states the number, so this was only ever the
  rendering half.
- **Verification.** `npx vitest run src/server/threads.test.ts src/server/workers/capability.test.ts`
  → **85 passed**, exit 0 (the joined case included). The joined case alone, run three times
  because its continuation is fire-and-forget: **1/1, 1/1, 1/1**.
  `npx vitest run --config src/frontend/vitest.config.ts ui/context-bar-style.test.ts` → **14
  passed**; the 13 other suites that read `styles.css` (`ui/context-bar.test.ts`,
  `ui/turns-context-bar.test.ts`, `ui/agent-color-surfaces.test.ts`, `ui/layout-containment.test.ts`,
  the seven `*-style.test.ts`, `records-style.test.ts`, `index.test.ts`) → **135 passed**.
  `src/plugin/context-compaction.test.ts` was not edited — its producer case is the other half of
  the join and stands as filed.
- **Concurrent-worker breakage seen mid-pass, not caused and not fixed here.**
  `src/server/harnesses/presets.ts` (another worker's file this wave) was briefly in a state where
  `:343` referenced an undefined `chat`, which failed every suite importing `./harnesses` —
  including `src/server/threads.test.ts` and `./workers/capability.test.ts` — with
  `ReferenceError: chat is not defined`. It cleared on its own; every number above is against the
  healthy file.
- **Not covered / left for the owner:** the op-set route in items 1's list (needs
  `../harness.ts` + `../types/index.ts`); the `README.md` line, text above; and the Rust port's
  inability to RAISE a lane at all, which stays 0017's open half.
- **Status: Fixed** for all three surviving records. The file is kept for review — delete it and
  its index row once the owner's integrated run confirms.
