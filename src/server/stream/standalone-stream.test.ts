// Standalone-listener evidence for T15: `startHarnessServer` must serve the update stream on the
// SAME port as the REST mount, publish to it from the process, and tear it down honestly.
//
// This is the second of the two "real upgrade" hosts. The gateway-mounted one is
// ./service-stream.test.ts (a real `@underload/service` child process); this one is the standalone
// Node listener every `yarn dev:server` run uses. Both are real sockets — no mocked upgrade.
//
// The mount constant still comes from ./api.ts (the REST owner's file). The stream path is DERIVED
// from it (`${STANDALONE_MOUNT}/stream`) rather than hard-coded, so the assertions below stay true
// when the owner repoints `STANDALONE_MOUNT` at `HARNESS_API_ROOT`, and they document the one
// integration left to that owner: REST and WS must sit under the same root.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_WS_SUBPROTOCOL } from '../../shared/harness-api';
import { createHarnessRegistry } from '../harnesses';
import { PRODUCTION_WITH_FIXTURES } from '../harnesses/fixture-presets.test-support';
import { STANDALONE_MOUNT } from '../api';
// The shared epoch/revision hub (REST owner): the stream must report THIS epoch, not its own.
import { HARNESS_RUNTIME_EPOCH } from '../api-events';
import { startHarnessServer, type HarnessServer } from '../start';

let server: HarnessServer;
let streamPath = '';

const streamUrl = (): string => `${server.url.replace(/^http/, 'ws')}${streamPath}`;
const httpUrl = (): string => `${server.url}${streamPath}`;

beforeAll(async () => {
    server = await startHarnessServer({
        port: 0,
        staticRoot: null,
        registry: createHarnessRegistry(PRODUCTION_WITH_FIXTURES)
    });

    streamPath = server.stream.path;
}, 30_000);

afterAll(async () => {
    // The last test already closed the listener; a second close must not fail the suite.
    try {
        if (server !== undefined) await server.close();
    } catch {
        // Already closed.
    }
});

type Frame = Record<string, unknown> & { type: string };

const connect = async (): Promise<{ socket: WebSocket; frames: Frame[]; closes: number[]; send: (frame: unknown) => void }> => {
    const socket = new WebSocket(streamUrl(), HARNESS_WS_SUBPROTOCOL);
    const frames: Frame[] = [];
    const closes: number[] = [];

    socket.addEventListener('message', (event) => frames.push(JSON.parse(String((event as MessageEvent).data)) as Frame));
    socket.addEventListener('close', (event) => closes.push((event as CloseEvent).code));

    await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('standalone stream handshake failed')));
    });

    return { socket, frames, closes, send: (frame) => socket.send(JSON.stringify(frame)) };
};

const poll = async (predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    return predicate();
};

describe('standalone update stream', () => {
    it('mounts the stream under the same root as REST, on the same port', () => {
        expect(streamPath).toBe(`${STANDALONE_MOUNT}/stream`);

        // One listener: the stream URL is the REST URL with the scheme swapped, so no second port and
        // no second root exist to drift apart.
        expect(streamUrl()).toBe(`${server.url.replace('http://', 'ws://')}${streamPath}`);
    });

    it('welcomes with the listener epoch, and a REST-side publish reaches the client', async () => {
        const client = await connect();

        expect(await poll(() => client.frames.length > 0)).toBe(true);

        const welcome = client.frames[0];
        const epoch = server.stream.broker.epoch();

        expect({ protocol: welcome.protocol, epoch: welcome.epoch }).toEqual({ protocol: HARNESS_WS_SUBPROTOCOL, epoch });
        expect((welcome.limits as { max_server_frame_bytes: number }).max_server_frame_bytes).toBe(65_536);

        client.send({ type: 'subscribe', subscription_id: 'g', scope: 'global' });
        expect(await poll(() => client.frames.some((frame) => frame.type === 'subscription_state'))).toBe(true);

        // The publish path the REST owner wires: a broker call inside THIS process lands on the wire
        // in order, with the sequence and cursor the client resumes from.
        server.stream.broker.publish({ kind: 'config.updated', payload: {} });

        expect(await poll(() => client.frames.some((frame) => frame.type === 'update'))).toBe(true);

        const update = client.frames.find((frame) => frame.type === 'update') as Frame;

        expect({ kind: update.kind, sequence: update.sequence, subscription_id: update.subscription_id }).toEqual({
            kind: 'config.updated',
            sequence: 1,
            subscription_id: 'g'
        });

        // One runtime object, two transports: the epoch `welcome` carries IS the epoch the REST
        // headers carry, and both are the process epoch from the shared hub.
        expect(epoch).toBe(HARNESS_RUNTIME_EPOCH);
        expect(server.events.epoch).toBe(epoch);

        client.send({ type: 'bye' });
        expect(await poll(() => client.closes.length > 0)).toBe(true);
        expect(client.closes[0]).toBe(1000);
    });

    it('answers 400 for a non-upgrade GET on the stream path and needs no client header any more', async () => {
        const response = await fetch(httpUrl());
        expect(response.status).toBe(400);

        const body = (await response.json()) as { error?: { message?: string } };
        expect(body.error?.message).toContain('WebSocket upgrade');

        // The legacy `X-Harness-Client: ui` gate is gone: a plain curl-style GET works, which is what
        // makes the Origin policy the single access rule for REST and WS alike.
        const health = await fetch(`${server.url}${STANDALONE_MOUNT}/health`);
        expect(health.status).toBe(200);
    });

    it('closes live streams with 1001 when the listener shuts down', async () => {
        const client = await connect();
        expect(await poll(() => client.frames.length > 0)).toBe(true);

        await server.close();

        expect(await poll(() => client.closes.length > 0)).toBe(true);
        expect(client.closes[0]).toBe(1001);
    });
});
