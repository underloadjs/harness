// The compact view surface, its durable reconstruction, and the canonical REST reads that
// replaced the old `/views` routes (R1/R2/R3/R4).
//
// T35 MIGRATION NOTE: `/api` and `/views/*` are gone from the network surface. The same
// compiled-state contract is now pinned on `/v1/harness/sessions/...`: the session aggregate
// is a bounded page/row read, one turn is metadata + counts, the tree is
// `.../turns/{id}/display`, one step is `.../steps/{id}`, one context segment is
// `.../blocks/{id}`, and the verbatim record is the paged `.../events` read. The old
// per-session display STREAM is no longer a REST route: realtime is one WebSocket upgrade on
// `/v1/harness/stream`, so the frames this file used to pull off a dispatcher stream are now
// pinned at the hub that plane subscribes to (`api.events`) and at the store seam
// (`store.watchView`). Only the CARRIERS changed; every compiled-state expectation below is
// the original one.
//
// What is pinned here, in the user's own terms:
//   - the UI wire carries SERVER-COMPILED display state, and no raw step/tool
//     payload ever rides on it (a sentinel body proves it by size, not by hope);
//   - one click retrieves the EXACT recorded request AND response of one tool call;
//   - the compiled state is cached in memory and REBUILT from the durable journal on
//     restart — never folded per request;
//   - a legacy database (no journal) still loads, a crash-truncated tail is tolerated,
//     mid-file corruption is surfaced, and reset/delete cannot replay stale steps.
//
// The raw contract is guarded too: `get()`/`list()` still carry every event, because
// the CLI and existing clients read them (./cli/index.ts, ./api.test.ts).
//
// Cross-references:
//   - ./turn-projector.test.ts — the fold's semantics (this file tests the store seam)
//   - ./journal.test.ts        — the log's own format/tolerance rules
//   - ../shared/turn-display.ts + ./protocol.ts — the shapes asserted below

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent } from '../harness';
import { createHarnessRegistry } from './harnesses';
import { SessionError, SessionStore } from './sessions';
import { HARNESS_DATABASE_DIRECTORY, HARNESS_DATABASE_FILE, HarnessPersistence } from './persistence';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { HARNESS_JOURNAL_FILE, HarnessJournal } from './journal';
import type { SessionStreamItem, SessionTurn, SessionView } from './protocol';
import { DISPLAY_NODE_PREVIEW_CHARS, DISPLAY_PREVIEW_CHARS } from '../shared/turn-display';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-view-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
    vi.restoreAllMocks();
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret',
    model: 'scripted/test'
};

// A body big enough that forwarding it on the compact wire would be obvious: the
// sentinel sits in the MIDDLE, so a head-truncated preview can never contain it, and
// `not.toContain(SENTINEL)` on the compact document is a real assertion.
const SENTINEL = 'SENTINEL-PAYLOAD-4c1d';
const HUGE = `${'filler-'.repeat(300)}${SENTINEL}${'-tail'.repeat(300)}`;

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

const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [], usage: { input: 90, output: 12, total: 102 } };
    };

const requestStream = (requests: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;

    return async function* (): AsyncGenerator<HarnessStreamEvent> {
        const frames = requests[index] ?? requests[requests.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

// One core-`task` round carrying an oversized argument, then the answer. The task
// tool echoes its input in the result, so BOTH the recorded request arguments and the
// recorded result content hold the sentinel — which is what the detail route has to
// return in full while the compact wire returns neither.
// The preset's own instruction, named once so a test can assert the bar's `system`
// segment counts EXACTLY what the agent was seeded with (./sessions.ts
// `noteInstructionSource` reads `Agent.instructions`).
const WORKER_INSTRUCTION = 'Take one tool round, then answer.';

const toolRoundPreset = (name = 'worker', instruction = WORKER_INSTRUCTION): HarnessPreset =>
    presetOf(name, (settings, progress) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction,
                    stream: requestStream([
                        [
                            {
                                type: 'done',
                                stopReason: 'tool_calls',
                                toolCalls: [
                                    {
                                        id: 'call-1',
                                        name: 'tasks',
                                        arguments: JSON.stringify({ tasks: [{ text: HUGE }] })
                                    }
                                ],
                                usage: { input: 500, output: 20, total: 520 }
                            }
                        ],
                        [
                            { type: 'text', agent: name, delta: 'fin' },
                            { type: 'text', delta: 'ished' },
                            { type: 'done', stopReason: 'stop', toolCalls: [], usage: { input: 620, output: 25, total: 645 } }
                        ]
                    ]),
                    tools: ['task']
                })
            },
            primary: name,
            presets: false,
            report: { progress }
        })
    );

const singlePreset = (name = 'one'): HarnessPreset =>
    presetOf(name, (settings, progress) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: 'You are a scripted test agent.',
                    stream: answerStream('plain answer')
                })
            },
            primary: name,
            presets: false,
            report: { progress }
        })
    );

// A store over an injected catalogue, optionally durable under `root`. The restart
// path is the same one ./runtime.ts uses: load the document, hand it to a new store.
const storeOf = (presets: HarnessPreset[], root?: string): SessionStore => {
    const registry = createHarnessRegistry(presets);

    if (root === undefined) return new SessionStore(SETTINGS, registry);

    const persistence = new HarnessPersistence(root);
    const database = persistence.load();

    return new SessionStore(SETTINGS, registry, undefined, {
        persistence,
        ...(database === undefined ? {} : { database })
    });
};

const journalFileOf = (root: string, sessionId: string): string =>
    path.join(root, 'harness', 'sessions', sessionId, HARNESS_JOURNAL_FILE);

const runTurn = async (store: SessionStore, id: string, input: string): Promise<SessionTurn> => {
    const accepted = await store.dispatch(id, input);
    const turn = accepted.turn;

    await store.waitForIdle(id);

    return store.get(id).turns.find((candidate) => candidate.id === turn.id) as SessionTurn;
};

describe('the compiled view is compact and carries no raw internals', () => {
    it('ships bounded rows, and never a step payload, an events array, or a transcript roster', async () => {
        const store = storeOf([toolRoundPreset()]);
        const created = await store.create('worker');
        const turn = await runTurn(store, created.id, 'do the work');

        const view = store.getView(created.id);
        const serialized = JSON.stringify(view);

        // R1/R3: a bounded preview can only quote the HEAD of a payload, so the
        // mid-payload sentinel proves the body never rode the wire. No raw event
        // structure appears either.
        expect(serialized).not.toContain(SENTINEL);
        expect(serialized).not.toContain('"events"');
        expect(serialized).not.toContain('"eventTimes"');
        expect(serialized).not.toContain('"messages"');
        expect(serialized.length).toBeLessThan(8_000);

        const display = view.displays[turn.id];
        const step = display.sections[0].nodes.find((node) => node.kind === 'tool') as {
            state: string;
            preview?: string;
            durationMs?: number;
            detail: { stepId: string; resultStepId?: string; hasResult: boolean; truncated: boolean };
        };

        expect(view.turns[0]).toMatchObject({
            id: turn.id,
            prompt: 'do the work',
            status: 'done',
            state: 'done',
            activeAgents: [],
            usage: { total: 1_165 },
            latestInput: 620,
            stepCount: 1
        });
        expect(view.turns[0].blocks.map((block) => block.status)).toEqual(['done']);
        expect(step).toMatchObject({ state: 'ok', durationMs: expect.any(Number) });
        expect((step.preview ?? '').length).toBeLessThanOrEqual(DISPLAY_PREVIEW_CHARS);
        expect(step.detail.hasResult).toBe(true);
        expect(step.detail.truncated).toBe(true);

        // The RAW surface is untouched: a raw consumer still gets every event.
        expect(store.get(created.id).turns[0].events.length).toBeGreaterThan(0);
        expect(JSON.stringify(store.get(created.id))).toContain(SENTINEL);
    });

    it('the rail document omits the node trees entirely', async () => {
        const store = storeOf([singlePreset()]);
        const created = await store.create('one');

        await runTurn(store, created.id, 'first');

        const views = store.listViews();

        expect(views).toHaveLength(1);
        expect('displays' in (views[0] as Record<string, unknown>)).toBe(false);
        expect(views[0].turns).toHaveLength(1);
        expect(views[0].turns[0].prompt).toBe('first');
        expect(JSON.stringify(views[0])).not.toContain('"events"');
    });
});

describe('lazy step detail (R2)', () => {
    it('returns the exact recorded request AND response together, with indexes and times', async () => {
        const store = storeOf([toolRoundPreset()]);
        const created = await store.create('worker');
        const turn = await runTurn(store, created.id, 'do the work');

        const display = store.getView(created.id).displays[turn.id];
        const step = display.sections[0].nodes.find((node) => node.kind === 'tool') as { id: string };

        const detail = store.stepDetail(created.id, turn.id, step.id);

        expect(detail.sessionId).toBe(created.id);
        expect(detail.turnId).toBe(turn.id);
        expect(detail.sectionId).toBe(display.sections[0].id);
        expect(detail.callId).toBe('call-1');

        // Indexes address the append-only event list, so the pair is exact and
        // re-resolvable, and the timestamps are the recorded `eventTimes` entries.
        expect(detail.opening.index).toBe(Number(step.id));
        expect(detail.opening.event.type).toBe('tool_call');
        expect(detail.result?.index).toBeGreaterThan(detail.opening.index);
        expect(detail.result?.event.type).toBe('tool_result');

        // The full payloads — absent from the compact wire — are here verbatim.
        expect(JSON.stringify(detail.opening.event)).toContain(SENTINEL);
        expect(JSON.stringify(detail.result?.event)).toContain(SENTINEL);
        expect(detail.opening.at).toBe(turn.eventTimes?.[detail.opening.index]);
        expect(detail.result?.at).toBe(turn.eventTimes?.[detail.result.index]);

        // A copy: mutating the answer cannot rewrite the server's record.
        (detail.opening.event as { call?: { name?: string } }).call = { name: 'tampered' };

        expect((store.stepDetail(created.id, turn.id, step.id).opening.event as { call?: { name?: string } }).call?.name).toBe('tasks');
    });

    it('refuses an unknown turn, an unknown step, and a malformed step id', async () => {
        const store = storeOf([singlePreset()]);
        const created = await store.create('one');
        const turn = await runTurn(store, created.id, 'answer me');

        expect(() => store.stepDetail(created.id, 'nope', '0')).toThrow(SessionError);

        try {
            store.stepDetail(created.id, turn.id, '999');
        } catch (error) {
            expect((error as SessionError).status).toBe(404);
        }

        try {
            store.stepDetail(created.id, turn.id, 'not-a-number');
        } catch (error) {
            expect((error as SessionError).status).toBe(400);
        }

        // A text event has no step, so asking for its index is a 404, not a phantom.
        try {
            store.stepDetail(created.id, turn.id, '0');
        } catch (error) {
            expect((error as SessionError).status).toBe(404);
        }
    });

    it('the raw turn route answers with the verbatim record', async () => {
        const store = storeOf([toolRoundPreset()]);
        const created = await store.create('worker');
        const turn = await runTurn(store, created.id, 'do the work');

        const raw = store.rawTurn(created.id, turn.id);

        expect(raw.events.map((event: HarnessEvent) => event.type)).toEqual(turn.events.map((event) => event.type));
        expect(JSON.stringify(raw)).toContain(SENTINEL);
        expect(() => store.rawTurn(created.id, 'nope')).toThrow(SessionError);
    });
});

describe('the observer stream (R3/R4)', () => {
    it('opens with a view, streams display ops, and hands each watcher its own copy', async () => {
        const store = storeOf([singlePreset()]);
        const created = await store.create('one');
        const frames: unknown[] = [];

        const watched = store.watchView(
            created.id,
            (item) => {
                frames.push(item);

                // Mutate the frame the way a careless renderer might.
                (item as { view?: SessionView }).view = undefined;
            },
            () => {}
        );

        expect(watched.view.turns).toEqual([]);

        await store.dispatch(created.id, 'streamed');
        await store.waitForIdle(created.id);
        watched.unsubscribe();

        const kinds = frames.map((frame) => (frame as { type: string }).type);

        // `watchView` hands the initial view to its caller atomically (exactly like
        // `watch()` hands a snapshot); the ROUTE is what sends it as the first frame —
        // pinned by the dispatcher stream test below.
        expect(kinds[0]).toBe('ops');
        expect(kinds).toContain('ops');
        // The drain snapshot mirrors as a self-sufficient final `view` frame.
        expect(kinds[kinds.length - 1]).toBe('view');

        const ops = frames
            .filter((frame) => (frame as { type: string }).type === 'ops')
            .flatMap((frame) => (frame as { ops: { op: string }[] }).ops)
            .map((op) => op.op);

        // Row upsert, section, prose nodes, then the terminal row: no raw event frame.
        expect(ops).toContain('turn');
        expect(ops).toContain('section:open');
        expect(ops).toContain('node:insert');
        expect(ops).toContain('node:append');

        // The mutation above proved isolation: the store's own view is intact.
        expect(store.getView(created.id).turns).toHaveLength(1);
    });
});

describe('restart reconstruction (R4)', () => {
    it('rebuilds identical compiled state and identical detail after a restart', async () => {
        const root = tempRoot('restart');
        const first = storeOf([toolRoundPreset()], root);
        const created = await first.create('worker');

        await runTurn(first, created.id, 'persist me');

        const before = first.getView(created.id);
        const beforeTurn = first.get(created.id).turns[0];
        const stepId = (before.displays[beforeTurn.id].sections[0].nodes.find((node) => node.kind === 'tool') as { id: string }).id;
        const beforeDetail = first.stepDetail(created.id, beforeTurn.id, stepId);

        // The journal holds one line per event, including BOTH text deltas.
        const journalPath = journalFileOf(root, created.id);

        expect(fs.existsSync(journalPath)).toBe(true);

        const lines = fs.readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.length > 0);

        expect(lines).toHaveLength(beforeTurn.events.length + 1);
        expect(JSON.parse(lines[0])).toMatchObject({ type: 'header', sessionId: created.id });
        expect(lines.filter((line) => JSON.parse(line).event?.type === 'text')).toHaveLength(2);

        const second = storeOf([toolRoundPreset()], root);
        const after = second.getView(created.id);

        expect(after).toEqual(before);
        expect(second.stepDetail(created.id, beforeTurn.id, stepId)).toEqual(beforeDetail);

        // No raw get() was needed to produce the compact answer, and the compiled
        // memory was warm at startup (the fold ran during restore).
        expect(second.get(created.id).turns[0].events.length).toBe(beforeTurn.events.length);
    });

    it('loads a legacy database that has no journal at all', async () => {
        const root = tempRoot('legacy');
        const first = storeOf([singlePreset()], root);
        const created = await first.create('one');

        await runTurn(first, created.id, 'old server wrote this');

        // Simulate an upgrade: the checkpoint exists, the per-step log does not.
        fs.rmSync(path.dirname(journalFileOf(root, created.id)), { recursive: true, force: true });

        const second = storeOf([singlePreset()], root);
        const view = second.getView(created.id);

        expect(view.turns).toHaveLength(1);
        expect(view.turns[0].prompt).toBe('old server wrote this');
        expect(JSON.stringify(view)).not.toContain('"events"');

        const text = view.displays[view.turns[0].id].sections[0].nodes.find((node) => node.kind === 'text');

        expect(text).toMatchObject({ text: 'plain answer' });
        expect(second.journalErrors).toEqual([]);
    });

    it('keeps checkpoint records the journal never saw, and recovers a turn only the journal saw', async () => {
        const root = tempRoot('merge');
        const first = storeOf([singlePreset()], root);
        const created = await first.create('one');

        await runTurn(first, created.id, 'checkpointed');

        // A crash-active turn: its events were appended to the log, but its record
        // never reached a document (a failed/lost checkpoint).
        const journal = new HarnessJournal(path.join(root, 'harness'), created.id);

        journal.open();
        journal.append({
            turnId: 'ghost-turn',
            index: 0,
            at: 5_000,
            event: { type: 'start', agent: 'one', model: 'scripted/test' }
        });
        journal.append({ turnId: 'ghost-turn', index: 1, at: 5_001, event: { type: 'text', agent: 'one', delta: 'uncheckpointed work' } });
        journal.flush();

        // A legacy document with a stale journal directory would ALSO be re-read; both
        // sources are merged, and neither may drop what the other holds.
        const second = storeOf([singlePreset()], root);
        const view = second.getView(created.id);

        expect(view.turns).toHaveLength(2);

        const ghost = view.turns.find((row) => row.id === 'ghost-turn');

        expect(ghost).toMatchObject({ status: 'error', state: 'error', prompt: '' });
        expect(JSON.stringify(view.displays['ghost-turn'] ?? '')).toContain('uncheckpointed work');
        expect(second.journalErrors.join('\n')).toContain('recovered turn ghost-turn');

        // The checkpointed turn is untouched by the merge.
        expect(view.turns[0].prompt).toBe('checkpointed');
    });

    it('surfaces mid-file journal corruption instead of swallowing it', async () => {
        const root = tempRoot('corrupt');
        const first = storeOf([singlePreset()], root);
        const created = await first.create('one');

        await runTurn(first, created.id, 'before corruption');

        const file = journalFileOf(root, created.id);

        // Hand-corrupt one middle line.
        first.dispose();

        const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0);

        lines.splice(2, 0, '}{ not json');
        fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

        const restored = storeOf([singlePreset()], root);
        const errors = restored.journalErrors.join('\n');

        expect(errors).toContain('corruption');
        expect(errors).toContain('line 3');
    });

    it('a reset cannot replay stale steps, and a delete cannot resurrect them', async () => {
        const root = tempRoot('stale');
        const first = storeOf([singlePreset()], root);
        const created = await first.create('one');

        await runTurn(first, created.id, 'remember once');
        await first.reset(created.id);

        const journalPath = journalFileOf(root, created.id);

        // Only the header survives a reset: the old log cannot describe new turns.
        expect(fs.readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.length > 0)).toHaveLength(1);
        expect(first.getView(created.id).turns).toEqual([]);

        const restarted = storeOf([singlePreset()], root);

        expect(restarted.getView(created.id).turns).toEqual([]);

        // A thread deletion compacts the log to the SURVIVING turns only.
        const threaded = storeOf([singlePreset()], root);
        const made = await threaded.create('one');
        const firstSubmit = await threaded.dispatch(made.id, 'thread one');
        const threadId = firstSubmit.turn.threadId as string;

        await threaded.waitForIdle(made.id);
        await threaded.dispatch(made.id, 'thread two', undefined, undefined, threadId);
        await threaded.waitForIdle(made.id);

        const kept = threaded.getView(made.id);

        expect(kept.turns).toHaveLength(2);

        await threaded.deleteThread(made.id, threadId);

        const afterDelete = threaded.getView(made.id);

        expect(afterDelete.turns).toHaveLength(0);

        const survivorLines = fs
            .readFileSync(journalFileOf(root, made.id), 'utf8')
            .split('\n')
            .filter((line) => line.length > 0 && line.includes('"event"'));

        expect(survivorLines).toHaveLength(0);

        const revived = storeOf([singlePreset()], root);

        expect(revived.getView(made.id).turns).toHaveLength(0);
    });

    it('removing a session deletes its durable footprint', async () => {
        const root = tempRoot('remove');
        const store = storeOf([singlePreset()], root);
        const created = await store.create('one');

        await runTurn(store, created.id, 'gone soon');

        expect(fs.existsSync(journalFileOf(root, created.id))).toBe(true);
        expect(await store.remove(created.id)).toBe(true);
        expect(fs.existsSync(path.dirname(journalFileOf(root, created.id)))).toBe(false);
    });
});

describe('the canonical session surface (R3)', () => {
    const apiOf = (store: SessionStore) =>
        createHarnessApi({
            store,
            defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true },
            registry: createHarnessRegistry([singlePreset(), toolRoundPreset()])
        });

    // T13 removed the `/api` mount and the `/views` resource family: ONE mount, and the
    // compact view is now a set of named reads under `/v1/harness/sessions/...`.
    const call = async (
        api: (request: HarnessApiRequest) => Promise<HarnessApiResult>,
        method: string,
        pathname: string,
        body?: unknown
    ): Promise<{ status: number; json: Record<string, unknown> }> => {
        const result = await api({
            method,
            pathname,
            mount: '/v1/harness',
            readBody: async <T>() => (body === undefined ? ({} as T) : (body as T))
        });

        if (result.kind !== 'json') throw new Error(`expected a json result, got ${result.kind}`);

        return { status: result.status, json: result.body as Record<string, unknown> };
    };

    /** Creates one session and answers its id. */
    const createViaApi = async (
        api: (request: HarnessApiRequest) => Promise<HarnessApiResult>,
        harness: string
    ): Promise<string> => {
        const created = await call(api, 'POST', '/v1/harness/sessions', { harness });

        expect(created.status).toBe(201);
        expect(JSON.stringify(created.json)).not.toContain('"events"');

        return (created.json.session as { id: string }).id;
    };

    it('answers every read and mutation with compiled state only', async () => {
        const store = storeOf([toolRoundPreset()]);
        const api = apiOf(store);

        const sessionId = await createViaApi(api, 'worker');

        // The submit answers a 202 receipt: the turn is named, not carried, and the heavy
        // children stay behind their own routes (R1/R3 — no raw payload on this wire).
        const submitted = await call(api, 'POST', `/v1/harness/sessions/${sessionId}/tasks`, {
            input: 'route me'
        });

        expect(submitted.status).toBe(202);
        expect(Object.keys(submitted.json).sort()).toEqual([
            'accepted_at',
            'links',
            'session_id',
            'session_revision',
            'status',
            'thread_id',
            'turn_id'
        ]);
        expect(String((submitted.json.turn_id as string) ?? '')).toBeTruthy();
        expect(JSON.stringify(submitted.json)).not.toContain(SENTINEL);

        const turnId = submitted.json.turn_id as string;

        // Let the scripted run finish, so the cancel below is a clean "nothing is running"
        // answer and the rail page is the settled one (store oracle, not a wire shape).
        await store.waitForIdle(sessionId);

        // The rail read is a bounded page of turn rows, never the compiled tree.
        const listed = await call(api, 'GET', '/v1/harness/sessions');

        expect(listed.status).toBe(200);
        expect((listed.json.items as unknown[]).length).toBe(1);

        const turns = await call(api, 'GET', `/v1/harness/sessions/${sessionId}/turns`);

        expect(turns.status).toBe(200);
        expect((turns.json.items as { id: string; promptPreview: string }[]).map((row) => row.id)).toEqual([
            turnId
        ]);
        expect(JSON.stringify(turns.json)).not.toContain(SENTINEL);
        expect(JSON.stringify(turns.json)).not.toContain('"events"');

        const one = await call(api, 'GET', `/v1/harness/sessions/${sessionId}`);

        expect(one.status).toBe(200);
        expect(JSON.stringify(one.json)).not.toContain(SENTINEL);

        // A turn's own metadata read carries counts, never the recorded event array.
        const turn = await call(api, 'GET', `/v1/harness/sessions/${sessionId}/turns/${turnId}`);

        expect(turn.status).toBe(200);
        expect(turn.json.turn).toMatchObject({ id: turnId, prompt: 'route me' });
        expect(turn.json.turn).not.toHaveProperty('events');
        expect(turn.json.turn).not.toHaveProperty('eventTimes');

        const cancelled = await call(api, 'POST', `/v1/harness/sessions/${sessionId}/cancel`, {});

        // A receipt again: the answer states what it did and the revision it moved, so a
        // client never re-reads the aggregate to confirm the write. Nothing is running and
        // nothing is queued, so `active_turn_id` is absent rather than null.
        expect(cancelled.status).toBe(200);
        expect(cancelled.json).toEqual({
            cancelled: false,
            session_id: sessionId,
            dropped_queued_tasks: 0,
            revision: api.events.getRevision('session', sessionId)
        });

        const patched = await call(api, 'PATCH', `/v1/harness/sessions/${sessionId}`, {
            agent_models: { worker: 'next/model' }
        });

        expect(patched.status).toBe(200);
        expect((patched.json.session as { agent_models: Record<string, string> }).agent_models).toEqual({
            worker: 'next/model'
        });

        const removed = await call(api, 'DELETE', `/v1/harness/sessions/${sessionId}`);

        expect(removed.json).toEqual({
            deleted: true,
            session_id: sessionId,
            aborted_turns: 0,
            dropped_queued_tasks: 0
        });
    });

    it('serves the lazy step detail and the verbatim events, and refuses unknown ones', async () => {
        const store = storeOf([toolRoundPreset()]);
        const api = apiOf(store);
        const sessionId = await createViaApi(api, 'worker');

        await call(api, 'POST', `/v1/harness/sessions/${sessionId}/tasks`, { input: 'route detail' });
        await store.waitForIdle(sessionId);

        const view = store.getView(sessionId);
        const turnId = view.turns[0].id;
        const stepId = (view.displays[turnId].sections[0].nodes.find((node) => node.kind === 'tool') as { id: string }).id;

        const detail = await call(api, 'GET', `/v1/harness/sessions/${sessionId}/turns/${turnId}/steps/${stepId}`);

        expect(detail.status).toBe(200);
        // The full payloads ride the DETAIL answer, and only here.
        expect(JSON.stringify(detail.json)).toContain(SENTINEL);

        // The old `raw` aggregate read is now the events route: the same verbatim pair,
        // each row carrying its ordinal and recorded time.
        const events = await call(api, 'GET', `/v1/harness/sessions/${sessionId}/turns/${turnId}/events`);

        expect(events.status).toBe(200);
        expect(JSON.stringify(events.json)).toContain(SENTINEL);
        expect(
            (events.json.items as { event: { type: string } }[]).map((row) => row.event.type)
        ).toEqual(store.get(sessionId).turns[0].events.map((event) => event.type));

        // The compiled tree is its own lazy read as well (nothing folds per request).
        const display = await call(api, 'GET', `/v1/harness/sessions/${sessionId}/turns/${turnId}/display`);

        expect(display.status).toBe(200);
        expect(JSON.stringify(display.json)).not.toContain(SENTINEL);

        const missing = await call(
            api,
            'GET',
            `/v1/harness/sessions/${sessionId}/turns/${turnId}/steps/424242`
        );

        expect(missing.status).toBe(404);
    });

    it('keeps the method and route rules of the single canonical mount', async () => {
        const api = apiOf(storeOf([singlePreset()]));

        const sessionId = await createViaApi(api, 'one');

        // The dispatcher maps every known failure to a JSON status, exactly like the
        // raw routes do (the adapters never re-implement the mapping).
        expect((await call(api, 'PUT', '/v1/harness/sessions')).status).toBe(405);
        expect((await call(api, 'GET', '/v1/harness/sessions/nope')).status).toBe(404);
        expect((await call(api, 'GET', '/v1/harness/sessions/nope/turns/x/steps/0')).status).toBe(404);
        expect((await call(api, 'GET', '/v1/harness/nonsense/route')).status).toBe(404);

        // T13/T15: the per-session SSE path is gone from the network surface — realtime is
        // one WebSocket upgrade on `/stream`, so a REST client addressing `/events` gets a
        // 404 naming the route it asked for, and a plain (non-upgrading) GET `/stream` is
        // the 400 the capability document promised.
        expect((await call(api, 'GET', `/v1/harness/sessions/${sessionId}/events`)).status).toBe(404);

        const noUpgrade = await call(api, 'GET', '/v1/harness/stream');

        expect(noUpgrade.status).toBe(400);
        expect(noUpgrade.json).toEqual({
            error: {
                message:
                    'GET /stream expects a WebSocket upgrade (Sec-WebSocket-Key/Version) for the harness.v1 subprotocol.'
            }
        });

        // The legacy prefix is not mounted at all, and the 404 says what IS served.
        const stale = await call(api, 'GET', '/v1/harness/sessions');

        expect(stale.status).toBe(200);

        expect((await call(api, 'DELETE', `/v1/harness/sessions/${sessionId}`)).status).toBe(200);
        expect((await call(api, 'DELETE', `/v1/harness/sessions/${sessionId}`)).status).toBe(404);
    });

    it('publishes compiled display frames on the hub, and never a raw event frame', async () => {
        const store = storeOf([singlePreset()]);
        const api = apiOf(store);
        const sessionId = await createViaApi(api, 'one');

        // TRANSPORT CHANGE, SAME DOMAIN: the dispatcher no longer streams (T15 moved
        // realtime to the WebSocket plane), but what that plane carries is decided HERE, at
        // the hub it subscribes to. The old "view first, then ops, never a raw event" rule
        // becomes: the run publishes `turn.upsert` + `display.ops`, and no kind named
        // `event` exists on this plane at all.
        const frames: { kind: string; payload?: unknown }[] = [];
        const unsubscribe = api.events.subscribe((event) => {
            frames.push(event as unknown as { kind: string; payload?: unknown });
        });

        await call(api, 'POST', `/v1/harness/sessions/${sessionId}/tasks`, { input: 'observed' });
        await store.waitForIdle(sessionId);
        unsubscribe();

        const kinds = frames.map((frame) => frame.kind);

        expect(kinds).toContain('turn.upsert');
        expect(kinds).toContain('display.ops');
        expect(kinds).toContain('session.updated');
        // A raw stream item type must never reach the display plane.
        expect(kinds).not.toContain('event');
        expect(kinds).not.toContain('snapshot');

        const ops = frames
            .filter((frame) => frame.kind === 'display.ops')
            // The published record carries the ops at the TOP level (api.ts `display.ops`
            // publish), not nested in a payload envelope.
            .flatMap((frame) => (frame as unknown as { ops: { op: string }[] }).ops)
            .map((op) => op.op);

        // The op sequence a single scripted answer mints, in order. Note the absence of a
        // `turn` op: on this plane the ROW is delivered by the `turn.upsert` event above, so
        // publishing it again inside the ops would be two figures for one change (the store
        // seam test at `watchView` is where the self-sufficient `turn` op is pinned).
        expect(ops).toEqual([
            'section:open',
            'context:add',
            'context:add',
            'section:set',
            'node:insert',
            'context:add',
            'node:append',
            'context:set',
            'tail:set',
            'usage',
            'usage',
            'node:set',
            'section:set',
            'attempt:commit'
        ]);

        // Section open, prose node insert + append, and the commit that closes the attempt:
        // every frame is compiled display state, never a raw event.
        expect(ops.filter((op) => op === 'node:insert' || op === 'node:append')).toEqual([
            'node:insert',
            'node:append'
        ]);
        expect(ops.filter((op) => op === 'attempt:commit')).toEqual(['attempt:commit']);

        // R1/R3 on the WIRE: nothing in any frame carries a raw events array.
        expect(JSON.stringify(frames)).not.toContain('"events"');
    });

    it('gives the canonical submit the attachment body bound and nothing else does', async () => {
        const { MAX_SUBMIT_BODY_BYTES } = await import('../shared/attachments');
        const { MAX_API_BODY_BYTES, bodyLimitFor } = await import('./api');

        // The one submit route, on the one mount.
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/tasks', '/v1/harness')).toBe(
            MAX_SUBMIT_BODY_BYTES
        );

        // Every sibling and every other verb keeps the legacy cap.
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/cancel', '/v1/harness')).toBe(
            MAX_API_BODY_BYTES
        );
        expect(bodyLimitFor('GET', '/v1/harness/sessions/abc/tasks', '/v1/harness')).toBe(
            MAX_API_BODY_BYTES
        );
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/messages', '/v1/harness')).toBe(
            MAX_API_BODY_BYTES
        );
        expect(bodyLimitFor('POST', '/v1/harness/sessions/abc/turns/x/steps/0', '/v1/harness')).toBe(
            MAX_API_BODY_BYTES
        );

        // `bodyLimitFor` classifies the MOUNT-RELATIVE path, so the same submit shape under a
        // stale prefix still classifies as a submit — that prefix is refused by ROUTING
        // (`dispatch` answers 404 and names the canonical root), never by a different cap.
        expect(bodyLimitFor('POST', '/api/sessions/abc/tasks', '/api')).toBe(MAX_SUBMIT_BODY_BYTES);
    });

    // -----------------------------------------------------------------------
    // The ONE context bar (T10): metadata-only segments on the wire, and one click
    // for the EXACT recorded bytes of any segment (R6/R8).
    // -----------------------------------------------------------------------

    it('counts every bar segment from the record while the view ships none of that text', async () => {
        const store = storeOf([toolRoundPreset()]);
        const created = await store.create('worker');
        const turn = await runTurn(store, created.id, 'do the work');

        const view = store.getView(created.id);
        const bar = view.displays[turn.id].sections[0].context ?? [];
        const record = store.get(created.id).turns[0];

        // The turn RECORD is the authority for every figure below — the point of the
        // bar is that it counts recorded bytes, not previews.
        const argsIndex = record.events.findIndex((event) => event.type === 'tool_call');
        const resultIndex = record.events.findIndex((event) => event.type === 'tool_result');
        const textIndex = record.events.findIndex((event) => event.type === 'text');
        const args = (record.events[argsIndex] as { call: { arguments: string } }).call.arguments;
        const result = (record.events[resultIndex] as { content: string }).content;

        expect(bar.map((block) => block.id)).toEqual([
            '0-system-instructions',
            '0-user-prompt',
            `0-tool-${argsIndex}`,
            `0-assistant-${textIndex}`
        ]);
        // 'do the work' is 11 recorded characters, the instruction 33, the answer 8,
        // and the tool row is the recorded arguments PLUS the recorded result.
        expect(bar.map((block) => block.chars)).toEqual([WORKER_INSTRUCTION.length, 11, args.length + result.length, 8]);
        expect(bar.map((block) => block.inPrompt)).toEqual([true, true, true, true]);

        const tool = bar[2];

        expect(tool).toMatchObject({
            name: 'tasks',
            state: 'ok',
            argsChars: args.length,
            resultChars: result.length,
            eventFrom: argsIndex,
            eventTo: resultIndex,
            durationMs: expect.any(Number)
        });

        // R6 and R1 together: the segment counts a payload of thousands of characters,
        // and the compact document contains none of it.
        expect(tool.chars).toBeGreaterThan(HUGE.length);
        expect(JSON.stringify(bar)).not.toContain(SENTINEL);
        expect(JSON.stringify(view)).not.toContain(SENTINEL);
    });

    it('answers one exact recorded body per segment kind, and refuses an unknown one', async () => {
        const preset = { ...toolRoundPreset(), agentInstructions: { worker: 'An override the run may or may not use.' } };
        const store = storeOf([preset]);
        const api = apiOf(store);
        const created = await store.create('worker');
        const turn = await runTurn(store, created.id, 'do the work');
        const record = store.get(created.id).turns[0];
        const argsIndex = record.events.findIndex((event) => event.type === 'tool_call');
        const resultIndex = record.events.findIndex((event) => event.type === 'tool_result');
        const textIndex = record.events.findIndex((event) => event.type === 'text');
        const args = (record.events[argsIndex] as { call: { arguments: string } }).call.arguments;
        const result = (record.events[resultIndex] as { content: string }).content;
        // The bar's click target is now a canonical child route of the turn.
        const route = (blockId: string) =>
            `/v1/harness/sessions/${created.id}/turns/${turn.id}/blocks/${blockId}`;
        const view = store.getView(created.id);

        // The `system` segment answers with the instruction entries the agent ACTUALLY
        // ran with, one entry per recorded system message, in order.
        const system = await call(api, 'GET', route('0-system-instructions'));

        expect(system.status).toBe(200);
        expect(system.json.block).toEqual({
            kind: 'system',
            id: '0-system-instructions',
            turnId: turn.id,
            sectionId: `${turn.id}:0`,
            name: 'instructions',
            at: expect.any(Number),
            chars: WORKER_INSTRUCTION.length,
            inPrompt: true,
            sessionId: created.id,
            entries: [WORKER_INSTRUCTION]
        });

        const prompt = await call(api, 'GET', route('0-user-prompt'));

        expect(prompt.json.block).toMatchObject({ kind: 'user', name: 'prompt', chars: 11, text: 'do the work' });

        // The tool segment is the whole pair: recorded arguments AND recorded result
        // text, sentinel included — the bytes the compact bar deliberately omits.
        const tool = (await call(api, 'GET', route(`0-tool-${argsIndex}`))).json.block as Record<string, unknown>;

        expect(tool.args).toBe(args);
        expect(tool.result).toBe(result);
        expect(JSON.stringify(tool)).toContain(SENTINEL);
        expect(tool.chars).toBe(args.length + result.length);

        const answer = (await call(api, 'GET', route(`0-assistant-${textIndex}`))).json.block;

        expect(answer).toMatchObject({ kind: 'assistant', name: 'answer', chars: 8, text: 'finished' });

        // A segment the bar never minted (or one a discarded attempt removed) is an
        // honest 404, and a non-GET keeps the mount's method contract.
        expect((await call(api, 'GET', route('0-tool-9999'))).status).toBe(404);
        expect((await call(api, 'GET', `/v1/harness/sessions/${created.id}/turns/nope/blocks/0-user-prompt`)).status).toBe(404);

        const wrongMethod = await call(api, 'POST', route('0-user-prompt'));

        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.json).toEqual({
            error: {
                message: `Use GET, PATCH for /v1/harness/sessions/${created.id}/turns/${turn.id}/blocks/0-user-prompt.`
            }
        });

        // R3: an instruction OVERRIDE is per-agent system-prompt text, so the compact
        // surface trims it out of the descriptor...
        expect(preset.agentInstructions).toBeDefined();
        expect(view.harnessDefinition).not.toHaveProperty('agentInstructions');
        // ...while the RAW surface still reports the frozen descriptor verbatim (the
        // raw contract is unchanged, and a saved session's dialog reads it there).
        expect(store.get(created.id).harnessDefinition?.agentInstructions).toEqual(preset.agentInstructions);
    });

    // -----------------------------------------------------------------------
    // The inclusion toggle (T5): one segment, one control, and the write goes through
    // the SEGMENT's own route. No whole-transcript document PUT is issued for it, so the
    // context bar never races the live transcript (docs/tasks R5-R8).
    // -----------------------------------------------------------------------

    it('switches one tool round out of the prompt through its own segment route', async () => {
        const store = storeOf([toolRoundPreset()]);
        const api = apiOf(store);
        const created = await store.create('worker');
        const turn = await runTurn(store, created.id, 'do the work');
        // The LIVE record, not the snapshot: the assertions below read the transcript through
        // the harness seam the route itself writes through (./api.ts `blockUnitOf` +
        // `updateThreadTranscript`), which is the seam the NEXT model request is built from.
        const record = store.liveSession(created.id);
        const events = record.turns[0].events;
        const argsIndex = events.findIndex((event) => event.type === 'tool_call');
        const resultIndex = events.findIndex((event) => event.type === 'tool_result');
        const textIndex = events.findIndex((event) => event.type === 'text');
        const args = (events[argsIndex] as { call: { arguments: string } }).call.arguments;
        const result = (events[resultIndex] as { content: string }).content;
        // The recorded ledger, compared verbatim at the end: the toggle moves a transcript
        // FLAG, so none of the bytes the bar counts may move with it.
        const ledger = JSON.stringify(events);
        // The conversation the turn belongs to. The route takes this id from the turn's own
        // join (./protocol.ts `SessionTurn.threadId`), never from the client, so pinning it
        // here is what makes the receipt's `thread_id` an assertion rather than a tautology.
        const threadId = turn.threadId as string;

        expect(threadId).toBe('thread-1');

        const route = (blockId: string) => `/v1/harness/sessions/${created.id}/turns/${turn.id}/blocks/${blockId}`;
        const toolId = `0-tool-${argsIndex}`;
        const toolRoute = route(toolId);
        const displayRoute = `/v1/harness/sessions/${created.id}/turns/${turn.id}/display`;

        /**
         * What one segment says about inclusion: the published boolean, or `unaddressable`
         * when the property is ABSENT. Absent is the load-bearing case — the instruction and
         * the prompt are seeded by the core, and an ANSWER has no single transcript entry of
         * its own (it is the text half of an assistant leader split across two events), so the
         * bar mints segments whose inclusion nobody can switch. The dialog renders no control
         * for them, which is why `true` and "absent" may not be conflated.
         */
        const publishedInclusion = async (blockId: string) => {
            const read = await call(api, 'GET', route(blockId));

            expect(read.status).toBe(200);

            const block = read.json.block as Record<string, unknown>;

            return Object.hasOwn(block, 'included') ? block.included : 'unaddressable';
        };

        expect(await publishedInclusion('0-system-instructions')).toBe('unaddressable');
        expect(await publishedInclusion('0-user-prompt')).toBe('unaddressable');
        expect(await publishedInclusion(`0-assistant-${textIndex}`)).toBe('unaddressable');
        expect(await publishedInclusion(toolId)).toBe(true);

        // OFF, and the receipt is the write's own verdict read BACK off the record: the dialog
        // repaints from THIS body rather than guessing, so a refusal leaves the chip exactly
        // where it was (R6: no optimistic state).
        const off = await call(api, 'PATCH', toolRoute, { included: false });

        expect(off.status).toBe(200);
        expect(off.json).toEqual({
            session_id: created.id,
            turn_id: turn.id,
            block_id: toolId,
            included: false,
            thread_id: threadId,
            revision: 1,
            links: {
                block: toolRoute,
                transcript: `/v1/harness/sessions/${created.id}/threads/${threadId}/transcript`
            }
        });

        // The durable consequence, at the seam the core folds into the next request: the
        // round's LEADER and the result that answers its call are flagged together, and nothing
        // else moves — same entries, same ids, same text, `included: false` as the only
        // difference. `false` is the only value ever stored, the way core's own `turn.before`
        // control writes it (../harness.ts `writeIncluded`).
        expect(record.harness.threadMessages(threadId)).toStrictEqual([
            { role: 'system', content: WORKER_INSTRUCTION, messageId: 'msg-1' },
            { role: 'user', content: 'do the work', messageId: 'msg-2' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'tasks', arguments: args }], included: false, messageId: 'msg-3' },
            { role: 'tool', content: result, toolCallId: 'call-1', name: 'tasks', included: false, messageId: 'msg-4' },
            { role: 'assistant', content: 'finished', messageId: 'msg-5' }
        ]);

        // ON again, read back the same way — and ON REMOVES the flag rather than writing
        // `included: true`, so the durable document keeps the shape every other writer expects.
        const on = await call(api, 'PATCH', toolRoute, { included: true });

        expect(on.status).toBe(200);
        expect(on.json).toEqual({
            session_id: created.id,
            turn_id: turn.id,
            block_id: toolId,
            included: true,
            thread_id: threadId,
            revision: 2,
            links: {
                block: toolRoute,
                transcript: `/v1/harness/sessions/${created.id}/threads/${threadId}/transcript`
            }
        });
        expect(record.harness.threadMessages(threadId)).toStrictEqual([
            { role: 'system', content: WORKER_INSTRUCTION, messageId: 'msg-1' },
            { role: 'user', content: 'do the work', messageId: 'msg-2' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'tasks', arguments: args }], messageId: 'msg-3' },
            { role: 'tool', content: result, toolCallId: 'call-1', name: 'tasks', messageId: 'msg-4' },
            { role: 'assistant', content: 'finished', messageId: 'msg-5' }
        ]);

        // OFF once more, for the two reads the dialog and the bar actually make.
        expect((await call(api, 'PATCH', toolRoute, { included: false })).json).toMatchObject({ included: false, revision: 3 });

        // R7 on the detail surface: the segment is still the SAME segment — same recorded
        // bytes, same state — with one extra fact. `inPrompt` stays true on purpose: that is
        // the projector's claim about the run that already happened, while `included` is the
        // reader-facing axis for the requests that FOLLOW (../shared/turn-display.ts:542-560).
        expect((await call(api, 'GET', toolRoute)).json.block).toMatchObject({
            kind: 'tool',
            id: toolId,
            name: 'tasks',
            state: 'ok',
            chars: args.length + result.length,
            inPrompt: true,
            included: false,
            args,
            result
        });

        // The compact surface keeps every figure it had, flagless. The bar counts the recorded
        // ledger, which this write does not touch; a segment that stopped riding in the prompt
        // is still the same number of recorded characters, and the dialog is where the switch
        // shows up.
        const context = ((await call(api, 'GET', displayRoute)).json.display as { sections: { context: Record<string, unknown>[] }[] })
            .sections[0].context;

        expect(context.map((segment) => [segment.id, segment.chars, segment.inPrompt, segment.included])).toEqual([
            ['0-system-instructions', WORKER_INSTRUCTION.length, true, undefined],
            ['0-user-prompt', 11, true, undefined],
            [toolId, args.length + result.length, true, undefined],
            [`0-assistant-${textIndex}`, 8, true, undefined]
        ]);
        expect(JSON.stringify(record.turns[0].events)).toBe(ledger);

        // A segment with no addressable entry REFUSES rather than answering a quiet no-op —
        // the alternative is a chip that looks like it worked and changed nothing.
        for (const blockId of ['0-system-instructions', '0-user-prompt', `0-assistant-${textIndex}`]) {
            const refusal = await call(api, 'PATCH', route(blockId), { included: false });

            expect(refusal.status).toBe(409);
            expect(refusal.json).toEqual({
                error: {
                    message: `Context segment "${blockId}" has no transcript entry to switch: the call it recorded is not in this conversation's transcript.`
                }
            });
        }

        // A block the bar never minted and a turn that does not exist stay 404s, and the body
        // gate is the GENERATED one: only `included` rides, and only as a real boolean — the
        // same strictness `setIncluded` applies to its own argument.
        expect((await call(api, 'PATCH', route('0-tool-9999'), { included: false })).status).toBe(404);
        expect(
            (await call(api, 'PATCH', `/v1/harness/sessions/${created.id}/turns/nope/blocks/${toolId}`, { included: false })).status
        ).toBe(404);
        expect((await call(api, 'PATCH', toolRoute, {})).json).toEqual({
            error: { message: 'A context segment inclusion write requires a boolean "included" value.' }
        });
        expect((await call(api, 'PATCH', toolRoute, { included: 'no' })).json).toEqual({
            error: { message: 'A context segment inclusion write requires a boolean "included" value.' }
        });
        expect((await call(api, 'PATCH', toolRoute, { nope: true })).json).toEqual({
            error: { message: 'Unknown field "nope". Allowed fields: included.' }
        });
    });
});

// ---------------------------------------------------------------------------
// The bar across a restart (R4/R6): the compiled counts are REBUILT from the durable
// record, and the instruction text they counted is the text the turn actually ran
// with — not whatever the catalogue or the preset says today.
// ---------------------------------------------------------------------------

describe('the context bar survives a restart with the counts it recorded', () => {
    it('rebuilds the identical bar, freezes a historical instruction snapshot, and never invents one for a legacy turn', async () => {
        const root = tempRoot('bar-restart');
        const before = storeOf([toolRoundPreset()], root);
        const created = await before.create('worker');

        await runTurn(before, created.id, 'do the work');

        const viewBefore = before.getView(created.id);
        const firstTurnId = viewBefore.turns[0].id;
        const barBefore = viewBefore.displays[firstTurnId].sections[0].context;
        const systemBefore = before.blockDetail(created.id, firstTurnId, '0-system-instructions');

        expect(barBefore?.map((block) => block.kind)).toEqual(['system', 'user', 'tool', 'assistant']);
        expect(barBefore?.[0]).toEqual({
            kind: 'system',
            id: '0-system-instructions',
            turnId: firstTurnId,
            sectionId: `${firstTurnId}:0`,
            name: 'instructions',
            at: expect.any(Number),
            chars: WORKER_INSTRUCTION.length,
            inPrompt: true
        });
        expect(barBefore?.[1]).toMatchObject({ id: '0-user-prompt', name: 'prompt', chars: 11, inPrompt: true });
        expect(systemBefore.entries).toEqual([WORKER_INSTRUCTION]);

        // A NEW PROCESS over the same root, with the preset instruction rewritten. The
        // session's live agents are now seeded differently, and a historical turn must
        // still report the bytes IT ran with.
        const rewritten = 'A much later rewrite of the instructions.';
        const after = storeOf([toolRoundPreset('worker', rewritten)], root);

        expect(after.getView(created.id).displays[firstTurnId].sections[0].context).toEqual(barBefore);
        expect(after.blockDetail(created.id, firstTurnId, '0-system-instructions')).toEqual(systemBefore);

        // A turn submitted AFTER the edit records its OWN snapshot, so the present moves
        // while the history stays frozen (no silent mutation of recorded metadata).
        const second = await runTurn(after, created.id, 'again');
        const barAfter = after.getView(created.id).displays[second.id].sections[0].context ?? [];

        expect(barAfter.find((block) => block.kind === 'system')?.chars).toBe(rewritten.length);
        expect(after.blockDetail(created.id, second.id, '0-system-instructions').entries).toEqual([rewritten]);

        // A document written before snapshots existed: no evidence, therefore NO system
        // segment — an honest absence rather than a count reconstructed from today.
        const legacyRoot = tempRoot('bar-legacy');
        const seeded = storeOf([toolRoundPreset()], legacyRoot);
        const legacySession = await seeded.create('worker');

        await runTurn(seeded, legacySession.id, 'do the work');

        const file = path.join(legacyRoot, HARNESS_DATABASE_DIRECTORY, HARNESS_DATABASE_FILE);
        const document = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: Record<string, unknown>[] };

        for (const session of document.sessions) delete session.turnInstructionSources;

        fs.writeFileSync(file, JSON.stringify(document));

        const legacy = storeOf([toolRoundPreset()], legacyRoot);
        const legacyView = legacy.getView(legacySession.id);
        const legacyBar = legacyView.displays[legacyView.turns[0].id].sections[0].context ?? [];

        expect(legacyBar.map((block) => block.kind)).toEqual(['user', 'tool', 'assistant']);
        expect(legacyBar[0]).toMatchObject({ id: '0-user-prompt', chars: 11 });

        // The other segments still answer exactly: the snapshot is only what a `system`
        // segment needs, and its absence does not weaken any recorded byte elsewhere.
        const legacyPrompt = legacy.blockDetail(legacySession.id, legacyView.turns[0].id, '0-user-prompt');

        expect(legacyPrompt).toMatchObject({ kind: 'user', name: 'prompt', chars: 11, text: 'do the work' });
    });

    it('keeps recorded thinking out of the view and answers it exactly on the block route', async () => {
        // A think window far longer than the wire bound, with a marker in the MIDDLE so
        // a head-truncated preview cannot accidentally contain it.
        const thinking = `${'think-'.repeat(120)}MIND-${'tail'.repeat(120)}`;
        const store = storeOf([
            presetOf('thinker', (settings, progress) =>
                harness({
                    agents: {
                        thinker: agent({
                            model: settings.model,
                            instruction: 'Think first.',
                            stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                                yield { type: 'reasoning', delta: thinking };
                                yield { type: 'text', delta: 'answered' };
                                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                            }
                        })
                    },
                    primary: 'thinker',
                    presets: false,
                    report: { progress }
                })
            )
        ]);
        const created = await store.create('thinker');
        const turn = await runTurn(store, created.id, 'ponder this');
        const view = store.getView(created.id);
        const display = view.displays[turn.id];

        // R1/R3: thinking is never replayed in full. The node is a bounded preview with
        // its EXACT length beside it, and the recorded body appears nowhere in the view.
        expect(JSON.stringify(view)).not.toContain('MIND-');

        const think = display.sections[0].nodes.find((node) => node.kind === 'reasoning') as {
            text: string;
            chars?: number;
            redacted?: boolean;
        };

        expect(think.chars).toBe(thinking.length);
        expect(think.redacted).toBe(true);
        expect(think.text.length).toBeLessThanOrEqual(DISPLAY_NODE_PREVIEW_CHARS);

        // The CURRENT answer is the other designated carrier, so it is not bounded.
        const answer = display.sections[0].nodes.find((node) => node.kind === 'text') as {
            text: string;
            chars?: number;
            redacted?: boolean;
        };

        expect(answer).toEqual({ kind: 'text', id: expect.any(String), text: 'answered', committed: true, chars: 8 });

        // R8: the segment answers with the WHOLE recorded window, concatenated from the
        // recorded deltas in order — and its count says "not prompt text".
        const block = display.sections[0].context?.find((entry) => entry.kind === 'reasoning');

        if (block === undefined) throw new Error('the think window minted no segment');

        expect(block.chars).toBe(thinking.length);
        expect(block.inPrompt).toBe(false);
        expect(block.durationMs).toBeUndefined();

        const detail = store.blockDetail(created.id, turn.id, block.id);

        expect(detail.text).toBe(thinking);
        expect(detail.chars).toBe(thinking.length);
        expect(JSON.stringify(detail)).toContain('MIND-');
    });

    it('streams bounded context ops to an observer, and a reset drops the recorded snapshots', async () => {
        const root = tempRoot('bar-ops');
        const store = storeOf([toolRoundPreset()], root);
        const created = await store.create('worker');
        const frames: unknown[] = [];

        store.watchView(
            created.id,
            (item) => {
                frames.push(item);
            },
            () => {}
        );

        await store.dispatch(created.id, 'do the work');
        await store.waitForIdle(created.id);

        const ops = frames.flatMap((frame) => ((frame as { ops?: Record<string, unknown>[] }).ops ?? []));
        const added = ops.filter((op) => op.op === 'context:add');

        // The bar is BUILT by the stream: a watcher never folds anything itself. (The
        // order here is MINT order — the bar's own order is asserted on the view above.)
        expect(added.map((op) => (op.block as { kind: string }).kind)).toEqual(['system', 'user', 'tool', 'assistant']);
        expect(ops.some((op) => op.op === 'context:set')).toBe(true);

        // R23 (T23): the stream builds the TAIL too. The call takes the designation when it
        // opens (with its recorded request), again when it settles (with its recorded
        // response), and the answer takes it back — so a watcher that never asks for a
        // detail route still shows the current block in full, live.
        expect(ops.filter((op) => op.op === 'tail:set').map((op) => (op.tail as { kind: string }).kind)).toEqual([
            'tool',
            'tool',
            'assistant'
        ]);

        // R1/R3 on the WIRE, and stated exactly: the oversized payload reached the browser on
        // the TWO frames where it WAS the current block, and on no other op — never on a
        // `step:set`, a `context:*` frame or the row.
        const withPayload = ops.filter((op) => JSON.stringify(op).includes(SENTINEL));

        expect(withPayload.map((op) => op.op)).toEqual(['tail:set', 'tail:set']);
        expect((withPayload[0].tail as { args?: string }).args).toContain(SENTINEL);
        expect((withPayload[1].tail as { result?: string }).result).toContain(SENTINEL);
        expect(JSON.stringify(added)).not.toContain(SENTINEL);
        // The frame that ENDS the run leaves no full payload behind: the answer superseded
        // the call, so every op after that designation is compact again — a stale tail on
        // the wire is a bug, not a rendering choice.
        const lastDesignation = ops.map((op) => op.op).lastIndexOf('tail:set');

        expect(JSON.stringify(ops.slice(lastDesignation + 1))).not.toContain(SENTINEL);
        expect(JSON.stringify(store.getView(created.id))).not.toContain(SENTINEL);
        expect(frames.some((frame) => (frame as { type: string }).type === 'event')).toBe(false);

        const statePath = path.join(root, HARNESS_DATABASE_DIRECTORY, HARNESS_DATABASE_FILE);
        const before = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { sessions: Record<string, unknown>[] };

        expect(before.sessions[0].turnInstructionSources).toBeDefined();

        // A reset ends the conversation, so the recorded snapshots go with it; the next
        // turn freezes whatever its agents run with then.
        await store.reset(created.id);

        const after = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { sessions: Record<string, unknown>[] };

        expect('turnInstructionSources' in after.sessions[0]).toBe(false);
        expect(store.getView(created.id).turns).toEqual([]);
    });
});

describe('the raw surface is unchanged', () => {
    it('still answers the raw routes with full records, and the raw stream with event frames', async () => {
        const store = storeOf([toolRoundPreset()]);
        const api = createHarnessApi({
            store,
            defaults: { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true },
            registry: createHarnessRegistry([toolRoundPreset()])
        });
        const created = await store.create('worker');
        const items: SessionStreamItem[] = [];

        await store.run(created.id, 'raw still works', (item) => {
            items.push(item);
        });

        expect(items.some((item) => item.type === 'event')).toBe(true);
        expect(items.some((item) => item.type === 'snapshot')).toBe(true);
        expect(JSON.stringify(items)).toContain(SENTINEL);
        expect(store.get(created.id).turns[0].events.length).toBeGreaterThan(2);
    });
});
