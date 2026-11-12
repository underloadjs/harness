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
//   - ./lane-worker.ts      - the lane worker ENTRY the module runner imports (a Worker is
//                             spawned with ./worker-boot.mjs, never with this `.ts`); its path
//                             is resolved by ./lane-host.ts (`resolveEntry`, line 169)
//   - ./lane-worker-loop.ts - the worker side: rebuild, capability report, runtime
//                             interception, operation derivation, commit boundaries
//   - ./capability.ts       - what may run in worker mode at all, per harness and per tool,
//                             with the reason and the fix
//   - ./io-protocol.ts      - D4: the durability frames (checkpoint save, journal
//                             open/append/flush/rewrite/truncate/remove/close) and the three
//                             outcomes ('durable' / 'written' / 'superseded')
//   - ./io-client.ts        - D4: the coordinator side of durability - one FIFO queue per
//                             database root, the strict/queued split, and the handshake gate
//   - ./io-worker.ts        - D4: the IO worker ENTRY (published as the package subpath
//                             `@underload/harness/io-worker` -> `src/server/workers/io-worker.ts`
//                             in ../../../package.json). It is SOURCE, not a build product: a
//                             thread is spawned with ./worker-boot.mjs, that bootstrap starts
//                             Vite's `ModuleRunner`, and the runner imports this `.ts` entry
//                             through the one shared Vite server in ./worker-runner.ts. The
//                             coordinator resolves the path in ./io-client.ts
//                             (`resolveIoWorkerEntry`, line 317).
//   - ./io-worker-loop.ts   - D4: the thread body: the operation table, the held journal
//                             handles, and `startIoWorker` (called by the entry, because the
//                             manifest says `sideEffects: false`)
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
// reaches `src/server` at all: the root `browser` condition group of ../../../package.json maps
// the browser root to `src/browser.ts`, and ../../../scripts/check-package-types.ts
// (`yarn test:package`, part of `prepublishOnly`) walks the real source graph from
// `src/browser.ts` and fails if `src/index.ts` (the Node root) or `src/server/index.ts` (this
// barrel's parent) ever becomes reachable from it.
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
// D4 (R1/R2/R4): the IO subsystem's COORDINATOR surface - the frames and the client. The
// ENTRY modules (./io-worker.ts and ./io-worker-loop.ts) are deliberately NOT re-exported:
// a Worker is spawned with the FILE PATH (see `resolveIoWorkerEntry` below), never with an
// imported symbol, and pulling the loop into every barrel importer would put `node:worker_
// threads` and the fs-only writer loop behind unrelated imports. Same rule ./lane-worker.ts
// follows, with the one documented exception of `startLaneWorker` for tests.
export * from './io-protocol';
export * from './io-client';
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
    // T10 finding M5: the field-correct reader (moduleText, not source) that every scan must
    // share, and T10 finding S1: the handle reads a lane replica routes to the authority. The
    // session-level plan (../sessions.ts `memoryKeysFor`) has to use `toolScanTextOf` too -
    // until it does, its window is computed from an unscanned toolbox.
    LANE_ROUTED_HANDLE_READS,
    toolScanTextOf,
    SHARED_STATE_TOOL_NAMES,
    DELEGATION_TOOL_NAME,
    // T12 (S7): the nested-run refusal. Named in the barrel because BOTH sides of the promise
    // must quote one sentence: ../sessions.ts and ./lane-worker-loop.ts refuse the tools, the
    // capability report discloses them, and the tests assert the disclosure.
    NESTED_RUN_LIMITATION_CODE,
    NESTED_RUN_TOOL_NAMES,
    isNestedRunTool,
    nestedRunLimitationMessage,
    // T14: the SAME limitation on the doors a tool BODY holds. The core guard (src/harness.ts,
    // armed by ./lane-worker-loop.ts) raises `nestedRunUnsupportedError`; the scan below names
    // which doors a captured revision reaches, and the two wordings say honestly which of them
    // the runtime refuses versus what must be refused before the tool runs.
    NESTED_RUN_ARMED_DOORS,
    LANE_NESTED_RUN_DOORS,
    reachesNestedRunDoors,
    nestedRunDoorReason,
    nestedRunDoorWarning,
    nestedRunRefusalMessage,
    nestedRunUnsupportedError
} from './capability';
export type { AuthorityRuntimeMethod, LaneWorkerCapability, LocalRuntimeMethod, NestedRunDoor, ToolPlacement, ToolSurface, WorkerToolPlan } from './capability';
// The worker-side helpers, exported for tests (the entry itself is only ever spawned).
// `startLaneWorker` is the loop attach point; importing it has no side effects.
// `refuseNestedRuns` is the replica-shaping step (S7), exported so a test can prove the
// registry entries and the `runtime.delegate` route are both gone.
export { deriveOperations, installAuthorityRuntime, nestedRunHandshakeLimitations, refuseNestedRuns, startLaneWorker } from './lane-worker-loop';
export type { LaneWorkerState } from './lane-worker-loop';
