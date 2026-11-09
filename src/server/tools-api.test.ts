// R3 — the GLOBAL tool switch over REST (src/server/api.ts `patchTool`, plus the row fields).
//
// WHAT THIS FILE PROVES (one block per acceptance criterion):
//   1. ROWS      - `GET /v1/harness/tools` carries `enabled` and `protected` on EVERY row
//                  (the pair the Tools pane switches on), and the identified read carries
//                  them beside `parameters`/`execution`.
//   2. WRITE     - `PATCH /v1/harness/tools/{tool_id}` with `{enabled:false}` answers 200
//                  with the updated identified read, bumps the collection revision, and the
//                  next list reflects it. `{enabled:true}` puts it back.
//   3. REFUSALS  - unknown tool => 404 (identity BEFORE body or protection); a protected
//                  entry => 403 with the store's own sentence; a missing/blank/mistyped
//                  `enabled` or an unknown body field => 400. A refused write changes nothing.
//   4. ANYTIME   - there is NO idle gate: the switch lands on a session that is ALIVE, and
//                  the same running session's very NEXT model request is built without the
//                  disabled tool (the wiring proof is the report identity below).
//   5. DURABLE   - `state.json` carries `toolSettings: { disabled: [...] }` and nothing else,
//                  a deployment that never switched anything writes no field at all, and a
//                  fresh runtime on the same root boots with the switch applied. A protected
//                  name smuggled into a hand-edited document is dropped, not honoured.
//
// Determinism: every status, key list, sentence and value below is an EXACT assertion. The
// session harness is scripted (no provider, no network), and the captured stream requests
// ARE the observation of what the model was told.
//
// Cross-references:
//   - ./tool-settings.ts            — the store, the 403 rule, the live provider
//   - ./api.ts                      — `patchTool`, `toolEnablementOf`, the route table
//   - ./sessions.ts                 — `updateToolEnabled` (persist-before-answer) and `buildHarness`
//   - ../harness.ts                 — the declaration filter that reads the provider per request
//   - ./plugins-api.test.ts         — the sibling REST+durability suite this one mirrors
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agent, harness, tool } from '../harness';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '../harness';
import { createHookBus } from '../plugin/hooks';
import { createHarnessRegistry } from './harnesses';
import type { HarnessPreset, HarnessPresetReport, RunnerSettings } from './harnesses/types';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime, HarnessRuntimeOptions } from './runtime';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { CORE_TOOL_NAMES } from './harnesses/toolbox';
import { HARNESS_EPOCH_HEADER, HARNESS_REVISION_HEADER } from '../shared/harness-api';

const MOUNT = '/v1/harness';

const SETTINGS: RunnerSettings = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'demo-model'
};

const DEFAULTS = { baseURL: 'http://provider.test/v1', model: 'demo-model', hasApiKey: true };

// ---------------------------------------------------------------------------
// Scratch root: the workspace `Temp/` (repo policy), same ancestor rule as
// ./plugins-api.test.ts and ./api.test.ts.
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
const SCRATCH_ROOT = join(WORKSPACE_ROOT, 'Temp', 'R3');

const roots: string[] = [];

const fixture = async (): Promise<string> => {
    await mkdir(join(WORKSPACE_ROOT, 'Temp'), { recursive: true });
    await mkdir(SCRATCH_ROOT, { recursive: true });

    const root = await mkdtemp(join(SCRATCH_ROOT, 'tools-'));

    roots.push(root);

    return root;
};

const fileOf = (root: string): string => join(root, 'harness', 'state.json');

const documentOf = (root: string): Record<string, any> =>
    JSON.parse(readFileSync(fileOf(root), 'utf8')) as Record<string, any>;

const writeDocument = async (root: string, document: unknown): Promise<void> => {
    await writeFile(fileOf(root), JSON.stringify(document, null, 2), 'utf8');
};

// ---------------------------------------------------------------------------
// The scripted probe preset: a real session harness (registered tools, a live enabled
// set, the store's report) whose model is a scripted stream that RECORDS every request.
// ---------------------------------------------------------------------------

let probeRequests: HarnessStreamRequest[] = [];
let builtReports: (HarnessPresetReport | undefined)[] = [];

const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        probeRequests.push(request);

        const frames = turns[index] ?? turns[turns.length - 1];

        index += 1;

        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const probePreset = (): HarnessPreset => ({
    name: 'probe',
    title: 'Probe',
    description: 'Scripted global-tool-switch probe preset.',
    requiresEndpoint: false,
    primary: 'probe',
    subagents: [],
    agents: ['probe'],
    tools: ['write'],
    builtin: true,
    editable: true,
    // Shaped exactly like a production factory (`./harnesses/toolbox.ts`): both live
    // providers ride in on the report, because that is the only path from the store to a
    // harness — dropping `toolSettings` here is what the wiring assertion below catches.
    create: (settings, progress, report) => {
        builtReports.push(report);

        return harness({
            agents: {
                probe: agent({
                    model: settings.model,
                    instruction: 'Scripted tool-switch probe agent.',
                    stream: scripted([answer('one'), answer('two'), answer('three')])
                })
            },
            primary: 'probe',
            presets: false,
            tools: {
                write: tool({
                    description: 'Write a file.',
                    tags: ['files'],
                    visibility: 'searchable',
                    execute: () => 'written'
                })
            },
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            },
            ...(report?.pluginSettings === undefined ? {} : { pluginSettings: report.pluginSettings }),
            ...(report?.toolSettings === undefined ? {} : { toolSettings: report.toolSettings })
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
    probeRequests = [];

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

const patchTool = (runtime: HarnessRuntime, name: string, body: unknown): Promise<CallResult> =>
    call(runtime, 'PATCH', `${MOUNT}/tools/${name}`, body);

const toolsOf = (runtime: HarnessRuntime) => runtime.store.toolSettings;

const createSession = async (runtime: HarnessRuntime): Promise<string> => {
    const created = await call(runtime, 'POST', `${MOUNT}/sessions`, { harness: 'probe' });

    expect(created.status).toBe(201);

    return created.body.session.id as string;
};

/** The tool names one captured request was given, in declaration order. */
const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((entry) => entry.name);

afterEach(() => {
    vi.unstubAllEnvs();
});

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('GET /v1/harness/tools — the enablement fields', () => {
    it('carries enabled and protected on every row, and nothing else changed', async () => {
        const runtime = createRuntime();
        const page = await call(runtime, 'GET', `${MOUNT}/tools`, {}, 'limit=100');

        expect(page.status).toBe(200);

        const rows = page.body.items as Record<string, any>[];

        expect(rows.length).toBeGreaterThan(0);

        // The closed `ToolSummary` row: the eight fields are on EVERY row (R3 added the last
        // two), and the one optional member the schema allows is `availability` — a
        // credential-dependent entry only. Asserted as "the required set, plus at most
        // availability", so a new field on the wire fails loudly instead of riding along.
        const requiredRowKeys = [
            'description',
            'enabled',
            'group',
            'name',
            'protected',
            'session_bound',
            'tags',
            'visibility'
        ];

        for (const row of rows) {
            expect(typeof row.enabled).toBe('boolean');
            expect(typeof row.protected).toBe('boolean');

            const extra = Object.keys(row)
                .sort()
                .filter((key) => !requiredRowKeys.includes(key));

            expect(extra).toEqual(row.availability === undefined ? [] : ['availability']);
        }

        // Nothing has been switched: every row is enabled, and only the harness-owned set
        // is protected. A protected row is enabled BY DEFINITION, which is what lets a
        // client render its switch disabled with the real reason instead of a 403.
        expect(rows.every((row) => row.enabled === true)).toBe(true);
        expect(rows.filter((row) => row.protected).map((row) => row.name).sort()).toEqual(
            [...CORE_TOOL_NAMES].sort((left, right) => left.localeCompare(right))
        );
    });

    it('reports the live switch on the row and on the identified read', async () => {
        const runtime = createRuntime();

        const before = await call(runtime, 'GET', `${MOUNT}/tools/timeNow`);

        expect(before.status).toBe(200);
        expect(before.body.tool).toMatchObject({ name: 'timeNow', enabled: true, protected: false });
        expect(Object.keys(before.body.tool).sort()).toEqual([
            'description',
            'enabled',
            'execution',
            'group',
            'name',
            'parameters',
            'protected',
            'session_bound',
            'tags',
            'visibility'
        ]);

        await patchTool(runtime, 'timeNow', { enabled: false });

        const after = await call(runtime, 'GET', `${MOUNT}/tools/timeNow`);

        expect(after.body.tool).toMatchObject({ enabled: false, protected: false });
        expect((await call(runtime, 'GET', `${MOUNT}/tools`, {}, 'limit=100')).body.items).toContainEqual(
            expect.objectContaining({ name: 'timeNow', enabled: false })
        );

        // A protected row reports enabled forever, whatever a document claims.
        const core = CORE_TOOL_NAMES[0];
        const row = (await call(runtime, 'GET', `${MOUNT}/tools/${core}`)).body.tool;

        expect(row).toMatchObject({ name: core, protected: true, enabled: true });
    });
});

describe('PATCH /v1/harness/tools/{tool_id}', () => {
    it('answers 200 with the updated identified read and bumps the collection revision', async () => {
        const runtime = createRuntime();

        const patched = await patchTool(runtime, 'timeNow', { enabled: false });

        expect(patched.status).toBe(200);
        expect(patched.body.tool).toMatchObject({ name: 'timeNow', enabled: false, protected: false });

        // The whole identified read comes back, so a client never re-reads to confirm its
        // own click (the plugins response precedent).
        expect(Object.keys(patched.body.tool).sort()).toEqual([
            'description',
            'enabled',
            'execution',
            'group',
            'name',
            'parameters',
            'protected',
            'session_bound',
            'tags',
            'visibility'
        ]);

        // Revision: the tool-settings store's own counter, one bump per accepted switch,
        // stamped in the contract header like every other write here.
        expect(patched.headers[HARNESS_REVISION_HEADER]).toBe('1');
        expect(patched.headers[HARNESS_EPOCH_HEADER]).toBe(runtime.events.epoch);

        const back = await patchTool(runtime, 'timeNow', { enabled: true });

        expect(back.status).toBe(200);
        expect(back.body.tool).toMatchObject({ enabled: true });
        expect(back.headers[HARNESS_REVISION_HEADER]).toBe('2');

        // An idempotent repeat is accepted, like every other switch on this surface.
        expect((await patchTool(runtime, 'timeNow', { enabled: true })).status).toBe(200);
        expect(toolsOf(runtime).disabled()).toEqual([]);

        // A GET on the collection is still a read: the route table keeps `GET /tools`
        // method-only, and the row set is unchanged by the writes above.
        expect((await call(runtime, 'POST', `${MOUNT}/tools`, {})).status).toBe(405);
    });

    it('refuses a protected entry with 403, an unknown tool with 404, and a bad body with 400', async () => {
        const runtime = createRuntime();

        const core = CORE_TOOL_NAMES[0];

        expect(await patchTool(runtime, core, { enabled: false })).toEqual({
            status: 403,
            body: {
                error: {
                    message: `Tool "${core}" is harness-owned; it is part of the control plane every session runs on and cannot be disabled.`
                }
            },
            headers: expect.any(Object)
        });

        expect(toolsOf(runtime).disabled()).toEqual([]);

        // Identity FIRST: an unknown name is a 404 even with a body that would also fail,
        // and even when the name is protected-shaped.
        const missing = await patchTool(runtime, 'no-such-tool', { enabled: 'yesterday' });

        expect(missing.status).toBe(404);
        expect(missing.body.error.message).toContain('no-such-tool');

        for (const body of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }, {}]) {
            const refused = await patchTool(runtime, 'timeNow', body);

            expect(refused.status).toBe(400);
            expect(refused.body.error.message).toBe(
                '"enabled" must be a boolean (true runs the tool, false disables it for every session).'
            );
        }

        // An unknown FIELD in the closed body is the contract's generic 400, naming the field.
        const unknownField = await patchTool(runtime, 'timeNow', { enabled: false, group: 'x' });

        expect(unknownField.status).toBe(400);
        expect(unknownField.body.error.message).toContain('group');
        expect(toolsOf(runtime).disabled()).toEqual([]);

        // Nothing moved, and the protected row still reads enabled on the wire.
        const page = await call(runtime, 'GET', `${MOUNT}/tools`, {}, 'limit=100');

        expect((page.body.items as Record<string, any>[]).every((row) => row.enabled === true)).toBe(true);
        expect((await call(runtime, 'GET', `${MOUNT}/tools/${core}`)).body.tool).toMatchObject({
            protected: true,
            enabled: true
        });
    });

    it('is write-anytime: it lands on a live session and changes its very next request', async () => {
        const runtime = createRuntime();
        const sessionId = await createSession(runtime);
        const record = runtime.store.liveSession(sessionId);

        // The wiring proof: the report `buildHarness` passed carried THIS store's provider
        // object (identity, not an equal copy) — the same reference discipline that makes a
        // plugin-settings PATCH reach an existing session (./plugins-api.test.ts).
        expect(builtReports).toHaveLength(1);
        expect(builtReports[0]?.toolSettings).toBe(toolsOf(runtime).provider);

        // Put `write` in this session's enabled set (what a `toolRequest` round would do),
        // so the tool is genuinely declared on the next request.
        record.harness.runtime.manageTool(undefined, { operation: 'enable', name: 'write' });

        await record.harness('one');

        expect(declaredNames(probeRequests[0])).toContain('write');

        // The switch, applied while the session is alive. There is no 409 path on this
        // route at all: `assertIdleForToolMutation` (the session-scoped rule) is not
        // consulted, because the tool stays registered and no schema a model was promised
        // disappears mid-turn.
        const patched = await patchTool(runtime, 'write', { enabled: false });

        expect(patched.status).toBe(200);
        expect(runtime.store.liveSession(sessionId).harness).toBe(record.harness);

        await record.harness('two');

        // The SAME harness object, rebuilt declarations: the disabled name is gone and its
        // neighbours are untouched.
        expect(declaredNames(probeRequests[1])).not.toContain('write');
        expect(declaredNames(probeRequests[1])).toEqual(declaredNames(probeRequests[0]).filter((name) => name !== 'write'));

        // Back on, and the session-wide enabled set still holds it — a disable forgets
        // nothing, because it never un-registered anything.
        await patchTool(runtime, 'write', { enabled: true });
        await record.harness('three');

        expect(declaredNames(probeRequests[2])).toContain('write');
    });

    it('persists the deny list as the only new field and restores it on the next boot', async () => {
        const root = await fixture();
        const first = createRuntime({ root });

        await first.store.persistRegistry();

        const clean = documentOf(root);

        // A deployment that never touched the Tools pane keeps its exact previous document.
        expect(Object.hasOwn(clean, 'toolSettings')).toBe(false);

        const patched = await patchTool(first, 'timeNow', { enabled: false });

        expect(patched.status).toBe(200);

        const saved = documentOf(root);

        expect(saved.toolSettings).toEqual({ disabled: ['timeNow'] });
        expect(JSON.stringify(saved)).not.toContain('server-secret');

        const second = createRuntime({ root });

        expect(second.store.toolSettings.isDisabled('timeNow')).toBe(true);
        expect(second.store.toolSettings.provider.isToolDisabled('timeNow')).toBe(true);

        const page = await call(second, 'GET', `${MOUNT}/tools`, {}, 'limit=100');
        const row = (page.body.items as Record<string, any>[]).find((candidate) => candidate.name === 'timeNow');

        expect(row).toMatchObject({ enabled: false, protected: false });

        // The revision counter is epoch-local, so a restart reports 0 while the STATE does
        // not move.
        expect(page.body.revision).toBe(0);

        // A later boot after the switch is undone leaves NO `toolSettings` key at all: the
        // writer never emits an empty deny list, so the document returns to its exact
        // pre-R3 shape.
        await patchTool(second, 'timeNow', { enabled: true });

        expect(Object.hasOwn(documentOf(root), 'toolSettings')).toBe(false);
        expect(second.store.toolSettings.isDisabled('timeNow')).toBe(false);

        const third = createRuntime({ root });

        expect(third.store.toolSettings.snapshot()).toEqual({});

        // And one more disable, so the round trip is proven in both directions.
        await patchTool(third, 'timeNow', { enabled: false });

        expect(documentOf(root).toolSettings).toEqual({ disabled: ['timeNow'] });
        expect((await call(third, 'GET', `${MOUNT}/tools`, {}, 'limit=100')).body.items).toContainEqual(
            expect.objectContaining({ name: 'timeNow', enabled: false })
        );
    });

    it('drops a protected name smuggled into a hand-edited document instead of honouring it', async () => {
        const root = await fixture();
        const first = createRuntime({ root });

        await first.store.persistRegistry();

        const saved = documentOf(root);

        // `disabled` must be an array of strings (./persistence.ts is strict about SHAPE)...
        saved.toolSettings = { disabled: CORE_TOOL_NAMES };

        await writeDocument(root, saved);

        const second = createRuntime({ root });

        // ...while the STORE decides what is still meaningful: every protected name is
        // dropped, so the control plane stays on after a boot from a hostile file.
        expect(second.store.toolSettings.disabled()).toEqual([]);
        expect(second.store.toolSettings.snapshot()).toEqual({});

        const page = await call(second, 'GET', `${MOUNT}/tools`, {}, 'limit=100');

        expect((page.body.items as Record<string, any>[]).every((row) => row.enabled === true)).toBe(true);

        // A wrong SHAPES is corruption of a named slot: it throws on load, like every other
        // field in this document, rather than being silently accepted.
        const broken = documentOf(root);

        broken.toolSettings = { disabled: 'timeNow' };

        await writeDocument(root, broken);

        expect(() => createRuntime({ root })).toThrow(/toolSettings.disabled must be an array of strings/);
    });
});

// A hook bus is asserted once to prove this suite's probe harness is a real harness (its
// bus exists and its registrations are the framework's, not a stub), which is what makes
// the declaration assertions above an observation of the production path.
describe('the probe harness is built on the real hook bus', () => {
    it('constructs a bus whose dispatch the framework owns', () => {
        const bus = createHookBus();
        const seen: string[] = [];

        bus.on('run.started', () => seen.push('ran'), { owner: 'probe' });
        bus.fire('run.started', { agent: 'probe', depth: 0, input: 'x' });

        expect(seen).toEqual(['ran']);
    });
});
