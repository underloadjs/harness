# Context inclusion (Stage 1) — the shipped flag has no UI, and that is the open work

Status: **trimmed 2026-11-09 — the edges this file named have been closed one by one, and the
closed ones (with their landing notes) have been REMOVED from this file rather than left as
done-markers.** One task is still open: **T7 — no UI marker for an excluded turn.** Two
non-items are kept as one-line pointers because they are standing decisions a future change
trades against: the deferral rule for per-call partial inclusion (unclaimed) and the two
decision records T6.2 / T1.4, kept below. The stale "cooldown pollution is still there" framing
from the closed branch-discriminator work is gone:
the shipped compactor declines branch rounds outright
(`src/plugins/context-compaction.plugin.ts:303` and `:460`, explained at `:36-39`), so the
cooldown map no longer accumulates `branch:<id>` keys. This file is not a defect report: every
remaining item is a scope limit the stage chose on purpose.

Line numbers describe the working tree reviewed on 2026-11-09; the names are the durable
anchors and the *drift check* at the end lists the commands to re-verify them.

Companion entries:
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) (the framework work
this feeds) and [2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md)
(the consumer that writes the flag). Related issues:
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md),
[../issues/0007-improvements-review-list.md](../issues/0007-improvements-review-list.md).

## Date / Method / Scope

**Date:** 2026-11-09 (re-reviewed and trimmed the same day).

**Method:** static audit of the shipped surface — the flag's declaration, the projection, the
plugin-facing control, each persistence path, and every consumer of the flag in
`src/frontend/` — plus one grep per negative claim. Tests were read as contracts, not executed:
this is a documentation-only change.

**Scope:** the `included` flag and the `turn.before` control surface that writes it —
`src/types/index.ts`, `src/harness.ts` (`projectTranscript`, `transcriptUnits`,
`emitTurnBefore`, `setIncluded`), `src/core/agent.ts` (`withIncluded`), `src/core/snapshot.ts`
(`applyIncluded`), `src/core/branch.ts` (`copyIncluded`), the worker protocol
(`src/server/workers/*`), and the frontend/contract surfaces.

**Out of scope:** compaction policy (the compaction entry), the decision/pipeline questions
(the pipeline entry), and the token-budget gaps that
[../issues/0004-context-window-and-token-budget.md](../issues/0004-context-window-and-token-budget.md)
owns.

## The substrate the remaining work stands on

The landed tasks were removed; these are the facts T7 quotes, inlined so this file stays
self-contained.

| Fact | Where |
|---|---|
| The flag itself: `included?: boolean` on all four `HarnessMessage` variants; absent/`true` = included, only `false` is stored | `src/types/index.ts:173`, `:191`, `:208`, `:269`; the single normalization point is `withIncluded` in `src/core/agent.ts` |
| A stable address for an entry, so a marker can name the turn it dimmed | `messageId` on all four variants (`src/types/index.ts:173`, `:191`, `:208`, `:269`), minted by `src/core/message-id.ts` |
| The live metric a UI would have to agree with | `currentEstimatedTokens()` (`src/types/index.ts:3832`, implemented in `src/harness.ts`), the same estimator the context bar uses (`src/core/context-estimate.ts:17-19`) |
| The branch discriminator, already exposed and already consumed by the shipped compactor | `actorKey` `:3797`, `branchId` `:3804` |
| The per-pass diagnostic a UI could show, end to end on the server side | producer `api.report.diagnostic` (`src/plugins/context-compaction.plugin.ts:334` below the floor, `:378` the pass report); server journal `notePluginDiagnostic` (`src/server/sessions.ts:3008-3028`), bounded by `PLUGIN_DIAGNOSTIC_LIMIT`, durable through `HarnessSessionRecord.pluginDiagnostics`; projected as `plugin_diagnostics` (`src/server/api-reads.ts:241-243`); typed in the client contract (`src/shared/harness-api.ts:961`) |

## Tasks

### T7 — UI and observability

The flag works and persists; nothing in the product shows it. After a compactor prunes 30
units, the visible conversation tells you nothing, and the context bar's number moves with no
explanation.

- **T7.1 — an "excluded from context" marker plus a count on the conversation board.** Zero
  consumers of `included` exist in `src/frontend/`: every `included` hit there is prose or an
  unrelated local (`src/frontend/main.ts:1655`). The board is event-driven and the progress
  union `HarnessEvent` (`src/types/index.ts:2322-2486`) carries no inclusion field in any
  variant, so the board cannot show what no event reports. The flag IS visible in the transcript
  dialog — a `<pre>` of the server's recorded messages
  (`src/frontend/ui/thread-transcript.ts:31-33`) — and IS published for all four variants in
  `src/server/harness.swagger.yaml`. **Prefer the transcript read over a new event field:** the
  document is the authority, and an event would have to be replayed to reconstruct state.
- **T7.2 — transcript metadata: the excluded count and the estimated tokens saved**, surfaced
  where the context bar already lives. Nothing carries it today: there is no such field
  server-side and none in `src/shared/harness-api.ts` (no `excluded`/tokens-saved member on the
  session or transcript reads). The bar's number is the same estimate the plugin compares
  against (`src/core/context-estimate.ts:17-19`), so a savings figure shown next to it must come
  from that estimator or be labelled as not comparable.
- **T7.3 — surface the compactor's per-pass diagnostic in the UI.** The producer and the server
  sides are already landed (see the substrate row above: the pass report at
  `src/plugins/context-compaction.plugin.ts:378`, the bounded durable journal at
  `src/server/sessions.ts:3008-3028`, the `plugin_diagnostics` projection at
  `src/server/api-reads.ts:241-243`, typed at `src/shared/harness-api.ts:961`) and **the
  frontend never consumes it** — zero references to `plugin_diagnostics` in `src/frontend/`.
  This task's part is only making an already-durable record visible.

*Check:* a frontend test in the existing transcript/board suites asserting the marker renders
from a transcript containing one `included: false` unit and that the count matches that unit
exactly; `npm run test:frontend` (`package.json:97`) green.

## Deferred and decided (pointers, not tasks)

- **T2 — per-call partial inclusion stays deferred by its own rule:** *do not implement before a
  use case is written here with a name.* No name has been written. The unit-level rule is what
  keeps provider pairing unbreakable, and the shipped surface refuses a call-level patch — a
  `toolCalls` edit is one of the refused inputs pinned at
  `src/harness.inclusion.test.ts:2467`.
- **T6.2 — decision record: no read-side normalization.** `threadMessages()` (and with it
  `api.threads.messages` and the server's transcript GET) shows canonical state verbatim, so a
  `true` written straight into the public mutable `agent.messages` stays visible to that reader
  while being invisible to the model, to `snapshot()`, and therefore to a restart. The
  divergence is documented, not an accident; normalizing there would make the read surface
  disagree with `context.entries`, which must keep handing out the canonical object.
- **T1.4 — decision record: a fork copies ids.** An entry's `messageId` travels across a
  fork/branch rather than being re-minted, so a host-side address stays meaningful after a fork;
  a transcript that has none gets one minted on read.

## Verify before starting — drift check

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'; git status --short
grep -rn "included" src/frontend/ | grep -v "entries included" | grep -v test    # T7.1: zero real consumers?
grep -rn "plugin_diagnostics\|pluginDiagnostics" src/frontend/                   # T7.3: still unconsumed?
grep -n "excluded\|tokensSaved\|tokens_saved" src/shared/harness-api.ts          # T7.2: still no field?
grep -n "export type HarnessEvent =" src/types/index.ts                          # T7.1: the union to extend (or not)
npx vitest run src/harness.inclusion.test.ts                                     # BASELINE green before any edit
```

Stop-and-recheck conditions:

1. **The frontend renders the flag** — T7.1 is done; verify the count comes from the transcript
   read, not from a reconstructed event stream.
2. **A progress event gained an inclusion field** — T7.1 took the other branch of the design;
   re-read this section and record which one shipped.
3. **A per-call use case is written into T2 with a name** — T2 stops being a pointer and becomes
   a task; the acceptance condition is the pairing oracle (`wireIssues`,
   `src/harness.background.test.ts`) staying empty on a block with one excluded and one included
   call.

## Not tested

- **UI behaviour with an excluded turn** — no frontend surface consumes the flag, so nothing has
  been observed; the transcript dialog shows it only as raw JSON.
- **An id used by a client of the HTTP transcript routes** — the server-side id and its
  persistence are pinned; no consumer outside the package has addressed a turn by it.
- **Whether one notification per write is actually slow** — the save model is a whole-document
  rewrite (`src/server/persistence.ts`), and no profile was ever taken.
- **A host writing `included: true` in place** — probed at the library level (the value is
  invisible to the model and to snapshots, visible to `threadMessages()` until the next copy);
  whether any real host does it is unprobed.
