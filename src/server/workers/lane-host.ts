// The lane host: the coordinator-side owner of every live lane worker.
//
// WHAT THIS MODULE IS
// -------------------
// One instance per SessionStore. It spawns a `Worker` per LIVE lane (one lane = one
// persistent conversation, plus a `root` lane for the legacy `/messages` run and an
// `operator` lane for a direct tool call or slash command), performs the hello handshake,
// relays that worker's frames into the session's authority, and reclaims idle workers.
//
// WHY ONE WORKER PER CONVERSATION
// -------------------------------
// The isolation promise (R1) is per LOGICAL thread: a CPU-bound tool body in lane A must not
// freeze lane B, the HTTP surface, or a sibling's SSE stream. Only a separate OS thread buys
// that, so each live conversation gets its own worker (bounded by `maxLaneWorkers`, because
// every worker owns a harness replica).
//
// ORDERING RULES ENFORCED HERE
// ----------------------------
//   - Events are relayed through the store's own recorder and only THEN acked, so a worker
//     never runs further ahead of the state the server has recorded than the credit window
//     allows - the same backpressure the inline `await progress(event)` contract had.
//   - Mutating requests are answered strictly in arrival order per lane, so a `task add` can
//     never be observed after a later `task list` from that same lane. Read-only requests,
//     leases, and an owner question (which waits on a human) are answered concurrently, so a
//     pending question never blocks a sibling tool call of the same run.
//   - A terminal turn is published only when the authority's journal confirms that turn's
//     final commit was applied (`mayPublishSuccess`). A refused commit surfaces as a failure,
//     never as success with the fault hidden in a log (T3 finding F8).
//   - When a worker errors or exits, every pending promise of that lane settles and the epoch
//     is retired in the authority's journal, so a frame that still arrives late is refused by
//     the receipt path instead of mutating state nobody owns (T3 finding F9).
//   - One turn per lane at a time. The store's lane pump is already FIFO and the harness
//     serializes inside a conversation; a second concurrent dispatch is a caller bug and is
//     reported as one rather than silently queued behind a live worker.
//
// ENTRY RESOLUTION (no silent inline fallback)
// --------------------------------------------
// `threadExecution: 'worker'` must really isolate, so the entry is resolved explicitly: the
// operator's `workerEntry`, else the built `dist/` bundle, else the source module (dev/test,
// where the entry installs its own resolver hooks). A missing entry is a ServerRuntimeError
// naming both candidate paths - not a session quietly executed inline.
//
// Cross-references:
//   - ./lane-authority.ts   - the canonical state every frame is applied to
//   - ./lane-worker-loop.ts - the worker side of this conversation
//   - ../sessions.ts        - the caller (executeTurn, executeTool, executeCommand)
//   - ../config.ts          - `ServerRuntimeConfiguration` and its error type

import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { HarnessAttachment, HarnessEvent, HarnessThreadStatus } from '../../types';
import type { ServerRuntimeConfiguration } from '../config';
import { ServerRuntimeError } from '../config';
import { packagePath } from '../package-root';
import type { LaneAuthority, LaneAuthorityRequest } from './lane-authority';
import type { IdSpace } from './lane-identity';
import type { IdentityLease } from './lane-identity';
import type { LaneBlueprint, LaneCommand, LaneReply } from './protocol';
import { LANE_PROTOCOL_VERSION, createSequence, describeEnvelope, isLaneEnvelope, isLaneReplyKind } from './protocol';
import { laneWorkerEnvironment } from './capability';

// Ids a lane mints locally, reserved per lane at hello. A lane that outgrows its reservation
// asks for another with a `lease` request; 512 covers a long-lived conversation without a
// round trip, and ids are never reused, so an unused tail costs only a gap (decision D5).
export const LANE_RUN_ID_LEASE = 512;
export const LANE_THREAD_ID_LEASE = 32;

// The non-thread lane roles: the legacy root run, and operator actions (a direct tool call
// or a slash command) that decision D1 also keeps off the coordinator.
export const ROOT_LANE_ROLE = 'root';
export const OPERATOR_LANE_ROLE = 'operator';

export type LaneTarget = { kind: 'thread'; threadId: string } | { kind: 'root'; agent: string };

// The per-session data a lane needs to rebuild its replica. The store already owns both
// records, so the host never keeps session state of its own: a reclaimed lane costs nothing
// but a rebuild from committed state.
export type LaneBlueprintSource = Pick<LaneBlueprint, 'record' | 'settings' | 'apiKey' | 'memoryKeys'>;

export type LaneTurnRequest = {
    sessionKey: string;
    authority: LaneAuthority;
    turnId: string;
    target: LaneTarget;
    prompt: string;
    attachments?: HarnessAttachment[];
    // Mirror of the inline `freshBlock` rule for a legacy `/messages` turn.
    reset?: boolean;
    signal?: AbortSignal;
    onEvent: (event: HarnessEvent) => Promise<void>;
    blueprint: LaneBlueprintSource;
};

export type LaneTurnResult = {
    answer?: string;
    failure?: string;
    cancelled?: boolean;
    commitFaults?: string[];
};

// A registry change the authority already applied and pushes to every live replica. It
// carries the METADATA as well as the source, because a created tool's source is a function
// BODY (not a self-describing module): a replica cannot install the revision from text alone,
// and `registerTool` refuses a candidate with no description.
export type RegistryChange = {
    name: string;
    description?: string;
    tags?: string[];
    parameters?: Record<string, unknown>;
    source: string;
    revision: string;
    removed: boolean;
};

export type LaneHost = {
    runTurn(request: LaneTurnRequest): Promise<LaneTurnResult>;
    // An operator action (direct tool call / slash command), on the session's operator lane.
    invoke<T = unknown>(input: { sessionKey: string; authority: LaneAuthority; request: LaneAuthorityRequest; blueprint: LaneBlueprintSource }): Promise<T>;
    steer(sessionKey: string, target: LaneTarget, input: string): boolean;
    interrupt(sessionKey: string, target: LaneTarget, reason?: string): boolean;
    broadcastRegistry(sessionKey: string, change: RegistryChange): void;
    closeLane(sessionKey: string, target: LaneTarget, reason?: string): void;
    closeSession(sessionKey: string, reason?: string): void;
    // Store shutdown: every worker terminated.
    close(reason?: string): Promise<void>;
    // Live lanes, so a deployment can prove what is isolated (and an operator can see it).
    lanes(): { sessionKey: string; role: string; epoch: number; busy: boolean }[];
    runtime: ServerRuntimeConfiguration;
    entry(): { path: string; mode: 'explicit' | 'built' | 'source' };
};

// Resolve the worker entry once per host (it cannot move while the server runs).
const resolveEntry = (runtime: ServerRuntimeConfiguration): { path: string; mode: 'explicit' | 'built' | 'source' } => {
    if (runtime.workerEntry !== undefined) {
        if (!existsSync(runtime.workerEntry)) {
            throw new ServerRuntimeError(
                `workerEntry names "${runtime.workerEntry}", which does not exist. Build the package ("yarn build") or leave HARNESS_WORKER_ENTRY unset.`
            );
        }

        return { path: runtime.workerEntry, mode: 'explicit' };
    }

    const built = packagePath('dist', 'underload-harness.worker.mjs');

    if (existsSync(built)) return { path: built, mode: 'built' };

    // Source mode: vitest and `vite-node` run before any build exists. The entry installs
    // resolve hooks for the extension-less specifiers this repo uses, so a plain `new
    // Worker(...)` under Node can evaluate the graph.
    const source = packagePath('src', 'server', 'workers', 'lane-worker.ts');

    if (existsSync(source)) return { path: source, mode: 'source' };

    throw new ServerRuntimeError(
        `No lane-worker entry exists: neither "${built}" nor "${source}" was found. Build the package ("yarn build"), or set workerEntry / HARNESS_WORKER_ENTRY to the built worker file.`
    );
};

// A command must survive `postMessage`. Checked on the coordinator so a live reference (a
// closure, a signal, an Agent) fails as a named error here instead of as a structured-clone
// TypeError inside Node.
const assertTransferable = (laneKey: string, frame: LaneCommand): void => {
    try {
        structuredClone(frame);
    } catch (error) {
        throw new ServerRuntimeError(
            `A ${frame.kind} frame for lane ${laneKey} cannot be transferred: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

// The roster mirror for a lane conversation.
//
// A canonical thread record says `idle` and carries no `invocationId` unless something moves
// it, and in worker mode the run that would have moved it lives on another thread. Without
// this, the UI would show a running conversation as idle and could not join its turn to the
// archived result. A refusal (the conversation was deleted mid-turn) is not an error worth
// failing a settled turn for, so it is absorbed here and reported by the next read.
const mirrorThreadStatus = (
    authority: LaneAuthority,
    threadId: string,
    status: HarnessThreadStatus,
    invocationId?: string
): void => {
    try {
        authority.harness.setThreadStatus(threadId, status, ...(invocationId === undefined ? [] : [invocationId]));
    } catch {
        // The conversation is gone, or a local run owns its own status. Either way the
        // canonical transcript commit (or its absence) is what the next read reports.
    }
};

// The lane a turn's conversation is addressed as on the CANONICAL harness: a host thread id,
// or the agent's default conversation for a root run (its transcript IS those messages).
const canonicalTargetId = (target: LaneTarget): string =>
    target.kind === 'thread' ? target.threadId : `agent:${target.agent}`;

// The request kinds that change canonical state. Their answers are ordered per lane;
// everything else (a read, a lease, an owner question) may settle concurrently.
const MUTATING_REQUEST_OPS = new Set(['runtime']);

/**
 * Create the lane host for one store.
 *
 * `runtime.threadExecution` is the caller's decision: this function is only ever reached in
 * worker mode (../sessions.ts asks first), so a host that exists at all means isolation is
 * promised, and every failure below is reported rather than degraded into inline execution.
 */
export const createLaneHost = (runtime: ServerRuntimeConfiguration): LaneHost => {
    const environment = laneWorkerEnvironment();

    if (!environment.workersAvailable) {
        throw new ServerRuntimeError(environment.message ?? 'This process does not provide worker threads.');
    }

    const entry = resolveEntry(runtime);
    const nextEpoch = createSequence(1);

    type LiveLane = {
        key: string;
        role: string;
        epoch: number;
        worker: Worker;
        authority: LaneAuthority;
        ready: Promise<void>;
        settleReady: (error?: Error) => void;
        busy: boolean;
        // The canonical conversation this lane writes (absent for the operator lane). Kept so
        // a crash or reclaim can retire the roster mirror instead of leaving 'running' behind.
        targetId?: string;
        nextCallId: () => number;
        invokes: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
        turn?: { turnId: string; resolve: (result: LaneTurnResult) => void; reject: (error: Error) => void };
        onEvent?: (event: HarnessEvent) => Promise<void>;
        mutationChain: Promise<void>;
        idleTimer?: ReturnType<typeof setTimeout>;
        closed: boolean;
    };

    const lanes = new Map<string, LiveLane>();
    // The epoch each key held before, so a reborn lane retires its OWN predecessor in the
    // authority's journal (a sibling's epoch is untouched).
    const previousEpochs = new Map<string, number>();

    const laneKeyOf = (sessionKey: string, target: LaneTarget): string =>
        `${sessionKey}::${target.kind === 'thread' ? target.threadId : target.kind}`;

    const post = (lane: LiveLane, frame: LaneCommand): void => {
        if (lane.closed) return;

        assertTransferable(lane.key, frame);
        lane.worker.postMessage(frame);
    };

    const clearIdle = (lane: LiveLane): void => {
        if (lane.idleTimer === undefined) return;

        clearTimeout(lane.idleTimer);
        lane.idleTimer = undefined;
    };

    // Reclaim is always safe: the next turn rebuilds the replica from the authority's
    // committed state, and the epoch is retired so nothing can arrive for the old worker.
    const armIdle = (lane: LiveLane): void => {
        if (runtime.workerIdleMs <= 0 || lane.closed) return;

        lane.idleTimer = setTimeout(() => {
            closeWorker(lane, 'idle');
        }, runtime.workerIdleMs);

        lane.idleTimer.unref?.();
    };

    const closeWorker = (lane: LiveLane, reason: string): void => {
        if (lane.closed) return;

        lane.closed = true;
        clearIdle(lane);

        // The epoch dies BEFORE the frames stop: any late reply from this worker is then
        // refused by the journal, which is what makes "the old worker answered anyway" safe.
        lane.authority.closeLane(lane.epoch);

        try {
            lane.worker.postMessage({ kind: 'dispose', laneEpoch: lane.epoch, reason } satisfies LaneCommand);
        } catch {
            // A dead channel is expected here; terminate() is the real teardown.
        }

        void lane.worker.terminate().catch(() => undefined);
        lanes.delete(lane.key);

        for (const [, invoke] of [...lane.invokes.entries()]) {
            invoke.reject(new Error(`The lane closed before its invocation settled (${reason}).`));
        }

        lane.invokes.clear();

        const turn = lane.turn;

        if (turn !== undefined) {
            lane.turn = undefined;
            lane.busy = false;
            turn.resolve({ failure: `The lane stopped (${reason}).`, cancelled: false });
        }

        // A crashed or reclaimed lane must not leave a conversation permanently 'running' in the
        // roster: the run is gone, whatever its last mirror said.
        if (lane.targetId !== undefined) mirrorThreadStatus(lane.authority, lane.targetId, 'idle');

        lane.settleReady(new Error(`The lane closed before it was ready (${reason}).`));
    };

    const spawn = (
        sessionKey: string,
        spec: { role: string; target?: LaneTarget },
        authority: LaneAuthority,
        blueprintSource: LaneBlueprintSource
    ): LiveLane => {
        const { role, target } = spec;
        const key = `${sessionKey}::${role}`;
        const existing = lanes.get(key);

        if (existing !== undefined && !existing.closed) {
            // A lane survives a turn: keep the worker, but always point it at the CURRENT
            // authority object (a session restore rebuilds the harness).
            existing.authority = authority;
            clearIdle(existing);

            return existing;
        }

        const epoch = nextEpoch();
        const previous = previousEpochs.get(key);

        previousEpochs.set(key, epoch);
        authority.openLane(epoch, previous);

        // THIS lane is the writer of the conversation it runs. The lease is what lets a
        // transcript append be accepted, and it is what makes a second lane delegating into
        // the SAME agent default conversation take its own child instead of writing behind
        // this one (T3 finding F5). The operator lane has no conversation, so it claims
        // nothing: its writes are record/registry operations, which are CAS-guarded instead.
        if (target !== undefined) {
            authority.leases.claim(
                target.kind === 'thread'
                    ? { kind: 'thread', id: target.threadId }
                    : { kind: 'agent', name: target.agent },
                epoch
            );
        }

        // Lease the id ranges this replica mints locally, so two lanes rebuilt from one
        // snapshot cannot mint the same invocation or thread identity (T3 finding F2). The
        // published values are the LAST USED id of each range, which is what a replica's
        // `++counter` continues from.
        const runLease = authority.ledger.allocate('invocation', LANE_RUN_ID_LEASE, epoch);
        const threadLease = authority.ledger.allocate('thread', LANE_THREAD_ID_LEASE, epoch);

        if (!runLease.ok) throw new ServerRuntimeError(`The invocation identity space is exhausted: ${runLease.fault.message}`);
        if (!threadLease.ok) throw new ServerRuntimeError(`The thread identity space is exhausted: ${threadLease.fault.message}`);

        const identities: Partial<Record<IdSpace, number>> = {
            invocation: identityEnd(runLease.lease),
            resultSequence: identityEnd(runLease.lease),
            thread: identityEnd(threadLease.lease),
            // Budget and completion order are the AUTHORITY's counts: a replica may read them
            // but never moves them (T3 finding F3).
            createdToolCount: authority.ledger.watermarkOf('createdToolCount'),
            completedOrder: authority.ledger.watermarkOf('completedOrder')
        };

        const blueprint: LaneBlueprint = {
            ...blueprintSource,
            snapshot: authority.blueprintSnapshot(),
            identities
        };

        const worker = new Worker(entry.path, {
            // Source mode needs Node's type transform; a built bundle needs no execArgv.
            ...(entry.mode === 'source' ? { execArgv: ['--experimental-transform-types'] } : {}),
            workerData: { laneEpoch: epoch, protocol: LANE_PROTOCOL_VERSION }
        });

        let settleReady: (error?: Error) => void = () => undefined;

        const ready = new Promise<void>((resolve, reject) => {
            settleReady = (error?: Error) => (error === undefined ? resolve() : reject(error));
        });

        // A rejected `ready` nobody awaited would surface as an unhandled rejection; the
        // dispatch path always awaits it, so this only guards the shutdown races.
        ready.catch(() => undefined);

        const lane: LiveLane = {
            key,
            role,
            epoch,
            worker,
            authority,
            ready,
            settleReady,
            busy: false,
            ...(target === undefined ? {} : { targetId: canonicalTargetId(target) }),
            nextCallId: createSequence(),
            invokes: new Map(),
            mutationChain: Promise.resolve(),
            closed: false
        };

        const handshake = setTimeout(() => {
            settleReady(
                new ServerRuntimeError(
                    `The lane worker did not complete its hello handshake within ${runtime.workerHandshakeMs}ms (entry: ${entry.path}).`
                )
            );
            closeWorker(lane, 'handshake-timeout');
        }, runtime.workerHandshakeMs);

        handshake.unref?.();

        const onFrame = async (incoming: unknown): Promise<void> => {
            if (!isLaneEnvelope(incoming)) {
                settleReady(new ServerRuntimeError(`Malformed frame from lane ${key}: ${describeEnvelope(incoming)}`));
                return;
            }

            // A worker sends replies, never commands. Narrowing through `isLaneReplyKind`
            // keeps the switch below exhaustive over `LaneReply` - `hello` exists in BOTH
            // directions (the coordinator sends the blueprint, the worker answers with its
            // capability report), so a plain union switch would not disambiguate it.
            if (!isLaneReplyKind(incoming.kind)) return;

            const raw = incoming as LaneReply;

            // A frame from a superseded epoch is dropped BEFORE it can touch anything: the
            // worker that owns this conversation now is a different one.
            if (raw.laneEpoch !== lane.epoch) return;

            switch (raw.kind) {
                case 'hello': {
                    clearTimeout(handshake);

                    if (raw.version !== LANE_PROTOCOL_VERSION) {
                        settleReady(
                            new ServerRuntimeError(
                                `The lane worker speaks protocol v${raw.version}; this build speaks v${LANE_PROTOCOL_VERSION}. Rebuild the package so dist/ and the server agree.`
                            )
                        );
                        closeWorker(lane, 'protocol-mismatch');
                        return;
                    }

                    if (!raw.capabilities.ok) {
                        settleReady(
                            new ServerRuntimeError(
                                `This session cannot run its threads on a lane worker: ${raw.capabilities.unsupported
                                    .map((reason) => reason.message)
                                    .join(' ')}`
                            )
                        );
                        closeWorker(lane, 'capability-refused');
                        return;
                    }

                    // The declared memory window ships before any turn, so a tool's first read
                    // sees canonical values under canonical digests.
                    post(lane, { kind: 'sync.memory', laneEpoch: lane.epoch, window: lane.authority.memoryWindow(lane.epoch) });
                    settleReady();
                    return;
                }

                case 'event': {
                    const sink = lane.onEvent;

                    if (sink === undefined) {
                        // Nothing is waiting for this event: ack anyway so the lane is not
                        // parked on a window nobody drains, and let the turn report itself.
                        post(lane, { kind: 'event.ack', laneEpoch: lane.epoch, streamSeq: raw.streamSeq });
                        return;
                    }

                    try {
                        await sink(raw.event);
                        post(lane, { kind: 'event.ack', laneEpoch: lane.epoch, streamSeq: raw.streamSeq });
                    } catch (error) {
                        // A recorder failure is the run's failure: the inline path aborts the
                        // run when its sink throws, and a lane must not pretend otherwise.
                        closeWorker(lane, `event relay failed: ${error instanceof Error ? error.message : String(error)}`);
                    }

                    return;
                }

                case 'mutation': {
                    const outcome = lane.authority.commit(lane.epoch, raw.group);

                    post(lane, { kind: 'mutation.receipt', laneEpoch: lane.epoch, seq: raw.group.seq, outcome });

                    return;
                }

                case 'request': {
                    const reply = async (): Promise<void> => {
                        try {
                            const value = await lane.authority.answer(lane.epoch, raw.request);

                            post(lane, {
                                kind: 'request.reply',
                                laneEpoch: lane.epoch,
                                callId: raw.callId,
                                ok: true,
                                value: value.value,
                                ...(value.sync === undefined ? {} : { sync: value.sync })
                            });
                        } catch (error) {
                            post(lane, {
                                kind: 'request.reply',
                                laneEpoch: lane.epoch,
                                callId: raw.callId,
                                ok: false,
                                error: error instanceof Error ? error.message : String(error)
                            });
                        }
                    };

                    if (MUTATING_REQUEST_OPS.has(raw.request.op)) {
                        lane.mutationChain = lane.mutationChain.then(reply);
                    } else {
                        void reply();
                    }

                    return;
                }

                case 'invoke.done': {
                    const invoke = lane.invokes.get(raw.callId);

                    if (invoke === undefined) return;

                    lane.invokes.delete(raw.callId);

                    if (raw.ok) invoke.resolve(raw.value);
                    else invoke.reject(new Error(raw.error ?? 'The lane refused the invocation.'));

                    return;
                }

                case 'turn-done': {
                    const turn = lane.turn;

                    lane.turn = undefined;
                    lane.busy = false;
                    lane.onEvent = undefined;

                    if (turn === undefined || turn.turnId !== raw.turnId) return;

                    // The terminal gate: the state that produced this answer must already be
                    // applied (T3 finding F8).
                    const publishable = lane.authority.journal.mayPublishSuccess(lane.epoch, raw.terminalSeq);
                    const failure =
                        raw.failure ??
                        (publishable
                            ? undefined
                            : `The lane's final state was not accepted (commit ${raw.terminalSeq} did not reach the applied watermark).`);

                    turn.resolve({
                        ...(raw.answer === undefined ? {} : { answer: raw.answer }),
                        ...(failure === undefined ? {} : { failure }),
                        ...(raw.cancelled === undefined ? {} : { cancelled: raw.cancelled }),
                        ...(raw.commitFaults === undefined ? {} : { commitFaults: raw.commitFaults })
                    });

                    // Refresh this lane's memory window: a sibling may have written while the
                    // turn ran, and the next turn must read canonical digests.
                    post(lane, { kind: 'sync.memory', laneEpoch: lane.epoch, window: lane.authority.memoryWindow(lane.epoch) });
                    armIdle(lane);

                    return;
                }

                case 'fault': {
                    const turn = lane.turn;

                    if (turn !== undefined) {
                        lane.turn = undefined;
                        lane.busy = false;
                        lane.onEvent = undefined;
                        turn.resolve({ failure: raw.message, cancelled: false });
                        armIdle(lane);

                        return;
                    }

                    settleReady(new ServerRuntimeError(`The lane worker reported a fault: ${raw.message}`));
                    closeWorker(lane, raw.message);

                    return;
                }

                case 'aborted': {
                    // Confirmation only: the store classifies cancellation from its own
                    // stop request, so a lane's word here cannot change a turn's outcome.
                    return;
                }
            }
        };

        worker.on('message', (raw: unknown) => {
            void onFrame(raw).catch((error: Error) => {
                settleReady(error);
                closeWorker(lane, `relay error: ${error.message}`);
            });
        });

        worker.on('error', (error: Error) => {
            clearTimeout(handshake);
            settleReady(error);
            closeWorker(lane, `worker error: ${error.message}`);
        });

        worker.on('exit', (code: number) => {
            clearTimeout(handshake);

            if (lane.closed) return;

            closeWorker(lane, `worker exited with code ${code}`);
        });

        post(lane, { kind: 'hello', laneEpoch: epoch, blueprint });

        lanes.set(key, lane);

        return lane;
    };

    const identityEnd = (lease: IdentityLease): number => lease.start + lease.count - 1;

    const waitForLane = async (lane: LiveLane): Promise<void> => {
        await lane.ready;

        if (lane.closed) throw new ServerRuntimeError(`The lane for ${lane.key} closed before it was ready.`);
    };

    const runTurn = async (request: LaneTurnRequest): Promise<LaneTurnResult> => {
        const lane = spawn(
            request.sessionKey,
            { role: roleOf(request.target), target: request.target },
            request.authority,
            request.blueprint
        );

        await waitForLane(lane);
        clearIdle(lane);

        if (lane.busy) {
            throw new ServerRuntimeError(
                `Lane ${lane.key} is already running a turn; a conversation executes one turn at a time, so the caller must wait for the previous one.`
            );
        }

        lane.busy = true;
        lane.onEvent = request.onEvent;
        lane.targetId = canonicalTargetId(request.target);

        // The roster mirror is driven by the HOST, because the host is the only side that
        // knows when a lane's run starts and ends (the canonical record never executes it).
        mirrorThreadStatus(request.authority, lane.targetId, 'running');

        const result = await new Promise<LaneTurnResult>((resolve, reject) => {
            lane.turn = { turnId: request.turnId, resolve, reject };

            const forward = request.signal;

            if (forward !== undefined) {
                const abort = (): void => {
                    // Cancellation is a FRAME: a cloned AbortSignal arrives as an empty object,
                    // so the stop state cannot cross (./protocol.ts, T3 finding F9).
                    post(lane, { kind: 'interrupt', laneEpoch: lane.epoch, turnId: request.turnId, reason: 'The run was cancelled.' });
                };

                if (forward.aborted) abort();
                else forward.addEventListener('abort', abort, { once: true });
            }

            try {
                post(lane, {
                    kind: 'turn',
                    laneEpoch: lane.epoch,
                    turnId: request.turnId,
                    target: request.target,
                    prompt: request.prompt,
                    fromLength: request.authority.canonicalLengthOf(lane.targetId ?? canonicalTargetId(request.target)),
                    ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
                    ...(request.reset === undefined ? {} : { reset: request.reset })
                });
            } catch (error) {
                reject(error as Error);
            }
        });

        lane.busy = false;
        lane.onEvent = undefined;

        // Settle the mirror. A host thread's invocation identity is its own id (the core rule
        // `invocationIdOf` implements inline), so the roster can join this turn to the result
        // the lane archived.
        if (lane.targetId !== undefined) {
            mirrorThreadStatus(
                request.authority,
                lane.targetId,
                'idle',
                request.target.kind === 'thread' ? request.target.threadId : undefined
            );
        }

        if (lane.turn !== undefined && lane.turn.turnId === request.turnId) lane.turn = undefined;

        armIdle(lane);

        return result;
    };

    const invoke = async <T,>(input: {
        sessionKey: string;
        authority: LaneAuthority;
        request: LaneAuthorityRequest;
        blueprint: LaneBlueprintSource;
    }): Promise<T> => {
        const lane = spawn(input.sessionKey, { role: OPERATOR_LANE_ROLE }, input.authority, input.blueprint);

        await waitForLane(lane);
        clearIdle(lane);

        const callId = lane.nextCallId();

        try {
            return await new Promise<T>((resolve, reject) => {
                lane.invokes.set(callId, { resolve: resolve as (value: unknown) => void, reject });
                post(lane, { kind: 'invoke', laneEpoch: lane.epoch, callId, request: input.request });
            });
        } finally {
            armIdle(lane);
        }
    };

    const steer = (sessionKey: string, target: LaneTarget, input: string): boolean => {
        const lane = lanes.get(laneKeyOf(sessionKey, target));

        if (lane === undefined || lane.closed || lane.turn === undefined) return false;

        post(lane, { kind: 'steer', laneEpoch: lane.epoch, turnId: lane.turn.turnId, input });

        return true;
    };

    const interrupt = (sessionKey: string, target: LaneTarget, reason?: string): boolean => {
        const lane = lanes.get(laneKeyOf(sessionKey, target));

        if (lane === undefined || lane.closed) return false;

        post(lane, {
            kind: 'interrupt',
            laneEpoch: lane.epoch,
            ...(lane.turn === undefined ? {} : { turnId: lane.turn.turnId }),
            ...(reason === undefined ? {} : { reason })
        });

        return true;
    };

    const broadcastRegistry = (sessionKey: string, change: RegistryChange): void => {
        for (const lane of [...lanes.values()]) {
            if (lane.closed || !lane.key.startsWith(`${sessionKey}::`)) continue;

            post(lane, { kind: 'broadcast.registry', laneEpoch: lane.epoch, change });
        }
    };

    const closeLane = (sessionKey: string, target: LaneTarget, reason?: string): void => {
        const lane = lanes.get(laneKeyOf(sessionKey, target));

        if (lane === undefined) return;

        closeWorker(lane, reason ?? 'closed');
    };

    const closeSession = (sessionKey: string, reason?: string): void => {
        for (const [key, lane] of [...lanes.entries()]) {
            if (!key.startsWith(`${sessionKey}::`)) continue;

            closeWorker(lane, reason ?? 'session removed');
        }
    };

    const close = async (reason?: string): Promise<void> => {
        const live = [...lanes.values()];

        for (const lane of live) {
            lane.authority.closeLane(lane.epoch);
            clearIdle(lane);
            lane.closed = true;

            try {
                lane.worker.postMessage({ kind: 'dispose', laneEpoch: lane.epoch, reason: reason ?? 'server shutdown' } satisfies LaneCommand);
            } catch {
                // A worker that already stopped cannot be disposed twice.
            }

            lane.settleReady(new Error(`The lane closed (${reason ?? 'server shutdown'}).`));
        }

        await Promise.all(live.map((lane) => lane.worker.terminate().catch(() => undefined)));
        lanes.clear();
    };

    return {
        runTurn,
        invoke,
        steer,
        interrupt,
        broadcastRegistry,
        closeLane,
        closeSession,
        close,
        runtime,
        entry: () => entry,
        lanes: () =>
            [...lanes.values()].map((lane) => ({
                sessionKey: lane.key.slice(0, lane.key.lastIndexOf('::')),
                role: lane.role,
                epoch: lane.epoch,
                busy: lane.busy
            }))
    };
};

// The lane role for a target: a thread id, or the root/operator role name.
const roleOf = (target: LaneTarget): string => (target.kind === 'thread' ? target.threadId : target.kind);
