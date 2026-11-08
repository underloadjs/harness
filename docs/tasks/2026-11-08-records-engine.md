# `records` — one session store engine, with `task`/`chapter`/`profile`/`location` as wrappers

Status: **closed except the generated Rust twin — T1-T8 LANDED and the suite GREEN (round 9,
2026-11-09: 175 files / 3 004 passed / 2 skipped, `npm run typecheck` clean, both manifest
checks current, `npm run test:frontend` 138 files / 1 813 passed; the tree has grown since
that measurement with the plugin-pipeline stage's own landings — 178 files / 3 130 passed
recorded there — and nothing in this entry's scope has moved green-to-red since). T9 is
partial: the Rust twin `packages/typecrate/harness/src/tools/catalogue.rs` still carries
the **pre-engine** catalogue (`task`, `profileManage`, …) — it is GENERATED, its generator
lives in disposable `Temp/` scratch which was found EMPTY, so it was left alone rather than
hand-edited, and the host's typecrate service regenerates it from the current
`src/core/tool-manifest.ts` when next run; see the "Rust twin — documented, not touched"
note under round 9.**
Sixteen decisions (A-P) are made below. Q1-Q5 were answered by the architect (rounds 5-6) and are recorded as Decisions
I-O; **Q6 was answered in round 7 and is recorded as Decision P — no product question remains
open.**

**Round 7 changed the design, not just an answer.** The architect ruled *"locks and claims is
unneccessary, as all patches will be accepted unless it patches stale data"* — so claims are
**deleted from the engine**, not demoted to advisory — and added **R9**: a rejected stale patch
must **return the current entry**, not just a reason. That ruling supersedes parts of R1, R3,
F2, F11, F16, and Decisions H, L, N and O. Each is marked **`corrected`/`superseded` in place**
per `docs/tasks/README.md`; the original text is kept so the reasoning stays auditable.
**Decision P is the authority wherever this document contradicts itself.**

Written from a static source audit across five review rounds with the architect, then shaped by
ruling rounds 6 and 7 (Q4-Q6); **no live session was run and no test was executed**, so every
behavioural claim is inferred from source and marked in *Not tested*. **Round 7 is a design
change, not another audit pass** — the source references still describe `44cdbbe` as it was,
while the requirements and decisions describe what the engine must become.

---

## ⚠️ Read this first — the references in this document are already stale

**Other agents are editing this package concurrently.** Every `path:line` below was read
from a working tree that is moving under the reader. This is measured, not hypothetical:

| file | size when this doc was written | size at the last re-check, same session |
|---|---|---|
| `src/harness.ts` | 513,096 B | **521,777 B** (+8.7 KB) |

`src/harness.ts` changed size **twice** during the audit that produced this document
(513,096 → 513,212 → 521,777). Line numbers in a file that grows ~9 KB in an hour are
worthless after one other agent lands a change.

**The rule for whoever implements this:**

1. **Anchor on identifiers, not line numbers.** Every finding names the function, constant
   or comment string it rests on — `invokeRegisteredTool`, `callToolInternal`,
   `executeRecordTool`, `RECORD_SPACE`, `adoptStoreCounter`, `mergeConcurrentFields`,
   `readTaskRevisions`, `AUTHORITY_RUNTIME_METHODS`, `SHARED_STATE_TOOL_NAMES`,
   `is neither routed to the authority nor declared local`. Grep for those. They are the
   durable contract; the numbers are convenience.
2. **A wrong line number is not a wrong finding.** If the reference resolves but the
   behaviour described is still there, **fix the reference and proceed** — the task is
   valid. Do not stop, and do not report the finding as invalid.
3. **A missing anchor means the behaviour moved.** If the identifier is gone, renamed, or
   the quoted comment no longer exists, that is a signal the *behaviour* changed — probably
   because another agent landed part of this work. Then, per `docs/tasks/README.md`:
   mark the finding **`corrected` in place** (keep the original text, append what you
   found and which commit/agent changed it), and re-scope from the surviving findings.
   Do not delete the finding.
4. **Run the drift check at the end of this document before writing any code.** It is a
   copy-paste command set that re-establishes every anchor in one pass, and it names the
   baseline test run that must be green *before* any edit.
5. **Expect to renumber tasks.** T1-T10 are ordered by dependency, not by file. If
   another agent lands T1 or T3 first, mark it done here and continue from the next
   unresolved one — the ordering notes in each task say what depends on what.

The **requirements** (R1-R7) and the **decisions** are the durable part of this document.
The line numbers are not.

---

## Date / Method / Scope

**Date:** 2026-11-08 (audit); round 7 ruling recorded 2026-11-09.

**Method:** static audit over five review rounds, plus rounds 6-7 which settled Q4-Q6 and
removed claims (round 7's deletion surface was re-grepped across `src/` and is recorded in F2,
F11, F16 and Decision P). Tools used: `grep` (content search over
`packages/`), `glob`, `read` (bounded windows), `shell` (`diff` of name-normalized copies
of the three store modules, `wc`, `git ls-files` / `check-ignore` / `status`). No test was
run; no session was driven. Written against `44cdbbe` ("Upgraded Task Logic") of the
**`@underload/harness` package repository** — its own git repo at
`packages/underload/harness/.git`, *not* the workspace root — working tree dirty
(`git status` shows ~20 modified files under `src/`, plus these docs).

**Scope:** `src/core/{task,profile,chapter,location}.ts`, their `src/tools/runtime/*.tool.ts`
source entries, the harness store closures and `runtime.executeRecordTool` in
`src/harness.ts`, the snapshot record block (`src/core/snapshot.ts`, `src/types/index.ts`),
the worker routing surface (`src/server/workers/{capability,lane-authority,lane-worker-loop,lane-identity}.ts`),
and `src/core/creation.ts` / `src/tools/runtime/toolCreate.tool.ts`.

**Out of scope:** the `/task` slash-command feature set (a pass-through; it keeps working —
F7); the Rust twin `packages/typecrate/harness/src/tools/catalogue.rs` (generated —
regenerate, never edit, T9); the frontend preset buttons (`src/frontend/main.ts`, keyed by
tool name); and every pre-existing snapshot on disk (nothing is in production, so no
migration is required — R5).

---

## Requirement

Stated by the architect across seven rounds, reduced to the claims that bind. **These are
the contract; the code must fit them, not the reverse.**

- **R1.** A `records` tool exists and holds the **full current `task` capability** —
  revisions, change feed, atomic batch validation — expressed in a generic
  record format. *(Round 7 struck "locks/claims" from this list — Decision P. Everything else
  in R1 still binds, so "full current capability" still means every non-claim verb: batch,
  `expects`, `since`, `afterId`, `mergeDisjoint`.)*
- **R2.** `tasks`, `chapters`, `locations`, `profiles` are **wrappers around `records`**.
  They exist so an agent does not have to spend context on `records`; they are not the
  store. `tasks[]` is literally a batch reference to record entries.
- **R3.** All entries live in **one store** and carry the **same corruption/race controls**
  `task` has today — revisions, atomic whole-call validation — so no collection can
  corrupt another or race with it. *(Round 7 struck "locks": the race control is the CAS
  token, not a lease. Decision P.)*
- **R9.** *(new, round 7)* A rejected **stale** patch returns the **current entry**, not merely
  a reason. The architect: *"all patches will be accepted unless it patches stale data, which
  will notify the patcher the reason why for them to look up (in fact, it is better to simply
  return the current result in invalid patches to save them from looking up)."* So a conflict
  costs **one** round trip, not two — the caller learns the expected rev, the current rev, the
  last editor and time, which fields changed, **and the values they changed to**, in the same
  result. This is load-bearing now that claims are gone: CAS is the only conflict mechanism,
  so the conflict response must be complete.
- **R4.** `records` is **searchable, not core**. It is the powerful, low-level surface for
  complicated requests a wrapper cannot express. The agent composes its own request; the
  tool is "more complicated to use", and `records` answers a bad request with an error.
- **R5.** The engine's contract wins. `task`/`chapter`/`profile`/`location` are **rebuilt to
  obey it**. Nothing is in production, so no back-compat constraint applies to any of them.
- **R6.** Restriction is **tool-based and progressive**: `records` imposes no field-level
  restriction; a wrapper may add its own; an agent that finds a wrapper too restrictive
  escalates to `records`. The system does not forbid this — it is the intended escape hatch.
- **R7.** A `toolCreate`-authored tool must be **purely standalone** — it may not be a proxy
  for another tool. An agent creating a tool that just wraps another tool makes no sense.
  This is **not currently enforced** (F8), so it is recorded here as a rule to uplift.
- **R8.** The 64 KiB result caps are **not a hard constraint** — they exist to stop a
  non-deterministic agent flooding its own context window, and may be tuned freely.

---

## Findings

### F1. The three record stores are one template instantiated three times

`src/core/profile.ts` (595 lines), `chapter.ts` (628), `location.ts` (497) — 1,720 lines,
byte sizes 23,805 / 25,041 / 19,661.

Name-normalized (`profile`↔`location`, then `chapter`) and diffed:

| pair | diff lines (+/−) | real difference |
|---|---|---|
| profile vs location | 184 of ~1,092 | **only** the `traits` array (`readTraits`, `*_MAX_TRAITS`/`*_MAX_TRAIT`, traits in copy / paginate / snapshot-restore / patch). Strip traits → identical. |
| chapter vs location | 303, of which **133 blank/comment-only** | ~170 lines: `status` enum + per-status `counts`, `order` sort, the summary/body split (`content` only from `get`), `readSnapshotInteger`. |

~400 lines per file are shared boilerplate: `ACTIONS`, `readOffset`, `readLimit`,
`paginate` (64 KiB budget), `requireId`/`requireItem`/`requireText`/`optionalText`,
`read*StoreState`, `reset`/`snapshot`/`restore`. The sources say it themselves: *"Same
lifecycle as task (./todo.ts)"*, *"Identical for all three record tools"*, *"R9 … identical
policy in profile/chapter/location"*, *"./todo — the template this factory follows"*.

The three `src/tools/runtime/*.tool.ts` entries are also near-identical: the same `action`
enum `['add','list','get','update','remove']` — the **only** three tools in that directory
with it — the same `visibility: 'searchable'`, and `registration` blocks differing only in
`order: 70/80/90`.

**Why it matters:** this is the duplication `records` removes. It is also the evidence that
a single engine can express all three with a field spec, which is what T3 builds.

### F2. `task` is the same engine **plus** a concurrency protocol — and it is batch, not CRUD

`src/core/task.ts` is **72,870 bytes** vs profile 23,805 / chapter 25,041 / location
19,661. The ~400 shared lines are CRUD + bounds; the rest is:

- `rev` per record, bumped only when content actually changes (`task.ts:48-50`);
- `expects: [{ id, rev }]` compare-and-swap — `task.ts:54-56`: *"a call that HAS an agent
  identity must pass `expects: [{ id, rev }]` for every record it patches or removes. A
  mismatch rejects the WHOLE call atomically"*; the message is
  `` `guarded write: pass expects [{ id, rev }] for task "<id>" (read it first).` ``
  (`guardedWriteMessage`);
- `claim`/`release`/`takeover`/renew with `leaseMs` — `TASK_DEFAULT_LEASE_MS = 15 * 60_000`,
  `TASK_MIN_LEASE_MS = 60_000`, `TASK_MAX_LEASE_MS = 24h`; **[corrected, round 7]** accurate
  about today's code, and **deleted rather than ported** — Decision P. Verified deletion
  surface (grepped round 7): the three blocking loops behind `isHolder`/`isExpired`/
  `claimMessage` in `src/core/task.ts` (112 matching lines) and its test file (112);
  `takeover` in **13 files**; four params at `src/tools/runtime/task.tool.ts:84-107`;
  `TaskChangeOp` (`'claim' | 'release'`) at `src/types/index.ts:1258`; the
  `leaseUntil needs "owner"` restore check at `task.ts:1546`; the `/task claim|release|takeover`
  subcommands in `src/core/command-builtins.ts`; and **four** `taskStore.releaseThread(…)`
  sites in `src/harness.ts` (4460, 4522, 9398, 10057).
- attribution `updatedBy`/`updatedThreadId`/`updatedAt`, read from the ToolContext and
  **never** from arguments (`task.ts:50-52`: *"so the model cannot forge who edited what"*);
- `storeRev` + a bounded FIFO change log (`TASK_MAX_CHANGES = 200`,
  `TASK_MAX_CHANGES_IN_RESULT = 50`) + `since:`;
- `afterId` keyset cursor (`readAfterId`).

**`task` is not single-entry CRUD.** One call carries `tasks[]` (adds *and* patches mixed),
`remove[]`, `claim[]`, `release[]`, `takeover[]`, `expects[]`, validated as one unit with a
fixed apply order *(of those five batch fields, four survive round 7: `tasks[]`, `remove[]`,
`expects[]` — the three claim verbs are deleted, Decision P)* (`knowledge.md:753`): *"claims → releases → takeovers → expired-claim
clears → patches → removals → additions"*, and `readPatch`'s own comment:

**[corrected, round 7]** the first four of those seven steps do not survive Decision P — the
order the engine implements is **patches → removals → additions**. The atomicity and the
read-before-mutate discipline (`readPatch`'s comment) are unaffected and still bind. *"Steps 1-5 only
read the store, so a rejection anywhere in them leaves items, nextId, storeRev and the
change log exactly as they were."*

**Resolved by R1/R3:** `records` implements **batch** CRUD with whole-call validation and
that apply order preserved; `tasks[]` is a batch reference to entries in it. This is the
correct resolution and it simplifies F3.

### F3. One store means one id space — which removes three closed-set constraints

`src/server/workers/lane-authority.ts` maps four stores to four identity spaces:

```ts
const RECORD_SPACE: Record<RecordToolName, IdSpace> = {
    task: 'record:todos', profileManage: 'record:profiles',
    chapterManage: 'record:chapters', locationManage: 'record:locations' };
```

`RecordToolName` is `typeof RECORD_TOOL_NAMES[number]` (an `as const` tuple) and
`ID_SPACES` (`src/server/workers/lane-identity.ts`) is a fixed list; `seedsOf` iterates it
with `space.slice(7) as RecordStoreName`, and `adoptStoreCounter` folds the canonical
`nextId` back into the ledger after every routed write — its comment explains why: *"The
core minted the id inside ITS store, so the ledger must adopt that counter: without this a
later lane lease could hand out an id the authority already used, which is exactly the
invalid-snapshot failure T3 finding F1 reported."*

Under R3 (one store, one `nextId`) this collapses to **one** `record:*` space and the
`seedFromCounter` unit conversion stays valid. It also removes today's ambiguity —
`src/harness.ts`, at the store closures: *"Separate closets and separate id sequences, so a
profile id and a chapter id may both be `1` without ambiguity."*

**Consequence, accepted deliberately:** ids become **globally unique across collections**,
so the first task may be `"7"`, not `"1"`. `afterId` still works (it is "ids greater than X",
filtered to the collection). Every `taskItem('1', …)` pin in
`src/server/persistence.test.ts`, `src/server/sessions.test.ts` and
`src/server/commands.test.ts` changes — which R5 permits.

### F4. The discovery gate is on the model path only — R4 needs no new seam

`src/harness.ts` `invokeRegisteredTool` and `callToolInternal` **never consult**
`currentEnabledSet()`. The gate exists in exactly one place, the model's launch path:

```ts
// Core tools and pending-only runtime controls are always authorized.
if (definition.visibility !== 'core' && !pendingOnlyDefinitions.has(definition)
    && !currentEnabledSet().has(call.name)) {
    await fail(`Tool "${call.name}" is registered but not enabled yet. Call ${TOOL_REQUEST} with tags like ${tags} to enable it.`);
```

and the `activeTools` declaration states the intent: *"Searchable tools stay in the registry
but are not declared — and not callable — until they land here."* — callable **by the
model**. `disableToolFor` adds: *"The registration stays: discovery gates the MODEL, so a
disabled tool is still callable by a host and costs no budget to re-enable."*

**So a core wrapper reaching a searchable `records` works today, with no new seam.** The
wrapper is always available; the model's direct access to `records` is gated. R4 is already
the implemented behaviour. **Confirmed — no change needed.** This is exactly the architect's
ruling: *"A tool calling another tool is not like an agent, where it has to discover the
tool first… all tools are enabled internally."* Correct, and already true.

Record stores are also genuinely callable: `runtimeControlDefinitions` blocks only
`toolCancel`/`threadFork`/`actionRequest` (*"requires the harness run that owns the
conversation"*).

### F5. **BLOCKING (resolved by Decision A)** — `callTool` is routed to *neither* lane guard; `harness.runtime.*` is

The architect's answer to this finding addressed *discovery* (F4 — correct, and see the
note there). This is about **routing**, which is orthogonal and was not answered.

`src/server/workers/lane-worker-loop.ts` states the rule:

> *"a record-store write, a registry change, a discovery grant, an agent-result read and a
> cross-thread send become requests the AUTHORITY performs on the canonical harness; a slash
> command or a direct tool call executed here reaches the authority through the same door
> (src/harness.ts ~2690 / ~2804 / ~3370 call `runtime.*`, **not** `handle.runtime.*`)"*

Today the shipped sources obey this exactly — `src/tools/runtime/profileManage.tool.ts`
ends with `context.harness.runtime.executeRecordTool('profileManage', context)`, and
`src/server/workers/capability.ts` declares the route:

```ts
export const AUTHORITY_RUNTIME_METHODS = {
    executeRecordTool: 'task | profileManage | chapterManage | locationManage', …
```
> *"Interception happens on the REPLICA's handle, so no tool source changes and no shared
> write is ever performed locally."*

**Two guards exist, and `context.callTool` slips between both:**

1. **The classification guard** — `lane-worker-loop.ts` throws
   `` `harness.runtime.${key} is neither routed to the authority nor declared local, so this build cannot guarantee that shared state has one writer.` ``
   but it iterates `Object.keys(runtime)` **only**. `callTool` is a handle/context member
   (`src/types/index.ts`, `ToolContext.callTool` and `Harness.callTool`), never a runtime
   method → **invisible to this loop**.
2. **The capability scan** — `capability.ts` does know about `callTool`, but flags exactly
   two names:
   ```ts
   label: 'context.callTool("delegate" | "threadFork")',
   blocking: false,
   patterns: [/\bcallTool\s*\(\s*['"`](?:delegate|threadFork)['"`]/]
   ```
   `callTool('records')` matches nothing → **no refusal, no warning**.

`toolHandleView` passes `callTool` through untouched — its own comment lists *"`runtime.*`
(the routed cross-thread and shared-state operations), `memory`, `tools`, `commands`,
`agent`, `executeTool`, `callTool`"* as what the toolbox uses and what passes straight
through.

**Therefore: a wrapper built on `context.callTool('records', …)` runs `records`' body on the
lane replica against a private copy of the session, and nothing in the build detects it.**
That is the failure `capability.ts` names next to `SHARED_STATE_TOOL_NAMES`:

> *"a core tool that mutates shared state but is missing here would run its body on the lane
> against a private copy of the session — **a lost write, silently**."*

And `lane-authority.ts` states the invariant being broken: *"a lane never writes a record, a
registry entry, a discovery grant, an agent-result read, or a cross-thread message against
its private copy of the session."*

### F6. **BLOCKING (resolved by Decision B)** — `storeRev` and the change log are per-store; one store makes them cross-collection

Every recorded event appends one `TaskChange` to a **FIFO log capped at 200** and advances
the monotonic `storeRev`. `TaskChange` is
`{ rev, id, op, by, threadId, at, fields, itemRev }` (`src/types/index.ts`) — **no
`collection` field**.

With one store holding tasks + chapters + locations + profiles:

1. **Eviction interference.** 200 events was sized for one list. A chapter-writing burst
   evicts the task events a `mergeDisjoint` caller needs. `mergeConcurrentFields` requires
   **no gap** from `expected+1` to the record's current rev and returns `undefined` (refuse
   the merge) on any hole. Its own comment: the log *"is what makes `since` cheap and a
   disjoint merge provable, so it must outlive a normal working burst without holding memory
   hostage"*.
2. **`since:` wakes on other collections.** The promise *"poll `since: storeRev` next time
   and get only what it missed"* becomes "every chapter edit too", and the 50-event result
   cap fills with irrelevant events.
3. **`storeRev` semantics fork.** Global `storeRev` → noisy feeds. Per-collection `storeRev`
   → the gap-coverage proof, the FIFO, and `readTaskStoreState`'s strictly-ascending
   validation (`knowledge.md:826`) all become per-collection.

R5 removes the *compatibility* constraint but does not choose the mechanism. **Decision B**
resolves it.

### F7. The wrapper pattern is already proven one layer up, and `/task` survives untouched

`src/core/command-builtins.ts` is a pure pass-through layer over tools:

> *"PASS-THROUGH MEANS THE LIVE TOOL — Each pass-through calls
> `context.harness.executeTool(name, parameters)`, so the command mutates THIS harness's task
> list and uses THIS harness's configured web credentials, exactly like a model tool call or
> the UI's Tools tab would. It also inherits the tool's own bounds (the 200/4000/20-per-page
> task caps, the fetch content-type gate) instead of duplicating them here."*

`/task`, `/websearch`, `/webfetch` all do it, and `hasTool` degrades gracefully when a name
is unregistered. **`/task` keeps working unchanged as long as the wrapper keeps a registered
name.** Two hazards it inherits:

- **The CAS dance.** `command-builtins.ts`: *"WHY A READ FIRST: `harness.executeTool` always
  hands the tool an agent identity (`agent: primary`), and `core/task.ts` requires an
  `expects: [{ id, rev }]` token for EVERY record an identified caller patches or removes. A
  blind command would die on `guarded write: pass expects [...]`"*. `readTaskRevisions`
  pages the whole list to harvest revs — `for (const task of tasks) revisions.set(task.id,
  task.rev);` — and costs *"one extra read (and its `tool_execute` notification) per"* write,
  still leaving a TOCTOU window. **If `records` returns the page on every success (F9), this
  dance disappears** — a strong argument for that envelope.
- **`executeTool` launders identity; `callTool` does not.** The manual path hardcodes
  `{ agent: primary, runDepth: 1 }`, while the model path passes the real `agent: brain`,
  `signal`, `runDepth: run.depth` and `threadId` into the nested context. A wrapper must
  preserve attribution — which is another reason to route via `runtime` (Decision A), where the
  authority resolves the caller from the name the lane reported (`callerFor`) rather than
  defaulting to primary.

**Depth is free:** the nested call passes `run.depth` (the same run, not a nested
conversation), so `MAX_RUN_DEPTH = 2` and the delegate guard never fire on a wrapper hop.

### F8. `toolCreate` bodies are unrestricted — R7 is a rule to add, not one to keep

Verified: **nothing today prevents a created tool from proxying another tool.**

- `src/core/creation.ts` compiles with `new AsyncFunction('args', 'context', source)` — the
  body receives the **full `ToolContext`**, which includes `callTool` and `harness`.
- The trust model is explicit: *"Compilation uses the host realm's Function constructor… A
  created tool therefore has the full permissions of the process: filesystem, network, child
  processes… this package has no sandbox and no isolation, and nothing here should ever be
  described as sandboxing. What this module DOES guarantee: a bounded name/description/tag/
  source shape, a compile error (HarnessError) when the body does not parse, no execution at
  registration."* Caps are shape-only (`DEFAULT_CREATED_TOOLS_LIMIT = 32`).
- The **only** name gate is collision/reservation: `options.reserved` is *"the registry's own
  name list (toolRequest/toolCreate/delegate…)"* and a hit throws
  `` `Tool name "<name>" is reserved by the harness.` `` — that is a *naming* rule, not a
  *behaviour* rule. A created tool may still call the tool it shadows.
- The **only** thing discouraging a proxy is prose: `toolCreate.tool.ts`'s description
  describes `context` as *"(agent, agents, run)"* — it does **not mention `callTool` or
  `harness` at all**. A convention, not a gate.

So R7 must be **uplifted from convention to stated contract** (T4). The architect's
reasoning stands on its own terms and is recorded as D8: a created tool is a deterministic
function of its arguments (`sum(A,B)` is always the same; `Math.random()` is deterministic
*in effect* — randomness is its declared outcome), unlike an agent whose every run differs.
**That is why R7 exists, but it is not an exemption from F5's routing rule** — a created
tool's body may be deterministic and still execute against the wrong copy of the session.

### F9. Two result contracts exist; the engine must pick one

`task.ts` — *"Result contract (**ONE shape for every success**, mutations included):
`task()` → `{ tasks, counts, page, storeRev }`; `task({ tasks: [...] })` → the same, add/
patch **then read**"*.

`profile.ts` / `location.ts` / `chapter.ts` — *"list → `{ profiles, counts, page }`; add | get
| update → `{ profile, counts }`; remove → `{ removed, counts }`"* and *"mutation results
return only the changed record and the counts, **never the whole store**."*

R5 says rebuild the wrappers to obey `records`; R1 says `records` inherits `task`'s
semantics. So the engine envelope is **task's** (Decision D). Two source-backed reasons:

1. `rev` must be in the response or `expects` is unusable — F7 proves the alternative is an
   extra full-list read per guarded write.
2. `mergeDisjoint`'s safety proof reads `change.fields`, which requires a **canonical field
   order per collection** (`TASK_CONTENT_FIELDS` — *"the ONE order every `fields` array and
   every stale-error hint uses. Stable ordering is what…"*). A generic engine has no fixed
   field list unless the collection declares one.

Per-collection facets and projection must also be **declared, not inferred**:
`ChapterCounts = { total, planned, draft, complete }` vs `TaskCounts = { total, completed,
pending }`, and `knowledge.md:770` — *"Counts are always derived from the whole store, never
from the page."* Chapter's summary/body split (*lists and mutations carry summaries; only
`get` returns `content`*) is a **response** rule a generic engine cannot invent.

### F10. `records` access is **transient** — `maxEnabledTools` can evict it between turns

`currentEnabledNames()` is `activeSearchableNames().slice(0, maxEnabledTools)`, and
`enableTools` reports `evicted: previous.filter(name => !result.has(name) &&
!retainedSet.has(name))` — with the note that *"an over-cap legacy snapshot is trimmed from
the FRONT (the newest retained entries)"*.

`records` is searchable (R4), so a later `toolRequest` **can evict it** and the model's
direct access vanishes mid-session while the wrappers keep working (F4). The recovery is
already right — the gate's failure message names the tags to re-enable with — but the model
must not read eviction as "the capability is gone". This is a **description-text**
requirement (T5), not a defect.

### F11. **SUPERSEDED by Decision P (round 7)** — the thread-lifecycle claim sweep is wired to the task store — at **four** call sites

Claims become a general entry capability under R3, but the sweep is single-store:
`taskStore.releaseThread(…)` is called from **four** places in `src/harness.ts` (re-counted
at the last re-check; this document originally cited two, which is itself an example of the
drift warned about at the top):

| site | context |
|---|---|
| `harness.ts:4460` | thread stop — comment: *"reserved, so its task claims are dropped HERE — the one place every stop"* |
| `harness.ts:4522` | thread delete / cascade |
| `harness.ts:9398` | `restore()` — `if (!threadStates.has(threadId)) taskStore.releaseThread(threadId)` |
| `harness.ts:10057` | agent default conversation dropped from the roster |

`task.ts` documents why the hook exists: *"`releaseThread` (T1) is the lifecycle hook: when a
thread stops or is deleted its claims must not keep blocking the rest of the session"*, and
the lease can run to `TASK_MAX_LEASE_MS` = **24 hours**.

**If `chapters`/`locations`/`profiles` entries can be claimed, a claim on them outlives its
thread at all four sites** and blocks the session for up to 24 h. ~~T6~~ *(the sweep task is
**T5**; T6 is the description text — pre-existing typo, noted rather than silently fixed).*

**Corrected in place (round 7):** the premise is gone. Decision P deletes claims, so there is
no lock to sweep and **the 24-hour deadlock this finding exists to prevent cannot occur**. The
finding is kept because the four call sites are real and must now be **removed, not extended**.
Only the `releaseThread` call inside each site goes — the surrounding work (thread stop,
delete/cascade, `restore()`, roster drop) is unrelated and stays. T5 is rewritten to the
deletion.

### F12. Two `tool_execute` notifications per logical write

`invokeRegisteredTool`'s `finally` fires `notifyStateChange('tool_execute', { tool: name,
… })` — and the wrapper's own execution fires one for the wrapper. So one logical
`tasks.add` emits **two** state changes (`records` + `tasks`). `command-builtins.ts` already
acknowledges this cost for the read-first dance.

The persistence contract says `reason` is *"a coarse hint for coalescing/debouncing a save"*
and that `snapshot()` is safe to call **during** an active run (T16), so this is very likely
harmless — but it must be **verified, not assumed** (T7), because a session store that writes
twice per tool call doubles snapshot churn.

### F13. R6 is coherent for fields; the engine still needs **store-level** bounds

R6 (field caps are tool-based; escalate to `records` for freedom) is **accepted** — it is
progressive disclosure, and it matches the existing stance that a tool's own schema is the
field gate (`resolveToolParameters` validates against the tool's schema before `execute`).

One residual R6 does not cover: **`records` has no wrapper to supply store bounds.** Today
every store states its own `*_MAX_RECORDS = 200` and `*_RESPONSE_BUDGET_BYTES = 64 * 1024`.
With no wrapper, an agent-created collection grows unbounded and a `list` can be arbitrarily
large. So: **field-level caps = tool-based (R6, accepted); store-level bounds = engine-owned
(mandatory, or `records` is an unbounded store).** T8.

Related, and independent of the 64 KiB number (R8 says it is tunable): the invariant that
matters is **inner budget ≤ outer budget**. `callTool`/`runtime` results are exempt from the
model-facing cap (*"it is NOT subject to the model-facing 64 KiB text budget"*), but the
**wrapper's** result is bounded (`src/core/result-budget.ts`). If `records` budgets its page
at the same size as the outer envelope, an inner page can report `hasMore: false` while the
outer envelope truncates — the model concludes it saw everything when it did not. Also
preserve `paginate`'s *"the first record of a non-empty page is always included, so
`nextOffset` always advances (no stall, no gaps)"* rule when generalizing it.

### F14. **NEW** — the four stores do not share a visibility today, and that is a test-pinned asymmetry

Re-checked while writing this document:

| tool | `visibility` |
|---|---|
| `src/tools/runtime/task.tool.ts` | **`core`** |
| `src/tools/runtime/profileManage.tool.ts` | `searchable` |
| `src/tools/runtime/chapterManage.tool.ts` | `searchable` |
| `src/tools/runtime/locationManage.tool.ts` | `searchable` |

`task` is always in context; the other three wait for `toolRequest`. `src/harness.records.test.ts`
pins this shape directly:

```ts
// R9-R11: the record tools are registered and searchable, not declared, so the
// first request only offers the bootstrap plus the session plan.
const CORE_ORDER = [
    'toolRequest',
    'task'
];
```

**Why it matters for this design:** R4 fixes `records` as searchable, but R2/R5 do not say
whether the **wrappers** are core or searchable. Making all four wrappers `core` would put
four store tools in every request (context cost); making all four `searchable` would strip
`task` out of the bootstrap and break `CORE_ORDER` plus every declaration-order test. This
is a product decision about context budget, not an implementation detail — see **Q2**.

### F17. **NEW (round 6)** — errors carry **no machine-readable code**, so a wrapper cannot translate them reliably

Q5 makes error handling a requirement (*"records have its proper error, and the error must be
handled by the wrapper… the error by records must be accurate and precise"*). The current
error surface cannot support that cleanly.

`src/util/errors.ts` defines the whole contract:

```ts
export class HarnessError extends Error {
    constructor(message: string, options?: { cause?: unknown }) { … }
}

export const toErrorInfo = (error: unknown): { message: string } => { … };
```

- `HarnessError` adds **only `cause`** to `Error`. There is no `code`, no `field`, no
  `details`.
- `toErrorInfo` returns **`{ message: string }`** — one field. Its own comment is explicit
  that this is a **wire value**: *"Events are consumed by CLIs and (later) RPC clients, so
  they carry data, not exceptions"*, and `UNKNOWN_ERROR_MESSAGE = 'Unknown harness error'` is
  *"Kept stable because it is a wire value on an error event."*
- Every store rejection is therefore **prose only**. The engine's distinct failures are
  indistinguishable except by reading the sentence:

| failure | message today |
|---|---|
| missing CAS token | `` `guarded write: pass expects [{ id, rev }] for task "<id>" (read it first).` `` |
| stale token | `` `task "<id>" changed since revision <n> (now <m>, last edited by "<x>"); re-read and retry[; changed fields: …].` `` |
| ~~live foreign claim~~ | ~~`` `task "<id>" is claimed by "<owner>" until <ISO>; release it or take it over first.` ``~~ **(deleted, round 7 — Decision P; this row's condition can no longer occur)** |
| field too long | `` `tasks "<field>" is <n> characters; the limit is <max>. Shorten it and retry.` `` |
| unknown collection | *(new — Decision C)* |
| store full | `` `… already holds the maximum of <n> …; remove one before adding another.` `` |

**Why this blocks Q5.** A wrapper that must "handle" an engine error has two options, and
only one of them exists today: **string-match the message** — which breaks the moment another
agent rewords a sentence, and `harness.ts` renders it as
`` `Tool "<name>" failed: <message>` ``, so the wrapper sees the engine's prose with a prefix
bolted on. There is no code to switch on.

**The precedent to follow already exists.** `src/core/nested-runs.ts` solves exactly this for
one limitation, and its comment states why:

> *"The stable machine name of the limitation. It is the capability code in the lane
> handshake, the error `name` of every refusal, and the first token of every refusal message,
> so the model, the HTTP surface, the worker report and the operator all quote ONE
> identifiable name."* … *"`name` is set too, so a host that catches it can classify without
> parsing prose."*

That is a one-off (`error.name = NESTED_RUN_LIMITATION_CODE`), not a general mechanism.
**Decision O** generalizes it. Note the same file's warning that a thrown value may be
hostile — `isInstanceOf` exists because *"a thrown Proxy with a throwing `getPrototypeOf` trap
can make `instanceof` throw"* — so any classification helper must stay total.

### F16. **NEW (round 5); claim half superseded (round 7)** — agents *can* be removed, and removal deliberately releases their claims

Raised because the Q3 answer assumed otherwise (*"agents within a session cannot be deleted
(I think)"*). They can:

| fact | where |
|---|---|
| `removeAgent(name)` exists and is exported on the `Harness` interface | `src/harness.ts` (`addAgent` / `removeAgent`, both on the returned handle) |
| Driven by the HTTP surface | `DELETE /sessions/{id}/agents` (comment at `src/harness.ts:9122`) |
| Only the **primary** is undeletable | throws `` `Agent "<name>" is the primary agent and cannot be removed; change the harness definition instead.` `` — so **subagents are removable** |
| Removal requires an idle roster | `assertRosterIdle('change the agent roster')` — proves no **run** is live, not that no claim exists |
| Removal **releases the agent's claims** | at the roster-drop site: `taskStore.releaseThread(defaultThreadIdOf(key))` |

The comment at that call site is the important one:

> *"T1 (Phase 2) ownership: `agent:<name>` is the only conversation this agent can still hold
> a task claim on (a host thread of the same agent is refused above), and `assertRosterIdle`
> only proves no RUN is live — **a claim from a finished turn outlives it. Nothing else can
> lift that claim once the record is gone, so release it with the transcript.**"*

**Why this does not contradict the architect's principle — it confirms it, for the right
field.** Attribution is already permanent and is never re-validated against the roster:
`updatedBy?: string` (`src/types/index.ts`) and `readTaskStoreState` checks it only as a
non-empty string (`min: 1`), so a snapshot naming a departed agent restores and reports
`last edited by "<name>"` unchanged. The claim sweep is about the **lock** (`owner` /
`leaseUntil`), which is a different field with a different lifetime. Decision L separates
them explicitly; T5 must not blur them.

**Consequence if they *were* blurred:** dropping claims on agent removal would erase history
(the memo), and keeping claims alive would deadlock the collection for up to
`TASK_MAX_LEASE_MS` = 24 h with no living holder able to release it.

**Corrected in place (round 7):** the *deadlock* half is moot — Decision P deletes the lock, so
a removed agent can strand nothing. The **attribution** half is untouched and still binds:
`updatedBy` survives removal, is never roster-validated, and a stale-token message must still
name a departed agent as the last editor — now with R9's current entry beside it. `removeAgent`
itself is unchanged. This finding's surviving value is the attribution invariant, which
Decision L keeps.

### F15. **NEW** — `records` and its wrappers must not collide on names

`creation.ts`'s reserved-name rule (*"`options.reserved` is the registry's own name list
(toolRequest/toolCreate/delegate…)"*, throwing `` `Tool name "<name>" is reserved by the
harness.` ``) is the mechanism that keeps `records` and the wrapper names safe from a model
creating a shadowing tool. Confirm `records` joins that same reserved set when it is added,
or an agent can `toolCreate` a tool called `records` and replace the engine. Cross-reference
T4 (R7 also forbids a created tool from *behaving* as a proxy — the name rule alone does not
cover that).

---

## Decisions recorded — the architect's rulings

Per `docs/tasks/README.md`, a claim overturned by the requester is **recorded, not
deleted**, so the reasoning stays auditable.

| # | my earlier claim | architect's ruling | status |
|---|---|---|---|
| D1 | `task` is batch, `records` CRUD — incompatible | `tasks[]` **is** a batch reference to entries in `records`; entries carry revs/locks | **resolved**, adopted as R1/R3 — *the "revs" half stands; "locks" was struck in round 7 (Decision P)* |
| D2 | chapter/profile must keep their contracts | they are **uplifted** to `records` logic; nothing in production | **resolved**, adopted as R5 |
| D3 | id spaces are a closed set | same as D2 | **resolved**, see F3 |
| D4 | response body is load-bearing | entries have a defined structure **plus** other data; wrappers return their own shape | **accepted**; the engine envelope still must carry `rev`/`storeRev` (F9) |
| D5 | 64 KiB caps constrain a wrapper | caps are tunable; the number exists to stop an agent flooding its own context | **accepted** as R8; the real invariant is inner ≤ outer (F13) |
| D6 | tools calling tools must be routed | discovery restriction is **agent-facing only**; tools calling tools is internal and always enabled | **correct for discovery** (F4, confirmed in code), **does not answer routing** (F5 → D9) |
| D7 | engine-side caps needed per collection | restriction is **tool-based**; `records` is deliberately freer; the agent escalates | **corrected** for field caps; store-level bounds still required (F13) |
| D8 | `toolCreate` bodies are non-deterministic | created tools are deterministic functions of their args; agents use tools **to avoid** hallucination | **accepted**; this is the rationale for R7, not an exemption from F5 |
| D9 | (open — routing mechanism unanswered) | *resolved by this document* | **Decision A** below |
| D10 | (open — change-log scope unanswered) | *resolved by this document* | **Decision B** below |
| D11 | (open — declared vs agent-created collections) | *resolved by this document* | **Decision C** below |

---

## Decisions made by this document

The architect asked that every open question be resolved to whatever best delivers R1-R8.
These are the calls, each with the requirement it serves and the evidence that decided it.
**If one of these turns out to be wrong, the finding it rests on is marked `corrected` and
the alternative is stated — it is not hidden.**

### Decision A — wrappers route through `harness.runtime.*`, not `context.callTool` *(closes F5)*

**Chosen:** a new routed runtime method, e.g. `harness.runtime.executeRecords(name, context)`,
replacing today's `executeRecordTool`. Wrappers call that.

**Why:** it is the only option that is *mechanically enforced*. `lane-worker-loop.ts`'s
classification loop throws for any runtime key that is neither routed nor declared local —
so forgetting to route `executeRecords` fails at worker startup instead of losing writes
silently. `capability.test.ts` already cross-checks `AUTHORITY_RUNTIME_METHODS` against
`SHARED_STATE_TOOL_NAMES` and the shipped tool sources, so an omission fails a test. And it
is the pattern every shipped record source already follows (F5).

**Rejected:** `context.callTool('records', …)` — invisible to both lane guards (F5), so the
failure is silent. **Rejected:** declaring `callTool` local — contradicts `lane-authority.ts`
(*"a lane never writes a record… against its private copy of the session"*). **Rejected:**
making `callTool` itself routed — it changes semantics for every tool in the registry, which
is a much larger blast radius than this requirement needs.

**Delivers:** R3 (no corruption, no race, one writer of record).

### Decision B — per-collection change log and per-collection `storeRev` *(closes F6)*

**Chosen:** each collection owns its own `storeRev` + FIFO change window (engine default
`MAX_CHANGES = 200`, `MAX_CHANGES_IN_RESULT = 50`).

**Why:** `mergeConcurrentFields`' correctness proof requires a **gap-free** window from
`expected+1` to the record's current revision. A single global log shared by four
collections makes that gap a routine outcome of unrelated writes — which would silently
degrade `mergeDisjoint` from "provably safe" to "usually refused". R3 explicitly asks for
the same anti-corruption guarantees `task` has today; a shared log weakens exactly that.
It also keeps `since:` relevant (F6 symptom 2) for free.

**Rejected:** one global log with `collection` added to `TaskChange` and `since` filtered —
that fixes the *noise* but not the *eviction*, which is the symptom that actually breaks the
merge proof.

**Delivers:** R1 (full task capability), R3 (same controls, no cross-collection corruption).

### Decision C — collections are **declared by code, extensible by `define`** *(closes the open question)*

**Chosen:** the four built-in collections (`tasks`, `chapters`, `locations`, `profiles`) are
declared in code with their engine-owned specs (field order, caps, facets, projection,
sort). `records` additionally exposes `define`, so an agent can register a **new**
collection at runtime.

**Why both:** a schema `enum` would reject a typo before `execute` — the guarantee today's
`action` enum gives — but an enum cannot grow at runtime, which forecloses the flexibility
the whole redesign exists to provide. So `collection` is a `string` in the schema,
**validated engine-side against the registered set before dispatch**, and an unknown name
**throws** naming the defined collections. That keeps the one property that matters (a typo
is an error, never a plausible-looking empty list) and gives up only the schema-level check.

**The failure mode this is guarding against:** `src/core/discovery.ts` matches **tool name
and tags, never the description**, with an exact-4/prefix-3/contains-2 ladder — and that
fuzziness applies to **names only**, never to parameter values. So `collection: 'tsak'` gets
no rescue anywhere in the system. Rejecting it loudly is the only defence.

**Delivers:** R4 ("far greater control", "the agent forms its own request"), R6 (escalation
path), and the flexibility premise from the first round.

### Decision D — the engine envelope is `task`'s shape *(closes F9)*

**Chosen:** every successful `records` call returns the same envelope:
`{ entries | entry | removed, counts, page, storeRev, changes?, changesHasMore?,
changesTruncated? }`, where each entry carries `id, rev, updatedBy?, updatedThreadId?,
updatedAt?` + the collection's declared fields. *(Round 7: `owner?` and `leaseUntil?` are
struck from the entry shape — Decision P.)*

**R9 (round 7) extends this envelope to the failure path.** A `stale-record` rejection is not
just a sentence: it carries the **current entry** in the same shape a successful `get` would
return, plus `{ expectedRev, currentRev, updatedBy, updatedAt, changedFields }`. So the
envelope rule becomes *one shape for every outcome* — success returns the page, conflict returns
the record that beat you. A wrapper must pass that payload through, not flatten it to prose
(Decision O), and it must respect the same inner ≤ outer budget rule (F13) — a current entry
with a long chapter `content` can itself overflow the rejection.

**Why:** F7 — if `rev` is not in the response, every guarded write costs an extra full-list
read to harvest tokens, which is precisely the dance `command-builtins.ts` documents and
pays for today. Uniform-on-success is also the shape `task` already ships and tests.

**Delivers:** R1, R5 (wrappers rebuild to this), and it *removes* work from T4 of the
`/task` command (the read-first dance becomes unnecessary).

### Decision E — `records` is the escalation surface; wrappers are the ergonomic one *(closes R2/R4/R6 as a design principle)*

**Chosen:** wrappers are **thin**: they declare their own schema (including their own
field-level caps, per R6), map their collection name, and reshape the response into their
domain shape. They hold **no state and no logic of their own**. Anything a wrapper's schema
refuses, `records` accepts — that is the documented escalation path, not a workaround.

**Why:** this is what makes R6 coherent rather than a loophole. If wrappers held logic,
escalating to `records` would bypass behaviour, not just strictness. Keeping them stateless
means both doors operate on one store with one set of guarantees (R3).

### Decision F — R7 is enforced **softly** *(closes F8)*

**Chosen:** state the rule in `toolCreate`'s description, and add a **non-blocking**
capability-scan pattern for `callTool(` / `harness.executeTool(` in a created source —
reported, not refused, exactly like the existing
`context.callTool("delegate" | "threadFork")` entry (`blocking: false`).

**Why:** `creation.ts` explicitly disclaims sandboxing and lists its guarantees as
shape + compile + no-execution-at-registration. A hard *semantic* ban would be the first
semantic restriction in a module that says "there is no sandbox", and a source-text scan
gives false positives on comments and strings — `capability.ts`'s own regex approach is
deliberately narrow for that reason. Soft enforcement matches the module's stated trust
model while making the rule visible to the model at the moment it writes the body.

**Rejected:** rejecting at compile time. Cheaper to reason about, but it contradicts F8's
quoted trust model and would need a real parser, not a regex.

**Also (F15):** add `records` to the reserved-name set so a created tool cannot shadow the
engine by name.

### Decision G — store-level bounds are engine-owned; field-level caps are tool-owned *(closes F13)*

**Chosen:** `records` enforces an engine default of 200 entries per collection and a page
budget strictly **smaller** than the outer model-facing budget; a wrapper may add field-level
`maxLength`/`maxItems`/`enum` on top.

**Why:** R6 is about *restriction*, and it is right. But an unbounded store is not a
restriction — it is an unbounded context risk, which is the thing R8 says the caps exist to
prevent. The distinction (store bounds vs field caps) satisfies both.

### Decision H — **SUPERSEDED by Decision P (round 7)** — the claim sweep extends to every collection *(had closed F11)*

**Chosen:** `releaseThread` becomes an engine operation and all four `harness.ts` call sites
(4460, 4522, 9398, 10057) call the engine, not `taskStore`.

**Why:** R3 says entries in every collection carry the same locks. A lock that survives the
death of its holder is not the same lock — it is a 24-hour deadlock.

**Overturned (round 7):** R3's "locks" was struck, so there is no lock and nothing to sweep.
**`releaseThread` is deleted, not generalized.** The reasoning above was sound given R3's old
wording — the change was in R3, not here. T5 is rewritten to the deletion.

### Decision I — visibility: `tasks` is core, `records` and the other three wrappers are searchable *(closes Q2)*

**Answered by the architect:** the `tasks` wrapper is **`core`**; `records` and
`chapters`/`profiles`/`locations` are **`searchable`**. This preserves today's split (F14:
`task.tool.ts` is `core`, the other three are `searchable`) and therefore keeps
`CORE_ORDER = ['toolRequest', 'task']` in `src/harness.records.test.ts` valid — with `task`
renamed to `tasks` (Decision J).

**Why this is the right shape, not just the incumbent one:** the session plan's task list is
the one store an agent needs before it has discovered anything, so it stays in the bootstrap;
the story-collections and the low-level engine are opt-in and cost context only when used.

**Consequence for `records` (Decision K):** because `records` is searchable, an agent that
hits a wrapper cap does **not** automatically have the engine in context. Escalation
therefore requires a `toolRequest` round trip, and `records` can be evicted between turns
(F10). Both are intended per R4 — but they make the error text load-bearing, which is why
T6 and **Q5** exist.

### Decision J — the tool is `tasks`; the command stays `/task` *(closes Q1)*

**Answered by the architect:** the tool is named **`tasks`** (plural — it manages a
collection), while the slash command stays **`/task`** (singular — *"I'm adding a task, not a
bunch of tasks"*). The verb is singular because the operation is; the noun is plural because
the store is.

**The rename surface** (all of it, so an implementer does not "helpfully" rename the command
too):

| surface | name | action |
|---|---|---|
| tool wire name | `task` → **`tasks`** | rename |
| `src/tools/runtime/task.tool.ts` → | **`tasks.tool.ts`** | rename file + `TASK_NAME`/`TASK_METADATA` |
| HTTP path | `POST /v1/harness/sessions/:id/tools/task/executions` → `…/tools/tasks/executions` | follows the name |
| frontend presets | keyed by tool name (`src/frontend/main.ts`) | re-key |
| reserved-name list | `task` → `tasks` | update |
| `CORE_ORDER` in `src/harness.records.test.ts` | `'task'` → `'tasks'` | update |
| `scripts/check-package-tools.mjs` | entry list + name→path map | update |
| **slash command** | **`/task` — unchanged** | **do not rename** |
| `command-builtins.ts` | `const TASK_TOOL_NAME = 'task'` → `'tasks'` | **one constant**; `hasTool(context, TASK_TOOL_NAME)` and the message *"the \"task\" tool is not registered in this harness"* follow it |

The last row is the trap: the command resolves its tool through that single constant, so the
tool rename is one line there — but the **command name** is a separate literal and must stay
`/task`. A test that asserts `/tasks` works would be wrong.

### Decision K — collection names are plural and match their tool *(replaces the open question)*

With the tool renamed `tasks`, there are three naming surfaces for one thing: the tool
(`tasks`), the command (`/task`), and the engine's collection key. **Chosen: the collection
key is plural and identical to the wrapper's tool name** — `tasks`, `chapters`, `profiles`,
`locations`. One canonical spelling everywhere the model touches it; `/task` stays the only
singular surface, because a command names an act, not a store.

`define`d collections take the agent's chosen name verbatim (plural recommended, not
enforced — there is no principled way to singularize arbitrary nouns).

### Decision L — attribution is permanent; the *lock* is liftable *(closes Q3)*

**Answered by the architect:** records are durable session data written to disk and
rediscovered on restart; a `rev` written by an agent stays valid even if that agent is no
longer accessible — *"if Person A writes a memo and he dies, the memo was still written by
Person A."*

That principle is **already implemented for attribution**, and the code agrees with it:
`updatedBy` is `string | undefined` (`src/types/index.ts`) and `readTaskStoreState` validates
it only as a non-empty string (`min: 1`) — **never against the agent roster**. A restored
snapshot naming a departed agent restores cleanly and reports
`` `(now <rev>, last edited by "<name>"); re-read and retry…` `` unchanged. **Keep this
behaviour; do not add roster validation.**

**But one premise in the answer is wrong, and it matters.** *"Agents within a session cannot
be deleted (I think)"* — they can:

- `harness.removeAgent(name)` exists (`src/harness.ts`, exported on the `Harness` interface
  as `removeAgent`), driven by `DELETE /sessions/{id}/agents`;
- only the **primary** is undeletable — it throws
  `` `Agent "<name>" is the primary agent and cannot be removed; change the harness definition instead.` ``
  so subagents **are** removable;
- and removing one **deliberately releases its claims**: at the roster-drop site the code
  calls `taskStore.releaseThread(defaultThreadIdOf(key))` with the comment —

  > *"`agent:<name>` is the only conversation this agent can still hold a task claim on… a
  > claim from a finished turn outlives it. **Nothing else can lift that claim once the record
  > is gone**, so release it with the transcript."*

**Resolution — these are two different fields, and they must behave differently:**

| field | meaning | on agent removal / thread deletion |
|---|---|---|
| `updatedBy`, `updatedThreadId`, `updatedAt` | **attribution** — who wrote this rev | **immutable fact.** Survives removal and restart. Never re-validated. (The memo.) |
| ~~`owner`, `leaseUntil`~~ | ~~**a lock** — who may write next~~ | **deleted (round 7).** Decision P removes the lock, so there is nothing to lift. (The pen is gone; the memo stays.) |

The architect's principle governs the first row and the existing code already honours it —
**that row is Decision L's surviving content and it binds unchanged.** The second row was
written while the lock existed; round 7 deleted the lock, so the 24-hour-deadlock argument no
longer applies and **T5 is a deletion, not an extension**. What T5 must now protect is the
attribution invariant alone: `updatedBy` / `updatedThreadId` / `updatedAt` survive thread stop,
delete, roster-drop and restore untouched, and a stale-token message still names a departed
agent as the last editor.

### Decision M — collections are permanent once non-empty; definitions persist *(derived from Q3)*

The Q3 answer's other half — *"these shouldn't mutate existing history of records"* — settles
the removal question that Q3 was originally asked about: **dropping a non-empty collection
would itself mutate history, so it is not allowed.**

- `define`d collections may be dropped **only when empty** (no entries to lose).
- Collection **definitions persist in the snapshot alongside their entries**, so a collection
  an agent defined mid-session is rediscovered after restart — which the architect's *"written
  into drive, so it discovered next restart"* requires. Consequence for T2: engine-side
  `collection` validation must validate against **restored** definitions, not only the
  built-in four, and a restored definition must itself be validated (unknown field, bad cap,
  empty field list → reject the restore, matching the stores' existing
  "validate everything before mutating" stance).
- A `define` of a name that already exists is an **error**, not a silent merge — otherwise an
  agent could re-`define` `tasks` with different caps and quietly change a live collection's
  contract mid-session.

### Decision N — authorship is not ownership *(closes Q4; the lease half superseded by Decision P, round 7)*

**Answered by the architect:** *"is a record owned by another agent cannot be updated by a
different agent? That isn't how the requirement should be… Records exists in a session and can
be access and modify by any thread within that session. That means, there is no owner, and a
record entry can be updated by 2 agent simultaneously (hence revision history). It is up to
the agent to ensure that what they are working on correct to the latest revised task."*

That is a **pure CAS statement**, and it settles Q4: `updatedBy` confers no write right. Any
thread in the session may patch any record, and the `expects: [{ id, rev }]` token is the only
gate — which is what `task.ts` does today, so **no change is needed for the common case**.
The previous agent's code is not wrong here; my Q4 framing was.

**But "there is no owner" collides with one thing, and it must be read narrowly.**
`task.ts` already refuses a non-holder's write while a claim is live:

```ts
for (const id of [...patches.map((entry) => entry.id as string), ...removals]) {
    const item = store.find(id) as TaskItem;
    if (item.owner === undefined || isHolder(item, store.by, store.threadId)) continue;
    if (!isExpired(item, store.now)) throw claimMessage(item);
```

Read literally, *"there is no owner"* would delete that guard — and with it R1's *"full
current tasks capability"*, since claims/leases/`takeover` are the feature. So the two
requirements are reconciled as follows, which is the only reading consistent with both:

| | rule |
|---|---|
| **Ownership is not intrinsic** | a record has no owner by default. Authorship (`updatedBy`) is attribution only and grants nothing. |
| ~~**Ownership is opt-in and temporary**~~ | **deleted (round 7).** No lease exists at all. |
| **Unclaimed = anyone** | any thread may patch, gated only by the CAS token — "2 agents simultaneously" is exactly this. |
| ~~**Claimed = holder only, until expiry**~~ | **deleted (round 7).** Nothing blocks a write; every patch is accepted unless it is stale. |

**Net effect as written in round 6:** no behaviour change to claims — the answer rejected
*ownership by authorship*, not *ownership by lease*.

**Overturned in part (round 7):** the hedge below came true, and went further than the
advisory middle ground it imagined. The architect ruled *"locks and claims is unneccessary"*,
so the last two table rows are **deleted outright**. The first two rows (ownership is not
intrinsic; authorship grants nothing) **stand and are the whole of Q4**. Decision P is the
authority; this reconciliation is kept because it records why the block looked mandatory for
two rounds and exactly what changed.

### Decision O — the engine gives every rejection a stable code; the wrapper translates, never swallows *(closes Q5)*

**Answered by the architect:** *"records have its proper error, and the error must be handled
by the wrapper. Agents uses records instead of wrapper should receive records' error, so the
error by records must be accurate and precise."*

Three obligations follow, and F17 shows the third is not implementable today:

1. **`records` owns its error quality.** Every engine rejection must be precise and
   self-sufficient — name the collection, the id, the field, the limit, and the fix. The
   existing stores already write to that standard (`"… is <n> characters; the limit is <max>.
   Shorten it and retry."`); the engine must not regress it into generic text.
2. **A wrapper handles the error; it does not hide it.** A wrapper may re-word an engine
   rejection into its own vocabulary, but it must not swallow one or reduce it to "failed".
   An agent that called `tasks` and got a cap error must learn the same fact the engine knew.
3. **Translation needs a code, not prose** (F17). **Chosen:** give `HarnessError` a stable
   machine name, following the `nested-runs.ts` precedent — set `error.name` (or a new `code`
   field) to a constant per rejection class, e.g. `stale-record`, `guarded-write`,
   `field-too-long`, `unknown-collection`, `store-full`, `record-cap`.
   A wrapper switches on the code; the message stays the human/model-facing half. Keep any
   classifier **total** — `isInstanceOf` exists precisely because a thrown value may have
   hostile traps, and `toErrorInfo` must never throw.
   *(Round 7: `claimed-record` is struck from the set — Decision P deletes the only condition
   that raised it. `stale-record` and `guarded-write` become the **only** write-conflict codes,
   which is why R9 matters: with one code left for conflicts, that code's payload has to carry
   the whole story.)*

**Rejected:** string-matching the message in wrappers. It works until a sentence is reworded,
and `harness.ts` prefixes it with `` `Tool "<name>" failed: ` `` anyway, so the wrapper would
be pattern-matching a rendered wire value.

**Consequence for Q5's earlier default:** the wrapper naming `records` as the escalation path
(still recommended, still the default) is now an **addition** to a faithful translation, not a
substitute for one — the wrapper must convey *what the engine said* **and** *where to go
instead*.

### Decision P — no locks, no claims: CAS is the only conflict control, and a stale rejection returns the current entry *(closes Q6; supersedes parts of R1, R3, F2, F11, F16, Decisions H, L, N, O)*

**Answered by the architect (round 7):** *"This is evolving design, and what I tell you last is
the correct information. locks and claims is unneccessary, as all patches will be accepted
unless it patches stale data, which will notify the patcher the reason why for them to look up
(in fact, it is better to simply return the current result in invalid patches to save them from
looking up)."*

**Chosen — three rules, and nothing else:**

| | rule |
|---|---|
| **Every patch is accepted** | any thread may patch any record at any time. No verb, no field, and no state can refuse a write on the grounds that somebody else is working on it. |
| **A stale patch is refused** | `expects: [{ id, rev }]` mismatch → `stale-record`, whole call rejected atomically (unchanged from today). |
| **The refusal carries the current entry** | R9. Expected rev, current rev, last editor, last time, changed fields, **and the current values** — in the rejection, so no follow-up read is needed. |

**Why this is coherent, and why the block was worth two rounds of argument.** The claim existed
to protect **work that spans turns**: read a record, spend 40 tool calls on a refactor, patch —
under pure CAS a concurrent edit lands mid-flight and the whole effort is discarded at the last
step. The architect's ruling accepts that cost deliberately, and it is the right trade for
three reasons this document already established:

1. **A claim never closed the race it was named for.** It is taken *after* the read, so two
   threads that both read and both write still both write. It only ever refused a write that
   came *later* — i.e. it traded a guaranteed cheap retry for a possible expensive one.
2. **It was the only mechanism in the design that could deadlock.** `TASK_MAX_LEASE_MS` = 24 h,
   and F11/F16 exist purely to clean up after a holder dies. Delete the lock and both the
   deadlock class and its entire lifecycle machinery disappear — F11, F16's lock half,
   Decision H, T5, and `releaseThread`'s four call sites all fall out at once.
3. **The `indefinite` claim was a latent bug.** `task.ts:547-551`: a claim with no `leaseUntil`
   is INDEFINITE and **never auto-expires**, rendered as "forever" in `command-builtins.ts:188`.
   Under a blocking model that is a permanent lock from a hand-edited or externally restored
   store. Under Decision P it is nothing at all.

**Corroboration from the worker layer — the design already agreed with this ruling.**
`src/server/workers/lane-commit.ts:339`: *"A record/memory/tool/discovery op is **NOT
lease-guarded: it is CAS-guarded**."* The lane boundary has never protected a record write with
a lease; only transcripts and agents are writer-leased. So deleting record claims removes no
protection anyone was relying on across the worker boundary.

**Do not over-delete — three unrelated things share the word.** These must **survive**
unchanged; they are not record claims:

| survives | what it is | where |
|---|---|---|
| `WriterLeaseLedger` | one writer per shared **conversation** (thread/agent), not per record | `src/server/workers/lane-commit.ts:294-330` |
| `IdentityLease` | a **range of ids** leased from an id space | `src/server/workers/lane-identity.ts`, `lane-authority.ts:124` `'lease'` op |
| `ownerThreadId` on a **thread** | which conversation spawned a thread | `lane-authority.ts:256,277`, `lane-commit.ts:83,187` |

Only `owner` / `ownerThreadId` / `leaseUntil` **on a record entry** go away.

**Ripple, stated so it is not discovered mid-edit:**

- **T2** loses four verbs (`claim`/`release`/`takeover`/renew), three entry fields, and four of
  the seven steps in the fixed apply order — it becomes *patches → removals → additions*.
- **T5** inverts: from "extend the sweep to every collection" to "delete the sweep and its four
  call sites". Its attribution half survives unchanged (Decision L).
- **T6b**'s code set loses `claimed-record`; `stale-record`'s payload grows (R9).
- **T8** loses the claim suite and gains the R9 envelope tests.
- **`/task`** loses three subcommands (`claim`/`release`/`takeover`) and the `(claimed by X
  until Y)` suffix at `command-builtins.ts:196`. The command name itself is unaffected
  (Decision J).
- **`TaskChangeOp`** (`types/index.ts:1258`) loses `'claim' | 'release'`, shrinking the change
  feed to `add | update | remove`. Decision B's per-collection log is unaffected — it just
  records fewer op kinds.
- **Snapshot restore** loses the `leaseUntil needs "owner"` cross-check (`task.ts:1546`) and the
  `readSnapshotNumber` path that fed it.
- **R1/R3** are amended above rather than rewritten, so "full current `task` capability" no
  longer silently includes claims.

**Rejected:** keeping claims as an **advisory signal** (the middle ground Q6 offered) — it
preserves three fields, two change-log ops, two subcommands and a snapshot validator to carry a
hint that nothing enforces and that `rev` already conveys better. The architect's wording is
*"unnecessary"*, not "advisory", and Q6's own text said a demotion should delete rather than
keep-as-no-op. If a real need for "who is working on this" appears later, it should be a
**derived read** (recent `updatedBy` in the change feed), not a lock.

**Delivers:** R3 (one control, not two that can disagree), R8-adjacent simplicity, and — via
R9 — a conflict path that costs one turn instead of two.

*Check:* `grep -rn "claim\|takeover\|leaseUntil" src/core/task.ts src/tools/runtime/task.tool.ts`
returns nothing; `/task claim 1` is an unknown subcommand; a stale patch's rejection body
contains the current record's fields, not just a sentence.

---

## Questions for the architect

Only questions the code cannot answer — i.e. about **what the product should do**, not how.
Everything else is decided above.

### Answered (round 5) — recorded so the decisions above stay traceable

**Q1 → `tasks` for the tool, `/task` for the command.** *"tool should be called 'tasks',
whereas command is /task (basically, i'm adding a task, not a bunch of tasks)."* →
**Decision J**, plus **Decision K** (collection keys plural, matching the tool name) which
the answer forced.

**Q2 → `tasks` core; `records` and the other three wrappers searchable.** → **Decision I**.
Keeps `CORE_ORDER` valid and preserves the reason `task` is core today.

**Q3 → records are durable session data; a `rev` outlives its author.** *"if Person A write a
memo, and he dies, the memo was still written by Person A regardless… if a rev written by an
agent and that agent is no longer accessible, the rev still valid."* → **Decision L**
(attribution immutable, lock liftable) and **Decision M** (collections permanent once
non-empty; definitions persist in the snapshot).

**One premise in Q3 was corrected by the code:** *"agents within a session cannot be deleted
(I think)"* — they can. `harness.removeAgent(name)` exists, is driven by
`DELETE /sessions/{id}/agents`, refuses only the **primary**, and **deliberately releases the
removed agent's claims**. See **F16**; the answer's principle still holds, but only for
attribution, not for locks.

### Answered (round 6)

**Q4 → authorship grants nothing; any thread may write; the CAS token is the only gate.**
*"Records exists in a session and can be access and modify by any thread within that session.
That means, there is no owner, and a record entry can be updated by 2 agent simultaneously
(hence revision history). It is up to the agent to ensure that what they are working on
correct to the latest revised task."* → **Decision N**. Today's `task.ts` already behaves this
way for unclaimed records, so **no change is needed for the common case** — my Q4 framing was
the error, not the previous agent's code.

**One caveat recorded in Decision N (round 6), resolved in round 7:** it warned that read
literally, *"there is no owner"* would delete the guard blocking a non-holder's write during a
live claim — and with it R1's *"full current tasks capability"*. **That is exactly what
happened.** The architect confirmed the literal reading in round 7 (*"locks and claims is
unneccessary"*), so the guard goes and R1 was amended rather than the guard kept. See
**Decision P**. The reconciliation Decision N offered (ownership as an opt-in lease) is
superseded; its first two rows — authorship grants nothing, unclaimed means anyone — are the
parts that were always correct and now stand alone.

**Q5 → the engine's errors must be precise, and the wrapper must handle them.** *"records have
its proper error, and the error must be handled by the wrapper. Agents uses records instead of
wrapper should receive records' error, so the error by records must be accurate and
precise."* → **Decision O**, and it exposed **F17**: today an error carries **only a message**
(`HarnessError` adds just `cause`; `toErrorInfo` returns `{ message: string }`), so a wrapper
cannot translate one reliably — it would have to string-match prose that `harness.ts` renders
as `` `Tool "<name>" failed: <message>` ``. The fix follows a precedent already in the repo
(`nested-runs.ts`: a stable code as `error.name` and the first token of the message, *"so a
host that catches it can classify without parsing prose"*).

### Answered (round 7)

**Q6 → neither: claims are deleted.** *"locks and claims is unneccessary, as all patches will
be accepted unless it patches stale data, which will notify the patcher the reason why for them
to look up (in fact, it is better to simply return the current result in invalid patches to save
them from looking up)."* → **Decision P**, plus the new **R9**. This is stronger than either
option Q6 offered: not "block" and not "advisory", but **no lock at all**. It supersedes
Decision H, T5's sweep, the `claimed-record` code, and the last two rows of Decision N's table.

**The method note the architect restated — "what I tell you last is the correct information" —
is recorded as binding for this file.** Where an earlier round's answer and a later one
conflict, the later one wins and the earlier is marked `corrected` in place, not deleted. That
is why this document now carries a superseded Decision H and a struck table row rather than a
silently rewritten one.

### Still open

**None.** Every question the code could not answer has been answered (Q1-Q6, rounds 5-7).
What remains is **verification, not decision** — the claims in *Not tested* below, and the
drift check. T7 settles the load-bearing one (F5, the lost-write claim) and T7 now also has to
settle R9, which has never been run either.

---

## Tasks

Order matters: **T1-T3 are the change**, T4-T6 are correctness edges that must not be
forgotten, T7-T8 are verification and text, T9 is housekeeping the repo rules require.
**Re-read the staleness warning at the top before trusting any line number here.**

### T1 — Route the wrappers to the engine (Decision A)

- Add `executeRecords` (name is the implementer's; the *routing* is the requirement) to
  `HarnessToolRuntime` (`src/types/index.ts`) and implement it in `src/harness.ts` beside
  today's `executeRecordTool`.
- Register it in **all four** places, or the guards will not catch the omission for you:
  `AUTHORITY_RUNTIME_METHODS` and `SHARED_STATE_TOOL_NAMES` (`capability.ts`), the
  `LaneRuntimeCall` union (`lane-authority.ts`), and the `answer()` switch including
  `adoptStoreCounter` (`lane-authority.ts`).
- Re-point every wrapper source entry at it, replacing
  `context.harness.runtime.executeRecordTool('profileManage', context)`.
- State the rule where a tool author reads it: `toolCreate`'s description
  (`toolCreate.tool.ts`) and `capability.ts`'s `WORKER_MODE_NOTES`.

*Check:* a worker-mode test (pattern: `src/server/workers/lane-authority.test.ts`,
`capability.test.ts`) asserting a `tasks` write from a lane produces exactly one `answer()`
frame on the canonical harness and **no** mutation on the replica; `lane-worker-loop.ts`'
classification loop still throws for an unclassified runtime key (delete the registration
and confirm it throws — that is the proof the guard works).

### T2 — Build the engine (Decisions B, C, D, G)

- One store, one `nextId`, one entry shape carrying `rev` / `updatedBy` /
  `updatedThreadId` / `updatedAt` — **and no `owner`, no `ownerThreadId`, no `leaseUntil`**
  (Decision P).
- Batch CRUD + `expects` + `since` + `offset`/`limit`/`afterId` + `mergeDisjoint`, whole-call
  validated, with the apply order **patches → removals → additions** (Decision P deleted the
  four claim steps).
- **No claim machinery at all** (Decision P): do not port `isHolder`, `isExpired`,
  `claimMessage`, the `claim`/`release`/`takeover`/renew verbs, `leaseMs`, or the three
  `TASK_*_LEASE_MS` constants. Deleting them is the requirement, not an oversight — a reviewer
  who "restores the missing claim support" has undone R3.
- **A stale rejection returns the current entry** (R9): the `stale-record` payload carries
  `expectedRev`, `currentRev`, `updatedBy`, `updatedAt`, `changedFields`, **and the current
  values**, so the caller never re-reads to recover. Budget it like a page (F13).
- **Per-collection** `storeRev` + FIFO change window (Decision B).
- Per-collection declaration, engine-owned because the engine cannot infer it (F9): field
  list **in canonical order**, field caps, count facets, projection (chapters: `content`
  only from `get`), sort (chapters: `order` ascending, then insertion order).
- `collection` is a schema `string`, validated against the registered set **before**
  dispatch; unknown → `HarnessError` naming the defined collections (Decision C).
- `define` action for agent-created collections, with engine defaults for caps.
- Store bounds: 200 entries/collection default; page budget strictly < outer envelope;
  preserve the "first record always included so `nextOffset` always advances" rule.
- **Persist collection definitions in the snapshot** (Decision M), so a `define`d collection
  is rediscovered after restart; engine-side `collection` validation must accept **restored**
  definitions, and a restored definition is itself validated before anything mutates (unknown
  field / bad cap / empty field list → reject the restore).
- **`define` of an existing name is an error**, never a silent merge (Decision M) — otherwise
  an agent could re-`define` `tasks` with different caps and change a live contract mid-session.
- **Drop a collection only when empty** (Decision M): dropping a non-empty one would itself
  mutate history, which the Q3 answer forbids.
- **Attribution fields are immutable facts** (Decision L / F16): `updatedBy` /
  `updatedThreadId` / `updatedAt` are never re-validated against the agent roster, and a
  snapshot naming a departed agent restores and reports unchanged. Do not add roster
  validation here.

*Check:* `src/core/{profile,chapter,location}.ts` no longer carry their own `paginate`,
`readOffset`, `readLimit`, `requireText`, `optionalText`, `copy*`, or `reset`/`snapshot`/
`restore` — one implementation each in the engine. Re-run the F1 normalized diff: profile vs
location should reduce to the `traits` field spec alone.

### T3 — Rebuild the four wrappers, and collapse the harness/snapshot/worker plumbing

- Wrappers: `tasks`, `chapters`, `profiles`, `locations` become stateless adapters
  (Decision E) — own schema + field caps, collection mapping, response reshape.
- **Rename `task` → `tasks`** per Decision J, across every surface in that decision's table
  (tool name, source file, `TASK_NAME`/`TASK_METADATA`, HTTP path, frontend presets,
  reserved names, `CORE_ORDER`, `scripts/check-package-tools.mjs`, and the single
  `TASK_TOOL_NAME` constant in `command-builtins.ts`). **The slash command stays `/task`** —
  it is a separate literal; a test asserting `/tasks` works would be wrong.
- **Collection keys are plural and identical to the tool name** (Decision K): `tasks`,
  `chapters`, `profiles`, `locations`.
- **Visibility** per Decision I: `tasks` = `core`; `records`, `chapters`, `profiles`,
  `locations` = `searchable`.
- Keep tags, HTTP paths and frontend presets otherwise unchanged
  (`src/frontend/main.ts`, keyed by tool name).
- Collapse the four store closures in `src/harness.ts` (`createTaskTool`/`createProfileTool`/
  `createChapterTool`/`createLocationTool`) and the `reset()` block into one engine.
- Collapse the snapshot record block: `src/core/snapshot.ts`
  `readSnapshotKeys(records, ['todos','profiles','chapters','locations'], 'snapshot.records')`
  and `HarnessSnapshot.records` in `src/types/index.ts` become one collection map, with
  per-collection validation delegated to each collection's reader. Greenfield (R5), so no v1
  migration — but keep `HARNESS_SNAPSHOT_VERSION` honest about the shape change.
- Collapse `RECORD_SPACE` / `RECORD_TOOL_NAMES` / `ID_SPACES` to one record space (F3).
- Preserve `visibility` per Decision I / Q2 (default: today's split, F14).

*Check:* `src/harness.records.test.ts`, `src/harness.snapshot.test.ts`,
`src/harness.metadata.test.ts`, `src/core/metadata.ownership.test.ts` pass — with the
`CORE_ORDER`, `TOOL_NAMES` and `taskItem('1', …)` expectations updated deliberately and
called out in the diff, not silently massaged to green.

### T4 — Make R7 (`toolCreate` is standalone) a stated contract (Decision F)

- Add to `TOOL_CREATE_METADATA.description`: a created tool computes its own result from its
  arguments and is **not** a proxy for another tool. Note the description currently lists
  `context` as *"(agent, agents, run)"* and never mentions `callTool`/`harness` — make that
  omission deliberate and explicit, since the body *does* receive them (F8).
- Add a **non-blocking** capability-scan pattern for `callTool(` / `harness.executeTool(` in
  a created source, modelled on the existing
  `context.callTool("delegate" | "threadFork")` entry (`blocking: false`).
- Add `records` to the reserved-name set (F15) so a created tool cannot shadow the engine.
- Keep the entry-literal contract intact: `scripts/check-package-tools.mjs` requires
  `dependencies: []` and computation-free literals. Do not "fix" duplication by adding an
  import.

*Check:* `npm run test:package:tools` and `npm run tools:manifest:check` pass; a created
tool whose body calls `context.callTool(...)` is **reported** (not refused), and
`toolCreate`'s description says so.

### T5 — Delete the claim sweep and every lock field with it (Decision P; inverts Decision H / F11)

**This task was "extend the sweep to every collection". Round 7 inverted it: there is no lock,
so there is nothing to sweep.** Do the deletion, and keep the attribution invariant intact.

- Remove `releaseThread` from the record engine entirely (`task.ts:213` declares it,
  `task.ts:1349-1351` implements it).
- Remove the **four** `taskStore.releaseThread(…)` calls in `src/harness.ts` — thread stop,
  thread delete/cascade, `restore()`, and the `removeAgent` roster-drop site. Re-grep, the line
  numbers move. **Delete only the call**, not the surrounding lifecycle work: stopping a thread,
  cascading a delete, and dropping a roster entry all still happen.
- Remove `owner` / `ownerThreadId` / `leaseUntil` from the entry type, the copy path,
  the snapshot readers (`task.ts:1523-1547`, including the `leaseUntil needs "owner"`
  cross-check and the `readSnapshotNumber` path that fed it), and the canonical field lists
  (`task.ts:1390,1400`).
- Remove `'claim' | 'release'` from `TaskChangeOp` (`src/types/index.ts:1257-1258`) and update
  the comment above it that describes what each op covers.
- Remove the four params from `src/tools/runtime/task.tool.ts:84-107` (`claim`, `release`,
  `takeover`, `leaseMs`) and every mention of them in the description (`:27`, `:68`) —
  including the "one id may appear in only ONE of `tasks`/`remove`/`claim`/…" clause, which
  shrinks to `tasks`/`remove`.
- Remove the `/task claim|release|takeover` subcommands (`command-builtins.ts:384-396`), the
  `(claimed by X until Y)` suffix (`:196`), the indefinite-claim rendering (`:188-189`), and the
  usage line at `:269`.
- **Do not touch** `WriterLeaseLedger` (`lane-commit.ts:294-330`), `IdentityLease`
  (`lane-identity.ts`, the `'lease'` op at `lane-authority.ts:124`), or `ownerThreadId` **on a
  thread** (`lane-authority.ts:256,277`, `lane-commit.ts:83,187`). Same words, different
  feature — see Decision P's "do not over-delete" table.

**What survives, and is the whole of this task's test obligation** (Decision L / F16):
`updatedBy` / `updatedThreadId` / `updatedAt` are immutable facts. They must survive thread
stop, thread delete, `removeAgent`, and `restore()` untouched, and a stale rejection after any
of those must still name the departed agent as the last editor — now alongside R9's current
entry.

*Check:* `grep -rn "releaseThread" src/` returns only `plugins/async-ping.plugin.ts` (its own
unrelated local `releaseThread`); `grep -rn "claim\|takeover\|leaseUntil" src/core/task.ts
src/tools/runtime/task.tool.ts src/types/index.ts` returns nothing; `/task claim 1` reports an
unknown subcommand; and the attribution test below passes.

### T6 — Write `records`' description so the model can actually use a low-level surface (R4)

Three things the text must carry:

- **Unknown collection is an error, never an empty list** (Decision C). Say what the defined
  collections are, and that `define` creates a new one.
- **Access is transient** (F10): `records` can be evicted by the `maxEnabledTools` cap, and
  re-enabling costs nothing — name the tags so the model can re-open it.
- **It is the escalation path** (R6): the wrappers are cheaper in context; `records` is for
  requests a wrapper's schema refuses.
- **Do not advertise claim verbs** (Decision P): the description must not mention
  `claim`/`release`/`takeover`/`leaseMs`, and should state the conflict rule in one line —
  *every patch is accepted unless it is stale, and a stale rejection returns the current
  record.* An agent that reads a description listing locks will try to take one.
- Per **Decision O / Q5**, the wrapper's own rejections must be equally precise, and must
  name `records` plus a tag that would enable it — so an agent that has never discovered the
  engine can still find it. That is the difference between R6 being a documented escape hatch
  and R6 being reachable.

*Check:* `src/core/metadata.ownership.test.ts` and `src/harness.metadata.test.ts` pass; the
generated mirror `src/core/tool-manifest.ts` is **regenerated**, never hand-edited; a
`records` call with an unknown collection throws rather than returning an empty page.

### T6b — Give every engine rejection a stable code (Decision O, F17)

Required before wrappers can honour Q5. Today an error is prose only: `HarnessError` adds
just `cause`, and `toErrorInfo` returns `{ message: string }`.

- Follow the `src/core/nested-runs.ts` precedent: a **stable machine code** per rejection
  class, carried as `error.name` (and/or a new `code` field on `HarnessError`) **and** as the
  first token of the message, so the model, the HTTP surface, the worker report and the
  operator all quote one identifiable name.
- Minimum code set: `stale-record`, `guarded-write`, `field-too-long`,
  `unknown-collection`, `record-cap`, `store-full`, `nested-run-unsupported` (already uses
  this shape — align it rather than inventing a second mechanism). `claimed-record` is gone
  (Decision P), which makes `stale-record` the **only** write-conflict code — so its payload
  must carry everything R9 asks for, because there is no second chance and no other rejection
  a caller could consult instead.
- Keep classification **total**: `isInstanceOf` exists because *"a thrown Proxy with a
  throwing `getPrototypeOf` trap can make `instanceof` throw"*, and `toErrorInfo` must never
  throw. A wrapper switching on codes must not become a new crash path.
- Wrappers switch on the **code**, then re-word into their own vocabulary — they translate, do
  not swallow (Decision O).

*Check:* a wrapper test asserting a specific engine rejection is surfaced with the same code
and a wrapper-specific message; `toErrorInfo`'s existing totality tests
(`src/util/errors.ts`, and the `Tool "…" failed: <message>` rendering in `src/harness.ts`) stay
green; the `nested-runs.ts` code `nested-run-unsupported` still resolves unchanged.

### T7 — Verify the claims this document could not test

- **F12:** with a `stateChange` listener attached, one `tasks` add emits exactly two
  `tool_execute` events (`records` + `tasks`), and `src/server/sessions.ts` performs **one**
  snapshot write per turn, not two. If it writes twice, record that here and bound the
  wrapper's notifications.
- **F5:** confirm the routed path really is the one taken in worker mode — instrument
  `answer()` and assert a wrapper write crosses the boundary. This is the claim the whole
  design rests on and it has never been observed live.
- **R9 (round 7, new):** confirm a `stale-record` rejection actually carries the current entry
  through **both** hops — engine → wrapper → model — and that the payload survives the outer
  64 KiB budget for a record with a long `content` field. If the current entry would overflow,
  the rejection must degrade to a projection (fields + revs, `content` omitted) and say so, not
  truncate silently.

*Check:* both results written into this file, marked `unconfirmed` if not run.

### T8 — Tests for the guarantees R3 promises

Minimum set, beyond whatever the rebuild inherits:

- `mergeDisjoint` still succeeds after a burst of writes to a **different** collection
  (Decision B's whole point).
- `since:` on collection A returns **no** B events.
- Global ids across collections: adding a chapter after three tasks does not reuse an id,
  and `afterId` filters by collection.
- ~~A claim on a chapter blocks only that chapter, and is swept by `releaseThread` (T5).~~
  **(deleted, round 7)** — replaced by: a write to a chapter and a write to a task never
  interfere at all, in either direction (Decision P removed the only cross-writer that could).
- An over-cap `add` is an actionable error and **does not burn an id** (the existing
  `profile.ts` stance: *"a full store is an actionable error, and a failed add never burns
  an id"*).
- **Attribution survives agent removal** (Decision L / F16, Q4 default): a record written by
  `researcher` is patched successfully by `writer` after `removeAgent('researcher')`, and the
  stale-token message still names `researcher` as the last editor.
- **A `define`d collection is rediscovered after `snapshot()`/`restore()`** (Decision M), and
  re-`define`ing an existing name is an error.
- **A non-empty collection cannot be dropped** (Decision M).
- **Authorship grants nothing** (Decision N): `writer` patches a record `researcher` wrote,
  and succeeds on the correct `expects` token — and the stale-token message still names
  `researcher` as the last editor.
- **Nothing blocks a write but a stale one** (Decision P): two threads patch the same record
  with the same `expects` rev; the first lands, **the second is refused with `stale-record`
  and its rejection body contains the first thread's new values** — not merely a message telling
  it to re-read. This is the single test that proves both rulings at once.
- **No lock can be stranded** (Decision P): after `removeAgent`, thread stop, thread delete and
  a `restore()`, every record in every collection is writable by anyone immediately — there is no
  `owner` field to clear and no expiry to wait out.
- **Every engine rejection carries its code** (Decision O / T6b), and a wrapper surfaces the
  same code with its own message rather than swallowing it.
- ~~**Q6 default (block):** a non-holder write against a live claim throws `claimed-record`;
  after expiry the same write succeeds and clears the claim.~~ **(deleted, round 7 — Q6 was
  answered "neither"; see the two Decision P tests above instead.)**
- A `records` list on a large collection cannot return a page the outer envelope then
  truncates while `hasMore` is `false` (F13).

*Check:* focused run —
`npx vitest run src/harness.records.test.ts src/core/task.test.ts src/core/profile.test.ts src/core/chapter.test.ts src/core/location.test.ts src/server/workers/capability.test.ts src/server/workers/lane-authority.test.ts src/server/persistence.test.ts`
then `npm test` (`package.json`, which is the two manifest checks plus `vitest run`). Report
counts and failing test names. **A green focused run is evidence for those files only** —
never the final verification.

### T9 — Housekeeping the repo rules require

- This file's row in `docs/tasks/README.md`'s index (done with this entry).
- Update `knowledge.md`'s *Session records* section and the tool-tag table (grep
  `profileManage` there — several rows and prose blocks name the three stores), and mark the
  superseded "three separate stores" / "separate closets" prose **`corrected` in place**
  rather than deleting it.
- **`knowledge.md` also documents the claim protocol at length** — grep
  `claim|takeover|lease` there returns **71 matching lines**, including the apply-order
  sentence at `knowledge.md:753` that F2 quotes (*"claims → releases → takeovers →
  expired-claim clears → patches → removals → additions"*). Decision P deletes that protocol,
  so this is not a incidental edit in T9 — it is most of the file's record-store prose, and
  leaving it makes `knowledge.md` describe a locking engine the code no longer has. Correct it
  in place with the same rule, and update the quoted apply order to **patches → removals →
  additions** wherever it appears (F2 and T2 both cite it).
- Update `src/core/index.ts` exports and `scripts/check-package-tools.mjs` (the
  `RUNTIME_SOURCE_ENTRIES` list and the name→path mapping both enumerate the three
  `*.tool.ts` files; a new `records.tool.ts` must be added there or the gate fails).
- Regenerate the Rust twin: `packages/typecrate/harness/src/tools/catalogue.rs` is
  **generated** by `Temp/typecrate-harness/t4/generate-catalogue.mjs` from
  `src/core/tool-manifest.ts` — *"Regenerate instead of editing."* Its header also pins row
  ORDER to `GET /tools`, so re-check the ordered name arrays in `src/server/api.test.ts`,
  `src/server/cli/options.test.ts`, `src/server/commands.test.ts` and
  `src/server/harnesses/presets.test.ts`.

*Check:* `npm run test:package:tools` and `npm run tools:manifest:check` pass, and the Rust
catalogue diff contains no hand edits.

---

## Verify before starting — drift check

Run this first, in one pass. It re-establishes every anchor by **identifier**, so it stays
useful no matter how far the line numbers have moved.

```bash
cd packages/underload/harness
git rev-parse --show-toplevel            # must be .../packages/underload/harness (own repo)
git log -1 --format='%h %s'              # written against 44cdbbe; anything newer = re-check
wc -c src/harness.ts                     # 513,096 when written; 521,777 at last re-check

# F5 / Decision A — the routing crux (most important; verify before anything else)
grep -n "AUTHORITY_RUNTIME_METHODS\|SHARED_STATE_TOOL_NAMES\|LOCAL_RUNTIME_METHODS" \
     src/server/workers/capability.ts
grep -n "is neither routed to the authority nor declared local" src/server/workers/lane-worker-loop.ts
grep -n "callTool" src/server/workers/capability.ts src/server/workers/lane-authority.ts
#   expect: capability.ts flags callTool ONLY for delegate|threadFork, blocking: false;
#           lane-authority.ts has NO callTool routing case.

# F4 — the discovery gate is still model-path-only
grep -n "registered but not enabled yet" src/harness.ts
grep -n "invokeRegisteredTool\|callToolInternal\|executeToolInternal\|toolHandleView\|executeRecordTool" src/harness.ts

# F6 / Decision B — change log and storeRev
grep -n "TASK_MAX_CHANGES\|storeRev\|mergeConcurrentFields\|TASK_CONTENT_FIELDS" src/core/task.ts
grep -n "collection" src/types/index.ts        # TaskChange still has no collection field?

# F3 / F11 / F13 / F15
grep -n "RECORD_SPACE\|RECORD_TOOL_NAMES\|adoptStoreCounter" src/server/workers/lane-authority.ts
grep -n "ID_SPACES" src/server/workers/lane-identity.ts
grep -n "releaseThread" src/harness.ts src/core/task.ts   # expect FOUR harness.ts call sites —
#   all four are DELETED by T5 (Decision P), so a non-empty result here is the starting state
grep -n "MAX_RECORDS\|RESPONSE_BUDGET_BYTES" src/core/task.ts src/core/profile.ts
grep -n "reserved\|is reserved by the harness" src/core/creation.ts

# F14 — visibility split
grep -n "visibility" src/tools/runtime/task.tool.ts src/tools/runtime/{profile,chapter,location}Manage.tool.ts
grep -n -A4 "CORE_ORDER = \[" src/harness.records.test.ts

# F17 / Decision O — does HarnessError carry a code yet?
grep -n "class HarnessError\|toErrorInfo\|UNKNOWN_ERROR_MESSAGE" src/util/errors.ts
#   expect: HarnessError adds only `cause`; toErrorInfo returns { message: string }.
#   If a `code`/`name` field already exists, T6b is partly landed — align, don't duplicate.
grep -n "NESTED_RUN_LIMITATION_CODE\|error.name =" src/core/nested-runs.ts   # the precedent
#   expect: error.name = the code, and the code is the message's first token.

# Decision P — the claim machinery to DELETE (round 7). Non-empty here = work still to do;
# empty everywhere = T5 is landed. Do not "restore" any of it.
grep -n "isHolder\|claimMessage\|is claimed by\|isExpired\|leaseUntil\|takeover" \
     src/core/task.ts src/tools/runtime/task.tool.ts src/types/index.ts src/core/command-builtins.ts
#   and confirm the three UNRELATED leases survive (they must NOT be deleted):
grep -n "WriterLeaseLedger" src/server/workers/lane-commit.ts
grep -n "IdentityLease\|IdentityLease" src/server/workers/lane-identity.ts src/server/workers/lane-authority.ts
grep -n "ownerThreadId" src/server/workers/lane-authority.ts src/server/workers/lane-commit.ts

# F16 / Decision L — agents ARE removable; attribution is not roster-validated
grep -n "removeAgent\|addAgent\|is the primary agent and cannot be removed" src/harness.ts
grep -n "releaseThread(defaultThreadIdOf" src/harness.ts
grep -n "updatedBy" src/core/task.ts src/types/index.ts   # optional string, never roster-checked

# Decision J — the rename surface (re-grep; these move)
grep -rn "'task'\|TASK_TOOL_NAME\|task\.tool\.ts" src/tools/runtime src/core/command-builtins.ts \
     src/harness.records.test.ts scripts/check-package-tools.mjs src/frontend/main.ts | head -30
#   confirm the slash-command literal is still `/task` and is NOT in the rename set

# F8 / T4 — toolCreate still unrestricted
grep -n "AsyncFunction('args'\|no sandbox\|DEFAULT_CREATED_TOOLS_LIMIT" src/core/creation.ts
grep -n "callTool\|harness" src/tools/runtime/toolCreate.tool.ts
#   expect: the description mentions `context` (agent, agents, run) and NOT callTool.

# F9 / snapshot
grep -n "readSnapshotKeys(records\|HARNESS_SNAPSHOT_VERSION" src/core/snapshot.ts

# BASELINE — must be green BEFORE any edit, or you cannot tell your damage from theirs
npx vitest run src/harness.records.test.ts src/core/task.test.ts src/core/profile.test.ts \
             src/core/chapter.test.ts src/core/location.test.ts \
             src/server/workers/capability.test.ts src/server/workers/lane-authority.test.ts
npm run tools:manifest:check && npm run test:package:tools
```

**Stop-and-recheck conditions** — each means a finding moved, not that the work is wrong:

1. **`callTool` gained a routing case or a blocking capability pattern** → F5 is partly
   closed by someone else; keep T1's documentation and test halves, mark F5 `corrected`.
2. **`TaskChange` gained a `collection` field** → Decision B was overridden toward the global
   log; re-verify F6's *eviction* symptom, which filtering does **not** fix.
3. **The record stores were already deduplicated** → F1's line counts are stale; re-run the
   normalized diff before claiming the duplication is gone.
4. **`releaseThread` gained or lost call sites** → F11's table is stale (it has already moved
   from 2 to 4 during this audit); re-grep rather than trusting the table. **Round 7 note: a
   count of ZERO means T5 is already landed by someone else — do not re-add the sweep.**
5. **`maxEnabledTools` eviction was removed or made sticky** → F10 and T6's second bullet no
   longer apply.
6. **`toolCreate` gained a semantic source restriction** → Decision F is already made;
   record which way and drop the other.
7. **The manifest/package gates changed** (`package.json` scripts;
   `scripts/check-package-tools.mjs` entry list and name→path map) → T4 and T9's commands
   break first, so run them before writing prose.
8. **Q4 or Q5 has been answered elsewhere** (a permission model on `updatedBy`, or wrapper
   cap errors that do not name `records`) → mark it resolved here and align T5/T6.
9. **`removeAgent` was removed or made to refuse subagents** → F16's premise flips; re-read
   the roster-drop comment. **Round 7 note: T5 no longer touches the claim sweep — it deletes
   the call at this site. What still matters here is the attribution invariant, which
   `removeAgent` must not disturb.**
10. **The tool was already renamed to `tasks`** (or the command to `/tasks`) → Decision J is
   partly landed; verify the **command** is still `/task`, which is the half most likely to
   have been renamed by mistake.
11. **`claim`/`takeover`/`leaseUntil` reappear in a record store** (a new file, or restored in
   `task.ts`) → someone has overridden Decision P. Do not assume it was you: ask before
   building on it, because R1/R3 as amended no longer list locks and the whole lifecycle
   machinery (F11, F16, Decision H, T5) was deleted on the strength of that ruling.
12. **A stale rejection returns only prose** (no current entry) → R9 is unimplemented. It is a
   requirement, not a nicety: with claims gone, CAS is the only conflict control, and a
   conflict that costs two round trips instead of one is the tax on every concurrent edit.

---

## Not tested

- **No live session and no test run for this entry.** Everything is read from source. In
  particular the F5 lost-write claim is inferred from `capability.ts`'s own statement of the
  failure mode, not observed on a lane. T7 exists to settle it.
- **Whether a wrapper's `runtime`/`callTool` hop actually mutates the replica's private copy
  in worker mode** — F5. Unconfirmed; this is the single most load-bearing unverified claim
  in the document.
- **Whether two `tool_execute` notifications cause two snapshot writes** — F12, T7. Inferred
  from `invokeRegisteredTool`'s `finally` and the persistence contract in
  `src/types/index.ts`.
- **Whether `records` is really evicted mid-session in practice** — F10 is read from
  `currentEnabledNames`/`enableTools`; the eviction window under a real `maxEnabledTools`
  value was not exercised.
- **The `mergeDisjoint` degradation under cross-collection churn** — F6 symptom 1. The no-gap
  rule is read directly from `mergeConcurrentFields`, but no simulated burst was run.
- ~~**`paused`/`stopped` thread interaction with the claim sweep**~~ — **moot as of round 7**:
  Decision P deletes the sweep, so a stopped thread strands nothing. The sibling entry
  `2026-11-08-delegate-stress-test.md:385-387` still never observed `paused` live, but that gap
  no longer bears on this design.
- **R9's current-entry payload** — decided in round 7, never run. Whether the payload fits the
  outer budget for a chapter with a long `content`, and whether a wrapper passes it through
  rather than flattening it to a sentence, is unverified. T7 covers it.
- **The cost of deleting claims is a guess, not a measurement.** Decision P argues the lost
  protection (wasted work when an edit lands mid-flight) is acceptable. That is the architect's
  call and it is well-reasoned, but nobody has run a multi-agent session under pure CAS to see
  how often a long-running edit actually loses its race. If it turns out to be frequent, the
  answer is a **derived read** (recent `updatedBy` in the change feed), not a lock — see
  Decision P's *Rejected*.
- **Whether `callTool`-from-a-tool was ever tried and backed out.** The package is its own
  repo at `44cdbbe` with a dirty tree (~20 modified `src/` files), and the record-store
  sources are untracked from the workspace root, so no history answers this.
- **Concurrent-edit risk to this document itself.** Other agents hold the same files open;
  `src/harness.ts` grew ~9 KB during the audit that produced this entry. Treat every number
  here as a pointer, not a fact — see the warning at the top.


---

## Round 8 — implementation record (2026-11-09, agent G8)

**Drift check first.** Written against `44cdbbe`; the tree had moved to `afb38f1` plus a
large uncommitted sibling landing (delegate timeout/scope, threadSend merge, plugin bus,
edit/actorKey, messageId, outcome persistence, compaction policy, worker-lane transcript
patch). Every anchor below was re-grepped by **identifier** before editing, per the rule at
the top; no line number in this document was trusted. `src/harness.ts` is now ~582 KB.

**Baseline before any edit** (`npx vitest run`, no TMPDIR override): 178 files,
**3130 passed / 2 skipped**, exit 0. Focused baseline of the five files the brief names:
**138 passed (5 files)**. Green, so work proceeded.

### Landed

| task | state | where |
|---|---|---|
| **T2 engine** | **landed** | new `src/core/records.ts` (~1,000 lines): one store, one global `nextId` (F3), batch CRUD with apply order **patches → removals → additions**, `expects` CAS, `since`/`afterId`/`mergeDisjoint`, per-collection `storeRev` + FIFO window (Decision B, 200/50), declared field specs with canonical order, caps, facets, `getOnly` projection and `sortable` (F9), `define`/`drop` (Decisions C/M: re-define is an error, non-empty and built-in drops are refused, definitions persist in the snapshot), snapshot readers (`readRecordsStoreState`) that validate every collection against its own stored definition, and the **R9 stale payload**: `stale-record` carries `expectedRev`/`currentRev`/`updatedBy`/`updatedAt`/`changedFields` **plus the current entry**, both in `error.details` and in the message as `current: {…}`, budgeted at `RECORD_STALE_PAYLOAD_BUDGET_BYTES` with a stated projection when it would overflow. |
| **T2 specs** | **landed** | `src/core/{task,profile,chapter,location}.ts` are now pure `RecordCollectionDefinition` declarations. The F1 normalized diff reduced to what it predicted: `profile.ts` vs `location.ts` differ by the `traits` field alone. |
| **T1 routing** | **landed** | `harness.runtime.executeRecords(name, context)` replaces `executeRecordTool`, registered in all four places: `AUTHORITY_RUNTIME_METHODS` + `SHARED_STATE_TOOL_NAMES` (`capability.ts`), the `LaneRuntimeCall` union (`lane-authority.ts`), the `answer()` switch with `adoptStoreCounter()` (`lane-authority.ts`), and the replica route (`lane-worker-loop.ts`). |
| **T3 wrappers + rename** | **landed** | `tasks.tool.ts` (renamed from `task.tool.ts`, `TASKS_NAME`/`TASKS_METADATA`), new `records.tool.ts`, and `chapters`/`profiles`/`locations` (renamed from `*Manage.tool.ts`) — each one literal schema plus one routed call; the mapping and response reshape live engine-side because the gate pins these entries to `dependencies: []`. `TASK_TOOL_NAME` in `command-builtins.ts` is `'tasks'`; the command is still `/task`. HTTP path, frontend presets (`main.ts`), `contract.ts` core names, `scripts/check-package-tools.mjs` (entry list + name→path map), `CORE_ORDER` and the snapshot (`HarnessSnapshot.records` = one collection map, `HARNESS_SNAPSHOT_VERSION` **1 → 2**, no v1 reader per R5) all follow. `RECORD_SPACE`/`RECORD_TOOL_NAMES`/`ID_SPACES` collapse to one `'record'` space and `CanonicalView.records`. |
| **T5 claim deletion** | **landed** | `claim`/`release`/`takeover`/`leaseMs`, the three `TASK_*_LEASE_MS` constants, `isHolder`/`isExpired`/`claimMessage`, entry `owner`/`ownerThreadId`/`leaseUntil`, `'claim'|'release'` from the change-op union (now `RecordChangeOp = 'add'|'update'|'remove'`), the `leaseUntil needs "owner"` restore check, the `/task claim|release|takeover` subcommands and the `(claimed by …)` suffix are **gone**, with `releaseThread` and all four `harness.ts` call sites (stop, delete/purge, `restore()`, roster-drop). `WriterLeaseLedger`, `IdentityLease` and a thread's `ownerThreadId` are untouched, as Decision P's "do not over-delete" table requires. |
| **T4 R7 uplift** | **landed** | `toolCreate`'s description now states the purely-standalone rule and says plainly that the body receives `callTool`/`harness`; `capability.ts` gained `CREATED_TOOL_PROXY_CODE`/`CREATED_TOOL_PROXY_PATTERNS`/`reachesToolProxy` and reports (never refuses) a created body that forwards, surfaced on the authority's created-tool answer as `sync.warnings`. `records` is in the reserved-name set automatically (the reserved list is the registry's own names). |
| **T6 / T6b descriptions + codes** | **landed** | `RECORD_ERROR_CODES` (`invalid-input`, `unknown-collection`, `collection-exists`, `collection-not-empty`, `collection-permanent`, `definition-invalid`, `record-cap`, `store-full`, `unknown-field`, `invalid-field`, `field-too-long`, `unknown-record`, `guarded-write`, `stale-record`, `batch-conflict`) with `HarnessError.code`/`.details`/`name = code` and the code as the message's first token; `toErrorInfo` now carries `code` only when present; `errorCodeOf`/`isRecordRejection` are total. The `records` description carries the unknown-collection rule, the transient-access rule (F10) and the one-line conflict rule, and advertises no claim verb. |
| **T7 (partial)** | **evidence in tests, not run live** | `src/core/records.test.ts` proves the R9 payload survives the engine boundary and `src/harness.task.test.ts` proves it reaches the model through the wrapper (`Tool "tasks" failed: stale-record: … current: {…}`). The lane half is **not yet re-verified**: `lane-authority.test.ts` still fails on the renamed route (`executeRecords`) and on the deleted claim test. F12's two-notification question is answered by construction (a wrapper calls `runtime.executeRecords`, not `callTool`), so exactly one `invokeRegisteredTool` fires per wrapper call — not yet asserted in a test. |
| **T8 tests** | **landed** | new `src/core/records.test.ts` (12 tests, all passing) covering: global ids across collections and `afterId` filtering by collection; `since` on A carries no B events and A's `storeRev` is untouched by a B burst; `mergeDisjoint` still provable after 240 writes to two other collections; the Decision P/R9 conflict test (same token, first lands, second refused with the winner's **values**); guarded write vs anonymous blind write; coded rejections for unknown collection / field cap / store full, with **no id burned**; `define` + re-define error + built-in/non-empty drop errors + empty drop; a `define`d collection (with its caps) rediscovered after `snapshot()`/`restore()`; the chapter `getOnly` projection, status facets and `order` sort; the one-collection-map snapshot shape. |
| **T9 housekeeping** | **partial** | this section + the README row + the `knowledge.md` corrections. `src/core/index.ts` and `scripts/check-package-tools.mjs` are updated; `npm run tools:manifest` regenerated (31 descriptors) and `tools:manifest:check` is clean. **Not done:** the Rust twin `packages/typecrate/harness/src/tools/catalogue.rs` (its generator lives in `Temp/`, outside the repo) has not been regenerated. |

### Corrected in place (the findings that moved)

- **F17/T6b**: `HarnessError` gained `code` + `details` and sets `name = code`, exactly the
  shape the finding asked for; `toErrorInfo` keeps `{ message }` and adds `code` only when
  present, so every pre-existing `{ message }` wire payload is unchanged.
- **F14/Decision I**: `CORE_ORDER` became `['toolRequest', 'tasks']` and the searchable set
  gained `records` — `src/harness.task.test.ts` now pins 14 registered runtime tools.
- **F3 consequence, measured**: the engine enforces the cross-collection uniqueness at
  restore (`readSnapshotIdCounter` over the union of every collection's ids), which is what
  the every-`taskItem('1')` rewrite needs.
- **`releaseThread` count**: four call sites confirmed, all deleted (round 7's count of 2
  had already been corrected to 4 in F11).

### Not green yet — the honest state

Full-suite work was in flight when this entry was written. Still failing and why:
`harness.records.test.ts` (its expectations still name `profileManage`/`chapterManage`/
`locationManage` and the removed claim verbs), `capability.test.ts` (routed-tool and
shipped-toolbox name lists grow by `records`), `lane-authority.test.ts` /
`lane-commit.test.ts` / `lane-identity.test.ts` (one `record` id space, the renamed routed
method, and one lane claim test that must become a Decision P test),
`harness.snapshot.test.ts` / `persistence.test.ts` / `sessions.test.ts` / `api.test.ts` /
`metadata*.test.ts` (snapshot v2 shape + renamed tools + coded messages), and the frontend
preset re-key. `npm run typecheck` is clean (0 errors) over `src/`.

---

## Round 9 — repair pass, the tag ruling, and the last verifications (2026-11-09, agent G8b)

Scope: the suite drift left by the engine landing (44 files at the start of the pass), the two
lane checks T7 still owed, and the discovery finding T6 left open. Three production fixes came
out of chasing failures — each is a contract this document already states, listed under "Fixes
found by chasing failures" so the change is auditable rather than silent.

### The tag ruling — `records` owns only the engine's words (corrects the T6 row in place)

T6 as written: *"`records`' description carries the unknown-collection rule, the transient-access
rule (F10) and the one-line conflict rule"* and the entry is searchable. Its tag list originally
echoed the collection vocabulary (`collection`, `collections`, `schema`), which made the engine a
tag-shadow of every wrapper it serves.

Corrected: the tag set is now `['records', 'record', 'store', 'entries', 'define']` — the words
that describe the ENGINE (`src/tools/runtime/records.tool.ts`). Wrapper words (todos, traits,
memos, scenes, settings…) belong to the wrappers, which are the doors an agent walks through for
one store; `records` is the escalation surface reached when a wrapper's schema refuses, and it is
found by its own name.

The measured half, which the ruling does NOT change: narrowing the tags did not stop
`toolRequest tags:["profile"]` from enabling `records`. The cause is not the tags — it is
`scoreTool`'s 1-point rung (`src/core/discovery.ts:127-141`), which scans a searchable tool's
DESCRIPTION, and T6 requires this description to name the built-in collections. So a wrapper word
still reaches `records`, always at the WEAKEST rung: `profiles` scores 4 (exact tag) and ranks
first, `records` scores 1 and ranks last. That is the property the escalation rationale needs
(the engine never outranks a wrapper), and it is now pinned rather than assumed:
`harness.records.test.ts`, `harness.test.ts` and `harness.browser-fallback.test.ts` carry
`records` in the enabled sets with a comment naming the rung.

Two consequences of the same narrowing are pinned where they are visible: the searchable tag
UNION grows by `define`, `entries`, `record`, `records`, `store` and loses `book` (the chapters
entry keeps only the story words) — `harness.already-available.test.ts` and
`harness.discovery.test.ts` pin the union; and every pinned inventory count grows by the one new row:
`src/core/tool-manifest.ts` reports 31 descriptors, the browser fallback without presets
reports 21, and the `descriptors*` / `tool-discovery*` / server-page expectations follow.

### Fixes found by chasing failures (three, all contract-restoring)

1. **`chapters` `get` returns `{ chapter, content, counts }`.** The engine first shipped
   `content` INSIDE `chapter`, which contradicts the wrapper's own description and
   `knowledge.md:971`. `toWrapperResult` now hoists every `getOnly` field of a collection to a
   SIBLING of the singular key on a `get`, leaving the entry as the declared projection
   (`src/core/records.ts:2655-2687`). `records` — no wrapper, no reshape — still answers with the
   record whole, and a mutation answer still carries no body.
2. **A removal of an id the collection never held reports `unknown-record`.** Removal ids were
   absent from the existence pass, so an identified caller got the guard's "read it first" and an
   identity-less caller got a silent no-op. They now join it (`src/core/records.ts:1412-1423`),
   which is what `core/task.ts:34` ("an unknown id is a rejection"), the old
   `core/chapter.ts:597` and `/task remove`'s own comment in `command-builtins.ts:363-365` all
   promise. `/task remove 99` answers
   `/task remove: unknown-record: tasks has no task with id "99".`
3. **Restore validation got the depth the entries already had.** An entry field failure was
   labelled with the COLLECTION name (`tasks state "completed" must be a boolean…`), so a 200-record
   file never said WHICH record; it now carries the snapshot path
   (`records state.collections.tasks.items[0] "completed" must be a boolean when provided.`).
   And a change-feed `fields` array is validated against the collection's declared keys, with
   duplicates refused — the pre-engine store enforced exactly this over `TASK_CONTENT_FIELDS`, and
   the feed is the evidence `mergeDisjoint` relies on, so an undeclared name would make a real
   conflict look provable (`readStoredChange`, `src/core/records.ts:1745-1810`).

### T7 closed — every claim this document could not test is now a test

- **F12 (one notification per logical write)** — `src/harness.records.test.ts`,
  `record wrappers call the engine exactly once (F12)`. Two checks: a source scan of all five
  entries (exactly one `runtime.executeRecords(<NAME>, context)` call site each, zero `callTool`),
  and one live call per surface asserting exactly one engine call and exactly one
  `{ reason: 'tool_execute', tool: <name> }` event on the persistence observer.
- **Worker mode routes a wrapper write to the authority** — `src/server/workers/lane-worker.test.ts`,
  `worker mode: the record route is the only door (T1/T7)`. Writes through `tasks`, `profiles`,
  `chapters`, `locations` and `records` in one session land in the COORDINATOR's document with ids
  1-5 from the ONE counter (`records.nextId === 6`), attribution answered by the authority
  (`updatedBy: 'demo'`, no thread for a manual call). A replica-local write fails on the first
  assertion.
- **The classification guard** — same describe: every member a live `harness.runtime` exposes is
  classified (routed or local), `executeRecords` is routed and serves all five tools by name, and
  installing an authority runtime over an UNREGISTERED member throws
  `harness.runtime.mintRecordLocally is neither routed to the authority nor declared local…`
  instead of letting a lane keep a private writer.
- **Lane tests re-pointed** — `lane-authority.test.ts` pins the engine's CAS sentence verbatim
  (code-first, `updatedAt` beside the last editor, R9's `current:` payload) and the routed lane
  CLAIM test is deleted (Decision P deleted its subject; the CAS test above it is the routed-write
  proof). `lane-commit.test.ts` folds an add+update window through the collection-map validator and
  pins the digest-vs-token difference on the ATTRIBUTION pair, which is what moves without the
  tool's `{ id, rev }` token now that claims are gone. `lane-identity.test.ts` pins the single
  `record` space (one message change) and the v2 store shape. `capability.test.ts` pins `tasks` and
  `records` in the proxied/routed sets.

### T8 harness-level items closed

`src/harness.task.test.ts`, `record engine at the harness boundary (T8)`:
- **Decision L** — attribution outlives the roster: a record written by `researcher` keeps
  `updatedBy: 'researcher'` and the feed event keeps `by: 'researcher'` after
  `harness.removeAgent('researcher')`, byte-identical before and after. Never roster-validated.
- **Decision P restated at its simplest** — there is no lock to strand, so stop / delete /
  snapshot / restore strand nothing: the tool schema has no `claim`/`release`/`takeover`/`leaseMs`,
  the persisted block contains no `"owner"` or `leaseUntil` anywhere, the feed has only `add`, and a
  restored record is exactly `['id','text','completed','rev','updatedBy','updatedThreadId','updatedAt']`.
  An OLD file that does carry a claim is refused as an unknown field
  (`src/harness.snapshot.test.ts`), which is the check the retired sweep used to be.
- **Decision O through the wrapper** — a stale write through `tasks` rejects with
  `code === 'stale-record'`, a message that STARTS with `stale-record: `, and
  `details.currentRev` / `details.changedFields` / `details.entry` (R9's current record) intact.

### The Rust twin — documented, not touched

`packages/typecrate/harness/src/tools/catalogue.rs` is a GENERATED file: its header names
`Temp/typecrate-harness/t4/generate-catalogue.mjs` as the writer, and that path exists in this
checkout but is EMPTY (Temp is disposable scratch per `AGENTS.md`). The generator is therefore
absent, the twin was NOT regenerated here, and it was not hand-edited either — the rule in its own
header ("Regenerate instead of editing") is the reason. The host's typecrate service regenerates it
from `packages/underload/harness/src/core/tool-manifest.ts`; when it next runs it will pick up the
31-descriptor catalogue (`records` new, `task` → `tasks`, `profileManage`/`chapterManage`/
`locationManage` → `profiles`/`chapters`/`locations`, and the `tasks` schema without the claim
verbs). Until then the twin still describes the pre-engine catalogue.

### Round 9 status — T1-T9, as measured this pass

| Task | State | Evidence |
|---|---|---|
| **T1** route the wrappers | **landed** | `executeRecords(name, context)` in `src/types/index.ts` + all four worker places (`capability.ts`, `lane-authority.ts`, `lane-worker-loop.ts`, `lane-commit.ts`); one `record` id space. Proved in worker mode by the new `lane-worker.test.ts` describe, and by `lane-authority.test.ts`'s routed CAS test. |
| **T2** build the engine | **landed** | `src/core/records.ts` (single store, global counter, declared field specs, canonical order, facets, `getOnly`, guarded writes, `mergeDisjoint`, `define`/`drop`, R9 payloads) + `src/core/records.test.ts` (12 tests). |
| **T3** wrappers + rename + plumbing | **landed** | five source entries, four spec-only core modules, manifest regenerated (31), snapshot v2 (`HARNESS_SNAPSHOT_VERSION = 2`, no v1 reader per R5), `CORE_ORDER`, frontend presets, `contract.ts`, `check-package-tools.mjs`, HTTP names. The `getOnly` response half was fixed this pass (finding 1 above). |
| **T4** R7 stated contract | **landed** | `toolCreate` description + `CREATED_TOOL_PROXY_*` scan (round 8); description re-pinned verbatim this pass. |
| **T5** delete the lock | **landed** | verbs, `leaseMs`, lease constants, holder fields, `/task claim|release|takeover`, `releaseThread` and its 4 sites gone; snapshot refuses a persisted claim as an unknown field; the strand-free restatement is now a test. |
| **T6** `records` description | **landed** (corrected this pass) | description unchanged in substance; tags narrowed to the engine's own words, and the description-rung behaviour pinned rather than assumed. |
| **T6b** coded rejections | **landed** | 15 `RECORD_ERROR_CODES`; `HarnessError.code`/`details`/`name`; code-first messages; the wrapper-surfaces-same-code test closes the "same code through the wrapper" half. |
| **T7** verify the untestable claims | **landed** (was partial) | F12 and the worker-mode route are asserted, not inferred — see the round-9 T7 section. |
| **T8** tests for R3's guarantees | **landed** | engine (12) + harness-boundary (3) + snapshot v2 (41) + persistence/commands/queue/records integration; `src/harness.task.test.ts` 18 tests. |
| **T9** housekeeping | **partial** | knowledge.md + README + this record updated; manifests regenerated and `:check` clean. The Rust twin is NOT regenerated (generator absent from `Temp/` scratch) — documented above, deliberately not hand-edited. |

### Round 9 measurements (the commands, the context, the outcome)

Run from `packages/underload/harness/`, no `TMPDIR` override, Node 24.19, after the last
production and test edit of this pass:

| Command | Outcome |
|---|---|
| `npx vitest run` (whole backend suite) | **exit 0** — 175 files passed, 3 004 passed / 2 skipped (3 006). |
| `npm run test:frontend` | **exit 0** — 138 files passed, 1 813 passed. |
| `npm run typecheck` | **exit 0** (tsc clean, then both manifest checks). |
| `npm run tools:manifest:check` | `tool-manifest.ts is current (31 descriptors)`. |
| `npm run plugins:manifest:check` | `plugin-manifest.ts is current (2 plugins)`. |
| `npx vitest run src/core/records.test.ts src/harness.task.test.ts src/harness.records.test.ts src/server/persistence.test.ts src/server/commands.test.ts` | **5 files / 87 tests passed** — the engine, the wrapper + T8 harness boundary, the F12 construction check, and the two persistence/HTTP surfaces that read snapshot v2. |

Round 8's "not green yet" list is closed: the 44 failing files were 25 when this pass started
(93 failing tests → 52), and all 25 are now passing. The drift was pinned to the re-keyed
reality — snapshot v2 shapes, the `record` id space, coded message prefixes, `tasks` /
`profiles` / `chapters` / `locations` / `records` in every registered/searchable/proxied list,
the narrowed tag union (loses `book`, gains `define`/`entries`/`record`/`records`/`store`), and
the deleted claim verbs — except the three places listed above under "Fixes found by chasing
failures", where the PRODUCTION code was wrong against this document.
