# 0015 — One generic "network error" sentence for DNS failure, refused connection, and unreachable host

> **Status:** Open
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
- Status stays **Open**.
