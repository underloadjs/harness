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
import { afterAll, describe, expect, it, vi } from 'vitest';
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
import { ALL_PRESET_TEMPLATES, createWebSearchCatalogueEntry, createToolCatalogue } from './harnesses';
import { AGENT_PROFILES, agentInstruction } from '../agents';
import { SessionStore } from './sessions';
import {
    HARNESS_DATABASE_DIRECTORY,
    HARNESS_DATABASE_FILE,
    HARNESS_DATABASE_VERSION,
    HarnessPersistence,
    HarnessPersistenceError,
    INTERRUPTED_TOOL_RESULT_TEXT,
    readHarnessDatabase,
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

// Force the unconfigured search entry so the catalogue does not depend on the
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
        const created = await first.store.create('one');
        const id = created.id;

        // One completed turn: the transcript and the turn record must survive.
        await first.store.run(id, 'remember this', async () => {});

        // A durable session record (task) and a durable runtime-created tool.
        expect(await first.store.callTool(id, 'task', { tasks: [{ text: 'keep me' }] })).toEqual({
            tasks: [{ id: '1', text: 'keep me', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
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
        const patched = await first.store.setAgentModels(id, { one: 'next/model' });
        expect(patched.agentModels).toEqual({ one: 'next/model' });

        // A user-created registry entry that must come back after restart.
        first.registry.create({
            name: 'mine',
            title: 'My harness',
            description: 'created through the API',
            primary: 'instruct'
        });
        await first.store.persistRegistry();

        const before = first.store.get(id);
        expect(before.discoveredTools).toEqual(['echoed']);
        const todosBefore = await first.store.callTool(id, 'task', {});
        expect(todosBefore).toEqual({
            tasks: [{ id: '1', text: 'keep me', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
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
        expect(await second.store.callTool(id, 'task', {})).toEqual(todosBefore);
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

    // T3 editable configuration. An instruction override is EXECUTABLE state: a
    // restart must bring back both the map and the prompts the next session runs, or
    // the saved configuration the reader edited would silently revert on reboot.
    it('restores a saved instruction override and applies it to the rebuilt factory', async () => {
        const root = tempRoot('instructions');
        const preset = liveScriptedPreset('one', 'persisted answer');

        const first = runtimeOf(root, [preset]);
        first.registry.create({
            name: 'voiced',
            primary: 'research',
            subagents: ['summarizer'],
            agentInstructions: { summarizer: 'Condense to one line.' }
        });
        await first.store.persistRegistry();

        // It is in the durable document (not only in memory).
        const stored = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            registry: { name: string; agentInstructions?: Record<string, string> }[];
        };
        expect(stored.registry.find((entry) => entry.name === 'voiced')?.agentInstructions).toEqual({
            summarizer: 'Condense to one line.'
        });

        first.store.dispose();

        const second = runtimeOf(root, [preset]);
        const restored = second.registry.find('voiced');

        expect(restored?.agentInstructions).toEqual({ summarizer: 'Condense to one line.' });
        // The override replaces ONLY the identity sentence, and both sections live in
        // ONE entry: `agentInstruction()` joins them into a single string so the
        // rebuilt factory seeds one system message (../agents/index.ts).
        expect(restored?.create(SETTINGS, () => undefined).agents.summarizer.instructions).toEqual([
            'Condense to one line.\n\nGuidelines:\n- Keep names, numbers, and conclusions.\n- Drop preamble and repetition.'
        ]);
    });

    // R2 identity colors — the third per-agent map, persisted and restored exactly like
    // the two above, plus the half that matters most for a display field: a document
    // written before colors exists must restore byte-identically, with NO `agentColors`
    // key invented anywhere (a UI distinguishes "no configured color" from "an empty
    // one", and only the absent key is the honest answer for an old row).
    it('restores a saved color map and applies it to the rebuilt factory', async () => {
        const root = tempRoot('colors');
        const preset = liveScriptedPreset('one', 'persisted answer');

        const first = runtimeOf(root, [preset]);
        first.registry.create({
            name: 'painted',
            primary: 'research',
            subagents: ['summarizer'],
            agentColors: { research: '#4ade80', summarizer: '#f97316' }
        });
        await first.store.persistRegistry();

        // It is in the durable document, not only in memory.
        const stored = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            registry: { name: string; agentColors?: Record<string, string> }[];
        };
        expect(stored.registry.find((entry) => entry.name === 'painted')?.agentColors).toEqual({
            research: '#4ade80',
            summarizer: '#f97316'
        });

        first.store.dispose();

        const second = runtimeOf(root, [preset]);
        const restored = second.registry.find('painted');

        expect(restored?.agentColors).toEqual({ research: '#4ade80', summarizer: '#f97316' });
        // The rebuilt factory still captures the map, so the NEXT session's agents carry
        // the swatches the operator configured — the restart cannot quietly repaint them.
        const rebuilt = restored!.create(SETTINGS, () => undefined);
        expect(rebuilt.agents.research.color).toBe('#4ade80');
        expect(rebuilt.agents.summarizer.color).toBe('#f97316');
    });

    it('restores a pre-color registry document unchanged', async () => {
        const root = tempRoot('colors-legacy');
        const preset = liveScriptedPreset('one', 'persisted answer');

        const first = runtimeOf(root, [preset]);
        first.registry.create({
            name: 'unpainted',
            primary: 'research',
            subagents: ['summarizer'],
            // An OVERRIDE the pre-R2 loader already understood: proves the new optional
            // field is read alongside the old ones rather than replacing them.
            agentModels: { summarizer: 'small/fast' }
        });
        await first.store.persistRegistry();

        const stored = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            registry: { name: string; agentColors?: Record<string, string> }[];
        };
        const row = stored.registry.find((entry) => entry.name === 'unpainted')!;
        // Absent, not `{}`: an uncolored harness writes no field at all.
        expect(Object.hasOwn(row, 'agentColors')).toBe(false);

        first.store.dispose();

        const second = runtimeOf(root, [preset]);
        const restored = second.registry.find('unpainted')!;

        // The ENTRY normalizes an absent map to `{}` (exactly what `agentModels` and
        // `agentInstructions` do), while the durable row keeps the field absent. What must
        // not happen is a stored color appearing where none was ever written.
        expect(restored.agentColors).toEqual({});
        expect(restored.agentModels).toEqual({ summarizer: 'small/fast' });
        // And no agent of the rebuilt harness carries a color key.
        const rebuilt = restored.create(SETTINGS, () => undefined);
        expect(Object.hasOwn(rebuilt.agents.summarizer, 'color')).toBe(false);
        expect(rebuilt.agents.summarizer.model()).toBe('small/fast');
    });

    it('keeps a frozen session descriptor color across a restart and a later recolor', async () => {
        const root = tempRoot('colors-frozen');
        const preset = liveScriptedPreset('one', 'persisted answer');

        const first = runtimeOf(root, [preset]);
        first.registry.create({
            name: 'painted',
            primary: 'research',
            subagents: ['summarizer'],
            agentColors: { summarizer: '#4ade80' }
        });
        await first.store.persistRegistry();

        const created = await first.store.create('painted');
        const frozen = first.store.get(created.id).harnessDefinition;
        // The session's frozen copy carries the color the card held at creation time.
        expect(frozen?.agentColors).toEqual({ summarizer: '#4ade80' });

        // A later recolor of the registry entry, then a restart.
        first.registry.update('painted', { agentColors: { summarizer: '#f97316' } });
        await first.store.persistRegistry();
        first.store.dispose();

        const second = runtimeOf(root, [preset]);

        expect(second.registry.find('painted')?.agentColors).toEqual({ summarizer: '#f97316' });

        const restored = second.store.get(created.id);
        // The FROZEN descriptor round-trips unchanged: `readDescriptor` restores the
        // creation-time map, which is what keeps an existing conversation's palette
        // stable while the definition moves on.
        expect(restored.harnessDefinition).toEqual(frozen);
        expect(restored.harnessDefinition?.agentColors).toEqual({ summarizer: '#4ade80' });
    });

    // ---------------------------------------------------------------------------
    // R7: the session-defined agent map. A harness DEFINITION never carries one (the registry's
    // create/PATCH surface exposes no field for it), so the writer that produces the value is a
    // session's own frozen preset copy (./sessions.ts `applyBindingMaps` → `presetToRecord`).
    // What the persistence layer owns is the READER: restore the map exactly (a restart rebuilds
    // the invented agent from it), invent nothing for a document that predates the field, and
    // refuse a stored value that is not text instead of silently producing a broken roster.
    // ---------------------------------------------------------------------------
    it('restores a stored custom agent map, adds nothing to a pre-R7 document, and refuses a non-string entry', async () => {
        const root = tempRoot('custom-agents');
        const first = runtimeOf(root, [liveScriptedPreset('one')]);
        const sessionId = (await first.store.create('one')).id;

        first.store.dispose();

        const document = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>;
        const stored = document.sessions.find((entry: Record<string, any>) => entry.id === sessionId);

        // Absent, not `{}`: a session with no invented agent writes no key anywhere, so the
        // document is byte-identical to what an older build saved for the same conversation.
        expect(Object.hasOwn(stored.preset, 'customAgents')).toBe(false);
        expect(Object.hasOwn(document.registry[0], 'customAgents')).toBe(false);

        // The shape a newer writer produces: one session-defined agent, named by its own base
        // instruction. Stamped on both halves, because a foreign writer (or a hand-edited file)
        // may put it on either, and the reader must accept both.
        stored.preset.customAgents = { localizer: 'You rewrite copy for the target market.' };
        document.registry[0].customAgents = {
            localizer: 'You rewrite copy for the target market.'
        };
        fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');

        const loaded = readHarnessDatabase(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')));

        expect(loaded.sessions.find((entry) => entry.id === sessionId)?.preset.customAgents).toEqual({
            localizer: 'You rewrite copy for the target market.'
        });
        expect(loaded.registry.find((entry) => entry.name === 'one')?.customAgents).toEqual({
            localizer: 'You rewrite copy for the target market.'
        });

        // A non-string entry is a broken document, refused with the path that names it.
        const broken = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>;
        broken.sessions
            .find((entry: Record<string, any>) => entry.id === sessionId)
            .preset.customAgents = { localizer: 7 };

        expect(() => readHarnessDatabase(broken)).toThrow(
            /preset\.customAgents\.localizer must be a string\./
        );
    });

    it('preserves a queued backlog and marks a running turn interrupted without replaying it', async () => {
        const root = tempRoot('interrupted');
        const fixture = gatedPreset();
        const first = runtimeOf(root, [fixture.preset]);

        const created = await first.store.create('gated');
        const id = created.id;

        const running = first.store.run(id, 'hold the turn', async () => {});
        await fixture.started;

        // A queued prompt accepted while the first turn is still running.
        const queued = await first.store.enqueue(id, 'do this next');
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

        // T5: this pins the SCRIPTED demo's frozen factory, so it injects the
        // fixtures explicitly — exactly what a host that wants the offline card does.
        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            registry: createHarnessRegistry(ALL_PRESET_TEMPLATES),
            catalogue: CATALOGUE,
            loadEnvironment: false
        });
        const created = await first.store.create('demo');
        const frozenDefinition = first.store.get(created.id).harnessDefinition;

        expect(frozenDefinition?.title).toBe('Scripted demo');

        // Metadata-only patch of the shipped demo: the registry entry changes, the
        // session keeps its captured factory and descriptor.
        first.registry.update('demo', { title: 'Renamed demo', description: 'patched' });
        await first.store.persistRegistry();

        first.store.dispose();

        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            registry: createHarnessRegistry(ALL_PRESET_TEMPLATES),
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
        // ONE system message, because `agentInstruction()` joins the demo profile's
        // identity sentence and guidelines into a single prompt (../agents/index.ts).
        expect(restored.messages.map((message) => message.role)).toEqual(['system']);
        expect(restored.messages).toEqual([
            { role: 'system', content: agentInstruction(AGENT_PROFILES.demo) }
        ]);
    });

    it('rebuilds a live session from its frozen record after an executable registry patch', async () => {
        const root = tempRoot('frozen-live');

        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });
        const created = await first.store.create('instruct');
        const frozen = first.store.get(created.id).harnessDefinition;
        expect(frozen?.primary).toBe('instruct');

        // Executable patch: the registry entry now routes to a different agent.
        first.registry.update('instruct', { primary: 'workspace', subagents: [] });
        await first.store.persistRegistry();
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
        // The frozen harness was rebuilt (not the patched registry entry), and its
        // primary's prompt is the frozen instruct profile joined into ONE system
        // message (../agents/index.ts `agentInstruction`).
        expect(restored.messages.map((message) => message.role)).toEqual(['system']);
        expect(restored.messages).toEqual([
            { role: 'system', content: agentInstruction(AGENT_PROFILES.instruct) }
        ]);
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

        const a = await runtimeA.store.create('one');
        const b = await runtimeB.store.create('one');

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

    it('writes atomically (canonical file only, no staging leftovers) and recreates nothing on load failure', async () => {
        const root = tempRoot('atomic');
        const runtime = runtimeOf(root, [liveScriptedPreset('one')]);
        await runtime.store.create('one');

        const directory = path.join(root, 'harness');
        expect(fs.readdirSync(directory)).toEqual(['state.json']);

        // A second save replaces the same file atomically; staging names are
        // unique and removed before the call returns.
        await runtime.store.persistRegistry();
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
                                            name: 'task',
                                            arguments: '{"tasks":[{"text":"done before crash"}]}'
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
        const created = await first.store.create('mutator');
        const running = first.store.run(created.id, 'mutate then hold', async () => {});
        await secondRequest;

        // The tool completed while the run was still active. The core now permits a
        // synchronous snapshot at a mutation boundary, so the observer saved the
        // todo record; a crash here must not lose it.
        const second = runtimeOf(root, [preset]);
        const restored = second.store.get(created.id);

        expect(restored.turns[0].status).toBe('error');
        expect(await second.store.callTool(created.id, 'task', {})).toEqual({
            tasks: [{ id: '1', text: 'done before crash', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
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
                    toolCalls: [{ id: 'c1', name: 'task', arguments: '{}' }]
                }
            ]
        });

        const repaired = repairInterruptedToolCalls(dangling);
        expect(repaired.agents.lead.messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'task', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: INTERRUPTED_TOOL_RESULT_TEXT,
                toolCallId: 'c1',
                name: 'task'
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
                        { id: 'done-1', name: 'task', arguments: '{}' },
                        { id: 'lost-2', name: 'task', arguments: '{"tasks":[{"x"}]}' }
                    ]
                },
                { role: 'tool', content: '{"tasks":[]}', toolCallId: 'done-1', name: 'task' }
            ]
        });

        const partialRepaired = repairInterruptedToolCalls(partial);
        expect(partialRepaired.agents.lead.messages).toEqual([
            { role: 'user', content: 'run both' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'done-1', name: 'task', arguments: '{}' },
                    { id: 'lost-2', name: 'task', arguments: '{"tasks":[{"x"}]}' }
                ]
            },
            { role: 'tool', content: '{"tasks":[]}', toolCallId: 'done-1', name: 'task' },
            {
                role: 'tool',
                content: INTERRUPTED_TOOL_RESULT_TEXT,
                toolCallId: 'lost-2',
                name: 'task'
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
                    toolCalls: [{ id: 'lead-1', name: 'delegate', arguments: '{}' }]
                }
            ],
            helper: [
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'helper-1', name: 'task', arguments: '{}' }]
                }
            ]
        });

        const multiRepaired = repairInterruptedToolCalls(multiAgent);
        expect(multiRepaired.agents.lead.messages[1]).toEqual({
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT_TEXT,
            toolCallId: 'lead-1',
            name: 'delegate'
        });
        expect(multiRepaired.agents.helper.messages[1]).toEqual({
            role: 'tool',
            content: INTERRUPTED_TOOL_RESULT_TEXT,
            toolCallId: 'helper-1',
            name: 'task'
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
        const created = await first.store.create('probe');
        await first.store.callTool(created.id, 'task', { tasks: [{ text: 'kept record' }] });
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
            toolCalls: [{ id: 'orphan-1', name: 'task', arguments: '{"tasks":[{"never run"}]}' }]
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
            name: 'task'
        });

        // The orphan call was never executed: only the pre-crash record exists.
        expect(await second.store.callTool(created.id, 'task', {})).toEqual({
            tasks: [{ id: '1', text: 'kept record', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
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
        const created = await first.store.create('blocking');
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

    it('resumes a session whose base URL is foreign without a persisted credential', async () => {
        const root = tempRoot('foreign');
        const preset = liveScriptedPreset('one');

        const first = runtimeOf(root, [preset]);
        const created = await first.store.create('one', { baseURL: 'http://elsewhere.invalid/v1' });
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
        const keep = await first.store.create('one');
        const doomed = await first.store.create('two');

        // Both sessions get real content: deleting one must leave the other's
        // transcript/turns untouched.
        await first.store.run(keep.id, 'keep this', async () => {});
        await first.store.run(doomed.id, 'delete this transcript', async () => {});

        // Durable session state on the doomed record: a todo (core snapshot), a
        // live per-agent model map and its own settings model.
        expect(await first.store.callTool(doomed.id, 'task', { tasks: [{ text: 'delete me too' }] })).toEqual({
            tasks: [{ id: '1', text: 'delete me too', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false }
        });
        expect((await first.store.setAgentModels(doomed.id, { two: 'next/model' })).agentModels).toEqual({
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
        expect(await first.store.remove(doomed.id)).toBe(true);
        expect(await first.store.remove(doomed.id)).toBe(false);
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

// T5: deleting a harness has to be DURABLE, and `registry` alone cannot say "this
// shipped built-in is gone" (a fresh registry always re-seeds the shipped templates).
// The document therefore carries the deleted names in the additive `deleted` list,
// which restore replays BEFORE the rows. The invariant under test is the saved
// conversation: a session freezes its own preset record, so removing a card must
// never lose, drop, or change a transcript — including the scripted fixture, whose
// factory the restore looks up in the shipped-template superset.
describe('T5 durable harness deletion', () => {
    type Document = {
        version: number;
        savedAt: number;
        registry: { name: string; title?: string; primary?: string; builtin?: boolean }[];
        deleted?: string[];
        sessions: { id: string; harness: string }[];
    };

    const readState = (root: string): Document =>
        JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Document;

    const writeState = (root: string, document: Document): void => {
        fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');
    };

    // A registry/store with a persistence owner whose WRITE always fails: the
    // database directory sits under a path component that is a plain FILE, so the
    // store's own `mkdirSync` fails for a real reason (no mock involved).
    const failingStore = (label: string): { store: SessionStore; registry: ReturnType<typeof createHarnessRegistry> } => {
        const root = tempRoot(label);
        const blocker = path.join(root, 'blocked');
        fs.writeFileSync(blocker, 'not a directory', 'utf8');

        const registry = createHarnessRegistry();
        const store = new SessionStore(SETTINGS, registry, undefined, {
            persistence: new HarnessPersistence(path.join(blocker, 'nested'))
        });

        return { store, registry };
    };

    // D4: the strict store methods are async, so a refused write arrives as a REJECTION -
    // an async helper is the only way to observe its status and message. Same contract, awaited.
    const failureOf = async (run: () => unknown): Promise<{ status: number; message: string }> => {
        try {
            await run();
        } catch (error) {
            const failure = error as { status?: number; message: string };
            return { status: failure.status ?? 0, message: failure.message };
        }

        throw new Error('expected the mutation to fail');
    };

    it('keeps a deleted user harness gone across a restart without a tombstone', async () => {
        const root = tempRoot('delete-custom');
        const first = runtimeOf(root, [liveScriptedPreset('one')]);

        first.registry.create({ name: 'mine', title: 'Mine', primary: 'workspace' });
        expect((await first.store.mutateRegistry(() => first.registry.remove('mine'))).name).toBe('mine');

        // A user harness is absent from the document as soon as it is absent from
        // `list()`; only a built-in needs the extra record.
        const document = readState(root);
        expect(document.registry.map((entry) => entry.name)).toEqual(['one']);
        expect(document).not.toHaveProperty('deleted');

        first.store.dispose();

        const second = runtimeOf(root, [liveScriptedPreset('one')]);
        expect(second.registry.find('mine')).toBeUndefined();
        expect(second.registry.list().map((preset) => preset.name)).toEqual(['one']);
        expect(second.registry.deletedBuiltins()).toEqual([]);
    });

    it('keeps a deleted built-in gone across a restart and records the tombstone', async () => {
        const root = tempRoot('delete-builtin');

        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        // A live session on the shipped default, created before the deletion.
        const id = (await first.store.create('instruct')).id;
        const frozen = first.store.get(id).harnessDefinition;
        expect(frozen?.title).toBe('Instruct');

        await first.store.mutateRegistry(() => first.registry.remove('instruct'));

        // The card is gone for good, so a NEW session on it is a 404.
        expect(await failureOf(async () => await first.store.create('instruct'))).toEqual({
            status: 404,
            message: 'Unknown harness "instruct".'
        });

        const document = readState(root);
        expect(document.deleted).toEqual(['instruct']);
        expect(document.registry.map((entry) => entry.name)).toEqual([
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(document.sessions.map((session) => session.harness)).toEqual(['instruct']);

        first.store.dispose();

        // A restart over the same root: the shipped template comes back from the
        // module, and the tombstone takes it out again before any row is replayed.
        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        expect(second.registry.list().map((preset) => preset.name)).toEqual([
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(second.registry.find('instruct')).toBeUndefined();

        // An alias follows its target: `writer` named instruct, and instruct is gone.
        expect(second.registry.find('writer')).toBeUndefined();
        expect(second.registry.deletedBuiltins()).toEqual(['instruct']);

        // The conversation survives the deletion untouched, and the restore dropped
        // nothing: the frozen 'live' record rebuilds without a registry entry.
        expect(second.store.restoreErrors).toEqual([]);
        const restored = second.store.get(id);
        expect(restored.harness).toBe('instruct');
        expect(restored.harnessDefinition).toEqual(frozen);
        expect(second.store.list().map((session) => session.id)).toEqual([id]);
    });

    it('keeps a deleted fixture session restorable AND runnable', async () => {
        const root = tempRoot('delete-fixture-session');

        // A host that injected the offline fixture records a real conversation, then
        // deletes the card (it is a built-in in that registry, so it tombstones).
        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            registry: createHarnessRegistry(ALL_PRESET_TEMPLATES),
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        const id = (await first.store.create('demo')).id;
        await first.store.run(id, 'first question', async () => {});
        const frozen = first.store.get(id).harnessDefinition;
        expect(frozen?.title).toBe('Scripted demo');

        expect((await first.store.mutateRegistry(() => first.registry.remove('demo'))).name).toBe('demo');
        expect(readState(root).deleted).toEqual(['demo']);

        first.store.dispose();

        // Restart WITHOUT the fixture injection: `demo` is not in the production
        // catalogue at all, and the old row cannot resurrect it. The session is still
        // there, with its transcript, because its frozen record names the scripted
        // factory this build still ships as a preset.
        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        expect(second.registry.find('demo')).toBeUndefined();
        expect(second.registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(second.store.restoreErrors).toEqual([]);

        const restored = second.store.get(id);
        expect(restored.harness).toBe('demo');
        expect(restored.harnessDefinition).toEqual(frozen);
        expect(restored.turns.map((turn) => turn.prompt)).toEqual(['first question']);
        expect(restored.turns[0].status).toBe('done');

        // The rebuilt frozen harness really runs: an offline turn on a harness the
        // catalogue no longer lists.
        await second.store.run(id, 'second question', async () => {});
        expect(second.store.get(id).turns.map((turn) => turn.prompt)).toEqual([
            'first question',
            'second question'
        ]);
    });

    it('re-creating a deleted built-in name clears the tombstone durably', async () => {
        const root = tempRoot('recreate-deleted');

        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        await first.store.mutateRegistry(() => {
            first.registry.remove('workspace');

            return first.registry.create({ name: 'workspace', title: 'My coder', primary: 'reviewer' });
        });

        // Row and tombstone can never both name the harness: `create` cleared the
        // tombstone in the same synchronous block that the commit then persisted.
        const document = readState(root);
        expect(document).not.toHaveProperty('deleted');

        const row = document.registry.find((entry) => entry.name === 'workspace');
        expect(row).toBeDefined();
        expect({
            name: row?.name,
            title: row?.title,
            primary: row?.primary,
            builtin: row?.builtin
        }).toEqual({ name: 'workspace', title: 'My coder', primary: 'reviewer', builtin: false });

        first.store.dispose();

        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        expect(second.registry.deletedBuiltins()).toEqual([]);
        expect(second.registry.find('workspace')?.title).toBe('My coder');
        expect(second.registry.find('workspace')?.primary).toBe('reviewer');

        // Documented limitation of the replay: a re-created name occupies the shipped
        // row's position, so its `builtin` provenance flag comes back true (the
        // configuration is the saved one, and R20.1 makes `builtin` informational —
        // it never gates a mutation).
        expect(second.registry.find('workspace')?.builtin).toBe(true);
    });

    it('answers failure, not success, when the durable write fails — and rolls the registry back', async () => {
        const { store, registry } = failingStore('delete-write-failure');

        const failure = await failureOf(async () => await store.mutateRegistry(() => registry.remove('research')));
        expect(failure.status).toBe(500);
        expect(failure.message).toContain('Could not save the harness database');

        // In-memory state matches the (unchanged) disk: nothing was removed and no
        // tombstone was left behind, in the original listing order.
        expect(registry.find('research')?.title).toBe('Researcher');
        expect(registry.deletedBuiltins()).toEqual([]);
        expect(registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);

        // The same guarantee for a create: no phantom card.
        expect(await failureOf(async () => await store.mutateRegistry(() => registry.create({ name: 'ghost', primary: 'instruct' })))).toEqual(
            {
                status: 500,
                message: expect.stringContaining('Could not save the harness database')
            }
        );
        expect(registry.find('ghost')).toBeUndefined();

        // A failed PATCH rolls back too, so the client never sees an edit the file
        // does not carry.
        expect(
            (await failureOf(async () => await store.mutateRegistry(() => registry.update('planner', { title: 'Renamed' })))).status
        ).toBe(500);
        expect(registry.find('planner')?.title).toBe('Planner');
    });

    it('keeps an earlier tombstone when a later mutation fails', async () => {
        const { store, registry } = failingStore('tombstone-rollback');

        // One committed deletion (in-memory), then a failure that must not undo it.
        registry.restoreDeletedBuiltins(['workspace']);
        expect(registry.deletedBuiltins()).toEqual(['workspace']);

        expect((await failureOf(async () => await store.mutateRegistry(() => registry.remove('reviewer')))).status).toBe(500);

        // The snapshot is taken per mutation, so the rolled-back state is exactly the
        // state at the start of THAT mutation: workspace still deleted, reviewer back.
        expect(registry.deletedBuiltins()).toEqual(['workspace']);
        expect(registry.find('reviewer')?.title).toBe('Reviewer');
    });

    it('reads a document without the additive field and validates it when present', async () => {
        const root = tempRoot('deleted-shape');
        const first = runtimeOf(root, [liveScriptedPreset('one')]);
        await first.store.create('one');
        first.store.dispose();

        // A pre-T5 document has no `deleted` key, loads, and is reported as absent
        // (not as an empty list) so a rewrite keeps its exact shape.
        const before = readState(root);
        expect(before).not.toHaveProperty('deleted');
        expect(new HarnessPersistence(root).load()).not.toHaveProperty('deleted');

        // Names are trimmed and de-duplicated (a name listed twice is one fact).
        const tidied = readState(root);
        tidied.deleted = ['instruct', 'instruct', ' research '];
        writeState(root, tidied);
        expect(new HarnessPersistence(root).load()?.deleted).toEqual(['instruct', 'research']);

        // Everything else is corruption of the named slot, reported per slot.
        const notAnArray = readState(root);
        notAnArray.deleted = 'instruct' as never;
        writeState(root, notAnArray);
        expect(() => new HarnessPersistence(root).load()).toThrow(
            'The harness database deleted must be an array of harness names.'
        );

        const blank = readState(root);
        blank.deleted = ['ok', '   '];
        writeState(root, blank);
        expect(() => new HarnessPersistence(root).load()).toThrow('deleted[1] must not be blank.');

        const notAString = readState(root);
        notAString.deleted = [7 as never];
        writeState(root, notAString);
        expect(() => new HarnessPersistence(root).load()).toThrow('deleted[0] must be a string.');
    });

    it('does not resurrect a built-in the document never recorded as deleted', async () => {
        // The additive field must not change behaviour for an untouched document:
        // every shipped default is still there, and the rows replay exactly as before.
        const root = tempRoot('no-tombstone');
        const first = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });
        first.registry.update('instruct', { title: 'Edited default' });
        await first.store.persistRegistry();
        first.store.dispose();

        const second = createHarnessRuntime({
            root,
            settings: SETTINGS,
            defaults: DEFAULTS,
            catalogue: CATALOGUE,
            loadEnvironment: false
        });

        expect(second.registry.find('instruct')?.title).toBe('Edited default');
        expect(second.registry.list().map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner'
        ]);
        expect(second.registry.deletedBuiltins()).toEqual([]);
    });
});

// T14/F4: a persisted conversation label is AUTHORITATIVE display state, so it must
// be a label this server can actually emit. A blank/lowercase/zero-ordinal/free-text
// value (for example a global creation ordinal such as `T8`) would otherwise be
// adopted as a conversation name and break `#LABEL` resolution, so the load fails
// loudly — exactly like any other structural corruption, and without touching the
// file. A valid value is normalised to the allocator's uppercase spelling.
describe('durable conversation labels (T14)', () => {
    type StoredDocument = {
        version: number;
        savedAt: number;
        registry: unknown[];
        sessions: {
            id: string;
            threadLabels?: Record<string, string>;
            threadLabelHighWater?: Record<string, number>;
            turns: { id: string; threadLabel?: string }[];
        }[];
    };

    // One persisted session that owns exactly ONE host conversation (RR1), so every
    // case below has a real thread id and a real recorded turn label to tamper with.
    const persistOneConversation = async (label: string): Promise<{
        root: string;
        threadId: string;
        turnId: string;
    }> => {
        const root = tempRoot(label);
        const runtime = runtimeOf(root, [liveScriptedPreset('researcher')]);
        const id = (await runtime.store.create('researcher')).id;
        const task = await runtime.store.enqueue(id, 'one');
        await task.settled;
        await runtime.store.waitForIdle(id);
        runtime.store.dispose();

        const threadId = task.turn.threadId;
        if (threadId === undefined) throw new Error('the persisted submit opened no conversation');
        return { root, threadId, turnId: task.turn.id };
    };

    const readDocument = (root: string): StoredDocument =>
        JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as StoredDocument;

    const writeDocument = (root: string, document: StoredDocument): void => {
        fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');
    };

    it('normalises a valid conversation label and its recorded turn label', async () => {
        const { root, threadId } = await persistOneConversation('labels-normalise');
        const document = readDocument(root);

        // Lowercase is the client/typing spelling: the durable contract is the
        // allocator's uppercase label, so both copies are normalised on load.
        document.sessions[0].threadLabels = { [threadId]: 'rr1' };
        document.sessions[0].turns[0].threadLabel = 'rr1';
        writeDocument(root, document);

        const database = new HarnessPersistence(root).load();
        const session = database?.sessions[0];
        if (session === undefined) throw new Error('the document did not load');

        expect(session.threadLabels).toEqual({ [threadId]: 'RR1' });
        expect(session.turns[0].threadLabel).toBe('RR1');
    });

    it('rejects a label the allocator can never emit', async () => {
        const { root, threadId } = await persistOneConversation('labels-reject');
        const document = readDocument(root);

        // A global creation ordinal is NOT a conversation label (R10), and `RR0` is
        // not an occurrence the allocator can mint.
        for (const bad of ['T8', 'RR0', '']) {
            const tampered = readDocument(root);
            tampered.sessions[0].threadLabels = { [threadId]: bad };
            writeDocument(root, tampered);

            expect(() => new HarnessPersistence(root).load()).toThrow(
                `sessions[0].threadLabels.${threadId} must be a conversation label such as "RR1".`
            );
        }

        // The original document is untouched by a failed load: the file still holds
        // the tampered text, and restoring valid content loads again.
        writeDocument(root, document);
        expect(new HarnessPersistence(root).load()?.sessions[0].threadLabels).toEqual({
            [threadId]: 'RR1'
        });
    });

    it('rejects a blank conversation key and a malformed recorded turn label', async () => {
        const { root, threadId } = await persistOneConversation('labels-turn');
        const document = readDocument(root);

        // A blank thread id could never be addressed by a client.
        document.sessions[0].threadLabels = { '   ': 'RR1' };
        writeDocument(root, document);
        expect(() => new HarnessPersistence(root).load()).toThrow(
            'sessions[0].threadLabels has a blank thread id key.'
        );

        // The per-turn copy is validated the same way, so a hand edit cannot smuggle
        // an arbitrary display name past the session-level map.
        const turnTampered = readDocument(root);
        turnTampered.sessions[0].threadLabels = { [threadId]: 'RR1' };
        turnTampered.sessions[0].turns[0].threadLabel = 'T8';
        writeDocument(root, turnTampered);
        expect(() => new HarnessPersistence(root).load()).toThrow(
            'sessions[0].turns[0].threadLabel must be a conversation label such as "RR1".'
        );

        // A turn WITHOUT the field is a valid old record: the key stays absent.
        const noField = readDocument(root);
        delete noField.sessions[0].turns[0].threadLabel;
        writeDocument(root, noField);
        const restored = new HarnessPersistence(root).load()?.sessions[0];
        expect(restored?.turns[0].threadLabel).toBeUndefined();
        // `toEqual` on the record proves the key is absent rather than empty.
        expect(restored?.turns[0]).not.toHaveProperty('threadLabel');
    });
});

// C8-m8: `invalidThreads` is keyed by THREAD ID — opaque, host-minted text — and the
// session reader used to build the map with ordinary bracket assignment on an object
// literal. A document naming one thread `__proto__` therefore hit the PROTOTYPE
// SETTER: `mapped['__proto__'] = value` re-points the object's prototype instead of
// storing an entry, so that conversation's raw broken transcript vanished from the
// loaded record even though the file still carried it (`Object.keys` never showed the
// id, and the operator got a 404-stale "readable" conversation instead of the text
// they have to fix). The reader now builds a NULL-PROTOTYPE map.
describe('prototype-shaped invalid transcript keys (C8-m8)', () => {
    // One persisted session, tampered with the way a foreign writer (or an older
    // build) would leave the document: an `invalidThreads` map holding a `__proto__`
    // key next to a normal thread id.
    const documentWithProtoKey = async (label: string): Promise<{ root: string; sessionId: string }> => {
        const root = tempRoot(label);
        const runtime = runtimeOf(root, [liveScriptedPreset('one')]);
        const sessionId = (await runtime.store.create('one')).id;

        runtime.store.dispose();

        // Parsed, NOT an object literal: `{ __proto__: value }` in a literal invokes
        // the setter while writing the file, which would hide the very key under test.
        const invalidThreads = JSON.parse(
            '{ "__proto__": { "error": "thread \\"__proto__\\" messages must be an array.",' +
                ' "messages": "broken", "agent": "one" },' +
                ' "thread-9": { "error": "thread \\"thread-9\\" messages must be an array.",' +
                ' "messages": "also broken", "agent": "one" } }'
        ) as Record<string, unknown>;

        const document = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>;
        document.sessions[0].invalidThreads = invalidThreads;
        fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');

        return { root, sessionId };
    };

    it('keeps a `__proto__` thread id as a stored entry through the reader', async () => {
        const { root, sessionId } = await documentWithProtoKey('invalid-proto-key');

        const database = readHarnessDatabase(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')));
        const record = database.sessions.find((entry) => entry.id === sessionId);
        const invalid = record?.invalidThreads;

        if (invalid === undefined) throw new Error('the reader dropped the invalidThreads map');

        // Both ids are REAL entries, in document order — the `__proto__` one used to
        // disappear into the prototype instead of being stored.
        expect(Object.keys(invalid)).toEqual(['__proto__', 'thread-9']);
        expect(Object.prototype.hasOwnProperty.call(invalid, '__proto__')).toBe(true);
        expect(invalid['__proto__']).toEqual({
            error: 'thread "__proto__" messages must be an array.',
            messages: 'broken',
            agent: 'one'
        });
        expect(invalid['thread-9']).toEqual({
            error: 'thread "thread-9" messages must be an array.',
            messages: 'also broken',
            agent: 'one'
        });

        // Null prototype is what makes the assignment safe (and it stays an ordinary
        // enumerable map for every consumer: Object.entries, JSON, the store merge).
        expect(Object.getPrototypeOf(invalid)).toBeNull();
        expect(Object.values(invalid)).toHaveLength(2);
    });

    it('loads the same document through the persistence owner', async () => {
        const { root, sessionId } = await documentWithProtoKey('invalid-proto-load');

        const loaded = new HarnessPersistence(root).load()?.sessions.find(
            (entry) => entry.id === sessionId
        );
        const invalid = loaded?.invalidThreads;

        if (invalid === undefined) throw new Error('load() dropped the invalidThreads map');

        expect(Object.keys(invalid)).toEqual(['__proto__', 'thread-9']);
        expect(invalid['__proto__'].messages).toBe('broken');
    });
});

// ---------------------------------------------------------------------------
// T10: the per-turn instruction snapshot. It is the ONLY durable evidence for the
// context bar's `system` segment, so the loader validates it STRUCTURALLY (a
// non-string entry would silently produce a wrong character count instead of failing)
// and an absent field must stay absent, so a pre-T10 document keeps its exact shape.
// ---------------------------------------------------------------------------

describe('durable per-turn instruction snapshots (T10)', () => {
    it('records the instruction text the run actually used', async () => {
        const root = tempRoot('instructions');
        const runtime = runtimeOf(root, [liveScriptedPreset('one', 'persisted answer')]);
        const created = await runtime.store.create('one');

        await runtime.store.run(created.id, 'remember this', async () => {});

        const loaded = readHarnessDatabase(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')));
        const record = loaded.sessions.find((session) => session.id === created.id);
        const turnId = record?.turns[0]?.id ?? '';

        // The exact seeded instruction entries, per agent, with the capture time. This
        // is what `SessionStore.blockDetail` returns as `entries`, and what the fold
        // counted into the segment's `chars`.
        expect(record?.turnInstructionSources?.[turnId]).toEqual([
            { agent: 'one', instructions: ['You are the one scripted agent.'], at: expect.any(Number) }
        ]);
    });

    it('keeps a legacy document exact, and refuses a malformed snapshot instead of mis-counting it', async () => {
        const root = tempRoot('instructions-shape');
        const runtime = runtimeOf(root, [liveScriptedPreset('one', 'persisted answer')]);
        const created = await runtime.store.create('one');

        await runtime.store.run(created.id, 'remember this', async () => {});

        const written = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as { sessions: Record<string, unknown>[] };

        // Rewrite the file the way a build BEFORE this feature wrote it.
        for (const session of written.sessions) delete session.turnInstructionSources;

        fs.writeFileSync(stateFile(root), JSON.stringify(written));

        const reopened = runtimeOf(root, [liveScriptedPreset('one', 'persisted answer')]);

        expect(reopened.store.get(created.id).turns[0].prompt).toBe('remember this');

        // Any structural mutation persists the whole document, so this proves the
        // absent key is not re-invented on the way back out.
        await reopened.store.setAgentModels(created.id, { one: 'next/model' });

        const rewritten = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as { sessions: Record<string, unknown>[] };

        expect('turnInstructionSources' in rewritten.sessions[0]).toBe(false);

        const good = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
        const refusing = (mutate: (session: Record<string, unknown>) => void, message: string): void => {
            const broken = structuredClone(good);

            mutate(broken.sessions[0]);

            expect(() => readHarnessDatabase(broken)).toThrow(message);
        };

        refusing(
            (session) => {
                session.turnInstructionSources = { t: 'not a list' };
            },
            /must be an array of instruction sources/
        );
        refusing(
            (session) => {
                session.turnInstructionSources = { t: [{ agent: 'one', instructions: 'not a list' }] };
            },
            /instructions must be an array/
        );
        refusing(
            (session) => {
                session.turnInstructionSources = { t: [{ agent: 'one', instructions: ['ok', 7] }] };
            },
            /instructions\[1\]/
        );
        refusing(
            (session) => {
                session.turnInstructionSources = { t: [{ agent: 'one', instructions: ['ok'], at: 'soon' }] };
            },
            /\.at/
        );

        // An EMPTY instruction list is a legitimate recorded value ("this agent ran with
        // no system message") and must survive untouched.
        const empty = structuredClone(good);

        empty.sessions[0].turnInstructionSources = { t: [{ agent: 'one', instructions: [] }] };

        expect(readHarnessDatabase(empty).sessions[0].turnInstructionSources).toEqual({
            t: [{ agent: 'one', instructions: [] }]
        });
    });

    it('freezes the snapshot at the turn start, so an interrupted turn still rebuilds its system segment', async () => {
        const root = tempRoot('instructions-interrupted');
        const fixture = gatedPreset();
        const first = runtimeOf(root, [fixture.preset]);
        const created = await first.store.create('gated');

        const running = first.store.run(created.id, 'hold the turn', async () => {});

        await fixture.started;

        // The turn-START write already carries the snapshot, before the run produced a
        // terminal record and before any later instruction edit could happen.
        const duringRun = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as {
            sessions: {
                turns: { id: string; status: string }[];
                turnInstructionSources?: Record<string, { agent: string; instructions: string[] }[]>;
            }[];
        };
        const stored = duringRun.sessions[0];
        const turnId = stored.turns[0].id;

        expect(stored.turns[0].status).toBe('running');
        expect(stored.turnInstructionSources?.[turnId]).toEqual([
            { agent: 'gated', instructions: ['You are the gated scripted agent.'], at: expect.any(Number) }
        ]);

        // A fresh process over the same root while the first is still alive (the crash
        // case): the interrupted turn is restored as error, and its bar is rebuilt from
        // the durable record — the instruction it ACTUALLY ran with, not a live agent
        // that no longer exists (R4/R6).
        const second = runtimeOf(root, [fixture.preset]);
        const view = second.store.getView(created.id);
        const bar = view.displays[turnId].sections[0].context ?? [];

        expect(bar.map((block) => block.kind)).toEqual(['system', 'user', 'assistant']);
        expect(bar[0]).toMatchObject({
            id: '0-system-instructions',
            chars: 'You are the gated scripted agent.'.length,
            inPrompt: true
        });
        expect(second.store.blockDetail(created.id, turnId, '0-system-instructions').entries).toEqual([
            'You are the gated scripted agent.'
        ]);

        fixture.release();
        await running;
    });
});

// ---------------------------------------------------------------------------
// T14/T15: the per-turn steered-submit TEXT archive (`SessionTurn.steerTexts`).
//
// The 64-entry `steers` list is the operational AUDIT record (and the compact row);
// the archive is the durable evidence that lets a context-bar segment answer a click
// with its exact text AFTER the ring has moved past that submit. It is ADDITIVE, so the
// reader rules are the same ones every other per-turn field follows: validate the shape
// entry by entry (a corrupt entry would surface as a segment that opens with nothing in
// it), keep an absent key absent (a pre-T14 document keeps its exact shape and loads on
// an older server), and never bump `HARNESS_DATABASE_VERSION`. It is deliberately NOT
// length-capped (T15): every entry is a submit the user made and the server ACCEPTED, so
// the reader refuses no count — only a malformed entry, wherever it sits.
// ---------------------------------------------------------------------------

describe('durable steered-submit text archive (T14)', () => {
    // One gated run with three steered submits, exactly the way a live session produces
    // them: the first `enqueue` starts the turn, the next three land while it runs.
    const steeredDocument = async (label: string): Promise<{ root: string; sessionId: string; turnId: string }> => {
        const root = tempRoot(label);
        const fixture = gatedPreset();
        const runtime = runtimeOf(root, [fixture.preset]);
        const created = await runtime.store.create('gated');

        const running = await runtime.store.enqueue(created.id, 'hold the turn');

        await fixture.started;

        // Steer into the conversation the run ACTUALLY owns (the same join the audit record
        // and the context bar attribute the submit by).
        const threadId = running.turn.threadId;

        if (threadId === undefined) throw new Error('the gated run owns no conversation');

        // D4: the three submits are DISPATCHED in one synchronous batch (that is what makes them
        // steer into the running conversation rather than queue after it), so the map callback
        // stays non-async and the awaited durability is collected with `Promise.all`.
        const steered = await Promise.all(
            ['steer one', 'steer two', 'steer three'].map(async (input) =>
                await runtime.store.enqueue(created.id, input, undefined, undefined, threadId)
            )
        );

        expect(steered.every((receipt) => receipt.steered === true)).toBe(true);
        await Promise.all(steered.map((receipt) => receipt.settled));

        fixture.release();
        await running.settled;
        await runtime.store.waitForIdle(created.id);

        return { root, sessionId: created.id, turnId: running.turn.id };
    };

    const documentOf = (root: string): Record<string, any> =>
        JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>;

    const writeDocument = (root: string, document: Record<string, any>): void => {
        fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');
    };

    it('archives every accepted submit durably, beside the unchanged audit ring', async () => {
        const { root, sessionId, turnId } = await steeredDocument('archive-write');
        const written = documentOf(root);

        // The archive is IN the checkpoint document: the live record is not the only copy.
        const turn = written.sessions[0].turns.find((entry: Record<string, any>) => entry.id === turnId);

        expect(turn.steerTexts.map((entry: Record<string, unknown>) => entry.prompt)).toEqual([
            'steer one',
            'steer two',
            'steer three'
        ]);
        expect(written.version).toBe(HARNESS_DATABASE_VERSION);

        // The identity is the archive's address, and it is the SAME id the audit ring (and
        // therefore the context-bar segment) carries.
        const loaded = new HarnessPersistence(root).load()?.sessions[0];
        const restored = loaded?.turns.find((entry) => entry.id === turnId);
        const ring = restored?.steers ?? [];
        const archive = restored?.steerTexts ?? [];

        expect(archive.map((entry) => entry.prompt)).toEqual(['steer one', 'steer two', 'steer three']);
        expect(archive.map((entry) => entry.id)).toEqual(ring.map((steer) => steer.id));
        expect(new Set(archive.map((entry) => entry.id)).size).toBe(3);
        // Exact bytes, exact times, no invented fields: a root-thread submit records no
        // destination, and the archive never carries the ring's `references`.
        expect(archive[0]).toEqual({ id: archive[0].id, at: archive[0].at, prompt: 'steer one' });
        expect(archive.every((entry) => entry.threadId === undefined)).toBe(true);

        // A FRESH process over the same root reproduces the archived bar and answers each
        // segment with its own text: the archive is what makes the click resolvable after a
        // restart, not only while the run is alive.
        const reopened = runtimeOf(root, [gatedPreset().preset]);
        const view = reopened.store.getView(sessionId);
        const segments = (view.displays[turnId].sections[0].context ?? []).filter(
            (block) => block.name === 'steer'
        );

        expect(segments.map((block) => block.id)).toEqual(archive.map((entry) => `0-user-i${entry.id}`));
        expect(segments.map((block) => block.chars)).toEqual([9, 9, 11]);
        expect(segments.map((block) => reopened.store.blockDetail(sessionId, turnId, block.id).text)).toEqual([
            'steer one',
            'steer two',
            'steer three'
        ]);

        // And the archive is NOT part of the default wire: the compact row publishes the
        // bounded audit ring only, so a turn's archived text — however many submits it holds —
        // cannot grow a normal frame.
        expect(view.turns[0].steers ?? []).toHaveLength(3);
        expect(view.turns[0]).not.toHaveProperty('steerTexts');
        // A bar segment is METADATA: the archived bytes reach a client only through the one
        // lazy block route above, never inside the compiled tree.
        expect(segments.every((block) => !('text' in block))).toBe(true);

        reopened.store.dispose();
    });

    it('keeps a pre-archive document exact and refuses to invent the key back', async () => {
        const { root, sessionId, turnId } = await steeredDocument('archive-legacy');
        const written = documentOf(root);

        // Rewrite the file the way a build BEFORE this feature wrote it.
        for (const session of written.sessions) {
            for (const turn of session.turns) delete turn.steerTexts;
        }

        writeDocument(root, written);

        const reopened = runtimeOf(root, [gatedPreset().preset]);

        expect(reopened.store.get(sessionId).turns.find((turn) => turn.id === turnId)?.steerTexts).toBeUndefined();

        // The archive-less record still projects a bar whose every segment resolves: the
        // audit ring is the complete submit list when there is no archive.
        const view = reopened.store.getView(sessionId);
        const segments = (view.displays[turnId].sections[0].context ?? []).filter((block) => block.name === 'steer');

        expect(segments).toHaveLength(3);
        expect(segments.map((block) => reopened.store.blockDetail(sessionId, turnId, block.id).text)).toEqual([
            'steer one',
            'steer two',
            'steer three'
        ]);

        // Any structural mutation rewrites the WHOLE document, so this proves the absent key
        // is not re-invented on the way back out (the same rule the T10 snapshots follow).
        await reopened.store.setAgentModels(sessionId, { gated: 'next/model' });

        const rewritten = documentOf(root);

        expect(
            rewritten.sessions[0].turns.some((turn: Record<string, unknown>) => 'steerTexts' in turn)
        ).toBe(false);

        reopened.store.dispose();
    });

    it('refuses a malformed archive instead of storing an unresolvable segment', async () => {
        const { root, turnId } = await steeredDocument('archive-shape');
        const good = documentOf(root);
        const refusing = (mutate: (turn: Record<string, unknown>) => void, message: RegExp): void => {
            const broken = structuredClone(good);

            mutate(broken.sessions[0].turns.find((entry: Record<string, unknown>) => entry.id === turnId));

            expect(() => readHarnessDatabase(broken)).toThrow(message);
        };

        refusing((turn) => {
            turn.steerTexts = 'not a list';
        }, /must be an array/);
        refusing((turn) => {
            turn.steerTexts = ['steer one'];
        }, /steerTexts\[0\] must be an object/);
        // The id is MANDATORY here (unlike the audit ring, where a pre-T13 record may lack
        // one): the archive is addressed by it, so a blank or missing key would make the
        // entry unreachable by the very route that reads it.
        refusing((turn) => {
            turn.steerTexts = [{ at: 1, prompt: 'steer one' }];
        }, /\.id must be a string/);
        refusing((turn) => {
            turn.steerTexts = [{ id: '  ', at: 1, prompt: 'steer one' }];
        }, /\.id must not be blank/);
        refusing((turn) => {
            turn.steerTexts = [{ id: 'a', at: 'soon', prompt: 'steer one' }];
        }, /\.at must be a finite number/);
        refusing((turn) => {
            turn.steerTexts = [{ id: 'a', at: 1, prompt: 7 }];
        }, /\.prompt must be a string/);
        refusing((turn) => {
            turn.steerTexts = [{ id: 'a', at: 1, prompt: 'steer one', threadId: ' ' }];
        }, /\.threadId must not be blank/);
        // T15: there is NO length cap. The archive holds accepted user data, so a document
        // with more entries than any earlier artificial bound must load verbatim rather than
        // be refused (a refused load would strand the whole session). The per-ENTRY rules
        // above are unchanged, and one bad entry among many still fails the load.
        const large = structuredClone(good);

        large.sessions[0].turns.find((entry: Record<string, unknown>) => entry.id === turnId).steerTexts = [
            ...Array.from({ length: 999 }, (_entry, index) => ({
                id: `id-${index}`,
                at: 1,
                prompt: `steer ${index}`
            })),
            { id: 'id-last', at: 2, prompt: 'steer last', threadId: 'thread-2' }
        ];

        const restored = readHarnessDatabase(large).sessions[0].turns.find((entry) => entry.id === turnId);

        expect(restored?.steerTexts).toHaveLength(1_000);
        expect(restored?.steerTexts?.[0]).toEqual({ id: 'id-0', at: 1, prompt: 'steer 0' });
        expect(restored?.steerTexts?.[998]).toEqual({ id: 'id-998', at: 1, prompt: 'steer 998' });
        // Exact bytes in acceptance order, and a destination thread survives.
        expect(restored?.steerTexts?.[999]).toEqual({
            id: 'id-last',
            at: 2,
            prompt: 'steer last',
            threadId: 'thread-2'
        });

        // Entry validation is not dropped with the cap: one malformed entry deep in a large
        // archive is still corruption, and it fails the load by name.
        const rotted = structuredClone(large);

        rotted.sessions[0].turns.find((entry: Record<string, unknown>) => entry.id === turnId).steerTexts[640].prompt = 42;

        expect(() => readHarnessDatabase(rotted)).toThrow(/steerTexts\[640\]\.prompt must be a string/);
    });
});
