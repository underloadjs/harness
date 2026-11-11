# 0004 — No pre-request context guard, and no provider overflow classification

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11) — closed**)
> **Severity:** Minor (was Significant — the remaining gap is a guard and an error
> classification, not a missing capability)
> **Area:** `src/transport/openai.ts`, `src/core/agent.ts`, `src/types/index.ts`, `src/harness.ts`
> **Date opened:** 2026-11-02

## Context

Any host that owns conversation transcripts (the harness server's own sessions, and a
distribution building its own chat endpoint on `agent()`) eventually sends a history that
no longer fits the model's window. Today the request is simply sent and the provider's
rejection comes back as a generic transport error, after the round trip has already been
paid for. What is still missing is anything that stops an oversized request from leaving,
and any way to tell an overflow from a broken credential.

## Gap

What a consumer still cannot do:

- **guard a request before it is sent.** Nothing compares the size of the transcript about
  to leave against a configured model window and fails before `fetch`; the only limit in
  the product lives in one plugin's settings and applies only when that plugin is enabled;
- **recognise an overflow.** A provider's "input too long" 400/413 is indistinguishable
  from any other non-2xx, and with the default retry policy the same oversized request is
  re-sent through the whole backoff ladder before the caller sees anything;
- **use the package's own estimate.** The estimator exists but is not on the published
  surface, so a host trimming its own history still invents its own heuristic and gets a
  different number from the one the UI's context bar and the compaction plugin use
  (as of 2026-11-09 that divergence is wider, not smaller: the compaction trigger now
  compares a provider-anchored hybrid — `estimateContextTokensHybrid` once a request
  has reported `usage` — while the context bar stays pure chars/4, and neither name is
  exported);
- **find out what the package does about context size.** The README still says only that
  `agent()` owns no compaction; it never says where that policy lives or what the estimate
  counts.

## Why it is the way it is

Deliberate layering, stated: `agent()` "owns no other policy: no tool execution, **no
compaction**, no planning" (`src/core/agent.ts:3-11`), and the dependency-free rule
(`README.md:12-14`) rules out shipping a real tokenizer — which `src/core/context-estimate.ts`
argues at length in its header. Compaction policy was placed at the plugin bus on purpose:
`turn.before` is documented as "the ONLY hook whose return value matters (it may replace the
transcript the provider is about to see) … that is what makes context compaction and the
per-agent context limit possible" (`src/types/index.ts:3709-3713`).

So the remaining gap is not a missing component. It is that the guard belongs nowhere in the
documented request path, and the vocabulary for "this transcript is too big" does not exist on
the wire.

## Evidence

| Fact | Source |
|---|---|
| `agent()` explicitly owns no compaction | `src/core/agent.ts:3-11` |
| A streamed request posts the full transcript, unguarded | `src/transport/openai.ts:812-837` |
| Every non-2xx collapses to one error frame carrying status + raw body text | `src/transport/openai.ts:844-847` |
| No `contextWindow` / `maxPromptTokens` field on provider or agent configuration | `src/types/index.ts:447-467` (`HarnessSampling`, `HarnessProviderConfiguration`), `:409-417` (`HarnessStreamRequest`); grep `contextWindow\|maxPromptTokens` over `src/types/index.ts` → 0 matches |
| The estimator is internal: defined in core, imported by the harness, never re-exported — re-checked **2026-11-09** and still true: the hybrid sibling (`estimateContextTokensHybrid`) landed with compaction T5.4 and is **also** not on the published surface (neither `src/core/index.ts` nor the root export block re-exports either name) | `src/core/context-estimate.ts:167` (`estimateContextTokens`), `:250` (hybrid), `:221` (`anchorFromUsage`); `src/harness.ts:388-392` (imports the hybrid), `:9150`/`:9161` (the two `turn.before` estimates), `src/core/context-pruning.ts:90,361` (the floor) — and grep `estimateContextTokens` over `src/index.ts` / the root `export {` block / `dist/index.d.ts` → no match |
| The root barrel's public-surface block exports no context helper; the only star-export is types | `src/harness.ts:11988` (the `export { agent, tool, … }` public-surface block), `:12135` (`export type * from './types'`) |
| The limit is plugin settings, not provider config, and is checked at the turn boundary | `src/plugins/context-compaction.plugin.ts:377` (`contextLimit`), `:380`/`:439` (the default, written twice by design), `:657` (the resolved limit), `:1375`/`:1442` (the turn-boundary read and the comparison that fires the pass) |
| A per-request retry re-sends the same oversized request, so an overflow costs the full backoff ladder; cancellation is the one existing non-retriable precedent | `src/core/agent.ts:405` (`isAbortError`), `:816` (the abort boundary — the rethrow before the backoff), `:25-30` (the retry-policy comment) |
| README documents none of this — re-checked **2026-11-09**: `turn.before` now appears as the hook a context policy writes through (the transcript-routes paragraph and the `plugins` configuration row), but the README still never names the estimator, the `contextLimit` setting, or the shipped `context-compaction` plugin, and the `agent()` section still states only "no compaction" | grep `context-compaction\|contextLimit\|estimatedTokens\|estimateContextTokens` over `README.md` → 0 matches (grep `turn.before` → the flag/plugins rows); the "no compaction" line stands where it was |

## Proposal

**Smallest useful change, in this order:**

1. **Publish the estimator.** Export `estimateContextTokens` from the root barrel. It is
   already total (nothing throws), dependency-free, and uses the same `ceil(chars / 4)`
   convention as the frontend's context bar, so a host's own trimming and the product's own
   limit stop disagreeing. This is one line of the public-surface block.
2. **A pre-request guard.** Accept `provider.contextWindow?: number` /
   `agent({ maxPromptTokens })`. When the estimate exceeds the window, fail **before**
   fetch with a distinct typed error (`'context-overflow'`) naming the estimate and the
   window, which the retry layer must treat as non-retriable — cancellation already has that
   precedent, so the mechanism exists.
3. **Classify the provider's own overflow answer.** A small, explicit recognition of
   400/413 context errors (status + a documented message pattern) so the frame says
   `context-overflow` instead of dumping a raw body.
4. **Say what the package does.** One README paragraph next to the existing "no compaction"
   line: the estimate exists and what it counts, `turn.before` is where replacement policy
   lives, and the shipped `context-compaction` plugin is the reference implementation with a
   `contextLimit` setting.

**Alternatives considered.**

- *"Hosts can trim before calling."* True, and what the reference consumers do today — but
  they cannot get a stable estimate (no exported helper), cannot distinguish an overflow
  failure, and have no seam that keeps the transcript in history while sending a shorter
  projection.
- *Move the limit from plugin settings into provider config.* Rejected: the plugin seam is
  the right home for a policy that may want to summarise rather than refuse. The guard in
  (2) is a *floor* (a request that cannot fit is a bug), not a second policy owner.
- *Built-in LLM summarisation.* Rejected: it spends model requests and invents policy that
  belongs to the product. The seam already exists; the host fills it.
- *A real tokenizer.* Rejected: a dependency, and a false promise of exactness across
  gateways.

## Acceptance criteria

1. A caller can ask "will this transcript fit?" with one exported helper, and the helper's
   doc states it is an estimate and how it is derived.
2. Setting a window produces a typed, **non-retried** failure before any request is made,
   and the error names the measured estimate and the window.
3. A provider-side context overflow is reported distinctly from a generic transport error.
4. `README.md` states plainly what the package does and does not do about context size,
   next to the existing "no compaction" line, and points at the plugin that owns the limit.

## Tests to add

- `src/core/agent.test.ts` — overflow guard fires before fetch (assert fetch was not
  called); the error is not retried; an unset window keeps today's behaviour byte-identical.
- `src/transport/openai.test.ts` — 400/413 context patterns map to `context-overflow`; an
  unrelated 400 keeps the raw detail.
- `src/structure.test.ts` / `scripts/check-package-types.mjs` — `estimateContextTokens` is
  present in the root barrel and type-checks for both the NodeNext and the
  `customConditions: ["browser"]` consumer.

## Out of scope

- Summarisation strategies, session memory, retrieval.
- Cost accounting/UI (the server already folds usage per turn and per session).
- Streaming a partial reply on overflow.
- Changing where the compaction policy lives (the plugin bus is correct).

## Update (2026-11-11)

- **Anchors re-grounded** against the current tree; status stays **Open** and no
  part closed. Re-checked on the way: `grep` for `contextWindow` /
  `maxPromptTokens` over
  `src/types/index.ts` is still 0 matches, `estimateContextTokens` is still
  absent from the root public-surface block (`src/harness.ts:11988-12004` — only
  `export type * from './types'` at `:12135` carries types out), and
  `agent()` still owns "no compaction" (`src/core/agent.ts:3-11`,
  `README.md:379`).
- Re-pointed anchors: the unguarded full-transcript post is
  `src/transport/openai.ts:812-837`, the non-2xx collapse `:844-847`; the
  `turn.before` estimates are `src/harness.ts:9150`/`:9161` (the hybrid import
  stays at `:388-392`); the compaction plugin's `contextLimit` is `:377` with its
  duplicated default at `:380`/`:439`, the resolved limit at `:657` and the
  turn-boundary read and comparison at `:1375`/`:1442`; the abort precedent is
  `src/core/agent.ts:405` (`isAbortError`) and `:816` (the rethrow before the
  backoff). The `turn.before` hook documentation this issue quotes moved to
  `src/types/index.ts:3709-3713`.
- `src/core/context-estimate.ts:167`/`:221`/`:250`,
  `src/core/context-pruning.ts:90`/`:361`, `src/core/agent.ts:25-30` and
  `README.md:12-14` were re-checked and are still exact.

## Update (2026-11-11) — closed

All four parts of the proposal shipped, in the proposal's order, and nothing was
redesigned: the estimator is published, the guard is a floor that refuses before the
socket opens, the provider's own overflow answer is a named failure, and the README
says what the package does. **Gap**, **Evidence**, **Proposal**, **Acceptance
criteria** and **Tests to add** are left as filed — the issue closed whole, not in
part, so nothing is deleted from them; the section below records what shipped and what
the implementation settled that the proposal left open.

**What shipped**

- **(1) The estimator is public.** `estimateContextTokens` is re-exported from the
  root barrel (`src/harness.ts:12008-12015`, through
  `src/core/index.ts:282-291`), with the contract — an estimate, `ceil(chars / 4)`,
  what it counts and what it excludes — stated on the helper itself
  (`src/core/context-estimate.ts:161-181`).
- **(2) The pre-request guard.** `provider.contextWindow`
  (`src/types/index.ts:581-605`) and `agent({ maxPromptTokens })`
  (`src/types/index.ts:659-682`), validated at construction (`requireContextWindow`,
  `src/core/agent.ts:551-589`), enforced on the exact transcript about to be sent and
  **outside** the retry sequence (`src/core/agent.ts:908-958`): a typed
  `context-overflow` (`HarnessError.code`, also `error.name`, also the first token of
  the message) naming the estimate and the window, with
  `details: { estimatedTokens, contextWindow, model, agent }` for a caller that has to
  recover. No fetch, no retry, no `retry` event, and `stream()` still rolls its own
  prompt back.
- **(3) The provider's own overflow answer.** A 413 (by status) or a 400 whose body
  matches one of eight documented wordings
  (`CONTEXT_OVERFLOW_PATTERNS` / `isContextOverflowResponse`,
  `src/transport/openai.ts:1082-1091`/`:1116-1121`) yields an error frame carrying
  `code: 'context-overflow'` (`:1063`) and a message that leads with it, quoting at
  most 300 collapsed characters of the provider's line instead of the whole body
  (`:1295-1313`). The frame's optional `code` (`HarnessStreamEvent`,
  `src/types/index.ts:447-459`) rides onto the thrown `HarnessError` in
  `attemptRequest` (`src/core/agent.ts:1018`/`:1048`), and the retry owner rethrows
  that code on the first attempt (`src/core/agent.ts:1108-1121`) — cancellation's
  precedent, as this issue said.
- **(4) The README.** A paragraph in the `agent()` section, immediately after the
  "no compaction" line, states what is measured, what the estimate counts and
  excludes, what the floor refuses, what is never retried, and that
  `turn.before` plus the shipped `context-compaction` plugin (`contextLimit`) own
  replacement policy.

**Decisions the proposal left open, and what the implementation chose**

- **One guard, in the agent.** `provider.contextWindow` is enforced by `agent()`, not
  by `openAICompatible`, so the same floor covers a custom `stream` and the failure
  lands where the retry decision lives. A host calling the transport directly has no
  guard and measures with the published helper — stated on the field.
- **`maxPromptTokens` wins over `provider.contextWindow`** (agent scope is narrower
  than endpoint scope), and **both** spellings are validated even when one is shadowed,
  so a typo in the losing field is not a silently dead setting.
- **Checked after `turn.before`.** The guard measures the projection it is handed, so
  a compaction pass gets its chance to shrink the transcript first and the floor only
  refuses what survives policy — the "floor, not a second policy owner" line from the
  proposal, made literal.
- **Status-gated classification.** Only 413 and 400 can be an overflow, whatever the
  body says: a 401 or a 5xx quoting the provider's own context docs stays the plain
  frame it always was, because the remedy there is not "send less". A 400 that matches
  no pattern keeps its raw detail, so the worst case is the pre-0004 frame, never a
  wrong diagnosis.
- **Fork and thread inherit the floor**, re-spelled as `maxPromptTokens` because both
  carry the resolved transport rather than the provider block — a branch that dropped
  it would send what its source refuses.
- **Only the plain estimator is published.** The provider-anchored
  `estimateContextTokensHybrid` and its `ContextTokenAnchor` stay internal; the
  proposal publishes the one helper a host needs, and a host that wants the anchored
  number and the heuristic to agree has to wait for a reason to publish the anchor.
- **The refusal says what the estimate does not see.** Both the guard's message and the
  provider frame's message name the exclusions (attachment bytes, and the tool schemas
  that ride in the same request body). A host that reads only "estimated 100 against a
  99 window" would reach for the wrong knob: those tokens are real and are outside the
  measurement, so a tool-heavy agent has to shrink its schemas or its media, not its
  transcript.

**Tests** — `src/core/agent.test.ts` (12 cases: the published helper and code, refusal
before `fetch`, zero transport calls and no `retry` event under a 3-retry policy, the
`details` pair, a fitting transcript sent byte-for-byte, the projection path, a
provider overflow frame not retried, an ordinary failure still retried with no code on
its payloads, both precedence directions, construction-time validation, and a fork);
`src/transport/openai.test.ts` (8 cases: the OpenAI and Anthropic wordings, a 413 by
status, all eight patterns, an unrelated 400 and four non-overflow statuses keeping
the raw frame with no `code` key, and the whitespace collapse and 300-character cap);
`src/structure.test.ts` (the root barrel carries the helper and the code); and
`scripts/check-package-types.mjs` carries both names plus both configuration fields in
the NodeNext and `customConditions: ["browser"]` consumer fixtures.

