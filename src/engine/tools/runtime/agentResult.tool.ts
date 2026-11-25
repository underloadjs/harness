// agentResult — standalone source entry for paged completed-answer retrieval.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const AGENT_RESULT_NAME = 'agentResult';

// Full retrieval. `agent` is required; omitting `invocationId` selects that
// agent's latest FINISHED result (newest completed, else newest failed/cancelled —
// see the STATUS PROSE block). `offset`/`limit` page a long answer without relying
// on the harness's serialized tool-result bound (`MODEL_TOOL_RESULT_BUDGET_BYTES`,
// 256 KiB in core/result-budget.ts — the 64 KiB figure this comment used to quote is
// the value that constant held before the read budget was raised).
//
// The page bounds below (4000 default, 8000 maximum) mirror
// AGENT_RESULT_PAGE_CHARS / AGENT_RESULT_PAGE_MAX_CHARS in core/agent-limits.ts.
// They are literals because a runtime entry must keep zero captured local
// dependencies and must not value-import ../core (that closes a cycle through
// core/metadata.ts); core/metadata.ownership.test.ts pins the equality.
//
// STATUS PROSE (2026-11-13, corrected in the same review wave that fixed the selector).
// The description used to claim "a failed or cancelled invocation reports its error and
// no content", which stopped being true when T28 added `partialContent`, and it described
// only "an agent that has not run yet" as the empty case. Both halves were restated to
// match what `agentResultFor` actually answers (src/harness.ts ~3798-3930), so every
// promise here is literally true:
//   - THE OMITTED-`invocationId` SELECTOR picks the newest TERMINAL record: the newest
//     COMPLETED one, else the newest failed/cancelled one (src/harness.ts ~3935-3939).
//     The sentence this entry used to carry — "when that agent has no completed result
//     the answer is status empty" — contradicted that fallback outright: an agent whose
//     only finished runs failed got `status: 'empty'` in prose and a failed record in
//     fact. The prose now names the fallback, and reserves "empty" for an agent with
//     NOTHING finished (never ran, or every invocation still in flight).
//   - an explicitly addressed RUNNING invocation -> status "running" with empty
//     content: no partial text is ever passed off as a finished answer.
//     DEFECT M1 (2026-11-17) extended that clause with the row's AGE, because a `running`
//     row used to carry no time fact at all: `delegate` is unbounded by default
//     (`DELEGATE_TIMEOUT_MS === +Infinity`, core/agent-limits.ts) and retention never evicts
//     a running row, so a stalled child looked exactly like a freshly started one. The two
//     keys now projected on the running branch of `agentResultFor` (src/harness.ts,
//     `agentResultFor` -> `startedAt`/`ageMs`) come from the start stamp `registerInvocation`
//     writes and from the same record `agentManage` reads, so the two doors can never name
//     different ages for one run. Scope is deliberately narrow: `status` and every terminal
//     transition are untouched, and NO completed / failed / cancelled / `empty` envelope
//     gained a key. The new wording says "when that run began" and "how old it is" instead of
//     any phrase containing the substring `time`, for the discovery-scoring reason stated at
//     the end of this block.
//   - CANCELLED / FAILED -> the error plus paged `partialContent` and
//     `cancelledAtMessage`. The wording here used to call that pair "the surviving account of a
//     rolled-back run", which stopped being true on 2026-11-15: a thread-bound run that ends
//     without concluding KEEPS its turns (`runAgentCore`'s retention boundary in
//     `../../harness.ts`, repaired by `core/transcript-repair.ts`), so the transcript is a second
//     account and `threadRead` is the door that reads it. Only a BRANCH run still rolls back, and
//     the description now names that exception instead of implying a rollback everywhere. What did
//     NOT move is this door's own contract: `agentResult` answers with answer TEXT and nothing
//     else — never a call, never a tool body (0020's leak boundary).
//     B3 (2026-11-13) made the prose literal: `content` carries one page of the
//     partial and `partialContent` now exists as its own field holding the WHOLE
//     text, mirroring the unfinished-run envelope `delegate` has always returned
//     (src/harness.ts `agentResultFor` / `delegateFor`) and matching the sentence
//     `threadFork` gives a caller when a branch dies.
//   - That partial is DURABLE (issue 0033, 2026-11-14). `partialContent` and
//     `cancelledAtMessage` are fields of the PERSISTED `agentResults` record
//     (`src/types/index.ts` `HarnessAgentResultSnapshot`, validated and read back by
//     `readAgentResults` in `src/core/snapshot.ts`), not only of the live envelope. A
//     save/restart/reload therefore answers the same `invocationId` with the same partial
//     and the same position. Before this, the pair was runtime-only: the snapshot
//     projection wrote `content`, which is EMPTY for a non-completed run, so the durable
//     ledger took back an answer this door had already shown the caller. Nothing about the
//     shape the model reads changed — only whether it survives a boot — so the pinned
//     fragments below are untouched.
// IT19 R4 (2026-11-15): the description now NAMES `stopReason` — the machine-readable cause
//     this door has been returning since the retention fix. `agentResultFor` projects
//     `record.stopReason` on a `failed`/`cancelled` envelope (src/harness.ts ~4448-4452), the
//     same field `harness.thread(id)` (~13880) and `snapshot().agentResults[]` (~14279) already
//     carried. Prose only — the envelope shape is untouched, and the clause sits in the
//     "cancelled or failed" status run, AFTER the `(durationMs ...)` aside, which keeps the
//     pinned `at most 8000 characters (default 4000)` fragment below byte-identical.
//     WHY THE NINE VALUES ARE NOT LISTED HERE (verified while gating, not guessed): this entry
//     is `visibility: 'searchable'`, and `core/discovery.ts:135-137` scores a hit worth 1 when a
//     query needle is a >=3-char substring of the DESCRIPTION. The closed `HarnessRunStopReason`
//     union (src/types/index.ts ~2911) contains `timeout`, whose first four letters are the tag
//     `time` — so an enumerated clause newly ranked `agentResult` for `toolRequest(["time"])` and
//     appended it to the `enabled` array that src/server/api.test.ts:2722 pins VERBATIM (the
//     scripted discovery round). The values stay documented in `src/types/index.ts` and in the
//     `threadList` row, which cannot cause that drift because it is `visibility: 'core'`
//     (src/tools/runtime/threadList.tool.ts:39) and `core/discovery.ts:264` admits only
//     `searchable` tools to the match set (`listed: false` is a separate LISTING flag and does
//     not exclude a tool from search). Any future edit to THIS description must keep the
//     substring `time` out, or that recorded-event pin has to move with it.
// The two pinned fragments below — "latest completed result" (the parameter
// description, pinned by src/harness.agent-results.test.ts:169) and "at most 8000
// characters (default 4000)" (pinned by core/metadata.ownership.test.ts:424) — are
// kept verbatim, and every PARAMETER description stays byte-identical.
// RANK WORDING (2026-11-18, the rank-model pass): the retired `subagent` TAG is replaced by
// `rank`, matching the delegate entry's tag set. Only the tag moves — every pinned description
// fragment above stays byte-identical. The consequence is documented once, in
// ./agentManage.tool.ts: this entry is `visibility: 'searchable'`, so its tags ARE the
// vocabulary a no-match `toolRequest` answers with in `availableTags`, and the pinned
// vocabulary lists (src/harness.already-available.test.ts, src/harness.discovery.test.ts) and
// the tag pin (src/harness.agent-results.test.ts) moved with it.
// DEFECT F1-5 (2026-11-25) — DOC ONLY; the report's HIGH claim was not a defect. Its thesis
// was that `agentResult` "misses a run that has already finished". It cannot: the ledger row is
// finalized BEFORE `delegate` resolves (the terminal commit runs in `runAgent`, and the tool
// result is the delegation's own answer), so a read that follows `delegate` sees the finished
// status — pinned in src/harness.agent-results.test.ts. What a caller actually trips on is the
// BATCH: tool calls in one assistant step run concurrently, so a step that emits `delegate` and
// `agentResult` for the same id takes the read at a moment when that run has, correctly, not
// finished — the answer is `running`, and the same step's `delegate` then reports the finished
// run. The description now says which instant `running` describes and what to do about it.
// Nothing else moved: no new status (`finalizing` was weighed and rejected — it is a read
// ordering fact, not a run state), no `settled` flag, no envelope change, and the `time`
// substring stays out of this description for the reason documented above.
// ONE MECHANICAL TRAP this entry carries and ./agentManage.tool.ts does not: its `description`
// is a NO-SUBSTITUTION TEMPLATE LITERAL, and `./core/tool-scan.ts:208` reads the metadata as an
// AST literal — a template EXPRESSION (any `${…}`) is refused at registration, and an unescaped
// backtick inside the text ends the literal early. So prose in this description quotes with
// double quotes and never embeds a backtick.
// A SECOND TRAP, and it is a ranking trap: this tool is `visibility: 'searchable'`, and
// `./core/discovery.ts:138` scores a query needle against the DESCRIPTION as well as the name and
// tags. The bare word `delegate` is another tool's wire name, so writing it here makes this row
// answer a "delegate" query. `./core/discovery.ts:300` then sorts by best score and SECOND by the
// NUMBER of needles matched, so picking up one extra needle is enough to reorder the shortlist.
// src/engine/harness.already-available.test.ts pins both shapes — a `{"tags":["delegate"]}` query
// must enable NOTHING and only REPORT the declared `delegate` tool, and
// `["agents","delegate","delegation"]` must keep `agentManage` ahead of `agentResult` — so this
// description says "the blocking delegation call" and "once that delegation returns". "delegation"
// does not contain "delegate", and `agentManage` ranks first on name once both rows tie.
export const AGENT_RESULT_METADATA: CoreToolMetadata = {
    name: AGENT_RESULT_NAME,
    description:
        `Read the completed result of one agent invocation. Pass "agent"; optionally pass "invocationId" from agentManage (omit it for that agent's latest FINISHED result - the newest COMPLETED one, or the newest failed or cancelled one when nothing has completed, and an explicitly addressed id always answers whatever that run did - with one honest limit: an invocation NUMBER can be recycled when the harness restarts, and after that this harness's row of that number is what answers, because it is the run that owns the id now). Only an agent with NOTHING finished at all - no completed, failed or cancelled run - gets status "empty" with empty content; that is never somebody else's run and never one that is still in flight. The result contains content, contentLength, offset, limit, hasMore, and nextOffset when more remains; page through by passing nextOffset back as offset. Each page is at most 8000 characters (default 4000), so a long answer is returned in full across pages instead of being silently truncated. A delegation's "nextOffset" is directly usable as "offset" here - the cursor is the same index into the same answer - but pass "limit" if you want the page you already had, because this tool's own default is 4000 where a delegation pages at 8000. What each status means: "empty" - nothing has finished for that agent at all, so there is no answer to read yet; "running" - an invocation you addressed by id is still running, and it reports empty content because a partial answer is never presented as a finished one, together with startedAt (when that run began, as epoch milliseconds) and ageMs (how old it is right now, in milliseconds). A "running" answer is a fact about the INSTANT this read was taken - the run had not finished at that moment - and the case that surprises a caller is your own batching: if you issue this read in the SAME step as the blocking delegation call for that same id, it answers "running", because the tool calls of one step execute concurrently and this read never blocks on the delegation it sits beside. That is not a lost or wrong answer: the ledger is written when the run ends, so read this tool again once that delegation returns and the answer is there. "cancelled" or "failed" - the run did not complete, and it reports its error together with the partialContent it had committed and the cancelledAtMessage, which counts the messages that run had committed and is NOT a measure of how far it got (durationMs is the field that scales), and stopReason, the machine-readable cause of that early end, which is the field to branch on instead of matching the error prose - it is absent only when no cause was recorded; partialContent is only the LAST assistant text that run committed, so this answer never carries the tool calls and tool results it made: a run that wrote a conversation keeps those turns in that transcript, where threadRead can read them (a fork branch is the exception - its unfinished tail is rolled back, so agentResult is the only account of a branch), and when the run was stopped before committing any assistant text both keys are ABSENT rather than empty. An unfinished answer is paged exactly like a completed one (content is ONE page of that partial, partialContent is the whole text in one field, so a short unfinished answer needs no second call); an unknown invocationId, or one that belongs to another agent, is an error. Only answer text is exposed - a finished answer in content, an unfinished one in partialContent - never system instructions, transcripts, tool arguments, or tool bodies.`,
    tags: ['agents', 'result', 'answer', 'output', 'rank', 'inspect'],
    // R9-R11 demand discovery: searchable, so the model finds it through toolRequest
    // and enables it for this session instead of seeing it declared on every request.
    // Registration itself is unchanged (the entry still joins the harness registry),
    // so toolRequest always has something to surface.
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            agent: {
                type: 'string',
                minLength: 1,
                description: 'Configured agent name whose result to read.'
            },
            invocationId: {
                type: 'string',
                minLength: 1,
                description:
                    'Invocation id from agentManage. Omit to read that agent\'s latest completed result.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    '0-based character offset into the result. Defaults to 0; use nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 8000,
                description: 'Page size in characters, 1-8000. Defaults to 4000.'
            }
        },
        required: ['agent'],
        additionalProperties: false
    }
};

export const metadata = AGENT_RESULT_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 110,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('agentResult requires the live harness reference.');
    }

    return context.harness.runtime.agentResult(
        (context.parameters ?? {}) as Record<string, any>
    );
};
