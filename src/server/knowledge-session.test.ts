// T7 — the KNOWLEDGE store from the SERVER side: one store per database root, handed to every
// harness the listener builds, durable across a listener restart, invisible to a session
// deletion, and absent-but-working when the deployment has no database root.
//
// WHY THESE PINS AND NOT MORE
// ---------------------------
//   1. ONE STORE PER ROOT (acceptance 3). ./runtime.ts owns the table, so the listener, the
//      service routes, and a second listener over the SAME root all resolve ONE instance, while
//      a different root resolves its own. Two writers over one directory is the failure mode
//      this pins — the file layer's staging-owner rule (./knowledge-file-store.ts:83-91) exists
//      because of it.
//   2. EVERY HARNESS GETS IT (acceptance 3). What the preset factory RECEIVED
//      (`report.knowledge`) and what the HANDLE HOLDS (`harness.knowledge`) are asserted
//      separately, because they are two different hops of wiring: ../sessions.ts `buildHarness`
//      → ./harnesses/toolbox.ts → `harness({ knowledge })` → the handle getter in ../harness.ts.
//      An article written in session A being readable in session B is the user-visible meaning
//      of "persistent outside the session".
//   3. SHUTDOWN FLUSHES (acceptance 3, in ./shutdown-background.test.ts's style: assert the real
//      bytes under a real root). The article is provably NOT on disk synchronously after the
//      mutation — a commit pass yields one microtask (./knowledge-file-store.ts:1413-1420) — so
//      "the file exists after `close()`" is a statement about the barrier, not about a write
//      that had already happened. The store is then disposed exactly once, by the listener.
//   4. NO ROOT ⇒ IN MEMORY, NO WRITES (acceptance 4). Knowledge still answers through the
//      handle, and fs spies prove no byte was written under `harness/knowledge`.
//   5. SESSION DELETION CHANGES NOTHING (acceptance 5). The whole tree is compared path-for-path
//      and byte-for-byte across `store.remove()`, and the same test proves the deletion actually
//      happened (the session's shard is gone, the committed document no longer names it), so the
//      equality cannot pass vacuously.
//
// WHAT IS DELIBERATELY NOT HERE
// -----------------------------
// No HTTP endpoint and no snapshot field are pinned, because knowledge gained neither in T7: the
// base is deployment-scoped, so it is NOT part of a per-session snapshot (folding it in would
// let one session's restart rewrite what every other session is reading), and the REST contract
// gained no route.
//
// Temp roots live under the REPO-ROOT `Temp/`, resolved through `import.meta.url`; this file
// never chdir's and never uses the OS temp directory (the layout ./shutdown-background.test.ts:52-64
// uses).
//
// Cross-references:
//   - ./runtime.ts                  — `prepareHarnessKnowledge` / `peekHarnessKnowledge` /
//                                     `harnessKnowledgeOf` / `disposeHarnessKnowledge`
//   - ./start.ts                    — the load (before a session is restored) and `close()`
//   - ./sessions.ts                 — `SessionStoreOptions.knowledge`, `buildHarness`
//   - ./harnesses/toolbox.ts        — the preset-report hop that carries the store into `harness({})`
//   - ../harness.knowledge.test.ts  — the library-level proof (one store, two handles)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../engine/harness';
import type {
    Harness,
    HarnessKnowledgeStore,
    HarnessProgress,
    HarnessStream,
    HarnessStreamEvent,
    KnowledgeCreateResult,
    KnowledgeEngine,
    KnowledgeOperation
} from '../engine/harness';
import { createHarnessRegistry, createToolCatalogue, createWebSearchCatalogueEntry } from './harnesses';
import { createToolboxHarness } from './harnesses/toolbox';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { startHarnessServer } from './start';
import { knowledgeArticleFileOf, knowledgeDirectoryOf } from './knowledge-file-store';
import { createKnowledgeEngine } from '../engine/core';
import { harnessKnowledgeOf, peekHarnessKnowledge } from './runtime';
import { harnessSessionFileOf, readPersistedDocument } from './persistence-test-helpers';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

// One root per test: no test may read another test's articles.
const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-knowledge-${label}-`));

    roots.push(root);

    return root;
};

afterAll(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'server-secret-key',
    model: 'scripted/test'
};

const DEFAULTS = { baseURL: SETTINGS.baseURL, model: SETTINGS.model, hasApiKey: true };

// Forced unconfigured search: the catalogue must not depend on the runner's environment
// (the ./shutdown-background.test.ts:81-85 posture).
const CATALOGUE = createToolCatalogue({
    websearch: createWebSearchCatalogueEntry({ configuration: { env: {} } })
});

const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// What one preset build produced: the harness, and the knowledge object the store handed the
// factory. Two sessions of one listener mean two entries, in build order.
type Build = { harness: Harness; received: unknown };

// The scripted preset, wired like a production one: `create`'s third argument is what
// ../sessions.ts passes, and forwarding `report.knowledge` into `harness({})` is the shipped
// behaviour of ./harnesses/toolbox.ts — asserted against the real factory in its own test below.
const knowledgePreset = (builds: Build[]): HarnessPreset => ({
    name: 'knowledge',
    title: 'Knowledge',
    description: 'Scripted preset used by the T7 knowledge wiring tests.',
    requiresEndpoint: false,
    // THE RANK PAIR (clean break): one member, one rank — what the retired
    // `subagents: []` implied by absence is now stated directly.
    entry: 'writer',
    ranks: { writer: 'A' },
    agents: ['writer'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress: HarnessProgress, report) => {
        const built = harness({
            agents: {
                writer: agent({
                    model: settings.model,
                    instruction: 'You are the knowledge scripted agent.',
                    stream: answerStream('quiet')
                })
            },
            entry: 'writer',
            ranks: { writer: 'A' },
            presets: false,
            report: {
                progress,
                ...(report?.stateChange === undefined ? {} : { stateChange: report.stateChange })
            },
            ...(report?.knowledge === undefined ? {} : { knowledge: report.knowledge })
        });

        builds.push({ harness: built, received: report?.knowledge });

        return built;
    }
});

const registryOf = (builds: Build[]): ReturnType<typeof createHarnessRegistry> =>
    createHarnessRegistry([knowledgePreset(builds)]);

const startOf = (options: { root?: string; builds: Build[] }) =>
    startHarnessServer({
        port: 0,
        staticRoot: null,
        ...(options.root === undefined ? {} : { databaseRoot: options.root }),
        settings: SETTINGS,
        defaults: DEFAULTS,
        registry: registryOf(options.builds),
        catalogue: CATALOGUE
    });

// The door a tool uses: `context.harness.knowledge.engine.execute(op, context)`. A handle's
// member is either shape, so `engine` is read first and the member itself is the fallback.
const engineOf = (target: Harness | KnowledgeEngine): KnowledgeEngine => {
    const knowledge = (target as Harness).knowledge;

    if (knowledge === undefined) return target as KnowledgeEngine;

    return (knowledge as HarnessKnowledgeStore).engine ?? (knowledge as KnowledgeEngine);
};

const create = (target: Harness | KnowledgeEngine, title: string, content: string[]): KnowledgeCreateResult =>
    engineOf(target).execute({ verb: 'create', title, content } as KnowledgeOperation) as unknown as KnowledgeCreateResult;

const titles = (target: Harness | KnowledgeEngine): string[] =>
    (
        engineOf(target).execute({ verb: 'list' } as KnowledgeOperation) as unknown as {
            articles: { title: string }[];
        }
    )
        .articles.map((article) => article.title)
        .sort();

// EVERY byte under `<root>/harness/knowledge/`, keyed by relative path: the strictest available
// answer to "did deleting a session change the knowledge tree", covering `index.json`, every
// article file, and any file a writer might leave behind.
const treeOf = (directory: string): Record<string, string> => {
    if (!fs.existsSync(directory)) return {};

    const found: Record<string, string> = {};

    for (const entry of fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            for (const [name, bytes] of Object.entries(treeOf(full))) found[`${entry.name}/${name}`] = bytes;
        } else {
            found[entry.name] = fs.readFileSync(full).toString('base64');
        }
    }

    return found;
};

describe('T7 — the server knowledge store', () => {
    it('resolves one store per database root and hands it to every harness the listener builds', async () => {
        const root = tempRoot('shared');
        const builds: Build[] = [];

        const server = await startOf({ root, builds });

        try {
            // THE STORE: the listener's reference IS the process-global store for this root, and
            // its directory is `<root>/harness/knowledge/` — a sibling of `sessions/`, hence
            // outside every session folder.
            const store = server.knowledge;

            expect(store).toBeDefined();
            expect(store!.root).toBe(root);
            expect(store!.directory).toBe(path.join(root, 'harness', 'knowledge'));
            expect(peekHarnessKnowledge(root)).toBe(store);
            expect(harnessKnowledgeOf(root)).toBe(store);

            const first = await server.store.create('knowledge');
            const second = await server.store.create('knowledge');

            expect(builds).toHaveLength(2);
            expect(first.id).not.toBe(second.id);

            // HOP 1 — the store reaches the preset factory. HOP 2 — the handle holds the SAME
            // object. Both are asserted because they are separate lines of wiring.
            expect(builds[0].received).toBe(store);
            expect(builds[1].received).toBe(store);
            expect(builds[0].harness.knowledge).toBe(store);
            expect(builds[1].harness.knowledge).toBe(store);
            expect(builds[1].harness.knowledge).toBe(builds[0].harness.knowledge);

            // THE USER-VISIBLE MEANING: one session's article is the other's to read, with no
            // commit, no reload and no restart in between.
            const created = create(builds[0].harness, 'Gateway runbook', ['Drain the lane before restart.']);

            expect(created.article.title).toBe('Gateway runbook');
            expect(titles(builds[1].harness)).toEqual(['Gateway runbook']);

            // And durable at the canonical path (the awaited flush is the barrier).
            const report = await store!.flush();

            expect(report.written).toContain(created.article.id);

            const onDisk = JSON.parse(
                fs.readFileSync(knowledgeArticleFileOf(root, created.article.id), 'utf8')
            ) as { version: number; article: { title: string } };

            expect(onDisk.version).toBe(1);
            expect(onDisk.article.title).toBe('Gateway runbook');
        } finally {
            await server.close();
        }
    });

    it('flushes on close(), disposes the store exactly once, and a restart reads the article back', async () => {
        const root = tempRoot('close');
        const builds: Build[] = [];

        const server = await startOf({ root, builds });

        await server.store.create('knowledge');

        const created = create(builds[0].harness, 'Written in the last tick', ['The barrier is what writes this.']);

        // Synchronously after the mutation the file does NOT exist: the commit pass yields one
        // microtask, so the next assertion measures the barrier rather than a completed write.
        expect(fs.existsSync(knowledgeArticleFileOf(root, created.article.id))).toBe(false);

        await server.close();

        // THE BARRIER: `close()` awaited the flush, so the article's file is now on disk.
        const onDisk = JSON.parse(
            fs.readFileSync(knowledgeArticleFileOf(root, created.article.id), 'utf8')
        ) as { article: { title: string; content: { text: string }[] } };

        expect(onDisk.article.title).toBe('Written in the last tick');
        expect(onDisk.article.content.map((line) => line.text)).toEqual(['The barrier is what writes this.']);

        // AND the listener disposed it exactly once: the root's entry is gone, so no second
        // dispose can fire and no other party (a session's `harness.dispose`) did.
        expect(peekHarnessKnowledge(root)).toBeUndefined();

        // A fresh listener over the same root reads the SAME article back: the base outlived the
        // listener that wrote it, and the next listener gets a usable store rather than a
        // disposed one.
        const restarted: Build[] = [];

        const next = await startOf({ root, builds: restarted });

        try {
            expect(next.knowledge).toBeDefined();
            expect(next.knowledge).not.toBe(server.knowledge);

            await next.store.create('knowledge');

            expect(titles(restarted[0].harness)).toEqual(['Written in the last tick']);
        } finally {
            await next.close();
        }
    });

    it('gives a second listener the same store for one root, and its own store for another root', async () => {
        const left = tempRoot('root-left');
        const right = tempRoot('root-right');
        const builds: Build[] = [];

        const first = await startOf({ root: left, builds });
        const second = await startOf({ root: left, builds });
        const other = await startOf({ root: right, builds });

        try {
            // ONE per root…
            expect(second.knowledge).toBe(first.knowledge);

            // …and never shared ACROSS roots, exactly like the runtime singleton it sits beside.
            expect(other.knowledge).not.toBe(first.knowledge);
            expect(other.knowledge!.directory).toBe(path.join(right, 'harness', 'knowledge'));
            expect(first.knowledge!.directory).toBe(path.join(left, 'harness', 'knowledge'));
        } finally {
            // The first close disposes the shared store; the second close is a no-op on the
            // evicted entry rather than a double dispose (./runtime.ts `disposeHarnessKnowledge`).
            await second.close();
            await first.close();
            await other.close();
        }
    });

    it('leaves <root>/harness/knowledge/ byte-identical when a session is deleted', async () => {
        const root = tempRoot('delete');
        const builds: Build[] = [];

        const server = await startOf({ root, builds });

        try {
            const doomed = await server.store.create('knowledge');
            const kept = await server.store.create('knowledge');

            // One article per session, so the tree holds a mix the deletion could plausibly
            // disturb — including one the DELETED session alone wrote.
            create(builds[0].harness, 'Written by the doomed session', ['Outlives its author.']);
            create(builds[1].harness, 'Written by the survivor', ['Untouched.']);

            await server.knowledge!.flush();

            const directory = knowledgeDirectoryOf(root);
            const before = treeOf(directory);

            expect(Object.keys(before).length).toBe(3);
            expect(before['index.json']).toBeDefined();
            expect(fs.existsSync(harnessSessionFileOf(root, doomed.id))).toBe(true);

            expect(await server.store.remove(doomed.id)).toBe(true);

            // THE PIN: the whole knowledge tree, path for path and byte for byte.
            expect(treeOf(directory)).toEqual(before);

            // …and the deletion really happened, so the equality above is not vacuous: the shard
            // is gone and the committed document no longer names the session.
            expect(fs.existsSync(harnessSessionFileOf(root, doomed.id))).toBe(false);
            expect(fs.existsSync(harnessSessionFileOf(root, kept.id))).toBe(true);
            expect(
                (readPersistedDocument(root).sessions as { id: string }[]).map((record) => record.id)
            ).toEqual([kept.id]);

            // The deleted session's ARTICLE is still there, readable from the survivor.
            expect(titles(builds[1].harness)).toEqual([
                'Written by the doomed session',
                'Written by the survivor'
            ]);
        } finally {
            await server.close();
        }
    });

    it('offers knowledge in memory with NO database root, and writes nothing to the filesystem', async () => {
        // A scratch directory that is never used as a root; together with the fs spies below it is
        // the "no filesystem writes" half of acceptance 4.
        const scratch = tempRoot('no-root-fs');
        const builds: Build[] = [];

        // The ORIGINAL functions are captured first: a pass-through spy that called `fs[name]()`
        // would recurse into itself.
        const touched: string[] = [];
        const originals = {
            openSync: fs.openSync,
            writeFileSync: fs.writeFileSync,
            renameSync: fs.renameSync,
            mkdirSync: fs.mkdirSync
        };

        const spies = (Object.keys(originals) as (keyof typeof originals)[]).map((name) =>
            vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
                const target = args[0];

                if (typeof target === 'string' || target instanceof URL) touched.push(String(target));

                return (originals[name] as unknown as (...inner: unknown[]) => unknown)(...args);
            }) as never)
        );

        const server = await startOf({ builds });

        try {
            // NO root ⇒ NO durable store — stated, not faked.
            expect(server.knowledge).toBeUndefined();
            expect(peekHarnessKnowledge(null)).toBeUndefined();

            await server.store.create('knowledge');

            const engine = builds[0].received as HarnessKnowledgeStore;

            // The handle carries an ENGINE with no durability verbs, so the `knowledge` tool
            // reports "in memory" instead of promising a file.
            expect(builds[0].harness.knowledge).toBe(engine);
            expect(engine.flush).toBeUndefined();
            expect(engine.commit).toBeUndefined();
            expect(engine.directory).toBeUndefined();

            create(builds[0].harness, 'In memory only', ['No store, no bytes.']);

            expect(titles(builds[0].harness)).toEqual(['In memory only']);

            // THE WRITES: nothing touched a path under `harness/knowledge`.
            expect(touched.filter((target) => target.includes(path.join('harness', 'knowledge')))).toEqual([]);
            expect(fs.existsSync(path.join(scratch, 'harness'))).toBe(false);
        } finally {
            for (const spy of spies) spy.mockRestore();

            await server.close();
        }
    });

    it('forwards the base through the shipped toolbox factory, not only through a test preset', () => {
        // A BARE engine, which is the shape ../runtime.ts hands a build before its store settles
        // (and the posture a lane worker replica is in). The point of the test is the ONE line in
        // ./harnesses/toolbox.ts: a host factory that does not know about knowledge still gets
        // the deployment's base onto the handle.
        const engine = createKnowledgeEngine();

        const built = createToolboxHarness(
            {
                agents: {
                    writer: agent({
                        model: SETTINGS.model,
                        instruction: 'You are the toolbox scripted agent.',
                        stream: answerStream('quiet')
                    })
                },
                entry: 'writer',
                ranks: { writer: 'A' },
                // Tool-less posture: this test pins ONE forwarding line, not the catalogue.
                sharedToolbox: false
            },
            SETTINGS,
            async () => undefined,
            { knowledge: engine }
        );

        expect(built.knowledge).toBe(engine);

        create(built, 'Built by the toolbox', ['Forwarded, not wrapped.']);

        expect(titles(built)).toEqual(['Built by the toolbox']);

        // An engine-shaped member stays durability-free: no `flush` was invented on the way
        // through the factory (../types `HarnessKnowledge`).
        expect(built.knowledge).not.toHaveProperty('flush');
    });
});
