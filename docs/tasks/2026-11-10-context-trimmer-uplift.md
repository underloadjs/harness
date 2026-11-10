# Context Trimmer uplift — the engine trims nothing, the trimmer is the only trimmer, and it needs switches

Status: **open, unstarted.** Written 2026-11-10 as a pick-up-and-complete brief, not as a
finding log. The ask, in one sentence: **the engine core must not trim context by default
(everything recorded stays in the request), and the shipped `context-trimmer` built-in becomes
the one place trimming happens, driven by several independent switches — at minimum
"dropping old thoughts" and "dropping invalid tool calls once the next tool call yields a valid
one".**

Two of the three pillars are already true in code and are pinned below as FACTS rather than
work (Part A). The work is the third pillar plus the switch surface: today the trimmer has
exactly **one** setting (`enabled`) and **one** policy (superseded failed tool units). It has no
say at all about thinking text, and it cannot have one today without a mechanism that does not
exist yet (F3). That mechanism, not the predicate, is the bulk of this entry.

Line numbers describe the working tree as reviewed on 2026-11-10; names are the durable anchors
and the **drift check** at the end lists the commands that re-verify them. A claim without a
`path:line` reference is marked `unconfirmed`.

Companion entries:
[2026-11-09-progressive-compaction.md](./2026-11-09-progressive-compaction.md) (the sibling
context pass and the stricter version of the same rule),
[2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md) (the
`included` flag this plugin writes, and the missing UI marker),
[2026-11-09-plugin-pipeline-v2.md](./2026-11-09-plugin-pipeline-v2.md) (hook ordering, settings
writes, worker-lane commit). Related issue:
[../issues/blocking-provider-request-body-extension.md](../issues/blocking-provider-request-body-extension.md)
(issue 0001 — the transport cannot send a non-numeric request field, which is what blocks the
provider half of the thoughts switch; see F6).

---

## Date / Method / Scope

**Date:** 2026-11-10.

**Method:** two passes.

1. **Repo pass** — static audit of the shipped context-control surface: the trimmer plugin and
   its test, the compaction plugin and its settings, `groupUnits`/`planContextPruning`,
   `projectTranscript`, `setIncluded`, `edit`, the settings read/write edges
   (`src/plugin/settings.ts`, `src/server/plugins.ts`), the projection consumers
   (`withIncluded`, `core/snapshot.ts`, `core/branch.ts`), the estimator, the transport's
   request builder, and the read/UI surfaces that publish prompt-inclusion
   (`server/turn-projector.ts`, `server/api.ts`, `shared/turn-display.ts`,
   `frontend/ui/context-detail.ts`). Every negative claim was checked with one grep per claim.
   Tests were read as contracts, not executed.
2. **Ecosystem pass** — vendor contracts and measurements for replaying (or not replaying) a
   model's own prior thinking: Anthropic, DeepSeek, Kimi/Moonshot, Z.ai/GLM, Qwen + llama.cpp +
   vLLM, Gemini, OpenAI; plus four preprints on trajectory/thought reduction and roughly forty
   harness issue reports. Part E carries what that pass concluded and marks it **external
   evidence**, because it is not reproducible from this repository.

**Scope:** `src/plugins/context-trimmer.plugin.ts`, `src/plugin/context-trimmer.test.ts`,
`src/plugin/manifest.ts` (regenerated), the plugin settings descriptors it publishes, the
`turn.before` context surface it acts through (`src/types/index.ts`, `src/harness.ts`), the
thought-inclusion mechanism it needs (F3: possibly `src/types/index.ts`, `src/core/agent.ts`,
`src/core/snapshot.ts`, `src/core/branch.ts`, `src/core/context-estimate.ts`), and the
documentation that describes the current single-switch posture
(`docs/plugins.md:402-418`, `:639-652`).

**Out of scope:** the transport's per-model wire policy and its request-body limits (issue 0001
owns the body; F6/T8 records what the trimmer needs from it and stops there); the missing
board-level excluded marker and the tokens-saved figures
([2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md) T7.1 /
T7.2); compaction's `annotate` writer (progressive-compaction T5.3); per-session (as opposed to
process-wide) plugin settings, which do not exist and which no task here assumes.

---

## Part A — The premise is already true: the engine core trims nothing

This is the part the next agent must **not** re-implement, only pin. Recorded because it is the
invariant every switch below is measured against.

| Fact | Where |
|---|---|
| The request is a **pure skip filter** over canonical history: a `false` entry is skipped, everything else is emitted; nothing is rewritten, reordered, merged or truncated; the no-flag-anywhere case is byte-identical to the pre-flag behaviour | `src/harness.ts:6543-6570` (the rules comment), `:6571-6683` (`projectTranscript`) |
| The exclusion **unit** is a whole tool-call block — the assistant message owning `toolCalls` plus every `tool` message answering one of its calls, contiguous **or spliced in later** — so a withheld block never leaves half its `tool_calls[]` unanswered, and an orphan result never travels alone | `src/harness.ts:6576-6612` (the two exclusion passes), `:6613-6660` (the consumption loop) |
| A withheld assistant block still **consumes** its contiguous tool run, so its results cannot project as orphans under the next message | `src/harness.ts:6617-6627` |
| An unanswered call gets a **materialised `status: 'pending'` placeholder**, never a dropped entry — the request stays pair-clean | `src/harness.ts:6661-6679` |
| A projection copy **never carries an `included` key at all** (not even `included: true`), so a custom `HarnessStream` sees flag-free data | `src/harness.ts:6561-6569`, `src/core/agent.ts:194-208` (`withIncluded`) |
| Nothing in the engine window, truncates, elides or bounds a transcript: no history window, no overflow truncation, no context-length handler. The only engine-side eviction is of **invocation result records**, not of context | `grep -n "\.slice(\|maxHistory\|window\|elide\|truncat" src/harness.ts src/core/agent.ts` — the context-bearing hits are tool-list selection (`src/harness.ts:1689`, `:1743`, `:3169`), tool-output previews (`:3583-3596`), store pages (`:4111`, `:4147`) and `pruneInvocationRecords` (`:3492-3506`) |
| Recorded tool **bytes** and the `outcome` key are stored, never serialised into `content`, and the 64 KiB model-facing text budget does not truncate them | `src/harness.ts:6469-6487` |
| Both shipped context passes are **plugins**, and both act only through writes to canonical state (`setIncluded`), never by deleting | `src/plugins/context-trimmer.plugin.ts:334-387`, `src/plugins/context-compaction.plugin.ts`, `src/plugin/manifest.ts:33-41` (scan order = dispatch order) |

**The one place the premise is NOT literally true** — and the reason the wording of the ask
matters: `harness()` auto-loads the built-ins (`src/plugin/manifest.ts:1-24`), and both shipped
context passes declare `enabled` with default `true`
(`src/plugins/context-trimmer.plugin.ts:118-127`,
`src/plugins/context-compaction.plugin.ts` `enabled`, default `true`). So:

- **the engine core trims nothing** — true, and pinned by T1;
- **an out-of-the-box deployment trims something** — true, by exactly these two built-ins, which
  is the design the ask is asking for, not a contradiction of it.

T1's job is to turn that sentence into a test, so a future engine change cannot quietly add a
third, implicit trimmer inside the projection.

---

## Part B — The substrate the switches stand on

Every row is a constraint a switch design has to respect, not background reading.

### B1 The shipped trimmer today: one rule, one setting

| Fact | Where |
|---|---|
| Metadata: `name: 'context-trimmer'`, hooks `['turn.before']`, **exactly one** setting `enabled` (boolean, default `true`), and the description states the rule | `src/plugins/context-trimmer.plugin.ts:109-128`; the duplicate fallback `ENABLED_DEFAULT = true` at `:135` (both places move together, because the scanner requires a plain object literal: `scripts/plugin-manifest-scan.mjs:13-30`, `:73-76`) |
| The plan is **pure**: `planTrimmedUnits(entries)` → `TrimCandidate[]`, oldest-first | `src/plugins/context-trimmer.plugin.ts:246-305`, `:213-229` |
| The predicate, per unit: (1) still `included` (idempotence), (2) `kind === 'candidate'` — at least one call, **every** call answered, **every** answer `failed` or `rejected`, (3) **every** name it called has a `completed` answer in **some later, still-included** unit — matched on tool **NAME**, no argument comparison | `src/plugins/context-trimmer.plugin.ts:231-302`, `:194-210` (`firstAnswerOf`), `:140-189` (facts by name) |
| The loosening vs compaction is deliberate and name-only: compaction demands the same `toolCallFingerprint(name, canonicalArguments)`; the trimmer does not | `src/plugins/context-trimmer.plugin.ts:15-35` vs `src/core/context-pruning.ts:19-23` and `src/core/argument-fingerprint.ts:138`, `:171` |
| Guards, in one place: `branchId !== undefined` → refuse (an ephemeral copy is never trimmed); `enabled` false → refuse; `isInternalAgent(agent)` → refuse (the compactor's own helper thread must keep the failures it was handed) | `src/plugins/context-trimmer.plugin.ts:311-316`, `:50-58`; `isInternalAgent` exported from `src/plugins/context-compaction.plugin.ts` |
| The writer does **one** `setIncluded(entry, false)` per candidate, re-located by index, then **one** `api.report.diagnostic` for the whole pass (self-contained text + structured `data.units`) | `src/plugins/context-trimmer.plugin.ts:334-387` |
| Handler shape: guard + plan **synchronously**; `pause()` → write → `resume()` in a `finally`, and only on a turn that will actually write (a `undefined` return costs one microtask) | `src/plugins/context-trimmer.plugin.ts:410-440`, reasoning at `:60-68` |
| Action seam a host or test can reuse: `executeTrimming(api, context)`; writer seam: `applyTrimPlan(api, context, candidates)` via `HarnessTrimmingAction` | `src/plugins/context-trimmer.plugin.ts:389-406` |
| **No state at all** — no cooldown, no counter, nothing persisted; the trimmed state IS the `included` flag, canonical, durable, operator-visible, re-runnable after a restart | `src/plugins/context-trimmer.plugin.ts:70-75` |
| Deliberately **no** token floor, **no** tail horizon, **no** cooldown — the arguments are stated, and they are the arguments T3 re-opens (see F4) | `src/plugins/context-trimmer.plugin.ts:37-48` |

### B2 The unit and outcome model the switches read

| Fact | Where |
|---|---|
| `groupUnits` is the shared unit **mirror** (re-derived, not imported from `harness.ts`, to avoid a plugin→harness import cycle through the manifest); a divergence can only change which entry is named, never the cascade the runtime applies | `src/core/context-pruning.ts:52-60`, `:120-136` (`ContextUnit`: `leader`, `members`, `kind`, `keys`, `outcomes`, `included` — LIVE) |
| `UnitClass` is a closed set: `candidate` (all results failed/refused, all answered), `answered`, `unanswered` (a call has no committed result — in flight or never answered), `mixed` (a `cancelled` result, or healthy and failed answers together), `standalone` (a non-tool message, or an orphan result) | `src/core/context-pruning.ts:102-116`, classification at `:314` |
| `toolOutcomeOf(message)` = `message.outcome ?? 'completed'`; only a **non**-`completed` outcome is ever stored, so a pre-outcome transcript reads healthy and is never a candidate. `isErrorOutcome` is `outcome !== 'completed'`, which makes `cancelled` an error outcome by that helper while the pruning rule keeps it a **keep** | `src/core/tool-outcome.ts:54`, `:90-99`; the deliberate keep at `src/core/context-pruning.ts:16-19` and the write rule at `src/harness.ts:6484-6487` |
| Compaction's candidate list already separates **policy** from **writer**, precisely so a second writer (`annotate`) plugs in without a second policy | `src/core/context-pruning.ts:9-12`, `:139-165` (`PruneCandidate`, `PruneOptions`), and progressive-compaction T5.3 |

### B3 The controls a plugin may write

| Fact | Where |
|---|---|
| `turn.before` hands the plugin: `messages` (frozen at entry) **and** `currentMessages()`, `estimatedTokens` (frozen) **and** `currentEstimatedTokens()`, the **full canonical `entries` including disabled ones**, `iteration` (1-based model-turn counter), `actorKey`, `branchId?`, `signal`, `api` | `src/types/index.ts:4039-4097`, `:4212-4228` |
| `setIncluded(target, boolean)` — targets are an **entry**, a transcript **index**, or a **`messageId`**; `false` stores `included: false`, `true` **removes the key** (so re-enabling is the exact inverse); the write **cascades the whole unit**; lands in place on the canonical message; reports one `agent_message` transcript change, which is the ONLY durability mechanism; a branch round applies it to its ephemeral copy and reports nothing | `src/types/index.ts:4098-4156`; implementation `src/harness.ts:8523-8567` (`writeIncluded`, the cascade) and `:8688` (`setIncluded`, the target resolution) — `src/shared/turn-display.ts:548` cites the former |
| `edit(entry, {content?, reasoning?})` — the **closed** editable set is `['content','reasoning']` (`EDITABLE_FIELDS`); `reasoning` is **assistant-only**; every field is validated before anything is written; the write is in place and carries the same notification/durability as a flag write; `included` and every structural key is **refused** | `src/types/index.ts:4029-4034`, `:4157-4211`; `src/harness.ts:686`, `:691`, `:720-723`, `:8738-8815` |
| A `toolCalls`/`toolCallId`/`name` patch is refused — those are the **pairing keys** the unit resolver and the transport both trust. Consequence: **per-call partial elision is not expressible** through this surface today; unit granularity is forced | `src/types/index.ts:4162-4179`; pinned by `src/harness.inclusion.test.ts:2467` (cited by [2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md), "Deferred and decided") |
| Hook dispatch: sequential, awaited, **higher `priority` first, then registration order**, last non-empty `{transcript}` wins; fail-open is the framework's job | `src/plugin/hooks.ts:18-27`, `:60`; `src/types/index.ts:4340-4350` |
| Dispatch order of the two built-ins: **compaction before trimmer** (path-ascending scan = registration order at equal priority), and the compactor's header already reasons about the trimmer's park/resume wrapper being harmless *because* parks are owned | `src/plugin/manifest.ts:33-41`; `src/plugins/context-compaction.plugin.ts:196-228`; `docs/plugins.md:402-418` |

### B4 Settings: how a switch is declared, stored, read and switched mid-session

| Fact | Where |
|---|---|
| Setting types are exactly `'number' \| 'string' \| 'boolean'` — **there is no enum type**. A tier switch is a `string` setting with a documented closed set and a **named fallback** for anything else (the compactor's `mode` is the precedent, including "any value other than these behaves as X, and the value actually used is reported in the pass diagnostic") | `src/types/index.ts:3703`, `:3705-3716`; `src/plugins/context-compaction.plugin.ts` `mode` descriptor |
| `api.settings.boolean/number/string(key, fallback)` **coerce** — a corrupt stored value falls back to the declared default, so a read can never hand a plugin `NaN` or the string `"false"`; `api.settings` is **live per call**, read per turn | `src/types/index.ts:3797-3810`; `src/plugin/settings.ts` `resolve`, and `src/server/plugins.ts:8-15` ("changes what an EXISTING session reads on its very next turn") |
| `enabled` is a **framework-reserved** key: every plugin answers to it whether or not it declares one, it gates **hook delivery** (registered with a live `enabled()` predicate), and a plugin that declares its own descriptor (`context-compaction`, `context-trimmer`) makes the framework gate and the Rule-0 read **one value with one write path** | `src/server/plugins.ts:29-49`; `src/plugin/host.ts:151`; `src/plugins/context-trimmer.plugin.ts:118-127` |
| Validation is at the **write edge** (`min`/`max` and the declared type are enforced, the value is normalised to the declared type), coercion at the **read edge**. Consequence for this entry: a `string` tier setting accepts **any string** at the PATCH edge, so the plugin owns the closed-set check and must say which value it fell back to | `src/server/plugins.ts:51-60`; `src/plugin/settings.ts` `setOwnValue`; `src/server/plugins.ts` `checkValue` |
| Storage is **process-wide**, durable in `<databaseRoot>/harness/state.json`, minimal-delta (only what an operator changed), seeded from the generated manifest, handed to every harness as **one live provider object** | `src/server/plugins.ts:1-30`, `:19-27` |
| `api.settings.setOwn` is the only write a plugin has, the shipped server's provider is **read-only**, and a library default provider persists nothing — so a plugin that tried to persist its own policy decision is host-dependent | `src/types/index.ts:3811-3831` |
| New descriptors reach the UI and the API **automatically**: the descriptor object is imported into the manifest, `GET /plugins` publishes it, `values(plugin)` is declared-default-plus-override resolved through the same view a plugin reads | `src/plugin/manifest.ts:12-16`, `:33-41`; `src/server/plugins.ts:19-27`, `src/server/api.ts:2239` (`GET /plugins`) |

### B5 Persistence, lanes, forks — what a new per-entry field would cost

If the thoughts switch is implemented as a **flag** (recommended, T6 option A) rather than as a
text edit, then a per-message field is being added, and these are the four lists that must learn
about it or the transcript stops restoring:

| Fact | Where |
|---|---|
| Snapshot whitelist is **per role**: the assistant record allows `['role','content','toolCalls','reasoning','included','messageId']` | `src/core/snapshot.ts:398-400`, read-back `:412-416` |
| Branch history copy has the same whitelist and its own type checks | `src/core/branch.ts:575`, `:589-593` |
| `withIncluded` is the single normalisation point that decides which keys reach a projection copy and a branch record | `src/core/agent.ts:194-208` (and the sibling rule at `:211-213`) |
| The stage's stated persistence rule is "**no new message field is introduced** … a future per-message field would have to be added to every one of those lists or the flagged/edited transcript would stop restoring" | `src/types/index.ts:4201-4206` |
| The assistant commit is the third canonical creation point; it stores `reasoning` **only when non-empty**, and the comment states the current posture: kept for replay/UI, never sent back | `src/core/agent.ts:806` (result payload), `:825-833` (the pushed entry), comment `:814-816` |
| `reasoning?: string` exists on the assistant variant only | `src/types/index.ts:199` |
| Under `threadExecution: 'worker'` an **in-place** change to an already-committed message (a flag or text) is pushed as one `transcript:patch` over the committed prefix, compare-and-set against the digest the lane adopted; if canonical rewrote the prefix first the patch is **refused whole** and the policy re-derives on the next `turn.before` | `src/types/index.ts:4111-4130`, `:4192-4199`; `src/server/workers/lane-commit.ts` (pipeline T4.1) |

### B6 What the estimator and the wire actually do with thinking

| Fact | Where |
|---|---|
| **`reasoning` is never counted** by the context estimator: "It is retained for replay … and is not resent to the provider." So every savings figure a plugin computes with `estimatedTokens`/`currentEstimatedTokens` is **blind to thinking** | `src/core/context-estimate.ts:34-35`; counted list at `:21-33`; hybrid anchor `:41-56` |
| The wire assistant entry is `role` + `content` (+ `tool_calls`); **`reasoning` is dropped**, with the stated reason: "it is local replay data and several providers reject unknown message fields" | `src/transport/openai.ts:295-313` (comment at `:311-312`) |
| Thinking is **read** from deltas under both spellings (`delta.reasoning_content ?? delta.reasoning`) and surfaced as a `reasoning` stream event | `src/transport/openai.ts:830-834` |
| `tools` is sent whenever the tool list is non-empty — always, for a tool-calling agent — which is exactly DeepSeek's condition for demanding `reasoning_content` be passed back (Part E, E2) | `src/transport/openai.ts:781` |
| The request body is `{model, stream, messages, tools, ...samplingBody(sampling)}`, and `samplingBody` forwards **numeric values only**. Therefore `reasoning_effort`, `thinking`, `thinking.keep`, `clear_thinking`, `chat_template_kwargs.preserve_thinking` and `stream_options` **cannot be sent at all** | `src/transport/openai.ts:620-628`, `:768-786` |
| The projector mints every `reasoning` block with a **static per-kind** `inPrompt: false`, with a comment stating that thinking is "the one segment class that is not prompt text" | `src/server/turn-projector.ts:2141-2157` (`inPrompt: false` at `:2154`); every other kind gets `true` (`:1520`, `:1542`, `:1611`, `:2108`, `:2245`, `:2362`, `:2419`, `:2532`) |
| `ContextBlock.included` is a **deliberately separate, tri-state** axis from `inPrompt`, published only by the block-detail route (the one read that holds both the recorded event and the live transcript); ABSENT means "this server could not name the entry behind the segment" | `src/shared/turn-display.ts:536-565` |
| The join can only name a **tool** segment's entry: `blockCallIdOf` returns `undefined` for every non-`tool` kind, so a reasoning block's `included` is always ABSENT and the chip falls back to the static verdict | `src/server/api.ts:785-803`; the chip's three-way reading `src/frontend/ui/context-detail.ts:275-291` (`inclusionFactOf`) |

---

## Part C — Findings

### F1 — `enabled` conflates "this plugin exists" with "this policy runs"

One boolean switches off the only policy the plugin has. Once there are two independent
policies — superseded tool units and old thinking — an operator who wants one and not the other
has no lever, and the framework's reserved `enabled` gate (B4) means a plugin-level off and a
policy-level off are the same click. Today's single setting is therefore not a shape to extend,
it is a shape to split. Note the trap: `enabled` stays **reserved and framework-owned**
(B4), so the master switch must keep the key `enabled` (a plugin that declares it gets one value
and one write path) and the *policies* must be separate keys that do not collide with it
(`src/plugins/context-trimmer.plugin.ts:118-127`, `src/server/plugins.ts:29-49`).

### F2 — The rule's granularity is right, but "invalid" is defined narrower than the ask

The shipped predicate only ever sees a unit that is **all-`failed`/`rejected` and fully
answered** (`src/plugins/context-trimmer.plugin.ts` header `:24-26`; classification
`src/core/context-pruning.ts:102-116`). Three real shapes are therefore keeps, and at least two
of them are exactly "an invalid tool call that a later call answered":

- **a duplicate successful call** — the model re-reads the same file with the same arguments
  because it lost track; the earlier unit is `answered`, so it is never a candidate. This is the
  single largest "redundant content" class in the trajectory-reduction literature (Part E, E4);
- **a mixed block** — one healthy answer and one failure in the same assistant block, class
  `mixed`, never touched. Correct for pairing (the unit is atomic) and worth keeping, but it
  must be a **documented** keep, not an accident;
- **a `cancelled` answer** — deliberately a keep **today and by default** (the agent *chose* to
  stop; `src/core/context-pruning.ts:16-19`). The uplift keeps that as the default and makes it an
  explicit opt-in on `invalidOutcomes` — an operator who wants it pays for it in the setting text,
  not in a code change;

Also note the asymmetry the ask's wording implies and the code does not: the current rule
requires **every** name a block called to have a later answer (`:268-285`), which is right for
pairing (half a unit leaving is worse than the whole unit staying) and must not be relaxed — but
it means a block that called `A` and `B`, where only `A` was retried successfully, stays whole.
Say that out loud in the setting text.

### F3 — "Dropping old thoughts" has **no write target** in the shipped surface

This is the central technical finding, and it is why the thoughts switch is not a two-line
addition.

- `reasoning` is committed on the canonical assistant entry (`src/core/agent.ts:825-833`) and is
  editable (`src/harness.ts:8810-8812`) — so a plugin **can** reach it;
- but the transport **never sends it** (`src/transport/openai.ts:311-312`), so withholding it
  changes **nothing** about the request;
- and the estimator **never counts it** (`src/core/context-estimate.ts:34-35`), so withholding it
  registers as **zero saved tokens** in `currentEstimatedTokens()` and in every diagnostics
  figure built on it.

So "drop old thoughts" is currently a no-op dressed as a switch. It becomes real only when
*something* would otherwise put thinking into the request, i.e. when the transport replays it
(T8, gated on issue 0001 for the parameter half but not for the echo half — see F6). Until then
the switch has exactly one honest implementation: **it decides which recorded thinking stays
eligible for replay, and it says so in the diagnostic** — the flag is written now, the wire
honours it later. Everything else (T6) is the mechanism question.

The two candidate mechanisms, with their costs, in T6. The short version:

| | A — a per-entry **flag** (recommended) | B — `edit(entry, {reasoning: ''})` |
|---|---|---|
| Reversible by the reader / operator | yes — the same control switches back, mirroring `included` | **no** — the text is gone from canonical history |
| Matches the shipped philosophy ("nothing is deleted, it can be switched back on") | yes (`src/plugins/context-trimmer.plugin.ts:9-13`) | no |
| New message field | **yes** → B5's four whitelists + `withIncluded` + swagger + projector | no (`reasoning` is already whitelisted, `src/core/snapshot.ts:398-400`) |
| Persistence churn | one flag per old assistant entry, first pass only | one **text** write per entry, first pass only — same notification class, so the same cost (`src/types/index.ts:4111-4119`) |
| UI consequence | the thinking chip becomes a real control (T6) | the transcript loses the thinking text the user was reading |

### F4 — The economy knobs the trimmer explicitly declined, and the reason they now matter

`src/plugins/context-trimmer.plugin.ts:37-48` argues for **no floor, no horizon, no cooldown**:
one flag write per superseded unit, idempotent, and the removed units "ARE the pure-noise ones".
That argument was written when compaction existed alongside as the guarded, expensive pass. Once
the trimmer is **the only** trimmer (the ask), the same argument has two soft spots worth
naming rather than re-litigating:

1. **first pass over an old conversation** — the trimmer has no per-pass cap, so a
   conversation restored from weeks ago loses every superseded unit in one turn, and the
   provider's cached prefix diverges at the oldest trimmed position. Compaction's T4.3 solved
   precisely this with `maxUnits` (`src/core/context-pruning.ts:160-162`) and its descriptor at
   `src/plugins/context-compaction.plugin.ts` `safetyTurns`/`minTokens`;
2. **the cache cost is no longer amortised** by compaction's floor — compaction's own text says
   "a 40-token prune is a provider prompt-cache invalidation for nothing"
   (`src/plugins/context-compaction.plugin.ts` `minTokens`). Trimming on **every** turn with no
   floor is the shape most likely to reproduce that.

T3 adds the knobs with defaults that preserve today's behaviour exactly (all-off / zero), so the
uplift is behaviour-neutral by default and the knobs are opt-in.

### F5 — Settings are process-wide and live; a mid-session flip is one `PATCH` away, and it is a cache event

`src/server/plugins.ts:8-15` — a `PATCH /v1/harness/plugins/{plugin_id}` "changes what an
EXISTING session reads on its very next turn". Combined with the projection rule that a
withheld unit is skipped (Part A), a switch flipped mid-conversation **moves the point where the
provider's cached prefix diverges**: the request that used to contain the trimmed unit stops
containing it, everything from that position is recomputed, and switching the policy back
re-diverges it in the other direction. The shipped trimmer is nearly immune because its rule is
*deterministic and monotone* (a unit that qualified yesterday qualifies forever, and only
`false` is ever written), so no write in steady state ever *adds* content back. That property
is load-bearing, and it is F7.

### F6 — The provider half of the thoughts switch is unreachable today

Nothing in the shipped surface can tell a provider what to do with historical thinking:
`samplingBody` forwards numeric values only (`src/transport/openai.ts:620-628`), so
`thinking: {type:'enabled'}`, `thinking.keep`, `clear_thinking`,
`chat_template_kwargs: {preserve_thinking:true}` and `reasoning_effort: 'high'` are all dropped
silently. There is no capability flag equivalent to OpenCode's
`interleaved: {field: 'reasoning_content'}` either. Issue 0001
([../issues/blocking-provider-request-body-extension.md](../issues/blocking-provider-request-body-extension.md))
owns the request-body extension point; issue 0001's own text says the only escape is a full
custom `HarnessStream`.

Consequence for this entry: **the echo half** of the thoughts policy (putting current-turn
thinking back on the assistant entry) needs only `wireMessage` plus a per-entry flag, and is in
scope as T8; **the parameter half** (telling the provider to keep/ignore old thinking) waits for
issue 0001, and T8 must not silently grow it.

### F7 — Monotonicity is an assumption another plugin already relies on

`src/plugins/context-compaction.plugin.ts:196-205` states, as the reason no phase check is
needed between the two passes, that the trimmer's writer "writes ONLY `included: false` flags
… no `setTranscript`, no `replaceHistory`, **nothing that re-ENABLES an entry**". If a new
switch restores anything (an "off" that un-flags what an earlier "on" withheld, or a thoughts
flag that flips back to `true`), that compatibility argument has to be re-checked, and T9 owns
that re-check. Recommend: **every switch is withhold-only within a session**; an operator
"off" stops *new* writes and never undoes old ones; state that in each setting's text so the
behaviour is not discovered.

### F8 — The `inPrompt` chip states a universal where the truth is per-policy, per-position, per-model

`inPrompt: false` is minted per **kind** (`src/server/turn-projector.ts:2154`) and the chip falls
back to it whenever the server cannot name an entry
(`src/server/api.ts:785-803` → `included` is ABSENT for every non-tool kind →
`src/frontend/ui/context-detail.ts:275-291` renders "not replayed into the prompt"). Once a
policy decides *which* thinking is replayed, that sentence stops being a property of the segment
class and becomes a property of a decision. The contract in
`src/shared/turn-display.ts:536-565` already separates the two axes and says `inPrompt` is "the
projector's static per-kind verdict"; the uplift either keeps that sentence honest by making it
policy-aware (T6) or must keep the chip's wording honest while `inPrompt` stays static. Doing
neither makes the UI state a falsehood. T6 is small but must not be skipped.

---

## Part D — The switch specification

Names follow the package's existing camelCase convention (`contextLimit`, `modelLimits`,
`minTokens`, `safetyTurns`, `mode` — `src/plugins/context-compaction.plugin.ts` settings
block). Every `string` tier must state its closed set **and** the value an unrecognised string
behaves as, **and** report the value actually used in the pass diagnostic (precedent: compaction's
`mode`). Every default below is chosen to leave today's request byte-for-byte unchanged except
where a row says otherwise.

### D1 Required switches (the ask, literally)

| key | type | default | semantics |
|---|---|---|---|
| `enabled` | boolean | `true` | **Unchanged key, unchanged role** (B4: reserved, framework-gated, one value with one write path). It turns the plugin's hook delivery off; each policy below then decides nothing, and previously-written flags are **not** undone (F7). Declaring it here is deliberate, exactly as compaction does |
| `dropSupersededToolCalls` | boolean | `true` | **The shipped rule, verbatim**: a unit whose every committed result is `failed`/`rejected`, fully answered, and where **every** tool name it called has a later `completed` answer **in a still-included unit**, stops being sent — as a whole unit. Flipping it off stops new writes and restores nothing (F7). `false` + everything else off == the engine's pure "everything in" posture |
| `dropInvalidToolCallsOnceAnswered` | boolean | `true` | The same rule **generalised over what counts as invalid** (F2), and it is the switch the ask names. It is expressed as the outcome set a unit may be withheld for, so it does not need three booleans: see `invalidOutcomes` below. `true` is today's behaviour (`failed`/`rejected`); `false` restricts the generalisation to nothing and leaves `dropSupersededToolCalls` as the only tool policy. The two booleans must be **independent**: with both off, no tool unit is ever withheld |
| `invalidOutcomes` | string | `"failed,rejected"` | The closed set the generalisation may act on, comma-separated, chosen from `failed` \| `rejected` \| `cancelled` \| `empty`. `failed`/`rejected` = today. `cancelled` opts into withholding a unit the agent abandoned — **opt-in only**, because the package rule is that a healthy control outcome is not garbage (`src/core/context-pruning.ts:16-19`). `empty` opts into treating a `completed` result whose text is empty/whitespace as invalid — **dangerous and opt-in**, because a legitimately empty answer (`grep` with no matches, a zero-hit search) is indistinguishable from a stub, and trimming it removes the one fact that proves the agent already looked. Unknown names are dropped, an empty resulting set disables the generalisation, and the set actually used is in the diagnostic. **Not every value maps onto the shipped unit classifier** — only `failed`/`rejected` read as `kind === 'candidate'`; `cancelled` and `empty` reach units classified `mixed`/`answered` and need their own predicate over `unit.outcomes` (T4 states the mapping). Never accept `completed` here without `dropDuplicateCalls` |
| `dropOldThoughts` | string | `"turn"` | **The thoughts switch.** Closed set `off` \| `turn` \| `all`:\n• `off` — no thinking is ever withheld; every recorded thought stays eligible for replay (the engine's posture, and the right value for a backend whose template concatenates historical thinking — Part E, E3);\n• `turn` — **the recommended default and the industry convergence** (Part E, E2/E3): the thinking of the **open turn** — every committed assistant entry after the last `user` entry — stays eligible; thinking of every **closed** turn is withheld. Bounded, satisfies every strict provider contract in E2, and the cache divergence point is pinned one turn back forever (E5);\n• `all` — every committed thinking is withheld, including the open turn's. Only sane when the transport replays nothing (today's transport, F3) or when the operator is paying for window, not for continuity; it costs the current-turn continuity that every measured failure mode attributes the damage to (E6).\nAny other string behaves as `turn` and says so |
| `thoughtKeepUnits` | number | `0` | How many **older** assistant units, counted from the end of the transcript, additionally keep their thinking — the `recent-N` tier, for the backends Part E, E3 names (local Qwen/GLM/Kimi, DeepSeek-with-tools, Claude keep-all generations). **Every value above 0 is documented as cache-hostile**: a sliding window walks the divergence point backwards through history on every eviction, which is strictly worse than `0` on both axes (E5). Bounds: `min: 0`, `max: 32`, `step: 1` (enforced at the write edge, B4) |

### D2 Recommended economy and strictness knobs (defaults preserve today's behaviour)

| key | type | default | semantics |
|---|---|---|---|
| `supersedeMatch` | string | `"name"` | Closed set `name` \| `fingerprint`. `name` is the shipped loosening (`src/plugins/context-trimmer.plugin.ts:15-35`); `fingerprint` is compaction's exact rule via `toolCallFingerprint` (`src/core/argument-fingerprint.ts:171`), which makes the two passes agree by construction instead of by comment. Unknown → `name`. Recommend shipping `name` as the default so the uplift is behaviour-neutral, and documenting `fingerprint` as the value that makes compaction's failure-retry pass redundant (T9) |
| `dropDuplicateCalls` | boolean | `false` | Withhold an **earlier** unit when a later, still-included unit re-ran the **same work** — matched by `toolCallFingerprint(name, arguments)`, never by name alone — and produced only `completed` answers, regardless of the earlier unit's outcome. This is F2's largest class and needs the strict fingerprint match precisely because it can reach an `answered` unit. Off by default: it is the one switch here that can withhold work the model actually used |
| `minTokens` | number | `0` | A pass must withhold at least this many **estimated** tokens of **tool-unit** text or it writes nothing at all (no flag, no notification, no save). Default `0` = today. Applies to tool writes only, and that scoping is not a detail: the estimator never counts `reasoning` (B6), so a floor shared with the thoughts writes would **silently disable** the thoughts switch whenever the floor is above zero |
| `minThoughtChars` | number | `0` | The thoughts twin, measured in **characters of withheld thinking** (the only measure the estimator offers for text it does not count, `src/core/context-estimate.ts:21-35`). Default `0`. A future task may make the estimator thinking-aware; until then do not convert this number to tokens |
| `safetyUnits` | number | `0` | Units at the **end** of the transcript no tool trim may touch, counted like compaction's `safetyTurns` (units, not the per-run `iteration`). Default `0` preserves today's "the pair the model just replaced is exactly the pair that is safe to drop next request" argument (`src/plugins/context-trimmer.plugin.ts:44-48`); `> 0` is the operator's answer to F4's cache point 2. `0` removes the horizon |
| `maxUnits` | number | `0` | Cap on how many tool units **one** pass may withhold; `0` = unbounded (today). F4's point 1 — a first pass over a restored conversation. Oldest-first order is already the cache-friendly one (`src/plugins/context-trimmer.plugin.ts:231-233`, `src/core/context-pruning.ts:29-31`) |

### D3 Explicit non-switches — write these into the settings text, do not add booleans

- **`completed` is never invalid** on its own; only `dropDuplicateCalls` can withhold a healthy
  unit, and only on a fingerprint match (F2).
- **An unanswered unit is never touched.** `kind === 'unanswered'` covers an in-flight
  background call and a never-answered host block (`src/core/context-pruning.ts:19-21`), and a
  pending call is materialised as a placeholder rather than dropped anyway (Part A).
- **Half a unit never leaves.** Provider pairing is unit-atomic
  (`src/harness.ts:6576-6612`) and the `edit` surface refuses a `toolCalls` patch
  (`src/types/index.ts:4162-4179`), so per-call elision is not expressible; keep it that way.
- **A branch round is never trimmed** and no setting is even read on one
  (`src/plugins/context-trimmer.plugin.ts:311-316`, `:50-58`).
- **An internal agent's transcript is never trimmed** (`isInternalAgent`, reused from
  `src/plugins/context-compaction.plugin.ts`) — the summariser must keep the failures it was
  handed to explain.
- **A resolver that is itself withheld is not evidence** — trimming on the strength of an answer
  the model cannot see drops both halves (`src/plugins/context-trimmer.plugin.ts:200-203`).
- **Order of the two passes is not a knob.** Compaction is dispatched first
  (B3) and the compactor's compatibility argument depends on the trimmer being withhold-only
  (F7); if a switch makes that false, T9 re-checks it rather than adding a priority.

### D4 Diagnostics and observability (not optional)

One `api.report.diagnostic` per pass, one line per decision, self-contained text plus structured
`data` — the shipped shape (`src/plugins/context-trimmer.plugin.ts:357-386`) and the shape the
framework already journals durably, projects as `plugin_diagnostics` and types in the client
contract (see the substrate table in
[2026-11-09-context-inclusion-followups.md](./2026-11-09-context-inclusion-followups.md):
`src/server/sessions.ts:3008-3028`, `src/server/api-reads.ts:241-243`,
`src/shared/harness-api.ts:961`). Requirements:

1. the message names **which switch** fired, and for a tier, **the value actually used** after
   normalisation (compaction's `mode` precedent);
2. tool-unit lines keep naming **what answered** (`supersededBy`) — already the rule;
3. thought lines name the entry, the turn it belongs to, the character count withheld, and the
   policy in force;
4. with every policy off, the plugin writes **no** diagnostic and touches no transcript — the
   zero-cost fast path the shipped test pins
   (`src/plugin/context-trimmer.test.ts:713-728`, `:685-711`);
5. a pass that writes nothing writes nothing at all — no flag, no notification, no save, no
   diagnostic (idempotence; `src/plugins/context-trimmer.plugin.ts:41-44`, pinned at
   `src/plugin/context-trimmer.test.ts:631-643`).

---

## Part E — Why these tiers, and what the evidence says

**External evidence.** Nothing in this part is reproducible from this repository; it comes from
the vendor pass and the preprints listed in the References, gathered 2026-11-10. It is the
reasoning behind D1's defaults, recorded so the next agent does not re-derive it — and marked so
it is never mistaken for a package test.

### E1 The question that actually decides the defaults

Not "is thinking useful" but **"which thinking, at which position, for which model, at what
wall-clock and step cost"**. The two poles the ask implies — keep everything in place, or omit
completely — are both dominated by the middle: *replay the current turn's thinking verbatim in
place; withhold every closed turn's.*

### E2 Every major provider constrains the same line

| Provider | Inside the current turn's tool loop | Across user turns |
|---|---|---|
| Anthropic | **Required** — thinking blocks must come back with the tool results, complete and unmodified, or `400 … Expected thinking or redacted_thinking` | "Required within a tool-use turn, recommended across turns, allowed to omit outside tool use"; Opus 4.5+/4.6+/5-family **keep** prior thinking and bill it as input; older generations the API strips it whether or not you send it |
| DeepSeek (thinking mode) | **Hard** — with `tools` present, `reasoning_content` must be passed back or the API returns `400 The reasoning_content in the thinking mode must be passed back to the API.` | Without `tools`: "does not need to be passed back; even if passed, it will be ignored" |
| Kimi / Moonshot | **Hard** — `400 … reasoning_content is missing in assistant tool call message at index N` | Opt-in `thinking.keep: null` (default, drop) vs `"all"`; `kimi-k2.7-code` always thinks and cannot be turned off |
| GLM / Z.ai | **Required** — preserve reasoning and return it with the tool results, including reasoning produced *after* tool results | `clear_thinking: true` default; `false` recommended for **coding agents** for continuity *and* cache hits |
| Qwen / llama.cpp / vLLM | Template keeps think blocks inside the active tool chain | Template **strips** historical thinking unless `preserve_thinking: true`; llama.cpp's `--reasoning-preserve` is **default-on**; vLLM's own interleaved sample appends `reasoning` back onto the tool-call message |
| Gemini 3 | **Hard**, and by *signature*: the first `functionCall` part of every step of the **current** turn must carry `thought_signature`, else `400` — enforced even at `MINIMAL` | "Must return signatures in subsequent requests"; 3.5-Flash+ preserve thoughts by default; partial context "can degrade model performance" |
| OpenAI (Responses) | Reasoning items must come back with the function calls so the model can continue after a tool call | `reasoning.context: current_turn` (default pre-5.6) vs `all_turns` (5.6-family default); a *prefix edit* drops reasoning items → "may have to redo some reasoning … output quality may also drop" |

`src/transport/openai.ts:781` always sends `tools`, so the harness sits on DeepSeek's/Kimi's
strict branch of that table the moment the model thinks by default (Kimi K2.7-class, gateways
pinning DeepSeek/Claude). `dropOldThoughts: "turn"` is the **only** tier that satisfies every row
of E2 at once; `"all"` breaks the current-turn half, `"off"` is the only tier that satisfies the
"concatenates old reasoning" backends without a cache break.

### E3 The cache argument (this is what F5 and `thoughtKeepUnits` encode)

Under strict `turn` scoping the divergence point is **pinned one turn back forever**: turns that
ended long ago were thinking-free in every request since, so they were never part of the cached
prefix; you recompute roughly one turn per user turn. A **sliding K-turn window** is strictly
worse on both axes — every eviction walks the divergence point backwards through previously-stable
history. Measured in the wild: opencode #19081, cache diverging exactly at a stripped `think`
boundary, **18,993 tokens reprocessed where ~46 sufficed**; llama.cpp discussion #29472, an SWA
server that "can't roll back to that exact spot, so it falls back to an older checkpoint". On
hosted APIs the one-turn recompute is cents; on self-hosted it is wall-clock — which is exactly
why Qwen/GLM/Kimi ship preserve flags and llama.cpp defaults to preserving. Hence: `turn` as the
default, `off`/`thoughtKeepUnits > 0` as the documented escape for concatenating backends.
Two cost notes: Anthropic's server-side `clear_thinking_20251015` counts the tokens **before**
applying the edit, so server-side scoping buys window, not money; and on Anthropic strip-models a
client-side drop is cache-neutral, because the API strips it either way.

### E4 Effectiveness, measured as the ask frames it (completion time + accuracy)

- **Causal**: *Why Pay for Long Reasoning When Rewrite Do Trick?* (arXiv 2611.03852) rewrote a
  model's own **prior** reasoning into compact records, verified field-by-field that only
  reasoning differed, and measured the continuation: extended verification (≥350 reasoning
  tokens) on the submission turn fell **61.1 % → 0 %**, median final-turn reasoning **489 → 12
  tokens**, mean reasoning per response **−31.1 %**, savings growing with depth (8.8 % at turn 1 →
  56.1 % at turn 3). The honest counter: paying **a model call** to do the shortening inverted the
  result (DeepSeek self-compaction **−41.5 % target-only → +78.3 % inclusive** wall time; only 2
  of 8 arms reduced inclusive time). Authors decline a quality non-inferiority claim (≤3/50 tasks
  differ). Practical rule that follows: **drop, don't summarise; and if you summarise, summarise
  toward the decision**, which is what that paper's rewrite is instructed to preserve.
- **Trajectory reduction**: AgentDiet (arXiv 2509.23586) — input tokens **−39.9…59.7 %**, compute
  **−21.1…35.9 %**, Pass **−1.0…+2.0 pp**, and steps went **down**: instances hitting the 100-step
  limit **66 → 26**. Their `Step` metric is defined as the over-pruning detector, which is
  exactly the instrument H2 asks for.
- **Thought omission**: Agent-Omit (arXiv 2602.04284) measures each thought's contribution by
  Monte-Carlo rollouts and finds an average of **3–4 omissible turns per trajectory**, with the
  contribution varying by turn position.
- **Context pruning beats memory**: *Less Context, Better Agents* (arXiv 2606.10209) — full
  history **71.0 %** → last-five tool pairs **79.0 %** → pruned + summarised **91.6 %**; SWE-agent's
  ACI ablation — last-5 observations **18.0 %** vs full history **15.0 %**; MEM1 (arXiv 2506.15841)
  — discarding prior thoughts into one internal state scored **highest**.
- **The named harm of keeping it**: *Do LLMs Benefit from Their Own Words?* (arXiv 2602.24287) —
  quality largely preserved at **~8× less** context; models **rehash** prior output instead of
  answering, and "context pollution" propagates earlier errors across turns.
- **Where dropping costs you**: current-turn omission produces re-deciding and stubs — Hermes
  #122303 (Kimi K3 with reasoning stripped emitted `patch` calls as `{"path": ...}` at ~68
  completion tokens vs 1,550 reasoning tokens filling the schema correctly); *thin instead of
  absent* is worse than either extreme — Bifrost #5185 measured **2–3× wall-time and token
  inflation** from replaying summarised rather than full signed thinking, with no error.
  Command Code #754 (0/5 recall with fabricated "memories" vs 3/3 on DeepSeek direct) and oMLX
  #814 name the same confabulation.

### E5 The rule this entry ships, in one line

**Keep the open turn's thinking verbatim; for closed turns keep the decision, not the prose — at
zero extra model calls.** The decision content of an old turn already survives in `content` and
in the tool results (which is why dropping old CoT measures accuracy-neutral); the residue that
does not (scratch ids, paths, hypotheses worth revisiting) belongs in a durable note the **model
writes into `content`**, not in replayed CoT and not in a harness-side summary that spends a
request.

### E6 The tier table, ranked by measured time-and-accuracy outcome

| Policy | Time | Accuracy | Maps to |
|---|---|---|---|
| Open-turn verbatim, closed turns withheld, free client-side write | **best** — fewer steps, less future thinking | neutral to + | `dropOldThoughts: "turn"`, `thoughtKeepUnits: 0` |
| Same + one compact decision record per closed turn, produced free (model-written, not an extra call) | good | protects the scratch-state case | not built here (see "Deferred") |
| Keep all prose, model trained for it (local Qwen/GLM/Kimi, DeepSeek-with-tools, Claude keep-all, GPT-5.6 `all_turns`) | good, but only if append-only | neutral, sometimes + on decision consistency | `dropOldThoughts: "off"`, `thoughtKeepUnits` as needed |
| Keep all prose, model **not** trained for it | **worst** — quadratic prefill, longer generations, lost-in-middle | neutral to − | `off` on the wrong model |
| Withhold the open turn too | bad — retries, re-deciding, hard 400s on strict providers | − | `dropOldThoughts: "all"` |

---

## Part F — Invariants a switch must not break

1. **Pair-atomicity.** A tool unit is withheld whole, or not at all
   (`src/harness.ts:6576-6612`). The oracle: `wireIssues`/`pairIssues` stays empty (the same
   check `src/plugin/context-trimmer.test.ts:983-1072` already borrows from
   `src/harness.inclusion.test.ts`).
2. **Withhold-only within a session.** No switch may re-enable an entry an earlier turn withheld
   (F7), because the compactor's no-phase-check argument depends on it
   (`src/plugins/context-compaction.plugin.ts:196-205`).
3. **Idempotence.** A second pass over an unchanged transcript writes nothing, notifies nothing,
   saves nothing, reports nothing (`src/plugins/context-trimmer.plugin.ts:41-44`;
   `src/plugin/context-trimmer.test.ts:631-643`). This matters more, not less, once the plugin
   can write per-message text or flags.
4. **Determinism across restarts and lanes.** No in-process state; the decision is re-derived from
   canonical state (B1 `:70-75`). Under the worker lane an in-place write can be **refused whole**
   by the CAS and must simply re-derive next turn (B5) — a task must not "fix" that with a retry.
5. **Branch rounds and internal agents untouched; a disabled plugin costs one settings read and no
   transcript walk** (`src/plugins/context-trimmer.plugin.ts:318-324`, pinned at
   `src/plugin/context-trimmer.test.ts:644-711`). Keep the synchronous fast path exactly as
   written (`:430-439`) — more switches must not turn the common no-op turn into an `async` one.
6. **The engine's projection stays a pure skip filter** (Part A). A new thought flag may only ever
   *remove* an entry's thinking from a request; it may never reorder, reword or re-pair anything.
7. **Estimator honesty.** Any "tokens saved" figure must come from the same estimator the UI bar
   uses, and the thoughts numbers must be labelled as characters, because `reasoning` is not
   counted (B6, `src/core/context-estimate.ts:34-35`).
8. **UI truth.** The chip may state a verdict only where the server can name the entry; where it
   cannot, the wording must describe the **policy**, not a property of the segment class
   (`src/shared/turn-display.ts:536-565`, `src/server/api.ts:785-803`).

---

## Part G — Tasks

Phased; **each phase is independently shippable** and each task carries its own closing check.
Order matters in two places: **T3 before everything** (a switch that has no descriptor is not a
switch — `src/server/plugins.ts` validates writes against the descriptor), and **T6 before
T7/T8** (the mechanism must exist before the UI read and the wire honour exist).

### Phase A — pin the posture, split the switch

**T1 — Pin "the engine core trims nothing" as an executed contract.**
Today the claim is true by construction and by comment (`src/harness.ts:6548-6560`) but no test
states it. Add an assertion in the inclusion suite: with **no** plugin installed and **no** flag
anywhere, `projectTranscript` output equals the canonical transcript entry-for-entry (same length,
same order, same `content`, no `included` key), and nothing in `src/harness.ts` drops a recorded
entry outside `projectTranscript`. Close it by grepping the projection call sites so a future
second filter has to be named here.
*Check:* new test green in `npx vitest run src/harness.inclusion.test.ts`; the drift-check grep
for a second projection consumer returns the same set it does today.

**T2 — Decide and record the default posture, in one sentence, in three places.**
The ask's sentence ("the engine does not trim anything; the trimmer does") must appear as (a)
`metadata.description` of the plugin, (b) a paragraph in `docs/plugins.md` replacing the
"the trimmer's rule is a superset of compaction's" section at `:402-418`, and (c) one line here
recording what shipped. Do not change defaults without writing the reason into the setting text.
*Check:* `docs/plugins.md:402-418` no longer describes a one-switch trimmer; `npm run
plugins:manifest:check` green.

**T3 — Split `enabled` into the policy booleans/tiers of D1 + add D2's knobs.**
Add the descriptors (keep `enabled`'s key and default), add the matching fallbacks beside them
(the metadata must stay a plain literal, so every default is written **twice** and both move
together — `src/plugins/context-trimmer.plugin.ts:130-135`,
`scripts/plugin-manifest-scan.mjs:13-30`), read them **per turn** inside `planOf`/`guardPasses`
(`:311-324`), normalise every `string` tier through one helper that returns the **used** value,
and keep the whole read behind the branch/internal-agent guards so a disabled plugin still costs
one settings read. Regenerate the manifest.
*Check:* `node scripts/generate-plugin-manifest.mjs && npx vitest run src/plugin/manifest.test.ts
src/plugin/settings.test.ts` green; `src/plugin/context-trimmer.test.ts:832-860` updated from
"declares **one** setting" to the new closed set — assert the key list **exactly**, so a silent
new setting fails; `src/server/plugins.test.ts:440` (`values('context-trimmer')` equals exactly
`{ enabled: true }`) and `src/server/plugins-api.test.ts:463-470` (the row's key set) updated to
the new descriptor set; `npm run typecheck` green.

**T3b — Keep the settings surface honest at the write edge.** A `string` tier accepts any string
(B4), so: unknown → the documented fallback, named in the diagnostic; `min`/`max` published on
every `number` so the PATCH edge refuses nonsense before it reaches a turn
(`src/server/plugins.ts:51-60`).
*Check:* a `PATCH /v1/harness/plugins/context-trimmer` test per tier with a garbage value,
asserting a `2xx` (the write edge does not own the closed set) **and** a plugin-side diagnostic
naming the fallback; a bounds refusal test for one `number`.

### Phase B — the tool-call switches

**T4 — Generalise "invalid" without touching granularity.**
`invalidOutcomes` (D1) does **not** map cleanly onto the shipped classifier, and that is the
implementation detail to get right first:

- `failed` / `rejected` — reuse it. An all-`failed`/`rejected`, fully answered unit **is**
  `kind === 'candidate'` (`src/core/context-pruning.ts:102-105`), so the existing gate is
  exactly the right floor and nothing changes;
- `cancelled` — **cannot** reuse it. A `cancelled` answer puts the unit in `mixed`
  (`src/core/context-pruning.ts:111-112`), so opting in needs its own predicate over
  `unit.outcomes`, plus the same two guards the shipped rule demands: every call answered, and
  the answering unit still `included` (`src/plugins/context-trimmer.plugin.ts:200-203`).
  A unit **mixing** `cancelled` with a healthy answer stays a keep;
- `empty` — also **cannot** reuse it, because an empty-but-`completed` result is `answered`.
  Same predicate shape, over `member.message.content` (trimmed, empty/whitespace), and it must
  not fire on a `cancelled` result — an abandoned call has no content to judge.

Implement `dropDuplicateCalls` as a second, strictly-fingerprint-matched pass over `answered`
units (`src/core/argument-fingerprint.ts:171` — name **and** canonical arguments, never name
alone), and `supersedeMatch` as the single switch deciding which matcher the primary rule uses.
Whatever fires, the write is the **same** `setIncluded(leader, false)` and the report is the
**same** single diagnostic — one pass, one decision, one line per withheld unit
(`src/plugins/context-trimmer.plugin.ts:334-387`).
*Check:* plan-table cases in `src/plugin/context-trimmer.test.ts` per outcome value and per
matcher, each stating which switch makes it fire; a table case proving a `mixed` block (healthy +
failed) and an `unanswered` unit stay for **every** combination; a case proving `cancelled` is
kept while `empty` can fire, and vice versa; the pairing oracle green on a block with one
withheld and one kept call (`src/harness.inclusion.test.ts`, and the `toolCalls`-patch refusal at
`:2467` must still be a refusal).

**T5 — Add the economy knobs (`minTokens`, `minThoughtChars`, `safetyUnits`, `maxUnits`) with
zero-behaviour-change defaults.**
Reuse the shapes compaction already ships (`src/core/context-pruning.ts:156-165`
`PruneOptions`) rather than inventing new ones; the horizon counts **units from the end**, never
`iteration`. A floor that is not met writes **nothing** — no flag, no notification, no save
(compaction T4.1 precedent, `src/plugins/context-compaction.plugin.ts` `minTokens` descriptor).
*Check:* a test per knob at `0` proving byte-identical output to today, and one proving the knob
bites when raised; explicitly, one test proving a `minTokens > 0` does **not** suppress a
thoughts write (F3/B6 estimator blindness).

### Phase C — the thoughts switch

**T6 — Pick and land the mechanism, then make the flag mean something.** (F3, blocked-by-nothing;
this is the largest single task.)

- **Option A, recommended — a per-entry flag.** Add an inclusion axis for thinking on the
  assistant variant only, written by a new `turn.before` control alongside `setIncluded`
  (`src/types/index.ts:4098-4156` is the model to copy: entry/index/`messageId` targets, strict
  boolean check before any write, unit cascade **not** needed — thinking belongs to exactly one
  entry — `false` stored, `true` removes the key). Then: `withIncluded` (`src/core/agent.ts:194-208`)
  must strip it from projection copies like `included`; the snapshot and branch whitelists must
  list it (B5: `src/core/snapshot.ts:398-400`, `src/core/branch.ts:575`); the projection must
  carry it without breaking its "no flag key on a request" posture
  (`src/harness.ts:6561-6569` — decide and document whether the thought flag rides on the request
  object or is resolved out of it, and make `turn.before`'s `currentMessages()` agree);
  `harness.swagger.yaml` and the client contract must publish it; and the control's doc comment
  must state the storage rule the same way `setIncluded`'s does.
- **Option B — `edit(entry, {reasoning: ''})`.** Cheaper, no new field, and **destructive**:
  the transcript stops carrying the thinking a reader was shown, which contradicts "nothing is
  deleted … can be switched back on" (`src/plugins/context-trimmer.plugin.ts:9-13`). If this
  option wins, the setting text must say the write is irreversible, and the write must be
  guarded by `reasoning !== undefined && reasoning !== ''` so a re-run stays a no-op (invariant 3).

Either way, the **turn boundary** is derived the same way: the open turn is every committed entry
**after the last `user` entry** — not `iteration`, which counts model steps within a run and
cannot express the boundary (`src/types/index.ts:4048-4049`, and compaction's own note that a
per-run counter cannot express a conversation-level horizon,
`src/core/context-pruning.ts:26-29`). On `iteration === 1` every committed assistant entry is a
closed turn; from `iteration ≥ 2` the loop's own assistant entries are inside the open turn and
must keep their thinking. A mailbox/autoanswer user message legitimately moves the boundary —
say so.
*Check:* a unit table per tier (`off`/`turn`/`all`) × per position (open-turn entry vs closed-turn
entry) × per `thoughtKeepUnits`; a re-run test proving idempotence under the chosen mechanism; a
restart test proving the decision re-derives (no state); under `threadExecution: 'worker'`, the
existing CAS-refusal behaviour is unchanged (`src/types/index.ts:4111-4130`); a
snapshot→restore→continue test proving the flag survives (this is exactly the list B5 warns about).

**T7 — Make the UI and the projector tell the truth about thinking.** (F8)
Two allowed answers, one required: either publish a real verdict for a reasoning segment (the
detail join gains a thought-side analogue of `blockCallIdOf` — `src/server/api.ts:785-803` —
resolving the turn's assistant entry, so the chip becomes the same `<button aria-pressed>`
control it already is for a tool segment), or keep `included` absent and make `inPrompt` carry the
policy instead of the kind. The chip must never again say "not replayed into the prompt" as an
absolute while a tier says otherwise (`src/frontend/ui/context-detail.ts:275-291`,
`src/shared/turn-display.ts:536-565`, `src/server/turn-projector.ts:2141-2157`).
*Check:* a `src/server/view.test.ts` case publishing the verdict, and a
`src/frontend/ui/context-detail.test.ts` case rendering each of the three chip states; the
existing fingerprint-cache rule for block detail still invalidates on the new field.

**T8 — Let the transport honour the policy (the half that makes `turn` real).**
Emit `reasoning_content` (and, where the model needs the other spelling, `reasoning`) on an
assistant wire entry **only** when the entry's thinking is not withheld
(`src/transport/openai.ts:295-313`), i.e. current-turn thinking comes back, closed-turn thinking
does not. This is the echo half; it needs no request-body extension, so it is **not** blocked by
issue 0001. Two rules: (1) the field must be omitted, never sent as an empty string — a strict
provider reads `""` as a thinking block that is missing content; (2) the *parameter* half
(`reasoning_effort`, `thinking.keep`, `clear_thinking`, `chat_template_kwargs`) stays **out** and
keeps pointing at issue 0001 (F6).
*Check:* transport tests per shape — a first-step request, a tool-loop continuation carrying the
thinking that produced the pending call, a closed-turn entry carrying none — and the existing
reasoning read-side tests untouched (`src/transport/openai.ts:830-834`,
`src/transport/openai.test.ts`); a documented, explicitly **not-tested** note that no live
DeepSeek/Kimi/Anthropic round-trip was observed.

### Phase D — de-duplicate, then measure

**T9 — Resolve the compaction overlap deliberately, not by comment.**
`docs/plugins.md:402-418` records that the trimmer's rule is a superset of compaction's
failure-retry pruning, so compaction's prune only matters through its own floor/horizon/cooldown
gates. With the knobs of D2 landed, that paragraph has an answer available: run the
failure-retry pruning in **one** place (`supersedeMatch: 'fingerprint'` makes the trimmer equal
to compaction's rule; compaction keeps its summarise/checkpoint role). Decide, write the decision
here, and re-verify F7's assumption if anything restores.
*Check:* `docs/plugins.md:402-418` rewritten to the shipped posture;
`src/plugin/context-compaction.test.ts` and `src/server/persistence.test.ts:2495-2610` (which
switch the trimmer off via a fixture provider — the seam stays valid either way) green without
seeding unless the decision changed them; one new test asserting **exactly one** pass withholds a
given superseded unit.

**T10 — Measure, with the instrument the ask implies: steps and wall clock, not tokens.**
Run the same task set through at least three configurations — all policies off (the engine
posture), `dropOldThoughts: "turn"` (the proposed default), and `dropOldThoughts: "off"` — and
record per configuration: **tool calls / model turns to resolve** (the over-pruning signal —
more steps means something needed was removed, E4 AgentDiet), **wall time**, `usage.cached` ratio,
and pass diagnostics. `packages/underload/bench` already replays full histories and captures
`reasoning` separately from `content` (`packages/underload/bench/src/core/types.ts:30-46`,
`BenchGeneration.reasoning` at `:34-39`; the growing-context scenario in
`packages/underload/bench/src/dashboard/scenarios/`), which makes "does dropping old thinking
shorten the model's *next* thinking" directly measurable there. Write the numbers into a table in
this file; if no live provider was used, say so in the row.
*Check:* a results table added under a new "## Measurements" heading in this file, one row per
configuration, with the step count and the pass diagnostics; if the numbers are absent, the
heading exists and states why.

---

## Part H — Acceptance criteria

1. **Engine posture:** with the plugin's policies all off, a run's provider request contains
   every recorded entry, in canonical order, and no plugin-side write happens at all (T1).
2. **Switch independence:** each of `dropSupersededToolCalls`,
   `dropInvalidToolCallsOnceAnswered`/`invalidOutcomes`, `dropDuplicateCalls` and
   `dropOldThoughts` demonstrably changes the request while the others are off, and turning one
   off never silently turns another on (T3, T4, T6).
3. **Pairing:** `wireIssues`/`pairIssues` empty on every configuration, including a mixed block
   with one withheld unit adjacent to a kept one (invariant 1).
4. **Thoughts:** with `dropOldThoughts: "turn"`, the request carries the open turn's thinking and
   none of any closed turn's; with `"all"`, none; with `"off"`, all; unknown string → `turn`,
   reported as such (T6, T8).
5. **Reversibility and truth:** whatever mechanism T6 picks, the block-detail read and the chip
   state what is actually in the prompt for that segment, and the word "never" appears nowhere in
   the reasoning chip's wording (T7, F8).
6. **Economy:** at `minTokens: 0`, `safetyUnits: 0`, `maxUnits: 0`, `minThoughtChars: 0` the
   request is byte-identical to today's for the fixtures in
   `src/plugin/context-trimmer.test.ts` (T5).
7. **Everything green:** `npm run typecheck && npm run test && npm run test:frontend`
   (`package.json` scripts — `test` and `typecheck` both run the manifest checks first, so a
   metadata change that skips `npm run plugins:manifest` fails loudly).
8. **Measured, not asserted:** T10's table exists, with step counts, or the file says why not.

---

## Part I — Open decisions (answer these before writing code)

1. **Thought mechanism: flag (reversible, new per-message field) or text edit (cheap,
   destructive)?** Recommend the flag. The costs are enumerated in F3 and B5, and the deciding
   constraint is the package's own persistence rule at `src/types/index.ts:4201-4206`.
2. **Does the thought flag ride on the request object, or is it resolved out of it the way
   `included` is (`src/core/agent.ts:194-208`)?** `turn.before`'s `currentMessages()` must agree
   with whatever the transport sees; picking "resolved out" means the transport reads canonical
   state a second way, picking "rides along" means every custom `HarnessStream` sees a new key.
3. **Is `dropOldThoughts: "all"` allowed to withhold the open turn's thinking when the transport
   *does* replay (T8 landed)?** That combination is the one every measured failure mode blames
   (E4). Recommend: keep it available (a small-local-model operator may want the window) and put
   the cost in the setting text.
4. **Does `empty` as an invalid outcome default anywhere but off?** Recommend off, permanently,
   until a real-corpus count exists (F2, and the false-positive on a legitimate zero-hit result).
5. **Do we freeze the effective policy per conversation** so a mid-session `PATCH` cannot move the
   cache divergence point (F5, E3)? Settings are process-wide and live today
   (`src/server/plugins.ts:8-15`) and there is no per-session settings surface (Part "Out of
   scope"), so the honest answer is probably "document the cost, don't build the freeze" — but
   write that down rather than discover it.
6. **Does compaction stop doing failure-retry pruning once `supersedeMatch: 'fingerprint'` makes
   the two rules identical** (T9)? Decide with the paragraph, not with a comment.

## Deferred, recorded so nobody builds it by accident

- **A per-closed-turn decision record** (E5's "keep the decision, not the prose") — the model
  writing a durable note into `content` is a **prompt** concern, not a trimmer concern; and an
  LLM-side summariser is exactly what inverted the time saving in E4. If it lands, it lands as a
  separate plugin, not as a trimmer switch.
- **Estimator awareness of `reasoning`** (B6): if the estimator ever counts thinking, `minTokens`
  and `minThoughtChars` must be re-tuned together, and the UI context bar's number changes meaning
  (`src/core/context-estimate.ts:17-19`).
- **Provider-side scoping** (`thinking.keep`, `clear_thinking`, `preserve_thinking`,
  `reasoning_effort`) — issue 0001.
- **Per-session plugin settings** — do not assume they exist.

---

## Part J — Verify before starting (drift check)

```bash
cd packages/underload/harness
git rev-parse --show-toplevel              # must be .../packages/underload/harness
git log -1 --format='%h %s'; git status --short

# Part A: the engine still trims nothing of its own
grep -n "const projectTranscript" src/harness.ts                  # one definition
grep -rn "projectTranscript(" src/*.ts src/**/*.ts | grep -v test # every consumer, listed here

# B1: still one rule, one setting, no state
grep -n "settings: \[" -A 12 src/plugins/context-trimmer.plugin.ts
grep -n "planTrimmedUnits\|applyTrimPlan\|executeTrimming" src/plugins/context-trimmer.plugin.ts

# B4/F1: the reserved key and the write edge
sed -n '29,49p' src/server/plugins.ts
grep -n "context-trimmer" src/server/plugins.test.ts src/server/plugins-api.test.ts   # exact-match assertions to update

# B6/F3: thinking is wire-inert and estimate-inert — the two greps that decide T6's framing
grep -n "NEVER COUNTED" src/core/context-estimate.ts
sed -n '295,315p' src/transport/openai.ts
sed -n '620,628p' src/transport/openai.ts

# F7: the compatibility assumption any restoring write must re-check
sed -n '196,228p' src/plugins/context-compaction.plugin.ts

# B5: the whitelists a new per-entry field has to join
sed -n '396,402p' src/core/snapshot.ts
sed -n '573,595p' src/core/branch.ts

# F8: the wording that must stop being absolute
sed -n '2141,2158p' src/server/turn-projector.ts
sed -n '785,804p' src/server/api.ts
sed -n '275,292p' src/frontend/ui/context-detail.ts

# BASELINE green before any edit
npx vitest run src/plugin/context-trimmer.test.ts src/harness.inclusion.test.ts
```

Stop-and-recheck conditions:

1. **`projectTranscript` grows a second filter, or a second caller** — Part A is no longer a fact;
   re-derive the "engine trims nothing" claim before touching a switch.
2. **`reasoning` starts being counted by the estimator, or sent by the transport** — F3 changes,
   `minThoughtChars` becomes redundant, and T8 may already be done. Re-read F3 first.
3. **A per-session plugin settings surface lands** — open decision 5 stops being a documentation
   task and becomes a buildable one.
4. **A new `turn.before` plugin appears in `src/plugins/`** — the dispatch-order claim in B3 and
   the F7 assumption both need re-reading; registration order, not a priority, is what runs today.
5. **Issue 0001 closes** — T8's parameter half stops being out of scope; the tier then wants a
   per-model capability flag (`never | turn | recent-N`), which is the shape D1 already implies.

---

## Part K — Not tested / not assumed

- **No live provider was observed.** Every E2 contract row is vendor documentation as read
  2026-11-10, and E4's strongest quality numbers are harness maintainers' A/B reports rather than
  controlled ablations. The two independent papers (arXiv 2602.24287, arXiv 2606.10209) measure
  pruned tool history and prior *assistant text*, so they bound the cross-turn case, not the
  in-loop one.
- **Per-model generation drift is real and unmodelled here**: the "keeps historical thinking"
  behaviour differs within a vendor by generation (Claude pre-4.5 vs 4.5+/5-family, Kimi K2.6 vs
  K2.7-code, GPT pre-5.6 vs 5.6, Gemini 3 vs 3.5-Flash+). No capability flag exists in this
  package to express that (F6), so any tier is, today, a deployment-wide guess the operator made.
- **Whether one notification per write is slow** — the save model is a whole-document rewrite
  (`src/server/persistence.ts`), no profile exists, and the first pass over an old conversation is
  the worst case (F4). T6's flag writes make that worst case reachable more often.
- **Cost of a `turn.before` write under the worker lane's CAS** — documented as
  refuse-and-re-derive (`src/types/index.ts:4111-4130`); never measured.
- **Real-corpus effect of `dropDuplicateCalls`** — the class is well attested in the literature
  (E4) and the switch is off by default precisely because it is the one here that can withhold
  work the model actually used.

## References

Vendor contracts (external, read 2026-11-10): Anthropic *Thinking* / *Thinking in tool and
multi-turn workflows* / *Context windows*; DeepSeek *Thinking Mode* and *Tool Calls*; Kimi
*Thinking Models* / *Preserved Thinking*; Z.ai–SiliconFlow *Interleaved Thinking*; Gemini
*Thought Signatures*; OpenAI *Reasoning* / *Preserved reasoning* / *Conversation state*;
Qwen (`preserve_thinking`) and llama.cpp (`--reasoning-preserve`).

Harness reports (external): opencode #24104, #19081, #61754; llama.cpp #23722 and its discussion
29472; Command Code #754; oMLX #814; Bifrost #5185; Hermes #122303; LiteLLM #25322.

Preprints (external): arXiv 2611.03852 (causal reasoning-history compaction); arXiv 2509.23586
(AgentDiet, `Step` as the over-pruning signal); arXiv 2602.04284 (Agent-Omit); arXiv 2606.10209
(Less Context, Better Agents); arXiv 2602.24287 (own-words / context pollution); arXiv 2506.15841
(MEM1); arXiv 2511.20048 (speculation-based reasoning-skip).

Repo anchors worth re-reading first: `src/plugins/context-trimmer.plugin.ts` (the header is the
ratified reasoning for every guard), `src/core/context-pruning.ts` (unit mirror + the stricter
rule + `PruneOptions`), `src/plugins/context-compaction.plugin.ts:196-228` (the two passes'
interaction), `src/harness.ts:6548-6683` (the projection), `src/server/plugins.ts:1-60`
(the settings plane), `src/shared/turn-display.ts:536-565` (the two inclusion axes).

