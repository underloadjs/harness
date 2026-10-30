// toolRegistry — the ordinary model-facing entry for self-modifying tools.
//
// This file is an independently compilable source entry. Startup registers it by
// compiling THIS FILE through the same synchronous kernel operation runtime
// registrations use, so the registration path is not special-cased:
//
//     harness() -> prepareToolCandidate({ sourcePath: 'runtime-tools/toolRegistry.ts' })
//               -> publish prepared tool
//
// The implementation is deliberately thin: the harness kernel owns capture,
// compilation, validation, ordering, and atomic publication. This entry owns the
// tool contract and the mapping from model arguments to a registration candidate;
// replacing this file replaces the model-facing registration behavior.
//
// Cross-references:
//   - ../core/metadata.ts — TOOL_REGISTRY_METADATA (single metadata source)
//   - ../core/tool-source.ts — compile/load/validate
//   - ../harness.ts — registerTool (the underlying kernel operation)
//   - ../types — HarnessToolRegistrationCandidate

import { TOOL_REGISTRY_METADATA } from '../core/metadata';
import type { HarnessToolRegistrationCandidate, ToolContext } from '../types';

// Reuse the canonical metadata so the server catalogue and the runtime cannot
// advertise different names, descriptions, or schemas.
export const metadata = TOOL_REGISTRY_METADATA;

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
