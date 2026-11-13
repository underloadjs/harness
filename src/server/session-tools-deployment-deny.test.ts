// F2-1 — the deployment-wide tool deny × the SESSION toolbox rows.
//
// WHY THIS FILE EXISTS: the published contract (`SessionToolSummary.enabled`,
// ../shared/harness-api.ts, generated from ./harness.swagger.yaml) promised that a session this
// server created NEW answers `true` for "every row that is switchable at all". A name the
// OPERATOR has switched off deployment-wide (`PATCH /v1/harness/tools/{tool_id}`) is still
// switchable by this session, so the promise was read as falsified: after denying `shell`, a
// brand-new session reports `shell` = `enabled: false, protected: false, origin: 'catalogue'`.
// The prose now states its real scope — every row the harness CAN switch AND that this deployment
// has not disabled — and the pins below are the behaviour that prose describes. Nothing here
// changes authority: BOTH directions are pinned, because both are deliberate.
//
// WHAT IS PINNED, exactly:
//   1. FRESH SESSION UNDER A DENY — the denied row reports `enabled: false` / `protected: false`
//      / `origin: 'catalogue'` (the seed filtered the deny list out before the pass,
//      ../harness.ts `seedSwitchableTools`), while every other switchable row keeps its seeded
//      slot. T6 states the enabled figure as the call axis, so the count is 31 of 32 rows and not
//      21 of 32: the ten names that hold no cap slot are `true` through their declaration list, and
//      the one false row is the denied name; the GLOBAL row for the same name states the
//      deployment's answer (`enabled: false`), which is the read a client uses for that figure;
//   2. NO SESSION ROW FIELD STATES THE DENIAL — the two figures a session row does carry for a
//      denied name are unrelated facts: `availability` is a CREDENTIAL gate the catalogue states
//      (absent entirely for `shell`), and `source_available` is the editable-source gate (true).
//      A new wire field is a contract decision, so this pin records what exists rather than
//      inventing one;
//   3. THE SESSION LIFT — `PATCH /sessions/{id}/tools/shell {enabled:true}` answers 200 and
//      persists across a restart (this session's membership is its own), YET the name stays
//      withheld from the model: the declaration filter hides it, `toolRequest` answers the
//      operator sentence under `forbidden`, and a model that GUESSES the name is refused by the
//      launch gate with a tool RESULT. A ticked row is therefore not a capability promise;
//   4. MID-LIFE DENY — an EXISTING session keeps its own enabled figure (the deny does not
//      rewrite rows), while its very next request stops offering the name.
//
// Cross-references:
//   - ../harness.ts                  — `isToolGloballyDisabled` (:1542), `seedSwitchableTools`,
//                                      the declaration filter (:4579), the launch gate (:7852)
//   - ./api-reads.ts                 — `sessionToolRowsOf` (`enabled`/`protected`/`origin`)
//   - ./api.ts                       — `patchTool` (the global route), `setSessionToolEnabled`
//   - ./tool-settings.ts             — the deployment deny list behind both routes
//   - ./harness.swagger.yaml         — the prose this file is the behaviour half of
//   - ./session-reset-toolbox.test.ts — the same seed scope on the reset path (F2-2)
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agent, harness } from '../harness';
import type { HarnessPreset, HarnessStreamEvent, HarnessStreamRequest } from '../harness';
import type { RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { SHARED_TOOL_NAMES, createToolboxHarness } from './harnesses/toolbox';
import { HARNESS_DATABASE_FILE, HarnessPersistence } from './persistence';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { SessionStore } from './sessions';

const ROOT = path.join(process.cwd(), 'Temp', 'deny-rows');

const SETTINGS: RunnerSettings = {
    baseURL: 'http://deny.invalid/v1',
    apiKey: 'server-secret-value',
    model: 'scripted/first'
};

const API_DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

const MOUNT = '/v1/harness';

// The exact seed a keyless host gets with NOTHING denied — the population
// ./api-session-tool-writes.test.ts pins, minus nothing. Every assertion below is stated
// against this list so a seed that silently changes shape cannot pass by accident.
const SEEDED_NAMES = [
    'toolRegistry',
    'toolList',
    'toolManage',
    'toolCreate',
    'records',
    'profiles',
    'chapters',
    'locations',
    'agentManage',
    'agentResult',
    'threadFork',
    'actionRequest',
    'syntax',
    'files',
    'shell',
    'gitDiff',
    'download',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize'
];

// The ten names that hold NO `maxEnabledTools` slot. Since T6 the session row's `enabled` is the
// CALL AXIS, not this capped list: these ten answer `true` through their declaration list, so the
// enabled figure below is 31 of 32 rows with `shell` denied, not 21 of 32. `shell` is one of the
// capped names, which is exactly why the deny is visible on it and invisible on a core row.
const SLOTLESS_NAMES = ['toolRequest', 'tasks', 'delegate', 'toolCancel', 'read', 'write', 'edit', 'glob', 'grep', 'fetch'];

// All 32 rows in the server's own order (`SEEDED_NAMES` interleaved with `SLOTLESS_NAMES`), so the
// enabled figure cannot be satisfied by a reordered or partially populated list.
const ROW_ORDER = [
    'toolRegistry',
    'toolRequest',
    'toolList',
    'toolManage',
    'toolCreate',
    'records',
    'tasks',
    'profiles',
    'chapters',
    'locations',
    'agentManage',
    'agentResult',
    'delegate',
    'threadFork',
    'actionRequest',
    'toolCancel',
    'syntax',
    'read',
    'write',
    'edit',
    'files',
    'glob',
    'grep',
    'shell',
    'gitDiff',
    'download',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize',
    'fetch'
];

// The two sentences the kernel owns for a denied name: the launch gate's tool RESULT, and the
// `toolRequest` `forbidden` reason (../harness.ts `globalDisableReason` /
// `globalDisableDiscoveryReason`). One place, and this file is the pin that they are the SAME
// reason the row's tick does not contradict.
const DENIED_RESULT = 'Tool "shell" is disabled on this server by the operator.';
const DENIED_DISCOVERY = `${DENIED_RESULT} Requesting it again will not change this answer — adapt to the available tools or report the limitation.`;

// One scripted brain, plus the two observations this file needs:
//   - `seen` captures every model request, whose `tools` array IS `declared()` — the only way to
//     read "what the model was SHOWN" from outside the kernel;
//   - `script` is a queue of turn frames, so a test can make the model GUESS a denied name.
const scriptedBrain = (
    name: string,
    script: HarnessStreamEvent[][],
    seen: HarnessStreamRequest[]
): ReturnType<typeof agent> =>
    agent({
        model: SETTINGS.model,
        instruction: `Scripted deny-fixture brain (${name}).`,
        stream: async function* (request): AsyncGenerator<HarnessStreamEvent> {
            seen.push(request);

            const frames = script.shift() ?? [
                { type: 'text', delta: 'ok' },
                { type: 'done', stopReason: 'stop', toolCalls: [] }
            ];

            for (const frame of frames) yield frame;
        }
    });

// The shipped card: the shared toolbox plus a team, so `delegate` registers and the row
// population is the production one (see ./api-session-tool-writes.test.ts for the same fixture).
const toolboxPreset = (script: HarnessStreamEvent[][], seen: HarnessStreamRequest[]): HarnessPreset => ({
    name: 'toolbox',
    title: 'Toolbox',
    description: 'Shared-toolbox fixture for the deployment-deny rows, scripted model.',
    requiresEndpoint: false,
    primary: 'boss',
    subagents: ['helper'],
    agents: ['boss', 'helper'],
    tools: SHARED_TOOL_NAMES,
    environmentTools: ['search', 'fetch'],
    builtin: false,
    editable: true,
    create: (settings, progress, report) =>
        createToolboxHarness(
            {
                agents: {
                    boss: scriptedBrain('boss', script, seen),
                    helper: scriptedBrain('helper', [], seen)
                },
                primary: 'boss',
                subagents: ['helper']
            },
            settings,
            progress,
            // Forwarded UNMODIFIED, exactly as a shipped card receives it, so the store's
            // per-build `enableAllTools` and its live `toolSettings` provider both land.
            report
        )
});

// `search` registers only behind a provider key, which would make the row population depend on
// the developer's .env. `fetch` is keyless and always registers.
const stubKeylessSearch = (): void => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('LINKUP_API_KEY', '');
};

afterEach(() => {
    vi.unstubAllEnvs();
});

const tempRoot = (label: string): string => {
    const root = path.join(ROOT, `${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

    fs.mkdirSync(root, { recursive: true });

    return root;
};

const stateFile = (root: string): string => path.join(root, 'harness', HARNESS_DATABASE_FILE);

const readDocument = (root: string): Record<string, any> =>
    fs.existsSync(stateFile(root))
        ? (JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>)
        : {};

const openPair = (root: string, database?: Record<string, unknown>, script: HarnessStreamEvent[][] = [], seen: HarnessStreamRequest[] = []) => {
    const registry = createHarnessRegistry([toolboxPreset(script, seen)]);
    const store = new SessionStore(SETTINGS, registry, undefined, {
        persistence: new HarnessPersistence(root),
        ...(database === undefined ? {} : { database: database as never })
    });
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry, databaseRoot: root });

    return { store, registry, api };
};

const call = async (
    api: ReturnType<typeof openPair>['api'],
    method: string,
    rawPathname: string,
    body: unknown = {}
): Promise<{ status: number; body: Record<string, any> }> => {
    const [pathname, query] = rawPathname.split('?');
    const result = (await api({
        method,
        pathname: pathname!,
        mount: MOUNT,
        ...(query === undefined ? {} : { searchParams: new URLSearchParams(query) }),
        readBody: async () => body
    } as unknown as HarnessApiRequest)) as HarnessApiResult;

    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any> };
};

const sessionOf = async (api: ReturnType<typeof openPair>['api']): Promise<string> => {
    const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'toolbox' });

    expect(created.status).toBe(201);

    return created.body.session.id as string;
};

const rowsOf = async (api: ReturnType<typeof openPair>['api'], sessionId: string): Promise<Record<string, any>[]> => {
    const page = await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools?limit=100`);

    expect(page.status).toBe(200);

    return page.body.items as Record<string, any>[];
};

const rowNamed = (rows: Record<string, any>[], name: string): Record<string, any> => {
    const row = rows.find((candidate) => candidate.name === name);

    if (row === undefined) throw new Error(`no row named "${name}"`);

    return row;
};

const namesWhere = (rows: Record<string, any>[], predicate: (row: Record<string, any>) => boolean): string[] =>
    rows.filter(predicate).map((row) => row.name as string);

// The names one model request was GIVEN. `declared()` is invisible from outside the kernel, and
// this array is its projection — the same observation ./harness.tool-settings.test.ts uses.
const offeredNames = (request: HarnessStreamRequest | undefined): string[] =>
    ((request?.tools ?? []) as { name?: string }[]).map((tool) => tool.name ?? '').filter((name) => name.length > 0);

// Every tool RESULT this session's conversations hold, newest last. The launch gate answers a
// guessed call with a readable result rather than a failed run, so the sentence has to be read
// out of the transcript.
const toolResultsOf = (record: ReturnType<SessionStore['liveSession']>): string[] =>
    record.harness.threads().flatMap((thread) =>
        (record.harness.threadMessages(thread.id) as { role?: string; content?: unknown }[])
            .filter((message) => message.role === 'tool')
            .map((message) => String(message.content ?? ''))
    );

describe('a brand-new session under a deployment-wide deny', () => {
    it('leaves the denied row off and switchable, and states the denial on the global row instead', async () => {
        stubKeylessSearch();
        const { api } = openPair(tempRoot('fresh-denied'));

        // The deny lands BEFORE the session exists, so it is in force for the seed pass.
        const deny = await call(api, 'PATCH', `${MOUNT}/tools/shell`, { enabled: false });

        expect(deny.status).toBe(200);

        const sessionId = await sessionOf(api);
        const rows = await rowsOf(api, sessionId);
        const shell = rowNamed(rows, 'shell');

        // The row: off, but NOT protected — this conversation could switch it itself. `catalogue`
        // is what a name that is neither declared nor enabled reports.
        expect({
            enabled: shell.enabled,
            protected: shell.protected,
            origin: shell.origin,
            declared: shell.declared,
            visibility: shell.visibility
        }).toEqual({ enabled: false, protected: false, origin: 'catalogue', declared: false, visibility: 'searchable' });

        // F2-1's other half: NOTHING on this row says "withheld by the deployment".
        // `availability` is the catalogue's credential gate, and `shell` has none at all;
        // `source_available` is the editable-source gate, and it is true here.
        expect('availability' in shell).toBe(false);
        expect(shell.source_available).toBe(true);

        // Every OTHER switchable row keeps its seeded slot, so the deny removed exactly one name —
        // and the ten rows with no slot are on anyway, through their declaration list. T6 states the
        // figure as the call axis (31 of 32), where the pre-T6 cap figure read 21 of 32.
        expect(namesWhere(rows, (row) => row.enabled)).toEqual(ROW_ORDER.filter((name) => name !== 'shell'));
        expect(namesWhere(rows, (row) => !row.enabled)).toEqual(['shell']);
        expect(namesWhere(rows, (row) => SLOTLESS_NAMES.includes(row.name as string) && row.enabled)).toEqual(SLOTLESS_NAMES);
        // Stated the other way round, against the capped list this file seeds: every name that holds
        // a slot is on except the denied one, so the deny is a one-name removal and nothing else.
        expect(namesWhere(rows, (row) => row.enabled && SEEDED_NAMES.includes(row.name as string))).toEqual(
            SEEDED_NAMES.filter((name) => name !== 'shell')
        );

        // The deployment's answer is stated where the deployment is the subject: the global row.
        const globalRow = (await call(api, 'GET', `${MOUNT}/tools/shell`)).body.tool as Record<string, any>;

        expect({ name: globalRow.name, enabled: globalRow.enabled, visibility: globalRow.visibility }).toEqual({
            name: 'shell',
            enabled: false,
            visibility: 'searchable'
        });
        expect('availability' in globalRow).toBe(false);
    });
});

describe('the session-scoped lift of a name the deployment denies', () => {
    it('accepts and persists the lift, while discovery, the declarations and the launch gate keep refusing it', async () => {
        stubKeylessSearch();
        const script: HarnessStreamEvent[][] = [];
        const seen: HarnessStreamRequest[] = [];
        const root = tempRoot('lift');
        const { api, store } = openPair(root, undefined, script, seen);

        await call(api, 'PATCH', `${MOUNT}/tools/shell`, { enabled: false });

        const sessionId = await sessionOf(api);

        expect(rowNamed(await rowsOf(api, sessionId), 'shell').enabled).toBe(false);

        // The session's own membership is its own: the lift is accepted, with no warning and no
        // refusal, because a `protected` row is the kernel's answer and this is not one.
        const lift = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/shell`, { enabled: true });

        expect(lift.status).toBe(200);

        const lifted = rowNamed(await rowsOf(api, sessionId), 'shell');

        expect({ enabled: lifted.enabled, protected: lifted.protected, origin: lifted.origin }).toEqual({
            enabled: true,
            protected: false,
            origin: 'discovered'
        });

        // Discovery keeps reporting the truth the row cannot: an explicit `toolRequest` for the
        // name comes back `forbidden`, and nothing about it is written to any enabled set.
        const discovery = (await store
            .liveSession(sessionId)
            .harness.runtime.requestTools(undefined, { names: ['shell'] })) as Record<string, any>;

        expect(discovery).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [{ name: 'shell', reason: DENIED_DISCOVERY, allowed: [] }]
        });

        // A REAL turn, with a model that GUESSES the name anyway (the state the tick tempts a
        // caller into): the name is not in the request's declarations, and the launch gate
        // answers the call with the operator sentence as a tool RESULT.
        script.push(
            [{ type: 'done', stopReason: 'tool_calls', toolCalls: [{ id: 'call-1', name: 'shell', arguments: '{"command":"ls"}' }] }],
            [{ type: 'text', delta: 'after' }, { type: 'done', stopReason: 'stop', toolCalls: [] }]
        );

        await store.run(sessionId, 'try shell', () => {});

        expect(offeredNames(seen[0]).includes('shell')).toBe(false);
        expect(offeredNames(seen[0]).includes('files')).toBe(true);
        expect(toolResultsOf(store.liveSession(sessionId))).toEqual([DENIED_RESULT]);

        // And the lift is durable: the session's committed enabled set carries the name across a
        // restart, deny or no deny — the deployment does not rewrite a conversation's rows.
        const document = readDocument(root);

        expect((document.sessions[0].core.discovery.enabled as string[]).includes('shell')).toBe(true);

        const reopened = openPair(root, document, script, seen);
        const afterRestart = rowNamed(await rowsOf(reopened.api, sessionId), 'shell');

        expect({ enabled: afterRestart.enabled, origin: afterRestart.origin }).toEqual({ enabled: true, origin: 'discovered' });
    });
});

describe('a deny that lands while a session already holds the name enabled', () => {
    it('rewrites no session row, and still withdraws the name from the model', async () => {
        stubKeylessSearch();
        const script: HarnessStreamEvent[][] = [];
        const seen: HarnessStreamRequest[] = [];
        const { api, store } = openPair(tempRoot('mid-life'), undefined, script, seen);
        const sessionId = await sessionOf(api);

        // The seeded baseline: enabled, discovered, clickable.
        expect(rowNamed(await rowsOf(api, sessionId), 'shell')).toMatchObject({ enabled: true, protected: false, origin: 'discovered' });

        await store.run(sessionId, 'before the deny', () => {});

        const before = offeredNames(seen[seen.length - 1]);

        expect(before.includes('shell')).toBe(true);

        const deny = await call(api, 'PATCH', `${MOUNT}/tools/shell`, { enabled: false });

        expect(deny.status).toBe(200);

        const after = rowNamed(await rowsOf(api, sessionId), 'shell');

        // AUTHORITY, first direction: the session's own membership survives untouched. No row
        // field moves, so a client that wants the deployment's figure reads the global row.
        expect({ enabled: after.enabled, protected: after.protected, origin: after.origin }).toEqual({
            enabled: true,
            protected: false,
            origin: 'discovered'
        });
        expect((await call(api, 'GET', `${MOUNT}/tools/shell`)).body.tool.enabled).toBe(false);

        // AUTHORITY, second direction: that tick grants nothing. The next request's declarations
        // drop exactly one name, and guessing it is refused.
        await store.run(sessionId, 'after the deny', () => {});

        const next = offeredNames(seen[seen.length - 1]);

        expect(before.filter((name) => !next.includes(name))).toEqual(['shell']);
        expect(next.filter((name) => !before.includes(name))).toEqual([]);

        const discovery = (await store
            .liveSession(sessionId)
            .harness.runtime.requestTools(undefined, { names: ['shell'] })) as Record<string, any>;

        expect(discovery.forbidden).toEqual([{ name: 'shell', reason: DENIED_DISCOVERY, allowed: [] }]);
    });
});
