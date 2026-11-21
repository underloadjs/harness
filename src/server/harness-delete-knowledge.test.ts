// T6 — HARNESS-OWNED KNOWLEDGE ATTRIBUTION AND SCOPED DELETION.
//
// WHAT THIS FILE PINS (the product decision: owner-based cleanup, NOT read isolation and NOT
// a deployment-wide reset):
//   1. ATTRIBUTION AT CREATION. An article created through a server-built harness carries the
//      canonical preset name (`harness: 'alpha'` / `'beta'`), while a direct engine create —
//      no harness identity — keeps the pre-T6 shape with NO `harness` key. Model-supplied
//      `harness` fields are refused as unknown on `create` and `modify`, and a successful
//      `modify` retains the original owner.
//   2. SHARED VISIBILITY IS UNCHANGED. Both harnesses still list/read each other's articles.
//      Attribution adds provenance; it does not filter reads.
//   3. OWNER SURVIVES PERSISTENCE. The article file carries `harness`; unowned files do not;
//      a reload reads both back. Strict validation accepts a valid owner and refuses a bad
//      one with the reader's own wording.
//   4. 409 AND REGISTRY-FAILURE PATHS TOUCH NO KNOWLEDGE. The guard returns before cleanup,
//      and a failed harness-document write rolls the registry back before cleanup.
//   5. SUCCESSFUL DELETE REMOVES ALL AND ONLY THE OWNED ARTICLES. A's articles and files are
//      gone; B's, unowned legacy rows and a `storyline-knowledge` row survive; the index no
//      longer names A; the store watermark moved (never reset to 0) and the directory still
//      exists. Durable after a reload.
//   6. IN-MEMORY cleanup works the same way with no filesystem at all.
//   7. SESSION DELETION still changes no knowledge byte (the whole tree is compared) — the
//      cleanup belongs to harness deletion alone.
//   8. THE SHIPPED TOOLBOX forwards `knowledgeOwner`, so production presets attribute even
//      though they never mention the field themselves.
//
// Determinism: scripted agents (no provider, no network), exact receipts/keys, and temp roots
// under the REPO-ROOT `Temp/` resolved through `import.meta.url` (the layout
// ./knowledge-session.test.ts:52-64 uses).
//
// Cross-references:
//   - ../types/index.ts                     — `KnowledgeArticle.harness`,
//                                             `KnowledgeArticleMeta.harness`,
//                                             `HarnessConfiguration.knowledgeOwner`,
//                                             `Harness.knowledgeOwner`
//   - ../core/knowledge.ts                  — `ownerOfContext` / `createArticle` / readers
//   - ../harness.ts                         — `knowledgeOwnerOf` + the handle getter
//   - ./sessions.ts                         — `buildHarness` report, `removeKnowledgeOwnedBy`
//   - ./api.ts                              — `deleteHarness`'s post-commit cleanup
//   - ./harnesses/toolbox.ts                — the report -> configuration forwarding line
//   - ../server/knowledge-file-store.ts     — the per-article files and `index.json`

import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, harness } from '../harness';
import type {
    Harness,
    HarnessStream,
    HarnessStreamEvent,
    KnowledgeCreateResult,
    KnowledgeEngine,
    ToolTextEnvelope
} from '../harness';
import { createKnowledgeEngine } from '../core';
import { knowledge as knowledgeTool } from '../tools/runtime/knowledge.tool';
import { createHarnessRegistry } from './harnesses';
import { createToolboxHarness } from './harnesses/toolbox';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { SessionStore } from './sessions';
import { HarnessPersistence } from './persistence';
import {
    knowledgeArticleFileOf,
    knowledgeDirectoryOf,
    loadKnowledgeFileStore
} from './knowledge-file-store';
import type { KnowledgeStore } from './knowledge-file-store';
import { HARNESS_ROUTES } from '../shared/harness-api';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');

fs.mkdirSync(TEMP_ROOT, { recursive: true });

const roots: string[] = [];

const tempRoot = (label: string): string => {
    const root = fs.mkdtempSync(path.join(TEMP_ROOT, `harness-delete-knowledge-${label}-`));

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

const MOUNT = '/v1/harness';

const answerStream = (text: string): HarnessStream =>
    async function* (): AsyncGenerator<HarnessStreamEvent> {
        yield { type: 'text', delta: text };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };

// The scripted preset, built through the REAL toolbox factory so the attribution line under
// test is the shipped one. `report` -> `createToolboxHarness` -> `harness({ knowledgeOwner })`
// is the production hop chain; this factory itself never names the owner.
const ownedPreset = (name: string, builds: Harness[]): HarnessPreset => ({
    name,
    title: `${name} fixture`,
    description: `Scripted T6 ownership fixture "${name}".`,
    requiresEndpoint: false,
    entry: 'writer',
    ranks: { writer: 'A' },
    agents: ['writer'],
    tools: [],
    builtin: false,
    editable: true,
    create: (settings, progress, report) => {
        const built = createToolboxHarness(
            {
                agents: {
                    writer: agent({
                        model: settings.model,
                        instruction: `You are the ${name} ownership fixture.`,
                        stream: answerStream('quiet')
                    })
                },
                entry: 'writer',
                ranks: { writer: 'A' },
                // The knowledge tool must be registered for the tool-door tests. Everything
                // else in the shared toolbox is irrelevant here, but leaving the default on
                // is what a production card does; discovery stays cheap because the run never
                // asks for it.
                sharedToolbox: true
            },
            settings,
            progress,
            report
        );

        builds.push(built);

        return built;
    }
});

type Context = {
    engine: KnowledgeEngine;
    store: SessionStore;
    registry: ReturnType<typeof createHarnessRegistry>;
    api: ReturnType<typeof createHarnessApi>;
    builds: Record<string, Harness[]>;
    knowledge?: KnowledgeStore;
    sessions: Record<string, string>;
};

const createContext = async (
    options: { root?: string; engines?: KnowledgeEngine; brokenPersistence?: string } = {}
): Promise<Context> => {
    const engine = options.engines ?? createKnowledgeEngine();
    const durableKnowledge =
        options.root === undefined ? undefined : await loadKnowledgeFileStore({ root: options.root, engine });

    // A broken persistence path is how the registry-write failure is produced for real (no
    // mock): its parent is a plain FILE, so the harness document cannot be written.
    const persistence =
        options.brokenPersistence === undefined ? undefined : new HarnessPersistence(options.brokenPersistence);
    const durablePersistence =
        options.root !== undefined && persistence === undefined ? new HarnessPersistence(options.root) : persistence;

    const builds: Record<string, Harness[]> = { alpha: [], beta: [] };
    const registry = createHarnessRegistry([ownedPreset('alpha', builds.alpha), ownedPreset('beta', builds.beta)]);
    const store = new SessionStore(SETTINGS, registry, undefined, {
        knowledge: durableKnowledge ?? engine,
        ...(durablePersistence === undefined ? {} : { persistence: durablePersistence })
    });
    const api = createHarnessApi({ store, defaults: DEFAULTS, registry });

    return {
        engine,
        store,
        registry,
        api,
        builds,
        ...(durableKnowledge === undefined ? {} : { knowledge: durableKnowledge }),
        sessions: {}
    };
};

const createSession = async (context: Context, harnessName: string): Promise<string> => {
    const session = await context.store.create(harnessName);

    context.sessions[harnessName] = session.id;

    return session.id;
};

// The model/operator door: the registered knowledge tool with the live ToolContext. It returns
// the branded text envelope, so `content` is the engine's own result.
const createThrough = async (
    built: Harness,
    title: string,
    content: string[]
): Promise<KnowledgeCreateResult> => {
    const envelope = (await built.executeTool('knowledge', {
        verb: 'create',
        title,
        content
    })) as ToolTextEnvelope<KnowledgeCreateResult>;

    return envelope.content;
};

const call = (
    api: ReturnType<typeof createHarnessApi>,
    method: string,
    pathname: string,
    body: unknown = {}
): Promise<HarnessApiResult> =>
    api({
        method,
        pathname,
        mount: MOUNT,
        readBody: async <T>() => body as T
    } as HarnessApiRequest);

const jsonOf = (result: HarnessApiResult): { status: number; body: Record<string, any> } => {
    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return { status: result.status, body: result.body as Record<string, any> };
};

const labels = (engine: KnowledgeEngine): { title: string; harness: string | undefined }[] =>
    engine
        .articles()
        .map((article) => ({ title: article.title, harness: article.harness }))
        .sort((left, right) => left.title.localeCompare(right.title));

// EVERY byte under `<root>/harness/knowledge/`, keyed by relative path. The same digest
// ./knowledge-session.test.ts uses, so "untouched" covers the index and every article file.
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

describe('T6 — attribution at creation', () => {
    it('stamps the canonical harness on harness-created articles, keeps direct creates unowned, and shares reads', async () => {
        const context = await createContext();

        await createSession(context, 'alpha');
        await createSession(context, 'beta');

        const alpha = context.builds.alpha[0];
        const beta = context.builds.beta[0];

        // The report hop set the trusted identity on the handle; the tool stamps it without any
        // operation field.
        expect(alpha.knowledgeOwner).toBe('alpha');
        expect(beta.knowledgeOwner).toBe('beta');

        const fromAlpha = await createThrough(alpha, 'Alpha runbook', ['Alpha owns this.']);
        const fromBeta = await createThrough(beta, 'Beta runbook', ['Beta owns this.']);

        // A direct engine call has no harness identity, so the article keeps the pre-T6 key set.
        const unowned = context.engine.execute({
            verb: 'create',
            title: 'Deployment note',
            content: ['Nobody owns this.']
        }) as KnowledgeCreateResult;

        expect(fromAlpha.article.harness).toBe('alpha');
        expect(fromBeta.article.harness).toBe('beta');
        expect('harness' in unowned.article).toBe(false);
        expect(Object.keys(unowned.article)).toEqual([
            'id',
            'title',
            'createdAt',
            'updatedAt',
            'tags',
            'content',
            'rev'
        ]);

        // SHARED VISIBILITY: beta sees all three, including alpha's and the unowned row. The
        // owner rides the summary projection for the two attributed rows only.
        expect(labels(context.engine)).toEqual([
            { title: 'Alpha runbook', harness: 'alpha' },
            { title: 'Beta runbook', harness: 'beta' },
            { title: 'Deployment note', harness: undefined }
        ]);
        expect((context.engine.execute({ verb: 'list' }) as { articles: unknown[] }).articles).toHaveLength(3);
        expect(context.engine.read({ id: fromAlpha.article.id }).harness).toBe('alpha');

        // `modify` edits a copy of the stored article, so the owner survives a rename.
        const modified = (await alpha.executeTool('knowledge', {
            verb: 'modify',
            id: fromAlpha.article.id,
            title: 'Alpha runbook v2'
        })) as ToolTextEnvelope<{ article: { harness?: string } }>;

        expect(modified.content.article.harness).toBe('alpha');

        // The MODEL-SUPPLIED field is refused by the tool's published schema first: `harness` is
        // not on the operation schema, so the model path cannot reach the engine with one.
        await expect(
            alpha.executeTool('knowledge', {
                verb: 'create',
                title: 'Forged',
                content: ['x'],
                harness: 'beta'
            })
        ).rejects.toThrow('$.operation must not include the additional property "harness".');

        await expect(
            alpha.executeTool('knowledge', {
                verb: 'modify',
                id: fromAlpha.article.id,
                harness: 'beta'
            })
        ).rejects.toThrow('$.operation must not include the additional property "harness".');

        // Defence in depth: a direct engine caller bypassing the schema is refused by the
        // engine's own strict key reader, with the accepted keys named.
        expect(() =>
            context.engine.execute({
                verb: 'create',
                title: 'Forged',
                content: ['x'],
                harness: 'beta'
            } as never)
        ).toThrow(
            'knowledge "create" has no field "harness"; it takes "verb", "title", "tags", "content" — fix the name or drop it.'
        );

        expect(() =>
            context.engine.execute({ verb: 'modify', id: fromAlpha.article.id, harness: 'beta' } as never)
        ).toThrow(
            'knowledge "modify" has no field "harness"; it takes "verb", "id", "title", "addTags", "removeTags", "addContent", "setParagraphs", "moveParagraphs", "removeParagraphs", "expects" — fix the name or drop it.'
        );

        // Neither refusal changed the stored owner.
        expect(context.engine.read({ id: fromAlpha.article.id }).harness).toBe('alpha');
    });

    it('forwards knowledgeOwner through the shipped toolbox factory', () => {
        const engine = createKnowledgeEngine();

        const built = createToolboxHarness(
            {
                agents: {
                    writer: agent({
                        model: SETTINGS.model,
                        instruction: 'Toolbox attribution fixture.',
                        stream: answerStream('quiet')
                    })
                },
                entry: 'writer',
                ranks: { writer: 'A' },
                // The tool catalogue is not what this test pins; the ONE forwarding line is.
                sharedToolbox: false
            },
            SETTINGS,
            async () => undefined,
            { knowledge: engine, knowledgeOwner: 'toolbox-owner' }
        );

        expect(built.knowledgeOwner).toBe('toolbox-owner');
        expect(built.knowledge).toBe(engine);
    });

    it('attributes only when the host names an owner, and refuses a malformed owner at construction', () => {
        const build = (knowledgeOwner: unknown) =>
            harness({
                agents: {
                    writer: agent({
                        model: SETTINGS.model,
                        instruction: 'Owner validation fixture.',
                        stream: answerStream('quiet')
                    })
                },
                entry: 'writer',
                ranks: { writer: 'A' },
                presets: false,
                knowledgeOwner: knowledgeOwner as string
            });

        // Absent and blank both mean UNOWNED: the handle carries no getter at all, so
        // `ownerOfContext` reads nothing and the article keeps the pre-T6 shape.
        expect('knowledgeOwner' in build(undefined)).toBe(false);
        expect('knowledgeOwner' in build('   ')).toBe(false);

        expect(build('alpha').knowledgeOwner).toBe('alpha');

        // A non-string is a host configuration error, not a silent "unowned".
        expect(() => build(7)).toThrow(
            'HarnessConfiguration.knowledgeOwner must be a harness name string; received number.'
        );
        expect(() => build('x'.repeat(65))).toThrow(
            'HarnessConfiguration.knowledgeOwner is 65 characters, over the 64-character harness name limit.'
        );
    });
});

describe('T6 — persistence and strict validation', () => {
    it('writes the owner to the article file, reads it back, and keeps unowned files key-free', async () => {
        const root = tempRoot('persist');
        const context = await createContext({ root });

        await createSession(context, 'alpha');
        await createSession(context, 'beta');

        const fromAlpha = await createThrough(context.builds.alpha[0], 'Durable alpha', ['Written by alpha.']);
        const fromBeta = await createThrough(context.builds.beta[0], 'Durable beta', ['Written by beta.']);
        const unowned = context.engine.execute({
            verb: 'create',
            title: 'Durable unowned',
            content: ['Written by nobody in particular.']
        }) as KnowledgeCreateResult;

        await context.knowledge!.flush();

        const alphaOnDisk = JSON.parse(
            fs.readFileSync(knowledgeArticleFileOf(root, fromAlpha.article.id), 'utf8')
        ) as { version: number; article: Record<string, unknown> };

        expect(alphaOnDisk.version).toBe(1);
        expect(alphaOnDisk.article.harness).toBe('alpha');
        expect(JSON.parse(fs.readFileSync(knowledgeArticleFileOf(root, fromBeta.article.id), 'utf8')).article.harness).toBe(
            'beta'
        );

        const unownedOnDisk = JSON.parse(
            fs.readFileSync(knowledgeArticleFileOf(root, unowned.article.id), 'utf8')
        ) as { article: Record<string, unknown> };

        expect('harness' in unownedOnDisk.article).toBe(false);

        // A restart: the store is disposed exactly once by its owner, then a fresh load reads
        // the same articles with the same owners.
        await context.knowledge!.dispose();

        const reloaded = await loadKnowledgeFileStore({ root });

        try {
            expect(labels(reloaded.engine)).toEqual([
                { title: 'Durable alpha', harness: 'alpha' },
                { title: 'Durable beta', harness: 'beta' },
                { title: 'Durable unowned', harness: undefined }
            ]);
            expect(reloaded.engine.read({ id: fromAlpha.article.id }).harness).toBe('alpha');
            expect(reloaded.engine.read({ id: fromBeta.article.id }).harness).toBe('beta');
        } finally {
            await reloaded.dispose();
        }
    });

    it('accepts a stored owner and refuses malformed ones with the shared reader wording', () => {
        // The strict reader is exercised through `restore`, which is the public door that runs
        // `readKnowledgeStoreState` on an unknown value.
        const base = {
            id: '9f1c2b7a-3d4e-4f6a-8b7c-1d2e3f4a5b6c',
            title: 'Stored',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            tags: [],
            content: [
                {
                    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
                    text: 'Body.',
                    rev: 1,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z'
                }
            ],
            rev: 1
        };

        const live = createKnowledgeEngine();

        live.restore({ storeRev: 1, articles: [{ ...base, harness: 'alpha' }] });
        expect(live.articles()[0].harness).toBe('alpha');

        expect(() =>
            live.restore({ storeRev: 1, articles: [{ ...base, harness: '  ' }] })
        ).toThrow(
            'EKNOWLEDGE_INPUT: knowledge state.articles[0].harness is blank; an article either names the harness that created it or omits the field (unowned).'
        );

        expect(() =>
            live.restore({ storeRev: 1, articles: [{ ...base, harness: 7 }] })
        ).toThrow('knowledge state.articles[0].harness must be a string.');

        expect(() =>
            live.restore({ storeRev: 1, articles: [{ ...base, harness: 'x'.repeat(65) }] })
        ).toThrow('knowledge state.articles[0].harness must be at most 64 characters.');
    });
});

describe('T6 — guarded and failed deletions leave knowledge untouched', () => {
    it('answers 409 while a session remains, and the whole knowledge store is unchanged', async () => {
        const context = await createContext();

        await createSession(context, 'alpha');
        await createSession(context, 'beta');

        await createThrough(context.builds.alpha[0], 'Alpha keeps', ['A.']);
        await createThrough(context.builds.beta[0], 'Beta keeps', ['B.']);
        context.engine.execute({ verb: 'create', title: 'Unowned keeps', content: ['U.'] });

        const before = JSON.parse(JSON.stringify(context.engine.snapshot()));

        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')))).toEqual({
            status: 409,
            body: {
                error: {
                    message:
                        'Harness "alpha" still owns 1 session. Delete it first; a harness can only be deleted after all of its sessions are deleted.'
                }
            }
        });

        expect(context.engine.snapshot()).toEqual(before);
        expect(labels(context.engine)).toEqual([
            { title: 'Alpha keeps', harness: 'alpha' },
            { title: 'Beta keeps', harness: 'beta' },
            { title: 'Unowned keeps', harness: undefined }
        ]);
        expect(context.registry.find('alpha')).toBeDefined();
    });

    it('answers 500 when the harness document cannot be written, and removes no knowledge', async () => {
        const root = tempRoot('registry-failure');
        const blocker = path.join(root, 'blocked');

        fs.writeFileSync(blocker, 'not a directory');

        const engine = createKnowledgeEngine();
        const context = await createContext({ engines: engine, brokenPersistence: path.join(blocker, 'nested') });

        // No session is needed to seed the articles (and none can be created over the broken
        // document): build ONE attributed handle with the same report the store would pass.
        const alpha = ownedPreset('alpha', context.builds.alpha).create(SETTINGS, async () => undefined, {
            knowledge: engine,
            knowledgeOwner: 'alpha'
        });
        const beta = ownedPreset('beta', context.builds.beta).create(SETTINGS, async () => undefined, {
            knowledge: engine,
            knowledgeOwner: 'beta'
        });

        const fromAlpha = await createThrough(alpha, 'Alpha survives', ['A.']);
        await createThrough(beta, 'Beta survives', ['B.']);
        context.engine.execute({ verb: 'create', title: 'Unowned survives', content: ['U.'] });

        const before = JSON.parse(JSON.stringify(context.engine.snapshot()));
        const failure = jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')));

        expect(failure.status).toBe(500);
        expect(failure.body.error.message).toContain('Could not save the harness database');

        // The registry rolled back AND the cleanup never ran: the harness is still directly
        // registered and every article (including A's) is still present.
        expect(context.registry.find('alpha')).toBeDefined();
        expect(context.engine.snapshot()).toEqual(before);
        expect(context.engine.read({ id: fromAlpha.article.id }).harness).toBe('alpha');
    });
});

describe('T6 — partial cleanup is surfaced, never faked', () => {
    it('answers 500 when the post-commit flush reports a failure, and the harness is already gone', async () => {
        const engine = createKnowledgeEngine();
        const root = tempRoot('flush-failure');

        // A store-shaped seam whose engine is real but whose durability barrier RESOLVES with a
        // failure report (the shape the real file layer uses when a write fails: it keeps the
        // work dirty instead of rejecting). The engine removal succeeds, the flush does not,
        // which is exactly the cross-store window the route must not report as a 200. A
        // rejecting barrier is covered by the ordinary error path; this pins the checked-report
        // branch and the store-wide attribution wording.
        const failingStore = {
            root,
            directory: path.join(root, 'harness', 'knowledge'),
            engine,
            flush: async () => ({ failure: 'simulated flush failure' })
        };

        const builds: Record<string, Harness[]> = { alpha: [], beta: [] };
        const registry = createHarnessRegistry([
            ownedPreset('alpha', builds.alpha),
            ownedPreset('beta', builds.beta)
        ]);
        const store = new SessionStore(SETTINGS, registry, undefined, { knowledge: failingStore });
        const api = createHarnessApi({ store, defaults: DEFAULTS, registry });

        await store.create('alpha');

        // Seeded directly so the test does not depend on the fake store's session harness:
        // ONE attributed handle and ONE unowned article are enough to tell the scopes apart.
        const alpha = ownedPreset('alpha', builds.alpha).create(SETTINGS, async () => undefined, {
            knowledge: failingStore,
            knowledgeOwner: 'alpha'
        });

        await createThrough(alpha, 'Alpha removed before the failure', ['A.']);
        engine.execute({ verb: 'create', title: 'Unowned survives', content: ['U.'] });

        const alphaSession = store.liveSessions().find((record) => record.preset.name === 'alpha')!;

        await store.remove(alphaSession.id);

        const failure = jsonOf(await call(api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')));

        expect(failure.status).toBe(500);
        expect(failure.body.error.message).toBe(
            'Harness "alpha" was deleted, but removing the knowledge articles it owned did not complete: Knowledge articles owned by harness "alpha" were removed from the engine, but the shared knowledge store\'s flush reported a failure (it may concern any pending knowledge write, not only this cleanup): simulated flush failure'
        );

        // The harness document DID commit (there is no rollback across the two stores), and the
        // engine removals already happened; what failed was durability. The honest answer is
        // the 500 above, and a repeat DELETE cannot retry the cleanup.
        expect(registry.find('alpha')).toBeUndefined();
        expect(labels(engine)).toEqual([{ title: 'Unowned survives', harness: undefined }]);
        expect(jsonOf(await call(api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha'))).status).toBe(404);
    });
});

describe('T6 — scoped deletion removes all and only the owner', () => {
    it('deletes A with sessions removed, keeps B/unowned/Storyline, and proves the durability barrier', async () => {
        const root = tempRoot('durable-delete');
        const context = await createContext({ root });

        const alphaSession = await createSession(context, 'alpha');
        await createSession(context, 'beta');

        // Acceptance 9: the cleanup must never take the whole-engine reset path.
        const resetSpy = vi.spyOn(context.engine, 'reset');

        const fromAlpha = await createThrough(context.builds.alpha[0], 'Alpha doomed', ['A.']);
        const secondAlpha = await createThrough(context.builds.alpha[0], 'Alpha doomed too', ['A2.']);
        const fromBeta = await createThrough(context.builds.beta[0], 'Beta survives', ['B.']);

        const unowned = context.engine.execute({
            verb: 'create',
            title: 'Legacy unowned',
            content: ['No owner field.']
        }) as KnowledgeCreateResult;
        const storyline = context.engine.execute({
            verb: 'create',
            title: 'Storyline manuscript',
            tags: ['storyline-knowledge'],
            content: ['Another consumer owns this row.']
        }) as KnowledgeCreateResult;

        await context.knowledge!.flush();

        const directory = knowledgeDirectoryOf(root);
        const beforeTree = treeOf(directory);
        const storeRevBefore = context.knowledge!.readIndex().storeRev;

        // A live session still blocks: 409, no article and no file moves.
        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha'))).status).toBe(
            409
        );
        expect(treeOf(directory)).toEqual(beforeTree);

        // SESSION deletions are the only way to clear the guard, and they still touch no byte.
        expect(await context.store.remove(alphaSession)).toBe(true);
        expect(treeOf(directory)).toEqual(beforeTree);

        // Once A has no session, the DELETE removes A's articles and nothing else. The receipt
        // shape is unchanged by T6.
        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')))).toEqual({
            status: 200,
            body: { deleted: true, harness_name: 'alpha', tombstoned: false, restored_by_restart: false }
        });

        expect(labels(context.engine)).toEqual([
            { title: 'Beta survives', harness: 'beta' },
            { title: 'Legacy unowned', harness: undefined },
            { title: 'Storyline manuscript', harness: undefined }
        ]);

        // The ENGINE was not reset and the DIRECTORY was not deleted: the surviving articles
        // kept their bytes and the store watermark only moved forward.
        expect(fs.existsSync(directory)).toBe(true);
        expect(treeOf(directory)).not.toEqual(beforeTree);
        expect(context.knowledge!.readIndex().storeRev).toBeGreaterThan(storeRevBefore!);
        expect(resetSpy).not.toHaveBeenCalled();

        // A's files are erased, B's/unowned/Storyline files remain, the index names only the
        // survivors, and the response above did not precede the erase (it awaited the flush).
        expect(fs.existsSync(knowledgeArticleFileOf(root, fromAlpha.article.id))).toBe(false);
        expect(fs.existsSync(knowledgeArticleFileOf(root, secondAlpha.article.id))).toBe(false);
        expect(fs.existsSync(knowledgeArticleFileOf(root, fromBeta.article.id))).toBe(true);
        expect(fs.existsSync(knowledgeArticleFileOf(root, unowned.article.id))).toBe(true);
        expect(fs.existsSync(knowledgeArticleFileOf(root, storyline.article.id))).toBe(true);

        const index = context.knowledge!.readIndex();
        expect(index.articles.map((row) => [row.title, row.id]).sort((left, right) => left[0].localeCompare(right[0]))).toEqual([
            ['Beta survives', fromBeta.article.id],
            ['Legacy unowned', unowned.article.id],
            ['Storyline manuscript', storyline.article.id]
        ]);

        // A RESTART reads the same survivors back: the cleanup is durable, not just in memory.
        await context.knowledge!.dispose();

        const reloaded = await loadKnowledgeFileStore({ root });

        try {
            expect(labels(reloaded.engine)).toEqual([
                { title: 'Beta survives', harness: 'beta' },
                { title: 'Legacy unowned', harness: undefined },
                { title: 'Storyline manuscript', harness: undefined }
            ]);
            expect(() => reloaded.engine.read({ id: fromAlpha.article.id })).toThrow(/^EKNOWLEDGE_NOT_FOUND: /);
        } finally {
            await reloaded.dispose();
        }
    });

    it('cleans only the owner in memory, with no filesystem dependency', async () => {
        const context = await createContext();

        await createSession(context, 'alpha');
        await createSession(context, 'beta');

        await createThrough(context.builds.alpha[0], 'Alpha in memory', ['A.']);
        await createThrough(context.builds.beta[0], 'Beta in memory', ['B.']);
        context.engine.execute({ verb: 'create', title: 'Unowned in memory', content: ['U.'] });

        // A bare engine: no durability verbs and no directory, so this path cannot be touching
        // files even accidentally.
        expect(context.knowledge).toBeUndefined();
        expect(context.engine).not.toHaveProperty('flush');
        expect(context.engine).not.toHaveProperty('directory');

        expect(await context.store.remove(context.sessions.alpha)).toBe(true);
        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')))).toEqual({
            status: 200,
            body: { deleted: true, harness_name: 'alpha', tombstoned: false, restored_by_restart: false }
        });

        expect(labels(context.engine)).toEqual([
            { title: 'Beta in memory', harness: 'beta' },
            { title: 'Unowned in memory', harness: undefined }
        ]);
    });
});

// T11/R1 — THE IN-FLIGHT REMOVAL WINDOW.
//
// `SessionStore.remove` deletes from the live map BEFORE awaiting its durable write, so a plain
// `liveSessions()` count answered zero while the session's harness object was still alive. These
// tests instrument the REAL persistence step and hold it open, which is the only way to observe
// the window rather than its stable-state aftermath.
//
// Success: while the write is pending the harness DELETE stays 409 and knowledge/harness state is
// untouched; only after the removal settles (rollback tail cleared, `disposeSession` ran) does the
// DELETE succeed and cleanup remove the owner's articles.
// Failure: a rejected write puts the session back, and every subsequent DELETE stays 409.
describe('T11 — a session removal in flight still blocks harness deletion', () => {
    type DeferredPersist = { started: Promise<void>; release: () => void; restore: () => void };

    // Replace the store's persistence step with "signal, wait for the test, then run the REAL
    // method". Nothing is skipped or faked: the same document write, the same rollback.
    const deferNextPersist = (store: SessionStore): DeferredPersist => {
        const target = store as unknown as { persistOrThrow: (...args: unknown[]) => Promise<void> };
        const original = target.persistOrThrow;
        let releaseGate!: () => void;
        let markStarted!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
        });
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });

        target.persistOrThrow = async (...args: unknown[]) => {
            markStarted();
            await gate;

            return original.apply(store, args);
        };

        return {
            started,
            release: releaseGate,
            restore: () => {
                delete (target as { persistOrThrow?: unknown }).persistOrThrow;
            }
        };
    };

    it('keeps the 409 while the removal write is pending, then allows deletion after teardown', async () => {
        const root = tempRoot('pending-success');
        const context = await createContext({ root });

        const alphaSession = await createSession(context, 'alpha');
        await createSession(context, 'beta');

        const alphaArticle = await createThrough(context.builds.alpha[0], 'Alpha pending', ['A.']);
        await createThrough(context.builds.beta[0], 'Beta stays', ['B.']);

        await context.knowledge!.flush();

        const before = JSON.parse(JSON.stringify(context.engine.snapshot()));
        const beforeTree = treeOf(knowledgeDirectoryOf(root));
        const disposeSpy = vi.spyOn(context.builds.alpha[0], 'dispose');

        const deferred = deferNextPersist(context.store);
        const removal = context.store.remove(alphaSession);

        await deferred.started;

        // The deleting session is gone from ORDINARY reads (the marker is deliberately not part
        // of `liveSessions`), yet the guard still counts it as a blocker.
        expect(context.store.liveSessions().map((record) => record.id)).not.toContain(alphaSession);
        expect(context.store.peekSession(alphaSession)).toBeUndefined();
        expect(context.store.harnessDeletionBlockers('alpha')).toBe(1);

        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')))).toEqual({
            status: 409,
            body: {
                error: {
                    message:
                        'Harness "alpha" still owns 1 session. Delete it first; a harness can only be deleted after all of its sessions are deleted.'
                }
            }
        });

        // The refusal changed nothing: harness present, whole store and knowledge tree identical.
        expect(context.registry.find('alpha')).toBeDefined();
        expect(context.engine.snapshot()).toEqual(before);
        expect(treeOf(knowledgeDirectoryOf(root))).toEqual(beforeTree);

        // Let the REAL persistence run. Once `remove` resolves, its rollback/teardown tail and
        // `disposeSession` have run, and only then is the marker cleared.
        deferred.release();
        await expect(removal).resolves.toBe(true);
        deferred.restore();

        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(context.store.harnessDeletionBlockers('alpha')).toBe(0);
        expect(context.store.peekSession(alphaSession)).toBeUndefined();

        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')))).toEqual({
            status: 200,
            body: { deleted: true, harness_name: 'alpha', tombstoned: false, restored_by_restart: false }
        });

        // Cleanup now runs: A's article/file are gone, B's are untouched.
        expect(labels(context.engine)).toEqual([{ title: 'Beta stays', harness: 'beta' }]);
        expect(fs.existsSync(knowledgeArticleFileOf(root, alphaArticle.article.id))).toBe(false);
    });

    it('rolls back a failed removal write and keeps every later DELETE guarded', async () => {
        const root = tempRoot('pending-failure');
        const context = await createContext({ root });

        const alphaSession = await createSession(context, 'alpha');
        const alphaArticle = await createThrough(context.builds.alpha[0], 'Alpha rollback', ['A.']);
        context.engine.execute({ verb: 'create', title: 'Unowned rollback', content: ['U.'] });

        await context.knowledge!.flush();

        const before = JSON.parse(JSON.stringify(context.engine.snapshot()));
        const beforeTree = treeOf(knowledgeDirectoryOf(root));

        const deferred = deferNextPersist(context.store);
        const removal = context.store.remove(alphaSession);

        await deferred.started;

        expect(context.store.harnessDeletionBlockers('alpha')).toBe(1);
        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha'))).status).toBe(
            409
        );
        expect(context.engine.snapshot()).toEqual(before);
        expect(treeOf(knowledgeDirectoryOf(root))).toEqual(beforeTree);

        // Fail the REAL document write after the gate opens. The store's own catch must put the
        // session back, and the removal marker must live through that rollback.
        const persistence = (context.store as unknown as { persistence: HarnessPersistence }).persistence;
        const saveSpy = vi.spyOn(persistence, 'save').mockImplementation(() => {
            throw new Error('simulated removal save failure');
        });

        deferred.release();

        await expect(removal).rejects.toThrow('Could not save the harness database: simulated removal save failure');

        saveSpy.mockRestore();
        deferred.restore();

        // ROLLBACK: the session is readable and blocking again; a later DELETE is not a loophole.
        expect(context.store.peekSession(alphaSession)).toBeDefined();
        expect(context.store.liveSessions().map((record) => record.id)).toContain(alphaSession);
        expect(context.store.harnessDeletionBlockers('alpha')).toBe(1);

        expect(jsonOf(await call(context.api, 'DELETE', HARNESS_ROUTES.harnessesByHarnessName('alpha')))).toEqual({
            status: 409,
            body: {
                error: {
                    message:
                        'Harness "alpha" still owns 1 session. Delete it first; a harness can only be deleted after all of its sessions are deleted.'
                }
            }
        });

        // Nothing was deleted: registry, whole knowledge store and knowledge tree identical.
        expect(context.registry.find('alpha')).toBeDefined();
        expect(context.engine.snapshot()).toEqual(before);
        expect(treeOf(knowledgeDirectoryOf(root))).toEqual(beforeTree);
        expect(context.engine.read({ id: alphaArticle.article.id }).harness).toBe('alpha');
    });
});
