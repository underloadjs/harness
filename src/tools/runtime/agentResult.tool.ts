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
export const AGENT_RESULT_METADATA: CoreToolMetadata = {
    name: AGENT_RESULT_NAME,
    description:
        `Read the completed result of one agent invocation. Pass "agent"; optionally pass "invocationId" from agentManage (omit it for that agent's latest completed result). The result contains content, contentLength, offset, limit, hasMore, and nextOffset when more remains; page through by passing nextOffset back as offset. Each page is at most 8000 characters (default 4000), so a long answer is returned in full across pages instead of being silently truncated. A running invocation returns status "running" with no content, a failed or cancelled invocation reports its error and no content, an unknown invocation is an error, and an agent that has not run yet returns status "empty". Only completed answer text is exposed - never system instructions, transcripts, tool arguments, or tool bodies.`,
    tags: ['agents', 'result', 'answer', 'output', 'subagent', 'inspect'],
    visibility: 'core',
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
    alwaysDeclared: true,
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
