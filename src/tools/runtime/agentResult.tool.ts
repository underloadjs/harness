// agentResult — standalone source entry for paged completed-answer retrieval.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const AGENT_RESULT_NAME = 'agentResult';

// Full retrieval. `agent` is required; omitting `invocationId` selects that
// agent's latest completed result. `offset`/`limit` page a long answer without
// relying on the harness's 64 KiB result cap.
//
// The page bounds below (4000 default, 8000 maximum) mirror
// AGENT_RESULT_PAGE_CHARS / AGENT_RESULT_PAGE_MAX_CHARS in core/agent-limits.ts.
// They are literals because a runtime entry must keep zero captured local
// dependencies and must not value-import ../core (that closes a cycle through
// core/metadata.ts); core/metadata.ownership.test.ts pins the equality.
//
// STATUS PROSE (2026-11-13). The description used to claim "a failed or cancelled
// invocation reports its error and no content", which stopped being true when T28
// added `partialContent`, and it described only "an agent that has not run yet" as
// the empty case. Both halves are restated to match what `agentResultFor` actually
// answers (src/harness.ts ~3798-3930), so every promise here is literally true:
//   - NO COMPLETED result for that agent -> status "empty" with empty content. The
//     omitted-`invocationId` selector picks the latest COMPLETED record, so an
//     in-flight or failed-only agent must not answer with that record's identity.
//   - an explicitly addressed RUNNING invocation -> status "running" with empty
//     content: no partial text is ever passed off as a finished answer.
//   - CANCELLED / FAILED -> the error plus paged `partialContent` and
//     `cancelledAtMessage` (that is the surviving account of a rolled-back run).
// The two pinned fragments below — "latest completed result" (the parameter
// description, pinned by src/harness.agent-results.test.ts:169) and "at most 8000
// characters (default 4000)" (pinned by core/metadata.ownership.test.ts:424) — are
// kept verbatim, and every PARAMETER description stays byte-identical.
export const AGENT_RESULT_METADATA: CoreToolMetadata = {
    name: AGENT_RESULT_NAME,
    description:
        `Read the completed result of one agent invocation. Pass "agent"; optionally pass "invocationId" from agentManage (omit it for that agent's latest completed result - when that agent has no completed result the answer is status "empty" with empty content, not somebody else's run and not one that is still in flight). The result contains content, contentLength, offset, limit, hasMore, and nextOffset when more remains; page through by passing nextOffset back as offset. Each page is at most 8000 characters (default 4000), so a long answer is returned in full across pages instead of being silently truncated. What each status means: "empty" - no completed result is available for that agent, so nothing of yours has finished yet; "running" - an invocation you addressed by id is still running, and it reports empty content because a partial answer is never presented as a finished one; "cancelled" or "failed" - the run did not complete, and it reports its error together with the partialContent it had produced and the cancelledAtMessage showing how far it got, paged exactly like a completed answer; an unknown invocationId, or one that belongs to another agent, is an error. Only answer text is exposed - a finished answer in content, an unfinished one in partialContent - never system instructions, transcripts, tool arguments, or tool bodies.`,
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
