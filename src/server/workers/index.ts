// The lane-worker subsystem.
//
// WHAT LIVES HERE
// ---------------
// The machinery that lets ONE logical thread (a `ThreadLane` in ../sessions.ts) execute its
// whole turn - agent loop and CPU-bound tool bodies - on its own OS worker thread, while the
// SESSION's shared state stays owned by one coordinator.
//
//   - ./protocol.ts         - the frames, and the epoch / seq / callId / credit rules that
//                             make a late or abandoned reply harmless
//   - ./lane-identity.ts    - the authority's id ledger: every thread, invocation, result
//                             order, record id and created-tool budget is minted or leased
//                             here, because a replica minting its own ids collides and
//                             produces snapshots the core rejects
//   - ./lane-commit.ts      - shared state moves as OPERATIONS with receipts, never as state
//                             documents: authority-minted inserts, digest-checked updates
//                             (compare-and-set), prefix-checked transcript appends, one
//                             writer per shared conversation, atomic groups, and a journal
//                             that decides when a turn may be published
//   - ./lane-memory.ts      - `harness.memory` across lanes: faithful transfer, bounded
//                             declared windows, compare-and-set, and named refusals
//   - ./lane-authority.ts   - the COORDINATOR side: answers a lane's routed `runtime`
//                             operations on the canonical harness and commits its groups
//                             through the targeted harness seams (appendThreadMessages,
//                             setThreadStatus, archiveInvocation, reserveIdentity) - never a
//                             `restore()` per commit
//   - ./lane-host.ts        - the per-store worker manager: entry resolution, spawn, hello,
//                             event relay with acks, receipts, cancellation, crash handling,
//                             idle reclaim, shutdown
//   - ./lane-worker.ts      - the WORKER ENTRY (the file a Worker is spawned with); resolves
//                             built vs source layout
//   - ./lane-worker-loop.ts - the worker side: rebuild, capability report, runtime
//                             interception, operation derivation, commit boundaries
//   - ./capability.ts       - what may run in worker mode at all, per harness and per tool,
//                             with the reason and the fix
//   - ../config.ts          - the validated `threadExecution` runtime configuration (kept
//                             with the other server settings, not here)
//
// WHY THE FIRST DESIGN WAS REPLACED
// ---------------------------------
// The initial cut let each lane mutate a full harness replica and merged the record diff
// back with a last-writer-wins rule. An independent review (Temp/t3) reproduced, through the
// CORE's own validators, what that lost: a rejected `nextId`, one of two concurrent terminal
// results, a spent tool budget, a sibling's memory key deleted by the lane that never read
// it, and mutations silently dropped because the lane did not own them. The modules above
// therefore state the authority-first contract, and the session layer maps each operation
// onto ONE targeted harness call.
//
// NODE-ONLY: this barrel touches `node:worker_threads` and `node:fs`. The browser entry never
// reaches `src/server` at all (see ../../../vite.config.ts).
//
// Cross-references:
//   - ../sessions.ts   - where worker mode branches: executeTurn, executeTool, executeCommand
//   - ../runtime.ts    - where the runtime configuration is resolved and enforced
//   - ../../../Temp/t3 - the review probes that produced the reproductions
//   - ../../../Temp/t4/ARCHITECTURE.md - the design this wiring implements

export * from './protocol';
export * from './lane-identity';
export * from './lane-commit';
export * from './lane-memory';
export * from './lane-authority';
export * from './lane-host';
export {
    assertWorkerRuntimeReady,
    assessLaneWorkerCapability,
    assessWorkerToolSurface,
    isSharedStateTool,
    isAuthorityRuntimeMethod,
    laneWorkerEnvironment,
    laneWorkerUnsupportedMessage,
    planWorkerToolSurfaces,
    reachesCanonicalDocument,
    ROUTED_RUNTIME_METHODS,
    AUTHORITY_RUNTIME_METHODS,
    LOCAL_RUNTIME_METHODS,
    LANE_FORBIDDEN_HANDLE_CALLS,
    SHARED_STATE_TOOL_NAMES,
    DELEGATION_TOOL_NAME
} from './capability';
export type { AuthorityRuntimeMethod, LaneWorkerCapability, LocalRuntimeMethod, ToolPlacement, ToolSurface, WorkerToolPlan } from './capability';
// The worker-side helpers, exported for tests (the entry itself is only ever spawned).
// `startLaneWorker` is the loop attach point; importing it has no side effects.
export { deriveOperations, installAuthorityRuntime, startLaneWorker } from './lane-worker-loop';
export type { LaneWorkerState } from './lane-worker-loop';
