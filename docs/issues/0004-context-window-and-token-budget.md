# 0004 — No token counter, context-window guard, or compaction hook

> **Status:** Open
> **Severity:** Significant
> **Area:** `src/core/agent.ts`, `src/harness.ts`, `src/types/index.ts`
> **Date opened:** 2026-11-02

## Context

Any host that owns conversation transcripts (the harness server's own sessions,
and a distribution building its own chat endpoint on `agent()`) eventually
sends a history that no longer fits the model's window. Today the request is
simply sent and the provider's rejection comes back as a generic transport
error, after the round trip has already been paid for.

## Gap

The package has post-hoc accounting but no pre-request budget:

- no token counter or estimator of any kind, so a host cannot predict whether a
  transcript fits;
- no context-window guard: nothing compares prompt size against a configured
  model window before the request;
- no compaction/summarisation hook, and no documented extension point where a
  host would attach one;
- provider context-overflow failures are indistinguishable from any other
  non-2xx: the transport yields one error frame containing the status and the
  raw response text, so "reduce your history" and "bad API key" reach the caller
  identically;
- `usage` arrives only after a request succeeded, and `HarnessUsage.input`
  includes the replayed prefix, so a host can measure growth but cannot act
  before the next turn.

Net effect: every consumer re-implements the same trimming heuristic, and none
of them can tell an overlong transcript from a broken credential.

## Why it is the way it is

Deliberate layering, stated twice: `agent()` "owns no other policy: no tool
execution, **no compaction**, no planning" (`src/core/agent.ts:9`), and the
package ships byte budgets only for what it controls itself — the model-facing
tool result cap, `MODEL_TOOL_RESULT_BUDGET_BYTES = 64 * 1024`
(`src/core/result-budget.ts:42`, exported at `src/harness.ts:7458-7460`) — plus
`maxIterations`, which bounds **requests per run**, not context size
(`src/types/index.ts:1996-2010`). The dependency-free rule (`README.md:12-14`)
also rules out shipping a real tokenizer.

So the gap is not a missing component: it is that the design has no seam where
compaction belongs, and no vocabulary for "this transcript is too big".

## Evidence

| Fact | Source |
|---|---|
| `agent()` explicitly owns no compaction | `src/core/agent.ts:3-11` |
| `HarnessUsage` is response-side accounting; `input` includes the replayed prefix | `src/types/index.ts:154-168` |
| A streamed request posts the full transcript, unguarded | `src/transport/openai.ts:441-466` || Every non-2xx collapses to one error frame carrying status + body text | `src/transport/openai.ts:473-477` |
| The only budgets in the package are per-tool-result bytes and per-run iterations | `src/core/result-budget.ts:42`, `src/types/index.ts:1996-2010` |
| No tokenizer / estimator / window field exists anywhere in `src` | grep `tokeniz\|estimateTokens\|contextWindow\|maxPromptTokens` → 0 source matches |
| A per-request retry re-sends the same oversized request, so an overflow is retried 10 times before it surfaces | `src/core/agent.ts:13-30`, `src/types/index.ts:186-193` |

The last row is the sharp edge: with the default retry policy an
"input too long" 400 that the gateway surfaces as a 5xx-shaped or retriable
response costs the full 1s…512s backoff ladder before the caller sees it.

## Proposal

**Smallest useful change, in this order:**

1. **A documented estimator + a pre-request guard.** Export
   `estimatePromptTokens(messages, model?)` (character heuristic, no dependency,
   explicitly labelled an estimate) and accept
   `provider.contextWindow?: number` / `agent({ maxPromptTokens })`. When the
   estimate exceeds the window, fail **before** fetch with a distinct typed
   error (`'context-overflow'`), which the retry layer must treat as
   non-retriable — cancellation already has that non-retriable precedent at
   `src/core/agent.ts:556-558`, so the mechanism exists.
2. **A compaction seam at the harness layer, not the agent.** One optional hook,
   called with the transcript that is about to be sent, returning a replacement
   plus what was dropped:
   `compact?: (messages, { estimate, window }) => HarnessMessage[] | undefined`.
   The harness already projects the transcript per request through
   `AgentStreamOptions.transcript` (`src/types/index.ts:304-312`), so the seam
   exists; the hook only needs to be exposed and documented as "policy lives
   here".
3. **Classify the provider's own overflow answer.** A small, explicit
   recognition of 400/413 context errors (status + a documented message pattern)
   so the frame says `context-overflow` instead of a raw body dump.

**Alternatives considered.**

- *"Hosts can trim before calling."* True, and what the reference consumers do
  today — but they cannot get a stable estimate (no exported helper), cannot
  distinguish an overflow failure, and have no seam that keeps the transcript in
  history while sending a shorter projection. `transcript` is harness-internal
  today and its contract says "standalone callers never need this"
  (`src/types/index.ts:311`).
- *Built-in summarisation (LLM compaction).* Rejected for this issue: it spends
  model requests and invents policy that belongs to the product. Ship the seam;
  let the host fill it.
- *A real tokenizer.* Rejected: a dependency, and a false promise of exactness
  across gateways.

## Acceptance criteria

1. A caller can ask "will this transcript fit?" with one exported helper, and the
   helper's doc states it is an estimate and how it is derived.
2. Setting a window produces a typed, **non-retried** failure before any request
   is made, and the error names the measured estimate and the window.
3. A host can supply a compaction policy at the harness layer that (a) never
   rewrites committed history, and (b) is visible to the caller as an event or
   result field so the UI can show what was dropped.
4. A provider-side context overflow is reported distinctly from a generic
   transport error.
5. `README.md` Concepts section states plainly what the package does not do about
   context size, next to the existing "no compaction" line.

## Tests to add

- `src/core/agent.test.ts` — overflow guard fires before fetch (assert fetch was
  not called); the error is not retried; an unset window keeps today's behaviour
  byte-identical.
- `src/harness.test.ts` — the compaction hook is called with the about-to-send
  transcript, committed history is unchanged, and a hook that returns
  `undefined` means "send as-is".
- `src/transport/openai.test.ts` — 400/413 context patterns map to
  `context-overflow`; an unrelated 400 keeps the raw detail.
- `src/transport/models.ts` consumer test — nothing: models are unaffected.

## Out of scope

- Summarisation strategies, session memory, retrieval.
- Cost accounting/UI (the server already sums usage per turn).
- Streaming a partial reply on overflow.
