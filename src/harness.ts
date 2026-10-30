// harness() — the execution loop.
//
// One call builds a callable writer:
//
//     const writer = harness({
//         agents: { writer: agent({ model, provider }) },
//         tools: { webSearch: tool({ ... }) },
//         report: { progress: async (event) => console.log(event) }
//     });
//
//     await writer('tell me about new year');
//
// Calling the harness runs the entry agent until it answers with text. Along the
// way it executes every tool the model asks for, feeds the results back, and
// re-requests — the loop a caller would otherwise write by hand against
// `agent.turn()`.
//
// Loop shape, per call:
//
//     append user input
//     repeat:
//         turn()                      -> assistant message (+ tool calls)
//         usage?                      -> report what that request spent
//         no tool calls?              -> pending work? pause : report done and return
//         for each call:              -> LAUNCH it (validation is synchronous,
//                                        execution is background/concurrent)
//         (loop again immediately, with placeholders for unfinished calls)
//
// Calls complete on their own schedule. Every completion is committed at the
// call's ORIGINAL position in the transcript and wakes the run for another turn;
// a pause (`done` with `pending`) keeps the harness promise open until the whole
// tree drains. See the "Background tool scheduling" block below for the protocol.
//
// Termination:
//   - the model answers with text (normal);
//   - an unknown tool, an undiscovered tool, malformed arguments, or a throwing
//     tool becomes a tool result the model can read and recover from — it does
//     not end the run;
//   - exceeding the configured model-request limit (`maxIterations`, default
//     DEFAULT_MAX_ITERATIONS) — every turn counts, including pauses with pending
//     work and wake-driven turns — or a transport failure ends the run: history is
//     truncated back to where the call started and the harness throws.
//
// Tool visibility:
//
// A registry can hold thousands of tools, so a request declares only:
//   - every `visibility: 'core'` tool, and
//   - every searchable tool that toolRequest has enabled so far.
//
// Core vs searchable (R18): the everyday file tools (fileRead, fileWrite,
// fileEdit, fileGlob) carry `visibility: 'core'` in the preset catalogue, and a
// configured webSearch is core too, so they are declared up front. The rest of the
// preset catalogue — fileList, syntaxCheck, commandRun, gitDiff, the app tools —
// stays searchable. "core" is only a declaration classification: it does NOT make
// the tool session-bound. The harness-owned tools below are the session-bound set,
// and the server gates only those on a sessionId.
//
// toolRequest is itself core and is always registered here. It ranks the catalogue
// against the tags the model passes (core/discovery), enables the best matches,
// and the next request declares them. Ranking is OR-style — a tool needs only one
// query tag to be a candidate, and its rank is its best single-tag score — so the
// order is deterministic and a broad tool cannot outrank an exact tag hit.
// Matches are capped at MAX_DISCOVERY_MATCHES (5) per request (R7): the model may
// pass a SMALLER `limit`, never a larger one, and the result reports `remaining`
// — the count of additional tools that matched but were not listed. Refining the
// tags is the main way to drill deeper, and (R12) repeating the SAME query
// advances to the next capped tranche: the harness tracks an offset per identical
// query (normalized tags + limit), so the omitted tail is reachable instead of the
// cap being a stationary dead end. `remaining` always counts the matches still
// unseen AFTER the returned page. Undiscovered tools are not callable, so the model
// cannot skip discovery by guessing a name. The enabled set is per harness and
// survives across calls (turns), so a capability discovered once stays declared
// until reset().
//
// A query that names an already-declared CORE capability is answered too: the
// result's `alreadyAvailable` lists those tools (metadata only) so the model does
// not conclude "no match" for something it can call directly, and such a tag is not
// reported in `unmatchedTags`. Nothing is enabled for them and the 5-match budget
// is untouched. The list is the caller's own view: a subagent never sees
// agentDelegate there, and a harness without subagents never has it to report.
//
// Harness-owned names sit outside that scheme:
//   - toolRequest  — discovery, described above.     (every agent, core)
//   - toolCreate   — compile-and-register a tool.    (every agent, core)
//   - todoManage   — the session todo list.          (every agent, core)
//   - profileManage — session character profiles.    (every agent, core)
//   - chapterManage — session chapter tracking.      (every agent, core)
//   - locationManage — session places/settings.      (every agent, core)
//   - agentManage  — list agents and result previews.(every agent, core)
//   - agentResult  — read one completed result.       (every agent, core)
//   - agentDelegate — hand a task to a subagent.     (primary agent only, core)
//   - threadSend   — post a message into another thread. (every agent, core,
//                    registered once this session owns an independent thread)
//   - threadList   — list this session's live conversations and ids. (same
//                    condition; registered with threadSend so ids are observed,
//                    never invented by the model or injected by the server)
//
// TERMINOLOGY (R1). Three levels, kept deliberately distinct:
//   - HARNESS — this factory and the execution loop. It provides callable agents.
//   - SESSION — server-controlled shared memory: one harness instance plus the
//     record stores, agent results, and snapshot/restore.
//   - THREAD  — one persistent, agent-owned conversation with a stable id and its
//     own transcript.
// Every configured agent owns a DEFAULT thread (`agent:<name>`) whose transcript
// is the registry Agent's history, which is what keeps delegation's historical
// accumulation. `harness.createThread(agent)` opens an ADDITIONAL independent
// conversation (a fresh Agent with the same instructions/transport/model), so two
// threads of one agent run CONCURRENTLY while sharing this session's tools and
// stores. A delegation/ctx.run child OF A HOST THREAD becomes its own host
// conversation (own id/transcript, ownerThreadId = caller) instead of reusing the
// child agent's default conversation, so concurrent siblings never mix and every
// child is addressable/stopped/deleted through the same host API. A host thread
// re-reads its owning agent's model at each run start, so a model change reaches
// every live thread of that agent on its next run.
// Thread runs are serialized per thread and never overlap inside one
// thread; `sendThreadInput` resumes, `steerThread` queues guidance for the next
// safe model boundary, `stopThread`/`stopAllThreads` abort (cascading to owned
// children), and `deleteThread` purges a terminal host conversation plus its
// invocation/branch lookups without pretending to erase what other histories
// already learned from it (its invocation results and every branch materialized
// from it go with it). `threadSend` lets an agent post into another thread
// (sender identity is runtime-derived, so it cannot be spoofed) and its paired
// `threadList` roster exposes the live ids of this session only.
//
// Ownership and stop invariants (review corrections): only a HOST thread may own
// another thread (`agent:<name>` is implicit and cannot be persisted as an owner);
// a stop invalidates every host turn already queued on the conversation (the stop
// epoch is captured at submission), so only a NEW host send revives it; steering
// drained into a run that fails for a non-stop reason is re-queued for the next
// host turn instead of being lost.
//
// toolCreate is the R2b capability: the model can author a JavaScript tool body
// mid-conversation, and the tool is registered searchable and enabled at once. The
// source is compiled but never executed at registration. There is NO sandbox: a
// created tool runs with this process's permissions, the same trust model as the
// commandRun preset. See core/creation.ts for the validated bounds.
//
// Tool creation is additionally bounded by policy and budget (R12):
//   - `toolCreation` is 'all' (default), 'primary' (the tool is not declared to
//     subagents and a guessed call is rejected), or false (no model-facing tool at
//     all; the host's `harness.createTool` still works);
//   - `maxCreatedTools` (default 32) is a LIFETIME budget per harness: reset()
//     does not restore it, because created tools stay registered across a reset.
//
// Cancellation (R10, T3): `HarnessRunOptions.signal` reaches every model request,
// every tool's `ToolContext.signal`, and every run a tool or agentDelegate starts.
// Tools now run in the BACKGROUND with a per-call AbortController linked to the
// run signal: cancelling the run aborts all of them, while the model's `toolCancel`
// aborts exactly one. The harness releases a cancelled call LOGICALLY at once
// (removes it from the pending view, discards a late result) because arbitrary
// JavaScript cannot be preempted; a cooperative tool stops its own work, an
// uncooperative one may finish in the background with nobody listening. A run
// abort rolls back every actor's transcript to the start of its call and leaves
// the harness reusable.
//
// Model turns are preemptive too (T15): the turn consumer races the run signal, so
// a provider that never returns cannot keep the agent's actor, its active-run slot,
// or later same-agent delegation reserved. The abandoned stream is detached; the
// agent's precommit guard refuses any late commit and the ownership guard suppresses
// its frames, so it cannot touch a later run's transcript (arbitrary provider work
// may still exist; it is logically ignored, like an aborted tool).
//
// Background tools (T3): every call is launched CONCURRENTLY and the run keeps
// going. Tool validation stays synchronous (an unknown/undiscovered/malformed
// call is still an immediate result), but execution is scheduled. Until a call
// settles, the request projection answers it with a placeholder and the model may
// answer, call more tools, or pause (`done` with `pending`). Each completion is
// committed at the call's ORIGINAL position and drives another turn. The harness
// promise resolves only when the model has answered AND the whole tree (delegated
// children included) has drained. A `wakeup` heartbeat (default every 600000 ms)
// re-requests a paused agent so it can inspect elapsed times and cancel a hung
// call through the `toolCancel` control. Scheduler: core/scheduler.ts.
//
// Model-facing output cap (R10): every serialized tool result AND tool error is
// passed through `boundToolResult` (64 KiB UTF-8 by default, core/result-budget.ts).
// Small outputs are byte-exact; a large one becomes a small, valid JSON truncation
// envelope. The cap is post-serialization, so it bounds conversation cost, not the
// process's peak memory; UI panels are bounded separately (core/tool-ui.ts).
//
// Arguments (R11): the model's JSON is validated against the tool's schema before
// `execute` sees it (core/schema-validation.ts), then unwrapped by the
// single-property rule. The manual `executeTool` path validates identically and
// also accepts the legacy already-unwrapped direct-call form.
//
// Manual execution (R8): `harness.executeTool(name, parameters)` runs one
// REGISTERED tool directly, with this harness's context. It is the host/server path
// behind the UI's Tools tab (server/sessions.ts → executeTool), so a manual
// toolRequest/toolCreate/todoManage/agentDelegate call changes this session rather
// than a detached copy. Core file tools (R18) also run here, exactly like a direct
// call; only the harness-owned set needs session state. Discovery gates the model
// only: an explicit user call may run a searchable tool that was never enabled.
// Everything else still applies —
// toolCreate keeps its guarded registration, agentDelegate keeps its primary-only
// check, and a tool this harness did not register (agentDelegate without subagents)
// is an honest error, never a fabricated implementation.
//
// todoManage is session state, not catalogue state: a fresh list is created for
// each harness() call, shared by every agent in that harness, and cleared by
// reset() with the conversation. That is why it is built by a factory closure
// (core/todo.ts) rather than registered as a module singleton. profileManage,
// chapterManage, and locationManage follow the same pattern with their own
// closures (core/profile.ts, chapter.ts, location.ts).
//
// agentDelegate is bounded delegation (R4): `primary` selects the entry agent, and
// `subagents` is the allowlist the primary may delegate to. The tool is not
// declared to subagents (and a guessed call is rejected), so delegation is one
// level deep; re-entering an already-running agent is rejected by runAgent, which
// also closes ctx.run cycles. runAgent additionally enforces MAX_RUN_DEPTH
// centrally (R12), so a created tool that received the whole context and calls
// `context.run` cannot widen the hierarchy either — while the primary's own
// trusted ctx.run (textSummarize) still works at depth 2.
//
// The bundled preset catalogue (./tools) is preloaded into the registry by
// default, so a new harness gets fileRead/fileWrite/fileEdit/fileGlob as declared
// core tools and can discover commandRun/… without the caller importing anything.
// The searchable presets cost no context until discovered. `presets: false` opts
// out.
//
// Cross-references:
//   - core/agent     — the brain being driven (turn())
//   - core/tool      — what gets executed, and where tags/visibility live
//   - core/discovery — the tag ranking behind toolRequest
//   - core/creation  — compile-and-register behind toolCreate
//   - core/todo      — the per-harness todo list behind todoManage
//   - types          — Harness, HarnessEvent, HarnessConfiguration
//
// This is the only source file at the root of src/. Everything else lives in a
// role folder with its own barrel, and the public surface is re-exported at the
// bottom of this file.

import { HarnessError, toErrorInfo } from './util';
import {
    agent as createAgent,
    tool as defineTool,
    searchTools,
    normalizeTags,
    toolUiOf,
    resolveToolParameters,
    boundToolResult,
    DEFAULT_CREATED_TOOLS_LIMIT,
    cloneToolSourceRecord,
    supportsToolCompilation,
    createTodoTool,
    createProfileTool,
    createChapterTool,
    createLocationTool,
    HARNESS_SNAPSHOT_VERSION,
    cloneToolCreation,
    readHarnessMessages,
    readHarnessSnapshot,
    TOOL_CREATE_METADATA,
    TOOL_CREATE_NAME,
    TOOL_REGISTRY_METADATA,
    TOOL_REGISTRY_NAME,
    prepareToolCandidate,
    AGENT_DELEGATE_NAME,
    AGENT_MANAGE_METADATA,
    AGENT_MANAGE_NAME,
    AGENT_MANAGE_LIST_PER_AGENT,
    AGENT_MANAGE_PREVIEW_CHARS,
    AGENT_RESULT_METADATA,
    AGENT_RESULT_NAME,
    AGENT_RESULT_PAGE_CHARS,
    AGENT_RESULT_PAGE_MAX_CHARS,
    AGENT_RESULT_RETENTION,
    TOOL_REQUEST_METADATA,
    TOOL_REQUEST_NAME,
    TODO_MANAGE_NAME,
    PROFILE_MANAGE_NAME,
    CHAPTER_MANAGE_NAME,
    LOCATION_MANAGE_NAME,
    agentDelegateMetadata,
    createTaskScheduler,
    TOOL_CANCEL_METADATA,
    TOOL_CANCEL_NAME,
    // R4 cross-thread chat + R2 thread agents. A host thread is backed by a fresh
    // Agent built from the owner's configuration (core/thread.ts), and the chat
    // tool is registered lazily once the session owns an independent thread.
    THREAD_LIST_METADATA,
    THREAD_LIST_NAME,
    THREAD_SEND_METADATA,
    THREAD_SEND_NAME,
    THREAD_HOST_PREFIX,
    MAX_THREAD_RECORDS,
    createThreadAgent,
    defaultThreadIdOf,
    normalizeThreadLabel,
    // N6 runtime: branch identity/creation, action-request parsing, fork bounds,
    // and the private metadata of the two branch tools.
    ACTION_REQUEST_METADATA,
    ACTION_REQUEST_NAME,
    THREAD_FORK_METADATA,
    THREAD_FORK_NAME,
    MAX_FORK_CONCURRENT,
    MAX_FORK_DEPTH,
    MAX_FORK_HISTORY_BYTES,
    MAX_BRANCH_RECORDS,
    agentBranchOf,
    assertBranchConcurrency,
    forkAgent,
    incorporateBranchHistory,
    normalizeBranchLabel,
    pruneBranchRecords,
    reserveBranchSequence,
    validateActionChoice,
    validateActionRequestParameters
} from './core';
import type { AgentBranchMetadata } from './core';
import { presetTools, createWebSearchTool, WEB_SEARCH_TOOL_NAME, createWebFetchTool, WEB_FETCH_TOOL_NAME } from './tools';
import { runPlugins } from './plugin';
import { validateAttachments } from './shared/attachments';
import type {
    Agent,
    Harness,
    HarnessActionAnswer,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessActionRequestContext,
    HarnessActionResult,
    HarnessAgentSnapshot,
    HarnessAssistantMessage,
    HarnessAttachment,
    HarnessBranchRecord,
    HarnessBranchStatus,
    HarnessBranchSummary,
    HarnessBranchTerminalStatus,
    HarnessConfiguration,
    HarnessDelegationResult,
    HarnessErrorInfo,
    HarnessEvent,
    HarnessForkConfiguration,
    HarnessForkResult,
    HarnessMessage,
    HarnessPendingTool,
    HarnessProgress,
    HarnessRunOptions,
    HarnessSnapshot,
    HarnessStateChangeReason,
    HarnessStreamTool,
    HarnessThread,
    HarnessThreadCreateOptions,
    HarnessThreadMessageResult,
    HarnessThreadRecord,
    HarnessThreadRoster,
    HarnessThreadSteerReceipt,
    HarnessToolCall,
    HarnessToolCallOptions,
    HarnessToolOutcome,
    HarnessToolRegistrationCandidate,
    HarnessToolRegistrationResult,
    HarnessToolSource,
    HarnessMemory,
    HarnessToolRuntime,
    Tool,
    ToolContext,
    ToolCreation,
    ToolCreationPolicy,
    ToolCreationResult,
    ToolSearchResult,
    ToolUiPanel
} from './types';
import type { PreparedTool, ToolSourceRecord } from './core';

// Hard stop for a model that keeps requesting turns forever (tool rounds, pauses
// with pending work, and wake-driven turns all count). This is a guard, not a
// policy knob, so the library default stays deliberately small; a real agent
// session can raise it with `harness({ maxIterations })` (the application presets
// do, see harnesses/presets.ts). A runaway loop must not be able to run a CLI
// process out of money or stack, so `maxIterations` is validated at construction
// (positive safe integer) and can never be Infinity.
const DEFAULT_MAX_ITERATIONS = 16;

// Recurring wake while background tool calls are pending (R4): 10 minutes. This
// is a LIVENESS heartbeat, not a timeout — nothing is killed automatically (the
// model decides, via toolCancel). Configurable through `wakeIntervalMs` so tests
// can exercise it in milliseconds; the timer exists only while work is pending.
const DEFAULT_WAKE_INTERVAL_MS = 600_000;

const resolveWakeInterval = (value: number | undefined): number => {
    if (value === undefined) return DEFAULT_WAKE_INTERVAL_MS;

    if (!Number.isSafeInteger(value) || value < 1) {
        throw new HarnessError(
            `wakeIntervalMs must be a positive safe integer; received ${String(value)}.`
        );
    }

    return value;
};

// Validate and resolve the configured model-request bound. Rejecting anything that is
// not a positive safe integer keeps the guard meaningful: 0 would make every tool
// request fail, 1.5/NaN/Infinity have no well-defined round count, and values
// beyond Number.MAX_SAFE_INTEGER cannot be counted exactly.
const resolveMaxIterations = (value: number | undefined): number => {
    if (value === undefined) return DEFAULT_MAX_ITERATIONS;

    if (!Number.isSafeInteger(value) || value < 1) {
        throw new HarnessError(
            `maxIterations must be a positive safe integer; received ${String(value)}.`
        );
    }

    return value;
};

// Fork/branch configuration, resolved once at construction. The defaults are the
// frozen core bounds (core/branch.ts): forks enabled, depth 2, four live branches,
// 8 MiB of history, 64 retained records. A value that is not a positive safe
// integer is a configuration bug, not something to silently clamp.
const resolveForks = (value: HarnessForkConfiguration | undefined): Required<HarnessForkConfiguration> => {
    const enabled = value?.enabled ?? true;

    if (typeof enabled !== 'boolean') {
        throw new HarnessError(`forks.enabled must be a boolean; received ${String(enabled)}.`);
    }

    const positive = (field: string, candidate: number | undefined, fallback: number): number => {
        if (candidate === undefined) return fallback;

        if (!Number.isSafeInteger(candidate) || candidate < 1) {
            throw new HarnessError(
                `forks.${field} must be a positive safe integer; received ${String(candidate)}.`
            );
        }

        return candidate;
    };

    return {
        enabled,
        maxDepth: positive('maxDepth', value?.maxDepth, MAX_FORK_DEPTH),
        maxConcurrent: positive('maxConcurrent', value?.maxConcurrent, MAX_FORK_CONCURRENT),
        maxHistoryBytes: positive('maxHistoryBytes', value?.maxHistoryBytes, MAX_FORK_HISTORY_BYTES),
        maxBranchRecords: positive('maxBranchRecords', value?.maxBranchRecords, MAX_BRANCH_RECORDS)
    };
};

// At most four actionRequests may be awaiting an owner at once. Beyond that a
// model is not asking a focused question; it is fanning out and should retry
// after an answer. Enforced synchronously at launch, so the bound also covers a
// host handler that never resolves.
const MAX_PENDING_ACTION_REQUESTS = 4;

// A branch is an ephemeral side transcript. Its agent must NOT share the source's
// queue/actor keys, or a fork could deadlock behind the run it was forked from.
// `actorKey` is therefore the runtime scheduling identity: the display name for a
// registered agent, and a namespaced branch id for a branch.
type HarnessActorRole = 'primary' | 'subagent';

const cloneMessages = (messages: readonly HarnessMessage[]): HarnessMessage[] =>
    JSON.parse(JSON.stringify(messages)) as HarnessMessage[];

const cloneBranchRecord = (record: HarnessBranchRecord): HarnessBranchRecord => ({
    ...record,
    toolCallIds: record.toolCallIds.map((entry) => ({ ...entry })),
    messages: cloneMessages(record.messages),
    ...(record.result !== undefined ? { result: { ...record.result } } : {}),
    ...(record.error !== undefined ? { error: { ...record.error } } : {})
});

// Parse + schema-validate one model tool call. Shared by the ordinary launch path
// and the two branch controls, so malformed arguments produce the same error
// wording everywhere. The caller converts a throw into a readable tool result.
const parseToolCallArguments = (
    schema: Record<string, unknown> | undefined,
    call: HarnessToolCall
): unknown => {
    const parsed: unknown = call.arguments.trim().length > 0 ? JSON.parse(call.arguments) : {};
    return resolveToolParameters(schema, parsed, 'model');
};

// The discovery entry point. The harness owns this name: the whole visibility
// scheme depends on there being exactly one tool that can enable the rest.
const TOOL_REQUEST = TOOL_REQUEST_NAME;

// Runtime tool creation (R2b), the session todo list, the session record tools,
// and bounded delegation (R4). All are model-facing core tools, so their wire
// names are part of the harness contract. The names come from core/metadata.ts,
// which the server's tool catalogue also describes — one copy, so a descriptor
// cannot advertise a name the runtime does not register.
const TOOL_CREATE = TOOL_CREATE_NAME;
const TODO_MANAGE = TODO_MANAGE_NAME;
const PROFILE_MANAGE = PROFILE_MANAGE_NAME;
const CHAPTER_MANAGE = CHAPTER_MANAGE_NAME;
const LOCATION_MANAGE = LOCATION_MANAGE_NAME;
// Agent inspection (R3): every agent, including a subagent, may read the
// session's agents and their completed results. Registration order matches
// coreToolMetadata().
const AGENT_MANAGE = AGENT_MANAGE_NAME;
const AGENT_RESULT = AGENT_RESULT_NAME;
const AGENT_DELEGATE = AGENT_DELEGATE_NAME;
// Targeted cancellation for a background call (T3/R4). Declared only while the
// calling agent has work in flight. It is an ordinary registry definition, not a
// reserved name: a replacement drops the control marker and executes normally.
const TOOL_CANCEL = TOOL_CANCEL_NAME;
// N6 branch controls. threadFork is registered whenever forks are enabled
// (default true); actionRequest is registered whenever `interaction` is
// configured. Both are core declarations, but both are RUNTIME-ONLY: the manual
// executeTool path refuses them because a host call has no owning run transcript
// to fork or ask from.
const THREAD_FORK = THREAD_FORK_NAME;
const ACTION_REQUEST = ACTION_REQUEST_NAME;
// R4 cross-thread chat. Registered lazily (the first `createThread`), because a
// session with one conversation per agent has no second thread to talk to and
// must keep its historical declaration list. It remains an ordinary replaceable
// registry entry once present.
const THREAD_SEND = THREAD_SEND_NAME;
// R4 roster: the discoverable source of the ids `threadSend` accepts, so neither a
// model nor the server has to invent or inject them. Registered with threadSend.
const THREAD_LIST = THREAD_LIST_NAME;

// Budget for toolCreate: registration is cheap but not free, and an unbounded
// registry defeats the point of discovery. Session-local (no filesystem writes),
// counted per harness for the LIFETIME of the harness, and configured with
// `maxCreatedTools`. The default lives in core/creation.ts so the constant is
// part of the public surface a host can quote.
const resolveMaxCreatedTools = (value: number | undefined): number => {
    if (value === undefined) return DEFAULT_CREATED_TOOLS_LIMIT;

    if (!Number.isSafeInteger(value) || value < 1) {
        throw new HarnessError(
            `maxCreatedTools must be a positive safe integer; received ${String(value)}.`
        );
    }

    return value;
};

// Who may create tools at runtime (R12). Validated at construction so a typo
// cannot silently disable (or widen) creation.
const CREATION_POLICIES: readonly ToolCreationPolicy[] = ['all', 'primary', false];

const resolveToolCreation = (value: ToolCreationPolicy | undefined): ToolCreationPolicy => {
    if (value === undefined) return 'all';

    if (!CREATION_POLICIES.includes(value)) {
        throw new HarnessError(
            `toolCreation must be one of: "all", "primary", false. Received ${String(value)}.`
        );
    }

    return value;
};

// How deeply agent runs may nest (R12): the entry run, plus at most ONE
// delegation level. Enforced centrally in runAgent so every door — the model's
// agentDelegate tool, `ctx.run`, and a model-created tool that received the whole
// `context` and calls `context.run` — obeys the same rule. Without this, a
// subagent's tool (created or not) could call `run()` on a third agent and turn
// "one level deep" into an unstated hierarchy.
//
// Depth 1 = the run the caller started; depth 2 = a delegated/ctx.run agent. Note
// that a trusted PRIMARY-triggered ctx.run (the bundled textSummarize preset) is
// depth 2 and therefore still allowed — the limit only blocks a run STARTED from
// inside another one at the limit.
const MAX_RUN_DEPTH = 2;

// The wire-safe tool-name alphabet, identical to the shared source-contract gate.
// Definition registrations must satisfy the same name/schema shape as compiled
// source revisions, even though they skip transpilation.
const WIRE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// Tool results are text on the wire. Strings pass through untouched so a tool
// can return prose; everything else is JSON. The model-facing cap is applied by
// boundToolResult at the ONE place a result is committed (see deliverTask).
const serialize = (value: unknown): string => {
    if (value === undefined) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value) ?? String(value);
};

// The single-property rule (see core/tool.ts) plus runtime schema validation
// (R11) now live in core/schema-validation.ts, because the MANUAL path
// (`harness.executeTool`) must resolve arguments identically and must accept the
// already-unwrapped legacy form. The model path always unwraps the wrapper object.


export const harness = (configuration: HarnessConfiguration): Harness => {
    // Resolve the loop bound once, before anything is built, so a bad value fails
    // at construction instead of after a long run. The bound applies to every agent
    // run in this harness (entry, ctx.run, and delegated subagents); each run gets
    // its own budget because the check lives in runAgentCore's loop.
    const maxIterations = resolveMaxIterations(configuration.maxIterations);

    // Background heartbeat interval (T3/R4), validated at construction like every
    // other numeric bound so a typo fails before a run starts.
    const wakeIntervalMs = resolveWakeInterval(configuration.wakeIntervalMs);

    // R12 policy resolved once, at construction: a bad `toolCreation` or
    // `maxCreatedTools` fails here rather than after a run has started spending.
    const toolCreation = resolveToolCreation(configuration.toolCreation);
    const maxCreatedTools = resolveMaxCreatedTools(configuration.maxCreatedTools);

    // N6 fork bounds and owner interaction, both resolved before any run can
    // start. `interaction` presence is what registers actionRequest; `forks`
    // enabled (the default) is what registers threadFork.
    const forks = resolveForks(configuration.forks);
    const interaction = configuration.interaction;

    const agentNames = Object.keys(configuration.agents ?? {});
    if (agentNames.length === 0) {
        throw new HarnessError('A harness requires at least one agent.');
    }

    // Build the agent registry. The registry key is the identity: it names the
    // agent in progress events and is what `run(name, input)` addresses. The
    // agent's own `name` is overwritten so the two can never disagree.
    const agents: Record<string, Agent> = {};
    for (const [name, brain] of Object.entries(configuration.agents)) {
        if (!brain || typeof brain.turn !== 'function') {
            throw new HarnessError(`Agent "${name}" is not an agent: create it with agent({...}).`);
        }

        brain.name = name;
        agents[name] = brain;
    }

    // The entry point. `primary` names it explicitly; without one the first key
    // wins, so a single-agent or naturally ordered config needs no extra field.
    // An unknown name is a configuration bug, not a runtime surprise, so it fails
    // here rather than at the first prompt.
    const primaryName = configuration.primary ?? agentNames[0];

    if (!Object.prototype.hasOwnProperty.call(configuration.agents, primaryName)) {
        throw new HarnessError(
            `Primary agent "${primaryName}" is not registered. Configured agents: ${agentNames.join(', ')}.`
        );
    }

    const primary = agents[primaryName];

    // Runtime role/actor identity (N6). The registry key stays the DISPLAY name
    // used by events and `run(name)`; a branch additionally needs a scheduling
    // identity that is distinct from its source, so a fork never queues behind
    // the run that created it. Both maps are WeakMaps: they add no field to the
    // public Agent shape and disappear with the branch.
    const actorRoles = new WeakMap<Agent, HarnessActorRole>();
    const actorKeys = new WeakMap<Agent, string>();

    // A branch inherits the SOURCE's role (a fork of the primary keeps
    // agentDelegate/toolCreate; a fork of a subagent does not). Registered
    // agents fall back to the registry comparison, so a plugin-added agent is a
    // subagent without extra bookkeeping.
    const roleOf = (brain: Agent): HarnessActorRole =>
        actorRoles.get(brain) ?? (brain === primary ? 'primary' : 'subagent');

    // Scheduler/mailbox/turn-queue identity. `branch:${branchId}` cannot collide
    // with a display name (branch ids are runtime-generated and reserved).
    const actorKeyOf = (brain: Agent): string => {
        const explicit = actorKeys.get(brain);
        if (explicit !== undefined) return explicit;

        const branch = agentBranchOf(brain);
        return branch === undefined ? brain.name : `branch:${branch.branchId}`;
    };

    // Resolve the delegation allowlist once, at construction. `agents` order is no
    // longer the routing decision when one is given explicitly.
    const subagentNames = ((): string[] => {
        const requested = configuration.subagents;

        // Default: every agent except the primary. A one-agent harness therefore
        // has no subagents and gets no agentDelegate tool at all.
        if (requested === undefined) return agentNames.filter((name) => name !== primaryName);

        const resolved: string[] = [];

        for (const name of requested) {
            if (name === primaryName) {
                throw new HarnessError(
                    `Subagent "${name}" is the primary agent "${primaryName}"; the primary cannot delegate to itself.`
                );
            }

            if (!Object.prototype.hasOwnProperty.call(agents, name)) {
                throw new HarnessError(
                    `Subagent "${name}" is not registered. Configured agents: ${agentNames.join(', ')}.`
                );
            }

            // Deduplicate so the allowlist is also the exact tool description.
            if (!resolved.includes(name)) resolved.push(name);
        }

        return resolved;
    })();

    // The allowlisted agents, exposed on the handle so a host can inspect who the
    // primary is allowed to reach.
    const subagents: Record<string, Agent> = {};
    for (const name of subagentNames) subagents[name] = agents[name];

    // The tool registry starts EMPTY. Every entry — the preset catalogue,
    // configured tools, harness-owned controls, plugin contributions, and runtime
    // source revisions — is committed through the one kernel registration
    // operation below. No reserved-name or "already registered" gate exists:
    // later submissions win, including over the harness's own controls.
    const tools: Record<string, Tool> = {};

    // Captured source revisions and persistence records. The registry is the
    // runtime truth; these maps only feed inspection and snapshot()/restore().
    const toolSourceRecords = new Map<string, ToolSourceRecord>();
    const createdToolRecords = new Map<string, ToolCreation>();

    // Definitions whose declaration/execution is role-gated or runtime-special.
    // Keyed by the DEFINITION, not by name: replacing the definition drops the
    // gate, which is what makes built-in/module-facing controls genuinely
    // replaceable instead of bypassing the registry by wire name.
    const primaryOnlyDefinitions = new WeakSet<Tool>();
    const runtimeControlDefinitions = new WeakMap<Tool, 'toolCancel' | 'threadFork' | 'actionRequest'>();
    const pendingOnlyDefinitions = new WeakSet<Tool>();
    // T2/R1 answer extraction belongs to the BASELINE agentDelegate definition.
    // A replacement under the same wire name must behave like an ordinary tool,
    // so both model and manual `context.run` paths key the descriptor on this
    // marker rather than on the call name.
    const delegateAnswerDefinitions = new WeakSet<Tool>();

    // Progress reporting is awaited for every step, so a UI can pace the run.
    const progress: HarnessProgress = async (event: HarnessEvent) => {
        await configuration.report?.progress?.(event);
    };

    // Persistence observer (R3a / T3 addendum). Fires AFTER a mutation a snapshot
    // would record, so a server can save without waiting for session close. It is
    // advisory and synchronous: a throwing callback is swallowed here, because a
    // persistence failure must never turn a completed tool call into a failure or
    // change the run's outcome.
    //
    // snapshot() is safe to call from here even while the run is active (T16):
    // the callback runs on the same thread immediately after the mutation, so the
    // read sees the committed transcript/store state and cannot interleave with
    // another mutation.
    //
    // Call sites cover every mutation the harness itself performs: agent history
    // appends/rollbacks, tool executions (model and manual), host/model tool
    // creation, reset(), and restore(). Direct agent.user()/assistant()/model()
    // calls and direct agent.messages edits happen outside the harness and cannot
    // be observed; see HarnessStateChangeEvent in ./types.
    const notifyStateChange = (
        reason: HarnessStateChangeReason,
        detail: { agent?: string; tool?: string } = {}
    ): void => {
        const observer = configuration.report?.stateChange;
        if (!observer) return;

        try {
            observer({ type: 'state_change', reason, ...detail });
        } catch {
            // Observer failures are not harness failures. The next successful
            // mutation (or a periodic save) will notify again.
        }
    };

    // Tools toolRequest has enabled, in discovery order. Searchable tools stay
    // in the registry but are not declared — and not callable — until they land
    // here. Core tools bypass the set entirely. The set is per harness, so a
    // discovered tool stays available for the rest of the conversation.
    const activeTools = new Set<string>();

    // Progressive discovery (R12). The cap keeps one query to five matches, so a
    // broad query used to be stationary: the omitted tail was unreachable. This
    // map remembers, per identical query (normalized tags + limit), how many ranked
    // matches have already been shown, so repeating the query returns the NEXT
    // tranche. It is harness state, cleared by reset() with the discovery set.
    const discoveryOffsets = new Map<string, number>();

    // Key that makes "the same query" exact: normalized and ORDER-INDEPENDENT
    // (two tag orders are the same question), with the limit included because a
    // narrower shortlist is a different page size.
    const discoveryQueryKey = (query: readonly string[], limit: number | undefined): string =>
        JSON.stringify([[...normalizeTags(query)].sort(), limit ?? null]);

    const enableTools = (names: readonly string[]): void => {
        for (const name of names) {
            if (tools[name]) activeTools.add(name);
        }
    };

    // The core tools a given agent may actually see: every 'core' definition, minus
    // the primary-only ones for every other agent. ONE rule, shared by the request
    // declaration below and by toolRequest's `alreadyAvailable` report, so a tool
    // cannot be declared to a subagent and omitted from discovery (or advertised
    // to an agent that never receives it).
    const visibleCoreTools = (brain: Agent): Tool[] => {
        const core: Tool[] = [];
        const role = roleOf(brain);

        for (const definition of Object.values(tools)) {
            if (definition.visibility !== 'core') continue;
            // Runtime controls (toolCancel) are declared separately and only while
            // actionable; they are still ordinary replaceable registry entries.
            if (pendingOnlyDefinitions.has(definition)) continue;
            // Primary-only definitions are marked by object, NOT by wire name, so
            // replacing agentDelegate/toolCreate drops the gate unless the
            // replacement itself declares it.
            if (primaryOnlyDefinitions.has(definition) && role !== 'primary') continue;
            core.push(definition);
        }

        return core;
    };

    // -----------------------------------------------------------------------
    // The ONE registration kernel (R1/R2/R3)
    // -----------------------------------------------------------------------
    //
    // Every registration path funnels through `acceptTool`:
    //   - startup (toolRegistry first, then the rest of the core set, presets,
    //     configured tools, and plugins);
    //   - the model-facing toolCreate (legacy async body);
    //   - the model-facing toolRegistry and host `registerTool` (editable module
    //     revision or legacy body).
    //
    // ORDERING: capture, transpilation/loading, contract validation, and the
    // registry commit all happen SYNCHRONOUSLY in call order. No compilation runs
    // in a background task, so overlapping registrations have a total submission
    // order and the last one to complete wins. `registerTool` returns a
    // Promise-compatible result, but the promise is created only after the commit:
    // it is a completion barrier, not a queue handle.
    //
    // ATOMICITY: the candidate is prepared completely before mutation. A thrown
    // transpile/load/contract error leaves the registry, the captured revision, the
    // enabled set, and the creation budget untouched. Unrestricted candidate code
    // may have external side effects during loading; the guarantee is registry
    // publication, not rollback of arbitrary side effects.
    //
    // REPLACEMENT: names are not reserved, "already registered" is not an error,
    // and replacing an implementation does not consume the new-tool budget. The
    // replacement PUBLISHES a new definition object; already-scheduled calls keep
    // the object they captured.
    let createdTools = 0;
    let startupPhase = true;

    // Stable harness-owned tool memory. Unlike module-local variables, this
    // survives a replacement implementation and is shared by every agent/tool in
    // this harness. `data` is the live store; the methods are the supported API.
    const memoryData: Record<string, unknown> = {};
    const memory: HarnessMemory = {
        data: memoryData,
        get: (key) => memoryData[key],
        set: (key, value) => {
            memoryData[key] = value;
        },
        has: (key) => Object.prototype.hasOwnProperty.call(memoryData, key),
        delete: (key) => delete memoryData[key],
        keys: () => Object.keys(memoryData),
        clear: () => {
            for (const key of Object.keys(memoryData)) delete memoryData[key];
        }
    };

    type RegistrationIntent = HarnessToolRegistrationCandidate & {
        // Host/plugin compatibility: an already-constructed Tool. It still goes
        // through the same atomic publish path, but has no editable source revision.
        definition?: Tool;
        // Startup and restore explicitly opt out of the new-tool budget.
        countAgainstBudget?: boolean;
    };

    // Convert a prepared source revision to the JSON-shaped record snapshot()
    // persists. Metadata comes from the installed tool so schema and
    // implementation always describe the same revision.
    const creationRecordOf = (prepared: PreparedTool): ToolCreation => ({
        name: prepared.tool.name,
        description: prepared.tool.description,
        tags: [...prepared.tool.tags],
        ...(prepared.tool.parameters === undefined
            ? {}
            : {
                  parameters: JSON.parse(JSON.stringify(prepared.tool.parameters)) as Record<
                      string,
                      unknown
                  >
              }),
        ...(prepared.record.source === undefined ? {} : { source: prepared.record.source }),
        ...(prepared.record.moduleText === undefined
            ? {}
            : { moduleText: prepared.record.moduleText }),
        ...(prepared.record.sourcePath === undefined
            ? {}
            : { sourcePath: prepared.record.sourcePath }),
        ...(prepared.record.dependencies.length === 0
            ? {}
            : { dependencies: prepared.record.dependencies.map((entry) => ({ ...entry })) }),
        ...(prepared.tool.visibility === 'core' ? { visibility: 'core' as const } : {})
    });

    // Prepare a definition candidate without re-running `tool()`: configured tools
    // and plugins already constructed their callable. The contract checks that do
    // not need compilation are repeated so a hand-built object cannot bypass the
    // registry's shape rules.
    const prepareDefinition = (definition: Tool): PreparedTool => {
        if (
            typeof definition.name !== 'string' ||
            !WIRE_NAME_PATTERN.test(definition.name)
        ) {
            throw new HarnessError(
                `Tool name "${String(definition.name)}" is not valid: use one letter followed by letters, digits, "_" or "-", at most 64 characters.`
            );
        }

        if (typeof definition.execute !== 'function') {
            throw new HarnessError('Registered tool definitions require an execute function.');
        }

        if (typeof definition.description !== 'string' || definition.description.trim().length === 0) {
            throw new HarnessError(`Tool "${definition.name}" requires a description.`);
        }

        if (!Array.isArray(definition.tags) || definition.tags.length === 0) {
            throw new HarnessError(`Tool "${definition.name}" requires at least one tag.`);
        }

        if (definition.parameters !== undefined) {
            if (
                typeof definition.parameters !== 'object' ||
                definition.parameters === null ||
                Array.isArray(definition.parameters)
            ) {
                throw new HarnessError(
                    `Tool "${definition.name}" parameters must be a JSON Schema object.`
                );
            }

            try {
                JSON.stringify(definition.parameters);
            } catch {
                throw new HarnessError(
                    `Tool "${definition.name}" parameters must be JSON-serialisable.`
                );
            }
        }

        return {
            tool: definition,
            revision: 'definition',
            record: {
                name: definition.name,
                revision: 'definition',
                dependencies: [],
                format: 'function-body',
                checks: ['contract:definition']
            }
        };
    };

    // The synchronous commit half. Returns everything the public paths need.
    const acceptTool = (
        intent: RegistrationIntent,
        options: { record?: ToolCreation | false; baseline?: boolean } = {}
    ): { prepared: PreparedTool; result: HarnessToolRegistrationResult } => {
        // 1. CAPTURE + COMPILE + LOAD + VALIDATE. Nothing below runs on failure.
        const prepared =
            intent.definition === undefined
                ? prepareToolCandidate(intent, { expectedName: intent.name })
                : prepareDefinition(intent.definition);

        const name = prepared.tool.name;
        const existing = tools[name];
        const existed = existing !== undefined;
        const replacingCreated = createdToolRecords.has(name);

        // 2. Budget: only a NEW name registered after startup counts. Replacing an
        // existing definition never exhausts the budget.
        if (
            !existed &&
            !startupPhase &&
            options.baseline !== true &&
            intent.countAgainstBudget !== false &&
            createdTools >= maxCreatedTools
        ) {
            throw new HarnessError(
                `This harness already created ${maxCreatedTools} tools; reuse an existing tool instead of creating more.`
            );
        }

        // 3. PUBLISH implementation + metadata + schema together as one object.
        const previousRevision = toolSourceRecords.get(name)?.revision;
        tools[name] = prepared.tool;

        if (prepared.record.format === 'module' || prepared.record.source !== undefined) {
            toolSourceRecords.set(name, prepared.record);
        } else {
            toolSourceRecords.delete(name);
        }

        // 4. Persistence bookkeeping. A source registration is recorded when it
        // creates a new name or replaces a previously-created tool; replacing a
        // baseline preset/core tool remains runtime-only (the existing persistence
        // contract does not require carrying built-in replacements across restart).
        if (!startupPhase && options.baseline !== true) {
            if (options.record !== undefined && options.record !== false) {
                // Persist a legacy creation only when it owns the name. Replacing a
                // baseline preset/core tool is runtime-only: recording it would make
                // a snapshot restore collide with the fresh harness's baseline.
                if (!existed || replacingCreated) {
                    createdToolRecords.set(name, cloneToolCreation(options.record));
                }
            } else if (prepared.record.format === 'module' || prepared.record.source !== undefined) {
                if (!existed || replacingCreated) {
                    createdToolRecords.set(name, creationRecordOf(prepared));
                }
            }
            // A definition replacement of a created tool keeps the old persisted
            // revision: runtime-only replacements are not promised across restart,
            // and dropping the record would desynchronise createdToolCount.

            if (!existed && intent.countAgainstBudget !== false) createdTools++;

            // A newly registered/replaced tool is immediately usable by the
            // registering agent without another discovery round.
            if (!existed || prepared.tool.visibility !== 'core') activeTools.add(name);

            notifyStateChange('tool_create', { tool: name });
        }

        return {
            prepared,
            result: {
                name,
                revision: prepared.revision,
                created: !existed,
                replaced: existed,
                ...(previousRevision === undefined ? {} : { previousRevision }),
                ...(prepared.record.sourcePath === undefined
                    ? {}
                    : { sourcePath: prepared.record.sourcePath }),
                checks: [...prepared.record.checks]
            }
        };
    };

    // Startup helper: the kernel may be called directly before any model-facing
    // registration tool exists, but it uses the same acceptance operation.
    const registerAtStartup = (intent: RegistrationIntent): PreparedTool =>
        acceptTool(intent, { record: false }).prepared;

    // Conditional BASELINE tools (threadSend/threadList) are registered after
    // startup but are catalogue state, not user creations: they neither spend the
    // creation budget nor enter the snapshot's createdTools set.
    const registerBaselineAtRuntime = (intent: RegistrationIntent): PreparedTool =>
        acceptTool(intent, { record: false, baseline: true }).prepared;

    // Explicit compiler capability boundary. The aliased browser stub exports
    // false; Node exports true even when its editable roots are missing, so a
    // mispackaged Node build FAILS startup compilation instead of silently using
    // prepared definitions. Runtime source registration always goes through
    // prepareToolCandidate and fails actionable when unsupported.
    const sourceStartupSupported = supportsToolCompilation;

    const registerBaselineSource = (
        intent: RegistrationIntent,
        fallback: () => Tool
    ): PreparedTool =>
        sourceStartupSupported
            ? registerAtStartup(intent)
            : registerAtStartup({ definition: fallback() });

    // Runtime registration. The compile/publish work is synchronous; the returned
    // promise only represents the already-decided outcome. A rejection therefore
    // cannot leave a partially published candidate.
    const registerTool = (
        candidate: HarnessToolRegistrationCandidate
    ): Promise<HarnessToolRegistrationResult> => {
        try {
            return Promise.resolve(acceptTool(candidate, { record: false }).result);
        } catch (error) {
            return Promise.reject(error);
        }
    };

    // Inspect one installed source revision. Returns a detached copy; a caller
    // cannot mutate the captured record through it.
    const toolSource = (name: string): HarnessToolSource | undefined => {
        const record = toolSourceRecords.get(name);
        return record === undefined ? undefined : cloneToolSourceRecord(record);
    };

    const toolSources = (): HarnessToolSource[] =>
        Object.keys(tools)
            .map((name) => toolSourceRecords.get(name))
            .filter((record): record is ToolSourceRecord => record !== undefined)
            .map(cloneToolSourceRecord);

    // toolRegistry is registered FIRST, because the bootstrap needs a model-facing
    // entry that delegates to the kernel for every later revision. It is loaded by
    // compiling its editable source entry through registerAtStartup — the SAME
    // operation runtime registrations use, not a prepared-definition shortcut.
    // If the source file is missing, construction fails loudly rather than silently
    // starting without the self-modification loop.
    registerBaselineSource(
        {
            name: TOOL_REGISTRY_NAME,
            sourcePath: 'runtime-tools/toolRegistry.ts'
        },
        () =>
            defineTool({
                ...TOOL_REGISTRY_METADATA,
                execute: (context) => {
                    if (context.harness === undefined) {
                        throw new HarnessError(
                            'toolRegistry requires the live harness reference.'
                        );
                    }

                    return context.harness.registerTool(
                        (context.parameters ?? {}) as HarnessToolRegistrationCandidate
                    );
                }
            })
    );

    // The discovery STATE/operation lives on the harness; the model-facing
    // toolRequest entry is a standalone source module compiled through the kernel.
    // Keeping the cursor and enabled-set mutation here is what makes the source
    // entry replaceable without losing harness state.
    const requestToolsFor = (
        caller: Agent | undefined,
        parameters: { tags?: unknown; limit?: unknown } | unknown
    ): ToolSearchResult => {
        // Tolerate a bare array (a model ignoring the schema) and a missing
        // `tags`, so a sloppy call still gets the catalogue vocabulary back.
        const query = Array.isArray(parameters)
            ? parameters
            : Array.isArray((parameters as { tags?: unknown } | undefined)?.tags)
              ? ((parameters as { tags: string[] }).tags)
              : [];
        const limit = Array.isArray(parameters)
            ? undefined
            : typeof (parameters as { limit?: unknown } | undefined)?.limit === 'number'
              ? (parameters as { limit: number }).limit
              : undefined;

        // Repeat the same query to advance through the omitted tail (R12).
        const key = discoveryQueryKey(query, limit);
        const offset = discoveryOffsets.get(key) ?? 0;

        // Pending-only runtime controls are never discoverable: they are declared
        // only while actionable and have no catalogue identity to hand out.
        const catalogue = Object.values(tools).filter(
            (definition) => !pendingOnlyDefinitions.has(definition)
        );
        const result = searchTools(catalogue, query, limit, offset, {
            declared: visibleCoreTools(caller ?? primary)
        });
        enableTools(result.enabled);

        // Advance only when this page actually returned matches AND more are
        // left; when the tail is exhausted the key is dropped so a later
        // identical query starts a fresh first page instead of an empty one.
        if (result.remaining > 0 && result.enabled.length > 0) {
            discoveryOffsets.set(key, offset + result.enabled.length);
        } else {
            discoveryOffsets.delete(key);
        }

        return result;
    };

    registerBaselineSource(
        {
            name: TOOL_REQUEST,
            sourcePath: 'runtime-tools/toolRequest.ts'
        },
        () =>
            defineTool({
                ...TOOL_REQUEST_METADATA,
                execute: (context) => requestToolsFor(context.agent, context.parameters)
            })
    );

    // Legacy runtime creation (R2b). This is a THIN COMPATIBILITY ADAPTER over the
    // same kernel: toolCreate still accepts an async function body, but capture,
    // compilation, contract validation, publication, budget accounting, and
    // persistence all run through acceptTool. There is no second pipeline.
    const createToolFrom = (configuration: ToolCreation): Tool => {
        const { prepared } = acceptTool(
            {
                name: configuration.name,
                description: configuration.description,
                tags: configuration.tags,
                ...(configuration.parameters === undefined
                    ? {}
                    : { parameters: configuration.parameters }),
                ...(configuration.visibility === undefined
                    ? {}
                    : { visibility: configuration.visibility }),
                ...(configuration.source === undefined ? {} : { source: configuration.source }),
                ...(configuration.moduleText === undefined
                    ? {}
                    : { moduleText: configuration.moduleText }),
                ...(configuration.sourcePath === undefined
                    ? {}
                    : { sourcePath: configuration.sourcePath }),
                ...(configuration.dependencies === undefined
                    ? {}
                    : { dependencies: configuration.dependencies })
            },
            {
                // Persist exactly what was compiled. Clone now: the caller owns the
                // configuration object and may mutate it after this returns.
                record: cloneToolCreation(configuration)
            }
        );

        return prepared.tool;
    };

    // The model-facing toolCreate tool (R2b), gated by the creation policy (R12).
    // `toolCreation: false` means the tool is not registered at all — a session
    // without the capability gives an honest "not registered" instead of a tool
    // that always fails. The host path `harness.createTool` stays available in
    // every policy: an operator action is not a model privilege.
    const createToolForAgent = (
        caller: Agent | undefined,
        configuration: ToolCreation
    ): ToolCreationResult => {
        // 'primary' policy: the tool is also not DECLARED to subagents, so this is
        // the defence-in-depth check for a guessed name.
        if (toolCreation === 'primary' && roleOf(caller ?? primary) !== 'primary') {
            throw new HarnessError(
                `Only the primary agent "${primaryName}" can create tools; "${caller?.name ?? 'a host'}" cannot.`
            );
        }

        // Throwing is the error path the harness turns into a readable tool result:
        // invalid name, budget, a body that does not parse, etc. Publication is
        // atomic inside the shared kernel.
        const definition = createToolFrom(configuration);

        const result: ToolCreationResult = {
            name: definition.name,
            description: definition.description,
            tags: [...definition.tags],
            enabled: true
        };

        if (definition.parameters) result.parameters = definition.parameters;

        return result;
    };

    if (toolCreation !== false) {
        const preparedToolCreate = registerBaselineSource(
            {
                name: TOOL_CREATE,
                sourcePath: 'runtime-tools/toolCreate.ts'
            },
            () =>
                defineTool({
                    ...TOOL_CREATE_METADATA,
                    execute: (context) =>
                        createToolForAgent(
                            context.agent,
                            context.parameters as ToolCreation
                        )
                })
        );

        // 'primary' policy is a property of THIS definition, not the wire name;
        // replacing toolCreate publishes a new object with no inherited gate.
        if (toolCreation === 'primary') primaryOnlyDefinitions.add(preparedToolCreate.tool);
    }

    // Session todos (R1/R2). One instance per harness: the tool closes over its
    // own list and id counter, so two harnesses (and therefore two server
    // sessions) can never share todos. Every agent in this harness calls the same
    // tool, so the primary and its subagents see one list. reset() below clears
    // it together with the conversation; nothing is persisted.
    const todo = createTodoTool();
    registerBaselineSource(
        { name: TODO_MANAGE, sourcePath: 'runtime-tools/todoManage.ts' },
        () => todo.tool
    );

    // Session records (profiles, chapters, locations). Same lifecycle as the todo
    // list: one factory instance per harness, shared by every agent here, and
    // cleared by reset(). Separate closets and separate id sequences, so a
    // profile id and a chapter id may both be "1" without ambiguity.
    const profile = createProfileTool();
    registerBaselineSource(
        { name: PROFILE_MANAGE, sourcePath: 'runtime-tools/profileManage.ts' },
        () => profile.tool
    );

    const chapter = createChapterTool();
    registerBaselineSource(
        { name: CHAPTER_MANAGE, sourcePath: 'runtime-tools/chapterManage.ts' },
        () => chapter.tool
    );

    const location = createLocationTool();
    registerBaselineSource(
        { name: LOCATION_MANAGE, sourcePath: 'runtime-tools/locationManage.ts' },
        () => location.tool
    );

    // Per-harness network closures. They are populated during startup from the
    // `websearch`/`webfetch` configuration and carry the credentials; the compiled
    // source entries only reference the operations, never the keys.
    const webOperations: { webSearch?: Tool; webFetch?: Tool } = {};

    // Live operations used by the standalone core source entries. These are not a
    // capability substitute: core tools also receive the full `context.harness`.
    const runtime: HarnessToolRuntime = {
        requestTools: requestToolsFor,
        createToolForAgent,
        agentManage: () => agentManageView(),
        agentResult: (parameters: Record<string, any>) => agentResultFor(parameters),
        delegate: (caller, parameters, run, runDepth) =>
            delegateFor(caller, parameters, run, runDepth),
        threadSend: (caller, threadId, parameters) => threadSendFor(caller, threadId, parameters),
        threadList: (threadId) => threadRoster(threadId),
        webSearch: (context) => {
            const operation = webOperations.webSearch;

            if (operation === undefined) {
                throw new HarnessError(
                    'webSearch is not configured for this harness (no provider key resolved).'
                );
            }

            return operation.execute(context);
        },
        webFetch: (context) => {
            const operation = webOperations.webFetch;

            if (operation === undefined) {
                throw new HarnessError('webFetch is not configured for this harness.');
            }

            return operation.execute(context);
        },
        executeRecordTool: (
            name: 'todoManage' | 'profileManage' | 'chapterManage' | 'locationManage',
            context: ToolContext
        ) => {
            switch (name) {
                case 'todoManage':
                    return todo.tool.execute(context);
                case 'profileManage':
                    return profile.tool.execute(context);
                case 'chapterManage':
                    return chapter.tool.execute(context);
                case 'locationManage':
                    return location.tool.execute(context);
            }
        }
    };

    // -----------------------------------------------------------------------
    // Agent inspection (R3): agentManage / agentResult
    // -----------------------------------------------------------------------
    //
    // WHY A PER-INVOCATION REGISTRY
    // -----------------------------
    // agent.messages is the canonical transcript, but exposing it would leak
    // system instructions, user prompts, tool arguments, and tool bodies. The
    // registry records ONLY the completed answer value a run returns (plus its
    // identity), so agentManage/agentResult can never read anything else.
    //
    // Invocation identity:
    //   - root run            -> String(run.id)
    //   - delegation/ctx.run  -> run.thread.id === String(run.id)
    //   - fork/autoanswer     -> run.thread.id === branchId
    // Branch runs are recorded too, so a fork result is available without
    // parsing the owner's transcript (kind 'fork' / 'autoanswer').
    //
    // Retention is bounded by AGENT_RESULT_RETENTION: completed records beyond it
    // are evicted oldest-first, while a still-running record is NEVER evicted.
    // TERMINAL records are durable through the OPTIONAL `agentResults` field of
    // snapshot v1 (same version, backward compatible); `running` records are
    // omitted because they have no answer yet. reset() clears the registry with
    // the conversation, because invocation ids are session-scoped.
    type AgentInvocationKind = 'root' | 'delegation' | 'fork' | 'autoanswer';
    type AgentInvocationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

    type AgentInvocationRecord = {
        invocationId: string;
        // The run sequence. It is monotonic per harness and sorts records
        // deterministically without a wall-clock timestamp.
        sequence: number;
        // Monotonic completion order. agentResult without an invocation id uses
        // this (not start order) so the agent's LAST FINISHED answer wins even
        // when a fork started later but completed earlier. 0 while running; set
        // once on the terminal transition and persisted in snapshot v1.
        completedOrder: number;
        agent: string;
        role: 'primary' | 'subagent';
        kind: AgentInvocationKind;
        status: AgentInvocationStatus;
        // Completed answer text only. Empty for running/failed/cancelled.
        content: string;
        // Failure/cancellation message (never a transcript or tool body).
        error?: string;
        // R2: the persistent thread that owns this invocation. Internal only; it
        // exists so `deleteThread` can purge every lookup scoped to the removed
        // conversation (the persisted agent-result schema is unchanged).
        threadId?: string;
    };

    const invocationRecords = new Map<string, AgentInvocationRecord>();
    let invocationCompletionSequence = 0;

    const invocationIdOf = (run: RunState): string => run.thread?.id ?? String(run.id);

    const invocationKindOf = (run: RunState): AgentInvocationKind => {
        if (run.branch !== undefined) return run.branch.kind;
        return run.parent === undefined ? 'root' : 'delegation';
    };

    // Evict oldest TERMINAL records only. Active runs are retained without
    // bound by this policy (in practice the scheduler/run guards bound them),
    // so a long-running invocation is always addressable.
    const pruneInvocationRecords = (): void => {
        const overflow = invocationRecords.size - AGENT_RESULT_RETENTION;
        if (overflow <= 0) return;

        const removable = [...invocationRecords.values()]
            .filter((record) => record.status !== 'running')
            .sort((left, right) => left.sequence - right.sequence)
            .slice(0, overflow);

        for (const record of removable) invocationRecords.delete(record.invocationId);
    };

    const registerInvocation = (run: RunState): void => {
        const invocationId = invocationIdOf(run);

        invocationRecords.set(invocationId, {
            invocationId,
            sequence: run.id,
            agent: run.agent.name,
            role: roleOf(run.agent),
            kind: invocationKindOf(run),
            status: 'running',
            content: '',
            completedOrder: 0,
            ...(run.threadId === undefined ? {} : { threadId: run.threadId })
        });

        pruneInvocationRecords();
    };

    // Terminal transition. A success records the resolved answer (which may be
    // empty); a failure keeps only the error message. Deliberately pure from the
    // run's perspective: it must never affect history, events, or the outcome.
    const finishInvocation = (
        run: RunState,
        outcome: { message?: HarnessAssistantMessage; error?: unknown }
    ): void => {
        const record = invocationRecords.get(invocationIdOf(run));
        if (record === undefined) return;

        record.completedOrder = ++invocationCompletionSequence;

        if (outcome.message !== undefined) {
            record.status = 'completed';
            record.content = typeof outcome.message.content === 'string' ? outcome.message.content : '';
        } else {
            record.status =
                run.aborted || run.signal?.aborted === true ? 'cancelled' : 'failed';
            record.error = toErrorInfo(
                outcome.error ?? new HarnessError(`Agent "${run.agent.name}" ended without a result.`)
            ).message;
        }

        pruneInvocationRecords();
    };

    // A preview is whitespace-trimmed answer text, capped at the declared size.
    // The ellipsis marks truncation explicitly; `truncated` is the machine flag.
    const invocationPreviewOf = (record: AgentInvocationRecord) => {
        if (record.status !== 'completed') {
            return {
                invocationId: record.invocationId,
                kind: record.kind,
                status: record.status,
                contentLength: 0,
                preview: '',
                truncated: false
            };
        }

        const trimmed = record.content.trim();
        const truncated = trimmed.length > AGENT_MANAGE_PREVIEW_CHARS;

        return {
            invocationId: record.invocationId,
            kind: record.kind,
            status: record.status,
            contentLength: record.content.length,
            preview: truncated ? `${trimmed.slice(0, AGENT_MANAGE_PREVIEW_CHARS)}…` : trimmed,
            truncated
        };
    };

    // Newest first within one agent. `sequence` is unique, so the order is total.
    const recordsForAgent = (name: string): AgentInvocationRecord[] =>
        [...invocationRecords.values()]
            .filter((record) => record.agent === name)
            .sort((left, right) => right.sequence - left.sequence);

    // Pagination must not cut a UTF-16 surrogate pair in half. `offset` is a
    // character (code-unit) index, which can land inside a non-BMP glyph; move the
    // start back one unit to include the whole pair, then keep the page at `limit`
    // units and move the END back when it would split the next pair. ASCII results
    // are unchanged byte-for-byte.
    const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

    const resultPageOf = (
        content: string,
        requestedOffset: number,
        limit: number
    ): { content: string; offset: number; hasMore: boolean; nextOffset?: number } => {
        const total = content.length;
        let start = Math.min(Math.max(0, requestedOffset), total);

        if (
            start > 0 &&
            start < total &&
            isLowSurrogate(content.charCodeAt(start)) &&
            isHighSurrogate(content.charCodeAt(start - 1))
        ) {
            start--;
        }

        let end = Math.min(start + limit, total);

        if (
            end > start &&
            end < total &&
            isHighSurrogate(content.charCodeAt(end - 1)) &&
            isLowSurrogate(content.charCodeAt(end))
        ) {
            end--;
        }

        const hasMore = end < total;

        return {
            content: content.slice(start, end),
            offset: start,
            hasMore,
            ...(hasMore ? { nextOffset: end } : {})
        };
    };

    // Listing. Every configured agent appears (even with no results), so a model
    // can see who exists before anything has run.
    const agentManageView = (): unknown => {
            const records = [...invocationRecords.values()];
            let listed = 0;

            const agentsView = Object.entries(agents).map(([name, brain]) => {
                const recent = recordsForAgent(name);
                const visible = recent.slice(0, AGENT_MANAGE_LIST_PER_AGENT);
                listed += visible.length;

                return {
                    name,
                    role: roleOf(brain),
                    model: brain.model(),
                    invocationCount: recent.length,
                    results: visible.map(invocationPreviewOf)
                };
            });

            return {
                agents: agentsView,
                totalResults: records.length,
                activeResults: records.filter((record) => record.status === 'running').length,
                // True when at least one agent has more retained invocations than
                // this listing shows. Full text is always retrievable by id via
                // agentResult while the record is retained.
                truncated: records.length > listed
            };
    };

    registerBaselineSource(
        { name: AGENT_MANAGE, sourcePath: 'runtime-tools/agentManage.ts' },
        () =>
            defineTool({
                ...AGENT_MANAGE_METADATA,
                execute: () => agentManageView()
            })
    );

    // Full retrieval by agent (and preferably invocation id). There is no
    // transcript access at all: every branch below reads the recorded answer
    // value only.
    const agentResultFor = (parameters: Record<string, any>): unknown => {
            const name = parameters?.agent;
            const configured = Object.prototype.hasOwnProperty.call(agents, name);

            if (!configured) {
                throw new HarnessError(
                    `Agent "${String(name)}" is not registered. Configured agents: ${Object.keys(agents).join(', ')}.`
                );
            }

            const requestedId =
                typeof parameters?.invocationId === 'string' ? parameters.invocationId : undefined;

            let record: AgentInvocationRecord | undefined;

            if (requestedId !== undefined) {
                const candidate = invocationRecords.get(requestedId);

                // An id belonging to another agent is reported as unavailable for
                // THIS agent: the lookup is scoped, so a caller cannot probe
                // sibling results through the wrong name.
                if (candidate === undefined || candidate.agent !== name) {
                    throw new HarnessError(
                        `No result "${requestedId}" is available for agent "${name}".`
                    );
                }

                record = candidate;
            } else {
                const recent = recordsForAgent(name);
                // Latest FINISHED result wins (completion order, not start order,
                // so a fork that finished earlier never masks the root's answer);
                // a still-running invocation does not hide the last finished
                // answer. Fall back to the newest started record so a failure or
                // an active-only agent is still explainable.
                const completed = recent
                    .filter((entry) => entry.status === 'completed')
                    .sort((left, right) => right.completedOrder - left.completedOrder);

                record = completed[0] ?? recent[0];
            }

            const limit =
                typeof parameters?.limit === 'number'
                    ? Math.min(parameters.limit, AGENT_RESULT_PAGE_MAX_CHARS)
                    : AGENT_RESULT_PAGE_CHARS;

            // No invocation at all: an honest empty state, not an error.
            if (record === undefined) {
                return {
                    agent: name,
                    status: 'empty',
                    content: '',
                    contentLength: 0,
                    offset: 0,
                    limit,
                    hasMore: false
                };
            }

            const base = {
                agent: name,
                invocationId: record.invocationId,
                kind: record.kind,
                status: record.status
            };

            if (record.status === 'running') {
                // A run in flight has NO answer yet. Never return a streamed
                // partial as if it were a completed result.
                return {
                    ...base,
                    content: '',
                    contentLength: 0,
                    offset: 0,
                    limit,
                    hasMore: false
                };
            }

            if (record.status === 'failed' || record.status === 'cancelled') {
                return {
                    ...base,
                    content: '',
                    contentLength: 0,
                    offset: 0,
                    limit,
                    hasMore: false,
                    error: record.error ?? 'The invocation did not complete.'
                };
            }

            const total = record.content.length;
            const offset =
                typeof parameters?.offset === 'number' ? Math.min(parameters.offset, total) : 0;
            const page = resultPageOf(record.content, offset, limit);

            return {
                ...base,
                content: page.content,
                contentLength: total,
                offset: page.offset,
                limit,
                hasMore: page.hasMore,
                ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset })
            };
    };

    registerBaselineSource(
        { name: AGENT_RESULT, sourcePath: 'runtime-tools/agentResult.ts' },
        () =>
            defineTool({
                ...AGENT_RESULT_METADATA,
                execute: (context) =>
                    agentResultFor((context.parameters ?? {}) as Record<string, any>)
            })
    );

    // Bounded delegation (R4). Registered only when there is somewhere to
    // delegate: a tool that can only fail would cost context on every request.
    // Subagents never receive it (see declared()), and launchToolCall rejects a
    // guessed call, so delegation is exactly one level deep. runAgent rejects
    // re-entering an agent that is already running, which closes the ctx.run
    // cycle as well.
    const delegateFor = async (
        caller: Agent | undefined,
        parameters: { agent?: string; input?: string },
        run: ToolContext['run'],
        runDepth: number | undefined
    ): Promise<HarnessDelegationResult> => {
        // Defence in depth: the tool is not DECLARED to subagents, but a model can
        // guess a name, so the caller is checked here too.
        if (roleOf(caller ?? primary) !== 'primary') {
            throw new HarnessError(
                `Only the primary agent "${primaryName}" can delegate; "${caller?.name ?? 'a host'}" cannot.`
            );
        }

        // Delegation is a top-level capability. A primary reached as a subagent of
        // another run must not recurse outward. `runDepth` is the calling run's
        // depth (1 = top level), carried on the context so this rule survives
        // concurrent runs without a global run stack.
        if ((runDepth ?? 1) > 1) {
            throw new HarnessError(
                'Delegation is only available from the primary agent\'s own run, not from inside another agent.'
            );
        }

        // Two schema properties, so `parameters` is the parsed arguments object.
        const target = parameters?.agent;

        if (typeof target !== 'string' || !subagentNames.includes(target)) {
            throw new HarnessError(
                `Agent "${String(target)}" is not a configured subagent. Allowed: ${subagentNames.join(', ')}.`
            );
        }

        if (typeof parameters?.input !== 'string' || parameters.input.trim().length === 0) {
            throw new HarnessError('Delegation requires a non-empty input.');
        }

        if (!run) {
            throw new HarnessError('Delegation requires a harness run context.');
        }

        const message = await run(target, parameters.input);

        // Only the answer crosses back: the subagent keeps its own transcript and
        // instructions.
        return { agent: target, content: message.content };
    };

    if (subagentNames.length > 0) {
        // The allowlist schema is per-harness, so the candidate overrides the
        // source entry's generic schema (the editable module still owns the
        // execution contract and delegates to the live runtime operation).
        const delegateMetadata = agentDelegateMetadata(subagentNames);
        const agentDelegateDefinition = registerBaselineSource(
            {
                name: AGENT_DELEGATE,
                description: delegateMetadata.description,
                tags: delegateMetadata.tags,
                parameters: delegateMetadata.parameters,
                sourcePath: 'runtime-tools/agentDelegate.ts'
            },
            () =>
                defineTool({
                    ...delegateMetadata,
                    execute: (context) =>
                        delegateFor(
                            context.agent,
                            (context.parameters ?? {}) as {
                                agent?: string;
                                input?: string;
                            },
                            context.run,
                            context.runDepth
                        )
                })
        ).tool;

        // Primary-only and answer-extraction are properties of THIS definition. A
        // replacement published under the same wire name inherits neither.
        primaryOnlyDefinitions.add(agentDelegateDefinition);
        delegateAnswerDefinitions.add(agentDelegateDefinition);
    }

    // -----------------------------------------------------------------------
    // N6 branch controls: threadFork and actionRequest
    // -----------------------------------------------------------------------
    //
    // Both need the owning RunState (the exact transcript snapshot and the owner
    // run) rather than an ordinary tool context, so launchToolCall dispatches them
    // to runtime handlers. The dispatch is keyed by a MARKER ON THE RESOLVED
    // DEFINITION, never by wire name before registry lookup: replacing either
    // tool drops the marker and the replacement executes as an ordinary tool.
    // Their execute bodies fail loudly if some future path calls them directly.
    if (forks.enabled) {
        const threadForkDefinition = registerBaselineSource(
            { name: THREAD_FORK, sourcePath: 'runtime-tools/threadFork.ts' },
            () =>
                defineTool({
                    ...THREAD_FORK_METADATA,
                    execute: () => {
                        throw new HarnessError(
                            'threadFork requires the harness run that owns the conversation; call it from a model tool call.'
                        );
                    }
                })
        ).tool;
        runtimeControlDefinitions.set(threadForkDefinition, 'threadFork');
    }

    if (interaction !== undefined) {
        const actionRequestDefinition = registerBaselineSource(
            { name: ACTION_REQUEST, sourcePath: 'runtime-tools/actionRequest.ts' },
            () =>
                defineTool({
                    ...ACTION_REQUEST_METADATA,
                    execute: () => {
                        throw new HarnessError(
                            'actionRequest requires the harness run that owns the conversation; call it from a model tool call.'
                        );
                    }
                })
        ).tool;
        runtimeControlDefinitions.set(actionRequestDefinition, 'actionRequest');
    }

    // toolCancel is an ordinary registered definition too, but it is DECLARED
    // only while the calling actor has background work. `pendingOnlyDefinitions`
    // (not the name) drives that declaration rule; replacing it publishes a normal
    // tool that is declared according to its own visibility.
    if (tools[TOOL_CANCEL] === undefined) {
        const toolCancelDefinition = registerBaselineSource(
            { name: TOOL_CANCEL, sourcePath: 'runtime-tools/toolCancel.ts' },
            () =>
                defineTool({
                    ...TOOL_CANCEL_METADATA,
                    execute: () => {
                        throw new HarnessError(
                            'toolCancel must be dispatched by the harness run that owns the pending call.'
                        );
                    }
                })
        ).tool;
        // The baseline control is not a standing core declaration; it is appended
        // by offerDeclarations only while actionable. Keeping its visibility
        // 'searchable' also keeps descriptor core lists honest. A replacement is
        // unaffected and uses its own visibility.
        toolCancelDefinition.visibility = 'searchable';
        runtimeControlDefinitions.set(toolCancelDefinition, 'toolCancel');
        pendingOnlyDefinitions.add(toolCancelDefinition);
    }

    // Baseline preset registrations. Each preset is compiled from its EDITABLE
    // source entry through the same kernel (not from a cached lazy proxy and not
    // from a prepared definition): the startup path therefore exercises exactly
    // the compilation/loading/validation operation a runtime replacement uses.
    // `presets: false` simply skips these baseline rows.
    const PRESET_SOURCE_ENTRIES: Record<string, string> = {
        syntaxCheck: 'tools/syntax/syntaxCheck.ts',
        fileRead: 'tools/files/fileRead.ts',
        fileWrite: 'tools/files/fileWrite.ts',
        fileEdit: 'tools/files/fileEdit.ts',
        fileList: 'tools/files/fileList.ts',
        fileGlob: 'tools/files/fileGlob.ts',
        commandRun: 'tools/command/commandRun.ts',
        gitDiff: 'tools/command/gitDiff.ts'
    };

    if (configuration.presets !== false) {
        for (const name of Object.keys(presetTools)) {
            const source = PRESET_SOURCE_ENTRIES[name];
            if (source === undefined) continue;
            // Browser fallback keeps the historical lazy-proxy definitions; no
            // browser code execution is promised, only the same declaration shape.
            registerBaselineSource(
                { name, sourcePath: source },
                () => presetTools[name as keyof typeof presetTools]
            );
        }
    }

    // Host-configured source entries, committed AFTER the baseline and BEFORE
    // `tools` overrides. These are genuine compiled/reloaded revisions, not a
    // prebuilt-definition shortcut: this is the application tool-source map.
    for (const [name, sourcePath] of Object.entries(configuration.toolSources ?? {})) {
        if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
            throw new HarnessError(`Tool source "${name}" must be a non-empty source path.`);
        }

        registerAtStartup({ name, sourcePath });
    }

    // User-configured tools are committed AFTER the baseline and toolSources, so a
    // configured tool of the same name intentionally wins. Function-closure tools
    // remain compatible, but they are wrapped in a fresh definition instead of
    // mutating the caller's shared Tool object (`name` is a mutable own property).
    for (const [name, definition] of Object.entries(configuration.tools ?? {})) {
        if (!definition || typeof definition.execute !== 'function') {
            throw new HarnessError(`Tool "${name}" is not a tool: create it with tool({...}).`);
        }

        const wrapped = defineTool({
            name,
            description: definition.description,
            tags: definition.tags,
            visibility: definition.visibility,
            ...(definition.parameters === undefined
                ? {}
                : { parameters: definition.parameters }),
            // Preserve the original receiver in case a host implementation is a
            // method that relies on `this`; the shared object is never mutated.
            execute: (context) => definition.execute(context)
        });

        registerAtStartup({ definition: wrapped });
    }

    // Opt-in web search (W3). The provider closure (and its credentials) stays
    // harness-owned; the REGISTERED entry is the independently compiled runtime
    // source revision. Candidate metadata supplies the configured provider surface
    // (dynamic schema), so no credential or provider list is baked into source.
    if (
        configuration.websearch !== undefined &&
        configuration.websearch !== false &&
        tools[WEB_SEARCH_TOOL_NAME] === undefined
    ) {
        const webSearch = createWebSearchTool(
            configuration.websearch === true ? {} : configuration.websearch
        );

        if (webSearch) {
            webOperations.webSearch = webSearch;
            registerBaselineSource(
                {
                    name: WEB_SEARCH_TOOL_NAME,
                    sourcePath: 'runtime-tools/webSearch.ts',
                    description: webSearch.description,
                    tags: webSearch.tags,
                    parameters: webSearch.parameters,
                    visibility: webSearch.visibility
                },
                () => webSearch
            );
        }
    }

    // Opt-in page fetch (W4). Same rule: the registered implementation is compiled
    // source; the provider/credential closure is the live runtime operation.
    if (
        configuration.webfetch !== undefined &&
        configuration.webfetch !== false &&
        tools[WEB_FETCH_TOOL_NAME] === undefined
    ) {
        const webFetch = createWebFetchTool(
            configuration.webfetch === true ? {} : configuration.webfetch
        );
        webOperations.webFetch = webFetch;
        registerBaselineSource(
            {
                name: WEB_FETCH_TOOL_NAME,
                sourcePath: 'runtime-tools/webFetch.ts',
                description: webFetch.description,
                tags: webFetch.tags,
                parameters: webFetch.parameters,
                visibility: webFetch.visibility
            },
            () => webFetch
        );
    }

    // The tools a request may declare: every core tool first (file tools, a
    // configured webSearch, and the harness-owned set), then everything discovered
    // so far. Everything else stays out of the context window on purpose.
    //
    // agentDelegate is core for the primary only: it is skipped for every other
    // agent, so a subagent cannot even see the delegation control. toolCreate is
    // the same under the 'primary' creation policy (R12). That rule lives in
    // visibleCoreTools, which toolRequest also reads — one source for both.
    const declared = (brain: Agent): Tool[] => {
        const discovered: Tool[] = [];

        for (const definition of Object.values(tools)) {
            if (definition.visibility !== 'core' && activeTools.has(definition.name)) {
                discovered.push(definition);
            }
        }

        return [...visibleCoreTools(brain), ...discovered];
    };

    // Declarations handed to every request. Rebuilt per run so a plugin that
    // registers tools mid-flight is picked up on the next call, and so a toolRequest
    // round shows up in the very next request. Per-brain because agentDelegate is a
    // primary-only declaration.
    //
    // toolCancel is appended ONLY while this agent's ACTOR has background work
    // pending: that is the only moment it can succeed, and keeping it off ordinary
    // requests costs no context and leaves the historical declaration list
    // unchanged for a run with no background work (T3/R4).
    //
    // An AUTOANSWER branch is tool-free and single-iteration by contract: it is
    // declared no tools at all (not even toolCancel), so the owner can only
    // produce the directive answer this runtime parses.
    // The OFFERED DEFINITIONS for one model request. Keeping the exact Tool
    // objects (not just names/metadata) is what makes the advertised schema and
    // the implementation that executes a returned call the SAME revision. A
    // replacement published while this request is in flight is visible to the
    // NEXT request; calls from this one retain their captured definitions.
    const offerDeclarations = (
        run: RunState
    ): { offered: Map<string, Tool>; declarations: HarnessStreamTool[] } => {
        const offered = new Map<string, Tool>();

        if (run.autoAnswer) return { offered, declarations: [] };

        const definitions = declared(run.agent);
        const list: HarnessStreamTool[] = [];

        for (const definition of definitions) {
            offered.set(definition.name, definition);
            list.push({
                name: definition.name,
                description: definition.description,
                parameters: definition.parameters
            });
        }

        // toolCancel is declared only while this actor has work in flight. It is a
        // normal registered definition; the pending-only marker belongs to the
        // baseline object, so a replacement is declared by its own visibility.
        const pendingCancel = tools[TOOL_CANCEL];

        if (
            pendingCancel !== undefined &&
            pendingOnlyDefinitions.has(pendingCancel) &&
            scheduler.pending(run.actorKey).length > 0
        ) {
            offered.set(pendingCancel.name, pendingCancel);
            list.push({
                name: pendingCancel.name,
                description: pendingCancel.description,
                parameters: pendingCancel.parameters
            });
        }

        return { offered, declarations: list };
    };

    // -----------------------------------------------------------------------
    // Background tool scheduling (T3)
    // -----------------------------------------------------------------------
    //
    // A tool call no longer blocks the conversation. Each call is launched on the
    // scheduler immediately and the run continues: the next model request sees a
    // provider-safe PROJECTION in which unfinished calls have placeholder tool
    // results. Real results are committed to the canonical transcript as they
    // arrive (always immediately after the assistant block that requested them),
    // and each completion makes the run dirty, which drives another model turn so
    // the model actually sees the outcome.
    //
    // Consequences that are deliberate:
    //   - the 0ms settle window after a launch lets ordinary synchronous /
    //     microtask tools finish in the SAME round, preserving the historical
    //     transcript and event order for fast tools. It is not a wait for
    //     completion: a tool doing real I/O stays pending and the run continues.
    //   - a `done` event carries `pending` when the run pauses with work in
    //     flight; the harness promise stays open until the whole tree drains.
    //   - a response immediately superseded by a completion that landed while its
    //     request was in flight emits no `done` (it is an intermediate turn, like
    //     a tool-call round).
    //   - cancellation is logical: a cancelled call is removed at once and its
    //     late result is discarded. JavaScript cannot be preempted, so a tool that
    //     ignores its signal may still keep running (documented, not hidden).

    // One logical agent run. State lives HERE rather than in module globals so
    // concurrent runs (delegation, ctx.run, two harness calls) cannot corrupt each
    // other. The lineage is the ancestry chain, which is what makes the cycle and
    // depth rules work without a global run stack.
    type RunState = {
        // Monotonic id; also the scheduler scope, so toolCancel can never reach a
        // sibling run's tasks.
        id: number;
        scope: string;
        agent: Agent;
        // Scheduling/mailbox identity (N6): the display name for a registered
        // agent, `branch:<id>` for a branch. Event `agent` stays the display
        // name; this key is what isolates a fork from its source's queues.
        actorKey: string;
        // Delegation depth (1 = a top-level run). A branch run starts at 1 again:
        // fork nesting is bounded by forkDepth (core/branch.ts), NOT by
        // MAX_RUN_DEPTH, so a normal fork may fork itself.
        depth: number;
        // True for an autoanswer owner branch: no tools, exactly one model
        // request, and any tool call is an invalid directive answer.
        autoAnswer: boolean;
        // Branch metadata when this run IS a branch (fork/autoanswer). Absent for
        // every ordinary run. Branch agent_history mutations are NOT persisted:
        // branches are ephemeral and excluded from snapshot v1.
        branch?: AgentBranchMetadata;
        // Invocation identity reported on every event of a NON-ROOT run (T3 UI
        // threads); undefined for a root run, whose events keep their historical
        // shape. Built once in runAgent so every frame of this invocation (start,
        // text, tool_call/result, usage, done, error) carries the same id.
        thread?: HarnessThread;
        // R2: the PERSISTENT thread this run executes in. Every ordinary run has
        // one (root = the primary's default conversation, delegation = the
        // child's default conversation, host call = the created thread); a
        // fork/autoanswer branch owns an ephemeral transcript instead and has
        // none.
        threadState?: ThreadState;
        // The persistent thread id, carried to ToolContext (sender identity) and
        // to the invocation record (delete-thread purge). Distinct from
        // `thread.id`, which is the per-RUN invocation id.
        threadId?: string;
        signal?: AbortSignal;
        lineage: readonly Agent[];
        parent?: RunState;
        active: boolean;
        aborted: boolean;
        iteration: number;
        // Root-prompt attachments (T3). Validated once at runAgent entry and
        // consumed by runAgentCore when it appends the user message. Always
        // empty for delegated/ctx.run children: the root's bytes are never
        // re-sent with an unrelated subagent prompt.
        attachments: HarnessAttachment[];
        // True when new work (a completion or a wake) arrived and the loop should
        // take another turn instead of waiting/returning.
        dirty: boolean;
        waiters: Array<() => void>;
        // The error a tool threw while the run was being aborted. A cancellation
        // discards late RESULTS, but a tool that observed the abort and threw
        // gives the more specific error the caller should see (the historical
        // behaviour), so keep the first one and prefer it over the generic
        // AbortError.
        abortError?: unknown;
        // A progress/observer failure raised while delivering a background
        // outcome or a wake. The mailbox must stay serialized even when a callback
        // throws, so the error is parked here and rethrown by the loop: a failing
        // emitter still fails the run, exactly like a synchronous event would.
        deliveryError?: unknown;
        // Delegation answer extraction (T2/R1), opted into by the two agentDelegate
        // call sites only (see RunInternals). When true, the run also records the
        // last substantive tool-free response below and may resolve to it instead
        // of a whitespace-only terminal turn.
        delegateAnswer: boolean;
        // Steering drained from the thread queue INTO this run. A successful run
        // consumes it; a failed run rolls the appended messages back with the
        // transcript, so the text is re-queued for the next host turn (a stop
        // discards it by contract). Order is preserved either way.
        steering: string[];
        // The latest substantive response THIS run produced: no tool calls, a
        // normal stop, and non-blank text. Captured on the run itself so the
        // fallback never rescans agent history after the run returns — the agent
        // queue releases before the delegate promise resolves (runAgent's finally
        // releases the actor), so a queued follow-up may already be appending to
        // the same transcript by the time a caller looks. Undefined until such a
        // response occurs; reset naturally with each new RunState.
        answer?: HarnessAssistantMessage;
    };

    // Internal run knobs. Deliberately NOT part of the public HarnessRunOptions:
    // a host call and an arbitrary ctx.run keep their exact historical semantics,
    // and only the built-in delegation paths opt in.
    type RunInternals = {
        // T2/R1: when this run's FINAL turn is a normal `stop` with whitespace-only,
        // tool-free text, resolve to `RunState.answer` (the last substantive
        // tool-free response of this same run) instead of that blank turn. A
        // genuinely later non-blank answer, a run that never said anything
        // substantive, a `length` stop, and a failure/abort all keep their
        // existing result.
        delegateAnswer?: boolean;
        // N6: this run executes a branch. `metadata` is the fork identity created
        // by core/branch.ts; `autoAnswer` marks the tool-free single-iteration
        // owner read. A branch run is owned/cancellable by its requester but does
        // not consume a delegation depth level.
        branch?: { metadata: AgentBranchMetadata; autoAnswer: boolean };
    };

    // The delegate answer policy (T2/R1). One shared instance so the model path
    // (launchToolCall) and the manual path (executeTool) opt into identical
    // semantics.
    const DELEGATE_ANSWER: RunInternals = { delegateAnswer: true };

    // -----------------------------------------------------------------------
    // R2 persistent threads
    // -----------------------------------------------------------------------
    //
    // A THREAD is one persistent, agent-owned conversation. The session (one
    // harness) owns the shared memory — tools, todo list, profiles, chapters,
    // locations, discovery, creation budget — and every thread shares it; only
    // the TRANSCRIPT and the execution slot are per thread.
    //
    //   'agent' — the agent's default conversation. Its Agent is the registry
    //             instance, so delegation/ctx.run/host calls keep writing to the
    //             historical transcript. Id: `agent:<name>`, derived (never
    //             persisted), which is why snapshot v1 can omit it.
    //   'host'  — an additional conversation from `harness.createThread`, backed
    //             by a FRESH Agent instance with the same instructions, seed
    //             messages, transport, and current model. Two host threads of one
    //             agent run concurrently because their actor keys differ.
    //
    // Steering and cross-thread chat are queued here and drained by the run loop
    // at the next safe model boundary (never inside an in-flight request).
    type ThreadState = {
        // Internal and mutable; every public read returns a copy.
        record: HarnessThreadRecord;
        agent: Agent;
        // Text queued for the next model boundary, in arrival order. A message
        // queued while the thread is idle is appended directly instead, so this
        // only holds input for a RUNNING thread.
        queue: string[];
        // The active run (at most one per thread; `acquireAgent` serializes).
        run?: RunState;
        // Cancellation for the active run. Linked to the caller's signal, so a
        // host abort, `stopThread`, and an owner's stop all reach the same work.
        controller?: AbortController;
        // Stop epoch (M1). Every stop bumps this, and a submission captures it at
        // call time; a queued run whose epoch is stale is REJECTED instead of
        // running (a stop must cancel work that was already queued, not only the
        // active request). A NEW host send after the stop captures the new epoch
        // and is therefore the one legal revival path.
        generation: number;
    };

    const threadStates = new Map<string, ThreadState>();

    // Creation-order sequence for records (defaults first, then host threads). It
    // is the public `sequence` field and the deterministic sort key.
    let threadSequence = 0;
    // Host-thread id high-water mark (`thread-<N>`). Separate from the ordering
    // sequence so the first host thread is `thread-1` even though the configured
    // agents already occupy sequence slots. Persisted as `threadSequence`, so a
    // restart can never reuse a deleted thread's id.
    let threadIdSequence = 0;

    // A thread record is copied on every read: a caller must never mutate live
    // scheduling/ownership state through the handle.
    const threadRecordCopy = (record: HarnessThreadRecord): HarnessThreadRecord => ({ ...record });

    const threadStateOf = (threadId: string): ThreadState => {
        const state = threadStates.get(threadId);

        if (state === undefined) {
            throw new HarnessError(
                `Thread "${threadId}" is not available in this harness; it was never created, or it was deleted.`
            );
        }

        return state;
    };

    // The default conversation of a REGISTRY agent. A branch/fork/thread Agent is
    // not a registry entry, so it has no default thread of its own.
    const defaultThreadOf = (brain: Agent): ThreadState | undefined => {
        if (agents[brain.name] !== brain) return undefined;
        return threadStates.get(defaultThreadIdOf(brain.name));
    };

    // Default conversations are derived state: one idle record per configured
    // agent, in configuration order, with deterministic sequence numbers. They are
    // created BEFORE any run, so `threads()`/`sendThreadInput` always resolve.
    for (const name of Object.keys(agents)) {
        threadStates.set(defaultThreadIdOf(name), {
            record: {
                id: defaultThreadIdOf(name),
                agent: name,
                origin: 'agent',
                status: 'idle',
                sequence: ++threadSequence
            },
            agent: agents[name],
            queue: [],
            generation: 0
        });
    }

    // The live conversations of this session, newest last, as detached records.
    // Shared by the host-facing `threads()` and the model-facing `threadList`
    // tool, so both read exactly the same roster (deleted threads are already
    // absent from the map). `currentThreadId` comes from the RUN, never from a
    // tool argument.
    const threadRoster = (currentThreadId?: string): HarnessThreadRoster => ({
        ...(currentThreadId === undefined ? {} : { currentThreadId }),
        threads: [...threadStates.values()]
            .sort((left, right) => left.record.sequence - right.record.sequence)
            .map((state) => threadRecordCopy(state.record))
    });

    // Cross-thread chat + roster are CONDITIONAL core tools (core/metadata.ts):
    // a session with one conversation per agent pays no context for them, and the
    // historical declaration list of a harness that never opens a thread is
    // unchanged. Registration is idempotent; once registered they stay (deleting
    // the last host thread must not yank a tool between two model turns).
    //
    // They are registered TOGETHER: an id is only useful if it can be discovered,
    // so exposing threadSend without its roster would force the server (or the
    // model) to invent targets.
    const threadSendFor = (
        caller: Agent | undefined,
        threadId: string | undefined,
        parameters: Record<string, unknown>
    ): HarnessThreadMessageResult => {
        const target = typeof parameters?.thread === 'string' ? parameters.thread.trim() : '';
        const message = typeof parameters?.message === 'string' ? parameters.message : '';

        if (target.length === 0) {
            throw new HarnessError('threadSend requires a non-empty target thread id.');
        }

        if (message.trim().length === 0) {
            throw new HarnessError('threadSend requires a non-empty message.');
        }

        // SENDER IDENTITY (R4): derived from the runtime context, never from a
        // tool argument. A manual executeTool call has no `threadId` and runs as
        // the primary agent (an operator action).
        return postThreadMessage(
            {
                agent: caller?.name ?? primaryName,
                ...(threadId === undefined ? {} : { threadId })
            },
            target,
            message
        );
    };

    // Conditional baseline source entries and their order. Kept in one place so
    // createThread and restore prepare the same revisions.
    const THREAD_TOOL_SOURCES = [
        { name: THREAD_LIST, sourcePath: 'runtime-tools/threadList.ts' },
        { name: THREAD_SEND, sourcePath: 'runtime-tools/threadSend.ts' }
    ] as const;

    const threadToolFallback = (name: string): Tool =>
        name === THREAD_LIST
            ? defineTool({
                  ...THREAD_LIST_METADATA,
                  execute: (context) => threadRoster(context.threadId)
              })
            : defineTool({
                  ...THREAD_SEND_METADATA,
                  execute: (context) =>
                      threadSendFor(
                          context.agent,
                          context.threadId,
                          (context.parameters ?? {}) as Record<string, unknown>
                      )
              });

    // Restore must not compile after Phase 4 has mutated live state. These two
    // helpers split preparation (may throw, no mutation) from publication (no
    // remaining I/O/compilation).
    const prepareMissingThreadTools = (reserved?: ReadonlySet<string>): PreparedTool[] =>
        THREAD_TOOL_SOURCES.filter(
            ({ name }) =>
                reserved?.has(name) !== true &&
                // "Missing" is against the FINAL registry after Phase 4, not the
                // pre-restore registry: a currently-created entry is about to be
                // deleted, so its name must be prepared as a baseline revision.
                (tools[name] === undefined || createdToolRecords.has(name))
        ).map(({ name, sourcePath }) =>
            sourceStartupSupported
                ? prepareToolCandidate({ name, sourcePath }, { expectedName: name })
                : prepareDefinition(threadToolFallback(name))
        );

    const publishPreparedBaseline = (prepared: PreparedTool): void => {
        tools[prepared.tool.name] = prepared.tool;

        if (prepared.record.format === 'module' || prepared.record.source !== undefined) {
            toolSourceRecords.set(prepared.tool.name, prepared.record);
        } else {
            toolSourceRecords.delete(prepared.tool.name);
        }
    };

    const registerThreadTools = (): void => {
        for (const { name, sourcePath } of THREAD_TOOL_SOURCES) {
            if (tools[name] === undefined) {
                if (sourceStartupSupported) {
                    registerBaselineAtRuntime({ name, sourcePath });
                } else {
                    registerBaselineAtRuntime({
                        definition: threadToolFallback(name)
                    });
                }
            }
        }
    };

    // Deliver one cross-thread message. The text is attributed explicitly, so the
    // receiving model can tell another conversation's data from its own owner's
    // instructions.
    const postThreadMessage = (
        sender: { agent: string; threadId?: string },
        targetThreadId: string,
        message: string
    ): HarnessThreadMessageResult => {
        const target = threadStateOf(targetThreadId);
        const receipt: HarnessThreadMessageResult = {
            threadId: targetThreadId,
            delivered: target.record.status === 'running' ? 'queued' : 'appended',
            sender: sender.agent,
            ...(sender.threadId === undefined ? {} : { senderThreadId: sender.threadId })
        };

        if (target.record.status === 'stopped') {
            throw new HarnessError(
                `Thread "${targetThreadId}" is stopped; it cannot receive messages until a host resumes or deletes it.`
            );
        }

        const content = `from agent "${sender.agent}"${
            sender.threadId === undefined ? '' : ` (thread ${sender.threadId})`
        }:\n${message}`;

        if (target.record.status === 'running' && target.run !== undefined) {
            // Running: land at the next model boundary, never inside the request
            // that is already in flight (R5 ordering guarantee).
            target.queue.push(content);
            notifyStateChange('thread');
            markRunDirty(target.run);
            return receipt;
        }

        // Idle: append immediately. Nothing is executing, so the message is
        // visible on the thread's next run without any scheduling work.
        target.agent.user(content);
        notifyStateChange('agent_message', { agent: target.agent.name });
        return receipt;
    };

    // Create one host thread and return its LIVE state. Shared by the public
    // `createThread` and the runtime's host-parent delegation (R4), so both paths
    // enforce the same agent/owner/label/cap rules and both produce a persistable
    // record. `notify` lets the runtime skip a redundant save signal mid-run (the
    // run itself already emits agent/thread state changes).
    const createThreadState = (
        agentName: string,
        options?: HarnessThreadCreateOptions,
        notify = true
    ): ThreadState => {
        if (!Object.prototype.hasOwnProperty.call(agents, agentName)) {
            throw new HarnessError(
                `Agent "${String(agentName)}" is not registered. Configured agents: ${Object.keys(agents).join(', ')}.`
            );
        }

        // Bound the persisted set: snapshot v1 refuses more than
        // MAX_THREAD_RECORDS host threads, and a harness must never emit a
        // snapshot its own restore rejects. Deleting a terminal thread frees a
        // slot; the id high-water mark does not move.
        const hostThreadCount = [...threadStates.values()].filter(
            (state) => state.record.origin === 'host'
        ).length;

        if (hostThreadCount >= MAX_THREAD_RECORDS) {
            throw new HarnessError(
                `This session already has ${hostThreadCount} independent threads; delete a terminal one before creating another (maximum ${MAX_THREAD_RECORDS}).`
            );
        }

        const label = normalizeThreadLabel(options?.label);
        const ownerThreadId = options?.ownerThreadId;

        if (ownerThreadId !== undefined) {
            // Validate the link before minting an id: a bad owner must not leave a
            // half-created record behind.
            const owner = threadStateOf(ownerThreadId);

            // H1: only an INDEPENDENT host thread may own another thread. A default
            // conversation (`agent:<name>`) is implicit and never persisted as a
            // thread record, so a child pointing at it could not be restored (the
            // persisted owner link would name a record the snapshot omits). Reject
            // it at creation instead of emitting a self-incompatible snapshot.
            // Runtime-created delegation children always use a HOST parent thread.
            if (owner.record.origin !== 'host') {
                throw new HarnessError(
                    `Thread "${ownerThreadId}" is an agent's default conversation; only an independent host thread can own another thread.`
                );
            }
        }

        const id = `${THREAD_HOST_PREFIX}${++threadIdSequence}`;
        const source = agents[agentName];
        const threadAgent = createThreadAgent(source);

        // Scheduling identity and role travel with the fresh Agent, so a thread of
        // the primary keeps primary tools while never queueing behind the default
        // conversation (and vice versa).
        actorRoles.set(threadAgent, roleOf(source));
        actorKeys.set(threadAgent, `thread:${id}`);

        const state: ThreadState = {
            record: {
                id,
                agent: agentName,
                origin: 'host',
                status: 'idle',
                sequence: ++threadSequence,
                ...(ownerThreadId === undefined ? {} : { ownerThreadId }),
                ...(label === undefined ? {} : { label })
            },
            agent: threadAgent,
            queue: [],
            generation: 0
        };

        threadStates.set(id, state);
        registerThreadTools();
        if (notify) notifyStateChange('thread');
        return state;
    };

    const createThread = (
        agentName: string,
        options?: HarnessThreadCreateOptions
    ): HarnessThreadRecord => threadRecordCopy(createThreadState(agentName, options).record);

    // Every persistent parent above `state`, nearest first. A corrupt/cyclic link
    // (only possible after a hand-edited snapshot) terminates instead of looping.
    const ownersOf = (state: ThreadState): ThreadState[] => {
        const chain: ThreadState[] = [];
        const seen = new Set<string>([state.record.id]);
        let current = state.record.ownerThreadId;

        while (current !== undefined && !seen.has(current)) {
            seen.add(current);
            const owner = threadStates.get(current);
            if (owner === undefined) break;
            chain.push(owner);
            current = owner.record.ownerThreadId;
        }

        return chain;
    };

    // Mark one thread stopped and abort its run, if any. Returns whether a live run
    // was actually aborted (a thread with no active work is still marked stopped).
    const stopThreadState = (state: ThreadState, reason: HarnessError): boolean => {
        state.record.status = 'stopped';
        // M1: invalidate every submission that existed before this stop. A queued
        // `sendThreadInput` carries the epoch it observed at call time; after the
        // bump it refuses to run, so "stopped" cannot be rewritten to running by
        // work that was already waiting. A NEW host send captures the new epoch,
        // which is the only legal revival path.
        state.generation += 1;
        // Guidance queued for a conversation that is being stopped is discarded:
        // a later host revive starts from the host's new input, not from stale
        // steering the aborted run never consumed.
        state.queue.length = 0;

        if (state.run === undefined || !state.run.active || state.controller === undefined) {
            return false;
        }

        // Abort reaches the model request, every tool controller, and every child
        // run linked to this run's signal (delegation inherits it).
        state.controller.abort(reason);
        return true;
    };

    const stopThread = (threadId: string, reason?: string): boolean => {
        const state = threadStateOf(threadId);
        const error = new HarnessError(reason ?? `Thread "${threadId}" was stopped.`);

        let aborted = stopThreadState(state, error);

        for (const other of threadStates.values()) {
            if (other === state) continue;
            if (!ownersOf(other).some((owner) => owner.record.id === threadId)) continue;
            if (stopThreadState(other, error)) aborted = true;
        }

        notifyStateChange('thread');
        return aborted;
    };

    const stopAllThreads = (reason?: string): number => {
        const error = new HarnessError(reason ?? 'All threads were stopped.');
        let aborted = 0;

        for (const state of threadStates.values()) {
            if (stopThreadState(state, error)) aborted++;
        }

        notifyStateChange('thread');
        return aborted;
    };

    // Drop one thread state and every LOOKUP that pointed at it. Shared by
    // deleteThread (invocation/branch purge) and restore (replacing the persisted
    // set), so both paths cannot drift. It never touches an agent transcript the
    // thread shares with anyone else: the caller's content purge is the thread's
    // own Agent, which becomes unreachable here.
    const purgeThread = (state: ThreadState): void => {
        const threadId = state.record.id;
        threadStates.delete(threadId);

        // Invocation lookups owned by THIS conversation. Branch runs inherit the
        // persistent owner, so a fork's/autoanswer's result is scoped here too.
        const ownedInvocations = new Set<string>();

        for (const [key, record] of invocationRecords) {
            if (record.threadId === threadId || record.invocationId === state.record.invocationId) {
                ownedInvocations.add(record.invocationId);
                invocationRecords.delete(key);
            }
        }

        // M2: purge branches by their PERSISTENT owner (`record.threadId`).
        // `sourceThreadId` is an INVOCATION id, so comparing it to the thread id
        // never matched; it is retained only as a defensive fallback through the
        // invocation ids this thread owned (nested forks and autoanswer branches
        // carry the owner too, so the primary predicate covers them).
        const removed = branchRecords.filter(
            (record) =>
                record.threadId === threadId ||
                record.branchId === threadId ||
                ownedInvocations.has(record.branchId) ||
                (record.sourceThreadId !== undefined && ownedInvocations.has(record.sourceThreadId))
        );

        if (removed.length > 0) {
            const removedIds = new Set(removed.map((record) => record.branchId));
            branchRecords = branchRecords.filter((record) => !removedIds.has(record.branchId));

            // A purged branch cannot hold a concurrency slot or a scope mapping.
            for (const branchId of removedIds) {
                activeBranches.delete(branchId);
                branchScopes.delete(branchId);
            }
        }
    };

    // Remove a terminal host thread and every lookup scoped to it. Content that
    // was already copied into another transcript (a delegated answer, a delivered
    // chat message) is NOT recalled: deletion is a purge of THIS conversation, not
    // a promise of forgetting what other histories learned from it.
    const deleteThread = (threadId: string): void => {
        const state = threadStateOf(threadId);

        if (state.record.origin === 'agent') {
            throw new HarnessError(
                `Thread "${threadId}" is the agent's own conversation and cannot be deleted; use reset() to clear the session.`
            );
        }

        if (state.record.status === 'running' || state.run !== undefined) {
            throw new HarnessError(`Thread "${threadId}" is running; stop it before deleting it.`);
        }

        // A linked child cannot outlive the conversation that owns it. Collect
        // EVERY descendant first and refuse the whole delete if any of them is
        // running, so a partial removal is impossible (recursive deletion could
        // otherwise drop earlier children before hitting the live one).
        const descendants: ThreadState[] = [];
        const seen = new Set<string>([threadId]);
        const pending: ThreadState[] = [state];

        while (pending.length > 0) {
            const current = pending.pop()!;

            for (const candidate of threadStates.values()) {
                if (candidate.record.ownerThreadId !== current.record.id) continue;
                if (seen.has(candidate.record.id)) continue;

                seen.add(candidate.record.id);
                descendants.push(candidate);
                pending.push(candidate);
            }
        }

        for (const child of descendants) {
            if (child.record.status === 'running' || child.run !== undefined) {
                throw new HarnessError(
                    `Thread "${child.record.id}" is running; stop it before deleting "${threadId}".`
                );
            }
        }

        purgeThread(state);
        for (const child of descendants) purgeThread(child);
        notifyStateChange('thread');
    };

    const steerThread = (threadId: string, input: string): HarnessThreadSteerReceipt => {
        const state = threadStateOf(threadId);

        if (typeof input !== 'string' || input.trim().length === 0) {
            throw new HarnessError('Steering requires non-empty text.');
        }

        if (state.record.status === 'stopped') {
            return {
                threadId,
                queued: false,
                reason: `Thread "${threadId}" is stopped; a host must resume it before steering.`
            };
        }

        if (state.record.status !== 'running' || state.run === undefined) {
            return {
                threadId,
                queued: false,
                reason: `Thread "${threadId}" is idle; use sendThreadInput to start a turn.`
            };
        }

        state.queue.push(input);
        notifyStateChange('thread');
        // A paused run (background work pending) must wake to reach its boundary;
        // a run inside a request drains this at the next loop iteration.
        markRunDirty(state.run);

        return { threadId, queued: true };
    };

    const sendThreadInput = async (
        threadId: string,
        input: string,
        options?: HarnessRunOptions
    ): Promise<HarnessAssistantMessage> => {
        const state = threadStateOf(threadId);

        if (typeof input !== 'string' || input.trim().length === 0) {
            throw new HarnessError('Thread input must be non-empty text.');
        }

        // An explicit HOST turn revives a stopped conversation. Model-driven
        // paths (delegation, threadSend, steering) do not: "stopped" must mean
        // stopped for agents.
        if (state.record.status === 'stopped') {
            state.record.status = 'idle';
            notifyStateChange('thread');
        }

        return runAgent(
            state.agent,
            input,
            options?.signal,
            undefined,
            undefined,
            undefined,
            options?.attachments,
            undefined,
            state
        );
    };

    const threadMessages = (threadId: string): HarnessMessage[] =>
        cloneMessages(threadStateOf(threadId).agent.messages);

    // Every live run, so a scheduler wake can mark the right runs dirty. Runs are
    // removed in runAgent's finally.
    const runs = new Set<RunState>();
    let runSequence = 0;
    let activeRuns = 0;

    // N6 branch state. Ephemeral, deliberately NOT part of snapshot v1. Records
    // are kept in creation order; active branch ids are the concurrency slots.
    let branchRecords: HarnessBranchRecord[] = [];
    const activeBranches = new Set<string>();
    // Pending actionRequests across the whole harness (host- and fork-answered).
    const pendingActionRequests = new Set<string>();
    let actionRequestSequence = 0;

    // Branch history is runtime state, not session state. The stateChange
    // observer still fires for SHARED STORE mutations (tool_execute) inside a
    // branch, but an `agent_message` append there would make a server snapshot a
    // transcript that snapshot()/restore() never include. Suppress exactly that
    // reason for branch runs.
    const notifyRunStateChange = (
        run: RunState,
        reason: HarnessStateChangeReason,
        detail: { agent?: string; tool?: string } = {}
    ): void => {
        if (run.branch !== undefined && reason === 'agent_message') return;
        notifyStateChange(reason, detail);
    };

    // Retained branch records, bounded by maxBranchRecords. Active records are
    // never evicted; the newest terminal records fill the remaining budget.
    const retainedBranches = (): HarnessBranchRecord[] =>
        pruneBranchRecords(branchRecords, forks.maxBranchRecords);

    // Update one live record in place. The record is internal; every public read
    // goes through cloneBranchRecord.
    const branchRecordOf = (branchId: string): HarnessBranchRecord | undefined =>
        branchRecords.find((record) => record.branchId === branchId);

    // Terminal transition. IDEMPOTENT by design: a branch reaches a terminal state
    // exactly once, whether the branch task's catch observes the abort, the owning
    // run's cleanup releases a task that never started, or an in-flight cancel
    // races that cleanup. Returns true only for the call that actually moved a
    // `running` record to terminal, which is the ONLY call allowed to emit
    // `branch_end` (no duplicate terminal audit frames).
    const finishBranch = (
        branchId: string,
        status: HarnessBranchTerminalStatus,
        detail: {
            messages?: readonly HarnessMessage[];
            result?: { content: string; stopReason: HarnessAssistantMessage['stopReason'] };
            error?: HarnessErrorInfo;
        }
    ): boolean => {
        const record = branchRecordOf(branchId);
        if (record === undefined || record.status !== 'running') return false;

        record.status = status;
        if (detail.messages !== undefined) record.messages = cloneMessages(detail.messages);
        if (detail.result !== undefined) record.result = { ...detail.result };
        if (detail.error !== undefined) record.error = { ...detail.error };

        // Prune on every terminal transition: a long session must not grow an
        // unbounded audit list, while a live branch stays addressable.
        branchRecords = pruneBranchRecords(branchRecords, forks.maxBranchRecords);
        return true;
    };

    // Select the terminal status for a failed branch task. A cancellation is a
    // cancellation (toolCancel or a run abort), not an ordinary tool failure.
    const branchFailureStatus = (signal: AbortSignal): HarnessBranchTerminalStatus =>
        signal.aborted ? 'cancelled' : 'failed';

    // Per-agent mailbox. Completion deliveries and wakeups for one agent are
    // serialized through this chain, so transcript inserts, events, and state
    // changes never interleave for a single agent. Different agents still run
    // concurrently.
    const mailboxes = new Map<string, Promise<void>>();

    const enqueueMailbox = (agentName: string, work: () => Promise<void>): void => {
        const previous = mailboxes.get(agentName) ?? Promise.resolve();
        const next = previous.then(work).catch(() => {
            // Delivery work is already careful about its own failures; swallowing
            // here guarantees one bad delivery cannot poison an agent's mailbox.
        });
        mailboxes.set(agentName, next);

        // Release the tail reference once this delivery is the settled tail, so a
        // long session does not grow an unbounded promise chain per agent.
        void next.then(() => {
            if (mailboxes.get(agentName) === next) mailboxes.delete(agentName);
        });
    };

    const markRunDirty = (run: RunState): void => {
        run.dirty = true;
        const waiters = run.waiters.splice(0);
        for (const resolve of waiters) resolve();
    };

    // Let every delivery already queued for this agent settle before asking the
    // model again. This is what COALESCES simultaneous completions into one turn
    // (otherwise each completion could spend its own request) and guarantees the
    // request projection sees every outcome the mailbox has accepted. A completion
    // that arrives after this drain marks the run dirty and gets its own turn.
    //
    // Loops until the mailbox map has no tail (the cleanup microtask removes a
    // settled tail): returning with ANY queued delivery is the P1-A lost-outcome
    // bug. The bound is a paranoia guard, not an expected exit.
    const drainMailbox = async (agentName: string): Promise<void> => {
        for (let pass = 0; pass < 1_000; pass++) {
            const tail = mailboxes.get(agentName);
            if (tail === undefined) return;
            await tail;
            // Let `next.then(cleanup)` run so a settled tail is removed; a tail
            // that was replaced by a newer job is awaited on the next pass.
            await Promise.resolve();
        }
    };

    // Cancellation check for a run. A tool that observed the abort and threw
    // supplies a more specific error, which is the historical contract; otherwise
    // the standard AbortError propagates.
    const throwIfAborted = (run: RunState): void => {
        if (run.signal?.aborted === true) {
            throw run.abortError ?? run.signal.reason;
        }
    };

    // The reason to throw for a cancelled request. DOM gives a DOMException with a
    // standard message when the caller aborted without one; reuse the exact reason
    // the signal carries so callers/tests see their own error.
    const abortErrorOf = (signal: AbortSignal): unknown =>
        signal.reason ?? new DOMException('This operation was aborted', 'AbortError');

    // Pre-commit ownership guard (passed to core/agent as `precommit`). A provider
    // that ignores its signal may finish a turn LONG after the run was aborted and
    // its actor released; the assistant message must not be appended to a
    // transcript another run is now using. This runs immediately before the only
    // commit point, so a late transport cannot mutate history.
    const assertCommitAllowed = (run: RunState): void => {
        if (!run.active || run.aborted || run.signal?.aborted === true) {
            throw run.signal === undefined
                ? new HarnessError(
                      `Agent "${run.agent.name}" no longer owns its turn; the late response was discarded.`
                  )
                : abortErrorOf(run.signal);
        }
    };

    // Ownership check for streamed progress. A run owns events only while it and
    // every ANCESTOR are live: an uncooperative provider can still yield frames
    // after its run (or an ancestor) aborted, and those must never be attributed
    // to a later turn that happens to be streaming on the same sink.
    //
    // The run itself is released on abort by requestTurn's signal race (T15), so
    // ownership is checked against released state too: the detached provider's
    // generator may still exist, but it can neither emit (this guard) nor commit
    // (core/agent's precommit guard) into a later run.
    const runOwnsEvents = (run: RunState): boolean => {
        if (!run.active || run.aborted) return false;

        let ancestor = run.parent;
        while (ancestor !== undefined) {
            if (!ancestor.active || ancestor.aborted) return false;
            ancestor = ancestor.parent;
        }

        return true;
    };

    // Identity fields for a frame AFTER `start`: the thread id plus its lineage
    // anchors. `input` is deliberately dropped so a long child prompt travels once
    // (on `start`) instead of on every delta, tool result, and done frame.
    const threadIdentity = (thread: HarnessThread): HarnessThread => {
        const identity: HarnessThread = { id: thread.id };
        if (thread.parentId !== undefined) identity.parentId = thread.parentId;
        if (thread.callId !== undefined) identity.callId = thread.callId;
        // N6: branch audit fields are part of EVERY frame, not just `start`.
        // Without them a client could not group a nested fork's later deltas
        // under the same branch. `input` still travels on `start` only.
        if (thread.kind !== undefined) identity.kind = thread.kind;
        if (thread.branchId !== undefined) identity.branchId = thread.branchId;
        return identity;
    };

    // Attach a run's invocation identity to an event. A ROOT run has no thread, so
    // its events keep the exact pre-thread shape (recorded fixtures and the server
    // contract depend on that); only child runs carry `thread`.
    const withThread = (run: RunState, event: HarnessEvent): HarnessEvent => {
        if (run.thread === undefined) return event;
        return {
            ...event,
            // A copy on `start` so a reporter that mutates the frame it receives
            // cannot corrupt the identity every later frame of this run is built from.
            thread: event.type === 'start' ? { ...run.thread } : threadIdentity(run.thread)
        } as HarnessEvent;
    };

    // Every streamed event goes through this guard (P2-A). The run's canonical
    // commit/rollback is separate: this only decides whether a frame is reported.
    //
    // The invocation identity is attached HERE (T3 UI threads) rather than at each
    // call site, so no event can escape without its thread and a root run needs no
    // special case at all.
    const emit = async (run: RunState, event: HarnessEvent): Promise<void> => {
        if (!runOwnsEvents(run)) return;
        await progress(withThread(run, event));
    };

    // Terminal error is the one frame a CANCELLED ROOT still reports (its call
    // failed). A child whose cancellation came from its tree is silent: the owner
    // already reports the cause, and a late child error would land in the next
    // session. A normally-failing child still reports its own error.
    //
    // Deliberately does NOT require `run.active`: the caller is runAgentCore's
    // catch, which marks the run inactive first so no delivery can touch the
    // transcript it is about to roll back. This runs at most once per run.
    const emitError = async (run: RunState, error: HarnessErrorInfo): Promise<void> => {
        if (run.aborted && run.parent !== undefined) return;

        let ancestor = run.parent;
        while (ancestor !== undefined) {
            if (!ancestor.active) return;
            ancestor = ancestor.parent;
        }

        await progress(withThread(run, { type: 'error', agent: run.agent.name, error }));
    };

    // The one board per harness. It owns the per-call AbortControllers and the
    // single recurring wake timer.
    const scheduler = createTaskScheduler({
        wakeIntervalMs,
        // Wake delivery goes through the per-agent mailbox for the same reason a
        // completion does: it may append nothing, but it emits an event and starts
        // a turn, and those must not race a completion for the same agent.
        //
        // The pending list is recomputed INSIDE the mailbox: the scheduler's tick
        // snapshot can be stale by the time a queued delivery runs (a completion
        // may have drained the board), and a stale list would tell the model (and
        // the UI) that finished work is still running.
        onWake: (actorKey) => {
            enqueueMailbox(actorKey, async () => {
                const live = [...runs].filter(
                    (run) => run.actorKey === actorKey && runOwnsEvents(run)
                );
                if (live.length === 0) return;

                const pending = scheduler.pendingList(actorKey);

                try {
                    // The wake frames for the run(s) live right now. One ACTOR has
                    // at most one active run (agentQueues serializes them), so the
                    // first live run is the owner; a root run contributes no
                    // thread. The event still names the DISPLAY agent, never the
                    // actor key.
                    await progress(
                        withThread(live[0], {
                            type: 'wakeup',
                            agent: live[0].agent.name,
                            reason: 'pending-tools',
                            pending
                        })
                    );
                } catch (error) {
                    // A failing reporter fails the run(s), as a synchronous event
                    // would. Park the error and wake the loop.
                    for (const run of live) {
                        if (run.deliveryError === undefined) run.deliveryError = error;
                        markRunDirty(run);
                    }
                    return;
                }

                // Always give a live run its wake turn, even when the recomputed
                // list is empty: the tick is a liveness prompt, and a completion
                // that drained in the meantime may still be queued behind this
                // mailbox job. Suppressing it could hide the last-drain wake.
                for (const run of live) markRunDirty(run);
            });
        }
    });

    // Tool calls still running for one run, as the wire view.
    const runPending = (run: RunState, at: number = Date.now()): HarnessPendingTool[] =>
        scheduler.pendingOfScope(run.scope).map((task) => ({
            callId: task.callId,
            name: task.name,
            elapsedMs: Math.max(0, at - task.startedAt)
        }));

    // Where a tool result belongs: immediately after the assistant message that
    // requested it, ordered by CALL ORDER (not arrival), and before any assistant
    // turn committed later. Returns -1 when no such assistant message exists (the
    // run was rolled back, or a host edited history), in which case the delivery
    // is discarded rather than appending an unpaired result at the end.
    const resultInsertIndex = (brain: Agent, callId: string): number => {
        let assistantIndex = -1;
        let order: readonly HarnessToolCall[] = [];

        for (let index = brain.messages.length - 1; index >= 0; index--) {
            const message = brain.messages[index];
            if (message.role !== 'assistant') continue;
            if (message.toolCalls?.some((call) => call.id === callId)) {
                assistantIndex = index;
                order = message.toolCalls;
                break;
            }
        }

        if (assistantIndex < 0) return -1;

        const position = new Map(order.map((call, index) => [call.id, index]));
        const target = position.get(callId) ?? Number.POSITIVE_INFINITY;

        let insertAt = assistantIndex + 1;
        while (insertAt < brain.messages.length) {
            const message = brain.messages[insertAt];
            if (message.role !== 'tool') break;

            const existing = position.get(message.toolCallId);
            // A recorded result for a LATER call must stay after this one, which is
            // what makes an out-of-order completion land in its own slot.
            if (existing !== undefined && existing > target) break;
            insertAt++;
        }

        return insertAt;
    };

    // The committed result for one call id, if any. R2: this is the canonical
    // "this call already settled" record (see the toolCancel branch), because the
    // harness inserts exactly one tool message per settled call and never commits
    // a pending placeholder. Bounded by the conversation, scoped to this agent.
    const toolResultOf = (
        brain: Agent,
        callId: string
    ): Extract<HarnessMessage, { role: 'tool' }> | undefined =>
        brain.messages.find(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool' && message.toolCallId === callId
        );

    const hasToolResult = (brain: Agent, callId: string): boolean =>
        toolResultOf(brain, callId) !== undefined;

    // Insert one real result into the canonical transcript. Returns false when
    // there is nothing to insert (already answered, or originating block gone).
    const insertToolMessage = (
        brain: Agent,
        call: HarnessToolCall,
        content: string,
        // N6: branch transcripts are ephemeral (snapshot v1 excludes them), so a
        // branch delivery must not ask a server to persist an agent_message.
        notify = true
    ): boolean => {
        if (hasToolResult(brain, call.id)) return false;

        const index = resultInsertIndex(brain, call.id);
        if (index < 0) return false;

        brain.messages.splice(index, 0, {
            role: 'tool',
            content,
            toolCallId: call.id,
            name: call.name
        });

        // Snapshot-managed mutation: notify after the splice, exactly like the
        // synchronous path used to.
        if (notify) notifyStateChange('agent_message', { agent: brain.name });
        return true;
    };

    // Build the request-only transcript. Real results are canonical; unanswered
    // calls get a placeholder tool message so a strict provider (assistant tool
    // calls MUST be followed by their results) accepts the request.
    //
    // Ordering is CALL ORDER, not completion order: each assistant block is
    // followed by one tool message per call, using the real result when it has
    // arrived and a placeholder otherwise. The canonical records may be in
    // arrival order (or interleaved with later assistant turns), so this is also
    // what keeps the wire pairing valid. Placeholders are NEVER committed: they
    // depend on wall-clock elapsed time and would be stale the moment they landed.
    const projectTranscript = (
        brain: Agent,
        pending: readonly HarnessPendingTool[]
    ): HarnessMessage[] => {
        const pendingById = new Map(pending.map((entry) => [entry.callId, entry]));
        const projected: HarnessMessage[] = [];

        let index = 0;
        while (index < brain.messages.length) {
            const message = brain.messages[index];
            index++;

            projected.push({ ...message });

            if (message.role !== 'assistant' || !message.toolCalls?.length) continue;

            // Consume the contiguous tool block that belongs to this assistant
            // message. In a harness transcript every contiguous tool message after
            // a call block belongs to it; keying by call id keeps a restored or
            // hand-edited transcript from mis-pairing.
            const realById = new Map<string, Extract<HarnessMessage, { role: 'tool' }>>();
            while (index < brain.messages.length && brain.messages[index].role === 'tool') {
                const candidate = brain.messages[index] as Extract<HarnessMessage, { role: 'tool' }>;
                if (message.toolCalls.some((call) => call.id === candidate.toolCallId)) {
                    realById.set(candidate.toolCallId, candidate);
                }
                index++;
            }

            for (const call of message.toolCalls) {
                const real = realById.get(call.id);

                if (real !== undefined) {
                    projected.push({ ...real });
                    continue;
                }

                const entry = pendingById.get(call.id);
                projected.push({
                    role: 'tool',
                    toolCallId: call.id,
                    name: call.name,
                    content: JSON.stringify({
                        status: 'pending',
                        callId: call.id,
                        name: call.name,
                        ...(entry === undefined ? {} : { elapsedMs: entry.elapsedMs }),
                        note:
                            entry === undefined
                                ? 'This tool call has not produced a result yet.'
                                : 'This tool call is still running in the background. Its real result arrives in a later turn; use toolCancel with this callId to abandon it.'
                    })
                });
            }
        }

        return projected;
    };

    // A malformed assistant turn (P2-B): duplicate/empty call ids, or an id that
    // aliases one already committed, would make result pairing ambiguous — the
    // scheduler keys on scope+callId and the transcript dedupes by callId, so one
    // call's result would silently replace the other. Validation happens BEFORE
    // any call is launched, so rejection has no side effects: the run rolls back
    // the assistant turn and nothing ran.
    const assertToolCallIds = (brain: Agent, calls: readonly HarnessToolCall[]): void => {
        const seen = new Set<string>();

        for (const call of calls) {
            if (typeof call.id !== 'string' || call.id.trim().length === 0) {
                throw new HarnessError(
                    `Agent "${brain.name}" requested a tool call with an empty id; the turn is malformed.`
                );
            }

            if (seen.has(call.id)) {
                throw new HarnessError(
                    `Agent "${brain.name}" requested tool call id "${call.id}" more than once in one turn; refusing to execute an ambiguous call.`
                );
            }

            seen.add(call.id);
        }

        // The current assistant message was committed by agent.turn() just before
        // `done`; every earlier message is prior history. Reusing an id from there
        // would alias an existing (possibly still pending) result.
        const history = brain.messages.slice(0, -1);

        for (const message of history) {
            if (message.role !== 'assistant' || !message.toolCalls) continue;

            for (const call of message.toolCalls) {
                if (!seen.has(call.id)) continue;

                throw new HarnessError(
                    `Agent "${brain.name}" reused tool call id "${call.id}" from an earlier turn; tool call ids must be unique within the conversation.`
                );
            }
        }
    };

    // Deliver one settled task. Runs inside the agent's mailbox, so the insert and
    // the event are one serialized step. A task whose run has already ended (or
    // was aborted) is discarded: the transcript it would touch was rolled back.
    const deliverTask = async (
        task: ReturnType<typeof scheduler.schedule>,
        run: RunState,
        call: HarnessToolCall
    ): Promise<void> => {
        // A run-level abort discards results that lost the race with cancellation.
        // Keep a tool's own abort error, though: a tool that observed the signal
        // and threw explains the cancellation better than "operation was aborted".
        if (run.aborted) {
            if (run.abortError === undefined && task.error !== undefined) run.abortError = task.error;
            return;
        }

        if (!run.active) return;

        const brain = run.agent;
        const durationMs = Math.max(0, Date.now() - task.startedAt);

        // R1: ONE structured outcome, computed here and projected onto `isError`
        // below. A settled task has three honest shapes: released by toolCancel
        // (cancelled — an expected control outcome, not a failure), threw while
        // running (failed — an operational failure), or returned a value
        // (completed). Invocation errors never reach this function; they are
        // answered by immediateResult() before a task exists.
        let content: string;
        let outcome: HarnessToolOutcome;
        let panels: ToolUiPanel[] | undefined;

        if (task.status === 'cancelled') {
            // A targeted cancellation is a result the model must see: without it
            // the provider projection would keep a placeholder forever. It is
            // error-SHAPED (no usable value exists) but classified `cancelled`, so
            // a UI renders it as a control outcome instead of a tool failure.
            content = boundToolResult(
                `Tool call "${call.name}" (${call.id}) was cancelled before it completed; no result is available.`
            ).content;
            outcome = 'cancelled';
        } else if (task.error !== undefined) {
            content = boundToolResult(
                `Tool "${call.name}" failed: ${toErrorInfo(task.error).message}`
            ).content;
            outcome = 'failed';
        } else {
            // Same unwrap/cap as the historical synchronous path (R10/R20.2).
            const ui = toolUiOf(task.result);
            content = boundToolResult(serialize(ui === undefined ? task.result : ui.content)).content;
            panels = ui?.panels;
            outcome = 'completed';
        }

        // The provider/transcript-facing boolean is DERIVED, never set separately:
        // a consumer that ignores `outcome` still gets an honest answer, and the
        // two fields cannot drift apart.
        const isError = outcome !== 'completed';

        insertToolMessage(brain, call, content, run.branch === undefined);

        // The outcome is CANONICAL at this point (P1-A). Wake the loop BEFORE the
        // reporter runs: a slow progress callback must not be able to keep
        // `dirty` false while the loop decides the response is final, and two
        // completions must not be lost behind one blocked mailbox job.
        markRunDirty(run);

        // Computed AFTER the board removed this task, so the list is what is still
        // running, not the call just delivered.
        const pending = scheduler.pendingList(run.actorKey);

        await emit(run, {
            type: 'tool_result',
            agent: brain.name,
            name: call.name,
            callId: call.id,
            content,
            isError,
            outcome,
            // Every EXECUTED call reports its span. An inline call is a real
            // (usually sub-millisecond) measurement, not a milder kind of call;
            // consumers can render 0ms without special-casing background work.
            durationMs,
            ...(panels === undefined ? {} : { ui: panels }),
            ...(pending.length === 0 ? {} : { pending })
        });

        // A tool may have mutated session state; notify for every settled call,
        // success or failure, exactly like the synchronous path's finally.
        notifyStateChange('tool_execute', { agent: brain.name, tool: call.name });
    };

    // Emit a result that never became background work (validation failure, or a
    // toolCancel acknowledgement). It is inserted and reported in one step.
    //
    // `outcome` is the structured classification (R1): every `fail()` call site is
    // a REJECTED invocation (the tool never ran), a cancellation acknowledgement
    // is COMPLETED (the control did what was asked), and a branch-control refusal
    // is REJECTED. `isError` is derived from it, so a caller cannot report an
    // error-shaped result without also saying why.
    const immediateResult = async (
        run: RunState,
        call: HarnessToolCall,
        raw: string,
        outcome: HarnessToolOutcome,
        withDuration = false
    ): Promise<void> => {
        const content = boundToolResult(raw).content;
        insertToolMessage(run.agent, call, content, run.branch === undefined);

        const pending = scheduler.pendingList(run.actorKey);

        await emit(run, {
            type: 'tool_result',
            agent: run.agent.name,
            name: call.name,
            callId: call.id,
            content,
            isError: outcome !== 'completed',
            outcome,
            ...(withDuration ? { durationMs: 0 } : {}),
            ...(pending.length === 0 ? {} : { pending })
        });
    };

    // Launch one tool call. Validation is still synchronous and every failure
    // mode still becomes a readable tool result; only the implementation runs in
    // the background.
    //
    // EXCEPTION: an abort is not a tool failure. It propagates (no result is
    // written for it) so the run rolls back instead of inviting a retry.
    const launchToolCall = async (
        run: RunState,
        call: HarnessToolCall,
        offered?: ReadonlyMap<string, Tool>
    ): Promise<void> => {
        // ABORT BOUNDARY (R10): no call starts into a cancelled run.
        throwIfAborted(run);

        await emit(run, { type: 'tool_call', agent: run.agent.name, call });

        const brain = run.agent;

        const fail = (content: string): Promise<void> =>
            immediateResult(run, call, content, 'rejected');

        const parseArguments = (schema: Record<string, unknown> | undefined): unknown =>
            parseToolCallArguments(schema, call);

        // RESOLUTION: a call returned by a model request uses the definition that
        // request ADVERTISED, even if the name was replaced while the request was
        // in flight. That keeps schema and implementation on one revision. A later
        // request captures the replacement. Runtime controls are recognised by a
        // marker on the resolved definition object, never by name before lookup.
        const definition = offered?.get(call.name) ?? tools[call.name];

        if (!definition) {
            // Unknown tool: answer the call so the transcript stays valid for strict
            // providers, and point the model at discovery.
            const available = declared(brain).map((tool) => tool.name).join(', ') || 'none';
            await fail(
                `Tool "${call.name}" is not registered. Available tools: ${available}. Call ${TOOL_REQUEST} with capability tags to search the catalogue.`
            );
            return;
        }

        // Roles/content policies are attached to the baseline DEFINITION objects,
        // not to names. A replacement under agentDelegate/toolCreate is an ordinary
        // tool and does not inherit the old gate.
        if (primaryOnlyDefinitions.has(definition) && roleOf(brain) !== 'primary') {
            await fail(
                `Tool "${call.name}" is only available to the primary agent "${primaryName}".`
            );
            return;
        }

        // toolCancel is a HARNESS control only while the resolved definition is the
        // baseline control object. A replacement executes through the ordinary path.
        if (runtimeControlDefinitions.get(definition) === 'toolCancel') {
            // Call ids are resolved inside the CALLING run's scope, so a run can
            // never cancel a sibling's work.
        //
        // R2 — IDEMPOTENCE: cancellation is a state to reach, not a transition to
        // perform exactly once. A call that is still pending is released; a call
        // that ALREADY settled in this conversation (completed, failed, or already
        // cancelled) is a SUCCESS with `alreadySettled: true`, because the caller's
        // intent ("this call must not keep the run waiting") already holds. Only an
        // id this run never started is an error — a foreign/unknown id must never
        // be reported as a successful cancellation it did not perform.
        if (call.name === TOOL_CANCEL) {
            let parameters: unknown;

            try {
                parameters = parseArguments(definition.parameters);
            } catch (error) {
                const info = toErrorInfo(error);
                await fail(
                    error instanceof SyntaxError
                        ? `Tool "${call.name}" received malformed JSON arguments: ${info.message}`
                        : `Tool "${call.name}" received arguments that do not match its schema: ${info.message}`
                );
                return;
            }

            const callId = typeof parameters === 'string' ? parameters : '';
            const task = scheduler.find(run.scope, callId);

            if (!task) {
                // No pending task under this run's scope. The canonical record of a
                // SETTLED call is its tool message in this agent's transcript:
                // deliverTask/immediateResult insert one for every completed,
                // failed, rejected, and cancelled call, and a placeholder is never
                // committed. Consulting it (rather than a growing ledger) keeps the
                // memory bounded by the conversation itself and keeps the answer
                // honest: a foreign run's id never appears here.
                const settled = toolResultOf(brain, callId);

                if (settled !== undefined) {
                    await immediateResult(
                        run,
                        call,
                        JSON.stringify({
                            cancelled: true,
                            callId,
                            name: settled.name,
                            alreadySettled: true
                        }),
                        // The control outcome is a success, not an error: nothing
                        // is left running and nothing needs to be reported as
                        // "already cancelled/completed".
                        'completed',
                        // Control result: report its (zero) span like any other
                        // completed call.
                        true
                    );
                    return;
                }

                await fail(
                    `No tool call "${callId}" was started in this run, so there is nothing to cancel. Pass the callId of a call this run started (see the pending list or the tool_call event).`
                );
                return;
            }

            // Remove it before acknowledging, so the acknowledgement's own
            // `pending` list is already accurate. Delivery of the cancelled
            // result is queued on the mailbox and the late implementation result
            // (if any) is ignored by the scheduler.
            scheduler.cancel(run.scope, callId);
            await immediateResult(
                run,
                call,
                JSON.stringify({ cancelled: true, callId, name: task.name }),
                'completed',
                // The acknowledgement is a control result; report its (zero)
                // span so a UI can render it like any other completed call.
                true
            );
            return;
        }
        }

        // N6 branch controls. Both need the owning RunState (an exact transcript
        // snapshot and, for actionRequest, the owner lineage), so a baseline
        // control definition dispatches to a runtime handler. A replacement has no
        // marker and therefore executes through definition.execute like any tool.
        const runtimeControl = runtimeControlDefinitions.get(definition);

        if (runtimeControl === 'threadFork' && forks.enabled) {
            await launchThreadFork(run, call, parseArguments);
            return;
        }

        if (runtimeControl === 'actionRequest' && interaction !== undefined) {
            await launchActionRequest(run, call, parseArguments);
            return;
        }

        // Discovery gates the model: a captured declaration is already authorised,
        // otherwise the current registry entry must be core or enabled.
        if (
            offered?.get(call.name) !== definition &&
            definition.visibility !== 'core' &&
            !activeTools.has(call.name)
        ) {
            const tags = definition.tags.slice(0, 3).map((tag) => `"${tag}"`).join(', ');
            await fail(
                `Tool "${call.name}" is registered but not enabled yet. Call ${TOOL_REQUEST} with tags like ${tags} to enable it.`
            );
            return;
        }

        let parameters: unknown;

        try {
            parameters = parseArguments(definition.parameters);
        } catch (error) {
            const info = toErrorInfo(error);
            await fail(
                error instanceof SyntaxError
                    ? `Tool "${call.name}" received malformed JSON arguments: ${info.message}`
                    : `Tool "${call.name}" received arguments that do not match its schema: ${info.message}`
            );
            return;
        }

        // Launch. The task's own signal is what the tool sees; it is linked to
        // the run signal by the scheduler, and toolCancel aborts only this call.
        scheduler.schedule({
            scope: run.scope,
            agent: run.actorKey,
            callId: call.id,
            name: call.name,
            parent: run.signal,
            run: async (signal) => {
                const context: ToolContext = {
                    parameters,
                    agent: brain,
                    agents,
                    // THE live harness reference: strict identity is preserved across
                    // replacement (the handle is created once, after startup, and is
                    // never cloned for a tool invocation).
                    harness: handle,
                    // Nested calls resolve through the live registry at call time and
                    // inherit this invocation's cancellation/caller/thread/depth.
                    callTool: (name: string, nestedParameters: unknown) =>
                        callToolInternal(name, nestedParameters, {
                            agent: brain,
                            signal,
                            runDepth: run.depth,
                            ...(run.threadId === undefined ? {} : { threadId: run.threadId })
                        }),
                    // Always present now: a background call is always cancelable.
                    signal,
                    runDepth: run.depth,
                    // R2/R4: the persistent conversation this call belongs to. The
                    // runtime supplies it (never a tool argument), so threadSend can
                    // attribute the sender honestly.
                    ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
                    run: (agentName: string, input: string) => {
                        const target = agents[agentName];
                        if (!target) {
                            throw new HarnessError(`Agent "${agentName}" is not registered.`);
                        }
                        // The child inherits THIS call's signal, so cancelling a
                        // delegation also cancels the work it started. `call.id`
                        // labels the child's events with the tool call that spawned
                        // it (T3 UI threads); the runtime guards above are unchanged.
                        //
                        // T2/R1: only the built-in agentDelegate opts into answer
                        // extraction (a whitespace-only final turn resolves to the
                        // run's last substantive tool-free response). Any other tool
                        // using ctx.run keeps the literal final-turn return.
                        return runAgent(
                            target,
                            input,
                            signal,
                            run,
                            call.id,
                            delegateAnswerDefinitions.has(definition) ? DELEGATE_ANSWER : undefined
                        );
                    }
                };

                return definition.execute(context);
            },
            onSettled: (task) => {
                enqueueMailbox(run.actorKey, () =>
                    deliverTask(task, run, call).catch((error) => {
                        // Keep the mailbox chain healthy and fail the RUN on the
                        // loop, where the rollback path is.
                        if (run.deliveryError === undefined) run.deliveryError = error;
                        markRunDirty(run);
                    })
                );
            }
        });
    };

    // -----------------------------------------------------------------------
    // N6: branch runtime (threadFork / actionRequest)
    // -----------------------------------------------------------------------
    //
    // A branch tool call is still BACKGROUND work: it is scheduled on the same
    // board, answered through the same per-actor mailbox, and delivered into the
    // requester's transcript at the original call position. What differs is WHO
    // runs: threadFork runs a detached clone of the CALLING agent, and
    // actionRequest either awaits the host (root) or runs a tool-free autoanswer
    // fork of the immediate OWNER run's agent (a child/fork request).
    //
    // Snapshot timing is synchronous at request instant: the fork is created (and
    // therefore materializes its source transcript) before this function awaits
    // anything, so later messages can never leak into the branch and the branch
    // can never see the future.

    // A branch's lifecycle is ephemeral (snapshot v1 excludes it) but its AUDIT
    // event must still be reported. Ownership suppression would hide a branch_end
    // after the requester aborted, so branch audit frames bypass `emit` and are
    // written directly; a reporter failure is parked on the requester exactly
    // like a delivery failure.
    // A branch's AUDIT frame carries the BRANCH's own thread, not the requester's:
    // `branch_start`, `branch_end`, and every frame of the branch run therefore
    // group under one id/kind/branchId. `parentId` names the REQUester thread when
    // it has one, which is how a nested fork stays indented.
    const branchThreadOf = (
        branchId: string,
        kind: 'fork' | 'autoanswer',
        parentRun: RunState,
        callId: string
    ): HarnessThread => {
        const thread: HarnessThread = {
            id: branchId,
            kind,
            branchId
        };
        if (parentRun.thread !== undefined) thread.parentId = parentRun.thread.id;
        thread.callId = callId;
        return thread;
    };

    const emitBranchEnd = async (
        run: RunState,
        branchId: string,
        status: HarnessBranchTerminalStatus,
        kind: 'fork' | 'autoanswer',
        callId: string,
        error?: HarnessErrorInfo
    ): Promise<void> => {
        try {
            await progress({
                type: 'branch_end',
                agent: run.agent.name,
                branchId,
                status,
                ...(error === undefined ? {} : { error }),
                thread: branchThreadOf(branchId, kind, run, callId)
            });
        } catch (thrown) {
            if (run.deliveryError === undefined) run.deliveryError = thrown;
        }
    };

    // A branch record is born `running`, before its run owns an actor, so a UI can
    // render the summary immediately. `toolCallIds` is the materializer's exact
    // origin->branch map; `messages` is a detached baseline that the terminal
    // transition replaces with the branch's committed transcript.
    const createBranchRecord = (
        summary: HarnessBranchSummary,
        messages: readonly HarnessMessage[],
        toolCallIds: ReadonlyArray<{ origin: string; branch: string }>,
        requesterScope: string
    ): HarnessBranchRecord => {
        const record: HarnessBranchRecord = {
            ...summary,
            toolCallIds: toolCallIds.map((entry) => ({ ...entry })),
            messages: cloneMessages(messages),
            status: 'running'
        };

        branchRecords.push(record);
        // Bound retained history at creation too: a long session that starts a
        // branch after many terminal records must not grow the audit list.
        branchRecords = pruneBranchRecords(branchRecords, forks.maxBranchRecords);
        activeBranches.add(summary.branchId);
        branchScopes.set(summary.branchId, requesterScope);
        return record;
    };

    // Branch ids created by a run that failed/was aborted before their task could
    // start. The scheduler does not notify for abandonScope, so the run's finally
    // releases them here: no record may stay `running` and no concurrency slot may
    // leak after the owning run is gone.
    const branchScopes = new Map<string, string>();

    // A branch may be created before its `branch_start` frame is reported. Only a
    // branch whose start was actually emitted may emit a terminal frame: this set
    // is what prevents a terminal-without-start audit pair.
    const branchStarted = new Set<string>();

    // Release every branch owned by this run. AWAITED by runAgent's finally: a
    // task the scheduler abandons before `run` is invoked has no catch to report
    // its lifecycle, so this cleanup is the only place that can emit the single
    // terminal `branch_end` for the already-emitted `branch_start` (D1). It uses
    // the same idempotent finishBranch as an in-flight catch, so exactly one of
    // them can report the terminal frame.
    const releaseBranchesForScope = async (run: RunState): Promise<void> => {
        for (const [branchId, ownerScope] of [...branchScopes.entries()]) {
            if (ownerScope !== run.scope) continue;

            activeBranches.delete(branchId);
            branchScopes.delete(branchId);

            const record = branchRecordOf(branchId);
            const started = branchStarted.has(branchId);
            branchStarted.delete(branchId);

            if (record === undefined) continue;

            const kind = record.kind;
            const callId = record.callId ?? '';

            const transitioned = finishBranch(branchId, 'cancelled', {
                error: {
                    message:
                        'The requesting run ended before this branch could start; the branch was cancelled.'
                }
            });

            if (transitioned && started) {
                await emitBranchEnd(run, branchId, 'cancelled', kind, callId);
            }
        }
    };

    // Pending actionRequests are bounded globally and must also be released when
    // their requester is abandoned (the scheduler does not notify for that path).
    const actionRequestScopes = new Map<string, string>();

    const releaseActionRequestsForScope = (scope: string): void => {
        for (const [requestId, ownerScope] of [...actionRequestScopes.entries()]) {
            if (ownerScope !== scope) continue;
            actionRequestScopes.delete(requestId);
            pendingActionRequests.delete(requestId);
        }
    };

    const failBranchTool = (
        run: RunState,
        call: HarnessToolCall,
        message: string
    ): Promise<void> => immediateResult(run, call, message, 'rejected');

    // Turn a validated choice into the model-facing result. An option answer is
    // widened with the label/description the model never sent, so it can reason
    // about the human-visible wording.
    const actionResultOf = (
        request: HarnessActionRequest,
        choice: HarnessActionChoice,
        answeredBy: 'owner' | 'auto'
    ): HarnessActionResult => {
        if (choice.kind === 'custom') {
            return { requestId: request.requestId, answeredBy, choice: { kind: 'custom', text: choice.text } };
        }

        const option = request.options.find((entry) => entry.id === choice.optionId);

        // validateActionChoice already rejected an unknown id; this guard keeps the
        // runtime honest if a future caller passes an unvalidated choice.
        if (option === undefined) {
            throw new HarnessError(
                `actionRequest option "${choice.optionId}" is not one of this request's options.`
            );
        }

        return {
            requestId: request.requestId,
            answeredBy,
            choice: {
                kind: 'option',
                optionId: option.id,
                label: option.label,
                ...(option.description !== undefined ? { description: option.description } : {})
            }
        };
    };

    // The strict autoanswer directive. This is a USER message appended to the
    // owner+child transcript, never a new system instruction: child system text
    // was already demoted to quoted user data by incorporateBranchHistory.
    const actionDirective = (request: HarnessActionRequest): string =>
        [
            'You are the OWNER of the actionRequest below. No tools are available and you get exactly one reply.',
            '',
            `Question: ${request.question}`,
            '',
            'Options:',
            ...request.options.map(
                (option) =>
                    `- ${option.id}: ${option.label}${
                        option.description === undefined ? '' : ` — ${option.description}`
                    }`
            ),
            '',
            `Advisory recommendation (never applied automatically): ${request.recommended}`,
            '',
            'Reply with EXACTLY one line and nothing else:',
            'option:<id>  — one of the option ids above, or',
            'custom:<text> — your own answer.'
        ].join('\n');

    // Parse the autoanswer's one-line directive. Blank, multi-line prose, an
    // unknown option id, or a malformed custom answer is an EXPLICIT failure. It
    // is never replaced by `recommended`: that would fabricate an answer nobody
    // gave.
    const parseDirectiveAnswer = (
        content: string,
        request: HarnessActionRequest
    ): HarnessActionChoice => {
        const text = content.trim();

        if (text.length === 0) {
            throw new HarnessError('The owner fork returned a blank action answer.');
        }

        const optionMatch = /^option:([A-Za-z0-9_-]+)$/.exec(text);
        if (optionMatch !== null) {
            return validateActionChoice({ kind: 'option', optionId: optionMatch[1] }, request);
        }

        if (text.startsWith('custom:')) {
            return validateActionChoice({ kind: 'custom', text: text.slice('custom:'.length) }, request);
        }

        throw new HarnessError(
            `The owner fork did not answer with exactly "option:<id>" or "custom:<text>"; received "${text}".`
        );
    };

    // threadFork: clone the calling agent at request instant, run it as an
    // independent actor, and return ONLY {branchId, threadId, content}. The fork's
    // transcript is never merged into the origin; the origin receives one normal
    // tool result.
    const launchThreadFork = async (
        run: RunState,
        call: HarnessToolCall,
        parseArguments: (schema: Record<string, unknown> | undefined) => unknown
    ): Promise<void> => {
        let parameters: unknown;

        try {
            parameters = parseArguments(THREAD_FORK_METADATA.parameters);
        } catch (error) {
            const info = toErrorInfo(error);
            await failBranchTool(
                run,
                call,
                error instanceof SyntaxError
                    ? `Tool "${call.name}" received malformed JSON arguments: ${info.message}`
                    : `Tool "${call.name}" received arguments that do not match its schema: ${info.message}`
            );
            return;
        }

        const input =
            typeof (parameters as { input?: unknown })?.input === 'string'
                ? ((parameters as { input: string }).input).trim()
                : '';

        if (input.length === 0) {
            await failBranchTool(run, call, 'threadFork requires a non-empty input task.');
            return;
        }

        let label: string | undefined;
        try {
            label = normalizeBranchLabel((parameters as { label?: unknown })?.label);
        } catch (error) {
            await failBranchTool(run, call, `threadFork received an invalid label: ${toErrorInfo(error).message}`);
            return;
        }

        // Concurrency is checked BEFORE any fork is created, so a refused fork
        // leaves no branch record and no history materialization work.
        try {
            assertBranchConcurrency(activeBranches.size, forks.maxConcurrent);
        } catch (error) {
            await failBranchTool(run, call, toErrorInfo(error).message);
            return;
        }

        const sourceBranch = agentBranchOf(run.agent);

        let branch: Agent;
        let metadata: AgentBranchMetadata;

        try {
            // SYNCHRONOUS snapshot at request instant: forkAgent materializes the
            // calling agent's FULL committed transcript (never a slice), remaps tool
            // ids, and pairs the pending threadFork call with an explicit
            // non-success placeholder. core/branch.ts enforces the history cap.
            branch = forkAgent(run.agent, {
                ...(label !== undefined ? { label } : {}),
                kind: 'fork',
                ...(sourceBranch !== undefined ? { sourceBranchId: sourceBranch.branchId } : {}),
                ...(run.thread !== undefined ? { sourceThreadId: run.thread.id } : {}),
                callId: call.id,
                reason: 'threadFork',
                maxDepth: forks.maxDepth,
                maxHistoryBytes: forks.maxHistoryBytes
            });

            const created = agentBranchOf(branch);
            if (created === undefined) {
                throw new HarnessError('The fork was created without branch metadata.');
            }
            metadata = created;
        } catch (error) {
            await failBranchTool(run, call, `threadFork could not create a branch: ${toErrorInfo(error).message}`);
            return;
        }

        // A branch is a separate actor with the SAME role as its source, so a fork
        // of the primary keeps agentDelegate/toolCreate and a fork of a subagent
        // does not gain them.
        actorRoles.set(branch, roleOf(run.agent));

        const summary: HarnessBranchSummary = {
            branchId: metadata.branchId,
            kind: 'fork',
            agent: run.agent.name,
            role: roleOf(run.agent),
            ...(metadata.sourceBranchId !== undefined
                ? { sourceBranchId: metadata.sourceBranchId }
                : {}),
            ...(metadata.sourceThreadId !== undefined
                ? { sourceThreadId: metadata.sourceThreadId }
                : {}),
            // M2: the PERSISTENT owner (the conversation the requester runs in),
            // which is what `deleteThread` purges against.
            ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
            callId: call.id,
            forkDepth: metadata.forkDepth,
            model: metadata.model,
            tools: declared(branch).map((definition) => definition.name)
        };

        // The branch's own callable surface is declared exactly like an ordinary
        // agent's (role-aware, discovery-aware); a fork therefore can fork again
        // until forkDepth is exhausted.
        createBranchRecord(summary, branch.messages, metadata.toolCallIds, run.scope);

        await progress({
            type: 'branch_start',
            agent: run.agent.name,
            branch: summary,
            thread: branchThreadOf(metadata.branchId, 'fork', run, call.id)
        });
        // The start frame is now observable: a later release may emit its terminal.
        branchStarted.add(metadata.branchId);

        scheduler.schedule({
            scope: run.scope,
            agent: run.actorKey,
            callId: call.id,
            name: call.name,
            parent: run.signal,
            run: async (signal) => {
                try {
                    const message = await runAgent(
                        branch,
                        input,
                        signal,
                        run,
                        call.id,
                        undefined,
                        undefined,
                        { branch: { metadata, autoAnswer: false } }
                    );

                    const content = message.content.trim();
                    if (content.length === 0) {
                        throw new HarnessError(
                            `threadFork branch "${metadata.branchId}" produced no substantive answer.`
                        );
                    }

                    const completed = finishBranch(metadata.branchId, 'completed', {
                        messages: branch.messages,
                        result: { content, stopReason: message.stopReason }
                    });
                    if (completed) {
                        await emitBranchEnd(run, metadata.branchId, 'completed', 'fork', call.id);
                    }

                    const fork: HarnessForkResult = {
                        branchId: metadata.branchId,
                        threadId: metadata.branchId,
                        content
                    };
                    return fork;
                } catch (error) {
                    const status = branchFailureStatus(signal);
                    const info = toErrorInfo(error);

                    if (
                        finishBranch(metadata.branchId, status, {
                            messages: branch.messages,
                            error: info
                        })
                    ) {
                        await emitBranchEnd(run, metadata.branchId, status, 'fork', call.id, info);
                    }
                    throw error;
                } finally {
                    activeBranches.delete(metadata.branchId);
                    branchScopes.delete(metadata.branchId);
                    branchStarted.delete(metadata.branchId);
                }
            },
            onSettled: (task) => {
                enqueueMailbox(run.actorKey, () =>
                    deliverTask(task, run, call).catch((error) => {
                        if (run.deliveryError === undefined) run.deliveryError = error;
                        markRunDirty(run);
                    })
                );
            }
        });
    };

    // actionRequest: the owner question. A ROOT run is answered only by the host
    // handler (no automatic selection, no owner to fork). A CHILD/FORK run is
    // answered by an autoanswer fork of its immediate owner run, with the owner's
    // FULL history plus the requester's FULL history at request instant.
    const launchActionRequest = async (
        run: RunState,
        call: HarnessToolCall,
        parseArguments: (schema: Record<string, unknown> | undefined) => unknown
    ): Promise<void> => {
        let parameters: unknown;

        try {
            parameters = parseArguments(ACTION_REQUEST_METADATA.parameters);
        } catch (error) {
            const info = toErrorInfo(error);
            await failBranchTool(
                run,
                call,
                error instanceof SyntaxError
                    ? `Tool "${call.name}" received malformed JSON arguments: ${info.message}`
                    : `Tool "${call.name}" received arguments that do not match its schema: ${info.message}`
            );
            return;
        }

        let body: { question: string; recommended: string; options: HarnessActionRequest['options'] };

        try {
            body = validateActionRequestParameters(parameters);
        } catch (error) {
            await failBranchTool(run, call, toErrorInfo(error).message);
            return;
        }

        const ownerRun = run.parent;

        // Root: the host is the only owner. Without a handler there is no answer to
        // give, and picking `recommended` would fabricate one.
        if (ownerRun === undefined && interaction?.actionRequest === undefined) {
            await failBranchTool(
                run,
                call,
                'actionRequest cannot be answered: this root run has no interaction.actionRequest handler. The recommendation is never selected automatically.'
            );
            return;
        }

        if (ownerRun !== undefined) {
            if (!forks.enabled) {
                await failBranchTool(
                    run,
                    call,
                    'actionRequest cannot be answered: a child request needs an owner fork, but forks are disabled.'
                );
                return;
            }

            if (interaction?.autoAnswer === false) {
                await failBranchTool(
                    run,
                    call,
                    'actionRequest cannot be answered: autoAnswer is disabled and a root-only host handler never answers a child request.'
                );
                return;
            }
        }

        if (pendingActionRequests.size >= MAX_PENDING_ACTION_REQUESTS) {
            await failBranchTool(
                run,
                call,
                `actionRequest cannot start: ${MAX_PENDING_ACTION_REQUESTS} requests are already awaiting an owner.`
            );
            return;
        }

        const requestId = `request-${++actionRequestSequence}`;
        const request: HarnessActionRequest = {
            requestId,
            question: body.question,
            recommended: body.recommended,
            options: body.options,
            allowCustom: true
        };

        // Context identifies the requester exactly. `branchId` is the requester's
        // own branch (absent for a root run), not the owner's.
        const requesterBranch = agentBranchOf(run.agent);
        const context: HarnessActionRequestContext = {
            requestId,
            agent: run.agent.name,
            ...(requesterBranch !== undefined ? { branchId: requesterBranch.branchId } : {}),
            ...(run.thread !== undefined ? { threadId: run.thread.id } : {}),
            callId: call.id,
            request
        };

        // CHILD/FORK: snapshot BOTH full transcripts and create the owner fork now,
        // synchronously, before any await. Nothing later can enter the branch.
        let autoBranch: Agent | undefined;
        let autoMetadata: AgentBranchMetadata | undefined;
        let autoSummary: HarnessBranchSummary | undefined;

        if (ownerRun !== undefined) {
            const ownerBranch = agentBranchOf(ownerRun.agent);

            try {
                assertBranchConcurrency(activeBranches.size, forks.maxConcurrent);
            } catch (error) {
                await failBranchTool(run, call, toErrorInfo(error).message);
                return;
            }

            try {
                autoBranch = forkAgent(ownerRun.agent, {
                    kind: 'autoanswer',
                    ...(ownerBranch !== undefined ? { sourceBranchId: ownerBranch.branchId } : {}),
                    ...(ownerRun.thread !== undefined ? { sourceThreadId: ownerRun.thread.id } : {}),
                    callId: call.id,
                    requestId,
                    reason: 'actionRequest',
                    maxHistoryBytes: forks.maxHistoryBytes
                });

                const created = agentBranchOf(autoBranch);
                if (created === undefined) {
                    throw new HarnessError('The owner fork was created without branch metadata.');
                }
                autoMetadata = created;

                // The owner fork must read the OWNER transcript AND the full
                // requesting transcript (including earlier invocations). The helper
                // demotes child system messages to quoted user data, so a branch
                // cannot turn its instructions into the owner's system privilege.
                const incorporated = incorporateBranchHistory({
                    ownerMessages: ownerRun.agent.messages,
                    ownerBranchId: ownerBranch?.branchId ?? 'owner',
                    branchMessages: run.agent.messages,
                    branchId: created.branchId,
                    branchKind: 'autoanswer',
                    // The owner's still-pending call is the delegation that started
                    // this requester, not the actionRequest itself: use the neutral
                    // placeholder. The child's own pending call IS this request.
                    reason: 'other',
                    maxHistoryBytes: forks.maxHistoryBytes
                });

                autoBranch.messages.length = 0;
                for (const message of incorporated.messages) {
                    autoBranch.messages.push(message);
                }

                actorRoles.set(autoBranch, roleOf(ownerRun.agent));

                const summary: HarnessBranchSummary = {
                    branchId: created.branchId,
                    kind: 'autoanswer',
                    agent: ownerRun.agent.name,
                    role: roleOf(ownerRun.agent),
                    ...(created.sourceBranchId !== undefined
                        ? { sourceBranchId: created.sourceBranchId }
                        : {}),
                    ...(created.sourceThreadId !== undefined
                        ? { sourceThreadId: created.sourceThreadId }
                        : {}),
                    // M2: the OWNER conversation owns the answer branch, so
                    // deleting that conversation removes this record too.
                    ...(ownerRun.threadId === undefined ? {} : { threadId: ownerRun.threadId }),
                    callId: call.id,
                    requestId,
                    forkDepth: created.forkDepth,
                    model: created.model,
                    tools: []
                };

                createBranchRecord(summary, incorporated.messages, incorporated.toolCallIds, run.scope);
                autoSummary = summary;
            } catch (error) {
                // A fork that could not be created is an honest tool error; no
                // action_request is reported because no owner can answer it.
                if (autoBranch !== undefined && autoMetadata !== undefined) {
                    activeBranches.delete(autoMetadata.branchId);
                    branchScopes.delete(autoMetadata.branchId);
                }
                await failBranchTool(
                    run,
                    call,
                    `actionRequest could not create the owner fork: ${toErrorInfo(error).message}`
                );
                return;
            }
        }

        // The owner fork's audit frame, before the request is announced. Its
        // `thread` is the REQUESTER's identity; the branch run's own frames carry
        // the autoanswer thread (kind/branchId).
        if (autoSummary !== undefined) {
            await progress({
                type: 'branch_start',
                agent: autoSummary.agent,
                branch: autoSummary,
                thread: branchThreadOf(autoSummary.branchId, 'autoanswer', run, call.id)
            });
            branchStarted.add(autoSummary.branchId);
        }

        pendingActionRequests.add(requestId);
        actionRequestScopes.set(requestId, run.scope);

        // The request frame is reported BEFORE the host (or owner fork) is invoked,
        // so a client can render the pending card while it awaits.
        try {
            await emit(run, {
                type: 'action_request',
                agent: run.agent.name,
                callId: call.id,
                request
            });
        } catch (error) {
            // The action_request could not be reported: fail the run (a reporter
            // failure is a run failure). The branch, if created, is released by
            // the requester run's finally, which marks it cancelled.
            pendingActionRequests.delete(requestId);
            actionRequestScopes.delete(requestId);
            throw error;
        }

        scheduler.schedule({
            scope: run.scope,
            agent: run.actorKey,
            callId: call.id,
            name: call.name,
            parent: run.signal,
            run: async (signal) => {
                try {
                    let choice: HarnessActionChoice;
                    let source: 'owner' | 'auto';

                    if (autoBranch === undefined || autoMetadata === undefined) {
                        // ROOT: await the host. The handler receives the run's
                        // cancellation signal; a late resolution after an abort is
                        // discarded (never turned into a fake answer).
                        const handler = interaction?.actionRequest;

                        if (handler === undefined) {
                            throw new HarnessError(
                                'actionRequest has no owner handler for this root run; the recommendation is never selected automatically.'
                            );
                        }

                        try {
                            choice = await handler(context, signal);
                        } catch (error) {
                            throw new HarnessError(
                                `actionRequest owner handler failed: ${toErrorInfo(error).message}`
                            );
                        }

                        if (signal.aborted) throw signal.reason;
                        choice = validateActionChoice(choice, request);
                        source = 'owner';
                    } else {
                        // CHILD/FORK: a tool-free, single-iteration owner read.
                        let message: HarnessAssistantMessage;

                        try {
                            message = await runAgent(
                                autoBranch,
                                actionDirective(request),
                                signal,
                                run,
                                call.id,
                                undefined,
                                undefined,
                                { branch: { metadata: autoMetadata, autoAnswer: true } }
                            );
                        } catch (error) {
                            const status = branchFailureStatus(signal);
                            const info = toErrorInfo(error);
                            if (
                                finishBranch(autoMetadata.branchId, status, {
                                    messages: autoBranch.messages,
                                    error: info
                                })
                            ) {
                                await emitBranchEnd(
                                    run,
                                    autoMetadata.branchId,
                                    status,
                                    'autoanswer',
                                    call.id,
                                    info
                                );
                            }
                            throw error;
                        }

                        if (signal.aborted) throw signal.reason;

                        try {
                            choice = parseDirectiveAnswer(message.content, request);
                        } catch (error) {
                            const info = toErrorInfo(error);
                            if (
                                finishBranch(autoMetadata.branchId, 'failed', {
                                    messages: autoBranch.messages,
                                    error: info
                                })
                            ) {
                                await emitBranchEnd(
                                    run,
                                    autoMetadata.branchId,
                                    'failed',
                                    'autoanswer',
                                    call.id,
                                    info
                                );
                            }
                            throw error;
                        }

                        if (
                            finishBranch(autoMetadata.branchId, 'completed', {
                                messages: autoBranch.messages,
                                result: { content: message.content, stopReason: message.stopReason }
                            })
                        ) {
                            await emitBranchEnd(
                                run,
                                autoMetadata.branchId,
                                'completed',
                                'autoanswer',
                                call.id
                            );
                        }
                        source = 'auto';
                    }

                    // Report the answer BEFORE the tool result is delivered (the
                    // delivery happens in onSettled, after this task settles).
                    const answer: HarnessActionAnswer = {
                        requestId,
                        choice,
                        source,
                        ...(source === 'auto' && autoMetadata !== undefined
                            ? { branchId: autoMetadata.branchId }
                            : {})
                    };

                    await emit(run, {
                        type: 'action_answer',
                        agent: run.agent.name,
                        requestId,
                        answer
                    });

                    return actionResultOf(request, choice, source);
                } finally {
                    pendingActionRequests.delete(requestId);
                    actionRequestScopes.delete(requestId);
                    if (autoMetadata !== undefined) {
                        activeBranches.delete(autoMetadata.branchId);
                        branchScopes.delete(autoMetadata.branchId);
                        branchStarted.delete(autoMetadata.branchId);
                    }
                }
            },
            onSettled: (task) => {
                enqueueMailbox(run.actorKey, () =>
                    deliverTask(task, run, call).catch((error) => {
                        if (run.deliveryError === undefined) run.deliveryError = error;
                        markRunDirty(run);
                    })
                );
            }
        });
    };

    // Provider-safe projection + serialized model turn. One active turn per agent:
    // two independent runs of the same agent queue here instead of interleaving
    // requests and commits. The projection is built INSIDE the lock because a
    // background completion may have landed while this turn waited.
    const turnQueues = new Map<string, Promise<void>>();

    const serializeTurn = <T>(agentName: string, work: () => Promise<T>): Promise<T> => {
        const previous = turnQueues.get(agentName) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        turnQueues.set(agentName, tail);

        void tail.then(() => {
            if (turnQueues.get(agentName) === tail) turnQueues.delete(agentName);
        });

        return previous.then(work).finally(() => release());
    };

    // One model turn, made abort-PREEMPTIVE (T15). The transport may ignore its
    // signal entirely, so we do not rely on it settling: the consumer races the
    // run signal and throws as soon as the run is cancelled. The abandoned
    // generator is drained in the background; core/agent's `precommit` guard is
    // what refuses a late commit, so the detached stream cannot touch the
    // transcript (or emit events through `emit`, which is ownership-guarded).
    const requestTurn = async (
        run: RunState
    ): Promise<{ message: HarnessAssistantMessage; offered: Map<string, Tool> }> => {
        const brain = run.agent;

        return serializeTurn(run.actorKey, async () => {
            // The run may have been aborted while this turn waited behind another
            // turn of the same agent: never start a provider request for it.
            throwIfAborted(run);

            const projection = projectTranscript(brain, runPending(run));
            // Capture the exact offered definitions for this request. Tool calls
            // returned by it execute these objects even if a replacement publishes
            // before the calls are launched.
            const { offered, declarations: declarationsForRequest } = offerDeclarations(run);
            const iterator = brain
                .turn({
                    signal: run.signal,
                    tools: declarationsForRequest,
                    transcript: projection,
                    precommit: () => assertCommitAllowed(run)
                })
                [Symbol.asyncIterator]();

            let message: HarnessAssistantMessage | undefined;

            const consume = (async (): Promise<HarnessAssistantMessage> => {
                while (true) {
                    const next = await iterator.next();
                    if (next.done === true) break;

                    const event = next.value;

                    switch (event.type) {
                        case 'text':
                            await emit(run, { type: 'text', agent: brain.name, delta: event.delta });
                            break;

                        case 'reasoning':
                            await emit(run, { type: 'reasoning', agent: brain.name, delta: event.delta });
                            break;

                        case 'done':
                            message = event.message;
                            break;

                        case 'error':
                            throw new HarnessError(event.error.message);
                    }
                }

                if (!message) {
                    throw new HarnessError(`Agent "${brain.name}" ended without producing a message.`);
                }

                return message;
            })();

            // A losing consumer settles after the race is decided; it must never
            // become an unhandled rejection.
            void consume.catch(() => undefined);

            // Captured once: the run signal never changes, and a local const keeps
            // the abort wiring below reliably narrowed.
            const signal = run.signal;

            if (signal === undefined) {
                try {
                    return { message: await consume, offered };
                } catch (error) {
                    // Preserve for-await's close-on-early-exit semantics even
                    // though this path has no abort race (e.g. a reporter threw):
                    // unwind the generator and the transport it is iterating.
                    if (iterator.return) {
                        void iterator.return(undefined).catch(() => undefined);
                    }
                    throw error;
                }
            }

            let rejectAborted!: (reason: unknown) => void;
            const aborted = new Promise<never>((_, reject) => {
                rejectAborted = reject;
            });
            const abortHandler = (): void => rejectAborted(abortErrorOf(signal));
            if (signal.aborted) abortHandler();
            else signal.addEventListener('abort', abortHandler, { once: true });

            try {
                return { message: await Promise.race([consume, aborted]), offered };
            } catch (error) {
                // Unwind at the next suspension (no await: a provider stuck in a
                // pending next() may take forever, and that is fine — the
                // precommit guard keeps it harmless).
                if (iterator.return) {
                    void iterator.return(undefined).catch(() => undefined);
                }
                throw error;
            } finally {
                signal.removeEventListener('abort', abortHandler);
            }
        });
    };

    // Wait until a completion/wake/abort marks the run dirty. The loop always
    // re-checks the real state after waking; this is a notification, not a
    // decision.
    const waitForWork = (run: RunState): Promise<void> => {
        if (run.dirty) {
            run.dirty = false;
            return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
            run.waiters.push(() => {
                run.dirty = false;
                resolve();
            });
        });
    };

    // Bounded microtask window after a launch. Tools that settle without yielding
    // to real I/O (synchronous bodies, resolved promises, a delegated child whose
    // scripted transport is microtask-only) finish in the SAME round, preserving
    // the historical transcript/event order. A tool that is genuinely waiting
    // (timer, socket, a gated promise) stays pending and the run continues with
    // placeholders. Microtasks rather than setTimeout also keeps this deterministic
    // under fake timers: no timer is created, so no timer can leak.
    const settleWindow = async (run: RunState): Promise<void> => {
        for (let pass = 0; pass < 256; pass++) {
            if (scheduler.pendingOfScope(run.scope).length === 0) return;
            await Promise.resolve();
        }
    };

    // Resolve the message a DELEGATED run hands back (T2/R1). Only the exact
    // reported failure case is rescued: a normal `stop` whose content is
    // whitespace only, after the same run already produced a substantive
    // tool-free answer (a pending background completion re-prompts the model,
    // which then "stops" with a blank turn). Everything else passes through:
    //   - a later, non-blank turn wins (its content is the answer);
    //   - a `length` stop is a truncation fact, not a blank answer, so it is
    //     never replaced (R2);
    //   - a tool-call turn is a preamble, never a candidate (recorded below);
    //   - a run with no substantive response keeps its literal result, so a
    //     genuinely empty answer stays empty (R2);
    //   - failures and aborts throw before this point, so they never reach it.
    // The TRANSCRIPT and the terminal `done` event keep the literal final turn:
    // only the value returned to the delegating caller is resolved, which is what
    // changes and leaves streaming/transport untouched.
    const resolveRunAnswer = (
        run: RunState,
        message: HarnessAssistantMessage
    ): HarnessAssistantMessage => {
        if (!run.delegateAnswer) return message;
        if (message.stopReason !== 'stop') return message;
        // Defensive: the terminal path below only calls this for tool-free turns.
        if (message.toolCalls.length > 0) return message;
        if (message.content.trim().length > 0) return message;

        return run.answer ?? message;
    };

    // R5 STEERING BOUNDARY. Thread input (a host steer or a cross-thread chat
    // message) is queued rather than inserted, so it can never land in the middle
    // of an in-flight model request or between an assistant tool-call block and
    // its results. This drains the queue as ordinary user messages at the loop's
    // safe boundary and reports whether anything was appended (which means the
    // run owes the model another turn).
    //
    // Ordering: queue order is transcript order, so two steers keep the order of
    // their receipts even when the run takes several turns to observe them.
    const drainThreadQueue = (run: RunState): boolean => {
        const state = run.threadState;
        if (state === undefined || state.queue.length === 0) return false;

        const queued = state.queue.splice(0);
        for (const content of queued) run.agent.user(content);
        // Track what this run consumed so a NON-STOP failure can preserve it for
        // the next host turn (the rollback below removes the appended messages).
        run.steering.push(...queued);
        notifyRunStateChange(run, 'agent_message', { agent: run.agent.name });
        notifyStateChange('thread');
        return true;
    };

    // Run one agent until it has answered AND nothing it started is still
    // running. `maxIterations` bounds model turns; exhaustion cancels the pending
    // work before throwing so no orphan task survives a rolled-back run.
    const runAgentCore = async (
        run: RunState,
        input: string
    ): Promise<HarnessAssistantMessage> => {
        const brain = run.agent;

        // Everything past this index belongs to this run. A failure truncates
        // back to it, so a failed call is never replayed on the next attempt.
        const commitIndex = brain.messages.length;

        await emit(run, { type: 'start', agent: brain.name, model: brain.model() });
        // Attachments ride ONLY on this run's root user message; the agent
        // re-validates/copies them before the append (core/agent.ts), so the
        // transcript owns its own bytes.
        brain.user(input, run.attachments.length > 0 ? run.attachments : undefined);
        notifyRunStateChange(run, 'agent_message', { agent: brain.name });

        try {
            while (true) {
                // ABORT BOUNDARY (R10): no new model request or tool launch once
                // the run is cancelled.
                throwIfAborted(run);

                // A background delivery or wake whose reporter threw fails the run
                // here, where the rollback path is (the mailbox itself never
                // rejects: one bad delivery must not poison the agent's chain).
                if (run.deliveryError !== undefined) throw run.deliveryError;

                if (run.iteration >= (run.autoAnswer ? 1 : maxIterations)) {
                    // Explicit drain: release everything this run started before
                    // the rollback below, so a failure cannot leave a task that
                    // later inserts into a dead transcript.
                    scheduler.abandonScope(run.scope);
                    const limit = run.autoAnswer ? 1 : maxIterations;
                    throw new HarnessError(
                        run.autoAnswer
                            ? 'The owner fork did not answer in one tool-free response; actionRequest accepts no tools.'
                            : `Agent "${brain.name}" requested tools more than ${limit} times without answering.`
                    );
                }

                run.iteration++;
                // Deliveries that landed before this turn must be visible to it;
                // reset dirty AFTER draining so the reset does not hide a real
                // outcome from `changedDuringRequest` below.
                await drainMailbox(run.actorKey);
                run.dirty = false;

                // R5: apply queued steering/chat BEFORE building this request, so
                // the model sees the fresh guidance on the very next turn instead
                // of one round late.
                drainThreadQueue(run);

                const { message, offered } = await requestTurn(run);

                // P1-A: a completion may have landed WHILE this request was in
                // flight, and its slow reporter may still be running. Drain the
                // agent's mailbox BEFORE deciding this response is final, so the
                // run can never return with a run-owned delivery still queued.
                // `run.dirty` is set at canonical insertion (before the reporter),
                // so `changedDuringRequest` is reliable even when the reporter is
                // blocked here.
                await drainMailbox(run.actorKey);

                // An abort that arrived while the transport was in flight must stop
                // the run HERE: an uncooperative provider may still deliver a
                // message, but it is not an answer for a cancelled run (and its
                // assistant commit must be rolled back with the rest).
                throwIfAborted(run);

                const changedDuringRequest = run.dirty;
                run.dirty = false;

                // Validate id integrity BEFORE any persistence/usage boundary: a
                // malformed turn must never be written to a snapshot even briefly.
                // The agent already committed it in memory; the throw below rolls
                // it back and only the post-rollback state is persisted.
                if (message.toolCalls.length > 0) {
                    assertToolCallIds(brain, message.toolCalls);
                }

                // Autoanswer branches are tool-free by contract: a tool call is
                // not a partial answer, it is an invalid directive. Fail before
                // launching anything so no side effect can run from an owner read.
                if (run.autoAnswer && message.toolCalls.length > 0) {
                    throw new HarnessError(
                        'The owner fork attempted a tool call; actionRequest requires one tool-free directive answer.'
                    );
                }

                // agent.turn() committed the assistant message before yielding
                // `done`; persist that append before any tool work or the next turn.
                notifyRunStateChange(run, 'agent_message', { agent: brain.name });

                if (message.usage !== undefined) {
                    await emit(run, { type: 'usage', agent: brain.name, usage: message.usage });
                }

                // Answer-so-far (T2/R1): record a completed, tool-free, non-blank
                // response as this run's substantive answer. Recording happens on
                // the RUN (not in agent history) so the delegate fallback needs no
                // post-return transcript scan and cannot see a queued follow-up's
                // turns. `length` responses are excluded: a truncated answer is not
                // a better answer than the blank terminal turn.
                if (
                    run.delegateAnswer &&
                    message.toolCalls.length === 0 &&
                    message.stopReason === 'stop' &&
                    message.content.trim().length > 0
                ) {
                    run.answer = message;
                }

                if (message.toolCalls.length === 0) {
                    const pending = runPending(run);

                    // Paused, not finished: report the response with the work it
                    // is waiting on, then wait for a completion or the wake timer.
                    if (pending.length > 0) {
                        await emit(run, { type: 'done', agent: brain.name, message, pending });

                        if (!changedDuringRequest) await waitForWork(run);
                        continue;
                    }

                    // Work arrived while the request was in flight: take another
                    // turn so the model sees the new results. No `done` is emitted
                    // for this superseded response.
                    if (changedDuringRequest) continue;

                    // Final guard: the mailbox is drained and dirty is clear right
                    // before the run is allowed to resolve. A delivery that raced
                    // this check re-dirties the run and gets its own turn; an abort
                    // that raced it must still fail/roll back rather than resolve.
                    await drainMailbox(run.actorKey);
                    if (run.dirty) continue;

                    // R5: guidance that arrived WHILE this final turn was in flight
                    // must not be swallowed by the return — it buys one more turn.
                    if (drainThreadQueue(run)) continue;
                    throwIfAborted(run);

                    await emit(run, { type: 'done', agent: brain.name, message });

                    // Terminal boundary (T18): the reporter that receives `done`
                    // may abort the run (a UI cancelling from its own handler). The
                    // check before emit is not enough because the abort happens
                    // DURING the awaited reporter; re-check before resolving so a
                    // cancelled run rolls back and rejects instead of returning a
                    // successful answer.
                    throwIfAborted(run);

                    // T2/R1: a delegated run resolves to its answer, not necessarily
                    // to this literal final turn — see resolveRunAnswer. The
                    // transcript and the `done` emitted above stay literal.
                    return resolveRunAnswer(run, message);
                }

                // Launch every requested call; they run concurrently. A launch
                // failure is already a tool result, so the round always completes.
                for (const call of message.toolCalls) {
                    throwIfAborted(run);
                    await launchToolCall(run, call, offered);
                }

                await settleWindow(run);
            }
        } catch (error) {
            // Mark the run dead BEFORE any await: a completion racing this catch
            // must not insert into the transcript that is about to be truncated.
            run.active = false;
            run.aborted = run.signal?.aborted === true;
            scheduler.abandonScope(run.scope);

            // R5 preservation: steering this run drained is rolled back with the
            // transcript, so hand it to the NEXT host turn in its original order.
            // A stop is different by contract: the host stopped the conversation,
            // and stopThread already cleared the queue (and bumped the epoch), so
            // the guidance is discarded instead of resurrected.
            if (run.threadState !== undefined && run.steering.length > 0) {
                if (!run.aborted && run.threadState.record.status !== 'stopped') {
                    run.threadState.queue.unshift(...run.steering);
                    notifyStateChange('thread');
                }
                run.steering = [];
            }

            brain.messages.splice(commitIndex);
            notifyRunStateChange(run, 'agent_message', { agent: brain.name });

            const info = toErrorInfo(error);
            await emitError(run, info);

            throw error instanceof HarnessError ? error : new HarnessError(info.message, { cause: error });
        }
    };

    // One active RUN per agent (the actor). Model turns are already serialized by
    // turnQueues, but a run appends a user message and a transcript; two runs of
    // the same agent interleaving those appends would show each other's prompts.
    // Queuing the whole run is what makes repeated delegation/follow-ups to the
    // same subagent sequential. Independent agents still run concurrently, and
    // tools within a run are concurrent.
    const agentQueues = new Map<string, Promise<void>>();

    const acquireAgent = (
        agentName: string,
        signal?: AbortSignal
    ): (() => void) | Promise<() => void> => {
        const previous = agentQueues.get(agentName);

        const createGate = (): { release: () => void; tail: Promise<void> } => {
            let releaseGate!: () => void;
            const gate = new Promise<void>((resolve) => {
                releaseGate = resolve;
            });
            let released = false;
            const release = (): void => {
                if (released) return;
                released = true;
                releaseGate();
            };
            return { release, tail: gate };
        };

        // FAST PATH: no run of this agent is active or queued. Return the release
        // function SYNCHRONOUSLY so the run can emit `start` in the same tick the
        // caller invoked it (the server's event contract depends on that: the
        // first turn's start predates a watcher attached just after submission).
        if (previous === undefined) {
            const { release, tail } = createGate();
            agentQueues.set(agentName, tail);
            void tail.then(() => {
                if (agentQueues.get(agentName) === tail) agentQueues.delete(agentName);
            });
            return release;
        }

        // QUEUED PATH: wait for the current actor. A queued run must remain
        // cancelable: a follow-up waiting behind a hung sibling should reject when
        // its own signal aborts instead of starting later. Releasing the gate on
        // abort lets the NEXT waiter through.
        return (async () => {
            const { release, tail } = createGate();
            const queued = previous.then(() => tail);
            agentQueues.set(agentName, queued);

            void queued.then(() => {
                if (agentQueues.get(agentName) === queued) agentQueues.delete(agentName);
            });

            if (signal) {
                let onAbort: (() => void) | undefined;
                const aborted = new Promise<never>((_, reject) => {
                    onAbort = () => reject(signal.reason);
                    if (signal.aborted) onAbort();
                    else signal.addEventListener('abort', onAbort, { once: true });
                });

                try {
                    await Promise.race([previous, aborted]);
                } catch (error) {
                    release();
                    throw error;
                } finally {
                    if (onAbort) signal.removeEventListener('abort', onAbort);
                }
            } else {
                await previous;
            }

            return release;
        })();
    };

    // The one entry point every path uses: the harness call, ctx.run, and
    // agentDelegate. Guards live here so none can be bypassed through a tool's
    // general context.
    //
    // Per-run state replaces the old global runStack/runSignal: concurrent tools
    // and delegated agents must not overwrite each other's signal or lineage.
    const runAgent = async (
        brain: Agent,
        input: string,
        signal?: AbortSignal,
        parent?: RunState,
        // The parent tool call that spawned this run (T3 UI threads). `ctx.run`
        // and agentDelegate pass their own `call.id`; a host/root invocation passes
        // nothing. It only labels the child's events — it grants no authority.
        callId?: string,
        // Internal, delegate-only answer extraction (T2/R1). Omitted for host runs
        // and arbitrary ctx.run calls, which keep their historical return value.
        internals?: RunInternals,
        // Root-prompt attachments (T3). ONLY the harness callable passes these;
        // ctx.run/agentDelegate omit them so root bytes never reach a child
        // prompt. Validated here, before the run acquires the agent or mutates
        // any history.
        attachments?: HarnessAttachment[],
        // N6 branch internals, passed only by the runtime's fork/autoanswer
        // launches. Kept separate from `internals` so an arbitrary ctx.run cannot
        // claim to be a branch through the public tool context.
        branchInternals?: RunInternals,
        // R2: the persistent thread this run executes in. Host calls pass the
        // created thread; everything else is resolved below (root -> the
        // primary's default conversation, delegation -> the child agent's default
        // conversation). A fork/autoanswer branch never binds to a thread.
        threadState?: ThreadState
    ): Promise<HarnessAssistantMessage> => {
        // Validation is the first side-effect-free step: a malformed attachment
        // rejects the run with nothing appended, nothing emitted, and no queued
        // actor slot.
        const validatedAttachments = validateAttachments(attachments);

        const ancestors = parent?.lineage ?? [];
        const branchRun = branchInternals?.branch;

        if (ancestors.includes(brain)) {
            throw new HarnessError(
                `Agent "${brain.name}" is already running; it cannot be re-entered (delegation cycle).`
            );
        }

        // Delegation depth is INDEPENDENT of fork depth (N6). A branch run is a
        // fresh actor and starts at depth 1 again; its nesting is bounded by
        // core/branch.ts's forkDepth instead. An ordinary run is one level below
        // its parent. The check is AFTER the cycle check so a cycle keeps its own,
        // more precise message.
        const depth = branchRun !== undefined ? 1 : (parent?.depth ?? 0) + 1;

        if (depth > MAX_RUN_DEPTH) {
            throw new HarnessError(
                `Agent "${brain.name}" cannot run: runs nest at most ${MAX_RUN_DEPTH} deep, and "${ancestors[ancestors.length - 1].name}" is already running.`
            );
        }

        // An already-cancelled run must not create a conversation (the child-thread
        // path below mints one). The later checks stay: this one only protects the
        // side effect that happens before the actor queue.
        signal?.throwIfAborted();

        // R2/R4 PERSISTENT THREAD BINDING. A branch keeps its ephemeral transcript
        // (below); every ordinary run belongs to a conversation:
        //   - an explicit host thread (sendThreadInput);
        //   - a NEW host thread when the CALLER is a host conversation. A host
        //     thread's delegation/ctx.run child is its own independent conversation
        //     (fresh Agent, own id, ownerThreadId = caller) — siblings never share
        //     a transcript, even when they target the same agent. This is what makes
        //     R4 "linked subagents" real instead of inheriting the agent's default
        //     conversation;
        //   - the target agent's DEFAULT conversation for a legacy/root delegation;
        //   - the primary's default conversation for the callable root.
        const resolvedThread = ((): ThreadState | undefined => {
            if (branchRun !== undefined) return undefined;
            if (threadState !== undefined) return threadState;

            if (parent !== undefined && parent.threadState?.record.origin === 'host') {
                // `ctx.run`/agentDelegate resolve a registry agent by name; a brain
                // outside the registry cannot be re-created as a thread, so it falls
                // back to its own default conversation (never a host's transcript).
                if (agents[brain.name] !== brain) return defaultThreadOf(brain);

                return createThreadState(
                    brain.name,
                    parent.threadId === undefined ? undefined : { ownerThreadId: parent.threadId },
                    true
                );
            }

            return defaultThreadOf(brain);
        })();

        // The BRAIN that actually runs. A registry brain arrives from the
        // callable/ctx.run/agentDelegate; when the run is bound to a host thread,
        // that thread's own Agent instance is the actor: its transcript, its actor
        // key, and its events. Without this the child of a host thread would still
        // write into `agent:<name>` (and queue behind it), which is exactly the
        // sharing R4 forbids.
        const runBrain = resolvedThread === undefined ? brain : resolvedThread.agent;

        // Model selection is a property of the OWNING agent. A host thread was
        // created with the model value of that moment; re-reading it at every run
        // start makes `agents[name].model('…')` propagate predictably to every live
        // conversation of that agent on its NEXT run (a request already in flight
        // keeps the model it started with, as before).
        if (resolvedThread !== undefined && resolvedThread.record.origin === 'host') {
            const ownerAgent = agents[resolvedThread.record.agent];
            if (ownerAgent !== undefined && resolvedThread.agent.model() !== ownerAgent.model()) {
                resolvedThread.agent.model(ownerAgent.model());
            }
        }

        // A stopped conversation refuses MODEL-DRIVEN work (delegation, ctx.run).
        // The host owns the stop, so an explicit root call revives it; an explicit
        // sendThreadInput already revived it before calling here.
        if (resolvedThread !== undefined && resolvedThread.record.status === 'stopped') {
            if (parent === undefined && threadState === undefined) {
                resolvedThread.record.status = 'idle';
                notifyStateChange('thread');
            } else {
                throw new HarnessError(
                    `Thread "${resolvedThread.record.id}" is stopped; a host must resume it before it can run.`
                );
            }
        }

        // M1: the stop epoch observed at submission time. Captured AFTER the
        // revival above, so a host call made after a stop is legal; every run
        // already queued when the stop lands carries the old epoch and is refused
        // below.
        const threadGeneration = resolvedThread?.generation;

        // M2: the PERSISTENT conversation this run belongs to. A branch run keeps
        // its ephemeral transcript (resolvedThread stays undefined) but still
        // belongs to the conversation that spawned it, so a nested fork or an
        // autoanswer branch can be purged with that thread and its invocation
        // result is scoped the same way.
        const runThreadId =
            resolvedThread?.record.id ?? (branchRun === undefined ? undefined : parent?.threadId);

        // A thread run gets its OWN controller, linked to the caller's signal, so
        // stopThread can abort exactly this conversation while a host abort still
        // reaches every run it started (including delegated children).
        const threadController = resolvedThread === undefined ? undefined : new AbortController();
        let unlinkThreadAbort: (() => void) | undefined;

        if (threadController !== undefined && signal !== undefined) {
            const forwardAbort = (): void => threadController.abort(abortErrorOf(signal));

            if (signal.aborted) forwardAbort();
            else {
                signal.addEventListener('abort', forwardAbort, { once: true });
                unlinkThreadAbort = () => signal.removeEventListener('abort', forwardAbort);
            }
        }

        // The signal every downstream boundary checks: the thread controller when
        // one exists, otherwise the caller's signal (historical behaviour).
        const runSignal = threadController?.signal ?? signal;

        // An already-cancelled run must not start: check before queueing.
        runSignal?.throwIfAborted();

        // Wait for this actor. A queued run is not "started" until it owns the
        // actor, so an abort while waiting rejects without touching history. The
        // free path returns synchronously (no microtask before `start`). The key is
        // the ACTOR key: a fork never queues behind its source (N6), and a host
        // thread of an agent queues only behind ITSELF (`thread:<id>`, set when the
        // thread was created), never behind the agent's default conversation.
        const acquired = acquireAgent(actorKeyOf(runBrain), runSignal);
        const releaseAgent = typeof acquired === 'function' ? acquired : await acquired;

        try {
            runSignal?.throwIfAborted();

            // Re-check AFTER owning the actor: a stop that landed while this run
            // waited in the queue must not let it start afterwards. The EPOCH, not
            // just the status, is what catches already-queued host submissions
            // (M1) — revival by a new host send bumps nothing, so its own run is
            // unaffected, while all older queued runs are refused here.
            if (resolvedThread !== undefined && resolvedThread.generation !== threadGeneration) {
                // No run ever started, so release the abort bridge this queued
                // submission installed before refusing it.
                unlinkThreadAbort?.();
                throw new HarnessError(
                    `Thread "${resolvedThread.record.id}" was stopped while this turn was queued; the turn was not started.`
                );
            }

            const id = ++runSequence;
            const run: RunState = {
                id,
                scope: String(id),
                agent: runBrain,
                actorKey: actorKeyOf(runBrain),
                depth,
                autoAnswer: branchRun?.autoAnswer === true,
                ...(branchRun !== undefined ? { branch: branchRun.metadata } : {}),
                // R2: the run's cancellation is the thread controller when the run
                // belongs to a conversation, so stopThread and a host abort reach
                // the same boundaries.
                signal: runSignal,
                ...(resolvedThread === undefined ? {} : { threadState: resolvedThread }),
                ...(runThreadId === undefined ? {} : { threadId: runThreadId }),
                lineage: [...ancestors, runBrain],
                parent,
                active: true,
                aborted: false,
                iteration: 0,
                dirty: false,
                waiters: [],
                steering: [],
                attachments: validatedAttachments,
                // Delegate-only answer extraction (T2/R1). A host run and an
                // arbitrary ctx.run leave this false, so their returned message is
                // exactly the model's final turn, as before.
                delegateAnswer: internals?.delegateAnswer === true
            };

            // Invocation identity (T3 UI threads), built ONCE after the actor is
            // owned: a queued follow-up therefore gets its id only when it really
            // starts, and `runSequence` (monotonic per harness) makes that id unique
            // within the owning SessionTurn — repeated delegation to the SAME agent
            // produces distinct ids. `parentId` names the parent's THREAD id, so it
            // is omitted for a direct child of the root (the root has no thread) and
            // set for anything deeper. `input` travels on `start` only (see
            // withThread/threadIdentity).
            //
            // N6 BRANCH THREADS: id is the branch id, so `branch_start`,
            // `harness.branch(id)`, and EVERY frame of the branch share one naming
            // scheme; kind/branchId ride along on every event (threadIdentity).
            if (branchRun !== undefined) {
                const metadata = branchRun.metadata;
                const thread: HarnessThread = {
                    id: metadata.branchId,
                    input,
                    kind: branchRun.autoAnswer ? 'autoanswer' : 'fork',
                    branchId: metadata.branchId
                };
                if (parent?.thread !== undefined) thread.parentId = parent.thread.id;
                if (callId !== undefined) thread.callId = callId;
                run.thread = thread;
            } else if (parent !== undefined) {
                const thread: HarnessThread = { id: String(id), input };
                if (parent.thread !== undefined) thread.parentId = parent.thread.id;
                if (callId !== undefined) thread.callId = callId;
                run.thread = thread;
            } else if (resolvedThread !== undefined && resolvedThread.record.origin === 'host') {
                // R2: a host thread run is not a child of the callable root, but it
                // is still a separate conversation that a client must be able to
                // group, so it carries the ordinary invocation identity (no parent
                // and no spawning call). Root events keep their historical shape.
                run.thread = { id: String(id), input };
            }

            // R2: publish the run on its thread AFTER the invocation id exists, so
            // `thread.invocationId` always names a real agentResult entry. At most
            // one run per thread (the actor queue serializes), so a plain assignment
            // is the whole state machine.
            if (resolvedThread !== undefined) {
                resolvedThread.record.status = 'running';
                resolvedThread.record.invocationId = String(id);
                resolvedThread.controller = threadController;
                resolvedThread.run = run;

                // Persistent parent link (R4): the FIRST persistent thread that
                // spawns work in this conversation owns it. A default conversation
                // may be delegated to from several places; its history belongs to
                // the agent, so the link is informational and never reassigned.
                if (
                    resolvedThread.record.origin === 'agent' &&
                    resolvedThread.record.ownerThreadId === undefined &&
                    parent?.threadId !== undefined &&
                    parent.threadId !== resolvedThread.record.id
                ) {
                    resolvedThread.record.ownerThreadId = parent.threadId;
                }

                // No state-change notification here on purpose: a run already
                // emits `agent_message` for every transcript append, and the
                // thread's status/invocation id are derived from that same run.
                // Emitting `thread` on every turn would double every save without
                // recording anything a snapshot of the transcript does not.
            }

            // A run-level abort wakes a paused loop so the next iteration observes
            // it and rolls back. Every in-flight controller is linked by the
            // scheduler.
            const onAbort = (): void => {
                run.aborted = true;
                markRunDirty(run);
            };

            if (runSignal) {
                if (runSignal.aborted) onAbort();
                else runSignal.addEventListener('abort', onAbort, { once: true });
            }

            runs.add(run);
            activeRuns++;

            // R3: make this invocation visible to agentManage/agentResult while
            // it runs. The registry entry is completed in the catch/return below;
            // it never touches history or events.
            registerInvocation(run);

            try {
                const message = await runAgentCore(run, input);
                finishInvocation(run, { message });
                return message;
            } catch (error) {
                finishInvocation(run, { error });
                throw error;
            } finally {
                run.active = false;
                runs.delete(run);
                activeRuns--;
                // Idempotent: the catch path already drained; a successful run has
                // nothing left. This also handles an unexpected throw outside the
                // loop's own catch.
                scheduler.abandonScope(run.scope);
                // Release branch/action bookkeeping this run owned. abandonScope
                // does not notify, so these are the only cleanup for work that never
                // started (or whose task was detached by the abort). The branch
                // release is AWAITED because it may be the only place that can emit
                // the terminal branch_end for an already-emitted branch_start (D1).
                await releaseBranchesForScope(run);
                releaseActionRequestsForScope(run.scope);
                if (runSignal) runSignal.removeEventListener('abort', onAbort);

                // R2: release the thread slot. A `stopped` record keeps that status
                // (the host's intent must survive the abort); an ordinary finish
                // returns the conversation to idle. The controller and run are
                // cleared so a later stop cannot abort a run that already ended.
                if (resolvedThread !== undefined) {
                    if (resolvedThread.run === run) resolvedThread.run = undefined;
                    if (resolvedThread.controller === threadController) {
                        resolvedThread.controller = undefined;
                    }
                    if (resolvedThread.record.status === 'running') {
                        resolvedThread.record.status = 'idle';
                    }
                }

                unlinkThreadAbort?.();
            }
        } finally {
            releaseAgent();
        }
    };

    // -----------------------------------------------------------------------
    // R3a: snapshot / restore
    // -----------------------------------------------------------------------
    //
    // snapshot() is a pure synchronous read: it copies agent transcripts, the
    // model each agent will use, enabled/discovered tools, progressive-discovery
    // offsets, the lifetime creation budget, runtime-created tool SOURCES, every
    // session record store, and the TERMINAL agent-result archive (R3 durability).
    // It deliberately omits configuration, credentials, functions
    // (transports/tool implementations/plugins/progress hooks), in-flight
    // execution state (runStack/runSignal), and `running` agent results (they have
    // no answer yet and are written by the next boundary snapshot if they finish).
    //
    // SAFE DURING AN ACTIVE RUN (T16). Agent history is only mutated synchronously
    // at commit points, and snapshot() runs on the same thread, so a read from a
    // synchronous boundary (the stateChange observer, a progress callback, or the
    // host's own event-loop turn) always sees a coherent committed state: a
    // completed tool's store mutation AND its tool-result message together. That
    // is what lets a server persist an interrupted turn instead of losing work.
    //
    // This does NOT include text/reasoning deltas that have not yet been committed
    // to agent.messages; those are progress events, not snapshot state. A snapshot
    // taken from inside a tool body while it is awaiting captures the writes that
    // tool has completed so far (no torn state is possible; the tool itself owns
    // its intermediate consistency).
    //
    // restore() is still forbidden during a run: it would replace the transcript
    // the loop is actively using. The asymmetry is intentional.
    //
    // restore() validates the whole value before touching anything:
    //   1. schema/version and every record (readHarnessSnapshot) — pure;
    //   2. compilation of every created tool (createDynamicTool; compile only,
    //      never execute, same trusted-source policy as toolCreate);
    //   3. target-specific checks: agent identity, registry collisions, creation
    //      budget, and that every discovered name resolves.
    // Only then is state replaced (including the agent-result archive and its id
    // high-water counters). Validation failure therefore leaves the target
    // untouched, which is what makes a corrupt on-disk snapshot safe to report.
    //
    // A restore removes tools THIS harness previously restored (tracked in
    // createdToolRecords) before registering the snapshot's set, so applying the
    // same snapshot twice is idempotent instead of colliding with itself.
    const snapshot = (): HarnessSnapshot => {
        const agentSnapshots: Record<string, HarnessAgentSnapshot> = {};

        for (const [name, brain] of Object.entries(agents)) {
            // readHarnessMessages validates the same schema restore will enforce,
            // so this harness cannot emit a snapshot its own restore rejects.
            agentSnapshots[name] = {
                model: brain.model(),
                messages: readHarnessMessages(brain.messages, `agent "${name}" messages`)
            };
        }

        // R3 durability: persist only TERMINAL results, in run-start order. A
        // running invocation has no answer yet; it is omitted rather than written
        // as a fabricated/cancelled result. Its eventual completion is recorded by
        // the next mutation-boundary snapshot (or lost only if the process dies
        // mid-run, which is the same guarantee as any other in-flight work).
        const agentResults = [...invocationRecords.values()]
            .filter((record) => record.status !== 'running')
            .sort((left, right) => left.sequence - right.sequence)
            .map((record) => ({
                invocationId: record.invocationId,
                sequence: record.sequence,
                completedOrder: record.completedOrder,
                agent: record.agent,
                role: record.role,
                kind: record.kind,
                status: record.status as 'completed' | 'failed' | 'cancelled',
                content: record.content,
                ...(record.error === undefined ? {} : { error: record.error })
            }));

        // R2: persist HOST threads only. An agent's default conversation is its
        // registry transcript (already above) with an id derived from the name, so
        // including it would duplicate state. A running thread is written as idle:
        // a snapshot must never claim work is live after a restart, and its
        // committed transcript is still durable.
        const hostThreads = [...threadStates.values()]
            .filter((state) => state.record.origin === 'host')
            .sort((left, right) => left.record.sequence - right.record.sequence)
            .map((state) => ({
                id: state.record.id,
                agent: state.record.agent,
                status: state.record.status === 'stopped' ? ('stopped' as const) : ('idle' as const),
                sequence: state.record.sequence,
                ...(state.record.ownerThreadId === undefined
                    ? {}
                    : { ownerThreadId: state.record.ownerThreadId }),
                ...(state.record.label === undefined ? {} : { label: state.record.label }),
                // A running invocation has no persisted agentResult, so pointing a
                // restored record at it would dangle. Status is written as idle for
                // the same reason.
                ...(state.record.invocationId === undefined || state.record.status === 'running'
                    ? {}
                    : { invocationId: state.record.invocationId }),
                messages: readHarnessMessages(
                    state.agent.messages,
                    `thread "${state.record.id}" messages`
                )
            }));

        // The field pair is omitted entirely while only default conversations
        // exist, so every pre-thread snapshot (and fixture) keeps its shape. The
        // high-water mark travels with the (possibly empty) list, so a deleted
        // thread's id is never minted again after a restore.
        const threadFields =
            hostThreads.length > 0 || threadIdSequence > 0
                ? { threads: hostThreads, threadSequence: threadIdSequence }
                : {};

        return {
            version: HARNESS_SNAPSHOT_VERSION,
            agents: agentSnapshots,
            discovery: {
                // Set iteration order is discovery order and must survive.
                enabled: [...activeTools],
                offsets: [...discoveryOffsets.entries()].map(([query, offset]) => ({
                    query,
                    offset
                }))
            },
            // Creation order is registry insertion order, which decides
            // declaration order after a restore.
            createdTools: [...createdToolRecords.values()].map(cloneToolCreation),
            createdToolCount: createdTools,
            // Omitted when empty so a snapshot without results (and every older
            // fixture) keeps its exact prior shape.
            ...(agentResults.length === 0 ? {} : { agentResults }),
            ...threadFields,
            records: {
                todos: todo.snapshot(),
                profiles: profile.snapshot(),
                chapters: chapter.snapshot(),
                locations: location.snapshot()
            }
        };
    };

    const restore = (value: HarnessSnapshot): void => {
        if (activeRuns > 0) {
            throw new HarnessError(
                'Cannot restore while an agent run is in progress; wait for the run to settle.'
            );
        }

        // Phase 1: pure validation. Throws without mutating anything.
        const next = readHarnessSnapshot(value);

        // Phase 2: compile EVERY restore candidate through the same shared
        // prepare operation runtime/startup registration uses. Module revisions
        // use their captured entry bytes + local dependencies (not a re-read of an
        // edited path) so the restored revision is exactly the persisted one;
        // legacy records keep their async-body form. Nothing executes and no live
        // state is touched until every candidate has prepared.
        const restoredCandidates = next.createdTools.map((creation) =>
            prepareToolCandidate(
                {
                    name: creation.name,
                    description: creation.description,
                    tags: creation.tags,
                    ...(creation.parameters === undefined
                        ? {}
                        : { parameters: creation.parameters }),
                    ...(creation.visibility === undefined
                        ? {}
                        : { visibility: creation.visibility }),
                    ...(creation.source === undefined ? {} : { source: creation.source }),
                    ...(creation.moduleText === undefined
                        ? {}
                        : { moduleText: creation.moduleText }),
                    ...(creation.sourcePath === undefined
                        ? {}
                        : { sourcePath: creation.sourcePath }),
                    ...(creation.dependencies === undefined
                        ? {}
                        : { dependencies: creation.dependencies })
                },
                { expectedName: creation.name }
            )
        );

        // Phase 3: target-specific checks.
        //
        // Registry collisions ignore tools this harness restored earlier: those
        // are replaced by this restore (idempotent), not treated as conflicts.
        const occupied = new Set(
            Object.keys(tools)
                .filter((name) => !createdToolRecords.has(name))
                .map((name) => name.toLowerCase())
        );

        for (const prepared of restoredCandidates) {
            const definition = prepared.tool;
            const key = definition.name.toLowerCase();

            if (occupied.has(key)) {
                throw new HarnessError(
                    `Tool "${definition.name}" is already registered in this harness; the snapshot cannot be restored.`
                );
            }

            occupied.add(key);
        }

        if (next.createdToolCount > maxCreatedTools) {
            throw new HarnessError(
                `Snapshot records ${next.createdToolCount} created tools; this harness allows at most ${maxCreatedTools}.`
            );
        }

        // Agent identity is the registry key. A snapshot applied to a
        // same-definition harness has exactly the same set, so a mismatch is a
        // wrong-session/wrong-build signal rather than something to skip.
        for (const name of Object.keys(next.agents)) {
            if (!Object.prototype.hasOwnProperty.call(agents, name)) {
                throw new HarnessError(
                    `Snapshot agent "${name}" is not registered in this harness.`
                );
            }
        }

        for (const name of Object.keys(agents)) {
            if (!Object.prototype.hasOwnProperty.call(next.agents, name)) {
                throw new HarnessError(
                    `Agent "${name}" is missing from the snapshot; it cannot be resumed from this file.`
                );
            }
        }

        // Discovery may name configured/preset tools or snapshot-created ones.
        // A name that resolves nowhere would be silently un-callable after
        // restore, so it is rejected instead.
        const available = new Set(
            Object.keys(tools).filter((name) => !createdToolRecords.has(name))
        );

        for (const prepared of restoredCandidates) available.add(prepared.tool.name);

        for (const name of next.discovery.enabled) {
            if (!available.has(name)) {
                throw new HarnessError(
                    `Snapshot discovery names "${name}", which is not registered in this harness.`
                );
            }
        }

        // Phase 3b (R2): build the backing Agent for every persisted host thread
        // BEFORE mutating live state. The owner agents are already validated
        // above; a factory failure aborts the restore with nothing replaced.
        const restoredThreads = (next.threads ?? []).map((entry) => {
            const threadAgent = createThreadAgent(agents[entry.agent]);
            actorRoles.set(threadAgent, roleOf(agents[entry.agent]));
            actorKeys.set(threadAgent, `thread:${entry.id}`);
            return { entry, threadAgent };
        });

        // Conditional thread tools are restored catalogue state too. PREPARE their
        // source revisions before Phase 4; publication below performs no remaining
        // compilation, so a compile failure still aborts with nothing mutated.
        const pendingThreadTools =
            next.threads === undefined
                ? []
                : prepareMissingThreadTools(
                      new Set(restoredCandidates.map((prepared) => prepared.tool.name))
                  );

        // Phase 4: apply. Everything above succeeded; from here the snapshot is
        // the new state.
        for (const name of [...createdToolRecords.keys()]) {
            delete tools[name];
            // A removed created tool must not leave a stale inspection record.
            toolSourceRecords.delete(name);
        }

        createdToolRecords.clear();

        restoredCandidates.forEach((prepared, index) => {
            tools[prepared.tool.name] = prepared.tool;
            // Keep the captured revision inspectable after a restore. This is the
            // same source record the compiler just consumed.
            toolSourceRecords.set(prepared.tool.name, prepared.record);
            createdToolRecords.set(
                prepared.tool.name,
                cloneToolCreation(next.createdTools[index])
            );
        });

        // Publish the prepared conditional entries WITHOUT compiling here.
        for (const prepared of pendingThreadTools) publishPreparedBaseline(prepared);

        // The lifetime budget is state, not configuration: a resumed session
        // must not regain spent creations. reset() still does not clear it.
        createdTools = next.createdToolCount;

        activeTools.clear();
        for (const name of next.discovery.enabled) activeTools.add(name);

        discoveryOffsets.clear();
        for (const entry of next.discovery.offsets) {
            discoveryOffsets.set(entry.query, entry.offset);
        }

        // R3 durability: replace the result registry with the snapshot's terminal
        // records. An old snapshot (no agentResults) intentionally restores an
        // EMPTY registry: a pre-feature file could not have persisted one, so
        // there is nothing to reconstruct. Counters are advanced to the archived
        // high-water marks; otherwise a new root run could reuse an archived
        // numeric invocation id, or a new fork `branch-N` could overwrite the
        // archived result with the same id.
        const restoredResults = next.agentResults ?? [];

        invocationRecords.clear();
        for (const result of restoredResults) {
            invocationRecords.set(result.invocationId, {
                invocationId: result.invocationId,
                sequence: result.sequence,
                completedOrder: result.completedOrder,
                agent: result.agent,
                role: result.role,
                kind: result.kind,
                status: result.status,
                content: result.content,
                ...(result.error === undefined ? {} : { error: result.error })
            });
        }

        const maxSequence = restoredResults.reduce(
            (max, result) => Math.max(max, result.sequence),
            0
        );
        const maxCompletionOrder = restoredResults.reduce(
            (max, result) => Math.max(max, result.completedOrder),
            0
        );
        let maxBranchSequence = 0;

        for (const result of restoredResults) {
            const match = /^branch-([1-9][0-9]*)$/.exec(result.invocationId);
            if (match !== null) maxBranchSequence = Math.max(maxBranchSequence, Number(match[1]));
        }

        runSequence = Math.max(runSequence, maxSequence);
        invocationCompletionSequence = Math.max(
            invocationCompletionSequence,
            maxCompletionOrder
        );
        reserveBranchSequence(maxBranchSequence);

        for (const [name, agentSnapshot] of Object.entries(next.agents)) {
            const brain = agents[name];

            // Replace in place: message arrays are exposed as `agent.messages`,
            // and callers may already hold that reference.
            brain.messages.length = 0;
            for (const message of agentSnapshot.messages) brain.messages.push(message);

            brain.model(agentSnapshot.model);
        }

        // R2: rebuild the thread records to match the snapshot exactly. Default
        // conversations are derived state, so they are reset to idle here (their
        // transcript was just replaced above); host threads not in the snapshot are
        // removed with their lookups, then the persisted ones are re-created.
        for (const state of [...threadStates.values()]) {
            // A turn queued on a conversation this restore is replacing must not
            // start against the old transcript.
            state.generation += 1;

            if (state.record.origin === 'host') {
                // No lookup purge here: restore replaces the invocation/branch
                // registries from the snapshot, so only the record map needs the
                // old entries removed.
                threadStates.delete(state.record.id);
            } else {
                state.record.status = 'idle';
                state.queue.length = 0;
                state.run = undefined;
                state.controller = undefined;
                delete state.record.invocationId;
                // L2: default conversations are implicit, so restore cannot bring
                // an owner link back; clear it here (a host thread's owner IS
                // persisted and is re-created below).
                delete state.record.ownerThreadId;
            }
        }

        for (const { entry, threadAgent } of restoredThreads) {
            threadAgent.messages.length = 0;
            for (const message of entry.messages) threadAgent.messages.push(message);

            threadStates.set(entry.id, {
                record: {
                    id: entry.id,
                    agent: entry.agent,
                    origin: 'host',
                    status: entry.status,
                    sequence: entry.sequence,
                    ...(entry.ownerThreadId === undefined
                        ? {}
                        : { ownerThreadId: entry.ownerThreadId }),
                    ...(entry.label === undefined ? {} : { label: entry.label }),
                    ...(entry.invocationId === undefined
                        ? {}
                        : { invocationId: entry.invocationId })
                },
                agent: threadAgent,
                queue: [],
                generation: 0
            });
        }

        // Never lower either counter. `threadSequence` is creation order;
        // `threadIdSequence` is the `thread-N` high-water mark, so a deleted id is
        // never minted again after a restart.
        threadSequence = Math.max(
            threadSequence,
            Object.keys(agents).length,
            ...restoredThreads.map(({ entry }) => entry.sequence)
        );
        threadIdSequence = Math.max(threadIdSequence, next.threadSequence ?? 0);

        // The field pair's presence means this session owned host threads at some
        // point (possibly all deleted); those tools were prepared and published
        // above without compiling after mutation.

        todo.restore(next.records.todos);
        profile.restore(next.records.profiles);
        chapter.restore(next.records.chapters);
        location.restore(next.records.locations);

        notifyStateChange('restore');
    };

    // Apply plugins before returning so the handle is complete and consistent.
    const pluginNames = runPlugins(configuration.plugins ?? [], {
        agents,
        tools,
        createAgent: (name, agentConfiguration) => {
            if (agents[name]) {
                throw new HarnessError(`Agent "${name}" is already registered.`);
            }
            const brain = createAgent({ ...agentConfiguration, name });
            agents[name] = brain;
            // R2: a plugin-added agent owns a default conversation like every
            // configured one, so `threads()`/threadSend can address it and
            // `sendThreadInput('agent:<name>')` resumes it.
            threadStates.set(defaultThreadIdOf(name), {
                record: {
                    id: defaultThreadIdOf(name),
                    agent: name,
                    origin: 'agent',
                    status: 'idle',
                    sequence: ++threadSequence
                },
                agent: brain,
                queue: [],
                generation: 0
            });
            return brain;
        },
        addTool: (name, toolConfiguration) => {
            // No reserved names and no "already registered" rejection: a plugin is
            // an intentional later registration and therefore REPLACES by name.
            // It commits through the same atomic kernel as every other path.
            const definition = defineTool({ ...toolConfiguration, name });
            registerAtStartup({ definition });
            return definition;
        }
    });

    // Startup is complete: registrations from here on are runtime registrations
    // (budget, enabled set, persistence bookkeeping, and state-change reporting).
    startupPhase = false;

    // The host/server-facing execution path (R8): run one REGISTERED tool by name
    // with the session it belongs to, exactly like the model would, but without
    // spending a discovery round trip. The server's `POST /tools/:name` calls this
    // through its session for the session-bound harness-owned tools, which is what
    // makes a manual toolRequest/toolCreate/todoManage/agentDelegate call mutate
    // THIS harness instead of a detached copy. Core file tools use the ordinary
    // direct-call path and do not require a session.
    //
    // Gating difference, on purpose: discovery gates the MODEL. An explicit user
    // action may run any registered tool even when toolRequest never enabled it;
    // the model still cannot. Nothing else is bypassed — toolCreate goes through
    // createToolFrom (validation, budget, collisions, guarded compilation) and
    // agentDelegate's own execute re-checks the primary's authority.
    //
    // R11: the arguments are resolved and VALIDATED exactly like the model path,
    // except that the already-unwrapped direct-call form is accepted too (see
    // core/schema-validation.ts). A manual call therefore cannot skip the schema.
    //
    // No progress events are emitted: a manual call is not a conversation turn, so
    // there is no transcript position for a tool_call/tool_result pair. The
    // caller's request/response carries the duration (ToolCallResult).
    // Nested/registered-tool invocation (R2). The registry is read at CALL time,
    // so a tool that calls a sibling observes a replacement instead of capturing a
    // fixed implementation. Arguments are validated with the same schema gate as
    // the manual path; caller, cancellation, thread, and depth are inherited from
    // the invocation options. A baseline runtime control is rejected because it
    // needs the owning RunState, not an ordinary tool context; a replacement under
    // the same name has no marker and runs normally.
    const callToolInternal = async (
        name: string,
        parameters: unknown,
        options: HarnessToolCallOptions = {}
    ): Promise<unknown> => {
        const definition = tools[name];

        if (!definition) {
            throw new HarnessError(`Tool "${name}" is not registered in this harness.`);
        }

        if (runtimeControlDefinitions.has(definition)) {
            throw new HarnessError(
                `Tool "${name}" requires the harness run that owns the conversation and cannot be called through callTool.`
            );
        }

        const resolved = resolveToolParameters(definition.parameters, parameters, 'direct');
        const signal = options.signal;

        const context: ToolContext = {
            parameters: resolved,
            agents,
            harness: handle,
            callTool: (nestedName: string, nestedParameters: unknown) =>
                callToolInternal(nestedName, nestedParameters, options),
            ...(options.agent === undefined ? {} : { agent: options.agent }),
            ...(signal === undefined ? {} : { signal }),
            runDepth: options.runDepth ?? 1,
            ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
            run: (agentName: string, input: string) => {
                const target = agents[agentName];

                if (!target) {
                    throw new HarnessError(`Agent "${agentName}" is not registered.`);
                }

                return runAgent(
                    target,
                    input,
                    signal,
                    undefined,
                    undefined,
                    delegateAnswerDefinitions.has(definition) ? DELEGATE_ANSWER : undefined
                );
            }
        };

        try {
            return await definition.execute(context);
        } finally {
            // Same advisory boundary as executeTool: nested calls are real tool
            // executions and may have changed snapshot-managed state.
            notifyStateChange('tool_execute', {
                tool: name,
                ...(options.agent === undefined ? {} : { agent: options.agent.name })
            });
        }
    };

    const executeTool = async (name: string, parameters: unknown): Promise<unknown> => {
        const definition = tools[name];

        // The session owns which tools exist: a harness without subagents has no
        // agentDelegate, so an operator asking for one gets an honest error here (the
        // server maps it to 404) instead of a fabricated implementation. The same is
        // true of toolCreate under `toolCreation: false`.
        if (!definition) {
            throw new HarnessError(`Tool "${name}" is not registered in this harness.`);
        }

        // Baseline branch controls are not host-callable. A manual call has no
        // requester transcript to fork and no owner run to ask. The check uses the
        // resolved definition MARKER, so a replacement under the same name is an
        // ordinary tool and is callable here.
        if (runtimeControlDefinitions.has(definition)) {
            throw new HarnessError(
                `Tool "${name}" is not available through executeTool: it requires the harness run that owns the conversation.`
            );
        }

        const resolved = resolveToolParameters(definition.parameters, parameters, 'direct');

        try {
            return await definition.execute({
                parameters: resolved,
                // An explicit host call acts as the session's entry agent: agentDelegate
                // therefore stays primary-only, and ctx.run cycles and the depth rule are
                // still enforced by runAgent.
                agent: primary,
                agents,
                // Manual/nested calls receive the same LIVE harness reference. A tool
                // must never be handed a clone or a state snapshot as a substitute.
                harness: handle,
                callTool: (nestedName: string, nestedParameters: unknown) =>
                    callToolInternal(nestedName, nestedParameters, { agent: primary, runDepth: 1 }),
                // A manual call is a top-level action (depth 1), exactly like a
                // harness invocation; delegation and the depth rule see it that
                // way.
                runDepth: 1,
                run: (agentName: string, input: string) => {
                    const target = agents[agentName];
                    if (!target) {
                        throw new HarnessError(`Agent "${agentName}" is not registered.`);
                    }
                    // T2/R1: a MANUAL agentDelegate call gets the same answer
                    // extraction as the model path, so a host-triggered delegation
                    // cannot return a blank terminal turn while the child already
                    // answered substantively. Other manual ctx.run tools keep the
                    // literal final-turn return.
                    return runAgent(
                        target,
                        input,
                        undefined,
                        undefined,
                        undefined,
                        delegateAnswerDefinitions.has(definition) ? DELEGATE_ANSWER : undefined
                    );
                }
            });
        } finally {
            // Manual calls emit no progress events (they are not conversation
            // turns), so this is the ONLY notification a persistence layer gets
            // for a UI Tools-tab mutation. It fires on failure too, since a tool
            // may have mutated state before throwing.
            notifyStateChange('tool_execute', { tool: name });
        }
    };

    // The harness is a function you call. Properties ride on it so a CLI has
    // everything in one handle without a second lookup object.
    const run = (input: string, options?: HarnessRunOptions) =>
        // `attachments` is the FINAL argument and is intentionally absent from
        // every nested runAgent call: only the root prompt may carry media.
        runAgent(primary, input, options?.signal, undefined, undefined, undefined, options?.attachments);

    // Every Harness field except `name` and `discoveredTools` is assigned here.
    // Those two are defineProperty'd below: `name` is a built-in function property
    // that cannot be assigned, and `discoveredTools` must be a getter so a caller
    // can never mutate the enabled set. The `unknown`-mediated cast is therefore
    // describing exactly that: a complete handle assembled from two sources. Keep
    // this list in step with the Harness type — an omitted accessor typechecks as
    // `never` here and the cast would silently hide it.
    let handle!: Harness;
    handle = Object.assign(run, {
        agent: primary,
        agents,
        subagents,
        tools,
        plugins: pluginNames,
        // The single kernel registration operation. Runtime source revisions and
        // the model-facing toolRegistry both go through this exact function.
        registerTool,
        toolSource,
        toolSources,
        callTool: (name: string, parameters: unknown, options?: HarnessToolCallOptions) =>
            callToolInternal(name, parameters, options),
        // Stable, replacement-surviving tool memory.
        memory,
        // Live operations behind the standalone core-tool source entries.
        runtime,
        // Host-side runtime creation: the same path the model's toolCreate tool
        // uses, so validation, budget, collision rules, and immediate enablement
        // are identical. Throws HarnessError, unlike the model path which turns
        // the failure into a tool result.
        createTool: createToolFrom,
        // The public Harness type names this capability toolCreate; keep both
        // spellings as the same function for backward compatibility.
        toolCreate: createToolFrom,
        // Server-facing manual execution (R8): the session-bound tool invocation
        // `POST /tools/:name` uses when a client supplies a sessionId.
        executeTool,
        // N6 branch audit. Ephemeral: never snapshot/restore state. Every read is a
        // DETACHED copy, so a caller cannot mutate a live record (or its branch
        // transcript) through the handle. Retention is bounded by
        // maxBranchRecords with active records never evicted.
        branches: () => retainedBranches().map(cloneBranchRecord),
        branch: (id: string) => {
            const record = retainedBranches().find((entry) => entry.branchId === id);
            return record === undefined ? undefined : cloneBranchRecord(record);
        },
        // R2 persistent threads. Reads are detached copies (a record or a
        // transcript), writes are the explicit lifecycle calls below. The default
        // conversation of every configured agent is always present as
        // `agent:<name>`; `createThread` adds independent conversations.
        threads: () =>
            [...threadStates.values()]
                .sort((left, right) => left.record.sequence - right.record.sequence)
                .map((state) => threadRecordCopy(state.record)),
        thread: (id: string) => {
            const state = threadStates.get(id);
            return state === undefined ? undefined : threadRecordCopy(state.record);
        },
        threadMessages,
        createThread,
        sendThreadInput,
        steerThread,
        stopThread,
        stopAllThreads,
        deleteThread,
        // R3a persistence. `snapshot` never mutates; `restore` validates fully
        // and recompiles created-tool sources without executing them.
        snapshot,
        restore,
        // reset() is "start over": EVERY agent's conversation goes back to its
        // seeded instructions (R12 — a subagent used to keep its transcript, which
        // leaked one session into the next), tool discovery is forgotten, the
        // session todo list and record stores (profiles, chapters, locations) are
        // cleared (ids restart at "1"), and the agent-result registry is emptied
        // (invocation ids are session-scoped), so the next run begins from the core
        // set and empty session state.
        //
        // Deliberately NOT reset:
        //   - tools created at runtime stay in the catalogue (registry state, not
        //     conversation state); they are simply no longer enabled;
        //   - the creation BUDGET stays spent. It is a lifetime budget: restoring
        //     it here would let a session grow the registry without bound one reset
        //     at a time.
        reset: () => {
            // R2: a reset clears every conversation, so it cannot run underneath
            // one. Existing harness calls already had no guard (they reset the
            // transcripts a live run was using); a host thread makes that
            // unrecoverable, so it is refused explicitly here.
            for (const state of threadStates.values()) {
                if (state.record.status === 'running' || state.run !== undefined) {
                    throw new HarnessError(
                        `Cannot reset while thread "${state.record.id}" is running; stop it first.`
                    );
                }
            }

            for (const brain of Object.values(agents)) brain.reset();
            activeTools.clear();
            discoveryOffsets.clear();
            todo.reset();
            profile.reset();
            chapter.reset();
            location.reset();
            invocationRecords.clear();
            // R2: host conversations belong to the session's conversation state,
            // so they are removed with it. The id high-water mark is NOT restored
            // (a deleted id stays retired, like the creation budget), and the
            // threadSend tool stays registered (it is catalogue state).
            for (const state of [...threadStates.values()]) {
                // Invalidate any turn still queued on this conversation: reset
                // clears the history it was going to read.
                state.generation += 1;

                if (state.record.origin === 'host') threadStates.delete(state.record.id);
                else {
                    state.record.status = 'idle';
                    state.queue.length = 0;
                    state.run = undefined;
                    state.controller = undefined;
                    delete state.record.invocationId;
                    // L2: the runtime-only owner link of a default conversation is
                    // part of the conversation being cleared, so a reset must not
                    // leave a stale `ownerThreadId` (which a restart would not
                    // reproduce anyway).
                    delete state.record.ownerThreadId;
                }
            }
            // A reset is a snapshot-managed mutation too: a server must persist
            // the cleared transcripts/stores instead of keeping the old file.
            notifyStateChange('reset');
        }
    }) as unknown as Harness;

    // `name` is a built-in, read-only property of every function, so it must be
    // defined rather than assigned. The entry agent's name is the harness name.
    Object.defineProperty(handle, 'name', {
        value: primary.name,
        enumerable: true,
        configurable: true
    });

    // Read-only discovery view (`Harness.discoveredTools`). A getter that copies
    // the Set on every read: a caller must never be able to mutate the enabled
    // set through the handle, and a server snapshot can record the list so a
    // reload still knows which capabilities were discovered.
    Object.defineProperty(handle, 'discoveredTools', {
        get: () => [...activeTools],
        enumerable: true,
        configurable: true
    });

    return handle;
};

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
//
// src/ holds only this file. Everything else is barrelled from its role folder,
// and re-exported here so the package has one entry point:
//
//   core       agent, tool, searchTools, createDynamicTool — usable without a harness
//   transport  openAICompatible, listModels, ModelListError — wire + catalogue
//   tools      the preset tools        — executable on their own
//   util       HarnessError            — the error type
//   types      every public type
//
// Internal folders import each other directly, so a barrel is never load-bearing
// for the runtime wiring — it only defines what consumers can reach.
//
// The tool re-exports are lazy proxies (see tools/lazy.ts): naming them here does
// not import a single implementation, so `import { harness } from '@underload/harness'`
// costs no `node:fs`/`child_process`/`vm` load. The result types are exported
// alongside each tool so a consumer can type a direct call without reaching into
// an internal path.
export { agent, tool, searchTools, compileToolSource, createDynamicTool, toolUi, toolUiOf } from './core';
// R3a persistence: the schema version a caller stores beside a snapshot. The
// snapshot types (HarnessSnapshot, HarnessAgentSnapshot, ...) and the per-store
// state types are part of `export type * from './types'` below.
export { HARNESS_SNAPSHOT_VERSION } from './core';
// R10/R11/R12 shared helpers. `boundToolResult` + MODEL_TOOL_RESULT_BUDGET_BYTES
// are the model-facing 64 KiB cap, exported so a server can apply the SAME cap
// when it serializes a manual `executeTool` result, and so a tool author can
// quote the number. `resolveToolParameters` is the canonical unwrap/validate
// helper (the manual path and the model path both use it); the schema helpers
// let a host validate arguments before a run. DEFAULT_CREATED_TOOLS_LIMIT is the
// lifetime toolCreate budget.
export {
    MODEL_TOOL_RESULT_BUDGET_BYTES,
    boundToolResult,
    utf8ByteLength,
    resolveToolParameters,
    validateSchemaValue,
    checkToolSchemaComplexity,
    MAX_CREATED_SCHEMA_DEPTH,
    MAX_CREATED_SCHEMA_NODES,
    MAX_CREATED_SCHEMA_BYTES,
    DEFAULT_CREATED_TOOLS_LIMIT
} from './core';
export type { BoundedToolResult, SchemaCheck, ToolArgumentMode } from './core';
// The session record factories are public too, so a host can build the same
// stores the harness registers (e.g. for a server-side tool or a test). They
// mirror the core/index.ts exports; todoManage's factory stays internal to keep
// this change scoped.
export { createProfileTool, createChapterTool, createLocationTool } from './core';
// R4 cross-thread chat descriptor. The tool is registered CONDITIONALLY (once a
// session owns an independent thread), so a server catalogue can quote the same
// name/description/schema the runtime uses without advertising it up front.
export { THREAD_LIST_METADATA, THREAD_LIST_NAME, THREAD_SEND_METADATA, THREAD_SEND_NAME } from './core';
export { MAX_THREAD_LABEL_CHARS, MAX_THREAD_RECORDS, defaultThreadIdOf } from './core';
// Tool-panel bounds and the normalizer are public too: a client or a host-side
// tool author can quote the same caps the server enforces (see core/tool-ui.ts).
export { TOOL_UI_LIMITS, normalizeToolUiPanels } from './core';
export type { ToolUiExtraction } from './core';
export { openAICompatible, listModels, ModelListError } from './transport';
export type { ModelListConfiguration, ModelListErrorKind } from './transport';
export {
    syntaxCheck,
    fileRead,
    fileWrite,
    fileEdit,
    fileList,
    fileGlob,
    commandRun,
    gitDiff,
    createWebSearchTool,
    WEB_SEARCH_METADATA,
    WEB_SEARCH_TOOL_NAME,
    createWebFetchTool,
    WEB_FETCH_TOOL_NAME,
    presetTools
} from './tools';
export type {
    SyntaxCheckLanguage,
    SyntaxCheckParameters,
    FileReadEntry,
    FileReadParameters,
    FileReadResult,
    FileReadTarget,
    FileWriteEntry,
    FileWriteParameters,
    FileWriteResult,
    FileWriteResultEntry,
    FileEditEntry,
    FileEditParameters,
    FileEditResult,
    FileEditResultEntry,
    FileListParameters,
    FileGlobFilesResult,
    FileGlobMatch,
    FileGlobMatchesResult,
    FileGlobParameters,
    FileGlobResult,
    GitDiffParameters,
    GitDiffResult,
    CommandRunResult
} from './tools';
export { HarnessError } from './util';
export type * from './types';

