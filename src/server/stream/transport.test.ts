// Real-socket tests for the stream transport: the `101` handshake, the frame codec, and every
// framing violation the contract assigns a close code to.
//
// Two clients are used on purpose:
//   - a hand-written RAW client (below), because only that can send an unmasked frame, a binary
//     frame, an oversize frame, or a fragmented message, and can inspect the exact response bytes;
//   - Node's own `WebSocket` (undici) for the interop case, which proves a third-party RFC 6455
//     implementation completes the handshake and parses our frames — the thing a hand-rolled
//     implementation most often gets wrong.
//
// Both run against a real `http.Server`, so the upgrade is a real `upgrade` event on a real
// listener, not a mocked socket. The REST handler on the same listener proves one port serves both.

import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HARNESS_WS_SUBPROTOCOL } from '../../shared/harness-api';
import { createHarnessStreamMount, type HarnessStreamMount } from './mount';
import { HARNESS_WS_STREAM_PATH } from './protocol';

// The RFC 6455 §1.3 GUID, spelled here rather than imported: the test's job is to verify the
// server computed the accept token the way the RFC says, so it must not reuse the server's constant.
const RFC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const acceptOf = (key: string): string => createHash('sha1').update(`${key}${RFC_GUID}`).digest('base64');

let server: http.Server;
let mount: HarnessStreamMount;
let port = 0;

beforeAll(async () => {
    mount = createHarnessStreamMount({ epoch: 'aabbccdd' });

    server = http.createServer((request, response) => {
        response.statusCode = 200;
        response.end('rest');
    });

    mount.attach(server);

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });

    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    mount.close(1001);
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
});

// ---------------------------------------------------------------------------
// The raw client
// ---------------------------------------------------------------------------

type RawFrames = { statusLine: string; headers: Record<string, string>; frames: string[]; closes: number[] };

const maskKey = Buffer.from([0x37, 0xfa, 0x21, 0x1d]);

/** Build a client frame: always masked (the wire rule), optionally fragmented/binary/unmasked. */
const buildFrame = (
    opcode: number,
    payload: string | Buffer,
    options: { fin?: boolean; mask?: boolean } = {}
): Buffer => {
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const fin = options.fin !== false;
    const masked = options.mask !== false;
    const header = Buffer.alloc(2 + (masked ? 4 : 0));

    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (masked ? 0x80 : 0) | body.length;

    if (masked) maskKey.copy(header, 2);

    const maskedBody = Buffer.from(body);

    if (masked) for (let i = 0; i < maskedBody.length; i += 1) maskedBody[i] ^= maskKey[i % 4];

    return Buffer.concat([header, maskedBody]);
};

/** Read one server frame (the server never masks) and return its payload plus the opcode. */
const parseFrame = (buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | undefined => {
    if (buffer.length < 2) return undefined;

    let offset = 2;
    let length = buffer[1] & 0x7f;

    if (length === 126) {
        if (buffer.length < 4) return undefined;
        length = buffer.readUInt16BE(2);
        offset = 4;
    } else if (length === 127) {
        if (buffer.length < 10) return undefined;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }

    if (buffer.length < offset + length) return undefined;

    return {
        opcode: buffer[0] & 0x0f,
        payload: buffer.subarray(offset, offset + length),
        rest: buffer.subarray(offset + length)
    };
};

const rawConnect = (
    options: {
        path?: string;
        key?: string | null;
        version?: string;
        protocol?: string;
        origin?: string;
        upgradeHeader?: string;
        connectionHeader?: string;
    } = {}
): { socket: net.Socket; request: string; frames: string[]; closes: number[]; handshake: Promise<RawFrames> } => {
    const socket = net.connect(port, '127.0.0.1');
    const key = options.key === null ? '' : (options.key ?? 'dGhlIHNhbXBsZSBub25jZQ==');

    const lines = [`GET ${options.path ?? HARNESS_WS_STREAM_PATH} HTTP/1.1`, 'Host: 127.0.0.1'];

    lines.push(`Upgrade: ${options.upgradeHeader ?? 'websocket'}`);
    lines.push(`Connection: ${options.connectionHeader ?? 'Upgrade'}`);
    if (options.key !== null) lines.push(`Sec-WebSocket-Key: ${key}`);
    lines.push(`Sec-WebSocket-Version: ${options.version ?? '13'}`);
    if (options.protocol !== undefined) lines.push(`Sec-WebSocket-Protocol: ${options.protocol}`);
    if (options.origin !== undefined) lines.push(`Origin: ${options.origin}`);

    const request = `${lines.join('\r\n')}\r\n\r\n`;

    socket.write(request);

    // ONE listener, and the frame/close arrays are LIVE: a test awaits the status line first, then
    // polls the same arrays with `until(...)`. Two separate listeners would race for the close frame,
    // which is exactly the kind of flake a transport test must not have.
    const frames: string[] = [];
    const closes: number[] = [];
    let buffer = Buffer.alloc(0);
    let head: { statusLine: string; headers: Record<string, string> } | undefined;
    let resolveHead!: (value: RawFrames) => void;

    const handshake = new Promise<RawFrames>((resolve) => {
        resolveHead = resolve;
    });

    const drain = (): void => {
        for (;;) {
            const frame = parseFrame(buffer);
            if (frame === undefined) return;

            if (frame.opcode === 0x1) frames.push(frame.payload.toString('utf8'));
            if (frame.opcode === 0x8) closes.push(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005);

            buffer = frame.rest;
        }
    };

    socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);

        if (head === undefined) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) return;

            const text = buffer.subarray(0, end).toString('utf8');
            const [statusLine, ...headerLines] = text.split('\r\n');
            const headers: Record<string, string> = {};

            for (const line of headerLines) {
                const separator = line.indexOf(':');
                if (separator === -1) continue;
                headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
            }

            head = { statusLine, headers };
            buffer = buffer.subarray(end + 4);
            resolveHead({ statusLine, headers, frames, closes });
        }

        drain();
    });

    return { socket, request, frames, closes, handshake };
};

const waitForClose = (socket: net.Socket): Promise<void> =>
    new Promise((resolve) => {
        socket.once('close', () => resolve());
        socket.once('end', () => resolve());
    });

/** Poll the live frame list, because the 101 headers and the first frame may split across packets. */
const until = async (predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return predicate();
};

// ---------------------------------------------------------------------------

describe('the upgrade handshake', () => {
    it('answers 101 with the RFC accept token, the negotiated subprotocol, and the epoch header', async () => {
        const key = 'dGhlIHNhbXBsZSBub25jZQ==';
        const { socket, handshake } = rawConnect({ key, protocol: `${HARNESS_WS_SUBPROTOCOL}, other` });

        const response = await handshake;

        expect(response.statusLine).toBe('HTTP/1.1 101 Switching Protocols');
        expect(response.headers.upgrade).toBe('websocket');
        expect(response.headers.connection).toBe('Upgrade');
        expect(response.headers['sec-websocket-accept']).toBe(acceptOf(key));
        expect(response.headers['sec-websocket-protocol']).toBe(HARNESS_WS_SUBPROTOCOL);
        // The contract puts the epoch on the 101 so a client learns its cursors are dead before it
        // sends a single frame.
        expect(response.headers['x-harness-epoch']).toBe('aabbccdd');

        socket.destroy();
    });

    it('sends welcome as the first frame, carrying the epoch and the limits in force', async () => {
        const { socket, handshake } = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        const response = await handshake;

        expect(response.statusLine).toBe('HTTP/1.1 101 Switching Protocols');
        expect(await until(() => response.frames.length > 0)).toBe(true);

        const welcome = JSON.parse(response.frames[0]) as Record<string, unknown>;

        expect(welcome.type).toBe('welcome');
        expect(welcome.protocol).toBe(HARNESS_WS_SUBPROTOCOL);
        expect(welcome.epoch).toBe('aabbccdd');
        expect((welcome.limits as { replay_frames: number; heartbeat_interval_ms: number }).replay_frames).toBe(512);
        expect((welcome.limits as { heartbeat_interval_ms: number }).heartbeat_interval_ms).toBe(15_000);

        socket.destroy();
    });

    it('omits the subprotocol when the client offered none, instead of inventing one', async () => {
        const { socket, handshake } = rawConnect({});
        const response = await handshake;

        expect(response.statusLine).toBe('HTTP/1.1 101 Switching Protocols');
        expect(response.headers['sec-websocket-protocol']).toBeUndefined();

        socket.destroy();
    });

    it('refuses a missing Sec-WebSocket-Key with 400', async () => {
        const { socket, handshake } = rawConnect({ key: null });
        const response = await handshake;

        expect(response.statusLine).toBe('HTTP/1.1 400 Bad Request');

        socket.destroy();
    });

    it('refuses version 13 alternatives with 426 plus the version header', async () => {
        const { socket, handshake } = rawConnect({ version: '8' });
        const response = await handshake;

        expect(response.statusLine).toBe('HTTP/1.1 426 Upgrade Required');
        expect(response.headers['sec-websocket-version']).toBe('13');

        socket.destroy();
    });

    it('refuses a foreign Origin with 403, which is a policy refusal and not an auth challenge', async () => {
        const { socket, handshake } = rawConnect({ origin: 'https://evil.example' });
        const response = await handshake;

        expect(response.statusLine).toBe('HTTP/1.1 403 Forbidden');

        socket.destroy();
    });

    it('accepts a loopback Origin (the dev UI) and a same-host Origin', async () => {
        const loopback = rawConnect({ origin: 'http://localhost:5180' });
        expect((await loopback.handshake).statusLine).toBe('HTTP/1.1 101 Switching Protocols');
        loopback.socket.destroy();

        const sameHost = rawConnect({ origin: `http://127.0.0.1:${port}` });
        expect((await sameHost.handshake).statusLine).toBe('HTTP/1.1 101 Switching Protocols');
        sameHost.socket.destroy();
    });

    it('answers 404 for another path on the same listener, and leaves plain GETs to the REST handler', async () => {
        const wrong = rawConnect({ path: '/v1/harness/streams' });
        expect((await wrong.handshake).statusLine).toBe('HTTP/1.1 404 Not Found');
        wrong.socket.destroy();

        // A plain HTTP GET on the same port never enters the upgrade path.
        const rest = await new Promise<string>((resolve) => {
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write('GET /anything HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
            });

            socket.once('data', (chunk) => {
                resolve(chunk.toString('utf8'));
                socket.destroy();
            });
        });

        expect(rest.startsWith('HTTP/1.1 200 OK')).toBe(true);
        expect(rest).toContain('rest');
    });

    it('completes with Node’s own WebSocket client (real RFC 6455 interop)', async () => {
        const client = new WebSocket(`ws://127.0.0.1:${port}${HARNESS_WS_STREAM_PATH}`, HARNESS_WS_SUBPROTOCOL);

        const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
            client.addEventListener('message', (event) => resolve(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>), { once: true });
            client.addEventListener('error', () => reject(new Error('handshake failed')));
        });

        expect(first).toEqual({
            type: 'welcome',
            protocol: HARNESS_WS_SUBPROTOCOL,
            epoch: 'aabbccdd',
            at: expect.any(Number),
            limits: expect.objectContaining({ subscriptions_per_connection: 64, replay_frames: 512 })
        });
        expect(client.protocol).toBe(HARNESS_WS_SUBPROTOCOL);

        client.close();
    });
});

describe('the frame codec', () => {
    const connectOpen = async (): Promise<{ socket: net.Socket; frames: () => string[]; feed: (frame: Buffer) => void }> => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        return {
            socket: client.socket,
            frames: () => client.frames,
            feed: (frame) => client.socket.write(frame)
        };
    };

    /** Wait for the server's close frame and return its status code. */
    const closeCode = async (client: { socket: net.Socket; closes: number[] }): Promise<number> => {
        expect(await until(() => client.closes.length > 0)).toBe(true);
        return client.closes[0];
    };

    it('reassembles a fragmented text message before parsing it', async () => {
        const { socket, frames, feed } = await connectOpen();

        // Split one `ping` frame across two TCP writes AND two WebSocket frames: the server must
        // answer exactly one pong, which is only possible if the fragments were joined first.
        feed(buildFrame(0x1, '{"type":"ping","at":', { fin: false }));
        feed(buildFrame(0x0, '7}', { fin: true }));

        expect(await until(() => frames().some((text) => text.includes('"pong"')))).toBe(true);
        expect(frames().filter((text) => text.includes('"pong"'))).toEqual(['{"type":"pong","at":7}']);

        socket.destroy();
    });

    it('answers a WS-level ping control frame with the identical payload', async () => {
        const { socket, feed } = await connectOpen();

        // Attach the reader BEFORE feeding: the pong can land on the very next tick, and the shared
        // handshake listener parses (and ignores) control frames it is not tracking. The loop below
        // also matters: a chunk may carry the welcome frame plus the pong together (one TCP write
        // each, coalesced by the stack), so a single `parseFrame` call would stop at the text frame.
        const echoed = new Promise<Buffer | undefined>((resolve) => {
            let buffer = Buffer.alloc(0);

            socket.on('data', (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);

                for (;;) {
                    const frame = parseFrame(buffer);
                    if (frame === undefined) return;
                    if (frame.opcode === 0xa) {
                        resolve(frame.payload);
                        return;
                    }
                    buffer = frame.rest;
                }
            });
        });

        feed(buildFrame(0x9, 'liveness'));

        expect((await echoed)?.toString('utf8')).toBe('liveness');
        socket.destroy();
    });

    it('closes 1002 on an unmasked client frame', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        client.socket.write(buildFrame(0x1, '{"type":"ping"}', { mask: false }));

        expect(await closeCode(client)).toBe(1002);
        client.socket.destroy();
    });

    it('closes 1003 on a binary frame, because this conversation is JSON text only', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        client.socket.write(buildFrame(0x2, 'not json'));

        expect(await closeCode(client)).toBe(1003);
        client.socket.destroy();
    });

    it('closes 1009 when a client frame exceeds max_client_frame_bytes', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // 16384 is the fixed contract cap; one byte more must be refused, not buffered.
        const oversize = Buffer.alloc(16_385, 0x61);
        const header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0xfe | 0x80;
        header.writeUInt16BE(oversize.length, 2);
        maskKey.copy(header, 4);

        for (let i = 0; i < oversize.length; i += 1) oversize[i] ^= maskKey[i % 4];

        client.socket.write(Buffer.concat([header, oversize]));

        expect(await closeCode(client)).toBe(1009);
        client.socket.destroy();
    });

    it('echoes the peer close status back, so the close handshake is complete', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // Attach the close watcher BEFORE sending: the server ends the socket immediately after the
        // echo, and a listener attached afterwards would miss both `end` and `close`.
        const closed = waitForClose(client.socket);

        const payload = Buffer.alloc(4);
        payload.writeUInt16BE(1000, 0);
        payload.write('ok', 2);
        client.socket.write(buildFrame(0x8, payload));

        expect(await closeCode(client)).toBe(1000);
        await closed;
    });

    // -----------------------------------------------------------------------
    // RFC 6455 corner cases the harness conversation must refuse, in the order
    // the RFC states them. Each of these was a real hole in the first cut of the
    // handwritten codec, which is why they are asserted at the byte level.
    // -----------------------------------------------------------------------

    it('reassembles a code point split across frames, with a control frame interleaved', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // A JSON `bye` whose `reason` contains a 2-byte UTF-8 character, cut in HALF between two
        // continuation frames, with a WS ping control frame squeezed in the middle: the RFC allows the
        // interleaving (§5.4) and requires the split code point to survive (§5.6), because a streamed
        // display delta is exactly this shape in practice. `bye` is a legal frame carrying free text,
        // and its observable effect is a clean close — which also proves the message PARSED (a bad
        // reassembly would surface `invalid_payload` or a framing close instead).
        const text = Buffer.from('{"type":"bye","reason":"café"}', 'utf8');
        const marker = Buffer.from('é', 'utf8');
        const start = text.indexOf(marker);
        expect(start).toBeGreaterThan(-1);

        client.socket.write(buildFrame(0x1, text.subarray(0, start + 1), { fin: false }));
        client.socket.write(buildFrame(0x9, 'mid'));
        client.socket.write(buildFrame(0x0, text.subarray(start + 1), { fin: true }));

        await until(() => client.closes.length > 0 || client.frames.length > 1, 1_500);

        expect({ closes: client.closes, errors: client.frames.filter((text) => text.includes('error')) }).toEqual({
            closes: [1000],
            errors: []
        });

        client.socket.destroy();
    });

    it('closes 1007 on a text message that is not valid UTF-8', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // 0xff is not a legal UTF-8 lead byte. A lenient decoder would substitute U+FFFD and keep the
        // connection; the RFC makes this invalid payload data.
        client.socket.write(buildFrame(0x1, Buffer.from([0x7b, 0xff, 0x7d])));

        expect(await closeCode(client)).toBe(1007);
        client.socket.destroy();
    });

    it('closes 1002 on a close frame with a one-byte payload', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        client.socket.write(buildFrame(0x8, Buffer.from([0x03])));

        expect(await closeCode(client)).toBe(1002);
        client.socket.destroy();
    });

    it('closes 1002 on a close status that cannot appear on the wire', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // 1005 ("no status received") is a SENTINEL, never a wire value: echoing it back would launder
        // an incomplete handshake into a normal close.
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1005, 0);
        client.socket.write(buildFrame(0x8, payload));

        expect(await closeCode(client)).toBe(1002);
        client.socket.destroy();
    });

    it('closes 1002 on a non-canonical length encoding', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // A 5-byte payload encoded with the 16-bit length form: legal-looking bytes, but RFC 6455 §5.2
        // requires the minimal encoding, and accepting both forms is how a splitter can be fooled.
        const body = Buffer.from('12345', 'utf8');
        const maskedBody = Buffer.from(body);
        for (let i = 0; i < maskedBody.length; i += 1) maskedBody[i] ^= maskKey[i % 4];

        const header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(body.length, 2);
        // The mask key follows the 2 extended length bytes; a 6-byte header would silently truncate it
        // and desynchronize the frame.
        maskKey.copy(header, 4);

        client.socket.write(Buffer.concat([header, maskedBody]));

        expect(await closeCode(client)).toBe(1002);
        client.socket.destroy();
    });

    it('closes 1009 when a FRAGMENTED message exceeds the byte budget', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // Each frame is under the 16384-byte cap; only the SUM is over it. A server that sizes each
        // fragment alone would buffer an unbounded message from a hostile peer.
        const chunk = Buffer.alloc(9000, 0x61);
        const frameOf = (fin: boolean, opcode: number): Buffer => {
            // 2 flag/length bytes + 2 extended-length bytes + 4 mask-key bytes = 8 header bytes.
            const header = Buffer.alloc(8);
            header[0] = (fin ? 0x80 : 0) | opcode;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(chunk.length, 2);
            maskKey.copy(header, 4);

            const masked = Buffer.from(chunk);
            for (let i = 0; i < masked.length; i += 1) masked[i] ^= maskKey[i % 4];

            return Buffer.concat([header, masked]);
        };

        client.socket.write(frameOf(false, 0x1));
        client.socket.write(frameOf(false, 0x0));
        client.socket.write(frameOf(true, 0x0));

        expect(await closeCode(client)).toBe(1009);
        client.socket.destroy();
    });

    it('writes server frames with the minimal length form, never a padded one', async () => {
        const client = rawConnect({ protocol: HARNESS_WS_SUBPROTOCOL });
        await client.handshake;

        // A WS ping with an 8-byte payload must be answered by a 0x8A frame whose second byte IS the
        // length: this writer is an implementation too, and a padded header would be a non-canonical
        // encoding a strict peer is entitled to reject. The loop skips any leading text frame (the
        // welcome) so the assertion is about the pong's own two header bytes.
        const pongHeader = new Promise<number[]>((resolve) => {
            let buffer = Buffer.alloc(0);

            client.socket.on('data', (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);

                for (;;) {
                    const frame = parseFrame(buffer);
                    if (frame === undefined) return;

                    if (frame.opcode === 0xa) resolve([buffer[0], buffer[1]]);

                    buffer = frame.rest;
                }
            });
        });

        client.socket.write(buildFrame(0x9, 'liveness'));

        const [first, second] = await pongHeader;
        expect(first).toBe(0x8a);
        // 8 payload bytes: the short form, not 0x7e/0x7f followed by a padded length.
        expect(second).toBe(8);
        client.socket.destroy();
    });
});
