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
//   3. a protected entry (a harness-owned control tool) refuses the REMOVAL with 403, and a name
//      with no session-local registration answers 400 - the refusals stay distinguishable. Since
//      T6 the switch is NOT one of the things `protected` refuses: every registered name toggles
//      with 200 (see the T6 block below);
//   4. a metadata-only PATCH (description with no new source) goes through the registration
//      kernel using the INSTALLED revision's own text, so the edit is real instead of refused;
//   5. durability: the changed enabled set and the removal survive a restart, because the
//      session document is written from the harness snapshot at the same commit boundary a
//      registration uses;
//   6. nothing global moved: the deployment catalogue still lists the name the session removed.
//
// R1/R2/R3 (the shared-toolbox fixture at the bottom of this file) pin the row CLASSIFICATION
// and the new-session toolbox state, which the tool-less fixture above cannot even express:
//   7. a brand-new session starts with every row ON - a searchable one through its seeded cap
//      slot, a core or pending-only one through its declaration list - and the only rows that read
//      `enabled: false` are ones this conversation switched off, or one a cap eviction (or a
//      deployment deny) left outside the capped set (R1, and T6's redefinition of the field);
//   8. the `protected` figure IS the kernel's own UNREGISTER answer (the live registry's
//      `visibility === 'core'`, the same test `toolManage remove` makes): a protected row refuses
//      DELETE with 403, a non-protected row removes with 200, no row answers 409, and the SAME
//      protected row toggles its switch with 200 - the flag no longer predicts the PATCH at all;
//   9. both misclassification directions are gone — `delegate` (harness-owned: 403 on DELETE, 200
//      on the switch, and labelled `Core tools`/`core`/session-bound like the global row for the
//      same name) and `syntax`/`files`/`shell` (searchable, switchable, previously locked behind a
//      403);
//  10. `toolCancel` proves the two axes are genuinely separate rather than one flag with two
//      names: it is pending-only, so it holds NO cap slot (which is what the OLD `protected`
//      figure reported), while its REGISTERED visibility is `searchable` - what the kernel's
//      `remove` rule reads and what `protected` reports now. It is therefore switchable AND
//      deletable, and a row built from either predicate alone gets one of the two wrong.
//
// T6 (the session tool switch) adds the block at the bottom of this file, which is the only place
// these server-visible consequences are pinned:
//  11. an `enabled`-only PATCH answers 200 for EVERY registered row, harness-owned core ones
//      included, and there is no longer any 403 or 409 on that route;
//  12. it is accepted WHILE A THREAD IS RUNNING (no idle gate) and lands on that thread's next
//      model request - the real-time requirement;
//  13. a switch of a CORE name is durable: `discovery.withheld` carries it across a restart, and a
//      reset (which clears the switch set) puts it back;
//  14. a switched-off row stays LISTED (`GET /sessions/{id}/tools` is the operator's view of the
//      toolbox, including what the model can no longer see), reports `enabled: false`, and is
//      distinguishable from a cap eviction, which is not the user's decision at all;
//  15. the switch does NOT reach the operator's own doors: a manual REST execution of a switched-off
//      name still runs with 200 and leaves the switch in place. The nested `context.callTool` half of
//      that promise is pinned kernel-side (../harness.discovery.test.ts:1418).
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

    it('switches a harness-owned core tool with 200, and its row follows the switch in both directions', async () => {
        const { api } = openPair(tempRoot('gate-core'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        const row = await rowOf(api, sessionId, 'tasks');

        // T6: a core declaration is ON through its declaration list (nothing to do with a cap
        // slot), while `protected` still says it cannot be UNREGISTERED. Those two figures are
        // now independent, and this row is the case that used to be forced to disagree.
        expect(row).toMatchObject({ protected: true, enabled: true, declared: true, visibility: 'core' });

        const off = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/tasks`, { enabled: false });

        // The reported symptom this replaces: the route answered 403 "harness-owned ... cannot be
        // enabled or disabled" BEFORE the runtime was asked, so the operator could not switch the
        // one class of tool they most wanted off.
        expect(off.status).toBe(200);
        expect(await rowOf(api, sessionId, 'tasks')).toMatchObject({ enabled: false, protected: true, declared: true });

        // A switch is not a removal: the entry is still addressed, still registered, and still
        // carries its declaration figure.
        expect((await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/tasks`)).status).toBe(200);

        const on = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/tasks`, { enabled: true });

        expect(on.status).toBe(200);
        expect(await rowOf(api, sessionId, 'tasks')).toMatchObject({ enabled: true, protected: true });
    });

    it('is accepted while the session is busy — no idle gate, because the switch is real time', async () => {
        const { api, store } = openPair(tempRoot('gate-busy'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        await createTool(api, sessionId, 'liveTool');

        // THE REAL-TIME REQUIREMENT: a thread is running RIGHT NOW. `busy` is exactly what the
        // idle gate read (`assertIdleForToolMutation` in ./api.ts), and the two routes that still
        // carry that gate answer 409 in this state - ./api.test.ts and the DELETE below show it.
        const record = store.liveSession(sessionId);

        record.busy = true;

        try {
            // A core row and a created (cap-slot) row, in both directions, all while busy.
            expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/tasks`, { enabled: false })).status).toBe(200);
            expect(await rowOf(api, sessionId, 'tasks')).toMatchObject({ enabled: false });
            expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/tasks`, { enabled: true })).status).toBe(200);
            expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/liveTool`, { enabled: false })).status).toBe(200);
            expect(await rowOf(api, sessionId, 'liveTool')).toMatchObject({ enabled: false });
            expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/liveTool`, { enabled: true })).status).toBe(200);

            // The two writes that DO replace what a run is executing keep their gate, so the
            // exemption above is scoped to the switch and not to the whole route family.
            const refusedDelete = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/liveTool`);

            expect(refusedDelete.status).toBe(409);
            expect(refusedDelete.body.error.message).toContain('needs the session idle');
        } finally {
            record.busy = false;
        }

        // Nothing half-applied while the session was busy: both rows state the last write.
        expect(await rowOf(api, sessionId, 'tasks')).toMatchObject({ enabled: true });
        expect(await rowOf(api, sessionId, 'liveTool')).toMatchObject({ enabled: true, protected: false });
    });

    it('keeps a CORE switch across a restart, because the snapshot carries the withheld list', async () => {
        const root = tempRoot('gate-core-durable');
        const { api } = openPair(root);
        const sessionId = (await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' })).body.session.id as string;

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/tasks`, { enabled: false })).status).toBe(200);

        const snapshot = readDocument(root).sessions[0].core as HarnessSnapshot;

        // THE DURABILITY ASYMMETRY that is the whole reason `discovery.withheld` exists: a core
        // name never held a cap slot, so `discovery.enabled` cannot state its switch at all - the
        // name appears in `withheld` and in neither list-change. A restart that replayed only
        // `enabled` would hand every core switch back ON.
        expect(snapshot.discovery.withheld).toEqual(['tasks']);
        expect(snapshot.discovery.enabled ?? []).toEqual([]);
        expect((snapshot.createdTools ?? []).map((entry) => entry.name)).toEqual([]);

        const reopened = openPair(root, readDocument(root));

        expect(await rowOf(reopened.api, sessionId, 'tasks')).toMatchObject({ enabled: false, protected: true });

        // And it stays off until the operator (or a reset) puts it back.
        expect((await call(reopened.api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/tasks`, { enabled: true })).status).toBe(200);
        expect(await rowOf(reopened.api, sessionId, 'tasks')).toMatchObject({ enabled: true });
        expect(readDocument(root).sessions[0].core.discovery.withheld ?? []).not.toContain('tasks');
    });

    it('still runs a switched-off tool over REST, because the switch gates the model and not the operator', async () => {
        const { api, store } = openPair(tempRoot('gate-exec'));
        const created = await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' });
        const sessionId = created.body.session.id as string;

        await createTool(api, sessionId, 'quietExec');

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/quietExec`, { enabled: false })).status).toBe(200);
        expect(await rowOf(api, sessionId, 'quietExec')).toMatchObject({ enabled: false });

        // THE SCOPE SENTENCE THE DOCUMENT PROMISES: `PATCH {enabled}` restricts the agents and
        // threads of THIS conversation. A manual execution is the operator's own door - the same
        // door a tool's `context.callTool` uses from inside another tool - so the very name the
        // model can no longer see still runs, and answers with its ordinary result.
        const executed = await call(api, 'POST', `${MOUNT}/sessions/${sessionId}/tools/quietExec/executions`, { parameters: {} });

        expect(executed.status).toBe(200);
        expect(executed.body).toEqual({ ok: true, result: { quietExec: true }, duration_ms: expect.any(Number) });

        // Executing a tool is not a way of re-enabling it: the switch is untouched, so the next
        // model request still does not offer the name.
        expect(await rowOf(api, sessionId, 'quietExec')).toMatchObject({ enabled: false });
        expect(store.liveSession(sessionId).harness.withheldTools).toEqual(['quietExec']);
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

// ---------------------------------------------------------------------------
// R5b (T10) — THE PUSH DOOR. Every case above pins the WRITE: the row, the receipt, the durable
// document. This describe pins the OTHER half of the same route body — ../sessions.ts
// `pushToolState`, the one call that carries the switch to the conversation's live lanes
// (./workers/lane-authority.ts `onToolStateChange` is its twin on the model side). The lane-side
// EFFECT of that frame is ./workers/lane-tool-reconcile.test.ts, whose "level 4" drives this very
// route against real warm lanes; what is under test HERE is the route's accounting — which writes
// fire, how often, and where the push sits against the commit. These stores are inline, so a push
// here is a call, not a delivery: the spy is the right instrument, and the delivery is theirs.
// ---------------------------------------------------------------------------
describe('R5b (T10): an accepted session tool write pushes the lane tool state', () => {
    afterEach(() => {
        // The spies patch the STORE instance a later case would otherwise inherit.
        vi.restoreAllMocks();
    });

    it('pushes once, before the durable commit, for an enabled write that lands', async () => {
        const { store, api } = openPair(tempRoot('push-order'));
        const sessionId = (await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' })).body.session.id as string;

        expect((await createTool(api, sessionId, 'pushTool')).status).toBe(201);

        const journal: string[] = [];

        // BOTH store doors recorded in ONE journal, so the ORDER is asserted rather than inferred.
        // The push comes FIRST: `persistRegistry` can fail (a quota, an IO fault) and turn this
        // request into a 500, and a push parked behind it would leave a warm lane declaring a tool
        // the operator had already switched off — the harness holds the new state either way
        // (../api.ts:4139-4157).
        vi.spyOn(store, 'pushToolState').mockImplementation((id) => {
            journal.push(`push:${id === sessionId}`);
        });
        vi.spyOn(store, 'persistRegistry').mockImplementation(async () => {
            journal.push('persist');
        });

        const off = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/pushTool`, { enabled: false });

        expect(off.status).toBe(200);
        expect(journal).toEqual(['push:true', 'persist']);
        // The push is not a substitute for the write. The commit is mocked (so nothing reached the
        // document here), which is exactly why the check below is the live row and the live switch
        // set: the route handed the lane machinery the state it had already made canonical.
        expect(await rowOf(api, sessionId, 'pushTool')).toMatchObject({ enabled: false });
        expect(store.liveSession(sessionId).harness.withheldTools).toEqual(['pushTool']);
    });

    it('pushes once for a combined patch that restates the gate on top of a re-publication', async () => {
        const { store, api } = openPair(tempRoot('push-combined'));
        const sessionId = (await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' })).body.session.id as string;

        await createTool(api, sessionId, 'comboTool', 'Original description.');

        const journal: string[] = [];

        vi.spyOn(store, 'pushToolState').mockImplementation((id) => {
            journal.push(`push:${id === sessionId}`);
        });
        vi.spyOn(store, 'persistRegistry').mockImplementation(async () => {
            journal.push('persist');
        });

        // The branch with TWO writes in one request: a declaration update, then the gate. One frame
        // per ACCEPTED write, because BOTH of them move canonical state. A re-publication is not a
        // registry-only fact: `registerTool` ends in `enableTools([name])` (src/harness.ts:2408),
        // which moves the declared set (../workers/lane-authority.ts:602 reads `discoveredTools`) —
        // the probe in Temp/t10/probe-create2.ts measured a re-registration moving `glob` to the HEAD
        // of that list with no length change, an order-only move a set comparison would swallow.
        const patched = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/comboTool`, {
            description: 'Rewritten description.',
            enabled: false
        });

        expect(patched.status).toBe(200);
        // TWO commits, TWO frames, each one the canonical state at its own moment: the
        // re-publication pushes and commits inside `registerSessionTool`, then the gate pushes and
        // commits again. The last frame is therefore the FINAL state of the request, and since every
        // lane applies frames in the order they arrive (./workers/lane-worker-loop.ts
        // `applyToolStateSync` is wholesale and convergent), the intermediate frame cannot strand a
        // lane on a half-applied request.
        expect(journal).toEqual(['push:true', 'persist', 'push:true', 'persist']);

        const detail = await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/comboTool`);

        expect(detail.body.tool).toMatchObject({ description: 'Rewritten description.', enabled: false });
        expect(store.liveSession(sessionId).harness.withheldTools).toEqual(['comboTool']);
    });

    it('pushes nothing for a request the route refuses, and once for the un-registration that lands', async () => {
        const { store, api } = openPair(tempRoot('push-refused'));
        const sessionId = (await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' })).body.session.id as string;

        expect((await createTool(api, sessionId, 'refuseTool')).status).toBe(201);

        const pushes: string[] = [];

        vi.spyOn(store, 'pushToolState').mockImplementation((id) => {
            pushes.push(id);
        });

        // A 400 is refused BEFORE the runtime is asked, a 404 never reaches it, and an unknown
        // session is resolved before either: none of them moved a switch, so none of them may post
        // a frame that would tell every lane of a conversation about a change nobody made.
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/refuseTool`, { enabled: 'nope' })).status).toBe(400);
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/nothing`, { enabled: false })).status).toBe(404);
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/absent/tools/refuseTool`, { enabled: false })).status).toBe(404);

        expect(pushes).toEqual([]);

        // THE DOCUMENTED ASYMMETRY, now closed the same way the model door has it. `DELETE`
        // un-registers through the same kernel operation the model's `toolManage remove` uses, and
        // that door posts (./workers/lane-authority.ts `toolSwitchOperationOf`). The frame's `enabled`
        // axis IS the session's declared set (../workers/lane-authority.ts:602 reads
        // `harness.discoveredTools`) and an un-registration empties it of the name — measured live in
        // Temp/t10/probe-create2.ts: removing a created tool takes `enabled` from 25 names to 24 and
        // the name is gone, while `withheld` does not move. So the lane MUST hear: a warm lane that
        // did not would go on declaring a tool its session no longer has.
        //
        // What it still cannot hear is the DEFINITION. An un-publish is a registry fact, the registry
        // axis (./workers/lane-host.ts `broadcastRegistry`) has no caller for a session-local removal
        // (the store fires it only for a lane-created tool), and that gap stays on record at
        // ../api.ts — a replica keeps an implementation it no longer declares, which is the safe
        // direction: declared-but-missing is the one that faults on a call.
        const removed = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/refuseTool`);

        expect(removed.status).toBe(200);
        expect((await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/tools/refuseTool`)).status).toBe(404);
        expect(pushes).toEqual([sessionId]);
        // The state behind that one frame, read off the live harness rather than the spy: the name
        // left the declared set, and nothing else moved.
        expect(store.liveSession(sessionId).harness.discoveredTools).not.toContain('refuseTool');
        expect(store.liveSession(sessionId).harness.withheldTools).toEqual([]);
    });

    it('pushes once for a creation, and once for a content-only patch that only reorders the declared set', async () => {
        const { store, api } = openPair(tempRoot('push-registration'));
        const sessionId = (await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' })).body.session.id as string;

        expect((await createTool(api, sessionId, 'headTool')).status).toBe(201);

        // Read the same way the authority does (../workers/lane-authority.ts:602): the seam exists on
        // a harness build that carries it, and the defensive read is what the frame is built from.
        const declared = () =>
            [...((store.liveSession(sessionId).harness as unknown as { discoveredTools?: string[] }).discoveredTools ?? [])];

        // A creation lands at the HEAD of the declared order (probe: Temp/t10/probe-create2.ts).
        expect(declared()[0]).toBe('headTool');

        const pushes: { id: string; declared: string[] }[] = [];

        // The spy can only record the CALL — `pushToolState(sessionId)` takes the id and reads the
        // state itself (../sessions.ts) — so the figure captured here is the declared set at the
        // instant the route pushed, which is the figure the frame carried.
        vi.spyOn(store, 'pushToolState').mockImplementation((id) => {
            pushes.push({ id, declared: declared() });
        });

        expect((await createTool(api, sessionId, 'tailTool')).status).toBe(201);

        // ONE frame for the creation, and the created name IS in it. Before this trigger existed the
        // creation moved the declared set silently, so a sibling warm lane kept declaring the OLD set
        // until its next blueprint — the gap T7's claim names.
        expect(pushes.map((entry) => entry.id)).toEqual([sessionId]);
        expect(pushes[0]!.declared.slice(0, 2)).toEqual(['tailTool', 'headTool']);
        expect(pushes[0]!.declared).toContain('tailTool');

        // A CONTENT-ONLY patch, with the gate untouched: the re-publication re-enables the name,
        // which puts it back at the head. The LIST changed but no SET did — `['a','b']` and `['b','a']`
        // hold the same names — so an authority that compared sets would have stayed silent while a
        // lane went on declaring the old order.
        const patched = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/headTool`, {
            description: 'Rewritten without touching the gate.'
        });

        expect(patched.status).toBe(200);
        expect(pushes.map((entry) => entry.id)).toEqual([sessionId, sessionId]);
        expect(pushes[1]!.declared.slice(0, 2)).toEqual(['headTool', 'tailTool']);
        expect([...pushes[1]!.declared].sort()).toEqual([...pushes[0]!.declared].sort());
    });

    it('pushes on every accepted repeat, because a re-click is how an operator heals a missed frame', async () => {
        const { store, api } = openPair(tempRoot('push-repeat'));
        const sessionId = (await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'tooling' })).body.session.id as string;

        await createTool(api, sessionId, 'againTool');

        const pushes: string[] = [];

        vi.spyOn(store, 'pushToolState').mockImplementation((id) => {
            pushes.push(id);
        });

        const first = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/againTool`, { enabled: false });
        const second = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/againTool`, { enabled: false });

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        // TWO frames for a state that moved ONCE. The authority's own door gates on the move
        // (./workers/lane-authority.ts `notifyToolStateChange`) because a model re-asks inside a live
        // turn; the operator's door does not, because a one-way frame is never acknowledged and a
        // repeat click is the only way to re-send one. `applyToolStateSync` is wholesale and
        // convergent (./workers/lane-worker-loop.ts), so the second can land anywhere and must land
        // nowhere new.
        expect(pushes).toEqual([sessionId, sessionId]);
        // And the state it repeats is the state that stands: one withheld entry, not two.
        expect(store.liveSession(sessionId).harness.withheldTools).toEqual(['againTool']);

        const back = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/againTool`, { enabled: true });

        expect(back.status).toBe(200);
        expect(pushes).toEqual([sessionId, sessionId, sessionId]);
        expect(store.liveSession(sessionId).harness.withheldTools).toEqual([]);
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
//   - 32 rows total, in the registry order `ROW_ORDER` states below (the order the model sees
//     them, and the order `namesWhere` compares against);
//   - 32 of them `enabled: true` on a session that has never run. T6 is why the number is 32 and
//     not 22: `enabled` answers "may an agent of this conversation call it", so the 22 names that
//     hold a cap slot are on because the seed filled the slots, and the 10 that hold NO slot
//     (`SLOTLESS_NAMES`) are on because their declaration list puts them in context on every
//     request. Before T6 the second group read `enabled: false`, which is a row calling a live,
//     callable, always-in-context tool "off";
//   - 9 `protected` (`PROTECTED_NAMES`) - the names the kernel will not let this conversation
//     UNREGISTER, i.e. whose registered `visibility` is `core`. The tenth slotless name,
//     `toolCancel`, is NOT one of them: it registers at `visibility: 'searchable'`, so its
//     `remove` is accepted, and the old figure (`!isToolSwitchable`) called it un-registerable
//     because it is pending-only - a cap-slot answer wearing an unregister flag;
//   - 8 declared - the frozen definition's `coreTools`, which is the set in context on every
//     request (NOT `definition.tools`, the 15-name registered list).
// ===========================================================================

// The rows this conversation may NOT un-register (`harness.tools[name].visibility === 'core'`,
// the live-registry test ./api.ts `deleteSessionTool` and ../harness.ts `toolManage remove` make).
// Stated in ROW ORDER, because every `namesWhere` comparison below is order-sensitive.
const PROTECTED_NAMES = [
    'toolRequest',
    'tasks',
    'delegate',
    'read',
    'write',
    'edit',
    'glob',
    'grep',
    'fetch'
];

// The rows that hold NO searchable cap slot: the nine harness-owned ones plus the pending-only
// `toolCancel`, in ROW ORDER. They are `enabled: true` through their declaration list, they never
// appear in `discovery.enabled`, and their switch lives ONLY in `discovery.withheld`.
const SLOTLESS_NAMES = [
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

// The complement: every name that competes for one of the `maxEnabledTools` slots, and therefore
// starts ON only because the construction seed filled them (R1).
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

// All 32 rows in the server's own order, so an "everything is on" assertion cannot be satisfied
// by a reordered or partially populated list.
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

// The declared core set - `coreTools` of the frozen definition, in definition order. This is NOT
// "the protected rows minus `fetch`": `fetch` is kernel-protected (its registered visibility is
// `core`, so DELETE answers 403) yet absent from the declaration list, because `describeHarness`
// declares the core file/record controls and `delegate` only - the environment-backed and
// always-mounted extras are in context through the kernel, not through the declaration.
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

describe('R1 — a brand-new session starts with the whole toolbox on', () => {
    it('enables every row, and reports `protected` as the UNREGISTER answer only', async () => {
        stubKeylessSearch();
        const { api } = openToolboxPair(tempRoot('seed'));
        const sessionId = await sessionOf(api);
        const rows = await rowsOf(api, sessionId);

        // The reconciliation for a fresh harness, stated as exact name lists.
        expect(rows.length).toBe(32);
        expect(rows.map((row) => row.name)).toEqual(ROW_ORDER);
        // T6: EVERY row is callable on a fresh session - 22 through their seeded cap slots, 10
        // through a declaration list that needs no slot. "0 enabled for a core row" was the lie.
        expect(namesWhere(rows, (row) => row.enabled)).toEqual(ROW_ORDER);
        expect(namesWhere(rows, (row) => row.protected)).toEqual(PROTECTED_NAMES);
        expect(namesWhere(rows, (row) => row.declared)).toEqual(DECLARED_NAMES);

        // ONE rule stated twice, now stated honestly: no row is `enabled: false` on a session that
        // has never run, and the slotless group is exactly the group that owes its ON state to a
        // declaration rather than to a cap slot.
        expect(namesWhere(rows, (row) => !row.enabled)).toEqual([]);
        expect(namesWhere(rows, (row) => row.enabled && !row.protected && !ENABLED_NAMES.includes(row.name as string))).toEqual([
            'toolCancel'
        ]);

        // The seeded names hold a slot without being declared, which is what `discovered` means on
        // a row; the declared core set, the pending-only control, and the always-mounted `fetch`
        // do not - and `origin` stays keyed on the CAPPED SET, so `write` being `enabled: true` has
        // not relabelled it `discovered`.
        expect(namesWhere(rows, (row) => row.origin === 'discovered')).toEqual(ENABLED_NAMES);
        expect(namesWhere(rows, (row) => row.origin === 'catalogue')).toEqual(SLOTLESS_NAMES);
        // THE TWO AXES, stated separately: the one row that is slotless WITHOUT being protected is
        // `toolCancel` (pending-only, registered `searchable`), and the one that is protected
        // WITHOUT being declared is `fetch`. Deriving either flag from the other breaks one of them.
        expect(namesWhere(rows, (row) => SLOTLESS_NAMES.includes(row.name as string) && !row.protected)).toEqual(['toolCancel']);
        expect(namesWhere(rows, (row) => row.protected && !row.declared)).toEqual(['fetch']);
    });

    it('answers 200 for EVERY row the pane offers, never 403 and never 409', async () => {
        stubKeylessSearch();
        const { api } = openToolboxPair(tempRoot('seed-sweep'));
        const sessionId = await sessionOf(api);
        const rows = await rowsOf(api, sessionId);

        // The sweep the report ran by hand ("click delegate -> error pill"): every row in the
        // pane, asked to move to the state it is NOT in. After T6 the status is the SAME for all
        // of them, because the switch has no exception - the row figure that used to predict a
        // 403 here now predicts only what DELETE does.
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
        expect(namesWhere(rows, (row) => statuses.get(row.name as string) === 403)).toEqual([]);
        expect(namesWhere(rows, (row) => statuses.get(row.name as string) === 200)).toEqual(ROW_ORDER);

        // The re-read the sweep's effect is measured against.
        const after = await rowsOf(api, sessionId);

        // Every row is off afterwards, in BOTH groups, and that is the honest figure. The call axis
        // reads the conversation's switch FIRST (`withheldTools`), and the kernel records that switch
        // for every registered name - including the 10 that hold no cap slot, whose ON state comes
        // from the declaration list rather than from `discoveredTools`. Their `enabled: true` at
        // creation is not a fixed flag; it is the answer "nothing has switched this off".
        expect(namesWhere(after, (row) => row.enabled)).toEqual([]);
        expect(namesWhere(after, (row) => row.protected)).toEqual(PROTECTED_NAMES);

        // Off is not gone: the operator still sees all 32 rows, which is the point of a switch that
        // hides a tool from the MODEL only.
        expect(after.length).toBe(32);
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
        // A searchable disable is written TWICE - out of the capped set AND into the switch list -
        // and the row figure reads the second one, which is what keeps it distinguishable from a
        // cap eviction (that one never enters `withheld`).
        expect(snapshot.discovery.withheld).toEqual(['syntax']);

        const reopened = openToolboxPair(root, readDocument(root));
        const rows = await rowsOf(reopened.api, sessionId);

        // AC4: the restore changes no switch state. The restore BUILD now runs the seed pass
        // (src/server/sessions.ts — that is what arms the reset re-run in this process), but
        // `harness.restore()` replaces the enabled set with the persisted one straight afterwards,
        // so the conversation comes back with exactly what it committed: the one name it switched
        // off is still off after the restart, and nothing else moved.
        expect(namesWhere(rows, (row) => row.enabled)).toEqual(ROW_ORDER.filter((name) => name !== 'syntax'));
    });
});

describe('R3 — `protected` is the kernel UNREGISTER refusal, and nothing else', () => {
    it('classifies `delegate` as protected core, and SWITCHES it with 200 instead of refusing', async () => {
        stubKeylessSearch();
        const { api, store } = openToolboxPair(tempRoot('delegate'));
        const sessionId = await sessionOf(api);

        const row = await rowOf(api, sessionId, 'delegate');

        expect(row).toMatchObject({
            declared: true,
            // T6: `enabled` is the CALL axis - "may an agent of this conversation call it right
            // now" - and a declared core tool is in context on every request, so it is ON.
            // `protected` answers a DIFFERENT question ("may this conversation un-register it"),
            // and that answer is still true. Before T6 both fields carried the unregister answer,
            // which is why the pane showed a live, callable tool as "off" and refused the click.
            enabled: true,
            protected: true,
            visibility: 'core',
            group: 'Core tools',
            session_bound: true,
            origin: 'catalogue'
        });

        const off = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/delegate`, { enabled: false });

        // THE REPORTED SYMPTOM THIS REPLACES ("click delegate -> error pill"): the route answered
        // 403 "harness-owned ... cannot be enabled or disabled" BEFORE the runtime was asked.
        // `delegate` is core AND holds a searchable slot, so the kernel switches it happily and the
        // write lands in this conversation's own withheld set.
        expect(off.status).toBe(200);
        expect(await rowOf(api, sessionId, 'delegate')).toMatchObject({ enabled: false, protected: true, declared: true });

        // Where that switch lives: this conversation's own `withheldTools` list. The cap-mutation
        // log is not exposed on the server-side handle at all, because the cap set never moved here
        // — the snapshot proof of that is in the durability case above (`discovery.enabled` stays
        // empty for a name that has no slot).
        const session = store.liveSession(sessionId);

        expect(session.harness.withheldTools).toEqual(['delegate']);

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/delegate`, { enabled: true })).status).toBe(200);
        expect(session.harness.withheldTools).toEqual([]);
        expect(await rowOf(api, sessionId, 'delegate')).toMatchObject({ enabled: true, protected: true });

        // The protection still owns the one thing it has always owned: the unregister route.
        const refusedDelete = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/delegate`);

        expect(refusedDelete.status).toBe(403);
        expect(refusedDelete.body.error.message).toContain('cannot be unregistered');
        expect(await rowOf(api, sessionId, 'delegate')).toMatchObject({ protected: true, enabled: true });

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

    it('reports the pending-only `toolCancel` as switchless but NOT protected, and lets DELETE take it away', async () => {
        stubKeylessSearch();
        const { api, store } = openToolboxPair(tempRoot('cancel'));
        const sessionId = await sessionOf(api);

        const row = await rowOf(api, sessionId, 'toolCancel');

        // THE GUARD AGAINST BOTH DERIVATIONS AT ONCE. `toolCancel` is DEMOTED to
        // `visibility: 'searchable'` where it registers (src/harness.ts `registerBaselineDescriptors`,
        // the same demotion `syncDelegateDeclaration` applies to a mid-session install) and is
        // additionally marked pending-only, so it never occupies a searchable cap slot:
        //  - a `protected` built from `!isToolSwitchable` (the pre-T6 figure) called it
        //    un-registerable, which is wrong - the kernel's `remove` accepts it, as the DELETE below
        //    proves with a 200;
        //  - an `enabled` built from the capped set alone called it "off", which is also wrong - a
        //    pending-only name is in context through the declaration list, so it is callable without
        //    ever holding a slot.
        // T6 states each fact from its own source: `protected` from the registered visibility,
        // `enabled` from the call axis (switch first, cap set second).
        expect(row).toMatchObject({ visibility: 'searchable', declared: false, enabled: true, protected: false });

        const off = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/toolCancel`, { enabled: false });

        // Accepted, and REAL: a pending-only name has no cap slot to evict, so its switch lives only
        // in this conversation's withheld list - which is exactly the state the row reports.
        expect(off.status).toBe(200);
        expect(await rowOf(api, sessionId, 'toolCancel')).toMatchObject({ enabled: false, protected: false });
        expect(store.liveSession(sessionId).harness.withheldTools).toContain('toolCancel');

        const on = await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/toolCancel`, { enabled: true });

        expect(on.status).toBe(200);
        expect(await rowOf(api, sessionId, 'toolCancel')).toMatchObject({ enabled: true, protected: false });

        const removed = await call(api, 'DELETE', `${MOUNT}/sessions/${sessionId}/tools/toolCancel`);

        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({
            deleted: true,
            tool_id: 'toolCancel',
            session_id: sessionId,
            removed_created: false,
            // The registration kernel keeps only the installed revision, so the row disappears
            // instead of reverting to a catalogue default.
            restored_inherited: false
        });
        expect(await rowOf(api, sessionId, 'toolCancel')).toBeUndefined();
    });

    it('keeps a withheld row in the toolbox with `enabled: false` — a switch hides a tool from the model, never from the operator', async () => {
        stubKeylessSearch();
        const { api, store } = openToolboxPair(tempRoot('withheld-row'));
        const sessionId = await sessionOf(api);

        // Before the switch: the row holds a cap slot, so it is `discovered` (the label the CAPPED
        // SET drives, which is NOT the same figure as the call axis).
        expect(await rowOf(api, sessionId, 'syntax')).toMatchObject({ enabled: true, protected: false, origin: 'discovered' });

        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/syntax`, { enabled: false })).status).toBe(200);

        const rows = await rowsOf(api, sessionId);

        // THE CONTRACT THE FRONTEND SWITCH LIST DEPENDS ON: the row set never shrinks, so a tool the
        // operator turned off can still be turned back on from this same list. A disabled tool
        // disappears only from the MODEL's tool list.
        expect(rows.map((row) => row.name)).toEqual(ROW_ORDER);
        expect(namesWhere(rows, (row) => row.enabled)).toEqual(ROW_ORDER.filter((name) => name !== 'syntax'));

        // The kernel state behind that one row: BOTH axes move, because a disable on a name with a
        // slot evicts the slot AND records the switch. `origin` follows the slot, so the row now
        // reads `catalogue` again - which is precisely why `origin` is not the call axis and a
        // client must read `enabled` for that.
        expect(rows.find((row) => row.name === 'syntax')).toMatchObject({ enabled: false, protected: false, origin: 'catalogue' });

        // A CAP EVICTION answers the same `enabled: false` for a different reason, and the two stay
        // distinguishable: an evicted or undiscovered name is merely absent from the capped set and
        // NEVER appears in the withheld list, which is the operator's own record. That is why the
        // withheld list above is stated exactly rather than as "contains the name".
        const session = store.liveSession(sessionId);

        expect(session.harness.withheldTools).toEqual(['syntax']);
        expect(session.harness.discoveredTools).not.toContain('syntax');

        // Re-enabling restores both figures, so the switch is reversible from this surface alone.
        expect((await call(api, 'PATCH', `${MOUNT}/sessions/${sessionId}/tools/syntax`, { enabled: true })).status).toBe(200);
        expect(session.harness.withheldTools).toEqual([]);
        expect(session.harness.discoveredTools).toContain('syntax');
        expect(await rowOf(api, sessionId, 'syntax')).toMatchObject({ enabled: true, origin: 'discovered' });
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
