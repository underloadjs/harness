# 0005 — Built-in session API cannot express conversation-level product features

> **Status:** Open
> **Severity:** Significant (Blocking only for a consumer that adopts the built-in
> `/sessions` API instead of building its own endpoint)
> **Area:** `src/server/protocol.ts`, `src/server/api.ts`, `src/server/sessions.ts`, `src/server/harnesses/presets.ts`
> **Date opened:** 2026-11-02

## Context

`distribution/chat-assistant` was evaluated as a migration candidate against the
harness **server** API before settling on building its own endpoint on the
library. Five features its UI provides today have no representation in the
session contract at all. They are listed here because any consumer that reuses
`/v1/harness` directly hits the same wall, and because two of them are cheap
contract additions.

## Gap

1. **No conversation title or rename.** `SessionSnapshot` has no `title` field;
   `PATCH /sessions/:id` accepts exactly one thing, `agentModels`. A chat list
   therefore has no label the client can set, and a rename cannot be persisted
   server-side. Titles exist only on harness *descriptors*.
2. **No transcript mutation.** There is no route or store method to edit,
   delete, or truncate a single message/turn. The mutation surface is: reset the
   whole session, cancel a run, stop a thread, delete a thread. Editing the
   third user turn of a conversation — the most common chat affordance after
   send — is not expressible.
3. **No transcript seeding or fork-at-turn.** `POST /sessions` takes
   `{ harness, settings }` only; a submit takes `input` (user text); thread
   creation takes `{ label, ownerThreadId }`. There is no way to start a
   conversation that already contains messages, which also rules out importing
   an existing history and forking at an arbitrary turn (the `threadFork` tool
   exists but is model-driven and refuses manual calls).
4. **No per-client scoping of the session list.** `GET /sessions` returns every
   session on the host, each with its complete `turns` array including every
   `event` and `eventTimes`. The dispatcher request type carries no query
   string, so no route can filter or project. A multi-user LAN host must download
   everybody's full transcripts to render one browser's sidebar.
5. **No tool-less chat preset.** Every live preset registers the shared toolbox,
   so a "just answer me" session still declares core file tools, discovery,
   delegation and the record stores, and may spend tool rounds touching the
   server host's filesystem. A client cannot select an empty toolbox, because a
   harness is composed from trusted agent profiles only.

Two smaller ones ride along: no session-level usage total (each client sums per
turn itself), and no way to give a session a product-specific system prompt
without adding an agent profile in code.

## Why it is the way it is

The session API is an **operator/agent console**, not a chat backend: it renders
runs, threads, delegation and tools, and it deliberately keeps prompt text
trusted-catalogue-only ("a client may choose an agent, but must never supply the
text a model is seeded with"). Frozen `harnessDefinition` at creation
(`README.md:1884-1888`) is what makes transcripts reproducible, and the
`{ session }`-shaped, always-complete snapshots are what let a second client
render without replaying the stream.

That explains every one of the five; it does not make them unnecessary for a
consumer whose product is a chat.

## Evidence

| Fact | Source |
|---|---|
| `SessionSnapshot` fields (no `title`) | `src/server/protocol.ts:317-372` |
| `PATCH /sessions/:id` body is `agentModels` only | `src/server/protocol.ts:446-462`, `src/server/api.ts:1164-1187` |
| `title` exists only on `AgentDescriptor` / `HarnessDescriptor` / create+patch harness bodies | `src/server/protocol.ts:151`, `:160`, `:198`, `:214` |
| Store mutation surface (create/get/list/setAgentModels/enqueue/watch/cancel/cancelThread/deleteThread/reset/remove/dispose) | `src/server/sessions.ts:800`, `:1881`, `:1885`, `:1916`, `:2715`, `:3234`, `:3802`, `:3910`, `:4120`, `:4438`, `:4509`, `:4529` |
| Session create body / submit body / thread create options carry no messages | `src/server/protocol.ts:441-444`, `:475-478`, `:494-528`; `src/types/index.ts:1557-1567` |
| Harness create/patch reject instruction text explicitly | `src/server/api.ts:991-1009` (`requireKnownFields`, `CREATE_HARNESS_FIELDS`), `:1045-1068` |
| Agent prompt text is trusted catalogue data by rule | `src/agents/types.ts:1-20`, `src/server/protocol.ts:145-155` |
| Dispatcher request has no query field | `src/server/api.ts:216-230`, and the explicit note at `:624-628` |
| `GET /sessions` returns full snapshots for every session | `src/server/sessions.ts:1885-1887`, `:1836-1879` (`snapshot`), `src/server/protocol.ts:341` |
| `turns` includes `events` + `eventTimes` per turn | `src/server/protocol.ts:67-127` |
| Usage is per turn, summed by the server from request events; no session total | `src/server/protocol.ts:113-118`, `README.md:1906-1910` |
| `threadFork` needs the owning run and is refused on the manual path | `README.md:1940`, `:555` |
| All live presets share the full toolbox; presets differ only by agents | `src/server/harnesses/presets.ts:133-199` ("Only the agents differ between live presets, never the tools") |
| Threads are capped at 256 host records per session (429 on the thread routes) | `src/core/thread.ts:46`, `README.md:129-139` |
| No authentication: the boundary is an Origin gate, sessions are host-global | `src/server/service.ts:18-40`, `:136-151` |

## Proposal

Grouped by cost, all additive:

**(A) Cheap contract additions (do first).**

- `SessionSnapshot.title?: string`, settable through the existing PATCH with
  `{ title }` (bounded like `CreateHarnessRequest.title`), default derived
  server-side from the first turn's trimmed first line so an untitled session is
  still labelable today. One field, one validation path, no state machine change.
- A session-level `usage?: HarnessUsage` computed by the store as the sum over
  `turns` — the arithmetic every client repeats, in the one place that already
  owns the per-turn tally (`src/server/sessions.ts:1836-1879`).
- `GET /sessions` gains a projection: either honour a query string (which means
  adding `query` to `HarnessApiRequest` — one field, both adapters already have
  it: the service loader parses `context.req.query()`, `handler.ts` has the URL)
  or add `GET /sessions?summary` returning `{ id, title, harness, status, model,
  createdAt, updatedAt, messageCount, usage }`. The second is enough for a
  sidebar and is far less invasive than shipping events.

**(B) Transcript mutation, expressed as turns, not messages.**

Add `DELETE /sessions/:id/turns/:turnId` (drop a recorded turn) and
`PATCH /sessions/:id/turns/:turnId` `{ input }` (replace a turn's prompt for a
rewind-and-resend), or one route `POST /sessions/:id/rewind { fromIndex }` that
truncates the conversation at a turn and returns the snapshot. The store already
does the hard part of this correctly for `deleteThread` — purging turns,
references, label counters and the persisted copy (`src/server/sessions.ts:4120`,
`src/server/protocol.ts:556-565`) — so this reuses existing machinery rather than inventing
it. State the contract for an agent transcript alongside it: the harness keeps
its own `HarnessMessage[]`, so a rewind must project into `core` too, which is
exactly the coupling snapshot/restore already models (`src/types/index.ts:2210-2224`).

**(C) Seeding.** Optional `messages?: HarnessMessage[]` on `POST /sessions`
(validated like `attachments` are on submit, applied before the first turn), or a
dedicated `POST /sessions/:id/seed`. This is what makes "clone a conversation up
to turn N" and "import a history" possible; without it the store's persistence
has no ingestion path for foreign data.

**(D) A `chat` preset in the app catalogue**: one primary, `tools: []`,
`presets: false`, `maxIterations` 1, no subagents (so no `delegate`), no
`interaction`, no forks — i.e. the documented minimum (`src/types/index.ts:1981-2117`).
Keep it a trusted profile so the "clients never supply prompt text" rule holds.

**Alternatives considered.**

- *"Leave it; consumers build their own endpoint."* True and validated — the
  library covers all five (custom `instruction`, `messages` seeding,
  `presets: false`, host-owned store). Then the README should say which surface is
  a console and which is a kit, which today it does not (see 0007).
- *Full OpenAI-style `/chat/completions` compatibility on the harness server.*
  Rejected: it would fork the contract away from turns/events/threads, which are
  the API's actual value.
- *Making the transcript the client's business (stateless per-request).* That is
  what 0001-0004 serve; it is an alternative **for consumers**, not a change the
  package should make to its own store.

## Acceptance criteria

1. A client can set and read a session title through one documented route.
2. A session snapshot reports a usage total consistent with summing its turns.
3. A list route exists whose payload is proportional to the number of sessions,
   not to their event count; the README states what each list route returns.
4. A transcript can be truncated at a turn, and the store's existing
   label/reference/persistence invariants still hold afterwards (the same
   invariants `deleteThread` is tested against).
5. A session can be created with a seeded transcript, or the README states that
   history is write-only from the client's side.
6. A tool-less preset ships, or the README names `presets: false` as the way a
   host declares one and confirms the service-host registry can register it.

## Tests to add

- `src/server/api.test.ts` + `src/server/sessions.test.ts` — title PATCH
  validation; rewind purges turns/references/labels like `deleteThread`; seeded
  create survives snapshot→persist→restore.
- `src/server/persistence.test.ts` — new fields round-trip through DTO
  validation and an old `state.json` without them still loads (v1 stays readable).
- `src/server/threads.test.ts` — the rewind route against a running/stopped
  thread (409 vs 200), reusing the existing stop-before-delete contract.
- `src/server/harnesses/presets.test.ts` + `catalogue.test.ts` — the `chat`
  preset declares no tools and no `delegate`.

## Out of scope

- Authentication, per-user isolation, quotas (tracked in 0007).
- Message-granular editing inside one turn (the harness's own tool transcript).
- Any change to the frozen-at-creation `harnessDefinition` rule.

## Update — 2026-11-02

Related documentation drift found in the same pass: `README.md:1901` says
"Sessions are in memory and are lost when the server restarts", while the
service mount persists and restores them (`src/server/service.ts:59-66`,
`src/server/runtime.ts:103-140`, `src/server/persistence.ts:99-154`). Tracked in
0007 so the fix lands in the docs pass, not buried here.
