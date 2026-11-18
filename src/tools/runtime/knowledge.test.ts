/**
 * `knowledge.tool.ts` — the model-facing entry contract (T6).
 *
 * What this file pins, and why each pin exists:
 *
 * 1. THE WIRE CONTRACT. `metadata` is read through the TypeScript AST and shipped VERBATIM into
 *    the generated catalogue (`src/core/tool-scan.ts` → `src/core/tool-manifest.ts`), so the
 *    description, the tags, the visibility, the schema and the registration row are all asserted
 *    as data — the same way `threadDelete.test.ts:92-129` pins that pair. The bounds in the schema
 *    are restated against the ENGINE's own constants (`src/core/knowledge.ts:148-219`), because a
 *    schema that quietly disagrees with the store is a schema that teaches the model to write a
 *    call the store refuses.
 * 2. THE ARGUMENT BOX. `metadata.parameters` declares exactly ONE object-valued property, so the
 *    executor hands `execute` the UNWRAPPED operation (`toolParameterKey`, src/core/tool.ts:65-73;
 *    the model path reads `raw[key]`, src/core/schema-validation.ts:383-386; the direct path tries
 *    the unwrapped value first, :405-418). Both shapes are pinned at the engine boundary, plus the
 *    degenerate ones (`undefined`, `{}`, a string, an array), which the entry answers with a
 *    listing instead of a crash.
 * 3. THE SEAM. `Harness.knowledge` (T7) is the only way this entry reaches a store. Both usable
 *    shapes (`{ engine }` and a bare `KnowledgeEngine`) are pinned working; every unusable shape
 *    is pinned refusing, with a CODE (an uncoded TypeError never reaches the model as a code).
 * 4. THE PROJECTION. `content` is the engine result untouched, and the prose is a projection
 *    sized against the engine's own model budget in ESCAPED payload bytes
 *    (src/core/knowledge.ts:186-211, measured by src/core/payload-bytes.ts:72). Every projection
 *    string here is exact; the byte figures are exact; the cut note is exact.
 * 5. THE REFUSALS. An engine refusal travels UNCHANGED — code, message and `details` — because
 *    `details.article` is the payload the retry is built from (src/core/knowledge.ts:1304-1322).
 *
 * Determinism: every engine runs on `createKnowledgeEngine({ now, ids })`
 * (src/core/knowledge.ts:1330-1336) with a fixed clock and a counter, so the timestamps
 * (2023-11-14T22:13:20.000Z) and the ids are fixed. Mint order is PARAGRAPH-FIRST
 * (src/core/knowledge.ts:1535-1548): a 2-paragraph create takes …0001/…0002 and the article takes
 * …0003, which is why the ids below are written out rather than looked up.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    createKnowledgeEngine,
    KNOWLEDGE_LIST_DEFAULT_LIMIT,
    KNOWLEDGE_LIST_MAX_LIMIT,
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
    type KnowledgeEngine
} from '../../core/knowledge';
import { modelPayloadBytes } from '../../core/payload-bytes';
import { validateSchemaValue } from '../../core/schema-validation';
import { KNOWLEDGE_OPERATION_VERBS, type KnowledgeOperation, type ToolContext } from '../../types';
import {
    KNOWLEDGE_METADATA,
    KNOWLEDGE_NAME,
    execute,
    knowledge,
    metadata,
    registration
} from './knowledge.tool';

const SOURCE = readFileSync(fileURLToPath(new URL('./knowledge.tool.ts', import.meta.url)), 'utf8');
const MANIFEST = readFileSync(fileURLToPath(new URL('../../core/tool-manifest.ts', import.meta.url)), 'utf8');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The one clock every engine runs on, and the ISO string it renders.
const CLOCK = 1_700_000_000_000;
const STAMP = '2023-11-14T22:13:20.000Z';

// A fresh engine: the fixed clock, and an `ids` counter whose mint order is observable
// (`createKnowledgeEngine` calls it once per paragraph, then once for the article).
const engine = (): KnowledgeEngine => {
    let next = 0;

    return createKnowledgeEngine({
        now: () => CLOCK,
        ids: () => `7c9e6679-7425-40de-944b-e07fc1f90${String(++next).padStart(3, '0')}`
    });
};

// The three-article store most scenarios read. Ids: Alpha …0002 (paragraph …0001), Beta …0004
// (paragraph …0003, tag `costs`), Gamma …0006 (paragraph …0005, body mentions alpha).
const articles = (): KnowledgeEngine => {
    const store = engine();

    for (const operation of [
        { verb: 'create', title: 'Alpha Primer', content: ['Alpha is the first letter.'] },
        { verb: 'create', title: 'Beta Primer', tags: ['costs'], content: ['Beta is the second letter.'] },
        { verb: 'create', title: 'Gamma Notes', content: ['Gamma mentions alpha casually.'] }
    ] as KnowledgeOperation[]) {
        store.execute(operation);
    }

    return store;
};

// A stub engine: records what the ENTRY handed it, and answers with a fixed payload. Used where
// the scenario is about the entry (argument routing, the projection cut), not about the store.
const stubEngine = (result: unknown, seen?: unknown[]) => ({
    name: 'stub',
    execute: (operation: KnowledgeOperation) => {
        if (seen !== undefined) seen.push(operation);

        return result as never;
    }
});

// A context carries only what this entry reads (`context.harness?.knowledge`).
const context = (parameters: unknown, seam?: unknown): ToolContext =>
    ({
        name: KNOWLEDGE_NAME,
        parameters,
        ...(seam === undefined ? {} : { harness: { knowledge: seam } })
    }) as unknown as ToolContext;

// Runs the entry and hands back the branded envelope plus both views of it: `content` (the engine
// result, which must arrive untouched) and `projection` (the parsed prose), and the two byte
// figures measured in the currency the budget is stated in — escaped payload BYTES, the figure the
// model pays (`__toolText` is a JSON string inside the serialized envelope, hence the re-encode).
const call = (parameters: unknown, seam: unknown) => {
    const envelope = execute(context(parameters, seam));

    return {
        envelope,
        content: JSON.parse(JSON.stringify(envelope.content)) as Record<string, unknown>,
        projection: JSON.parse(envelope.__toolText) as Record<string, unknown>,
        proseBytes: modelPayloadBytes(JSON.stringify(envelope.__toolText)),
        contentBytes: modelPayloadBytes(JSON.stringify(envelope.content))
    };
};

// Captures a refusal as data, because the refusal OBJECT is the contract.
const refusal = (parameters: unknown, seam: unknown) => {
    try {
        call(parameters, seam);
    } catch (error) {
        const { code, message, details } = error as never as { code?: string; message?: string; details?: unknown };

        return { code, message, details };
    }

    return { thrown: false as const };
};

// A store with the three articles, for the refusal scenarios that need one.
const refusing = (operation: unknown) => refusal(operation, articles());

// ---------------------------------------------------------------------------
// The source contract: what the AST reader actually sees
// ---------------------------------------------------------------------------

describe('knowledge entry — source contract', () => {
    it('names itself once, as a literal the scanner can resolve', () => {
        // `KNOWLEDGE_METADATA.name` is the literal the AST reads; `KNOWLEDGE_NAME` is the host-side
        // alias (the `*_NAME` pattern of every runtime entry). Exactly one definition of each, or
        // the wire name becomes ambiguous (src/core/tool-scan.ts:567-597 takes the FIRST one).
        expect(KNOWLEDGE_NAME).toBe('knowledge');
        expect(KNOWLEDGE_METADATA.name).toBe(KNOWLEDGE_NAME);
        expect(SOURCE.match(/export const KNOWLEDGE_NAME = /g)).toHaveLength(1);
        // The manifest keys this entry by that label.
        expect(MANIFEST).toContain('case "tools/runtime/knowledge.tool.ts":');
    });

    it('keeps `metadata` and `registration` pure literals, so reading them needs no import', () => {
        // `metadata` is the alias the discovery reader follows, and it must resolve to the SAME
        // object (src/core/tool-discovery.ts, and the idiom at threadDelete.tool.ts:256-259).
        expect(metadata).toBe(KNOWLEDGE_METADATA);

        const blocks = [
            SOURCE.match(/export const KNOWLEDGE_METADATA[^=]* = \{[\s\S]*?\n\};/),
            SOURCE.match(/export const registration = \{[\s\S]*?\n\};/)
        ].map((match) => match?.[0] ?? '');

        // No interpolation, no identifier values: the AST reader accepts literals, plain objects and
        // arrays ONLY (src/core/tool-scan.ts:501-541), and a template or an imported constant would
        // read as `undefined` and ship an empty field in the catalogue.
        for (const block of blocks) {
            expect(block).not.toBe('');
            expect(block).not.toContain('${');
            expect(block).not.toMatch(/^\s+[a-z]+: [A-Z][A-Za-z]*[,;\n]/m);
        }
    });

    it('imports only the live framework specifiers, so the source compiler can capture it', () => {
        // A `.tool.ts` entry is compiled against the LIVE framework namespace, whose specifiers are
        // the closed `LIVE_MODULE_KEYS` (src/core/tool-source.ts:504-523). `../../core` and
        // `../../util` are in it; a leaf `../../core/*` path would become a captured LOCAL
        // dependency the compiled artifact may not keep (src/core/tool-source.ts:1347-1465).
        expect(SOURCE.split('\n').filter((line) => line.startsWith('import '))).toEqual([
            "import { modelPayloadBytes, tool, toolText } from '../../core';",
            "import type { CoreToolMetadata } from '../../core';",
            "import { HarnessError } from '../../util';",
            'import type {'
        ]);

        // `KNOWLEDGE_RESPONSE_BUDGET_BYTES` is an ENGINE constant the live core namespace does not
        // re-export (src/core/tool-source.ts:463-499), so the projection cap is a local literal —
        // pinned against the engine below, which is what turns drift into a failing assertion.
        expect(SOURCE).toContain('KNOWLEDGE_PROJECTION_BUDGET_BYTES = 24 * 1024');
        expect(SOURCE).not.toMatch(/import[^;]*KNOWLEDGE_RESPONSE_BUDGET_BYTES[^;]*from/);
    });

    it('stays synchronous, because the engine never awaits', () => {
        // `KnowledgeEngine.execute` is sync (the file layer is a SUBSCRIBER, src/types/index.ts), and
        // the entry declares no `mode`, so the harness applies DEFAULT_TOOL_MODE 'sync'
        // (src/core/tool.ts:85). An `async` body would hand the sync runner a promise.
        expect(SOURCE).not.toMatch(/^\s*(async|await)\b/m);
        expect('mode' in knowledge).toBe(false);
        expect(registration).not.toHaveProperty('mode');
    });

    it('uses no schema keyword the validator ignores', () => {
        // The validator's vocabulary is `type`/`enum`/bounds/`items`/`required`/
        // `additionalProperties:false`; `if`, `then` and `allOf` are parsed and DISCARDED
        // (src/core/schema-validation.ts:122,200,221), so a rule written in them would be enforced
        // by nobody while looking enforced.
        for (const keyword of ['"if"', '"then"', '"allOf"', '"not"']) {
            expect(SOURCE.includes(keyword)).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// The metadata the model reads
// ---------------------------------------------------------------------------

describe('knowledge metadata', () => {
    it('carries the discovery fields and nothing else', () => {
        expect(KNOWLEDGE_METADATA.name).toBe('knowledge');
        expect(KNOWLEDGE_METADATA.visibility).toBe('searchable');
        expect(KNOWLEDGE_METADATA.tags).toEqual([
            'knowledge',
            'article',
            'articles',
            'search',
            'read',
            'edit',
            'reference'
        ]);
        // Harness bookkeeping (`group`, `order`, …) must never reach the model-facing contract.
        expect(Object.keys(KNOWLEDGE_METADATA).sort()).toEqual([
            'description',
            'name',
            'parameters',
            'tags',
            'visibility'
        ]);
    });

    it('publishes one object-valued property, closed and NOT required', () => {
        // ONE object-valued property is what makes the executor unwrap it; `operation` is
        // deliberately optional, because the empty argument box `{}` is a meaningful call
        // (list the newest articles).
        expect(KNOWLEDGE_METADATA.parameters).toEqual({
            type: 'object',
            properties: {
                operation: expect.objectContaining({
                    type: 'object',
                    additionalProperties: false
                })
            },
            additionalProperties: false
        });
        expect(KNOWLEDGE_METADATA.parameters).not.toHaveProperty('required');
        expect(operationSchema()).not.toHaveProperty('required');
    });

    it('lists the six verbs the engine routes, in the engine order', () => {
        // `KNOWLEDGE_OPERATION_VERBS` is the same list the refusal sentence is built from
        // (src/core/knowledge.ts:345), so a new verb must show up in the schema in the same step.
        expect(operationSchema().properties!.verb).toEqual({
            type: 'string',
            enum: [...KNOWLEDGE_OPERATION_VERBS],
            description: expect.any(String)
        });
        expect(KNOWLEDGE_OPERATION_VERBS).toEqual(['list', 'search', 'read', 'create', 'modify', 'remove']);
    });

    it('declares the union of the six verbs fields, and nothing outside it', () => {
        // The engine refuses a key that belongs to ANOTHER verb by name
        // (`"search" has no field "from"`), so a flat union schema costs nothing in clarity and
        // buys one schema instead of a oneOf the validator cannot evaluate per-verb anyway.
        expect(Object.keys(operationSchema().properties!).sort()).toEqual([
            'addContent',
            'addTags',
            'content',
            'expects',
            'from',
            'id',
            'limit',
            'moveParagraphs',
            'offset',
            'outline',
            'paragraphs',
            'query',
            'removeParagraphs',
            'removeTags',
            'search',
            'setParagraphs',
            'tag',
            'tags',
            'title',
            'verb'
        ]);
    });

    it('closes every object level, including the oneOf arms', () => {
        // An unknown SIBLING must be caught here (the engine's own message names the accepted keys,
        // and it can only do that once the object reached it). `content`/`addContent` are
        // `oneOf: string | object`, so their arms need the same closure.
        const operation = operationSchema();

        expect(operation.additionalProperties).toBe(false);
        expect((operation.properties!.content as { items: { oneOf: { additionalProperties?: boolean }[] } }).items.oneOf[1].additionalProperties).toBe(false);
        expect((operation.properties!.addContent as { items: { oneOf: { additionalProperties?: boolean }[] } }).items.oneOf[1].additionalProperties).toBe(false);

        for (const key of ['setParagraphs', 'moveParagraphs', 'expects'] as const) {
            expect((operation.properties![key] as { items: { additionalProperties?: boolean } }).items.additionalProperties).toBe(false);
        }
        for (const key of ['content', 'addContent', 'setParagraphs'] as const) {
            const items = (operation.properties![key] as { items: { oneOf?: { properties?: { refs?: { items: { additionalProperties?: boolean } } } }[]; properties?: { refs?: { items: { additionalProperties?: boolean } } } } }).items;
            const refs = (items.oneOf?.[1]?.properties ?? items.properties)?.refs!;

            expect(refs.items.additionalProperties).toBe(false);
            expect(refs.items.required).toEqual(['articleId']);
        }
        expect((operation.properties!.setParagraphs as { items: { required: string[] } }).items.required).toEqual(['id']);
        expect((operation.properties!.moveParagraphs as { items: { required: string[] } }).items.required).toEqual(['id']);
        expect((operation.properties!.expects as { items: { required: string[] } }).items.required).toEqual(['id', 'rev']);
    });

    it('states the bounds the engine enforces, cited to the engine constants', () => {
        const properties = operationSchema().properties!;

        // Each figure is the engine's own constant. These assertions are the drift guard the schema
        // cannot express by itself: change one side and this test says which constant moved.
        expect(properties.title).toEqual(expect.objectContaining({ type: 'string', maxLength: KNOWLEDGE_MAX_TITLE }));
        // The search term is capped like a paragraph (KNOWLEDGE_MAX_TEXT, src/core/knowledge.ts:1906-1911),
        // because the failure mode it guards is a model pasting a document into `query`.
        expect(properties.query).toEqual(expect.objectContaining({ type: 'string', minLength: 1, maxLength: KNOWLEDGE_MAX_TEXT }));
        // The `tag` FILTER is checked by the engine's own tag reader — `readTags(label, 'tag', …)`
        // (src/core/knowledge.ts:1923 → :557-569) — so its ceiling is KNOWLEDGE_MAX_TAGS (16), the
        // SAME figure as create's `tags`. It used to be pinned to KNOWLEDGE_MAX_ITEMS (64), the
        // id-list bound, a different axis: 17 filter entries passed the schema and then met an
        // EKNOWLEDGE_LIMIT from the engine, which is the direction this schema may never go.
        expect(properties.tag).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_TAGS, items: { type: 'string', maxLength: KNOWLEDGE_MAX_TAG } }));
        expect(properties.tags).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_TAGS, items: { type: 'string', maxLength: KNOWLEDGE_MAX_TAG } }));
        // ONE `limit` property serves list, search AND read (OPERATION_KEYS,
        // src/core/knowledge.ts:316-334) and the validator has no `if`/`then`
        // (src/core/schema-validation.ts:122, :200, :221), so the single ceiling must be safe for
        // all three: the engine allows 1-100 on the page verbs (`readLimitArgument`, :467-478) but
        // only 1-64 on the read window (`readWindowLimitArgument`, :496-507), so 64 is the bound
        // that never out-promises the engine. The assertion below pins BOTH figures so a future
        // widening of the page bound cannot quietly make this schema too loose again.
        expect(properties.limit).toEqual(expect.objectContaining({ type: 'integer', minimum: 1, maximum: KNOWLEDGE_MAX_PARAGRAPHS }));
        // Both engine figures, exact: the read window (64) is what the schema carries, the page
        // bound (100) is what it deliberately gives up. Pinned as digits here so a drift on either
        // side names itself instead of silently making the shared ceiling too loose or too tight.
        expect(KNOWLEDGE_MAX_PARAGRAPHS).toBe(64);
        expect(KNOWLEDGE_LIST_MAX_LIMIT).toBe(100);
        expect(properties.offset).toEqual(expect.objectContaining({ type: 'integer', minimum: 0 }));
        // `from` is READ windowing (OPERATION_KEYS.read, src/core/knowledge.ts:319), not list paging, so
        // it carries no maximum here: the 50-row ceiling is about offset+limit on list/search, a relation
        // between two numbers the schema vocabulary cannot state (the engine refuses it as rank 47-56).
        expect(properties.from).toEqual(expect.objectContaining({ type: 'integer', minimum: 0 }));
        expect(properties.paragraphs).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_ITEMS, items: { type: 'string' } }));
        expect(properties.outline).toEqual(expect.objectContaining({ type: 'boolean' }));
        expect(properties.content).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_PARAGRAPHS }));
        expect(properties.addContent).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_PARAGRAPHS }));
        expect(properties.setParagraphs).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_ITEMS }));
        expect(properties.moveParagraphs).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_ITEMS }));
        expect(properties.removeParagraphs).toEqual(expect.objectContaining({ type: 'array', maxItems: KNOWLEDGE_MAX_ITEMS }));
        // THE ONE DELIBERATELY TIGHTER BOUND. The engine parses up to KNOWLEDGE_MAX_ITEMS (64)
        // tokens (`readExpects`, src/core/knowledge.ts:893-905), but a call writes ONE article: a
        // second token for the same id collapses (`:930-942`) and a token for another id is refused
        // by `checkExpects` (`:2020-2036`, called at `:2062`/`:2363`). So 1 is the whole
        // engine-honoured capability through one call — a multi-paragraph CAS is ONE article-grain
        // token here, not several — and the 64 below is pinned to prove the schema is tighter on
        // purpose rather than by accident.
        expect(properties.expects).toEqual(expect.objectContaining({ type: 'array', maxItems: 1 }));
        expect(KNOWLEDGE_MAX_ITEMS).toBe(64);
        expect((properties.content as { items: { oneOf: { properties?: { text?: { maxLength?: number }; refs?: { maxItems?: number } } }[] } }).items.oneOf[1].properties!.text!.maxLength).toBe(KNOWLEDGE_MAX_TEXT);
        expect((properties.setParagraphs as { items: { properties: { refs: { maxItems: number } } } }).items.properties.refs.maxItems).toBe(KNOWLEDGE_MAX_REFS);
        expect((properties.expects as { items: { properties: { rev: { minimum: number } } } }).items.properties.rev.minimum).toBe(1);

        // The constants themselves, so the comparison above cannot be satisfied by two edits that
        // move together. `KNOWLEDGE_MAX_QUERY` is not exported, so 500 is spelled twice on purpose:
        // the schema value and the literal here are the same figure the engine validates.
        expect(KNOWLEDGE_MAX_TITLE).toBe(200);
        expect(KNOWLEDGE_MAX_TEXT).toBe(4000);
        expect(KNOWLEDGE_MAX_NOTE).toBe(500);
        expect(KNOWLEDGE_MAX_TAGS).toBe(16);
        expect(KNOWLEDGE_MAX_TAG).toBe(64);
        expect(KNOWLEDGE_MAX_REFS).toBe(16);
        expect(KNOWLEDGE_MAX_ITEMS).toBe(64);
        expect(KNOWLEDGE_MAX_PARAGRAPHS).toBe(64);
        expect(KNOWLEDGE_MAX_SEARCH).toBe(50);
        expect(KNOWLEDGE_LIST_DEFAULT_LIMIT).toBe(20);
        expect(KNOWLEDGE_LIST_MAX_LIMIT).toBe(100);
    });

    it('teaches the drill-in workflow, because the description is the only place it is taught', () => {
        const { description } = KNOWLEDGE_METADATA;

        // One operation object, and the unwrapping promise the harness keeps.
        expect(description).toContain('Six verbs, ONE operation object per call, sent as { operation: { ... } }');
        expect(description).toContain("which the harness unwraps for you");
        // The workflow, in the order the model has to perform it.
        expect(description).toContain('DRILL IN, NEVER FLOOD. list and search answer with article METADATA ONLY');
        expect(description).toContain('Read the outline before you read text, and read text a window at a time');
        expect(description).toContain('the remedy is always list or search first');
        // The write guard, and what a stale token answers with.
        expect(description).toContain('WRITES NEED THE TOKEN');
        expect(description).toContain('ONE token, article grain');
        expect(description).toContain('A stale token is refused EKNOWLEDGE_REV and the refusal quotes the CURRENT rev and article');
        // The two rules a flat union schema cannot express.
        expect(description).toContain('the "search" KEY is a free-text filter and is NOT the search verb');
        expect(description).toContain('search needs a non-empty query');
        expect(description).toContain('matchedIn: "title"');
        // modify answers per KIND of change, which is the shape a caller branches on.
        expect(description).toContain('modify answers one key per KIND of change that happened (changedIds / noopIds / movedIds / createdIds / removedIds / articleFields) and noop: true when nothing moved');
        // The response cap, stated as the engine states it, including this tool's own note.
        expect(description).toContain('THE RESPONSE CAP CUTS, IT DOES NOT FAIL: 24576 bytes of what you pay for');
        expect(description).toContain('Ask for the next window (from/limit, offset)');
        // Every code the model can meet, with its remedy class.
        for (const code of ['EKNOWLEDGE_INPUT', 'EKNOWLEDGE_ID', 'EKNOWLEDGE_REV', 'EKNOWLEDGE_LIMIT', 'EKNOWLEDGE_REF', 'EKNOWLEDGE_NOT_FOUND']) {
            expect(description).toContain(code);
        }
    });

    it('restates the bounds in prose with the same figures the schema carries', () => {
        expect(KNOWLEDGE_METADATA.description).toContain('100 articles; 64 paragraphs per article; 4000 characters per paragraph; 200 per title; 500 per reference note; 16 tags per article or paragraph and at most 16 in a "tag" filter, at 64 characters each; 16 references per paragraph; 64 entries per list argument, and exactly 1 in expects (one call guards one article)');
        // The shared `limit` ceiling and the rank window, spelled the way the engine applies them:
        // ONE bound for THREE verbs (the schema has one property, src/core/schema-validation.ts:122),
        // and rank 50 on `search` ONLY (`checkSearchDepth`, src/core/knowledge.ts:1927) — the prose
        // used to promise "list/search … rank at most the first 50 rows", which over-promises on
        // the verb that has no rank ceiling.
        expect(KNOWLEDGE_METADATA.description).toContain('limit is 1-64 on EVERY verb, because one property serves list, search and read and the read window is the tightest (list/search default to 20); search ranks at most the first 50 rows (offset + limit <= 50) while list pages the whole store; read answers at most 64 paragraphs per call');
        // `remove.danglingRefs` is a store-wide survey (`danglingAcrossStore`,
        // src/core/knowledge.ts:1543-1548 → :2375), so the description says so rather than
        // implying the list is only what this removal broke.
        expect(KNOWLEDGE_METADATA.description).toContain("danglingRefs, and that list is the WHOLE store's unresolvable reference targets");
        expect(KNOWLEDGE_METADATA.description).toContain('not as a count of what this removal broke');
    });

    it('refuses an over-bound argument at the door, not late in the engine', () => {
        // `validateSchemaValue` runs BEFORE `execute` on the model path
        // (src/core/schema-validation.ts:122, reached through `resolveToolParameters` at :334), so a
        // number written in this schema is ENFORCED — and these are exactly the arguments that used
        // to walk through the door and then meet an engine `EKNOWLEDGE_LIMIT`: a 65-paragraph read
        // window (`readWindowLimitArgument`, src/core/knowledge.ts:496-507) and a 17th tag
        // (`readTags`, :557-569). Exact messages, because a schema that only LOOKS enforced is the
        // one failure this entry cannot see from its own code.
        const operation = operationSchema();
        const id = '7c9e6679-7425-40de-944b-e07fc1f90001';
        const tags = Array.from({ length: 16 }, (_, index) => `tag-${index}`);

        expect(validateSchemaValue(operation, { verb: 'read', id, limit: 65 })).toEqual({
            valid: false,
            message: '$.limit must be <= 64.'
        });
        // The boundary itself, so the ceiling cannot be quietly lowered to 63 or 32.
        expect(validateSchemaValue(operation, { verb: 'read', id, limit: 64 })).toEqual({ valid: true });
        expect(validateSchemaValue(operation, { verb: 'list', tag: [...tags, 'tag-16'] })).toEqual({
            valid: false,
            message: '$.tag must contain at most 16 items.'
        });
        expect(validateSchemaValue(operation, { verb: 'list', tag: tags })).toEqual({ valid: true });
        // `expects` keeps exactly one token: the duplicate is refused HERE, one step before the
        // engine's per-article guard (src/core/knowledge.ts:2020-2036) would fold it anyway.
        expect(
            validateSchemaValue(operation, {
                verb: 'modify',
                id,
                expects: [
                    { id, rev: 3 },
                    { id, rev: 3 }
                ]
            })
        ).toEqual({ valid: false, message: '$.expects must contain at most 1 item.' });
    });

    it('ships the same description through the generated manifest, in registration order', () => {
        // Four-space indentation ONLY: a row header sits at the top of a descriptor, while `name:`
        // also occurs inside the nested parameter schemas of the same descriptor.
        const names = MANIFEST.split('\n').filter((line) => line.startsWith('    name: ')).map((line) => line.trim());

        // The row is generated from the entry (no hand-maintained inventory), and its place in the
        // table is the registration order: after `locations` (90), before `agentManage` (100).
        expect(names.indexOf('name: "locations",') + 1).toBe(names.indexOf('name: "knowledge",'));
        expect(names.indexOf('name: "knowledge",') + 1).toBe(names.indexOf('name: "agentManage",'));
        // Byte-for-byte: the generator ships the AST value as data, so a stale manifest is a failure
        // here even before `yarn tools:manifest:check`.
        expect(MANIFEST).toContain(`description: ${JSON.stringify(KNOWLEDGE_METADATA.description)}`);
        expect(MANIFEST).toContain('sourcePath: "tools/runtime/knowledge.tool.ts"');
    });

    it('exposes the callable form with the same contract, and no mode of its own', () => {
        // The catalogue resolves the callable (`descriptors.ts` prefers `module[name]`), so it has to
        // carry the same wire contract as the metadata literal.
        expect(typeof knowledge).toBe('function');
        expect(knowledge.name).toBe('knowledge');
        expect(knowledge.visibility).toBe('searchable');
        expect(knowledge.tags).toEqual(KNOWLEDGE_METADATA.tags);
        expect(knowledge.parameters).toBe(KNOWLEDGE_METADATA.parameters);
        expect(knowledge.description).toBe(KNOWLEDGE_METADATA.description);
    });
});

// ---------------------------------------------------------------------------
// The registration row
// ---------------------------------------------------------------------------

describe('knowledge registration', () => {
    it('registers as the record-family runtime entry it is', () => {
        // Same group/activation/flags as `records` (src/tools/runtime/records.tool.ts:94-101): the
        // entry needs the live session harness to answer at all, is searchable rather than
        // always-declared, and is listed for the server's direct-call catalogue.
        expect(registration).toEqual({
            group: 'runtime',
            activation: 'always',
            order: 95,
            sessionBound: true,
            alwaysDeclared: false,
            listed: true
        });
    });
});

// ---------------------------------------------------------------------------
// Arguments: what reaches the engine
// ---------------------------------------------------------------------------

describe('knowledge arguments', () => {
    it('routes the unwrapped operation, the wrapper, and both together, identically', () => {
        const seen: unknown[] = [];
        const answer = { articles: [], counts: { total: 0 }, page: { offset: 0, limit: 2, hasMore: false } };

        // The model path and the defensive wrapper path (a host calling `execute` directly, past the
        // validator), and the ambiguous case where BOTH are present — the wrapper wins, because
        // `operation` is a key of no verb (src/core/knowledge.ts:316-333).
        call({ verb: 'list', limit: 2 }, stubEngine(answer, seen));
        call({ operation: { verb: 'list', limit: 2 } }, stubEngine(answer, seen));
        call({ operation: { verb: 'read', id: 'x' }, verb: 'list' }, stubEngine(answer, seen));

        expect(seen).toEqual([
            { verb: 'list', limit: 2 },
            { verb: 'list', limit: 2 },
            { verb: 'read', id: 'x' }
        ]);
    });

    it('answers an absent, empty or malformed box with a plain listing', () => {
        const seen: unknown[] = [];

        for (const parameters of [undefined, null, {}, { operation: {} }, 'search', 7, [1, 2]]) {
            call(parameters, stubEngine({ articles: [], counts: { total: 0 }, page: { offset: 0, limit: 20, hasMore: false } }, seen));
        }

        // `list` is the one verb that needs nothing, so it is what a bare call means. The entry adds
        // NO `limit`: the engine default answers, and an invented bound would be a bound the caller
        // never asked for (and `offset: 200` below proves the entry does not compute paging either).
        expect(seen).toEqual([
            { verb: 'list' },
            { verb: 'list' },
            { verb: 'list' },
            { verb: 'list' },
            { verb: 'list' },
            { verb: 'list' },
            { verb: 'list' }
        ]);
    });

    it('defaults only the verb, and forwards every other key untouched', () => {
        const seen: unknown[] = [];
        const answer = { articles: [], counts: { total: 0 }, page: { offset: 0, limit: 10, hasMore: false } };

        call({ limit: 10 }, stubEngine(answer, seen));
        call({ verb: 'search', query: 'alpha' }, stubEngine(answer, seen));
        call({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90001', outline: true }, stubEngine({ id: 'x', paragraphs: [] }, seen));

        expect(seen).toEqual([
            { verb: 'list', limit: 10 },
            { verb: 'search', query: 'alpha' },
            { verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90001', outline: true }
        ]);
    });
});

// ---------------------------------------------------------------------------
// The seam: Harness.knowledge
// ---------------------------------------------------------------------------

describe('knowledge seam', () => {
    it('accepts the store shape and the bare engine, and answers identically', () => {
        const store = articles();
        const operation = { verb: 'list', limit: 1 };

        // `{ engine, file? }` is the `HarnessKnowledge` member T7 mounts (src/types/index.ts:2779-2796);
        // a bare engine is the other half of the union. `'engine' in seam` is the discriminator.
        const asStore = call(operation, { engine: store });
        const asEngine = call(operation, store);

        expect(asEngine.projection).toEqual(asStore.projection);
        expect(asStore.projection).toEqual({
            total: 3,
            page: { offset: 0, limit: 1, hasMore: true, nextOffset: 1 },
            articles: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90002', title: 'Alpha Primer', tags: [], rev: 1, paragraphCount: 1 }]
        });
    });

    it('refuses every host that has no base, with the code and the missing-seam sentence', () => {
        // No harness at all, and each shape that is not a seam OBJECT. None of them may become a bare
        // TypeError: the harness relays a code to the model only when the error carries one.
        for (const seam of [undefined, null, [], 'nope', 7]) {
            expect(refusal({ verb: 'list' }, seam)).toEqual({
                code: 'EKNOWLEDGE_INPUT',
                message: 'knowledge requires a knowledge base, and this harness has none (no Harness.knowledge seam).',
                details: undefined
            });
        }
        expect(refusal({ verb: 'list' }, undefined)).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'knowledge requires a knowledge base, and this harness has none (no Harness.knowledge seam).',
            details: undefined
        });
    });

    it('refuses a seam object that carries no callable engine, naming the difference', () => {
        // "No base" and "a base with nothing behind it" need different fixes, so they get different
        // sentences — and a `{ engine: null }` store must not crash inside the engine call.
        for (const seam of [{}, { engine: null }, { engine: undefined }, { engine: {} }]) {
            expect(refusal({ verb: 'list' }, seam)).toEqual({
                code: 'EKNOWLEDGE_INPUT',
                message: 'knowledge requires a knowledge base, and this harness has none (Harness.knowledge carries no engine).',
                details: undefined
            });
        }
    });

    it('does not invent a store for a direct call without a harness', async () => {
        // The callable form builds its OWN context — `{ parameters: value }`, nothing else
        // (src/core/tool.ts:157) — so a direct call can never carry a seam, and `run` wraps every
        // return in a promise (:152). Both facts are pinned: the refusal is the host-configuration
        // sentence, and it arrives as a rejection rather than as an empty listing.
        const failure = await knowledge({ verb: 'list' }).then(
            () => ({ thrown: false as const }),
            (error: unknown) => ({ code: (error as { code?: string }).code, message: (error as Error).message })
        );

        // The code is what the harness relays; the message is the ENTRY'S own sentence, still
        // un-prefixed here because the prefix is the harness's job (src/harness.ts:13069-13071).
        expect(failure).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'knowledge requires a knowledge base, and this harness has none (no Harness.knowledge seam).'
        });
    });
});

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

describe('knowledge envelope', () => {
    it('wraps the engine result exactly once, and leaves `content` untouched', () => {
        const store = articles();
        const operation = { verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90002' };

        // The engine's own result is the machine view, field for field — the projection is the only
        // thing this entry authors.
        const direct = store.execute(operation as KnowledgeOperation);
        const { envelope, content, projection } = call(operation, store);

        expect(Object.keys(envelope).sort()).toEqual(['__toolText', 'content']);
        expect(content).toEqual(JSON.parse(JSON.stringify(direct)));
        expect(content).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90002',
            title: 'Alpha Primer',
            tags: [],
            createdAt: STAMP,
            updatedAt: STAMP,
            rev: 1,
            paragraphCount: 1,
            paragraphs: [
                {
                    id: '7c9e6679-7425-40de-944b-e07fc1f90001',
                    text: 'Alpha is the first letter.',
                    rev: 1,
                    createdAt: STAMP,
                    updatedAt: STAMP
                }
            ]
        });

        // The prose drops the timestamps and the per-row `chars`, and keeps the ids and revs the
        // caller acts on.
        expect(projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90002',
            title: 'Alpha Primer',
            tags: [],
            rev: 1,
            paragraphCount: 1,
            paragraphs: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001', rev: 1, text: 'Alpha is the first letter.' }]
        });
    });
});

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

describe('knowledge verbs', () => {
    it('creates, reporting the ids the model needs and none of the text it wrote', () => {
        const { content, projection } = call(
            { verb: 'create', title: 'Alpha Primer', tags: ['costs'], content: ['Alpha is the first letter.', { text: 'Use it first.', tags: ['detail'] }] },
            engine()
        );

        // The engine answers a create with the WHOLE article — up to 64 × 4000 characters the model
        // just paid for once already (src/types/index.ts:2599-2605). `content` keeps it; the prose
        // keeps the identity, the fresh rev and the minted paragraph ids.
        expect(content).toEqual({
            article: {
                id: '7c9e6679-7425-40de-944b-e07fc1f90003',
                title: 'Alpha Primer',
                createdAt: STAMP,
                updatedAt: STAMP,
                tags: ['costs'],
                content: [
                    { id: '7c9e6679-7425-40de-944b-e07fc1f90001', text: 'Alpha is the first letter.', rev: 1, createdAt: STAMP, updatedAt: STAMP },
                    { id: '7c9e6679-7425-40de-944b-e07fc1f90002', text: 'Use it first.', rev: 1, tags: ['detail'], createdAt: STAMP, updatedAt: STAMP }
                ],
                rev: 1
            },
            createdIds: ['7c9e6679-7425-40de-944b-e07fc1f90001', '7c9e6679-7425-40de-944b-e07fc1f90002']
        });
        expect(projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90003',
            title: 'Alpha Primer',
            tags: ['costs'],
            rev: 1,
            paragraphCount: 2,
            createdIds: ['7c9e6679-7425-40de-944b-e07fc1f90001', '7c9e6679-7425-40de-944b-e07fc1f90002']
        });
    });

    it('honours a pinned paragraph id, and creates an article with no paragraphs at all', () => {
        const pinned = call({ verb: 'create', title: 'Pinned', content: [{ text: 'pinned body', id: '11111111-1111-1111-1111-111111111111' }] }, engine());

        expect(pinned.projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90001',
            title: 'Pinned',
            tags: [],
            rev: 1,
            paragraphCount: 1,
            createdIds: ['11111111-1111-1111-1111-111111111111']
        });

        // A `content` of `[]` is the engine's answer, not a refusal — and the entry does not claim a
        // paragraph that was never minted.
        expect(call({ verb: 'create', title: 'Empty' }, engine()).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90001',
            title: 'Empty',
            tags: [],
            rev: 1,
            paragraphCount: 0,
            createdIds: []
        });
    });

    it('pages a listing and projects each row to the fields a caller acts on', () => {
        const store = articles();

        // Row fields: id, title, tags, rev, paragraphCount. `createdAt`/`updatedAt` are dropped from
        // the prose (they are in `content`), and `total` is the engine's whole-matched-set count
        // rather than the page length (src/types/index.ts:2549-2553).
        expect(call({ verb: 'list', limit: 2 }, store).projection).toEqual({
            total: 3,
            page: { offset: 0, limit: 2, hasMore: true, nextOffset: 2 },
            articles: [
                { id: '7c9e6679-7425-40de-944b-e07fc1f90002', title: 'Alpha Primer', tags: [], rev: 1, paragraphCount: 1 },
                { id: '7c9e6679-7425-40de-944b-e07fc1f90004', title: 'Beta Primer', tags: ['costs'], rev: 1, paragraphCount: 1 }
            ]
        });

        // `nextOffset` appears only when the engine sets it, and the last page says it is the last.
        expect(call({ verb: 'list', offset: 2 }, store).projection).toEqual({
            total: 3,
            page: { offset: 2, limit: 20, hasMore: false },
            articles: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90006', title: 'Gamma Notes', tags: [], rev: 1, paragraphCount: 1 }]
        });

        // Paging past the end is an empty page, not an error, and the entry does not second-guess
        // the engine's `limit` (20, the default) even at offset 200.
        expect(call({ verb: 'list', offset: 200 }, store).projection).toEqual({
            total: 3,
            page: { offset: 200, limit: 20, hasMore: false },
            articles: []
        });

        // The filter keys: `search` is a substring filter of `list`, and `tag` is case-folded.
        expect(call({ verb: 'list', search: 'alpha' }, store).projection!.total).toBe(1);
        expect(call({ verb: 'list', tag: ['Costs'] }, store).projection!.articles).toEqual([
            { id: '7c9e6679-7425-40de-944b-e07fc1f90004', title: 'Beta Primer', tags: ['costs'], rev: 1, paragraphCount: 1 }
        ]);
    });

    it('searches, and never drops which lane answered', () => {
        const store = articles();

        // `matchedIn: "title"` means the title lane matched and the TEXT was never scanned for that
        // term (src/types/index.ts:2556-2561). Dropping it would let the model conclude the body
        // mentions the phrase.
        expect(call({ verb: 'search', query: 'Alpha Primer' }, store).projection).toEqual({
            matchedIn: 'title',
            total: 1,
            page: { offset: 0, limit: 20, hasMore: false },
            articles: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90002', title: 'Alpha Primer', tags: [], rev: 1, paragraphCount: 1 }]
        });
        expect(call({ verb: 'search', query: 'casually' }, store).projection).toEqual({
            matchedIn: 'text',
            total: 1,
            page: { offset: 0, limit: 20, hasMore: false },
            articles: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90006', title: 'Gamma Notes', tags: [], rev: 1, paragraphCount: 1 }]
        });

        // The rank window and the tag filter ride through unchanged.
        expect(call({ verb: 'search', query: 'primer', offset: 1, limit: 1 }, store).projection).toEqual({
            matchedIn: 'title',
            total: 2,
            page: { offset: 1, limit: 1, hasMore: false },
            articles: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90004', title: 'Beta Primer', tags: ['costs'], rev: 1, paragraphCount: 1 }]
        });
        expect(call({ verb: 'search', query: 'primer', tag: ['costs'] }, store).projection!.total).toBe(1);
    });

    it('reads an article, an outline, a window and a selection, echoing the engine shape', () => {
        const store = articles();

        // An OUTLINE answer: ids, revs and sizes, no text — the step between a page row and the text.
        expect(call({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90002', outline: true }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90002',
            title: 'Alpha Primer',
            tags: [],
            rev: 1,
            paragraphCount: 1,
            outline: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001', rev: 1, chars: 26 }]
        });

        // A WINDOW answer: `from`/`limit`/`truncated`/`totalParagraphs` are the engine's, verbatim.
        expect(call({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90002', from: 0, limit: 1 }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90002',
            title: 'Alpha Primer',
            tags: [],
            rev: 1,
            paragraphCount: 1,
            truncated: false,
            totalParagraphs: 1,
            from: 0,
            limit: 1,
            paragraphs: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001', rev: 1, text: 'Alpha is the first letter.' }]
        });

        // A SELECTION answers in the same shape, and reports the paragraphs it served — the entry
        // does not invent an offset for a set of ids.
        const pair = engine();

        pair.execute({ verb: 'create', title: 'Two Part', tags: ['costs'], content: ['One.', 'Two.'] } as KnowledgeOperation);
        expect(call({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90003', paragraphs: ['7c9e6679-7425-40de-944b-e07fc1f90002', '7c9e6679-7425-40de-944b-e07fc1f90001'] }, pair).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90003',
            title: 'Two Part',
            tags: ['costs'],
            rev: 1,
            paragraphCount: 2,
            truncated: false,
            totalParagraphs: 2,
            from: 0,
            limit: 2,
            paragraphs: [
                { id: '7c9e6679-7425-40de-944b-e07fc1f90001', rev: 1, text: 'One.' },
                { id: '7c9e6679-7425-40de-944b-e07fc1f90002', rev: 1, text: 'Two.' }
            ]
        });

        // A reference keeps its TARGET and drops the caller's free-text note (the note is in `content`).
        const linked = engine();

        linked.execute({ verb: 'create', title: 'Target', content: ['Target body.'] } as KnowledgeOperation);
        linked.execute({
            verb: 'create',
            title: 'Holder',
            content: [{ text: 'Points at the target.', tags: ['link'], refs: [{ articleId: '7c9e6679-7425-40de-944b-e07fc1f90002', note: 'Because it defines the term.' }] }]
        } as KnowledgeOperation);
        const { content, projection } = call({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90004' }, linked);

        expect(projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90004',
            title: 'Holder',
            tags: [],
            rev: 1,
            paragraphCount: 1,
            paragraphs: [
                {
                    id: '7c9e6679-7425-40de-944b-e07fc1f90003',
                    rev: 1,
                    text: 'Points at the target.',
                    tags: ['link'],
                    refs: [{ articleId: '7c9e6679-7425-40de-944b-e07fc1f90002' }]
                }
            ]
        });
        expect((content.paragraphs as { refs: { note: string }[] }[])[0].refs[0].note).toBe('Because it defines the term.');
    });

    it('modifies, one key per kind of change, and reports the rev the next write needs', () => {
        const store = engine();

        store.execute({ verb: 'create', title: 'Alpha Primer', tags: ['old'], content: ['First.', 'Second.', 'Third.'] } as KnowledgeOperation);

        // An article-level change: `articleFields` names the fields that moved, and `rev` is the NEW
        // revision (the token for the next write).
        expect(call({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90004', title: 'Alpha Primer II', addTags: ['new'], removeTags: ['old'], expects: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90004', rev: 1 }] }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90004',
            title: 'Alpha Primer II',
            tags: ['new'],
            rev: 2,
            paragraphCount: 3,
            articleFields: ['title', 'tags'],
            noop: false
        });

        // A rewrite that changes nothing reports the id in `noopIds` and bumps no rev — the caller
        // learns "nothing happened" without paying for an article.
        expect(call({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90004', setParagraphs: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001', text: 'First.' }] }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90004',
            title: 'Alpha Primer II',
            tags: ['new'],
            rev: 2,
            paragraphCount: 3,
            noopIds: ['7c9e6679-7425-40de-944b-e07fc1f90001'],
            noop: true
        });

        // A move is visible ONLY in `movedIds` (it bumps no paragraph rev).
        expect(call({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90004', moveParagraphs: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90003', before: '7c9e6679-7425-40de-944b-e07fc1f90001' }] }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90004',
            title: 'Alpha Primer II',
            tags: ['new'],
            rev: 3,
            paragraphCount: 3,
            movedIds: ['7c9e6679-7425-40de-944b-e07fc1f90003'],
            noop: false
        });

        // Two kinds in one call → two keys, and `createdIds` keeps its own place (the projection
        // forwards the keys rather than flattening them into counts, because the KEY is the answer).
        expect(call({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90004', addContent: ['Fourth.'], removeParagraphs: ['7c9e6679-7425-40de-944b-e07fc1f90002'] }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90004',
            title: 'Alpha Primer II',
            tags: ['new'],
            rev: 4,
            paragraphCount: 3,
            removedIds: ['7c9e6679-7425-40de-944b-e07fc1f90002'],
            noop: false,
            createdIds: ['7c9e6679-7425-40de-944b-e07fc1f90005']
        });

        // A real rewrite: `changedIds`, and no `noop` claim beyond the flag.
        expect(call({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90004', setParagraphs: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001', text: 'Rewritten.', tags: ['edited'] }] }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90004',
            title: 'Alpha Primer II',
            tags: ['new'],
            rev: 5,
            paragraphCount: 3,
            changedIds: ['7c9e6679-7425-40de-944b-e07fc1f90001'],
            noop: false
        });

        // A modify whose every field already matches: the identity still answers (a caller that sent
        // a no-op write needs the CURRENT rev for its next attempt), and the rev does not move —
        // `noop: true` is the whole answer, with no invented `articleFields` for nothing.
        expect(call({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90004', removeTags: ['nothing-here'] }, store).projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90004',
            title: 'Alpha Primer II',
            tags: ['new'],
            rev: 5,
            paragraphCount: 3,
            noop: true
        });
    });

    it('removes, and reports the references the removal just broke', () => {
        const store = engine();

        store.execute({ verb: 'create', title: 'Target', content: ['Target body.'] } as KnowledgeOperation);
        store.execute({ verb: 'create', title: 'Holder', content: [{ text: 'Points at the target.', refs: [{ articleId: '7c9e6679-7425-40de-944b-e07fc1f90002', note: 'why' }] }] } as KnowledgeOperation);

        const { content, projection } = call({ verb: 'remove', id: '7c9e6679-7425-40de-944b-e07fc1f90002', expects: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90002', rev: 1 }] }, store);

        // `danglingRefs` is the part a caller cannot get any other way: the links that broke live in
        // OTHER articles (src/types/index.ts:2630-2633). The count leads; the machine view keeps the
        // list even when it is empty.
        expect(projection).toEqual({
            removed: { id: '7c9e6679-7425-40de-944b-e07fc1f90002', title: 'Target', tags: [], rev: 1, paragraphCount: 1 },
            danglingCount: 1,
            danglingRefs: ['7c9e6679-7425-40de-944b-e07fc1f90002']
        });
        expect(content.danglingRefs).toEqual(['7c9e6679-7425-40de-944b-e07fc1f90002']);

        // An article nothing referenced: the count says so and the empty list costs nothing.
        const lonely = engine();

        lonely.execute({ verb: 'create', title: 'Lonely', content: ['No links.'] } as KnowledgeOperation);
        const clean = call({ verb: 'remove', id: '7c9e6679-7425-40de-944b-e07fc1f90002' }, lonely);

        expect(clean.projection).toEqual({
            removed: { id: '7c9e6679-7425-40de-944b-e07fc1f90002', title: 'Lonely', tags: [], rev: 1, paragraphCount: 1 },
            danglingCount: 0
        });
        expect(clean.projection).not.toHaveProperty('danglingRefs');
        expect(clean.content.danglingRefs).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The budget the prose is cut to
// ---------------------------------------------------------------------------

describe('knowledge projection budget', () => {
    it('prices the projection in escaped payload bytes, and stays under the engine budget', () => {
        // The engine's own cap, pinned as a number so a change there cannot silently move the
        // projection target with it (the projection cap is a literal, see the import-discipline test).
        expect(KNOWLEDGE_RESPONSE_BUDGET_BYTES).toBe(24576);
        expect(KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES).toBe(8192);

        const store = engine();

        for (let index = 0; index < 60; index++) {
            store.execute({
                verb: 'create',
                title: `Article ${String(index).padStart(2, '0')} — a long enough title to make the listing honest`,
                content: ['Body.']
            } as KnowledgeOperation);
        }

        // 60 wide rows are 15398 bytes of machine result and 11933 bytes of prose: the projection is
        // the difference the model saves, and nothing was dropped to get there.
        const listing = call({ verb: 'list', limit: 100 }, store);

        expect((listing.projection.articles as unknown[]).length).toBe(60);
        expect(listing.projection).not.toHaveProperty('note');
        expect(listing.projection).not.toHaveProperty('omitted');
        expect(listing.proseBytes).toBe(11933);
        expect(listing.contentBytes).toBe(15398);
        expect(listing.proseBytes).toBeLessThan(KNOWLEDGE_RESPONSE_BUDGET_BYTES);

        // A small page costs proportionally: the projection never carries the article bodies.
        const page = call({ verb: 'list', limit: 5 }, store);

        expect(page.projection.page).toEqual({ offset: 0, limit: 5, hasMore: true, nextOffset: 5 });
        expect(page.proseBytes).toBe(1116);
        expect(page.contentBytes).toBe(1387);
    });

    it('echoes the engines own cut rather than claiming a second one', () => {
        // 64 paragraphs × 3990 characters: the ENGINE drops its own tail to stay inside its budget
        // and says so (`truncated`, `budgetTruncated`, src/types/index.ts:2567-2574). The prose must
        // carry those flags unchanged — two competing claims about one response are worse than one.
        const store = engine();

        store.execute({ verb: 'create', title: 'Wide', content: Array.from({ length: 64 }, () => 'x'.repeat(3990)) } as KnowledgeOperation);
        const { projection, proseBytes, contentBytes } = call({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90065' }, store);

        // The article id is the 65th mint: 64 paragraphs first, then the article.
        expect(projection).toEqual({
            id: '7c9e6679-7425-40de-944b-e07fc1f90065',
            title: 'Wide',
            tags: [],
            rev: 1,
            paragraphCount: 64,
            truncated: true,
            budgetTruncated: true,
            totalParagraphs: 64,
            from: 0,
            limit: 5,
            paragraphs: Array.from({ length: 5 }, (_, index) => ({
                id: `7c9e6679-7425-40de-944b-e07fc1f900${String(index + 1).padStart(2, '0')}`,
                rev: 1,
                text: 'x'.repeat(3990)
            }))
        });
        expect(projection).not.toHaveProperty('note');
        expect(proseBytes).toBe(20695);
        expect(contentBytes).toBe(21055);
        expect(proseBytes).toBeLessThan(KNOWLEDGE_RESPONSE_BUDGET_BYTES);

        // The outline mode is the cheap way across the same article: 64 rows of ids and sizes, 5986
        // bytes against 7764 of machine result, with no text at all.
        const outline = call({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90065', outline: true }, store);

        expect((outline.projection.outline as unknown[]).length).toBe(64);
        expect((outline.projection.outline as unknown[])[0]).toEqual({ id: '7c9e6679-7425-40de-944b-e07fc1f90001', rev: 1, chars: 3990 });
        expect(outline.proseBytes).toBe(5986);
        expect(outline.contentBytes).toBe(7764);
    });

    it('cuts the prose to fit when the engine did not, and names the way back', () => {
        // A stub engine, so the cut is provably the ENTRY'S (a second, nested engine cut would make
        // the note lie about who dropped what). 64 paragraphs of 4000 characters cannot fit 24576
        // bytes even projected, so the halving stops at 4 rows and says what it dropped.
        const rows = Array.from({ length: 64 }, (_, index) => ({
            id: `7c9e6679-7425-40de-944b-e07fc1f90${String(index + 1).padStart(2, '0')}`,
            rev: 1,
            text: 'x'.repeat(4000)
        }));
        const { projection, content, proseBytes, contentBytes } = call(
            { verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90001' },
            stubEngine({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90001', title: 'Alpha Primer', tags: [], rev: 1, paragraphCount: 64, truncated: false, budgetTruncated: false, paragraphs: rows })
        );

        expect(proseBytes).toBe(16814);
        expect(proseBytes).toBeLessThan(KNOWLEDGE_RESPONSE_BUDGET_BYTES);
        // The machine view keeps all 64 paragraphs — 260873 bytes of them. A caller that pages from
        // the server keeps everything; only the transcript pays the projection.
        expect(contentBytes).toBe(260873);
        expect((content.paragraphs as unknown[]).length).toBe(64);

        const paragraphs = projection.paragraphs as { id: string; text: string }[];

        expect(paragraphs.map((paragraph) => paragraph.id)).toEqual(rows.slice(0, 4).map((row) => row.id));
        expect(paragraphs[3].text).toBe('x'.repeat(4000));
        expect(projection.paragraphCount).toBe(64);
        expect(projection.omitted).toBe(60);
        expect(projection.note).toBe(
            'Projection cut for the 24576-byte model budget: 60 of 64 paragraphs not shown (the tail was dropped); ask for the next window (from/limit) or the paragraph ids you still need'
        );
    });

    it('never cuts an id list the engine itself bounded', () => {
        // 64 uuids is the engine's own per-call bound (KNOWLEDGE_MAX_ITEMS), so an id list can never
        // be the thing that breaks the budget. Both are asserted at the bound, with no note.
        const ids = Array.from({ length: 64 }, (_, index) => `7c9e6679-7425-40de-944b-e07fc1f90${String(index + 1).padStart(2, '0')}`);
        const created = call(
            { verb: 'create', title: 'Alpha Primer', content: ['x'] },
            stubEngine({
                verb: 'create',
                article: {
                    id: '7c9e6679-7425-40de-944b-e07fc1f90001',
                    title: 'Alpha Primer',
                    tags: [],
                    rev: 1,
                    createdAt: 'x',
                    updatedAt: 'x',
                    content: ids.map((id) => ({ id, text: 'y', rev: 1, createdAt: 'x', updatedAt: 'x' }))
                },
                createdIds: ids
            })
        );

        expect((created.projection.createdIds as unknown[]).length).toBe(64);
        expect(created.projection).not.toHaveProperty('note');
        expect(created.projection).not.toHaveProperty('createdCount');
        expect(created.proseBytes).toBe(2989);

        const removed = call(
            { verb: 'remove', id: '7c9e6679-7425-40de-944b-e07fc1f90001' },
            stubEngine({ verb: 'remove', removed: { id: '7c9e6679-7425-40de-944b-e07fc1f90001', title: 'Alpha Primer', tags: [], rev: 1, createdAt: 'x', updatedAt: 'x', paragraphCount: 1 }, danglingRefs: ids, counts: { total: 0 } })
        );

        expect((removed.projection.danglingRefs as unknown[]).length).toBe(64);
        expect(removed.projection.danglingCount).toBe(64);
        expect(removed.proseBytes).toBe(3033);
    });
});

// ---------------------------------------------------------------------------
// The refusals: the entry stays out of the way
// ---------------------------------------------------------------------------

describe('knowledge refusals', () => {
    // Every message below starts with `EKNOWLEDGE_*: ` because the ENGINE splices its own code into
    // the message when it builds the rejection (`knowledgeError`, src/core/knowledge.ts:269-275 —
    // "the code is spliced in as the message's FIRST token so the greppable name survives every
    // renderer"). This entry relays that message UNCHANGED, so the prefix is part of the contract the
    // model reads; the entry's own seam refusal is the one message in this file WITHOUT a prefix,
    // because adding it is the harness's job (src/harness.ts:13069-13071).

    it('refuses an unknown verb, naming the six it knows', () => {
        expect(refusing({ verb: 'frobnicate' })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge operations have a "verb" of "list", "search", "read", "create", "modify", "remove"; received frobnicate.',
            details: undefined
        });
    });

    it('refuses a field the verb does not take, naming the fields it does', () => {
        expect(refusing({ verb: 'list', limito: 5 })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge "list" has no field "limito"; it takes "verb", "search", "tag", "limit", "offset" — fix the name or drop it.',
            details: undefined
        });
        // The flat union schema cannot say "only read takes `from`"; the engine can, and does.
        expect(refusing({ verb: 'search', query: 'alpha', from: 1 })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge "search" has no field "from"; it takes "verb", "query", "tag", "limit", "offset" — fix the name or drop it.',
            details: undefined
        });
    });

    it('refuses an id it cannot use, distinguishing the two remedies', () => {
        expect(refusing({ verb: 'modify', title: 'Orphan' })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge "modify" requires "id" to be a uuid string; run a "search" or "list" — ids are uuids the engine assigned.',
            details: undefined
        });
        expect(refusing({ verb: 'read', id: 'not-a-uuid' })).toEqual({
            code: 'EKNOWLEDGE_ID',
            message: 'EKNOWLEDGE_ID: knowledge "read" "id" is "not-a-uuid", which is not a uuid; run a "search" or "list" — ids are uuids the engine assigned.',
            details: undefined
        });
        expect(refusing({ verb: 'read', id: '7c9e6679-7425-40de-944b-e07fc1f90099' })).toEqual({
            code: 'EKNOWLEDGE_NOT_FOUND',
            message: 'EKNOWLEDGE_NOT_FOUND: knowledge "read" found no article "7c9e6679-7425-40de-944b-e07fc1f90099". Run a "search" or "list" to find the article you mean; ids are uuids the engine assigned and cannot be guessed.',
            details: { id: '7c9e6679-7425-40de-944b-e07fc1f90099' }
        });
    });

    it('refuses a bound, quoting the figure and the constant', () => {
        expect(refusing({ verb: 'list', limit: 500 })).toEqual({
            code: 'EKNOWLEDGE_LIMIT',
            message: 'EKNOWLEDGE_LIMIT: knowledge "list" "limit" is 500, outside the 1-100 range the KNOWLEDGE_LIST_MAX_LIMIT bound allows; pass a limit between 1 and 100.',
            details: undefined
        });
        expect(refusing({ verb: 'search', query: 'alpha', offset: 46, limit: 10 })).toEqual({
            code: 'EKNOWLEDGE_LIMIT',
            message: 'EKNOWLEDGE_LIMIT: knowledge "search" asks for rank 47-56, past the KNOWLEDGE_MAX_SEARCH ceiling of 50 results. Narrow the query or add a "tag" filter instead of paging to the end of a loose match.',
            details: undefined
        });
    });

    it('refuses a paragraph named twice, because the engine will not guess the order', () => {
        // The rule the description teaches, enforced here: one paragraph, two kinds of change.
        expect(refusing({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90002', setParagraphs: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001', text: 'x' }], moveParagraphs: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001' }] })).toEqual({
            code: 'EKNOWLEDGE_ID',
            message: 'EKNOWLEDGE_ID: knowledge "modify" changes paragraph "7c9e6679-7425-40de-944b-e07fc1f90001" in both "setParagraphs" and "moveParagraphs"; one paragraph takes one kind of change per call. Split the call or drop one of them.',
            details: { paragraphId: '7c9e6679-7425-40de-944b-e07fc1f90001', steps: ['setParagraphs', 'moveParagraphs'] }
        });
    });

    it('refuses a write token that cannot be honoured', () => {
        expect(refusing({ verb: 'remove', id: '7c9e6679-7425-40de-944b-e07fc1f90002', expects: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90002', rev: 1 }, { id: '7c9e6679-7425-40de-944b-e07fc1f90004', rev: 1 }] })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge "remove" writes article "7c9e6679-7425-40de-944b-e07fc1f90002", so "expects" may only name that id; it named "7c9e6679-7425-40de-944b-e07fc1f90004". One article per call — send a second call for the other.',
            details: undefined
        });
        expect(refusing({ verb: 'remove', id: '7c9e6679-7425-40de-944b-e07fc1f90002', expects: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90002', rev: 0 }] })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge "remove" "expects" item 0 "rev" is 0, which is not a revision the engine ever mints; pass the "rev" the last read reported.',
            details: undefined
        });
    });

    it('refuses a reference whose target does not exist', () => {
        expect(refusing({ verb: 'create', title: 'Dangling', content: [{ text: 'x', refs: [{ articleId: '99999999-9999-9999-9999-999999999999' }] }] })).toEqual({
            code: 'EKNOWLEDGE_REF',
            message: 'EKNOWLEDGE_REF: knowledge "create" set a reference on paragraph "7c9e6679-7425-40de-944b-e07fc1f90007" to article "99999999-9999-9999-9999-999999999999", which this store does not hold. Reference an article that exists — "search" for it first — or remove the reference.',
            details: { paragraphId: '7c9e6679-7425-40de-944b-e07fc1f90007', articleId: '99999999-9999-9999-9999-999999999999' }
        });
    });

    it('lets a stale write out with the current article attached, unchanged', () => {
        // This is the refusal whose payload IS the recovery path: `details.article` is what the retry
        // is built from, and the harness relays code, message and details to the model
        // (src/harness.ts:13069-13071). A translation here would destroy it.
        const store = engine();

        store.execute({ verb: 'create', title: 'Alpha Primer', content: ['Alpha is the first letter.'] } as KnowledgeOperation);
        store.execute({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90002', title: 'Second Edition' } as KnowledgeOperation);

        expect(refusal({ verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90002', title: 'Never Applied', expects: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90002', rev: 1 }] }, store)).toEqual({
            code: 'EKNOWLEDGE_REV',
            message: `EKNOWLEDGE_REV: knowledge "modify" refused article "7c9e6679-7425-40de-944b-e07fc1f90002" at revision 1: the store holds revision 2, last modified at ${STAMP}. Retry with "expects" [{ id: "7c9e6679-7425-40de-944b-e07fc1f90002", rev: 2 }] after re-reading the paragraphs you want to change. current: {"id":"7c9e6679-7425-40de-944b-e07fc1f90002","title":"Second Edition","createdAt":"${STAMP}","updatedAt":"${STAMP}","tags":[],"content":[{"id":"7c9e6679-7425-40de-944b-e07fc1f90001","text":"Alpha is the first letter.","rev":1,"createdAt":"${STAMP}","updatedAt":"${STAMP}"}],"rev":2}`,
            details: {
                id: '7c9e6679-7425-40de-944b-e07fc1f90002',
                expectedRev: 1,
                currentRev: 2,
                updatedAt: STAMP,
                projected: false,
                article: {
                    id: '7c9e6679-7425-40de-944b-e07fc1f90002',
                    title: 'Second Edition',
                    createdAt: STAMP,
                    updatedAt: STAMP,
                    tags: [],
                    content: [
                        { id: '7c9e6679-7425-40de-944b-e07fc1f90001', text: 'Alpha is the first letter.', rev: 1, createdAt: STAMP, updatedAt: STAMP }
                    ],
                    rev: 2
                }
            }
        });
    });

    it('never repairs the operation on the way in', () => {
        // A missing title is the engine sentence, not a title the entry invented; an empty verb
        // STRING is not a verb, so it is refused rather than defaulted.
        expect(refusing({ verb: 'create', title: '   ', content: ['x'] })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge "create" requires a non-empty "title" string; the title is how a later session finds this article again.',
            details: undefined
        });
        expect(refusing({ verb: '' })).toEqual({
            code: 'EKNOWLEDGE_INPUT',
            message: 'EKNOWLEDGE_INPUT: knowledge operations have a "verb" of "list", "search", "read", "create", "modify", "remove"; received .',
            details: undefined
        });

        // `expects` travels exactly as written: the entry does not pre-read the article to fill in a
        // revision, which is the whole point of a compare-and-set token.
        const seen: unknown[] = [];
        const operation = { verb: 'modify', id: '7c9e6679-7425-40de-944b-e07fc1f90001', expects: [{ id: '7c9e6679-7425-40de-944b-e07fc1f90001', rev: 9 }], title: 'Whatever' };

        call(operation, stubEngine({ verb: 'modify', article: { id: '7c9e6679-7425-40de-944b-e07fc1f90001', title: 'Whatever', tags: [], rev: 9, content: [] }, noop: false }, seen));
        expect(seen).toEqual([operation]);
    });
});

// ---------------------------------------------------------------------------
// Schema helper
// ---------------------------------------------------------------------------

// The one `operation` box, typed loosely so the structural assertions read as data.
type SchemaNode = {
    type?: string;
    additionalProperties?: boolean;
    required?: string[];
    properties?: Record<string, Record<string, unknown>>;
};

const operationSchema = (): SchemaNode => KNOWLEDGE_METADATA.parameters.properties.operation as SchemaNode;
