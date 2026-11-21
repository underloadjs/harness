# @underload/harness Knowledge

Plugin-first CLI agent harness. `agent` is the brain, `tool` is an action, `harness` is the loop.

> **Last verified:** 2026-11-19 (composition) for TOOL-CALL COMPOSITION VISIBILITY and the four
> transport liveness fixes that came with it, documented from the code and from two live captures,
> not from a brief: the `progress` event kind (projection-only, counters-only, NEVER argument text —
> `HarnessProgressPhase` / `HarnessToolCallProgress`, `src/types/index.ts:468, 477`), the one
> tool-call de-multiplexing rule (`slotForFragment`, `src/transport/openai.ts:979`), the name-echo
> guard (`:1046`), the minted id for an anonymous call (`harness-call-<slot>`, `:1076, 1112`), the
> completeness rule that stops a complete tool block from being re-generated ten times
> (`completeToolRound`, `:2054`), the 500 ms throttle (`:1091`, monotonic, no new timer), the
> display field that mints no node and no context block (`TurnSection.toolProgress`,
> `src/shared/turn-display.ts:1154`; `src/server/turn-projector.ts:1926, 3393`), the journal-index
> shift it causes (ids derived from the event position move, exactly as a journaled `wakeup` moves
> them), and the timeout-boundary arithmetic (27 s and 62 s of silence are inside EVERY bound; only
> a tool block past the 120 s between-reads bound trips `provider-timeout` and its 4-attempt ladder
> — no default changed). The dated brief is
> `docs/tasks/2026-11-19-tool-call-composition-visibility.md`; what remains open is
> `docs/issues/minor-relay-gateway-silence-adds-no-per-request-provider-log.md` (0037) and
> `docs/issues/minor-long-tool-block-has-no-per-attempt-total-clock.md` (0038). The claims still
> being written by that pass — the exact frontend strings — are named where they live rather than
> quoted here. Before that, 2026-11-18 (ranks) for the RANK MODEL that replaced the
> `primary`/`subagent`/`subagents` vocabulary across this package's contract, documented from
> the code rather than from a brief. The premise of the redesign is that AUTHORITY IS A LADDER,
> NOT A SINGLETON: `AgentRank` is a 26-letter scale (`'A'` highest), any number of agents may
> hold Rank A, `entry` is a routing choice that grants no capability, and what an agent may DO
> is a function of its rank and nothing else. Recorded here from the enforcing code —
> `AgentRank`/`AGENT_RANKS`/`rankIndexOf`/`isLowerRank`/`isAgentRank` (`src/types/index.ts:1469,
> 1501, 1532, 1539, 1547`, value-re-exported at `src/harness.ts:17578` so a worker or server
> never re-spells letters), the `entry` + `ranks` pair with its two resolution rules, the
> resolved map on the handle (`harness.ranks`, a getter over a LIVE roster at
> `src/harness.ts:17230`; `harness.name` is the EFFECTIVE entry agent's name — the one `entry`
> names while it is registered, else the first still-registered member — at `:17191`), strictly-downward
> delegation with both refusal sentences and the distinct-rank NESTING CEILING that replaces the
> hard-coded "one level deep", the per-caller `delegate` declaration (`delegateDeclarationFor`),
> the RANK-FREE TOOL SURFACE (the `primaryOnly` declaration filter and launch gate are DELETED —
> `src/harness.ts` "THERE IS NO ROLE GATE HERE ANY MORE" — and what survives is the per-run
> `scope.tools` allowlist with its `toolRequest` exception, the conversation's withheld set, the
> deployment-wide tool disable, the enabled-tool cap, and the ONE optional rank ceiling
> `toolCreation`), threading as parallel work that NEVER consults rank, and the CLEAN BREAK:
> records renamed `role` → `rank`, snapshot version 3 refusing the old words, stored
> `primary`/`subagents` registry and session documents REFUSED on load, and the lane archive
> digest hashing `rank` so a pre-rank archive re-archives by design. The asymmetries were MEASURED
> with a `yarn vite-node` probe instead of assumed, and are stated in the body rather than smoothed
> over. ONE is live: `harness.toolCreate()` is the ungated HOST path (`src/harness.ts:16994` binds it
> to `createToolFrom`), so a `toolCreation` rank ceiling gates the MODEL door and the host DOOR —
> measured: `executeTool('toolCreate', …)` with a Rank B entry refuses with `Tool creation is limited
> to Rank A and above in this harness; "lead" holds Rank B.` — while the handle member never meets the
> ceiling. The OTHER one CLOSED with the clean break: a legacy `primary` key in a LIVE `harness({…})`
> config used to be silently IGNORED (`harness({ agents: { a, b }, primary: 'b' }).name` answered
> `'a'`), and the construction door now REFUSES it with the same words the persistence guard uses
> (`src/harness.ts:1467-1477`, measured), so a live config and a stored document fail identically.
> A THIRD split is deliberate and stays: the LIBRARY may detach the entry agent while the server
> refuses to (see [Delegation](#delegation)). The dated
> records under `docs/tasks/**` and `docs/issues/**`, the Rust port under
> `packages/typecrate/**`, and `distribution/chat-assistant` are OUT OF SCOPE for this pass and
> still speak the old vocabulary; then 2026-11-18 (knowledge) for the CROSS-SESSION knowledge base, which this
> pass documented from the code rather than from a brief: the three-layer split
> (`src/core/knowledge.ts` engine / `src/server/knowledge-file-store.ts` subscriber /
> `src/tools/runtime/knowledge.tool.ts` door), the six verbs with their EXACT result key sets,
> the engine-owned bounds and the six `EKNOWLEDGE_*` codes, the two-lane ranking and the
> `matchedIn` it reports, the optimistic `expects` CAS with the current article attached to a
> stale refusal, the 24576 / 8192 / 32768 budget ladder and why the inner cap stays under the
> outer one, the file layout with `HARNESS_KNOWLEDGE_VERSION = 1` gating reads and the ZERO
> default commit window, the ordered commit (articles → erasures → index LAST) and its
> sha256-plus-witness skip gate, the forced repair pass, and the wiring that keys the base by
> RESOLVED ROOT at `<databaseRoot>/harness/knowledge/` instead of folding it into a session —
> no snapshot field, no `reset()` touch, no `harness.dispose` hook. Every figure came from the
> file and line this section cites. The documentation pass found FOUR divergences between the
> published schema and the engine, and the next pass (T12, same day) verified each against source
> and FIXED the three real ones instead of only recording them: the `tag` filter's ceiling went
> 64 → 16 (`KNOWLEDGE_MAX_TAGS`, `readTags` `src/core/knowledge.ts:557-569`), the shared `limit`
> ceiling went 100 → 64 (the `read` window, `readWindowLimitArgument` `:496-507`, is the smallest
> bound one flat property can carry — see the rule below), and `expects` was confirmed at exactly
> 1 on the wire as the ONE deliberate tighter bound, because one call guards one article
> (`checkExpects`, `:2020-2036`). The two doc-level inaccuracies are gone from the interface too:
> the published description now says the rank-50 ceiling belongs to `search` ALONE
> (`checkSearchDepth` runs for `search` only, `:1927`, pinned by a test named "…and leaves list
> uncapped"), and it now says `remove.danglingRefs` is the WHOLE store's standing dangling set
> (`danglingAcrossStore`, `:1543-1548` → `:2375`), which the `KnowledgeRemoveResult` comment at
> `src/types/index.ts:2627-2633` now states the same way. The fourth finding — the store comparing
> its zero window to a `VIEW_CHECKPOINT_INTERVAL_MS` it believed was also 0 while the real figure
> is 2 s (`src/server/sessions.ts:523`) — resolved the OTHER way: the value stayed 0 on its OWN
> reasoning (`HARNESS_KNOWLEDGE_INTERVAL_MS`, `src/server/knowledge-file-store.ts:271-279`) and the
> COMMENTS were corrected to stop claiming inheritance (`:149-157`, `:271-278`). An independent
> review of that artifact (T15, same day) then closed six findings, and each closure is documented
> where it lives: the two factories the `harness()` validation refusal names are now ON THE PUBLISHED
> SURFACE the message points at (`loadKnowledgeFileStore` via `src/server/index.ts`,
> `createKnowledgeEngine` beside `createRecordEngine` in `src/harness.ts`); the staging owner keeps
> the pid (`knowledge.<pid>`, so a second process cannot collide on `state.json.knowledge.0.tmp`); a
> DISPOSED store refuses `commit()`/`flush()` instead of answering a zero-work success; the
> single-writer boundary is stated as the deployment constraint it is, with its consequence pinned by
> tests (two live stores over one root lose one edit with no signal, while a lost `index.json` row
> self-heals off the files); the `storeRev` comment no longer claims the file layer decides flushes
> from it; and the `setParagraphs` description says ABSENT means UNCHANGED. Two findings were
> confirmed rather than changed: the out-of-band duplicate-file abort stays fail-closed (its remedy
> is one `rm`, now written down), and an un-awaited background commit's failure still reaches nobody
> by default — the durable base can silently stop being durable, and the hook a host must wire
> (`report`, or `diagnostics()`) is named in "Not built yet". Pinned by the knowledge suites —
> `src/core/knowledge.test.ts` (80), `src/tools/runtime/knowledge.test.ts` (45),
> `src/server/knowledge-file-store.test.ts` (29), `src/harness.knowledge.test.ts` (9),
> `src/server/knowledge-session.test.ts` (6) and `src/server/harness-delete-knowledge.test.ts` (12)
> — 181 tests, all green on 2026-11-21 (T6 owner attribution + T11 pending-removal race and
> owner-length cases).
> Then 2026-11-17 (X2, the context-compaction correctness pass) for SIX behaviour
> fixes on the summarize path, each pinned where it is observable. THE FLOOR IS ONE CURRENCY:
> `measureRequestFloor` adds the projection's media term back onto the harness figure before
> subtracting (X1 subtracted a media-INCLUSIVE body from a media-FREE estimate), so an attachment
> replayed on every turn can no longer make the floor read ~1.5 M tokens low; the residual a dead
> run reports is the estimator's UPPER bound — on an anchored round it carries the
> `ANCHOR_GROWTH_MARGIN` premium — and NOT a catalogue measurement (44,597 measured on `Temp/d1`
> round 21 against ≈31,700 of real serialized catalogue plus system prompt). GIVE-UP IS KEYED ON
> PROGRESS, not on the rung counter: `overflowBest` holds the billed figure a shrink sequence last
> actually SENT, and a rung that cannot come back strictly smaller than it ends the ladder with
> `stage: 'no-progress'`, no park and no provider round trip (the measured failure was four rung
> targets — 41,399 / 34,093 / 24,352 / 17,046 — all resolving to one identical 206,159-token
> request). THE HEADROOM BUFFER NO LONGER REQUIRES A DECLARED WINDOW: a bare `contextLimit` is the
> operator's GUESS at that window and the summarize request (whole projection plus the 1,752-byte
> instruction) is scored against the model's REAL one, so the 15% / 16,000-floor / half-ceiling rule
> now comes off WHICHEVER ceiling BINDS, the dead-run guard compares a request against the REFUSAL
> point (`floor >= ceiling`) rather than the buffered firing point, and `headroomRatio: 0` is the
> documented opt-out — the declared-window rows of the table stay byte-identical (4096→2048,
> 8192→4096, 32768→16768, 128000→108800, 200000→170000). THE DEAD-RUN REPORT states the real cause
> and the levers (`contextLimit`, `modelLimits`, the tool set) instead of blaming the ladder, prints
> ONCE PER SIZE STEP (its latch re-arms on Rule 3's own 5% margin and `reported: true` marks the
> turn that printed), and the ServiceInfo / `tool_result_bytes` prose that called the cap
> window-scaled now says what it is — a FIXED byte count — regenerated into
> `src/shared/harness-api.ts` from `src/server/harness.swagger.yaml`. Plus the fourth door of the
> DOOR SHAPE rule below: a compaction note also used to cross the delegation door through the
> STREAMING lane (`isCompactionAnswerStream`, a position test on a content-free placeholder turn,
> makes an abort mid-summary fall through to `lastSubstantiveText`). Pinned in
> `src/plugin/context-compaction.test.ts`, `src/harness.delegation-context-relief.test.ts` and
> `scripts/generate-harness-contract.test.ts`; the two harness-level compaction fixtures
> (`src/harness.compaction-delegation.test.ts`, `src/harness.delegation-context-relief.test.ts`)
> seed `headroomRatio: 0` and say why, because their ceilings are hand-derived against the typed
> limit. Then 2026-11-17 for the roster-identity and interrupted-run-display
> documentation pass — the identity TRIPLE the host/UI roster row now publishes
> (`ThreadSummary.invocation_id` / `invocation_ids` / `epoch`, its emit rule, the two sources behind
> `invocation_ids`, the 64-id cap that keeps the OLDEST, the bare-id strip, and the key order), the
> fact that a `thread.upsert` frame carries the SAME keys because it is the same producer, the
> model-facing `threadList` page still STRIPPING the epoch while the host plane declares the pair —
> the two planes now differ by decision — and what the pair is FOR (the transcript join's two doors:
> the recorded run key, then unioned process evidence, never a guess between two claimants naming one
> process); plus the interrupted-run DISPLAY rule `settle()` now applies on THREE planes (rows end at
> their own `lastStamp` and state `'cancelled'` when the turn settles `done`, cards and context-bar
> segments end at the call's own last frame from ONE shared computation, the root row stays the
> turn's), with the measured before/after figures read off the recorded run's own folds; every value
> was re-derived at source from `src/server/api-reads.ts` (`threadRowOf`, `rosterInvocationIdsOf`,
> `uniqueInvocationIds`, `MAX_ROSTER_INVOCATIONS`), `src/server/harness.swagger.yaml`,
> `src/shared/harness-api.ts`, `src/shared/harness-stream.ts`, `src/shared/run-identity.ts`,
> `src/server/protocol.ts`, `src/server/turn-projector.ts` (`interruptedStateOf`,
> `interruptedEndedAtOf`, `abandonedEndedAtOf`, `settle`), `src/server/journal.ts`,
> `src/harness.ts` (`classifyRunStopReason`, `modelThreadRosterOf`, `runSequence`),
> `src/core/agent-limits.ts`, `src/core/agent.ts`, `src/server/config.ts`,
> `src/transport/{openai,provider-timeouts}.ts`, `src/transport/openai.provider-wire-codes.test.ts`,
> `src/frontend/{view-model,view-api}.ts` and `src/frontend/ui/thread-transcript.ts`, and the
> display figures were re-read from `Temp/orch-plan/{w23,w24,w25}/{before,after}.txt` rather than
> restated; this pass corrected prose that had gone STALE AGAIN — the classifier note still required
> `RunState.sawRetryFrame` for a codeless transit death, which `src/harness.ts` removed on
> 2026-11-17, and README plus `.env.example` still called that removed gate "a stream that died in
> transit after a retry"; the over-trigger it accepts (a codeless transit frame, a
> `decode`/`unknown`/absent code, or an `upstream_status` 408/429/5xx reaching the whole resume
> ceiling) and the UNCHANGED restart policy ("mark interrupted, never replay", no startup
> auto-resume) are now stated explicitly because both are deliberate boundaries a reader can
> otherwise "fix" away; TWO stale comments were fixed IN CODE, comment text only and both pinned by
> their own test file — `src/server/turn-projector-abandoned-card.test.ts` (which still claimed the
> context-bar plane "still reports the turn's close", closed by T-W25) and the W22 plane enumeration
> in `src/types/index.ts` (which stopped short of the ids W26 published beside the epoch) — and
> `.env.example`'s worker-entry line was corrected from "the built bundles under `dist/`" to what
> `lane-host.ts` / `io-client.ts` actually resolve (TypeScript SOURCE, no build step); the
> interrupted-run rule named above is documented IN THE BODY (the `### Task queue and presentation`
> bullet "An interrupted run reports its OWN span, on THREE planes", with the per-plane anchors and
> the three pin files), because the register alone was claiming it; and the epoch-carrier prose W26
> made OVER-BROAD was qualified in the three places that still said the epoch rides nothing but the
> recorded event payload — "The epoch is row state, never a TURN wire field" here, and the two
> clauses in README (the `thread` note under Progress events, and the restart-policy bullet) — since
> `SessionThread.epoch` (`src/server/protocol.ts:610`), `SessionThreadView.epoch` (`:719`) and
> `ThreadSummary.epoch` (`src/shared/harness-api.ts:2821`, hence a `thread.upsert` frame,
> `src/shared/harness-stream.ts:766`) DO carry the token, while the display TURN records
> (`TurnSection` / `TurnSummary`) and the `turn.*` ops still carry none; the drift this
> pass found but did NOT touch is reported, not rewritten — `src/harness.ts:6167` cites
> `harness.invocation-run-key.test.ts` / `tools/runtime/threadList.tool.ts` as the proof of the
> model-page epoch strip and NEITHER names `epoch` (there is no `threadList` test file),
> `src/server/config.ts:148` anchors `DEFAULT_MAX_RETRIES` to `../core/agent-limits.ts` while the
> constant lives at `src/core/agent.ts:552`, `src/server/config.ts:485` still calls the lane
> entry a "shipped bundle", and `src/server/turn-projector.ts:856` cites the `'0ms'` pin of
> `./turn-projector-settle-interrupted.test.ts` at `:459` while the test file has since moved it to
> `:461` (neither file is this pass's to edit); the one TEXT defect in an owned file was fixed —
> `.env.example:10` carried a mojibake em dash (`â€”`) where the file's own style is `—`;
> the ONLY test executed for this pass is
> `yarn vitest run src/server/turn-projector-abandoned-card.test.ts` (8 passed / 8, after the comment
> edit), the full suite being run by a verifier in parallel, and no behaviour file, test assertion or
> generated contract was modified — and
> 2026-11-17 for the run-identity EPOCH documentation pass — the
> per-process epoch every run identity now carries (`HARNESS_PROCESS_EPOCH`,
> `src/core/agent-limits.ts`: ONE opaque string minted at module load, never re-minted, and
> legal only for equality), `src/server/api-events.ts` `HARNESS_RUNTIME_EPOCH` becoming an
> ALIAS of it instead of minting its own, `HarnessThread.epoch` as the OPTIONAL payload field
> that rides EVERY frame of a non-root run (`threadIdentity`) while root runs stay thread-less,
> the fold's RULE (0) that makes two KNOWN-but-different epochs the strongest run boundary
> (`isEpochBoundary`, `src/server/turn-projector.ts`) and an epoch-less record fold
> byte-identically to before, and WHY the field exists at all: invocation ids are per PROCESS,
> so a restarted process and a lane WORKER (its own module registry, its own counters) recycle
> them — `reserveIdentity` cannot prevent it because it only ever RAISES a leased counter — and
> the gateway error-frame vocabulary now has TWO producers (`packages/underload/service/src/server/
> start.ts` and `repository/agentic/src/server/start-server.ts`, one closed vocabulary
> deliberately duplicated across the two, each side pinned by its own frame test) so a codeless
> frame is a build that predates them, not a different gateway; and the browser fold now applies
> the same rule itself (T-W10 — `src/frontend/ui/turns.ts` `runKeyOf` keys a row by `id` +
> `epoch`, falling back to the bare id while the row has none) while nothing renders the value;
> every statement was cross-checked at source level against `src/core/agent-limits.ts`,
> `src/types/index.ts`, `src/harness.ts`, `src/server/{api-events,turn-projector,journal}.ts`,
> `src/transport/{openai,provider-timeouts}.ts`, `src/frontend/contract.ts`,
> `src/frontend/ui/turns.ts`,
> `packages/underload/service/src/server/start.ts` and `repository/agentic/src/server/
> start-server.ts`, with the epoch's real format confirmed by one `yarn vite-node` probe rather
> than assumed; this pass touched NO `.ts` file and NO test, and the stale statements it found
> IN CODE are REPORTED rather than rewritten — the run-identity notes in `src/transport/openai.ts`
> and `src/transport/provider-timeouts.ts` (and the comments in their tests) still call the
> second SSE writer the codeless one, which the patched `repository/agentic` writer disproves,
> and the `src/server/sessions.ts` `clearNetworkStreak` drift is RESOLVED by T-W14 — its comment
> LISTS `markDeletedThread` (`:10831-10835`) and the calls now include the deletion path
> (`:12315`, "streak leaves with the conversation"), `done` (`:10858`), revival (`:5270`) — and
> 2026-11-17 for the provider-failure, durable-auto-recovery and
> rollback-evidence documentation pass — the `provider-network` run stop reason and the exact
> classification rule behind it (a network-class machine code, OR an exhausted CODELESS
> `provider-transit` ladder — never a prose match), the closed resumable-stop set it joins,
> the per-delay ceiling that now caps EVERY retry ladder and the two short class ladders
> (`provider-connection` unchanged at 3 attempts; `provider-timeout` moved from TERMINAL to its
> own bounded 4-attempt ladder under a 900 s wall-clock deadline), `retry: false` /
> `maxRetries: 0` as a hard opt-out for EVERY class including the class ladders, the gateway's
> in-stream error codes (`timeout`/`connection`/`aborted`/`upstream_status`/`decode`/`unknown`)
> and the one translator that turns them into our retry classes, the `code` + `provider`
> diagnostics a TERMINAL `error` record now carries beside its message, the DURABLE
> per-conversation network-failure streak and the ceiling that stops auto-resuming it
> (`networkResumeLimit`, default **10**, `HARNESS_PROVIDER_NETWORK_RESUME_LIMIT`, `0` = off —
> with the restart policy itself UNCHANGED, still "mark interrupted, never replay"), the
> journal's third line kind `rollback` plus a compaction that re-emits EVERY turn's records and
> keeps the header's original `createdAt`, and the `inactive_thread_ids` / `inactiveThreads`
> field that carries a soft-deletion BESIDE the roster that still hides those rows; every
> statement was cross-checked at source level against `src/core/agent.ts`,
> `src/core/agent-limits.ts`, `src/core/snapshot.ts`, `src/types/index.ts`, `src/harness.ts`,
> `src/transport/openai.ts` + `src/transport/provider-timeouts.ts`,
> `src/server/{config,journal,protocol,sessions,persistence,api-reads}.ts`,
> `src/server/harnesses/types.ts` and `src/tools/runtime/{threadSend,threadList}.tool.ts` —
> cited by SYMBOL, not by line anchor, because the code this pass describes was just rewritten;
> the ONE source line this pass touched is the stale resumable-stop enumeration in the
> `src/tools/runtime/threadSend.tool.ts` header comment (guarded by
> `yarn vitest run src/core/tool-discovery.test.ts`), and no behaviour code and no test file was
> changed — and
> 2026-11-17 for the records-receipt, change-window and running-row-age
> documentation pass — the three id receipts `addedIds` / `changedIds` / `noopIds` (one per kind
> of write, present at ANY count and independently of each other, with `noopIds`' single producer
> at a tool door being the patch whose named fields already held those values), the change-feed
> keys `oldestAvailableRev` / `droppedEvents` and the planes that project them differently (the
> per-collection feed, the `tasks` batch wrapper, the store-wide `records()` /
> `recordsChanges()` pair and the closed REST delta object), `define`'s `definition` echo and
> `drop`'s `dropped: true` marker with the schema gates that keep both verbs out of `tasks`, the
> count-aware store-full advice, and the `startedAt` / `ageMs` pair a RUNNING agent-results row
> carries — plus the `delegate` unfinished-child envelope that reports `durationMs` instead; every
> statement was cross-checked at source level against `src/core/records.ts`, `src/harness.ts`,
> `src/types/index.ts`, `src/core/agent-limits.ts`, `src/shared/harness-api.ts`,
> `src/server/api-reads.ts`, `src/frontend/extensions/records-client.ts`,
> `src/tools/runtime/{tasks,records}.tool.ts` and the pins in `src/core/records.test.ts`,
> `src/harness.{task,records,metadata,agent-results}.test.ts` — no line anchor is restated into a
> file this work rewrote (those are cited by symbol), NO test was executed for this pass (it is
> docs-only and the drift it repairs is prose, not contract), and no code was touched — and
> 2026-11-14 for the delegated-threads documentation pass — the
> `threadDelete` receipt growing `removedInvocationIds`/`removedBranchIds`, the branch-id
> refusal and the left-the-family sentence a default conversation now answers, the
> `threadSend` TRANSIENT REPLY ROUTE (a conversation started on an agent's default
> conversation can answer the thread that woke it, and the route reverts with the run) and
> the `note` rule narrowed to an address the caller can actually use, the fifth member of
> the thread family and the address a caller loses when its last thread of an agent is
> deleted, the `threadRead` truncation vocabulary (page BUDGET vs per-message `contentLimit`)
> and the `total`/`matched` split, the `threadList` field vocabulary (`origin`'s two values,
> `sequence` as the creation-order sort key, fork branches absent by design), the
> `agentManage` counting fields, the carried-and-verified delegation identity
> (`HarnessRunIdentity` — addressed by the id the child run wrote, never invented; two
> no-carrier fallbacks survive and the last of them is still discovery, as the C5
> correction inside the Delegation section states), the terminal
> envelope a released or abandoned `delegate` call now carries in its OWN tool message
> (`callCancelled`), the `maxTurns`-counts-model-REQUESTS correction, and the content-conditional
> preview clause of a cancelled/failed `threadFork` branch; every statement was cross-checked
> at source level against `src/harness.ts` (`threadFamilyOf` step 5, `postThreadMessage`,
> `liveSiblingNoteFor`, `deleteThread`/`threadDeleteFor`/`purgeThread`/`branchDeleteRefusal`/
> `defaultFamilyClauseOf`, `releasedDelegateResultOf`, `delegateFor`, `deliverTask`,
> `runAgentCore`, `commitRunTerminal`, `commitTerminalIdentity`, `threadRoster`),
> `src/types/index.ts` (`HarnessThreadDeleteResult`, `HarnessDelegationResult`,
> `HarnessRunIdentity`, `HarnessThreadOrigin`), `src/tools/runtime/threadRead.ts`
> (`ThreadReadResult`, `truncated`), `src/tools/runtime/{threadList,threadDelete}.tool.ts`,
> `src/core/{agent-limits,branch}.ts`, `src/plugin/hooks.ts`, `src/server/sessions.ts`,
> `src/server/workers/{capability,lane-authority,lane-commit,lane-worker-loop}.ts`, and the
> pins in `src/harness.thread-runtime.test.ts`, `src/harness.delegation.test.ts`,
> `src/harness.fork.test.ts`, `src/tools/runtime/threadDelete.test.ts`,
> `src/server/threads.test.ts` and `src/server/workers/lane-authority.test.ts` — no line
> anchor is restated into a file this pass rewrote (those are cited by symbol), the test
> suite was NOT re-run beyond `src/structure.test.ts` and `src/core/metadata.ownership.test.ts`
> as a docs guard (the integrated run owns the rest), and no code was touched — and
> 2026-11-13 for the session-tool-switch (`withheldTools`) documentation
> pass — EVERY registered name being switchable per conversation (the former core names and the
> pending-only `toolCancel` included), the mechanism being a per-harness WITHHELD SET rather
> than cap-set membership (`occupiesSearchableSlot`/`Harness.isToolSwitchable` reduced to cap
> arithmetic, which is all they ever decided for a searchable name), the `enabled`-only session
> tool PATCH answering `200` while a thread is RUNNING and no longer `403`-ing a harness-owned
> name — with the idle gate kept on the combined source+enabled PATCH and on `DELETE` — the two
> reworked wire axes (`SessionToolSummary.enabled` as the CALL axis, `protected` as the
> UNREGISTER axis, so `toolCancel` is now `protected: false` while a core row stays `true` for
> `DELETE` alone and is clickable for the switch), `toolRequest` hiding a withheld name from
> `tools`/`matched`/`omitted`/`availableTags`/`alreadyAvailable` and never reporting it
> `forbidden`, the new session-scoped refusal sentence, the additive snapshot
> `discovery.withheld` (`HARNESS_SNAPSHOT_VERSION` still `2`) with `pruneStaleEnabledTools` now
> pruning both lists, and the lane replica's `LaneBlueprint.withheldTools` beside the one-way
> `sync.tools` reconcile frame; every statement was cross-checked against `src/harness.ts`,
> `src/types/index.ts`, `src/shared/harness-api.ts`, `src/server/api.ts`,
> `src/server/api-reads.ts`, `src/server/sessions.ts`,
> `src/server/workers/{protocol,lane-host,lane-authority,lane-worker-loop}.ts`,
> `src/harness.discovery.test.ts`, `src/server/api-session-tool-writes.test.ts`,
> `src/server/restore-enabled-tool-prune.test.ts`, `src/server/session-reset-toolbox.test.ts`
> and `src/server/workers/lane-tool-reconcile.test.ts` at source level — the `sync.tools` frame,
> its applier and its canonical read are verified at source; the route-side trigger that posts
> it is stated here as the design, not as an executed observation — no line anchor is restated
> into a file this work rewrote (those are cited by symbol), the test suite was NOT re-run (a
> verification pass owns that), and no code was touched — and 2026-11-13 for the
> tolerated-stale-enabled-tool documentation pass —
> the two restore outcomes now stated apart (a stale `core.discovery.enabled` name is
> PRUNED and the session survives; a record that cannot be rebuilt for another reason —
> renamed agent, model map, inconsistent record — is still DROPPED), the reporter now
> carrying both kinds and how a host tells them apart, the `createdTools` exemption, and
> the pruned name being forgotten on the next save; every statement was cross-checked
> against `src/server/sessions.ts`, `src/harness.ts`, `src/types/index.ts`,
> `src/server/workers/lane-worker-loop.ts`, `src/server/restore-enabled-tool-prune.test.ts`
> and `src/server/restore-isolation.test.ts` at source level — no counts are restated
> here, the test suite was NOT re-run (a reviewer runs it concurrently), and no code was
> touched — and 2026-11-13 for the new-session toolbox-seed and session-tool-row
> documentation pass — `HarnessConfiguration.enableAllTools` (what it seeds, the four things
> that bound it, and why the restore path is not seeded), the `Harness.isToolSwitchable`
> seam, the reworked `declared` / `protected` / `origin` rules behind
> `GET /v1/harness/sessions/:id/tools`, the `403`-or-`200` line a session-tool PATCH and
> DELETE now draw, and which `409`s those routes still have (the idle gate, plus the
> runtime's own race refusal — no longer the core-declaration sentence); every
> statement was cross-checked against `src/types/index.ts`, `src/harness.ts`,
> `src/server/sessions.ts`, `src/server/api.ts`, `src/server/api-reads.ts`,
> `src/server/harnesses/descriptor.ts`, `src/server/harnesses/toolbox.ts` and
> `src/tools/**` at source level — six stale line anchors were re-grounded
> (`api-reads.ts:951-985` → `:1003-1032`, `api-reads.ts:1564-1566` → `:1610-1612`,
> `api.ts:4044` → `:4060-4070`, `lane-authority.ts:381`/`:534` → `:386`/`:539`,
> and the `maxEnabledTools` types anchor) — no row COUNTS are
> restated here because the runtime was not re-executed; the only thing executed was the
> package's non-mutating manifest check
> (`yarn vite-node scripts/generate-tool-manifest.ts --check` and the plugin one), which
> reported the manifest current at 32 tool descriptors and 3 plugins — the test suite was
> NOT re-run (two other passes own it), and no code was touched — and 2026-11-13 for the
> eager-session-creation and per-session-plugin-settings
> documentation pass — session creation as its own route and what the UI's `+` actually does,
> the plugin-settings scope split (the template store vs the store each session owns and
> persists), the three catalogue scopes (per-session toolbox, process-wide tool deny list,
> template plugin gate), the `GET/PATCH /v1/harness/sessions/:id/plugins[/:plugin_id]` rows,
> the eight-entry preset catalogue, and the corrected stale claim that "Reset/New session/tab
> switches stay locked while pending"; every statement was cross-checked against
> `src/server/sessions.ts`, `src/server/api.ts`, `src/server/plugins.ts`,
> `src/server/persistence.ts`, `src/server/tool-settings.ts`, `src/server/api-reads.ts`,
> `src/server/harnesses/presets.ts`, `src/frontend/main.ts` and
> `src/frontend/canonical-directory-live-main.test.ts` at source level — the test suite was NOT
> re-run here (a verification pass owns that), and no code was touched — and 2026-11-13 for the
> thread-tools documentation pass — the new
> [model-facing thread tools](#the-model-facing-thread-tools-2026-11-13) section
> (`threadDelete`, the thread-family scope, the `threadRead` first-page contract, the
> `threadSend` lineage policy), the `delegate` `maxTurns` / handle bullets, the
> `threadFork` `timeoutMs` and branch-handle bullets, the 22-entry `src/tools/runtime/`
> layout and 32-descriptor manifest count, and the corrected stale claim that
> `agentManage`/`agentResult` names were reserved (that mechanism no longer exists —
> the registry replaces by name); every statement was cross-checked against
> `src/harness.ts`, `src/core/agent-limits.ts`, `src/types/index.ts`,
> `src/tools/runtime/*.tool.ts`, `src/tools/runtime/threadRead.ts`, and
> `src/server/workers/{capability,lane-authority,lane-worker-loop}.ts` at source level —
> the test suite was NOT re-run here (an integration pass owns that), and the
> fork-expiry `partialContent` delivery was documented as the entries' stated contract —
> and 2026-11-11 for this file's documentation-vs-code realignment pass — the
> workspace-consumer line, the `Layout` trees (now complete at DIRECTORY level: `src/plugins/`,
> `src/tools/runtime/`, `src/server/workers/`, `src/server/stream/`, `src/server/tools/shared/`,
> `src/frontend/extensions/` and the `src/core/`, `src/shared/`, `src/plugin/`, `src/frontend/`
> additions; the deleted `core/task.test.ts`, the renamed `command/shell.tool.ts` /
> `command/gitDiff.tool.ts`, the derived catalogue, and the SIX published entries corrected), the
> Index anchors and omissions, the [Session tasks](#session-tasks) section's claims/lease content
> (Decision P), the `tool_result` event's `media` key, the `harness()` tool/member/config lists,
> the "Not built yet" `patch` item, and the `plugin` row of the dependency-direction table; every
> line anchor cited in this file was re-grounded against the current tree, and no code was touched —
> runtime behaviour was NOT re-executed and the test suite was NOT re-run, so an independent
> verifier still owns both — and 2026-11-09 for this file's documentation pass — the header
> dependencies, the plugin-pipeline member of the run-end lists, and the grep
> matching-time paragraph (all corrected in place; the landed plugin surface is
> documented in `docs/plugins.md`) — and 2026-11-08 for the shared `task` store
> and its concurrency contract (`src/core/task.ts`, `src/tools/runtime/task.tool.ts`,
> the `/task` verbs in
> `src/core/command-builtins.ts`, and the `records.todos` snapshot/restore path in
> `src/core/snapshot.ts` and `src/harness.ts`) [BRACKETED CORRECTION 2026-11-11, the entry itself
> left verbatim: `src/tools/runtime/task.tool.ts` is not in the current tree — that entry is
> `src/tools/runtime/tasks.tool.ts`; the "concurrency contract" verified here (claims/leases) was
> deleted the next day by records-engine Decision P; and the snapshot block is now
> `records.collections.tasks` under snapshot v2, not `records.todos`], and 2026-11-03 for the documentation
> review of the server-side slash-command
> layer (`src/core/command.ts`, `src/core/command-builtins.ts`, `src/harness.ts`
> registry, `src/server/sessions.ts` `dispatch`/`executeCommandTurn`,
> `src/server/cli/commands.ts`) and of editable thread transcripts
> (`src/server/sessions.ts` `threadTranscript`/`updateThreadTranscript` and the
> tolerant restore, `Harness.setThreadMessages`,
> `src/frontend/ui/thread-transcript.ts`); this was a source-level documentation pass —
> runtime behaviour was not re-verified and the test suite was not re-run, so an
> independent verifier still owns both)
> **Package name:** `@underload/harness`
> **Dependencies:** none beyond `dotenv` and `typescript`, both declared in
> `package.json` `dependencies` — `dotenv` by the Node entry points' `.env` loader
> (`src/server/environment.ts`), `typescript` by the tool-source compiler
> (`src/core/tool-source.ts`, Node-only). CORRECTED IN PLACE 2026-11-09: this line
> used to read "none". The DEFAULT transport still adds nothing — it is plain
> `fetch` (Node 18+), and the browser build reaches neither dependency's module.
> **Workspace consumers:** `@erosire/chat-assistant` (`distribution/chat-assistant`) — it declares
> `@underload/harness` in `dependencies` (`distribution/chat-assistant/package.json:24`) and imports
> the root, `/server` and `/frontend` entries (`distribution/chat-assistant/src/server/presets.ts:34-35`,
> `distribution/chat-assistant/src/server/main.ts:35-36`, `distribution/chat-assistant/src/server/main.test.ts:25-26`,
> `distribution/chat-assistant/src/api/harness.ts:68,69,119`).
> `@underload/dashboard` is NOT a consumer: it declares no dependency on this package at all, and its
> own README says the example runs with "no `@underload/harness` import"
> (`packages/underload/dashboard/README.md:360`). VERIFIED IN PLACE 2026-11-11: this line used to
> read "none yet".

---

## How to Update This File

1. Read `src/harness.ts` for the public barrel and the loop
2. Check `src/core/agent.ts`, `src/core/tool.ts`, `src/core/discovery.ts`,
   `src/core/creation.ts`, `src/core/records.ts` (the ONE session store engine, and the
   engine `src/core/task.ts` / `profile.ts` / `chapter.ts` / `location.ts` are specs for),
   `src/core/knowledge.ts` + `src/server/knowledge-file-store.ts` (the CROSS-SESSION engine and
   its file subscriber — the sibling that is not part of that session store),
   `src/core/profile.ts`,
   `src/core/chapter.ts`, `src/core/location.ts`, `src/core/action.ts`,
   `src/core/branch.ts`, and `src/transport/openai.ts` + `src/transport/models.ts`
3. Check `src/tools/catalogue.ts` / `src/tools/lazy.ts` when touching presets
4. Check `src/plugins/` (the shipped auto-discovered plugins that become
   `src/plugin/manifest.ts`) when touching plugin behaviour, settings, or the run-end lists
5. Check `src/server/`, `src/frontend/` (including `ui/action-request.ts`), and
   `src/shared/` for the app contract
6. Update the "Last verified" date
7. Keep the "Not built yet" list honest — it is the roadmap

---

## Layout

`src/` has THREE root *source* files — `harness.ts` (the library and public barrel),
`index.ts` (the Node root) and `browser.ts` (the browser root) — and the rest of the
root level is colocated tests: `structure.test.ts` plus 45 `harness.*.test.ts`
suites. Everything else lives in a role folder with its own barrel, and `harness.ts`
re-exports the public surface.

> **Structural completeness note (2026-11-11).** The two trees below are complete at
> DIRECTORY level; individual files are named where they matter or where a reader
> would otherwise be misled. A per-file annotation older than 2026-11-11 reflects the
> review date it was written; the 2026-11-11 pass guarantees the directory list and
> every file name it spells out match the tree on disk. Test files are usually named
> only as a group.

```
src/
  harness.ts            the library entry: harness() + the public barrel
  index.ts              the Node root (library + shared + server + client)
  browser.ts            the browser root (library + shared + client)
  structure.test.ts     the layout/import-safety contract (its items 1-9): the app tree
                        lives under `src/`, package.json/exports resolve SOURCE FIRST —
                        every condition names a `src/*.ts` entry, so there is no
                        dev/build fork to select — and each root entry composes only
                        the layers it may reach (the browser root never the server
                        tree), the client barrel carries no shell or stylesheet, the
                        service endpoint keeps its `service-route*.ts` contract, and the
                        Vite resolver + tsconfig `paths` mirror the same `src/*.ts`
                        targets
  harness.test.ts       its test, next to the loop
  harness.creation.test.ts    toolCreate behaviour, next to the loop
  harness.delegation.test.ts  the rank ladder + delegate, next to the loop
  harness.task.test.ts        the `tasks` collection in a live harness: declaration, one
                              shared list, and the boundary checks (incl. that no
                              claim/lease shape survives stop/delete/snapshot/restore)
  harness.commands.test.ts    command registry: built-in/config/plugin/runtime order,
                              collisions, replace-by-name, executeCommand contracts
  harness.records.test.ts     the profiles/chapters/locations wrappers in a harness
  harness.knowledge.test.ts   the `knowledge` seam in a live harness: `harness({})` runs the whole
                              round-trip through its own in-memory engine, the handle answers the
                              SAME object and refuses assignment, a configuration value that is
                              neither a store nor an engine fails at CONSTRUCTION, knowledge
                              survives `reset()` and never enters the snapshot, and two harnesses
                              over one host-owned store share one article set (a harness dispose
                              does not dispose the host's store)
  harness.metadata.test.ts    core tool metadata (R7 cap, schemas, and the pinned
                              model-facing descriptions) as registered
  harness.websearch.test.ts   opt-in search registration/core declaration/secrets
  harness.webfetch.test.ts    opt-in fetch registration (native default, hosted keys)
  harness.*.test.ts     the other 28 root-level loop suites: action-request,
                        agent-results, already-available, attachments, background,
                        browser-fallback, budget, creation-policy, discovery, fork,
                        inclusion, media, missing-source, nested-runs, plugin, races,
                        retry, self-modifying, snapshot, sync-async, thread-park-queue,
                        thread-read, thread-runtime, threads, tool-failures,
                        tool-folders, tool-list, tool-settings
  core/
    index.ts            barrel: agent, tool, searchTools, compileToolSource, createDynamicTool,
                        createRecordEngine + the four collection SPECS (TASKS_COLLECTION,
                        PROFILES_COLLECTION, CHAPTERS_COLLECTION, LOCATIONS_COLLECTION),
                        createKnowledgeEngine + `readKnowledgeStoreState` +
                        `isKnowledgeRejection` + the engine's bounds/codes as VALUES
                        (`KNOWLEDGE_ERROR_CODES`, `KNOWLEDGE_UUID_PATTERN`, the
                        `KNOWLEDGE_MAX_*` figures) — the per-store factories createTaskTool/createProfileTool/
                        createChapterTool/createLocationTool are gone (records-engine T3):
                        one engine, one store, specs instead of factories,
                        action/branch internals (validateActionRequestParameters,
                        validateActionChoice, agentBranchOf, forkAgent, materialize/incorporate)
    records.ts          THE ONE session store engine: collections, one id counter, the
                        `expects` compare-and-swap, the per-collection change feed, the
                        bounds, and snapshot/restore (`readRecordsStoreState`)
    action.ts           strict actionRequest parameters/choice parsing + limits (N3)
    agent.ts            the brain
    agent-limits.ts     the R3 inspection bounds a tool DECLARES and the runtime ENFORCES,
                        plus the per-process EPOCH (`HARNESS_PROCESS_EPOCH`, T-W8) that every
                        run identity is stamped with — it lives HERE because it is a
                        dependency-free leaf the runtime (`harness.ts`) and the server
                        (`server/api-events.ts`) may BOTH value-import, and `harness.ts` may
                        not reach into `src/server`
    argument-fingerprint.ts  canonical tool-argument fingerprint (compaction T2.1/T2.2)
    branch.ts           fork identity, tool-id materialization, incorporation, bounds (N3)
    chapter.ts          the `chapters` COLLECTION SPEC (summaries, status, order, body only from get)
    command.ts          the ONE slash-line parser: tokenizer, name rules, /help renderer
    command-builtins.ts the built-in set (/help /tools /task /websearch /webfetch)
    context-estimate.ts rough context sizing + the hybrid estimate anchored on real usage (T5.4)
    context-pruning.ts  the one pure pruning policy behind the shipped trimmer (compaction T3)
    creation.ts         validate + compile a tool from an async function body
    discovery.ts        tag ranking behind toolRequest
    knowledge.ts        the CROSS-SESSION article engine (T4): uuid ids, TWO revisions
                        (article + paragraph), six verbs, optimistic `expects` CAS, the
                        two-lane ranking, the 24 KiB response budget and the
                        `onStoreChange` feed — sync and in-memory, and the file layer is a
                        SUBSCRIBER, never a dependency
                        (see [Cross-session knowledge](#cross-session-knowledge))
    location.ts         the `locations` COLLECTION SPEC (name, description, notes)
    message-id.ts       stable message ids (context-inclusion follow-ups, T1)
    metadata.ts         core-tool metadata COMPATIBILITY aggregation — each declarative half now
                        lives in its own `src/tools/runtime/<name>.tool.ts` (T13→T19); the record
                        specs and `tool-source.ts` still read these re-exports, while
                        `src/server/harnesses/core.ts` builds its catalogue from `tools/descriptors`
    nested-runs.ts      the nested-run POLICY: limitation code, its sentence, validated arm (T14)
    profile.ts          the `profiles` COLLECTION SPEC (per-harness character/people records)
    result-budget.ts    the model-facing tool-result budget, per result AND per turn (R10)
    scheduler.ts        the background board that keeps a run open while calls are in flight (T3)
    schema-validation.ts runtime JSON Schema validation for tool arguments (R11)
    snapshot.ts         the snapshot schema + validation; v3 persists ONE `records` collection map
    snapshot-validation.ts the shared validators for UNTRUSTED persisted JSON
    task.ts             the `tasks` COLLECTION SPEC (fields, caps, count facets, canonical
                        field order, wrapper mapping) — no store, no factory, no lock
                        (records-engine T3/T5; the releaseThread hook died with Decision P)
    thread.ts           persistent threads (R2) — the middle level of the three-level model
    tool.ts             an action the model can request, or you can call
    tool-discovery.ts   the public metadata API over the AST scan (T19 / R8-R9)
    tool-manifest.ts    GENERATED browser manifest — not the Node truth (live scan wins)
    tool-metadata.ts    leaf type module: a tool's declarative half + the discovery descriptor
    tool-media.ts       declarative tool MEDIA — the `toolUi()` seam, for file BYTES
    tool-outcome.ts     the persisted tool outcome (compaction T1)
    tool-scan.ts        the AST half of discovery, with NO dependency on the manifest
    tool-source.ts      tool source compilation and loading (R1/R2, Node-only)
    tool-source-browser.ts the browser stub of `tool-source` (keeps the browser graph Node-free)
    tool-text.ts        declarative tool PROJECTION — the `toolUi()`/`toolMedia()` seam, for
                        the prose a MODEL reads instead of a serialized result object
    tool-ui.ts          declarative tool panels — the server-tool→client seam (R20.2)
    *.test.ts           colocated suites (75 `.ts` files in this folder in total, tests
                        included — 35 of them suites); `records.test.ts` pins the session store
                        engine, `records.store-events.test.ts` the store-change events,
                        `knowledge.test.ts` the CROSS-SESSION engine and its feed (see
                        [Cross-session knowledge](#cross-session-knowledge)), and there
                        is NO `task.test.ts` any more — task behaviour is
                        pinned by `records.test.ts` and the root `harness.task.test.ts`
  agents/
    index.ts            trusted AgentProfile registry + agentInstruction()
    types.ts            AgentProfile (name, title, description, instruction, guidelines)
    guidelines.ts       the policy lines the real roles share (discovery, search
                        key, conditional delegation, read-only, no sandbox, toolCreate) —
                        one source so the wording cannot drift; tool availability itself
                        is the declaration list, never prompt prose, and a profile composes
                        only the lines its own role needs
    general.ts / instruct.ts / research.ts / workspace.ts / reviewer.ts /
    planner.ts / debugger.ts
                        the seven real roles: General (default, works alone), Instruct
                        (delegates only context-burning steps), Explore (id `research`,
                        read-only), Analyst (id `workspace`, the implementor), Reviewer,
                        Manager (id `planner`, orchestrates + independent review), and
                        Debugger (stress-tests everything)
    summarizer.ts       the delegated condenser (Rank B in every teamed preset)
                        (there is no `demo`/`flaky` profile: those fixture agents were
                        deleted, so the roster is exactly the eight names above)
    agents.test.ts      pinned ids/instructions + guideline composition + the
                        policy-not-inventory and prompt-budget guards
  transport/
    index.ts            barrel: openAICompatible, listModels, ModelListError
    openai.ts           OpenAI-compatible SSE transport
    openai.test.ts
    models.ts           GET {baseURL}/models → string[]
    models.test.ts
  tools/
    index.ts            barrel: the presets + presetTools (preload catalogue)
    catalogue.ts        DERIVED, not maintained: PRESET_TOOLS is built from the discovered
                        descriptors, so no hand-written projection and no per-name import
                        switch survive — a new `.tool.ts` appears on the next cold start
                        (src/tools/catalogue.ts:11-32,70-76)
    descriptors.ts      the single seam onto the discovered catalogue + the generated
                        loader: a LIVE scan on Node, the generated manifest only as the
                        browser / scanner-less fallback
    lazy.ts             callable Tool whose body loads on first execution
    catalogue.test.ts / descriptors.test.ts / descriptors.scan-failure.test.ts /
    descriptors.browser.test.ts / laziness.test.ts
                        the derived catalogue, its scan failures, and laziness
    syntax/
      index.ts
      syntax.tool.ts      public tool: language dispatch, two properties
      javascript.ts       node:vm Script parser (imported on demand)
      typescript.ts       transpileModule syntax diagnostics for ts/tsx/jsx (on demand)
      json.ts             strict JSON.parse verdict (imported on demand)
      python.ts           compile() through the interpreter (imported on demand)
    files/
      index.ts
      read.tool.ts
      write.tool.ts       was fileWrite
      edit.tool.ts        multi-edit and multi-file in ONE call: one `edits[]` property
                          (path/oldString/newString/`replaceAll`), so a rename across
                          several files is one request (src/tools/files/edit.tool.ts:1-8,124-136)
      files.tool.ts
      glob.tool.ts        names only          } the two halves of the old fileGlob
      grep.tool.ts        contents only      }
      glob.ts           shared walker (used by glob and grep)
      search.ts         shared pattern/root/argument rules for both searches
      lock.ts           one async mutex per REAL FILE — the lost-update guard (D4)
      identity.ts       one canonical key per real file (T16)
      gitignore.ts      dependency-free `.gitignore` matching for the walker
      bounded-regex.ts  a content matcher that cannot hang (T16)
      *.test.ts
    command/
      index.ts
      shell.tool.ts     the shell entry (the tree used to name this `shell.ts`)
      gitDiff.tool.ts   the gitDiff entry (the tree used to name this `gitDiff.ts`)
      boundedOutput.ts  incremental capture that keeps the HEAD *and* the TAIL
      boundedText.ts    incremental UTF-8 capture with a hard BYTE cap
      processTree.ts    `terminateTree` — ends a child AND the tree it started
      *.test.ts
    runtime/            the SESSION-BOUND tool entries: one `.tool.ts` per harness-owned
                        tool, each carrying only its name/description/schema/routing —
                        the state lives in the harness, not in the entry (24 entries):
                        tasks, records, profiles, chapters, locations, knowledge, toolRequest,
                        toolList, toolManage, toolRegistry, toolCreate, toolCancel,
                        delegate, threadFork, threadList, threadRead, threadSend,
                        threadDelete, actionRequest, agentManage, agentResult, search,
                        fetch, sleep (`threadRead.ts` is the reader helper; `threadDelete.test.ts`
                        and `threadRead.test.ts` test the thread tools' own entries).
                        `knowledge.tool.ts` is the one entry of this group whose state is NOT
                        per-harness: it writes through the `harness.knowledge` seam, which the
                        host hands over by reference, and it owns a bounded `toolText()`
                        PROJECTION on top of the routing (`knowledge.test.ts` is its suite) —
                        see [Cross-session knowledge](#cross-session-knowledge)
    websearch/
      index.ts          createWebSearchTool: key resolution, validation, dispatch
      request.ts        bounds, fetch/timeout, sanitized errors, normalization, redaction
      exa.ts            Exa adapter (dynamic import)
      tavily.ts         Tavily adapter (dynamic import)
      linkup.ts         Linkup adapter (dynamic import)
      websearch.test.ts factory + all three adapters, env injected, fetch stubbed
    webfetch/
      index.ts          createWebFetchTool: native is always the default provider
      request.ts        page bounds (1 MiB / 240 000 chars), text-only gate, URL rules
      native.ts         the direct GET + dependency-free HTML→markdown/text converter
      exa.ts            Exa /contents adapter (dynamic import)
      linkup.ts         Linkup /v1/fetch adapter (dynamic import)
      sections.ts       section selection for the optional `query` argument
      webfetch.test.ts  native + both hosted providers, env injected, fetch stubbed
    webdownload/
      index.ts          type-only barrel (no value import, keeps the entry lazy)
      download.tool.ts  the `download` preset: 20 MiB cap, toolMedia() envelope
      download.test.ts  caps, streaming, names, kinds, cancellation
    presets.test.ts     covers every preset, standalone and in a harness
  plugin/               the programmatic extension host (four parts, one folder)
    index.ts            barrel: runPlugins, resolvePluginList, createHookBus, the two
                        settings providers, and BUILTIN_PLUGINS / BUILTIN_PLUGIN_DESCRIPTORS
    manifest.ts         GENERATED (scripts/generate-plugin-manifest.ts): the auto-discovered
                        built-ins scanned out of `src/plugins`
    host.ts             precedence (built-in first, then `configuration.plugins` REPLACING
                        that name) and the per-plugin api (scoped settings + `on`)
    hooks.ts            the typed, sequential, fail-open lifecycle bus (priority/timeoutMs)
    settings.ts         the host read model + the per-plugin typed settings view
  plugins/              the SHIPPED plugins, auto-discovered into `plugin/manifest.ts`
                        (referenced from `src/types/index.ts:3231-3234`); a configured
                        plugin of the same name replaces the built-in instead of colliding
    context-compaction.plugin.ts  the two compaction modes — `exclude` and the default
                        `summarize` (the conversation compacts ITSELF, one of its own turns)
    context-trimmer.plugin.ts     the shipped preset trimmer over `core/context-pruning`
    async-ping.plugin.ts          the recurring wake, armed ONLY while at least one pending
                        call resolves to `mode:'async'` (a sync group re-enters the run itself)
  util/
    index.ts            barrel: HarnessError, toErrorInfo
    errors.ts           HarnessError, toErrorInfo
  types/
    index.ts            every public type
```

The published package bundles SIX entries (`package.json:9-59`: `.`, `./server`,
`./worker`, `./io-worker`, `./frontend`, `./shared`, plus the `./package.json`
export), all under `src/`:
`.` (the library, whose Node root is `index.ts` and whose browser root is `browser.ts`),
`./server`, `./worker` (`server/workers/lane-worker.ts`), `./io-worker`
(`server/workers/io-worker.ts`), `./frontend`, and `./shared`. The application
layers are never separate top-level folders:

```
src/index.ts            Node root: library + shared + server + client
src/browser.ts          browser root: library + shared + client
src/shared/
  index.ts              the /shared barrel (isomorphic code only — safe in either runtime)
  origin.ts             loopback/same-origin rules (inbound gate + outbound gate)
  harness-api.ts        GENERATED from src/server/harness.swagger.yaml — the canonical REST
                        contract types (scripts/generate-harness-contract.ts)
  harness-stream.ts     GENERATED from the same spec — the update-stream wire vocabulary
  attachments.ts        the SINGLE attachment gate shared by composer, route, run, snapshot
                        and transport
  agent-results.ts      result "block" references shared by server and browser
  turn-display.ts       the server-compiled turn DISPLAY contract (R1/R3/R4)
  *.test.ts             colocated contract/validation tests
src/server/
  index.ts              server barrel -> @underload/harness/server
  start.ts              startHarnessServer: standalone node:http server (explicit) — loads the
                        knowledge base BEFORE the `SessionStore` exists (a failure aborts
                        startup), hands every session the same store through an accessor, and
                        flushes + disposes it exactly once in `close()`
  api.ts                transport-neutral dispatcher: routes, body policy, bootstrap
  handler.ts            Node adapter on /v1/harness; no header gate (T15); SSE by bridging
                        `runHarnessSseStream` onto the ONE exported writer
                        `createHarnessSseResponse` (./service.ts, issue 0006)
  service.ts            @underload/service adapter: /v1/harness, Origin gate, raw SSE
  runtime.ts            lazy shared store/catalogue for the service routes, keyed by root —
                        and the owner of the ONE knowledge base per resolved root
                        (`getHarnessKnowledgeEngine` / `prepareHarnessKnowledge` /
                        `harnessKnowledgeOf` / `flushHarnessKnowledge` /
                        `disposeHarnessKnowledge`: engine created sync, load AND failure
                        memoized per root)
  persistence.ts        durable database (v2 SHARDS): versioned JSON DTO, one file per
                        session and per conversation under `sessions/<id>/`, ordered
                        content-digested atomic commits, validation
  knowledge-file-store.ts the DURABLE half of the cross-session knowledge base (T7):
                        `<root>/harness/knowledge/` — one JSON file per article plus the
                        `index.json` accelerator (the only place `storeRev` survives),
                        ordered atomic commits (articles → erasures → index LAST), the
                        sha256 + `{size, mtimeMs}` skip gate, the forced repair pass,
                        `flush()` and `dispose()`. It SUBSCRIBES to `engine.onStoreChange`;
                        the engine never knows it exists
  sessions.ts           authoritative turns + FIFO queue, watchers, single-flight gate,
                        owner-action registry (answerAction/expiry), core-snapshot
                        write-through and restart recovery; the submit `dispatch`
                        (prompt → queue, `/command` → terminal command turn) and the
                        editable per-thread transcript (GET/PUT, tolerant restore,
                        `invalidThreads`)
  dev.ts                explicit standalone API launcher (no Vite/UI)
  environment.ts        package-root .env loader (Node entry points only)
  config.ts             provider defaults + mergeSettings credential rule
  protocol.ts           client/server wire types (turns, queue, stream items, threads,
                        `SessionInvalidThread`, `ThreadTranscriptResponse`)
  package-root.ts       package root discovered by walking to package.json (build-layout free)
  static.ts             src/frontend/dist serving
  api-errors.ts         the ONE HttpError the dispatcher and every helper throw (T13)
  api-events.ts         the server-side event hub + the home of RESOURCE REVISIONS (T13). Its
                        `HARNESS_RUNTIME_EPOCH` is now an ALIAS of `core/agent-limits.ts`
                        `HARNESS_PROCESS_EPOCH` (T-W8), NOT its own mint — the point is that the
                        epoch in a REST cursor/header and the epoch on a recorded run frame are
                        the SAME string, so they name the same process
  api-paging.ts         the one paging helper every paginated canonical route shares (T13)
  api-reads.ts          the bounded read model behind the canonical REST surface (T13)
  journal.ts            the per-step durable journal beside the checkpoint (R4) — THREE line
                        kinds now, one file: `header` (line 1; its `createdAt` is the log's
                        BIRTH and a compaction re-emits it unchanged instead of re-dating the
                        file), `event` (one recorded step, addressed by `(turnId, index)`), and
                        `rollback` (F4, 2026-11-17 — the durable witness of an ABANDONED
                        attempt: the events a resume spliced out of a turn, including that
                        attempt's terminal `error` frame; EVIDENCE, never a step, so the
                        restore merge ignores it and the reader's per-turn gap check cannot
                        fire on it)
  turn-projector.ts     the fold from one turn's HarnessEvent stream to a TurnDisplay tree
                        (the work the browser used to do) — one section per RUN, decided by
                        `isRunBoundary`: rule (0) is the per-process EPOCH (two KNOWN epochs
                        that differ are two runs, whatever their ids say, T-W8), then the
                        identity-SHAPE rule, then "an OPEN row still owns its run", then "only a
                        `start` recorded after the closing stamp opens another one"; an absent
                        epoch on either side decides NOTHING and falls through, so a record
                        written before the epoch exists folds exactly as it did
  plugins.ts            the runtime plugin-settings layer: the TEMPLATE value a built-in
                        plugin's setting has, plus the per-session store forked from it
                        (`copyPluginSettingsStore`) that that session's harness really
                        reads, and the reserved `enabled` key whose live gate switches one
                        plugin's hook delivery (T5/R2-R3, the two scopes are R4)
  tool-settings.ts      the runtime GLOBAL tool switch: which names this deployment runs,
                        for every session and thread at once (R3)
  cli/
    index.ts            argv parsing, one-shot, interactive, --serve
    options.ts          the argv parser alone (index.ts runs main() at import time)
    commands.ts         the REPL's slash-command dispatch (local set first, then the
                        harness registry) + the two-section /help
    commands.test.ts
    render.ts           terminal rendering of HarnessEvent
  endpoint/harness/     discovered by @underload/service
    service-route.ts        /v1/harness/*
    service-route-root.ts   /v1/harness    (bare bootstrap document)
    service-route-stream.ts GET /v1/harness/stream on the @underload/service
                        gateway — its own endpoint module, so the loader can attach
                        the `upgrade` handler to an exact path instead of racing the
                        `/v1/harness/*` wildcard
  harnesses/
    index.ts            createToolCatalogue: runtime catalogue for CLI and server
    core.ts             core-tool catalogue entries (sessionBound) for the server (R8)
    presets.ts          the 8 shipped presets and nothing else (the `demo`/`flaky`
                    example tier is deleted), legacy defaults,
                        and teamOf() — assembled from src/agents profiles
    registry.ts         in-memory registry: create/patch, aliases, validation, agentModels (R9),
                        restore policy (refresh unmodified shipped defaults, T3)
    descriptor.ts       describeHarness/describeAgent: the single wire projection
    toolbox.ts          shared toolbox + createProfiledHarness/createToolboxHarness
    tools.ts            timeNow, textCount, diceRoll, noteSearch, textSummarize
                    (one scanned folder, `src/server/tools/shared`; the opt-in
                    `examples` folder and its `testFlaky` are deleted)
    websearch.ts        always-listed search entry (configured or not)
    webfetch.ts         the catalogue view of web fetch (its own module, unlike search)
    agent-state.ts      the GLOBAL agent-override layer (T19)
    fixture-presets.test-support.ts  TEST-ONLY `demo` (scripted) + `flaky`
                    (toolbox + `testFlaky`) presets a suite injects; not production
    types.ts            RunnerSettings, HarnessPreset, CatalogueEntry, availability
  tools/shared/         the five app tools the toolbox scans (one folder, no hand table):
                    timeNow.tool.ts, textCount.tool.ts, diceRoll.tool.ts,
                    noteSearch.tool.ts, textSummarize.tool.ts
  stream/               the realtime half of the server: ONE update stream at
                        `/v1/harness/stream` (13 files)
    index.ts            the subsystem barrel and the layout rule each file owns
    protocol.ts         closed vocabularies, per-scope tables, the opaque cursor codec,
                        and the client-frame validator that runs FIRST
    broker.ts           counters, subscriptions, sequences and replay windows; never touches
                        a socket, so the REST side can drive it by plain calls
    connection.ts       the per-connection conversation between the `101` and the close —
                        the ONLY place a client frame mutates broker state
    transport.ts        a minimal standards-safe RFC 6455 server transport (no `ws`)
    mount.ts            attaching the stream to an HTTP listener + the bridge that lets the
                        store/registry answer the stream's three cheap questions
    *.test.ts           broker/connection/protocol/transport + standalone- and
                        service-host upgrade tests
  workers/              the lane-worker subsystem (29 files): each conversation can run on
                        its own worker thread (`threadExecution: 'worker'`), and the same
                        folder carries the durability arm (`ioExecution: 'worker'`)
    index.ts            the subsystem barrel
    lane-worker.ts      the Worker ENTRY file (two load modes, one file)
    lane-worker-loop.ts one persistent lane thread's execution, on its own OS
                        thread: a replica of the session harness rebuilt from the
                        `hello` blueprint, so the agent loop, the provider stream and
                        every synchronous tool BODY run off the main thread (R1)
    lane-host.ts        the coordinator-side host that spawns and supervises lanes
    lane-authority.ts   the authority: rebuilds the tool context from the crossing
                        `LaneCallIdentity`, so a routed write keeps its (agent, threadId)
    lane-commit.ts      the receipted commit path — shared state is mutated AT the
                        authority, never merged into a replica (T3 findings F1-F8)
    lane-identity.ts    the crossing call identity
    lane-memory.ts      shared harness memory across lanes: faithful transfer and
                        compare-and-set against the AUTHORITY's value (T3 finding F4)
    capability.ts       the ONE decision a session makes at creation/restore about whether
                        its turns may run on lane workers
    protocol.ts         the lane wire vocabulary
    io-worker.ts        the lane worker's durability arm (entry file)
    io-worker-loop.ts   what runs on the IO thread (checkpoint + journal writes)
    io-client.ts        the coordinator side: one FIFO durability queue per database root
    io-protocol.ts      the IO request/response types
    *.test.ts           authority, commit, identity, memory, capability, protocol,
                        correctness, tool-settings + the two test-support stubs
src/frontend/
  index.ts              client barrel -> @underload/harness/frontend (no CSS, no shell)
  main.ts               app shell: imports styles.css, mounts the DOM (NOT exported)
  vite.config.ts        Vite dev/build/preview; dev binds the dual-stack wildcard
                        (localhost + LAN), /v1/harness proxy
                        to the service on :5000; proxy stamps target origin so the
                        service gate accepts LAN-browser traffic without CORS changes
  vite-proxy.ts         /v1/harness proxy map: target, changeOrigin, target-origin
                        header, rewrite, `ws` upgrade
  api.ts                root resolution (query/injected/build/api) + fetch; no SSE
                        parser left (`src/frontend/api.ts:6-9`)
  stream.ts             the realtime plane: ONE centralized `harness.v1` WebSocket (T14)
  contract.ts           wire validation/presentation helpers
  view-api.ts           the browser's DISPLAY FACADE over the canonical control plane — the
                        only place the UI assembles a render document (T14)
  view-model.ts         the frontend's OWN render model for one conversation (T14)
  view-state.ts         the browser-side display state: a `SessionView` plus the
                        `TurnDisplayOp` stream that mutates it (R1/R3)
  view-context.ts       the ONE context bar's model (segments, widths, tone, a11y text)
  view-detail.ts        the ONE place a lazy detail body becomes view data (R2/R8)
  view-shell.ts         the shell's existing vocabulary, bound to the canonical contract
  display-project.ts    wire display record -> internal projector model (T14)
  deployment.ts         where the harness API lives when the UI is on a STATIC origin
                        (the GitHub Pages case)
  build-label.ts        the build identity the topbar brand shows
  index.html            the standalone client document
  styles.css            the shell stylesheet, imported ONLY by `main.ts` (`main.ts:99`),
                        which is what keeps the published barrel CSS-free
  view-test-support.ts  the shared helper the frontend suites use to stand up a fake
                        control plane
  vite-env.d.ts         ambient types for the Vite client build
  vitest.config.ts      the jsdom suite (`yarn test:frontend`)
  extensions/           the plug-and-play panel seam under the panel pipeline (T5/R1)
    index.ts            the subsystem barrel
    runtime.ts          the mount/unmount engine the shell paints THROUGH
    panel-kinds.ts      the closed panel-kind vocabulary
    context.ts          the extension context handed to a panel
    records-panels.ts / records-client.ts / records-dom.ts / records-wake.ts
                        the two live shell panels (`harness.tasks`, `harness.records`)
    shell-panels.ts     the shell's own panel registrations
  ui/                   29 modules for the DOM surface (+ colocated tests, + dialog.css and
                        agent-dialog.css): action-request, activity, agent-color,
                        agent-control, agent-dialog, agent-label, agents, attachments,
                        composer, context-bar, context-detail, create-harness, dialog,
                        editor, file-links, file-preview, markdown, model-order, panels,
                        preview, rail-resize, references, thread-transcript, threads, time,
                        tokens, tools, turns, usage-summary (+ highlight-core.d.ts)
  ui/turns.ts           linear turn timeline: completed grey, active green, queued neutral;
                        one independently expandable entry per delegated invocation,
                        nested depth-first outside every collapsible body, and the entry is
                        keyed by the RUN (`runKeyOf` = invocation id + `epoch`, bare id while
                        the row has none — T-W10; the epoch rides `data-run-epoch`, rendered
                        nowhere)
  ui/markdown.ts        safe GFM (marked + DOMPurify) + highlight.js fenced code (R5)
  ui/action-request.ts  interactive owner-question card; read-only non-root card (N3)
  ui/thread-transcript.ts  one conversation's lossless JSON document AND its editor
                        (C4/C5): "Edit transcript" swaps in a textarea over the
                        thread's `messages`, and an unreadable thread opens in it
                        directly
```

**Transcript threads.** One `.turn-row` per server turn: a `.tile` (compact header,
collapsible `.tile-body`) plus a `.thread-children` host that sits outside the body.
Each delegated invocation appends a `.thread-row` there (`data-depth` 1 for a child
of the turn root, 2 for a grandchild, …), and that row owns its own body and its own
children host. The nesting rule (`.thread-children { padding-left }`) gives one
indent step per level and depth-first sibling order; because descendants live
outside the parent body, neither tile collapse nor entry collapse can hide them.
Every entry is keyed by the RUN, not merely by its id: runtime `thread.id`, or a synthesized
`call:<callId>` where a record offers no id to adopt (the same spellings the server fold uses
for its section keys, `src/server/turn-projector.ts` `newSection`). Because `thread.id` is a
per-process counter and a restarted server re-mints the SAME number for a DIFFERENT run, the
rule on both surfaces is: a row whose KNOWN epoch differs from an incoming frame's starts a NEW
entry, a one-sided comparison (either side epoch-less) MERGES, and an epoch-less record behaves
exactly as it did before. The server enforces it as rule (0) of `isRunBoundary` via
`isEpochBoundary`; the browser fold enforces the SAME definition — its own `isEpochBoundary`
(a copy, because the bundle must not import the server module), `runKeyOf` (id joined to the
epoch with the board's existing NUL separator, bare id while the row has no epoch),
`resolveRunEntry` (qualified key first, bare id second, which is what makes the merge case
merge) and `parentKeyOf` (so a split parent keeps its children). The value rides the row as
`data-run-epoch` and renders nowhere. An epoch-less legacy record therefore keeps the fold every
pre-change fixture pins, where the id and the spawn `callId` are all the record says. Only the
parent's `tool_result` for the spawning `callId` — or the root turn's terminal status — closes an
entry for good; `done.pending` is a pause, not a finish. A
`threadFork`/autoanswer branch reuses
this same nested row shape (`thread.kind` plus `branchId`) rather than inventing a
second presentation; only the small kind tag differs. The layout is pure DOM/CSS,
so the `main.ts` stream/snapshot routing needs no per-agent case.

**The same keying rule owns a THIRD plane: the tool cards inside a row (T-W15, 2026-11-17).**
`runKeyOf` split the ROWS, but the fold's tool-card state was still keyed by the BARE `callId`
(`pendingTools` `src/frontend/ui/turns.ts:4389`, `settledCalls` `:4399`), and the call-id
counter is per process exactly like the invocation counter — `src/core/agent-limits.ts:224-243`
states the per-process counter universe that `HARNESS_PROCESS_EPOCH` (`:282`) exists to name. So
after the row split the NEW run's row got its own card while that card's `tool_result` was thrown
away as a DUPLICATE of the dead run's settled call: the row was right and the chip inside it hung
`running` forever. A call is therefore identified by `(process epoch, callId)` through `callKeyOf`
(`:1668`), which the two card writers use — `appendTool` (`:6651`) and `resolveTool` (`:6840`) —
and it is deliberately `runKeyOf` itself rather than a second copy of the NUL join, so the row
plane, the placeholder lookup (`findThreadByCallId`, `:5217`) and the card plane cannot each
re-implement the separator and drift. `isKeyOfCall` (`:1673`) answers "does this key name this
call id, in ANY process" as exact equality plus a NUL-terminated prefix, which is why `call-1`
never matches `call-12`. A call that knows no epoch keeps the bare id, so every pre-change key,
every `data-thread-id` assertion and every legacy record folds exactly as before — nothing to
migrate on restore. Pinned by `src/frontend/ui/turns-run-epoch.test.ts:444` ("the epoch splits the
tool-card plane"); the browser's contract reader keeps `epoch` on the event copy for exactly this
consumer, because dropping it loses a settled CARD, not just a row (`src/frontend/contract.ts:485-492`).

`src/server` and `src/server/cli` import `src/harness.ts` relatively (they are
inside the package) and re-use the public harness surface. `src/frontend` imports
the server wire types **type-only** from `src/server/protocol.ts` (erased at build
time — `main.ts:100-113`, `contract.ts:33-42`, `view-state.ts:44-50`,
`ui/turns.ts`, `ui/thread-transcript.ts`), so the client never loads server code;
its runtime cross-tree dependencies are all in the isomorphic `src/shared/` layer —
`harness-api.ts` (route/constant values), `harness-stream.ts` (the stream wire),
`origin.ts` (the trust gate) and `attachments.ts` (the shared attachment gate) —
which is why the old `node:` stubs are gone. The one exception is
`view-test-support.ts`, a TEST-ONLY helper that does import server runtime
(`server/turn-projector.ts`) to drive the projector the client renders.

Tests are colocated with the module they cover, and the harness's own behaviour is
exercised through the PUBLISHED specifiers — `@underload/harness` and its
subpaths — while an internal that is not on the public surface is imported
relatively (e.g. `./core`, `./core/tool-outcome`, `./server/harnesses/toolbox`).
Those specifiers resolve with NO `resolve.alias` block at all: the package is published
as TypeScript source, so every condition in `package.json` `exports` already names a raw
`src/*.ts` entry and there is no `development` condition to select — the manifest map IS
the source map. `vitest run` therefore needs no build and can never accidentally test a
bundle; an alias here would shadow that map and let the
manifest and the suite drift apart (`vitest.config.ts:3-18`). `tsconfig.json`
`paths` mirror the same six targets for editors and `tsc`, and
`src/structure.test.ts` (items 8-9) pins manifest, config and tsconfig against each
other. The Node suite excludes `src/frontend/**`; the jsdom client suite is
`src/frontend/vitest.config.ts` (`yarn test:frontend`).

**Type-surface contract (source-only, R1 types).** There is no declaration build: the
`types` condition of every published subpath names the same `.ts` file the runtime loads,
so an installed consumer type-checks the sources this repository edits. Two constraints
replaced the old `.d.ts` constraints:

1. *Consumer module mode.* `tsc` reads the published sources, whose relative specifiers are
   extensionless (`./harness`, `./ui/turns`); `moduleResolution: node16|nodenext` rejects
   that with TS2834, so the supported consumer mode is `moduleResolution: bundler` — what
   Vite, Vitest, vite-node and every bundler host already use. An emitted `.d.ts` tree with
   `.js` specifiers is what used to pay the NodeNext cost, so retiring the emit retired the
   post-process too (`scripts/build-declarations.ts` and `scripts/fix-declaration-specifiers.ts`
   are gone). A source consumer also needs `types: ["vite/client"]` (`src/frontend/api.ts`
   reads `import.meta.env`) and accepts `skipLibCheck: true` (the source graph reaches
   third-party `.d.ts` files through `typescript`, `ws` and `marked`).
2. *Environment-matched types.* The root's nested `browser` group names `src/browser.ts`
   (library + shared + client) and the `types`/`default` pair names `src/index.ts` (plus
   the server). The old risk lived in the emitted graph: in one tsc program the root's
   inferred types dragged `dist/server/**` (`node:http`) into the browser declarations,
   which is why the entries were emitted by a **separate** program
   (`tsconfig.entries.json`). A source-only publish has no graph to emit, so the equivalent
   proof is a source walk: `scripts/check-package-types.ts` follows the import graph of
   `src/browser.ts` and fails if it ever reaches `src/index.ts` or `src/server/index.ts`
   (today that walk covers 168 files and reaches neither).

`scripts/check-package-types.ts` (`yarn test:package`, part of `prepublishOnly`) verifies
the published SOURCE shape: every export target of every condition is inside `files` and
resolves to a single published file, the legacy `main`/`module`/`types` trio names
`src/index.ts`, no stale `dist/` or `.entries/` exists on disk, the packed file list
carries no built artifact (`.mjs`/`.cjs`/`.js`/`.map`, or a `foo.d.ts` twin of `foo.ts`)
beyond the one permitted `src/server/workers/worker-boot.mjs`, every bare specifier inside
the published sources is a declared dependency, and real `moduleResolution: Bundler` plus
`customConditions: ["browser"]` consumers type-check against a copied, published shape of
the package.

`scripts/check-package-runtime.ts` (`yarn test:package:runtime`) runs that copied install
instead of only reading it: `loadEnvironmentFile` against a fixture (the dotenv path),
`createHarnessRuntime({ root })` writing its database under an absolute temp root,
`startHarnessServer({ databaseRoot, port: 0 })` answering the `/v1/harness` mount (a
session POST, the paged harness index, the retired `/api/health` path as a 404) and closing
cleanly, plus the IO worker committing, journaling and fencing off-thread. It exists
because "the manifest resolves" is not the same claim as "the package runs": the failure it
was written for was `loadEnvironmentFile()` throwing `path.resolve is not a function` while
imports, types and every source test still passed, because the lib build of that day had
replaced bare `require('fs')`/`require('path')` from the bundled CommonJS `dotenv` with an
empty `__vite-browser-external` stub. Nothing bundles the server any more, so the modern
form of that same bug is a dependency that is undeclared or unresolvable in an installed
tree — which is why `dotenv`, `typescript`, `marked`, `dompurify` and `highlight.js` are
`dependencies` and why the source scan asserts both the specifiers and their resolution.

`scripts/check-package-tools.ts` (`yarn test:package:tools`) is the end-to-end run of the
copied source: it drives the whole self-modifying-tool loop (register, replace, fail,
replace again, then a scripted model conversation that discovers `toolRegistry`, registers
a tool and calls it on the very next request) through `src/index.ts` — possible only
because the published entry and the editable tool sources are the same tree.

Browser scope of the tools is a documented limitation, not a target: importing the
browser entry evaluates no server code and no Node built-in, but the lazy preset
modules (each preset's own `*.tool.ts`, reached by `import()` — `read`, `shell`,
`gitDiff`, `syntax`, `write`, `glob`, `grep`, …) contain
`node:fs`/`node:vm`/`node:child_process` because
those tools are Node-only by design. Calling them in a browser fails at the dynamic
import; importing the library, shared or client entries does not load them. A static
walk of the browser SOURCE graph therefore sees those `node:` specifiers — the old
build hid them by swapping the source compiler and splitting chunks, which is why
`scripts/check-package-types.ts` proves the browser tree by reachability (never
`src/index.ts`, never `src/server/index.ts`) instead of by the absence of `node:`.

A consequence worth knowing: a symbol that is not exported from the root barrel
cannot be unit-tested. That is intentional — it is the pressure that keeps the
public surface clean.

**Dependency direction** — a strict DAG, so no barrel can create a cycle:

| Folder | May import |
|---|---|
| `types` | nothing (leaf) |
| `util` | nothing (leaf) |
| `transport` | `types`, `util` |
| `core` | `types`, `util`, `transport` |
| `tools` | `types`, `util`, `core` |
| `plugins` | `types`, `core` — the shipped plugins reach the pure helpers they need (`core/context-pruning`, `core/argument-fingerprint`, `core/context-estimate`, `core/tool-outcome`) |
| `plugin` | `types`, `util`, `plugins` — the host and the settings view stay clean; only the GENERATED `plugin/manifest.ts` names the built-ins (`:26-28`) |
| `harness` | `types`, `util`, `core`, `transport`, `tools`, `plugin` (and `plugins` transitively, through that manifest) |

CORRECTED IN PLACE 2026-11-11: the `plugin` row used to read "`types`, `util`" and the
`plugins` folder was not in the table at all — that was true before the shipped plugins
were auto-discovered, and the folder is now `plugin/{manifest,host,hooks,settings}.ts`
plus `src/plugins/*.plugin.ts`.

Internal folders import each other through barrels. A barrel is never
load-bearing for runtime wiring; it only defines what consumers can reach.

`agent` and `tool` live in `core/` and are barrelled to the package root, so
consumers import `{ agent, tool, harness }` from `@underload/harness` and never
reach into `src/`.

---

## Index

### Core
- [agent](#agent) — The brain, usable on its own
- [tool](#tool) — An executable action: call it directly, or let the model call it
- [Tool discovery](#tool-discovery) — Tags, visibility, toolRequest, the ranking, and the
  conversation's tool switch (`withheldTools`)
- [Turn modes](#turn-modes-sync-vs-async-t2) — sync vs async calls, and the background board
- [Session tasks](#session-tasks) — The `tasks` collection of the one session store:
  incremental ids, per-harness state, revisions, guarded writes and the change feed
- [Session records](#session-records) — The `profiles`/`chapters`/`locations` collections of
  the one record engine (`src/core/records.ts`)
- [Cross-session knowledge](#cross-session-knowledge) — The deployment-wide article store that
  outlives a session: the `src/core/knowledge.ts` engine, the JSON file layer beside `sessions/`,
  and the six-verb `knowledge` tool
- [Agent results](#agent-results-r3) — Core agentManage/agentResult result inspection
- [toolCreate](#toolcreate) — Runtime tool creation from an async function body
- [Delegation](#delegation) — The rank ladder, strictly-downward delegation, rank-bounded
  nesting, uniform tool access, and the model-facing thread tools (family roster, first-page
  reads, lineage policy, release)
- [Owner questions and history forks](#owner-questions-and-history-forks) —
  Conditional `actionRequest`/`threadFork`, autoanswer owner forks, ephemeral branches

<!-- The `-1` slugs below are not typos: this Index's own group headings
     ("### Preset Tools", "### Harness") slug to the same anchors as the sections
     they list, so github-slugger gives the LATER heading the `-1` suffix. Linking
     the bare slug would jump back into this Index instead of to the section. -->

### Preset Tools
- [Preset tools](#preset-tools-1) - the ten lazy presets, executable on their own
- [Web search](#web-search) — opt-in per-harness `search` over Exa/Tavily/Linkup
- [Web fetch](#web-fetch) — opt-in `fetch`: keyless `native` default, hosted `exa`/`linkup`
- [Web download](#web-download) — always-registered `download`: 20 MiB bytes as model media

### Harness
- [harness](#harness-1) — Callable execution loop
- [Slash commands](#slash-commands) — Operator-facing registry, built-ins, and the
  command turn (no model, server state, UI renders)

### Transport
- [openAICompatible](#openaicompatible) — Default SSE transport
- [listModels](#listmodels) — Model catalogue for the dropdown

### Types
- [HarnessEvent](#harnessevent) — Progress events
- [HarnessMessage](#harnessmessage) — Transcript entries
- [HarnessAssistantMessage](#harnessassistantmessage) — Finished turn
- [ToolVisibility / selectTools / searchTools](#toolvisibility--selecttools--searchtools) —
  Discovery data
- [Action and branch types](#action-and-branch-types-n3) — The N3 wire shapes
- [Declarative tool panels](#declarative-tool-panels-r202) — `toolUi()`, the server-tool→client seam

### Application
- [CLI, server, and UI](#cli-server-and-ui) — The app built on the harness
- [API](#api) — The canonical REST surface and its generated contract
- [Task queue and presentation](#task-queue-and-presentation-r4r5) — Server-owned FIFO queue, watcher stream, timeline, Markdown
- [Persistent threads in the UI](#persistent-threads-in-the-ui-t5--r5-r7) — Host threads, resume, steer, stop
- [Live shell panels](#live-shell-panels-harnesstasks-harnessrecords) — The two panel-host panels
- [Lane workers](#lane-workers-threadexecution-worker) — One conversation per worker thread
- [IO workers](#io-workers-ioexecution-worker) — Checkpoint and journal writes off the request loop
- [Agents and the harness registry](#agents-and-the-harness-registry) — Trusted profiles, create/patch, frozen teams, live models
- [Tool-composition visibility](#tool-composition-visibility) — The `progress` frame, the display field it paints, and what the UI may claim

### Document
- [Decisions worth remembering](#decisions-worth-remembering) — The rulings a change must not undo
- [Not built yet](#not-built-yet) — The roadmap, in the order it is expected

---

## Design Split

| Layer | Owns | Must not own |
|---|---|---|
| `agent` | model, instruction, history, one transport call per turn plus its model-request retry sequence | tool execution, compaction, planning |
| `tool` | description, JSON Schema, one `execute` function | state (except the harness-owned `task`/record factories), retries, policy |
| `harness` | agent registry, tool registry, command registry, loop, progress | model I/O, prompt policy |

The harness is the only layer that knows about tools and looping. That is what
makes `agent` reusable standalone.

**Standalone is real, not theoretical.** `agent.stream(input)` is exactly one
turn. A caller who wants tool calling writes the loop by hand: `brain.user(...)`,
`brain.turn({ tools })`, inspect `message.toolCalls`, append tool messages,
`turn()` again. `harness()` is that loop.

---

## agent

```ts
const brain = agent({ model, instruction, provider });   // name optional
```

- `instruction` accepts a string or an array; each entry becomes its own system
  message, in order. Seed `messages` follow the instructions.
- `structured: schema` (issue 0001) — "send the schema AND hand me a validated
  value". It rides into the built-in transport as `provider.responseFormat`
  (`json_schema`, name derived from the agent name) unless the host set
  `responseFormat` explicitly, and it becomes the acceptance test every answer
  passes: `validateSchemaValue` — the same gate a created tool's arguments pass —
  and the parsed value lands on the turn as `message.structured`. A bad answer is a
  `HarnessError` with code `structured-output-invalid` and NO commit to history
  (never a silent `{}`), and it is deliberately NOT a transport retry: the provider
  answered, so the retry loop already finished. A `stopReason: 'length'` truncation
  or a `stopReason: 'tool_calls'` round is not judged, so a truncated answer stays
  distinguishable from a malformed one. The schema itself is gated at construction
  by `checkToolSchemaComplexity` (`structured-schema-invalid`), and forks and
  threads inherit it.
- `name` is optional (default `'agent'`). **A harness overwrites it with its
  registry key**, so `agents: { writer: agent({...}) }` gives `agent.name ===
  'writer'` without repeating the name.
- `stream(input, options?)` — append the user message, run one turn, commit
  both. On failure it truncates back to where it started and yields an `error`
  event.
- `turn(options?)` — run one turn against the current history, **no user append
  and no rollback**. Throws on failure. This is the primitive the harness
  re-requests with after a tool result.
- **Retries (R1, as re-shaped on 2026-11-17).** The agent is the single retry owner
  for model calls. Default: one initial attempt plus ten retries (`DEFAULT_MAX_RETRIES`
  / `DEFAULT_RETRY_BASE_DELAY_MS`, `src/core/agent.ts`), waiting
  `min(baseDelayMs * 2 ** (n - 1), RETRY_MAX_DELAY_MS)` — 1s, 2s, 4s, 8s, 16s, 32s,
  then **60 000 ms flat** for every later retry. The ceiling is not decoration:
  uncapped doubling made an exhausted ladder sleep 1+2+4+…+512 s = **1023 s (~17 min)**,
  which is longer than most provider outages, so the tail is now flattened and the
  same exhausted default ladder waits at most **303 s (~5.05 min)**. The attempt COUNT
  is untouched — a host that asked for `maxRetries: 10` still gets eleven chances —
  and there is deliberately **no jitter** (one client re-sending one request gains
  nothing from spreading, and a published `delayMs` must be a fact a test can pin; a
  host that wants jitter varies `retry.baseDelayMs` per agent). A successful attempt
  ends the sequence; when the last retry also fails, that attempt's own error is what
  the caller sees. Every TRANSIENT
  model-call failure is retried — a returned `error` frame (any HTTP status, a
  provider error on a `200` stream, a malformed or truncated stream), a thrown
  network error, and a mid-stream throw — and the classes that are NOT retried are
  named below, so "transient" is the ladder's word, not a guess about the error text.
  **Cancellation is never retried.**
  A retry re-sends ONLY the current request, and the failed attempt's partial
  text/reasoning/tool calls are discarded, so nothing from it is committed and no
  tool it named can run. The `retry` event reports `attempt`, `maxAttempts`,
  `delayMs` and the failed attempt's `error` (`HarnessErrorInfo`: `message`, plus
  `code` and — for a provider-classified attempt — `provider`).
  - **Three ladders, not one** (`src/core/agent-limits.ts`, applied by the class
    switch in `src/core/agent.ts`). The generic transient ladder above;
    `provider-connection` (nothing answered the dial) gets its OWN short ladder of
    **3 attempts** with 250 ms / 500 ms waits — 750 ms of waiting total, unchanged
    since T6; and `provider-timeout` (a bound expired, OR the provider reported a
    timeout on an open stream) got one on 2026-11-17: **4 attempts** (1 +
    `PROVIDER_TIMEOUT_MAX_RETRIES` = 3) with waits of 2 s / 4 s / 8 s, each capped at
    `PROVIDER_TIMEOUT_RETRY_MAX_DELAY_MS` = **30 000 ms**, under a
    `PROVIDER_TIMEOUT_RETRY_DEADLINE_MS` = **900 000 ms** wall clock measured from the
    START of the first attempt and INCLUDING the provider time each attempt consumed.
    This class used to be TERMINAL — one attempt, zero `retry` frames, a conversation
    permanently marked interrupted because a gateway went silent mid-stream — and the
    reasoning that killed it ("re-sending into a provider that missed a five-minute
    bound buys another five minutes") was right about the LADDER and wrong about the
    CONCLUSION: what it rules out is the 1 s → 60 s transient ladder, not retrying.
    Worst case with the shipped bounds is ~494 s (four attempts at the 120 s stream
    bound plus 14 s of backoff), which is why the deadline only bites the pathological
    shape — a host that raised `HARNESS_PROVIDER_*_TIMEOUT_MS` to minutes. The
    deadline is checked BEFORE the `retry` frame is emitted and before the wait starts,
    so an expired sequence neither promises a retry nor sleeps for it; one deadline is
    captured per model request, so the next turn owns a fresh budget.
    `retry.maxRetries` does NOT stretch either class ladder (widening the transient
    ladder says "my provider blips", not "dial my dead port eleven times"), and
    `retry.baseDelayMs` only ever RAISES the timeout ladder's 2 s base
    (`max(baseDelayMs, 2000)`, still capped at 30 s) — it never lowers it.
  - **Terminal classes.** `context-overflow` (the pre-request floor the request would
    breach — issue 0004, never worth re-sending), `provider-rejected` (an HTTP
    400/401/403/404 refusal),
    `provider-aborted` (the gateway's own in-stream `aborted` answer — a cancel that
    did NOT come from our signal, so a re-send would be a request nobody waits for)
    and an abort from the caller's own `AbortSignal` end the sequence on the spot. A
    LOCAL stop never reaches `provider-aborted`: the `isAbortError` short-circuit runs
    first, so a user stop keeps its historical identity.
  - **`retry: false` (and `retry: { maxRetries: 0 }`) is a HARD opt-out for every
    class** (the `maxRetries === 0` gate in `src/core/agent.ts`, ahead of the class
    switch). The class ladders ignore a NON-ZERO `maxRetries`, but zero is a different
    promise — the published contract says one attempt, and a host passes it exactly
    when a re-send is unwanted rather than merely bounded (scripted fixtures, a
    non-idempotent endpoint, a test on its own clock). Before this gate a
    `provider-timeout` spent four dials and 14 s under `retry: false`.
- `options.tools` forwards tool declarations to the transport. The agent never
  executes them; standalone callers do.
- `messages` is the live array (not a copy).
- `model()` reads, `model('x')` writes. `system`/`user`/`assistant` append and
  chain. `reset()` restores instructions + seed messages.
- `fork({ label? })` returns a private branch of this agent's entire committed
  history, current model, and instruction snapshot. `core/branch.ts` materializes
  a detached copy: every tool call gets a deterministic provider-safe id and every
  still-pending call gets an explicit non-success placeholder. The source
  transcript is never mutated. The branch shares the transport (credentials and
  external side effects), never a sandbox. `label` is display metadata, trimmed,
  ≤120 characters, whitespace-only treated as absent.
- A fork's `reset()` restores its fork-time baseline (the cloned history), not the
  live source history. Fork identity lives in a private `WeakMap`
  (`agentBranchOf` from `core/index`, not the package root), so the public `Agent`
  shape carries no nullable branch field.

Construction throws on: missing model, and missing transport (neither `stream`
nor `provider.baseURL`).

---

## tool

A tool is an **executable object**. `tool()` returns a callable with `name`,
`description`, `parameters`, and `execute` attached, so the same implementation
runs from a direct call or from the model's tool call.

```ts
const read = tool<FileReadParameters, FileReadResult>({
    description: 'Read a bounded window of UTF-8 text files.',
    tags: ['files', 'read'],
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } } }, required: ['paths'] },
    execute: async ({ parameters }) => readBounded(parameters)
});

await read(['package.json']);                // direct: no harness, no agent
harness({ tools: { read } });                // the model calls it
// Result: { files: [{ path, content, startLine, endLine, truncated,
//                     nextLine, nextColumn, bytes }], truncated, bytes, contentBudget }
```

- `name` is optional (default `'tool'`). **A harness overwrites it with its
  registry key**, which is the name the model calls.
- `tags` is **required** (at least one, else construction throws). Stored trimmed,
  lowercased, and deduplicated by `normalizeTags()`, so discovery compares
  normalized values on both sides.
- `visibility` is `'core'` or `'searchable'`, default `'searchable'`. An unknown
  value throws. Core tools are declared on every request; searchable tools wait in
  the catalogue for toolRequest.
- `parameters` is plain JSON Schema. TypeBox output *is* JSON Schema, so a
  `Type.Object({...})` can be passed directly — this package needs no schema
  dependency to interop with the rest of the workspace.
- **Single-property rule.** `execute` receives the single property's *value* when
  the schema declares exactly one property, and the whole object otherwise. This
  is what makes `read(['package.json'])` and a model call carrying
  `{ "paths": ["package.json"] }` identical inside the implementation. The harness
  applies it via `unwrapParameters()` → `toolParameterKey()`. Multi-property tools
  such as `syntax({ code, language })`, `glob({ patterns })` and
  `grep({ pattern, patterns })` receive the whole object.
- The tool context is `{ parameters, agent?, agents?, run? }`. The harness fields
  are **optional** because a direct call has none; a tool that needs them must
  check. The presets deliberately do not.
- `execute` may be sync or async; `tool()` normalizes to a promise.
- Throwing is expected: the harness converts it into a tool result.
- `name` is defined with `Object.defineProperty` (a function's `name` is
  read-only) but left writable, so the harness can rename it.
- Construction throws on: missing description, missing tags (or tags that
  normalize to nothing), unknown visibility, missing `execute`.

---

## Tool naming (T14, renamed by T2)

Harness tools are named for what the model calls them. Two shapes coexist on purpose:

- the six everyday capabilities are bare **action verbs** — `read`, `edit`, `shell`,
  `search`, `fetch`, `delegate` — because they are the tools a model reaches for
  constantly and a namespace prefix would only cost tokens;
- a tool that owns ONE action keeps `<namespace><action>`, which is what groups a large
  catalogue for `toolRequest`; a tool that owns a DOMAIN of operations is named for the
  domain (`files` = list/move/copy/delete/mkdir, `tasks` = the task list), because no
  single verb describes it and one call can sequence the operations that belong together.

| Namespace | Tools |
|---|---|
| `tool*` | `toolRequest` (discovery), `toolCreate` (runtime creation), `toolManage`, `toolList`, `toolRegistry`, `toolCancel` |
| `record*` | `records` (the ONE session store every wrapper writes through — one id counter, `define`/`drop` for new collections; records-engine T2/T3) |
| `task*` | `tasks` (session tasks; renamed from `task` by Decision J — the `Todo*` type names stay as legacy aliases) |
| `profile*` | `profiles` (session character/people records; renamed from `profileManage`) |
| `chapter*` | `chapters` (session chapters, summaries + ordered list; renamed from `chapterManage`) |
| `location*` | `locations` (session locations/places; renamed from `locationManage`) |
| `agent*` | `agentManage` (list agents + result previews), `agentResult` (read one completed result) |
| `action*` | `actionRequest` (conditional owner question; `interaction` configured) |
| `thread*` | `threadFork` (conditional private history fork; forks enabled), `threadSend`, `threadList`, `threadRead` (paged FIRST-page transcript read: one message by index, regex/role/includeSystem filters, per-message content paging under a byte budget), `threadDelete` (release one finished thread you own — issue 0027) |
| `file*` | `files` (the domain-named manager of list/move/copy/delete/mkdir; the single-action halves stay bare verbs: `read`, `write`, `edit`, `glob`, `grep`) |
| (verbs) | `read`, `write`, `edit`, `glob`, `grep`, `shell`, `search`, `fetch`, `delegate` |
| (bare verb) | `sleep` (a wall-clock pause the run sets for itself; ONE argument `seconds`, 0–3600 — the `MODEL_TIMEOUT_MAX_MS` ceiling restated — `activation: always` + `mode: sync` + `visibility: searchable` + `order: 145`, so the settled call rather than a timer event is what re-enters the parked run) |
| `text*` | `textCount`, `textSummarize` |
| `time*` | `timeNow` |
| `dice*` | `diceRoll` |
| `note*` | `noteSearch` |
| (already conformant) | `gitDiff` |
(`testFlaky` is gone: the tool and the `flaky` preset that registered it were deleted.)

There are **no aliases**. The T14 spellings (`fileRead`, `fileEdit`, `commandRun`,
`webSearch`, `webFetch`, `agentDelegate`, plus the older `readFile`, `writeFile`,
`editFile`, `listFiles`, `searchFiles`, `globFiles`, `runCommand`, `clock`,
`wordCount`, `roll`, `searchNotes`, `summarize`, `flaky`) are gone from the wire
surface, the exports, the entry file names, the catalogue, the prompts, and the
reserved-name list. The later rename removed `fileWrite` (now `write`), `fileGlob`
(now the pair `glob` + `grep`), `syntaxCheck` (now `syntax`), and `fileList` (now the
`list` OPERATION of `files`) the same way, and the naming rule is simply "name it for
what it does best": bare verbs where a verb is the capability (naming a file, finding a
line, searching, fetching), and the domain name where a tool owns a set of operations.
Two names for one tool makes
discovery ambiguous, and a
compatibility alias would also mean a second catalogue entry the model could pick by
mistake. The public TYPE names (`FileReadResult`, `FileWriteParameters`,
`FileGlobParameters`, `FileGrepParameters`, `SyntaxCheckParameters`,
`WebSearchParameters`,
`FILE_READ_MAX_LINES`, `createWebSearchTool`, …) deliberately did NOT change: they name
a payload shape, a limit, or a factory, not the tool the model calls.

What is deliberately **not** renamed:

- **harness / preset ids** — `general`, `instruct`, `research`, `workspace`,
  `reviewer`, `planner`, `debugger` are identities, not tool names, and sessions/aliases
  reference them (`demo`/`flaky` are deleted, so those two names resolve to nothing). `workspace` keeps its id while its visible title is "Analyst", so
  every saved session and bookmark still resolves;
- **agent ids** — `summarize`'s delegated half still targets the `summarizer` agent;
- **the `websearch` harness configuration field** — it names the *feature*, not the
  tool (`websearch: true | WebsearchConfiguration`), so renaming it would break
  every host's configuration for no API gain;
- **generic helpers** — `createToolCatalogue`, `createToolFrom`, `createToolRunner`,
  `createToolboxHarness`, `createRecordEngine` (the store the record tools write through;
  `createTaskTool` and its three siblings are gone with the per-store factories), `createDynamicTool`,
  `createWebSearchTool`, and native `node:fs` `readFile`/`writeFile` imports are
  functions, not wire names.

---

## Turn modes: sync vs async (T2)

Every tool has an EFFECTIVE turn mode — `ToolMode = 'sync' | 'async'`
(`src/types/index.ts`) — and the documented default is **`'sync'`** (`DEFAULT_TOOL_MODE`,
`src/core/tool.ts`). The mode answers exactly one question: *when this call finishes, may
the agent be re-prompted right now?*

| Declared where | Applies to |
|---|---|
| `registration: { mode }` in a `*.tool.ts` entry | the shipped built-ins: read by the AST scanner (`src/core/tool-scan.ts`), projected into the discovered row (`DiscoveredTool.mode`), copied by every descriptor clone (`src/tools/descriptors.ts`, `src/core/tool-discovery.ts`), and emitted into the generated `src/core/tool-manifest.ts` |
| `tool({ mode })` (`ToolConfiguration.mode`) | every custom tool: a host `tools: {…}` entry, a `toolSources`/`toolFolders` module, a `toolCreate`/`toolRegistry` revision |
| declared nowhere | effective `'sync'` |

Precedence at launch is: the registration policy bound to the PUBLISHED definition
(`modeDefinitions`, set inside `registerDescriptor`) → `definition.mode` → `'sync'`. It is
keyed to the definition OBJECT and never to the wire name, exactly like the rank-projection
marker, the `toolCreation` ceiling marker and the control markers, so replacing `shell` with an
ordinary tool publishes a plain sync tool — no policy leaks onto a replacement.

Behaviour (`runAgentCore`, `deliverTask`, `launchToolCall` in `src/harness.ts`):

- **sync** — the call joins the SYNC GROUP of the assistant message that requested it
  (`RunState.syncGroups`). A member is removed only once its outcome was DELIVERED, and
  the group wakes the run exactly ONCE, when its last member settled; success, failure,
  and cancellation all settle. Three sync calls in one message therefore cost ONE extra
  turn, and a lone sync call starts its next turn only after it finished.
- **async** — the completion marks the run dirty immediately and triggers its own turn,
  even while another call from the same message is still running.
- The batch gate (`waitForSyncBatch`) is a PARK, never a block: any other wake (an async
  completion, the recurring heartbeat, a steer, a parked delivery failure) or the run's
  abort signal releases it, and no delivery is ever delayed by a pending sibling. The
  heartbeat is not on hand for a `sync`-only park, though: it arms only while at least one
  pending call resolves to `mode: 'async'` (`src/plugins/async-ping.plugin.ts`), so such a
  park releases on its own group settling, on a steer, or on the abort signal. The
  implementation stays background work — scheduled on the board, cancelable per call,
  delivered through the agent mailbox in canonical order.
- Groups are per run, so a delegated, `ctx.run`, or branch run never holds its parent's
  batch.

Shipped values: `read`, `edit`, `search`, `fetch`, and `actionRequest` are `'sync'`;
`shell`, `delegate`, and `threadFork` declare `'async'`. `threadFork` is the deliberate
control-tool exception: a fork's answer arrives independently of the requester's batch
(that dispatch never joins a group), and making it sync would hold a batch hostage to a
detached clone. `actionRequest` is `'sync'` because the requester's wait IS the hold, not
a placeholder turn: while a run owns an unsettled request the turn loop issues no model
request (`waitForActionRequests`, `src/harness.ts`), and an owner answer, a `toolCancel`,
or expiry is what releases it — the scheduler owns no clock. The owner that answers a
CHILD request is a distinct agent (actor key `branch:<id>`, its own scope), so a child
never waits on itself and no lane head-of-lines. A batch of questions in one message
therefore costs ONE turn, after the last answer.
`toolCancel` is answered inline and declares nothing, so its default is inert.

`src/harness.sync-async.test.ts` pins the whole contract — the completion orders of a
mixed sync/async batch, a singleton sync, an all-sync batch, an async-only batch, two
batches in one run, two concurrent runs, failure and cancellation as settled members, and
the no-leakage-onto-a-replacement rule. Its `batch gate races` block adds the two
park-specific checks: an abort releases a parked gate (the run rolls back instead of
waiting on a call it will never deliver), and a sync call that settles inside its own
launch round spends no extra turn. `src/harness.background.test.ts` and
`src/harness.races.test.ts` now declare `mode: 'async'` on the probe tools whose whole
point is a call that stays pending while the run keeps taking turns: under the sync
default those frames would never be emitted, so the mode is stated rather than assumed.
`src/tools/presets.test.ts` pins the sync side from the other direction: `read` does real
I/O, and its transcript is `user → assistant → tool → assistant` with no placeholder turn.

---

## Tool discovery

The rework that keeps a large catalogue out of the context window. A request
declares:

- every `visibility: 'core'` tool, and
- every searchable tool the ENABLED set carries — what `toolRequest` or `toolManage`
  has switched on, plus whatever the host seeded at construction
  (`HarnessConfiguration.enableAllTools`, `src/types/index.ts:4008`; a library
  caller gets an empty set unless it asks, the shipped server asks for every session
  it creates, see below).

**Every harness preloads the preset catalogue** (`src/tools/`) unless it is
created with `presets: false`. **Five file tools are core (R18)** —
`read`, `write`, `edit`, `glob`, `grep` — so they are declared on every
request and need no discovery. `files`, `syntax`, `shell`, and
`gitDiff` stay searchable: a model that needs a directory listing asks for
`files`/`list`. A configured tool replaces a preloaded preset of the same name.
The harness-owned `toolRequest` and `tasks` are core too, and so is the
environment-backed web pair: `search` when a provider key resolved, `fetch` when
the host opted into `webfetch` (R9-R11). The remaining harness-owned rows
(`toolList`, `toolManage`, `toolCreate`, `records`, `profiles`, `chapters`,
`locations`, `knowledge`, `agentManage`, `agentResult`, `sleep`) stay registered but SEARCHABLE —
`records` deliberately so (R4): it is the escalation surface an agent reaches by NAME
when a wrapper's schema is what stops it, and its tags are the ENGINE's words only
(`records`, `record`, `store`, `entries`, `define`), never the wrappers' collection words,
exactly like the always-registered `download` preset: the model opens them with
`toolRequest`. `knowledge` joins the list on the same rule — `activation: 'always'` registers
it on every harness, `alwaysDeclared: false` keeps its description and schema out of every
request until something asks for it, and its tags (`knowledge`, `article`, `articles`,
`search`, `read`, `edit`, `reference`) are what that query matches
(`src/tools/runtime/knowledge.tool.ts:199`, `:200-208`, `:567-574`;
see [Cross-session knowledge](#cross-session-knowledge)).
`delegate` is core for every agent of a roster that spans two or more ranks, and its declared
description and target hint are projected PER CALLER onto that caller's strictly-lower-ranked
targets (a caller with no lower-ranked peer is not offered it at all);
`actionRequest` is core only when `interaction` is configured; `threadFork` is
core when `forks.enabled` (the
default). Both are registered as standalone definitions whose `execute` refuses a
direct call, because the runtime handles them with the owning run.

**Core is not session-bound.** The five core file tools, `download`, `search`,
and `fetch` have real implementations, so the server's direct-call path runs them
without a `sessionId`.
Only the harness-owned set mutates a session's harness and therefore carries
`sessionBound: true`. `knowledge` carries the flag for that reason alone, and NOT because what
it writes belongs to the session: the flag says the CALL needs a session's harness — that is
where its `harness.knowledge` seam lives — while the articles it writes land beside
`harness/sessions/`, outside every session folder
([Cross-session knowledge](#cross-session-knowledge)). There is no `fileSearch` tool and no mode switch either:
`glob` lists names and `grep` searches contents, both under their own name, and both
are core.

**The toolbox is per session; the switches above it are not.** Which names a harness
has declared — every core tool this conversation has NOT switched off, plus whatever the
enabled set carries, i.e. what `toolRequest` or `toolManage` has switched on plus what the host
seeded at creation (the note below this list) — is per-harness state (the enabled `Set`, and the
conversation's withheld `Set` beside it, both cleared by `reset()`, above), and
the server keeps one live harness per session, so discovery is per conversation. A
CPU-isolated lane worker is a REPLICA of that same session and reports both of that harness's
lists (`lane-authority.ts` `enabledNow()`/`toolStateNow()`, the payload of the `sync.tools`
frame below). Two
surfaces sit ABOVE that set, and their scope is a contract, not an implementation detail:

- the deployment **deny list** has one store per PROCESS (`src/server/tool-settings.ts:1-2`
  — "which tool names this deployment runs, for EVERY session and EVERY thread at once").
  `harness()` consumes it through `configuration.toolSettings` and re-reads the provider on
  every turn (`src/harness.ts:1540-1543`), so `PATCH /v1/harness/tools/:id` moves the next
  turn of every session and thread. A session CAN switch any name in its own toolbox off
  or on — every registered name, the core declarations and the pending-only controls included,
  through `PATCH /v1/harness/sessions/:id/tools/:tool_id` and the withheld set below — and that
  is not a copy of this
  switch: the deployment entry is re-applied on top of it, because every harness filters the
  request list through the provider (`src/harness.ts:4567-4581`) and refuses the LAUNCH of a
  denied name (`:7845-7853`) — a session cannot lift a deployment denial. One carve-out is
  part of the contract: the MANUAL path (`harness.executeTool` and both server
  tool-execution routes) is not gated by the switch, so an operator can still run a name the
  model was denied (`src/harness.ts:7848-7850`);
- **plugin settings** have one store per SCOPE — the template plus a detached copy per
  session — which is the `src/server/plugins.ts` header's "THE TWO SCOPES" (R4); see
  [CLI, server, and UI](#cli-server-and-ui).

CORRECTED IN PLACE 2026-11-13: this bullet list is new — the section previously said
nothing about scope, which read as "process-wide, like the deny list". The copy is taken at
session creation (`src/server/plugins.ts` `copyPluginSettingsStore:713`, called from
`src/server/sessions.ts:2268`) and injected with the harness (`src/server/sessions.ts:2490`,
`pluginSettings: plugins.provider`), so `PATCH /v1/harness/plugins/:id` changes only the
sessions created AFTER the write while `PATCH /v1/harness/sessions/:id/plugins/:plugin_id`
(`src/server/api.ts:2864`) changes one live conversation from its next turn. A session's own
tool REGISTRATIONS were always session-scoped
(`/v1/harness/sessions/:id/tools[/:tool_id]`) — the distinction worth keeping is that a
registration changes what THIS session holds, while the deny list changes what the
DEPLOYMENT runs at all.

CORRECTED IN PLACE 2026-11-13: the paragraph above this list stated that the declared set is
"every core tool plus whatever `toolRequest` has enabled", as if nothing else could ever
populate the enabled set. That is the LIBRARY posture and it still holds — `harness({})`
starts with an empty enabled set and only a switch moves it (`toolRequest`,
`toolManage enable|disable`, or a host write) — but a session the SERVER
creates does not start that way. `SessionStore.create` builds its harness with
`{ enableAllTools: true }` (`src/server/sessions.ts:2204`, forwarded into the configuration at
`:2430`), so a conversation that has never run begins with every registered name that can hold
a cap slot already enabled: the ask was a harness that is usable immediately instead of one that
has to discover its own catalogue first. The flag is an opt-in SEED
(`src/types/index.ts` `HarnessConfiguration.enableAllTools`), not a policy change, and five
things decide what it seeds:

- the QUALIFIER is the kernel's own, not a list: the seed is ONE `enableTools` pass over
  `Object.keys(tools)` (`src/harness.ts` `seedSwitchableTools`, the pass it delegates to at
  `enableTools`) — the same path a `toolRequest` match
  takes — so `occupiesSearchableSlot` is
  what keeps a `visibility: 'core'` name and a pending-only registration OUT OF THE CAPPED SET
  (they never hold a slot, so the seed has nothing to switch on for them; it is NOT a statement
  that those names cannot be switched — see the withheld set below). It runs after the LAST
  startup registration, plugins included, because "what can hold a slot right now" cannot be
  answered before everything that answers it has registered;
- a name the host's GLOBAL tool provider has disabled is filtered out BEFORE the pass
  (`isToolGloballyDisabled`, applied inside `seedSwitchableTools`) — the seed never
  spends a cap slot on a name the deployment switched off, and a session still cannot lift that
  denial;
- a name THIS CONVERSATION has switched off is skipped by the same pass
  (`isToolWithheld`, applied beside `isToolGloballyDisabled` in `seedSwitchableTools`, and again
  by the `Harness.enableAllSwitchableTools` re-seed): the seed is an AUTO-enable, and a capacity
  pass that ignored the withheld set would quietly undo every switch the user made the moment a
  host re-seeded — a reset re-run, a restore, a plugin calling the seam. Only the user switching
  a name back on does that;
- `maxEnabledTools` (default 32) still binds and is NOT raised for the
  seed: an over-cap catalogue keeps the first `maxEnabledTools` names in registration order
  and leaves the rest off, which the rows report as `enabled: false`. Overflow is never a
  throw — it is the same `omitted` outcome a beyond-cap `toolRequest` match gets
  (`enableTools`);
- the flag is NOT snapshot state: `harness.restore()` ends by replacing the enabled set with
  the persisted `discovery.enabled` (`src/harness.ts` `restore()`), so a restart never switches a tool
  back on for a conversation that had switched it off. CORRECTED IN PLACE 2026-11-13: this bullet
  used to say "the restore path does not re-apply it (`src/server/sessions.ts:3808`)", and that is
  now only half true — the SERVER does pass the flag on the restore build (`:3843`), because the
  reset seam below is gated on that per-process configuration and an unseeded restore disarmed
  it: `create → reset` answered 22 enabled while `create → restart → reset` answered 0, and the
  emptiness then persisted. What the bullet's guarantee actually rests on is the overwrite in
  `restore()`, not the absence of the flag, so the refill never happens on a restart either way
  (pinned by `src/server/session-reset-toolbox.test.ts`, including the committed-EMPTY case, which
  is also the shape of a record written before the seed existed: a legacy session refills on its
  first RESET and never on a plain restart — nothing per-record is stored, so nothing migrates).
  CORRECTED IN PLACE 2026-11-13 (F2-2): the sentence
  this bullet used to carry — "`reset()` still empties the set — a cleared conversation is a
  different event from a new one" — is true of the KERNEL and was false of the SERVER. The
  kernel's `reset()` does empty it (`src/harness.ts`), and the server now re-runs this same
  pass straight after (`src/server/sessions.ts` `SessionStore.reset`, via
  `Harness.enableAllSwitchableTools`), because a reset conversation is a NEW conversation and
  leaving it at zero enabled rows reproduced the very complaint the seed exists to answer.
  The distinction that survives is create/restore, not create/reset;

**A conversation switches ANY registered name off — through a withheld set, not by membership.**
CORRECTED IN PLACE 2026-11-13: this block is new, and it retires the rule it restates wherever
this file carried it: `toolRequest`, `tasks`, `delegate`, `read`/`write`/`edit`/`glob`/`grep`, a
configured `search`/`fetch` and the pending-only `toolCancel` used to be UNSWITCHABLE — refused
by the kernel, `403`'d by the route, and rendered as an unswitchable "always in context for this
conversation" tile. All three of those are gone, and the reason is the mechanism. The
off-switch is a per-harness `withheldTools` Set (`src/harness.ts`, exposed as
`Harness.withheldTools`, `src/types/index.ts`) — a different fact from the capped `activeTools`
set, not a second view of it:

- **Every registered name is switchable.** The one kernel is `applyToolSwitch`
  (`src/harness.ts`): it writes `withheldTools` for EVERY name, and additionally moves the
  capped set for the names that have one. A core or pending-only name never had a slot, so for
  it the withheld set is the ONLY record of the switch;
- **Cap math is untouched.** `occupiesSearchableSlot` — and the `Harness.isToolSwitchable`
  forward onto it — still mean exactly "occupies one of the `maxEnabledTools` cap slots", which
  is all they ever decided, and they are NO LONGER the switchability story. A core/pending-only
  switch costs and frees no slot and never evicts anything, and such a name can never be evicted
  by the cap. The switch operations (`toolManage enable|disable`, the plugin seam
  `api.enableTool`/`disableTool`, and the operator's PATCH) all land on that one kernel, and
  `requireSwitchableTool` refuses only a blank name and an unregistered one;
- **Real time, no rebuild.** `visibleCoreTools`, the per-request declaration list, the launch
  gate and `toolRequest`'s catalogue each read the set live — per model request and per launch —
  so a switch made while a thread is running lands on that thread's very NEXT request. Nothing
  is un-registered and no promised schema vanishes mid-turn, which is why the `enabled`-only
  session PATCH carries no idle gate (the route note in "Two settings scopes, three catalogue
  scopes", below);
- **Its scope is the agents and threads of that conversation, never the implementation.** A
  nested call made by another tool (`context.callTool`) and a manual REST execution
  (`POST …/sessions/{id}/tools/{tool_id}/executions`, `harness.executeTool`) still run a
  switched-off name — exactly as they run an evicted or never-discovered one — no other session
  moves, and no deployment setting is written;
- **Discovery hides it entirely.** A withheld name is absent from `toolRequest`'s `tools`,
  `matched` and `omitted`, from `availableTags` and from `alreadyAvailable` (the catalogue
  filter and `declaredForDiscovery` both drop it), so no match can re-enable it and a model
  cannot search its way back. It is deliberately NOT reported under `forbidden`: that field
  stays the delegation allowlist (`scope.tools`) plus the deployment deny list — the two denials
  that are stable for a whole run and can be explained to a model. Calling the name anyway
  answers the session-scoped refusal, `Tool "<name>" is switched off for this conversation by its
  user. Calling toolRequest will not find it and asking again will not change this answer.`
  (`src/harness.ts` `sessionDisableReason`, read by the launch gate at call time). The unknown-tool
  answer beside it drops its "call `toolRequest`" hint when `toolRequest` is itself withheld, so
  a model is never told to use a door its conversation closed;
- **The wire states two axes, and they are not the old two.** `SessionToolSummary.enabled` is
  the CALL axis — `!withheld && (occupiesCapSlot ? in the capped set : true)` — so `false` means
  either "this conversation switched it off" or "the cap has no free slot for it", and only the
  first lands in `withheldTools`. The row carries no separate withheld flag, so for a SEARCHABLE
  name those two `false`s are indistinguishable from this read alone, while for a slotless one
  (a core declaration, the pending-only `toolCancel`) `false` can only mean switched off.
  `SessionToolSummary.protected` is the UNREGISTER axis — `visibility === 'core'` read from the
  live registry map, i.e. exactly the `DELETE` `403` — and no enable/disable PATCH consults it.
  The consequence a pane has to absorb: `toolCancel` is now `protected: false` (it registers at
  `visibility: 'searchable'`, so `remove` accepts it) while
  `write`/`read`/`edit`/`glob`/`grep`/`fetch`/`toolRequest`/`tasks`/`delegate` stay
  `protected: true` — for `DELETE`, and for nothing else;
- **It persists as conversation state.** The snapshot records it as `discovery.withheld`
  (`src/types/index.ts` `HarnessSnapshot.discovery`), OMITTED while empty — the shape that is why
  `HARNESS_SNAPSHOT_VERSION` cost NO version bump when this key landed (an absent key restores
  as "nothing switched off"). The constant is `3` today (`src/core/snapshot.ts:107`), and that
  bump came from the rank vocabulary — `results[].rank` replacing v2's `role` — not from this
  key, and restore drops a name the rebuilt harness does not register LENIENTLY, never a
  throw (what strictness costs here is the rationale in
  `src/server/restore-enabled-tool-prune.test.ts`). A
  stale switch on a vanished name therefore goes silently, and if that name is registered again
  it comes back ON. `reset()` clears the set — a new conversation starts with everything on —
  and a restart preserves it, and `pruneStaleEnabledTools` (`src/server/sessions.ts`) now prunes
  the withheld list to registered-or-recreated names on the same tolerant rule it already applies
  to `enabled`;
- **A worker lane gets it two ways.** A replica starts from `LaneBlueprint.withheldTools`
  (`src/server/workers/protocol.ts`, filled by `SessionStore.blueprintFor`,
  `src/server/sessions.ts`, and applied by `applyToolStateSync`,
  `src/server/workers/lane-worker-loop.ts`), and the design keeps a WARM lane honest with a
  one-way `sync.tools { enabled, withheld }` reconcile frame (`LaneToolStateSync`,
  `src/server/workers/protocol.ts`) whenever the session's canonical tool state moves, so a
  disable reaches a live lane instead of waiting for it to be recreated: `lane-authority.ts`
  `toolStateNow()` is the canonical read and `lane-host.ts` `broadcastTools()` the session-wide
  push. The frame is additive — `LANE_PROTOCOL_VERSION` did not move — and its applier DROPS a
  name the replica cannot register (a preset `tool()` object cannot cross a thread, and
  `refuseNestedRuns` deletes `delegate` from every replica) instead of throwing. The frame, the
  applier, the canonical read and the push are all at source in `src/server/workers/` and pinned
  at the wire level by `src/server/workers/lane-tool-reconcile.test.ts`; the route-side call that
  posts it is stated here as the design, not as an executed observation.

The hazards are the accepted cost, and they are worth recording rather than smoothing over:
disabling `toolRequest` removes the model's only switching door, so recovery is user-side only;
disabling `tasks`/`delegate`/the thread controls leaves the server-side machinery running while
the model loses its writer and its dispatcher; disabling `toolCancel` removes the only way for a
model to withdraw an in-flight call; enabling a searchable name can still EVICT another enabled
name through the cap; and a session can hold a name `enabled` while the deployment deny list
still refuses it, because deployment outranks session in both directions.

The public seam that comes with the seed is `Harness.isToolSwitchable(name)` (`src/types/index.ts`
→ `src/harness.ts`, a bare forward onto `occupiesSearchableSlot`). Since the session switch it
states cap arithmetic ONLY: "would this name hold one of the `maxEnabledTools` slots", true
exactly while it resolves to a live definition that is neither `visibility: 'core'` nor
pending-only. It is not the predicate the switch refuses with (that is `requireSwitchableTool`:
blank and unregistered names only), and it is no longer the negation of a session-tool row's
`protected` figure — that field is the kernel's `remove` rule (`src/server/api-reads.ts`
`sessionToolRowsOf`), so the two are independent: `toolCancel` is `false` on BOTH (no slot, and
removable) while `write` is `false` on the cap predicate and `true` on the unregister one. What
the seam is still for is a host that has to know which rows are CAP-MANAGED — which names an
enable spends a slot on, and which an over-cap selection evicts. A host that re-derives THAT from
catalogue metadata gets it wrong in both directions: `toolCancel` is demoted to
`visibility: 'searchable'` at registration (`src/harness.ts`) yet stays pending-only, so it holds
no slot, while a searchable preset row such as `shell` looks core-adjacent and genuinely holds
one. A host that wants "what has this conversation switched off" reads `Harness.withheldTools`.

**toolRequest is built by the harness**, not shipped in `src/tools/`. It has to be:
it closes over the live registry and the harness's active set. It is registered
after the declarative tools and before plugins, is always core, and its name is
reserved (`harness()` throws if the config or a preset already has `toolRequest`).
`toolCreate`, `records`, `tasks`, `profiles`, `chapters`, `locations`,
`agentManage`, `agentResult`, and
(when the roster spans two or more ranks) `delegate` are reserved the same way, as are
`actionRequest` and `threadFork` when their configuration registers them.

- Signature: `toolRequest({ names?: string[], regex?: string, tags?: string[],
  limit?: number })`. The three query fields are OR-ed into one UNCAPPED union by
  `selectTools` (`core/discovery.ts`); an exact name is case-sensitive, a regex may
  be bare source or `/source/flags`, and tags keep the fuzzy ranking. A bare array
  or a missing `tags` is tolerated as a legacy tags-only call. Name, description,
  tags, and schema live in the tool's own `tools/runtime/toolRequest.tool.ts` entry;
  `core/metadata.ts` is a data-only compatibility projection of the generated
  descriptor manifest (`core/tool-manifest.ts`) that the server catalogue also
  reads. `limit` narrows only the current query; it is not a global request cap.
- Result: `{ enabled, tools: [{ name, description, tags }], matched, omitted,
  evicted?, unmatchedTags?, availableTags?, alreadyAvailable? }`.
  `enabled`/`tools` are THIS call's matches admitted by `maxEnabledTools`
  (default 32, core tools excluded), `matched` is the whole union, `omitted` is
  the selected matches beyond the cap/limit, and `evicted` names prior enabled
  tools displaced by this call. `enabled` doubles as the ranking order.
- The harness owns the per-turn bound. Every selector kind switches the set:
  this call's ordered matches lead (`maxEnabledTools` maximum), prior enabled
  entries fill leftover capacity, overflow is reported as `omitted`, and displaced
  prior names as `evicted`. `declared()`, tool authorization, `discoveredTools`,
  and snapshot all read the same capped set, so a restored snapshot cannot exceed
  the current configuration. Core tools are declared unless this conversation has switched
  them off, and never count against the cap.
- `selectTools(tools, query, options?)` is the pure uncapped selector; the legacy
  `searchTools(tools, tags, limit?, offset?, options?)` remains for existing hosts.
  Both are exported from the package root. Only `visibility: 'searchable'` tools are
  candidates for ENABLING — core tools are already declared, unless the conversation switched
  them off, in which case they are not a candidate either: a withheld name is excluded from
  the catalogue `toolRequest` selects from, from its `availableTags`, and from
  `declaredForDiscovery`'s core view, so no match list can re-enable it and a search cannot
  resurrect it (`src/harness.ts`).
- Scoring is **OR-style, best-match**: each query tag scores a tool (exact tag 4,
  tag prefix 3, tag contains query 2, query contains tag 2, name/description
  contains query 1), and the tool's rank is its **best single-tag score**. More
  matching tags only breaks ties (then name), so breadth can never outrank an
  exact hit. Prefix needs two characters, fuzzy needs three. Exact requested names
  rank first in caller order, then regex name hits, then tag matches.
- `MAX_DISCOVERY_MATCHES = 5` belongs to the legacy `searchTools` answer only.
  `toolRequest` never uses it.
- `alreadyAvailable` reports CORE tools the CALLER already has declared
  (`options.declared`, supplied by the harness from `visibleCoreTools`). This is a
  report only: they are never enabled, never counted against the bound, and their
  query tags are added to the matched set so `unmatchedTags` cannot claim an
  already-callable capability is absent. Core matching is deliberately stricter:
  wire NAME, TAGS, and exact/regex NAME only — never the description, whose
  everyday words would match almost every query. The caller's view is what makes
  it honest: `delegate` is declared with the CALLER's own legal targets in its description
  (`delegateDeclarationFor`, `src/harness.ts`), and is withheld entirely from an agent nobody
  ranks below — so a Rank B model is never told it may hand work to a Rank A peer, and a
  single-rank harness has no such row to advertise.
- `availableTags` (the sorted vocabulary of searchable tools) is returned when
  nothing matched or when the query was empty, so a failed query teaches the model
  the real tags.
- Active tools live in a `Set` per harness: discovery survives across calls and is
  cleared by `reset()`. `harness.discoveredTools` exposes the names (a copy); a
  server snapshot records them so a reload can show the discovery state.
- An **undiscovered** tool is not callable: the harness answers the call with a
  tool result naming tags that would enable it. The model cannot bypass discovery
  by guessing a name.
- `declared()` builds the request list core-first, then the current capped enabled
  set, and is rebuilt for every request, so a toolRequest round shows up on the very
  next turn. Authorization reads that same set; a same-turn call evicted by an
  earlier toolRequest is rejected. `delegate` is PROJECTED per agent rather than skipped by
  role: its description names that agent's strictly-lower-ranked targets, its schema enum stays
  the whole roster on purpose (a narrow enum answers a wrong guess with `$.agent must be one
  of: …`, which cannot name a rank), and it is left out of the list for the one caller with no
  lower-ranked peer.

**toolManage persistence:** `create`/`update` default to `persist: "folder"`.
A pathless create requires `name` and writes `<name>.tool.ts` under the LAST
configured folder; a pathless update reuses the captured absolute owning path when
it is inside a configured folder. Explicit `path` must be inside one of those
folders. `persist: "runtime"` is the explicit no-disk mode and cannot combine with
`path`/`folder`. Disk-backed publications bypass `createdToolRecords` and
`maxCreatedTools`; restart re-scans the folder. Failed writes restore the prior
bytes (or delete the new file) and surface rollback failure.

---

## Session tasks

`src/core/task.ts` is the `tasks` **collection SPEC** — 66 lines of field definitions,
caps, count facets, the canonical field order and the wrapper mapping. It used to be the
whole task store (~1,700 lines of CRUD, bounds, pagination, CAS and change feed); all of
that now lives ONCE in the engine, `src/core/records.ts` (records-engine T2/T3, finding
F9). The wire tool is `tasks`, named and described by `TASKS_NAME`/`TASKS_METADATA`
(`src/tools/runtime/tasks.tool.ts:20-22`), and it holds no state and no logic of its own
(Decision E). The spelling history: Decision J renamed the TOOL to the plural, Decision K
made the collection key identical to the tool name, Decision I kept it `core`, and R9-R11
renamed the original `todoManage`.

It is still a **deliberate exception to the stateless-tool rule**: the state lives in the
engine instance the harness constructs (`src/harness.ts:4372`, `createRecordEngine()`), never in a module
singleton, so one harness owns exactly one store and two harnesses — i.e. two server
sessions — can never share records.

```ts
// One STORE per harness, owned by the engine — not one factory per tool (records-engine T2).
const engine = createRecordEngine();   // collections + the single id counter + reset/snapshot/restore
```

- The wire shape is one **merge command**, not an action enum: `tasks` holds patch
  entries, `remove` holds ids, `ids` reads specific records, and
  `offset`/`limit`/`afterId`/`since` shape the answer. No
  arguments (or `{}`) is a read. An entry **without** `id` adds a task (`text`
  required); an entry **with** a known `id` patches it — `text` and/or `completed`,
  whichever are sent; omitted fields are unchanged. An unknown id, an entry with
  neither `text` nor a known `id`, one id in two of the three id lists, or an id
  patched twice are all rejections. (`claim`/`release`/`takeover` were parameters too;
  they died with the lock — see the Decision P note below.)
- The whole patch is validated **before** anything mutates, so a rejected call
  leaves the records, the id counter, `storeRev` and the change log exactly as they
  were. Apply order is fixed: claims → releases → takeovers → expired-claim clears →
  patches → removals → additions.
  **Corrected in place (records-engine Decision P, 2026-11-09):** the first four steps died
  with the claim protocol, so the order the engine implements is **patches → removals →
  additions**. There is no `claim`/`release`/`takeover` verb, no `leaseMs`, and no
  `owner`/`ownerThreadId`/`leaseUntil` on a record: **every patch is accepted unless it is
  stale**, and a stale rejection returns the CURRENT record (R9). The sentence above is kept
  so the reasoning stays auditable; `src/core/records.ts` is the implementation.
- Ids are decimal strings (`"1"`, `"2"`, …), monotonic per harness and unique across
  EVERY collection of the store (F3 — one counter, so a task id and a chapter id can no
  longer both be `"1"`); a removed id is never re-used. `reset()` clears every
  collection with its counter, per-collection `storeRev` and per-collection window.
- **Every record carries concurrency state** (T1), on top of `id`/`text`/`completed`:
  `rev` (its CONTENT revision — 1 on add, `+1` only when trimmed `text` or
  `completed` actually changes, so a restated value is a silent no-op FOR THE PATCH
  ITSELF, and the answer names that id in `noopIds` instead of leaving the caller to
  re-read `rev`) plus the write attribution `updatedBy`/`updatedThreadId`/`updatedAt`. Those
  five are the RESERVED entry keys — `id, rev, updatedBy, updatedThreadId, updatedAt`
  (`src/core/records.ts:288`) — so no collection may define a field that claims one.
  Attribution comes from the
  `ToolContext` (`agent?.name`, `threadId`), never from arguments, so a model cannot
  forge it. Optional fields stay ABSENT rather than `undefined`-valued. (CORRECTED IN
  PLACE 2026-11-11: the "optional claim triple `owner`/`ownerThreadId`/`leaseUntil`"
  this bullet used to list no longer exists.)
- **Every recorded event also bumps the store**: one `RecordChange` per accepted change
  goes into THAT collection's FIFO window capped at `RECORD_MAX_CHANGES` (200,
  `src/core/records.ts:165`) and that collection's `storeRev` advances by one; the op is
  `add` | `update` | `remove` ONLY (`src/types/index.ts:1904` — `claim`/`release` are
  gone, so there is no ownership event to log and nothing to sweep when a thread dies).
  A no-op patch records nothing, which is why a heartbeat cannot knock a reader off its
  revision — and the key that says so is `noopIds` (the envelope bullet below): present
  whenever such a patch happened, at any count, and disjoint from `changedIds`, because an
  id is either in one or in the other (`src/core/records.ts:3235-3247` is the single branch
  that classifies it, `:3362` emits it). Its ONE producer at a tool door today is a patch
  whose NAMED fields already hold those values: an entry that names an `id` and sets no
  field at all is refused outright by `readEntryInput` — `tasks "tasks[0]" names id "1" but
  sets no field; read it with "ids" instead.` (`src/core/records.ts:1676-1681`, pinned at
  `src/core/records.test.ts:2861-2872`) — so the "names no field" shape `noopIds` also
  covers in principle has no door that can produce it.
- Every success answers the SAME bounded envelope, with no action wrapper:
  `{ tasks, counts: { total, completed, pending }, page: { offset, limit, hasMore,
  nextOffset? | afterId? + nextAfterId?, budgetTruncated? }, storeRev, entry?,
  removed? | removedIds?, addedIds? | changedIds? | noopIds? }` (20 items by default, hard
  maximum 100, and a 64 KiB page budget charged against the serialized items themselves and not
  the JSON around them — `src/core/records.ts:2758-2769` — which stops at the first item that
  would cross it, while the first item of a non-empty page always lands). `tasks` is the current
  page — including right after an add, a
  patch or a removal — and is a defensive copy, so mutating a
  result can never mutate the session list. `entry` is present when ONE record answers
  (an `ids` read or a single patch), `removed` when exactly one record was deleted and
  `removedIds` when two or more were; `budgetTruncated` appears only when the byte
  budget cut the page short of `limit`. **The three id receipts follow a DIFFERENT
  presence rule from `removed`/`removedIds`, and that is the whole contract**: `addedIds`
  (every id the call minted, in mint order), `changedIds` (every id it REALLY patched, in
  caller order) and `noopIds` (every id whose patch wrote nothing) are each emitted
  **whenever that kind of write happened at all — at any count, and independently of each
  other**, so a batch of one add plus one patch names BOTH ids while `entry` stays out
  (`src/core/records.ts:3336-3362`, mirrored key-for-key by the wrapper at
  `toWrapperResult`, `:3827-3834`; pinned at `src/core/records.test.ts:2531-2558` and
  `src/harness.task.test.ts:399-417`). A caller branches on which KEY is present, never on
  a count: an empty list means the key is absent, each key keeps one stable type (an array
  of ids), and an id is in `changedIds` or in `noopIds`, never both. `entry` is
  singular-only and is a CONVENIENCE, not a suppression condition — a one-record add
  answers with `entry` AND `addedIds: ["1"]` (`src/harness.task.test.ts:278-280`) — and the
  receipts are emitted whatever `limit` says, because the page is a plain projection and
  `{ limit: 1 }` is the documented cheap-write recipe. A read answers with NONE of the three
  (`src/harness.task.test.ts:438-440`). `counts` always describes the WHOLE
  collection, never the page. Caps: 200 tasks and 4000 characters of text each
  (`TASK_MAX_RECORDS`/`TASK_MAX_TEXT`, `src/core/task.ts:35-36`). The whole description —
  this key set included — is pinned byte-for-byte by `src/harness.metadata.test.ts:307-309`
  against `src/tools/runtime/tasks.tool.ts:47`.
- **Two cursors, deliberately different.** `offset` is an index; `afterId` is a
  keyset cursor over the numeric ids ("everything after id 7"), which cannot skip or
  repeat a record when another agent deletes one mid-walk. The walk runs in **id
  order**, which on a `sortable` collection is NOT the page order, and one walk may not
  mix the two modes: passing an EXPLICIT
  `offset` alongside `afterId` is a rejection, and a keyset page reports `afterId`
  plus `nextAfterId` while `hasMore` — never `nextOffset`.
- **The change feed** is the cheap alternative to re-reading: `since: <storeRev>`
  adds FIVE keys, and nothing else adds any of them — `changes` (the events after that
  revision, oldest first, at most `RECORD_MAX_CHANGES_IN_RESULT` = 50 entries — `src/core/records.ts:166` —
  and no further than `responseBudgetBytes` allows once the WHOLE serialized page has been
  charged against it, `:2880-2891`), `changesHasMore` (**the page was cut**: this answer carries
  fewer events than exist above `since`, measured against the whole post-`since` set, by the
  50-entry cap OR by the byte budget — `:2899` — which withholds later events and loses
  nothing the reader was owed), `changesTruncated` (**the retention floor**: the retained
  window no longer covers `since + 1`, so the reader never saw part of the gap —
  `:2900-2906`), `oldestAvailableRev` (the floor itself: the oldest revision this
  collection's window can still show) and `droppedEvents` (its SIZE —
  `max(0, oldestAvailableRev - since - 1)`, the events strictly BELOW the floor that are gone
  for good, `:2907-2922`). **What `responseBudgetBytes` bounds is the PAGE, not the answer, and
  the feed is appended after it on purpose.** The page loop charges `JSON.stringify(entry)` plus one
  separator per record against the budget, stops at the first record that would cross it, and
  always admits the first record of a non-empty page (`:2758-2769`). The feed is the LAST thing
  added, because the page the caller asked for is authoritative and "a feed that only reported
  'more exist' after every 4 KiB page would be useless" (`:2709-2710`, `:2877-2879`); its trim loop
  seeds `used` with `JSON.stringify(result)` — the page answer so far, `counts`, `page`, `storeRev`
  and `oldestAvailableRev` included — and then charges only the event payloads, so the feed's own
  keys (`"changes":[…]`, `changesHasMore`, `changesTruncated`, `droppedEvents`) are written AFTER
  the loop and never charged at all, and the first retained event lands whatever it weighs
  (`:2880-2922`). A feed-bearing answer therefore ends up a small FIXED amount over the declared
  budget — roughly 80 bytes of key names and brackets, plus at most one whole event past where the
  trim stopped — and that overshoot does not depend on how many events were dropped, because
  `droppedEvents` sizes what the retention WINDOW lost while the byte budget only withholds events
  that are still retained (the `changesHasMore: true` / `changesTruncated: false` case just below).
  Next to the one real whole-answer cap — `boundToolResult` in `core/result-budget.ts`,
  `MODEL_TOOL_RESULT_BUDGET_BYTES` = 256 KiB, which bounds the serialized text of every model-facing
  result and every tool error — the overshoot is noise at the default 65536; it is a `define`d 1024
  budget where a caller that reads the number as an exact response ceiling gets bitten. No records
  or tasks test measures bytes, so nothing in the suite pins the total size of a feed-bearing
  response. The two booleans are not one signal and neither is the number:
  `changesHasMore: true` with `changesTruncated: false` and `droppedEvents: 0` is a reader
  that simply has more to read (`src/core/records.test.ts:3196-3230`), and a reader parked at
  `since = floor − 1` loses nothing even though the window has trimmed behind it
  (`src/core/records.test.ts:3256-3260`). `windowFloor` (`:1517-1525`) is the only source of
  the floor and has two branches a consumer cannot derive from the messages: an EMPTY window
  reports `storeRev + 1` — nothing at or below `storeRev` survives, whether the window was
  trimmed to nothing or this is the epoch floor a re-`define` inherits — while a non-empty one
  reports the revision its own oldest entry carries (`rev` in a per-collection window, `seq` in
  the store-wide feed). A collection that has NEVER written therefore answers `1` — the revision
  its first event will carry — and an empty-window reader is current only AT
  `since === storeRev` (`src/core/records.test.ts:3145-3163` pins the `1`; `:3292-3337` pins the
  idle store at 1 and a re-`define`d collection at `storeRev 3` answering 4). The floor is
  never arithmetic on `storeRev`, because a no-op patch records nothing and does not advance
  it. `droppedEvents` exists precisely so a poller does not have to know
  `RECORD_MAX_CHANGES` out of band to report how far behind it is, and it stands in for a
  separate truncation field: `oldestAvailableRev` says where to resume, `droppedEvents` says
  how much was lost. Outside a feed there is no gap to size, so `droppedEvents` appears ONLY
  beside `changes`; `oldestAvailableRev` also rides EVERY projected result of one collection
  on the un-wrapped `records` surface — reads and mutations alike, `:2841-2859` — while the
  `define`/`drop`/`describe`/bare-name answers are separate literals that carry neither key
  (`src/core/records.test.ts:3166-3181` for the plain read, `src/harness.records.test.ts:639-655`
  for `describe`, `:722-727` for the bare name, and the `define` key set at
  `src/core/records.test.ts:2926-2933`). Through the `tasks` wrapper BOTH feed
  keys ride ONLY beside `changes`, because the batch projection rebuilds the envelope key by
  key and the wrapper's page envelope is pinned byte-for-byte (`:3837-3857`,
  `src/core/records.test.ts:3185-3189`); a `since` read whose feed came back empty still
  carries both (`src/core/records.test.ts:3295-3299`). The window is PER COLLECTION
  (Decision B), so a task reader is never woken by chapter edits. A `since` ahead of
  `storeRev` is an error, and those five keys are absent from every other result — including
  the store-wide observation plane, which publishes the same floor beside its own BOOLEAN
  `reset` and never grows `droppedEvents` (`:4143-4172`,
  `src/core/records.test.ts:3349-3365`, and see
  [Session records](#session-records)).
- Validation names the offending field with a quoted, balanced path, labelled by the
  TOOL name (the engine's `callLabelOf`, `src/core/records.ts:279-280`):
  `tasks "tasks[0]" needs "text" to add a task, or an existing "id" to change one.`
  (`src/core/records.ts:1538`);
  the harness turns the throw into a recoverable tool result.
- **The model-facing contract lives in `src/tools/runtime/tasks.tool.ts`**
   (`TASKS_METADATA`: description + JSON Schema; the registration flags are a SEPARATE
   literal at `:174`, still `core`/always-declared, order 60), and
   `src/core/metadata.ts` is only the compatibility aggregation over those entries. The
   two must stay in step, and this boundary is deliberate: the schema's
   `pattern: '^[0-9]+$'` on `afterId` (`:133`) is DECLARATIVE — the shared validator
   (`src/core/schema-validation.ts`) implements type/minimum/maximum/
   `additionalProperties` but not regex, so a non-decimal cursor reaches the store and
   `readAfterId` (`src/core/records.ts:451`) is what rejects it. (CORRECTED IN PLACE
   2026-11-11: the second half of this bullet — the `leaseMs` clamp and its
   `$.leaseMs must be >= 60000.` rejection — described a parameter Decision P deleted.)
- `src/harness.ts` registers the collection through the ENGINE (`createRecordEngine()`,
  `:3364`; the wrappers are executed by `recordEngine.executeRecords(name, context)`,
  `:3412`), and the `tasks` entry keeps `visibility: 'core'` so it is declared to every
  agent with no discovery (Decision I). `reset()` clears the engine via
  `recordEngine.reset()` (`:11905`), and the harness passes the calling agent +
  conversation into the tool context on every door (model call, `executeTool`, slash
  command). Names are NOT reserved any more — harness.ts:1141 and :1891 state that no
  reserved-name or "already registered" gate exists, so a replacement by name is legal.
  Because
  `src/server/sessions.ts` creates one harness per session, tasks are isolated per
  session and shared by every agent of that harness, whatever rank it holds.
- Snapshot persistence keeps the WHOLE store as one block: `records` (snapshot **v3** —
  `HARNESS_SNAPSHOT_VERSION = 3`, `src/core/snapshot.ts:107`) is
  `{ nextId, collections: { tasks: { definition, items, storeRev?, changes? }, … } }`
  (`src/core/records.ts:2140,2221`), so the per-collection block still exists — the
  collection key is `tasks`, and the v1 sibling `records.todos` is gone (Decision K made
  the key equal the tool name). Entries are full records including `rev` and the
  attribution fields, and the definition persists with them (Decision M).
  `readRecordsStoreState` (`src/core/records.ts:2369`) validates that block and returns
  deep copies; it is the SAME reader `src/core/snapshot.ts:985` runs the persisted value
  through before a session is accepted, so a corrupt file cannot half-restore a live
  store. A duplicate id inside one collection reports with the persisted field name
  (`records state.collections.tasks.items lists the same id twice; ids are unique.`,
  `src/core/records.ts:2162-2164`).
- **Old snapshots load, new snapshots do not go backwards.** `storeRev` and
  `changes` are optional and default to `0` / `[]`, and a record without `rev`
  defaults to `1` — the revision it was created with — so a pre-T1 file restores
  unchanged (`src/core/records.ts:1948-1964`). The reverse is refused: the validator keeps an
  EXACT key set (`src/core/snapshot-validation.ts:109-130`), so a snapshot written by THIS build —
  whose records carry `rev` and whose block carries `storeRev`/`changes` — cannot be
  restored by an older build, and a snapshot from another shape is refused by the version
  gate rather than half-read. It also refuses a persisted claim field
  (`items[0] has an unknown field "leaseUntil".` — `src/harness.snapshot.test.ts:1786,1790`
  pins that a claim is never silently restored), a
  change `rev` outside `1..storeRev`, a change log that is not strictly ascending
  (`records state.collections.<name>.changes must be strictly ascending in "rev"; …`), a
  `storeRev` behind its newest event, an over-cap `items` (the collection's own
  `maxRecords`) or an over-`RECORD_MAX_CHANGES` window, and a collection map whose key
  disagrees with the definition it holds.
- **~~Thread lifecycle clears claims~~ (deleted in place, records-engine Decision P).**
  `releaseThread(threadId)` used to drop every claim tagged with a conversation id, and the
  harness called it when a thread stopped (`stopThread` and every path through it), when one
  was purged/deleted, when an agent's default conversation was dropped from the roster, and
  on `restore` for any claim whose `ownerThreadId` is absent from the restored session
  — a claim from a thread that no longer exists could never be renewed or released.
- Beyond the tool result the store reaches a host three ways (CORRECTED IN PLACE
  2026-11-11 — this bullet used to claim "no separate host getter" and named the deleted
  `readTaskStoreState()`): `harness.snapshot().records` for the durable document, the
  live `harness.records()` / `recordsChanges(since)` / `onRecordsChange(listener)`
  control-plane members (`src/types/index.ts:3441-3443`), and the server's record
  routes over them. `readRecordsStoreState()` is the exported pure reader that the
  snapshot and `restore()` paths share. The browser renders the live view in the two
  shell panels, and only in an OPEN card on a SHOWN board — see
  [Live shell panels](#live-shell-panels-harnesstasks-harnessrecords).

**Concurrency and ownership (T1).** One store is shared by every agent on every
thread, and a call is not a transaction: a read is a snapshot, and somebody else can
write the same record before your next call lands. The contract makes that race
explicit instead of letting the last write win:

- A caller the runtime **knows** (any model call, `executeTool`, a command, a lane
  worker — anything with `context.agent`) must send `expects: [{ id, rev }]` for
  every id it patches or removes; that is the GUARDED WRITE rule. A bare `tool()` /
  driver call has no identity and may write blind (the pre-T1 behaviour hosts and tests
  rely on). CORRECTED IN PLACE 2026-11-11: this bullet ended "…and cannot claim, release
  or take over at all" — those verbs no longer exist, so the sentence had nothing left
  to exclude.
- A token that does not match the stored `rev` rejects the WHOLE call, names what
  moved, and CARRIES THE CURRENT RECORD (R9 — one round trip, not two):
  `tasks "1" changed since revision 1 (now 2, last edited by "writer" at <ISO>); changed fields: text; retry with "expects" [{ id: "1", rev: 2 }] or pass "mergeDisjoint": true. current: {"id":"1",…}`
  (`src/core/records.ts:1301-1317`, pinned byte-for-byte at
  `src/harness.task.test.ts:589`). A token for an id this collection does NOT hold answers
  ONE provable cause, never a choice between two (step 3, `:1802-1879`): an id that is
  **live in another collection** gets `tasks id "1" belongs to "chapters" — re-read that
  collection.` (`:1814-1829`); an id this collection's own window still logs a `remove` for
  gets the only sentence allowed to say "was removed" — `tasks "1" was removed since
  revision 1 — re-read the list and add or retry.` (`:1832-1841`); an id the global counter
  never minted, or one in a collection whose window still reaches revision 1 (where "no
  removal logged" IS evidence), gets `tasks has no task with id "9999" — "tasks" never held
  it, and this collection's change log holds no removal for it either. Re-read the list.`
  (`:1862-1871`); and an id whose removal has aged out gets the sentence that names the
  boundary instead of guessing — `… its removal is older than this collection's retained
  change window, which now starts at revision 400 (200 events), so the log can no longer
  show it.` — with `oldestAvailableRev` in the structured `details` (`:1873-1879`). Both are
  pinned byte-for-byte, floor included: `src/core/records.test.ts:796-806` (AGED OUT) and
  `:810-821` (NEVER EXISTED, which deliberately carries NO `oldestAvailableRev` key). The
  blind spot that stays **disclosed rather than argued**: `ownerOf` only reports a record
  that is still live, so an id minted and removed in ANOTHER collection is invisible to this
  one and lands on the never-held / aged-out wording (`:1859-1861`).
  The tokens are compared (step 3) BEFORE the existence lookups
  (step 4), so a `tasks` patch, a `remove` or a token alone all
  name the removal the caller actually hit. The generic
  `tasks has no task with id "1".` (`:1885-1888`) is only what a call that sent NO token for
  that id hears, and a token for a live id the call does not touch is still rejected as
  a token for nothing (step 5, coverage).
- `rev` is content-only and per-collection `storeRev` counts every event. CORRECTED IN
  PLACE 2026-11-11: the rest of this bullet ("…which is exactly why a claim, a release,
  a takeover or a lease renewal can never break another agent's compare-and-swap")
  described events that no longer exist. With no lock, the `expects` token is the ONLY
  conflict control — which is exactly why its rejection has to be complete.
- ~~`claim` / `leaseUntil` / `TASK_DEFAULT_LEASE_MS`~~ — **deleted with the lock
  (records-engine Decision P), restated here 2026-11-11 so the deletion is one edit
  rather than folklore:** there is no `claim` verb, no `leaseMs` parameter, no
  `TASK_DEFAULT_LEASE_MS` constant, no live-lease refusal for a non-holder, no renewal
  path, no indefinite `owner`-only claim, and no `takeover` override. Two agents that
  both want the same record simply both write, and the loser is the one whose `expects`
  token went stale.
- `takeover` is gone with that same decision; `mergeDisjoint: true` SURVIVES
  (`src/types/index.ts:1692`) and is the one escape from a
  stale content patch: the patch applies only when the log proves every concurrent
  update since the caller's read covers `expected+1 … current` with no gap or
  duplicate and touched none of the fields the patch sets. A logged `remove` of that
  id, an overlapping field, or an uncovered tail all refuse; a stale `remove` is never
  merged, because a removal carries no patch to prove disjoint
  (`src/core/records.ts:1237`).
- **Corrected in place (Decision P):** there is no claim, so a conversation ending strands
  nothing — no sweep, no wiring, and no lease for a crashed agent to hold. The guarantee is
  structural, and `src/harness.task.test.ts:1062-1082` pins it by SHAPE (no
  `claim`/`release`/`takeover`/`leaseMs` parameter, and no `owner`/`leaseUntil` key
  anywhere in a persisted store after stop/delete/snapshot/restore — and a snapshot that
  DID carry a claim is refused as an unknown field instead of re-locking the record).
- Worker mode changes nothing: a `tasks` call made on a lane is ROUTED, and the
  authority rebuilds the tool context from the crossing `LaneCallIdentity`
  (`src/server/workers/lane-authority.ts`), so a lane's write is attributed to — and
  guarded by — the same `(agent, threadId)` pair it would have inline.

**Not OpenCode's `todowrite`.** OpenCode's current dev branch (`fd8268e`,
2026-10-27) has an experimental `todo` plugin tool gated by `experimental.todo`:
input `{ todos: [{ content, status: 'pending' | 'in_progress' | 'completed' |
'cancelled' }] }`, full-list replacement, no ids or priorities; the visible list is
derived by the UI from the last call's input, with no server-side todo state.
Sources:
[`plugin/todo.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/todo.ts),
[`todowrite.txt`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/todowrite.txt),
[`tool-todo.test.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/test/tool-todo.test.ts).
`tasks` is a partial patch with stable ids, not parity: it never rewrites the whole
list and it does not carry `in_progress`/`cancelled` states.

**Operator surface.** `/task [list | add <text> | complete <id> | reopen <id> |
remove <id>…]` (`src/core/command-builtins.ts:265`) is the built-in slash command over
this SAME tool: it calls `harness.executeTool('tasks', …)` (`TASK_TOOL_NAME`, `:95`), so
a terminal, an HTTP submit, or the composer reads
and changes this session's list without spending a model turn, and it inherits every
bound above. (The COMMAND name stays singular `/task` by Decision J even though the tool
is plural — the command addresses one task at a time.)
`complete`/`reopen`/`remove` are guarded writes, so the command first walks
the store (`readTaskRevisions`, `:220` — `offset` paging at `limit: 100`, following
`page.nextOffset` until it is
exhausted) and sends the REAL `expects: [{ id, rev }]` tokens it read — never an invented
revision (`:336-347` for `complete`/`reopen`, `:366-373` for `remove`) — which turns a
concurrent edit into the tool's stale error instead of a lost
update; an id the read did not see gets no token, so the tool's own unknown-id rejection
is what an operator reads. `/task claim|release|takeover` are GONE: Decision P deleted the
three verbs, the tool's `leaseMs` parameter and its ownership block, and the comment at
`:380-386` says why — an operator who types one now falls through to
`unknown action "<verb>".` (`:388`), which is the honest answer because there is no
ownership state left to move. The listing is one `#<id> [x| ] <text>` line per task plus
the totals and the page line (`formatTaskPage`, `:185-205`); the old
`(claimed by <agent> until <ISO>)` suffix is gone because the lock it described is gone,
while `rev` and the attribution still ride in the command's machine-readable `data`.
See [Slash commands](#slash-commands).

Tests: `src/core/records.test.ts` (the ENGINE — one id counter across collections, per-collection
feeds, patch semantics, bounds, keyset and offset paging, `rev`/attribution, guarded writes
and CAS, disjoint merges, `define`/`drop`, snapshot/restore and the corrupted-file rejections;
the claim/lease tests left with the lock), `src/harness.task.test.ts` (declaration, one shared
list in a live harness, and the harness-boundary checks — `:1062-1082` is the no-claim-by-shape
guarantee), `src/harness.metadata.test.ts:307-309` (the pinned `tasks` description),
`src/harness.commands.test.ts` (the five `/task` verbs — `list`/`add`/`complete`/`reopen`/
`remove` — including the read-before-write `expects`, and `unknown action` for the three
ownership verbs that were deleted), `src/harness.snapshot.test.ts:1786,1790` (a persisted
claim field is refused, never restored), and
`src/server/workers/lane-authority.test.ts` (a routed `tasks` call against the canonical
harness).

---

## Session records

> **Corrected in place (records-engine T2/T3, 2026-11-09).** This section used to describe
> THREE SEPARATE STORES with "separate closets and separate id sequences". They are now
> COLLECTIONS of one store: `src/core/records.ts` is the engine (one id counter across every
> collection, so a profile id and a chapter id can no longer both be `"1"`), and
> `src/core/profile.ts` / `chapter.ts` / `location.ts` are pure field-spec declarations —
> the only thing a generic engine cannot infer. `createProfileTool()` is gone; the harness
> builds one `createRecordEngine()` and the tools `profiles`, `chapters`, `locations` (plus
> `records` itself, and `tasks`) are thin wrappers over it. Records also gained `rev`,
> attribution and the compare-and-swap contract [Session tasks](#session-tasks) already had,
> which is what R3 asked for: no collection can corrupt or race with another.

`src/core/profile.ts`, `src/core/chapter.ts`, and `src/core/location.ts` declare the three
story collections the engine serves, with the same harness-owned lifecycle as the task list:
one store per harness (so per server session), shared by every agent there, stable
decimal-string ids from the store's single counter, full validation before any mutation,
defensive copies on every result, and cleared by `harness.reset()`. Their metadata lives in
`core/metadata.ts` and their types in `types/index.ts`.

```ts
const engine = createRecordEngine();      // tasks / chapters / profiles / locations + define
await engine.executeRecords('profiles', context);   // routed: harness.runtime.executeRecords
```

Shared action set (`RecordAction = 'add' | 'list' | 'get' | 'update' | 'remove'`);
`src/harness.ts` registers each tool, reserves its name, and calls its `reset()`.
**Corrected in place (records-engine T2/T3, 2026-11-09):** none of these tools holds state
any more. The four wrappers are a schema plus one routed call
(`context.harness.runtime.executeRecords(<name>, context)`), and `src/core/records.ts` is the
single store behind them AND behind `records` — one collection map, one id counter, one change
feed per collection. The `*Manage` names are gone (Decision J).

| Tool | `add` requires | Optional (default) | `update` mutable fields | Result extras |
|---|---|---|---|---|
| `profiles` | `name`, `description` | `traits` (`[]`), `notes` (`''`) | name, description, traits, notes | `list` → `{ profiles, counts: { total }, page }`; `get` → `{ profile, counts }`; writes → `{ profile \| removed, counts }` |
| `chapters` | `title`, `summary` | `content` (`''`), `status` (`planned`), `order` (unset) | title, summary, content, status, order | `list` → `{ chapters, counts: { total, planned, draft, complete }, page }`; `get` → `{ chapter, content, counts }`; writes → `{ chapter \| removed, counts }` |
| `locations` | `name`, `description` | `notes` (`''`) | name, description, notes | `list` → `{ locations, counts: { total }, page }`; `get` → `{ location, counts }`; writes → `{ location \| removed, counts }` |

`page` is `{ offset, limit, hasMore, nextOffset? }`: 20 records by default, hard
maximum 100 per call, and a 64 KiB budget charged on the serialized records themselves — the first
record always lands and the `counts`/`page` envelope around them is not counted
(`src/core/records.ts:2758-2769`) — so a model reads a long cast one bounded page at a time
(`nextOffset` is omitted when `hasMore` is false).
Caps: 200 records per tool, 200-character names/titles, 4000-character descriptions,
summaries, chapter bodies and notes, and at most 32 profile traits of 200 characters.
The paged result types are re-exported from `types/index.ts`; the SHAPES are declared by
the collection specs in `core/{task,profile,chapter,location}.ts` (field keys, caps, count
facets, the `getOnly` projection) and rendered by `core/records.ts`, so a wrapper cannot
drift from what the engine returns and adding a collection adds no validator.

- **The receipts and the feed keys stop at the engine envelope; the three story wrappers
  strip them.** `records` answers with the engine's own result —
  `{ entries | entry, counts, page, storeRev, removed?, oldestAvailableRev, addedIds? |
  changedIds? | noopIds?, changes? (+ changesHasMore / changesTruncated / droppedEvents) }`
  — because a call that names its own collection returns
  `executeCollection(...)` verbatim (`src/core/records.ts:3965-3971`), and that is the key set
  [Session tasks](#session-tasks) documents. `profiles` / `chapters` / `locations` go through
  `toWrapperResult`'s ACTION branch, which rebuilds a domain shape key by key —
  `{ profiles, counts, page }` for a list, `{ profile | chapter | location, counts }` (plus
  `content` beside it for a chapter `get`), `{ removed, counts }` for a removal
  (`:3863-3913`) — so a story-tool write carries **no** `addedIds`/`changedIds`/`noopIds`, no
  `storeRev`, no `oldestAvailableRev` and no feed keys at all. Confirming a write by id is a
  `records` or `tasks` job, not a story-tool job, and the batch branch above that one
  (`:3795-3860`) is why `tasks` keeps the receipts but drops the low-water keys unless a
  `changes` array is present.
- **`define` echoes the spec it accepted; `drop` answers with a marker.** `records
  { define: {…} }` returns `{ entries: [], counts: { total: 0 }, page, storeRev, collection,
  definition }` — `definition` is the VALIDATED spec, i.e. `readCollectionDefinition`'s result
  with the engine defaults the caller omitted (`maxRecords`, `responseBudgetBytes`) filled in,
  copied by `cloneDefinition` so a result never hands out the live definition object the
  collection runs on (`src/core/records.ts:3426-3443`, key set and order pinned at
  `src/core/records.test.ts:2926-2933`); `describe: true` returns the same `definition` beside
  the collection's real `counts` and `storeRev` (`:3453-3461`). `records { collection,
  drop: true }` returns `{ entries: [], counts: { total: 0 }, page, storeRev, collection,
  dropped: true }` — one constant, always `true`, only on the success path, because an empty
  page plus the name is byte-identical to what a READ of an empty collection answers and the
  caller had to make a second call that then failed `unknown-collection` (`:3505-3527`, key set,
  marker and counts pinned at `src/core/records.test.ts:2972-2982`). `dropped` is a success
  marker, never a maybe: every
  other outcome throws, and a second `drop` of the same name is the named refusal rather than a
  second `true` (`src/core/records.test.ts:2984-2996`). Neither verb carries `oldestAvailableRev` or
  `droppedEvents` — those literals are written out separately from the projected results
  (`src/core/records.test.ts:3166-3181` covers the read, `src/harness.records.test.ts:639-655`
  the `describe` answer, `:722-727` the bare-name `collections` list, whose `storeRev` is `0`
  because no single collection is addressed).
  Neither verb is reachable through `tasks`: its schema is `additionalProperties: false`
  (`src/tools/runtime/tasks.tool.ts:180`), so a `define` beside `tasks`/`ids`/`remove` is
  refused by the SCHEMA before the engine sees it (`must not include the additional property
  "define".`, `src/harness.records.test.ts:739-746`), and `records` refuses `define` BESIDE a
  `collection` — `records "define" registers a NEW collection, so it takes no "collection"
  beside it.` (`src/core/records.ts:3946-3948`, pinned at `src/harness.records.test.ts:689-699`)
  — while `{ define }` on its own stays the documented call, because `undefined` is absence,
  not a sent collection.
- **The store-full refusal sizes the job.** An over-cap call is refused BEFORE any id is
  consumed, with the advice computed for THIS call: `tasks would hold 201 tasks; the maximum
  is 200. Remove one before adding.`, and `Remove 2 more before adding.` at two over — the
  count is `resulting - maxRecords` after the call's own `remove` list is netted off, so a
  5-addition batch over `maxRecords: 3` is told the number that actually fits instead of being
  told to delete one record and retry into the same wall four more times
  (`src/core/records.ts:2013-2036`, pinned at `src/core/records.test.ts:867`, `:3034`, `:3047`,
  `:3057`). The `store-full:` prefix and the two facts before the advice are unchanged.
- **Partial update is atomic.** The tool validates into a patch object and then
  assigns; a later invalid field cannot leave earlier ones applied. An update that
  names no mutable field is an error, not a no-op. Blank `name`/`description`
  (and blank chapter `title`/`summary`) are rejected on update; `notes` and
  chapter `content` may be cleared to `''`; `traits: []` clears a profile's traits.
  Traits are trimmed and deduplicated; an omitted `traits` on `add` defaults to
  `[]`.
- **Chapters return summaries.** `ChapterSummary` is `{ id, title, summary,
  status, order? }`; `content` is stored (`ChapterItem`) but only `get` returns it
  in the result. `order` sorts the returned list: ordered chapters ascending
  first, then unordered ones in insertion order (stable sort); the live array is
  never sorted and there is no move action. `order` must be a safe integer and
  cannot be cleared through `update` (set a new value). `status` is
  `planned | draft | complete` and `counts` tallies all three.
- **Profiles and locations return whole records**, so they have no summary/body
  split.
- **Validation is up-front for every action.** Wrong field types, an unknown
  action, a missing/blank/non-string `id`, an unknown id, a non-integer `order`,
  and an unknown `status` throw `HarnessError` naming the tool and field, even on
  `list`, so no failed call mutates a store.
- **No persistence, no UI panel, no HTTP endpoint of their own.** The stores are
  reached only through their core tools (the server's `sessionBound` catalogue
  entries and `harness.executeTool`).

---

- **One realtime surface for all of it.** The store's position is published as two
  watermarks — `store_rev` for the append-only change feed and `collections_rev` for the
  collection set — and `GET /sessions/{id}/records` answers both. A change row names the
  fields it touched (`fields: string[]`) and carries no values, so a consumer that wants
  the values re-reads; the `records.updated` stream event says only that one of those two
  counters moved. On that store-wide plane the gap signal stays a BOOLEAN:
  `harness.recordsChanges(since)` answers `{ storeRev, collectionsRev, changes, reset,
  oldestAvailableRev }` and `harness.records()` answers
  `{ storeRev, collectionsRev, collections, changes }` — the snapshot has no gap to size,
  because it hands over the WHOLE retained feed and its own `changes[0].seq` IS the floor
  (`oldestAvailableRev` is declared optional on `RecordStoreView` precisely so an older host may
  omit it, and this engine omits it — the answer's key set is exactly those four, pinned at
  `src/core/records.test.ts:3366-3373`; the delta's
  five keys — `droppedEvents` among them absent — are pinned at `:3349-3365`,
  `src/types/index.ts:2004-2036`). `reset` answers one of three provable cases: `since >
  storeRev` (the store rewound under this watermark — a `reset()` to 0), `since === storeRev`
  (current, nothing to apply, NOT a reset), or `since < storeRev` with an empty window or a
  window whose oldest event sits above `since + 1` (a real gap: trimmed, or a restore/restart
  that cleared the feed) — `changesSince`, `src/core/records.ts:4143-4172`. The resume number is
  `oldestAvailableRev`; how many events were lost is NOT published here, because
  `droppedEvents` is a per-collection feed key and this plane kept its boolean (`Session
  tasks`' change-feed bullet). Over REST the delta is a CLOSED object —
  `{ session_id, revision, store_rev, collections_rev, changes, reset }` — and neither low-water
  key crosses the wire in either form (`src/shared/harness-api.ts:2553-2607`, projection
  `src/server/api-reads.ts:1040-1076`), so a browser that lost its position has exactly one
  recovery: the snapshot read, which the live panel takes on `reset: true` and on a moved
  `collections_rev` (`src/frontend/extensions/records-client.ts:865-876`).
  The two live shell panels are the only consumers of that surface today,
  and only while their cards are open and the board is showing —
  see [Live shell panels](#live-shell-panels-harnesstasks-harnessrecords).

## Cross-session knowledge

`records` owns one session and dies with it. The knowledge base is the sibling that does NOT:
an article store keyed by the deployment's DATABASE ROOT and written BESIDE `harness/sessions/`,
never inside it, so a killed session, a `harness.reset()` and a deleted `sessions/<id>/`
directory each leave the articles exactly where they were and the next session reads the same
bytes back (`src/server/knowledge-session.test.ts`). Three modules, and no rule lives in two
of them:

| Layer | File | Owns |
|---|---|---|
| Engine | `src/core/knowledge.ts` | ids, revisions, every bound, every refusal code, the ranking, the byte budget and the change feed — purely in-memory and SYNCHRONOUS (`execute` never awaits), so it never learns where its bytes live |
| Durability | `src/server/knowledge-file-store.ts` | the SUBSCRIBER on `engine.onStoreChange` that puts those bytes at `<databaseRoot>/harness/knowledge/` — the engine stays the single source of truth and a dead file writer fails an observer, never a write (`:1592-1629`) |
| Door | `src/tools/runtime/knowledge.tool.ts` | wire name, description, schema, argument normalization and the bounded model projection; it adds exactly TWO behaviours of its own — `{}` is `list`, and the prose is cut to the budget |

```ts
const engine = createKnowledgeEngine();                        // src/core/knowledge.ts:1330 — sync, in-memory
const store = await loadKnowledgeFileStore({ root, engine });  // src/server/knowledge-file-store.ts:1065 — adopts THAT engine
harness({ knowledge: store });                                 // HarnessConfiguration.knowledge, src/types/index.ts:4847
```

**Owner attribution and harness deletion (T6).** An article carries an OPTIONAL `harness`
field naming the canonical preset that CREATED it. The engine stamps it in `createArticle`
from the trusted `ToolContext.harness.knowledgeOwner` — a host field
(`HarnessConfiguration.knowledgeOwner`) that `SessionStore.buildHarness` sets to
`preset.name` and the shared toolbox forwards through the preset report. No operation accepts
it: the strict `create`/`modify` key readers refuse `harness` as an unknown field, so a model
can neither forge an owner nor move an article to another one, and `modify` retains the
original because it edits a `copyArticle` clone. Articles created directly through an engine,
by a library consumer, or before this field existed have NO owner; absent is the unowned
spelling and it means deployment-wide.

`DELETE /v1/harness/harnesses/{name}` therefore removes all and only the articles whose
persisted owner is exactly `{name}`. The cleanup runs AFTER the registry mutation is durable
(so a `409` ownership refusal — which counts live/restored sessions AND session removals still
in flight — or a failed harness-document write leaves every article
untouched), goes through the engine's own `remove` so the file subscriber erases each file and
rewrites `index.json` last, and awaits the store's `flush` before answering `200`. It never
calls `engine.reset()` and never deletes `<root>/harness/knowledge/`: articles of OTHER
harnesses, unowned rows (including the Storyline-tagged ones) and the shared read visibility
all survive, and deleting a SESSION still touches nothing. The two stores are not one
transaction: if cleanup or its flush fails after the harness document committed, the route
answers `500` naming the partial outcome instead of claiming success, and a retry of the DELETE
is a `404` that does not re-run the cleanup. The failure is not merely cosmetic: the engine has
already dropped the owned articles from memory, but their FILES may still be on disk, and the
next load treats the files as authoritative (files win per article), so those owned articles can
be RE-ADOPTED after a restart. There is no retry route and no rollback that could un-delete the
harness; an operator has to repair the store (or erase the leftover files) directly, then let a
reload reconcile.

The persisted article envelope stays **version 1**. This build reads an absent owner as
unowned, so every pre-T6 file remains valid. The reverse direction is NOT compatible: an older
strict build reads an owned version-1 file, sees `harness` as an unknown article field, and
aborts that load — `startHarnessServer` fails startup, while the service handler reports the
failure and keeps serving an in-memory base. No dual-version reader or migration is added; a
downgrade requires removing or ignoring the field out of band.

Six verbs, ONE operation object per call. The schema carries exactly one object-valued
property (`operation`), which is what makes the harness deliver the UNWRAPPED operation to
`execute` (`toolParameterKey`, `src/core/tool.ts:65-73`; `src/core/schema-validation.ts:383-386`),
so `{ operation: { verb: "list" } }` and `{ verb: "list" }` arrive identically — and an
argument-less call is `{}` → the single property's value `undefined`
(`src/core/schema-validation.ts:400-410`), which the entry applies as `list` one step before
the engine (`knowledge.tool.ts:1047-1056`). It is never a refusal: `knowledge()` is the cheapest
call a model can make.

| Verb | Accepted keys (`OPERATION_KEYS`, `src/core/knowledge.ts:316-334`) | Result (shapes at `src/types/index.ts:2536-2650`) |
|---|---|---|
| `list` (the default) | `search?`, `tag?`, `limit?`, `offset?` | `{ articles: KnowledgeArticleSummary[], counts: { total }, page }` — metadata plus `paragraphCount`, never bodies |
| `search` | `query` (required), `tag?`, `limit?`, `offset?` | the same page `+ matchedIn: 'title' \| 'text'` |
| `read` | `id`, `outline?`, `paragraphs?`, `from?`, `limit?` | `{ id, title, tags, createdAt, updatedAt, rev, paragraphCount }` then `paragraphs` OR `outline`; `from`/`limit`/`totalParagraphs`/`truncated`/`budgetTruncated` appear ONLY on a subset (`:2556-2596`); `danglingRefs` covers the refs this response names |
| `create` | `title`, `tags?`, `content` (a string, or `[{ text, tags?, refs?, id? }]`) | `{ article, createdIds }` — every body it just wrote, plus the paragraph ids it minted in append order (a pinned id is listed too) |
| `modify` | `id`, `expects?`, `title?`, `addTags?`, `removeTags?`, `addContent?`, `setParagraphs?`, `moveParagraphs?`, `removeParagraphs?` | `{ article, noop }` plus ONE key per KIND of change that happened — `changedIds` / `noopIds` / `movedIds` / `createdIds` / `removedIds` / `articleFields` — and `danglingRefs` for the modified article |
| `remove` | `id`, `expects?` | `{ removed: KnowledgeArticleSummary, danglingRefs }` — and `danglingRefs` is the WHOLE store's standing dangling set (always present, possibly empty), not a diff of this call |

- **Ids are uuid v4** (`KNOWLEDGE_UUID_PATTERN`, `src/core/knowledge.ts:297`), minted by
  `randomUUID()`, canonicalized to LOWERCASE on the way in (`:299-304`), and minted per
  PARAGRAPH as well — so every paragraph id is unique across the whole store and a
  `KnowledgeReference` names a paragraph absolutely. There is no counter to persist beside the
  articles, which is exactly what lets two harnesses write two files without coordinating; the
  price is that an id is never guessable, so an unknown id is `EKNOWLEDGE_NOT_FOUND` and the
  remedy is always list/search first.
- **TWO revisions, both read-side facts** (`:27-32`). `article.rev` moves when ANYTHING in the
  article moves, order included; `paragraph.rev` moves ONLY when that paragraph's own
  text/tags/refs really changed. A reorder is therefore visible in the article token and
  invisible in the paragraph tokens, which lets a caller guard one paragraph's body without
  being woken by a sibling moving.
- **Optimistic CAS and nothing else** (records' Decision P, carried over unchanged):
  `expects: [{ id, rev }]` — ONE token, at ARTICLE grain, because a paragraph edit moves the
  article `rev` too. A stale token refuses the WHOLE operation and the refusal CARRIES THE
  CURRENT ARTICLE (`EKNOWLEDGE_REV`), budgeted at `KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES = 8192`
  (`:213-219`); when the whole article does not fit, the payload degrades to the article
  metadata plus a paragraph OUTLINE (ids, revs, sizes, no text) and SAYS so, so the retry is
  still buildable from the refusal — one round trip to discover a conflict, not two. A write
  with no `expects` still writes, and can overwrite what another thread changed. No locks, no
  leases, no claims, no sweep.
- **Six codes, one greppable prefix** (`KNOWLEDGE_ERROR_CODES`, `:236-266`):
  `EKNOWLEDGE_INPUT` (the CALL is malformed — nothing about the store has to be true to know
  it), `EKNOWLEDGE_ID` (not a uuid, one id named twice, or a pinned id already held),
  `EKNOWLEDGE_REV` (the only conflict this engine has), `EKNOWLEDGE_LIMIT` (a NUMBER crossed a
  bound, and the message quotes the size, the bound and the constant name), `EKNOWLEDGE_REF`
  (a NEW reference's target does not exist), `EKNOWLEDGE_NOT_FOUND`. The code is `error.name`,
  `error.code` AND the first token of the message, because `src/harness.ts` renders a thrown
  error as `Tool "<name>" failed: <message>` and only the message reaches a model
  (`:268-291`). The tool catches NOTHING: relabelling would launder `EKNOWLEDGE_REV`'s payload
  into a guessed sentence (`knowledge.tool.ts:1074-1080`, the `translateRecordRejection`
  precedent, `src/core/records.ts:4326-4348`).
- **Bounds are engine-owned** (`:148-219`) and restated in the schema as DIGITS, because the
  AST scanner evaluates `metadata` without executing the entry
  (`src/core/tool-scan.ts:323-326`): 100 articles, 64 paragraphs per article, 4000 characters
  per paragraph, 200 per title, 500 per reference note, 16 tags per article, per paragraph AND
  in a `tag` filter, at 64 characters each, 16 references per paragraph, 64 entries per list
  argument (`KNOWLEDGE_MAX_ITEMS === KNOWLEDGE_MAX_PARAGRAPHS`, so "restate the whole article"
  is ONE call), `limit` 1-64 defaulting to 20 on the page verbs, a query of at most 4000
  characters, and `read` capped at 64 paragraphs per call.
  **THE RECONCILIATION RULE** (fixed 2026-11-18; `knowledge.tool.ts:153-174` states it where the
  schema is written, and the validator has no `if`/`then` vocabulary,
  `src/core/schema-validation.ts:122, :200, :221`, so ONE flat schema serves all six verbs):
  the schema may NEVER be more permissive than the engine — a bound that lets a call through and
  the engine refusing it afterwards is a late, confusing refusal — so where two verbs share one
  property and the engine bounds them differently, the shared ceiling is the SMALLEST bound that
  is safe for every verb. Two properties follow from that: `limit` is 64, the `read` window
  (`readWindowLimitArgument`, `:496-507`), not the 100 the page verbs accept
  (`readLimitArgument`, `:467-478`) — a 65-paragraph read is impossible anyway, and `list` losing
  36 rows per call costs least because a 24576-byte page cannot carry them — and `tag` is
  KNOWLEDGE_MAX_TAGS (16), because the filter is read by the SAME reader as create's `tags`
  (`readTags`, `:557-569`, reached from `:1923`). Being STRICTER than the engine is allowed only
  when it is intentional and documented, and there is exactly one such property: `expects`
  carries 1 entry where `readExpects` parses up to 64 (`:893-905`), because a call writes ONE
  article — a duplicate token collapses (`:930-942`) and a token for another id is refused
  ("One article per call", `checkExpects`, `:2020-2036`) — so one token is the whole
  engine-honoured capability and a multi-paragraph CAS is ONE article-grain token, not several
  (`knowledge.tool.ts:489-506`). `src/tools/runtime/knowledge.test.ts` pins every digit against
  the engine's own export AND runs the door itself (`validateSchemaValue` on `limit: 65`, a 17th
  tag and a duplicate `expects` each answer with the exact refusal), so a widened bound fails a
  test instead of narrowing the published interface in silence.
- **`search` reaches rank 50 and no further.** `checkSearchDepth` tests
  `offset + limit <= KNOWLEDGE_MAX_SEARCH` (50) and runs for the `search` verb ONLY
  (`:1927`, pinned at `src/core/knowledge.test.ts:1309`) — a `list` is bounded by the store and
  the byte budget instead. The published description now says exactly that; before 2026-11-18 it
  over-promised "list/search … rank at most the first 50 rows", which teaches a model to page
  `list` and stop at 50 for no reason. The refusal itself names the fix ("narrow the query or
  add a `tag` filter").
- **Ranking has two lanes and says which one answered** (`:1544-1646`): the `tag` filter
  (case-insensitive ANY-OF against the ARTICLE tags) applies first and is a FILTER, never a
  score; the term is then matched against TITLES (exact 3, prefix 2, substring 1) and ANY title
  hit SHORT-CIRCUITS the paragraph-text scan; only when no title matches does the engine count
  occurrences in paragraph text. `matchedIn` reports the lane, so a caller told `"title"` knows
  its text was never consulted for that term. Inside a lane: score desc → `updatedAt` desc →
  id ascending, the id tiebreak being what keeps a page (and a test) deterministic under an
  injected clock.
- **The budget cuts, it does not fail.** `KNOWLEDGE_RESPONSE_BUDGET_BYTES = 24576` (`:199-211`)
  is charged against the ESCAPED payload bytes the model is billed (`modelPayloadBytes`,
  `src/core/payload-bytes.ts:72`) and it drops TRAILING ROWS rather than cutting a JSON string
  mid-document: a smaller page is still machine-readable and still paged. It stays strictly
  under the harness's outer `MODEL_TOOL_RESULT_BUDGET_BYTES = 32768`
  (`src/core/result-budget.ts:192`) on purpose — an inner page that claims `truncated: false`
  while the outer envelope cut it is a lie the caller cannot detect. `read` reports
  `truncated` / `budgetTruncated` plus `totalParagraphs`; `list` and `search` set
  `page.hasMore` / `page.budgetTruncated`.
- **`toolText`, so the model and the API pay different prices.** `execute` returns
  `toolText(result, projectResult(operation, result))` (`knowledge.tool.ts:1086`, the same
  shape `src/tools/files/read.tool.ts` ships): `content` is the engine result untouched — a
  server response, a UI card, a host threading the next `offset` — while the prose is a
  projection of metadata rows, capped at the same 24576 with a 512-byte note reserve
  (`:604`) and ONE row that always survives the cut (`:613`), because a 4000-character
  paragraph is ~4 KiB escaped. The cap is a module-local LITERAL (`:593`) rather than an
  import: a compiled `.tool.ts` resolves `../../core` to the hand-assembled LIVE namespace, and
  that namespace does not cover `core/knowledge` (`src/core/tool-source.ts:463-499,504-523`).
  The test pins the literal against the engine's own export (`:1043`) and pins that the source
  still does NOT import it (`:209-210`), so drift is a failing assertion instead of prose.
- **The feed is a subscription, not a dependency.** `onStoreChange` fans out
  `{ storeRev, reason, affectedArticles, removedArticles }` with
  `reason: 'create' | 'modify' | 'remove' | 'reset' | 'restore'`
  (`src/core/knowledge.ts:1415-1443`, `src/types/index.ts:2678-2697`); the notification is
  built only when someone is listening, and a listener that throws is DROPPED rather than
  fatal, because the write already committed. `storeRev` advances exactly once per COMMITTED
  operation (`:2012`, `:2324`, `:2372`), and a call that changed NOTHING commits nothing: no
  `rev` bump, no `updatedAt` move, no watermark, no notification.
- **Refs are validated when WRITTEN and never cascaded on removal** (`:46-51`). A reference to
  a deleted article or paragraph survives unmodified and reads back as DANGLING through the
  `danglingRefs` projection — rewriting every referring paragraph would bump a `rev` the caller
  never edited, turn a read-side fact into a write, and make the state unrepresentable in
  `KnowledgeReference`, which has no `dangling` field. The projection is scoped BY VERB: `read`
  reports the refs of the paragraphs it returned (`:1778`), `modify` those of the modified
  article (`:2317`, `:2338`), and `remove` those of the WHOLE store (`danglingAcrossStore`,
  `:1543-1548`, called at `:2375`) — removing one article dangles references in articles the
  caller was not looking at, AND the scan is not scoped to the removal at all: a link that was
  already dangling before this call is reported too, so `remove.danglingRefs` is a survey of the
  base, not a diff of the call. It is also the one `danglingRefs` that is ALWAYS present (an empty
  array means a clean base), where `read`'s and `modify`'s are optional keys. (FIXED IN PLACE
  2026-11-18: the `KnowledgeRemoveResult` comment at `src/types/index.ts:2627-2633` used to
  describe that list as what "this removal just made unresolvable"; it now says
  WHOLE-store/standing/survey, the tool description teaches the same reading
  (`knowledge.tool.ts:196`, pinned at `src/tools/runtime/knowledge.test.ts:452`), and
  `projectRemove` says it too (`knowledge.tool.ts:881-889`).)
- **`modify` has a fixed apply order** (`:59-78`): title → `addTags` THEN `removeTags` (a tag
  named by both nets out REMOVED, and the surviving order is the stored order with additions
  appended) → `setParagraphs` → `addContent` → `moveParagraphs` (each move applied to the array
  the previous one left) → `removeParagraphs` → ref revalidation LAST, over only the refs THIS
  call wrote, so a reference may point at a paragraph the same call appended while a reference
  at a paragraph the same call removed is refused rather than committed dangling. Every
  operation works on a CLONE of the one article it touches and swaps the clone in only after
  every step validated, so a rejection mid-operation leaves the store, the watermark and the
  feed exactly as they were — and a rejected `create` burns nothing, because a uuid has no
  observable sequence.
- **Strict at both levels.** An unknown key is a REFUSAL naming the key, never a dropped field
  (records' Decision C), and `readItemKeys` checks the nested item shapes the same way
  (`CONTENT_ITEM_KEYS` / `SET_ITEM_KEYS` / `MOVE_ITEM_KEYS` / `REF_ITEM_KEYS` /
  `EXPECT_ITEM_KEYS`, `:343-347`). Optional keys are ABSENT, never `undefined`-valued, so the
  persisted JSON and the byte budget both measure the real serialized shape.
- **`setParagraphs` tells ABSENT from PRESENT, and the model-facing text says so.** An item that
  omits `text`, `tags` or `refs` leaves that field exactly as stored, and `tags: []` / `refs: []`
  CLEAR it: the reader carries absent-vs-present through the normalization as
  `hasText`/`hasTags`/`hasRefs` (`src/core/knowledge.ts:799-847`), and the writer touches the
  paragraph only when one of those keys was PRESENT and actually different (`:2128-2173`) — so a
  text-only rewrite keeps the stored tags, and a rewrite that changes nothing lands in `noopIds` and
  bumps no rev. The schema property description (`src/tools/runtime/knowledge.tool.ts:451-457`) and
  the rules line of the long description (`:195`) both spell it out; the wording used to read "each
  item replaces that paragraph", which teaches a rewrite that silently drops the paragraph's tags —
  the opposite of what the engine does. The generated manifest is pinned byte-for-byte against the
  source description (`src/tools/runtime/knowledge.test.ts:502-506`), and
  `yarn tools:manifest:check` gates the rest of the table.

### The durable half

```text
<databaseRoot>/harness/knowledge/index.json   read accelerator: version, savedAt, storeRev?, one row per article { id, title, updatedAt, file }
<databaseRoot>/harness/knowledge/<id>.json    ONE article: { version, article }
```

- **One file per article, because the session store learned that lesson at 110 MB**
  (`src/server/knowledge-file-store.ts:34-40`, citing the measured 800 ms checkpoint at
  `src/server/persistence.ts:2253-2261`). Editing a paragraph costs one small file, the failure
  radius of a bad byte is one article, and `index.json` stays a few kilobytes however big the
  base gets — and the article bytes are PRETTY-PRINTED (`null, 2`, `:42-48`), a deliberate
  deviation from the session shards' compact bytes, because this file optimises for a human or
  an agent grepping a bounded article. `<databaseRoot>` is the DATABASE root the deployment
  already uses for sessions: `KnowledgeStoreOptions.root` takes that root and appends
  `harness/knowledge/` itself, so no caller can spell the namespace two ways — and this
  `index.json` is NOT the `harness/index.json` session-document header, which this store never
  reads or writes (`:18-32`, `:259-262`).
- **`storeRev` lives only on the accelerator**, because it is the one field the article files
  cannot show: the engine counts MUTATIONS, so an article created and then removed leaves a
  watermark the files do not evidence, and `KnowledgeEngine.restore()` takes that number
  explicitly (`src/core/knowledge.ts:2487`). It is declared OPTIONAL and a load without it falls
  back to the highest article rev (`:321-334`) — a crash window or a hand-built index still
  loads.
- **The envelope version gates reads and there is NO migration**: `HARNESS_KNOWLEDGE_VERSION = 1`
  (`:269`), carried on the ARTICLE file rather than the index, so a reader that opens one file
  directly with no index still knows what it holds. A mismatch throws naming the FILE — the
  `HARNESS_DATABASE_VERSION` / `HARNESS_JOURNAL_VERSION` idiom (`:264-269`,
  `:110-117`) — because guessing which of two shapes a file holds is how a silent clean slate
  starts.
- **The default commit window is ZERO**: `HARNESS_KNOWLEDGE_INTERVAL_MS = 0` (`:271-279`),
  because the unit of work here is one settled article edit per tool call, so the property the
  tool needs is "durable before the next call" and durability has no reason to wait for a batch.
  At zero every notification commits on the spot and NO timer is armed at all; the gate still
  coalesces one synchronous burst (a call that moves a paragraph then rewrites a title is TWO
  notifications) into ONE pass (`commit` joins the pass the first caller armed, `:1539-1564`), and
  a byte-identical article is `skipped` rather than rewritten by the sha256-plus-witness gate — so
  "every committed change flushes" is NOT "one syscall per mutation". The trailing timer —
  `unref()`'d, `:1507-1524` — exists only to make a NON-zero `intervalMs` work (`:1612-1629`).
  WHAT THIS WINDOW IS *NOT*: the store used to justify 0 by comparing it to
  `VIEW_CHECKPOINT_INTERVAL_MS: 0`; that interval is 2 s (`src/server/sessions.ts:523`, trade-off
  argued at `:495-521`), sized for the per-token churn of a live conversation, and the comparison
  was simply false. T12 re-examined the value and KEPT 0 rather than moving it to 2 s: the
  mutation cadence here is one article per tool call (a settled, already-atomic change, at most
  two small files), so a debounce window buys no batching and only widens the crash hole around a
  change that is cheap to persist now, while the awaitable barrier (`flush()`) already exists for
  callers that need durability before a response. The COMMENTS now say that
  (`:149-157`, `:271-278`) instead of claiming inheritance, and the divergence is deliberate: two
  different units of work, two different windows. `src/server/knowledge-file-store.test.ts` pins
  the exported zero (635), the "no timer armed at all" behaviour and the one-pass-per-burst
  coalescing (617-660).
- **A commit is ordered, synchronous end to end, and incremental**: article files → erasures →
  `index.json` LAST (`:88-96`), which is the torn-set story — a crash between the files and the
  index leaves NEW files beside a STALE index (a reported, lossless divergence), whereas the
  reverse order would leave an accelerator promising articles the record does not have. Each
  file is content-addressed (sha256) against the last bytes THIS writer committed AND must still
  carry the `{size, mtimeMs}` witness recorded then (`witnessMatches`, `:1189-1196`), because a
  digest alone cannot notice an out-of-band edit — it hashes this writer's own bytes. So a
  byte-identical article is `skipped`, a hand-edited one is rewritten, and `load()` primes both
  digests and witnesses from the bytes it read. Writes go through `commitHarnessFile` with staging
  owner `'knowledge.<pid>'` (`knowledgeStagingOwnerOf`, `:313-318`, used at `:1072`): the
  `knowledge` PREFIX makes this store's `.tmp` family disjoint from the session store's and the agent
  overlay's, and the pid makes it disjoint from another PROCESS writing the same directory. The pid
  is not decoration — the suffix comes from a per-store sequence that starts at 0, the stage is
  opened `'w'` rather than `'wx'`, and the failure path `rmSync`s it (`src/server/persistence.ts:2200`,
  `:2222`), so two processes spelling the old bare `'knowledge'` token would both stage
  `state.json.knowledge.0.tmp` and could publish each other's payload or delete a live stage and fail
  the rename — the same reasoning the coordinator/IO-worker pair uses for `<pid>.io<threadId>`
  (`HarnessDatabaseWriteOptions`, `src/server/persistence.ts:2124-2135`). The exact name, and a
  caller's own `owner` still winning, are pinned (`src/server/knowledge-file-store.test.ts`, "the
  staging name carries the pid"). A stranded `.tmp` is a file, never an article, because the loader
  ignores it.
- **LOAD IS LOUD, WRITE IS REPORTED.** An unreadable directory, an unknown `version`, malformed
  JSON, an envelope with an unknown key, an article that fails the engine's own strict reader
  (`readKnowledgeStoreState`, `src/core/knowledge.ts:1235`), a file whose name and content
  disagree on the id, or two files claiming one id all throw `HarnessPersistenceError` naming the
  FILE (`:110-117`) — nothing is reset, skipped or deleted, because a silently ignored article
  lets a corrupt file masquerade as a smaller base. The one deliberate exception is a name that
  is not a uuid at all: the engine could never address that article, so a stranger's
  `notes.json` is skipped AND reported. A WRITE failure is the other direction:
  `KnowledgeCommitReport.failure` names the file, the article stays DIRTY for the next pass, the
  index is left alone, reads keep working, and the in-memory change is never lost (`:119-125`).
- **`commit({ force: true })` is the repair pass**: it re-examines every article AND every file,
  ADOPTS a file the engine has no article for (a peer's write, not garbage to delete), erases a
  file the engine deliberately removed, rewrites bytes that disagree, restamps the index, and
  answers `report.due = { created, modified, deleted }` — a symmetric difference over article
  ids, each sorted, filled from the same observations the syscalls came from (`:353-378`). The
  survey is a DEBT, not a private request: once one has been asked for, the NEXT pass that arms
  performs it, whatever armed that pass, and a caller waiting on a forced request always ends
  holding a report that carries `due` (`:462-477`). `diagnostics()` returns the divergences the
  store has SEEN AND NOT YET REPAIRED — load findings plus standing forced-pass findings — and
  clears them as one SET when a forced pass finishes clean, which is the proof the store's view
  matches the files (`:486-494`).
- **`flush()` is the durability barrier**, in the `drainIo` shape (`runBarrier`, `:1713-1752`):
  concurrent callers join the one in-flight barrier, it clears the trailing timer because this call IS
  the write, commits until quiet (capped at `FLUSH_MAX_PASSES = 8`, `:320-323`, stopping on a
  `failure` rather than retrying it into a hot loop), and answers the report of the pass that DID the
  work, so a trailing idle pass cannot hide the write the caller is waiting for. `dispose()` flushes,
  clears the timer and unsubscribes exactly ONCE (`:1760-1778`).
- **A disposed store REFUSES durability instead of faking it.** A `commit()`/`flush()` that arrives
  after `dispose()` throws (rejects) a `HarnessPersistenceError` naming the DIRECTORY and the one
  remedy — load a store again (`refuseDisposed`, `:1574-1588`; the guarded wrappers are `:1654-1667`
  and `:1754-1758`) — rather than answering a zero-work `{ written: [], bytes: 0 }`, which reads as
  "nothing owed, everything durable" to a caller whose article just stopped being durable. The
  internal pass engine (`commitNow`, `:1594-1651`) is what the timer, the notification handler and
  the teardown flush call, so the shutdown pass still runs AFTER `disposed` is set and a refusal is
  never an attempt: nothing a late caller does re-arms the trailing timer, and a SECOND `dispose()`
  stays idempotent (`undefined`, no syscall) because closing a closed store is not a durability
  request. The engine underneath is untouched and may still be shared — what ended is this store's
  ability to move bytes.
- **ONE server process per database root, and what two of them do.** Two live
  `loadKnowledgeFileStore` instances over one root — what two server processes look like from inside
  one — each commit THEIR OWN engine, so the later commit replaces the earlier one's article file:
  both report success with the article among the bytes written, both `diagnostics()` answer `[]`, and
  one writer's paragraph is gone with NO signal, because from each side nothing failed. The
  article-grain `expects` token cannot cross processes (each engine validates it against its own
  copy, and both copies are equally "current"), and `index.json`'s `storeRev` is exactly the number a
  cross-writer CAS could have used and is NOT: no commit re-reads it. Adding that re-read, a journal
  or a real lock is out of scope — the sibling session store assumes the same single writer
  (`src/server/persistence.ts:74-76`), and the module states it as a NON-GOAL
  (`src/server/knowledge-file-store.ts:214-234`). What DOES self-heal is the accelerator: two writers
  each creating an article lose only the `index.json` ROW of one of them, because the article FILES
  are the record — the next load reads BOTH articles back and reports the index disagreeing, and a
  forced pass ADOPTS the file the engine never held. Both halves are pinned
  (`src/server/knowledge-file-store.test.ts`, "two live stores over one root").
- **Two files claiming one id is a hard abort, and the remedy is one `rm`.** On a case-sensitive
  filesystem `<UUID>.json` beside `<uuid>.json` is two records for one article and choosing between
  them is arbitrary, so `load` throws `Two knowledge article files claim article "<id>" ("<a>.json"
  and "<b>.json"); one of them must go.` (`src/server/knowledge-file-store.ts:945-953`) rather than
  picking one — fail-closed, because a silently-chosen article is a base that got smaller without
  saying so. The operator-facing fix is exactly one step: open both files, keep the article that
  should survive, and DELETE the other. A rename cannot fix it, because the id IS the file name.
- **Merge rule on load, because either side can legitimately hold articles**: the FILES win per
  article (they are the durable record), an article the engine holds with no file is KEPT and
  marked dirty (dropping it would lose the only copy), and every difference is a load diagnostic
  (`:424-433`). `loadKnowledgeFileStore` does NOT create the directory — a load must stay
  side-effect-free so a read-only mount can still serve reads — and the first commit does,
  because `commitHarnessFile` `mkdir -p`s its own directory (`:28-32`).
- **The id IS the file name, so it is also a traversal fence**: the engine's
  `KNOWLEDGE_UUID_PATTERN` is reused verbatim rather than re-spelled, and an id that fails it is
  refused BEFORE it is path-joined — otherwise a hand-edited `../../x` would read, write and
  DELETE a path outside `<root>/harness/knowledge/` (`:508-527`). The file layer canonicalizes
  the id to lowercase for the same reason the engine does: without it, an upper-cased uuid is
  ONE article in the engine and TWO files on a case-sensitive filesystem.

### Wiring

- **One engine and at most one store per RESOLVED DATABASE ROOT**, owned by
  `src/server/runtime.ts:415-562` rather than by `SessionStore`: the engine is created
  SYNCHRONOUSLY on first touch (`getHarnessKnowledgeEngine`), so a harness built BEFORE the load
  settles still holds THE engine; `prepareHarnessKnowledge` memoizes the load per root — ten
  concurrent hosts cause exactly one load — and memoizes the FAILURE the way a corrupt session
  document is, so a broken knowledge file is a fact an operator fixes rather than a condition
  re-probed on every request. `harnessKnowledgeOf` answers the store as soon as it exists and
  THE SHARED ENGINE until then, which is never a lie about durability because an engine-shaped
  seam carries no `flush`. The `''` key is the no-root deployment: knowledge works in memory and
  the process performs NO filesystem write for it.
- **`harness()` always has a base** (`src/harness.ts:1356-1388`, `:4396`): an absent
  `HarnessConfiguration.knowledge` means the harness builds its OWN in-memory engine, so
  `harness({}).knowledge` always answers and the tool never specialises an unconfigured host —
  and `knowledgeSourceOf` VALIDATES the argument instead of casting it, because presence of
  `flush` is the only honest durability signal a tool can print. `Harness.knowledge`
  (`src/types/index.ts:4935`) is `readonly`, never `undefined`, and passes the host's object BY
  REFERENCE: identity is the proof of sharing, which is what makes one session's article the
  next session's to read. The seam type is the deliberate union
  `KnowledgeEngine | HarnessKnowledgeStore` (`:2779-2798`), narrowed by `'engine' in seam`
  behind an object guard (`knowledge.tool.ts:953-1004`), and the ONLY refusals this entry owns
  are about an unusable seam — no `context.harness` at all, or a seam that carries no callable
  engine — both `EKNOWLEDGE_INPUT`, because the engine uses that code for "this call cannot run
  as shaped". It never fabricates a store, because a silently-empty base reads as "nothing is
  written down here" instead of "this host has no base".
- **The shipped server loads the base before a single request**, and before the `SessionStore`
  exists (`src/server/start.ts:186-198`), hands that store an ACCESSOR
  (`knowledge: () => harnessKnowledgeOf(root)`, `:252`) which `buildHarness` reads ONCE per
  build and never caches across builds (`src/server/sessions.ts:2811-2814`, `:2860`), and
  exposes the store on the listener itself (`HarnessServer.knowledge`, `:382`). A load failure
  ABORTS startup, deliberately: a server that quietly forgot the knowledge it failed to read
  would write over the very files it failed to read (`:194-198`). `close()` flushes and disposes
  exactly ONCE, prints a failure instead of throwing, and still closes the process — a shutdown
  that failed to write an article must not strand the sessions (`:411-430`) — and
  `disposeHarnessKnowledge` evicts the root's entry so a listener restarted in the same process
  loads a FRESH store instead of disposing one twice (`src/server/runtime.ts:538-562`).
  `src/server/service.ts:551-560` awaits the same memoized load before resolving a runtime, so a
  request-driven first touch cannot build a harness that missed the base.
- **The catalogue row** is
  `{ group: 'runtime', activation: 'always', order: 95, sessionBound: true, alwaysDeclared: false, listed: true }`
  (`knowledge.tool.ts:567-574`) with `visibility: 'searchable'`: every harness REGISTERS the
  tool, and the model opens it by NAME through `toolRequest` instead of the provider paying this
  entry's description and schema on every request of every session — its tags
  (`knowledge`, `article`, `articles`, `search`, `read`, `edit`, `reference`) are how that query
  matches. `mode` is omitted, which IS `sync` (`DEFAULT_TOOL_MODE`, `src/core/tool.ts:85`),
  because the engine never awaits — the file layer is a subscriber. Being `listed: true` puts it
  in `RUNTIME_DESCRIPTORS` and therefore in the host-wide catalogue
  (`src/server/harnesses/core.ts` derives it, T21), and its name → source row is part of the
  release gate's startup-record list (`STARTUP_SOURCE_ENTRIES.knowledge`,
  `scripts/check-package-tools.ts:174-179`) — without that row, the one startup registration the
  gate never looks at would be this one.
- **NOT wired, deliberately.** NO snapshot field and no knowledge-specific HTTP route:
  `snapshot()` is per-session state, and folding the base in would let one session's restart
  rewrite the base every other session is reading while a session deleted with its directory
  took the articles with it (`src/harness.ts:4380-4385`). NO `reset()` — a reset clears the
  conversation and the SESSION record stores, and the knowledge base outlives the conversation
  by design (`:4386-4388`). NO `dispose` hook, because whatever is here was created by the HOST
  (which owns the one disposal path) or is the in-memory fallback, which holds no timer,
  subscription or file handle (`:4389-4395`). NO panel, no `toolUi()`, and no swagger surface.
  The ONE server write that reaches the base is the owner cleanup behind
  `DELETE /harnesses/{name}` (see the section above); it is not a knowledge route and it never
  resets the shared store. And a CPU-isolated LANE WORKER gets the replica `harness()` built for
  it — an in-memory engine, not the host's live store — because a live object cannot cross
  `worker_threads` (the `pluginSettings`/`toolSettings` posture, `src/types/index.ts:4925-4927`);
  that is why nothing under `src/server/workers/` touches the durable store.
  `execute(operation, context)` DOES read one field from `ToolContext` — the trusted
  `harness.knowledgeOwner` — but only `create` consumes it, to stamp
  `KnowledgeArticle.harness` (`src/core/knowledge.ts` `ownerOfContext`/`createArticle`,
  `knowledge.tool.ts:1062-1066`). It is never a model input, and an unowned harness writes
  articles without the field.

### Pinned by

```bash
yarn vitest run src/core/knowledge.test.ts src/server/knowledge-file-store.test.ts \
  src/tools/runtime/knowledge.test.ts src/harness.knowledge.test.ts \
  src/server/knowledge-session.test.ts src/server/harness-delete-knowledge.test.ts
```

181 tests, 6 files, all green at the last run of this pass (2026-11-21). The engine suite (80)
is the authority for bounds, codes, verbs, ranking, budgets, the feed and every projection —
including that the rank-50 ceiling belongs to `search` alone ("caps a search at the
KNOWLEDGE_MAX_SEARCH rank it can actually deliver, and leaves list uncapped",
`src/core/knowledge.test.ts:1309`); the file-store suite (29) for the layout, the version gate,
the zero window, the commit order and skip gate, the repair pass, the barrier and disposal — and
since T15 also for the staging name carrying the pid (`state.json.knowledge.<pid>.<n>.tmp`, with a
caller's own `owner` still winning), for the disposed store REFUSING `commit()`/`flush()` (a
`HarnessPersistenceError` naming the directory, no pass run, no timer re-armed, a second `dispose()`
still `undefined`), and for the single-writer boundary in both directions: two live stores over one
root each holding a valid `expects` token lose one writer's edit with no refusal, no `failure` and no
`diagnostics()` line, while two concurrent `create`s lose only the loser's `index.json` ROW because
the next load reads both articles back and a forced pass ADOPTS the peer's file; the
tool suite (45) for the schema digits against the engine's own exports, for the door refusing an
over-bound argument before the engine is asked (`limit: 65`, a 17th tag, a duplicate `expects`),
the projection cap, the seam narrowing, the projection itself and the registration row (`:525`);
`src/harness.knowledge.test.ts` (9) for the seam in a live harness — including that knowledge
survives `reset()`, never enters the snapshot, and is not disposed by a harness teardown, and since
T15/F1 that BOTH factories the construction refusal names are live on the surface the message names
(`createKnowledgeEngine` and `loadKnowledgeFileStore` importable from `@underload/harness`, the
latter also from `@underload/harness/server`, and identical to the objects the internals use); and
`src/server/knowledge-session.test.ts` (6) for the guarantee the whole feature exists for —
"resolves one store per database root and hands it to every harness the listener builds",
"flushes on close(), disposes the store exactly once, and a restart reads the article back",
"leaves `<root>/harness/knowledge/` byte-identical when a session is deleted", and "offers
knowledge in memory with NO database root, and writes nothing to the filesystem". The
discovered-catalogue pin that includes the name is
`src/server/workers/lane-tool-settings.test.ts:780-812`.

## Agent results (R3)

Two ALWAYS-registered core tools expose the session's completed agent answers to
every configured agent, whatever rank it holds:

```ts
agentManage({})                                  // every agent + truncated previews
agentResult({ agent: 'researcher' })             // latest finished result
agentResult({ agent: 'researcher', invocationId: '3', offset: 4000 })
```

| Tool | Input | Result |
|---|---|---|
| `agentManage` | `{}` | `{ agents: [{ name, role, model, invocationCount, results }], totalResults, activeResults, truncated }`; each result is `{ invocationId, kind, status, contentLength, preview, truncated }` — plus `startedAt`/`ageMs` on a RUNNING row and nowhere else (see the age bullet below) — top-level `truncated` is the LISTING flag (some agent has more retained invocations than this view shows), NOT a text cut; see the listing bullet below |
| `agentResult` | `{ agent, invocationId?, offset?, limit? }` | `{ agent, invocationId, kind, status, content, contentLength, offset, limit, hasMore, nextOffset? }` — for a failed/cancelled run `content` is the paged partial answer and `error` (plus `cancelledAtMessage` when the run appended anything) comes with it; a RUNNING row answers `{ agent, invocationId, kind, status, content: '', contentLength: 0, offset: 0, limit, hasMore: false }` plus `startedAt`/`ageMs`, never a streamed partial; `status: 'empty'` with empty `content` only when NOTHING has finished for that agent to select (no completed AND no failed/cancelled record — an agent whose only finished runs failed selects the newest of those, per the selector bullet below) |

- **Identity.** `invocationId` is the run id for a root run and the thread id for
  a delegated/ctx.run child; a fork/autoanswer uses its `branchId`. The harness
  records roots, delegations, forks, and autoanswer branches in a bounded
  registry (`AGENT_RESULT_RETENTION` = 64 completed records, active runs are never
  evicted) and persists every TERMINAL record as the OPTIONAL `agentResults` array of
  the EXISTING snapshot document — an additive optional key, deliberately NOT a version bump
  when it landed (`src/core/snapshot.ts`). That no longer means an older file still loads: the
  rank pass moved the document to version 3 (`HARNESS_SNAPSHOT_VERSION`, `src/core/snapshot.ts:107`)
  and the reader accepts ONLY that version — `Snapshot version 2 is not supported; this harness
  reads version 3.` (`:1205-1207`) — because translating v2's `role: 'primary' | 'subagent'`
  into a rank would invent a ranking the old shape never carried. Restoring advances
  the run, completion, and branch-id counters to
  the archived high-water marks (`src/harness.ts` — `Math.max` over the restored rows'
  `sequence`, which IS the run id, plus the `branch-N` marks), so a run started in a
  restored harness cannot reuse or overwrite an invocation id THIS snapshot still
  archives. That is a RESTORE guarantee, not a global one: the counters are per PROCESS, so
  an invocation id is unique only inside one (the `HarnessThread` contract in
  `src/types/index.ts` states exactly that, and `HarnessThread.epoch` exists to make the
  recycling visible on a recorded frame), a lane worker mints from its OWN counters, and a
  snapshot that carries no `agentResults` array leaves them at 0 while the session journal
  still holds the ids that came before — so a caller treats `invocationId` as a handle into
  THIS harness's retained registry, never as a permanent id through history.
  Old snapshots without the field restore an empty registry, and
  `reset()` clears it with the conversation.
- **An unfinished run keeps its partial on disk (2026-11-14, issue 0033).** The live
  envelope of a cancelled or failed run reports the assistant TEXT it had in hand when it was
  cut off (`partialContent`) and how many messages were committed when it stopped
  (`cancelledAtMessage`). Both are part of the PERSISTED record — OPTIONAL keys beside
  `error`, written by the snapshot projection and carried back by `restore()`, and the pair
  crosses the worker/lane archive seam the same way, so a lane-archived cancellation keeps it
  too (see [Lane workers](#lane-workers-threadexecution-worker)). Before this
  they were runtime-only: `content` is empty for a non-completed run, so a save/restart/
  reload answered the very same `invocationId` with `content: ""` and no `partialContent`
  key at all, and the caller lost an answer it had already been shown. The server persists
  `core` verbatim (`src/server/persistence.ts`), so this array IS what lands in
  that session's `sessions/<sessionId>/session.json` shard — the only part of `core` the
  writer splits out is `core.threads[].messages`, and an agent-result row never travels
  with a transcript (`splitHarnessSessionRecord`, `src/server/persistence.ts:2320-2358`),
  and `src/core/snapshot.ts` had to start accepting the pair for that file to
  come back at all — the record shape and the reader are one fix, not two. The pair is mutually exclusive with `content` by construction —
  `finishInvocation` and `archiveInvocation` write `content` for a COMPLETED run and
  `partialContent` for every other terminal state, never both — so the archive still holds
  AT MOST one answer string per record and `AGENT_RESULT_RETENTION` (64) is unchanged; no
  new bound was added, and `content` has always been stored whole and paged on READ. WHICH
  text a row's partial holds was WIDENED the same day by 0020's AC1, and the wording here
  follows the capture: `runAgentCore`'s cancellation catch reads the answer the run was still
  STREAMING when the cut landed — the per-request buffer `RunState.streamedText` (declared
  `src/harness.ts:6489`, reset per request at `:13402`, accumulated at `:13444`, dropped at
  `:13463`) — and falls back to the last COMMITTED assistant text (`lastSubstantiveText`) only
  when that buffer is empty (`:14288-14295`); `finishInvocation` then stores whichever of the
  two it was handed (`:4773-4776`). The in-flight buffer WINS because it is the fresher
  evidence and the caller of a cancelled child had already been shown it; an empty buffer
  means the run really had nothing in hand, and the answer stays ABSENT rather than becoming a
  synthetic `""` (which is what keeps the reader's `min: 1` bound meaningful, below). What has
  NOT moved is the leak boundary, and it stays emphatic: a row's partial is TEXT and nothing
  else — never a tool call, never a tool result, so `agentResult`'s answer stays text-only.
  WHAT MOVED (IT19 R1, 2026-11-15) is where those blocks live: an interrupted run attached to
  a conversation now KEEPS its committed turns, so its calls and results stay in that
  transcript and `threadRead` shows them, with a lone unanswered call closed by the repair
  helper's interrupted placeholder (`SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT`,
  `src/core/transcript-repair.ts:79`). Only a forked BRANCH run still splices. The boundary
  this bullet guards is therefore narrower than it used to be — row-level, not
  transcript-level — and it is still the criterion issue 0032 is written against, whose
  transcript half R1 retired (see the issue record for 0036).
- **Completed answers only.** The registry records the value `runAgentCore`
  returns, never a streamed delta, so an explicitly addressed running invocation
  has `status: 'running'` and no content and is OMITTED from a snapshot (never
  written as a fabricated or cancelled answer). `agentResult` without an id
  selects the latest result by COMPLETION order, so a fork that finished earlier
  cannot mask the root's final answer — and since 2026-11-13 it SKIPS runs that
  are still in flight: the default selector takes the latest COMPLETED record,
  else the latest TERMINAL one (failed/cancelled — the last answer that actually
  exists), else answers the honest `status: 'empty'` rather than a running
  record's empty body (`agentResultFor`; the old fallback was the newest STARTED
  record, which made a finished-earlier child look like it had said nothing).
  Live invocations are still reported by `agentManage`, and an explicit
  `invocationId` still reaches a running record.
- **A RUNNING row says how long it has claimed to be running (DEFECT M1, 2026-11-17).** Both
  doors project ONE absence-conditional pair, and only beside `status: 'running'`: `startedAt`
  (epoch milliseconds, stamped on the ledger by `registerInvocation`, `src/harness.ts:4695-4732`,
  REUSED from `RunState.startedAt` instead of re-reading the clock, so the live `ageMs` and the
  terminal `durationMs` measure from one instant and can never disagree by the gap between two
  clock reads) and `ageMs` (`max(0, Date.now() - startedAt)` computed at READ time by
  `invocationAgeOf`, `:4126-4138` — which is what tells a poller a run that just started from one
  that has claimed `running` for an hour). `agentManage` adds the pair to that row's preview
  (`invocationPreviewOf`, `:4141-4160`) and `agentResult` adds it to the running envelope an
  explicit `invocationId` reaches (`:4434-4458`), where `content: ''` / `contentLength: 0` stay
  byte-for-byte as they were — the pair is age, not content, and a streamed partial is still
  never presented as a result. Everywhere else the pair is ABSENT, and the absence is asserted BY
  NAME at every door: a `completed`, `failed` or `cancelled` row and `agentResult`'s
  `status: 'empty'` keep their exact pre-M1 key sets — the preview's own comment gives the reason
  (`:4143-4147`: a failed or cancelled preview already reports a terminal row whose span is
  `durationMs` on the full envelope, and adding the pair there would change a key set every listing
  pin asserts byte-for-byte; a `completed` answer is simply over, and its envelope has no span key
  at all) — and a row written by `archiveInvocation` (`:8114`) or by snapshot restore carries no
  start stamp at all (`:14021-14023` projects TERMINAL records only, and the restore literal
  rebuilds each row key by key with no `startedAt` among them, `:14422-14449`), so the pair is
  absent there rather than `0` and absence reads as "unknown",
  never as an age of zero. It is an AGE, not a heartbeat or a lease: nothing proves the run is
  alive, `delegate` has no wall-clock bound by default (`DELEGATE_TIMEOUT_MS =
  Number.POSITIVE_INFINITY`, `src/core/agent-limits.ts:62`) and retention never evicts a running
  record — which is exactly why elapsed time is the fact these doors publish, and why the caller
  decides whether to poll again or move on. `src/types/index.ts:1496-1512` states the same rule
  beside `HarnessInvocationStatus`, because neither door publishes a typed envelope
  (`agentManage: () => unknown`, `agentResult: (parameters) => unknown`), and it also fixes the
  one place the pair cannot help: in lane/worker mode the canonical harness never sees a worker's
  live runs, so age is the only liveness-adjacent fact at that boundary. The `delegate` door is
  NOT that pair's door — `unfinishedDelegateEnvelopeOf` (`:4627-4665`) answers a released or
  abandoned child with `status`, `invocationId` and `durationMs`
  (`record.durationMs ?? max(0, Date.now() - startedAt)`, and that `startedAt` is the CALL's, not
  a row's) beside `content` / `error` / `partialContent` / `cancelledAtMessage`, and grows
  `startedAt`/`ageMs` nowhere: a released `delegate` describes a child that already settled, a
  `running` agent-results row describes one that has not. Pinned: the pair on BOTH doors for one
  run and recomputed when the clock moves (`src/harness.agent-results.test.ts:2586-2653`), the
  exact running row of a parked run beside a key-free completed row of the SAME agent in one
  listing (`:2810-2900`, where "the difference is exactly `status`"), and the absence demanded by
  name on the failed, cancelled and empty envelopes (`:2695-2807`, via `expectNoAgeKeys`).
- **A registered invocation always settles (2026-11-14, stress report #9).**
  `registerInvocation` files the record as `running`, and the ONLY code that makes it
  terminal is `commitRunTerminal` — on the success path and on the failure path of the
  same `try` in `runAgent`. That `try` now also covers the `run.started` emit, so
  nothing between registration and the terminal commit can strand the record:
  a `running` entry is never evicted (retention takes terminal records only), never
  snapshotted, and would be reported live forever, with the conversation left `running`
  beside it. This is an UNCONDITIONAL INVARIANT, not a bug fix — the hook bus is
  fail-open end to end (`src/plugin/hooks.ts` rule 2: a handler that throws, rejects,
  outlives its `timeoutMs`, or returns an unparseable decision is dropped and reported,
  and even the host's diagnostic reporter is wrapped), so no PLUGIN could orphan a
  record in the first place; what the guard covers is a defect inside the dispatch
  itself (a payload factory that throws, a handler list that changes mid-round) and
  anything the fail-open contract is ever widened to stop swallowing. The emit order is
  unchanged: `run.started` still fires after `registerInvocation` and before
  `runAgentCore`, still behind `hookBus.has()` so a hookless harness keeps its exact
  microtask order, and the terminal commit and the `finally` release block stay where
  B2 put them (pinned by `src/harness.thread-runtime.test.ts`).
- **Durability is strict.** `snapshot.agentResults` is validated before any restore
  mutation: unique `invocationId`/`sequence`/`completedOrder`, an agent present in
  `snapshot.agents`, terminal status only, `error` required exactly for
  failed/cancelled, and at most 64 records. A corrupt array rejects the whole
  restore and leaves the live registry untouched. The forensic pair of issue 0033 rides
   the SAME rule `error` already sets, which is what keeps the old files loading:
   `partialContent` must be at least 1 character when present (an empty one is a hand
   edit, and accepting it would restore a `partialContent: ""` shape the runtime never
   answers with), `cancelledAtMessage` is a safe integer >= 0 (a run stopped before it
   appended anything legitimately reports 0), and both must be ABSENT on a `completed`
   record so that `restore -> snapshot` re-projects byte-for-byte instead of drifting the
   archive a second time. They are NOT required to appear together — a run cancelled
   inside its first tool round commits messages without committing substantive text, which
   is 0020's still-open case. And a row that carries NEITHER key, i.e. every snapshot
   written before 2026-11-14, is still valid and restores with its exact prior meaning.
- **The listing is a WINDOW, not a cursor (spelled out 2026-11-14).** `agentManage`
  takes no input, so there is no page to continue and no token to carry back: it lists the
  **5 most recent invocations per agent** (`AGENT_MANAGE_LIST_PER_AGENT`,
  `core/agent-limits.ts`, newest first by `sequence`) and at most **200 characters** of
  each answer (`AGENT_MANAGE_PREVIEW_CHARS`, whitespace-trimmed, an ellipsis marking the
  cut with the per-row `truncated` flag as the machine-readable version). The fields
  around that window say how much is off-screen: `invocationCount` is how many records
  that agent has RETAINED (bounded by `AGENT_RESULT_RETENTION` = 64 across the session),
  `totalResults` counts every retained record in the session (running included), and
  `activeResults` counts the `running` ones — all three are COUNTING fields, never
  continuations, and nothing about the listing changes what is stored. Top-level
  `truncated` is `records.length > listed`: at least one agent has more retained
  invocations than this view shows. The ids that do NOT appear here are not lost — the
  caller already holds them, because every door that STARTS a run reports its own
  identity in its envelope (`delegate`'s `invocationId`, `threadFork`'s `branchId`, which
  doubles as the invocation id, and the terminal envelope a cancelled call carries), and
  `agentResult` pages any of them by id while it is retained. An id evicted from the
  bounded registry is gone from every door at once (issue 0029's retention trigger),
  which is why the envelopes, not a listing cursor, are the address channel
  (`agentManageView`, `invocationPreviewOf`, `recordsForAgent`).
- **No private data.** Neither tool reads system instructions, transcript
  messages, tool arguments, or tool bodies. Only answer text crosses the
  boundary — a finished answer in `content`, an unfinished one in
  `partialContent` — plus run identity.
- **Names are NOT reserved** (CORRECTED IN PLACE 2026-11-13: this bullet claimed
  `agentManage` and `agentResult` were in a `RESERVED_TOOL_NAMES` list; that
  mechanism is gone — the registry starts empty and the comment at
  `src/harness.ts` "The tool registry starts EMPTY" states "No reserved-name or
  'already registered' gate exists: later submissions win, including over the
  harness's own controls," and `registerTool`'s header repeats "names are not
  reserved, 'already registered' is not an error"). A configured, plugin, or
  created tool therefore REPLACES `agentManage`/`agentResult` by name
  intentionally, and the replacement drops the built-in definition's policy —
  pinned by `src/harness.agent-results.test.ts` and
  `src/harness.creation.test.ts`.
- **Paging, not silent truncation.** `agentResult` defaults to 4000 characters per
  page and caps `limit` at 8000 (far below the 256 KiB serialized tool-result bound
  `MODEL_TOOL_RESULT_BUDGET_BYTES` even with JSON escaping — the "64 KiB" this line
  used to cite was that constant's value before `core/result-budget.ts` raised it 4x;
  the current figure is stated where the cap itself is documented, `boundToolResult`
  in the `### API` section's R13 note). `nextOffset` pages
  the remainder, so a long
  result is read in full instead of being cut by `boundToolResult`. Offsets are
  UTF-16 code-unit indices; both page edges are moved to a surrogate-pair boundary
  so a non-BMP glyph is never split (the returned `offset` is the one actually
  used).

---

## Preset tools

`src/tools/` ships ten presets: `syntax`, the six file tools (`read`,
`write`, `edit`, `files`, `glob`, `grep`), `shell`, `gitDiff`, and
`download`. Each
is a standard `tool()` and each is executable standalone. R18 kept `read`,
`write`, `edit`, `glob`, and `grep` **core**; `files`, `syntax`, `shell`,
`gitDiff`, and (R9-R11) `download` are **searchable**.

The folder is one file per tool, one folder per capability — `tools/syntax/`,
`tools/files/`, `tools/command/` — and the barrel exports both the named tools and
`presetTools`, the catalogue the harness preloads. **Adding a tool means adding one
`*.tool.ts` file with its `metadata` + `registration` literals — that is all.** No
`PRESET_TOOLS` row, no `loadPresetTool` import branch, no barrel line is required
(T21 removed the inventory; T24 removed the stale-manifest gap). `tools/descriptors.ts`
derives the catalogue from a LIVE `tools/**/*.tool.ts` scan on Node — the same
`core/tool-scan` reader `harness({})` uses — so a cold process already lists and
loads a brand-new entry. The generated `core/tool-manifest.ts` is the BROWSER
inventory (a browser cannot read files or parse TypeScript) and only needs
regenerating (`yarn tools:manifest`) for the browser surface, never for Node.
A barrel line is needed only when the tool must also be a named public import
(`presetTools[name]` reaches it either way).

**The exports are lazy.** `tools/index.ts` builds each named export with
`lazyTool(name)` (`tools/lazy.ts`) from the discovered rows: name, description, tags,
visibility and schema are eager metadata, while `execute` resolves the real
implementation on first call — through the GENERATED `import()` when the manifest
knows the entry, and through the runtime source compiler (`prepareToolCandidate`)
when it is newer than the manifest (T24). Consequences:

- importing the package (or constructing a harness, or listing the server
  catalogue) loads no `node:fs`, `node:child_process`, or `node:vm`;
- the published shape is the source tree, so every branch stays an `import()` of its own
  `*.tool.ts` file — there is no bundling step, no chunk per implementation, and no
  `inlineDynamicImports` flag that could undo the split;
- the proxy keeps the `Tool` contract exactly — writable `name`, `tags`
  normalized like `tool()`, callable directly, `execute(context)` delegated — so
  harness registration and the server's direct-call path are unchanged;
- a failed import clears the cache so the next call retries.

Every preset is tagged. The five core file tools are declared up front; the
searchable remainder (`files`, `syntax`, `shell`, `gitDiff`, `download`) waits for
`files`/`list`/`move`/`rename`/`copy`/`delete`/`remove`/`mkdir`, `shell`, `git`,
`javascript`/`typescript`/`json`/`python`, or the `grep` tag — that is the LIBRARY
posture, where only a switch (`toolRequest` or `toolManage`) closes the gap; a session the
server CREATES starts with those names already enabled, subject to the same cap and deny
list (`enableAllTools`, see [Tool discovery](#tool-discovery)).

| Export | Call | Result |
|---|---|---|
| `syntax` | `({ code, language: string })` — validated free name: `javascript`/`js`, `typescript`/`ts`, `tsx`, `jsx`, `json`, `python`/`py`/`python3` (trimmed, case-folded, a leading dot allowed) | `boolean`; an unsupported language, a non-string `code`, a missing interpreter, and a cancelled or timed-out Python run are all ERRORS, never a verdict |
| `read` | `(paths: (string \| { path, startLine?, startColumn?, startByte?, maxLines?, maxBytes?, lossy?, numbered? })[])` — non-empty, ≤100 | a `toolText()` **envelope**, not a plain value: `{ content: { files: [{ path, content, startLine, endLine, truncated, limit, startByteAligned, nextLine, nextColumn, nextByte, bytes, sizeBytes, lineCount?, lossy?, budgetGranted?, error? }], truncated, bytes, wireBytes, contentBudget, budgetPool, modelBytes, skipped, note? }, __toolText: <projection> }` — `unwrapToolResult` hands the object to a programmatic caller (the server's manual-execute answer included) and the prose to the transcript. Per-file defaults `startLine 1`, `startColumn 0`, `startByte null`, **`maxLines 2000`, `maxBytes 65536`** — deliberately SMALL, because a read feeds a context window; ceilings 20000 lines / 262144 bytes, and an explicit value outside them is refused, never clamped. `maxBytes` is charged in **escaped wire bytes** — the unit `wireBytes` counts, not the raw bytes `bytes` reports — so a newline-heavy window stops with `bytes` well under the allowance and `limit: 'maxBytes'`. `limit` names WHICH governor cut a window (`'maxLines'` / `'maxBytes'` / `'budget'` / `null` for EOF), `budgetPool` (always present) is what the batch had left to split once the result's and every entry's scaffolding and the note reserve were taken, `budgetGranted` names the allowance an entry was actually scanned against and appears only when that batch share was smaller than its own `maxBytes`, and `lineCount` (the `wc -l` figure) appears only once EVERY line has been counted to a PROVEN end — a window stopped mid-file carries none, and a size-less pseudo-file publishes a count only after a walk actually reached its end. A truncated entry's `nextByte` is always STRICTLY PAST the offset its own window started at, so paging terminates, and `nextColumn` is counted from the PHYSICAL start of `nextLine` (never from a seek), so `{ startLine: nextLine, startColumn: nextColumn }` resumes exactly — including through a line longer than `maxBytes`. A `startColumn` past the end of `startLine` lands on the NEXT line and the entry reports the line it actually returned. The off-the-end axes answer differently: `startByte` at or past EOF is `ERANGE` (exactly AT EOF included), `startLine === lineCount + 1` is a legal empty window ONLY when the last line is terminated — the newline is what creates the position past it, so `'a\nb\n'` accepts `startLine: 3` and `'a\nb'` refuses it — `startLine` past that is `ERANGE`, and a 0-byte file answers ANY `startLine` with the empty window and `lineCount: 0`. `sizeBytes` is `number \| null`, and `null` means the size is not a filesystem fact — a FIFO, socket or device, or a regular file whose `st_size === 0` a read contradicts (`/proc`, `/sys`) — and neither `0` nor `null` is ever treated as EOF: such a target resumes from its own `nextByte` instead of answering `ERANGE`, and its `startLine` is settled against a real EOF rather than answered from byte 0. `numbered: true` is PER FILE — the `123: ` gutter lands on that file's model copy only and is charged against that file's `maxBytes` at the padded width the projection pads to. The 256 KiB budget is measured on the **serialized** result and water-filled by demand, so `modelBytes <= wireBytes <= contentBudget` always holds and the continuation fields survive the harness cap — the `note`'s own size is reserved before the split, and it appears only for a file of `65536` bytes or more whose window was cut (up to 2 paths named, the rest counted). A missing path, directory, permission denial, or **binary content** keeps its own ordered entry with `error: { code: 'ENOENT' \| 'EISDIR' \| 'EACCES' \| 'EPERM' \| 'EBINARY' \| 'ERANGE' \| 'EAGAIN' \| 'ENOTDIR' \| 'ELOOP' \| 'ENAMETOOLONG' \| 'ESPIPE' \| 'ETIMEDOUT' \| 'ECANCELED' \| 'EIO', rawCode?, message }` — a CLOSED 14, so an errno the tool does not promise is folded onto `EIO` with its untouched name in `rawCode` — and consumes no budget: ENOENT names up to 3 near-miss siblings (`FILE_READ_SUGGESTION_MAX`) or the nearest existing ancestor, EISDIR previews up to 12 entries (`FILE_READ_PREVIEW_MAX`), an `ERANGE` seek past EOF names the file's size or line count, `EAGAIN` is a FIFO with no writer (every FIFO is opened `O_NONBLOCK`, which is what replaced the kernel-level hang), `ESPIPE` is a `startByte` on a target with no file offset, and `ETIMEDOUT` is this tool's own per-file 10 000 ms I/O deadline (`FILE_READ_IO_DEADLINE_MS`, injectable through `FileReadLimits` / `DEFAULT_FILE_READ_LIMITS`) — one unresponsive mount costs one entry, never the batch; a CANCELLED call is the opposite and rejects the whole CALL with `ECANCELED` (the 14th code, and the only one of the 14 that never lands on an entry), because the caller's signal is checked before every syscall; that rejection carries `details: { rawCode, path }` with the reason the host passed to `abort()` as `rawCode` (the published rule: present because it differs from `code`) and the same object as its `cause`, and it is authored by `tools/files/cancellation.ts`, which replaced the old answer of "whatever the signal happened to carry" (measured: a `DOMException` named `AbortError` whose `code` is the NUMBER 20, not a string errno and not a member of this set); `lossy: true` substitutes U+FFFD for undecodable bytes instead of reporting EBINARY (the entry then says `lossy: true`; a NUL is still binary). Only a malformed request or a cancelled call (`ECANCELED`, see the cancellation clause above) rejects the call. The NUL check is WINDOW-scoped and the invalid-UTF-8 check CHUNK-scoped; neither is whole-file validation. A `startByte` inside a run of UTF-8 continuation bytes longer than any code point is `EBINARY` naming that offset — the alignment probe stays bounded and used to report EOF on giving up, which read as "the file ends here" over a file with readable bytes before the run. A readable file whose share of the envelope was consumed by the per-entry reserves gets the smallest window the floor allows — ONE code point, `limit: 'budget'`, `budgetGranted: 0`, and a cursor that still advances — never `EIO` |
| `write` | `(files: { path, content }[])` — non-empty, ≤100 (`FILE_WRITE_MAX_TARGETS`) | ordered `{ path, bytes }[]`; all validated first, duplicate targets rejected by file identity, NUL content rejected (read would refuse it). Serialized per file against a concurrent `edit` on the same path. Each file is PUBLISHED ATOMICALLY (`publishAtomically`, shared with `edit`): the payload goes into a staging file created next to the RESOLVED target (`realWriteTarget`, so the rename stays on one device), the existing file's mode is copied onto it (`existingMode` + `chmod`), and a same-directory rename swaps the directory ENTRY — so a reader sees the whole previous content or the whole new content, never a prefix, and a failure before the rename leaves the target exactly as it was with the staging file removed. What that trade buys, stated plainly: the target gets a NEW inode, so an already-open handle, a hard link, `uid`/`gid` and xattrs keep describing the OLD file (the mode travels, ownership does not); a read-only FILE is now overwritable, because only the DIRECTORY's permissions gate the rename; a DANGLING symlink is still HONORED, exactly as the in-place write honored it — the link survives and its missing end is created, so `path` names the link and not a new regular file (the parent directory and mode are the link's own, not the resolved directory's); a NON-REGULAR target is now refused with a stated error (`EISDIR` for a directory, `EOPNOTSUPP` for a FIFO/socket/device) instead of having the rename clobber it — and the same is true of a non-regular link TARGET, which an in-place write would have happily followed; and no `fsync` was added, so the power-loss durability boundary is the one in-place writing already had |
| `edit` | `(edits: { path, oldString, newString, replaceAll? }[])` — non-empty, ≤100 (`FILE_EDIT_MAX_TARGETS`, and the same `maxItems: 100` is published in the schema) | ordered `{ path, replacements, bytes, match? }[]`; exact-first matching (typographic and trailing-whitespace fallbacks), all preflighted before the first write, each file written once. `match` names a fallback tier and can ONLY be `'typographic'` or `'trailing-whitespace'` — there is no ending-related value; the trailing-whitespace tier matches WHOLE LINES, so an edit that came through it replaces those whole lines and the trailing whitespace inside the region goes with them. Line endings: an LF-only `newString` adopts the endings of the matched region, while a `newString` containing `\r` is ENDING-EXPLICIT and is written VERBATIM, byte for byte (`edit.tool.ts` `verbatim`), so an explicit `\r\n` is never rewritten into the file's endings — converting endings is an `oldString`/`newString` pair that differs only in `\r`, which matches exact bytes. A target whose bytes are not valid UTF-8, or that holds a NUL, is refused with `EBINARY` naming the byte offset during the preflight (`decodeEditSource` / `firstInvalidUtf8Byte`), rewriting nothing — it used to round-trip a Latin-1 file as U+FFFD and report success. The result is PUBLISHED EXACTLY LIKE `write` does (`publishAtomically('edit', ...)`): staged beside the resolved target, mode copied, renamed over the directory ENTRY — so the inode and its mode do NOT survive, an already-open handle or hard link keeps describing the OLD bytes, and a failure before the rename leaves the previous bytes exactly as they were with the stage removed. A target over `FILE_EDIT_MAX_BYTES` (8 MiB) is refused DURING THE PREFLIGHT with `EFBIG` and its `details.limit`, naming the entry — the ceiling is what keeps N fallback scans linear — and it is checked BEFORE the empty-array check, so `edits: []` can only ever mean an empty file and the tool can never report a vacuous success. A malformed entry — non-array/empty array, non-string field, or an UNKNOWN property — is refused with `EINVSTATE` plus the dotted `details.field` (`edits[0].replaceAl`), before any filesystem change, instead of reaching `undefined.replaceAll` as an unhandled TypeError; note the refusal is an unknown FIELD, not an unknown ERROR code — an invented `code` in an op is a different bug and still lands on the closed published set. A file whose current bytes already equal the result is reported `changed: false` and is NOT republished: no stage, no rename, no new inode, so a no-op does not churn a hot file's identity. That flag is the only `false` `changed` can ever hold — when a fallback tier produced byte-identical output the call still errors, because that means the model reproduced the region without changing it. Read-match-write is one per-file critical section (`./tools/files/lock.ts`), so a concurrent call re-reads the winner's bytes and fails with "no match" instead of clobbering the other's change — unless the winner happened to produce exactly what the loser wanted, which is the `changed: false` no-op above |
| `files` | `(ops: ({ op: 'list' \| 'move' \| 'copy' \| 'delete' \| 'mkdir', path? \| from+to, overwrite?, recursive?, force?, offset?, limit? })[])` - non-empty, ≤100 (`FILES_MAX_OPS`) | `{ results, bytes, contentBudget }` with ONE ordered receipt per operation: `list` → `{ path, entries, truncated, nextOffset, offset, limit, bytes, starved?, note?, error? }` (ONE page of `dir/entry`, directories end with `/` — including a symlink that resolves to one, since "walkable" is what the slash means — non-recursive; `limit` defaults to 200 and is CLAMPED into 1..1000, `offset` is clamped to ≥0, and neither is ever rejected, which is why the published schema carries NO `minimum`/`maximum` on those two fields — a schema bound would be enforced before `execute` and turn the runtime clamp into a dead branch; the 64 KiB `FILES_CONTENT_BUDGET` of entry text is ONE mutable allowance threaded through every list op in the CALL, so an op whose turn arrives after it is spent answers `entries: []` with `truncated: true` and `nextOffset` naming its own offset while entries remain past it, and `nextOffset` is `null` when nothing was withheld); duplicate or aliased spellings of one directory in a `path` array are walked ONCE, first spelling wins (`dedupePaths` by `fileIdentity`); `move`/`copy` → `{ path, to, kind, bytes, replaced? }` — `replaced: { path, kind, entries }` shows up ONLY when an existing destination was removed to make room, and it is the receipt's account of what that cost: `kind` names what stood there, `entries` counts the IMMEDIATE entries of a replaced directory or is `null` when the listing itself failed, so "unknown" is never read as "empty" (a file or a symlink costs no tree and reports 0) — an existing destination is refused unless `overwrite`, a real DIRECTORY destination additionally needs `replaceDirectory: true` (a symlink destination does not: replacing it costs the link alone), and a destination that IS the source or lies INSIDE it is refused BEFORE any filesystem change (`selfOrContained`: resolved text first, then real identity, so a symlinked alias is caught) — that guard is what stops `copy X → X` with `overwrite: true` from deleting the tree and reporting success, and `copyDirectory` additionally stops at `FILES_COPY_MAX_DEPTH` (64) levels; a symlink inside a copied tree is copied AS a symlink (target string verbatim, 0 bytes) while a symlinked directory used as the SOURCE is still followed at the top level; `delete` → `{ path, removed, recursive }` (a NON-EMPTY directory needs `recursive`, an EMPTY directory is removed without it, a DANGLING symlink is deletable because the path is examined with `lstat` before anything follows it, and a missing path needs `force` and is then reported `removed: false, skipped: true`; a NON-EMPTY directory without `recursive` is a `files-delete-non-empty` refusal that counts what is in there); `mkdir` → `{ path, created }`, creating parents, reporting an existing directory as `created: false`, and REFUSING whatever else stands there — `files-mkdir-not-a-directory` for a plain file or a symlink that resolves to a non-directory (its `details` carry `kind` and `targetExists`), `files-mkdir-dangling-link` for a symlink whose target is gone — because `mkdir` never replaces anything: `replaceDirectory` is a move/copy permission and nothing else. A failed list entry carries its own `error: { code, message, details? }` and does NOT void the directories that could be read — the surviving entries stay in the receipt, the `code` comes from the closed set `ENOENT`/`ENOTDIR`/`EACCES`/`EPERM`/`EIO`/`EXDEV` (the exported `FILES_ERROR_CODES` carries a 7th member, `ECANCELED`, and it is the CALL-level cancellation answer, never an entry's) (`filesFailureOf` folds every other raw Node errno — `ENAMETOOLONG`, `ELOOP`, `ERR_FS_EISDIR`, `ENOTEMPTY` — onto `EIO`, because a caller switches on `code` and cannot switch on a set the tool never promises) while the raw errno stays in `rawCode` — the message alone is not an interface, and it gets re-prefixed when the receipt travels through an MCP boundary; a failed mutation rejects the call and names the operations already applied (there is no rollback), with machine-readable `details`: `{ op, path, applied, appliedCount, rollback: false, failure: { code, details } }`, so an `EXDEV` rename and an `EACCES` on the same operand are distinguishable, and the batch-level `code` is the refusal's OWN code when it has one (`files-source-missing`, `files-source-is-destination`, `files-destination-inside-source`, `files-destination-contains-source`, `files-destination-exists`, `files-destination-directory`, `files-delete-missing`, `files-delete-non-empty`, `files-mkdir-not-a-directory`, `files-mkdir-dangling-link`) and only otherwise the generic `files-operation-failed`. Operations run in array order against the state each one finds, and mutations hold the same per-file locks as `write`/`edit` (`./tools/files/lock.ts`) |
| `glob` | `({ patterns?, paths?, maxResults? })` | `{ files, truncated }` — names only; the old `content` property is gone and the schema rejects it |
| `grep` | `({ pattern, patterns?, paths?, maxResults? })` | `{ matches: [{ path, line, text, textTruncated, bytes }], truncated, bytes, contentBudget }` (required `pattern`; 1 KiB snippet per line, 64 KiB aggregate) |
| `shell` | `({ command, cwd?, timeoutMs?, input?, saveOutput? })` | `{ exitCode, stdout, stderr, truncated, stdoutTruncated, stderrTruncated, stdoutBytes, stderrBytes, stdoutDroppedBytes, stderrDroppedBytes, outputPath, timedOut, aborted, exitSignal, durationMs, linesChained }`; stdout 128 KiB / stderr 16 KiB **head+tail** with an in-band `[... N bytes omitted ...]` marker (`./boundedOutput`, because build and test output is read from the end) and the full stream teed to `outputPath` when either was cut; timeout 1..600000 ms (default 120000), process tree killed best-effort (`taskkill /T` cannot reach detached/reparented descendants), and a run that finished on its own is never reported `timedOut`; stdin is closed by default and `input` feeds it; on Windows a multi-line `command` is chained with `&&` because cmd.exe otherwise executes only its first line; `exitCode` is normalised to the signed convention |
| `gitDiff` | `({ ref?, staged?, paths?, cwd? })` | `{ exitCode, stdout, stderr, truncated, timedOut, stderrTruncated, aborted }`; `paths` is one path or a non-empty array |
| `download` | `({ url, name? })` — absolute `http(s)`, no userinfo, URL ≤2 048 chars | a `toolMedia()` **envelope**, not a plain value: `{ content: { url, finalUrl, contentType, kind, name, bytes, declaredBytes?, media: 'attached', mediaId }, __toolMedia: [attachment] }` — the summary text is what the model reads, the bytes ride on the tool message (20 MiB cap, 60 s, one attempt, nothing written to disk) |

Implementation notes worth keeping:

- **`syntax` never executes code.** JavaScript compiles with `node:vm`'s
  `Script` (parses, never runs; classic scripts only — `import`/`export` report
  false). TypeScript/TSX/JSX go through the `typescript` dependency already used by
  `core/tool-source`, with `transpileModule(..., reportDiagnostics)` and the dialect
  chosen by FILE NAME (`snippet.ts` / `.tsx` / `.jsx`) — syntax diagnostics only, so a
  TYPE error is still `true`, and `<div/>` parses in tsx/jsx but not in typescript.
  JSON is strict `JSON.parse` (one leading BOM ignored), because the compiler's JSON
  reader is JSONC-lenient and `transpileModule` cannot emit a .json file at all.
  Python pipes source to `compile()` through the interpreter, which also
  only parses. Every parser is a separate module imported on demand, so a check
  in one language never loads another's Node built-in (the compiler is
  multi-megabyte and stays out of js/json/python runs).
- **`syntax` answers with a verdict only for languages it can read.** `language` has
  no schema `enum`: it is a validated free name, normalized (trim, casefold, a leading
  dot) and resolved through an alias table, and anything outside that table THROWS
  listing the supported set. A non-string `code` throws for the same reason —
  `false` must keep meaning "this snippet did not parse".
- **The Python half needs a Python 3 interpreter.** Probes `python3` then `python`
  by exit status (the Windows Store `python3` shim exists but exits non-zero) and
  caches the answer. A missing interpreter **throws** — "false" must keep meaning
  "your code is wrong".
- **The four batched file tools declare ONE array property** (`paths` / `files` /
  `edits`), so the single-property rule hands `execute` the array itself. That is
  what makes `read(['a', 'b'])` and a model call carrying
  `{ "paths": ["a", "b"] }` the same code path. `read` keeps that property while
  allowing range objects as ITEMS (`{ path, startLine?, startColumn?, startByte?,
  maxLines?, maxBytes?, lossy?, numbered? }`); per-file windows are not a second
  top-level property, and the item's `additionalProperties: false` REFUSES a typo'd
  knob rather than dropping it — silently ignoring `maxLine` would hand the caller a
  default window it did not ask for.
- **`read` is bounded by TWO numbers on each axis: a DEFAULT that is a context budget, and a
  CEILING that is the transport envelope.** A window starts at a 1-based `startLine`; per file
  the defaults are `maxLines 2000` (`FILE_READ_DEFAULT_MAX_LINES`) and `maxBytes 65536`
  (`FILE_READ_DEFAULT_MAX_BYTES`), and the ceilings an explicit argument may ask for are 20000
  lines (`FILE_READ_MAX_LINES`) and 262 144 bytes (`FILE_READ_MAX_BYTES` =
  `FILE_READ_WIRE_BUDGET` = `MODEL_TOOL_RESULT_BUDGET_BYTES`, held equal by an assertion in
  `read.test.ts` rather than an import so the preset compiles with no captured dependency).
  An explicit value outside `[1, ceiling]` is REFUSED, not clamped — a silent clamp of
  `maxBytes: 10000000` down to the envelope would report `limit: "budget"` for a request the
  caller believed was unlimited, and `limit` is the field that decides whether to ask again.
  `maxBytes` is a WIRE figure, not a `bytes` figure: it is charged in the escaped form the
  caller's context pays (`\n` costs 2 escaped bytes there and 1 raw byte in `bytes`), so a
  newline-heavy window stops at `limit: "maxBytes"` with `bytes` near HALF the allowance —
  measured, `maxBytes: 100` over `a\n` lines returns 67 raw bytes — and long lines cannot reach
  the 20 000-line ceiling on bytes at all (measured: 30 001 lines of 24 characters with
  `maxLines: 20000, maxBytes: 262144` ends at line 10 036 with 250 889 RAW bytes, and its
  `limit` is `"budget"`, because one file's share of the envelope bit before its own cap).
  The exported defaults round-trip: a caller that reads `FILE_READ_DEFAULT_MAX_LINES` and
  passes it back gets that behaviour, not a validation error.
  **Corrected in place (D11, 2026-11-12):** the bullet this one replaces — and the D6
  correction inside it, dated 2026-11-11, which argued "no default line cap: the 256 KiB
  budget decides" — measured the default against the WIRE envelope, which is not the budget
  that breaks. A default read of this package's own `src/harness.ts` (634 705 bytes,
  12 323 lines) returned 261 129 content bytes ≈ 64k-78k tokens in ONE tool result, so an
  agent that merely looked at a large file exhausted its context window immediately. A wire
  cap is a transport guarantee, not a policy about what a caller should be SHOWN, so the
  policy moved into the defaults and the ceiling stayed exactly where D6 put it. Measured on
  the same 200 000-line fixture: a default ask takes lines 1-1325 (25.3% of the envelope,
  cut by `maxBytes`), and `maxBytes: 262144, maxLines: 20000` still fills it (99.8%, cut by
  the shared budget) — so "omit the arguments" never became a synonym for "want less", it
  just stopped spending the whole window by default. Context-AWARE budgeting (sizing the
  window from the model's remaining context) is deliberately absent: a tool that guesses how
  much context is left invites the misjudgement the compaction tools exist to prevent.
  Both knobs are PER FILE because "I want this one file, generously" is one argument; the
  shared 256 KiB aggregate is still allocated by DEMAND (every readable file gets an equal
  share, files needing less hand the difference back to the files actually cut, passes are
  capped). `limit` therefore has three values, and each one has a different remedy:
  `'maxLines'` → raise `maxLines`; `'maxBytes'` → raise `maxBytes`, the only knob that widens
  ONE file; `'budget'` → the batch envelope is full, and raising either cap on that path
  changes nothing (want fewer bytes across the batch); `null` → the window reached EOF,
  nothing was withheld. It streams 64 KiB chunks and stops at the cap, so a huge file or
  giant line is never read wholesale. `content` is raw text (line 1 is `startLine`); a
  truncated entry reports `nextLine`/`nextColumn`/`nextByte`, where `nextColumn` is a 0-based
  byte offset inside the line counted from that line's PHYSICAL start and never from a seek
  (the removed seek-relative exception made `{ startLine: nextLine, startColumn: nextColumn }`
  re-read the offset it had just returned, so a mid-line walk never advanced); it is non-zero
  only for a line cut mid-line. A TRUNCATED entry's `nextByte` is always STRICTLY PAST the
  offset its own window started at, whatever the allowance: the byte cut happens BEFORE the
  character is emitted, so an allowance smaller than the first code point at the window start
  (a 4-byte emoji with `maxBytes: 3`, or a numbered window whose `123: ` gutter alone does not
  fit) used to answer an empty window whose documented continuation returned that same empty
  window forever. `startByte = nextByte`
  resumes by SEEKING with no line counting, which is the O(window) way to walk a large file;
  a line-based window at line N rescans from byte 0. A seek past EOF is an `ERANGE` entry that
  names the file's size (a byte seek) or its line count (a `startLine` past the end), never an
  empty window — an empty success teaches a model that the file is shorter
  than it is. The two off-the-end axes are deliberately NOT one rule, because "either axis is
  `ERANGE`" hides a legal case: `startByte >= sizeBytes` is `ERANGE` INCLUDING the offset
  exactly AT EOF, `startLine === lineCount + 1` is a LEGAL request for the position one past
  the last line (the empty window at EOF, which is where a finished `nextLine` walk stands),
  `startLine > lineCount + 1` is `ERANGE`, and a 0-byte file answers ANY `startLine` with the
  empty window and `lineCount: 0` — a file with no lines has nothing out of range. A
  `startColumn` past the end of `startLine` is not an error either: the skip crosses that
  line's terminator and stops on the line after it (the behaviour every version of the skip
  had), and the entry now REPORTS the line it actually returned, with `lineCount` built from
  the same prefix walk, instead of repeating the caller's `startLine` with a count one newline
  short. Binary rejection is scoped rather than whole-file, and its two checks see different
  amounts of the file: the NUL check is WINDOW-scoped (it fires on a NUL the window would have
  to CONTAIN, so a stray NUL far past the window reads as text there and as `EBINARY` on the
  page that reaches it, which is paging working as designed), while the invalid-UTF-8 check is
  CHUNK-scoped (the strict decoder is handed the whole read chunk before the window is cut, so
  a bad byte after the cut but inside that chunk also answers `EBINARY`). Bytes before the
  window and past the last chunk are never decoded, so one file can read as text for a narrow
  window and as `EBINARY` for a wide one. A call
  accepts at most 100 paths (`FILE_READ_MAX_TARGETS`) so metadata cannot grow without bound
  either.
  A path that cannot be read is DATA, not a failed call: it keeps its ordered slot as
  an entry with empty `content`, `endLine = startLine - 1`, `bytes: 0`, and
  `error: { code, message }` — `ENOENT`, `EISDIR`, `EACCES`/`EPERM`, `EBINARY`, `ERANGE`, or
  `EIO` — and it consumes no budget (the split is computed across files that actually
  opened, see `execute`'s two phases), so the readable files are still returned in
  full. A readable file whose share of the envelope was consumed by the per-entry reserves is
  NOT an I/O failure either: the first allocation pass runs whatever the share turns out to be,
  so a 0-byte allowance is simply the tightest one — an empty window, `limit: "budget"`, and a
  cursor that still advances — while `EIO` goes back to meaning "this handle could not be
  read". Only a malformed REQUEST rejects the whole call.
  `wireBytes` is the exact serialized length of the response and always satisfies
  `wireBytes <= contentBudget`, which is what keeps the continuation fields alive
  through the harness's own cap.
- **`read` answers with a `toolText()` envelope: the model reads prose, the caller reads the
  object** (`src/core/tool-text.ts`, the third branded seam after `toolUi()` and `toolMedia()`).
  The return value is `{ __toolText: <projection>, content: <FileReadResult> }`, and
  `unwrapToolResult` (`src/core/tool-media.ts`) peels text, media and panels in ANY nesting
  order at the one delivery site (`deliverTask` in `src/harness.ts`), which writes
  `text ?? serialize(content)` into the transcript. Serializing the machine result instead —
  what every other tool does, and the cheapest honest rendering available — costs escaping
  (+2.05% measured on this package's own source, +15.2% on quote-heavy code) plus ~200 bytes
  of per-entry metadata, all of it charged to the CALLER'S context window, which is the one
  budget `read` exists to protect. `content` stays byte-exact no matter how the prose is
  rendered, so diffing `files[].content` against a file and the server's manual-execute
  response are unaffected. The projection is one header line per entry (`path  lines A-B of N
  size S bytes  (reached end of file)  returned X bytes`), then the window verbatim, then a
  footer naming the cut reason and the exact continuation
  (`[truncated by maxBytes; 64258 bytes returned; continue from startByte 64258]`).
  `numbered: true` adds the `123: ` gutter to the PROJECTION ONLY — `content` stays raw — but
  the gutter's bytes are charged inside the scanner, so numbering cannot silently push the
  window past the allowance the same call bought unnumbered. It is PER FILE (one item asking
  for gutters used to number the whole batch), and the charge is the width the RENDERER pads
  to — `numberProjectionText` sizes the gutter on the WIDEST line number in the window, so a
  window over lines 998-2000 has a 4-digit gutter on every line — because billing the digits of
  each line's own number under-charged such a window, and an under-charged gutter is the one
  place `modelBytes` could exceed `wireBytes`. `bytes` never counts the gutter: it exists only
  in the model's copy, so a numbered read shows fewer bytes than the model was given. The
  boundary rules are the same
  as the other two brands: `unwrapToolResult(plain)` answers `{ content }` with NO `text` key,
  so every tool that does not use the seam is byte-for-byte unchanged at the delivery
  boundary; `toolText()` validates at the tool; and a forged or hand-built envelope is
  REJECTED at the unwrap, never silently dropped ("the model never saw it" is the quiet
  failure this prevents). The header and footer are RESERVED per file before the scan
  (`PROJECTION_HEADER_MARGIN` 128 / `PROJECTION_CONTINUATION_MARGIN` 176), which is what keeps
  `modelBytes <= wireBytes <= contentBudget` under every cut reason — an under-reserved
  projection is the one way `modelBytes` could exceed the budget and have prose cut that the
  machine view still has. The public surface is `toolText` / `toolTextOf` and the
  `ToolTextExtraction` type on `@underload/harness`; `core/tool-source.ts` registers
  `core/tool-text` in its live-core module map for the same reason it registers `tool-ui` and
  `tool-media` — a compiled preset must reach the SAME brand the harness peels, or the
  boundary serializes the wrapper instead of the prose, reintroducing every escaped byte the
  seam exists to avoid.
- **`read` explains a failure it can act on, and only on failure paths.** An `ENOENT` entry
  names up to 3 siblings the requested spelling is close to (`FILE_READ_SUGGESTION_MAX`, from
  a bounded `FILE_READ_SUGGESTION_SCAN = 200` readdir): prefix/substring ranks first — the
  shape of a half-remembered path — then a banded Levenshtein under a `floor(len/3)` cap, the
  shape of a mistyped COPY (`nested-targt.ts` for `nested-target.ts`), which no substring test
  catches. Names longer than 120 code points are not scored at all, and an empty base (`dir/`)
  suggests nothing rather than offering three arbitrary siblings. When the parent folder is
  missing too, the message names the nearest folder along the path that DOES exist and how many
  levels up it is, because then the DIRECTORY part is wrong, not just the file name; when the
  parent exists but nothing resembles the name it says so and points at `files`/`glob` instead
  of inventing a guess. An `EISDIR` entry previews up to 12 entries (`FILE_READ_PREVIEW_MAX`).
  None of this rides on a successful read: guidance the caller did not need costs the same
  context window the tool is protecting.
- **`read`'s refusals are published, and the field refusal happens before `execute`.** The request
  schema declares ONLY `paths`, and each item declares ONLY `path`, `startLine`, `startColumn`,
  `startByte`, `maxLines`, `maxBytes`, `lossy`, `numbered` — both with `additionalProperties:
  false` — so a misspelled or inherited field (`postion`, a top-level `maxBytes`) is refused
  BEFORE any path is resolved: never clamped, never ignored, because a silently-dropped bound is a
  truncated read the caller believes it asked for. That schema guard is only HALF of it, and the
  other half is a runtime check (`FILE_READ_FIELDS`, `tools/files/read.tool.ts`): the DIRECT call
  path hands `execute` its argument untouched (`core/tool.ts`), and the bare-ARRAY form of `paths`
  skips the `parameters.paths` wrapper the harness validates at all, so until T14
  `[{ path, offset: 3 }]`, plus the one-character typos `maxByte`, `maxLine` and `maxlines`, were
  served the DEFAULT window with no signal at all, the entry reporting a window its caller never
  asked for. The refusal names the key and the accepted set, in the same words
  `write files entries do not accept ...` and `edit edits entries do not accept ...` already use.
  The error alphabet is CLOSED —
  `FILE_READ_ERROR_CODES` is exactly `ENOENT` `EISDIR` `EACCES` `EPERM` `EBINARY` `ERANGE`
  `EAGAIN` `ENOTDIR` `ELOOP` `ENAMETOOLONG` `ESPIPE` `ETIMEDOUT` `ECANCELED` `EIO` — because a code outside the
  set is unrenderable downstream once the error crosses an MCP boundary, where the message gets
  re-prefixed and prose is not an interface; any other errno folds onto `EIO` and keeps its true
  name in the separate `rawCode` field, so a caller switches on `code` without losing the reason.
  Each shape has its own sentence and its own code: a DIRECTORY is `EISDIR` with a preview of the
  folder, a positional read on a PIPE / SOCKET / DEVICE is `ESPIPE` telling the caller to read it
  WITHOUT `startByte` — which works, because the tool then takes what is there instead of a
  positioned read — a FIFO with no writer is `EAGAIN` that says out loud this is NOT "the file is
  empty", a device that discards input answers `EBINARY` rather than a clean empty read, and a
  deadline trip is `ETIMEDOUT` naming the milliseconds in force while the sibling paths keep their
  content.
- **A cancelled call is refused with the published `ECANCELED`, by all four filesystem tools, at
  CALL level (T14).** Before this the four answered a cancellation four different ways: `read`
  rejected with whatever the host's `AbortSignal` carried (measured: a `DOMException` named
  `AbortError` whose `code` is the NUMBER 20, therefore neither a string errno nor a member of any
  set the tool promises), and `write`, `edit` and `files` never read `context.signal` at all, so the
  side effects ran and the call reported success to a caller that had already walked away. The
  contract in `types/index.ts` is why the answer has to travel as an ERROR: the harness releases a
  cancelled call logically even when the implementation ignores the signal, and a late result is
  discarded, so no consumer is left for a result. One module owns the decision now
  (`tools/files/cancellation.ts`; deliberately NOT named `*.tool.ts`, or
  `core/tool-discovery.ts` and `scripts/generate-tool-manifest.ts` would read it as a tool): it
  exports `FILE_CANCELLATION_CODE` (`ECANCELED`), `cancellationRawCodeOf`, `isFileCancellation`,
  `fileCancelledError` and `throwIfFileCancelled`, so the code, the `rawCode` rule and the `cause`
  rule cannot drift between the four. The code joins the published sets this wave already exposes:
  `FILE_PUBLISH_ERROR_CODES` (hence `FILE_WRITE_ERROR_CODES` and `FILE_EDIT_ERROR_CODES`, which
  spread it), `FILES_ERROR_CODES` and `FILE_READ_ERROR_CODES` (13 to 14). The check sites are the
  boundaries a host can reason about: the top of every call; once per entry for `write`/`edit` (the
  `write` half lives inside the shared publish in `tools/files/atomic-publish.ts`, so it also covers
  a target whose staging has not started); once per operation for `files`, LIST ops included, which
  is why a cancelled `list` rejects the call instead of answering an entry `error`; and before every
  syscall for `read` (the `bounded` deadline helper, the target `stat`, and the scanner, which throws
  its own `HarnessError` for `EBINARY` and therefore asks `isFileCancellation` FIRST, because a
  coded cancellation reaching that branch would be reported as "this file is binary", the most
  misleading fold available). `details` says where work stopped and what already landed
  (`completedPaths`, `applied` / `appliedCount` / `rollback`, `path`), the reason the host passed to
  `abort()` is `details.rawCode` (present because it differs from `code`, the published rule), and
  that same object is the rejection's `cause`, because `harness.ts` prefers a tool's own explanation
  of a cancellation and re-throws it instead of the generic reason. `EIO` was refused as the mapping
  on purpose: it is this harness's TRANSIENT code, the one the published descriptions teach a model
  to retry, and a cancelled call is permanent by construction. Pinned by the cancellation suites in
  all four test files, and by `read.test.ts`'s H2 pin that the whole call is rejected rather than
  answered with whichever entries had landed.
- **`read` reports the pool, not just its own spend, and its cuts respect code points.** The
  call-wide envelope is `FILE_READ_WIRE_BUDGET` (256 KiB of ESCAPED WIRE bytes), `maxBytes` is the
  only knob that widens ONE file (default 65 536, schema maximum 262 144) and is charged in that
  same wire unit, and `budgetPool` reports what was ACTUALLY left for content once the per-entry
  reserves were taken: 40 paths against that envelope is a pool of about 5 KiB per file no matter
  what `maxBytes` asked for, and without the number a caller can see its batch was cut but cannot
  tell why. A failed entry consumes NO pool, so it cannot shrink the window of a file that does
  exist, and an entry the pool never let open carries `sizeBytes: null` rather than a size it never
  learned. The floor of every cut is ONE CODE POINT, never one byte — slicing UTF-8 mid-code point
  would return U+FFFD and label it a truncation notice — and the cursor still advances, so a
  one-code-point window is a page, not a stall. The caution the code itself carries belongs here:
  `maxBytes` bounds BYTES, so a line of a variable-length-line pseudo-file (`/proc/*` and friends)
  changes size and content between reads, and an agent that re-reads a pid-keyed `/proc` path and
  reports the first N lines "hasn't changed" has proven very little.
- **`write` / `edit` preflight everything.** Every entry is shape-checked,
  every target must be unique **by real file identity** (`tools/files/identity.ts`:
  `realpath`, plus the nearest existing ancestor for a file that does not exist yet,
  case-folded only on Windows — so `notes.txt`/`NOTES.TXT` and symlink aliases are
  caught, while Linux keeps `a.ts`/`A.ts` as two files), and (for edits) every file
  is read and match-checked before the first byte is written, so one bad entry leaves
  every file untouched. A filesystem error during the write phase names the completed
  paths: there is **no transaction and no rollback**. What the failed entry looks like IS
  defined, and `write`'s staged publish is what makes it honest: the target it failed on keeps
  the text it had before (or stays uncreated), never a partial prefix, and its staging file is
  removed — so the "already completed" list never implies a half-written file. `edit` publishes the
  SAME way (`publishAtomically('edit', ...)`), so both tools carry that per-file publish guarantee
  and NEITHER keeps the target's inode: the mode travels to the new file, an already-open handle or
  hard link keeps the old bytes, and only the DIRECTORY's permissions gate the swap.
- **`write` / `edit` hold one critical section per file** (`tools/files/lock.ts`,
  keyed by that same file identity). Read-match-write is three awaits, so two
  overlapping calls used to read one original text, both match, both report success,
  and the last write silently won (measured: `VERSION-0` plus three concurrent edits
  ended at `VERSION-C` with all three claiming to have applied). With the lock the
  later call RE-READS the winner's bytes and fails honestly with "no match" — unless the
  winner produced exactly what the loser asked for, in which case that entry reports
  `changed: false` instead of failing. Only `write`, `edit` and the `files` MUTATIONS
  take the lock; `read`, `glob` and `grep` take none, and `read` deliberately runs
  OUTSIDE every critical section so its output is exactly what a cold page cache
  returns. A
  multi-file batch acquires its locks **deduplicated and sorted by identity** and
  releases in reverse, so two batches naming overlapping files cannot deadlock. The
  map entry is dropped when the last holder leaves, so the key set does not grow with
  the number of files the process has touched. This is per-process, per-event-loop
  only: it orders nothing against another process or worker thread, and claims not to.
- **`edit` is exact-first and guarded (opencode v2 matching).** Matching runs a
  three-tier cascade on an LF view of the file: exact bytes, then typographic
  quote/dash/space folding, then trailing-whitespace-ignoring whole-line matching —
  a fallback tier only runs when the tier above found NOTHING, and indentation is
  never forgiven. That trailing-whitespace tier compares WHOLE LINES, so its match is the whole
  line SPAN rather than the caller's `oldString`: replacing "a\nb" in "a   \nb\t\t\nz\n"
  through it removes the two tabs on the second line too, because they were inside the matched
  lines, and the `match: "trailing-whitespace"` receipt is what makes that widening visible
  instead of incidental. CRLF/mixed endings are matched, and an LF-only `newString` comes back
  with the endings of the matched region (a line that survives the edit reuses that line's
  ending); an oldString/newString pair that differs only in `\r` matches exact bytes, which is
  how endings get CONVERTED. A `newString` containing a `\r` is ENDING-EXPLICIT and is written
  VERBATIM, byte for byte — no fold to LF, no region re-join — so an explicit `\r\n` is never
  rewritten into the file's endings; before that rule the fold deleted every `\r\n` in
  `newString` and a lone `\r` it left behind produced a carriage return the caller never asked
  for. There is no ending-related `match` value and no ending knob in the schema at all: `match`
  is only ever `"typographic"` or `"trailing-whitespace"`. `oldString` must appear exactly
  once or `replaceAll: true` must be passed; an edit whose result is byte-identical to the
  file it came from reports `changed: false` and is NOT republished (no stage, no rename, no
  new inode) — that is the only `false` the field ever holds, because when a FALLBACK tier
  produced those identical bytes the call still errors: it means the model reproduced the
  region without changing it. Each file is read as BYTES and must decode as
  UTF-8 with no NUL (`decodeEditSource`): a Latin-1 target used to round-trip as U+FFFD and
  report a plain success, and it is now refused with `EBINARY` naming the offending byte offset
  — in the preflight, so the refusal rewrites nothing. One call carries at most
  `FILE_EDIT_MAX_TARGETS` (100) entries, the cap `read`, `write` and `files` already publish,
  enforced BEFORE any validation or filesystem work so a refused batch never appears to have
  applied its first 100 entries. A missing file is an error that says
  so and names `write` (the raw errno used to leak as `ENOENT: no such file or
  directory, open '...'`, which named no remedy); a directory target is classified as
  a directory rather than a permission denial, which matters because Windows reports
  EPERM for both. A target over `FILE_EDIT_MAX_BYTES` (8 MiB) is refused IN THE PREFLIGHT with
  `EFBIG` and its `details.limit`, naming the entry, and that ceiling is checked BEFORE the
  empty-array check so `edits: []` can only ever mean an empty file; a malformed entry —
  non-array, empty array, non-string field, or an unknown property — is refused with
  `EINVSTATE` plus the dotted `details.field`, before any filesystem change, instead of
  reaching `undefined.replaceAll` as an unhandled TypeError. The result is then PUBLISHED the
  way `write` publishes (`tools/files/atomic-publish.ts`): staged as a `.tmp-` sibling beside the RESOLVED target, the current
  file's mode copied onto it, then renamed over the directory ENTRY — so the inode and its
  mode do NOT survive, an open handle or hard link keeps the old bytes, a read-only FILE is
  overwritable because only the DIRECTORY gates the rename, and a failure before the rename
  leaves the previous content exactly as it was with the stage removed. The result reports
  `replacements`, the new byte size, `changed: false` for a no-op, and `match` when a fallback
  tier was used.
- **`files`' `list` operation takes one directory or several and returns ONE PAGE.**
  `files([{ op: 'list', path: ['src', 'task'] }])` returns one flat list whose entries
  are prefixed with their directory (`src/a.ts`, `src/nested/`, `task/b.ts`); directories
  keep the trailing `/`. It stays **non-recursive** - `glob({ patterns: ['**/*'] })` is the
  walking tool - and omitting `path` lists the working directory, returning bare entry
  names. Paging state lives INSIDE the list receipt (`{ entries, truncated, nextOffset,`
  `offset, limit, bytes, starved?, note? }`), which is what lets `files` declare ONE array property (`ops`)
  where `fileList` needed three - the catalogue's last exception to the batching rule is
  gone. The 64 KiB entry-text budget (`FILES_CONTENT_BUDGET`) is ONE mutable `{ remaining }`
  allowance threaded through every list op in the CALL, so it means "64 KiB across the whole
  call", not per op: the second list op starts where the first stopped, a page stops BEFORE the
  entry that would cross it (no entry is ever split), and an op whose turn arrives to a spent
  budget answers `entries: []`, `truncated: true`, `nextOffset: <its own offset>` — a cursor at
  the entry that did not fit, never one that silently walks past it. The receipt tells the two
  ways an op comes up empty apart: an op that CONSUMED its share and simply stopped at the
  allowance says `truncated: true` with no `starved`, while an op whose turn arrives to a pool
  that was ALREADY spent says `starved: true` and repeats the reason verbatim in `note` — that
  op never ran, which is a different fact from having spent its share. `starved`/`note` are
  absent, never `false`, when the pool had room. An entry whose OWN UTF-8
  size exceeds the whole budget is a refusal naming it and its offset, because its cursor could
  never advance. Unlike `fileList`, a directory that cannot be read is that entry's own `error`
  (`ENOENT`/`ENOTDIR`/`EACCES`/`EPERM`/`ECANCELED`/`EIO`/`EXDEV` — a CLOSED set exported as
  `FILES_ERROR_CODES` so a caller can type the switch; `filesFailureOf` folds every other raw Node
  errno — `ENAMETOOLONG`, `ELOOP`, `ERR_FS_EISDIR`, `ENOTEMPTY` — onto `EIO` and puts the real name
  in `error.rawCode`, because the message gets re-prefixed when the receipt travels through an MCP
  boundary and prose is not an interface) rather than a failed call, because a read-only miss must not
  discard mutations the same call already applied — and it does NOT void the directories that
  could be read: each requested directory is collected in its own `try/catch`, the window is
  computed over the SURVIVING sequence, and the receipt carries those entries beside an `error`
  naming the directory the tool actually tried to read (answering `entries: []` with
  `truncated: false` would claim a COMPLETE listing of a directory the tool never managed to
  open). The server's direct-call route resolves both the
  legacy bare value and the wrapper through the shared validator
  (`resolveToolParameters`, 'direct' mode), so they are the same request. An explicit
  `[]` is still an error. Directories are visited in the caller's order, each listing
  sorted by code point, and a directory named twice (`src`, `./src`, or a symlinked alias) is
  walked ONCE: `dedupePaths` compares by `fileIdentity` and keeps the first spelling, because a
  second pass duplicates every entry AND moves `offset` underneath a caller that is paging. A
  symlink that resolves to a directory carries the trailing `/` — "walkable" is what the slash
  means to a caller and the walk does follow it — while a link whose target is gone or looping
  keeps the plain name instead of failing the listing.
  The receipt is `{ entries, truncated, nextOffset, offset, limit, bytes, starved?, note?, error? }`:
  `contentBudget` belongs to the ENVELOPE (`{ results, bytes, contentBudget }`) and never to a
  receipt. A page holds at most 200 entries by default (hard maximum 1000) beside the byte
  budget above, and `limit`/`offset` are CLAMPED, never rejected — `limit` into 1..1000,
  `offset` to ≥0, a non-number still an error — with NO `minimum`/`maximum` in the published
  JSON Schema on purpose: this harness validates a model's arguments BEFORE `execute`, so a
  bound written there would reject `limit: 5000` first and turn the runtime clamp into a dead
  branch, leaving the "an oversized page is never rejected" promise true only for a host holding
  the tool object. `truncated` means entries exist past this page — cut by the entry cap or by
  the shared byte allowance — and `nextOffset` is then `offset + entries.length`, or `null` when
  nothing was withheld, so passing it back as `offset` walks the list once, in order, with no
  gaps or duplicates. There is no `total` and no keyset cursor, so an `offset` past what the
  directory holds reads as an empty page carrying EXACTLY `truncated: false` and
  `nextOffset: null`: the request was satisfied and there is simply nothing at that offset, which
  is the opposite of the spent-pool answer above — a caller that pages until `truncated` is false
  stops correctly, and one that retries on an empty entries array instead loops forever. The old `string[]` return is gone: a
  caller that only wants names reads `.entries`.
- **`files` refuses a destination that IS or CONTAINS its source, before a byte moves.** A
  `copy`/`move` whose `to` is the source or lies under it is a refusal naming both paths
  (`selfOrContained`), whatever `overwrite` says, because both shapes destroy the call: `copy
  X → X` with `overwrite: true` removed the destination — which WAS the source — and then copied
  nothing onto it, so the tree was gone and the receipt reported success; `copy X → X/inside`
  walked into its own freshly written output until the path overflowed, leaving a half-built
  garbage tree with no rollback; `move X → X/inside` is the same impossibility one syscall deep
  (POSIX answers `EINVAL`, and only after the destination was removed). The check is TEXT first
  (`resolve`, so `X`, `./X` and `a/../X` are one path) and then by REAL IDENTITY, so a symlinked
  alias of the source — or a destination that is itself a link pointing at it — is caught as the
  same thing on disk rather than different spellings. NOTHING on the filesystem is touched
  before it passes: not the destination's parents, and not the `overwrite` removal.
  `copyDirectory` refuses past `FILES_COPY_MAX_DEPTH` (64) levels as the belt behind those
  braces — a source that slips the guard is named instead of overflowing the stack mid-tree —
  and a symlink inside a copied tree is copied AS a symlink (`readlink` → `symlink`, target
  string verbatim, 0 bytes because a link holds no payload), which is also what stops a link
  pointing at an ancestor from being dereferenced into an endless walk. A symlinked DIRECTORY
  named as the source is still followed at the top level, which is what a caller naming it
  means.
- **`files`' `delete` asks permission for trees, not for empty directories.** A NON-EMPTY
  directory without `recursive` is refused with the instruction to pass it; an EMPTY directory
  is removed, because that is exactly what the caller named (emptiness is decided by `readdir`,
  and a directory that cannot be listed is treated as non-empty rather than deleted). The path
  is examined with `lstat` FIRST and only followed with `stat` for the directory question, so a
  DANGLING symlink — `stat` calls it missing because its target is gone — stays a real,
  deletable entry with or without `force`. A missing path is an error unless `force: true`,
  which reports `removed: false, skipped: true`: "already gone" is a success, not a surprise.
  A NON-EMPTY refusal is not a swallowed recursive attempt: emptiness is checked first and a
  verified-empty entry is removed with `rmdir` (a real directory) or `unlink` (a symlink),
  NEVER the widened `rm({ recursive: true })` — the widened call succeeds and takes the whole
  tree with it, which would make a path the receipt just called too busy to delete disappear
  anyway. A child that appears between the emptiness check and the removal therefore surfaces
  as the `ENOTEMPTY` refusal it was always meant to be, not as an unplanned recursive delete
  followed by `removed: true`. `recursive` is therefore never inferred from what the tool happens
  to be able to undo.
  The failure halves differ on purpose: a failed list op is an in-band receipt entry, while a
  failed MUTATION is a `HarnessError` naming the operations that already ran AND carrying
  machine-readable `details` — `{ op, path, applied, appliedCount, rollback: false, failure: {
  code, details } }` — so an `EXDEV` rename and an `EACCES` on the operand are distinguishable, and a cancelled call reaches the caller the same way with `ECANCELED`
  without parsing prose. The batch-level `code` is the refusal's own `files-*` code when it has one
  (the `FILES_REFUSAL_CODES` alphabet: `files-source-missing`, `files-source-is-destination`,
  `files-destination-inside-source`, `files-destination-contains-source`,
  `files-destination-exists`, `files-destination-directory`, `files-delete-missing`,
  `files-delete-non-empty`, `files-mkdir-not-a-directory`, `files-mkdir-dangling-link`) and only
  otherwise the generic `files-operation-failed`; the closed errno set (`FILES_ERROR_CODES`) belongs
  to the list receipts, where a read-only miss must not discard the mutations that already
  succeeded. A failed MOVE also says when `overwrite` had ALREADY removed the destination before the
  `rename` failed — including the entry count of what was lost and that the source is still where it
  was — because "applied: none" alone reads as "nothing happened" over a destination that no longer
  exists. A mutation holds the same per-file locks
  as `write`/`edit`, but only for its ENDPOINTS: a concurrent `write` to a file INSIDE a
  directory being moved is not ordered against that move, and nothing here claims it is.
- **`files` gates a destination DIRECTORY behind `replaceDirectory`, and bills the removal in the
  receipt.** `overwrite` alone clears a file or a symlink at the destination; a real destination
  DIRECTORY needs `replaceDirectory: true` as well, because that replacement is a recursive removal
  and the tool will not infer it from a boolean that only says "replace what is there". A
  destination that is a SYMLINK, live or dangling, is not a tree: replacing it costs the link alone,
  exactly like `delete` on a link, so no extra permission is asked for. When a removal does happen,
  the move/copy receipt carries `replaced: { path, kind, entries }` — `kind` names what was
  destroyed (`file` / `directory` / `symlink`) and `entries` counts the IMMEDIATE entries of a
  replaced directory, or `null` when that listing itself failed, because "unknown" must never read
  as "empty"; a file or a link holds no tree and reports 0. The refusal side counts too: an
  unauthorised directory destination is refused with how many entries it holds and suggests the
  answer the caller usually means, a path INSIDE the directory, while a directory that cannot be
  listed is treated as non-empty (the safe side) and says so instead of claiming 0. `mkdir` asks for
  nothing and replaces nothing: an existing directory is `created: false`, a plain file or a symlink
  that resolves to a non-directory is `files-mkdir-not-a-directory` with `kind` and `targetExists`
  in `details`, and a symlink whose target is gone is `files-mkdir-dangling-link`.
  The same `replaced` field marks a `force`-cleared symlink in a `delete` receipt.
- **Search is TWO tools, not one tool with two modes.** `glob` answers with names
  (`{ files, truncated }`) and `grep` answers with lines
  (`{ matches, truncated, bytes, contentBudget }`); the old `content` discriminator is
  gone from `glob`'s schema (`additionalProperties: false`), so a stale request is
  rejected rather than silently reinterpreted, and there is no `fileSearch` alias.
  Both share `tools/files/search.ts`, so the rules below apply identically to each:
  `patterns` default `['**/*']` and are OR-ed; a pattern with no `/` also matches
  file names at any depth, and a pattern is matched against a file path **relative
  to each root** (results are root-prefixed, never absolute-matched). `paths` default
  `['.']` and are walked in caller order; overlapping roots are deduplicated by root
  identity first (a symlink alias, or `src`/`SRC` on Windows, is walked once) and
  then files by resolved identity, with the first root winning the prefix; the cap is
  global. A non-object argument (a string or an array) is rejected instead of
  silently meaning "every file", and an explicit empty `patterns`/`paths` array is
  rejected instead of matching nothing. Both skip `.git` and symlinks always, and skip
  `node_modules` unless a root is placed inside it; both honor the `.gitignore` files
  **at or below** each root (`tools/files/gitignore.ts`), so an ignored path is neither
  listed nor read, while a root you name explicitly is still walked because no rule
  above a root reaches into it. `grep` additionally skips binaries and files over 1 MiB,
  caps its result at 100
  matches (clamped 1-100), cuts each match to a 1 KiB snippet on a code-point boundary
  with `textTruncated`, and stops the whole call at a 64 KiB aggregate with
  `truncated`; `.git/info/exclude` and the global `core.excludesFile` are not read.
- **Content matching is time-bounded.** grep's `pattern` is a JavaScript regex, and
  JavaScript regexes backtrack: `(a+)+$` blocks the process for seconds on a 31-byte
  line. `tools/files/bounded-regex.ts` therefore runs the match loop inside
  `node:vm` with a cumulative 30-second MATCHING budget for the whole search
  (`MAX_CONTENT_MATCH_MILLIS`; charged only by measured regex execution, never by
  walking or reading — one context and one precompiled script per search, one call
  per FILE, so ordinary greps cost the same as before). That is the only time bound
  on MATCHING. CORRECTED IN PLACE
  2026-11-09: the clause here used to claim "there is no additional overall request
  timeout", and that stopped being true when the grep tool grew its own whole-search
  wall clock — `MAX_SEARCH_MILLIS` (30 s over walk, reads, and matching together,
  `src/tools/files/grep.tool.ts`). The two bounds now answer differently, which is
  the point of keeping them separate: exhausting the MATCHING budget is the
  pattern's fault and throws a `HarnessError` naming the budget and the likely
  cause, while exhausting the SEARCH budget is the TREE's fault and returns a
  partial result (`partial: true`, `stopReason: 'searchBudget'`, a note to narrow
  `paths`/`patterns`). A big search is a partial answer; an expensive pattern is an
  error; neither is ever reported as the other. It is a timeout, not a sandbox; an
  invalid pattern still fails in the host realm so the caller gets the parser's own
  `SyntaxError`.
- **`gitDiff` is the read-only git path.** A fixed argv with no shell, no colour,
  no external diff drivers, no textconv; `ref` may not start with `-`, and paths
  go after `--`. Non-zero exit is data, like `shell`.
- **No sandbox anywhere.** Paths resolve against `process.cwd()` and are used as
  given; `shell` and `gitDiff` run with host permissions. This matches other
  CLI harnesses: powerful by default, fenced by the process boundary the host
  provides. Say so loudly in docs.
- **Non-zero exit is data.** `shell` / `gitDiff` resolve with `exitCode`
  rather than throwing, so the model can read a failing command and react.
- `write` creates parent directories and returns the absolute path + byte
  count, because agents write into not-yet-existing directories constantly.

---

## Web search

`search` is the one preset-shaped tool that is **not** in `presetTools`, and the
reason is the design: it needs a provider credential, and a credential belongs to
one harness. A module singleton would freeze the first key ever read and advertise
a network tool the host may not be able to authenticate.

**Factory, not catalogue entry.** `createWebSearchTool({ env?, exa?, tavily?, linkup? })`
(`tools/websearch/index.ts`) resolves keys **once, at construction** (a getter is
not re-read per search; there is no rotation), and returns
`Tool<WebSearchParameters, WebSearchResult> | undefined`. `undefined` is not an
error: it means no provider has a usable key, and that is also what makes
`websearch: true` a no-op on a keyless host.

| Input | Result |
|---|---|
| absent / `false` | no tool |
| `true` / `{}` | read `EXA_API_KEY` / `TAVILY_API_KEY` / `LINKUP_API_KEY` from `process.env` |
| `env: {...}` | same, from an injected snapshot (tests, deploy) |
| `exa.apiKey` / `tavily.apiKey` / `linkup.apiKey` | explicit string or getter (called once), wins over env |
| explicit blank key | that provider is off, **without** falling back to env |
| no provider with a key | `undefined` |
| configured `tools.search` | wins; the factory is not consulted |

harness.ts registers the result after configured tools and before the reserved-name
check (so a preset or plugin cannot claim the name first), and only when
`configuration.websearch` is truthy (the field keeps its name) and no custom `search` exists. **A configured
`search` is core (R18)**: it is declared on every request, so the model calls it
directly instead of spending a toolRequest round. Registration is still conditional
on a usable key, so a keyless host neither declares nor lists a runnable search
tool. Keys live in the tool closure: two harnesses never share one, and nothing
enters the schema, arguments, result, events, `RunnerSettings`, the UI, or a client
payload.

**Catalogue visibility (C1).** `src/server/harnesses/websearch.ts` always produces an entry
for the direct-call catalogue. `createWebSearchCatalogueEntry()` calls the factory
at run time and returns `{ entry, tool? }`:

| Host state | Catalogue result |
|---|---|
| any of `EXA_API_KEY` / `TAVILY_API_KEY` / `LINKUP_API_KEY` present | entry + executable tool; `availability: { state: 'available', environment: [...] }` |
| no usable key | entry with `WEB_SEARCH_METADATA` and no `tool`; `availability: { state: 'unconfigured', environment: [...], hint }` |

`src/server/harnesses/index.ts` exports `createToolCatalogue(options?)` instead of module-level
`catalogue`/`allTools`. The factory is what makes startup ordering safe: the server
and CLI load `.env` after their imports, then build the catalogue, so the key is
captured once for the handler's lifetime (never at module evaluation). `websearch`
is group `'Web search'` and `webfetch` is group `'Web fetch'` (the `ToolGroup` union in
`src/server/harnesses/types.ts`); existing groups and the CLI column layout are
unchanged.
`GET /v1/harness/tools` sends the optional `availability` field on every row;
`POST /v1/harness/tools/search/executions`
executes the injected tool when configured and returns `{ ok: false, error }` with
the hint when not. No path echoes a key value — the hint carries variable names
only.

**The fetch entry is the same shape with a different gate.**
`src/server/harnesses/webfetch.ts` exports `createWebFetchCatalogueEntry({ enabled?,
configuration? })` -> `{ entry, tool? }`. `enabled` defaults to `true`, because every
live preset builds its toolbox with `webfetch: true` (`./toolbox.ts`) and the `native`
provider needs no credential; a host that never opts in passes `enabled: false` and
gets the entry with `WEB_FETCH_METADATA`, no `tool`, and
`availability: { state: 'unconfigured', environment: ['EXA_API_KEY', 'LINKUP_API_KEY'],
hint }`. `createToolCatalogue()` appends it right after `search`, and that pairing is
what lets `describeHarness` name `fetch` in a card's `tools`/`coreTools`: a descriptor
advertises an environment tool only when the catalogue can actually run it.

**Wire contracts** (fixed endpoints, keys in headers only):

- Exa — `POST https://api.exa.ai/search`, `x-api-key`, body
  `{ query, type: 'auto', numResults, contents: { highlights: true } }`, response
  `results[{ title, url, highlights: string[], publishedDate? }]`.
- Tavily — `POST https://api.tavily.com/search`, `Authorization: Bearer`, body
  `{ query, max_results, search_depth: 'basic', include_answer: false,
  include_raw_content: false }`, response `results[{ title, url, content,
  score?, published_date? }]`.
- Linkup — `POST https://api.linkup.so/v1/search`, `Authorization: Bearer`, body
  `{ q, depth: 'fast', outputType: 'searchResults', maxResults }`, response
  `results[{ type, name, url, content, favicon }]`. `name` is the title and
  `content` the excerpt; `type`/`favicon` are dropped and Linkup sends no
  publication date, so `published` is simply absent for this provider.
  `depth: 'fast'` and `outputType: 'searchResults'` are pinned for cost and
  shape: an LLM-composed answer would be model output presented as a search
  result (the same reason Tavily's `include_answer` is off).

`numResults` / `max_results` / `maxResults` are always set explicitly: the
provider default must not decide the tool's context cost. `score` is ignored;
highlights are joined into one snippet.

**R12 hardening.** A snippet is redacted BEFORE it is cut to the per-result limit, so
a secret cannot survive in the retained prefix of a truncated highlight. A URL is
accepted only when it parses, is `http(s)`, has NO userinfo, and is at most 2048
characters; `published` is kept only when it is a string of at most 64 characters.
The provider response is read through a streamed 512 KiB body cap, so a runaway page
or a hostile provider cannot allocate an unbounded buffer. These are input/output
bounds, not a claim that a search result is trustworthy.

**Bounds** (`tools/websearch/request.ts`): 5 results by default, 20 maximum
(clamped), 300-character title, 1,000-character snippet, a **512 KiB**
(`512 * 1024` bytes) response read per streamed chunk with a `content-length`
pre-check, 15 s timeout via `AbortController` cleared in
`finally`, `redirect: 'error'`, http(s)-only result URLs. Rows without a valid URL
are dropped, not fatal; the first row's title falls back to its URL. The 512 KiB
budget is the PROVIDER budget; the `fetch` tool's page GET is held to 1 MiB
instead (see [Web fetch](#web-fetch)).

**Cost policy:** one request, no retry, no failover, one provider. The default is
the first provider with a key in the fixed `PROVIDERS` order **exa → tavily →
linkup** (so Exa wins whenever its key exists, and appending a provider later
never reorders what an existing deployment resolves to); `provider` overrides per
call and is only offered when more
than one is configured. 401/403 → key rejected, 402/432/433 → credits/quota, 429
→ rate limited, other non-2xx → HTTP status; timeout, network failure, non-JSON,
and a missing `results` list each get one fixed sentence. **The provider body is
never echoed**, so an error cannot print a key, an account name, or HTML.

**Secret hygiene:** every returned string (title, URL, snippet, published) passes
through `createRedactor` over *all* non-empty configured keys, however short, so
even a page quoting a key becomes `[redacted]`. The description names configured
providers but never a value; no environment variable name appears in metadata
either.

**Laziness:** `tools/websearch/index.ts` statically imports only `tool`, types,
`HarnessError`, and `request.ts`; `exa.ts` / `tavily.ts` / `linkup.ts` are
`import()`ed inside `execute` (one explicit branch per provider, so a fourth
provider fails loudly there instead of silently running Linkup's adapter). No
SDK: all three adapters use `fetch`. A failed import is a plain tool error
and is not cached, so a later call can retry.

**Application wiring:** EVERY shipped preset (`general`, `instruct`, `research`,
`workspace`, `reviewer`, `planner`, `debugger`) passes `websearch: true` AND
`webfetch: true` through the shared toolbox (`src/server/harnesses/toolbox.ts`), so
the CLI and server read search keys from their own process environment. There is no
endpoint-free preset left to exempt — the scripted `demo` and the `flaky` example are
deleted — so every card declares `environmentTools: ['search', 'fetch']` to match what
the factory registers.
This is why no search key was added to `RunnerSettings` or the Endpoint panel. The
app entry points preload the package-root `.env` into `process.env` (see “CLI,
server, and UI”); the library still has no autoload and importing it never reads a
file.

**Preset descriptors follow the catalogue.** Those live presets also declare
`environmentTools: ['search', 'fetch']` in `src/server/harnesses/presets.ts` — metadata
only, no harness is built to answer a listing. `describeHarness` appends such a name
to the preset's `tools` only when the runtime catalogue holds an executable definition
for it, and includes it in `coreTools` under the same condition (R18). That pairing is
why each web name has its own catalogue module
(`src/server/harnesses/{websearch,webfetch}.ts`): without a `fetch` entry a card could
never advertise the declaration its harness really makes. A keyless host therefore
advertises no search at all (the global catalogue still shows the tool as unconfigured
with its hint) but does advertise `fetch`, because the `native` provider needs no
credential. Core file tools in `coreTools` are likewise filtered by the preset's
registered names. Both web
names are declared CORE when registered (R9-R11): a configured search and any enabled
fetch are in the first request's schema, while the eleven demoted runtime rows and
`download` wait for `toolRequest`.

**Operator surface.** `/websearch <query>` is the built-in slash command over the
registered `search` tool; when the tool is absent it answers the configuration guidance
instead of a registry error (see [Slash commands](#slash-commands)).

---

## Web fetch

`fetch` (`tools/webfetch/`) is the page-reading sibling of `search` and follows the
same factory rule (`createWebFetchTool({ env?, exa?, linkup? })`), with one
deliberate difference: **it always returns a Tool.** The default provider is
`native`, a direct GET with no credential, so "opted in but keyless" is still a
runnable tool. `harness({ webfetch: true })` registers it; the configuration field
keeps the folder name while the TOOL is `fetch`.

| Fact | Behaviour |
|---|---|
| Default provider | `native`, always — even when an Exa/Linkup key exists. Hosted crawlers cost credits, so they are never a silent upgrade; `provider` picks them per call. |
| Keyed providers | `exa` (`EXA_API_KEY`) and `linkup` (`LINKUP_API_KEY`) only. Tavily is search-only. Same explicit-string-or-getter resolution as search: omitted → env, explicit blank → provider absent with no env fallback. |
| Schema | `url` (required), `format` (`markdown` default / `text` / `html`), and `provider` ONLY when a hosted key resolved (`available.length > 1`). |
| Visibility | `core` (R9-R11, same policy as a configured `search`): a harness that registered `fetch` declares it on every request, so researching a page costs no `toolRequest` round. The gate is REGISTRATION, not visibility — no `webfetch` opt-in means no tool and no declaration. Registration: `tools/runtime/fetch.tool.ts`, `activation: 'webfetch'`, `mode: sync`, `order: 250`. |
| Redirects | Followed; the result reports the final URL (the hosted JSON calls keep search's `redirect: 'error'`). |

**Text only, and the bound is a policy pair.** `tools/webfetch/request.ts` caps a
native page at **1 MiB** (`MAX_RESPONSE_BYTES = 1024 * 1024`, `:71`) — checked against
`content-length` before the body is touched and then per streamed chunk, cancelling the reader
the moment the budget is crossed — and returns at most **240,000 characters**
(`MAX_CONTENT_CHARS`, `:75`; `truncated: true` when cut). 1 MiB (not the 512 KiB the provider
requests allow) is the point: a page that does not fit is a file, not an article.
**Corrected in place 2026-11-11:** this paragraph quoted **100 KiB / 24,000 characters**; both
figures were raised 10x, the byte cap because the old 100 KiB was acting as a CONTENT budget
(a measured run over the top ten results of a real search found 5 of 8 pages unreadable purely
because their raw HTML was over 100 KiB — GitHub, a13n.dev, arxiv, a docs site, Wikipedia — each
costing a wasted model turn), and the measured reasoning is the comment at
`src/tools/webfetch/request.ts:62-70`. The
content-type gate agrees with that sentence: no header is treated as text, and the
readable set is `text/*`, `application/json`, `*+json`, `application/xml`,
`*+xml`, `application/xhtml+xml`, the JS/TS MIMEs and `image/svg+xml` (SVG is
text, and must be checked BEFORE the `image|audio|video/` family rejection).
Everything else is refused with one sentence that names `download`, so the tool
description and the gate are one policy stated twice. Timeout is 15 s with one
attempt per user agent, plus a single honest-`User-Agent` retry (`underload-harness`)
when Cloudflare answers `cf-mitigated: challenge` to the browser-impersonating one.

The hosted adapters reuse `tools/websearch/request.ts`'s `requestSearch` (fixed
endpoint, JSON body, key in a header, no redirects, 512 KiB streamed response cap,
sanitized status errors), so a hosted fetch failure reads "Exa search …" /
"Linkup search …" — one error vocabulary per api host. Exa's `/contents` takes
`text.maxCharacters` server-side (the local slice is a formality there); Linkup's
`/v1/fetch` has no such knob, so `MAX_CONTENT_CHARS` is applied locally. Both
answer markdown, so the reported `contentType` on those paths is `text/markdown`.
Redaction happens BEFORE the character cut (the search lesson: bounding first can
leave a secret prefix at the cut), over every configured web key.

**Application wiring:** the shared toolbox passes `webfetch: true`, so a live
session always has `fetch` registered (native on a keyless host) and declares it as
core. It is part of the server's direct-call catalogue too
(`src/server/harnesses/webfetch.ts`, group `Web fetch`): `createToolCatalogue()`
holds the package presets, the app tools, the `search` entry, and the `fetch`
entry, so `POST /v1/harness/tools/fetch/executions` is answered whenever the host enabled webfetch —
which is what lets a preset card advertise the declaration its harness really makes.
A host that passes `createWebFetchCatalogueEntry({ enabled: false })` still LISTS the
tool, with `availability.state: 'unconfigured'`, the static `WEB_FETCH_METADATA`
shape, and no callable implementation.

**Operator surface.** `/webfetch <url>` is the built-in slash command over the
registered `fetch` tool (the first token is the URL, and the tool's content-type gate
and character cap still apply); with `webfetch` disabled it answers the configuration
guidance instead (see [Slash commands](#slash-commands)).

---

## Web download

`download` (`tools/webdownload/download.tool.ts`) is the byte path. `fetch`
answers bounded text and refuses a binary; `download` accepts **any** content
type, caps the transfer, and hands the real bytes to the model as multimodal
input. It is a plain **preset** — in `presetTools`, exported by name, listed and
callable in the server catalogue — with `registration: { group: 'preset',
activation: 'always', mode: 'sync', order: 235 }` and `visibility: 'core'`, so
every harness registers and declares it without a key, a configuration field, or a
discovery round. `presets: false` is the only way to keep it out.

**Caps (all enforced before allocation, all module-local literals).**
`MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024` decoded bytes, checked twice — against
`content-length` before any byte is paid for, then per streamed chunk for a host
that declares nothing or lies. `DOWNLOAD_TIMEOUT_MS = 60_000` for the whole
transfer (a 20 MiB file on a slow link is normal; `fetch`'s 15 s is not), one
attempt, redirects followed, `context.signal` LINKED to the timeout controller so
`toolCancel`/run abort stops the socket rather than only its delivery. URL must be
absolute `http(s)` without userinfo, ≤2,048 characters. **Nothing is written to
disk** — there is no output path argument; a host that wants a file uses `write`.

The value a caller gets is a `toolMedia()` **envelope**
(`{ __toolMedia: [attachment], content: summary }`), and the two halves are
deliberately different sizes:

- `content` is the small JSON summary (`url`, `finalUrl`, `contentType`, `kind`,
  `name`, `bytes`, `declaredBytes?`, `media: 'attached'`, `mediaId`) — a few
  hundred bytes, so the 64 KiB model-facing result budget never touches it;
- the bytes go on the committed `tool` message's `attachments`
  (`HarnessMessage` tool branch), which is what makes them survive history,
  snapshot restore, and forks;
- a `tool_result` event and the server's manual execute answer carry
  `ToolMediaDescriptor[]` (`id`, `kind`, `name`, `mime`, `size`) — metadata only,
  never base64, because events are JSON round-tripped and persisted per turn;
- the transport expands the attachments into a clearly labelled **USER**-role
  payload AFTER the whole contiguous tool block, so strict provider tool-call
  pairing is never broken. Markers/ids are regenerated when one block aggregates
  several downloads whose `dl-1` ids would collide.

Validation runs at both ends of the seam: `toolMedia()` fails the call, and
`toolMediaOf()` re-validates at the unwrap boundary so a forged envelope cannot
splice 500 MB into history. An invalid envelope is REJECTED, never silently
dropped — "downloaded but the model never saw it" is the failure this rule exists
to prevent. Known families keep their media kind and are checked against the
shared magic signatures (a server claiming `image/png` and sending HTML fails
loudly); anything else is `kind: 'file'` with its exact bytes and a sanitized
filename (≤200 chars, no path separators, no drive colon).

**Trust profiles are not interchangeable.** `validateAttachments` takes a profile:
uploads keep `UPLOAD_ATTACHMENT_LIMITS` (4 MiB per file / 8 MiB per turn / 4
files, and `kind: 'file'` is an explicit transport refusal), while tool media uses
`DOWNLOAD_ATTACHMENT_LIMITS` (20 MiB per file, 4 files / 80 MiB per aggregated
block). Grammar, MIME tables, magic signatures and canonical base64 are shared, so
a download is never held to a looser standard than an upload.

**Provider support is the open end, stated plainly.** The transport maps image →
`image_url`, pdf → `file` (data URL), audio → `input_audio` (wav/mp3), video →
`video_url` **only when the request host is `openrouter.ai`** (an OpenRouter
extension, decided on the actual hostname so an OpenAI gateway is never sent an
unsupported part), and a generic `file` → the OpenAI-compatible
`{ type: 'file', file: { filename, file_data } }` part under the tool-media policy
(under the upload policy it stays an explicit "not supported" error). A provider
that cannot represent the part answers with its own explicit error; nothing is
dropped quietly. So "the model can see the file" is a claim about the configured
model, not about this package.

**Cost of the bytes.** One 20 MiB download becomes ~27 MiB of base64 in the
persisted transcript, in the snapshot, and in every later request body built from
it. `forks.maxHistoryBytes` (default 8 MiB of serialized history including
attachment payloads) therefore still applies and can block a fork of a
download-heavy session until it is raised. There is no UI preview of downloaded
files.

**Packaging contract.** The entry is compiled as editable source, so its only
value imports are the `../../core` barrel and `../../util`; the bounds and MIME
tables are literals to keep the captured source revision at `dependencies: []`. The
focused test (`download.test.ts`) asserts those literals equal the authoritative
numbers in `shared/attachments.ts`, so the two cannot drift. The folder barrel is
type-only for the same reason a value re-export anywhere else would eagerly
evaluate the entry.

---

## toolCreate

The model can write a small tool for itself mid-conversation; the host can do the
same with `writer.toolCreate(configuration)`. One registration path serves both
(`createToolFrom` in `src/harness.ts`, `createDynamicTool` in `src/core/creation.ts`).

```ts
const tool = writer.toolCreate({
    name: 'upper',
    description: 'Uppercase a string.',
    tags: ['text', 'upper'],
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    source: 'return String(args).toUpperCase();'   // BODY of an async function
});
```

- **Two-phase.** Registration validates the shape and compiles the body
  (`new AsyncFunction('args', 'context', source)`) but **never executes** it. The
  body runs only when the tool is called, receiving `args` (the parameter value,
  single-property rule applied) and `context` (the full `ToolContext`).
- **Validation** (`core/creation.ts`): name must be a letter first, then
  letters/digits/`_`/`-`, ≤64 chars; reserved names are rejected case-insensitively;
  description non-blank and ≤2 000 chars; 1–16 tags, each ≤64 chars; `parameters`
  must be a JSON-serialisable object; source non-blank and ≤20 000 chars; a body
  that does not parse is a `HarnessError`.
- **Registry rules** (`src/harness.ts`): a case-insensitive collision with any
  registered tool is rejected ("fileread" cannot shadow "read"), and a harness
  may create at most **32** tools (`MAX_CREATED_TOOLS`). The model path returns the
  failure as a tool result; the host path throws.
- **Schema gate is a traversal limit, not schema validation**
  (`checkToolSchemaComplexity`): a created schema is re-sent on every request, so it
  is bounded to 12 levels of container nesting, 256 nested objects/arrays anywhere in
  the value, and 16 KiB of serialized bytes. The walk follows EVERY container —
  `properties`/`items`/`oneOf`, but equally `$defs`, `patternProperties`,
  `dependentSchemas`, or an unknown keyword — because a keyword-only walk let 400
  objects under `$defs` through; the byte cap is what catches one enormous scalar
  `description`/`enum` string. Cycles are rejected explicitly (a host can pass a live
  object; `JSON.stringify` would otherwise throw). `validateSchemaValue` still
  enforces only the vocabulary it documents, so these keywords are counted, not
  resolved.
- **Registered searchable and enabled immediately**, so the next turn can call it
  without a second toolRequest round. It stays in the searchable catalogue afterwards.
- **Session-local.** Created tools live in that harness's registry only; two
  harnesses cannot see each other's tools. A server with a database root persists
  their SOURCES in the session's core snapshot and recompiles them on restore
  (`reset()` keeps the registry and clears only the enabled set); without a root a
  restart starts clean.
- **No sandbox.** The body is compiled with the host realm's `Function`
  constructor and runs with the process's full permissions — the same trust model
  as `shell`. Nothing here isolates filesystem, network, or processes.

---

## Delegation

```ts
const team = harness({
    agents: { lead: agent({...}), tester: agent({...}), reviewer: agent({...}) },
    entry: 'lead',                                  // routing ONLY — not an authority claim
    ranks: { lead: 'A', tester: 'B', reviewer: 'B' },
    report: { progress }
});
```

- **`entry` names the agent the callable runs** (`HarnessConfiguration.entry`,
  `src/types/index.ts:4710-4718`). Optional; defaults to the first `agents` key; an unknown name
  throws at construction with
  `Entry agent "zzz" is not registered. Configured agents: a.`
  (`src/harness.ts`, `entryName`). It is called ENTRY rather than PRIMARY because it is a
  ROUTING choice: `harness.name` is that name and `handle.agent` is that brain — both are GETTERS
  over the CURRENT EFFECTIVE entry (`:17191` / `:17201`, resolved by `effectiveEntryName` `:16855`
  and `effectiveEntryAgent` `:16863`), so neither can report a detached agent — the default
  conversation is `agent:<entry>`, a host-initiated call carries the entry agent's standing, and
  the entry agent is the member a SESSION may never detach (`src/server/sessions.ts:7419-7424`
  answers `409`, pinned by `src/server/api-session-agents.test.ts`).
  **THE ONE REMOVAL ASYMMETRY, LEFT IN PLACE ON PURPOSE:** the LIBRARY handle allows what that
  route refuses — `harness.removeAgent(entryName)` is legal (`src/harness.ts:16706-16710`, "THE
  ENTRY AGENT IS REMOVABLE") and the two handle readers then fall back to the first
  CURRENTLY-registered member — because only the server guards a DURABLE roster, where
  `definition.entry` is a persisted routing fact no binding write may orphan.
  **An entry claim is not an authority claim** — the entry agent may hold Rank A or Rank C, and
  nothing about being the entry grants a capability. A legacy `primary` (or `subagents`) key in a
  LIVE config is REFUSED at construction, exactly as a stored document naming it is
  (see [Persistence restore policy (T3)](#persistence-restore-policy-t3)) — this build does not
  translate the retired vocabulary, because silently dropping `primary` moved ROUTING to
  `agents[0]` AND, with `ranks` absent, put Rank A on that same first agent, so a stale document
  resumed as a different team with a different authority one layer below the layer that already
  answers loudly (`src/harness.ts:1467-1477`; the same break on the roster-mutation door refuses
  `addAgent(…, { role })` and adds no member, and `src/harness.delegation.test.ts`
  `refuses a live config still written in the retired roster vocabulary` /
  `refuses addAgent options that still carry the retired \`role\` key` pin both):

  ```text
  HarnessConfiguration was written before the rank model and carries `primary`. This build routes with `entry` (the entry agent, one of `agents`) and ranks with `ranks` (agent name -> one rank letter, "A" highest to "Z" lowest), and it does not translate the old keys: name `entry` and `ranks` instead.
  ```
- **`ranks` is the authority map**, agent name → `AgentRank` (`'A'`…`'Z'`; the union is
  `src/types/index.ts:1469`, the ordering data `AGENT_RANKS` `:1501`, the one comparison
  `rankIndexOf` `:1532`, THE delegation predicate `isLowerRank` `:1539` and the untrusted-input
  guard `isAgentRank` `:1547`; all four VALUES are re-exported from the entry point at
  `src/harness.ts:17578`). A LARGER letter is a LOWER authority, and **any number of agents may
  share one rank** — two Rank A agents are ordinary, and neither is the other's subordinate.
  Resolution (`src/harness.ts` `defaultRank`/`rankByName`, every line below measured with
  `yarn vite-node`):
  1. `ranks` ABSENT entirely → the entry agent is Rank A and every other agent is Rank B, which
     is exactly the default the removed `primary` + implicit `subagents` pair produced, so an
     existing single-team harness needs no configuration change (`{a,b,c}` → `{a:'A',b:'B',c:'B'}`);
  2. `ranks` PRESENT → an explicit letter wins and every agent the map OMITS — the entry agent
     included — takes ONE RANK BELOW the lowest rank explicitly stated anywhere in it, clamped at
     `'Z'` (`{a:'C'}` over `{a,b,c,d}` → `{a:'C',b:'D',c:'D',d:'D'}`);
  3. `ranks: {}` therefore states "no ranking", not "use the A/B default": `{a,b}` →
     `{a:'B',b:'B'}` — one distinct rank, no Rank A agent, no delegation.
  Both misconfigurations throw and name the exact site (observed):
  `HarnessConfiguration.ranks names agent "zzz", which is not registered. Configured agents: a.`
  and `HarnessConfiguration.ranks.a must be one of: A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z. Received a.`
  (`resolveRankValue`, `src/harness.ts:1271`); a `ranks` that is not a map throws
  `HarnessConfiguration.ranks must be a map of agent name to rank letter.`
- **`harness.ranks` is the RESOLVED map** (`Harness.ranks`, `src/types/index.ts:5017`): a GETTER
  over the live roster, so `addAgent`/`removeAgent` move it, and `ranksView`
  (`src/harness.ts:1720`, mounted at `:17230`) hands out a frozen defensive copy per read — a
  caller can neither mutate the ranking nor cache its way to a promotion. It replaces the removed
  `harness.subagents` allowlist: who may delegate to whom follows from these letters and nothing
  else.
- **There is NO delegation allowlist any more.** The removed `subagents` list named targets by
  hand; targets are now rank-derived through `delegableNamesFor` (`src/harness.ts:1602`) — every
  registered agent STRICTLY below the caller's rank, in registration order, so the declared
  `agent` enum and the refusal's target list are stable between calls. The one roster-level
  opt-out left is `addAgent(name, configuration, { delegate: false })`, which lands the member in
  `nonDelegatable`: still reachable by thread and `ctx.run`, never a delegation target
  (`src/types/index.ts:5530-5548`).
- **`delegate` exists exactly when the roster spans two or more DISTINCT ranks**
  (`rosterHasDelegation`, `src/harness.ts:1614`; the entry's descriptor row is gated on
  `registration.activation: 'delegation'` — `src/tools/runtime/delegate.tool.ts:208-221`,
  honoured at `src/harness.ts:1808` and `:3989`). A one-agent harness, an all-Rank-A roster, and
  a roster whose members are all junior therefore register no `delegate` at all — the same honest
  absence the removed empty-allowlist rule produced, now stated in DATA rather than inferred from
  an empty array. Counting DISTINCT letters (not members) is what makes it exact: seven members
  all at Rank B still cannot delegate (`ranksDeclareDelegation`,
  `src/server/harnesses/toolbox.ts:289-290`). A roster that gains its first rank-below pair
  installs the tool through `syncDelegateDeclaration` (`src/harness.ts:16529`), and once
  installed it stays — dropping a declaration between two model turns would tear the list.
- **Delegation is strictly downward, and the refusal names the caller's rank and its legal
  targets.** One comparison in `delegateFor` (`src/harness.ts:5570`, the rule block
  `:5624-5678`) replaces the two removed throws (the caller-role check and the `runDepth > 1`
  check): the caller may hand work only to a
  REGISTERED agent whose rank is strictly lower. A→A and B→B are refused (a same-rank peer is not
  a subordinate), B→A is refused, and the wording tells a model which names exist instead of
  which unnamed agent is privileged. Verbatim, observed live through
  `harness.executeTool('delegate', …)` on a `{ lead:'A', co:'A', helper:'B' }` roster:

  ```text
  lead holds Rank A and cannot delegate to "co" (Rank A): delegation is strictly downward. The legal targets are Rank B and below: helper.
  ```

  with the second arm when nothing sits below the caller:

  ```text
  No agent in this harness is ranked below Rank A, so a Rank A agent cannot delegate at all.
  ```

  That second arm has TWO CAUSES and the sentence tells them apart (`lowerRankedNames`
  `:5633-5635`): `legalTargets` is rank-derived MINUS the opted-out names, so an empty
  `legalTargets` alone cannot distinguish "the ladder ends at the caller" from "every junior was
  registered with `delegate: false`". When the ladder does continue, the arm reads:

  ```text
  boss holds Rank A and cannot delegate to "peer" (Rank A): delegation is strictly downward. Every agent ranked below Rank A (worker) is registered with `addAgent(…, { delegate: false })`, so this call has no legal target.
  ```

  A target outside the roster keeps the pre-existing sentence
  `Agent "x" is not registered in this harness. Registered agents: …`. The checks run in that
  order — registration, rank, opt-out, then the input check (`:5640-5683`) — so a same-rank or
  senior target keeps the rank sentence even when it opted out too, and every refusal lands
  BEFORE the child runs.
- **A HOST CALL IS AN ACTOR, NOT A RANKED AGENT.** Every door a host uses acts with the SAME
  standing: `harness.executeTool('delegate', …)`, `context.callTool`,
  `runtime.delegate(undefined, …)`, `toolRequest`'s host view (`declaredForDiscovery`,
  `src/harness.ts:2733`) and the `toolCreation` ceiling (`createToolForAgent`, `:4314`). They
  resolve through `hostActor()` (`:1669`), which is the live entry agent while it is REGISTERED —
  so the text stays byte-identical to the entry agent's own — and after `removeAgent` detaches it,
  an unregistered identity named `host` pinned to Rank A (`hostRank`, `:1637`) so the documented
  "a host can still reach every member downward" holds at every door. The host is not itself a
  roster member and holds no rank of its own; its standing is DERIVED, and a host refusal names
  `host` rather than a departed agent
  (`refuses a delegate:false member at the refusal site, which the schema cannot` and
  `names the host, never the detached entry agent, in a host refusal` in
  `src/harness.delegation.test.ts`).
- **`addAgent(…, { delegate: false })` is the host's opt-out from being a TARGET, and it is a
  REFUSAL, not only a declaration.** The set was read ONLY by `delegableNamesFor` (`:1602`, the
  DECLARATION path), so an opted-out member stayed legal at the door: it is lower-ranked, the rank
  check passed, and the call RAN. That asymmetry is structural, not theoretical — the installed
  `delegate` schema deliberately carries the WHOLE roster, so any caller that names the call is
  one argument away from the door the declaration closed. `delegateFor` now refuses it at
  `:5675`, after the rank check and before the child runs, and says whose decision it was:

  ```text
  Agent "worker" is not a delegation target: it was registered with `addAgent(…, { delegate: false })`. Rank B is below Rank A, so the target is legal on rank alone and the host's opt-out is what refuses it; it stays reachable through threads and `ctx.run`.
  ```

  The member stays a roster member with a conversation — threading is never rank-gated — and
  `toolRequest` re-checks the same set, so the card and the door cannot disagree.
- **The `delegate` CARD is projected per caller; the schema enum is not.**
  `delegateDeclarationFor` (`src/harness.ts:2716`) rewrites the DESCRIPTION to the caller's legal
  set, so a Rank B model is told "Rank C and below" and two agents of different ranks never see
  the same prose, while `widenDelegateEnum` (`:2695`) keeps the `agent` enum every registered name
  — deliberately permissive, because a narrow enum answers a wrong guess with
  `$.agent must be one of: "editor"`, which cannot name a RANK; a permissive enum lets the guess
  reach `delegateFor` and get the rank sentence. `toolRequest`'s `alreadyAvailable` card is
  re-projected the same way (`declaredForDiscovery`, `:2733`), and the row is withheld from a
  caller with no lower-ranked target at all (`visibleCoreTools`, `:2656`, withholding at `:2680-2683`) — an empty enum is
  a control the model could only guess against. The two description forms a model actually reads
  are the zero-target catalogue literal
  (`src/core/tool-manifest.ts:1541`, regenerated from `src/tools/runtime/delegate.tool.ts:136-202`)
  and the allowlist template (`src/tools/runtime/delegate.tool.ts:233-272`, hand-duplicated in
  `src/core/metadata.ts:250` and pinned equal by `src/core/metadata.ownership.test.ts`). The
  catalogue form opens:

  > Delegate a self-contained task to a lower-ranked agent and return its answer. Delegation
  > follows the harness RANK model: you may delegate only to an agent ranked strictly below you
  > (a Rank A agent may delegate to Rank B and below), a same-rank or a higher-rank target is
  > refused with an error naming your rank and the legal targets, and a harness registers this
  > tool only while at least one of its agents has a lower-ranked peer - a session whose harness
  > has none answers 404.

  and the allowlist form adds the set and the ceiling in words: `Agents you may delegate to:
  ${listed}. You may delegate only to a strictly lower-ranked agent (a Rank A agent reaches Rank B
  and below); your own rank and every rank above it are refused, by an error that names your rank
  and the legal targets.` plus `Delegation never widens upward: the targets above are the whole
  set for your rank, and a rank change is a harness reconfiguration, not a call.`
- **Nesting is bounded by the number of DISTINCT ranks — the old "one level deep" is gone.**
  The per-harness ceiling is `runDepthCeiling = min(distinctRankCount, 26)`
  (`src/harness.ts:1591`), recomputed by `recomputeRankBounds` (`:1593`) on every roster change; the hard
  ceiling is `MAX_RUN_DEPTH_CEILING = AGENT_RANKS.length` = 26 (`:1295`), one per letter. A chain
  of runs visits strictly DESCENDING ranks, so it can never be longer than the set of ranks that
  exist: with `A`,`B`,`C` configured, A→B→C is legal at depth 3, while a fourth level would have
  to put two agents on one rank — which the strictly-downward check already refuses. A roster of
  `{A, A, B}` nests two deep and no further, because its two Rank A agents are peers rather than a
  ladder, and a single-rank roster gets ceiling 1 (no nesting at all — the honest shape of
  "nobody is below anybody"). The old `MAX_RUN_DEPTH = 2` was that rule hard-coded for the one
  roster shape the removed vocabulary could express. The ceiling is enforced centrally in
  `runAgent` (`:14700-14707`), so the model's `delegate`, `ctx.run`, and a created tool that
  received the whole `context` all obey the same number, and the refusal is:

  ```text
  Agent "…" cannot run: this harness configures 2 distinct ranks, so runs nest at most 2 levels deep, and "…" is already running at that depth.
  ```

  The AGENT-CYCLE guard is separate and comes FIRST (`:14680-14684`), so a re-entry keeps its own,
  more precise message: `Agent "x" is already running; it cannot be re-entered (delegation cycle).`
  What it guards is RE-ENTRY, the one shape the rank comparison cannot see: threading is never
  rank-gated, so `ctx.run` (and a created tool holding the whole `context`) can call back into an
  agent that is already on the stack, and that is refused here. A trip back up the ladder through
  `delegate` never reaches this guard — B→A is an UPWARD target, so `delegateFor` refuses A→B→A on
  rank alone (`:5648`), which is also why a `delegate` chain can never outlive the rank span.
- **Tools are NEVER rank-gated: every agent has access to every registered tool.** The removed
  mechanism was `registration.primaryOnly`, a role gate that filtered the DECLARATION and refused
  the LAUNCH; it is gone from `ToolRegistration` (`src/core/tool-metadata.ts:95-124`), from the
  discovered row (`:128-151`) and from the dispatch path ("THERE IS NO ROLE GATE HERE ANY MORE",
  `src/harness.ts`, beside `executeToolCall`). What SURVIVES, and is the whole list:
  1. the per-RUN `scope.tools` allowlist a delegation carries (the bullet below — with
     `toolRequest` never restricted by the scope, so a scoped child can always report what it is
     missing);
  2. the conversation's WITHHELD set, `harness.withheldTools` (a switch the user of this
     conversation owns; it gates the agents of that conversation, never `executeTool` or
     `context.callTool`);
  3. the DEPLOYMENT-wide disable, `toolSettings` (one provider over the names an operator turns
     off for every session);
  4. the discovery door and its cap — `maxEnabledTools` (default 32) bounds how many SEARCHABLE
     rows are enabled at once, and undiscovered rows are not declared;
  5. the ONE optional rank ceiling: `toolCreation`.
- **`toolCreation` is `'all' | false | <rank letter>`** (`ToolCreationPolicy`,
  `src/types/index.ts:1556`; `HarnessConfiguration.toolCreation` `:4766-4786`). A LETTER means
  that rank and every rank TOWARD A may create (`holdsCreationRank`, `src/harness.ts:1264`), so
  `'A'` is the faithful replacement for the removed `'primary'` policy and `'C'` admits A, B and
  C. The gate withholds the DECLARATION (`creationGatedDefinitions`, `:1903`) AND refuses a
  guessed call, with
  `Tool creation is limited to Rank A and above in this harness; "helper" holds Rank B.`
  (`createToolForAgent`, `:4314`, rank check `:4329`). A bad policy value fails construction (observed):
  `toolCreation must be "all", false, or a rank letter (A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z). Received primary.`
  (`resolveToolCreation`, `:1246-1257`). `false` registers no model-facing `toolCreate` at all,
  which is an honest 404 rather than a tool that always fails. **`harness.toolCreate()` is the
  HOST path and is never rank-gated** — `:16975` binds it to `createToolFrom` — because an
  operator action is not a model privilege; the lifetime `maxCreatedTools` budget applies either
  way. THE LINE IS DRAWN BETWEEN TWO HOST DOORS, not between host and model: the other one,
  `executeTool('toolCreate', …)`, runs as `hostActor()` and IS ceiling-gated (`:4326-4333`) —
  measured on a `toolCreation: 'A'` roster whose entry holds Rank B:
  `Tool creation is limited to Rank A and above in this harness; "lead" holds Rank B.` — while
  `harness.toolCreate(…)` on the same harness creates.
- **Threading is NOT delegation, and no thread door consults rank.** Thread creation, visibility,
  messaging and lineage are rank-free, because threading is one agent working in PARALLEL, not a
  hand-off to a subordinate: a Rank B agent forks, spawns threads, sends, reads and calls every
  tool a Rank A agent calls. Rank is only ever PROPAGATED downward so a derived actor keeps its
  authority — `actorRanks.set` writes the source's rank onto a thread agent (`src/harness.ts:7371`,
  and `:15659` for the lane worker's restored thread), a branch (`:11651`) and an autoanswer
  branch (`:11968`); `rankOf` (`:1629`) reads that per-object override first, then the roster map
  by NAME, then the roster default. A thread of a Rank B agent is therefore still refused a Rank A
  delegation target — same authority, same limits, more parallelism.
- **Each agent keeps its own `instruction`(s) and transcript.** A child never
  sees its caller's conversation; `run(target, input)` returns only the final
  `content`, and that envelope is what the tool result carries back.
- `ctx.run(name, input)` inside a tool still runs a full sibling turn; it is the
  tool-side path (used by the `textSummarize` harness tool) and is not model-visible
  delegation. It is NOT rank-gated: `ctx.run` is a tool calling the harness, and the
  bounds it obeys are the cycle guard and the same `runDepthCeiling` above.
- **A delegation is a pending tool.** The parent's `delegate` call stays in
  flight until the child fully completes, so it can appear in the parent's
  `done.pending` list and the resume arrives as a `wakeup`. WHICH conversation the
  child answers from depends on the caller's own address (`runAgent`'s
  `resolvedThread`): from a HOST-thread parent (a server session conversation, or
  any `createThread` record) every delegation MINTS A NEW child conversation —
  siblings never share a transcript, and the follow-up door is `threadSend` into the
  `threadId` the envelope returned, not a second `delegate` (issue 0028: fresh-thread
  per delegation is the documented design, so a re-`delegate` remembers nothing);
  from the ENTRY agent's own DEFAULT conversation the child runs in the target's standing
  `agent:<name>` conversation, and a second delegation to that agent continues that
  transcript.
- **No time limit by default (policy 2026-11-09).** The child runs to its own final
  answer; `timeoutMs` is an optional bound the caller sets when it wants one, and an
  omitted or non-finite value arms no timer at all. While the call is in flight the
  parent's next request carries a `{ status: "pending", callId, … }` placeholder that
  NAMES `toolCancel` as the way to abandon the child — and abandoning does not discard
  the outcome: the child's terminal envelope is still delivered, as that call's own tool
  message, with `callCancelled: true` marking the release while the `toolCancel` result
  stays an acknowledgement (see the D2 bullet below; the `delegate` description now says
  the same to the model) — and `toolRequest` reports
  `toolCancel` under `alreadyAvailable` in exactly that window (it is a
  `pendingOnly` core control, declared only while work is in flight, so the report —
  not the catalogue — is where it is discoverable). A conversation that SWITCHES
  `toolCancel` off loses the declaration and that report together — the withheld set applies
  to a pending-only control like any other name — which is the hazard worth naming: the model
  is left with no way to withdraw an in-flight call while the server-side machinery it cannot
  reach keeps running.
- **An unfinished child leaves an ADDRESSABLE trail (IT19 R1/R3/R5, 2026-11-15).** A cut run
  keeps every turn it COMMITTED: its tool calls and tool results stay in that child's
  transcript, which `threadRead` answers, and only a call left without an answer is recorded
  as interrupted (`src/core/transcript-repair.ts:79`) — the pairing a strict provider demands
  is what makes retention safe. Retention is keyed on the run OWNING a thread
  (`run.threadState !== undefined`): a forked BRANCH run has none and still splices to its
  fork baseline, which is why the `threadFork` branch wording is unchanged. The child's record
  carries `stopReason` — WHY it halted, never how far it got — and an agent may continue a
  child whose run was cut short with `threadSend` (receipt `"resumed"`), while a host stop
  (`user-stopped`), a plugin park (`plugin-parked`) or an absent reason stay host-only; an
  INACTIVE (deleted) child is refused before any status branch, because typing into a
  conversation off the roster is not a door an agent owns.
  A pending PLACEHOLDER is not the end of the account either: `deliverOwedAccounts`
  (`src/harness.ts:10686-10771`, upgrade arm `:10704-10726`) pays every debt at the TOP of the parent's next turn, before
  the mailbox drain, and rides the call's own slot. When that slot holds the R1 interrupted
  placeholder — a retained run cut off mid-`delegate` whose child kept working and finished
  later — the placeholder is UPGRADED IN PLACE with the real account: same call id, same
  position, same `messageId`, no `outcome` key, so the model is never told two contradictory
  facts about one call. If the account cannot be described (the child's ledger row is gone),
  the placeholder stays: an honest "no outcome was recorded" beats an empty rewrite. A late
  child never WAKES a concluded parent — the account defers to that parent's next turn, and
  `agentResult` remains the durable half.
- **`maxTurns` is a second OPTIONAL, caller-set bound (I5, 2026-11-13; unit corrected
  2026-11-14, stress report #7).** It counts the child's MODEL REQUESTS — the
  `run.iteration` the loop increments once per `requestTurn` — beside `timeoutMs`'s
  wall clock: an integer 1–64 (the
  ceiling equals `DELEGATE_MAX_TURNS_MAX` in `core/agent-limits.ts`, restated as a
  literal in the entry and pinned equal by `core/metadata.ownership.test.ts`),
  enforced as `min(harness-wide maxIterations, maxTurns)` in `runAgentCore` — an
  omitted value is `Infinity`, so the argument can only LOWER what one child may do,
  never raise the session limit. Because the ANSWER must itself be one of the requests,
  `maxTurns: N` leaves room for at most **N−1 tool rounds**: `maxTurns: 1` is a child
  that answers with no tool call at all, and a child that spends its last permitted
  request on tools hits the bound rather than answering. (The earlier wording, "a count
  of model turns (tool rounds)", read as if N rounds were available and is what report
  #7 corrected.) A child that runs out of turns has not answered, and
  its result is the unfinished-run envelope (status plus `partialContent`), never a
  final answer it never gave; the refusal names the bound that fired and says the cap
  was the caller's own (``Agent "…" requested tools on all N model turns without
  answering, the maxTurns this run was given`` — and `on its single model turn` when
  N is 1). No scheduling priority was added:
  per-actor FIFO is unchanged.
- **The envelope's `threadId` is the follow-up HANDLE (C1, 2026-11-13).** A
  delegation from a host-thread parent mints its own conversation (the documented
  sibling-isolation design, issue 0027) and the envelope names it: `threadSend` posts
  a follow-up message into it, `threadRead` reads its transcript, and `threadDelete`
  releases it once its answer has been read — the release is also how a session frees
  a slot under the 256-thread cap. The `agent:<name>` spelling addresses the target agent's
  standing DEFAULT conversation, which is NOT the live delegation thread (`threadSend` adds a
  receipt `note` naming the live thread when that distinction matters — and only when
  that thread is addressable from the caller's family, 2026-11-14).
- **Identity is CARRIED AND VERIFIED, never discovered (D1, 2026-11-14 — closes the
  fabrication half of issue 0029).** `delegate` hands the child an OUT-carrier,
  `HarnessRunIdentity` (`src/types/index.ts`), through `context.run(..., { identity })`;
  the RUN ITSELF writes `invocationId`/`threadId` into it immediately after
  `registerInvocation` and `status` at its two terminal commits (`runAgent`'s identity
  block, `commitTerminalIdentity` beside `commitRunTerminal`). The parent then ADDRESSES
  the ledger entry with that id (`invocationRecords.get(carried.invocationId)`) and the
  two checks left in `delegateFor` only CONFIRM the entry is still the one that run wrote
  (same id, expected agent). On that path nothing searches by parent call id, and nothing
  matches by recency: a tool-call id is unique only within one run, and a concurrent host
  thread of the same agent writes into the same shared ledger, so both retired heuristics
  could hand a caller ANOTHER run's identity and status. CORRECTED IN PLACE (2026-11-14,
  independent review — C5): the two sentences above read as if the carrier path were the
  whole rule. `newInvocationOf` (`src/harness.ts:5779-5808`) is a THREE-step chain and only
  TWO steps are exact — (1) the carrier address plus its verification (`:5780-5791`),
  (2) the `(parentCallId, parentScope)` pair, compared with `===` on both fields
  (`:5795-5805`), and (3) a set-difference that is still DISCOVERY: "the first record for
  that agent that was not already known at dispatch" (`:5807`, against the snapshot taken at
  `:5760-5762`). Steps 2 and 3 run only when the child wrote no carrier, and step 3 can
  therefore still adopt a concurrent run of the same agent and report it as this call's
  child — the residual the in-code comment already admits ("both are fallible; a carrier
  always wins", `:5774-5778`). NO TEST exercises step 3: every child a harness run starts
  writes the carrier, and the two fixtures that call `runtime.delegate` directly forward
  `context.run!` unchanged (`src/harness.delegation.test.ts:2660`, `:3250`). The
  pair-addressed fallback
  (`parentScope` + `parentCallId`, `delegatedRecordOf`) survives only for a run that never
  reached `registerInvocation` and so wrote no carrier — a child refused before it owned
  its actor, or a host calling `runtime.delegate` with its own `run` closure. A record
  that cannot be confirmed is OMITTED: `invocationId`/`threadId`/`status` stay absent
  rather than `''`/`'completed'` being invented, and the content and paging fields stay
  exact either way.
- **A released or abandoned `delegate` call answers with the CHILD'S TERMINAL ENVELOPE,
  not an acknowledgement (D2, 2026-11-14 — partially closes issue 0021).** A live
  delegation publishes a `DelegateCallTrace` (its scope + call id as key, the identity
  carrier, the target agent, the page size and the start time) into `delegateCallTraces`
  for exactly as long as the call runs. When `toolCancel` releases the call, the
  scheduler's `onSettled` reads that trace SYNCHRONOUSLY in the cancel's own stack (the
  tool body clears it a moment later) and hands it to `deliverTask`, which awaits the
  child's own already-in-flight settle promise — no second timer — and inserts the
  terminal envelope as the call's tool message: `status`, `error`, `partialContent`,
  `cancelledAtMessage`, the identity fields, the paged answer, and `callCancelled: true`
  (`releasedDelegateResultOf`). `error` is the harness's own sentence
  (`Delegation to "…" was cancelled by the caller before the call returned.`), never the
  raw `"This operation was aborted"` the record still holds for `agentResult`.
  `callCancelled` separates "the caller let go of the call" from "the child did not
  finish" — a child that answered a moment after the release reports
  `status: 'completed'` beside the marker, because a release races the child and its
  final answer wins the `content` page. Two things did NOT change: the `toolCancel` ACK
  is still the control receipt `{ cancelled: true, callId, name }` (and
  `{ cancelled: true, …, alreadySettled: true }` for an id that already settled in this
  conversation) — it is a control result, not the result channel — and when the child
  left no record to report (refused before it started, or purged mid-run) the delivery
  falls back to the historical "no result is available" sentence byte for byte, which is
  what keeps "no invented identity" true on this door too.
- **`scope.tools` cannot block the discovery door.** The allowlist hides and refuses
  every capability it omits, `toolRequest` excepted: a restricted child must always
  be able to ask for what it is missing. Before this, a child scoped to
  `["read","glob"]` and told to write looped on `glob` for 45 messages instead of
  failing cleanly, and `scope: { tools: [] }` produced no output at all
  (docs/tasks/2026-11-08-delegate-stress-test.md, finding 2 — that task file has since been
  removed from `docs/tasks/`, so this is a historical reference). Enabling a tool through
  discovery is still not the same as being allowed to call it — the launch gate keeps
  the allowlist for everything else.

### Shipped cards and their rank maps (T3)

`src/server/harnesses/presets.ts` states every card's ROSTER and RANK MAP explicitly, side by
side, in the order the runtime reads them (`agents` order is `[entry, ...the rest]`, `ranks`
states what each may do). `teamOf(primary)` is DELETED — it derived an allowlist from the single
"primary" concept that no longer exists and hid the two decisions the rank model makes visible:
who runs at all, and who may hand work to whom. The two letters are named once
(`ENTRY_RANK = 'A'` `:168`, `TEAM_RANK = 'B'` `:169`) so a rank map reads as a decision rather
than a letter, and every card names its routing agent explicitly (`entry:` is stated even when it
is also `agents[0]`). Consequences:

- the eight shipped cards are `general`, `instruct`, `research` (title "Explore"), `workspace`
  (title "Analyst"), `reviewer`, `planner` (title "Manager"), `debugger` and `chat`; the six
  TEAMED ones (`instruct`, `research`, `workspace`, `reviewer`, `planner`, `debugger`) each hold
  their own entry agent at Rank A with every other member at Rank B, so each registers `delegate`
  and every target the description names exists by id (the Manager's `research`/`workspace`/
  `reviewer` targets included);
- `general` (`:186`) and the tool-less `chat` card (`:441`) state ONE rank
  (`ranks: { general: 'A' }`), so `ranksDeclareDelegation` (`../toolbox.ts:289-290`) is false and
  `delegate` is never even registered — the absence is stated in DATA now, not inferred from an
  empty allowlist, and `chat` is the one declared toolbox exception as well
  (`tools: []` with `sharedToolbox: false`), so it registers no toolbox tool either;
- every shipped card spans exactly TWO distinct ranks, so the "one level deep" a reader observes
  is a property of the shipped RANK MAP rather than a rule the runtime enforces by role: a Rank B
  team member has no strictly-lower target, while a host that configures `A/B/C` gets a chain two
  levels deep with no other change. Threading is unaffected either way — a Rank B member of a
  shipped team forks, spawns threads and calls every tool its Rank A entry agent calls;
- two names are still left out of every shipped team but their own: the card's own entry agent (a
  member is listed once, and its rank is what says whether it can delegate) and
  `planner`/Manager, because a Manager refuses to run as a delegate (`src/agents/planner.ts`
  states the refusal) and offering a member that answers "I do not run as a delegate" is a wasted
  run. A USER-created team may still select the Manager; the refusal is what makes that honest.
  `summarizer` stays in every team so the `textSummarize` delegated path keeps working (it
  condenses locally when absent);
- each profile's delegation guideline stays conditional on the two facts the runtime actually
  checks: the profile has a strictly-lower-ranked peer AND this harness declares `delegate` to it.
  A lone or all-equal agent is told to do the work itself, which is the same sentence the old
  vocabulary used for a subagent, now stated in the model's own terms;
- `AGENT_PROFILE_NAMES` is still the seven real roles plus `summarizer`
  (`src/agents/index.ts:80-89`) — the rank pass changed no profile and renamed no agent id;
- There are no fixtures in the catalogue. The `demo` (scripted) and `flaky`
  (failure-example) presets, their agent profiles, the `testFlaky` tool and the scanned
  `src/server/tools/examples` folder are DELETED; the server lists exactly the seven
  real roles. A suite that needs the offline loop or the failing tool builds its own
  preset in `src/server/harnesses/fixture-presets.test-support.ts` and injects it.
  The CLI and UI both select `general` first (`DEFAULT_CLI_PRESET`), and `--preset demo`
  is an unknown name that prints the real list.

### Persistence restore policy (T3)

What is replayed is the `registry` array and the optional `deleted` list of the document
header `<root>/harness/index.json` (`harnessIndexDocumentOf`,
`src/server/persistence.ts:2289-2306`, consumed at `src/server/runtime.ts:178-195`); sessions
are independent shards, so one session's record is read from
`sessions/<sessionId>/session.json` and a registry row cannot change it.
`restoreHarnessRegistry()` replays saved rows, but a saved BUILT-IN row whose
executable fields still match `LEGACY_PRESET_DEFINITIONS` (the previous shipped
defaults) is refreshed to the current template instead of pinning the old one. It is
the provable case: any executable difference (`entry`, the `ranks` map, `agents`, tools,
environment tools, template, a non-empty `agentModels`/`agentInstructions`/`agentColors`/
`customAgents` map) means the operator customised the row, and a customised row is
replayed verbatim. `isLegacyShippedDefinition` (`src/server/harnesses/registry.ts:1163-1200`)
compares the rank map CANONICALISED (`sortedRanks`, `:912-914`) because rank is executable
authority: a row whose planner sits at Rank B instead of Rank A is a real customisation and
must not be refreshed away. The legacy table itself is written in the CURRENT `entry`/`ranks`
vocabulary, so it can prove "the operator never customised this row" only for a row that
already speaks rank. An edited title/description survives a refresh.
Frozen sessions never depend on this: `SessionStore.restoreSession` rebuilds from
the session's own `preset` record, so an old conversation keeps the team it started
with.

- **THE RANK PASS IS A CLEAN BREAK, and every durable reader says so instead of
  guessing.** A silent rename would let a stored row resume as a harness whose DELEGATION
  differs from the one that produced the transcript saved beside it — the session would read
  back a plausible team that no longer answers the same way. So the old words are refused, at
  four doors, each naming the shape that replaced them:
  1. **A stored registry row or frozen session descriptor** carrying `primary` or `subagents`
     fails the load (and it fails on EITHER key, because a half-migrated `entry` + leftover
     `subagents` document is the same ambiguity in a different costume):
     `requireNoLegacyRosterKeys` (`src/server/persistence.ts:697-706`, called first at `:837`
     for a saved preset and at `:746` for a frozen session descriptor) answers

     ```text
     <label> was written before the rank model and carries `primary` and `subagents`. This build stores `entry` (the routing agent, one of `agents`) and `ranks` (agent id -> a single rank letter, "A" highest to "Z" lowest) instead, and it does not translate the old keys: re-save this harness definition in the new shape, or start from a fresh database root.
     ```

  2. **A stored `ranks` map** must hold rank LETTERS: `readRankMap` (`:717-731`) refuses any
     other value with `<label>.<agent> must be a single rank letter from "A" (highest) to "Z"
     (lowest).`, checked with the shared `isAgentRank` guard so this store, the registry and the
     kernel cannot disagree about what a rank is. The KEYS are plain agent ids and are NOT
     re-validated against the profile catalogue — a saved row selecting a retired profile must
     still LOAD (its own sessions keep working), and the refusal belongs to whoever selects it
     NEW.
  3. **A snapshot document is version 3 and refuses the old vocabulary**
     (`HARNESS_SNAPSHOT_VERSION = 3`, `src/core/snapshot.ts:107`). The gate is
     `Snapshot version 2 is not supported; this harness reads version 3.` (`:1205-1207`), and two
     dedicated refusals name the rename itself rather than a generic shape error:
     `<entry> carries the removed `role` field (snapshot v2 vocabulary); v3 stores `rank` as a rank letter (A, B, …, Z).`
     (`:302-305`) and
     `<entry>.rank must be one of: A, B, …, Z (the removed primary/subagent vocabulary is not accepted).`
     (`:313-316`, one refusal for an ABSENT rank and for a rank spelled with the removed words).
     Translating `role: 'primary'` into `rank: 'A'` is a GUESS about how that deployment ranked
     its agents — v3 lets any number of agents share Rank A, so two v2 `primary` rows are neither
     two Rank A rows nor one — and the repo's standing posture on a vocabulary break is "refuse,
     don't half-migrate" (`src/types/index.ts:4255-4268`). The transcript's own `role`
     (system/user/assistant/tool) is NOT the removed actor role, so v3 renames nothing there
     (`src/core/snapshot.ts:631-636`); `results[].rank` is the only rank-carrying field.
  4. **The lane archive digest hashes the RANK string** (`archiveDigestOf`,
     `src/server/workers/lane-commit.ts:155-190`), which is the single place the authority axis
     enters that digest. A pre-rank archive row carries `role` and digests to the OLD value, so a
     lane replaying an older document sees its `lane.archived` digest disagree and RE-ARCHIVES the
     row once, and a writer from an older build against this authority gets a digest MISMATCH that
     sends it to re-read canonical — the existing recovery path. Both are by design: re-archiving a
     terminal row is idempotent, while keeping a `role` alias in the digest would pin the retired
     axis into the durable identity of every row.
- **And one asymmetry a reader must not smooth over:** the clean break is about DURABLE
  documents. A live `harness({ … })` config is not validated key-by-key, so a leftover `primary`
  there is silently IGNORED and the first `agents` key stays the entry (measured, not assumed) —
  while the same word inside `index.json`, a session record or a snapshot is REFUSED.

### The model-facing thread tools (2026-11-13)

The thread group — `threadList`, `threadRead`, `threadSend`, `threadDelete` — is
registered together on the FIRST independent thread (`activation: 'threads'`) and
then declared for every agent in the session. Declaration order stays roster-first:
the group registers in DESCENDING `order` (threadList 270, threadRead 265,
threadSend 260, threadDelete 255), so the declarations arrive roster, reader,
writer, reaper — an id is always discoverable before a tool that addresses it.
With `threadDelete` added the generated `core/tool-manifest.ts` carried 32 descriptors
(22 runtime entries); as of `sleep` (2026-11-19) it carries **34** — 24 of them
`group: "runtime"`, counted from the generated rows in `src/core/tool-manifest.ts`.

- **THREAD FAMILY is the address space (B3/B4, fifth member added 2026-11-14).** A
  model-facing thread tool is scoped to the caller's thread family: the thread itself, its
  ancestors and descendants (the `ownerThreadId` lineage, however deep), the DEFAULT
  `agent:<name>` conversations of the agents the family spans, and a default whose
  first-wins owner link falls in the family. A SIBLING is deliberately not in the
  set — it shares an ancestor but was not created by this caller. Threadless
  callers (the host handle, a plugin `api.threads.*` outside any conversation, a
  manual `executeTool`) stay UNSCOPED and see everything: the host is the one party
  that may address any conversation, and the server's thread surfaces depend on
  that (`threadFamilyOf`/`familyOfCaller`, `src/harness.ts`).
  - **THE FIFTH MEMBER IS TRANSIENT: THE RUN'S REPLY TARGET.** A `threadSend` that STARTS
    a dormant DEFAULT conversation fires the child run with no parent (a parent would put
    the sender's brain in the lineage and turn two threads of one agent into a delegation
    cycle), so nothing ever writes `ownerThreadId` for it and steps 1-4 compute a SINGLETON
    family — the started turn could see nothing but itself and its reply to the party that
    woke it was refused "outside your lineage" (issue 0030). The sender's id therefore
    travels on the RUN (`RunState.replyThreadId`, set from `RunInternals.replyThreadId` by
    `postThreadMessage`'s dormant-start branch) and `threadFamilyOf` step 5 folds it in as
    ONE extra member, read off `state.run`. It is transient by construction: the route is
    gone when the run releases its thread state, and the PERSISTENT first-wins
    `ownerThreadId` write was deliberately NOT reused — welding one caller's family onto
    another agent's standing transcript outlives the conversation that earned it
    (`RunState.replyThreadId`, `threadFamilyOf`, `postThreadMessage`, `src/harness.ts`).
  - **THE FAMILY SHRINKS WHEN YOU REAP.** Membership in step 4 is computed from the agents
    the family SPANS, so deleting your last conversation running agent `X` drops
    `agent:<X>` out of your addressable set with no visible cause — the default itself is
    still alive, it is simply no longer yours. One `delegate` to `X` re-admits the address
    (the conversation it mints spans `X` again). Both read doors state the cause and the
    remedy instead of leaving the caller to guess: `threadNotVisibleError` and the
    `threadSend` gate append `defaultFamilyClauseOf`'s sentence for a DEFAULT target only,
    and every other out-of-family address keeps its refusal byte for byte (stress report #5,
    pinned by `src/harness.thread-runtime.test.ts`).
  - **PERSISTENCE CAVEAT for that last clause.** The first-wins owner link a DEFAULT
    conversation adopts (`src/harness.ts` `runAgent`'s run-start block, written with no
    state-change notification) is NOT persisted: `snapshot()` ships HOST threads only
    (`.filter((state) => state.record.origin === 'host')` in the same file), because a
    default IS the registry agent's transcript with a name-derived id. So after a
    snapshot→restore the link is gone and
    a default's family visibility is RE-DERIVED from the agents the family spans —
    which can NARROW what a restored conversation may read or write into: a default
    that was reachable only through the owner link (an agent the family does not itself
    span) stops being reachable until a run mints the link again.
- **`threadList` returns the family roster**, newest last, with `currentThreadId`
  naming the caller's own thread; a threadless caller gets every thread in the
  session, as before. A RELEASED thread is absent by construction — but released means
  MARKED, not destroyed (IT19 R2, 2026-11-15): `purgeThread` sets `inactive`/`inactiveAt` and
  the record, its transcript and its invocation rows are RETAINED, so the roster and `actOn`
  stop naming it while a host can still read it by id, and every AGENT door refuses it with its
  own sentence rather than the "never created, or it was deleted" wording. That omission is
  UNCHANGED for the tool (2026-11-17): what moved is the HOST side, where a soft-deletion now
  travels as its own field instead of being inferred from a roster that stopped naming an id —
  `SessionResource.inactive_thread_ids` and `SessionSnapshot.inactiveThreads` /
  `SessionView.inactiveThreads` (see [API](#api)). The row also carries
  `stopReason` (R3/R5) — see the `threadSend` bullet for which stopped rows an agent send may
  continue.
  - **The fields, exactly.** `origin` has TWO values (`HarnessThreadOrigin`,
    `src/types/index.ts`): `'agent'` is an agent's DEFAULT standing conversation (the
    `agent:<name>` address), `'host'` is a conversation on top of an agent — a
    `createThread` record or the child conversation a delegation mints (a finished
    fork's `branch-N` reads as `'host'` for the same reason: `threadRecordOfBranch`
    synthesizes the record, and it is not an agent's default). `sequence` is the
    monotonic per-harness creation counter, which is the sort key — deliberately not a
    wall clock, so the order is stable across a restore and under tests
    (`HarnessThreadRecord`, `src/types/index.ts`; `threadRoster` sorts by it).
    `status`/`ownerThreadId`/`invocationId`/`label` carry their record values.
    **`epoch` is STRIPPED here and nowhere else (W19/W22, 2026-11-17).** The runtime record pairs
    `invocationId` with the process that minted it, and every plane that resolves a run reads that
    pair — except the model page, which `modelThreadRosterOf` (`src/harness.ts:6804-6813`) narrows
    back to the bare ids it has always published. The reason is a parameter the tool does not have:
    the `threadList` schema has no epoch argument, so handing the model a token it could never send
    back would widen a contract the model reads for no benefit, and the page stays byte-identical
    to the pre-W19 roster. The HOST/UI planes DO carry the pair
    (`SessionThread.epoch` / `SessionThreadView.epoch` / `ThreadSummary.epoch`) — see
    [Persistent threads in the UI](#persistent-threads-in-the-ui-t5--r5-r7) for the identity triple
    and why the two planes are allowed to differ. `src/harness.ts:6167` cites
    `./harness.invocation-run-key.test.ts` and `./tools/runtime/threadList.tool.ts` as the proof of
    the strip, and NEITHER mentions `epoch` (there is no `threadList` test file at all) — the strip
    is therefore an observed behaviour of `modelThreadRosterOf`, not a pinned contract; reported
    here rather than papered over.
  - **Fork branches are absent from the roster on purpose.** A `threadFork` branch is an
    INVOCATION with an ephemeral transcript, not a thread slot, so it never enters
    `threadStates` and never appears here; its `branch-N` id is still readable through
    `threadRead`/`agentResult` via the branch ledger (see
    [threadFork](#threadfork)), and `threadDelete` refuses it as an address, not as a
    release.
  - **The roster is a LIVE, caller-relative snapshot**, computed per call
    (`threadRoster(currentThreadId)` reads the current `threadStates` map and the caller's
    family at that instant). Nothing is cached, nothing is a projection of an earlier turn,
    and two callers in one session get different lists.
- **`threadRead` reads the FIRST PAGE, not "the whole thread from the start"
  (I1–I4).** The old docstring promised a full read the tool never performed; the
  description now states the applied defaults: `limit` 20 messages, per-message
  `contentLimit` 4000 characters, and a total `contentBudget` of 32,768 UTF-8 bytes
  per page — the reader's OWN, deliberately smaller bound, so the 20 × 4000 worst
  case cannot blow past the harness's serialized tool-result cap
  (`core/result-budget.ts`) and come back as an opaque truncation envelope instead
  of the pagination metadata (`THREAD_READ_*`, `src/tools/runtime/threadRead.ts`).
  Nothing is cut silently, and the TWO truncation vocabularies are distinct
  (`ThreadReadResult`/`ThreadReadMessage`, `src/tools/runtime/threadRead.ts`):
  - top-level `truncated` means the 32 KiB PAGE BUDGET did the cutting — it trimmed text
    below what `contentLimit` allowed, or it dropped whole messages off the end of the page
    (an exhausted budget breaks the loop); a `contentLimit` cut ALONE does not set it,
    because that is the caller's own bound, not the reader running out of room;
  - a per-message `contentLimit` (or `contentOffset`) cut is reported on THAT message as
    `contentHasMore` plus `nextContentOffset`, never as top-level `truncated`;
  - `hasMore`/`nextOffset` address the MATCHED MESSAGE LIST — pass `nextOffset` back as
    `offset` while `hasMore` — while `nextContentOffset` goes back as `contentOffset` to
    finish one long message; the two cursors are independent, and a `message`-mode read
    never has a next list page;
  - `total` counts the UNFILTERED transcript — the system seed included even when
    `includeSystem` is false — while `matched` counts what survives `includeSystem` + `role`
    + `regex`, and is the length `offset`/`limit`/`nextOffset` page through. Each message's
    `index` still addresses the FULL transcript (`total`'s numbering), so an index reported
    by a filtered page stays re-readable with `message`.
  New parameters:
  - `includeSystem` (default **FALSE**) keeps the leading system seed out of the
    pages AND out of regex matching — one decision, not two — so it no longer
    occupies every page's budget; `true` restores the old behavior, and `message`
    mode reads index 0 regardless because that mode addresses a raw transcript
    position and bypasses the filter. `total` and each message's `index` still
    address the FULL transcript, so a reported index stays re-readable with
    `message`.
  - `toolArgs` (default **`"reference"`**) renders each assistant tool call as
    `{ id, name, argumentsLength }` with NO arguments text and no byte cost —
    reading one's own thread no longer re-bills the arguments the caller just sent
    (a delegation brief used to dominate self-reads); `"full"` restores the paged
    inline arguments. `regex` matches the RAW arguments either way; the
    `tool`-role result BODIES are unaffected by the mode, and reference mode
    reports no truncation flag because nothing was cut.
  - `regexFields` narrows which fields `regex` searches — `content`, assistant
    `reasoning`, `toolArguments`, `toolName` (one word covers both an assistant
    call's name and the tool a tool result answers); the default is all four.
    Fields are tested SEPARATELY, never concatenated. Every returned message then
    names its hits in `matchedFields`, including hits in fields the page does not
    display — which is how the SELF-MATCH (your own earlier call's arguments
    containing the pattern you just sent) became an explicit report instead of a
    mystery message.
  - A FINISHED fork's `branch-N` id is a readable `thread` id: the read seams
    resolve it through the branch ledger (`threadRecordOfBranch`), which is exactly
    why forks stay invocations and not roster threads (see
    [threadFork](#threadfork)).
- **`threadSend` reaches the LINEAGE, with per-address self-rules (B4).** Own
  thread, an ancestor, one of your descendants, or a DEFAULT conversation
  (`agent:<name>`) the caller's roster lists — the defaults of EVERY agent the family
  spans, not only the sender's own; anything else outside the lineage is refused with a
  sentence distinct from not-found ("the id exists — it is simply outside your
  lineage"), so a model can tell a roster problem from a typo. The target's state decides
  delivery, and since IT19 R5 the receipt names which of THREE operations it caused —
  `"queued"` STEERING, `"started"` CONTINUE, `"resumed"` RESUME — never a bare word.
  running → `"queued"` (mid-run steering at
  the next safe model boundary — including a message to your OWN running thread),
  a PLUGIN-PARKED (`paused`) target → also `"queued"`, and the park is LEFT EXACTLY AS IT
  WAS — no resume, no run, because the holder of the park is waiting for its own turn
  (only a host `sendThreadInput` lifts a park from outside, T8) — and an idle target →
  `"started"` — EXCEPT the two self-calls: asking your own idle thread
  to start a fresh run is refused (you are already inside that turn), and asking
  your own idle `agent:<name>` default is refused ("use the current turn"); your
  own default while it runs is simply `"queued"`. A different agent's idle
  default conversation still starts a run of its own — the historical cross-agent
  chat survives, and it is what the family's default-conversation rule exists for.
  When that start happens, the sender's id rides on the RUN as its REPLY TARGET (see the
  family rule's fifth member above), so the started turn — and only that turn — can
  `threadList`, `threadRead` and `threadSend` the conversation that woke it; the route
  reverts when the run ends (issue 0030).
  A `note` naming the live thread id is added CONDITIONALLY — exactly when the target is
  an `agent:` DEFAULT and at least one OTHER thread of that addressed agent is
  `running` (`liveSiblingNoteFor`, `src/harness.ts`; it prefers a thread the sender
  owns, and otherwise names the newest): the default conversation is NOT the live
  delegation, the message went where it was addressed, and the note names the thread
  whose turn is in flight. The candidate list is FILTERED THROUGH THE CALLER'S FAMILY
  (2026-11-14, issue 0031): the note names a live thread ONLY when that thread is
  addressable from your family, because every other thread tool refuses anything outside
  it — before this, the newest-running-SIBLING fallback usually advised an id the caller
  could not send to (a sibling is excluded from the family by design), so the receipt
  promised a door it then refused. A receipt with NO note now means "no live thread of
  that agent is reachable from here", which is a truthful answer rather than a missing
  hint; a threadless (host) caller is unscoped and keeps every candidate.
  A STOPPED thread is no longer uniformly host-revive-only (IT19 R3/R5, 2026-11-15): the
  record's `stopReason` decides. A run that was cut short — `caller-released`, `timeout`,
  `turn-cap`, `budget-exhausted`, `api-error`, `retries-exhausted`, `provider-network` or
  `parent-closed` — takes an
  agent `threadSend`, and that send reports `"resumed"` because the retained turns continue the
  same conversation instead of opening a fresh one. A thread the HOST stopped (`user-stopped`),
  one a plugin parked (`plugin-parked`), and one stopped with NO recorded cause are refused —
  only a host `sendThreadInput` revives those. An INACTIVE target is refused too, ahead of any
  status branch: its record and transcript are retained for a host read, but it is off the
  roster and takes no messages THROUGH THIS DOOR — `threadSend` is the agent-facing one, and the
  host `sendThreadInput` remains the revival that lifts `inactive` (see the thread-lifecycle
  bullet below). Every refusal queues nothing, so a failed send never leaves a message waiting to
  land.
- **`threadDelete` releases a FINISHED thread you own (B5 — closes issue 0027).**
  The model-facing counterpart of the host `deleteThread`: explicit and MANUAL
  (the issue's rejection of auto-delete holds — a settled child stays readable
  until its owner says otherwise). PERMANENT is retired wording (IT19 R2, 2026-11-15):
  `deleteThread` MARKS the record `inactive` (+ `inactiveAt`) through `purgeThread`, and the
  row, its transcript and its invocation rows SURVIVE — the generation still bumps, the queue
  is still cleared, and a second `threadDelete` on a released descendant RESTATES the first
  receipt without re-marking, without a fresh `inactiveAt` and without a second
  `thread.deleted` hook. Nothing an agent does destroys a conversation; only deleting the
  session does - with one bound this passage now states plainly: the roster holds at most
  `MAX_THREAD_RECORDS` (256) rows, and once it is over that bound `capThreadRecords`
  (`src/server/sessions.ts:4787`, mirrored inside the harness by `capRetiredThreadRecords` at
  `src/harness.ts:889`, the constant being `core/thread.ts:52`) retires the OLDEST released rows
  TOGETHER WITH their transcript rows. So a released conversation stays readable until the cap
  passes it - a bounded roster of 256 thread records, not every row ever. The tool text states
  the same bound (`src/tools/runtime/threadDelete.tool.ts`). `thread` must be a STRICT
  DESCENDANT of the
  caller (`threadDeleteFor` walks the persistent owner chain): your own current
  thread, an ancestor, a sibling, and another agent's conversation are refused by
  name; a RUNNING thread is refused ("stop it first") — and the remedy is named in the
  description now, because the sentence used to imply a door that does not exist: there is NO
  thread-stop tool, and an agent's only stop is `toolCancel` on a call ITS OWN run started,
  which does end a delegated child (the child's signal is linked to that call's controller, so
  the child lands `stopped` + `stopReason: 'caller-released'` with its turns retained); the
  default `agent:<name>`
  conversations are refused; a threadless caller gets the unscoped host operation
  verbatim. A FORK's `branch-N` id gets its OWN truthful refusal, not the generic
  not-found (2026-11-14, stress report #4): the delete seam resolves the branch ledger
  BEFORE the thread table (`branchRecordOf` ahead of `threadStateOf` in `deleteThread`
  and in `threadDeleteFor`) and `branchDeleteRefusal` states the rule — a branch is a
  record, not a conversation, it holds no thread slot, it leaves when the conversation
  that forked it is deleted, and the branch ledger keeps only its newest
  `maxBranchRecords` (64 by default, `core/branch.ts`). The refusal is still a refusal:
  no branch became deletable, and a caller that does not own the FORKING conversation
  still gets the lineage refusal rather than a probe of which subtree an id belongs to.
  Deletion CASCADES (the finished descendants go with the target — a
  running descendant refuses the whole delete, so no partial removal), and the
  receipt is FOUR fields — `{ deleted, removedThreadIds, removedInvocationIds,
  removedBranchIds }` (`HarnessThreadDeleteResult`) — the state the caller caused.
  The last two were added because the purge silently SHRINKS the agent-result registry:
  `purgeThread` releases the invocation records owned by everything that went (it now
  RETURNS the two id sets instead of throwing them away), so `agentManage`'s counts drop and
  the released ids stop being LISTED — and a caller auditing a reaping loop needs to see which
  ids went with the conversation. IT19 R2 changed what the two sets MEAN, not their names:
  `removedInvocationIds` now lists the rows that stopped being LISTED (the rows themselves are
  retained, and `agentResult` still answers an explicit `invocationId` the caller already
  holds), while `removedBranchIds` is the one set genuinely REMOVED, because a branch lives in
  the bounded branch ledger and not in a conversation. **A REPEAT DELETE RESTATES THE TWO HIDDEN
  SETS (2026-11-15, F-A Defect 3):** re-deleting an already-released id used to answer three
  fields under three different rules — `removedThreadIds` = only what THIS call newly marked (so a
  cascade child the first release had already hidden was missing), `removedInvocationIds` = what
  is STILL hidden (the first receipt's set), `removedBranchIds` = empty — while the tool text an
  agent reads promises the retry "restates the same receipt". The code now follows that promise:
  the two fields that describe RETAINED-but-hidden state (`removedThreadIds`,
  `removedInvocationIds`) are restated in full, in the first receipt's order, and only
  `removedBranchIds` keeps the "newly by this call" reading — that one is the accurate exception,
  because the branch ledger row really did go. Pinned at `src/harness.thread-runtime.test.ts`
  (the B5 reaping case, both receipts compared) and in `src/tools/runtime/threadDelete.test.ts`
  (the receipt prose). Both arrays are ALWAYS present, and
  empty means "released nothing", not "did not say". A released id is off every AGENT door,
  while a host read still resolves it,
  and the 256-thread cap (`MAX_THREAD_RECORDS`, `core/thread.ts` — `createThreadState`
  THROWS at it) is finally actionable from inside a session. Worker mode classifies
  it as authority work: `threadDelete` is in `AUTHORITY_RUNTIME_METHODS`
  (`src/server/workers/capability.ts`), the target travels as the request's
  `threadId` and the CALLER inside `identity`, so the canonical harness performs
  the scoped delete and the lane mirror rebases (`lane-worker-loop.ts`). Two
  worker-mode holes closed on 2026-11-14 made the release honest there: the durable
  server projection no longer skips branch results when it reconstructs which
  invocations a delete dooms (`SessionStore.doomedInvocationIds` used to exclude any
  event thread with a `kind`/`branchId`, asserting "the runtime keeps them" while the
  live session had already dropped them), and a LANE-ARCHIVED result now carries its
  `threadId` (`SharedMutation`'s `result:archive` op in `lane-commit.ts`, stated by the
  worker as `lane.targetId` in `lane-worker-loop.ts`, forwarded verbatim by
  `lane-authority.ts`) — the delete cascade predicates on `record.threadId`, so without
  it the same `threadDelete` removed an inline conversation's results and left a lane
  conversation's behind. **THE CASCADE IS A DURABLE RULE (the C6 hole this passage recorded on
  2026-11-14 — issue 0027's dated update — is CLOSED):** the owner travels with the row end to
  end. `HarnessAgentResultSnapshot.threadId` exists (`src/types/index.ts:4377`), the snapshot
  projection writes it when the invocation has a conversation (`src/harness.ts:15352-15384`,
  the `agentResults` map in `snapshot()`), `restore()` rebuilds it with the row
  (`:15776-15814`), and the reader accepts and validates the key — MAY-BE-ABSENT like `error`,
  so an old file still loads, and a present one must be a non-blank string, so a hand-edited
  `threadId: ""` is refused rather than restored into an owner that matches no conversation
  (`src/core/snapshot.ts:180,198,320-326`). After a `snapshot()` → `restore()` round trip the
  cascade's PRIMARY predicate (`record.threadId === threadId`, `src/harness.ts:7864`) therefore
  still matches: deleting a conversation AFTER a reload takes its archived results exactly as
  the same delete does BEFORE it, inline or lane-archived, and the four-field receipt names the
  same ids either way. That parity is pinned, both doors in one run, by
  `src/harness.agent-results.test.ts` (the `deleteThread` pair inside its
  `carries a cancelled run partial and its message position through snapshot -> restore` case,
  and the `threadId` rows of its forensic-value case) and by the on-disk row plus reload
  asserted in `src/server/threads.test.ts`. TWO boundaries survive and neither is a cascade
  hole: `threadId` is ABSENT only on a row whose run resolved no conversation at all
  (`runThreadId`, `src/harness.ts:14811` — an ephemeral branch whose parent had none, or a brain
  outside the registry), while an ordinary root run names the agent's default conversation,
  `agent:<name>`, and matches after a reload like every other one; and a run still `running` at
  snapshot time is not persisted at all (the projection filters it at `:15353`, and the thread
  row drops its `invocationId` for the same reason, `:15416-15418`), which is the unchanged "a
  snapshot never claims work is live" rule. WHAT A RELOAD STILL DOES NOT RESTORE is the
  PER-CALL attribution: `parentScope`/`parentCallId` live on the in-memory record
  (`:4533-4536`, stamped at `:4727-4728`) but on no persisted row — the reader's key list
  names neither (`src/core/snapshot.ts:176-198`) — and `delegatedRecordOf` addresses a child by
  exactly that pair (`src/harness.ts:5531-5540`), so the OWNER chain is durable while the doors
  that reach a child by its spawning tool call go quiet after a reload even though the row is
  intact (the half issue 0033 records as still owed).
  **Worker mode no longer diverges about the forensic pair either.** The same `result:archive`
  op that states the owner also carries `partialContent`/`cancelledAtMessage`
  (`HarnessInvocationArchiveInput`, `src/types/index.ts:4409-4470`; emitted by
  `lane-worker-loop.ts` from the replica's own terminal record, `:1119-1120` beside its
  `threadId` at `:1146`), and every leg is shipped: the op digest covers the pair
  (`archiveDigestOf`, `lane-commit.ts:171-199`) so a lane cannot skip the very archive that
  would carry it, the fold validates the pair BEFORE it touches the canonical view and answers a
  permanent `invalid-mutation` for a malformed one (`:1092-1119` via `readArchiveForensicPair`,
  which reuses `src/core/snapshot-validation.ts` — the same bounds `src/core/snapshot.ts` uses
  to read those fields back off disk, so nothing is ever legal to archive and illegal to
  reload), the authority forwards it verbatim (`lane-authority.ts:1171-1180`), and
  `archiveInvocation` returns the pair with the row it stores (`src/harness.ts:8907-9092`)
  because the lane digests the RETURN value. What the lane still cannot do is unchanged:
  `delegate` and `threadFork` are REFUSED on a lane (the nested-run policy is armed at the hello
  handshake, `lane-worker-loop.ts` `refuseNestedRuns`), 0034's structured lane rejection (a
  `code` plus the refused id on the wire) was DECLINED as a protocol change — a failed request
  still crosses as `{ ok: false, error: message }` (`src/server/workers/protocol.ts`
  `request.reply`) — and `threadExecution` still DEFAULTS to `inline`
  (`DEFAULT_THREAD_EXECUTION`, `src/server/config.ts:118`).
- **Terminal state is ONE synchronous commit (B2).** A finished run's terminal
  ledger entry (`finishInvocation`) AND its thread-status release to `idle` now
  happen together in `commitRunTerminal`, BEFORE the post-run hooks and branch
  release that used to `await` between the two facts — a `run.finished` handler
  (or a `threadDelete`) that arrives once a run answered never sees a still-`running`
  record that would refuse with "stop it first", and never a conversation gone
  while its ledger entry is still open. `thread.invocationId` is stamped only
  AFTER the invocation record exists, and `runAgent`'s `finally` keeps its release
  block as an idempotent backstop (event ORDER is preserved — only the STATE moves
  earlier).
- **Spawner-side context relief is REQUEST-ONLY, and the answer door carries the
  task answer (2026-11-17, T6; `src/harness.delegation-context-relief.test.ts`
  pins both rules as facts a parent can OBSERVE — D-1 and D-3).** A delegation
  costs the spawner context in two places and only one of them is relieveable.
  (a) THE ANSWER LEG: a fan-out spawner parks in `waitForWork` while its children
  work, so NO `turn.before` boundary runs during the wait and every answer of the
  round lands in ONE step function the estimate could not price — each in-flight
  call projects a ~200-byte `status: 'pending'` placeholder, so the pile is
  invisible until it is already owed. At the boundary of the request that would
  carry it, `relieveDeliveryWeight` (`src/harness.ts:10108`, wired into `requestOf`
  at :13161) measures the `tool` entries inserted since `run.deliveryMark` and
  takes the excess out of THAT REQUEST with the shipped planner
  (`planCompactionRequest`, `src/plugins/context-compaction.plugin.ts`).
  REQUEST-ONLY means: nothing is deleted, no inclusion flag moves, the canonical
  transcript keeps every byte, and the newest round — the answers the run just
  delegated — stays verbatim. The ceiling that sizes the relief scales with the
  bound model's WINDOW through `toolResultBudgetsForContextTokens` (published from
  the `src/harness.ts` barrel 2026-11-17), never with the operator's
  `contextLimit`. (b) THE REQUEST LEG is not relieveable and relief is
  spawner-side only: a spawner's task text IS its request, so rewriting it re-asks
  the question, and a child shrinks its own transcript and its own answer — never
  the request that spawned it. (c) THE DOOR SHAPE: what crosses to the spawner is
  the child's TASK answer, never one of the child's own context-relief artifacts.
  A summarize pass commits a tool-free prose turn (the structured summary the
  compaction instruction asked for), byte-for-byte the shape the run loop exits
  terminally on, so three doors used to hand that prose upward — the blank-turn
  rescue (`resolveRunAnswer`), the answer-so-far recording, and the cancellation
  report (`run.partialContent` → `lastSubstantiveText`); each now skips a
  compaction entry. THE CANCELLATION REPORT HAS TWO LANES and X2 (F4) closed the
  second: `partialContent` PREFERS the in-flight stream buffer over the committed
  walk ("the FRESHER evidence wins", issue 0020), and the skip had only ever been
  applied to the walk — so a stop between the instruction commit and the summary's
  `done` frame put the HALF-STREAMED summary in the buffer and the spawner read a
  relief note as the answer the child had in hand. `src/harness.ts` now asks the
  plugin (`isCompactionAnswerStream`, which appends a content-free placeholder turn
  and runs the transcript POSITION test `isCompactionAnswerTurn` — the streamed text
  never enters the decision) and, when the turn being streamed IS the compaction
  answer, falls through to `lastSubstantiveText`: an interrupted child reports its
  last TASK sentence, or no partial at all. Pinned with an issue-0020 CONTROL
  (`src/harness.delegation-context-relief.test.ts`) that proves the buffer still
  wins when the cut is not a compaction answer, so the exclusion pin cannot go
  vacuous. The ENTRY stays in the child's own transcript, where
  `threadRead` / `agentResult` still answer for it: the parent has no business
  seeing that its child compacted. The rule that makes a mid-task child compaction
  reachable at all is pinned in `src/harness.compaction-delegation.test.ts` (a
  child of a host-thread parent is `depth >= 2`, the only case whose in-run turn
  can carry the continuation nudge). NOT claimed: a delegation that ENDS as an
  answer is not re-priced when its parent runs — that re-pricing stays on the
  deferred list, see `## Context and history` for what a run's context actually is
  and `## Delegation cost and resume accounting` for what a spawner pays at resume.

---

## Owner questions and history forks

Two conditional harness-owned core tools (N3/N4). Their parsers, defaults, and
bounds live in `core/action.ts` and `core/branch.ts`; the runtime handling is in
`src/harness.ts`; the server broker is `SessionStore` (`src/server/sessions.ts`);
the card is `src/frontend/ui/action-request.ts`.

### Registration and configuration

```ts
const writer = harness({
    agents: { writer: agent({ ... }) },
    interaction: {
        actionRequest: async (context, signal) => ({ kind: 'option', optionId: 'safe' }),
        autoAnswer: true                       // default
    },
    forks: {
        enabled: true,                         // default
        maxDepth: 2,
        maxConcurrent: 4,
        maxHistoryBytes: 8 * 1024 * 1024,
        maxBranchRecords: 64
    }
});
```

- `actionRequest` is registered only when `configuration.interaction` is present.
  Its `execute` is a deliberate refusal: the runtime handles it, so a direct
  `executeTool()` call cannot fabricate an owner.
- `threadFork` is registered when `forks.enabled` is true (default). Set
  `forks: { enabled: false }` for a harness that must not branch.
- `resolveForks` reads defaults from `core/branch.ts`. Every numeric bound must be
  a positive safe integer; a typo throws at construction instead of silently
  clamping. `maxConcurrent` counts autoanswer branches too.
- The server always passes an `interaction.actionRequest` handler into every
  preset (fresh and restored) and leaves `autoAnswer` unset. The CLI passes a
  handler that rejects with a readable "no owner UI" message, so a root question
  is declared and can be attempted, but the recommendation is never accepted on
  the user's behalf. A plain library harness without `interaction` has no
  `actionRequest` tool at all.

### actionRequest

Model arguments and the parsed request:

```ts
type HarnessActionOption = { id: string; label: string; description?: string };
type HarnessActionRequest = {
    requestId: string;              // runtime-generated, never model-supplied
    question: string;
    recommended: string;            // MUST be one of options[].id
    options: HarnessActionOption[];
    allowCustom: true;              // type-level constant, not an argument
};
```

- Strict parser (`validateActionRequestParameters`): plain object only; exactly
  `question`/`recommended`/`options`; no `allowCustom` argument (unknown properties
  are rejected). Bounds: question 1..4000, options 2..8, id 1..32 matching
  `^[A-Za-z0-9_-]+$`, unique ids, label 1..120, description trimmed and ≤500
  (blank is omitted). Ids/labels/question are trimmed by the parser. An unknown
  `recommended` id is an error, never a fallback to `options[0]`.
- `allowCustom` is always true: an owner can always answer
  `{ kind: 'custom', text }` (trimmed, 1..4000). `validateActionChoice` accepts
  exactly `{ kind: 'option', optionId }` or `{ kind: 'custom', text }`; an option
  id the model did not offer is an error, and a custom choice has no request-side
  switch to check.
- `HarnessActionHandler = (context, signal) => Promise<HarnessActionChoice>`.
  `context` is `{ requestId, agent, branchId?, threadId?, callId, request }`.
  `branchId` is the REQUESTER's branch, absent for a root. `signal` aborts with
  the run. A rejecting/throwing handler fails the tool call with a readable tool
  result (`actionRequest owner handler failed: …`).
- The model-visible result is `HarnessActionResult`
  `{ requestId, answeredBy: 'owner' | 'auto', choice }`. An option choice is
  widened with the resolved `label`/`description`; a custom choice is verbatim.
- The runtime request id is `request-<epoch>-<n>`: a process-local epoch nonce
  (`HARNESS_PROCESS_EPOCH`, `src/core/agent-limits.ts`) and a monotonic counter, so an
  id from an earlier process can never collide with a live one. It is minted per
  request, so a client must carry the value from the frame that reports it rather than
  construct it.
- Pending limit: at most 4 unresolved requests per harness (`src/harness.ts`) and
  per session (`MAX_PENDING_ACTIONS` in `src/server/sessions.ts`). A fifth is
  rejected for the model, never auto-answered.
- Root runs: only the host handler can answer. If it is absent, the tool result is
  a readable "no interaction.actionRequest handler" failure; the recommendation is
  never selected automatically.
- Child/fork runs: the immediate owner is cloned at request instant, synchronously,
  over the owner's FULL history plus the requester's FULL history
  (`incorporateBranchHistory`; child system messages are demoted to quoted user
  data). The autoanswer branch is tool-free and gets exactly one turn, so it cannot
  recursively fork or ask again. It must
  reply `option:<id>` or `custom:<text>` on one line; blank, prose, an unknown id,
  or any tool call is an explicit failure. `forks.enabled` must be true and
  `autoAnswer !== false`. The answer is delivered only to the requester's
  `actionRequest` tool result; the owner transcript is unchanged. The autoanswer
  branch inherits the owner's role and records `tools: []`.

### threadFork

```ts
threadFork({ input: string; label?: string; timeoutMs?: number })
// -> HarnessForkResult { branchId, threadId, content }
```

- `input` is required and non-empty. `label` is display-only, trimmed, ≤120.
  `threadFork` is a normal tool call: the requester stays in flight and the branch
  runs as a separate actor.
- At request instant the runtime calls `forkAgent(run.agent, …)`; the branch gets
  this agent's ENTIRE committed transcript (never a slice), current model, and
  instruction snapshot. `materializeBranchHistory` deep-copies and validates every
  message, remaps every tool-call id to `call_<branchToken>_<n>`, rewrites every
  tool result to the remapped id, and pairs outstanding calls with the
  `threadFork` non-success placeholder. Duplicate/orphan results and repeated ids
  are rejected. The origin transcript is never mutated.
- Branches inherit the source agent's RANK (`actorRanks.set(branch, rankOf(run.agent))`,
  `src/harness.ts:11670`, and the same for an autoanswer branch at `:11987`), so `declared(branch)`
  resolves the same rank-aware projection: a fork of a Rank A agent keeps `delegate` (narrowed to
  that agent's own strictly-lower targets) and keeps `toolCreate` whenever the `toolCreation`
  ceiling admits Rank A; a fork of a Rank B agent neither sees a Rank A delegation target nor
  creates tools under an `'A'` ceiling. A fork can fork
  again until `maxDepth`.
- Bounds (`core/branch.ts`): `MAX_FORK_DEPTH = 2` (ordinary forks; autoanswer
  inherits the source depth), `MAX_FORK_CONCURRENT = 4` live branches,
  `MAX_FORK_HISTORY_BYTES = 8 MiB` of serialized history,
  `MAX_BRANCH_RECORDS = 64` retained records. Over-cap history is an EXPLICIT
  error — a fork never truncates history. The serialized cap includes attachment
  payloads, so a legal media-heavy turn can exceed 8 MiB; raise
  `forks.maxHistoryBytes` for those histories.
- The only value returned to the origin is `{ branchId, threadId, content }`, where
  `threadId === branchId`. `content` is the branch's final assistant text, trimmed
  and required non-empty (`threadFork branch "…" produced no substantive answer.`
  otherwise). There is no separate summarizer pass and no transcript merge; the
  full branch transcript stays in the audit record. SINCE 2026-11-13 the shared
  `branch-N` id is a documented HANDLE (finding C1/B1), not a receipt: `threadRead`
  accepts it to read the branch transcript (the read seams resolve the branch
  through the branch ledger — the fork remains an INVOCATION, deliberately not a
  roster thread), and `agentResult` accepts it as `invocationId` to page the
  answer, including the `partialContent` of a branch that was cancelled, failed,
  or timed out before it answered.
- **`timeoutMs` (B1, 2026-11-13)** is the fork half of the 2026-11-09 time policy:
  an optional 1–3,600,000 ms wall clock on the branch run (the ceiling is
  `MODEL_TIMEOUT_MAX_MS`, shared with `delegate`'s `timeoutMs` and restated as a
  literal pinned by `core/metadata.ownership.test.ts`). Omitting it resolves to
  the harness's `threadForkTimeoutMs` configuration (the host's backstop for the
  non-tool fork doors — `thread.forkThread()`, `api.threads.fork()`,
  `runtime.threadFork`), which itself defaults to NO LIMIT (`FORK_TIMEOUT_MS` is
  `Infinity`); a finite value arms the branch's OWN controller, linked into the
  scheduler's signal, so the requester's run keeps its signal and still receives
  a structured outcome. On expiry the branch is recorded `cancelled` (the honest
  control outcome, not `failed` — `branchFailureStatus` reads the LINKED signal, which is
  why the branch's own clock counts as a cancellation and not a throw). What the
  requester reads is CONTENT-CONDITIONAL, and only the pointer is unconditional: a
  cancelled fork call answers with the branch id and the two doors that still read it
  (`Tool call "threadFork" (id) was cancelled before it completed; its branch
  "branch-N" still holds what it produced — read it with threadRead "branch-N" or
  agentResult by that id.`), while the FAILED-door sentence embeds an inline preview of
  what the branch had produced ONLY when a partial actually exists (the branch's
  invocation `partialContent`, capped at `FORK_PARTIAL_PREVIEW_CHARS`); a branch that
  produced nothing reports only the reason, byte for byte the historical
  `Tool "…" failed: <message>` sentence, and the same holds for the `produced no
  substantive answer` case. So the branch's committed WORK survives; the inline preview
  does not exist independently of it.
  `threadRead branch-N` and the partial are two different facts, though (corrected
  2026-11-14): a cancelled or failed branch rolls back its OWN turns, so the transcript
  that address serves is the baseline the branch was forked from — the origin conversation
  up to and including the fork call — while the text the branch had actually produced
  lives in the invocation record and pages through `agentResult` with `branch-N` as
  `invocationId` (`finishBranch`'s terminal `messages`, `lastSubstantiveText`, and the
  pins in `src/harness.fork.test.ts`). A fork is still the one background call whose work
  survives its own cancellation — it survives as a RECORD, not as a transcript tail.
- Runtime identity is private: `actorKeyOf(branch)` is `branch:<branchId>`, never
  the display name, so a fork cannot deadlock behind a same-name source run.
  `actorRoles` inherits the source role; `agentBranchOf` reads the `WeakMap`.
- `harness.branches()` returns detached `HarnessBranchRecord` copies; `branch(id)`
  returns one or `undefined`. A record is `HarnessBranchSummary` plus `status`
  (`running|completed|failed|cancelled`), `toolCallIds` (origin→branch remap),
  `messages`, and optional `result`/`error`. Active records are never evicted;
  the newest terminal records fill the remaining `maxBranchRecords` capacity.
- Branch state is ephemeral: `branchRecords`/`activeBranches`/pending request ids
  are runtime/session state, deliberately NOT in `HarnessSnapshot` v1. `reset()`
  does not clear branch records (nor does restore bring them back); they are
  pruned only by the retention bound.
- `src/harness.ts` refuses `executeTool('threadFork' | 'actionRequest', …)` with
  "requires the harness run that owns the conversation", so neither can be
  invoked through the manual server tool route.

### Events and threads

- `action_request`: `{ agent, callId, request, thread? }`, emitted by the
  requester before the handler/owner fork is invoked, so a client can render the
  pending card.
- `action_answer`: `{ agent, requestId, answer, thread? }`, emitted for every
  accepted answer before the tool result. `answer` is
  `{ requestId, choice, source: 'owner'|'auto', branchId? }`.
- `branch_start`: `{ agent, branch: HarnessBranchSummary, thread? }`; for an
  autoanswer it is emitted before `action_request`.
- `branch_end`: `{ agent, branchId, status, error?, thread? }`; `error` is present
  for `failed`/`cancelled` and absent for `completed`.
- `HarnessThread` = `{ id, parentId?, callId?, input?, kind?, branchId?, epoch? }`. `kind`
  is `'delegation' | 'fork' | 'autoanswer'`; a branch's `id` IS its `branchId`, and
  the branch's own frames carry that same `thread`, so `branch_start`/`branch_end`,
  the branch frames, `harness.branch(id)`, and the transcript's nested entry use
  one naming scheme. `input` is the branch/child task. `epoch` (T-W8) is the per-process
  epoch that minted `id` — a `branch-N` id is recycled across a restart exactly like an
  invocation id, so `branchThreadOf` stamps the epoch on the audit frames too (they BYPASS
  `emit` and go straight to `progress`, where nothing else would put the process identity),
  and one branch row therefore never sees two epochs for one run. See "HarnessEvent" for the
  full identity contract.

### Server broker and UI

- Route: `POST /v1/harness/sessions/:id/actions/:requestId/answer` — ONE mount on both
  hosts (CORRECTED IN PLACE 2026-11-11: this named "standalone `/api`, service
  `/v1/harness`", and the answer no longer replies with a bare `{ ok: true }`) — with
  body `{ choice }` and response `{ ok: true, request_id, resolved_at }`
  (`src/server/api.ts:3570-3585`).
  `SessionStore.answerAction` validates against the recorded request and settles
  the handler promise exactly once. Status mapping: 400 malformed body/unknown
  option/out-of-bounds text, 404 unknown session or request id, 409 already
  answered or expired. It is deliberately allowed while the session is busy — the
  active run is awaiting it — and it never enqueues a turn.
- Pending entries keep the run's abort listener. `cancel()`, session end,
  `remove()`/`dispose()`, and an abort settle them with readable rejection text;
  `MAX_COMPLETED_ACTIONS = 64` request ids are remembered so a stale card is 409,
  never 404.
- Restore marks every recorded `action_request` id as expired (the awaiting
  runtime is gone) and starts no run, so a restarted session cannot resume a
  question.
- UI: one card per event. A root request is interactive: recommended option first,
  alternatives after, **always** a free-text custom path, explicit **Answer**
  (nothing auto-submits); submit disables controls, keeps the choice on failure,
  and treats `setAnswer` from `action_answer` as authoritative. A non-root card is
  read-only ("Auto-answered by the owner fork.") because its owner answers
  automatically. Cards capture the session id at render time; a session
  switch/clear or a terminal turn expires them, and `main.ts` re-checks the binding
  before POSTing, so an answer can never cross conversations.
- Branch entries render through the existing nested invocation layout (`thread`
  metadata) with a small kind tag; a settled turn's cards are expired on replay.

---

### Tool-composition visibility

A model writing a TOOL CALL emits NOTHING while it writes it: fragments are merged
inside the stream reader with no yield (`src/transport/openai.ts:1976-1979`), `tool_call`
events exist only AFTER the terminal frame, and only the terminal frame carries them. Pre-tool
reasoning and content still stream — the engine's filter withholds only from the first potential
tool marker onward
(`services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:1000-1005`) — so the silence
begins exactly at the tool block and ends when the calls launch. This workspace's relay family
makes it worse: it withholds the whole tool region and flushes one final SSE frame
(`services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100, 993-1003`), and
its own deploy doc says the consequence out loud: "progressive write buffers, stall
detectors, and live progress consumers all stop working for the duration of the generation"
(`services/modal/deploy/qwen3.8-27b/modal_qwen3_8_l40s_ninfer.py:984-993`). SSE keep-alive
comments are no help either: the OpenAI SDK's decoder discards any `:`-prefixed line
(`node_modules/openai/src/core/streaming.ts:321-324`) and the relay re-emits only `data:`
lines (`runtime/endpoint/provider/private/chat-completion/private-chat-completion.ts:162-164`).
A 60 s silent request and a dead stream produced the SAME pixels — and one user aborted on
that ambiguity (`docs/tasks/2026-11-19-tool-call-composition-visibility.md`, Finding 1).

The answer is ONE new informational event kind and ONE new display field, not a new timeout:

- **Source.** After each `delta.tool_calls[]` merge the reader yields
  `{ type: 'progress', phase: 'tool-composition', toolCallSlots, argumentChars }` — the first
  fragment of an attempt emits IMMEDIATELY, later ones at most once per
  `TOOL_CALL_PROGRESS_INTERVAL_MS = 500` (`src/transport/openai.ts:1091, 1983-1989`), on
  `performance.now()`, and **no timer is armed** for it (the transport's only `setTimeout`
  arms are the provider idle bounds, `:744-790`, and those `unref()`).
- **It changes nothing about the turn.** `agent()` forwards it as an event and accumulates
  nothing (`src/core/agent.ts:1174-1199`); attempt scoping is free because a retry re-creates
  the transport iterator and the throttle clock lives in that generator's closure.
  `harness()` publishes it through the one `emit` gate, so it carries `thread` — a delegated
  child's composition lands on the CHILD's section, not the parent's
  (`src/harness.ts:13452-13478`). A frame after `completed` is dropped like a late text delta.
- **Contract.** `progress` joined the CLOSED event-kind list
  (`src/shared/harness-stream.ts:130-146`) and the generated swagger / API types
  (`src/server/harness.swagger.yaml:9241, 9257, 9687-9709`;
  `src/shared/harness-api.ts:3956, 4057-4068`) — all three are generator output
  (`scripts/generate-harness-contract.ts`), never hand-edited.
- **Counters, never text.** `toolCallSlots` is `pending.size` — a slot exists exactly when the
  provider opened a call, because `slotForFragment` mints slots and never removes them
  (`src/transport/openai.ts:979-1005`) — and `argumentChars` is the summed length
  (`src/transport/openai.ts:1099-1107`). Argument text is deliberately excluded: it is
  kilobytes per block, model-private, and every harness event is journalled VERBATIM
  (`src/server/sessions.ts:1372`), so carrying it would multiply the turn record by the
  throttle rate (`src/types/index.ts:470-476`).
- **Journal.** A `progress` line is journalled on purpose — after an abort or a restart it is
  the evidence that the turn was ALIVE — at ≤ ~2 lines per second per composing turn. It
  consumes a journal position, so node / context-block / step ids derived from that position
  move for everything that follows (`src/server/journal.ts:118, 143`), exactly as a journaled
  `wakeup` already moves them; the parity pin states both halves instead of hiding one
  (`src/server/journal-progress.test.ts:166, 192`).
- **Display plane.** ONE attempt-scoped field, `TurnSection.toolProgress`
  (`src/shared/turn-display.ts:1154`, patch copy `:1181`), painted by `paintToolProgress`
  (`src/server/turn-projector.ts:1926-1945`, dispatched at `:3393-3400`). It **mints no node,
  no step and no context block**, takes no tail, opens no prose window, costs ZERO ops when the
  counters did not move, and clears to `phase: 'idle'` at `done` / `retry` / `attempt_commit` /
  `error` (`:3245, 3363, 3378, 3439` with `IDLE_TOOL_PROGRESS`). A CLEAR of an ABSENT field
  emits nothing, so a pre-T2 record, or a relay that sent nothing, keeps a byte-identical
  display (`:1931-1934`). **`absent` is not `idle`**: absent means "this producer never
  reported composition" and must never be rendered as an elapsed figure.
- **Frontend.** The ops fold applies the field as a whole-value replace
  (`src/frontend/view-state.ts:424-429`). The tile renders the composition clause
  `composing N tool call(s) · <chars> chars` (`src/frontend/ui/turns.ts:891-893`, full claim on
  `title` at `:898-904`) and the silence grade beside it — `still generating · quiet for …`,
  extended with "— the run is still working" on the 30 s grade
  (`src/frontend/ui/turns.ts:4829-4830`, title at `:4855-4857`). The
  thresholds there (`QUIET_AFTER_MS = 5 000`, `SILENT_AFTER_MS = 30 000`,
  `src/frontend/ui/time.ts:52-53`) are **presentation thresholds, not timeouts** — crossing
  them changes only what the UI is allowed to SAY about a run that is still running, in a
  package where no external clock ends a run. The per-agent ring grades use the same
  vocabulary, and they are WIRED, not a capability waiting for a pass: the stamps come from
  every ops frame (`src/frontend/main.ts:14593-14600`), the graded paint runs from the document
  and patch paths (`:6845-6849` does the paint, `:6855` arms the clock; call sites `:7455,
  13988, 14437, 14601`), and while any agent is active a 1 000 ms clock re-grades those stamps
  (`ACTIVITY_GRADE_TICK_MS` `:6732`, `tickActivityClock` `:6761-6779`, `window.setInterval`
  `:6789`). The grading itself is `gradeActivityFromStamps`
  (`src/frontend/ui/activity.ts`, exported symbol `gradeActivityFromStamps` — cited BY SYMBOL
  because that file's line numbers move every pass), and that file's own header comment states the same
  wired fact (`:31-42`).
- **What it must never imply.** A SLOT is a call the provider has OPENED, not one that
  launched, was queued or is running — partial arguments are never executed — so "composing"
  is the only honest verb this signal supports. Nothing may end, time out or reorder a run
  because of a `progress` frame (`src/types/index.ts:4185-4192`).

**Timeout interaction, stated once:** the two recorded spans (27.683 s and 62.232 s of zero
frames) sit **inside** every shipped bound — head 300 000 ms, first token 300 000 ms,
between-reads 120 000 ms (`src/transport/provider-timeouts.ts:150-152`) — so no timeout could
have ended either turn, and no default was retuned to ship this. The first genuine danger
zone is a tool block past **120 s of silence**: the coded `provider-timeout` fires, which
takes the 4-attempt ladder (1 + 3, 2 s/4 s/8 s capped at 30 s, under a 900 000 ms
ladder-wide deadline — `src/core/agent.ts:1361-1385, 1402-1424`, `src/core/agent-limits.ts:179-207, 209-221`) and
re-sends the SAME request from token 1 with the generated arguments discarded. A stream that
trickles within the bounds is bounded by NOTHING on a total clock (pinned at
`src/transport/openai.tool-call-liveness.test.ts:653` ("lets a default-configured stream TRICKLE past
3 600 000 ms without any bound firing"); `MODEL_TIMEOUT_MAX_MS` = 3 600 000
is not a request clock (`src/core/agent-limits.ts:74-81`). See issues 0037 and 0038.

Tests: `src/transport/openai.tool-call-liveness.test.ts` (the four accumulation fixes, the
62 s/120 s bound pair), `src/transport/openai.tool-call-progress.test.ts` (phase entry, the
throttle, payload discipline, the one-frame relay shape), `src/harness.progress.test.ts`
(ordering, attempt boundaries, a reader that ignores it),
`src/server/turn-projector-progress.test.ts` (no node/step/block, coalescing, the four
clears, live-vs-reload parity), `src/server/journal-progress.test.ts` (verbatim round trip,
order, projection parity apart from the field).

---


## harness

```ts
const writer = harness({
    agents: { writer: agent({...}), researcher: agent({...}) },
    tools: { search: tool({...}) },
    report: { progress: async (event) => {} }
});

await writer('tell me about new year');
```

- **Callable.** `writer(input)` runs the entry agent to completion. With concurrent
  tools that also means it drains: it resolves only after the response is complete
  AND every pending call — delegated child runs included — has finished.
- **A thread has no wall-clock limit (policy 2026-11-09).** A conversation — a
  delegated child, a `threadFork` branch, a host thread, a steered turn — stops when
  its agent produces its final answer, and nothing external ends it on a clock. The
  one path that ever had a timer, `delegate`, now treats `timeoutMs` as an OPTIONAL,
  caller-set bound whose default is "no limit": set one when you believe a limit is
  warranted (a model may ask for 1..3600000 ms; the unvalidated host path
  `harness.runtime.delegate` may pass any finite bound and is not clamped), and on
  expiry the child returns the structured `status: "cancelled"` envelope with
  `partialContent` and `cancelledAtMessage`. ADDED 2026-11-13: `threadFork` now
  accepts the same OPTIONAL caller-set `timeoutMs` (1..3600000 ms —
  `MODEL_TIMEOUT_MAX_MS` is the shared ceiling), the unbounded default resolving
  through the `threadForkTimeoutMs` configuration to `FORK_TIMEOUT_MS`
  (`Number.POSITIVE_INFINITY`); nothing arms a timer when neither names one.
  CORRECTED IN PLACE: this default used to
  be a finite 300000 ms (5 minutes) inherited from the T28 hole where a child that ran
  `sleep 600` sat `running` forever — the mechanism survives, the finite default does
  not (`core/agent-limits.ts` `DELEGATE_TIMEOUT_MS` is now `Number.POSITIVE_INFINITY`,
  and `src/harness.delegation.test.ts` pins both halves). Consequences a reader must
  accept: a stuck child is abandoned by an explicit `toolCancel` on its pending
  `callId` (named in the `status: "pending"` placeholder), and that release does not
  discard the outcome — the child's terminal envelope still arrives as the call's own
  tool message, marked `callCancelled: true` (see [Delegation](#delegation)); a
  `writer(input)` whose
  child never settles never resolves — that is the drain contract above working as
  specified, not a bug. What DOES bound a long run: every tool's own timeout (below),
  the OPTIONAL `maxIterations` REQUEST COUNT (`DEFAULT_MAX_ITERATIONS` is
  `Infinity` — no limit unless a host names one), `delegate`'s per-child `maxTurns`
  bound (a `min(maxIterations, maxTurns)` a caller can only LOWER, see
  [Delegation](#delegation)), the rank-bounded run-nesting ceiling (`runDepthCeiling`,
  the thread/branch/record caps, and — ADDED 2026-11-09 when the plugin-pipeline
  user-facing lists landed — a `turn.before` plugin's `stop` decision
  (`HarnessTurnDecision`, `docs/plugins.md`): a policy assertion by shipped code at
  a turn boundary, not a clock, and it ends the run through the run's own abort path
  (`stopped` record, `cancelled` invocation). The run's appended work is RETAINED
  (IT19 R1, 2026-11-15 — `runAgentCore`'s catch no longer splices a conversation's turns; a
  forked BRANCH run still splices, because it owns no thread state of its own) and the record
  says WHY it halted (`stopReason`, R3). Whether an AGENT may continue a stopped conversation
  now follows that reason, and the set of reasons that allow it is CLOSED and kept in ONE
  table — `RESUMMABLE_RUN_STOP_REASONS` (`src/harness.ts`): `caller-released`, `timeout`,
  `turn-cap`, `budget-exhausted`, `api-error`, `retries-exhausted`, `provider-network`,
  `parent-closed`. A run cut short for one of those takes an agent
  `threadSend`, which reports `"resumed"`; a thread the HOST stopped (`user-stopped`), one a
  plugin parked (`plugin-parked`), and one stopped with no recorded cause stay host-only — a
  host `sendThreadInput` revives those, and it revives the others too. An INACTIVE (deleted)
  conversation takes no MESSAGE from an agent — `threadSend` and `steerThread` refuse it ahead of any
  status branch, because a model cannot address what the roster no longer names — but a HOST
  `sendThreadInput` IS the revival the spec reserves to the host: it lifts `inactive` / `inactiveAt`
  and runs the turn (`src/harness.ts` `sendThreadInput`; the server's `reactivateThreadRow` plus the
  `resumeThread` route drive it). So "host-reviveable" covers reads, restores AND an explicit host
  turn; only the SESSION being deleted takes the thread away.
  - **`provider-network` (2026-11-17) names a NETWORK death instead of a refusal**
    (`HarnessRunStopReason`, `src/types/index.ts`; produced by `classifyRunStopReason`,
    `src/harness.ts`; accepted on restore by `HARNESS_RUN_STOP_REASONS`,
    `src/core/snapshot.ts`, which is the READER half of the union — a new member must join
    that table in the same change that adds its producer, or a document carrying it is
    refused). The classifier runs AFTER the abort/stamp rules (an abort is an ACTOR, a
    network failure is a CAUSE, and an aborted run's cause is the actor that stopped it) and
    BEFORE the exhausted-ladder rule, and answers `provider-network` when, and only when, one
    of these holds: **(1)** the failure's machine `code` is `provider-timeout` (a bound
    expired, or the provider reported a timeout on the stream) or `provider-connection`
    (nothing answered the dial) — network-class BY CLASS, whether or not a retry was spent,
    which is the whole point, since the reported defect died with ZERO `retry` frames and
    would otherwise have persisted as `api-error`; or **(2)** the failure is CODELESS and the
    transport diagnosed the dying bytes as `provider-transit` (`details.errorClass`, read
    through the SAME `providerDiagnosticsOf` the `retry` frame uses).
    - **THE `sawRetryFrame` REQUIREMENT IS GONE (2026-11-17, accepted explicitly).** Rule (2)
      used to ALSO demand that the run had spent at least one retry (`RunState.sawRetryFrame`),
      so a transit failure on the FIRST attempt stayed `api-error` — with no streak and no
      auto-resume. The proof was never the ladder: the transport's own `provider-transit`
      diagnosis says the bytes died in the WIRE rather than in the request, so a transit death
      that spent ZERO retries now raises the consecutive-failure streak and auto-resumes like any
      other network class (`src/harness.ts` `classifyRunStopReason`;
      `src/harness.provider-network-stop.test.ts`).
    - **THE ACCEPTED OVER-TRIGGER — written out because it reads like a bug and is not.** What
      lands on the codeless `provider-transit` class is decided by the TRANSPORT, and it is wider
      than "the network died": a gateway mid-stream frame whose code is `decode`, `unknown`,
      absent, or `upstream_status` carrying a status that is NOT a refusal — which is exactly
      408 / 429 / any 5xx, 504 included, because `isTerminalProviderStatus` names only
      400/401/403/404 (`isTerminalProviderStatus` `src/transport/provider-timeouts.ts:510`, rationale
      `:590-597`) — plus any body that closed
      without reporting a completion (`src/transport/openai.ts`, the truncation guard). Each of
      those is CODELESS **with** the transit diagnosis, so each is a `provider-network` death,
      raises the streak, and can therefore consume the WHOLE resume ceiling on an endpoint that is
      merely truncated or merely rate limiting its own upstream. That is the accepted trade: the
      reported failure mode was a network death answering `api-error` and never resuming at all,
      and the ceiling bounds what the over-trigger can cost.
    - **What still isolates a NON-network failure**: the failure must be codeless **and** carry the
      transit diagnosis — an HTTP 4xx/5xx RESPONSE BODY, a malformed stream frame and a
      schema/validation throw carry no such class — so `retries-exhausted` still means "a
      NON-network ladder ran out" and `api-error` still means a genuine first-attempt failure, and
      a user stop / turn cap / plugin park stays an ACTOR.
    WHY the member exists at all: the session layer has to
    answer "is this conversation interrupted because the endpoint is unhealthy, or because
    the request itself was refused?" before it counts consecutive network failures against a
    threshold (see the auto-recovery note under [CLI, server, and UI](#cli-server-and-ui)),
    and neither `api-error` nor `retries-exhausted` is safe to branch on. **The restart
    policy is NOT moved by this member**: such a run is still marked interrupted and never
    replayed automatically — the difference is only that a caller can tell WHY from a field.
    Its membership in the resumable set is about a PEER'S `threadSend`, not about
    auto-recovery: the turns are retained, and a message is a legitimate way to put the
    conversation back to work.
- **Concurrency lives in the runtime, not in the provider stream.** Each agent has
  one serialized model stream; its tool calls are async work scheduled together.
  An agent's `done` event is one RESPONSE: it may list `pending` calls still running
  and the agent is woken (`wakeup`) when outcomes land. A periodic wake
  (**600000 ms** default) keeps a hung call visible so it can be killed — for `async` work
  only: the `async-ping` plugin arms it only while at least one pending call resolves to
  `mode: 'async'` (`src/plugins/async-ping.plugin.ts`), because a `sync` group re-enters the
  run itself when its last member settles, so a `sync`-only park is never pinged; there is
  **no automatic hard tool timeout**. Pending work is interrupted, not resumed,
  across a restart, and a hung call ends only through an explicit cancel (or the
  tool's own configured timeout). The same sentence holds for a whole THREAD since
  2026-11-09 (the bullet above), so "no automatic hard timeout" is now the rule at
  both levels, with the tool clocks the load-bearing defence; the wake covers a
  delegated child too (its own actor is pinged and its own inspecting turn declares
  `toolCancel` — `src/harness.delegation.test.ts`, policy doc T8).
- **Ordering is completion order.** Concurrent calls can interleave side effects
  (two writes/commands), and results are appended as they settle rather than in
  call order. Tools are async promises in ONE Node process: there are no OS worker
  threads and no CPU isolation, so CPU-bound JavaScript blocks the event loop. (A
  server-hosted session may opt out per deployment with
  `threadExecution: 'worker'`; see [Lane workers](#lane-workers-threadexecution-worker),
  and `ioExecution: 'worker'` for that deployment's durability writes — see
  [IO workers](#io-workers-ioexecution-worker).)
- **The entry agent is explicit or first.** `entry` names it; without one, the
  first `agents` key wins, so a single-agent config needs nothing. An unknown name
  throws at construction. `harness.name` and `handle.agent` are GETTERS over the CURRENT effective
  entry — the agent `entry` names while it is REGISTERED, else the FIRST CURRENTLY-registered
  member, the same rule `entry` itself defaults to — so a detached entry agent is never what the
  handle reports (`src/harness.ts:17210` / `:17220`, one rule behind both: `effectiveEntryName`
  `:16855`, `effectiveEntryAgent` `:16863`); `run()` still REFUSES on a detached entry rather than
  re-routing onto the fallback brain. Being the entry is ROUTING, not authority: the entry agent's
  rank comes from `ranks` exactly like every other member's. A HOST DOOR is a SEPARATE rule and
  does NOT follow that fallback: every host call acts as `hostActor()` (`:1669`) — the live entry
  agent while it is registered, then an unregistered identity literally named `host` pinned to Rank
  A (`hostRank`, `:1637`) — so the host holds no rank of its own, gains the top of the ladder the
  moment the entry is detached (which is what keeps every member reachable downward), and a host
  refusal names `host`, never the departed agent and never the fallback member.
- **`ranks` is the authority map.** `agentName → 'A'…'Z'`, with the resolution rules and the
  exact refusals in [Delegation](#delegation); there is NO `subagents` allowlist any more, and
  no `harness.subagents` member — `harness.ranks` is the resolved map. A roster spanning one
  distinct rank has no `delegate` tool. See [Delegation](#delegation).
- The registry key is the identity for both agents and tools; `agent.name` /
  `tool.name` are overwritten to match.
- **Tool declarations are filtered, not the registry.** `writer.tools` holds the
  preset preload, the configured tools, the record-engine wrappers (`tasks`,
  `records`, `profiles`, `chapters`, `locations`), `toolRequest`, `toolList`,
  `toolManage`, `toolRegistry`, `toolCreate`, `toolCancel`,
  `agentManage`, `agentResult`, the thread surface
  (`threadList`/`threadRead`/`threadSend`/`threadDelete`), `threadFork` when forks are
  enabled, `actionRequest` when interaction is configured, and `delegate` when the roster spans
  two or more distinct ranks; a request declares every core tool
  (`read`/`write`/`edit`/`glob`/`grep`, the environment `search`/`fetch` pair it
  actually registered, and the declared harness-owned set), then whatever the enabled set
  carries — what `toolRequest` switched on, or what an `enableAllTools` seed put there. The
  searchable remainder (`files`, `shell`, `download`, ...) waits for
  discovery. `delegate` is core for every agent of such a roster, with its declaration
  projected onto that caller's own lower-ranked targets, and `toolCreate` is declared only while
  the `toolCreation` policy admits the caller's rank — nothing else is withheld by rank.
  (CORRECTED IN PLACE 2026-11-11: the old list named the dead
  `task`/`profileManage`/`chapterManage`/`locationManage` names — Decision J renamed
  the tools to the plurals and the records engine added `records`.)
- **`discoveredTools`** is a read-only copy of the CAPPED (searchable) enabled set, in discovery
  order.
  It persists for the harness's lifetime (every call/turn) and is emptied by
  `reset()`; a server snapshot records it so a reload can show it. A harness built with
  `enableAllTools` starts from a populated set instead of an empty one (see below). What it can
  never state is this conversation's SWITCHES: a core or pending-only name holds no slot, so
  neither its being ON nor its being OFF is a fact this list can carry — that is the sibling
  read's job.
- **`withheldTools`** — ADDED 2026-11-13 with the session switch — the sorted, copied read of the
  names THIS conversation has switched off for its agents (`src/types/index.ts`
  `Harness.withheldTools` → `src/harness.ts`). It is the ONLY record of such a switch for a
  `visibility: 'core'` or pending-only name, and it is independent of `discoveredTools` by
  construction: a disable frees a searchable name's slot in the same step (`applyToolSwitch`),
  and a core name never had one. A getter that copies, so a caller can neither mutate the live
  Set through the handle nor see an intermediate order. `reset()` clears it, and the snapshot's
  `discovery.withheld` is what a restart restores it from. What a name in it does NOT stop:
  `harness.executeTool` (the manual/REST execution routes) and `context.callTool` (a tool calling
  a tool) keep reaching a registered name whatever this list says — the switch gates the agents
  of this conversation, never the implementation.
- **`isToolSwitchable(name)`** — ADDED 2026-11-13 — the kernel's own yes/no on whether THIS
  harness gives a name a SEARCHABLE CAP SLOT (`src/types/index.ts` `Harness.isToolSwitchable` →
  `src/harness.ts`, a bare forward onto `occupiesSearchableSlot`).
  The re-seed seam beside it — `Harness.enableAllSwitchableTools` (`src/types/index.ts` →
  `src/harness.ts`) — is the other half of the SAME cap story: which names may hold a slot, and
  the one pass that fills every slot the conversation has not switched off.
  CORRECTED IN PLACE 2026-11-13: this bullet used to read as if it answered "may a caller switch
  this name at all", and to call itself the exact negation of `protected` on the server's
  session-tool rows. Both moved with the withheld set: `toolManage enable|disable`, the plugin
  seam and the operator's PATCH now accept EVERY registered name — the core declarations and the
  pending-only `toolCancel` included — and `protected` states only the kernel's `remove` rule
  (`src/server/api-reads.ts` `sessionToolRowsOf`). `false` here means "no cap slot", and covers
  three cases identically: an unregistered name, a `visibility: 'core'` declaration, and a
  pending-only runtime control (`toolCancel` is demoted to `'searchable'` at registration,
  `src/harness.ts`, yet stays pending-only). Read at
  call time, so a tool registered after construction holds a slot the moment it exists and a
  removed one does not. A host that wants "which names has this conversation switched off" reads
  `withheldTools` above, not this.
- **`executeTool(name, parameters)`** (R8) runs one REGISTERED tool directly with
  this harness's context (`agent: hostActor()`, `agents`, `run` — an explicit host call acts as
  THE HOST, which is the session's ENTRY agent while that agent is registered and the Rank A `host`
  identity once `removeAgent` detaches it, so its rank is the entry's standing or Rank A, never a
  stale rank pinned to a departed name: `src/harness.ts:16380`, `hostActor` `:1669`, `hostRank`
  `:1637`).
  It is the server's
  manual-execution path for the session-bound tools (`POST /tools/:name` with a
  `sessionId`), so a manual toolRequest/toolCreate/tasks/records/profiles/chapters/
  locations/agentManage/agentResult/delegate call mutates
  this session. Core file tools and search are ordinary direct-call catalogue
  entries and do not need a session. Discovery gates the MODEL only: an explicit
  operator call may run a searchable tool that was never enabled. Nothing else is bypassed — `toolCreate` keeps its guarded
  registration, `delegate` keeps its rank check (the delegation runs with the HOST's standing —
  the entry agent's rank while it is registered, Rank A after `removeAgent` detaches it, and the
  refusal names `host` in that second state — so a Rank A target of a Rank A entry is refused), and
  a name this harness
  did not register (delegate in a single-rank roster) throws instead of inventing an
  implementation. `actionRequest` and `threadFork` are refused explicitly: both
  need the owning run (`requires the harness run that owns the conversation`).
  No progress events are emitted: a manual call is not a turn.
- `forks` resolves to `{ enabled, maxDepth, maxConcurrent, maxHistoryBytes,
  maxBranchRecords }` with defaults `true, 2, 4, 8 MiB, 64`; `enabled: true`
  registers `threadFork`. `interaction` presence registers `actionRequest`;
  `autoAnswer` defaults true and only controls a child/fork request's owner fork.
  See [Owner questions and history forks](#owner-questions-and-history-forks).
- `branches()` / `branch(id)` expose DETACHED branch audit records. They are
  ephemeral: branch records, active slots, and pending action requests are not in
  `snapshot()`/`restore()` (N3). `branches()` prunes to `maxBranchRecords`, keeping
  every running record and the newest terminal ones.
- `presets` (default `true`) preloads `presetTools` into the registry. `false`
  starts from `tools` alone. A configured tool wins on a name collision.
- `plugins` remains as an optional programmatic extension point
  (`createAgent`, `addTool`, `addCommand`). It is not part of the declarative config shape, and
  a plugin-added tool is searchable like any other. The reserved names stay
  reserved for plugins too, while a plugin-added COMMAND replaces by name (see
  [Slash commands](#slash-commands)).
- `commands` is the declarative slash-command list
  (`{ name, description, usage?, execute }`). It installs after the built-ins, so a
  name that collides with one — or repeats inside the list — fails construction;
  plugins and `registerCommand` run later and override by name.
  See [Slash commands](#slash-commands).
- `reset()` clears the entry agent's conversation, the discovered-tool set, the ONE
  session store (every collection with its entries, the shared id counter, each
  collection's `storeRev` and change window — the reset lives in the ENGINE,
  `src/core/records.ts`, reached as `recordEngine.reset()` at `src/harness.ts:17155`;
  `src/core/task.ts` has no `reset()` of its own), and the agent-result archive, so a
  reset run starts from the core set and empty session state. The terminal result
  archive is otherwise durable through snapshot/restore (see
  [Agent results](#agent-results-r3)).
  Created tools stay registered (registry state), just no longer enabled — the
  lifetime `maxCreatedTools` budget is NOT restored either. The
  server resets every agent in a session, not only the entry agent; its extra
  agent-loop reset does not replace `harness.reset()`, which is what clears the
  shared store. Branch records and action-request state are
  ephemeral runtime state and are not cleared by `reset()`.

**Configuration fields this section did not already cover** (every line anchor is
`src/types/index.ts`, the `HarnessConfiguration` type):

- `maxIterations` (`:3104`) — the OPTIONAL REQUEST-COUNT bound on one run. Unset
  means NO LIMIT: `DEFAULT_MAX_ITERATIONS` is `Infinity` (`src/harness.ts`), and the
  shipped presets carry one either (`PRESET_MAX_ITERATIONS` is `Infinity` —
  `src/server/harnesses/toolbox.ts`). A finite value must be a positive safe
  integer; `Infinity` is accepted explicitly. On exhaustion the pending work is
  aborted and the transcript is RETAINED (IT19 R1), and the record carries
  `stopReason: 'turn-cap'` so a reader can tell a capped run from a host stop — and an agent
  may send to it again, because a cap is a reason the run was cut short.
- `threadForkTimeoutMs` — ADDED 2026-11-13 (B1; declared on `HarnessConfiguration`
  beside `maxIterations`): the DEFAULT wall clock for a `threadFork` branch when the
  caller does not name one, and it therefore covers the `threadFork` TOOL as well.
  `src/harness.ts:11725-11727` calls `resolveForkTimeoutMs(parameters.timeoutMs,
  threadForkTimeoutMs)` on the MODEL path too, so an OMITTED tool `timeoutMs` falls
  through to this configuration — `thread.forkThread()`, `api.threads.fork()` and
  `runtime.threadFork` resolve the same way, and every fork door takes the same
  default. Only an EXPLICIT tool value wins over it. (The sentence this bullet used
  to carry — "the `threadFork` TOOL passes its own schema value, so this is the
  host's backstop for every other fork door" — contradicted the `threadFork`
  section's own correct reading above.) Unset
  means NO LIMIT (`FORK_TIMEOUT_MS`, `core/agent-limits.ts`), the same policy the
  delegate default follows; a finite value arms a timer, which is how a host lets a
  stuck branch release its concurrency slot without waiting for `toolCancel`.
- `toolCreation` (`src/types/index.ts:4766-4786`) — who may create tools at runtime (R12):
  `'all'` (default), `false` (no model-facing `toolCreate` at all), or a RANK LETTER meaning that
  rank and every rank TOWARD A — `'A'` is the faithful replacement for the removed `'primary'`
  policy and `'C'` admits A, B and C. A gated agent neither sees nor calls `toolCreate`
  (`Tool creation is limited to Rank A and above in this harness; "helper" holds Rank B.`); the
  host path `harness.toolCreate()` still works, because an operator action is not a model
  privilege. A letter outside the union fails construction, naming the whole accepted set.
  **This is the only rank-shaped capability gate left in the package.**
- `wakeIntervalMs` (`:3130`) — how often a run with ASYNC background calls emits `wakeup`
  (the 600000 ms default is stated above, and the async-only trigger rule with it); a
  `pluginSettings` value for `async-ping.intervalMs` wins over it.
- `maxCreatedTools` (`:3139`) — the LIFETIME creation budget for this instance.
  Created tools outlive `reset()`, so `reset()` deliberately does not refill it.
- `toolSources` (`:3158`) — `name → source text` for tools compiled at startup. A
  source with virtual dependencies needs `harness.registerTool({ moduleText,
  dependencies })` instead.
- `toolFolders` (`:3170`) — ordered external folders of editable `*.tool.ts` modules;
  `toolManage` disk writes are fenced to them, and source compilation is Node-only.
- `maxEnabledTools` (`src/types/index.ts`) — the bound on how many SEARCHABLE tools may
  be enabled at once (default 32); core tools are declared unless this conversation has switched
  them off, and never count against the cap. It binds
  the seed below just as it binds a `toolRequest` match.
- `enableAllTools` (`src/types/index.ts` `HarnessConfiguration.enableAllTools`) — ADDED
  2026-11-13 (R1). Opt-in
  full-toolbox SEED, off unless exactly `true`: at the end of startup, after every
  registration the configuration and the plugins made and before the handle exists, the
  harness runs ONE `enableTools` pass over its registered names (`src/harness.ts`
  `seedSwitchableTools`). Being the same path an ordinary `toolRequest` match takes,
  it inherits the kernel's rules rather than restating them: only slot-holding names land
  (`occupiesSearchableSlot` — a core declaration and a pending-only registration take no slot,
  and since the session switch that is a fact about CAP MATH, not about being switchable), names
  the host's global tool provider has disabled are filtered out first (`isToolGloballyDisabled`),
  names THIS conversation has switched off are filtered out by that same pass (`isToolWithheld` —
  an auto-enable never overwrites a user's switch; without it a reset re-run, a restore, or a
  plugin calling the seam would hand back every name they turned off), and `maxEnabledTools` caps
  the result, leaving the
  overflow off rather than throwing. It emits no `stateChange` and is NOT snapshot state: the
  KERNEL's `reset()` empties the set like any other enabled name and clears the conversation's
  withheld set beside it, so a reset conversation starts with every name ON, and the handle seam
  `Harness.enableAllSwitchableTools` (`src/types/index.ts` → `src/harness.ts`) is what lets a
  host re-run the pass on a live harness. A
  library consumer that does not pass it keeps an empty enabled set; the shipped server passes
  it for a session it CREATES (`src/server/sessions.ts:2204`) and for a session it RESTORES
  (`:3843`), and RE-RUNS the pass on a session
  it RESETS (`SessionStore.reset`, so a reset conversation starts exactly like a new one — pinned by
  `src/server/session-reset-toolbox.test.ts`). The restore build carries the flag so that re-run
  works after a restart; `restore()` overwrites the enabled set it seeds
  (`src/harness.ts` `restore()`), so a restart on its own still changes no switch state. The one
  session that resets to an empty toolbox is one whose preset factory withholds the seed from
  `HarnessConfiguration` (`src/server/session-reset-toolbox.test.ts`) — the shipped catalogue
  forwards it, a library caller and the CLI never receive the report.
- `report.stateChange` (`:3216`) — the persistence observer (R3a): synchronous,
  advisory, runs after a snapshot-recorded mutation, and its errors are ignored.
- `report.diagnostic` (`:3223`) — the plugin diagnostics channel (T1.5), the one place
  a BROKEN plugin becomes visible instead of looking like a plugin that did nothing.
- `pluginSettings` (`:3658`) — the host's read-only per-plugin settings provider
  (`<pluginName>.<key>`); absent means the library's own in-memory provider seeded from each
  plugin's declared defaults (`src/plugin/settings.ts:60`, installed per harness at
  `src/harness.ts:1687-1691`) — so the fallback's lifetime is ONE HARNESS, not the process.
  CORRECTED IN PLACE 2026-11-13: this bullet described the shipped server as if one provider
  covered every session. It no longer does — each session's harness is built with ITS OWN
  store's provider (`src/server/sessions.ts:2490`), while this config field keeps the same
  read-only contract. That provider is still `get`-only (`src/server/plugins.ts:439-441`),
  which is exactly why a plugin calling `api.settings.setOwn` on the shipped server gets the
  library's "read-only (no writer)" refusal (`src/plugin/settings.ts:329-333`).
- `toolSettings` (`:3673`) — the host's GLOBAL tool switch (R3): one live provider over
  the names this deployment disables for every session, core control plane included. The two
  settings surfaces are deliberately asymmetric: a plugin's knobs belong to the conversation
  that runs it, the deny list belongs to the deployment (`src/server/tool-settings.ts:1-2`).

**Members:** callable, `name`, `agent`, `agents`, `ranks` (the RESOLVED rank map, a getter over
the live roster, `src/types/index.ts:5017`), `tools`, `plugins`,
`discoveredTools`, `withheldTools` (the conversation's switch set, `src/types/index.ts`
`Harness.withheldTools`), `isToolSwitchable(name)` (`src/types/index.ts`, the CAP-SLOT
predicate),
`toolCreate(config)`, `registerTool(candidate)` (`src/types/index.ts:3292`),
`executeTool(name, parameters)`, `callTool(name, parameters, options)` (`:3306`, the
registry-resolving twin that keeps caller/thread/signal),
`toolSource(name)` (`:3298`) / `toolSources()` (`:3300`),
`commands`, `executeCommand(input)`, `registerCommand(command)`, `branches()`,
`branch(id)`, `memory` (`:3313`), `runtime` (`:3316`), `nestedRuns()` (`:3590`),
`records()` / `recordsChanges(since)` / `onRecordsChange(listener)` (`:3441-3443`),
`reset()` — plus the thread surface (`threads()`, `thread(id, callerThreadId?)`,
`threadMessages(id, callerThreadId?)`, `setThreadMessages(id, messages)`,
`createThread()`, `sendThreadInput()`, `steerThread()`, `stopThread()`,
`deleteThread()` — the optional caller thread is what narrows a host read to one
family; omitted means the unscoped host view, and `deleteThread()` answers with the
same `{ deleted, removedThreadIds }` receipt the `threadDelete` tool reports) and
`snapshot()`/`restore()`.

### The loop

```
append user input
repeat:
    turn()                 -> assistant message (+ tool calls)
    no tool calls?         -> report done, return the message
    schedule each tool     -> concurrently (one async actor per call)
    results arrive         -> a tool message per settled call, in completion order
    (loop again, waking on pending outcomes)
```

Multi-tool turns are **scheduled concurrently**, not run one after another. The
model stream stays serialized per agent (one request at a time), and every call
still gets a matching `tool` message with the id the model used, so strict
providers never see a dangling `tool_calls` id. The harness promise resolves only
when the response is complete and all pending work (delegates included) drains.

The tool declarations sent with each `turn()` are the core set plus the ENABLED set —
the tools `toolRequest` has switched on, plus whatever an `enableAllTools` seed
installed at construction — that is how a discovery round changes the next request
without mutating the registry.

Recoverable failures become tool results the model can read:
- unknown tool → result listing the declared tools and pointing at toolRequest;
- undiscovered tool → result naming tags that would enable it (it does not run);
- malformed JSON arguments → result naming the parse failure (the tool is not
  executed). A call whose arguments parse but are **not a JSON object** (`[1,2]`,
  `42`, `"text"`, `null`) is rejected the same way: every tool is declared with an
  object schema, so nothing downstream can bind it. When the request stopped with
  `stopReason: 'length'`, the result also says the reply hit its output-token
  limit, because that is the usual cause — generation was cut off mid-JSON and the
  model needs to know the payload was truncated, not mistyped;
- throwing/rejecting tool (including a runtime-compiled module) → result with the
  error message. `throw undefined` / `Promise.reject(undefined)` are still
  failures: the scheduler records a `failed` flag independently of the payload.
  `toErrorInfo` also describes non-Error thrown values (`42`, a symbol, a plain
  object) and never throws while doing so;
- a tool that returns a result the harness cannot serialize → failed result naming
  the serialization error. The run continues and the other calls in the turn still
  deliver.
- a nested `context.callTool` or `context.run` failure propagates unchanged to an
  awaiting caller. A compiled tool that fires and forgets that promise cannot turn
  the failure into a process `unhandledRejection`; manual `executeTool` has the
  same observation while still rejecting for callers that await it. This covers the
  harness-issued promise only: a caller's own `.then(...)` chain without a
  rejection handler, a timer callback, or another detached async task is outside
  the harness boundary.
- arbitrary thrown values are classified with `isInstanceOf` (guarded
  `instanceof`) on server/harness catch paths. A hostile Proxy whose
  `getPrototypeOf` throws is reported as a normal tool error instead of escaping
  the catch; it is never misclassified as a `SessionError`/HTTP status.

Terminal failures truncate history to the pre-call length, emit `error`, and
throw:
- transport failure;
- more than **maxIterations** model requests without an answer — only when a host
  has opted into that OPTIONAL guard. Every request
  counts, including an immediate tool continuation, a pause turn, and every
  completion or timed wake. Defaults to **no limit**;
  `harness({ maxIterations })` arms it and is validated at construction
  as a positive safe integer or `Infinity`. The application presets leave it
  unarmed. The bound is per agent run,
  so a delegated child run gets its own budget.

Multi-tool turns are **scheduled concurrently**, and every call gets a matching
`tool` message so strict providers never see a dangling `tool_calls` id. The
agent's `done` is a response boundary, not a turn boundary: with concurrent calls
it may arrive while its own calls are still running (`pending`), and the runtime
wakes the agent (`wakeup`) as outcomes land. Cancellation signals every running
call (`toolCancel({ callId })` targets one): `toolCancel` logically settles/aborts
that call's own task and its late result is ignored; cancelling an already settled
(or already cancelled) call is a SUCCESS with `alreadySettled: true`, because
cancellation is a state to reach rather than a one-shot transition, while a
`callId` this run never started is an error. The ack is a CONTROL receipt
(`{ cancelled: true, callId, name }`) and not the result channel: for a released
`delegate` call the child's terminal envelope arrives in that call's OWN tool message,
tagged `callCancelled: true` — see [Delegation](#delegation). Command tools honour the abort
and kill their process tree, but arbitrary JavaScript cannot be preempted. The four filesystem tools
honour it as well and answer with a CODE, `ECANCELED` (`tools/files/cancellation.ts`): `read` before
every syscall, `write`/`edit` before each file (the write half sits inside the shared publish in
`tools/files/atomic-publish.ts`), `files` before every operation, `list` included. Before T14 only
`read` observed the signal at all, and it rejected with whatever the signal carried (measured: a
`DOMException` named `AbortError` whose `code` is the NUMBER 20, not a published member), while
`write`, `edit` and `files` ran their side effects and reported success. A
whole-run abort preempts an uncooperative provider request, releases the child
actor/restore slot and rolls back the cancelled turn's in-flight prompt state
immediately; a late provider commit is rejected by the core precommit check. A
provider socket/generator that never returns can remain in memory without blocking
the actor or re-delegation, but a host `report.progress` reporter that hangs can
still stall the mailbox and therefore cancellation (no guaranteed reporter
watchdog). Because calls share one Node process there is no thread or CPU
isolation, and side effects are ordered by completion rather than by call order.

---

## Slash commands

A slash line is an **operator action, never a prompt**: it runs in the process that
owns the session and costs no model request. The registry lives on the harness handle,
not in a front end, so the CLI, the HTTP server and the UI composer execute ONE
implementation per name — which is the invariant this whole layer exists to protect.

- **Grammar (`src/core/command.ts`, pure: no harness, no transport).**
  `parseCommandLine(text)` answers `undefined` for anything whose trimmed text does
  not start with `/` — that is how a host decides "prompt, not command" — and
  otherwise `{ name, args, rest, input }`. Only the NAME is case-folded: arguments
  keep the case typed, because task text and search queries are data. `tokenize` is
  the shell-ish minimum and the whole contract: whitespace separates, `"…"`/`'…'`
  group, `\` escapes one character inside and outside quotes, `""` is an EMPTY
  argument (not a missing one), an unmatched quote swallows the rest of the line
  instead of throwing (an operator is mid-edit in a REPL), and a trailing `\` keeps
  itself. `COMMAND_NAME_PATTERN` (`/^[a-z][a-z0-9-]{0,31}$/`) is checked at
  registration, so a registry key is always `/`-safe and lowercase — one canonical
  spelling per command, so `/Task` and `/task` can never disagree.
  `normalizeCommandName` (trim + optional leading slash + lowercase) is used by BOTH
  registration and lookup; `validateCommandName` throws for a bad key.
  `formatCommandHelp` renders the sorted, diffable `/help` body
  (`/name  description`, then an indented `usage:` line).
- **Result shape (`HarnessCommandResult`, `src/types/index.ts`).**
  `{ content, isError?, data? }`: displayable text, a recoverable-failure flag a host
  styles instead of parsing prose, and the structured value for a UI.
  `executeCommand` normalizes a missing `content` to `''` and emits the optional keys
  only when the command set them, so a host can spread the result safely.
- **Built-ins (`src/core/command-builtins.ts`, exported as
  `createBuiltinCommands()`).** `/help [command]`, `/tools [filter]`,
  `/task [list|add|complete|reopen|remove]` — the FIVE live verbs, exactly the `usage` string
  at `:265`. **Corrected in place (records-engine Decision P, 2026-11-11):** this list used to
  read ~~`[list|add|complete|reopen|remove|claim|release|takeover]`~~. Decision P
  deleted those three ownership verbs with the lock they served, so `/task claim 1` now falls
  through to `unknown action "<verb>".` (`:388`; the comment at `:380-386` says why). The
  eight-verb spelling is kept struck through so the deletion stays auditable, and
  [Session tasks](#session-tasks) carries the full history. `/websearch <query>`
  (the RAW tail is the query, so an exact phrase survives), `/webfetch <url>` (the FIRST
  token is the URL, so a trailing flag cannot corrupt it). The last three are
  **pass-throughs to the live tools** through
  `context.harness.executeTool('tasks' | 'search' | 'fetch', …)` (`TASK_TOOL_NAME`, `:95` —
  CORRECTED IN PLACE 2026-11-11: this line said `'task'`, which is the COMMAND name, not the
  tool it calls), so they mutate THIS
  harness's stores and inherit the tools' bounds (200 tasks, 4000 characters, 20/page by
  default; the fetch content-type gate) instead of duplicating them. Because
  `executeTool` always supplies an agent identity, `/task complete|reopen|remove` are
  GUARDED writes: the command reads the whole store first (`offset` paging at limit 100,
  bounded to 16 pages) and sends the `expects` revisions it read, so a concurrent edit
  surfaces as the tool's stale error. **Corrected in place (records-engine Decision P,
  2026-11-11):** this sentence used to end "`claim|release|takeover` send no token, and the
  command's own holder pair is `(entry agent, no thread)`" — those three verbs are deleted, so
  no `/task` write is token-less any more and there is no holder pair left to describe (see
  [Session tasks](#session-tasks)). `search`/`fetch` are conditional, so an unconfigured session
  answers guidance naming the configuration field and the key names rather than
  `Tool "search" is not registered`. Nothing in the built-ins throws: a usage
  mistake, an unregistered tool, or a rejected tool call returns
  `{ content, isError: true }`; `executeCommand` is the only thrower. Bodies share the
  model's 256 KiB budget (`MODEL_TOOL_RESULT_BUDGET_BYTES` — the "64 KiB" this line
  used to name was that constant's value before `core/result-budget.ts` raised it 4x)
  but append a plain
  `… truncated: …` marker (`capText`), because a command result is human-facing.
- **Ordering and asymmetric collisions (`src/harness.ts`).** built-ins →
  `configuration.commands` → plugins (`api.addCommand`) → runtime
  `harness.registerCommand`. The first two phases reject a duplicate name, because two
  declarative entries cannot both mean one name:
  `Command "/task" is already registered. Built-in commands and "commands" entries
  share one namespace and must be unique; use a plugin or harness.registerCommand()
  to override "/task".` The last two REPLACE by name, mirroring `addTool` /
  `registerTool` — overriding a built-in is the supported way to change one. All
  validation happens before the first mutation (a rejected candidate changes nothing,
  the same atomicity rule the tool kernel follows), and the installed record is a NEW
  frozen-shape object, so a caller cannot mutate a published command afterwards.
  `handle.commands` is a getter that copies AND freezes per read: live, but never
  writable through the copy.
- **Execution (`handle.executeCommand`).** Lookups are own-key on BOTH surfaces — the
  dispatcher and `/help <name>` — so a command named `constructor` is legal, an
  unregistered `toString` is not "found", and `/help toString` answers "unknown
  command" instead of inventing an entry. The model is never called and NO progress
  event is emitted (a command is not a
  conversation turn, so a host can run `/task` while a run is in flight); a built-in's
  tool call still fires `stateChange('tool_execute')`, which is what a persistence
  layer needs to see the mutation. Two failures are exceptions because they are host
  bugs rather than user input: a line without a leading `/`
  (`a command must start with "/"`) and an unknown name (`unknown command: /nope`,
  and `unknown command: /` for a bare slash). A host command's own throw is rethrown.
- **Server path (`src/server/sessions.ts`).** `dispatch()` is the ONE submit surface
  `POST /sessions/:id/tasks` calls, and it is the only splitter: non-command text goes
  to `enqueue()` **untouched** (before any local check, so the legacy "attachment error
  wins over an empty prompt" precedence survives), and a command line becomes
  `executeCommandTurn()` — a real `SessionTurn` with `start` + `tool_call`
  (`name: 'command'`, `arguments: '{"input":"<verbatim line>"}'`) + `tool_result`
  paired by `callId`, NO `text`/`usage`/`done` (nothing generated, nothing billed),
  status `done`/`error`, no `threadId`, and terminal BEFORE the `202` (so nothing
  entered a queue and `settled` resolves immediately). Commands skip the single-flight
  gate and the pending cap on purpose; `attachments`/`references` are a `400`
  (a command has no schema to bind media to) and `threadId` is accepted-and-ignored (a
  command acts on the SESSION, never on one conversation, so its turn never joins a
  lane and is never purged with a focused thread). `session.status`/`lastError` are
  untouched. An unknown name and any command throw become an **error turn**, never a
  `500`. Durability follows the enqueue rule twice: the running row is written before
  any work (a failed write means the command never happened, so the record rolls
  back), and the terminal record is written with `persistOrThrow` before the response
  — except for a disposed session or a closing store, where the save is skipped so a
  shutdown file is not overwritten with an empty session list. A host handle without
  `executeCommand` (built before this layer) falls back to `enqueue()`, which is
  exactly what that server did before. The legacy `/messages` route never treated `/`
  as a command: its SSE envelope predated the registry and had no terminal-turn frame —
  CORRECTED IN PLACE 2026-11-11: that route is DELETED (`src/server/api.ts:12-15`), so
  this sentence is history, not a live caveat.
- **CLI path (`src/server/cli/commands.ts`).** Everything except readline/stdout, so
  the REPL is testable from a plain object: the host injects a `CliCommandHost`
  (`harness`, `presets`, `write`, `writeError`, `reset`, `exit`, `printTools`,
  `printPresets`) and gets back "was this line a command?". The LOCAL set
  (`exit`, `quit`, `help`, `reset`, `tools`, `presets`) is checked FIRST and therefore
  SHADOWS the same-named built-ins — a terminal wants the direct-call tool catalogue
  with `.env`-aware availability hints and the REPL's own list — while `/help` still
  prints `harness commands:` rendered verbatim from `harness.commands`, because
  hiding the shadowed entries would make `/help` disagree with the registry. The line
  is forwarded to `executeCommand` verbatim (`parsed.input`), replacing the old
  whole-input `toLowerCase()` that destroyed task text and query case. `./index.ts`
  prints the live registry in the banner, serializes input (extra lines typed while a
  line is in flight are dropped, so a command and a run never overlap), and routes
  command output to stderr under `--json` where stdout carries the event stream. An
  unknown command prints the harness message plus
  `hint: /help lists the commands this session can run`; any other throw prints
  `command failed: <message>`.
- **The invariant: commands are server state, the UI is a renderer.** There is no
  client-side command table and no browser command parser. The composer submits `/…`
  text to `/tasks` like any other message, and the recorded command turn renders
  through the ordinary tool-card path (`src/frontend/ui/activity.ts` switches on
  `tool_call`/`tool_result`, `src/frontend/ui/tools.ts` `createToolCallCard`), so a
  reload replays it with zero special cases. Anything the UI knows how to run is what
  `harness.commands` reports, which is why `--json`/CLI/server/UI all print one list.

Tests: `src/core/command.test.ts` (grammar, name validation, help rendering),
`src/harness.commands.test.ts` (registry order, collisions, plugin/runtime override,
`executeCommand` contracts), `src/server/commands.test.ts` (the `/tasks` command turn,
watcher frames, restart replay, lane bypass, 400s),
`src/server/cli/commands.test.ts` (shadowing, `/help` both sections, stderr routing).

---

## openAICompatible

```ts
const stream = openAICompatible(
    {
        baseURL,                 // trailing slashes trimmed; /chat/completions appended
        apiKey,                  // string or () => string, resolved per request
        headers,                 // merged over generated headers
        sampling,                // temperature, top_p, max_tokens, presence/frequency_penalty
        extraBody,               // Record | (request) => Record — merged FIRST
        responseFormat           // 'text' | 'json' | { jsonSchema: { name, schema, strict? } }
    },
    { buildBody }                // (body, request) => body — the composable seam (issue 0001)
);
```

- Posts `{ model, stream: true, messages, tools?, ...sampling }` — byte-for-byte
  when none of the three seams below is used. `extraBody` is spread FIRST, so the
  first-class fields written after it always win; an `extraBody` `tools` key is
  REMOVED rather than outranked (a declared tool list is the harness's, and an
  out-of-band list produces calls with no implementation). `stream` is not
  overridable through `extraBody` at all: it decides what the reader parses.
- `extraBody` / `responseFormat` are validated at TRANSPORT CONSTRUCTION (a
  `HarnessError` with code `provider-request-body`, message naming the field):
  plain JSON object only, no `undefined`/function/symbol values, no cycles, and at
  most `MAX_EXTRA_BODY_BYTES` (8 KiB) serialized. A `responseFormat.jsonSchema.name`
  must match a gateway's `[a-zA-Z0-9_-]{1,MAX_RESPONSE_SCHEMA_NAME_CHARS}`. The
  function form is called once per request, AFTER the model/transcript/tools are
  resolved, and a rejected result is an `error` frame with nothing sent.
- `responseFormat` maps to `response_format`: `{ type: 'text' }`,
  `{ type: 'json_object' }`, or `{ type: 'json_schema', json_schema: { name, schema,
  strict? } }`. `strict` is omitted when unset, and a first-class
  `responseFormat` beats an `extraBody` key of the same name.
- `options.buildBody` receives that assembled body plus the request and returns the
  body to serialize — the seam that keeps message mapping, attachment parts, video
  policy, aborting, error scrubbing and this SSE reader reusable. Its result must be
  a plain JSON object (else an `error` frame), and serialization happens BEFORE
  fetch so a cycle is an honest body error rather than a fake network failure.
- Maps internal messages to the wire format: assistant `toolCalls` become
  `tool_calls[{ id, type: 'function', function: { name, arguments } }]`, and
  `role: 'tool'` becomes `{ role: 'tool', tool_call_id, content }`.
- `function.arguments` is normalized to a JSON **object** on the wire. A provider
  rejects a non-object or unparseable value with a bare
  `500 {"error":"Internal Server Error"}` for the whole request, so a tool call
  truncated by the output-token ceiling would otherwise fail every later request
  that replays it. The transcript keeps the raw text (it is what the model sent,
  and the UI shows it); only the payload is repaired, to `'{}'`.
- `reasoning` on an assistant message is **dropped** from the payload: local
  replay data, and several providers reject unknown message fields.
- Tool declarations default `parameters` to `{ type: 'object', properties: {} }`.
- Accumulates streamed tool-call fragments and reports complete calls on the terminal
  frame, ordered by slot. Partial arguments are never executed. CORRECTED IN PLACE
  2026-11-19: this line used to say only "by `index`", which was one quarter of the rule —
  four parallel calls arriving WITHOUT an `index` all fall into slot 0 and become one
  unresolvable call. CORRECTED AGAIN the same day (independent review): that sentence then
  called the shape "the cause of a real merge", and that claim is NOT evidenced — no capture
  in this workspace shows an index-less parallel block. The merge is a **test-demonstrated
  behaviour of the old code**: `name: 'alphabeta'` over `'{}{}'` is the LIVENESS-FIXTURE value
  asserted by `src/transport/openai.tool-call-liveness.test.ts:588` ("opens its own slot for
  an id-less-index provider reporting a SECOND id"), i.e. what the `index ?? 0` rule PRODUCES
  for that stream, not a string a live relay was ever observed to produce. The rule below is
  therefore stated as code behaviour pinned by tests, and nothing here should be read as a
  witnessed relay defect. The de-multiplexing rule is now ONE function, `slotForFragment`
  (`src/transport/openai.ts:979-1004`): a numeric `index` is authoritative → else an `id`
  this stream already uses → else an unseen `id` OPENS a slot one past the highest in use
  (flush order stays equal to the order the provider introduced them in) → else the slot
  last known to be streaming, which is `0` exactly when the provider never sent an index
  (the shape the old `?? 0` was written for). Pinned both directions by
  `src/transport/openai.tool-call-liveness.test.ts:265, 528, 561, 588`.
- A non-empty `function.name` fragment is APPENDED, and the ONLY drop is a fragment that is
  byte-identical to the name the slot already holds — an ECHO of the whole name, never a piece
  of it (`nameIsEcho`, `src/transport/openai.ts:1067-1072`, rationale comment `:1019-1066`).
  CORRECTED IN PLACE: the reader used to concatenate unconditionally, so a relay that REPEATS
  the full name on every delta of the block turned `delegate` into `delegatedelegate`; that
  name resolves to no tool and ONE unresolvable call fails the WHOLE multi-call block.
  CORRECTED AGAIN THE SAME DAY (review F2): the first version of the guard ALSO dropped every
  name once the slot had taken an argument byte — "a name fragment is appended only while that
  slot has taken no argument bytes, or is still unnamed" — and that clause was strictly broader
  than the echo: it regressed a shape the OpenAI schema permits, a name piece arriving AFTER the
  first argument byte (`name:'deleg'` → `arguments:'{"a":1}'` → `name:'ate'` flushed `deleg`,
  where concatenation gives `delegate` — the byte-exact value of `deleg` + `ate`). Pinned in
  every direction: pieces before any argument
  still concatenate, an echoed full name is ignored, a late name on an unnamed slot is taken,
  and an interleaved piece concatenates
  (`src/transport/openai.tool-call-liveness.test.ts:304, 333, 371, 400`). RESIDUAL RISK, stated
  rather than hidden: a relay that re-sends a NAME PREFIX (`delegate`, later `deleg`) is not an
  echo by this test and becomes `delegatedeleg`; HEAD's unconditional append produced the same
  value from the same stream, so nothing that worked before breaks, and any rule strong enough
  to catch it must guess whether a repeated prefix is a prefix or the next piece of a longer
  legitimate name. Pinned as a fact on disk at
  `src/harness.tool-composition-review.test.ts` ("RESIDUAL RISK: a relay that re-sends a PREFIX
  of the name is not an echo"). DEFENSIVE, NOT OBSERVED: no capture in this workspace shows a
  name-echoing relay (`Temp/d1/session/events.jsonl` carries clean `call_*` ids and predates the
  change), and the stalled session emitted no tool-call frame at all, so it can neither confirm
  nor refute the shape.
- A tool call the provider left anonymous gets a MINTED id — `harness-call-<slot>`, with a
  collision bump so it can never duplicate an id the provider really sent
  (`SYNTHETIC_TOOL_CALL_ID_PREFIX` `src/transport/openai.ts:1093`, minted in
  `finishToolCalls` `:1129-1155`). It is not cosmetic: replay pairs a `tool` result with
  its call BY id (`tool_call_id`, `src/transport/openai.ts:452`), so the old `id: ''`
  made several parallel calls unpairable, and the same string lands on BOTH sides of the
  pair because both are built from this one object (`src/core/agent.ts:1505` commits
  `outcome.toolCalls` verbatim; `src/harness.ts:9798` stamps `toolCallId: call.id`).
  Pinned at `:791, 810, 873` of the liveness test ("mints a distinct id per anonymous
call", "replays the SAME minted id on both sides of the pair", "never mints an id that duplicates
one the provider really sent"). Also defensive:
  no observed relay omitted the id.
- A provider that reports tool calls without `finish_reason` is treated as a
  tool turn (`stopReason: 'tool_calls'`).
- A body that closes WITHOUT the `[DONE]` sentinel and without a `finish_reason` is a
  truncated generation and FAILS the request (the `provider-transit` error below) — UNLESS
  every accumulated slot's arguments parse to a plain JSON OBJECT, which is a COMPLETE tool
  round and is flushed as `done` / `stopReason: 'tool_calls'` (`completeToolRound`
  `src/transport/openai.ts:2083`, gated on the same `isPlainJsonObject` the outbound wire
  uses, `:317-333`). CORRECTED IN PLACE 2026-11-19: the reader used to DISCARD a fully
  generated block in that case — the engine family at the end of this workspace's relay leg
  withholds the whole tool region and flushes one final frame
  (`services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100, 993-1003`), so
  "no `[DONE]`" and "fully generated" are compatible facts — and the discarded error was
  CODELESS, which walks the generic 11-attempt ladder: up to TEN full re-generations of the
  same ~60 s block, the loop the user watched. A half-written `arguments` string still fails
  the guard (`:432, 457` of the liveness test), and a no-argument call streamed as
  `arguments: ''` keeps its old retry because `''` is not a JSON object — the transport
  cannot tell "no arguments" from "cut before the first byte", conservative on purpose.
  **The disclosed trade-off:** a socket cut *between two complete calls* now launches the
  partial set instead of retrying the block.
- Does **not** send `stream_options` BY DEFAULT — several gateways reject unknown
  request fields. Usage is parsed when a provider volunteers it. A host that needs
  the opt-in asks for it per agent:
  `provider.extraBody: { stream_options: { include_usage: true } }`.
- Reads reasoning from `delta.reasoning_content` (DeepSeek-compatible) or
  `delta.reasoning`.
- Ignores non-`data:` lines (`event:`, `id:`, `:` comments). Stops at `[DONE]`.
  Flushes a final frame that arrived without a newline.
- Failures become `error` events: non-2xx (`HTTP <status>: <body>`), a
  `chunk.error` on a 200 stream, a malformed frame, a TRUNCATED stream (a body that
  closes without `[DONE]` and without a `finish_reason`) **unless that body was a complete
  tool round — see the `completeToolRound` bullet above**, or a connection failure.
  The agent retries whatever its class allows (see "agent" — R1 and the three
  ladders); the transport itself never retries, so there is exactly one retry owner.
  A `progress` frame never follows the terminal frame: the emission site sits inside the
  data-frame loop, so `done`, `error` and every early `return` are unreachable behind it
  (`src/transport/openai.ts:1959-1990`, pinned at
  `src/transport/openai.tool-call-progress.test.ts:185, 293`).
- **A gateway error frame is read STRUCTURALLY (2026-11-17).** A proxy in front of
  another provider does not fail the HTTP request when ITS upstream dies: it answers
  200, streams a while, and attaches `{"error":{"code":…,"status":…,"errno":…}}` to
  one SSE frame. This reader used to take `error.message` and drop the rest, so every
  mid-stream provider failure reached `agent()` codeless. `providerWireFailureOf`
  (`src/transport/provider-timeouts.ts`) is now the ONE translator between the
  gateway's vocabulary and ours, so a provider-side change lands in one function:
  `timeout` → `provider-timeout` (the bounded timeout ladder, `phase: 'stream-chunk'`
  because an in-stream frame can only mean the stream was open), `connection` →
  `provider-connection` (the short 3-attempt dial ladder), `aborted` →
  `provider-aborted` (never re-sent), `upstream_status` → `provider-rejected` ONLY
  when the frame carries a usable status AND `isTerminalProviderStatus` names it
  (400/401/403/404 — a refusal must be OUR request's fault, so the producer's 408 /
  429 / 5xx answers, a 504 included, stay codeless), and `decode` / `unknown` / an
  absent or unrecognised code → **codeless**, the generic transient ladder, unchanged
  on purpose. Nothing classifies on the MESSAGE: the producer's prose is
  endpoint-specific, and the legacy `Upstream stream terminated` /
  `Provider reported an error` sentences stay byte-identical for the codeless case, so
  a scripted provider error is retried exactly as `src/core/agent.retry.test.ts`
  pins it. The reading is total (`null`, a string, or a frame whose fields are objects
  all answer), keys are never tested with `in`, and "absent", `null` and `undefined`
  are the same answer, because a frame with NO `code` is legal input and keeps the
  codeless ladder (that shape is pinned in `src/transport/openai.provider-wire-codes.test.ts`
  and `src/transport/openai.test.ts`). That vocabulary now has TWO producers — the primary
  gateway (`packages/underload/service/src/server/start.ts`) and a second SSE writer
  (`repository/agentic/src/server/start-server.ts`, an INLINED copy of the same classifier
  and payload builder, called out at its `start-server.ts:275-292` and pinned by its own
  `start-server-stream-error.test.ts`) — both emitting the same six codes, the same frame
  keys in the same insertion order and the same legacy `unknown` sentence, so a codeless
  frame is a build that predates the coded envelope rather than a different gateway. A coded
  frame leads with its code and names the endpoint, the status, what happens next and
  the provider's own quoted line (`providerWireMessage`, bounded like the other coded
  messages, with the OpenAI `param` the provider blamed quoted when it named one).
- **Diagnostics ride on every classified frame.** Each such `error` carries
  `details` (`errorClass`, redacted `url`, effective `port`, and `phase` / `errno`
  when the class has them) and, when the wire code resolved to one, `code` — the
  frozen `HarnessProviderAttemptDiagnostics` shape, published from the ONE reader
  `providerDiagnosticsOf`, which both the agent's `retry` frames and the harness's
  TERMINAL `error` record use, so the two can never disagree. The
  DIAGNOSTICS-ONLY class `provider-transit` (`PROVIDER_TRANSIT_CLASS`) covers a
  codeless network death — a codeless gateway frame, and the truncated stream above —
  where the retry policy stays generic but the diagnosis is still a fact a consumer
  reads from a field; it is a `details.errorClass` value and a stop-reason
  discriminator, NEVER a published `error.code`, because a code promises a retry
  policy. `timeoutMs` is deliberately OMITTED when the provider reported the timeout:
  no local bound expired, so quoting one would invent it.

---

## listModels

```ts
import { listModels, ModelListError } from '@underload/harness';

const ids = await listModels({ baseURL, apiKey, headers?, signal? });
```

- `GET {baseURL}/models`, same URL rules as `openAICompatible`: trim, absolute,
  http(s) only, trailing slashes removed before `/models` is appended.
- Accepts `{ object: 'list', data: [{ id }] }` and a bare array. Ids are trimmed,
  empty values dropped, duplicates removed **in provider order** (a dropdown
  should not reshuffle the provider's preference). A non-string `id` is ignored.
- Resolves `[]` when the provider answers with an empty catalogue. That is a UI
  state, not an error.
- Throws `ModelListError` with `kind`: `'configuration'` (blank/invalid URL; no
  request attempted), `'request'` (network/TLS/abort), `'response'` (answered but
  unusable). The server maps configuration→400, the others→502.
- The key travels only in the `authorization` header (omitted when empty) and is
  redacted from every error message; errors quote a URL without userinfo, query,
  or fragment.
- The server calls it with a per-attempt abort (`POST /v1/harness/models`) because it
  owns the key and the browser cannot call the provider (no CORS, no key).
  Failed provider requests (`'request'`/`'response'`) are retried immediately
  with a fresh controller and a doubled deadline: 10 s, 20 s, 40 s, ... up to
  ten total attempts (the last at 5_120 s), stopping on the first success.
  `'configuration'` errors fail at once with no network call. Nothing is
  persisted or logged.

---

## HarnessEvent

```ts
| { type: 'start';          agent: string; model: string }
| { type: 'text';           agent: string; delta: string }
| { type: 'reasoning';      agent: string; delta: string }
| { type: 'tool_call';      agent: string; call: HarnessToolCall }
| { type: 'tool_result';    agent: string; name: string; callId?: string; content: string; isError: boolean; outcome?: HarnessToolOutcome; durationMs?: number; pending?: HarnessPendingTool[]; ui?: ToolUiPanel[]; media?: ToolMediaDescriptor[] }
| { type: 'usage';         agent: string; usage: HarnessUsage }
| { type: 'done';           agent: string; message: HarnessAssistantMessage; pending?: HarnessPendingTool[] }
| { type: 'wakeup';         agent: string; reason: 'pending-tools'; pending: HarnessPendingTool[] }
| { type: 'progress';       agent: string; phase: HarnessProgressPhase; toolCallSlots: number; argumentChars: number }
| { type: 'retry';          agent: string; attempt: number; maxAttempts: number; delayMs: number; error: HarnessErrorInfo; provider?: HarnessProviderAttemptDiagnostics }
| { type: 'attempt_commit'; agent: string; attempt: number; maxAttempts: number }
| { type: 'action_request'; agent: string; callId: string; request: HarnessActionRequest }
| { type: 'action_answer';  agent: string; requestId: string; answer: HarnessActionAnswer }
| { type: 'branch_start';   agent: string; branch: HarnessBranchSummary }
| { type: 'branch_end';     agent: string; branchId: string; status: HarnessBranchTerminalStatus; error?: HarnessErrorInfo }
| { type: 'error';          agent: string; error: HarnessErrorInfo }

// EVERY variant also carries `thread?: HarnessThread` for a non-root run.
// HarnessErrorInfo = { message: string; code?: string; provider?: HarnessProviderAttemptDiagnostics }
//   — `code` is the machine class of the failure (`provider-timeout`, `context-overflow`,
//     …) whenever the throwing `HarnessError` carried one, and `provider` is the
//     transport's diagnosis of the attempt that ENDED the run (additive, 2026-11-17, and
//     absent for an unclassified failure). Both are DECLARED members now: `toErrorInfo`
//     (`src/util/errors.ts`) has emitted `code` beside the message for a long time and the
//     type simply did not say so, which is why every consumer read it defensively or
//     regexed the class back out of the prose.
// HarnessPendingTool = { callId: string; name: string; elapsedMs: number }
// HarnessThread = { id; parentId?; callId?; input?; kind?: 'delegation'|'fork'|'autoanswer'; branchId?; epoch? }
//   — `epoch` (T-W8, 2026-11-17) is the per-process epoch that MINTED `id`; see the run-identity
//   paragraph below for why an id alone cannot say which run a frame belongs to.
```

Delivered through `report.progress`, which is **awaited** for every step, so a
slow reporter paces the run. Every event names its agent. `tool_result.callId` is
optional for compatibility and is always populated by the harness: it is the id of
the `tool_call` the result answers, which lets a client pair two same-name calls
exactly instead of positionally — the only safe pairing once calls run
concurrently. A tool-call id must be non-empty and **unique for the whole
conversation**; a duplicate/reused id is rejected before the call is launched and
never reaches persistence. `ui` is the optional declarative panel list from
`toolUi()` (see “Declarative tool panels” below); the model never sees it.
`media` is the optional list from `toolMedia()` (`src/core/tool-media.ts`; the event
field is `src/types/index.ts:2607-2614`) and carries `ToolMediaDescriptor`s ONLY —
`{ id, kind, name, mime, size }`, `src/types/index.ts:91-98`, never the base64, because
every event is JSON round-tripped and persisted while the bytes live exactly once, on the
committed `tool` message. Like `ui`, it is absent for every medialess tool, so recorded
events keep their historical shape. A `toolText()` projection (`src/core/tool-text.ts`,
currently only `read`) adds **no** event field either: it replaces the `content` TEXT the
model reads — the transcript carries the tool's own prose instead of that result object's
serialized JSON — while the machine value stays reachable through `unwrapToolResult`.

`thread` is a NON-ROOT run's invocation identity, and since T-W8 (2026-11-17) it also names
the PROCESS that minted it. `thread.id` is the runtime's `runSequence` counter, and that
counter is per PROCESS: a restarted harness starts it again (a restore raises it only as far as
the archived agent-result rows it retained — a bounded raise, not a global one, and a snapshot
with no such array leaves it at 0), and a lane worker mints from its
OWN counter (`reserveIdentity`, `src/harness.ts` — it only ever RAISES a leased mark, it never
mints an identity), so an invocation id is unique only INSIDE one process and the same `id`
can name two unrelated runs inside one `events.jsonl`. Every mint therefore stamps
`epoch: HARNESS_PROCESS_EPOCH` (`src/core/agent-limits.ts` — ONE opaque string minted at
module load, never re-minted, a base36 timestamp plus a random suffix, e.g.
`mwk24rfs-222y0t4w3p13`, and legal only for the question "is this the same epoch as that
one?"; the REST epoch `HARNESS_RUNTIME_EPOCH` that rides the boot document, every response
header and every stream cursor is the SAME value, aliased in `src/server/api-events.ts`, so a
cursor and a recorded frame naming one epoch name one process), and `threadIdentity`
(`src/harness.ts`) copies it onto EVERY frame of the run — copied off the run's own thread,
never re-read from the module constant, so a frame can never claim an epoch other than the one
its run was born with. The mint sites are `run.thread` for a branch run, for a child of
another run, and for a HOST-THREAD run (`src/harness.ts`), plus `branchThreadOf` for the branch
audit frames; the host-thread mint is the load-bearing one, because a host conversation's own
run is ROOT-SHAPED (no parent, no spawn call, no kind, no branch), so the shape test cannot
separate the run a turn started with from the run a restarted process continues it with — and
the two can carry the SAME recycled id, which is exactly what the live artifact did: it filed a
resumed conversation under a dead child's id. Root runs are unchanged: they still emit no
`thread` at all. Three consequences a consumer has to respect:

- **A KNOWN epoch that differs is a run boundary, full stop.** The server's fold makes it rule
  (0) of `isRunBoundary` (`src/server/turn-projector.ts`), ahead of the identity-shape test and
  ahead of "the row is still open": a dead run's row cannot absorb a frame from a process that
  never ran it, however similar the two runs look. This is the defect it closes — the F5
  residual, where two runs of the SAME shape whose spawn `callId` was ALSO recycled were
  unseparable from the recorded lines, so unrelated runs merged into one turn-projection row
  (the same defect family F5 reported as a main conversation stuck at "thinking" while its
  answer sat in the record).
- **An absent `epoch` says NOTHING, and that is the contract, not a gap.** Every turn recorded
  before 2026-11-17, every un-adopted placeholder row and every hand-written reporter has none,
  so a reader must fall through to the shape and post-terminal-`start` rules rather than treat a
  missing epoch as a mismatch — that asymmetry is what keeps a pre-change session folding
  BYTE-IDENTICALLY. `snapshot()`/`restore()` deliberately carry no epoch either (they move the
  counters, not the process), so a restored replica is a NEW minting context — which is exactly
  the case the discriminator is there to catch.
- **The epoch is row state, never a TURN wire field.** It is a PAYLOAD-level field: the journal writes
  the event record verbatim (`JournalEventRecord.event` is a plain `HarnessEvent`, and the
  store's `copyEvent` is a JSON round trip), so no line schema and no snapshot version moved —
  and the recorded frames are the ONLY place the value survives a restart, which is why the fold
  can still read it after a reload. No DISPLAY TURN record carries it: `TurnSection` / `TurnSummary`
  gained no key and the display ops name no such field, so a consumer that needs the epoch of a RUN
  reads the recorded `event.thread`. The browser keeps it as its own row state and stamps it on the
  row as `data-run-epoch` (`src/frontend/ui/turns.ts:5282`) for inspection — nothing renders it.
  CORRECTED IN PLACE 2026-11-17 (W26): this bullet's heading used to read "never a wire field", and
  that is true only of the TURN planes. The same process token IS published on the CONVERSATION
  planes, beside the run ids it discriminates — `SessionThread.epoch` (`src/server/protocol.ts:610`),
  `SessionThreadView.epoch` (`:719`, the compact row the browser renders) and `epoch` on
  `ThreadSummary` (`src/server/harness.swagger.yaml:7544-7595` → `src/shared/harness-api.ts:2821`),
  which is also what a `thread.upsert` frame carries because the live row is the same producer
  (`WsUpdateThreadUpsert.thread: ThreadSummary`, `src/shared/harness-stream.ts:766`). The token is
  BARE there too, and the model-facing `threadList` page still strips it. See "THE ROSTER ROW
  CARRIES AN IDENTITY TRIPLE" under "Persistent threads in the UI".

The three concurrency fields are additive, and a client must fall back to its
pre-concurrency rendering when they are absent (old persisted turns):

- `durationMs` is the server-measured span of the call that just ended, not the gap
  between frame arrivals (concurrent calls wait behind each other). Every
  **executed** call reports one — inline/direct calls included; a call rejected by
  argument validation never executed and may omit it.
- `pending` is the set of calls still running. On `done` it means the agent's
  response is complete while its own calls are not: an interim response, not the
  end of the turn. The UI keeps those cards alive and prints their spans; a client
  must not close them on such a `done`. The field is omitted when nothing remains,
  so absence is not a drain signal; a UI prunes a settled `callId` itself.
- `wakeup` is a RESUME. It resolves no tool and ends nothing; it says background
  work progressed and the agent continued. Its `pending` list is required: a wake
  without one is malformed and produces no update.
- `progress` (ADDED 2026-11-19) is the TOOL-COMPOSITION heartbeat:
  `{ phase, toolCallSlots, argumentChars }` with
  `HarnessProgressPhase = 'tool-composition' | 'idle'` (`src/types/index.ts:468, 477`).
  It is **PROJECTION-ONLY**: it never becomes a transcript entry, never joins a commit
  decision, and **no consumer may act on it** — the calls still arrive only on the terminal
  frame and partial arguments are still never executed (`src/types/index.ts:487-494`,
  `src/core/agent.ts:1174-1199`). It carries **counters and never argument text** (the text
  is kilobytes per block, it is model-private, and every event is journalled verbatim —
  `src/types/index.ts:470-476`). `'idle'` is spelled only by the DISPLAY plane when an
  attempt boundary clears a stale line; a transport never emits it, because its own
  `done`/`error` frame IS the settle (`src/types/index.ts:462-467`). It IS journalled, in
  recorded order, and it consumes a journal POSITION — so the ordinals of every later event,
  and the node / context-block / step ids derived from that position, shift relative to a
  turn that never composed a tool call, exactly as they already shift for a journaled
  `wakeup` (`src/server/journal.ts:118, 143`; pinned honestly at
  `src/server/journal-progress.test.ts:192` — the two projections agree once the
  position-derived keys are set aside and do NOT agree with their real ids). Emission is
  gated at the source by **"is a slot open"**: the first sample of an attempt that has
  `toolCallSlots > 0` emits IMMEDIATELY, later ones at most once per
  `TOOL_CALL_PROGRESS_INTERVAL_MS = 500` (`src/transport/openai.ts:1109, 1853, 2002-2019`),
  monotonic clock, **no new timer**; a relay that flushes the whole tool region in one frame
  costs exactly one line, and an empty `tool_calls: []` delta costs NOTHING — it emits no
  frame and does not consume that first emission, so the fragment that really does open a
  slot still reports at once. CORRECTED IN PLACE 2026-11-19 (review F3, then P2): this
  sentence read "once at phase entry, then at most one per 500 ms", which is stale on both
  halves — phase entry alone no longer buys a frame (only an OPEN SLOT does, and an empty
  delta may not spend it), and the same `slots >= 1` bound was extended to the DISPLAY side
  so the projector refuses the frame the transport refuses
  (`src/server/turn-projector.ts:381-391` `toolProgressOf`); before that, a custom transport
  or a pre-F3 journal could paint the self-contradictory `composing 0 tool calls · 0 chars`
  while the CLI validator (`src/server/cli/render.ts:103`) rejected the identical frame. The
  clear is exempt: `IDLE_TOOL_PROGRESS` also carries zero slots and still clears
  (`src/server/turn-projector.ts:404`). Pins:
  `src/transport/openai.tool-call-progress.test.ts:307`,
  `src/server/turn-projector-progress.test.ts`. A reader that does
  not know the kind skips it and sees the run it saw before (`src/harness.progress.test.ts:103`).
  CORRECTED IN PLACE 2026-11-19: the transport's own event vocabulary used to be FOUR kinds
  — `text | reasoning | done | error` — and is now FIVE, `progress` added
  (`src/types/index.ts:495-522`); this section's union omitted the variant entirely.
- `retry` (R1) says the agent abandoned ONE failed model request and re-sent the
  same one after `delayMs`. Text/reasoning/tool calls streamed since the previous
  boundary (`start`/`retry`/`attempt_commit`/`done`) belong to the FAILED attempt: a
  client discards them (the UI truncates back to its attempt boundary) because the
  agent never commits them. `attempt` is the failed attempt (1-based) and
  `maxAttempts` its budget, so "2 of 11" needs no guessing — and the budget is the
  CLASS's, not one constant: **11** for the generic transient ladder, **3** for
  `provider-connection`, **4** for `provider-timeout` (2026-11-17 — that class used to
  emit NO `retry` frame at all, because it was terminal). `delayMs` is the capped,
  jitter-free wait the ladder publishes (see "agent" — Retries), and `provider`
  carries the redacted endpoint, effective port and failure class of THAT attempt
  when the transport classified it. **What a `retry` of class `provider-timeout` costs a tool
  round (2026-11-19):** the re-send is the SAME request from token 1, so every argument byte the
  model had already generated in the abandoned attempt is DISCARDED and the block is
  re-generated — a 4-attempt ladder on a 60 s block is up to 4 minutes of the same work, under a
  900 000 ms ladder-wide deadline (`src/core/agent-limits.ts:192-202, 221`). `progress` frames
  streamed since the last attempt boundary are discarded with it, by construction: the retry
  re-creates the transport iterator and the throttle clock lives in that closure
  (`src/core/agent.ts:1174-1199`). Nothing in that sequence is a TOTAL clock — one attempt that
  keeps producing bytes within the idle bounds is unbounded
  (`src/transport/openai.tool-call-liveness.test.ts:653`, "lets a default-configured stream TRICKLE past 3 600 000 ms without any bound firing"; issue 0038).
- A terminal `error` frame carries the SAME machine-readable half since 2026-11-17:
  `error.code` plus `error.provider` (the diagnosis of the attempt that ended the run),
  emitted through the same `providerDiagnosticsOf` reader, so a failure that was
  terminal BY DESIGN — a `provider-rejected`, `provider-aborted` or `provider-transit`
  death, or an exhausted ladder whose last attempt never got a `retry` frame — no
  longer reaches a UI, a journal row or the session layer as a sentence to parse. An
  unclassified failure still carries neither key, so every historical recording keeps
  the `{ message }` payload it always had and `src/frontend/provider-diagnostics.ts`
  keeps its prose fallback for exactly those rows.
- `attempt_commit` (R3) is the SUCCESS end of one model request: the answer is in
  history, so everything streamed since the previous boundary is final and a later
  `retry` (a NEWER request) must not discard it. It exists because `done` is not
  always emitted — a completed tool round gets no `done` at all, and a text response
  superseded by a completion that landed mid-request is committed but never reported.
  It is therefore emitted for every committed response that does NOT get a `done`; a
  response that does get one keeps its exact old sequence. Older recordings simply
  have no such frame, and a client keeps its historical `done`-only boundary
  behaviour for them.
- Committing a request also DETACHES the incremental prose/reasoning writers (the
  committed nodes stay, their buffers do not). Without that, the next request's
  deltas would be appended into the committed block, fusing two requests into one
  node that a retry could then neither keep nor remove cleanly.

`usage` is emitted once per **model request**, including the tool rounds that keep
a run going — `done` only ever reports the final request, so this is the only
per-request feed a client can tally. It is absent when the provider reported no
usage block for that request. The server folds every one of them into
`SessionTurn.usage` (delegated-child requests included) and repeats the running sum on
each `usage.updated` stream frame; the UI prints the LATEST model request's input/context size with
the turn's cumulative cached input in brackets, e.g. `150 (140)` (the label's
title names both scopes). The wire tally's `input` stays the cumulative sum for
other metrics.

## HarnessMessage

```ts
| { role: 'system'; content }
| { role: 'user';   content }
| { role: 'assistant'; content; toolCalls?; reasoning? }
| { role: 'tool';      content; toolCallId; name; attachments?; outcome?; included?; messageId? }
```

The optional keys above arrived with their own entries and are all MINIMAL-DELTA: absent is
the canonical spelling of the default. `attachments?` is out-of-band tool/upload media
(`src/core/tool-media.ts`), `included?` is the context-inclusion flag and is stored only when
`false` (`src/core/agent.ts` `withIncluded`), and `messageId?` is the stable transcript address
minted at every canonical creation point and never model-facing
(`src/core/message-id.ts`). The `tool` variant additionally carries
`outcome?: HarnessToolOutcome` — **only a NON-`completed` outcome is stored**, so absent means
`completed`, a transcript written before the field exists keeps its exact previous shape, and
nothing re-derives the value from the result prose. The three rules (write / read / derive)
live in `src/core/tool-outcome.ts`; `isError` on the event is always derived from the outcome,
never stored beside it. None of these keys reaches a provider: the transport field-selects the
wire shape per role (`src/transport/openai.ts`).

`HarnessToolCall` is `{ id, name, arguments }` where `arguments` stays a raw JSON
string — malformed JSON is the harness's problem to report, not a parse crash, and
it is retained verbatim so a restored transcript replays what the model actually
sent (the transport repairs it at the wire boundary, see `openAICompatible`). The
`id` is non-empty and unique across the conversation; the runtime rejects a
duplicate/reused id before it launches or persists the call.

## HarnessAssistantMessage

```ts
{
    role: 'assistant';
    content: string;
    reasoning: string;              // '' for non-reasoning models
    toolCalls: HarnessToolCall[];   // [] when the model answered directly
    model: string;                  // captured at request time
    stopReason: 'stop' | 'length' | 'tool_calls';
    usage?: {
        input: number;   // prompt tokens, INCLUDING a replayed cache prefix
        output: number;
        total: number;
        cached?: number; // replayed prefix the provider served from cache, when reported
    };
    structured?: unknown;   // ONLY for an agent({ structured }): the parsed, validated answer
}
```

`structured` is written only when a `structured` agent's answer PASSED the schema,
and the key is absent (never `undefined`) otherwise — including for every agent
that did not configure one, for a `length`-truncated turn, and for a tool-call
round. A turn whose answer failed the schema never produces this message at all:
it fails with code `structured-output-invalid` and commits nothing.

`usage.cached` is optional and never defaulted: “not reported” and “reported, 0”
are different facts. The transport reads it from `prompt_tokens_details.cached_tokens`
(OpenAI-compatible, and what the workspace's Lightning adapter emits) or
`prompt_cache_hit_tokens` (DeepSeek-compatible), and clamps it to `input`.

## ToolVisibility / selectTools / searchTools

```ts
type ToolVisibility = 'core' | 'searchable';

// The uncapped selector behind toolRequest. Every matched tool is returned; the
// harness applies maxEnabledTools when it decides what to enable/declare.
type ToolSelectionResult = {
    names: string[];
    tools: { name: string; description: string; tags: string[] }[];
    alreadyAvailable?: { name: string; description: string; tags: string[] }[];
                                        // core tools the caller already has; never selected
};

// The harness's model-facing answer: the bound admits enabled/tools, while
// matched counts the whole union and omitted is the difference.
// { enabled, tools, matched, omitted, unmatchedTags?, availableTags?, alreadyAvailable? }

// Legacy tag-only paged answer still returned by searchTools (not toolRequest).
type ToolSearchResult = {
    enabled: string[];                  // ranked; legacy paged shortlist
    tools: { name: string; description: string; tags: string[] }[];
    remaining: number;                  // matched but excluded by MAX_DISCOVERY_MATCHES
    unmatchedTags?: string[];           // query tags that matched nothing
    availableTags?: string[];           // vocabulary, when nothing matched
    offset?: number;                    // start of a later page (legacy progressive discovery)
    truncated?: boolean;                // remaining > 0 (compatibility mirror)
    alreadyAvailable?: { name: string; description: string; tags: string[] }[];
                                        // core tools the caller already has; reported, never enabled
};

type ToolSearchOptions = {
    declared?: readonly Tool[];         // the caller-visible core set (harness: visibleCoreTools)
};
```

`searchTools()` returns the same shape as a `toolRequest` call, so a UI can rank a
catalogue without a harness.

## Action and branch types (N3)

```ts
type HarnessActionOption = { id: string; label: string; description?: string };

type HarnessActionRequest = {
    requestId: string;                  // runtime-generated
    question: string;
    recommended: string;                // one of options[].id
    options: HarnessActionOption[];     // 2..8, unique ids
    allowCustom: true;                  // constant, not model-controlled
};

type HarnessActionChoice =
    | { kind: 'option'; optionId: string }
    | { kind: 'custom'; text: string };

type HarnessActionAnswer = {
    requestId: string;
    choice: HarnessActionChoice;
    source: 'owner' | 'auto';
    branchId?: string;                  // auto answer only
};

type HarnessActionResult = {
    requestId: string;
    answeredBy: 'owner' | 'auto';
    choice:
        | { kind: 'option'; optionId: string; label: string; description?: string }
        | { kind: 'custom'; text: string };
};

type HarnessActionRequestContext = {
    requestId: string;
    agent: string;
    branchId?: string;                  // the requester's branch
    threadId?: string;
    callId: string;
    request: HarnessActionRequest;
};

type HarnessActionHandler = (
    context: HarnessActionRequestContext,
    signal: AbortSignal
) => Promise<HarnessActionChoice>;

type HarnessForkResult = { branchId: string; threadId: string; content: string };

type HarnessBranchSummary = {
    branchId: string;
    kind: 'fork' | 'autoanswer';
    agent: string;                      // source/owner agent name
    rank: AgentRank;                    // INHERITED from the source agent, never re-derived
    sourceBranchId?: string;
    sourceThreadId?: string;            // the REQUESTER's invocation identity
    threadId?: string;                  // the persistent conversation that owns the branch
    callId?: string;
    requestId?: string;                 // autoanswer only
    forkDepth: number;                  // ordinary forks; autoanswer inherits
    model: string;
    tools: string[];                    // declared wire names ([] for autoanswer)
};

type HarnessBranchStatus = 'running' | 'completed' | 'failed' | 'cancelled';
type HarnessBranchRecord = HarnessBranchSummary & {
    status: HarnessBranchStatus;
    toolCallIds: Array<{ origin: string; branch: string }>;
    messages: HarnessMessage[];
    result?: { content: string; stopReason: HarnessStopReason };
    error?: HarnessErrorInfo;
};

type HarnessForkConfiguration = {
    enabled?: boolean;                  // default true
    maxDepth?: number;                  // default 2
    maxConcurrent?: number;             // default 4
    maxHistoryBytes?: number;           // default 8 MiB
    maxBranchRecords?: number;          // default 64
};

type HarnessInteractionConfiguration = {
    actionRequest?: HarnessActionHandler;
    autoAnswer?: boolean;               // default true
};
```

`src/types/index.ts` is canonical; the runtime parsers are `core/action.ts`, and
`core/branch.ts` owns the summary/record/bounds. Branch records are runtime state,
never snapshot state (a `snapshot()` carries no branch record, and `reset()` clears none).

## Declarative tool panels (R20.2)

A tool result is text for the model. To let a client render a small, safe summary,
a tool wraps its ordinary value:

```ts
toolUi(content, panels)               // branded ToolUiEnvelope<TContent>
toolUiOf(value)                       // extraction + re-normalization, or undefined

type ToolUiBlock =
    | { type: 'text'; text: string }
    | { type: 'table'; columns: string[]; rows: string[][] }
    | { type: 'keyValue'; items: { label: string; value: string }[] };

type ToolUiPanel = { id: string; slot: string; title: string; blocks: ToolUiBlock[] };
```

`src/types/index.ts` is the canonical type home; `src/core/tool-ui.ts` owns the
normalizer and the exported `TOOL_UI_LIMITS`.

- **Model content is unchanged.** `executeToolCall` calls `toolUiOf(result)` and
  serializes only `ui.content`; the envelope/panels never enter the transcript or
  a transport request.
- **The event carries it.** `tool_result.ui` is present only for a recognized
  envelope. `src/server/sessions.ts` copies events as before, so the opt-in `run.event`
  stream frame and the recorded
  turn keep the panels and `eventTimes` stays a parallel array with the same
  length/order.
- **Manual calls unwrap.** `src/server/api.ts` projects `ToolCallResult.result` to the
  content and adds optional `panels` (session-bound and direct paths alike).
- **Safety bounds.** `slot` is an open string (`right` is the default mount, with
  `center`/`left` available to the UI); panels are data only (no HTML/JS/actions).
  Normalization caps 32 panels, 64 blocks/panel, 100 table rows, 20 columns, 100
  key/value items, bounded text/cell/label lengths, and a 256 KiB total; malformed
  panels/blocks are dropped, non-string cells blanked/padded, and oversized
  panels dropped whole.
- **Demonstration.** `src/server/harnesses/tools.ts` `timeNow` returns a right-slot key/value
  panel while keeping its `{ timezone, iso, unix }` content. The server API result
  is unchanged; the chat transcript shows the panel. A direct callable consumer
  receives the branded envelope and should use `toolUiOf()`.

---

## Decisions worth remembering

- **No runtime dependency for the loop.** The package publishes standalone: the default
  transport is ~150 lines of SSE over global `fetch`, and `parameters` is plain
  JSON Schema so TypeBox needs no dependency. What IS declared in `dependencies` is what
  the published sources actually import — `dotenv` (server `.env` loader), `typescript`
  (the tool-source compiler), `dompurify`/`marked`/`highlight.js` (the browser markdown
  renderer) — because a source-only publish cannot hide an import behind a bundle.
- **The registry key is the identity.** Both agents and tools take an optional
  `name` that the harness overwrites, so `writer: agent({...})` never repeats
  `name: 'writer'`.
- **`turn()` vs `stream()`.** `turn()` is the loop primitive (no user append, no
  rollback, throws); `stream()` is the standalone one-turn convenience (atomic,
  yields errors). Keeping both is what lets the harness and a hand-written caller
  share one implementation.
- **Tool failures are data, not exceptions.** Only transport failure and a
  runaway loop are terminal; everything a tool did wrong is reported back to the
  model so it can recover.
- **`ErrorOptions` is not used.** The package's `lib` does not include
  `es2022.error`, so `HarnessError` assigns `cause` directly.
- **`harness.name` must be defined, not assigned.** `name` is a read-only
  property of every function, so the callable is built with `Object.assign` and
  then `Object.defineProperty(handle, 'name', ...)`. It is a GETTER, and so is
  `handle.agent` (`:17191` / `:17201`): `Object.assign` would flatten a literal
  getter into ONE value, and both readers have to follow the roster because the
  entry agent is removable (`effectiveEntryName`, `:16855`). `tool()` hits the same
  constraint and defines `name` with `writable: true` so a harness can rename it.
- **A tool is a function, not a record.** Making `tool()` return a callable is
  what lets the same definition be an executable object and a model-facing
  declaration. The cost is that `name` needs `defineProperty` and that the
  callable's signature has to be pinned with generics (`tool<Params, Result>`)
  because a JSON Schema literal cannot be turned into a TS type without a
  TypeBox-style dependency.
- **Visibility is a harness concern, not a tool concern.** A tool knows only its
  own tags and whether it is core; the harness owns the active set and the
  declarations. That split is what lets discovery change between turns while the
  registry stays immutable after construction.
- **Tags are required, scored, and page-capped (legacy `searchTools` only).** A
  tool without tags could never be found, so construction rejects it. Ranking is
  OR-style best-match (a tool's rank is its strongest single-tag hit; hit count
  only breaks ties), deterministic (score, hits, name), and each legacy
  `searchTools` page is capped at five matches — default AND maximum — because
  paged tag discovery exists to save context; the excluded tail is reported only as
  `remaining`. A caller may ask for fewer, never more. The live `toolRequest` tool
  does NOT use that cap: `selectTools` returns every match and the harness's
  `maxEnabledTools` (default 32, core tools excluded) bounds the enabled set, with
  the newest request displacing older enabled tools when the bound is full.
- **Presets are lazy proxies, not implementations.** `src/tools/index.ts` exports
  callable `Tool`s whose metadata is static and whose body is a dynamic import.
  Building a harness, listing the catalogue, or ranking a preset therefore never
  loads `node:fs`/`child_process`/`vm`. The trade-off is packaging coupling: the
  published tree has to carry every branch as its own editable source file (there is no
  chunk table), and a consumer bundler that inlines dynamic imports would fold those
  Node bodies back into the entry it ships to a browser.
- **Created tools are compiled, not run, at registration.** `createDynamicTool`
  validates the shape and compiles the body with the host realm's `Function`
  constructor; execution happens only on call. The harness adds reserved names, a
  case-insensitive collision check, and a 32-tool budget. It is session-local (a
  server with a database root persists the creation SOURCES in the core snapshot and
  recompiles them on restore; nothing is written into the tool catalogue) and
  **unsandboxed**.
- **Authority is a LADDER, not a singleton, and delegation runs strictly downward.**
  `delegate` is core for every agent of a roster that spans two or more DISTINCT ranks; the
  target set is DERIVED from rank (`isLowerRank`, `src/types/index.ts:1539`) and never listed, and
  a same-rank or higher-rank target is refused with the caller's rank and its legal targets named.
  Depth is bounded by the number of distinct ranks (`runDepthCeiling`, hard ceiling 26), not by a
  fixed "one level", and a `delegate` chain is bounded by its OWN RANKS: B→A is an UPWARD target, so
  the rank check in `delegateFor` (`src/harness.ts:5624`, refusal at `:5648-5663`) refuses A→B→A
  BEFORE a second child is launched — which means the agent-cycle guard CAN NEVER FIRE for the
  `delegate` door (CORRECTED IN PLACE 2026-11-18: this bullet credited that guard with refusing
  A→B→A, and the rank check is what fires first). The cycle guard stays the live guard for the one
  shape the rank comparison cannot see — re-entering an agent that is ALREADY running through
  `ctx.run` or a created tool holding the whole `context`, since threading is never rank-gated — and
  it runs in `runAgent` (`:14680-14684`), ahead of the distinct-rank nesting ceiling (`:14700-14707`)
  so a re-entry keeps its own, more precise message. Each agent keeps its own
  instructions and transcript; only the answer crosses back.
  WHY THE OLD RULE IS GONE: `MAX_RUN_DEPTH = 2` and "core for the primary only" were ONE
  assumption written twice — that a roster has exactly one top. Two Rank A leads (a planner and a
  reviewer who each own work, or two peer specialists) are a legitimate harness, and an
  enforcement keyed to a single privileged role cannot express it: either the second lead could
  not delegate, or the rule had to special-case it. Making rank a per-agent LETTER, and the only
  authority axis, lets any number of agents share the top while the strictly-downward rule keeps
  chains finite for free — a descending chain over a finite ladder cannot cycle, which is why the
  nesting bound needs no separate depth counter and why the cycle guard stayed as its own,
  more precise refusal.
- **Tools are never rank-gated.** Every agent has access to every registered tool. The removed
  `registration.primaryOnly` flag filtered the DECLARATION *and* refused the LAUNCH, which
  duplicated what the two authoritative checks already prove (and could not express a roster where
  two agents hold Rank A and a third holds Rank B). What remains each answers a DIFFERENT
  question: the per-run `scope.tools` allowlist (what THIS child should do — with `toolRequest`
  never restricted by the scope, so a child reports what it is missing instead of looping),
  the conversation's withheld set (what the USER of this conversation switched off),
  `toolSettings` (what the DEPLOYMENT disables for every session), and `maxEnabledTools` plus
  discovery (how much context one request pays). The ONE optional rank ceiling left is
  `toolCreation`, and it is a capability about creating tools, not about using them.
  WHY: a role gate treated the declaration list as a permission, and a declaration list is a
  HINT — a caller that guessed a name always reached the authoritative check anyway, so the gate
  bought a smaller prompt at the cost of a second, drift-prone copy of the rule.
- **Threading is parallel work by the SAME agent, so rank never gates a thread.**
  `createThread`, `api.threads.*`, `threadFork`, thread visibility, messaging and lineage never
  read a rank; a Rank B agent spawns threads, forks and calls every tool a Rank A agent calls.
  Rank is PROPAGATED to thread/branch/fork agents (`actorRanks.set`) so a derived actor keeps the
  authority it came from — which is the whole point: threading multiplies one agent's capacity,
  delegation changes who does the work, and only the second one is an authority question. A
  harness that gated threads by rank would silently cap a junior agent's throughput while telling
  it that nothing is restricted.
- **A branch is a conversation copy, not a sandbox.** `threadFork`/`Agent.fork()`
  clone the entire committed history at request instant, remap tool ids, and share
  the transport; external side effects remain shared. Only the final summary
  returns. Branch records/events are ephemeral audit state (never snapshot state), and a
  fork that exceeds the history cap fails explicitly instead of truncating.
- **A question never selects its recommendation.** `actionRequest` has no model
  switch for free text (`allowCustom` is always true) and no automatic fallback to
  `recommended`; a root needs a real host answerer, and a child/fork request is
  answered by a tool-free owner clone. A failed or expired answer stays a readable
  tool result and is never fabricated.
- **Undiscovered tools do not run.** Executing a tool the model was never
  declared would make toolRequest optional in practice. Instead the call comes back
  as a tool result naming the tags that would enable it, which is recoverable and
  still teaches the model the vocabulary.
- **Preload the catalogue, declare only the core.** Shipping the presets into
  every harness by default stays cheap: only the `visibility: 'core'` rows are declared
  up front — the five core file tools (`read`/`write`/`edit`/`glob`/`grep`), `tasks`,
  `toolRequest`, `toolCancel`, the thread group (`threadList`/`threadRead`/
  `threadSend`/`threadDelete`)
  when the harness has threads, the configured `search`/`fetch` pair, and `delegate` for
  every agent of a roster spanning two or more DISTINCT ranks (declared per caller against that
  caller's own lower-ranked targets) — while every searchable row costs no
  context until discovered (the library
  posture; the server's new sessions are seeded, below): the
  record wrappers `records`/`profiles`/`chapters`/`locations`, `agentManage`/
  `agentResult`, `toolList`/`toolManage`/`toolRegistry`/`toolCreate`, `files`, `shell`,
  `download`, `threadFork` and `actionRequest`. (CORRECTED IN PLACE 2026-11-11: this
  bullet named `task`/`profileManage`/`chapterManage`/`locationManage`, and listed
  `toolCreate` among the declared set although it is `visibility: 'searchable'` with
  `activation: 'creation'`.)
  `presets: false` exists for callers who want an empty catalogue, which is also
  what the harness tests use when they assert exact discovery results.
  THAT IS THE LIBRARY POSTURE. The shipped server inverts it for the events that START a
  conversation: `SessionStore.create` builds a new session's harness with `enableAllTools: true`
  (`src/server/sessions.ts:2204`), and `SessionStore.reset` re-runs the same pass afterwards
  (`SessionStore.reset`, in that same file), so a conversation that has never run — or one whose conversation was just discarded —
  starts with the
  whole SWITCHABLE toolbox enabled — the operator asked for a harness that is usable
  immediately, not one that spends a discovery round trip before it can call `shell`. The
  cost is exactly the one this bullet names: those rows are declared, so every request pays
  their schemas from the first turn. It is bounded, not open-ended — the seed runs through
  `enableTools` (`src/harness.ts` `seedSwitchableTools`, called from the `configuration.enableAllTools === true` branch at the end of construction), `maxEnabledTools` (default 32) is NOT raised
  for it, a deployment-disabled name is filtered out first, and a RESTORED session keeps exactly
  the set it committed — `restore()` replaces the enabled set after construction
  (`src/harness.ts` `restore()`), so the flag the restore build also passes
  (`src/server/sessions.ts:3843`) refills nothing; it only arms the reset re-run above for a
  session that survived a restart. See
  [Tool discovery](#tool-discovery) for the four rules that decide the seeded set.
- **Session state is instance state, not module state.** The ONE record engine is
  constructed per harness (`src/harness.ts:4372`, `createRecordEngine()`), so two sessions never share records —
  and its id counter is shared ACROSS the `tasks`/`profiles`/`chapters`/`locations`
  collections plus anything an agent `define`s (F3), which is what makes an id
  conversation-wide rather than per-store. `reset()` is therefore a complete "start
  over" that no module singleton could express.
- **A model is a per-request choice, so it is editable live.** The harness always
  reads an agent's model when it starts a request (`requestModel` in
  `src/core/agent.ts`), which is what lets `PATCH /sessions/:id` retarget an agent
  without rebuilding anything: the in-flight request and the message it commits
  keep the model they started with, and the next request uses the new one.
- **Knowledge is DEPLOYMENT state, so it lives outside `sessions/` — and nothing else is
  allowed to own it.** The durable base is `<databaseRoot>/harness/knowledge/`, a SIBLING of
  `harness/sessions/`, and that placement is the whole feature: folding the base into
  `harness.snapshot()` would let ONE session's restart rewrite the articles every other session
  is reading, and a session deleted with its `sessions/<id>/` directory would take them with it.
  So `src/harness.ts` wires the seam and NOTHING else — no snapshot field, no `reset()` touch,
  no `dispose` hook (`src/harness.ts:4380-4395`) — the store is keyed by RESOLVED ROOT in
  `src/server/runtime.ts:415-562` (one engine, at most one store, load AND failure memoized per
  root, `''` meaning "in memory, no filesystem write"), and the ONLY disposer is the process
  owner (`src/server/start.ts:411-430`), because one session's teardown must not unsubscribe the
  base every other session is still writing. A lane WORKER therefore gets an in-memory replica,
  not the live store: a live object cannot cross `worker_threads`.
  Pinned by `src/server/knowledge-session.test.ts` ("byte-identical when a session is deleted",
  "disposes the store exactly once, and a restart reads the article back") and by
  `src/harness.knowledge.test.ts` ("keeps knowledge across `reset()`", "never carries knowledge
  in the snapshot"). See [Cross-session knowledge](#cross-session-knowledge).
- **Knowledge concurrency is optimistic CAS and NOTHING else** — records' Decision P carried
  over unchanged. `modify`/`remove` pass `expects: [{ id, rev }]`, one token at ARTICLE grain
  (a paragraph edit moves the article `rev` too, so there is exactly one token to reason about);
  a stale token refuses the WHOLE operation and the refusal CARRIES THE CURRENT ARTICLE, budgeted
  at `KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES = 8192`, degrading to metadata + a paragraph OUTLINE
  when the article does not fit — so the retry needs ONE round trip, not two, and the caller can
  still harvest every paragraph id and `rev` it needs. There are no locks, leases, claims or
  sweeps, and an unwarned write is legal (`expects` is optional: the tool's own description says
  it "can overwrite what another thread changed"). The token is TWO revisions wide, and the split
  is the point: `article.rev` moves on anything including ORDER, `paragraph.rev` only on that
  paragraph's own text/tags/refs, which is what lets one caller guard a paragraph body without
  being woken by a sibling being reordered (`src/core/knowledge.ts:27-32`).

## CLI, server, and UI

The app is split so the harness has **no UI dependency**. The library
(`src/harness.ts`) stays the published harness entry; the application layers
(`src/server`, `src/frontend`, `src/shared`) are consumers of it and are published
as their own entries.

- **CLI (`src/server/cli/`)** runs a preset in-process: one-shot from argv/stdin, or an
  interactive session on a TTY. It renders `HarnessEvent`s directly with
  `src/server/cli/render.ts`, or emits one JSON object per line with `--json`. With
  concurrent tools the terminal also shows the server's `durationMs`
  (`← read · 1.3s`), a `pending · name 1.2s` line for calls still running, and a
  `~ agent woke · …` wake line, so background work is never invisible in a CLI.
  `--serve` switches to the HTTP server. The CLI never imports the UI.
  An interactive line goes through `src/server/cli/commands.ts` first: its own
  `/exit`, `/quit`, `/help`, `/reset`, `/tools` and `/presets` are answered locally
  (they SHADOW the same-named harness commands), every other `/name` is forwarded
  verbatim to `harness.executeCommand`, and only ordinary text starts a model run
  (see [Slash commands](#slash-commands)).
- **Environment (`src/server/environment.ts`)** loads the package-root `.env` from
  `src/server/cli/index.ts` (before `settingsFrom`) and from the top of
  `startHarnessServer()` (used by `src/server/dev.ts` and the service runtime), via `dotenv` as a
  devDependency. The path is module-relative (`../../.env`), `override: false`
  keeps shell values (including empty ones) authoritative, a missing file is a
  no-op, and `quiet: true` prevents startup logging. It must run before harness
  construction because search keys are captured there. The library graph never
  imports it.
- **Server (`src/server/`)** owns HTTP and sessions, not harness policy. Routing and
  validation live in transport-neutral `api.ts`; `handler.ts` is only the Node
  adapter for the ONE mount `/v1/harness` (no header gate since T15, streamed body
  bound, SSE served by piping `runHarnessSseStream` onto the one exported writer
  `createHarnessSseResponse`) and
  `service.ts` the `@underload/service` adapter for the SAME mount (Origin gate,
  content-length/serialized body bound, raw SSE `Response` for a streamed result).
  CORRECTED IN PLACE 2026-11-11: this bullet called `handler.ts` "the Node adapter for
  `/api` (client header, …)" — neither the mount nor the `X-Harness-Client` gate exists
  any more (`STANDALONE_MOUNT`, `src/server/api.ts:307`; gate removed,
  `src/server/handler.ts:8-13`), and no route returns a `stream` result today, which is
  why both adapters' SSE writers are dormant
  (`src/server/handler.ts:139-164`, `src/server/service.ts:184`;
  "REST routes never stream", `src/server/api.ts:399`). `start.ts` holds
  `startHarnessServer` — the only listener, created when called. `SessionStore`
  keeps one `Harness` per session and owns each run's `SessionTurn`s plus the FIFO
  task queue, so a second task continues the conversation in order, a reload can
  replay the transcript from `list()`/`get()`, and a watcher can reattach through
  `watch()`. Creating a session is its own operation, not a by-product of a first task:
  `create()` (`src/server/sessions.ts:2223`) needs the harness NAME and nothing else
  (`src/server/api.ts:2979-2983`), mints the id itself with `randomUUID()`
  (`src/server/sessions.ts:2298`) — the id is the server's, never the client's — copies the
  template plugin-settings store down BEFORE the factory runs (`copyPluginSettingsStore`,
  `src/server/plugins.ts:713`, called at `src/server/sessions.ts:2268`, because the provider
  reference has to exist for `buildHarness` at `:2276`), and writes the record through before
  the `201`, deleting the in-memory entry when that write fails (`:2358-2366`). The ordering is
  load-bearing for the UI: `+` calls this route the moment it is pressed
  (`src/frontend/main.ts:13803` `newSession` → `:14138` `ensureSession`), so a first task never
  has to discover an id and a failed create is one visible error instead of a deferred one; a
  repeat `+` creates again, because the teardown in `newSession` IS the reset — no dedup, no
  reuse, no client-side cap (`src/frontend/main.ts:13897-13905`). CORRECTED IN PLACE
  2026-11-13: the eager-creation pass rewrote this bullet to state what the server already
  guaranteed; the client used to create lazily on the first submit.
  The store owns TWO plugin-settings scopes (`src/server/plugins.ts`, "THE TWO SCOPES"): the
  template store the global routes edit, and one detached store per session whose live provider
  is the one that session's harness reads (`src/server/sessions.ts:2490`), persisted on the
  session's own record (`src/server/persistence.ts:293`) and rebuilt from it on restore
  (`src/server/sessions.ts:3677`). The TOOL switch beside it keeps the PROCESS scope alone
  (`toolSettings: this.tools.provider`, `:2380`) — the asymmetry is deliberate, and it is why
  the plugin docs now separate "this conversation" from "sessions created after this".
  `dispatch()` is the submit surface `POST /sessions/:id/tasks` calls and
  the only place a slash line is split from a prompt: non-command text is queued, a
  `/command` becomes a terminal command turn executed in this process (no model, no
  lane). The store also owns the editable per-thread transcript
  (`threadTranscript`/`updateThreadTranscript`) and the tolerant restart that keeps one
  unreadable conversation from dropping a session. `static.ts` serves
  `src/frontend/dist`; `dev.ts` is the separate standalone API launcher
  (`yarn dev:server`, static serving disabled), while
  `yarn dev:frontend` is Vite only and proxies `/v1/harness` to the service on :5000.
  It binds the IPv6 wildcard `::` (`DEV_SERVER_HOST` in
  `src/frontend/vite-proxy.ts`), which Node opens dual-stack, so the one listener
  serves `localhost` (`::1`), `127.0.0.1` and the LAN IPv4 address; an IPv4-only
  bind made Vite's printed `Local` URL false because `localhost` resolves to `::1`
  first. Preview stays pinned to `localhost` (loopback, IPv6-only on Windows).
  Set `HARNESS_DEV_API=http://127.0.0.1:5181/v1/harness` to point that same proxy at the
  standalone launcher instead — CORRECTED IN PLACE 2026-11-11: this example named the
  removed `/api` mount (the launcher serves `mount /v1/harness`,
  `src/server/dev.ts:45`); that `/api` spelling survives only as an example of an
  arbitrary upstream mount path inside the proxy's own comment
  (`src/frontend/vite-proxy.ts:17-21`, `:109-115`). There is no CORS in the standalone Node mode: the
  UI is same-origin in production and proxied (or service-hosted) in development.
- **Service host (`src/server/endpoint/` + `src/server/service.ts`)** is the same API on the
  repository's Hono gateway. `@underload/service` scans the repo root for
  `endpoint`/`endpoints` folders and imports every `service-route*.ts` default
  export; `src/server/endpoint/harness/service-route.ts` registers `/v1/harness/*` and
  `service-route-root.ts` registers the bare `/v1/harness` (a wildcard does not
  match the bare path). Neither declares a `port`, so both run on the gateway's
  single listener — no worker server, no 307, no second port. `src/server/runtime.ts`
  builds one shared store/catalogue lazily on the first request (`.env` loaded
  there, never at import). The boot document's root — `api_root` on the
  wire (CORRECTED IN PLACE 2026-11-11: this named the retired `rootPath` field, which
  survives only as the browser client's own property, `src/frontend/api.ts:1650`) — is
  the canonical API URL (`/v1/harness`), not a filesystem root: file tools resolve against
  `process.cwd()` and have no sandbox, so advertising a workspace root would be a
  lie. `variables.root` is the service's database boundary, not a workspace. The
  handler selects a runtime keyed by that resolved root, and the runtime writes the v2
  shard tree under `<root>/harness/` — `index.json`, one `sessions/<id>/session.json` per
  session and one `sessions/<id>/threads/<threadId>.json` per conversation (see
  persistence.ts); restoring rebuilds the registry
  first, then each session's frozen harness, then its core snapshot. Restore is
  best-effort PER SESSION, and it separates two degrees of staleness. A stale name in
  the snapshot's ENABLED set (`core.discovery.enabled`) is PRUNED, never fatal: the
  store filters that list through `harness.isToolSwitchable(name)` immediately before
  `harness.restore()` (`pruneStaleEnabledTools`, `src/server/sessions.ts`; the predicate is
  `src/types/index.ts` `Harness.isToolSwitchable`), switching off only what this rebuilt harness
  could never
  call, keeping every other name in the order it was committed, and COPYING the
  snapshot rather than mutating it. A name the snapshot re-registers itself is exempt:
  a tool the session CREATED lives only in `createdTools`, so it is absent from the
  registry when the store decides, and `restore()` counts it as available
  (`src/harness.ts` `restore`). A vanished registration — a `search` key removed, a
  plugin unregistered, an app tool edited out of a harness card — therefore costs one
  switch, not the conversation, while the kernel stays strict for a snapshot handed to
  it directly (`src/harness.ts` `restore`'s own validation); a CPU-isolated lane replica applies
  the same
  `isToolSwitchable` filter to its own rebuilt copy, for the record-rebuild reason that
  comment states (`src/server/workers/lane-worker-loop.ts`).
  THE SAME FUNCTION NOW PRUNES THE WITHHELD LIST TOO, against a DIFFERENT bar, and the
  difference is the session switch: `discovery.withheld` is trimmed to the names this build
  registers (or re-registers through `createdTools`) — never through `isToolSwitchable`, because
  a core declaration (`write`) and the pending-only `toolCancel` hold no cap slot yet their
  switch is the entire reason that list exists, so the cap predicate would discard a core disable
  at every restart. A dropped SWITCH stays silent — no tolerated-restore line, because "do not
  show the agents a tool we do not have" asserts nothing dangerous — while a dropped ENABLED name
  still reports one (`noteToleratedRestore`), and either way the pruned list is what gets
  restored AND what the next save writes, so a vanished name cannot ride in every later snapshot.
  The consequence for a user, stated plainly: a switch on a name that no longer exists is
  forgotten, and a name registered again later comes back ON.
  CORRECTED IN PLACE 2026-11-13: this passage named "a snapshot naming a renamed tool"
  among the DROP causes instead. That is precisely the case the new-session toolbox seed
  made ordinary (`SessionStore.create` passes `enableAllTools`, so a first save already
  carries every switchable name this deployment has not denied), where the drop silently deleted
  whole conversations;
  the tolerance is pinned by `src/server/restore-enabled-tool-prune.test.ts`, and
  `src/server/restore-isolation.test.ts` now pins the drop by renaming an AGENT.
  A record this build cannot rebuild for any other reason — a renamed agent
  (`src/harness.ts:15617-15623`), a model map naming a retired agent
  (`src/server/sessions.ts:3973-3981`), an inconsistent record — is still DROPPED,
  through the per-session catch in the load loop (`src/server/sessions.ts:1735-1741`),
  and answered as `404 Unknown session` afterwards, so one stale session can never make
  the whole server unavailable. Both kinds report through the SAME channel —
  `onRestoreError`/`SessionStore.restoreErrors` (stderr by default) — so the lines
  interleave and a host separates them BY TEXT, not by position
  (`src/server/sessions.ts:1818-1826`): a drop always states the reason (`Session "<id>"
  could not be restored: …`, `:4038-4053`), while a prune states that the session
  RESTORED and names what it switched off (`noteToleratedRestore`, `:3685-3703`), and
  only the pruned session is still in `list()`. The pruned set is that session's
  committed state from that moment: the store re-captures `session.core` from the live
  harness right after the restore (`:4013`), so the stale name is forgotten on the next
  save instead of re-reported at every restart. It is finer-grained still for
  transcripts, because those are user-editable: every host thread's stored `messages`
  is validated with `readHarnessMessages` BEFORE `harness.restore()`, and an unreadable
  one is neutralised with a valid `[transcript unreadable: …]` system placeholder while
  the raw value is retained in the additive `invalidThreads` roster — so one
  hand-broken conversation never costs the session (see “Persistent threads in the UI”
  below). Document-level corruption (unreadable file, bad JSON,
  unknown version, invalid record shape, a malformed `invalidThreads` map) stays fatal
  and leaves the file untouched. A running turn
  is marked interrupted and never replayed; pending background calls are
  interrupted, not resumed (a restored UI shows them abandoned, not running);
  branch records are not restored, and every recorded `action_request` is expired
  (the awaiting runtime is gone), so no question or branch is resumed;
  queued prompts are preserved but stay
  paused until an explicit submit or a cancel-all. When the snapshot ended between
  an assistant tool call and its result, restore appends explicit interrupted tool
  results for the unmatched ids (no re-execution), so the next provider request is
  coherent.
  **Durable network-failure auto-recovery (F1, 2026-11-17) — which does NOT touch the restart
  policy above.** A persistent conversation that keeps dying on the network no longer just
  rests: the store keeps a DURABLE per-conversation streak of consecutive NETWORK-CLASS run
  failures (`Session.networkFailures`, persisted as the additive
  `HarnessSessionRecord.networkFailures`; entries at 0 are pruned, so a healthy session's
  document keeps its exact key set) and, while that streak is STRICTLY BELOW the session's
  ceiling, calls its OWN resume path — `resumeThread`, the same one
  `POST …/threads/:threadId/resume` serves, which is what keeps the recovery honest about the
  status gates, the in-place requeue, the lane pump, the durability fence and the journal. The
  rule is written ONCE (`src/server/sessions.ts`, beside `INTERRUPTED_MESSAGE`) and implemented
  by `observeTerminalTurn` (bookkeeping, BEFORE the terminal checkpoint, so the number a resume
  or a restart reads is the one this run decided) and `autoResumeAfterNetworkFailure` (the
  resume, at the very END of `executeTurn` and synchronous up to the requeue's first await, so a
  `waitForIdle()` caller sees one continuous run of work instead of an idle window). `done`
  clears the streak; `error` on a network-class reason raises it, saturating AT the ceiling so a
  client rendering "n/10" never sees a number that lies about what is in control; a
  `cancelled`/`aborted` row touches NOTHING — a stop by intent is neither proof the network
  recovered nor a failure to count against it.
  - **What counts as network-class** is exactly the run stop reason `provider-network` — plus
    ONE bounded legacy allowance: `api-error` counts ONLY when the reason was carried in from
    disk (`Session.legacyNetworkReasons`, seeded at restore from the rows the document
    actually carried) AND the conversation's streak is still 0, so a record written before this
    vocabulary buys AT MOST ONE auto-resume per conversation per process, and the moment a run
    of this build terminalizes that row the allowance is gone for good. `retries-exhausted`
    never counts (it is a NON-network exhausted ladder) and neither does `timeout` — that
    reason is the host's own wall clock being enforced, an operator policy, not a connection
    dying; a provider bound that is missed arrives as a provider failure class and reaches this
    rule as `provider-network`. **What that class deliberately WIDENS, stated because a reader
    will otherwise narrow it back:** the transport's codeless `provider-transit` diagnosis is what
    the classifier trusts, and it covers a gateway frame the producer routes as `upstream_status`
    with a NON-refusal status (408 / 429 / any 5xx — `isTerminalProviderStatus` refuses to call an
    upstream's own 504 our request's fault, `src/transport/provider-timeouts.ts:510, 590-597`), a
    `decode`/`unknown`/absent code, and a body that closed without reporting a completion. Each of
    those is a network death that raises this streak, so a merely truncated or merely
    upstream-throttled endpoint can consume the FULL ceiling before the conversation rests — an
    over-trigger accepted on purpose, because the failure this work was asked to fix was a network
    death that counted as nothing and never resumed at all. An HTTP 4xx/5xx RESPONSE body, a
    malformed frame and a schema throw carry no such class and still land on `api-error` /
    `retries-exhausted`, which do NOT raise it.
  - **The ceiling** is `Session.networkResumeLimit`, resolved once per session by
    `networkResumeLimitOf` in one order: the per-provider `settings.networkResumeLimit`
    (`RunnerSettings`, `src/server/harnesses/types.ts` — a PROVIDER field, because it bounds
    what a flaky provider costs; validated in `mergeSettings`, so a bad value is a 400 naming
    the field rather than a silent coercion into an off-by-default feature), else the
    deployment runtime's `networkResumeLimit` (`HARNESS_PROVIDER_NETWORK_RESUME_LIMIT`, digits
    only, 0–1000, refused at startup by `resolveNetworkResumeLimit` naming the variable, and
    `0` = auto-recovery OFF — the honest spelling of "turn it off", not "resume once"), else
    `DEFAULT_NETWORK_RESUME_LIMIT` = **10** (`src/server/config.ts`). A ceiling read back from a
    hand-edited document outside that range is CLAMPED, not refused (a session the operator can
    still run beats one that fails to load). Both numbers are reported READ-ONLY on the
    snapshot pair — `SessionSnapshot.networkFailures` + `networkFailureLimit` and the same on
    `SessionView` (`src/server/protocol.ts`), omitted while no conversation is in a streak — and
    the per-conversation count rides on each roster row (`SessionThread.networkFailures` /
    `SessionThreadView.networkFailures`, absent at 0), so a host can render "n/10" without
    hard-coding the ceiling. Those are the SESSION DOCUMENTS (the store snapshot and the `/views`
    surface): the bounded canonical read `GET /v1/harness/sessions/:id` answers a `SessionResource`
    and carries NONE of them, so a REST-only client cannot see a streak and must not go looking for
    one there (`src/server/api-reads.ts`). The shipped shell does not read these fields yet — they
    exist for
    the client that will. A `reset()` clears every streak with the conversation it ends, and
    the abandoned-attempt evidence beside it; a host `…/resume` does NOT clear one — only an
    answered run does.
  - **Two runaway guards.** The durable streak is the primary bound; on top of it
    `Session.autoResumeClaims` caps how many auto-resumes the store will START for ONE turn row
    (in-memory by design — a restart is a fresh budget), and a disposed session, a store that is
    shutting down, or one still restoring is refused outright, so a restart never spends
    provider time by itself. A refusal here is deliberately silent: every one of them is a state
    the store already states correctly, and the conversation keeps its `stopReason` plus its
    streak, which is the honest explanation of why it is resting.
  - **What did NOT change, said because the two features are easy to conflate:** the restart
    policy is still **"mark interrupted, never replay"**. A turn that was running when the
    process died comes back `error` with its recorded events intact and is NOT re-run
    automatically, and a restored streak only COUNTS — `autoResumeAfterNetworkFailure` refuses
    while the store is loading, so the auto-resume door is the terminal path of a LIVE run
    (plus an explicit host `POST …/resume`), never the restore pass. The resumed attempt is
    requeued IN PLACE, so the evidence of the attempt it abandons is preserved by the journal's
    `rollback` line and the checkpoint's `turnRollbacks` map (see
    [IO workers](#io-workers-ioexecution-worker)).
  The loader's permissive CORS means no request header is a boundary there — and the
  standalone `X-Harness-Client: ui` gate is gone as well (T15,
  `src/server/handler.ts:8-13`), so the header is an inert marker on both hosts.
  Instead, the adapter rejects a browser `Origin` that is neither the request host
  nor loopback (`localhost`, `127.0.0.1`, `[::1]`), and allows requests with no
  `Origin`. That is not authentication: the service binds `0.0.0.0`, so anyone
  who can reach the port is trusted, and the tools are unsandboxed. Prefer a
  loopback host for the service when the port is reachable from untrusted
  networks; this package changes no global host/CORS setting.
- **Catalogue (`src/server/harnesses/`)** holds the presets and harness-level tools shared by
  the CLI and server. Presets are factories because a harness bakes its transport
  at construction. `toolbox.ts` owns the one shared toolbox and the factory every
  live preset uses, so the seven tool-bearing presets
  register the same tools and differ only in agents/instructions/routing. `chat` is the one
  card that opts out: `createProfiledHarness('general', [], …, { sharedToolbox: false })`
  (`presets.ts:387`) ships it with NO toolbox tools — only the harness-owned core rows
  (`toolRequest`, `tasks`) — and that posture belongs to the shipped TEMPLATE, not to a
  durable column: an executable patch that gives the card a TEAM rebuilds it through
  `liveFactory` → `createProfiledHarness(...)` with no toolbox argument
  (`src/server/harnesses/registry.ts:698-706`), which hands the shared toolbox back. There is no
  scripted template and no preset-specific extra tool any more: the `demo` and `flaky`
  example tier, the `testFlaky` tool and the scanned `examples` folder are deleted, so
  every shipped card is a live profiled harness that requires an endpoint. Every template is
  editable (R20.1): the registry copies it, metadata-only patches preserve the
  captured factory, and an executable patch rebuilds the harness as a live profiled
  harness. Every preset
  names its `entry` AND its `ranks` explicitly (never inferred); the six teamed presets each rank
  their own entry agent at A with every other member at B, so each registers
  `delegate`, while `general` and the tool-less `chat` card state ONE rank and get no delegate at
  all. Every
  agent keeps its own instruction. `src/server/harnesses/index.ts` exports
  `createToolCatalogue`, which snapshots the lazy `presetTools` metadata plus the
  harness tools plus the runtime `search` entry; it never executes or imports an
  implementation. `findPreset` resolves the legacy ids (`writer`/`assistant` →
  `instruct`, `researcher` → `research`) without listing duplicate cards. The
  server calls the catalogue builder after `loadEnvironmentFile()` and injects the
  result into the handler; the CLI calls it from `--tools`/`/tools`, which run
  after the same load.
- **UI (`src/frontend/`)** is only a client. It resolves its API root at runtime
  (`?apiRoot=` → the **“Harness server URL”** saved in this browser →
  `window.__HARNESS_CONFIG__.apiRoot` / meta tag → build-time
  `VITE_HARNESS_API` → the compiled Pages chain → `/v1/harness` on the page's own
  origin), then lists presets/tools, creates sessions,
  enqueues tasks (`POST /sessions/:id/tasks`, `202 TaskReceipt`), and observes the
  session through a subscription on the page's single `harness.v1` WebSocket,
  `GET /v1/harness/stream`, while work is pending (bounded poll as fallback).
  CORRECTED IN PLACE 2026-11-11: this named the deleted `GET /events` SSE watcher —
  `src/frontend/api.ts:6-9` states that the `text/event-stream` observer and its parsers
  are gone from the client and realtime lives in `src/frontend/stream.ts`. A `/…` composer
  line is submitted like any other task and answered as a server-side command turn —
  the client has NO command table of its own, because commands are server state and
  the UI is a renderer. The transcript dialog reads
  `GET /sessions/:id/threads/:threadId/transcript` and saves the parsed editor text
  through `PUT` (`src/frontend/api.ts` `getThreadTranscript` /
  `updateThreadTranscript`). Runtime
  absolute roots must be the
  page's own origin or loopback (`src/shared/origin.ts`, shared with the service
  Origin gate) because the saved provider key is posted to that root;
  `VITE_HARNESS_API` is operator-controlled and deliberately trusted across
  origins. The **saved “Harness server URL”** (step 2 of the ladder) is the other
  source the client trusts, and the only
  one a reader controls: the status pill opens **Endpoint & model**, the field at the
  top of that dialog edits it, and `Apply` — the dialog's ONLY button, at the bottom
  right — is the only thing that commits anything. CORRECTED IN PLACE 2026-11-13: this
  record named an `Apply & reconnect` action and a secondary `Reset` button; the dialog
  is one `Apply` and has no reset button. What the dialog shows is a DRAFT: the
  `Close` button, `Escape` and a backdrop click each discard it, and `Apply` writes the
  provider triple plus, when the URL changed, this key. A valid URL (a rooted path, or an
  absolute `http(s)` URL with no query, fragment, credentials or backslashes) is stored
  in NORMALIZED form under its own `underload-harness-app:api-root` key
  (`src/frontend/api.ts` `API_ROOT_STORAGE_KEY`, `saveApiRootSetting`), any `apiRoot`
  parameter is stripped from the address bar (that parameter outranks the saved value
  for the load it is on, so leaving it would undo the save), and the page reloads — the
  root is resolved once at module load, so a reload IS the reconnect; an unchanged URL
  commits with no reload. `Enter` inside any text field of the dialog IS that `Apply`
  press (`src/frontend/main.ts` `commitFromEnter`), so it is exactly one commit and never a
  form submit or a bare reload, and it does nothing at all when the keystroke is an
  input-method confirming a candidate (`isComposing || keyCode === 229`, the same guard the
  composer's Enter handler runs). Applying a blank field deletes the key and restores automatic
  resolution, which is now the only reset affordance; a refused value is reported inline
  and stores nothing. A saved cross-origin host is accepted on the
  reader's own authority, so what decides whether it answers is the service Origin
  gate, CORS and the browser's mixed-content rule (an https page cannot dial a
  plain-http harness). The value never enters a request body: the dialog's base URL /
  API key / model triple is the PROVIDER, and where the UI dials is a separate
  decision; the triple is the same draft, so `Apply` is what saves it, and the model is
  always one the endpoint advertises — editing the base URL debounces a
  `POST /v1/harness/models` for the draft settings by ~500 ms, the SERVER performs the
  upstream `GET {base}/models` because it owns the credential (the key is never sent back
  to the browser), and the ids it answers repopulate the Model dropdown, which is
  select-only: there is no input in which to type an id. That debounced lookup is a PREVIEW:
  its answer paints the dialog's dropdown and nothing else, and an answer from a preview the
  reader dismissed or overtook is dropped rather than painted (`src/frontend/main.ts`
  `modelTicket`). The catalogue the rest of the app dials moves only on a COMMITTED lookup —
  the one boot arms for the saved settings even when the dialog is already open, and the one
  `Apply` arms once the draft IS the record — and `Apply` publishes only when the list on
  screen was fetched for exactly that (Base URL, API key) pair, because a blank key on the
  configured origin means the SERVER's key
  (`src/shared/harness-api.ts` `RunnerSettingsInput.api_key`), so the same URL legitimately
  answers with a different list once a key is typed. Reopening spends no request when the
  published catalogue already answers for that pair: `seedModelPreview` seeds the dropdown
  from it, and arms exactly ONE committed lookup when nothing is known about it. A saved root
  also pins a Pages
  host — the compiled chain is a fallback, never an override. It imports no harness code
  and no `node:` built-ins, which is why
  `node-stub.ts` and the source alias were deleted. To drive the service host
  from the built UI:
  `http://localhost:5180/?apiRoot=http://localhost:5000/v1/harness` — the Vite
  dev/preview origin is loopback, so the Origin gate allows it.
  On a phone (`max-width: 860px`) both rails are **collapsed by default** and the
  topbar grows one toggle per rail (`main.ts` `setRailOpen`): the two are
  mutually exclusive, a backdrop click or `Escape` dismisses the open one, and
  leaving the breakpoint clears the state so a resize cannot resurrect a dismissed
  rail. The rails stay in the DOM — CSS only hides them — so their content and
  state survive a toggle, and wider layouts ignore the state and show both rails
  permanently. A shut drawer also PARKS the scratch board's live data plane — the
  panels' rows, disclosures and filter survive the toggle untouched, while their read
  and their realtime registration are released until it opens again (see
  [Live shell panels](#live-shell-panels-harnesstasks-harnessrecords)).
  `src/frontend/rail-toggle.test.ts` pins the DOM of this contract. The composer's agent chip
  deliberately does NOT follow this width: its press semantics branch on the primary pointing
  device — the single positive `(pointer: fine)` claim, `main.ts` `finePointerMedia` — so a
  700px-wide desktop window still cycles with `Tab` and a landscape phone past 860px still taps
  and press-and-holds; `src/frontend/composer-control.test.ts` and
  `src/frontend/composer-agent-cycle.test.ts` stub the `(max-width: 860px)` and
  `(pointer: fine)` queries independently so neither can leak into the other. See
  [Task queue and presentation](#task-queue-and-presentation-r4r5) → **Composer agent chip**.
  Above the phone breakpoint each rail is **resizable**. A `role="separator"` seam sits in
  its own 6px grid track between the rail and the chat (`src/frontend/ui/rail-resize.ts`),
  and a drag writes `--rail-left-width` / `--rail-right-width` on `.shell` — the two
  custom properties `.shell { grid-template-columns }` reads — never a `width` on the
  rail, because a grid item is sized by its track. No width is stored anywhere: a reload,
  like a double-click on a seam, returns the stylesheet's 248px / 320px, and the chat
  keeps a 320px floor so a rail can never be pulled over the transcript. Both seams are
  hidden on a phone (the rails are fixed-width drawers there) and only the right one on a
  tablet (the scratch board is a full-width strip). The board's own live-ness signal is the
  one `main.ts` `scratchRailVisible` reads — `!isPhoneLayout() || openRail === 'right'` — so
  the panels are dormant on a phone until the drawer opens and live on tablet and desktop
  whatever the drawer state is. That value is published on every `paintPanels()`, which
  `setRailOpen()` (including the branch where the harness drawer displaces the board) and
  both branches of the breakpoint handler call. A drag re-runs the reflow a window
  resize does (`main.ts` `reflowLayout`), so the composer's grown height, the scratch
  button's anchor and the notched routing label re-measure against the new chat width.
  `src/frontend/ui/rail-resize.test.ts` pins the drag, keyboard, clamp and reset.

### API

**One mount, one dispatcher.** CORRECTED IN PLACE 2026-11-11: this section opened with
"`/api` is the standalone mount; the `@underload/service` host serves the same paths
below `/v1/harness`". There is now exactly ONE mount on BOTH hosts:
`STANDALONE_MOUNT = SERVICE_MOUNT = HARNESS_API_ROOT = '/v1/harness'`
(`src/server/api.ts:307-308`), and the paths below are the contract's
(`HARNESS_PATH_TEMPLATES`, `src/shared/harness-api.ts:54`). Every collection read is
paged (`HARNESS_PAGE_LIMIT` — `limit` default 25, max 100, plus an opaque `cursor` —
`src/shared/harness-api.ts:51`), every write answers a SLIM RECEIPT
rather than the mutated aggregate, and request/wire field names are snake_case
(`thread_id`, `agent_models`) while the display subtree keeps the domain's camelCase
(`src/server/api.ts:30-38`). Full table with every receipt shape: README's endpoint
table.

| Route | Purpose |
|---|---|
| `GET /v1/harness/health` | Liveness and session count (`{ ok, sessions, epoch }`, `src/server/api.ts:1675-1680`) |
| `GET /v1/harness/harnesses` | Harness definitions, **paged** (`q` matches name/title/description); every entry is an editable application copy and `editable` is always `true`. CORRECTED IN PLACE 2026-11-11: this row also used to promise "provider defaults, and `agents`" in the same answer — defaults are `GET /config` now and the registry is `GET /agents`, each its own bounded page |
| `POST /v1/harness/harnesses` | `{ name, title?, description?, agents, entry?, ranks?, agent_models?, agent_instructions?, agent_colors? }` → `201 { harness }` (`agents` is the ONLY roster field, in declaration order, and is REQUIRED beside `name`; `entry` defaults to its first name and `ranks` may cover fewer members than the roster. CORRECTED IN PLACE 2026-11-11: these fields are snake_case on the wire, not the old camelCase `agentModels`/`agentInstructions`, `src/shared/harness-api.ts:643-652`; CORRECTED AGAIN 2026-11-18: `primary`/`subagents` are gone from the contract — the row is `entry` + `ranks`, and `AgentRank` is the 26-letter enum at `src/server/harness.swagger.yaml:4587-4593`) |
| `PATCH /v1/harness/harnesses/:name` | `{ title?, description?, agents?, entry?, ranks?, agent_models?, agent_instructions?, agent_colors? }` → `{ harness }`; every template is patchable, `entry` re-targets routing ALONE (an omitted `entry` keeps the current one while it stays a member and otherwise falls back to the new roster's first agent), `ranks` REPLACES the authority map (`{}` clears every rank, an omitted map keeps the ranks of the surviving members), and each other map field REPLACES the map it names |
| `GET /v1/harness/harnesses/:name` | `200 { harness }` — one definition with the IDENTIFIED read's own projection, `agent_instructions` included when the card overrides any; the paged listing omits that map, so the configuration dialog reads the single card it opens. A legacy NAME alias (`writer` → `instruct`) resolves to its target; unknown is `404` |
| `DELETE /v1/harness/harnesses/:name` | `200 { deleted: true, harness_name, tombstoned, restored_by_restart: false }`; `404` unknown name or repeat delete (name aliases are not deletable identities); `409` while a live or restored session belongs to that exact canonical harness — the message names the count, nothing is removed, and no session is cascaded, so each owned session must be deleted individually (`DELETE /v1/harness/sessions/:id`; there is deliberately no bulk delete) before the retry answers `200`. Removes a user harness or a shipped built-in; a built-in's name is persisted in the database's additive `deleted` list so a restart keeps it removed. A session still keeps the frozen definition it captured, which is exactly why the route refuses while any remain: a conversation must never outlive its harness card as an orphan the UI cannot reach. **T6:** after the registry write succeeds, the route also removes every knowledge article ATTRIBUTED to this canonical harness (`KnowledgeArticle.harness`) from the shared base and awaits the store's flush before the `200`; other harnesses' articles, unowned/legacy rows and Storyline records survive, and the base is never reset. The two stores are not transactional: a cleanup/flush failure after the committed harness delete answers `500` naming the partial outcome (the harness is gone; a repeat DELETE is `404` and does not retry the cleanup) |
| `GET /v1/harness/agents` | Trusted agent registry (`AgentDescriptor[]` rows), **paged** |
| `GET /v1/harness/tools` | The host-wide catalogue, **paged**: session-bound core entries (`group: 'Core tools'`, `sessionBound: true`) plus every directly callable tool (including the core file tools); `search` always present with `availability` |
| `GET /v1/harness/tools/:id` | One catalogue entry with its argument schema. CORRECTED IN PLACE 2026-11-11: this row replaces the deleted `GET /api/tools/bootstrap` alias ("the list the root bootstrap document carries") — the boot document carries no catalogue any more |
| `POST /v1/harness/tools/:id/executions` | `{ parameters }` (the only accepted body field) → `200 { ok, result \| error, duration_ms, panels?, media? }`, run against the DEPLOYMENT catalogue with no session. A `sessionBound` name is a `403` naming the session route (`src/server/api.ts:2572-2574`); a listed-but-unconfigured tool is `200 { ok: false, error, duration_ms }` carrying the catalogue hint (`:2587-2589`); an unknown name is `404` whatever the body. CORRECTED IN PLACE 2026-11-11: the deleted `POST /api/tools/:name` route took `sessionId` in the BODY instead. See the R8/N4 note below |
| `GET /v1/harness/sessions/:id/plugins` | ONE conversation's plugin rows, **paged** by the global read's rules (`limit`/`cursor`/`q`; the catalogue itself is not session state — every store is seeded from the same generated manifest, so rows and defaults are identical and only the resolved `enabled`/`values` differ). Identity FIRST: an unknown session is a `404` before any paging parameter is read (`src/server/api.ts:2771`). `X-Harness-Revision` is that session's OWN store counter — 0 until this session accepts a `PATCH`, one bump per accepted write, and it never moves the template counter or vice versa |
| `GET /v1/harness/sessions/:id/plugins/:plugin_id` | One row of that conversation's store (`src/server/api.ts:2834`) |
| `PATCH /v1/harness/sessions/:id/plugins/:plugin_id` | `{ settings }` → `{ plugin }`, write-anytime: no idle gate and no `409` path at all, because a settings write moves no registration and removes no schema the model was promised — the same reason the session TOOL switch (`enabled`-only `PATCH …/tools/:tool_id`) is write-anytime since the withheld set; `assertIdleForToolMutation` (`src/server/api.ts`) now gates only the tool writes that replace or remove an implementation (a source/metadata PATCH, and `DELETE`). Unknown session/plugin is `404` BEFORE the body is read; an unknown key, a wrong type or an out-of-range value is the store's `400`, thrown before it mutates, so a refused patch is a no-op on this conversation. Durable before the answer, and honoured from this session's next turn (`src/server/api.ts` `patchSessionPlugin` → `SessionStore.updateSessionPluginSettings`, `src/server/sessions.ts`) |
| `POST /v1/harness/sessions/:id/tools/:toolId/executions` | Same body, executed through THIS session's registry (`SessionStore.callTool`, `src/server/api.ts:4605-4620`): a replaced preset, a created tool and a session-owned core tool all run what the session holds. `404` a name the session does not list, `409` a busy session, `403` a name whose execution scope is not manual. CORRECTED IN PLACE 2026-11-11: this row replaces the deleted `POST /api/tools/:name/call` alias |
| `POST /v1/harness/models` | `{ settings? }` → `{ models, observed_at }` (the generated `ModelIndex`); server-side `listModels`. CORRECTED IN PLACE 2026-11-11: the old answer was the bare `{ models: string[] }`, and `observed_at` is now part of the contract (`src/server/models.test.ts:16-18`) |
| `POST /v1/harness/sessions` | `{ harness, title?, settings?, messages? }` → `201 { session }`. The harness NAME is the only requirement (`src/server/api.ts:2979-2983`), and `messages` is the optional seeded transcript, validated BEFORE anything exists (`src/server/api.ts:2985-3012`). Session creation is its own operation, not a side effect of a first task: the id is the server's `randomUUID()` (`src/server/sessions.ts:2298`), the session's plugin-settings store is copied from the template at this moment (`:2268`), and the record is written before the answer — a failed write deletes the in-memory entry so a retry cannot observe a phantom (`:2358-2366`). A client holding a `201` may therefore `POST /sessions/:id/tasks` immediately with no retry loop, which is exactly what the UI's `+` relies on (`src/frontend/main.ts:6308` `ensureSession`) |
| `GET /v1/harness/sessions`, `GET /v1/harness/sessions/:id` | BOUNDED reads, never a snapshot: the list is paged (`limit`/`cursor`, plus `status`/`harness` filters) and one session is its metadata + live `agent_models` + counters. CORRECTED IN PLACE 2026-11-11: this row used to promise "always including `turns` (with `eventTimes`) and the frozen `harnessDefinition`" — turns (`/turns`), threads (`/threads`), the queue (`/queue`), the frozen definition (`/definition`) and the display trees (`/turns/:turnId/display`) are each their own route, and no route assembles a session aggregate (`src/server/api.ts:22-23`). The old additive `invalidThreads` roster is not a session field on this contract either: an unreadable conversation is reported on the transcript read (`transcript_state: 'unreadable'` + `unreadable_reason`, `src/shared/harness-api.ts:2934,2950`). **F7 (2026-11-17) does add one session field: `inactive_thread_ids`** on the identified read (`SessionResource.inactive_thread_ids`, `src/shared/harness-api.ts`; emitted by `sessionResourceOf`, `src/server/api-reads.ts`) — the ids of this session's SOFT-DELETED conversations, ADDITIVE and ABSENT while it never deleted one, sorted by id so a repaint is byte-stable. WHY IT EXISTS: the roster (`GET /sessions/:id/threads`) HIDES those rows and so does the turns page — the right listing rule for a client that WATCHED the delete — but after a RELOAD the client never saw it, and "the roster stopped naming this id" is not evidence: it is indistinguishable from a conversation that never existed, which is exactly why the board painted a retired conversation's sections again. Widening the roster filter is the wrong remedy (it is the single place every roster comes from — `threadRoster` feeds `snapshot()`, `viewOf()` and `viewSummaryOf()`, and `threadRecordsOf` mirrors it for REST — and the gate several routes lean on), so the deletion fact travels BESIDE it and the roster keeps meaning exactly "the conversations this session can still run". The predicate is the one the turns page already hides with: `retiredThreadIdsOf` = the durable `Session.inactiveThreads` ledger UNION the `inactive: true` marks on the retained rows (both restored from the shard), and the in-process twins are `SessionSnapshot.inactiveThreads` / `SessionView.inactiveThreads` (`src/server/protocol.ts`, filled by `SessionStore.inactiveThreadIdsOf` from the same two sources — the WIDE answer, so a ledger that missed one hydration cannot under-report a deletion while the roster filter keeps its narrow one) |
| `PATCH /v1/harness/sessions/:id` | `{ agent_models: { agent: model } }` (and/or `title`, where `null` clears it) → `{ session }`. Merges into the live map, validates every key against the session's agents and every value as a model id (400 with nothing applied), rejects `{}` as a no-op, is allowed while the session is busy (no abort/rebuild), and leaves the frozen definition untouched. The current request keeps the model it started with; the next request uses the new one. CORRECTED IN PLACE 2026-11-11: the body field is `agent_models`, not `agentModels` |
| `POST /v1/harness/sessions/:id/tasks` | `{ input, attachments?, references?, thread_id? }` → `202` **`TaskReceipt`** (`{ session_id, turn_id, status, thread_id, … }`, `src/shared/harness-api.ts:2280`) — a task receipt, never the mutated document. Server-queued FIFO task: the turn is `queued`, has a stable id/index, and has no `startedAt` until the pump starts it. Cap 100 pending (`429`); queued turns are durable with a database root and paused after a restart. An `input` starting with `/` is a **slash command**: `dispatch()` runs it in this process through `harness.executeCommand`, never calls the model, never enters a lane, and returns the ALREADY-TERMINAL turn (`status: 'done' \| 'error'`, events `start`/`tool_call`/`tool_result`, no `usage`); `attachments`/`references` are `400` and `thread_id` is accepted and ignored. A `thread_id` that is RUNNING steers instead of queueing. CORRECTED IN PLACE 2026-11-11: the old answer was `202 { session, turn }` and the field was camelCase `threadId` |
| `GET /v1/harness/sessions/:id/threads/:threadId/transcript` | `{ transcript }` = the transcript's cheap HEAD: `transcript_state`, `message_count`, `chars`, `bytes`, `role_counts`, `revision` (plus `unreadable_reason`/`stored_type` when it could not be parsed) — NO content. The messages are the paged `…/transcript/messages` read and the editor's JSON document is `…/transcript/document` (`src/shared/harness-api.ts:2930-2956`, `src/server/api.ts:4899-4911`, messages `:4913-4959`, document `:4961-4985`). `404` unknown session/thread. CORRECTED IN PLACE 2026-11-11: this row described the retired `{ threadId, agent, messages, raw, invalid? }` document |
| `PUT /v1/harness/sessions/:id/threads/:threadId/transcript` | `{ messages, if_revision? }` → the **`TranscriptWriteReceipt`** (`{ session_id, thread_id, accepted_as, message_count, revision, invalid?, links? }`, `src/shared/harness-api.ts:3039-3063`). Wholesale transcript replace. A structurally invalid value is still a **200**: it is persisted, the live transcript becomes the `[transcript unreadable: …]` placeholder, and `receipt.invalid` explains why. `400` absent `messages`/non-object body, `404` unknown thread, `405` other methods, `409` running thread or a harness handle without `setThreadMessages`. CORRECTED IN PLACE 2026-11-11: the old answer was the `{ session, transcript }` aggregate |
| `GET /v1/harness/stream` | The ONE live-update channel: a **WebSocket** upgrade on the `harness.v1` subprotocol (`src/shared/harness-api.ts:42`); a plain `GET` is a `400` naming the upgrade (`src/server/api.ts:4759`). Frames, scopes and recovery are in the live-plane note below. CORRECTED IN PLACE 2026-11-11: this row replaces the two deleted SSE rows — `GET /api/sessions/:id/events` (the watcher) and `POST /api/sessions/:id/messages` (the run-owning stream whose close aborted the harness). Neither is aliased, and dropping the socket never cancels a task because execution is server-owned |
| `POST /v1/harness/sessions/:id/reset` | Reset every agent + discovery + tasks + record stores → the **`ResetSessionResult`** receipt (`{ reset: true, session_id, discarded_turns, discarded_threads, dropped_queued_tasks, revision }`, `src/shared/harness-api.ts:2323-2331`); `409` while a run or queued work is pending |
| `POST /v1/harness/sessions/:id/threads/:threadId/cancel` | `{}` → `200 { cancelled, thread_id, session_id, status, dropped_queued_tasks, revision }` (the generated `CancelThreadResult`, `src/shared/harness-api.ts:2894-2918`). `cancelled` is the STORE's honest answer: true exactly when this call terminated work — an aborted run, a turn released from a reference PARK (its lane had claimed work the runtime never started), or at least one dropped queued continuation, counting the named conversation and every conversation it owns; false when the stop only marked the conversation `stopped`. `status` is the conversation's real post-stop status read from its own record (never a constant), `dropped_queued_tasks` is the NAMED conversation's own backlog measured before the stop (a floor, not the cascade's total), and `revision` is the thread resource's counter the roster repaint reads |
| `DELETE /v1/harness/sessions/:id/threads/:threadId` | `200 { deleted, thread_id, session_id, removed_descendants, removed_turns, revision }` (the generated `DeleteThreadResult`, `src/shared/harness-api.ts:2880-2888`). Stops that conversation first (the cancel above, so live and queued rows are dropped as `cancelled`) and only then purges it: the conversations it owns, their owning turns, transcripts and persisted copies. The agent's own `agent:<name>` conversation is `400` (use reset) |
| `POST /v1/harness/sessions/:id/cancel` | `{ all?: true }` → the **`CancelSessionResult`** receipt (`{ cancelled, session_id, dropped_queued_tasks, active_turn_id?, revision }`, `src/shared/harness-api.ts:2349-2358`). Default aborts the active run only; `all: true` (the UI's Stop) also cancels every queued turn, which stays in `/turns` as a `cancelled` row. CORRECTED IN PLACE 2026-11-11: the old answer was the bare `{ cancelled }` |
| `POST /v1/harness/sessions/:id/actions/:requestId/answer` | `{ choice: { kind: 'option', option_id } \| { kind: 'custom', text } }` (the generated `AnswerActionRequest`, `src/shared/harness-api.ts:2633-2635`; the domain type is `HarnessActionChoice`) → `{ ok: true, request_id, resolved_at }` (`src/server/api.ts:3570-3585`). Settles one pending `actionRequest`; 400 invalid body/unknown option/out-of-bounds text, 404 unknown session or request id, 409 answered or expired. Allowed while busy |
| `DELETE /v1/harness/sessions/:id` | Forget the session → the **`DeleteSessionResult`** receipt (`{ deleted: true, session_id, aborted_turns, dropped_queued_tasks }`, `src/shared/harness-api.ts:1450-1457`): abort active work, drop queued work, close watchers |
| `GET /v1/harness` | The **boot document**, on this host AND on the standalone listener: `{ api_root, service, api_version, server_time, epoch, capabilities, limits, links }` — CONSTANT SIZE, no catalogue, no defaults, no sessions (`src/server/api.ts:1643-1670`). CORRECTED IN PLACE 2026-11-11: this row was "Service only: bootstrap `{ rootPath, presets, agents, tools, defaults, sessions }`" — both the fat `{ rootPath, presets, … }` payload and the "service only" asymmetry are gone |

**Two settings scopes, three catalogue scopes.** The table's process-level rows and its
session-level rows are not two views of one store, and the difference is a contract:

- **Plugin settings** have BOTH scopes. `GET/PATCH /v1/harness/plugins[/:plugin_id]` read
  and write the TEMPLATE store (`src/server/api.ts:2594` → `SessionStore.pluginSettings`,
  `src/server/sessions.ts:1998`), so an accepted write changes what every session CREATED
  AFTER IT inherits and nothing that already exists; `GET /v1/harness/sessions/:id/plugins[/:plugin_id]`
  and `PATCH /v1/harness/sessions/:id/plugins/:plugin_id` move ONE conversation's values,
  honoured from its next turn (`SessionStore.updateSessionPluginSettings`,
  `src/server/sessions.ts:2055`). A session's store is a detached copy taken at creation
  (`copyPluginSettingsStore`, `src/server/plugins.ts:713` → `src/server/sessions.ts:2268`) and
  persisted on its own record (`src/server/persistence.ts:293`, restored at
  `src/server/sessions.ts:3677`), so there is no override layer, no merge and no
  "inherit unless changed" flag to reason about — two stores simply share no map
  (`src/server/plugins.ts:23-28`). A CPU-isolated lane replica gets the SESSION's snapshot in
  its `hello` blueprint, never the template's (`src/server/plugins.ts:107-121`).
  **There is no third plugin scope, in either direction.** A harness TEMPLATE carries no
  plugin settings at all — `HarnessPresetRecord` has no such field, and the two durable homes
  are the document and the session record (`src/server/persistence.ts:495` and `:293`) — so a
  "this harness's plugins" scope does not exist yet, and neither does a per-THREAD one: a
  conversation shares its session's store, which is why a lane replica resolves the SESSION's
  values (`src/server/plugins.ts:107-121`). Both are open work, not an omission of this
  document.
- **Tool settings have two scopes, and they are orthogonal.** The DEPLOYMENT deny list is one
  store per process (`src/server/tool-settings.ts`), consumed live by every harness, so
  `PATCH /v1/harness/tools/:id` is honoured on the next request of every session and thread —
  for the MODEL path only, because the manual execution path is deliberately not gated by it
  (`src/harness.ts` `executeToolInternal`). It outranks the conversation's own switch in BOTH
  directions: a session cannot lift a denial, and a denial that lands mid-life rewrites none of
  a session's rows. The SECOND scope is the conversation's own switch:
  `PATCH /v1/harness/sessions/:id/tools/:tool_id` with an `enabled` field writes that harness's
  `withheldTools` set (see [Tool discovery](#tool-discovery)), and it reaches EVERY registered
  name — the core declarations (`toolRequest`, `tasks`, the file tools, the thread group, a
  configured `search`/`fetch`, `delegate`) and the pending-only `toolCancel` included.
  `GET /v1/harness/sessions/:id/tools[/:tool_id]` reports that toolbox (`sessionToolRowsOf`,
  `src/server/api-reads.ts`) on two row axes that replaced the old pair: `enabled` is the CALL
  axis (`!withheld && (holds a cap slot ? in the capped set : true)`), and `protected` is the
  UNREGISTER axis — `visibility === 'core'` read from the live registry map, i.e. the kernel's own
  `toolManage remove` rule (`src/harness.ts`) restated from the same map the delete route asks.
  `declared` is unchanged: membership in the frozen definition's `coreTools`.
  CORRECTED IN PLACE 2026-11-13 — this bullet carried three claims that the session switch
  retired, and the record matters because each one is a status code a client still expects:
  (1) "a session tool write needs the session idle". Only a write that REPLACES or REMOVES an
  implementation does. `assertIdleForToolMutation` (`src/server/api.ts`) still gates `DELETE`, the
  source/metadata half of a PATCH, and a PATCH that restates BOTH the declaration and the gate —
  whose consequence the route publishes rather than hides: that `409` can arrive with the new
  revision already installed and the switch unchanged. The `enabled`-only PATCH has no idle gate
  and answers `200` while a thread RUNS, because the withheld set is read per model request and
  per launch, so the switch lands on that thread's very next request; (2) "a name the session's
  kernel CANNOT switch refuses a disable/unregister with `403`". The switch PATCH no longer `403`s
  anything: its refusals are the `404` for a name this session does not list and the `400`s of its
  own body validation, plus the runtime's race `409` for a name that stopped being registered
  between the row and the write. `403` survives on exactly one axis — `DELETE` of a `protected`
  row; (3) "`protected` is `!harness.isToolSwitchable(name)`, so the rendered row and the status
  code are one fact". It is one fact again, but a different one, and the swap runs in BOTH
  directions: `toolCancel` used to be reported protected and is now `protected: false` (it
  registers at `visibility: 'searchable'`, so `remove` accepts it — while `DELETE`ing it still
  answers the `400` for a name this session never registered itself, because it is INHERITED), and
  `write`/`read`/`edit`/`glob`/`grep`/`fetch`/`toolRequest`/`tasks`/`delegate` stay
  `protected: true` while their SWITCH answers `200` and takes effect on the running thread. The
  kernel's old switch-time sentence ("…is a core declaration; it is always in context…") is gone
  from `src/harness.ts` together with the refusal it explained; the sentence that remains for a
  core name — "is a core harness tool and cannot be unregistered" — belongs to `DELETE` alone, and
  that is precisely the `403` the row predicts.
  Unchanged from the previous pass, and still worth stating: `DELETE` of a seeded or otherwise
  enabled catalogue row answers `200`, because its row is `origin: 'discovered'` ahead of the
  "inherited … has no session-local registration to remove" `400` (`src/server/api.ts`
  `deleteSessionTool`).
- **A harness template** is a third scope again: `GET/PATCH/DELETE /v1/harness/harnesses/:name`
  edit the definition, and an existing session keeps the definition and the agent-model map
  it froze at creation, so a template write never reaches a live conversation either. The
  DELETE is the one harness write that consults sessions at all: it answers `409` while any
  live or restored session's `preset.name` still equals the direct name being deleted (delete
  those sessions first, one at a time), because the frozen copy a session keeps is precisely
  the orphan state that guard removes.

CORRECTED IN PLACE 2026-11-13: this paragraph is new, and it retires the sentence in
`docs/plugins.md` ("an accepted PATCH changes what every existing session and thread does
on its very next turn") as the description of the plugin routes — that survives only for the
TOOL switch and for a write inside one scope.

There is ONE mount and no alias left. CORRECTED IN PLACE 2026-11-11: this paragraph
still described `/api` as a live second root with `/presets` aliases. The `/presets`,
`/views`, `/tools/bootstrap`, `/tools/:name/call` and `/sessions/:id/messages` aliases
were deleted rather than kept behind a flag, and so was the second mount:
`STANDALONE_MOUNT = SERVICE_MOUNT = HARNESS_API_ROOT = '/v1/harness'`
(`src/server/api.ts:307-308`, `src/shared/harness-api.ts:39`). A request under any other
mount answers a 404 that NAMES the root — `This server serves /v1/harness; "/api" is not
mounted.` (`src/server/api.ts:4845-4846`). The bare `/v1/harness` answers the boot
document on BOTH hosts; the dispatcher's `bootstrapRoot` flag is kept for source
compatibility only and no longer changes behaviour (`src/server/api.ts:394-396`). The
root URL in that document is `api_root` on the wire
(`src/server/api.ts:1947`, mapped to the client's `rootPath` at
`src/frontend/api.ts:1650`) and it is the API URL `/v1/harness`, not a filesystem path.

**Body policy (the one mount).** Action endpoints require a JSON object; `null`,
arrays, and primitives are `400`. An execution body is a wrapper object and
`parameters` is its only accepted field (`requireKnownFields`,
`src/server/api.ts:544`, `:2568`, `:4605`) — an unknown field is a `400`, while an ABSENT
`parameters` is the same empty argument box as `{ "parameters": {} }`
(`src/server/api.ts:2579-2583`). CORRECTED IN PLACE 2026-11-11: this paragraph used to
say `POST /tools/:name` *requires* a `parameters` property, "so an empty body cannot run
a tool" — that was the deleted route's rule. An unknown tool name is `404` whatever the
body looks like. Bounds: the Node adapter stops a streamed body over
1,000,000 bytes with `413` (`MAX_API_BODY_BYTES`, `src/server/api.ts:312-315`); the
service adapter checks declared `content-length`
and the serialized parsed body before dispatch. The service loader parses JSON
before the endpoint runs, so it cannot prevent that upstream allocation and a
parse failure arrives as `{}` — a documented residual, not something this package
can fix.

**R13: the manual route validates and bounds like the model path.**

- The direct (session-less) runner resolves `parameters` through
  `resolveToolParameters(schema, raw, 'direct')` before `execute` sees them. Both
  documented shapes therefore work — the legacy unwrapped value (a bare array for a
  single-property schema, or `files([{ op: 'list', path: 'src' }])`) and the schema
wrapper (`{ "ops": [{ op: 'list', path: 'src' }] }`) - and a wrong type is a `{ ok: false }` tool error with a
  JSON path instead of an implementation crash. `null` is normalized to `{}`.
- Result and error TEXT share the model-facing per-result cap (`boundToolResult` in
  `src/core/result-budget.ts`, 256 KiB, applied AFTER the `unwrapToolResult` peel of the
  `toolUi()` / `toolMedia()` / `toolText()` brands, so panels stay on their own limit, media
  rides on the message, and a tool that declared its own prose is measured on THAT text
  rather than on the escaped JSON of its result object). A result that fits is returned byte-for-byte unchanged; a result
  that does not is returned as the parsed truncation envelope
  `{ truncated, originalBytes, budgetBytes, note, content, tail }` — `content` is the HEAD
  preview, `tail` the end of the original text, and `note` says how many bytes were cut,
  which cap bit, and which call to re-run to get them back — so the HTTP body stays valid
  JSON with an explicit marker rather than a half-written document (the manual route has no
  transcript call to name, so its note says only "the tool call"). This is a
  post-serialization cap: it bounds the wire/context cost, **not** the process's peak
  memory (the tool's own budget has to do that). The MODEL path also bounds the SUM of one
  turn's results — `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES` (512 KiB) through the run's
  `createToolResultTurnBudget`, which spills the results that no longer fit through the same
  envelope and NEVER drops one, because a request must answer every `tool_calls[]` entry.
  A manual call has no turn, so the per-result cap is all it applies.
- A tool that exists only in ONE session's registry (created by `toolCreate`, or
  added by a plugin to that session's harness) is not in the static catalogue, so it is
  callable only through the SESSION route. There, a name the session's own listing does
  not carry is `Unknown tool "<name>" in session "<id>"`
  (`src/server/api.ts:4032` + `missing`, `:646-647`); asked of the global catalogue
  route it stays `Unknown tool "<name>"`. A tool that belongs to a SIBLING session is
  refused either by the store (`Tool "<name>" is not available in this session.`,
  `src/server/sessions.ts:4115`) or by that listing check — one session's tools are
  never listed or callable through another session's id. Listing surface: a created tool
  is registered and enabled at once, so `GET /v1/harness/sessions/:id/definition` reports
  its name in `discovered_tools` (`src/server/api-reads.ts:1697`);
  that key is emitted only when the enabled set is non-empty, and a session the server CREATED
  is seeded, so its first definition read already carries the toolbox
  (`src/server/sessions.ts` `create`) — as does one it RESETS (`SessionStore.reset`), CORRECTED IN PLACE
  2026-11-13 (F2-2): this sentence used to name "a `reset()`-ed conversation" as a case that
  reports an empty set, which is the LIBRARY behaviour only. What still reports an empty set is
  a library harness, a session whose every switchable name the deployment denies, or a
  conversation that switched its toolbox off and then merely restarted.
  `GET /v1/harness/tools` remains the static catalogue. CORRECTED IN PLACE 2026-11-11:
  this bullet reached the same lookup through a `sessionId` BODY field on the deleted
  `/api/tools/:name` route and read the discovery list off `GET /sessions/:id`.

**Core tools in the catalogue (R8/N4).** `src/server/harnesses/core.ts` DERIVES its
entries (T21 — CORRECTED IN PLACE 2026-11-11: the old text named a hand-written list of
eight entries and the dead `task`/`profileManage`/`chapterManage`/`locationManage` names,
and cited the path without its `server/` segment). The rows are every
`RUNTIME_DESCRIPTORS` row — `group === 'runtime'` and `listed !== false`,
`src/tools/descriptors.ts:326-328`, which today is `toolRegistry`, `toolRequest`,
`toolList`, `toolManage`, `toolCreate`, `tasks`, `records`, `profiles`, `chapters`,
`locations`, `knowledge`, `agentManage`, `agentResult`, `delegate`, `threadFork` and `actionRequest`;
`search`/`fetch`/`toolCancel`/`threadList`/`threadRead`/`threadSend`/`threadDelete`
set `listed: false` and stay out of the host-wide list) — added to the host-wide listing
(`GET /v1/harness/tools`), in the kernel's registration order. CORRECTED IN PLACE
2026-11-11: that list used to name the `/tools/bootstrap` alias and the root bootstrap
document — the alias was deleted with the legacy mount (`src/server/api.ts:12-15`) and
the boot document is constant-size with no catalogue at all
(`src/server/api.ts:1643-1645`), so the catalogue is its own bounded page. `delegate`, `actionRequest` and
`threadFork` are conditional in a session's harness (the rank map lets some agent
delegate / `interaction` configured / `forks.enabled`), but the host-wide catalogue always lists them; a session
without the capability answers a clear 404 rather than inventing them. Every row is
`group: 'Core tools'` and `sessionBound: true`, and its `visibility` is the
DESCRIPTOR's (`?? 'core'`), so a searchable core tool stays searchable. They
deliberately have **no** `tool` implementation:
there is one implementation of each (the session's harness). `SessionStore.callTool(id, name, parameters)` →
`harness.executeTool` is therefore the only path, and the ONE route that reaches it is
`POST /v1/harness/sessions/:id/tools/:toolId/executions` (`src/server/api.ts:4605-4620`,
mounted at `:4815`). CORRECTED IN PLACE 2026-11-11: this paragraph described the deleted
standalone `POST /api/tools/:name` route, which took `sessionId` in the BODY ("a
missing/blank `sessionId` is `400`"); the session now lives in the PATH, `parameters` is
the only accepted body field (`requireKnownFields`, `src/server/api.ts:4605`), and the
GLOBAL route answers a session-bound name with a `403` naming the session route
(`src/server/api.ts:2278-2281`). An unknown session or a tool the session's harness does not register
(delegate when no caller may delegate) is `404`, a name that is not callable manually is `403`
(`Tool "x" is not callable manually.`), a session with ANY operation in flight
(a streaming run, a reset, another manual call - the store's private `busy`
single-flight flag) or with queued work pending is `409`, a throwing tool is
`{ ok: false, error, duration_ms }`, and
success is `{ ok: true, result, duration_ms }` (plus optional `panels`/`media`,
`src/server/api.ts:616-626`). `PATCH /sessions/:id` is the one
exception to that gate: a model change is not a harness mutation, so it is applied
while a run streams and aborts nothing (see the route table above). Directly
callable entries keep their session-less runner, on the global route
`POST /v1/harness/tools/:toolId/executions` (`src/server/api.ts:2265-2310`); it takes no
`sessionId` at all, because a session that owns the tool moves into the PATH. The
metadata comes from the same discovered descriptors the runtime registration reads —
a live scan on Node, falling back to the generated `src/core/tool-manifest.ts` only in a
browser or scanner-less build (`src/tools/descriptors.ts`) —
so a descriptor cannot advertise a schema the runtime does not use.

**R18: core file/search/download tools are NOT session-bound.** `read`, `write`,
`edit`, `glob`, `grep`, `download`, and a configured `search` have
`visibility: 'core'` but
keep their real `tool` implementation and appear in the direct-call catalogue
(groups `Package presets` / `Web search`), so
`POST /v1/harness/tools/read/executions` works with no session at all;
`POST /v1/harness/tools/download/executions` returns the summary plus
`media` **descriptors**, never the base64. `sessionBound: true` remains exclusive to the eight
harness-owned entries above plus `delegate`, `actionRequest`, and `threadFork`
(the last two are still refused by the manual call path because they need the
owning run). The UI's core dropdown reads
`coreTools` from the descriptor, which is computed from the registered names and
therefore includes the file tools, adds `search` only when this host resolved a
key, omits `files` (and the other searchable tools), and matches the harness's
actual core declarations.

No request header is required anywhere. CORRECTED IN PLACE 2026-11-11: this paragraph
used to read "Every standalone request requires `X-Harness-Client: ui`" and "`curl` must
add it". That gate is REMOVED (T15, `src/server/handler.ts:8-13`): the header decides
nothing, a header-less `GET /v1/harness/health` is answered `200`
(`src/server/stream/standalone-stream.test.ts:130-133`),
and the requirement's absence is pinned by `src/server/models.test.ts:21` and `:337`.
The browser still SENDS the header as an inert marker (`src/frontend/api.ts:601`,
`:730`). What protects the standalone listener is that it sends no CORS headers at all
and binds loopback by default, so a foreign page has nothing to read; the service mount
applies the Origin policy to REST (`isAllowedOrigin`, `src/server/service.ts:165`) and
the stream upgrade applies the same rule (`src/server/stream/mount.ts:46`) — a policy
rule, not authentication, exactly as described above.

**The live plane is a WebSocket, not a stream of SSE frames.** CORRECTED IN PLACE
2026-11-11: this section described SSE as the current transport. Both SSE routes — the
run-owning `POST …/messages` and the watching `GET …/events` — are DELETED rather than
aliased (`src/server/api.ts:12-15`), and nothing streams over REST any more
("REST routes never stream", `src/server/api.ts:399`). The one live channel is
`GET /v1/harness/stream`, upgraded on the `harness.v1` subprotocol
(`HARNESS_WS_SUBPROTOCOL`, `src/shared/harness-api.ts:42`); a plain `GET` there is a
`400` naming the upgrade (`src/server/api.ts:4759`). Both frame vocabularies are CLOSED
and generated in `src/shared/harness-stream.ts`: client → server `hello` · `subscribe` ·
`unsubscribe` · `ack` · `ping` · `bye` (`:56`), server → client `welcome` ·
`subscription_state` · `update` · `resync_required` · `error` · `heartbeat` · `pong`
(`:59`). An `update` names one of sixteen kinds — the successors of the old frames are
`turn.upsert` (turn rows), `run.event` (opt-in raw events), `usage.updated` (the
server-summed figures) and `session.updated` — and no kind carries a session tree, so a
client reconciles rows instead of applying a snapshot.

The record-level facts those frames used to carry still hold, because they were never
transport facts: `at` is the server's epoch-ms stamp for a
record and is identical to the matching entry in `turn.eventTimes`
(`src/server/protocol.ts:207`), so a live view and a reload agree on elapsed time. The
turn's running token tally is summed by the SERVER (`{ input, output, total, cached? }`)
and published as the `usage.updated` figure (`src/server/api.ts:1309-1322`), so a client
prints the server's figure instead of accumulating one of its own, and a poll/reload
(`SessionTurn.usage`) shows exactly the same number.
`tool_result` events also carry the `callId` of the `tool_call` they answer, which
pairs same-name calls exactly.

Retired SSE frames (history only — these routes answer `404` now):

- Every SSE `data:` frame was `{ type: 'turn', turn }`, `{ type: 'event', turnId, event,
  at, usage? }`, `{ type: 'snapshot', session }`, or `{ type: 'failed', error, session }`.
  The two streams meant different things:
- `POST /messages` (legacy) opened with `turn`, then events, and ended with `snapshot`
  on success or `failed` on error/cancel. The response owned the run: its close
  aborted the harness, so a disconnected client did not keep spending provider time.
- `GET /sessions/:id/events` (watch) was NOT an owner. It opened with one `snapshot`,
  sent each `turn` as an UPSERT on the same id (queued → running → terminal), then
  event frames, and sent one `snapshot` when the queue drained; a reset also sent
  a snapshot (it deletes rows, so no upsert can express it). A disconnect
  only unsubscribed; the pump kept executing for nobody.

### Task queue and presentation (R4/R5)

`SessionStore` (`src/server/sessions.ts`) owns the queue; no response does.

- **Submit/accept.** `enqueue()` validates and applies the pending cap before any
  mutation, then appends a `SessionTurn` with `status: 'queued'`, a `randomUUID` id,
  the next `index`, and NO `startedAt`; it returns the accepted snapshot + turn and
  the HTTP layer answers `202`. A rejected submit (`400` empty/too long, `413`,
  `429` over 100 pending) leaves the session untouched.
- **Pump.** A private loop peeks the FIFO head (never shifts until it starts it),
  waits for the shared single-flight gate when a legacy run/manual call holds it,
  retries the same head afterwards, and keeps draining after a per-task error.
  `pumping`/`busy` are set synchronously, so a second enqueue joins the worker
  instead of starting one. A `watch()` subscriber can never cancel or block it:
  `publish()` neither awaits nor throws and drops a failing watcher.
  Thread-capable submits do NOT use this one backlog: every thread has its own
  `ThreadLane` with its own `pumpLane` FIFO, so two threads run concurrently while
  one lane stays ordered; the loop above survives only for a legacy harness handle
  that predates the thread API (and the shared `busy` gate still parks every lane).
- **Status.** `SessionStatus` remains `idle | running | error`; queue state is
  `SessionTurn.status` (`queued | running | done | error | cancelled`) plus
  `SessionSnapshot.queueDepth` (pending turns, active excluded, omitted at zero).
  A cancelled turn keeps its row/events (`updatedAt` moves, no `startedAt` for a
  never-started one), so a reload shows what was stopped.
- **Gates.** `reset`, `callTool`, and the legacy `/messages` reject while `busy` or
  while the queue is non-empty (`409`); Delete/`dispose()` aborts the active run,
  discards pending work, settles its `enqueue()` completions, and closes watchers
  without waiting. The abort preempts the provider request, releases the child
  actor/restore slot and rolls back the cancelled turn's in-flight prompt state
  immediately (a late provider commit is rejected by the core precommit check), so
  the logical cancel never waits on a socket that never returns. Shutdown saves at
  most once: a save-once guard stops a late write from replacing the database with
  an empty state, legacy event writes are serialized, and a failed graceful save is
  reported through `persistenceError`/the log while shutdown still closes.
  `PATCH /sessions/:id` stays the exception: it is accepted while
  busy, aborts nothing, and applies to the next request of that agent — including a
  queued task's request, which reads the model when it starts.
- **Recovery.** The UI keeps one live observer for the selected session
  while it has pending work. CORRECTED IN PLACE 2026-11-11: this bullet named it
  "one `GET /events` observer" — that SSE route is deleted, and the observer is today a
  `session` subscription on the page's single `harness.v1` WebSocket,
  `GET /v1/harness/stream` (`src/frontend/stream.ts`; the frame vocabulary is the
  README's "Live updates (the WebSocket stream)" section). Losing it still falls back to
  `GET /sessions/:id` polling (1 s, ~120 attempts — `POLL_INTERVAL_MS`/`POLL_MAX_ATTEMPTS`,
  `src/frontend/main.ts:11548`, `:11551`; the poll is what runs when the plane reports
  `closed`/`reconnecting`, `src/frontend/main.ts:12764-12775`) and a reconnect after 1 s
  (`RECONNECT_DELAY_MS`, `src/frontend/main.ts:13611`). Reload re-reads the snapshot,
  calls `view.reconcile()` (merge by id, never rebuild), and reopens the observer
  when work is still pending. Settled history never re-lights an agent ring; only a
  `running` turn does.
- **Controls.** Run stays enabled while work is pending — only the short POST
  `/tasks` round trip locks it — so the queue grows by submitting again. Stop is
  enabled whenever work is pending and sends `{ all: true }` (active + queued).
  CORRECTED IN PLACE 2026-11-13: the rest of this bullet used to read "Reset/New
  session/tab switches stay locked while pending", and none of that is the shipped
  contract. There is NO Reset control at all (R10 — starting over IS New session, while
  `POST /sessions/:id/reset` stays alive for other clients,
  `src/frontend/main.ts:4086-4088`). `+` has exactly one writer of `disabled`,
  `paintSessionActions` (`src/frontend/main.ts:11852-11857`):
  `submitting || !booted || archivedSelection` — a live run is deliberately NOT in that
  expression, so a second independent conversation can start while the first one streams,
  and its `POST /sessions` create is eager (the SessionStore bullet above);
  `src/frontend/canonical-directory-live-main.test.ts:304` pins
  `expect(newSessionButton().disabled).toBe(false)` against a live run. Switching
  conversation is a view change, never a cancellation: the header cycler
  (`src/frontend/main.ts:3591-3602`) is never disabled by pending work — it is only
  `hidden` while no conversation is open — and switching away just unsubscribes, because
  the work is server-owned.
- **Composer agent chip (T1).** The chip inside the composer frame (`.agent-control-button`,
  `src/frontend/ui/agent-control.ts`) is still ONE button — no chevron, no popover — and what is
  device-split is what a PRESS means. The axis is the PRIMARY POINTER, never width: the shell
  re-reads the ONE existing positive `(pointer: fine)` query as three states (`main.ts`
  `finePointerMedia` → `pointerDevice`) and adds no second query. **Fine pointer, and `unknown`
  (no `matchMedia`):** click / `Enter` / `Space` opens the shared agent dialog (R11, unchanged)
  and `Tab` / `Shift+Tab` IN THE FIELD walks the team forward / backwards with wrap-around;
  unknown keeps that half verbatim, because an engine that cannot report its pointer must not be
  handed a gesture that changes routing. **`coarse`:** a tap cycles forward and a press-and-hold
  opens that SAME dialog, because a finger owns no modifier key with which to ask for settings.
  The machine is `src/frontend/ui/press-hold.ts`: `PRESS_HOLD_MS` 500 ms, `PRESS_SLOP_PX` 10 px,
  and a move past that slop, `pointercancel`, `lostpointercapture`, `blur` or the node leaving
  the DOM ends the press with NO action; the `click` the browser synthesises after a gesture is
  swallowed exactly once, so a tap can never open a dialog on top of its own cycle. It arms only
  for a real `touch`/`pen` `PointerEvent`, which is how a `(pointer: none)` machine keeps
  plain-activation semantics.
  The cycle set is the SESSION ROSTER in server-declared order (`src/frontend/contract.ts`
  `membersOf`: entry agent first, then every other member exactly as the definition lists them —
  the order the dialog's own tabs use, and ORDER IS PRESENTATION ONLY: `membersOf` says nothing
  about authority, so two Rank A members side by side are normal and no caller may read "first"
  as "top"), and a cycle is CLIENT-ONLY: it writes the per-conversation pending choice
  (`Instance.agentSelection`, resolved by `main.ts` `selectedAgentOf`) and costs ZERO requests, so
  one stray press never promotes an agent (R11). The next send COMMITS it on the wire that already
  exists: while the selection is the agent that send would have run anyway (`main.ts`
  `defaultAgentOf` — the focused conversation's owner WHEN the loaded roster describes it, the entry
  agent when nothing is focused, and `undefined` when a conversation IS focused but the roster
  cannot say whose it is; unknown means "send it THERE, change nothing", so the continuation wins
  and NO thread is minted (`src/frontend/composer-agent-cycle.test.ts:957` — "continues a focused
  conversation the roster does not describe instead of minting a stray thread")) the body is the
  byte-identical pre-feature `POST /sessions/:id/tasks`; when it names another member the shell
  first creates a conversation THAT agent owns,
  `POST /sessions/:id/threads {agent}` (`api.ts` `createSessionThread`), and posts the task INTO
  it, `POST /sessions/:id/tasks {…, thread_id}` (`view-shell.ts` `submitViewTask`) — a thread
  never changes owner, so submitting into an agent-owned thread IS the mechanism
  (`src/server/sessions.ts:1545-1549` `runAgentOf`). Nothing calls the template write —
  `PATCH /harnesses/:name` (`api.ts` `updateHarness`) — and no protocol field was added, so the
  harness TEMPLATE — and a frozen saved-session definition — stay untouched: the chip only ever
  promised which EXISTING member answers next. A cycle is refused for a one-member team or a
  view that hides the slot, and the reason sits in the accessible name and the tooltip instead of a
  silently dead control (`main.ts` `agentCycleBlockOf`). The spoken half of that contract is the
  polite live region (`main.ts` `agentCycleLive` / `agentCycleSay` / `agentCycleSentenceOf`,
  `styles.css` `.agent-control-live`): an sr-only `role="status"` `aria-live="polite"` node that
  states the agent WITH ITS ROSTER POSITION — "Agent for the next message: Researcher (2 of 3)." —
  goes silent when the roster drops the chosen name and on navigation, and SPEAKS THE FALLBACK when
  the choice is spent, so the region is never left naming an agent the chip no longer shows. It is
  mounted deliberately OUTSIDE the rebuilt `.agent-slot` (that host is `replaceChildren`-ed on every
  paint, and a region destroyed at the moment it has something to say is never announced). Tab
  OWNERSHIP is settled before any wire question: the field's `Tab`/`Shift+Tab` cycle leg sits
  AFTER the `@`/`#` suggestion-list branch of the composer keydown handler (`main.ts`), so an
  open list with a pickable row keeps `Tab` and picks it, and one with nothing pickable leaves
  `Tab` to the browser — a plain focus move, no cycle (`src/frontend/composer-control.test.ts`
  — "picks the active suggestion row on Tab instead of moving focus out of the field", "leaves
  Tab to the browser when the open suggestion list has nothing to pick"); an open modal keeps its
  own `Tab` focus trap, registered on `document` in CAPTURE phase (`src/frontend/ui/dialog.ts`),
  which is exactly why the cycle leg bails on `event.defaultPrevented` — that guard is the
  mechanism that makes the two rules coexist (`src/frontend/composer-agent-cycle.test.ts` —
  "leaves Tab to the dialog trap while the agent settings dialog is open"); and a locked cycle
  (a one-member team, a view that hides the chip host) falls through the same way, so `Tab` still
  leaves the field. ONE
  resolver decides whether a send changes the wire at all — `main.ts` `agentSendPlanOf`, gated on
  `Instance.agentSelection` being set AND the focused conversation not already running that agent —
  and BOTH `paintComposerTarget` and `run()` call it, precisely so the routing line and the POST
  cannot disagree. When they would, THE CHIP WINS: cycle to the researcher, re-expand a conversation
  owned by another agent, and the label reads `New thread` with `dataset.mode === 'new'` while the
  send mints THAT agent's conversation (`src/frontend/composer-agent-cycle.test.ts:891` — "promises
  the conversation the send will actually use when a choice and a focus disagree"); the continuation
  only wins when the choice names the focused conversation's OWN agent, or the roster cannot
  describe whose it is. `cycleAgentSelection` itself releases the board's focus (its explicit
  unfocus). The hold affordance is an ATTRIBUTE like every other state here
  (`.agent-control-button[data-hold='armed'|'held']`, `styles.css`), and that same
  `.agent-control-button` block disarms the platform's own long-press around it
  (`touch-action: manipulation`, `user-select: none`, `-webkit-touch-callout: none`) — input
  semantics, no desktop pixel changes. The painted label, `title` and `aria-label` are the ONLY
  pre-gesture hints, and at phone width the chip's visible label collapses to the two-letter code
  (`styles.css:7403-7411`): the implementer logged that as a known discoverability limitation for
  the hold gesture. Proofs: `src/frontend/composer-agent-cycle.test.ts` (roster order at zero
  requests; the two-route commit IN THAT ORDER; an entry-agent send costing no thread request at
  all), `src/frontend/ui/press-hold.test.ts` (each action exactly once, every cancel leg silent) and
  `src/frontend/ui/agent-control.test.ts` (the per-device press table).
- **Configuration scope follows the pointer.** The Tools and Plugins pane toggles are hidden
  while no session is bound (`harnessTitleTools.hidden = toolsToggle.hidden =
  pluginsToggle.hidden = !bound`, `src/frontend/main.ts` `paintControls`, pinned by
  `src/frontend/compact-ui.test.ts:401-435`), because what they edit is THIS conversation:
  `sessionIsBound()` / `configScope` (`src/frontend/main.ts:6011-6016`) decide which routes the
  panes dial — `GET /sessions/:id/tools` for tools (rows built by `sessionToolRowsOf`,
  `src/server/api-reads.ts:1003-1032`) and `GET /sessions/:id/plugins` for plugins
  (`src/frontend/main.ts:256` `listSessionPlugins`, read in `loadPlugins`) — and every write is
  a session-scoped PATCH (`updateSessionTool` / `updateSessionPluginSettings`, fired by
  `setToolEnabled` / `setPluginEnabled`). The conversation scope is stated where the reader asks
  — on each tile's own tooltip (`toolSwitchTitleOf` / `pluginSwitchTitleOf`); the pane-level
  sentence this bullet used to quote, "… for this conversation.", was removed with the tile
  swap, so there is no footer copy to cite. The pane hides rather than disables because a hidden
  control needs no second explanation (same `paintControls` block); `disabled` keeps its old
  meaning of "the server never answered". One carve-out stays, and it is the one a reader is most
  likely to get wrong:
  RUNNING a tool from the tools pane executes in the playground's own throwaway session, not
  in the conversation being configured (`src/frontend/main.ts:2253-2292` wires
  `options.ensureSession` to `ensurePlaygroundSession`, then
  `callTool(name, parameters, sessionId)`), so a pane tool call never mutates the transcript
  it is inspecting. Neither pane dials the TEMPLATE pair any more:
  `listPlugins` (`src/frontend/api.ts:1024`) / `updatePluginSettings` (`:1034`) and
  `listAllTools` (`:927`) / `updateToolEnabled` (`:975`) stay in the client as the deployment
  surface for other clients, and the page's own imports say so in as many words
  (`src/frontend/main.ts:240-262`, `:273-282` — "no pane here calls it any more").
- **Presentation.** The turn board is one linear timeline: completed = grey, the
  single active task = green (amber while its request is on the wire), queued =
  neutral, error = red, cancelled = muted. Assistant Markdown is GFM via `marked`,
  always sanitized by `DOMPurify`, with fenced code highlighted by `highlight.js`
  core plus a registered language subset (aliases resolve; an unknown fence stays
  escaped text), a CSS language caption, and accent typography/inline code. No
  browser verification was performed for this documentation pass.
- **Chip anatomy (transcript).** A tool call and a reasoning round are the SAME
  surface: a `details.tool` chip that stays INLINE in `.tool-group` and opens its
  detail in a modal (never inline). Reasoning is labelled `think`
  (`ui/tools.ts` `createReasoningCard`), painted amber, and its pill is the share of
  the block's accumulated CONTEXT the round occupies
  (`formatThinkShare`: chars/4 estimate over `BlockMeta.context()` — the same figure
  the header tally prints), not a character count: what is worth seeing is how much
  context the thinking is using. The pill is `[hidden]` until a `usage` figure exists,
  and every chip of a block is repainted when a `usage` event or the server tally
  advances that denominator, so a percentage can never disagree with the header.
  Because a think chip IS a `details.tool`, "how many calls" selects
  `details.tool:not(.think)`. No control in the app shows a disclosure chevron any
  more (`styles.css` base `summary { list-style: none }` + the WebKit marker reset): a
  labelled chip that opens a dialog does not need one, and a future chip inherits it.
- **Block header vs block toolbar.** The expanded block's toolbar owns BOTH per-thread
  actions — `Delete` first (destructive, left), `Transcript` last (`margin-left: auto`,
  right) — plus the full-width two-step Delete confirmation. The card header keeps no
  control slot at all (`.tile-header-action`/`.thread-header-action`/
  `.thread-focus-head-action` are gone from the DOM and the CSS): the header's right
  edge belongs to the measurement line, so an expanded tile lays out as a row-wrap with
  the thread badge left and `elapsed | tokens` flush right on the same line, and the
  meta line wraps below. A nested card was already that shape (`.thread-top`
  `order: 2; margin-left: auto`), which is why the two headers now agree without
  absolute positioning or reserved padding. T4 changed WHICH bar is on screen and added
  a third control, not this anatomy: the destructive slot is one button with two meanings
  (`Stop` while the thread/subtree is live, `Delete` otherwise), `Resume` is inserted
  immediately BEFORE `Transcript` and the flush-right auto margin moves onto whichever of
  the two is visible, and the bar belongs to the CONVERSATION rather than to the expanded
  entry — see the two bullets on this in `### Persistent threads in the UI`.
- **Background work (R6).** Concurrent tools mean a turn is `running` until the
  harness promise drains, while an agent `done` can be interim. The UI reconciles
  the same way (by turn id, never rebuilding) and, for the additive frames:
  - `tool_result.durationMs` replaces the browser's frame-gap measurement;
  - a present `pending` array replaces `.agent-pending` (`pending · name 1.2s`, a
    static snapshot of the server's spans, never a local tick) and the summed
    `N tools still running` count in the tile meta (visible when expanded; clipped
    sr-only on compact rows). A settled call is pruned from that snapshot by its
    `callId` even when the frame omits `pending` (the runtime omits it when nothing
    remains), so absence is never read as a global drain. The array never resolves
    or abandons a card;
  - a `wakeup` appends `.agent-wakeup` and keeps the agent's ring lit; it is a
    resume, so it does not settle the tile or close a card. A wake frame without a
    usable `pending` list is malformed and produces no update;
  - on a terminal `cancelled`/`error`/`done` turn, any card still running is
    `abandon()`-ed with a reason (`Cancelled before the call returned.`, etc.)
    instead of being left as a live-looking chip — pending work is interrupted, not
    resumed. A result id already settled (resolved or abandoned) is a duplicate and
    is ignored, so a retried/late frame cannot add a second card. The CLI mirrors
    the duration/pending/wake/done **lines** in `src/server/cli/render.ts`; card
    closure is a browser-only state.
- **An interrupted run reports its OWN span, on THREE planes (T-W23/W24/W25, 2026-11-17).**
  `settle` (`src/server/turn-projector.ts:3575`) is a FORCE-close: the turn ended over every row,
  card and context-bar segment it still reaches, so each must now report only what its OWN frames
  recorded. Before this pass all three carried the TURN's end stamp, and on the user's recorded run
  one interrupted `delegate` call was simultaneously a `64m04s` context-bar segment, a `64m04s`
  card, and a `3,844,6xx ms / done` ROW — the row claiming it had finished.
  - **Rows** (`:3604-3632`) end at `record.lastStamp`, the stamp of the last frame ROUTED to that
    row (`interruptedEndedAtOf`, `:804-812` — written by `apply` at `:3514` from frame stamps only,
    never a wall-clock read), and state is `'cancelled'` where the turn settled `done`
    (`interruptedStateOf`, `:794-795`). `'cancelled'` is an EXISTING vocabulary value
    (`src/shared/turn-display.ts:195`), so the wire enum (`src/server/harness.swagger.yaml:8298`),
    the client's terminal-state sets (`src/frontend/view-state.ts:907`, `:962-963`, `:975-976`) and
    the detail's settled test (`src/frontend/view-detail.ts:261-263`) are all unchanged — nothing to
    migrate on restore. The alternatives were rejected on the record: `'done'` is the
    lie, `'error'` claims a failure the record does not hold (this projector stamps a section
    `error` only beside a recorded `error` frame, `:3314`), and `'streaming'`/`'open'` would keep
    the agent in the live "active agents" set after the turn closed
    (`src/frontend/view-state.ts:963, :976`). A turn that settled `error`/`cancelled` maps its rows
    exactly as before, so only
    the CLAIM of success changed.
  - **The root row is the one thing `settle` does NOT force-close** (`:3604-3613`): the turn's own
    card never mints a terminal frame of its own, so the root's end and state ARE the turn's — the
    same pair the turn tile prints off `TurnSummary.startedAt`/`updatedAt`
    (`src/frontend/ui/turns.ts:9346-9355`). Truncating the root row would only make the section
    disagree with the tile above it.
  - **Cards** (`:3641-3666`) and the **context-bar segments** of those same calls (`:3668-3694`)
    share ONE end computation (`abandonedEndedAtOf`, `:877-892`) so the two planes cannot drift. A
    still-`running` card has been written by exactly ONE frame — the `tool_call`/`action_request`
    that MINTED it, because the only later writer, `setStep`, has just the two settling call sites
    (`tool_result` `:2941`, `action_answer` `:3380`) and both move the card out of `running` — so
    its end is that mint stamp and its span lands on **0 ms**. That is the honest figure, not a
    bug: an ABSENT `endedAt` makes the compiled card tick from `startedAt` to NOW
    (`src/frontend/ui/turns.ts:8240-8246`), the same absurdity with a moving number. Reusing the
    helper one plane down is sound because `segment.at === step.startedAt` for exactly these
    segments (`:2806` writes `step.startedAt` at `:2831` and the segment's `at` at `:2857` from the
    SAME stamp). What did NOT move: the card's STATE (`abandonedStateOf`, `:814` — `'error'` for a
    call that failed to return, `'cancelled'` only when the turn itself settled `cancelled`), its
    preview, and the segment's CONTENT (`chars`, `argsChars`, `included`, `eventTo`, which the
    detail reads depend on). A segment whose call got its own `tool_result` never enters the loop.
  - **Legacy records fold byte-identically on every plane**: a record with no `eventTimes` at all
    (`DISPLAY_NO_TIMESTAMP`) keeps the settle stamp, and the recorded start is the FLOOR, because
    `elapsedBetween` (`src/frontend/ui/time.ts:36`) returns `undefined` for a negative span — and
    the context bar prints NO duration label when the span is `undefined`
    (`contextBlockDurationOf`, `src/frontend/view-context.ts:338-346`, which prefers a measured
    `durationMs` and falls back to `endedAt - at`).
  - **Measured on the recorded run** (`Temp/orch-plan/{w23,w24,w25}/{before,after}.txt`): the three
    interrupted delegated rows went from `3,844,6xx ms / done` (64m04s) to `185,9xx ms / cancelled`
    (3m05s); the 5 abandoned cards from a widest `3,844,657 ms` to `0 ms`; and the context bar's
    `totalDurationMs` from **23489076** (391m29s) to **4637688** (77m17s) — still inflated, because
    the surviving spans are honest waits, not a projector bug. The root row is UNCHANGED at
    **3,993,309 ms** (66m33s, `done`): it genuinely spans that wall time — pre-restart run, resumed
    post-restart on the same row, then waiting on its own recorded pending work.
  - **Pins:** `src/server/turn-projector-settle-interrupted.test.ts` (8 — the row plane, including
    the `'0ms'` floor at `:461`), `src/server/turn-projector-abandoned-card.test.ts` (8 — the card
    plane, with state/preview/detail asserted whole),
    `src/server/turn-projector-abandoned-segment.test.ts` (10 — the segment plane and the shared
    computation) and the shared pin `src/server/turn-projector.test.ts:1706`, whose `endedAt` was
    MOVED on purpose from the settle stamp `5_000` to the call's own `1_010` — that move is the
    segment rule, not a regression.
  - **The line numbers above are the CURRENT tree's.** The in-file comments of
    `src/server/turn-projector.ts` still cite the pre-W24 positions of these same sites —
    `apply`'s `lastStamp` write at `:3436`, the settling `tool_result` at `:2863`, `action_answer`
    at `:3302`, the section `error` patch at `:3235`, and the `'0ms'` pin at
    `turn-projector-settle-interrupted.test.ts:459` — all of which have since moved to `:3514`,
    `:2941`, `:3380`, `:3314` and `:461`. The rules those comments describe are unchanged; only the
    anchors drifted, so do not "correct" this bullet back to the comment numbers.

### Persistent threads in the UI (T5 / R5-R7)

Two identities exist and must never be conflated:

- `HarnessThread` (`event.thread`, `AgentResultBlock.threadId`) = ONE invocation.
  Its id changes on every run and it is what a `#` reference binds to — and it is a
  per-PROCESS id, unique only inside the process that minted it (a restarted harness starts
  the counter again and a lane worker mints from its own), so a `#` handle names an
  invocation in the harness that is answering, not one archived before a restart;
  `event.thread.epoch` (T-W8) is the field that says WHICH process minted it. See
  "HarnessEvent" for the identity contract.
- `SessionTurn.threadId` and `SessionSnapshot.threads[]` = ONE persistent runtime
  conversation. Its id is stable for the thread's life, and repeated turns of it
  are the same conversation (one `RR2` badge in the transcript). R8: the id is opaque;
  the DISPLAY name is `<agent code><per-agent conversation ordinal>` (`RR1`, `RR2`,
  …; `IT1` for Instruct), allocated once per CONVERSATION by the server and re-used
  by every run/steer/continuation. It is carried on `SessionTurn.threadLabel` and
  `SessionThread.label`, never minted per invocation. A host-thread ROOT frame has a
  metadata-only `thread` record (no parent/callId/kind/branch): it belongs to the
  tile's root block and must never render as an indented `T<n>` wrapper.

**THE ROSTER ROW CARRIES AN IDENTITY TRIPLE (W22 + W26, 2026-11-17).** The two bullets above are
why a conversation row needs a discriminator; this is what the HOST/UI roster row actually
publishes — `invocation_id`, `invocation_ids` and `epoch`. It used to publish NONE of them: the
row was id-free by the R1 compact-roster decision, and W22 published only the PROCESS, which left
the token unpairable exactly where the join needs it.

- **The wire shape** is `ThreadSummary` (`src/server/harness.swagger.yaml:7544-7595` → the
  generated `src/shared/harness-api.ts:2793` `invocation_id`, `:2805` `invocation_ids`
  (`maxItems: 64`), `:2821` `epoch`). All three are OPTIONAL and their values are **BARE** —
  never `id\0epoch`. The store's persisted join is keyed by the RUN (`src/shared/run-identity.ts`),
  and `invocationIdOfRunKey` strips the epoch at this boundary, so a client can post a reported id
  straight back to the transcript routes and compose `id + U+0000 + epoch` itself if it wants the
  run key; the composite never crosses the wire.
- **The emit rule** (`threadRowOf`, `src/server/api-reads.ts:693-767`): `invocation_id` exactly
  when the conversation's own record names a non-empty `thread.invocationId`; `invocation_ids`
  exactly when that record-slot ∪ the store's `record.invocationThreads` join is non-empty;
  `epoch` exactly when the record pairs an id with a non-empty epoch. A conversation that never
  ran names NONE of the three (never `[]`, never an empty string), and a document whose runs
  predate the epoch field gains the two id keys and stays epoch-free, so a legacy row projects
  byte-identically. Key order is `invocation_id` → `invocation_ids` → `epoch`, after
  `label`/`owner_thread_id` and before `transcript_state`.
- **`invocation_ids` has TWO sources that are not interchangeable** (`rosterInvocationIdsOf`,
  `src/server/api-reads.ts:788-801`): the durable join map first — its iteration order is
  OBSERVATION order, so a card's original run precedes the continuations that advanced the
  record's single slot — then the runtime record's own slot, appended only when the join does not
  already name it, because a conversation can hold a run its durable join never names (a `reset()`
  clears the map, and the scan that writes the join is one-sided when the record carries no epoch —
  the residual `src/server/sessions.epoch-discrimination.test.ts` D2 pins). Deduped by BARE id (one
  conversation that ran in two processes can hold the same id once under each epoch), capped at
  `MAX_ROSTER_INVOCATIONS` = **64** (`src/server/api-reads.ts:865`), keeping the OLDEST 64 — so on
  a conversation with more recorded work the NEWEST ids are the ones missing, which is precisely
  why the latest id rides separately in `invocation_id`.
- **A `thread.upsert` frame carries the same keys**, because the live row is the SAME producer
  (`threadRowForStream` → `threadRowOf`, `src/server/api.ts:1306-1316`, called at `:1505` and
  published as `payload.thread` at `:1511-1515`; `WsUpdateThreadUpsert.thread: ThreadSummary`,
  `src/shared/harness-stream.ts:766`). A live repaint and a reload therefore cannot disagree about
  which run a row names.
- **The model plane and the host plane now differ DELIBERATELY.** The model-facing `threadList`
  page still strips the epoch (`modelThreadRosterOf`, `src/harness.ts:6804-6813`) — its schema has
  no epoch parameter, so the model could never send the token back and its contract stays
  byte-identical. The host/UI planes declare the pair: `SessionThread.epoch`
  (`src/server/protocol.ts:610`), `SessionThreadView.epoch` (`:719`, the compact row the browser
  renders) and `ThreadSummary.epoch`, and the browser's render model renames it at the boundary
  (`ThreadRow.epoch`, `src/frontend/view-model.ts:81`, mapped by `src/frontend/view-api.ts:295`).
- **What it is for** is the invocation → conversation join in `src/frontend/ui/thread-transcript.ts`
  (`attributedThreadOf`, `:450-491`), and ONLY when the bare id is CONTESTED (two roster rows claim
  it) and the frame names a process — otherwise the roster's answer stands, which is what keeps a
  legacy document resolving exactly as before. Door 1 (`recordedRuns`, `:357-378`) rebuilds
  `invocationRunKeyOf(id, epoch)` from the two bare wire fields and takes the row that recorded
  exactly that pair — a recorded fact, not an inference. Door 2 (`:466-490`) unions the process
  evidence the document offers (the W19 fingerprint plus the row's own `epoch` via `rowEpochs`) and
  takes a single candidate; two candidates naming ONE process is a genuine ambiguity, and the join
  refuses to guess between them. `threadEpochOf` (`:226-230`) is the single reader of the row's
  token.
  Tests: `src/server/sessions.epoch-discrimination.test.ts` (D1–D6: the store's join AND the wire
  page across a restart), `src/frontend/ui/thread-transcript-run-join.test.ts` (F1–F7: the browser
  join, including the export plane) and
  `src/server/api-thread-roster-invocation-ids.test.ts` (the row shape over HTTP).

`src/frontend/ui/threads.ts` owns the decisions; `main.ts` owns the POSTs and the
DOM. The contract it is written against is optional/additive, so a server that does
not send `threads`/`threadId` renders exactly the old UI (`sessionThreadsOf` → `[]`,
`turnThreadIdOf` → `undefined`, submit body unchanged).

- **Focus is explicit board state (S1).** `focusedThreadId` + `explicitUnfocus`, not
  "whichever tile is expanded". `create()` NEVER expands: snapshot adoption, the
  observer `upsert` and a late record for a failed submit are background events and
  may not steal the reader's focus or undo an explicit "New thread". `begin`
  expands the optimistic tile (a submit is a focus choice); `reconcile` keeps a
  surviving expanded tile, re-focuses the same THREAD when its surface disappears,
  clears on deletion, and only auto-opens the newest conversation for the FIRST
  content of an empty board. Reported through `onFocusChange(focusedThreadId)`.
- **Child conversations (S2).** A runtime child thread has no `SessionTurn` of its
  own (its work is in the parent's events). `focusThread(id)` resolves in order:
  a turn with that `threadId` (a continuation creates one) → the nested invocation
  the roster joins via `invocationId`/`originInvocationId` → a roster-only panel
  rendered from `SessionThread.messages`. Focusing a child collapses the tile and
  every other PERSISTENT child entry, so exactly one conversation is expanded;
  pure invocation details (no roster join) keep their independent expand. Clicking
  a mapped nested row focuses the child's true id, which the composer then targets.
- **Routing (`resolveSubmitTarget`).** Focused idle/stopped → `continue` (new turn in
  the same thread), focused running → `steer`, no focus + `#` references →
  `connected` (new thread whose turn carries `references`; the roster derives
  `connectedThreadIds`, a reference EDGE — never `ownerThreadId`, which stays
  delegation lineage), no focus → `new`. The wire body carries `threadId` ONLY in
  the first two cases; omitting it is the server's "open a new thread" signal.
  Unfocused submits run CONCURRENTLY, one lane each; only a legacy pre-thread
  harness handle keeps the serialized backlog.
- **A running focus is not always steered.** Steering is text-only and needs
  terminal reference content, so a draft with attachments (`attachments > 0` in the
  helper, ready files only) or a `#` reference whose target turn is still
  `queued`/`running` becomes a QUEUED CONTINUATION turn in that same thread: bytes,
  reference binding and prompt are kept and run when the active turn settles. The
  target id (and thus the POST body) is unchanged; only the label changes —
  `submitTargetLabel` prints `Queued in …` instead of `Steering …` when
  `target.queued` is set. `main.ts` feeds both the paint path and `run()` the same
  counters (`draftAttachments` ready count, `unfinishedReferenceCount` over the
  authoritative `records`), so what the line promises is what the request does.
- **Capacity.** At most `MAX_THREAD_RECORDS` (256) independent host threads per
  session, delegated children of host threads included; creating one past the bound
  is the runtime's "already has N independent threads; delete a terminal one"
  refusal, mapped to `429` on the server's thread routes. Deleting a terminal
  thread removes its record and frees the slot again — and since 2026-11-13 the
  model itself can free one: `threadDelete` is the model-facing release of a
  finished child it owns (issue 0027, see
  [the model-facing thread tools](#the-model-facing-thread-tools-2026-11-13)),
  so the cap is no longer host-only. The UI does NOT auto-prune:
  reducing thread count is an explicit per-row delete. Deletion purges only that
  conversation — not what other histories were told, not what it wrote to shared
memory (tasks/profiles/chapters/locations), and not a result a connected thread
  already received.
- **One conversation, many runs (T12b).** The server keeps one `SessionTurn` per run,
  but the board projects every turn of one `threadId` into ONE top-level
  `.conversation` container (`ui/turns.ts` `placeTurn`/`reorderHosts`), in recorded
  order. Idle continuations and steered prompts therefore extend the SAME RR2
  conversation instead of adding a second top-level tile; only the first exchange
  shows the conversation label. A legacy turn without a thread stays its own row. A
  roster `ownerThreadId` nests a child conversation's continuation inside its
  owner (still focusable by id); agent-spawned invocation rows remain the only
  indented `.thread-row` entries. `blocks()` is per turn and unchanged, so `#`
  result bindings survive grouping. Expanding a conversation opens every exchange;
  exactly one conversation is open at a time.
- **Steering answers with the owner.** A running target may return the OWNING turn
  (same id), so `run()` discards its optimistic steering tile and merges the record
  into the existing tile (`view.discard`). Without that, an unbound queued ghost
  would survive every later snapshot as "pending". The owner's `steers` audit is
  rendered as a visible `.turn-steer` user message INSIDE that tile (R9), in record
  order, so steering both replies and shows the typed text in the same conversation.
- **Roster order and labels.** The roster is ordered by the server's `sequence`, not
  array order; the display name is the server conversation label (`RR2`/`IT1`). A
  legacy entry without one derives the same agent-prefixed shape from roster order —
  there is no `T{sequence}` wrapper. (The strip that rendered these rows, and with it
  the per-row `stop`/`delete` controls, is removed; the roster now feeds the routing
  decision and the board's label/badge joins only.)
- **Delete reconciliation + tombstones (S3, N1, N2).** The DELETE answer carries the
  full snapshot; applying it drops the turns and the roster row. Deletion is recorded
  in `Instance.threadTombstones`/`turnTombstones` BEFORE the answer is applied, with
  descendants and the removed turns. Every inbound record is filtered through them:
  late stream frames (`turn.upsert`/`run.event` on the `harness.v1` socket — CORRECTED
  IN PLACE 2026-11-11: this read "late SSE `turn`/`event` frames", and the SSE routes
  that produced them are deleted) and late GET answers cannot resurrect the thread or
  re-focus it. The sets are session-scoped: `openSession` (switch), `ensureSession`
  and `newSession` clear them, and `applySnapshot` REFUSES a snapshot whose id is not
  the instance's current session (a late answer cannot re-point the card). A switch
  also drops the previous session's `records`/`threads`/watermark BEFORE applying the
  new snapshot, so deletion learning cannot compare one session's roster with the
  next one's ids (N1). A snapshot older than the applied watermark is ignored
  ENTIRELY — it can neither learn a deletion nor replace records/reconcile an older
  turn list and delete a live streamed row (N2). Equal stamps are not stale: every new
  turn bumps `updatedAt`, so only a strictly older snapshot can be missing one.
  `purgeStaleReferences` removes any `#` chip whose turn is gone (it would 400 the
  whole submit) on authoritative snapshots and again after a failed submit restores
  its draft snapshot (N3, silently — the failure notice stays), keeping the surviving
  text/attachment draft intact; labels of surviving blocks are kept by the snapshot's
  per-turn `labelSeeds`.
- **Labels (S6/R8).** `threadLabelOf` is the ONE display identity: the roster's
  agent-prefixed conversation label (`RR2`) or an agent-prefixed fallback for a
  legacy row, `T?` only when the roster does not describe the id (never digits
  parsed from the opaque id). It titles the tile badge, the root block header and a
  `#` reference. A deleted conversation's ordinal is retired (the server keeps a
  per-code high-water), so a later conversation never reuses `RR3`.
- **The thread strip is REMOVED.** The compact `.thread-strip` band (one row per
  HOST thread with focus/stop/delete controls and a `New thread` unfocus button) no
  longer exists: it duplicated the transcript's own `.tile-thread` badge and cost a
  permanent row of height. Focus is expressed by the single expanded conversation
  (clicking a tile/thread header) and by the composer's routing label; unfocus is
  collapsing that conversation. Per-thread stop/delete are API-only, and a deletion
  learned from any authoritative snapshot drops the focus even when a pending
  optimistic row still names the thread (`applySnapshot` → tombstone check →
  `view.clearFocus`).
- **Stop-all.** `composerStopOf(action, pending)` adds the separate `.composer-stop`
  only when work is pending and the inline action is not already `stop`; it calls
  the same `stopRun` → `POST /sessions/:id/cancel { all: true }`. A draft in the
  field therefore never hides the session-wide cancellation control.
- **Editable transcript (C4/C5).** `GET`/`PUT`
  `/sessions/:id/threads/:threadId/transcript` is the only mutation surface for one
  conversation, and only `messages` are editable: turns, events, statuses,
  `eventTimes` and `usage` stay server history, because they record what actually ran
  rather than what the model will be sent. GET answers
  `{ threadId, agent, messages, raw, invalid? }` (`ThreadTranscriptResponse`) — the
  LIVE transcript, the pretty JSON the editor holds, and the read failure only when
  the value cannot be read. PUT takes `{ messages }` (deliberately `unknown`,
  `UpdateThreadTranscriptRequest`) and answers `{ session, transcript }`, so one
  response repaints the board and the dialog.
- **A broken transcript is a 200, not a 400.** A structurally invalid `messages`
  value is ACCEPTED and PERSISTED. Its raw bytes go to
  `Session.invalidThreads` (persisted as the optional per-record `invalidThreads`
  map), and the live transcript becomes
  `[{ role: 'system', content: '[transcript unreadable: <reason>]' }]` — a `system`
  entry is the only role with no structural partners to satisfy, so the placeholder
  can never itself become the invalid-transcript problem, and a run of that thread
  still carries a readable explanation in the model's context. The session therefore
  stays runnable, snapshot-able and restorable while the operator keeps fixing the
  JSON, and the dialog opens a thread named in `invalidThreads` DIRECTLY in the
  editor with that banner plus the raw value. Only an absent `messages` property is a
  `400`: the service adapter hands an unparseable body as `{}`, so accepting it would
  silently EMPTY a transcript. The rest of the contract is `409` for a running thread
  (record `running` or a lane with an active run — this route's own live-work gate;
  `deleteThread` no longer refuses on it, because a delete now STOPS the conversation
  first and only then purges it), `404` for an unknown session/thread, `405` for any other method, and `409`
  when the session's harness handle predates `setThreadMessages`.
- **`harness.setThreadMessages(threadId, messages)` is the write primitive
  (`src/harness.ts`), and its order is fixed.** Resolve the thread (an unknown id is
  the ordinary `HarnessError`) → refuse live work BEFORE validating (the caller gets
  "stop it first", not a schema complaint about a value a run is still writing) →
  validate with `readHarnessMessages` (the SAME reader `snapshot()`/`restore()` use,
  so a harness can never be left holding a transcript its own snapshot would refuse)
  → replace IN PLACE (truncate + push, like `restore()`), because `agent.messages` is
  exposed by reference and a later holder must see the new value. An empty array is a
  legal transcript, a STOPPED thread is writable (repairing a broken conversation is
  the point), and a default `agent:<name>` conversation is writable for the same
  reason. The write notifies the existing `agent_message` reason and emits no progress
  event: a host edit is not model output.
- **Tolerant restore, per thread.** `tolerateThreadTranscripts` validates every host
  thread's stored `messages` BEFORE `harness.restore()` (which validates the whole
  document atomically) and neutralises the unreadable ones while keeping each thread's
  id, agent, label and turn links; `mergeInvalidTranscripts` then reconciles that with
  the raw values the document already recorded. A persisted entry survives only while
  the live transcript is STILL a placeholder (`isUnreadablePlaceholder` matches the
  exact `[transcript unreadable: …]` shape this package mints): a deleted thread, or a
  transcript whose JSON was repaired by hand, makes the recorded raw value stale, so it
  is dropped. The scope is deliberately per HOST THREAD: an invalid DEFAULT
  conversation (`core.agents[name].messages`) still fails the restore and drops the
  session, because that transcript is what the entry point runs and a placeholder there
  would silently rewrite the session's entry-agent conversation. Retention also covers a
  default conversation whose placeholder came from a live `PUT`; only a hand-broken
  `core.agents[name].messages` in the stored file stays fatal. Document-level corruption
  remains fatal — a malformed `invalidThreads` map is record-shape corruption like any
  other field — because tolerance is about one conversation, never about an
  unparseable file.
- **The dialog never destroys an in-progress repair.** A refresh repaints the
  read-only document but NEVER replaces the textarea's text — only an explicit Save,
  a Cancel, or opening a different thread does — and a refresh into or out of the
  unreadable state never closes the dialog. Save parses locally first (`invalid JSON: …`
  keeps the text and sends nothing), then PUTs the parsed value; a 200 carrying
  `transcript.invalid` is a SUCCESS shown as a banner with the text exactly as sent.
  `ui/threads.ts` `invalidThreadsOf` reads the additive roster structurally, so a
  server without it behaves exactly as before.

Tests: `ui/threads.test.ts` (pure roster/routing/labels), `ui/thread-focus.test.ts`
(board focus/badge/discard/stop-all matrix), `thread-routing.test.ts` (live shell
wiring: `threadId` in the body, per-thread stop/delete, steering collision,
stop-all with a draft), `thread-session-scope.test.ts` (N1 cross-session
tombstones, N2 stale snapshot vs live turn, N3 failed-submit reference restore),
`src/harness.thread-runtime.test.ts` (the C4 `setThreadMessages` contract: order,
running refusal, stopped-thread repair, in-place replacement),
`src/server/transcript.test.ts` (transcript read/write on both ADAPTERS — the Node
handler and the `@underload/service` route, one `/v1/harness` mount on each — an invalid
value as a 200, the 400/404/405/409 matrix, restart round-trips, tolerant restore and
stale-entry dropping, and document corruption that still aborts startup),
`ui/thread-transcript.test.ts` + `ui/thread-transcript-edit.test.ts` (the lossless
read-only document, the editor, and the unreadable-thread open),
`ui/thread-action-bar-placement.test.ts` (T4/R2: exactly ONE visible bar per expanded
conversation, in its head exchange, stable while other entries are pressed, targeting the
conversation's thread; no second bar for a delegated card or a continuation routed inside
one; the child's own bar when the CHILD is the focused surface), and
`ui/turns-navigation.test.ts` (T4/R1 with R3a/R3c: which press reveals which entry, and
which re-render is silent), and the ROSTER IDENTITY triple above —
`src/server/sessions.epoch-discrimination.test.ts` (D1–D6: the store's invocation join across a
restart — a dead generation cannot claim the live run's join (D1), the documented epoch-less
residual (D2), a wholly epoch-less document unchanged (D3) — plus its WIRE halves: `epoch` beside
`invocation_id` in both generations (D4), no `epoch` key for an epoch-less record while its live
successor emits one (D5), and an epoch-less document naming its runs with bare ids and no `epoch`
anywhere (D6)),
`src/server/api-thread-roster-invocation-ids.test.ts` (the `ThreadSummary` row shape over HTTP, five
shapes: W26-1 a conversation that RAN — exact key order, both ids bare, `epoch` only beside
`invocation_id`; W26-2 one that NEVER RAN — no identity block at all, byte-identical to the old row;
W26-3 a SOFT-DELETED conversation — hidden from the page, identity kept on the projected read;
W26-4 the LEGACY document — the two id keys arrive and the `epoch` key stays absent; W26-5 the
JOIN-CLEARED document — the row still names the run its own record carries), and
`ui/thread-transcript-run-join.test.ts` (F1–F7: the browser's invocation → conversation join — a
recycled id split along each frame's epoch, the legacy door, the no-guess rule, the descendant
chain, the W22 pair, the both-claimants-name-one-process decline, and the export/roster-PAGE plane).

- **One action bar per conversation SURFACE, anchored at its top (T4/R2).** The bar
  belongs to the CONVERSATION, not to the expanded entry: `ui/turns.ts`
  `showsThreadActionBar(card)` shows a tile's `.tile-transcript-action` only while the
  enclosing `.conversation` (or the standalone row, for a legacy/unthreaded turn) is
  expanded AND the card is that surface's FIRST exchange — the head prompt that carries
  the thread badge — so the Stop/Delete + Resume + Transcript row sits directly under the
  thread header and above every entry body. `coveredByExpandedSurface(row)` hides a
  delegated child card's own `.thread-transcript-action` while an expanded conversation
  (or owner tile) already shows the bar for everything rendered inside it; the child's
  actions stay reachable because pressing the child's header focuses THAT conversation
  (`focusThread` path 2 → `focusChildThread`), which closes the covering surface first,
  and a roster-only child keeps its own focus-panel bar. The bar is deliberately IN-FLOW
  and NOT viewport-sticky: the transcript is one scroll list holding several conversation
  cards, so the bar anchors to the top of ITS conversation and scrolls with it. Because
  visibility no longer follows the expanded entry, every expansion change repaints ALL
  bars — `refreshActionBars()` at the end of `expand`, in `detachTileExpansion`, in
  `dropFocusState`, and in `reorderBoard` when a card's head exchange actually changed (an
  unconditional repaint there re-renders bars on every projection reorder for no
  behavioral gain). A per-tile repaint cannot do this job: it can neither hide the bar of
  the conversation the focus left nor show the head exchange's bar when the reader pressed
  a LATER exchange of the same card.
- **Pressing an entry reveals THAT entry (T4/R1).** `expand(turn, scroll)` calls
  `turn.element.scrollIntoView?.({ block: 'nearest' })` AFTER the class toggles, the
  conversation-host toggles and the bar repaint: opening a conversation grows content
  ABOVE the pressed row (every earlier exchange's body becomes visible, and the in-flow
  bar adds height) while the transcript keeps its numeric scroll offset, so a reveal that
  ran earlier in the sequence would land on the head entry — the reported bug. `nearest`
  is the same minimal reveal `focusChildThread` already used: it scrolls the least amount
  that brings the pressed entry into the viewport — nothing while the whole entry is on
  screen, and for an entry TALLER than the viewport whichever of its two edges is nearest,
  so a taller-than-viewport entry is re-landed rather than left mid-content. The flag is set ONLY by a real gesture (the
  entry's `.tile-select` press, and the header press that reaches `focusThread(id, true)`),
  and `focusThread` path 1 forwards it (`expand(candidate, scroll)`); hydration,
  reconciliation, a collapse press and every background/re-render focus stay silent, which
  is the R3c contract the same suite pins. `main.ts` arms `revealEntry` for the click and
  re-applies the same minimal reveal from `repaintPlane` (`revalidateReveal`) when a
  lazily-loaded display tree lands and grows the conversation AFTER that frame; the arm is
  RECOMPUTED on every press — the newly opened surface when the press changed which surface
  is open, else the pressed persistent child row when nothing is open (a delegated child
  focus has no tile), else nothing, so a button or a chip pressed INSIDE the conversation the
  reader is already reading leaves no request behind. The arm
  dies on any reader gesture (wheel / pointerdown / keydown / touchstart on the log), on
  `clear()`, or as soon as the expansion or the attachment changed, so a late paint can
  never drag the viewport under a reader who has already scrolled away.

- **ONE conversation code per SESSION, re-derived on every paint (D1/D2, 2026-11-18).** A tile elects the
  card of a conversation it holds (`syncCompiledConversationCards`, `ui/turns.ts:8221`) and STAMPS
  that election on the row as `data-thread-card` — the provable conversation id (`TurnSection.threadId`,
  else a UNIQUE roster claim), never the section id, which the roster does not know. The board then
  re-derives the session-wide figure in `syncCompiledThreadRepeats` (`ui/turns.ts:3307`, called at the end
  of `placeAllTurns` at :3454 and after every applied ops frame at :11257): ONE board-level query for
  `.thread-row[data-thread-card], .thread-row[data-thread-repeat]`, then every card row is attributed to
  the tile that owns it by walking up to the nearest `.turn-row`, and every card whose conversation an
  EARLIER card already shows gets `data-thread-repeat`. "Earlier" is the owning turn's index in the
  board's turn ARRAY, then the order inside that turn — the recorded order on a snapshot frame, arrival
  order after an ops `{op:'turn'}` upsert (:10660 appends the tile) until the next snapshot heals it.
  Never document order overall: a continued child's rows sit INSIDE another tile's card (`placeTurn`/
  `childExchangeHost`) and would win a rank they do not hold, and a row no turn owns ranks last. Each
  card row is visited exactly once per invocation — the fix for the old defect, where the SECOND visit
  marked the NESTED card as its own repeat and left it ZERO readable codes. Never twice, never zero. The
  pass clears the existing marks first, so a demotion or a teardown can never strand one, and returns
  early when nothing is stamped, so a rows-only board pays one query and nothing else. Markers only — NO
  session-keyed map, because tiles are lazy/windowed (`src/frontend/view-api.ts`) and `resetCompiled()`
  tears every compiled tile down, so a remembered owner would hide the wrong tile's name. A rows-only or
  optimistic tile has no compiled tree, publishes no marker, and therefore can neither claim a code nor
  lose one. The marked row loses ONLY its visible label: `styles.css:3469` withdraws it with
  `visibility: hidden` — the same slot-reserving device `styles.css:3422-3444` uses for a repeated TILE
  badge — because `display: none` (what the `hidden` attribute did, `[hidden]` at `styles.css:124`)
  collapses the identity half of `.thread-select` and starts `.thread-preview`, the only flexible item,
  one badge width left of its neighbours. The join (`data-persistent-thread`), the run's own context
  strip, its prose and its body/dialog/transcript routes all stay. Pinned by
  `ui/turns-thread-repeat-labels.test.ts`, which measures readability through the SHIPPED stylesheet
  instead of mirroring the selectors, plus the two-tile case of
  `ui/turns-compiled-conversation-cards.test.ts:929`; that file's mirrored reader is itself pinned to the
  injected stylesheet in its last suite, so mirror and engine cannot drift apart.
- **Pressing an exchange header opens THAT run and moves nothing (R8, 2026-11-18).** The two repeated
  codes press differently ON PURPOSE. An in-tile exchange (`data-thread-exchange`) is not its own
  steerable surface — the card above represents that conversation — so its `.thread-select` press
  toggles its own entry and returns (`ui/turns.ts:5701-5710`): no `focusThread`, no scroll, no focus move,
  and the card above stays exactly as it was. A cross-tile repeat (`data-thread-repeat`) IS a card in
  its own tile, so it keeps the persistent branch (`focusThread(persistent, true)`): taking its label
  never took its steering. Both are pinned in `ui/turns-thread-repeat-labels.test.ts`.

### Live shell panels (`harness.tasks`, `harness.records`)

The scratch board carries two live panels over the session record store. They are
ordinary entries in the shell's panel registry — the definitions sit at the foot of
`src/frontend/extensions/records-panels.ts` (`HARNESS_TASKS_PANEL_ID`, `title: 'Tasks'`,
`slot: 'scratch'`, `requiresSession: true`, ordered above `harness.records`),
`registerBuiltinShellPanels()` — defined in `src/frontend/extensions/records-panels.ts`
and re-exported by `extensions/index.ts` — hands them to the runtime, and
`src/frontend/main.ts` calls it at startup — so the extension runtime
(`extensions/runtime.ts`) owns their mount, session scoping and teardown exactly as it
owns a plugin panel's. They mount from boot, but both cards ship **closed**, and a closed
card has no engine: nothing on the records surface moves until a reader opens one. Nothing
in `src/server/**`, `src/shared/**` or `src/core/records.ts` knows they exist, and they are
display-only — their controls are view-side only. The first is the card's own title, the
collapse control: pressing it boots the engine (one snapshot read, one wake registration)
and pressing it again releases both and clears the surface, so a re-open is a fresh boot,
never a resurrection of rows nothing was reading. The others are a task row opening its own
detail (the collapsed row is a tick-or-cross mark plus its text, and pressing it reveals the
full text, the meta line and the record's history — a local disclosure of history the panel
already holds, with no request of its own), the collection filter chips, the "N new" follow
pill, and a Retry where a read failed.

- **Reads.** `src/frontend/api.ts` adds the two bounded REST reads (`getSessionRecords` =
  `GET …/records`, `getSessionRecordsDelta` = `GET …/records?since=`). They are wrapped as
  `readRecordsSnapshot` / `readRecordsDelta` in `src/frontend/view-api.ts:1223-1231`, and
  `src/frontend/extensions/context.ts:74-76` surfaces those to panels as
  `PanelContext.api.readRecordsSnapshot` / `readRecordsDelta` so an injected host can answer
  them. `extensions/records-client.ts` is the
  reconciliation half: watermarks, the capped feed window, per-record history, and the
  rule that a wake names fields but carries no values — so a live row lands with its
  identity and order and its values arrive with ONE debounced snapshot re-read.
- **The plane.** `records.updated` is a watermark wake, never a payload. Each panel owns
  its client, but the WS registration is SHARED: `extensions/records-wake.ts` brokers one
  subscription per (seam, session) and fans its frames to every attached panel, keyed on
  the RAW `ctx.subscribeSeam` rather than the per-context wrapper. A conversation switch
  releases the old registration with the old client — and so does the collapse gate: the
  registration's lifetime is now CARD- and BOARD-dependent, created by expanding a card on
  a shown board and retired by closing it (`stopEngine` — the wake first, then the client)
  or by the board going off screen. A closed card, and any card inside a shut phone drawer,
  holds no registration and does no clock work at all.
- **Board visibility.** `PanelContext.visible` (default true) and its
  `PanelContext.onVisibility(listener)` are the runtime's channel for "is this slot the
  reader can actually look at"; `PanelContextController.setVisibility` publishes it — once at
  mount, then on every paint — and fires listeners only on a CHANGE, so a host that never
  passes `PanelPaintInput.visibility` leaves every panel visible. A HIDE is a SUSPENSION, not
  a collapse and not an unmount: the plane is released (wake detach, then client dispose) and
  the clock idles, but the element, its painted rows, its open row disclosures and its filter
  survive untouched, exactly as the rail contract asks. A re-show boots a card the reader left
  OPEN with exactly one fresh snapshot read — the frames the drawer missed are what that read
  answers — and leaves a collapsed one inert.
- **One owner per answer.** A dead plane makes the client hold a pending resync, and the
  next baseline answers it. A panel re-reads on that baseline only when the client is not
  already owed the read, so a reconnect costs exactly one delta read, not two.
- **States.** Five, derived and published as `data-phase` on the panel root: `loading`,
  `empty`, `error` + Retry, `stale`, `ready`. `recordsPanelPhaseOf` is the single derivation;
  the stylesheet switches on the same attribute the tests assert. A closed card carries neither
  a `data-phase` nor a word in the corner box — the surface is cleared and the box stays
  hidden, so the open card is not the default state to be in. The corner box
  (`recordsStatusOf`) adds ONE dimension the phase does not carry: while a read is in flight
  it says `reading` whatever `data-phase` says, because an unanswered fetch is not evidence
  that the rows on screen are behind — a badge that went `live` → `stale` → `live` on every
  re-read was the flicker the reader complained about. `RecordsClient.fetching` is
  edge-detected and stays up across the body-refresh debounce (a queued re-read is the same
  fetch finishing), and each of its two transitions publishes a `fetch` notice, which a panel
  answers by repainting chrome only: no announcement, no arrival, no `data-phase` move.
- **The surface.** `extensions/records-dom.ts` holds the pieces both panels share: the
  pre-mounted visually-hidden `role=status` region and its coalescing announcer, the
  follow controller (frozen reading position + "N new" pill, auto-follow only at the live
  edge), the keyed-list FLIP mover, the "just landed" marker (a LIVE apply only), and the
  relative-stamp ladder that renders `5m` inside `<time datetime>` with the ISO in `title`.
- **Isolation.** Every failure is local to one panel: a refused registration, a rejected
  read or a dead seam changes one rail, never its neighbour and never the shell. Going off
  screen is not a failure at all — the board parks each card it carries, and re-boots an open
  one when the reader opens the drawer again.
- **CSS.** One clearly-marked section appended at the end of `src/frontend/styles.css`,
  namespaced `.panel-tasks-*` / `.panel-records-*`; it overrides nothing above it, and
  `prefers-reduced-motion` plus forced-colors are part of the contract.

Tests: `extensions/records-client.test.ts` (watermarks, windows, the value-honesty rule,
the outage protocol), `extensions/records-wake.test.ts` (one shared registration, fan-out,
release on the last panel), `extensions/records-dom.test.ts` (announcer, follow, FLIP,
stamps), `extensions/records-panels.test.ts` (both mounts end to end: the collapse gates —
both cards mount CLOSED with no read and no registration, and the title press is what boots
the engine and what releases it — the five states, the live burst, the pill, the chips, the
session switch, the teardown, and the drawer suspension: a hidden slot releases the
registration and idles the clock while the rows, the open disclosure and the filter survive
untouched, and a re-show is one fresh boot), and
`src/frontend/records-style.test.ts` (the appended section stays at EOF, the namespace
allow-list, every painted class is styled, the phase/motion/contrast rules).

### Lane workers: `threadExecution: 'worker'`

`src/server/workers/` is the subsystem that lets ONE logical thread (a `ThreadLane`
in `src/server/sessions.ts`) execute its whole turn — agent loop **and** CPU-bound
tool bodies — on its own OS worker thread, while the session's shared state stays
owned by one coordinator. The default remains `inline`, so nothing changes shape for
an existing host.

Layout (each file states its own contract in its header):

| File | Owns |
|---|---|
| `protocol.ts` | the frame vocabulary (`hello`/`turn`/`invoke`/`steer`/`interrupt`/`event`+`event.ack`/`mutation`+`mutation.receipt`/`request`+`request.reply`/`turn-done`/`aborted`/`fault`/`dispose`/`broadcast.registry`/`sync.memory`/`sync.tools`/`lease.grant`) plus the epoch / seq / callId / event-credit rules — `sync.tools` is the additive, one-way `{ enabled, withheld }` tool-state reconcile (`LaneToolStateSync`) that keeps a warm lane on this conversation's switches; it moved no `LANE_PROTOCOL_VERSION` |
| `lane-identity.ts` | the authority's id ledger: leases per id space, in the core's own units |
| `lane-commit.ts` | mutation ops + receipts, the writer-lease ledger, and the journal that decides when a turn may be published |
| `lane-memory.ts` | `harness.memory` across lanes: faithful transfer, bounded declared windows, compare-and-set, named refusals |
| `lane-authority.ts` | the COORDINATOR side: answers a lane's routed `runtime` calls on the canonical harness, folds and replays a commit group |
| `lane-host.ts` | the per-store worker manager: entry resolution, spawn, hello, event relay-then-ack, ordered mutating answers, receipts, crash teardown, idle reclaim |
| `lane-worker.ts` | the spawned **entry**: source vs built layout, resolve hooks for `.ts` in dev/test |
| `lane-worker-loop.ts` | the worker loop: rebuild, capability report, runtime interception, operation derivation, commit boundaries |
| `capability.ts` | what may run in worker mode at all, per harness and per tool, with the reason and the fix |

The three load-bearing decisions:

- **State moves as operations with receipts, never as a merged document.** The first
  cut let each lane mutate a full harness replica and merged the record diff
  last-writer-wins; an independent review (`Temp/t3`) reproduced, through the core's
  own validators, what that lost: a rejected `nextId`, one of two concurrent terminal
  results, a spent tool budget, a sibling's memory key deleted by a lane that never
  read it, and mutations silently dropped. So an append carries the prefix length the
  lane saw, an IN-PLACE rewrite of the already-committed prefix carries the digest of that
  prefix (`transcript:patch` — the write a plugin's `setIncluded`/`edit` makes changes no
  length at all, so the append condition could never see it and the change died with the
  worker process; the lane now keeps a `committedDigest` beside its `committedLength` and
  the authority replays the rewrite through `harness.patchThreadMessages`), a memory write
  carries the digest it read, and a terminal invocation
  carries an authority-leased identity — a collision is a REFUSAL naming the
  canonical value, never an overwrite.
- **A lane's run frames carry the LANE's epoch (T-W8).** `HARNESS_PROCESS_EPOCH` is minted
  per PROCESS, and a lane is a real `node:worker_threads` worker with its own module registry
  (`lane-host.ts`), so the ids a lane mints are stamped with the LANE's epoch even when
  `reserveIdentity` has leased it a range: the lease stops two replicas minting the SAME
  identity for different work, and the epoch says which process actually wrote the frame — a
  fold reading one recorded stream needs the second fact, and it cannot be inferred from the
  id, because `reserveIdentity` only ever RAISES a leased counter and never mints an identity.
- **The authority intercepts the replica's own `harness.runtime` object** (the same
  reference `src/harness.ts` builds at ~2415 and the core tool sources call), not the
  `harness.runtime` property. That is what makes the interception total: harness
  internals call `runtime.*` locally, so a slash command or a manual tool body running
  on a lane is routed too. `search` and `fetch` stay local — their provider and network
  waits are the work isolation protects. `delegate` is classified local as well (the
  key exists on the replica and nothing crosses for it), but a replica REPLACES it with
  the nested-run refusal below, so the classification describes the routing, not a
  promise that it runs.
- **Nested conversation state is refused, not weakened silently (S7 + T14).** `delegate` and
  `threadFork` each start a CHILD conversation, and adopting a thread by an EXISTING id
  needs a core seam the authority does not have (it can mint an id, mirror a status, and
  archive a result — `appendThreadMessages`/`setThreadStatus`/`archiveInvocation` — but
  not adopt a whole thread). Running them lane-locally produced a real answer behind
  phantom state: the archived child result reached the coordinator while the canonical
  roster could not list the child and its transcript died with the lane. So
  `lane-worker-loop.ts` `refuseNestedRuns()` closes FOUR kinds of door at hello:
  1. it deletes the two registry entries (the run builds its declarations from that registry —
     `declared()` maps the enabled set through `tools[name]` and `visibleCoreTools`, which iterates
     `Object.values(tools)` — `src/harness.ts:2228-2240`/`:3620-3623`, and it resolves a call through the
     same map (`:7810`); `threadFork`'s dispatch is a core CONTROL path keyed on the definition
     OBJECT in `runtimeControlDefinitions`, a marker a rebuilt replica definition can never carry
     (`:1306`, read at `:7973`));
  2. it replaces `harness.runtime.delegate` (the route
     `src/tools/runtime/delegate.tool.ts:120` calls) with a thrower;
  3. T14/T15 — it ARMS the core nested-run policy (`replica.nestedRuns('refuse')`) on EVERY lane it
     starts, whatever preset that lane rebuilt: the arm follows the execution mode, there is no
     per-preset flag to read, and it runs before the capability report and before any frame is
     serviced, so no tool body can be reached unarmed. Steps 1-2 close the doors that go through a
     tool or a runtime route; they never reached the doors a tool BODY holds. T13 measured the gap:
     the shipped `textSummarize` called `ctx.run(...)`, the child answered, and its transcript died
     inside the lane, while `refuseNestedRuns` reported a clean removal. The policy is core state
     (`src/core/nested-runs.ts` owns the code, the sentence and the validated arm), and T15 keeps it
     enforced at the SURFACES rather than at a stack depth: `ToolContext.run` refuses at all three
     construction sites (the model dispatch, `invokeRegisteredTool` and `executeToolInternal` — the
     last two pass NO parent run, which is why a `runAgent` lineage check alone was not enough),
     `runAgent` still refuses anything that reaches it with a parent or as a branch, `context.agents`
     is a guarded view whose `turn()`/`stream()` throw at the READ, and a refusing instance hands the
     body `toolHandleView()` instead of the raw handle — its callable, `sendThreadInput` and every
     brain under `agents` (each wrapped by `toolAgentsView`/`guardedBrainOf` so `turn`/`stream`
     throw at the READ) throw WHENEVER they are reached; the one surface the guard hands out
     readable is `ranks`, the frozen copy of the resolved rank map that replaced `subagents` — so
     a body that stores
     `context.harness` and fires it from a callback after its own call settled is refused exactly
     like a call inside the body, which a timing window (`toolBodiesRunning`) could never bind. That
     window stays only as the backstop for a RAW handle a host-defined closure (no scanned source,
     reported as `closure-definition`) captured in its own scope, and it skips a run that arrives
     with a `threadState`, so a direct tool call running alongside the lane's own authorized turn can
     never refuse that turn. Plain reads and the routed `harness.runtime` operations pass through the
     view untouched, an inline harness still receives the strict-identical live handle, and a write
     made through the view lands on the live replica (it is a guard, not a copy). Every door throws
     the named `nested-run-unsupported` error BEFORE a thread record, a transcript append or a
     provider request exists, and the read-back in `refuseNestedRuns` turns an absent seam (a
     worker entry pinned somewhere else that predates the seam) into a hello `fault`: the handshake is rejected, and there is no inline
     fallback.
  The refusal is one formatter, so no surface can paraphrase it: `capability.ts` re-exports the
  code and words the tool-name spelling (`NESTED_RUN_TOOL_NAMES`,
  `NESTED_RUN_LIMITATION_CODE`, `nestedRunLimitationMessage`), `NESTED_RUN_ARMED_DOORS` (four doors:
  `context.run`, the callable, `sendThreadInput`, a sibling brain run) +
  `nestedRunHandshakeLimitations()` state the armed doors in the hello `limitations`, and a
  per-BODY textual scan (`LANE_NESTED_RUN_DOORS`, `reachesNestedRunDoors`) reports a
  runtime-refused door (`context.run`, `callTool('delegate')`) as a warning while REFUSING, before
  it is installed, the revisions whose OWN source starts the child (`context.harness(...)` used as a
  runner, `agents.<name>.turn()/stream()`) — not because the runtime is blind to them (T15 refuses
  those very doors at the handle a refusing tool is handed) but because such a body has no
  worker-safe path left, and installing it would promise the model a call that can only fail. The
  scan states its own limit on the surface: it is textual, a computed member or an uncaptured helper
  can miss it, and the armed core — not the pattern — is the guarantee for every spelling, named or
  missed.
  A shipped tool with a real local path takes it instead of failing: `textSummarize` reads
  `context.nestedRuns` and condenses the notes on a lane (its documented no-summarizer
  fallback), so worker mode neither loses a child nor bans the toolbox over one call. Cross-thread
  work is NOT in that set: `threadSend`/`threadList`/`threadDelete` route to the authority and
  `threadRead` reads through it, so the roster feature survives worker mode intact —
  `threadDelete` (B5, 2026-11-13) is classified in `AUTHORITY_RUNTIME_METHODS`
  because it moves canonical state (record, transcript, invocation/branch lookups,
  and the host-thread slot the cap counts); the TARGET travels as the request's
  `threadId` while the CALLER travels inside `identity`, so the authority scopes the
  release to the lane caller's own descendants and `applySync` rebases the lane's
  mirror of every conversation the cascade removed.
- **A commit is applied through targeted core seams, never `restore()` per commit.**
  `restore()` rebuilds every created tool and thread agent and zeroes each thread's
  generation, i.e. it spends coordinator CPU and disturbs live handles. The four seams
  (`appendThreadMessages`, `setThreadStatus`, `archiveInvocation`, `reserveIdentity`;
  `src/harness.ts` ~3833-4060) are the whole applier surface, and each validates its
  own input so a rejected lane write mutates nothing.

Node-24 facts this subsystem paid for (all still true, don't re-derive them):

- a worker does **not** service `parentPort` messages while its module body is still
  evaluating, so the loop must be driven from the message handler, not from a
  top-level await;
- `module.registerHooks` must **not** return `format: 'module'` for a `.ts` file —
  that routes it through the JavaScript compiler and loses Node's type stripping;
- a source-mode worker needs `execArgv: ['--experimental-transform-types']` for this
  repo's parameter properties;
- an unreferenced dynamic import is shaken to an empty namespace by a bundler, so
  the entry imports the loop AND calls `startLaneWorker()` — the manifest says
  `"sideEffects": false`, so that explicit call is both what a bundling consumer keeps and
  what starts the loop when the thread loads `src/server/workers/lane-worker.ts` itself
  through `src/server/workers/worker-boot.mjs`;
- `workerData` is read-only and a cloned `AbortSignal` arrives as `{}`, so
  cancellation is a FRAME (`interrupt`), never a signal copy;
- the global `Worker` is undefined in this Node build; `node:worker_threads` is used.

Two more contracts are enforced at the coordinator boundary, because both used to be
claimed before anyone knew:

- **A steer is answered by the worker, not by the post.** `lane-host.ts` `steer()` returns
  `Promise<LaneSteerReceipt | undefined>`: `undefined` when no live lane owns the
  conversation (the store then answers from the canonical harness, exactly as inline does
  once a run ended), otherwise the worker's own `steer.result` receipt — `{queued: true}`,
  or `{queued: false, reason}` naming the refusal. Waiters are a per-turn FIFO (the frame
  pair carries no steer id, and a lane has one live turn), and a turn that ends, faults, or
  a lane that dies settles every outstanding waiter `false`. `sessions.ts` `steerOnLane`
  forwards THAT, so `steered: true` on `POST /sessions/:id/tasks` is now evidence the
  guidance reached the running conversation, not evidence a frame was posted.
- **The declared memory window follows the installed revision.** `sessions.ts`
  `memoryKeysFor` scans with `workers` `toolScanTextOf` (the `moduleText` + captured
  helpers, the field a `format: 'module'` registration actually fills — T10 finding M5) and
  caches per session keyed on the sorted `name + revision` fingerprint of
  `harness.toolSources()`, so `toolCreate`/`toolManage` refreshing a revision recomputes the
  window instead of keeping the one captured at session build.

Tests: `src/server/workers/lane-authority.test.ts` (19 in-process cases against a
REAL harness — prefix refusal, one-writer lease, central archive with reassigned
order, memory CAS, routed `task`/`threadSend`/`threadList`, lease disjointness,
retired epochs answering nothing), `lane-worker.test.ts` (10 live-worker cases: two
lanes busy simultaneously, an 800 ms burn while a sibling's event stream grows, a task
written on one lane read back by a REBUILT lane, cross-thread send/roster from a lane,
a cancel with events frozen, a terminated worker failing the turn with canonical
transcripts frozen, an unrebuildable preset refused at create, the nested-run removal
against a REAL preset harness, and the steering receipt from both angles),
`lane-worker-correctness.test.ts` (T11: eight turns of one conversation with the lane
reclaimed between each, a message another lane sent while this one was idle, a
cross-thread read answered from canonical state the lane never created, the
`maxLaneWorkers` cap with the evicted lane still usable, and an in-flight turn settled
by `host.close()`), plus
`lane-commit`/`lane-identity`/`lane-memory`/`protocol`/`capability` for the
primitives, `io-worker-bridge.test.ts` for the durability path, and
`config.test.ts`/`environment.test.ts`/`server.test.ts` for the runtime surface.

### IO workers: `ioExecution: 'worker'`

The lane workers isolate a turn's CPU; the IO worker isolates **durability**. One
thread per database root owns the write side of the v2 shard tree —
`harness/index.json`, one `harness/sessions/<id>/session.json` per session and one
`harness/sessions/<id>/threads/<threadId>.json` per conversation — plus
`harness/sessions/<id>/events.jsonl`, so the per-shard stringify plus
mkdir/open/write/fsync/rename no longer block the loop that serves every other session
and every open stream (the `harness.v1` WebSocket — there is no SSE route left, see
[API](#api)). Protocol **version 3** is the current frame set
(`IO_PROTOCOL_VERSION`, `src/server/workers/io-protocol.ts:129`): version 2 turned a commit
from one `checkpoint.save` frame carrying the whole document into one `shard.save` frame per
file, and version 3 added the `shard.erase` kind so worker mode can also REMOVE what a
document stopped naming — neither addition is addable, so a mismatched entry fails the
handshake (`:109-129`). The durability
rules were not relaxed to make the split, only the payload got smaller. The flag is
independent of `threadExecution`: a deployment may
want either, both, or neither, and the default for both is `inline` (today's behavior).

Layout (`src/server/workers/`, same subsystem barrel as the lane workers):

| File | Owns |
|---|---|
| `io-protocol.ts` | the data-only frames (`shard.save`, `shard.erase`, `journal.open/append/flush/rewrite/truncate/remove/close`, `hello`, `shutdown`), the commit order `IO_SHARD_ORDER` (`thread` → `session` → `index`, `:188`, applied by `orderIoShardUnits` `:643`), the three outcomes (`durable` / `written` / `superseded`) plus the additive `skipped` flag on a `result` (`:406-414`), the flattened `{message, code, path, cause}` error report, and the callId source |
| `io-client.ts` | the coordinator side: one FIFO queue per root, the handshake gate, strict-vs-queued semantics, the document→shard split (`harnessShardUnitsOf`, `:506`), the vanished-shard **plan** (`shardErasesOf`, `:1172`) and its **unawaited** posting (`postShardErase`, `:1152`; strict path `:1426`, queued path via `deferredErases` `:703` drained by `flushDeferred` `:1098-1116`), **per-path** coalescing and per-path byte accounting (`lastShardBytes`, `:248-260`; the worker's skips land in `skippedShards`, `:259`), `barrier`, `close`, the `resolveIoWorkerEntry` chain, and the numbered integration contract at the bottom of the file |
| `io-worker.ts` | the spawned **entry**: source vs built layout, resolve hooks for extension-less `.ts` specifiers, and the explicit `startIoWorker()` call the bundler needs to keep the loop |
| `io-worker-loop.ts` | the thread body: the operation table, one per-shard commit per frame (`runShardSave`, `:302-384`) **with the worker-side skip gate** (`committedShards`, `:142`, judged on digest + `size`/`mtimeMs` witness at `:355-367`), the erase handler (`runShardErase`, `:401-423`, which calls persistence.ts's `eraseHarnessShardPaths` — the same primitive the inline collector uses), the cached per-session `HarnessJournal` (the append fd lives HERE), the staging owner `<pid>.io<threadId>` (`:108`), the shard-layout refusal (`shard-layout`, `:307-320`) and the frame bound enforced on the true serialized length of THAT shard (`:322-341`) |

Invariants, in priority order:

- **ORDER.** Frames are posted in call order and answered one at a time (every
  operation inside the thread is synchronous), so a journal append reaches the file
  before the checkpoint that lists it, a reset's truncate precedes the record that
  forgets those turns, and a `journal.flush` ordered ahead of a save fences the tail.
  The rule `src/server/journal.ts` always relied on becomes structural. Inside one
  commit the same queue applies `IO_SHARD_ORDER`, so a thread shard is on disk before
  the `session.json` that indexes it and that before `index.json` — a reader starting at
  the header never follows a reference to a shard written after it
  (`io-protocol.ts:46-52`, `:161-176`).
- **NO FALSE SUCCESS.** An awaited operation resolves only on the worker's own success
  receipt and rejects with the exact message the inline writer throws, so a 500 body is
  identical in both modes. A QUEUED operation never claims durability at all — it
  claims order — and its failure goes to the same channels the inline
  `journal.error` / `persistence.lastWriteError` feed. A coalesced-away shard is
  counted `superseded`, in total and per path (`io-client.ts:57-64`, `:1003-1042`), never reported
  as written. **No composite claim**: each `shard.save` answers for itself, and nothing
  reads "all shards durable" out of the index receipt, because the index rename does not
  fsync the shard renamed before it (`io-protocol.ts:72-77`).
- **SKIP AND GARBAGE COLLECTION, RE-HOMED — NOT MISSING.** Both modes skip a shard whose
  bytes did not change and both remove the shards a commit stopped naming; what differs is
  WHERE the skip is decided and WHEN the erase is awaited. Inline decides it in
  `commitShardIfChanged` (`src/server/persistence.ts:2994-3011`), worker mode on the worker
  in `runShardSave` against `committedShards` (`src/server/workers/io-worker-loop.ts:142`,
  judged at `:355-367`) — the only place that can decide it there, because only the worker
  holds the serialized bytes; a restarted worker starts with an empty map and re-commits each
  shard ONCE (`:135`). Removal is one shared primitive, `eraseHarnessShardPaths`
  (`src/server/persistence.ts:3086-3106`): inline calls it inside `save()`
  (`eraseVanishedShards`, `:3025-3052`), worker mode posts a `shard.erase` frame whose exact
  `files`/`trees` the coordinator derives from `persistence.shardFootprint` (`:2577-2583`) and
  hands to the queue UNAWAITED behind that commit's writes
  (`src/server/workers/io-client.ts:1426` strict, `:1115` queued). No new durability outcome:
  an erase failure answers `failure` with code `shard-erase`
  (`src/server/workers/io-worker-loop.ts:412-421`), is not put on the sticky persistence-error
  channel (`noteFailure`, `src/server/workers/io-client.ts:822-844`), and leaves bytes `load()`
  never lists — disk, not correctness.
- **ONE WRITER.** The store still owns the state and builds every record. In worker mode
  it must not write through a coordinator-side `HarnessJournal` for a session the client
  owns (two append handles is two writers), so `attachJournal` creates a READER only and
  the open/append/rewrite/truncate/remove/close calls are queued. Reads
  (`persistence.load`, `journal.read`) stay on the coordinator by design.
- **NO INLINE FALLBACK.** A missing entry, no `node:worker_threads`, a thread that dies,
  or a protocol-version mismatch throws a named `HarnessIoError`, fails every
  outstanding operation, and aborts startup. `startHarnessServer` awaits
  `store.ioReady()` before `listen`, and `close()` awaits `store.drainIo()` so the
  graceful commits are on disk before the process may exit — with `summary.failures`
  listing what is NOT known durable.
- **TERMINAL FENCES (new, strictly stronger than inline).** A cancel / cancelThread /
  turn-start / command-terminal commit maps to `io.commitCheckpoint({ document,
  fenceSessions: [session.id] })`. Inline never fsynced at those sites, so worker mode
  is an upgrade, not a parity claim.
- **BOUNDED, NOT FREE.** The record build and the structured clone of each frame stay on
  the main thread (the authority owns the state), and EVERY checkpoint re-fans the whole
  document into units (`harnessShardUnitsOf`, `io-client.ts:506`), so per-commit fan-out,
  clone and the worker's stringify are O(total store) — the split buys the **write syscall**
  and the **failure radius**, not cheaper CPU; an unchanged shard is not opened at all in
  either mode (see the bullet above). Each SHARD frame is bounded by
  `maxFrameBytes`, measured by the worker per shard (`io-worker-loop.ts:322-341`) and fed
  back per path so the client's guard is O(1) for that path (`io-client.ts:912`,
  `:1288-1292`) — one oversized conversation
  stops being cloned without freezing the other sessions' writes
  (`io-client.ts:44-49`).
- **ABANDONED-ATTEMPT EVIDENCE SURVIVES A RESUME — AND THE NEXT COMPACTION (F4, 2026-11-17).**
  A resume re-runs a turn IN PLACE: `requeueTurnInPlace` splices every event after the last
  `attempt_commit` out of the turn record and then compacts the log. Both halves were correct
  about the resumed row and both were destroying the evidence — the abandoned attempt's streamed
  steps AND its terminal `error` frame left the record and the file in the same instant, which
  is why a `provider-timeout` could appear ZERO times in an `events.jsonl` whose run died of
  exactly that. It now writes the evidence BEFORE the truncation, in two copies that are
  deliberately different sizes: `recordRollback` appends ONE journal `rollback` line holding the
  FULL dropped tail in order (each entry keyed by the index it held in the abandoned attempt,
  plus the `boundary` — the index of the last kept `attempt_commit`, or `-1` when the attempt
  committed nothing — and the `reason`, read out of the tail's own `error` frame before it
  leaves), and it keeps a BOUNDED summary in the session shard (`Session.rollbacks` → the
  additive `HarnessSessionRecord.turnRollbacks` → `SessionSnapshot.turnRollbacks` /
  `SessionView.turnRollbacks`): boundary, count, reason capped at `ROLLBACK_REASON_LIMIT`
  (240 chars, because a shard is re-read on every restore) and the dropped `error` frames
  verbatim — the last `TURN_ROLLBACK_LIMIT` of them, since every other frame survives there only
  as the `droppedEvents` count. Caps: `JOURNAL_ROLLBACK_LIMIT` = 64 journal lines per session and
  `TURN_ROLLBACK_LIMIT` = 10 records per turn, and in both cases the OLDEST evidence goes first —
  the newest abandoned attempt is the one an operator debugs. A refused append is NOTED, never
  thrown: a resume is the user's
  recovery action and must not fail because the evidence copy could not be written, and
  `undoRollback` reverses both copies when the persist that follows fails.
  - **`compactJournal` no longer writes only the turn being re-run.** The old rewrite took a
    `turnIds` filter and silently dropped every OTHER conversation's event lines (they survived
    only in the shard, so a journal rebuild could no longer see them), and it ran BEFORE the
    in-memory rollback while the recorder had already written the abandoned attempt's frames
    into the live row — so it re-published the very tail it meant to remove. It now emits the
    live event records of EVERY turn of EVERY conversation plus one `rollback` line per
    registered abandonment (`session.journalRollbacks`), and `HarnessJournal.read` returns the
    rollback lines on their own channel (`JournalReadResult.rollbacks`) that
    `mergeJournal` loads only to keep them durable — folding them would resurrect a step whose
    indices belong to an attempt that no longer exists.
  - **The header's `createdAt` survives a compaction.** `rewrite` used to stamp
    `Date.now()`, so the one file whose whole purpose is being the durable per-step record of a
    session claimed to have been BORN the moment its first resume compacted it. `open` now
    captures the original value from the first 4 KiB of the file (a bounded read, because a real
    journal is megabytes of token deltas and a stamp must not pay a full read) and `rewrite`
    re-emits it; a log whose header cannot be read honestly means "now". The value is exposed as
    `HarnessJournal.createdAt`.
  - **Why the worker mode needs the shard copy.** `rewrite`'s payload widened from
    `JournalEventRecord[]` to `JournalRewriteRecord[]`, and each record keeps its OWN `type` —
    the old writer forced `'event'` on every line, which would have rewritten a rollback line
    into a bogus step. The discriminator is `=== 'rollback'`, NOT `=== 'event'`, because the IO
    worker's `journal.rewrite` frame carries `IoJournalRewriteRecord`s WITHOUT the `type`/`v`
    stamps (the writer adds them), and an event-test would send every worker compaction down the
    rollback arm — 0 events back from `read()`. The coordinator's rewrite channel still carries
    EVENT records only, so in `ioExecution: 'worker'` the shard summary is the ONLY copy that
    mode gets (`recordRollback`'s append is inline-only — the coordinator holds no journal handle
    for a session the client owns), and the rewrite the worker performs republishes every live
    event record and no rollback line. Inline mode has both copies: the coordinator owns the
    append handle, and `compactJournal` hands it the live events plus
    `session.journalRollbacks` in one call — which is also why that in-memory list exists at all,
    since `read` returns the lines the file holds and `mergeJournal` re-arms the list from them
    (`slice(-JOURNAL_ROLLBACK_LIMIT)`) so a restart does not let the next rewrite forget them.

`SessionStore` opens the client in its constructor when the resolved runtime says
`ioExecution: 'worker'` (or when a host injects `options.io`), and the strict path is
`await`ed through 17 `persistOrThrow` call sites — which is why `create`, `enqueue`,
`reset`, `remove`, `cancel`, `cancelThread`, `deleteThread`, `updateThreadTranscript`,
`setAgentModels`, `persistRegistry` and `mutateRegistry` are async on the public store
surface, and why the dispatcher awaits them before building a response.

Tests: `src/server/workers/io-protocol.test.ts` (frame validation and the outcome
table), `io-client.test.ts` (a REAL spawned worker: ordering, barriers, error close,
source-mode entry, and byte identity with the inline writer), `io-worker.test.ts` (the
operation table in-process), `src/server/io-worker-bridge.test.ts` (the store and the
standalone listener: readiness, off-loop strict writes, a failed commit that rolls back
with the inline message, journal ordering + reload, reset/delete/dispose queueing,
shutdown drain, and the off-thread durability round-trip), and
`scripts/check-package-runtime.ts` (the SHIPPED `src/server/workers/io-worker.ts` entry,
spawned through `src/server/workers/worker-boot.mjs` from a copied published install,
handshakes, commits, journals and is re-read by the server that same install starts).

### Agents and the harness registry

`src/agents/` is the trusted catalogue: one `AgentProfile` per agent with `name`,
`title`, `description`, `instruction`, and `guidelines`. `agentInstruction()`
composes the profile into ONE system prompt — `` `${instruction}\n\nGuidelines:\n- …` `` —
because several OpenAI-compatible gateways accept only a single system turn, so an
`[instruction, guidelines]` pair used to seed two `system` messages and silently lost
the policy on those models. The application builds agents with
`agent({ model, instruction: agentInstruction(profile), provider })`. That join is the
DEFAULT only: with an explicit `instructionOverride` (T6) `agentInstruction()` returns the
stored text verbatim as the complete prompt, so the guidelines never double up under an
operator's edited box. Nothing in a profile is secret, and a client cannot supply one.

`src/server/harnesses/registry.ts` is the in-memory harness registry shared by the store and
the dispatcher:

- `list()` → shipped templates (preset order) then user-created harnesses; each entry
  is an independent COPY of its template (R20.1), never the module object;
- `find()` resolves legacy aliases (`writer`/`assistant` → `instruct`,
  `researcher` → `research`) for session creation; `update()` deliberately does not
  accept an alias;
- `create()` validates a new name (letters/digits/`_`/`-`, ≤64, case-insensitively
  unique, not an alias), the ROSTER (`normalizeRoster`: distinct, ≤`MAX_ROSTER_AGENTS`
  = 16, every name known and selectable), an optional `entry`, and an optional `ranks`
  map, then builds a live harness with the shared toolbox and
  `builtin: false, editable: true`. THE ROSTER IS RESOLVED FIRST because the other two
  roster fields are validated against it: `entry` must be a MEMBER and every `ranks`
  KEY must be a member. `agents` is the client's own explicit list now (it used to be
  DERIVED as `[primary, ...subagents]`) and its order is load-bearing, because it is
  the display/cycle order. `entry` is optional and defaults to `roster[0]` — a ROUTING
  default only: the rank map says authority, nothing requires the entry to hold Rank A
  or to be the only Rank A member, so a two-Rank-A harness is a normal shape and there
  is no "exactly one" check left to fail. `ranks` is normalised (`normalizeRanks`: keys
  must be members, values must be rank letters) and then RESOLVED into the map the
  harness runs with (`resolveRosterRanks`, `src/server/harnesses/toolbox.ts:252-275`,
  applying the kernel's rule 1, `src/harness.ts:1536-1545`): an omitted map is entry `A` +
  every other member `B`; a stated map is validated then filled one rank below the
  lowest rank it names; `ranks: {}` is the flat team it reads as (every member `B`, no
  delegation anywhere). The registry stores the RESOLVED map, so the durable record,
  the card and the construction argument state the SAME ranks and the operator's map is
  resolved ONCE here instead of re-derived at every start;
- `update()` changes `title`/`description`/`entry`/`ranks`/`agents`/`agentModels`/
  `agentInstructions`/`agentColors` for
  **every** entry (there is no 403/read-only branch; `editable` is a compatibility
  wire field, always true). It **replaces** the preset object instead of mutating
  it. A metadata-only patch keeps the captured factory. An executable patch
  (`entry`/`ranks`/`agents`/`agentModels`/`agentInstructions`/`agentColors`) rebuilds
  from the `template`:
  `live` uses `createProfiledHarness`, and `flaky` — the marker the deleted example
  preset carried, still rebuildable for a saved row or an injected preset — goes
  through `createToolboxHarness` with `extraToolSources: {}`, since no shipped preset
  contributes an extra tool any more. A `scripted` record has no shipped factory any more:
  `presetFromRecord` rebuilds it only from a matching injected `fallback`, and otherwise
  throws `Scripted harness "<name>" is not shipped in this build`, which the session store
  turns into a per-session restore DROP with a readable reason rather than a silent
  substitution. ENTRY PRESERVATION replaced the old "changing the primary removes it
  from `subagents`" rule, which reached its guarantee from the other direction: an
  omitted `entry` keeps the current entry whenever the same patch left it a member
  (re-targeting routing is a SEPARATE decision from changing the team) and falls back to
  `roster[0]` when the patch dropped it, so a patch can never leave a harness routed at
  an agent it no longer contains. Ranks follow the same shape: a stated map REPLACES the
  stored one and is filled for every member it does not name; an omitted one keeps the
  current ranks RESTRICTED TO THE SURVIVING MEMBERS, and a member the patch ADDED takes
  the filled value (one rank below the lowest rank that survives), so a newcomer never
  lands at Rank A by accident and a flat harness stays flat. A rank for a member this
  patch removed is DROPPED, not rejected (it is neither a target nor a delegator any
  more), exactly like a model/instruction/color override for the same member.
  THE EMPTY-MAP DISTINCTION IS THE CLIENT'S, NOT THE HOST'S: `ranks: {}` in the body is
  an explicit "make this team flat", while an OMITTED map is "no opinion" — and when a
  roster swap drops every member the retained map is legitimately empty, so it passes
  `undefined` to the resolver and gets the same rule-1 default POST would, rather than
  silently flattening a team the client never described as flat;
- `remove(name)` (T5) deletes any entry by its DIRECT name (an alias is a read redirect,
  not an identity), returns the removed preset, and answers 404 for an unknown or
  already-deleted name. A deleted **built-in** also records a tombstone
  (`deletedBuiltins()`), persisted as the additive `deleted` array in the document header
  `index.json` (`src/server/persistence.ts:2299`),
  because a fresh registry always re-seeds the shipped templates - the missing row
  alone cannot express a deletion. A deleted **user** harness needs no tombstone (its
  row is simply gone). `create()` clears the tombstone for the name it takes, so
  re-creating `instruct` survives its own restart, and `restoreHarnessRegistry` replays
  the tombstones BEFORE the saved rows. `snapshot()`/`restore()` give the durable commit
  path one rollback for create/patch/delete: `SessionStore.mutateRegistry` writes the
  document and restores the snapshot (entries, listing order, tombstones) when the write
  fails, so `DELETE` never answers `{ deleted: true }` for a harness the next restart
  brings back. The REGISTRY primitive is session-unaware on purpose: `remove()` never
  counts, deletes, or refuses over sessions, and an existing session keeps running (and a
  saved one restores) from its own frozen preset record. Ownership is enforced at the
  SERVER boundary instead - `deleteHarness` in `src/server/api.ts` answers `409` while any
  live or restored session's `preset.name` still equals the DIRECT name being removed - so
  the reusable registry stays free of store knowledge while the operator-facing route
  cannot create an orphaned conversation. The SAME direct name is the knowledge owner:
  `SessionStore.buildHarness` stamps `preset.name` onto the report
  (`knowledgeOwner`), the engine writes it to each article it creates, and after a successful
  registry commit `deleteHarness` calls `SessionStore.removeKnowledgeOwnedBy(name)` so exactly
  that harness's articles leave the shared base (T6 - see "Cross-session knowledge"; a
  cleanup failure is a `500`, because the registry and the base are two stores with no shared
  transaction);
- `agentModels` (R9) is a map of selected agent id → model id on create/patch. Keys
  are validated against the FINAL roster set (unknown key = 400
  naming the members), values are trimmed, non-empty, ≤200 characters, and free of
  control characters. `update()` REPLACES the map when one is stated — `{}` clears
  every override — and otherwise keeps only the entries whose agent is still
  selected. `createProfiledHarness(entry, roster, ranks, agentModels, agentInstructions,
  agentColors, customAgents, toolbox?)` (`src/server/harnesses/toolbox.ts:558-575`) captures the
  map in the factory closure, so `update()` builds a NEW closure and a harness edit
  never reaches an existing session; that session's models change only through
  `PATCH /sessions/:id`. Only ids are overridable: provider, base URL, and key
  always come from `RunnerSettings`. `describeHarness()` emits the override map
  only when it is non-empty, so an omitted agent reads as "session default";
- `agentInstructions` (T3 editable configuration) is the parallel map of selected
  agent id → instruction OVERRIDE on create/patch. Same validation shape
  (`normalizeAgentInstructions`: keys must be FINAL members, values trimmed,
  non-empty, ≤8000 characters, and free of control characters except tab/newline/CR,
  so multi-line prose is legal) and the same REPLACE semantics (`{}` clears every
  override). It is EXECUTABLE state: `update()` rebuilds the factory (an instruction
  patch on an injected scripted fixture therefore upgrades it to a live harness,
  exactly like a model patch), it is persisted in the registry record, and `agentInstruction(profile,
  override)` returns the stored text VERBATIM as the COMPLETE prompt (T6) — the profile's
  `guidelines` are the default an UN-overridden member runs on and are never appended
  underneath an override, and the trusted profile in `src/agents` is never rewritten. A
  member the map omits runs the trusted `GET /agents` instruction, which is why the
  descriptor carries the OVERRIDE map and the UI edits one box holding the full effective
  prompt (composed from `instruction` + `guidelines` when there is no override). Sessions
  are deliberately NOT part of this contract: a running
  conversation's system messages are already seeded, so `PATCH /sessions/:id` still
  accepts `agentModels` only and the frozen `harnessDefinition` records the overrides
  the conversation was built with;
- unknown names are 404; duplicate names are 409; everything else is 400. No
  registry failure is a 403.

Semantic validation lives in the registry; the dispatcher rejects unknown body
fields, so a bare `instruction`, `tools`, or `provider` cannot be smuggled into a
create/patch request. `agentModels` is the single model-shaped field: it selects an
id, never credentials. `agentInstructions` (T3) is the single text-shaped field: a
per-member OVERRIDE stored on the harness, validated and bounded by the registry,
that never rewrites the trusted profile. The registry is **in memory only unless a database root is
supplied**: with one, registry metadata is saved in the document header
`<root>/harness/index.json` and
replayed on restart (see the Persistence section in README.md); without one, a
restart returns to the shipped catalogue.

Sessions capture the resolved preset AND a `describeHarness()` snapshot at
creation. **Team membership, the ENTRY agent, the resolved RANK MAP, and that descriptor
are frozen**: a
registry change affects future sessions only, and the existing session keeps
running (and reporting) what it was built with, including its frozen
`harnessDefinition` (`entry` plus the resolved `ranks` map). Rank is why the freeze
matters MORE than it did under the old vocabulary: the delegation surface this
conversation has been using is a FUNCTION of those ranks, so
`PATCH /harnesses/:name` can never take `delegate` away from, or hand it to, a session
that is already running — the session's own frozen map is the only authority it reads
(`src/frontend/contract.ts` `ranksOf` and `src/server/api-reads.ts` `rankOfMember` read
`definition.ranks` and nothing else, the latter with a lowest-rank fallback when no map
is stated). The same descriptor projection feeds `/harnesses`, so a card
and a session snapshot cannot disagree.

**Agent models are the one live mutation (R2).** `SessionStore.setAgentModels`
(`PATCH /sessions/:id`) validates the map with the registry's shared
`normalizeAgentModels` against this session's members, applies it all-or-nothing by
calling `agent.model(value)` on each brain, and returns the ordinary snapshot.
Rules that matter:

- it **merges** into the live map (an agent absent from the body keeps its model),
  unlike `PATCH /harnesses/:name`, which replaces the override map;
- `{}` is a 400 no-op, an unknown key or invalid model id is a 400 with nothing
  applied, and a rejected patch leaves every agent unchanged;
- it is **allowed while busy** (streaming run or manual tool call) and never
  aborts or rebuilds anything; `agent.turn()` captures `requestModel` before the
  transport call, so the in-flight request and the assistant message it commits
  keep the old model and the next request uses the new one (a queued task reads it
  when the pump starts that task, so the patch applies there too);
- `SessionSnapshot.model`/`agentModels` are derived from the live brains on every
  snapshot, while `harnessDefinition.agentModels` stays the creation-time record.

This frozen-team rule is not a read-only harness rule: every harness card is
editable (R20.1), and a team edit applies to the next session started. Models are
the exception a saved chat exposes directly.

### Decisions worth keeping

- **No environment autoload in the published library.** `src/` never imports
  `dotenv`; importing `@underload/harness` must not read the host's `.env`. Only
  the Node app entry points load the one package-root file, before provider/search
  configuration, and `.env` stays git-ignored while `.env.example` is tracked.
- **The server is a consumer, not a new layer in `src/`.** `SessionStore` calls the
  same `harness()` a CLI does; neither the CLI nor the server adds tool execution
  or model policy.
- **Sessions are durable only when a database root is supplied.** With one, the
  server writes the v2 shard tree under `<root>/harness/` (`index.json` plus
  `sessions/<id>/session.json` and `sessions/<id>/threads/<threadId>.json`) and a restart
  rebuilds the registry,
  sessions, queues, and core state; without one the store is in memory and a
  restart is a clean slate (the default for direct unit tests). The v1 single-file
  `harness/state.json` is neither read nor removed: an upgrade starts empty and says so
  once (`src/server/persistence.ts:2530-2549`).
- **The queue belongs to the server, not to a response.** `/tasks` answers `202`
  because a task accepted with a socket would die with that socket. CORRECTED IN PLACE
  2026-11-11: this bullet still named the legacy `/messages` route as the one holder of
  the "close cancels" contract and `/events` as a non-owning watcher — both SSE routes
  are DELETED (`src/server/api.ts:12-15`), so NOTHING on the wire owns a run through a
  response any more: the `harness.v1` socket only observes, and a dropped socket (like a
  reload, a hidden tab or a session switch) never stops work. STOP is
  an explicit `{ all: true }` cancel rather than an implicit disconnect.
- **Queue and transcript are one record.** A queued turn is a real `SessionTurn`
  from acceptance (stable id/index, no `startedAt`), and every frame is an upsert by
  that id, which is what lets the UI reconcile instead of rebuilding and lets a
  reload show a backlog. `queueDepth` is derived, not a second source of truth.
- **Presentation is state, not decoration.** Green is reserved for the one active
  run, so completed rows are grey and queued rows neutral; a finished turn can
  never look busy. Markdown/HTML is untrusted: every rendered response goes through
  DOMPurify, and highlighting is a fixed registered language subset to keep the
  bundle small.
- **No CORS, and no request header (standalone).** CORRECTED IN PLACE 2026-11-11:
  this record read "explicit client header" and required `X-Harness-Client: ui` on
  every standalone request. That gate is GONE (T15): the header decides nothing any
  more (`src/server/handler.ts:8-13`), while the browser still sends it as an inert
  marker (`src/frontend/api.ts:601`, `:730`). What survives of its rationale is the
  weaker fact that the standalone listener sends NO CORS headers at all, so a
  cross-origin browser cannot read it and dials the service mount instead of `:5181`.
  The service host is the opposite trade: permissive CORS from the loader, so the
  boundary is an Origin gate (own host or loopback, `src/shared/origin.ts`) and not
  authentication — the SAME rule guards the `harness.v1` stream handshake
  (`isStreamOriginAllowed`, `src/server/stream/mount.ts:46`, deliberately identical to
  the HTTP rule). Dev proxies forward
  `/v1/harness` and stamp the target origin so Host and Origin agree
  (`src/frontend/vite-proxy.ts:31-38`); production serves the UI and API from one
  origin.
- **The server key follows the configured provider, never the client's URL.** A
  single `mergeSettings` (`src/server/config.ts`) serves `POST /models` and
  `POST /sessions`: an omitted/blank key falls back to the configured key only
  when the effective base URL matches that provider's origin + base path
  (trailing slashes normalized); a foreign host/port/path gets no key unless the
  client supplies one. This is what stops `POST /models` or a session from being
  used to exfiltrate `HARNESS_API_KEY`.
- **The boot document's root is an API URL.** CORRECTED IN PLACE 2026-11-11: this
  record named the bootstrap's `rootPath`; the generated document calls the field
  `api_root` (`src/server/api.ts:1947`), and only the browser client keeps a `rootPath`
  member (`src/frontend/api.ts:175`, mapped from `api_root` at `:1650`). Either way the
  value is `/v1/harness`, not a
  filesystem root. File tools use the process cwd and are unsandboxed, so no
  workspace-root option exists or is advertised.
- **Loopback by default (standalone).** `127.0.0.1:5181`. Direct tool calls and
  `workspace` run with the server's permissions and have no sandbox. The service
  host binds `0.0.0.0`; restrict it to loopback (its start options) or a trusted
  network; no global service setting is changed here.
- **Settings are bounded and type-checked once.** Base URL ≤ 2048 chars, model
  ≤ 256, non-string fields are `400` (`SettingsError`), so a malformed settings
  body cannot 500 or carry an unbounded value into provider requests.
- **One toolbox, built explicitly.** Every live harness (built-in and
  user-created) uses `createToolboxHarness`/`createProfiledHarness` with the shared
  registry and `presets: false`, so a session can never see a tool outside the
  advertised toolbox through the library's default preload. Choosing a harness
  changes its agents and routing only.
- **A command turn is terminal before the response.** A `/command` never enters a
  queue or a lane, so it needs neither the single-flight gate nor the pending cap, and
  `POST /tasks` can answer the finished turn in the same `202` envelope a queued task
  gets. The event frames are the ones the renderers already switch on
  (`start`/`tool_call`/`tool_result`, paired by `callId`) with a synthesized
  `name: 'command'`, so no front end learned a new shape, and the transcript survives a
  reload. A command's answer is text with `isError`, not a `usage` tally: nothing was
  billed, and an absent tally beats a fabricated zero.
- **A broken transcript is a successful write.** The transcript is the user's own
  JSON, so refusing a structurally invalid value would strand them: they could not
  save the repair they are typing. Instead the raw value is persisted
  (`invalidThreads`), the live transcript becomes a valid `system` placeholder, and the
  session keeps loading, snapshotting and running. Only an absent `messages` property
  is a `400`, because the service adapter reports an unparseable body as `{}` and that
  would otherwise empty a conversation.
- **Commands and transcripts are server state; the UI stays a renderer.** The browser
  has no command table, no slash parser and no transcript validation of its own beyond
  "is this JSON parseable". It submits the line and PUTs the parsed text, and it draws
  whatever the server recorded — which is the same rule the queue, the timeline and the
  labels already follow.

### Scripts

```bash
yarn cli "task"           # one-shot as the live default preset (instruct)
yarn cli --preset planner # any of the eight shipped presets (all need a provider)
yarn cli                  # interactive Instruct session
yarn cli --serve          # explicit standalone API + built UI on :5181 (CLI opt-in)
yarn dev:frontend         # Vite UI on :5180, dual-stack wildcard (localhost + LAN); /v1/harness proxies to the service on :5000
yarn dev:server           # separate standalone API on :5181 (no Vite/UI), on the same /v1/harness mount
yarn preview:frontend     # built UI on :5180, proxies /v1/harness to the service on :5000
yarn test                 # library + server + shared tests
yarn test:frontend        # jsdom client tests
yarn start-service        # repo root: builds UI for /harness/, serves it + /v1/harness on :5000
```

`dev:frontend` and `dev:server` are independent launches: the first is Vite only
and never calls `startHarnessServer`; the second is the standalone API only and
starts no UI. `HARNESS_DEV_API` (default
`http://127.0.0.1:5000/v1/harness`) selects the Vite proxy target, so the UI can
be pointed at the standalone launcher when that is the server being run — at its own
`http://127.0.0.1:5181/v1/harness`. CORRECTED IN PLACE 2026-11-11: this sentence
named "the standalone `/api` mount"; T13 removed that second mount
(`STANDALONE_MOUNT = HARNESS_API_ROOT`, `src/server/api.ts:307`, and
`src/server/dev.ts:45` prints `mount /v1/harness`), and an `/api` request on the
standalone listener is now the dispatcher's 404. The browser always dials
`/v1/harness/...`; the proxy rewrites the prefix only when `HARNESS_DEV_API` names an
upstream mount path of its own (`src/frontend/vite-proxy.ts:109-115`), and it carries
`ws: true` so the `harness.v1` socket is proxied with the REST reads
(`src/frontend/vite-proxy.ts:90-93`).
There is no generic `start`/`serve`/`server` script: normal hosting is owned by
`@underload/service` (`yarn start-service`), and `startHarnessServer()` is an
explicit API. The root launcher builds the UI with `PLAYGROUND_BASE=/harness/`
and `VITE_HARNESS_API=/v1/harness`, then imports the service entry from the
repository-root cwd after setting `UNDERLOAD_HARNESS_UI=1`; the service entry is
API-only without that opt-in, so `yarn workspace @underload/service start` needs
no UI build. The opted-in gateway serves the page at `/harness/` as well as
`/v1/harness`, so a device on the same LAN can open `http://<LAN-IP>:5000/harness/`
(no auth, trusted LAN only). `src/server/server.test.ts` drives the real HTTP server with the
inline scripted `demo` FIXTURE (injected through `PRODUCTION_WITH_FIXTURES`, since no
example card ships any more): create a session, submit a task (`POST …/tasks` → `202 TaskReceipt`),
continue it, reset it, call a tool directly (`POST /tools/{tool_id}/executions`), and check the
error statuses. CORRECTED IN PLACE 2026-11-11: this line said "stream a task" — the streamed submit
was the deleted `POST /api/sessions/:id/messages` SSE route; the test now posts the durable task and
awaits the record (its own comment at `src/server/server.test.ts:19` names those legacy spellings as
exactly what was removed). `src/server/service-start.test.ts` runs an
actual `vite-node` service gateway that discovers
`src/server/endpoint/harness/service-route*.ts` and answers `/v1/harness`. The UI
build no longer needs a package alias, so `src/frontend/dist` is a plain client
bundle.


## Not built yet

In the order they are expected:

1. **streaming tool output** — `execute` cannot report progress mid-call yet.
2. **context summarization** — pruning AND summarizing are both built, as the two modes of
   the shipped `context-compaction` plugin. `exclude` withholds tool units a later success
   already answered, at the turn boundary, through the `included` flag (a pure rule in
   `src/core/context-pruning.ts`, guarded by `minTokens`, a `safetyTurns` tail horizon and a
   per-pass unit bound, and reported on `api.report.diagnostic`). `summarize` — the DEFAULT
   since the 2026-11-10 context-compaction ruling — makes the conversation compact ITSELF:
   the thread is parked at the turn boundary, the plugin commits one instruction into the
   canonical transcript, this same agent's next model turn answers it with a summary of what
   is done, what it is working on and where it left off, everything before that instruction
   (plus any turn a disobedient model spent on tools in between) stops being sent, and the
   thread is un-parked and continued with a nudge. Neither mode deletes anything, and neither
   spawns a helper model: the compaction rides the conversation's own turn, which is why it
   costs one model turn and no new machinery (`src/plugins/context-compaction.plugin.ts`).
   What is still open is the THIRD writer and the storage question behind it: T5.3 (eliding
   superseded LARGE results into a one-line handle) waits on whether an annotated result
   keeps its original text or only a handle
   (`docs/tasks/2026-11-09-progressive-compaction.md`, Open decisions 2). A withheld result
   stays re-fetchable by RE-RUNNING it — an over-cap result arrives as a head/tail envelope
   whose `note` names the call (T5.1) — rather than by re-reading a stored copy, because the
   full text lives only in canonical history, not anywhere addressable.
3. **per-agent tool scoping** — searchable tools are catalogued once; every agent
   can discover every searchable tool, and NOTHING keys a tool to one agent by a flag
   any more. `delegate` used to carry a `primaryOnly` marker on its descriptor; the rank
   model replaced that declaration with two DERIVED facts — the tool registers at all only
   when the rank map spans two or more distinct letters (`ranksDeclareDelegation`,
   `src/server/harnesses/toolbox.ts:289-290`), and its DECLARATION is projected PER CALLER,
   so only an agent that actually holds a strictly-lower-ranked target is shown it
   (`rankProjectedDefinitions`, `src/harness.ts:4031` and `:16591`). What DOES exist beyond
   that is narrower than per-agent configuration: a per-RUN allowlist (the delegation
   `scope.tools`, `src/types/index.ts:1368`, carried into `ctx.run`'s `options.tools`,
   `:3026`, and read back by a tool as `ToolContext.toolScope`, `:1433`) and one host-WIDE
   switch (`toolSettings`, `:4970`). Nothing keys a tool set to an agent PROFILE.
   "Host-wide" now applies to the TOOL switch only: plugin settings became
   per-session (R4), so the two `harness()` config fields describe different scopes
   (`pluginSettings`, `src/types/index.ts:4955`; `toolSettings`, `:4970`).
4. **sandboxed presets and created tools** — the file and command tools, and any
   `toolCreate` body, run with host permissions; a `root`-scoped/fenced variant
   would be the natural next step.
5. **more presets** — the multi-edit gap is CLOSED, so this item is no longer a
   "patch/multi-edit" gap: `edit` already replaces text in one or more existing files
   in a single call — one `edits` array of `{ path, oldString, newString, replaceAll? }`
   entries (`src/tools/files/edit.tool.ts:1-8,124-136`). What is genuinely still
   missing is a DIFF-shaped tool: nothing applies a unified diff, there is no `patch`
   entry in the catalogue, and `gitDiff` only reads a diff back. The
   former `fetchUrl` idea is built: `fetch` (text) and `download` (bytes) cover
   the read-a-URL surface.
6. **slash-command UX in the browser UI** — the composer's mention popup triggers on
   `@` (files) and `#` (result blocks) only, so a `/` line has no completion surface
   and no command palette: an operator types a command blind and reads the answer off
   the resulting tool card, with `/help` as the discovery path. The registry itself is
   already readable (`harness.commands`), so this is presentation work.
7. **command progress** — related to item 1: a command runs to completion before the
   `202` leaves, so a long host command cannot stream intermediate output or be
   cancelled as a command (it emits no progress events by design, and a command turn is
   not a per-thread lane — in worker mode its body still runs on the session's operator
   lane, but there is no command-specific cancel or stream). A built-in that calls a
   tool inherits the tool's own limits.
8. **no page surface for the two TEMPLATE settings scopes** — the Tools and Plugins panes are
   scoped to the conversation on screen, so they hide entirely when nothing is bound
   (`src/frontend/main.ts` `paintControls`, the `*.hidden = !bound` trio) and no pane calls the global pairs any more
   (`src/frontend/main.ts:240-262`, `:273-282`). What is therefore API-only today is the
   store a NEW session inherits — `GET/PATCH /v1/harness/plugins[/:plugin_id]` — and the
   per-name deployment deny list — `PATCH /v1/harness/tools/:id`. This is presentation work
   only: both routes are live, paged, durable and tested. Harness TEMPLATES themselves are not
   on this list — the page already edits `entry`, `ranks`, `agent_models` and
   `agent_instructions` (and the roster itself, since `agents` REPLACES it on this route)
   through `PATCH /v1/harness/harnesses/:name`
   (`src/frontend/main.ts:8861` `patchAgents`, which restates `ranks` in MEMBER ORDER and
   only for surviving members, so a key for a removed agent can never be a 400) — but the
   third scope this pass introduced (a session's own
   configuration) has no harness-level twin to fall back on, which is exactly why the panes
   hide instead of falling back.
9. **no surviving record of what a killed child DID — now only for a BRANCH run.** The
   premise this item was written on (a cancelled or failed run splices its own turns out of
   the transcript, `runAgentCore`'s catch to `commitIndex`) was RETIRED for conversation runs
   by IT19 R1 (2026-11-15, issue 0036): a cut run keeps its committed turns, and a lone
   `tool_calls` block is closed by the repair helper's interrupted result
   (`src/core/transcript-repair.ts:79`) — the same pairing rule that made the splice look
   necessary is now satisfied by the placeholder instead of by deletion. What is still open is
   the two-thirds the item actually cared about: (a) a forked BRANCH run still splices to its
   fork baseline, because it owns no thread state, so a cancelled branch's activity is still
   unrecoverable except through `partialContent`/`agentResult`; and (b) the RESULT ROW for a
   cut run is still TEXT only — `partialContent` never carries a tool call or a tool result
   (issue 0020's leak boundary), so a post-mortem that reads only the agent-result ledger
   still sees what a stopped child was SAYING and not what it DID. `threadRead` is the door
   that answers with the retained work. The bounded, SEPARATE forensic field under discussion
   in issue 0032 is therefore now a ledger-side concern, not a transcript-side one.
10. **the knowledge base's surface beyond the tool** — the cross-session store is engine +
    files + one model-facing door today ([Cross-session knowledge](#cross-session-knowledge)),
    and five things are deliberately NOT built: (a) **no HTTP route, no panel, no swagger
    surface** — `src/harness.ts:4024-4030` refuses a snapshot field and the server adds no
    endpoint, so the base is reachable only through the `knowledge` tool, the host handle
    (`harness.knowledge`, `HarnessServer.knowledge`) and the files themselves, and the store's
    own `report` sink and `diagnostics()` have no consumer beyond the tests;
    (b) **no durable knowledge inside a lane WORKER** — a `threadExecution: 'worker'` replica is
    built by `harness()` with no `knowledge` configuration (nothing under `src/server/workers/`
    touches the store, because a live object cannot cross `worker_threads`), so an article an
    agent writes from a CPU-isolated lane lives in that worker and neither persists nor reaches
    the host's other sessions; the seam is a per-replica object today, not a framed resource;
    (c) **no version migration** — an article file whose `version` is not
    `HARNESS_KNOWLEDGE_VERSION` is a hard, named failure BY DESIGN (no shape guessing), so the
    day the on-disk shape changes incompatibly, the work is an operator-facing migration step,
    not a loader that tries both shapes; (d) **no attribution** — an article records WHEN it
    changed and never WHO or WHICH thread did, and `KnowledgeEngine.execute(operation, context)`
    already carries the `ToolContext` unexamined for exactly that revision
    (`src/tools/runtime/knowledge.tool.ts:1062-1066`); (e) **no link graph** — `refs` are
    validated on write and reported through `danglingRefs`, but nothing answers "what links
    here", and there is no backlink projection, no cascade and no rename propagation; and (f) **no
    alarm when the durable base stops being durable** — a write failure inside a BACKGROUND commit
    (the trailing-timer pass, `src/server/knowledge-file-store.ts:1554-1572`, or the pass a
    notification arms, `:1669-1707`) is a report nobody is holding: those calls are
    `void commit().catch(() => undefined)`, the `report` sink (`KnowledgeStoreOptions.report`,
    `:475`) has no consumer in the shipped server, and `diagnostics()` only knows what a forced pass
    has looked at. So a full disk, a read-only mount or a permission error leaves the base still
    SERVING reads — from memory, and from whatever files are still there — while the newest edits
    quietly stop landing, and neither the model nor the operator is told: the durable base can
    silently stop being durable. A host that wants the fact wires `report` (one
    `{ kind: 'failure', directory, file, message, id? }` event per failing file, its message naming
    the path) or polls `diagnostics()`; `src/server/start.ts:411-430` prints the SHUTDOWN flush's
    failure and nothing else does. An explicit `commit()`/`flush()` does answer `report.failure`, and
    a disposed store refuses outright (see [Cross-session knowledge](#cross-session-knowledge)) — the
    gap is the un-awaited path, and closing it is a tool-result-shape decision, not a file-layer one.

Parallel tool execution is no longer on this list: calls are scheduled
concurrently (see “The loop”). There is no ordered side-effect guarantee, and the
library itself still has no thread/CPU isolation; a server deployment can now move
each conversation onto its own worker thread (`threadExecution: 'worker'`, see
[Lane workers](#lane-workers-threadexecution-worker)), which is documented there
with the boundaries that stay refused. The same deployment can also move the
checkpoint's shard commits and the per-event journal off the request loop
(`ioExecution: 'worker'`, see [IO workers](#io-workers-ioexecution-worker)); the
library-level statements above are about the library, and neither flag changes them.

