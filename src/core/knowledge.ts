// knowledge — the ONE cross-session article engine (T4).
//
// WHAT THIS MODULE IS
// -------------------
// `records` (./records.ts) owns the session and dies with it. This engine owns the same
// class of data with the same rules and a different lifetime: articles that outlive the
// conversation, persisted as one JSON file per article by ../server/knowledge-file-store.ts.
// The engine itself is PURELY IN-MEMORY and synchronous — it never touches the filesystem,
// never awaits, and never learns where its bytes are kept. Persistence is a SUBSCRIBER
// (`onStoreChange`), which is exactly the seam `records` uses for its observation plane
// (records.ts:2479-2525) and for the same reason: the engine stays the single source of
// truth, and a dead transport fails an observer, never a write.
//
// The layering is the one the user asked for: `knowledge` the TOOL (../tools/runtime/) is a
// thin shell that routes operations here, the way `tasks` is a thin shell over `records`.
// A future `recipes` tool wraps this same engine with its own vocabulary and inherits every
// rule below for free.
//
// THE RULES THIS ENGINE OWNS
// --------------------------
//   - ids are uuid v4 from `node:crypto` `randomUUID()` — no counter, so nothing has to be
//     persisted beside the articles and two harnesses writing two files cannot collide.
//     Consequence, and the reason it is worth the randomness: EVERY paragraph id is unique
//     across the whole store, not merely within one article, so a `KnowledgeReference` names
//     a paragraph absolutely and a `read { paragraphs }` selection can never be ambiguous.
//     (Contrast records' F3 monotonic counter, which works only because one process owns it.)
//   - TWO revisions, and both are read-side facts a caller can act on. `article.rev` moves
//     when ANYTHING in the article moves, including order; `paragraph.rev` moves ONLY when
//     that paragraph's text/tags/refs really changed (the records rule at records.ts:1910).
//     A reorder is therefore visible in the article token and invisible in the paragraph
//     tokens — which is what lets a caller guard one paragraph's body without being woken by
//     somebody moving a sibling.
//   - optimistic CAS through `expects: [{ id, rev }]` and NOTHING else (records' Decision P,
//     carried over unchanged): no locks, no leases, no claims, no sweep. A stale token
//     refuses the WHOLE operation and the refusal CARRIES THE CURRENT ARTICLE (records' R9),
//     budgeted — one round trip to discover a conflict, not two.
//   - every rejection carries a stable machine CODE (records' Decision O): the code is
//     `error.name`, `error.code`, AND the first token of the message, because ../harness.ts
//     renders a thrown error as `Tool "<name>" failed: <message>` and only the message
//     reaches a model. The message names the offending id, the bound, and the fix.
//   - validate everything, then commit, or commit nothing. Each operation works on a CLONE of
//     the one article it touches and swaps the clone in only after every step validated, so a
//     rejection mid-operation leaves the store, the watermark and the feed exactly as they
//     were. (A uuid mint is not "burned" by a failed call — unlike records' counter, nothing
//     observable moves — so a rejected create costs nothing to retry.)
//   - refs are validated when WRITTEN and never cascaded on removal: a reference to a deleted
//     article or paragraph survives, unmodified, and reads back as DANGLING through the
//     `danglingRefs` projection. Rewriting every referring paragraph to record an absence
//     would (a) bump a `rev` the caller never edited, (b) turn a read-side fact into a write,
//     and (c) make the dangling state unrepresentable in `KnowledgeReference`, which has no
//     `dangling` field. So the mark is computed, and `danglingRefs` is where it is said.
//   - store-level bounds are engine-owned (records' Decision G): a model can flood its own
//     context with a non-deterministic agent, so the caps live here, below the outer
//     model-facing cap, and a wrapper may not raise them by asking nicely.
//   - optional keys are ABSENT, never `undefined`-valued (records.ts:299-308): the persisted
//     JSON and the byte budget both measure the real serialized shape, and a key present with
//     `undefined` breaks a deep-equal that should have matched.
//
// APPLY ORDER FOR `modify` (deterministic, and pinned by ./knowledge.test.ts)
// ---------------------------------------------------------------------------
//   1. `title`            — a change is a change only if the trimmed text differs;
//   2. `addTags` then `removeTags` — so a tag named by BOTH nets out REMOVED, and the
//      surviving order is the stored order with additions appended;
//   3. `setParagraphs`    — rewrite an EXISTING paragraph's text/tags/refs (never its order);
//   4. `addContent`       — append after the paragraphs that already exist;
//   5. `moveParagraphs`   — reorder whatever steps 3 and 4 produced, entry by entry, each move
//      applied to the array the previous one left;
//   6. `removeParagraphs` — drop by id;
//   7. ref revalidation   — validate ONLY the refs this call wrote, against the store as this
//      call will leave it. Last, so a reference may point at a paragraph another step of the
//      SAME call appended (the recipe case) — and so a reference at a paragraph this call
//      removed is refused rather than committed dangling. Stored refs are NOT revalidated: a
//      ref that dangled before this call is a legal stored state, and refusing every later edit
//      of the article that holds it would make deletion impossible to clean up.
//
// A call that changes NOTHING commits nothing: no `article.rev` bump, no `updatedAt` move, no
// watermark advance, and no notification — the records 0012 `noopIds` discipline, applied to
// the whole operation.
//
// Cross-references:
//   - ../types                    — KnowledgeOperation, KnowledgeArticle, KnowledgeParagraph,
//                                   KnowledgeReference, KnowledgeExpect, KnowledgeStoreState,
//                                   KnowledgeStoreNotification, KnowledgeEngine, and every
//                                   result projection this file returns
//   - ./records.ts                — the in-memory pattern mirrored here (bounds, codes, R9,
//                                   the copy-on-the-way-out rule, onStoreChange)
//   - ./payload-bytes.ts          — modelPayloadBytes, the currency every budget here is
//                                   measured in (T3: the escaped payload is what the model pays)
//   - ./result-budget.ts          — MODEL_TOOL_RESULT_BUDGET_BYTES (32 KiB), the OUTER cap this
//                                   file's budgets stay under
//   - ./snapshot-validation.ts    — the strict readers ../server/knowledge-file-store.ts and
//                                   `readKnowledgeStoreState` share
//   - ../server/knowledge-file-store.ts — the subscriber that turns notifications into files

import { randomUUID } from 'node:crypto';
import { HarnessError, isInstanceOf } from '../util';
import { KNOWLEDGE_OPERATION_VERBS } from '../types';
import type {
    KnowledgeArticle,
    KnowledgeArticleMeta,
    KnowledgeArticleSummary,
    KnowledgeCreateResult,
    KnowledgeEngine,
    KnowledgeEngineOptions,
    KnowledgeExpect,
    KnowledgeModifyResult,
    KnowledgeOperation,
    KnowledgeOutlineEntry,
    KnowledgePageResult,
    KnowledgeParagraph,
    KnowledgeReadParams,
    KnowledgeReadResult,
    KnowledgeReference,
    KnowledgeRemoveResult,
    KnowledgeResult,
    KnowledgeResultFor,
    KnowledgeSearchParams,
    KnowledgeSearchResult,
    KnowledgeStoreChangeReason,
    KnowledgeStoreNotification,
    KnowledgeStoreState,
    ToolContext
} from '../types';
import {
    readSnapshotArray,
    readSnapshotInteger,
    readSnapshotKeys,
    readSnapshotRecord,
    readSnapshotString
} from './snapshot-validation';
import { modelPayloadBytes } from './payload-bytes';

// ---------------------------------------------------------------------------
// Engine bounds (the records Decision G discipline, records.ts:142-183)
// ---------------------------------------------------------------------------
//
// Every number below is a CONTEXT bound first and a memory bound second: the agent
// driving this engine is non-deterministic, so the caps have to exist somewhere the agent
// cannot negotiate with. What IS load-bearing is the relationship between the two budgets:
// `KNOWLEDGE_RESPONSE_BUDGET_BYTES` stays strictly under MODEL_TOOL_RESULT_BUDGET_BYTES
// (32 KiB, ./result-budget.ts:192) so a knowledge result that reports `truncated: false`
// still fits the harness envelope — an inner page that claims it is complete while the
// outer envelope cut it is a lie the model cannot detect.
//
// 100 articles, not records' 200: one knowledge article carries up to 64 × 4000-character
// paragraphs, i.e. an order of magnitude more prose than one record row, and the whole
// store is paged through a model's context rather than scanned by code.
export const KNOWLEDGE_MAX_ARTICLES = 100;

// Paragraphs per article. 64 is a section-count an article can actually hold (one
// paragraph ≈ one screen of prose) and it is also `KNOWLEDGE_MAX_ITEMS`, so a caller may
// restate a whole article in one `modify` — the same property records' apply order buys
// (records.ts:61-66).
export const KNOWLEDGE_MAX_PARAGRAPHS = 64;

// One paragraph's text, in characters. Same figure as RECORD_MAX_TEXT (records.ts:154) on
// purpose: it is the one number the records engine already proved a model can be trusted
// with in a single write, and it keeps the worst-case article (64 × 4000) inside one
// readable file.
export const KNOWLEDGE_MAX_TEXT = 4_000;

// Note free-text cap: a reference reason is a sentence, not an essay, and it rides inside
// every read that shows the link.
export const KNOWLEDGE_MAX_NOTE = 500;

// An article title is what `search` matches on and what a page row shows, so it is capped
// far below the text cap: a 200-character title cannot be read in a page, and a page of
// them cannot be scanned.
export const KNOWLEDGE_MAX_TITLE = 200;

// Tags per article (and per paragraph) and characters per tag. Tags are a search FILTER
// matched case-insensitively; the caps keep a tag list readable in a page row and keep the
// filter set small enough to state in one call.
export const KNOWLEDGE_MAX_TAGS = 16;
export const KNOWLEDGE_MAX_TAG = 64;

// Outgoing links per paragraph. Sixteen is more links than a paragraph can justify, and
// refs are validated on write, so this also bounds the work one `create` can trigger.
export const KNOWLEDGE_MAX_REFS = 16;

// Items per call: `content`, `setParagraphs`, `moveParagraphs`, `removeParagraphs`, a
// `paragraphs` selection and `expects` are all bounded by this one number. It equals
// KNOWLEDGE_MAX_PARAGRAPHS so "restate the whole article" is expressible in one call —
// the alternative forces an agent into a multi-call dance whose intermediate states are
// visible to everyone else in the session.
export const KNOWLEDGE_MAX_ITEMS = 64;

// The paging ceiling for one `search`: a caller may not page past rank 50. `list` is
// bounded by the store itself, but a relevance-ranked `search` that answers thousands of
// rows is a query that has not been narrowed yet, and paging to the end of it defeats the
// drill-in loop the tool exists to encourage. The refusal says exactly that.
export const KNOWLEDGE_MAX_SEARCH = 50;

// Page sizing, in the records shape (records.ts:156-157): a default a model gets without
// asking, and a ceiling an explicit `limit` may not exceed.
export const KNOWLEDGE_LIST_DEFAULT_LIMIT = 20;
export const KNOWLEDGE_LIST_MAX_LIMIT = 100;

// The engine's own response cap, in the escaped payload bytes the model is billed (T3,
// ./result-budget.ts:62-98 — measuring text bytes while capping payload bytes is the bug
// that post-mortem measured at +4.7% per result).
//
// 24 KiB ≈ 6k tokens ≈ 3% of the shipped 200k window, and ~8 KiB UNDER
// MODEL_TOOL_RESULT_BUDGET_BYTES. The headroom is not slack: the `knowledge` tool wraps
// this JSON in a model projection, and a budget that already equalled the outer cap would
// put every full-sized result into the spill envelope — which replaces a structured,
// `truncated`-flagged answer with a head/tail text cut the caller cannot page from.
// `read` may spend the whole cap (FILE_READ_WIRE_BUDGET, ../tools/files/read.tool.ts:690)
// because its payload is ONE file body with no structure left to lose; knowledge answers
// with a projection a caller has to keep parsing.
export const KNOWLEDGE_RESPONSE_BUDGET_BYTES = 24 * 1024;

// A stale refusal carries the CURRENT article (records' R9), so it is budgeted like a
// response — otherwise a conflict on a full-size article turns a rejection into a bigger
// flood than the write that caused it. When the whole article does not fit, the payload
// degrades to the article metadata + a paragraph OUTLINE (ids, revs, sizes, no text) and
// the message says so: a caller can still harvest every paragraph id and rev it needs for
// the retry, and the degradation is a stated fact rather than a silent cut.
export const KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Stable rejection codes (records' Decision O / F17)
// ---------------------------------------------------------------------------
//
// One closed set, six codes. The split between the two generic ones is deliberate and is
// the sentence every refusal states:
//   - `EKNOWLEDGE_INPUT`  — the CALL is malformed: wrong type, missing required value, an
//     unknown field, a combination that contradicts itself. Nothing in the store has to be
//     true for this to be knowable.
//   - `EKNOWLEDGE_LIMIT`  — a NUMBER crossed a bound: a store that is full, a paragraph over
//     its character cap, a tag list too long, a `limit` out of range, a search paged too
//     deep. The message always quotes the actual size, the bound, and the constant name.
// `EKNOWLEDGE_ID` and `EKNOWLEDGE_NOT_FOUND` are separate because the remedies differ: the
// first says "that string is not an id shape the engine can ever mint", the second says
// "that is a well-formed id this store does not hold — go look it up".
export type KnowledgeErrorCode =
    | 'EKNOWLEDGE_INPUT'
    | 'EKNOWLEDGE_ID'
    | 'EKNOWLEDGE_REV'
    | 'EKNOWLEDGE_LIMIT'
    | 'EKNOWLEDGE_REF'
    | 'EKNOWLEDGE_NOT_FOUND';

// The published set as a VALUE, so a test and the tool description enumerate the SAME list
// the union carries rather than re-pasting it (the FILE_READ_ERROR_CODES precedent,
// ../tools/files/read.tool.ts:961) — drift becomes a failing assertion, not prose.
export const KNOWLEDGE_ERROR_CODES: readonly KnowledgeErrorCode[] = [
    // Argument shape: a wrong type, a missing required value, an unknown field, or a
    // combination that contradicts itself. The message names the exact field.
    'EKNOWLEDGE_INPUT',
    // An id string the engine could never accept (not a uuid), or one id named twice by one
    // call, or a pinned id the store already holds.
    'EKNOWLEDGE_ID',
    // The CAS token did not match: the ONLY conflict this engine has, and its payload carries
    // the current article.
    'EKNOWLEDGE_REV',
    // A bound: store size, paragraph count, text/tags/refs/items caps, a `limit` out of range,
    // or a search paged past KNOWLEDGE_MAX_SEARCH.
    'EKNOWLEDGE_LIMIT',
    // A reference whose target article or paragraph does not exist. Only NEW references are
    // refused; a reference that dangled before the call is reported, never refused.
    'EKNOWLEDGE_REF',
    // An article id this store does not hold, or a paragraph id the named article does not
    // hold. The remedy is always "list/search/read first" — ids are uuids, never guessable.
    'EKNOWLEDGE_NOT_FOUND'
] as readonly KnowledgeErrorCode[];

// One rejection, coded. The code is spliced in as the message's FIRST token so the greppable
// name survives every renderer between here and the model (../harness.ts prefixes the rest).
const knowledgeError = (code: KnowledgeErrorCode, message: string, details?: unknown): HarnessError =>
    new HarnessError(`${code}: ${message}`, {
        code,
        ...(details === undefined ? {} : { details })
    });

const inputError = (message: string): HarnessError => knowledgeError('EKNOWLEDGE_INPUT', message);

// The label every refusal in one code path quotes, so a model reading
// `knowledge "modify" ...` knows which verb answered it.
type Label = string;

// Total classifier for the engine's rejections (records' Decision O): a wrapper switches on
// the CODE, never the prose, and must not become a new crash path when the thrown value is
// hostile (`isInstanceOf` exists for exactly that reason).
export const isKnowledgeRejection = (error: unknown): error is HarnessError & { code: KnowledgeErrorCode } =>
    isInstanceOf(error, HarnessError) &&
    typeof error.code === 'string' &&
    (KNOWLEDGE_ERROR_CODES as readonly string[]).includes(error.code);

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

// The one id shape the engine mints and accepts. `KNOWLEDGE_UUID_PATTERN` is exported
// because ../server/knowledge-file-store.ts validates file CONTENT with the same rule, and
// a second regex would be a second truth about what an id is.
export const KNOWLEDGE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ids are canonicalized to LOWERCASE on the way in, so a caller that upper-cased a uuid
// still matches the stored row and a snapshot compares byte-for-byte after a round trip.
const canonicalId = (value: string): string => value.trim().toLowerCase();

const isUuid = (value: unknown): value is string =>
    typeof value === 'string' && KNOWLEDGE_UUID_PATTERN.test(value.trim());

// ---------------------------------------------------------------------------
// Accepted key sets
// ---------------------------------------------------------------------------
//
// Strict by default: an unknown key is a REFUSAL naming the key, never a silently dropped
// field (records' Decision C — "a typo must be a refusal naming the typo, never an empty
// page"). A model that mistyped `"title"` as `"tile"` and got a silent no-op would retry the
// same typo forever; a refusal quoting the accepted keys ends it in one round trip.
type KnowledgeVerb = (typeof KNOWLEDGE_OPERATION_VERBS)[number];

const OPERATION_KEYS: Record<KnowledgeVerb, readonly string[]> = {
    list: ['verb', 'search', 'tag', 'limit', 'offset'],
    search: ['verb', 'query', 'tag', 'limit', 'offset'],
    read: ['verb', 'id', 'paragraphs', 'from', 'limit', 'outline'],
    create: ['verb', 'title', 'tags', 'content'],
    modify: [
        'verb',
        'id',
        'title',
        'addTags',
        'removeTags',
        'addContent',
        'setParagraphs',
        'moveParagraphs',
        'removeParagraphs',
        'expects'
    ],
    remove: ['verb', 'id', 'expects']
};

// Nested item shapes. `setParagraphs` distinguishes ABSENT from PRESENT (an omitted `tags`
// leaves the stored tags alone; `tags: []` clears them), so its reader checks these keys
// against the raw item rather than against a normalized object.
const CONTENT_ITEM_KEYS = ['text', 'tags', 'refs', 'id'] as const;
const SET_ITEM_KEYS = ['id', 'text', 'tags', 'refs'] as const;
const MOVE_ITEM_KEYS = ['id', 'before'] as const;
const REF_ITEM_KEYS = ['articleId', 'paragraphId', 'note'] as const;
const EXPECT_ITEM_KEYS = ['id', 'rev'] as const;

const VERB_LIST = KNOWLEDGE_OPERATION_VERBS.map((verb) => `"${verb}"`).join(', ');

// Membership test for a `verb` argument. A Set, not `OPERATION_KEYS[verb]`: an object index
// answers truthy for `"constructor"` and `"toString"` through the prototype, which would route
// a typo to a handler that does not exist instead of refusing it by name.
const VERB_SET = new Set<KnowledgeVerb>(KNOWLEDGE_OPERATION_VERBS);

const verbList = (keys: readonly string[]): string => keys.map((key) => `"${key}"`).join(', ');

// ---------------------------------------------------------------------------
// Argument readers (engine-wide, label-first — the records readers' shape)
// ---------------------------------------------------------------------------

// A JSON object that is not an array. Arrays are refused because `[1,2]` is valid JSON but
// cannot carry an operation, and accepting it would make the error less specific than the
// schema suggests.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const readOperationRecord = (value: unknown, label: Label): Record<string, unknown> => {
    if (!isRecord(value)) {
        throw inputError(
            `${label} takes a JSON object; received ${
                Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value
            }.`
        );
    }

    return value;
};

// Exact-key check for a nested item, sharing records' wording (`has no field "x"`) so a
// caller learns one rule rather than two.
const readItemKeys = (record: Record<string, unknown>, allowed: readonly string[], label: Label): void => {
    const permitted = new Set<string>(allowed);

    for (const key of Object.keys(record)) {
        if (permitted.has(key)) continue;

        throw inputError(`${label} has no field "${key}"; it takes ${verbList(allowed)} — fix the name or drop it.`);
    }
};

// A uuid argument. `field` is the field path the message quotes, spelled by the CALLER
// (`'"id"'`, or `'"paragraphs" item 0'`), because the same reader serves a top-level `id`, an
// element of an id array, and a nested reference — and a refusal that names `"id"` when the
// caller typed `articleId` sends them editing the wrong key.
const readIdArgument = (label: Label, field: string, value: unknown, advice: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw inputError(`${label} requires ${field} to be a uuid string; ${advice}`);
    }

    const id = canonicalId(value);

    if (!KNOWLEDGE_UUID_PATTERN.test(id)) {
        throw knowledgeError('EKNOWLEDGE_ID', `${label} ${field} is "${value}", which is not a uuid; ${advice}`);
    }

    return id;
};

// An array of uuids: a paragraph selection, a removal list. Empty is legal (a no-op list,
// which the engine reports as `noop`), duplicates are refused because the caller asked for
// the same row twice and one of the two answers is a lie.
const readIdArray = (label: Label, field: string, value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;

    if (!Array.isArray(value)) {
        throw inputError(`${label} "${field}" must be an array of uuid strings.`);
    }

    if (value.length > KNOWLEDGE_MAX_ITEMS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "${field}" carries ${value.length} ids, over the KNOWLEDGE_MAX_ITEMS limit of ${KNOWLEDGE_MAX_ITEMS}; send at most ${KNOWLEDGE_MAX_ITEMS} ids per call.`
        );
    }

    const ids: string[] = [];
    const seen = new Set<string>();

    for (const [index, entry] of value.entries()) {
        // The element is named, not just the array: "paragraphs is \"2\"" would send the caller
        // looking for a scalar argument they never sent.
        const id = readIdArgument(label, `"${field}" item ${index}`, entry, 'ids are uuids the engine assigned.');
        if (seen.has(id)) {
            throw knowledgeError(
                'EKNOWLEDGE_ID',
                `${label} "${field}" names "${id}" twice; name each id once per call.`
            );
        }

        seen.add(id);
        ids.push(id);
    }

    return ids;
};

const readBooleanArgument = (label: Label, field: string, value: unknown): boolean => {
    if (value === undefined) return false;

    if (typeof value !== 'boolean') {
        throw inputError(`${label} "${field}" must be a boolean when provided.`);
    }

    return value;
};

const readOffsetArgument = (label: Label, value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "offset" is ${String(value)}, which is not a non-negative integer; pass an offset the previous page's "nextOffset" gave you.`
        );
    }

    return value as number;
};

const readLimitArgument = (label: Label, value: unknown): number => {
    if (value === undefined) return KNOWLEDGE_LIST_DEFAULT_LIMIT;

    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > KNOWLEDGE_LIST_MAX_LIMIT) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "limit" is ${String(value)}, outside the 1-${KNOWLEDGE_LIST_MAX_LIMIT} range the KNOWLEDGE_LIST_MAX_LIMIT bound allows; pass a limit between 1 and ${KNOWLEDGE_LIST_MAX_LIMIT}.`
        );
    }

    return value as number;
};

// The `read` window: `from` is a paragraph index and `limit` is bounded by what an article
// can hold, not by the page limit — a read window is a slice of one article, and the reader
// already paid for the article to exist.
const readFromArgument = (label: Label, value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "from" is ${String(value)}, which is not a non-negative paragraph index; the outline says how many paragraphs the article holds.`
        );
    }

    return value as number;
};

const readWindowLimitArgument = (label: Label, value: unknown): number | undefined => {
    if (value === undefined) return undefined;

    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > KNOWLEDGE_MAX_PARAGRAPHS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "limit" is ${String(value)}, outside the 1-${KNOWLEDGE_MAX_PARAGRAPHS} range one article's paragraphs allow (KNOWLEDGE_MAX_PARAGRAPHS); pass a limit between 1 and ${KNOWLEDGE_MAX_PARAGRAPHS}.`
        );
    }

    return value as number;
};

// A title: trimmed, never empty, and short enough to read in a page row. An empty title is
// refused rather than defaulted — a title is how anything finds this article again.
const readTitle = (label: Label, value: unknown): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw inputError(
            `${label} requires a non-empty "title" string; the title is how a later session finds this article again.`
        );
    }

    const title = value.trim();

    if (title.length > KNOWLEDGE_MAX_TITLE) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "title" is ${title.length} characters, over the KNOWLEDGE_MAX_TITLE limit of ${KNOWLEDGE_MAX_TITLE}; shorten it and put the detail in a paragraph.`
        );
    }

    return title;
};

// One paragraph's text: trimmed at the edges (the stored form, so two agents restating the
// same sentence do not churn `rev` over invisible whitespace) and capped.
const readParagraphText = (label: Label, value: unknown, where: string): string => {
    if (typeof value !== 'string') {
        throw inputError(`${label} ${where} "text" must be a string.`);
    }

    const text = value.trim();

    if (text.length === 0) {
        throw inputError(
            `${label} ${where} "text" holds no non-space character; remove the paragraph instead of emptying it.`
        );
    }

    if (text.length > KNOWLEDGE_MAX_TEXT) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} ${where} "text" is ${text.length} characters, over the KNOWLEDGE_MAX_TEXT limit of ${KNOWLEDGE_MAX_TEXT}; split it into two paragraphs.`
        );
    }

    return text;
};

// Tags: trimmed, non-empty, deduped case-insensitively keeping the FIRST spelling (the
// stored spelling is what a page echoes), capped twice over.
const readTags = (label: Label, field: string, value: unknown): string[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw inputError(`${label} "${field}" must be an array of tag strings.`);
    }

    if (value.length > KNOWLEDGE_MAX_TAGS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "${field}" carries ${value.length} tags, over the KNOWLEDGE_MAX_TAGS limit of ${KNOWLEDGE_MAX_TAGS}; keep the tags a search would actually filter on.`
        );
    }

    const tags: string[] = [];
    const seen = new Set<string>();

    for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim().length === 0) {
            throw inputError(`${label} "${field}" holds "${String(entry)}", which is not a non-empty tag string.`);
        }

        const tag = entry.trim();

        if (tag.length > KNOWLEDGE_MAX_TAG) {
            throw knowledgeError(
                'EKNOWLEDGE_LIMIT',
                `${label} "${field}" holds a tag of ${tag.length} characters ("${tag.slice(0, 24)}…"), over the KNOWLEDGE_MAX_TAG limit of ${KNOWLEDGE_MAX_TAG}; shorten it.`
            );
        }

        const key = tag.toLowerCase();
        if (seen.has(key)) continue;

        seen.add(key);
        tags.push(tag);
    }

    return tags;
};

// An article-level tag EDIT: additions merged into the stored list (case-insensitive dedupe,
// stored order first, additions appended in call order), then removals subtracted. A tag
// named by BOTH nets out removed, which is the only reading of "add then remove" that does
// not depend on an unstated ordering.
const mergeTags = (stored: readonly string[], added: readonly string[], removed: readonly string[]): string[] => {
    const dropped = new Set(removed.map((tag) => tag.toLowerCase()));
    const seen = new Set<string>();
    const merged: string[] = [];

    for (const tag of [...stored, ...added]) {
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(tag);
    }

    return merged.filter((tag) => !dropped.has(tag.toLowerCase()));
};

const sameTags = (left: readonly string[] | undefined, right: readonly string[] | undefined): boolean => {
    const a = left ?? [];
    const b = right ?? [];

    // Case-INSENSITIVE equality: two spellings of one tag are one tag, and bumping a
    // paragraph `rev` for a case change would be the whitespace churn this engine refuses
    // everywhere else.
    return a.length === b.length && a.every((tag, index) => tag.toLowerCase() === (b[index] ?? '').toLowerCase());
};

// Ordered equality of two ALREADY-normalized tag lists — used by the article-tag step, where
// `mergeTags` has deduped and subtracted and the only question left is whether the stored
// document changed. Element-wise rather than joined on a delimiter: a tag may hold any
// printable character, so no separator is safe, and a NUL delimiter would put a control byte
// in this file's own source.
const sameTagList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((tag, index) => tag === right[index]);

// Links: capped, and canonicalized so an optional key that arrives empty is ABSENT in the
// stored shape (the records absent-vs-undefined rule). Exact duplicates collapse; two links
// to one target with different notes are two statements and both survive.
const readRefs = (label: Label, field: string, value: unknown): KnowledgeReference[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw inputError(`${label} "${field}" must be an array of reference objects.`);
    }

    if (value.length > KNOWLEDGE_MAX_REFS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "${field}" carries ${value.length} references, over the KNOWLEDGE_MAX_REFS limit of ${KNOWLEDGE_MAX_REFS} per paragraph; keep the links a reader would follow.`
        );
    }

    const refs: KnowledgeReference[] = [];
    const seen = new Set<string>();

    for (const [index, entry] of value.entries()) {
        const where = `"${field}" item ${index}`;
        const record = readOperationRecord(entry, `${label} ${where}`);

        readItemKeys(record, REF_ITEM_KEYS, `${label} ${where}`);

        const articleId = readIdArgument(
            `${label} ${where}`,
            '"articleId"',
            record.articleId,
            'a reference names an article by its uuid.'
        );

        let paragraphId: string | undefined;

        if (record.paragraphId !== undefined) {
            paragraphId = readIdArgument(
                `${label} ${where}`,
                '"paragraphId"',
                record.paragraphId,
                'omit "paragraphId" to link the whole article.'
            );
        }

        let note: string | undefined;

        if (record.note !== undefined) {
            if (typeof record.note !== 'string') {
                throw inputError(`${label} ${where} "note" must be a string.`);
            }

            const trimmed = record.note.trim();

            if (trimmed.length > KNOWLEDGE_MAX_NOTE) {
                throw knowledgeError(
                    'EKNOWLEDGE_LIMIT',
                    `${label} ${where} "note" is ${trimmed.length} characters, over the KNOWLEDGE_MAX_NOTE limit of ${KNOWLEDGE_MAX_NOTE}; say why in one line.`
                );
            }

            // An all-space note is an ABSENT note: a stored `note: ''` would serialize as a
            // key that carries no information and reads like a truncated one.
            if (trimmed.length > 0) note = trimmed;
        }

        const ref: KnowledgeReference = {
            articleId,
            ...(paragraphId === undefined ? {} : { paragraphId }),
            ...(note === undefined ? {} : { note })
        };

        const key = `${articleId}\u0000${paragraphId ?? ''}\u0000${note ?? ''}`;
        if (seen.has(key)) continue;

        seen.add(key);
        refs.push(ref);
    }

    return refs;
};

// Two refs lists compared as VALUES, so a `setParagraphs` that resends the stored links does
// not bump `rev`. Order matters: a link list is a list, and reordering it is an edit.
const sameRefs = (
    left: readonly KnowledgeReference[] | undefined,
    right: readonly KnowledgeReference[] | undefined
): boolean => {
    const a = left ?? [];
    const b = right ?? [];

    if (a.length !== b.length) return false;

    return a.every((ref, index) => {
        const other = b[index];

        return (
            other !== undefined &&
            ref.articleId === other.articleId &&
            (ref.paragraphId ?? '') === (other.paragraphId ?? '') &&
            (ref.note ?? '') === (other.note ?? '')
        );
    });
};

// One paragraph as the CALLER described it, normalized for the apply loops.
type ParsedContent = {
    id?: string;
    text: string;
    tags: string[];
    refs: KnowledgeReference[];
};

const readContentItems = (label: Label, field: string, value: unknown): ParsedContent[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw inputError(`${label} "${field}" must be an array of paragraph strings or objects.`);
    }

    if (value.length > KNOWLEDGE_MAX_ITEMS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "${field}" carries ${value.length} paragraphs, over the KNOWLEDGE_MAX_ITEMS limit of ${KNOWLEDGE_MAX_ITEMS} per call; send the rest in a second call.`
        );
    }

    return value.map((entry, index): ParsedContent => {
        // The field is QUOTED in the item path, the way every other nested list labels itself
        // (`"setParagraphs" item 0` below): one spelling of "which item of which field" across
        // the whole code space, because a model is the reader.
        const where = `"${field}" item ${index}`;

        // A bare string is the common shape ("text only"), and the shorthand is what keeps a
        // three-paragraph create typeable at all.
        if (typeof entry === 'string') {
            return { text: readParagraphText(label, entry, where), tags: [], refs: [] };
        }

        const record = readOperationRecord(entry, `${label} ${where}`);

        readItemKeys(record, CONTENT_ITEM_KEYS, `${label} ${where}`);

        if (record.text === undefined) {
            throw inputError(`${label} ${where} requires "text" (or pass the paragraph as a plain string).`);
        }

        return {
            ...(record.id === undefined
                ? {}
                : {
                      id: readIdArgument(
                          `${label} ${where}`,
                          '"id"',
                          record.id,
                          'pin a uuid of your own, or omit "id" and let the engine assign one.'
                      )
                  }),
            text: readParagraphText(label, record.text, where),
            tags: readTags(`${label} ${where}`, 'tags', record.tags),
            refs: readRefs(`${label} ${where}`, 'refs', record.refs)
        };
    });
};

// One `setParagraphs` entry. `hasText`/`hasTags`/`hasRefs` carry ABSENT-vs-PRESENT through
// the normalization, because "leave the tags alone" and "clear the tags" are different asks.
type ParsedSet = {
    id: string;
    hasText: boolean;
    text?: string;
    hasTags: boolean;
    tags?: string[];
    hasRefs: boolean;
    refs?: KnowledgeReference[];
};

const readSetItems = (label: Label, value: unknown): ParsedSet[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw inputError(`${label} "setParagraphs" must be an array of { id, text?, tags?, refs? } objects.`);
    }

    if (value.length > KNOWLEDGE_MAX_ITEMS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "setParagraphs" carries ${value.length} entries, over the KNOWLEDGE_MAX_ITEMS limit of ${KNOWLEDGE_MAX_ITEMS} per call; send the rest in a second call.`
        );
    }

    return value.map((entry, index): ParsedSet => {
        const where = `"setParagraphs" item ${index}`;
        const record = readOperationRecord(entry, `${label} ${where}`);

        readItemKeys(record, SET_ITEM_KEYS, `${label} ${where}`);

        const id = readIdArgument(
            `${label} ${where}`,
            '"id"',
            record.id,
            'read the article for its paragraph ids, or use "addContent" to append a new one.'
        );

        return {
            id,
            hasText: record.text !== undefined,
            ...(record.text === undefined ? {} : { text: readParagraphText(label, record.text, where) }),
            hasTags: record.tags !== undefined,
            ...(record.tags === undefined ? {} : { tags: readTags(`${label} ${where}`, 'tags', record.tags) }),
            hasRefs: record.refs !== undefined,
            ...(record.refs === undefined ? {} : { refs: readRefs(`${label} ${where}`, 'refs', record.refs) })
        };
    });
};

type ParsedMove = { id: string; before?: string };

const readMoveItems = (label: Label, value: unknown): ParsedMove[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw inputError(`${label} "moveParagraphs" must be an array of { id, before? } objects.`);
    }

    if (value.length > KNOWLEDGE_MAX_ITEMS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "moveParagraphs" carries ${value.length} entries, over the KNOWLEDGE_MAX_ITEMS limit of ${KNOWLEDGE_MAX_ITEMS} per call.`
        );
    }

    return value.map((entry, index): ParsedMove => {
        const where = `"moveParagraphs" item ${index}`;
        const record = readOperationRecord(entry, `${label} ${where}`);

        readItemKeys(record, MOVE_ITEM_KEYS, `${label} ${where}`);

        const id = readIdArgument(`${label} ${where}`, '"id"', record.id, 'the outline lists the paragraph ids.');

        return {
            id,
            ...(record.before === undefined
                ? {}
                : {
                      before: readIdArgument(
                          `${label} ${where}`,
                          '"before"',
                          record.before,
                          'omit "before" to move the paragraph to the end.'
                      )
                  })
        };
    });
};

// The CAS tokens. One article per call, so a token naming a different article is a refusal
// rather than a guard nobody can satisfy: with `expects: [{otherId, rev}]` the caller
// believes it is protected against a change to `otherId` and is not.
const readExpects = (label: Label, value: unknown): KnowledgeExpect[] | undefined => {
    if (value === undefined) return undefined;

    if (!Array.isArray(value)) {
        throw inputError(`${label} "expects" must be an array of { id, rev } objects.`);
    }

    if (value.length > KNOWLEDGE_MAX_ITEMS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} "expects" carries ${value.length} tokens, over the KNOWLEDGE_MAX_ITEMS limit of ${KNOWLEDGE_MAX_ITEMS} per call.`
        );
    }

    const expects: KnowledgeExpect[] = [];
    const byId = new Map<string, number>();

    for (const [index, entry] of value.entries()) {
        const where = `"expects" item ${index}`;
        const record = readOperationRecord(entry, `${label} ${where}`);

        readItemKeys(record, EXPECT_ITEM_KEYS, `${label} ${where}`);

        const id = readIdArgument(
            `${label} ${where}`,
            '"id"',
            record.id,
            'the token names the article this call writes.'
        );

        if (!Number.isSafeInteger(record.rev) || (record.rev as number) < 1) {
            throw inputError(
                `${label} ${where} "rev" is ${String(record.rev)}, which is not a revision the engine ever mints; pass the "rev" the last read reported.`
            );
        }

        const rev = record.rev as number;
        const prior = byId.get(id);

        if (prior !== undefined) {
            if (prior !== rev) {
                throw knowledgeError(
                    'EKNOWLEDGE_ID',
                    `${label} "expects" gives article "${id}" two different tokens (${prior} and ${rev}); pass one token per article.`
                );
            }

            continue;
        }

        byId.set(id, rev);
        expects.push({ id, rev });
    }

    return expects;
};

// ---------------------------------------------------------------------------
// Detached copies and projections
// ---------------------------------------------------------------------------
//
// Copy on the way out, ALWAYS (records.ts:299-339 restated): a caller — or a model-visible
// result — must never hold a reference into the live store, or `result.article.content[0].text
// = 'x'` in a UI would rewrite knowledge behind the engine's back. Key order is fixed and
// optional keys stay ABSENT, so the serialized shape the byte budget measures is the shape
// the caller receives.

const copyRef = (ref: KnowledgeReference): KnowledgeReference => ({
    articleId: ref.articleId,
    ...(ref.paragraphId === undefined ? {} : { paragraphId: ref.paragraphId }),
    ...(ref.note === undefined ? {} : { note: ref.note })
});

const copyParagraph = (paragraph: KnowledgeParagraph): KnowledgeParagraph => ({
    id: paragraph.id,
    text: paragraph.text,
    rev: paragraph.rev,
    createdAt: paragraph.createdAt,
    updatedAt: paragraph.updatedAt,
    ...(paragraph.tags === undefined ? {} : { tags: [...paragraph.tags] }),
    ...(paragraph.refs === undefined ? {} : { refs: paragraph.refs.map(copyRef) })
});

// Both projections carry the optional owner CONDITIONALLY: an unowned article must serialize
// to exactly the pre-T6 shape (every existing stored file and every existing test row), while
// an owned one keeps the attribution through copy/snapshot/persist/modify. `harness` is a
// string, so no defensive copy is needed.
const copyArticle = (article: KnowledgeArticle): KnowledgeArticle => ({
    id: article.id,
    title: article.title,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    tags: [...article.tags],
    content: article.content.map(copyParagraph),
    rev: article.rev,
    ...(article.harness === undefined ? {} : { harness: article.harness })
});

// The read projections expose ownership as provenance (see `KnowledgeArticleMeta.harness`), but
// only when there is an owner: a pre-T6 article's row is byte-identical to what it was.
const metaOf = (article: KnowledgeArticle): KnowledgeArticleMeta => ({
    id: article.id,
    title: article.title,
    tags: [...article.tags],
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    rev: article.rev,
    ...(article.harness === undefined ? {} : { harness: article.harness })
});

// A page row: metadata + paragraph count, and NOTHING else. This is the drill-in step, so
// bodies are absent rather than emptied — an article with `paragraphs: []` in a row would
// read as "this article is empty", which is a different fact from "this page shows no bodies".
const summaryOf = (article: KnowledgeArticle): KnowledgeArticleSummary => ({
    ...metaOf(article),
    paragraphCount: article.content.length
});

// One outline row: everything about a paragraph except its text, plus the size the caller
// needs to decide whether reading it is worth the context.
const outlineOf = (paragraph: KnowledgeParagraph): KnowledgeOutlineEntry => ({
    id: paragraph.id,
    rev: paragraph.rev,
    updatedAt: paragraph.updatedAt,
    chars: paragraph.text.length,
    ...(paragraph.tags === undefined ? {} : { tags: [...paragraph.tags] }),
    ...(paragraph.refs === undefined ? {} : { refs: paragraph.refs.map(copyRef) })
});

// The id a refusal reports for a reference that does not resolve: the paragraph id when the
// paragraph is what is missing, otherwise the article id. One rule everywhere `danglingRefs`
// is emitted, so a caller can treat the list as "ids that are gone".
const missingIdOf = (ref: KnowledgeReference): string => ref.paragraphId ?? ref.articleId;

// ---------------------------------------------------------------------------
// Snapshot validation (the strict reader `restore` and the file layer share)
// ---------------------------------------------------------------------------
//
// JSON read back from disk is UNTRUSTED input even when this process wrote it (the
// ./snapshot-validation.ts header, and the reason the file layer validates through here
// rather than trusting its own last write). Rules, in the words this module enforces:
//   - exact key sets at every level, so a schema change is one loud refusal instead of a
//     silently half-restored store;
//   - ids are uuids, unique — an article id twice, or a paragraph id shared by two articles,
//     would make every `refs` target ambiguous and every `read { paragraphs }` a coin flip;
//   - the bounds are re-checked, because a file written under looser bounds must not become a
//     store the running engine cannot answer;
//   - dates are ISO-8601 and are returned VERBATIM (a normalized date would make a restored
//     snapshot differ from the one that was saved, which is the round-trip fidelity
//     ./knowledge.test.ts pins).
//
// WHAT IS NOT CHECKED, and why that is a decision rather than an omission: `refs` targets are
// NOT resolved. A dangling reference is a LEGAL stored state (a target article was removed on
// purpose), so refusing a snapshot because of one would make it impossible to persist the
// aftermath of a removal — and a file written after one removal would then never load again.

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const readStoredDate = (value: unknown, label: string): string => {
    const text = readSnapshotString(value, label, { min: 1 });

    if (!ISO_DATE_PATTERN.test(text) || !Number.isFinite(Date.parse(text))) {
        throw knowledgeError(
            'EKNOWLEDGE_INPUT',
            `${label} is "${text}", which is not an ISO-8601 timestamp; the engine writes dates as Date#toISOString() renders them.`
        );
    }

    return text;
};

const readStoredId = (value: unknown, label: string, taken: Set<string>): string => {
    const text = readSnapshotString(value, label, { min: 1 });

    if (!KNOWLEDGE_UUID_PATTERN.test(text)) {
        throw knowledgeError(
            'EKNOWLEDGE_ID',
            `${label} is "${text}", which is not a uuid; every knowledge id is uuid v4 text the engine minted.`
        );
    }

    const id = canonicalId(text);

    if (taken.has(id)) {
        throw knowledgeError(
            'EKNOWLEDGE_ID',
            `${label} repeats the id "${id}", which this state already uses; ids are unique across the whole store, so one paragraph may not share an id with another.`
        );
    }

    taken.add(id);

    return id;
};

const readStoredTags = (value: unknown, label: string): string[] => {
    const list = readSnapshotArray(value, label);

    if (list.length > KNOWLEDGE_MAX_TAGS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} holds ${list.length} tags, over the KNOWLEDGE_MAX_TAGS limit of ${KNOWLEDGE_MAX_TAGS}.`
        );
    }

    return list.map((entry, index): string => {
        const tag = readSnapshotString(entry, `${label}[${index}]`, { min: 1 }).trim();

        if (tag.length === 0) {
            throw knowledgeError(
                'EKNOWLEDGE_INPUT',
                `${label}[${index}] is blank; a tag holds at least one character.`
            );
        }

        if (tag.length > KNOWLEDGE_MAX_TAG) {
            throw knowledgeError(
                'EKNOWLEDGE_LIMIT',
                `${label}[${index}] is ${tag.length} characters, over the KNOWLEDGE_MAX_TAG limit of ${KNOWLEDGE_MAX_TAG}.`
            );
        }

        return tag;
    });
};

// The owner token on a stored article (T6). It is the canonical harness NAME, so it is bounded
// by the registry's own 64-character name cap (`../server/harnesses/registry.ts` `NAME_PATTERN`)
// rather than by a second grammar: this reader validates SIZE only, because a future registry
// may admit a name today's pattern does not, and a stored article must stay readable across
// that change. Blank and whitespace-only values are refused — absent is the unowned spelling,
// and "owned by nothing" would make the cleanup filter silently wrong.
const readStoredHarness = (value: unknown, label: string): string => {
    const owner = readSnapshotString(value, label, { min: 1, max: KNOWLEDGE_MAX_TAG }).trim();

    if (owner.length === 0) {
        throw knowledgeError(
            'EKNOWLEDGE_INPUT',
            `${label} is blank; an article either names the harness that created it or omits the field (unowned).`
        );
    }

    return owner;
};

const readStoredRefs = (value: unknown, label: string): KnowledgeReference[] => {
    const list = readSnapshotArray(value, label);

    if (list.length > KNOWLEDGE_MAX_REFS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} holds ${list.length} references, over the KNOWLEDGE_MAX_REFS limit of ${KNOWLEDGE_MAX_REFS}.`
        );
    }

    return list.map((entry, index): KnowledgeReference => {
        const where = `${label}[${index}]`;
        const record = readSnapshotRecord(entry, where);

        // Same rule as the paragraph above: the permitted set is the FULL shape, and only the
        // fourth argument marks what may be absent. A stored reference with a `paragraphId` or a
        // `note` is ordinary knowledge, not an unknown field.
        readSnapshotKeys(record, ['articleId', 'paragraphId', 'note'], where, ['paragraphId', 'note']);

        const articleId = readStoredId(record.articleId, `${where}.articleId`, new Set<string>());

        return {
            articleId,
            ...(record.paragraphId === undefined
                ? {}
                : { paragraphId: readStoredId(record.paragraphId, `${where}.paragraphId`, new Set<string>()) }),
            ...(record.note === undefined
                ? {}
                : { note: readSnapshotString(record.note, `${where}.note`, { min: 1, max: KNOWLEDGE_MAX_NOTE }) })
        };
    });
};

const readStoredParagraph = (
    value: unknown,
    label: string,
    articleId: string,
    paragraphIds: Set<string>
): KnowledgeParagraph => {
    const record = readSnapshotRecord(value, label);

    // `readSnapshotKeys` takes the FULL permitted set and then the subset of it that may be
    // absent (../snapshot-validation.ts:120-141). Passing the optional keys only in the fourth
    // argument would make a stored `tags`/`refs` an UNKNOWN field, which is a worse failure
    // than a typo: the engine writes those keys itself, so its own snapshots would not load.
    readSnapshotKeys(record, ['id', 'text', 'rev', 'createdAt', 'updatedAt', 'tags', 'refs'], label, ['tags', 'refs']);

    const id = readStoredId(record.id, `${label}.id`, paragraphIds);
    const text = readSnapshotString(record.text, `${label}.text`, { min: 1 }).trim();

    if (text.length === 0) {
        throw knowledgeError(
            'EKNOWLEDGE_INPUT',
            `${label}.text is blank; article "${articleId}" should not carry an empty paragraph, so drop it.`
        );
    }

    if (text.length > KNOWLEDGE_MAX_TEXT) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label}.text is ${text.length} characters, over the KNOWLEDGE_MAX_TEXT limit of ${KNOWLEDGE_MAX_TEXT}.`
        );
    }

    return {
        id,
        text,
        rev: readSnapshotInteger(record.rev, `${label}.rev`, { min: 1, max: Number.MAX_SAFE_INTEGER }),
        createdAt: readStoredDate(record.createdAt, `${label}.createdAt`),
        updatedAt: readStoredDate(record.updatedAt, `${label}.updatedAt`),
        ...(record.tags === undefined ? {} : { tags: readStoredTags(record.tags, `${label}.tags`) }),
        ...(record.refs === undefined ? {} : { refs: readStoredRefs(record.refs, `${label}.refs`) })
    };
};

const readStoredArticle = (
    value: unknown,
    label: string,
    articleIds: Set<string>,
    paragraphIds: Set<string>
): KnowledgeArticle => {
    const record = readSnapshotRecord(value, label);

    // `harness` is the one MAY-BE-ABSENT article field (see `KnowledgeArticle.harness`): absent
    // is the unowned spelling, and requiring it would make every pre-T6 file unreadable. Passing
    // it in the fourth argument is what keeps it out of the "unknown field" refusal; leaving it
    // out of the permitted list entirely would do the same for a NEW file, which is the failure
    // this reader exists to prevent.
    readSnapshotKeys(
        record,
        ['id', 'title', 'createdAt', 'updatedAt', 'tags', 'content', 'rev', 'harness'],
        label,
        ['harness']
    );

    const id = readStoredId(record.id, `${label}.id`, articleIds);
    const title = readSnapshotString(record.title, `${label}.title`, { min: 1 }).trim();

    if (title.length === 0) {
        throw knowledgeError('EKNOWLEDGE_INPUT', `${label}.title is blank; a knowledge article is found by its title.`);
    }

    if (title.length > KNOWLEDGE_MAX_TITLE) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label}.title is ${title.length} characters, over the KNOWLEDGE_MAX_TITLE limit of ${KNOWLEDGE_MAX_TITLE}.`
        );
    }

    const content = readSnapshotArray(record.content, `${label}.content`);

    if (content.length > KNOWLEDGE_MAX_PARAGRAPHS) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label}.content holds ${content.length} paragraphs, over the KNOWLEDGE_MAX_PARAGRAPHS limit of ${KNOWLEDGE_MAX_PARAGRAPHS}.`
        );
    }

    return {
        id,
        title,
        createdAt: readStoredDate(record.createdAt, `${label}.createdAt`),
        updatedAt: readStoredDate(record.updatedAt, `${label}.updatedAt`),
        tags: readStoredTags(record.tags, `${label}.tags`),
        content: content.map((entry, index) =>
            readStoredParagraph(entry, `${label}.content[${index}]`, id, paragraphIds)
        ),
        rev: readSnapshotInteger(record.rev, `${label}.rev`, { min: 1, max: Number.MAX_SAFE_INTEGER }),
        ...(record.harness === undefined ? {} : { harness: readStoredHarness(record.harness, `${label}.harness`) })
    };
};

// The strict reader for a whole store: the exact input `restore` takes, and the same check
// ../server/knowledge-file-store.ts runs on a file it just read back. It returns DETACHED
// copies, so a caller that mutates what it got cannot reach the parsed input.
export const readKnowledgeStoreState = (value: unknown): KnowledgeStoreState => {
    const root = readSnapshotRecord(value, 'knowledge state');

    readSnapshotKeys(root, ['storeRev', 'articles'], 'knowledge state');

    const storeRev = readSnapshotInteger(root.storeRev, 'knowledge state.storeRev', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER
    });

    const raw = readSnapshotArray(root.articles, 'knowledge state.articles');

    if (raw.length > KNOWLEDGE_MAX_ARTICLES) {
        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `knowledge state.articles holds ${raw.length} articles, over the KNOWLEDGE_MAX_ARTICLES limit of ${KNOWLEDGE_MAX_ARTICLES}; remove an article before restoring.`
        );
    }

    const articleIds = new Set<string>();
    const paragraphIds = new Set<string>();

    return {
        storeRev,
        articles: raw.map((entry, index) =>
            readStoredArticle(entry, `knowledge state.articles[${index}]`, articleIds, paragraphIds)
        )
    };
};

// ---------------------------------------------------------------------------
// The stale-refusal payload (records' R9, at article grain)
// ---------------------------------------------------------------------------
//
// The refusal carries what the caller needs for its NEXT call — the current `rev` and, for a
// paragraph-level retry, the paragraph ids and revs. When the whole article fits the budget it
// rides verbatim; when it does not, the payload degrades to metadata + OUTLINE and the message
// and `details.projected` both say so, because a degradation the caller can read is a different
// thing from a silent cut (records.ts:1209-1249).
// `value` is the structured twin `error.details.article` carries, and it is the SAME object
// `json` serializes — one projection, so the caller that reads `details` and the model that
// reads the message are never shown two different payloads (records passes
// `copyEntry(definition, entry, projected === false)` for the same reason).
type StalePayload = { value: unknown; json: string; projected: boolean; note?: string };

const stalePayloadOf = (article: KnowledgeArticle): StalePayload => {
    const full = copyArticle(article);
    const fullJson = JSON.stringify(full);

    if (modelPayloadBytes(fullJson) <= KNOWLEDGE_STALE_PAYLOAD_BUDGET_BYTES) {
        return { value: full, json: fullJson, projected: false };
    }

    const projected = {
        ...metaOf(article),
        paragraphCount: article.content.length,
        outline: article.content.map(outlineOf)
    };

    return {
        value: projected,
        json: JSON.stringify(projected),
        projected: true,
        note: 'paragraph text omitted'
    };
};

// The one message every rejected CAS write shows: the token the caller sent, the token the
// store holds, when it moved, the retry token spelled out, and the CURRENT article.
const staleArticleError = (label: Label, article: KnowledgeArticle, expected: number): HarnessError => {
    const payload = stalePayloadOf(article);

    return knowledgeError(
        'EKNOWLEDGE_REV',
        `${label} refused article "${article.id}" at revision ${expected}: the store holds revision ${article.rev}, last modified at ${article.updatedAt}. ` +
            `Retry with "expects" [{ id: "${article.id}", rev: ${article.rev} }] after re-reading the paragraphs you want to change. ` +
            `current: ${payload.json}${payload.projected ? ` (${payload.note})` : ''}`,
        {
            id: article.id,
            expectedRev: expected,
            currentRev: article.rev,
            updatedAt: article.updatedAt,
            projected: payload.projected,
            ...(payload.note === undefined ? {} : { note: payload.note }),
            article: payload.value
        }
    );
};

// The trusted owner carrier (T6/T11), read from the LIVE harness handle the tool context
// carries. `harness.knowledgeOwner` is a constructor-time, host-supplied identity (../harness.ts
// builds it from `HarnessConfiguration.knowledgeOwner`); nothing in an operation or model message
// can reach it. A hand-built context can still hold anything, so the guard here is total:
// non-string and whitespace-only values mean "no identity", i.e. an unowned article. That is the
// safe reading — an unowned article is preserved by owner-based cleanup, while guessing an owner
// could delete somebody else's knowledge.
//
// NORMALIZATION HAPPENS HERE, ONCE: trimming before any length check is what stops surrounding
// whitespace from smuggling an over-limit name past the create boundary below. The MAX bound is
// enforced at that boundary rather than here, because `ownerOfContext` runs for every verb and a
// malformed host token must not make reads fail.
const ownerOfContext = (context: ToolContext | undefined): string | undefined => {
    const candidate = context?.harness?.knowledgeOwner;

    if (typeof candidate !== 'string') return undefined;

    const owner = candidate.trim();

    return owner.length === 0 ? undefined : owner;
};

// The CREATE boundary for the trusted owner (T11). `harness.ts` validates a configured owner and
// `readStoredHarness` validates a stored one, but `KnowledgeEngine.execute` is public and can be
// handed a hand-built ToolContext. Without this check such a context could stamp a 65+ character
// owner into the live store and its SNAPSHOT, which the durable reader then rejects on the next
// load — a write that can prevent startup. Refuse instead, before the clock is read or an id is
// minted, so a rejected input leaves the store byte-identical. The model cannot reach this path:
// `knowledgeOwner` is host configuration, not an operation key.
const readCreationOwner = (owner: string | undefined, label: Label): string | undefined => {
    if (owner === undefined) return undefined;

    if (owner.length > KNOWLEDGE_MAX_TAG) {
        throw knowledgeError(
            'EKNOWLEDGE_INPUT',
            `${label} refused: the trusted harness owner is ${owner.length} characters, over the ${KNOWLEDGE_MAX_TAG}-character harness name limit. An article owner is written by the host (HarnessConfiguration.knowledgeOwner), never by an operation; shorten the name or leave it unset.`
        );
    }

    return owner;
};

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

// What `createKnowledgeEngine()` returns is declared once, in ../types
// (`KnowledgeEngine`), so the tool layer, the file layer and this file agree on one shape.
export const createKnowledgeEngine = (options: KnowledgeEngineOptions = {}): KnowledgeEngine => {
    // Insertion order is CREATION order, which is what a restored store pages in before any
    // ranking is applied (and what `snapshot` writes). A Map, because an article titled
    // "constructor" must not inherit the prototype (records.ts:2529-2531, same reasoning).
    const articles = new Map<string, KnowledgeArticle>();

    // The two deterministic seams. Validated ON USE, not at construction: an engine built
    // with a bad clock still answers a `list`, and the refusal then says which knob is broken
    // rather than storing a forged timestamp nobody can re-parse.
    const clock = options.now ?? ((): number => Date.now());
    const source = options.ids ?? ((): string => randomUUID());

    // The store watermark: +1 per COMMITTED operation, persisted in KnowledgeStoreState. What it
    // IS: the store-level counter `index.json` carries (`KnowledgeDirectoryIndex.storeRev`,
    // ../server/knowledge-file-store.ts:355-368) and the value `restore()` clamps to
    // (../server/knowledge-file-store.ts:1122-1131 — the higher of the restored number and what
    // this engine already counted), so a restart never reads as "behind" the files it just loaded.
    // What it is NOT: the flush trigger. The file layer decides whether a pass is due from the
    // `onStoreChange` notifications it was handed (`hasPendingWork`,
    // ../server/knowledge-file-store.ts:1195-1196) plus the per-file sha256+witness gate; it
    // never compares this number against its last commit. It is also NOT a cross-writer token: two
    // processes each count their own mutations, and nothing re-reads the stored number before a
    // commit (see the single-writer note in that file's NON-GOALS).
    let storeRev = 0;

    const listeners = new Set<(notification: KnowledgeStoreNotification) => void>();

    const stamp = (): string => {
        const millis = clock();

        if (!Number.isFinite(millis)) {
            throw inputError(
                `the knowledge clock returned ${String(millis)}, which is not an epoch millisecond; pass a "now" that returns Date.now()-style milliseconds.`
            );
        }

        return new Date(millis).toISOString();
    };

    const mintId = (label: Label): string => {
        const id = source();

        if (!isUuid(id)) {
            throw knowledgeError(
                'EKNOWLEDGE_ID',
                `${label} the knowledge id source returned "${String(id)}", which is not a uuid; pass an "ids" that returns uuid strings, or omit it and use crypto.randomUUID().`
            );
        }

        return canonicalId(id);
    };

    // The claim on one paragraph id, shared by `create` and `modify ... addContent` so the two
    // paths cannot grow different rules about what "already taken" means. `taken` is every id
    // the store holds; `fresh` is every id THIS call has claimed, which is what catches two
    // items pinning the same uuid — a mistake the store cannot catch, because the call has not
    // committed either of them yet.
    //
    // A PINNED id and a MINTED id that collide get different sentences on purpose: the first is
    // the caller's typo (fix: drop the pin), the second is a broken `ids` seam (fix: fix the
    // source, or stop stubbing it). Naming the wrong remedy would send the caller editing an
    // argument it never sent.
    const takeParagraphId = (
        label: Label,
        field: string,
        index: number,
        pinned: string | undefined,
        taken: ReadonlySet<string>,
        fresh: Set<string>
    ): string => {
        const id = pinned === undefined ? mintId(label) : pinned;
        const owner = pinned === undefined ? 'assigned' : 'pinned';
        // Both sentences name the ITEM: an id collision and a repeated pin can each be fixed by
        // editing one entry of the array, and a message that stops at the field name does not
        // say which entry.
        const holder = taken.has(id)
            ? `${label} ${field} item ${index} ${owner} paragraph id "${id}", which the store already uses.`
            : `${label} ${field} item ${index} ${owner} paragraph id "${id}" more than once in this call; one id per paragraph.`;
        const fix =
            pinned === undefined
                ? 'Pass an "ids" that returns fresh uuids, or omit it and use crypto.randomUUID().'
                : 'Drop "id" and let the engine assign one, or choose a uuid of your own that nothing uses.';

        if (taken.has(id) || fresh.has(id)) {
            throw knowledgeError('EKNOWLEDGE_ID', `${holder} ${fix}`, { id, index });
        }

        fresh.add(id);

        return id;
    };

    /**
     * Fan out one committed change. Built only when someone is listening (an engine with no
     * persistence layer pays nothing), and a listener that throws is DROPPED rather than
     * fatal: the write already committed, and a dead file writer must not fail a model's tool
     * call after the fact (records.ts:2599-2623).
     */
    const notify = (
        reason: KnowledgeStoreChangeReason,
        affectedArticles: readonly string[],
        removedArticles: readonly string[]
    ): void => {
        if (listeners.size === 0) return;

        const notification: KnowledgeStoreNotification = {
            storeRev,
            reason,
            affectedArticles: [...affectedArticles],
            removedArticles: [...removedArticles]
        };

        for (const listener of listeners) {
            try {
                listener(notification);
            } catch {
                // The write is committed and the store is consistent; a dead observer is the
                // observer's problem, and one dead listener must not starve the live ones.
            }
        }
    };

    // -----------------------------------------------------------------------
    // Reference resolution
    // -----------------------------------------------------------------------

    // A reference as the STORE sees it, i.e. after the operation committed. Reads and
    // dangling projections use this; a validating write may not, because during `modify` the
    // store still holds the PRE-edit copy of the article being written.
    const refResolves = (ref: KnowledgeReference): boolean => {
        const target = articles.get(ref.articleId);

        if (target === undefined) return false;
        if (ref.paragraphId === undefined) return true;

        return target.content.some((paragraph) => paragraph.id === ref.paragraphId);
    };

    // Every paragraph id currently in the store. Linear on purpose: the whole store is
    // bounded at 100 × 64 = 6400 rows, so a scan is cheaper than a second index that can
    // drift out of step with the articles — and an index bug here would let two paragraphs
    // share an id, which is the one invariant `refs` depends on.
    const usedParagraphIds = (): Set<string> => {
        const taken = new Set<string>();

        for (const article of articles.values()) {
            for (const paragraph of article.content) taken.add(paragraph.id);
        }

        return taken;
    };

    /**
     * Validate the references THIS call wrote, against the store as the call will leave it.
     *
     * `draft` is the article being written, which is NOT yet in the store, so a reference to
     * the draft's own id resolves against `draft.content` — that is what makes a `create`
     * whose second paragraph links to its first (or a `modify` that links to a paragraph the
     * same call appended) legal, which is the recipe shape.
     *
     * `byParagraph` maps paragraph id → the refs this call set. Stored refs are not in it and
     * are not checked: a ref that dangled before the call stays dangling, silently, and reads
     * back through `danglingRefs`.
     */
    const validateRefs = (
        label: Label,
        draft: KnowledgeArticle,
        byParagraph: ReadonlyMap<string, KnowledgeReference[]>
    ): void => {
        for (const [paragraphId, refs] of byParagraph) {
            for (const ref of refs) {
                const inDraft = ref.articleId === draft.id;
                const target = inDraft ? draft : articles.get(ref.articleId);

                if (target === undefined) {
                    throw knowledgeError(
                        'EKNOWLEDGE_REF',
                        `${label} set a reference on paragraph "${paragraphId}" to article "${ref.articleId}", which this store does not hold. ` +
                            `Reference an article that exists — "search" for it first — or remove the reference.`,
                        { paragraphId, articleId: ref.articleId }
                    );
                }

                if (ref.paragraphId === undefined) continue;

                if (!target.content.some((paragraph) => paragraph.id === ref.paragraphId)) {
                    throw knowledgeError(
                        'EKNOWLEDGE_REF',
                        `${label} set a reference on paragraph "${paragraphId}" to paragraph "${ref.paragraphId}" of article "${ref.articleId}", which that article does not hold. ` +
                            `Reference a paragraph that exists (read the article for its ids), or drop "paragraphId" to link the whole article.`,
                        { paragraphId, articleId: ref.articleId, paragraphTarget: ref.paragraphId }
                    );
                }
            }
        }
    };

    // The ids named by the refs of `rows` that no longer resolve — deduped and sorted so the
    // list is stable across calls and comparable in a test.
    const danglingOf = (rows: readonly KnowledgeParagraph[]): string[] => {
        const missing = new Set<string>();

        for (const paragraph of rows) {
            for (const ref of paragraph.refs ?? []) {
                if (!refResolves(ref)) missing.add(missingIdOf(ref));
            }
        }

        return [...missing].sort();
    };

    // Every dangling target in the WHOLE store — what `remove` reports, because removing one
    // article can dangle references in articles the caller was not looking at.
    const danglingAcrossStore = (): string[] => {
        const rows: KnowledgeParagraph[] = [];

        for (const article of articles.values()) rows.push(...article.content);

        return danglingOf(rows);
    };

    // -----------------------------------------------------------------------
    // Ranking
    // -----------------------------------------------------------------------
    //
    // THE MATCHING RULE, stated once because it is the rule the tool's help text teaches:
    //   1. the `tag` filter (case-insensitive ANY-OF against the ARTICLE tags) is applied
    //      first and always — it is a filter, not a ranking input, so an article with the tag
    //      but no text hit still loses to the term;
    //   2. the term is matched against TITLES. Any title hit at all short-circuits the text
    //      scan: a caller who asked "how do I retry a lane" and gets the article titled
    //      "Lane retries" does not want twenty articles that merely contain the word "retry";
    //   3. ONLY when no article's title matches does the engine scan paragraph TEXT (that is
    //      the expensive path — every paragraph of every candidate — and it is the fallback
    //      that makes a term nobody titled still findable). `search` reports which lane
    //      answered through `matchedIn`, so the short-circuit is never invisible.
    //
    // Ranking inside a lane: score desc, then `updatedAt` desc (newest knowledge wins), then
    // id ascending as the final tiebreak. The id tiebreak is not decoration — with an injected
    // clock every article can share one `updatedAt`, and an unstable order would make a page
    // and a test non-deterministic.
    const titleScore = (title: string, needle: string): number => {
        const text = title.toLowerCase();

        if (text === needle) return 3;
        if (text.startsWith(needle)) return 2;

        return text.includes(needle) ? 1 : 0;
    };

    const countOccurrences = (haystack: string, needle: string): number => {
        if (needle.length === 0) return 0;

        let count = 0;
        let index = haystack.indexOf(needle);

        while (index !== -1) {
            count += 1;
            index = haystack.indexOf(needle, index + needle.length);
        }

        return count;
    };

    const textScore = (article: KnowledgeArticle, needle: string): number => {
        let hits = 0;

        for (const paragraph of article.content) hits += countOccurrences(paragraph.text.toLowerCase(), needle);

        return hits;
    };

    type Ranked = { article: KnowledgeArticle; score: number };

    // score desc → updatedAt desc → id asc. One comparator for both lanes, so a title page
    // and a text page cannot rank the same pair of articles two different ways.
    const compareRanked = (left: Ranked, right: Ranked): number => {
        if (left.score !== right.score) return right.score - left.score;
        if (left.article.updatedAt !== right.article.updatedAt) {
            return left.article.updatedAt < right.article.updatedAt ? 1 : -1;
        }

        return left.article.id < right.article.id ? -1 : left.article.id > right.article.id ? 1 : 0;
    };

    type Matched = { list: KnowledgeArticle[]; matchedIn: 'title' | 'text' };

    const matchArticles = (term: string | undefined, tags: readonly string[]): Matched => {
        const wanted = new Set(tags.map((tag) => tag.toLowerCase()));

        const candidates =
            wanted.size === 0
                ? [...articles.values()]
                : [...articles.values()].filter((article) => article.tags.some((tag) => wanted.has(tag.toLowerCase())));

        // A term-less `list` answers everything, and the "lane" it matched in is a title-page
        // shape by definition (no text was consulted).
        if (term === undefined) {
            return {
                list: candidates
                    .map((article) => ({ article, score: 0 }))
                    .sort(compareRanked)
                    .map((ranked) => ranked.article),
                matchedIn: 'title'
            };
        }

        const needle = term.toLowerCase();
        const byTitle = candidates
            .map((article) => ({ article, score: titleScore(article.title, needle) }))
            .filter((ranked) => ranked.score > 0)
            .sort(compareRanked);

        if (byTitle.length > 0) {
            return { list: byTitle.map((ranked) => ranked.article), matchedIn: 'title' };
        }

        const byText = candidates
            .map((article) => ({ article, score: textScore(article, needle) }))
            .filter((ranked) => ranked.score > 0)
            .sort(compareRanked);

        return { list: byText.map((ranked) => ranked.article), matchedIn: 'text' };
    };

    // The search paging bound: rank 1..KNOWLEDGE_MAX_SEARCH is reachable, anything deeper is
    // a query that has not been narrowed. Checked against `offset + limit` — the deepest row
    // the call could actually receive — so a caller that asks for `limit: 100` is measured
    // honestly instead of being allowed 100 rows it then pages past.
    const checkSearchDepth = (label: Label, offset: number, limit: number): void => {
        if (offset + limit <= KNOWLEDGE_MAX_SEARCH) return;

        throw knowledgeError(
            'EKNOWLEDGE_LIMIT',
            `${label} asks for rank ${offset + 1}-${offset + limit}, past the KNOWLEDGE_MAX_SEARCH ceiling of ${KNOWLEDGE_MAX_SEARCH} results. Narrow the query or add a "tag" filter instead of paging to the end of a loose match.`
        );
    };

    // -----------------------------------------------------------------------
    // Paging + the response budget
    // -----------------------------------------------------------------------
    //
    // The budget is applied to the WHOLE serialized result (the same currency the harness
    // bills in), and it drops trailing rows rather than cutting a JSON string mid-document: a
    // page that is smaller is still machine-readable and still paged, while a text cut is
    // neither. The FIRST row of a non-empty page is always kept (records.ts:2723-2726): one
    // summary cannot approach the budget, and dropping it would let `nextOffset` stall.
    const buildPage = (matched: Matched, offset: number, limit: number, search: boolean): KnowledgePageResult => {
        const total = matched.list.length;
        let rows = matched.list.slice(offset, offset + limit).map(summaryOf);
        let budgetTruncated = false;

        const assemble = (): KnowledgePageResult => {
            const pageEnd = offset + rows.length;
            const hasMore = pageEnd < total;

            const result: KnowledgePageResult = {
                articles: rows,
                counts: { total },
                page: {
                    offset,
                    limit,
                    hasMore,
                    ...(hasMore ? { nextOffset: pageEnd } : {})
                }
            };

            if (budgetTruncated) result.page.budgetTruncated = true;
            if (search) (result as KnowledgeSearchResult).matchedIn = matched.matchedIn;

            return result;
        };

        let page = assemble();

        while (rows.length > 1 && modelPayloadBytes(JSON.stringify(page)) > KNOWLEDGE_RESPONSE_BUDGET_BYTES) {
            rows = rows.slice(0, -1);
            budgetTruncated = true;
            page = assemble();
        }

        return page;
    };

    // -----------------------------------------------------------------------
    // The read projections
    // -----------------------------------------------------------------------
    //
    // WHICH KEYS APPEAR WHEN (the contract's "always echo metadata + rev, plus
    // truncated/totalParagraphs when a window applies", made exact):
    //   - `paragraphCount` is ALWAYS present: the article's total, whatever was returned.
    //   - `from` / `limit` / `totalParagraphs` / `truncated` are present together, and only
    //     when the response is an ordered SUBSET of the article — i.e. the caller passed
    //     `from`/`limit`, or selected ids, or the byte budget cut the response. `truncated`
    //     may then be `false` (a window that happened to cover the whole article), which is
    //     the honest answer to "did I get everything" for that request rather than a missing key.
    //   - `limit` in a response is the number of rows it ACTUALLY carries, so `from + limit`
    //     is where a paging loop resumes — echoing the caller's requested limit back would be
    //     a number the response does not honour after a budget cut.
    //   - `from` is the ARTICLE index of the first returned paragraph, which is well defined
    //     for a window (its own offset), for a selection (the lowest stored index among the
    //     selected ids, since a selection is returned in stored order) and for a full read cut
    //     by the budget (0).
    //   - `budgetTruncated` appears only when the engine's own cap did the cutting, so a
    //     caller can tell "ask for a narrower window" from "the article is genuinely huge".
    //   - `outline` replaces `paragraphs` for `outline: true` and composes with every window
    //     above; `danglingRefs` appears only when something in THIS response is unresolvable.
    const indexOfParagraph = (article: KnowledgeArticle, paragraphId: string): number =>
        article.content.findIndex((paragraph) => paragraph.id === paragraphId);

    const buildRead = (
        article: KnowledgeArticle,
        rows: KnowledgeParagraph[],
        windowed: { from: number } | undefined,
        // `outline: true`: the rows are projected to metadata-only entries instead of being
        // handed back as text. A parameter, not a captured variable, because the budget loop
        // below re-assembles the result and nothing may be able to flip the mode mid-loop.
        outlineOnly: boolean
    ): KnowledgeReadResult => {
        const total = article.content.length;
        const subset = windowed !== undefined || rows.length !== total;
        const first = windowed?.from ?? (rows.length === 0 ? 0 : indexOfParagraph(article, rows[0].id));

        let kept = rows;
        let budgetTruncated = false;

        const assemble = (): KnowledgeReadResult => {
            const result: KnowledgeReadResult = {
                ...metaOf(article),
                paragraphCount: total
            };

            // `outline` and `paragraphs` are ALTERNATIVE keys, never both: an outline is the
            // cheap answer to "what is in this article", and shipping both would double the
            // rows for the caller that only wanted one of them.
            if (outlineOnly) result.outline = kept.map(outlineOf);
            else result.paragraphs = kept;

            if (subset || budgetTruncated) {
                result.from = first;
                result.limit = kept.length;
                result.totalParagraphs = total;
                result.truncated = kept.length < total;
            }

            if (budgetTruncated) result.budgetTruncated = true;

            const dangling = danglingOf(kept);
            if (dangling.length > 0) result.danglingRefs = dangling;

            return result;
        };

        let read = assemble();

        // One paragraph is at most 4000 characters of text plus 16 capped notes, so a
        // single-row response can in the extreme still exceed the budget (16 × 500-character
        // notes). It is returned anyway — the records stance: a row over budget is a
        // degradation the caller can read, and a page with nothing in it is a stall.
        while (kept.length > 1 && modelPayloadBytes(JSON.stringify(read)) > KNOWLEDGE_RESPONSE_BUDGET_BYTES) {
            kept = kept.slice(0, -1);
            budgetTruncated = true;
            read = assemble();
        }

        return read;
    };

    const readArticle = (input: unknown): KnowledgeReadResult => {
        const label: Label = 'knowledge "read"';
        const record = readOperationRecord(input, label);

        readItemKeys(record, OPERATION_KEYS.read, label);

        const id = readIdArgument(
            label,
            '"id"',
            record.id,
            'run a "search" or "list" — ids are uuids the engine assigned.'
        );
        const article = articles.get(id);

        if (article === undefined) {
            throw knowledgeError(
                'EKNOWLEDGE_NOT_FOUND',
                `${label} found no article "${id}". Run a "search" or "list" to find the article you mean; ids are uuids the engine assigned and cannot be guessed.`,
                { id }
            );
        }

        const selected = readIdArray(label, 'paragraphs', record.paragraphs);
        const outline = readBooleanArgument(label, 'outline', record.outline);
        const hasFrom = record.from !== undefined;
        const hasLimit = record.limit !== undefined;
        const from = readFromArgument(label, record.from);
        const limit = readWindowLimitArgument(label, record.limit);

        // A selection is already a window: `paragraphs: [a, b]` with `from: 3` asks two
        // different questions about the same read, and there is no ordering of the two that
        // is not a guess.
        if (selected !== undefined && (hasFrom || hasLimit)) {
            throw inputError(
                `${label} takes "paragraphs" or "from"/"limit", not both: a paragraph selection is already a window. Drop one of them.`
            );
        }

        // The window/selection decision is made here, once, and `windowed` says so to the
        // projection layer — which is the only place that knows whether `from`/`limit`/
        // `totalParagraphs`/`truncated` belong in the answer.
        let rows: KnowledgeParagraph[];
        let windowed: { from: number } | undefined;

        if (selected !== undefined) {
            // Returned in the ARTICLE's order, not the request's: an article is a document, and
            // a reader quoting two paragraphs back in reverse order would be shown a different
            // document than the one that exists.
            const positions: number[] = [];

            for (const paragraphId of selected) {
                const at = indexOfParagraph(article, paragraphId);

                if (at === -1) {
                    throw knowledgeError(
                        'EKNOWLEDGE_NOT_FOUND',
                        `${label} asked for paragraph "${paragraphId}", which article "${article.id}" ("${article.title}") does not hold. Read the article with "outline": true for its paragraph ids.`,
                        { id: article.id, paragraphId }
                    );
                }

                positions.push(at);
            }

            const ordered = [...positions].sort((left, right) => left - right);

            rows = ordered.map((at) => copyParagraph(article.content[at]));
            // `from` for a selection is the stored index of the FIRST row returned (a selection
            // has no offset of its own), so `from + limit` still points a paging loop at the
            // next paragraph in the article rather than at a phantom index inside the selection.
            windowed = { from: ordered.length === 0 ? 0 : ordered[0] };
        } else if (hasFrom || hasLimit) {
            rows = article.content.slice(from, limit === undefined ? undefined : from + limit).map(copyParagraph);
            windowed = { from };
        } else {
            rows = article.content.map(copyParagraph);
            windowed = undefined;
        }

        return buildRead(article, rows, windowed, outline);
    };

    // -----------------------------------------------------------------------
    // The verb handlers
    // -----------------------------------------------------------------------

    const listArticles = (record: Record<string, unknown>, search: boolean): KnowledgePageResult => {
        const label: Label = search ? 'knowledge "search"' : 'knowledge "list"';

        readItemKeys(record, search ? OPERATION_KEYS.search : OPERATION_KEYS.list, label);

        const rawTerm = search ? record.query : record.search;

        if (search && rawTerm === undefined) {
            throw inputError(`${label} requires a non-empty "query" string; use "list" to page the whole store.`);
        }

        // The term is matched as a case-insensitive SUBSTRING, and is capped at one
        // paragraph's length because a term longer than a whole paragraph can only match a
        // paragraph that is entirely that term — a typo worth refusing.
        let term: string | undefined;

        if (rawTerm !== undefined) {
            if (typeof rawTerm !== 'string') {
                throw inputError(`${label} ${search ? '"query"' : '"search"'} must be a string.`);
            }

            const trimmed = rawTerm.trim();

            if (trimmed.length === 0) {
                throw inputError(
                    `${label} ${search ? '"query"' : '"search"'} is blank; drop it to page the whole store.`
                );
            }

            if (trimmed.length > KNOWLEDGE_MAX_TEXT) {
                throw knowledgeError(
                    'EKNOWLEDGE_LIMIT',
                    `${label} ${search ? '"query"' : '"search"'} is ${trimmed.length} characters, over the ${KNOWLEDGE_MAX_TEXT}-character KNOWLEDGE_MAX_TEXT bound; search for a phrase, not for a document.`
                );
            }

            term = trimmed.toLowerCase();
        }

        const tags = readTags(label, 'tag', record.tag);
        const offset = readOffsetArgument(label, record.offset);
        const limit = readLimitArgument(label, record.limit);

        if (search) checkSearchDepth(label, offset, limit);

        return buildPage(matchArticles(term, tags), offset, limit, search);
    };

    // `owner` is the trusted attribution the router read from `ToolContext.harness`
    // (`knowledgeOwner`), never an operation field (see `OPERATION_KEYS.create` — `harness` is
    // not among the accepted keys, so a model-supplied one is refused as unknown). It is
    // captured once per call and stamped on the article this call commits; a caller with no
    // harness identity creates an UNOWNED article, exactly like every pre-T6 article.
    const createArticle = (record: Record<string, unknown>, owner: string | undefined): KnowledgeCreateResult => {
        const label: Label = 'knowledge "create"';

        readItemKeys(record, OPERATION_KEYS.create, label);

        // Validate/normalize the trusted owner BEFORE any clock read or id mint: a refused
        // over-limit token must leave the store exactly as it was (and must never reach a
        // snapshot the durable reader would reject on the next load).
        const acceptedOwner = readCreationOwner(owner, label);

        const title = readTitle(label, record.title);
        const tags = readTags(label, 'tags', record.tags);
        const items = readContentItems(label, 'content', record.content);

        // Checked BEFORE the clock is read or an id is minted: a refusal must not look like it
        // did work (records' "a rejected add never burns an id").
        if (articles.size >= KNOWLEDGE_MAX_ARTICLES) {
            throw knowledgeError(
                'EKNOWLEDGE_LIMIT',
                `${label} refused: the store holds ${articles.size} articles, the KNOWLEDGE_MAX_ARTICLES limit of ${KNOWLEDGE_MAX_ARTICLES}. Remove an article ("verb": "remove") or add these paragraphs to an existing one ("verb": "modify").`,
                { articles: articles.size, max: KNOWLEDGE_MAX_ARTICLES }
            );
        }

        const taken = usedParagraphIds();
        // Ids this call has claimed, kept apart from the store snapshot so a repeated pin is
        // attributed to the call, not to a row that does not exist yet.
        const fresh = new Set<string>();
        const at = stamp();
        const content: KnowledgeParagraph[] = [];
        const byParagraph = new Map<string, KnowledgeReference[]>();

        for (const [index, item] of items.entries()) {
            if (content.length >= KNOWLEDGE_MAX_PARAGRAPHS) {
                throw knowledgeError(
                    'EKNOWLEDGE_LIMIT',
                    `${label} "content" would put ${content.length + 1} paragraphs in one article, over the KNOWLEDGE_MAX_PARAGRAPHS limit of ${KNOWLEDGE_MAX_PARAGRAPHS}; continue in a second article.`,
                    { max: KNOWLEDGE_MAX_PARAGRAPHS }
                );
            }

            // A pinned id is the caller's handle; an unpinned one is minted. Both go through
            // the same claim, so "already used" means the same thing on every path — and
            // `fresh` is kept SEPARATE from `taken` so an in-call duplicate is reported as an
            // in-call duplicate rather than as a store collision that never happened.
            const id = takeParagraphId(label, '"content"', index, item.id, taken, fresh);

            content.push({
                id,
                text: item.text,
                rev: 1,
                createdAt: at,
                updatedAt: at,
                ...(item.tags.length === 0 ? {} : { tags: [...item.tags] }),
                ...(item.refs.length === 0 ? {} : { refs: item.refs.map(copyRef) })
            });

            if (item.refs.length > 0) byParagraph.set(id, item.refs);
        }

        const id = mintId(label);

        if (articles.has(id)) {
            throw knowledgeError(
                'EKNOWLEDGE_ID',
                `${label} the knowledge id source returned "${id}", which the store already uses as an article id; pass an "ids" that returns fresh uuids.`,
                { id }
            );
        }

        const article: KnowledgeArticle = {
            id,
            title,
            createdAt: at,
            updatedAt: at,
            tags: [...tags],
            content,
            rev: 1,
            // Present ONLY when this create ran through an attributed harness build; the
            // conditional spread is what keeps an unscoped create's article shape unchanged.
            ...(acceptedOwner === undefined ? {} : { harness: acceptedOwner })
        };

        // Validate before the store changes (and refs may point inside this very article,
        // which is why the draft is passed to the validator).
        validateRefs(label, article, byParagraph);

        articles.set(id, article);
        storeRev += 1;
        notify('create', [id], []);

        return { article: copyArticle(article), createdIds: content.map((paragraph) => paragraph.id) };
    };

    // The `expects` guard, shared by `modify` and `remove`: tokens must name THIS article, and
    // any mismatch refuses the whole call with the current article attached.
    const checkExpects = (
        label: Label,
        article: KnowledgeArticle,
        expects: readonly KnowledgeExpect[] | undefined
    ): void => {
        for (const expect of expects ?? []) {
            if (expect.id !== article.id) {
                throw inputError(
                    `${label} writes article "${article.id}", so "expects" may only name that id; it named "${expect.id}". One article per call — send a second call for the other.`
                );
            }

            if (expect.rev !== article.rev) {
                throw staleArticleError(label, article, expect.rev);
            }
        }
    };

    const modifyArticle = (record: Record<string, unknown>): KnowledgeModifyResult => {
        const label: Label = 'knowledge "modify"';

        readItemKeys(record, OPERATION_KEYS.modify, label);

        const id = readIdArgument(
            label,
            '"id"',
            record.id,
            'run a "search" or "list" — ids are uuids the engine assigned.'
        );
        const article = articles.get(id);

        if (article === undefined) {
            throw knowledgeError(
                'EKNOWLEDGE_NOT_FOUND',
                `${label} found no article "${id}". Run a "search" or "list" to find the article you mean; ids are uuids the engine assigned and cannot be guessed.`,
                { id }
            );
        }

        // The CAS guard runs BEFORE any parsing of the edit itself: a caller whose token is
        // stale is told that first, with the current article attached, because the payload of
        // the refusal is what it needs to rebuild the call (records' R9 — one round trip).
        checkExpects(label, article, readExpects(label, record.expects));

        const title = record.title === undefined ? undefined : readTitle(label, record.title);
        const addTags = readTags(label, 'addTags', record.addTags);
        const removeTags = readTags(label, 'removeTags', record.removeTags);
        const sets = readSetItems(label, record.setParagraphs);
        const adds = readContentItems(label, 'addContent', record.addContent);
        const moves = readMoveItems(label, record.moveParagraphs);
        const removals = readIdArray(label, 'removeParagraphs', record.removeParagraphs) ?? [];

        // Everything below edits a CLONE. The store is swapped only after every step,
        // including ref validation, has succeeded — so a refusal anywhere leaves the article,
        // the watermark and the feed exactly as they were.
        const draft = copyArticle(article);
        const at = stamp();

        const fields: string[] = [];
        const created: string[] = [];
        const changed: string[] = [];
        const noop: string[] = [];
        const moved: string[] = [];
        const removed: string[] = [];

        // One paragraph, one kind of change per call (records' `batch-conflict` role, spelled
        // with EKNOWLEDGE_ID because the engine's code space is its own). An ambiguous call —
        // set a paragraph AND remove it, or move it AND set it — has no honest outcome, and
        // silently picking one would make the apply order a fact a caller had to memorize.
        const claims = new Map<string, string>();

        // `inherits` names the prior step this step may legally CONTINUE rather than conflict
        // with. There is exactly one: a paragraph this call APPENDED may also be MOVED by the
        // same call, which is one intent ("append this paragraph and put it here"), not two
        // edits competing for one row. Everything else — set+move, set+remove, move+remove,
        // add+set — stays a refusal, because the apply order would decide the outcome and the
        // caller never said which reading it wanted.
        const claim = (paragraphId: string, step: string, inherits: readonly string[] = []): void => {
            const prior = claims.get(paragraphId);

            if (prior === undefined || inherits.includes(prior)) {
                claims.set(paragraphId, step);
                return;
            }

            throw knowledgeError(
                'EKNOWLEDGE_ID',
                `${label} changes paragraph "${paragraphId}" in both "${prior}" and "${step}"; one paragraph takes one kind of change per call. Split the call or drop one of them.`,
                { paragraphId, steps: [prior, step] }
            );
        };

        // 1. title — a change only when the trimmed text differs.
        if (title !== undefined && title !== draft.title) {
            draft.title = title;
            fields.push('title');
        }

        // 2. tags — add, then remove (a tag named by both nets out removed).
        if (addTags.length > 0 || removeTags.length > 0) {
            const merged = mergeTags(draft.tags, addTags, removeTags);

            if (!sameTagList(merged, draft.tags)) {
                draft.tags = merged;
                fields.push('tags');
            }
        }

        // 3. setParagraphs — rewrite an EXISTING paragraph's content, never its order.
        const touched = new Map<string, KnowledgeReference[]>();

        for (const item of sets) {
            claim(item.id, 'setParagraphs');

            const paragraph = draft.content.find((candidate) => candidate.id === item.id);

            if (paragraph === undefined) {
                throw knowledgeError(
                    'EKNOWLEDGE_NOT_FOUND',
                    `${label} "setParagraphs" named paragraph "${item.id}", which article "${draft.id}" ("${draft.title}") does not hold. Use "addContent" to append a paragraph, or read the article with "outline": true for its ids.`,
                    { id: draft.id, paragraphId: item.id }
                );
            }

            let dirty = false;

            if (item.hasText && item.text !== paragraph.text) {
                paragraph.text = item.text as string;
                dirty = true;
            }

            if (item.hasTags) {
                const tags = item.tags as string[];

                if (!sameTags(paragraph.tags, tags)) {
                    // An empty tag list CLEARS the key rather than storing `[]`: absent is the
                    // shape every other write produces, and the byte budget measures the real
                    // serialized document.
                    paragraph.tags = tags.length === 0 ? undefined : [...tags];
                    dirty = true;
                }
            }

            if (item.hasRefs) {
                const refs = item.refs as KnowledgeReference[];

                if (!sameRefs(paragraph.refs, refs)) {
                    paragraph.refs = refs.length === 0 ? undefined : refs.map(copyRef);
                    dirty = true;
                }

                // Whatever the call set is validated, even when it matched what was stored:
                // re-asserting a link to a paragraph that has since been removed is a refusal,
                // not a silent no-op.
                touched.set(paragraph.id, refs);
            }

            if (dirty) {
                paragraph.rev += 1;
                paragraph.updatedAt = at;
                changed.push(paragraph.id);
            } else {
                noop.push(paragraph.id);
            }
        }

        // 4. addContent — append after what exists (a move in step 5 can then reposition it).
        const taken = usedParagraphIds();
        // Ids this call has claimed, separate from the store snapshot (see `create`).
        const fresh = new Set<string>();

        // The bound is the article's size AFTER the call, counted up front: `removeParagraphs`
        // runs in step 6, so room a call makes by deleting paragraphs in the same call has to be
        // visible here — otherwise the remedy this message offers ("remove a paragraph in the
        // same call") would itself be a refusal. Every removal is room, because a paragraph this
        // call appends cannot also be named by `removeParagraphs` (one claim per paragraph).
        const projected = draft.content.length + adds.length - removals.length;

        if (projected > KNOWLEDGE_MAX_PARAGRAPHS) {
            throw knowledgeError(
                'EKNOWLEDGE_LIMIT',
                `${label} "addContent" would leave ${projected} paragraphs in article "${draft.id}", over the KNOWLEDGE_MAX_PARAGRAPHS limit of ${KNOWLEDGE_MAX_PARAGRAPHS}. Remove paragraphs in the same call or start another article.`,
                { id: draft.id, max: KNOWLEDGE_MAX_PARAGRAPHS, projected }
            );
        }

        for (const [index, item] of adds.entries()) {
            // Same claim as `create` (see `takeParagraphId`): `taken` already includes this
            // article's own paragraphs, because the live rows are exactly the ids a new
            // paragraph may not reuse.
            const paragraphId = takeParagraphId(label, '"addContent"', index, item.id, taken, fresh);

            // APPEND-then-POSITION is one intent, not two competing edits: the paragraph this
            // call appended may be repositioned by `moveParagraphs` in step 5 (see `claim`).
            claim(paragraphId, 'addContent');

            draft.content.push({
                id: paragraphId,
                text: item.text,
                rev: 1,
                createdAt: at,
                updatedAt: at,
                ...(item.tags.length === 0 ? {} : { tags: [...item.tags] }),
                ...(item.refs.length === 0 ? {} : { refs: item.refs.map(copyRef) })
            });

            created.push(paragraphId);
            if (item.refs.length > 0) touched.set(paragraphId, item.refs);
        }

        // 5. moveParagraphs — reorder, entry by entry, each move applied to the array the
        //    previous one produced. Order is NOT content: no paragraph `rev` moves, so `movedIds`
        //    is the only place a reorder is visible, while the article `rev` does move (the
        //    document the caller read is no longer the document that exists).
        for (const move of moves) {
            // A paragraph this same call appended may be positioned by this move (the one
            // `claim` inheritance the contract allows); every other combination is a conflict.
            claim(move.id, 'moveParagraphs', ['addContent']);

            const from = draft.content.findIndex((paragraph) => paragraph.id === move.id);

            if (from === -1) {
                throw knowledgeError(
                    'EKNOWLEDGE_NOT_FOUND',
                    `${label} "moveParagraphs" named paragraph "${move.id}", which article "${draft.id}" ("${draft.title}") does not hold. Read the article with "outline": true for its paragraph ids.`,
                    { id: draft.id, paragraphId: move.id }
                );
            }

            let to: number;

            if (move.before === undefined) {
                to = draft.content.length;
            } else {
                const anchor = draft.content.findIndex((paragraph) => paragraph.id === move.before);

                if (anchor === -1) {
                    throw knowledgeError(
                        'EKNOWLEDGE_NOT_FOUND',
                        `${label} "moveParagraphs" named "before" paragraph "${move.before}", which article "${draft.id}" ("${draft.title}") does not hold. Read the article with "outline": true for its paragraph ids.`,
                        { id: draft.id, paragraphId: move.before }
                    );
                }

                to = anchor;
            }

            const [row] = draft.content.splice(from, 1);

            // Taking the row out shifted every index after it left by one, so an insertion
            // point that was to its right moves left to stay in front of the same row.
            if (from < to) to -= 1;

            draft.content.splice(to, 0, row as KnowledgeParagraph);

            if (from !== to) moved.push(move.id);
        }

        // 6. removeParagraphs — an unknown id is a refusal, not the silent skip the records
        //    engine gives a stale removal: `removeParagraphs` is the one verb where "nothing
        //    matched" reads to the model as success while its cleanup did not happen.
        for (const paragraphId of removals) {
            claim(paragraphId, 'removeParagraphs');

            const index = draft.content.findIndex((paragraph) => paragraph.id === paragraphId);

            if (index === -1) {
                throw knowledgeError(
                    'EKNOWLEDGE_NOT_FOUND',
                    `${label} "removeParagraphs" named paragraph "${paragraphId}", which article "${draft.id}" ("${draft.title}") does not hold. Read the article with "outline": true for its paragraph ids.`,
                    { id: draft.id, paragraphId }
                );
            }

            draft.content.splice(index, 1);
            touched.delete(paragraphId);
            removed.push(paragraphId);
        }

        // 7. ref revalidation — last, so a link may target a paragraph this same call appended
        //    and a link to a paragraph this same call removed is refused. Only the refs this
        //    call wrote are checked; refs that dangled before are left alone and reported.
        validateRefs(label, draft, touched);

        const dirty =
            fields.length > 0 || changed.length > 0 || created.length > 0 || moved.length > 0 || removed.length > 0;

        // A call that wrote nothing commits nothing: no `rev` bump, no `updatedAt` move, no
        // watermark advance, no notification. The caller still gets the current article, so
        // the answer it can act on is the same either way.
        if (!dirty) {
            const dangling = danglingOf(draft.content);

            return {
                article: copyArticle(article),
                noop: true,
                ...(noop.length === 0 ? {} : { noopIds: noop }),
                ...(dangling.length === 0 ? {} : { danglingRefs: dangling })
            };
        }

        draft.rev += 1;
        draft.updatedAt = at;
        articles.set(draft.id, draft);
        storeRev += 1;
        notify('modify', [draft.id], []);

        const dangling = danglingOf(draft.content);

        return {
            article: copyArticle(draft),
            noop: false,
            ...(created.length === 0 ? {} : { createdIds: created }),
            ...(changed.length === 0 ? {} : { changedIds: changed }),
            ...(noop.length === 0 ? {} : { noopIds: noop }),
            ...(moved.length === 0 ? {} : { movedIds: moved }),
            ...(removed.length === 0 ? {} : { removedIds: removed }),
            ...(fields.length === 0 ? {} : { articleFields: fields }),
            ...(dangling.length === 0 ? {} : { danglingRefs: dangling })
        };
    };

    const removeArticle = (record: Record<string, unknown>): KnowledgeRemoveResult => {
        const label: Label = 'knowledge "remove"';

        readItemKeys(record, OPERATION_KEYS.remove, label);

        const id = readIdArgument(
            label,
            '"id"',
            record.id,
            'run a "search" or "list" — ids are uuids the engine assigned.'
        );
        const article = articles.get(id);

        if (article === undefined) {
            throw knowledgeError(
                'EKNOWLEDGE_NOT_FOUND',
                `${label} found no article "${id}". Run a "search" or "list" to find the article you mean; ids are uuids the engine assigned and cannot be guessed.`,
                { id }
            );
        }

        checkExpects(label, article, readExpects(label, record.expects));

        const removed = summaryOf(article);

        // The article's OWN outgoing refs disappear with it (they were its paragraphs'
        // statements). What it leaves behind are the refs OTHER articles wrote into it — those
        // are reported, and deliberately not rewritten: a cascading rewrite would bump a `rev`
        // nobody edited and would delete the evidence that the link was ever made.
        articles.delete(id);
        storeRev += 1;
        notify('remove', [], [id]);

        return { removed, danglingRefs: danglingAcrossStore() };
    };

    // -----------------------------------------------------------------------
    // Routing
    // -----------------------------------------------------------------------

    // The operation is validated at the door: not-an-object, an unknown `verb` and an unknown
    // field are all refusals that quote what IS accepted, before any verb handler runs.
    const execute = <TOperation extends KnowledgeOperation>(
        operation: TOperation,
        context?: ToolContext
    ): KnowledgeResultFor<TOperation> => {
        const record = readOperationRecord(operation, 'knowledge');
        const verb = record.verb;

        // Checked against the VERB SET, not against `OPERATION_KEYS[verb]`: a plain object
        // lookup answers truthy for `"constructor"` and `"toString"`, which would route a typo
        // to no handler at all instead of refusing it by name.
        if (typeof verb !== 'string' || !VERB_SET.has(verb as KnowledgeVerb)) {
            throw inputError(`knowledge operations have a "verb" of ${VERB_LIST}; received ${String(verb)}.`);
        }

        // `Set.has` does not narrow, so the membership proof above is carried across by this
        // one named narrowing — the only place the verb type is asserted, and it is what
        // `dispatch`'s exhaustive switch then checks.
        const knownVerb = verb as KnowledgeVerb;

        // The ONE trusted field read from `context` (T6): the canonical harness name the host
        // attached to this build (`Harness.knowledgeOwner` — set by ../server/sessions.ts
        // `buildHarness` from the frozen preset name and forwarded through the preset report).
        // It is read HERE, never from `record`, so the model has no input that can set or
        // overwrite an article's owner. Every other attribution question stays out of this
        // engine (an article records when it changed, not who changed it beyond its creator).
        //
        // The runtime guard is deliberate: `execute` is public and a hand-built ToolContext is
        // allowed to be arbitrary, so a non-string or blank value is treated as "no identity"
        // rather than being written into the store as a bogus owner. `harness()` itself refuses
        // a malformed `knowledgeOwner` at construction, so this only covers a hand-built
        // context and keeps a bad host value from corrupting persisted articles.
        const owner = ownerOfContext(context);

        const result: KnowledgeResult = dispatch(knownVerb, record, owner);

        // The cast is the router's, not a hole: `dispatch` returns the result of exactly the
        // handler `verb` selects, and the union in ../types maps each verb to one result
        // shape, so a literal `{ verb: 'create' }` really does answer `KnowledgeCreateResult`.
        return result as KnowledgeResultFor<TOperation>;
    };

    const dispatch = (verb: KnowledgeVerb, record: Record<string, unknown>, owner: string | undefined): KnowledgeResult => {
        switch (verb) {
            case 'list':
                return listArticles(record, false);
            case 'search':
                return listArticles(record, true);
            case 'read':
                return readArticle(record);
            case 'create':
                return createArticle(record, owner);
            case 'modify':
                return modifyArticle(record);
            case 'remove':
                return removeArticle(record);
            default:
                // Unreachable: `execute` matched `verb` against VERB_SET first. The clause is
                // here so an added verb is a compile-time miss in VERB_SET, never a call that
                // silently answers `undefined`.
                throw inputError(`knowledge operations have a "verb" of ${VERB_LIST}; received ${String(verb)}.`);
        }
    };

    return {
        execute,

        // The whole store as rows, in the order `list` answers with (newest change first).
        // This is the host's "what is in here" call — an operator panel and the file layer's
        // initial write both use it — so it is a projection, never the bodies.
        articles: (): KnowledgeArticleSummary[] =>
            [...articles.values()]
                .map((article) => ({ article, score: 0 }))
                .sort(compareRanked)
                .map((ranked) => summaryOf(ranked.article)),

        search: (operation: KnowledgeSearchParams): KnowledgeSearchResult =>
            listArticles({ ...operation, verb: 'search' }, true) as KnowledgeSearchResult,

        read: (operation: KnowledgeReadParams): KnowledgeReadResult => readArticle({ ...operation, verb: 'read' }),

        onStoreChange: (listener: (notification: KnowledgeStoreNotification) => void): (() => void) => {
            listeners.add(listener);

            return (): void => {
                listeners.delete(listener);
            };
        },

        // A snapshot carries EVERY paragraph body: a resumed session must not lose knowledge,
        // and unlike a records page there is no `getOnly` field to project away — the body IS
        // the article. Detached, so a caller that keeps a snapshot and then keeps writing sees
        // the bytes it saved.
        snapshot: (): KnowledgeStoreState => ({
            storeRev,
            articles: [...articles.values()].map(copyArticle)
        }),

        // Validate into copies first, then swap, so a rejected restore leaves the live store
        // exactly as it was (the records restore discipline, records.ts:4300-4341).
        restore: (state: unknown): void => {
            const restored = readKnowledgeStoreState(state);
            const prior = [...articles.keys()];

            articles.clear();

            for (const article of restored.articles) articles.set(article.id, article);

            // The watermark comes from the restored state: files were written under it, so a
            // resumed engine that restarted the count would let the file layer skip a commit it
            // believed it owed.
            storeRev = restored.storeRev;

            const affected = restored.articles.map((article) => article.id);
            const removed = prior.filter((id) => !articles.has(id));

            notify('restore', affected, removed);
        },

        // A clean start, watermark 0 — the store, the conversation that referenced it, and the
        // file layer's notion of what it has written all go together (records' reset, at 0 for
        // the same reason).
        reset: (): void => {
            const prior = [...articles.keys()];

            articles.clear();
            storeRev = 0;

            notify('reset', [], prior);
        }
    };
};
