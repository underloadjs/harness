# 0006 — The SSE writer is not reusable, and the streaming recipe is not in the README

> **Status:** Fixed — 2026-11-11 (see **Update (2026-11-11 — fix)** at the bottom: AC1 is
> `createHarnessSseResponse`, published from `@underload/harness/server` and consumed by the
> Node adapter, and AC2 is a paragraph in the README's Service host section. File kept for
> review — delete it and its index row once the owner's integrated run confirms.)
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
   adapter (`src/server/handler.ts:163-198`). Both implement the same
   `data: <json>\n\n` frame contract, the same `: connected` preamble, the same
   `X-Accel-Buffering` header, and the same cancel→abort semantics. A host streaming harness
   events writes a third copy.
2. **The streaming recipe is only in the source headers.** The README documents the
   two-module mount, but not the raw-vs-`{ stream }` passthrough choice, not the body caps,
   and not that a `{ stream }` handler must wire its own abort from
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
| Second writer for the standalone Node adapter | `src/server/handler.ts:163-198` |
| Loader passthroughs available to any endpoint: `{ raw: Response }` and `{ stream: AsyncIterable }` | `packages/underload/service/src/server/start.ts:357-361` (raw passthrough), `:363-387` (stream path) |
| The `{ stream }` path stops writing on `stream.aborted` but never signals the handler's run | `packages/underload/service/src/server/start.ts:363-387` |
| A `{ stream }` handler gets no abort signal for its own run, so the wiring step is unstated anywhere a host would look | `packages/underload/service/src/server/start.ts:363-387`; `README.md:223-230` lists the route modules but not the abort wiring |

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

## Update (2026-11-11)

- **One anchor corrected**: the route/server-module listing this issue points at
  as the place a host would look for the abort wiring is `README.md:223-230` (the
  `src/server/` block naming `handler.ts` — "the /v1/harness mount" — and
  `service.ts` — "/v1/harness, Origin gate, CORS, the stream upgrade"); the number
  it carried predated the README realignment.
- **Re-verified exact**: `createSseResponse` is still module-private at
  `src/server/service.ts:184` (the frame contract is documented in its header at
  `:182-183`, and the only use is the raw passthrough at `:595`), the second
  writer is still `src/server/handler.ts:163-198` (`runStream`: the same
  `: connected` preamble at `:175`, the same `X-Accel-Buffering` at `:172`), the
  raw-`Response` rationale is still `src/server/service.ts:16`, and the loader
  passthroughs are still `packages/underload/service/src/server/start.ts:357-361`
  (raw) and `:363-387` (the `{ stream }` path that breaks on `stream.aborted` at
  `:367` without signalling the handler).
- Status stays **Open**. Note for the owner: a third transport has since landed
  (the `/v1/harness/stream` WebSocket upgrade, T15) — see 0007's code-health row;
  it does not close either gap here, both of which are about the SSE writer a
  **host** writes for its own endpoint.

## Update (2026-11-11 — fix)

Both records are closed as proposed; nothing was redesigned.

- **AC1 — the writer is published.** `src/server/service.ts:215` is now
  `export const createHarnessSseResponse(start, signal?)` — that is the function that
  already existed (was the module-private `createSseResponse` at `:184`, used once at
  `:595`): the body is unchanged line for line, so the rename plus the `export` and an
  expanded header comment are the whole diff, and the only in-package call site is now
  `:626`. `src/server/index.ts` reaches it through the existing `export * from './service'`,
  and the Node root re-exports that barrel, so it is importable as
  `@underload/harness/server` and from the root; the barrel's surface list
  (`src/server/index.ts:11-14`) now names it. No new module, no new dependency, and no
  `package.json` change (the `./server` condition already pointed at that barrel).
- **AC1 — one in-package writer consumes it.** The **Node adapter's** copy is the one
  collapsed, because it is the second copy this issue names: `handler.ts:141-198`
  (`createSseWriter` + `runStream`, ~58 lines with their own `data: <json>\n\n` literal,
  `: connected\n\n`, four `setHeader` calls and their own abort wiring) is now
  `runHarnessSseStream` (`src/server/handler.ts:170`), which calls the shared writer and
  pipes its body onto the `ServerResponse` with `Readable.fromWeb`. Chosen over collapsing
  the service adapter because that adapter is the fetch-shaped side the helper is typed
  for, and the loader consumes its `Response` directly. Exported (so the `./server` barrel
  publishes it) because a host that owns its own Node listener no longer has to write a
  writer at all.
- **Three honest consequences of the collapse, all deliberate:**
  1. Header **names** reach the Node wire lower-cased, because `Response.headers`
     normalises them (`content-type:` where the deleted copy wrote `Content-Type:`). Every
     **value** is unchanged, and RFC 9110 §5.1 makes the name case-insensitive. The frame
     bytes, the preamble and the header set are asserted identical below.
  2. Backpressure moved from `response.write()` + `'drain'` to the writer's
     `desiredSize` wait plus `pipe` — one rule on both mounts instead of two idioms.
     Destroying the bridge in the `finally` is what fires the writer's `cancel()`, which is
     the abort path.
  3. A `start` that **throws** no longer propagates to the adapter's `catch`: the shared
     writer already swallowed it and closed the body (that is what the gateway mount has
     always done, `src/server/service.ts:272-288`), and the dispatcher turns a failed run
     into a `failed` frame anyway. The adapter's `if (response.headersSent)
     response.destroy()` branch stays for a failure BEFORE headers go out.
- **AC2 — the recipe is findable.** `README.md:3972-3993`, one paragraph at the end of the
  **Service host (`/v1/harness`)** section, states: the two passthroughs the loader offers
  and that `raw` is returned untouched; that `createHarnessSseResponse` is the import for a
  host's own endpoint; that `body: 'raw'` skips the loader's uncapped pre-parse and the body
  then goes through the **route-aware** cap; and that a `{ stream }` handler must wire its
  own abort from `context.req.raw.signal`, because `stream.aborted` only stops the loader's
  writing loop — flagged as the one step that decides whether a disconnect stops a run or
  only stops a socket. The caps are stated as the code enforces them
  (`bodyLimitFor`, `src/server/api.ts:744`): **16 MiB for `POST /v1/harness/sessions/:id/tasks`
  only, 1,000,000 bytes everywhere else**. That is narrower than this issue's own wording
  ("the submit routes (/tasks **and /messages**)"), which the header comment at
  `src/server/service.ts:65-67` repeated — the `/messages` stream is gone since T15, so the
  comment was corrected to name the one route `bodyLimitFor` actually raises, and the README
  states the same live rule.
- **Tests: `src/server/sse-writer.test.ts` (new, 7 cases, all exact-value).** The file the
  issue names does not exist: there is no `src/server/service.test.ts` (the service adapter's
  suite is `service-start.test.ts`, a child-process gateway run) and `server.test.ts` has no
  stream arm to reach — T15 deleted the SSE routes, so no in-package route answers a plain
  GET with one and both writers were unreachable from an HTTP test. The cases: the writer is
  importable from the server barrel **and is the same function** `./service.ts` exports
  (identity, not "a callable of the right name"); status + the four header values + the body
  byte-for-byte (`: connected\n\ndata: {"type":"a"}\n\ndata: {"type":"b"}\n\n`); `cancel()`
  aborts the run's signal and the reader then sees `{ value: undefined, done: true }`; a
  request signal aborts the run the same way; **pacing** — with five frames wanted and two
  reads taken, `produced` is exactly `3`, still `3` after a 40 ms settle, and the drained
  bytes are the exact five frames; and over a real `http.Server`, `runHarnessSseStream`
  emits the identical bytes/headers and a mid-stream client disconnect ends the run as
  `{ finished: true, aborted: true }`. Chunk boundaries over a socket are not a fixed value,
  so that last case pins the exact prefix and the exact outcome instead of a chunk split.
- **Verification** (all against the tree with this fix, after the last edit):
  `npx vitest run src/server/sse-writer.test.ts` → **7 passed**, three runs in a row
  (the pacing case asserts an exact count after a 40 ms settle, so it was repeated).
  Scoped server run `npx vitest run src/server/sse-writer.test.ts src/server/server.test.ts
  src/server/service-start.test.ts src/server/stream src/server/api.test.ts
  src/server/dev.test.ts` → **12 files, 184 passed**, exit 0. Package-wide:
  **`npx vitest run` → 188 files passed, 3566 passed | 2 skipped (3568), exit 0** — exactly
  the campaign baseline (187 files / 3559 passed / 2 skipped) plus this file's 7 cases, so
  no other suite moved. `npx tsc --noEmit` → **exit 0**. `yarn build` (manifests + vite
  entries + `build:types`) → **exit 0**, 256 declarations emitted, so the new barrel names
  publish cleanly. The one risk the collapse could have introduced — an unhandled `'error'`
  on the `ServerResponse` when a client dies mid-write now that `pipe` owns the write loop —
  was probed directly (`Temp/T14/probe7.mjs`: five harsh mid-stream socket destroys against
  a fast 4 KiB-frame producer) → **0 uncaught exceptions**; the deleted copy had the same
  exposure and no response-error listener, so none was added.
- **Scope respected:** `@underload/service` untouched (the loader `AbortSignal` alternative
  stays in 0007), `src/shared/harness-stream.ts` untouched, hono `streamSSE` not replaced,
  no WebSocket/HTTP-2 transport work.
- **Left for the owner:** whether `runHarnessSseStream` should stay published from the
  barrel — it is a real capability for a host with its own Node listener, and it is what
  makes the collapsed path testable without a route (no in-package route reaches it any
  more, so a decision to unexport it needs a different seam in the test).

