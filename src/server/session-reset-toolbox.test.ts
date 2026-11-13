// F2-2 — a session RESET starts the conversation with the toolbox a NEW session gets.
//
// WHY THIS FILE EXISTS: the kernel's `reset()` empties the enabled set (../harness.ts, and
// README's `reset()` row; src/types/index.ts `discoveredTools` says so too) and the construction
// seed is not snapshot state, so after a reset the pane showed 0 on / 22 off-but-clickable rows —
// byte-for-byte the brand-new harness the report objected to, one reset later. The server's
// session-reset path now re-applies the SAME seed a CREATE passes (`./sessions.ts` `reset`, through
// the kernel's one-pass `Harness.enableAllSwitchableTools`), so a reset conversation and a fresh
// one are the same state instead of two different ones.
//
// WHAT IS PINNED, exactly:
//   1. rows after `POST /sessions/{id}/reset` == rows after `POST /sessions` — every field of
//      every row, name by name, in server order (`enabled`, `protected`, `origin`, `declared`);
//   2. a toolbox the conversation switched OFF comes back on a reset, and the re-seed is DURABLE
//      (the session document's `discovery.enabled` carries it, so a restart keeps it);
//   3. the re-seed keeps the seed's SCOPE: a name the deployment denies stays off after a reset,
//      exactly as it stays off in a session created under the same deny;
//   4. THE RESTART CASE (the regression this file used to miss): the same reset, issued after the
//      server restarted, answers the SAME toolbox. The seam is gated on a per-process
//      `HarnessConfiguration`, so an unseeded RESTORE build disarmed it and
//      `create → restart → reset` returned 0 enabled where `create → reset` returned 22. The
//      store now asks for the seed on both build paths (`./sessions.ts:2204` create, `:3843`
//      restore) — pinned row-for-row, and pinned as durable in the persisted document;
//   5. the RESTORE itself is still a no-refill, which is what makes (4) safe: the restore-path
//      seed is overwritten by `harness.restore()` (`../harness.ts:11676` replaces the enabled
//      set), so a session that switched names off — even ALL of them — comes back with exactly
//      the set it committed, in the rows AND in the document the restarted process writes;
//   6. a preset whose factory DROPS the store's report (a scripted fixture, a library handle, the
//      CLI) stays an empty toolbox through create, reset, and restart-then-reset: the gate above
//      is what keeps `reset` and `create` two names for ONE posture, and it is not removed.
//
// Cross-references:
//   - ./sessions.ts                  — `create` (`:2204`, the seed), `restoreSession` (`:3843`,
//                                      the seed that restore then overwrites), `reset`
//                                      (the re-seed at `:10204`)
//   - ../harness.ts                  — `seedSwitchableTools` (`:12046-12063`),
//                                      `enableAllSwitchableTools` (`:12663-12674`, gated on
//                                      `configuration.enableAllTools`), `reset`, and the
//                                      `restore()` overwrite at `:11676`
//   - ../types/index.ts              — `HarnessConfiguration.enableAllTools`,
//                                      `Harness.enableAllSwitchableTools`
//   - ./harness.swagger.yaml         — `SessionToolSummary.enabled` (the promise's wording)
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agent, harness } from '../harness';
import type { HarnessPreset, HarnessSnapshot, HarnessStreamEvent } from '../harness';
import type { RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { SHARED_TOOL_NAMES, createToolboxHarness } from './harnesses/toolbox';
import { HARNESS_DATABASE_FILE, HarnessPersistence } from './persistence';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { SessionStore } from './sessions';

const ROOT = path.join(process.cwd(), 'Temp', 'reset-toolbox');

const SETTINGS: RunnerSettings = {
    baseURL: 'http://reset.invalid/v1',
    apiKey: 'server-secret-value',
    model: 'scripted/first'
};

const API_DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

const MOUNT = '/v1/harness';

// The seeded set for a keyless host: every name the kernel can switch. Stated as exact names so
// "the reset re-applied the seed" cannot be satisfied by a partial refill.
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

// The complement, in server row order: the ten names the kernel will not let this conversation
// switch (`!isToolSwitchable`), so a row for each is `protected` and stays `enabled: false` in
// every posture — seeded or not. Listed exactly because "0 enabled" only means what it claims if
// the protected half is still the same ten.
const PROTECTED_NAMES = ['toolRequest', 'tasks', 'delegate', 'toolCancel', 'read', 'write', 'edit', 'glob', 'grep', 'fetch'];

const scriptedBrain = (name: string): ReturnType<typeof agent> =>    agent({
        model: SETTINGS.model,
        instruction: `Scripted reset-fixture brain (${name}).`,
        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
            yield { type: 'text', delta: 'ok' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        }
    });

const toolboxPreset = (): HarnessPreset => ({
    name: 'toolbox',
    title: 'Toolbox',
    description: 'Shared-toolbox fixture for the reset toolbox, scripted model.',
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
            { agents: { boss: scriptedBrain('boss'), helper: scriptedBrain('helper') }, primary: 'boss', subagents: ['helper'] },
            settings,
            progress,
            // Forwarded UNMODIFIED, so the store's per-build `enableAllTools` reaches
            // `HarnessConfiguration` on BOTH store build paths (./sessions.ts `:2204` create,
            // `:3843` restore). That is what lets the reset re-seam fire after a restart; the
            // restore's own enabled set still comes from the committed snapshot.
            report
        )
});

// THE NON-SEEDED POSTURE: the same toolbox by a factory that WITHHOLDS the seed. Everything else
// in the store's report is forwarded, so the only variable is `enableAllTools` — the shape of a
// preset that opts out (and, one step further out, of a scripted fixture, an injected library
// preset, or the CLI, which drop the whole report). The store now asks for the seed on BOTH build
// paths, so this is the figure that keeps such a session unseeded: `createToolboxHarness` forwards
// on `report.enableAllTools === true` (./harnesses/toolbox.ts:671), and the kernel's re-seam is
// gated on the same value (../harness.ts:12663-12664). The last test below pins that a session
// built this way keeps an empty toolbox through create, reset, and restart-then-reset.
const unseededToolboxPreset = (): HarnessPreset => {
    const input = {
        agents: { boss: scriptedBrain('boss'), helper: scriptedBrain('helper') },
        primary: 'boss',
        subagents: ['helper']
    };

    return {
        ...toolboxPreset(),
        create: (settings, progress, report) =>
            createToolboxHarness(input, settings, progress, {
                ...(report ?? {}),
                // `false`, not `undefined`: the library default and an explicit opt-out are the
                // same posture here, and spelling it out keeps the fixture's intent readable.
                enableAllTools: false
            })
    };
};

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

const openPair = (
    root: string,
    database?: Record<string, unknown>,
    preset: HarnessPreset = toolboxPreset()
) => {
    const registry = createHarnessRegistry([preset]);
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

const namesWhere = (rows: Record<string, any>[], predicate: (row: Record<string, any>) => boolean): string[] =>
    rows.filter(predicate).map((row) => row.name as string);

// One row AS THE PANE SEES IT: every field the toolbox state is made of, in server order.
// `session_id` is excluded because two different conversations are compared — every other field
// (description, tags, group, visibility, source figures included) must match too, so the
// projection is the WHOLE row minus the one field that legitimately differs.
const comparableRows = (rows: Record<string, any>[]): Record<string, any>[] =>
    rows.map((row) => {
        const { session_id: _sessionId, ...rest } = row;

        return rest;
    });

describe('POST /sessions/{id}/reset re-applies the new-session toolbox seed', () => {
    it('answers the same rows a brand-new session answers, field for field', async () => {
        stubKeylessSearch();
        const { api } = openPair(tempRoot('rows-equal'));

        const createdId = await sessionOf(api);
        const createdRows = await rowsOf(api, createdId);

        // The baseline this file is about: a session that has never run starts full.
        expect(namesWhere(createdRows, (row) => row.enabled)).toEqual(SEEDED_NAMES);

        const reset = await call(api, 'POST', `${MOUNT}/sessions/${createdId}/reset`);

        expect(reset.status).toBe(200);

        const resetRows = await rowsOf(api, createdId);

        // The reset conversation IS a new conversation: 32 rows, the same 22 on, the same 10
        // protected, the same origins, in the same order.
        expect(comparableRows(resetRows)).toEqual(comparableRows(createdRows));
        expect(namesWhere(resetRows, (row) => row.enabled)).toEqual(SEEDED_NAMES);
        expect(namesWhere(resetRows, (row) => row.enabled).length).toBe(22);
        expect(namesWhere(resetRows, (row) => row.protected).length).toBe(10);

        // A SECOND reset changes nothing: the seed is a state, not a one-shot bonus.
        expect((await call(api, 'POST', `${MOUNT}/sessions/${createdId}/reset`)).status).toBe(200);
        expect(comparableRows(await rowsOf(api, createdId))).toEqual(comparableRows(createdRows));
    });

    it('brings back a toolbox the conversation switched off, durably', async () => {
        stubKeylessSearch();
        const root = tempRoot('restore-switched-off');
        const { api } = openPair(root);
        const sessionId = await sessionOf(api);

        // The report's other state: a conversation whose reader turned names off.
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/syntax`, { enabled: false })).status).toBe(200);
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/shell`, { enabled: false })).status).toBe(200);

        const off = await rowsOf(api, sessionId);

        expect(namesWhere(off, (row) => row.enabled)).toEqual(SEEDED_NAMES.filter((name) => name !== 'syntax' && name !== 'shell'));

        expect((await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/reset`)).status).toBe(200);

        const rows = await rowsOf(api, sessionId);

        expect(namesWhere(rows, (row) => row.enabled)).toEqual(SEEDED_NAMES);

        // The re-seed is the conversation's committed state, not a paint: the session document
        // carries the full set, so a restart cannot put the two off-switches back. Compared as a
        // set because the snapshot's own order is the kernel's active-tool order, not the row list.
        const snapshot = readDocument(root).sessions[0].core as HarnessSnapshot;

        expect([...(snapshot.discovery.enabled as string[])].sort()).toEqual([...SEEDED_NAMES].sort());

        const reopened = openPair(root, readDocument(root));

        expect(namesWhere(await rowsOf(reopened.api, sessionId), (row) => row.enabled)).toEqual(SEEDED_NAMES);
    });

    it('keeps the seed scope: a name the deployment denies stays off after a reset', async () => {
        stubKeylessSearch();
        const { api } = openPair(tempRoot('reset-under-deny'));

        expect((await call(api, 'PATCH', `${MOUNT}/tools/shell`, { enabled: false })).status).toBe(200);

        const underDenyId = await sessionOf(api);
        const underDenyRows = await rowsOf(api, underDenyId);
        const before = row(underDenyRows, 'shell');

        expect({ enabled: before.enabled, protected: before.protected, origin: before.origin }).toEqual({
            enabled: false,
            protected: false,
            origin: 'catalogue'
        });

        expect((await call(api, 'POST', `${MOUNT}/sessions/${underDenyId}/reset`)).status).toBe(200);

        const rows = await rowsOf(api, underDenyId);
        const after = row(rows, 'shell');

        // The denied name is not switched on by a reset — the deployment outranks this
        // conversation's set, and the seed filtered the deny list out before the pass.
        expect({ enabled: after.enabled, protected: after.protected, origin: after.origin }).toEqual({
            enabled: false,
            protected: false,
            origin: 'catalogue'
        });
        expect(namesWhere(rows, (row) => row.enabled)).toEqual(SEEDED_NAMES.filter((name) => name !== 'shell'));

        // And the denied-name session is still the same state a fresh one gets: same rows, both
        // before and after the reset.
        const freshId = await sessionOf(api);

        expect(comparableRows(rows)).toEqual(comparableRows(await rowsOf(api, freshId)));
    });

    // THE MISSED REGRESSION. `Harness.enableAllSwitchableTools` is gated on
    // `HarnessConfiguration.enableAllTools` (../harness.ts:12663-12664), and a configuration
    // belongs to the harness built IN THIS PROCESS. `restoreSession` used to build without the
    // seed, so a reset after a restart found no seed to re-run: the same session answered 22
    // enabled when its reset ran in the creating process and 0 when it ran in the next one — and
    // the empty set was then durable, because the reset commits what it produced. Measured before
    // the fix: `{ total: 32, enabled: 0, protected: 10 }`.
    it('answers the same toolbox when the session was restarted first, not only in its own process', async () => {
        stubKeylessSearch();
        const root = tempRoot('restart-then-reset');
        const { api } = openPair(root);

        const createdId = await sessionOf(api);
        const createdRows = await rowsOf(api, createdId);

        expect(namesWhere(createdRows, (row) => row.enabled)).toEqual(SEEDED_NAMES);

        // THE RESTART: a registry, a store, and an API built again from the persisted document.
        // Restoring on its own changes nothing (the committed set here happens to be the full 22).
        const reopened = openPair(root, readDocument(root));

        expect(namesWhere(await rowsOf(reopened.api, createdId), (row) => row.enabled)).toEqual(SEEDED_NAMES);

        // The reset belongs to the SECOND process. This is the call that used to empty the pane.
        const reset = await call(reopened.api, 'POST', `${MOUNT}/sessions/${createdId}/reset`);

        expect(reset.status).toBe(200);

        const resetRows = await rowsOf(reopened.api, createdId);

        // Row for row, field for field: `create -> reset` == `create -> restart -> reset`.
        expect(comparableRows(resetRows)).toEqual(comparableRows(createdRows));
        expect(namesWhere(resetRows, (row) => row.enabled)).toEqual(SEEDED_NAMES);
        expect(namesWhere(resetRows, (row) => row.enabled).length).toBe(22);
        expect(namesWhere(resetRows, (row) => row.protected).length).toBe(10);

        // The refill is the SECOND process's committed state, so a further restart keeps it. Before
        // the fix the emptiness was equally durable, which is why the bug looked permanent.
        const snapshot = readDocument(root).sessions[0].core as HarnessSnapshot;

        expect([...(snapshot.discovery.enabled as string[])].sort()).toEqual([...SEEDED_NAMES].sort());

        const reopenedAgain = openPair(root, readDocument(root));

        expect(namesWhere(await rowsOf(reopenedAgain.api, createdId), (row) => row.enabled)).toEqual(SEEDED_NAMES);
    });

    // Requirement 2: the restore build now carries the seed (./sessions.ts:3843), and that is only
    // safe because `harness.restore()` REPLACES the enabled set with the persisted one
    // (../harness.ts:11676) before the session is ever published. Pinned from both sides: the
    // switches a conversation moved stay moved, and the document the restarted process writes next
    // still reflects the committed set rather than the construction seed.
    it('a restart alone never refills: the committed set survives the restore-path seed', async () => {
        stubKeylessSearch();
        const root = tempRoot('restart-no-refill');
        const { api } = openPair(root);
        const sessionId = await sessionOf(api);

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/syntax`, { enabled: false })).status).toBe(200);
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/shell`, { enabled: false })).status).toBe(200);

        const committed = SEEDED_NAMES.filter((name) => name !== 'syntax' && name !== 'shell');

        expect(namesWhere(await rowsOf(api, sessionId), (row) => row.enabled)).toEqual(committed);

        const reopened = openPair(root, readDocument(root));

        // 20, not 22: `syntax` and `shell` are still off, and no third name moved.
        const restoredRows = await rowsOf(reopened.api, sessionId);

        expect(namesWhere(restoredRows, (row) => row.enabled)).toEqual(committed);
        expect(namesWhere(restoredRows, (row) => row.enabled).length).toBe(20);
        expect(namesWhere(restoredRows, (row) => row.protected).length).toBe(10);

        // Not just a paint over a refilled harness: the next mutation this process persists starts
        // from the committed set, so the construction seed never reached the document either.
        expect((await call(reopened.api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/download`, { enabled: false })).status).toBe(200);

        const snapshot = readDocument(root).sessions[0].core as HarnessSnapshot;

        expect([...(snapshot.discovery.enabled as string[])].sort()).toEqual(
            [...committed.filter((name) => name !== 'download')].sort()
        );

        // Only an explicit reset starts a new conversation — and it refills in this process too.
        expect((await call(reopened.api, 'POST', `${MOUNT}/sessions/${sessionId}/reset`)).status).toBe(200);
        expect(namesWhere(await rowsOf(reopened.api, sessionId), (row) => row.enabled)).toEqual(SEEDED_NAMES);
    });

    // The strongest form of the same guarantee: a committed set that is EMPTY. A seed that
    // UNIONED into the restored set instead of being replaced by it would light up here.
    //
    // This is also the shape of a LEGACY record — one written before the seed existed, whose
    // `discovery.enabled` holds the handful of names a `toolRequest` round happened to match (or
    // nothing at all). It restores exactly as written, and its first RESET refills: the product
    // rule the seed exists for is "a new conversation starts with every tool on", and a reset
    // starts a new conversation. No posture field is stored on the record, so no per-record
    // migration is needed for that to hold.
    it('a committed EMPTY set survives a restart — the restore replaces the seed, never merges it', async () => {
        stubKeylessSearch();
        const root = tempRoot('restart-empty-set');
        const { api } = openPair(root);
        const sessionId = await sessionOf(api);

        for (const name of SEEDED_NAMES) {
            expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/${name}`, { enabled: false })).status).toBe(200);
        }

        const off = await rowsOf(api, sessionId);

        expect(namesWhere(off, (row) => row.enabled)).toEqual([]);
        expect(namesWhere(off, (row) => row.protected)).toEqual(PROTECTED_NAMES);

        const reopened = openPair(root, readDocument(root));
        const restoredRows = await rowsOf(reopened.api, sessionId);

        // Nothing came back on: 0 enabled of 32 rows, the 10 protected still reported off.
        expect(namesWhere(restoredRows, (row) => row.enabled)).toEqual([]);
        expect(restoredRows.length).toBe(32);
        expect(namesWhere(restoredRows, (row) => row.protected)).toEqual(PROTECTED_NAMES);

        // And the reset still refills it, in this process.
        expect((await call(reopened.api, 'POST', `${MOUNT}/sessions/${sessionId}/reset`)).status).toBe(200);
        expect(namesWhere(await rowsOf(reopened.api, sessionId), (row) => row.enabled)).toEqual(SEEDED_NAMES);
    });
});

// Requirement 3: the kernel gate stays, and with it the non-seeded posture. The store asks for
// the seed on both build paths now, so the only thing that decides whether a session gets one is
// whether ITS preset factory forwards the report — exactly as it was before, and unchanged for a
// factory that ignores it. `./sessions.test.ts` ("keeps discovery enabled across two turns") pins
// the same gate through a scripted fixture; this pins it for the restart, where the store's own
// flag is now set on both paths.
describe('a session built without the seed keeps an empty toolbox, reset or not', () => {
    it('stays empty through create, reset, and restart-then-reset', async () => {
        stubKeylessSearch();
        const root = tempRoot('unseeded');
        const { api } = openPair(root, undefined, unseededToolboxPreset());
        const sessionId = await sessionOf(api);

        // The same 32 rows, none of them on: the toolbox is fully listed, just not seeded.
        const created = await rowsOf(api, sessionId);

        expect(created.length).toBe(32);
        expect(namesWhere(created, (row) => row.enabled)).toEqual([]);
        expect(namesWhere(created, (row) => row.protected)).toEqual(PROTECTED_NAMES);

        // A reset in the creating process re-runs a seed this harness never had.
        expect((await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/reset`)).status).toBe(200);
        expect(namesWhere(await rowsOf(api, sessionId), (row) => row.enabled)).toEqual([]);

        // And a reset after a restart — where the store DOES pass the flag on the build now —
        // stays empty too, because this factory withholds the seed before it can reach the kernel.
        const reopened = openPair(root, readDocument(root), unseededToolboxPreset());

        expect(namesWhere(await rowsOf(reopened.api, sessionId), (row) => row.enabled)).toEqual([]);
        expect((await call(reopened.api, 'POST', `${MOUNT}/sessions/${sessionId}/reset`)).status).toBe(200);
        expect(namesWhere(await rowsOf(reopened.api, sessionId), (row) => row.enabled)).toEqual([]);
    });
});

const row = (rows: Record<string, any>[], name: string): Record<string, any> => {
    const found = rows.find((candidate) => candidate.name === name);

    if (found === undefined) throw new Error(`no row named "${name}"`);

    return found;
};
