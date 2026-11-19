# 0039 — A folder tool's declared `registration.mode` is inert at runtime: discovery reports it, registration never binds it

> **Status:** Open — **filed 2026-11-19, record only.** Nothing in core was changed by the pass
> that found this; the entry exists so the next person who reads a folder row's `mode` does not
> have to measure it again.
> **Severity:** Minor — **latent, not user-visible today.** Both consumers of the policy currently
> agree on `'sync'`, so no shipped configuration loses hang-visibility.
> **Area:** `src/harness.ts` (startup + folder registration), `src/core/tool-scan.ts` (folder rows),
> `src/plugins/async-ping.plugin.ts` (pending-call mode resolution)
> **Date opened:** 2026-11-19

## Gap up front

A host that drops `myTool.tool.ts` into a configured `toolFolders` entry and states
`registration.mode: 'async'` is told, in the row discovery hands back, that its call is async —
`{ mode: 'async', origin: 'folder' }` — and is then run **sync**: the published registry object
answers `.mode === undefined`, the batch gate stays shut, and the liveness heartbeat never wakes
for it. The declaration is read, published to every reader, and dropped at the one moment it would
have to be honoured.

## Context

Found on 2026-11-19 while auditing the new `sleep` runtime entry
(`src/tools/runtime/sleep.tool.ts`), the first harness-owned entry whose `registration` literal
spells `mode: 'sync'` out instead of leaving it defaulted (`:164`, with the reason at `:142-145`).
Checking whether that statement has any effect for a **package** row led to the sibling path — how a
**folder** row gets registered — and there it has none.

The measurement is not hypothetical: the reviewer probe `Temp/review-sleep/probe10.ts` and its
fixture `Temp/review-sleep/foldertool/asyncWait.tool.ts` (a folder entry declaring
`mode: 'async'`) were re-run on this tree on 2026-11-19 and reproduced all four numbers below.
The async-ping plugin already carries the same result in its header
(`src/plugins/async-ping.plugin.ts:57-79`) — an earlier claim there, that a folder entry "pings",
was measured false and corrected in place — and the heartbeat task's own risk table still carries
the stale version of it (see the last Evidence row).

## Gap

Stated as a capability, not as a fix: **the turn policy a folder entry declares should be the
policy its call actually runs under, and the policy a consumer can read back.** Today:

- **(a) the declared mode is silently ignored for folder tools.** A folder call runs async only if
  the mode travels on the *compiled definition* it exports; a mode stated in the entry's
  `registration` literal — the field the entry is documented to declare its policy in — changes
  nothing.
- **(b) discovery reports a policy the runtime does not honour.** `discoverToolMetadata` returns
  `mode: 'async'` for that row, so a host (or the server catalogue, or `toolManage`) that reads the
  row it was given is positively misinformed rather than merely uninformed.
- **(c) latent flip.** Harness and plugin agree today, but only by accident: discovery *already*
  advertises the row as async, so the moment core honours what it reports, the plugin's
  `'sync'` fallback flips from harmless to **under-pinging** — the one direction that header
  promises it will not go.

## Why it is the way it is

Two design rules meet, and neither one intends the result:

- **Folders are deliberately outside the package scan.** Package rows come from
  `discoverToolMetadata()`; configured folders are registered by their own ordered loop, "so a
  later folder wins a name collision" and "reports a bad module with its exact file path"
  (`src/harness.ts:1748-1752`, loop at `:6008-6018`). That ordering-and-attribution rule is real and
  a fix must keep it.
- **The per-definition policy is bound by the kernel operation, keyed on the published object.**
  `registerDescriptor` is where a discovered row's mode is attached to the definition it published
  (`src/harness.ts:3918-3948`; the bind itself is `:3945`), and `effectiveToolMode` reads exactly
  that private WeakMap, then the definition's own `mode`, then `DEFAULT_TOOL_MODE` (`:1918`,
  `:1927-1928`).

The folder loop never reaches that bind: `registerAtStartup({ sourcePath })` →
`acceptTool(intent, { record: false })` (`src/harness.ts:3102-3103`), and `modeDefinitions.set`
appears at exactly one call site in the whole file (`:3945`). Nothing re-reads the entry after
registration — by design, so a replacement under the same wire name inherits nothing. So the mode
falls on the floor **for folder rows only**, and the row keeps advertising it.

On the plugin side the same split is structural, not a bug: its table of known policies is built
from `BUILTIN_TOOL_DESCRIPTORS`, whose type pins `origin: 'package'`
(`src/core/tool-metadata.ts:157`; table build at `src/plugins/async-ping.plugin.ts:191`,
`:200-209`). A folder name is therefore a registry **hit** with no declared mode and no row, which
is step 3 → `'sync'`, no wake (`src/plugins/async-ping.plugin.ts:288-297`, documented at `:45-47`).
The header states the asymmetry it is protecting: over-pinging costs at most one extra turn,
**under-pinging silently removes hang-visibility** (`:50-55`).

## Evidence

| Fact | Source |
|---|---|
| A folder row carries its declared mode, stamped `origin: 'folder'` | `src/core/tool-scan.ts:871-881` (the `readEntry(..., 'folder', ...)` push); row shape `src/core/tool-metadata.ts:96-103` (`group`/`activation`/`mode?`), `ToolOrigin = 'package' \| 'folder'` at `:61`; folders append after package rows at `src/core/tool-discovery.ts:112-140` |
| Folders are excluded from the package scan and registered by their own ordered loop | `src/harness.ts:1748-1752` (the rule), `:6003-6019` (the loop) |
| That loop registers through the startup helper, not the descriptor kernel | `src/harness.ts:6011` → `registerAtStartup:3102-3103` (`acceptTool(intent, { record: false })`) |
| The only site that binds a discovered mode to a published definition | `src/harness.ts:3945` — `if (descriptor.mode !== undefined) modeDefinitions.set(prepared.tool, descriptor.mode)`, inside `registerDescriptor` (`:3918`) |
| The effective-mode precedence a call actually runs under | `src/harness.ts:1918` (`modeDefinitions`), `:1927-1928` (`modeDefinitions.get(definition) ?? definition.mode ?? DEFAULT_TOOL_MODE`) |
| The plugin's policy table cannot answer for a folder name | `src/core/tool-metadata.ts:157` (`BuiltinToolDescriptor = DiscoveredTool & { origin: 'package' }`); `src/plugins/async-ping.plugin.ts:191`, `:200-209` |
| "Registry hit, no mode, no row" resolves to `'sync'`, no wake | `src/plugins/async-ping.plugin.ts:288-297` (`return false` at `:296`), documented as step 3 at `:45-47`; the protected direction at `:50-55` |
| **Measured, re-run 2026-11-19** (`yarn vite-node Temp/review-sleep/probe10.ts`, fixture `Temp/review-sleep/foldertool/asyncWait.tool.ts` declaring `mode: 'async'`) | discovery row `mode = "async"`, `origin = folder`, `group = external`; **2 model requests** (2 = the run PARKED ⇒ sync policy; 3+ = the gate released ⇒ async); `api.tools.asyncWait.mode` = **`undefined`**; heartbeat **wakeups = 0** |
| No shipped folder tool declares a mode, so nothing shipped is affected today | `src/server/tools/shared/timeNow.tool.ts:73`, `textCount.tool.ts:40`, `diceRoll.tool.ts:54`, `noteSearch.tool.ts:61`, `textSummarize.tool.ts:67` — each `registration` is `{ group: 'external', activation: 'always', order: 1000-1040, listed: true }` only; the folder default itself declares no mode (`src/core/tool-scan.ts:799-803`) |
| No shipped test covers the folder-mode contract | `src/harness.tool-folders.test.ts` has no `registration.mode` case (its `mode` hits at `:14`, `:335`, `:509`, `:581` are `persist: "runtime"` prose); `src/plugin/async-ping.test.ts` never names a folder entry (its only `tools` field is the fake registry at `:150`) |
| The plugin header records the mechanism and the latent flip | `src/plugins/async-ping.plugin.ts:57-79` |
| The heartbeat task's risk table still states the stale version of this row | `docs/tasks/2026-11-19-heartbeat-async-only.md:79` has a folder entry falling through to "wake anyway" → **over-ping**; measured: a folder entry is a registry HIT with no row → step 3 → **no wake**. That table row needs the same correction the plugin header already got (that file is outside this entry's fix). |

## Proposal

Close the mismatch in **one** direction — make the runtime match the row, or stop the row
claiming — and pin it either way.

Smallest change that keeps both design rules: carry the folder row's mode across the folder path,
without moving folder registration into the package scan.

1. **Preferred:** put the declared mode on the **published definition** when a folder source is
   compiled, exactly as the `harness({ tools })` wrapper already does for a host-declared mode
   (`src/harness.ts:6036-6052`, `mode` copied at `:6045`). One field, no new state: `effectiveToolMode`'s
   existing second clause (`definition.mode`, `:1928`) then answers correctly, and the plugin's
   step 1 (`:291-292`) sees it with no table change and no new plugin surface — which also means
   the under-ping direction closes automatically rather than waiting on the `api.toolMode(name)`
   follow-up.
2. **Alternative:** bind the WeakMap in the folder loop instead — read the mode off the row the
   scanner already produced and `modeDefinitions.set(prepared.tool, row.mode)` where
   `registerAtStartup` returns (`:3102-3103`). Cheaper to write, but it fixes only the harness: the
   registry object stays `.mode === undefined`, so gap (b) and the plugin's blind spot survive.

**Alternatives considered and rejected.**

- *Fix only the plugin.* Rejected: the generated table can't answer for folder names by
  construction (`src/core/tool-metadata.ts:157`), and the `api.toolMode(name)` follow-up
  (`docs/tasks/2026-11-19-heartbeat-async-only.md`, task 2) still leaves the harness running a
  sync call the row calls async — gap (a) and (b) untouched.
- *Stop discovery reporting a mode for folder rows.* Rejected: it hides information at the source,
  breaks the uniform `DiscoveredTool` row shape (`src/core/tool-metadata.ts:96-103`), and reads
  like a documentation of a missing feature rather than a fix.
- *Register folder entries through `registerDescriptor` too.* Rejected for this entry: it is the
  largest blast radius (collision order, per-file error attribution, the created-tool budget) for a
  latent gap, and proposal 1 achieves the same honesty in one field.
- *Leave the code, document `mode` as unsupported for folder entries.* Acceptable only as a
  deliberate deferral, and then the row should say so where a host reads it rather than advertising
  a policy that never runs.

## Acceptance criteria

1. A folder entry declaring `mode: 'async'` **runs** async: the batch gate releases and the run is
   re-requested while the call is still pending — i.e. the probe above reports 3+ model requests,
   not 2.
2. The registry object's own `.mode` and the discovery row agree for a folder entry (gap (b) is
   closed), so any consumer reading either gets the same answer.
3. The heartbeat wakes for that call: 1+ wakeups in the probe configuration
   (`wakeIntervalMs: 250`), i.e. the plugin never answers `'sync'` for a call core runs async.
4. Package rows are byte-for-byte unchanged, and none of the five shipped folder tools changes
   behaviour (none declares a mode — see Evidence).
5. Whatever is left unfixed is stated where a host reads it (the paragraph describing
   `registration.mode` in `knowledge.md`), not only here.

## Tests to add

- `src/harness.tool-folders.test.ts` — a folder entry declaring `mode: 'async'`: assert the run
  treats it as async (the second model request lands while the call is still pending) and that the
  published registry object reports the mode the row declares. This file currently pins folder
  persistence and collision order and says nothing about the turn policy.
- `src/harness.tool-folders.test.ts` — the mirror case: a folder entry declaring `mode: 'sync'`
  parks the run, and a folder entry declaring **no** mode stays `'sync'` (so the five shipped tools
  stay pinned on the default path).
- `src/plugin/async-ping.test.ts` — a folder-origin pending call whose row declares `'async'`:
  assert a wake fires, pinning whichever resolution order the fix lands on, so the step-2 package
  case and the step-3 "no row" case cannot be conflated again.

## Out of scope

- The `api.toolMode(name)` plugin API itself (task 2 of the 2026-11-19 heartbeat task) — named as a
  possible vehicle, not required by this entry.
- Any retuning of the heartbeat's interval, or of `DEFAULT_TOOL_MODE`.
- Changing what the generated table holds (`origin: 'package'` at `src/core/tool-metadata.ts:157` is
  deliberate) or moving folder registration into the package scan.
- The five shipped folder tools under `src/server/tools/shared/` — they declare no mode and must not
  start depending on one.
