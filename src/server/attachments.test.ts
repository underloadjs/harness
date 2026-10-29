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
//   - /tasks and /messages alone get the 16 MiB body cap on both adapters;
//     every other route keeps the 1 MB cap.

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
        const created = runtime.store.create('media');
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
        const created = runtime.store.create('media');
        const attachment = imageAttachment();

        const task = runtime.store.enqueue(created.id, '  Look at [Image 1]  ', [attachment]);

        // The accepted 202 copy is detached: mutating it cannot rewrite the turn.
        expect(task.turn).toEqual({
            id: task.turn.id,
            index: 0,
            prompt: 'Look at [Image 1]',
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
        const created = first.store.create('gated');
        const attachment = imageAttachment();

        // Hold the legacy run so the attachment task stays queued on disk.
        void first.store.run(created.id, 'hold', async () => {});
        await fixture.started;

        const queued = first.store.enqueue(created.id, '', [attachment]);
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

        // Starting the pump with a new submit executes the restored turn FIRST,
        // with its persisted bytes, and only then the new text turn.
        const kick = second.store.enqueue(created.id, 'after restart');
        await kick.settled;

        expect(seen).toEqual([
            { prompt: 'hold' },
            { prompt: '', attachments: [attachment] },
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
        const created = runtime.store.create('media');

        expect(() => runtime.store.enqueue(created.id, '   ')).toThrow(SessionError);
        expect(() => runtime.store.enqueue(created.id, '   ')).toThrow('A task cannot be empty.');
        expect(() => runtime.store.enqueue(created.id, 'x'.repeat(200_001), [imageAttachment()])).toThrow(
            'A task cannot exceed 200000 characters.'
        );
        expect(runtime.store.get(created.id).turns).toEqual([]);

        const task = runtime.store.enqueue(created.id, '   ', [imageAttachment()]);
        expect(task.turn.prompt).toBe('');
        await task.settled;
        expect(seen).toEqual([{ prompt: '', attachments: [imageAttachment()] }]);
    });

    it('maps malformed, wrong-signature, and oversized media to 400/415/413 with nothing queued', async () => {
        const runtime = runtimeOf(recordingPreset('media', []));
        const created = runtime.store.create('media');
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
                runtime.store.enqueue(created.id, 'x', [entry.attachment]);
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(SessionError);
            expect((thrown as SessionError).status).toBe(entry.status);
            expect((thrown as SessionError).message).toBe(entry.message);
            expect(runtime.store.get(created.id).turns).toEqual(baseline);
        }

        expect(() => runtime.store.enqueue(created.id, 'x', tooMany)).toThrow(
            'attachments may contain at most 4 entries; received 5.'
        );
        expect(runtime.store.get(created.id).turns).toEqual(baseline);
    });

    it('rejects a turn whose attachments exceed the total byte budget', () => {
        const runtime = runtimeOf(recordingPreset('media', []));
        const created = runtime.store.create('media');

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

        expect(() => runtime.store.enqueue(created.id, 'x', attachments)).toThrow(
            `attachments total ${each * 3} bytes, above the ${8 * 1024 * 1024}-byte per-turn limit.`
        );
        expect(runtime.store.get(created.id).turns).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// HTTP contract and the route-aware body cap
// ---------------------------------------------------------------------------

describe('submit routes over HTTP', () => {
    it('carries an attachment-only prompt through the legacy /messages stream', async () => {
        const seen: SeenTurn[] = [];
        const runtime = runtimeOf(recordingPreset('media', seen));
        const session = await createSession(runtime, 'media');
        const attachment = imageAttachment();

        const result = await callService(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
            body: { input: '   ', attachments: [attachment] }
        });
        expect(result.status).toBe(200);
        expect(result.raw).toBeDefined();

        const items = sseItems(await result.raw!.text()) as {
            type: string;
            session?: SessionSnapshot;
        }[];
        const terminal = items[items.length - 1];
        expect(terminal?.type).toBe('snapshot');
        expect(terminal?.session?.turns[0]?.attachments).toEqual([attachment]);
        expect(seen).toEqual([{ prompt: '', attachments: [attachment] }]);
    });

    it('accepts attachments on /tasks, keeps the old text-only shape, and rejects bad media with clear statuses', async () => {
        const runtime = runtimeOf(recordingPreset('media', []));
        const session = await createSession(runtime, 'media');
        const attachment = imageAttachment();

        // Old payload: no `attachments` key reaches the turn.
        const legacy = await callService(runtime, 'POST', `/v1/harness/sessions/${session.id}/tasks`, {
            body: { input: 'plain text' }
        });
        expect(legacy.status).toBe(202);
        expect(Object.keys((legacy.body as { turn: object }).turn).sort()).toEqual(
            ['eventTimes', 'events', 'id', 'index', 'prompt', 'status', 'updatedAt'].sort()
        );

        // Attachment-only: blank text is valid because a clip carries the task.
        const media = await callService(runtime, 'POST', `/v1/harness/sessions/${session.id}/tasks`, {
            body: { input: '   ', attachments: [attachment] }
        });
        expect(media.status).toBe(202);
        expect((media.body as { turn: { prompt: string; attachments: HarnessAttachment[] } }).turn).toEqual({
            id: expect.any(String),
            index: 1,
            prompt: '',
            attachments: [attachment],
            status: 'queued',
            updatedAt: expect.any(Number),
            events: [],
            eventTimes: []
        });

        const malformed = await callService(runtime, 'POST', `/v1/harness/sessions/${session.id}/tasks`, {
            body: { input: 'x', attachments: [imageAttachment({ data: '!!' })] }
        });
        expect(malformed).toEqual({
            status: 400,
            body: { error: { message: 'attachments[0].data must be canonical base64 (no data: prefix or whitespace).' } }
        });

        const mismatch = await callService(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
            body: {
                input: 'x',
                attachments: [
                    imageAttachment({
                        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString('base64'),
                        size: 8
                    })
                ]
            }
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

        // Blank /messages without a clip stays the legacy 400, before a stream.
        const blank = await callService(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
            body: { input: '   ' }
        });
        expect(blank).toEqual({ status: 400, body: { error: { message: 'A task cannot be empty.' } } });

        // The rejected submits never created a turn.
        expect(runtime.store.get(session.id).turns.map((turn) => turn.prompt)).toEqual(['plain text', '']);
    });
});

describe('route body caps', () => {
    it('gives only /tasks and /messages the 16 MiB cap on both mounts', () => {
        expect(bodyLimitFor('POST', '/api/sessions/abc/tasks', '/api')).toBe(MAX_SUBMIT_BODY_BYTES);
        expect(bodyLimitFor('POST', '/api/sessions/abc/messages', '/api')).toBe(MAX_SUBMIT_BODY_BYTES);
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/tasks', '/v1/harness')).toBe(
            MAX_SUBMIT_BODY_BYTES
        );
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/messages', '/v1/harness')).toBe(
            MAX_SUBMIT_BODY_BYTES
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

        // ~1.2 MiB decoded → ~1.6 MB JSON: above the legacy 1 MB cap, below 16 MiB.
        const large = imageAttachment({
            size: 1_200_000,
            data: pngData(1_200_000)
        });
        const accepted = await runNodeHandler(
            runtime,
            'POST',
            `/api/sessions/${session.id}/tasks`,
            [Buffer.from(JSON.stringify({ input: '', attachments: [large] }))]
        );
        expect(accepted.status).toBe(202);
        expect((accepted.body as { turn: { attachments: HarnessAttachment[] } }).turn.attachments).toEqual([
            large
        ]);

        // One byte over the submit cap is refused while streaming (the request
        // body is not buffered first).
        const oversized = await runNodeHandler(
            runtime,
            'POST',
            `/api/sessions/${session.id}/tasks`,
            [Buffer.alloc(MAX_SUBMIT_BODY_BYTES + 1, 0x20)]
        );
        expect(oversized).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${MAX_SUBMIT_BODY_BYTES} bytes.` } }
        });

        // A non-submit route keeps the old 1 MB streamed cap.
        const general = await runNodeHandler(runtime, 'POST', '/api/models', [
            Buffer.alloc(MAX_API_BODY_BYTES + 1, 0x20)
        ]);
        expect(general).toEqual({
            status: 413,
            body: { error: { message: `A request body cannot exceed ${MAX_API_BODY_BYTES} bytes.` } }
        });
    });
});
