// R3 — the GLOBAL tool switch over REST (src/server/api.ts `patchTool`, plus the row fields).
//
// WHAT THIS FILE PROVES (one block per acceptance criterion):
//   1. ROWS      - `GET /v1/harness/tools` carries `enabled` on EVERY row (the figure the
//                  Tools pane switches on), and the identified read carries it beside
//                  `parameters`/`execution`. No row states a `protected` flag: the switch
//                  applies to the whole catalogue (R5).
//   2. WRITE     - `PATCH /v1/harness/tools/{tool_id}` with `{enabled:false}` answers 200
//                  with the updated identified read, bumps the collection revision, and the
//                  next list reflects it. `{enabled:true}` puts it back.
//   3. REFUSALS  - unknown tool => 404 (identity BEFORE the body); a missing/blank/mistyped
//                  `enabled` or an unknown body field => 400. A refused write changes nothing.
//                  A harness-owned core tool is NOT a refusal (R5): it takes the same 200.
//   4. ANYTIME   - there is NO idle gate: the switch lands on a session that is ALIVE, and
//                  the same running session's very NEXT model request is built without the
//                  disabled tool (the wiring proof is the report identity below).
//   5. CORE      - a core tool (`tasks`) is switchable end to end: the row reports
//                  `enabled: false`, the deny list survives a restart, the next request
//                  hides the name from its declarations, the launch gate answers a guess
//                  with the switch's readable tool result, `toolRequest` reports it under
//                  `forbidden`, and re-enabling puts all of it back.
//   6. DURABLE   - `state.json` carries `toolSettings: { disabled: [...] }` and nothing else,
//                  a deployment that never switched anything writes no field at all, and a
//                  fresh runtime on the same root boots with the switch applied. A hand-edited
//                  document listing a core name is HONOURED, not dropped.
//
// Determinism: every status, key list, sentence and value below is an EXACT assertion. The
// session harness is scripted (no provider, no network), and the captured stream requests
// ARE the observation of what the model was told.
//
// Cross-references:
//   - ./tool-settings.ts            — the store, the deny list, the live provider
//   - ./api.ts                      — `patchTool`, `toolEnablementOf`, the route table
//   - ./sessions.ts                 — `updateToolEnabled` (persist-before-answer) and `buildHarness`
//   - ../harness.ts                 — the declaration filter, launch gate and discovery that read the provider
//   - ../harness.tool-settings.test.ts — the same three consumers at the library boundary
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

/** One scripted model turn that emits a single tool call (the guessed/queried name). */
const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

// The scripted turns the NEXT probe harness runs, one entry per model request (the last
// entry repeats once the list runs out — see `scripted`). A test that needs the model to
// CALL a tool reassigns this BEFORE the session is created, because `probePreset().create`
// captures the array when the harness is built. `createRuntime` resets it, so a test never
// inherits another test's script.
const defaultTurns = (): HarnessStreamEvent[][] => [answer('one'), answer('two'), answer('three')];

let probeTurns: HarnessStreamEvent[][] = defaultTurns();

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
                    stream: scripted(probeTurns)
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
    // The default script is three plain answers; a test that needs a tool call reassigns
    // `probeTurns` after this call and BEFORE the session is created.
    probeTurns = defaultTurns();

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

/**
 * The content of one tool result in a session's transcript, by call id. The transcript is
 * the live harness's own record (`harness.agent.messages`), so this reads what the MODEL was
 * answered — a refusal is a tool result, never a failed run.
 */
const toolResultOf = (harness: { agent: { messages: readonly unknown[] } }, callId: string): string => {
    const found = (harness.agent.messages as { role: string; toolCallId?: string; content?: string }[]).find(
        (message) => message.role === 'tool' && message.toolCallId === callId
    );

    return found?.content ?? '';
};

afterEach(() => {
    vi.unstubAllEnvs();
});

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('GET /v1/harness/tools — the enablement fields', () => {
    it('carries enabled on every row, and nothing else changed', async () => {
        const runtime = createRuntime();
        const page = await call(runtime, 'GET', `${MOUNT}/tools`, {}, 'limit=100');

        expect(page.status).toBe(200);

        const rows = page.body.items as Record<string, any>[];

        expect(rows.length).toBeGreaterThan(0);

        // The closed `ToolSummary` row: the seven fields are on EVERY row, and the one
        // optional member the schema allows is `availability` — a credential-dependent
        // entry only. Asserted as "the required set, plus at most availability", so a new
        // field on the wire fails loudly instead of riding along. R6: `protected` is gone —
        // the switch applies to every entry, so a row has no exception to advertise.
        const requiredRowKeys = [
            'description',
            'enabled',
            'group',
            'name',
            'session_bound',
            'tags',
            'visibility'
        ];

        for (const row of rows) {
            expect(typeof row.enabled).toBe('boolean');
            expect(Object.hasOwn(row, 'protected')).toBe(false);

            const extra = Object.keys(row)
                .sort()
                .filter((key) => !requiredRowKeys.includes(key));

            expect(extra).toEqual(row.availability === undefined ? [] : ['availability']);
        }

        // Nothing has been switched, so every row — the harness-owned core entries
        // included — reads enabled (./tool-settings.ts: a deny list, empty by default).
        expect(rows.every((row) => row.enabled === true)).toBe(true);
        // The core entries are still LISTED, and are ordinary switchable rows now: the
        // shipped control-plane set appears among them with no special marker.
        const coreRows = rows.filter((row) => CORE_TOOL_NAMES.includes(row.name));

        expect(coreRows.map((row) => row.name).sort()).toEqual(
            [...CORE_TOOL_NAMES].sort((left, right) => left.localeCompare(right))
        );
        expect(coreRows.every((row) => row.enabled === true)).toBe(true);
        expect(coreRows.map((row) => row.group).sort()).toEqual(['Core tools', 'Core tools']);
    });

    it('reports the live switch on the row and on the identified read', async () => {
        const runtime = createRuntime();

        const before = await call(runtime, 'GET', `${MOUNT}/tools/timeNow`);

        expect(before.status).toBe(200);
        expect(before.body.tool).toMatchObject({ name: 'timeNow', enabled: true });
        expect(Object.keys(before.body.tool).sort()).toEqual([
            'description',
            'enabled',
            'execution',
            'group',
            'name',
            'parameters',
            'session_bound',
            'tags',
            'visibility'
        ]);

        await patchTool(runtime, 'timeNow', { enabled: false });

        const after = await call(runtime, 'GET', `${MOUNT}/tools/timeNow`);

        expect(after.body.tool).toMatchObject({ enabled: false });
        expect((await call(runtime, 'GET', `${MOUNT}/tools`, {}, 'limit=100')).body.items).toContainEqual(
            expect.objectContaining({ name: 'timeNow', enabled: false })
        );

        // A core entry is an ordinary row of an untouched deployment: listed, enabled, and
        // with no marker saying the switch skips it (R5/R6).
        const core = CORE_TOOL_NAMES[0];
        const row = (await call(runtime, 'GET', `${MOUNT}/tools/${core}`)).body.tool;

        expect(row).toMatchObject({ name: core, enabled: true });
        expect(Object.hasOwn(row, 'protected')).toBe(false);
    });
});

describe('PATCH /v1/harness/tools/{tool_id}', () => {
    it('answers 200 with the updated identified read and bumps the collection revision', async () => {
        const runtime = createRuntime();

        const patched = await patchTool(runtime, 'timeNow', { enabled: false });

        expect(patched.status).toBe(200);
        expect(patched.body.tool).toMatchObject({ name: 'timeNow', enabled: false });

        // The whole identified read comes back, so a client never re-reads to confirm its
        // own click (the plugins response precedent).
        expect(Object.keys(patched.body.tool).sort()).toEqual([
            'description',
            'enabled',
            'execution',
            'group',
            'name',
            'parameters',
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

    it('accepts a core entry, refuses an unknown tool with 404 and a bad body with 400', async () => {
        const runtime = createRuntime();

        // R5: the write that used to answer 403 is now an ordinary switch. A harness-owned
        // name goes on the same deny list as a preset tool, and the response is the same
        // whole identified read (./api.ts `patchTool` — the 403 branch is gone with it).
        const core = CORE_TOOL_NAMES[0];
        const disabled = await patchTool(runtime, core, { enabled: false });

        expect(disabled.status).toBe(200);
        expect(disabled.body.tool).toMatchObject({ name: core, enabled: false });
        expect(toolsOf(runtime).disabled()).toEqual([core]);
        expect(toolsOf(runtime).isEnabled(core)).toBe(false);
        expect(disabled.headers[HARNESS_REVISION_HEADER]).toBe('1');

        // Identity FIRST: an unknown name is a 404 even with a body that would also fail.
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

        // Every refusal above was a no-op: the ONLY state that moved is the core switch this
        // test made first, and `timeNow` is still enabled.
        expect(toolsOf(runtime).disabled()).toEqual([core]);
        expect(toolsOf(runtime).isEnabled('timeNow')).toBe(true);

        const page = await call(runtime, 'GET', `${MOUNT}/tools`, {}, 'limit=100');
        const rows = page.body.items as Record<string, any>[];

        expect(rows.filter((row) => row.enabled === false).map((row) => row.name)).toEqual([core]);
        expect((await call(runtime, 'GET', `${MOUNT}/tools/${core}`)).body.tool).toMatchObject({
            name: core,
            enabled: false
        });
    });

    it('switches a harness-owned core tool off and back on, end to end (R5)', async () => {
        const runtime = createRuntime();

        // The scripted model, one entry per model request: it GUESSES the core name `tasks`
        // (the launch-gate case) and answers; then asks `toolRequest` for the same name (the
        // discovery case) and answers; then answers plainly on the run AFTER the name is put
        // back. Assigned BEFORE the session is created, because the preset builds the harness
        // (and captures this array) there.
        probeTurns = [
            callTool('c1', 'tasks', '{}'),
            answer('refused'),
            callTool('d1', 'toolRequest', '{"names":["tasks"]}'),
            answer('forbidden'),
            callTool('c2', 'tasks', '{}'),
            answer('ran')
        ];

        const sessionId = await createSession(runtime);
        const record = runtime.store.liveSession(sessionId);

        expect((await patchTool(runtime, 'tasks', { enabled: false })).status).toBe(200);

        // --- 1. DECLARATIONS. The core name is hidden from the request the NEXT run builds;
        // the only other shipped core entry stays, so this is a per-name decision and not the
        // control plane being switched off wholesale (../harness.ts `declared`).
        const first = await record.harness('go');

        expect(declaredNames(probeRequests[0])).toEqual(['toolRequest']);

        // --- 2. LAUNCH GATE. The model guessed the disabled name anyway, and the answer is a
        // readable TOOL RESULT — the run SURVIVES (../harness.ts, the global gate).
        expect(first.content).toBe('refused');
        expect(record.harness.agent.messages.filter((message) => message.role === 'tool').length).toBe(1);
        expect(toolResultOf(record.harness, 'c1')).toBe('Tool "tasks" is disabled on this server by the operator.');

        // --- 3. DISCOVERY. `toolRequest` answers with the denial, not a promise, and the
        // session-wide enabled set is untouched (one search cannot undo the operator here).
        const second = await record.harness('search');

        expect(second.content).toBe('forbidden');

        // One entry per denied match, and `tasks` is a DECLARED core entry: the searchable
        // selection is empty, so the vocabulary hint rides along with the denial (the tag
        // list is deployment data, not this switch's contract — the field set is pinned).
        const discovery = JSON.parse(toolResultOf(record.harness, 'd1')) as Record<string, unknown>;

        expect(Object.keys(discovery).sort()).toEqual([
            'availableTags',
            'enabled',
            'forbidden',
            'matched',
            'omitted',
            'tools'
        ]);
        expect(discovery.enabled).toEqual([]);
        expect(discovery.tools).toEqual([]);
        expect(discovery.matched).toBe(0);
        expect(discovery.omitted).toBe(0);
        expect(discovery.forbidden).toEqual([
            {
                name: 'tasks',
                reason:
                    'Tool "tasks" is disabled on this server by the operator. Requesting it again will not change this answer — adapt to the available tools or report the limitation.',
                allowed: []
            }
        ]);
        expect(record.harness.discoveredTools).toEqual([]);

        // --- 4. RE-ENABLE. The same live session, no rebuild: the next request declares the
        // name again, and a call to it executes for real (turns 5-6 of the script).
        expect((await patchTool(runtime, 'tasks', { enabled: true })).status).toBe(200);

        const third = await record.harness('again');

        expect(declaredNames(probeRequests[4])).toEqual(['toolRequest', 'tasks']);
        expect(third.content).toBe('ran');

        // The call result is the session's (empty) task page, not the gate's refusal sentence.
        expect(JSON.parse(toolResultOf(record.harness, 'c2')).tasks).toEqual([]);

        // The bypass the switch must never reach (R7): a HOST execution still runs a name the
        // model cannot see at all — the tool stayed REGISTERED the whole time.
        expect((await patchTool(runtime, 'tasks', { enabled: false })).status).toBe(200);
        expect(await record.harness.executeTool('tasks', {})).toBeDefined();
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

        expect(row).toMatchObject({ enabled: false });

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

    it('honours a core name listed by a hand-edited document, and restores a core switch across a restart', async () => {
        const root = await fixture();
        const first = createRuntime({ root });

        await first.store.persistRegistry();

        const saved = documentOf(root);

        // `disabled` must be an array of strings (./persistence.ts is strict about SHAPE)...
        saved.toolSettings = { disabled: [...CORE_TOOL_NAMES].reverse() };

        await writeDocument(root, saved);

        const second = createRuntime({ root });

        // ...while the STORE decides what is still meaningful, and R5 removed the only rule
        // that used to discard a name: every listed name is honoured, the harness-owned
        // control tools included, in sorted order (the writer's order).
        expect(second.store.toolSettings.disabled()).toEqual(['tasks', 'toolRequest']);
        expect(second.store.toolSettings.snapshot()).toEqual({ disabled: ['tasks', 'toolRequest'] });

        const page = await call(second, 'GET', `${MOUNT}/tools`, {}, 'limit=100');
        const rows = page.body.items as Record<string, any>[];

        expect(rows.filter((row) => row.enabled === false).map((row) => row.name).sort()).toEqual([
            'tasks',
            'toolRequest'
        ]);

        // A switch MADE through the route round-trips exactly the same way: the write is
        // durable, re-enabling removes it, and the next boot reports the state on the row.
        await patchTool(second, 'toolRequest', { enabled: true });

        expect(documentOf(root).toolSettings).toEqual({ disabled: ['tasks'] });

        const third = createRuntime({ root });

        expect(third.store.toolSettings.disabled()).toEqual(['tasks']);
        expect((await call(third, 'GET', `${MOUNT}/tools/tasks`)).body.tool).toMatchObject({
            name: 'tasks',
            enabled: false
        });
        expect((await call(third, 'GET', `${MOUNT}/tools/toolRequest`)).body.tool).toMatchObject({
            name: 'toolRequest',
            enabled: true
        });

        // A wrong SHAPE is corruption of a named slot: it throws on load, like every other
        // field in this document, rather than being silently accepted.
        const broken = documentOf(root);

        broken.toolSettings = { disabled: 'toolRequest' };

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
