// T5 (R2/R3) — the plugin settings REST contract, the live-provider wiring, and durability.
//
// WHAT THIS FILE PROVES (one block per acceptance criterion):
//   1. LIST      - `GET /v1/harness/plugins` answers EVERY built-in the manifest ships, in
//                  manifest order, with their declared settings + defaults, effective
//                  `values`, and `builtin: true`. Paging and `q` behave like every other
//                  collection in this contract.
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

// The shipped descriptors, read from the generated manifest rather than retyped: the plugin
// file is the single owner of its own metadata, so a row that echoed prose typed here would
// drift the moment the plugin changed. Every NUMBER (default/min/step) and every identity field
// IS hardcoded below, because those are the contract this route exposes.
const ASYNC_PING = BUILTIN_PLUGIN_DESCRIPTORS.find((entry) => entry.name === 'async-ping') as HarnessPluginMetadata;
const COMPACTION = BUILTIN_PLUGIN_DESCRIPTORS.find(
    (entry) => entry.name === 'context-compaction'
) as HarnessPluginMetadata;
// The third built-in (R5, `src/plugins/context-trimmer.plugin.ts`). Its metadata is owned by
// the plugin file and mirrored here through the manifest, exactly like the two above, so a
// wording change in the plugin cannot silently break this contract test.
const TRIMMER = BUILTIN_PLUGIN_DESCRIPTORS.find(
    (entry) => entry.name === 'context-trimmer'
) as HarnessPluginMetadata;
// The manifest scan order (path ascending), written ONCE here as a literal and asserted
// against the route, the toolbox factory and the row list alike. It is an exact pin, not a
// derivation: a re-ordered or renamed built-in fails these assertions, and the pane renders
// this order as-is.
const CATALOGUE = ['async-ping', 'context-compaction', 'context-trimmer'];

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
// One scratch database per durability test, under the repo's scratch root
// (AGENTS.md: throwaway work lives in `Temp/`, never in OS temp). Module-scoped
// because BOTH durability describes need it — the declared-key round trip and the
// R2 reserved-`enabled` round trip read and hand-edit the same `state.json`.
// ---------------------------------------------------------------------------

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
//
// `probeThrows` is the T1.5 sink switch: a handler that THROWS is the framework's fail-open case,
// where the run must still answer AND the host must still be told. The throw happens AFTER the
// settings read, so every existing `probeReads` assertion below keeps its exact expected array —
// the failure is added to the same moment, never moved out of it.
let probeThrows = false;

// The other half of the diagnostic channel: a plugin speaking for ITSELF (`api.report.diagnostic`,
// compaction T4.5) rather than failing. It is the case the server log must NOT print — a policy
// report is what the plugin DECIDED, and a pass per turn would drown the failures this whole
// surface exists to make visible — while still belonging on the session.
let probeReportsPolicy = false;

const probePlugin = {
    name: 'context-compaction',
    metadata: COMPACTION,
    setup: (api: HarnessPluginApi) => {
        api.on('turn.before', () => {
            probeReads.push(api.settings.number('contextLimit'));

            if (probeReportsPolicy) {
                api.report.diagnostic({
                    message: 'withheld 1 superseded tool failure unit',
                    data: { units: ['msg-2'], savedTokens: 24 }
                });
            }

            if (probeThrows) throw new Error('the probe policy could not read the transcript');
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
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange }),
                // The T1.5 sink the shipped factories forward (./harnesses/toolbox.ts). This fixture
                // exists to be shaped exactly like a production harness, and as of T4 a production
                // harness HAS a diagnostic sink — so the assertion below about what the store
                // receives is only meaningful if the forwarding is here too.
                ...(report?.diagnostic === undefined ? {} : { diagnostic: report.diagnostic })
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
    // The diagnostic switches are per-scenario on purpose: a test that leaves one set must not
    // make an unrelated settings case below report a failure that never happened.
    probeThrows = false;
    probeReportsPolicy = false;

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
    it('lists every built-in with their declared settings, defaults, and effective values', async () => {
        const runtime = createRuntime();
        const page = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(page.status).toBe(200);
        expect(Object.keys(page.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);

        // A three-entry catalogue fits one default page, so the cursor ends the collection.
        expect(page.body.limit).toBe(3);
        expect(page.body.next_cursor).toBeNull();

        // An untouched runtime has a collection revision of 0 ("never changed"), exactly like
        // every other collection before its first write. The header carries only the epoch: a
        // LIST read is not one resource instance, so `json()` gets no revision argument (the
        // same rule `GET /harnesses` follows, ./api.ts `getHarnesses`). The figure rides in
        // `body.revision`.
        expect(page.body.revision).toBe(0);
        expect(page.headers).toEqual({ [HARNESS_EPOCH_HEADER]: runtime.events.epoch });

        // Manifest order (scan order, path ascending), pinned because the pane renders it as-is.
        expect(page.body.items.map((row: { name: string }) => row.name)).toEqual(CATALOGUE);

        // The full row key set (the closed `PluginSummary` object). A plugin that declares no
        // description/version/tags/hooks would omit those keys, and all three shipped plugins
        // declare all four, so the set below IS what the shipped catalogue answers.
        expect(Object.keys(page.body.items[0]).sort()).toEqual([
            'builtin',
            'description',
            'enabled',
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
            // R2: the reserved switch, reported on EVERY row — including async-ping, which
            // declares no `enabled` setting of its own. Default on, and NOT part of `values`
            // (that map stays the projection of the DECLARED keys only).
            enabled: true,
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
            // R2: same reserved switch; context-compaction DECLARES this key, so the row
            // field and `values.enabled` are one stored value read two ways.
            enabled: true,
            settings: [
                {
                    key: 'contextLimit',
                    label: 'Context limit (tokens)',
                    type: 'number',
                    default: 200000,
                    min: 1000,
                    step: 1000,
                    description: COMPACTION.settings?.[0].description
                },
                // R4 added this BEFORE `enabled` (declared order is the row order the pane
                // renders, so both position and value are pinned): the per-model JSON
                // override map. There is no headroom setting any more — the limit IS the
                // firing point (the operator's 2026-11-10 one-number ruling).
                {
                    key: 'modelLimits',
                    label: 'Per-model limits (JSON)',
                    type: 'string',
                    default: '{}',
                    description: COMPACTION.settings?.find((setting) => setting.key === 'modelLimits')?.description
                },
                {
                    key: 'enabled',
                    label: 'Compact conversations',
                    type: 'boolean',
                    default: true,
                    description: COMPACTION.settings?.find((setting) => setting.key === 'enabled')?.description
                },
                {
                    key: 'minTokens',
                    label: 'Minimum saving per pass (tokens)',
                    type: 'number',
                    default: 200,
                    min: 0,
                    step: 50,
                    description: COMPACTION.settings?.find((setting) => setting.key === 'minTokens')?.description
                },
                {
                    key: 'safetyTurns',
                    label: 'Recent units to protect',
                    type: 'number',
                    default: 6,
                    min: 0,
                    step: 1,
                    description: COMPACTION.settings?.find((setting) => setting.key === 'safetyTurns')?.description
                },
                {
                    key: 'mode',
                    label: 'Compaction mode',
                    type: 'string',
                    default: 'summarize',
                    description: COMPACTION.settings?.find((setting) => setting.key === 'mode')?.description
                }
            ],
            values: {
                contextLimit: 200000,
                modelLimits: '{}',
                enabled: true,
                minTokens: 200,
                safetyTurns: 6,
                mode: 'summarize'
            }
        });

        // The third row: `context-trimmer` (R5). Same closed key set, and `values` is the
        // projection of ITS declared keys only — one boolean — which is the proof the route does
        // not leak another plugin's settings onto a row.
        expect(page.body.items[2]).toEqual({
            name: 'context-trimmer',
            title: 'Context Trimmer',
            description: TRIMMER.description,
            version: '1.0.0',
            tags: ['context', 'trimming', 'lifecycle'],
            hooks: TRIMMER.hooks,
            builtin: true,
            // Same reserved-switch rule as compaction: the plugin DECLARES `enabled`, so the row
            // field and `values.enabled` are one stored value read two ways.
            enabled: true,
            settings: [
                {
                    key: 'enabled',
                    label: 'Trim superseded tool calls',
                    type: 'boolean',
                    default: true,
                    description: TRIMMER.settings?.find((setting) => setting.key === 'enabled')?.description
                }
            ],
            values: { enabled: true }
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

        // One entry per page over a THREE-entry catalogue: pages 1 and 2 are full, so each
        // advertises a cursor, and only the last page ends the collection.
        const second = await call(runtime, 'GET', `${MOUNT}/plugins`, {}, `limit=1&cursor=${first.body.next_cursor}`);

        expect(second.body.items.map((row: { name: string }) => row.name)).toEqual(['context-compaction']);
        expect(typeof second.body.next_cursor).toBe('string');

        const third = await call(runtime, 'GET', `${MOUNT}/plugins`, {}, `limit=1&cursor=${second.body.next_cursor}`);

        expect(third.body.items.map((row: { name: string }) => row.name)).toEqual(['context-trimmer']);
        expect(third.body.next_cursor).toBeNull();

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
        // `values` is the projection of EVERY declared key (six as of the 2026-11-10
        // one-number ruling: the limit, the per-model map, and the four policy knobs), not
        // just the one that was written. The same six-key map is what every later read below
        // re-asserts, because the store answers stored value -> declared default per key and
        // a partial projection would let a new setting ship without ever being exposed on the
        // contract.
        expect(patched.body.plugin.values).toEqual({
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });

        // The declared descriptor is unchanged by a write: the row still carries the reset target.
        expect(patched.body.plugin.settings[0].default).toBe(200000);

        // One accepted write, one revision, on the body AND the contract header.
        expect(patched.body.plugin.name).toBe('context-compaction');
        expect(patched.headers).toEqual({
            [HARNESS_EPOCH_HEADER]: runtime.events.epoch,
            [HARNESS_REVISION_HEADER]: '1'
        });

        const reload = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(reload.body.revision).toBe(1);
        expect(reload.body.items[1].values).toEqual({
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });

        // The other plugins are untouched, and only the changed plugin is stored.
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
        expect(patched.body.plugin.values).toEqual({
            contextLimit: 150000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });
        expect(pluginsOf(runtime).get('context-compaction', 'contextLimit')).toBe(150000);
    });

    it('resets one key back to the declared default on an explicit null', async () => {
        const runtime = createRuntime();

        await patchSettings(runtime, 'context-compaction', { contextLimit: 200000 });
        const reset = await patchSettings(runtime, 'context-compaction', { contextLimit: null });

        expect(reset.status).toBe(200);
        expect(reset.body.plugin.values).toEqual({
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });
        expect(reset.body.plugin.settings[0].default).toBe(200000);
        expect(pluginsOf(runtime).snapshot()).toEqual({});

        // A reset is a mutation, so the counter moved again (1 -> 2).
        expect(reset.headers[HARNESS_REVISION_HEADER]).toBe('2');
    });

    it('404s a plugin this build does not ship, naming what it does', async () => {
        const runtime = createRuntime();

        expect(await patchSettings(runtime, 'nope', { contextLimit: 5000 })).toEqual({
            status: 404,
            body: {
                error: {
                    message:
                        'Unknown plugin "nope". This build ships: async-ping, context-compaction, context-trimmer.'
                }
            },
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
                        'Unknown setting "context_limit" for plugin "context-compaction". Allowed settings: contextLimit, modelLimits, enabled, minTokens, safetyTurns, mode.'
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

        // `pruneMode` is a name this build never declared — `enabled` IS one now (compaction
        // T4.6), so the example has to be a key the catalogue genuinely lacks.
        expect(await patchSettings(runtime, 'context-compaction', { contextLimit: 5000, pruneMode: 'soft' })).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'Unknown setting "pruneMode" for plugin "context-compaction". Allowed settings: contextLimit, modelLimits, enabled, minTokens, safetyTurns, mode.'
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

        expect(probeReads).toEqual([200000]);

        const patched = await patchSettings(runtime, 'context-compaction', { contextLimit: 24000 });

        expect(patched.status).toBe(200);

        // The SAME provider object the harness already holds now answers the new number...
        expect(report?.pluginSettings?.get('context-compaction', 'contextLimit')).toBe(24000);

        // ...and the SAME harness object (no rebuild, no new session) reads it on its next turn.
        expect(runtime.store.liveSession(sessionId).harness).toBe(record.harness);

        await record.harness('two');

        expect(probeReads).toEqual([200000, 24000]);

        // A reset is equally immediate: the plugin falls back to the declared default.
        await patchSettings(runtime, 'context-compaction', { contextLimit: null });
        await record.harness('three');

        expect(probeReads).toEqual([200000, 24000, 200000]);
    });

    it('resolves the effective value through the same view a plugin uses', () => {
        const runtime = createRuntime();
        const provider = pluginsOf(runtime).provider;
        const view = createPluginSettingsView('context-compaction', provider, COMPACTION.settings);

        expect(view.number('contextLimit')).toBe(200000);
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

        // `harness()` applied the auto-scanned catalogue on top of the host provider: all three
        // built-ins are present, which is the shape the Plugins pane lists. `CATALOGUE` is the
        // manifest's own scan order, so this also proves the catalogue is not re-sorted on the
        // way through the toolbox factory.
        expect(built.plugins).toEqual(CATALOGUE);
        expect(built.pluginMetadata.map((entry) => entry.name)).toEqual(CATALOGUE);

        // And the provider it was built with is still live: an edit lands on the same map.
        pluginsOf(runtime).update('context-compaction', { contextLimit: 12000 });
        expect(pluginsOf(runtime).provider.get('context-compaction', 'contextLimit')).toBe(12000);
    });
});

// ---------------------------------------------------------------------------
// Pipeline T1.5's LAST mile: the server installs a `report.diagnostic` sink.
//
// The library has emitted plugin diagnostics since T1.5 — a hook that THREW, TIMED OUT, or
// returned an unparseable decision is dropped and reported (fail-open, rule 2 of
// ../plugin/hooks.ts), and a plugin can report its own DECISIONS through `api.report.diagnostic`
// (compaction T4.5). What was missing is a host on the other end: `harness({ report.diagnostic })`
// had no caller in the server, so through `GET /sessions` "the compaction policy is broken" and
// "the compaction policy did nothing" were the same answer. These cases pin the difference, on the
// same probe plugin the settings acceptance above uses — the plugin throws AFTER its settings read,
// so every pre-existing assertion in this file keeps its exact expected values.
// ---------------------------------------------------------------------------
describe('the server installs a plugin-diagnostic sink (T1.5 last mile)', () => {
    const roots: string[] = [];

    const fixture = async (): Promise<string> => {
        await mkdir(join(WORKSPACE_ROOT, 'Temp'), { recursive: true });
        await mkdir(SCRATCH_ROOT, { recursive: true });

        const root = await mkdtemp(join(SCRATCH_ROOT, 'plugins-diagnostic-'));

        roots.push(root);

        return root;
    };

    const documentOf = (root: string): Record<string, any> =>
        JSON.parse(readFileSync(join(root, 'harness', 'state.json'), 'utf8')) as Record<string, any>;

    afterEach(async () => {
        probeThrows = false;
        probeReportsPolicy = false;

        for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    });

    // A throwing `turn.before` handler, captured stderr, and one run.
    const runWithThrowingPlugin = async (runtime: HarnessRuntime, sessionId: string): Promise<string[]> => {
        const lines: string[] = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            lines.push(args.map((part) => String(part)).join(' '));
        });

        probeThrows = true;

        try {
            await runtime.store.liveSession(sessionId)?.harness('does a broken plugin still answer?');
        } finally {
            spy.mockRestore();
            probeThrows = false;
        }

        return lines;
    };

    it('a hook that throws still answers, and names itself, its owner and its event on the session', async () => {
        const runtime = createRuntime();
        const created = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'probe' });

        expect(created.status).toBe(201);

        const sessionId = created.body.session.id as string;

        // A healthy session reports NOTHING — the key is absent, so every existing client reads
        // the resource shape it read before this surface existed.
        expect('plugin_diagnostics' in (await call(runtime, 'GET', `${MOUNT}/sessions/${sessionId}`)).body.session).toBe(false);

        const lines = await runWithThrowingPlugin(runtime, sessionId);

        // FAIL-OPEN, first: the whole point of the channel is that a broken policy plugin is
        // visible WITHOUT becoming the run's failure. The scripted answer arrived.
        expect(String((await runtime.store.liveSession(sessionId)?.harness('and again'))?.content)).toBe('second');

        const read = await call(runtime, 'GET', `${MOUNT}/sessions/${sessionId}`);

        // The observable answer to "is this session's plugin broken": WHO, WHERE, WHAT.
        expect(read.body.session.plugin_diagnostics).toEqual([
            {
                at: expect.any(Number),
                kind: 'handler-threw',
                owner: 'context-compaction',
                event: 'turn.before',
                message: 'the probe policy could not read the transcript'
            }
        ]);

        // And the same fact on the server log, which is the other half of "visible" promised by
        // the task — an operator not polling the API still hears about it.
        expect(lines.filter((line) => line.includes('[harness] plugin diagnostic'))).toEqual([
            expect.stringContaining(
                'context-compaction — turn.before handler-threw: the probe policy could not read the transcript'
            )
        ]);

        runtime.store.dispose();
    });

    it('journals the failure on the durable plane and reports it again after a restart', async () => {
        const root = await fixture();
        const first = createRuntime({ root });
        const created = await call(first, 'POST', `${MOUNT}/sessions`, { harness: 'probe' });
        const sessionId = created.body.session.id as string;

        await runWithThrowingPlugin(first, sessionId);

        const diagnostic = {
            at: expect.any(Number),
            kind: 'handler-threw',
            owner: 'context-compaction',
            event: 'turn.before',
            message: 'the probe policy could not read the transcript'
        };

        // The document, not just the in-memory session. The store writes the journal with the NEXT
        // state change rather than scheduling a save for a diagnostic, and a run always produces
        // one — so "broken since before the restart" is a fact the next process can still read.
        expect(documentOf(root).sessions[0].pluginDiagnostics).toEqual([diagnostic]);

        const second = createRuntime({ root });
        const rebooted = await call(second, 'GET', `${MOUNT}/sessions/${sessionId}`);

        expect(rebooted.body.session.plugin_diagnostics).toEqual([diagnostic]);

        second.store.dispose();
        first.store.dispose();
    });

    it('keeps a plugin’s own policy report on the session and off the server log', async () => {
        const runtime = createRuntime();
        const created = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'probe' });
        const sessionId = created.body.session.id as string;

        const lines: string[] = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            lines.push(args.map((part) => String(part)).join(' '));
        });

        probeReportsPolicy = true;

        try {
            await runtime.store.liveSession(sessionId)?.harness('what did the compactor withhold?');
        } finally {
            spy.mockRestore();
            probeReportsPolicy = false;
        }

        const read = await call(runtime, 'GET', `${MOUNT}/sessions/${sessionId}`);

        // Recorded, WITH the structured payload the plugin chose (the units, the token saving), and
        // attributed to the plugin that authored it even though the report named no owner.
        expect(read.body.session.plugin_diagnostics).toEqual([
            {
                at: expect.any(Number),
                kind: 'policy',
                owner: 'context-compaction',
                message: 'withheld 1 superseded tool failure unit',
                data: { units: ['msg-2'], savedTokens: 24 }
            }
        ]);

        // No `event`: a policy report is not tied to one hook, and inventing one would claim a
        // failure that did not happen.
        expect('event' in read.body.session.plugin_diagnostics[0]).toBe(false);
        // And nothing was logged: a decision is information, not a breakage.
        expect(lines.filter((line) => line.includes('[harness] plugin diagnostic'))).toEqual([]);

        runtime.store.dispose();
    });
});

describe('plugin settings survive a restart', () => {
    // The scratch helpers (`fixture`, `documentOf`, `writeDocument`) and their `afterEach`
    // are module-scoped now, because the R2 enablement round trip below uses them too.

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

        // Overrides only: the declared default (200000) is NOT written, and no other plugin
        // appears. The credential rule of this file holds for the whole document.
        expect(saved.pluginSettings).toEqual({ 'context-compaction': { contextLimit: 200000 } });
        expect(JSON.stringify(saved)).not.toContain('server-secret');

        // A second runtime over the same root is what a restart is: the override is read back
        // before the first request, through the store AND therefore through every harness the
        // store builds (`buildHarness` passes `this.plugins.provider`, seeded from the document).
        const second = createRuntime({ root });

        expect(second.store.pluginSettings.get('context-compaction', 'contextLimit')).toBe(200000);
        expect(second.store.pluginSettings.provider.get('context-compaction', 'contextLimit')).toBe(200000);
        expect(second.store.pluginSettings.values('context-compaction')).toEqual({
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });

        // The revision counter is epoch-local, so it restarts at 0 while the VALUE does not.
        const page = await call(second, 'GET', `${MOUNT}/plugins`);

        expect(page.body.revision).toBe(0);
        expect(page.body.items[1].values).toEqual({
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });

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
        expect(page.body.items[1].values).toEqual({
            contextLimit: 4000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });
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
        expect(fourth.store.pluginSettings.values('context-compaction')).toEqual({
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
        });
        expect((await call(fourth, 'GET', `${MOUNT}/plugins`)).body.items[1].values).toEqual({
            // Back on every declared default — and "declared" now means all six settings
            // (five as of compaction T4.6, plus R4's `modelLimits`; the R4 headroom knob was
            // removed by the 2026-11-10 one-number ruling), not just the limit.
            contextLimit: 200000,
            modelLimits: '{}',
            enabled: true,
            minTokens: 200,
            safetyTurns: 6,
            mode: 'summarize'
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

// ---------------------------------------------------------------------------
// R2 — THE GLOBAL PLUGIN SWITCH (the operator's one-click enable/disable)
//
// Every assertion below is exact. `async-ping` is the case that does NOT declare an
// `enabled` setting of its own (the framework's reserved key is the only reason the write
// is accepted) and `context-compaction` is the case that DOES (its Rule-0 read and the
// framework gate are one stored value). The scripted probe plugin replaces compaction and
// records every `turn.before` delivery, which is what makes "the hook stopped" an
// observation rather than an inference.
//
// Cross-references:
//   - ./plugins.ts                — `PLUGIN_ENABLED_KEY`, `RESERVED_ENABLED_DESCRIPTOR`, `enabled()`
//   - ../plugin/host.ts           — the gate that turns the stored value into "no delivery"
//   - ../plugin/hooks.ts          — rule 9, and the `harness.dispose` exemption
//   - ./api.ts                    — `patchPlugin` / `pluginRowOf`, the route table
// ---------------------------------------------------------------------------

describe('R2 — the global plugin switch', () => {
    it('answers 200 with the row switched off for a plugin that never declares the key', async () => {
        const runtime = createRuntime();

        // On by default, and reported on the row even though async-ping declares no such
        // setting: the switch belongs to the framework, not to the plugin.
        const before = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(before.status).toBe(200);
        expect(before.body.items[0]).toMatchObject({ name: 'async-ping', enabled: true });
        expect(Object.keys(before.body.items[0].values)).toEqual(['intervalMs']);

        const patched = await patchSettings(runtime, 'async-ping', { enabled: false });

        expect(patched.status).toBe(200);
        expect(patched.body.plugin).toMatchObject({ name: 'async-ping', builtin: true, enabled: false });

        // `values` stays the declared projection: the switch is the row's own field, so a
        // client that edits `values` never accidentally edits enablement.
        expect(patched.body.plugin.values).toEqual({ intervalMs: 600000 });
        expect(patched.body.plugin.settings.map((entry: { key: string }) => entry.key)).toEqual(['intervalMs']);

        // The collection revision is the store's own counter: one bump per accepted write.
        const after = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(after.body.revision).toBe(1);
        expect(after.body.items[0]).toMatchObject({ name: 'async-ping', enabled: false });
        expect(after.body.items[1]).toMatchObject({ name: 'context-compaction', enabled: true });

        // A second click turns it back on, and the store keeps no override at its default.
        const on = await patchSettings(runtime, 'async-ping', { enabled: true });

        expect(on.status).toBe(200);
        expect(on.body.plugin).toMatchObject({ enabled: true });
        expect(pluginsOf(runtime).snapshot()).toEqual({ 'async-ping': { enabled: true } });

        // `null` is the documented RESET: the override goes away and the default (true) applies.
        const reset = await patchSettings(runtime, 'async-ping', { enabled: null });

        expect(reset.status).toBe(200);
        expect(reset.body.plugin).toMatchObject({ enabled: true });
        expect(pluginsOf(runtime).snapshot()).toEqual({});
    });

    it('unifies with a plugin that DECLARES `enabled`: one stored value, read by the row and by the plugin', async () => {
        const runtime = createRuntime();

        const patched = await patchSettings(runtime, 'context-compaction', { enabled: false });

        expect(patched.status).toBe(200);
        // The row field and the declared `values` entry are the SAME value: compaction's
        // own Rule-0 read consults the identical key, so a row can never disagree with
        // what the running plugin does.
        expect(patched.body.plugin).toMatchObject({ name: 'context-compaction', enabled: false });
        expect(patched.body.plugin.values).toMatchObject({ enabled: false });
        expect(pluginsOf(runtime).provider.get('context-compaction', 'enabled')).toBe(false);

        const page = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(page.body.items[1]).toMatchObject({ enabled: false });
    });

    it('refuses a non-boolean `enabled` with 400 and changes nothing', async () => {
        const runtime = createRuntime();

        // A number, a string that is not one of the two words the runtime parses, an
        // object, and an array: every one is a 400 that names the declared type, and none
        // of them mutates the store.
        for (const submitted of ['nope', 1, {}, []]) {
            const refused = await patchSettings(runtime, 'async-ping', { enabled: submitted });

            expect(refused.status).toBe(400);
            expect(refused.body.error.message).toBe(
                '"enabled" of plugin "async-ping" must be true or false (it is declared "boolean").'
            );
            expect(pluginsOf(runtime).enabled('async-ping')).toBe(true);
        }

        // A refused write never moved the counter either: the row is exactly as it was.
        const page = await call(runtime, 'GET', `${MOUNT}/plugins`);

        expect(page.body.revision).toBe(0);
        expect(page.body.items[0]).toMatchObject({ enabled: true });

        // An unknown plugin is still 404 before any of this, and an unknown FIELD is still 400.
        expect((await patchSettings(runtime, 'nope-plugin', { enabled: false })).status).toBe(404);
        expect((await call(runtime, 'PATCH', `${MOUNT}/plugins/async-ping`, { enabled: false })).status).toBe(400);
    });

    it('stops a LIVE session\'s hook from the next turn, with no rebuild, while the session is running', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);
        const record = runtime.store.liveSession(sessionId);

        // Turn 1: the probe plugin's `turn.before` handler runs and records the read.
        await record.harness('one');

        expect(probeReads).toEqual([200000]);

        // The write lands with a session ALIVE and needs no idle window (R1: the page is
        // reachable while a thread is running, and this route has no 409 path at all).
        const patched = await patchSettings(runtime, 'context-compaction', { enabled: false });

        expect(patched.status).toBe(200);
        expect(runtime.store.liveSession(sessionId).harness).toBe(record.harness);

        // Turn 2: the gate in ../plugin/host.ts consults the live provider, so this
        // plugin's handler is NOT delivered — and the run still answers normally.
        const second = await record.harness('two');

        expect(probeReads).toEqual([200000]);
        expect(second.content).toBe('second');

        // Turn 3 after the click back on: the same registration is live again, with no
        // re-registration and no new session.
        await patchSettings(runtime, 'context-compaction', { enabled: true });
        await record.harness('three');

        expect(probeReads).toEqual([200000, 200000]);

        // `has()` follows the gate too, so an emit site guarded by it skips the payload
        // construction: a disabled permanent subscriber costs what no subscriber costs.
        expect(runtime.store.liveSession(sessionId).harness).toBe(record.harness);
    });

    it('persists the reserved key as the only override and restores it on the next boot', async () => {
        const root = await fixture();
        const first = createRuntime({ root });

        await first.store.persistRegistry();

        const clean = documentOf(root);

        expect(Object.hasOwn(clean, 'pluginSettings')).toBe(false);

        const patched = await patchSettings(first, 'async-ping', { enabled: false });

        expect(patched.status).toBe(200);

        const saved = documentOf(root);

        // One key, one plugin, no defaults beside it — and the reserved key is stored exactly
        // like a declared one, because it IS a normal entry in the same override map.
        expect(saved.pluginSettings).toEqual({ 'async-ping': { enabled: false } });
        expect(JSON.stringify(saved)).not.toContain('server-secret');

        const second = createRuntime({ root });
        const page = await call(second, 'GET', `${MOUNT}/plugins`);

        // Read back before the first answer: a restart does not silently switch the plugin on.
        expect(second.store.pluginSettings.enabled('async-ping')).toBe(false);
        expect(second.store.pluginSettings.provider.get('async-ping', 'enabled')).toBe(false);
        expect(page.body.items[0]).toMatchObject({ name: 'async-ping', enabled: false });
        expect(page.body.revision).toBe(0);

        // The restored provider is still THE live one: a click after the restart moves it.
        await patchSettings(second, 'async-ping', { enabled: true });

        expect(documentOf(root).pluginSettings).toEqual({ 'async-ping': { enabled: true } });
        expect((await call(createRuntime({ root }), 'GET', `${MOUNT}/plugins`)).body.items[0]).toMatchObject({
            enabled: true
        });
    });

    it('survives a hand-edited document the same tolerant way a declared key does', async () => {
        const root = await fixture();
        const first = createRuntime({ root });

        // Boot once so the file exists, then hand-edit it the way an operator or a bad
        // release would.
        await first.store.persistRegistry();

        const saved = documentOf(root);

        // A mistyped enablement value, and a retired plugin that also names `enabled`:
        // neither may abort the boot, and the bad entry is simply not restored.
        saved.pluginSettings = {
            'async-ping': { enabled: 'maybe' },
            'retired-plugin': { enabled: false }
        };

        await writeDocument(root, saved);

        const second = createRuntime({ root });
        const page = await call(second, 'GET', `${MOUNT}/plugins`);

        expect(page.status).toBe(200);
        expect(page.body.items[0]).toMatchObject({ name: 'async-ping', enabled: true });
        expect(second.store.pluginSettings.snapshot()).toEqual({});
    });
});
