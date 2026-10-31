// Server catalogue entries for the harness-owned CORE tools (R8).
//
// WHY THIS IS SEPARATE FROM createToolCatalogue()
// ----------------------------------------------
// `createToolCatalogue()` (./index.ts) lists tools a host can call DIRECTLY: no
// harness, no model, no session. The harness-owned core tools are the opposite —
// toolRegistry, toolRequest, todoManage, profileManage, chapterManage,
// locationManage, agentManage, agentResult, agentDelegate, actionRequest,
// threadFork only mean something inside one session's harness, because they mutate
// that harness's registry, enabled set, todo list, record stores, or agent
// team/result registry (or need that session's owner/fork configuration). Adding
// them there would make the CLI promise a callable tool it cannot run.
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
// DERIVED FROM THE DESCRIPTOR MANIFEST (T21)
// ------------------------------------------
// This module used to import a hand-written list of metadata constants
// (TOOL_REGISTRY_METADATA, coreToolMetadata(), agentDelegateMetadata(),
// ACTION_REQUEST_METADATA, THREAD_FORK_METADATA). That list was a second inventory
// of the runtime entries and had to be edited whenever one was added.
//
// The rows are now DERIVED from the generated descriptor manifest: every descriptor
// whose group is 'runtime' and which is advertised (`listed !== false`) is a
// harness-owned, session-bound catalogue entry, in descriptor order. Metadata comes
// from the same generated copy the runtime registration reads, so a descriptor can
// never advertise a name, description, tags, or schema the runtime does not use.
//
// Order is the descriptor `order` (the scan's registration order). The generated
// manifest is responsible for emitting it in the kernel's registration order
// (toolRegistry first, then the always-declared set, then the conditional tools);
// that is what keeps the Tools tab stable.
//
// Cross-references:
//   - ./types.ts            — CatalogueEntry (sessionBound), ToolGroup ('Core tools')
//   - ../../tools/descriptors — RUNTIME_DESCRIPTORS (the generated projection)
//   - ../api.ts      — compose + session-bound call routing
//   - ../sessions.ts — SessionStore.callTool → harness.executeTool

import { RUNTIME_DESCRIPTORS } from '../../tools/descriptors';
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

// Build the core entries from the generated runtime descriptors, in descriptor
// order. Every row is session-bound by definition (see the header), so the flag is
// set here rather than being read off the descriptor: the descriptor says the tool
// lives in the runtime group, and the SERVER's rule is that the whole group needs a
// session.
export const createCoreToolEntries = (): CatalogueEntry[] =>
    RUNTIME_DESCRIPTORS.map((descriptor) => ({
        name: descriptor.metadata.name,
        group: CORE_TOOL_GROUP,
        // No `tool`: the session's harness owns the implementation (see header).
        description: descriptor.metadata.description,
        tags: [...descriptor.metadata.tags],
        // Marked exactly as the harness declares it: core, not searchable. The
        // Tools tab can therefore separate "always declared" from "discovered".
        visibility: descriptor.metadata.visibility ?? 'core',
        parameters: descriptor.metadata.parameters,
        sessionBound: true,
        availability: { state: 'available', hint: CORE_TOOL_SESSION_HINT }
    }));
