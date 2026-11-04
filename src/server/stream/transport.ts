// A minimal, standards-safe RFC 6455 SERVER transport for the harness update stream.
//
// WHY THIS EXISTS INSTEAD OF `ws`
// `@underload/harness` publishes with exactly two runtime dependencies (`dotenv`, `typescript`), so
// a `import { WebSocketServer } from 'ws'` here would resolve in this monorepo (a hoisted transitive
// copy) and break for every consumer of the published package — and no installs are allowed. The
// stream needs only the text-frame subset of RFC 6455, so this module implements exactly that and
// nothing else:
//
//   - the `101 Switching Protocols` handshake (RFC 6455 §4.2.2), including `Sec-WebSocket-Accept`
//     (SHA-1 of the key plus the fixed GUID, base64) and optional subprotocol negotiation;
//   - server-to-client frames UNMASKED (the wire rule), client-to-server frames REQUIRED to be
//     masked (an unmasked client frame is a 1002 protocol error), the 7/16/64-bit length forms,
//     fragmentation with continuation frames, and control frames (close 0x8, ping 0x9, pong 0xA);
//   - the close handshake, with the codes the harness contract defines (1000/1003/1007/1009/1013/
//     4401/4408/4429) passed through untouched;
//   - a send queue with per-entry accounting, so the caller can implement the contract's
//     backpressure rule (drop the OLDEST droppable update frame, never a control frame) and read
//     back WHICH entry was lost.
//
// Explicitly NOT supported, because the contract forbids it: extensions (any RSV bit set is a 1002),
// binary payloads (the conversation is JSON text only, so a binary frame is a 1003), and messages
// above `max_client_frame_bytes` (a 1009 close, no buffering).
//
// Cross-references:
//   - ./protocol.ts            — close codes and byte limits this module enforces
//   - ./connection.ts          — the JSON conversation layered on `HarnessSocket`
//   - ./mount.ts               — `http.Server` attachment (the single `upgrade` listener)
//   - RFC 6455 §5 (frame layout), §5.5 (close), §6 (client/server requirements)

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { HARNESS_WS_STREAM_LIMITS } from '../../shared/harness-stream';
import { HARNESS_WS_CLOSE_CODES } from './protocol';

/** RFC 6455 §5.2 opcodes, restricted to the subset this conversation accepts. */
const OPCODE = {
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa
} as const;

/** The fixed RFC 6455 §1.3 GUID mixed into the accept hash. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WEBSOCKET_STATE = { connecting: 0, open: 1, closing: 2, closed: 3 } as const;

export type HarnessSocketSendMeta = { droppable?: boolean; token?: string };

export type HarnessSocketSendResult = {
    status: 'sent' | 'queued' | 'closed';
    /** Set when the CALLER asked for an eviction and the queue had a droppable entry to lose. */
    droppedToken?: string;
};

export type HarnessSocket = {
    readonly readyState: number;
    readonly protocol: string | undefined;
    readonly queuedFrames: number;
    readonly queuedBytes: number;
    /** Deliver a UTF-8 text frame. `droppable` marks an entry the caller may evict under pressure. */
    send(text: string, meta?: HarnessSocketSendMeta): HarnessSocketSendResult;
    /** Remove and return the token of the OLDEST droppable queued entry (control frames never move). */
    evictOldestDroppable(): { token?: string; bytes: number } | undefined;
    /** Send a close frame and finish once the peer echoes (or the socket dies). */
    close(code?: number, reason?: string): void;
    /** Send a close frame and destroy the socket immediately: a violation leaves nothing to drain. */
    fail(code?: number, reason?: string): void;
    /** Text message completion (fragmented payloads are reassembled before this fires). */
    onMessage(listener: (text: string) => void): void;
    /** ANY inbound frame or control reply — the liveness signal the heartbeat budget measures. */
    onActivity(listener: () => void): void;
    /** Peer-initiated close or socket loss. The code is `undefined` when the peer sent no status. */
    onClose(listener: (code: number | undefined, reason: string) => void): void;
};

// ---------------------------------------------------------------------------
// Request side: is this an upgrade, and may it be accepted?
// ---------------------------------------------------------------------------

/** True when the request carries the upgrade tokens, whatever the path is. */
export const isWebSocketUpgrade = (request: IncomingMessage): boolean => {
    const upgrade = request.headers.upgrade;
    const connection = request.headers.connection;

    // `Connection` may be a token list (`keep-alive, Upgrade`), and proxies fold case, so the
    // check is a case-insensitive token match rather than a string equality test.
    const connectionValue = Array.isArray(connection) ? connection.join(',') : (connection ?? '');
    const tokens = connectionValue.toLowerCase().split(',');

    if (!tokens.some((token) => token.trim() === 'upgrade')) return false;

    return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
};

export type HarnessUpgradeOptions = {
    /** Exact pathname the upgrade must target; the query string is ignored (the handshake carries no resume state). */
    path: string;
    /** Subprotocols this host speaks, in preference order. Echoed only when the client offered one. */
    subprotocols?: readonly string[];
    /** Extra response headers, e.g. the epoch header the contract requires on the 101. */
    headers?: Record<string, string>;
    /** Origin/host policy. A refusal answers 403 BEFORE the upgrade, which is a policy refusal. */
    allow?: (request: IncomingMessage) => { ok: true } | { ok: false; status: number; message: string };
    /** Default `max_client_frame_bytes` from the contract. */
    maxClientFrameBytes?: number;
};

/** Pathname of an `IncomingMessage.url`, without touching the query string. */
const pathnameOf = (url: string | undefined): string => {
    const value = url ?? '/';
    const marker = value.indexOf('?');
    const path = marker === -1 ? value : value.slice(0, marker);

    // A raw request target such as `//x` or a percent-encoded traversal is matched literally,
    // which is what the loader's route matching does too — normalising here would create a second
    // notion of "same path" and let `/v1/harness/stream/` slip past an exact-path gate.
    return path;
};

const REASON_PHRASES: Record<number, string> = {
    400: 'Bad Request',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    426: 'Upgrade Required',
    503: 'Service Unavailable'
};

const rejectUpgrade = (socket: Duplex, status: number, message: string, extraHeaders: string[] = []): void => {
    const body = JSON.stringify({ error: { message } });

    // Written by hand because no `ServerResponse` exists at this point: the request has already
    // been handed over as a socket. The reason phrase follows the status, which is what a client
    // that cannot read a JSON body (a browser opening a WebSocket) still reports correctly.
    socket.end(
        `HTTP/1.1 ${status} ${REASON_PHRASES[status] ?? 'Bad Request'}\r\n` +
            'Content-Type: application/json; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n` +
            'Connection: close\r\n' +
            `${extraHeaders.join('\r\n')}${extraHeaders.length > 0 ? '\r\n' : ''}\r\n${body}`
    );
};

/** RFC 6455 §4.2.2: `base64(SHA1(key + GUID))`. */
const acceptKey = (key: string): string => createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');

// ---------------------------------------------------------------------------
// Frame codec
// ---------------------------------------------------------------------------

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
    const length = payload.length;
    // 2 + (2 | 8) header bytes plus the unmasked payload: the server never masks (RFC 6455 §5.1).
    const headerLength = length < 126 ? 2 : length < 65_536 ? 4 : 10;
    const frame = Buffer.alloc(headerLength + length);

    frame[0] = 0x80 | opcode;

    if (length < 126) {
        frame[1] = length;
    } else if (length < 65_536) {
        frame[1] = 126;
        frame.writeUInt16BE(length, 2);
    } else {
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(length), 2);
    }

    payload.copy(frame, headerLength);

    return frame;
};

/** One inbound frame after unmasking, or a violation the caller must close over. */
type ParsedFrame =
    | { opcode: number; fin: boolean; payload: Buffer }
    | { violation: { code: number; reason: string } };

const unmask = (payload: Buffer, key: Buffer): Buffer => {
    const out = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ key[i % 4];
    return out;
};

// RFC 6455 §5.6 says a text message MUST be valid UTF-8, and §5.5.1 applies the same rule to a close
// reason. A `fatal` decoder is how that requirement is enforced rather than approximated: Node's
// default `toString('utf8')` silently substitutes U+FFFD, which would hand the conversation a mangled
// frame and let a corrupt stream keep running.
const strictText = new TextDecoder('utf-8', { fatal: true });

/**
 * Which close statuses may legally appear on the wire (RFC 6455 §7.4, plus the codes this contract
 * registers). 1005 and 1006 mean "no status was received" and must never be SENT; 1004 and 1015 are
 * reserved; 1016-1999 are unassigned; and the private range this host uses (4401/4408/4429) sits in
 * 3000-4999. A status outside this set is a protocol error, not a code to echo back.
 */
const isWireCloseStatus = (code: number): boolean =>
    code === 1000 ||
    code === 1001 ||
    code === 1002 ||
    code === 1003 ||
    (code >= 1007 && code <= 1014) ||
    (code >= 2000 && code <= 4999);

// ---------------------------------------------------------------------------
// The connection object
// ---------------------------------------------------------------------------

type QueueEntry = { frame: Buffer; bytes: number; droppable: boolean; token?: string };

/**
 * Take over an accepted upgrade and return the socket wrapper.
 *
 * The caller is responsible for the path/policy checks (see `attachUpgrade`); this function only
 * performs the handshake and starts the read loop. `head` (bytes already buffered after the
 * request headers) is fed into the frame parser, because a client that pipelines its first
 * `hello` with the handshake is legal and common.
 */
const createSocket = (
    socket: Duplex,
    protocol: string | undefined,
    maxClientFrameBytes: number
): HarnessSocket => {
    let readyState: number = WEBSOCKET_STATE.open;
    let pending: QueueEntry[] = [];
    let queuedBytes = 0;
    let draining = false;
    let fragment: Buffer[] = [];
    // Total bytes buffered for the message being fragmented, so a run of continuation frames cannot
    // exceed the single-frame budget by simply being split many times.
    let fragmentBytes = 0;
    let fragmentOpcode = -1;
    let buffer: Buffer = Buffer.alloc(0);
    let closeEchoSent = false;
    let notified = false;

    const messageListeners: ((text: string) => void)[] = [];
    const activityListeners: (() => void)[] = [];
    const closeListeners: ((code: number | undefined, reason: string) => void)[] = [];

    const push = (entry: QueueEntry): void => {
        pending.push(entry);
        queuedBytes += entry.bytes;
    };

    // Writes everything still pending. There is no state guard here on purpose: the close frame is
    // queued AFTER the state moved to `closing`, so a guarded flush would never put it on the wire.
    // Data sends are already refused by `sendFrame`, and `finish()` clears what is left.
    const flush = (): void => {
        if (draining) return;

        while (pending.length > 0) {
            const entry = pending.shift() as QueueEntry;
            queuedBytes -= entry.bytes;
            draining = socket.write(entry.frame) === false;
            if (draining) return;
        }

        draining = false;
    };

    // One close notification, whatever path ended the conversation (a close frame, a dropped peer,
    // or our own teardown). The conversation must release its subscriptions exactly once.
    const finish = (code?: number, reason?: string): void => {
        if (!notified) {
            notified = true;
            for (const listener of closeListeners) listener(code, reason ?? '');
        }

        if (readyState === WEBSOCKET_STATE.closed) return;
        readyState = WEBSOCKET_STATE.closed;
        pending = [];
        queuedBytes = 0;

        // `end()` flushes what is already on the socket (the close frame) before half-closing; the
        // timer is the hard stop for a peer that never drains.
        socket.end();

        const timer = setTimeout(() => socket.destroy(), 200);
        timer.unref?.();
    };

    const sendFrame = (opcode: number, payload: Buffer, meta: HarnessSocketSendMeta = {}): HarnessSocketSendResult => {
        if (readyState >= WEBSOCKET_STATE.closing) {
            // Nothing is accepted once the close handshake started, except the close echo itself.
            return { status: 'closed' };
        }

        const frame = encodeFrame(opcode, payload);
        const entry: QueueEntry = { frame, bytes: frame.length, droppable: meta.droppable === true, ...(meta.token === undefined ? {} : { token: meta.token }) };

        if (!draining && pending.length === 0) {
            draining = socket.write(frame) === false;
            return { status: draining ? 'queued' : 'sent' };
        }

        push(entry);

        return { status: 'queued' };
    };

    // Send a close frame with the given status. Data still queued behind it is dropped, which is
    // honest: the conversation is ending, and the contract's rule is that loss is reported by
    // `resync_required`, not by a silent truncation.
    const respondClose = (code: number, reason: string): void => {
        if (closeEchoSent) return;
        closeEchoSent = true;

        const reasonBuffer = Buffer.from(reason, 'utf8');
        // A close payload is a 2-byte code plus the reason, and the reason is capped so the whole
        // control frame stays within RFC 6455's 125-byte limit for control frames.
        const capped = reasonBuffer.subarray(0, Math.min(reasonBuffer.length, 123));
        const payload = Buffer.alloc(2 + capped.length);
        payload.writeUInt16BE(code, 0);
        capped.copy(payload, 2);

        if (readyState < WEBSOCKET_STATE.closing) readyState = WEBSOCKET_STATE.closing;

        const frame = encodeFrame(OPCODE.close, payload);

        // Already-queued data frames go out FIRST: the contract reports a closing stream through an
        // `error` frame with a `close_code`, and a client that never saw it would treat the close as
        // a dropped connection. `close()`'s timer is the bound on how long that may take.
        pending = [...pending, { frame, bytes: frame.length, droppable: false }];
        queuedBytes += frame.length;
        draining = false;
        flush();
    };

    // A protocol violation in the frame stream: report it, then take the socket down. Nothing is
    // salvageable once the framing is out of step.
    const violate = (code: number, reason: string): void => {
        respondClose(code, reason);
        finish(code, reason);
    };

    const handleFrame = (frame: { opcode: number; fin: boolean; payload: Buffer }): void => {
        switch (frame.opcode) {
            case OPCODE.ping:
                // Answer with the identical payload (RFC 6455 §5.5.3) and keep it non-droppable. A
                // ping/ping may legally arrive in the MIDDLE of a fragmented message, and it must not
                // disturb the fragment state — which is why the fragment lives outside this switch.
                sendFrame(OPCODE.pong, frame.payload);
                return;
            case OPCODE.pong:
                for (const listener of activityListeners) listener();
                return;
            case OPCODE.close: {
                // RFC 6455 §5.5.1: the payload is either empty or a 2-byte status plus a UTF-8 reason.
                // A single byte is not a status, and a status that cannot appear on the wire
                // (1005/1006 mean "no status received", 1004 and 1015 are reserved, <1000 and
                // 1016-1999 are unassigned) is a protocol error — never something to echo back and
                // thereby launder into a legal close.
                if (frame.payload.length === 1) {
                    violate(HARNESS_WS_CLOSE_CODES.protocolError, 'A close payload is empty or at least two bytes');
                    return;
                }

                if (frame.payload.length === 0) {
                    respondClose(HARNESS_WS_CLOSE_CODES.normal, '');
                    finish(undefined, '');
                    return;
                }

                const code = frame.payload.readUInt16BE(0);

                if (!isWireCloseStatus(code)) {
                    violate(HARNESS_WS_CLOSE_CODES.protocolError, `Close status ${code} cannot appear on the wire`);
                    return;
                }

                let reason = '';

                if (frame.payload.length > 2) {
                    try {
                        // The reason must itself be valid UTF-8 (§5.5.1 points at §5.6).
                        reason = strictText.decode(frame.payload.subarray(2));
                    } catch {
                        violate(HARNESS_WS_CLOSE_CODES.invalidPayload, 'A close reason must be valid UTF-8');
                        return;
                    }
                }

                // Echo the peer's status so a proxy in front of us sees a complete close handshake.
                respondClose(code, reason);
                finish(code, reason);
                return;
            }
            case OPCODE.text:
            case OPCODE.continuation: {
                if (frame.opcode === OPCODE.continuation) {
                    if (fragmentOpcode === -1) {
                        violate(HARNESS_WS_CLOSE_CODES.protocolError, 'Unexpected continuation frame');
                        return;
                    }

                    fragment.push(frame.payload);
                    fragmentBytes += frame.payload.length;
                } else {
                    if (fragmentOpcode !== -1) {
                        violate(HARNESS_WS_CLOSE_CODES.protocolError, 'Interleaved text frame inside a fragment');
                        return;
                    }

                    fragment = [frame.payload];
                    fragmentBytes = frame.payload.length;
                    fragmentOpcode = OPCODE.text;
                }

                // A fragmented message is bounded by the SAME byte budget as a single frame: without
                // this, an endless run of continuation frames would buffer an unbounded message inside
                // a connection that is supposed to cost one page render.
                if (fragmentBytes > maxClientFrameBytes) {
                    violate(HARNESS_WS_CLOSE_CODES.messageTooBig, `A client message cannot exceed ${maxClientFrameBytes} bytes`);
                    return;
                }

                if (!frame.fin) return;

                // RFC 6455 §5.6: a text message MUST be valid UTF-8. Decoding with `fatal` is what
                // turns an invalid sequence into a 1007 instead of a silent U+FFFD substitution — and
                // because the fragments are CONCATENATED before this decode, a code point split across
                // a frame boundary (the common case for a non-ASCII delta in a streamed reply) stays
                // perfectly legal.
                let text: string;

                try {
                    text = strictText.decode(Buffer.concat(fragment));
                } catch {
                    violate(HARNESS_WS_CLOSE_CODES.invalidPayload, 'A text message must be valid UTF-8');
                    return;
                }

                fragment = [];
                fragmentBytes = 0;
                fragmentOpcode = -1;

                for (const listener of activityListeners) listener();
                for (const listener of messageListeners) listener(text);
                return;
            }
            default:
                // Binary and reserved opcodes: this conversation is JSON text only.
                violate(HARNESS_WS_CLOSE_CODES.unsupportedData, 'This conversation carries JSON text frames only');
        }
    };

    const consume = (): void => {
        for (;;) {
            if (buffer.length < 2) return;

            const first = buffer[0];
            const second = buffer[1];
            const fin = (first & 0x80) !== 0;
            const rsv = first & 0x70;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;

            // No extensions are negotiated, so any RSV bit is a protocol error (§5.1).
            if (rsv !== 0) {
                violate(HARNESS_WS_CLOSE_CODES.protocolError, 'Unsupported extension bits');
                return;
            }

            // A client frame MUST be masked (§5.1): an unmasked client frame is 1002, not something
            // to tolerate, because a proxy that skipped masking would corrupt every payload.
            if (!masked) {
                violate(HARNESS_WS_CLOSE_CODES.protocolError, 'Client frames must be masked');
                return;
            }

            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;

                // RFC 6455 §5.2: a length that fits in 7 bits MUST use the 7-bit form. Accepting a
                // padded encoding would let two byte-distinct encodings of the same frame pass
                // different validation paths, which is how request-splitting caches get fooled.
                if (length < 126) {
                    violate(HARNESS_WS_CLOSE_CODES.protocolError, 'A 16-bit length must exceed 125 bytes');
                    return;
                }
            } else if (length === 127) {
                if (buffer.length < 10) return;
                const wide = buffer.readBigUInt64BE(2);
                if (wide > BigInt(Number.MAX_SAFE_INTEGER)) {
                    violate(HARNESS_WS_CLOSE_CODES.messageTooBig, 'Frame length is beyond this host');
                    return;
                }
                length = Number(wide);
                offset = 10;

                if (length <= 0xffff) {
                    violate(HARNESS_WS_CLOSE_CODES.protocolError, 'A 64-bit length must exceed 65535 bytes');
                    return;
                }
            }

            // Control frames are never fragmented and never larger than 125 bytes (§5.5).
            if (opcode >= 0x8 && (length > 125 || !fin)) {
                violate(HARNESS_WS_CLOSE_CODES.protocolError, 'Invalid control frame');
                return;
            }

            if (length > maxClientFrameBytes) {
                violate(HARNESS_WS_CLOSE_CODES.messageTooBig, `A client frame cannot exceed ${maxClientFrameBytes} bytes`);
                return;
            }

            // 4 mask bytes follow the length field.
            if (buffer.length < offset + 4 + length) return;

            const maskKey = buffer.subarray(offset, offset + 4);
            const payload = unmask(buffer.subarray(offset + 4, offset + 4 + length), maskKey);

            buffer = buffer.subarray(offset + 4 + length);
            handleFrame({ opcode, fin, payload });

            if (readyState >= WEBSOCKET_STATE.closing) return;
        }
    };

    socket.on('data', (chunk: Buffer) => {
        buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
        consume();
    });

    socket.on('drain', () => {
        draining = false;
        flush();
    });

    // A dropped peer is normal (a closed tab) and is reported with NO status code, which is the
    // difference the contract draws between a clean `bye` and a connection that simply went away.
    socket.on('close', () => finish());

    // A socket error after the upgrade (an ECONNRESET mid-flight) is the same case as a close.
    socket.on('error', () => finish());

    return {
        get readyState(): number {
            return readyState;
        },
        get protocol(): string | undefined {
            return protocol;
        },
        get queuedFrames(): number {
            return pending.length;
        },
        get queuedBytes(): number {
            return queuedBytes;
        },
        send: (text, meta = {}) => sendFrame(OPCODE.text, Buffer.from(text, 'utf8'), meta),
        evictOldestDroppable: () => {
            const index = pending.findIndex((entry) => entry.droppable);
            if (index === -1) return undefined;

            const [entry] = pending.splice(index, 1) as [QueueEntry];
            queuedBytes -= entry.bytes;

            return { bytes: entry.bytes, ...(entry.token === undefined ? {} : { token: entry.token }) };
        },
        close: (code = HARNESS_WS_CLOSE_CODES.normal, reason = '') => {
            respondClose(code, reason);

            // Give the peer a moment to echo, then finish: a client that never answers must not
            // hold the socket — and therefore a subscription — open forever.
            const timer = setTimeout(() => finish(), 1000);
            timer.unref?.();
        },
        fail: (code = HARNESS_WS_CLOSE_CODES.protocolError, reason = '') => {
            respondClose(code, reason);
            finish(code, reason);
        },
        onMessage: (listener) => {
            messageListeners.push(listener);
        },
        onActivity: (listener) => {
            activityListeners.push(listener);
        },
        onClose: (listener) => {
            closeListeners.push(listener);
        }
    };
};

/**
 * Validate the handshake and take over the socket.
 *
 * Returns the wrapper on success and `undefined` after writing the refusal, so an attachment point
 * can try the next candidate route without leaking the socket. The checks here are the transport
 * half only (upgrade tokens, key, version, exact path, host policy); the JSON conversation starts
 * in ./connection.ts.
 */
export const performUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    options: HarnessUpgradeOptions
): HarnessSocket | undefined => {
    const headers = request.headers;

    const refusal = options.allow?.(request);
    if (refusal !== undefined && refusal.ok === false) {
        rejectUpgrade(socket, refusal.status, refusal.message);
        return undefined;
    }

    if (request.method !== 'GET') {
        rejectUpgrade(socket, 405, 'The stream upgrade is a GET.');
        return undefined;
    }

    if (!isWebSocketUpgrade(request)) {
        rejectUpgrade(socket, 400, 'The request is not a WebSocket upgrade.');
        return undefined;
    }

    const key = headers['sec-websocket-key'];

    if (typeof key !== 'string' || key.length === 0) {
        rejectUpgrade(socket, 400, 'A WebSocket upgrade requires Sec-WebSocket-Key.');
        return undefined;
    }

    const version = headers['sec-websocket-version'];

    if (version !== '13') {
        // 426 plus the version header is the RFC's answer to a client speaking another version.
        rejectUpgrade(socket, 426, 'This stream speaks WebSocket protocol version 13.', ['Sec-WebSocket-Version: 13']);
        return undefined;
    }

    if (pathnameOf(request.url) !== options.path) {
        rejectUpgrade(socket, 404, `No stream is mounted at ${pathnameOf(request.url)}.`);
        return undefined;
    }

    // Subprotocol negotiation: echo the first offered token this host speaks, and nothing when the
    // client offered none — the contract says a subprotocol-less upgrade must not assume the
    // vocabulary, so inventing one here would be a lie.
    const offered = typeof headers['sec-websocket-protocol'] === 'string' ? (headers['sec-websocket-protocol'] as string).split(',') : [];
    const negotiated = (options.subprotocols ?? []).find((name) =>
        offered.some((candidate) => candidate.trim() === name)
    );

    const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(key)}`
    ];

    if (negotiated !== undefined) lines.push(`Sec-WebSocket-Protocol: ${negotiated}`);

    for (const [name, value] of Object.entries(options.headers ?? {})) lines.push(`${name}: ${value}`);

    socket.write(`${lines.join('\r\n')}\r\n\r\n`);

    const connection = createSocket(socket, negotiated, options.maxClientFrameBytes ?? HARNESS_WS_STREAM_LIMITS.max_client_frame_bytes);

    // `head` is data the HTTP parser already consumed; re-emitting it keeps a `hello` frame that was
    // pipelined with the handshake from being lost. It is synchronous, so ordering is preserved.
    if (head.length > 0) socket.emit('data', head);

    return connection;
};

export { rejectUpgrade };
