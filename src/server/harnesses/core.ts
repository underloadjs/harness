// Server catalogue entries for the harness-owned CORE tools (R8).
//
// WHY THIS IS SEPARATE FROM createToolCatalogue()
// ----------------------------------------------
// `createToolCatalogue()` (./index.ts) lists tools a host can call DIRECTLY: no
// harness, no model, no session. The harness-owned core tools are the opposite —
// toolRequest, toolCreate, todoManage, profileManage, chapterManage, locationManage,
// and agentDelegate only mean something inside one session's harness, because they
// mutate that harness's enabled set, registry, todo list, record stores, or agent
// team. Adding them there would make the CLI promise a callable tool it cannot run.
//
// R18: the four core FILE tools (fileRead/fileWrite/fileEdit/fileGlob) and a
// configured webSearch are also `visibility: 'core'`, but they are NOT listed
// here and NOT sessionBound: they have real standalone implementations, so they
// stay in createToolCatalogue()'s direct-call path and run without a sessionId.
// "Core" means always declared; only this harness-owned set means "needs a
// session".
//
// The server, however, must LIST them: the UI's Tools tab shows every tool
// (core included) for review and manual execution, and all execution happens
// server-side. So the API composes `[...coreEntries, ...catalogue.entries]` and
// marks these entries `sessionBound`, which is how `POST /tools/:name` knows to
// require a `sessionId` and forward the call to `harness.executeTool`.
//
// NO DUMMY IMPLEMENTATIONS: every entry here has `tool: undefined` on purpose.
// There is exactly one implementation of each harness-owned core tool — the one
// the harness registers for the session — and the server reaches it through the
// session.
//
// Metadata comes from ../../src/core/metadata.ts, the same copy the harness
// registration reads, so a descriptor cannot advertise a name, description, tags,
// or schema the runtime does not use.
//
// Cross-references:
//   - ./types.ts            — CatalogueEntry (sessionBound), ToolGroup ('Core tools')
//   - ../src/core/metadata  — the single source of the core metadata
//   - ../api.ts      — compose + session-bound call routing
//   - ../sessions.ts — SessionStore.callTool → harness.executeTool

import { agentDelegateMetadata, coreToolMetadata } from '../../core/metadata';
import type { CatalogueEntry } from './types';

// The display group for the core set. A distinct group (rather than 'Harness
// tools') tells a user these tools are not directly callable: they run against a
// selected session.
export const CORE_TOOL_GROUP = 'Core tools' as const;

// The hint a client can print verbatim. It states the one thing that is different
// about these entries — they need a session — without promising availability in a
// particular session (agentDelegate, for example, exists only where the harness
// allows subagents).
export const CORE_TOOL_SESSION_HINT =
    'Runs inside a session harness: send a sessionId with the call.';

// Build the core entries: the six always-registered harness tools from
// coreToolMetadata(), then agentDelegate. `agentDelegate` is always listed, with
// generic metadata: the catalogue is host-wide, while whether agentDelegate is
// registered is a property of the selected session's harness. A session without
// subagents answers a clear 404 rather than inventing a subagent.
export const createCoreToolEntries = (): CatalogueEntry[] =>
    [...coreToolMetadata(), agentDelegateMetadata()].map((metadata) => ({
        name: metadata.name,
        group: CORE_TOOL_GROUP,
        // No `tool`: the session's harness owns the implementation (see header).
        description: metadata.description,
        tags: [...metadata.tags],
        // Marked exactly as the harness declares it: core, not searchable. The
        // Tools tab can therefore separate "always declared" from "discovered".
        visibility: metadata.visibility,
        parameters: metadata.parameters,
        sessionBound: true,
        availability: { state: 'available', hint: CORE_TOOL_SESSION_HINT }
    }));
