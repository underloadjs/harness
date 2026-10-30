// agentDelegate — standalone source entry for one-level bounded delegation.
//
// The allowlist schema is per-harness, so the kernel registration supplies the
// exact description/schema while this entry owns the execution contract. The
// runtime operation enforces caller role/depth and invokes the invocation-bound
// `context.run`, never a captured child implementation.
import { agentDelegateMetadata } from '../core/metadata';
import type { ToolContext } from '../types';

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
