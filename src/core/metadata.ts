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
//   tools/runtime/records.tool.ts            RECORDS_NAME / RECORDS_METADATA
//   tools/runtime/tasks.tool.ts              TASKS_NAME / TASKS_METADATA
//   tools/runtime/profiles.tool.ts           PROFILES_NAME / PROFILES_METADATA
//   tools/runtime/chapters.tool.ts           CHAPTERS_NAME / CHAPTERS_METADATA
//   tools/runtime/locations.tool.ts          LOCATIONS_NAME / LOCATIONS_METADATA
//   tools/runtime/agentManage.tool.ts      AGENT_MANAGE_NAME / AGENT_MANAGE_METADATA
//   tools/runtime/agentResult.tool.ts      AGENT_RESULT_NAME / AGENT_RESULT_METADATA
//   tools/runtime/delegate.tool.ts    AGENT_DELEGATE_NAME / agentDelegateMetadata
//   tools/runtime/toolCancel.tool.ts       TOOL_CANCEL_NAME / TOOL_CANCEL_METADATA
//   tools/runtime/actionRequest.tool.ts    ACTION_REQUEST_NAME / ACTION_REQUEST_METADATA
//   tools/runtime/threadFork.tool.ts       THREAD_FORK_NAME / THREAD_FORK_METADATA
//   tools/runtime/threadSend.tool.ts       THREAD_SEND_NAME / THREAD_SEND_METADATA
//   tools/runtime/threadList.tool.ts       THREAD_LIST_NAME / THREAD_LIST_METADATA
//   tools/runtime/threadRead.tool.ts       THREAD_READ_NAME / THREAD_READ_METADATA
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
// threadList/threadRead/delegate are capability-by-configuration: they are
// exported individually (and listed by the server catalogue) but deliberately
// omitted from coreToolMetadata() because a session without the capability must
// not declare them.
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
//
// The three model-settable run bounds below join that list for the same reason: the
// canonical number lives in ./agent-limits, the ENTRY restates it as a literal, and
// this module is where a consumer (the server catalogue, and the ownership test that
// pins the equality) reads the canonical value. `MODEL_TIMEOUT_MAX_MS` is the ceiling
// BOTH `delegate` and `threadFork` inline as `3600000`; `FORK_TIMEOUT_MS` is the fork
// half of "the default is no limit"; `DELEGATE_MAX_TURNS_MAX` is the `maxTurns`
// ceiling the delegate entry inlines as `64`.
export {
    AGENT_MANAGE_LIST_PER_AGENT,
    AGENT_MANAGE_PREVIEW_CHARS,
    AGENT_RESULT_PAGE_CHARS,
    AGENT_RESULT_PAGE_MAX_CHARS,
    AGENT_RESULT_RETENTION,
    DELEGATE_MAX_TURNS_MAX,
    DELEGATE_TIMEOUT_MS,
    FORK_TIMEOUT_MS,
    MODEL_TIMEOUT_MAX_MS
} from './agent-limits';

// Look one generated row up by wire name. Throws for an unknown name so a typo
// fails loudly at import time instead of publishing an empty metadata object.
const descriptorOf = (name: string): BuiltinToolDescriptor => {
    const descriptor = BUILTIN_TOOL_DESCRIPTORS.find((candidate) => candidate.name === name);

    if (descriptor === undefined) {
        throw new Error(
            `No generated tool descriptor for "${name}". Regenerate with: yarn vite-node scripts/generate-tool-manifest.ts`
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

// R9-R11 rows state their visibility explicitly (core for the declared set,
// searchable for the demand-discovery set), so this projection narrows the
// optional field to the stated union once, here. The function name is
// historical: it means "states visibility", not "is core".
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
export const TASKS_NAME = descriptorOf('tasks').name;
export const RECORDS_NAME = descriptorOf('records').name;
export const PROFILES_NAME = descriptorOf('profiles').name;
export const CHAPTERS_NAME = descriptorOf('chapters').name;
export const LOCATIONS_NAME = descriptorOf('locations').name;
export const AGENT_MANAGE_NAME = descriptorOf('agentManage').name;
export const AGENT_RESULT_NAME = descriptorOf('agentResult').name;
export const AGENT_DELEGATE_NAME = descriptorOf('delegate').name;
export const TOOL_CANCEL_NAME = descriptorOf('toolCancel').name;
export const ACTION_REQUEST_NAME = descriptorOf('actionRequest').name;
export const THREAD_FORK_NAME = descriptorOf('threadFork').name;
export const THREAD_SEND_NAME = descriptorOf('threadSend').name;
export const THREAD_READ_NAME = descriptorOf('threadRead').name;
export const THREAD_LIST_NAME = descriptorOf('threadList').name;
// B3 (2026-11-13): the row is now projected. `descriptorOf` throws for a name the
// committed `./tool-manifest` does not carry, so this line could only land once
// `yarn tools:manifest` had regenerated the table with `threadDelete` (order 255).
export const THREAD_DELETE_NAME = descriptorOf('threadDelete').name;

// ---------------------------------------------------------------------------
// Declarative halves, by historical symbol name.
// ---------------------------------------------------------------------------

// Discovery / inventory / management / creation.
export const TOOL_REQUEST_METADATA = coreMetadataOf(TOOL_REQUEST_NAME);
export const TOOL_LIST_METADATA = coreMetadataOf(TOOL_LIST_NAME);
export const TOOL_MANAGE_METADATA = coreMetadataOf(TOOL_MANAGE_NAME);
export const TOOL_CREATE_METADATA = coreMetadataOf(TOOL_CREATE_NAME);
export const TOOL_REGISTRY_METADATA = coreMetadataOf(TOOL_REGISTRY_NAME);

// Session record tools: the engine plus its four wrappers (records-engine T3).
export const RECORDS_METADATA = coreMetadataOf(RECORDS_NAME);
export const TASKS_METADATA = coreMetadataOf(TASKS_NAME);
export const PROFILES_METADATA = coreMetadataOf(PROFILES_NAME);
export const CHAPTERS_METADATA = coreMetadataOf(CHAPTERS_NAME);
export const LOCATIONS_METADATA = coreMetadataOf(LOCATIONS_NAME);

// Agent inspection and delegation.
export const AGENT_MANAGE_METADATA = coreMetadataOf(AGENT_MANAGE_NAME);
export const AGENT_RESULT_METADATA = coreMetadataOf(AGENT_RESULT_NAME);

// Conditional controls and cross-thread tools.
export const TOOL_CANCEL_METADATA = coreMetadataOf(TOOL_CANCEL_NAME);
export const ACTION_REQUEST_METADATA = coreMetadataOf(ACTION_REQUEST_NAME);
export const THREAD_FORK_METADATA = coreMetadataOf(THREAD_FORK_NAME);
export const THREAD_SEND_METADATA = coreMetadataOf(THREAD_SEND_NAME);
export const THREAD_READ_METADATA = coreMetadataOf(THREAD_READ_NAME);
export const THREAD_LIST_METADATA = coreMetadataOf(THREAD_LIST_NAME);
// B3 (2026-11-13): `threadDelete` (issue 0027) is projected NOW, and the ordering was
// the constraint, not taste: `coreMetadataOf`/`descriptorOf` THROW for a name the
// committed `./tool-manifest` does not carry, so this row could only land in the same
// step that regenerated the table (`yarn tools:manifest`, 32 descriptors). Before that
// the row made this module — and every importer of `core/index` — throw on import.
export const THREAD_DELETE_METADATA = coreMetadataOf(THREAD_DELETE_NAME);

// ---------------------------------------------------------------------------
// Delegation: the ONE set-projection function in this module.
// ---------------------------------------------------------------------------

// Delegation (R4). Capability-by-configuration: the harness registers delegate
// only when the allowlist is non-empty, so this metadata has two honest forms:
//   - with subagents - the runtime declaration, whose `agent` enum is the exact
//     allowlist and whose description names it;
//   - without - the catalogue-only baseline below (the server lists the capability
//     and a session without subagents answers a clear 404 when it is called).
//
// The BASELINE IS THE ENTRY'S LITERAL (read from the generated manifest), and this
// function only applies the allowlist transformation to it. Keeping the baseline
// as data is what stops the two copies of the wording from drifting.
//
// T28: the allowlist form is derived from the BASELINE SCHEMA, not re-typed. The
// previous version restated `properties` by hand, so every new delegate argument
// (`maxChars`, `requireClarification`, `timeoutMs`, `maxTurns`) had to be added twice
// and the projection silently advertised a smaller surface than the entry it claimed
// to mirror. Only `agent` is replaced (its enum IS the allowlist); every other
// property is copied from the entry's own literal.
//
// The DESCRIPTION below is the one hand-duplicated string in this module: it is the
// entry's `agentDelegateMetadata` allowlist wording (../tools/runtime/delegate.tool.ts),
// which this module may not import. Keep the two character-for-character equal — the
// entry has the matching note, and core/metadata.ownership.test.ts compares the two
// projections, so the equality is enforced rather than intended.
export const agentDelegateMetadata = (
    subagents: readonly string[] = []
): CoreToolMetadata => {
    const baseline = coreMetadataOf(AGENT_DELEGATE_NAME);
    const listed = [...subagents];

    if (listed.length === 0) return baseline;

    const baselineParameters = baseline.parameters as {
        properties?: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties?: boolean;
    };

    return {
        name: baseline.name,
        description: `Delegate a self-contained task to a configured subagent and return its answer. Subagents: ${listed.join(', ')}. The subagent does not see this conversation, and each delegation starts a NEW conversation with it, so it remembers no earlier one either - unless the call comes from the host rather than one of your conversations, and then the child re-enters that subagent's default conversation (agent:<name>), where it may remember what it answered for you before: the brief must carry everything it needs. Only the primary agent can delegate; subagents cannot delegate further. The result carries agent, content, contentLength, offset, limit, truncated, nextOffset and durationMs, and - when the run is identifiable - invocationId, threadId and status; a child whose ledger entry cannot be resolved (released with its thread, or aged out of the bounded result ledger) reports its answer with those three keys ABSENT rather than inventing an identity, and a run that did not complete adds error, plus the forensic fields it has: partialContent - only the LAST assistant TEXT that run committed, its tool calls and tool results are rolled back and never retained - and cancelledAtMessage, which counts the messages that run had committed and is not a measure of progress. threadId and invocationId are HANDLES, not bookkeeping: threadId is the conversation the child ran in, so post a follow-up message into it with threadSend and read its transcript with threadRead, while agentResult pages that answer by invocationId; a finished child thread stays addressable until it is released with threadDelete, which is also how a session frees a thread slot. content is ONE page of at most maxChars characters (default 8000): when truncated is true, read the rest with agentResult using invocationId and nextOffset as offset - and pass limit, because agentResult's own page is at most 8000 and DEFAULTS TO 4000, so following the cursor without it silently halves your page - or delegate again with a larger maxChars. A cancelled or failed child is reported as a structured result rather than an empty record: its error, plus partialContent whenever it had committed assistant text. That partial is one assistant message, so work the child did through tools is not recoverable from it, and cancelledAtMessage counts committed messages - durationMs is the field that scales with the work. maxTurns caps how many model REQUESTS the child may make (1-64) when you want a deliberately short run; its answer must land inside the cap, so N leaves room for at most N-1 tool rounds and 1 only suits a child that answers with no tool call. Omit it and the harness-wide limit applies. DELIVERY: a delegation is background work, so the RESULT SHAPE is always the envelope above, but WHEN it arrives depends on the child. A child that finishes without real I/O has its result in the tool message of your next turn; a child that is still running leaves a { status: "pending", callId, name, invocationId, threadId, elapsedMs, note } placeholder there instead, and the real envelope arrives in a later turn (use toolCancel with that callId to abandon it). The two ids are in the placeholder on purpose: while the child is still running you can already page what it has produced with agentResult by invocationId, or read its live transcript with threadRead / post into it with threadSend by threadId - and both are ABSENT when the child never started, so a missing id means no run, not an unknown one. Never treat the placeholder as an answer, and never assume the envelope is missing just because the first turn showed a placeholder. Abandoning a live child with toolCancel does not discard its outcome: the tool message of that call carries the same envelope, built from the child's terminal record - status, any partialContent/cancelledAtMessage - plus callCancelled: true, which marks that you released the call while the child's result stayed readable. The toolCancel result itself is an acknowledgement, not the delegation's answer.`,
        tags: [...baseline.tags],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: {
                ...(baselineParameters.properties ?? {}),
                agent: {
                    type: 'string',
                    enum: listed,
                    description: 'Subagent name, one of the configured allowlist.'
                }
            },
            required: [...(baselineParameters.required ?? ['agent', 'input'])],
            additionalProperties: baselineParameters.additionalProperties ?? false
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
