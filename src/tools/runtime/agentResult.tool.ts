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
//   - CANCELLED / FAILED -> the error plus paged `partialContent` and
//     `cancelledAtMessage` (that is the surviving account of a rolled-back run).
//     B3 (2026-11-13) made the prose literal: `content` carries one page of the
//     partial and `partialContent` now exists as its own field holding the WHOLE
//     text, mirroring the unfinished-run envelope `delegate` has always returned
//     (src/harness.ts `agentResultFor` / `delegateFor`) and matching the sentence
//     `threadFork` gives a caller when a branch dies.
// The two pinned fragments below — "latest completed result" (the parameter
// description, pinned by src/harness.agent-results.test.ts:169) and "at most 8000
// characters (default 4000)" (pinned by core/metadata.ownership.test.ts:424) — are
// kept verbatim, and every PARAMETER description stays byte-identical.
export const AGENT_RESULT_METADATA: CoreToolMetadata = {
    name: AGENT_RESULT_NAME,
    description:
        `Read the completed result of one agent invocation. Pass "agent"; optionally pass "invocationId" from agentManage (omit it for that agent's latest FINISHED result - the newest COMPLETED one, or the newest failed or cancelled one when nothing has completed, and an explicitly addressed id always answers whatever that run did). Only an agent with NOTHING finished at all - no completed, failed or cancelled run - gets status "empty" with empty content; that is never somebody else's run and never one that is still in flight. The result contains content, contentLength, offset, limit, hasMore, and nextOffset when more remains; page through by passing nextOffset back as offset. Each page is at most 8000 characters (default 4000), so a long answer is returned in full across pages instead of being silently truncated. What each status means: "empty" - nothing has finished for that agent at all, so there is no answer to read yet; "running" - an invocation you addressed by id is still running, and it reports empty content because a partial answer is never presented as a finished one; "cancelled" or "failed" - the run did not complete, and it reports its error together with the partialContent it had produced and the cancelledAtMessage showing how far it got, paged exactly like a completed answer (content is ONE page of that partial, partialContent is the whole text in one field, so a short unfinished answer needs no second call); an unknown invocationId, or one that belongs to another agent, is an error. Only answer text is exposed - a finished answer in content, an unfinished one in partialContent - never system instructions, transcripts, tool arguments, or tool bodies.`,
    tags: ['agents', 'result', 'answer', 'output', 'subagent', 'inspect'],
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
