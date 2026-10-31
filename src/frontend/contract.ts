// Browser-side contract accessors.
//
// The frontend imports wire types from `../../server/protocol` (type-only, so
// the browser never loads server code). This module is the one place that turns
// those records into the values the UI renders, with a documented fallback for a
// server that predates a field:
//
//   - descriptor extensions (primary/subagents/builtin/editable/coreTools);
//   - session freezing (`harnessDefinition`);
//   - per-turn timings (`eventTimes`) and per-frame `at`;
//   - `tool_result.callId`;
//   - concurrent-tool fields (`toolResult.durationMs`, `pending`, `wakeup`);
//   - interactive action requests/answers and fork/autoanswer branch events (N3);
//   - legacy harness aliases for the sessions filter.
//
// Every accessor has to be safe on an older payload: a missing field must degrade
// to something truthful, never to NaN or to a fabricated duration.

import type {
    AgentDescriptor,
    HarnessDescriptor,
    HarnessEvent,
    HarnessThread,
    HarnessUsage,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../server/protocol';
// N3 interaction/branch wire shapes live in the shared type barrel. They are read
// structurally below so a server that predates them (or a malformed frame) cannot
// make the transcript throw; the canonical types only anchor the return values.
import type {
    HarnessActionAnswer,
    HarnessActionChoice,
    HarnessActionRequest
} from '../types';

// Legacy fallback: the harness-owned core tools an OLD server (no `coreTools`)
// declared. R21.2 removed the right-rail core dropdown and the tool catalogue that
// used this list, so the UI no longer derives a core set at all: the Tools tab
// renders the server's complete catalogue, core entries included. The constants are
// kept (exported for callers that only need the historical names) but nothing in
// the shell renders them.
//
// T14 discovery upgrade: the wire inventory is toolRequest / toolList / toolManage /
// toolCreate / todoManage (see src/tools/runtime/*.tool.ts and
// src/harness.metadata.test.ts), so the fallback lists them in that order. A
// pre-T14 server only ever declared the old three names; listing the new pair here
// is what keeps an old payload's derived core set matching today's catalogue.
export const HARNESS_CORE_TOOL_NAMES = [
    'toolRequest',
    'toolList',
    'toolManage',
    'toolCreate',
    'todoManage'
] as const;

// One-line explanations for the historical core set. Retained as documentation
// data; no UI location lists core tools any more (R21.2). The toolList/toolManage
// lines summarize the canonical descriptions in src/tools/runtime/toolList.tool.ts
// and src/tools/runtime/toolManage.tool.ts (that module is authoritative; these are
// only the one-line form kept here for callers that render a hint).
export const HARNESS_CORE_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
    toolRequest: 'Find tools by capability tag and enable them for this chat.',
    toolList: 'List every registered tool by name and description.',
    toolManage: 'Inspect and edit registered tools: details, source, path, create, update, reload.',
    toolCreate: 'Add a small session-local tool when the catalogue cannot help.',
    todoManage: 'Keep a task list for the current work.',
    agentDelegate: 'Hand a self-contained task to one of this harness’s agents.',
    fileRead: 'Read one or more text files on the server host.',
    fileWrite: 'Write one or more text files on the server host.',
    fileEdit: 'Replace exact text in one or more files on the server host.',
    fileGlob: 'Find files by glob, or search their contents, in one call.',
    webSearch: 'Search the web when the host configured a provider key.'
};

const descriptorsOf = (descriptor: HarnessDescriptor): readonly string[] =>
    Array.isArray(descriptor.agents) ? descriptor.agents : [];

// The entry agent. The contract makes `primary` explicit; an older descriptor is
// interpreted the documented way — first declared agent, else the harness name.
export const primaryOf = (descriptor: HarnessDescriptor): string => {
    const primary = descriptor.primary;
    if (typeof primary === 'string' && primary.trim().length > 0) return primary;

    return descriptorsOf(descriptor)[0] ?? descriptor.name;
};

// Agents the primary may delegate to. The server's list wins; the fallback is
// "every agent except the primary", which is what the harness does when
// `subagents` is omitted.
export const subagentsOf = (descriptor: HarnessDescriptor): string[] => {
    const primary = primaryOf(descriptor);

    const listed = Array.isArray(descriptor.subagents)
        ? descriptor.subagents.filter((name): name is string => typeof name === 'string')
        : descriptorsOf(descriptor);

    return uniqueNames(listed.filter((name) => name !== primary));
};

// The complete team in display order: primary first, then secondaries.
export const membersOf = (descriptor: HarnessDescriptor): string[] => {
    const primary = primaryOf(descriptor);
    return [primary, ...subagentsOf(descriptor).filter((name) => name !== primary)];
};

// Deduplicate while preserving order. Used for every request body so a repeated
// member can never be sent to the server.
export const uniqueNames = (names: readonly string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const name of names) {
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        result.push(name);
    }

    return result;
};

// R21.1: EVERY harness is editable. The wire's `editable` flag is legacy metadata
// (the old server marked the demo/flaky fixtures `false`), and the UI deliberately
// ignores it rather than disabling a card: the backend now accepts PATCH for every
// built-in preset, including those fixtures, so a stored `false` describes an old
// server, not a real restriction. A harness that really cannot be patched reports
// its refusal through PATCH (main.ts shows the server's message); the UI must not
// pre-emptively claim a read-only state that no longer exists.
//
// Kept as a function (rather than deleting the accessor and its call sites) so the
// distinction between "editing a harness" and "editing the team of a saved
// session" (main.ts `renderAgents`) stays explicit.
export const editableOf = (_descriptor: HarnessDescriptor): boolean => true;

export const builtinOf = (descriptor: HarnessDescriptor): boolean => descriptor.builtin === true;

// Core tools for the dropdown. R18: the SERVER's `coreTools` is authoritative —
// it already contains the four file tools, a configured webSearch, and
// agentDelegate when applicable — so the UI reflects catalogue/runtime visibility
// instead of hard-coding the harness-owned names. Only an older payload without
// the field falls back to the legacy harness-owned list (adding delegate when the
// local team has a second member).
export const coreToolsOf = (descriptor: HarnessDescriptor, memberCount: number): string[] => {
    if (Array.isArray(descriptor.coreTools)) {
        return descriptor.coreTools.filter(
            (name): name is string => typeof name === 'string' && name.length > 0
        );
    }

    return [
        ...HARNESS_CORE_TOOL_NAMES,
        ...(memberCount > 1 ? ['agentDelegate'] : [])
    ];
};

// Per-agent model overrides (`agentModels`), read defensively.
//
// The map is optional and only present when a harness actually overrides a member
// (protocol.ts HarnessDescriptor.agentModels). A member absent from the map uses
// the session's settings model; the dropdown labels that no-override choice with
// the resolved id (R18), never the word "inherit". Values are model ids only: no
// provider or credential ever travels here.
//
// The same accessor reads a SessionSnapshot's effective map: the server freezes it
// at creation with every member present, so a reload can render each agent's model
// without knowing the creation settings.
export const agentModelsOf = (source: {
    agentModels?: Record<string, string>;
}): Record<string, string> => {
    const map = source.agentModels;
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return {};

    const result: Record<string, string> = {};
    for (const [name, model] of Object.entries(map)) {
        // Empty ids mean "no override" and must not become a model option.
        if (typeof model === 'string' && model.length > 0) result[name] = model;
    }

    return result;
};

// Filter an override map down to a member list, preserving member order. Used for
// every PATCH: the server REPLACES its map with what it receives, so the browser
// must send the complete current map and let a removed member's key drop out.
export const modelsForMembers = (
    models: Readonly<Record<string, string>>,
    members: readonly string[]
): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const member of members) {
        const model = models[member];
        if (typeof model === 'string' && model.length > 0) result[member] = model;
    }

    return result;
};

// A session may freeze the definition it started with (`harnessDefinition`). The
// frontend renders that descriptor, never the live one, so an edited harness
// cannot rewrite a conversation that is already on screen.
export const frozenDefinitionOf = (session: SessionSnapshot): HarnessDescriptor | undefined => {
    const frozen = session.harnessDefinition;
    if (frozen === null || typeof frozen !== 'object') return undefined;

    return typeof frozen.name === 'string' && frozen.name.length > 0 ? frozen : undefined;
};

// Recorded event timestamps, aligned 1:1 with `events`. A missing/partial array
// means "older server": callers must degrade rather than compute NaN.
export const eventTimesOf = (turn: SessionTurn): (number | undefined)[] | undefined => {
    const times = turn.eventTimes;
    if (!Array.isArray(times) || times.length === 0) return undefined;

    return times.map((value) => finiteOf(value));
};

// SSE event frames may carry the server clock (`at`) for the event. Optional on
// purpose: a legacy server sends frames without it.
export const frameAtOf = (item: SessionStreamItem): number | undefined => {
    if (item.type !== 'event') return undefined;
    return finiteOf(item.at);
};

// Validate one token tally from the wire — a turn record's `usage` or a stream
// frame's `usage`. All three required counts must be finite; a partially malformed
// block resolves to undefined so the header hides instead of printing "NaN" or a
// half-sum. `cached` is kept only when it is a real number (absent means "the
// provider never reported a cache figure", which the label renders without
// brackets).
export const usageOf = (value: unknown): HarnessUsage | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const candidate = value as { input?: unknown; output?: unknown; total?: unknown; cached?: unknown };
    const input = finiteOf(candidate.input);
    const output = finiteOf(candidate.output);
    const total = finiteOf(candidate.total);

    if (input === undefined || output === undefined || total === undefined) return undefined;

    const cached = finiteOf(candidate.cached);
    return { input, output, total, ...(cached === undefined ? {} : { cached }) };
};

// The running tally attached to an event frame (see protocol.ts SessionStreamItem).
// Undefined for every other frame type and for a server that does not send one, so
// the tile falls back to the recorded turn's `usage` rather than inventing a value.
export const frameUsageOf = (item: SessionStreamItem): HarnessUsage | undefined =>
    item.type === 'event' ? usageOf(item.usage) : undefined;

// `tool_result` may name the call it answers. When present it is the authoritative
// match; name+oldest-first stays as the fallback for an older server.
export const callIdOf = (event: HarnessEvent): string | undefined => {
    if (event.type !== 'tool_result') return undefined;
    return typeof event.callId === 'string' && event.callId.length > 0 ? event.callId : undefined;
};

// --- Invocation threads (frozen runtime contract) ---------------------------
//
// Every HarnessEvent may carry an optional `thread`; the runtime emits it for
// NON-ROOT events only. A child's `start` carries the full record:
//
//   { id, parentId?, callId?, input? }
//
//   - `id`        the invocation id (stable for the whole invocation);
//   - `parentId`  the SPAWNING invocation's id. OMITTED when the parent is the
//                 turn's root invocation (the root has no thread id);
//   - `callId`    the tool call that spawned it (the parent's agentDelegate call);
//   - `input`     the child's prompt.
//
// Subsequent events of the same invocation may carry only `{ id }`, so every
// consumer has to remember the earlier full record (see ui/turns.ts `entryFor`).
// A root invocation emits NO metadata: its shape is exactly the pre-thread one.
//
// This accessor is deliberately structural (`unknown` input): the field is
// additive on the wire, and the browser must keep working against a server that
// predates it (undefined) as well as one that sends a malformed block. Validation
// never throws and never invents a field: a missing/blank id means "no metadata",
// which is what routes the event down the legacy-by-agent path.
//
// The shape is the runtime's canonical `HarnessThread` (server/protocol re-exports
// it) so this module and the wire contract cannot drift; the local alias exists
// only because the frontend barrel already exports the canonical name from other
// modules and a duplicate export would be ambiguous.
export type HarnessThreadInfo = HarnessThread;

export const threadOf = (source: unknown): HarnessThreadInfo | undefined => {
    if (source === null || typeof source !== 'object') return undefined;

    const raw = (source as { thread?: unknown }).thread;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

    const candidate = raw as {
        id?: unknown;
        parentId?: unknown;
        callId?: unknown;
        input?: unknown;
        kind?: unknown;
        branchId?: unknown;
    };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) return undefined;

    const result: HarnessThreadInfo = { id: candidate.id };

    // A self-referencing parent is not ancestry; dropping it keeps the UI's
    // depth walk finite instead of re-parenting a row under itself.
    if (
        typeof candidate.parentId === 'string' &&
        candidate.parentId.length > 0 &&
        candidate.parentId !== candidate.id
    ) {
        result.parentId = candidate.parentId;
    }
    if (typeof candidate.callId === 'string' && candidate.callId.length > 0) result.callId = candidate.callId;
    if (typeof candidate.input === 'string') result.input = candidate.input;

    // N3: what spawned this non-root invocation. Omitted for historical records
    // and hand-written reporters, so it is read only when it is a known kind.
    if (candidate.kind === 'delegation' || candidate.kind === 'fork' || candidate.kind === 'autoanswer') {
        result.kind = candidate.kind;
    }
    if (typeof candidate.branchId === 'string' && candidate.branchId.length > 0) {
        result.branchId = candidate.branchId;
    }

    return result;
};

// --- Interactive action requests (N3) ---------------------------------------
//
// `actionRequest` asks the OWNER a bounded question. The frozen wire shape is:
//
//   request: { requestId, question, recommended, options[], allowCustom: true }
//   choice:  { kind: 'option', optionId } | { kind: 'custom', text }
//   answer:  { requestId, choice, source: 'owner' | 'auto', branchId? }
//
// The UI must never act on a partially-malformed request: a card whose option id
// is not a string could otherwise post a bogus answer. These parsers therefore
// return undefined unless EVERY required field is well-formed, and drop malformed
// optional fields (`description`) instead of failing the whole request. Custom
// text is part of the contract (`allowCustom: true`) and is not a switch a server
// may turn off; a request that omits it is still rendered with custom input.
const actionOptionOf = (value: unknown): HarnessActionRequest['options'][number] | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const candidate = value as { id?: unknown; label?: unknown; description?: unknown };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) return undefined;
    if (typeof candidate.label !== 'string' || candidate.label.length === 0) return undefined;

    return {
        id: candidate.id,
        label: candidate.label,
        ...(typeof candidate.description === 'string' && candidate.description.length > 0
            ? { description: candidate.description }
            : {})
    };
};

export const actionRequestOf = (value: unknown): HarnessActionRequest | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const candidate = value as {
        requestId?: unknown;
        question?: unknown;
        recommended?: unknown;
        options?: unknown;
        allowCustom?: unknown;
    };

    if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0) return undefined;
    if (typeof candidate.question !== 'string' || candidate.question.length === 0) return undefined;
    if (typeof candidate.recommended !== 'string' || candidate.recommended.length === 0) return undefined;
    if (!Array.isArray(candidate.options)) return undefined;

    const options: HarnessActionRequest['options'] = [];
    const seen = new Set<string>();
    for (const raw of candidate.options) {
        const option = actionOptionOf(raw);
        // Duplicate ids would make the radio group ambiguous; keep the first.
        if (option === undefined || seen.has(option.id)) continue;
        seen.add(option.id);
        options.push(option);
    }

    // The frozen contract always allows custom answers. A legacy/malformed frame
    // without the flag is still treated as allowing them (the UI never withholds
    // the free-text path); `false` is not part of the contract and is ignored.
    return {
        requestId: candidate.requestId,
        question: candidate.question,
        recommended: candidate.recommended,
        options,
        allowCustom: true
    };
};

export const actionChoiceOf = (value: unknown): HarnessActionChoice | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const candidate = value as { kind?: unknown; optionId?: unknown; text?: unknown };
    if (candidate.kind === 'option') {
        return typeof candidate.optionId === 'string' && candidate.optionId.length > 0
            ? { kind: 'option', optionId: candidate.optionId }
            : undefined;
    }
    if (candidate.kind === 'custom') {
        // Empty custom text is not a usable answer: the submit control stays
        // disabled until the user typed something, and the server rejects it too.
        return typeof candidate.text === 'string' && candidate.text.trim().length > 0
            ? { kind: 'custom', text: candidate.text }
            : undefined;
    }

    return undefined;
};

export const actionAnswerOf = (value: unknown): HarnessActionAnswer | undefined => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const candidate = value as {
        requestId?: unknown;
        choice?: unknown;
        source?: unknown;
        branchId?: unknown;
    };

    if (typeof candidate.requestId !== 'string' || candidate.requestId.length === 0) return undefined;
    if (candidate.source !== 'owner' && candidate.source !== 'auto') return undefined;

    const choice = actionChoiceOf(candidate.choice);
    if (choice === undefined) return undefined;

    return {
        requestId: candidate.requestId,
        choice,
        source: candidate.source,
        ...(typeof candidate.branchId === 'string' && candidate.branchId.length > 0
            ? { branchId: candidate.branchId }
            : {})
    };
};

// The whole `action_request` frame, validated. A frame that lacks the agent/call
// identity is not routable (we cannot attribute the card), so it is dropped rather
// than guessed at.
export const actionRequestEventOf = (
    event: HarnessEvent
): Extract<HarnessEvent, { type: 'action_request' }> | undefined => {
    if (event.type !== 'action_request') return undefined;
    if (typeof event.agent !== 'string' || event.agent.length === 0) return undefined;
    if (typeof event.callId !== 'string' || event.callId.length === 0) return undefined;

    const request = actionRequestOf(event.request);
    if (request === undefined) return undefined;

    return { ...event, request };
};

export const actionAnswerEventOf = (
    event: HarnessEvent
): Extract<HarnessEvent, { type: 'action_answer' }> | undefined => {
    if (event.type !== 'action_answer') return undefined;
    if (typeof event.agent !== 'string' || event.agent.length === 0) return undefined;
    if (typeof event.requestId !== 'string' || event.requestId.length === 0) return undefined;

    const answer = actionAnswerOf(event.answer);
    if (answer === undefined) return undefined;
    // The envelope and the frame must name the SAME request; a frame that answers
    // a different one is malformed and would resolve the wrong card.
    if (answer.requestId !== event.requestId) return undefined;

    return { ...event, answer };
};

// --- Fork / autoanswer branches (N3) ---------------------------------------
//
// A branch run is a NON-ROOT invocation with `thread.kind` = 'fork' | 'autoanswer'
// and a `branchId`. The two branch events summarize its lifecycle:
//
//   branch_start { agent, branch: HarnessBranchSummary, thread? }
//   branch_end   { agent, branchId, status: completed|failed|cancelled, error?, thread? }
//
// A malformed summary has no identity or unknown kind, so it cannot be rendered
// as a real row; returning undefined leaves the transcript and activity unchanged.
export const branchStartEventOf = (
    event: HarnessEvent
): Extract<HarnessEvent, { type: 'branch_start' }> | undefined => {
    if (event.type !== 'branch_start') return undefined;
    if (typeof event.agent !== 'string' || event.agent.length === 0) return undefined;

    const branch = event.branch;
    if (branch === null || typeof branch !== 'object') return undefined;
    if (typeof branch.branchId !== 'string' || branch.branchId.length === 0) return undefined;
    if (branch.kind !== 'fork' && branch.kind !== 'autoanswer') return undefined;
    if (typeof branch.agent !== 'string' || branch.agent.length === 0) return undefined;
    if (branch.role !== 'primary' && branch.role !== 'subagent') return undefined;
    if (!Number.isFinite(branch.forkDepth) || branch.forkDepth < 0) return undefined;
    if (typeof branch.model !== 'string') return undefined;
    if (!Array.isArray(branch.tools)) return undefined;

    return event;
};

export const branchEndEventOf = (
    event: HarnessEvent
): Extract<HarnessEvent, { type: 'branch_end' }> | undefined => {
    if (event.type !== 'branch_end') return undefined;
    if (typeof event.agent !== 'string' || event.agent.length === 0) return undefined;
    if (typeof event.branchId !== 'string' || event.branchId.length === 0) return undefined;
    if (event.status !== 'completed' && event.status !== 'failed' && event.status !== 'cancelled') {
        return undefined;
    }

    return event;
};

export const finiteOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// --- Concurrent / background tool execution (R6) -----------------------------
//
// The runtime runs tools concurrently with one serialized model stream per agent:
// an agent's response can complete while its own tool calls are still in flight,
// and a periodic wake brings it back once outcomes land. The wire contract is:
//
//   - `tool_result.durationMs` — the authoritative span of the call that just
//     ended (a call that waited behind other work must not be timed in the
//     browser);
//   - `tool_result.pending` / `done.pending` — calls STILL running at the moment
//     the frame was produced, with their elapsed spans. The runtime OMITS the
//     field when nothing remains, so absence is "no new information", not "the
//     queue drained".
//   - `{ type: 'wakeup', agent, reason: 'pending-tools', pending }` — the agent
//     resumed because pending work progressed. `pending` is REQUIRED: a frame
//     without it is malformed and must produce no update.
//
// The canonical members live in src/types/index.ts. The two names below are
// DERIVED from the event union rather than restated, so this module can never
// drift from the wire contract; `HarnessPendingTool` keeps its public name because
// the frontend barrel exports it.
export type HarnessPendingTool = NonNullable<
    Extract<HarnessEvent, { type: 'tool_result' }>['pending']
>[number];

// The wakeup frame itself (canonical member of the union).
export type HarnessWakeupEvent = Extract<HarnessEvent, { type: 'wakeup' }>;

// Validate a `pending` array. `undefined` means the FIELD WAS ABSENT (older
// persisted turn, or a frame that reports nothing new) and is deliberately distinct
// from `[]` ("the server reports nothing running"): only presence may replace the
// UI's pending snapshot. Invalid entries are dropped one by one; malformed input
// never throws.
const pendingListOf = (value: unknown): HarnessPendingTool[] | undefined => {
    if (!Array.isArray(value)) return undefined;

    const result: HarnessPendingTool[] = [];
    for (const item of value) {
        if (item === null || typeof item !== 'object') continue;

        const candidate = item as { callId?: unknown; name?: unknown; elapsedMs?: unknown };
        if (typeof candidate.callId !== 'string' || candidate.callId.length === 0) continue;
        if (typeof candidate.name !== 'string' || candidate.name.length === 0) continue;

        const elapsed = finiteOf(candidate.elapsedMs);
        // A negative or non-finite span is not a duration: drop the entry rather
        // than render "NaN" or a fabricated negative.
        if (elapsed === undefined || elapsed < 0) continue;

        result.push({ callId: candidate.callId, name: candidate.name, elapsedMs: elapsed });
    }

    return result;
};

// Calls still running per a `tool_result` or `done` frame. Undefined when the
// frame has no `pending` field at all.
export const pendingOf = (event: HarnessEvent): HarnessPendingTool[] | undefined => {
    if (event.type !== 'tool_result' && event.type !== 'done') return undefined;
    return pendingListOf(event.pending);
};

// Authoritative duration for the `tool_result` that just arrived, if the server
// measured one. Prefer it over the browser's local span (see ui/turns.ts).
export const toolDurationOf = (event: HarnessEvent): number | undefined => {
    if (event.type !== 'tool_result') return undefined;

    const duration = finiteOf(event.durationMs);
    return duration === undefined || duration < 0 ? undefined : duration;
};

// The wakeup frame, or undefined for every other event type. A frame whose
// `pending` is missing — or is a non-empty array with no valid entry — is
// MALFORMED and returns undefined (no update). It must never be normalised to an
// empty list: that would clear the pending line and claim "everything settled",
// which the frame never said.
export const wakeupOf = (event: HarnessEvent): HarnessWakeupEvent | undefined => {
    if (event.type !== 'wakeup') return undefined;
    if (event.agent.length === 0) return undefined;
    if (!Array.isArray(event.pending)) return undefined;

    const pending = pendingListOf(event.pending);
    if (pending === undefined) return undefined;
    if (event.pending.length > 0 && pending.length === 0) return undefined;

    return { type: 'wakeup', agent: event.agent, reason: event.reason, pending };
};

// Agent presets from descriptor data, for an older server with no agents list.
// The seed is intentionally minimal: the picker still works, and the detail panel
// says the server did not advertise an instruction.
export const agentsFromDescriptors = (
    descriptors: readonly HarnessDescriptor[]
): AgentDescriptor[] => {
    const byName = new Map<string, AgentDescriptor>();

    for (const descriptor of descriptors) {
        for (const name of descriptorsOf(descriptor)) {
            if (byName.has(name)) continue;

            byName.set(name, {
                name,
                title: name,
                description: 'This server does not advertise agent details.',
                instruction: '',
                guidelines: []
            });
        }
    }

    return [...byName.values()];
};

// Harness names the catalogue used historically. Sessions recorded under an alias
// still belong to the canonical harness, which is what the sessions rail filters
// by. Keep in sync with src/harnesses/index.ts PRESET_ALIASES.
const HARNESS_ALIASES: Readonly<Record<string, string>> = {
    writer: 'instruct',
    assistant: 'instruct',
    researcher: 'research'
};

// Resolve a session's harness to the canonical descriptor name. Unknown names are
// returned unchanged so a row for a harness this page cannot see is filtered out
// rather than silently attributed to the selected one.
export const canonicalHarnessName = (
    name: string,
    descriptors: readonly HarnessDescriptor[]
): string => {
    if (descriptors.some((descriptor) => descriptor.name === name)) return name;

    const alias = HARNESS_ALIASES[name];
    if (alias !== undefined && descriptors.some((descriptor) => descriptor.name === alias)) return alias;

    return name;
};
