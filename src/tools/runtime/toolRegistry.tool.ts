// toolRegistry — the ordinary model-facing entry for self-modifying tools.
//
// This file is an independently compilable source entry. Startup registers it by
// compiling THIS FILE through the same synchronous kernel operation runtime
// registrations use, so the registration path is not special-cased:
//
//     harness() -> prepareToolCandidate({ sourcePath: 'tools/runtime/toolRegistry.tool.ts' })
//               -> publish prepared tool
//
// The implementation is deliberately thin: the harness kernel owns capture,
// compilation, validation, ordering, and atomic publication. This entry owns the
// tool contract and the mapping from model arguments to a registration candidate;
// replacing this file replaces the model-facing registration behavior.
//
// Cross-references:
//   - this file — TOOL_REGISTRY_METADATA is authoritative (T13); ../core/metadata.ts
//     projects it from the generated manifest for the server/public compatibility
//     surface
//   - ../core/tool-source.ts — compile/load/validate
//   - ../harness.ts — registerTool (the underlying kernel operation)
//   - ../types — HarnessToolRegistrationCandidate

import type { CoreToolMetadata } from '../../core';
import type { HarnessToolRegistrationCandidate, ToolContext } from '../../types';

// Runtime source registration/replacement (self-modifying tools). This is an
// ordinary core tool that delegates to the harness kernel; it is deliberately not
// reserved and can replace itself like every other tool.
export const TOOL_REGISTRY_NAME = 'toolRegistry';

// Self-modifying source registration. `sourcePath` and `moduleText` are mutually
// exclusive; both compile through the SAME synchronous kernel operation startup
// uses. Successful registration publishes metadata, schema, and implementation
// together, and replaces an existing name (including this tool's own) atomically.
// Transpilation is not a type check and the loaded code runs with full process
// permissions; the description states both facts so the model is not misled.
export const TOOL_REGISTRY_METADATA: CoreToolMetadata = {
    name: TOOL_REGISTRY_NAME,
    description:
        'Compile and register a tool from editable source, replacing any existing registration with the same name. Provide `sourcePath` (a tool-source-relative or absolute path) or `moduleText` (full TypeScript/JavaScript module text). The module must export a Tool (named/default), a `tool` export, or `metadata` + `execute`. Local helper imports are compiled from source; `node:` imports and package dependencies resolve through Node. Success returns the installed name and source revision and makes the tool immediately callable; syntax, loading, or contract failures return diagnostics and leave the previous registration untouched. Transpilation checks syntax, NOT semantic types or runtime correctness, and loaded code runs with full process permissions.',
    tags: ['tools', 'registry', 'source', 'self-modifying', 'compile'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description:
                    'Wire name to install. Optional when the module exports a named Tool or metadata.name; required for a default/legacy registration.'
            },
            sourcePath: {
                type: 'string',
                description:
                    'Editable entry file, relative to the package source roots or absolute. Local relative imports are compiled and captured with it.'
            },
            moduleText: {
                type: 'string',
                description: 'Full module source, for a revision that is not written to disk yet.'
            },
            source: {
                type: 'string',
                description:
                    'Legacy form: the BODY of an async function (args, context) => value. Mutually exclusive with module forms.'
            },
            description: {
                type: 'string',
                description: 'Optional metadata override for the installed tool.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tag override for the installed tool.'
            },
            parameters: {
                type: 'object',
                description: 'Optional JSON Schema override for the installed tool.'
            },
            visibility: {
                type: 'string',
                enum: ['core', 'searchable'],
                description: 'Optional visibility override; defaults to the module value or "searchable".'
            },
            dependencies: {
                type: 'array',
                description:
                    'Optional virtual local modules for moduleText: [{ path, text }]. Relative imports resolve against them.',
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
        additionalProperties: false
    }
};

export const metadata = TOOL_REGISTRY_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 10,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

// Compile/register one candidate. The harness promise is already-backed: the
// kernel performs capture + compilation + publication synchronously before
// returning it, so awaiting this only observes an already-committed result.
//
// A missing harness reference is an honest error rather than a fabricated local
// compiler: registration must target the live harness the caller belongs to.
export const execute = async (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error(
            'toolRegistry requires the live harness reference; call it through a harness invocation.'
        );
    }

    const parameters = (context.parameters ?? {}) as Record<string, unknown>;

    // `definition` is host-only. Accepting it from the model would let a call
    // bypass source inspection and the wording of the compile gate, so it is not
    // part of the advertised schema and is refused here.
    if (parameters.definition !== undefined) {
        throw new Error('toolRegistry does not accept a prebuilt definition; pass sourcePath or moduleText.');
    }

    // Build the candidate explicitly instead of forwarding unknown keys: the
    // kernel's accepted surface stays small and a typo cannot be mistaken for an
    // intended field.
    const candidate: HarnessToolRegistrationCandidate = {
        ...(typeof parameters.name === 'string' ? { name: parameters.name } : {}),
        ...(typeof parameters.description === 'string'
            ? { description: parameters.description }
            : {}),
        ...(Array.isArray(parameters.tags) ? { tags: parameters.tags as string[] } : {}),
        ...(typeof parameters.parameters === 'object' && parameters.parameters !== null
            ? { parameters: parameters.parameters as Record<string, unknown> }
            : {}),
        ...(parameters.visibility === 'core' || parameters.visibility === 'searchable'
            ? { visibility: parameters.visibility }
            : {}),
        ...(typeof parameters.source === 'string' ? { source: parameters.source } : {}),
        ...(typeof parameters.moduleText === 'string' ? { moduleText: parameters.moduleText } : {}),
        ...(typeof parameters.sourcePath === 'string' ? { sourcePath: parameters.sourcePath } : {}),
        ...(Array.isArray(parameters.dependencies)
            ? {
                  dependencies: (parameters.dependencies as Array<Record<string, unknown>>).map(
                      (dependency) => ({
                          path: String(dependency.path ?? ''),
                          text: String(dependency.text ?? '')
                      })
                  )
              }
            : {})
    };

    return harness.registerTool(candidate);
};
