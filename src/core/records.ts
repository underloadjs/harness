// records — the ONE session store engine (docs/tasks/2026-11-08-records-engine.md).
//
// WHAT THIS MODULE IS
// -------------------
// Every record the session keeps lives in this one store: the task list, the
// chapters, the profiles, the locations, and any collection an agent registers at
// runtime with `define`. `tasks`, `chapters`, `profiles` and `locations` are thin
// WRAPPERS over it (Decision E): they carry a schema and a response shape, and hold
// no state and no logic of their own. `records` is the low-level surface an agent
// escalates to when a wrapper's schema refuses a request (R4/R6) — it accepts
// anything a wrapper accepts and more.
//
// The duplication this removes is measured, not asserted: finding F1 diffed the
// three old store modules after name-normalizing them and found ~400 identical lines
// per file (ACTIONS, readOffset, readLimit, paginate, requireId/requireItem/
// requireText/optionalText, snapshot/restore), with the ONLY real differences being
// one field spec. This file is that shared half, written once; the field specs live
// next to their collection (./task.ts, ./profile.ts, ./chapter.ts, ./location.ts).
//
// THE RULES THIS ENGINE OWNS
// --------------------------
//   - ONE store, ONE id counter (F3): ids are globally unique ACROSS collections,
//     so a task and a chapter can never collide and the first task is not
//     necessarily "1". Consequence, accepted deliberately: an id that used to mean
//     "row 1 of the task list" now means "record 1 of the session".
//   - per-collection `storeRev` + per-collection FIFO change window (Decision B):
//     `mergeConcurrentFields`' safety proof needs a GAP-FREE window from
//     `expected+1` to the record's current revision, and a log shared across four
//     collections would turn unrelated chapter writes into holes that silently
//     degrade a provable merge to "usually refused". Per-collection `since:` also
//     stays relevant — a task reader is not woken by chapter edits.
//   - NO locks, NO claims (Decision P, round 7): every patch is accepted unless it
//     is stale. There is no `owner`, no `ownerThreadId`, no `leaseUntil`, no
//     `claim`/`release`/`takeover` verb, no lease constant, and no `releaseThread`
//     lifecycle hook — the sweep existed only because a lock could outlive its
//     holder. A reviewer who "restores the missing claim support" has undone R3.
//   - the CAS token (`expects: [{ id, rev }]`) is therefore the ONLY conflict
//     control, so its rejection must be complete: R9 requires a stale refusal to
//     CARRY THE CURRENT ENTRY (fields and values), not merely a reason. One round
//     trip, not two.
//   - attribution is an immutable fact (Decision L): `updatedBy`/`updatedThreadId`/
//     `updatedAt` are read from the ToolContext, never from arguments, and are never
//     re-validated against the agent roster. A snapshot naming a departed agent
//     restores and reports it unchanged.
//   - store-level bounds are engine-owned (Decision G / F13): 200 entries per
//     collection by default, and a page budget below the outer model-facing cap so a
//     page can never report `hasMore: false` while the envelope truncates it.
//     Field-level caps are the TOOL's (R6) — an escalation to `records` is the
//     documented way to get more room, which is only true of collections an agent
//     did not declare.
//   - collections are permanent once non-empty and their DEFINITIONS persist in the
//     snapshot (Decision M): a `define` of an existing name is an error, a `define`d
//     collection drops only when empty, and a built-in never drops — dropping a
//     non-empty collection would itself mutate history.
//   - every rejection carries a stable machine CODE (Decision O / F17), following
//     the ./nested-runs.ts precedent: the code is `error.name`, `error.code`, and the
//     first token of the message, so the model, the HTTP surface, a worker report and
//     an operator all quote one identifiable name and a wrapper can switch on it
//     instead of pattern-matching prose that ../harness.ts prefixes anyway.
//
// APPLY ORDER (corrected by Decision P — the first four of task's seven steps died
// with the claims): **patches → removals → additions**. Removals are netted off the
// capacity check, so a caller may restate a full section in one call. Every step
// BEFORE the apply loops only reads the store, so a rejection anywhere in validation
// leaves items, the id counter, every `storeRev` and every change log exactly as
// they were — including a rejected CAS, which burns no id.
//
// RESULT CONTRACT — ONE shape for every success (Decision D):
//   { entries | entry | removed, counts, page, storeRev, changes?, … }
// `rev` is in every entry because F7 proved the alternative: without it, a guarded
// write costs an extra full-list read per write just to harvest tokens (which is
// precisely the dance ../core/command-builtins.ts documents and pays for today).
// The wrappers reshape this envelope into their own domain contract (tasks returns
// `{ tasks, … }`, the action wrappers return `{ profile }` / `{ removed }` / …), and
// a wrapper's reshape never drops the rev a caller needs for its next write.
//
// Cross-references:
//   - ../types                            — RecordEntry, RecordChange, RecordsResult,
//                                           RecordsStoreState, RecordCollectionDefinition
//   - ./task.ts ./profile.ts ./chapter.ts ./location.ts — the four built-in specs
//   - ./metadata.ts                       — the five tool definitions (name, description, schema)
//   - ../tools/runtime/records.tool.ts + tasks/chapters/profiles/locations .tool.ts
//                                         — the source entries; each ends with
//                                         `context.harness.runtime.executeRecords(NAME, context)`
//   - ../harness.ts                       — one store closure per harness; `reset()` clears it;
//                                           snapshot()/restore() persist it
//   - ./result-budget.ts                  — MODEL_TOOL_RESULT_BUDGET_BYTES (256 KiB), the outer cap
//   - ./snapshot-validation.ts            — the strict readers this module's restore uses
//   - ../server/workers/lane-authority.ts — routes a lane's wrapper write here (Decision A)

import { HarnessError, isInstanceOf } from '../util';
import type {
    RecordAction,
    RecordChange,
    RecordCollectionDefinition,
    RecordCollectionState,
    RecordCounts,
    RecordEntry,
    RecordExpect,
    RecordFieldDefinition,
    RecordsPageInfo,
    RecordsParameters,
    RecordsResult,
    RecordsStoreState,
    RecordsToolName,
    RecordStoreChange,
    RecordStoreChangeReason,
    RecordStoreCollection,
    RecordStoreDelta,
    RecordStoreNotification,
    RecordStoreView,
    Tool,
    ToolContext
} from '../types';
import {
    CHAPTERS_METADATA,
    CHAPTERS_NAME,
    LOCATIONS_METADATA,
    LOCATIONS_NAME,
    PROFILES_METADATA,
    PROFILES_NAME,
    RECORDS_METADATA,
    RECORDS_NAME,
    TASKS_METADATA,
    TASKS_NAME
} from './metadata';
import { tool } from './tool';
import {
    readSnapshotArray,
    readSnapshotId,
    readSnapshotIdCounter,
    readSnapshotInteger,
    readSnapshotKeys,
    readSnapshotRecord,
    readSnapshotString
} from './snapshot-validation';
import { CHAPTERS_COLLECTION } from './chapter';
import { LOCATIONS_COLLECTION } from './location';
import { PROFILES_COLLECTION } from './profile';
import { TASKS_COLLECTION } from './task';

// ---------------------------------------------------------------------------
// Engine bounds (Decision G / F13 / R8)
// ---------------------------------------------------------------------------
//
// The numbers a wrapper may NOT lower and an agent may not exceed without saying
// so. R8: the byte budgets exist to stop a non-deterministic agent flooding its own
// context window — they are tunable, not load-bearing. What IS load-bearing is that
// the page budget stays below MODEL_TOOL_RESULT_BUDGET_BYTES (256 KiB), because an
// inner page that claims `hasMore: false` while the outer envelope truncates it is a
// lie the model cannot detect.
export const RECORD_MAX_RECORDS = 200;
export const RECORD_MIN_RECORDS = 1;
export const RECORD_MAX_TEXT = 4000;
export const RECORD_MAX_ITEMS = 32;
export const RECORD_LIST_DEFAULT_LIMIT = 20;
export const RECORD_LIST_MAX_LIMIT = 100;
export const RECORD_RESPONSE_BUDGET_BYTES = 64 * 1024;

// Per-collection change window (Decision B). 200 retained events, at most 50 handed
// back per call, both FIFO. Sizing note from the old task store, still true and now
// per collection rather than per session: the window is what makes `since` cheap and
// a disjoint merge provable, so it must outlive a normal working burst without
// holding memory hostage.
export const RECORD_MAX_CHANGES = 200;
export const RECORD_MAX_CHANGES_IN_RESULT = 50;

// Bounds on a `define`d collection: enough fields to model anything an agent would
// hand-roll, few enough that the page budget stays predictable, and a name short
// enough to read in an error message.
export const RECORD_MAX_FIELDS = 16;
export const RECORD_MAX_COLLECTION_NAME = 200;

// R9's payload budget. The current entry rides inside the REJECTION, so it is
// budgeted like a page: a chapter with a 4000-character body must not turn a
// conflict into a second flood. When the whole entry does not fit, the engine drops
// the `getOnly` fields (the projection a list already uses) and says so — a
// degradation the caller can read, never a silent truncation.
export const RECORD_STALE_PAYLOAD_BUDGET_BYTES = 8 * 1024;

// The batch size a single call may carry. Not a context rule — a 200-add call is
// legal — but an unbounded array in one model turn is a flooding risk of its own.
export const RECORD_MAX_BATCH = 200;

// ---------------------------------------------------------------------------
// Stable rejection codes (Decision O / T6b, closing F17)
// ---------------------------------------------------------------------------
//
// The minimum set the decision names, plus the codes for the rejections a wrapper
// still has to distinguish. `claimed-record` is NOT here: Decision P deleted the
// only condition that could raise it, which leaves `stale-record` as the ONLY
// write-conflict code — and that is exactly why R9 exists, because the one code
// left has to carry the whole story.
//
// The code is `error.name`, `error.code`, AND the first token of the message (the
// ./nested-runs.ts precedent), because ../harness.ts renders a thrown error as
// `Tool "<name>" failed: <message>` and only the message reaches a model, an SSE
// consumer or a worker report.
export const RECORD_ERROR_CODES = {
    // Argument shape: a wrong type, a bad cursor, a combination that contradicts
    // itself. The message names the exact field; the code says "fix your call".
    invalidInput: 'invalid-input',
    // The named collection is not registered (Decision C). Loud, and it lists what IS.
    unknownCollection: 'unknown-collection',
    // `define` of a name that already exists — never a silent merge (Decision M).
    collectionExists: 'collection-exists',
    // `drop` of a collection that still holds records (Decision M).
    collectionNotEmpty: 'collection-not-empty',
    // `drop` of a built-in collection, which is permanent by declaration.
    collectionPermanent: 'collection-permanent',
    // R3/T3.2 — the caller's `since` predates the CURRENT change log of a collection
    // that was dropped and re-`define`d under it. Distinct from `invalid-input` on
    // purpose: the number the client sent was correct when it saved it, so the only
    // honest answer is "the epoch moved — resync from scratch", not "you sent a bad
    // number". Codes are enumerated from this object everywhere (`isRecordRejection`
    // reads `Object.values`), so adding a key here is the whole registration.
    revisionEpochReset: 'revision-epoch-reset',
    // A `define`d field spec that does not hold together (bad type, empty list,
    // duplicate or reserved key, cap out of range).
    definitionInvalid: 'definition-invalid',
    // A `define`d `maxRecords` outside RECORD_MIN_RECORDS..RECORD_MAX_RECORDS.
    recordCap: 'record-cap',
    // The collection is at capacity: an actionable error, and a failed add never
    // burns an id from the monotonic counter.
    storeFull: 'store-full',
    // A field the collection does not declare.
    unknownField: 'unknown-field',
    // A field whose value has the wrong type, an unknown enum value, or a missing
    // required value.
    invalidField: 'invalid-field',
    // A field over its character / item cap, naming the actual size and the limit.
    fieldTooLong: 'field-too-long',
    // An id this call names that the collection does not have.
    unknownRecord: 'unknown-record',
    // An identified caller patched or removed a record without reading it first.
    guardedWrite: 'guarded-write',
    // The CAS token did not match: the ONLY conflict this engine has (Decision P),
    // and its payload carries the current entry (R9).
    staleRecord: 'stale-record',
    // One id named by two operations in one call (patched twice, or patched AND
    // removed, or read AND changed).
    batchConflict: 'batch-conflict'
} as const;

export type RecordErrorCode = (typeof RECORD_ERROR_CODES)[keyof typeof RECORD_ERROR_CODES];

// One rejection, coded. The code is spliced in as the message's first token so the
// greppable name survives every renderer between here and the model.
const recordError = (
    code: RecordErrorCode,
    message: string,
    details?: unknown
): HarnessError =>
    new HarnessError(`${code}: ${message}`, {
        code,
        ...(details === undefined ? {} : { details })
    });

// The human-facing label for a collection: the wrapper's singular noun when it has
// one (`task`, `profile`), otherwise the collection name. It keeps the historical
// sentence shape (`tasks has no task with id "9".`) while the code carries the
// machine name.
const recordLabel = (definition: RecordCollectionDefinition): string =>
    definition.wrapper === undefined ? definition.name : definition.wrapper.singular;

// The label argument errors quote: the wrapper's tool name when the call came through
// a wrapper, otherwise the collection itself. Naming the COLLECTION rather than
// "records" is what Decision O asks for — "name the collection, the id, the field,
// the limit, and the fix".
const callLabelOf = (definition: RecordCollectionDefinition): string =>
    definition.wrapper === undefined ? definition.name : definition.wrapper.tool;

// A field's character cap, i.e. the limit an oversized write is measured against.
// `strings` caps its ELEMENTS; the array itself is capped by `maxItems`.
const fieldCapOf = (field: RecordFieldDefinition): number | undefined =>
    field.type === 'text' || field.type === 'strings' ? field.maxLength : undefined;

// True for the keys every entry owns and a field may therefore never claim.
const RESERVED_ENTRY_KEYS: readonly string[] = ['id', 'rev', 'updatedBy', 'updatedThreadId', 'updatedAt'];

// Type guard for the argument object. Arrays are rejected: `[1,2]` is valid JSON but
// cannot carry a patch, and accepting it would make the error less specific than the
// schema suggests.
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Entry copies and projections
// ---------------------------------------------------------------------------
//
// Copy on the way out, ALWAYS. A caller or a model-visible result must never hold a
// reference into the live store, or `result.entries[0].completed = true` in a UI
// would mutate session state behind the tool's back. A `strings` field is copied too.
//
// Key ORDER is fixed here and in the snapshot reader: id, then the declared fields
// in canonical order, then `rev`, then the attribution triple. Optional keys stay
// ABSENT rather than `undefined`-valued — a key present with value `undefined`
// serializes as a missing key but still breaks a deep-equal comparison, and the byte
// budget below measures the real serialized shape.
const copyEntry = (
    definition: RecordCollectionDefinition,
    entry: RecordEntry,
    // `full` keeps `getOnly` fields (a single-record `get`, and R9's payload when it
    // fits). Every page, mutation result and snapshot copy uses the projection, which
    // is what keeps ten listed chapters from costing ten bodies.
    full: boolean = false
): RecordEntry => {
    const copy: Record<string, unknown> = { id: entry.id };

    for (const field of definition.fields) {
        if (field.getOnly === true && full === false) continue;

        const value = entry[field.key];

        // A `getOnly` field that is present but excluded is DROPPED, not emptied: a
        // projection that carries `content: ''` would read as "this chapter has no
        // body", which is a different fact from "this page does not show bodies".
        if (value === undefined) continue;

        copy[field.key] = Array.isArray(value) ? [...(value as unknown[])] : value;
    }

    copy.rev = entry.rev;

    if (entry.updatedBy !== undefined) copy.updatedBy = entry.updatedBy;
    if (entry.updatedThreadId !== undefined) copy.updatedThreadId = entry.updatedThreadId;
    if (entry.updatedAt !== undefined) copy.updatedAt = entry.updatedAt;

    return copy as RecordEntry;
};

// Same rule for a change entry: detached copy, defined keys only, canonical order,
// and a copied `fields` array so a caller cannot push into the log through a result.
const copyChange = (change: RecordChange): RecordChange => ({
    rev: change.rev,
    id: change.id,
    op: change.op,
    ...(change.by === undefined ? {} : { by: change.by }),
    ...(change.threadId === undefined ? {} : { threadId: change.threadId }),
    at: change.at,
    ...(change.fields === undefined ? {} : { fields: [...change.fields] }),
    ...(change.itemRev === undefined ? {} : { itemRev: change.itemRev })
});

// Counts are always derived from the WHOLE selection, never from the page (F9): a
// caller listing page 2 must still see how many records exist in total. The selection
// is the whole collection for an unfiltered read, and the matching set for a read that
// sent `where` (R7/T7.1 — see the note in `project`, which is the only caller that can
// narrow it). The facets come from the definition, which is the only way a generic
// engine can produce `{ total, completed, pending }` for tasks and `{ total, planned,
// draft, complete }` for chapters without inventing either.
const countsOf = (
    definition: RecordCollectionDefinition,
    items: readonly RecordEntry[]
): RecordCounts => {
    const counts: RecordCounts = { total: items.length };

    for (const field of definition.fields) {
        const count = field.count;

        if (count === undefined) continue;

        if (count === true) {
            // An enum: one count per declared value, in the declared order, so a
            // caller can compare count objects without sorting keys.
            for (const value of field.values ?? []) {
                counts[value] = items.filter((item) => item[field.key] === value).length;
            }

            continue;
        }

        const matching = items.filter((item) => item[field.key] === true).length;

        counts[count.key] = matching;

        if (count.complement !== undefined) counts[count.complement] = items.length - matching;
    }

    return counts;
};

// R6/T6.1 — a detached copy of a stored definition, for `describe`. The engine hands
// results out by copy everywhere else (a caller must not be able to widen a cap or push
// into `values` through an answer it was given), and the definition object is shared by
// every collection built from a spec, so this is the same rule rather than a new one.
// Key order follows the declared field order, i.e. the order a page emits fields in.
const cloneDefinition = (
    definition: RecordCollectionDefinition
): RecordCollectionDefinition => ({
    name: definition.name,
    fields: definition.fields.map((field) => ({
        ...field,
        ...(field.values === undefined ? {} : { values: [...field.values] }),
        ...(Array.isArray(field.default)
            ? { default: [...(field.default as unknown[])] }
            : {}),
        ...(field.count !== undefined && field.count !== true
            ? { count: { ...field.count } }
            : {})
    })),
    maxRecords: definition.maxRecords,
    responseBudgetBytes: definition.responseBudgetBytes,
    // The wrapper half is part of the definition, and it is the answer to "which tool
    // serves this collection", so it rides verbatim when the collection has one.
    ...(definition.wrapper === undefined ? {} : { wrapper: { ...definition.wrapper } })
});

// ---------------------------------------------------------------------------
// Argument readers (engine-wide — the wrappers no longer own copies of these)
// ---------------------------------------------------------------------------
//
// One page cursor. Offset mode keeps `nextOffset`; keyset mode (`afterId`) echoes the
// cursor and answers with `nextAfterId`, because a numeric-id cursor survives another
// agent removing a record mid-walk while an index cannot.

const readOffset = (label: string, value: unknown): number => {
    if (value === undefined) return 0;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "offset" must be a non-negative integer when provided.`
        );
    }

    return value as number;
};

const readLimit = (label: string, value: unknown): number => {
    if (value === undefined) return RECORD_LIST_DEFAULT_LIMIT;

    if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (value as number) > RECORD_LIST_MAX_LIMIT
    ) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "limit" must be an integer between 1 and ${RECORD_LIST_MAX_LIMIT} when provided.`
        );
    }

    return value as number;
};

// The keyset cursor is a DECIMAL ID, not an index: ids are monotonic and never reused
// inside an instance, so "everything after id 7" is stable under concurrent removals
// while "everything after position 7" is not. Same shape rule as the persisted ids
// (`readSnapshotId`), so a cursor copied out of a page always parses.
const readAfterId = (label: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;

    if (typeof value !== 'string' || !/^[0-9]+$/.test(value.trim())) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "afterId" must be a decimal record id string when provided.`
        );
    }

    const id = value.trim();

    if (!Number.isSafeInteger(Number(id))) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "afterId" is larger than a safe integer.`
        );
    }

    return id;
};

// The change-feed watermark. `since > storeRev` is checked by the caller, because
// only the closure knows the collection's current revision.
const readSince = (label: string, value: unknown): number | undefined => {
    if (value === undefined) return undefined;

    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "since" must be a non-negative integer when provided.`
        );
    }

    return value as number;
};

const readMergeDisjoint = (label: string, value: unknown): boolean => {
    if (value === undefined) return false;

    if (typeof value !== 'boolean') {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "mergeDisjoint" must be a boolean when provided.`
        );
    }

    return value;
};

// R6/T6.1 — the introspection flag. Same shape rule as `drop`: a boolean, and only
// `true` means anything. A non-boolean is a caller error, not something to coerce.
const readDescribe = (label: string, value: unknown): boolean => {
    if (value === undefined) return false;

    if (typeof value !== 'boolean') {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "describe" must be a boolean when provided.`
        );
    }

    return value;
};

// R7/T7.1 — the equality filter, validated against the collection's DECLARED fields.
// A `define`d collection's field set is invisible to the JSON Schema, so an unknown key
// here would otherwise read as "nothing matches": Decision C's stance for parameter
// values is that a typo must be a refusal naming the typo, never an empty page.
//
// The value must match the field's declared type — and, unlike a WRITE, an enum value
// only has to be one the field declares (there is nothing to store) while a text value
// is trimmed to meet the stored form. A `strings` field is refused outright: an entry
// cannot name an array term in a `Record<string, string | number | boolean>`.
const readWhere = (
    label: string,
    definition: RecordCollectionDefinition,
    value: unknown
): Record<string, unknown> | undefined => {
    if (value === undefined) return undefined;

    if (!isRecord(value)) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "where" must be an object of { field: value } equality terms when provided.`
        );
    }

    const declared = definition.fields.map((field) => field.key);
    const where: Record<string, unknown> = {};

    for (const key of Object.keys(value)) {
        const field = definition.fields.find((candidate) => candidate.key === key);

        if (field === undefined) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "where" has no field "${key}"; filterable fields: ${declared.join(', ')}.`
            );
        }

        const term = value[key];
        const sent = JSON.stringify(term);

        if (field.type === 'strings') {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "where" cannot filter the strings field "${key}"; an equality term is a text, integer, enum or boolean value.`
            );
        }

        if (field.type === 'boolean' && typeof term !== 'boolean') {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "where.${key}" must be a boolean to filter a boolean field; got ${sent}.`
            );
        }

        if (field.type === 'integer' && !Number.isSafeInteger(term)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "where.${key}" must be an integer to filter an integer field; got ${sent}.`
            );
        }

        if (field.type === 'text' && typeof term !== 'string') {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "where.${key}" must be a string to filter a text field; got ${sent}.`
            );
        }

        if (field.type === 'enum') {
            const allowed = field.values ?? [];

            if (typeof term !== 'string' || !allowed.includes(term)) {
                throw recordError(
                    RECORD_ERROR_CODES.invalidInput,
                    `${label} "where.${key}" must be one of: ${allowed.join(', ')}; got ${sent}.`
                );
            }
        }

        // A stored text is trimmed on the way IN, so the term is trimmed to meet it —
        // otherwise `where: { text: "done " }` would find nothing for a record stored as
        // "done".
        where[key] = field.type === 'text' ? (term as string).trim() : term;
    }

    return where;
};

// One record against the validated filter map: exact equality on every key (AND). The
// values are already in stored form (trimmed text), so a plain `===` is the whole rule;
// a record that has no value for a filtered field never matches it, which is the
// honest answer for an optional field the writer left out.
const matchesWhere = (entry: RecordEntry, where: Record<string, unknown>): boolean => {
    for (const key of Object.keys(where)) {
        if (entry[key] !== where[key]) return false;
    }

    return true;
};

// One trimmed, non-empty id. A missing, non-string, or blank id is reported BEFORE
// the lookup, so "not found" can never be confused with "you sent nothing".
const readId = (label: string, value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} ${field} must be a non-empty record id string.`
        );
    }

    return value.trim();
};

// Reads one id-only list (`remove`, `ids`) with the same shape rules per element.
const readIdList = (
    label: string,
    value: unknown,
    field: string,
    max: number = RECORD_MAX_BATCH
): string[] => {
    if (value === undefined) return [];

    if (!Array.isArray(value)) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "${field}" must be an array of record id strings when provided.`
        );
    }

    const entries = value as unknown[];

    if (entries.length > max) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "${field}" has ${entries.length} ids; the most one call may name is ${max}.`
        );
    }

    return entries.map((entry, index) =>
        readId(label, entry, `"${field}[${index}]"`)
    );
};

// One validated CAS precondition list. The pair (id, rev) is the caller's PROOF of
// what it read; an id may be named at most once, and `rev` must be the revision
// shape the reader saw (>= 1, matching `RecordEntry.rev`).
const readExpects = (label: string, value: unknown): Map<string, number> => {
    if (value === undefined) return new Map();

    if (!Array.isArray(value)) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "expects" must be an array of { id, rev } objects when provided.`
        );
    }

    const expects = new Map<string, number>();

    for (const [index, entry] of (value as unknown[]).entries()) {
        const field = `"expects[${index}]"`;

        if (!isRecord(entry)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} ${field} must be an object with an "id" and a "rev".`
            );
        }

        const id = readId(label, entry.id, `"expects[${index}].id"`);

        if (!Number.isSafeInteger(entry.rev) || (entry.rev as number) < 1) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "expects[${index}].rev" must be a positive integer (the revision you read).`
            );
        }

        if (expects.has(id)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "expects" lists id "${id}" more than once.`
            );
        }

        expects.set(id, entry.rev as number);
    }

    return expects;
};

// ---------------------------------------------------------------------------
// Field validation — the one place a value becomes a stored value
// ---------------------------------------------------------------------------
//
// A declared field is validated and NORMALIZED the same way for `records`, for every
// wrapper, and for a snapshot restore, which is what makes the three record stores
// behave identically (R3) without three copies of the checks.
//
// The rules, all carried over from the stores this replaces:
//   - text is trimmed; a `required` text may never be blank (a stored task with no
//     text is meaningless), and an oversized write is REJECTED naming the actual
//     length rather than sliced — silently storing something shorter than the caller
//     wrote is the worse failure;
//   - a non-required text accepts '' , which is how `notes`/`content` get CLEARED;
//   - `strings` entries are trimmed and de-duplicated. The RAW array length is
//     checked against `maxItems` BEFORE de-duplication, so a flood of duplicates is
//     rejected too; a blank entry is an error rather than a silent drop, because the
//     stored record would then differ from what the model sent;
//   - `enum` values are checked against the closed set, so a typo cannot create a
//     value the counts do not know about;
//   - `integer` values must be safe integers within `max`.
const normalizeFieldValue = (
    label: string,
    field: RecordFieldDefinition,
    value: unknown,
    index?: number
): unknown => {
    const at = index === undefined ? '' : `entry ${index + 1} `;

    if (field.type === 'boolean') {
        if (typeof value !== 'boolean') {
            throw recordError(
                RECORD_ERROR_CODES.invalidField,
                `${label} "${field.key}" must be a boolean when provided.`
            );
        }

        return value;
    }

    if (field.type === 'integer') {
        if (!Number.isSafeInteger(value)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidField,
                `${label} "${field.key}" must be an integer when provided.`
            );
        }

        const max = field.max;

        if (max !== undefined && Math.abs(value as number) > max) {
            throw recordError(
                RECORD_ERROR_CODES.fieldTooLong,
                `${label} "${field.key}" is ${value}; the limit is ${max}.`
            );
        }

        return value as number;
    }

    if (field.type === 'enum') {
        const values = field.values ?? [];

        if (typeof value !== 'string' || !values.includes(value)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidField,
                `${label} "${field.key}" must be one of: ${values.join(', ')}.`
            );
        }

        return value;
    }

    if (field.type === 'strings') {
        if (!Array.isArray(value)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidField,
                `${label} "${field.key}" must be an array of non-empty strings when provided.`
            );
        }

        const raw = value as unknown[];
        const maxItems = field.maxItems ?? RECORD_MAX_ITEMS;

        if (raw.length > maxItems) {
            throw recordError(
                RECORD_ERROR_CODES.fieldTooLong,
                `${label} "${field.key}" has ${raw.length} entries; the limit is ${maxItems}.`
            );
        }

        const items: string[] = [];

        for (const [itemIndex, item] of raw.entries()) {
            if (typeof item !== 'string' || item.trim().length === 0) {
                throw recordError(
                    RECORD_ERROR_CODES.invalidField,
                    `${label} "${field.key}" ${at}must be an array of non-empty strings when provided.`
                );
            }

            const text = item.trim();
            const cap = fieldCapOf(field);

            if (cap !== undefined && text.length > cap) {
                throw recordError(
                    RECORD_ERROR_CODES.fieldTooLong,
                    `${label} "${field.key}" entry ${itemIndex + 1} is ${text.length} characters; the limit is ${cap}.`
                );
            }

            if (!items.includes(text)) items.push(text);
        }

        return items;
    }

    // The `text` branch: the only remaining declared type.
    if (typeof value !== 'string') {
        throw recordError(
            RECORD_ERROR_CODES.invalidField,
            `${label} "${field.key}" must be a string when provided.`
        );
    }

    const text = value.trim();

    if (text.length === 0) {
        // A required text may not be blank; an optional one may, because '' is how a
        // caller clears `notes` or a chapter body.
        if (field.required === true) {
            throw recordError(
                RECORD_ERROR_CODES.invalidField,
                `${label} "${field.key}" requires a non-empty string.`
            );
        }

        return '';
    }

    const cap = fieldCapOf(field);

    if (cap !== undefined && text.length > cap) {
        throw recordError(
            RECORD_ERROR_CODES.fieldTooLong,
            `${label} "${field.key}" is ${text.length} characters; the limit is ${cap}. Shorten it and retry.`
        );
    }

    return text;
};

// ---------------------------------------------------------------------------
// Collection definitions (code-declared + `define`)
// ---------------------------------------------------------------------------

// The four collections the package ships. Order is declaration order, which is also
// the order a fresh store lists them in.
export const BUILTIN_RECORD_COLLECTIONS: readonly RecordCollectionDefinition[] = [
    TASKS_COLLECTION,
    CHAPTERS_COLLECTION,
    PROFILES_COLLECTION,
    LOCATIONS_COLLECTION
];

// The names that are permanent: a built-in collection is part of the product, so it
// cannot be dropped even when empty (Decision M).
const BUILTIN_COLLECTION_NAMES: readonly string[] = BUILTIN_RECORD_COLLECTIONS.map(
    (definition) => definition.name
);

// Every wrapper tool name, so the runtime can refuse a name that is not a record
// tool at all (rather than silently falling through to `records`).
const BUILTIN_WRAPPER_TOOLS: readonly string[] = BUILTIN_RECORD_COLLECTIONS.map(
    (definition) => definition.wrapper?.tool ?? definition.name
);

// Validates and normalizes ONE field spec. Reachable from three sides — a code
// declaration, a `define` call, and a snapshot restore — so the checks live here once
// rather than three times.
const readFieldDefinition = (
    label: string,
    value: unknown,
    seen: Set<string>
): RecordFieldDefinition => {
    const raw = readSnapshotRecord(value, label);
    const keys = Object.keys(raw);

    if (keys.length === 0 || raw.key === undefined || raw.type === undefined) {
        throw recordError(
            RECORD_ERROR_CODES.definitionInvalid,
            `${label} must declare at least "key" and "type".`
        );
    }

    // Only the documented keys are accepted: a typo in a persisted or `define`d spec
    // would otherwise silently drop a cap the author believes is in force.
    const allowed = new Set([
        'key',
        'type',
        'required',
        'maxLength',
        'maxItems',
        'values',
        'max',
        'default',
        'getOnly',
        'sortable',
        'count'
    ]);

    for (const key of keys) {
        if (!allowed.has(key)) {
            throw recordError(
                RECORD_ERROR_CODES.definitionInvalid,
                `${label} has unknown field "${key}"; allowed: ${[...allowed].join(', ')}.`
            );
        }
    }

    const key = readSnapshotString(raw.key, `${label}.key`, {
        min: 1,
        max: RECORD_MAX_COLLECTION_NAME
    });

    if (seen.has(key)) {
        throw recordError(
            RECORD_ERROR_CODES.definitionInvalid,
            `${label}.key "${key}" is declared more than once.`
        );
    }

    if (RESERVED_ENTRY_KEYS.includes(key)) {
        throw recordError(
            RECORD_ERROR_CODES.definitionInvalid,
            `${label}.key "${key}" is reserved by the entry shape: ${RESERVED_ENTRY_KEYS.join(', ')}.`
        );
    }

    seen.add(key);

    const type = raw.type;

    if (
        type !== 'text' &&
        type !== 'boolean' &&
        type !== 'integer' &&
        type !== 'enum' &&
        type !== 'strings'
    ) {
        throw recordError(
            RECORD_ERROR_CODES.definitionInvalid,
            `${label}.type must be one of: text, boolean, integer, enum, strings.`
        );
    }

    const field: RecordFieldDefinition = {
        key,
        type: type as RecordFieldDefinition['type']
    };

    if (raw.required === true) field.required = true;

    if (raw.maxLength !== undefined) {
        field.maxLength = readSnapshotInteger(raw.maxLength, `${label}.maxLength`, {
            min: 1,
            max: RECORD_MAX_TEXT
        });
    }

    if (raw.maxItems !== undefined) {
        field.maxItems = readSnapshotInteger(raw.maxItems, `${label}.maxItems`, {
            min: 1,
            max: RECORD_MAX_ITEMS
        });
    }

    if (raw.max !== undefined) {
        field.max = readSnapshotInteger(raw.max, `${label}.max`, { min: 1 });
    }

    if (raw.getOnly === true) {
        // Only text bodies are worth hiding from a page; a boolean facet or a sort key
        // that only `get` reports would make the counts unexplainable.
        if (type !== 'text' && type !== 'strings') {
            throw recordError(
                RECORD_ERROR_CODES.definitionInvalid,
                `${label}.getOnly is only valid on a text or strings field.`
            );
        }

        field.getOnly = true;
    }

    if (raw.sortable === true) {
        if (type !== 'integer') {
            throw recordError(
                RECORD_ERROR_CODES.definitionInvalid,
                `${label}.sortable is only valid on an integer field.`
            );
        }

        field.sortable = true;
    }

    if (type === 'enum') {
        const values = readSnapshotArray(raw.values, `${label}.values`);

        if (values.length === 0) {
            throw recordError(
                RECORD_ERROR_CODES.definitionInvalid,
                `${label}.values must list at least one allowed value.`
            );
        }

        field.values = values.map((value, index) =>
            readSnapshotString(value, `${label}.values[${index}]`, {
                min: 1,
                max: RECORD_MAX_COLLECTION_NAME
            })
        );

        if (new Set(field.values).size !== field.values.length) {
            throw recordError(
                RECORD_ERROR_CODES.definitionInvalid,
                `${label}.values lists the same value twice.`
            );
        }
    }

    if (raw.default !== undefined) {
        // The default must be a value the field itself would accept, so a definition
        // cannot smuggle a state the caps forbid. An empty string is a legal default
        // for an optional text (that is how `notes` starts empty).
        field.default = normalizeFieldValue(label, field, raw.default);
    }

    if (raw.count !== undefined) {
        if (raw.count === true) {
            if (type !== 'enum') {
                throw recordError(
                    RECORD_ERROR_CODES.definitionInvalid,
                    `${label}.count: true is only valid on an enum field.`
                );
            }

            field.count = true;
        } else {
            const count = readSnapshotRecord(raw.count, `${label}.count`);

            if (type !== 'boolean') {
                throw recordError(
                    RECORD_ERROR_CODES.definitionInvalid,
                    `${label}.count { key, complement } is only valid on a boolean field.`
                );
            }

            const facetKey = readSnapshotString(count.key, `${label}.count.key`, {
                min: 1,
                max: RECORD_MAX_COLLECTION_NAME
            });

            field.count =
                count.complement === undefined
                    ? { key: facetKey }
                    : {
                          key: facetKey,
                          complement: readSnapshotString(count.complement, `${label}.count.complement`, {
                              min: 1,
                              max: RECORD_MAX_COLLECTION_NAME
                          })
                      };
        }
    }

    return field;
};

// Validates a whole collection definition. `existing` is the set of registered
// collection names, consulted by `define` (a duplicate is an error, never a merge)
// and by a restore (where the built-ins are already known).
const readCollectionDefinition = (
    label: string,
    value: unknown,
    existing?: ReadonlySet<string>
): RecordCollectionDefinition => {
    const raw = readSnapshotRecord(value, label);
    // The bounds and the wrapper are harness-supplied and may be omitted by an agent
    // 'define'; the reader below substitutes the engine defaults. readSnapshotKeys's
    // 4th argument is the MAY-BE-ABSENT list — without it an optional persisted key
    // reads as data loss.
    readSnapshotKeys(
        raw,
        ['name', 'fields', 'maxRecords', 'responseBudgetBytes', 'wrapper'],
        label,
        ['maxRecords', 'responseBudgetBytes', 'wrapper']
    );

    const name = readSnapshotString(raw.name, `${label}.name`, {
        min: 1,
        max: RECORD_MAX_COLLECTION_NAME
    });

    const entries = readSnapshotArray(raw.fields, `${label}.fields`);

    if (entries.length === 0) {
        throw recordError(
            RECORD_ERROR_CODES.definitionInvalid,
            `${label}.fields must declare at least one field.`
        );
    }

    if (entries.length > RECORD_MAX_FIELDS) {
        throw recordError(
            RECORD_ERROR_CODES.definitionInvalid,
            `${label}.fields declares ${entries.length} fields; the most is ${RECORD_MAX_FIELDS}.`
        );
    }

    const seen = new Set<string>();
    const fields = entries.map((entry, index) =>
        readFieldDefinition(`${label}.fields[${index}]`, entry, seen)
    );

    if (existing !== undefined && existing.has(name)) {
        throw recordError(
            RECORD_ERROR_CODES.collectionExists,
            `A collection named "${name}" is already defined; a re-define is refused rather than merged, because it would silently change a live contract.`
        );
    }

    const definition: RecordCollectionDefinition = {
        name,
        fields,
        maxRecords:
            raw.maxRecords === undefined
                ? RECORD_MAX_RECORDS
                : readSnapshotInteger(raw.maxRecords, `${label}.maxRecords`, {
                      min: RECORD_MIN_RECORDS,
                      max: RECORD_MAX_RECORDS
                  }),
        responseBudgetBytes:
            raw.responseBudgetBytes === undefined
                ? RECORD_RESPONSE_BUDGET_BYTES
                : readSnapshotInteger(raw.responseBudgetBytes, `${label}.responseBudgetBytes`, {
                      min: 1024,
                      max: RECORD_RESPONSE_BUDGET_BYTES
                  })
    };

    // The wrapper half is DECLARATIVE so the engine can serve a wrapper without
    // knowing its name, but it is harness-supplied — a `define`d collection has no
    // wrapper, and `readSnapshotKeys` would otherwise refuse the key on restore.
    if (raw.wrapper !== undefined) {
        const wrapper = readSnapshotRecord(raw.wrapper, `${label}.wrapper`);

        definition.wrapper = {
            tool: readSnapshotString(wrapper.tool, `${label}.wrapper.tool`, { min: 1 }),
            plural: readSnapshotString(wrapper.plural, `${label}.wrapper.plural`, { min: 1 }),
            singular: readSnapshotString(wrapper.singular, `${label}.wrapper.singular`, { min: 1 }),
            style: wrapper.style === 'batch' ? 'batch' : 'action'
        };
    }

    return definition;
};

// ---------------------------------------------------------------------------
// The stale-write payload (R9)
// ---------------------------------------------------------------------------
//
// Which fields the log says changed on `id` after revision `expected`. Deliberately
// LENIENT: whatever the log shows is named, and NOTHING is named when the log cannot
// show an update — a claimed coverage the window cannot back up would be a lie.
const changedFieldsSince = (
    definition: RecordCollectionDefinition,
    changes: readonly RecordChange[],
    id: string,
    expected: number
): string[] | undefined => {
    const seen = new Set<string>();

    for (const change of changes) {
        if (change.id !== id || change.op !== 'update') continue;
        if (change.itemRev === undefined || change.itemRev <= expected) continue;

        for (const field of change.fields ?? []) seen.add(field);
    }

    if (seen.size === 0) return undefined;

    // Canonical declaration order, never insertion order.
    return definition.fields.map((field) => field.key).filter((key) => seen.has(key));
};

// The current entry, rendered for a rejection. Budgeted like a page (F13's inner ≤
// outer rule applies to a refusal too — a chapter's 4000-character body must not turn
// a conflict into a second flood), degrading to the projection a list uses and SAYING
// so (T7's requirement) instead of truncating mid-JSON.
const stalePayloadOf = (
    definition: RecordCollectionDefinition,
    entry: RecordEntry
): { json: string; projected: boolean; note?: string } => {
    const full = copyEntry(definition, entry, true);
    const fullJson = JSON.stringify(full);

    if (Buffer.byteLength(fullJson, 'utf8') <= RECORD_STALE_PAYLOAD_BUDGET_BYTES) {
        return { json: fullJson, projected: false };
    }

    const projected = copyEntry(definition, entry, false);
    const names = definition.fields
        .filter((field) => field.getOnly === true)
        .map((field) => `"${field.key}"`)
        .join(', ');

    return {
        json: JSON.stringify(projected),
        projected: true,
        // The note is composed into the MESSAGE, never into the payload, so the JSON a
        // caller parses stays exactly the entry shape.
        ...(names.length === 0 ? {} : { note: names })
    };
};

// R4 — what the caller could ACTUALLY do about the conflict. `staleRecordError` used to
// append `or pass "mergeDisjoint": true` unconditionally, which twice sent a live agent
// after a knob that cannot help: a REMOVAL is never merged (the tool schemas say so),
// and a patch that already sent the flag has already used it. The one call site below
// knows both facts, so it passes them here; the sentence is then composed from them.
type StaleAdvice = {
    // The field patch this call sends for the record, or ABSENT when the call removes
    // it (a removal has no patch, and `mergeDisjoint` never merges one).
    patch?: FieldPatch;
    // True when the call already passed `mergeDisjoint: true`.
    mergeDisjoint: boolean;
};

// The one message every rejected CAS write shows. Sentence shape preserved from the
// old task store (current rev, last editor, the fields the log can attribute) with
// two additions: `updatedAt` beside the editor, and the CURRENT RECORD appended as
// compact JSON — R9's "return the current result in invalid patches to save them
// from looking up". The structured twin goes in `error.details`, so a wrapper
// switches on the code and reads the payload without parsing prose (Decision O).
const staleRecordError = (
    label: string,
    definition: RecordCollectionDefinition,
    entry: RecordEntry,
    expected: number,
    changes: readonly RecordChange[],
    advice: StaleAdvice
): HarnessError => {
    const fields = changedFieldsSince(definition, changes, entry.id, expected);
    const hint = fields === undefined || fields.length === 0 ? '' : `; changed fields: ${fields.join(', ')}`;
    const payload = stalePayloadOf(definition, entry);
    const projection =
        payload.projected === false
            ? ''
            : ` (projection: ${'note' in payload && payload.note !== undefined ? `${payload.note} omitted` : 'large fields omitted'})`;

    // The clashing fields, in canonical declaration order — the same intersection the
    // provable-merge refusal composes above (`cannot merge "<field>" because this patch
    // sets it too`), computed from what the log CAN attribute. `fields === undefined`
    // means the window shows no update for this record at all, so nothing clashes and
    // nothing more is claimed.
    //
    // The patch is copied into a const first: a property access is not narrowed inside a
    // closure (the same trap `project` documents for `since`), and the filter below reads
    // it from inside one.
    const patched = advice.patch;
    const clash =
        patched === undefined || fields === undefined
            ? []
            : definition.fields
                  .map((field) => field.key)
                  .filter((key) => patched[key] !== undefined && fields.includes(key));

    const token = `retry with "expects" [{ id: "${entry.id}", rev: ${entry.rev} }]`;
    const adviceText =
        // A removal: the flag is not an option this caller has, so it is not mentioned.
        advice.patch === undefined
            ? `${token}.`
            : advice.mergeDisjoint
                ? // The flag is already set, so re-recommending it is noise. When the
                  // window still names a field this patch also sets, say which one;
                  // when it cannot (its coverage of this record has aged out), the
                  // honest sentence is that the flag is spent — no invented advice.
                    clash.length === 0
                        ? `${token}; "mergeDisjoint" is already set, and the change window no longer covers every revision since ${expected}, so it cannot prove this patch disjoint.`
                        : `${token}; "mergeDisjoint" is already set and cannot merge ${clash
                              .map((field) => `"${field}"`)
                              .join(' and ')} because this patch sets it too.`
                : `${token} or pass "mergeDisjoint": true.`;

    return recordError(
        RECORD_ERROR_CODES.staleRecord,
        `${label} "${entry.id}" changed since revision ${expected} ` +
            `(now ${entry.rev}, last edited by "${entry.updatedBy ?? 'unknown'}"` +
            `${entry.updatedAt === undefined ? '' : ` at ${entry.updatedAt}`})${hint}; ` +
            `${adviceText} ` +
            `current: ${payload.json}${projection}`,
        {
            id: entry.id,
            expectedRev: expected,
            currentRev: entry.rev,
            updatedBy: entry.updatedBy ?? 'unknown',
            ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
            ...(fields === undefined ? {} : { changedFields: fields }),
            // R4: the machine-readable twin of the clash sentence, mirroring the
            // provable-merge refusal's `details.clash`. Only for a patch that opted in.
            ...(advice.mergeDisjoint && clash.length > 0 ? { clash } : {}),
            projected: payload.projected,
            entry: copyEntry(definition, entry, payload.projected === false)
        }
    );
};

// Proves a stale content patch is still SAFE to apply (opt-in `mergeDisjoint`).
// Returns the union of the fields every concurrent content change touched, or
// `undefined` when the merge must be refused because coverage is unknown:
//   - the window must contain one update per revision from expected+1 UP TO the
//     record's current rev, with no gap and no duplicate (a FIFO-trimmed window that
//     dropped one of them fails exactly this test — Decision B's per-collection window
//     is what keeps that from happening on unrelated writes);
//   - any logged `remove` of the id means the record was deleted and re-created (a
//     restore can bring an id back), so the live record is not the one the caller read;
//   - an `add` entry never breaks coverage: it is the creation the caller already saw.
//     (The old log had two more op kinds that did not move `rev`; Decision P deleted
//     them along with the lock.)
const mergeConcurrentFields = (
    changes: readonly RecordChange[],
    id: string,
    expected: number,
    current: number
): Set<string> | undefined => {
    const union = new Set<string>();
    let covered = 0;

    for (const change of changes) {
        if (change.id !== id) continue;
        if (change.op === 'remove') return undefined;
        if (change.op !== 'update') continue;
        if (change.itemRev === undefined || change.itemRev <= expected) continue;

        // The window is append-only and ascending, so the covered revisions must walk
        // expected+1, expected+2, ... with no hole.
        if (change.itemRev !== expected + covered + 1) return undefined;

        covered += 1;
        for (const field of change.fields ?? []) union.add(field);
    }

    // Anything short of the current revision means the tail is outside the window.
    if (covered !== current - expected) return undefined;

    return union;
};

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

// One collection's live state. `items` is insertion order EXCEPT where a sortable
// field reorders the view; the live array is never sorted, so an unordered record's
// position stays stable (the historical chapter rule).
type CollectionState = RecordCollectionState;

// The caller identity, resolved from the ToolContext by the harness (or, in worker
// mode, by the authority from the name the lane reported — `callerFor`). `by` is what
// makes a write guarded, attributed, or logged at all.
type CallerIdentity = {
    by?: string;
    threadId?: string;
};

// The validated, ordered plan one invocation produces. Nothing has touched the store
// yet: applying this plan is the only mutating step. Apply order is patches →
// removals → additions.
type FieldPatch = Record<string, unknown>;

type ResolvedEntry = {
    index: number;
    id?: string;
    patch: FieldPatch;
};

type Plan = {
    // Entries naming an existing id, in caller order, values normalized and bounded.
    patches: ResolvedEntry[];
    // New records to append, in caller order.
    additions: FieldPatch[];
    // Ids to delete, in caller order.
    removals: string[];
    // Ids to read back one-by-one (`get`); conflicts with the three above.
    lookups: string[];
    // CAS preconditions by id (empty when the caller sent none).
    expects: Map<string, number>;
    // True when at least one record is created or changed.
    mutates: boolean;
};

// The store reads the planner needs. Reads only: the planner never mutates, so a
// rejection anywhere in it leaves the collection exactly as it was.
type StoreView = {
    find: (id: string) => RecordEntry | undefined;
    length: () => number;
    changes: () => readonly RecordChange[];
    // R5/T5.1 — which OTHER collection holds this id, if any. The id counter is global
    // (F3, Decision F3), so an id lives in at most one collection and the answer is
    // unambiguous. The view itself stays per-collection — `find` must keep meaning
    // "in THIS collection", which is exactly what the first draft of this finding got
    // wrong — and this is the one cross-collection question the pre-check may ask to
    // phrase its answer truthfully. Optional so a caller that cannot see the rest of
    // the store degrades to the "absent everywhere" wording rather than lying.
    ownerOf?: (id: string) => string | undefined;
    by?: string;
    threadId?: string;
};

// R5/T5.2/T5.3 — the newest `remove` event the window still holds for an id. The
// phrase "was removed" is only allowed when this returns a revision: the log is the
// engine's own evidence, and an absent entry means either "this collection never had
// the id" or "the removal aged out of the FIFO window" — neither of which may be
// reported as a removal the caller missed.
const removalRevOf = (changes: readonly RecordChange[], id: string): number | undefined => {
    let rev: number | undefined;

    for (const change of changes) {
        if (change.id === id && change.op === 'remove') rev = change.rev;
    }

    return rev;
};

// Registers one id against the list that named it and rejects a duplicate or a
// cross-list conflict. One id may be touched by exactly ONE operation per call,
// otherwise the last writer would silently win and the model would have no way to
// tell which of its own instructions ran.
const touchId = (
    label: string,
    batchKey: string,
    touched: Map<string, string>,
    id: string,
    list: string
): void => {
    const prior = touched.get(id);

    if (prior === undefined) {
        touched.set(id, list);
        return;
    }

    if (prior === list) {
        throw recordError(
            RECORD_ERROR_CODES.batchConflict,
            list === batchKey
                ? `${label} "${batchKey}" changes id "${id}" more than once; send one entry per id.`
                : `${label} "${list}" lists id "${id}" more than once.`
        );
    }

    throw recordError(
        RECORD_ERROR_CODES.batchConflict,
        `${label} id "${id}" appears in both "${prior}" and "${list}"; one operation per id per call.`
    );
};

// Validates ONE entry object against the collection's field spec. An entry with no
// `id` is an addition; with an `id` it is a partial patch, and every field it omits
// keeps its stored value. Unknown keys are refused here rather than ignored, because
// a silently-dropped key in a generic record is invisible data loss: the schema cannot
// catch it for a `define`d collection whose fields the schema does not know.
const readEntryInput = (
    definition: RecordCollectionDefinition,
    label: string,
    batchKey: string,
    value: unknown,
    index: number
): ResolvedEntry => {
    const field = `"${batchKey}[${index}]"`;

    if (!isRecord(value)) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} ${field} must be an object with an optional "id" plus the collection's fields.`
        );
    }

    const rawId = value.id;

    // An explicit `id: null` is a type error, not "no id": only an ABSENT id means
    // "create a new record", so a caller cannot accidentally duplicate a row.
    if (rawId !== undefined && typeof rawId !== 'string') {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "${batchKey}[${index}].id" must be a string when provided.`
        );
    }

    const id =
        rawId === undefined ? undefined : readId(label, rawId, `"${batchKey}[${index}].id"`);

    const byKey = new Map(definition.fields.map((field) => [field.key, field] as const));
    const patch: FieldPatch = {};

    for (const key of Object.keys(value)) {
        if (key === 'id') continue;

        const spec = byKey.get(key);

        if (spec === undefined) {
            throw recordError(
                RECORD_ERROR_CODES.unknownField,
                `${label} ${field} has no field "${key}"; ${definition.name} declares ${
                    definition.fields.length === 0
                        ? 'no fields'
                        : definition.fields.map((known) => `"${known.key}"`).join(', ')
                }.`
            );
        }

        patch[key] = normalizeFieldValue(label, spec, value[key]);
    }

    if (id === undefined) {
        // A new record must say everything the collection requires: a field with a
        // default is covered by the default, and every other required field must be
        // present. `records` is the escalation surface, so this is the field spec's
        // rule, not a wrapper's cap (R6).
        for (const spec of definition.fields) {
            if (spec.required === true && patch[spec.key] === undefined) {
                throw recordError(
                    RECORD_ERROR_CODES.invalidField,
                    `${label} ${field} needs "${spec.key}" to add a ${recordLabel(definition)}, or an existing "id" to change one.`
                );
            }
        }
    } else if (Object.keys(patch).length === 0) {
        // An id with no field is ambiguous: a read belongs in `ids`.
        throw recordError(
            RECORD_ERROR_CODES.invalidField,
            `${label} ${field} names id "${id}" but sets no field; read it with "ids" instead.`
        );
    }

    return { index, ...(id === undefined ? {} : { id }), patch };
};

// Validates the WHOLE call into a plan before anything is mutated. Every rejection
// lives here: types, unknown ids, duplicates, the conflicting `entries`/`remove`/`ids`
// overlap, the guarded-write and CAS rules, and the record cap.
//
// PASS ORDER IS PART OF THE CONTRACT (carried over from the task store's readPatch):
//   1. shape    — every argument is type-checked with NO store read, so a malformed
//                call reports its malformed field instead of an id;
//   2. register — each id is claimed for exactly one list, so the duplicate and
//                cross-list conflicts are structural;
//   3. removed  — a token whose record is gone answers `was removed since revision
//                <n>` BEFORE the plain lookup, because that is the race the caller
//                actually hit;
//   4. lookup   — an id this call touches that the collection does not have;
//   5. guards   — the coverage rule, the guarded-write rule, and the CAS comparison
//                (with the only rescue, `mergeDisjoint`).
// Steps 1-5 only READ, so a rejection anywhere leaves items, the id counter, every
// storeRev and every change log exactly as they were.
// `batchKey` is the key the CALLER used for its entry list: the wrapper's plural
// (`tasks`) for a batch wrapper, `entries` for `records` and for the action wrappers
// (whose flat fields the engine assembled into entries). A rejection must quote what
// the caller sent, not the engine's internal spelling.
const readPlan = (
    definition: RecordCollectionDefinition,
    raw: Record<string, unknown>,
    store: StoreView,
    batchKey: string = 'entries'
): Plan => {
    const label = callLabelOf(definition);
    const rawEntries = raw.entries;
    const rawRemove = raw.remove;
    const rawIds = raw.ids;

    if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "${batchKey}" must be an array of record objects when provided.`
        );
    }

    if (raw.remove !== undefined && !Array.isArray(rawRemove)) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "remove" must be an array of record id strings when provided.`
        );
    }

    if (rawIds !== undefined && !Array.isArray(rawIds)) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "ids" must be an array of record id strings when provided.`
        );
    }

    const mergeDisjoint = readMergeDisjoint(label, raw.mergeDisjoint);

    // STEP 1 — the CAS tokens are part of the argument shape. Their id/rev checks run
    // here, before any store read, so a malformed token is reported as the typo it is
    // rather than as a lookup result.
    const expects = readExpects(label, raw.expects);

    const entries = (rawEntries === undefined ? [] : (rawEntries as unknown[])).map((entry, index) =>
        readEntryInput(definition, label, batchKey, entry, index)
    );

    if (entries.length > RECORD_MAX_BATCH) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} "${batchKey}" has ${entries.length} entries; the most one call may send is ${RECORD_MAX_BATCH}.`
        );
    }

    // STEP 2 — registration.
    const touched = new Map<string, string>();
    const lookups: string[] = [];
    const patches: ResolvedEntry[] = [];
    const additions: FieldPatch[] = [];

    for (const entry of entries) {
        if (entry.id === undefined) {
            additions.push(entry.patch);
            continue;
        }

        touchId(label, batchKey, touched, entry.id, batchKey);
        lookups.push(entry.id);
        patches.push(entry);
    }

    const removals = readIdList(label, rawRemove, 'remove');

    for (const id of removals) {
        touchId(label, batchKey, touched, id, 'remove');
        // A removal names a record the caller believes exists, so its id belongs in the
        // existence pass exactly like a patch's: STEP 4 then reports an unknown id as
        // `unknown-record` instead of the guard's "read it first" (which is the wrong
        // diagnosis for an id the collection never held), and an identity-less caller
        // gets the same loud answer as an identified one rather than a silent no-op.
        lookups.push(id);
    }

    // `ids` is the read half of a call. It may not overlap a write of the same id in
    // the same breath, because the page the caller then sees is ambiguous.
    const reads = readIdList(label, rawIds, 'ids');

    for (const id of reads) {
        if (touched.has(id)) {
            throw recordError(
                RECORD_ERROR_CODES.batchConflict,
                `${label} id "${id}" appears in both "ids" and "${touched.get(id)}"; read it or change it, not both.`
            );
        }

        lookups.push(id);
    }

    // STEP 3 — removed-since. Every token is compared against the live store BEFORE
    // any id is looked up for the caller's own sake.
    //
    // R5 — this used to answer the SAME sentence for every miss, and the sentence was
    // wrong twice over: it claimed "was removed" for an id this collection never held
    // (id "4" belonged to `profiles` all along, live at rev 4), and it claimed "the id
    // is free again", which is never true inside a session because the id counter only
    // moves forward. The three facts are now told apart: live elsewhere, removed from
    // here with the log as evidence, and simply not here.
    for (const [id, rev] of expects) {
        if (store.find(id) !== undefined) continue;

        const owner = store.ownerOf === undefined ? undefined : store.ownerOf(id);

        if (owner !== undefined) {
            // Live in another collection: the caller named the wrong door, and there is
            // nothing removed about it.
            throw recordError(
                RECORD_ERROR_CODES.staleRecord,
                `${label} id "${id}" belongs to "${owner}" — re-read that collection.`,
                {
                    id,
                    expectedRev: rev,
                    currentRev: 0,
                    updatedBy: 'unknown',
                    collection: owner
                }
            );
        }

        if (removalRevOf(store.changes(), id) !== undefined) {
            // The one case allowed to say "was removed". The "the id is free again"
            // clause is gone (T5.2): ids are never re-claimed, and the sentence invited
            // the caller to try.
            throw recordError(
                RECORD_ERROR_CODES.staleRecord,
                `${label} "${id}" was removed since revision ${rev} — re-read the list and add or retry.`,
                { id, expectedRev: rev, currentRev: 0, updatedBy: 'unknown', removed: true }
            );
        }

        // Absent here with nothing in the log: never in this collection, or a removal
        // the 200-event window has already dropped. Both are stated, neither claims a
        // removal, and `removed` stays out of the details (T5.3).
        throw recordError(
            RECORD_ERROR_CODES.staleRecord,
            `${label} has no ${recordLabel(definition)} with id "${id}" and this collection's change log holds no removal for it — ` +
                `it was never in "${definition.name}", or its removal aged out of the ${RECORD_MAX_CHANGES}-event window. Re-read the list.`,
            { id, expectedRev: rev, currentRev: 0, updatedBy: 'unknown' }
        );
    }

    // STEP 4 — existence, reported in the order the lists named it.
    for (const id of lookups) {
        if (store.find(id) === undefined) {
            throw recordError(
                RECORD_ERROR_CODES.unknownRecord,
                `${label} has no ${recordLabel(definition)} with id "${id}".`
            );
        }
    }

    // STEP 5 — coverage: a token for a record nobody touches guards nothing, so it is
    // rejected rather than ignored.
    for (const id of expects.keys()) {
        if (!touched.has(id)) {
            // m11 — the refusal was correct but unhelpful: the common cause is a stale or
            // mistyped id in `expects`, and the caller had the right ids somewhere else in
            // the same call. Naming the ids the call DOES change turns a guess into a diff.
            //
            // `touched.keys()` IS exactly that set, verified against STEP 2: it registers a
            // patch (`:1630`, under the batch key) and a removal (`:1638`, under 'remove'),
            // while an addition has no id to register (`:1625` returns early) and a READ is
            // only conflict-checked and pushed to `lookups` (`:1652-1661`) — never into
            // `touched`. So nothing that merely gets read can be named here as changed.
            const changed = [...touched.keys()];

            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "expects" names id "${id}", which this call does not change`
                    + (changed.length === 0
                        // An ADDITION has no id to register (`:1625` returns before
                        // `touchId`), so an empty `touched` here does NOT mean the call
                        // changes nothing — it may be adding records and minting their ids.
                        // Saying "changes no records" would contradict the call's own batch.
                        ? additions.length > 0
                            ? `; this call changes no existing record — it adds ${additions.length}.`
                            : '; this call changes no record.'
                        : `; this call changes ${changed.length === 1 ? 'id' : 'ids'} ${changed
                            .slice(0, 5)
                            .map((touchedId) => `"${touchedId}"`)
                            .join(', ')}`
                            + (changed.length > 5 ? ` (+${changed.length - 5} more)` : '.'))
            );
        }
    }

    // GUARDED WRITES. A call with an agent identity (model, manual, worker) may only
    // patch or remove a record it has read: the token is the proof. An identity-less
    // call — a direct `tool()` or driver call — may still write blind.
    if (store.by !== undefined) {
        for (const entry of patches) {
            if (!expects.has(entry.id as string)) {
                throw recordError(
                    RECORD_ERROR_CODES.guardedWrite,
                    `guarded write: pass "expects" [{ id, rev }] for ${recordLabel(definition)} "${entry.id as string}" (read it first).`,
                    { id: entry.id as string }
                );
            }
        }

        for (const id of removals) {
            if (!expects.has(id)) {
                throw recordError(
                    RECORD_ERROR_CODES.guardedWrite,
                    `guarded write: pass "expects" [{ id, rev }] for ${recordLabel(definition)} "${id}" (read it first).`,
                    { id }
                );
            }
        }
    }

    // COMPARE-AND-SWAP. A token that does not match the stored content revision means
    // somebody else got there first — the only conflict this engine has (Decision P).
    // Only `mergeDisjoint` can rescue it, and only for a content patch whose fields
    // provably do not collide.
    const patchById = new Map<string, ResolvedEntry>();

    for (const entry of patches) patchById.set(entry.id as string, entry);

    for (const [id, expected] of expects) {
        const entry = store.find(id) as RecordEntry;

        if (entry.rev === expected) continue;

        const patch = patchById.get(id);

        if (mergeDisjoint && patch !== undefined) {
            const concurrent = mergeConcurrentFields(store.changes(), id, expected, entry.rev);

            if (concurrent !== undefined) {
                const clash = definition.fields
                    .map((field) => field.key)
                    .filter((key) => patch.patch[key] !== undefined && concurrent.has(key));

                // Disjoint: the patch applies as-is, and the fields the caller left out
                // keep whatever the concurrent writer stored.
                if (clash.length === 0) continue;

                throw recordError(
                    RECORD_ERROR_CODES.staleRecord,
                    `${label} "${id}" changed since revision ${expected} (now ${entry.rev}, last edited by ` +
                        `"${entry.updatedBy ?? 'unknown'}"); "mergeDisjoint" cannot merge ${clash
                            .map((field) => `"${field}"`)
                            .join(' and ')} because this patch sets it too.`,
                    {
                        id,
                        expectedRev: expected,
                        currentRev: entry.rev,
                        updatedBy: entry.updatedBy ?? 'unknown',
                        clash,
                        entry: copyEntry(definition, entry, false)
                    }
                );
            }
        }

        // R4: the advice must match the operation the caller actually sent, and whether
        // it has already used its one escape hatch. Reachability, from the branch above:
        //   - a REMOVAL never has a patch, so the flag is unreachable for it by contract
        //     ("Never merges a removal") and must not be recommended;
        //   - a stale patch WITH the flag and provable coverage never reaches this line:
        //     it either applies (disjoint) or is refused by the merge-clash message above
        //     naming the field;
        //   - a stale patch WITH the flag reaching this line therefore means the window
        //     can no longer prove coverage, which is exactly the case the caller needs
        //     told — the flag is spent, not recommended.
        throw staleRecordError(label, definition, entry, expected, store.changes(), {
            ...(patch === undefined ? {} : { patch: patch.patch }),
            mergeDisjoint
        });
    }

    // CAPACITY, checked after field validation and before any id is consumed: an
    // over-cap batch is an actionable error, and a rejected call never burns an id
    // from the monotonic counter. Removals ARE netted off, because they apply before
    // the additions, so a caller may restate a full section in one call.
    const resulting = store.length() - removals.length + additions.length;

    if (resulting > definition.maxRecords) {
        throw recordError(
            RECORD_ERROR_CODES.storeFull,
            `${label} would hold ${resulting} ${definition.name}; the maximum is ${definition.maxRecords}. Remove one before adding another.`
        );
    }

    return {
        patches,
        additions,
        removals,
        lookups: reads,
        expects,
        mutates: patches.length > 0 || additions.length > 0 || removals.length > 0
    };
};

// The ordered view a page is built from: ascending by the collection's sortable field
// (records that have one first, then the rest in insertion order — a stable sort,
// which is why there is no move action), otherwise insertion order.
const orderedFor = (
    definition: RecordCollectionDefinition,
    items: readonly RecordEntry[]
): readonly RecordEntry[] => {
    const sortable = definition.fields.find((field) => field.sortable === true);

    if (sortable === undefined) return items;

    return [...items].sort((left, right) => {
        const a = left[sortable.key];
        const b = right[sortable.key];

        // Absent sorts last, and two absents keep their relative order.
        if (a === undefined && b === undefined) return 0;
        if (a === undefined) return 1;
        if (b === undefined) return -1;

        return (a as number) - (b as number);
    });
};

// Index of the first record whose numeric id is strictly greater than the cursor. The
// source is a numeric-sorted COPY: a normal store is already in that order, but a
// restored or hand-edited one may not be, and keyset paging is only correct over a
// stable order. (A sortable collection's id order and its display order differ, which
// is exactly why keyset mode re-sorts by id rather than reusing the page order.)
const firstIndexAfter = (ordered: readonly RecordEntry[], afterId: number): number => {
    let index = 0;

    while (index < ordered.length && Number(ordered[index].id) <= afterId) index += 1;

    return index;
};

// A record's stored value for one field, i.e. what an omitted write keeps.
const valueOfField = (
    entry: RecordEntry,
    definition: RecordCollectionDefinition,
    key: string
): unknown => {
    if (entry[key] !== undefined) return entry[key];

    const spec = definition.fields.find((field) => field.key === key);

    // A `strings` default is shared by reference in the definition, so hand out a copy
    // — a caller pushing into a stored array must not widen the spec.
    const fallback = spec?.default;

    return Array.isArray(fallback) ? [...fallback] : fallback;
};

// ---------------------------------------------------------------------------
// Snapshot validation (the readers snapshot.ts and the lane fold call)
// ---------------------------------------------------------------------------

// One persisted entry, checked field by field against the collection's spec. Key sets
// are exact: a persisted key the spec does not declare is data loss that gets REPORTED
// instead of dropped, and a missing declared field restores as its default only when
// the spec says so.
const readStoredEntry = (
    definition: RecordCollectionDefinition,
    value: unknown,
    label: string
): RecordEntry => {
    const record = readSnapshotRecord(value, label);
    // EVERY key this entry may carry, then the subset that may be ABSENT. The
    // validator's 4th argument is the "optional" list (./snapshot-validation.ts):
    // an unknown key is data loss, and a missing key is data loss UNLESS the field
    // is genuinely optional — `rev` defaults to 1, the attribution triple is absent
    // for a store an identified caller never wrote, and a field with a default (or no
    // `required` flag) restores from the spec.
    const allowed = [
        'id',
        'rev',
        'updatedBy',
        'updatedThreadId',
        'updatedAt',
        ...definition.fields.map((field) => field.key)
    ];
    const optional = [
        'rev',
        'updatedBy',
        'updatedThreadId',
        'updatedAt',
        ...definition.fields
            .filter((field) => field.default !== undefined || !field.required)
            .map((field) => field.key)
    ];

    readSnapshotKeys(record, allowed, label, optional);

    const entry: Record<string, unknown> = {
        id: readSnapshotId(record.id, `${label}.id`)
    };

    for (const field of definition.fields) {
        const key = field.key;
        const raw = record[key];

        if (raw === undefined) {
            if (field.default !== undefined) {
                entry[key] = Array.isArray(field.default) ? [...field.default] : field.default;
                continue;
            }

            if (field.required !== true) continue;

            throw recordError(
                RECORD_ERROR_CODES.definitionInvalid,
                `${label}.${key} is required by the "${definition.name}" collection and is missing.`
            );
        }

        // The snapshot PATH is the label, not the collection name: a corrupt file with
        // 200 entries has to tell the host WHICH record is wrong. Same wording as the
        // write path, deeper label.
        entry[key] = normalizeFieldValue(label, field, raw);
    }

    entry.rev =
        record.rev === undefined
            ? 1
            : readSnapshotInteger(record.rev, `${label}.rev`, { min: 1 });

    if (record.updatedBy !== undefined) {
        // Decision L: attribution is validated ONLY as a non-empty string, never
        // against the agent roster. A snapshot naming a departed agent restores and
        // reports it unchanged — "the memo was still written by Person A".
        entry.updatedBy = readSnapshotString(record.updatedBy, `${label}.updatedBy`, { min: 1 });
    }

    if (record.updatedThreadId !== undefined) {
        entry.updatedThreadId = readSnapshotString(record.updatedThreadId, `${label}.updatedThreadId`, {
            min: 1
        });
    }

    if (record.updatedAt !== undefined) {
        entry.updatedAt = readSnapshotString(record.updatedAt, `${label}.updatedAt`, { min: 1 });
    }

    // Canonical key order, so a restored store serializes to the same size the writer
    // measured (the page budget is computed on the real shape).
    const ordered: Record<string, unknown> = { id: entry.id };

    for (const field of definition.fields) {
        if (entry[field.key] !== undefined) ordered[field.key] = entry[field.key];
    }

    ordered.rev = entry.rev;

    for (const key of ['updatedBy', 'updatedThreadId', 'updatedAt']) {
        if (entry[key] !== undefined) ordered[key] = entry[key];
    }

    return ordered as RecordEntry;
};

// The change ops a persisted window may contain. `claim`/`release` are GONE — a
// snapshot carrying one names an event the engine can no longer produce, so it is
// refused rather than silently dropped (Decision P's deletion is a shape change).
const readStoredChangeOp = (value: unknown, label: string): RecordChange['op'] => {
    const op = readSnapshotString(value, label, { min: 1 });

    if (op !== 'add' && op !== 'update' && op !== 'remove') {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label} must be one of: add, update, remove.`
        );
    }

    return op;
};

// One persisted change entry, with the same exact-key discipline as an entry.
// `definition` is what makes `fields` checkable: the feed is the evidence behind
// `mergeDisjoint`, so a name the collection never declared would make a real conflict
// look provable — the pre-engine store validated these against TASK_CONTENT_FIELDS and
// that rule survives as "validate against the declared field keys".
const readStoredChange = (
    definition: RecordCollectionDefinition,
    value: unknown,
    label: string
): RecordChange => {
    const record = readSnapshotRecord(value, label);

    // `by`/`threadId` are absent for an identity-less write, `fields` only rides an
    // `update`, and `itemRev` only rides an add/update — the same shape the writer
    // emits. readSnapshotKeys's 4th argument is the may-be-absent list.
    readSnapshotKeys(
        record,
        ['rev', 'id', 'op', 'by', 'threadId', 'at', 'fields', 'itemRev'],
        label,
        ['by', 'threadId', 'fields', 'itemRev']
    );

    const fields =
        record.fields === undefined
            ? undefined
            : readSnapshotArray(record.fields, `${label}.fields`).map((field, index) => {
                  const key = readSnapshotString(field, `${label}.fields[${index}]`, { min: 1 });

                  if (!definition.fields.some((spec) => spec.key === key)) {
                      throw recordError(
                          RECORD_ERROR_CODES.invalidInput,
                          `${label}.fields entries must be one of: ${definition.fields
                              .map((spec) => spec.key)
                              .join(', ')}.`
                      );
                  }

                  return key;
              });

    // A repeated name is not merely untidy: the merge proof compares field SETS, and a
    // feed entry that says `text, text` describes a change the writer never emitted.
    if (fields !== undefined) {
        const seen = new Set<string>();

        for (const key of fields) {
            if (seen.has(key)) {
                throw recordError(
                    RECORD_ERROR_CODES.invalidInput,
                    `${label}.fields lists "${key}" more than once.`
                );
            }

            seen.add(key);
        }
    }

    return {
        rev: readSnapshotInteger(record.rev, `${label}.rev`, { min: 1 }),
        id: readSnapshotId(record.id, `${label}.id`),
        op: readStoredChangeOp(record.op, `${label}.op`),
        ...(record.by === undefined
            ? {}
            : { by: readSnapshotString(record.by, `${label}.by`, { min: 1 }) }),
        ...(record.threadId === undefined
            ? {}
            : {
                  threadId: readSnapshotString(record.threadId, `${label}.threadId`, { min: 1 })
              }),
        at: readSnapshotString(record.at, `${label}.at`, { min: 1 }),
        ...(fields === undefined ? {} : { fields }),
        ...(record.itemRev === undefined
            ? {}
            : {
                  itemRev: readSnapshotInteger(record.itemRev, `${label}.itemRev`, { min: 1 })
              })
    };
};

// One persisted collection: definition, entries, store revision and change window.
// Validation is DELEGATED to the definition (T3): there is one entry reader, and what
// it checks comes from the spec, so adding a collection adds no validator.
const readStoredCollection = (
    value: unknown,
    label: string,
    existing: ReadonlySet<string>
): CollectionState => {
    const record = readSnapshotRecord(value, label);

    readSnapshotKeys(record, ['definition', 'items', 'storeRev', 'changes'], label);

    const definition = readCollectionDefinition(`${label}.definition`, record.definition, existing);
    const entries = readSnapshotArray(record.items, `${label}.items`);

    if (entries.length > definition.maxRecords) {
        throw recordError(
            RECORD_ERROR_CODES.storeFull,
            `${label}.items holds ${entries.length} ${definition.name}; the maximum is ${definition.maxRecords}.`
        );
    }

    const items = entries.map((entry, index) =>
        readStoredEntry(definition, entry, `${label}.items[${index}]`)
    );

    // Uniqueness WITHIN the collection; the global cross-collection bound (F3) is
    // enforced by readRecordsStoreState over the union of every collection's ids.
    const ids = new Set(items.map((item) => item.id));

    if (ids.size !== items.length) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label}.items lists the same id twice; ids are unique.`
        );
    }

    const changeEntries =
        record.changes === undefined
            ? []
            : readSnapshotArray(record.changes, `${label}.changes`);

    if (changeEntries.length > RECORD_MAX_CHANGES) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label}.changes holds ${changeEntries.length} events; the window is ${RECORD_MAX_CHANGES}.`
        );
    }

    const changes = changeEntries.map((change, index) =>
        readStoredChange(definition, change, `${label}.changes[${index}]`)
    );

    // The window must be ascending and unique in BOTH numbers it counts: the store
    // revision (the log's own ordering) and, per record, the content revision (the
    // disjoint-merge proof walks itemRev 1..n with no hole, so a window that fails
    // this test would silently make provable merges unprovable).
    let previousRev = 0;

    for (const change of changes) {
        if (change.rev <= previousRev) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label}.changes must be strictly ascending in "rev"; ${change.rev} follows ${previousRev}.`
            );
        }

        previousRev = change.rev;
    }

    const storeRev =
        record.storeRev === undefined
            ? previousRev
            : readSnapshotInteger(record.storeRev, `${label}.storeRev`, { min: 0 });

    if (previousRev > storeRev) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            `${label}.storeRev is ${storeRev}, behind the last retained change (${previousRev}).`
        );
    }

    return { definition, items, storeRev, changes };
};

// Validates the WHOLE store and returns deep copies. Called before a restore mutates
// anything (the stores' existing "validate everything before mutating" stance) and by
// the lane fold to revalidate a candidate view.
export const readRecordsStoreState = (value: unknown): RecordsStoreState => {
    const root = readSnapshotRecord(value, 'records state');

    readSnapshotKeys(root, ['nextId', 'collections'], 'records state');

    const collectionsRecord = readSnapshotRecord(root.collections, 'records state.collections');
    const names = Object.keys(collectionsRecord);

    if (names.length === 0) {
        throw recordError(
            RECORD_ERROR_CODES.invalidInput,
            'records state.collections must define at least one collection.'
        );
    }

    const existing = new Set<string>();
    const collections: Record<string, CollectionState> = {};
    const allIds: string[] = [];

    for (const name of names) {
        const state = readStoredCollection(
            collectionsRecord[name],
            `records state.collections.${name}`,
            existing
        );

        if (state.definition.name !== name) {
            throw recordError(
                RECORD_ERROR_CODES.unknownCollection,
                `records state.collections is keyed "${name}" but holds the collection "${state.definition.name}".`
            );
        }

        existing.add(name);
        collections[name] = state;

        // ONE id space (F3): every id in the store is unique across collections, so
        // the counter bound is checked against the union, not per collection.
        allIds.push(...state.items.map((item) => item.id));
    }

    for (const definition of BUILTIN_RECORD_COLLECTIONS) {
        if (collections[definition.name] === undefined) {
            throw recordError(
                RECORD_ERROR_CODES.unknownCollection,
                `records state.collections is missing the built-in collection "${definition.name}".`
            );
        }
    }

    return {
        nextId: readSnapshotIdCounter(allIds, root.nextId, 'records state'),
        collections
    };
};

// ---------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------

// What createRecordEngine() returns: the five tools plus the persistence hooks. The
// harness keeps ONE instance per session (a module singleton would leak records
// between server sessions), routes every record-tool call at `executeRecords`, and
// clears the store with `reset()`.
export type RecordEngine = {
    // The routed surface: `harness.runtime.executeRecords(name, context)`.
    executeRecords: (name: RecordsToolName, context: ToolContext) => Promise<unknown>;
    // Every tool this engine serves, keyed by wire name. The harness registers these
    // five through their source entries; the map is what `executeRecords` dispatches
    // on, and what a host can call directly in a test or a driver.
    tools: Record<RecordsToolName, Tool>;
    // The registered collection names, in declaration order (the list an
    // `unknown-collection` refusal quotes).
    collections: () => string[];
    reset: () => void;
    snapshot: () => RecordsStoreState;
    restore: (state: unknown) => void;
    // -----------------------------------------------------------------------
    // R2a/R3a — the OBSERVATION plane (additive; nothing here writes).
    //
    // A host that renders the store live (the harness server's records/tasks panels)
    // needs three things and no more: to be told a call committed, to read the bounded
    // snapshot once, and to page the feed after that. All three are read-only views of
    // state the engine already keeps, so the plane costs no second source of truth.
    //
    // WHY A CALLBACK AND NOT AN EMITTER: one Set, no event names, no `once`/`off`
    // surface to keep honest, and the unsubscribe is the returned closure. A harness
    // with no subscriber pays nothing (the notification is built only when someone is
    // listening), which is what keeps every existing record test byte-identical.
    /**
     * Subscribe to committed store mutations. The listener runs SYNCHRONOUSLY inside
     * the mutating call, after the store is consistent; a listener that throws is
     * ignored, because the write already happened and a dead transport must not fail
     * a tool call. Returns the unsubscribe function.
     */
    onStoreChange: (listener: (notification: RecordStoreNotification) => void) => () => void;
    /** The bounded store snapshot: every collection, its entries, and the retained feed. */
    view: () => RecordStoreView;
    /**
     * The feed after `since`, plus the honest `reset` flag for a `since` the retained
     * window can no longer answer (trimmed away, or a store that was replaced wholesale
     * by a restore/reset — including a `since` ABOVE the watermark, i.e. a watermark
     * carried across a `reset()` that rewound the store to 0).
     */
    changesSince: (since: number) => RecordStoreDelta;
};

export const createRecordEngine = (): RecordEngine => {
    // Insertion order IS declaration order: built-ins first, then anything an agent
    // `define`s. A Map, because a plain object would put a collection named
    // "constructor" in charge of the prototype.
    const collections = new Map<string, CollectionState>();

    // THE id counter — one for the whole store, not one per collection (F3). It
    // restarts at 1 after reset(), because a reset is a clean start: the conversation
    // and every id referring to it are gone too.
    let nextId = 1;

    // R3/T3.1 — the per-NAME storeRev high-water mark, and the epoch floor that goes
    // with a re-`define`.
    //
    // The defect: `drop` deleted the collection outright and a re-`define` built it
    // with `freshState`, i.e. storeRev 0 and an empty change log. Every client holding
    // a watermark from the dropped epoch then hit `since > storeRev` and was told its
    // own saved revision was a caller error — a token that could never be accepted
    // again, with no code that says "the epoch moved, resync".
    //
    // The fix is RUNTIME state, held beside `collections` and deliberately NOT part of
    // the snapshot: `readRecordsStoreState` validates the persisted root with an exact
    // key set (`nextId`, `collections`) and each collection with an exact key set
    // (`definition`, `items`, `storeRev`, `changes`), so a new persisted key would
    // break every restore, and persistence itself is out of R3's scope. `restore()`
    // therefore SEEDS this map from each restored collection's storeRev, which covers
    // the restart path that keeps the same name.
    //
    // Residual gap, stated rather than hidden: drop → process restart → re-`define`
    // loses the mark, because nothing persisted ever held it and the dropped name is
    // absent from the snapshot. That restart already loses the client's change log too.
    const storeRevHighWater = new Map<string, number>();

    // The lowest `since` the CURRENT epoch of a name accepts. Absent means "this name
    // has never been re-defined", i.e. every since >= 0 is meaningful and today's
    // behaviour is unchanged. Never persisted, for the same reason as the map above.
    const epochFloors = new Map<string, number>();

    // -----------------------------------------------------------------------
    // R2a/R3a — the store-wide feed (the observation plane's only new state).
    //
    // WHAT IT IS: a second, STORE-level FIFO of the same change entries `pushChange`
    // already logs per collection, each stamped with a store-wide `seq` and its
    // collection name. It exists because a live panel shows every collection at once
    // and needs ONE cursor across them, while the per-collection windows (Decision B)
    // must stay per-collection for the disjoint-merge proof. The two are views of the
    // same events, never two truths: the per-collection entry is written first and
    // unconditionally (that is the pinned tool contract), and the feed mirrors it.
    //
    // WHY IT IS RUNTIME-ONLY: `readRecordsStoreState` validates the persisted root with
    // an exact key set, so a new persisted key would break every existing snapshot
    // (the same reason `storeRevHighWater`/`epochFloors` above are runtime-only), and
    // R5 forbids a persistence schema change. A restart therefore starts with an empty
    // feed, which the delta reader reports as `reset: true` — the client re-bootstraps
    // from the snapshot, which is exactly what a restart needs anyway.
    //
    // WHY IT IS ALWAYS MAINTAINED (not only while subscribed): the REST read is a poll
    // source for a host with no live subscriber, and 200 detached entries is a bound
    // the per-collection windows already accept.
    let storeRev = 0;
    let collectionsRev = 0;
    const storeFeed: RecordStoreChange[] = [];

    // The entries appended by the call currently executing, when that call is the
    // mutating kind. One call = one notification, so a 40-record batch never becomes 40
    // stream frames. Nothing between the apply loops' first and last push is async
    // (`executeCollection` is synchronous end to end), so this single slot cannot be
    // taken by an interleaved call, and it is cleared in a `finally` either way.
    let feedCapture: RecordStoreChange[] | undefined;

    const storeListeners = new Set<(notification: RecordStoreNotification) => void>();

    /** Fan out one committed change. A listener that throws is dropped, never fatal. */
    const notifyStore = (
        reason: RecordStoreChangeReason,
        affectedCollections: string[],
        changes: readonly RecordStoreChange[]
    ): void => {
        if (storeListeners.size === 0) return;

        const notification: RecordStoreNotification = {
            storeRev,
            collectionsRev,
            affectedCollections,
            // Detached, so a listener that keeps or mutates the list cannot disturb the feed.
            changes: changes.map((change) => ({ ...change })),
            reason
        };

        for (const listener of storeListeners) {
            try {
                listener(notification);
            } catch {
                // The write already committed; a dead observer is the observer's problem.
            }
        }
    };

    // Records that a name has been seen at least this high. Monotonic by construction:
    // a registration, a drop and a restore all flow through here and none may lower it.
    const seedHighWater = (name: string, storeRev: number): void => {
        const prior = storeRevHighWater.get(name);

        storeRevHighWater.set(name, prior === undefined || storeRev > prior ? storeRev : prior);
    };

    const freshState = (
        definition: RecordCollectionDefinition,
        // R3: a re-`define` of a dropped name inherits the epoch, so its starting
        // revision is passed in; a first-time name (and every built-in) starts at 0.
        storeRev: number = 0
    ): CollectionState => ({
        definition,
        items: [],
        storeRev,
        changes: []
    });

    for (const definition of BUILTIN_RECORD_COLLECTIONS) {
        collections.set(definition.name, freshState(definition));
        seedHighWater(definition.name, 0);
    }

    // The names the engine currently accepts — the set `records` validates a
    // `collection` against BEFORE dispatch (Decision C). Restored definitions join it,
    // which is what makes a `define`d collection rediscoverable (Decision M).
    const registeredNames = (): Set<string> => new Set(collections.keys());

    const findCollection = (name: unknown): CollectionState => {
        if (typeof name !== 'string' || name.trim().length === 0) {
            throw recordError(
                RECORD_ERROR_CODES.unknownCollection,
                `records requires a non-empty "collection" string; defined collections: ${[
                    ...collections.keys()
                ].join(', ')}.`
            );
        }

        const state = collections.get(name.trim());

        if (state === undefined) {
            throw recordError(
                RECORD_ERROR_CODES.unknownCollection,
                `records has no collection "${name.trim()}"; defined collections: ${[
                    ...collections.keys()
                ].join(', ')}. Pass "define" to create a new one.`,
                { collection: name.trim(), defined: [...collections.keys()] }
            );
        }

        return state;
    };

    // Records one accepted event in ONE collection's window: bump that collection's
    // revision, append the entry with it, and keep the window bounded. `entry` carries
    // everything but `rev`, so no caller can log an event with a hand-picked revision.
    //
    // Per collection, deliberately (Decision B): a chapter write must not open a hole
    // in the task window that `mergeDisjoint` reads as "coverage unknown".
    const pushChange = (state: CollectionState, entry: Omit<RecordChange, 'rev'>): void => {
        state.storeRev += 1;

        const change: RecordChange = { rev: state.storeRev, ...entry };

        state.changes.push(change);

        if (state.changes.length > RECORD_MAX_CHANGES) {
            state.changes.splice(0, state.changes.length - RECORD_MAX_CHANGES);
        }

        // R2a — mirror the SAME event into the store-wide feed (see the block above
        // `freshState`). Order is fixed: the per-collection window is written first, so
        // every existing result contract and every existing test sees exactly the bytes
        // it saw before, and the feed is a pure addition. The entry is detached with the
        // same `copyChange` the snapshot uses, so one event's two views never alias.
        storeRev += 1;

        const feedEntry: RecordStoreChange = {
            seq: storeRev,
            collection: state.definition.name,
            ...copyChange(change)
        };

        storeFeed.push(feedEntry);

        if (storeFeed.length > RECORD_MAX_CHANGES) {
            storeFeed.splice(0, storeFeed.length - RECORD_MAX_CHANGES);
        }

        if (feedCapture !== undefined) feedCapture.push(feedEntry);
    };

    // Builds one budgeted page of the CURRENT collection, plus the store revision and,
    // when `since` was asked for, the change feed:
    //   - records are copied first, so the live store is never handed out;
    //   - they are added while the serialized UTF-8 size stays inside the collection's
    //     budget (a comma per record is counted too);
    //   - the FIRST record of a non-empty page is always included: one record is at
    //     most a few KiB over the declared caps, so this cannot blow the budget, and it
    //     guarantees `nextOffset` always advances (no stall, no gaps);
    //   - `hasMore` is computed against the full ordered length, so a budget-truncated
    //     page reports the cursor of its last included record rather than offset+limit;
    //   - the change feed is the LAST thing added to the budget: the page the caller
    //     asked for is authoritative, and a trimmed feed says so via `changesHasMore`.
    // Every success path goes through here, which is what makes Decision D's single
    // result shape a property of the code rather than of discipline.
    const project = (
        state: CollectionState,
        request: {
            offset: number;
            limit: number;
            afterId?: string;
            since?: number;
            // R7/T7.1 — the validated equality filter. ABSENT means "no filter", and
            // every path below then reads the live `state.items` exactly as it always
            // did, which is what makes an unfiltered page byte-identical (stop-condition
            // 5). `readWhere` has already normalized it, so `project` never re-validates.
            where?: Record<string, unknown>;
        }
    ): RecordsResult => {
        const definition = state.definition;
        // The collection's sort key, when it declares one. `orderedFor` uses the first
        // `sortable` field; R2's cursor rule below asks the same question, so the two
        // stay in agreement about what "a sortable collection" means.
        const sortable = definition.fields.find((field) => field.sortable === true);
        const keyset = request.afterId !== undefined;
        // R7/T7.1 — the filter is applied to the ITEM SET, before the order is chosen and
        // before the slice is cut, so `offset`, `limit`, `hasMore`, `nextOffset` and
        // `nextAfterId` all describe the matching records (the doc's check: a filtered
        // page must report `hasMore` against the filtered set). Filtering after the slice
        // would return short pages that claim there is no more.
        const selected: readonly RecordEntry[] =
            request.where === undefined
                ? state.items
                : state.items.filter((item) => matchesWhere(item, request.where as Record<string, unknown>));
        const ordered: readonly RecordEntry[] = keyset
            ? [...selected].sort((left, right) => Number(left.id) - Number(right.id))
            : orderedFor(definition, selected);
        const start = keyset
            ? firstIndexAfter(ordered, Number(request.afterId))
            : request.offset;

        const entries: RecordEntry[] = [];
        let bytes = 0;
        // M10 — whether the BYTE BUDGET, not `limit`, is what stopped this page. A caller
        // that sees a short page must know which bound bit: a `limit`-short page means
        // "ask for more per page", a budget-short page means "your records are too big to
        // page at this size" and raising `limit` would change nothing. Absent unless true,
        // so every existing whole-object `page` assertion on small records stays exact.
        let budgetTruncated = false;

        for (const item of ordered.slice(start, start + request.limit)) {
            const copy = copyEntry(definition, item);
            const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

            if (entries.length > 0 && bytes + size > definition.responseBudgetBytes) {
                budgetTruncated = true;
                break;
            }

            entries.push(copy);
            bytes += size;
        }

        const consumed = start + entries.length;
        const page: RecordsPageInfo = {
            // Keyset mode reports the EFFECTIVE index of the first included record (an
            // empty page reports the ordered length, i.e. "nothing after the cursor");
            // offset mode echoes the cursor the caller asked for.
            offset: keyset && entries.length === 0 ? ordered.length : start,
            limit: request.limit,
            hasMore: consumed < ordered.length
        };

        if (budgetTruncated) page.budgetTruncated = true;

        if (keyset) page.afterId = request.afterId as string;

        if (page.hasMore) {
            if (keyset) page.nextAfterId = entries[entries.length - 1].id;
            else {
                page.nextOffset = consumed;

                // R2/T2.1 — the seam between the two page orders. An OFFSET page on a
                // collection that declares a `sortable` field is in PAGE order, while
                // every `afterId` cursor walks ID order, and those two orders differ on
                // exactly such a collection (the decision recorded above
                // `firstIndexAfter`). Emitting only `nextOffset` left a caller that
                // switches modes to invent a cursor from the last id it SAW, which on a
                // sortable page is not the largest id on it — so the switch silently
                // skipped every record that sorted into this page while carrying a
                // smaller id (the doc's {82,84} → 85 walk that lost 81 and 83). Handing
                // back the MAXIMUM id of the page makes the switch lossless.
                //
                // Deliberately narrow, so nothing else moves:
                //   - a keyset page already reports the maximum id of its own page,
                //     because `ordered` is id-sorted in that mode;
                //   - an offset page on a NON-sortable collection is already in id
                //     order, so its last element IS the maximum and `nextOffset` alone
                //     stays sufficient;
                //   - `hasMore` implies a non-empty page in offset mode (`limit` >= 1 and
                //     the first record always fits the budget), hence the length guard is
                //     belt-and-braces for a hand-built request.
                if (sortable !== undefined && entries.length > 0) {
                    // MAX numeric id, NOT the last element — pinned by a limit-3 test on
                    // the doc's fixture, where the page ends at the prio-5 record while
                    // the prio-3 record carries the larger id.
                    let maxId = Number(entries[0].id);

                    for (const entry of entries) {
                        const id = Number(entry.id);

                        if (id > maxId) maxId = id;
                    }

                    page.nextAfterId = String(maxId);
                }
            }
        }

        const result: RecordsResult = {
            entries,
            // R7/T7.1 — the counts rule, stated exactly because it is what a caller
            // reconciles the page against: an UNFILTERED read still counts the WHOLE
            // collection (`selected` IS `state.items` there, so this line is byte-identical
            // to before), while a read that sends `where` counts the FILTERED set — the
            // only way a facet count and a filtered page can ever agree. `selected` is the
            // same array the page and its cursors were computed from, so the two cannot
            // disagree in either mode.
            counts: countsOf(definition, selected),
            page,
            storeRev: state.storeRev
        };

        // Copy the watermark into a const so the narrowing survives into the filter
        // callback (a property access is not narrowed inside a closure).
        const since = request.since;

        if (since === undefined) return result;

        const feed = state.changes.filter((change) => change.rev > since);
        const limited = feed.slice(0, RECORD_MAX_CHANGES_IN_RESULT);

        // The window is FIFO-trimmed, so a reader that fell behind the oldest retained
        // event never sees the whole gap. Say so, rather than handing back a short list
        // that looks complete.
        const truncated =
            since < state.storeRev &&
            (state.changes.length === 0 || state.changes[0].rev > since + 1);

        // Same first-entry-always-fits rule as the page: a change entry is ~100 bytes,
        // so one can never blow the budget, and a feed that only reported "more exist"
        // after every 4 KiB page would be useless.
        let used = Buffer.byteLength(JSON.stringify(result), 'utf8');
        const kept: RecordChange[] = [];

        for (const change of limited) {
            const copy = copyChange(change);
            const size = Buffer.byteLength(JSON.stringify(copy), 'utf8') + 1;

            if (kept.length > 0 && used + size > definition.responseBudgetBytes) break;

            kept.push(copy);
            used += size;
        }

        result.changes = kept;
        // Covers BOTH ways the feed gets cut: the entry cap and the byte budget.
        result.changesHasMore = kept.length < feed.length;
        result.changesTruncated = truncated;

        return result;
    };

    // Reads the ids `ids` names, one entry each for a single id (Decision D's `entry`).
    const readIds = (state: CollectionState, ids: readonly string[]): RecordEntry[] =>
        ids.map((id) =>
            copyEntry(state.definition, state.items.find((item) => item.id === id) as RecordEntry, true)
        );

    // The engine's own action surface: everything that is not a wrapper's argument
    // mapping. `input` is the already-narrowed argument record; `identity` comes from
    // the ToolContext, never from the arguments.
    const executeCollection = (
        state: CollectionState,
        input: RecordsParameters & Record<string, unknown>,
        identity: CallerIdentity,
        callerBatchKey: string = 'entries'
    ): RecordsResult => {
        const definition = state.definition;
        const label = callLabelOf(definition);
        const raw = input as Record<string, unknown>;

        // `define` is answered by runCall, because a NEW collection has no
        // collection to operate on. Reaching it here means the caller passed BOTH a
        // collection and a define, which is ambiguous and refused, not merged.
        if (raw.define !== undefined) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `records "define" registers a NEW collection, so it takes no "collection" beside it.`
            );
        }

        if (raw.drop === true) {
            if (
                raw.entries !== undefined ||
                raw.remove !== undefined ||
                raw.ids !== undefined
            ) {
                throw recordError(
                    RECORD_ERROR_CODES.invalidInput,
                    'records "drop" removes a collection on its own; send it without "entries", "remove" or "ids".'
                );
            }

            return dropCollection(state);
        }

        // R6/T6.1 — `describe` reads the collection's SPEC, so it is answered before the
        // paging, cursor, `since` and plan rules run at all: nothing about a page can
        // disturb it, and it cannot be combined with a write (a call that both asked for
        // the definition and sent `entries` would otherwise silently drop the write).
        // `drop` is checked above and still wins, because it was here first and its
        // error wording is pinned.
        if (raw.describe !== undefined) {
            // Read the flag even when it is `false`, so a non-boolean is still refused.
            const described = readDescribe(label, raw.describe);

            if (described) {
                // Review F5 — the guard used to refuse only the three batch keys, so every
                // READ control beside `describe: true` rode along unvalidated and was
                // silently ignored: `describe: true, since: 999` answered with a definition
                // and no `changes`, and a `where`/`offset`/`limit`/`afterId` beside it could
                // move nothing, because this branch short-circuits ahead of the readers
                // below. A `describe` answer is the SPEC plus an empty page, so "on its own"
                // now means exactly that: none of the eight controls may accompany it.
                const crowded =
                    raw.entries !== undefined ||
                    raw.remove !== undefined ||
                    raw.ids !== undefined ||
                    raw.since !== undefined ||
                    raw.offset !== undefined ||
                    raw.limit !== undefined ||
                    raw.afterId !== undefined ||
                    raw.where !== undefined;

                if (crowded) {
                    throw recordError(
                        RECORD_ERROR_CODES.invalidInput,
                        `${label} "describe" reads a collection's definition on its own; send it without "entries", "remove", "ids", "since", "offset", "limit", "afterId" or "where".`
                    );
                }

                return describeCollection(state);
            }
        }

        const offset = readOffset(label, raw.offset);
        const limit = readLimit(label, raw.limit);
        const afterId = readAfterId(label, raw.afterId);
        const since = readSince(label, raw.since);
        // R7/T7.1 — validated against the declared fields, so a typo is a refusal naming
        // the key rather than an empty page. It is read HERE rather than in `readPlan`
        // because it belongs to the READ half of a call: it never touches the store.
        const where = readWhere(label, definition, raw.where);

        // The two cursors mean different things (an index vs. an id) and a caller that
        // sends both has not decided which page it wants.
        if (afterId !== undefined && raw.offset !== undefined) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "afterId" and "offset" cannot be combined.`
            );
        }

        // R7/T7.1 — `where` narrows the set the page cursors move over, while `since`
        // asks for the collection's event LOG, which is a different axis entirely: a
        // change entry has no field values to filter on, so a filtered feed would be a
        // fabrication. Refused rather than silently ignoring one of the two.
        if (where !== undefined && since !== undefined) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "where" and "since" cannot be combined: the change feed is the unfiltered log of the whole collection.`
            );
        }

        // Review F3 — `ids` is the OTHER axis `where` cannot meet: it is the one lookup
        // mode that does not answer with the page at all. `readIds` (`records.ts:2547`)
        // fetches exactly the ids the caller named and REPLACES the projected entries with
        // them (`records.ts:2749-2756`), while `project` has already filtered the SET the
        // page and `counts` were computed from. The answer was therefore two different
        // sets in one envelope: unfiltered records beside filtered counts, with nothing
        // refusing the pair and nothing documenting it.
        //
        // `ids` is the only non-page lookup mode in the request parser. `readPlan`
        // (`records.ts:1568`) sorts the rest into writes — `entries` are patches and
        // additions, `remove` is a removal list — and a mutating call still answers with a
        // PAGE (`records.ts:2880-2888`), which `where` bounds honestly. So the refusal
        // covers every mode where the filter would be bypassed and only that mode.
        //
        // Through a wrapper this is the same rule, not a new one: an `action`-style
        // `get` maps to `ids: [id]` (`records.ts:3185`), and its schema already says
        // `where` is "For 'list' only", so `get` + `where` was a silently ignored filter.
        if (where !== undefined && raw.ids !== undefined) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "where" and "ids" cannot be combined: "ids" answers with the records it names, so a filter would narrow only the page and the counts beside them.`
            );
        }

        // Asking for events the collection has not produced yet is a bug, not an empty
        // answer: it usually means the caller sent a page revision.
        //
        // R3: this stays the FIRST check, and stays `invalid-input`, so the code keeps
        // its meaning — "you asked for a revision the store has not reached". A token
        // that was fine when it was saved and is now behind the log gets its own code
        // below.
        if (since !== undefined && since > state.storeRev) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} "since" is revision ${since}, ahead of the store (storeRev ${state.storeRev}); read the list first.`
            );
        }

        // R3/T3.2 — the other side of the epoch: the watermark is real, but the change
        // log it indexes was deleted and rebuilt under the caller (drop + re-`define`).
        // `revision-epoch-reset` tells a client to resync from scratch instead of
        // blaming its arithmetic, and it can only fire for a name that was re-`define`d,
        // because only then does a floor exist.
        const epochFloor = epochFloors.get(definition.name);

        if (since !== undefined && epochFloor !== undefined && since < epochFloor) {
            throw recordError(
                RECORD_ERROR_CODES.revisionEpochReset,
                `${label} "since" ${since} predates the current change log (the collection was dropped and re-defined; storeRev is now ${state.storeRev}) — resync from scratch.`,
                { collection: definition.name, since, epochFloor, storeRev: state.storeRev }
            );
        }

        // Validate everything, then mutate. Nothing between this line and the apply
        // loops below can throw, so the store is never half-patched — including a
        // rejected CAS, which leaves items, the id counter, storeRev and the log
        // exactly as they were.
        const plan = readPlan(
            definition,
            raw,
            {
                find: (id) => state.items.find((candidate) => candidate.id === id),
                length: () => state.items.length,
                changes: () => state.changes,
                // R5/T5.1: the whole-store id sweep, from the one place that can do it
                // — the engine closure, which owns every collection. First match wins
                // because ids are unique across collections (F3).
                ownerOf: (id: string): string | undefined => {
                    for (const [name, candidate] of collections) {
                        if (candidate.items.some((item) => item.id === id)) return name;
                    }

                    return undefined;
                },
                ...(identity.by === undefined ? {} : { by: identity.by }),
                ...(identity.threadId === undefined ? {} : { threadId: identity.threadId })
            },
            callerBatchKey
        );

        // A pure read: `ids` (one → `entry`) or the current page.
        if (!plan.mutates) {
            const result = project(state, {
                offset,
                limit,
                ...(afterId === undefined ? {} : { afterId }),
                ...(since === undefined ? {} : { since }),
                // R7: the filter decides the ordered set the page is cut from.
                ...(where === undefined ? {} : { where })
            });

            if (plan.lookups.length === 1) {
                const [only] = readIds(state, plan.lookups);

                delete result.entries;
                result.entry = only;
            } else if (plan.lookups.length > 1) {
                result.entries = readIds(state, plan.lookups);
            }

            return result;
        }

        // -----------------------------------------------------------------
        // APPLY — the only mutating step. One timestamp for the whole call, so every
        // attribution and every change entry of one call agrees.
        // -----------------------------------------------------------------
        const now = Date.now();
        const at = new Date(now).toISOString();
        const identityFields = {
            ...(identity.by === undefined ? {} : { by: identity.by }),
            ...(identity.threadId === undefined ? {} : { threadId: identity.threadId })
        };

        // Attribution is written for a real write only. Who did it is knowable only
        // when the caller had an identity, and `updatedAt` is a fact about this write
        // and always moves.
        const writeAttribution = (entry: RecordEntry): void => {
            entry.updatedAt = at;
            if (identity.by !== undefined) entry.updatedBy = identity.by;
            if (identity.threadId !== undefined) entry.updatedThreadId = identity.threadId;
        };

        const findEntry = (id: string): RecordEntry =>
            state.items.find((candidate) => candidate.id === id) as RecordEntry;

        // The records this call created or changed, in caller order, so a one-record
        // mutation can answer with `entry` (the wrapper contract) and a multi-record
        // batch answers with the page like any other success.
        const affected: RecordEntry[] = [];

        // 1. PATCHES. An existing entry keeps its position and its id, and only the
        //    fields the caller named change. A patch whose named fields already hold
        //    those values is a SUCCESS with no event — no rev bump, no attribution, no
        //    log entry — so re-sending the same list cannot flood the change window or
        //    knock every reader off its revision.
        for (const patch of plan.patches) {
            const entry = findEntry(patch.id as string);
            const fields: string[] = [];
            const written = new Map<string, unknown>();

            for (const spec of definition.fields) {
                if (!Object.prototype.hasOwnProperty.call(patch.patch, spec.key)) continue;

                const next = patch.patch[spec.key];
                const current = valueOfField(entry, definition, spec.key);

                // Arrays compare by content, not reference: `traits: ["brave"]` sent
                // twice is not a change.
                const same =
                    Array.isArray(current) && Array.isArray(next)
                        ? current.length === next.length &&
                          current.every((item, index) => item === next[index])
                        : current === next;

                if (same) continue;

                fields.push(spec.key);
                written.set(spec.key, next);
            }

            if (fields.length === 0) continue;

            entry.rev += 1;

            for (const [key, value] of written) {
                entry[key] = Array.isArray(value) ? [...value] : value;
            }

            writeAttribution(entry);
            pushChange(state, {
                id: entry.id,
                op: 'update',
                ...identityFields,
                at,
                fields,
                itemRev: entry.rev
            });
            affected.push(entry);
        }

        // 2. REMOVALS, before the additions, so a caller may restate a full section in
        //    one call and the freed slots do not shift the appended records.
        const removed: RecordEntry[] = [];

        for (const id of plan.removals) {
            const index = state.items.findIndex((candidate) => candidate.id === id);

            if (index === -1) continue;

            const [gone] = state.items.splice(index, 1);

            removed.push(copyEntry(definition, gone, false));
            pushChange(state, { id, op: 'remove', ...identityFields, at });
        }

        // 3. ADDITIONS last, in caller order, taking ids from the GLOBAL monotonic
        //    counter (a removed id is never reused within this instance, and a task and
        //    a chapter never collide — F3). A new record starts at content rev 1,
        //    attributed when the caller has an identity.
        for (const addition of plan.additions) {
            const id = String(nextId);
            const entry: RecordEntry = { id, rev: 1 } as RecordEntry;

            for (const spec of definition.fields) {
                const value = Object.prototype.hasOwnProperty.call(addition, spec.key)
                    ? addition[spec.key]
                    : spec.default;

                if (value === undefined) continue;

                entry[spec.key] = Array.isArray(value) ? [...value] : value;
            }

            writeAttribution(entry);
            state.items.push(entry);
            nextId += 1;

            pushChange(state, { id, op: 'add', ...identityFields, at, itemRev: 1 });
            affected.push(entry);
        }

        const result = project(state, {
            offset,
            limit,
            ...(afterId === undefined ? {} : { afterId }),
            ...(since === undefined ? {} : { since }),
            // R7: a mutation still answers with a page, and `where` bounds that page the
            // same way it bounds a read. The write itself is unaffected by the filter.
            ...(where === undefined ? {} : { where })
        });

        if (removed.length > 0) result.removed = removed;

        // One affected record → `entry`, which is what lets an action wrapper answer
        // `add`/`update` with its singular domain shape.
        if (affected.length === 1) {
            result.entry = copyEntry(
                definition,
                affected[0],
                // A fresh chapter still costs no body in a mutation result: `get` is
                // the one read that pays for it.
                false
            );
        }

        return result;
    };

    // Registers a NEW collection (Decision C). Engine defaults cover the bounds the
    // agent did not name; a name that already exists is an ERROR, never a silent
    // merge — otherwise an agent could re-`define` `tasks` with different caps and
    // quietly change a live collection's contract mid-session (Decision M).
    const defineCollection = (input: {
        name: string;
        fields: unknown[];
        maxRecords?: number;
        responseBudgetBytes?: number;
    }): RecordsResult => {
        const definition = readCollectionDefinition(
            `records "define"`,
            {
                name: input.name,
                fields: input.fields,
                ...(input.maxRecords === undefined
                    ? {}
                    : { maxRecords: input.maxRecords }),
                ...(input.responseBudgetBytes === undefined
                    ? {}
                    : { responseBudgetBytes: input.responseBudgetBytes })
            },
            registeredNames()
        );

        // R3/T3.1 — a name whose high-water mark survives a drop continues the count
        // instead of restarting at 0, so a `storeRev` a client saved before the drop can
        // never be "ahead of the store" again, and never silently re-uses a revision
        // number from the previous epoch. A name the engine has never seen keeps exactly
        // today's behaviour (storeRev 0, no floor).
        const priorHighWater = storeRevHighWater.get(definition.name);
        const startRev = priorHighWater === undefined ? 0 : priorHighWater + 1;
        const state = freshState(definition, startRev);

        collections.set(definition.name, state);
        seedHighWater(definition.name, startRev);

        // The floor exists only for a re-`define`: it is the first revision of the NEW
        // change log, so anything below it belongs to the dropped epoch.
        if (startRev > 0) epochFloors.set(definition.name, startRev);

        // R2a — a NEW collection is a store change a live panel must see (its tab does
        // not exist yet), and it mints no record event, so it moves `collectionsRev`
        // only. A client that notices the number move re-reads the snapshot.
        collectionsRev += 1;
        notifyStore('define', [definition.name], []);

        return {
            entries: [],
            counts: { total: 0 },
            page: { offset: 0, limit: RECORD_LIST_DEFAULT_LIMIT, hasMore: false },
            // R3: echo the state's real revision — this literal was `storeRev: 0`, which
            // after a drop + re-`define` would report a revision the store does not have.
            storeRev: state.storeRev,
            collection: definition.name
        };
    };

    // R6/T6.1 — reads a collection's OWN spec back. There was no introspection verb:
    // the engine held the answer (the same map that powers the `unknown-collection`
    // name list) and exposed only the names, which is what made discovering the accepted
    // `count` shapes cost a live session four failed `define` calls.
    //
    // Short-circuited ahead of `readPlan` and ahead of the paging/cursor/`since` rules,
    // so it can never disturb them: a describe call mints nothing, moves nothing and
    // reports the collection's real `counts` and `storeRev` alongside the spec.
    const describeCollection = (state: CollectionState): RecordsResult => ({
        entries: [],
        counts: countsOf(state.definition, state.items),
        page: { offset: 0, limit: RECORD_LIST_DEFAULT_LIMIT, hasMore: false },
        storeRev: state.storeRev,
        collection: state.definition.name,
        definition: cloneDefinition(state.definition)
    });

    // R6/T6.2 — the registered collection names, sorted. `collections()` on the engine
    // surface returns declaration order (the order `unknown-collection` quotes); this is
    // the answer to "what can I ask for?" and must be stable across hosts, hence the
    // sort.
    const listCollections = (): RecordsResult => {
        const names = [...collections.keys()].sort();

        return {
            entries: [],
            counts: { total: names.length },
            page: { offset: 0, limit: RECORD_LIST_DEFAULT_LIMIT, hasMore: false },
            // No single collection is addressed by a bare call, so there is no store
            // revision to report — `0` says "none", and `collections` is the answer.
            storeRev: 0,
            collections: names
        };
    };

    // Drops a `define`d collection. Only when EMPTY, and only for a collection an
    // agent defined (Decision M): dropping a non-empty one would itself mutate
    // history, and a built-in is part of the product.
    const dropCollection = (state: CollectionState): RecordsResult => {
        if (BUILTIN_COLLECTION_NAMES.includes(state.definition.name)) {
            throw recordError(
                RECORD_ERROR_CODES.collectionPermanent,
                `records cannot drop "${state.definition.name}": it is a built-in collection and is permanent.`,
                { collection: state.definition.name }
            );
        }

        if (state.items.length > 0) {
            throw recordError(
                RECORD_ERROR_CODES.collectionNotEmpty,
                `records cannot drop "${state.definition.name}": it still holds ${state.items.length} ${state.definition.name}. Remove them first — dropping a non-empty collection would delete history.`,
                { collection: state.definition.name, count: state.items.length }
            );
        }

        // R3/T3.1: keep the high-water mark (raised, never lowered) across the delete,
        // because the point of the mark is exactly what the client still holds after the
        // collection is gone. `drop` only accepts an EMPTY collection, so the surviving
        // number is the last revision that collection reached.
        seedHighWater(state.definition.name, state.storeRev);

        collections.delete(state.definition.name);

        // R2a — the collection is gone, so a panel has to drop its tab. Same rule as
        // `define`: a collection-set change moves `collectionsRev`, never the record feed.
        collectionsRev += 1;
        notifyStore('drop', [state.definition.name], []);

        return {
            entries: [],
            counts: { total: 0 },
            page: { offset: 0, limit: RECORD_LIST_DEFAULT_LIMIT, hasMore: false },
            storeRev: state.storeRev,
            collection: state.definition.name
        };
    };

    // Reads and validates a `define` argument. Kept separate from
    // `readCollectionDefinition` because the agent-facing shape is narrower: the name
    // and fields, with the bounds optional.
    const readDefineInput = (
        label: string,
        value: unknown
    ): { name: string; fields: unknown[]; maxRecords?: number; responseBudgetBytes?: number } => {
        const raw = readSnapshotRecord(value, `${label} "define"`);

        // 'maxRecords' is optional: the engine default (RECORD_MAX_RECORDS) fills it in,
        // which is what makes define { name, fields } a complete call (Decision C).
        //
        // 'responseBudgetBytes' was RESTORED-only: `readCollectionDefinition` validated it
        // on a snapshot (`:1140-1146`, min 1024 / max RECORD_RESPONSE_BUDGET_BYTES) and
        // `describe` reported it, but no agent could SET it — so the one number that
        // decides when a page starts losing records (M10's `budgetTruncated`) was readable
        // and not writable from the tool surface. Admitted here as optional; the range is
        // enforced by the shared validator below, so a bad value is refused, not clamped.
        readSnapshotKeys(
            raw,
            ['name', 'fields', 'maxRecords', 'responseBudgetBytes'],
            `${label} "define"`,
            ['maxRecords', 'responseBudgetBytes']
        );

        const name = readSnapshotString(raw.name, `${label} "define".name`, {
            min: 1,
            max: RECORD_MAX_COLLECTION_NAME
        });

        // Decision K: a `define`d name is taken VERBATIM — plural is recommended, not
        // enforced, because there is no principled way to singularize an arbitrary
        // noun. A decimal-only name would collide with the id space in prose, so it is
        // refused; anything else the agent wrote is what the agent gets.
        if (/^[0-9]+$/.test(name)) {
            throw recordError(
                RECORD_ERROR_CODES.definitionInvalid,
                `${label} "define".name "${name}" cannot be a bare number; name the collection after what it holds.`,
                { name }
            );
        }

        const fields = readSnapshotArray(raw.fields, `${label} "define".fields`);

        return {
            name,
            fields,
            ...(raw.maxRecords === undefined
                ? {}
                : {
                      // A cap outside the engine's range is refused, not clamped: the
                      // agent chose a number and must learn what the store allows.
                      maxRecords: (() => {
                          const cap = readSnapshotInteger(raw.maxRecords, `${label} "define".maxRecords`, {
                              min: 1
                          });

                          if (cap > RECORD_MAX_RECORDS) {
                              throw recordError(
                                  RECORD_ERROR_CODES.recordCap,
                                  `${label} "define".maxRecords is ${cap}; a collection holds at most ${RECORD_MAX_RECORDS} records.`
                              );
                          }

                          return cap;
                      })()
                  }),
            // M10 companion — the page budget, settable from the tool surface for the
            // first time. Same refuse-don't-clamp rule as `maxRecords`, and the same
            // 1024..RECORD_RESPONSE_BUDGET_BYTES range the snapshot path already enforced
            // (`:1140-1146`), so a `define` and a `restore` of the same number agree.
            ...(raw.responseBudgetBytes === undefined
                ? {}
                : {
                      responseBudgetBytes: (() => {
                          const budget = readSnapshotInteger(
                              raw.responseBudgetBytes,
                              `${label} "define".responseBudgetBytes`,
                              { min: 1 }
                          );

                          if (budget < 1024 || budget > RECORD_RESPONSE_BUDGET_BYTES) {
                              throw recordError(
                                  RECORD_ERROR_CODES.recordCap,
                                  `${label} "define".responseBudgetBytes is ${budget}; a page budget must be between 1024 and ${RECORD_RESPONSE_BUDGET_BYTES} bytes.`
                              );
                          }

                          return budget;
                      })()
                  })
        };
    };

    // -----------------------------------------------------------------------
    // The wrappers (Decision E): a schema and a response shape, nothing else.
    // -----------------------------------------------------------------------
    //
    // The mapping lives HERE rather than in the source entries for one mechanical
    // reason: a shipped source entry is a standalone compiled module that
    // ../scripts/check-package-tools.mjs pins to `dependencies: []`, so it cannot
    // import a helper. The entries therefore carry only their schema (their own field
    // caps, which is where R6's progressive restriction is enforced by
    // ./schema-validation.ts before this code runs) and the routed call; the engine
    // turns their arguments into a collection call and their result into their
    // historical domain shape. That keeps every wrapper stateless and logic-free,
    // which is what makes escalating to `records` an escalation in FREEDOM rather than
    // a change of behaviour.

    // Translates one wrapper call into the engine input.
    const toCollectionInput = (
        definition: RecordCollectionDefinition,
        parameters: unknown
    ): RecordsParameters & Record<string, unknown> => {
        const wrapper = definition.wrapper;
        const raw = isRecord(parameters) ? parameters : {};

        if (parameters !== undefined && parameters !== null && !isRecord(parameters)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${callLabelOf(definition)} expects an object with the collection's fields.`
            );
        }

        if (wrapper === undefined || wrapper.style === 'batch') {
            // `tasks`: the historical patch design. `tasks[]` carries adds AND patches,
            // `remove[]` carries ids, and no arguments at all is a read.
            const batchKey = wrapper === undefined ? 'entries' : wrapper.plural;
            const input: RecordsParameters & Record<string, unknown> = { ...raw };

            if (batchKey !== 'entries') {
                // The wrapper's plural key IS the engine's `entries` array; the cast is
                // the wrapper-schema → engine-input mapping, nothing more.
                input.entries = raw[batchKey] as RecordsParameters['entries'];
                delete input[batchKey];
            }

            return input;
        }

        // The action design: `{ action, id?, ...fields, offset?, limit?, expects? }`.
        const label = wrapper.tool;
        const ACTIONS: readonly RecordAction[] = ['add', 'list', 'get', 'update', 'remove'];

        if (typeof raw.action !== 'string' || !ACTIONS.includes(raw.action as RecordAction)) {
            throw recordError(
                RECORD_ERROR_CODES.invalidInput,
                `${label} requires "action" to be one of: ${ACTIONS.join(', ')}.`
            );
        }

        const action = raw.action as RecordAction;
        const input: RecordsParameters & Record<string, unknown> = {
            // Carried on the mapped input so the response reshape knows which domain
            // shape to produce. The engine reads only its own keys and ignores this one.
            action
        };

        // The mutable fields this collection has, i.e. everything except `id`.
        const fieldKeys = definition.fields.map((field) => field.key);
        const patch: Record<string, unknown> = {};

        for (const key of fieldKeys) {
            if (raw[key] !== undefined) patch[key] = raw[key];
        }

        // Pagination and CAS pass through unchanged: a wrapper is not allowed to be
        // stricter about the ENGINE's controls, only about its own field caps (R6).
        if (raw.offset !== undefined) input.offset = raw.offset as number;
        if (raw.limit !== undefined) input.limit = raw.limit as number;
        if (raw.afterId !== undefined) input.afterId = raw.afterId as string;
        if (raw.since !== undefined) input.since = raw.since as number;
        // R7/T7.1 — `where` is one of the engine's list-read controls, so every wrapper
        // that can page must forward it. A `list` call returns right below, which is why
        // this sits with the other read controls rather than with the patch fields.
        if (raw.where !== undefined) input.where = raw.where as Record<string, string | number | boolean>;
        if (raw.expects !== undefined) input.expects = raw.expects as RecordExpect[];
        if (raw.mergeDisjoint !== undefined) {
            input.mergeDisjoint = raw.mergeDisjoint as boolean;
        }

        if (action === 'list') return input;

        // 'add' creates: there is no id to read yet (and demanding one is what made
        // every wrapper add fail). Every other action names a record, so its id is
        // read and validated with the same rules the engine uses elsewhere.
        if (action === 'add') {
            input.entries = [patch];

            return input;
        }

        const id = readId(label, raw.id, '"id"');

        if (action === 'get') {
            input.ids = [id];

            return input;
        }

        if (action === 'remove') {
            input.remove = [id];

            return input;
        }

        // `update`: a patch with no field is an error the old stores also raised, so
        // the wrapper's own contract is intact.
        if (Object.keys(patch).length === 0) {
            throw recordError(
                RECORD_ERROR_CODES.invalidField,
                `${label} "update" requires at least one of: ${fieldKeys.join(', ')}.`
            );
        }

        input.entries = [{ id, ...patch }];

        return input;
    };

    // Reshapes the engine envelope into the wrapper's domain contract (Decision D
    // inside, the historical shape outside).
    const toWrapperResult = (
        definition: RecordCollectionDefinition,
        input: RecordsParameters & Record<string, unknown>,
        result: RecordsResult
    ): RecordsResult | Record<string, unknown> => {
        const wrapper = definition.wrapper;

        if (wrapper === undefined) return result;

        if (wrapper.style === 'batch') {
            // `tasks` keeps its own contract exactly: the page under the collection's
            // plural key, plus the counts, cursor, revision and (on `since`) the feed.
            //
            // R1/T1.1 — the engine answers a single-id read (`records.ts:2252-2259`) and
            // a single-record mutation (`records.ts:2392-2402`) with `entry`, having
            // DELETED `entries`. This branch used to read only `entries`, so `?? []`
            // turned a found record into an empty list and the record itself was
            // dropped: `tasks {"ids":[<id>]}` answered `{"tasks":[]}` while promising
            // "entry" (tasks.tool.ts:70). Carrying `entry` through closes the contract
            // without touching anything else in the shape — the empty plural stays for
            // an actually-empty page, because the engine deletes `entries` ONLY for a
            // one-id answer.
            //
            // T1.1 EXTENSION — `removed`, the same defect class as `entry` above. The
            // engine answers ANY call that deleted at least one record with
            // `result.removed`, an ARRAY of full copies of the records it deleted
            // (`records.ts:2804-2813` + `:2853`), and this branch used to drop it the
            // way it dropped `entry`: `tasks {"remove":["1"]}` answered only the
            // survivor page, so the caller could not see WHICH record body it had just
            // deleted (rev, attribution and text included).
            //
            // It is surfaced SINGULAR, mirroring `entry`, and only when exactly ONE
            // record was removed:
            //   - `entry` follows the same one-record rule (`affected.length === 1` at
            //     `records.ts:2857`), so a multi-record batch keeps the historical
            //     page-only shape and every existing pin stays exact;
            //   - the sibling action-wrapper branch already answers `removed` as ONE
            //     record — `removed: (result.removed ?? [])[0]` below at `:3253` — so
            //     the two wrapper styles now agree about what `removed` MEANS;
            //   - a caller that removes several records still gets the full array from
            //     the engine surface (`records` with no wrapper returns `result`
            //     verbatim, `:3183`), where `removed?: RecordEntry[]` is declared.
            const shaped: Record<string, unknown> = {
                [wrapper.plural]: result.entries ?? [],
                counts: result.counts,
                page: result.page,
                storeRev: result.storeRev,
                ...(result.entry === undefined ? {} : { entry: result.entry }),
                ...(result.removed?.length === 1 ? { removed: result.removed[0] } : {}),
                // M3 — a removal of TWO OR MORE records used to answer with nothing that
                // named what it deleted: `removed` is singular-only by the rule above, so
                // `tasks {"remove":[5 ids]}` returned only a survivor page and the caller
                // had to re-read the list to confirm its own write landed. The bodies stay
                // withheld (the documented trade-off just above: the un-wrapped `records`
                // surface answers with the full array), but the IDS cost ~20 bytes and
                // close the confirmation gap.
                //
                // A SEPARATE key, deliberately, rather than widening `removed` to
                // `TaskItem | TaskItem[]`: `removed` keeps one stable type (a single
                // record) and `removedIds` keeps another (an array), so a caller never has
                // to branch on count to read either. Emitted only when more than one record
                // went, because at exactly one `removed` already says everything.
                ...(result.removed && result.removed.length > 1
                    ? { removedIds: result.removed.map((entry) => entry.id) }
                    : {})
            };

            if (result.changes !== undefined) shaped.changes = result.changes;
            if (result.changesHasMore !== undefined) {
                shaped.changesHasMore = result.changesHasMore;
            }
            if (result.changesTruncated !== undefined) {
                shaped.changesTruncated = result.changesTruncated;
            }

            return shaped;
        }

        const action = (input.action ?? 'list') as RecordAction;

        // The action wrappers carry NO page on a mutation and NO storeRev: that is the
        // contract these three tools have always had, and Decision E's reshape is
        // allowed to keep it because the engine result underneath still has both.
        if (action === 'list') {
            return {
                [wrapper.plural]: result.entries ?? [],
                counts: result.counts,
                page: result.page
            };
        }

        if (action === 'remove') {
            return {
                removed: (result.removed ?? [])[0],
                counts: result.counts
            };
        }

        // `get` produced `entry` from a single-id read, which the engine returns IN
        // FULL (a `getOnly` body included); a one-record mutation produced `entry` as the
        // projection, so updating a chapter still costs no body. The engine already made
        // that choice — the reshape never re-reads.
        const entry = result.entry ?? (result.entries ?? [])[0];

        // The summary/body split is the ONE part of the action-wrapper contract a generic
        // engine cannot guess: `chapters` `get` returns `{ chapter, content, counts }`
        // (knowledge.md:971, and the tool's own description in its entry), i.e. every
        // `getOnly` field rides BESIDE the singular key, never inside it. So the body
        // leaves the entry here — the engine's full read stays untouched for `records`.
        const bodyFields = definition.fields.filter((field) => field.getOnly === true);

        if (action !== 'get' || entry === undefined || bodyFields.length === 0) {
            return { [wrapper.singular]: entry, counts: result.counts };
        }

        const summary: RecordEntry = { ...entry };
        const shaped: Record<string, unknown> = { [wrapper.singular]: summary, counts: result.counts };

        for (const field of bodyFields) {
            // A declared `getOnly` field the entry does not carry stays ABSENT rather
            // than becoming '' : an omitted chapter body is "no body", not "empty body".
            if (!(field.key in summary)) continue;

            shaped[field.key] = summary[field.key];
            delete summary[field.key];
        }

        return shaped;
    };

    // Executes one wrapper/engine call. `definition` is the collection it operates on
    // (undefined for `records`, which names its own collection in its input).
    //
    // This is the DISPATCH half; the notification half is the `runCall` wrapper below,
    // which is the only thing that knows where one call begins and ends.
    const dispatchCall = (
        definition: RecordCollectionDefinition | undefined,
        parameters: unknown,
        identity: CallerIdentity
    ): unknown => {
        if (definition === undefined) {
            // `records` itself: the collection comes from the argument, and an unknown
            // name throws BEFORE dispatch (Decision C) — never an empty list.
            const raw = isRecord(parameters) ? parameters : {};

            if (parameters !== undefined && parameters !== null && !isRecord(parameters)) {
                throw recordError(
                    RECORD_ERROR_CODES.invalidInput,
                    'records expects an object with a "collection" and the store operations.'
                );
            }

            // `define` creates a collection, so it arrives WITHOUT a `collection` to
            // operate on; checking it first is what keeps `records({ define })` from being
            // read as an unknown-collection typo.
            if (raw.define !== undefined) {
                return defineCollection(readDefineInput('records', raw.define));
            }

            // R6/T6.2 — a `records` call that names NO collection lists the defined
            // names instead of erroring, so discovery no longer has to trip
            // `unknown-collection` to find out what exists. Deliberately narrow:
            //   - `define` is handled above, so `records({ define })` is unchanged;
            //   - `{ drop: true }` with no collection still falls through to
            //     `findCollection`, keeping that refusal's exact wording;
            //   - an empty or whitespace `collection` is NOT absent, and still gets the
            //     exact `records requires a non-empty "collection" string` message.
            if (raw.collection === undefined && raw.drop === undefined) {
                return listCollections();
            }

            const state = findCollection(raw.collection);

            return executeCollection(state, raw, identity);
        }

        const wrapper = definition.wrapper;
        const input = toCollectionInput(definition, parameters);
        const state = collections.get(definition.name) as CollectionState;
        const result = executeCollection(
            state,
            input,
            identity,
            // A batch wrapper speaks `tasks`; the action wrappers speak flat fields,
            // which the engine assembled under `entries`.
            wrapper === undefined || wrapper.style !== 'batch' ? 'entries' : wrapper.plural
        );

        return toWrapperResult(definition, input, result);
    };

    // R2a — the ONE entry point every record call goes through (the five tools'
    // `execute` closures, and nothing else), wrapped so that a call's store effect is
    // announced exactly once, after it committed.
    //
    // THE RULES THIS ENFORCES:
    //   - a REJECTED call announces nothing: `dispatchCall` threw before the store moved
    //     (the engine's own invariant — validation runs ahead of the apply loops), and a
    //     `return` after the loops means the write is real;
    //   - a READ announces nothing: the capture stays empty, because `pushChange` is
    //     reached only by the apply loops (`plan.mutates`);
    //   - one call = one notification, whatever it touched; the affected collection names
    //     are derived from the feed entries in first-seen order, so a call that patched
    //     and removed in one breath lists one collection;
    //   - `define`/`drop`/`reset`/`restore` notify from their own sites (they append no
    //     record event), and the wrapper stays quiet for them because their capture is
    //     empty — never a double frame.
    const runCall = (
        definition: RecordCollectionDefinition | undefined,
        parameters: unknown,
        identity: CallerIdentity
    ): unknown => {
        const capture: RecordStoreChange[] = [];

        feedCapture = capture;

        try {
            const result = dispatchCall(definition, parameters, identity);

            if (capture.length > 0) {
                const affected: string[] = [];

                for (const change of capture) {
                    if (!affected.includes(change.collection)) affected.push(change.collection);
                }

                notifyStore('mutate', affected, capture);
            }

            return result;
        } finally {
            feedCapture = undefined;
        }
    };

    // Builds one tool per served name. The metadata (description, tags, visibility,
    // schema) comes from ./metadata.ts, i.e. from the source entries themselves, so a
    // runtime registration and the catalogue projection can never disagree.
    const buildTool = (
        metadata: typeof RECORDS_METADATA,
        definition: RecordCollectionDefinition | undefined
    ): Tool =>
        tool({
            name: metadata.name,
            description: metadata.description,
            tags: metadata.tags,
            visibility: metadata.visibility,
            parameters: metadata.parameters,
            execute: (context: ToolContext) =>
                runCall(
                    definition,
                    // The single-property rule in ./tool.ts hands a multi-property
                    // schema the whole arguments object; `records` and every wrapper
                    // declare several, so this is the record. A no-argument call arrives
                    // as undefined and is the documented READ.
                    context.parameters,
                    {
                        // Identity is read from the context and NEVER from arguments, so
                        // the model cannot forge who edited what (task's rule, kept).
                        ...(context.agent?.name === undefined
                            ? {}
                            : { by: context.agent.name }),
                        ...(context.threadId === undefined
                            ? {}
                            : { threadId: context.threadId })
                    }
                )
        });

    const tasksDefinition = collections.get('tasks')?.definition as RecordCollectionDefinition;

    const tools = {
        [RECORDS_NAME]: buildTool(RECORDS_METADATA, undefined),
        [TASKS_NAME]: buildTool(TASKS_METADATA, tasksDefinition),
        [CHAPTERS_NAME]: buildTool(CHAPTERS_METADATA, collections.get('chapters')
            ?.definition as RecordCollectionDefinition),
        [PROFILES_NAME]: buildTool(PROFILES_METADATA, collections.get('profiles')
            ?.definition as RecordCollectionDefinition),
        [LOCATIONS_NAME]: buildTool(LOCATIONS_METADATA, collections.get('locations')
            ?.definition as RecordCollectionDefinition)
    } as Record<RecordsToolName, Tool>;

    // The routed surface. A lane replica's `harness.runtime.executeRecords` is
    // intercepted and answered by the authority (../server/workers/lane-authority.ts),
    // which fabricates the context — so this is the ONLY way a record tool body writes,
    // and it is mechanically checked: forgetting the registration makes the worker's
    // classification loop throw at startup instead of losing the write silently (F5).
    const executeRecords = async (name: RecordsToolName, context: ToolContext): Promise<unknown> => {
        const implementation = tools[name as RecordsToolName];

        if (implementation === undefined) {
            throw recordError(
                RECORD_ERROR_CODES.unknownCollection,
                `records has no tool "${String(name)}"; the record tools are ${RECORDS_TOOL_LIST}.`
            );
        }

        return implementation.execute(context);
    };

    return {
        executeRecords,
        tools,
        collections: () => [...collections.keys()],

        // -------------------------------------------------------------------
        // R2a — the observation plane. Reads are detached copies (the same rule every
        // result envelope follows: handing out a live entry would let a UI's scratch
        // buffer mutate session state); the subscription is one Set with a closure
        // unsubscribe, and a host with no listener pays nothing at all.
        // -------------------------------------------------------------------
        onStoreChange: (listener: (notification: RecordStoreNotification) => void): (() => void) => {
            storeListeners.add(listener);

            return () => {
                storeListeners.delete(listener);
            };
        },

        view: (): RecordStoreView => {
            const listed: RecordStoreCollection[] = [];

            for (const [, state] of collections) {
                listed.push({
                    name: state.definition.name,
                    // The CLONED spec: `definition` is the engine's own object and a
                    // shared reference would let a host rewrite a live collection's
                    // field set through the read.
                    fields: cloneDefinition(state.definition).fields,
                    storeRev: state.storeRev,
                    count: state.items.length,
                    // Projected like a list page (`getOnly` bodies excluded), because
                    // this is a list read; one body is one `records get` away.
                    entries: state.items.map((item) => copyEntry(state.definition, item))
                });
            }

            return {
                storeRev,
                collectionsRev,
                collections: listed,
                changes: storeFeed.map((change) => ({ ...change }))
            };
        },

        changesSince: (since: number): RecordStoreDelta => {
            const changes = storeFeed.filter((change) => change.seq > since).map((change) => ({ ...change }));

            // THE RESET RULE, in the three cases that exist:
            //   - `since > storeRev`: the store rewound under this watermark (a `reset()`
            //     to 0), so the caller is holding a revision the store never had;
            //   - `since === storeRev`: current, nothing to apply, NOT a reset;
            //   - `since < storeRev` with an empty window, or a window whose oldest event
            //     is above `since + 1`: the gap is real (trimmed, or a restore/restart that
            //     cleared the feed), and an honest reader says so instead of answering a
            //     delta that quietly skipped events.
            const reset =
                since > storeRev ||
                (since < storeRev && (storeFeed.length === 0 || (storeFeed[0] as RecordStoreChange).seq > since + 1));

            return { storeRev, collectionsRev, changes, reset };
        },

        // "Start over": every collection's records, both counters and every change
        // window. A reset is a clean start, so the next session-shaped conversation
        // sees the same ids AND the same storeRev 0 a new harness would. `define`d
        // collections go with it — they are session state, not configuration.
        reset: () => {
            collections.clear();

            // R3: a reset rewinds EVERYTHING, by design — including the epoch bookkeeping
            // this defect added. Stop-condition 4: `reset()` is not a drop + re-`define`,
            // it is the declared clean start, so the old rewinds-to-0 behaviour stays and
            // the high-water marks must go with it (otherwise a reset would refuse a
            // `since: 0` that is genuinely correct again).
            storeRevHighWater.clear();
            epochFloors.clear();

            for (const definition of BUILTIN_RECORD_COLLECTIONS) {
                collections.set(definition.name, freshState(definition));
                seedHighWater(definition.name, 0);
            }

            nextId = 1;

            // R2a — a reset rewinds the store-wide feed with everything else: the client
            // rule is "`storeRev` below my watermark means the epoch moved", so a reset
            // has to come back as 0, and the retained window is emptied because none of
            // those events describe the store that exists now.
            storeRev = 0;
            storeFeed.length = 0;
            collectionsRev += 1;
            notifyStore('reset', [], []);
        },

        // Copy out, so a snapshot never aliases live state. The DEFINITION rides along
        // with each collection (Decision M): a collection an agent defined mid-session
        // must be rediscoverable after a restart, and its caps are part of the data.
        snapshot: (): RecordsStoreState => {
            const section: Record<string, CollectionState> = {};

            for (const [name, state] of collections) {
                section[name] = {
                    definition: state.definition,
                    items: state.items.map((item) =>
                        // A snapshot carries EVERY declared field, `getOnly` included: a
                        // resumed session must not lose chapter bodies.
                        copyEntry(state.definition, item, true)
                    ),
                    storeRev: state.storeRev,
                    changes: state.changes.map(copyChange)
                };
            }

            return { nextId, collections: section };
        },

        // Validate into copies first, then replace the closure state in one step, so a
        // rejected restore leaves the live store exactly as it was.
        restore: (state: unknown): void => {
            const restored = readRecordsStoreState(state);

            collections.clear();

            // R3: the high-water marks are runtime-only, so a restore REBUILDS what it
            // can from the restored revisions (keep-or-raise, never lower) rather than
            // trusting that the live map happens to agree. The epoch FLOORS do go: a
            // restored change log is the persisted one, so every `since` at or below its
            // own revisions is answerable and nothing should be refused as
            // pre-epoch. A name that is re-`define`d after a restore still gets the
            // monotonic start, because the marks above survived.
            epochFloors.clear();

            for (const [name, restoredState] of Object.entries(restored.collections)) {
                collections.set(name, restoredState);
                seedHighWater(name, restoredState.storeRev);
            }

            nextId = restored.nextId;

            // R2a — a restore is a wholesale replacement, so the retained feed cannot
            // describe the store that exists now: it is emptied, and the store-wide
            // watermark is raised to the highest revision the restored collections
            // actually reached (a persisted watermark must never read as "behind" its own
            // log, the same invariant Decision B's window keeps per collection).
            //
            // A client therefore gets `reset: true` from any `since` other than that
            // figure, and `collectionsRev` moved as well, so the bootstrap rule
            // ("re-read when `reset` or when `collectionsRev` moved") fires on every
            // restart path — including a restore of an empty store, where the watermark
            // happens to stay 0.
            storeRev = 0;

            for (const restoredState of Object.values(restored.collections)) {
                if (restoredState.storeRev > storeRev) storeRev = restoredState.storeRev;
            }

            storeFeed.length = 0;
            collectionsRev += 1;
            notifyStore('restore', [], []);
        }
    };
};

// The record tool names, quoted in the one refusal a host can hit by passing a name
// that is not a record tool. Derived from ../types so the list cannot drift.
const RECORDS_TOOL_LIST = (
    [
        'records',
        ...BUILTIN_WRAPPER_TOOLS
    ] as string[]
).join(', ');

// The five tools the engine serves, in registration order — exported so the harness
// and the capability scan cross-check the same list instead of restating it.
export const RECORD_ENGINE_TOOL_NAMES: readonly RecordsToolName[] = [
    'records',
    ...BUILTIN_WRAPPER_TOOLS
] as readonly RecordsToolName[];

// Total classifier for the engine's rejections (Decision O): a wrapper switches on
// the CODE, never the prose, and must not become a new crash path when the thrown
// value is hostile (`isInstanceOf` exists for exactly that reason).
export const isRecordRejection = (error: unknown): error is HarnessError & { code: RecordErrorCode } =>
    isInstanceOf(error, HarnessError) &&
    typeof error.code === 'string' &&
    (Object.values(RECORD_ERROR_CODES) as string[]).includes(error.code);

// A wrapper's translation (Decision O): the same code, its own vocabulary, and the
// escalation path named — so an agent that has never discovered `records` can still
// find it. The engine's payload (R9's current entry) rides along untouched, because
// flattening it to a sentence would put the two round trips back.
export const translateRecordRejection = (
    error: unknown,
    wrapperLabel: string,
    message: string
): HarnessError => {
    if (!isRecordRejection(error)) {
        // Not the engine's: rethrow the original rather than laundering an unknown
        // failure into a record error with a guessed code.
        return isInstanceOf(error, HarnessError)
            ? error
            : new HarnessError(`${wrapperLabel} failed: ${String(
                  isInstanceOf(error, Error) ? error.message : error
              )}`);
    }

    const code = error.code as RecordErrorCode;
    const details = error.details;

    return new HarnessError(`${code}: ${message}`, {
        code,
        ...(details === undefined ? {} : { details })
    });
};
