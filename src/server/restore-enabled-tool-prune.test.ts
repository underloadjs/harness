// R1 restore tolerance: a stale ENABLED TOOL name costs a switch, not a conversation.
//
// WHY THIS FILE EXISTS. `create` seeds a brand-new session with every name the kernel can
// switch (src/server/sessions.ts `buildHarness(preset, settings, ..., { enableAllTools: true })`,
// ../types/index.ts `HarnessConfiguration.enableAllTools`), so a persisted
// `core.discovery.enabled` is ~22 names on the FIRST save rather than the handful a couple of
// `toolRequest` rounds used to leave behind. The kernel refuses an enabled name the rebuilt
// harness does not register:
//   `Snapshot discovery names "X", which is not registered in this harness.`
//   (../harness.ts:11611-11617)
// and the store's load loop turns that throw into a PER-SESSION DROP
// (src/server/sessions.ts:1731-1737 -> `noteRestoreError`), so the ordinary operational
// events below silently DELETED whole conversations:
//   - a web-search key is removed, so `search` stops registering;
//   - a plugin is unregistered;
//   - an app tool is edited out of a harness card.
// The repair is `pruneStaleEnabledTools` (src/server/sessions.ts): the STORE drops the
// enabled names the rebuilt harness cannot register, keeps every other name exactly as
// committed, and reports one tolerated line on the restore channel. The KERNEL stays
// strict — ./restore-isolation.test.ts pins that — and the lane replica has always done the
// same thing for its own rebuilt copy (./workers/lane-worker-loop.ts:1391).
//
// What is pinned, exactly:
//   1. a SEEDED snapshot carrying one now-unregistered name restores SUCCESSFULLY, with the
//      remaining names still enabled in the same order, and the session still listed,
//      addressable, and runnable;
//   2. the row view states the same truth: every switchable row is still `enabled: true`, and
//      the name this build does not register is not a row at all (a pruned name cannot be
//      shown as a switch the operator flipped off, because the tool is gone);
//   3. the drop is OBSERVABLE: one line on `restoreErrors` and the injected `onRestoreError`
//      reporter (stderr when the host injected none), and that line is the ONLY entry for a
//      session that is still listed;
//   4. the stale name is FORGOTTEN, not re-pruned forever: the next save writes the pruned
//      enabled set, so a third load reports nothing;
//   5. a tool the session CREATED keeps its enabled slot. `createdTools` names are not in the
//      registry yet when the store decides what to prune, and `restore()` re-registers them
//      (../harness.ts:11609 counts them as available), so a name the snapshot itself provides
//      is never pruned. Without that half of the predicate this is the case that would
//      regress: the session's own runtime tool would come back switched off after a restart;
//   6. a snapshot that needs NO pruning is restored with no diagnostic at all (the tolerant
//      path is silent, so `restoreErrors` keeps its "what went wrong" meaning).
//
// Everything runs against injected scripted presets and a REAL database root under the
// repo-root Temp/ directory (no provider, no network), exactly like
// ./restore-isolation.test.ts and ./persistence.test.ts. "Restart" always means a FRESH
// runtime over the same root, never a reused instance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessStream, HarnessStreamEvent } from '../harness';
import { createHarnessRegistry, createToolCatalogue, createWebSearchCatalogueEntry, describeHarness } from './harnesses';
import { SHARED_TOOL_NAMES, createToolboxHarness } from './harnesses/toolbox';
import type { HarnessPreset } from './harnesses/types';
import type { RunnerSettings } from './harnesses/types';
import { HarnessPersistence } from './persistence';
import type { HarnessDatabase } from './persistence';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { SessionStore } from './sessions';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-enabled-tool-prune-${label}-`));
    roots.push(root);
    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://prune.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'prune/test'
};

const DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

// Force the unconfigured search entry so the seeded population never depends on the test
// runner's environment (nor on a developer's .env) — same rule as ./restore-isolation.test.ts.
const CATALOGUE = createToolCatalogue({
    websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
});

const MOUNT = '/v1/harness';

const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// THE SEEDED TOOLBOX. The same `createToolboxHarness` factory every shipped card uses, so the
// enabled set these tests prune is the real production population, not a fixture approximation.
const toolboxPreset = (): HarnessPreset => ({
    name: 'toolbox',
    title: 'Toolbox',
    description: 'Shared-toolbox fixture: the real production rows, scripted model.',
    requiresEndpoint: false,
    primary: 'boss',
    // A non-empty allowlist is what makes `delegate` register as a core declaration, i.e. the
    // protected row the original report clicked.
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
                    boss: agent({
                        model: settings.model,
                        instruction: 'Scripted toolbox boss.',
                        stream: answerStream('ok')
                    }),
                    helper: agent({
                        model: settings.model,
                        instruction: 'Scripted toolbox helper.',
                        stream: answerStream('ok')
                    })
                },
                primary: 'boss',
                subagents: ['helper']
            },
            settings,
            progress,
            // Forwarded UNMODIFIED, exactly as a shipped card receives it, so the store's
            // per-build `enableAllTools` reaches `HarnessConfiguration`.
            report
        )
});

// A card that registers NOTHING switchable of its own, so the only enabled name in its records
// is a tool the session created itself (pin 5). Same shape as the `tooling` fixture in
// ./api-session-tool-writes.test.ts.
const barePreset = (): HarnessPreset => ({
    name: 'bare',
    title: 'Bare',
    description: 'Tool-less fixture: created tools only.',
    requiresEndpoint: false,
    primary: 'solo',
    subagents: [],
    agents: ['solo'],
    tools: [],
    builtin: false,
    editable: true,
    create: (settings, progress, report) =>
        harness({
            agents: {
                solo: agent({
                    model: settings.model,
                    instruction: 'Scripted bare agent.',
                    stream: answerStream('ok')
                })
            },
            primary: 'solo',
            presets: false,
            // Forwarded UNMODIFIED so the store's persistence observer is attached, which is
            // what makes `createdTools` and the enabled set durable in the record below.
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
});

// The seeded population, restated as exact names (the same list
// ./api-session-tool-writes.test.ts pins for this fixture; `search` is absent because the
// catalogue above is keyless). If this drifts, the prune figures below drift with it, which is
// the point of restating it rather than reading it back from the harness.
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

const runtimeOf = (root: string, presets: readonly HarnessPreset[]): HarnessRuntime =>
    createHarnessRuntime({
        root,
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry([...presets]),
        catalogue: CATALOGUE,
        loadEnvironment: false
    });

const stateFile = (root: string): string => path.join(root, 'harness', 'state.json');

type StoredDocument = {
    version: number;
    savedAt: number;
    registry: unknown[];
    sessions: {
        id: string;
        queue: string[];
        core: {
            discovery?: { enabled?: string[]; offsets?: unknown[] };
            createdTools?: { name: string }[];
        } & Record<string, unknown>;
    }[];
};

const readDocument = (root: string): StoredDocument =>
    JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as StoredDocument;

const writeDocument = (root: string, document: StoredDocument): void => {
    fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');
};

// Append ONE enabled name to one session's committed snapshot, in the exact shape a real
// pre-rename `state.json` carries it: an `enabled` list naming a tool this build no longer
// registers, next to names that still resolve.
const tamperDiscovery = (root: string, id: string, staleName: string): void => {
    const document = readDocument(root);
    const session = document.sessions.find((entry) => entry.id === id);

    if (session === undefined) throw new Error(`state.json holds no session "${id}".`);

    const enabled = session.core.discovery?.enabled ?? [];

    if (enabled.includes(staleName)) throw new Error(`the snapshot already names "${staleName}".`);

    session.core.discovery = { ...(session.core.discovery ?? {}), enabled: [...enabled, staleName] };
    writeDocument(root, document);
};

// The tolerated line, composed the way production composes it (src/server/sessions.ts
// `noteToleratedRestore`). It is NOT a drop: the session stays listed and usable.
const toleratedLine = (id: string, kept: number, dropped: readonly string[]): string =>
    `Session "${id}" restored with ${kept} enabled tool(s); ` +
    `${dropped.length} name(s) this build does not register were switched off: ${dropped.join(', ')}.`;

const callApi = async (
    runtime: HarnessRuntime,
    method: string,
    rawPathname: string,
    body: unknown = {}
): Promise<{ status: number; body: Record<string, any> }> => {
    const [pathname, query] = rawPathname.split('?');
    const result = await runtime.api({
        method,
        pathname: pathname!,
        mount: MOUNT,
        ...(query === undefined ? {} : { searchParams: new URLSearchParams(query) }),
        readBody: async <T>() => body as T
    });

    if (result.kind !== 'json') throw new Error(`expected a JSON answer from ${method} ${rawPathname}`);

    return { status: result.status, body: result.body as Record<string, any> };
};

/** The live enabled set one restored session actually holds, in snapshot order. */
const enabledOf = (runtime: HarnessRuntime, id: string): string[] => [
    ...(runtime.store.liveSession(id).harness.discoveredTools as string[])
];

/** The toolbox rows for one session, as the pane reads them. */
const rowsOf = async (runtime: HarnessRuntime, id: string): Promise<Record<string, any>[]> => {
    const page = await callApi(runtime, 'GET', `${MOUNT}/sessions/${id}/tools?limit=100`);

    expect(page.status).toBe(200);

    return page.body.items as Record<string, any>[];
};

const namesWhere = (rows: Record<string, any>[], predicate: (row: Record<string, any>) => boolean): string[] =>
    rows.filter(predicate).map((row) => row.name as string);

/** Create one session through the real route, so the seed is the production seed. */
const createSession = async (runtime: HarnessRuntime, harnessName: string): Promise<string> => {
    const created = await callApi(runtime, 'POST', `${MOUNT}/sessions`, { harness: harnessName });

    expect(created.status).toBe(201);

    return (created.body.session as { id: string }).id;
};

describe('a stale enabled tool name is tolerated on restore (R1 seed)', () => {
    it('keeps the session and every other enabled name when one seeded name is no longer registered', async () => {
        const root = tempRoot('keep');
        const presets = [toolboxPreset()];
        const first = runtimeOf(root, presets);
        const sessionId = await createSession(first, 'toolbox');

        // The fixture really is the seeded toolbox: a fresh session states every switchable
        // name as enabled, before any pruning is in play.
        expect(enabledOf(first, sessionId)).toEqual(ENABLED_NAMES);
        first.store.dispose();

        tamperDiscovery(root, sessionId, 'commandRun');

        // The tampered document is the shape a real stale record has: 22 live names plus one
        // that resolves nowhere.
        expect(readDocument(root).sessions[0].core.discovery?.enabled).toEqual([...ENABLED_NAMES, 'commandRun']);

        const second = runtimeOf(root, presets);

        // R6/R7 semantics are unchanged for this record: it is NOT dropped.
        expect(second.store.list().map((session) => session.id)).toEqual([sessionId]);
        expect(second.store.size).toBe(1);

        // The remaining names keep their exact committed state — same names, same order — and
        // only the unresolvable one is gone.
        expect(enabledOf(second, sessionId)).toEqual(ENABLED_NAMES);

        // The rows the pane renders state the same fact: everything switchable is still ON,
        // and a name this build does not register is not a row at all.
        const rows = await rowsOf(second, sessionId);

        expect(namesWhere(rows, (row) => row.enabled)).toEqual(ENABLED_NAMES);
        expect(rows.some((row) => row.name === 'commandRun')).toBe(false);

        // One tolerated line, no drop diagnostic.
        expect(second.store.restoreErrors).toEqual([toleratedLine(sessionId, ENABLED_NAMES.length, ['commandRun'])]);

        // And the conversation still works: the prune cost it a switch, not the session.
        await second.store.run(sessionId, 'continue after the prune', async () => {});
        expect(second.store.get(sessionId).turns.map((turn) => [turn.prompt, turn.status])).toEqual([
            ['continue after the prune', 'done']
        ]);

        const listed = await callApi(second, 'GET', `${MOUNT}/sessions/${sessionId}`);

        expect(listed.status).toBe(200);
        expect((listed.body as { session: { id: string } }).session.id).toBe(sessionId);

        second.store.dispose();
    });

    it('writes the pruned set back so the next restart needs no prune and reports nothing', async () => {
        const root = tempRoot('forget');
        const presets = [toolboxPreset()];
        const first = runtimeOf(root, presets);
        const sessionId = await createSession(first, 'toolbox');

        first.store.dispose();

        tamperDiscovery(root, sessionId, 'webSearch');

        const second = runtimeOf(root, presets);

        expect(second.store.restoreErrors).toEqual([toleratedLine(sessionId, ENABLED_NAMES.length, ['webSearch'])]);

        // Any persistence-eligible change commits the pruned enabled set: the store re-captures
        // `session.core` from the live harness right after restore, so the stale name is
        // already out of the committed document.
        second.store.dispose();

        expect(readDocument(root).sessions[0].core.discovery?.enabled).toEqual(ENABLED_NAMES);

        const third = runtimeOf(root, presets);

        expect(third.store.restoreErrors).toEqual([]);
        expect(enabledOf(third, sessionId)).toEqual(ENABLED_NAMES);

        third.store.dispose();
    });

    it('reports the tolerated prune to the injected onRestoreError reporter instead of stderr', async () => {
        const root = tempRoot('reporter');
        const presets = [toolboxPreset()];
        const first = runtimeOf(root, presets);
        const sessionId = await createSession(first, 'toolbox');

        first.store.dispose();

        tamperDiscovery(root, sessionId, 'fileEdit');

        const database: HarnessDatabase | undefined = new HarnessPersistence(root).load();

        if (database === undefined) throw new Error('the tampered document did not load');

        const reported: string[] = [];
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const registry = createHarnessRegistry([...presets]);
            const store = new SessionStore(SETTINGS, registry, (preset) => describeHarness(preset, CATALOGUE), {
                persistence: new HarnessPersistence(root),
                database,
                onRestoreError: (error) => {
                    reported.push(error.message);
                }
            });

            expect(reported).toEqual([toleratedLine(sessionId, ENABLED_NAMES.length, ['fileEdit'])]);
            expect(store.restoreErrors).toEqual(reported);
            expect(store.list().map((session) => session.id)).toEqual([sessionId]);

            // The host opted in, so the stderr default stays silent.
            expect(
                stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[harness]'))
            ).toEqual([]);

            store.dispose();
        } finally {
            stderr.mockRestore();
        }
    });

    it('logs the tolerated prune to stderr when the host injects no reporter', async () => {
        const root = tempRoot('stderr');
        const presets = [toolboxPreset()];
        const first = runtimeOf(root, presets);
        const sessionId = await createSession(first, 'toolbox');

        first.store.dispose();

        tamperDiscovery(root, sessionId, 'agentDelegate');

        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const second = runtimeOf(root, presets);

            expect(second.store.list().map((session) => session.id)).toEqual([sessionId]);
            expect(
                stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[harness]'))
            ).toEqual([
                `[harness] kept a session whose enabled set named a tool this build lost: ${toleratedLine(
                    sessionId,
                    ENABLED_NAMES.length,
                    ['agentDelegate']
                )}`
            ]);

            second.store.dispose();
        } finally {
            stderr.mockRestore();
        }
    });

    it('leaves an untouched seeded snapshot enabled exactly as it was, with no diagnostic', async () => {
        const root = tempRoot('clean');
        const presets = [toolboxPreset()];
        const first = runtimeOf(root, presets);
        const sessionId = await createSession(first, 'toolbox');

        first.store.dispose();

        const second = runtimeOf(root, presets);

        // The no-op path is silent AND byte-exact: no names dropped, no line reported.
        expect(second.store.restoreErrors).toEqual([]);
        expect(enabledOf(second, sessionId)).toEqual(ENABLED_NAMES);

        second.store.dispose();
    });
});

describe('a created tool keeps its slot through a restart', () => {
    it('keeps a session-created tool enabled, because the snapshot re-registers it', async () => {
        const root = tempRoot('created');
        const presets = [barePreset()];
        const first = runtimeOf(root, presets);
        const sessionId = await createSession(first, 'bare');

        // No toolbox, so nothing is seeded: the created tool is the ONLY enabled name.
        expect(enabledOf(first, sessionId)).toEqual([]);

        const registered = await callApi(first, 'POST', `${MOUNT}/sessions/${sessionId}/tools`, {
            name: 'pruneProbe',
            description: 'Created tool that must survive a restart.',
            tags: ['test', 'prune'],
            module_text: `
export const metadata = {
    name: 'pruneProbe',
    description: 'Created tool that must survive a restart.',
    tags: ['test', 'prune']
};
export const execute = () => ({ pruneProbe: true });
`
        });

        expect(registered.status).toBe(201);
        expect(enabledOf(first, sessionId)).toEqual(['pruneProbe']);

        // The durable statement of a created tool: the name lives in `createdTools` AND in the
        // enabled set, and that is precisely the pair the prune must not split.
        const stored = readDocument(root).sessions[0].core;

        expect((stored.createdTools ?? []).map((created) => created.name)).toEqual(['pruneProbe']);
        expect(stored.discovery?.enabled).toEqual(['pruneProbe']);

        first.store.dispose();

        const second = runtimeOf(root, presets);

        expect(second.store.restoreErrors).toEqual([]);
        expect(enabledOf(second, sessionId)).toEqual(['pruneProbe']);

        const rows = await rowsOf(second, sessionId);
        const created = rows.find((row) => row.name === 'pruneProbe');

        // The row states the truth a restart must preserve: still created by this session,
        // still switched on, and still switchable.
        expect(created?.enabled).toBe(true);
        expect(created?.origin).toBe('created');
        expect(created?.protected).toBe(false);

        second.store.dispose();
    });
});
