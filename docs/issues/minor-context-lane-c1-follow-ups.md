# 0018 — Four display-lane follow-ups the C1 wave left open: worker mode never sees a bump, a contract regeneration cannot render the block-write body, no store-level lane test, and no forced-colors rule for the lane chip

> **Status:** Open
> **Severity:** Minor (ergonomics and drift risk — none of the four breaks the shipped
> inline-mode feature, and each one is a gap a later change can walk into unnoticed)
> **Area:** `src/server/sessions.ts` + `src/server/workers` (item 1),
> `scripts/generate-harness-contract.mjs` + `src/shared/harness-api.ts` (item 2),
> `src/server/threads.test.ts` + `src/plugin/context-compaction.test.ts` (item 3),
> `src/frontend/styles.css` + `src/frontend/ui/context-bar.ts` (item 4)
> **Date opened:** 2026-11-11

## Context

The C1 wave shipped the display lane: a summarize compaction raises its conversation's
`contextLane`, the session recorder stamps that number onto every event it records, the
projector folds the stamps into stacked `ContextBlock.lane` rows, and the browser stacks the
context bar's rows from them. The wave was reviewed end to end (server + frontend) and the
lane itself is sound; these four records are what that review found **outside** the change's
declared scope — a deployment shape the tests never exercise, a generator limitation the
review's own regeneration tripped, a test seam neither existing file reaches, and one CSS
state the new chip never got a rule for.

Item 2 is not hypothetical: the review's regeneration of `src/shared/harness-api.ts` produced
`PatchTurnBlockRequest = unknown | unknown` and dropped the property doc blocks of
`TurnBlockWriteReceipt`, which is 13 `npm run typecheck` errors at
`src/server/api.ts:4602-4662` (the block-write route reads `body.included` /
`body.reasoningIncluded`). The shipped file was hand-restored to HEAD, so the gap in the
generator remains and the same regeneration will re-break it.

## Gap

What a maintainer cannot do today:

1. **run the lane feature with worker thread execution.** With `threadExecution: 'worker'`
   the lane a plugin raises on the worker-side harness has no route back to the record the
   server reads, so the bar stays one row and the compaction boundary is invisible — while
   the same session on the default `inline` engine paints two rows. Nothing in the product
   states this to the operator who flips the setting;
2. **regenerate the contract without losing two hand-written types.** A schema that carries
   `anyOf` (a "one of these fields is required" body) beside sibling `properties` renders as
   a union of `unknown`, and a schema's per-property `description` is never rendered at all,
   so `node scripts/generate-harness-contract.mjs` silently degrades any body of that shape —
   and a consumer cannot tell from the generated header ("Do not edit by hand") that the two
   affected blocks are in fact hand-maintained;
3. **see the whole lane path in one test.** The producer half is tested against a real harness
   with the shipped plugin, and the store half is tested against a real store with a
   hand-written lane writer; no test runs the shipped compaction plugin through a store run
   and reads the two-row bar out of the projector, so the join between them is pinned only by
   reading both files;
4. **read the lane chip in a forced-colors mode.** The chip is quiet ink on a translucent
   panel, which is exactly the combination forced-colors collapses, and it is the only cue
   that names which stacked row a segment belongs to.

## Why it is the way it is

All four are staged or documented omissions, not defects:

1. The lane is harness-record state and its only writer is the plugin api
   (`src/harness.ts` `setThreadContextLane`); `setContextLane` appears nowhere under
   `src/server/workers`, and the lane-commit op set has no lane key at all —
   `src/server/workers/lane-commit.ts:685` digests `{ status, label }` for `thread:status`,
   so a worker-side bump cannot reach the canonical record the server read walks. The read
   side says so out loud (`src/server/sessions.ts:2736-2744`, inside `contextLaneOf`), and
   the default engine is `inline` (`src/server/config.ts:42`, `:118`
   `DEFAULT_THREAD_EXECUTION`), so the shipped default is the covered shape;
2. The renderer's `anyOf` branch returns the union of its members and never consults the
   sibling `properties` (`scripts/generate-harness-contract.mjs:141-142`) — the `allOf` branch
   two lines below does (`:144-150`), and a member that carries only `required` has no type to
   render, so `baseType` answers `unknown` (`:183`). Per-property `description` is not
   rendered anywhere: `objectBody` (`:188-217`) emits keys and optionality only, and
   `jsdoc` (`:228`) is applied to the schema, not to its properties. So the property prose in
   `src/shared/harness-api.ts` is hand-authored, and `--check` was already red at HEAD
   ("harness contract types are stale", exit 1) — the file's real status quo is
   generated-plus-hand-patched, which the generated header does not say;
3. The two halves exist and are individually strict: the compaction cases drive the shipped
   plugin through a real harness and sample the lane from inside each provider request
   (`src/plugin/context-compaction.test.ts:2437-2522`), and the store cases drive a real
   `SessionStore` and read the folded bar back out of `getView`
   (`src/server/threads.test.ts:4124-4182`). They are separate because the store fixture's
   writer bumps the lane at a controllable instant mid-stream
   (`src/server/threads.test.ts:286-340`), which is what puts the boundary inside one turn;
   wiring the shipped compactor into a store fixture means a settings provider, a transcript
   long enough to cross the trigger, the pass's own extra model request, and the
   fire-and-forget continuation turn the pass ends with, none of which exists today;
4. Forced-colors rules are per-component by convention (`.context-bar-segment` has one at
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
| The `anyOf` branch ignores sibling `properties`; a `required`-only member renders `unknown` | `scripts/generate-harness-contract.mjs:141-142` vs `:144-150`, `:183`; spec body `src/server/harness.swagger.yaml:8417-8420` (`anyOf: [required: [included], required: [reasoningIncluded]]` with the real `properties:` map starting at `:8420`) |
| Per-property `description` is never rendered, so the property doc blocks are hand-authored | `scripts/generate-harness-contract.mjs:188-217` (`objectBody`), `:222+` (`jsdoc`, schema-level only); spec prose that is therefore dropped: `src/server/harness.swagger.yaml:8458-8470` |
| The regeneration's cost, measured: `PatchTurnBlockRequest` collapsed to `unknown \| unknown` and `TurnBlockWriteReceipt` lost its two property doc blocks, which is 13 `tsc` errors in the block-write route | `src/server/api.ts:4602-4620` (the two `body.<axis>` reads), `:4715-4727` (the receipt it answers with); `src/shared/harness-api.test.ts` "keeps the block-detail write body and receipt reachable through their declared keys" is the guard that now fails to compile on that collapse |
| The generated header forbids hand edits while `--check` is red at HEAD | `src/shared/harness-api.ts:1-3`; `node scripts/generate-harness-contract.mjs --check` at `a2f36d7`: "harness contract types are stale: src/shared/harness-api.ts", exit 1 |
| Producer half, no store: shipped plugin, real harness, lane sampled per request | `src/plugin/context-compaction.test.ts:2437-2522` (`lanes` sampled inside the stream, `expect(lanes).toEqual(['1', '1'])`), bump site `src/plugins/context-compaction.plugin.ts:1199-1203` |
| Store half, no shipped plugin: hand-written bump between two recorded events, folded bar asserted | `src/server/threads.test.ts:286-340` (`laneFixture`), `:4125-4182` (`store.getView(...).displays[turn.id]` two-row expectation) |
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
2. **Generator.** Teach `type()` to fold sibling `properties` into the `anyOf` result the way
   `allOf` already does (`:144-150` is the pattern), and emit per-property `description` as a
   JSDoc block in `objectBody`. Then re-run the generator and reconcile: the hand-restored
   blocks should become byte-identical to the generated output, and `--check` should go green
   for the first time. Rejected: regenerating now (it re-breaks `src/server/api.ts`), and
   re-stating the body as an inline object with `oneOf` in the spec only (the spec's
   `anyOf` pair is what the API description explains field by field, and it is correct);
3. **The joined test.** Add one store case that mounts the shipped `context-compaction`
   plugin: a settings provider with a low `contextLimit`, one submit whose prompt crosses the
   trigger, and assertions on `store.getView(...).displays[turn.id]` for the boundary turn
   (two rows) and on the continuation turn (one row, on the raised lane). Both fixtures
   already exist; the new part is the fixture that combines them;
4. **The chip.** Add the `@media (forced-colors: active)` rule for `.context-bar-lane`
   (`forced-color-adjust: none` plus a `CanvasText` border/outline, matching what
   `.context-bar-segment` does at `:8013`), and pin it the way the other style tests pin
   forced-colors rules.

## Acceptance criteria

- With `threadExecution: 'worker'`, either a compaction bump reaches
  `contextLaneOf` and the bar shows two rows, or the limitation is stated in the operator-
  facing config/capability surface — not only in a source comment;
- `node scripts/generate-harness-contract.mjs` regenerates `PatchTurnBlockRequest` as an
  object with `included` / `reasoningIncluded` and keeps the `TurnBlockWriteReceipt` property
  prose, and `--check` exits 0 with no hand edits after the regeneration;
- one test drives the shipped compaction plugin through a store run and asserts the folded
  two-row bar from `getView`, with the continuation turn asserted as one row;
- `src/frontend/styles.css` carries a forced-colors rule for `.context-bar-lane`, asserted by
  the context-bar style test.

## Tests to add

- `src/server/workers/*` (or the lane test suite in `src/server/threads.test.ts`): a lane bump
  committed from a lane worker reaches the server-side read — or the capability refusal that
  replaces it;
- `scripts/`: a generator fixture test over a schema with `anyOf` + sibling `properties` and a
  described property (the two rules above), and the existing `--check` guard turning green;
- `src/server/threads.test.ts`: the plugin→store→projector case described in **Proposal 3**
  (the compile-time guard for the degraded types already lives in
  `src/shared/harness-api.test.ts`);
- `src/frontend/ui/context-bar-style.test.ts`: the forced-colors block for the lane chip.

## Out of scope

- No lane arithmetic outside the summarize pass, and no lane REST route (0017 keeps both out);
- no change to what a lane means or to the two-source fold rule — these four items must not
  become a lane redesign;
- no forced-colors audit of the rest of the frontend: only the chip this wave added is
  recorded here;
- no re-running of the contract generator as part of closing items 3 or 4 — item 2 is the only
  one that may touch the generated file.
