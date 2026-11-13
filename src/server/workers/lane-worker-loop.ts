// The lane worker: one persistent thread's execution, on its own OS thread.
//
// WHAT RUNS HERE
// --------------
// A replica of THIS session's harness, rebuilt from the durable preset record the
// coordinator ships in the `hello` blueprint. A turn is executed by calling that replica
// exactly the way ../sessions.ts calls the canonical one (`sendThreadInput` for a thread
// run, the callable handle for a root run), so the agent loop, the provider stream
// handling, and every synchronous tool BODY run on this thread - which is the CPU
// isolation `threadExecution: 'worker'` exists for (R1).
//
// WHAT DOES NOT RUN HERE
// ----------------------
// Session-shared state. `installAuthorityRuntime` replaces the shared operations on the
// replica's OWN `harness.runtime` object (src/harness.ts ~2415 - the same object the
// harness internals and the standalone core tool sources call), so:
//
//   - a record-store write, a registry change, a discovery grant, an agent-result read and
//     a cross-thread send become requests the AUTHORITY performs on the canonical harness;
//   - a slash command or a direct tool call executed here reaches the authority through the
//     same door (src/harness.ts ~2690 / ~2804 / ~3370 call `runtime.*`, not
//     `handle.runtime.*`), so an operator action performed on a lane still has one writer;
//   - `delegate`, `search` and `fetch` stay local (./capability.ts LOCAL_RUNTIME_METHODS):
//     their loop and IO are the work isolation protects, and their shared effects (a
//     subagent transcript, an archived result) are committed as operations, never merged.
//
// WHY THE COMMIT IS AN OPERATION LIST AND NOT A DIFF
// --------------------------------------------------
// Each boundary sends intents carrying the facts they depend on: the transcript appends at
// the length this lane last SAW, a memory write carries the digest it READ (compare-and-set),
// and a terminal invocation carries the identity this lane LEASED. A collision is therefore
// a refusal with the canonical value in the receipt - never a silent overwrite, and never a
// value here that the authority's own validators would have rejected (T3 findings F1-F8).
//
// WHY THE MESSAGE LOOP, NOT A TOP-LEVEL RUN
// -----------------------------------------
// A worker does not service `parentPort` messages while its module body is still evaluating
// (measured on Node 24), so this module finishes evaluating and drives every turn from the
// message loop. Anything awaited at module scope would block the very frames the
// coordinator is waiting for.
//
// Cross-references:
//   - ./protocol.ts        - the frames and the epoch / seq / callId / credit rules
//   - ./lane-authority.ts  - the coordinator side that answers and commits
//   - ./lane-host.ts       - spawn, hello, relay, reclaim, crash handling
//   - ./lane-worker.ts     - the entry that evaluates this module (and resolves source mode)

import { parentPort } from 'node:worker_threads';
import type {
    Agent,
    Harness,
    HarnessActionChoice,
    HarnessActionRequestContext,
    HarnessAgentResultSnapshot,
    HarnessEvent,
    HarnessIdentityReservation,
    HarnessMessage,
    HarnessPluginSettingsProvider,
    HarnessToolSettingsProvider,
    ToolContext
} from '../../types';
import type { HarnessPluginSettingsRecord } from '../persistence';
import type { HarnessPreset } from '../harnesses/types';
import { presetFromRecord } from '../harnesses';
import type { LaneAuthorityRequest } from './lane-authority';
import type { LaneBlueprint, LaneCommand, LaneRegistryChange, LaneReply, LaneRequestReplyValue, LaneToolStateSync } from './protocol';
import {
    LANE_EVENT_WINDOW,
    LANE_MAX_FRAME_BYTES,
    LANE_PROTOCOL_VERSION,
    createSequence,
    describeEnvelope,
    frameByteLength,
    isLaneEnvelope,
    isTransferableFrame
} from './protocol';
import {
    DELEGATION_TOOL_NAME,
    LOCAL_RUNTIME_METHODS,
    NESTED_RUN_ARMED_DOORS,
    NESTED_RUN_LIMITATION_CODE,
    NESTED_RUN_TOOL_NAMES,
    ROUTED_RUNTIME_METHODS,
    assessWorkerToolSurface,
    nestedRunLimitationMessage,
    nestedRunRefusalMessage,
    nestedRunUnsupportedError,
    planWorkerToolSurfaces,
    toolScanTextOf
} from './capability';
import type { SharedMutation, MutationReceipt } from './lane-commit';
import { archiveDigestOf, expectsDigestOf } from './lane-commit';
import type { IdSpace, IdentityLease } from './lane-identity';
import { syncMemoryMap } from './lane-memory';
import type { MemoryWindow } from './lane-memory';
import { reservationOf } from './lane-authority';

// The routed set is defined once, in ./capability.ts (AUTHORITY_RUNTIME_METHODS), and the
// guard in `installAuthorityRuntime` below is what makes an unclassified new method fail at
// hello instead of letting a lane mutate shared state that nobody routes.

const channel = parentPort;

// One frame out. A frame carrying a live reference (a closure, a signal) or a runaway
// payload fails HERE, as a named fault, instead of as a structured-clone TypeError inside
// `postMessage` or a message the coordinator silently never receives.
const send = (frame: LaneReply): void => {
    if (channel === null) return;

    if (!isTransferableFrame(frame)) {
        channel.postMessage({
            kind: 'fault',
            laneEpoch: frame.laneEpoch,
            message: `A ${frame.kind} frame is not transferable: ${describeEnvelope(frame)}`
        } satisfies LaneReply);

        return;
    }

    channel.postMessage(frame);
};

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

export type LaneWorkerState = {
    replica?: Harness;
    epoch: number;
    turnId?: string;
    // The conversation this lane writes: a host thread id, or `agent:<name>` for the legacy
    // root run (whose transcript IS that registry agent's messages).
    targetId?: string;
    controller?: AbortController;
    // Committed facts, adopted per receipt (T3 finding F7, T10 finding M2).
    //
    // `committedLength` is the CANONICAL PREFIX this replica holds: the invariant is
    // `replica.threadMessages(targetId)[0..committedLength] === canonical[0..committedLength]`
    // (T10 finding M4). The lane's own unpublished work therefore lives at
    // `slice(committedLength)`, and a delta a sibling wrote is inserted AT that index, which
    // is what keeps a re-derivation from duplicating or dropping messages.
    committedLength: number;
    // pipeline T4.1 — the CONTENT half of that same base. `committedLength` says how much of
    // canonical state this replica holds; `committedDigest` says what it HELD at the moment it
    // adopted it, which is the only way to notice that an already-committed entry was rewritten
    // IN PLACE (`setIncluded` storing/removing `included`, `edit` changing `content`). A flag
    // write moves no length, so a length-only base cannot see it — finding F6's exact bug.
    //
    // Always `digestMemoryValue(replica.threadMessages(targetId)[0..committedLength])`, recomputed
    // LOCALLY at the four points that move the base (hello, a first turn for a target, an adopted
    // receipt, a transcript sync). Recomputing rather than adopting the receipt's `effect.digest`
    // keeps one rule for every point — after an applied op the replica's prefix IS canonical's, so
    // the two answers are equal by construction, and a locally recomputed digest can never
    // disagree with the content the next derivation reads.
    committedDigest: string;
    readDigests: Record<string, string>;
    declaredKeys: string[];
    // Terminal invocations this lane has published, mapped to the CANONICAL digest the
    // authority reported for each.
    //
    // T10 finding M3: this used to be a Set of invocation ids. A host thread's invocation id
    // IS its thread id (and a default conversation's is `agent:<name>`) - the core reuses it
    // for every turn of that conversation - so after turn 1 the Set suppressed turn 2 forever
    // and the canonical archive kept the first answer for the life of the session. A digest
    // per id instead says "this lane has published THIS result", so the next one is sent, and
    // an unchanged one is still skipped.
    archived: Map<string, string>;
    nextSeq: () => number;
    nextCallId: () => number;
    nextStreamSeq: () => number;
    pending: Map<number, { resolve: (value: LaneRequestReplyValue) => void; reject: (error: Error) => void }>;
    pendingCommits: Map<number, (outcome: CommitOutcome) => void>;
    // T10 finding S4: one commit at a time. `mutation` groups are ordered by `seq` and the
    // journal refuses a group that arrives behind the watermark, so two overlapping commits
    // (an interrupt landing while the turn's final commit is still awaiting its receipt)
    // would settle out of order and strand the second receipt. Every commit - and every
    // transcript rebase, which is the request the retry depends on - runs through
    // `runExclusive`.
    commitChain: Promise<unknown>;
    // Event credit: the coordinator acks each stream sequence, so a stalled SSE consumer
    // paces this run exactly like the inline `await progress(event)` contract.
    ackedThrough: number;
    ackWaiters: (() => void)[];
    // Commits the coordinator refused. The terminal frame cannot report a clean success over
    // state nobody accepted (T3 finding F8).
    commitFaults: string[];
    // Identity high-water marks the authority shipped or leased.
    identities: Partial<Record<IdSpace, number>>;
    // The invocation this turn published (T10 finding M3's roster half). A store-dispatched
    // thread run gets a NEW numeric invocation id per turn (harness.ts `invocationIdOf` falls
    // back to `String(run.id)` when the run carries no thread agent), inline and on a lane
    // alike, so the roster's `invocationId` cannot be invented from the thread id - the host
    // mirrors the id the lane actually archived, or the UI joins a turn to a result that does
    // not exist.
    turnInvocationId?: string;
    // R5b: a `sync.tools` frame that arrived while this lane had NO replica yet. The window is
    // real but narrow: the coordinator posts the frame as soon as the route writes a toggle, and
    // `handle` is not awaited by the message listener, so a frame can be dispatched while
    // `sayHello` is still awaiting its imports and its `restore()`.
    //
    // It is STASHED rather than dropped, and applied as the LAST replica-shaping step of hello.
    // Ordering is safe in the only direction that matters: the frame was posted AFTER the host
    // read the blueprint's canonical snapshot, so its state is the newer one, and applying it on
    // top of the restore lands the replica where the coordinator stands. A silent drop here would
    // strand the toggle until the user clicked again, which is the report R5b is about.
    pendingToolSync?: LaneToolStateSync;
};

const state: LaneWorkerState = {
    epoch: 0,
    committedLength: 0,
    // T4.1 — '' means "no content adopted yet", which can never collide with a real digest (the
    // serializer's shape is 16 hex chars + ':' + a length), so a base that failed to be adopted
    // produces a NAMED `prefix-moved` refusal rather than a patch that silently matches.
    committedDigest: '',
    readDigests: {},
    declaredKeys: [],
    archived: new Map(),
    nextSeq: createSequence(),
    nextCallId: createSequence(),
    nextStreamSeq: createSequence(),
    pending: new Map(),
    pendingCommits: new Map(),
    commitChain: Promise.resolve(),
    ackedThrough: 0,
    ackWaiters: [],
    commitFaults: [],
    identities: {}
};

// ---------------------------------------------------------------------------
// Requests: raise one, await the authority's answer
// ---------------------------------------------------------------------------

// A request in flight, with the handle the caller may use to cancel it (an owner question is
// cancelled by the run that asked it, not by the client).
type PendingCall = {
    callId: number;
    promise: Promise<LaneRequestReplyValue>;
    reject: (reason: string) => void;
};

const raiseRequest = (request: LaneAuthorityRequest): PendingCall => {
    const callId = state.nextCallId();

    let rejectDirect: (reason: string) => void = () => undefined;

    const promise = new Promise<LaneRequestReplyValue>((resolve, reject) => {
        rejectDirect = (reason: string) => {
            state.pending.delete(callId);
            reject(new Error(reason));
        };

        state.pending.set(callId, { resolve, reject });
    });

    send({ kind: 'request', laneEpoch: state.epoch, callId, request });

    return { callId, promise, reject: (reason: string) => rejectDirect(reason) };
};

const raise = (request: LaneAuthorityRequest): Promise<LaneRequestReplyValue> => raiseRequest(request).promise;

// Reject every unanswered request of this epoch: an interrupt or a lost channel must not
// leave a tool body hanging on a reply that will never matter (T3 finding F9).
const rejectPendingRequests = (reason: string): void => {
    for (const [callId, waiter] of [...state.pending.entries()]) {
        state.pending.delete(callId);
        waiter.reject(new Error(reason));
    }
};

// ---------------------------------------------------------------------------
// Shared-state interception on the replica's runtime object
// ---------------------------------------------------------------------------

// The caller identity a shared operation carries, as DATA (a name, never a live Agent). The
// authority resolves it against its own registry, so a sender cannot be spoofed - the same
// rule the inline path follows in src/tools/runtime/threadSend.tool.ts:65.
const identityOf = (source: unknown, extra?: { threadId?: string }): { agent?: string; threadId?: string; runDepth?: number } => {
    if (source === undefined || source === null) {
        return extra?.threadId === undefined ? {} : { threadId: extra.threadId };
    }

    const asContext = source as ToolContext;
    const brain = (asContext.agent ?? source) as Agent;
    const name = typeof brain?.name === 'string' ? brain.name : undefined;
    const threadId = extra?.threadId ?? asContext.threadId;

    return {
        ...(name === undefined ? {} : { agent: name }),
        ...(threadId === undefined ? {} : { threadId }),
        ...(asContext.runDepth === undefined ? {} : { runDepth: asContext.runDepth })
    };
};

/**
 * Replace the shared operations on the replica's own `runtime` object.
 *
 * Mutating the OBJECT (not the `harness.runtime` property) is deliberate: the harness
 * internals captured the same reference, so a slash command or an internal call is routed
 * too. Every routed method returns a promise here; each core caller RETURNS its runtime
 * result from an async `execute` (src/tools/runtime/*.tool.ts), which is what makes an
 * async route behave identically to the local synchronous one.
 */
// The replica's OWN implementations of the two methods used for mirror writes, captured in
// `installAuthorityRuntime` before the routed replacements are installed.
type LocalToolRuntime = {
    requestTools: (caller: unknown, parameters: unknown) => unknown;
    manageTool: (caller: unknown, parameters: unknown) => unknown;
};

let localRuntime: LocalToolRuntime = {
    // Until a replica exists, a mirror write is a no-op rather than a crash: the only callers
    // are frame handlers that cannot run before hello built the replica.
    requestTools: () => undefined,
    manageTool: () => undefined
};

// The replica's OWN thread reads, captured for the same reason (T10 finding S1): the handle
// members are replaced with routed canonical reads, so everything inside this loop - the op
// derivation, the fresh-block reset, and the transcript rebase - must go through the local
// closures or it would receive a promise where it needs an array.
type LocalThreadReads = {
    messages: (threadId: string) => HarnessMessage[];
    record: (threadId: string) => unknown;
};

let localThreads: LocalThreadReads = {
    messages: () => [],
    record: () => undefined
};

// T11 (RR4 loop) + T14 gap (d): the payload a lane raises for a routed `toolRequest`, extracted
// to module scope and EXPORTED so the mapping is pinnable without a spawned thread. The 3rd
// runtime argument (the toolRequest call's own id) is deliberately DROPPED — the canonical
// pending board has no lane calls, and forwarding a lane id could mask a real canonical pending
// task in the `toolCancel` report — while the 4th (`ToolContext.toolScope`, absent when the run
// is unrestricted) is forwarded, because that is what makes the authority answer a scoped lane
// with the honest `forbidden` shape instead of enabling a tool the lane's run cannot launch.
// Dropping `scope` here is silent everywhere else: the authority simply answers the historical
// unrestricted shape, and only this mapping (and the test over it) notices.
export const requestToolsRoutePayload = (
    caller: unknown,
    parameters: unknown,
    _selfCallId: unknown,
    scope?: unknown
): Record<string, unknown> => ({
    parameters,
    ...(scope === undefined ? {} : { scope }),
    identity: identityOf(caller)
});

// THE ROUTED CONVERSATION READ, as a pinnable payload builder (2026-11-13, independent review).
// Exported for exactly the reason `requestToolsRoutePayload` above is: the CALLER identity is the
// only thing that makes the authority's thread-family gate agree with what the same read refuses
// inline, and the two handle members in `installAuthorityRuntime` used to send `identity: {}`, so
// a lane-worker's `threadRead` of a foreign-family thread returned the whole transcript where the
// same call inline answers "not visible". A test over THIS function fails the moment the caller
// id is dropped again; before this, no suite could see the drop.
//
// `identityOf(undefined, …)` is the same carrier `threadList` and `threadDelete` use: the caller is
// a thread id, never a model argument, and the lane has no live `ToolContext` at this point (the
// seam is a handle member, not a runtime method), so only `threadId` is knowable and only
// `threadId` is what the gate on the other side reads (`familyOfCaller`).
//
// The NEW `threadRead` page parameters (`includeSystem` / `toolArgs` / `regexFields`, plus every
// other filter) deliberately do NOT ride on this request: the routed read answers the page's two
// INPUTS (the record and the canonical transcript), and the page build itself —
// `readThreadTranscript(record, messages, parameters)` in src/tools/runtime/threadRead.tool.ts —
// still runs inside the LANE's own tool body. So the filters, the paging and the 32 KiB budget are
// applied to canonical data on the lane, which is the CPU split ./lane-authority.ts documents
// ("the paging, regex filtering and byte budgeting stay on the lane").
export const threadReadRoutePayload = (
    threadId: string,
    callerThreadId?: string
): { threadId: string; identity: { agent?: string; threadId?: string; runDepth?: number } } => ({
    threadId,
    identity: identityOf(undefined, { threadId: callerThreadId })
});

export const installAuthorityRuntime = (replica: Harness): void => {
    const runtime = replica.runtime as unknown as Record<string, unknown>;

    // The two methods a MIRROR write needs. `applySync` and `applyRegistryChange` replay an
    // authority decision into THIS replica, so they must call the replica's own
    // implementation - calling the routed one would ask the authority to change itself again.
    // Captured EAGERLY: reading `replica.runtime.x` at call time would read the replaced
    // (routed) method and recurse.
    const original = {
        requestTools: replica.runtime.requestTools,
        manageTool: replica.runtime.manageTool
    };

    localRuntime = {
        requestTools: (caller: unknown, parameters: unknown) => original.requestTools(caller as never, parameters),
        manageTool: (caller: unknown, parameters: unknown) => original.manageTool(caller as never, parameters)
    };

    const route = (method: string, build: (...args: unknown[]) => Record<string, unknown>): void => {
        runtime[method] = (...args: unknown[]): Promise<unknown> =>
            raise({ op: 'runtime', method, ...build(...args) } as LaneAuthorityRequest).then((reply) => {
                applySync(reply.sync);

                return reply.value;
            });
    };

    // `executeRecords(name, context)` (records-engine Decision A): the record engine's
    // routed door. `name` is the CALLING TOOL — `records` or one of the four wrappers — and
    // only the DATA part of the context crosses, because the authority fabricates the
    // ToolContext against the canonical harness (./lane-authority.ts) and resolves the
    // caller from the name the lane reported. This is the registration the classification
    // loop below depends on: delete it and a lane write stops being routable, which must
    // throw at startup rather than land on a private copy.
    route('executeRecords', (name, context) => ({
        name,
        parameters: (context as ToolContext | undefined)?.parameters,
        identity: identityOf(context)
    }));

    route('manageTool', (caller, parameters) => ({ parameters, identity: identityOf(caller) }));
    route('createToolForAgent', (caller, creation) => ({ creation, identity: identityOf(caller) }));
    // T11 (RR4 loop): the 3rd runtime argument (the toolRequest call's id) is
    // deliberately NOT forwarded — the canonical pending board has no lane calls, and
    // forwarding a lane id could mask a real canonical pending task in the
    // `toolCancel` report. The 4th (ToolContext.toolScope, absent when unrestricted)
    // IS forwarded so the authority answers a scoped lane with the honest `forbidden`
    // shape rather than enabling a tool the lane's run cannot launch (finding S-parity:
    // the R1 denial must exist on the lane exactly as inline).
    // T14 gap (d): the `requestTools` payload builder lives at module scope and is EXPORTED
    // (`requestToolsRoutePayload`, above the install helper) so a test can pin the exact
    // request body a lane raises — the one place the calling run's `toolScope` could be
    // dropped on its way to the authority without any suite noticing. The registration below
    // uses that function, so the pin cannot drift from the route.
    route('requestTools', requestToolsRoutePayload);
    route('threadSend', (caller, threadId, parameters) => ({
        threadId: threadId as string | undefined,
        parameters,
        identity: identityOf(caller, { threadId: threadId as string | undefined })
    }));
    route('threadList', (threadId) => ({ identity: identityOf(undefined, { threadId: threadId as string | undefined }) }));
    // B5 (2026-11-13): `threadDelete(callerThreadId, threadId)`. The TARGET travels as the
    // request's `threadId` (the thing to remove) and the CALLER travels inside `identity`,
    // exactly like `threadList` carries its reader — the authority scopes the delete to that
    // caller's own descendants, so a lane cannot release a sibling subtree through a replica
    // copy. The receipt (`deleted`, `removedThreadIds`) comes back from the canonical harness.
    //
    // CORRECTED 2026-11-13 (independent review): the sentence this comment used to close with
    // credited `applySync` with "rebasing this lane's mirror of every conversation the cascade
    // removed". It does not rebase anything: `applySync` (below this function) replays the
    // authority's TOOL-side decisions only — the enabled set, registry revisions, declared
    // memory keys and identity watermarks. Transcript mirrors move through `transcript:sync` /
    // `adoptCommittedBase`, and a cascade target is never the lane's own conversation (that one
    // read stays local), so a later read of a released id is ROUTED and answers the canonical
    // harness's own "no record in this session" error instead of a stale local copy.
    route('threadDelete', (callerThreadId, threadId) => ({
        threadId: threadId as string,
        identity: identityOf(undefined, { threadId: callerThreadId as string | undefined })
    }));
    route('agentResult', (parameters) => ({ parameters, identity: identityOf(undefined) }));
    route('agentManage', () => ({ identity: identityOf(undefined) }));
    route('listTools', () => ({ identity: identityOf(undefined) }));

    // T10 finding S1: the two handle READS of session-shared conversation state.
    //
    // A replica is a hello snapshot plus what this lane itself has run, so a direct
    // `harness.threadMessages(id)` / `harness.thread(id)` is a PRIVATE answer: stale for any
    // conversation a sibling moved, and simply missing for a thread another lane created.
    // `threadRead` is the model-facing feature that reads exactly those conversations, so the
    // replica's own handle members are replaced with routed reads answered by the canonical
    // harness, and the tool entry awaits them.
    //
    // The lane's OWN conversation stays local: this replica is the only place its uncommitted
    // tail exists, so routing that read backwards would hide the run's own work.
    //
    // R2-F14 (2026-11-13, independent review): the SECOND argument of both members is the
    // CALLER's thread id, which `src/tools/runtime/threadRead.tool.ts` passes from `context.threadId`.
    // It used to be dropped on the way to the authority (`identity: {}`), and the authority then read
    // the canonical harness UNSCOPED — so a lane-worker model caller could read a foreign-family
    // transcript in full where the same call inline is refused "not visible" (harness.ts
    // `isAddressVisible`). Both routed reads now carry the caller in `identity.threadId`, the same
    // carrier `threadList`/`threadDelete` use, and ./lane-authority.ts hands it to both seams as
    // `callerThreadId`, so the lane and the inline path give the same answer for the same address.
    // The lane's own conversation stays local AND unscoped: reading the conversation you are
    // standing in is never a lineage question.
    const handle = replica as unknown as {
        threadMessages: (threadId: string, callerThreadId?: string) => unknown;
        thread: (threadId: string, callerThreadId?: string) => unknown;
    };
    const localMessages = replica.threadMessages.bind(replica);
    const localRecord = replica.thread.bind(replica);

    // Captured BEFORE the routed replacements: ./lane-worker-loop.ts's own derivation, reset
    // handling and transcript rebase all need the synchronous local answer, and reading the
    // member back at call time would get a promise.
    localThreads = { messages: localMessages, record: localRecord };

    handle.threadMessages = (threadId: string, callerThreadId?: string): unknown =>
        threadId === state.targetId ? localMessages(threadId) : raise({ op: 'thread:read', ...threadReadRoutePayload(threadId, callerThreadId) } as LaneAuthorityRequest).then((reply) => (reply.value as { messages: unknown[] }).messages);
    handle.thread = (threadId: string, callerThreadId?: string): unknown =>
        threadId === state.targetId ? localRecord(threadId) : raise({ op: 'thread:read', ...threadReadRoutePayload(threadId, callerThreadId) } as LaneAuthorityRequest).then((reply) => (reply.value as { record: unknown }).record);

    // Asserted, not assumed: a NEW runtime method must be classified as routed or local or local
    // before a lane may run it, and this is where that rule bites at hello time.
    for (const key of Object.keys(runtime)) {
        if ((LOCAL_RUNTIME_METHODS as readonly string[]).includes(key)) continue;
        if ((ROUTED_RUNTIME_METHODS as readonly string[]).includes(key)) continue;

        throw new Error(
            `harness.runtime.${key} is neither routed to the authority nor declared local, so this build cannot guarantee that shared state has one writer.`
        );
    }
};

// T12 (S7) + T14: close EVERY nested-run path on this replica before any turn can start a child
// conversation inside it, and report the names actually removed so the hello frame carries the
// limitation (a replica whose preset registered no subagents has no `delegate` to remove).
//
// Three levers, because three kinds of door can start a child (./capability.ts
// NESTED_RUN_TOOL_NAMES + LANE_NESTED_RUN_DOORS explain why a refusal, not a private copy, is the
// honest answer):
//   1. the registry entries - the same mechanism a mirrored registry REMOVAL already uses in
//      `applyRegistryChange` below: `tools` is the registry map the handle exposes, and the run
//      resolves a call AND builds its model-facing declarations from it (src/harness.ts:1105
//      and :2242 read `Object.values(tools)`), so dropping the entry takes the tool out of
//      both. This is the only lane-side lever for `threadFork`, whose dispatch is a core
//      CONTROL path keyed on a definition marker the replica handle does not expose
//      (src/harness.ts:2111-2120).
//   2. `harness.runtime.delegate` - the direct runtime route the tool entry itself calls
//      (src/tools/runtime/delegate.tool.ts:120), plus any built-in delegation path. Replaced,
//      NOT deleted: the loop above classifies every key the replica exposes, and `delegate`
//      stays declared local (./capability.ts LOCAL_RUNTIME_METHODS) because nothing crosses
//      for it - it refuses.
//   3. THE CORE RUNTIME GUARD, armed by `replica.nestedRuns('refuse')` on EVERY lane, whatever
//      preset this worker rebuilt: the arm is a property of the execution mode, not a preset option,
//      and the read-back below makes an unarmable build a HELLO FAULT (the coordinator settles the
//      turn with the named error) rather than a quiet inline fallback. Levers 1-2 close the doors
//      that go THROUGH a tool or a runtime route; they do not close the doors a tool BODY holds,
//      which is the `context.run` / `context.harness` / `context.agents` surface the core builds per
//      invocation. T13 measured exactly that bypass: the shipped `textSummarize` reached a nested
//      child through `ctx.run`, the child answered, and its transcript died in the lane. Arming the
//      policy makes the core throw the named limitation instead — before the child, its transcript
//      or its provider request exist — for every spelling of the same closure (a direct
//      `context.run(...)`, `ctx.run(...)`, `const { run } = context`, or an alias), including a tool
//      created or replaced after hello. T15: on a refusing replica those surfaces are the GUARDED
//      views the core builds (`toolHandleView`, `toolAgentsView`, the guarded `run` closure), so a
//      reference the body keeps and calls after its own call settled is refused as well; the armed
//      doors are `context.run(name, input)`, `harness(...)`,
//      `harness.sendThreadInput(...)` and `harness.agents.<name>.turn() / .stream()`, and every one
//      of them is stated in the hello report (./capability.ts `NESTED_RUN_ARMED_DOORS`).
export const refuseNestedRuns = (replica: Harness): string[] => {
    // T14 lever 3, FIRST: arm the CORE nested-run policy on this replica, so every door the core
    // can see (a tool-context `run`, a run nested inside another run, a `harness(...)` call made
    // from a tool body, a sibling brain run through `context.agents`) throws the named
    // `nested-run-unsupported` limitation before a child exists. The accessor is validated, so an
    // unsupported value throws here rather than arming nothing; and the read-back below is what
    // proves the seam is really present in THIS build — an unarmed replica would keep running
    // children against a private copy of the session, which is the exact defect this closes.
    replica.nestedRuns('refuse');

    if (replica.nestedRuns() !== 'refuse') {
        throw new Error(
            'This harness build exposes no nested-run seam (harness.nestedRuns), so a lane replica cannot refuse the nested runs a tool body starts. The worker entry and the server must come from the same checkout, or run the session with threadExecution "inline".'
        );
    }

    const tools = replica.tools as Record<string, unknown>;
    const runtime = replica.runtime as unknown as Record<string, unknown>;
    const removed: string[] = [];

    for (const name of NESTED_RUN_TOOL_NAMES) {
        if (tools[name] === undefined) continue;

        delete tools[name];
        removed.push(name);
    }

    // A rejected tool handler is turned into a readable tool result by the runtime, so a model
    // (or an internal path) that still reaches delegation gets the named sentence rather than a
    // crash it cannot act on.
    runtime.delegate = (): never => {
        throw nestedRunUnsupportedError(`Tool "${DELEGATION_TOOL_NAME}"`);
    };

    return removed;
};

// T14: the doors `refuseNestedRuns` ARMED on this replica are listed in ./capability.ts
// (`NESTED_RUN_ARMED_DOORS`) and named in the hello report below, so the handshake states what
// this lane refuses even when the preset registered no `delegate` to remove.

// Adopt the canonical follow-up state the authority sent with an answer.
const applySync = (sync: LaneRequestReplyValue['sync']): void => {
    if (sync === undefined) return;

    const replica = state.replica;

    // A discovery grant or a registry change moves the set of tools the MODEL is shown on the
    // next request, so the replica re-applies the canonical decision locally. That is
    // replaying an authority decision, not merging a replica's guess.
    if (sync.enabled !== undefined && replica !== undefined) {
        const installed = replica.tools as Record<string, unknown>;
        const granted = sync.enabled.filter((name) => installed[name] !== undefined);

        // R5b: the SWITCH half of the replay. Canonical's `enabled` list can never contain a
        // withheld name - `applyToolSwitch(false)` removes the cap slot in the SAME breath it
        // withholds (src/harness.ts:1957) and `restore` re-applies the same rule
        // (src/harness.ts:11914) - so a name the authority reports as enabled is, canonically, a
        // name its user has switched ON. A replica can still hold a stale local flag for it, in
        // exactly one way: step 4 of `applyToolStateSync` below, the only seam that frees a cap
        // slot also sets the flag. CLEARING THE FLAG HERE IS NOT OPTIONAL, and the failure mode
        // is silent: `requestToolsFor` filters withheld names out of its OWN catalogue
        // (src/harness.ts:3439), so the grant under this line would match nothing, report
        // `matched: 0`, and the lane would keep omitting a tool the canonical harness had just
        // enabled - until the next reconcile frame arrived.
        //
        // `enable` on a name that is neither withheld nor already capped re-takes a slot
        // newest-first, which is the same insertion a canonical grant performs, so the cap stays
        // capped and no arithmetic changes.
        for (const name of granted) {
            if (replica.withheldTools.includes(name)) {
                localRuntime.manageTool(undefined, { operation: 'enable', name });
            }
        }

        if (granted.length > 0) {
            // LOCAL replay: `requestTools` is the core's only enabled-set writer and is
            // idempotent for names already enabled.
            //
            // T11 consistency: a FORBIDDEN lane toolRequest grants nothing canonically,
            // so it produces no replay at all — the denial cannot leak into this or any
            // sibling replica. And a name granted to an UNRESTRICTED lane that a later
            // SCOPED run cannot use is still filtered at the declaration boundary by
            // `declared(run.agent, run.toolScope)` (src/harness.ts), so replaying the
            // canonical set unrestricted here never makes a scoped run see more.
            localRuntime.requestTools(undefined, { names: granted });
        }
    }

    for (const change of sync.registry ?? []) void applyRegistryChange(change);

    // T10 finding M5: the authority may have widened the SESSION window for this very reply
    // (a tool revision naming new literal keys was just installed). Join them and pull the
    // digests, or the tool's first memory write has no base to commit against.
    if (sync.memoryKeys !== undefined) void declareMemoryKeys(sync.memoryKeys);

    if (sync.identities !== undefined) {
        for (const [space, value] of Object.entries(sync.identities)) {
            if (typeof value === 'number') state.identities[space as IdSpace] = Math.max(state.identities[space as IdSpace] ?? 0, value);
        }

        reserve(state.identities);
    }
};

// Raise this replica's minting counters to the leased high-water marks.
const reserve = (identities: Partial<Record<IdSpace, number>>): HarnessIdentityReservation | undefined =>
    state.replica?.reserveIdentity(reservationOf(identities));

// ---------------------------------------------------------------------------
// R5b — THE WHOLESALE TOOL-STATE RECONCILE (the `sync.tools` applier)
// ---------------------------------------------------------------------------

// What one reconcile actually did, as data. Exported so a test can assert the EXACT outcome of
// a frame - including what it dropped and why - without reaching into harness internals, and so
// the warm-lane tests can state the difference between "installed" and "silently ignored".
export type LaneToolStateReconcile = {
    // WHAT THE FRAME ASKED FOR, pruned to what this replica could honour - NOT a read of the two
    // sets this replica ends up holding. The two genuinely differ, in both directions, and `dropped`
    // does not cover either difference:
    //   - `enabled` can name a slot this replica never took: step 3's `requestTools` insert is
    //     capped, so when the cap binds the kernel evicts one of the names this list carries, and
    //     the pruner says nothing because it only judges what the FRAME could mean, not what the
    //     CAP could hold (./lane-tool-reconcile.test.ts, the capped fixture);
    //   - `withheld` can leave out a name this replica IS flagged for: step 4 flags every capped
    //     name it withdraws (the residue below), and a name canonical merely evicted never appears
    //     in the frame's `withheld` at all - so the return has said `['probeCore']` while the
    //     replica held `['probeCore', 'probeOther']`.
    // The replica's real state is the harness's own `discoveredTools` / `withheldTools`, which is
    // what every case here asserts alongside this report.
    enabled: string[];
    withheld: string[];
    // Names the frame carried that THIS replica could not install, each with its reason. A
    // reconcile never throws on one of these: a lane replica is rebuilt from a RECORD, so a name
    // the coordinator holds may genuinely not exist here (the `testFlaky` case in
    // ./lane-tool-settings.test.ts, and every nested-run tool `refuseNestedRuns` deletes).
    dropped: { name: string; list: 'enabled' | 'withheld'; reason: 'not-registered' | 'not-switchable' }[];
};

/**
 * Set the replica's copy of the session's tool switches to the canonical state - WHOLESALE.
 *
 * WHY IT IS A RECONCILE AND NOT A PATCH
 * -------------------------------------
 * The frame is one-way (no id, no receipt, no ordering guarantee beyond the port), the switch is
 * per-SESSION while lanes are per-conversation and appear and disappear, and a lane may have
 * been rebuilt from a fresh snapshot between two frames. Setting both lists from the payload
 * makes every frame independently sufficient: a duplicate lands the same SWITCH state (the cap
 * arithmetic step 3 performs can still move which name holds a slot - see THE RESIDUE below), a
 * late one lands the newer state, and a lost one is covered by the next click. A delta would need
 * all three to be true at once.
 *
 * WHY IT USES THE KERNEL SEAMS INSTEAD OF A NEW ONE
 * -------------------------------------------------
 * The replica's two sets are closure state inside src/harness.ts (`activeTools`,
 * `withheldTools`); the ONLY writable doors the kernel offers are `runtime.manageTool
 * enable|disable` (one name, both sets, `applyToolSwitch`) and `runtime.requestTools
 * {names}` (the capped set, additive). `restore()` would be the true wholesale primitive but it
 * rebuilds tools and thread agents and zeroes the run generation (./protocol.ts:110-113) - on a
 * WARM lane that is exactly the "abort the running thread" outcome R5b forbids. So this function
 * composes the seams, in the order that makes each step's side effect the next step's input, and
 * documents the one residue that composition leaves (step 4).
 *
 * THE FOUR STEPS
 * --------------
 *  1. WITHHOLD what the frame withholds. `disable` records the flag for EVERY registered name
 *     (a core or pending-only name's switch lives only there) and frees the cap slot when the
 *     name holds one. Idempotent, so a repeat frame costs nothing.
 *  2. UN-WITHHOLD what the replica withheld and the frame does not. `enable` clears the flag and,
 *     for a searchable name, re-takes a slot newest-first.
 *  3. ENABLE the canonical capped names this replica lacks (a rebuild may have pruned one, or a
 *     grant may have arrived on a frame the replica has not seen yet).
 *  4. WITHDRAW the capped names the replica holds and the frame does not - the direction the
 *     protocol has NEVER had before, and what makes a disable reach a warm lane.
 *
 * THE RESIDUE, stated rather than hidden (step 4): the only seam that frees a cap slot is
 * `disable`, which also sets the switch flag, so a name canonical merely EVICTED (cap pressure,
 * not a user action) ends up flagged on the replica as well as off its list - and the returned
 * `withheld` does not name it, because that field is the frame's pruned ask, not this replica's
 * set. That is the redundant-but-safe direction: a flagged-and-uncapped name is undeclared and
 * refused at the gate, which is exactly canonical's behaviour for it. THE FLAG IS NOT
 * SELF-CLEARING: a repeated identical frame re-creates it - step 2 clears it, step 4 puts it
 * straight back - so a steady frame holds the residue as a FIXED POINT rather than dissolving it.
 * Only a frame whose `enabled` list carries the name again, or a grant for it replayed in
 * `applySync` above, takes the name out of the flag set for good.
 *
 * AND WHEN THE CAP BINDS, the residue costs a slot. Step 2's re-enable re-takes a cap slot
 * newest-first before step 4 gives it back, so on a full toolbox one of the names the frame lists
 * can end up MISSING from this replica's catalogue, and which one survives can move between two
 * identical frames. The invariant that does hold is the one that matters: a reconcile never makes
 * this lane MORE permissive than canonical - every name it declares is a name canonical declares -
 * while it may legitimately declare fewer. Both halves, plus the fixed point, are pinned against a
 * capped harness in ./lane-tool-reconcile.test.ts.
 *
 * `target` defaults to the live lane's replica and its captured LOCAL runtime; a test passes a
 * plain harness and its own runtime so the reconcile can be pinned without spawning a thread
 * (calling the routed runtime here would ask the authority to change itself instead).
 */
export const applyToolStateSync = (
    sync: LaneToolStateSync,
    target?: { replica: Harness; runtime: LocalToolRuntime }
): LaneToolStateReconcile | undefined => {
    const replica = target?.replica ?? state.replica;

    // No replica yet. The frame handler stashes it for the end of hello, so this is a "not now",
    // never a "no": returning undefined is how the caller tells the two apart.
    if (replica === undefined) return undefined;

    const runtime = target?.runtime ?? localRuntime;
    const installed = replica.tools as Record<string, unknown>;
    const dropped: LaneToolStateReconcile['dropped'] = [];

    // TOLERANCE FIRST. A name the replica does not register is dropped, and a name it registers
    // but cannot hold in a CAP slot is dropped from the enabled list only - both are the same
    // decision the hello prune already makes two functions below, restated here so a toggle for
    // a tool this build does not have is a no-op instead of a `toolManage ... is not registered`
    // throw that would fault the frame and, with it, the lane's live turn.
    const prune = (names: readonly string[], list: 'enabled' | 'withheld'): string[] => {
        const unique: string[] = [];
        const seen = new Set<string>();

        for (const name of names) {
            // A non-string or blank member is wire junk, not a name. It is SKIPPED rather than
            // reported: the routed door this applier calls refuses a blank name outright
            // (`toolManage ${operation} requires \`name\`.`, src/harness.ts `manageTool` case
            // 'enable' / 'disable'), and there is no name to name in the result. A WHITESPACE-only
            // name is NOT skipped: that same test is `values.name.length === 0`, so a name-shaped
            // string gets through and is refused as unregistered — which is why `'   '` is dropped
            // and REPORTED two blocks below.
            if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;

            seen.add(name);

            if (installed[name] === undefined) {
                dropped.push({ name, list, reason: 'not-registered' });
                continue;
            }

            // `enabled` is the CAPPED SEARCHABLE set (`discoveredTools`), so a name the kernel
            // says holds no slot cannot be installed into it here either - the same
            // `isToolSwitchable` rule as the hello prune. `withheld` has no such bound: it is
            // precisely where a core or pending-only name's switch lives.
            if (list === 'enabled' && !replica.isToolSwitchable(name)) {
                dropped.push({ name, list, reason: 'not-switchable' });
                continue;
            }

            unique.push(name);
        }

        return unique;
    };

    const targetEnabled = prune(Array.isArray(sync?.enabled) ? sync.enabled : [], 'enabled');
    const targetWithheld = prune(Array.isArray(sync?.withheld) ? sync.withheld : [], 'withheld');
    const wantWithheld = new Set(targetWithheld);
    const wantEnabled = new Set(targetEnabled);

    // Step 1: install the switches the user made. Read BEFORE step 2 mutates anything, so the set
    // membership the loops compare against is one consistent snapshot of this replica.
    for (const name of targetWithheld) {
        if (!replica.withheldTools.includes(name)) {
            runtime.manageTool(undefined, { operation: 'disable', name });
        }
    }

    // Step 2: clear the switches the user undid. A name whose registration left the harness
    // mid-flight is gone from `withheldTools` already (src/harness.ts:3071), so every member of
    // this read is still resolvable; the guard against a throw is the same registry check the
    // prune above uses.
    const heldWithheld = new Set(replica.withheldTools);

    for (const name of heldWithheld) {
        if (!wantWithheld.has(name) && installed[name] !== undefined) {
            runtime.manageTool(undefined, { operation: 'enable', name });
        }
    }

    // Step 3: take the capped slots canonical holds and this replica does not. AFTER step 2, on
    // purpose - `requestToolsFor` selects out of a catalogue that excludes withheld names, so
    // enabling before clearing a stale flag would match nothing and the name would stay undeclared.
    const heldEnabled = new Set(replica.discoveredTools);
    const missing = targetEnabled.filter((name) => !heldEnabled.has(name));

    if (missing.length > 0) {
        runtime.requestTools(undefined, { names: missing });
    }

    // Step 4: free the capped slots this replica holds and canonical does not, and that are not
    // already accounted for by step 1 (a name the frame withholds left the list in step 1).
    //
    // `disable` is the ONLY seam that frees a slot, and it sets the switch flag on the way out, so
    // every name withdrawn here leaves FLAGGED (see THE RESIDUE in the block comment above): the
    // replica withholds a name canonical may merely have evicted. The direction is safe — a
    // flagged name is undeclared and gate-refused, exactly as canonical treats it — and the flag is
    // a fixed point across identical frames, not something the next frame clears.
    const stillEnabled = new Set(replica.discoveredTools);
    const stale = [...stillEnabled].filter((name) => !wantEnabled.has(name) && !wantWithheld.has(name));

    for (const name of stale) {
        runtime.manageTool(undefined, { operation: 'disable', name });
    }

    return { enabled: targetEnabled, withheld: targetWithheld, dropped };
};

// Install a registry change the authority already applied, so this replica runs the same
// revision the canonical harness runs (T3 finding F9: no stale definition behind a replace).
//
// T10 finding M5: the revision is installed in the FORM the canonical harness compiled. The
// shipped format is a MODULE (`format: 'module'`, text in `moduleText`); pushing that text
// through `source` fed module code to the legacy function-body path, and left `source` empty
// for every core-installed tool. Whichever one is present wins, and the captured helper
// modules travel with it.
const applyRegistryChange = (change: LaneRegistryChange): Promise<void> => {
    const replica = state.replica;

    if (replica === undefined) return Promise.resolve();

    if (change.removed) {
        // The core has no "unregister" operation on the handle (toolManage offers
        // list/details/source/path/create/update/reload), so a removal is mirrored by
        // dropping the entry from the replica's own registry map - the same object the
        // handle exposes, so the next call cannot resolve it.
        delete (replica.tools as Record<string, unknown>)[change.name];

        return Promise.resolve();
    }

    // T10 finding S2: scan a source that arrives from ELSEWHERE (an operator toolManage,
    // another lane's create) before installing it, with the same lens the hello report uses.
    // The common path - a model creating a tool from this very lane - is already refused
    // authority-side before install, so a hit here means a revision entered the session
    // through another door and this lane genuinely cannot run it.
    const installedText = toolScanTextOf({ source: change.source, moduleText: change.moduleText, dependencies: change.dependencies });
    const surface = assessWorkerToolSurface({ name: change.name, source: installedText });

    if (surface.reasons.length > 0) {
        // Not installed, and reported: running it against a private copy of the map would be
        // the silent loss, and dropping it without a word would be the invisible one. The
        // turn reports the reason instead of pretending the tool is available here.
        state.commitFaults.push(`capability: ${surface.reasons.map((entry) => entry.message).join(' ')}`);

        return Promise.resolve();
    }

    // A created tool's body needs the metadata as well as the text: `registerTool` refuses a
    // candidate with no description.
    void replica.registerTool({
        name: change.name,
        ...(change.description === undefined ? {} : { description: change.description }),
        ...(change.tags === undefined ? {} : { tags: change.tags }),
        ...(change.parameters === undefined ? {} : { parameters: change.parameters }),
        ...(change.moduleText === undefined
            ? { source: change.source }
            : { moduleText: change.moduleText, ...(change.dependencies === undefined ? {} : { dependencies: change.dependencies }) })
    });

    // M5: the keys this revision added to the session window join this lane's declared set,
    // and their canonical digests are pulled immediately - a memory write for a key with no
    // read base would otherwise be refused as undeclared on the lane's very next boundary.
    return declareMemoryKeys(change.memoryKeys);
};

// T10 finding M5: join keys the authority added to this session's memory window (because a
// tool revision that names them was just installed) and fetch their canonical values.
//
// Without this the derivation loop never examines the key, so the tool's memory write is
// invisible to the commit - the "silently dropped memory effect" the finding names. A key
// the scan did not produce is never added, so the window still bounds what a lane may write
// (./lane-authority.ts `memory:window`, enforced at the fold by ./lane-commit.ts).
const declareMemoryKeys = (keys: readonly string[] | undefined): Promise<void> => {
    if (keys === undefined || keys.length === 0 || state.replica === undefined) return Promise.resolve();

    const fresh = keys.filter((key) => !state.declaredKeys.includes(key));

    if (fresh.length === 0) return Promise.resolve();

    state.declaredKeys.push(...fresh);

    return raise({ op: 'memory:window', keys: fresh }).then(
        (reply) => applyMemoryFrame(reply.value as MemoryWindow),
        () => undefined
    );
};

// ---------------------------------------------------------------------------
// Progress events, with credit
// ---------------------------------------------------------------------------

// Release every run parked in the event-credit window. Two things end a wait legitimately:
// the coordinator's `event.ack`, and the run ending (an abort or a dispose) - in the second
// case no further ack is coming, and a promise nobody resolves would strand the turn's
// terminal commit (T10 finding S3).
const drainAckWaiters = (): void => {
    for (const resolve of state.ackWaiters.splice(0, state.ackWaiters.length)) resolve();
};

const emitProgress = async (event: HarnessEvent): Promise<void> => {
    const turnId = state.turnId;

    if (turnId === undefined) return;

    const streamSeq = state.nextStreamSeq();

    send({ kind: 'event', laneEpoch: state.epoch, turnId, streamSeq, event });

    // Credit window: wait while the coordinator is more than LANE_EVENT_WINDOW behind. This
    // is the worker-side half of the inline backpressure contract.
    while (state.ackedThrough + LANE_EVENT_WINDOW < streamSeq) {
        if (state.controller?.signal.aborted === true) return;

        await new Promise<void>((resolve) => {
            state.ackWaiters.push(resolve);
        });
    }
};

// ---------------------------------------------------------------------------
// Commit boundaries
// ---------------------------------------------------------------------------

// The read surface the derivation needs. Stated structurally (not as `Harness`) because the
// handle members are patched in worker mode (T10 finding S1: a routed read is a promise), so
// this loop reads conversations through the replica's ORIGINAL closures. A test or probe can
// hand over the same three members without a harness.
export type ReplicaReadView = {
    threadMessages: (threadId: string) => HarnessMessage[];
    memory: { has: (key: string) => boolean; get: (key: string) => unknown };
    snapshot: () => { agentResults?: HarnessAgentResultSnapshot[] };
};

// T4.1: the CONTENT half of the committed base, digested from the replica's own read of the
// conversation this lane writes — the same `digestMemoryValue` (via `expectsDigestOf`) the
// authority CASes against, and key-order independent, so the two sides agree whenever they hold
// the same messages.
//
// This is what an append-shaped base cannot see: `setIncluded` and `edit` rewrite an
// already-committed entry IN PLACE (src/harness.ts, src/types/index.ts `edit`), which changes no
// length, so `transcript.length > committedLength` — the ONLY condition a lane owed an operation
// for until T4 — stayed false and the change died with the worker process (finding F6).
export const committedDigestOf = (
    replica: ReplicaReadView,
    base: { targetId: string; committedLength: number }
): string => expectsDigestOf(replica.threadMessages(base.targetId).slice(0, base.committedLength));

// Re-adopt the content base from this replica. Called at every point `committedLength` moves
// (a first turn for a target, an adopted receipt, a transcript sync), because after any of them
// the prefix this replica holds IS canonical state — so recomputing locally always equals what
// the authority's receipt reported, and the NEXT derivation can tell "canonical moved" from
// "I moved", which is the whole difference between a rebase and losing a plugin's decision.
const adoptCommittedBase = (): void => {
    const targetId = state.targetId;

    if (state.replica === undefined || targetId === undefined) {
        state.committedDigest = '';
        return;
    }

    state.committedDigest = committedDigestOf(readView(), { targetId, committedLength: state.committedLength });
};

// The operations this lane owes the authority, derived from what it actually did since the
// facts its RECEIPTS reported. Nothing here is a whole-state diff: each op names the prefix,
// the digest, or the identity it depends on.
export const deriveOperations = (lane: LaneWorkerState, replica: ReplicaReadView): SharedMutation[] => {
    const ops: SharedMutation[] = [];

    // 1. The transcript this lane owns, appended at the length the AUTHORITY last reported.
    const transcript: HarnessMessage[] = replica.threadMessages(lane.targetId as string);

    // 1a. IN-PLACE changes to the committed prefix (pipeline T4.1). The length test below is
    //     blind to them by construction — a flag write or a text edit does not grow the
    //     transcript — so the base carries the content it was adopted with, and a digest
    //     comparison is what makes "I disabled a unit two turns ago" an operation the authority
    //     has to hear about. Whole prefix, not a sparse diff: see ./lane-commit.ts on why the
    //     whole-prefix CAS is the honest granularity, and note that this is the SAME serializer
    //     the authority CASes with (`expectsDigestOf` → `digestMemoryValue`, key-order
    //     independent), so the fold's view and this replica's read agree on a canonical prefix
    //     they both got by validating the same messages.
    const committedPrefix = transcript.slice(0, lane.committedLength);
    const committedDigest = expectsDigestOf(committedPrefix);

    if (committedDigest !== lane.committedDigest) {
        ops.push({
            kind: 'transcript:patch',
            threadId: lane.targetId as string,
            expectedLength: lane.committedLength,
            expects: lane.committedDigest,
            messages: committedPrefix
        });
    }

    // 1b. The append, unchanged. Emitted SECOND on purpose: the fold applies a group in order,
    //     a patch never changes a length, so an append at `committedLength` lands on the prefix
    //     the patch above just rewrote — which is what lets one boundary carry a plugin's prune
    //     of older turns AND the turn it just answered.
    if (transcript.length > lane.committedLength) {
        ops.push({
            kind: 'transcript:append',
            threadId: lane.targetId as string,
            fromLength: lane.committedLength,
            messages: transcript.slice(lane.committedLength)
        });
    }

    // 2. Memory: only the declared window, and only a key whose digest moved since this lane
    //    read it. An undeclared sibling key is invisible here, so this lane can never delete
    //    it (T3 finding F4's lost update).
    for (const key of lane.declaredKeys) {
        const present = replica.memory.has(key);
        const value = present ? replica.memory.get(key) : undefined;
        const digest = expectsDigestOf(value);
        const read = lane.readDigests[key] ?? expectsDigestOf(undefined);

        if (digest === read) continue;

        ops.push(present ? { kind: 'memory:set', key, value, expects: read } : { kind: 'memory:delete', key, expects: read });
    }

    // 3. Terminal invocations this lane produced. Identity is this replica's own (leased at
    //    hello), so two lanes cannot archive the same id; completion ORDER is reassigned by
    //    the authority, which owns the ordering counter.
    //
    //    T10 finding M3: the skip test is the published DIGEST, not the id. A host thread's
    //    invocation id is its thread id, so turn 2 of the same conversation legitimately
    //    archives that id again - a Set keyed by id suppressed it forever and the canonical
    //    archive kept the first answer. The digest projection excludes `completedOrder`
    //    (./lane-commit.ts `archiveDigestOf`), which the authority reassigns, so an unchanged
    //    result is still skipped and a new one is sent.
    const results = replica.snapshot().agentResults ?? [];

    for (const record of results) {
        if (lane.archived.get(record.invocationId) === archiveDigestOf(record)) continue;

        ops.push({
            kind: 'result:archive',
            invocationId: record.invocationId,
            sequence: record.sequence,
            completedOrder: record.completedOrder,
            agent: record.agent,
            role: record.role,
            // The run's origin (root / delegation / fork / autoanswer).
            runKind: record.kind,
            status: record.status,
            content: record.content,
            ...(record.error === undefined ? {} : { error: record.error })
        });
    }

    return ops;
};

// The receipt a lane waits for at a boundary. `complete` says every op landed; `receipts`
// carries, per op, what actually happened and the canonical fact the lane must adopt
// (T10 finding M2), which is also where a needed transcript rebase is detected.
type CommitOutcome = { complete: boolean; receipts: MutationReceipt[] };

// One boundary, at a time (T10 finding S4).
//
// A `mutation` group is ordered by `seq`, and the journal refuses a group that arrives out
// order, so an interrupt that commits while a turn's final commit is still awaiting its
// receipt used to settle two groups concurrently: the second receipt answered a seq the
// authority had already passed, and the lane parked on a promise nobody resolves. Every
// commit - and the transcript rebase its retry depends on - runs through here.
const runExclusive = <T,>(work: () => Promise<T>): Promise<T> => {
    const run = state.commitChain.then(work, work);

    state.commitChain = run.then(
        () => undefined,
        () => undefined
    );

    return run;
};

// The read view the derivation uses: the replica's ORIGINAL closures, not the routed handle
// members (T10 finding S1), because a committed tail must be a synchronous array.
const readView = (): ReplicaReadView => {
    const replica = state.replica as Harness;

    return {
        threadMessages: (threadId) => localThreads.messages(threadId),
        memory: replica.memory,
        snapshot: () => replica.snapshot() as { agentResults?: HarnessAgentResultSnapshot[] }
    };
};

// One group, sent and answered. The seq is taken here so a caller cannot report progress for
// a group that was never raised.
const sendCommit = (ops: SharedMutation[], reason: 'agent_message', turnId?: string): Promise<CommitOutcome> => {
    const seq = state.nextSeq();

    send({
        kind: 'mutation',
        laneEpoch: state.epoch,
        ...(turnId === undefined ? {} : { turnId }),
        reason,
        group: { laneEpoch: state.epoch, seq, ops }
    });

    return new Promise<CommitOutcome>((resolve) => {
        state.pendingCommits.set(seq, resolve);
    });
};

// Adopt the canonical facts a receipt reported, per op (T10 findings M2 and M3).
//
// The retired rule was all-or-nothing: an incomplete group adopted NOTHING, so one contested
// memory key left the lane re-deriving the same refusal forever, and the turn could never
// publish. The correct rule splits by receipt:
//   - `applied`  -> adopt what the AUTHORITY wrote (its length/digest, never our guess);
//   - rejected memory -> adopt the canonical digest the receipt carries, so the next boundary
//     writes against the real value (this is what makes the retry land);
//   - rejected transcript append OR patch -> the length alone is not enough: the replica needs
//     the canonical MESSAGES, which `needsRebase` asks for;
//   - rejected archive of a slot another live lane owns -> remember the canonical digest so
//     this lane stops re-sending an identity it does not hold;
//   - `group-rolled-back` -> nothing landed, so nothing is adopted.
const adoptReceipts = (ops: SharedMutation[], receipts: MutationReceipt[]): { needsRebase: boolean; faults: string[] } => {
    const faults: string[] = [];
    let needsRebase = false;
    // T4.1: whether the CONTENT base needs re-adopting. Only a transcript op that LANDED moves
    // it; a refused patch or a rolled-back group leaves this replica's prefix exactly where the
    // authority says it is not, and the base must keep saying that (re-adopting on a refusal
    // would silently swallow the change the next boundary is supposed to re-send or rebase).
    let transcriptMoved = false;

    for (const receipt of receipts) {
        const op = ops[receipt.opId];

        if (op === undefined) continue;

        const digest = receipt.effect?.digest;

        if (receipt.status === 'applied') {
            if (op.kind === 'transcript:append') state.committedLength = receipt.effect?.length ?? state.committedLength + op.messages.length;

            // T4.1: an applied patch rewrote the committed prefix on CANONICAL state, and this
            // replica already holds that content (it sent it), so the length does not move while
            // the content base does. Without this adoption the next boundary would re-derive the
            // same patch and the plugin's write would be pushed once per tool call forever.
            if (op.kind === 'transcript:patch') transcriptMoved = true;
            if (op.kind === 'transcript:append') transcriptMoved = true;

            if (op.kind === 'result:archive' && digest !== undefined) {
                state.archived.set(op.invocationId, digest);

                // The identity this turn's answer is addressable by (the last terminal result it
                // published), reported on the terminal frame so the roster mirror names a real
                // archived invocation.
                state.turnInvocationId = op.invocationId;
            }
            if (op.kind === 'memory:set') state.readDigests[op.key] = digest ?? expectsDigestOf(op.value);
            if (op.kind === 'memory:delete') state.readDigests[op.key] = digest ?? expectsDigestOf(undefined);

            continue;
        }

        const code = receipt.rejection?.code ?? 'rejected';

        faults.push(`${code}: ${receipt.rejection?.message ?? 'no reason given'}`);

        if (code === 'group-rolled-back') continue;

        if ((op.kind === 'memory:set' || op.kind === 'memory:delete') && digest !== undefined) state.readDigests[op.key] = digest;
        // T4.1: a patch conflicts on the same axis as an append (`prefix-moved`), so it takes the
        // same action — pull canonical and re-derive. That is also the case where a plugin's
        // in-place decision is DROPPED in favour of the writer that landed first: the flag is
        // re-derived from policy on the next round, never merged entry by entry, because a
        // whole-prefix digest cannot tell the reader which entries it disagreed about.
        if ((op.kind === 'transcript:append' || op.kind === 'transcript:patch') && code === 'prefix-moved') needsRebase = true;
        if (op.kind === 'result:archive' && code === 'not-writer' && digest !== undefined) state.archived.set(op.invocationId, digest);
    }

    if (transcriptMoved) adoptCommittedBase();

    return { needsRebase, faults };
};

// T10 finding M4: pull the canonical transcript messages this replica has not adopted.
//
// `committedLength` is the canonical prefix this lane holds, so the answer is exactly what
// moved - a sibling `threadSend`, another lane's append, a coordinator transcript edit. The
// delta is inserted AT that prefix, which keeps the lane's own unpublished tail after it in
// the order canonical state already has; appending it at the end instead would make the
// replica's tail stop matching canonical, and the next append would publish the wrong
// messages at the right length.
//
// Returns false when the replica refused the write (the core refuses a wholesale transcript
// replacement while a run is attached, harness.ts ~3821). That is not a loss: the facts are
// re-read at the next commit boundary, which is the safe point.
const syncTranscript = async (): Promise<boolean> => {
    const replica = state.replica;
    const targetId = state.targetId;

    if (replica === undefined || targetId === undefined) return false;

    // T4.1: the pull now states WHAT this replica holds, not only how much, so an in-place
    // canonical change (a host transcript edit, another lane's committed patch) at the same
    // length is answered with the whole transcript instead of an empty delta.
    const reply = await raise({
        op: 'transcript:sync',
        threadId: targetId,
        haveLength: state.committedLength,
        haveDigest: state.committedDigest
    });
    const canonical = reply.value as { threadId: string; fromLength: number; length: number; messages: HarnessMessage[]; rebased?: boolean };
    const rebased = canonical.rebased === true;

    // "Nothing moved" is length AND content: `rebased` says the authority compared this lane's
    // stated digest against canonical's and they differ, which is exactly the case where the
    // counts match and the bytes do not.
    if (canonical.length === state.committedLength && !rebased) return false;

    const local = localThreads.messages(targetId);

    // Nothing of ours is waiting to publish, and canonical only got LONGER: a plain append is
    // enough, and it is legal even while the run is live (the lane-worker seam deliberately
    // skips the live-run guard). A rebase is NOT that case — the prefix itself moved, so the
    // answer is the WHOLE transcript and appending it here would duplicate the conversation.
    if (local.length === state.committedLength && !rebased) {
        try {
            replica.appendThreadMessages(targetId, canonical.messages, state.committedLength);
        } catch {
            return false;
        }

        state.committedLength = canonical.length;
        adoptCommittedBase();

        return true;
    }

    // Own work is pending, so the delta has to go BETWEEN the adopted prefix and that tail.
    // `rebased` means canonical got shorter than our base OR rewrote the part our base covers
    // (a reset, a host repair, a sibling's patch): then the whole canonical transcript is the
    // prefix and our tail follows it. The lane's own in-place edit of a committed entry is
    // dropped by that replace — canonical won the CAS, and the policy that produced the edit
    // runs again on the next `turn.before` round.
    const prefix = rebased ? canonical.messages : [...local.slice(0, canonical.fromLength), ...canonical.messages];

    try {
        replica.setThreadMessages(targetId, [...prefix, ...local.slice(state.committedLength)]);
    } catch {
        // Refused while a local run is attached. Nothing is adopted, so the base keeps saying
        // "my prefix disagrees with canonical", and the next boundary (or the next turn start,
        // which always syncs before the run attaches) asks again.
        return false;
    }

    state.committedLength = prefix.length;
    adoptCommittedBase();

    return true;
};

// Extra rebase-and-retry attempts per boundary. One is enough to beat a single concurrent
// writer; more would let two lanes fighting over one key spin inside a turn.
const COMMIT_RETRY_LIMIT = 1;

// Send one commit group and await its receipt. Applied facts are adopted INSIDE, so a caller
// cannot report progress the authority refused. The reason is always `agent_message`: it is
// the core's own reason for "a conversation changed", which is all a lane commits.
const commit = async (reason: 'agent_message', turnId?: string): Promise<void> =>
    runExclusive(async () => {
        if (state.replica === undefined) return;

        let ops = deriveOperations(state, readView());

        if (ops.length === 0) return;

        let faults: string[] = [];

        for (let attempt = 0; ; attempt += 1) {
            const outcome = await sendCommit(ops, reason, turnId);
            const adopted = adoptReceipts(ops, outcome.receipts);

            if (outcome.complete) return;

            faults = adopted.faults;

            if (attempt >= COMMIT_RETRY_LIMIT) break;

            // A transcript refusal needs the canonical messages before a re-derivation can
            // mean anything; a memory refusal is already re-based by `adoptReceipts`.
            if (adopted.needsRebase) await syncTranscript();

            ops = deriveOperations(state, readView());

            if (ops.length === 0) break;
        }

        // The base moved with every receipt that reported a canonical fact, so the next
        // boundary re-derives against the AUTHORITY's state (T3 findings F7/F8) - and a turn
        // whose state nobody accepted still reports its refusals instead of hiding them.
        state.commitFaults.push(...faults);
    });

// ---------------------------------------------------------------------------
// hello: rebuild the replica
// ---------------------------------------------------------------------------

// What this replica can really do. A non-empty refusal list fails the HELLO, so the operator
// learns before a turn is spent rather than halfway through a lost write.
const capabilityReport = (replica: Harness, preset: HarnessPreset, refusedNestedRuns: string[]): {
    ok: boolean;
    agents: string[];
    tools: string[];
    unsupported: { code: string; message: string }[];
    // T12 (S7): the nested-run tools this replica removed. Named here so the operator reads
    // the limitation in the hello handshake instead of discovering it as a missing feature.
    limitations: { code: string; message: string }[];
} => {
    // T10 finding M5: `toolScanTextOf` reads `moduleText` (plus the captured helpers), which
    // is where the text of a `format: 'module'` registration actually lives. Reading
    // `.source` handed the planner `undefined` for every shipped core tool, so all 30 tools
    // were reported lane-safe without a single line of them being scanned.
    const sources = replica.toolSources();
    const installed = new Map(sources.map((source) => [source.name, toolScanTextOf(source)]));
    const plan = planWorkerToolSurfaces(
        Object.keys(replica.tools).map((name) => ({
            name,
            // A tool with no captured revision came from the preset's own configuration: the
            // replica rebuilt it the same way the authority has it, so there is nothing to
            // INSTALL - only nothing to SCAN. ./capability.ts keeps that a warning.
            source: installed.get(name)
        }))
    );

    return {
        ok: plan.unsupported.length === 0,
        agents: Object.keys(replica.agents).sort(),
        tools: Object.keys(replica.tools).sort(),
        // The routed runtime interception protects every shared operation a CORE tool can
        // reach, so the only lane-unsafe thing left is an opaque body that walks the memory
        // map dynamically or touches a canonical-document member of the live handle.
        unsupported: plan.unsupported.map((surface) => surface.reasons).flat(),
        limitations: nestedRunHandshakeLimitations(refusedNestedRuns)
    };
};

// T14: the nested-run limitations the HELLO frame carries, built in ONE place so the handshake can
// never state less than the core enforces. Two kinds of entry, both under the same code:
//   - the tool entries THIS replica removed (`delegate`/`threadFork`, only when the preset really
//     registered them), named as tools;
//   - the doors `refuseNestedRuns` ARMED on the replica (./capability.ts NESTED_RUN_ARMED_DOORS),
//     named as the call a tool body would write — so the limitation is still stated for a harness
//     that has no subagents, where the only way to reach a child was always through the context.
export const nestedRunHandshakeLimitations = (refusedTools: readonly string[]): { code: string; message: string }[] => [
    ...refusedTools
        .slice()
        .sort()
        .map((name) => ({ code: NESTED_RUN_LIMITATION_CODE, message: nestedRunLimitationMessage(name) })),
    ...NESTED_RUN_ARMED_DOORS.map((door) => ({ code: NESTED_RUN_LIMITATION_CODE, message: nestedRunRefusalMessage(door) }))
];

// R3 (the GLOBAL tool switch): turn the blueprint's LANE-CREATION deny-list into the
// provider this replica's harness is built with. It lives here, next to its only caller,
// and is EXPORTED for the same reason `requestToolsRoutePayload` is: it is the one piece of
// the lane's tool-settings path that can be pinned without spawning a thread.
//
// WHY A SNAPSHOT IS THE HONEST SHAPE HERE: the coordinator's provider is a closure over the
// live store (../tool-settings.ts `provider`), and a closure cannot cross `worker_threads`.
// The alternative - shipping nothing - is what the "WORKER MODE" headers used to document as
// a limit: a lane kept declaring and launching tools the operator had switched off. Carrying
// the SET at lane creation gives a new lane the CURRENT value (an idle reclaim, a new
// conversation, an authority rebuild) while a live lane keeps the value it was built with,
// which is exactly the documented lane semantics (../harness.swagger.yaml, the
// plugin-settings PATCH: a lane "picks the new value up the next time its lane is created").
//
// WHY `undefined` FOR AN EMPTY LIST: `harness()` keeps a fast path for "no provider wired"
// (src/harness.ts `declared()` returns the list as built when `toolSettings` is absent), and
// an empty deny list answers identically to an absent provider. Returning the provider only
// when it can actually refuse something keeps a lane with nothing switched off byte-identical
// to the pre-R3 replica, and makes `blueprint.disabledTools: []` and an absent field mean the
// same thing rather than two shapes.
//
// EDGE CASES, all deliberate:
//   - the list may name ANY deployment tool, the harness-owned core names included: since
//     R5 the store accepts every switch, so a replica can absolutely see `toolRequest`
//     switched off, and it must answer that exactly like the in-process harness does
//     (../tool-settings.ts is a plain deny list, and this is its snapshot);
//   - the list is COPIED into a Set, so a caller mutating the array afterwards cannot move
//     this lane's answer mid-turn (a snapshot that changes under a run is not a snapshot).
// The worker's OWN read of the two deployment-wide switches, built from the blueprint's
// lane-creation snapshots. Both exist because the coordinator's providers are CLOSURES over
// live stores - `../tool-settings.ts` and `../plugins.ts` hand every harness the same object
// and re-read it per decision - and a closure cannot cross `worker_threads`. Serialising the
// VALUES at lane creation (../sessions.ts `blueprintFor`) and rebuilding the provider here is
// what makes a replica answer the operator's switches instead of the library's declared
// defaults; a live lane keeps the state it was created with and the next lane sees the edit,
// the documented semantics (../harness.swagger.yaml, PATCH /v1/harness/plugins/{plugin_id}).
//
// `undefined` for an absent/empty snapshot is the deliberate fast path: the preset factories
// spread these members only when present (../harnesses/toolbox.ts), so a deployment that never
// touched either switch builds exactly the harness it built before the switches existed -
// including the library's declared-default plugin-settings provider, which is what an absent
// `HarnessConfiguration.pluginSettings` means (src/harness.ts:1395).
export const laneToolSettingsProvider = (disabledTools?: readonly string[]): HarnessToolSettingsProvider | undefined => {
    if (disabledTools === undefined || disabledTools.length === 0) return undefined;

    const disabled = new Set(disabledTools);

    return {
        // `harness()` treats any non-`true` answer as enabled (src/harness.ts
        // `isToolGloballyDisabled`), and a Set lookup is exactly that answer.
        isToolDisabled: (name: string) => disabled.has(name)
    };
};

// R3 (the PLUGIN switches): the blueprint's plugin-settings snapshot turned back into the
// `HarnessPluginSettingsProvider` the replica's harness is built with - the twin of
// `laneToolSettingsProvider` above, for the other deployment-wide setting.
//
// WHY A `get`-ONLY PROVIDER IS THE RIGHT SHAPE HERE: the settings view a plugin holds
// resolves `stored override -> declared default -> call fallback` (src/plugin/settings.ts
// `resolve`), so a provider that answers ONLY the operator's overrides is complete - every
// key nobody touched keeps its declared default, exactly like the host's own provider, which
// is also an override map (../plugins.ts `provider`). No plugin metadata has to cross, and
// the library's `wakeIntervalMs` legacy seed is unaffected: the server never sets that field,
// and `DEFAULT_WAKE_INTERVAL_MS` equals the `async-ping` plugin's declared default, so an
// override-less read answers the same 600000 either way.
//
// NO `set` MEMBER, deliberately: the provider contract treats a writer-less provider as a
// read model, and `api.settings.setOwn` refuses it with the stated "this harness's
// plugin-settings provider is read-only (no writer)" answer (src/plugin/settings.ts:324-331).
// That is the honest lane answer. The provider a replica used to get instead (the library's
// in-memory one, absent configuration) ACCEPTS a write into a copy that dies with the lane,
// so a plugin that stored a value believed the host had it. Nothing shipped calls `setOwn`
// (src/plugins/** reads only), so this changes no built-in's behaviour - it makes a
// hypothetical host plugin's write refuse loudly instead of lying quietly.
//
// `undefined` for an absent/empty snapshot: no plugin setting has ever been changed (the
// pre-R3 document shape), so the worker installs no provider and the library's
// declared-default provider answers, byte for byte as before.
//
// EDGE CASES:
//   - the map is COPIED (per plugin), so a caller mutating the blueprint afterwards cannot
//     move a live lane's answer mid-turn - the same snapshot rule as the tool deny list;
//   - an OWN-KEY lookup only: a plugin named `constructor` or `toString` must not resolve
//     through the prototype and report a value nobody stored.
export const lanePluginSettingsProvider = (
    pluginSettings?: HarnessPluginSettingsRecord
): HarnessPluginSettingsProvider | undefined => {
    if (pluginSettings === undefined || Object.keys(pluginSettings).length === 0) return undefined;

    const snapshot: HarnessPluginSettingsRecord = {};

    for (const [plugin, values] of Object.entries(pluginSettings)) snapshot[plugin] = { ...values };

    return {
        get: (plugin: string, key: string) =>
            Object.prototype.hasOwnProperty.call(snapshot, plugin) ? snapshot[plugin]?.[key] : undefined
    };
};

const sayHello = async (frame: Extract<LaneCommand, { kind: 'hello' }>): Promise<void> => {
    const blueprint: LaneBlueprint = frame.blueprint;

    state.epoch = frame.laneEpoch;
    state.identities = { ...blueprint.identities };

    // The preset record is the only way a worker can own a harness: a factory closure from
    // the coordinator's process cannot cross (./capability.ts refuses such a preset).
    const preset = presetFromRecord(blueprint.record);

    // R3: the replica's global tool provider, built ONCE here so the presence test below and
    // the value it installs can never disagree.
    const toolSettings = laneToolSettingsProvider(blueprint.disabledTools);
    // R3: and the replica's plugin-settings provider, same one-build rule. This is the value
    // every plugin's `api.settings` - and therefore the framework's `enabled` HOOK gate -
    // resolves through on this thread (src/plugin/host.ts, src/plugin/hooks.ts).
    const pluginSettings = lanePluginSettingsProvider(blueprint.pluginSettings);

    const replica = preset.create(
        { ...blueprint.settings, ...(blueprint.apiKey === undefined ? {} : { apiKey: blueprint.apiKey }) },
        (event: HarnessEvent) => emitProgress(event),
        {
            // The authority persists on ITS harness. A replica state change only marks a
            // boundary, and boundaries are driven by the commit calls below. This callback
            // must never throw: the core swallows observer errors (T3 finding F4's invisibility).
            stateChange: () => undefined,
            // R3: the GLOBAL tool switch, as THIS lane was created. The blueprint carries the
            // deny list itself (the coordinator's provider is a closure and cannot cross
            // `worker_threads`), and `laneToolSettingsProvider` above turns it back into the
            // provider the factory below forwards into `HarnessConfiguration.toolSettings`
            // (../harnesses/toolbox.ts). A lane therefore honours every name switched off when
            // the lane was created, and picks up a later edit when it is next created - the
            // documented lane semantics, the same ones the plugin-settings PATCH states
            // (../harness.swagger.yaml, PATCH /v1/harness/plugins/{plugin_id}). Discovery is not even delayed by that window:
            // a lane's `toolRequest` is routed to the authority (../lane-authority.ts), which
            // answers against the canonical harness and so against the LIVE provider.
            ...(toolSettings === undefined ? {} : { toolSettings }),
            // R3: the plugin switches, on the identical rule. The framework gates every
            // built-in plugin's HOOKS on `settings.boolean('enabled', true)`
            // (src/plugin/host.ts:183-197, src/plugin/hooks.ts `isDeliverable`), and the view
            // resolves `stored override -> declared default` (src/plugin/settings.ts
            // `resolve`). Without the blueprint's override map a replica therefore answered
            // the DECLARED default, so a plugin the operator switched off kept running its
            // hooks on every lane - and every knob (`contextLimit`, `minTokens`, `intervalMs`)
            // kept its shipped value. With it, the replica's gate reads the operator's value,
            // and an override-less key still falls through to its declared default.
            ...(pluginSettings === undefined ? {} : { pluginSettings }),
            // T1.5's last mile, stated rather than left implied: the HOST has a diagnostic sink
            // now (../sessions.ts `notePluginDiagnostic`), and this replica does not forward one,
            // because a report fired inside a hook has no frame to travel on — a closure cannot
            // cross `worker_threads`, and `protocol.ts` has no diagnostic frame. So a plugin that
            // throws HERE is still fail-open and still invisible to the authority, exactly like
            // the plugin-SETTINGS limit documented at ../plugins.ts "WORKER MODE" (both are F5's
            // one cause: the replica is rebuilt from a record, not from the host's closures). A
            // lane that cannot run a plugin's shared write says so loudly through its commit
            // receipts instead; giving the diagnostics a frame is lane-protocol work, not this.
            diagnostic: () => undefined,
            // N4: an owner question. The runtime registers the request and emits its own
            // action_request / action_answer frames (which ride the event stream), then awaits
            // THIS handler. The question crosses as data, the answer comes back as data, and
            // the asking run owns the cancellation - a live `context` or `signal` cannot cross
            // a thread (T3 finding F9). `autoAnswer` stays unset, exactly like the inline
            // store: a server host never picks an option on the user's behalf.
            interaction: {
                actionRequest: (context: HarnessActionRequestContext, signal: AbortSignal) => {
                    if (signal.aborted) return Promise.reject(new Error('The run was cancelled.'));

                    const call = raiseRequest({
                        op: 'action:request',
                        requestId: context.requestId,
                        agent: context.agent,
                        ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
                        request: context.request
                    });

                    signal.addEventListener(
                        'abort',
                        () => call.reject('The run ended before the question was answered.'),
                        { once: true }
                    );

                    return call.promise.then((reply) => reply.value as HarnessActionChoice);
                }
            }
        }
    );

    // Reserve the leased id ranges BEFORE restoring: `restore()` raises counters with
    // Math.max, so an inflated reservation survives it, and a snapshot whose newest id is
    // lower cannot hand this lane an id somebody else already holds (T3 finding F2).
    replica.reserveIdentity(reservationOf(blueprint.identities));

    // R1 consequence, handled HERE rather than by weakening the kernel: the coordinator seeds a
    // brand-new session's enabled set with every name ITS harness can switch, and this replica is
    // rebuilt from a RECORD (`presetFromRecord`, ../harnesses/registry.ts:873-884 — "a factory
    // closure from the coordinator's process cannot cross", ./capability.ts), so a tool a preset
    // passed as a `tool()` object (`extraTools`, e.g. the `testFlaky` fixture) is registered on
    // the coordinator and absent here. `restore()` refuses an enabled name that is not registered
    // (src/harness.ts:11611) because on the COORDINATOR such a name would be silently un-callable
    // after a restart; on a lane replica it is the ordinary shape of a record rebuild, and the
    // shipped rebuild already says so (registry.ts:727-730: the rebuilt harness runs "minus a tool
    // this build no longer has"). `isToolSwitchable` is the kernel's own "a live, switchable
    // definition resolves under this name" answer (src/types/index.ts:3885), so a name it rejects
    // is a name this lane could never call: it is dropped from the replica's copy of the enabled
    // set. Everything the replica DOES register keeps its switch state, which is what the R3
    // lane-propagation pins (../workers/lane-tool-settings.test.ts) still test, and the coordinator's
    // strict check — with its per-session restore isolation, ./restore-isolation.test.ts — is untouched.
    type DiscoveryCarrier = { discovery?: { enabled?: readonly string[] } & Record<string, unknown> } & Record<string, unknown>;
    const carried = blueprint.snapshot as DiscoveryCarrier;
    const discovery = carried.discovery;
    const enabledNames = discovery?.enabled ?? [];
    // Only a name this replica cannot switch is dropped, and the snapshot object is copied rather
    // than mutated, so a frame that needed no pruning is restored exactly as it arrived.
    const kept = enabledNames.filter((name) => replica.isToolSwitchable(name));

    replica.restore(
        kept.length === enabledNames.length
            ? (blueprint.snapshot as never)
            : ({ ...carried, discovery: { ...discovery, enabled: kept } } as never)
    );

    state.replica = replica;
    state.declaredKeys = [...blueprint.memoryKeys];

    // T10 finding M3: keyed by the canonical DIGEST of each result the snapshot already
    // carries, not by invocation id. Those results came from the canonical harness, so this
    // lane does not owe them again - but the NEXT result for the same conversation id does
    // have to be sent, which a Set of ids made impossible.
    state.archived = new Map(
        (((replica.snapshot() as { agentResults?: HarnessAgentResultSnapshot[] }).agentResults ?? []) as HarnessAgentResultSnapshot[]).map(
            (record) => [record.invocationId, archiveDigestOf(record)]
        )
    );

    installAuthorityRuntime(replica);

    // T12 (S7) / T14 / T15: shape the replica BEFORE the report is built and before any turn or
    // tool call can arrive. The call is UNCONDITIONAL — every lane arms the nested-run policy
    // whatever preset it rebuilt, and an operation that beat the handshake is already refused above
    // ('A turn arrived before hello completed') — and it is the LAST replica-shaping step before
    // `capabilityReport`, so the hello frame states what this lane refuses rather than discovering
    // it mid-turn. A replica that cannot arm throws HERE, which the message loop turns into a
    // `fault` frame: the handshake is rejected, and the coordinator never falls back to inline.
    const refusedNestedRuns = refuseNestedRuns(replica);

    // R5b: install the SESSION SWITCH state, and then any reconcile that arrived mid-handshake.
    //
    // THIS position is the whole design: after `installAuthorityRuntime` (so `localRuntime` is the
    // replica's own kernel seams, not the routed ones) and AFTER `refuseNestedRuns` (which deletes
    // names from this registry, so a canonical switch for one of them must be pruned, not
    // installed against a tool that no longer resolves here). It is the same applier the
    // `sync.tools` frame runs, so hello and a live toggle cannot drift: hello is simply the first
    // reconcile of the session's tool state.
    //
    // `withheldTools` is optional on the blueprint, and the snapshot ALREADY carries the same set
    // under `discovery.withheld` (src/harness.ts:11679, restored at :11919) - the fallback below
    // is what makes the two spellings agree instead of fighting, and what keeps a coordinator that
    // ships only the snapshot at exactly the state it always reached.
    const blueprintWithheld = blueprint.withheldTools ?? (discovery as { withheld?: readonly string[] } | undefined)?.withheld ?? [];

    applyToolStateSync({ enabled: [...enabledNames], withheld: [...blueprintWithheld] });

    // A frame that landed while this replica did not exist yet (see LaneWorkerState
    // `.pendingToolSync`): the coordinator has ALREADY posted the newer state, so applying it on
    // top of the blueprint's is what makes "toggle a tool while the lane is starting" land rather
    // than vanish. Cleared here so a later hello on a rebuilt replica cannot re-apply a stale one.
    //
    // Mutation-probed as DEFENSIVE rather than load-bearing with today's host: the worker drains the
    // whole hello install before the frame posted at `lanes.set` is ever processed
    // (./lane-host.ts:872-874), so the boot-window case in ../lane-tool-reconcile.test.ts stays
    // green with this stash removed. It stays because that ordering is a host implementation detail,
    // not a protocol guarantee - an `await` ahead of this install would make it live again.
    const earlySync = state.pendingToolSync;

    state.pendingToolSync = undefined;

    if (earlySync !== undefined) applyToolStateSync(earlySync);

    const report = capabilityReport(replica, preset, refusedNestedRuns);

    send({ kind: 'hello', laneEpoch: frame.laneEpoch, version: LANE_PROTOCOL_VERSION, capabilities: report });
};

// ---------------------------------------------------------------------------
// The message loop
// ---------------------------------------------------------------------------

const handle = async (frame: LaneCommand): Promise<void> => {
    switch (frame.kind) {
        case 'hello': {
            await sayHello(frame);
            return;
        }

        case 'turn': {
            const replica = state.replica;

            if (replica === undefined) {
                send({ kind: 'fault', laneEpoch: frame.laneEpoch, message: 'A turn arrived before hello completed.' });
                return;
            }

            state.turnId = frame.turnId;
            state.commitFaults = [];
            state.ackedThrough = 0;
            state.turnInvocationId = undefined;

            const targetId = frame.target.kind === 'thread' ? frame.target.threadId : `agent:${frame.target.agent}`;
            const firstTurnForTarget = state.targetId !== targetId;

            state.targetId = targetId;

            // T10 finding M4: the base is the prefix THIS REPLICA holds, never the canonical
            // length read off the authority. The retired code assigned `frame.fromLength`
            // straight to the base, so whenever canonical had run ahead of the replica (a
            // sibling `threadSend` landed while this lane was idle), the lane's own new
            // messages sat BELOW that base and were skipped - the lane committed nothing and
            // its work was dropped.
            if (frame.reset === true) {
                // The inline path resets conversations for a fresh legacy block before the run
                // (../sessions.ts ~5399); the replica must do the same, or the two transcripts
                // would disagree at the first append.
                for (const brain of Object.values(replica.agents)) brain.reset();

                state.committedLength = localThreads.messages(targetId).length;
                // T4.1: a reset re-bases the CONTENT half too — the digest of the (now shorter)
                // prefix this replica holds is the base every later patch is compared against.
                adoptCommittedBase();
            } else if (firstTurnForTarget) {
                // A fresh replica was built from the canonical snapshot at hello, so its own
                // copy IS the canonical prefix at that instant; adopt that length and pull only
                // what has moved since.
                state.committedLength = localThreads.messages(targetId).length;
                // T4.1: and adopt its content. This is the line that makes a RESTARTED lane
                // correct by construction: the new worker's base is canonical state as of hello,
                // so the plugin's next `turn.before` decision is diffed against the truth and the
                // `transcript:patch` it derives lands instead of conflicting with itself.
                adoptCommittedBase();
            }

            // The turn-start delta sync. `frame.fromLength` is the cross-check that proves the
            // two sides may disagree, and the pull closes the gap BEFORE the run starts, so the
            // model context already contains a message another lane sent here.
            //
            // T4.1 adds the CONTENT half of that check. A canonical IN-PLACE change — an operator
            // repairing one turn's text, or a sibling lane's committed `transcript:patch` — moves
            // no length at all, so the length test alone would call it "nothing moved" and this
            // turn would ask the provider with a transcript the authority no longer holds. An
            // absent `fromDigest` (an older coordinator) keeps the length-only rule, never a guess.
            const canonicalMoved =
                state.committedLength !== frame.fromLength ||
                (frame.fromDigest !== undefined && frame.fromDigest !== state.committedDigest);

            if (canonicalMoved) {
                await runExclusive(() => syncTranscript());
            }

            const controller = new AbortController();

            state.controller = controller;

            const options = {
                signal: controller.signal,
                ...(frame.attachments === undefined ? {} : { attachments: frame.attachments })
            };

            let answer: string | undefined;
            let failure: string | undefined;

            try {
                if (frame.target.kind === 'thread') {
                    const message = await replica.sendThreadInput(frame.target.threadId, frame.prompt, options);

                    answer = typeof message.content === 'string' ? message.content : '';
                } else {
                    answer = await (replica as unknown as (input: string, runOptions: unknown) => Promise<string>)(frame.prompt, options);
                }
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
            }

            // The state this run produced is committed BEFORE the terminal frame, and that
            // frame names the seq whose acceptance gates publishing success.
            try {
                await commit('agent_message', frame.turnId);
            } catch (error) {
                failure = failure ?? `The lane could not commit its final state: ${(error as Error).message}`;
            }

            // The highest seq actually issued this turn (0 when nothing needed a commit).
            const terminalSeq = state.nextSeq() - 1;

            send({
                kind: 'turn-done',
                laneEpoch: frame.laneEpoch,
                turnId: frame.turnId,
                ...(answer === undefined ? {} : { answer }),
                ...(failure === undefined ? {} : { failure }),
                ...(controller.signal.aborted ? { cancelled: true } : {}),
                // The invocation this turn archived, so the coordinator's roster mirror names a
                // result that really exists (T10 M3: it is NOT derivable from the thread id).
                ...(state.turnInvocationId === undefined ? {} : { invocationId: state.turnInvocationId }),
                terminalSeq: Math.max(terminalSeq, 0),
                ...(state.commitFaults.length === 0 ? {} : { commitFaults: [...state.commitFaults] })
            });

            state.controller = undefined;
            state.turnId = undefined;

            return;
        }

        case 'steer': {
            const replica = state.replica;

            if (replica === undefined || state.targetId === undefined) {
                send({
                    kind: 'steer.result',
                    laneEpoch: frame.laneEpoch,
                    turnId: frame.turnId,
                    queued: false,
                    reason: 'There is no live run on this lane to steer.'
                });

                return;
            }

            const receipt = replica.steerThread(state.targetId, frame.input);

            // T10 finding M6: a steering refusal is its own NON-TERMINAL reply. It used to
            // travel as a `fault`, and the host settles a turn on a fault - so guidance that
            // arrived between two model steps ended a live conversation (and the terminal frame
            // for the real turn then arrived for a lane whose turn record was already gone).
            send({
                kind: 'steer.result',
                laneEpoch: frame.laneEpoch,
                turnId: frame.turnId,
                queued: receipt.queued,
                ...(receipt.queued ? {} : { reason: receipt.reason ?? 'The run is not at a point where steering applies.' })
            });

            return;
        }

        case 'invoke': {
            const replica = state.replica;

            if (replica === undefined) {
                send({ kind: 'invoke.done', laneEpoch: frame.laneEpoch, callId: frame.callId, ok: false, error: 'An invoke arrived before hello completed.' });
                return;
            }

            // A direct tool call or a slash command: the body runs HERE (decision D1) and its
            // shared operations route to the authority like any turn's.
            const request = frame.request;

            try {
                let value: unknown;

                if (request.op === 'execute:command') {
                    value = await (replica as unknown as { executeCommand: (line: string) => unknown }).executeCommand(request.line);
                } else if (request.op === 'execute:tool') {
                    value = await replica.executeTool(request.name, request.parameters);
                } else {
                    throw new Error(
                        `An invoke frame carried "${request.op}", which is not an operator invocation; only execute:tool and execute:command are sent to a lane.`
                    );
                }

                send({ kind: 'invoke.done', laneEpoch: frame.laneEpoch, callId: frame.callId, ok: true, value });
            } catch (error) {
                send({
                    kind: 'invoke.done',
                    laneEpoch: frame.laneEpoch,
                    callId: frame.callId,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error)
                });
            }

            return;
        }

        case 'interrupt': {
            rejectPendingRequests('The run was cancelled.');
            state.controller?.abort();

            // T10 finding S3: releasing the event credit waiters. A run parked in the credit
            // window of `emitProgress` is waiting on a promise that only an `event.ack`
            // resolves; after an abort that ack may never come (the coordinator stops draining
            // the stream the moment the turn is over), and the aborted run would hang there
            // instead of reaching the commit below.
            drainAckWaiters();

            // Commit what the stopped run already produced. A burn cannot be pre-empted
            // mid-loop, but the transcript it wrote is canonical state, and the terminal
            // frame below carries the cancellation. Serialized with every other commit
            // (T10 finding S4), so an interrupt landing mid-turn cannot settle a group out of
            // order and strand this receipt.
            await commit('agent_message', frame.turnId).catch(() => undefined);

            send({ kind: 'aborted', laneEpoch: frame.laneEpoch, ...(frame.turnId === undefined ? {} : { turnId: frame.turnId }) });

            return;
        }

        case 'request.reply': {
            const waiter = state.pending.get(frame.callId);

            if (waiter === undefined) return;

            state.pending.delete(frame.callId);

            if (frame.ok) waiter.resolve({ value: frame.value, sync: frame.sync });
            else waiter.reject(new Error(frame.error ?? 'The authority refused the request.'));

            return;
        }

        case 'mutation.receipt': {
            const resolve = state.pendingCommits.get(frame.seq);

            if (resolve === undefined) return;

            state.pendingCommits.delete(frame.seq);

            // T10 findings M2/M4: the whole receipt list is what the boundary acts on - the
            // per-op canonical facts, and whether a transcript refusal means canonical holds
            // messages this replica has never seen (./lane-commit.ts `prefix-moved`).
            resolve({ complete: frame.outcome.complete, receipts: frame.outcome.receipts });

            return;
        }

        case 'event.ack': {
            state.ackedThrough = Math.max(state.ackedThrough, frame.streamSeq);

            drainAckWaiters();

            return;
        }

        case 'broadcast.registry': {
            // Awaited: the change may widen this lane's memory window (T10 finding M5), and a
            // turn that calls the new tool next must already hold the canonical digests.
            await applyRegistryChange(frame.change);

            return;
        }

        case 'sync.memory': {
            applyMemoryFrame(frame.window);
            return;
        }

        // T10 finding M4: the coordinator says canonical conversation state moved. Try the
        // delta immediately - that is what makes a foreign send visible to a RUNNING turn at
        // its next safe point - and let the commit boundary retry if the replica cannot take a
        // wholesale transcript write while its run is attached.
        case 'sync.transcript': {
            await runExclusive(async () => {
                if (state.targetId !== frame.threadId) return;

                await syncTranscript();
            }).catch(() => undefined);

            return;
        }

        // R5b: the session's tool switches moved. SYNCHRONOUS and NOT serialised behind the
        // commit chain, on purpose - the applier touches only this replica's two discovery sets
        // (kernel seams, no await), and the effect the requirement cares about is the NEXT model
        // request of THIS lane, which `declared()` rebuilds from exactly those sets. Nothing here
        // aborts, interrupts or re-bases a run: a tool call already scheduled when the frame
        // lands keeps executing, because the switch is read at LAUNCH (src/harness.ts:8040) and
        // the launch already happened.
        case 'sync.tools': {
            if (state.replica === undefined) {
                // Mid-handshake. Stashed and applied at the end of hello (see LaneWorkerState
                // `.pendingToolSync`); a fault here would fail the handshake over a settings
                // frame, which is the wrong size of answer. Mutation-probed: with today's host the
                // worker drains the hello install before this frame is ever processed, so the path
                // is defensive rather than load-bearing (lane-tool-reconcile.test.ts, boot-window
                // case). It stays because a future `await` ahead of the install would make it live.
                state.pendingToolSync = frame.tools;
                return;
            }

            applyToolStateSync(frame.tools);
            return;
        }

        case 'lease.grant': {
            if (frame.lease !== undefined) adoptLease(frame.lease);

            return;
        }

        case 'dispose': {
            rejectPendingRequests('The lane was reclaimed.');
            drainAckWaiters();
            send({ kind: 'aborted', laneEpoch: frame.laneEpoch });
            channel?.close();
            process.exit(0);
        }

        default: {
            const unknown = frame as unknown as LaneCommand;

            send({ kind: 'fault', laneEpoch: unknown.laneEpoch, message: `Unknown command for a lane worker: ${describeEnvelope(unknown)}` });
        }
    }
};

// A fresh id lease: raise the counters this worker mints from.
const adoptLease = (lease: IdentityLease): void => {
    state.identities[lease.space] = Math.max(state.identities[lease.space] ?? 0, lease.start + lease.count - 1);
    reserve(state.identities);
};

// Apply an authoritative memory window to the live map and to the read-digest base.
const applyMemoryFrame = (window: MemoryWindow): void => {
    const replica = state.replica;

    if (replica === undefined) return;

    // `harness.memory.data` IS the live record the tools read (src/harness.ts ~1150), so the
    // window is written into that object - the mistake that produced F4's lost delete was
    // advancing a base without moving the live map.
    const moved = syncMemoryMap((replica.memory as unknown as { data: Record<string, unknown> }).data, window);

    for (const entry of window.entries) {
        // Only a key that actually moved may advance the base (F7).
        const applied = moved.some((result) => result.key === entry.key && result.status !== 'untransferable');

        if (applied) state.readDigests[entry.key] = entry.digest;
    }
};

// ---------------------------------------------------------------------------
// Entry wiring
// ---------------------------------------------------------------------------

/**
 * Attach the message loop. Called by ./lane-worker.ts AFTER it resolved the module.
 *
 * This is a function rather than a module side effect for one concrete reason: the bundler
 * drops an unused dynamic import (`await import('./lane-worker-loop.ts')` with nothing
 * referenced tree-shakes to an empty namespace - measured in `dist/` as
 * `Promise.resolve().then(() => Object.freeze({__proto__: null}))`). A named export the
 * entry CALLS cannot be shaken out, so the built worker really runs this loop.
 */
export const startLaneWorker = (): void => {
    if (channel === null) return;

    channel.on('message', (raw: unknown) => {
        if (!isLaneEnvelope(raw)) {
            const epoch = raw !== null && typeof raw === 'object' && typeof (raw as { laneEpoch?: unknown }).laneEpoch === 'number'
                ? (raw as { laneEpoch: number }).laneEpoch
                : 0;

            send({ kind: 'fault', laneEpoch: epoch, message: `Malformed frame for a lane worker: ${describeEnvelope(raw)}` });
            return;
        }

        const size = frameByteLength(raw);

        if (size !== undefined && size > LANE_MAX_FRAME_BYTES) {
            send({ kind: 'fault', laneEpoch: raw.laneEpoch, message: `A ${raw.kind} frame of ${size} bytes exceeded ${LANE_MAX_FRAME_BYTES}.` });
            return;
        }

        void handle(raw as LaneCommand).catch((error: Error) => {
            send({
                kind: 'fault',
                laneEpoch: state.epoch,
                ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
                message: error.message
            });
        });
    });

    channel.on('error', (error: Error) => {
        rejectPendingRequests(`The lane lost its message channel: ${error.message}`);
    });
};
