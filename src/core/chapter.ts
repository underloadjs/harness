// chapterManage — the harness session chapter tracker.
//
// Same lifecycle as todoManage (./todo.ts) and profileManage (./profile.ts):
// factory closure per harness, shared by every agent, stable decimal string ids,
// full validation before any mutation, defensive copies, cleared by reset().
//
// Two chapter-specific decisions:
//   - LISTS AND MUTATION RESULTS CARRY SUMMARIES, NEVER THE BODY. A chapter's
//     `content` can be long, and a model that lists ten chapters should not pay
//     for all ten bodies. `get` is the one action that returns content.
//   - `order` is a simple optional integer sort position. There is no move
//     action: update it to reorder. A list sorts ordered chapters first by
//     ascending order, then unordered ones in insertion order (Array.sort is
//     stable), so insertion order remains the default. The live array is never
//     sorted; the sorted copy is only used to build the page.
//
// R9 (tool audit) — bounded results, identical policy in profile/chapter/location:
//   - at most CHAPTER_MAX_RECORDS (200) chapters may be stored; `add` past the
//     cap is an actionable error, never a silent drop of stored data;
//   - per-field caps: title CHAPTER_MAX_NAME (200), summary/content
//     CHAPTER_MAX_TEXT (4000) characters. Oversized writes are rejected with the
//     actual size so the model can shorten and retry;
//   - `list` is paginated after the order sort: `offset` defaults to 0, `limit`
//     defaults to 20 and is hard-capped at 100, and the page stops before the
//     UTF-8 payload exceeds CHAPTER_RESPONSE_BUDGET_BYTES (64 KiB).
//     `page.hasMore` / `page.nextOffset` walk every chapter without gaps;
//   - mutation results return only the affected summary and the counts, never
//     the whole store.
//
// ACTIONS (shared by profile/chapter/location):
//   add     — requires title + summary; content/status/order optional.
//             status defaults to 'planned' and content to ''.
//   list    — one bounded page of summaries, in the order described above.
//   get     — one summary plus its full `content`.
//   update  — partial: only the fields present in the arguments change.
//             title/summary must stay non-empty; content and order may be
//             rewritten (there is no way to clear `order`; set a new value).
//   remove  — one chapter by id, returned as `removed` (summary only).
//
// Cross-references:
//   - ../types   — RecordAction, ChapterStatus, ChapterSummary, ChapterItem,
//                  ChapterParameters, Tool
//   - ./metadata — CHAPTER_MANAGE_METADATA (name, description, tags, schema)
//   - ./todo     — the template this factory follows
//   - ../harness — registers the tool as core, reserves the name, resets it
//
// Result contracts (all list-shaped results carry `page`, mutations do not):
//   list                 → { chapters, counts, page }
//   add | update         → { chapter, counts }
//   get                  → { chapter, content, counts }
//   remove               → { removed, counts }

import { HarnessError } from '../util';
import type {
    ChapterItem,
    ChapterParameters,
    ChapterStatus,
    ChapterSummary,
    RecordAction,
    Tool
} from '../types';
import { CHAPTER_MANAGE_METADATA } from './metadata';
import { tool } from './tool';

// The accepted actions, in the order the error messages and schema advertise
// them. Identical for all three record tools.
const ACTIONS: readonly RecordAction[] = ['add', 'list', 'get', 'update', 'remove'];

const ACTION_HINT = ACTIONS.join(', ');

// The lifecycle states. Anything else is rejected, so a typo cannot create a
// status the counts do not know about.
const STATUSES: readonly ChapterStatus[] = ['planned', 'draft', 'complete'];

// The mutable fields an `update` may carry; used to reject an empty update.
const UPDATE_FIELDS = ['title', 'summary', 'content', 'status', 'order'] as const;

// R9 bounds. Exported so tests (and any UI) assert the exact limits.
export const CHAPTER_MAX_RECORDS = 200;
export const CHAPTER_MAX_NAME = 200;
export const CHAPTER_MAX_TEXT = 4000;
export const CHAPTER_LIST_DEFAULT_LIMIT = 20;
export const CHAPTER_LIST_MAX_LIMIT = 100;
export const CHAPTER_RESPONSE_BUDGET_BYTES = 64 * 1024;

// One page of a bounded list. `nextOffset` is present only when `hasMore`, so a
// caller loops `while (page.hasMore) { list(offset: page.nextOffset) }` and never
// skips chapters trimmed by the byte budget.
export type ChapterPageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
};

// Per-status totals derived from the whole store on every call, never from the
// page: a caller listing page 2 must still see every status total.
export type ChapterCounts = {
    total: number;
    planned: number;
    draft: number;
    complete: number;
};

// `list` result: the requested page of summaries (not a snapshot of the store).
export type ChapterListResult = {
    chapters: ChapterSummary[];
    counts: ChapterCounts;
    page: ChapterPageInfo;
};

// Mutation result: the affected summary (or removed summary), the derived
// counts, and - for `get` only - the body. No `chapters` array.
export type ChapterChangeResult = {
    chapter?: ChapterSummary;
    content?: string;
    removed?: ChapterSummary;
    counts: ChapterCounts;
};

export type ChapterResult = ChapterListResult | ChapterChangeResult;

// What createChapterTool() returns. Declared here (rather than in ../types)
// because the R9 bounded shape is owned by this module while ../types is shared
// with units still editing the same file; see the final report for the migration.
export type ChapterToolset = {
    tool: Tool<ChapterParameters, ChapterResult>;
    reset: () => void;
};

// Arrays are rejected: valid JSON, but it cannot carry an `action`.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// The metadata half of a chapter. `order` is copied only when present, so a
// summary never invents a position a chapter does not have.
const copySummary = (item: ChapterSummary): ChapterSummary => {
    const summary: ChapterSummary = {
        id: item.id,
        title: item.title,
        summary: item.summary,
        status: item.status
    };

    if (item.order !== undefined) summary.order = item.order;

    return summary;
};

// Sort position: ordered chapters first by ascending `order`, everything else
// after them. Comparing explicit ranks (rather than subtracting Infinity) keeps
// the comparator total, and a stable sort then preserves insertion order among
// the unordered remainder.
const rankOf = (item: ChapterSummary): number => item.order ?? Number.POSITIVE_INFINITY;

const orderedSummaries = (items: readonly ChapterItem[]): ChapterSummary[] =>
    [...items]
        .sort((left, right) => {
            const a = rankOf(left);
            const b = rankOf(right);

            if (a === b) return 0;
            return a < b ? -1 : 1;
        })
        .map(copySummary);

const countsOf = (items: readonly ChapterItem[]): ChapterCounts => {
    const counts: ChapterCounts = { total: items.length, planned: 0, draft: 0, complete: 0 };

    for (const item of items) counts[item.status]++;

    return counts;
};

// Read `offset` once, for every action: a negative or fractional cursor is a
// validation error, not a clamp.
const readOffset = (value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new HarnessError(
            'chapterManage "offset" must be a non-negative integer when provided.'
        );
    }

    return value as number;
};

// Read `limit` once, for every action. 1..CHAPTER_LIST_MAX_LIMIT; a bigger limit
// is rejected (not clamped) so the caller knows its page was not silently shrunk.
const readLimit = (value: unknown): number => {
    if (value === undefined) return CHAPTER_LIST_DEFAULT_LIMIT;

    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > CHAPTER_LIST_MAX_LIMIT
    ) {
        throw new HarnessError(
            `chapterManage "limit" must be an integer between 1 and ${CHAPTER_LIST_MAX_LIMIT} when provided.`
        );
    }

    return value as number;
};

// Build one budgeted page from the already-ordered summary view:
//   - summaries are copies, so the live store is never handed out;
//   - they are added while the serialized UTF-8 size stays inside
//     CHAPTER_RESPONSE_BUDGET_BYTES (a comma per summary is counted too);
//   - the first summary of a non-empty page is always included, so `nextOffset`
//     always advances (no stall, no gaps).
// `hasMore` is computed against the full ordered length, so a budget-truncated
// page reports the cursor of its last included summary rather than offset + limit.
const paginate = (
    ordered: readonly ChapterSummary[],
    offset: number,
    limit: number
): { chapters: ChapterSummary[]; page: ChapterPageInfo } => {
    const chapters: ChapterSummary[] = [];
    let bytes = 0;

    for (const item of ordered.slice(offset, offset + limit)) {
        const copy = copySummary(item);
        const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

        if (chapters.length > 0 && bytes + size > CHAPTER_RESPONSE_BUDGET_BYTES) break;

        chapters.push(copy);
        bytes += size;
    }

    const consumed = offset + chapters.length;
    const page: ChapterPageInfo = {
        offset,
        limit,
        hasMore: consumed < ordered.length
    };

    if (page.hasMore) page.nextOffset = consumed;

    return { chapters, page };
};

// Read `status` once, for every action: a wrong value is a validation error even
// on `list`, matching todoManage's up-front field checks. `undefined` means the
// caller omitted it (add defaults to 'planned', update leaves it unchanged).
const readStatus = (value: unknown): ChapterStatus | undefined => {
    if (value === undefined) return undefined;

    if (typeof value !== 'string' || !STATUSES.includes(value as ChapterStatus)) {
        throw new HarnessError(
            `chapterManage "status" must be one of: ${STATUSES.join(', ')} when provided.`
        );
    }

    return value as ChapterStatus;
};

// Read `order` once, for every action. Only safe integers are accepted: a
// fractional/NaN/Infinity position has no stable sort meaning.
const readOrder = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;

    if (!Number.isSafeInteger(value)) {
        throw new HarnessError('chapterManage "order" must be an integer when provided.');
    }

    return value as number;
};

// The per-harness chapter list. Ids are decimal strings, monotonic for the life
// of this instance, and restart at "1" after reset().
export const createChapterTool = (): ChapterToolset => {
    const items: ChapterItem[] = [];
    let nextId = 1;

    // Resolve an id for every action that names one, before the lookup, so a
    // missing id is not reported as "not found".
    const requireId = (input: Record<string, unknown>, action: RecordAction): string => {
        const id = input.id;

        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new HarnessError(`chapterManage "${action}" requires a non-empty "id" string.`);
        }

        return id;
    };

    // Look up one record without mutating anything.
    const requireItem = (id: string): ChapterItem => {
        const item = items.find((candidate) => candidate.id === id);

        if (!item) {
            throw new HarnessError(`chapterManage has no chapter with id "${id}".`);
        }

        return item;
    };

    // A required text field, trimmed, non-empty, and within `max` characters.
    // Missing/blank is reported against the action ("add" or "update") that
    // needed it; an oversized value reports both the length and the limit.
    const requireText = (
        value: unknown,
        action: RecordAction,
        field: string,
        max: number
    ): string => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new HarnessError(
                `chapterManage "${action}" requires a non-empty "${field}" string.`
            );
        }

        const text = value.trim();

        if (text.length > max) {
            throw new HarnessError(
                `chapterManage "${field}" is ${text.length} characters; the limit is ${max}. Shorten it and retry.`
            );
        }

        return text;
    };

    // An optional text field: absent becomes '', otherwise the trimmed value,
    // still under the same character cap. Content may be cleared to "" - an
    // empty body is a valid state (a planned chapter with no prose yet).
    const optionalText = (value: unknown, field: string, max: number): string => {
        const text = typeof value === 'string' ? value.trim() : '';

        if (text.length > max) {
            throw new HarnessError(
                `chapterManage "${field}" is ${text.length} characters; the limit is ${max}. Shorten it and retry.`
            );
        }

        return text;
    };

    // Name, description, tags, schema, and visibility come from the shared
    // metadata module. Core on purpose, like todoManage.
    const implementation = tool<ChapterParameters, ChapterResult>({
        name: CHAPTER_MANAGE_METADATA.name,
        description: CHAPTER_MANAGE_METADATA.description,
        tags: CHAPTER_MANAGE_METADATA.tags,
        visibility: CHAPTER_MANAGE_METADATA.visibility,
        parameters: CHAPTER_MANAGE_METADATA.parameters,
        execute: ({ parameters }) => {
            // A model can pass anything. One readable error for "not an object"
            // lets every action below assume a record.
            if (!isRecord(parameters)) {
                throw new HarnessError(
                    `chapterManage expects an object with an "action" (${ACTION_HINT}).`
                );
            }

            const action = parameters.action;

            if (typeof action !== 'string' || !ACTIONS.includes(action as RecordAction)) {
                throw new HarnessError(
                    `chapterManage requires "action" to be one of: ${ACTION_HINT}.`
                );
            }

            const resolvedAction = action as RecordAction;

            // Field types are validated once, for every action; wrong types are
            // errors even on list rather than silently ignored fields.
            if (parameters.id !== undefined && typeof parameters.id !== 'string') {
                throw new HarnessError('chapterManage "id" must be a string when provided.');
            }

            if (parameters.title !== undefined && typeof parameters.title !== 'string') {
                throw new HarnessError('chapterManage "title" must be a string when provided.');
            }

            if (parameters.summary !== undefined && typeof parameters.summary !== 'string') {
                throw new HarnessError('chapterManage "summary" must be a string when provided.');
            }

            if (parameters.content !== undefined && typeof parameters.content !== 'string') {
                throw new HarnessError('chapterManage "content" must be a string when provided.');
            }

            // Validate status/order for every action and reuse the normalized
            // values in add/update.
            const status = readStatus(parameters.status);
            const order = readOrder(parameters.order);

            // The pagination cursor is validated for every action too, so a
            // stray `limit: 500` on `add` is reported instead of ignored. The
            // schema declares offset/limit (see ./metadata.ts); ChapterParameters
            // is read through a raw record because this module's bounded result
            // contract is declared locally (see ChapterToolset above).
            const raw = parameters as unknown as Record<string, unknown>;
            const offset = readOffset(raw.offset);
            const limit = readLimit(raw.limit);

            switch (resolvedAction) {
                case 'add': {
                    // Build the whole record before touching the store: any
                    // invalid field means nothing is created and the id is not
                    // consumed.
                    const item: ChapterItem = {
                        id: String(nextId),
                        title: requireText(parameters.title, 'add', 'title', CHAPTER_MAX_NAME),
                        summary: requireText(
                            parameters.summary,
                            'add',
                            'summary',
                            CHAPTER_MAX_TEXT
                        ),
                        content: optionalText(parameters.content, 'content', CHAPTER_MAX_TEXT),
                        status: status ?? 'planned'
                    };

                    if (order !== undefined) item.order = order;

                    // Capacity is checked before the id is consumed: a full store
                    // is an actionable error, and a failed add never burns an id.
                    if (items.length >= CHAPTER_MAX_RECORDS) {
                        throw new HarnessError(
                            `chapterManage already holds the maximum of ${CHAPTER_MAX_RECORDS} chapters; remove one before adding another.`
                        );
                    }

                    nextId++;
                    items.push(item);

                    return { chapter: copySummary(item), counts: countsOf(items) };
                }

                case 'list': {
                    // Sort a copy first, then take one page from the sorted view:
                    // the live array keeps insertion order.
                    const { chapters, page } = paginate(orderedSummaries(items), offset, limit);

                    return { chapters, counts: countsOf(items), page };
                }

                case 'get': {
                    const item = requireItem(requireId(parameters, resolvedAction));

                    // The only action that pays for the body. An empty body is
                    // the string "" and is still reported, so `get` is explicit.
                    return {
                        chapter: copySummary(item),
                        content: item.content,
                        counts: countsOf(items)
                    };
                }

                case 'update': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // Partial update into a patch first, so a later invalid
                    // field cannot leave earlier ones applied.
                    const patch: Partial<ChapterItem> = {};

                    if (parameters.title !== undefined) {
                        patch.title = requireText(
                            parameters.title,
                            'update',
                            'title',
                            CHAPTER_MAX_NAME
                        );
                    }

                    if (parameters.summary !== undefined) {
                        patch.summary = requireText(
                            parameters.summary,
                            'update',
                            'summary',
                            CHAPTER_MAX_TEXT
                        );
                    }

                    // Content may be cleared to "": an empty body is a valid
                    // state (a planned chapter with no prose yet).
                    if (parameters.content !== undefined) {
                        patch.content = optionalText(parameters.content, 'content', CHAPTER_MAX_TEXT);
                    }

                    if (status !== undefined) patch.status = status;
                    if (order !== undefined) patch.order = order;

                    if (Object.keys(patch).length === 0) {
                        throw new HarnessError(
                            `chapterManage "update" requires at least one of: ${UPDATE_FIELDS.join(', ')}.`
                        );
                    }

                    Object.assign(item, patch);

                    // Summaries only: an update that rewrote the body does not
                    // echo it back.
                    return { chapter: copySummary(item), counts: countsOf(items) };
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`chapterManage has no chapter with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return { removed: copySummary(removed), counts: countsOf(items) };
                }
            }
        }
    });

    return {
        tool: implementation,
        // Clear the records and restart the id sequence with harness.reset().
        reset: () => {
            items.splice(0, items.length);
            nextId = 1;
        }
    };
};
