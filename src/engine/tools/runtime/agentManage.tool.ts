// agentManage — standalone source entry; the bounded invocation registry is
// harness-owned state, exposed through the live runtime operation.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

// Agent inspection (R3). agentManage lists every configured agent plus truncated
// result previews; agentResult reads one completed result in pages. Both are
// ALWAYS-registered core tools: EVERY rank gets the same view of the session's other
// agents — the Rank A entry agent and the lowest-ranked worker see the identical
// roster — so a delegated worker can inspect what its siblings already produced. This
// door is not rank-gated, and the word "rank" below is the engine's own vocabulary
// (`AgentRank = 'A'..'Z'`, src/types/index.ts), not the retired role pair.
export const AGENT_MANAGE_NAME = 'agentManage';

// Listing. No arguments: the session already defines the agent set, so a
// parameter would only invite the model to filter it.
//
// The numbers below (5 recent invocations, 200-character previews) mirror
// AGENT_MANAGE_LIST_PER_AGENT / AGENT_MANAGE_PREVIEW_CHARS in core/agent-limits.ts.
// They are literals because a runtime entry must keep zero captured local
// dependencies and must not value-import ../core (that closes a cycle through
// core/metadata.ts); core/metadata.ownership.test.ts pins the equality.
//
// RANK WORDING (2026-11-18, the rank-model pass). The listing projects `rank: rankOf(brain)`
// (src/harness.ts:4903), so the description names RANK: the sentence it used to carry,
// "role (primary/subagent)", described a field the engine stopped emitting. The `subagent` TAG
// moved the same way, and that is not cosmetic — this entry is `visibility: 'searchable'`, so
// its tags ARE the vocabulary a no-match `toolRequest` reports in `availableTags`. The pinned
// vocabulary lists in src/harness.already-available.test.ts and src/harness.discovery.test.ts
// therefore drop `subagent` and gain `rank`, and src/harness.agent-results.test.ts pins the
// tag array itself.
//
// AND KEEP THE SUBSTRING `delegate` OUT OF THIS DESCRIPTION: the entry is `searchable`, and
// core/discovery.ts scores a 1-point match when a >=3-char query needle is a substring of the
// DESCRIPTION. Writing "…may delegate to…" here made `toolRequest(["agents","delegate",
// "delegation"])` report `delegate` as MATCHED, which drops the `unmatchedTags: ['delegate']`
// half of the pins in src/harness.already-available.test.ts. The rank phrase is therefore
// worded as "which agents it may hand work to". (Same class of trap as the `time` rule
// documented in ./agentResult.tool.ts.)
//
// DEFECT M1 (2026-11-17) — the running-row AGE clause. A preview of a run that is still in
// flight used to say only `status: "running"`, with no fact about how long it had said that.
// `agentManage` is the liveness surface of this ledger, so the pair lives here: `invocationPreviewOf`
// (src/harness.ts) now projects `startedAt` (epoch ms, stamped by `registerInvocation`) and
// `ageMs` (elapsed at read time) on RUNNING rows only. Failed/cancelled rows in the same list
// keep their exact pre-M1 keys, because those rows are terminal and already have `durationMs`
// on the full envelope. The wording avoids the substring `time` for the same discovery-scoring
// reason src/tools/runtime/agentResult.tool.ts documents (this entry is `searchable` too).
//
// DEFECT F1-1 (2026-11-25) — the three global counters are now stated as what they are.
// `truncated` was described as "some agent has more retained invocations than the 5 shown
// here" while the engine computed it from a GLOBAL row count (`records.length > listed`,
// `agentManageView`, src/engine/harness.ts:5111), so it also fired when every agent was at or
// below its cap and rows were hidden for another reason (a released conversation — the case
// src/engine/harness.thread-runtime.test.ts reported). The engine now computes the per-agent
// fact the sentence described, and the global fact it used to carry is its own field,
// `hiddenResults`. The prose fixes all three relations, because the page is the only place a
// caller learns them (`agentManageView` at src/engine/harness.ts:5111, and the retired-row test
// `recordIsInactiveOwned` at :4961):
//   - `totalResults` and `activeResults` count the WHOLE retained ring (`AGENT_RESULT_RETENTION`,
//     src/engine/core/agent-limits.ts:25): every listed agent's `invocationCount` PLUS the rows
//     retired with a transcript that was dropped, which belong to no listed agent. So
//     `totalResults` EQUALS the sum of the `invocationCount`s while nothing is retired and is
//     strictly greater once something is — "never a sum" was the wrong correction, because that
//     sum is exactly its floor.
//   - overflow past the 5-row preview cap is INSIDE each agent's `invocationCount` (the count is
//     the ring count, the list is the preview), so it never widens `totalResults`; it is what a
//     per-agent `truncated: true` reports.
//   - `hiddenResults` is `totalResults` minus the rows this listing shows, which is why it
//     covers BOTH causes of an unlisted row — cap overflow and rows retired with a released
//     conversation.
// Still no substring `time` anywhere in the description.
export const AGENT_MANAGE_METADATA: CoreToolMetadata = {
    name: AGENT_MANAGE_NAME,
    description:
        'List every configured agent in this harness session with previews of recent results. Each entry carries the agent\'s name, rank (one letter of the A-Z authority scale, A highest, and the fact that says which agents it may hand work to), model, invocationCount, and up to 5 recent invocations - roots, delegations, and forks - newest first. A result preview is at most 200 characters, flags whether it was truncated, and reports the full contentLength; a running invocation has status "running" and no content, and it also reports startedAt (when that run began, as epoch milliseconds) and ageMs (how old it is right now, in milliseconds). Use agentResult with the agent name and optional invocationId to read a full completed result. Only completed answer text is ever exposed here: never system instructions, transcript messages, tool arguments, or tool bodies. The listing also reports `totalResults` (every invocation record this harness still retains, across all agents) and `activeResults` (how many of those are still running); BOTH are ring-wide counts rather than per-agent ones, and the arithmetic is exact: `totalResults` equals the sum of the per-agent `invocationCount`s PLUS every retained row that belongs to a transcript which has been dropped - a retired run stays in the ring, listed by no agent, while it stays readable by id. With nothing dropped, `totalResults` IS that sum; it grows past it only when transcripts are dropped. A top-level `truncated: true` is a DIFFERENT fact from a preview\'s own truncated flag, and it is PER-AGENT: at least one listed agent has more retained invocations than the 5 shown under it, which is why `invocationCount` can exceed `results.length`. `hiddenResults` is the ring-wide half of that, kept apart so the two are readable separately: how many retained rows appear in NO agent\'s list at all, exactly `totalResults` minus the rows this listing shows - the overflow past the 5-row cap, plus the rows retired with the transcript that carried them. A top-level `truncated: false` with `hiddenResults` above 0 is therefore normal, and it is not a claim that nothing is missing: it says no agent overflowed its own list. This tool takes no arguments and has no cursor, so paging is not an option - the remedy is agentResult with an exact invocationId, and an id that was not listed is still in the envelope that created the run: a delegation reports its `invocationId`, a fork reports the branch id that doubles as one, and `agentResult` echoes the id it read.',
    tags: ['agents', 'results', 'preview', 'rank', 'team', 'inspect'],
    // R9-R11 demand discovery: searchable, so the model finds it through toolRequest
    // and enables it for this session instead of seeing it declared on every request.
    // Registration itself is unchanged (the entry still joins the harness registry),
    // so toolRequest always has something to surface.
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    }
};

export const metadata = AGENT_MANAGE_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 100,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('agentManage requires the live harness reference.');
    }

    return context.harness.runtime.agentManage();
};
