// toolManage — canonical `*.tool.ts` management entry.
//
// All mutation (create/update/reload) is delegated to the harness runtime, which
// calls the SAME acceptTool/prepareToolCandidate kernel as toolCreate and
// toolRegistry. This module owns only the model-facing contract; it never writes a
// file or publishes a definition itself.
import type { CoreToolMetadata } from '../../core';
import type { HarnessToolManageParameters, ToolContext } from '../../types';

// Active management surface: inspect source/path, create/update folder entries,
// and reload an installed revision. All mutation still goes through the same
// acceptTool kernel as toolCreate/toolRegistry.
export const TOOL_MANAGE_NAME = 'toolManage';

// Management/inspection. Read operations (list/details/source/path) are always
// available. Mutations (create/update/reload) compile through the same kernel as
// toolCreate/toolRegistry: a candidate is prepared before publication, so a
// failed edit leaves the previous registration untouched.
//
// Persistence default (T13/T12 cross-contract): `create` and `update` PERSIST by
// default. A create without `path` derives a safe `<name>.tool.ts` filename in the
// LAST configured toolFolders entry; an update without `path` rewrites the tool's
// owning source path. `persist: "runtime"` is the explicit opt-out: it keeps the
// candidate in the registry only and cannot be combined with `path`/`folder`. The
// schema below is the model-facing contract the runtime implements (harness.ts
// `persistentTargetFor` / `persistAndRegister`); keep the default and the enum in
// step with that lifecycle.
export const TOOL_MANAGE_METADATA: CoreToolMetadata = {
    name: TOOL_MANAGE_NAME,
    description:
        'Inspect and edit registered tools. `list` returns registry metadata, `details` inspects one tool, `source` returns its captured module text and local dependencies, `path` resolves a tool source path or a candidate path inside the configured toolFolders, `create` and `update` register a module and, by default, persist it: `create` writes a safe `<name>.tool.ts` filename in the LAST configured toolFolders entry, and `update` rewrites the tool\'s owning source path (an explicit `path` overrides either). Set `persist: "runtime"` to opt out of disk writes explicitly; that mode keeps the module in this session\'s registry only and cannot be combined with `path` or `folder`. `reload` recompiles the installed source revision. Every mutation is validated and published atomically through the same kernel as toolCreate/toolRegistry; a failed compile leaves the previous tool registered. Loaded tool code runs with this process\'s full permissions - there is no sandbox.',
    tags: ['tools', 'manage', 'source', 'edit', 'reload'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            operation: {
                type: 'string',
                enum: ['list', 'details', 'source', 'path', 'create', 'update', 'reload'],
                description: 'What to do.'
            },
            name: {
                type: 'string',
                description: 'Registered tool name (details/source/path/reload, optional expected name on create/update).'
            },
            path: {
                type: 'string',
                description:
                    'Explicit *.tool.ts file path, absolute or relative to `folder`. Overrides the default create filename or the update owning path; not allowed with persist "runtime".'
            },
            folder: {
                type: 'string',
                description:
                    'Configured toolFolders entry that a relative `path` resolves against; requires `path`. A pathless create targets the LAST configured entry.'
            },
            persist: {
                type: 'string',
                enum: ['folder', 'runtime'],
                default: 'folder',
                description:
                    'Where create/update persist the module. "folder" (default) writes it to disk: a safe `<name>.tool.ts` in the last configured toolFolders entry for create, or the owning source path for update. "runtime" explicitly keeps it in this session\'s registry only and cannot be combined with `path` or `folder`.'
            },
            moduleText: {
                type: 'string',
                description: 'Full TypeScript/JavaScript module text for create/update/reload when not reading a path.'
            },
            source: {
                type: 'string',
                description: 'Legacy async function-body form for create/update (mutually exclusive with moduleText).'
            },
            description: {
                type: 'string',
                description: 'Optional metadata override installed with the candidate.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tag override installed with the candidate.'
            },
            parameters: {
                type: 'object',
                description: 'Optional JSON Schema override installed with the candidate.'
            },
            visibility: {
                type: 'string',
                enum: ['core', 'searchable'],
                description: 'Optional visibility override for the installed candidate.'
            },
            dependencies: {
                type: 'array',
                description:
                    'Optional captured local helper modules for moduleText: [{ path, text }].',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        text: { type: 'string' }
                    },
                    required: ['path', 'text'],
                    additionalProperties: false
                }
            }
        },
        required: ['operation'],
        additionalProperties: false
    }
};

export const metadata = TOOL_MANAGE_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 40,
    sessionBound: true,
    alwaysDeclared: true,
    listed: true
} as const;

export const execute = (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error('toolManage requires the live harness reference.');
    }

    return harness.runtime.manageTool(
        context.agent,
        (context.parameters ?? { operation: 'list' }) as HarnessToolManageParameters
    );
};
