# 0037 — A silent upstream is invisible and unrecoverable: no per-request provider log, keep-alive comments die at the relay's decoder, and the rotation is shared

> **Status:** Open — **filed 2026-11-19** against the tree at nested-repo HEAD `142bf90`; the code
> that has to change is **outside this package** (see **Where the owning code lives**)
> **Severity:** Minor (ergonomics and forensics: the request itself succeeds or fails on rules
> this workspace chose on purpose — what is missing is the ability to see and attribute it)
> **Area:** relay/gateway chain in front of a harness provider leg —
> `packages/underload/service`, `runtime/endpoint/provider/private/*`,
> `packages/agentic/provider/src/local/local-basalt.ts`, `config/vault/src/services/basalt.ts`
> **Date opened:** 2026-11-19

## Gap up front

When a provider leg goes quiet in the middle of a long generation, the operator cannot answer
three questions from any artifact this workspace writes: **which relay** was serving, **when** the
request started and whether any byte ever arrived, and **whether the upstream was actually
sending anything** while the client watched a spinner. Four independent facts compose into that
blind spot, and each one is individually reasonable:

1. the relay's only per-request log line is a **token tally written when the stream ends**, so a
   request that dies mid-flight logs nothing;
2. upstream SSE **keep-alive comments (`: ping`) are consumed by the OpenAI SDK decoder inside the
   relay hop and never re-emitted**, so a comment-based heartbeat cannot cross the hop;
3. the failover **rotation over the seven named relays is process-wide shared** and advances only
   on a 404, so silence neither rotates nor is attributed;
4. the harness client has **no heartbeat of its own during upstream silence**, so its only
   mid-stream bound is the 120 s between-reads bound — which means a tool block longer than 120 s
   of silence is killed and **re-generated from token 1**.

This is the co-defect behind the incident recorded in
[`docs/tasks/2026-11-19-tool-call-composition-visibility.md`](../tasks/2026-11-19-tool-call-composition-visibility.md):
the two captures show 27.683 s and 62.232 s of **zero frames** inside a tool-call block, and a
third shape (`Temp/d1/analysis.out`, the thread-1 timeline at `t+734s … t+1068s`) shows what the
same stack does when the death is recognised — eleven `provider-transit` attempts and a rollback.

## Context

A live `instruct` session (model `local/basalt`) stalled 62.232 s with no frames and was aborted
by the user; a second capture of the same relay family completed the same shape after 27.683 s.
The post-mortem needed to say which upstream served each request and whether that upstream had
emitted anything during the stall. It could not: the session journal records the harness side only
(`…/temporary/dump/harness/sessions/beed8a0c-…/events.jsonl`, zero `delegate` frames), and the
relay's own stdout records only a per-request token line written after the stream settles. The
`provider` diagnostics added on 2026-11-17 name the dialled URL/port/class, not the relay behind
it, and the relay's upstream name is deliberately a secret-shaped value (a name, never a URL).

## Gap

A consumer needs one answer to: **"was that request alive, on which upstream, and what did that
upstream send while I waited?"** Today the answer is reconstructible only by re-running the
request with a proxy attached. The capability requested — not a fix:

- a request that is **in flight and silent** is distinguishable from one that is **in flight and
  producing**, and from one that was **cut**, from artifacts already being written;
- the **relay identity** that served a request is recoverable for that request, including for a
  request that never produced a final chunk;
- a keep-alive written by an upstream is **not silently consumed** by the hop that decodes it.

## Why it is the way it is

Every half of this is an intentional rule, and the harness half is a recorded decision, not an
oversight:

- **The provider bounds are deliberately generous, and the generosity is the documented reason
  the 120 s bound is the only mid-stream one.** `src/transport/provider-timeouts.ts:41-66` states
  it: *"DEFAULTS ARE DELIBERATELY GENEROUS. The risk of cutting off a legitimately slow provider
  is worse than the win of failing a stalled one a minute sooner, because the previous behaviour
  was 'wait forever' and a slow provider was still correct."* The stream-chunk figure is 120 000 ms
  because *"Two minutes is ~2 orders of magnitude above any observed inter-delta gap"* (`:63-66`),
  and head/first-token are 300 000 ms because several gateways in this workspace flush headers only
  when the first token is ready (`:45-61`). `0` disables any bound individually, restoring the
  pre-T6 "wait forever".
- **No external clock ends a run** is a package-wide policy, so the harness will not invent a
  per-request deadline to make a silent relay visible: the bounds above are idle bounds, and a
  tool block is exactly the case where idle bounds are the only thing watching
  (`knowledge.md`, "A THREAD has no wall-clock limit either (policy 2026-11-09)";
  `src/core/agent-limits.ts:74-81`).
- **The relay classifies rather than re-narrates.** The relay generator rethrows the upstream error
  object untouched so the gateway can read its `status` / `cause.code`
  (`runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts:153-169`), and the
  gateway publishes one closed error vocabulary with no upstream bodies on the wire
  (`packages/underload/service/src/server/start.ts:295-330`). Adding per-request chatter to that
  path risks exactly the identity the classifier depends on.
- **The SSE comment is not data.** The SDK reader treats a `:`-prefixed line as a field it discards
  (`node_modules/openai/src/core/streaming.ts:321-324`), and the relay re-serialises parsed chunks
  as `data:` lines (`…/private-chat-completion.ts:162-164`). Forwarding comments verbatim would
  mean the relay stops using the SDK's decoder for that leg.
- **The rotation is shared on purpose, and secrets stay out of logs.** The basalt client keeps
  `remainingEndpoints` per instance precisely so a depleted rotation is not shared across clients
  (`packages/agentic/provider/src/local/local-basalt.ts:156-159`), and `upstreamLabel` is the
  endpoint record's **key**, never its URL, because the URL must stay out of every log line
  (`:159-163`, `:243-246`; `…/private-chat-completion.ts:44-56`).

## Evidence

| Fact | Source |
|---|---|
| The relay logs one token line, **after** the stream settles | `runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts:174-181` (inside the generator, after the `for await` loop closes) and `:210-217` (the settled non-stream path); the line's shape is `formatTokenLine` `:49-58` |
| There is **no** request-start or mid-flight line | the same file greps `console.log` only at `:174` and `:210`; the only other relay-side line is the exhaustion notice, `packages/agentic/provider/src/local/local-basalt.ts:238` |
| The SDK decoder drops every SSE comment line | `node_modules/openai/src/core/streaming.ts:321-324` (`if (line.startsWith(':')) return null`) |
| The relay re-emits only `data:` lines built from parsed chunks | `runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts:162-164` (`yield \`data: ${JSON.stringify(chunk)}\``) |
| The upstream set is **seven** named relays | `config/vault/src/services/basalt.ts:2-37` — `MolabEndless` `:3`, `MarktonWillonLatest` `:11`, `FamialPhotoFast` `:31`, `DracoDravenFast` `:32`, `DrakeJohnsonFast` `:33`, `CornethOneThreeFast` `:34`, `LandarMcTyreFast` `:35` (every other entry is commented out); the client reads `Object.keys` order and pins the head (`packages/agentic/provider/src/local/local-basalt.ts:13, 151`) |
| The clients the relay serves are **shared process-wide**, and rotation advances only on a 404-class failover | `…/private-chat-completion.ts:99` ("the registry clients are shared process-wide"), `:108-122` (relay identity must be captured at the response head because rotation can move the shared client mid-request); `packages/agentic/provider/src/local/local-basalt.ts:156-159, 231-246` (`switchBaseUrl` advances on failover only) |
| The engine family at the end of that chain withholds the whole tool region | `services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100, 993-1003`; the sibling deploy doc: progressive streaming "degrades to a single update at the end — progressive write buffers, stall detectors, and live progress consumers all stop working" (`services/modal/deploy/qwen3.8-27b/modal_qwen3_8_l40s_ninfer.py:984-993`) |
| The client's only mid-stream bound during that silence is 120 s between reads | `src/transport/provider-timeouts.ts:150-152`; the recorded consequence is the 4-attempt `provider-timeout` ladder, `src/core/agent.ts:1361-1385, 1402-1424`, `src/core/agent-limits.ts:179-207, 209-221` |
| What "recognised death" already looks like end to end | `Temp/d1/analysis.out` thread-1 timeline: eleven `provider-transit` retries `t+734s … t+1068s`, then `ROLLBACK boundary=71177 dropped=298` |
| The provider client's own ceiling is a **30 minute** SDK `timeout` with `maxRetries: 3` | `packages/agentic/provider/src/model-class.ts:624, 628` — a request-level ceiling on that leg, NOT on the harness's own leg (`src/transport/openai.ts` is plain `fetch` — `knowledge.md:415-416`, "The DEFAULT transport still adds nothing — it is plain `fetch` (Node 18+)") |

## Where the owning code lives

Not in `@underload/harness`. The change belongs to:

- `packages/underload/service/src/server/start.ts` — the SSE envelope, the closed stream-error
  vocabulary (`:295-330`) and anything the gateway can stamp on a stream frame;
- `runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts` — the generator
  that decodes upstream and re-emits (`:162-181`);
- `packages/agentic/provider/src/local/local-basalt.ts` + `config/vault/src/services/basalt.ts` —
  the relay set and its rotation;
- `packages/agentic/provider/src/model-class.ts:615-629` — the SDK client's timeout/retry budget.

The harness's own side of the same problem (no per-attempt total clock) is
[issue 0038](./minor-long-tool-block-has-no-per-attempt-total-clock.md).

## Proposal

The smallest change that closes the gap without touching the generous bounds:

1. **Log the flight, not only the outcome.** In the relay generator, emit one line when the
   upstream iterator yields its first chunk and one when it ends, each stamped with `client.id` +
   `servingRelay` + elapsed-since-first-chunk. Two lines per request, both already-known values,
   no new secret on the wire. A silent request then has a start, and a killed request has a start
   with no end.
2. **Re-emit the upstream heartbeat as a harness-visible comment.** Either forward `:` comments
   through the hop (stop using the SDK's line decoder for that leg) or, smaller: have the relay
   write its own `: ping` when it has forwarded nothing for N seconds. The consumer side needs no
   change — `src/transport/openai.ts` ignores non-`data:` lines by design, and after R5 it no
   longer needs the comment to know a turn is alive.
3. **Rotate or re-target on silence, not only on 404.** Today a wedged relay keeps every subsequent
   request. A silence-triggered `switchBaseUrl()` (the mechanism already exists,
   `local-basalt.ts:231-246`) would spread a wedged relay's cost instead of concentrating it.

**Alternatives considered.**

- *Lower the harness's 120 s stream-chunk bound.* Rejected: it is the package's deliberate
  posture (`src/transport/provider-timeouts.ts:41-66`), and the bound already fires in this shape
  (the >120 s case); tightening it converts more legitimate slow generations into 4-attempt
  re-generations from token 1.
- *Have the harness log relay identity.* Rejected: the harness cannot know the relay behind a
  gateway — `provider` diagnostics carry the dialled URL/port/class only, and the relay's own
  upstream name is deliberately a name from the endpoint record, never a URL.
- *Add a client-side application heartbeat to the harness transport.* Rejected as out of scope for
  this package: a comment cannot survive the hop anyway (Evidence, row 3), and the harness already
  has its honest liveness signal in the new `progress` frame (see the task brief).
- *Treat the shared rotation as a bug and make it per-request.* Rejected: the per-instance
  `remainingEndpoints` split at `local-basalt.ts:156-159` is the reviewed behaviour, and the
  response-head capture at `private-chat-completion.ts:108-122` exists precisely because the
  shared field can move under a request.

## Acceptance criteria

1. A relay request that produced at least one chunk is identifiable in the relay's own log with
   its serving relay name, whether or not it ended cleanly.
2. A request that was cut mid-generation is distinguishable from one that produced a final chunk,
   from the log alone.
3. A keep-alive signal (upstream comment or relay-generated) reaches the harness client during a
   silent upstream stretch, OR the relay documents that it cannot and the harness's `progress`
   frame is named as the only honest liveness signal on that path.
4. A wedged relay does not pin every later request to itself indefinitely (rotation or an explicit
   operator escape hatch).

## Tests to add

Owned by the packages named above, not by this one (recorded so the owner does not have to infer
them): a relay test asserting the two flight lines with a redacted relay name, and a test asserting
the response-head identity capture survives a mid-request rotation — the existing identity pin is
`runtime/endpoint/provider/private/chat-completion/private-chat-completion.test.ts`.

## Out of scope

- Changing any `provider.*TimeoutMs` default in this package.
- Per-attempt total clocks inside the harness (issue 0038 owns that).
- The `progress` frame itself (shipped; `docs/tasks/2026-11-19-tool-call-composition-visibility.md`).
- Any wire change to the closed stream-error vocabulary beyond what the two log lines need.
