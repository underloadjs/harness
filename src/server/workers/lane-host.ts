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
// operator's `workerEntry`, else the package's own `src/server/workers/lane-worker.ts`. There is
// no built bundle to prefer - this package publishes TypeScript source and is run through Vite,
// so the `.ts` entry IS the production artifact. A missing entry is a ServerRuntimeError naming
// what was looked for - not a session quietly executed inline.
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
import { MAX_LANE_WORKERS_LIMIT, ServerRuntimeError } from '../config';
import { packagePath } from '../package-root';
import type { LaneAuthority, LaneAuthorityRequest } from './lane-authority';
import type { IdSpace } from './lane-identity';
import type { IdentityLease } from './lane-identity';
import type { LaneBlueprint, LaneCommand, LaneRegistryChange, LaneReply } from './protocol';
import { LANE_PROTOCOL_VERSION, createSequence, describeEnvelope, isLaneEnvelope, isLaneReplyKind } from './protocol';
import { laneWorkerEnvironment } from './capability';
import { openHarnessWorkerSession, type HarnessWorkerSession } from './worker-runner';

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
//
// `disabledTools` and `pluginSettings` (both R3) join the same list because they are the
// same KIND of value: durable settings the coordinator can only hand over as data - but they
// come from DIFFERENT scopes, and a lane replica must not read that as one deployment-wide
// pair. `disabledTools` IS process-wide (../tool-settings.ts `disabled()`, one switch for
// every session), while `pluginSettings` is the SESSION's own snapshot: ../sessions.ts
// `blueprintFor` hands over `session.plugins.snapshot()`, that conversation's copy made at
// its creation (../plugins.ts `copyPluginSettingsStore`), never the template store. The
// store reads both at THIS moment, the host merges them into the `hello` blueprint verbatim
// below, and the worker turns each back into the provider its harness is built with
// (./lane-worker-loop.ts `laneToolSettingsProvider` / `lanePluginSettingsProvider`). They are
// therefore LANE-CREATION snapshots, not live reads - the documented lane semantics for every
// value that crosses here (../harness.swagger.yaml, the plugin-settings PATCH).
export type LaneBlueprintSource = Pick<
    LaneBlueprint,
    'record' | 'settings' | 'apiKey' | 'memoryKeys' | 'disabledTools' | 'pluginSettings'
>;

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
    // The invocation id this turn's result was archived under, as the LANE reports it. A
    // store-dispatched host thread gets a fresh numeric invocation per turn (harness.ts
    // `invocationIdOf` falls back to `String(run.id)`), so the coordinator cannot name the
    // roster's invocation from the thread id and must take the lane's word for it.
    invocationId?: string;
};

// A registry change the authority already applied and pushes to every live replica. It
// carries the METADATA as well as the text, because a created tool's source is a compiled
// body (not a self-describing module): a replica cannot install the revision from text alone,
// and `registerTool` refuses a candidate with no description. The single definition lives in
// ./protocol.ts so the frame and this API cannot drift (T10 finding M5).
export type RegistryChange = LaneRegistryChange;

// T12: the lane's own answer to a steering frame. `queued` is true ONLY once the worker's
// `steer.result` receipt says so - the store used to report `queued: true` from the POST alone
// (T10 finding M6 named this integration hook), which told the client its guidance landed on a
// run that had refused it. `reason` is the worker's own sentence, so the client reads why.
export type LaneSteerReceipt = { queued: boolean; reason?: string };

// One waiter per posted `steer` frame, in the order posted. The frame pair carries no steer id
// (./protocol.ts `steer` / `steer.result`), so FIFO order is the correlation, and it is sound:
// a lane has exactly one live turn, and ./lane-worker-loop.ts answers EVERY steer frame with
// its own receipt, accept or refuse.
type SteerWaiter = { resolve: (receipt: LaneSteerReceipt) => void; active: boolean };

export type LaneHost = {
    runTurn(request: LaneTurnRequest): Promise<LaneTurnResult>;
    // An operator action (direct tool call / slash command), on the session's operator lane.
    invoke<T = unknown>(input: { sessionKey: string; authority: LaneAuthority; request: LaneAuthorityRequest; blueprint: LaneBlueprintSource }): Promise<T>;
    // Awaited on purpose (see `LaneSteerReceipt`): `undefined` means there is no live lane for
    // this conversation, so the caller answers from the canonical harness; a receipt is the
    // owning lane's decision and must not be re-asked of the authority.
    steer(sessionKey: string, target: LaneTarget, input: string): Promise<LaneSteerReceipt | undefined>;
    interrupt(sessionKey: string, target: LaneTarget, reason?: string): boolean;
    broadcastRegistry(sessionKey: string, change: RegistryChange): void;
    closeLane(sessionKey: string, target: LaneTarget, reason?: string): void;
    closeSession(sessionKey: string, reason?: string): void;
    // Store shutdown: every worker terminated.
    close(reason?: string): Promise<void>;
    // Live lanes, so a deployment can prove what is isolated (and an operator can see it).
    lanes(): { sessionKey: string; role: string; epoch: number; busy: boolean }[];
    runtime: ServerRuntimeConfiguration;
    entry(): { path: string };
};

// Resolve the worker entry once per host (it cannot move while the server runs).
//
// The entry is the SOURCE module, and the thread loads it through Vite's module runner
// (./worker-boot.mjs + ./worker-runner.ts) - there is no built bundle in this package's
// publishing model, so there is no `dist/` arm to try first and no Node flag to add.
//
// T10 finding S9 still applies to the override: an operator may pin an entry (a checkout
// elsewhere, a scratch entry in a test), and that pin is honoured exactly - which is what
// keeps the integration suite asserting the CURRENT worker code instead of an older copy.
const resolveEntry = (runtime: ServerRuntimeConfiguration): { path: string } => {
    if (runtime.workerEntry !== undefined) {
        if (!existsSync(runtime.workerEntry)) {
            throw new ServerRuntimeError(
                `workerEntry names "${runtime.workerEntry}", which does not exist. Leave HARNESS_WORKER_ENTRY unset to use the package's own worker entry.`
            );
        }

        return { path: runtime.workerEntry };
    }

    const source = packagePath('src', 'server', 'workers', 'lane-worker.ts');

    if (existsSync(source)) return { path: source };

    throw new ServerRuntimeError(
        `No lane-worker entry exists: "${source}" was not found. Set workerEntry / HARNESS_WORKER_ENTRY to the worker entry to load.`
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
        // The module-runner session behind this thread: its port is what lets the thread
        // resolve and transform its `.ts` entry (./worker-runner.ts).
        runner: HarnessWorkerSession;
        authority: LaneAuthority;
        ready: Promise<void>;
        settleReady: (error?: Error) => void;
        busy: boolean;
        // The canonical conversation this lane writes (absent for the operator lane). Kept so
        // a crash or reclaim can retire the roster mirror instead of leaving 'running' behind.
        targetId?: string;
        nextCallId: () => number;
        invokes: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
        // T12: the steering receipts still waiting for this lane's live turn, keyed by turnId.
        steers: Map<string, SteerWaiter[]>;
        turn?: { turnId: string; resolve: (result: LaneTurnResult) => void; reject: (error: Error) => void };
        onEvent?: (event: HarnessEvent) => Promise<void>;
        mutationChain: Promise<void>;
        idleTimer?: ReturnType<typeof setTimeout>;
        closed: boolean;
        // The shared terminate() promise, so every close path (idle reclaim, crash, host
        // shutdown) can await the same teardown exactly once (T10 finding M8).
        termination?: Promise<void>;
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

    // T12: settle ONE waiting steer with the worker's receipt (FIFO for this turn). A reply for
    // a turn nobody waits on is dropped - the steer already timed out or the lane moved on.
    const answerSteer = (lane: LiveLane, turnId: string, receipt: LaneSteerReceipt): void => {
        const waiters = lane.steers.get(turnId);

        if (waiters === undefined) return;

        const next = waiters.find((waiter) => waiter.active);

        if (next === undefined) {
            lane.steers.delete(turnId);

            return;
        }

        next.active = false;
        next.resolve(receipt);

        if (!waiters.some((waiter) => waiter.active)) lane.steers.delete(turnId);
    };

    // T12: settle EVERY steer still waiting, because the lane can no longer answer it - the
    // turn ended, or the worker is gone. `queued: false` is the truth in both cases: the
    // guidance never reached a steerable point of a live run.
    const settleSteers = (lane: LiveLane, turnId: string | undefined, reason: string): void => {
        for (const [key, waiters] of [...lane.steers.entries()]) {
            if (turnId !== undefined && key !== turnId) continue;

            for (const waiter of waiters) {
                if (!waiter.active) continue;

                waiter.active = false;
                waiter.resolve({ queued: false, reason });
            }

            lane.steers.delete(key);
        }
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

    // Tears the lane down and returns the termination promise.
    //
    // T10 finding M8: the terminate() promise used to be fire-and-forget, so a caller that
    // needed the worker REALLY gone (host.close) could not wait for it, and the exit handler
    // of a lane whose turn was still open had nothing to settle the turn with. Returning it
    // costs nothing on the idle path and makes shutdown provable.
    const closeWorker = (lane: LiveLane, reason: string): Promise<void> => {
        if (lane.closed) return lane.termination ?? Promise.resolve();

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

        // Settles when the worker thread is actually gone; every close path shares it, so a
        // turn or an invocation is never left hanging on a worker that will not answer.
        // The runner session is released with the thread: its port is useless without the
        // worker, and the last released session closes the shared Vite server (AC6/AC7).
        const termination = lane.worker.terminate().then(
            () => {
                lane.runner.dispose();
            },
            () => {
                lane.runner.dispose();
            }
        );

        lane.termination = termination;
        lanes.delete(lane.key);

        for (const [, invoke] of [...lane.invokes.entries()]) {
            invoke.reject(new Error(`The lane closed before its invocation settled (${reason}).`));
        }

        lane.invokes.clear();

        // T12: a worker that is gone can never answer a `steer.result`, so every guidance still
        // waiting on this lane is refused now rather than held until the turn's own end.
        settleSteers(lane, undefined, `The lane stopped (${reason}).`);

        const turn = lane.turn;

        if (turn !== undefined) {
            lane.turn = undefined;
            lane.busy = false;
            lane.onEvent = undefined;
            turn.resolve({ failure: `The lane stopped (${reason}).`, cancelled: false });
        }

        // A crashed or reclaimed lane must not leave a conversation permanently 'running' in the
        // roster: the run is gone, whatever its last mirror said.
        if (lane.targetId !== undefined) mirrorThreadStatus(lane.authority, lane.targetId, 'idle');

        lane.settleReady(new Error(`The lane closed before it was ready (${reason}).`));

        return termination;
    };

    // T10 finding M4: tell the lane that OWNS a conversation that canonical state moved in
    // it. The frame carries no payload on purpose: the replica's adopted prefix is its own
    // knowledge, so it pulls exactly the delta it is missing (./lane-authority.ts
    // `transcript:sync`). A lane that cannot insert the delta yet - a wholesale transcript
    // write is refused while its run is attached - retries at its next commit boundary, which
    // is the safe point; this push is the responsiveness half of the fix, that retry is the
    // correctness half.
    const notifyTranscriptMoved = (ownerSessionKey: string, threadId: string | undefined): void => {
        if (threadId === undefined) return;

        // `agent:<name>` is an agent's DEFAULT conversation, and in worker mode the session's
        // root lane is the one that runs it (decision D1), so that is the lane to notify.
        const owner = lanes.get(
            laneKeyOf(
                ownerSessionKey,
                threadId.startsWith('agent:') ? { kind: 'root', agent: threadId.slice('agent:'.length) } : { kind: 'thread', threadId }
            )
        );

        if (owner === undefined || owner.closed) return;

        post(owner, { kind: 'sync.transcript', laneEpoch: owner.epoch, threadId });
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
            if (existing.authority === authority) {
                // A lane survives a turn: keep the worker, and point it at the CURRENT
                // authority object (a session restore rebuilds the harness).
                clearIdle(existing);

                return existing;
            }

            // T10 finding M7: the store replaced the AUTHORITY OBJECT (a restore or a reset
            // re-creates the harness, and ../sessions.ts rebuilds the authority with it). The
            // identity ledger, the writer leases and the commit journal the lane's frames were
            // validated against are gone with it, so re-pointing the live worker is not enough:
            // the retired path skipped openLane, the lease claim and the hello re-handshake, and
            // every later commit from that lane was refused as `epoch-superseded` while its
            // turn hung on a receipt that would never say `applied`. The lane is closed and
            // rebuilt, which is the only path that re-opens an epoch, re-claims the writer lease
            // and re-ships the snapshot on the new authority.
            closeWorker(existing, 'authority-replaced');
        }

        // T10 finding M9: `maxLaneWorkers` is the deployment's memory guard - every live lane
        // holds a harness replica - and it was never enforced, so the host spawned one worker
        // per conversation without limit. An idle lane is evicted first (the next turn rebuilds
        // it from committed state, which is what makes eviction safe); only when EVERY lane is
        // executing a turn is the spawn a refusal the operator can act on.
        if (lanes.size >= runtime.maxLaneWorkers) {
            const evictable = [...lanes.values()].find((candidate) => candidate.key !== key && !candidate.busy);

            if (evictable === undefined) {
                throw new ServerRuntimeError(
                    `This server runs at most ${runtime.maxLaneWorkers} lane workers at a time, and every one of them is executing a turn, so the lane for ${key} cannot start. Raise maxLaneWorkers (HARNESS_MAX_LANE_WORKERS, maximum ${MAX_LANE_WORKERS_LIMIT}) or wait for a lane to finish.`
                );
            }

            closeWorker(evictable, `evicted to stay within the ${runtime.maxLaneWorkers}-lane worker limit`);
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

        // The thread runs the plain-JS bootstrap (./worker-boot.mjs), which starts Vite's
        // module runner and imports `entry.path` (`.ts`) from the shared parent-side server.
        // The lane protocol is untouched: `laneEpoch`/`protocol` are still the boot marker,
        // and `entry`/`port` are additive runner wiring on a SECOND port.
        const runner = openHarnessWorkerSession(entry.path);

        const worker = new Worker(runner.bootScript, {
            workerData: {
                entry: runner.entryUrl,
                port: runner.transportPort,
                laneEpoch: epoch,
                protocol: LANE_PROTOCOL_VERSION
            },
            transferList: [runner.transportPort]
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
            runner,
            authority,
            ready,
            settleReady,
            busy: false,
            ...(target === undefined ? {} : { targetId: canonicalTargetId(target) }),
            nextCallId: createSequence(),
            invokes: new Map(),
            steers: new Map(),
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
                                `The lane worker speaks protocol v${raw.version}; this build speaks v${LANE_PROTOCOL_VERSION}. The worker entry and the server must come from the same checkout.`
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

                            // T10 finding M4: a cross-thread send just grew a conversation
                            // canonically. Whoever OWNS that conversation - this lane (sending
                            // into its own thread) or a live sibling - is told to pull the
                            // delta, so a running turn sees a message another lane sent it at
                            // its next safe point instead of discovering it as a refusal.
                            if (raw.request.op === 'runtime' && raw.request.method === 'threadSend') {
                                notifyTranscriptMoved(sessionKey, raw.request.threadId ?? raw.request.identity.threadId);
                            }
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

                    // T10 finding M6: compare BEFORE clearing anything. The retired handler
                    // dropped lane.turn, busy and onEvent first and only then looked at the id,
                    // so a turn-done that arrived late from an already-settled turn (a reclaimed
                    // worker, or the fault path above) cleared the record of the turn that is
                    // running NOW - and that next turn then had nothing to settle it.
                    if (turn === undefined || turn.turnId !== raw.turnId) return;

                    lane.turn = undefined;
                    lane.busy = false;
                    lane.onEvent = undefined;

                    // T12: the turn is over, so any guidance still waiting for it never reached
                    // a steerable point. Refusing it here is what keeps `queued: true` honest -
                    // without this drain the receipt would hang until the lane was reclaimed.
                    settleSteers(lane, raw.turnId, 'The turn ended before the guidance reached a steerable point.');

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
                        ...(raw.invocationId === undefined ? {} : { invocationId: raw.invocationId }),
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
                        // T10 finding M6: a fault ends a turn ONLY when it names that turn. A
                        // mismatched id belongs to a turn that already settled (the retired path
                        // cleared the live turn on arrival, so a late frame from an old worker
                        // silently destroyed the next turn's record).
                        if (raw.turnId !== undefined && raw.turnId !== turn.turnId) return;

                        // An UNNAMED fault arrived while a turn is live, so it came from the
                        // frame layer (a payload that cannot transfer, an unknown command). The
                        // worker is not trustworthy after that: close it, which settles this turn
                        // as a failure and retires the epoch, instead of reporting one failure and
                        // leaving a broken worker to answer the next turn.
                        if (raw.turnId === undefined) {
                            closeWorker(lane, raw.message);

                            return;
                        }

                        lane.turn = undefined;
                        lane.busy = false;
                        lane.onEvent = undefined;
                        // T12: the run ended in a fault, so a guidance still waiting on it is
                        // refused with the same sentence rather than left hanging.
                        settleSteers(lane, raw.turnId, `The turn failed before the guidance reached a steerable point (${raw.message}).`);
                        turn.resolve({ failure: raw.message, cancelled: false });
                        armIdle(lane);

                        return;
                    }

                    settleReady(new ServerRuntimeError(`The lane worker reported a fault: ${raw.message}`));
                    closeWorker(lane, raw.message);

                    return;
                }

                // T10 finding M6: the answer to a `steer` frame, and explicitly NOT terminal.
                // A run that is not at a steerable point refuses the guidance; the turn keeps
                // executing, which is exactly what the client was told inline.
                //
                // T12 closed the integration hook this note listed: `steer()` below now awaits
                // this frame, so ../sessions.ts reports the lane's own answer instead of the
                // optimistic `queued: true` the POST alone used to produce.
                case 'steer.result': {
                    answerSteer(lane, raw.turnId, {
                        queued: raw.queued,
                        ...(raw.reason === undefined ? {} : { reason: raw.reason })
                    });

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
                // ONE canonical read for both halves of the base the lane is about to write
                // against: the length it appends at, and (T4.1) the content digest that lets an
                // IN-PLACE canonical change — a host transcript edit, a sibling's committed patch
                // — be seen at the same length instead of running the turn on a stale context.
                const head = request.authority.canonicalHeadOf(lane.targetId ?? canonicalTargetId(request.target));

                post(lane, {
                    kind: 'turn',
                    laneEpoch: lane.epoch,
                    turnId: request.turnId,
                    target: request.target,
                    prompt: request.prompt,
                    fromLength: head.length,
                    fromDigest: head.digest,
                    ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
                    ...(request.reset === undefined ? {} : { reset: request.reset })
                });
            } catch (error) {
                reject(error as Error);
            }
        });

        lane.busy = false;
        lane.onEvent = undefined;

        // Settle the mirror. The roster's invocation id is the one the LANE archived its result
        // under, reported on the terminal frame; the thread id is only the fallback for a run
        // that published nothing (T10 finding M3: the core mints a fresh numeric invocation per
        // thread turn, so inventing `thread-N` here joins the roster to a result that does not
        // exist, and `agentResult` cannot find the turn the UI is pointing at).
        if (lane.targetId !== undefined) {
            mirrorThreadStatus(
                request.authority,
                lane.targetId,
                'idle',
                result.invocationId ?? (request.target.kind === 'thread' ? request.target.threadId : undefined)
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

    // T12: AWAITED. The POST alone only proves the frame left this process, so the retired
    // `return true` reported a guidance as queued on a run that had already refused it (T10
    // finding M6's integration hook). `undefined` is a different answer from a refusal: there is
    // no live lane, so the caller must answer from the canonical harness (the inline behaviour
    // when a run has ended), and it must not be re-asked once the owning lane has spoken.
    const steer = async (sessionKey: string, target: LaneTarget, input: string): Promise<LaneSteerReceipt | undefined> => {
        const lane = lanes.get(laneKeyOf(sessionKey, target));

        if (lane === undefined || lane.closed || lane.turn === undefined) return undefined;

        const turnId = lane.turn.turnId;
        let resolveReceipt!: (receipt: LaneSteerReceipt) => void;
        const receipt = new Promise<LaneSteerReceipt>((resolve) => {
            resolveReceipt = resolve;
        });
        const waiter: SteerWaiter = { resolve: resolveReceipt, active: true };

        // Registered BEFORE the frame is posted: the worker's answer is another message on this
        // same port, and a reply processed before the waiter existed would find nobody.
        const waiters = lane.steers.get(turnId) ?? [];

        waiters.push(waiter);
        lane.steers.set(turnId, waiters);

        try {
            post(lane, { kind: 'steer', laneEpoch: lane.epoch, turnId, input });
        } catch (error) {
            // The frame never left (a payload that cannot transfer, a channel that died between
            // the check and the post). Nothing can answer, so refuse now with the reason.
            waiter.active = false;
            waiter.resolve({ queued: false, reason: `The lane could not accept the guidance (${(error as Error).message}).` });
            if (!waiters.some((entry) => entry.active)) lane.steers.delete(turnId);
        }

        return receipt;
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

        // T10 finding M8: shutdown goes through `closeWorker`, the same teardown an idle reclaim
        // or a crash uses. It settles the lane's open turn and every pending invocation, marks
        // the epoch retired, and returns the terminate() promise; the retired path set
        // `closed = true` by hand and awaited terminate() alone, so a turn that was in flight
        // when the server stopped was never resolved and its caller hung.
        await Promise.all(live.map((lane) => closeWorker(lane, reason ?? 'server shutdown')));

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
