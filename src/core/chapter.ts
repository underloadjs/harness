// chapters — the `chapters` COLLECTION SPECIFICATION (records-engine T2/T3).
//
// Same shape as ./profile.ts: the field spec only. The engine owns CRUD, bounds,
// pagination, revisions, the change window and the CAS rules (./records.ts).
//
// The three chapter-specific behaviours below are DECLARED rather than hard-coded
// in the engine, because a generic store cannot invent them (finding F9):
//   - `content` is `getOnly`: lists, pages and mutation results carry summaries,
//     and only a single-record `get` returns the body — so ten listed chapters do
//     not cost ten bodies;
//   - `order` is the ascending sort key: chapters that have one come first, in
//     ascending order, and the rest stay in insertion order (a stable sort), which
//     is why there is no move action;
//   - `status` is a closed enum whose values become the count facets
//     (`{ total, planned, draft, complete }`).
//
// Cross-references:
//   - ./records.ts                          — the engine
//   - ../tools/runtime/chapters.tool.ts     — CHAPTERS_NAME / CHAPTERS_METADATA
//   - ../types                              — RecordCollectionDefinition, ChapterStatus

import type { RecordCollectionDefinition } from '../types';

// R9 bounds, unchanged by the redesign: 200 chapters, 200-character titles, 4000
// characters of summary/body.
export const CHAPTER_MAX_RECORDS = 200;
export const CHAPTER_MAX_NAME = 200;
export const CHAPTER_MAX_TEXT = 4000;

// The lifecycle states. Anything else is rejected, so a typo cannot create a
// status the counts do not know about.
export const CHAPTER_STATUSES = ['planned', 'draft', 'complete'] as const;

// The highest sort position a chapter may claim. The old store accepted any safe
// integer; the engine bounds it so a `define`d sortable field cannot overflow the
// page's numeric comparison, and `order` stays an ordinary optional integer.
export const CHAPTER_MAX_ORDER = 1_000_000;

export const CHAPTERS_COLLECTION: RecordCollectionDefinition = {
    name: 'chapters',
    maxRecords: CHAPTER_MAX_RECORDS,
    responseBudgetBytes: 64 * 1024,
    wrapper: { tool: 'chapters', plural: 'chapters', singular: 'chapter', style: 'action' },
    fields: [
        { key: 'title', type: 'text', required: true, maxLength: CHAPTER_MAX_NAME },
        { key: 'summary', type: 'text', required: true, maxLength: CHAPTER_MAX_TEXT },
        // The body. `getOnly`, so it never rides along in a page or a mutation
        // result, and it may be cleared with an empty string.
        { key: 'content', type: 'text', maxLength: CHAPTER_MAX_TEXT, default: '', getOnly: true },
        {
            key: 'status',
            type: 'enum',
            values: CHAPTER_STATUSES,
            default: 'planned',
            count: true
        },
        // Optional sort position: absent until written, and there is no way to clear
        // it (the historical contract — set a new value instead).
        { key: 'order', type: 'integer', sortable: true, max: CHAPTER_MAX_ORDER }
    ]
};
