# Task log

Actionable work items found while exercising `@underload/harness` from inside a
live session. Unlike `../issues/` — which records design-level gaps between what
a consumer needs and what the published surface provides — a file here is a
task list: each entry names the change, the file it touches, and the check that
closes it.

## Index

| File | Area | One line |
|---|---|---|
| [2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) | plugins / server / workers | Stage 2, **trimmed 2026-11-09 — the stage landed and the landed work has been removed from the entry**; what is left is two probes. **Probe 1**: a plugin-visible mirror diagnostic event — the lifecycle catalogue is exactly 18 events (`src/types/index.ts:3428-3451`), no `plugin_error` exists, `configuration.report.diagnostic` (`:2961`) is host-only, and the event cannot be added before its **re-entrancy rule** is written (a reporter emitting into the bus can recurse). **Probe 2**: the same-actor `api.threads.send`-from-a-hook test that would replace a standing prohibition with an observation — only stubs exist, and `docs/plugins.md` keeps telling authors not to re-enter their own parked turn. Recorded as boundaries, not work: external plugin loading (the stage's answer is that only application-shipped code runs — no plugin list in `src/server/harnesses/toolbox.ts`, a replica builds without plugin input), `respond`/`retry` (the decision union is exactly `continue`/`replace`/`pause`/`stop`), capability tiers (design target only), the closed worker-lane rewrite residue (`transcript:patch` + `committedDigest` + `patchThreadMessages`), and the lane's deliberate no-op diagnostic sink. |
| [2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) | plugins / context | Stage 3, **trimmed 2026-11-09 — the pruner landed (the persisted tool outcome, the argument fingerprint, the pure rule in `src/core/context-pruning.ts`, its guards/settings/pass report, and the separable budget controls) and everything landed has been removed from the entry**. Open: **T5.3** — tool-result elision for superseded LARGE results, the `annotate` writer, blocked on Open decisions 2 and on nothing else (`COMPACTION_MODES` implements `exclude` only, `src/plugins/context-compaction.plugin.ts:222`, the degradation to `exclude` pinned at `src/plugin/context-compaction.test.ts:1036-1049`, and the candidate-list seam a second writer plugs in at `src/core/context-pruning.ts:12`/`:169`); **T6** — the summarize-and-reinitialize checkpoint, deliberately unbuilt, whose design text this entry still carries and which `knowledge.md:3861` ("Not built yet", item 2 at `:3866-3882`) names; **T7** — real-corpus / live-provider observations only (no real provider observed, no real pre-outcome `state.json`, prompt-cache cost and the tuning constants unmeasured, the UI-vs-plugin estimate divergence unquantified); and **T5.5** as a pointer to `../issues/0004-context-window-and-token-budget.md`, not a task. Open decisions 2/3/4 stay (1 and 5 closed and removed). Prune answered failures, never failures — with cited vendor/preprint evidence. |
| [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md) | context / plugins / UI | **Trimmed 2026-11-09 — every edge this entry named is closed and removed except one.** Open: **T7 — the shipped `included` flag has no UI.** Zero consumers of `included` in `src/frontend/` (the hits are prose or an unrelated local at `main.ts:1655`); the progress union `HarnessEvent` (`src/types/index.ts:2322-2486`) carries no inclusion field in any variant; no excluded-count or tokens-saved field exists server-side or in `src/shared/harness-api.ts`; and the compactor's per-pass diagnostic is already produced, journalled (`src/server/sessions.ts:3008-3028`, capped at `PLUGIN_DIAGNOSTIC_LIMIT`) and projected as `plugin_diagnostics` (`src/server/api-reads.ts:241-243`, typed at `src/shared/harness-api.ts:961`) yet consumed by nothing in the frontend. Closing check: a frontend test rendering the marker from a transcript with one `included: false` unit. Kept as one-line pointers, not tasks: T2's deferral rule (per-call inclusion waits for a named use case; call-level `toolCalls` patches are refused) and the T6.2 / T1.4 decision records (no read-side normalization; a fork copies ids). |

## Format

1. **Date / Method / Scope** — how the finding was produced, so it can be re-run.
2. **Findings** — one numbered section per finding, each with observed behaviour
   and `path:line` evidence.
3. **Tasks** — the work needed, per finding, each with a closing check.
4. **Not tested** — claims that were assumed but never exercised.

Rules: a finding is marked `corrected` rather than deleted when a later check
overturns it, and the original claim is kept so the reasoning is auditable. A
claim without a `path:line` reference is marked `unconfirmed`.
