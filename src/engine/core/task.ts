// tasks — the `tasks` COLLECTION SPECIFICATION (records-engine T2/T3).
//
// This file used to be the whole task store: ~1,700 lines of CRUD, bounds,
// pagination, CAS and change feed. All of that now lives ONCE in ./records.ts —
// the unified session store engine — and what remains here is the one thing the
// engine cannot infer (finding F9): what a task IS.
//
// `tasks` is the collection formerly spelled `task`. Decision J renamed the TOOL
// to the plural (the store is a collection, the act is one), Decision K made the
// collection key identical to the tool name, and Decision I kept this wrapper
// `core`: the session plan's task list is the one store an agent needs before it
// has discovered anything, so it stays in the bootstrap.
//
// Decision P (round 7) is why this spec has no lock: the claim/lease protocol was
// deleted, not demoted. Every patch is accepted unless it is stale, and a stale
// rejection carries the current entry (R9). Do not "restore the missing claim
// support" — that undoes the ruling.
//
// The canonical FIELD ORDER below is load-bearing: it decides the key order of
// every emitted entry, every persisted entry (so a store always serializes to the
// same byte size for the page budget) and every `fields` array in the change log
// (so a disjoint merge can be compared without sorting).
//
// Cross-references:
//   - ./records.ts                      — the engine that reads and writes this
//   - ../tools/runtime/tasks.tool.ts    — TASKS_NAME / TASKS_METADATA (schema + description)
//   - ../types                          — RecordCollectionDefinition, RecordFieldDefinition, TaskItem
//   - ../server/workers/capability.ts   — the tool names routed to the authority

import type { RecordCollectionDefinition } from '../types';

// R9 bounds, unchanged by the redesign: 200 records and a 4000-character text.
// They are exported so tests and any UI assert the exact limits instead of
// hard-coding a number a second time.
export const TASK_MAX_RECORDS = 200;
export const TASK_MAX_TEXT = 4000;

// The collection. `text` is required on add and must stay non-empty; `completed`
// defaults to false and is never required. The boolean `count` facet is what makes
// the result carry `{ total, completed, pending }` — the complement key is the
// engine's, not a hand-written counter.
export const TASKS_COLLECTION: RecordCollectionDefinition = {
    name: 'tasks',
    maxRecords: TASK_MAX_RECORDS,
    // F13's real invariant is about the RELATION of the two budgets, and the old sentence
    // for it is stale: the page is budgeted at 64 KiB while ./result-budget.ts caps one
    // rendered tool result at MODEL_TOOL_RESULT_BUDGET_BYTES = 32,768 payload bytes, so the
    // inner budget is the LARGER of the two — the 256 KiB this comment used to quote no
    // longer exists. What still holds is the honest half: a page over the cap is never
    // silently truncated behind a `hasMore: false` claim. It is REFUSED at the delivery seam
    // (F-CUTTER) with a "re-run with narrower arguments" error the caller can act on. R8
    // says the 64 KiB number itself is tunable; an agent that needs a page to arrive whole
    // sets `responseBudgetBytes` at or below 32,768.
    responseBudgetBytes: 64 * 1024,
    wrapper: { tool: 'tasks', plural: 'tasks', singular: 'task', style: 'batch' },
    fields: [
        {
            key: 'text',
            type: 'text',
            required: true,
            maxLength: TASK_MAX_TEXT
        },
        {
            key: 'completed',
            type: 'boolean',
            default: false,
            count: { key: 'completed', complement: 'pending' }
        }
    ]
};
