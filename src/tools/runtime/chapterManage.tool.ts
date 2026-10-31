// chapterManage — standalone source entry; state lives in the harness record store.
import type { CoreToolMetadata } from '../../core';
import type { ToolContext } from '../../types';

export const CHAPTER_MANAGE_NAME = 'chapterManage';

// Session chapters. The description states the two chapter-specific rules the
// model must know: summaries in lists/results, and the body only from "get".
export const CHAPTER_MANAGE_METADATA: CoreToolMetadata = {
    name: CHAPTER_MANAGE_NAME,
    description:
        'Manage chapters for this harness session. Actions: "add" (requires title and summary; optional content, status and order), "list", "get" (requires id), "update" (requires id and at least one of title, summary, content, status, order; fields you omit are unchanged), and "remove" (requires id). Status is planned, draft or complete and defaults to planned. The optional integer order sorts list: ordered chapters first ascending, unordered ones after in insertion order. Ids are stable strings returned by "add". Lists and mutation results carry summaries without the body; only "get" returns content. Chapters are shared by every agent in this harness, kept across turns, and cleared by reset. "list" returns ONE PAGE: { chapters, counts { total, planned, draft, complete }, page { offset, limit, hasMore, nextOffset? } } - 20 by default, at most 100, 64 KiB serialized page budget. "get" returns { chapter, content, counts }; "add"/"update" return { chapter, counts } and "remove" returns { removed, counts }, with NO list. Caps: 200 chapters, 200-character titles, 4000-character summaries and content.',
    tags: ['chapter', 'chapters', 'story', 'writing', 'outline', 'book'],
    visibility: 'core',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'get', 'update', 'remove'],
                description: 'One of: add, list, get, update, remove.'
            },
            id: {
                type: 'string',
                description: 'Chapter id returned by "add". Required for get/update/remove.'
            },
            title: {
                type: 'string',
                maxLength: 200,
                description:
                    'Chapter title for "add", or a replacement for "update". Required for "add"; trimmed. Maximum 200 characters.'
            },
            summary: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Short summary for "add", or a replacement for "update". Required for "add"; trimmed. Returned by list. Maximum 4000 characters.'
            },
            content: {
                type: 'string',
                maxLength: 4000,
                description:
                    'Chapter body for "add" or "update". Optional; trimmed. Never returned by list or mutation results - use "get" to read it. Maximum 4000 characters.'
            },
            status: {
                type: 'string',
                enum: ['planned', 'draft', 'complete'],
                description:
                    'Chapter status. Defaults to "planned" on add; omitting it on update leaves it unchanged.'
            },
            order: {
                type: 'integer',
                description:
                    'Optional sort position. Lower values list first; chapters without one follow in insertion order. Omitting it on update leaves it unchanged.'
            },
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'For "list" only: 0-based index of the first chapter. Defaults to 0; use page.nextOffset from the previous page.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description: 'For "list" only: page size, 1-100. Defaults to 20.'
            }
        },
        required: ['action'],
        additionalProperties: false
    }
};

export const metadata = CHAPTER_MANAGE_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 80,
    sessionBound: true,
    alwaysDeclared: true,
    listed: true
} as const;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('chapterManage requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('chapterManage', context);
