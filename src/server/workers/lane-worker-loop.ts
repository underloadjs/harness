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
    HarnessEvent,
    HarnessIdentityReservation,
    HarnessMessage,
    ToolContext
} from '../../types';
import type { HarnessPreset } from '../harnesses/types';
import { presetFromRecord } from '../harnesses';
import type { LaneAuthorityRequest } from './lane-authority';
import type { LaneBlueprint, LaneCommand, LaneReply, LaneRequestReplyValue } from './protocol';
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
import { LOCAL_RUNTIME_METHODS, ROUTED_RUNTIME_METHODS, planWorkerToolSurfaces } from './capability';
import type { SharedMutation } from './lane-commit';
import { expectsDigestOf } from './lane-commit';
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
    // Committed facts, adopted ONLY from an applied receipt (T3 finding F7).
    committedLength: number;
    readDigests: Record<string, string>;
    declaredKeys: string[];
    // Invocation ids already archived, so a boundary never re-sends one the authority has.
    archived: Set<string>;
    nextSeq: () => number;
    nextCallId: () => number;
    nextStreamSeq: () => number;
    pending: Map<number, { resolve: (value: LaneRequestReplyValue) => void; reject: (error: Error) => void }>;
    pendingCommits: Map<number, (outcome: { complete: boolean; faults: string[] }) => void>;
    // Event credit: the coordinator acks each stream sequence, so a stalled SSE consumer
    // paces this run exactly like the inline `await progress(event)` contract.
    ackedThrough: number;
    ackWaiters: (() => void)[];
    // Commits the coordinator refused. The terminal frame cannot report a clean success over
    // state nobody accepted (T3 finding F8).
    commitFaults: string[];
    // Identity high-water marks the authority shipped or leased.
    identities: Partial<Record<IdSpace, number>>;
};

const state: LaneWorkerState = {
    epoch: 0,
    committedLength: 0,
    readDigests: {},
    declaredKeys: [],
    archived: new Set(),
    nextSeq: createSequence(),
    nextCallId: createSequence(),
    nextStreamSeq: createSequence(),
    pending: new Map(),
    pendingCommits: new Map(),
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
let localRuntime: {
    requestTools: (caller: unknown, parameters: unknown) => unknown;
    manageTool: (caller: unknown, parameters: unknown) => unknown;
} = {
    // Until a replica exists, a mirror write is a no-op rather than a crash: the only callers
    // are frame handlers that cannot run before hello built the replica.
    requestTools: () => undefined,
    manageTool: () => undefined
};

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

    // `executeRecordTool(name, context)`: only the DATA part of the context crosses. The
    // authority fabricates the ToolContext against the canonical harness (./lane-authority.ts).
    route('executeRecordTool', (name, context) => ({
        name,
        parameters: (context as ToolContext | undefined)?.parameters,
        identity: identityOf(context)
    }));

    route('manageTool', (caller, parameters) => ({ parameters, identity: identityOf(caller) }));
    route('createToolForAgent', (caller, creation) => ({ creation, identity: identityOf(caller) }));
    route('requestTools', (caller, parameters) => ({ parameters, identity: identityOf(caller) }));
    route('threadSend', (caller, threadId, parameters) => ({
        threadId: threadId as string | undefined,
        parameters,
        identity: identityOf(caller, { threadId: threadId as string | undefined })
    }));
    route('threadList', (threadId) => ({ identity: identityOf(undefined, { threadId: threadId as string | undefined }) }));
    route('agentResult', (parameters) => ({ parameters, identity: identityOf(undefined) }));
    route('agentManage', () => ({ identity: identityOf(undefined) }));
    route('listTools', () => ({ identity: identityOf(undefined) }));

    // Asserted, not assumed: a NEW runtime method must be classified as routed or local
    // before a lane may run it, and this is where that rule bites at hello time.
    for (const key of Object.keys(runtime)) {
        if ((LOCAL_RUNTIME_METHODS as readonly string[]).includes(key)) continue;
        if ((ROUTED_RUNTIME_METHODS as readonly string[]).includes(key)) continue;

        throw new Error(
            `harness.runtime.${key} is neither routed to the authority nor declared local, so this build cannot guarantee that shared state has one writer.`
        );
    }
};

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

        if (granted.length > 0) {
            // LOCAL replay: `requestTools` is the core's only enabled-set writer and is
            // idempotent for names already enabled.
            localRuntime.requestTools(undefined, { names: granted });
        }
    }

    for (const change of sync.registry ?? []) applyRegistryChange(change);

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

// Install a registry change the authority already applied, so this replica runs the same
// revision the canonical harness runs (T3 finding F9: no stale definition behind a replace).
const applyRegistryChange = (change: {
    name: string;
    description?: string;
    tags?: string[];
    parameters?: Record<string, unknown>;
    source: string;
    revision: string;
    removed: boolean;
}): void => {
    const replica = state.replica;

    if (replica === undefined) return;

    if (change.removed) {
        // The core has no "unregister" operation on the handle (toolManage offers
        // list/details/source/path/create/update/reload), so a removal is mirrored by
        // dropping the entry from the replica's own registry map - the same object the
        // handle exposes, so the next call cannot resolve it.
        delete (replica.tools as Record<string, unknown>)[change.name];

        return;
    }

    // A created tool's `source` is a function BODY, so the metadata has to travel with it:
    // `registerTool` refuses a candidate without a description.
    void replica.registerTool({
        name: change.name,
        ...(change.description === undefined ? {} : { description: change.description }),
        ...(change.tags === undefined ? {} : { tags: change.tags }),
        ...(change.parameters === undefined ? {} : { parameters: change.parameters }),
        source: change.source
    });
};

// ---------------------------------------------------------------------------
// Progress events, with credit
// ---------------------------------------------------------------------------

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

// The operations this lane owes the authority, derived from what it actually did since the
// last APPLIED receipt. Nothing here is a whole-state diff: each op names the prefix, the
// digest, or the identity it depends on.
export const deriveOperations = (lane: LaneWorkerState, replica: Harness): SharedMutation[] => {
    const ops: SharedMutation[] = [];

    // 1. The transcript this lane owns, appended at the length the AUTHORITY last reported.
    const transcript: HarnessMessage[] = replica.threadMessages(lane.targetId as string);

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
    const results = replica.snapshot().agentResults ?? [];

    for (const record of results) {
        if (lane.archived.has(record.invocationId)) continue;

        ops.push({
            kind: 'result:archive',
            invocationId: record.invocationId,
            sequence: record.sequence,
            completedOrder: record.completedOrder,
            agent: record.agent,
            role: record.role,
            runKind: record.kind,
            status: record.status,
            content: record.content,
            ...(record.error === undefined ? {} : { error: record.error })
        });
    }

    return ops;
};

// Send one commit group and await its receipt. Applied facts are adopted INSIDE, so a caller
// cannot report progress the authority refused. The reason is always `agent_message`: it is
// the core's own reason for "a conversation changed", which is all a lane commits.
const commit = async (reason: 'agent_message', turnId?: string): Promise<void> => {
    const replica = state.replica;

    if (replica === undefined) return;

    const ops = deriveOperations(state, replica);

    if (ops.length === 0) return;

    const seq = state.nextSeq();

    send({
        kind: 'mutation',
        laneEpoch: state.epoch,
        ...(turnId === undefined ? {} : { turnId }),
        reason,
        group: { laneEpoch: state.epoch, seq, ops }
    });

    const outcome = await new Promise<{ complete: boolean; faults: string[] }>((resolve) => {
        state.pendingCommits.set(seq, resolve);
    });

    if (!outcome.complete) {
        // The base does NOT move: the next boundary re-derives the same intents against the
        // canonical facts the receipt carried (T3 findings F7/F8).
        state.commitFaults.push(...outcome.faults);

        return;
    }

    for (const op of ops) {
        if (op.kind === 'transcript:append') state.committedLength += op.messages.length;
        if (op.kind === 'result:archive') state.archived.add(op.invocationId);
        if (op.kind === 'memory:set') state.readDigests[op.key] = expectsDigestOf(op.value);
        if (op.kind === 'memory:delete') state.readDigests[op.key] = expectsDigestOf(undefined);
    }
};

// ---------------------------------------------------------------------------
// hello: rebuild the replica
// ---------------------------------------------------------------------------

// What this replica can really do. A non-empty refusal list fails the HELLO, so the operator
// learns before a turn is spent rather than halfway through a lost write.
const capabilityReport = (replica: Harness, preset: HarnessPreset): {
    ok: boolean;
    agents: string[];
    tools: string[];
    unsupported: { code: string; message: string }[];
} => {
    const sources = replica.toolSources();
    const installed = new Map(sources.map((source) => [source.name, source.source]));
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
        unsupported: plan.unsupported.map((surface) => surface.reasons).flat()
    };
};

const sayHello = async (frame: Extract<LaneCommand, { kind: 'hello' }>): Promise<void> => {
    const blueprint: LaneBlueprint = frame.blueprint;

    state.epoch = frame.laneEpoch;
    state.identities = { ...blueprint.identities };

    // The preset record is the only way a worker can own a harness: a factory closure from
    // the coordinator's process cannot cross (./capability.ts refuses such a preset).
    const preset = presetFromRecord(blueprint.record);

    const replica = preset.create(
        { ...blueprint.settings, ...(blueprint.apiKey === undefined ? {} : { apiKey: blueprint.apiKey }) },
        (event: HarnessEvent) => emitProgress(event),
        {
            // The authority persists on ITS harness. A replica state change only marks a
            // boundary, and boundaries are driven by the commit calls below. This callback
            // must never throw: the core swallows observer errors (T3 finding F4's invisibility).
            stateChange: () => undefined,
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
    replica.restore(blueprint.snapshot as never);

    state.replica = replica;
    state.declaredKeys = [...blueprint.memoryKeys];
    state.archived = new Set(((replica.snapshot().agentResults ?? []) as { invocationId: string }[]).map((record) => record.invocationId));

    installAuthorityRuntime(replica);

    const report = capabilityReport(replica, preset);

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
            state.targetId = frame.target.kind === 'thread' ? frame.target.threadId : `agent:${frame.target.agent}`;

            // The authority reports the canonical transcript length for THAT conversation at
            // dispatch; the lane appends against it instead of guessing its own.
            state.committedLength = frame.fromLength;

            // The inline path resets conversations for a fresh legacy block before the run
            // (../sessions.ts ~5399); the replica must do the same, or the two transcripts
            // would disagree at the first append.
            if (frame.reset === true) {
                for (const brain of Object.values(replica.agents)) brain.reset();

                // A reset rewrites every conversation, so the committed prefix restarts from
                // what the reset seeded (the instructions message).
                state.committedLength = replica.threadMessages(state.targetId).length;
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
                send({ kind: 'fault', laneEpoch: frame.laneEpoch, message: 'Steering arrived with no live run on this lane.' });
                return;
            }

            const receipt = replica.steerThread(state.targetId, frame.input);

            if (!receipt.queued) {
                send({
                    kind: 'fault',
                    laneEpoch: frame.laneEpoch,
                    turnId: frame.turnId,
                    message: receipt.reason ?? 'The run is not at a point where steering applies.'
                });
            }

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

            // Commit what the stopped run already produced. A burn cannot be pre-empted
            // mid-loop, but the transcript it wrote is canonical state, and the terminal
            // frame below carries the cancellation.
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

            const faults = frame.outcome.receipts
                .filter((receipt) => receipt.status === 'rejected')
                .map((receipt) => `${receipt.rejection?.code ?? 'rejected'}: ${receipt.rejection?.message ?? 'no reason given'}`);

            resolve({ complete: frame.outcome.complete, faults });

            return;
        }

        case 'event.ack': {
            state.ackedThrough = Math.max(state.ackedThrough, frame.streamSeq);

            for (const resolve of state.ackWaiters.splice(0, state.ackWaiters.length)) resolve();

            return;
        }

        case 'broadcast.registry': {
            applyRegistryChange(frame.change);
            return;
        }

        case 'sync.memory': {
            applyMemoryFrame(frame.window);
            return;
        }

        case 'lease.grant': {
            if (frame.lease !== undefined) adoptLease(frame.lease);

            return;
        }

        case 'dispose': {
            rejectPendingRequests('The lane was reclaimed.');
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
