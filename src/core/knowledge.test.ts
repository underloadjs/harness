// The knowledge engine — the guarantees the contract block in ../types states: strict
// arguments with coded refusals, optimistic `rev` CAS (the ONLY conflict this engine has),
// two-tier search with the title short-circuit reported through `matchedIn`, windowed reads
// with the byte budget stated rather than implied, references validated only for what a call
// wrote, and one store notification per COMMITTED operation.
//
// Written against the requirements (the doc comments in ./knowledge.ts and ../types), not
// against the implementation's output: every success assertion below is an exact value —
// ids, ISO stamps, ranks, kept-row counts — derived from the rules the contract fixes. The
// exceptions are the two byte-budget counts, which are DERIVED FROM THE BOUNDARY instead
// (see the budget sections: the pinned count is the largest row count that fits, proven by
// the +/-1 neighbours), because a byte count is not a number a reader can compute by hand.
//
// Determinism comes from the two engine seams (`now`, `ids`); `idAt`/`stampAt` below are the
// same sequences read forward, so a test names the value the engine is ABOUT to store instead
// of echoing whatever it returned.

import { describe, expect, it } from 'vitest';
import {
    createKnowledgeEngine,
    isKnowledgeRejection,
    KNOWLEDGE_ERROR_CODES,
    KNOWLEDGE_LIST_DEFAULT_LIMIT,
    KNOWLEDGE_LIST_MAX_LIMIT,
    KNOWLEDGE_MAX_ARTICLES,
    KNOWLEDGE_MAX_ITEMS,
    KNOWLEDGE_MAX_NOTE,
    KNOWLEDGE_MAX_PARAGRAPHS,
    KNOWLEDGE_MAX_REFS,
    KNOWLEDGE_MAX_SEARCH,
    KNOWLEDGE_MAX_TAG,
    KNOWLEDGE_MAX_TAGS,
    KNOWLEDGE_MAX_TEXT,
    KNOWLEDGE_MAX_TITLE,
    KNOWLEDGE_RESPONSE_BUDGET_BYTES,
    KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES,
    KNOWLEDGE_UUID_PATTERN,
    readKnowledgeStoreState
} from './knowledge';
import { MODEL_TOOL_RESULT_BUDGET_BYTES } from './result-budget';
import type {
    KnowledgeArticle,
    KnowledgeContentInput,
    KnowledgeCreateResult,
    KnowledgeEngine,
    KnowledgeModifyResult,
    KnowledgeOperation,
    KnowledgePageResult,
    KnowledgeReadResult,
    KnowledgeRemoveResult,
    KnowledgeSearchResult,
    KnowledgeStoreNotification,
    KnowledgeStoreState
} from '../types';
import { KNOWLEDGE_OPERATION_VERBS } from '../types';

// ---------------------------------------------------------------------------
// Deterministic seams
// ---------------------------------------------------------------------------

// The n-th uuid the `ids` source hands out (1-based). Hex, so a 3-digit count still fits the
// uuid shape the engine enforces.
const idAt = (index: number): string =>
    `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;

// A uuid that is well-formed and NEVER handed out by a rig below (rank 0xffff), which is how
// the tests name "an id this store does not hold".
const MISSING_ID = idAt(0xffff);

// The n-th clock reading rendered the way the engine stores it: the clock hands out epoch
// milliseconds 0, 1000, 2000... in call order, so `stampAt(0)` is the `createdAt` of whatever
// the first write commits.
const stampAt = (index: number): string => new Date(index * 1000).toISOString();

// An engine plus its seams read forward. `nextId`/`nextStamp` are the values the NEXT seam
// call produces, which is how a test asserts an exact id or stamp without asking the engine
// what it used.
const makeRig = (idFrom = 1) => {
    let idCalls = idFrom - 1;
    let stampCalls = 0;

    const engine = createKnowledgeEngine({
        ids: () => idAt(++idCalls),
        now: () => stampCalls++ * 1000
    });

    return {
        engine,
        nextId: () => idAt(idCalls + 1),
        nextStamp: () => stampAt(stampCalls),
        // How many times each seam has been pulled. A refused call may or may not have pulled
        // one (the bounds are checked before the clock is read), so the count is exposed for
        // the tests that care about it rather than assumed.
        idCalls: () => idCalls,
        stampCalls: () => stampCalls
    };
};

// ---------------------------------------------------------------------------
// Verb wrappers
// ---------------------------------------------------------------------------
//
// The wrappers take a LOOSE argument bag because half of these tests deliberately send
// malformed arguments (a typo'd key, a number where a uuid belongs). The engine's strict
// exact-key refusal is the type check for the rest: a typo in a success-path test surfaces as
// an `EKNOWLEDGE_INPUT` failure with the accepted keys in the message, never as a silent
// no-op. Every success assertion below is still an exact value.

const create = (
    engine: KnowledgeEngine,
    input: Record<string, unknown>
): KnowledgeCreateResult =>
    engine.execute({ verb: 'create', ...input } as KnowledgeOperation) as KnowledgeCreateResult;

const read = (engine: KnowledgeEngine, input: Record<string, unknown>): KnowledgeReadResult =>
    engine.execute({ verb: 'read', ...input } as KnowledgeOperation) as KnowledgeReadResult;

const list = (engine: KnowledgeEngine, input: Record<string, unknown> = {}): KnowledgePageResult =>
    engine.execute({ verb: 'list', ...input } as KnowledgeOperation) as KnowledgePageResult;

const search = (engine: KnowledgeEngine, input: Record<string, unknown>): KnowledgeSearchResult =>
    engine.execute({ verb: 'search', ...input } as KnowledgeOperation) as KnowledgeSearchResult;

const modify = (engine: KnowledgeEngine, input: Record<string, unknown>): KnowledgeModifyResult =>
    engine.execute({ verb: 'modify', ...input } as KnowledgeOperation) as KnowledgeModifyResult;

const remove = (engine: KnowledgeEngine, input: Record<string, unknown>): KnowledgeRemoveResult =>
    engine.execute({ verb: 'remove', ...input } as KnowledgeOperation) as KnowledgeRemoveResult;

// The one-line create every fixture uses: one paragraph, so the seam arithmetic stays legible
// (paragraph id = the next id, article id = the one after it).
const createArticle = (
    engine: KnowledgeEngine,
    title: string,
    text: string,
    tags?: string[]
): KnowledgeCreateResult =>
    create(engine, { title, content: [text], ...(tags === undefined ? {} : { tags }) });

// ---------------------------------------------------------------------------
// Rejection capture
// ---------------------------------------------------------------------------

// Sync counterpart of records.test.ts' `expectCode`: the engine is synchronous and throws.
// The code has to be on `error.code`, `error.name` AND the first token of the message,
// because `harness.ts` renders a thrown error as `Tool "..." failed: <message>` and only the
// message reaches the model.
const expectCode = (
    call: () => unknown,
    code: string
): { message: string; details?: unknown } => {
    try {
        call();
    } catch (error) {
        const failure = error as { name: string; code?: string; message: string; details?: unknown };

        expect(failure.code).toBe(code);
        expect(failure.name).toBe(code);
        expect(failure.message.startsWith(`${code}: `)).toBe(true);

        return {
            message: failure.message.slice(code.length + 2),
            ...(failure.details === undefined ? {} : { details: failure.details })
        };
    }

    throw new Error(`expected a ${code} refusal, and the call succeeded`);
};

// The shared snapshot readers (./snapshot-validation.ts) throw a PLAIN HarnessError: no code,
// no prefix. That is the contract for a malformed persisted file (the file layer reports the
// label verbatim), so those refusals are asserted on the exact message instead.
const expectMessage = (call: () => unknown, message: string): void => {
    try {
        call();
    } catch (error) {
        expect((error as Error).message).toBe(message);
        expect((error as { code?: string }).code).toBeUndefined();

        return;
    }

    throw new Error(`expected the refusal "${message}", and the call succeeded`);
};

// The store feed recorder. Returns the live array so a test can assert the exact notification
// sequence a run of calls produced.
const recordFeed = (engine: KnowledgeEngine): KnowledgeStoreNotification[] => {
    const feed: KnowledgeStoreNotification[] = [];

    engine.onStoreChange((notification) => feed.push(notification));

    return feed;
};

// A detached clone for "the store did not move" assertions: a snapshot is a plain JSON value,
// so a deep clone lets a test compare a whole store state after further calls.
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// A fresh engine holding one article with `count` paragraphs, so the window/outline tests
// start from a known shape. Returns the engine plus the create result (ids, stamps).
const seedArticle = (engine: KnowledgeEngine, title: string, count: number): KnowledgeCreateResult => {
    const content: KnowledgeContentInput[] = [];

    for (let index = 0; index < count; index += 1) {
        content.push(`Paragraph ${index + 1}.`);
    }

    return create(engine, { title, content });
};

// ---------------------------------------------------------------------------
// The published surface
// ---------------------------------------------------------------------------

describe('knowledge engine — the published bounds and codes', () => {
    it('publishes the closed code set, in the order the union declares it', () => {
        expect([...KNOWLEDGE_ERROR_CODES]).toStrictEqual([
            'EKNOWLEDGE_INPUT',
            'EKNOWLEDGE_ID',
            'EKNOWLEDGE_REV',
            'EKNOWLEDGE_LIMIT',
            'EKNOWLEDGE_REF',
            'EKNOWLEDGE_NOT_FOUND'
        ]);
    });

    it('publishes every bound at the value the contract fixes', () => {
        expect({
            KNOWLEDGE_MAX_ARTICLES,
            KNOWLEDGE_MAX_PARAGRAPHS,
            KNOWLEDGE_MAX_TEXT,
            KNOWLEDGE_MAX_NOTE,
            KNOWLEDGE_MAX_TITLE,
            KNOWLEDGE_MAX_TAGS,
            KNOWLEDGE_MAX_TAG,
            KNOWLEDGE_MAX_REFS,
            KNOWLEDGE_MAX_ITEMS,
            KNOWLEDGE_MAX_SEARCH,
            KNOWLEDGE_LIST_DEFAULT_LIMIT,
            KNOWLEDGE_LIST_MAX_LIMIT,
            KNOWLEDGE_RESPONSE_BUDGET_BYTES,
            KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES
        }).toStrictEqual({
            KNOWLEDGE_MAX_ARTICLES: 100,
            KNOWLEDGE_MAX_PARAGRAPHS: 64,
            KNOWLEDGE_MAX_TEXT: 4_000,
            KNOWLEDGE_MAX_NOTE: 500,
            KNOWLEDGE_MAX_TITLE: 200,
            KNOWLEDGE_MAX_TAGS: 16,
            KNOWLEDGE_MAX_TAG: 64,
            KNOWLEDGE_MAX_REFS: 16,
            KNOWLEDGE_MAX_ITEMS: 64,
            KNOWLEDGE_MAX_SEARCH: 50,
            KNOWLEDGE_LIST_DEFAULT_LIMIT: 20,
            KNOWLEDGE_LIST_MAX_LIMIT: 100,
            // 24 KiB, deliberately under the harness' own outer cap: an engine-sized response
            // must reach the model without the outer truncator rewriting it.
            KNOWLEDGE_RESPONSE_BUDGET_BYTES: 24_576,
            KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES: 8_192
        });
        expect(KNOWLEDGE_RESPONSE_BUDGET_BYTES < MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(true);
        expect(MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(32_768);
    });

    it('accepts exactly uuid-shaped ids, which is the same rule the file layer enforces', () => {
        expect(KNOWLEDGE_UUID_PATTERN.test(idAt(1))).toBe(true);
        expect(KNOWLEDGE_UUID_PATTERN.test('00000000-0000-0000-0000-00000000000A')).toBe(true);
        expect(KNOWLEDGE_UUID_PATTERN.test('2')).toBe(false);
        expect(KNOWLEDGE_UUID_PATTERN.test('00000000-0000-0000-0000-00000000000')).toBe(false);
    });

    it('classifies its own rejections and nothing else', () => {
        const engine = createKnowledgeEngine();

        let coded: unknown;
        let plain: unknown;

        try {
            read(engine, { id: 'nope' });
        } catch (error) {
            coded = error;
        }

        try {
            readKnowledgeStoreState(['not', 'a', 'state']);
        } catch (error) {
            plain = error;
        }

        expect(isKnowledgeRejection(coded)).toBe(true);
        // A malformed FILE is a different failure class (the shared snapshot wording, no
        // engine code), and a wrapper must not switch on a code it does not have.
        expect(isKnowledgeRejection(plain)).toBe(false);
        expect(isKnowledgeRejection(new Error('boom'))).toBe(false);
        expect(isKnowledgeRejection(undefined)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Routing and argument discipline
// ---------------------------------------------------------------------------

describe('knowledge engine — routing and argument discipline', () => {
    it('refuses a non-object operation, naming what arrived', () => {
        const engine = createKnowledgeEngine();

        expect(expectCode(() => engine.execute(null as never), 'EKNOWLEDGE_INPUT').message).toBe(
            'knowledge takes a JSON object; received null.'
        );
        expect(expectCode(() => engine.execute([1, 2] as never), 'EKNOWLEDGE_INPUT').message).toBe(
            'knowledge takes a JSON object; received an array.'
        );
        expect(expectCode(() => engine.execute('read' as never), 'EKNOWLEDGE_INPUT').message).toBe(
            'knowledge takes a JSON object; received string.'
        );
    });

    it('refuses an unknown verb by name, quoting the accepted set', () => {
        const engine = createKnowledgeEngine();
        const accepted = KNOWLEDGE_OPERATION_VERBS.map((verb) => `"${verb}"`).join(', ');

        expect(expectCode(() => engine.execute({ verb: 'delete' } as never), 'EKNOWLEDGE_INPUT').message).toBe(
            `knowledge operations have a "verb" of ${accepted}; received delete.`
        );
        // The prototype-key case the naive `OPERATION_KEYS[verb]` check answers truthy for.
        expect(
            expectCode(() => engine.execute({ verb: 'constructor' } as never), 'EKNOWLEDGE_INPUT').message
        ).toBe(`knowledge operations have a "verb" of ${accepted}; received constructor.`);
        expect(expectCode(() => engine.execute({} as never), 'EKNOWLEDGE_INPUT').message).toBe(
            `knowledge operations have a "verb" of ${accepted}; received undefined.`
        );
    });

    it('refuses an unknown field rather than dropping it, per verb', () => {
        const rig = makeRig();
        createArticle(rig.engine, 'Document', 'Body.');

        expect(expectCode(() => list(rig.engine, { bogus: 1 }), 'EKNOWLEDGE_INPUT').message).toBe(
            'knowledge "list" has no field "bogus"; it takes "verb", "search", "tag", "limit", "offset" — fix the name or drop it.'
        );
        expect(
            expectCode(
                () => create(rig.engine, { title: 'x', content: ['y'], tile: 'z' }),
                'EKNOWLEDGE_INPUT'
            ).message
        ).toBe(
            'knowledge "create" has no field "tile"; it takes "verb", "title", "tags", "content" — fix the name or drop it.'
        );
        expect(
            expectCode(
                () => modify(rig.engine, { id: idAt(2), setParagraphs: [{ id: idAt(1), text: 'x', order: 2 }] }),
                'EKNOWLEDGE_INPUT'
            ).message
        ).toBe(
            'knowledge "modify" "setParagraphs" item 0 has no field "order"; it takes "id", "text", "tags", "refs" — fix the name or drop it.'
        );
    });

    it('accepts the tool context and never reads it, so an article carries no attribution', () => {
        const engine = createKnowledgeEngine();
        const withContext = engine.execute(
            { verb: 'create', title: 'Attribution', content: ['No author is stored.'] },
            { parameters: {}, agent: { name: 'coder' }, threadId: 'thread-1' } as never
        ) as KnowledgeCreateResult;
        const plain = createKnowledgeEngine();
        const same = createArticle(plain, 'Attribution', 'No author is stored.');

        // Same seams (both engines default), so the two results are comparable field for
        // field EXCEPT the ids/timestamps, which come from the default seams. What the context
        // must not do is add a key.
        expect(Object.keys(withContext)).toStrictEqual(Object.keys(same));
        expect(Object.keys(withContext.article)).toStrictEqual(Object.keys(same.article));
        expect(withContext.article.title).toBe('Attribution');
    });

    it('exposes search() and read() without the verb key, answering exactly as the routed door does', () => {
        const rig = makeRig();
        const created = createArticle(rig.engine, 'Lane retries', 'Each lane keeps its own retry budget.');

        expect(rig.engine.search({ query: 'retry' })).toStrictEqual(
            search(rig.engine, { query: 'retry' })
        );
        expect(rig.engine.read({ id: created.article.id })).toStrictEqual(
            read(rig.engine, { id: created.article.id })
        );
        // 'Lane retries' does not contain 'retry', so the title lane is empty and the fallback
        // answers — the direct call reports the same lane as the routed one.
        expect(rig.engine.search({ query: 'retry' }).matchedIn).toBe('text');
    });

    it('answers articles() with the page order and never the bodies', () => {
        const rig = makeRig();
        const first = createArticle(rig.engine, 'First', 'One.');
        const second = createArticle(rig.engine, 'Second', 'Two.');

        expect(rig.engine.articles()).toStrictEqual([
            {
                id: second.article.id,
                title: 'Second',
                tags: [],
                createdAt: second.article.createdAt,
                updatedAt: second.article.updatedAt,
                rev: 1,
                paragraphCount: 1
            },
            {
                id: first.article.id,
                title: 'First',
                tags: [],
                createdAt: first.article.createdAt,
                updatedAt: first.article.updatedAt,
                rev: 1,
                paragraphCount: 1
            }
        ]);
        expect('content' in rig.engine.articles()[0]).toBe(false);
    });

    it('hands out detached copies, so a caller cannot rewrite the store through a result', () => {
        const rig = makeRig();
        const created = seedArticle(rig.engine, 'Detached', 2);
        const id = created.article.id;

        created.article.content[0].text = 'Mutated by the caller.';
        (created.article as { tags?: string[] }).tags = ['mutated'];

        const fresh = read(rig.engine, { id });

        expect(fresh.paragraphs?.[0].text).toBe('Paragraph 1.');
        expect(fresh.tags).toStrictEqual([]);

        fresh.paragraphs?.pop();

        expect(read(rig.engine, { id }).paragraphs?.length).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('knowledge engine — create', () => {
    it('commits the article exactly as the contract shapes it: trimmed, deduped, rev 1, one stamp', () => {
        const rig = makeRig();
        const stamp = rig.nextStamp();
        const result = create(rig.engine, {
            title: '  Lane retries  ',
            tags: ['Runbook', 'runbook'],
            content: ['  First paragraph.  ', { text: 'Second.', tags: ['Draft', 'draft', 'beta'] }]
        });

        // `create` claims the paragraph ids first and mints the ARTICLE id last, which is why
        // the article is idAt(3) behind paragraphs idAt(1)/idAt(2). One clock pull per call,
        // shared by the article and every paragraph it appends.
        expect(result).toStrictEqual({
            article: {
                id: idAt(3),
                title: 'Lane retries',
                createdAt: stamp,
                updatedAt: stamp,
                tags: ['Runbook'],
                content: [
                    {
                        id: idAt(1),
                        text: 'First paragraph.',
                        rev: 1,
                        createdAt: stamp,
                        updatedAt: stamp
                    },
                    {
                        id: idAt(2),
                        text: 'Second.',
                        rev: 1,
                        createdAt: stamp,
                        updatedAt: stamp,
                        tags: ['Draft', 'beta']
                    }
                ],
                rev: 1
            },
            createdIds: [idAt(1), idAt(2)]
        });
        // `toStrictEqual` above is the point: an optional key that arrived empty is ABSENT,
        // never `undefined`-valued, or the byte budget would measure a key that carries nothing.
        expect('tags' in result.article.content[0]).toBe(false);
        expect('refs' in result.article.content[0]).toBe(false);
    });

    it('accepts an article with no content and reports no created ids', () => {
        const rig = makeRig();

        expect(create(rig.engine, { title: 'Empty' })).toStrictEqual({
            article: {
                id: idAt(1),
                title: 'Empty',
                createdAt: stampAt(0),
                updatedAt: stampAt(0),
                tags: [],
                content: [],
                rev: 1
            },
            createdIds: []
        });
    });

    it('honours a pinned paragraph id and refuses a pin the store already holds', () => {
        const rig = makeRig();
        const pinned = idAt(900);
        const first = create(rig.engine, { title: 'Pinned', content: [{ id: pinned, text: 'Handle.' }] });

        expect(first.createdIds).toStrictEqual([pinned]);
        expect(first.article.content[0].id).toBe(pinned);

        expect(
            expectCode(
                () => create(rig.engine, { title: 'Clash', content: [{ id: pinned, text: 'Twice.' }] }),
                'EKNOWLEDGE_ID'
            ).message
        ).toBe(
            `knowledge "create" "content" item 0 pinned paragraph id "${pinned}", which the store already uses. Drop "id" and let the engine assign one, or choose a uuid of your own that nothing uses.`
        );

        // Two pins of one id inside one call: the store cannot catch it (neither row exists
        // yet), so the call catches it — and says so, rather than naming a store row. A FRESH
        // uuid is the only way to reach this message: an id the store holds is refused earlier,
        // as a store collision, which is the truer sentence.
        expect(
            expectCode(
                () => create(rig.engine, { title: 'Twice', content: [{ id: idAt(901), text: 'A' }, { id: idAt(901), text: 'B' }] }),
                'EKNOWLEDGE_ID'
            ).message
        ).toBe(
            `knowledge "create" "content" item 1 pinned paragraph id "${idAt(901)}" more than once in this call; one id per paragraph. Drop "id" and let the engine assign one, or choose a uuid of your own that nothing uses.`
        );
    });

    it('canonicalizes a pinned id to lowercase, so an upper-cased uuid round-trips', () => {
        const rig = makeRig();
        const upper = '00000000-0000-0000-0000-0000000000AB';
        const created = create(rig.engine, { title: 'Case', content: [{ id: upper, text: 'Upper.' }] });

        expect(created.article.content[0].id).toBe(upper.toLowerCase());
        expect(read(rig.engine, { id: created.article.id, paragraphs: [upper] }).paragraphs?.[0].id).toBe(
            upper.toLowerCase()
        );
    });

    it('lets a create reference a paragraph of the article it is creating (the recipe shape)', () => {
        const rig = makeRig();
        // The article id is minted LAST, so with a deterministic source the caller can name it:
        // paragraphs 1 and 2, article 3. A ref to paragraph 1 of article 3 resolves against the
        // draft, which is what makes a step quote the article it lives in.
        const futureArticle = idAt(3);
        const created = create(rig.engine, {
            title: 'Recipe',
            content: [
                { text: 'Step one.' },
                {
                    text: 'Step two.',
                    refs: [
                        { articleId: futureArticle, paragraphId: idAt(1), note: 'depends on step one' },
                        { articleId: futureArticle, note: '   ' }
                    ]
                }
            ]
        });

        expect(created.article.content[1].refs).toStrictEqual([
            { articleId: futureArticle, paragraphId: idAt(1), note: 'depends on step one' },
            // An all-space note is an ABSENT note.
            { articleId: futureArticle }
        ]);
    });

    it('refuses a reference to an article or paragraph this store does not hold', () => {
        const rig = makeRig();

        expect(
            expectCode(
                () => create(rig.engine, { title: 'Dangling', content: [{ text: 'Points nowhere.', refs: [{ articleId: MISSING_ID }] }] }),
                'EKNOWLEDGE_REF'
            ).details
        ).toStrictEqual({ paragraphId: idAt(1), articleId: MISSING_ID });

        const other = createArticle(rig.engine, 'Target', 'Real paragraph.');

        // The refused create above pulled TWO ids from the source before it refused: validation
        // runs after the paragraph id and the article id are both claimed. So this call's
        // paragraph is idAt(5) and the target article is idAt(4) — the seam arithmetic is part of
        // what "a refused call left nothing behind" means, and the rows are what it asserts.
        expect(
            expectCode(
                () =>
                    create(rig.engine, {
                        title: 'Wrong paragraph',
                        content: [{ text: 'Points at a row that does not exist.', refs: [{ articleId: other.article.id, paragraphId: MISSING_ID }] }]
                    }),
                'EKNOWLEDGE_REF'
            ).message
        ).toBe(
            `knowledge "create" set a reference on paragraph "${idAt(5)}" to paragraph "${MISSING_ID}" of article "${other.article.id}", which that article does not hold. Reference a paragraph that exists (read the article for its ids), or drop "paragraphId" to link the whole article.`
        );

        // The refused create left nothing behind.
        expect(list(rig.engine).counts.total).toBe(1);
    });

    it('refuses each bound with the code, the number it hit and the fix', () => {
        const rig = makeRig();

        expect(
            expectCode(() => create(rig.engine, { title: 'x'.repeat(201), content: ['Body.'] }), 'EKNOWLEDGE_LIMIT')
                .message
        ).toBe(
            'knowledge "create" "title" is 201 characters, over the KNOWLEDGE_MAX_TITLE limit of 200; shorten it and put the detail in a paragraph.'
        );
        expect(
            expectCode(() => create(rig.engine, { title: 'Long', content: ['x'.repeat(4_001)] }), 'EKNOWLEDGE_LIMIT')
                .message
        ).toBe(
            'knowledge "create" "content" item 0 "text" is 4001 characters, over the KNOWLEDGE_MAX_TEXT limit of 4000; split it into two paragraphs.'
        );
        expect(
            expectCode(
                () => create(rig.engine, { title: 'Tags', content: ['Body.'], tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`) }),
                'EKNOWLEDGE_LIMIT'
            ).message
        ).toBe(
            'knowledge "create" "tags" carries 17 tags, over the KNOWLEDGE_MAX_TAGS limit of 16; keep the tags a search would actually filter on.'
        );
        expect(
            expectCode(() => create(rig.engine, { title: 'Tag', content: ['Body.'], tags: ['x'.repeat(65)] }), 'EKNOWLEDGE_LIMIT')
                .message
        ).toBe(
            `knowledge "create" "tags" holds a tag of 65 characters ("${'x'.repeat(24)}…"), over the KNOWLEDGE_MAX_TAG limit of 64; shorten it.`
        );
        expect(
            expectCode(
                () =>
                    create(rig.engine, {
                        title: 'Refs',
                        content: [
                            {
                                text: 'Body.',
                                refs: Array.from({ length: 17 }, () => ({ articleId: MISSING_ID }))
                            }
                        ]
                    }),
                'EKNOWLEDGE_LIMIT'
            ).message
        ).toBe(
            'knowledge "create" "content" item 0 "refs" carries 17 references, over the KNOWLEDGE_MAX_REFS limit of 16 per paragraph; keep the links a reader would follow.'
        );
        expect(
            expectCode(
                () =>
                    create(rig.engine, {
                        title: 'Note',
                        content: [{ text: 'Body.', refs: [{ articleId: MISSING_ID, note: 'x'.repeat(501) }] }]
                    }),
                'EKNOWLEDGE_LIMIT'
            ).message
        ).toBe(
            'knowledge "create" "content" item 0 "refs" item 0 "note" is 501 characters, over the KNOWLEDGE_MAX_NOTE limit of 500; say why in one line.'
        );
        expect(
            expectCode(
                () => create(rig.engine, { title: 'Items', content: Array.from({ length: 65 }, (_, index) => `P${index}`) }),
                'EKNOWLEDGE_LIMIT'
            ).message
        ).toBe(
            'knowledge "create" "content" carries 65 paragraphs, over the KNOWLEDGE_MAX_ITEMS limit of 64 per call; send the rest in a second call.'
        );
        expect(
            expectCode(() => create(rig.engine, { title: 'Blank', content: ['   '] }), 'EKNOWLEDGE_INPUT').message
        ).toBe(
            'knowledge "create" "content" item 0 "text" holds no non-space character; remove the paragraph instead of emptying it.'
        );
        expect(
            expectCode(() => create(rig.engine, { title: '   ', content: ['Body.'] }), 'EKNOWLEDGE_INPUT').message
        ).toBe(
            'knowledge "create" requires a non-empty "title" string; the title is how a later session finds this article again.'
        );
        expect(
            expectCode(() => create(rig.engine, { title: 'No text', content: [{ tags: ['x'] }] }), 'EKNOWLEDGE_INPUT')
                .message
        ).toBe('knowledge "create" "content" item 0 requires "text" (or pass the paragraph as a plain string).');
        expect(
            expectCode(() => create(rig.engine, { title: 'Bad tag', content: ['Body.'], tags: ['  '] }), 'EKNOWLEDGE_INPUT')
                .message
        ).toBe('knowledge "create" "tags" holds "  ", which is not a non-empty tag string.');
        expect(
            expectCode(() => create(rig.engine, { title: 'Bad ref', content: [{ text: 'Body.', refs: [{ articleId: '2' }] }] }), 'EKNOWLEDGE_ID')
                .message
        ).toBe(
            'knowledge "create" "content" item 0 "refs" item 0 "articleId" is "2", which is not a uuid; a reference names an article by its uuid.'
        );
    });

    it('fills to KNOWLEDGE_MAX_ARTICLES and refuses the 101st without burning a slot', () => {
        const rig = makeRig();

        for (let index = 0; index < KNOWLEDGE_MAX_ARTICLES; index += 1) {
            createArticle(rig.engine, `Article ${index}`, 'Body.');
        }

        const before = rig.engine.snapshot();
        const failure = expectCode(
            () => createArticle(rig.engine, 'Article 100', 'Body.'),
            'EKNOWLEDGE_LIMIT'
        );

        expect(failure.details).toStrictEqual({ articles: 100, max: 100 });
        expect(failure.message).toBe(
            'knowledge "create" refused: the store holds 100 articles, the KNOWLEDGE_MAX_ARTICLES limit of 100. Remove an article ("verb": "remove") or add these paragraphs to an existing one ("verb": "modify").'
        );
        // A refusal that mints nothing: no article, no watermark move, no clock pull.
        expect(rig.engine.snapshot()).toStrictEqual(before);
    });

    it('refuses a broken clock or id source instead of storing a forged value', () => {
        const brokenClock = createKnowledgeEngine({ ids: () => idAt(1), now: () => Number.NaN });

        expect(expectCode(() => create(brokenClock, { title: 'Clock', content: ['x'] }), 'EKNOWLEDGE_INPUT')
            .message).toBe(
            'the knowledge clock returned NaN, which is not an epoch millisecond; pass a "now" that returns Date.now()-style milliseconds.'
        );

        const brokenIds = createKnowledgeEngine({ ids: () => 'not-a-uuid', now: () => 0 });

        expect(
            expectCode(() => create(brokenIds, { title: 'Ids', content: ['x'] }), 'EKNOWLEDGE_ID').message
        ).toBe(
            'knowledge "create" the knowledge id source returned "not-a-uuid", which is not a uuid; pass an "ids" that returns uuid strings, or omit it and use crypto.randomUUID().'
        );

        // A source that repeats an ARTICLE id is a different refusal: the store already holds it.
        const stuckIds = createKnowledgeEngine({ ids: () => idAt(1), now: () => 0 });

        create(stuckIds, { title: 'First' });

        expect(
            expectCode(() => create(stuckIds, { title: 'Second' }), 'EKNOWLEDGE_ID').message
        ).toBe(
            `knowledge "create" the knowledge id source returned "${idAt(1)}", which the store already uses as an article id; pass an "ids" that returns fresh uuids.`
        );
    });
});
// ---------------------------------------------------------------------------
// read — the drill-in projections
// ---------------------------------------------------------------------------

// The fixture every read test shares, with the seam arithmetic written out:
//   target  → paragraph idAt(1), article idAt(2), stamp stampAt(0)
//   document→ paragraphs idAt(3), idAt(4), idAt(5); article idAt(6); stamp stampAt(1)
// Paragraph text lengths are 16 / 24 / 15, which is what the `outline` `chars` values assert.
const seedReadFixture = () => {
    const rig = makeRig();
    const target = createArticle(rig.engine, 'Target', 'The linked paragraph.');
    const document = create(rig.engine, {
        title: 'Retry playbook',
        tags: ['runbook'],
        content: [
            'First paragraph.',
            { text: 'Tagged middle paragraph.', tags: ['detail'] },
            { text: 'Last paragraph.', refs: [{ articleId: target.article.id, note: 'the linked article' }] }
        ]
    });

    return { engine: rig.engine, target, document };
};

const DOCUMENT_ID = idAt(6);

describe('knowledge engine — read projections', () => {
    it('answers a whole read with metadata plus every paragraph, and no window keys at all', () => {
        const { engine } = seedReadFixture();
        const stamp = stampAt(1);

        // `toStrictEqual` is the whole point of this assertion: `from`, `limit`,
        // `totalParagraphs`, `truncated` and `budgetTruncated` are ABSENT when the response is
        // not a subset, so a caller can branch on the key rather than on a number.
        expect(read(engine, { id: DOCUMENT_ID })).toStrictEqual({
            id: DOCUMENT_ID,
            title: 'Retry playbook',
            tags: ['runbook'],
            createdAt: stamp,
            updatedAt: stamp,
            rev: 1,
            paragraphCount: 3,
            paragraphs: [
                { id: idAt(3), text: 'First paragraph.', rev: 1, createdAt: stamp, updatedAt: stamp },
                {
                    id: idAt(4),
                    text: 'Tagged middle paragraph.',
                    rev: 1,
                    createdAt: stamp,
                    updatedAt: stamp,
                    tags: ['detail']
                },
                {
                    id: idAt(5),
                    text: 'Last paragraph.',
                    rev: 1,
                    createdAt: stamp,
                    updatedAt: stamp,
                    refs: [{ articleId: idAt(2), note: 'the linked article' }]
                }
            ]
        });
    });

    it('answers outline: true with everything but the text, and never with both keys', () => {
        const { engine } = seedReadFixture();
        const stamp = stampAt(1);

        expect(read(engine, { id: DOCUMENT_ID, outline: true })).toStrictEqual({
            id: DOCUMENT_ID,
            title: 'Retry playbook',
            tags: ['runbook'],
            createdAt: stamp,
            updatedAt: stamp,
            rev: 1,
            paragraphCount: 3,
            outline: [
                { id: idAt(3), rev: 1, updatedAt: stamp, chars: 16 },
                { id: idAt(4), rev: 1, updatedAt: stamp, chars: 24, tags: ['detail'] },
                {
                    id: idAt(5),
                    rev: 1,
                    updatedAt: stamp,
                    chars: 15,
                    refs: [{ articleId: idAt(2), note: 'the linked article' }]
                }
            ]
        });
    });

    it('states the window on every subset read, including a window that happens to cover all of it', () => {
        const { engine } = seedReadFixture();
        const stamp = stampAt(1);
        const second = {
            id: idAt(4),
            text: 'Tagged middle paragraph.',
            rev: 1,
            createdAt: stamp,
            updatedAt: stamp,
            tags: ['detail']
        };

        expect(read(engine, { id: DOCUMENT_ID, from: 1, limit: 1 }).paragraphs).toStrictEqual([second]);
        expect(read(engine, { id: DOCUMENT_ID, from: 1, limit: 1 })).toMatchObject({
            from: 1,
            limit: 1,
            totalParagraphs: 3,
            truncated: true
        });

        // `from` alone means "everything from here".
        expect(
            read(engine, { id: DOCUMENT_ID, from: 1 }).paragraphs?.map((paragraph) => paragraph.id)
        ).toStrictEqual([idAt(4), idAt(5)]);
        expect(read(engine, { id: DOCUMENT_ID, from: 1 })).toMatchObject({
            from: 1,
            limit: 2,
            totalParagraphs: 3,
            truncated: true
        });

        // A window that covers the article still reports its keys, with `truncated: false`: the
        // honest answer to "did I get everything" for THAT request.
        const whole = read(engine, { id: DOCUMENT_ID, from: 0, limit: 3 });

        expect(whole.truncated).toBe(false);
        expect(whole.from).toBe(0);
        expect(whole.limit).toBe(3);
        expect(whole.totalParagraphs).toBe(3);
        expect(whole.paragraphs?.length).toBe(3);

        // A window past the end is empty but still a window, and `truncated` answers "is there
        // more above you", which for offset 9 there is.
        expect(read(engine, { id: DOCUMENT_ID, from: 9 })).toStrictEqual({
            id: DOCUMENT_ID,
            title: 'Retry playbook',
            tags: ['runbook'],
            createdAt: stamp,
            updatedAt: stamp,
            rev: 1,
            paragraphCount: 3,
            paragraphs: [],
            from: 9,
            limit: 0,
            totalParagraphs: 3,
            truncated: true
        });
    });

    it('answers a paragraph selection in the article order, not the request order', () => {
        const { engine } = seedReadFixture();

        const selected = read(engine, { id: DOCUMENT_ID, paragraphs: [idAt(5), idAt(3)] });

        expect(selected.paragraphs?.map((paragraph) => paragraph.id)).toStrictEqual([idAt(3), idAt(5)]);
        // `from` for a selection is the stored index of the first row it returned, so a paging
        // loop resumes at the next paragraph of the article instead of inside the selection.
        expect({ from: selected.from, limit: selected.limit, totalParagraphs: selected.totalParagraphs, truncated: selected.truncated }).toStrictEqual({
            from: 0,
            limit: 2,
            totalParagraphs: 3,
            truncated: true
        });

        // A selection in the middle of the article reports the lowest selected index.
        expect(
            read(engine, { id: DOCUMENT_ID, paragraphs: [idAt(4)] }).from
        ).toBe(1);
    });

    it('refuses a selection that also names a window, and a selection the article does not hold', () => {
        const { engine } = seedReadFixture();

        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, paragraphs: [idAt(3)], from: 1 }), 'EKNOWLEDGE_INPUT')
                .message
        ).toBe(
            'knowledge "read" takes "paragraphs" or "from"/"limit", not both: a paragraph selection is already a window. Drop one of them.'
        );
        expect(
            expectCode(
                () => read(engine, { id: DOCUMENT_ID, paragraphs: [idAt(3)], limit: 1 }),
                'EKNOWLEDGE_INPUT'
            ).message
        ).toBe(
            'knowledge "read" takes "paragraphs" or "from"/"limit", not both: a paragraph selection is already a window. Drop one of them.'
        );

        // Another article's paragraph: the id exists, but not in THIS article.
        const failure = expectCode(
            () => read(engine, { id: DOCUMENT_ID, paragraphs: [idAt(1)] }),
            'EKNOWLEDGE_NOT_FOUND'
        );

        expect(failure.message).toBe(
            `knowledge "read" asked for paragraph "${idAt(1)}", which article "${DOCUMENT_ID}" ("Retry playbook") does not hold. Read the article with "outline": true for its paragraph ids.`
        );
        expect(failure.details).toStrictEqual({ id: DOCUMENT_ID, paragraphId: idAt(1) });

        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, paragraphs: [idAt(3), idAt(3)] }), 'EKNOWLEDGE_ID')
                .message
        ).toBe(`knowledge "read" "paragraphs" names "${idAt(3)}" twice; name each id once per call.`);

        // An id ARRAY names the element that failed, not the array.
        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, paragraphs: ['2'] }), 'EKNOWLEDGE_ID').message
        ).toBe(
            'knowledge "read" "paragraphs" item 0 is "2", which is not a uuid; ids are uuids the engine assigned.'
        );
    });

    it('refuses a read of an article this store does not hold', () => {
        const { engine } = seedReadFixture();
        const failure = expectCode(() => read(engine, { id: MISSING_ID }), 'EKNOWLEDGE_NOT_FOUND');

        expect(failure.message).toBe(
            `knowledge "read" found no article "${MISSING_ID}". Run a "search" or "list" to find the article you mean; ids are uuids the engine assigned and cannot be guessed.`
        );
        expect(failure.details).toStrictEqual({ id: MISSING_ID });

        expect(
            expectCode(() => read(engine, { id: '2' }), 'EKNOWLEDGE_ID').message
        ).toBe(
            'knowledge "read" "id" is "2", which is not a uuid; run a "search" or "list" — ids are uuids the engine assigned.'
        );
        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, bogus: 1 }), 'EKNOWLEDGE_INPUT').message
        ).toBe(
            'knowledge "read" has no field "bogus"; it takes "verb", "id", "paragraphs", "from", "limit", "outline" — fix the name or drop it.'
        );
        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, outline: 'yes' }), 'EKNOWLEDGE_INPUT').message
        ).toBe('knowledge "read" "outline" must be a boolean when provided.');
    });

    it('refuses a window bound that is not a paragraph index', () => {
        const { engine } = seedReadFixture();

        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, from: -1 }), 'EKNOWLEDGE_LIMIT').message
        ).toBe(
            'knowledge "read" "from" is -1, which is not a non-negative paragraph index; the outline says how many paragraphs the article holds.'
        );
        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, from: 1.5 }), 'EKNOWLEDGE_LIMIT').message
        ).toBe(
            'knowledge "read" "from" is 1.5, which is not a non-negative paragraph index; the outline says how many paragraphs the article holds.'
        );
        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, limit: 0 }), 'EKNOWLEDGE_LIMIT').message
        ).toBe(
            'knowledge "read" "limit" is 0, outside the 1-64 range one article\'s paragraphs allow (KNOWLEDGE_MAX_PARAGRAPHS); pass a limit between 1 and 64.'
        );
        expect(
            expectCode(() => read(engine, { id: DOCUMENT_ID, limit: 65 }), 'EKNOWLEDGE_LIMIT').message
        ).toBe(
            'knowledge "read" "limit" is 65, outside the 1-64 range one article\'s paragraphs allow (KNOWLEDGE_MAX_PARAGRAPHS); pass a limit between 1 and 64.'
        );
    });

    it('reports a reference that no longer resolves without rewriting the stored link', () => {
        const { engine, target } = seedReadFixture();

        expect(remove(engine, { id: target.article.id }).danglingRefs).toStrictEqual([idAt(2)]);

        const after = read(engine, { id: DOCUMENT_ID });

        // The projection says which target is missing (a whole-article link reports the ARTICLE
        // id), while the paragraph's own `refs` array is exactly what the write stored.
        expect(after.danglingRefs).toStrictEqual([idAt(2)]);
        expect(after.paragraphs?.[2].refs).toStrictEqual([
            { articleId: idAt(2), note: 'the linked article' }
        ]);

        // The same holds in the cheap projection.
        expect(read(engine, { id: DOCUMENT_ID, outline: true }).danglingRefs).toStrictEqual([idAt(2)]);
    });

    it('dedupes and sorts the missing targets a response names, by the id a reader must resolve', () => {
        const rig = makeRig();
        // A whole-article link and a paragraph-level link to ONE article, written in the order
        // that makes the ascending sort non-trivial: the paragraph id (idAt(1)) is named last.
        const quoted = createArticle(rig.engine, 'Worth quoting', 'A paragraph worth quoting.');
        const holder = create(rig.engine, {
            title: 'Holder',
            content: [
                {
                    text: 'Quotes the article, then the paragraph.',
                    refs: [{ articleId: quoted.article.id }, { articleId: quoted.article.id, paragraphId: quoted.article.content[0].id }]
                },
                { text: 'Quotes the article again.', refs: [{ articleId: quoted.article.id }] },
                'Unlinked.'
            ]
        });

        expect(read(rig.engine, { id: holder.article.id }).danglingRefs).toBeUndefined();

        remove(rig.engine, { id: quoted.article.id });

        const missing = read(rig.engine, { id: holder.article.id }).danglingRefs;

        // Three broken links, TWO ids: the paragraph-level link reports the PARAGRAPH id (that
        // is the row that failed to resolve) and the whole-article links report the ARTICLE id,
        // deduped to one entry and sorted ascending.
        expect(missing).toStrictEqual([idAt(1), idAt(2)]);
    });
});

// ---------------------------------------------------------------------------
// search / list — the two lanes, the filter, the page
// ---------------------------------------------------------------------------

// The fixture the ranking tests share. One paragraph per article, so the ids are:
//   alpha 'Lane retries'   → paragraph idAt(1), article idAt(2)
//   beta  'Retry budget'   → paragraph idAt(3), article idAt(4)
//   gamma 'Pooling'        → paragraph idAt(5), article idAt(6)
// and the stamps are stampAt(0), stampAt(1), stampAt(2) in the same order.
const seedSearchFixture = () => {
    const rig = makeRig();
    const alpha = createArticle(rig.engine, 'Lane retries', 'Each lane keeps its own retry budget.', ['runbook']);
    const beta = createArticle(rig.engine, 'Retry budget', 'The retry budget is shared by the pool.', ['runbook', 'tuning']);
    const gamma = createArticle(rig.engine, 'Pooling', 'Retries are counted per lane; the retry budget is per pool.', ['tuning']);

    return { engine: rig.engine, alpha, beta, gamma };
};

describe('knowledge engine — list and search', () => {
    it('pages the whole store newest-change first, with counts over the whole matched set', () => {
        const { engine, alpha, beta, gamma } = seedSearchFixture();

        expect(list(engine)).toStrictEqual({
            articles: [
                {
                    id: gamma.article.id,
                    title: 'Pooling',
                    tags: ['tuning'],
                    createdAt: stampAt(2),
                    updatedAt: stampAt(2),
                    rev: 1,
                    paragraphCount: 1
                },
                {
                    id: beta.article.id,
                    title: 'Retry budget',
                    tags: ['runbook', 'tuning'],
                    createdAt: stampAt(1),
                    updatedAt: stampAt(1),
                    rev: 1,
                    paragraphCount: 1
                },
                {
                    id: alpha.article.id,
                    title: 'Lane retries',
                    tags: ['runbook'],
                    createdAt: stampAt(0),
                    updatedAt: stampAt(0),
                    rev: 1,
                    paragraphCount: 1
                }
            ],
            counts: { total: 3 },
            // The default limit is echoed, and a page that ends the set carries no `nextOffset`.
            page: { offset: 0, limit: KNOWLEDGE_LIST_DEFAULT_LIMIT, hasMore: false }
        });
    });

    it('carries a paging loop from one page to the next through nextOffset alone', () => {
        const { engine, alpha, beta, gamma } = seedSearchFixture();
        const first = list(engine, { limit: 2 });

        expect(first.articles.map((row) => row.id)).toStrictEqual([gamma.article.id, beta.article.id]);
        expect(first.page).toStrictEqual({ offset: 0, limit: 2, hasMore: true, nextOffset: 2 });

        const second = list(engine, { offset: first.page.nextOffset as number, limit: 2 });

        expect(second.articles.map((row) => row.id)).toStrictEqual([alpha.article.id]);
        expect(second.page).toStrictEqual({ offset: 2, limit: 2, hasMore: false });
        // `counts.total` is the size of the MATCHED set on every page, never the page size.
        expect(second.counts.total).toBe(3);
    });

    it('filters by tag case-insensitively, any-of, before ranking', () => {
        const { engine, alpha, beta } = seedSearchFixture();

        expect(list(engine, { tag: ['RUNBOOK'] }).articles.map((row) => row.id)).toStrictEqual([
            beta.article.id,
            alpha.article.id
        ]);
        expect(list(engine, { tag: ['runbook', 'nope'] }).counts.total).toBe(2);
        expect(list(engine, { tag: ['nope'] })).toStrictEqual({
            articles: [],
            counts: { total: 0 },
            page: { offset: 0, limit: KNOWLEDGE_LIST_DEFAULT_LIMIT, hasMore: false }
        });
    });

    it('prefers titles: a term that matches one title never consults paragraph text', () => {
        const { engine, beta } = seedSearchFixture();

        // 'Lane retries' does NOT contain 'retry' (it contains 'retries'), and beta's title
        // starts with it — so exactly one article is on the title lane and the text of the
        // other two was never read.
        expect(search(engine, { query: 'retry' })).toStrictEqual({
            articles: [
                {
                    id: beta.article.id,
                    title: 'Retry budget',
                    tags: ['runbook', 'tuning'],
                    createdAt: stampAt(1),
                    updatedAt: stampAt(1),
                    rev: 1,
                    paragraphCount: 1
                }
            ],
            counts: { total: 1 },
            page: { offset: 0, limit: KNOWLEDGE_LIST_DEFAULT_LIMIT, hasMore: false },
            matchedIn: 'title'
        });
    });

    it('ranks an exact title above a prefix above a substring', () => {
        const rig = makeRig();
        const exact = createArticle(rig.engine, 'Retry', 'Body.');
        const prefix = createArticle(rig.engine, 'Retry budget', 'Body.');
        const inside = createArticle(rig.engine, 'The retry log', 'Body.');

        expect(search(rig.engine, { query: 'retry' }).articles.map((row) => row.id)).toStrictEqual([
            exact.article.id,
            prefix.article.id,
            inside.article.id
        ]);
        // The match is case-insensitive, and a caller's padding is trimmed away.
        expect(search(rig.engine, { query: '  RETRY ' }).counts.total).toBe(3);
    });

    it('breaks a score tie by newest change, then by id ascending', () => {
        const rig = makeRig();
        // Both titles merely CONTAIN the term, so both score 1 and the clock decides: the newer
        // article (created second, stamp 1) is first.
        const older = createArticle(rig.engine, 'a retry one', 'Body.');
        const newer = createArticle(rig.engine, 'b retry two', 'Body.');

        expect(search(rig.engine, { query: 'retry' }).articles.map((row) => row.id)).toStrictEqual([
            newer.article.id,
            older.article.id
        ]);

        // With the clock frozen, the last tiebreak is the id. The source below issues ids in the
        // REVERSE of creation order, so this cannot pass by falling back on insertion order.
        const source = [idAt(8), idAt(7), idAt(6), idAt(5)];
        let pulled = 0;
        const frozen = createKnowledgeEngine({ ids: () => source[pulled++], now: () => 0 });
        const zeta = createArticle(frozen, 'zeta retry', 'Body.');
        const alpha = createArticle(frozen, 'alpha retry', 'Body.');

        expect(alpha.article.id < zeta.article.id).toBe(true);
        expect(search(frozen, { query: 'retry' }).articles.map((row) => row.id)).toStrictEqual([
            alpha.article.id,
            zeta.article.id
        ]);
    });

    it('falls back to paragraph text only when no title matches, and says so', () => {
        const rig = makeRig();
        const once = createArticle(rig.engine, 'Alpha notes', 'quux once.');
        const twice = createArticle(rig.engine, 'Beta notes', 'quux twice quux again.');
        const later = createArticle(rig.engine, 'Gamma notes', 'quux once.');
        createArticle(rig.engine, 'Delta notes', 'nothing here.');

        const result = search(rig.engine, { query: 'quux' });

        // Two occurrences outrank one; between the two single-occurrence articles the newer one
        // wins. `matchedIn` is 'text' because no title held the term at all.
        expect(result.matchedIn).toBe('text');
        expect(result.counts.total).toBe(3);
        expect(result.articles.map((row) => row.id)).toStrictEqual([
            twice.article.id,
            later.article.id,
            once.article.id
        ]);

        // A term nothing matches at all: the fallback lane is the one that answered last.
        const nothing = search(rig.engine, { query: 'zzzz' });

        expect(nothing).toStrictEqual({
            articles: [],
            counts: { total: 0 },
            page: { offset: 0, limit: KNOWLEDGE_LIST_DEFAULT_LIMIT, hasMore: false },
            matchedIn: 'text'
        });
    });

    it('applies the tag filter to the CANDIDATES, so a tagged text hit beats an untagged title hit', () => {
        const { engine, beta, gamma } = seedSearchFixture();

        // 'pool' is in gamma's TITLE and in beta's TEXT. Restricted to the `runbook` tag, gamma
        // is not a candidate, so the title lane is empty and the text lane answers — which is
        // only possible if the filter runs before the lanes.
        const filtered = search(engine, { query: 'pool', tag: ['runbook'] });

        expect(filtered.matchedIn).toBe('text');
        expect(filtered.articles.map((row) => row.id)).toStrictEqual([beta.article.id]);

        // Without the filter the title lane answers first and gamma wins.
        const unfiltered = search(engine, { query: 'pool' });

        expect(unfiltered.matchedIn).toBe('title');
        expect(unfiltered.articles.map((row) => row.id)).toStrictEqual([gamma.article.id]);
    });

    it('keeps list and search distinct: only search reports the lane', () => {
        const { engine, beta } = seedSearchFixture();

        // `list` takes the term under `search` and answers with the plain page shape.
        const page = list(engine, { search: 'retry' });

        expect(page.articles.map((row) => row.id)).toStrictEqual([beta.article.id]);
        expect('matchedIn' in page).toBe(false);
        expect('matchedIn' in search(engine, { query: 'retry' })).toBe(true);
    });

    it('refuses a search term and a page bound the contract does not allow', () => {
        const { engine } = seedSearchFixture();

        expect(expectCode(() => search(engine, {}), 'EKNOWLEDGE_INPUT').message).toBe(
            'knowledge "search" requires a non-empty "query" string; use "list" to page the whole store.'
        );
        expect(expectCode(() => search(engine, { query: '   ' }), 'EKNOWLEDGE_INPUT').message).toBe(
            'knowledge "search" "query" is blank; drop it to page the whole store.'
        );
        expect(expectCode(() => list(engine, { search: '   ' }), 'EKNOWLEDGE_INPUT').message).toBe(
            'knowledge "list" "search" is blank; drop it to page the whole store.'
        );
        expect(
            expectCode(() => search(engine, { query: 'x'.repeat(4_001) }), 'EKNOWLEDGE_LIMIT').message
        ).toBe(
            'knowledge "search" "query" is 4001 characters, over the 4000-character KNOWLEDGE_MAX_TEXT bound; search for a phrase, not for a document.'
        );
        expect(
            expectCode(() => search(engine, { query: 'retry', limit: 0 }), 'EKNOWLEDGE_LIMIT').message
        ).toBe(
            'knowledge "search" "limit" is 0, outside the 1-100 range the KNOWLEDGE_LIST_MAX_LIMIT bound allows; pass a limit between 1 and 100.'
        );
        expect(expectCode(() => list(engine, { limit: 101 }), 'EKNOWLEDGE_LIMIT').message).toBe(
            'knowledge "list" "limit" is 101, outside the 1-100 range the KNOWLEDGE_LIST_MAX_LIMIT bound allows; pass a limit between 1 and 100.'
        );
        expect(expectCode(() => list(engine, { limit: 1.5 }), 'EKNOWLEDGE_LIMIT').message).toBe(
            'knowledge "list" "limit" is 1.5, outside the 1-100 range the KNOWLEDGE_LIST_MAX_LIMIT bound allows; pass a limit between 1 and 100.'
        );
        expect(expectCode(() => list(engine, { offset: -1 }), 'EKNOWLEDGE_LIMIT').message).toBe(
            'knowledge "list" "offset" is -1, which is not a non-negative integer; pass an offset the previous page\'s "nextOffset" gave you.'
        );
        expect(
            expectCode(() => search(engine, { query: 'retry', tag: [1 as never] }), 'EKNOWLEDGE_INPUT')
                .message
        ).toBe('knowledge "search" "tag" holds "1", which is not a non-empty tag string.');
    });

    it('caps a search at the KNOWLEDGE_MAX_SEARCH rank it can actually deliver, and leaves list uncapped', () => {
        const { engine } = seedSearchFixture();

        // offset + limit is the deepest rank the call could receive, so 30+20 is the last legal
        // window and 31+20 asks for rank 51.
        expect(search(engine, { query: 'retry', offset: 30, limit: 20 }).page.offset).toBe(30);
        expect(
            expectCode(() => search(engine, { query: 'retry', offset: 31, limit: 20 }), 'EKNOWLEDGE_LIMIT')
                .message
        ).toBe(
            'knowledge "search" asks for rank 32-51, past the KNOWLEDGE_MAX_SEARCH ceiling of 50 results. Narrow the query or add a "tag" filter instead of paging to the end of a loose match.'
        );
        expect(
            expectCode(() => search(engine, { query: 'retry', offset: 40, limit: 20 }), 'EKNOWLEDGE_LIMIT')
                .message
        ).toBe(
            'knowledge "search" asks for rank 41-60, past the KNOWLEDGE_MAX_SEARCH ceiling of 50 results. Narrow the query or add a "tag" filter instead of paging to the end of a loose match.'
        );

        // `list` pages the whole store on purpose, so it is not capped by a relevance bound.
        expect(list(engine, { offset: 60, limit: KNOWLEDGE_LIST_MAX_LIMIT })).toStrictEqual({
            articles: [],
            counts: { total: 3 },
            page: { offset: 60, limit: KNOWLEDGE_LIST_MAX_LIMIT, hasMore: false }
        });
    });

    it('drops trailing rows to stay under the response budget, and flags that it did', () => {
        // Fixed-size rows: every title is 16 characters, every tag is 64 (the KNOWLEDGE_MAX_TAG
        // bound) and every body is 8, so the number of rows the budget keeps is a property of the
        // ROW SIZE, not of the data. PAGE_KEEP is that number: the largest page that fits, and
        // the two neighbours below are what prove it.
        const PAGE_KEEP = 58;
        const engine = createKnowledgeEngine({ ids: makeIdSource(501), now: () => 0 });
        const tags = [`${'a'.repeat(63)}0`, `${'a'.repeat(63)}1`, `${'a'.repeat(63)}2`];

        for (let index = 0; index < KNOWLEDGE_MAX_ARTICLES; index += 1) {
            create(engine, {
                title: `Page article ${String(index).padStart(3, '0')}`,
                content: [`Body ${String(index).padStart(3, '0')}`],
                tags
            });
        }

        const cut = list(engine, { limit: KNOWLEDGE_LIST_MAX_LIMIT });

        expect(cut.counts.total).toBe(KNOWLEDGE_MAX_ARTICLES);
        expect(cut.articles.length).toBe(PAGE_KEEP);
        // `page.limit` is the limit the CALLER asked for; the kept count is what `articles`
        // carries, and `budgetTruncated` is what separates this from a limit-sized page.
        expect(cut.page).toStrictEqual({
            offset: 0,
            limit: KNOWLEDGE_LIST_MAX_LIMIT,
            hasMore: true,
            nextOffset: PAGE_KEEP,
            budgetTruncated: true
        });

        // The boundary: exactly PAGE_KEEP rows is not a budget cut at all...
        const exact = list(engine, { limit: PAGE_KEEP });

        expect(exact.page).toStrictEqual({ offset: 0, limit: PAGE_KEEP, hasMore: true, nextOffset: PAGE_KEEP });

        // ...and one row more is cut back to the SAME rows: the budget drops the tail, never a
        // middle, so a page is a prefix of the ranked set and `nextOffset` is honest.
        const oneTooMany = list(engine, { limit: PAGE_KEEP + 1 });

        expect(oneTooMany.articles).toStrictEqual(exact.articles);
        expect(oneTooMany.page.budgetTruncated).toBe(true);

        // A page from the cut resumes exactly where the cut stopped.
        const next = list(engine, { offset: PAGE_KEEP, limit: 1 });

        expect(next.page.nextOffset).toBe(PAGE_KEEP + 1);
    });
});

// A deterministic id source for the tests that only need valid uuids (the budget sections
// measure row SIZE, where every uuid is the same 36 characters). `from` keeps one test's ids
// from looking like another test's.
const makeIdSource = (from = 1) => {
    let issued = from - 1;

    return (): string => idAt(++issued);
};
// ---------------------------------------------------------------------------
// modify — one paragraph, one kind of change
// ---------------------------------------------------------------------------

// The modify fixture: one article, three paragraphs, one of them tagged.
//   paragraphs idAt(1), idAt(2), idAt(3); article idAt(4); stamp stampAt(0)
// Tests that need a second article create one afterwards, so its seam values follow on
// (paragraph idAt(5), article idAt(6), stamp stampAt(1)).
const seedModifyFixture = () => {
    const rig = makeRig();
    const document = create(rig.engine, {
        title: 'Document',
        content: [
            'First paragraph.',
            { text: 'Tagged middle paragraph.', tags: ['detail'] },
            'Last paragraph.'
        ]
    });

    return { rig, engine: rig.engine, document };
};

// The article id that fixture commits: one create of three paragraphs claims paragraph ids
// 1-3 and the article id 4.
const DOCUMENT_MODIFY_ID = idAt(4);

// The stored shape of that fixture, with the caller's revision and stamp substituted, so a
// result assertion can name the WHOLE committed article instead of a field at a time. The key
// order is the order `copyArticle` writes, which is the order the byte budget measures.
//
// The paragraph stamps are SEPARATE from the article stamp on purpose: an article-level edit
// moves `updatedAt` on the article and leaves every paragraph on the stamp it was created at,
// which is the difference this engine is repeatedly asked about.
const storedDocument = (
    article: { createdAt: string; updatedAt: string; rev: number },
    title = 'Document',
    tags: string[] = [],
    paragraphUpdatedAt = article.createdAt
) => ({
    id: DOCUMENT_MODIFY_ID,
    title,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    tags,
    content: [
        {
            id: idAt(1),
            text: 'First paragraph.',
            rev: 1,
            createdAt: article.createdAt,
            updatedAt: paragraphUpdatedAt
        },
        {
            id: idAt(2),
            text: 'Tagged middle paragraph.',
            rev: 1,
            createdAt: article.createdAt,
            updatedAt: paragraphUpdatedAt,
            tags: ['detail']
        },
        {
            id: idAt(3),
            text: 'Last paragraph.',
            rev: 1,
            createdAt: article.createdAt,
            updatedAt: paragraphUpdatedAt
        }
    ],
    rev: article.rev
});

describe('knowledge engine — modify', () => {
    it('renames the article and reports the field that moved, alone', () => {
        const { engine, document } = seedModifyFixture();
        const stamp = stampAt(1);

        expect(modify(engine, { id: DOCUMENT_MODIFY_ID, title: 'Renamed document' })).toStrictEqual({
            article: {
                ...storedDocument({ createdAt: stampAt(0), updatedAt: stamp, rev: 2 }),
                title: 'Renamed document'
            },
            noop: false,
            articleFields: ['title']
        });
        expect(document.article.rev).toBe(1);
    });

    it('treats a title that differs only by padding as no change at all', () => {
        const rig = makeRig();
        const { engine } = rig;
        const feed = recordFeed(engine);
        create(engine, { title: 'Document', content: ['First paragraph.'] });

        const result = modify(engine, { id: idAt(2), title: '  Document  ' });

        expect(result.noop).toBe(true);
        expect(result.article.rev).toBe(1);
        expect(result.article.updatedAt).toBe(stampAt(0));
        // A call that wrote nothing commits nothing: no watermark move and no notification.
        expect(engine.snapshot().storeRev).toBe(1);
        expect(feed).toStrictEqual([
            { storeRev: 1, reason: 'create', affectedArticles: [idAt(2)], removedArticles: [] }
        ]);
    });

    it('merges article tags in stored order and subtracts the removals', () => {
        const rig = makeRig();
        create(rig.engine, { title: 'Tagged', content: ['Body.'], tags: ['keep', 'drop'] });
        const stamp = rig.nextStamp();

        const result = modify(rig.engine, {
            id: idAt(2),
            addTags: ['add', 'Add'],
            removeTags: ['drop']
        });

        expect(result.articleFields).toStrictEqual(['tags']);
        // Stored rows first, additions in call order (case-insensitive dedupe keeps the FIRST
        // spelling), and a tag named by both lists nets out removed.
        expect(result.article.tags).toStrictEqual(['keep', 'add']);
        expect(result.article.updatedAt).toBe(stamp);

        // Adding a tag the article already has is not a change.
        const again = modify(rig.engine, { id: idAt(2), addTags: ['KEEP'] });

        expect(again.noop).toBe(true);
        expect(again.article.tags).toStrictEqual(['keep', 'add']);
    });

    it('rewrites one paragraph and bumps only that paragraph revision', () => {
        const { engine } = seedModifyFixture();
        const stamp = stampAt(1);

        const result = modify(engine, { id: DOCUMENT_MODIFY_ID, setParagraphs: [{ id: idAt(2), text: 'Rewritten middle.' }] });

        expect(result.changedIds).toStrictEqual([idAt(2)]);
        expect(result.article.content[1]).toStrictEqual({
            id: idAt(2),
            text: 'Rewritten middle.',
            rev: 2,
            createdAt: stampAt(0),
            updatedAt: stamp,
            tags: ['detail']
        });
        // Untouched rows keep their original stamp and rev.
        expect(result.article.content[0]).toStrictEqual({
            id: idAt(1),
            text: 'First paragraph.',
            rev: 1,
            createdAt: stampAt(0),
            updatedAt: stampAt(0)
        });
        expect(result.article.rev).toBe(2);
    });

    it('reports a paragraph it rewrote nothing under noopIds', () => {
        const { engine } = seedModifyFixture();

        expect(
            modify(engine, {
                id: DOCUMENT_MODIFY_ID,
                setParagraphs: [{ id: idAt(2), text: 'Tagged middle paragraph.', tags: ['DETAIL'] }]
            })
        ).toStrictEqual({ article: storedDocument({ createdAt: stampAt(0), updatedAt: stampAt(0), rev: 1 }), noop: true, noopIds: [idAt(2)] });
    });

    it('clears an optional paragraph key when the caller sends an empty list, instead of storing it', () => {
        const { engine } = makeRig();
        // One create commits paragraph idAt(1) and article idAt(2); the link points at the
        // article itself, which the create validates against the draft.
        create(engine, {
            title: 'Document',
            content: [
                { text: 'First paragraph.', tags: ['detail'], refs: [{ articleId: idAt(2), note: 'self' }] }
            ]
        });

        const cleared = modify(engine, { id: idAt(2), setParagraphs: [{ id: idAt(1), tags: [], refs: [] }] });

        expect(cleared.changedIds).toStrictEqual([idAt(1)]);
        expect(cleared.article.content[0]).toStrictEqual({
            id: idAt(1),
            text: 'First paragraph.',
            rev: 2,
            createdAt: stampAt(0),
            updatedAt: stampAt(1)
        });
        expect('tags' in cleared.article.content[0]).toBe(false);
        expect('refs' in cleared.article.content[0]).toBe(false);
    });

    it('refuses to re-assert a link whose target has gone, even when the value is unchanged', () => {
        const rig = makeRig();
        const { engine } = rig;
        const target = create(rig.engine, { title: 'Target', content: ['First row.', 'Second row.'] });
        // target: paragraphs idAt(1), idAt(2); article idAt(3)
        const holder = create(engine, {
            title: 'Holder',
            content: [
                {
                    text: 'Quotes the target.',
                    refs: [{ articleId: target.article.id, paragraphId: target.article.content[0].id }]
                }
            ]
        });
        // holder: paragraph idAt(4), article idAt(5)
        const reassert = [
            {
                id: holder.article.content[0].id,
                refs: [{ articleId: target.article.id, paragraphId: target.article.content[0].id }]
            }
        ];

        // The plain rewrite would call this a no-op (the refs list is byte-identical to the
        // stored one), but a link to a row that is gone is a refusal whoever wrote it.
        modify(engine, { id: target.article.id, removeParagraphs: [target.article.content[0].id] });

        const paragraphLevel = expectCode(
            () => modify(engine, { id: holder.article.id, setParagraphs: reassert }),
            'EKNOWLEDGE_REF'
        );

        expect(paragraphLevel.message).toBe(
            `knowledge "modify" set a reference on paragraph "${idAt(4)}" to paragraph "${idAt(1)}" of article "${idAt(3)}", which that article does not hold. Reference a paragraph that exists (read the article for its ids), or drop "paragraphId" to link the whole article.`
        );
        expect(paragraphLevel.details).toStrictEqual({
            paragraphId: idAt(4),
            articleId: idAt(3),
            paragraphTarget: idAt(1)
        });

        // Once the whole target article is gone, the refusal names the ARTICLE instead, and the
        // payload drops the paragraph target: the article is what the caller has to re-find.
        remove(engine, { id: target.article.id });

        const articleLevel = expectCode(
            () => modify(engine, { id: holder.article.id, setParagraphs: reassert }),
            'EKNOWLEDGE_REF'
        );

        expect(articleLevel.message).toBe(
            `knowledge "modify" set a reference on paragraph "${idAt(4)}" to article "${idAt(3)}", which this store does not hold. Reference an article that exists — "search" for it first — or remove the reference.`
        );
        expect(articleLevel.details).toStrictEqual({ paragraphId: idAt(4), articleId: idAt(3) });

        // The refused calls changed nothing: the stored link is still the one on record, and it
        // reads back as dangling rather than as an error.
        const stored = read(engine, { id: holder.article.id });

        expect(stored.paragraphs?.[0].refs).toStrictEqual([{ articleId: idAt(3), paragraphId: idAt(1) }]);
        expect(stored.danglingRefs).toStrictEqual([idAt(1)]);
    });

    it('appends paragraphs after what exists, reporting them as created ids', () => {
        const { engine } = seedModifyFixture();
        const stamp = stampAt(1);

        const result = modify(engine, {
            id: DOCUMENT_MODIFY_ID,
            addContent: ['Appended.', { text: 'Appended and tagged.', tags: ['new'] }]
        });

        expect(result.createdIds).toStrictEqual([idAt(5), idAt(6)]);
        expect(result.article.content.slice(3)).toStrictEqual([
            { id: idAt(5), text: 'Appended.', rev: 1, createdAt: stamp, updatedAt: stamp },
            { id: idAt(6), text: 'Appended and tagged.', rev: 1, createdAt: stamp, updatedAt: stamp, tags: ['new'] }
        ]);
        expect(result.article.content.length).toBe(5);
    });

    it('refuses the paragraph that would cross KNOWLEDGE_MAX_PARAGRAPHS, at the same call that would fill it', () => {
        const rig = makeRig();
        const full = create(rig.engine, {
            title: 'Full',
            content: Array.from({ length: KNOWLEDGE_MAX_PARAGRAPHS }, (_, index) => `Paragraph ${index}.`)
        });

        // 64 paragraphs in ONE create is legal: KNOWLEDGE_MAX_ITEMS and KNOWLEDGE_MAX_PARAGRAPHS
        // meet at 64, so `create` cannot cross the article bound — only `addContent` can.
        expect(full.article.content.length).toBe(KNOWLEDGE_MAX_PARAGRAPHS);

        const failure = expectCode(
            () => modify(rig.engine, { id: full.article.id, addContent: ['One too many.'] }),
            'EKNOWLEDGE_LIMIT'
        );

        expect(failure.message).toBe(
            `knowledge "modify" "addContent" would leave 65 paragraphs in article "${full.article.id}", over the KNOWLEDGE_MAX_PARAGRAPHS limit of 64. Remove paragraphs in the same call or start another article.`
        );
        expect(failure.details).toStrictEqual({ id: full.article.id, max: KNOWLEDGE_MAX_PARAGRAPHS, projected: 65 });

        // Two adds and one removal is still 65: the bound is the size the article will HAVE, not
        // the size it has when the first append is applied.
        expect(
            expectCode(
                () =>
                    modify(rig.engine, {
                        id: full.article.id,
                        addContent: ['A.', 'B.'],
                        removeParagraphs: [full.article.content[0].id]
                    }),
                'EKNOWLEDGE_LIMIT'
            ).details
        ).toStrictEqual({ id: full.article.id, max: KNOWLEDGE_MAX_PARAGRAPHS, projected: 65 });

        // One for one is the documented way through, and it is what the refusal above offers.
        const swapped = modify(rig.engine, {
            id: full.article.id,
            addContent: ['One swapped in.'],
            removeParagraphs: [full.article.content[0].id]
        });

        expect(swapped.article.content.length).toBe(KNOWLEDGE_MAX_PARAGRAPHS);
        expect(swapped.createdIds).toStrictEqual([idAt(66)]);
        expect(swapped.removedIds).toStrictEqual([idAt(1)]);

        // With room now free, a plain append fits again.
        expect(
            modify(rig.engine, { id: full.article.id, removeParagraphs: [idAt(2)] }).article.content.length
        ).toBe(KNOWLEDGE_MAX_PARAGRAPHS - 1);
    });

    it('reorders paragraphs without touching any paragraph revision', () => {
        const { engine } = seedModifyFixture();

        const moved = modify(engine, { id: DOCUMENT_MODIFY_ID, moveParagraphs: [{ id: idAt(3), before: idAt(1) }] });

        expect(moved.movedIds).toStrictEqual([idAt(3)]);
        expect(moved.article.content.map((paragraph) => paragraph.id)).toStrictEqual([idAt(3), idAt(1), idAt(2)]);
        // Order is not content: the article rev moves (the document the caller read is gone) and
        // no paragraph rev does, which is why `movedIds` is the only place a reorder is visible.
        expect(moved.article.content.map((paragraph) => paragraph.rev)).toStrictEqual([1, 1, 1]);
        expect(moved.article.rev).toBe(2);
        expect(moved.articleFields).toBeUndefined();

        // No `before` means "move to the end".
        expect(
            modify(engine, { id: DOCUMENT_MODIFY_ID, moveParagraphs: [{ id: idAt(3) }] }).article.content.map((p) => p.id)
        ).toStrictEqual([idAt(1), idAt(2), idAt(3)]);

        // Each move is applied to the array the previous one produced.
        expect(
            modify(engine, {
                id: DOCUMENT_MODIFY_ID,
                moveParagraphs: [
                    { id: idAt(3), before: idAt(1) },
                    { id: idAt(2), before: idAt(3) }
                ]
            }).article.content.map((paragraph) => paragraph.id)
        ).toStrictEqual([idAt(2), idAt(3), idAt(1)]);

        // A move that lands where the paragraph already sits is not a change: paragraph 2 is
        // already immediately before paragraph 3 in the order the moves above produced.
        const still = modify(engine, { id: DOCUMENT_MODIFY_ID, moveParagraphs: [{ id: idAt(2), before: idAt(3) }] });

        expect(still.noop).toBe(true);
        expect(still.article.content.map((paragraph) => paragraph.id)).toStrictEqual([idAt(2), idAt(3), idAt(1)]);
        expect(still.movedIds).toBeUndefined();
    });

    it('refuses a move that names a paragraph this article does not hold', () => {
        const { engine } = seedModifyFixture();

        const unknown = expectCode(
            () => modify(engine, { id: DOCUMENT_MODIFY_ID, moveParagraphs: [{ id: MISSING_ID }] }),
            'EKNOWLEDGE_NOT_FOUND'
        );

        expect(unknown.message).toBe(
            `knowledge "modify" "moveParagraphs" named paragraph "${MISSING_ID}", which article "${DOCUMENT_MODIFY_ID}" ("Document") does not hold. Read the article with "outline": true for its paragraph ids.`
        );
        expect(unknown.details).toStrictEqual({ id: DOCUMENT_MODIFY_ID, paragraphId: MISSING_ID });

        expect(
            expectCode(
                () => modify(engine, { id: DOCUMENT_MODIFY_ID, moveParagraphs: [{ id: idAt(1), before: MISSING_ID }] }),
                'EKNOWLEDGE_NOT_FOUND'
            ).details
        ).toStrictEqual({ id: DOCUMENT_MODIFY_ID, paragraphId: MISSING_ID });
    });

    it('removes paragraphs, and refuses one this article does not hold', () => {
        const { engine } = seedModifyFixture();

        const removed = modify(engine, { id: DOCUMENT_MODIFY_ID, removeParagraphs: [idAt(1)] });

        expect(removed.removedIds).toStrictEqual([idAt(1)]);
        expect(removed.article.content.map((paragraph) => paragraph.id)).toStrictEqual([idAt(2), idAt(3)]);
        expect(removed.article.rev).toBe(2);

        // Emptying an article is legal: the article is the unit, not its paragraphs.
        expect(
            modify(engine, { id: DOCUMENT_MODIFY_ID, removeParagraphs: [idAt(2), idAt(3)] }).article.content
        ).toStrictEqual([]);

        // An unknown id is a refusal, not the silent skip a stale removal would get away with.
        const failure = expectCode(
            () => modify(engine, { id: DOCUMENT_MODIFY_ID, removeParagraphs: [idAt(1)] }),
            'EKNOWLEDGE_NOT_FOUND'
        );

        expect(failure.message).toBe(
            `knowledge "modify" "removeParagraphs" named paragraph "${idAt(1)}", which article "${DOCUMENT_MODIFY_ID}" ("Document") does not hold. Read the article with "outline": true for its paragraph ids.`
        );
        expect(failure.details).toStrictEqual({ id: DOCUMENT_MODIFY_ID, paragraphId: idAt(1) });

        expect(
            expectCode(
                () => modify(engine, { id: DOCUMENT_MODIFY_ID, removeParagraphs: [MISSING_ID, MISSING_ID] }),
                'EKNOWLEDGE_ID'
            ).message
        ).toBe(`knowledge "modify" "removeParagraphs" names "${MISSING_ID}" twice; name each id once per call.`);
    });

    it('refuses one paragraph named by two kinds of change, naming both steps', () => {
        const { engine } = seedModifyFixture();

        const conflict = expectCode(
            () =>
                modify(engine, {
                    id: DOCUMENT_MODIFY_ID,
                    setParagraphs: [{ id: idAt(2), text: 'Rewritten.' }],
                    moveParagraphs: [{ id: idAt(2), before: idAt(1) }]
                }),
            'EKNOWLEDGE_ID'
        );

        expect(conflict.message).toBe(
            `knowledge "modify" changes paragraph "${idAt(2)}" in both "setParagraphs" and "moveParagraphs"; one paragraph takes one kind of change per call. Split the call or drop one of them.`
        );
        expect(conflict.details).toStrictEqual({ paragraphId: idAt(2), steps: ['setParagraphs', 'moveParagraphs'] });

        expect(
            expectCode(
                () => modify(engine, { id: DOCUMENT_MODIFY_ID, removeParagraphs: [idAt(1)], moveParagraphs: [{ id: idAt(1) }] }),
                'EKNOWLEDGE_ID'
            ).details
        ).toStrictEqual({ paragraphId: idAt(1), steps: ['moveParagraphs', 'removeParagraphs'] });

        // Two paragraphs, one change each, is never a conflict.
        expect(
            modify(engine, {
                id: DOCUMENT_MODIFY_ID,
                setParagraphs: [{ id: idAt(2), text: 'Rewritten.' }],
                moveParagraphs: [{ id: idAt(3), before: idAt(1) }]
            }).noop
        ).toBe(false);
    });

    it('applies every kind of change in one call and reports each kind under its own key', () => {
        const rig = makeRig();
        const { engine } = rig;
        create(rig.engine, { title: 'Document', tags: ['drop'], content: ['One.', { text: 'Two.', tags: ['detail'] }, 'Three.'] });
        const stamp = rig.nextStamp();

        const result = modify(engine, {
            id: DOCUMENT_MODIFY_ID,
            title: 'Renamed',
            removeTags: ['drop'],
            setParagraphs: [{ id: idAt(2), text: 'Two, rewritten.' }],
            addContent: ['Four.'],
            moveParagraphs: [{ id: idAt(5), before: idAt(1) }],
            removeParagraphs: [idAt(3)]
        });

        expect(result.noop).toBe(false);
        expect(result.articleFields).toStrictEqual(['title', 'tags']);
        expect(result.changedIds).toStrictEqual([idAt(2)]);
        // The create above claimed paragraphs 1-3 and article id 4, so the appended paragraph is
        // idAt(5).
        expect(result.createdIds).toStrictEqual([idAt(5)]);
        expect(result.movedIds).toStrictEqual([idAt(5)]);
        expect(result.removedIds).toStrictEqual([idAt(3)]);
        // `addContent` runs before `moveParagraphs`, so the paragraph appended in this very call
        // is the one the move repositions — and its rev is still 1, because a move is not an edit.
        expect(result.article.content.map((paragraph) => [paragraph.id, paragraph.rev])).toStrictEqual([
            [idAt(5), 1],
            [idAt(1), 1],
            [idAt(2), 2]
        ]);
        expect(result.article).toStrictEqual({
            id: DOCUMENT_MODIFY_ID,
            title: 'Renamed',
            createdAt: stampAt(0),
            updatedAt: stamp,
            tags: [],
            content: [
                { id: idAt(5), text: 'Four.', rev: 1, createdAt: stamp, updatedAt: stamp },
                { id: idAt(1), text: 'One.', rev: 1, createdAt: stampAt(0), updatedAt: stampAt(0) },
                { id: idAt(2), text: 'Two, rewritten.', rev: 2, createdAt: stampAt(0), updatedAt: stamp, tags: ['detail'] }
            ],
            rev: 2
        });
    });

    it('lets a paragraph link to another paragraph the same call appended', () => {
        const { engine } = seedModifyFixture();

        const result = modify(engine, {
            id: DOCUMENT_MODIFY_ID,
            addContent: [{ text: 'Step one.' }, { text: 'Step two.', refs: [{ articleId: DOCUMENT_MODIFY_ID, paragraphId: idAt(5) }] }]
        });

        expect(result.createdIds).toStrictEqual([idAt(5), idAt(6)]);
        expect(result.article.content[4].refs).toStrictEqual([
            { articleId: DOCUMENT_MODIFY_ID, paragraphId: idAt(5) }
        ]);

        // A link to a paragraph this same call REMOVED is refused, because ref validation runs
        // after the removals.
        expect(
            expectCode(
                () =>
                    modify(engine, {
                        id: DOCUMENT_MODIFY_ID,
                        setParagraphs: [{ id: idAt(1), refs: [{ articleId: DOCUMENT_MODIFY_ID, paragraphId: idAt(6) }] }],
                        removeParagraphs: [idAt(6)]
                    }),
                'EKNOWLEDGE_REF'
            ).details
        ).toStrictEqual({
            paragraphId: idAt(1),
            articleId: DOCUMENT_MODIFY_ID,
            paragraphTarget: idAt(6)
        });
    });

    it('reports the dangling targets left in the article it just wrote', () => {
        const { engine } = seedModifyFixture();
        const target = createArticle(engine, 'Target', 'Worth quoting.');

        modify(engine, {
            id: DOCUMENT_MODIFY_ID,
            addContent: [{ text: 'Quotes the target.', refs: [{ articleId: target.article.id }] }]
        });
        remove(engine, { id: target.article.id });

        const renamed = modify(engine, { id: DOCUMENT_MODIFY_ID, title: 'Renamed' });

        expect(renamed.danglingRefs).toStrictEqual([target.article.id]);
        // The stored link itself is untouched: a cascade would bump a rev nobody edited.
        expect(renamed.article.content[3].refs).toStrictEqual([{ articleId: target.article.id }]);
    });

    it('leaves the store exactly as it was when a later step of the call refuses', () => {
        const { engine } = makeRig();
        const feed = recordFeed(engine);
        // One create: paragraph idAt(1), article idAt(2).
        create(engine, { title: 'Document', content: ['First paragraph.'] });
        const before = clone(engine.snapshot());

        // The first step is a real edit; the second references a row that does not exist. The
        // edit must not survive the refusal.
        expectCode(
            () =>
                modify(engine, {
                    id: idAt(2),
                    title: 'Renamed',
                    addContent: [{ text: 'Dangling.', refs: [{ articleId: MISSING_ID }] }]
                }),
            'EKNOWLEDGE_REF'
        );

        expect(engine.snapshot()).toStrictEqual(before);
        expect(feed).toStrictEqual([
            { storeRev: 1, reason: 'create', affectedArticles: [idAt(2)], removedArticles: [] }
        ]);
        // The CAS token the refused call did not get to use is still the current one.
        expect(
            modify(engine, { id: idAt(2), title: 'Renamed', expects: [{ id: idAt(2), rev: 1 }] }).article.rev
        ).toBe(2);
    });

    it('refuses an article this store does not hold', () => {
        const { engine } = seedModifyFixture();
        const failure = expectCode(() => modify(engine, { id: MISSING_ID, title: 'Ghost' }), 'EKNOWLEDGE_NOT_FOUND');

        expect(failure.message).toBe(
            `knowledge "modify" found no article "${MISSING_ID}". Run a "search" or "list" to find the article you mean; ids are uuids the engine assigned and cannot be guessed.`
        );
        expect(failure.details).toStrictEqual({ id: MISSING_ID });
    });
});

// ---------------------------------------------------------------------------
// The CAS token — the only conflict this engine has
// ---------------------------------------------------------------------------

describe('knowledge engine — expects and the stale refusal', () => {
    it('refuses a stale token with the current article attached, in one round trip', () => {
        const { engine } = seedModifyFixture();

        // The rename commits at the second clock reading, so every value below is known before
        // the stale call runs.
        modify(engine, { id: DOCUMENT_MODIFY_ID, title: 'Renamed' });

        const current = storedDocument({ createdAt: stampAt(0), updatedAt: stampAt(1), rev: 2 }, 'Renamed');
        const failure = expectCode(
            () => modify(engine, { id: DOCUMENT_MODIFY_ID, title: 'Also renamed', expects: [{ id: DOCUMENT_MODIFY_ID, rev: 1 }] }),
            'EKNOWLEDGE_REV'
        );

        // The message carries the token sent, the token held, when it moved, the retry token
        // spelled out, and the current article — everything the next call needs.
        expect(failure.message).toBe(
            `knowledge "modify" refused article "${DOCUMENT_MODIFY_ID}" at revision 1: the store holds revision 2, last modified at ${stampAt(1)}. ` +
                `Retry with "expects" [{ id: "${DOCUMENT_MODIFY_ID}", rev: 2 }] after re-reading the paragraphs you want to change. ` +
                // The key order is the copy order, because the payload is the JSON the budget
                // measured, verbatim.
                `current: ${JSON.stringify(current)}`
        );
        expect(failure.details).toStrictEqual({
            id: DOCUMENT_MODIFY_ID,
            expectedRev: 1,
            currentRev: 2,
            updatedAt: stampAt(1),
            projected: false,
            article: current
        });
    });

    it('degrades the stale payload to metadata plus outline when the article is too big, and says so', () => {
        const rig = makeRig();
        const long = create(rig.engine, {
            title: 'Huge',
            content: Array.from({ length: 8 }, () => 'x'.repeat(1_200))
        });

        modify(rig.engine, { id: long.article.id, title: 'Huge, renamed' });

        const failure = expectCode(
            () => modify(rig.engine, { id: long.article.id, title: 'Huge, again', expects: [{ id: long.article.id, rev: 1 }] }),
            'EKNOWLEDGE_REV'
        );

        const projected = {
            id: long.article.id,
            title: 'Huge, renamed',
            tags: [],
            createdAt: stampAt(0),
            updatedAt: stampAt(1),
            rev: 2,
            paragraphCount: 8,
            outline: Array.from({ length: 8 }, (_, index) => ({
                id: idAt(index + 1),
                rev: 1,
                updatedAt: stampAt(0),
                chars: 1_200
            }))
        };

        // The projection is a degradation the caller can READ: the message names it, and
        // `details.projected` is the machine-visible twin.
        expect(failure.message).toBe(
            `knowledge "modify" refused article "${long.article.id}" at revision 1: the store holds revision 2, last modified at ${stampAt(1)}. ` +
                `Retry with "expects" [{ id: "${long.article.id}", rev: 2 }] after re-reading the paragraphs you want to change. ` +
                `current: ${JSON.stringify(projected)} (paragraph text omitted)`
        );
        expect(failure.details).toStrictEqual({
            id: long.article.id,
            expectedRev: 1,
            currentRev: 2,
            updatedAt: stampAt(1),
            projected: true,
            note: 'paragraph text omitted',
            article: projected
        });
        expect(failure.message.includes('x'.repeat(1_200))).toBe(false);
    });

    it('refuses a token that names a different article, and a token the engine never minted', () => {
        const rig = makeRig();
        const { engine } = rig;
        const first = createArticle(engine, 'First', 'One.');
        createArticle(engine, 'Second', 'Two.');

        expect(
            expectCode(
                () => modify(engine, { id: first.article.id, title: 'Renamed', expects: [{ id: idAt(4), rev: 1 }] }),
                'EKNOWLEDGE_INPUT'
            ).message
        ).toBe(
            `knowledge "modify" writes article "${first.article.id}", so "expects" may only name that id; it named "${idAt(4)}". One article per call — send a second call for the other.`
        );
        expect(
            expectCode(
                () => modify(engine, { id: first.article.id, title: 'Renamed', expects: [{ id: first.article.id, rev: 0 }] }),
                'EKNOWLEDGE_INPUT'
            ).message
        ).toBe(
            `knowledge "modify" "expects" item 0 "rev" is 0, which is not a revision the engine ever mints; pass the "rev" the last read reported.`
        );
        expect(
            expectCode(
                () =>
                    modify(engine, {
                        id: first.article.id,
                        title: 'Renamed',
                        expects: [
                            { id: first.article.id, rev: 1 },
                            { id: first.article.id, rev: 2 }
                        ]
                    }),
                'EKNOWLEDGE_ID'
            ).message
        ).toBe(
            `knowledge "modify" "expects" gives article "${first.article.id}" two different tokens (1 and 2); pass one token per article.`
        );
        expect(
            expectCode(
                () => modify(engine, { id: first.article.id, title: 'Renamed', expects: [{ id: first.article.id }] }),
                'EKNOWLEDGE_INPUT'
            ).message
        ).toBe(
            `knowledge "modify" "expects" item 0 "rev" is undefined, which is not a revision the engine ever mints; pass the "rev" the last read reported.`
        );

        // The same token twice is one token, not a conflict.
        expect(
            modify(engine, {
                id: first.article.id,
                title: 'Renamed',
                expects: [
                    { id: first.article.id, rev: 1 },
                    { id: first.article.id, rev: 1 }
                ]
            }).article.rev
        ).toBe(2);
    });

    it('checks the token before it parses the edit, so a stale caller gets the payload first', () => {
        const { engine } = seedModifyFixture();

        modify(engine, { id: DOCUMENT_MODIFY_ID, title: 'Renamed' });

        // A call that is stale AND over-long answers with the conflict, because the payload of
        // the conflict is what the caller needs for its next call.
        expectCode(
            () =>
                modify(engine, {
                    id: DOCUMENT_MODIFY_ID,
                    title: 'x'.repeat(201),
                    expects: [{ id: DOCUMENT_MODIFY_ID, rev: 1 }]
                }),
            'EKNOWLEDGE_REV'
        );
    });

    it('guards a remove with the same token, and leaves the article when it refuses', () => {
        const { engine } = seedModifyFixture();

        modify(engine, { id: DOCUMENT_MODIFY_ID, title: 'Renamed' });

        expectCode(
            () => remove(engine, { id: DOCUMENT_MODIFY_ID, expects: [{ id: DOCUMENT_MODIFY_ID, rev: 1 }] }),
            'EKNOWLEDGE_REV'
        );

        expect(read(engine, { id: DOCUMENT_MODIFY_ID }).rev).toBe(2);

        const removed = remove(engine, { id: DOCUMENT_MODIFY_ID, expects: [{ id: DOCUMENT_MODIFY_ID, rev: 2 }] });

        expect(removed.removed.paragraphCount).toBe(3);
    });
});
// ---------------------------------------------------------------------------
// remove — the unit of persistence goes, the links into it stay
// ---------------------------------------------------------------------------

describe('knowledge engine — remove', () => {
    it('answers with the deleted article as a summary and every reference the removal just broke', () => {
        const rig = makeRig();
        // quoted   → paragraphs idAt(1), idAt(2); article idAt(3); stamp stampAt(0)
        // linking  → paragraphs idAt(4), idAt(5); article idAt(6); stamp stampAt(1)
        const quoted = create(rig.engine, { title: 'Quoted', content: ['A paragraph worth quoting.', 'Another.'] });
        const linking = create(rig.engine, {
            title: 'Linking',
            content: [
                { text: 'Quotes a paragraph.', refs: [{ articleId: quoted.article.id, paragraphId: quoted.article.content[0].id }] },
                { text: 'Quotes the whole article.', refs: [{ articleId: quoted.article.id }] }
            ]
        });

        const removed = remove(rig.engine, { id: quoted.article.id });

        expect(removed.removed).toStrictEqual({
            id: idAt(3),
            title: 'Quoted',
            tags: [],
            createdAt: stampAt(0),
            updatedAt: stampAt(0),
            rev: 1,
            paragraphCount: 2
        });
        // One entry per missing TARGET, deduped and sorted: the paragraph-level link reports the
        // PARAGRAPH id, the whole-article link reports the ARTICLE id.
        expect(removed.danglingRefs).toStrictEqual([idAt(1), idAt(3)]);
        // The report reaches past the article the caller named: the broken links are in another
        // article entirely.
        expect(read(rig.engine, { id: linking.article.id }).danglingRefs).toStrictEqual([idAt(1), idAt(3)]);
        // And the stored links are exactly what they were. A cascade would bump a `rev` nobody
        // edited and delete the evidence that the link existed.
        expect(read(rig.engine, { id: linking.article.id }).paragraphs?.[0].refs).toStrictEqual([
            { articleId: idAt(3), paragraphId: idAt(1) }
        ]);

        // Removing the article that HELD the links takes its outgoing references with it, so the
        // store is clean again rather than haunted.
        const second = remove(rig.engine, { id: linking.article.id });

        expect(second.danglingRefs).toStrictEqual([]);
        expect(second.removed.paragraphCount).toBe(2);
    });

    it('refuses a second removal of the same article', () => {
        const rig = makeRig();
        const gone = createArticle(rig.engine, 'Gone', 'One paragraph.');

        remove(rig.engine, { id: gone.article.id });

        expect(
            expectCode(() => remove(rig.engine, { id: gone.article.id }), 'EKNOWLEDGE_NOT_FOUND').details
        ).toStrictEqual({ id: gone.article.id });
        expect(expectCode(() => read(rig.engine, { id: gone.article.id }), 'EKNOWLEDGE_NOT_FOUND').details).toStrictEqual({
            id: gone.article.id
        });
        expect(rig.engine.articles()).toStrictEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The store feed — one notification per COMMITTED operation
// ---------------------------------------------------------------------------

describe('knowledge engine — the store feed', () => {
    it('announces every committed change with the watermark, the reason and the ids that moved', () => {
        const rig = makeRig();
        const feed = recordFeed(rig.engine);

        createArticle(rig.engine, 'A', 'One.');
        modify(rig.engine, { id: idAt(2), title: 'A, renamed' });
        createArticle(rig.engine, 'B', 'Two.');
        remove(rig.engine, { id: idAt(4) });
        rig.engine.reset();

        expect(feed).toStrictEqual([
            { storeRev: 1, reason: 'create', affectedArticles: [idAt(2)], removedArticles: [] },
            { storeRev: 2, reason: 'modify', affectedArticles: [idAt(2)], removedArticles: [] },
            { storeRev: 3, reason: 'create', affectedArticles: [idAt(4)], removedArticles: [] },
            // A removal names the id under `removedArticles`: the file layer DELETES that file
            // rather than rewriting it empty.
            { storeRev: 4, reason: 'remove', affectedArticles: [], removedArticles: [idAt(4)] },
            // `reset` is the whole store going, with the watermark back at 0.
            { storeRev: 0, reason: 'reset', affectedArticles: [], removedArticles: [idAt(2)] }
        ]);
    });

    it('says nothing for a call that changed nothing, and nothing for a call that refused', () => {
        const rig = makeRig();
        const feed = recordFeed(rig.engine);

        createArticle(rig.engine, 'A', 'One.');
        modify(rig.engine, { id: idAt(2), title: ' A ' });
        expectCode(() => modify(rig.engine, { id: MISSING_ID, title: 'Ghost' }), 'EKNOWLEDGE_NOT_FOUND');
        expectCode(() => create(rig.engine, { title: 'x'.repeat(201), content: ['Body.'] }), 'EKNOWLEDGE_LIMIT');
        expectCode(() => remove(rig.engine, { id: MISSING_ID }), 'EKNOWLEDGE_NOT_FOUND');

        expect(feed).toStrictEqual([
            { storeRev: 1, reason: 'create', affectedArticles: [idAt(2)], removedArticles: [] }
        ]);
        expect(rig.engine.snapshot().storeRev).toBe(1);
    });

    it('unsubscribes cleanly, and a listener that throws cannot starve the live ones', () => {
        const rig = makeRig();
        const dead: KnowledgeStoreNotification[] = [];
        const alive: KnowledgeStoreNotification[] = [];

        // Registered first on purpose: a throwing listener must not stop the fan-out.
        const offDead = rig.engine.onStoreChange(() => {
            dead.push({ storeRev: -1, reason: 'reset', affectedArticles: [], removedArticles: [] });
            throw new Error('the persistence layer is down');
        });
        rig.engine.onStoreChange((notification) => alive.push(notification));

        createArticle(rig.engine, 'A', 'One.');
        expect(dead.length).toBe(1);
        expect(alive.length).toBe(1);

        // The write committed anyway: a dead persistence layer does not fail a tool call.
        expect(rig.engine.articles().length).toBe(1);

        offDead();
        createArticle(rig.engine, 'B', 'Two.');

        expect(dead.length).toBe(1);
        expect(alive.length).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// snapshot / restore / reset — the persistence seam
// ---------------------------------------------------------------------------

describe('knowledge engine — snapshot, restore and reset', () => {
    it('snapshots the whole store in creation order, with the watermark it carries', () => {
        const rig = makeRig();

        createArticle(rig.engine, 'A', 'One.');
        modify(rig.engine, { id: idAt(2), title: 'A, renamed' });
        createArticle(rig.engine, 'B', 'Two.');

        // Creation order, not page order: this is the order a resumed session pages in before
        // any ranking is applied.
        expect(rig.engine.snapshot()).toStrictEqual({
            storeRev: 3,
            articles: [
                {
                    id: idAt(2),
                    title: 'A, renamed',
                    createdAt: stampAt(0),
                    updatedAt: stampAt(1),
                    tags: [],
                    content: [
                        {
                            id: idAt(1),
                            text: 'One.',
                            rev: 1,
                            createdAt: stampAt(0),
                            updatedAt: stampAt(0)
                        }
                    ],
                    rev: 2
                },
                {
                    id: idAt(4),
                    title: 'B',
                    createdAt: stampAt(2),
                    updatedAt: stampAt(2),
                    tags: [],
                    content: [
                        {
                            id: idAt(3),
                            text: 'Two.',
                            rev: 1,
                            createdAt: stampAt(2),
                            updatedAt: stampAt(2)
                        }
                    ],
                    rev: 1
                }
            ]
        });
    });

    it('hands out a detached snapshot and survives a round trip through another engine', () => {
        const rig = makeRig();
        // The link points at the article itself, which the create validates against the draft,
        // so the stored shape carries a reference the round trip must preserve exactly.
        create(rig.engine, { title: 'Round', content: [{ text: 'Body.', tags: ['tag'], refs: [{ articleId: idAt(2) }] }] });
        const state = rig.engine.snapshot();

        state.articles[0].content[0].text = 'Mutated after the snapshot.';
        state.storeRev = 99;

        expect(rig.engine.snapshot()).toStrictEqual({
            storeRev: 1,
            articles: [
                {
                    id: idAt(2),
                    title: 'Round',
                    createdAt: stampAt(0),
                    updatedAt: stampAt(0),
                    tags: [],
                    content: [
                        {
                            id: idAt(1),
                            text: 'Body.',
                            rev: 1,
                            createdAt: stampAt(0),
                            updatedAt: stampAt(0),
                            tags: ['tag'],
                            refs: [{ articleId: idAt(2) }]
                        }
                    ],
                    rev: 1
                }
            ]
        });

        // The clean state, restored into a fresh engine, answers with the same value it came in
        // with — byte for byte, including the dangling reference and the dates.
        const clean = rig.engine.snapshot();
        const resumed = createKnowledgeEngine({ ids: makeIdSource(500), now: () => 0 });

        resumed.restore(clean);

        expect(resumed.snapshot()).toStrictEqual(clean);
        expect(JSON.stringify(resumed.snapshot())).toBe(JSON.stringify(clean));
    });

    it('restores stored dates verbatim and ids canonicalized to lowercase', () => {
        const engine = createKnowledgeEngine();
        const state = {
            storeRev: 42,
            articles: [
                {
                    id: '00000000-0000-0000-0000-0000000000AB',
                    title: 'Old file',
                    createdAt: '1970-01-01T00:00:00Z',
                    updatedAt: '2026-11-18T12:00:00.000+00:00',
                    tags: ['legacy'],
                    content: [
                        {
                            id: '00000000-0000-0000-0000-0000000000cd',
                            text: 'Stored body.',
                            rev: 7,
                            createdAt: '1970-01-01T00:00:00Z',
                            updatedAt: '2026-11-18T12:00:00.000+00:00'
                        }
                    ],
                    rev: 7
                }
            ]
        };

        engine.restore(state);

        // A normalized date would make a restored snapshot differ from the file that was saved,
        // so the file layer would rewrite every file on the next flush.
        expect(engine.snapshot().articles[0].createdAt).toBe('1970-01-01T00:00:00Z');
        expect(engine.snapshot().articles[0].updatedAt).toBe('2026-11-18T12:00:00.000+00:00');
        // Ids are the one thing that IS canonicalized, so a case-insensitive store cannot hold
        // two rows that differ only by case.
        expect(engine.snapshot().articles[0].id).toBe('00000000-0000-0000-0000-0000000000ab');
        expect(read(engine, { id: '00000000-0000-0000-0000-0000000000AB' }).rev).toBe(7);
        // The watermark comes FROM the restored state: a resumed engine must not read as behind
        // the files it just loaded.
        expect(engine.snapshot().storeRev).toBe(42);

        modify(engine, { id: '00000000-0000-0000-0000-0000000000ab', title: 'Renamed after resume' });

        expect(engine.snapshot().storeRev).toBe(43);
    });

    it('announces a restore as the whole store it replaces, naming the ids that fell out', () => {
        const rig = makeRig();
        const feed = recordFeed(rig.engine);
        createArticle(rig.engine, 'Keep', 'One.');
        createArticle(rig.engine, 'Drop', 'Two.');

        const restored = {
            storeRev: 9,
            articles: [
                {
                    id: idAt(2),
                    title: 'Keep',
                    createdAt: stampAt(0),
                    updatedAt: stampAt(0),
                    tags: [],
                    content: [
                        { id: idAt(1), text: 'One.', rev: 1, createdAt: stampAt(0), updatedAt: stampAt(0) }
                    ],
                    rev: 1
                }
            ]
        };

        rig.engine.restore(restored);

        expect(feed[feed.length - 1]).toStrictEqual({
            storeRev: 9,
            reason: 'restore',
            affectedArticles: [idAt(2)],
            removedArticles: [idAt(4)]
        });
        expect(rig.engine.articles().map((row) => row.id)).toStrictEqual([idAt(2)]);
    });

    it('accepts a stored reference that points nowhere, because that is the aftermath of a removal', () => {
        const engine = createKnowledgeEngine();

        engine.restore({
            storeRev: 3,
            articles: [
                {
                    id: idAt(20),
                    title: 'Holds a dead link',
                    createdAt: stampAt(0),
                    updatedAt: stampAt(0),
                    tags: [],
                    content: [
                        {
                            id: idAt(21),
                            text: 'Quotes a removed article.',
                            rev: 1,
                            createdAt: stampAt(0),
                            updatedAt: stampAt(0),
                            refs: [{ articleId: MISSING_ID }]
                        }
                    ],
                    rev: 1
                }
            ]
        });

        const after = read(engine, { id: idAt(20) });

        expect(after.danglingRefs).toStrictEqual([MISSING_ID]);
        expect(after.paragraphs?.[0].refs).toStrictEqual([{ articleId: MISSING_ID }]);
    });

    it('refuses a malformed state with the shared file wording, and leaves the live store alone', () => {
        const article = (overrides: Record<string, unknown> = {}) => ({
            id: idAt(2),
            title: 'Stored',
            createdAt: stampAt(0),
            updatedAt: stampAt(0),
            tags: [],
            content: [{ id: idAt(1), text: 'Body.', rev: 1, createdAt: stampAt(0), updatedAt: stampAt(0) }],
            rev: 1,
            ...overrides
        });

        expectMessage(() => readKnowledgeStoreState(null), 'knowledge state must be a JSON object.');
        expectMessage(() => readKnowledgeStoreState([1]), 'knowledge state must be a JSON object.');
        expectMessage(
            () => readKnowledgeStoreState({ storeRev: 0, articles: [], extra: true }),
            'knowledge state has an unknown field "extra".'
        );
        expectMessage(() => readKnowledgeStoreState({ articles: [] }), 'knowledge state is missing the field "storeRev".');
        expectMessage(() => readKnowledgeStoreState({ storeRev: 0, articles: {} }), 'knowledge state.articles must be an array.');
        expectMessage(
            () => readKnowledgeStoreState({ storeRev: 1.5, articles: [] }),
            'knowledge state.storeRev must be a safe integer.'
        );
        expectMessage(
            () => readKnowledgeStoreState({ storeRev: 0, articles: [article({ extra: 1 })] }),
            'knowledge state.articles[0] has an unknown field "extra".'
        );
        expectMessage(
            () => readKnowledgeStoreState({ storeRev: 0, articles: [article({ rev: 0 })] }),
            'knowledge state.articles[0].rev must be between 1 and 9007199254740991.'
        );
        expectMessage(
            () => readKnowledgeStoreState({ storeRev: 0, articles: [article({ content: [{ id: idAt(1), text: 'Body.', rev: 1, createdAt: stampAt(0), updatedAt: stampAt(0), extra: 1 }] })] }),
            'knowledge state.articles[0].content[0] has an unknown field "extra".'
        );
        expect(
            expectCode(() => readKnowledgeStoreState({ storeRev: 0, articles: [article({ id: '2' })] }), 'EKNOWLEDGE_ID')
                .message
        ).toBe(
            `knowledge state.articles[0].id is "2", which is not a uuid; every knowledge id is uuid v4 text the engine minted.`
        );
        expect(
            expectCode(() => readKnowledgeStoreState({ storeRev: 0, articles: [article({ createdAt: 'yesterday' })] }), 'EKNOWLEDGE_INPUT')
                .message
        ).toBe(
            'knowledge state.articles[0].createdAt is "yesterday", which is not an ISO-8601 timestamp; the engine writes dates as Date#toISOString() renders them.'
        );
        expect(
            expectCode(() => readKnowledgeStoreState({ storeRev: 0, articles: [article({ title: '   ' })] }), 'EKNOWLEDGE_INPUT')
                .message
        ).toBe('knowledge state.articles[0].title is blank; a knowledge article is found by its title.');
        expect(
            expectCode(
                () => readKnowledgeStoreState({ storeRev: 0, articles: [article({ content: [{ id: idAt(1), text: '   ', rev: 1, createdAt: stampAt(0), updatedAt: stampAt(0) }] })] }),
                'EKNOWLEDGE_INPUT'
            ).message
        ).toBe(
            `knowledge state.articles[0].content[0].text is blank; article "${idAt(2)}" should not carry an empty paragraph, so drop it.`
        );
        // One paragraph id shared by two articles is the failure `refs` cannot survive: every
        // target would become ambiguous.
        expect(
            expectCode(
                () =>
                    readKnowledgeStoreState({
                        storeRev: 0,
                        articles: [
                            article(),
                            { ...article(), id: idAt(4), content: [{ id: idAt(1), text: 'Same id.', rev: 1, createdAt: stampAt(0), updatedAt: stampAt(0) }] }
                        ]
                    }),
                'EKNOWLEDGE_ID'
            ).message
        ).toBe(
            `knowledge state.articles[1].content[0].id repeats the id "${idAt(1)}", which this state already uses; ids are unique across the whole store, so one paragraph may not share an id with another.`
        );
        expect(
            expectCode(
                () =>
                    readKnowledgeStoreState({
                        storeRev: 0,
                        articles: [article(), { ...article(), id: idAt(2) }]
                    }),
                'EKNOWLEDGE_ID'
            ).message
        ).toBe(
            `knowledge state.articles[1].id repeats the id "${idAt(2)}", which this state already uses; ids are unique across the whole store, so one paragraph may not share an id with another.`
        );
        expect(
            expectCode(
                () => readKnowledgeStoreState({ storeRev: 0, articles: Array.from({ length: 101 }, (_, index) => ({ ...article(), id: idAt(100 + index) })) }),
                'EKNOWLEDGE_LIMIT'
            ).message
        ).toBe(
            'knowledge state.articles holds 101 articles, over the KNOWLEDGE_MAX_ARTICLES limit of 100; remove an article before restoring.'
        );

        // A rejected restore is validate-then-swap, not a partial import.
        const rig = makeRig();
        const feed = recordFeed(rig.engine);
        createArticle(rig.engine, 'Live', 'Still here.');
        const before = clone(rig.engine.snapshot());

        expectCode(() => rig.engine.restore({ storeRev: 0, articles: [article({ id: '2' })] }), 'EKNOWLEDGE_ID');

        expect(rig.engine.snapshot()).toStrictEqual(before);
        expect(feed.length).toBe(1);
        expect(read(rig.engine, { id: idAt(2) }).title).toBe('Live');
    });

    it('treats a restored id as taken, so a resumed engine cannot mint a collision', () => {
        const engine = createKnowledgeEngine({ ids: makeIdSource(1), now: () => 0 });

        engine.restore({
            storeRev: 1,
            articles: [
                {
                    id: idAt(2),
                    title: 'Restored',
                    createdAt: stampAt(0),
                    updatedAt: stampAt(0),
                    tags: [],
                    content: [{ id: idAt(1), text: 'Body.', rev: 1, createdAt: stampAt(0), updatedAt: stampAt(0) }],
                    rev: 1
                }
            ]
        });

        // The id source starts over at idAt(1), which the restored store already holds.
        expect(
            expectCode(
                () => modify(engine, { id: idAt(2), addContent: ['Another paragraph.'] }),
                'EKNOWLEDGE_ID'
            ).message
        ).toBe(
            `knowledge "modify" "addContent" item 0 assigned paragraph id "${idAt(1)}", which the store already uses. Pass an "ids" that returns fresh uuids, or omit it and use crypto.randomUUID().`
        );

        expect(
            modify(engine, { id: idAt(2), addContent: [{ id: idAt(7), text: 'A free id.' }] }).article.content.map(
                (paragraph) => paragraph.id
            )
        ).toStrictEqual([idAt(1), idAt(7)]);
    });

    it('resets to a clean store with the watermark at zero', () => {
        const rig = makeRig();
        createArticle(rig.engine, 'A', 'One.');
        createArticle(rig.engine, 'B', 'Two.');

        rig.engine.reset();

        expect(rig.engine.snapshot()).toStrictEqual({ storeRev: 0, articles: [] });
        expect(rig.engine.articles()).toStrictEqual([]);
        expect(list(rig.engine).counts.total).toBe(0);
        expectCode(() => read(rig.engine, { id: idAt(2) }), 'EKNOWLEDGE_NOT_FOUND');

        // And the seams keep working: the next create is a normal create.
        const after = createArticle(rig.engine, 'C', 'Three.');

        expect(rig.engine.snapshot()).toStrictEqual({
            storeRev: 1,
            articles: [
                {
                    id: idAt(6),
                    title: 'C',
                    createdAt: stampAt(2),
                    updatedAt: stampAt(2),
                    tags: [],
                    content: [
                        { id: idAt(5), text: 'Three.', rev: 1, createdAt: stampAt(2), updatedAt: stampAt(2) }
                    ],
                    rev: 1
                }
            ]
        });
        expect(after.article.id).toBe(idAt(6));
    });
});

// ---------------------------------------------------------------------------
// The read response budget
// ---------------------------------------------------------------------------

describe('knowledge engine — the read response budget', () => {
    it('keeps a prefix of the paragraphs and flags that its own cap did the cutting', () => {
        // READ_KEEP is the largest number of 1200-character paragraphs whose serialized read
        // fits KNOWLEDGE_RESPONSE_BUDGET_BYTES. It is pinned as a number only because the two
        // neighbours below prove it is the boundary: that many rows is not a budget cut at all,
        // and one row more is cut back to exactly the same rows.
        const READ_KEEP = 17;
        const rig = makeRig();
        const big = create(rig.engine, {
            title: 'Long document',
            content: Array.from({ length: 20 }, () => 'x'.repeat(1_200))
        });

        const full = read(rig.engine, { id: big.article.id });

        expect(full.paragraphs?.length).toBe(READ_KEEP);
        expect({
            from: full.from,
            limit: full.limit,
            totalParagraphs: full.totalParagraphs,
            truncated: full.truncated,
            budgetTruncated: full.budgetTruncated
        }).toStrictEqual({
            from: 0,
            limit: READ_KEEP,
            totalParagraphs: 20,
            truncated: true,
            budgetTruncated: true
        });
        // `limit` in a READ response is the number of rows it carries, so `from + limit` is
        // where a paging loop resumes — not the limit the caller asked for.
        expect(full.paragraphs?.map((paragraph) => paragraph.id)).toStrictEqual(
            big.createdIds.slice(0, READ_KEEP)
        );

        const fits = read(rig.engine, { id: big.article.id, limit: READ_KEEP });

        expect(fits.paragraphs?.length).toBe(READ_KEEP);
        expect(fits.budgetTruncated).toBeUndefined();
        expect(fits.paragraphs).toStrictEqual(full.paragraphs);

        const cut = read(rig.engine, { id: big.article.id, limit: READ_KEEP + 1 });

        expect(cut.paragraphs).toStrictEqual(fits.paragraphs);
        expect(cut.budgetTruncated).toBe(true);
        expect({ from: cut.from, limit: cut.limit, totalParagraphs: cut.totalParagraphs, truncated: cut.truncated }).toStrictEqual({
            from: 0,
            limit: READ_KEEP,
            totalParagraphs: 20,
            truncated: true
        });

        // The cheap projection is not budget-bound at this size: asking for the outline is how a
        // caller reads a document this long whole.
        const outlined = read(rig.engine, { id: big.article.id, outline: true });

        expect(outlined.outline?.length).toBe(20);
        expect(outlined.budgetTruncated).toBeUndefined();
        expect(outlined.truncated).toBeUndefined();
        expect(outlined.paragraphCount).toBe(20);

        // And the window a budget cut points at is exactly the next rows.
        const rest = read(rig.engine, { id: big.article.id, from: READ_KEEP });

        expect(rest.paragraphs?.map((paragraph) => paragraph.id)).toStrictEqual(big.createdIds.slice(READ_KEEP));
        expect(rest.truncated).toBe(true);
        expect(rest.budgetTruncated).toBeUndefined();
    });
});
// ---END---

