// T2 (R4 + R5) — SESSION-SCOPED plugin settings: one settings provider per session, the two
// session-scoped REST routes, and the per-session durability that comes with them.
//
// WHAT THIS FILE PROVES (one block per requirement half):
//
//   R4 — ONE PROVIDER PER SESSION
//     1. SEEDING     - every session's store is its OWN object, seeded from the process/template
//                      store at creation; the report `SessionStore.buildHarness` handed the preset
//                      carries THAT session's provider object (identity, not an equal copy), so one
//                      provider per session reaches the harness, the toolbox, the plugin host, each
//                      plugin's `api.settings`, and every lane child built from that session — and
//                      NO provider is shared between two sessions or with the template.
//     2. CREATION    - a template `PATCH` is inherited by a session created AFTER it and by nothing
//                      that already exists (neither live nor on restart).
//     3. ISOLATION   - `PATCH /v1/harness/sessions/{A}/plugins/{p}` changes what session A's plugin
//                      reads on A's very next turn, same harness object, no rebuild — and changes
//                      nothing for session B and nothing for the template. A template `PATCH` after
//                      that reaches a NEW session only. A reset (`null`) is equally immediate.
//     4. SHARED HALF - the plugin CATALOGUE stays one object: three stores answer the identical
//                      descriptors, declared settings and defaults, and one provider is still ONE
//                      provider for everything inside one session (its plugins and its lanes).
//
//   R5 — THE REST SURFACE
//     5. PAGE ROWS   - `GET /v1/harness/sessions/{id}/plugins` answers the SAME row shape as
//                      `GET /v1/harness/plugins` (same keys per row, same order, same paging
//                      envelope), with THIS session's `enabled`/`values`.
//     6. ONE ROW     - `GET .../plugins/{plugin_id}` answers exactly the row the page carries, and
//                      `PATCH` there answers the row the page shows afterwards.
//     7. REFUSALS    - unknown session is a 404 BEFORE the body is read; unknown plugin is a 404;
//                      unknown key / wrong type / out-of-range / empty patch / a missing or unknown
//                      body field / an out-of-range `limit` are the SAME 400s the global route
//                      answers, with the same messages. There is no 409: the write is anytime.
//     8. REVISIONS   - `revision` (body and `X-Harness-Revision`) is PER STORE: a session's counter
//                      moves only for that session, the template counter only for the template, and
//                      neither route reads the other's number.
//     9. DURABLE     - the value is in `state.json` before the 200, per session, beside that
//                      session's `toolSettings`; a session that changed nothing writes NO
//                      `pluginSettings` key; a restart resumes each session's own copy while the
//                      template keeps its own; a hand-edited block with a stale key, an unusable
//                      value and a plugin this build lacks is TOLERATED, while the document-level
//                      template block stays strict.
//
// Determinism: every status, key list, message and number below is an EXACT assertion. The harness
// is scripted (no provider, no network); the probe plugin REPLACES the shipped `context-compaction`
// (same name = one entry, ../plugin/host.ts precedence) while keeping its declared metadata, so
// `api.settings.number('contextLimit')` resolves the same key, default and bounds as the real
// plugin, and `probeReads` IS the acceptance criterion: one entry per model request.
//
// WHY THIS FILE IS NEW RATHER THAN AN EDIT: the three server suites a settings change normally
// touches (`./plugins.test.ts`, `./persistence.test.ts`, `./workers/lane-tool-settings.test.ts`) are
// owned by other workers; this file adds the R4/R5 coverage without touching them.
//
// Cross-references:
//   - ./plugins.ts                    — `copyPluginSettingsStore` (the seed), per-store `revision()`
//   - ./sessions.ts                   — `Session.plugins`, `create`, `buildHarness`, `restoreSession`,
//                                       `sessionRecord`, `blueprintFor`, `updateSessionPluginSettings`
//   - ./persistence.ts                — `HarnessSessionRecord.pluginSettings` (tolerant read) beside
//                                       the strict document-level `pluginSettings`
//   - ./api.ts                        — `getSessionPlugins` / `getSessionPlugin` / `patchSessionPlugin`
//   - ../shared/harness-api.ts        — the generated templates these routes come from
//   - ./plugins-api.test.ts           — the template-scope contract (same probe, same helpers)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agent, harness } from '../harness';
import type { HarnessStream, HarnessStreamEvent } from '../harness';
import { BUILTIN_PLUGIN_DESCRIPTORS } from '../plugin/manifest';
import type { HarnessPluginApi, HarnessPluginMetadata } from '../types';
import { createHarnessRegistry } from './harnesses';
import type { HarnessPreset, HarnessPresetReport, RunnerSettings } from './harnesses/types';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime, HarnessRuntimeOptions } from './runtime';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { HARNESS_REVISION_HEADER } from '../shared/harness-api';

const MOUNT = '/v1/harness';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'demo-model'
};

const DEFAULTS = { baseURL: 'http://provider.test/v1', model: 'demo-model', hasApiKey: true };

// The shipped metadata, read from the generated manifest rather than retyped, so a wording change
// in the plugin file cannot silently break these pins (the same trick ./plugins-api.test.ts uses).
const COMPACTION = BUILTIN_PLUGIN_DESCRIPTORS.find((entry) => entry.name === 'context-compaction') as HarnessPluginMetadata;

// The manifest scan order (path ascending), as an exact literal: the page must carry this order,
// not a derivation of it.
const CATALOGUE = ['async-ping', 'context-compaction', 'context-trimmer'];

// What compaction's `values` object holds while nothing is overridden — all SIX declared settings
// (the five of compaction T4.6 plus R4's `modelLimits`). Hardcoded on purpose: it is the contract
// the pane renders, and a new or renamed declared setting has to fail here loudly.
const COMPACTION_DEFAULT_VALUES = {
    contextLimit: 200000,
    modelLimits: '{}',
    enabled: true,
    minTokens: 200,
    safetyTurns: 6,
    mode: 'summarize'
};

// ---------------------------------------------------------------------------
// Scratch roots for the durability block: the repo's own `Temp/` (AGENTS.md), with the package's
// `Temp/` as the standalone-checkout fallback. Same ancestor rule ./plugins-api.test.ts uses.
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

const roots: string[] = [];

const fixture = async (): Promise<string> => {
    await mkdir(join(WORKSPACE_ROOT, 'Temp'), { recursive: true });
    await mkdir(SCRATCH_ROOT, { recursive: true });

    const root = await mkdtemp(join(SCRATCH_ROOT, 'session-plugins-'));

    roots.push(root);

    return root;
};

const fileOf = (root: string): string => join(root, 'harness', 'state.json');

const documentOf = (root: string): Record<string, any> =>
    JSON.parse(readFileSync(fileOf(root), 'utf8')) as Record<string, any>;

const sessionBlock = (root: string, sessionId: string): Record<string, any> =>
    (documentOf(root).sessions as Record<string, any>[]).find((entry) => entry.id === sessionId);

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The scripted probe: a `turn.before` hook is the exact moment a real compaction plugin decides
// whether to compact, so the array of values it read IS "what this session's plugin reads".
// ---------------------------------------------------------------------------

let probeReads: number[] = [];

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

const probePlugin = {
    name: 'context-compaction',
    metadata: COMPACTION,
    setup: (api: HarnessPluginApi) => {
        api.on('turn.before', () => {
            probeReads.push(api.settings.number('contextLimit'));
        });
    }
};

// The reports `SessionStore.buildHarness` passed, one per harness THIS store built. The identity
// of `report.pluginSettings` is R4's whole invariant, so the array is reset per scenario.
let builtReports: (HarnessPresetReport | undefined)[] = [];

const probePreset = (): HarnessPreset => ({
    name: 'probe',
    title: 'Probe',
    description: 'Scripted per-session plugin-settings probe preset.',
    requiresEndpoint: false,
    primary: 'probe',
    subagents: [],
    agents: ['probe'],
    tools: [],
    builtin: true,
    editable: true,
    // Shaped exactly like `createToolboxHarness`: the settings provider that arrives in the report
    // is the one forwarded into `harness({ pluginSettings })`. With R4 that provider is the
    // SESSION's (./sessions.ts `buildHarness`), which is the wiring this file pins.
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
            report: { progress },
            ...(report?.pluginSettings === undefined ? {} : { pluginSettings: report.pluginSettings }),
            plugins: [probePlugin]
        });
    }
});

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

    return { status: result.status, body: result.body as Record<string, any>, headers: result.headers ?? {} };
};

/** One `POST /sessions` (the `probe` preset) and its created id. */
const createSession = async (runtime: HarnessRuntime): Promise<string> => {
    const created = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'probe' });

    expect(created.status).toBe(201);

    return created.body.session.id as string;
};

// The two new routes, spelled once.
const sessionPage = (runtime: HarnessRuntime, sessionId: string, search?: string): Promise<CallResult> =>
    call(runtime, 'GET', `${MOUNT}/sessions/${sessionId}/plugins`, {}, search);

const sessionRow = (runtime: HarnessRuntime, sessionId: string, plugin: string): Promise<CallResult> =>
    call(runtime, 'GET', `${MOUNT}/sessions/${sessionId}/plugins/${plugin}`);

const patchSession = (runtime: HarnessRuntime, sessionId: string, plugin: string, settings: unknown): Promise<CallResult> =>
    call(runtime, 'PATCH', `${MOUNT}/sessions/${sessionId}/plugins/${plugin}`, { settings });

/** The compaction row of one scope, by name rather than by index, so a re-order cannot hide behind it. */
const rowNamed = (page: CallResult, name: string): Record<string, any> =>
    (page.body.items as Record<string, any>[]).find((entry) => entry.name === name);

/** A row with the SCOPE-DEPENDENT halves removed — what must be identical in every scope. */
const shapeOf = (row: Record<string, any>): Record<string, unknown> => {
    const { enabled: _enabled, values: _values, ...rest } = row;

    return rest;
};

// ---------------------------------------------------------------------------
// R4 — one settings provider per session
// ---------------------------------------------------------------------------

describe('R4 — one settings provider per session', () => {
    it('gives every session its own store, seeded from the template, and hands THAT provider to the harness', async () => {
        const runtime = createRuntime();

        // The template is written BEFORE the sessions exist, so seeding is observable: a store
        // copied at creation carries the value, and the provider built from it answers it.
        expect((await call(runtime, 'PATCH', `${MOUNT}/plugins/context-compaction`, { settings: { contextLimit: 64000 } })).status).toBe(200);

        const first = await createSession(runtime);
        const second = await createSession(runtime);

        const template = runtime.store.pluginSettings;
        const firstStore = runtime.store.liveSession(first).plugins;
        const secondStore = runtime.store.liveSession(second).plugins;

        // THREE distinct store objects and THREE distinct provider objects. Nothing is shared: not
        // two sessions, and not a session and the template it was seeded from.
        expect(firstStore).not.toBe(secondStore);
        expect(firstStore).not.toBe(template);
        expect(firstStore.provider).not.toBe(secondStore.provider);
        expect(firstStore.provider).not.toBe(template.provider);

        // THE WIRING PROOF: each build's report carried its OWN session's provider object (identity,
        // not an equal copy) — the same object the toolbox forwards into `harness({ pluginSettings })`
        // and therefore the one every plugin of that session reads. Two sessions of ONE harness
        // template never share a provider, which is the R4 rule stated from the harness side.
        expect(builtReports).toHaveLength(2);
        expect(builtReports[0]?.pluginSettings).toBe(firstStore.provider);
        expect(builtReports[1]?.pluginSettings).toBe(secondStore.provider);
        expect(builtReports[0]?.pluginSettings).not.toBe(template.provider);

        // The seed itself: each session's override map is the template's snapshot, value for value.
        expect(firstStore.snapshot()).toEqual({ 'context-compaction': { contextLimit: 64000 } });
        expect(secondStore.snapshot()).toEqual({ 'context-compaction': { contextLimit: 64000 } });
        expect(firstStore.get('context-compaction', 'contextLimit')).toBe(64000);
        expect(firstStore.enabled('context-compaction')).toBe(true);

        // And the OTHER half of R4: the catalogue is not copied per session, it is one shared
        // reference, so rows, declared settings and defaults cannot drift between scopes.
        expect(firstStore.descriptors).toBe(template.descriptors);
        expect([...firstStore.descriptors].map((entry) => entry.name)).toEqual(CATALOGUE);
        expect(firstStore.values('context-compaction')).toEqual({ ...COMPACTION_DEFAULT_VALUES, contextLimit: 64000 });
    });

    it('changes nothing that already exists when the template moves, live or after a restart', async () => {
        const root = await fixture();
        const runtime = createRuntime({ root });
        const existing = await createSession(runtime);

        // The pre-existing session is the one the old semantics used to reach; R4 stops that.
        await runtime.store.liveSession(existing).harness('first');

        expect(probeReads).toEqual([200000]);

        expect((await call(runtime, 'PATCH', `${MOUNT}/plugins/context-compaction`, { settings: { contextLimit: 64000 } })).status).toBe(200);

        // (a) the LIVE session keeps reading what it was seeded with, on its very next turn…
        await runtime.store.liveSession(existing).harness('second');

        expect(probeReads).toEqual([200000, 200000]);
        expect(runtime.store.liveSession(existing).plugins.get('context-compaction', 'contextLimit')).toBeUndefined();

        // (b) …and so does it after a restart, because its own (empty) block is what persists.
        expect(sessionBlock(root, existing).pluginSettings).toBeUndefined();

        const restarted = createRuntime({ root });

        expect(restarted.store.liveSession(existing).plugins.get('context-compaction', 'contextLimit')).toBeUndefined();
        expect((await sessionRow(restarted, existing, 'context-compaction')).body.plugin.values.contextLimit).toBe(200000);

        // (c) the template write IS durable and does reach a session created afterwards.
        expect(documentOf(root).pluginSettings).toEqual({ 'context-compaction': { contextLimit: 64000 } });

        const created = await createSession(restarted);

        expect(restarted.store.liveSession(created).plugins.get('context-compaction', 'contextLimit')).toBe(64000);
        expect((await sessionRow(restarted, created, 'context-compaction')).body.plugin.values.contextLimit).toBe(64000);
    });

    it('hands one stable provider to every consumer inside one session, and no consumer outside it', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);

        // The store object is the SESSION's and it is stable: reading the session again returns the
        // same store, so a plugin, a lane child and the REST rows all resolve through ONE provider.
        const store = runtime.store.liveSession(sessionId).plugins;

        expect(runtime.store.liveSession(sessionId).plugins).toBe(store);
        expect(runtime.store.liveSession(sessionId).plugins.provider).toBe(store.provider);

        // ONE provider, two different consumers: a plugin's `api.settings` (via `values`) and the
        // framework's reserved-key gate (via `enabled`) read the same write, in the same turn.
        store.update('context-compaction', { contextLimit: 32000, enabled: false });

        expect(store.provider.get('context-compaction', 'contextLimit')).toBe(32000);
        expect(store.provider.get('context-compaction', 'enabled')).toBe(false);
        expect(store.values('context-compaction')).toEqual({ ...COMPACTION_DEFAULT_VALUES, contextLimit: 32000, enabled: false });
        expect(store.enabled('context-compaction')).toBe(false);

        // Nothing outside this session moved. The lane BLUEPRINT side of the same provider
        // (`./sessions.ts` `blueprintFor` -> `pluginOverrides` -> the child's `restore`) is pinned by
        // ./workers/lane-tool-settings.test.ts; the provider identity above is the fact it builds on.
        expect(runtime.store.pluginSettings.snapshot()).toEqual({});
        expect(runtime.store.pluginSettings.enabled('context-compaction')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// R5 — GET /v1/harness/sessions/{session_id}/plugins
// ---------------------------------------------------------------------------

describe('GET /v1/harness/sessions/{session_id}/plugins', () => {
    it('answers the global row shape with THIS session values, row for row', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);

        const global = await call(runtime, 'GET', `${MOUNT}/plugins`);
        const page = await sessionPage(runtime, sessionId);

        expect(page.status).toBe(200);
        expect(Object.keys(page.body).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);

        // Same items, same order, same page size as the global page — the two scopes differ in one
        // value set, never in shape or in ordering.
        expect(page.body.limit).toBe(3);
        expect(page.body.next_cursor).toBeNull();
        expect((page.body.items as Record<string, any>[]).map((entry) => entry.name)).toEqual(CATALOGUE);
        expect((global.body.items as Record<string, any>[]).map((entry) => entry.name)).toEqual(CATALOGUE);

        for (const [index, sessionEntry] of (page.body.items as Record<string, any>[]).entries()) {
            const globalEntry = (global.body.items as Record<string, any>[])[index];

            expect(Object.keys(sessionEntry).sort()).toEqual(Object.keys(globalEntry).sort());
            // With `enabled` and `values` removed the two rows are one and the same object shape,
            // identity fields and declared settings included.
            expect(shapeOf(sessionEntry)).toEqual(shapeOf(globalEntry));
        }

        // The session-scope row, literal: the compaction pane's exact starting state. Every identity
        // field is the value the plugin file declares (src/plugins/context-compaction.plugin.ts:367
        // -403), restated here as a literal so a metadata change fails this pin. `system_prompt` is
        // the plugin's multi-line compaction instruction — long and owned by that file, so it is
        // pinned as "a string that is the projected value" here and character-for-character against
        // the SAME projection in ./plugins-api.test.ts (the parity loop above proves this route
        // emits the identical field).
        const row = rowNamed(page, 'context-compaction');

        expect(row).toEqual({
            name: 'context-compaction',
            title: 'Context Compaction',
            description: 'Compacts the thread context when the conversation reaches a configured token threshold.',
            system_prompt: expect.any(String),
            version: '1.0.0',
            tags: ['context', 'compaction', 'lifecycle'],
            hooks: ['turn.before', 'turn.after', 'thread.idle', 'run.finished', 'run.failed'],
            builtin: true,
            enabled: true,
            settings: row.settings,
            values: COMPACTION_DEFAULT_VALUES
        });
        expect(Object.keys(row).sort()).toEqual(
            [
                'builtin',
                'description',
                'enabled',
                'hooks',
                'name',
                'settings',
                'system_prompt',
                'tags',
                'title',
                'values',
                'version'
            ].sort()
        );
        // The declared settings, in declared order, with the reserved `enabled` among them: the pane
        // renders this list as-is, and the reset target of every row is its `default`.
        expect((row.settings as Record<string, any>[]).map((entry) => entry.key)).toEqual([
            'contextLimit',
            'modelLimits',
            'enabled',
            'minTokens',
            'safetyTurns',
            'mode'
        ]);
        expect((row.settings as Record<string, any>[]).map((entry) => entry.default)).toEqual([
            200000,
            '{}',
            true,
            200,
            6,
            'summarize'
        ]);

        // The route answers EXACTLY what this session's provider answers.
        expect(row.values).toEqual(runtime.store.liveSession(sessionId).plugins.values('context-compaction'));
        expect(row.enabled).toBe(runtime.store.liveSession(sessionId).plugins.enabled('context-compaction'));
    });

    it('reads the same page the global route reads once this session overrides a value', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);

        expect((await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 24000 })).status).toBe(200);

        const page = await sessionPage(runtime, sessionId);
        const global = await call(runtime, 'GET', `${MOUNT}/plugins`);

        // Same shape, different numbers — asserted row by row, not inferred.
        expect(rowNamed(page, 'context-compaction').values).toEqual({ ...COMPACTION_DEFAULT_VALUES, contextLimit: 24000 });
        expect(rowNamed(global, 'context-compaction').values).toEqual(COMPACTION_DEFAULT_VALUES);
        expect(shapeOf(rowNamed(page, 'context-compaction'))).toEqual(shapeOf(rowNamed(global, 'context-compaction')));
    });

    it('filters, pages and answers parameters exactly like the global route', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);

        const limited = await sessionPage(runtime, sessionId, 'limit=2');

        expect(limited.status).toBe(200);
        expect((limited.body.items as Record<string, any>[]).map((entry) => entry.name)).toEqual(['async-ping', 'context-compaction']);
        expect(limited.body.next_cursor).toEqual(expect.any(String));

        const next = await sessionPage(runtime, sessionId, `limit=2&cursor=${limited.body.next_cursor}`);

        expect((next.body.items as Record<string, any>[]).map((entry) => entry.name)).toEqual(['context-trimmer']);
        expect(next.body.next_cursor).toBeNull();

        const searched = await sessionPage(runtime, sessionId, 'q=trimmer');

        expect((searched.body.items as Record<string, any>[]).map((entry) => entry.name)).toEqual(['context-trimmer']);

        // The SAME page-size rule as every other collection, the global plugin page included.
        expect(await sessionPage(runtime, sessionId, 'limit=0')).toEqual({
            status: 400,
            body: { error: { message: 'Query parameter "limit" must be an integer between 1 and 100.' } },
            headers: {}
        });
        expect(await call(runtime, 'GET', `${MOUNT}/plugins`, {}, 'limit=0')).toEqual({
            status: 400,
            body: { error: { message: 'Query parameter "limit" must be an integer between 1 and 100.' } },
            headers: {}
        });
    });

    it('answers one row exactly as the page shows it, and 404s what does not exist', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);

        const page = await sessionPage(runtime, sessionId);
        const detail = await sessionRow(runtime, sessionId, 'context-trimmer');

        expect(detail.status).toBe(200);
        expect(Object.keys(detail.body).sort()).toEqual(['plugin']);
        expect(detail.body.plugin).toEqual(rowNamed(page, 'context-trimmer'));
        // The revision travels in the body's envelope on the page and in the header on both routes.
        expect(detail.headers[HARNESS_REVISION_HEADER]).toBe('0');

        // Unknown session: 404 on all three session routes, with the store's own message.
        for (const result of [
            await sessionPage(runtime, 'ses_missing'),
            await sessionRow(runtime, 'ses_missing', 'context-compaction'),
            await patchSession(runtime, 'ses_missing', 'context-compaction', { contextLimit: 1000 })
        ]) {
            expect(result).toEqual({ status: 404, body: { error: { message: 'Unknown session "ses_missing".' } }, headers: {} });
        }

        // Unknown plugin on a LIVE session, by GET (the catalogue decides, naming the session) and by
        // PATCH (the store decides, naming what this build ships).
        expect(await sessionRow(runtime, sessionId, 'nope')).toEqual({
            status: 404,
            body: { error: { message: `Unknown plugin "nope" in session "${sessionId}".` } },
            headers: {}
        });
        expect(await patchSession(runtime, sessionId, 'nope', { contextLimit: 1000 })).toEqual({
            status: 404,
            body: {
                error: {
                    message: 'Unknown plugin "nope". This build ships: async-ping, context-compaction, context-trimmer.'
                }
            },
            headers: {}
        });
    });
});

// ---------------------------------------------------------------------------
// R5 — PATCH /v1/harness/sessions/{session_id}/plugins/{plugin_id}
// ---------------------------------------------------------------------------

describe('PATCH /v1/harness/sessions/{session_id}/plugins/{plugin_id}', () => {
    it('moves THIS session live, on its next turn, with no rebuild', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);
        const before = runtime.store.liveSession(sessionId).harness;

        await runtime.store.liveSession(sessionId).harness('one');

        expect(probeReads).toEqual([200000]);

        const patched = await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 24000 });

        expect(patched.status).toBe(200);
        expect(patched.body.plugin).toMatchObject({ name: 'context-compaction', enabled: true });
        expect(patched.body.plugin.values).toEqual({ ...COMPACTION_DEFAULT_VALUES, contextLimit: 24000 });
        // The PATCH answers the row the PAGE then shows — the client never re-reads to confirm.
        expect(patched.body.plugin).toEqual(rowNamed(await sessionPage(runtime, sessionId), 'context-compaction'));

        // The SAME provider object the harness already holds answers the new number…
        expect(builtReports[0]?.pluginSettings?.get('context-compaction', 'contextLimit')).toBe(24000);
        // …on the SAME harness object, and the next turn reads it.
        expect(runtime.store.liveSession(sessionId).harness).toBe(before);

        await runtime.store.liveSession(sessionId).harness('two');

        expect(probeReads).toEqual([200000, 24000]);

        // A reset is equally immediate: the declared default applies again.
        expect((await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: null })).status).toBe(200);

        await runtime.store.liveSession(sessionId).harness('three');

        expect(probeReads).toEqual([200000, 24000, 200000]);
    });

    it('is immediate for one session and invisible to the other sessions and to the template', async () => {
        const runtime = createRuntime();
        const first = await createSession(runtime);
        const second = await createSession(runtime);

        expect((await patchSession(runtime, first, 'context-compaction', { contextLimit: 24000 })).status).toBe(200);

        // A's own next turn…
        await runtime.store.liveSession(first).harness('a1');

        expect(probeReads).toEqual([24000]);

        // …and B's, unchanged, on the same process and the same template.
        await runtime.store.liveSession(second).harness('b1');

        expect(probeReads).toEqual([24000, 200000]);

        expect((await sessionPage(runtime, second)).body.items.find((e: any) => e.name === 'context-compaction').values).toEqual(
            COMPACTION_DEFAULT_VALUES
        );
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`)).body.items[1].values).toEqual(COMPACTION_DEFAULT_VALUES);
        expect(runtime.store.pluginSettings.snapshot()).toEqual({});

        // A template write afterwards reaches a NEW session only — and still neither existing one.
        expect((await call(runtime, 'PATCH', `${MOUNT}/plugins/context-compaction`, { settings: { contextLimit: 64000 } })).status).toBe(200);

        const third = await createSession(runtime);

        await runtime.store.liveSession(third).harness('c1');

        expect(probeReads).toEqual([24000, 200000, 64000]);

        await runtime.store.liveSession(first).harness('a2');
        await runtime.store.liveSession(second).harness('b2');

        expect(probeReads).toEqual([24000, 200000, 64000, 24000, 200000]);

        // The rows state the same three-way split, in the same request cycle.
        expect((await sessionPage(runtime, first)).body.items[1].values.contextLimit).toBe(24000);
        expect((await sessionPage(runtime, second)).body.items[1].values.contextLimit).toBe(200000);
        expect((await sessionPage(runtime, third)).body.items[1].values.contextLimit).toBe(64000);
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`)).body.items[1].values.contextLimit).toBe(64000);
    });

    it('switches one session off without switching the plugin off for anybody else', async () => {
        const runtime = createRuntime();
        const off = await createSession(runtime);
        const on = await createSession(runtime);

        expect((await patchSession(runtime, off, 'context-compaction', { enabled: false })).status).toBe(200);
        expect(rowNamed(await sessionPage(runtime, off), 'context-compaction').enabled).toBe(false);
        expect(rowNamed(await sessionPage(runtime, on), 'context-compaction').enabled).toBe(true);

        // The framework gate consults the SESSION's stored value, so the hook stops HERE and not there.
        await runtime.store.liveSession(off).harness('one');

        expect(probeReads).toEqual([]);

        await runtime.store.liveSession(on).harness('one');

        expect(probeReads).toEqual([200000]);

        // The template still says "on", so a session created next run still gets the hook.
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`)).body.items[1].enabled).toBe(true);
    });

    it('refuses a bad body with the global route errors, and never mentions "busy"', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);

        // A body that is not an object, and a body without `settings`.
        expect((await call(runtime, 'PATCH', `${MOUNT}/sessions/${sessionId}/plugins/context-compaction`, ['settings'])).status).toBe(400);
        expect(
            await call(runtime, 'PATCH', `${MOUNT}/sessions/${sessionId}/plugins/context-compaction`, { enabled: false })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "enabled". Allowed fields: settings.' } },
            headers: {}
        });

        // Unknown key — the store names every key this plugin accepts.
        expect(await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 5000, pruneMode: 'soft' })).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'Unknown setting "pruneMode" for plugin "context-compaction". Allowed settings: contextLimit, modelLimits, enabled, minTokens, safetyTurns, mode.'
                }
            },
            headers: {}
        });

        // Wrong type, and below the declared minimum — both exact store messages.
        expect(await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 'lots' })).toEqual({
            status: 400,
            body: {
                error: {
                    message: '"contextLimit" of plugin "context-compaction" must be a finite number (it is declared "number").'
                }
            },
            headers: {}
        });
        expect(await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 1 })).toEqual({
            status: 400,
            body: {
                error: { message: '"contextLimit" of plugin "context-compaction" must be at least 1000; 1 was submitted.' }
            },
            headers: {}
        });

        // An empty patch, and a non-object `settings`.
        expect(await patchSession(runtime, sessionId, 'context-compaction', {})).toEqual({
            status: 400,
            body: { error: { message: 'A plugin settings patch must change at least one setting.' } },
            headers: {}
        });
        expect((await call(runtime, 'PATCH', `${MOUNT}/sessions/${sessionId}/plugins/context-compaction`, { settings: [] })).status).toBe(400);

        // A refused patch is a no-op on this session: still the declared default, and still no
        // `pluginSettings` block in the document.
        expect(rowNamed(await sessionPage(runtime, sessionId), 'context-compaction').values.contextLimit).toBe(200000);

        // WRITE-ANYTIME: the session above was never idle-bound, and no route here has a 409 path —
        // a settings write moves no registration and removes no schema the model was promised.
        expect((await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 24000 })).status).toBe(200);
    });

    it('404s an unknown session before it reads the body', async () => {
        const runtime = createRuntime();

        // The id is resolved from the PATH before `readBody` is awaited, so a body that would be a
        // 400 on a live session is still a 400-free 404 here.
        const result = await call(runtime, 'PATCH', `${MOUNT}/sessions/ses_missing/plugins/context-compaction`, { nope: true });

        expect(result).toEqual({ status: 404, body: { error: { message: 'Unknown session "ses_missing".' } }, headers: {} });
    });
});

// ---------------------------------------------------------------------------
// R5 — the revision is PER STORE
// ---------------------------------------------------------------------------

describe('the plugin revision is per store', () => {
    it('moves for the session it belongs to and for nobody else', async () => {
        const runtime = createRuntime();
        const first = await createSession(runtime);
        const second = await createSession(runtime);

        // Both stores start at 0 (a fresh copy has accepted no PATCH), the template too.
        expect((await sessionPage(runtime, first)).body.revision).toBe(0);
        expect((await sessionPage(runtime, second)).body.revision).toBe(0);
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`)).body.revision).toBe(0);

        const patched = await patchSession(runtime, first, 'context-compaction', { contextLimit: 24000 });

        expect(patched.body.plugin).toBeDefined();
        expect(patched.headers[HARNESS_REVISION_HEADER]).toBe('1');
        expect((await sessionPage(runtime, first)).body.revision).toBe(1);
        expect((await sessionRow(runtime, first, 'context-compaction')).headers[HARNESS_REVISION_HEADER]).toBe('1');

        // Neither the other session nor the template moved.
        expect((await sessionPage(runtime, second)).body.revision).toBe(0);
        expect((await sessionPage(runtime, second)).headers[HARNESS_REVISION_HEADER]).toBe('0');
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`)).body.revision).toBe(0);
        expect(runtime.store.pluginSettings.revision()).toBe(0);
        expect(runtime.store.liveSession(second).plugins.revision()).toBe(0);

        // The template's own write moves only the template.
        const global = await call(runtime, 'PATCH', `${MOUNT}/plugins/context-compaction`, { settings: { contextLimit: 64000 } });

        expect(global.headers[HARNESS_REVISION_HEADER]).toBe('1');
        expect((await call(runtime, 'GET', `${MOUNT}/plugins`)).body.revision).toBe(1);
        expect((await sessionPage(runtime, first)).body.revision).toBe(1);
        expect((await sessionPage(runtime, second)).body.revision).toBe(0);

        // And a second accepted PATCH on the same session is one more bump, not a reset.
        expect((await patchSession(runtime, first, 'context-compaction', { minTokens: 300 })).headers[HARNESS_REVISION_HEADER]).toBe('2');
        expect((await sessionPage(runtime, first)).body.revision).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// R4 — durability: per session, in the same document, before the answer
// ---------------------------------------------------------------------------

describe('session plugin settings are durable before the answer', () => {
    it('writes one session block beside its tool settings and resumes each session with its own copy', async () => {
        const root = await fixture();
        const runtime = createRuntime({ root });
        const first = await createSession(runtime);
        const second = await createSession(runtime);

        expect((await patchSession(runtime, first, 'context-compaction', { contextLimit: 24000 })).status).toBe(200);
        expect((await patchSession(runtime, second, 'context-trimmer', { enabled: false })).status).toBe(200);
        // The template gets a value of its own, in the document-level block.
        expect((await call(runtime, 'PATCH', `${MOUNT}/plugins/async-ping`, { settings: { intervalMs: 900000 } })).status).toBe(200);

        // DURABLE BEFORE THE ANSWER: the document behind a 200 already carries it, per session.
        const document = documentOf(root);

        expect(sessionBlock(root, first).pluginSettings).toEqual({ 'context-compaction': { contextLimit: 24000 } });
        expect(sessionBlock(root, second).pluginSettings).toEqual({ 'context-trimmer': { enabled: false } });
        expect(document.pluginSettings).toEqual({ 'async-ping': { intervalMs: 900000 } });

        const restarted = createRuntime({ root });

        // Each session resumes with ITS OWN map — the two differ, and neither is the template's.
        expect(restarted.store.liveSession(first).plugins.snapshot()).toEqual({ 'context-compaction': { contextLimit: 24000 } });
        expect(restarted.store.liveSession(second).plugins.snapshot()).toEqual({ 'context-trimmer': { enabled: false } });
        expect(restarted.store.pluginSettings.snapshot()).toEqual({ 'async-ping': { intervalMs: 900000 } });

        // The scope split, from the same restart: `async-ping` was overridden on the TEMPLATE after
        // both sessions were seeded, so a session row still reports the declared default while the
        // template row reports the operator's value. That is R4, not a restore bug — the template's
        // number reaches a session created from here on, and the per-session rows answer with their
        // own copy either way.
        expect((await sessionPage(restarted, first)).body.items[0].values).toEqual({ intervalMs: 600000 });
        expect((await call(restarted, 'GET', `${MOUNT}/plugins`)).body.items[0].values).toEqual({ intervalMs: 900000 });
        expect(rowNamed(await sessionPage(restarted, first), 'context-compaction').values.contextLimit).toBe(24000);
        expect(rowNamed(await sessionPage(restarted, second), 'context-trimmer').enabled).toBe(false);
        expect(rowNamed(await sessionPage(restarted, second), 'context-compaction').values.contextLimit).toBe(200000);

        // The resumed provider is the resumed session's, so the restored value is live immediately:
        // the first turn after the restart reads the restored number.
        probeReads = [];

        await restarted.store.liveSession(first).harness('after restart');

        expect(probeReads).toEqual([24000]);
    });

    it('writes no pluginSettings key for a session that changed nothing', async () => {
        const root = await fixture();
        const runtime = createRuntime({ root });
        const sessionId = await createSession(runtime);

        await runtime.store.liveSession(sessionId).harness('one');

        const block = sessionBlock(root, sessionId);

        expect('pluginSettings' in block).toBe(false);
        expect('pluginSettings' in documentOf(root)).toBe(false);

        // A PATCH that RESETS every override returns the block to absent, not to `{}` — the writer
        // keeps its promise that "nothing changed" is one shape.
        expect((await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 24000 })).status).toBe(200);
        expect(sessionBlock(root, sessionId).pluginSettings).toEqual({ 'context-compaction': { contextLimit: 24000 } });
        expect((await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: null })).status).toBe(200);
        expect(sessionBlock(root, sessionId).pluginSettings).toBeUndefined();
    });

    it('tolerates a stale session block while the template block stays strict', async () => {
        const root = await fixture();
        const runtime = createRuntime({ root });
        const sessionId = await createSession(runtime);

        expect((await patchSession(runtime, sessionId, 'context-compaction', { contextLimit: 24000 })).status).toBe(200);

        // Hand-edit the block the way an older build or a typo would leave it: a plugin this build
        // lacks, a key nobody declares, a value the declared type rejects, and a non-object entry.
        // ONE parse, mutated in place and written back — `documentOf` returns a fresh object every
        // call, so editing two different parses would write neither.
        const document = documentOf(root);
        const block = (document.sessions as Record<string, any>[]).find((entry) => entry.id === sessionId);

        block.pluginSettings = {
            'context-compaction': { contextLimit: 24000, staleKey: 'kept until the store decides', minTokens: 'not-a-number' },
            'plugin-that-went-away': { anything: 1 },
            'not-an-object': 'a string',
            'context-trimmer': { enabled: false }
        };

        await writeFile(fileOf(root), JSON.stringify(document, null, 2), 'utf8');

        const restarted = createRuntime({ root });

        // TOLERANT: the session restores, the entries that still mean something are kept, and the
        // store's own `restore` (./plugins.ts `applyRestore`) is what drops the key nobody declares,
        // the value the declared type rejects, and the plugin this build lacks.
        expect(restarted.store.liveSession(sessionId).plugins.snapshot()).toEqual({
            'context-compaction': { contextLimit: 24000 },
            'context-trimmer': { enabled: false }
        });
        expect(rowNamed(await sessionPage(restarted, sessionId), 'context-trimmer').enabled).toBe(false);
        expect(rowNamed(await sessionPage(restarted, sessionId), 'context-compaction').values.contextLimit).toBe(24000);

        // A hand-edited block that is not even an object is dropped, and the session starts empty.
        const edited = documentOf(root);

        edited.sessions.find((entry: Record<string, any>) => entry.id === sessionId).pluginSettings = 'a string';

        await writeFile(fileOf(root), JSON.stringify(edited, null, 2), 'utf8');

        const third = createRuntime({ root });

        expect(third.store.liveSession(sessionId).plugins.snapshot()).toEqual({});
        expect(rowNamed(await sessionPage(third, sessionId), 'context-compaction').values).toEqual(COMPACTION_DEFAULT_VALUES);

        // THE CONTRAST, in the same file: the document-level (template) block is NOT tolerant. A
        // non-scalar there is corruption and the whole document refuses to load, which is the
        // deliberate difference `./persistence.ts` documents beside the session reader — one bad
        // template value must not silently redefine the defaults every session is seeded from.
        const strict = documentOf(root);

        strict.pluginSettings = { 'async-ping': { intervalMs: [] } };

        await writeFile(fileOf(root), JSON.stringify(strict, null, 2), 'utf8');

        let refusal = '';

        try {
            createRuntime({ root });
        } catch (error) {
            refusal = error instanceof Error ? error.message : String(error);
        }

        expect(refusal).toContain(
            'The harness database pluginSettings.async-ping.intervalMs must be a number, a string, or a boolean; plugin settings hold JSON scalars only.'
        );
    });
});
