// toolList — canonical `*.tool.ts` inventory entry.
//
// This module is deliberately tiny and self-contained in the required convention:
// `metadata` carries name/description/tags/schema and `execute` delegates to the
// live harness runtime. The harness owns registry state; replacing this file
// replaces only the model-facing shape, never the inventory operation.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

// Inventory of every live registry entry (name + description only). Distinct from
// toolRequest: listing must never imply a tool is enabled or callable.
export const TOOL_LIST_NAME = 'toolList';

// Full inventory. Deliberately returns ONLY name + description for every live
// registry entry, enabled or not; a model that needs tags/schema/source uses
// toolRequest or toolManage.
export const TOOL_LIST_METADATA: CoreToolMetadata = {
    name: TOOL_LIST_NAME,
    description:
        'List every registered tool by name and description, whether or not toolRequest has enabled it. Use this for an inventory; use toolRequest to make searchable tools callable, and toolManage for tags, schema, source, or editing.',
    tags: ['tools', 'list', 'catalogue', 'inventory'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
    }
};

export const metadata = TOOL_LIST_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 30,
    sessionBound: true,
    alwaysDeclared: true,
    listed: true
} as const;

export const execute = (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error('toolList requires the live harness reference.');
    }

    return harness.runtime.listTools();
};
