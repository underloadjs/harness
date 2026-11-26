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
//   - failed/cancelled/never-started targets BIND and compose the unavailable note (R-TREF);
//   - missing/malformed/non-earlier references are still rejected clearly;
//   - references survive a persistence restart and still expand afterwards;
//   - the /tasks HTTP route forwards references and maps a bad binding to 400;
//   - the existing 200k input bound still applies.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../engine/harness';
import type { AgentRank, HarnessMessage, HarnessStreamEvent } from '../engine/harness';
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
    REFERENCED_RESULTS_NO_RESULT_MARKER,
    agentLabelParts,
    listAgentResultBlocks,
    referencedResultUnavailableNote
} from '../engine/shared/agent-results';
import type { TaskReceipt, TurnResponse } from '../engine/shared/harness-api';
import type { SessionSnapshot, SessionTurn } from './protocol';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

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
    // R15 — `entry` is ROUTING (which member an unfocused submit opens) and `ranks` is AUTHORITY.
    // The retired `primary` + `subagents` pair said "the first agent leads, the rest are its
    // delegation targets"; the map says it outright — the entry holds Rank A and every other member
    // sits strictly below it, which is what derives the `delegate` allowlist (`isLowerRank`). A
    // stored card covers EVERY member (./harnesses/registry.ts `sortedRanks`).
    entry: agents[0] ?? name,
    ranks: Object.fromEntries(
        agents.map((member) => [member, member === (agents[0] ?? name) ? 'A' : 'B'])
    ) as Record<string, AgentRank>,
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
                            // R1: one attempt — the rejection path is what is pinned.
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
                    },
                    // R1: one attempt — the rejection path above is what is pinned.
                    retry: false
                })
            },
            entry: 'probe',
            presets: false,
            report: { progress }
        })
    );

    return { preset, requests, started, gate };
};

// Lead + helper, mirroring the runtime's delegation stream: root `lead` calls
// `delegate`, helper answers, lead then answers. This produces a nested block
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

                            if (last !== undefined && last.role === 'tool' && last.name === 'delegate') {
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
                                        name: 'delegate',
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
                // R1 — `entry` + `ranks` replace `primary`/`subagents`: `helper` at Rank B is the only
                // legal `delegate` target for the Rank A entry.
                entry: 'lead',
                ranks: { lead: 'A', helper: 'B' },
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

// R-TREF: ONE member, and the entry agent told to `delegate` to ITSELF. Rank A cannot
// delegate to rank A (`isLowerRank`), so the runtime refuses the call: the spawning
// `tool_call` frame is recorded, the tool answers an error `tool_result`, and the child
// conversation NEVER STARTS. That is the never-started attempt row F11 keeps on the board
// with a real label — the block ./sessions.ts must now bind instead of 400-ing.
// NOTE: `agentCodeOf('lead')` is first+last letter, so the root is `LD1` and the attempt
// `LD2` (see the label rules in ../engine/shared/agent-results.ts).
const refusedTeamPreset = (requests?: RecordedRequest[]): HarnessPreset =>
    presetOf(
        'refuser',
        (settings, progress) =>
            harness({
                agents: {
                    lead: agent({
                        model: settings.model,
                        instruction: 'Try to delegate to yourself, then answer.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            requests?.push({ agent: 'lead', messages: copyMessages(request.messages) });
                            const last = request.messages[request.messages.length - 1];

                            if (last !== undefined && last.role === 'tool' && last.name === 'delegate') {
                                // The refusal came back as the tool result; the run answers.
                                yield { type: 'text', delta: 'refused' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                                return;
                            }

                            yield {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    {
                                        id: 'call_self',
                                        name: 'delegate',
                                        arguments: '{"agent":"lead","input":"do it"}'
                                    }
                                ]
                            };
                        }
                    })
                },
                entry: 'lead',
                ranks: { lead: 'A' },
                presets: false,
                report: { progress }
            }),
        ['lead']
    );

// Exact injected prompt for a reference whose target produced NOTHING: the note section
// replaces the locator with the `no result available` marker (the composer's own shape,
// ../engine/shared/agent-results.ts `composeAgentResultPrompt`), and the note text is the
// shared helper's, so the wire prompt is pinned verbatim rather than restated loosely.
const notePrompt = (prompt: string, label: string, note: string): string =>
    [
        prompt,
        '',
        REFERENCED_RESULTS_HEADER,
        `--- #${label} | ${REFERENCED_RESULTS_NO_RESULT_MARKER} ---`,
        note,
        `--- end #${label} ---`,
        REFERENCED_RESULTS_FOOTER
    ].join('\n');

// Submit one queued task and wait for its completion.
const submit = async (
    store: SessionStore,
    id: string,
    input: string,
    references?: unknown
): Promise<SessionTurn> => {
    const task = await store.enqueue(id, input, undefined, references);
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
        const created = await store.create('probe');

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

        // The turn record keeps both prompts (server archive). R1-R6: each unfocused
        // submit runs in its OWN persistent thread, so the latest block lives in
        // that thread's transcript while the entry agent's default conversation —
        // `SessionSnapshot.messages` — stays empty (the legacy `/messages` route is
        // the surface that still appends there).
        const snapshot = store.get(created.id);
        expect(snapshot.turns.map((turn) => turn.prompt)).toEqual(['first block', 'second block']);
        expect(snapshot.messages.filter((message) => message.role !== 'system')).toEqual([]);

        const latestThread = snapshot.threads!.find(
            (thread) => thread.id === snapshot.turns[1]!.threadId
        )!;
        expect(withoutIds(latestThread.messages.filter((message) => message.role === 'user'))).toEqual([
            { role: 'user', content: 'second block' }
        ]);
    });
});

describe('explicit result references', () => {
    it('binds a root reference at enqueue and injects the completed result', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

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
        const created = await store.create('probe');

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
        const created = await store.create('probe');

        const firstStarted = fixture.started('hold one');
        const first = await store.enqueue(created.id, 'hold one');
        await firstStarted.promise;

        // The target is RUNNING and has only a start event; binding must not read
        // partial content and must not reject the task.
        const second = await store.enqueue(created.id, 'use #PE1');
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
        const created = await store.create('team');

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
        const created = await store.create('team');

        const first = await store.enqueue(created.id, 'delegate please');

        // Wait until the child request is inside its stream: the delegated block
        // has adopted thread id '2', so a reference using the STABLE call alias is
        // exactly the "bound before completion" case.
        await waitUntil(() => requests.some((request) => request.agent === 'helper'));

        const second = await store.enqueue(created.id, 'reuse child', undefined, [
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

// R-TREF (2026-11-26) — TERMINAL TARGETS ARE REFERENCEABLE, end to end.
//
// WHY THIS FILE'S OLD ANSWER WAS WRONG (the user mandate, verbatim):
//   "All labels must be valid. Cannot have T? or T- etc... all labels must be unique, as no
//    thread share same labeling. This is because user using these label to reference as needed,
//    and having a bunch of "T?" means they cannot reference specific one. All thread that
//    started, regardless of failure etc... must be assigned a proper label."
// F11 gave every row a valid, unique address — including the rows that died. An address the
// user cannot type is not an address, so binding a terminal block had to stop being a 400: the
// rows the operator most wants to name ARE the failed ones. What a terminal row lacks is a
// RESULT, and this file's own note mechanism (`referencedResultUnavailableNote`, pinned by
// ./thread-stop-reference.test.ts for a target that dies mid-wait) is the designed answer for
// exactly that. Binding and composition moved in ONE fold, so no chip can be minted that the
// server then rejects at submit.
describe('terminal references bind', () => {
    it('binds a failed target at enqueue and composes the unavailable-result note', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const failed = await submit(store, created.id, 'BOOM now');
        expect(failed.status).toBe('error');

        // The row keeps its address and its terminal status, with no result to reuse: the
        // projection clears `content` for a non-`done` block, which is what makes the NOTE
        // the honest composition below.
        expect(listAgentResultBlocks(store.get(created.id).turns)).toEqual([
            { turnId: failed.id, label: 'PE1', agent: 'probe', status: 'error' }
        ]);

        const second = await submit(store, created.id, 'reuse failure', [
            { turnId: failed.id, label: 'PE1' }
        ]);

        // The binding is stored exactly as for a completed target: accepted at enqueue, no
        // 400, and the task runs.
        expect(second.status).toBe('done');
        expect(second.prompt).toBe('reuse failure');
        expect(second.references).toEqual([{ turnId: failed.id, label: 'PE1' }]);

        // Composition injects the note, NOT an empty section: the model is told the input is
        // missing and still answers the rest of the request.
        expect(lastUser(fixture.requests[1].messages)).toBe(
            notePrompt('reuse failure', 'PE1', referencedResultUnavailableNote('PE1', 'error'))
        );
    });

    it('binds a cancelled target at enqueue and composes the unavailable-result note', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const started = fixture.started('hold one');
        const task = await store.enqueue(created.id, 'hold one');
        await started.promise;
        expect(await store.cancel(created.id)).toBe(true);
        await task.settled;
        await store.waitForIdle(created.id);

        expect(store.get(created.id).turns[0].status).toBe('cancelled');

        const second = await submit(store, created.id, 'reuse cancelled', [
            { turnId: task.turn.id, label: 'PE1' }
        ]);

        expect(second.status).toBe('done');
        expect(second.references).toEqual([{ turnId: task.turn.id, label: 'PE1' }]);
        expect(lastUser(fixture.requests[1].messages)).toBe(
            notePrompt('reuse cancelled', 'PE1', referencedResultUnavailableNote('PE1', 'cancelled'))
        );
    });

    it('binds a typed #LABEL that names a terminal block, like the chip path does', async () => {
        // The two spellings of one address must agree about what is referenceable, or the
        // composer offers a token that only works when typed. `normalizeReferences` used to
        // 400 here while the explicit list got through for a RUNNING target.
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const failed = await submit(store, created.id, 'BOOM now');
        expect(failed.status).toBe('error');

        const second = await submit(store, created.id, 'reuse #PE1');

        expect(second.references).toEqual([{ turnId: failed.id, label: 'PE1' }]);
        expect(lastUser(fixture.requests[1].messages)).toBe(
            notePrompt('reuse #PE1', 'PE1', referencedResultUnavailableNote('PE1', 'error'))
        );
    });

    it('binds a never-started delegation attempt (a labelled row with no result)', async () => {
        // THE SHAPE ITEM 2.3 ASKS ABOUT. A `delegate` call that the runtime refuses before
        // starting a child still leaves a row on the board: the spawning call minted the
        // placeholder, F11 let it KEEP its ordinal, and the parent's `tool_result` settles the
        // attempt as `error`. The projected block is
        //   { turnId, threadId: 'call:<callId>', label: '<CODE><n>', status: 'error' }
        // with NO content — the exact row the old doors refused ("ended as error" / "has no
        // completed result content"), which made the label the user was told to type useless.
        // It now binds, and the parent's own tool call + error result is the content the user
        // gets context for: the note says the attempt produced no answer.
        const requests: RecordedRequest[] = [];
        const store = createStore([refusedTeamPreset(requests)]);
        const created = await store.create('refuser');

        const first = await submit(store, created.id, 'delegate to yourself');

        // The attempt row exists, is addressable, and has no result — asserted before the
        // submit so the binding below cannot be accused of targeting the root instead.
        const attempt = listAgentResultBlocks(store.get(created.id).turns).find(
            (block) => block.threadId !== undefined
        );
        expect(attempt).toBeDefined();
        expect(attempt).toEqual({
            turnId: first.id,
            threadId: 'call:call_self',
            label: 'LD2',
            agent: 'lead',
            status: 'error'
        });

        const second = await submit(store, created.id, 'reuse the attempt', [
            { turnId: first.id, threadId: 'call:call_self', label: 'LD2' }
        ]);

        expect(second.status).toBe('done');
        expect(second.references).toEqual([
            { turnId: first.id, threadId: 'call:call_self', label: 'LD2' }
        ]);

        // Composition answers with the note for THAT row (thread-addressed, label kept).
        const waiter = requests.filter((request) => request.agent === 'lead');
        expect(lastUser(waiter[waiter.length - 1].messages)).toBe(
            notePrompt('reuse the attempt', 'LD2', referencedResultUnavailableNote('LD2', 'error'))
        );
    });
});

describe('rejected references', () => {

    it('rejects unknown turns, unknown labels, and a label/thread mismatch', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');
        const first = await submit(store, created.id, 'produce');

        await expect(store.enqueue(created.id, 'x', undefined, [{ turnId: 'missing', label: 'PE1' }])).rejects.toThrow(new SessionError(400, 'Referenced turn "missing" does not exist in this session.'));

        await expect(store.enqueue(created.id, 'x', undefined, [{ turnId: first.id, label: 'RH9' }])).rejects.toThrow(
            new SessionError(400, `Turn "${first.id}" has no block labelled "#RH9".`)
        );

        // A nested reference must name the thread; a bogus one cannot resolve.
        await expect(store.enqueue(created.id, 'x', undefined, [
                { turnId: first.id, threadId: 'ghost', label: 'PE1' }
            ])).rejects.toThrow(
            new SessionError(400, `Turn "${first.id}" has no block labelled "#PE1" (thread "ghost").`)
        );

        // Typed label with no matching prior block is rejected, never guessed.
        await expect(store.enqueue(created.id, 'use #ZZ9')).rejects.toThrow(
            new SessionError(400, 'No earlier block is labelled "#ZZ9". Type a label from a completed result.')
        );
    });

    it('rejects a malformed reference payload before creating a turn', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        await expect(store.enqueue(created.id, 'x', undefined, { turnId: 'a', label: 'PE1' })).rejects.toThrow(
            new SessionError(400, 'references must be an array.')
        );
        await expect(store.enqueue(created.id, 'x', undefined, [{ turnId: '', label: 'PE1' }])).rejects.toThrow(
            new SessionError(400, 'references[0].turnId must be a non-empty string.')
        );
        await expect(store.enqueue(created.id, 'x', undefined, [{ turnId: 'a', label: 'nope' }])).rejects.toThrow(
            new SessionError(400, 'references[0].label must be a block label such as "IT1".')
        );

        expect(store.get(created.id).turns).toEqual([]);
    });

    it('keeps the 200k input ceiling and resolves nothing for an oversized prompt', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        await expect(store.enqueue(created.id, 'x'.repeat(200_001))).rejects.toThrow(
            new SessionError(413, 'A task cannot exceed 200000 characters.')
        );
        expect(store.get(created.id).turns).toEqual([]);
    });

    it('fails a turn readably when prompt + referenced context exceed the combined budget', async () => {
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');
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
        const created = await firstStore.create('probe');
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

        const first = await runtime.store.enqueue(id, 'first');
        await first.settled;
        await runtime.store.waitForIdle(id);

        const accepted = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: 'use it',
            references: [{ turnId: first.turn.id, label: 'PE1' }]
        });
        if (accepted.kind !== 'json') throw new Error('expected JSON');
        expect(accepted.status).toBe(202);

        // T17: the 202 answer is a slim receipt, never the turn aggregate. The reference
        // array is pinned where it is durable — the canonical turn read.
        const receipt = accepted.body as TaskReceipt;

        expect(receipt.session_id).toBe(id);

        const recorded = await callApi(runtime, 'GET', `/v1/harness/sessions/${id}/turns/${receipt.turn_id}`);
        if (recorded.kind !== 'json') throw new Error('expected JSON');
        expect(recorded.status).toBe(200);
        expect((recorded.body as TurnResponse).turn.references).toEqual([
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

    it('drops the legacy /messages route instead of accepting a context-free submit', async () => {
        const fixture = probeFixture();
        const runtime = runtimeOf([fixture.preset]);

        const created = await callApi(runtime, 'POST', '/v1/harness/sessions', { harness: 'probe' });
        if (created.kind !== 'json' || created.status !== 201) throw new Error('expected a session');
        const id = (created.body as { session: SessionSnapshot }).session.id;

        const first = await runtime.store.enqueue(id, 'first');
        await first.settled;
        await runtime.store.waitForIdle(id);

        // T13/T17 removed the response-owned SSE surface: `/messages` is not mounted any
        // more, so a submit that relies on references cannot land on a route that would
        // accept it and then ignore them. A stale client gets a 404 naming the root.
        const payload = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
            input: 'use it',
            references: [{ turnId: first.turn.id, label: 'PE1' }]
        });
        if (payload.kind !== 'json') throw new Error('expected JSON');
        expect(payload.status).toBe(404);
        expect(payload.body).toEqual({
            error: { message: `Unknown API route: POST /v1/harness/sessions/${id}/messages` }
        });

        // A typed #LABEL on the stale route is refused the same way, never silently
        // stripped; the canonical /tasks route is the only submit surface.
        const typed = await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/messages`, {
            input: 'reuse #PE1'
        });
        if (typed.kind !== 'json') throw new Error('expected JSON');
        expect(typed.status).toBe(404);
        expect(typed.body).toEqual({
            error: { message: `Unknown API route: POST /v1/harness/sessions/${id}/messages` }
        });
    });
});

// ==================================================================================
// T-C4 (2026-11-26) — THE NO-BROKEN-CHIPS MATRIX (the binding contract of the whole
// reference redesign, stated once and then proven row by row).
//
//   EVERY ROW THE CLIENT'S PICKER OFFERS MUST BIND HERE AT SUBMIT.
//
// The client gate is loadscript `src/frontend/ui/references.ts` `isReferenceableBlock`:
// after the terminal relaxation it accepts ALL five `AgentResultStatus` values and filters
// ONLY on label validity (an unaddressable label is dropped because
// `readAgentResultReferenceList` rejects the whole list). So each status is a matrix row, and
// each row needs its proof on this side:
//
//   done      + content  -> binds, the recorded content is injected      (above: 'binds a root reference …')
//   done      no content -> binds, the unavailable-result NOTE is injected  (BELOW: 'binds a done row …')
//   error                -> binds, the note                               (above: 'binds a failed target …')
//   cancelled            -> binds, the note                               (above: 'binds a cancelled target …')
//   running              -> binds at enqueue, read after it settles       (above: 'binds a still-streaming target …')
//   queued               -> binds at enqueue, read after it settles       (BELOW: 'binds a QUEUED target …')
//
// THE APPARENT TENSION, resolved against the code. The gate accepts `queued`/`running` while
// `bindReference` still answers 400 for "a block … still queued/running". Those are two
// different doors on two different facts:
//   1. an UNSETTLED TARGET TURN (`target.status === 'running' || 'queued'`) returns EARLY, before
//      any block is read — the binding is stored and composition waits for the terminal event
//      (./sessions.ts, the branch above the `findAgentResultBlock` call). That is exactly the
//      live row the picker mints a chip for, and it BINDS;
//   2. the `queued`/`running` 400 is the SECOND check, reachable only after the target turn has
//      settled. It cannot fire on a projected row, because the block fold closes EVERY unfinished
//      child with the turn's own terminal status (../engine/shared/agent-results.ts, the
//      `block.status = turn.status` pass) and the picker only ever offers projected rows. The
//      third test below pins that closure instead of assuming it, which is what makes the
//      invariant a fact rather than a hope.
// ==================================================================================

// A `done` turn that recorded NO ANSWER: the run stops without ever yielding a text delta, so
// the projected root row carries the turn's terminal status with nothing to inject. This is the
// shape `bindReference` used to refuse ("a `done` block with no content") while the picker kept
// offering the row — the second never-started-attempt door the relaxation had to open.
const silentPreset = (requests?: RecordedRequest[]): HarnessPreset =>
    presetOf(
        'silent',
        (settings, progress) =>
            harness({
                agents: {
                    probe: agent({
                        model: settings.model,
                        instruction: 'Answer with nothing.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            requests?.push({ agent: 'probe', messages: copyMessages(request.messages) });
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                entry: 'probe',
                presets: false,
                report: { progress }
            }),
        ['probe']
    );

describe('the no-broken-chips matrix', () => {
    it('binds a QUEUED target at enqueue and expands it once the target settles', async () => {
        // ROW: `queued`. The picker offers a queued row (the gate accepts every status); the
        // server must not answer 400 for "it is still queued". The first submit parks inside the
        // transport, so the second one is genuinely a QUEUED turn, not a running one.
        const fixture = probeFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('probe');

        const firstStarted = fixture.started('hold one');
        const first = await store.enqueue(created.id, 'hold one');
        await firstStarted.promise;

        const second = await store.enqueue(created.id, 'produce two');
        expect(second.session.turns[1].status).toBe('queued');

        const third = await store.enqueue(created.id, 'reuse two', undefined, [
            { turnId: second.turn.id, label: 'PE2' }
        ]);

        // The chip binds exactly as stored — no 400, and nothing is read at enqueue time.
        expect(third.turn.references).toEqual([{ turnId: second.turn.id, label: 'PE2' }]);

        // FIFO: the target runs first, so by the time the referencing task composes, the target
        // has settled and its RECORDED answer is what lands in the prompt (not a note).
        fixture.gate('hold one').resolve();
        await first.settled;
        await second.settled;
        await third.settled;
        await store.waitForIdle(created.id);

        expect(store.get(created.id).turns[1].status).toBe('done');
        expect(lastUser(fixture.requests[2].messages)).toBe(
            injectedPrompt('reuse two', 'PE2', 'probe', second.turn.id, 'answer 2')
        );
    });

    it('binds a done row that recorded no content and composes the unavailable-result note', async () => {
        // ROW: `done` with NO content — the never-started-attempt shape inside a finished turn.
        // The row exists, is labelled, is `done`, and has nothing to inject; the picker offers it
        // and the server binds it, with the note as the honest composition. `bindReference` used
        // to refuse exactly this shape ("a `done` block with no content") while the picker kept
        // offering the row, which made the label the user was told to type useless.
        const requests: RecordedRequest[] = [];
        const store = createStore([silentPreset(requests)]);
        const created = await store.create('silent');

        const first = await submit(store, created.id, 'say nothing');
        expect(first.status).toBe('done');

        // Asserted BEFORE the submit, so the binding below cannot be accused of targeting a row
        // that has an answer: the projected row is `done` with an EMPTY record, which is the
        // `content.length === 0` case ./sessions.ts `composeReferences` sends to the note.
        expect(listAgentResultBlocks(store.get(created.id).turns)).toEqual([
            { turnId: first.id, label: 'PE1', agent: 'probe', status: 'done', content: '' }
        ]);

        const second = await submit(store, created.id, 'reuse the silence', [
            { turnId: first.id, label: 'PE1' }
        ]);

        expect(second.status).toBe('done');
        expect(second.references).toEqual([{ turnId: first.id, label: 'PE1' }]);

        // The composition is the note, and the note names the row's own status: the model is told
        // the labelled input produced nothing, and still answers the rest of the request.
        expect(lastUser(requests[1].messages)).toBe(
            notePrompt('reuse the silence', 'PE1', referencedResultUnavailableNote('PE1', 'done'))
        );
    });

    it('closes every projected row of a SETTLED turn, so the block-level 400 can never contradict a chip', async () => {
        // THE FOLD ROW OF THE MATRIX. While the delegated child is parked, the turn is `running`
        // and BOTH rows project as `running` — the live rows the picker offers, which bind through
        // the unsettled-target door. Once the turn settles, the projection closes the unfinished
        // child with the turn's own terminal status, so no projected row of a settled turn is ever
        // `queued`/`running`: the second 400 in `bindReference` cannot fire on a chip, only on a
        // reference that names a row the projection no longer shows that way.
        const requests: RecordedRequest[] = [];
        const gate = deferred();
        const store = createStore([teamPreset(requests, gate)]);
        const created = await store.create('team');

        const first = await store.enqueue(created.id, 'delegate please');
        await waitUntil(() => requests.some((request) => request.agent === 'helper'));

        // LIVE: both rows are `running` — the rows the picker offers while the run is in flight —
        // and a chip minted from either one binds, because the target TURN has not settled and
        // `bindReference` stores the binding without reading anything partial.
        expect(listAgentResultBlocks(store.get(created.id).turns)).toEqual([
            { turnId: first.turn.id, label: 'LD1', agent: 'lead', status: 'running' },
            { turnId: first.turn.id, threadId: '2', label: 'HR1', agent: 'helper', status: 'running' }
        ]);

        const second = await store.enqueue(created.id, 'reuse the live child', undefined, [
            { turnId: first.turn.id, threadId: '2', label: 'HR1' }
        ]);
        expect(second.turn.references).toEqual([{ turnId: first.turn.id, threadId: '2', label: 'HR1' }]);

        // SETTLED: the target turns are terminal, and the projection closed EVERY unfinished row
        // with its own turn's terminal status — so the block-level `still queued/running` door in
        // ./sessions.ts `bindReference` can never fire on a row this session renders. Asserted as
        // the exact invariant (not one hard-coded status), because WHICH terminal status this
        // scripted run lands on is the runtime's business; the matrix only needs "never unsettled".
        gate.resolve();
        await first.settled;
        await second.settled;
        await store.waitForIdle(created.id);

        const turns = store.get(created.id).turns;
        const rows = listAgentResultBlocks(turns);

        expect(turns.map((turn) => turn.status === 'queued' || turn.status === 'running')).toEqual([
            false,
            false
        ]);
        expect(rows.filter((row) => row.status === 'queued' || row.status === 'running')).toEqual([]);

        // …and every row the settled record renders still owns an ADDRESS, which is the other half
        // of the gate: `agentLabelParts` is the parser the picker and every server door share, so a
        // row that passes the fold check is a row the picker may mint and the server will bind. The
        // label list is pinned exactly so the check above cannot pass on an empty projection.
        expect(rows.map((row) => row.label)).toEqual(['LD1', 'HR1', 'LD2', 'HR2']);
        expect(rows.map((row) => agentLabelParts(row.label) !== undefined)).toEqual([true, true, true, true]);
    });
});
