// toolRequest — standalone source entry for catalogue discovery.
//
// The harness owns the discovery cursor/enabled set; this entry owns the tool
// contract and delegates to that live operation. Starting the harness compiles
// THIS file through the same kernel as any replacement, so editing/inspecting the
// entry is meaningful in production.
import type { CoreToolMetadata } from '../core';
import type { ToolContext } from '../types';

// Wire names. They are part of the harness contract: a model (and an operator)
// calls these exact strings, and the harness reserves them against every other
// tool source.
export const TOOL_REQUEST_NAME = 'toolRequest';

// Discovery. `selectTools` returns the whole union of exact names, name regex,
// and ranked tags; the harness (not this schema) bounds how many searchable tools
// may be enabled for a turn through `maxEnabledTools`, and core tools never spend
// that budget. `limit` remains a per-call narrowing of THIS query, not a global
// request cap. The description explains the alreadyAvailable report: a query
// naming an already-declared capability (agentDelegate in a harness with
// subagents is the motivating case) must not look like a miss.
export const TOOL_REQUEST_METADATA: CoreToolMetadata = {
    name: TOOL_REQUEST_NAME,
    description:
        'Find tools and enable them for your next turn, and check which tools you already have. Query by exact `names` (case-sensitive), by a name `regex`, and/or by capability `tags` (for example ["files", "list"], ["shell"], or ["git", "diff"]); the selector returns the UNION of all three, best match first, with no arbitrary five-result cap. The host may bound the total searchable tools enabled for a turn (`maxEnabledTools`); when that bound is full, the newest request takes precedence - whichever selector it used (`names`, `regex`, or `tags`), not only exact names - and replaces older enabled searchable tools as needed to make room, while core tools neither count against the bound nor get evicted. `matched` reports the full match count and `omitted` the exact number that did not get a slot, so a full answer is reported rather than silently truncated. The `alreadyAvailable` list names tools you can call directly right now without enabling anything - for example agentDelegate when this harness has subagents; a capability that appears in neither list is genuinely unavailable. An optional `limit` narrows only this query. Call this before concluding that something cannot be done.',
    tags: ['discovery', 'tools', 'catalogue'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            names: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exact wire names to enable, case-sensitive (e.g. ["fileList"]).'
            },
            regex: {
                type: 'string',
                description: 'JavaScript regex tested against tool names; bare source or /source/flags.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Capability tags to look for, e.g. ["files", "read", "shell"].'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                description:
                    "Optional per-query narrowing: return at most this many of THIS query's matches. It is not a global request cap."
            }
        },
        required: [],
        additionalProperties: false
    }
};

export const metadata = TOOL_REQUEST_METADATA;

export const execute = (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error('toolRequest requires the live harness reference.');
    }

    return harness.runtime.requestTools(context.agent, context.parameters);
};
