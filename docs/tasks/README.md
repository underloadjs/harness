# Task log

Actionable work items found while exercising `@underload/harness` from inside a
live session. Unlike `../issues/` — which records design-level gaps between what
a consumer needs and what the published surface provides — a file here is a
task list: each entry names the change, the file it touches, and the check that
closes it.

## Index

| File | Area | One line |
|---|---|---|
| [2026-11-08-delegate-stress-test.md](./2026-11-08-delegate-stress-test.md) | delegation / tools | 28-delegate stress run: `toolCancel` is undiscoverable, `scope` livelocks a restricted child, and `threadSend` cannot wake an idle or paused thread. Includes retest steps and one unresolved anomaly. |
| [2026-11-09-thread-timeout-policy.md](./2026-11-09-thread-timeout-policy.md) | threads / delegation | Policy change: a thread has no wall-clock limit — `delegate`'s `timeoutMs` (300000 ms default) becomes an optional, caller-set bound that defaults to infinity, while every tool keeps its own timeout. Maps the whole surface, names the blocking decisions, and lists a drift-check command set to re-verify before implementing. |
| [2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) | plugins / server / workers | Stage 2: only `turn.before` returns anything (`{ transcript? }`), merge is "last non-empty wins" with no priority/timeout and no production error reporter, `harness.dispose` is never emitted, the server never passes `configuration.plugins`, and a worker lane drops an in-place flag change. Task breakdown for an event bus v2, a `HarnessTurnDecision` pipeline, a mutation API, worker sync, and the blocking capability/security decision. |
| [2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) | plugins / context | Stage 3: `executeCompaction()` is a literal no-op while its trigger/cooldown/pause machinery is complete; tool `outcome` is decided then never persisted, so a restart leaves only English prose. Prune answered failures, never failures — with the `outcome` field, an argument fingerprint, guards/settings, the adjacent budget gaps, the deferred summary checkpoint, and cited vendor/preprint evidence. |
| [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md) | context / plugins / persistence | Stage 1 follow-ups: what shipped is verified (flag, unit filtering, snapshot/branch/fork persistence, `entries`/`setIncluded`/`currentMessages`), and eleven edges are named — no stable message ids, unit-level only, the worker-lane sync gap, `replaceHistory` invalidating entries, entry-time `messages`/`estimatedTokens`, per-write notifications, host-written `included: true`, shared `entry.message`, no UI marker, and no branch discriminator — each with a task and a closing check. |
| [2026-11-08-records-engine.md](./2026-11-08-records-engine.md) | record stores / tools / workers | Design, implementation-ready: one `records` engine holding `task`'s batch CRUD, revisions and change feed — with **claims and locks deleted outright** (round 7: CAS is the only conflict control, and a stale rejection must return the current entry) — with `tasks`/`chapters`/`profiles`/`locations` rebuilt as stateless wrappers over it. The three stores are proven near-duplicates (184 of ~1,092 normalized lines differ); the discovery gate already lets a core wrapper reach a searchable engine for free, but **`context.callTool` is routed to neither lane guard**, so a wrapper write on a worker replica is lost silently. Sixteen decisions made (route via `harness.runtime.*`; per-collection `storeRev`/change log; declared collections plus `define`; task's uniform envelope; `task`→`tasks` while the command stays `/task`; attribution immutable; authorship grants nothing; engine errors need stable codes — today `HarnessError` carries only a message, so a wrapper cannot translate one; **no locks, no claims**). **No product question remains open** — Q1-Q6 are all answered, and the round-7 ruling that deleted claims supersedes parts of R1, R3, F11, F16 and Decisions H, L, N, O (each marked `corrected` in place). Opens with a staleness warning: `src/harness.ts` grew ~9 KB during the audit, so anchor on identifiers, not line numbers. |

## Format

1. **Date / Method / Scope** — how the finding was produced, so it can be re-run.
2. **Findings** — one numbered section per finding, each with observed behaviour
   and `path:line` evidence.
3. **Tasks** — the work needed, per finding, each with a closing check.
4. **Not tested** — claims that were assumed but never exercised.

Rules: a finding is marked `corrected` rather than deleted when a later check
overturns it, and the original claim is kept so the reasoning is auditable. A
claim without a `path:line` reference is marked `unconfirmed`.
