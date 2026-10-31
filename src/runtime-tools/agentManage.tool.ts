// agentManage — standalone source entry; the bounded invocation registry is
// harness-owned state, exposed through the live runtime operation.
import type { CoreToolMetadata } from '../core';
import type { ToolContext } from '../types';

// Agent inspection (R3). agentManage lists every configured agent plus truncated
// result previews; agentResult reads one completed result in pages. Both are
// ALWAYS-registered core tools: a subagent has the same view of the session's
// other agents as the primary, so a delegated worker can inspect what its
// siblings already produced.
export const AGENT_MANAGE_NAME = 'agentManage';

// Listing. No arguments: the session already defines the agent set, so a
// parameter would only invite the model to filter it.
//
// The numbers below (5 recent invocations, 200-character previews) mirror
// AGENT_MANAGE_LIST_PER_AGENT / AGENT_MANAGE_PREVIEW_CHARS in core/agent-limits.ts.
// They are literals because a runtime entry must keep zero captured local
// dependencies and must not value-import ../core (that closes a cycle through
// core/metadata.ts); core/metadata.ownership.test.ts pins the equality.
export const AGENT_MANAGE_METADATA: CoreToolMetadata = {
    name: AGENT_MANAGE_NAME,
    description:
        'List every configured agent in this harness session with previews of recent results. Each entry carries the agent\'s name, role (primary/subagent), model, invocationCount, and up to 5 recent invocations - roots, delegations, and forks - newest first. A result preview is at most 200 characters, flags whether it was truncated, and reports the full contentLength; a running invocation has status "running" and no content. Use agentResult with the agent name and optional invocationId to read a full completed result. Only completed answer text is ever exposed here: never system instructions, transcript messages, tool arguments, or tool bodies.',
    tags: ['agents', 'results', 'preview', 'subagent', 'team', 'inspect'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    }
};

export const metadata = AGENT_MANAGE_METADATA;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('agentManage requires the live harness reference.');
    }

    return context.harness.runtime.agentManage();
};
