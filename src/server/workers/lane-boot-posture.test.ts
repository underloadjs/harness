// B6 — a lane replica rebuilds the CANONICAL boot posture, or the session is refused.
//
// WHAT WAS BROKEN (T6 finding): `lane-worker-loop.ts` `sayHello` rebuilt a replica with
// `presetFromRecord(blueprint.record)` and no report fields, so on a deployment whose
// boot configured ZERO plugins a lane silently regained the three generated built-ins
// (`async-ping`, `context-compaction`, `context-trimmer`), a tool-less card regained the
// shared toolbox, and a finite `maxIterations` became `Infinity`. The record cannot
// carry any of those facts (`presetToRecord` lists its fields and serialises no
// executable configuration), so the blueprint has to state them as data — and every
// fact that CANNOT be expressed as data (a plugin `setup`, a command handler, a
// constructed `Tool`) has to refuse the session instead of running a different harness.
//
// The three levels pinned here:
//   1. THE RULE (`laneBootPosture`): the exact supported-vs-refused matrix, one assert
//      per row, including the sentence an operator reads;
//   2. THE REAL BLUEPRINT + REBUILD: a real `SessionStore.create` → `blueprintFor` →
//      `structuredClone` → `laneReplicaPreset` → `preset.create`, with the FULL replica
//      shaping (`refuseNestedRuns`) applied — the exact sequence `sayHello` runs, minus
//      the thread. The zero-plugin `[]` vs absent contrast is asserted on the built
//      harness's own plugin list, and the toolbox on its own registry;
//   3. THE REAL LANE: one spawned `node:worker_threads` lane for a zero-plugin,
//      zero-toolbox boot, executing a core tool through the authority. That proves the
//      new blueprint fields survive the wire and that the replica builds; it does NOT
//      inspect the worker's plugin list from outside (the thread cannot be read), which
//      is why level 2 asserts that on the same reconstruction path.
//
// Cross-references:
//   - ./capability.ts       `laneBootPosture` + the three refusal codes
//   - ./protocol.ts         `LaneToolboxPosture` / `LanePresetRebuild` / `LanePluginPosture`
//   - ../sessions.ts        `assertWorkerCapable` (the 400) and `blueprintFor` (the payload)
//   - ./lane-worker-loop.ts `laneReplicaPreset`, `lanePluginSetOf`, `assertLaneRebuildPosture`
//   - ../harnesses/toolbox.ts `SHARED_APP_TOOL_SOURCES` (the declarative extra source)
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createHarnessRegistry } from '../harnesses';
import { presetToRecord } from '../harnesses/registry';
import { SHARED_APP_TOOL_SOURCES } from '../harnesses/toolbox';
import type { HarnessPreset, RunnerSettings } from '../harnesses/types';
import { DEFAULT_RUNTIME_CONFIGURATION } from '../config';
import type { ServerRuntimeConfiguration } from '../config';
import { SessionStore } from '../sessions';
import { BUILTIN_PLUGINS } from '../../plugin';
import { tool } from '../../harness';
import type { Harness, HarnessCommandConfiguration, HarnessPlugin } from '../../types';
import type { LaneBlueprintSource } from './lane-host';
import {
    LANE_COMMANDS_NOT_REBUILDABLE_CODE,
    LANE_EXTRA_TOOLS_NOT_REBUILDABLE_CODE,
    LANE_PLUGINS_NOT_REBUILDABLE_CODE,
    assessLaneWorkerCapability,
    laneBootPosture
} from './capability';
import { assertLaneRebuildPosture, lanePluginSetOf, laneReplicaPreset, refuseNestedRuns } from './lane-worker-loop';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://localhost:9/v1',
    apiKey: 'test-key',
    model: 'test/model'
};

// The lane suite's own entry resolution rule (./lane-worker.test.ts): the entry IS the
// source, loaded through the Vite module runner, so a cold lane runs the code under test.
const WORKER_ENTRY = fileURLToPath(new URL('./lane-worker.ts', import.meta.url));

const WORKER_RUNTIME: ServerRuntimeConfiguration = {
    ...DEFAULT_RUNTIME_CONFIGURATION,
    threadExecution: 'worker',
    workerEntry: WORKER_ENTRY,
    workerIdleMs: 0,
    maxLaneWorkers: 4,
    workerHandshakeMs: 120_000
};

// A constructed definition, which is exactly the kind a boot `extraTools` map carries
// and the kind a thread cannot receive.
const probeTool = tool<Record<string, never>, { boot: true }>({
    description: 'Boot probe tool.',
    tags: ['boot', 'probe'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ boot: true })
});

// A host plugin: `setup` is a closure, so a lane cannot rebuild it.
const hostPlugin: HarnessPlugin = {
    name: 'boot-probe',
    metadata: { name: 'boot-probe', title: 'Boot probe', builtin: false, settings: [] },
    setup: () => undefined
};

// A boot slash command: its handler is a closure for the same reason.
const bootCommand: HarnessCommandConfiguration = {
    name: 'deploy',
    description: 'Deploy the current draft.',
    execute: () => ({ content: 'deployed' })
};

// A hand-built template-backed preset. The factory is never called by the capability
// gate or the posture rule; `create` exists only to satisfy `HarnessPreset`.
const presetOf = (overrides: Partial<HarnessPreset> = {}): HarnessPreset => ({
    name: 'boot',
    title: 'Boot',
    description: 'A boot-compiled card.',
    requiresEndpoint: true,
    entry: 'general',
    ranks: { general: 'A' },
    agents: ['general'],
    tools: [],
    builtin: true,
    editable: true,
    template: 'live',
    create: () => {
        throw new Error('the capability gate must decide before a build');
    },
    ...overrides
});

// The supported per-card posture: every serializable field stated, `extraToolSources`
// aliased under a name that is NOT in `SHARED_TOOL_NAMES` (`bootEcho`), because the
// record's inference reads a shared name as `sharedToolbox: true` (that mismatch is its
// own case below).
const SUPPORTED_TOOLBOX = {
    sharedToolbox: false,
    websearch: false,
    webfetch: false,
    maxIterations: 7,
    extraToolSources: { bootEcho: SHARED_APP_TOOL_SOURCES.timeNow },
    toolFolders: [] as string[]
};

const SUPPORTED_POSTURE = {
    sharedToolbox: false,
    websearch: false,
    webfetch: false,
    maxIterations: 7,
    extraToolSources: { bootEcho: SHARED_APP_TOOL_SOURCES.timeNow },
    toolFolders: []
};

// The registry a real store restores from: one profiled card whose creation metadata is
// the supported posture above.
const supportedRegistry = () =>
    createHarnessRegistry([], { creation: SUPPORTED_TOOLBOX });

const stores: SessionStore[] = [];

const track = (store: SessionStore): SessionStore => {
    stores.push(store);
    return store;
};

// `blueprintFor` is private because the lane host is its only caller (the same read
// ./lane-tool-settings.test.ts performs).
const blueprintOf = (store: SessionStore, sessionId: string): LaneBlueprintSource =>
    (
        store as unknown as {
            blueprintFor: (session: ReturnType<SessionStore['liveSession']>) => LaneBlueprintSource;
        }
    ).blueprintFor(store.liveSession(sessionId));

afterAll(async () => {
    for (const store of stores.splice(0)) store.dispose();

    // Give every terminate() a tick to land, so a closing pool cannot race a live worker.
    await new Promise((resolve) => setTimeout(resolve, 250));
});

// The full HELLO shaping, minus the thread: `refuseNestedRuns` is unconditional on a
// lane (./lane-worker-loop.ts), so applying it here keeps the asserted toolbox exactly
// what a real replica exposes.
const replicaOf = (blueprint: LaneBlueprintSource): Harness => {
    const preset = laneReplicaPreset(blueprint);
    const plugins = lanePluginSetOf(blueprint.plugins);
    const harness = preset.create(SETTINGS, () => undefined, {
        // `undefined` is the factory-default (built-ins) case, so only a STATED posture
        // becomes a report field — exactly what `sayHello` does.
        ...(plugins === undefined ? {} : { plugins })
    });

    refuseNestedRuns(harness);

    return harness;
};

describe('B6 laneBootPosture — the supported posture matrix', () => {
    it('carries the exact serializable per-card posture', () => {
        const preset = presetOf({ creation: { factory: 'profiled', toolbox: SUPPORTED_TOOLBOX } });

        expect(laneBootPosture(preset)).toEqual({
            presetRebuild: { factory: 'profiled', toolbox: SUPPORTED_POSTURE },
            reasons: []
        });
    });

    it('states the configured-zero plugin set as `none`, never as an omission', () => {
        expect(laneBootPosture(presetOf(), { plugins: [] })).toEqual({
            plugins: { kind: 'none' },
            reasons: []
        });
    });

    it('recognizes the generated BUILTIN_PLUGINS by element identity', () => {
        expect(laneBootPosture(presetOf(), { plugins: BUILTIN_PLUGINS })).toEqual({
            plugins: {
                kind: 'builtin',
                names: ['async-ping', 'context-compaction', 'context-trimmer']
            },
            reasons: []
        });
    });

    it('recognizes a subset of the generated built-ins, in the stated order', () => {
        expect(laneBootPosture(presetOf(), { plugins: [BUILTIN_PLUGINS[2], BUILTIN_PLUGINS[0]] })).toEqual({
            plugins: { kind: 'builtin', names: ['context-trimmer', 'async-ping'] },
            reasons: []
        });
    });

    it('leaves the plugin axis absent when the host never configured it', () => {
        expect(laneBootPosture(presetOf())).toEqual({ reasons: [] });
    });

    it('rejects a host plugin with a named, actionable reason', () => {
        expect(laneBootPosture(presetOf(), { plugins: [hostPlugin] })).toEqual({
            reasons: [
                {
                    code: LANE_PLUGINS_NOT_REBUILDABLE_CODE,
                    message:
                        "This deployment applies 1 configured plugin (boot-probe) that a lane worker cannot rebuild: a plugin's `setup` is a closure, and only the generated built-in set (async-ping, context-compaction, context-trimmer) can be reconstructed in a worker. Not reconstructable: boot-probe. Configure the generated `BUILTIN_PLUGINS` (optionally a subset, by identity), configure none, or run this session with threadExecution \"inline\"."
                }
            ]
        });
    });

    it('rejects a boot command list, naming every handler', () => {
        expect(laneBootPosture(presetOf(), { commands: [bootCommand] })).toEqual({
            reasons: [
                {
                    code: LANE_COMMANDS_NOT_REBUILDABLE_CODE,
                    message:
                        'This deployment registers 1 boot slash command (deploy) whose handler is a closure and cannot be rebuilt in a lane worker. Register no boot commands, or run this session with threadExecution "inline" (where the canonical harness owns the handlers).'
                }
            ]
        });
    });

    it('rejects constructed extraTools definitions, naming them', () => {
        expect(
            laneBootPosture(
                presetOf({
                    creation: {
                        factory: 'profiled',
                        toolbox: { sharedToolbox: false, extraTools: { probeTool } }
                    }
                })
            )
        ).toEqual({
            reasons: [
                {
                    code: LANE_EXTRA_TOOLS_NOT_REBUILDABLE_CODE,
                    message:
                        'Harness "boot" was configured with 1 constructed extra tool (probeTool). A `Tool` definition is a closure and cannot cross into a lane worker, so the replica would run a smaller toolbox than this session. Register those tools as editable source paths (`extraToolSources`) or run this session with threadExecution "inline".'
                }
            ]
        });
    });

    it('rejects a host factory that is tagged as a live template', () => {
        expect(laneBootPosture(presetOf({ creation: { factory: 'advanced' } }))).toEqual({
            reasons: [
                {
                    code: 'preset-not-rebuildable',
                    message:
                        'Harness "boot" was injected as a host factory closure, so a lane worker cannot rebuild it from its durable record. Register it as a profiled template-backed harness ("live"), or run this session with threadExecution "inline".'
                }
            ]
        });
    });

    it('reports every refused axis in the order the operator can act on them', () => {
        const posture = laneBootPosture(
            presetOf({
                creation: {
                    factory: 'profiled',
                    toolbox: { sharedToolbox: false, extraTools: { probeTool } }
                }
            }),
            { plugins: [hostPlugin], commands: [bootCommand] }
        );

        expect(posture.reasons.map((entry) => entry.code)).toEqual([
            LANE_EXTRA_TOOLS_NOT_REBUILDABLE_CODE,
            LANE_PLUGINS_NOT_REBUILDABLE_CODE,
            LANE_COMMANDS_NOT_REBUILDABLE_CODE
        ]);
        expect(posture.presetRebuild).toBeUndefined();
        expect(posture.plugins).toBeUndefined();
    });
});

describe('B6 assessLaneWorkerCapability — the exact refusal at session creation', () => {
    it('accepts a profiled card with a configured-zero plugin set', () => {
        const preset = presetOf({ creation: { factory: 'profiled', toolbox: SUPPORTED_TOOLBOX } });

        expect(assessLaneWorkerCapability(preset, { workersAvailable: true }, { plugins: [] })).toMatchObject({
            supported: true,
            reasons: []
        });
    });

    it('refuses a host plugin set before the session can run a turn', () => {
        const capability = assessLaneWorkerCapability(presetOf(), { workersAvailable: true }, {
            plugins: [hostPlugin]
        });

        expect(capability.supported).toBe(false);
        expect(capability.reasons).toEqual([
            {
                code: LANE_PLUGINS_NOT_REBUILDABLE_CODE,
                message:
                    "This deployment applies 1 configured plugin (boot-probe) that a lane worker cannot rebuild: a plugin's `setup` is a closure, and only the generated built-in set (async-ping, context-compaction, context-trimmer) can be reconstructed in a worker. Not reconstructable: boot-probe. Configure the generated `BUILTIN_PLUGINS` (optionally a subset, by identity), configure none, or run this session with threadExecution \"inline\"."
            }
        ]);
    });

    it('reports the injected-factory reason once, not twice, for a template-less preset', () => {
        const capability = assessLaneWorkerCapability(presetOf({ name: 'custom', template: undefined }), {
            workersAvailable: true
        });

        expect(capability.reasons).toEqual([
            {
                code: 'preset-not-rebuildable',
                message:
                    'Harness "custom" was injected as a factory closure, so a lane worker cannot rebuild it. Register it as a template-backed harness ("live"), or run this session with threadExecution "inline".'
            }
        ]);
    });

    it('refuses a session at store.create with the same sentence the gate reports', async () => {
        const registry = createHarnessRegistry([], { creation: { sharedToolbox: false } });

        registry.create({ name: 'boot', agents: ['general'] });

        const store = track(
            new SessionStore(SETTINGS, registry, undefined, {
                runtime: WORKER_RUNTIME,
                plugins: [hostPlugin]
            })
        );

        await expect(store.create('boot')).rejects.toThrow(
            "This harness cannot run its threads on worker lanes: This deployment applies 1 configured plugin (boot-probe) that a lane worker cannot rebuild: a plugin's `setup` is a closure, and only the generated built-in set (async-ping, context-compaction, context-trimmer) can be reconstructed in a worker. Not reconstructable: boot-probe. Configure the generated `BUILTIN_PLUGINS` (optionally a subset, by identity), configure none, or run this session with threadExecution \"inline\"."
        );
    });
});

describe('B6 the real blueprint and the real rebuild path', () => {
    it('ships the approved posture as structured-clone-safe data', async () => {
        const registry = supportedRegistry();

        registry.create({ name: 'boot', agents: ['general'] });

        const store = track(
            new SessionStore(SETTINGS, registry, undefined, { runtime: WORKER_RUNTIME, plugins: [] })
        );
        const session = await store.create('boot');
        const blueprint = blueprintOf(store, session.id);

        expect(blueprint.presetRebuild).toEqual({
            factory: 'profiled',
            toolbox: SUPPORTED_POSTURE
        });
        expect(blueprint.plugins).toEqual({ kind: 'none' });
        // THE WIRE RULE: every frame is structured-cloneable. The posture is booleans,
        // numbers, path strings and names, so the whole blueprint clones byte-identically.
        expect(structuredClone(blueprint)).toEqual(blueprint);
    });

    it('rebuilds the SAME posture and exposes a zero-plugin, zero-toolbox replica', async () => {
        const registry = supportedRegistry();

        registry.create({ name: 'boot', agents: ['general'] });

        const store = track(
            new SessionStore(SETTINGS, registry, undefined, { runtime: WORKER_RUNTIME, plugins: [] })
        );
        const session = await store.create('boot');
        const blueprint = structuredClone(blueprintOf(store, session.id));
        const preset = laneReplicaPreset(blueprint);

        // The per-card posture survives `presetFromRecord`: budget, extra source and the
        // explicit empty folder list all come back exactly.
        expect(preset.creation).toEqual({
            factory: 'profiled',
            toolbox: SUPPORTED_POSTURE
        });

        const replica = replicaOf(blueprint);

        // THE ZERO-PLUGIN HALF: `plugins: []` from the blueprint becomes
        // `builtinPlugins: []` + `plugins: []` in the factory, so the generated three
        // are NOT there.
        expect(replica.plugins).toEqual([]);
        // THE TOOLBOX HALF: only the harness-owned core floor plus the declarative extra
        // source. No shared catalogue row (`read`/`grep`/…) and no web row.
        expect(Object.keys(replica.tools).sort()).toEqual([
            'agentManage',
            'agentResult',
            'bootEcho',
            'chapters',
            'knowledge',
            'locations',
            'profiles',
            'records',
            'sleep',
            'tasks',
            'toolCancel',
            'toolCreate',
            'toolList',
            'toolManage',
            'toolRegistry',
            'toolRequest'
        ]);
    });

    it('proves the plugin field is load-bearing by contrasting it with its omission', async () => {
        const registry = supportedRegistry();

        registry.create({ name: 'boot', agents: ['general'] });

        const store = track(
            new SessionStore(SETTINGS, registry, undefined, { runtime: WORKER_RUNTIME, plugins: [] })
        );
        const session = await store.create('boot');
        const blueprint = blueprintOf(store, session.id);

        // The same record and posture, with the plugin axis UNSTATED: the factory default
        // is what a pre-B6 replica ran, and it is exactly the three optional built-ins.
        const { plugins: _omitted, ...withoutPlugins } = blueprint;
        const defaultReplica = replicaOf(withoutPlugins as LaneBlueprintSource);

        expect(defaultReplica.plugins).toEqual(['async-ping', 'context-compaction', 'context-trimmer']);
        expect(replicaOf(blueprint).plugins).toEqual([]);
    });

    it('faults a rebuild whose record cannot express the approved posture', () => {
        // A boot card that ALIASES a shared tool name as its extra source: the record's
        // declaration then infers `sharedToolbox: true`, so the rebuilt factory would
        // register the whole shared catalogue on a card built tool-less. The posture is
        // approved (it is all data); the REBUILD is what cannot honour it, and that is a
        // hello fault, never a silently wider replica.
        const registry = createHarnessRegistry([], {
            creation: { ...SUPPORTED_TOOLBOX, extraToolSources: { timeNow: SHARED_APP_TOOL_SOURCES.timeNow } }
        });

        registry.create({ name: 'boot', agents: ['general'] });

        const card = registry.find('boot') as HarnessPreset;
        const posture = laneBootPosture(card).presetRebuild;

        expect(posture).toEqual({
            factory: 'profiled',
            toolbox: {
                sharedToolbox: false,
                websearch: false,
                webfetch: false,
                maxIterations: 7,
                extraToolSources: { timeNow: SHARED_APP_TOOL_SOURCES.timeNow },
                toolFolders: []
            }
        });

        const blueprint = { record: presetToRecord(card), presetRebuild: posture };

        expect(() => laneReplicaPreset(structuredClone(blueprint))).toThrowError(
            `preset-not-rebuildable: the lane replica of harness "boot" would be built with a different toolbox posture than this session ([false,false,false,"7",[["timeNow","${SHARED_APP_TOOL_SOURCES.timeNow}"]],[]] expected, [true,false,false,"7",[["timeNow","${SHARED_APP_TOOL_SOURCES.timeNow}"]],[]] rebuilt). The frozen record's tool declaration cannot express the boot posture, so running the turn on a lane would execute a different harness. Run this session with threadExecution "inline", or state the card's tools consistently with its toolbox in the boot configuration.`
        );

        // The guard is also callable directly on the rebuilt card, which is what the
        // mismatch above exercises: the approved posture alone always passes.
        const goodRegistry = supportedRegistry();

        goodRegistry.create({ name: 'boot', agents: ['general'] });

        const good = laneReplicaPreset({
            record: presetToRecord(goodRegistry.find('boot') as HarnessPreset),
            presetRebuild: laneBootPosture(goodRegistry.find('boot') as HarnessPreset).presetRebuild
        });

        expect(() => assertLaneRebuildPosture(good, SUPPORTED_POSTURE)).not.toThrow();
    });
});

describe('B6 a real lane for a zero-plugin, zero-toolbox boot', () => {
    it('boots the replica from the blueprint and runs a core tool through the authority', async () => {
        const registry = supportedRegistry();

        registry.create({ name: 'boot', agents: ['general'] });

        const store = track(
            new SessionStore(SETTINGS, registry, undefined, { runtime: WORKER_RUNTIME, plugins: [] })
        );
        const session = await store.create('boot');
        const page = (await store.callTool(session.id, 'tasks', {
            tasks: [{ text: 'written from a zero-plugin lane' }]
        })) as {
            tasks: {
                id: string;
                text: string;
                completed: boolean;
                rev: number;
                updatedBy: string;
                updatedAt: string;
            }[];
            counts: { total: number; completed: number; pending: number };
            page: { offset: number; limit: number; hasMore: boolean };
            storeRev: number;
            entry: {
                id: string;
                text: string;
                completed: boolean;
                rev: number;
                updatedBy: string;
                updatedAt: string;
            };
            addedIds: string[];
        };

        // The stamp is the one dynamic value in the receipt; it must be a real ISO string
        // and it is asserted by identity against the record it belongs to.
        const stamp = page.tasks[0]?.updatedAt as string;

        expect(Number.isNaN(Date.parse(stamp))).toBe(false);
        expect(page).toEqual({
            tasks: [
                {
                    id: '1',
                    text: 'written from a zero-plugin lane',
                    completed: false,
                    rev: 1,
                    updatedBy: 'general',
                    updatedAt: stamp
                }
            ],
            counts: { total: 1, completed: 0, pending: 1 },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1,
            entry: {
                id: '1',
                text: 'written from a zero-plugin lane',
                completed: false,
                rev: 1,
                updatedBy: 'general',
                updatedAt: stamp
            },
            addedIds: ['1']
        });
    });
});
