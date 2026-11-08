// Worker-mode capability assessment: the decision a session makes ONCE, at
// creation/restore, about whether its turns may run on lane workers.
//
// WHY THIS IS AN EXPLICIT DECISION AND NOT A FALLBACK
// ---------------------------------------------------
// `threadExecution: 'worker'` is a deployment promise: the configured worker mode
// must REALLY isolate the thread's execution. Quietly rebuilding a session inline
// because something about it was awkward would let a deployment believe it was
// isolated while a CPU-bound tool still froze the server. So an unsupported
// capability is a REASON with a name and a fix (SessionError → HTTP 4xx/5xx), and
// the only inline execution left in worker mode is the one the operator opted into
// by leaving `threadExecution` at 'inline'.
//
// WHAT MAKES A PRESET REBUILDABLE IN A WORKER
// -------------------------------------------
// A worker cannot receive a closure, so it must rebuild the session's harness from
// durable data: `presetFromRecord(record)` (harnesses/registry.ts ~638) turns a
// `HarnessPresetRecord` back into a factory, and the live toolbox registers its
// tools from SOURCE PATHS (harnesses/toolbox.ts, `SHARED_TOOL_SOURCES`) so the same
// definitions recompile inside the worker. That holds exactly for the three shipped
// template kinds:
//
//   - 'live'     -> createProfiledHarness  (agents + source toolbox + provider)
//   - 'flaky'    -> the live toolbox plus the discovered example tool sources
//   - 'scripted' -> the shipped offline transport, looked up by name
//
// A preset with NO template was injected by a host: its `create` factory, its
// configured `Tool` objects, and any custom command are closures. Nothing in the
// process can serialize them, so the record itself says "cannot be rebuilt from
// disk" (registry.ts ~678). Worker mode therefore refuses such a session.
//
// Cross-references:
//   - ../harnesses/registry.ts  presetFromRecord + the injected-factory error
//   - ../harnesses/toolbox.ts   source-path registration (the reason 'live' works)
//   - ./protocol.ts             LaneBlueprint (what a worker actually receives)
//   - ../sessions.ts            where this decision gates create/restore (a 400)
//   - ./lane-host.ts            where a worker's own report fails the hello

import { Worker } from 'node:worker_threads';
import type { ServerRuntimeConfiguration } from '../config';
// Runtime CONFIGURATION errors come from the server config layer; this module owns
// only the readiness decision, so the two never disagree about the error type.
import { ServerRuntimeError } from '../config';
import type { HarnessPreset } from '../harnesses/types';

export type LaneWorkerCapability = {
    // True only when every turn of this preset can run on a lane worker.
    supported: boolean;
    // Blocking reasons. Each one names the capability and the fix, in the order the
    // operator can act on them.
    reasons: { code: string; message: string }[];
    // Non-blocking facts about what worker mode does NOT move off the main thread
    // (they stay coordinator-side by design and must not be presented as isolated).
    notes: string[];
};

// What worker mode does NOT move off the coordinator, and what it moves
// DELIBERATELY. Asserted verbatim in ./capability.test.ts, because these sentences
// are the isolation promise an operator reads: a claim that is not implemented by the
// contract must not appear here.
const WORKER_MODE_NOTES: readonly string[] = [
    'In worker mode every harness body runs in a lane worker: a queue turn, the legacy root /messages run, a session-bound direct tool call (POST /tools/:name with a sessionId), and a slash command alike, so the coordinator executes no harness work inline on the event loop.',
    'A session-shared operation (a record store, the tool registry, tool discovery, the agent-result archive, a cross-thread send or roster read) is routed from the lane replica through harness.runtime to the coordinator, which performs it on the canonical harness and returns the answer - so shared state has exactly one writer of record.',
    'A cross-thread READ is routed the same way: harness.threadMessages and harness.thread on a lane replica answer from the canonical harness, so threadRead sees another lane\'s conversation and a thread another lane created, never this replica\'s private copy.',
    'Only the coordinator holds the canonical document: harness.snapshot(), harness.restore(), persistence, the event journal and every SSE response stay on it, because they serialize state rather than compute it.',
    'harness.memory is shared as a bounded window of the keys a tool names. A function or symbol value, or a tool that walks the map dynamically (memory.data, memory.keys(), a computed key), is refused naming the key or tool; nothing is silently dropped or coerced. A window is recomputed when a tool is created: the created revision is scanned at the coordinator before it is installed, its literal memory keys join the window, and one that reaches the map dynamically is refused at creation naming the tool.',
    'An agent default conversation has exactly one writer lane at a time; a lane that reaches an agent another lane holds waits for the lease instead of writing behind it.',
    'A tool registered from anywhere - a lane, the operator, a model - is applied at the coordinator first and broadcast to every live worker, so no replica keeps running a definition the authority replaced.',
    'LIMITATION (nested runs, refused before execution): worker mode does not centralise nested conversation state, so EVERY door that can start a child conversation is refused on a lane, and every refusal names itself (nested-run-unsupported). The policy is ARMED ON EVERY LANE, whatever preset that lane rebuilt - it is a property of the execution mode, not an opt-in a harness can skip - and a replica whose build has no nested-run seam faults the handshake instead of running children on a private copy (there is no inline fallback). The two tool doors - delegate and threadFork - are removed from the replica at hello, and harness.runtime.delegate on a replica throws. The execution-context doors are refused by the armed core at the surfaces it hands the tool itself: context.run/ctx.run in whatever spelling the body uses, the harness callable, harness.sendThreadInput, and a sibling brain run through context.agents - and because a REFUSING replica hands the body a guarded handle view rather than the raw one, a reference the body stores and calls AFTER its own call settled is refused just the same. A refused door creates nothing at all - no child thread record, no transcript append, no provider request. A revision whose captured source reaches one of those doors is refused at hello naming the tool, because a body whose purpose is a nested child has nothing to do on a lane; one that only reaches context.run is reported with the same code, because that is what it gets at runtime, and the shipped textSummarize answers with its documented local condensation instead. A plain read and every routed harness.runtime operation pass through the same view untouched, which is why threadRead, threadSend and threadList keep working in worker mode. An unscanned closure body (a tool the preset factory constructed) is refused the same doors by the armed core, and a harness INJECTED as a factory closure - which no lane can rebuild - is refused worker mode outright (preset-not-rebuildable) rather than run inline. Worker mode does not promise nested conversation state.',
    'A branch audit is lane-local by core design (branch state is deliberately absent from snapshot v1), so worker mode removes the fork tool rather than keeping a private branch the coordinator cannot list. A tool body that touches a canonical-document member of the live handle (harness.snapshot/restore/reset/registerTool/createThread/sendThreadInput and friends) is refused at hello naming the tool, never run against a private copy.'
];

const reason = (code: string, message: string): { code: string; message: string } => ({ code, message });

// Assess ONE preset. Called at session creation and again at restore, because a
// registry patch may replace a rebuilt entry with an injected one.
export const assessLaneWorkerCapability = (
    preset: HarnessPreset,
    environment: { workersAvailable: boolean; message?: string } = { workersAvailable: true }
): LaneWorkerCapability => {
    const reasons: LaneWorkerCapability['reasons'] = [];

    // Platform gate first: without a Worker constructor there is nothing to spawn,
    // and the answer must not look like a preset problem.
    if (!environment.workersAvailable) {
        reasons.push(
            reason(
                'worker-unavailable',
                environment.message ??
                    'This host has no worker threads, so threadExecution "worker" cannot isolate a thread. Run with threadExecution "inline".'
            )
        );

        return { supported: false, reasons, notes: [...WORKER_MODE_NOTES] };
    }

    // Rebuildability gate: the durable template tag is the only honest signal that
    // the harness can be reconstructed from data.
    if (preset.template === undefined) {
        reasons.push(
            reason(
                'preset-not-rebuildable',
                `Harness "${preset.name}" was injected as a factory closure, so a lane worker cannot rebuild it. Register it as a template-backed harness ("live"), or run this session with threadExecution "inline".`
            )
        );
    }

    return {
        supported: reasons.length === 0,
        reasons,
        notes: [...WORKER_MODE_NOTES]
    };
};

// The message the store raises for an unsupported session. One formatter keeps the
// HTTP surface, the CLI, and the tests quoting the same sentence.
export const laneWorkerUnsupportedMessage = (capability: LaneWorkerCapability): string =>
    `This harness cannot run its threads on worker lanes: ${capability.reasons
        .map((entry) => entry.message)
        .join(' ')}`;

// ---------------------------------------------------------------------------
// Per-tool placement (the supported-capability contract)
// ---------------------------------------------------------------------------
//
// A lane worker may run a tool BODY - that is the CPU work isolation exists for -
// but it may not be the place where SESSION-SHARED state is mutated. Every core tool
// below owns shared state (the record stores, the tool registry, the thread roster,
// the result archive, the owner question), so in worker mode its entry runs as a thin
// proxy that submits an operation to the authority and returns the receipt's answer
// (./lane-commit.ts). Placement is decided from NAMES the core itself exports, so a
// renamed core tool cannot silently drift into lane-local execution.
//
// `lane-local` is the default: a file, shell, search or app tool touches the process,
// not the session's shared records, so its body belongs on the lane's CPU.
//
// `unsupported` is reserved for a tool whose SHARED reach cannot be expressed as an
// operation at all: a host-registered definition with no captured source revision
// (nothing to rebuild here), or a tool body that walks `harness.memory` dynamically
// (`.data`, `.keys()`, a computed key) so its read-set cannot be bounded, or a body
// that calls `harness.snapshot()`/`restore()` - those read or replace the CANONICAL
// document, which only the authority may do.
export type ToolPlacement = 'lane-local' | 'authority-proxy' | 'unsupported';

export type ToolSurface = {
    name: string;
    placement: ToolPlacement;
    // Blocking: this tool cannot execute in a lane at all, and the reason names the fix.
    reasons: { code: string; message: string }[];
    // Non-blocking facts about the tool. A tool registered without a captured source
    // revision is in here, NOT in `reasons`: the replica rebuilds that tool exactly as the
    // authority has it (same preset record), so it CAN run - only its body cannot be
    // scanned. Its shared operations are still routed to the authority, and a memory write
    // it did not read is refused, so an unscanned body cannot lose a sibling's update.
    warnings: { code: string; message: string }[];
    // Memory keys a proxied/laned tool may touch, when they can be bounded.
    memoryKeys: string[];
    memoryDynamic: boolean;
};

// Shared-state core tools: the tools whose RESULT is session-shared state, so in worker
// mode their work is performed by the authority and only the answer crosses back
// (./lane-authority.ts routes them through the replica's `harness.runtime`).
//
// The list is deliberately a NAME set, cross-checked in ./capability.test.ts against
// `AUTHORITY_RUNTIME_METHODS` (the interception surface) and against the shipped tool
// sources: a core tool that mutates shared state but is missing here would run its body
// on the lane against a private copy of the session - a lost write, silently.
//
// NOT in this list, on purpose:
//   - `threadFork` - a runtime CONTROL tool (branch machinery in the run that owns the
//     conversation), so no proxy exists for it. Its branch state is ephemeral by core design
//     (deliberately absent from snapshot v1, harness.ts ~3841). T12/S7 refuses it in worker
//     mode rather than running it against a private copy - see NESTED_RUN_TOOL_NAMES.
//   - `toolCancel` - cancels a background call of THIS run, which lives in the lane.
//   - `delegate` - see DELEGATION_TOOL_NAME, and the nested-run refusal below.
export const SHARED_STATE_TOOL_NAMES: readonly string[] = [
    // The record family (records-engine T1): the engine surface and its four wrappers.
    // Every one of them ends its source entry with `harness.runtime.executeRecords`, so
    // a lane write is performed on the canonical harness — and a name missing here would
    // run its body on the lane against a private copy of the session (a lost write).
    'records',
    'tasks',
    'chapters',
    'profiles',
    'locations',
    'toolCreate',
    'toolManage',
    'toolRegistry',
    'toolRequest',
    'toolList',
    'threadSend',
    'threadList',
    'agentManage',
    'agentResult'
];

// The `harness.runtime` methods whose work belongs to the authority, each with the
// canonical tool name it backs (the shipped core tool sources do nothing but delegate to
// these — every record entry ends with
// `context.harness.runtime.executeRecords(<its own name>, context)`). Interception
// happens on the REPLICA's handle, so no tool source changes and no shared write is
// ever performed locally.
export const AUTHORITY_RUNTIME_METHODS = {
    executeRecords: 'records | tasks | chapters | profiles | locations',
    manageTool: 'toolManage',
    createToolForAgent: 'toolCreate',
    requestTools: 'toolRequest',
    listTools: 'toolList',
    agentManage: 'agentManage',
    agentResult: 'agentResult',
    threadSend: 'threadSend',
    threadList: 'threadList'
} as const satisfies Record<string, string>;

export type AuthorityRuntimeMethod = keyof typeof AUTHORITY_RUNTIME_METHODS;

// The routed list, derived from the map above so a new entry there CANNOT be forgotten in the
// worker's guard (./lane-worker-loop.ts imports this constant rather than restating it).
export const ROUTED_RUNTIME_METHODS = Object.keys(AUTHORITY_RUNTIME_METHODS) as AuthorityRuntimeMethod[];

// The runtime methods a lane runs LOCALLY. `search`/`fetch` are provider/network work with no
// session-state write. `delegate` is listed because the key EXISTS on the replica and nothing
// crosses for it - T12 (S7) replaced it with the nested-run refusal (./lane-worker-loop.ts
// `refuseNestedRuns`), so the classification stays "local" while the behaviour is a named
// refusal. A new runtime method must be classified here or above before a worker accepts a
// run, and ./lane-authority.test.ts asserts the two sets cover every key the replica exposes.
export const LOCAL_RUNTIME_METHODS = ['delegate', 'search', 'fetch'] as const;

export type LocalRuntimeMethod = (typeof LOCAL_RUNTIME_METHODS)[number];

export const isAuthorityRuntimeMethod = (value: unknown): value is AuthorityRuntimeMethod =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUTHORITY_RUNTIME_METHODS, value);

// The handle members a lane-local TOOL BODY may not use, because they read or move the
// canonical document rather than the lane's own conversation. A source that mentions one
// is refused at hello naming the tool (never executed against a private copy).
export const LANE_FORBIDDEN_HANDLE_CALLS = [
    'snapshot',
    'restore',
    'reset',
    'registerTool',
    'createTool',
    'toolCreate',
    'createThread',
    'setThreadMessages',
    'appendThreadMessages',
    // T4.1: the in-place prefix rewrite belongs with the two above. All three move the
    // CANONICAL transcript; a lane's tool body may only influence it by committing operations.
    'patchThreadMessages',
    'setThreadStatus',
    'archiveInvocation',
    'deleteThread',
    'sendThreadInput',
    'stopThread',
    'stopAllThreads'
] as const;

// True when a tool body reaches one of the handle members above. The access pattern accepts
// BOTH spellings a real body writes (`.harness.createThread(...)` and the optional-chained
// `.harness?.createThread(...)`), and requires the handle reference - a local variable named
// `harness` is not the live handle, and inventing a refusal for it would be a false positive.
// Scanned once per tool; the matched members are named in the refusal so the fix is obvious.
export const reachesCanonicalDocument = (source: string): string[] =>
    LANE_FORBIDDEN_HANDLE_CALLS.filter((member) => new RegExp(`\\.harness\\s*(?:\\?\\.|\\.)\\s*${member}\\b`).test(source));

// The handle members a lane REPLICA READS THROUGH THE AUTHORITY instead of its private copy.
//
// T10 finding S1: `threadRead` resolves a conversation with `harness.threadMessages(id)` and
// `harness.thread(id)`. Both are reads of SESSION-SHARED state, and a replica is a snapshot
// plus whatever this lane itself has run, so a direct handle read is stale and cannot see a
// thread another lane created. ./lane-worker-loop.ts therefore replaces these two members on
// the replica with routed reads that answer from the canonical harness, and the tool entry
// awaits them (a routed read is a promise by construction; `await` of the inline synchronous
// read is the same value). They are NOT in LANE_FORBIDDEN_HANDLE_CALLS: refusing every thread
// read would take the cross-thread feature away in worker mode, and routing it keeps it.
export const LANE_ROUTED_HANDLE_READS = ['threadMessages', 'thread'] as const;

// The whole scannable text of one installed tool revision: the entry PLUS every captured
// local helper, because a helper is where a real body keeps its `harness.memory` reach.
//
// T10 finding M5: the capability scan used to read `HarnessToolSource.source`, which is only
// populated for the legacy `format: 'function-body'` registration. Every shipped core tool is
// registered as `format: 'module'`, whose text lives in `moduleText`, so the scan received
// `undefined` for all 30 tools and produced an EMPTY refusal list - the memory and canonical-
// document checks passed vacuously. One helper means one place where the field choice is
// correct, so the worker report, the authority's created-tool check and the session-level plan
// cannot drift apart again.
//
// Returns `undefined` only when nothing was captured (a host-supplied closure definition),
// which is the case ./capability.ts keeps as a warning rather than a refusal.
export const toolScanTextOf = (record: {
    source?: string;
    moduleText?: string;
    dependencies?: readonly { text: string }[];
}): string | undefined => {
    const entry = record.moduleText ?? record.source;

    if (entry === undefined) return undefined;

    const helpers = (record.dependencies ?? []).map((helper) => helper.text);

    // A dependency can only add reach, so joining is the honest scan input; the entry text
    // stays first so a refusal names the part a model can still edit.
    return helpers.length === 0 ? entry : [entry, ...helpers].join('\n');
};

// The delegation tool is shared-state ADJACENT: it runs another agent's conversation,
// which is a shared record. It USED to stay lane-local (its loop is the CPU work) under a
// one-writer lease on that agent's default conversation (F5, the `brain:claim` request);
// T12/S7 refuses it in worker mode entirely, because the CHILD record it creates was not
// centralised - see NESTED_RUN_TOOL_NAMES below. The lease machinery stays: the
// coordinator still uses it for an agent default conversation it runs itself.
export const DELEGATION_TOOL_NAME = 'delegate';

// Every one of the shared-state tools has a lane-side proxy, so none of them is
// `unsupported` by name alone. `delegate` needs the lease, not a proxy - and now a
// refusal (NESTED_RUN_TOOL_NAMES) before either matters.
export const isSharedStateTool = (name: string): boolean => SHARED_STATE_TOOL_NAMES.includes(name);

// T12 (S7) + T14: the nested-run tools are REFUSED in worker mode, before they execute.
//
// WHY REFUSE RATHER THAN RUN: `delegate` and `threadFork` each start a CHILD conversation
// inside the run. In a lane that child - its thread record AND its transcript - exists only
// in that lane's replica, because adopting a thread by an EXISTING id needs a core seam the
// coordinator does not have (see ./lane-authority.ts, which can only mint or mirror ids it
// creates itself). Running them there produced a real answer behind phantom state: the
// archived child result reached the coordinator, `threadList`/`threadRead` could not name the
// child, and the transcript vanished when the lane was reclaimed.
//
// REFUSING is the honest half of the contract: the model reads a NAMED limitation instead of
// a silently weakened guarantee. THREE levers close the paths, because three kinds of door can
// start a child (T14 added the third, which is the one a tool body actually holds):
//   - the tool entries (`delegate`, `threadFork`) are removed from the replica's registry, so
//     neither is declared to the model nor resolvable by a call - this is the only mechanism
//     that stops `threadFork`, whose dispatch is a core CONTROL path (`registration.control:
//     'fork'`, src/tools/runtime/threadFork.tool.ts:59) keyed on a marker the lane cannot
//     reach (src/harness.ts:2111-2120, 7682);
//   - `harness.runtime.delegate`, the built-in runtime route the tool entry itself calls
//     (src/tools/runtime/delegate.tool.ts:120), is replaced with a thrower;
//   - the CORE nested-run policy is ARMED on the replica (`replica.nestedRuns('refuse')`; the
//     doors live in src/harness.ts and the sentence in src/core/nested-runs.ts). That covers
//     `context.run` in any spelling, a `harness(...)` call made from inside a tool body, and a
//     sibling brain run straight from `context.agents` — the doors T13 measured still open
//     behind the first two levers (the shipped `textSummarize` reached a child through
//     `context.run` and lost its transcript in the lane).
// The per-BODY door scan below (`LANE_NESTED_RUN_DOORS`, `reachesNestedRunDoors`) names which
// of those doors a captured revision reaches, and refuses up front the ones whose whole purpose a
// lane can never honour (the armed core refuses every one of them at runtime, whatever the spelling).
// Cross-thread state is NOT in this set: `threadSend`/`threadList` route to the authority and
// `threadRead` reads through it (LANE_ROUTED_HANDLE_READS), so the feature survives.
export const NESTED_RUN_TOOL_NAMES = ['delegate', 'threadFork'] as const;

// The code and the sentence now live in the CORE, because the runtime guard raises them and this
// report only quotes them (src/core/nested-runs.ts). Re-exported here so every worker surface —
// the hello report, the replica's runtime refusal, ./lane-worker-loop.ts and the tests — keeps
// importing one name and cannot drift from what the core actually throws.
export {
    NESTED_RUN_LIMITATION_CODE,
    NESTED_RUN_POLICIES,
    assertNestedRunPolicy,
    nestedRunRefusalMessage,
    nestedRunUnsupportedError
} from '../../core/nested-runs';
import { NESTED_RUN_LIMITATION_CODE, nestedRunRefusalMessage } from '../../core/nested-runs';

// The report's spelling of the refusal: a registry entry is named as a tool, a runtime door is
// named as the call the author wrote. Both go through the SAME core formatter.
export const nestedRunLimitationMessage = (name: string): string =>
    nestedRunRefusalMessage(`Tool "${name}"`);

export const isNestedRunTool = (name: string): boolean =>
    (NESTED_RUN_TOOL_NAMES as readonly string[]).includes(name);

// ---------------------------------------------------------------------------
// The nested-run DOORS a tool BODY can reach (T14)
// ---------------------------------------------------------------------------
//
// `NESTED_RUN_TOOL_NAMES` closes the two doors that are TOOLS. The third door is the execution
// context itself: every tool body receives `context.run`, the live `context.harness`, and the
// sibling registry `context.agents`, and each of those can start a conversation this lane cannot
// publish. Two facts decide how a door is handled:
//
//   1. THE RUNTIME CLOSES `context.run`. The core builds that closure, so an armed replica
//      throws the named limitation there whatever spelling the body used
//      (`context.run(...)`, `ctx.run(...)`, `const { run } = context`, `const child = ctx.run`) —
//      the alias still calls the guarded closure. A door like this is REPORTED (a warning naming
//      the code), never rejected: the shipped `textSummarize` reaches it and handles the refusal
//      with a real local fallback, and refusing it would take a whole toolbox out of worker mode
//      for one summarizer call.
//   2. THE RUNTIME CLOSES THE HANDLE DOORS AT THE EXPOSURE (T15). A REFUSING replica does not hand
//      a tool the raw live handle at all: it hands it `toolHandleView()` (src/harness.ts), a stable
//      view whose conversation-starting members — the callable, `sendThreadInput`, and the brains
//      under `agents` / `subagents` — refuse WHENEVER they are called, so a body cannot dodge the
//      guard by storing the reference and firing it after its own call settled. An INLINE harness
//      keeps receiving the strict-identical live handle, exactly as it always did. These bodies are
//      still REFUSED before they run, naming the tool — a revision whose captured source starts a
//      nested conversation has no worker-safe purpose left, and installing it would promise the
//      model a call that can only fail. The runtime refusal is the guarantee; the up-front refusal
//      is the honest placement.
//
// HONESTY OF THE SCAN: these are TEXTUAL patterns over the captured revision, which is exactly
// what a hello-time scan can be. They deliberately do not claim complete JavaScript analysis — a
// computed member (`context[name]`), a renamed context parameter, or a helper that lives outside
// the scanned text can reach a door the pattern misses. That costs nothing: every door below is
// closed by the armed core at runtime as well, so a missed spelling is refused rather than run.
// The wording below says so on the surface itself, so nobody reads a regex as a sandbox.
export type NestedRunDoor = {
    // How the refusal names the door — in the spelling an author recognises in their own body.
    label: string;
    // True when the tool's OWN captured source reaches a nested conversation, so the revision is
    // refused before it is installed (a blocking reason) instead of running a body that can only
    // fail. False when the armed core guard is the enforcement and the scan only reports it (a
    // warning), which is what a tool with a real local path needs. Either way the door itself is
    // closed at runtime: an armed replica refuses it whatever spelling the body used, including a
    // reference the body stores and calls after its own call settled.
    blocking: boolean;
    // The textual patterns for this door. Any one match is enough to name it.
    patterns: readonly RegExp[];
};

// Door (1): the tool-context run, runtime-enforced in src/harness.ts. Named as a constant because
// the alias scan below reports under THIS label, and a label drift between the two would silently
// double-report the same door.
const NESTED_RUN_CONTEXT_DOOR: NestedRunDoor = {
    label: 'context.run(name, input)',
    blocking: false,
    patterns: [/\b(?:context|ctx|toolContext)\s*(?:\?\.|\.)\s*run\s*\(/]
};

export const LANE_NESTED_RUN_DOORS: readonly NestedRunDoor[] = [
    NESTED_RUN_CONTEXT_DOOR,
    {
        // Door (2a): the live handle called AS A RUNNER from inside a body. The core's own root
        // callable, so it writes the primary's conversation inside this replica.
        label: 'context.harness(...)',
        blocking: true,
        patterns: [/\b(?:context|ctx|toolContext)\s*(?:\?\.|\.)\s*harness\s*\(/]
    },
    {
        // Door (2b): a sibling brain run directly — the provider request and the transcript
        // append happen without ever reaching `runAgent`. Dot and bracket spellings.
        label: 'context.agents.<name>.turn() / .stream()',
        blocking: true,
        patterns: [
            /\bagents\s*(?:\?\.|\.)\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:\?\.|\.)\s*(?:turn|stream)\s*\(/,
            /\bagents\s*\[[^\]]{1,48}\]\s*(?:\?\.|\.)\s*(?:turn|stream)\s*\(/
        ]
    },
    {
        // `context.callTool('delegate')`: already refused at runtime, because the replica has no
        // such registry entry to resolve (an honest "not registered"), so it is reported, not
        // blocked. Named here so the report says what the body will really get.
        label: 'context.callTool("delegate" | "threadFork")',
        blocking: false,
        patterns: [/\bcallTool\s*\(\s*['"`](?:delegate|threadFork)['"`]/]
    }
];

// ---------------------------------------------------------------------------
// R7 — a CREATED tool must be purely standalone (records-engine Decision F, F8)
// ---------------------------------------------------------------------------
//
// A created tool computes its result from its own arguments (`sum(A,B)` is always the
// same; randomness is its declared outcome), which is exactly why an agent reaches for
// `toolCreate` instead of spending a model turn on the work. A created tool that only
// FORWARDS to another tool throws that away: it costs a registry entry, a schema and a
// nested call, and computes nothing the shadowed tool did not already do.
//
// The rule is STATED where the author writes the body (`toolCreate`'s description) and
// REPORTED here — never refused. ../core/creation.ts disclaims any sandbox ("no sandbox
// and no isolation"), these are TEXTUAL patterns that also match a comment or a string,
// and a hard semantic ban would be the first semantic restriction in a module that says
// there is none. Same `blocking: false` stance as the door above.
export const CREATED_TOOL_PROXY_CODE = 'created-tool-proxy';

// The spellings of "this body calls another tool": the routed door and the direct one,
// in both member-access spellings a body writes.
export const CREATED_TOOL_PROXY_PATTERNS: readonly RegExp[] = [
    /\bcallTool\s*\(/,
    /\.harness\s*(?:\?\.|\.)\s*executeTool\s*\(/
];

// True when a created body reaches another tool. Textual, and honest about being
// textual: a hit is a warning to read, never a proof.
export const reachesToolProxy = (source: string | undefined): boolean =>
    source !== undefined && CREATED_TOOL_PROXY_PATTERNS.some((pattern) => pattern.test(source));

// The wording of the report.
export const createdToolProxyWarning = (name: string): string =>
    `${CREATED_TOOL_PROXY_CODE}: Tool "${name}" was created with a body that calls another tool (callTool / harness.executeTool). A created tool is meant to be PURELY STANDALONE — a deterministic computation over its own arguments — because the point of creating one is to replace a model turn with something repeatable, not to rename a tool that already exists. This is reported, not refused: \`toolCreate\` compiles the body and runs whatever it says, and this scan is a text pattern that also fires on a comment or a string. Keep the call when the body does real work around it; drop the created tool when the whole body is a forwarding call.`;

// The destructured/aliased spellings of door (1). The bound name only counts once the body CALLS
// it, which keeps the scan honest: an unused binding is not a reach.
const NESTED_RUN_RUN_BINDINGS: readonly {
    pattern: RegExp;
    // 'destructure' binds `run` (optionally renamed) out of a context object; 'alias' binds the
    // whole member (`const child = context.run`).
    form: 'destructure' | 'alias';
}[] = [
    // `const { run } = context`, `let { run: child, agents } = ctx`
    { pattern: /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:context|ctx|toolContext)\b/g, form: 'destructure' },
    // `execute: async ({ parameters: notes, run, agents }) => ...` and the `export const
    // execute = async ({ run }) => ...` module form (the shipped spelling is the first one: the
    // context arrives as the parameter list, with no `= context` text to match)
    { pattern: /\bexecute\s*[:=]\s*(?:async\s*)?\(\s*\{([^{}]*)\}/g, form: 'destructure' },
    // `const child = context.run` / `const child = ctx?.run`
    { pattern: /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:context|ctx|toolContext)\s*(?:\?\.|\.)\s*run\b(?![\w$])/g, form: 'alias' }
];

// The name a destructuring binding list gives to the run member — `run`, or the alias in
// `run: child` — or undefined when the list never names it.
const runBindingNameOf = (binding: string): string | undefined => {
    const text = binding.trim();

    if (text.length === 0) return undefined;

    const aliased = /(?:^|[{,]\s*)run\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(text);

    if (aliased !== null) return aliased[1];

    return /(?:^|[{,]\s*)run(?=$|[}\s,])/.test(text) ? 'run' : undefined;
};

// The doors ONE body reaches, as label + enforcement class. Textual by construction; see the
// honesty note above `LANE_NESTED_RUN_DOORS`.
export const reachesNestedRunDoors = (source: string | undefined): { label: string; blocking: boolean }[] => {
    if (source === undefined) return [];

    const doors: { label: string; blocking: boolean }[] = [];
    const nestedRunDoor = LANE_NESTED_RUN_DOORS[0];

    for (const door of LANE_NESTED_RUN_DOORS) {
        if (door.patterns.some((pattern) => pattern.test(source))) {
            doors.push({ label: door.label, blocking: door.blocking });
        }
    }

    // The alias forms of `context.run` resolve to the SAME runtime door, so a hit is reported with
    // that door's label rather than a new code or a second warning.
    if (!doors.some((entry) => entry.label === nestedRunDoor.label)) {
        for (const binding of NESTED_RUN_RUN_BINDINGS) {
            // A /g pattern keeps `lastIndex` between calls, so reset it before every scan.
            binding.pattern.lastIndex = 0;

            let match: RegExpExecArray | null;

            while ((match = binding.pattern.exec(source)) !== null) {
                const captured = match[1] ?? '';
                const bound = binding.form === 'alias' ? captured : runBindingNameOf(captured);

                if (bound === undefined || !new RegExp(`\\b${bound}\\s*\\(`).test(source)) continue;

                doors.push({ label: nestedRunDoor.label, blocking: nestedRunDoor.blocking });
                break;
            }

            if (doors.some((entry) => entry.label === nestedRunDoor.label)) break;
        }
    }

    return doors;
};

// The doors the ARMED core guard closes on EVERY replica, named in the spelling a tool author
// wrote. `refuseNestedRuns` (./lane-worker-loop.ts) arms them on EVERY lane it starts — the arm is
// a property of the execution mode, not of a preset opting in — so the hello report can state what
// this replica refuses independently of whether the preset happened to register `delegate`.
// Cross-reference: src/harness.ts raises each one (`toolHandleView`, `toolAgentsView`, the guarded
// `run` closure and the `runAgent` entry), src/core/nested-runs.ts words it.
export const NESTED_RUN_ARMED_DOORS = [
    'context.run(name, input)',
    'harness(...) called from a tool body',
    'harness.sendThreadInput(...) called from a tool body',
    'harness.agents.<name>.turn() / .stream()'
] as const;

// The warning wording (runtime-enforced door).
export const nestedRunDoorWarning = (name: string, door: string): string =>
    `Tool "${name}" reaches a nested conversation through ${door}. A lane worker refuses that call with the named "${NESTED_RUN_LIMITATION_CODE}" limitation before the child, its transcript or its provider request exists — the guard is armed on the replica in src/harness.ts, so every spelling of the same door is refused, including an alias. The body must therefore handle the refusal or take a local path (the shipped textSummarize condenses the notes itself). The scan is TEXTUAL and only names what it can see; the runtime refusal, not this warning, is the guarantee.`;

// The refusal wording for a body whose OWN source starts the nested conversation. The code is the
// first token for the same reason the runtime refusal carries it: this sentence is what an HTTP
// error body and a model's tool result show, so the limitation must stay greppable even where the
// `code` field does not travel (../sessions.ts composes `reasons[].message` into one SessionError
// message). Truthfulness rule (T15): this says WHY the revision is refused up front (its captured
// source starts a child a lane cannot publish), and it does not claim the runtime is blind — the
// armed core refuses the same door at the handle the tool is handed, whatever the spelling.
export const nestedRunDoorReason = (name: string, door: string): string =>
    `${NESTED_RUN_LIMITATION_CODE}: Tool "${name}" starts a nested conversation through ${door}, which a lane cannot honour: the child's thread record and transcript would live only in this lane's replica. The revision is refused BEFORE it is installed, because a body whose own source starts a child conversation has nothing worker-safe left to do; the armed core refuses the same door at runtime too (src/harness.ts hands a refusing tool a guarded view of the handle, so the callable, sendThreadInput and a stored sibling brain all throw this limitation whenever they are reached, including from a callback kept past the call). Drop the nested call, reach shared state through harness.runtime (a routed operation), or run this session with threadExecution "inline".`;

// One formatter, so the hello warning, the replica's runtime refusal and the docs quote the
// same sentence (the rule `laneWorkerUnsupportedMessage` above already follows). It now lives in
// src/core/nested-runs.ts, next to the runtime guard that raises it; the re-export above and the
// `nestedRunLimitationMessage` tool-name spelling next to it are the worker-side surface.

/**
 * Decide where ONE tool executes in worker mode.
 *
 * `source` is the tool's captured module text (undefined for a host closure). The
 * scan is deliberately textual rather than interpretive: it asks only whether the
 * body reaches the surfaces that cannot cross a thread, and every hit is reported
 * with the code the operator can act on.
 */
export const assessWorkerToolSurface = (tool: {
    name: string;
    source?: string;
    // True when the tool came from the harness configuration as a constructed
    // definition (a closure) rather than a compiled source revision.
    closureOnly?: boolean;
    // True when the tool was AUTHORED by a model through toolCreate. The R7
    // standalone rule addresses exactly that author, so its scan runs only for
    // these — a shipped tool legitimately calls a sibling tool, and warning on
    // every one of them would bury the finding.
    created?: boolean;
}): ToolSurface => {
    const reasons: ToolSurface['reasons'] = [];
    const warnings: ToolSurface['warnings'] = [];
    const memoryKeys: string[] = [];
    let memoryDynamic = false;

    if (tool.closureOnly === true || tool.source === undefined) {
        warnings.push({
            code: 'closure-definition',
            message: `Tool "${tool.name}" has no captured source revision, so its body could not be scanned for shared reach. It runs lane-local: the replica rebuilt it from the same preset record, its shared operations route to the coordinator, and a memory write it never read is refused rather than merged.`
        });
    }

    // T12 (S7): a nested-run tool is not an UNSCANNABLE surface - the replica CAN run it, it
    // simply is not allowed to. Recording the refusal as a WARNING keeps `placement` honest
    // (`lane-local`, the capability the replica actually has) while the hello report still
    // names the limitation, and ./lane-worker-loop.ts enforces the removal the note promises.
    if (isNestedRunTool(tool.name)) {
        warnings.push({ code: NESTED_RUN_LIMITATION_CODE, message: nestedRunLimitationMessage(tool.name) });
    }

    if (tool.source !== undefined) {
        const access = assessMemoryAccessText(tool.source);

        memoryKeys.push(...access.keys);

        if (access.dynamic) {
            memoryDynamic = true;
            reasons.push({
                code: 'memory-dynamic',
                message: `Tool "${tool.name}" reaches harness.memory dynamically (memory.data, memory.keys(), or a computed key), so its shared read-set cannot be bounded for a lane worker. Read the keys it needs by name, or run this session with threadExecution "inline".`
            });
        }

        // A tool body that reaches a canonical-document or roster-lifecycle member of the
        // live handle cannot be honoured in a lane: the write would land in a private copy
        // and vanish. Refused HERE (before the run), naming the tool.
        const forbidden = reachesCanonicalDocument(tool.source);

        if (forbidden.length > 0) {
            reasons.push({
                code: 'canonical-document-access',
                message: `Tool "${tool.name}" calls harness.${forbidden.join('/harness.')} on the live handle, which reads or moves the canonical session document. In worker mode only the coordinator may do that; reach the same state through harness.runtime (a routed operation) or run this session with threadExecution "inline".`
            });
        }

        // T14: the nested-run DOORS this body reaches. Enforcement differs per door, and the
        // wording says which one applies (see LANE_NESTED_RUN_DOORS):
        //   - a RUNTIME-REFUSED door (`context.run`, and a `callTool` naming a removed entry) is
        //     a WARNING: armed cores refuse it before the child exists, so the tool still runs
        //     lane-local and the body can take a local path. Refusing it outright would ban a
        //     whole toolbox because one shipped tool summarises through a subagent;
        //   - a door NO runtime guard can see (the live handle used as a runner, a sibling brain
        //     run directly) is a REASON: the tool is refused before it can create a child nobody
        //     publishes.
        // R7 (records-engine Decision F / F8): a created body that FORWARDS to another
        // tool. Reported under its own code, never a reason, because ../core/creation.ts
        // disclaims a sandbox and a text scan also matches a comment (see the block above
        // `CREATED_TOOL_PROXY_CODE`).
        if (tool.created === true && reachesToolProxy(tool.source)) {
            warnings.push({
                code: CREATED_TOOL_PROXY_CODE,
                message: createdToolProxyWarning(tool.name)
            });
        }

        for (const door of reachesNestedRunDoors(tool.source)) {
            if (door.blocking) {
                reasons.push({
                    code: NESTED_RUN_LIMITATION_CODE,
                    message: nestedRunDoorReason(tool.name, door.label)
                });
            } else {
                warnings.push({
                    code: NESTED_RUN_LIMITATION_CODE,
                    message: nestedRunDoorWarning(tool.name, door.label)
                });
            }
        }
    }

    const placement: ToolPlacement =
        reasons.length > 0 ? 'unsupported' : isSharedStateTool(tool.name) ? 'authority-proxy' : 'lane-local';

    return { name: tool.name, placement, reasons, warnings, memoryKeys, memoryDynamic };
};

// Session-level roll-up: the memory keys the whole toolbox may touch, and any tool
// that must be refused before a worker starts.
export type WorkerToolPlan = {
    placements: Record<string, ToolSurface>;
    // Tools replaced by a lane-side proxy that submits ops to the authority.
    proxied: string[];
    // Bounded memory window the lanes receive.
    memoryKeys: string[];
    unsupported: ToolSurface[];
};

export const planWorkerToolSurfaces = (tools: { name: string; source?: string; closureOnly?: boolean }[]): WorkerToolPlan => {
    const placements: Record<string, ToolSurface> = {};
    const proxied: string[] = [];
    const memoryKeys = new Set<string>();
    const unsupported: ToolSurface[] = [];

    for (const tool of tools) {
        const surface = assessWorkerToolSurface(tool);

        placements[tool.name] = surface;

        if (surface.placement === 'authority-proxy') proxied.push(tool.name);
        if (surface.placement === 'unsupported') unsupported.push(surface);

        for (const key of surface.memoryKeys) memoryKeys.add(key);
    }

    return {
        placements,
        proxied: proxied.sort(),
        memoryKeys: [...memoryKeys].sort(),
        unsupported
    };
};

// The memory scan lives in ./lane-memory.ts (it is a memory rule); this alias keeps
// the capability contract readable without importing a second name.
import { assessMemoryAccess as assessMemoryAccessText } from './lane-memory';

// Deployment-level readiness for `threadExecution: 'worker'`.
//
// WHY THIS EXISTS AT ALL: a configured runtime that is accepted but not consumed is worse
// than an unsupported one, because the operator would read "worker" in the settings as "my
// CPU-heavy tool can no longer freeze the server". This build ships the whole path - host,
// worker entry, authority, applier, and the session branch in ../sessions.ts - so the only
// deployment-level refusal left is a platform that has no worker threads at all.
//
// The WORKER ENTRY is resolved per lane (./lane-host.ts resolveEntry) with the same error
// type, and a missing entry fails the session rather than degrading to inline: this check
// cannot see the filesystem at configuration time without coupling config to package layout.
//
// `ServerRuntimeError` (not SettingsError): this is a deployment condition, and the message
// names the exact variable and the value that starts the server today.
export const assertWorkerRuntimeReady = (runtime: { threadExecution: string }): void => {
    if (runtime.threadExecution !== 'worker') return;

    const environment = laneWorkerEnvironment();

    if (!environment.workersAvailable) {
        throw new ServerRuntimeError(environment.message ?? 'This process does not provide worker threads.');
    }
};

// Node-only reachability check, evaluated once per process by the lane host.
// `node:worker_threads` (imported at the top) is the authority: Node's MAIN thread
// does not expose a global `Worker` (verified on Node 24:
// `typeof globalThis.Worker === 'undefined'`, while `MessageChannel` is global), so
// probing the global would report "no workers" on the exact platform that has them.
export const laneWorkerEnvironment = (): { workersAvailable: boolean; message?: string } => {
    const isNode = typeof process !== 'undefined' && process.versions?.node !== undefined;

    if (!isNode || typeof Worker !== 'function') {
        return {
            workersAvailable: false,
            message:
                'This process does not provide node:worker_threads, so threadExecution "worker" cannot isolate a thread. Run with threadExecution "inline".'
        };
    }

    return { workersAvailable: true };
};
