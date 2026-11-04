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
    'Only the coordinator holds the canonical document: harness.snapshot(), harness.restore(), persistence, the event journal and every SSE response stay on it, because they serialize state rather than compute it.',
    'harness.memory is shared as a bounded window of the keys a tool names. A function or symbol value, or a tool that walks the map dynamically (memory.data, memory.keys(), a computed key), is refused naming the key or tool; nothing is silently dropped or coerced.',
    'An agent default conversation has exactly one writer lane at a time; a second lane delegating to the same agent is given its own child conversation instead of writing behind the first lane.',
    'A tool registered from anywhere - a lane, the operator, a model - is applied at the coordinator first and broadcast to every live worker, so no replica keeps running a definition the authority replaced.',
    'A private fork/branch audit is lane-local by core design (branch state is deliberately absent from snapshot v1), so a fork records the summary it returns, while the branch listing of one lane is not a central roster entry. A tool body that touches a canonical-document member of the live handle (harness.snapshot/restore/reset/registerTool/createThread/sendThreadInput and friends) is refused at hello naming the tool, never run against a private copy.'
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
//     conversation). Its branch state is ephemeral by core design (deliberately absent
//     from snapshot v1, harness.ts ~3841), so it is lane-local work, and its branch audit
//     lives in that lane. The note below says exactly that, and the tool is refused only
//     if a harness would need it centrally.
//   - `toolCancel` - cancels a background call of THIS run, which lives in the lane.
//   - `delegate` - see DELEGATION_TOOL_NAME.
export const SHARED_STATE_TOOL_NAMES: readonly string[] = [
    'task',
    'profileManage',
    'chapterManage',
    'locationManage',
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
// these, e.g. src/tools/runtime/task.tool.ts:100). Interception happens on the REPLICA's
// handle, so no tool source changes and no shared write is ever performed locally.
export const AUTHORITY_RUNTIME_METHODS = {
    executeRecordTool: 'task | profileManage | chapterManage | locationManage',
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

// The runtime methods a lane runs LOCALLY. `delegate` is the nested run that isolation
// exists for; `search`/`fetch` are provider/network work with no session-state write.
// A new runtime method must be classified here or above before a worker accepts a run,
// and ./lane-authority.test.ts asserts the two sets cover every key the replica exposes.
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

// The delegation tool is shared-state ADJACENT: it runs another agent's conversation,
// which is a shared record. It stays lane-local (its loop is the CPU work) but only
// under a one-writer lease on that agent's default conversation (F5), taken through
// the `brain:claim` request.
export const DELEGATION_TOOL_NAME = 'delegate';

// Every one of the shared-state tools has a lane-side proxy, so none of them is
// `unsupported` by name alone. `delegate` needs the lease, not a proxy.
export const isSharedStateTool = (name: string): boolean => SHARED_STATE_TOOL_NAMES.includes(name);

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
