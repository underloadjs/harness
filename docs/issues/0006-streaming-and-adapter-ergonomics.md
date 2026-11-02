# 0006 — Streaming/adapter ergonomics for a host that reuses the kit behind `@underload/service`

> **Status:** Open
> **Severity:** Minor
> **Area:** `src/server/service.ts`, `src/server/handler.ts`, `src/server/api.ts`, `src/frontend/api.ts`
> **Date opened:** 2026-11-02

## Context

A distribution endpoint that streams harness events to a browser through the
same gateway faces exactly the problems the harness already solved twice inside
its own package — an SSE writer that honours backpressure and client
disconnect, a bootstrap payload shared with the client, a body-size policy that
runs after the loader has parsed. Each time the host must read the harness
implementation and re-derive it.

## Gap

1. **The SSE writer is not reusable.** `createSseResponse` is module-private
   (`src/server/service.ts:155-254`) and there is a second, independent writer in
   the Node adapter (`src/server/handler.ts`). Both implement the same
   `data: <json>\n\n` frame contract, the same `: connected` preamble, the same
   `X-Accel-Buffering` header, and the same cancel→abort semantics. A host
   streaming harness events writes a third copy.
2. **No request-scoped query in the transport-neutral dispatcher.**
   `HarnessApiRequest` carries `method`, `pathname`, `mount`, `readBody`,
   `bootstrapRoot` (`src/server/api.ts:216-230`) — so no route can filter or
   project, and the dispatcher itself documents the consequence when it declines
   to enumerate a session's replaced tool metadata: "the current request type
   carries no query string" (`src/server/api.ts:624-628`).
3. **The body-size policy is structurally late, and the docs say so.** The
   service loader calls `context.req.json()` before any handler runs, so an
   over-sized body is already buffered and a parse failure is already swallowed
   into `{}` (`src/server/service.ts:42-57`,
   `packages/underload/service/src/server/start.ts:288-292`). Harness compensates
   with a declared-length + re-serialized-size gate (`service.ts:298-314`) — a
   host must discover that compensation by reading the file.
4. **The bootstrap document has no home in the contract.** `HarnessBootstrap` is
   declared locally in `src/server/api.ts:246-254` ("protocol.ts is owned by the
   session-contract change") and re-declared by the browser in
   `src/frontend/api.ts:63-77` with a "keep in sync" comment. Two hand-maintained
   copies of one wire shape.
5. **The bare-route/wildcard pair is easy to get wrong.** Because Hono's
   `/v1/harness/*` does not match the bare path, a host must install two modules
   sharing one runtime (`src/server/endpoint/harness/service-route.ts`,
   `service-route-root.ts`, `src/server/service.ts:388-392`). Correct, but
   undocumented outside those two file headers.

## Why it is the way it is

The raw-`Response` path exists because the SSE stream must observe `cancel()` to
abort a run, which the loader's `streamSSE` helper cannot express
(`src/server/service.ts:13-16`, `:153-254`). The dispatcher stayed query-less
because every route so far is path- or body-addressed. The bootstrap duplication
is an explicitly deferred contract move.

## Evidence

| Fact | Source |
|---|---|
| Private SSE writer with backpressure, preamble, abort forwarding | `src/server/service.ts:155-254` |
| Second writer for the standalone Node adapter | `src/server/handler.ts:145-153` |
| Dispatcher request shape (no query) | `src/server/api.ts:216-230` |
| Dispatcher's own note that routes cannot carry a query | `src/server/api.ts:624-628` |
| Loader pre-parses JSON and swallows failures into `{}` | `src/server/service.ts:42-57`; `packages/underload/service/src/server/start.ts:288-292` |
| Harness compensation: declared length + serialized size, route-aware cap | `src/server/service.ts:298-314`, `src/server/api.ts:459-476` (`bodyLimitFor`) |
| Bootstrap shape declared twice, mirrored on purpose | `src/server/api.ts:246-254`, `src/frontend/api.ts:63-77` |
| Loader passthroughs available to any endpoint: `{ raw: Response }` and `{ stream: AsyncIterable }` | `packages/underload/service/src/server/start.ts:306-336` |
| `{ stream }` path stops writing on `stream.aborted` but never signals the handler's run | `packages/underload/service/src/server/start.ts:312-336` |
| Two route modules are required for one mount | `src/server/endpoint/harness/service-route.ts`, `service-route-root.ts`, `src/server/service.ts:388-392` |

## Proposal

- Export the SSE writer from `@underload/harness/server` as a small documented
  helper, e.g. `createHarnessSseResponse(start, signal)` — the function that
  already exists, minus the `private`. Optionally collapse `handler.ts` onto it so
  the package has one implementation instead of two.
- Add `query?: Record<string, string>` to `HarnessApiRequest` and pass it from
  both adapters (the service loader already builds `parameters.query`,
  `packages/underload/service/src/server/start.ts:294-298`). This is what
  unblocks the list-projection half of issue 0005.
- Move `HarnessBootstrap` into `src/server/protocol.ts` and delete the mirrored
  copy in `src/frontend/api.ts` (the "protocol.ts is not ours to extend" note is
  now stale: protocol.ts is the documented owner of every other wire shape).
- Document, once, in `README.md` (Service host section) and in
  `docs/issues/README.md` terms: how an endpoint streams, that the loader parses
  the body first, that a `{ stream }` handler must wire its own abort from
  `context.req.raw.signal`, and that a mount needs two route modules.

**Alternative considered:** teach the loader to pass an `AbortSignal` to the
handler for the `{ stream }` path. Better for everyone, but it is an
`@underload/service` change, so the harness-side doc note should land first and
the loader change is filed in 0007.

## Acceptance criteria

1. `createHarnessSseResponse` (or equivalent) is importable from
   `@underload/harness/server`, and one of the two in-package writers uses it.
2. A route can read a query parameter, and one real route uses it (the session
   list projection).
3. `HarnessBootstrap` has exactly one declaration, and the browser client imports
   the type from `protocol`.
4. A host can find the streaming recipe (raw vs stream passthrough, abort
   wiring, body caps, two-module mount) in the README without reading
   `service.ts`.

## Tests to add

- `src/server/service.test.ts` / `src/server/server.test.ts` — the shared writer
  keeps the existing frame contract byte-identical: preamble, `X-Accel-Buffering`,
  cancel aborts the run, backpressure releases on `pull`.
- `src/server/api.test.ts` — a query-carrying route (and that an absent query is
  unchanged for every existing route).
- `src/frontend/api.test.ts` — the bootstrap import resolves and the mirrored
  interface is gone.

## Out of scope

- Replacing hono `streamSSE` in the loader.
- HTTP/2 or WebSocket transport.
- The persistence/queue scaling items (0007).
