// T7 — the KNOWLEDGE SEAM as the SERVER uses it.
//
// The engine half (`harness({})` and a bare host engine) lives with the engine in
// `src/engine/harness.knowledge.test.ts`. This file keeps the pieces that need the
// server's durable store: the shipped factory on the published surfaces, two harness
// handles sharing one store, and harness teardown not owning the host's store.
//
// Cross-references:
//   - ./knowledge-file-store.ts            — the durable subscriber (T5)
//   - ./knowledge-session.test.ts          — the same seam from the session side
//   - ../engine/harness.knowledge.test.ts  — the engine-only seam

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, harness } from '../engine/index';
import type {
    Agent,
    Harness,
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
} from '../engine/index';
import { createKnowledgeEngine } from '../engine/core';
import {
    knowledgeArticleFileOf,
    knowledgeDirectoryOf,
    loadKnowledgeFileStore
} from './knowledge-file-store';
import {
    createKnowledgeEngine as publishedKnowledgeEngine,
    createRecordEngine as publishedRecordEngine,
    loadKnowledgeFileStore as publishedKnowledgeStore
} from '../index';
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

describe('T7 — harness({ knowledge }): the server durable store', () => {
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

});
