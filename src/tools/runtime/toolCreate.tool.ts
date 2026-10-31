// toolCreate — standalone source entry for guarded runtime tool creation.
//
// The kernel, lifetime budget, policy gate, and persistence bookkeeping are
// harness-owned operations. This module is the model-facing contract: parameters
// are the legacy `ToolCreation` shape and the result is the historical
// ToolCreationResult. Startup compiles it through the shared kernel.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext, ToolCreation } from '../../types';

export const TOOL_CREATE_NAME = 'toolCreate';

// Runtime creation (R2b). The text is the security statement the model is given:
// a created tool runs with the process's permissions and there is no sandbox.
export const TOOL_CREATE_METADATA: CoreToolMetadata = {
    name: TOOL_CREATE_NAME,
    description:
        "Create a tool for yourself from JavaScript source. `source` is the BODY of an async function, for example `return args.toUpperCase();`: it receives `args` (the call arguments; a one-property schema passes the value itself) and `context` (agent, agents, run). Registering validates and compiles the source and enables the tool for your next turn, without running it. The body runs with this process's full permissions - there is no sandbox - so only create tools you are willing to run, and keep them small.",
    tags: ['tools', 'create', 'extension', 'dynamic'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description:
                    'Wire name: a letter first, then letters, digits, "_" or "-", at most 64 characters.'
            },
            description: {
                type: 'string',
                description: 'What the tool does, shown to toolRequest and the model.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Capability tags, e.g. ["text", "upper"]. Required so toolRequest can find it.'
            },
            parameters: {
                type: 'object',
                description: "Optional JSON Schema for the new tool's arguments."
            },
            source: {
                type: 'string',
                description: 'Async function body, e.g. "return args.trim().toUpperCase();".'
            }
        },
        required: ['name', 'description', 'tags', 'source'],
        additionalProperties: false
    }
};

export const metadata = TOOL_CREATE_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'creation',
    order: 50,
    sessionBound: true,
    alwaysDeclared: true,
    listed: true
} as const;

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
