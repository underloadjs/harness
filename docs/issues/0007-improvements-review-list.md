# 0007 — Improvements review list (not gaps)

> **Status:** Open — extended on 2026-11-09 with the records-store stress-test findings
> that are doc fixes or wording, not gaps (the four that are gaps became 0008-0011);
> reduced earlier the same day (closed parts deleted; the Security-P2 `.env` item trimmed
> to the escape hatch that is still undocumented); for the package owner to triage
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
| P1 | `HarnessError` now carries a stable machine `code` (+ `details`, `name = code`) but still no HTTP `status`, so every library validation failure thrown inside a host route (bad tool name, `createThread` on an unknown agent, a construction-time provider error) still maps to **HTTP 500** in the package's own classifier, and in any host that copies it. The sibling error classes carry `.status`, and a coded rejection can be branched on by `code` — but nothing maps code→status. (The "carries no status **or code**" half of this item closed 2026-11-09 under the records engine's stable machine-code convention, established when every engine rejection gained a coded error: `HarnessError` gained `code`/`details` and `toErrorInfo` passes `code` through when present.) | `src/util/errors.ts:18-43` (`code`/`details` optional; message + `cause` when uncoded), `:100-106` (`toErrorInfo` adds `code` only when present); `src/server/api.ts:4221-4253` classifier (the sibling classes report `error.status`; everything else still falls to 500) | Add an optional `status` to `HarnessError` (or a documented code→status map), or state in README that hosts must map codes themselves. |
| P2 | `HarnessToolRegistrationCandidate`'s header comment promises a `definition` field "for host/plugin compatibility"; the type does not declare one. The internal `ToolRegistrationCandidate` omits it too. | `src/types/index.ts:789-804` (comment names `definition`, body declares `name`/`description`/`tags`/`parameters`/`visibility`/`source`/`moduleText`/`sourcePath`/`dependencies`); `src/core/tool-source.ts` | Fix the comment or add the field (issue 0003 prefers adding it). |
| P2 | A standalone `agent.turn()` caller reads per-request `usage` only from the `done` event's message; the per-request `usage` **event** is a harness-level synthesis, which is easy to miss when writing an endpoint. | `src/types/index.ts:528-544` (`AgentStreamEvent` = `text` \| `reasoning` \| `retry` \| `done` \| `error` — no `usage`) vs `:2381` (harness `{ type: 'usage', agent, usage, thread? }`) | One paragraph in README "Retries"/usage section, or add `usage` to the agent-level event union. |
| P3 | `HarnessUsage` uses `input`/`output`/`total`/`cached` while OpenAI-compatible hosts speak `prompt_tokens`/`completion_tokens`/`total_tokens`. Intentional, but every consumer writes the mapping. | `src/types/index.ts:334-347`; no `usageFromOpenAI`/`toOpenAIUsage` anywhere in `src/shared/`; consumer: `distribution/chat-assistant/src/api/chat-assistant.ts` | Ship a `usageFromOpenAI`/`toOpenAIUsage` pair in `shared`, or state the rename rule in README "Tool names"-style prose. |
| P3 | A snapshot deliberately holds no provider config or credential, so a host must persist `baseURL`/`model` beside it. Stated once in a type comment. | `src/types/index.ts:2564` ("no provider configuration, API key, header, or other credential"); `src/server/persistence.ts`; `HARNESS_SNAPSHOT_VERSION` is exported at `src/harness.ts:11425` | Say the same in README's persistence section, where a host will look. |
| P1 | The records `counts.total` changes unit between the two shapes of the same call: on an unscoped read it is the **collection count**, on a scoped read the **record count** — same key, no disambiguation, and the unscoped `page {offset:0, limit:20, hasMore:false}` and `storeRev: 0` are inert beside a list of 60+ names. | `src/core/records.ts:3019-3027` (`counts: { total: names.length }`, `page` default, `storeRev: 0` with its "no single collection is addressed" comment at `:3022-3024`) vs the scoped projection at `:2915` | Rename to `counts.collections` on the unscoped shape (or drop `counts`/`page` there and say so), so one key never means two things. |
| P2 | A `field-too-long` refusal says **characters** while the cap counts UTF-16 code units, so astral-plane text is refused at half the size a reader expects — a `maxLength: 4000` body holds 2000 emoji. | `src/core/records.ts:844` and `:806` (`${text.length} characters; the limit is ${cap}`) | Reword to "UTF-16 code units", or count code points (`[...text].length`) and say which. |
| P2 | The unknown-id refusal hedges between two causes it cannot distinguish ("never in …, or its removal aged out"). The cause split is argued in 0011; the wording itself is this row. | `src/core/records.ts:1708-1709` | Once `oldestAvailableRev` exists (0011), state one cause per case. |
| P3 | A `define`d collection with no wrapper singular noun renders its own name twice in refusals: `unicode has no unicode with id "9999"`. Built-ins read correctly (`has no task with id`). | `src/core/records.ts:255-257` (`recordLabel` falls back to the collection name), used at `:1708` and `:1719` after `has no ` | Fall back to "record" rather than the collection name in that slot. |

## Operations and scaling

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | Durability is one whole-document atomic rewrite (`state.json`) at each persistence boundary, with no session count bound and no TTL/pruning policy. A shared LAN host accumulates transcripts forever, and `deleteSession` is the only removal. `turn.events` is explicitly unbounded on the same reasoning. | `src/server/persistence.ts:33-44` and `:1555-1571` (staging file + fsync + rename over the canonical file), `:758` ("`turn.events` is unbounded"); `src/server/sessions.ts:1710-1712` (`get size()`, no cap) | Document the write model, and consider a bounded-retention policy (a per-session turn cap). |

## Security and trust posture

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | The service Origin gate admits **every** `https://<user>.github.io` site, and there is no authentication or session ownership: any allowed browser can read and drive every session on the host. Correct for the intended single-operator deployment, surprising for a shared one. | `src/server/service.ts:18-40` (the gate table, and "It does NOT add authentication: the service still listens on 0.0.0.0 by default"); `src/shared/origin.ts:65-85` (`PAGES_HOST_SUFFIX`); no `HARNESS_ALLOWED_ORIGINS` anywhere in `src/` | Operator-configurable allow-list (e.g. `HARNESS_ALLOWED_ORIGINS`), or state "single-trust-domain host" in README's access-control paragraph. |
| P2 | The `loadEnvironment: false` escape hatch on the first-request `.env` load is still reachable only through an options comment: a host that must not have `process.env` mutated has no documented way to turn the load off. (The side effect itself is now documented where a consumer reads it, so only the hatch remains.) | `src/server/runtime.ts:127-129` (`loadEnvironment` option), `:139-142` (`if (options.loadEnvironment !== false) loadEnvironmentFile()`); the documented side effect: `README.md:3426`, `README.md:3785-3789` | Name `loadEnvironment: false` next to the README:3785 paragraph, where the side effect is already described. |
| P3 | The environment surface is inconsistently named: the gateway UI flag is spelled with a different prefix (`UNDERLOAD_HARNESS_UI`) from every harness variable (`HARNESS_*`), and `HARNESS_SERVICE_DATABASE_ROOT` exists only in a test fixture. | `README.md:2115-2126` (one table: `HARNESS_BASE_URL`/`_API_KEY`/`_MODEL`, the search keys, `HARNESS_THREAD_EXECUTION`, the worker bounds, `HARNESS_IO_*`); `packages/underload/service/src/server/harness-ui.ts` (`HARNESS_UI_ENV === 'UNDERLOAD_HARNESS_UI'`); `src/server/service-start.test.ts:106` | Settle on one prefix, and note the launcher-only flags in the same table. |

## Documentation

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | `README.md` says "Sessions are in memory and are lost when the server restarts", which the service mount contradicts (persisted, restored, interrupted-tool repair included). | `README.md:2671` vs `src/server/service.ts:70-77`, `src/server/runtime.ts:103-140`, `src/server/persistence.ts:99-154` | Fix the sentence and say which mount persists (`variables.root`) and which does not (in-memory runtime). |
| P1 | There is no README/`docs` path for the audience that issues 0001-0005 are written for: a host building **its own** endpoint on `agent()`/`harness()`/`tool()`. The README documents the library and the shipped app; the third option is implied only by the exports table. | `README.md:192-257`, `:274-280`; `package.json:9-58`; grep `build your own endpoint` over `README.md` and `docs/` → 0 matches | Add `docs/build-your-own-endpoint.md`: what is reusable, what is app-private, worked example of an `agent()`-backed SSE route. |
| P2 | Bundler consumers are not covered by the TypeScript consumer table: with `moduleResolution: "bundler"` and no `customConditions: ["browser"]`, a Vite app resolves the **Node** root declarations (`dist/index.d.ts`) rather than `dist/browser.d.ts`, and pulling `/frontend` is the narrow, correct choice. | `README.md:300-305` (rows for `node16`/`NodeNext` and for `customConditions: ["browser"]`; grep `bundler` over `README.md` → 0 matches); consumer: `distribution/chat-assistant/tsconfig.json` | Add the bundler row and the "`/frontend` for a client, `/server` for a Node route" rule. |
| P3 | The honest-status banner style used in `docs/runtime-tools.md:3-8` ("does not assert a passing production verification run") is a good pattern that appears in only one other place. (`docs/plugins.md` adopted it 2026-11-09; the two logs still open with prose, not a banner.) | `docs/runtime-tools.md:3-8`, `docs/plugins.md:3-14`; `docs/issues/README.md` and `docs/tasks/README.md` open with prose, not a status banner | Reuse it for any doc that describes an unreleased surface. |
| P1 | The `getOnly` field description states the wrong boundary: "only a **single-record** read returns it". The engine returns it from **any** `ids` read, one id or many; only pages and mutation results withhold it. | `src/tools/runtime/records.tool.ts:235` (the wording), and `src/tools/runtime/records.tool.ts:90` ("One id answers with `entry` … several with `entries`") vs `src/core/records.ts:2582-2586` (`readIds` always copies with `full = true`) and `:305` (`full === false` is the only exclusion), pinned at runtime 2026-11-09: `ids:["10","11"]` returned `hidden` on both, a `limit:20` page on neither | Say "returned by an `ids` read (one id or several), never by a page or a mutation result". |
| P1 | The `records` headline contradicts its own guard: "EVERY PATCH IS ACCEPTED UNLESS IT IS STALE" — but a patch from an agent with no `expects` token is **refused**, not accepted, and the refusal is a different code (`guarded-write`, not `stale-record`). | `src/tools/runtime/records.tool.ts:40` (the headline clause) vs `src/core/records.ts:1761-1780` (the guard throws for every agent-identified write) | Qualify the clause: "…unless it is stale, and an agent write with no token is refused until you read the record". |

## Packaging and consumer ergonomics

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P1 | Every published entry point's `default` target points into `dist/`, so a workspace or monorepo consumer that does not select the `development` condition cannot import until `yarn build` has run; there is no `prepare` hook and the build prerequisite is stated only as a test recipe. | `package.json:9-58` (each export has `"development": "./src/…"` and `"default": "./dist/…"`; no `prepare` script); `README.md:311-317` ("`yarn build && yarn test:package` …") | Note the build prerequisite in README Install/Usage, or add a `prepare` script. |
| P2 | Breaking renames are documented as a table, but there is no CHANGELOG or migration guide, so a consumer cannot tell what changed in the version they just installed. | `README.md:974` ("There are **no aliases**: the old names are gone from the wire surface"); no `CHANGELOG.md` at the package root | Add `CHANGELOG.md` with per-version migration notes; keep the table as the long-form reference. |

## Code health

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P2 | Four persisted label maps express one sequence: `labelSeeds`, `labelHighWater`, `threadLabels`, `threadLabelHighWater`. High invariant load for the next contributor; the sequence itself is pinned by a test, but the four maps remain. | `src/server/sessions.ts:571-597`, `:2012-2015`; `src/server/persistence.ts`; pinned by `src/server/labels.test.ts` (its header lists the eight requirements, including "deletion retires a name across a restart") | Extract one documented label-allocator module. |
| P2 | Two independent SSE writers with the same frame contract. | `src/server/service.ts:184-284`; `src/server/handler.ts:163-198` | Issue 0006. |
| P3 | Modules that have outgrown review, and growing: `harness.ts` 11,551 lines, `frontend/main.ts` 12,211, `frontend/ui/turns.ts` 9,722, `server/sessions.ts` 9,522. | `wc -l` on the current tree | Split by concern (`threads`, `tools`, `runs` in `harness.ts`; per-panel modules in the frontend) — only when the tests make the seams safe. |
| P3 | `ids` is mapped without deduplication, so a repeated id is returned twice — and the `tasks` wrapper's own description promises the opposite ("one id may appear in only ONE of `tasks`/`remove`/`ids` per call", which reads as a uniqueness rule for `ids` itself). `entries` and `remove` both reject a repeated id; `ids` silently duplicates. | `src/core/records.ts:2582-2586` (`ids.map(…)` — no set, no refusal) vs `:1743`/`:1750` (the duplicate-id refusals for the other two keys) and `src/tools/runtime/tasks.tool.ts:38` (the sentence); runtime 2026-11-09: `tasks {ids:["1","1"]}` returned id 1 twice, `records {ids:["1","1"]}` returned it twice | Deduplicate, or refuse a repeated id the way `entries`/`remove` do, and align the wrapper sentence. |
| P3 | `frontend/index.ts` publishes ~15.9k lines of imperative DOM panels (the 14 `ui/*` modules it re-exports) alongside the two parts a non-DOM (e.g. React) host can actually reuse. The barrel header lists the panels and marks `main.ts` as not exported, and README calls it "the reusable client: api + contract + ui panels", but neither states that `ui/*` owns the DOM and a React host should take `api` + `contract` only. | `src/frontend/index.ts:26-48`; `README.md:242` | Say so in the barrel header and README ("reusable client: `api` + `contract`; `ui/*` owns the DOM"), or split the panels out. |

## Requests against other packages (out of this repo's hands)

| P | Item | Evidence | Suggested action |
|---|---|---|---|
| P2 | `@underload/service` still parses the JSON body **before** the handler in its default mode, swallows a parse failure into `{}`, and offers `streamSSE` without an abort signal — so an endpoint that must cancel a run on client disconnect has to reach for `{ raw: Response }` and re-implement the writer. The harness works around all three (`body: 'raw'`, its own bounded reader, its own writer); a host has to discover the workaround. | `packages/underload/service/src/server/start.ts:147-148` (`'raw'` skips the pre-buffer), `:339` (`catch { body = {} }`), `:363-387` (`streamSSE`, breaks on `stream.aborted`, never signals the handler); harness workaround: `src/server/service.ts:42-57`, `:16` | Ask for `(context, parameters, variables, { signal })`, or a documented `stream` contract that carries an abort signal the handler can forward. |

## Out of scope

- The capability changes argued in issues 0001-0006.
- Any product decision about which surfaces of the package should be published at all
  (splitting `server`/`frontend` into separate packages is a bigger call than this list).

