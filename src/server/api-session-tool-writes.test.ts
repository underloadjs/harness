// T19: the session TOOL write surface that used to answer 403 for lack of a domain operation
// (`PATCH /sessions/:id/tools/:tool_id {enabled}`, `DELETE /sessions/:id/tools/:tool_id`, and a
// metadata-only PATCH).
//
// What is pinned, exactly:
//   1. `enabled` is a real reversible gate on the LIVE harness: off withdraws the name from the
//      session's callable set without unregistering it, on restores it, and neither mints a
//      source revision (the envelope restates the installed revision and says
//      `created: false, replaced: false`);
//   2. `DELETE` un-registers: the name leaves the live registry, the source revision, the
//      created-tool budget, and the enabled set together, and the receipt says which kind of
//      removal it was;
//   3. a protected entry (a harness-owned control tool) refuses the gate switch and the removal
//      with 403, and a name with no session-local registration answers 400 - the refusals stay
//      distinguishable;
//   4. a metadata-only PATCH (description with no new source) goes through the registration
//      kernel using the INSTALLED revision's own text, so the edit is real instead of refused;
//   5. durability: the changed enabled set and the removal survive a restart, because the
//      session document is written from the harness snapshot at the same commit boundary a
//      registration uses;
//   6. nothing global moved: the deployment catalogue still lists the name the session removed.
//
// R1/R2/R3 (the shared-toolbox fixture at the bottom of this file) pin the row CLASSIFICATION
// and the new-session toolbox state, which the tool-less fixture above cannot even express:
//   7. a brand-new session starts with every SWITCHABLE row enabled, and only a row the kernel
//      cannot switch reads `enabled: false` (R1);
//   8. the `protected` figure IS the kernel's own switchability answer: a protected row refuses
//      with 403, a non-protected row toggles with 200, and no row in the pane can produce the 409
//      the raw kernel sentence used to surface (R2/AC2);
//   9. both misclassification directions are gone — `delegate` (core, protected, and now labelled
//      `Core tools`/`core`/session-bound like the global row for the same name) and `syntax`/
//      `files`/`shell` (searchable, switchable, previously locked behind a 403);
//  10. `toolCancel` proves the predicate cannot be re-implemented from `visibility`: its
//      registration DEMOTES it to `searchable`, yet the kernel refuses to switch it.
//
// Cross-references:
//   - ../harness.ts               â€” `toolManage enable|disable|remove`
//   - ./api.ts                    â€” `setSessionToolEnabled`, `patchSessionTool`, `deleteSessionTool`
//   - ./api-reads.ts              â€” `sessionToolRowsOf` (`enabled`/`protected`/`origin`)
//   - ./persistence.ts            â€” the session `core` snapshot that carries the enabled set

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

const ROOT = path.join(process.cwd(), 'Temp', 't19');

const SETTINGS: RunnerSettings = {
    baseURL: 'http://toolwrites.invalid/v1',
    apiKey: 'server-secret-value',
    model: 'scripted/first'
};

const API_DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

const MOUNT = '/v1/harness';

// A scripted preset with NO declared tools, so every tool in the session is either a
// harness-owned core entry (protected) or something this session created itself. The factory is
// offline: the contract being pinned is registry state, not model traffic.
const preset = (): HarnessPreset => ({
    name: 'tooling',
    title: 'Tooling',
    description: 'Scripted session-tool mutation fixture',
    requiresEndpoint: false,
    primary: 'tooler',
    subagents: [],
    agents: ['tooler'],
    tools: [],
    builtin: false,
    editable: true,
    create: (settings, progress, report) =>
        harness({
            agents: {
                tooler: agent({
                    model: settings.model,
                    instruction: 'Scripted tool-mutation agent.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'ok' };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }
                })
            },
            primary: 'tooler',
            presets: false,
            // The persistence observer MUST be forwarded: it is what refreshes the store's
            // committed `core` snapshot at every harness mutation boundary, and `createdTools`
            // / the enabled set are read from it. A fixture that dropped it (the api-durable
            // preset does, because it never registers a tool) would make every "did the write
            // land" assertion below test the projection's staleness instead of the write.
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
});

// ---------------------------------------------------------------------------
// THE SHARED-TOOLBOX FIXTURE (R1/R2/R3)
//
// The `tooling` preset above declares NO toolbox, so every row it produces is either a
// harness-owned control entry or something the session created — enough to pin the write
// surface, not enough to pin the row CLASSIFICATION. This second preset is built through the
// same `createToolboxHarness` factory every shipped card uses (./harnesses/toolbox.ts), so its
// rows are the real production toolbox: the runtime controls, `delegate` (a team exists), the
// pending-only `toolCancel`, the demoted searchable runtime set, and the shared catalogue
// entries (`syntax`, `files`, `shell`, ...). The three bugs this file used to be blind to all
// live in that population: `delegate` was clickable then refused with 409, `syntax`/`files`/
// `shell` were locked with 403 although the kernel can switch them, and every row was off.
//
// The model is scripted and no turn runs in these tests, so nothing costs a provider call.
// ---------------------------------------------------------------------------
const scriptedBrain = (name: string, settings: RunnerSettings): ReturnType<typeof agent> =>
    agent({
        model: settings.model,
        instruction: `Scripted toolbox-fixture brain (${name}).`,
        stream: async function* (): AsyncGenerator<HarnessStreamEvent> {
            yield { type: 'text', delta: 'ok' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        }
    });

const toolboxPreset = (): HarnessPreset => ({
    name: 'toolbox',
    title: 'Toolbox',
    description: 'Shared-toolbox fixture: the real production rows, scripted model.',
    requiresEndpoint: false,
    primary: 'boss',
    // A non-empty allowlist is what makes `delegate` REGISTER (as a core declaration), which is
    // the exact row the report said errored on click.
    subagents: ['helper'],
    agents: ['boss', 'helper'],
    tools: SHARED_TOOL_NAMES,
    // The same line every shipped card carries: `createToolboxHarness` opts into both
    // environment rows (`websearch`/`webfetch`), so a card that omitted this would describe a
    // `fetch` declaration its harness still makes. `describeHarness` then admits a name only
    // when THIS host can run it, which is why the keyless host below declares `fetch` but never
    // `search`.
    environmentTools: ['search', 'fetch'],
    builtin: false,
    editable: true,
    create: (settings, progress, report) =>
        createToolboxHarness(
            {
                agents: { boss: scriptedBrain('boss', settings), helper: scriptedBrain('helper', settings) },
                primary: 'boss',
                subagents: ['helper']
            },
            settings,
            progress,
            // The report rides through UNMODIFIED, exactly as a shipped card receives it, so the
            // store's per-build `enableAllTools` (R1) reaches `HarnessConfiguration`. A fixture
            // that cherry-picked fields would silently test the library default instead.
            report
        )
});

// The environment-backed `search` row registers only when a provider key resolves, which would
// make the row COUNT below depend on the developer's `.env`. `fetch` is keyless and always
// registers, so the expected population below is the keyless one.
const stubKeylessSearch = (): void => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('LINKUP_API_KEY', '');
};

afterEach(() => {
    vi.unstubAllEnvs();
});

const tempRoot = (label: string): string => {
    const root = path.join(ROOT, `tools-${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

    fs.mkdirSync(root, { recursive: true });

    return root;
};

const stateFile = (root: string): string => path.join(root, 'harness', HARNESS_DATABASE_FILE);

const readDocument = (root: string): Record<string, any> =>
    fs.existsSync(stateFile(root))
        ? (JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as Record<string, any>)
        : {};

// The store's persistence observer commits at every harness mutation boundary, so the document
// on disk is the same view a restart would rebuild from.
//
// `presets` is defaulted to the tool-less `tooling` card because that is what every existing case
// here pins; the R1/R2/R3 cases pass the shared-toolbox card instead.
const openPair = (
    root: string,
    database?: Record<string, unknown>,
    presets: HarnessPreset[] = [preset()]
) => {
    const registry = createHarnessRegistry(presets);
    const store = new SessionStore(SETTINGS, registry, undefined, {
        persistence: new HarnessPersistence(root),
        ...(database === undefined ? {} : { database: database as never })
    });
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry, databaseRoot: root });

    return { store, registry, api };
};

const call = async (
    api: ReturnType<typeof createHarnessApi>,
    method: string,
    rawPathname: string,
    body: unknown = {}
): Promise<{ status: number; body: Record<string, any> }> => {
    // The dispatcher reads parameters from `searchParams`, not from the pathname (the adapters
    // split them), so a query string in a test URL is split out here rather than becoming part
    // of the matched route.
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

/** One created tool, registered through the public route so the kernel's rules are the real ones. */
const createTool = async (
    api: ReturnType<typeof createHarnessApi>,
    sessionId: string,
    name: string,
    description = 'Original description.'
): Promise<{ status: number; body: Record<string, any> }> =>
    call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tools`, {
        name,
        description,
        tags: ['test', 'mutation'],
        module_text: `
export const metadata = {
    name: '${name}',
    description: '${description}',
    tags: ['test', 'mutation']
};
export const execute = () => ({ ${name}: true });
`
    });

const rowOf = async (
    api: ReturnType<typeof createHarnessApi>,
    sessionId: string,
    name: string
): Promise<Record<string, any> | undefined> => {
    const page = await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools?limit=100`);

    return (page.body.items as { name: string }[]).find((entry) => entry.name === name);
};

describe('PATCH /sessions/{id}/tools/{tool_id} with enabled only', () => {
    it('withholds a created tool and restores it, without minting a source revision', async () => {
        const { api } = openPair(tempRoot('gate'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        const registered = await createTool(api, sessionId, 'gateTool');

        expect(registered.status).toBe(201);

        const revision = registered.body.registration.source_revision as string;

        expect(revision).not.toBe('');

        const off = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/gateTool`, { enabled: false });

        expect(off.status).toBe(200);
        // The gate change is not a source change: the envelope restates the installed revision
        // and says nothing was created or replaced.
        expect(off.body.registration).toEqual({
            name: 'gateTool',
            source_revision: revision,
            created: false,
            replaced: false,
            budget: { used: 1, limit: expect.any(Number) }
        });

        expect(await rowOf(api, sessionId, 'gateTool')).toMatchObject({ enabled: false, protected: false });

        // A disabled tool is still ADDRESSED by the identified read (it is registered, just not
        // in the model's callable set), so a client can re-enable it without guessing.
        expect((await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/gateTool`)).status).toBe(200);

        const on = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/gateTool`, { enabled: true });

        expect(on.status).toBe(200);
        expect(on.body.registration.source_revision).toBe(revision);
        expect(await rowOf(api, sessionId, 'gateTool')).toMatchObject({ enabled: true });

        // Idempotent: a second identical switch still answers 200 and states the same gate.
        const again = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/gateTool`, { enabled: true });

        expect(again.status).toBe(200);
        expect(await rowOf(api, sessionId, 'gateTool')).toMatchObject({ enabled: true });
    });

    it('refuses to switch a harness-owned core tool with 403', async () => {
        const { api } = openPair(tempRoot('gate-protected'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        const row = await rowOf(api, sessionId, 'tasks');

        expect(row).toMatchObject({ protected: true });

        const refused = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/tasks`, { enabled: false });

        expect(refused.status).toBe(403);
        expect(refused.body.error.message).toContain('harness-owned');

        // The refusal is a refusal, not a partial write: the row is unchanged.
        expect(await rowOf(api, sessionId, 'tasks')).toMatchObject({ protected: true, enabled: row!.enabled });
    });

    it('rejects a non-boolean gate and an empty patch', async () => {
        const { api } = openPair(tempRoot('gate-valid'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        await createTool(api, sessionId, 'validTool');

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/validTool`, { enabled: 'nope' })).status).toBe(400);
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/validTool`, {})).status).toBe(400);
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/nothing`, { enabled: false })).status).toBe(404);
    });
});

describe('DELETE /sessions/{id}/tools/{tool_id}', () => {
    it('un-registers a created tool, frees its budget entry, and survives a restart', async () => {
        const root = tempRoot('remove');
        const { api } = openPair(root);
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        expect((await createTool(api, sessionId, 'goneTool')).status).toBe(201);
        expect(await rowOf(api, sessionId, 'goneTool')).toMatchObject({ origin: 'created', enabled: true });

        const removed = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/goneTool`);

        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({
            deleted: true,
            tool_id: 'goneTool',
            session_id: sessionId,
            removed_created: true,
            // This runtime has no inherited copy to hand back, and the receipt says so.
            restored_inherited: false
        });

        expect(await rowOf(api, sessionId, 'goneTool')).toBeUndefined();
        expect((await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/goneTool`)).status).toBe(404);
        expect((await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/goneTool/source`)).status).toBe(404);

        // The budget figure moves with the removal, because the created-tool record went with it.
        const page = await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools?limit=100`);

        expect(page.body.budget).toEqual({ used: 0, limit: page.body.budget.limit });

        // A repeat DELETE is 404 (the name is gone), not a second success.
        expect((await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/goneTool`)).status).toBe(404);

        // Restart: the document is the harness snapshot taken at the removal's commit boundary,
        // so the next process does not resurrect the tool.
        const reopened = openPair(root, readDocument(root));
        const rows = (await call(reopened.api, 'GET', `${MOUNT}/sessions/${sessionId}/tools?limit=100`)).body.items as {
            name: string;
        }[];

        expect(rows.map((entry) => entry.name)).not.toContain('goneTool');

        // Nothing global moved: the deployment catalogue still lists the name it always listed.
        expect(
            (await call(reopened.api, 'GET', `${MOUNT}/tools?limit=100`)).body.items.some(
                (entry: { name: string }) => entry.name === 'goneTool'
            )
        ).toBe(false);
    });

    it('keeps a disabled tool disabled across a restart, then removes it for good', async () => {
        const root = tempRoot('gate-durable');
        const { api } = openPair(root);
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        await createTool(api, sessionId, 'quietTool');

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/quietTool`, { enabled: false })).status).toBe(200);

        const snapshot = readDocument(root).sessions[0].core as HarnessSnapshot;

        // The durable statement of the gate: the enabled set no longer names the tool, while the
        // created-tool registration is still there (disabling is not unregistering).
        expect(snapshot.discovery.enabled).not.toContain('quietTool');
        expect(snapshot.createdTools.map((entry) => entry.name)).toContain('quietTool');

        const reopened = openPair(root, readDocument(root));

        expect(await rowOf(reopened.api, sessionId, 'quietTool')).toMatchObject({ enabled: false, origin: 'created' });

        expect((await call(reopened.api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/quietTool`)).status).toBe(200);
        expect(await rowOf(reopened.api, sessionId, 'quietTool')).toBeUndefined();
    });

    it('refuses a protected entry with 403', async () => {
        const { api } = openPair(tempRoot('remove-protected'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        const refused = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/tasks`);

        expect(refused.status).toBe(403);
        expect(refused.body.error.message).toContain('cannot be unregistered');
        expect(await rowOf(api, sessionId, 'tasks')).toMatchObject({ protected: true });
    });
});

describe('PATCH with metadata only', () => {
    it('re-publishes the installed revision with the new description instead of refusing', async () => {
        const { api } = openPair(tempRoot('metadata'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        await createTool(api, sessionId, 'metaTool', 'Original description.');

        const patched = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/metaTool`, {
            description: 'Rewritten description.'
        });

        expect(patched.status).toBe(200);
        expect(patched.body.registration.name).toBe('metaTool');

        const detail = await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/metaTool`);

        expect(detail.status).toBe(200);
        // The live registry owns its text, so the row states the rewrite, not the catalogue copy.
        expect(detail.body.tool.description).toBe('Rewritten description.');
        expect(detail.body.tool.origin).toBe('created');
        expect(detail.body.tool.enabled).toBe(true);
    });
});

// ===========================================================================
// R1 / R2 / R3 — the shared-toolbox fixture (see `toolboxPreset` above).
//
// WHY A SECOND FIXTURE: every case above runs on a preset with NO toolbox, so its rows are only
// harness-owned controls and session creations. The three defects in the report all live in the
// population a real card registers — `delegate`, the demoted runtime set, and the searchable
// preset entries — so the pins below need the real factory (`createToolboxHarness`), the real
// report wiring (`SessionStore.buildHarness`), and the real shared toolbox.
//
// EXPECTED POPULATION (a keyless host: `search` needs a provider key, `fetch` does not):
//   - 32 rows total;
//   - 22 enabled - every name the kernel can switch (the demoted runtime set + the shared
//     catalogue entries). Before R1 this number was 0, which is the report's "not all tools are
//     enabled by default";
//   - 10 protected - the 8 declared core names, the pending-only `toolCancel`, and `fetch`. A
//     protected name reports `enabled: false` because it never occupies a cap slot: it is in
//     context through the declaration list, not through the enabled set (see the contract note
//     on `enabled` in ../shared/harness-api.ts). `toolCancel` and `fetch` are the two names the
//     kernel refuses to switch WITHOUT being part of the declaration list, which is exactly why
//     `declared` and `protected` are separate axes rather than one flag;
//   - 8 declared - the frozen definition's `coreTools`, which is the set in context on every
//     request (NOT `definition.tools`, the 15-name registered list).
// ===========================================================================

// The rows the kernel refuses to switch, in registry order.
const PROTECTED_NAMES = [
    'toolRequest',
    'tasks',
    'delegate',
    'toolCancel',
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'fetch'
];

// Every other row: switchable, and therefore ON for a session that has never run (R1).
const ENABLED_NAMES = [
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

// The declared core set - `coreTools` of the frozen definition, in definition order. This is NOT
// "the protected rows minus `toolCancel`": `fetch` is kernel-protected (a toggle answers 403) yet
// absent from the declaration list, because `describeHarness` declares the core file/record
// controls and `delegate` only - the environment-backed and always-mounted extras are in context
// through the kernel, not through the declaration.
const DECLARED_NAMES = [
    'toolRequest',
    'tasks',
    'delegate',
    'read',
    'write',
    'edit',
    'glob',
    'grep'
];

const openToolboxPair = (root: string, database?: Record<string, unknown>) =>
    openPair(root, database, [toolboxPreset()]);

const sessionOf = async (api: ReturnType<typeof createHarnessApi>): Promise<string> => {
    const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'toolbox' });

    expect(created.status).toBe(201);

    return created.body.session.id as string;
};

const rowsOf = async (
    api: ReturnType<typeof createHarnessApi>,
    sessionId: string
): Promise<Record<string, any>[]> => {
    const page = await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools?limit=100`);

    expect(page.status).toBe(200);

    return page.body.items as Record<string, any>[];
};

const namesWhere = (rows: Record<string, any>[], predicate: (row: Record<string, any>) => boolean): string[] =>
    rows.filter(predicate).map((row) => row.name as string);

describe('R1 — a brand-new session starts with the whole switchable toolbox', () => {
    it('enables every switchable row, and only a row the kernel cannot switch reads false', async () => {
        stubKeylessSearch();
        const { api } = openToolboxPair(tempRoot('seed'));
        const sessionId = await sessionOf(api);
        const rows = await rowsOf(api, sessionId);

        // The reconciliation for a fresh harness, stated as exact name lists.
        expect(rows.length).toBe(32);
        expect(namesWhere(rows, (row) => row.enabled)).toEqual(ENABLED_NAMES);
        expect(namesWhere(rows, (row) => row.protected)).toEqual(PROTECTED_NAMES);
        expect(namesWhere(rows, (row) => row.declared)).toEqual(DECLARED_NAMES);

        // ONE rule stated twice: a row is enabled exactly when it is switchable. Either half of
        // this failing is the bug the report describes - an unticked box the user then has to
        // click, or a ticked box the runtime would refuse.
        expect(namesWhere(rows, (row) => !row.protected && !row.enabled)).toEqual([]);
        expect(namesWhere(rows, (row) => row.protected && row.enabled)).toEqual([]);

        // The seeded names hold a slot without being declared, which is what `discovered` means
        // on a row; the declared core set, the pending-only control, and the always-mounted
        // `fetch` do not.
        expect(namesWhere(rows, (row) => row.origin === 'discovered')).toEqual(ENABLED_NAMES);
        expect(namesWhere(rows, (row) => row.origin === 'catalogue')).toEqual(PROTECTED_NAMES);
        // The two axes stated separately so the one row that is protected WITHOUT being declared
        // cannot be quietly papered over by deriving one flag from the other.
        expect(namesWhere(rows, (row) => row.protected && !row.declared)).toEqual(['toolCancel', 'fetch']);
    });

    it('states the verdict before the click: 200 for every switchable row, 403 for every protected one, never 409', async () => {
        stubKeylessSearch();
        const { api } = openToolboxPair(tempRoot('seed-sweep'));
        const sessionId = await sessionOf(api);
        const rows = await rowsOf(api, sessionId);

        // The sweep the report ran by hand ("click delegate -> error pill"): every row in the
        // pane, asked to move to the state it is NOT in. The status must follow the row.
        const statuses = new Map<string, number>();

        for (const row of rows) {
            const write = await call(
                api,
                'PATCH',
                `${MOUNT}/sessions/${sessionId}/tools/${row.name as string}`,
                { enabled: !(row.enabled as boolean) }
            );

            statuses.set(row.name as string, write.status);
        }

        expect(namesWhere(rows, (row) => statuses.get(row.name as string) === 409)).toEqual([]);
        expect(namesWhere(rows, (row) => statuses.get(row.name as string) === 403)).toEqual(PROTECTED_NAMES);
        expect(namesWhere(rows, (row) => statuses.get(row.name as string) === 200)).toEqual(ENABLED_NAMES);

        // And the writes are real: every switchable row moved to OFF, while every protected row
        // still reports the state its declaration gives it (a refusal is not a partial write).
        const after = await rowsOf(api, sessionId);

        expect(namesWhere(after, (row) => row.enabled)).toEqual([]);
        expect(namesWhere(after, (row) => row.protected)).toEqual(PROTECTED_NAMES);
    });

    it('treats the seeded set as the session state: a restart keeps it, and a disable stays disabled', async () => {
        stubKeylessSearch();
        const root = tempRoot('seed-durable');
        const { api } = openToolboxPair(root);
        const sessionId = await sessionOf(api);

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/syntax`, { enabled: false })).status).toBe(200);

        // The durable statement of the seed: the enabled set is part of the session's own
        // harness snapshot, not a rule the server re-applies on every boot.
        const snapshot = readDocument(root).sessions[0].core as HarnessSnapshot;

        expect(snapshot.discovery.enabled).toContain('shell');
        expect(snapshot.discovery.enabled).not.toContain('syntax');

        const reopened = openToolboxPair(root, readDocument(root));
        const rows = await rowsOf(reopened.api, sessionId);

        // AC4: the restore changes no switch state. The restore BUILD now runs the seed pass
        // (src/server/sessions.ts:3843 — that is what arms the reset re-run in this process), but
        // `harness.restore()` replaces the enabled set with the persisted one straight afterwards
        // (src/harness.ts:11676), so the conversation comes back with exactly what it committed:
        // the one name it switched off is still off after the restart, and nothing else moved.
        expect(namesWhere(rows, (row) => row.enabled)).toEqual(ENABLED_NAMES.filter((name) => name !== 'syntax'));
    });
});

describe('R3 — `protected` is the kernel predicate, not a catalogue guess', () => {
    it('classifies `delegate` as protected core, and refuses the switch with 403 instead of the kernel 409', async () => {
        stubKeylessSearch();
        const { api } = openToolboxPair(tempRoot('delegate'));
        const sessionId = await sessionOf(api);

        const row = await rowOf(api, sessionId, 'delegate');

        expect(row).toMatchObject({
            declared: true,
            // `enabled: false` is not "off": a core declaration is in context on every request
            // and never occupies an enabled slot. `protected` is the field that says so.
            enabled: false,
            protected: true,
            visibility: 'core',
            group: 'Core tools',
            session_bound: true,
            origin: 'catalogue'
        });

        const refused = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/delegate`, { enabled: true });

        // The reported symptom: this write used to reach the runtime and come back as the raw
        // kernel sentence with a 409. The row says `protected` up front, so the route answers
        // with the documented 403 and the pane never shows an error pill for a click it allowed.
        expect(refused.status).toBe(403);
        expect(refused.body.error.message).toContain('harness-owned');
        expect(refused.body.error.message).toContain('cannot be enabled or disabled');

        // A protected row is also not un-registerable, and stays exactly as it was.
        expect((await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/delegate`)).status).toBe(403);
        expect(await rowOf(api, sessionId, 'delegate')).toMatchObject({ protected: true, enabled: false });

        // The same name must not be two different tools: the session row and the GLOBAL Tools row
        // resolve through one entry lookup, so their metadata is identical.
        const global = (await call(api, 'GET', `${MOUNT}/tools/delegate`)).body.tool as Record<string, any>;

        expect({
            group: row!.group,
            visibility: row!.visibility,
            session_bound: row!.session_bound
        }).toEqual({
            group: global.group,
            visibility: global.visibility,
            session_bound: global.session_bound
        });
    });

    it('keeps the pending-only `toolCancel` protected although its registered visibility is searchable', async () => {
        stubKeylessSearch();
        const { api } = openToolboxPair(tempRoot('cancel'));
        const sessionId = await sessionOf(api);

        const row = await rowOf(api, sessionId, 'toolCancel');

        // THE GUARD AGAINST A VISIBILITY-ONLY REIMPLEMENTATION: `toolCancel` is DEMOTED to
        // `visibility: 'searchable'` where it registers (src/harness.ts
        // `registerBaselineDescriptors`, which applies the same demotion `syncDelegateDeclaration`
        // does for a mid-session install) so `toolList`/details stay honest, and it is
        // additionally marked pending-only so the kernel never switches it. A row built from
        // `visibility` alone would call this clickable; the kernel's own predicate is the only
        // thing that gets it right.
        expect(row).toMatchObject({ visibility: 'searchable', declared: false, enabled: false, protected: true });

        const refused = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/toolCancel`, { enabled: true });

        expect(refused.status).toBe(403);
        expect(refused.body.error.message).toContain('protected entry cannot be enabled or disabled');
    });

    it('reports the previously-locked preset rows as switchable and toggles them with 200', async () => {
        stubKeylessSearch();
        const { api } = openToolboxPair(tempRoot('switchable'));
        const sessionId = await sessionOf(api);

        // The other misclassification direction: ten searchable preset rows used to be marked
        // protected (the frozen definition REGISTERS them) and every click on one answered 403,
        // although the kernel switches them happily. `syntax`, `files` and `shell` are the three
        // the operator reported.
        for (const name of ['syntax', 'files', 'shell']) {
            const row = await rowOf(api, sessionId, name);

            expect(row).toMatchObject({ protected: false, enabled: true, declared: false });

            expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/${name}`, { enabled: false })).status).toBe(200);
            expect(await rowOf(api, sessionId, name)).toMatchObject({ enabled: false, protected: false });
            expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/${name}`, { enabled: true })).status).toBe(200);
            expect(await rowOf(api, sessionId, name)).toMatchObject({ enabled: true, protected: false });
        }

        // The DELETE half of the same identity: the row and the route state one fact, so a row
        // the kernel can switch is also a row the session may unregister - previously these ten
        // rows answered 403 "protected" here and the runtime was never asked. `syntax` is the
        // shared catalogue entry the card registered, and the REMOVE operation is the runtime's
        // own, so the answer is a real 200 and a row that is gone.
        const removed = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/syntax`);

        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({
            deleted: true,
            tool_id: 'syntax',
            session_id: sessionId,
            removed_created: false,
            // No inherited copy is handed back: the registration kernel keeps only the installed
            // revision, so the row disappears rather than reverting to a catalogue default.
            restored_inherited: false
        });
        expect(await rowOf(api, sessionId, 'syntax')).toBeUndefined();
    });
});
