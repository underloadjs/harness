// F7 (the session DOWNLOADS FOLDER): the server-side wiring, pinned at the store.
//
// WHAT THIS FILE EXISTS TO PROVE. The `download` tool no longer picks a folder of its own — it
// refuses unless the harness names one (../engine/tools/webdownload/download.tool.ts
// `downloadsDirectoryOf`), and the ONLY way a harness names one is
// `HarnessConfiguration.downloadsDirectory`, which a server host supplies per BUILD. The engine half
// of that (the `ToolContext` supply and the refusal) is pinned in
// ../engine/tools/webdownload/download.test.ts; the HTTP half (a session download landing in the
// session's own folder, the media contract surviving it, and DELETE taking the bytes away) is pinned
// in ./api.test.ts. This file pins the MIDDLE, which no other file reaches:
//
//   1. CREATE  — the session id is minted BEFORE the harness is built, so the folder the build names
//                is the folder the session object's own id addresses. A folder derived after the
//                build cannot reach a build option at all, which is the state every durable session
//                used to ship in: the tool refused, inside a session, with "run it inside a server
//                session".
//   2. RESTART — a restored session is built against the SAME path (it is derived from the record's
//                id, not remembered), so bytes downloaded before the restart are still inside the
//                folder the session points at afterwards, and `journal.remove()` can still erase them.
//   3. ABSENCE — a store with NO persistence directory states NO folder, on the report AND on the
//                blueprint, so the tool refuses instead of inventing a folder for bytes nothing will
//                ever delete.
//   4. LANE    — the blueprint carries the folder, so a worker replica's `download` saves into the
//                conversation's folder instead of refusing where the inline session succeeds. The
//                value is a path STRING, so unlike `knowledge` (a live object) it crosses
//                `worker_threads` as data.
//   5. DELETE  — removing a session removes the folder, INCLUDING for a session that never ran a turn
//                and therefore never had a `HarnessJournal` instance. Before this change that edge
//                left `sessions/<id>/downloads/` behind: inline removal called `journal?.remove()`,
//                a no-op with no instance, while the IO worker's `journal.remove` op already deleted
//                the whole session directory whether or not a handle existed
//                (./workers/io-worker-loop.ts:265-281).
//
// Nothing about the store, the persistence layer or the journal is stubbed: every path below is a
// REAL database root under the repo-root `Temp/` (the scratch policy in the repo's AGENTS.md), a real
// `HarnessPersistence` commit, and a real `SessionStore.remove()`. "Restart" always means a FRESH
// store over the same root, never a reused instance.
//
// Cross-references:
//   - ./sessions.ts             `create` (the id mint), `restoreSession`, `downloadsDirectoryFor`,
//                               `buildHarness` (the report spread), `blueprintFor`, `remove()` and
//                               `eraseSessionDirectory`
//   - ./persistence.ts:2653     `harnessSessionDownloadsDirectoryOf` — the ONE spelling of the path
//   - ./harnesses/types.ts      `HarnessPresetReport.downloadsDirectory`
//   - ./harnesses/toolbox.ts    the report -> `HarnessConfiguration` forward a production card makes
//   - ./workers/protocol.ts     `LaneBlueprint.downloadsDirectory`
//   - ./workers/lane-host.ts    `LaneBlueprintSource` (the Pick that lets the field reach `hello`)
//   - ./workers/lane-worker-loop.ts `sayHello` (the replica's build option)
//   - ./journal.ts:788-797      `remove()` — the recursive erase that owns the folder's life

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { agent, harness, tool } from '../engine/harness';
import type { HarnessProgress, HarnessStream, HarnessStreamEvent } from '../engine/harness';
import { createHarnessRegistry } from './harnesses';
import { PRODUCTION_WITH_FIXTURES } from './harnesses/fixture-presets.test-support';
import type { HarnessPreset, HarnessPresetReport, RunnerSettings } from './harnesses/types';
import { DEFAULT_RUNTIME_CONFIGURATION } from './config';
import type { ServerRuntimeConfiguration } from './config';
import { HarnessPersistence, harnessSessionDownloadsDirectoryOf } from './persistence';
import type { HarnessDatabase } from './persistence';
import { SessionStore } from './sessions';
import type { LaneBlueprintSource } from './workers/lane-host';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

// One unique database root per case, removed with the case. Every expected path below is built from
// `persistence.directory` (`<root>/harness`), never from this string, so a pin cannot drift from the
// layout the store actually writes.
const roots: string[] = [];
const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-sessions-downloads-${label}-`));

    roots.push(root);

    return root;
};

const stores: SessionStore[] = [];

const track = (store: SessionStore): SessionStore => {
    stores.push(store);

    return store;
};

afterAll(() => {
    for (const store of stores) store.dispose();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = { baseURL: 'http://scripted.invalid/v1', apiKey: 'server-key', model: 'scripted/test' };

// Worker mode is what `blueprintFor` is written for (./workers/lane-host.ts is its only caller), so
// the blueprint cases run in the deployment that reads it. Nothing is DISPATCHED here, so no thread
// is spawned — the lane host is created lazily on the first worker-mode dispatch, while the
// capability gate that DOES run at `create` is the one a real lane passes.
const WORKER_RUNTIME: ServerRuntimeConfiguration = { ...DEFAULT_RUNTIME_CONFIGURATION, threadExecution: 'worker' };

// ---------------------------------------------------------------------------
// THE CAPTURING PRESET
//
// A real scripted harness whose factory RECORDS the per-build report it was handed — the only way to
// assert what `buildHarness` put ON the build without reading a private field of a live harness, and
// the same probe ./tools-api.test.ts uses (`builtReports`). It also states the other half of the
// contract: forwarding the report into `HarnessConfiguration` is the FACTORY's job (a factory that
// ignores it produces a refusing harness, exactly as for every other report field), so the store's
// job ends at putting the value on the report — which is what is asserted here.
// ---------------------------------------------------------------------------

let builtReports: HarnessPresetReport[] = [];

const scriptedAnswer = (text: string): HarnessStream => {
    let sent = false;

    return async function* stream() {
        if (sent) return;

        sent = true;

        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };
};

const capturePreset = (): HarnessPreset => ({
    name: 'folder',
    title: 'Folder',
    description: 'Scripted preset that records the build report it receives.',
    requiresEndpoint: false,
    entry: 'folder',
    ranks: { folder: 'A' },
    agents: ['folder'],
    tools: ['write'],
    builtin: true,
    editable: true,
    create: (settings, progress: HarnessProgress, report?: HarnessPresetReport) => {
        if (report !== undefined) builtReports.push(report);

        return harness({
            agents: {
                folder: agent({ model: settings.model, instruction: 'Folder probe agent.', stream: scriptedAnswer('ok') })
            },
            entry: 'folder',
            ranks: { folder: 'A' },
            presets: false,
            tools: {
                write: tool({ description: 'Write a file.', tags: ['files'], visibility: 'searchable', execute: () => 'written' })
            },
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            },
            // THE FIELD UNDER TEST, forwarded the way ./harnesses/toolbox.ts forwards it for every
            // shipped card: absent means the library default (no folder), presence means this build's
            // `download` has somewhere to write.
            ...(report?.downloadsDirectory === undefined ? {} : { downloadsDirectory: report.downloadsDirectory })
        });
    }
});

// A DURABLE store over `root`, with the persistence object handed back so every expected path is
// derived from `persistence.directory` instead of re-joined by hand.
const durableOf = (
    root: string,
    options: { presets?: HarnessPreset[]; runtime?: ServerRuntimeConfiguration } = {}
): { store: SessionStore; persistence: HarnessPersistence } => {
    const persistence = new HarnessPersistence(root);
    const store = track(
        new SessionStore(SETTINGS, createHarnessRegistry(options.presets ?? [capturePreset()]), undefined, {
            persistence,
            ...(options.runtime === undefined ? {} : { runtime: options.runtime })
        })
    );

    return { store, persistence };
};

// A RESTART: a fresh persistence object, the loader's read, and a fresh store over the SAME root.
const restartOf = (root: string): { store: SessionStore; persistence: HarnessPersistence } => {
    const database: HarnessDatabase | undefined = new HarnessPersistence(root).load();

    if (database === undefined) throw new Error('the persisted database did not load');

    const persistence = new HarnessPersistence(root);
    const store = track(
        new SessionStore(SETTINGS, createHarnessRegistry([capturePreset()]), undefined, { persistence, database })
    );

    return { store, persistence };
};

// `blueprintFor` is PRIVATE because the lane host is its only caller; the existing lane tests reach
// it through this same cast (./workers/lane-tool-settings.test.ts:133, ./workers/lane-boot-posture.test.ts:153).
const blueprintOf = (store: SessionStore, sessionId: string): LaneBlueprintSource =>
    (store as unknown as { blueprintFor: (session: ReturnType<SessionStore['liveSession']>) => LaneBlueprintSource }).blueprintFor(
        store.liveSession(sessionId)
    );

// ---------------------------------------------------------------------------

describe('F7 session downloads folder: the store supplies it on every build path', () => {
    it('names a fresh session by the SAME id the session object reports, before the build', async () => {
        builtReports = [];

        const root = tempRoot('create');
        const { store, persistence } = durableOf(root);
        const session = await store.create('folder');

        // ONE report, from ONE build.
        expect(builtReports).toHaveLength(1);

        // EXACTLY the persistence helper's path for the id the snapshot reports. BOTH halves of the
        // pin matter: the VALUE (a folder under the session directory, which is what lets the
        // deletion erase it) and the IDENTITY (the id minted before the build is the id the session
        // carries — mint it afterwards and this is `sessions/<some other uuid>/downloads`).
        expect(builtReports[0].downloadsDirectory).toEqual(harnessSessionDownloadsDirectoryOf(persistence.directory, session.id));
        expect(builtReports[0].downloadsDirectory).toEqual(path.join(persistence.directory, 'sessions', session.id, 'downloads'));

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('builds a restored session against the same folder, so a restart neither moves nor forgets it', async () => {
        builtReports = [];

        const root = tempRoot('restart');
        const first = durableOf(root);
        const session = await first.store.create('folder');

        // `create` is write-through, so the record is already durable here — the restart below reads
        // exactly what the first build committed, with no extra save.
        const createdWith = builtReports[0].downloadsDirectory;

        expect(createdWith).toEqual(harnessSessionDownloadsDirectoryOf(first.persistence.directory, session.id));

        first.store.dispose();

        // A FRESH store over the same root: the record's id IS the folder name, so the rebuilt
        // harness points at the bytes the first build wrote — and the folder that holds them is still
        // the one `journal.remove()` deletes.
        builtReports = [];

        const second = restartOf(root);

        expect(second.store.list().map((row) => row.id)).toEqual([session.id]);
        expect(builtReports).toHaveLength(1);
        expect(builtReports[0].downloadsDirectory).toEqual(createdWith);

        second.store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('states NO folder without a persistence directory — on the build AND on the blueprint', async () => {
        builtReports = [];

        // INLINE for the report: a hand-injected factory closure is REFUSED in worker mode at
        // `create` (./workers/capability.ts — a lane cannot rebuild a closure), so the build-side
        // half of this pin runs in the deployment that allows the probe.
        const inline = track(new SessionStore(SETTINGS, createHarnessRegistry([capturePreset()]), undefined, {}));

        const probed = await inline.create('folder');

        expect(builtReports).toHaveLength(1);
        expect(builtReports[0]).toBeDefined();
        // ABSENT, not empty: an empty string would be a folder named "" that resolves to the process
        // cwd — the leak F7 closed (../engine/tools/webdownload/download.tool.ts `downloadsDirectoryOf`
        // refuses blank for exactly this reason).
        expect('downloadsDirectory' in builtReports[0]).toBe(false);

        inline.dispose();

        // WORKER for the blueprint, on a card a lane CAN rebuild: an ephemeral store ships neither
        // key, so a replica refuses precisely where its inline twin refuses
        // (./workers/lane-worker-loop.ts `sayHello`).
        builtReports = [];

        const ephemeral = track(
            new SessionStore(SETTINGS, createHarnessRegistry(PRODUCTION_WITH_FIXTURES as never), undefined, {
                runtime: WORKER_RUNTIME
            })
        );

        const session = await ephemeral.create('demo');
        const blueprint = blueprintOf(ephemeral, session.id);

        expect('downloadsDirectory' in blueprint).toBe(false);
        expect(Object.keys(blueprint).sort()).toEqual([
            'apiKey',
            'disabledTools',
            'memoryKeys',
            'pluginSettings',
            'record',
            'settings',
            'withheldTools'
        ]);

        ephemeral.dispose();
    });

    it('carries the folder on the lane blueprint, as structured-clone-safe data', async () => {
        const root = tempRoot('blueprint');
        const { store, persistence } = durableOf(root, {
            presets: PRODUCTION_WITH_FIXTURES as never,
            runtime: WORKER_RUNTIME
        });

        const session = await store.create('demo');
        const expected = harnessSessionDownloadsDirectoryOf(persistence.directory, session.id);
        const blueprint = blueprintOf(store, session.id);

        // The SAME spelling the inline build used (./sessions.ts `downloadsDirectoryFor`), so a lane
        // and the canonical harness it mirrors cannot name two folders.
        expect(blueprint.downloadsDirectory).toEqual(expected);

        // THE WIRE RULE (./workers/protocol.ts): a `hello` frame is structured-clone data. This is why
        // the folder travels as a path string while `knowledge` (a live store object) cannot cross at
        // all — a live object here would fault at the thread boundary, not in a test.
        expect(structuredClone(blueprint).downloadsDirectory).toEqual(expected);

        // The field joins the lane-creation group without pushing anything off it: the two
        // deployment-wide snapshots, the session's own switch set and record, and now the folder.
        expect(Object.keys(blueprint).sort()).toEqual([
            'apiKey',
            'disabledTools',
            'downloadsDirectory',
            'memoryKeys',
            'pluginSettings',
            'record',
            'settings',
            'withheldTools'
        ]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('installs the blueprint field on the replica build (the worker-loop option)', () => {
        // The deepest level THIS fact can be pinned without booting a real lane worker (a cold thread
        // plus a provider stub, which would still only exercise the same line): the replica's build
        // option is one spread in ./lane-worker-loop.ts `sayHello`, and it is the ONLY consumer of
        // `blueprint.downloadsDirectory`. Restated as a source pin in the spirit of the `ENTRY_SOURCE`
        // pins in ../engine/tools/webdownload/download.test.ts:401 — if the spread is renamed or
        // dropped, the lane's model is told it cannot download while its conversation can.
        const source = fs.readFileSync(fileURLToPath(new URL('./workers/lane-worker-loop.ts', import.meta.url)), 'utf8');

        expect(source).toContain(
            '...(blueprint.downloadsDirectory === undefined ? {} : { downloadsDirectory: blueprint.downloadsDirectory })'
        );
    });

    it('removes a never-journaled session with its downloads folder, the way worker mode already did', async () => {
        // THE CONTAINMENT. A session that never ran a turn has no `HarnessJournal` instance, and the
        // inline removal used to be `journal?.remove()` — a no-op with no instance — so DELETE left
        // `sessions/<id>/downloads/` on disk. Worker mode already deleted the whole session directory
        // for this case (./workers/io-worker-loop.ts:265-281), so the fix is parity, not a new rule.
        const root = tempRoot('delete-unjournaled');
        const { store, persistence } = durableOf(root);
        const session = await store.create('folder');
        const downloads = harnessSessionDownloadsDirectoryOf(persistence.directory, session.id);
        const file = path.join(downloads, 'pixel.png');

        // Stand in for a COMPLETED download without running a turn: making the folder and writing a
        // byte into it is all the deletion has to undo, and neither opens a journal.
        fs.mkdirSync(downloads, { recursive: true });
        fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

        expect(fs.existsSync(file)).toBe(true);
        expect(store.journalErrors).toEqual([]);

        expect(await store.remove(session.id)).toBe(true);

        // The file, the folder, and the session directory that held them: a deleted conversation owns
        // nothing on disk. The shard and the transcripts are the persistence layer's erase
        // (./persistence.ts `eraseVanishedShards`); the DIRECTORY is the branch under test.
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.existsSync(downloads)).toBe(false);
        expect(fs.existsSync(path.join(persistence.directory, 'sessions', session.id))).toBe(false);
        expect(store.journalErrors).toEqual([]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('treats a session directory that was never created as already deleted', async () => {
        // The same branch with NOTHING to delete: `force: true` makes an absent directory a SUCCESS,
        // so this edge cannot turn a completed DELETE into a reported journal failure (the erase is
        // best-effort by policy — ./persistence.ts:3455-3458 states the same rule for shards).
        const root = tempRoot('delete-empty');
        const { store, persistence } = durableOf(root);
        const session = await store.create('folder');

        expect(await store.remove(session.id)).toBe(true);
        expect(fs.existsSync(path.join(persistence.directory, 'sessions', session.id))).toBe(false);
        expect(store.journalErrors).toEqual([]);

        store.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
});
