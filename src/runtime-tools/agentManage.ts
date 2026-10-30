// agentManage — standalone source entry; the bounded invocation registry is
// harness-owned state, exposed through the live runtime operation.
import { AGENT_MANAGE_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = AGENT_MANAGE_METADATA;

export const execute = (context: ToolContext) => {
    if (context.harness === undefined) {
        throw new Error('agentManage requires the live harness reference.');
    }

    return context.harness.runtime.agentManage();
};
