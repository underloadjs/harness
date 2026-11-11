# 0015 — One generic "network error" sentence for DNS failure, refused connection, and unreachable host

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11, fix)** at the bottom)
> **Severity:** Minor
> **Area:** `src/tools/webfetch/request.ts` (error classification)
> **Date opened:** 2026-11-10

## Context

Found by stress-testing `fetch` against hosts that fail for different reasons. Every
transport-level failure collapses into one string, so a caller cannot tell a permanent
condition (typo'd hostname, refused port) from a possibly-temporary one (reset, timeout) and
cannot decide whether to retry, change provider, or give up.

## Gap

`fetch could not be reached (network error).` is returned for at least three distinct causes:

| Cause | Result |
|---|---|
| DNS failure (`nonexistent-host-xyz-abc.invalid`) | `could not be reached (network error)` |
| Host resolves but refuses / resets (httpbin.org, see below) | `could not be reached (network error)` |
| Timeout | `fetch timed out after 15000 ms.` — the **only** case correctly distinguished |

The consumer needs the cause class in the message, and needs it to be honest about whether
retrying is plausible.

## Why it is the way it is

Deliberate, and the reasoning is written down. `request.ts:37-40`: *"Errors are sanitized on
purpose: a page status is reported, a page body never is (error pages are HTML), and a network
failure is reduced to one fixed sentence. There is no retry beyond the Cloudflare UA swap, so a
model cannot multiply spend by hammering a slow host."*

Two parts of that rule are in tension. **Status** classification genuinely works —
`example.com/<missing>` returns `fetch could not find the page (HTTP 404).`, and the download
tool distinguishes 403 and 404 the same way. It is the **transport** half that is over-collapsed:
sanitizing a *page body* protects the transcript from HTML noise, but a `getaddrinfo` code is
not page content and carries no such risk. The single-sentence rule is doing more than the
stated reason requires.

The "no retry" rule is also load-bearing and should not be quietly reversed: it is the stated
reason the tool cannot multiply spend, and `search` states the same policy at
`websearch/index.ts:39` ("one attempt, no retry and no failover").

## Evidence

| Fact | Source |
|---|---|
| The single generic sentence | `src/tools/webfetch/request.ts:576-579` (`networkFailure`; the generic sentence is `:579`) |
| Only the abort/timeout branch is distinguished | `src/tools/webfetch/request.ts:576-579` (`controller.signal.aborted` is the whole discriminator, at `:577`) |
| The deliberate-sanitization rule | `src/tools/webfetch/request.ts:37-40` |
| The no-retry rule and its rationale | `src/tools/webfetch/request.ts:39-40`, `:51` |
| Status classification works on a reachable host | runtime 2026-11-10: `example.com/definitely-missing-abc` → `fetch could not find the page (HTTP 404).` |
| DNS failure is indistinguishable from a reset | runtime 2026-11-10: `nonexistent-host-xyz-abc.invalid` and httpbin.org both → `could not be reached (network error).` |
| The failure is host-specific and **deterministic**, not transient | runtime 2026-11-10: 5/5 failures across `httpbin.org/html`, `/status/200`, `/status/404`, `/status/503`, while curl reaches all of them (`http=200/200/404/503`, 3,741 B for `/html`) |
| Other hosts fail intermittently | runtime 2026-11-10: `en.wikipedia.org/wiki/Quantum_mechanics` failed once and succeeded on the next identical call; `General_relativity` failed once with the network error and later with the correct oversize message |
| Working fallbacks exist on the tool surface | runtime 2026-11-10: `provider:"exa"` succeeded on `httpbin.org/html` where native failed; `?action=raw` succeeded where the full page hit the size cap |
| Loopback is refused before any request, with a precise message | runtime 2026-11-10: `http://127.0.0.1:8099/*` → `fetch refuses this URL: it is not a public absolute http(s) address (loopback and private addresses are not fetched).` — proof the tool *can* be precise when it wants to |

## Proposal

Classify the transport cause, keeping the sanitization rule intact — report the **class**, never
the raw body:

1. Distinguish `ENOTFOUND`/`EAI_AGAIN` (name does not resolve — "check the hostname, retrying
   will not help") from `ECONNREFUSED`/`ECONNRESET`/`EPIPE` (host reachable, connection dropped
   — "a retry or `provider: \"exa\"` may work") from a TLS error. Node exposes these as
   `error.cause.code`, so the classification costs a `switch`, not a redesign. Note the
   shape at `:602-604`: the send helper catches with a **binding-less** `catch { throw
   networkFailure(); }`, so the error object is discarded today and step 1 starts by
   binding it (`catch (error)`).
2. Name the working fallback in the reachable-but-failing case, since it is verified: switching
   provider resolved the httpbin failure in testing.

**Alternatives considered.**

- *Add a general retry with backoff.* Rejected as the primary fix, and it contradicts the
  stated no-retry rule at `:39-40`. A retry aimed at a typo'd hostname or a deterministically
  unreachable host is pure waste; classification has to come first so a retry can be scoped to
  the causes where it can help.
- *Leave it as one sentence.* Rejected: the tool already distinguishes timeout, and already
  produces a precise message for the loopback refusal, so the collapse is inconsistent rather
  than principled.
- *Surface the underlying Node error string.* Rejected: that risks the transcript noise the
  sanitization rule exists to avoid. Classify, do not dump.

## Acceptance criteria

1. A non-resolving hostname and a reachable-but-refusing host produce different messages.
2. Each message states whether a retry is plausibly useful.
3. The timeout message is unchanged.
4. No page body or stack trace reaches the message.

## Tests to add

- `src/tools/webfetch/webfetch.test.ts` — stub `fetch` rejecting with
  `TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })`, then `ECONNREFUSED`, then
  `ECONNRESET`; assert three distinct messages. The existing ENOTFOUND case
  (`:767`, `websearch.test.ts:892`) asserts only the generic string and must be updated.
- `src/harness.webfetch.test.ts` — the classification survives the tool envelope.

## Out of scope

- Adding a general retry policy (would need the no-retry rule at `:39-40` revisited first).
- Status-code classification, which already works.
- The oversize page surfacing as a network error — tracked in 0014's out-of-scope note.

## Update (2026-11-11)

- **Re-anchored** (two rows, one line each): `networkFailure` is `src/tools/webfetch/request.ts:576-579`
  — the collapsed sentence is `:579` and the abort test that separates a timeout from a network
  failure is `:577`.
- **Re-verified exact, no edit needed**: the sanitization rule quoted in "Why it is the way it
  is" is verbatim at `:37-40`, the no-retry rule at `:39-40` and `:51`, the same policy on the
  search side at `src/tools/websearch/index.ts:39`, and the two generic-string assertions at
  `src/tools/webfetch/webfetch.test.ts:767` and `src/tools/websearch/websearch.test.ts:892`.
- **New implementation detail recorded**: the send helper's catch is binding-less
  (`} catch { throw networkFailure(); }`, `:602-604`), so the transport error — and with it
  `error.cause.code`, the only thing that can classify the cause — is thrown away before the
  helper runs. Proposal step 1 has to bind the error first; that is a two-character change in
  the `catch`, and the sanitizer rule (`:37-40`) is unaffected because the classification names
  a class, not the message.
- The runtime rows are left **as recorded** (live 2026-11-10); the collapse they describe is
  still what the code does.
- Status moved to **Fixed** — closing note below.

## Update (2026-11-11, fix) — closed

- **Shipped.** The transport cause is classified and reported as a class. Implementation:
  `src/tools/webfetch/request.ts:160-270` — `DNS_CAUSE_CODES` (`:180`, `ENOTFOUND`, `EAI_AGAIN`),
  `CONNECTION_CAUSE_CODES` (`:185`, `ECONNREFUSED`, `ECONNRESET`, `EPIPE`), `TLS_CAUSE_CODES`
  (`:191-202`, plus the `ERR_TLS*` / `ERR_SSL*` / `ALERT_*` prefix rules so a long-tail handshake
  failure never falls into the unclassified bucket), one sentence per class
  (`TRANSPORT_FAILURE_MESSAGES`, `:211-218`), code extraction (`transportCodesOf`, `:226-244`),
  dispatch (`transportCause`, `:249-264`).
- **The binding-less catch the re-anchoring flagged is now bound**: `send`'s catch reads
  `catch (error) { throw networkFailure(error) }` (`:746-751`), and `networkFailure` checks the
  abort discriminator FIRST (`:720-723`) so a timeout is never relabelled — the timeout sentence
  is byte-identical to the one 0015 says is fine (criterion 3). Body-stream failures are threaded
  through too: `readBody` takes a `failure` factory (`:540-543`) and classifies what the stream
  throws (`:594-599`), which is the exact shape of the httpbin case in **Evidence** — a response
  that starts and dies mid-download.
- **Codes are read from three positions, not one.** The proposal named `error.cause.code`. Real
  rejections need all three: `error.code` (a direct connect failure, and what a body-stream reset
  carries), `error.cause.code` (undici's wrapped `TypeError: fetch failed`), and
  `error.cause.errors[].code` (the happy-eyeballs dual-stack aggregate, where every attempt's code
  lives on the attempt). `:220-225` records why. Nothing but the code is read — never the message,
  never the stack.
- **Criterion-by-criterion.** 1 — DNS, refused, reset, TLS and unknown each get their own
  sentence; a test asserts DNS ≠ connection (`:1489`). 2 — every sentence states the retry
  verdict: DNS "retrying will not help", connection "a retry may help", TLS "Retrying will not
  help: the same handshake fails", unclassified "a retry may help". 3 — the timeout message is
  unchanged and still tested (`:647`, plus `:1573` for a timeout that also carries a code). 4 —
  no raw text: the classifier maps code → constant, and a test feeds an HTML error page plus a
  stack-shaped tail and asserts neither appears (`:1554-1571`).
- **Step 2 (the verified fallback) is named where it was verified.** `"provider": "exa"` appears
  in the connection, TLS and unclassified sentences; it is deliberately absent from the DNS
  sentence, where a different client changes nothing (a test pins that absence, `:1510`). It is
  written into the sentences rather than appended through `providerDiagnostics`: the params echo
  adds nothing when the host was never reached, and naming the alternative client IS the remedy
  here. Consequence: a transport failure no longer carries the `provider`/`params` JSON tail —
  say so if a consumer depended on it.
- **Sanitization rule untouched.** The class is reported, not the Node text, so `:37-40` (no page
  body in the transcript) and the no-retry rule at `:39-40` still hold — classification is not a
  retry, and none was added (out of scope, as filed).
- **Anchors this fix moved**: `networkFailure` 576-579 → 720-723 (inside `requestPage`), the send
  catch 602-604 → 746-751, and the whole classifier sits at 160-270. `MAX_RESPONSE_BYTES` is 73.
- **Tests** (`src/tools/webfetch/webfetch.test.ts:1422-1597`, plus the envelope case in
  `src/harness.webfetch.test.ts:399`). The code→class table is pinned directly through the
  exported `transportFailureMessage` (`:269`, exported so the contract can be pinned without
  fabricating a GET around it), then the four classes are pinned end-to-end through the tool with
  a stubbed rejecting `fetch` — no live network anywhere in the file. The native-path assertion
  this issue asked to update (it pinned only the collapsed sentence) no longer exists: every
  native transport assertion now pins a class.
- **Left for the search side (another owner).** The classifier covers the native GET path
  (`requestPage`) and the body stream. A `fetch` call that goes through a hosted provider
  (`provider: "exa"` / `"linkup"`) still fails with one generic sentence, because that leg uses
  `src/tools/websearch/request.ts:419` — `${label} search could not be reached (network error).`
  — and its tests still assert that string (`src/tools/websearch/websearch.test.ts:627`, `:892`,
  and the fetch tool's own Linkup case at `src/tools/webfetch/webfetch.test.ts:789`). Same shape,
  same fix, files outside this issue's area and this fix's ownership; whoever takes it can reuse
  the exported `transportFailureMessage`.
- **Verification.** `vitest run src/tools/webfetch/webfetch.test.ts src/harness.webfetch.test.ts`
  → 106 passed; `tsc --noEmit -p .` → clean. The live rows were not re-run (provider spend and
  the flaky host they recorded); every class is reproduced offline by the stubs above.
