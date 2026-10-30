// toolRequest — standalone source entry for catalogue discovery.
//
// The harness owns the discovery cursor/enabled set; this entry owns the tool
// contract and delegates to that live operation. Starting the harness compiles
// THIS file through the same kernel as any replacement, so editing/inspecting the
// entry is meaningful in production.
import { TOOL_REQUEST_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = TOOL_REQUEST_METADATA;

export const execute = (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error('toolRequest requires the live harness reference.');
    }

    return harness.runtime.requestTools(context.agent, context.parameters);
};
