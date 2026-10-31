// agentDelegate — standalone source entry for one-level bounded delegation.
//
// The allowlist schema is per-harness, so the kernel registration supplies the
// exact description/schema while this entry owns the execution contract. The
// runtime operation enforces caller role/depth and invokes the invocation-bound
// `context.run`, never a captured child implementation.
//
// Metadata is a pure literal (T19 / R9)
// -------------------------------------
// `metadata` below is a literal object with no computation, no interpolation and
// no call. That is what lets the startup metadata reader
// (../../core/tool-scan.ts) extract it from the file's TypeScript AST without
// evaluating the module. The dynamic, allowlist-aware form lives in
// `agentDelegateMetadata(subagents)`, which the harness calls at registration time
// to override description/schema; its zero-allowlist branch is derived FROM the
// literal, so the two cannot drift (pinned by core/metadata.ownership.test.ts).
//
// The two new literals are annotated `as const` rather than with the
// ToolMetadata/ToolRegistration types: a runtime entry must keep
// `dependencies: []` (scripts/check-package-tools.mjs), and only the `core` /
// `tools/catalogue` specifiers resolve LIVE — a leaf type import would be captured
// as a local dependency. The shape is enforced at read time by
// core/tool-scan.ts.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const AGENT_DELEGATE_NAME = 'agentDelegate';

// The canonical, AST-extractable declaration. Deliberately literal (see header).
// This is the ZERO-SUBAGENT catalogue form: a host that lists the capability
// before any session exists sees this description and a free-form agent name.
export const metadata = {
    name: AGENT_DELEGATE_NAME,
    description:
        'Delegate a self-contained task to a configured subagent and return its answer. Only the primary agent can delegate, subagents cannot delegate further, and a harness registers this tool only when it has subagents - a session whose harness has none answers 404.',
    tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            agent: {
                type: 'string',
                description: 'Subagent name, one of the session harness allowlist.'
            },
            input: { type: 'string', description: 'The full brief the subagent should act on.' }
        },
        required: ['agent', 'input'],
        additionalProperties: false
    }
} as const;

// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are not part of the Tool wire contract, and the discovery reader
// only ever READS them (never executes anything) to reproduce the historical
// registration order and conditional policy.
export const registration = {
    group: 'runtime',
    activation: 'subagents',
    order: 120,
    primaryOnly: true,
    answerExtraction: true,
    sessionBound: true,
    listed: true,
    alwaysDeclared: false
} as const;

// Delegation (R4). Capability-by-configuration: the harness registers agentDelegate
// only when the allowlist is non-empty, so this metadata has two honest forms:
//   - with subagents - the runtime declaration, whose `agent` enum is the exact
//     allowlist and whose description names it;
//   - without - the catalogue-only literal above (the server lists the capability
//     and a session without subagents answers a clear 404 when it is called).
//
// A fresh object is returned every call: the harness spreads it into a Tool and a
// caller may mutate that Tool, so the module-level literal is never handed out.
export const agentDelegateMetadata = (subagents: readonly string[] = []): CoreToolMetadata => {
    const listed = [...subagents];

    if (listed.length === 0) {
        return {
            name: metadata.name,
            description: metadata.description,
            tags: [...metadata.tags],
            visibility: 'core',
            parameters: JSON.parse(JSON.stringify(metadata.parameters)) as Record<string, unknown>
        };
    }

    return {
        name: AGENT_DELEGATE_NAME,
        description: `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.`,
        tags: ['agents', 'delegate', 'delegation', 'subagent', 'team'],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    enum: listed,
                    description: 'Subagent name, one of the configured allowlist.'
                },
                input: { type: 'string', description: 'The full brief the subagent should act on.' }
            },
            required: ['agent', 'input'],
            additionalProperties: false
        }
    };
};

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
