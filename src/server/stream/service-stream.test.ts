// Real @underload/service evidence for the update stream: the gateway-owned listener must complete a
// genuine `101` upgrade for `GET /v1/harness/stream` on the SAME host and port that answers REST.
//
// Why a child process: the service loader imports endpoint modules with
// `import(pathToFileURL(filePath).href)`. Under Vitest that is Node's native loader, which cannot
// evaluate `.ts`; `vite-node` is the production path that can (the same reasoning
// `src/server/service-start.test.ts` documents). The child therefore runs the REAL `startServer`,
// which scans the REAL `src/server/endpoint/harness/` folder — including `service-route-stream.ts`,
// the module that declares both the JSON handler and the `upgrade` hook this suite exercises.
//
// What is proven here and what is not:
//   PROVEN: the loader's new upgrade tier reaches an endpoint-declared `upgrade`, the handshake and
//   subprotocol negotiation work through a third-party client, the broker lives in the root-keyed
//   runtime the gateway already uses, and the loader's `body: 'raw'` mode enforces the route cap
//   instead of pre-buffering (the 413 case) while normal REST keeps working.
//   NOT PROVEN (and asserted as the interim contract instead): `unknown_resource` for a session id
//   the store does not know. The store owner (T13) has not exposed `streamExists`/`hasSession` yet,
//   so `src/server/stream/mount.ts` accepts the id rather than guessing — the expectation below
//   states that, and will move to `unknown_resource` the moment the callback lands.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_WS_SUBPROTOCOL, HARNESS_ROUTES } from '../../shared/harness-api';
import type { TaskReceipt } from '../../shared/harness-api';
import { HARNESS_WS_STREAM_PATH } from './protocol';

// src/server/stream/ -> package root is three levels up.
const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');
const WORK_DIR = path.join(TEMP_ROOT, `harness-stream-service-${process.pid}-${Date.now()}`);
const DATABASE_ROOT = path.join(WORK_DIR, 'database');

// The stream only exists inside the noobscript workspace (the harness package is also published
// standalone), so the suite skips itself when the sibling service package is absent.
const SERVICE_START = path.join(REPO_ROOT, 'packages/underload/service/src/server/start.ts');
const HAS_SERVICE = fs.existsSync(SERVICE_START);
const describeService = HAS_SERVICE ? describe : describe.skip;

const DRIVER = `// Scratch driver written by src/server/stream/service-stream.test.ts.
// Boots the REAL service loader over the REAL harness endpoint folder on port 0.
import http from 'node:http';
import { startServer } from '../../packages/underload/service/src/server/start';
import { createHarnessRegistry } from '../../packages/underload/harness/src/server/harnesses';
import { PRODUCTION_WITH_FIXTURES } from '../../packages/underload/harness/src/server/harnesses/fixture-presets.test-support';
import { createHarnessRuntime, setHarnessRuntime } from '../../packages/underload/harness/src/server/runtime';

const target = http.Server.prototype;
const originalListen = target.listen;

// Port 0 is what keeps startServer from calling killPort; the bound port is reported from the
// listen callback, so this test can never kill another process.
target.listen = function (...args) {
    const callback = args[args.length - 1];

    if (typeof callback === 'function') {
        args[args.length - 1] = function () {
            const address = this.address();
            if (address !== null && typeof address === 'object') {
                console.log('HARNESS_STREAM_SERVICE_PORT=' + address.port);
            }
            return callback.call(this);
        };
    }

    return originalListen.apply(this, args);
};

// The shipped production presets are five real roles, none of which run without a provider, and the
// live-frames test below has to finish a scripted run offline. Pre-seeding the ROOT-KEYED runtime
// (exactly what src/server/service-start.test.ts does) is the explicit opt-in to the fixtures, and it
// also proves the stream and the routes share the one runtime the discovered module resolves: the
// hub, the broker, and the epoch are the ones THIS call built.
const serviceRoot = process.env.HARNESS_SERVICE_DATABASE_ROOT;
setHarnessRuntime(
    createHarnessRuntime({
        ...(serviceRoot === undefined ? {} : { root: serviceRoot }),
        registry: createHarnessRegistry(PRODUCTION_WITH_FIXTURES)
    }),
    serviceRoot
);

const server = await startServer({
    root: process.env.HARNESS_SERVICE_SCAN_ROOT,
    port: 0,
    host: '127.0.0.1',
    variables: { root: process.env.HARNESS_SERVICE_DATABASE_ROOT }
});

console.log('HARNESS_STREAM_SERVICE_READY');

const shutdown = () => {
    void server.close().then(
        () => process.exit(0),
        () => process.exit(1)
    );
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

type Child = ReturnType<typeof spawn>;

let child: Child;
let base = '';
let wsBase = '';
let output = '';
let errors = '';

const waitFor = (pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray> =>
    new Promise<RegExpMatchArray>((resolve, reject) => {
        const started = Date.now();

        const inspect = (): void => {
            const match = output.match(pattern);
            if (match !== null) {
                clearInterval(poll);
                resolve(match);
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(poll);
                reject(new Error(`Timed out waiting for ${pattern}. stdout:\n${output}\nstderr:\n${errors}`));
            }
        };

        const poll = setInterval(inspect, 50);
        inspect();
    });

beforeAll(async () => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORK_DIR, 'driver.ts'), DRIVER, 'utf8');

    child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, 'node_modules', 'vite-node', 'dist', 'cli.mjs'), path.join(WORK_DIR, 'driver.ts')],
        {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                HARNESS_SERVICE_SCAN_ROOT: PACKAGE_ROOT,
                HARNESS_SERVICE_DATABASE_ROOT: DATABASE_ROOT,
                TEMP: TEMP_ROOT,
                TMP: TEMP_ROOT,
                TMPDIR: TEMP_ROOT
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
        errors += chunk.toString('utf8');
    });

    const [, port] = await waitFor(/HARNESS_STREAM_SERVICE_PORT=(\d+)/, 30_000);
    await waitFor(/HARNESS_STREAM_SERVICE_READY/, 30_000);

    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
}, 60_000);

afterAll(() => {
    if (child !== undefined && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        void Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }

    fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

type Frame = Record<string, unknown> & { type: string };

const openStream = async (): Promise<{ socket: WebSocket; frames: Frame[]; closes: number[]; send: (frame: unknown) => void }> => {
    const socket = new WebSocket(`${wsBase}${HARNESS_WS_STREAM_PATH}`, HARNESS_WS_SUBPROTOCOL);
    const frames: Frame[] = [];
    const closes: number[] = [];

    socket.addEventListener('message', (event) => frames.push(JSON.parse(String((event as MessageEvent).data)) as Frame));
    socket.addEventListener('close', (event) => closes.push((event as CloseEvent).code));

    await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error(`stream handshake failed:\n${output}\n${errors}`)), { once: true });
    });

    return {
        socket,
        frames,
        closes,
        send: (frame) => socket.send(JSON.stringify(frame))
    };
};

// Bounded wait used for every "eventually true" claim in this file. The predicate may be async so
// the same helper drives a socket-frame check (sync over the recorded frames) AND a REST read
// (the settle check below), instead of a second, drifting timing constant per seam.
//
// The final predicate evaluation is returned rather than `false`, so a caller that times out still
// sees the last real observation; the bound is what makes the wait deterministic, not the sleep.
const poll = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return predicate();
};

// One REST read against the gateway, parsed once. Kept as a helper because the settle loop below
// reads the same document repeatedly and a non-200 must be visible as a status, not as a crash.
const readSessionRow = async (
    sessionId: string
): Promise<{ status: number; session?: { status?: string } }> => {
    const response = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId(sessionId)}`);

    return { status: response.status, ...((await response.json()) as { session?: { status?: string } }) };
};

const readTurnStatus = async (sessionId: string, turnId: string): Promise<{ status: number; turn?: { status?: string } }> => {
    const response = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(sessionId, turnId)}`);

    return { status: response.status, ...((await response.json()) as { turn?: { status?: string } }) };
};

// Index of the pane-unsubscribe barrier pong in the recorded frames, or -1 while it has not landed.
// `frames` only ever grows (the socket listener appends, nothing removes), so an index found here stays
// valid for the rest of the test, which is what lets the reader claim below sample at the very end.
const paneBarrierIndex = (frames: Frame[], at: number): number =>
    frames.findIndex((frame) => frame.type === 'pong' && (frame as Frame).at === at);

describeService('gateway-mounted update stream', () => {
    it('upgrades on the gateway port and welcomes with the runtime epoch', async () => {
        const client = await openStream();

        expect(client.socket.protocol).toBe(HARNESS_WS_SUBPROTOCOL);
        expect(await poll(() => client.frames.length > 0)).toBe(true);

        const welcome = client.frames[0];

        expect(welcome.type).toBe('welcome');
        expect(welcome.protocol).toBe(HARNESS_WS_SUBPROTOCOL);
        expect((welcome.limits as { replay_frames: number }).replay_frames).toBe(512);

        // THE cross-transport consistency check, against the real gateway: the epoch the WebSocket
        // `welcome` carries must be the epoch the REST health document (and every `X-Harness-Epoch`
        // header) carries. Two processes would get this wrong; one runtime object cannot.
        const health = await fetch(`${base}/v1/harness/health`);
        const info = (await health.json()) as { epoch?: string };

        expect(typeof info.epoch).toBe('string');
        expect(welcome.epoch).toBe(info.epoch);

        client.send({ type: 'bye' });
        expect(await poll(() => client.closes.length > 0)).toBe(true);
        expect(client.closes[0]).toBe(1000);
    });

    it('registers a global subscription against the mounted runtime and answers pong', async () => {
        const client = await openStream();
        await poll(() => client.frames.length > 0);

        client.send({ type: 'subscribe', subscription_id: 'g', scope: 'global' });
        expect(await poll(() => client.frames.some((frame) => frame.type === 'subscription_state'))).toBe(true);

        const state = client.frames.find((frame) => frame.type === 'subscription_state') as Frame;
        const welcome = client.frames[0] as Frame;

        expect({
            subscription_id: state.subscription_id,
            scope: state.scope,
            epoch: state.epoch,
            sequence: state.sequence,
            // The global baseline is exactly the four host-wide counters from the contract.
            resources: (state.revisions as { resource: string }[]).map((record) => record.resource)
        }).toEqual({
            subscription_id: 'g',
            scope: 'global',
            epoch: welcome.epoch,
            sequence: 0,
            resources: ['harnesses', 'agents', 'tools', 'config']
        });

        client.send({ type: 'ping', at: 1762250003000 });
        expect(await poll(() => client.frames.some((frame) => frame.type === 'pong'))).toBe(true);
        expect(client.frames.find((frame) => frame.type === 'pong')).toEqual({ type: 'pong', at: 1762250003000 });

        client.send({ type: 'bye' });
        await poll(() => client.closes.length > 0);
    });

    it('refuses a session the store does not know with unknown_resource', async () => {
        const client = await openStream();
        await poll(() => client.frames.length > 0);

        client.send({ type: 'subscribe', subscription_id: 's', scope: 'session', session_id: 'not-a-real-session' });
        expect(await poll(() => client.frames.some((frame) => frame.type !== 'welcome'))).toBe(true);

        const answer = client.frames.find((frame) => frame.type === 'subscription_state' || frame.type === 'error') as Frame;

        // T16 wired `store.streamExists`, so the store-backed existence check is live on the GATEWAY
        // mount: a stale id is refused for THAT subscription with `unknown_resource`, the connection
        // stays open for the others, and no snapshot is ever sent. This replaces the interim
        // "accept the id" behavior the bridge carried while the callback was missing.
        expect(answer).toEqual({
            type: 'error',
            code: 'unknown_resource',
            message: 'No session matches not-a-real-session.',
            subscription_id: 's',
            retryable: false
        });

        client.send({ type: 'bye' });
        await poll(() => client.closes.length > 0);
    });

    it('delivers real REST create+submit frames over the socket, with no broker.publish in the test', async () => {
        // THE integration proof T15 could not claim before the hub landed: the only writes this test
        // performs are REST writes through the real loader, and the frames below must arrive because
        // the store published into the shared hub and `bridgeEventHub` fanned that out. If any part of
        // that chain is missing, the socket goes quiet — and nothing here papers over it.
        const created = await fetch(`${base}${HARNESS_ROUTES.sessions()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });
        expect(created.status).toBe(201);
        const session = (await created.json() as { session: { id: string } }).session;

        const client = await openStream();
        await poll(() => client.frames.length > 0);

        client.send({ type: 'subscribe', subscription_id: 'live', scope: 'session', session_id: session.id });
        expect(await poll(() => client.frames.some((frame) => frame.type === 'subscription_state'))).toBe(true);

        const state = client.frames.find((frame) => frame.type === 'subscription_state') as Frame;
        expect(state.sequence).toBe(0);

        const submitted = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTasks(session.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: 'What time is it?' })
        });
        expect(submitted.status).toBe(202);
        const receipt = (await submitted.json()) as TaskReceipt;

        // A live `turn.upsert` must reach the session subscription: this is the frame the UI's row
        // patch consumes, and it is the reason `store.watchView` is never used to bootstrap. Asserted
        // as a membership check so a failure prints the frames that DID arrive.
        await poll(() => client.frames.some((frame) => frame.type === 'update'), 8_000);

        expect(client.frames.map((frame) => (frame.type === 'update' ? `update:${(frame as Frame).kind}` : frame.type))).toEqual(
            expect.arrayContaining(['welcome', 'subscription_state', 'update:turn.upsert'])
        );
        const upsert = client.frames.find(
            (frame) => frame.type === 'update' && (frame as Frame).kind === 'turn.upsert'
        ) as Frame;

        expect({
            subscription_id: upsert.subscription_id,
            turn_id: (upsert.turn as { id: string }).id,
            sequence_above_state: (upsert.sequence as number) > (state.sequence as number)
        }).toEqual({
            subscription_id: 'live',
            turn_id: receipt.turn_id,
            sequence_above_state: true
        });

        // T18's finding, now RESOLVED and stated as the rule rather than as an open gap:
        // `display.ops` is a TURN-scope kind (`HARNESS_WS_SCOPE_PUBLISHES` in ./protocol.ts - a
        // `session` subscription publishes session/turn/action/usage/thread/registry/run kinds, a
        // `turn` subscription publishes display.ops/usage.updated/turn.upsert). So its absence on
        // THIS subscription is contract routing (`isKindPublishedTo`), not a publishing failure,
        // and the positive form is asserted on the same live run below.
        const kinds = client.frames.map((frame) => (frame.type === 'update' ? `update:${(frame as Frame).kind}` : frame.type));

        expect(kinds).toEqual(expect.arrayContaining(['welcome', 'subscription_state', 'update:turn.upsert']));
        expect(kinds).not.toContain('update:display.ops');

        // ------------------------------------------------------------------
        // THE POSITIVE PROOF over the REAL socket: subscribe the same turn at turn scope and the
        // bounded ops frames arrive, with non-empty op lists and the three turn counters equal in
        // the baseline (the contract defines display/event revisions to equal the turn's).
        //
        // Timing, honestly: the pane is registered as soon as the receipt arrives. A scripted run
        // can settle before that round-trip lands, and a subscription that never existed has no
        // replay window, so a second run is driven and the pane is registered in the same tick the
        // receipt is read. Ops are still published per event group either way; what changes is only
        // WHICH run delivers them.
        // ------------------------------------------------------------------
        const openPane = async (subscriptionId: string, turnId: string): Promise<Frame[]> => {
            client.send({
                type: 'subscribe',
                subscription_id: subscriptionId,
                scope: 'turn',
                session_id: session.id,
                turn_id: turnId,
                pace: 'ordered'
            });

            const stateArrived = await poll(
                () => client.frames.some((frame) => frame.type === 'subscription_state' && (frame as Frame).subscription_id === subscriptionId),
                8_000
            );

            expect(stateArrived).toBe(true);

            const state = client.frames.find(
                (frame) => frame.type === 'subscription_state' && (frame as Frame).subscription_id === subscriptionId
            ) as Frame;

            // One baseline per turn-scope kind, and the display/event figures EQUAL the turn's.
            expect((state.revisions as Frame[]).map((record) => record.resource)).toEqual(['turn', 'turn_display', 'turn_events']);
            expect(new Set((state.revisions as Frame[]).map((record) => record.revision)).size).toBe(1);

            const arrived = await poll(
                () =>
                    client.frames.some(
                        (frame) =>
                            frame.type === 'update' &&
                            (frame as Frame).kind === 'display.ops' &&
                            (frame as Frame).subscription_id === subscriptionId
                    ),
                8_000
            );

            if (!arrived) return [];

            return client.frames.filter(
                (frame) =>
                    frame.type === 'update' &&
                    (frame as Frame).kind === 'display.ops' &&
                    (frame as Frame).subscription_id === subscriptionId
            ) as Frame[];
        };

        let secondTurnId = '';
        let opsFrames = await openPane('pane', receipt.turn_id);

        if (opsFrames.length === 0) {
            const second = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTasks(session.id)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ input: 'Tell me twice.' })
            });
            expect(second.status).toBe(202);
            const secondReceipt = (await second.json()) as TaskReceipt;

            secondTurnId = secondReceipt.turn_id;
            opsFrames = await openPane('pane2', secondReceipt.turn_id);
        }

        expect(opsFrames.length).toBeGreaterThan(0);

        // Every frame addresses ONE turn, and it is the turn the pane subscribed to.
        const addressed = new Set(opsFrames.map((frame) => frame.turn_id as string));

        expect(addressed.size).toBe(1);

        const paneTurnId = opsFrames[0].turn_id as string;

        expect(paneTurnId === receipt.turn_id || paneTurnId === secondTurnId).toBe(true);

        for (const frame of opsFrames) {
            expect(Array.isArray(frame.ops)).toBe(true);
            expect((frame.ops as unknown[]).length).toBeGreaterThan(0);
            expect((frame.ops as Record<string, unknown>[]).every((op) => typeof op.op === 'string')).toBe(true);
            // Bounded frame: ops only, never a compiled view. The byte bound is what makes a
            // regression to a whole display document fail here.
            expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThan(4_096);
        }

        // Disconnect the pane mid-flight and prove the stream is a READER: nothing is delivered to a
        // subscription that no longer exists, and the run still finishes on its own.
        //
        // ------------------------------------------------------------------
        // WHY A CAUSAL BARRIER REPLACES THE 250ms SLEEP (F11).
        //
        // The old shape sampled `paneFramesAtDisconnect` at the instant `socket.send` was CALLED, then
        // slept 250ms and demanded the count be identical. `send` is not synchronous with the wire
        // (src/server/stream/transport.ts:288-305 writes straight through only when the queue is empty,
        // otherwise appends), so every `display.ops` frame the broker had already handed to the socket
        // when the sample was taken is still in flight and lands AFTER the sample. The assertion was
        // therefore a wall-clock race, not a contract check: under turbo's full-graph load the in-flight
        // window grew past 250ms and the count read `3` where the contract produced `2`
        // (Temp/plan-v1/logs/harness-test-run3.log:986 `expected 3 to be 2`).
        //
        // "The server stopped pushing to the dead pane" is a CAUSAL end state, and the protocol already
        // supplies the barrier for it. Quoted from the production side:
        //   - `unsubscribe` removes the subscription synchronously: broker.ts:815-817
        //     `session.subscriptions.delete(subscriptionId); closeSubscription(subscription);`, and
        //     `closeSubscription` sets `subscription.closed = true` (broker.ts:634-640). Fan-out at
        //     broker.ts:611-625 iterates `session.subscriptions` and does `if (subscription.closed)
        //     continue`, so once the unsubscribe has been processed NO pane frame can be minted
        //     afterwards, and one thread means no `deliver` can be interleaved inside the handler.
        //   - `ping` is answered inside the same inbound tick: connection.ts:331-334
        //     `case 'ping': send({ type: 'pong', at: frame.at ?? clock() })`, and inbound frames are
        //     dispatched in wire order (transport.ts:531 `socket.on('data')` -> `consume()` ->
        //     `handleFrame` -> the synchronous `messageListeners` registered at transport.ts:583-585).
        //     So a pong proves the server has already processed the frame sent before it - the unsubscribe.
        //   - outbound order equals the order of the `socket.send` CALLS: transport.ts:297-304 writes
        //     directly only when `!draining && pending.length === 0` and otherwise appends to the tail,
        //     and `flush` (transport.ts:254-265) drains FIFO. So every pane frame minted BEFORE the
        //     unsubscribe was also written before the pong, and therefore arrives before it.
        //
        // Pane frames before the pong are contract-legal in-flight traffic. Pane frames after it are
        // the defect the claim is about, and the window now covers the whole rest of the run.
        // ------------------------------------------------------------------
        client.send({ type: 'unsubscribe', subscription_id: 'pane' });

        // A value this test invented, so the pong is unambiguously the echo of THIS ping: the server's
        // own keepalive is a `heartbeat` frame (connection.ts:370), never a `pong`, and this socket has
        // sent no other ping. Same echo contract the pong case above pins (`toEqual({ type, at })`).
        const paneBarrierAt = 1762250009000;

        client.send({ type: 'ping', at: paneBarrierAt });

        // Bounded, and the bound is a FAILURE rather than a pass-through: a missing pong means the
        // socket stopped answering, and the reader check below would then be measuring silence.
        const barrierArrived = await poll(() => paneBarrierIndex(client.frames, paneBarrierAt) !== -1, 8_000);

        expect({
            pong_arrived: barrierArrived,
            // On a timeout this prints the whole conversation, which is how a dead socket is told apart
            // from a lost ping.
            frame_types: client.frames.map((frame) => frame.type)
        }).toEqual({ pong_arrived: true, frame_types: expect.arrayContaining(['pong']) });

        const barrierIndex = paneBarrierIndex(client.frames, paneBarrierAt);

        // The pong echoes verbatim (connection.ts:333), which is what makes it usable as an ordering
        // marker; full-object equality also pins that no other field rides along on it.
        expect(client.frames[barrierIndex]).toEqual({ type: 'pong', at: paneBarrierAt });

        // Everything the pane will ever receive has arrived by the time its pong is delivered, so the
        // baseline is sampled AT the barrier rather than at an arbitrary point before it.
        const paneFramesAtBarrier = client.frames.filter(
            (frame, index) => index <= barrierIndex && (frame as Frame).subscription_id === 'pane'
        ).length;

        // Deterministic settle, replacing the fixed sleep that used to read the row here: the scripted
        // run is still in flight the instant the pane unsubscribes (a 250ms wait observed `running`),
        // so `idle` is an EVENTUAL state of the store, reached when the run's last event is applied.
        // Poll the real REST read until it leaves `running`, bounded.
        //
        // If it never leaves `running`, the assertion below fails with the transition trail printed:
        // that is a real store bug (a run that cannot settle) and it stays a failure - it must not be
        // weakened into "any status" or into a longer sleep.
        const statusTrail: string[] = [];

        const settledIdle = await poll(async () => {
            const row = await readSessionRow(session.id);

            // Only transitions are recorded, so a stuck row prints `["running"]` instead of 600 lines.
            if (statusTrail[statusTrail.length - 1] !== row.session?.status) statusTrail.push(String(row.session?.status));

            return row.session?.status === 'idle';
        }, 15_000);

        const settledSession = await readSessionRow(session.id);

        expect({
            settled_idle: settledIdle,
            read_status: settledSession.status,
            session_status: settledSession.session?.status,
            // A reader that cancelled the run would drive the row to `error`; the trail would also
            // never end on `idle` unless the store settled it.
            trail: statusTrail
        }).toEqual({
            settled_idle: true,
            read_status: 200,
            session_status: 'idle',
            trail: expect.arrayContaining(['idle'])
        });

        // THE non-cancel proof, read from the store instead of inferred from a sleep: the session row
        // returns to `idle` after a cancel too (see src/server/api-live-events.test.ts:610-640), so
        // `idle` alone cannot separate "the run finished" from "unsubscribing the pane cancelled it".
        // The cancel marker is the TURN status, so every turn this test drove must be `done` - not
        // `cancelled`, not `error`, not still `running`.
        const drivenTurnIds = secondTurnId === '' ? [receipt.turn_id] : [receipt.turn_id, secondTurnId];
        const turnReads = await Promise.all(drivenTurnIds.map(async (turnId) => await readTurnStatus(session.id, turnId)));

        expect(turnReads.map((read) => [read.status, read.turn?.status])).toEqual(drivenTurnIds.map(() => [200, 'done']));

        // THE READER CLAIM, asserted here rather than 250ms after the `send`: from the barrier up to
        // this line the run kept publishing (the settle poll above watched it leave `running` and reach
        // `idle`, and every turn this test drove reached `done`), so the dead pane had the whole
        // remainder of the run to be pushed to and must have stayed silent for all of it.
        const latePaneFrames = client.frames.filter(
            (frame, index) => index > barrierIndex && (frame as Frame).subscription_id === 'pane'
        ) as Frame[];

        expect({
            // Anti-vacuity 1: the pane really had a baseline BEFORE the cut (`openPane` pins its
            // `subscription_state`), so "nothing after the barrier" is not satisfied by a pane that
            // never existed.
            pane_at_barrier_min_1: paneFramesAtBarrier >= 1,
            pane_frames_after_barrier: latePaneFrames.length,
            late_frames: latePaneFrames.map((frame) => (frame.kind as string) ?? frame.type),
            // Anti-vacuity 2: the socket was still open for the whole window, so the silence is the
            // broker refusing a closed subscription and not a dropped connection.
            socket_closed: client.closes.length > 0
        }).toEqual({
            pane_at_barrier_min_1: true,
            pane_frames_after_barrier: 0,
            late_frames: [],
            socket_closed: false
        });

        // Monotonic sequences are PER SUBSCRIPTION: each live subscription numbers its own frames
        // 1..n, so the check runs per id rather than over a merged list.
        const subscriptionIds = new Set(
            client.frames.filter((frame) => frame.type === 'update').map((frame) => (frame as Frame).subscription_id as string)
        );

        expect(subscriptionIds.size).toBeGreaterThanOrEqual(1);

        for (const subscriptionId of subscriptionIds) {
            const updates = client.frames.filter(
                (frame) => frame.type === 'update' && (frame as Frame).subscription_id === subscriptionId
            ) as Frame[];

            expect(updates.map((frame) => frame.sequence as number)).toEqual(
                updates.map((_frame, position) => position + 1)
            );
        }

        const updates = client.frames.filter((frame) => frame.type === 'update') as Frame[];
        expect(updates.every((frame) => typeof frame.kind === 'string' && frame.kind.length > 0)).toBe(true);

        // Reconciliation contract: the receipt's session revision is the counter value a client
        // compares this subscription's records against, and the epoch on the socket is the epoch on the
        // REST headers (asserted above) — so a read issued after `subscription_state` wins over any
        // frame at or below its sequence.
        expect(receipt.session_revision).toBeGreaterThanOrEqual(1);

        client.send({ type: 'bye' });
        await poll(() => client.closes.length > 0);
    }, 60_000);

    it('answers 400 for a plain HTTP GET on the stream path, through the real loader pipeline', async () => {
        const response = await fetch(`${base}${HARNESS_WS_STREAM_PATH}`);
        const body = (await response.json()) as { error?: { message?: string } };

        expect(response.status).toBe(400);
        expect(body.error?.message).toContain('WebSocket upgrade');
    });

    it('enforces the route body cap while streaming (loader body: raw) and leaves REST working', async () => {
        const health = await fetch(`${base}/v1/harness/health`);
        expect(health.status).toBe(200);

        // 1 MB is the cap for a non-submit route. Over it must be 413 — and that only happens if the
        // loader skipped its own pre-parse, because the pre-parse would accept the body first.
        const oversized = await fetch(`${base}/v1/harness/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: 'x'.repeat(1_000_001) })
        });

        expect(oversized.status).toBe(413);
        const rejected = (await oversized.json()) as { error?: { message?: string } };
        expect(rejected.error?.message).toContain('1000000');

        // Under the cap, the raw reader parses and the dispatcher answers on its own merits.
        const accepted = await fetch(`${base}/v1/harness/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        expect(accepted.status).not.toBe(413);

        const missingUpgrade = await fetch(`${base}/v1/harness/config`, {
            method: 'GET'
        });
        expect(missingUpgrade.status).toBe(200);
    });
});
