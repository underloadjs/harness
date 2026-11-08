# 0006 — The SSE writer is not reusable, and the streaming recipe is not in the README

> **Status:** Open — reduced on 2026-11-08 (closed parts deleted)
> **Severity:** Minor
> **Area:** `src/server/service.ts`, `src/server/handler.ts`
> **Date opened:** 2026-11-02

## Context

A distribution endpoint that streams harness events to a browser through the same gateway
faces problems the harness has already solved twice inside its own package — an SSE writer
that honours backpressure and client disconnect, and cancel→abort wiring. Each time the host
must read the harness implementation and re-derive it.

## Gap

1. **The SSE writer is not reusable.** `createSseResponse` is module-private
   (`src/server/service.ts:184`) and there is a second, independent writer in the Node
   adapter (`src/server/handler.ts:165-176`). Both implement the same
   `data: <json>\n\n` frame contract, the same `: connected` preamble, the same
   `X-Accel-Buffering` header, and the same cancel→abort semantics. A host streaming harness
   events writes a third copy.
2. **The streaming recipe is only in the source headers.** A host can learn the
   raw-vs-`{ stream }` passthrough choice, the body caps, and the two-module mount from the
   README, but not that a `{ stream }` handler must wire its own abort from
   `context.req.raw.signal` — the one step that decides whether a browser disconnect
   cancels a run. Today that is `service.ts` reading.

## Why it is the way it is

The raw-`Response` path exists because the SSE stream must observe `cancel()` to abort a
run, which the loader's `streamSSE` helper cannot express (`src/server/service.ts:16`). The
two writers predate each other: the standalone Node adapter and the service mount were
written independently, and nothing in the package forces them together.

## Evidence

| Fact | Source |
|---|---|
| Private SSE writer with backpressure, preamble, abort forwarding | `src/server/service.ts:184-284` (used at `:595`) |
| Second writer for the standalone Node adapter | `src/server/handler.ts:165-176` |
| Loader passthroughs available to any endpoint: `{ raw: Response }` and `{ stream: AsyncIterable }` | `packages/underload/service/src/server/start.ts:363-391` |
| The `{ stream }` path stops writing on `stream.aborted` but never signals the handler's run | `packages/underload/service/src/server/start.ts:363-381` |
| A `{ stream }` handler gets no abort signal for its own run, so the wiring step is unstated anywhere a host would look | `packages/underload/service/src/server/start.ts:363-381`; `README.md:3344-3345` lists the route modules but not the abort wiring |

## Proposal

- Export the SSE writer from `@underload/harness/server` as a small documented helper, e.g.
  `createHarnessSseResponse(start, signal)` — the function that already exists, minus the
  `private`. Optionally collapse `handler.ts` onto it so the package has one implementation
  instead of two.
- Add one paragraph to `README.md` (Service host section): how an endpoint streams, that
  `body: 'raw'` skips the loader's pre-parse, that a `{ stream }` handler must wire its own
  abort from `context.req.raw.signal`, and what the route-aware body caps are.

**Alternative considered:** teach the loader to pass an `AbortSignal` to the handler for the
`{ stream }` path. Better for everyone, but it is an `@underload/service` change, so the
harness-side doc note should land first and the loader change is filed in 0007.

## Acceptance criteria

1. `createHarnessSseResponse` (or equivalent) is importable from `@underload/harness/server`,
   and one of the two in-package writers uses it.
2. A host can find the streaming recipe (raw vs stream passthrough, abort wiring, body caps)
   in the README without reading `service.ts`.

## Tests to add

- `src/server/service.test.ts` / `src/server/server.test.ts` — the shared writer keeps the
  existing frame contract byte-identical: preamble, `X-Accel-Buffering`, cancel aborts the
  run, backpressure releases on `pull`.

## Out of scope

- Replacing hono `streamSSE` in the loader.
- HTTP/2 or WebSocket transport (the canonical stream is now `/v1/harness/stream` over
  WebSocket; this issue is about the SSE writer a host writes for its own endpoint).
- The persistence/queue scaling items (0007).

