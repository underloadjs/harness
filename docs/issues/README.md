# Issue log

Open gaps and improvement requests against `@underload/harness`. Each file is one
issue: a verified gap between what a consumer needs and what the published
surface provides, with the evidence needed to re-check it.

These are **not** bug reports about behaviour that contradicts the docs. Every
entry below describes behaviour the package implements on purpose; the issue is
that the documented design leaves a consumer unable to reach a capability the
package's own model already implies. Where the omission is deliberate (a
security rule, a dependency rule, a gateway-compatibility rule) that is stated in
**Why it is the way it is**, and the proposal works inside the rule instead
of against it.

The log currently holds **seven entries**: 0007 (the review list) plus six live gaps —
0017, 0023, 0026, 0037, 0038 and 0039. Every other entry these passes produced has closed — fixed at
HEAD, refuted, or reduced to an alternative the owner declined — and the file and the
index row are deleted as the Format section below requires, with any surviving note moved
into 0007 or into one of the entries above. The paragraphs that used to introduce those
batches therefore describe only what is left of them. The most recent closure is **0032**
(closed 2026-11-26): the bounded `toolActivity` tally it proposed is shipped, so a stopped run's
tool calls are now a ledger fact on both doors, in worker mode, and across a restart.

The records-store stress test — 7 threads across 5 agents writing the same collections
concurrently — found no defect in the concurrency contract: no lost updates under a
same-`rev` race, `mergeDisjoint` refused an overlapping-field merge, and every batch was
atomic (no partial write on a rejected call). Its entries were the ergonomics and
consistency gaps around that core, not defects in it, and all of them have shipped; the
findings from that run that are doc wording or a wrong unit on one key live in 0007.

The web-tool stress test — 40+ calls against live providers, then re-checked reviewer by
reviewer — has no standalone entry either. Several claims as first filed were **refuted**
(a "mismatch" that was gzip compressed-vs-decoded length, a `pageCharacters` figure that
was correct, a `query`-mode exclusion that would have broken correct answers) and those
refutations are recorded in 0007 so the same claim is not re-filed; what survived that
pass is 0007's web-tools section.

Two Minor gaps survive from the `delegate` passes. **0023**: `scope.tools` is applied as a
membership test and never resolved against the registry, so a listed name that matches no
tool starves the child's toolbox and the delegation still answers `status: "completed"`
with no signal to the parent. **0026**: re-verified 2026-11-16, the page ceiling is one
constant (`src/core/agent-limits.ts:29`) feeding one derivation helper
(`delegatePageLimitOf`, `src/harness.ts:4547-4553`), so the over-ceiling `limit: 9000`
observation this entry was first filed with is **refuted**; it stays open for the two
things that re-verification did not close — the schema and prose copies of that ceiling
carry no equality pin, and a page clamped down from an over-ceiling request is still
reported as though it were the bound the caller asked for.

**0032** was the only one of the three entries the 2026-11-14 `delegate`/thread reconciliation pass
filed that outlived the passes after it, and it **closed on 2026-11-26** with the bounded
`toolActivity` tally it proposed — a stopped run's calls, how many of them reached an outcome, and
the up-to-8 busiest names, on `delegate`'s unfinished envelope, the `agentResult` row, the durable
snapshot and the lane archive chain. That pass's stress report is not in this repo, so what the entry
kept as an **unconfirmed** observation (whether a delegated child's own `tool` frames reach the
PARENT turn's session journal) survives as a row in 0007's Operations section rather than as a gap:
it is an operator-side surface, and 0032 itself listed it as out of scope.

**0017** is a porting gap rather than a runtime one: the Rust port has a plugin host, but
nothing executes a hook through it, so no display lane can be raised there and the
compaction bump cannot be ported.

**0037** and **0038** came from the 2026-11-19 tool-call-composition pass
([`../tasks/2026-11-19-tool-call-composition-visibility.md`](../tasks/2026-11-19-tool-call-composition-visibility.md))
and both describe the same residual from the two sides of one boundary: a model request that is
silent because it is **composing a tool block**. Neither is fixable inside this package (0017 holds
the precedent for an entry whose gap lives in another package): 0037 is the relay/gateway co-defect
(`packages/underload/service`, `runtime/endpoint/provider/private/*`,
`packages/agentic/provider/src/local/local-basalt.ts`) — no per-request provider log, SSE
keep-alive comments consumed by the SDK decoder inside the relay hop, a seven-relay rotation that
silence neither triggers nor attributes — and 0038 is the harness-side half, where one attempt is
bounded only by three provider **idle** bounds because there is no per-attempt total clock, and
`MODEL_TIMEOUT_MAX_MS` (3 600 000) is a ceiling on a *model-settable* `delegate`/`threadFork` bound
rather than a request clock (`src/core/agent-limits.ts:74-81`). Both carry the deliberate-policy
note: the generous defaults are recorded on purpose at `src/transport/provider-timeouts.ts:41-66`,
and nothing was retuned to ship the visibility fix.

**0039** is a **latent** one, recorded rather than fixed: a `toolFolders` entry that declares
`registration.mode` has that mode **inert at runtime** — discovery hands back `mode:'async',
origin:'folder'` while the published registry object answers `.mode === undefined` and the call runs
sync. Harness and the `async-ping` plugin currently **agree** on sync, so nothing shipped loses
hang-visibility; what keeps the entry open is that discovery already advertises a policy the runtime
does not honour, and that the plugin's `'sync'` fallback turns into under-pinging the moment core
starts honouring the row it is shown. None of the five shipped folder tools declares a mode, and no
shipped test covers the folder-mode contract.

## Index

| Issue | Area | Severity | One line |
|---|---|---|---|
| [0007](./review-list-improvements-review-list.md) | cross-cutting | Review list | Everything else found during review — plus the records-store stress-test items that are doc wording or a wrong unit on one key — listed separately for the package owner to triage. |
| [0017](./minor-rust-port-context-lane-drift.md) | rust port | Minor | **Open.** The display lane is ported end to end in `packages/typecrate/harness`: `ContextBlock.lane` is in the contract with swagger `:8122`'s `minimum: 0` / absent-means-zero reading, the fold stamps every segment from its own source (one mint point, no patch key), the durable turn/thread lanes round-trip, and the recorded two-lane TypeScript fixture pins the parity in 11 tests. **Still open:** nothing in the port can *raise* a lane — the plugin host **is** ported (`packages/typecrate/harness/src/plugin/host.rs`) but is not integrated: `NullRuntime` is the only type that implements `PluginRuntime` (`src/plugin/context.rs:391`), so the `set_context_lane` the trait declares (`:340`) exists only as `NullRuntime`'s empty body (`:404`) and has no caller anywhere in the crate — nothing can fire a hook, so the compaction bump is blocked; that is the only gap left in the file. |
| [0023](./minor-scope-tools-accepts-names-that-resolve-to-no-tool.md) | delegation / tool scope | Minor | `scope.tools` is applied as a membership test and never resolved against the registry, so `scope: { tools: ["read", "wri"] }` started a child whose allowlist really was `read, wri` and finished `status: "completed"` with a starved toolbox and no signal to the parent. |
| [0026](./minor-maxchars-ceiling-is-enforced-in-three-places-that-can-drift.md) | delegation / limits | Minor | The ceiling used to live as a schema bound, a prose number and a runtime clamp against a fourth constant, and a live process reported `limit: 9000` for a `maxChars: 9000` request with `truncated: false`. **Re-verified 2026-11-16 — the defect is refuted; the entry stays Open.** The ceiling is now ONE constant (`AGENT_RESULT_PAGE_MAX_CHARS`, `src/core/agent-limits.ts:29`) feeding ONE derivation helper (`delegatePageLimitOf`, `src/harness.ts:4547-4553`), so the four-way drift surface the title names no longer exists and no current build answers 9000. What keeps it open is what the re-verification did NOT close: the `delegate` schema and prose copies of that number carry **no equality pin** — `src/core/metadata.ownership.test.ts:407` is the file's only `maxChars` assertion and it pins the parameter NAME inside a `toEqual` key list, while the same file pins `agentResult.limit` completely against the constant at `:436-439` (`.maximum` plus the whole description string) and pins the constants themselves at `:422-428` — and a page clamped down from an over-ceiling request is still reported as though it were the bound the caller asked for. |

| [0037](./minor-relay-gateway-silence-adds-no-per-request-provider-log.md) | upstream relay / gateway (**owning code outside this package**) | Minor | **Open, filed 2026-11-19.** A silent upstream cannot be seen or attributed: the relay's only per-request line is a token tally written AFTER the stream settles (`runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts:174-181, 210-217`), upstream SSE keep-alive comments are consumed by the OpenAI SDK's decoder inside the relay hop (`node_modules/openai/src/core/streaming.ts:321-324`, and the relay re-emits only `data:` lines at `:162-164`), the SEVEN named basalt relays rotate only on a 404-class failover while the registry clients are shared process-wide (`config/vault/src/services/basalt.ts:2-37`; `packages/agentic/provider/src/local/local-basalt.ts:156-159, 231-246`; `…/private-chat-completion.ts:99, 108-122`), and the client has no heartbeat during upstream silence — so its only mid-stream bound is the 120 s between-reads one, and a tool block over 120 s of silence is killed and re-generated from token 1. Consequence of the engine at the end of that chain withholding the whole tool region (`services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100, 993-1003`). The generous bounds are deliberate and recorded (`src/transport/provider-timeouts.ts:41-66`); the proposal is flight logging, a heartbeat that survives the hop, and silence-triggered rotation — never a tighter default. |
| [0038](./minor-long-tool-block-has-no-per-attempt-total-clock.md) | transport / timeouts | Minor | **Open, filed 2026-11-19 — deliberate policy, recorded not refuted.** One model attempt has no total wall clock: head 300 000 ms, first token 300 000 ms and between-reads 120 000 ms are all IDLE bounds (`src/transport/provider-timeouts.ts:150-152`), so a stream that trickles one frame every 119 s runs forever — pinned by `src/transport/openai.tool-call-liveness.test.ts:607` (past 3 600 000 ms with no bound firing), with `:688` pinning the pair (nothing fires at 62 s, `stream-chunk` fires at exactly 120 s). The 900 000 ms deadline belongs to the 4-attempt `provider-timeout` LADDER and only exists once a bound tripped (`src/core/agent-limits.ts:192-202, 221`; `src/core/agent.ts:1380-1385, 1402-1424`). `MODEL_TIMEOUT_MAX_MS` = 3 600 000 is a ceiling on what a MODEL may ask `delegate`/`threadFork` to wait, not a request clock (`src/core/agent-limits.ts:74-81`). Proposal: publish the worst-case arithmetic, then an OPT-IN `provider.totalTimeoutMs` (default `0` = no bound) that trips the existing `provider-timeout` class — no new code, no new ladder, no default changed. |
| [0039](./minor-folder-tool-registration-mode-is-inert-at-runtime.md) | tool registration / `toolFolders` entries | Minor (**latent — record only, nothing user-visible today**) | **Open, filed 2026-11-19.** A folder entry's declared `registration.mode` is inert: `discoverToolMetadata` returns `{ mode: 'async', origin: 'folder' }` for it, yet the published registry object answers `.mode === undefined` and the run PARKS (measured 2026-11-19 with `Temp/review-sleep/probe10.ts` + the `foldertool` fixture: 2 model requests, 0 heartbeat wakeups). Mechanism: folder entries are registered by the separate ordered loop (`src/harness.ts:6003-6019` → `registerAtStartup:3102-3103`) and never pass through `registerDescriptor`, the one site that binds a discovered mode into the `modeDefinitions` WeakMap `effectiveToolMode` reads (`src/harness.ts:3945`, `:1927-1928`); the plugin's table is package-rows-only (`src/core/tool-metadata.ts:157`), so a folder name is a registry hit with no row → step 3, `'sync'` (`src/plugins/async-ping.plugin.ts:288-297`). Harness and plugin therefore AGREE today — no shipped configuration loses hang-visibility — and none of the five shipped folder tools declares a mode at all; the risk is the flip: discovery already reports the row as async, so the moment core honours it the plugin UNDER-pings, the one direction its header promises to protect against (`:50-55`). Fix proposal: carry the mode onto the published definition the way `harness({ tools })` already does (`src/harness.ts:6045`), so both consumers see it — no shipped test covers this contract today. |

## Format

Every issue file uses the same sections, in this order, so an owner can compare
entries and decide without re-reading the source:

1. **Status / Severity / Area / Date opened.**
2. **Context** — who hit it and what they were building. One paragraph.
3. **Gap** — what the consumer needs, stated as a capability, not as a fix.
4. **Why it is the way it is** — the existing design rule, with the source
   reference that proves it is intentional. If this section is empty the issue
   is an oversight, not a trade-off.
5. **Evidence** — `path:line` facts only. A reader must be able to re-check
   every claim in minutes.
6. **Proposal** — the smallest change that closes the gap, plus alternatives
   considered and why they were rejected.
7. **Acceptance criteria** — observable conditions that close the issue.
8. **Tests to add** — the named test files that must cover it.
9. **Out of scope** — what this issue must not grow into.

Severity vocabulary: **Blocking** (a consumer cannot ship the feature at all
without forking the package), **Significant** (shippable only with meaningful
duplicated code), **Minor** (ergonomics or drift risk), **Review list**
(no single fix, decisions to make).

Rules of the log: an issue is never edited to hide a regression — a correction
goes in a `## Update` section with its own date; **when part of an issue is
closed, that part is deleted outright — from the title, from **Gap**, from the
**Evidence** table, from **Proposal**, from **Acceptance criteria** and from
**Tests to add** — and the header records the reduction with its date. A closed
item is not kept as a footnote or a changelog entry: the log holds only live
gaps, and the history of what was removed is git's, not the file's**; when a
whole issue closes, the file is deleted and its index row dropped, and any
surviving note moves into a sibling issue or into 0007; a claim without a source
reference is marked `unconfirmed`.
