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
// Cross-references:
//   - ../harness.ts               â€” `toolManage enable|disable|remove`
//   - ./api.ts                    â€” `setSessionToolEnabled`, `patchSessionTool`, `deleteSessionTool`
//   - ./api-reads.ts              â€” `sessionToolRowsOf` (`enabled`/`protected`/`origin`)
//   - ./persistence.ts            â€” the session `core` snapshot that carries the enabled set

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agent, harness } from '../harness';
import type { HarnessPreset, HarnessSnapshot } from '../harness';
import type { RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
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
const openPair = (root: string, database?: Record<string, unknown>) => {
    const registry = createHarnessRegistry([preset()]);
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

        const row = await rowOf(api, sessionId, 'task');

        expect(row).toMatchObject({ protected: true });

        const refused = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/task`, { enabled: false });

        expect(refused.status).toBe(403);
        expect(refused.body.error.message).toContain('harness-owned');

        // The refusal is a refusal, not a partial write: the row is unchanged.
        expect(await rowOf(api, sessionId, 'task')).toMatchObject({ protected: true, enabled: row!.enabled });
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

        const refused = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/task`);

        expect(refused.status).toBe(403);
        expect(refused.body.error.message).toContain('cannot be unregistered');
        expect(await rowOf(api, sessionId, 'task')).toMatchObject({ protected: true });
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
