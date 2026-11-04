// Server-side slash-command turns (C2) — store AND HTTP contract.
//
// A leading "/" is an OPERATOR action, not a prompt: the server runs it through
// `harness.executeCommand` (packages/underload/harness/src/harness.ts:7192) and
// records the answer as one ordinary SessionTurn whose events are SYNTHESIZED
// (`start` / `tool_call` / `tool_result`), so the transcript, the watcher stream,
// and a browser reload need zero frontend changes. Everything else falls through
// to `enqueue()` untouched (packages/underload/harness/src/server/sessions.ts
// `dispatch`).
//
// Everything runs offline against scripted presets: no provider, no network. The
// clock is pinned (Date.now spy) so every recorded timestamp is an exact number,
// and the scripted stream RECORDS each request, so "the model was never called"
// is an exact assertion (`requests.toEqual([])`), not a smoke test.
//
// Coverage map (acceptance evidence for C2):
//   - POST /tasks `/task add "testing"` → 202, terminal `done` turn, exact
//     synthesized event record, and the task really exists in harness state;
//   - `/task` re-reads the store (the listing lands in `tool_result.content`);
//   - `/help` + `/tools` answer locally without a model request;
//   - unknown `/nope` → 202 `error` turn, readable `unknown command:` result;
//   - attachments and references on a command → 400, session untouched;
//   - watcher frame order (turn → events → terminal turn → snapshot) and a real
//     persistence round trip that keeps the events;
//   - a command while a model turn RUNS: no lane, no queueDepth, no steering;
//   - regression: non-command input still goes through `enqueue()` exactly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '../harness';
import type { HarnessAttachment, HarnessMessage, HarnessStreamEvent, HarnessStreamRequest } from '../harness';
import type { AgentResultReference } from '../shared/agent-results';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import type { HarnessRuntime } from './runtime';
import { createHarnessRuntime } from './runtime';
import { SessionError, SessionStore } from './sessions';
import type { SessionStreamItem, SessionTurn } from './protocol';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');

// Scratch database roots for the persistence round trip live in the repo-root
// Temp/ directory (AGENTS.md), never in OS temp.
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp', 'C2');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const tempRoot = (label: string): string => {
    const created = fs.mkdtempSync(path.join(TEMP_ROOT, `commands-${label}-`));
    roots.push(created);

    return created;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const DEFAULTS = {
    baseURL: 'http://scripted.invalid/v1',
    model: 'scripted/test',
    hasApiKey: true
};

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'super-secret-key',
    model: 'scripted/test'
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Every scripted preset here is single-agent and named `instruct`, so that is the
// agent a command turn's synthesized events name (`sessions.ts commandAgentOf` reads
// `harness.name`, the entry agent). Spell it out instead of reading it back from the
// session so an agent-attribution regression is visible.
const primary = 'instruct';

// The `task` tool's page shape (src/core/task.ts) — the same one the built-in
// command renders. Hard-coded so a harness-state assertion is exact.
const taskPage = (tasks: unknown[], total: number, completed: number, pending: number) => ({
    tasks,
    counts: { total, completed, pending },
    page: { offset: 0, limit: 20, hasMore: false }
});

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

// Pin the server clock; every Date.now() answers `value` until afterEach restores.
const pinClock = (): ((next: number) => void) => {
    let value = 2_000;
    vi.spyOn(Date, 'now').mockImplementation(() => value);

    return (next: number) => {
        value = next;
    };
};

afterEach(() => {
    vi.restoreAllMocks();
});

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });

    return { promise, resolve };
};

// The last user text of one recorded model request, i.e. the prompt the scripted
// stream actually saw. Used to name the gate of a running turn.
const lastUser = (messages: readonly HarnessMessage[]): string => {
    const users = messages.filter((message) => message.role === 'user');
    const last = users[users.length - 1];

    return last === undefined || last.role !== 'user' ? '' : String(last.content);
};

// One valid clip, so a rejected command submit proves the COMMAND rule (commands
// take no media) and not an attachment-validation accident. `data: 'AAAA'` decodes
// to exactly 3 bytes, which is what `size` must agree with (shared/attachments.ts).
const CLIP: HarnessAttachment = {
    id: 'a1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'clip.png',
    mime: 'image/png',
    size: 3,
    data: 'AAAA'
};

// One plausible result reference (shared/agent-results.ts shape) for the same test.
const REFERENCE: AgentResultReference = { turnId: 'any-turn', label: 'IT1' };

// A scripted harness whose stream RECORDS every model request. A command turn must
// leave `requests` EMPTY; the queue path must add exactly one entry.
type ScriptedFixture = {
    preset: HarnessPreset;
    requests: HarnessStreamRequest[];
};

const scriptedFixture = (): ScriptedFixture => {
    const requests: HarnessStreamRequest[] = [];

    const preset = presetOf('instruct', (settings, progress) =>
        harness({
            agents: {
                instruct: agent({
                    model: settings.model,
                    instruction: 'Answer briefly.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        requests.push(request);
                        yield { type: 'text', delta: `answer:${lastUser(request.messages)}` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            // The `task` tool is a harness-owned (runtime) entry, so `presets: false`
            // keeps it registered (src/harness.ts:783) — which is what makes
            // `/task add "testing"` really mutate this session's task store.
            primary: 'instruct',
            presets: false,
            report: { progress },
            tools: {
                digest: tool({
                    description: 'Summarise text.',
                    tags: ['text'],
                    execute: () => 'digested'
                })
            }
        })
    );

    return { preset, requests };
};

// A gated variant: one prompt parks the run inside the stream, so a command can be
// submitted while a model turn is genuinely executing.
type GatedFixture = {
    preset: HarnessPreset;
    requests: HarnessStreamRequest[];
    started: (prompt: string) => { promise: Promise<void>; resolve: () => void };
    gate: (prompt: string) => { promise: Promise<void>; resolve: () => void };
};

const gatedFixture = (): GatedFixture => {
    const requests: HarnessStreamRequest[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const starts = new Map<string, ReturnType<typeof deferred>>();

    const memo = (map: Map<string, ReturnType<typeof deferred>>, key: string) => {
        const existing = map.get(key);
        if (existing !== undefined) return existing;

        const created = deferred();
        map.set(key, created);

        return created;
    };

    const preset = presetOf('gated', (settings, progress) =>
        harness({
            agents: {
                gated: agent({
                    model: settings.model,
                    instruction: 'Wait for a per-prompt gate.',
                    stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                        const prompt = lastUser(request.messages);

                        requests.push(request);
                        memo(starts, prompt).resolve();

                        try {
                            // Never released by the fixture: the command under test must
                            // settle while THIS run is still inside the stream.
                            await memo(gates, prompt).promise;
                            yield { type: 'text', delta: `answer:${prompt}` };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        } finally {
                            // keep the generator exhaustive
                        }
                    }
                })
            },
            primary: 'gated',
            presets: false,
            report: { progress }
        })
    );

    return {
        preset,
        requests,
        started: (prompt) => memo(starts, prompt),
        gate: (prompt) => memo(gates, prompt)
    };
};

const createStore = (presets: HarnessPreset[]): SessionStore =>
    new SessionStore(SETTINGS, createHarnessRegistry(presets));

const runtimeOf = (presets: HarnessPreset[], root?: string): HarnessRuntime =>
    createHarnessRuntime({
        ...(root === undefined ? {} : { root }),
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry(presets),
        loadEnvironment: false
    });

// The sequence a frame asserts, in order: turn rows by status+prompt, events by
// type+turnId, and plain snapshot/failed frames (same helper queue.test.ts uses).
const frameKey = (item: SessionStreamItem): string => {
    if (item.type === 'turn') return `turn:${item.turn.status}:${item.turn.prompt}`;
    if (item.type === 'event') return `event:${item.event.type}:${item.turnId}`;

    return item.type;
};

const callApi = (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    body: unknown = {}
) =>
    runtime.api({
        method,
        pathname,
        mount: '/v1/harness',
        readBody: async <T>() => body as T,
        bootstrapRoot: true
    });

const createSession = async (runtime: HarnessRuntime, harnessName: string): Promise<string> => {
    const result = await callApi(runtime, 'POST', '/v1/harness/sessions', { harness: harnessName });
    if (result.kind !== 'json' || result.status !== 201) throw new Error('expected a created session');

    return (result.body as { session: { id: string } }).session.id;
};

const jsonBody = <T>(result: Awaited<ReturnType<HarnessRuntime['api']>>): { status: number; body: T } => {
    if (result.kind !== 'json') throw new Error('expected JSON');

    return { status: result.status, body: result.body as T };
};

// One command turn, read back from the store by id (the HTTP body and the stored
// record must be the same copy of the same truth).
const turnOf = (store: SessionStore, id: string, turnId: string): SessionTurn => {
    const turn = store.get(id).turns.find((candidate) => candidate.id === turnId);
    if (turn === undefined) throw new Error('the command turn is missing from the session');

    return turn;
};

describe('POST /sessions/:id/tasks slash commands', () => {
    it('runs /task add as a terminal done turn and writes the task into harness state', async () => {
        pinClock();
        const fixture = scriptedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'instruct');

        const accepted = jsonBody<{
            session: { status: string; queueDepth?: number; turns: SessionTurn[] };
            turn: SessionTurn;
            steered?: true;
        }>(await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: '  /task add "testing"  '
        }));

        expect(accepted.status).toBe(202);
        expect(accepted.body.steered).toBeUndefined();

        // The 202 body carries the FINISHED turn: a command never waits for a pump.
        const turn = accepted.body.turn;

        expect(turn).toEqual({
            id: turn.id,
            index: 0,
            prompt: '/task add "testing"',
            status: 'done',
            startedAt: 2_000,
            updatedAt: 2_000,
            events: [
                { type: 'start', agent: primary, model: 'scripted/test' },
                {
                    type: 'tool_call',
                    agent: primary,
                    call: {
                        id: String((turn.events[1] as { call: { id: string } }).call.id),
                        name: 'command',
                        arguments: '{"input":"/task add \\"testing\\""}'
                    }
                },
                {
                    type: 'tool_result',
                    agent: primary,
                    name: 'command',
                    callId: String((turn.events[1] as { call: { id: string } }).call.id),
                    content:
                        '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1',
                    isError: false,
                    outcome: 'completed'
                }
            ],
            eventTimes: [2_000, 2_000, 2_000]
        });

        // The synthesized call id is a real uuid and pairs the two frames exactly.
        const callId = String((turn.events[1] as { call: { id: string } }).call.id);
        expect(callId).toMatch(UUID_PATTERN);
        expect((turn.events[2] as { callId?: string }).callId).toBe(callId);

        // Session scope: no thread, no lane, no usage (nothing was billed), and the
        // session itself is still idle with no pending work.
        expect(turn).not.toHaveProperty('threadId');
        expect(turn).not.toHaveProperty('threadLabel');
        expect(turn).not.toHaveProperty('usage');
        expect(accepted.body.session.status).toBe('idle');
        expect(accepted.body.session.queueDepth).toBeUndefined();
        expect(accepted.body.session.turns.map((record) => record.status)).toEqual(['done']);

        // NO model request was made for a command turn.
        expect(fixture.requests).toEqual([]);

        // And the command really mutated THIS session's harness (the live tool sees
        // it; sessions.ts `callTool` refuses a busy session, and this one is idle).
        expect(await runtime.store.callTool(id, 'task', {})).toEqual(
            taskPage([{ id: '1', text: 'testing', completed: false }], 1, 0, 1)
        );

        // The stored record equals the response copy: a reload renders the same turn.
        expect(turnOf(runtime.store, id, turn.id)).toEqual(turn);
    });

    it('lists the added task in the next command turn through /task', async () => {
        pinClock();
        const fixture = scriptedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'instruct');

        await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
            input: '/task add "testing"'
        });

        const listed = jsonBody<{ turn: SessionTurn }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: '/task' })
        );

        expect(listed.status).toBe(202);
        expect(listed.body.turn.index).toBe(1);
        expect(listed.body.turn.status).toBe('done');
        expect(listed.body.turn.events[2]).toEqual({
            type: 'tool_result',
            agent: primary,
            name: 'command',
            callId: String((listed.body.turn.events[1] as { call: { id: string } }).call.id),
            content: '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1',
            isError: false,
            outcome: 'completed'
        });
        expect(fixture.requests).toEqual([]);
    });

    it('answers /help and /tools locally, without ever invoking the scripted stream', async () => {
        pinClock();
        const fixture = scriptedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'instruct');

        const help = jsonBody<{ turn: SessionTurn }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: '/help' })
        );

        // Exact inventory of the five built-ins (core/command-builtins.ts renders
        // them sorted with their usage lines), so a registry regression is visible.
        expect(help.body.turn.events[2]).toEqual({
            type: 'tool_result',
            agent: primary,
            name: 'command',
            callId: String((help.body.turn.events[1] as { call: { id: string } }).call.id),
            content: [
                '/help  List the commands in this harness, or show one command.',
                '  usage: /help [command]',
                "/task  Read and change this session's task list.",
                '  usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>...]',
                '/tools  List the tools registered in this harness.',
                '  usage: /tools [filter]',
                "/webfetch  Fetch one http(s) page through this session's fetch tool.",
                '  usage: /webfetch <url>',
                "/websearch  Search the web with this session's configured search tool.",
                '  usage: /websearch <query>'
            ].join('\n'),
            isError: false,
            outcome: 'completed'
        });
        expect(help.body.turn.status).toBe('done');

        const tools = jsonBody<{ turn: SessionTurn }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: '/tools' })
        );

        expect(tools.status).toBe(202);
        expect(tools.body.turn.status).toBe('done');

        // `/tools` renders one preview line per registered tool
        // (`<name> — <description, flattened and capped at 200 chars>`), so the
        // command's own OUTPUT is what the turn records — the store adds nothing. The
        // inventory of a scripted `harness({presets: false})` build is fixed, so the
        // name list is asserted exactly; the description previews belong to the tools
        // themselves (already pinned by harness.commands.test.ts) and are not part of
        // this contract, except the fixture's own one-line tool, asserted verbatim.
        const result = tools.body.turn.events[2] as {
            type: string;
            agent: string;
            name: string;
            callId: string;
            content: string;
            isError: boolean;
            outcome: string;
        };

        expect(result).toBeDefined();
        expect(result.type).toBe('tool_result');
        expect(result.agent).toBe(primary);
        expect(result.name).toBe('command');
        expect(result.isError).toBe(false);
        expect(result.outcome).toBe('completed');
        // Paired with the synthesized call by id, exactly like a model tool round.
        expect(result.callId).toMatch(UUID_PATTERN);
        expect(result.callId).toBe((tools.body.turn.events[1] as { call: { id: string } }).call.id);

        const lines = result.content.split('\n');

        expect(lines.map((line) => line.split(' — ')[0] as string)).toEqual([
            'agentManage',
            'agentResult',
            'chapterManage',
            'digest',
            'locationManage',
            'profileManage',
            'task',
            'threadFork',
            'toolCancel',
            'toolCreate',
            'toolList',
            'toolManage',
            'toolRegistry',
            'toolRequest'
        ]);
        expect(lines).toContain('digest — Summarise text.');

        // Neither command spent a model request.
        expect(fixture.requests).toEqual([]);
    });

    it('records an unknown command as an error turn with a readable result and no model call', async () => {
        pinClock();
        const fixture = scriptedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'instruct');

        const accepted = jsonBody<{
            session: { status: string; lastError?: string };
            turn: SessionTurn;
        }>(await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: '/nope' }));

        // 202, NOT 4xx/5xx: an unknown name is an operator typo with an answer.
        expect(accepted.status).toBe(202);

        const turn = accepted.body.turn;

        // `executeCommand` THROWS `unknown command: /nope` (src/harness.ts:7206); the
        // store converts it into this error-shaped result rather than a 500.
        expect(turn.events).toEqual([
            { type: 'start', agent: primary, model: 'scripted/test' },
            {
                type: 'tool_call',
                agent: primary,
                call: {
                    id: String((turn.events[1] as { call: { id: string } }).call.id),
                    name: 'command',
                    arguments: '{"input":"/nope"}'
                }
            },
            {
                type: 'tool_result',
                agent: primary,
                name: 'command',
                callId: String((turn.events[1] as { call: { id: string } }).call.id),
                content: 'unknown command: /nope',
                isError: true,
                outcome: 'failed'
            }
        ]);

        expect(turn.status).toBe('error');
        expect(accepted.body.session.status).toBe('idle');
        // A failed command must not raise the session-wide error banner a run owns.
        expect(accepted.body.session.lastError).toBeUndefined();
        expect(fixture.requests).toEqual([]);
    });

    it('rejects attachments and references on a command with 400 and mutates nothing', async () => {
        pinClock();
        const fixture = scriptedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('instruct');

        const before = store.get(created.id);

        // The store is the validator, so assert its exact rejections and statuses.
        const attachmentFailure = await store
            .dispatch(created.id, '/task add "testing"', [CLIP])
            .then(() => undefined)
            .catch((error: unknown) => error as SessionError);

        expect(attachmentFailure).toBeInstanceOf(SessionError);
        expect(attachmentFailure?.status).toBe(400);
        expect(attachmentFailure?.message).toBe('A slash command cannot carry attachments.');

        const referenceFailure = await store
            .dispatch(created.id, '/task', undefined, [REFERENCE])
            .then(() => undefined)
            .catch((error: unknown) => error as SessionError);

        expect(referenceFailure).toBeInstanceOf(SessionError);
        expect(referenceFailure?.status).toBe(400);
        expect(referenceFailure?.message).toBe('A slash command cannot carry result references.');

        // Nothing changed: no turn, no index burn, no timestamp move, no model call.
        expect(store.get(created.id)).toEqual(before);
        expect(store.get(created.id).turns).toEqual([]);
        expect(fixture.requests).toEqual([]);

        // And the HTTP surface answers the same way (the route adds no validation of
        // its own, so a rejected command must not have mutated the session either).
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'instruct');
        const httpBefore = runtime.store.get(id);

        const rejectedMedia = jsonBody<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: '/task',
                attachments: [CLIP]
            })
        );

        expect(rejectedMedia.status).toBe(400);
        expect(rejectedMedia.body.error.message).toBe('A slash command cannot carry attachments.');

        const rejectedReference = jsonBody<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: '/task',
                references: [REFERENCE]
            })
        );

        expect(rejectedReference.status).toBe(400);
        expect(rejectedReference.body.error.message).toBe(
            'A slash command cannot carry result references.'
        );

        expect(runtime.store.get(id)).toEqual(httpBefore);
        expect(runtime.store.get(id).turns).toEqual([]);
        expect(fixture.requests).toEqual([]);
    });

    it('publishes turn/event/terminal frames to watchers and replays them after a restart', async () => {
        const root = tempRoot('watch');
        pinClock();
        const fixture = scriptedFixture();
        const runtime = runtimeOf([fixture.preset], root);
        const id = await createSession(runtime, 'instruct');

        const frames: SessionStreamItem[] = [];
        const watched = runtime.store.watch(id, async (item) => {
            frames.push(item);
        });
        const sessionId = watched.snapshot.id;
        expect(sessionId).toBe(id);

        const accepted = await runtime.store.dispatch(id, '/task add "testing"');
        const turnId = accepted.turn.id;

        // EXACT ordering: the turn row first, then every event in record order, then
        // the terminal upsert, then the drain snapshot — the same shape a model turn
        // produces, which is why no frontend change is needed.
        expect(frames.map(frameKey)).toEqual([
            'turn:running:/task add "testing"',
            `event:start:${turnId}`,
            `event:tool_call:${turnId}`,
            `event:tool_result:${turnId}`,
            'turn:done:/task add "testing"',
            'snapshot'
        ]);

        // The frames carry the real payloads, not just matching keys.
        if (frames[4].type !== 'turn') throw new Error('expected the terminal turn frame');
        expect(frames[4].turn).toEqual(accepted.turn);
        if (frames[5].type !== 'snapshot') throw new Error('expected the drain snapshot');
        expect(frames[5].session.turns.map((record) => record.status)).toEqual(['done']);

        watched.unsubscribe();

        // Durability round trip: a FRESH runtime over the same database root rebuilds
        // the command turn with its events and times intact.
        runtime.store.dispose();

        const second = runtimeOf([fixture.preset], root);
        expect(second.store.restoreErrors).toEqual([]);

        const restored = second.store.get(id);
        expect(restored.turns).toEqual([accepted.turn]);
        expect(restored.status).toBe('idle');
        expect(restored.queueDepth).toBeUndefined();

        // The restarted harness also still has the task the command added.
        expect(await second.store.callTool(id, 'task', {})).toEqual(
            taskPage([{ id: '1', text: 'testing', completed: false }], 1, 0, 1)
        );

        expect(fixture.requests).toEqual([]);
    });

    it('executes a command while a model turn runs without entering a lane or the queue', async () => {
        pinClock();
        const fixture = gatedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('gated');
        const id = created.id;

        const running = await store.enqueue(id, 'hold');
        await fixture.started('hold').promise;

        const before = store.get(id);
        expect(before.queueDepth).toBeUndefined();
        expect(before.turns.map((record) => record.status)).toEqual(['running']);

        // A command submitted mid-run: executed here, not queued behind the run. The
        // FOCUSED threadId is accepted and ignored (session scope), and it must never
        // steer: there is no model request for the text to land in.
        const command = await store.dispatch(id, '/help', undefined, undefined, running.turn.threadId);

        expect(command.turn.status).toBe('done');
        expect(command.turn.index).toBe(1);
        // Session scope, even though a conversation is live: no thread, no label, so
        // stopping or deleting that conversation can never purge this record.
        expect(command.turn).not.toHaveProperty('threadId');
        expect(command.turn).not.toHaveProperty('threadLabel');
        expect(command.steered).toBeUndefined();
        expect(command).not.toHaveProperty('steeredThreadId');
        // No backlog was created: queueDepth (pending work) is still absent.
        expect(command.session.queueDepth).toBeUndefined();

        const during = store.get(id);
        expect(during.queueDepth).toBeUndefined();
        expect(during.turns.map((record) => `${record.index}:${record.status}`)).toEqual([
            '0:running',
            '1:done'
        ]);
        // The model run is untouched by the command: exactly one request so far, and
        // its turn is still the running one.
        expect(fixture.requests).toHaveLength(1);

        // The model run then finishes normally, and its terminal turn is unaffected.
        fixture.gate('hold').resolve();
        await running.settled;
        await store.waitForIdle(id);

        expect(store.get(id).turns.map((record) => `${record.index}:${record.status}`)).toEqual([
            '0:done',
            '1:done'
        ]);
        expect(before.turns[0].id).toBe(store.get(id).turns[0].id);
    });

    // C8-m5: dispatch() must refuse what a command cannot express BEFORE it bounds the
    // text, which is the order enqueue() uses (attachments validated first, then
    // `validateInput`). Before this fix `validateInput` ran first, so an over-long
    // command that also carried a clip answered 413 where the queue path answers the
    // attachment problem.
    it('answers the attachment/reference rejection before the input length bound', async () => {
        pinClock();
        const fixture = scriptedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('instruct');

        // 200 001 characters: one past MAX_INPUT_LENGTH (sessions.ts line 218).
        const overLong = `/task add ${'x'.repeat(200_001)}`;

        // The same line WITHOUT the attachment keeps the length answer — moving the
        // rejections up front must not soften the shared bound.
        const lengthFailure = await store
            .dispatch(created.id, overLong)
            .then(() => undefined)
            .catch((error: unknown) => error as SessionError);

        expect(lengthFailure).toBeInstanceOf(SessionError);
        expect(lengthFailure?.status).toBe(413);
        expect(lengthFailure?.message).toBe('A task cannot exceed 200000 characters.');

        // WITH the attachment the media rule wins (400), exactly like enqueue().
        const mediaFailure = await store
            .dispatch(created.id, overLong, [CLIP])
            .then(() => undefined)
            .catch((error: unknown) => error as SessionError);

        expect(mediaFailure).toBeInstanceOf(SessionError);
        expect(mediaFailure?.status).toBe(400);
        expect(mediaFailure?.message).toBe('A slash command cannot carry attachments.');

        // Same precedence for a reference.
        const referenceFailure = await store
            .dispatch(created.id, overLong, undefined, [REFERENCE])
            .then(() => undefined)
            .catch((error: unknown) => error as SessionError);

        expect(referenceFailure).toBeInstanceOf(SessionError);
        expect(referenceFailure?.status).toBe(400);
        expect(referenceFailure?.message).toBe('A slash command cannot carry result references.');

        // Every rejection happened before a turn existed, so nothing was mutated.
        expect(store.get(created.id).turns).toEqual([]);
        expect(fixture.requests).toEqual([]);

        // The HTTP surface answers the same precedence (400, never 413).
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'instruct');

        const rejected = jsonBody<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: overLong,
                attachments: [CLIP]
            })
        );

        expect(rejected.status).toBe(400);
        expect(rejected.body.error.message).toBe('A slash command cannot carry attachments.');
        expect(runtime.store.get(id).turns).toEqual([]);
    });

    // C8-m6: the pending cap (100 queued tasks) bounds MODEL work. A command is not a
    // queue entry — it is terminal before the 202 leaves — so a full backlog must not
    // turn `/task` into a 429 (sessions.ts `dispatch` never consults `pendingCount`).
    it('bypasses the pending cap and still executes with a full backlog', async () => {
        pinClock();
        const fixture = gatedFixture();
        const runtime = runtimeOf([fixture.preset]);
        const id = await createSession(runtime, 'gated');
        const store = runtime.store;

        // Park the exclusive gate with a legacy run so accepted lane work genuinely
        // stays PENDING (the same setup queue.test.ts uses for the 101st-pending 429).
        fixture.gate('legacy');
        void store.run(id, 'legacy', async () => {});
        await fixture.started('legacy').promise;

        for (let index = 0; index < 100; index += 1) {
            await store.enqueue(id, `queued-${index}`);
        }

        expect(store.get(id).queueDepth).toBe(100);

        // A MODEL submit at the cap is refused — the cap is really in force here.
        const overflow = jsonBody<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: 'one more' })
        );

        expect(overflow.status).toBe(429);
        expect(overflow.body.error.message).toBe(
            'A session cannot queue more than 100 pending tasks.'
        );

        // The command is accepted anyway: 202 with an ALREADY TERMINAL record, and the
        // backlog is exactly as full as it was (the command never entered it).
        const accepted = jsonBody<{
            session: { queueDepth?: number; status: string };
            turn: SessionTurn;
        }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, { input: '/task' })
        );

        expect(accepted.status).toBe(202);
        expect(accepted.body.turn.status).toBe('done');
        expect(accepted.body.turn).not.toHaveProperty('threadId');
        expect(accepted.body.session.queueDepth).toBe(100);
        // The session is `running` because the parked legacy run still owns the gate —
        // the command neither started nor displaced anything.
        expect(accepted.body.session.status).toBe('running');

        // The listing the empty task store answers (core/task.ts page shape rendered
        // by core/command-builtins.ts `formatTaskPage`).
        expect(accepted.body.turn.events[2]).toEqual({
            type: 'tool_result',
            agent: 'gated',
            name: 'command',
            callId: String((accepted.body.turn.events[1] as { call: { id: string } }).call.id),
            content: 'No tasks.\n0 total, 0 completed, 0 pending\npage: offset 0, limit 20, showing 0',
            isError: false,
            outcome: 'completed'
        });

        // Still no room for model work, and the command turn is terminal in the
        // session as well as in the response.
        expect(store.get(id).queueDepth).toBe(100);
        expect(turnOf(store, id, accepted.body.turn.id).status).toBe('done');

        // Release the parked run so the fixture cannot leak a live gate.
        await store.cancel(id, { all: true });
        fixture.gate('legacy').resolve();
        await store.waitForIdle(id);
    });

    // C8-m4: a failed TERMINAL persist must not leave every watcher on `running`.
    // Before this fix `persistOrThrow` threw before the terminal upsert was published,
    // so the route answered 500 and the optimistic/live card stayed in flight forever
    // (no later frame names that turn again). The fix publishes the terminal frames
    // first, downgrades the record to `error` (it cannot claim `done` — the transcript
    // the server promised was not written), and rethrows.
    it('publishes a terminal error turn when the terminal save fails', async () => {
        const root = tempRoot('terminal-persist');
        pinClock();
        const fixture = scriptedFixture();
        const runtime = runtimeOf([fixture.preset], root);
        const persistence = runtime.persistence;

        if (persistence === undefined) throw new Error('expected a persisted runtime');

        const id = await createSession(runtime, 'instruct');

        const frames: SessionStreamItem[] = [];
        const watched = runtime.store.watch(id, async (item) => {
            frames.push(item);
        });

        // Fail ONLY the terminal write, exactly once. The running row and the
        // background event saves all still describe the command turn as `running`, so
        // this discriminates the strict terminal save from every earlier best-effort
        // one; later saves (a follow-up tool call below) must succeed again.
        const original = persistence.save.bind(persistence);
        let refused = false;

        vi.spyOn(persistence, 'save').mockImplementation((database) => {
            const stored = database.sessions.find((entry) => entry.id === id);
            const settled = (stored?.turns ?? []).some(
                (turn) => turn.status !== 'running' && turn.status !== 'queued'
            );

            if (settled && !refused) {
                refused = true;

                throw new Error('disk full');
            }

            original(database);
        });

        // The route still reports the durability failure.
        const failed = jsonBody<{ error: { message: string } }>(
            await callApi(runtime, 'POST', `/v1/harness/sessions/${id}/tasks`, {
                input: '/task add "testing"'
            })
        );

        expect(failed.status).toBe(500);
        expect(failed.body.error.message).toBe(
            'Could not save the harness database: disk full'
        );

        // The watchers see the turn CLOSE: the same frame order as a successful
        // command, except the terminal upsert says `error` instead of `done`.
        const turnId = frames[0].type === 'turn' ? frames[0].turn.id : '';
        expect(frames.map(frameKey)).toEqual([
            'turn:running:/task add "testing"',
            `event:start:${turnId}`,
            `event:tool_call:${turnId}`,
            `event:tool_result:${turnId}`,
            'turn:error:/task add "testing"',
            'snapshot'
        ]);

        // Nothing in-flight survives: the live record is terminal, the session is
        // idle, and there is no backlog for the tile to be waiting on.
        const live = runtime.store.get(id);
        expect(live.turns.map((record) => [record.index, record.status])).toEqual([[0, 'error']]);
        expect(live.status).toBe('idle');
        expect(live.queueDepth).toBeUndefined();

        // HONEST DURABILITY (the remaining trade-off): the document STILL holds the
        // RUNNING row, because the write that would have replaced it failed. A restart
        // therefore recovers that turn as an interrupted run rather than pretending the
        // command was never submitted. Checked before the tool call below, whose own
        // successful save would rewrite the file.
        const written = JSON.parse(fs.readFileSync(persistence.file, 'utf8')) as {
            sessions: Record<string, any>[];
        };

        expect(written.sessions.find((entry) => entry.id === id)?.turns[0]?.status).toBe('running');

        // The command DID execute in the live session (its harness side effect is in
        // memory, and the answer is recorded in the turn's events). This later save
        // succeeds — the failure was one write, not a dead database.
        expect(await runtime.store.callTool(id, 'task', {})).toEqual(
            taskPage([{ id: '1', text: 'testing', completed: false }], 1, 0, 1)
        );

        watched.unsubscribe();
        runtime.store.dispose();
    });

    it('leaves non-command input on the untouched enqueue path', async () => {
        const setClock = pinClock();
        const fixture = scriptedFixture();
        const store = createStore([fixture.preset]);
        const created = await store.create('instruct');
        const id = created.id;

        setClock(3_000);

        // dispatch() delegates BEFORE validating, so the queued record is byte-for-byte
        // what enqueue() produces (trimmed prompt, stable id/index, thread + label, and
        // NO startedAt until the pump begins it).
        const dispatched = await store.dispatch(id, '  first  ');

        expect(dispatched.turn).toEqual({
            id: dispatched.turn.id,
            index: 0,
            prompt: 'first',
            threadId: 'thread-1',
            threadLabel: 'IT1',
            status: 'queued',
            updatedAt: 3_000,
            events: [],
            eventTimes: []
        });
        expect(dispatched.session.queueDepth).toBe(1);

        await dispatched.settled;

        const done = turnOf(store, id, dispatched.turn.id);
        expect(done.status).toBe('done');
        // Regression: a prompt IS a model turn, with the run's own event stream.
        expect(done.events.map((event) => event.type)).toEqual(['start', 'text', 'done']);
        expect(fixture.requests).toHaveLength(1);

        // The empty-prompt rule still answers through enqueue's own validation order.
        const empty = await store.dispatch(id, '   ').catch((error: unknown) => error as SessionError);
        expect(empty).toBeInstanceOf(SessionError);
        expect(empty?.status).toBe(400);
        expect(empty?.message).toBe('A task cannot be empty.');
    });
});
