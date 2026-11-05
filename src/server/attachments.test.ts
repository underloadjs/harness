// Server-side attachment contract (T3) — queue, persistence, reload, dispatch,
// validation ordering, and the route-aware body caps.
//
// Everything runs offline against a scripted preset and (where durability matters)
// a REAL database root under the repo-root Temp/ directory. No provider, no
// network. The body-cap tests use the in-process service adapter and a fake
// IncomingMessage/ServerResponse so the Node stream cap is exercised without
// opening a socket.
//
// Coverage map (acceptance evidence for R3/R4/R5):
//   - a valid image travels queue → harness call → turn record → state.json →
//     restart, with the raw base64 bytes intact;
//   - a persisted QUEUED attachment turn still dispatches after a crash restart;
//   - blank input is accepted only when a clip is present (store + HTTP);
//   - malformed, wrong-signature, and oversized attachments are rejected with
//     400/415/413 BEFORE any turn is created;
//   - legacy text-only bodies keep their exact old shape (no `attachments` key);
//   - the ONE submit route gets the 16 MiB body cap; every other route keeps the 1 MB cap.
//
// T35 MIGRATION NOTE: `/messages` and the `/api` mount are gone, so a submit is proved on
// `POST /v1/harness/sessions/{id}/tasks` and its answer is a 202 `TaskReceipt`. A turn read
// carries the attachment CHIP only (id/kind/marker/name/mime/size/`has_bytes`); the base64 is
// the named `GET .../turns/{id}/attachments/{attachmentId}` read, and that is where the byte
// fidelity below is asserted.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessAttachment, HarnessMessage, HarnessStreamEvent } from '../harness';
import { MAX_ATTACHMENT_BYTES, MAX_SUBMIT_BODY_BYTES } from '../shared/attachments';
import { createHarnessHandler } from './handler';
import { createHarnessRegistry } from './harnesses';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import type { HarnessRuntime } from './runtime';
import { createHarnessRuntime } from './runtime';
import { createHarnessServiceHandler } from './service';
import { SessionError } from './sessions';
import { MAX_API_BODY_BYTES, bodyLimitFor } from './api';
import type { SessionSnapshot } from './protocol';
// T35: canonical transport — one mount, a 202 receipt for the submit, and one named read per
// heavy member (turn metadata, attachment bytes). Composition lives in ./canonical-reads.
import { HARNESS_ROUTES } from '../shared/harness-api';
import {
    bindApiCall,
    readTurn,
    readTurnAttachment,
    submitTask,
    type CanonicalCall
} from './canonical-reads.test-support';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-attachments-${label}-`));
    roots.push(root);
    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'scripted/test'
};

const DEFAULTS = {
    baseURL: SETTINGS.baseURL,
    model: SETTINGS.model,
    hasApiKey: true
};

const stateFile = (root: string): string => path.join(root, 'harness', 'state.json');

// ---------------------------------------------------------------------------
// Attachments and the scripted preset
// ---------------------------------------------------------------------------

// Build a canonical-base64 PNG of an EXACT decoded size. The first eight bytes
// are the real PNG signature, so the shared validator's magic check passes for
// any size; the remaining bytes are zero padding. This lets one helper cover a
// tiny valid clip, a >1 MB clip (proves the route cap), and an over-limit clip.
const pngData = (size: number): string => {
    const bytes = Buffer.alloc(size);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    return bytes.toString('base64');
};

const IMAGE_DATA = pngData(12);

const imageAttachment = (overrides: Partial<HarnessAttachment> = {}): HarnessAttachment => ({
    id: 'image-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    size: 12,
    data: IMAGE_DATA,
    ...overrides
});

// One recorded harness call. `attachments` is absent for a text-only turn so the
// assertion can prove the old shape stayed absent at the harness boundary too.
type SeenTurn = {
    prompt: string;
    attachments?: HarnessAttachment[];
};

const lastUserMessage = (messages: readonly HarnessMessage[]): HarnessMessage | undefined => {
    const users = messages.filter((message) => message.role === 'user');
    return users[users.length - 1];
};

const presetOf = (name: string, create: HarnessPreset['create']): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: name,
    subagents: [],
    agents: [name],
    tools: [],
    builtin: true,
    editable: true,
    create
});

// A one-agent scripted harness that records the prompt and the user message's
// attachments for every model request. The observer is wired exactly like a
// production preset, so the store's write-through persistence path runs too.
const recordingPreset = (name: string, seen: SeenTurn[]): HarnessPreset =>
    presetOf(name, (settings, progress, report) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: `You are the ${name} scripted agent.`,
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const last = lastUserMessage(request.messages);
                        const content = last?.role === 'user' ? last.content : '';
                        const attachments =
                            last?.role === 'user' && last.attachments !== undefined
                                ? last.attachments
                                : undefined;

                        seen.push({
                            prompt: content,
                            ...(attachments === undefined ? {} : { attachments })
                        });

                        yield { type: 'text', delta: `answer:${content}` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: name,
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
    );

// A single preset used across a crash restart. It records every call and gates
// ONLY the literal 'hold' prompt, so the first runtime can leave a queued
// attachment turn on disk while the restored runtime dispatches that same turn.
const gatedPreset = (
    name: string,
    seen: SeenTurn[]
): { preset: HarnessPreset; started: Promise<void> } => {
    let startRun!: () => void;
    const started = new Promise<void>((resolve) => {
        startRun = resolve;
    });

    const gate = new Promise<void>((resolve) => {
        // Released only by the fixture (never in the restart test): the pending
        // promise keeps the event loop free but leaves the first runtime's turn
        // running, exactly like a process that dies mid-run.
        void resolve;
    });

    const preset = presetOf(name, (settings, progress, report) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: 'Hold the first turn.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const last = lastUserMessage(request.messages);
                        const content = last?.role === 'user' ? last.content : '';
                        const attachments =
                            last?.role === 'user' && last.attachments !== undefined
                                ? last.attachments
                                : undefined;

                        seen.push({
                            prompt: content,
                            ...(attachments === undefined ? {} : { attachments })
                        });

                        if (content === 'hold') {
                            startRun();
                            await gate;
                        }

                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: name,
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
    );

    return { preset, started };
};

const runtimeOf = (preset: HarnessPreset, root?: string): HarnessRuntime =>
    createHarnessRuntime({
        ...(root === undefined ? {} : { root }),
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry([preset]),
        loadEnvironment: false
    });

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

type FakeResponse = EventEmitter & {
    statusCode: number;
    headersSent: boolean;
    writableEnded: boolean;
    destroyed: boolean;
    headers: Record<string, string>;
    payload?: string;
    setHeader: (name: string, value: string) => void;
    flushHeaders: () => void;
    write: () => boolean;
    end: (body?: string) => void;
    destroy: () => void;
};

const fakeResponse = (): FakeResponse => {
    const response = new EventEmitter() as FakeResponse;
    response.statusCode = 0;
    response.headersSent = false;
    response.writableEnded = false;
    response.destroyed = false;
    response.headers = {};
    response.setHeader = (name, value) => {
        response.headers[name.toLowerCase()] = value;
    };
    response.flushHeaders = () => {
        response.headersSent = true;
    };
    response.write = () => true;
    response.end = (body) => {
        response.payload = body;
        response.writableEnded = true;
    };
    response.destroy = () => {
        response.destroyed = true;
    };
    return response;
};

const fakeRequest = (
    method: string,
    url: string,
    chunks: Buffer[],
    headers: Record<string, string> = {}
): Readable & { method: string; url: string; headers: Record<string, string> } => {
    const request = Readable.from(chunks) as Readable & {
        method: string;
        url: string;
        headers: Record<string, string>;
    };
    request.method = method;
    request.url = url;
    request.headers = { 'x-harness-client': 'ui', ...headers };
    return request;
};

const runNodeHandler = async (
    runtime: HarnessRuntime,
    method: string,
    url: string,
    chunks: Buffer[],
    headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> => {
    const handler = createHarnessHandler({
        store: runtime.store,
        defaults: DEFAULTS,
        registry: runtime.registry
    });
    const response = fakeResponse();
    await handler(fakeRequest(method, url, chunks, headers), response as never);

    return {
        status: response.statusCode,
        body: response.payload === undefined ? undefined : JSON.parse(response.payload)
    };
};

type ServiceCallOptions = {
    body?: unknown;
    headers?: Record<string, string>;
};

const callService = async (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    options: ServiceCallOptions = {}
): Promise<{ status: number; body: unknown; raw?: Response }> => {
    const handler = createHarnessServiceHandler({ runtime });
    const headers = options.headers ?? {};
    const result = await handler(
        {
            req: {
                path: pathname,
                header: (name) => headers[name.toLowerCase()],
                raw: { method, signal: new AbortController().signal }
            }
        },
        { body: options.body === undefined ? {} : options.body }
    );

    if (result.raw !== undefined) return { status: result.status, body: undefined, raw: result.raw };
    return { status: result.status, body: result.response };
};

const createSession = async (runtime: HarnessRuntime, harnessName: string): Promise<SessionSnapshot> => {
    const created = await callService(runtime, 'POST', '/v1/harness/sessions', {
        body: { harness: harnessName }
    });
    expect(created.status).toBe(201);

    return (created.body as { session: SessionSnapshot }).session;
};

// One `CanonicalCall` over the runtime's single mount (no `/api`, no `/messages`).
const callOf = (runtime: HarnessRuntime): CanonicalCall => bindApiCall(runtime.api, '/v1/harness');

// A call whose answer is asserted as `{status, body}` — the error-envelope assertions below
// are unchanged from the legacy file, only the route that answers them moved.
const callApiResult = async (
    call: CanonicalCall,
    method: Parameters<CanonicalCall>[0],
    pathname: string,
    body: unknown
): Promise<{ status: number; body: unknown }> => {
    const result = await call(method, pathname, body);

    if (result.kind !== 'json') throw new Error(`expected JSON from ${method} ${pathname}`);

    return { status: result.status, body: result.body };
};

// Mirrors api-reads.ts `attachmentDescriptorOf`: a turn read carries the CHIP (identity,
// size, and `has_bytes`), never the base64 — the bytes are their own route. Spelled out so
// the assertion is exact rather than a shape shrug.
const descriptorOf = (attachment: HarnessAttachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    marker: attachment.marker,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    has_bytes: true
});

// Parse the `data: <json>` SSE frames a service route returns as a raw Response.
const sseItems = (text: string): unknown[] => {
    const items: unknown[] = [];

    for (const block of text.split('\n\n')) {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

        if (data.length > 0) items.push(JSON.parse(data) as unknown);
    }

    return items;
};

// ---------------------------------------------------------------------------
// Queue + dispatch
// ---------------------------------------------------------------------------

describe('queued attachments dispatch and persist', () => {
    it('carries a valid image through the legacy run() trailing parameter', async () => {
        const seen: SeenTurn[] = [];
        const runtime = runtimeOf(recordingPreset('media', seen));
        const created = await runtime.store.create('media');
        const attachment = imageAttachment();

        // Positional proof: the 4th argument is still the options object and the
        // 5th is the new attachments slot.
        await runtime.store.run(created.id, 'legacy [Image 1]', async () => {}, {}, [attachment]);

        expect(seen).toEqual([{ prompt: 'legacy [Image 1]', attachments: [attachment] }]);
        expect(runtime.store.get(created.id).turns[0]!.attachments).toEqual([attachment]);
    });

    it('carries a valid image through queue → harness → turn record → state.json', async () => {
        const root = tempRoot('queue');
        const seen: SeenTurn[] = [];
        const runtime = runtimeOf(recordingPreset('media', seen), root);
        const created = await runtime.store.create('media');
        const attachment = imageAttachment();

        const task = await runtime.store.enqueue(created.id, '  Look at [Image 1]  ', [attachment]);

        // The accepted 202 copy is detached: mutating it cannot rewrite the turn.
        expect(task.turn).toEqual({
            id: task.turn.id,
            index: 0,
            prompt: 'Look at [Image 1]',
            threadId: 'thread-1',
            // R8: conversation name (agent code + per-agent ordinal).
            threadLabel: 'MA1',
            attachments: [attachment],
            status: 'queued',
            updatedAt: expect.any(Number),
            events: [],
            eventTimes: []
        });

        task.turn.attachments![0]!.data = 'mutated-by-caller';
        expect(runtime.store.get(created.id).turns[0]!.attachments).toEqual([attachment]);

        await task.settled;

        // The harness received the prompt AND the real bytes on its root message.
        expect(seen).toEqual([{ prompt: 'Look at [Image 1]', attachments: [attachment] }]);
        expect(runtime.store.get(created.id).turns[0]).toEqual({
            id: task.turn.id,
            index: 0,
            prompt: 'Look at [Image 1]',
            threadId: 'thread-1',
            threadLabel: 'MA1',
            attachments: [attachment],
            status: 'done',
            startedAt: expect.any(Number),
            updatedAt: expect.any(Number),
            events: expect.any(Array),
            eventTimes: expect.any(Array)
        });

        // The durable document stores the raw base64, not a URL or path.
        const document = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            sessions: { turns: { attachments?: HarnessAttachment[] }[] }[];
        };
        expect(document.sessions[0]!.turns[0]!.attachments).toEqual([attachment]);

        // RELOAD: a fresh store over the same root reads the exact same record.
        runtime.store.dispose();
        const reloaded = runtimeOf(recordingPreset('media', seen), root).store.get(created.id);
        expect(reloaded.turns[0]!.attachments).toEqual([attachment]);
        expect(reloaded.turns[0]!.prompt).toBe('Look at [Image 1]');
    });

    it('dispatches a persisted QUEUED attachment turn after a crash restart', async () => {
        const root = tempRoot('queued-restart');
        const seen: SeenTurn[] = [];
        const fixture = gatedPreset('gated', seen);
        const first = runtimeOf(fixture.preset, root);
        const created = await first.store.create('gated');
        const attachment = imageAttachment();

        // Hold the legacy run so the attachment task stays queued on disk.
        void first.store.run(created.id, 'hold', async () => {});
        await fixture.started;

        const queued = await first.store.enqueue(created.id, '', [attachment]);
        expect(queued.turn.status).toBe('queued');
        expect(queued.turn.prompt).toBe('');
        expect(queued.turn.attachments).toEqual([attachment]);

        const duringRun = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            sessions: { turns: { id: string; status: string; attachments?: HarnessAttachment[] }[]; queue: string[] }[];
        };
        expect(duringRun.sessions[0]!.turns[1]!.attachments).toEqual([attachment]);
        expect(duringRun.sessions[0]!.queue).toEqual([queued.turn.id]);

        // Crash restart (no dispose): the queued turn is restored paused. The SAME
        // preset object is supplied so the restored session keeps its scripted
        // factory (the registry fast path).
        const second = runtimeOf(fixture.preset, root);
        const restored = second.store.get(created.id);
        expect(restored.turns[1]!.attachments).toEqual([attachment]);
        expect(restored.turns[1]!.status).toBe('queued');

        // F1: the paused backlog belongs to its thread's lane, so the kick targets
        // that SAME conversation; it executes the restored turn FIRST, with its
        // persisted bytes, then the new text turn.
        expect(restored.turns[1]!.threadId).toBe('thread-1');
        const kick = await second.store.enqueue(created.id, 'after restart', undefined, undefined, 'thread-1');
        await kick.settled;

        // R1-R6: the blank attachment task runs in its own persistent thread, and a
        // thread run requires non-empty text, so its submit MARKER is the run text.
        // The recorded `turn.prompt` stays empty (asserted above).
        expect(seen).toEqual([
            { prompt: 'hold' },
            { prompt: '[Image 1]', attachments: [attachment] },
            { prompt: 'after restart' }
        ]);
        expect(second.store.get(created.id).turns.map((turn) => turn.status)).toEqual([
            'error',
            'done',
            'done'
        ]);
    });
});

// ---------------------------------------------------------------------------
// Validation and ordering
// ---------------------------------------------------------------------------

describe('attachment validation rejects before mutation', () => {
    it('accepts blank input only with a valid attachment and keeps the text cap', async () => {
        const seen: SeenTurn[] = [];
        const runtime = runtimeOf(recordingPreset('media', seen));
        const created = await runtime.store.create('media');

        await expect(runtime.store.enqueue(created.id, '   ')).rejects.toThrow(SessionError);
        await expect(runtime.store.enqueue(created.id, '   ')).rejects.toThrow('A task cannot be empty.');
        await expect(runtime.store.enqueue(created.id, 'x'.repeat(200_001), [imageAttachment()])).rejects.toThrow(
            'A task cannot exceed 200000 characters.'
        );
        expect(runtime.store.get(created.id).turns).toEqual([]);

        const task = await runtime.store.enqueue(created.id, '   ', [imageAttachment()]);
        // The user-facing record stays the raw blank prompt; only the RUN text a
        // persistent thread requires becomes the marker.
        expect(task.turn.prompt).toBe('');
        await task.settled;
        expect(seen).toEqual([{ prompt: '[Image 1]', attachments: [imageAttachment()] }]);
    });

    it('maps malformed, wrong-signature, and oversized media to 400/415/413 with nothing queued', async () => {
        const runtime = runtimeOf(recordingPreset('media', []));
        const created = await runtime.store.create('media');
        const baseline = runtime.store.get(created.id).turns;

        const malformed = imageAttachment({ data: 'not-base64!' });
        const mismatch = imageAttachment({
            data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64'),
            size: 8
        });
        const oversized = imageAttachment({
            data: pngData(MAX_ATTACHMENT_BYTES + 1),
            size: MAX_ATTACHMENT_BYTES + 1
        });
        const tooMany = Array.from({ length: 5 }, (_, index) =>
            imageAttachment({
                id: `image-${index + 1}`,
                marker: `[Image ${index + 1}]`,
                name: `pixel-${index + 1}.png`
            })
        );

        const cases: { attachment: HarnessAttachment; status: number; message: string }[] = [
            {
                attachment: malformed,
                status: 400,
                message: 'attachments[0].data must be canonical base64 (no data: prefix or whitespace).'
            },
            {
                attachment: mismatch,
                status: 415,
                message:
                    'attachments[0].data does not match its declared MIME "image/png" (magic signature mismatch).'
            },
            {
                attachment: oversized,
                status: 413,
                message: `attachments[0].data is ${MAX_ATTACHMENT_BYTES + 1} bytes, above the ${MAX_ATTACHMENT_BYTES}-byte attachment limit.`
            }
        ];

        for (const entry of cases) {
            let thrown: unknown;
            try {
                await runtime.store.enqueue(created.id, 'x', [entry.attachment]);
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(SessionError);
            expect((thrown as SessionError).status).toBe(entry.status);
            expect((thrown as SessionError).message).toBe(entry.message);
            expect(runtime.store.get(created.id).turns).toEqual(baseline);
        }

        await expect(runtime.store.enqueue(created.id, 'x', tooMany)).rejects.toThrow(
            'attachments may contain at most 4 entries; received 5.'
        );
        expect(runtime.store.get(created.id).turns).toEqual(baseline);
    });

    it('rejects a turn whose attachments exceed the total byte budget', async () => {
        const runtime = runtimeOf(recordingPreset('media', []));
        const created = await runtime.store.create('media');

        // Three clips under the per-clip cap but together over the 8 MiB budget.
        const each = Math.ceil((8 * 1024 * 1024) / 3) + 1;
        const attachments = Array.from({ length: 3 }, (_, index) =>
            imageAttachment({
                id: `image-${index + 1}`,
                marker: `[Image ${index + 1}]`,
                name: `big-${index + 1}.png`,
                size: each,
                data: pngData(each)
            })
        );

        await expect(runtime.store.enqueue(created.id, 'x', attachments)).rejects.toThrow(
            `attachments total ${each * 3} bytes, above the ${8 * 1024 * 1024}-byte per-turn limit.`
        );
        expect(runtime.store.get(created.id).turns).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// HTTP contract and the route-aware body cap
// ---------------------------------------------------------------------------

describe('submit routes over HTTP', () => {
    it('carries an attachment-only prompt through the canonical submit', async () => {
        const seen: SeenTurn[] = [];
        const runtime = runtimeOf(recordingPreset('media', seen));
        const session = await createSession(runtime, 'media');
        const attachment = imageAttachment();
        const call = callOf(runtime);

        // T13: `/messages` (a streaming legacy submit) is gone. One route, one answer: a
        // 202 receipt that names the turn, plus the named reads for its members.
        const accepted = await submitTask(call, session.id, {
            input: '   ',
            attachments: [attachment]
        });

        expect(accepted.session_id).toBe(session.id);
        expect(accepted.thread_id).toBe('thread-1');
        expect(accepted.links.turn).toBe(
            `/v1/harness/sessions/${session.id}/turns/${accepted.turn_id}`
        );

        await runtime.store.waitForIdle(session.id);

        // The turn read carries the CHIP (metadata + `has_bytes`), never the base64.
        const turn = await readTurn(call, session.id, accepted.turn_id);

        expect(turn).toMatchObject({
            index: 0,
            prompt: '',
            thread_id: 'thread-1',
            thread_label: 'MA1',
            status: 'done',
            attachment_count: 1,
            attachments: [descriptorOf(attachment)]
        });

        // The bytes are their own read, and they arrive intact.
        expect(await readTurnAttachment(call, session.id, accepted.turn_id, attachment.id)).toEqual(
            attachment
        );

        // The clip is what the model path actually received — the domain the old SSE
        // terminal snapshot proved. Note the two different carriers, both exact: the turn
        // RECORD keeps the trimmed prompt (`''`, asserted above), while the user MESSAGE
        // handed to the harness carries the attachment MARKER as its text.
        expect(seen).toEqual([{ prompt: '[Image 1]', attachments: [attachment] }]);
    });

    it('accepts attachments on /tasks, keeps the old text-only shape, and rejects bad media with clear statuses', async () => {
        const runtime = runtimeOf(recordingPreset('media', []));
        const session = await createSession(runtime, 'media');
        const call = callOf(runtime);
        const attachment = imageAttachment();

        // Old payload: no `attachments` key reaches the turn. On the canonical surface the
        // submit answers a receipt whose key set is fixed, and the READ of that turn is the
        // place an `attachments` member could appear.
        const legacy = await submitTask(call, session.id, { input: 'plain text' });

        expect(Object.keys(legacy).sort()).toEqual([
            'accepted_at',
            'links',
            'session_id',
            'session_revision',
            'status',
            'thread_id',
            'turn_id'
        ]);

        const plainTurn = await readTurn(call, session.id, legacy.turn_id);

        expect(plainTurn).not.toHaveProperty('attachments');
        expect(plainTurn.attachment_count).toBe(0);

        // Attachment-only: blank text is valid because a clip carries the task.
        const media = await submitTask(call, session.id, {
            input: '   ',
            attachments: [attachment]
        });

        // Every unfocused submit opens its own thread (the second submit here).
        expect(media.thread_id).toBe('thread-2');

        const mediaTurn = await readTurn(call, session.id, media.turn_id);

        expect(mediaTurn).toMatchObject({
            index: 1,
            prompt: '',
            thread_id: 'thread-2',
            thread_label: 'MA2',
            attachments: [descriptorOf(attachment)],
            attachment_count: 1
        });

        const malformed = await callApiResult(call, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(session.id), {
            input: 'x',
            attachments: [imageAttachment({ data: '!!' })]
        });

        expect(malformed).toEqual({
            status: 400,
            body: { error: { message: 'attachments[0].data must be canonical base64 (no data: prefix or whitespace).' } }
        });

        const mismatch = await callApiResult(call, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(session.id), {
            input: 'x',
            attachments: [
                imageAttachment({
                    data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64'),
                    size: 8
                })
            ]
        });

        expect(mismatch).toEqual({
            status: 415,
            body: {
                error: {
                    message:
                        'attachments[0].data does not match its declared MIME "image/png" (magic signature mismatch).'
                }
            }
        });

        // Blank input without a clip is still a 400, from the store's own validator.
        const blank = await callApiResult(call, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(session.id), {
            input: '   '
        });

        expect(blank).toEqual({ status: 400, body: { error: { message: 'A task cannot be empty.' } } });

        // The rejected submits never created a turn.
        expect(runtime.store.get(session.id).turns.map((turn) => turn.prompt)).toEqual(['plain text', '']);
    });
});

describe('route body caps', () => {
    it('gives ONLY the canonical submit route the 16 MiB cap', () => {
        // T13: one mount, one submit route. `/messages` is gone from the surface, so the
        // clip-sized cap belongs to `POST /v1/harness/sessions/{id}/tasks` alone.
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/tasks', '/v1/harness')).toBe(
            MAX_SUBMIT_BODY_BYTES
        );

        // A retired path shape keeps the ordinary cap: it is not a submit any more, it is an
        // unknown route (routing answers 404; the cap never gets to matter).
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/messages', '/v1/harness')).toBe(
            MAX_API_BODY_BYTES
        );

        // Everything else keeps the legacy 1 MB cap, including siblings and GET.
        expect(bodyLimitFor('POST', '/v1/harness/models', '/v1/harness')).toBe(MAX_API_BODY_BYTES);
        expect(bodyLimitFor('POST', '/v1/harness/sessions', '/v1/harness')).toBe(MAX_API_BODY_BYTES);
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/reset', '/v1/harness')).toBe(
            MAX_API_BODY_BYTES
        );
        expect(bodyLimitFor('GET', '/v1/harness/sessions/abc/tasks', '/v1/harness')).toBe(
            MAX_API_BODY_BYTES
        );

        // The cap is computed from the MOUNT-RELATIVE path, so it follows the path shape and
        // not the prefix: an unknown stale prefix still classifies by shape, and routing is
        // what refuses it. A sibling of the submit is not a submit.
        expect(bodyLimitFor('POST', '/api/sessions/abc/tasks', '/api')).toBe(MAX_SUBMIT_BODY_BYTES);
        expect(bodyLimitFor('POST', '/api/sessions/abc/tasks/extra', '/api')).toBe(MAX_API_BODY_BYTES);
    });

    it('enforces the submit cap and the legacy cap in the service adapter', async () => {
        const runtime = runtimeOf(recordingPreset('media', []));

        const submit = await callService(runtime, 'POST', '/v1/harness/sessions/abc/tasks', {
            body: {},
            headers: { 'content-length': String(MAX_SUBMIT_BODY_BYTES + 1) }
        });
        expect(submit).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${MAX_SUBMIT_BODY_BYTES} bytes.` } }
        });

        const general = await callService(runtime, 'POST', '/v1/harness/models', {
            body: {},
            headers: { 'content-length': String(MAX_API_BODY_BYTES + 1) }
        });
        expect(general).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${MAX_API_BODY_BYTES} bytes.` } }
        });
    });

    it('streams a >1 MB submit body through the Node adapter but still caps it at 16 MiB', async () => {
        const runtime = runtimeOf(recordingPreset('media', []));
        const session = await createSession(runtime, 'media');
        const call = callOf(runtime);

        // ~1.2 MiB decoded → ~1.6 MB JSON: above the legacy 1 MB cap, below 16 MiB.
        const large = imageAttachment({
            size: 1_200_000,
            data: pngData(1_200_000)
        });
        const accepted = await runNodeHandler(
            runtime,
            'POST',
            `/v1/harness/sessions/${session.id}/tasks`,
            [Buffer.from(JSON.stringify({ input: '', attachments: [large] }))]
        );

        expect(accepted.status).toBe(202);

        // The canonical answer is a receipt. The clip's survival is proved where its bytes
        // live: the attachment route serves them verbatim, and the turn read states the
        // count plus `has_bytes` rather than shipping the base64 inline.
        const receipt = accepted.body as { turn_id: string };

        expect(await readTurnAttachment(call, session.id, receipt.turn_id, large.id)).toEqual(large);
        expect(await readTurn(call, session.id, receipt.turn_id)).toMatchObject({
            attachment_count: 1,
            attachments: [descriptorOf(large)]
        });

        // One byte over the submit cap is refused while streaming (the request
        // body is not buffered first).
        const oversized = await runNodeHandler(
            runtime,
            'POST',
            `/v1/harness/sessions/${session.id}/tasks`,
            [Buffer.alloc(MAX_SUBMIT_BODY_BYTES + 1, 0x20)]
        );
        expect(oversized).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${MAX_SUBMIT_BODY_BYTES} bytes.` } }
        });

        // A non-submit route keeps the old 1 MB streamed cap.
        const general = await runNodeHandler(runtime, 'POST', '/v1/harness/models', [
            Buffer.alloc(MAX_API_BODY_BYTES + 1, 0x20)
        ]);
        expect(general).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${MAX_API_BODY_BYTES} bytes.` } }
        });

        // T13: a stale prefix is not mounted, and the Node adapter goes further than the
        // dispatcher — it does not answer at all, leaving the request to the host app (the
        // fake response above therefore records no status write). The in-process dispatcher
        // is what answers 404 and NAMES the canonical root (see the service-adapter case in
        // `enforces the submit cap...`, and ./transcript.test.ts for the 404 body).
        const stale = await runNodeHandler(runtime, 'POST', `/api/sessions/${session.id}/tasks`, [
            Buffer.from(JSON.stringify({ input: 'stale' }))
        ]);

        expect(stale.status).toBe(0);
        expect(stale.body).toBeUndefined();
        expect(runtime.store.get(session.id).turns.map((turn) => turn.prompt)).not.toContain('stale');
    });
});
