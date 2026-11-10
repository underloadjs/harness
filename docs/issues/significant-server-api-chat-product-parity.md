# 0005 — Built-in session API: no transcript seeding, and no tool-less preset

> **Status:** Open — reduced on 2026-11-08 (closed parts deleted); reduced again
> on 2026-11-11 (the narrow-toolbox **fixture** evidence row was deleted outright:
> the `demo`/`flaky` fixtures and `FIXTURE_PRESETS` no longer exist **in the shipped
> catalogue** — they survive only as test-scope presets
> (`src/server/harnesses/fixture-presets.test-support.ts:390`, `withFixtures` at `:394`) — so
> the "fixtures, not live presets" distinction is moot and every live preset is in the
> shared-toolbox case)
> **Severity:** Significant (Blocking only for a consumer that adopts the built-in
> `/sessions` API instead of building its own endpoint)
> **Area:** `src/server/api.ts`, `src/server/protocol.ts`, `src/server/harnesses/presets.ts`
> **Date opened:** 2026-11-02

## Context

`distribution/chat-assistant` was evaluated as a migration candidate against the harness
**server** API before settling on building its own endpoint on the library. Two of the chat
features its UI needed are still unrepresentable in the session contract, and both are cheap
additions.

## Gap

1. **No transcript seeding or fork-at-turn.** `POST /sessions` accepts
   `{ harness, title, settings }` and nothing else; a submit takes `input` (user text);
   thread creation takes `{ label, ownerThreadId }`. There is no way to start a
   conversation that **already contains messages**, which rules out importing an existing
   history and forking at an arbitrary turn. The transcript write that exists today
   (`PUT …/threads/:id/transcript`) replaces the transcript of a thread that already
   exists — it cannot create a session with content.
2. **No tool-less chat preset.** Every live preset registers the shared toolbox, so a
   "just answer me" session still declares core file tools, discovery, delegation and the
   record stores, and may spend tool rounds touching the server host's filesystem (all
   seven shipped presets declare `SHARED_TOOL_NAMES`, and there is no tool-less one). A
   client cannot select an empty toolbox, because a harness is composed from trusted
   agent profiles only.

## Why it is the way it is

The session API is an **operator/agent console**, not a chat backend: it renders runs,
threads, delegation and tools, and it deliberately keeps prompt text trusted-catalogue-only
("a client may choose an agent, but must never supply the text a model is seeded with",
`src/agents/types.ts:1-8`). Frozen `harnessDefinition` at creation
(`src/server/protocol.ts:650`, `:696`, `:945`) is what makes transcripts reproducible. Both explain the
two remaining gaps; neither makes them unnecessary for a consumer whose product is a chat.

## Evidence

| Fact | Source |
|---|---|
| `POST /sessions` accepts exactly `harness`, `title`, `settings` | `src/server/api.ts:2515-2518` (`postSession`, `requireKnownFields(body, ['harness', 'title', 'settings'])`), `src/shared/harness-api.ts:1039-1043` (`CreateSessionRequest`) |
| The only transcript write is a whole-transcript replace on an existing thread | `src/server/api.ts:4300-4336` (`putTranscript`, body `{ messages, if_revision }`), `src/server/sessions.ts:9170` (`updateThreadTranscript`), `src/server/harness.swagger.yaml:2438-2574` (the four transcript operations) |
| `threadFork` is model-driven and needs the owning run | `README.md:64-67`, `README.md:1879-1891` |
| Agent prompt text is trusted catalogue data by rule | `src/agents/types.ts:1-8` |
| Harness create/patch accept agent *selection* and per-agent instruction overrides, never a tool list | `src/server/api.ts:1868-1880`, `:1925-1936`, `src/shared/harness-api.ts:487` ("it cannot supply a provider, a credential, a transport, or a tool list") |
| All seven live presets share one toolbox, by stated rule | `src/server/harnesses/presets.ts:9-15` ("All seven … Only the agents differ … These seven are `presets`"), `:175`, `:197`, `:220`, `:243`, `:266`, `:290`, `:313` (`tools: SHARED_TOOL_NAMES`) |
| Sessions are host-global with no ownership: the boundary is an Origin gate | `src/server/service.ts:18-40` |

## Proposal

Both additive, both already half-built:

**(C) Seeding.** Optional `messages?: HarnessMessage[]` on `POST /sessions` (validated the
way `attachments` are on submit, applied before the first turn), or a dedicated
`POST /sessions/:id/seed`. This is what makes "clone a conversation up to turn N" and
"import a history" possible; without it the store's persistence has no ingestion path for
foreign data. The validation and the optimistic lock are already written for the transcript
replace (`api.ts:4300-4336`) and can be reused verbatim.

**(D) A `chat` preset in the app catalogue**: one primary, `tools: []`, `presets: false`,
`maxIterations` 1, no subagents (so no `delegate`), no `interaction`, no forks — the
documented minimum. Keep it a trusted profile so the "clients never supply prompt text" rule
holds. The mechanism already exists: every live preset is composed by
`createProfiledHarness` (`src/server/harnesses/toolbox.ts:448`, imported into the catalogue
at `src/server/harnesses/presets.ts:110`), and the registry accepts any extra
`HarnessPreset` a host or test passes it (`src/server/harnesses/presets.ts:345-350`,
`createHarnessRegistry([...presets, myFixture])`). So this is a catalogue entry, not a new
mechanism — the shipped presets that used to prove that point (`demo`, with
`tools: ['timeNow']`, and the `FIXTURE_PRESETS` tier) were deleted, which is why the
evidence row for them is gone.

**Alternatives considered.**

- *"Leave it; consumers build their own endpoint."* True and validated — the library covers
  both (custom `instruction`, host-owned store, `presets: false`). Then the README should
  say which surface is a console and which is a kit, which today it does not (see 0007).
- *Full OpenAI-style `/chat/completions` compatibility on the harness server.* Rejected: it
  would fork the contract away from turns/events/threads, which are the API's actual value.
- *Making the transcript the client's business (stateless per-request).* That is what
  0001-0004 serve; it is an alternative **for consumers**, not a change the package should
  make to its own store.

## Acceptance criteria

1. A session can be created with a seeded transcript, or the README states that history is
   write-only from the client's side.
2. A tool-less preset ships, or the README names `presets: false` as the way a host declares
   one and confirms the service-host registry can register it.

## Tests to add

- `src/server/api.test.ts` + `src/server/sessions.test.ts` — a seeded create survives
  snapshot → persist → restore, and the seeded messages are what the first provider request
  actually sees.
- `src/server/persistence.test.ts` — the new field round-trips through DTO validation and an
  old `state.json` without it still loads.
- `src/server/harnesses/presets.test.ts` + `catalogue.test.ts` — the `chat` preset declares
  no tools and no `delegate`, and still passes the shared-toolbox rule for live presets.

## Out of scope

- Authentication, per-user isolation, quotas (tracked in 0007).
- Message-granular editing inside one turn (the harness's own tool transcript).
- Any change to the frozen-at-creation `harnessDefinition` rule.

## Update (2026-11-11)

- **Both gaps are still live**, so the issue stays **Open**:
  `POST /v1/harness/sessions` still accepts only `harness`/`title`/`settings`
  (`src/server/api.ts:2515-2518`, `src/shared/harness-api.ts:1039-1043`) — no way
  to create a session that already contains messages — and all seven live presets
  still declare the shared toolbox
  (`src/server/harnesses/presets.ts:175`, `:197`, `:220`, `:243`, `:266`, `:290`,
  `:313`), with no tool-less preset in the catalogue.
- **Factual correction (five → seven presets).** The shipped catalogue is
  `general`, `instruct`, `research`, `workspace`, `reviewer`, `planner`,
  `debugger`: the module header states "All seven … Only the agents differ …
  These seven are `presets`, the default catalogue … and they are the WHOLE
  catalogue" (`src/server/harnesses/presets.ts:9-15`). Every "five presets"
  wording and the quoted evidence text were corrected to match.
- **Part closed — deleted outright, reduction recorded in the header.** The
  Evidence row "the narrow-toolbox entries are fixtures, not live presets"
  (`demo`, `tools: ['timeNow']`, `FIXTURE_PRESETS`) was removed rather than
  footnoted: the fixtures themselves are deleted, and the module now says so
  (`src/server/harnesses/presets.ts:17-26`, `:345-350` — no `FIXTURE_PRESETS`, no
  `ALL_PRESET_TEMPLATES`, no scripted `demo` transport). The distinction that row
  drew no longer has any referent, so nothing in **Gap**, **Proposal**,
  **Acceptance criteria** or **Tests** depends on it. Proposal (D) was re-pointed
  from the deleted `demo` factory to the mechanism that exists now:
  `createProfiledHarness` (`src/server/harnesses/toolbox.ts:448`, imported at
  `src/server/harnesses/presets.ts:110`) plus the registry's documented tolerance
  for a host- or test-declared `HarnessPreset`
  (`src/server/harnesses/presets.ts:345-350`).
- **Anchors re-grounded**: `src/server/api.ts:2515-2518` / `:4300-4336`,
  `src/shared/harness-api.ts:1039-1043` / `:487`,
  `src/server/api.ts:1868-1880` / `:1925-1936`,
  `src/server/sessions.ts:9170`, the four swagger transcript operations
  (`src/server/harness.swagger.yaml:2438-2574`), and the frozen-definition notes
  (`src/server/protocol.ts:650`, `:696`, `:945`). README cites follow the
  2026-11-11 README realignment (`:64-67`, `:1879-1891` for `threadFork`).
  `src/agents/types.ts:1-8` and `src/server/service.ts:18-40` were re-checked and
  are still exact.

