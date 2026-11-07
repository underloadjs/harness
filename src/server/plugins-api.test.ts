// T5 (R2/R3) — the plugin settings REST contract, the live-provider wiring, and durability.
//
// WHAT THIS FILE PROVES (one block per acceptance criterion):
//   1. LIST      - `GET /v1/harness/plugins` answers BOTH built-ins, in manifest order, with
//                  their declared settings + defaults, effective `values`, and `builtin: true`.
//                  Paging and `q` behave like every other collection in this contract.
//   2. WRITE     - `PATCH /v1/harness/plugins/{plugin_id}` validates against the plugin's own
//                  descriptor, answers the updated row, bumps the collection revision, and is
//                  durable BEFORE the response.
//   3. REFUSALS  - unknown plugin => 404; unknown key, wrong type, out-of-range, empty patch,
//                  and an unknown body field => 400 with the exact message; a method the path
//                  does not declare => 405 naming what it does.
//   4. LIVE      - the provider `SessionStore.buildHarness` handed the preset is THE store's
//                  provider object, and a plugin's `api.settings.number('contextLimit')` inside
//                  an EXISTING session's harness returns the new value on its very next turn -
//                  same harness object, no rebuild.
//   5. DURABLE   - `state.json` carries the override and nothing else, and a fresh runtime on
//                  the same root boots with it (both through `GET /plugins` and through the
//                  provider a new session would read). A deployment that never edited anything
//                  writes no `pluginSettings` field at all.
//
// Determinism: every status, key list, and value below is an EXACT assertion. The harness is
// scripted (no provider, no network), and the search-key stubs keep the toolbox's
// environment-backed rows deterministic regardless of the machine running the suite.
//
// Cross-references:
//   - ./plugins.ts                    — the store these routes read and write
//   - ./sessions.ts                   — `buildHarness` (the report) and `updatePluginSettings`
//   - ./harnesses/toolbox.ts          — the factory that forwards it into `harness()`
//   - ../plugins/context-compaction.plugin.ts — the settings the acceptance criteria name
//   - ./api.ts                        — `getPlugins` / `patchPlugin` and the route table
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agent, harness } from '../harness';
import type { HarnessStream, HarnessStreamEvent } from '../harness';
import { BUILTIN_PLUGIN_DESCRIPTORS } from '../plugin/manifest';
import { createPluginSettingsView } from '../plugin/settings';
import type { HarnessPluginApi, HarnessPluginMetadata } from '../types';
import { createHarnessRegistry, createToolboxHarness } from './harnesses';
import type { HarnessPreset, HarnessPresetReport, RunnerSettings } from './harnesses/types';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime, HarnessRuntimeOptions } from './runtime';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { HARNESS_EPOCH_HEADER, HARNESS_REVISION_HEADER } from '../shared/harness-api';

const MOUNT = '/v1/harness';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'demo-model'
};

const DEFAULTS = { baseURL: 'http://provider.test/v1', model: 'demo-model', hasApiKey: true };

// The two shipped descriptors, read from the generated manifest rather than retyped: the plugin
// file is the single owner of its own metadata, so a row that echoed prose typed here would
// drift the moment the plugin changed. Every NUMBER (default/min/step) and every identity field
// IS hardcoded below, because those are the contract this route exposes.
const ASYNC_PING = BUILTIN_PLUGIN_DESCRIPTORS.find((entry) => entry.name === 'async-ping') as HarnessPluginMetadata;
const COMPACTION = BUILTIN_PLUGIN_DESCRIPTORS.find(
    (entry) => entry.name === 'context-compaction'
) as HarnessPluginMetadata;

// ---------------------------------------------------------------------------
// Scratch root: the workspace `Temp/` (repo policy: throwaway work lives in the repo-root
// `Temp/`, never in OS temp), the package's `Temp/` as the standalone-checkout fallback.
// Same ancestor rule `src/server/api.test.ts` uses: the workspace root is the directory that
// carries `AGENTS.md` AND a `package.json` whose `workspaces` cover this package.
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const findWorkspaceRoot = (from: string): string | undefined => {
    let current = resolve(from);

    for (let depth = 0; depth < 8; depth += 1) {
        const parent = dirname(current);

        if (parent === current) return undefined;

        if (existsSync(join(parent, 'AGENTS.md')) && existsSync(join(parent, 'package.json'))) return parent;

        current = parent;
    }

    return undefined;
};

const WORKSPACE_ROOT = findWorkspaceRoot(PACKAGE_ROOT) ?? PACKAGE_ROOT;
const SCRATCH_ROOT = join(WORKSPACE_ROOT, 'Temp', 'T5');

// ---------------------------------------------------------------------------
// The scripted probe harness
// ---------------------------------------------------------------------------

const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;

    return async function* stream() {
        const frames = turns[index] ?? turns[turns.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// What the probe plugin read for `contextLimit`, once per model request. A `turn.before` hook is
// the exact moment a real compaction plugin decides whether to compact, so this array IS the
// acceptance criterion: turn 1 saw the default, turn 2 saw the operator's value.
let probeReads: number[] = [];

// The probe REPLACES the shipped `context-compaction` plugin (same name = one entry, per
// ../plugin/host.ts precedence) while keeping its declared metadata, so `api.settings` resolves
// the same key, the same default, and the same bounds the real plugin publishes.
const probePlugin = {
    name: 'context-compaction',
    metadata: COMPACTION,
    setup: (api: HarnessPluginApi) => {
        api.on('turn.before', () => {
            probeReads.push(api.settings.number('contextLimit'));
        });
    }
};

// The reports `SessionStore.buildHarness` passed, one per harness this store built.
let builtReports: (HarnessPresetReport | undefined)[] = [];

const probePreset = (): HarnessPreset => ({
    name: 'probe',
    title: 'Probe',
    description: 'Scripted plugin-settings probe preset.',
    requiresEndpoint: false,
    primary: 'probe',
    subagents: [],
    agents: ['probe'],
    tools: [],
    builtin: true,
    editable: true,
    // The same shape `createToolboxHarness` uses: the persistence observer rides in `report`,
    // and `pluginSettings` is forwarded from the report into the harness configuration.
    create: (settings, progress, report) => {
        builtReports.push(report);

        return harness({
            agents: {
                probe: agent({
                    model: settings.model,
                    instruction: 'Scripted settings probe agent.',
                    stream: scripted([answer('first'), answer('second'), answer('third')])
                })
            },
            primary: 'probe',
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            },
            ...(report?.pluginSettings === undefined ? {} : { pluginSettings: report.pluginSettings }),
            plugins: [probePlugin]
        });
    }
});

// ---------------------------------------------------------------------------
// Runtime + dispatcher helpers
// ---------------------------------------------------------------------------

const stubSearchKeys = (): void => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('LINKUP_API_KEY', '');
};

const createRuntime = (options: Partial<HarnessRuntimeOptions> = {}): HarnessRuntime => {
    stubSearchKeys();
    builtReports = [];
    probeReads = [];

    return createHarnessRuntime({
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry([probePreset()]),
        loadEnvironment: false,
        ...options
    });
};

type CallResult = { status: number; body: Record<string, any>; headers: Record<string, string | undefined> };

const call = async (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    body: unknown = {},
    search?: string
): Promise<CallResult> => {
    const result: HarnessApiResult = await runtime.api({
        method,
        pathname,
        mount: MOUNT,
        ...(search === undefined ? {} : { searchParams: search }),
        readBody: async <T,>() => body as T
    } as HarnessApiRequest);

    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return {
        status: result.status,
        body: result.body as Record<string, any>,
        headers: result.headers ?? {}
    };
};

/** One `POST /sessions` and its created session id. */
const createSession = async (runtime: HarnessRuntime): Promise<string> => {
    const created = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'probe' });

    expect(created.status).toBe(201);

    return created.body.session.id as string;
};

const patchSettings = (runtime: HarnessRuntime, plugin: string, settings: unknown): Promise<CallResult> =>
    call(runtime, 'PATCH', `${MOUNT}/plugins/${plugin}`, { settings });

const pluginsOf = (runtime: HarnessRuntime) => runtime.store.pluginSettings;

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('GET /v1/harness/plugins', () => {
    it('lists both built-ins with their declared settings, defaults, and effective values', async () => {
        const runtime = createRuntime();
        const page = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(page.status).toBe(200);
        expect(Object.keys(page.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);

        // A two-entry catalogue fits one default page, so the cursor ends the collection.
        expect(page.body.limit).toBe(2);
        expect(page.body.next_cursor).toBeNull();

        // An untouched runtime has a collection revision of 0 ("never changed"), exactly like
        // every other collection before its first write. The header carries only the epoch: a
        // LIST read is not one resource instance, so `json()` gets no revision argument (the
        // same rule `GET /harnesses` follows, ./api.ts `getHarnesses`). The figure rides in
        // `body.revision`.
        expect(page.body.revision).toBe(0);
        expect(page.headers).toEqual({ [HARNESS_EPOCH_HEADER]: runtime.events.epoch });

        // Manifest order (scan order, path ascending), pinned because the pane renders it as-is.
        expect(page.body.items.map((row: { name: string }) => row.name)).toEqual(['async-ping', 'context-compaction']);

        // The full row key set (the closed `PluginSummary` object). A plugin that declares no
        // description/version/tags/hooks would omit those keys, and both shipped plugins declare
        // all four, so the set below IS what the shipped catalogue answers.
        expect(Object.keys(page.body.items[0]).sort()).toEqual([
            'builtin',
            'description',
            'hooks',
            'name',
            'settings',
            'tags',
            'title',
            'values',
            'version'
        ]);

        // `hooks` and `tags` are read from the descriptor rather than retyped here: the plugin
        // file owns its declared metadata (that is why the manifest is generated), and the R4/R3
        // plugin work is changing exactly those lists. Everything the ROUTE owns - identity,
        // `builtin`, the settings descriptors, and the effective values - is a literal below.
        expect(page.body.items[0]).toEqual({
            name: 'async-ping',
            title: 'Background Ping',
            description: ASYNC_PING.description,
            version: '1.0.0',
            tags: ['background', 'async', 'lifecycle'],
            hooks: ASYNC_PING.hooks,
            builtin: true,
            settings: [
                {
                    key: 'intervalMs',
                    label: 'Ping interval (ms)',
                    type: 'number',
                    default: 600000,
                    min: 1000,
                    step: 1000,
                    description: ASYNC_PING.settings?.[0].description
                }
            ],
            values: { intervalMs: 600000 }
        });

        expect(page.body.items[1]).toEqual({
            name: 'context-compaction',
            title: 'Context Compaction',
            description: COMPACTION.description,
            version: '1.0.0',
            tags: ['context', 'compaction', 'lifecycle'],
            hooks: COMPACTION.hooks,
            builtin: true,
            settings: [
                {
                    key: 'contextLimit',
                    label: 'Context limit (tokens)',
                    type: 'number',
                    default: 100000,
                    min: 1000,
                    step: 1000,
                    description: COMPACTION.settings?.[0].description
                }
            ],
            values: { contextLimit: 100000 }
        });
    });

    it('filters with `q` and pages with `limit` like every other collection', async () => {
        const runtime = createRuntime();

        const filtered = await call(runtime, 'GET', `${MOUNT}/plugins`, {}, 'q=compact');

        expect(filtered.body.items.map((row: { name: string }) => row.name)).toEqual(['context-compaction']);

        const byTag = await call(runtime, 'GET', `${MOUNT}/plugins`, {}, 'q=BACKGROUND');

        expect(byTag.body.items.map((row: { name: string }) => row.name)).toEqual(['async-ping']);

        const none = await call(runtime, 'GET', `${MOUNT}/plugins`, {}, 'q=nonexistent');

        expect(none.body.items).toEqual([]);
        expect(none.body.limit).toBe(0);
        expect(none.body.next_cursor).toBeNull();

        // A full page always advertises a next page (the contract's end-of-collection rule).
        const first = await call(runtime, 'GET', `${MOUNT}/plugins`, {}, 'limit=1');

        expect(first.body.items).toHaveLength(1);
        expect(first.body.limit).toBe(1);
        expect(typeof first.body.next_cursor).toBe('string');

        const second = await call(runtime, 'GET', `${MOUNT}/plugins`, {}, `limit=1&cursor=${first.body.next_cursor}`);

        expect(second.body.items.map((row: { name: string }) => row.name)).toEqual(['context-compaction']);
        expect(second.body.next_cursor).toBeNull();

        // A limit outside the contract bounds is a 400 naming the parameter.
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`, {}, 'limit=0')).status).toBe(400);
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`, {}, 'limit=101')).status).toBe(400);
    });

    it('is a GET-only collection: a write verb on it is a 405 that names the method it takes', async () => {
        const runtime = createRuntime();

        expect(await call(runtime, 'DELETE', `${MOUNT}/plugins`)).toMatchObject({
            status: 405,
            body: { error: { message: 'Use GET for /v1/harness/plugins.' } }
        });

        // The item path declares PATCH only, and enable/disable is not an HTTP affordance.
        expect(await call(runtime, 'GET', `${MOUNT}/plugins/context-compaction`)).toMatchObject({
            status: 405,
            body: { error: { message: 'Use PATCH for /v1/harness/plugins/context-compaction.' } }
        });
    });
});

describe('PATCH /v1/harness/plugins/{plugin_id}', () => {
    it('persists a context limit and reports it on the next read', async () => {
        const runtime = createRuntime();

        const patched = await patchSettings(runtime, 'context-compaction', { contextLimit: 200000 });

        expect(patched.status).toBe(200);
        expect(Object.keys(patched.body)).toEqual(['plugin']);
        expect(patched.body.plugin.name).toBe('context-compaction');
        expect(patched.body.plugin.values).toEqual({ contextLimit: 200000 });

        // The declared descriptor is unchanged by a write: the row still carries the reset target.
        expect(patched.body.plugin.settings[0].default).toBe(100000);

        // One accepted write, one revision, on the body AND the contract header.
        expect(patched.body.plugin.name).toBe('context-compaction');
        expect(patched.headers).toEqual({
            [HARNESS_EPOCH_HEADER]: runtime.events.epoch,
            [HARNESS_REVISION_HEADER]: '1'
        });

        const reload = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(reload.body.revision).toBe(1);
        expect(reload.body.items[1].values).toEqual({ contextLimit: 200000 });

        // The other plugin is untouched, and only the changed plugin is stored.
        expect(reload.body.items[0].values).toEqual({ intervalMs: 600000 });
        expect(pluginsOf(runtime).snapshot()).toEqual({ 'context-compaction': { contextLimit: 200000 } });
    });

    it('keeps one patch change visible to every later read of every key', async () => {
        const runtime = createRuntime();

        await patchSettings(runtime, 'async-ping', { intervalMs: 5000 });

        const page = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(page.body.items[0].values).toEqual({ intervalMs: 5000 });
        expect(pluginsOf(runtime).snapshot()).toEqual({ 'async-ping': { intervalMs: 5000 } });
    });

    it('normalizes a numeric string to the declared type', async () => {
        const runtime = createRuntime();

        const patched = await patchSettings(runtime, 'context-compaction', { contextLimit: '150000' });

        expect(patched.status).toBe(200);
        // `values` carries a NUMBER, not the text that arrived, so a client round-trips types.
        expect(patched.body.plugin.values).toEqual({ contextLimit: 150000 });
        expect(pluginsOf(runtime).get('context-compaction', 'contextLimit')).toBe(150000);
    });

    it('resets one key back to the declared default on an explicit null', async () => {
        const runtime = createRuntime();

        await patchSettings(runtime, 'context-compaction', { contextLimit: 200000 });
        const reset = await patchSettings(runtime, 'context-compaction', { contextLimit: null });

        expect(reset.status).toBe(200);
        expect(reset.body.plugin.values).toEqual({ contextLimit: 100000 });
        expect(reset.body.plugin.settings[0].default).toBe(100000);
        expect(pluginsOf(runtime).snapshot()).toEqual({});

        // A reset is a mutation, so the counter moved again (1 -> 2).
        expect(reset.headers[HARNESS_REVISION_HEADER]).toBe('2');
    });

    it('404s a plugin this build does not ship, naming what it does', async () => {
        const runtime = createRuntime();

        expect(await patchSettings(runtime, 'nope', { contextLimit: 5000 })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown plugin "nope". This build ships: async-ping, context-compaction.' } },
            headers: {}
        });
    });

    it('400s an unknown key, naming the declared set of THAT plugin', async () => {
        const runtime = createRuntime();

        expect(await patchSettings(runtime, 'context-compaction', { context_limit: 5000 })).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'Unknown setting "context_limit" for plugin "context-compaction". Allowed settings: contextLimit.'
                }
            },
            headers: {}
        });

        // `intervalMs` is real, but not for this plugin: settings are scoped by plugin id.
        expect((await patchSettings(runtime, 'context-compaction', { intervalMs: 1000 })).status).toBe(400);
    });

    it('400s a value outside the declared bounds or of the wrong type', async () => {
        const runtime = createRuntime();

        expect(await patchSettings(runtime, 'context-compaction', { contextLimit: 999 })).toEqual({
            status: 400,
            body: {
                error: {
                    message: '"contextLimit" of plugin "context-compaction" must be at least 1000; 999 was submitted.'
                }
            },
            headers: {}
        });

        expect(await patchSettings(runtime, 'context-compaction', { contextLimit: 'plenty' })).toEqual({
            status: 400,
            body: {
                error: {
                    message: '"contextLimit" of plugin "context-compaction" must be a finite number (it is declared "number").'
                }
            },
            headers: {}
        });

        expect(await patchSettings(runtime, 'context-compaction', { contextLimit: true })).toEqual({
            status: 400,
            body: {
                error: {
                    message: '"contextLimit" of plugin "context-compaction" must be a finite number (it is declared "number").'
                }
            },
            headers: {}
        });

        // A refused write stored nothing and moved no counter.
        expect(pluginsOf(runtime).snapshot()).toEqual({});
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`)).body.revision).toBe(0);
    });

    it('400s a malformed body before touching the store', async () => {
        const runtime = createRuntime();

        expect(await call(runtime, 'PATCH', `${MOUNT}/plugins/context-compaction`, {})).toEqual({
            status: 400,
            body: { error: { message: 'A plugin settings patch requires a "settings" object.' } },
            headers: {}
        });

        expect(await patchSettings(runtime, 'context-compaction', {})).toEqual({
            status: 400,
            body: { error: { message: 'A plugin settings patch must change at least one setting.' } },
            headers: {}
        });

        expect(await patchSettings(runtime, 'context-compaction', { contextLimit: 5000, enabled: true })).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'Unknown setting "enabled" for plugin "context-compaction". Allowed settings: contextLimit.'
                }
            },
            headers: {}
        });

        // A body field the contract does not name is refused, never ignored.
        expect(await call(runtime, 'PATCH', `${MOUNT}/plugins/context-compaction`, { settings: { contextLimit: 5000 }, enabled: false })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "enabled". Allowed fields: settings.' } },
            headers: {}
        });

        expect((await call(runtime, 'PATCH', `${MOUNT}/plugins/context-compaction`, ['settings'])).status).toBe(400);
        expect(pluginsOf(runtime).snapshot()).toEqual({});
    });
});

describe('the live settings provider reaches an existing session', () => {
    it('passes the store\'s own provider into every harness build, and a PATCH changes the next turn', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);

        // The wiring proof: the report `buildHarness` supplied carried THIS store's provider
        // object (identity, not an equal copy), which is what `createToolboxHarness` forwards
        // into `harness({ pluginSettings })` for every shipped preset.
        expect(builtReports).toHaveLength(1);

        const report = builtReports[0];

        expect(report?.pluginSettings).toBe(pluginsOf(runtime).provider);

        const record = runtime.store.liveSession(sessionId);

        // Turn 1: nothing is stored, so the plugin reads its declared default.
        await record.harness('one');

        expect(probeReads).toEqual([100000]);

        const patched = await patchSettings(runtime, 'context-compaction', { contextLimit: 24000 });

        expect(patched.status).toBe(200);

        // The SAME provider object the harness already holds now answers the new number...
        expect(report?.pluginSettings?.get('context-compaction', 'contextLimit')).toBe(24000);

        // ...and the SAME harness object (no rebuild, no new session) reads it on its next turn.
        expect(runtime.store.liveSession(sessionId).harness).toBe(record.harness);

        await record.harness('two');

        expect(probeReads).toEqual([100000, 24000]);

        // A reset is equally immediate: the plugin falls back to the declared default.
        await patchSettings(runtime, 'context-compaction', { contextLimit: null });
        await record.harness('three');

        expect(probeReads).toEqual([100000, 24000, 100000]);
    });

    it('resolves the effective value through the same view a plugin uses', () => {
        const runtime = createRuntime();
        const provider = pluginsOf(runtime).provider;
        const view = createPluginSettingsView('context-compaction', provider, COMPACTION.settings);

        expect(view.number('contextLimit')).toBe(100000);
        expect(provider.get('context-compaction', 'contextLimit')).toBeUndefined();

        pluginsOf(runtime).update('context-compaction', { contextLimit: 32000 });

        expect(view.number('contextLimit')).toBe(32000);
        expect(view.number('nope', 7)).toBe(7);
    });

    it('accepts the report field in the shared toolbox factory and still auto-loads the built-ins', () => {
        stubSearchKeys();

        const runtime = createRuntime();
        const built = createToolboxHarness(
            {
                agents: {
                    probe: agent({
                        model: 'demo-model',
                        instruction: 'Toolbox wiring probe.',
                        stream: scripted([answer('ok')])
                    })
                },
                primary: 'probe'
            },
            SETTINGS,
            () => undefined,
            { pluginSettings: pluginsOf(runtime).provider }
        );

        // `harness()` applied the auto-scanned catalogue on top of the host provider: both
        // built-ins are present, which is the shape the Plugins pane lists.
        expect(built.plugins).toEqual(['async-ping', 'context-compaction']);
        expect(built.pluginMetadata.map((entry) => entry.name)).toEqual(['async-ping', 'context-compaction']);

        // And the provider it was built with is still live: an edit lands on the same map.
        pluginsOf(runtime).update('context-compaction', { contextLimit: 12000 });
        expect(pluginsOf(runtime).provider.get('context-compaction', 'contextLimit')).toBe(12000);
    });
});

describe('plugin settings survive a restart', () => {
    // One fixture database per test, under the repo's scratch root (AGENTS.md: throwaway work
    // lives in `Temp/`, never in OS temp). Removal happens in the local `afterEach`.
    const roots: string[] = [];

    const fixture = async (): Promise<string> => {
        await mkdir(join(WORKSPACE_ROOT, 'Temp'), { recursive: true });
        await mkdir(SCRATCH_ROOT, { recursive: true });

        const root = await mkdtemp(join(SCRATCH_ROOT, 'plugins-'));

        roots.push(root);

        return root;
    };

    const fileOf = (root: string): string => join(root, 'harness', 'state.json');

    const documentOf = (root: string): Record<string, any> =>
        JSON.parse(readFileSync(fileOf(root), 'utf8')) as Record<string, any>;

    const writeDocument = async (root: string, document: unknown): Promise<void> => {
        await writeFile(fileOf(root), JSON.stringify(document, null, 2), 'utf8');
    };

    afterEach(async () => {
        for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    });

    it('writes only the override to state.json and restores it on the next boot', async () => {
        const root = await fixture();
        const first = createRuntime({ root });

        // One durable write with NOTHING changed: the document exists and carries no
        // `pluginSettings` field at all, so a fresh deployment keeps its exact previous shape.
        await first.store.persistRegistry();

        const clean = documentOf(root);

        expect(Object.hasOwn(clean, 'pluginSettings')).toBe(false);
        expect(clean.sessions).toEqual([]);

        const patched = await patchSettings(first, 'context-compaction', { contextLimit: 200000 });

        expect(patched.status).toBe(200);

        const saved = documentOf(root);

        // Overrides only: the declared default (100000) is NOT written, and no other plugin
        // appears. The credential rule of this file holds for the whole document.
        expect(saved.pluginSettings).toEqual({ 'context-compaction': { contextLimit: 200000 } });
        expect(JSON.stringify(saved)).not.toContain('server-secret');

        // A second runtime over the same root is what a restart is: the override is read back
        // before the first request, through the store AND therefore through every harness the
        // store builds (`buildHarness` passes `this.plugins.provider`, seeded from the document).
        const second = createRuntime({ root });

        expect(second.store.pluginSettings.get('context-compaction', 'contextLimit')).toBe(200000);
        expect(second.store.pluginSettings.provider.get('context-compaction', 'contextLimit')).toBe(200000);
        expect(second.store.pluginSettings.values('context-compaction')).toEqual({ contextLimit: 200000 });

        // The revision counter is epoch-local, so it restarts at 0 while the VALUE does not.
        const page = await call(second, 'GET', `${MOUNT}/plugins`);

        expect(page.body.revision).toBe(0);
        expect(page.body.items[1].values).toEqual({ contextLimit: 200000 });

        // The restored store is still the LIVE one: an edit after the restart moves the same
        // provider object, and the document follows it.
        await patchSettings(second, 'context-compaction', { contextLimit: 150000 });

        expect(second.store.pluginSettings.provider.get('context-compaction', 'contextLimit')).toBe(150000);
        expect(documentOf(root).pluginSettings).toEqual({ 'context-compaction': { contextLimit: 150000 } });

        // A third boot reads the newest value, so the round trip is not one-way.
        const third = createRuntime({ root });

        expect(third.store.pluginSettings.snapshot()).toEqual({ 'context-compaction': { contextLimit: 150000 } });
    });

    it('drops an override whose plugin or key this build no longer declares', async () => {
        const root = await fixture();
        const first = createRuntime({ root });

        await patchSettings(first, 'async-ping', { intervalMs: 9000 });

        // Hand-edit the saved document the way a future release's migration would: a retired
        // plugin, a retired key, and a key that belongs to the OTHER plugin. None of them may
        // abort the boot; each is simply not restored.
        const saved = documentOf(root);

        saved.pluginSettings = {
            ...saved.pluginSettings,
            'retired-plugin': { anything: 1 },
            'async-ping': { intervalMs: 9000, gone: 'x' },
            'context-compaction': { contextLimit: 4000 }
        };

        await writeDocument(root, saved);

        const second = createRuntime({ root });
        const page = await call(second, 'GET', `${MOUNT}/plugins`);

        expect(page.body.items[0].values).toEqual({ intervalMs: 9000 });
        expect(page.body.items[1].values).toEqual({ contextLimit: 4000 });
        expect(second.store.pluginSettings.snapshot()).toEqual({
            'async-ping': { intervalMs: 9000 },
            'context-compaction': { contextLimit: 4000 }
        });

        // A hand-edited document whose SHAPE is wrong is corruption, and a boot says so loudly
        // (the persistence rule for every other field of this document).
        const broken = documentOf(root);

        broken.pluginSettings = { 'async-ping': { intervalMs: { nested: 1 } } };

        await writeDocument(root, broken);

        let failure = '';

        try {
            createRuntime({ root });
        } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }

        expect(failure).toContain(
            'The harness database pluginSettings.async-ping.intervalMs must be a number, a string, or a boolean; plugin settings hold JSON scalars only.'
        );

        // A stored value that simply violates the plugin's own bounds is NOT corruption: the
        // document loader validates shape, and the store drops the unusable override.
        const outOfRange = documentOf(root);

        outOfRange.pluginSettings = { 'context-compaction': { contextLimit: 1 } };

        await writeDocument(root, outOfRange);

        const fourth = createRuntime({ root });

        expect(fourth.store.pluginSettings.get('context-compaction', 'contextLimit')).toBeUndefined();
        expect(fourth.store.pluginSettings.values('context-compaction')).toEqual({ contextLimit: 100000 });
        expect((await call(fourth, 'GET', `${MOUNT}/plugins`)).body.items[1].values).toEqual({
            contextLimit: 100000
        });
    });
});

describe('the boot document advertises the plugin collection', () => {
    it('links /plugins alongside the other global collections', async () => {
        const runtime = createRuntime();
        const root = await call(runtime, 'GET', MOUNT);

        expect(root.body.links).toEqual({
            self: MOUNT,
            health: `${MOUNT}/health`,
            config: `${MOUNT}/config`,
            harnesses: `${MOUNT}/harnesses`,
            agents: `${MOUNT}/agents`,
            tools: `${MOUNT}/tools`,
            plugins: `${MOUNT}/plugins`,
            models: `${MOUNT}/models`,
            sessions: `${MOUNT}/sessions`,
            stream: `${MOUNT}/stream`
        });
    });
});
