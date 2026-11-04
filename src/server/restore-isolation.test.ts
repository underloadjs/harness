// T5 regression tests: per-session isolation while restoring the durable database.
//
// The failure these tests reproduce is the one an operator hits after a tool
// rename: a session persisted by an OLDER build names tools this build no longer
// registers (`commandRun` -> `shell`, `fileEdit` -> `edit`, `fileRead` -> `read`,
// `webSearch` -> `search`, `webFetch` -> `fetch`, `agentDelegate` -> `delegate`).
// `harness.restore()` rejects such a snapshot with
// `Snapshot discovery names "commandRun", which is not registered in this harness.`
// (src/harness.ts:6826-6832). Before the fix that throw escaped the SessionStore
// constructor (src/server/sessions.ts restore loop), so `createHarnessRuntime`
// (src/server/runtime.ts) and `startHarnessServer` (src/server/start.ts) aborted:
// the whole server became unavailable and NO session — healthy or not — could be
// listed, and no new session could be created.
//
// The contract under test:
//   R6   restore is best-effort PER SESSION: one broken record is dropped, while
//        every healthy session, the registry, the HTTP routes and new-session
//        creation keep working.
//   R7   no legacy alias and no snapshot migration: the broken session is NOT
//        exposed as usable (404 / absent, never a half-restored row) and the
//        reason stays observable (reporter + `restoreErrors` + stderr default).
//   R8   these tests drive a REAL old-tool snapshot through a real state.json
//        next to valid sessions, and check list/create/get behaviour.
//   scope the isolation is per SESSION, not per DOCUMENT: malformed JSON, an
//        unknown database version and an invalid record SHAPE are still fatal,
//        because an unparseable document says nothing trustworthy about any
//        session inside it.
//
// Everything runs against injected scripted presets and a REAL database root
// under the repo-root Temp/ directory (no provider, no network), exactly like
// ./persistence.test.ts. "Restart" always means a FRESH runtime over the same
// root, never a reused instance.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessProgress, HarnessStream, HarnessStreamEvent } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry, createToolCatalogue, createWebSearchCatalogueEntry, describeHarness } from './harnesses';
import { HarnessPersistence, HarnessPersistenceError } from './persistence';
import type { HarnessDatabase } from './persistence';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import type { SessionSnapshot } from './protocol';
import { SessionError, SessionStore } from './sessions';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-restore-isolation-${label}-`));
    roots.push(root);
    return root;
};

afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'scripted/test'
};

const DEFAULTS = {
    baseURL: SETTINGS.baseURL,
    model: SETTINGS.model,
    hasApiKey: true
};

// Force the unconfigured search entry so the catalogue never depends on the test
// runner's environment (nor on a developer's .env).
const CATALOGUE = createToolCatalogue({
    websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
});

const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

const presetOf = (
    name: string,
    create: HarnessPreset['create'],
    agents: readonly string[] = [name]
): HarnessPreset => ({
    name,
    title: name,
    description: `${name} scripted preset`,
    requiresEndpoint: false,
    primary: agents[0] ?? name,
    subagents: agents.slice(1),
    agents,
    tools: [],
    builtin: true,
    editable: true,
    create
});

// One-agent, one-answer scripted harness, wired to the core observer exactly like
// a production preset so the state-change persistence path is real.
const liveScriptedPreset = (name: string, text: string): HarnessPreset =>
    presetOf(name, (settings, progress: HarnessProgress, report) =>
        harness({
            agents: {
                [name]: agent({
                    model: settings.model,
                    instruction: `You are the ${name} scripted agent.`,
                    stream: answerStream(text)
                })
            },
            primary: name,
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            }
        })
    );

// Fresh preset OBJECTS per runtime (same values), like a new process.
const presetsOf = (): HarnessPreset[] => [liveScriptedPreset('one', 'answer one'), liveScriptedPreset('two', 'answer two')];

const runtimeOf = (root: string): HarnessRuntime =>
    createHarnessRuntime({
        root,
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: createHarnessRegistry(presetsOf()),
        catalogue: CATALOGUE,
        loadEnvironment: false
    });

const stateFile = (root: string): string => path.join(root, 'harness', 'state.json');

// The persisted document, narrowed to the fields these tests tamper with. `core`
// is only required to be an object by the document reader (persistence.ts:616),
// so an old tool name inside it survives validation and fails exactly where it
// does in production: inside `harness.restore()`.
type StoredDocument = {
    version: number;
    savedAt: number;
    registry: unknown[];
    sessions: {
        id: string;
        queue: string[];
        agentModels?: Record<string, string>;
        core: { discovery?: { enabled?: string[]; offsets?: unknown[] } } & Record<string, unknown>;
    }[];
};

const readDocument = (root: string): StoredDocument =>
    JSON.parse(fs.readFileSync(stateFile(root), 'utf8')) as StoredDocument;

const writeDocument = (root: string, document: StoredDocument): void => {
    fs.writeFileSync(stateFile(root), JSON.stringify(document, null, 2), 'utf8');
};

const sessionOf = (document: StoredDocument, id: string): StoredDocument['sessions'][number] => {
    const session = document.sessions.find((entry) => entry.id === id);
    if (session === undefined) throw new Error(`state.json holds no session "${id}".`);
    return session;
};

// Make ONE session's committed core snapshot name a tool this build renamed —
// the exact shape of a real pre-rename state.json entry.
const tamperDiscovery = (root: string, id: string, legacyName: string): void => {
    const document = readDocument(root);
    const session = sessionOf(document, id);
    const enabled = session.core.discovery?.enabled ?? [];

    if (enabled.includes(legacyName)) throw new Error(`the snapshot already names "${legacyName}".`);

    session.core.discovery = { ...(session.core.discovery ?? {}), enabled: [...enabled, legacyName] };
    writeDocument(root, document);
};

// Expected diagnostics, composed the way production composes them:
// HarnessPersistenceError prefixes the file (persistence.ts:166-176) and
// restoreSession wraps the reason as `Session "<id>" could not be restored: ...`.
const discoveryReason = (legacyName: string): string =>
    `Snapshot discovery names "${legacyName}", which is not registered in this harness.`;

const expectedDiagnostic = (root: string, id: string, legacyName: string): string =>
    `${stateFile(root)}: Session "${id}" could not be restored: ${discoveryReason(legacyName)}`;

// HTTP-shaped call through the runtime dispatcher (same convention as
// ./persistence.test.ts).
const callApi = async (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    body: unknown = {}
): Promise<{ status: number; body: unknown }> => {
    const result = await runtime.api({
        method,
        pathname,
        mount: '/v1/harness',
        readBody: async <T>() => body as T
    });

    if (result.kind !== 'json') throw new Error(`expected a JSON answer from ${method} ${pathname}`);
    return { status: result.status, body: result.body };
};

const sessionIdsOf = (body: unknown): string[] =>
    (body as { sessions: SessionSnapshot[] }).sessions.map((session) => session.id);

// D4: the strict store methods are async, so a refused write arrives as a REJECTION -
// an async helper is the only way to observe its status and message. Same contract, awaited.
const sessionErrorOf = async (run: () => unknown): Promise<{ status: number; message: string }> => {
    try {
        await run();
    } catch (error) {
        if (error instanceof SessionError) return { status: error.status, message: error.message };
        throw error;
    }

    throw new Error('expected the call to throw a SessionError.');
};

// One root holding TWO persisted sessions with real content: `healthy` (id first
// in the document) and `broken` (id second). Both prompts are unique so a test can
// prove which record survived a rewrite.
const persistTwoSessions = async (label: string): Promise<{ root: string; healthy: SessionSnapshot; broken: SessionSnapshot }> => {
    const root = tempRoot(label);
    const first = runtimeOf(root);

    const healthy = await first.store.create('one');
    const broken = await first.store.create('two');

    await first.store.run(healthy.id, 'keep this', async () => {});
    await first.store.run(broken.id, 'drop this', async () => {});

    const healthyBefore = first.store.get(healthy.id);
    const brokenBefore = first.store.get(broken.id);

    first.store.dispose();

    // Both records really are on disk before any tampering.
    expect(readDocument(root).sessions.map((session) => session.id)).toEqual([healthy.id, broken.id]);

    return { root, healthy: healthyBefore, broken: brokenBefore };
};

describe('per-session restore isolation (T5/R6)', () => {
    it('drops only the session naming a renamed tool and still restores, lists and runs the healthy one', async () => {
        const { root, healthy, broken } = await persistTwoSessions('isolate');

        tamperDiscovery(root, broken.id, 'commandRun');

        // The runtime itself comes up: a stale tool name is a per-session problem,
        // not a startup problem (this is the call that used to throw).
        const second = runtimeOf(root);

        // R6: the healthy session is restored whole — the exact snapshot it had
        // before the restart, including its transcript and turn records.
        expect(second.store.list().map((session) => session.id)).toEqual([healthy.id]);
        expect(second.store.size).toBe(1);
        expect(second.store.get(healthy.id)).toEqual(healthy);

        // R7: the broken session is not exposed as usable. It is absent, not a
        // half-restored row.
        expect(second.store.list().some((session) => session.id === broken.id)).toBe(false);
        const missing = await sessionErrorOf(() => second.store.get(broken.id));
        expect(missing.status).toBe(404);
        expect(missing.message).toBe(`Unknown session "${broken.id}".`);

        // R7: the reason is retained verbatim (file + session id + root cause).
        expect(second.store.restoreErrors).toEqual([expectedDiagnostic(root, broken.id, 'commandRun')]);

        // The healthy session is not merely listed: it still runs a turn.
        await second.store.run(healthy.id, 'continue after restart', async () => {});
        expect(second.store.get(healthy.id).turns.map((turn) => [turn.prompt, turn.status])).toEqual([
            ['keep this', 'done'],
            ['continue after restart', 'done']
        ]);

        // The routes answer: the UI's list, a fresh session, and the dead id.
        const listed = await callApi(second, 'GET', '/v1/harness/sessions');
        expect(listed.status).toBe(200);
        expect(sessionIdsOf(listed.body)).toEqual([healthy.id]);

        const created = await callApi(second, 'POST', '/v1/harness/sessions', { harness: 'two' });
        expect(created.status).toBe(201);
        const createdSession = (created.body as { session: SessionSnapshot }).session;
        expect(createdSession.harness).toBe('two');
        expect(createdSession.turns).toEqual([]);
        expect(createdSession.id).not.toBe(broken.id);

        const stale = await callApi(second, 'GET', `/v1/harness/sessions/${broken.id}`);
        expect(stale.status).toBe(404);
        expect(stale.body).toEqual({ error: { message: `Unknown session "${broken.id}".` } });

        const after = await callApi(second, 'GET', '/v1/harness/sessions');
        expect(sessionIdsOf(after.body)).toEqual([healthy.id, createdSession.id]);

        second.store.dispose();
    });

    it('still starts an empty, usable server when every saved session is invalid', async () => {
        const { root, healthy, broken } = await persistTwoSessions('all-invalid');

        tamperDiscovery(root, healthy.id, 'commandRun');
        tamperDiscovery(root, broken.id, 'fileEdit');

        const second = runtimeOf(root);

        // All rows are gone, and each drop is reported, in document order.
        expect(second.store.list()).toEqual([]);
        expect(second.store.size).toBe(0);
        expect(second.store.restoreErrors).toEqual([
            expectedDiagnostic(root, healthy.id, 'commandRun'),
            expectedDiagnostic(root, broken.id, 'fileEdit')
        ]);

        // A brand-new session is creatable AND runnable on a store that loaded
        // nothing: this is exactly what "server unavailable" used to prevent.
        const fresh = await second.store.create('two');
        expect(fresh.harness).toBe('two');

        await second.store.run(fresh.id, 'first after restart', async () => {});
        expect(second.store.get(fresh.id).turns.map((turn) => [turn.prompt, turn.status])).toEqual([
            ['first after restart', 'done']
        ]);
        expect(second.store.get(fresh.id).messages.at(-1)?.content).toBe('answer two');

        const listed = await callApi(second, 'GET', '/v1/harness/sessions');
        expect(listed.status).toBe(200);
        expect(sessionIdsOf(listed.body)).toEqual([fresh.id]);

        second.store.dispose();
    });

    it('isolates a store-level inconsistency (a model map naming a retired agent) after a partial restore', async () => {
        const { root, healthy, broken } = await persistTwoSessions('partial');
        const document = readDocument(root);

        // Valid JSON, valid SHAPE, valid core snapshot: only the live model map
        // names an agent this harness no longer has, so `harness.restore()`
        // succeeds first and the store check throws afterwards.
        sessionOf(document, broken.id).agentModels = { ghost: 'scripted/retired' };
        writeDocument(root, document);

        const second = runtimeOf(root);

        expect(second.store.list().map((session) => session.id)).toEqual([healthy.id]);
        expect(second.store.get(healthy.id)).toEqual(healthy);
        expect((await sessionErrorOf(() => second.store.get(broken.id))).message).toBe(`Unknown session "${broken.id}".`);
        expect(second.store.restoreErrors).toEqual([
            `${stateFile(root)}: Session "${broken.id}" could not be restored: the saved agent model map names "ghost", which is not part of this harness.`
        ]);

        // Failure cleanup: the half-restored session is not in the document that
        // the next save writes, and it never leaks into the registry.
        await second.store.create('one');
        second.store.dispose();

        const raw = fs.readFileSync(stateFile(root), 'utf8');
        expect(raw).not.toContain(broken.id);
        expect(raw).not.toContain('drop this');
        expect(raw).not.toContain('ghost');
        expect(raw).toContain('keep this');
    });

    it('rewrites state.json without the dropped session so the next restart loads cleanly', async () => {
        const { root, healthy, broken } = await persistTwoSessions('persist-drop');

        tamperDiscovery(root, broken.id, 'commandRun');

        const second = runtimeOf(root);
        expect(second.store.restoreErrors).toEqual([expectedDiagnostic(root, broken.id, 'commandRun')]);

        // Any structural mutation commits the in-memory database, and the dropped
        // record is simply no longer part of it.
        const added = await second.store.create('two');
        second.store.dispose();

        const raw = fs.readFileSync(stateFile(root), 'utf8');
        expect(raw).not.toContain('commandRun');
        expect(raw).not.toContain(broken.id);
        expect(raw).not.toContain('drop this');
        expect(readDocument(root).sessions.map((session) => session.id)).toEqual([healthy.id, added.id]);

        // Third process: nothing to drop any more.
        const third = runtimeOf(root);
        expect(third.store.restoreErrors).toEqual([]);
        expect(third.store.list().map((session) => session.id)).toEqual([healthy.id, added.id]);
        third.store.dispose();
    });

    it('reports each dropped session to the injected onRestoreError reporter instead of stderr', async () => {
        const { root, healthy, broken } = await persistTwoSessions('reporter');

        tamperDiscovery(root, broken.id, 'commandRun');

        const database: HarnessDatabase | undefined = new HarnessPersistence(root).load();
        if (database === undefined) throw new Error('the tampered document did not load');

        const reported: string[] = [];
        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const store = new SessionStore(
                SETTINGS,
                createHarnessRegistry(presetsOf()),
                (preset) => describeHarness(preset, CATALOGUE),
                {
                    persistence: new HarnessPersistence(root),
                    database,
                    onRestoreError: (error) => {
                        reported.push(error.message);
                    }
                }
            );

            // Exactly one report, carrying the full diagnostic (file + id + reason).
            expect(reported).toEqual([expectedDiagnostic(root, broken.id, 'commandRun')]);
            expect(store.restoreErrors).toEqual(reported);
            expect(store.list().map((session) => session.id)).toEqual([healthy.id]);

            // The host opted in, so the stderr default stays silent. Only the
            // `[harness]`-prefixed load lines are inspected: nothing else here logs.
            expect(
                stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[harness]'))
            ).toEqual([]);

            store.dispose();
        } finally {
            stderr.mockRestore();
        }
    });

    it('logs the drop to stderr when the host injects no reporter (R7 observability)', async () => {
        const { root, healthy, broken } = await persistTwoSessions('stderr');

        tamperDiscovery(root, broken.id, 'commandRun');

        const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

        try {
            const runtime = runtimeOf(root);

            expect(runtime.store.list().map((session) => session.id)).toEqual([healthy.id]);
            expect(
                stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('[harness]'))
            ).toEqual([
                `[harness] skipped an unrestorable saved session: ${expectedDiagnostic(root, broken.id, 'commandRun')}`
            ]);

            runtime.store.dispose();
        } finally {
            stderr.mockRestore();
        }
    });

    it('leaves a healthy store with no diagnostics at all when nothing was dropped', async () => {
        const { root, healthy, broken } = await persistTwoSessions('clean');
        const second = runtimeOf(root);

        expect(second.store.restoreErrors).toEqual([]);
        expect(second.store.list().map((session) => session.id)).toEqual([healthy.id, broken.id]);
        expect(second.store.get(broken.id)).toEqual(broken);

        second.store.dispose();
    });
});

// Scope guard for R7/R9: the policy changed for ONE SESSION inside a document,
// not for the document itself. Hosts still learn about unreadable/incompatible
// files instead of serving an empty database, and the file is never rewritten by
// a failed load.
describe('document-level failures stay fatal (T5 scope)', () => {
    it('still aborts startup for malformed JSON, an unknown version and an invalid record shape', async () => {
        const root = tempRoot('document-fatal');

        const first = runtimeOf(root);
        const created = await first.store.create('one');
        const written = fs.readFileSync(stateFile(root), 'utf8');
        first.store.dispose();
        expect(created.id).not.toBe('');

        // 1. Malformed JSON.
        fs.writeFileSync(stateFile(root), '{', 'utf8');
        let malformed: unknown;
        try {
            runtimeOf(root);
        } catch (error) {
            malformed = error;
        }
        expect(malformed).toBeInstanceOf(HarnessPersistenceError);
        expect((malformed as Error).message).toContain(`${stateFile(root)}: The harness database is not valid JSON:`);
        expect(fs.readFileSync(stateFile(root), 'utf8')).toBe('{');

        // 2. Unknown database version: rejected before any field is interpreted.
        fs.writeFileSync(
            stateFile(root),
            JSON.stringify({ version: 999, savedAt: 0, registry: [], sessions: [] }, null, 2),
            'utf8'
        );
        let versioned: unknown;
        try {
            runtimeOf(root);
        } catch (error) {
            versioned = error;
        }
        expect(versioned).toBeInstanceOf(HarnessPersistenceError);
        expect((versioned as Error).message).toContain('Unsupported harness database version 999');
        expect(fs.readFileSync(stateFile(root), 'utf8')).toContain('"version": 999');

        // 3. A record whose SHAPE is wrong: this is corruption of the document, not
        //    a session this build cannot rebuild, so it does not become a drop.
        fs.writeFileSync(stateFile(root), written, 'utf8');
        const document = readDocument(root);
        (sessionOf(document, created.id) as { core: unknown }).core = 'not-a-snapshot';
        writeDocument(root, document);

        let shaped: unknown;
        try {
            runtimeOf(root);
        } catch (error) {
            shaped = error;
        }
        expect(shaped).toBeInstanceOf(HarnessPersistenceError);
        expect((shaped as Error).message).toBe(
            `${stateFile(root)}: The harness database has an invalid shape or version: sessions[0].core must be an object.`
        );

        // The tampered text survives the failed load untouched: a fatal load never
        // rewrites the operator's file.
        expect(fs.readFileSync(stateFile(root), 'utf8')).toContain('"core": "not-a-snapshot"');
    });
});
