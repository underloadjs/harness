// Session-level result references (T4 / R2).
//
// Everything runs offline against injected scripted presets. The clock is pinned
// where timestamps matter; prompts, reference bindings, injected context, and turn
// statuses are asserted EXACTLY.
//
// Coverage map (acceptance evidence):
//   - a fresh turn does not inherit the previous user message;
//   - an explicit root reference injects the terminal `done` content;
//   - a typed `#LABEL` without metadata resolves the LATEST prior block;
//   - a still-streaming target binds at enqueue and expands after completion;
//   - a nested/subagent block is addressable by thread id;
//   - failed/cancelled/missing/malformed references are rejected clearly;
//   - references survive a persistence restart and still expand afterwards;
//   - the /tasks HTTP route forwards references and maps a bad binding to 400;
//   - the existing 200k input bound still applies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessMessage, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HarnessPersistence } from './persistence';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { SessionError, SessionStore } from './sessions';
import {
    REFERENCED_RESULTS_BUDGET_MESSAGE,
    REFERENCED_RESULTS_FOOTER,
    REFERENCED_RESULTS_HEADER,
    listAgentResultBlocks
} from '../shared/agent-results';
import type { SessionSnapshot, SessionTurn } from './protocol';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-references-${label}-`));
    roots.push(root);
    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
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

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const lastUser = (messages: readonly HarnessMessage[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];
    return last === undefined ? '' : String(last.content);
};

const copyMessages = (messages: readonly HarnessMessage[]): HarnessMessage[] =>
    JSON.parse(JSON.stringify(messages)) as HarnessMessage[];

type RecordedRequest = { agent: string; messages: HarnessMessage[] };

type Probe = {
    preset: HarnessPreset;
    requests: RecordedRequest[];
    started: (prompt: string) => { promise: Promise<void>; resolve: () => void };
    gate: (prompt: string) => { promise: Promise<void>; resolve: () => void };
};

// One scripted agent that records every request transcript. `BOOM` fails the run;
// `hold one`/`hold two` park inside the transport until the test releases them, so
// a reference can be submitted while the target is genuinely streaming.
const probeFixture = (): Probe => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const starts = new Map<string, ReturnType<typeof deferred>>();
    const requests: RecordedRequest[] = [];
    let answered = 0;

    const gate = (prompt: string) => {
        const existing = gates.get(prompt);
        if (existing !== undefined) return existing;
        const created = deferred();
        gates.set(prompt, created);
        return created;
    };

    const started = (prompt: string) => {
        const existing = starts.get(prompt);
        if (existing !== undefined) return existing;
        const created = deferred();
        starts.set(prompt, created);
        return created;
    };

    const preset = presetOf('probe', (settings, progress) =>
        harness({
            agents: {
                probe: agent({
                    model: settings.model,
                    instruction: 'Answer every prompt deterministically.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const prompt = lastUser(request.messages);
                        requests.push({ agent: 'probe', messages: copyMessages(request.messages) });

                        if (prompt.startsWith('BOOM')) {
                            yield { type: 'error', message: 'scripted failure' };
                            return;
                        }

                        if (prompt.startsWith('hold ')) {
                            started(prompt).resolve();
                            await new Promise<void>((resolve, reject) => {
                                if (request.signal?.aborted === true) {
                                    reject(new Error('The run was aborted.'));
                                    return;
                                }

                                request.signal?.addEventListener(
                                    'abort',
                                    () => reject(new Error('The run was aborted.')),
                                    { once: true }
                                );
                                gate(prompt).promise.then(resolve, reject);
                            });
                        }

                        answered += 1;
                        const answer = `answer ${answered}`;
                        yield { type: 'text', delta: answer };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'probe',
            presets: false,
            report: { progress }
        })
    );

    return { preset, requests, started, gate };
};

// Lead + helper, mirroring the runtime's delegation stream: root `lead` calls
// `agentDelegate`, helper answers, lead then answers. This produces a nested block
// with thread id '2' and label HR1. `helperGate` optionally parks the helper stream
// so a test can submit a reference while the delegated turn is still running.
const teamPreset = (
    requests?: RecordedRequest[],
    helperGate?: { promise: Promise<void> }
): HarnessPreset =>
    presetOf(
        'team',
        (settings, progress) =>
            harness({
                agents: {
                    lead: agent({
                        model: settings.model,
                        instruction: 'Delegate once, then answer.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            requests?.push({ agent: 'lead', messages: copyMessages(request.messages) });
                            const last = request.messages[request.messages.length - 1];

                            if (last !== undefined && last.role === 'tool' && last.name === 'agentDelegate') {
                                yield { type: 'text', delta: 'done by helper' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                                return;
                            }

                            yield {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    {
                                        id: 'call_1',
                                        name: 'agentDelegate',
                                        arguments: '{"agent":"helper","input":"find it"}'
                                    }
                                ]
                            };
                        }
                    }),
                    helper: agent({
                        model: settings.model,
                        instruction: 'Answer the lead.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            requests?.push({ agent: 'helper', messages: copyMessages(request.messages) });
                            if (helperGate !== undefined) await helperGate.promise;
                            yield { type: 'text', delta: 'helper answer' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'lead',
                subagents: ['helper'],
                presets: false,
                report: { progress }
            }),
        ['lead', 'helper']
    );

const createStore = (presets: HarnessPreset[], persistence?: HarnessPersistence): SessionStore =>
    new SessionStore(
        DEFAULTS,
        createHarnessRegistry(presets),
        undefined,
        persistence === undefined ? {} : { persistence }
    );

// Submit one queued task and wait for its completion.
const submit = async (
    store: SessionStore,
    id: string,
    input: string,
    references?: unknown
): Promise<SessionTurn> => {
    const task = store.enqueue(id, input, undefined, references);
    await task.settled;
    await store.waitForIdle(id);
    const turn = store.get(id).turns.find((candidate) => candidate.id === task.turn.id);
    if (turn === undefined) throw new Error('submitted turn is missing');
    return turn;
};

// Poll a condition across macrotasks without depending on a specific number of
// promise ticks (the pump and child delegation settle across several turns).
const waitUntil = async (condition: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    throw new Error('condition was not met in time');
};

// Exact injected prompt for one root block. Hard-coded (not derived from the
// composer) so a format regression is visible.
const injectedPrompt = (prompt: string, label: string, agentName: string, turnId: string, content: string): string =>
    [
        prompt,
        '',
        REFERENCED_RESULTS_HEADER,
        `--- #${label} | agent ${agentName} | turn ${turnId} ---`,
        content,
        `--- end #${label} ---`,
        REFERENCED_RESULTS_FOOTER
    ].join('\n');

describe('fresh server blocks', () => {
    it('does not inherit the previous block user message and injects nothing without a reference', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        await submit(store, created.id, 'first block');
        await submit(store, created.id, 'second block');

        // Each request is system instructions + THIS block's prompt only.
        expect(fixture.requests).toHaveLength(2);
        expect(fixture.requests[0].messages.filter((message) => message.role === 'user')).toEqual([
            { role: 'user', content: 'first block' }
        ]);
        expect(fixture.requests[1].messages.filter((message) => message.role === 'user')).toEqual([
            { role: 'user', content: 'second block' }
        ]);

        // The turn record keeps both prompts (server archive), but the live
        // conversation has only the latest block.
        expect(store.get(created.id).turns.map((turn) => turn.prompt)).toEqual([
            'first block',
            'second block'
        ]);
        expect(store.get(created.id).messages.filter((message) => message.role === 'user')).toEqual([
            { role: 'user', content: 'second block' }
        ]);
    });
});

describe('explicit result references', () => {
    it('binds a root reference at enqueue and injects the completed result', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const first = await submit(store, created.id, 'produce a result');

        // The block descriptor a UI would offer.
        expect(listAgentResultBlocks(store.get(created.id).turns)).toEqual([
            {
                turnId: first.id,
                label: 'PE1',
                agent: 'probe',
                status: 'done',
                content: 'answer 1'
            }
        ]);

        const second = await submit(store, created.id, 'reuse it', [
            { turnId: first.id, label: 'PE1' }
        ]);

        // The user-facing prompt stays raw; the reference is the binding record.
        expect(second.prompt).toBe('reuse it');
        expect(second.references).toEqual([{ turnId: first.id, label: 'PE1' }]);

        // The harness receives the raw prompt plus a delimited context section.
        expect(lastUser(fixture.requests[1].messages)).toBe(
            injectedPrompt('reuse it', 'PE1', 'probe', first.id, 'answer 1')
        );
        // Fresh block: exactly one user message in the request.
        expect(fixture.requests[1].messages.filter((message) => message.role === 'user')).toHaveLength(1);
    });

    it('resolves each typed #LABEL to the conversation-scoped block it names', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const first = await submit(store, created.id, 'first block');
        const second = await submit(store, created.id, 'second block');

        // Conversation-scoped numbering: the second `probe` invocation is PE2, so
        // #PE1 still names turn 1 — one label, one block (R5/R6).
        expect(listAgentResultBlocks(store.get(created.id).turns).map((block) => block.label)).toEqual([
            'PE1',
            'PE2'
        ]);

        const third = await submit(store, created.id, 'reuse #PE1');

        expect(third.references).toEqual([{ turnId: first.id, label: 'PE1' }]);
        expect(lastUser(fixture.requests[2].messages)).toBe(
            injectedPrompt('reuse #PE1', 'PE1', 'probe', first.id, 'answer 1')
        );

        const fourth = await submit(store, created.id, 'reuse #PE2');

        expect(fourth.references).toEqual([{ turnId: second.id, label: 'PE2' }]);
        expect(lastUser(fixture.requests[3].messages)).toBe(
            injectedPrompt('reuse #PE2', 'PE2', 'probe', second.id, 'answer 2')
        );
    });

    it('binds a still-streaming target and expands after it completes', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const firstStarted = fixture.started('hold one');
        const first = store.enqueue(created.id, 'hold one');
        await firstStarted.promise;

        // The target is RUNNING and has only a start event; binding must not read
        // partial content and must not reject the task.
        const second = store.enqueue(created.id, 'use #PE1');
        expect(second.turn.references).toEqual([{ turnId: first.turn.id, label: 'PE1' }]);
        expect(second.session.turns[1].status).toBe('queued');

        // Release the target; FIFO runs the queued task afterwards.
        fixture.gate('hold one').resolve();
        await first.settled;
        await second.settled;
        await store.waitForIdle(created.id);

        expect(lastUser(fixture.requests[1].messages)).toBe(
            injectedPrompt('use #PE1', 'PE1', 'probe', first.turn.id, 'answer 1')
        );
    });

    it('references a nested subagent block by thread id', async () => {
        const requests: RecordedRequest[] = [];
        const store = createStore([teamPreset(requests)]);
        const created = store.create('team');

        const first = await submit(store, created.id, 'delegate please');

        const blocks = listAgentResultBlocks(store.get(created.id).turns);
        expect(blocks).toEqual([
            {
                turnId: first.id,
                label: 'LD1',
                agent: 'lead',
                status: 'done',
                content: 'done by helper'
            },
            {
                turnId: first.id,
                threadId: '2',
                label: 'HR1',
                agent: 'helper',
                status: 'done',
                content: 'helper answer'
            }
        ]);

        const second = await submit(store, created.id, 'reuse child', [
            { turnId: first.id, threadId: '2', label: 'HR1' }
        ]);

        expect(second.references).toEqual([{ turnId: first.id, threadId: '2', label: 'HR1' }]);

        // The second turn's FIRST lead request carries the injected child result.
        const firstLeadRequest = requests.filter((request) => request.agent === 'lead')[2];
        expect(lastUser(firstLeadRequest.messages)).toBe(
            [
                'reuse child',
                '',
                REFERENCED_RESULTS_HEADER,
                `--- #HR1 | agent helper | turn ${first.id} | thread 2 ---`,
                'helper answer',
                '--- end #HR1 ---',
                REFERENCED_RESULTS_FOOTER
            ].join('\n')
        );
    });
    it('resolves a call:<callId> alias bound while the delegated turn is running', async () => {
        const requests: RecordedRequest[] = [];
        const gate = deferred();
        const store = createStore([teamPreset(requests, gate)]);
        const created = store.create('team');

        const first = store.enqueue(created.id, 'delegate please');

        // Wait until the child request is inside its stream: the delegated block
        // has adopted thread id '2', so a reference using the STABLE call alias is
        // exactly the "bound before completion" case.
        await waitUntil(() => requests.some((request) => request.agent === 'helper'));

        const second = store.enqueue(created.id, 'reuse child', undefined, [
            { turnId: first.turn.id, threadId: 'call:call_1', label: 'HR1' }
        ]);

        // Binding keeps the alias the client sent; expansion resolves it later.
        expect(second.turn.references).toEqual([
            { turnId: first.turn.id, threadId: 'call:call_1', label: 'HR1' }
        ]);

        gate.resolve();
        await first.settled;
        await second.settled;
        await store.waitForIdle(created.id);

        const leadRequests = requests.filter((request) => request.agent === 'lead');
        const reuseRequests = leadRequests.filter((request) =>
            lastUser(request.messages).startsWith('reuse child')
        );
        expect(reuseRequests.map((request) => lastUser(request.messages))).toEqual([
            [
                'reuse child',
                '',
                REFERENCED_RESULTS_HEADER,
                `--- #HR1 | agent helper | turn ${first.turn.id} | thread 2 ---`,
                'helper answer',
                '--- end #HR1 ---',
                REFERENCED_RESULTS_FOOTER
            ].join('\n'),
            [
                'reuse child',
                '',
                REFERENCED_RESULTS_HEADER,
                `--- #HR1 | agent helper | turn ${first.turn.id} | thread 2 ---`,
                'helper answer',
                '--- end #HR1 ---',
                REFERENCED_RESULTS_FOOTER
            ].join('\n')
        ]);
    });
});

describe('rejected references', () => {
    it('rejects a failed target at enqueue and creates no turn', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const failed = await submit(store, created.id, 'BOOM now');
        expect(failed.status).toBe('error');
        const before = store.get(created.id).turns.length;

        expect(() =>
            store.enqueue(created.id, 'reuse failure', undefined, [
                { turnId: failed.id, label: 'PE1' }
            ])
        ).toThrow(
            new SessionError(400, 'Block "#PE1" cannot be referenced because it ended as error.')
        );
        expect(store.get(created.id).turns).toHaveLength(before);
    });

    it('rejects a cancelled target at enqueue', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        const started = fixture.started('hold one');
        const task = store.enqueue(created.id, 'hold one');
        await started.promise;
        expect(store.cancel(created.id)).toBe(true);
        await task.settled;
        await store.waitForIdle(created.id);

        expect(store.get(created.id).turns[0].status).toBe('cancelled');
        expect(() =>
            store.enqueue(created.id, 'reuse cancelled', undefined, [
                { turnId: task.turn.id, label: 'PE1' }
            ])
        ).toThrow(
            new SessionError(400, 'Block "#PE1" cannot be referenced because it ended as cancelled.')
        );
    });

    it('rejects unknown turns, unknown labels, and a label/thread mismatch', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');
        const first = await submit(store, created.id, 'produce');

        expect(() =>
            store.enqueue(created.id, 'x', undefined, [{ turnId: 'missing', label: 'PE1' }])
        ).toThrow(new SessionError(400, 'Referenced turn "missing" does not exist in this session.'));

        expect(() =>
            store.enqueue(created.id, 'x', undefined, [{ turnId: first.id, label: 'RH9' }])
        ).toThrow(
            new SessionError(400, `Turn "${first.id}" has no block labelled "#RH9".`)
        );

        // A nested reference must name the thread; a bogus one cannot resolve.
        expect(() =>
            store.enqueue(created.id, 'x', undefined, [
                { turnId: first.id, threadId: 'ghost', label: 'PE1' }
            ])
        ).toThrow(
            new SessionError(400, `Turn "${first.id}" has no block labelled "#PE1" (thread "ghost").`)
        );

        // Typed label with no matching prior block is rejected, never guessed.
        expect(() => store.enqueue(created.id, 'use #ZZ9')).toThrow(
            new SessionError(400, 'No earlier block is labelled "#ZZ9". Type a label from a completed result.')
        );
    });

    it('rejects a malformed reference payload before creating a turn', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        expect(() => store.enqueue(created.id, 'x', undefined, { turnId: 'a', label: 'PE1' })).toThrow(
            new SessionError(400, 'references must be an array.')
        );
        expect(() => store.enqueue(created.id, 'x', undefined, [{ turnId: '', label: 'PE1' }])).toThrow(
            new SessionError(400, 'references[0].turnId must be a non-empty string.')
        );
        expect(() => store.enqueue(created.id, 'x', undefined, [{ turnId: 'a', label: 'nope' }])).toThrow(
            new SessionError(400, 'references[0].label must be a block label such as "IT1".')
        );

        expect(store.get(created.id).turns).toEqual([]);
    });

    it('keeps the 200k input ceiling and resolves nothing for an oversized prompt', () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');

        expect(() => store.enqueue(created.id, 'x'.repeat(200_001))).toThrow(
            new SessionError(413, 'A task cannot exceed 200000 characters.')
        );
        expect(store.get(created.id).turns).toEqual([]);
    });

    it('fails a turn readably when prompt + referenced context exceed the combined budget', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = store.create('probe');
        const first = await submit(store, created.id, 'produce');

        // Under the raw 200k ceiling, but there is no room left for the delimiters
        // once the reference expands: the turn must fail, not send an oversized
        // prompt or silently drop the reference.
        const huge = `${'x'.repeat(199_900)} #PE1`;
        const turn = await submit(store, created.id, huge);

        expect(turn.status).toBe('error');
        expect(turn.references).toEqual([{ turnId: first.id, label: 'PE1' }]);
        expect(store.get(created.id).lastError).toBe(REFERENCED_RESULTS_BUDGET_MESSAGE);
    });
});

describe('reference persistence', () => {
    it('restores bound references and expands them after a restart', async () => {
        const root = tempRoot('restart');
        const fixture = probeFixture();
        const persistence = new HarnessPersistence(root);

        const firstStore = createStore([fixture.preset], persistence);
        const created = firstStore.create('probe');
        const first = await submit(firstStore, created.id, 'produce a result');
        const second = await submit(firstStore, created.id, 'reuse it', [
            { turnId: first.id, label: 'PE1' }
        ]);
        expect(second.references).toEqual([{ turnId: first.id, label: 'PE1' }]);

        firstStore.dispose();

        const database = persistence.load();
        const secondStore = new SessionStore(
            DEFAULTS,
            createHarnessRegistry([fixture.preset]),
            undefined,
            { persistence, ...(database === undefined ? {} : { database }) }
        );

        const restored = secondStore.get(created.id);
        expect(restored.turns).toEqual([
            expect.objectContaining({ id: first.id, prompt: 'produce a result', status: 'done' }),
            expect.objectContaining({
                id: second.id,
                prompt: 'reuse it',
                status: 'done',
                references: [{ turnId: first.id, label: 'PE1' }]
            })
        ]);

        // The archive still resolves after the restart: the re-derived numbering is
        // the same conversation-scoped one (#PE1 = turn 1, #PE2 = turn 2), so a
        // stored label keeps its identity across a reload (R5/R6).
        const third = await submit(secondStore, created.id, 'again #PE1');
        expect(third.references).toEqual([{ turnId: first.id, label: 'PE1' }]);
        expect(lastUser(fixture.requests.at(-1)?.messages ?? [])).toBe(
            injectedPrompt('again #PE1', 'PE1', 'probe', first.id, 'answer 1')
        );

        const fourth = await submit(secondStore, created.id, 'and #PE2');
        expect(fourth.references).toEqual([{ turnId: second.id, label: 'PE2' }]);
        expect(lastUser(fixture.requests.at(-1)?.messages ?? [])).toBe(
            injectedPrompt('and #PE2', 'PE2', 'probe', second.id, 'answer 2')
        );
    });
});

describe('POST /tasks references', () => {
    const runtimeOf = (presets: HarnessPreset[]): HarnessRuntime => {
        const store = new SessionStore(SETTINGS, createHarnessRegistry(presets));
        return createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            store,
            loadEnvironment: false
        });
    };

    const callApi = (runtime: HarnessRuntime, method: string, pathname: string, body: unknown = {}) =>
        runtime.api({
            method,
            pathname,
            mount: '/v1/harness',
            readBody: async <T>() => body as T,
            bootstrapRoot: true
        });

    it('accepts a reference array in the 202 body and rejects a bad binding with 400', async () => {
        const fixture = probeFixture();
        const runtime = runtimeOf([fixture.preset]);

        const created = await callApi(runtime, 'POST', '/v1/harness/sessions', { harness: 'probe' });
        if (created.kind !== 'json' || created.status !== 201) throw new Error('expected a session');
        const id = (created.body as { session: SessionSnapshot }).session.id;

        const first = runtime.store.enqueue(id, 'first');
        await first.settled;
        await runtime.store.waitForIdle(id);

        const accepted = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: 'use it',
            references: [{ turnId: first.turn.id, label: 'PE1' }]
        });
        if (accepted.kind !== 'json') throw new Error('expected JSON');
        expect(accepted.status).toBe(202);
        expect((accepted.body as { turn: SessionTurn }).turn.references).toEqual([
            { turnId: first.turn.id, label: 'PE1' }
        ]);

        await runtime.store.waitForIdle(id);

        const rejected = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: 'bad',
            references: [{ turnId: 'missing', label: 'PE1' }]
        });
        if (rejected.kind !== 'json') throw new Error('expected JSON');
        expect(rejected.status).toBe(400);
        expect(rejected.body).toEqual({
            error: { message: 'Referenced turn "missing" does not exist in this session.' }
        });
    });

    it('rejects references explicitly on the legacy /messages endpoint', async () => {
        const fixture = probeFixture();
        const runtime = runtimeOf([fixture.preset]);

        const created = await callApi(runtime, 'POST', '/v1/harness/sessions', { harness: 'probe' });
        if (created.kind !== 'json' || created.status !== 201) throw new Error('expected a session');
        const id = (created.body as { session: SessionSnapshot }).session.id;

        const first = runtime.store.enqueue(id, 'first');
        await first.settled;
        await runtime.store.waitForIdle(id);

        // An explicit reference array is not forwarded by the legacy SSE route:
        // it is a clear 400, never a silently context-free run.
        const payload = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
            input: 'use it',
            references: [{ turnId: first.turn.id, label: 'PE1' }]
        });
        if (payload.kind !== 'json') throw new Error('expected JSON');
        expect(payload.status).toBe(400);
        expect(payload.body).toEqual({
            error: {
                message: 'Result references are not supported by /messages; submit this task through /tasks.'
            }
        });

        // A typed #LABEL is likewise not silently ignored on this route.
        const typed = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
            input: 'reuse #PE1'
        });
        if (typed.kind !== 'json') throw new Error('expected JSON');
        expect(typed.status).toBe(400);
        expect(typed.body).toEqual({
            error: {
                message: 'Result references are not supported by /messages; submit this task through /tasks.'
            }
        });
    });
});
