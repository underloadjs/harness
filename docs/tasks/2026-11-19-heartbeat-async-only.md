# 2026-11-19 — The heartbeat pings `async` work only: what the plugin had to learn

**Date:** 2026-11-19
**Method:** the reported behaviour, then the plugin read line by line against the working
tree; the decisive fact about the tool registry was settled by a probe, not by reading
(`Temp/coding/probe-registry-mode.ts`, run with `yarn vite-node`, output quoted in Finding
1), and every claim below is pinned by a test that was run.
**Scope (all landed):** `src/plugins/async-ping.plugin.ts` (the trigger rule, both decision
points, the sweep, the header), `src/plugin/async-ping.test.ts` (the rule block),
`src/harness.sync-async.test.ts` (the runtime half: turn counts, `wakeup` frames, timer
hygiene), `README.md` (the loop prose and the UI pending line), `docs/plugins.md` (the
`async.*` api bullet). **Not touched, deliberately:** `src/harness.ts`,
`src/core/scheduler.ts`, `src/types/index.ts`, `src/plugin/manifest.ts` (generated) — see
Tasks for the two follow-ups that need one of them.

---

## The request

The shipped `async-ping` plugin re-wakes an agent every `wakeIntervalMs` while ANY tool
call of that agent is pending, which means an agent parked behind a long **sync** call
(e.g. `sleep`, or a `read`/`edit`/`fetch` that has not returned) spends a model turn on a
`status:'pending'` placeholder every ten minutes. A sync call cannot use that turn: its
own settlement is already guaranteed to re-enter the model, because the completion joins
its message's sync group and the LAST member settling buys the turn. Only an `async`
completion can land while nobody is looking, and only for it is the heartbeat load-bearing.

The rule now implemented: **an agent is pinged only while at least one of its pending
calls resolves to `mode: 'async'`.**

## Findings

### 1. The tool registry does NOT tell a plugin the mode of a shipped tool — the discovery table does

| Fact | Evidence |
|---|---|
| `HarnessPendingTool` is `{ callId, name, elapsedMs }` — no policy, so a name→mode lookup is unavoidable | `src/types/index.ts:354-358` |
| `api.tools` IS the live registry a plugin can read | `src/types/index.ts` (`HarnessPluginApi.tools`), bound to the harness's own `tools` record at `src/harness.ts:2190` |
| **But a discovered built-in's published definition carries no `mode` at all.** Its entry states the policy in its `registration` literal (`ToolRegistration.mode`, `src/core/tool-metadata.ts:99-105`); the scanner puts it on the descriptor (`DiscoveredTool.mode`, `src/core/tool-metadata.ts:142-146`); the harness then binds it to the definition through a **private WeakMap** (`modeDefinitions`, `src/harness.ts:1918`, set at `:3945`, read by `effectiveToolMode` at `:1927-1928`) | probe output below |
| Probe (`Temp/coding/probe-registry-mode.ts`, a plugin reading `api.tools[name].mode` on a `presets: true` harness): `shell: inRegistry=true mode=undefined`, `threadFork: inRegistry=true mode=undefined`, `read: inRegistry=true mode=undefined`, `sleep: inRegistry=true mode=undefined`, `toolCancel: inRegistry=true mode=undefined`; a host `tool({ mode: 'async' })` → `hostAsync: inRegistry=true mode=async`. Also: `delegate`, `actionRequest`, `fetch`, `search` are not in the registry at all (activation-gated), so a name-based miss and a built-in hit look identical through `api.tools` | `yarn vite-node Temp/coding/probe-registry-mode.ts` |
| So a predicate of the shape "`definition.mode === 'async'`, anything else is sync" — the obvious reading — classifies **every** shipped async tool as sync. Two existing end-to-end tests caught exactly that regression while it was being written: `threadFork` and `actionRequest` stopped being woken | `src/harness.background.test.ts:1110` and `:1184` ("announces and pings a board whose only work is a threadFork branch / an actionRequest answer"), both failing before the table lookup landed |

**The predicate that landed** (`src/plugins/async-ping.plugin.ts:288-302`, four steps,
documented at `:11-92`): definition-declared mode → else the GENERATED row
(`BUILTIN_TOOL_DESCRIPTORS`, `src/core/tool-manifest.ts:37`, indexed once into
`DISCOVERED_MODES` at `src/plugins/async-ping.plugin.ts:188`) → else `'sync'` for a registry
hit with no row (`DEFAULT_TOOL_MODE`, `src/core/tool.ts:85`) → else, for a name the registry
cannot answer for, **treat as async and wake anyway**. That last asymmetry is deliberate:
an unanswerable policy must over-ping (one extra turn), never under-ping (silently losing
the hang-visibility the heartbeat exists to provide). Pinned at
`src/plugin/async-ping.test.ts:501` (`async-ping async-only trigger rule`) and
`src/harness.sync-async.test.ts:896`.

### 2. `async.drained` cannot express "the async work is gone", so the tick must self-drop

| Fact | Evidence |
|---|---|
| The drained transition fires only when the agent's WHOLE board is empty | `src/harness.ts:10482-10487` (`if (pending.length === 0 && hookBus.has('async.drained'))`) |
| Consequence: a timer armed for an async call is still armed when that call settles and a sync call from the same message remains, and no hook fires for that transition | the emit site above, plus the per-call announce at `src/harness.ts:11155` |
| So `tick` re-reads the live board and, finding no async entry, **drops its handle — no wake, no re-arm**. Without that, a sync-parked run would be pinged forever. The next `async.pending` re-arms, so the plugin self-heals | `src/plugins/async-ping.plugin.ts:391` |
| `arm` is filtered the same way, from the `async.pending` payload — the only board view available before `scheduler.schedule()` (the task may settle synchronously) | `src/plugins/async-ping.plugin.ts:406` |
| `sweepDrained` now also releases a timer whose board holds only sync work: that heartbeat is provably pointless, and an eager sweep beats waiting a whole interval | `src/plugins/async-ping.plugin.ts:323-328` |
| Mixed boards are NOT suppressed: one async + one sync still wakes, because the async completion is what releases the parked sync gate (`run.syncWakers`, `src/harness.ts:9403-9410`) | pinned at `src/plugin/async-ping.test.ts:540` and `src/harness.sync-async.test.ts:969` |

### 3. What gating removes: the agent's autonomous `toolCancel` window while parked

| Fact | Evidence |
|---|---|
| There is no automatic hard tool timeout anywhere in the loop; a hanging call ends through an explicit cancel or the tool's own bound | `knowledge.md:5311-5322` |
| The periodic wake was therefore the only event that gave a parked run a model turn on its own — the only autonomous chance to notice a hung call and cancel it | `src/harness.ts:9642-9681` (`onWake` → the `wakeup` frame → `markRunDirty`), which is also what releases a parked gate (`:9403-9410`, park at `:9458-9484`, loop gate at `:14266`) |
| **Still available to a sync-parked run:** steering input and any incoming message (the park is a park, never a block, and the turn it buys can call `toolCancel`), a thread stop, and aborting the caller's `signal` — all three release the park | `src/harness.sync-async.test.ts` ("releases a parked batch gate when the run is aborted"), pinned before and after this change |
| **Practical consequence, stated plainly:** a sync call with no bound of its own (`read`, `edit`, `fetch`, `search`, `webdownload`, `threadDelete`, `sleep`) that wedges now keeps the run parked until the HOST acts. The agent does not get a turn in which to notice. Tools that carry their own bound are unaffected — `shell.timeoutMs`, `fetch`'s, `delegate.timeoutMs` — and an `async` call keeps its heartbeat, so the shipped long-running surface is untouched | README: the "The trade-off this makes" bullet under the loop section; the same sentence in `docs/plugins.md:834-852` |

### 4. Two disclosed divergences from `effectiveToolMode` — row 1 over-pings; row 2 does NOT (corrected by the addendum below)

| Case | Harness | Plugin | Direction |
|---|---|---|---|
| A host REPLACES a built-in wire name with a definition that declares no mode (`addTool({ shell })`, or `harness({ tools: { shell } })`) | `modeDefinitions` never sees the replacement, so the effective mode is the `'sync'` default (`src/harness.ts:1924-1928`, pinned at `src/harness.sync-async.test.ts:279`) | the stale GENERATED row says `async` → keeps pinging | over-ping: one extra turn. Pinned as an observation at `src/harness.sync-async.test.ts:931` |
| A host `toolFolders` entry (`origin: 'folder'`) — **corrected the same day; as first written this row claimed "falls through to wake anyway → over-ping", which was measured false** (see the addendum) | it does NOT run async: `modeDefinitions` never sees a folder entry (folders register through the ordered loop at `src/harness.ts:6008-6019` → `registerAtStartup:3102`, while the only bind site is `registerDescriptor:3945`), so the published definition answers `.mode === undefined` and the effective mode is the `'sync'` default — measured: the run PARKS, 2 model requests | the package table holds `origin: 'package'` rows only, so the name is a registry HIT with NO row → step 3, `'sync'` → **no wake** — measured: 0 wakeups | **no divergence today: plugin and harness agree (both sync).** The exposure is LATENT and points at **under-ping**, the unsafe direction: discovery already publishes that row as `mode:'async'`, so the moment core honours it the harness runs async while step 3 still answers `'sync'` |

A replacement that DECLARES a mode is answered correctly by step 1, in both directions.

## Tasks

1. **Land the rule.** Done 2026-11-19: plugin header `src/plugins/async-ping.plugin.ts:11-92`,
   predicate `:288-302`, `arm` `:406`, `tick` `:391`, sweep `:323-328`. Closing check:
   `yarn vitest run src/plugin/async-ping.test.ts` (31 tests) and
   `yarn vitest run src/harness.sync-async.test.ts`.
2. **Give the plugin one accessor for the effective mode, so the generated-table lookup can
   go away.** STILL OPEN (2026-11-19), and it needs `src/types/index.ts` + `src/harness.ts`
   (out of this change's scope): `api.tools` answers for definitions only, which is why the
   plugin must
   duplicate `effectiveToolMode`'s precedence in the wrong place. The right shape is a
   plugin-visible `api.toolMode(name): ToolMode` reading the same WeakMap + `mode` +
   default chain as `src/harness.ts:1927`; Finding 4's two divergences disappear with it.
   Recorded meanwhile as an ACCEPTED, DOCUMENTED limitation — directions and measurements in
   the addendum ("Task 2" below).
   Closing check when built: the plugin drops its `BUILTIN_TOOL_DESCRIPTORS` import, and
   `src/harness.sync-async.test.ts:931` (the over-ping divergence) flips to expecting silence.
3. **Re-pin the plugin's own description.** CLOSED 2026-11-19, in the follow-up pass — see
   "Task 3" in the addendum for the new sentences and the four mirrors carried with them.
   It was deliberately deferred here originally: `metadata.description`
   still said "with the calls that are still running" and did not mention the async
   filter, and editing it means regenerating the GENERATED `src/plugin/manifest.ts`
   (`yarn vite-node scripts/generate-plugin-manifest.ts`) and re-pinning
   `src/plugin/manifest.test.ts` — neither of which this change was allowed to touch, so the
   operator-facing sentence was one step behind the behaviour. Closing check, met: the manifest
   check is green with the new sentence and `src/plugin/manifest.test.ts` matches it.
4. **`knowledge.md:700` still describes the plugin as "the recurring wake while background
   calls are pending".** CLOSED 2026-11-19, and CLOSED WITHOUT AN EDIT HERE — the line was
   re-read, not written (`knowledge.md` is not a file this change owns; it has an external
   editor), and it now names the async filter. See "Task 4" in the addendum for the exact
   current text.
   Closing check, met: that line names the async filter.

## Not tested

- A REAL wedge: no test hangs a filesystem or a socket. Findings 1-2 are exercised with
  deferred promises; the "hung `read` stays parked until the host aborts" sentence in
  Finding 3 is an argument from the park/release contract, not an observation of a stall.
- The browser/compat graph importing `../core/tool-manifest` from a plugin: the module is
  data plus lazy `import()` loaders, but no frontend test was run for this change
  (`yarn test:frontend` was not part of the scoped checks).
- No live provider, and no `presets: false` host that swaps the shipped plugin out while
  relying on the old "any pending call" behaviour — that override path is
  `src/harness.background.test.ts` "produces no wake and no timer when the ping plugin is
  replaced", which stays green because it replaces the plugin wholesale.

---

## Addendum (2026-11-19, follow-up pass C2) — Finding 4's folder row corrected; task 2 recorded as an accepted limitation, tasks 3-4 closed (and task 3's last two mirrors re-pinned)

### Finding 4, row 2: a folder entry is NOT an over-ping case — it is the opposite (measured)

The Finding 4 row above ORIGINALLY read: a `toolFolders` entry (`origin: 'folder'`) "falls
through to 'wake anyway'" — i.e. over-pings. That claim is **false on this tree** (the row
has been rewritten with the measured facts), and so was the plugin header that repeated it
("`origin: 'folder'` … so it pings"), which has been corrected too. Re-running the
reviewer's probe against the current tree,
`yarn vite-node Temp/review-sleep/probe10.ts` (fixture
`Temp/review-sleep/foldertool/asyncWait.tool.ts`, which declares `registration.mode: 'async'`):

```
1 discovery row  | mode = "async" | origin = folder
2 model requests | 2            (the run PARKED => the harness is running it sync)
3 registry mode  | undefined    (a plugin cannot see the policy on the published object)
  heartbeat      | wakeups = 0  (the plugin does NOT ping it)
```

| Corrected fact | Evidence |
|---|---|
| The scanner DOES read `registration.mode` off a folder module, so discovery reports `mode:'async', origin:'folder'` | probe line 1 above; row keys include `mode` and `origin` |
| The harness still runs that entry **sync**: the batch gate never releases (2 model requests, not 3), because `modeDefinitions` never sees a folder entry | probe line 2 above. Folder entries are registered by the ordered folder loop, `src/harness.ts:6008-6019` → `registerAtStartup` (`:3102`) → `acceptTool`; the ONLY `modeDefinitions.set` in the package is inside `registerDescriptor`, the PACKAGE-row path (`src/harness.ts:3945`), and `effectiveToolMode` (`:1928`) then resolves `modeDefinitions miss → definition.mode (undefined) → DEFAULT_TOOL_MODE ('sync')` |
| The plugin also treats it as **sync**, and for the same data reason: the entry IS a registry hit, `api.tools[name].mode` is `undefined`, and the generated `BUILTIN_TOOL_DESCRIPTORS` holds package rows only — so step 2's map has no key and step 3 answers `'sync'` → no wake | probe line 4 above; `src/plugins/async-ping.plugin.ts:310-319` |
| **Divergence direction, corrected:** today plugin and harness **agree** (both sync), so no shipped configuration loses hang-visibility and the row is neither over- nor under-ping — it is agreement-by-omission | the two rows above |
| The risk is **latent** and points at under-ping: discovery already publishes the async verdict, so the moment core honours a folder row, the harness runs the call async while step 3 still answers `'sync'` — the plugin silently stops pinging a genuinely async call, the one failure the plugin header claims to protect against | probe line 1 vs. plugin step 3 (`src/plugins/async-ping.plugin.ts:318`) |
| What a host can do TODAY to get heartbeat coverage on a folder/external tool: register it where a DECLARED mode is visible on the definition — a `harness({ tools: { … } })` entry copies `definition.mode` onto the wrapper (`src/harness.ts:6045`), which is step 1 of the predicate | `src/plugins/async-ping.plugin.ts:311-314` |

The corrected prose lives in the plugin header, `src/plugins/async-ping.plugin.ts:50-79`
(probe, mechanism, agreement, and the latent under-ping direction). `isAsyncPending`, the
`arm` gate and the `tick` gate were **not** touched by this pass: the async-only rule stays
exactly as landed in task 1. **Line-number note:** that header correction grew the file by
22 lines, so every pre-addendum citation in this file shifts by `+22` from `:196` down —
`isAsyncPending` `:288-302` → `:310-324`, `arm` `:406` → `:428`, `tick` `:391` → `:413`,
sweep `:323-328` → `:345-350`.

### Task 2 — still OPEN, now recorded as an accepted, documented limitation

`api.toolMode(name)` is not built, and it needs `src/types/index.ts` + `src/harness.ts`,
neither of which this change owns. The limitation is therefore documented rather than
fixed, with its direction stated in both places that describe the predicate:

- the replacement case (`addTool({ shell })` with a mode-less definition) is a **live**
  divergence in the **over-ping** direction — one extra turn, safe (`docs` Finding 4, row 1;
  pinned at `src/harness.sync-async.test.ts:931`);
- the folder-entry case is a **latent** divergence in the **under-ping** direction, dormant
  only because the harness ignores the folder row it just discovered (the addendum above);
- both disappear with the accessor, so the closing check in task 2 is unchanged, plus the
  folder row above flipping to "pings" once core honours `registration.mode` for folder
  entries.

### Task 3 — CLOSED (the plugin description now names the async filter)

`metadata.description` and the `intervalMs` setting description were rewritten, and every
mirror was carried with them:

| Surface | Status |
|---|---|
| `src/plugins/async-ping.plugin.ts:224-225` (owner, `metadata.description`) | now "…emitting a periodic ping **only while at least one pending call resolves to mode 'async'**, replacing the fixed scheduler heartbeat." |
| `src/plugins/async-ping.plugin.ts:245-246` (owner, `intervalMs` hint) | now "How often a conversation is pinged **while at least one pending call resolves to mode 'async'**. Defaults to the historical 10-minute wake." |
| `src/plugin/manifest.ts` (GENERATED) | regenerated: `yarn vite-node scripts/generate-plugin-manifest.ts --check` → `plugin-manifest.ts is current (3 plugins)`. **No bytes changed**, by design: the manifest imports each plugin's `metadata` object rather than copying its prose (`src/plugin/manifest.ts:26`), so the operator sentence cannot drift from the plugin. |
| `src/plugin/manifest.test.ts:105` and `:118` (pinned hand copies) | re-pinned to the new sentences; `yarn vitest run src/plugin/manifest.test.ts` green |
| `packages/typecrate/harness/src/plugins.rs:165` and `:185` (Rust plugin row) | mirrored byte-for-byte; `&'static str` text only, no counts, no arrays, no tool catalogue touched |
| `packages/typecrate/harness/tests/plugins.rs:423-425` and `:449-451` (the Rust **test** that asserts the `async-ping` row byte-for-byte against `BUILTIN_PLUGINS`) | re-pinned in the follow-up pass, with the Rust line-continuation (`"… \<newline>indent…`) preserved so the compiled value still equals the TS sentence exactly. Text only: no count, array, hook list or tool-catalogue edit |
| `src/frontend/plugins-tab.test.ts:258` and `:274` (hand-authored `GET /plugins` row fixture) | refreshed to the shipped sentences in the follow-up pass; the setting hint now carries the full shipped text rather than its first clause. `yarn vitest run --config src/frontend/vitest.config.ts src/frontend/plugins-tab.test.ts` → 37/37 green |
| `Temp/coding/verify-desc.ts` and `Temp/coding/verify-desc-2.ts` (`yarn vite-node`) | byte-identity proofs. The second probe is the complete one: 4 mirrors × 2 strings = **8/8 `true`**, each scope cut down to the `async-ping` entry so a sibling plugin's copy cannot satisfy it, and Rust literals de-continued with Rust's own rule before comparison |

The two mirrors that the first pass left behind because they sat outside its ownership were
**authorized and closed in the follow-up pass** — nothing is left stale:

- `src/frontend/plugins-tab.test.ts:258` / `:274` — the hand-authored `GET /plugins` fixture,
  never compared against the real metadata (no import of `./manifest`), so it could only go
  stale, never fail. It now carries the shipped sentences verbatim.
- `packages/typecrate/harness/tests/plugins.rs:423-425` / `:449-451` — the byte-for-byte Rust
  row assertion, which **would** have failed `cargo test` on wording alone. Re-pinned.

**Still unverified:** `cargo` does not run in this environment, so the Rust side is proven by
TEXT only — literal equality after reproducing Rust's `\`-continuation rule
(`Temp/coding/verify-desc-2.ts`). No compiler checked that `tests/plugins.rs` still parses or
that the crate builds; the edits are `&'static str` / `json!` string literals, with no count,
array length, hook list or tool-catalogue change, which is the class of edit that cannot shift
a type. That limit is inspection-level, not compile-level, and stays with whoever can run
`cargo test -p typecrate-harness`.

Closing check from task 3, met: the manifest check is green with the new sentence and
`src/plugin/manifest.test.ts` matches it.

### Task 4 — CLOSED (verified, not edited)

`knowledge.md` is not owned by this change. Its line was **read**, not written, and it no
longer carries the old sentence — `knowledge.md:700-701` now reads:

```
    async-ping.plugin.ts          the recurring wake, armed ONLY while at least one pending
                        call resolves to `mode:'async'` (a sync group re-enters the run itself)
```

Closing check from task 4, met (verified 2026-11-19 by another worker's edit; no edit here).

### Also fixed in this pass

- `src/plugins/async-ping.plugin.ts:218` cited the manifest generator as
  `scripts/generate-plugin-manifest.mjs`; the script is `scripts/generate-plugin-manifest.ts`
  (and every runner in this repo is `.ts`, per the root `AGENTS.md` runner policy).

### Scoped checks run for this pass

| Command | Result |
|---|---|
| `yarn vite-node Temp/coding/verify-desc.ts` | 4/4 byte-for-byte matches (plugin ↔ Rust row ↔ manifest test, both strings) |
| `yarn vite-node Temp/review-sleep/probe10.ts` | folder entry: `mode:"async"` row, 2 model requests, `mode=undefined`, 0 wakeups (the corrected claim, re-measured) |
| `yarn vite-node scripts/generate-plugin-manifest.ts --check` | `plugin-manifest.ts is current (3 plugins).` |
| `yarn vitest run src/plugin/async-ping.test.ts src/plugin/manifest.test.ts src/harness.plugin.test.ts src/plugin/host.test.ts src/plugin/settings.test.ts` | 5 files, 106 tests passed, 0 failed |

### Scoped checks run for the follow-up pass (the two remaining mirrors)

| Command | Result |
|---|---|
| `yarn vite-node Temp/coding/verify-desc-2.ts` | **8/8 byte-for-byte matches** — `metadata.description` and the `intervalMs` hint against `manifest.test.ts`, `plugins-tab.test.ts`, `src/plugins.rs` and `tests/plugins.rs`, every scope cut to the `async-ping` entry, Rust literals de-continued with Rust's own rule. No parse-count warnings, so every leg really found its two literals |
| `yarn vitest run --config src/frontend/vitest.config.ts src/frontend/plugins-tab.test.ts` | 1 file, **37 tests passed, 0 failed** (the jsdom `HTMLCanvasElement.getContext` lines are pre-existing environment noise, not failures) |
| `yarn vitest run src/plugin/async-ping.test.ts src/plugin/manifest.test.ts src/harness.plugin.test.ts src/plugin/host.test.ts src/plugin/settings.test.ts` | re-run after the follow-up: 5 files, 106 tests passed, 0 failed |
| `yarn vite-node scripts/generate-plugin-manifest.ts --check` | `plugin-manifest.ts is current (3 plugins).` |
| `grep` sweep for the two retired sentences across `src`, `docs`, the Rust `src` and `tests` | only ONE hit left: `docs/tasks/2026-11-19-heartbeat-async-only.md:98`, where the old sentence is quoted as the historical defect being described |
| `cargo test` | **NOT RUN** — no Rust toolchain here (see the limits note above) |
