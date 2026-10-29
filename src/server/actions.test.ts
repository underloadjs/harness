// N4 server interaction: host answerer wiring + POST /actions/:requestId/answer.
//
// These tests run entirely against injected scripted presets. The preset factory
// captures the `interaction.actionRequest` handler the SessionStore installs, which
// is exactly the object the runtime would await. No provider, no network, and no
// runtime implementation is needed: the store's pending map, validation, status
// mapping, and teardown semantics are the contract under test.
//
// Deterministic assertions: every status, error message, and resolved choice is
// asserted exactly. Request ids and option ids are literals, so a failure cannot
// hide behind a range check.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type {
    HarnessActionHandler,
    HarnessActionRequest,
    HarnessActionRequestContext,
    HarnessStream,
    HarnessStreamEvent
} from '../harness';
import type { HarnessPreset, HarnessPresetReport, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry, describeHarness } from './harnesses';
import { createToolboxHarness } from './harnesses/toolbox';
import { presetToRecord } from './harnesses/registry';
import { createHarnessApi } from './api';
import type { HarnessApiResult } from './api';
import { HARNESS_DATABASE_VERSION } from './persistence';
import type { HarnessSessionRecord } from './persistence';
import { SessionError, SessionStore } from './sessions';

const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'unused',
    model: 'scripted/test'
};

const API_DEFAULTS = {
    baseURL: 'http://scripted.invalid/v1',
    model: 'scripted/test',
    hasApiKey: false
};

// A transport that answers immediately, used for the "answer while busy" test.
const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

const presetOf = (
    name: string,
    create: HarnessPreset['create'],
    agents: readonly string[] = [name]
): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: agents[0] ?? name,
    subagents: agents.slice(1),
    agents,
    tools: [],
    builtin: true,
    editable: true,
    create
});

// The request the runtime would hand the host. Two options are enough to pin the
// "recommended must be a real option" and "choice must name an offered option"
// contracts.
const requestOf = (requestId: string): HarnessActionRequest => ({
    requestId,
    question: 'Which path should I take?',
    recommended: 'a',
    allowCustom: true,
    options: [
        { id: 'a', label: 'Path A', description: 'The recommended path' },
        { id: 'b', label: 'Path B' }
    ]
});

const contextOf = (
    requestId: string,
    overrides: Partial<HarnessActionRequestContext> = {}
): HarnessActionRequestContext => ({
    requestId,
    agent: 'worker',
    callId: 'call-1',
    request: requestOf(requestId),
    ...overrides
});

// Capture the handler the store installs while still returning a real harness so
// SessionStore.create/restore follow their normal paths.
const capturePreset = (
    options: { stream?: HarnessStream } = {}
): HarnessPreset & { captured: { handler?: HarnessActionHandler } } => {
    const captured: { handler?: HarnessActionHandler } = {};

    return {
        ...presetOf('worker', (settings, progress, report?: HarnessPresetReport) => {
            captured.handler = report?.interaction?.actionRequest;

            return harness({
                agents: {
                    worker: agent({
                        model: settings.model,
                        instruction: 'Scripted interaction test agent.',
                        stream: options.stream ?? answerStream('done')
                    })
                },
                primary: 'worker',
                presets: false,
                report: { progress }
            });
        }),
        captured
    };
};

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
};

// Small helper: run one store operation and return the thrown SessionError so the
// test can pin both its status and its exact message.
const sessionErrorOf = (run: () => unknown): SessionError => {
    try {
        run();
    } catch (error) {
        if (error instanceof SessionError) return error;
        throw error;
    }

    throw new Error('expected a SessionError');
};

const jsonOf = (result: HarnessApiResult): Extract<HarnessApiResult, { kind: 'json' }> => {
    if (result.kind !== 'json') throw new Error('expected a JSON result');
    return result;
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe('SessionStore owner interaction', () => {
    it('forwards the host answerer through the shared toolbox into the harness config', () => {
        const handler: HarnessActionHandler = async () => ({ kind: 'custom', text: 'x' });
        const agents = {
            worker: agent({
                model: DEFAULTS.model,
                instruction: 'Scripted toolbox probe.',
                stream: answerStream('done')
            })
        };

        const withInteraction = createToolboxHarness({ agents, primary: 'worker' }, DEFAULTS, () => undefined, {
            interaction: { actionRequest: handler }
        });
        expect(withInteraction.tools.actionRequest.visibility).toBe('core');
        expect(withInteraction.tools.actionRequest.name).toBe('actionRequest');

        // Forks are on by default (N6), so threadFork is declared either way.
        expect(withInteraction.tools.threadFork.visibility).toBe('core');

        // No interaction report -> the runtime does not register actionRequest.
        const withoutInteraction = createToolboxHarness({ agents, primary: 'worker' }, DEFAULTS, () => undefined);
        expect(withoutInteraction.tools.actionRequest).toBeUndefined();
    });

    it('answers a real harness actionRequest mid-run through the store', async () => {
        // A real harness (not a captured callback) with the interaction hook
        // forwarded exactly as SessionStore.buildHarness does. The scripted model
        // asks the owner once, then answers after the tool result wakes the run.
        // Background calls are re-requested with a placeholder before the answer
        // arrives, so the stream must not emit the same call id twice.
        let asked = false;
        const stream: HarnessStream = async function* (request) {
            const last = request.messages[request.messages.length - 1];

            if (last !== undefined && last.role === 'tool' && last.name === 'actionRequest') {
                yield { type: 'text', delta: 'resolved' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            if (asked) {
                // Placeholder round while the owner question is outstanding: answer
                // without new calls so the harness pauses on the pending request.
                yield { type: 'text', delta: 'waiting for the owner' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            asked = true;
            yield {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [
                    {
                        id: 'call-action',
                        name: 'actionRequest',
                        arguments: JSON.stringify({
                            question: 'Continue?',
                            recommended: 'yes',
                            options: [
                                { id: 'yes', label: 'Yes' },
                                { id: 'no', label: 'No' }
                            ]
                        })
                    }
                ]
            };
        };

        const preset = presetOf('worker', (settings, progress, report?: HarnessPresetReport) =>
            harness({
                agents: {
                    worker: agent({
                        model: settings.model,
                        instruction: 'Scripted interaction test agent.',
                        stream
                    })
                },
                primary: 'worker',
                presets: false,
                report: { progress },
                ...(report?.interaction === undefined ? {} : { interaction: report.interaction })
            })
        );
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        let announce!: (requestId: string) => void;
        const announced = new Promise<string>((resolve) => {
            announce = resolve;
        });

        const running = store.run(created.id, 'ask the owner', (item) => {
            if (item.type === 'event' && item.event.type === 'action_request') {
                announce(item.event.request.requestId);
            }
        });

        const requestId = await announced;

        // The request frame is emitted BEFORE the runtime schedules the host call
        // (harness.ts launchActionRequest), so yield one macrotask before answering.
        await new Promise<void>((resolve) => setImmediate(resolve));

        store.answerAction(created.id, requestId, { kind: 'option', optionId: 'yes' });
        await running;

        const turn = store.get(created.id).turns[0];
        expect(store.get(created.id).lastError).toBe(undefined);
        expect(turn.status).toBe('done');

        expect(turn.events.find((event) => event.type === 'action_request')).toEqual({
            type: 'action_request',
            agent: 'worker',
            callId: 'call-action',
            request: {
                requestId,
                question: 'Continue?',
                recommended: 'yes',
                allowCustom: true,
                options: [
                    { id: 'yes', label: 'Yes' },
                    { id: 'no', label: 'No' }
                ]
            }
        });

        // The runtime records the accepted owner answer before the tool result.
        expect(turn.events.find((event) => event.type === 'action_answer')).toEqual({
            type: 'action_answer',
            agent: 'worker',
            requestId,
            answer: {
                requestId,
                choice: { kind: 'option', optionId: 'yes' },
                source: 'owner'
            }
        });

        // A repeated answer is now a conflict, not a second resolution.
        const late = sessionErrorOf(() =>
            store.answerAction(created.id, requestId, { kind: 'option', optionId: 'no' })
        );
        expect(late.status).toBe(409);
    });

    it('cancels a run waiting for an owner answer without selecting a choice', async () => {
        let asked = false;
        const stream: HarnessStream = async function* () {
            if (asked) {
                yield { type: 'text', delta: 'paused' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            asked = true;
            yield {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [
                    {
                        id: 'call-action-cancel',
                        name: 'actionRequest',
                        arguments: JSON.stringify({
                            question: 'Cancel me?',
                            recommended: 'yes',
                            options: [
                                { id: 'yes', label: 'Yes' },
                                { id: 'no', label: 'No' }
                            ]
                        })
                    }
                ]
            };
        };

        const preset = presetOf('worker', (settings, progress, report?: HarnessPresetReport) =>
            harness({
                agents: {
                    worker: agent({
                        model: settings.model,
                        instruction: 'Scripted interaction test agent.',
                        stream
                    })
                },
                primary: 'worker',
                presets: false,
                report: { progress },
                ...(report?.interaction === undefined ? {} : { interaction: report.interaction })
            })
        );
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        let announce!: (requestId: string) => void;
        const announced = new Promise<string>((resolve) => {
            announce = resolve;
        });

        const running = store.run(created.id, 'ask then cancel', (item) => {
            if (item.type === 'event' && item.event.type === 'action_request') {
                announce(item.event.request.requestId);
            }
        });

        const requestId = await announced;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(store.cancel(created.id)).toBe(true);
        await running;

        const turn = store.get(created.id).turns[0];
        expect(turn.status).toBe('cancelled');
        expect(turn.events.some((event) => event.type === 'action_answer')).toBe(false);

        // Cancellation expired the pending entry; no default/recommended answer exists.
        const late = sessionErrorOf(() =>
            store.answerAction(created.id, requestId, { kind: 'option', optionId: 'yes' })
        );
        expect(late.status).toBe(409);
    });

    it('registers the host answerer on every created session and resolves an option answer', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        expect(typeof preset.captured.handler).toBe('function');

        const awaiting = preset.captured.handler!(contextOf('req-1'), new AbortController().signal);

        store.answerAction(created.id, 'req-1', { kind: 'option', optionId: 'b' });

        await expect(awaiting).resolves.toEqual({ kind: 'option', optionId: 'b' });

        // Exactly once: the entry left the pending map, and the id is now recorded
        // as no-longer-answerable rather than unknown.
        const repeated = sessionErrorOf(() =>
            store.answerAction(created.id, 'req-1', { kind: 'option', optionId: 'a' })
        );
        expect(repeated.status).toBe(409);
        expect(repeated.message).toBe('Action request "req-1" was already answered or has expired.');
    });

    it('trims and accepts a custom answer', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const awaiting = preset.captured.handler!(contextOf('req-custom'), new AbortController().signal);

        store.answerAction(created.id, 'req-custom', { kind: 'custom', text: '  Do it now  ' });

        await expect(awaiting).resolves.toEqual({ kind: 'custom', text: 'Do it now' });
    });

    it('rejects an option id the model never offered with 400 and keeps the request answerable', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const awaiting = preset.captured.handler!(contextOf('req-2'), new AbortController().signal);

        const malformed = sessionErrorOf(() =>
            store.answerAction(created.id, 'req-2', { kind: 'option', optionId: 'zzz' })
        );
        expect(malformed.status).toBe(400);
        expect(malformed.message).toBe(
            'actionRequest choice optionId "zzz" is not one of the request\'s option ids: a, b.'
        );

        // Nothing was consumed by the rejected body.
        store.answerAction(created.id, 'req-2', { kind: 'option', optionId: 'a' });
        await expect(awaiting).resolves.toEqual({ kind: 'option', optionId: 'a' });
    });

    it('rejects a non-object choice with 400', () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        void preset.captured.handler!(contextOf('req-3'), new AbortController().signal);

        const malformed = sessionErrorOf(() => store.answerAction(created.id, 'req-3', null));
        expect(malformed.status).toBe(400);
        expect(malformed.message).toBe('actionRequest choice must be an object.');
    });

    it('answers 404 for an unknown request and unknown session', () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const unknownRequest = sessionErrorOf(() =>
            store.answerAction(created.id, 'never-seen', { kind: 'custom', text: 'x' })
        );
        expect(unknownRequest.status).toBe(404);
        expect(unknownRequest.message).toBe('Unknown action request "never-seen".');

        const unknownSession = sessionErrorOf(() =>
            store.answerAction('missing-session', 'never-seen', { kind: 'custom', text: 'x' })
        );
        expect(unknownSession.status).toBe(404);
        expect(unknownSession.message).toBe('Unknown session "missing-session".');
    });

    it('bounds a session at four unanswered questions and settles all four', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const first = preset.captured.handler!(contextOf('req-a'), new AbortController().signal);
        const second = preset.captured.handler!(contextOf('req-b'), new AbortController().signal);
        const third = preset.captured.handler!(contextOf('req-c'), new AbortController().signal);
        const fourth = preset.captured.handler!(contextOf('req-d'), new AbortController().signal);

        const fifth = preset.captured.handler!(contextOf('req-e'), new AbortController().signal);
        await expect(fifth).rejects.toThrow(
            'This session already has 4 unanswered action requests; answer one before asking another.'
        );

        // The refused request was still announced by the runtime, so its card is
        // expired (409), not unknown (404).
        const refused = sessionErrorOf(() =>
            store.answerAction(created.id, 'req-e', { kind: 'option', optionId: 'a' })
        );
        expect(refused.status).toBe(409);
        expect(refused.message).toBe('Action request "req-e" was already answered or has expired.');

        store.answerAction(created.id, 'req-a', { kind: 'option', optionId: 'a' });
        store.answerAction(created.id, 'req-b', { kind: 'option', optionId: 'a' });
        store.answerAction(created.id, 'req-c', { kind: 'option', optionId: 'a' });
        store.answerAction(created.id, 'req-d', { kind: 'option', optionId: 'a' });

        await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([
            { kind: 'option', optionId: 'a' },
            { kind: 'option', optionId: 'a' },
            { kind: 'option', optionId: 'a' },
            { kind: 'option', optionId: 'a' }
        ]);
    });

    it('expires the pending answer when the run signal aborts, settling once', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const controller = new AbortController();
        const awaiting = preset.captured.handler!(contextOf('req-abort'), controller.signal);

        controller.abort();

        await expect(awaiting).rejects.toThrow(
            'The action request was cancelled before the owner answered. Ask again only if the question is still required.'
        );

        const late = sessionErrorOf(() =>
            store.answerAction(created.id, 'req-abort', { kind: 'option', optionId: 'a' })
        );
        expect(late.status).toBe(409);
        expect(late.message).toBe('Action request "req-abort" was already answered or has expired.');
    });

    it('answers while the session is busy (the run is awaiting the answer)', async () => {
        const gate = deferred();
        const preset = capturePreset({
            stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                await gate.promise;
                yield { type: 'text', delta: 'finished' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
            }
        });
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const running = store.run(created.id, 'hold the run open', () => undefined);
        await Promise.resolve();

        const awaiting = preset.captured.handler!(contextOf('req-busy'), new AbortController().signal);

        // No busy gate on this route: the answer must resolve while the turn runs.
        store.answerAction(created.id, 'req-busy', { kind: 'option', optionId: 'a' });
        await expect(awaiting).resolves.toEqual({ kind: 'option', optionId: 'a' });

        gate.resolve();
        await running;

        expect(store.get(created.id).turns[0].status).toBe('done');
    });

    it('rejects pending answers when the session is removed', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const awaiting = preset.captured.handler!(contextOf('req-remove'), new AbortController().signal);

        expect(store.remove(created.id)).toBe(true);

        await expect(awaiting).rejects.toThrow('The session was removed before the action request was answered.');

        const gone = sessionErrorOf(() =>
            store.answerAction(created.id, 'req-remove', { kind: 'option', optionId: 'a' })
        );
        expect(gone.status).toBe(404);
        expect(gone.message).toBe(`Unknown session "${created.id}".`);
    });

    it('rejects pending answers when the store is disposed', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        store.create('worker');

        const awaiting = preset.captured.handler!(contextOf('req-dispose'), new AbortController().signal);

        store.dispose();

        await expect(awaiting).rejects.toThrow('The session was removed before the action request was answered.');
        expect(store.size).toBe(0);
    });

    it('restores a session with every recorded question already expired', () => {
        const preset = capturePreset();
        const built = preset.create(DEFAULTS, () => undefined);

        const record: HarnessSessionRecord = {
            id: 'restored-session',
            harness: 'worker',
            preset: presetToRecord(preset),
            definition: describeHarness(preset),
            settings: { baseURL: DEFAULTS.baseURL, model: DEFAULTS.model },
            status: 'idle',
            createdAt: 1,
            updatedAt: 2,
            turns: [
                {
                    id: 'turn-1',
                    index: 0,
                    prompt: 'ask first',
                    status: 'done',
                    startedAt: 1,
                    updatedAt: 2,
                    events: [
                        {
                            type: 'action_request',
                            agent: 'worker',
                            callId: 'call-1',
                            request: requestOf('req-restored')
                        },
                        {
                            type: 'action_answer',
                            agent: 'worker',
                            requestId: 'req-restored',
                            answer: {
                                requestId: 'req-restored',
                                choice: { kind: 'option', optionId: 'a' },
                                source: 'owner'
                            }
                        }
                    ],
                    eventTimes: [1, 2]
                }
            ],
            queue: [],
            core: built.snapshot()
        };

        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]), (entry) => describeHarness(entry), {
            database: {
                version: HARNESS_DATABASE_VERSION,
                savedAt: 3,
                registry: [presetToRecord(preset)],
                sessions: [record]
            }
        });

        // The runtime that was awaiting this request did not survive the restart,
        // so the question is expired (409) instead of answerable or unknown.
        const expired = sessionErrorOf(() =>
            store.answerAction('restored-session', 'req-restored', {
                kind: 'option',
                optionId: 'a'
            })
        );
        expect(expired.status).toBe(409);
        expect(expired.message).toBe('Action request "req-restored" was already answered or has expired.');
    });
});

describe('POST /sessions/:id/actions/:requestId/answer', () => {
    const route = (sessionId: string, requestId: string): string =>
        `/api/sessions/${sessionId}/actions/${requestId}/answer`;

    const call = async (
        store: SessionStore,
        preset: HarnessPreset,
        sessionId: string,
        requestId: string,
        body: unknown
    ): Promise<HarnessApiResult> => {
        const api = createHarnessApi({
            store,
            defaults: API_DEFAULTS,
            registry: createHarnessRegistry([preset])
        });

        return api({
            method: 'POST',
            pathname: route(sessionId, requestId),
            mount: '/api',
            readBody: async <T>() => body as T
        });
    };

    it('answers { ok: true } for a valid option choice', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const awaiting = preset.captured.handler!(contextOf('req-api'), new AbortController().signal);

        const result = jsonOf(
            await call(store, preset, created.id, 'req-api', {
                choice: { kind: 'option', optionId: 'b' }
            })
        );

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ ok: true });
        await expect(awaiting).resolves.toEqual({ kind: 'option', optionId: 'b' });
    });

    it('maps unknown request 404, repeated answer 409, malformed 400, unknown session 404', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        void preset.captured.handler!(contextOf('req-api-2'), new AbortController().signal);

        const malformed = jsonOf(
            await call(store, preset, created.id, 'req-api-2', {
                choice: { kind: 'option', optionId: 'missing' }
            })
        );
        expect(malformed.status).toBe(400);
        expect(malformed.body).toEqual({
            error: {
                message: 'actionRequest choice optionId "missing" is not one of the request\'s option ids: a, b.'
            }
        });

        // The rejected body did not consume the request.
        const accepted = jsonOf(
            await call(store, preset, created.id, 'req-api-2', {
                choice: { kind: 'custom', text: 'answered' }
            })
        );
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ ok: true });

        const repeated = jsonOf(
            await call(store, preset, created.id, 'req-api-2', {
                choice: { kind: 'custom', text: 'again' }
            })
        );
        expect(repeated.status).toBe(409);
        expect(repeated.body).toEqual({
            error: { message: 'Action request "req-api-2" was already answered or has expired.' }
        });

        const unknownRequest = jsonOf(
            await call(store, preset, created.id, 'never-seen', {
                choice: { kind: 'custom', text: 'x' }
            })
        );
        expect(unknownRequest.status).toBe(404);
        expect(unknownRequest.body).toEqual({
            error: { message: 'Unknown action request "never-seen".' }
        });

        const unknownSession = jsonOf(
            await call(store, preset, 'missing-session', 'never-seen', {
                choice: { kind: 'custom', text: 'x' }
            })
        );
        expect(unknownSession.status).toBe(404);
        expect(unknownSession.body).toEqual({
            error: { message: 'Unknown session "missing-session".' }
        });
    });

    it('rejects a body without a choice and a body with an unknown field', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');

        const missing = jsonOf(await call(store, preset, created.id, 'req-api-3', {}));
        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({
            error: { message: 'An action answer requires a `choice`.' }
        });

        const extra = jsonOf(
            await call(store, preset, created.id, 'req-api-3', {
                choice: { kind: 'custom', text: 'x' },
                source: 'owner'
            })
        );
        expect(extra.status).toBe(400);
        expect(extra.body).toEqual({
            error: { message: 'Unknown field "source". Allowed fields: choice.' }
        });
    });

    it('rejects the GET method with 405', async () => {
        const preset = capturePreset();
        const store = new SessionStore(DEFAULTS, createHarnessRegistry([preset]));
        const created = store.create('worker');
        const api = createHarnessApi({
            store,
            defaults: API_DEFAULTS,
            registry: createHarnessRegistry([preset])
        });

        const result = jsonOf(
            await api({
                method: 'GET',
                pathname: route(created.id, 'req-1'),
                mount: '/api',
                readBody: async <T>() => ({}) as T
            })
        );

        expect(result.status).toBe(405);
        expect(result.body).toEqual({
            error: {
                message: 'Use POST for /api/sessions/:id/actions/:requestId/answer.'
            }
        });
    });
});
