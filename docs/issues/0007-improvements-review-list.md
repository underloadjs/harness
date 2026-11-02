# 0007 — Improvements review list (not gaps)

> **Status:** Open — for the package owner to triage
> **Severity:** Review list
> **Area:** cross-cutting
> **Date opened:** 2026-11-02

Everything below was found in the same review pass as issues 0001-0006 but is
**not** a capability gap: each item is a decision, a cleanup, a doc fix, or an
ergonomics change. They are listed separately so the capability work
(0001-0006) is not held hostage to judgement calls.

Priority vocabulary: **P1** = cheap and prevents a consumer making a wrong
assumption; **P2** = worth scheduling; **P3** = tidy-up.

## Contract and types

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | `HarnessError` carries no status or code, so every library validation failure thrown inside a host route (bad tool name, `createThread` on an unknown agent, a construction-time provider error) maps to **HTTP 500** in the package's own classifier, and in any host that copies it. | `src/util/errors.ts:7-19`; `src/server/api.ts:1410-1418` | Add an optional `status`/`kind` to `HarnessError`, or document that hosts must map it themselves. |
| P2 | `HarnessToolRegistrationCandidate`'s header comment promises a `definition` field "for host/plugin compatibility"; the type does not declare one. The internal `ToolRegistrationCandidate` omits it too. | `src/types/index.ts:587-592` vs `:592-602`; `src/core/tool-source.ts:159-173` | Fix the comment or add the field (issue 0003 prefers adding it). |
| P2 | A standalone `agent.turn()` caller reads per-request `usage` only from the `done` event's message; the per-request `usage` **event** is a harness-level synthesis, which is easy to miss when writing an endpoint. | `src/types/index.ts:340-356` vs `:1658-1665` | One paragraph in README "Retries"/usage section, or add `usage` to the agent-level event union. |
| P3 | `HarnessUsage` uses `input`/`output`/`total`/`cached` while OpenAI-compatible hosts speak `prompt_tokens`/`completion_tokens`/`total_tokens`. Intentional, but every consumer writes the mapping. | `src/types/index.ts:154-168`; consumer: `distribution/chat-assistant/src/api/chat-assistant.ts:106-134` | Ship a `usageFromOpenAI`/`toOpenAIUsage` pair in `shared`, or state the rename rule in README "Tool names"-style prose. |
| P3 | A snapshot deliberately holds no provider config or credential, so a host must persist `baseURL`/`model` beside it. Stated once in a type comment. | `src/types/index.ts:1845-1852`; `src/server/persistence.ts:89-95` | Say the same in README's persistence section, where a host will look. |

## Operations and scaling

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | Durability is one whole-document atomic rewrite (`state.json`) at each persistence boundary, with no session count bound and no TTL/pruning policy. A shared LAN host accumulates transcripts forever, and `deleteSession` is the only removal. | `src/server/persistence.ts:961-985`; `src/server/sessions.ts:797` (`size`, no cap), `:4509` (`remove`) | Document the write model, and consider a bounded-retention policy (per-session turn cap, or `GET /sessions` paging). |
| P1 | Limits that produce 4xx are not advertised by any route: `MAX_THREAD_RECORDS` = 256 host threads (429), queue cap 100 pending turns (429), 16 MiB submit body, 1 MiB every other body. A client learns them only from a failure message. | `src/core/thread.ts:46`, `README.md:129-139`, `:1947`; `src/server/api.ts:459-476` | Publish them in the bootstrap document / `GET /health`. |
| P2 | `GET /sessions` returns every session with full `turns` + `events` + `eventTimes`. | `src/server/sessions.ts:1885-1887`, `src/server/protocol.ts:67-127` | Issue 0005(A) — summary projection. |

## Security and trust posture

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | The service Origin gate admits **every** `https://<user>.github.io` site, and there is no authentication or session ownership: any allowed browser can read and drive every session on the host. Correct for the intended single-operator deployment, surprising for a shared one. | `src/server/service.ts:18-40`, `:136-151`; `src/shared/origin.ts:65-102` | Operator-configurable allow-list (e.g. `HARNESS_ALLOWED_ORIGINS`), or state "single-trust-domain host" in README's access-control paragraph. |
| P1 | The gateway binds `0.0.0.0` by default and the file/command tools have **no workspace root**: relative paths resolve against `process.cwd()`, with no fence. So `read`/`fileWrite`/`edit`/`shell` on a LAN-exposed host operate on the server machine. | `src/server/runtime.ts:13-22`; `src/server/service.ts:32-40`; `README.md:568-571` and `:1089` ("Folder code is trusted code with process permissions") | Make the "an HTTP client can make this process touch its own filesystem" warning explicit in README's Server-and-UI section, and consider an optional pinned cwd. |
| P2 | `createHarnessRuntime` loads the package-root `.env` on the **first request**, mutating `process.env` for the whole host process. The escape hatch exists (`loadEnvironment: false`) but is only visible in an options comment. | `src/server/runtime.ts:91-94`, `src/server/environment.ts` | Document the side effect where a library consumer will read it (README "Service host"), not only in the option comment. |
| P3 | The environment surface is scattered and inconsistently named: `HARNESS_BASE_URL`/`HARNESS_API_KEY`/`HARNESS_MODEL` in code, the package-root `.env` load, a `HARNESS_SERVICE_DATABASE_ROOT` name that exists only in the service-start fixture, and a gateway UI flag spelled with a different prefix (`UNDERLOAD_HARNESS_UI`). | `src/server/config.ts:92-105`, `src/server/environment.ts`, `src/server/runtime.ts:84-88` (`loadEnvironment` option), `src/server/service-start.test.ts:77-80`, `packages/underload/service/src/server/harness-ui.ts:24-25` | One README table of every variable: who reads it, what it changes, and whether it is runtime or launcher-only; settle on one prefix. |

## Documentation

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | `README.md:1901` says "Sessions are in memory and are lost when the server restarts", which the service mount contradicts (persisted, restored, interrupted-tool repair included). | `README.md:1901` vs `src/server/service.ts:59-66`, `src/server/runtime.ts:103-140`, `src/server/persistence.ts:99-154` | Fix the sentence and say which mount persists (`variables.root`) and which does not (in-memory runtime). |
| P1 | There is no README/`docs` path for the audience that issues 0001-0005 are written for: a host building **its own** endpoint on `agent()`/`harness()`/`tool()`. The README documents the library and the shipped app; the third option is implied only by the exports table. | `README.md:174-234`, `:251-258`; `package.json:9-40` | Add `docs/build-your-own-endpoint.md`: what is reusable, what is app-private, worked example of an `agent()`-backed SSE route. |
| P1 | No HTTP contract document for `/v1/harness` (the tables in README are the only spec; sibling distributions publish `.yml` specs). | `README.md:1931-1952` | Generate or hand-maintain an OpenAPI document, and link it from `docs/`. |
| P2 | Bundler consumers are not covered by the TypeScript consumer table: with `moduleResolution: "bundler"` and no `customConditions: ["browser"]`, a Vite app resolves the **Node** root declarations (`dist/index.d.ts`) rather than `dist/browser.d.ts`, and pulling `/frontend` is the narrow, correct choice. | `README.md:264-287`; consumer: `distribution/chat-assistant/tsconfig.json:10` | Add the bundler row and the "`/frontend` for a client, `/server` for a Node route" rule. |
| P2 | `docs/` holds one file; the README Layout section documents `src/` only. | `docs/runtime-tools.md`; `README.md:174-199` | Add a `docs/` index and mention it in the layout tree. |
| P3 | The honest-status banner style used in `docs/runtime-tools.md:3-8` ("does not assert a passing production verification run") is a good pattern that appears nowhere else. | `docs/runtime-tools.md:3-8` | Reuse it for any doc that describes an unreleased surface. |

## Packaging and consumer ergonomics

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | Every published entry point points into `dist/`, so a workspace or monorepo consumer cannot import until `yarn build` has run; there is no `prepare` hook or documented build order. | `package.json:6-40` | Note the build prerequisite in README Install/Usage, or add a `prepare` script. |
| P2 | The gateway `/harness` UI mount depends on a build that lives at `packages/underload/harness/src/frontend/dist` and is excluded from the published package; the failure mode is a thrown build hint. | `packages/underload/service/src/server/harness-ui.ts:31-35`, `:71-79`; `package.json:41-52` | Document the two builds (`vite build` vs `build:frontend`) and why the second is not published. |
| P2 | Breaking renames are documented as a table, but there is no CHANGELOG or migration guide, so a consumer cannot tell what changed in the version they just installed. | `README.md:745-786`, `:781-786` ("There are **no aliases**") | Add `CHANGELOG.md` with per-version migration notes; keep the table as the long-form reference. |
| P3 | A stray emitted `vitest.config.d.ts` sits at the package root. | `vitest.config.d.ts` | Delete or ignore; it is not referenced by `exports`. |

## Code health

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P2 | Four persisted label maps express one sequence: `labelSeeds`, `labelHighWater`, `threadLabels`, `threadLabelHighWater`, described as "two mirrored views of the single canonical label sequence". High invariant load for the next contributor. | `src/server/sessions.ts:374-400`; `src/server/persistence.ts:119-136`, `:127-131` | Extract one documented label-allocator module, or add an invariants test that asserts the maps can never disagree. |
| P2 | Two independent SSE writers with the same frame contract. | `src/server/service.ts:155-254`; `src/server/handler.ts` | Issue 0006. |
| P3 | Modules that have outgrown review: `harness.ts` (~7.5k lines), `frontend/ui/turns.ts` (~5.0k), `frontend/main.ts` (~5.6k), `server/sessions.ts` (~4.1k). | line counts | Split by concern (`threads`, `tools`, `runs` in `harness.ts`; per-panel modules in the frontend) — only when the tests make the seams safe. |
| P3 | `frontend/index.ts` publishes ~12.5k lines of imperative DOM panels (`ui/*`), while `api` + `contract` are the parts a non-DOM (e.g. React) host can actually reuse. | `src/frontend/index.ts:32-47`, `src/frontend/api.ts`, `src/frontend/contract.ts`, `src/frontend/ui/turns.ts` | Say so in the barrel header and README ("reusable client: `api` + `contract`; `ui/*` owns the DOM"), or split the panels out. |

## Requests against other packages (out of this repo's hands)

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P2 | `@underload/service` parses the JSON body **before** the handler, swallows a parse failure into `{}`, and offers `streamSSE` without an abort signal — so an endpoint that must cancel a run on client disconnect has to reach for `{ raw: Response }` and re-implement the writer. | `packages/underload/service/src/server/start.ts:288-336`; harness workaround: `src/server/service.ts:13-16`, `:42-57` | Ask for `(context, parameters, variables, { signal })`, or a documented `stream` contract that carries an abort signal the handler can forward. |

## Out of scope

- The capability changes argued in issues 0001-0006.
- Any product decision about which surfaces of the package should be published at
  all (splitting `server`/`frontend` into separate packages is a bigger call than
  this list).
