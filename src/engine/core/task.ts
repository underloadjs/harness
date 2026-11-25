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
    // THE CONFIGURED PAGE BUDGET — 64 KiB, the number this collection was born with.
    // It is what the PRODUCER pages by: `project` stops the page at the last whole row
    // that fits this many bytes and sets `page.budgetTruncated` (./records.ts:3466, stop at :3515).
    //
    // It is NOT the delivery guarantee, and F7-4 (2026-11-25) is why the two are kept
    // apart. The harness delivers ONE tool result at 32,768 payload bytes
    // (`MODEL_TOOL_RESULT_BUDGET_BYTES`, ./result-budget.ts:231) and REFUSES a JSON
    // document past it (./result-budget.ts:557-578), so a 64 KiB page cannot reach the
    // model whole — but the fix is the serve-time clamp in `clampToDeliveryCap`
    // (./records.ts:739), not a lower number here. F1-6 lowered this to 24 KiB, which
    // turned a previously valid `define` into a refusal, rewrote every persisted 65,536,
    // and STILL left a single record (16 fields x 4,000 chars) overshooting the cap.
    // So: the budget states what the caller asked for, the clamp states what the harness
    // can carry, and a clamped answer says which bound fired
    // (`page.deliveryBudgetBytes`). R8 keeps this number tunable, 1,024..65,536
    // (`RECORD_MIN/MAX_RESPONSE_BUDGET_BYTES`, ./records.ts:186).
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
