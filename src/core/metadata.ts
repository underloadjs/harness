// Compatibility aggregation for the harness-owned CORE tools (T13 / R2).
//
// OWNERSHIP MOVED, PUBLIC SURFACE DID NOT
// ---------------------------------------
// Each core tool's declarative half (wire name, description, tags, schema) now
// lives in that tool's own editable entry:
//
//   runtime-tools/toolRequest.tool.ts      TOOL_REQUEST_NAME / TOOL_REQUEST_METADATA
//   runtime-tools/toolList.tool.ts         TOOL_LIST_NAME / TOOL_LIST_METADATA
//   runtime-tools/toolManage.tool.ts       TOOL_MANAGE_NAME / TOOL_MANAGE_METADATA
//   runtime-tools/toolCreate.tool.ts       TOOL_CREATE_NAME / TOOL_CREATE_METADATA
//   runtime-tools/toolRegistry.tool.ts     TOOL_REGISTRY_NAME / TOOL_REGISTRY_METADATA
//   runtime-tools/todoManage.tool.ts       TODO_MANAGE_NAME / TODO_MANAGE_METADATA
//   runtime-tools/profileManage.tool.ts    PROFILE_MANAGE_NAME / PROFILE_MANAGE_METADATA
//   runtime-tools/chapterManage.tool.ts    CHAPTER_MANAGE_NAME / CHAPTER_MANAGE_METADATA
//   runtime-tools/locationManage.tool.ts   LOCATION_MANAGE_NAME / LOCATION_MANAGE_METADATA
//   runtime-tools/agentManage.tool.ts      AGENT_MANAGE_NAME / AGENT_MANAGE_METADATA
//   runtime-tools/agentResult.tool.ts      AGENT_RESULT_NAME / AGENT_RESULT_METADATA
//   runtime-tools/agentDelegate.tool.ts    AGENT_DELEGATE_NAME / agentDelegateMetadata
//   runtime-tools/toolCancel.tool.ts       TOOL_CANCEL_NAME / TOOL_CANCEL_METADATA
//   runtime-tools/actionRequest.tool.ts    ACTION_REQUEST_NAME / ACTION_REQUEST_METADATA
//   runtime-tools/threadFork.tool.ts       THREAD_FORK_NAME / THREAD_FORK_METADATA
//   runtime-tools/threadSend.tool.ts       THREAD_SEND_NAME / THREAD_SEND_METADATA
//   runtime-tools/threadList.tool.ts       THREAD_LIST_NAME / THREAD_LIST_METADATA
//
// This module is a DATA-FREE re-export layer plus the one set-projection function.
// Why keep it at all: the server (server/harnesses/core.ts) and public package
// surface (core/index.ts) import these symbols by their historical paths. Keeping
// the names here means existing consumers do not care where the definitions live,
// while the editable `.tool.ts` entry a model/host inspects is now the same object
// the runtime registers.
//
// ADDRESSING, NOT A RUNTIME DEPENDENCY
// ------------------------------------
// Runtime entries must not import this module: it imports every entry, so a value
// import back into it would create a cycle. They annotate their local metadata with
// a TYPE-ONLY import of `../core` (erased at transpile) and inline their schema
// bounds as literals. This file is therefore only ever imported by the aggregating
// consumers, never by an entry it aggregates.
//
// Core vs conditional. The ALWAYS-registered set is coreToolMetadata(), in the
// harness's registration order. actionRequest/threadFork/toolCancel/threadSend/
// threadList/agentDelegate are capability-by-configuration: they are exported
// individually (and listed by the server catalogue) but deliberately omitted from
// coreToolMetadata() because a session without the capability must not declare
// them. Preset tools live in src/tools and are owned by their own *.tool.ts files;
// the four everyday file tools are part of the catalogue's core classification but
// are not harness-owned metadata.
//
// Cross-references:
//   - ./tool-metadata.ts    — CoreToolMetadata (shared leaf type)
//   - ./agent-limits.ts     — AGENT_* preview/page/retention bounds
//   - ../runtime-tools/     — the authoritative per-tool declarations
//   - ../harness.ts         — registers these definitions as core tools
//   - ../../harnesses/core.ts — server catalogue entries for the same names

import type { CoreToolMetadata } from './tool-metadata';
// The set projection needs local bindings; the per-entry declarations below stay
// re-exported so consumers keep importing them from this historical path.
import { TOOL_REQUEST_METADATA } from '../runtime-tools/toolRequest.tool';
import { TOOL_LIST_METADATA } from '../runtime-tools/toolList.tool';
import { TOOL_MANAGE_METADATA } from '../runtime-tools/toolManage.tool';
import { TOOL_CREATE_METADATA } from '../runtime-tools/toolCreate.tool';
import { TODO_MANAGE_METADATA } from '../runtime-tools/todoManage.tool';
import { PROFILE_MANAGE_METADATA } from '../runtime-tools/profileManage.tool';
import { CHAPTER_MANAGE_METADATA } from '../runtime-tools/chapterManage.tool';
import { LOCATION_MANAGE_METADATA } from '../runtime-tools/locationManage.tool';
import { AGENT_MANAGE_METADATA } from '../runtime-tools/agentManage.tool';
import { AGENT_RESULT_METADATA } from '../runtime-tools/agentResult.tool';

export type { CoreToolMetadata } from './tool-metadata';

// Shared agent-inspection bounds (leaf values, no imports). The runtime entries
// inline the same numbers because they may not import this file without capturing
// a local dependency; core/metadata.ownership.test.ts pins the equality.
export {
    AGENT_MANAGE_LIST_PER_AGENT,
    AGENT_MANAGE_PREVIEW_CHARS,
    AGENT_RESULT_PAGE_CHARS,
    AGENT_RESULT_PAGE_MAX_CHARS,
    AGENT_RESULT_RETENTION
} from './agent-limits';

// Discovery / inventory / management / creation.
export { TOOL_REQUEST_NAME, TOOL_REQUEST_METADATA } from '../runtime-tools/toolRequest.tool';
export { TOOL_LIST_NAME, TOOL_LIST_METADATA } from '../runtime-tools/toolList.tool';
export { TOOL_MANAGE_NAME, TOOL_MANAGE_METADATA } from '../runtime-tools/toolManage.tool';
export { TOOL_CREATE_NAME, TOOL_CREATE_METADATA } from '../runtime-tools/toolCreate.tool';
export {
    TOOL_REGISTRY_NAME,
    TOOL_REGISTRY_METADATA
} from '../runtime-tools/toolRegistry.tool';

// Session record tools.
export { TODO_MANAGE_NAME, TODO_MANAGE_METADATA } from '../runtime-tools/todoManage.tool';
export { PROFILE_MANAGE_NAME, PROFILE_MANAGE_METADATA } from '../runtime-tools/profileManage.tool';
export { CHAPTER_MANAGE_NAME, CHAPTER_MANAGE_METADATA } from '../runtime-tools/chapterManage.tool';
export {
    LOCATION_MANAGE_NAME,
    LOCATION_MANAGE_METADATA
} from '../runtime-tools/locationManage.tool';

// Agent inspection and delegation.
export { AGENT_MANAGE_NAME, AGENT_MANAGE_METADATA } from '../runtime-tools/agentManage.tool';
export { AGENT_RESULT_NAME, AGENT_RESULT_METADATA } from '../runtime-tools/agentResult.tool';
export {
    AGENT_DELEGATE_NAME,
    agentDelegateMetadata
} from '../runtime-tools/agentDelegate.tool';

// Conditional controls and cross-thread tools.
export { TOOL_CANCEL_NAME, TOOL_CANCEL_METADATA } from '../runtime-tools/toolCancel.tool';
export { ACTION_REQUEST_NAME, ACTION_REQUEST_METADATA } from '../runtime-tools/actionRequest.tool';
export { THREAD_FORK_NAME, THREAD_FORK_METADATA } from '../runtime-tools/threadFork.tool';
export { THREAD_SEND_NAME, THREAD_SEND_METADATA } from '../runtime-tools/threadSend.tool';
export { THREAD_LIST_NAME, THREAD_LIST_METADATA } from '../runtime-tools/threadList.tool';

// The always-registered core set, in the harness's registration order. This is
// also what the server catalogue projects, so the order is part of the contract.
export const coreToolMetadata = (): CoreToolMetadata[] => [
    TOOL_REQUEST_METADATA,
    TOOL_LIST_METADATA,
    TOOL_MANAGE_METADATA,
    TOOL_CREATE_METADATA,
    TODO_MANAGE_METADATA,
    PROFILE_MANAGE_METADATA,
    CHAPTER_MANAGE_METADATA,
    LOCATION_MANAGE_METADATA,
    AGENT_MANAGE_METADATA,
    AGENT_RESULT_METADATA
];
