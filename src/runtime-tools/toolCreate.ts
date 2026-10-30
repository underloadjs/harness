// toolCreate — standalone source entry for guarded runtime tool creation.
//
// The kernel, lifetime budget, policy gate, and persistence bookkeeping are
// harness-owned operations. This module is the model-facing contract: parameters
// are the legacy `ToolCreation` shape and the result is the historical
// ToolCreationResult. Startup compiles it through the shared kernel.
import { TOOL_CREATE_METADATA } from '../core/metadata';
import type { ToolContext, ToolCreation } from '../types';

export const metadata = TOOL_CREATE_METADATA;

export const execute = (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error('toolCreate requires the live harness reference.');
    }

    return harness.runtime.createToolForAgent(
        context.agent,
        context.parameters as ToolCreation
    );
};
