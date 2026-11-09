# Plugin pipeline v2 — decisions, not only transcript rewrites

Status: **trimmed 2026-11-09 — the stage landed, and everything that landed (the wildcard
bus, `priority`, fail-open `timeoutMs`, the production diagnostic channel and the server sink,
`host.state_change`, `harness.dispose` + the handle member, the `turn.before`
`HarnessTurnDecision` reducer, `context.edit` / `api.snapshot()` / `settings.setOwn` /
`actorKey` / `branchId`, and the worker-lane `transcript:patch` durability work) has been
REMOVED from this file rather than left as done-markers.** What is left is two probes and the
boundaries that were closed by decision: **Probe 1** — the plugin-visible mirror diagnostic
event, the one edge the shipped stage recorded instead of building; **Probe 2** — the
same-actor `api.threads.send` probe that would replace a recorded prohibition with an
observation. Everything else
this entry named is either shipped or explicitly closed below, and the authoring guide is
`docs/plugins.md`.

Line numbers describe the working tree reviewed on 2026-11-09. Names are the durable anchors
and the *drift check* near the end lists the commands to re-verify them.

Companion entries:
[2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md)
(Stage 1's own edges — now only the UI marker) and
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) (the policy that
consumes this surface), plus
[../issues/review-list-improvements-review-list.md](../issues/review-list-improvements-review-list.md)
(cross-cutting review items; not duplicated here).

## Date / Method / Scope

**Date:** 2026-11-09 (re-reviewed and trimmed the same day).

**Method:** the entry was written from a static audit of the plugin surface — the declaration,
the merge/dispatch code, and the emit site of the same capability, each negative confirmed by a
targeted grep. The two probes below are the parts that audit could NOT settle: both need an
observation, not another read.

**Scope:** the plugin framework as it stands — the lifecycle bus (`src/plugin/hooks.ts`), the
plugin host and api (`src/plugin/host.ts`, `HarnessPluginApi` in `src/types/index.ts`), the
harness emit sites (`src/harness.ts`), the server's wiring of plugins and settings
(`src/server/harnesses/toolbox.ts`, `src/server/plugins.ts`), and the worker-lane transcript
protocol (`src/server/workers/*`).

**Out of scope (deliberately):** the *policy* of compaction —
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md); the token-budget
and provider-overflow gaps —
[../issues/minor-context-window-and-token-budget.md](../issues/minor-context-window-and-token-budget.md);
and tool-registry lifecycle —
[../issues/review-list-improvements-review-list.md](../issues/review-list-improvements-review-list.md).

## Invariants the probes trade against

- **Observation parity.** A plugin must be able to observe what the host observes, or a stated
  subset. Today the failure channel is host-only, which is exactly Probe 1's subject.
- **No overlapping harness execution for one actor key.** The run serializer
  (`serializeTurn`, `src/harness.ts:7931`, called as `serializeTurn(run.actorKey, …)` at
  `:8854`) is the reason a `turn.before` handler calling back into the same thread is a
  question at all; `src/server/queue.test.ts` pins peak concurrency 1 per actor. Probe 2's
  subject.
- **The synchronous fast path.** A hook that does nothing may cost no microtask; any new
  catalogue event or reporter must keep `src/server/queue.test.ts` green **unchanged**.
- **Context control never deletes**, and a lane rewrite is bound to a whole-prefix digest — the
  shipped shape of both is what the closed worker-lane notes below rest on.

## The substrate the remaining work stands on

The findings and the landed tasks were removed; these are the anchors the probes quote, inlined
so this file stays self-contained.

| Fact | Where |
|---|---|
| The lifecycle catalogue is exactly **18** events — the 17 run/thread events plus `host.state_change` | `src/types/index.ts:3428-3451` (`HarnessLifecycleEvent`) |
| There is **no** `plugin_error` (or any plugin-failure) event: the grep is empty across `src/` | — |
| Plugin failures are reported on a **host-only** channel: `configuration.report.diagnostic` | `src/types/index.ts:2961`; the event and its kinds `handler-threw` \| `handler-timed-out` \| `invalid-decision` \| `policy` at `:3656-3658` (`HarnessDiagnosticEvent`) |
| The bus already swallows a reporter's own throw, and a wildcard subscription receives every event except `host.state_change` | `src/plugin/hooks.ts`, and the `WILDCARD_DELIVERABLE` set that forces a new event's author to decide whether an audit plugin sees it |
| The server journals diagnostics durably, bounded | `notePluginDiagnostic`, `src/server/sessions.ts:3008-3028`, capped at `PLUGIN_DIAGNOSTIC_LIMIT`; projected as `plugin_diagnostics` (`src/server/api-reads.ts:241-243`) |
| A `turn.before` decision is exactly four actions — `continue` \| `replace` \| `pause` \| `stop` | `src/types/index.ts:4048-4052` (`HarnessTurnDecision`) |
| A lane CAN rewrite the committed prefix in place: the mutation op, the replica's base digest, the authority's replay seam, and the contract sentence | `transcript:patch` at `src/server/workers/lane-commit.ts:240`; `LaneWorkerState.committedDigest` at `src/server/workers/lane-worker-loop.ts:152` and the whole-prefix diff at `:703-710`; authority replay at `src/server/workers/lane-authority.ts:899` through `harness.patchThreadMessages` (`src/harness.ts:5338`); restart-durable wording at `src/types/index.ts:3865` |

## Tasks

### Probe 1 — a plugin-visible mirror diagnostic event

A plugin can make the **host** see everything that goes wrong with it — a handler that throws,
one that never resolves, a decision it cannot parse, and the policy report it files for itself —
but **no plugin can see another plugin's failure**: the whole diagnostic channel is host-only.

- **What exists.** `configuration.report.diagnostic` (`src/types/index.ts:2961`) is the only
  failure channel, its kinds are `handler-threw` | `handler-timed-out` | `invalid-decision` |
  `policy` (`:3656-3658`), and the server journals them durably
  (`src/server/sessions.ts:3008-3028`).
- **What is missing.** One new entry in `HarnessLifecycleEvent` (`src/types/index.ts:3428-3451`,
  currently exactly 18) — a `host.plugin_error`-style event that carries the same
  `HarnessDiagnosticEvent` payload — plus the decision of whether a `'*'` subscriber receives it
  (`src/plugin/hooks.ts` `WILDCARD_DELIVERABLE` forces that decision the moment the event is
  added).
- **The rule the original entry never specified, and this probe must state.** Re-entrancy: the
  reporter that emits into the bus is itself called from inside dispatch, so a handler that
  throws while a failure is being announced can recurse. The design has to say what bounds that
  (a depth flag, a suppression window for the failing owner, or a rule that the mirror emit is
  fire-and-forget outside the current frame) before the event exists — adding the catalogue entry
  without the rule ships a recursion hazard.
- **Also in scope for this probe:** whether the mirror event is journaled on the session like the
  host channel already is (it should be bounded by `PLUGIN_DIAGNOSTIC_LIMIT` for the same
  reason), and that it must stay **advisory** — a mirror emit can never fail a run, the same rule
  the synchronous reporter already follows.

*Check:* a `'*'` subscriber (or a named subscription) sees the new event with the failing
plugin's `owner`, `event` and `kind` when another plugin throws, and a case proves the recursion
rule (a handler that throws inside the mirror event's own dispatch does not loop and does not
fail the run). `npx vitest run src/plugin/hooks.test.ts src/plugin/host.test.ts
src/harness.plugin.test.ts src/server/queue.test.ts`, with `src/server/queue.test.ts` green
**unchanged**.

### Probe 2 — same-actor `api.threads.send` from inside a hook

Still **FORBIDDEN UNTIL TESTED**, and the answer recorded here is a prohibition, not a finding.

- **The question.** A `turn.before` handler that calls `api.threads.send(threadId, …)` for the
  thread whose turn is parked re-enters the serializer for that actor key (`serializeTurn`,
  `src/harness.ts:7931`; the run enters it at `:8854`). Whether that deadlocks or queues behind
  the parked turn has never been observed; the property at stake is the "no overlapping harness
  execution" invariant `src/server/queue.test.ts` pins.
- **Why it is still open as a matter of evidence.** No test exercises it. The only `threads.send`
  references inside plugin tests are stubs that record the call and never re-enter a run:
  `src/plugin/host.test.ts:62`, `src/plugin/context-compaction.test.ts:192`,
  `src/plugin/async-ping.test.ts:189`.
- **The boundary that is NOT in question.** A send under a **different** actor key is a different
  actor's queue and is already exercised by the `threadSend` merge.
- **What closing it needs.** One probe: a `turn.before` handler that sends to its own thread
  under a fake transport, with a bounded wait, asserting either the answer or the refusal — and
  then replacing this bullet, plus the guide's prohibition section
  (`docs/plugins.md`, "Do not call `api.threads.send` on the thread whose turn is parked, from
  inside a hook"), with what was observed. Until then the guide must keep telling authors not to
  do it, and must not imply the parked turn makes it safe.

*Check:* that single probe test exists and passes; the sentence in `docs/plugins.md` is replaced
by the observation (deadlock, queued-behind, or refused), with the timing it measured.

## Closed by decision — not work

- **External plugin loading stays NOT done** — the stage's answer to "may foreign plugin code be
  installed?" was **no**: the server runs only code the application shipped. That answer is why
  nothing loads plugins today: `src/server/harnesses/toolbox.ts` wires no plugin list (it
  forwards the diagnostic sink and the settings provider, nothing else), and a replica is
  built without plugin input (`src/server/workers/lane-worker-loop.ts:1089-1113`) — a preset
  factory closure cannot cross `worker_threads`. A host plugin running ON a lane is therefore a
  consequence of that decision, not a separate task.
- **`respond` / `retry` are deferred**: the decision union is exactly
  `continue` | `replace` | `pause` | `stop` (`src/types/index.ts:4048-4052`), and a variant that
  answers the model's next request without a provider call changes what `done` means and
  interacts with the iteration cap and the run record. `stop` itself is settled: it joins the
  closed list of things that end a run, and it is a policy assertion at a boundary the run is
  already parked at — not a wall-clock bound, so nothing expires.
- **Capability tiers are a design target, not implemented** — the alternative to raw `api`
  access, chosen as the direction and left unbuilt; `metadata` carries no capability field.
- **The worker-lane rewrite residue is closed by the lane work above** (`transcript:patch` +
  `committedDigest` + `patchThreadMessages`), so no in-place-write item is still open anywhere.
- **One decision is deferred rather than resolved: `respond`.** Every other open question this
  entry carried was answered by the implementation and removed with it.

## Known boundary (a note, not a task)

A lane replica's diagnostic sink is a deliberate no-op — `diagnostic: () => undefined` at
`src/server/workers/lane-worker-loop.ts:1097-1106` — because a report fired inside a hook has no
frame to travel on; the comment says so in the line itself ("giving the diagnostics a frame is
lane-protocol work, not this"). A plugin that throws on a lane is still fail-open and still
invisible to the authority. Probe 1 does not change that; a lane diagnostic frame is protocol
work owned by the lane.

## Verify before starting — drift check

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'
grep -rn "plugin_error" src/                                   # Probe 1: still no plugin-visible failure event?
grep -n "export type HarnessLifecycleEvent =" src/types/index.ts   # count the catalogue (18 today)
grep -n "WILDCARD_DELIVERABLE" src/plugin/hooks.ts                  # the set a new event must be judged against
grep -rn "threads.send" src/plugin/*.test.ts                       # Probe 2: still stubs only?
grep -rn "api.threads.send\|threads.send" src/server/workers/      # any lane path that would re-enter the serializer?
npx vitest run src/server/queue.test.ts                     # BASELINE green before any edit
npm run typecheck
```

Stop-and-recheck conditions:

1. **A plugin-failure event is in the catalogue** — Probe 1 is done; check that the re-entrancy
   rule was written down and pinned by a test, not just added to the union.
2. **A test calls `api.threads.send` on the parked thread from a hook** — Probe 2 is answered;
   replace the prohibition here and in `docs/plugins.md` with the observation.
3. **The server starts passing a plugin list** (`grep -n "plugins" src/server/harnesses/*.ts`) —
   the "only application-shipped code" answer has been revisited by someone else; record which
   change did it and re-read the closed-decision list above.

## Not tested

- **Both probes**, by construction: each is the observation this entry could not produce.
- **A `turn.before` plugin running on a real replica.** A preset factory closure cannot cross
  `worker_threads`, so the durable lane tests submit the patch ON the lane's behalf rather than
  watching a plugin produce it (the closed-decision and known-boundary notes above).
- **A timed-out handler's side effect.** The documented rule is that a budget bounds the WAIT,
  not the damage — a flag the handler wrote before stalling stays written — and no test writes
  `included` and then stalls.
- **A `pause` decision against a host-driven stop**, and a `stop` against an in-flight delegated
  child: control-flow claims about `src/harness.ts` paths no test has executed together.
- **Two live lanes patching one conversation at the same instant** — the whole-prefix CAS and the
  writer lease both refuse the second, pinned at the fold and at the authority but never raced on
  threads.
- **The Plugins pane rendering `plugin_diagnostics` or a new catalogue event** — the contract and
  the generated client types carry them; no rendered row was ever observed. Surfacing them is the
  companion entry's T7.
