// agentDelegate — standalone source entry for one-level bounded delegation.
//
// The allowlist schema is per-harness, so the kernel registration supplies the
// exact description/schema while this entry owns the execution contract. The
// runtime operation enforces caller role/depth and invokes the invocation-bound
// `context.run`, never a captured child implementation.
import type { CoreToolMetadata } from '../core';
import type { ToolContext } from '../types';

export const AGENT_DELEGATE_NAME = 'agentDelegate';

// Delegation (R4). Capability-by-configuration: the harness registers agentDelegate
// only when the allowlist is non-empty, so this metadata has two honest forms:
//   - with subagents - the runtime declaration, whose `agent` enum is the exact
//     allowlist and whose description names it;
//   - without - a catalogue-only description (the server lists the capability and
//     a session without subagents answers a clear 404 when it is called).
export const agentDelegateMetadata = (subagents: readonly string[] = []): CoreToolMetadata => {
    const listed = [...subagents];

    return {
        name: AGENT_DELEGATE_NAME,
        description:
            listed.length > 0
                ? `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.`
                : 'Delegate a self-contained task to a configured subagent and return its answer. Only the primary agent can delegate, subagents cannot delegate further, and a harness registers this tool only when it has subagents - a session whose harness has none answers 404.',
        tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                agent:
                    listed.length > 0
                        ? {
                              type: 'string',
                              enum: listed,
                              description: 'Subagent name, one of the configured allowlist.'
                          }
                        : {
                              type: 'string',
                              description: 'Subagent name, one of the session harness allowlist.'
                          },
                input: { type: 'string', description: 'The full brief the subagent should act on.' }
            },
            required: ['agent', 'input'],
            additionalProperties: false
        }
    };
};

export const metadata = agentDelegateMetadata([]);

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('agentDelegate requires the live harness reference.');
    }

    return context.harness.runtime.delegate(
        context.agent,
        (context.parameters ?? {}) as { agent?: string; input?: string },
        context.run,
        context.runDepth
    );
};
