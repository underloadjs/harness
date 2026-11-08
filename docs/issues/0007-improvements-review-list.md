# 0007 — Improvements review list (not gaps)

> **Status:** Open — reduced on 2026-11-09 (closed parts deleted); for the
> package owner to triage
> **Severity:** Review list
> **Area:** cross-cutting
> **Date opened:** 2026-11-02

Everything below was found in the same review pass as issues 0001-0006 but is **not** a
capability gap: each item is a decision, a cleanup, a doc fix, or an ergonomics change. They
are listed separately so the capability work (0001-0006) is not held hostage to judgement
calls.

Priority vocabulary: **P1** = cheap and prevents a consumer making a wrong assumption; **P2**
= worth scheduling; **P3** = tidy-up.

## Contract and types

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | `HarnessError` now carries a stable machine `code` (+ `details`, `name = code`) but still no HTTP `status`, so every library validation failure thrown inside a host route (bad tool name, `createThread` on an unknown agent, a construction-time provider error) still maps to **HTTP 500** in the package's own classifier, and in any host that copies it. The sibling error classes carry `.status`, and a coded rejection can be branched on by `code` — but nothing maps code→status. (The "carries no status **or code**" half of this item closed 2026-11-09 with the records engine's Decision O: `HarnessError` gained `code`/`details` and `toErrorInfo` passes `code` through when present.) | `src/util/errors.ts:18-43` (`code`/`details` optional; message + `cause` when uncoded), `:100-106` (`toErrorInfo` adds `code` only when present); `src/server/api.ts` classifier (the sibling classes report `error.status`; everything else still falls to 500) | Add an optional `status` to `HarnessError` (or a documented code→status map), or state in README that hosts must map codes themselves. |
| P2 | `HarnessToolRegistrationCandidate`'s header comment promises a `definition` field "for host/plugin compatibility"; the type does not declare one. The internal `ToolRegistrationCandidate` omits it too. | `src/types/index.ts:709-724` (comment names `definition`, body declares `name`/`description`/`tags`/`parameters`/`visibility`/`source`/`moduleText`/`sourcePath`/`dependencies`); `src/core/tool-source.ts` | Fix the comment or add the field (issue 0003 prefers adding it). |
| P2 | A standalone `agent.turn()` caller reads per-request `usage` only from the `done` event's message; the per-request `usage` **event** is a harness-level synthesis, which is easy to miss when writing an endpoint. | `src/types/index.ts:448-464` (`AgentStreamEvent` = `text` \| `reasoning` \| `retry` \| `done` \| `error` — no `usage`) vs `:2293` (harness `{ type: 'usage', agent, usage, thread? }`) | One paragraph in README "Retries"/usage section, or add `usage` to the agent-level event union. |
| P3 | `HarnessUsage` uses `input`/`output`/`total`/`cached` while OpenAI-compatible hosts speak `prompt_tokens`/`completion_tokens`/`total_tokens`. Intentional, but every consumer writes the mapping. | `src/types/index.ts:254-267`; no `usageFromOpenAI`/`toOpenAIUsage` anywhere in `src/shared/`; consumer: `distribution/chat-assistant/src/api/chat-assistant.ts` | Ship a `usageFromOpenAI`/`toOpenAIUsage` pair in `shared`, or state the rename rule in README "Tool names"-style prose. |
| P3 | A snapshot deliberately holds no provider config or credential, so a host must persist `baseURL`/`model` beside it. Stated once in a type comment. | `src/types/index.ts:2476` ("no provider configuration, API key, header, or other credential"); `src/server/persistence.ts`; `HARNESS_SNAPSHOT_VERSION` is exported at `src/harness.ts:11425` | Say the same in README's persistence section, where a host will look. |

## Operations and scaling

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | Durability is one whole-document atomic rewrite (`state.json`) at each persistence boundary, with no session count bound and no TTL/pruning policy. A shared LAN host accumulates transcripts forever, and `deleteSession` is the only removal. `turn.events` is explicitly unbounded on the same reasoning. | `src/server/persistence.ts:33-44` and `:1554-1571` (staging file + fsync + rename over the canonical file), `:748` ("`turn.events` is unbounded"); `src/server/sessions.ts:1665-1666` (`get size()`, no cap) | Document the write model, and consider a bounded-retention policy (a per-session turn cap). |

## Security and trust posture

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | The service Origin gate admits **every** `https://<user>.github.io` site, and there is no authentication or session ownership: any allowed browser can read and drive every session on the host. Correct for the intended single-operator deployment, surprising for a shared one. | `src/server/service.ts:25-40` (the gate table, and "It does NOT add authentication: the service still listens on 0.0.0.0 by default"); `src/shared/origin.ts:65-85` (`PAGES_HOST_SUFFIX`); no `HARNESS_ALLOWED_ORIGINS` anywhere in `src/` | Operator-configurable allow-list (e.g. `HARNESS_ALLOWED_ORIGINS`), or state "single-trust-domain host" in README's access-control paragraph. |
| P2 | `createHarnessRuntime` loads the package-root `.env` on the **first request**, mutating `process.env` for the whole host process. The escape hatch exists (`loadEnvironment: false`) but is only visible in an options comment. | `src/server/runtime.ts:127-129` (`loadEnvironment` option), `:140-142` (`if (options.loadEnvironment !== false) loadEnvironmentFile()`); `src/server/environment.ts` | Document the side effect where a library consumer will read it (README "Service host"), not only in the option comment. |
| P3 | The environment surface is inconsistently named: the gateway UI flag is spelled with a different prefix (`UNDERLOAD_HARNESS_UI`) from every harness variable (`HARNESS_*`), and `HARNESS_SERVICE_DATABASE_ROOT` exists only in a test fixture. | `README.md:2115-2126` (one table: `HARNESS_BASE_URL`/`_API_KEY`/`_MODEL`, the search keys, `HARNESS_THREAD_EXECUTION`, the worker bounds, `HARNESS_IO_*`); `packages/underload/service/src/server/harness-ui.ts` (`HARNESS_UI_ENV === 'UNDERLOAD_HARNESS_UI'`); `src/server/service-start.test.ts:106` | Settle on one prefix, and note the launcher-only flags in the same table. |

## Documentation

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | `README.md` says "Sessions are in memory and are lost when the server restarts", which the service mount contradicts (persisted, restored, interrupted-tool repair included). | `README.md:2671` vs `src/server/service.ts:59-66`, `src/server/runtime.ts:103-140`, `src/server/persistence.ts:99-154` | Fix the sentence and say which mount persists (`variables.root`) and which does not (in-memory runtime). |
| P1 | There is no README/`docs` path for the audience that issues 0001-0005 are written for: a host building **its own** endpoint on `agent()`/`harness()`/`tool()`. The README documents the library and the shipped app; the third option is implied only by the exports table. | `README.md:174-234`, `:251-258`; `package.json:8-45`; grep `build your own endpoint` over `README.md` and `docs/` → 0 matches | Add `docs/build-your-own-endpoint.md`: what is reusable, what is app-private, worked example of an `agent()`-backed SSE route. |
| P2 | Bundler consumers are not covered by the TypeScript consumer table: with `moduleResolution: "bundler"` and no `customConditions: ["browser"]`, a Vite app resolves the **Node** root declarations (`dist/index.d.ts`) rather than `dist/browser.d.ts`, and pulling `/frontend` is the narrow, correct choice. | `README.md:280-292` (rows for `node16`/`NodeNext` and for `customConditions: ["browser"]`; grep `bundler` over `README.md` → 0 matches); consumer: `distribution/chat-assistant/tsconfig.json` | Add the bundler row and the "`/frontend` for a client, `/server` for a Node route" rule. |
| P3 | The honest-status banner style used in `docs/runtime-tools.md:3-8` ("does not assert a passing production verification run") is a good pattern that appears in only one other place. (`docs/plugins.md` adopted it 2026-11-09; the two logs still open with prose, not a banner.) | `docs/runtime-tools.md:3-8`, `docs/plugins.md:3-14`; `docs/issues/README.md` and `docs/tasks/README.md` open with prose, not a status banner | Reuse it for any doc that describes an unreleased surface. |

## Packaging and consumer ergonomics

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | Every published entry point's `default` target points into `dist/`, so a workspace or monorepo consumer that does not select the `development` condition cannot import until `yarn build` has run; there is no `prepare` hook and the build prerequisite is stated only as a test recipe. | `package.json:8-45` (each export has `"development": "./src/…"` and `"default": "./dist/…"`; no `prepare` script); `README.md:300-306` ("`yarn build && yarn test:package` …") | Note the build prerequisite in README Install/Usage, or add a `prepare` script. |
| P2 | Breaking renames are documented as a table, but there is no CHANGELOG or migration guide, so a consumer cannot tell what changed in the version they just installed. | `README.md:960` ("There are **no aliases**: the old names are gone from the wire surface"); no `CHANGELOG.md` at the package root | Add `CHANGELOG.md` with per-version migration notes; keep the table as the long-form reference. |

## Code health

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P2 | Four persisted label maps express one sequence: `labelSeeds`, `labelHighWater`, `threadLabels`, `threadLabelHighWater`. High invariant load for the next contributor; the sequence itself is pinned by a test, but the four maps remain. | `src/server/sessions.ts:557-583`, `:1967-1970`; `src/server/persistence.ts`; pinned by `src/server/labels.test.ts` (its header lists the eight requirements, including "deletion retires a name across a restart") | Extract one documented label-allocator module. |
| P2 | Two independent SSE writers with the same frame contract. | `src/server/service.ts:184-284`; `src/server/handler.ts:165-176` | Issue 0006. |
| P3 | Modules that have outgrown review, and growing: `harness.ts` 10,329 lines, `frontend/main.ts` 12,132, `frontend/ui/turns.ts` 9,449, `server/sessions.ts` 8,949. | `wc -l` on the current tree | Split by concern (`threads`, `tools`, `runs` in `harness.ts`; per-panel modules in the frontend) — only when the tests make the seams safe. |
| P3 | `frontend/index.ts` publishes ~12.5k lines of imperative DOM panels (`ui/*`) alongside the two parts a non-DOM (e.g. React) host can actually reuse. The barrel header lists the panels and marks `main.ts` as not exported, and README calls it "the reusable client: api + contract + ui panels", but neither states that `ui/*` owns the DOM and a React host should take `api` + `contract` only. | `src/frontend/index.ts:26-48`; `README.md:235` | Say so in the barrel header and README ("reusable client: `api` + `contract`; `ui/*` owns the DOM"), or split the panels out. |

## Requests against other packages (out of this repo's hands)

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P2 | `@underload/service` still parses the JSON body **before** the handler in its default mode, swallows a parse failure into `{}`, and offers `streamSSE` without an abort signal — so an endpoint that must cancel a run on client disconnect has to reach for `{ raw: Response }` and re-implement the writer. The harness works around all three (`body: 'raw'`, its own bounded reader, its own writer); a host has to discover the workaround. | `packages/underload/service/src/server/start.ts:147-148` (`'raw'` skips the pre-buffer), `:339` (`catch { body = {} }`), `:363-381` (`streamSSE`, breaks on `stream.aborted`, never signals the handler); harness workaround: `src/server/service.ts:42-57`, `:16` | Ask for `(context, parameters, variables, { signal })`, or a documented `stream` contract that carries an abort signal the handler can forward. |

## Out of scope

- The capability changes argued in issues 0001-0006.
- Any product decision about which surfaces of the package should be published at all
  (splitting `server`/`frontend` into separate packages is a bigger call than this list).

