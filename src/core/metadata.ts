// Compatibility aggregation for the harness-owned CORE tools (T13 → T19 / R9).
//
// OWNERSHIP MOVED, PUBLIC SURFACE DID NOT
// ---------------------------------------
// Each core tool's declarative half lives in that tool's own editable entry, now
// under `tools/runtime/` after the R7 folder consolidation:
//
//   tools/runtime/toolRequest.tool.ts      TOOL_REQUEST_NAME / TOOL_REQUEST_METADATA
//   tools/runtime/toolList.tool.ts         TOOL_LIST_NAME / TOOL_LIST_METADATA
//   tools/runtime/toolManage.tool.ts       TOOL_MANAGE_NAME / TOOL_MANAGE_METADATA
//   tools/runtime/toolCreate.tool.ts       TOOL_CREATE_NAME / TOOL_CREATE_METADATA
//   tools/runtime/toolRegistry.tool.ts     TOOL_REGISTRY_NAME / TOOL_REGISTRY_METADATA
//   tools/runtime/todoManage.tool.ts       TODO_MANAGE_NAME / TODO_MANAGE_METADATA
//   tools/runtime/profileManage.tool.ts    PROFILE_MANAGE_NAME / PROFILE_MANAGE_METADATA
//   tools/runtime/chapterManage.tool.ts    CHAPTER_MANAGE_NAME / CHAPTER_MANAGE_METADATA
//   tools/runtime/locationManage.tool.ts   LOCATION_MANAGE_NAME / LOCATION_MANAGE_METADATA
//   tools/runtime/agentManage.tool.ts      AGENT_MANAGE_NAME / AGENT_MANAGE_METADATA
//   tools/runtime/agentResult.tool.ts      AGENT_RESULT_NAME / AGENT_RESULT_METADATA
//   tools/runtime/agentDelegate.tool.ts    AGENT_DELEGATE_NAME / agentDelegateMetadata
//   tools/runtime/toolCancel.tool.ts       TOOL_CANCEL_NAME / TOOL_CANCEL_METADATA
//   tools/runtime/actionRequest.tool.ts    ACTION_REQUEST_NAME / ACTION_REQUEST_METADATA
//   tools/runtime/threadFork.tool.ts       THREAD_FORK_NAME / THREAD_FORK_METADATA
//   tools/runtime/threadSend.tool.ts       THREAD_SEND_NAME / THREAD_SEND_METADATA
//   tools/runtime/threadList.tool.ts       THREAD_LIST_NAME / THREAD_LIST_METADATA
//
// This module is a DATA PROJECTION of the generated manifest plus the one
// set-projection function. Why keep it at all: the server
// (server/harnesses/core.ts) and the public package surface (core/index.ts) import
// these symbols by their historical paths. Keeping the names here means existing
// consumers do not care where the definitions live, while the editable `.tool.ts`
// entry a model/host inspects remains the authoritative source.
//
// NO TOOL MODULE IS IMPORTED HERE (R9)
// ------------------------------------
// Earlier revisions re-exported each `*.tool.ts` module, which evaluated every
// entry (and, transitively, `node:fs`/`node:child_process`) as soon as a catalogue
// wanted one description. This module now reads `./tool-manifest`, which is
// generated DATA: name/description/tags/schema/policy only, no implementations.
// That is what lets a host enumerate the catalogue without loading a single tool
// body, and it is also what keeps the browser graph free of Node built-ins.
//
// ADDRESSING, NOT A RUNTIME DEPENDENCY
// ------------------------------------
// Runtime entries must not import this module: it would create a cycle through the
// manifest. They annotate their local metadata with a TYPE-ONLY import of
// `../../core` (erased at transpile) and inline their schema bounds as literals.
//
// Core vs conditional. The ALWAYS-DECLARED set is coreToolMetadata(), in the
// harness's historical registration order (taken from each descriptor's
// `registration.order`). actionRequest/threadFork/toolCancel/threadSend/
// threadList/agentDelegate are capability-by-configuration: they are exported
// individually (and listed by the server catalogue) but deliberately omitted from
// coreToolMetadata() because a session without the capability must not declare
// them.
//
// Cross-references:
//   - ./tool-metadata.ts   — ToolMetadata / CoreToolMetadata / ToolRegistration
//   - ./tool-manifest.ts   — GENERATED descriptor table this module projects
//   - ./tool-discovery.ts  — the AST reader that produced the manifest
//   - ./agent-limits.ts    — AGENT_* preview/page/retention bounds
//   - ../tools/runtime/    — the authoritative per-tool declarations
//   - ../harness.ts        — registers these definitions as core tools
//   - ../../server/harnesses/core.ts — server catalogue entries for the same names

import { BUILTIN_TOOL_DESCRIPTORS } from './tool-manifest';
import type { BuiltinToolDescriptor, CoreToolMetadata, ToolMetadata } from './tool-metadata';

export type { CoreToolMetadata, ToolMetadata } from './tool-metadata';

// Shared agent-inspection bounds (leaf values, no imports). The runtime entries
// inline the same numbers because they may not value-import this file; the
// ownership test pins the equality.
export {
    AGENT_MANAGE_LIST_PER_AGENT,
    AGENT_MANAGE_PREVIEW_CHARS,
    AGENT_RESULT_PAGE_CHARS,
    AGENT_RESULT_PAGE_MAX_CHARS,
    AGENT_RESULT_RETENTION
} from './agent-limits';

// Look one generated row up by wire name. Throws for an unknown name so a typo
// fails loudly at import time instead of publishing an empty metadata object.
const descriptorOf = (name: string): BuiltinToolDescriptor => {
    const descriptor = BUILTIN_TOOL_DESCRIPTORS.find((candidate) => candidate.name === name);

    if (descriptor === undefined) {
        throw new Error(
            `No generated tool descriptor for "${name}". Regenerate with: npx vite-node scripts/generate-tool-manifest.mjs`
        );
    }

    return descriptor;
};

// A detached, JSON-shaped copy of one row's metadata. Callers spread this into a
// `tool()` configuration and may mutate the result, so the generated table is
// never handed out directly. `visibility` is defaulted to 'searchable' for the
// preset rows that omit it; every runtime row states 'core'.
const metadataOf = (name: string): ToolMetadata => {
    const metadata = descriptorOf(name).metadata;

    return {
        name: metadata.name,
        description: metadata.description,
        tags: [...metadata.tags],
        parameters: JSON.parse(JSON.stringify(metadata.parameters)) as Record<string, unknown>,
        visibility: metadata.visibility ?? 'searchable'
    };
};

// The core rows state `visibility: 'core'` in their entries, so this projection
// narrows the optional field to the stated union once, here.
const coreMetadataOf = (name: string): CoreToolMetadata => {
    const metadata = metadataOf(name);

    if (metadata.visibility === undefined) {
        throw new Error(`Core tool "${name}" must declare visibility in its entry.`);
    }

    return metadata as CoreToolMetadata;
};

// ---------------------------------------------------------------------------
// Wire names. Part of the harness contract: a model (and an operator) calls these
// exact strings. Taken from the generated descriptor names, which come from each
// entry's `metadata.name`, so a name cannot be advertised that the entry does not
// declare.
// ---------------------------------------------------------------------------

export const TOOL_REQUEST_NAME = descriptorOf('toolRequest').name;
export const TOOL_LIST_NAME = descriptorOf('toolList').name;
export const TOOL_MANAGE_NAME = descriptorOf('toolManage').name;
export const TOOL_CREATE_NAME = descriptorOf('toolCreate').name;
export const TOOL_REGISTRY_NAME = descriptorOf('toolRegistry').name;
export const TODO_MANAGE_NAME = descriptorOf('todoManage').name;
export const PROFILE_MANAGE_NAME = descriptorOf('profileManage').name;
export const CHAPTER_MANAGE_NAME = descriptorOf('chapterManage').name;
export const LOCATION_MANAGE_NAME = descriptorOf('locationManage').name;
export const AGENT_MANAGE_NAME = descriptorOf('agentManage').name;
export const AGENT_RESULT_NAME = descriptorOf('agentResult').name;
export const AGENT_DELEGATE_NAME = descriptorOf('agentDelegate').name;
export const TOOL_CANCEL_NAME = descriptorOf('toolCancel').name;
export const ACTION_REQUEST_NAME = descriptorOf('actionRequest').name;
export const THREAD_FORK_NAME = descriptorOf('threadFork').name;
export const THREAD_SEND_NAME = descriptorOf('threadSend').name;
export const THREAD_LIST_NAME = descriptorOf('threadList').name;

// ---------------------------------------------------------------------------
// Declarative halves, by historical symbol name.
// ---------------------------------------------------------------------------

// Discovery / inventory / management / creation.
export const TOOL_REQUEST_METADATA = coreMetadataOf(TOOL_REQUEST_NAME);
export const TOOL_LIST_METADATA = coreMetadataOf(TOOL_LIST_NAME);
export const TOOL_MANAGE_METADATA = coreMetadataOf(TOOL_MANAGE_NAME);
export const TOOL_CREATE_METADATA = coreMetadataOf(TOOL_CREATE_NAME);
export const TOOL_REGISTRY_METADATA = coreMetadataOf(TOOL_REGISTRY_NAME);

// Session record tools.
export const TODO_MANAGE_METADATA = coreMetadataOf(TODO_MANAGE_NAME);
export const PROFILE_MANAGE_METADATA = coreMetadataOf(PROFILE_MANAGE_NAME);
export const CHAPTER_MANAGE_METADATA = coreMetadataOf(CHAPTER_MANAGE_NAME);
export const LOCATION_MANAGE_METADATA = coreMetadataOf(LOCATION_MANAGE_NAME);

// Agent inspection and delegation.
export const AGENT_MANAGE_METADATA = coreMetadataOf(AGENT_MANAGE_NAME);
export const AGENT_RESULT_METADATA = coreMetadataOf(AGENT_RESULT_NAME);

// Conditional controls and cross-thread tools.
export const TOOL_CANCEL_METADATA = coreMetadataOf(TOOL_CANCEL_NAME);
export const ACTION_REQUEST_METADATA = coreMetadataOf(ACTION_REQUEST_NAME);
export const THREAD_FORK_METADATA = coreMetadataOf(THREAD_FORK_NAME);
export const THREAD_SEND_METADATA = coreMetadataOf(THREAD_SEND_NAME);
export const THREAD_LIST_METADATA = coreMetadataOf(THREAD_LIST_NAME);

// ---------------------------------------------------------------------------
// Delegation: the ONE set-projection function in this module.
// ---------------------------------------------------------------------------

// Delegation (R4). Capability-by-configuration: the harness registers agentDelegate
// only when the allowlist is non-empty, so this metadata has two honest forms:
//   - with subagents - the runtime declaration, whose `agent` enum is the exact
//     allowlist and whose description names it;
//   - without - the catalogue-only baseline below (the server lists the capability
//     and a session without subagents answers a clear 404 when it is called).
//
// The BASELINE IS THE ENTRY'S LITERAL (read from the generated manifest), and this
// function only applies the allowlist transformation to it. Keeping the baseline
// as data is what stops the two copies of the wording from drifting.
export const agentDelegateMetadata = (
    subagents: readonly string[] = []
): CoreToolMetadata => {
    const baseline = coreMetadataOf(AGENT_DELEGATE_NAME);
    const listed = [...subagents];

    if (listed.length === 0) return baseline;

    return {
        name: baseline.name,
        description: `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, so include everything it needs. Only the primary agent can delegate; subagents cannot delegate further.`,
        tags: [...baseline.tags],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    enum: listed,
                    description: 'Subagent name, one of the configured allowlist.'
                },
                input: {
                    type: 'string',
                    description: 'The full brief the subagent should act on.'
                }
            },
            required: ['agent', 'input'],
            additionalProperties: false
        }
    };
};

// ---------------------------------------------------------------------------
// The always-registered core set, in the harness's registration order.
// ---------------------------------------------------------------------------

// Selected by the descriptor's `alwaysDeclared` flag (which the entry declares in
// its `registration` literal) and ordered by `registration.order`. That is the
// same order the harness registers them in, so this projection and the live
// registry cannot disagree about sequence.
//
// toolRegistry is deliberately absent: it IS the registration surface, and the
// historical projection never listed it (the server adds it explicitly). toolCreate
// is present even though its REGISTRATION is policy-gated, because "always
// declared" is a declaration classification, not a registration condition.
export const coreToolMetadata = (): CoreToolMetadata[] =>
    BUILTIN_TOOL_DESCRIPTORS.filter((descriptor) => descriptor.alwaysDeclared === true)
        .slice()
        .sort((left, right) => left.order - right.order)
        .map((descriptor) => coreMetadataOf(descriptor.name));
