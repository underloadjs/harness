// T7 — the KNOWLEDGE SEAM on the harness handle.
//
// WHAT THIS FILE PINS (each item is a harness-integration fact; the engine's own semantics are
// ../core/knowledge.test.ts's job):
//
//   1. `harness({})` exposes a WORKING `knowledge` — the create/search/read/modify/remove
//      round-trip runs through the handle member, not through an engine the test built. An
//      unconfigured host must never specialise "no knowledge", and the member carries NO
//      durability verbs, so the `knowledge` tool cannot claim bytes this host will not write
//      (../types `HarnessKnowledge`: presence of `flush` IS the durability signal, and
//      `harness()` never invents a no-op one).
//   2. `harness({ knowledge: store })` uses the HOST's store, BY REFERENCE: two harness handles
//      built on one store instance see each other's articles — the library-level proof of
//      cross-session persistence (one session's article is the next session's to read) and the
//      proof the harness neither copies nor wraps the base.
//   3. The member is STABLE and READ-ONLY: a getter, so nothing can be assigned through the
//      handle and detach a harness from the deployment's base.
//   4. A configuration value that is neither a store nor an engine fails at CONSTRUCTION,
//      naming both factories AND the specifier each one is imported from — and BOTH names are
//      pinned live on the published surface (`@underload/harness` and `@underload/harness/server`),
//      so the refusal's advice is followable (T15/F1: the reviewer measured the knowledge factories
//      `undefined` beside `createRecordEngine: 'function'`).
//   5. Knowledge is NOT session state: `reset()` keeps it, and `snapshot()`/`restore()` never
//      carry its bytes (a per-session copy of a deployment-wide base is exactly how one
//      session's restart would silently rewrite another's articles).
//   6. One harness's teardown never disposes a host-owned store: after `harness.dispose()`,
//      another harness on the same store still reads AND still writes durable bytes.
//
// Cross-references:
//   - ../types/index.ts                   — `HarnessConfiguration.knowledge`, `Harness.knowledge`, `HarnessKnowledge`
//   - ./harness.ts                        — `knowledgeSourceOf` (the validator), the handle's `knowledge` getter
//   - ./core/knowledge.ts                 — the engine (T4)
//   - ./server/knowledge-file-store.ts    — the durable subscriber (T5), used here FOR REAL, so item 2
//                                           pins the shipping store rather than a stub
//   - ./server/knowledge-session.test.ts  — the same seam from the SERVER side: one store per database
//                                           root, session deletion, the shutdown flush
//
// Temp files go under the REPO-ROOT `Temp/`, resolved through `import.meta.url`, and every path
// is absolute: this file never chdir's and never touches the OS temp directory
// (../tools/files/edit.test.ts:67 is the style this follows).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, harness } from '@underload/harness';
import type {
    Agent,
    Harness,
    HarnessConfiguration,
    HarnessKnowledge,
    HarnessKnowledgeStore,
    HarnessStream,
    KnowledgeCreateResult,
    KnowledgeEngine,
    KnowledgeModifyResult,
    KnowledgeOperation,
    KnowledgePageResult,
    KnowledgeReadResult,
    KnowledgeRemoveResult,
    KnowledgeSearchResult
} from '@underload/harness';
import { createKnowledgeEngine } from './core';
import { HarnessError } from './util';
import { knowledgeArticleFileOf, knowledgeDirectoryOf, loadKnowledgeFileStore } from './server/knowledge-file-store';
// T15/F1 — the PUBLISHED spelling of the two factories `knowledgeSourceOf` names in its
// construction refusal. These are the bare specifiers a host writes (../package.json `exports`
// → `src/index.ts` for the Node root, `src/server/index.ts` for the `/server` subpath), so the
// import statement IS the type-level pin: a missing re-export stops compiling here instead of
// turning the refusal's advice into a dead end. The runtime assertions below are the sibling pin
// the reviewer measured by hand (`createRecordEngine: 'function'` beside
// `createKnowledgeEngine: undefined`).
import {
    createKnowledgeEngine as publishedKnowledgeEngine,
    createRecordEngine as publishedRecordEngine,
    loadKnowledgeFileStore as publishedKnowledgeStore
} from '@underload/harness';
import { loadKnowledgeFileStore as publishedKnowledgeStoreFromServer } from '@underload/harness/server';

const TEMP_ROOT = fileURLToPath(new URL('../../../Temp', import.meta.url));

const roots: string[] = [];

const tempRoot = (): string => {
    mkdirSync(TEMP_ROOT, { recursive: true });

    const root = mkdtempSync(join(TEMP_ROOT, 'harness-knowledge-'));

    roots.push(root);

    return root;
};

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// The smallest real harness: one scripted agent that answers with text, so construction,
// `reset()` and `snapshot()`/`restore()` behave exactly as they do in a live session.
const quietStream: HarnessStream = async function* () {
    yield { type: 'text', delta: 'quiet' };
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

const brain = (): Agent => agent({ model: 'scripted/test', stream: quietStream });

// The library consumer's call — no `knowledge` at all, which is acceptance item 1's posture.
//
// A one-agent roster needs no `ranks` map: `entry` alone places `writer` at Rank A
// (src/harness.ts, the ranks rule 1 default) and there is nobody below it to delegate to.
const quietHarness = (): Harness =>
    harness({ agents: { writer: brain() }, entry: 'writer', presets: false });

// A harness configured with a host-owned base (a store, or a bare engine).
const hostedHarness = (knowledge: HarnessKnowledge): Harness =>
    harness({ agents: { writer: brain() }, entry: 'writer', presets: false, knowledge });

// A harness configured with something that is neither, for the construction-refusal pins. The
// cast is deliberate: the compiler already refuses these, and the runtime validator is what is
// under test (a host that builds a config dynamically still reaches it).
const brokenHarness = (knowledge: unknown): Harness =>
    harness({
        agents: { writer: brain() },
        entry: 'writer',
        presets: false,
        knowledge: knowledge as HarnessConfiguration['knowledge']
    });

// THE DOOR A TOOL USES: `context.harness.knowledge.engine.execute(op, context)`. Accepting a
// handle or a bare engine keeps one set of helpers for both postures; a handle's member may be
// either shape, so `engine` is read first and the member itself is the fallback.
const engineOf = (target: Harness | KnowledgeEngine): KnowledgeEngine => {
    const knowledge = (target as Harness).knowledge;

    if (knowledge === undefined) return target as KnowledgeEngine;

    return (knowledge as HarnessKnowledgeStore).engine ?? (knowledge as KnowledgeEngine);
};

// Per-verb casts in the style of ./core/knowledge.test.ts:113 — the union is the input, and the
// verb-specific result is what each assertion reads.
const execute = <TResult>(target: Harness | KnowledgeEngine, operation: KnowledgeOperation): TResult =>
    engineOf(target).execute(operation) as unknown as TResult;

const create = (target: Harness | KnowledgeEngine, title: string, content: string[]): KnowledgeCreateResult =>
    execute<KnowledgeCreateResult>(target, { verb: 'create', title, content });

const read = (target: Harness | KnowledgeEngine, id: string): KnowledgeReadResult =>
    execute<KnowledgeReadResult>(target, { verb: 'read', id });

const search = (target: Harness | KnowledgeEngine, query: string): KnowledgeSearchResult =>
    execute<KnowledgeSearchResult>(target, { verb: 'search', query });

const list = (target: Harness | KnowledgeEngine): KnowledgePageResult =>
    execute<KnowledgePageResult>(target, { verb: 'list' });

const modify = (target: Harness | KnowledgeEngine, id: string, title: string): KnowledgeModifyResult =>
    execute<KnowledgeModifyResult>(target, { verb: 'modify', id, title });

const remove = (target: Harness | KnowledgeEngine, id: string): KnowledgeRemoveResult =>
    execute<KnowledgeRemoveResult>(target, { verb: 'remove', id });

// The TITLES the files in `<root>/harness/knowledge/` carry, sorted: durability asserted at the
// byte level rather than through a report, so a passing test means the article is on disk.
const titlesOnDisk = (root: string): string[] =>
    readdirSync(knowledgeDirectoryOf(root))
        .filter((name) => name.endsWith('.json') && name !== 'index.json')
        .map((name) => {
            const file = JSON.parse(readFileSync(join(knowledgeDirectoryOf(root), name), 'utf8')) as {
                article?: { title?: string };
            };

            return file.article?.title ?? '';
        })
        .sort();

describe('T7 — harness({}) knowledge: the unconfigured host', () => {
    it('answers the whole create/search/read/modify/remove round-trip through the handle', () => {
        const writer = quietHarness();

        // The member exists with NO configuration, and it is an engine: no durability verbs.
        // This is the honesty pin — an invented no-op `flush` here would let the tool promise
        // bytes on a host that owns no store.
        expect(writer.knowledge).toBeDefined();
        expect(typeof engineOf(writer).execute).toBe('function');
        expect(writer.knowledge).not.toHaveProperty('flush');
        expect(writer.knowledge).not.toHaveProperty('commit');
        expect(writer.knowledge).not.toHaveProperty('dispose');
        expect(writer.knowledge).not.toHaveProperty('directory');

        const created = create(writer, 'Release procedure', ['Tag the build.', 'Smoke-test the installer.']);

        expect(created.article.title).toBe('Release procedure');
        expect(created.article.content.map((line) => line.text)).toEqual([
            'Tag the build.',
            'Smoke-test the installer.'
        ]);

        // `search` answers the article the HANDLE just created — the door the tool uses.
        expect(search(writer, 'Release').articles.map((article) => article.title)).toEqual([
            'Release procedure'
        ]);

        const article = read(writer, created.article.id);

        expect(article.id).toBe(created.article.id);
        expect(article.title).toBe('Release procedure');
        expect(article.paragraphs?.map((line) => line.text)).toEqual([
            'Tag the build.',
            'Smoke-test the installer.'
        ]);

        expect(modify(writer, created.article.id, 'Release procedure v2').article.title).toBe(
            'Release procedure v2'
        );

        expect(remove(writer, created.article.id).removed.title).toBe('Release procedure v2');
        expect(list(writer).articles).toEqual([]);
    });

    it('hands the SAME object on every read and refuses an assignment through the handle', () => {
        const writer = quietHarness();
        const first = writer.knowledge;

        expect(writer.knowledge).toBe(first);

        // A getter without a setter: an ES module is always strict, so an assignment THROWS
        // rather than silently detaching this harness from the base it was configured with.
        expect(() => {
            (writer as unknown as { knowledge: unknown }).knowledge = createKnowledgeEngine();
        }).toThrow(TypeError);

        expect(writer.knowledge).toBe(first);
    });

    it('refuses a configuration value that is neither a store nor an engine, at construction', () => {
        // A bare object is the mistake the validator exists for: it would otherwise read as
        // durable to the tool while owning no engine at all.
        expect(() => brokenHarness({})).toThrow(HarnessError);
        expect(() => brokenHarness(7)).toThrow(HarnessError);

        try {
            brokenHarness({});
        } catch (error) {
            expect((error as Error).message).toContain('knowledge store');
            expect((error as Error).message).toContain('knowledge engine');
        }

        // THE PRIMITIVE CASE NAMES BOTH FACTORIES — and T15/F1 pins that it also says WHERE they
        // come from, because advice pointing at a name a consumer cannot import is not advice.
        try {
            brokenHarness(7);
        } catch (error) {
            const message = (error as Error).message;

            expect(message).toContain('loadKnowledgeFileStore');
            expect(message).toContain('createKnowledgeEngine');
            expect(message).toContain("'@underload/harness'");
            expect(message).toContain("'@underload/harness/server'");
            expect(message).toContain('received number');
        }
    });

    it('publishes both factories the construction refusal names, on the surface it names', () => {
        // The runtime half of the import pins above: the root barrel a Node host installs has to
        // answer with the SAME function objects the internals use, so the refusal's advice is
        // followable AND cannot drift to a second copy of either factory. `createRecordEngine` is
        // the yardstick — it has been on this surface since the records engine, and the knowledge
        // factory now sits beside it in ./harness.ts.
        expect(typeof publishedRecordEngine).toBe('function');
        expect(typeof publishedKnowledgeEngine).toBe('function');
        expect(typeof publishedKnowledgeStore).toBe('function');
        expect(publishedKnowledgeEngine).toBe(createKnowledgeEngine);
        expect(publishedKnowledgeStore).toBe(loadKnowledgeFileStore);

        // The `/server` subpath the message quotes for the store factory, pinned separately
        // because the root reaching it does not prove the subpath does.
        expect(publishedKnowledgeStoreFromServer).toBe(loadKnowledgeFileStore);
    });

    it('keeps knowledge across reset(), because a reset is a new conversation, not a new deployment', () => {
        const writer = quietHarness();
        const created = create(writer, 'Deployment map', ['The edge node is in Rack 3.']);

        writer.reset();

        expect(read(writer, created.article.id).title).toBe('Deployment map');
        expect(list(writer).articles.map((article) => article.title)).toEqual(['Deployment map']);
    });

    it('never carries knowledge in the snapshot, and a restore cannot move articles between engines', () => {
        const writer = quietHarness();
        const created = create(writer, 'Private to one engine', ['This base is not session state.']);

        const snapshot = writer.snapshot();
        const serialized = JSON.stringify(snapshot);

        // No knowledge field, and the article's own bytes are absent: the strongest statement
        // available that the base lives outside the per-session document (T7 decision 6).
        expect(Object.keys(snapshot)).not.toContain('knowledge');
        expect(serialized).not.toContain('Private to one engine');
        expect(serialized).not.toContain(created.article.id);

        // A fresh harness (its own engine) restores that snapshot and still owns an EMPTY base:
        // restoring somebody else's conversation cannot import their articles.
        const restored = quietHarness();

        restored.restore(snapshot);

        expect(list(restored).articles).toEqual([]);
        expect(read(writer, created.article.id).title).toBe('Private to one engine');
    });
});

describe('T7 — harness({ knowledge }): a host-provided base', () => {
    it('shares one article set between two harness handles built on the same store', async () => {
        const root = tempRoot();
        const store = await loadKnowledgeFileStore({ root });

        const first = hostedHarness(store);
        const second = hostedHarness(store);

        // PASS-THROUGH BY REFERENCE: the handle member IS the host's store, so object identity is
        // the proof of sharing — no wrapper, no copy, no second subscriber on one directory.
        expect(first.knowledge).toBe(store);
        expect(second.knowledge).toBe(store);
        expect(second.knowledge).toBe(first.knowledge);
        expect(engineOf(second)).toBe(store.engine);

        // Durability is TRUE now, and stated by presence plus the real directory: the tree is
        // `<databaseRoot>/harness/knowledge/`, i.e. beside `harness/sessions/` and OUTSIDE every
        // session folder — which is what lets it outlive a session.
        expect(store.flush).toBeTypeOf('function');
        expect((second.knowledge as HarnessKnowledgeStore).directory).toBe(join(root, 'harness', 'knowledge'));

        const created = create(first, 'Shared runbook', ['Restart the gateway at 03:00.']);

        // Session B sees it through ITS handle, with no commit and no reload.
        expect(read(second, created.article.id).paragraphs?.[0].text).toBe('Restart the gateway at 03:00.');
        expect(list(second).articles.map((article) => article.title)).toEqual(['Shared runbook']);

        // And B's edit is A's to read: sharing is not one-way.
        modify(second, created.article.id, 'Shared runbook v2');

        expect(read(first, created.article.id).title).toBe('Shared runbook v2');

        // The BYTES, at the canonical path (`intervalMs` is 0, so one microtask after the
        // mutation; the awaited flush is the barrier that makes the read deterministic).
        await store.flush();

        const onDisk = JSON.parse(readFileSync(knowledgeArticleFileOf(root, created.article.id), 'utf8')) as {
            version: number;
            article: { id: string; title: string; content: { text: string }[] };
        };

        expect(onDisk.version).toBe(1);
        expect(onDisk.article.id).toBe(created.article.id);
        expect(onDisk.article.title).toBe('Shared runbook v2');
        expect(onDisk.article.content.map((line) => line.text)).toEqual(['Restart the gateway at 03:00.']);

        await store.dispose();
    });

    it('survives one harness being disposed: a host-owned store is disposed by its host, once', async () => {
        const root = tempRoot();
        const store = await loadKnowledgeFileStore({ root });

        const first = hostedHarness(store);
        const second = hostedHarness(store);

        create(first, 'Written before teardown', ['A teardown hook must not unsubscribe this.']);

        // T1.6's teardown fires `harness.dispose`. Knowledge is untouched by it: the store belongs
        // to the host, and disposing it here would stop every OTHER session's writes without a
        // word (../harness.ts keeps the matching note, and ./start.ts owns the one disposal).
        first.dispose();

        create(second, 'Written after teardown', ['Still durable, still shared.']);

        await store.flush();

        expect(titlesOnDisk(root)).toEqual(['Written after teardown', 'Written before teardown']);
        // Sorted, because both articles are written inside one engine tick and `list`'s
        // newest-change-first order cannot separate them; the SET and its titles are the fact.
        expect(list(second).articles.map((article) => article.title).sort()).toEqual([
            'Written after teardown',
            'Written before teardown'
        ]);

        // And it is still the HOST's call: a second dispose is idempotent, and nothing above made it.
        expect(await store.dispose()).toBeUndefined();
    });

    it('accepts a bare engine a host owns, and every harness over it shares one in-memory base', () => {
        const engine = createKnowledgeEngine();

        const first = hostedHarness(engine);
        const second = hostedHarness(engine);

        expect(first.knowledge).toBe(engine);
        expect(second.knowledge).toBe(engine);

        const created = create(first, 'In memory only', ['No store, no bytes.']);

        expect(read(second, created.article.id).title).toBe('In memory only');

        // A bare engine carries no durability verbs, so the tool reports "in memory" instead of
        // promising a file.
        expect(second.knowledge).not.toHaveProperty('flush');
    });
});
