# 2026-11-19 — A `sleep` tool: giving a run a way to spend time on purpose

**Date:** 2026-11-19
**Method:** one new catalogue entry, read against the shipped entry contract
(`core/tool.ts`, `core/tool-scan.ts`, `core/tool-metadata.ts:95-124`) and the two
templates the runtime already trusts for this shape — `core/agent.ts:771-794`
(`waitForRetry`, the abort-aware one-shot wait) and `harness.ts:911-941`
(`armWallClock`, the `unref()` rule — a rule this entry deliberately does **not** follow,
for the reason recorded under "Review corrections" below). No live provider was involved:
every check below is deterministic.
**Scope:** `src/tools/runtime/sleep.tool.ts` + `sleep.test.ts` (new), the generated
`src/core/tool-manifest.ts`, the startup-source inventory in
`scripts/check-package-tools.ts`, and every pinned inventory that counts package rows,
lists a registered-tool set, or restates the server session toolbox (33 files of edits —
see "Files touched"). `src/plugins/**` and `src/plugin/**` are **out of scope**: the only
line this entry put in another entry's file is one `sleep:sync` row of
`src/harness.sync-async.test.ts`'s declared-policy matrix, and the heartbeat half of the
wake (the `async-ping` plugin no longer pinging a sync-parked run) is the separate
`2026-11-19-heartbeat-async-only` entry.

---

## The report

A Manager that spawns agents in async mode can fan work out and then wants to give those
children time to land — and a run had no way to spend time on purpose. `delegate` and
`threadFork` bound a CHILD's wall clock (`DELEGATE_TIMEOUT_MS` / `FORK_TIMEOUT_MS`,
`core/agent-limits.ts:62-88`), the retry ladders bound the transport's, and every one of
those is host-set or internal: nothing inside a conversation could say "wait 30 seconds and
then carry on". The only move was to answer early, or to burn a turn on an unrelated call.

## What landed

### 1. The entry — `src/tools/runtime/sleep.tool.ts`

| Field | Shipped value | Why |
|---|---|---|
| `metadata.name` | `sleep` | One verb, the capability. |
| `metadata.parameters` | exactly ONE required `seconds`, `type: 'number'`, `minimum: 0`, `maximum: 3600`, `additionalProperties: false` | The single-property rule (`core/tool.ts` `toolParameterKey` → `resolveToolParameters`) means the live call hands `execute` the **bare number**, so `execute` reads both shapes — the same dual read as `tools/runtime/threadDelete.tool.ts:141-153`. `number`, not `integer`: a sub-second pause is a real request. |
| `visibility` | `searchable` | The house posture for harness-owned runtime rows (`knowledge.md:1509-1523`). Tags are therefore the ONLY discovery path: `sleep, wait, delay, timer, pause, seconds, time`. |
| `registration.group` / `activation` | `runtime` / `always` | Registers on every harness construction — a library `harness({})` and a server session alike (the server's `presets: false` filter drops only the `preset` group; `src/harness.test.ts:395-421` shows the row in the disabled-presets set). |
| `registration.mode` | `sync` | The user's ruling, and the behaviour needs it. A sync completion joins its assistant message's sync group (`harness.ts:1924-1928`), so **the settled pending call is what re-enters the parked run** — the timer expiring IS the wake. No core change, no new event, no reliance on the liveness heartbeat. |
| `registration.order` | `145` | The deliberate gap between `actionRequest` (140) and `toolCancel` (150): the pause is declared before the control that can cut it short. |
| `registration.listed` / `alwaysDeclared` | `true` / `false` | The server can run a sleep directly (no caller lineage, no session state), so `sessionBound` is deliberately absent from the literal. |

### 2. The wait

`execute` validates BEFORE building the promise (a bad argument throws synchronously, the
house shape in `threadDelete`/`timeNow`), arms `setTimeout(Math.round(seconds * 1000))`
**and does not un-reference it** (the one deliberate exception in this runtime — M1 below),
and follows `core/agent.ts:771-794` exactly: an already-aborted signal arms nothing, the
abort listener clears the timer, and each path removes the other's resource, so neither a
listener nor a handle survives the wait.

Cancellation **returns** rather than throwing: `context.signal` is the per-call controller
(`types/index.ts:3104-3119`, linked in `core/scheduler.ts:183-192`), so both `toolCancel`
and a run stop land here, and the answer is data — `{ sleptMs, sleptSeconds,
requestedSeconds, cancelled, reason?, message }` with the time ACTUALLY waited. Who reads
that data is narrower than the entry's first wording claimed — M2 below.

`Math.round` is a float guard, not a rounding policy: `0.1 * 1000` is
`100.00000000000001` in IEEE-754, and an entry that armed THAT could never be pinned as
"exactly 100 ms".

### 3. The bound

`0 … 3600` seconds, stated TWICE — as the published schema bound and as the enforced
`SLEEP_MAX_SECONDS` — because a runtime entry keeps zero captured local dependencies and
cannot value-import `core/agent-limits.ts`. The ceiling is the one every model-settable
wall clock shares (`MODEL_TIMEOUT_MAX_MS = 3600000`, `core/agent-limits.ts:81`), and
`sleep.test.ts` asserts `SLEEP_MAX_SECONDS * 1000 === MODEL_TIMEOUT_MAX_MS` plus
schema-bounds-equal-constants, which is what stops the three numbers drifting apart
(docs/runtime-tools.md:206-222: the published schema is the door, never wider than the check).

## Files touched

| File | Change |
|---|---|
| `src/tools/runtime/sleep.tool.ts` | New entry: `metadata` + `registration` + `execute`, plus the `sleep = tool({ … })` callable export (`tools/descriptors.ts:472` selects `module[name]` in the scanner-less/browser build). The M1/M2 pass touched only the handle's ref state (the `unref()` is gone), the published description, the cancellation result text and the rationale comments — no new behaviour, and no configurable ceiling was reintroduced. |
| `src/tools/runtime/sleep.test.ts` | New: 18 cases at first landing, **19** after the M1/M2 corrections (the `unrefs: 0` pins, the referenced-handle/active-resources case, the description and result-text pins). Exact values throughout. |
| `src/core/tool-manifest.ts` | Regenerated — 33 rows → 34 (`yarn tools:manifest`, i.e. `vite-node scripts/generate-tool-manifest.ts`). The M2 reword needed a SECOND re-render of the same file: the generated table embeds each entry's published `description`, so editing that string without re-rendering leaves gate 1 of `yarn typecheck` / `yarn test` failing on `tool-manifest.ts is stale` (see the M2 note below). |
| `scripts/check-package-tools.ts` | `STARTUP_SOURCE_ENTRIES.sleep = 'tools/runtime/sleep.tool.ts'` (`:180-189`). An `activation: 'always'` runtime row registers from source at startup, so a missing row is the silent coverage loss that header warns about. |
| `src/core/tool-discovery.test.ts` | Folder listing + the two registration-order lists + the 33→34 row count. |
| `src/core/tool-discovery.browser.test.ts` | 33→34 rows, 23→24 runtime rows. |
| `src/tools/descriptors.test.ts` | `ALL_PACKAGE_NAMES`, the stale-manifest count (32→33 of 34), `RUNTIME_DESCRIPTORS`. |
| `src/tools/descriptors.browser.test.ts` | 33→34 rows, `RUNTIME_DESCRIPTORS`. |
| `src/tools/descriptors.scan-failure.test.ts` | 33→34 rows. |
| `src/harness.test.ts` | The `presets: false` registered-tools list gains `sleep` (after `threadFork`, before `toolCancel`). |
| `src/harness.creation.test.ts` | The registered list gains `sleep`, and the created-tool budget comment reads 48, not 47 (one more harness-owned baseline entry). |
| `src/harness.discovery.test.ts` | The tag vocabulary (`sleep`, `wait`, `delay`, `timer`, `pause`, `seconds`, `time`), the seedable-runtime set, the declared/seeded/withheld lists, the snapshot `enabled` list and the newest-first `discoveredTools` list. Largest blast radius of any file here: a new searchable tag is a new query needle. |
| `src/harness.already-available.test.ts` | Its `SEARCHABLE_TAGS` vocabulary gains the seven new tags. Its `enabled: []` pins are why the description is worded the way it is — see the description rule below. |
| `src/harness.task.test.ts`, `src/harness.records.test.ts`, `src/harness.webfetch.test.ts` | Each pins the full registered-tool list of a quiet harness; `sleep` slots between `threadFork` and `toolCancel` (order 145). |
| `src/harness.sync-async.test.ts` | The per-entry policy matrix gains its `sleep:sync` row — the row that keeps a stated `mode: 'sync'` from drifting from the heartbeat gate the other 2026-11-19 entry builds on it. |
| `src/core/metadata.ownership.test.ts`, `src/core/metadata.branches.test.ts`, `src/structure.test.ts`, `src/harness.tool-list.test.ts` | Verified, not edited (the first two project only always-declared rows, and `sleep` is not one). |
| `src/server/api.test.ts`, `src/server/service-start.test.ts`, `src/server/commands.test.ts`, `src/server/harnesses/{presets,registry,restore}.test.ts` | Server-side projections of the catalogue: each row list and count gains `sleep`. |
| `src/server/api-session-tool-writes.test.ts`, `src/server/session-reset-toolbox.test.ts`, `src/server/session-tools-deployment-deny.test.ts`, `src/server/restore-enabled-tool-prune.test.ts` | The session toolbox fixtures (`ENABLED_NAMES` 23→24, `ROW_ORDER` 33→34, `SEEDED_NAMES` 23→24) and every derived count and comment in those files. See the server blast radius below. |
| `src/server/workers/lane-tool-settings.test.ts` | The lane replica's request-toolset list gains `sleep` after `actionRequest`. |
| `docs/tasks/2026-11-19-runtime-sleep-tool.md` | This entry, plus its index row in `docs/tasks/README.md`. The M1/M2 pass added the "Review corrections" section and restated the rows above; it deliberately did **not** touch `docs/tasks/README.md`. |

### The server blast radius (the part that is not obvious)

A new `activation: 'always'` package row is not just one more line in the generated manifest: it joins the **server session toolbox**, and the toolbox is pinned as an exhaustive population in four `src/server/**` fixtures. The measured shape of a fresh keyless session, asserted by the probe in these tests:

| Axis | Before | After | Why |
|---|---|---|---|
| Toolbox rows | 33 | 34 | Every registered, switchable name is a row the operator can see. |
| `origin: 'discovered'` (holds a `maxEnabledTools` slot) | 23 | 24 | `sleep` is searchable and NOT always-declared, so the seed puts it in the capped set — it consumes a slot, exactly like `read`/`shell`. |
| `origin: 'catalogue'` (`SLOTLESS_NAMES`) | 10 | 10 | Unchanged. `toolCancel` stays the only slotless, unprotected row. |
| `protected` (`visibility: 'core'`) | 9 | 9 | `sleep` registers `searchable`, so a conversation may switch it off AND un-register it. |
| `declared` | 8 | 8 | `alwaysDeclared: false` keeps it out of every request until `toolRequest` asks. |

That distinction is load-bearing for anyone adding a runtime row: the two axes (`protected` vs `slotless`) are asserted separately in `api-session-tool-writes.test.ts:1005-1011` precisely because deriving one from the other breaks, and a new searchable row moves the capped count without moving either flag.

### The description is a discovery surface

`core/discovery.ts:128-141` (`scoreTool`) scores a **description substring hit** at 1 point, so every word in `metadata.description` is also a query needle. The shipped wording therefore avoids `cancel…` and `delegat…` on purpose: with them, a `toolRequest('cancel')` or `('delegate')` query pulled `sleep` into the result set, and `src/harness.already-available.test.ts` pins that set EMPTY (both names are declared rows, so they answer `alreadyAvailable` rather than enabling a third tool). The fix belongs in the entry's wording, not in the pinned expectations. That constraint still binds every rewording — M2 below had to satisfy it while fixing an honesty bug in the same sentence.


## Review corrections (same day, after the entry shipped)

Two measurements against the built entry overturned parts of the first implementation. The reviewer's probes are in `Temp/review-sleep/`; the probes that re-ran them after the fixes are in `Temp/sleep-c1/`. Both corrections are in the entry and its test — nothing in `src/harness.ts`, `src/core/**` or `src/plugins/**` moved.

### M1 (Major) — the `unref()`-ed timer let an idle host exit mid-sleep

The entry inherited the house rule and called `timer.unref?.()`. That rule is correct for the **background** timers that own it — the wall-clock bounds (`harness.ts:911-941` `armWallClock`: "Node keeps the process alive for a pending timer; a bound must not") and the liveness heartbeat (`plugins/async-ping.plugin.ts:355-359`, under "TIMERS MUST NEVER HOLD THE PROCESS OPEN": a heartbeat that held the loop would hang a CLI after the caller stopped caring) — because in both of those the timer is not the awaited work. For a sleep the wait **is** the awaited work, so while it runs the wait is the only thing the host is waiting on, and an un-referenced handle let an idle process exit inside the pause.

| Probe | Shape | Measured before the fix | Measured after the fix |
|---|---|---|---|
| `review-sleep/probe21.ts` | top-level `await executeTool('sleep', { seconds: 4 })`, nothing else on the loop | printed "before", **never** "after" — exit 0, no warning (reviewer measurement) | `P21 after the awaited sleep 4005 {"sleptMs":4005,"sleptSeconds":4.005,"requestedSeconds":4,"cancelled":false,…}`, exit 0 |
| `review-sleep/probe6.ts` | same shape, run not awaited | silent exit (reviewer measurement) | runs to completion (`D1 … elapsed ms = 610`, `D2 … 604`, "reached end of probe") |
| `review-sleep/probe7.ts` | same plus ONE plain referenced `setInterval` | woke at 613 ms — the control that pinned `unref()`, not the harness, as the cause | unchanged (610 ms; a ref-ed handle was already present) |
| `sleep-c1/probe-hold.ts` | awaited 2 s sleep, then an unawaited 1 s sleep, then `dispose()` | n/a | `elapsed = 2002 ms` with the full payload; the unawaited wake landed at 1001 ms; the process still exits on its own after `dispose()`, so the hold is not a leak |

**The fix:** the sleep's handle stays **referenced** for the length of the wait, and the entry's header names the two background-timer cases it diverges from. Clearing on settle and on abort is unchanged, so nothing outlives the sleep. `sleep.test.ts` pins it three ways: the stub clock now asserts `unrefs: 0` on every armed delay; the new real-timer case ("arms a REFERENCED handle while the wait runs, and releases it on both settle paths") wraps — never replaces — the real `setTimeout` and asserts `hasRef() === true` plus `process.getActiveResourcesInfo()`'s `Timeout` count at `baseline + 1` while the wait runs (an un-ref-ed handle is **absent** from that list, which is exactly what the old code produced); and both settle paths bring the count back to baseline — synchronously after `controller.abort()`, and after the fire. The pre-existing fake-clock pins still prove a cancelled sleep leaves `vi.getTimerCount() === 0`.

### M2 (Major) — the description promised a cancelled-call payload the model never sees

The shipped last sentence read: *"… ends the wait early rather than failing it: the result then reports the seconds actually slept and says the timer was cleared."* That is only true of what `execute` **returns**. Measured on the live, model-facing transcript:

| Door | What the model's tool message actually contains |
|---|---|
| `toolCancel` of the parked call | `Tool call "sleep" (s1) was cancelled before it completed; no result is available.` (`harness.ts:10305`). The entry's `{ sleptMs, sleptSeconds, requestedSeconds, cancelled: true, reason, message }` is **discarded** — `toolCancel` has already released the run and ignores a result that arrives afterwards (run settled 4 ms after the steer, ~26 s early). `review-sleep/probe20.ts`, `sleep-c1/probe-transcript.ts` |
| `stopThread` / run-level abort | `Tool execution was cancelled or interrupted before it produced a result, so this call has no recorded outcome. The tool may or may not have run; re-issue the call if its result is needed.`, and the run **rejects** with `Thread "agent:main" was stopped.` (723 ms into a 30 s sleep). `sleep-c1/probe-stop.ts` — which also exits immediately afterwards, proving the parked timer was cleared |
| timer expiry (the normal case) | the full payload IS delivered: `{"sleptMs":401,"sleptSeconds":0.401,"requestedSeconds":0.4,"cancelled":false,"message":"Slept for 0.401 seconds. The timer expired and the run is awake again."}`. `sleep-c1/probe-transcript.ts` |
| a direct caller (`executeTool`, the standalone callable) | the full payload, on every door — which is why the payload is still built |

**The fix is in the entry, not the core.** The sentence now reads: *"A stop of the run, or a request to abandon this call, ends the wait early rather than failing it: the timer is cleared and nothing waits out the rest of the delay."* — a claim the entry can honour on all three doors, with no promise about what the transcript reports. It keeps the four facts of the user's contract (the single `seconds` argument, the `0 … 3600` bound, fractional seconds honoured, "the timer expiring is what wakes the run"), and it keeps the two discovery-hostile substrings (`cancel`, `delegate`) out. The cancellation **result text** was scoped the same way: "the timer was cleared and nothing waits out the rest of the delay" replaces "nothing else is pending", which overreached into work this entry does not own. `sleep.test.ts` pins the description verbatim, those four facts, the new sentence, and the absence of the old promise.

**A published-description edit is also a manifest edit — the gate the first M2 pass missed.** `src/core/tool-manifest.ts` is GENERATED: `core/tool-scan.ts` renders every entry's `metadata` into the table, description included, and `scripts/generate-tool-manifest.ts --check` (gate 1 of both `yarn typecheck` and `yarn test`) compares the committed table against a fresh scan. The M2 pass edited the entry and re-ran the entry and catalogue suites — all green — but never re-rendered the file, so `yarn typecheck` died at gate 1 with `tool-manifest.ts is stale` (exit 1; `plugins:manifest:check` and `tsc` never ran), `yarn test` died at the same gate before vitest started, and `src/core/tool-discovery.test.ts:498` (`expect(committed).toBe(renderManifest(fresh))` — byte-identical) and `:518` ("matches the live scan field for field") failed with that one description line as the only diff. The remedy is the canonical regeneration, not a hand edit: `yarn tools:manifest` → `wrote src/core/tool-manifest.ts (34 descriptors)`, and the resulting diff is exactly ONE line (`:1760`, the `sleep` row's `metadata.description`) in an unchanged 2,885-line file — row count 34 before and after, no loader case moved, the `seconds` sub-description untouched (M2 did not change it), and the concurrent workstream's `actionRequest` row verified byte-identical across the two copies (same SHA-1 over the whole 73-line row). Rule for the next editor: any change to `metadata` or `registration` in an entry file must be followed by `yarn tools:manifest`, then `yarn typecheck`.


## Checks that close it

| Check | Command | Result |
|---|---|---|
| Manifests are current, and types are clean | `yarn typecheck` (`tools:manifest:check` → `plugins:manifest:check` → `tsc --noEmit`) | `tool-manifest.ts is current (34 descriptors).`, `plugin-manifest.ts is current (3 plugins).`, `tsc --noEmit` silent. **This gate FAILED between the M2 reword and its manifest re-render** (exit 1 at gate 1, `tool-manifest.ts is stale`, so `plugins:manifest:check` and `tsc` never ran) — the follow-up row below is the fix, and the M2 section explains why a description edit is a manifest edit |
| The startup source record exists with no captured dependencies | `yarn test:package:tools` (`vite-node scripts/check-package-tools.ts`) | `package tools: 21 check(s) OK`, `startup registration exposes source records … {"entries":14}` |
| The entry itself | `yarn vitest run src/tools/runtime/sleep.test.ts` | 18 passed as first landed; **19 passed** after the M1/M2 corrections, on three consecutive runs (the new case reads live handle state, so it was re-run to rule out a flake) |
| The catalogues that count rows, the registered surface, the tag vocabulary, the declared-policy matrix | `yarn vitest run src/tools/descriptors{,.browser,.scan-failure}.test.ts src/core/tool-discovery{,.browser}.test.ts src/tools/runtime/sleep.test.ts src/harness.{test,creation,discovery,tool-list,already-available,sync-async,task,records,webfetch}.test.ts src/structure.test.ts src/core/metadata.{ownership,branches}.test.ts` | 18 files, 277 passed |
| The server projections of the catalogue | `yarn vitest run src/server/api.test.ts src/server/service-start.test.ts src/server/commands.test.ts src/server/harnesses/{presets,registry,restore,catalogue,toolbox-sources,tools}.test.ts src/server/workers/{lane-worker,capability}.test.ts src/harness.tool-folders.test.ts src/harness.self-modifying.test.ts` | 13 files, 314 passed |
| The session toolbox population (rows, cap slots, prune, lane replica) | `yarn vitest run src/server/api-session-tool-writes.test.ts src/server/session-reset-toolbox.test.ts src/server/session-tools-deployment-deny.test.ts src/server/restore-enabled-tool-prune.test.ts src/server/workers/lane-tool-settings.test.ts` | 5 files, 62 passed |
| The frontend toolbox | `yarn vitest run --config src/frontend/vitest.config.ts src/frontend/tools-tab.test.ts src/frontend/tool-presets.test.ts` | 2 files, 25 passed — NO edit needed (the pane enumerates rows, it does not pin the population) |
| The whole package suite | `yarn test` | NOT run here; the orchestrator owns it. Every file this entry can break is named in the rows above (38 files, 678 tests). Its FIRST gate (`tools:manifest:check`) is the one the M2 re-word tripped, so the suite could not even reach vitest until `yarn tools:manifest` re-rendered the table — see the two follow-up rows. |
| The package integrity gates a new source entry can move | `yarn test:package` · `yarn test:package:files` · `yarn test:package:runtime` · `yarn test:contract` | `package types:` consumers OK / 0 undeclared imports · 4 passed · `package runtime: 11 check(s) OK` (a real `startHarnessServer` session registers the row) · 7 passed |
| The M1/M2 correction, in the suite | `yarn vitest run src/tools/runtime/sleep.test.ts src/harness.already-available.test.ts src/harness.discovery.test.ts src/harness.sync-async.test.ts` (cwd `packages/underload/harness`) | **4 files, 77 passed** |
| The M1/M2 behaviour, out of process | `yarn vite-node <probe>` from `packages/underload/harness` — `Temp/sleep-c1/probe-hold.ts` (does an idle host survive an awaited wait), `probe-transcript.ts` (both model-facing doors), `probe-stop.ts` (the `stopThread` door), plus the reviewer's `Temp/review-sleep/probe21.ts`, `probe6.ts`, `probe7.ts`, `probe20.ts` | every "measured after the fix" cell of the two correction tables above, quoted verbatim there |
| M2 follow-up — regenerate the manifest, and prove the diff is one line | `yarn tools:manifest` (`vite-node scripts/generate-tool-manifest.ts`), then a `diff` against the pre-regeneration copy saved in `Temp/sleep-c1/` | `wrote src/core/tool-manifest.ts (34 descriptors)` — diff is exactly **1 changed line** (`:1760`, the `sleep` row's `metadata.description`) in a 2,885-line file that keeps the same length and the same 34 rows; no loader case, count or other row moved, and the concurrent workstream's `actionRequest` row is **byte-identical** (same SHA-1 over its 73-line block in `ar.before` / `ar.after`). Artifacts: `Temp/sleep-c1/{tool-manifest.before.ts,manifest.diff,ar.before,ar.after}` |
| M2 follow-up — the gates the stale manifest was failing | `yarn typecheck` · `yarn test:package:tools` · `yarn vitest run src/core/tool-discovery{,.browser}.test.ts src/tools/descriptors{,.browser,.scan-failure}.test.ts src/tools/runtime/sleep.test.ts src/core/metadata.ownership.test.ts src/harness.metadata.test.ts` · `yarn vitest run --config src/frontend/vitest.config.ts src/frontend/tools-tab.test.ts` | exit **0** with all three gates reporting current manifests and `tsc` silent · `package tools: 21 check(s) OK` · **8 files, 83 passed** (the fresh-scan pins at `tool-discovery.test.ts:498` and `:518` included) · **1 file, 20 passed** (the jsdom canvas warning is unrelated noise). Logs: `Temp/sleep-c1/{typecheck,package-tools}.log` |

## What the tests pin, and why each half exists

- **The armed delay, proven twice.** Once by reading the delay passed to `setTimeout`
  through the `src/plugin/async-ping.test.ts:69-120` stub — which since M1 pins `unrefs: 0`,
  i.e. the handle is never un-referenced — and once on vitest's own clock, where the call is
  still pending at 2499 ms and settles at 2500 ms. The second proof is the one that would
  catch an off-by-one the stub could echo back, and it is where `vi.getTimerCount() === 0`
  proves a cancelled timer is gone rather than merely ignored.
- **Both argument shapes**, through the same entry: the unwrapped number the live path
  delivers and the `{ seconds }` wrapper a hand-built context can carry.
- **Listener accounting** on a signal double (this Node build's `AbortSignal` exposes no
  `listenerCount`), so "the listener is removed on both paths" from
  `core/agent.ts:761-766` is asserted, not hoped for; and a re-dispatched abort listener
  must not clear the timer twice.
- **Real timers, deliberately — three cases.** Handle state and loop-holding are exactly
  what a fake clock cannot falsify. One case waits real time to prove the pause resolves and
  proves a real cancel of a 30 s wait settles in well under 5 s; one asserts the M1 fix on
  the platform's own terms (`hasRef() === true`, `Timeout` count at `baseline + 1` while the
  wait runs, back to `baseline` after an abort and after a fire); one drives the standalone
  callable, the only path with no signal at all. Elapsed real milliseconds are the only
  values in the file that are not known in advance, and only those are range-checked.
- **The refusal table, not eleven loose assertions.** `sleep.test.ts:577-639` drives one
  case from a table of bad arguments, each row pinning the exact message AND that no timer
  was armed — the message is the model's only repair instruction, so it is a contract.
- **The description's forbidden words AND its promise.** `sleep.test.ts` asserts the
  description contains neither `cancel` nor `delegate` (the guard that keeps the
  `already-available` pins honest when someone rewords the entry — see the discovery rule
  above), pins it verbatim, pins the four contract facts a caller needs (`` `seconds` ``,
  `0 to 3600 (one hour)`, a honoured fraction, "the timer expiring is what wakes the run"),
  and since M2 pins the replacement sentence plus the ABSENCE of the old "the result then
  reports the seconds actually slept" promise.
- **The ceiling, pinned from both sides.** The published schema bound, the enforced
  constant and `MODEL_TIMEOUT_MAX_MS` are asserted equal, and the module's import
  specifiers are pinned so the entry cannot quietly grow a dependency and break its empty
  startup source record.

## Not tested / deliberately not done

- **No live-provider session proof.** Everything above is deterministic and offline. The
  end-to-end shape the report describes — a Manager calling `sleep` between `delegate`
  calls and resuming on the timer — has not been exercised against a real model.
- **`packages/typecrate/**` was not touched.** Any Rust-side mirror of the tool surface is
  out of scope for this entry; if one exists, it still lacks a `sleep` row.
- **The heartbeat half is another entry.** `src/plugins/async-ping.plugin.ts` stopping its
  ping against a sync-parked run, and the README wake prose, landed the same day in
  `docs/tasks/2026-11-19-heartbeat-async-only.md`. What THIS entry owns in that file is one
  row of `src/harness.sync-async.test.ts`'s declared-policy matrix — `sleep:sync` — because
  the gate the other entry builds keys off a STATED mode, and an absent key would let the
  declaration drift from the behaviour it depends on.
- **No `setTimeout` was added to `src/harness.ts`.** `src/harness.delegation.test.ts:3491-3513`
  fails if one appears there, so the timer lives entirely inside the entry.
- **No barrel line and no `PRESET_TOOLS` row** (`knowledge.md:3029-3039`: adding a tool is
  one file), so `sleep` is reachable through the catalogue, `toolRequest` and the server's
  direct-call list — not as a named `@underload/harness` import.
- **The compatibility facade gained nothing, on purpose.** `src/core/metadata.ts` and
  `src/core/index.ts` are untouched: that facade projects the generated table and does not
  re-export per-entry name constants (there is no `KNOWLEDGE_NAME` line either), so adding
  one here would be a new surface rather than a filled gap.
- **`knowledge.md:1376-1394` (the tool-namespace table) has no `sleep` row.** That table is
  prose, not a pin — no test reads it — and `knowledge.md` is outside this entry's file
  scope. Whoever next edits it should slot `sleep` beside the bare verbs.
