# 0004 — No pre-request context guard, and no provider overflow classification

> **Status:** Open — reduced on 2026-11-08 (closed parts deleted)
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
  different number from the one the UI's context bar and the compaction plugin use;
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
per-agent context limit possible" (`src/types/index.ts:3254-3260`).

So the remaining gap is not a missing component. It is that the guard belongs nowhere in the
documented request path, and the vocabulary for "this transcript is too big" does not exist on
the wire.

## Evidence

| Fact | Source |
|---|---|
| `agent()` explicitly owns no compaction | `src/core/agent.ts:3-11` |
| A streamed request posts the full transcript, unguarded | `src/transport/openai.ts:770-785` |
| Every non-2xx collapses to one error frame carrying status + raw body text | `src/transport/openai.ts:792-796` |
| No `contextWindow` / `maxPromptTokens` field on provider or agent configuration | `src/types/index.ts:334-354` (`HarnessSampling`, `HarnessProviderConfiguration`); grep `contextWindow\|maxPromptTokens` over `src/types/index.ts` → 0 matches |
| The estimator is internal: defined in core, imported by the harness, never re-exported | `src/core/context-estimate.ts:108`; `src/harness.ts:372` (import), `:7587` (the only production call site) |
| The root barrel's public-surface block exports no context helper; the only star-export is types | `src/harness.ts:10193` (the `export { agent, tool, … }` public-surface block), `:10328` (`export type * from './types'`) |
| The limit is plugin settings, not provider config, and is checked at the turn boundary | `src/plugins/context-compaction.plugin.ts:103` (`contextLimit`), `:115` (default), `:223`, `:234` (the comparison) |
| A per-request retry re-sends the same oversized request, so an overflow costs the full backoff ladder; cancellation is the one existing non-retriable precedent | `src/core/agent.ts:691-698` (`isAbortError` rethrows before the backoff), `:316-322` |
| README documents none of this | grep `context-compaction\|turn.before\|estimatedTokens\|contextLimit` over `README.md` → 0 matches; `README.md:356` still states only "no compaction" |

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

