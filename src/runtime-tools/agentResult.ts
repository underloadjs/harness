// agentResult — standalone source entry for paged completed-answer retrieval.
import { AGENT_RESULT_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = AGENT_RESULT_METADATA;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('agentResult requires the live harness reference.');
    }

    return context.harness.runtime.agentResult(
        (context.parameters ?? {}) as Record<string, any>
    );
};
