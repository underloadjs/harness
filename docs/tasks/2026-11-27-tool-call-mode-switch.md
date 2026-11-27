# 2026-11-27 — The reserved per-call `async` switch, and the lone-delegate refinement

**Date:** 2026-11-27
**Method:** this entry is the DOCUMENTATION pass over a production change that had already
landed and been accepted, so every anchor below was re-read off the working tree before it was
written. What was a **read**: the whole resolution chain (`src/engine/harness.ts`,
`src/engine/core/tool.ts`, `src/engine/core/schema-validation.ts`, the `delegate`/`threadFork`/
`toolCancel` entries, `src/engine/types/index.ts`, `src/engine/plugins/async-ping.plugin.ts`) and
the generated manifest. What was a **run**: the catalogue-cost figure, settled by
`yarn vitest run src/engine/harness.inclusion.test.ts -t "keeps \`estimatedTokens\` entry-time"`
— at the start of this pass the fixture reported `entryBefore/entryAfter = 3866` against its
standing pin of `3744` (the test pass re-anchored that file mid-pass, and the re-anchored figures
are cited where they now live), and the
fixture's own estimator produced both numbers, so **+122 estimated tokens/request is measured, not
inferred**. What was **carried from the implementer's probe, not re-run here**: the
`wakeIntervalMs: 40` heartbeat probe (2 wakeups / 2 placeholder turns refined-sync; 1 self-release
turn + 3 wakeups with `"async": true`) — reproduced by no test in the tree, so it is reported as a
probe figure. **Scratch and logs lived in repo-root `Temp/`** (`Temp/docsgroup/`), per the root
`AGENTS.md` policy, and every command here is `yarn vite-node` / `yarn vitest run` — never raw
`node`, `tsx` or `ts-node`.
**Scope (docs only, no `.ts` byte touched):** `src/harness-engine.md` (the `tool()` field table
plus the heartbeat rows the new default makes reachable), `knowledge.md` ("Turn modes: sync vs
async (T2)"), `README.md` (the `### tool()` mode bullets and the loop section),
`docs/runtime-tools.md` (the descriptor `mode` field, the definition-bound policy flags, the
argument door), `docs/plugins.md` (the `async.*` seam), this file,
`docs/tasks/2026-11-19-heartbeat-async-only.md` (an addendum, the original claims kept), and a
cross-reference in issue 0039. `src/engine/core/tool-manifest.ts` is **byte-identical**: the
declared defaults did not move. The `.ts` edits in this working tree (including the new
`src/engine/harness.tool-async-switch.test.ts` and the re-anchored estimate pins) came from the
concurrent implementation/test passes, not from this one; where they landed during this pass they
are named as such in Findings 4 and in task 1.

**Correction pass (same date, AFTER this entry was first written — 2026-11-27, `corrected`):** an
independent verification pass re-measured the cost and re-ran the suites, **A/B against pristine HEAD
`e66bce8`** by way of a worktree of that commit (`Temp/coding/head-wt`, logs `Temp/coding/` — the
both-trees probe is `Temp/coding/probe-catalogue-ab.ts`, legs `Temp/coding/probe-ab-head.txt` and
`Temp/coding/probe-ab-now.txt`). It **refuted three claims this entry made** and supplied the figure
it should have carried; each refuted sentence is kept below, marked `corrected`, and the mechanism
replaced — Findings 4 (the failure count, the per-declaration split, and the cause of the two
compaction cases), task 1 (now closed), and the index row in `docs/tasks/README.md`. What the
verification pass changed is **markdown only**: no `.ts` byte and no production behaviour moved
during it. **Line-shift note:** this correction grows Finding 4, task 1 and the task list, so every
line number AFTER `:101` in this file has shifted; nothing in the tree cites this file by line
number — the six in-tree references are file- or finding-level (`docs/tasks/README.md:28`,
`docs/plugins.md:864`, `knowledge.md:1562`, `README.md:2309`,
`docs/tasks/2026-11-19-heartbeat-async-only.md:282`, and
`docs/issues/minor-folder-tool-registration-mode-is-inert-at-runtime.md:98`, which cites
"Findings 1-2 and 6"), and all of them still resolve.

**Second correction pass (also 2026-11-27 — the final bounded review; Finding 7, tasks 7-9, and
the 26-row cost row/paragraph of Finding 4b, `corrected`).** Still markdown only. It grew
`knowledge.md` (+21 lines before the cost paragraph) and `README.md` (+12 lines before its loop
section), so the two in-tree citations that NAME line numbers moved and are re-pointed here:
this file's reference to `knowledge.md:1562` is now `knowledge.md:1586` (verified: that line is
the sentence carrying this file's path), and its `README.md:2309` is now `README.md:2320`
(verified, same rule); `docs/plugins.md:864` and `docs/tasks/README.md:28` did not move, and
`docs/tasks/2026-11-19-heartbeat-async-only.md:282` and
`docs/issues/minor-folder-tool-registration-mode-is-inert-at-runtime.md:98` are untouched by this
pass. Inside THIS file nothing was inserted above `:143`, so the `:101` rule above still holds —
the additions are a paragraph at `:156`, a table row at `:197`, Finding 7 at `:246`, tasks 7-9 at
`:364`, a status note on task 5 at `:338`, and three "Not tested" bullets at `:431` — every one of
them at or below the point it extends, and none of them above `:143`.

---

## The request

"When delegate, if it requests only 1 delegate, the mode default is sync. Currently it is always
async, but 1 delegate doesn't need to be async by default unless the spawner requested it."
Clarified into a general rule: "All tools should have async or sync ⇒ true or false as an optional
tool switch, allowing the tool to run in sync or async mode. Each tool has a default. Most tools
are sync, but some like delegate or threadFork are async by default. This should have been in the
specification. If a gap, implement it." And: "1 delegate means the spawner only calls 1 agent.
For 1 sub-agent spawn, it doesn't need to be async by default since the spawner is likely waiting
for the result of the spawned subagent."

## Findings

### 1. Every offered declaration now carries one reserved argument the catalogue does not

| Fact | Evidence |
|---|---|
| The key and its description are owned by one module: `TOOL_ASYNC_PARAMETER_KEY = 'async'` and the one-sentence model-facing hint | `src/engine/core/tool.ts:129`, `:133-134`; the factory section of `src/harness-engine.md` states the contract |
| It is added to the **model-facing copy** only, never to `definition.parameters` | `withToolAsyncSwitch` `src/engine/core/tool.ts:156`; the two call sites are `src/engine/harness.ts:7008` (ordinary rows, including the rank-projected `delegate` copy) and `:7037` (the pending-only `toolCancel` row) |
| Why a copy is mandatory: `definition.parameters` is ALSO the validation schema, and a second property would break the single-property rule for `read`/`sleep`/`toolCancel`-shaped tools | `toolParameterKey` `src/engine/core/tool.ts:66-73`, the comment block at `:112-120` |
| It is stripped centrally, as the FIRST statement of the shared resolver, so closed (`additionalProperties:false`) schemas still accept it and `context.parameters` never sees it | `resolveToolParameters` `src/engine/core/schema-validation.ts:336`, the strip at `:353` (`stripToolAsyncSwitch`, `src/engine/core/tool.ts:206`) |
| Every plane passes that one function: the model wire, `callTool`, `executeTool`, and the server's manual tool route | `src/engine/harness.ts:1213`, `:17549`, `:17650`; `src/server/api.ts:2937` |
| A non-boolean value is a readable refusal, identically on every plane: `$.async must be a boolean (true for async, false for sync); received <type>.` | `stripToolAsyncSwitch` `src/engine/core/tool.ts:206-222` |
| A tool that declares `async` in its OWN schema owns it: not injected, not stripped, never a mode | `toolOwnsAsyncParameter` `src/engine/core/tool.ts:144`, honoured at `:157` and in the strip's `owns` argument (`src/engine/core/schema-validation.ts:353`) |
| The transcript keeps what the model wrote — only the resolved value is stripped, so provider replay stays byte-exact | `src/engine/types/index.ts:100-123`; pinned as a fixture at `src/engine/harness.background.test.ts:1511` |
| **Catalogue vs declaration asymmetry (spec gap the request named):** `GET /v1/harness/tools` publishes the registered `parameters` literal WITHOUT the key; only the request's tools array carries it | the two injection sites above are the only ones (`src/engine/core/tool.ts:156` is referenced nowhere else in `src/engine/harness.ts`); documented in `docs/runtime-tools.md` and `src/harness-engine.md` |

### 2. The mode is now a per-call resolution, with a delegate-only refinement

| Fact | Evidence |
|---|---|
| Precedence for one call: the explicit switch → the discovered registration policy → `definition.mode` → `DEFAULT_TOOL_MODE` (`'sync'`) | the block comment at `src/engine/harness.ts:11911-11958`; step 1 `:11946`, step 2 `:11951` (`effectiveToolMode` `:2082-2083`, `modeDefinitions` `:2073`), default `src/engine/core/tool.ts:85` |
| The switch beats the chain in BOTH directions, and the switch is read tolerantly, before validation, against the RESOLVED definition | `readCallAsyncSwitch` `src/engine/harness.ts:1229-1249` (`undefined` for malformed JSON, a non-object, an absent key, or a non-boolean) |
| **The lone-delegate refinement:** no switch + step 2 resolved `'async'` + the message holds EXACTLY ONE async-resolving call + the definition is the BASELINE `delegate` row ⇒ the call resolves `'sync'` | `loneDelegation` / `callMode` `src/engine/harness.ts:11960-11966`; the baseline marker is `rankProjectedDefinitions` (`:2052`), so a replacement under the same wire name inherits nothing |
| It counts **async-resolving calls**, not delegates — one `delegate` plus one `threadFork`/`shell` is a fan-out and keeps async; an explicit `false` is NOT counted (it is another call the spawner waits on) | `countAsyncResolvedCalls` `src/engine/harness.ts:2104-2131`, computed once per message at the launch loop `:15444` and passed to every launch `:15448` |
| An un-instrumented caller can never trigger the refinement | the `asyncResolvedCalls` parameter is optional and omitted means "no message context", `src/engine/harness.ts:11788-11795` |
| Declared defaults are UNCHANGED, which is why docs must say "defaults to", never "is": `delegate` `mode:'async'`, `threadFork` `mode:'async'`, `shell` `mode:'async'`, `toolCancel` declares nothing | `src/engine/tools/runtime/delegate.tool.ts:261`, `src/engine/tools/runtime/threadFork.tool.ts:121`, `src/engine/tools/command/shell.tool.ts:378` (and `:425` on the standalone tool), `src/engine/tools/runtime/toolCancel.tool.ts:70` |

### 3. The control tools keep their own policies, and each honours the switch differently

| Control | Behaviour | Evidence |
|---|---|---|
| `threadFork` | joins the message's sync group ONLY on an explicit `"async": false`; absent, `true`, or a fork that owns the key keeps the historical no-group launch. The refinement never reaches a fork | dispatch `src/engine/harness.ts:12107`, the group handed down at `:12111` (`switchValue === false ? batch : undefined`), rationale at `:12088-12091`; the entry's own comment `src/engine/tools/runtime/threadFork.tool.ts:115-121` |
| `actionRequest` | defaults to `'sync'`; `"async": true` clears its group, and the join helper ignores an absent group, so a validation failure that never schedules can never hold the gate | called with `syncGroup` at `src/engine/harness.ts:12117`, joins at `:13185` (definition `:12938`), rule stated at `:12093-12099` |
| `toolCancel` | accepts the key and ignores it: it answers inline and never schedules, so there is no completion whose trigger could be grouped. The switch is still advertised on it, so the model is never taught the key is per-tool | advertised at `src/engine/harness.ts:7029-7037`; its dispatch is the baseline-control marker branch, `runtimeControlDefinitions.get(definition) === 'toolCancel'` at `:11984` |

### 4. Measured: advertising the key costs +122 estimated tokens per request

The package prices a request with `estimateContextTokens` (`src/engine/core/context-estimate.ts:600`),
and the tool catalogue is priced through `toolSchemaPayloadBytes` (`:451`) — serialized payload
bytes, `/4`. The estimate fixture in `src/engine/harness.inclusion.test.ts` states its own
arithmetic (`ceil((transcript bytes + catalogue bytes)/4)`, `3,744` from a `14,951`-byte catalogue
for the three declarations that roster offers). Re-running that one case after the change:

```
$ yarn vitest run src/engine/harness.inclusion.test.ts -t "keeps `estimatedTokens` entry-time"
AssertionError: expected { entryBefore: 3866, …(7) } to deeply equal { entryBefore: 3744, …(7) }
  - "entryBefore": 3744    + "entryBefore": 3866
  - "liveAfter":   3742    + "liveAfter":   3864
```

| Fact | Evidence |
|---|---|
| **+122 estimated tokens per request** on that fixture — 3,744 → 3,866, i.e. the catalogue floor moved 14,951 → 15,438 bytes (+487 B) | the assertion above (the fixture's OWN estimator, both numbers), and the re-anchored pin that now states the same arithmetic: `src/engine/harness.inclusion.test.ts:3264` (15,438), `:3306-3308`, `:3309`, `:3328` |
| **`corrected` (2026-11-27 verification pass)** — the injected property is `{type:'boolean', description: TOOL_ASYNC_PARAMETER_DESCRIPTION}`, ONE sentence on purpose, because every tool the request declares pays it on every request, parameterless ones included (that part stands). The original claim was: *"The inclusion fixture's 487-byte total across three declarations is roughly 2 × 151 B plus a larger first entry (a schema that declared no `properties` at all gains the whole `properties` object …); the per-entry split was not measured, only the per-request total."* **There is no 151 B and the split IS measured**: appending the key beside existing `properties` costs **147 B** per row (146 B on `threadList`, whose description sits one byte cheaper), and the first key into a declaration that declares NO `properties` costs **193 B**, because `withToolAsyncSwitch` has to materialize the object — the non-record branch at `src/engine/core/tool.ts:166` is what turns `undefined` into `{type:'object',properties:{async:…}}`. A 3-row roster is therefore **193 + 147 + 147 = 487 B**, which is exactly the total both 3-row fixtures show | `src/engine/core/tool.ts:133-134`, `:156-176` (the `properties`-materializing branch at `:166`); per-entry A/B probe `Temp/coding/probe-catalogue-ab.ts`, both trees (`Temp/coding/probe-ab-head.txt` vs `Temp/coding/probe-ab-now.txt`), reproduced as prose in the two fixtures that pay it: `src/engine/harness.budget.test.ts:645-658`, `src/engine/harness.inclusion.test.ts:3258-3270` |
| The inclusion fixture's pins were stale when this documentation pass started and were **re-anchored during it** by the test pass (the file moved from 3,744 to 3,866 while this entry was being written) — the pass re-verified the new figures by re-running the file green | `src/engine/harness.inclusion.test.ts:3309` now pins `entryBefore/liveBefore: 3866`, `liveAfter: 3864`; `yarn vitest run src/engine/harness.inclusion.test.ts` → green (log `Temp/docsgroup/estimate-suites-rerun.log`) |
| **Every catalogue-derived estimate in the tree moved the same way** — and, **`corrected`**, they are **no longer stale**: the tree is green. The original claim was: *"Measured on this tree after the inclusion fix: 21 tests across 3 files fail on the new figures … `harness.budget.test.ts` `3736 → 3857` (+121, 5 declarations; its catalogue row `14,939 → 15,426` bytes, +487 B ≈ 5 × 151) …"*. Two things in it were wrong. **(a) The count.** That figure came from a SIX-FILE focused run, so it could only ever count what it ran: the authoritative first **full** run of the tree is `Test Files 4 failed / 269 passed (273)` and `Tests 24 failed / 5,127 passed (5,151)` (vitest's own summary line, written with `/` because a literal pipe would break this table row), and the fourth file — `src/server/harness.it19-retention.test.ts`, 3 failures — is invisible to that focused list (Finding 5's host row, and task 1). **(b) The arithmetic.** That roster prices **3** declarations, not 5, and the 487 B is not `5 × 151`: it is **193 B on the parameterless `echo` row + 147 B + 147 B on the two appends**, and the pristine-HEAD leg of the same probe reproduces `14,939 B` exactly, which is what makes the delta a measurement rather than a division. The shift rule itself stands: `ceil(injected bytes / 4)`, so it scales with how many declarations the roster offers — see the per-roster table below this finding. **Final state (verification pass):** `273/273` files, `5,151/5,151` tests, 0 failed, 0 skipped, from **test-only** fixes — no production file touched, and `git diff` on `src/engine/core/tool-manifest.ts` is **empty** | the six-file focused run that produced the refuted count — `yarn vitest run src/engine/harness.inclusion.test.ts src/engine/harness.budget.test.ts src/engine/harness.plugin.test.ts src/engine/plugin/context-compaction.test.ts src/engine/harness.tool-async-switch.test.ts src/engine/harness.background.test.ts` → `3 failed / 3 passed` files, `21 failed / 264 passed` tests (logs `Temp/docsgroup/estimate-suites.log`, then `Temp/docsgroup/estimate-suites-rerun.log`); the authoritative full run: `Temp/coding/d1-full-suite.log:659-660` (vitest's summary — 4 failed / 269 passed files of 273, 24 failed / 5,127 passed tests of 5,151); the final green run: `Temp/coding/d6-full-suite.txt` (273 / 273 files, 5,151 / 5,151 tests, nothing skipped); the HEAD legs `Temp/coding/probe-ab-head.txt` and `Temp/coding/probe-ab-now.txt`; the re-anchored pins that now state 3 rows and the measured split: `src/engine/harness.budget.test.ts:645-658`, `:707` (`toBe(15_426)`), `:724` (`3857, 3860`) |
| Two compaction cases fail for a second reason and are NOT a re-anchor job — they assert the shape of a compaction turn, and their tokens moved the plugin's own `minTokens` gate → **`corrected` (2026-11-27 verification pass): they WERE a re-anchor job — stale floor constants, closed by moving constants only, and the gate that bit was not `minTokens`.** Mechanism, which the file's own comments had already predicted: both cases size their **ceiling relative to the tool-catalogue floor** (`contextLimit: CATALOGUE + 100` / `minTokens: CATALOGUE + 200` at `src/engine/plugin/context-compaction.test.ts:5313`/`:5318`, and `contextLimit: DELEGATE_FLOOR + 520` at `:5637`), and the advertised property **raised that floor** — `+404` tokens on the writer roster, `+441` on the delegating roster. A ceiling hand-set just above the OLD floor therefore fell **below the irreducible size of the request it gates**, and compaction's **X1 dead-run guard** declined the pass outright: `turnBefore` computes `floor = measureRequestFloor(messages, tokens)` — that is `estimatedTokens − measureBody(messages)`, `src/engine/plugins/context-compaction.plugin.ts:1507`/`:1546` — and refuses on `floor >= ceiling` at `:2602`, reporting `stage: 'unreachable-target'` (`:2619-2639`). Hence `'now'` where the compaction instruction was expected, and `Thread "thread-1" never reached "paused" (last: running)`. **There is no ordering or park-timing change in either failure: the park is never attempted**, so nothing about Finding 2's refinement or Finding 5's park is involved. The fix moved `CATALOGUE` to 14,790 (`:779`, its header at `:761-779`) and `DELEGATE_FLOOR` to 16,542 (`:4225`, its header at `:4212-4224`), and that header had already written the symptom in advance: *"If it is NOT moved, the guard is what bites: the pass declines to park at all, the thread stays `running`, and the failure reads 'Thread never reached paused' rather than naming a token figure — which is how this regression presented on 2026-11-26"* (`:4196-4198`) | the two cases, whose line anchors have drifted since this entry first cited them (`:5145`/`:5390` → `:5296`/`:5566`): `src/engine/plugin/context-compaction.test.ts:5296` "refuses the summarize pass below minTokens, and re-arms the moment the floor comes down", and `:5566` "queues a delegate threadSend that lands during the shipped park, and keeps it after the summary"; the guard `src/engine/plugins/context-compaction.plugin.ts:2602`; task 1, now closed |

### 4b. Measured, 2026-11-27 A/B: the per-declaration price of advertising the key

The row above finally names the figure this entry exists to carry. Both legs are the SAME probe run
against two trees — working tree and a worktree of pristine HEAD `e66bce8` (`Temp/coding/head-wt`,
removed once the pass was done; the two leg logs are the retained evidence) — so every delta below is
a measurement, not arithmetic: `Temp/coding/probe-catalogue-ab.ts`, legs
`Temp/coding/probe-ab-head.txt` and `Temp/coding/probe-ab-now.txt`.

**One advertised declaration costs ~147 serialized bytes**, and the split is not uniform:

| Shape | Cost | Why |
|---|---|---|
| A row that ALREADY declares `properties` | **147 B** (146 B on `threadList`) | the `"async":{"type":"boolean","description":…}` entry, 146 B on its own, plus the comma that joins it; one row's description text moves it by a byte |
| A **parameterless** row | **193 B** | `withToolAsyncSwitch` must materialize the schema the row did not have: `{type:'object',properties:{…}}` AND the `"parameters":` key, which `JSON.stringify` used to DROP from the row entirely (`src/engine/core/tool.ts:166`) |

The single sentence that buys it — `TOOL_ASYNC_PARAMETER_DESCRIPTION`, `src/engine/core/tool.ts:133-134` —
is **103 bytes** (103 characters, all ASCII), **105 once serialized** inside its two JSON quotes, i.e.
**72 %** of the 146 B entry. The remaining **41 B** is the `"async"` key (8 B) plus the
`{"type":"boolean","description":…}` envelope (33 B) — none of which is removable. Shortening that
sentence is therefore the only lever on the per-row figure that changes no behaviour: every 4 bytes cut
is one estimated token per request per advertised row.

**That lever was weighed and deliberately NOT taken (decision of the 2026-11-27 correction
pass, recorded so nobody reads it as an oversight).** Shortening `TOOL_ASYNC_PARAMETER_DESCRIPTION`
(103 characters, **105 B once serialized inside its JSON quotes — 72 % of the 146 B entry**, leaving
41 B irreducible) is the only way to move the per-row number without touching behaviour, it is worth
~1 token per advertised row per request (~955 tokens across the 26-row live roster below), and the
pass chose the sentence over the saving: the key is advertised on EVERY tool, so the model has to be
told what omitting it means, and a truncated hint would teach the switch as a boolean rather than as
"omit = this tool's default".

**And the fixture rosters understate a live session by ~8×: the full 26-row preset catalogue
costs +3,821 B ≈ +955 estimated tokens per request** (probe
`Temp/docfinal/probe-full-roster.ts`, both trees, legs `Temp/docfinal/probe-full-roster-head.txt`
and `Temp/docfinal/probe-full-roster-now.txt`; the HEAD leg is the `Temp/docfinal/head-wt`
worktree of `e66bce8`, removed after the pass). A harness with its presets on and
`enableAllTools: true` — what the shipped server seeds for every session it creates — declares
**26** rows (20 core: `toolRequest`, `tasks`, `delegate`, `read`, `write`, `edit`, `glob`, `grep`,
`toolRegistry`, `toolList`, `toolManage`, `toolCreate`, `records`, `profiles`, `chapters`,
`locations`, `knowledge`, `agentManage`, `agentResult`, `threadFork`, `sleep`; 6 searchable:
`syntax`, `files`, `shell`, `gitDiff`, `download` plus the rank-projected `delegate` already
counted), and EVERY one of them carries the key: catalogue `133,015 B → 136,836 B`,
`ceil(bytes/4)` `33,254 → 34,209`. Per declaration the mean is **147.0 B** — 25 rows at **+147 B**,
one at **+146 B** — summing to exactly 25 × 147 + 146 = **3,821 B**. Two refinements of the shape
table above fall out of the same run: the +146 B row is `agentManage`, an **EMPTY-`properties`**
row (it declares `properties: {}`, so the `properties` object and the `parameters` key already
exist and only the entry plus its comma are written), which narrows the **193 B** row above to a
declaration with **no `parameters` key at all** — the budget fixture's `echo`, the only shape of
that kind the package's suites build; and the +146/+147 spread is one byte of description text,
confirming the split the row already states. The per-roster table above is therefore a set of
FIXTURE floors, not a session figure: +487 B on 3 rows and +1,616 B on 11 rows describe the tests
that price them, and a real delegating session pays ~2.4× the writer-roster number and ~7.8× the
inclusion-fixture number.

Per roster, measured on both trees:

| Roster (rows that carry the key) | HEAD bytes | Now | Δ bytes | Δ estimated tokens | Where the new floor is pinned |
|---|---|---|---|---|---|
| 3 — budget (`toolRequest`, `tasks`, parameterless `echo`) | 14,939 | 15,426 | **+487** = 193 + 147 + 147 | **+121** (3,736 → 3,857; the floor itself 3,735 → 3,857) | `src/engine/harness.budget.test.ts:645-658`, `:707` (`toBe(15_426)`), `:724` |
| 3 — inclusion (`toolRequest`, `tasks`, `alpha`) | 14,951 | 15,438 | **+487** | **+122** (3,744 → 3,866) | `src/engine/harness.inclusion.test.ts:3264`, `:3306` |
| 7 — callable root | 35,820 | 36,849 | **+1,029** | **+258** (8,957 → 9,215) | `src/engine/harness.plugin.test.ts:346` |
| 11 — writer | 57,544 | 59,160 | **+1,616** = 10 × 147 + 146 | **+404** (14,386 → 14,790) | `src/engine/plugin/context-compaction.test.ts:761-779` and `:779` |
| 12 — delegating (writer + `delegate`) | 66,268 | 68,031 | **+1,763** = 11 × 147 + 146 | **+441** (16,567 → 17,008) | `src/engine/plugin/context-compaction.test.ts:4212-4225` |
| **26 — the LIVE preset registry** (presets on + `enableAllTools: true`: 20 core + 6 searchable rows, every one advertised) | 133,015 | 136,836 | **+3,821** = 25 × 147 + 146 (mean **147.0 B**/declaration) | **+955** (33,254 → 34,209 catalogue floor; +956 by `ceil` of the byte delta) | pinned nowhere — probe `Temp/docfinal/probe-full-roster.ts`, legs `Temp/docfinal/probe-full-roster-{head,now}.txt` |

The two `bytes` columns are the **catalogue alone** — `toolSchemaPayloadBytes` of the request's own
`tools` (`src/engine/core/context-estimate.ts:451`), the exact measure the estimator uses — while the
`Δ estimated tokens` column is each fixture's own **full-request** figure, catalogue floor PLUS its
transcript, so a row's endpoints are the numbers that file pins rather than `bytes / 4`. The two 3-row
rosters are why the columns must stay separate: the SAME +487 B prints **+121** on the budget fixture
and **+122** on the inclusion fixture, because the two transcripts round differently and neither
catalogue is a multiple of 4 (consequence 3 below).

**Three consequences a host has to be told about:**

1. **On a fixed operator `contextLimit`, compaction and trimming now cross ~404 tokens earlier** on
   the default 11-tool roster (more on a delegating harness: +441). The estimator did not move
   (`src/engine/core/context-estimate.ts` is untouched); the catalogue it prices did.
2. **A ceiling hand-set just above the old catalogue floor flips behaviour in one step** — from "the
   pass runs" to "the dead-run guard refuses the pass entirely" (`:2602` above). It is not a smaller
   compaction, it is no compaction, and the only symptom is the `unreachable-target` diagnostic or a
   thread that never parks. Every constant of the `CATALOGUE + n` / `*_FLOOR + n` shape in the tree is
   in this class, which is why task 6 records the margin fragility rather than the one constant that
   broke.
3. **Catalogues are no longer all multiples of 4 bytes** — the 7-row roster measures **36,849 B**
   (`Temp/coding/probe-ab-now.txt:39`), where the same roster was 35,820 B — so `ceil(bytes / 4)`
   floors now round up where they used to land exactly, and a transcript's rounding shifts by one
   token in some cases (the budget header says the same thing about its own pair: neither catalogue is
   a multiple of 4, `src/engine/harness.budget.test.ts:657-658`).

### 5. Measured: a refined-sync delegation parks the spawner, and `toolCancel` rides the heartbeat

| Fact | Evidence |
|---|---|
| A `sync` call joins the batch gate, so the parent's next turn waits for the child — the intended saving (no placeholder turn, the next request carries the child's REAL result) | `joinSyncBatch` `src/engine/harness.ts:12161`, the group created per message at `:15438`, the park at `:10323` |
| While the parent is parked, its own `toolCancel` is not advertised: the control is declared only while that actor has work in flight | the pending-only declaration block `src/engine/harness.ts:7013-7040` |
| So the parent's own chance to cancel a hung lone delegation is now a **heartbeat** wake, at the shipped **600000 ms** default | `DEFAULT_WAKE_INTERVAL_MS` `src/engine/harness.ts:676`; the plugin's own default `src/engine/plugins/async-ping.plugin.ts:216`, `:242` |
| Probe (implementer's, carried not re-run here): at `wakeIntervalMs: 40`, a refined-sync lone `delegate` produced **2 wakeups and 2 placeholder turns**; the same call with `"async": true` produced **1 self-release turn and 3 wakeups** | probe figure — no test in the tree reproduces it (see "Not tested") |
| Without a heartbeat, release comes from the run's abort, a host cancel, or a steer only — the park is a park, never a block | the gate's release paths, `src/engine/harness.ts:10323` onward; `docs/tasks/2026-11-19-heartbeat-async-only.md` Finding 3 |
| **The trade-off, stated plainly:** a hung lone `delegate` with no `timeoutMs` now parks the parent until the next ping, where the old always-background behaviour let the agent take a turn and cancel whenever the child answered. The default the request asked for buys the common case (one turn instead of two) and costs the rare one (hang-visibility on the default cadence) | this finding, plus `README.md`'s "The trade-off this makes" bullet |
| **The host-visible consequence, measured 2026-11-27:** any host that relied on a single UNSWITCHED `delegate` continuing past its placeholder must now send `"async": true`, or the caller blocks on the child. This is not a diagnostic change — it is a call-shape requirement, and three shipped server contracts proved it by dead-locking. (The same inline shape reached through `threadFork` is the EXPLICIT `"async": false` of Finding 3, never the refinement: an unswitched fork keeps its historical no-group launch, and the refinement never touches a fork.) | the three cases are `src/server/harness.it19-retention.test.ts` **AC1.4** `:619`, **AC2.1** `:677` and **AC3.1** `:727`, all three built on `releasedChild()`: with the switch absent, the parent sat in its batch gate until the child came back, and the child only comes back when the test settles its `hang`, which happens AFTER `writer('go')` returns — so the fixture dead-locked and all three timed out at 15 s without ever reaching a cancelled record. Fixed at the **fixture** by making the background intent explicit (`{ …, async: true }` at `:468`, with the reasoning in the comments at `:311-315` and `:456-467`); **the assertions were not touched** — the transcript, ledger row and cause AC1/AC2/AC3 pin are the same shapes as before |

### 6. Accepted divergence: the heartbeat resolves the mode by NAME, and cannot see the switch

| Fact | Evidence |
|---|---|
| `HarnessPendingTool` is `{ callId, name, elapsedMs }` — no mode, so a name→mode lookup is unavoidable | `src/engine/types/index.ts:365-369` |
| Core announces EVERY launch, sync included, so the plugin is told a call exists but never how it resolved | `announcePending` `src/engine/harness.ts:11756`, payload built at `:11761-11767`, emitted before every `schedule()` |
| The plugin therefore resolves the mode from `api.tools[name].mode`, else the GENERATED `BUILTIN_TOOL_DESCRIPTORS` row, else `'sync'` (and a registry miss over-pings) | `src/engine/plugins/async-ping.plugin.ts:310-319`, the table index at `:211`, the rule at `:11-47` |
| Consequence: any sync-resolved call on an async-DECLARED tool — an `"async": false` switch, or a refined lone delegation — keeps pinging: one placeholder turn per ping | the two rows above. Direction: **over-ping**, the safe one this plugin already argues for |
| Accepted, not fixed. The named fix is a `mode` field on the `async.pending` payload — recorded as task 2 below and as an addendum to the 2026-11-19 heartbeat entry, whose task 2 (`api.toolMode(name)`) is now **insufficient as written** (a name answers the default, not the call) | `docs/tasks/2026-11-19-heartbeat-async-only.md`, the 2026-11-27 addendum |

### 7. Recorded by the final 2026-11-27 review: one consequence and one cost figure the docs did
### not carry (this is the pass that carries them)

An independent review of the shipped change accepted the code and found the documentation short
in three places. Each row below names what was missing, where the truth was already pinned, and
which file now says it. No `.ts` byte moved in this pass; `git diff` on
`src/engine/core/tool-manifest.ts` remains **empty**.

| Gap | The truth | Where it was pinned / what now carries it |
|---|---|---|
| **`src/harness-engine.md:131` contradicted the shipped heartbeat.** The `wakeIntervalMs` row stated that a call resolving to `sync` — "a `tool({ mode: 'sync' })` tool, **or a lone unswitched `delegate` refined to `sync`**" — has no heartbeat behind it. For the refinement that is the opposite of the behaviour: the plugin resolves the mode by **NAME** from the generated table, whose `delegate` row is `async`, so a refined lone `delegate` IS pinged | `src/engine/plugins/async-ping.plugin.ts:310-319` (the name→mode read, table index `:211`); pinned by `src/engine/harness.tool-async-switch.test.ts:1579` ("pings a run parked on a refined lone delegate": one request, `status:'pending'` placeholder, one `wakeup`). Re-measured on this tree by `Temp/docfinal/probe-sequential.ts` (P-B, log `Temp/docfinal/probe-sequential.txt`): at `wakeIntervalMs: 40` with a 250 ms child, a refined lone `delegate` produced **6 wakeups, 7 extra parent requests and 6 `status:'pending'` placeholder tool messages** — 6 of those turns are the heartbeat's, the 7th is the child's own self-release, which is the turn the old always-background shape produced first. The `wakeIntervalMs: 40` pair carried in Finding 5 (2 wakeups / 2 placeholders vs 1 self-release + 3 wakeups) is the implementer's shorter-child reading of the SAME divergence — both agree the refined park is pinged. Now qualified in `src/harness-engine.md` itself, cross-referencing the `async.pending` section of `docs/plugins.md` ("Neither read can see a per-call override") and the "A periodic wake keeps a turn honest" bullet of `README.md`, which already said it correctly |
| **Two `delegate` calls in SEPARATE assistant messages now run strictly sequentially**, and nothing a model author reads said so: `README.md` and `knowledge.md` stated only that the count runs "once per message" (`knowledge.md:1486` before this pass), and `docs/runtime-tools.md` said nothing about the refinement at all | Both messages hold exactly ONE async-resolving call, so **both** refine to `sync` (`src/engine/harness.ts:11960-11966`, counted per message at `:15444`) and the children serialize — measured on this tree by `Temp/docfinal/probe-sequential.ts` (P-A): `child#0 START @358ms → ANSWER @609ms → child#1 START @612ms → ANSWER @863ms`, 3 parent requests, zero placeholder turns, i.e. the second child starts 3 ms after the first answers. Parallel children now need ONE message or an explicit `"async": true`. Added to `README.md` (the `tool()` mode bullet), `knowledge.md` (the refinement paragraph) and `docs/runtime-tools.md` (a new block in the switch section) |
| **The advertised-key cost was understated ~8×** — every published figure is a fixture roster (3/7/11/12 rows), while a live session declares the whole preset catalogue | +3,821 B / **≈ +955 estimated tokens** on the live 26-row registry, mean **147.0 B** per advertised declaration (25 rows +147 B, `agentManage` +146 B), measured on both trees — see Finding 4b. Added to `knowledge.md` (the cost paragraph) and to this entry; the mitigation lever (`TOOL_ASYNC_PARAMETER_DESCRIPTION`, 105 B serialized = 72 % of the 146 B entry, 41 B irreducible, ~4 B ≈ 1 token) is recorded there as **deliberately not taken** |
| **Boundary note a: an un-advertised name contributes 0 to the count.** A `delegate` beside a `threadFork` the request never declared is still lone | `src/engine/harness.ts:2113` — `offered?.get(call.name)` then `continue` (the function is `:2104-2131`); pinned at `src/engine/harness.tool-async-switch.test.ts:963`. Stated in `knowledge.md` and `docs/runtime-tools.md` |
| **Boundary note b: an advertised call that is later REFUSED still counted.** The count is taken once per message before any launch runs its gates, so a doomed sibling (bad arguments, a withheld name) suppresses the refinement and the surviving `delegate` keeps the historical background shape — conservative, never stranding | count at `src/engine/harness.ts:15444`, before the launch loop; the gates live downstream in `launchToolCall` (`:11782`, withheld-name gate `:11898`). Stated in `knowledge.md` and `docs/runtime-tools.md` |
| **Boundary note c: a `delegate` REPLACEMENT registered under the baseline name is an ordinary tool**, so a host can opt a session out of the refinement by re-registering the name — the marker is the definition, not the wire name | `rankProjectedDefinitions.has(definition)`, `src/engine/harness.ts:11964` (the `loneDelegation` expression is `:11960-11966`; the review's `:11963` is the `asyncResolvedCalls === 1` term). Already stated in `knowledge.md`, now also in `docs/runtime-tools.md` |

## Tasks

1. **Re-anchor the estimate pins the injected key moved** — **CLOSED 2026-11-27 by the verification
   pass, from TEST-ONLY edits** (`corrected` on two counts; the original text is kept below so the
   reasoning stays auditable). Final state: `Test Files 273 passed (273)`,
   `Tests 5,151 passed (5,151)`, **0 failed, 0 skipped**, and `git diff` on
   `src/engine/core/tool-manifest.ts` is **empty** — no production file was touched to get there
   (log `Temp/coding/d6-full-suite.txt`, whose summary reads `Test Files 273 passed (273)` /
   `Tests 5151 passed (5151)`; the run it replaced is `Temp/coding/d1-full-suite.log:659-660`). **`corrected` (a):** "21 failures" was a six-file focused-run
   count; the authoritative first full run was **24 failures across 4 files**, the 4th being
   `src/server/harness.it19-retention.test.ts` (3), which that list never ran — see Finding 5's host
   row and Finding 4. **`corrected` (b):** the two "behavioural" `context-compaction` cases were NOT a
   separate investigation, and the gate that bit was NOT `minTokens` — both ceilings are sized
   relative to the catalogue floor, the floor moved (+404 / +441 tokens), and the dead-run guard
   refused the pass (`src/engine/plugins/context-compaction.plugin.ts:2602`). Closed by moving
   constants and nothing else: `CATALOGUE` → 14,790 (`src/engine/plugin/context-compaction.test.ts:779`)
   and `DELEGATE_FLOOR` → 16,542 (`:4225`), each header now deriving its own measured delta from a
   both-trees probe. The "every other suite that reads a catalogue-derived estimate" clause is covered
   by the full-tree run.
   **As first written (kept):** *(in progress — the inclusion fixture is
   done, the rest are not). The catalogue floor is a constant tests state in bytes, and the switch
   raised it by 487 bytes on the inclusion fixture (3,744 → 3,866, +122 tokens). Done:
   `src/engine/harness.inclusion.test.ts` (re-anchored to 3,866 / 3,864, its comment block now
   derives 15,438 = 14,951 + 487, and the file is green). Still open: the same arithmetic in
   `src/engine/harness.budget.test.ts`, `src/engine/harness.plugin.test.ts` and
   `src/engine/plugin/context-compaction.test.ts` (21 failures), and every other suite that reads a
   catalogue-derived estimate, since the key is advertised on every declaration
   (`src/engine/plugin/context-trimmer.test.ts`, `src/engine/plugin/hooks.test.ts`,
   `src/engine/plugin/host.test.ts`, `src/engine/core/agent.test.ts`,
   `src/engine/core/context-estimate.test.ts`). Re-anchor the
   constant-derived pins, and treat the two behavioural `context-compaction` cases named in
   Finding 4 as their own investigation — a passing re-anchor there must explain WHY the
   summarize pass now clears or misses `minTokens`, not just move the number.*
   Closing check, **met**: `yarn vitest run src/engine/harness.inclusion.test.ts
   src/engine/harness.budget.test.ts src/engine/harness.plugin.test.ts
   src/engine/plugin/context-compaction.test.ts` green, with each re-anchored figure derived from a
   measured catalogue byte count, not from the failing output alone — the both-trees probe is
   `Temp/coding/probe-catalogue-ab.ts` (legs `Temp/coding/probe-ab-head.txt`,
   `Temp/coding/probe-ab-now.txt`), whose pristine-HEAD leg reproduces every old byte figure exactly.
2. **Make the heartbeat honest: put `mode` on the `async.pending` payload.** `HarnessPendingTool`
   carries no policy (`src/engine/types/index.ts:365-369`), which is why the plugin resolves by
   name and over-pings a sync-resolved call on an async-declared tool. This supersedes the
   `api.toolMode(name)` shape in the 2026-11-19 entry's task 2 — a NAME answers the tool's default,
   and the switch moved the truth onto the call. Closing check: `async.pending`/`async.drained`
   carry a per-entry mode, `src/engine/plugins/async-ping.plugin.ts:310-319` reads it instead of
   the registry/table chain, and a refined-sync (or `"async": false`) call on `delegate` produces
   NO wake — pinned in `src/engine/plugin/async-ping.test.ts` and
   `src/engine/harness.sync-async.test.ts`.
3. **Decide whether the published catalogue should advertise the key too.** Today the registered
   `parameters` literal (what `GET /v1/harness/tools` shows) does not carry it while the offered
   declaration does (`src/engine/harness.ts:7008`, `:7037`), which is defensible — the catalogue is
   the host's registry view, the declaration is the model's — but it is an asymmetry an operator
   reading only the catalogue cannot see, and the docs now have to say so
   (`docs/runtime-tools.md`). Closing check: either the catalogue row states the switch where a
   consumer reads it (a descriptor field or a documented note on the row), or
   `docs/runtime-tools.md` is amended to record the decision that the catalogue stays key-less on
   purpose, with the reason.
4. **Pin the switch's own contract in the model plane.** CLOSED 2026-11-27 —
   `src/engine/harness.tool-async-switch.test.ts` asserts every behaviour this entry describes, 27
   cases, green on this tree: advertised on the model-facing copy only and absent from the
   validation schema (`:410`), advertised on `toolCancel` while work is in flight (`:463`),
   `true` forcing a sync tool out of the group (`:492`, `:519`), `false` joining an async-declared
   tool's call (`:624`, `:649`), the lone `delegate` resolving sync (`:698`) including beside an
   ordinary sync call (`:760`), fan-out keeping background freedom (`:822`, `:887`, and the
   offered-definitions rule at `:963`), the explicit switch outranking the refinement (`:1036`,
   `:1077`, `:1132`), the closed-schema and single-property hazards (`:1188`, `:1212`), the own-key
   carve-out (`:1226`), the non-boolean refusal asserted as the exact sentence
   (`:1250`, matching `src/engine/core/tool.ts:206-222`), and the three control behaviours
   (`:1296`, `:1331`, `:1361`).
   Closing check, met: `yarn vitest run src/engine/harness.tool-async-switch.test.ts` green
   (re-run in the log cited in Finding 4).
5. **Re-run the heartbeat probe on this tree** and fold the numbers into Finding 5, or replace them
   with a test: the refined-sync vs `"async": true` comparison at `wakeIntervalMs: 40` currently
   survives only as a probe figure. Closing check: the figures in Finding 5 carry a `path:line`
   (a test) instead of a probe citation.
   **Status 2026-11-27 (final review):** the probe WAS re-run on this tree —
   `Temp/docfinal/probe-sequential.ts` (P-B), `wakeIntervalMs: 40` with a 250 ms child:
   **6 wakeups, 7 extra parent requests, 6 `status:'pending'` placeholder tool messages**
   (log `Temp/docfinal/probe-sequential.txt`), recorded in Finding 7. A test still pins none of
   it, so the task stays OPEN; only the source of the figure changed from "carried" to "re-run".
6. **Close the catalogue-relative ceiling fragility the verification pass found and deliberately
   left green** (new, 2026-11-27 — the class consequence 2 of Finding 4b, in the suite nobody
   re-anchored because it never went red). `CHILD_CATALOGUE = 9_029` is a **stale catalogue floor**
   in two delegation suites: `src/engine/harness.compaction-delegation.test.ts:175` and
   `src/engine/harness.delegation-context-relief.test.ts:258`. The child's true catalogue measures
   **37,765 B = 9,442 tokens** today, so the constant sits **413 tokens under** it — and it was
   already **+144 stale at pristine HEAD `e66bce8`**, i.e. pre-existing drift that this switch only
   widened. What still keeps both files green is their ceiling,
   `LIMIT = CHILD_CATALOGUE + 530` = **9,559**: by construction that is 530 tokens of headroom over
   the floor the constant describes (already only 386 at HEAD), and it now clears the child's TRUE
   floor by **117 tokens**. Roughly the next 117 tokens of catalogue growth breaks BOTH files with
   exactly the symptom Finding 4 documents — the dead-run guard refusing the child's summarize pass
   outright (`src/engine/plugins/context-compaction.plugin.ts:2602`), so the failure names no token
   figure at all. Left green on purpose: moving the constant to 9,442 buys the same 530 tokens back
   and leaves the next catalogue wave in the same place, so the fix is the assertion, not the number.
   Closing check: `yarn vitest run src/engine/harness.compaction-delegation.test.ts
   src/engine/harness.delegation-context-relief.test.ts` green, **and** each file states its headroom
   as a figure derived from a **measured** floor — the live-request catalogue read the way
   `src/engine/plugin/context-compaction.test.ts:761-779` reads `CATALOGUE` — so the case asserts the
   **margin**, not the constant. A re-anchor that merely moves `CHILD_CATALOGUE` to 9,442 does NOT
   close this task; a case that fails when the margin drops below a stated floor does.
7. **OPEN (2026-11-27 review) — rewrite the `delegate.timeoutMs` sentence that names a placeholder
   that is no longer there.** `src/engine/tools/runtime/delegate.tool.ts:193` still tells the model
   that "A child that is still running is abandoned with toolCancel using the callId from its
   **pending placeholder**." Under the shipped default that call has NO placeholder turn: the
   refined lone delegation parks the spawner, and `toolCancel` is advertised only while the actor
   has work in flight — i.e. on a heartbeat or steer turn (`src/engine/harness.ts:7013-7040`, and
   correctly stated for the model in `README.md`'s "The trade-off this makes" bullet). Deliberately NOT edited during the
   2026-11-27 passes: the sentence is one of three byte-equal copies — the entry literal →
   `src/engine/core/tool-manifest.ts` (regenerated by `yarn tools:manifest`, byte-pinned by
   `src/engine/core/tool-discovery.test.ts`) → the hand-mirrored Rust row at
   `packages/typecrate/harness/src/tools/catalogue.rs` (the `delegate` entry spans `:245-254`; the
   phrase lives on `parameters_json` at `:252`, and the same phrase is in the `threadFork` entry at
   `:269`) — and `src/engine/core/metadata.ownership.test.ts` pins that whole property object
   across the three copies (`:470-605` asserts the entry against the generated manifest, `:607-648`
   asserts it against the Rust file by source text; the file's own comment at `:617-624` states the
   chain, and `delegate.tool.ts:180-187` states it at the literal). It must also stay
   apostrophe-free and backtick-free, per that comment.
   **Closing check:** the `toolCancel` clause of the `timeoutMs` description no longer contains
   `pending placeholder`, and the three copies moved together — `rg -c "pending placeholder"
   src/engine/tools/runtime/delegate.tool.ts` → `0` for the DELEGATE row, `git diff` on
   `src/engine/core/tool-manifest.ts` shows the regenerated row and nothing else, the Rust
   `delegate` row (`packages/typecrate/harness/src/tools/catalogue.rs:252`) carries the new bytes,
   and `yarn vitest run src/engine/core/metadata.ownership.test.ts
   src/engine/core/tool-discovery.test.ts` is green. No `cargo` here, so the Rust leg is verified
   by text comparison only.
8. **CLOSED 2026-11-27 (markdown only) — the argument fingerprint now records the switch.**
   `call.arguments` KEEPS `async` (Finding 1), and `toolCallFingerprint(name, arguments)`
   (`src/engine/core/argument-fingerprint.ts:171`) hashes that raw text, so the same call recorded
   WITH `"async": true` and WITHOUT it are two different work keys — a `supersedeMatch:
   'fingerprint'` or `dropDuplicateCalls` prune that used to fold the pair no longer does
   (`src/engine/plugins/context-trimmer.plugin.ts:1115`; the setting text "Needs an exact re-run
   with identical arguments" is at `:675`). Assessed as **acceptable and left as behaviour**: the
   error is a *missed* prune, never a wrong one, which is the direction the module already chose
   ("EXACT match only", `src/engine/core/argument-fingerprint.ts:57-61`). What was missing was the
   sentence, now in `knowledge.md`; no test moved.
   Closing check, met: `knowledge.md` states the fingerprint effect with the three anchors above,
   and the code is unchanged (`git diff` on `src/engine/core/argument-fingerprint.ts` and
   `src/engine/plugins/context-trimmer.plugin.ts` is empty apart from the earlier passes' edits).
9. **OPEN, informational — the `joinSyncBatch` → `scheduler.schedule` duplicate-call-id window is
   pre-existing and this change does not widen it.** A `sync` call joins the batch through
   `joinSyncBatch` (`src/engine/harness.ts:12161`), and the board refuses a second task under the
   same id (`src/engine/core/scheduler.ts:170-181`) — a window that exists for any caller that
   launches the same id twice. It is unreachable in the model plane either way, because
   `assertToolCallIds` (`src/engine/harness.ts:10894`, called at `:15262`) ends the run on a reused
   id before any launch. Recorded here so a later reader does not attribute it to the refinement;
   no code change is asked for.
   Closing check: none required — this is a boundary record. If it is ever built on, the check is a
   test that reuses a call id and asserts the run failure comes from `assertToolCallIds`, not from
   the board.

## Not tested

- No live provider, so the +122 figure is the package's own estimate, not a billed delta. What the
  provider adds on top of a tools array (framing, a per-tool overhead) is unmeasured.
- No real wedge: no filesystem, socket or child-run hang was exercised, so the "a hung lone
  delegation parks the parent until the next ping" sentence argues from the park/release contract
  plus the implementer's `wakeIntervalMs: 40` probe, not from an observed stall.
- The worker-lane and browser planes were not exercised: the strip lives in the shared resolver,
  which the server's manual route also passes through (`src/server/api.ts:2937`), but no lane
  round-trip with `"async"` on the wire was run here.
- Whether a real model uses the switch well (does it learn to wait when it wants the answer?) is
  unobserved — no provider transcript was read for this entry, so the prompt-level effect of
  advertising the key is unconfirmed.
- The 37,765 B / 9,442-token child catalogue and the "+144 stale at HEAD" reading behind task 6 are
  **probe figures carried from the verification pass** (`Temp/coding/`, disposable scratch), not
  values any test pins: nothing in the tree measures that child catalogue today, which is exactly what
  task 6 asks for. The 117-token margin is arithmetic on those readings.
- The **sequential-children** consequence of Finding 7 (two `delegate` calls in separate messages
  running `child#0 START → ANSWER → child#1 START → ANSWER`) is a probe timeline, not a pinned
  behaviour: `src/engine/harness.tool-async-switch.test.ts` pins the count's inputs (the
  offered-definitions rule at `:963`, fan-out in one message at `:822`/`:887`) but has no case that
  puts one delegate in each of two messages. That test, not the prose, is what should close the gap.
- The +3,821 B / ≈+955-token full-roster figure (Finding 4b) is a **probe figure** too —
  `Temp/docfinal/probe-full-roster.ts` against both trees — and its HEAD leg came from a
  `Temp/docfinal/head-wt` worktree of `e66bce8` that has since been removed. No test in the tree
  prices the 26-row live catalogue, so the figure is re-derivable only by re-running that probe.
