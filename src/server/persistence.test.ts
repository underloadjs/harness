// Focused R3b persistence tests.
//
// Everything runs against injected scripted presets and a REAL database root under
// the repo-root Temp/ directory: no provider, no network. Each test gets its own
// root so one test can never restore another test's sessions. "Restart" means a
// FRESH runtime/store built over the same root, never a disposed instance reused.
//
// Assertions are exact where the value is known (registry metadata, transcripts,
// turn records, created-tool results) and identity-based across a restart for
// server-generated timestamps (the restored record must preserve the original).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agent, harness, tool } from '../harness';
import type {
    HarnessMessage,
    HarnessProgress,
    HarnessSnapshot,
    HarnessStream,
    HarnessStreamEvent
} from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { createWebSearchCatalogueEntry, createToolCatalogue } from './harnesses';
import {
    HARNESS_DATABASE_VERSION,
    HarnessPersistence,
    HarnessPersistenceError,
    INTERRUPTED_TOOL_RESULT_TEXT,
    repairInterruptedToolCalls
} from './persistence';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { getHarnessRuntime, setHarnessRuntime } from './runtime';
import type { SessionSnapshot } from './protocol';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-persistence-${label}-`));
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

// Force the unconfigured webSearch entry so the catalogue does not depend on the
// test runner's environment (nor on a developer's .env).
const CATALOGUE = createToolCatalogue({
    websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
});

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

// A one-agent, one-answer scripted harness. The third factory argument is wired
// to the core observer exactly like a production preset, so the store's
// state-change persistence path is exercised.
const liveScriptedPreset = (name = 'one', text = 'hello'): HarnessPreset =>
    presetOf(name, (settings, progress: HarnessProgress, report) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: `You are the ${name} scripted agent.`,
                    stream: answerStream(text)
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

// A harness whose first turn blocks after one delta. Used to prove that a running
// turn is saved as running and restored as interrupted, never replayed.
const gatedPreset = (): { preset: HarnessPreset; started: Promise<void>; release: () => void } => {
    let startRun!: () => void;
    const started = new Promise<void>((resolve) => {
        startRun = resolve;
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });

    const preset = presetOf('gated', (settings, progress, report) =>
        harness({
            agents: {
                gated: agent({
                    model: settings.model,
                    instruction: 'You are the gated scripted agent.',
                    stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                        yield { type: 'text', delta: 'held' };
                        startRun();
                        await gate;
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'gated',
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
    );

    return { preset, started, release };
};

const runtimeOf = (root: string, presets: HarnessPreset[]): HarnessRuntime =>
    createHarnessRuntime({
        root,
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry(presets),
        catalogue: CATALOGUE,
        loadEnvironment: false
    });

const stateFile = (root: string): string => path.join(root, 'harness', 'state.json');

describe('R3b durable harness database', () => {
    it('restores a same-root restart with registry, transcript, turns, models, records, and created tools', async () => {
        const root = tempRoot('restart');
        const preset = liveScriptedPreset('one', 'persisted answer');

        const first = runtimeOf(root, [preset]);
        const created = first.store.create('one');
        const id = created.id;

        // One completed turn: the transcript and the turn record must survive.
        await first.store.run(id, 'remember this', async () => {});

        // A durable session record (todoManage) and a durable runtime-created tool.
        expect(await first.store.callTool(id, 'todoManage', { action: 'add', text: 'keep me' })).toEqual({
            todo: { id: '1', text: 'keep me', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
        expect(
            await first.store.callTool(id, 'toolCreate', {
                name: 'echoed',
                description: 'Returns parameters upper-cased.',
                tags: ['test'],
                source: 'return String(args).toUpperCase();'
            })
        ).toEqual({
            name: 'echoed',
            description: 'Returns parameters upper-cased.',
            tags: ['test'],
            enabled: true
        });

        // A live model retarget: recorded beside the snapshot so it survives even
        // when the snapshot is stale.
        const patched = first.store.setAgentModels(id, { one: 'next/model' });
        expect(patched.agentModels).toEqual({ one: 'next/model' });

        // A user-created registry entry that must come back after restart.
        first.registry.create({
            name: 'mine',
            title: 'My harness',
            description: 'created through the API',
            primary: 'instruct'
        });
        first.store.persistRegistry();

        const before = first.store.get(id);
        expect(before.discoveredTools).toEqual(['echoed']);
        const todosBefore = await first.store.callTool(id, 'todoManage', { action: 'list' });
        expect(todosBefore).toEqual({
            todos: [{ id: '1', text: 'keep me', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });

        // No secrets in the canonical file (server key or session model note).
        const raw = fs.readFileSync(stateFile(root), 'utf8');
        expect(raw).not.toContain('server-secret-key');
        const parsed = JSON.parse(raw) as {
            version: number;
            sessions: { id: string; settings: Record<string, unknown>; turns: unknown[] }[];
            registry: { name: string; primary: string }[];
        };
        expect(parsed.version).toBe(HARNESS_DATABASE_VERSION);
        expect(parsed.sessions).toHaveLength(1);
        expect(parsed.sessions[0].id).toBe(id);
        expect(parsed.sessions[0].settings).toEqual({
            baseURL: SETTINGS.baseURL,
            model: SETTINGS.model
        });
        expect(Object.keys(parsed.sessions[0].settings)).toEqual(['baseURL', 'model']);
        expect(parsed.registry.map((entry) => entry.name)).toContain('mine');

        // Simulate a process restart: completely fresh registry/runtime/store over
        // the SAME root. `dispose()` commits before teardown, like a graceful stop.
        first.store.dispose();

        const second = runtimeOf(root, [preset]);
        const restored = second.store.get(id);

        expect(restored.harness).toBe('one');
        expect(restored.createdAt).toBe(before.createdAt);
        expect(restored.updatedAt).toBe(before.updatedAt);
        expect(restored.status).toBe('idle');
        expect(restored.messages).toEqual(before.messages);
        expect(restored.turns).toEqual(before.turns);
        expect(restored.discoveredTools).toEqual(['echoed']);
        expect(restored.agentModels).toEqual({ one: 'next/model' });
        expect(restored.harnessDefinition).toEqual(before.harnessDefinition);
        expect(await second.store.callTool(id, 'todoManage', { action: 'list' })).toEqual(todosBefore);
        expect(await second.store.callTool(id, 'echoed', 'works')).toBe('WORKS');

        // Registry metadata re-created from disk (not from the seed list).
        const mine = second.registry.find('mine');
        expect(mine).toBeDefined();
        expect(mine?.title).toBe('My harness');
        expect(mine?.description).toBe('created through the API');
        expect(mine?.primary).toBe('instruct');
        expect(mine?.builtin).toBe(false);
        expect(mine?.editable).toBe(true);
        expect(mine?.agents).toEqual(['instruct']);
    });

    it('preserves a queued backlog and marks a running turn interrupted without replaying it', async () => {
        const root = tempRoot('interrupted');
        const fixture = gatedPreset();
        const first = runtimeOf(root, [fixture.preset]);

        const created = first.store.create('gated');
        const id = created.id;

        const running = first.store.run(id, 'hold the turn', async () => {});
        await fixture.started;

        // A queued prompt accepted while the first turn is still running.
        const queued = first.store.enqueue(id, 'do this next');
        expect(queued.turn.status).toBe('queued');

        // The start transition was written through BEFORE provider work, and the
        // accepted backlog is part of the same document.
        const duringRun = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            sessions: {
                id: string;
                status: string;
                turns: { id: string; status: string }[];
                queue: string[];
            }[];
        };
        const stored = duringRun.sessions[0];
        expect(stored.id).toBe(id);
        expect(stored.status).toBe('running');
        expect(stored.turns.map((turn) => turn.status)).toEqual(['running', 'queued']);
        expect(stored.queue).toEqual([queued.turn.id]);

        // Fresh runtime over the same root while the first process is still alive:
        // this is the crash/restart case (no dispose, no terminal write).
        const second = runtimeOf(root, [fixture.preset]);
        const restored = second.store.get(id);

        expect(restored.status).toBe('error');
        expect(restored.lastError).toBe(
            'The previous run was interrupted by a server restart; it was not replayed. Review the recorded events before continuing.'
        );
        expect(restored.turns.map((turn) => turn.status)).toEqual(['error', 'queued']);
        expect(restored.turns[0].events.map((event) => event.type)).toEqual(['start', 'text']);
        expect(restored.queueDepth).toBe(1);
        expect(restored.turns[1].prompt).toBe('do this next');
        expect(restored.turns[1].startedAt).toBeUndefined();

        // No automatic replay: the restored queue stays paused and no frame or run
        // starts on its own.
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(second.store.get(id).turns.map((turn) => turn.status)).toEqual(['error', 'queued']);

        // Finish the original run so the test leaves no open work.
        fixture.release();
        await running;
    });

    it('keeps a session frozen after a registry patch and restores it from its own record', async () => {
        const root = tempRoot('frozen');

        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });
        const created = first.store.create('demo');
        const frozenDefinition = first.store.get(created.id).harnessDefinition;

        expect(frozenDefinition?.title).toBe('Scripted demo');

        // Metadata-only patch of the shipped demo: the registry entry changes, the
        // session keeps its captured factory and descriptor.
        first.registry.update('demo', { title: 'Renamed demo', description: 'patched' });
        first.store.persistRegistry();

        first.store.dispose();

        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        expect(second.registry.find('demo')?.title).toBe('Renamed demo');
        expect(second.registry.find('demo')?.description).toBe('patched');

        const restored = second.store.get(created.id);
        expect(restored.harness).toBe('demo');
        expect(restored.harnessDefinition).toEqual(frozenDefinition);
        expect(restored.harnessDefinition?.title).toBe('Scripted demo');
        // The scripted factory survives a metadata-only patch: messages are the
        // seeded scripted system transcript (the demo fixture does not run here).
        expect(restored.messages.map((message) => message.role)).toEqual(['system', 'system']);
    });

    it('rebuilds a live session from its frozen record after an executable registry patch', () => {
        const root = tempRoot('frozen-live');

        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });
        const created = first.store.create('instruct');
        const frozen = first.store.get(created.id).harnessDefinition;
        expect(frozen?.primary).toBe('instruct');

        // Executable patch: the registry entry now routes to a different agent.
        first.registry.update('instruct', { primary: 'workspace', subagents: [] });
        first.store.persistRegistry();
        first.store.dispose();

        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        expect(second.registry.find('instruct')?.primary).toBe('workspace');
        expect(second.registry.find('instruct')?.agents).toEqual(['workspace']);

        const restored = second.store.get(created.id);
        expect(restored.harnessDefinition).toEqual(frozen);
        expect(restored.harnessDefinition?.primary).toBe('instruct');
        // Every member of the FROZEN team reports its effective model (T3: the
        // shipped instruct team is six agents), so the restored conversation renders
        // the same dropdowns it had before the restart.
        expect(restored.agentModels).toEqual({
            instruct: SETTINGS.model,
            research: SETTINGS.model,
            workspace: SETTINGS.model,
            reviewer: SETTINGS.model,
            planner: SETTINGS.model,
            summarizer: SETTINGS.model
        });
        // The frozen harness was rebuilt (not the patched registry entry).
        expect(restored.messages.map((message) => message.role)).toEqual(['system', 'system']);
    });

    it('isolates distinct roots and reuses one runtime per root', async () => {
        const rootA = tempRoot('isolation-a');
        const rootB = tempRoot('isolation-b');
        const preset = liveScriptedPreset('one');

        const runtimeA = createHarnessRuntime({
            root: rootA,
            settings: SETTINGS,
            defaults: DEFAULTS,
            registry: createHarnessRegistry([preset]),
            catalogue: CATALOGUE,
            loadEnvironment: false
        });
        const runtimeB = createHarnessRuntime({
            root: rootB,
            settings: SETTINGS,
            defaults: DEFAULTS,
            registry: createHarnessRegistry([preset]),
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        const a = runtimeA.store.create('one');
        const b = runtimeB.store.create('one');

        expect(runtimeA.root).not.toBe(runtimeB.root);
        expect(runtimeA.store.list().map((session) => session.id)).toEqual([a.id]);
        expect(runtimeB.store.list().map((session) => session.id)).toEqual([b.id]);
        expect(fs.existsSync(stateFile(rootA))).toBe(true);
        expect(fs.existsSync(stateFile(rootB))).toBe(true);

        runtimeA.store.dispose();
        runtimeB.store.dispose();

        // The shared service singleton is keyed by resolved root: the same root
        // reuses one runtime, a different root cannot (no silent cross-root reuse).
        const shared = getHarnessRuntime({
            root: rootA,
            settings: SETTINGS,
            defaults: DEFAULTS,
            registry: createHarnessRegistry([preset]),
            catalogue: CATALOGUE,
            loadEnvironment: false
        });
        expect(
            getHarnessRuntime({
                root: rootA,
                settings: SETTINGS,
                defaults: DEFAULTS,
                registry: createHarnessRegistry([preset]),
                catalogue: CATALOGUE,
                loadEnvironment: false
            })
        ).toBe(shared);
        expect(
            getHarnessRuntime({
                root: rootB,
                settings: SETTINGS,
                defaults: DEFAULTS,
                registry: createHarnessRegistry([preset]),
                catalogue: CATALOGUE,
                loadEnvironment: false
            })
        ).not.toBe(shared);

        setHarnessRuntime(undefined, rootA);
        setHarnessRuntime(undefined, rootB);
    });

    it('does not silently reset an unknown version or corrupt document', () => {
        const root = tempRoot('corrupt');
        const persistence = new HarnessPersistence(root);

        // First run: no file => undefined (an empty database is not an error).
        expect(persistence.load()).toBeUndefined();

        // Malformed JSON: the error names the file and the canonical file is kept.
        fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
        fs.writeFileSync(stateFile(root), '{', 'utf8');

        let malformed: unknown;
        try {
            persistence.load();
        } catch (error) {
            malformed = error;
        }

        expect(malformed).toBeInstanceOf(HarnessPersistenceError);
        expect((malformed as Error).message).toContain('is not valid JSON');
        expect(fs.readFileSync(stateFile(root), 'utf8')).toBe('{');

        // Unknown version: rejected before any field is interpreted.
        fs.writeFileSync(
            stateFile(root),
            JSON.stringify({ version: 999, savedAt: 0, registry: [], sessions: [] }),
            'utf8'
        );

        let versioned: unknown;
        try {
            persistence.load();
        } catch (error) {
            versioned = error;
        }

        expect(versioned).toBeInstanceOf(HarnessPersistenceError);
        expect((versioned as Error).message).toContain('Unsupported harness database version 999');
        expect((versioned as Error).message).toContain(path.join('harness', 'state.json'));

        // A runtime built over the corrupt root fails loudly instead of serving an
        // empty store.
        expect(() =>
            createHarnessRuntime({
                root,
                settings: SETTINGS,
                defaults: DEFAULTS,
                registry: createHarnessRegistry([liveScriptedPreset('one')]),
                catalogue: CATALOGUE,
                loadEnvironment: false
            })
        ).toThrow(HarnessPersistenceError);
    });

    it('writes atomically (canonical file only, no staging leftovers) and recreates nothing on load failure', () => {
        const root = tempRoot('atomic');
        const runtime = runtimeOf(root, [liveScriptedPreset('one')]);
        runtime.store.create('one');

        const directory = path.join(root, 'harness');
        expect(fs.readdirSync(directory)).toEqual(['state.json']);

        // A second save replaces the same file atomically; staging names are
        // unique and removed before the call returns.
        runtime.store.persistRegistry();
        expect(fs.readdirSync(directory)).toEqual(['state.json']);

        runtime.store.dispose();
        expect(fs.readdirSync(directory)).toEqual(['state.json']);
    });

    it('persists registry create/patch made through the dispatcher before answering', async () => {
        const root = tempRoot('registry-api');
        const first = runtimeOf(root, [liveScriptedPreset('one')]);

        const created = await first.api({
            method: 'POST',
            pathname: '/v1/harness/harnesses',
            mount: '/v1/harness',
            readBody: async () => ({ name: 'viaapi', title: 'Via API', primary: 'instruct' })
        });

        expect(created).toMatchObject({ kind: 'json', status: 201 });
        if (created.kind !== 'json') throw new Error('expected JSON');

        const patched = await first.api({
            method: 'PATCH',
            pathname: '/v1/harness/harnesses/viaapi',
            mount: '/v1/harness',
            readBody: async () => ({ description: 'patched over HTTP' })
        });
        expect(patched).toMatchObject({ kind: 'json', status: 200 });

        first.store.dispose();

        const second = runtimeOf(root, [liveScriptedPreset('one')]);
        const restored = second.registry.find('viaapi');
        expect(restored).toBeDefined();
        expect(restored?.title).toBe('Via API');
        expect(restored?.description).toBe('patched over HTTP');
        expect(restored?.builtin).toBe(false);
    });

    it('keeps completed tool/store mutations from an interrupted turn (mutation-boundary snapshot)', async () => {
        const root = tempRoot('midrun-record');
        let startSecond!: () => void;
        const secondRequest = new Promise<void>((resolve) => {
            startSecond = resolve;
        });

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        let request = 0;
        const preset = presetOf('mutator', (settings, progress, report) =>
            harness({
                agents: {
                    mutator: agent({
                        model: settings.model,
                        instruction: 'Mutate one record, then hold the run open.',
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            request++;

                            if (request === 1) {
                                yield {
                                    type: 'done',
                                    stopReason: 'tool_calls',
                                    toolCalls: [
                                        {
                                            id: 'c1',
                                            name: 'todoManage',
                                            arguments: '{"action":"add","text":"done before crash"}'
                                        }
                                    ]
                                };
                                return;
                            }

                            yield { type: 'text', delta: 'holding' };
                            startSecond();
                            await gate;
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'mutator',
                presets: false,
                report: {
                    progress,
                    ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
                }
            })
        );

        const first = runtimeOf(root, [preset]);
        const created = first.store.create('mutator');
        const running = first.store.run(created.id, 'mutate then hold', async () => {});
        await secondRequest;

        // The tool completed while the run was still active. The core now permits a
        // synchronous snapshot at a mutation boundary, so the observer saved the
        // todo record; a crash here must not lose it.
        const second = runtimeOf(root, [preset]);
        const restored = second.store.get(created.id);

        expect(restored.turns[0].status).toBe('error');
        expect(await second.store.callTool(created.id, 'todoManage', { action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'done before crash', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
        // Interrupted, not replayed: the restored turn keeps the completed tool
        // exchange and gains no new provider request.
        expect(restored.turns[0].events.map((event) => event.type)).toContain('tool_result');

        release();
        await running;
    });

    it('repairs interrupted transcripts: completed results kept, missing ids synthesised in order', () => {
        const empty = harness({
            agents: {
                lead: agent({
                    model: 'scripted/model',
                    instruction: 'lead',
                    stream: answerStream('lead')
                }),
                helper: agent({
                    model: 'scripted/model',
                    instruction: 'helper',
                    stream: answerStream('helper')
                })
            },
            primary: 'lead',
            presets: false
        }).snapshot();

        const withMessages = (
            messages: Record<string, HarnessMessage[]>
        ): HarnessSnapshot => ({
            ...empty,
            agents: Object.fromEntries(
                Object.entries(empty.agents).map(([name, entry]) => [
                    name,
                    { ...entry, messages: messages[name] ?? entry.messages }
                ])
            )
        });

        // 1. A single dangling call gets one explicit non-success result.
        const dangling = withMessages({
            lead: [
                { role: 'user', content: 'go' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'c1', name: 'todoManage', arguments: '{}' }]
                }
            ]
        });

        const repaired = repairInterruptedToolCalls(dangling);
        expect(repaired.agents.lead.messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'todoManage', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: INTERRUPTED_TOOL_RESULT_TEXT,
                toolCallId: 'c1',
                name: 'todoManage'
            }
        ]);

        // 2. Partial multi-call: the completed result is byte-identical and keeps
        // its position; only the missing id is appended, after it.
        const partial = withMessages({
            lead: [
                { role: 'user', content: 'run both' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'done-1', name: 'todoManage', arguments: '{"action":"list"}' },
                        { id: 'lost-2', name: 'todoManage', arguments: '{"action":"add","text":"x"}' }
                    ]
                },
                { role: 'tool', content: '{"todos":[]}', toolCallId: 'done-1', name: 'todoManage' }
            ]
        });

        const partialRepaired = repairInterruptedToolCalls(partial);
        expect(partialRepaired.agents.lead.messages).toEqual([
            { role: 'user', content: 'run both' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'done-1', name: 'todoManage', arguments: '{"action":"list"}' },
                    { id: 'lost-2', name: 'todoManage', arguments: '{"action":"add","text":"x"}' }
                ]
            },
            { role: 'tool', content: '{"todos":[]}', toolCallId: 'done-1', name: 'todoManage' },
            {
                role: 'tool',
                content: INTERRUPTED_TOOL_RESULT_TEXT,
                toolCallId: 'lost-2',
                name: 'todoManage'
            }
        ]);

        // 3. A fully paired transcript is a no-op (identity, no rebuild).
        expect(repairInterruptedToolCalls(empty)).toBe(empty);
        expect(repairInterruptedToolCalls(partialRepaired)).toBe(partialRepaired);

        // 4. Subagent transcripts are repaired independently; record stores are
        // never touched by the repair.
        const multiAgent = withMessages({
            lead: [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'lead-1', name: 'agentDelegate', arguments: '{}' }]
                }
            ],
            helper: [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'helper-1', name: 'todoManage', arguments: '{}' }]
                }
            ]
        });

        const multiRepaired = repairInterruptedToolCalls(multiAgent);
        expect(multiRepaired.agents.lead.messages[1]).toEqual({
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT_TEXT,
            toolCallId: 'lead-1',
            name: 'agentDelegate'
        });
        expect(multiRepaired.agents.helper.messages[1]).toEqual({
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT_TEXT,
            toolCallId: 'helper-1',
            name: 'todoManage'
        });
        expect(multiRepaired.records).toBe(multiAgent.records);
        expect(multiRepaired.discovery).toBe(multiAgent.discovery);
        expect(multiRepaired.createdTools).toBe(multiAgent.createdTools);

        // The input snapshot is not mutated.
        expect(multiAgent.agents.lead.messages).toHaveLength(1);
    });

    it('restores an orphaned tool call as interrupted and sends a coherent next prompt, without executing it', async () => {
        const root = tempRoot('orphan');
        const requests: HarnessMessage[][] = [];
        const preset = presetOf('probe', (settings, progress, report) =>
            harness({
                agents: {
                    probe: agent({
                        model: settings.model,
                        instruction: 'Record the transcript, then answer.',
                        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
                            requests.push(
                                request.messages.map(
                                    (message) => JSON.parse(JSON.stringify(message)) as HarnessMessage
                                )
                            );
                            yield { type: 'text', delta: 'ok' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                primary: 'probe',
                presets: false,
                report: {
                    progress,
                    ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
                }
            })
        );

        const first = runtimeOf(root, [preset]);
        const created = first.store.create('probe');
        await first.store.callTool(created.id, 'todoManage', { action: 'add', text: 'kept record' });
        first.store.dispose();

        // Simulate the active-snapshot window T22 discovered: the persisted core
        // ends with an assistant tool_call whose result was never appended.
        const file = stateFile(root);
        const database = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            sessions: { core: { agents: Record<string, { messages: HarnessMessage[] }> } }[];
        };
        const transcript = database.sessions[0].core.agents.probe;
        transcript.messages.push({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'orphan-1', name: 'todoManage', arguments: '{"action":"add","text":"never run"}' }]
        });
        fs.writeFileSync(file, JSON.stringify(database, null, 2), 'utf8');

        const second = runtimeOf(root, [preset]);
        const restored = second.store.get(created.id);
        // This crafted document has no running turn, so the SESSION is idle; the
        // repair is about transcript coherence, not status. (A real mid-run file
        // also carries status 'running', which restores as 'error' above.)
        expect(restored.status).toBe('idle');
        expect(restored.messages.at(-1)).toEqual({
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT_TEXT,
            toolCallId: 'orphan-1',
            name: 'todoManage'
        });

        // The orphan call was never executed: only the pre-crash record exists.
        expect(await second.store.callTool(created.id, 'todoManage', { action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'kept record', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });

        // T4 introduced fresh blocks: every server turn reseeds the agent
        // conversation, so the next prompt sends only the instructions plus THIS
        // prompt. The repaired orphan remains part of the RESTORED record (asserted
        // above) but is deliberately not replayed into a new block, and it was never
        // executed. This replaces the old "history is inherited" expectation.
        await second.store.run(created.id, 'continue please', async () => {});
        const sent = requests[0];
        expect(sent).toEqual([
            { role: 'system', content: 'Record the transcript, then answer.' },
            { role: 'user', content: 'continue please' }
        ]);
        expect(sent.some((message) => message.role === 'tool')).toBe(false);
    });

    it('recovers a genuinely hanging tool as interrupted on a fresh runtime and never re-executes it', async () => {
        const root = tempRoot('hanging-tool');
        let toolStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            toolStarted = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let executions = 0;
        let request = 0;

        const preset = presetOf('blocking', (settings, progress, report) =>
            harness({
                agents: {
                    blocking: agent({
                        model: settings.model,
                        instruction: 'Call the blocking tool once.',
                        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
                            request++;

                            if (request === 1) {
                                yield {
                                    type: 'done',
                                    stopReason: 'tool_calls',
                                    toolCalls: [{ id: 'hang-1', name: 'blockTool', arguments: '{}' }]
                                };
                                return;
                            }

                            yield { type: 'text', delta: 'finished' };
                            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                        }
                    })
                },
                tools: {
                    blockTool: tool({
                        description: 'Blocks until the test releases it.',
                        tags: ['test'],
                        visibility: 'core',
                        execute: async () => {
                            executions++;
                            toolStarted();
                            await gate;
                            return 'released';
                        }
                    })
                },
                primary: 'blocking',
                presets: false,
                report: {
                    progress,
                    ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
                }
            })
        );

        const first = runtimeOf(root, [preset]);
        const created = first.store.create('blocking');
        const running = first.store.run(created.id, 'call it', async () => {});
        await started;

        // The run is paused inside the tool: the persisted snapshot ends with the
        // assistant tool_call and no result. A fresh runtime must repair it and
        // leave it paused (no replay). Reset the counter so a second execution in
        // this process would be observable.
        executions = 0;

        const second = runtimeOf(root, [preset]);
        const restored = second.store.get(created.id);
        expect(restored.turns[0].status).toBe('error');
        expect(restored.messages.at(-1)).toEqual({
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT_TEXT,
            toolCallId: 'hang-1',
            name: 'blockTool'
        });

        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(executions).toBe(0);
        expect(second.store.get(created.id).turns[0].events.map((event) => event.type)).not.toContain(
            'tool_result'
        );

        release();
        await running;
    });

    it('resumes a session whose base URL is foreign without a persisted credential', () => {
        const root = tempRoot('foreign');
        const preset = liveScriptedPreset('one');

        const first = runtimeOf(root, [preset]);
        const created = first.store.create('one', { baseURL: 'http://elsewhere.invalid/v1' });
        first.store.dispose();

        const second = runtimeOf(root, [preset]);
        // Restore must not fail on the missing key; the session is unauthenticated
        // because a foreign endpoint never receives the server credential.
        expect(second.store.get(created.id).harness).toBe('one');
        const raw = fs.readFileSync(stateFile(root), 'utf8');
        expect(raw).not.toContain('server-secret-key');
        expect(raw).not.toContain('apiKey');
    });

    // R8: deleting a session is a FULL removal, not a hidden row. The whole
    // document is rewritten without the record, so transcript, turns, core
    // records (todos), the live model map and settings all disappear with it —
    // and a fresh runtime over the same root cannot see it either.
    it('removes a deleted session from state.json and from a same-root reload', async () => {
        const root = tempRoot('delete');
        const keepPreset = liveScriptedPreset('one', 'kept answer');
        const doomedPreset = liveScriptedPreset('two', 'deleted answer');

        const first = runtimeOf(root, [keepPreset, doomedPreset]);
        const keep = first.store.create('one');
        const doomed = first.store.create('two');

        // Both sessions get real content: deleting one must leave the other's
        // transcript/turns untouched.
        await first.store.run(keep.id, 'keep this', async () => {});
        await first.store.run(doomed.id, 'delete this transcript', async () => {});

        // Durable session state on the doomed record: a todo (core snapshot), a
        // live per-agent model map and its own settings model.
        expect(await first.store.callTool(doomed.id, 'todoManage', { action: 'add', text: 'delete me too' })).toEqual({
            todo: { id: '1', text: 'delete me too', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
        expect(first.store.setAgentModels(doomed.id, { two: 'next/model' }).agentModels).toEqual({
            two: 'next/model'
        });

        const keptBefore = first.store.get(keep.id);
        const doomedBefore = first.store.get(doomed.id);

        const before = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            sessions: { id: string }[];
        };
        // Insertion order: the surviving session comes first.
        expect(before.sessions.map((session) => session.id)).toEqual([keep.id, doomed.id]);

        // The delete itself persists before returning.
        expect(first.store.remove(doomed.id)).toBe(true);
        expect(first.store.remove(doomed.id)).toBe(false);
        expect(first.store.list().map((session) => session.id)).toEqual([keep.id]);

        const raw = fs.readFileSync(stateFile(root), 'utf8');
        // Nothing from the removed record may survive: not the id, not the prompt,
        // the recorded answer, the todo text, or the live model id.
        expect(raw).not.toContain(doomed.id);
        expect(raw).not.toContain('delete this transcript');
        expect(raw).not.toContain('deleted answer');
        expect(raw).not.toContain('delete me too');
        expect(raw).not.toContain('next/model');
        // ...while the surviving session is still whole.
        expect(raw).toContain(keep.id);
        expect(raw).toContain('keep this');

        first.store.dispose();

        // A fresh runtime over the SAME root (a process restart) has no trace of
        // the deleted session, and the surviving one restores unchanged.
        const second = runtimeOf(root, [keepPreset, doomedPreset]);
        expect(second.store.list().map((session) => session.id)).toEqual([keep.id]);
        expect(() => second.store.get(doomed.id)).toThrow(`Unknown session "${doomed.id}".`);
        expect(second.store.get(keep.id)).toEqual(keptBefore);
        expect(doomedBefore.id).toBe(doomed.id);
    });
});
