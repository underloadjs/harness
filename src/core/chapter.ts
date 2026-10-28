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
//     sorted; the sorted copy is only used to build the result.
//
// ACTIONS (shared by profile/chapter/location):
//   add     — requires title + summary; content/status/order optional.
//             status defaults to 'planned' and content to ''.
//   list    — summaries only, in the order described above.
//   get     — one summary plus its full `content`.
//   update  — partial: only the fields present in the arguments change.
//             title/summary must stay non-empty; content and order may be
//             rewritten (there is no way to clear `order`; set a new value).
//   remove  — one chapter by id, returned as `removed` (summary only).
//
// Cross-references:
//   - ../types   — RecordAction, ChapterStatus, ChapterSummary, ChapterItem,
//                  ChapterParameters, ChapterResult, ChapterToolset
//   - ./metadata — CHAPTER_MANAGE_METADATA (name, description, tags, schema)
//   - ./todo     — the template this factory follows
//   - ../harness — registers the tool as core, reserves the name, resets it

import { HarnessError } from '../util';
import type {
    ChapterItem,
    ChapterParameters,
    ChapterResult,
    ChapterStatus,
    ChapterSummary,
    ChapterToolset,
    RecordAction
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

// The result envelope. `chapters` is always a sorted summary snapshot;
// `chapter` is a summary, `content` is present only for `get`, and `removed` is
// the summary of the deleted chapter.
const compose = (
    items: readonly ChapterItem[],
    extra: { chapter?: ChapterItem; removed?: ChapterItem; content?: string } = {}
): ChapterResult => {
    const counts = { total: items.length, planned: 0, draft: 0, complete: 0 };

    for (const item of items) counts[item.status]++;

    const result: ChapterResult = {
        chapters: orderedSummaries(items),
        counts
    };

    if (extra.chapter) result.chapter = copySummary(extra.chapter);
    if (extra.removed) result.removed = copySummary(extra.removed);
    // `undefined` means this action did not read the body; an empty body is the
    // string "" and must still be reported so `get` is always explicit.
    if (extra.content !== undefined) result.content = extra.content;

    return result;
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

    // A required text field, trimmed. Missing/blank is reported against the
    // action ("add" or "update") that needed it.
    const requireText = (value: unknown, action: RecordAction, field: string): string => {
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new HarnessError(
                `chapterManage "${action}" requires a non-empty "${field}" string.`
            );
        }

        return value.trim();
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

            switch (resolvedAction) {
                case 'add': {
                    // Build the whole record before touching the store: any
                    // invalid field means nothing is created and the id is not
                    // consumed.
                    const item: ChapterItem = {
                        id: String(nextId),
                        title: requireText(parameters.title, 'add', 'title'),
                        summary: requireText(parameters.summary, 'add', 'summary'),
                        content:
                            parameters.content === undefined
                                ? ''
                                : String(parameters.content).trim(),
                        status: status ?? 'planned'
                    };

                    if (order !== undefined) item.order = order;

                    nextId++;
                    items.push(item);

                    return compose(items, { chapter: item });
                }

                case 'list':
                    return compose(items);

                case 'get': {
                    const item = requireItem(requireId(parameters, resolvedAction));

                    // The only action that pays for the body.
                    return compose(items, { chapter: item, content: item.content });
                }

                case 'update': {
                    const id = requireId(parameters, resolvedAction);
                    const item = requireItem(id);

                    // Partial update into a patch first, so a later invalid
                    // field cannot leave earlier ones applied.
                    const patch: Partial<ChapterItem> = {};

                    if (parameters.title !== undefined) {
                        patch.title = requireText(parameters.title, 'update', 'title');
                    }

                    if (parameters.summary !== undefined) {
                        patch.summary = requireText(parameters.summary, 'update', 'summary');
                    }

                    // Content may be cleared to "": an empty body is a valid
                    // state (a planned chapter with no prose yet).
                    if (parameters.content !== undefined) {
                        patch.content = String(parameters.content).trim();
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
                    return compose(items, { chapter: item });
                }

                case 'remove': {
                    const id = requireId(parameters, resolvedAction);
                    const index = items.findIndex((candidate) => candidate.id === id);

                    if (index === -1) {
                        throw new HarnessError(`chapterManage has no chapter with id "${id}".`);
                    }

                    const [removed] = items.splice(index, 1);

                    return compose(items, { removed });
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
