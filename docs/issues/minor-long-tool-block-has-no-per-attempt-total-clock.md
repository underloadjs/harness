# 0038 — A long tool block is bounded only by provider idle bounds: there is no per-attempt total clock, and `MODEL_TIMEOUT_MAX_MS` is not one

> **Status:** Open — **filed 2026-11-19**, deliberate policy, recorded rather than refuted
> **Severity:** Minor (the residual is a missing bound nobody has asked to add; what was missing —
> visibility — shipped on 2026-11-19)
> **Area:** `src/transport/provider-timeouts.ts`, `src/core/agent-limits.ts`, `src/core/agent.ts`,
> `src/transport/openai.ts`
> **Date opened:** 2026-11-19

## Gap up front

One model request can run for an unbounded amount of wall clock, and the number that looks like
the ceiling — `MODEL_TIMEOUT_MAX_MS = 3 600 000` — is not a request clock at all: it ceilings what
a **model** may ask a `delegate` or `threadFork` to wait. During that unbounded request, the only
things watching are three **idle** bounds. A tool-call block is precisely the payload shape where
idle bounds are the weakest instrument, because a provider that is composing a large parallel tool
round can legitimately produce **zero bytes** for the whole block — so the request is either
silent-and-fine or silent-and-dead, and the client cannot tell until 120 s of silence have already
been spent.

## Context

Two live captures of the same relay family, 2026-11-19: one turn stalled **62.232 s** with no
frames and was aborted by the user, another completed the same shape after **27.683 s**
(`docs/tasks/2026-11-19-tool-call-composition-visibility.md`, Findings 1–2, with the probe output).
The post-mortem needed to answer "how long may this legitimately take, and what stops it". The
answer is: nothing on a total clock does, and the recorded generous defaults mean that was decided
more than once. The relay/gateway half of the same story is
[issue 0037](./minor-relay-gateway-silence-adds-no-per-request-provider-log.md).

## Gap

A caller needs one honest answer to **"what is the maximum wall clock for a single model
attempt?"** Today:

- the head bound (300 000 ms) bounds only `fetch` resolving with headers;
- the first-token bound (300 000 ms) bounds only the gap after the head;
- the stream-chunk bound (120 000 ms) bounds only the gap **between consecutive reads** — a stream
  that trickles one frame every 119 s never trips it and can run forever;
- the 900 000 ms deadline belongs to the **`provider-timeout` ladder**, i.e. it only exists once a
  bound has already fired; it never caps a single attempt that is still producing bytes.

So "119 s × N frames" is unbounded, and the documented contract does not claim otherwise — it just
does not say so where a caller would read it.

## Why it is the way it is

This is a decision, not an oversight, and it has been recorded three times:

- **The bounds are deliberately generous, because the previous behaviour was "wait forever" and a
  slow provider was still correct.** `src/transport/provider-timeouts.ts:41-66` states the rule and
  each figure's justification; `:150-152` ships `300_000 / 300_000 / 120_000`; `0` disables any one
  bound to restore the pre-T6 behaviour exactly.
- **Nothing external ends a run on a clock.** `knowledge.md`, "A THREAD has no wall-clock limit
  either (policy 2026-11-09)" (the paragraph that also carries the CORRECTED-IN-PLACE note that
  `delegate`'s default `timeoutMs` used to be a finite 300 000 ms); `src/core/agent-limits.ts:74-81`
  for the ceiling's real scope.
- **`MODEL_TIMEOUT_MAX_MS` bounds what a MODEL may ask for, not a request.** Its own comment: *"It
  bounds what a MODEL may ask for only — the host paths (`runtime.delegate`, harness config) are
  not schema-validated and may pass any finite bound, and the ABSENCE of a bound is
  `DELEGATE_TIMEOUT_MS` / `FORK_TIMEOUT_MS` above, not this number"*
  (`src/core/agent-limits.ts:74-81`), with `FORK_TIMEOUT_MS = Number.POSITIVE_INFINITY` (`:86-88`).
- **The generous defaults are what the shipped server actually uses**: the default provider
  configuration omits all three `*TimeoutMs` fields, so the transport resolves env → shipped default
  (`src/transport/openai.ts:1436-1452` via `resolveProviderTimeout`, read by the test at
  `src/transport/openai.tool-call-liveness.test.ts:607-620`).
- **The new `progress` frame is the mitigation that shipped instead of a clock** — it makes the
  silent block visible without deciding how long it may take (R5 of the task brief;
  `src/transport/openai.ts:1985-1989`, `src/harness.ts:13469-13478`). A total clock would be a
  policy change; a heartbeat is only information.

## Evidence

| Fact | Source |
|---|---|
| The three shipped bounds are head / first-token / between-reads | `src/transport/provider-timeouts.ts:150-152`; the "what each of them bounds" prose at `:47-66` |
| A stream that trickles never trips a bound, even past one hour | pinned by `src/transport/openai.tool-call-liveness.test.ts:607` ("lets a default-configured stream TRICKLE past 3 600 000 ms without any bound firing"); the pair pin at `:688` ("fires NOTHING at 62 s of silence and fires `stream-chunk` at exactly 120 s") |
| The 900 000 ms deadline is the **ladder's**, measured from the first attempt, and only exists for a `provider-timeout` | `src/core/agent-limits.ts:192-202, 221` (`PROVIDER_TIMEOUT_RETRY_DEADLINE_MS = 900_000`); `src/core/agent.ts:1380-1385, 1402-1424` (why a deadline and not only a count) |
| A `provider-timeout` re-sends the SAME request — so the arguments a block had already generated are discarded and the block is re-generated from token 1 | `src/core/agent.ts:1361-1385, 1402-1424`; `src/core/agent-limits.ts:179-207` |
| `MODEL_TIMEOUT_MAX_MS` is a model-settable ceiling, not a request clock | `src/core/agent-limits.ts:74-81` (comment quoted in **Why it is the way it is**) |
| No bound was changed by the 2026-11-19 fix | `src/transport/provider-timeouts.ts:150-152` unchanged; `git status` for `src/transport/**` shows `openai.ts` modified and `provider-timeouts.ts` untouched |
| A tool block really can be silent for the whole block on this workspace's engines | `services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100, 993-1003` (the tool region is withheld; one final SSE frame); `…/modal_qwen3_8_l40s_ninfer.py:984-993` ("stall detectors, and live progress consumers all stop working") |
| The transport's only mid-stream instruments are idle timers | `src/transport/openai.ts:738-769` (`guardedRead` arms a fresh timer per read and names the expired phase itself, `first-token` while nothing has been delivered, `stream-chunk` after — `:754`, `unref` `:760`) and `:778-799` (`raceHeadBound`, the response-head arm, `unref` `:790`); both `unref()` their timer, and the new `progress` frame adds **no** timer at all (`:1983-1989` reads `performance.now()` only) |
| The harness transport is plain `fetch`, so it inherits no SDK client timeout | the note at `knowledge.md:415-416` ("The DEFAULT transport still adds nothing — it is plain `fetch` (Node 18+)"); the SDK-level 30-minute ceiling exists only on the provider-package leg, `packages/agentic/provider/src/model-class.ts:624` |

## Proposal

State the bound where a caller reads it, then offer the escape hatch the operator actually wants:

1. **Publish the arithmetic.** Document (here and in `README.md`, "Transport") that a single
   attempt's worst case is `head + first-token + N × stream-chunk` with no ceiling on N, and that
   the 900 s figure belongs to the retry ladder. A caller choosing `provider.*TimeoutMs` needs that
   formula, not three unlabelled numbers.
2. **Offer an opt-in per-attempt wall clock** (`provider.totalTimeoutMs`, default `0` = no bound,
   same grammar as the other three, same env-var name convention
   — `src/transport/provider-timeouts.ts:154-158`) that trips the EXISTING `provider-timeout`
   class, so no new failure class, no new ladder, and the 4-attempt policy is reused unchanged.
   Default-off keeps the recorded policy intact for every existing host.
3. Keep `MODEL_TIMEOUT_MAX_MS` exactly as it is — a child-duration ceiling — and make its
   not-a-request-clock status impossible to misread by pointing at it from the transport docs.

**Alternatives considered.**

- *Turn one of the three idle bounds into a total clock by default.* Rejected: it silently changes
  a recorded policy decision (`src/transport/provider-timeouts.ts:41-66`) and would kill legitimate
  long generations — the exact risk the generous defaults exist to avoid.
- *Bound the tool block specifically (a "tool-composition timeout").* Rejected: the harness cannot
  distinguish a composing model from a wedged socket, which is the whole finding; and a tool-specific
  clock would be the first bound in this package that is not an idle gap.
- *Close the issue: `progress` made it visible, so the gap is closed.* Rejected: visibility answers
  "is it alive", not "how long may it take" — the operator who watches a composing line for eight
  minutes still has no bound to set.
- *Add a total clock on by default at some "sensible" figure.* Rejected until a live measurement
  exists: no live provider was dialled for this change (`docs/tasks/2026-11-19-tool-call-composition-visibility.md`,
  "Not tested"), so any default would be invented.

## Acceptance criteria

1. A reader of the transport docs can state the worst-case wall clock of one attempt, including
   that N is unbounded today.
2. An opt-in per-attempt clock exists with default `0` = no bound, and when it trips it produces the
   existing `provider-timeout` code and the existing 4-attempt ladder — no new code, no new ladder.
3. `MODEL_TIMEOUT_MAX_MS` is described beside its own scope at least once outside
   `src/core/agent-limits.ts`, so "3 600 000 = one hour per request" is not a readable inference.
4. The 2026-11-19 default figures are unchanged (`300_000 / 300_000 / 120_000`).

## Tests to add

- `src/transport/openai.provider-timeouts.test.ts` (the file that owns the bound matrix) — an
  opt-in `totalTimeoutMs` trips `provider-timeout` while a byte-per-119 s stream still runs
  unbounded under `totalTimeoutMs: 0`.
- `src/transport/openai.tool-call-liveness.test.ts` — extend the trickle pin at `:607` with the
  bounded counterpart, so the pair "no total clock by default / opt-in clock works" is one block.
- `src/core/metadata.ownership.test.ts` — if a fourth `provider.*` key is published, pin the new
  env-var name and default beside the existing three.

## Out of scope

- Changing any shipped default.
- Any new failure class or retry ladder.
- The relay/gateway half (issue 0037) and the visibility plane (shipped).
- A per-TURN budget: this entry is about one model attempt, and the package's no-external-clock
  policy for runs and threads is not reopened here.
