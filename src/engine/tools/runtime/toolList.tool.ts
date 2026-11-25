// toolList — canonical `*.tool.ts` inventory entry.
//
// This module is deliberately tiny and self-contained in the required convention:
// `metadata` carries name/description/tags/schema and `execute` delegates to the
// live harness runtime. The harness owns registry state; replacing this file
// replaces only the model-facing shape, never the inventory operation.
import type { CoreToolMetadata } from '../../core';
import { modelPayloadBytes } from '../../core';
import type { HarnessToolListEntry } from '../../types';
import type { ToolContext } from '../../types';

// Inventory of every live registry entry (name + description only). Distinct from
// toolRequest: listing must never imply a tool is enabled or callable.
export const TOOL_LIST_NAME = 'toolList';

// ---------------------------------------------------------------------------
// Paging bounds and the producer-side byte budget (defect F2, 2026-11-25)
// ---------------------------------------------------------------------------
//
// WHY PAGING LIVES HERE, IN THE TOOL
// ----------------------------------
// `harness.runtime.listTools()` is a published type (../types/index.ts:1443, mirrored
// in packages/loadscript/harness/src/types/index.ts:1416) AND an RPC-routed lane
// capability (../../server/workers/capability.ts:418-435, lane-authority.ts:154,
// 891-892), and the server's own tool pane reads it (../../server/api-reads.ts:1356,
// 1363). It stays parameterless and whole. What has to fit the model's delivery cap
// is the MODEL RESULT, so the page is cut here, in the model-facing layer.
//
// THE NUMBER THAT MADE THIS NECESSARY (measured on this repo's real registry, 26
// rows, presets on): at HEAD the bare array serialized at 60,851 payload bytes — it is
// 61,819 once the paging wording below is in the rows it lists — against
// MODEL_TOOL_RESULT_BUDGET_BYTES = 32,768 (../core/result-budget.ts:231).
// `boundToolResult`'s JSON rule (../core/result-budget.ts:557-578) DISCARDS a JSON
// document it cannot fit — the whole inventory, `rejected: oversized-json`, not a
// trimmed page — and the refusal told the caller to re-run "with narrower arguments
// (smaller limit, fewer ids, narrower fields)", advice this tool's schema used to
// reject outright (`additionalProperties: false`, no properties).
//
// THE LOAD-BEARING RELATIONSHIP (repo doctrine, ../core/records.ts:146-152 and
// ../core/result-budget.ts:66-70): the page budget stays STRICTLY UNDER the delivery
// cap, because an inner page that claims `hasMore: false` while the outer envelope
// truncates it is a lie the model cannot detect. 24 KiB is 8 KiB under 32,768, the
// same margin ../core/knowledge.ts:211 keeps (`KNOWLEDGE_RESPONSE_BUDGET_BYTES`), and
// the reason is the same: the headroom absorbs the `page` envelope and any wrapper a
// caller adds, so a page reporting `budgetTruncated: false` always survives delivery
// byte for byte.
//
// A LITERAL, NOT AN IMPORT: ../core/knowledge.ts:204-211 keeps its budget literal
// local for the same reason, and the schema below states these numbers as literals
// because the manifest generator reads this file through the TypeScript AST
// (../../scripts/generate-tool-manifest.ts → ../core/tool-scan.ts) and never
// evaluates an imported identifier. The paired assertions in
// ./harness.tool-list.test.ts pin the schema numbers against these constants, so the
// two cannot drift silently.
export const TOOL_LIST_DEFAULT_LIMIT = 10;
export const TOOL_LIST_MAX_LIMIT = 100;
export const TOOL_LIST_PAGE_BUDGET_BYTES = 24 * 1024;

// The two projections the `fields` enum offers. `name` alone is the cheap full roster:
// this repo's whole 26-row registry measures 681 payload bytes names-only (at
// `limit: 100`), i.e. the entire inventory fits one page without the byte budget
// engaging at all, while the SAME rows cost 24,496 bytes with descriptions — which is
// why `fields` is the knob the byte budget tells the caller to narrow, not `limit`.
export type ToolListFields = 'name' | 'name+description';

// One row. `description` is present only in the default projection, so a
// `fields: "name"` page contains no empty strings to skip over.
export type ToolListRow = { name: string; description?: string };

// The page envelope, modelled on ../core/records.ts:3152-3177 and
// ../core/knowledge.ts:1762-1789: `offset` is the index this page ACTUALLY starts at
// (equal to the requested cursor, except when the request points past the end of the
// registry, where it is clamped to the registry length so an empty page reports where
// it would have started), `limit` echoes the (clamped) page size, `hasMore` is
// computed against the FULL registry length, `nextOffset` is the index to ask for
// next, and `budgetTruncated` appears only when the byte cap — not `limit` — ended
// the page.
export type ToolListPage = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
    budgetTruncated?: boolean;
};

export type ToolListResult = { tools: ToolListRow[]; page: ToolListPage };

// Full inventory, paged. Deliberately returns ONLY name (+ description) for every
// live registry entry, enabled or not; a model that needs tags/schema/source uses
// toolRequest or toolManage.
export const TOOL_LIST_METADATA: CoreToolMetadata = {
    name: TOOL_LIST_NAME,
    // WORDING IS PART OF THE CONTRACT, in two directions. (1) It is the only place a
    // model learns the page size, the cursor semantics and `fields`, so they are stated
    // literally. (2) The discovery scorer counts a description SUBSTRING as a 1-point
    // match (../core/discovery.ts:128-140, `MIN_FUZZY_LENGTH` 3), so a careless word
    // here makes this row answer somebody else's capability tag: a draft that said
    // "a page at a time" turned `toolRequest {tags:["time"]}` into a hit on `toolList`
    // and moved the recorded enabled set in ../../server/api.test.ts:2807. After any
    // reword, audit this sentence against the tag vocabulary in
    // ../core/tool-manifest.ts: the set of vocabulary tags it contains must stay a
    // SUBSET of the one HEAD's sentence had (this row's own tags plus
    // edit/manage/search/source/tool), because every extra one is a query this row now
    // answers without being asked.
    description:
        'List every registered tool by name and description, whether or not toolRequest has enabled it — this is the inventory, and listing never means a tool is callable. One call never covers the whole inventory: `tools` carries at most `limit` rows (default 10, 1-100) starting at `offset` (default 0) in registration order, and each page is also byte-budgeted, so it can be shorter than `limit` - `page.hasMore` and `page.nextOffset` say exactly where to continue, and `page.budgetTruncated: true` says the byte cap rather than `limit` ended it. `fields: "name"` drops the descriptions, so a page is hundreds of bytes rather than tens of kilobytes - request it with a large `limit` to see every name in one page. Use toolRequest to make searchable tools callable, and toolManage for tags, schema, source, or editing.',
    tags: ['tools', 'list', 'catalogue', 'inventory'],
    // R9-R11 demand discovery: searchable, so the model finds it through toolRequest
    // and enables it for this session instead of seeing it declared on every request.
    // Registration itself is unchanged (the entry still joins the harness registry),
    // so toolRequest always has something to surface.
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'Zero-based row to start from, in registration order. Defaults to 0. Pass `page.nextOffset` back to get the next page; an offset past the end answers with no rows and `hasMore: false`.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description:
                    'Rows per page, 1-100 (default 10). A page is also byte-budgeted, so it can carry fewer rows than this - `page.budgetTruncated` says when it did.'
            },
            fields: {
                type: 'string',
                enum: ['name', 'name+description'],
                default: 'name+description',
                description:
                    'What each row carries. "name+description" (default) is the usage contract and costs the most bytes; "name" is the whole roster at a fraction of the size.'
            }
        },
        required: [],
        additionalProperties: false
    }
};

export const metadata = TOOL_LIST_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 30,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

// A page cursor must never be able to stall a walk, so the accepted bounds are
// clamped rather than trusted. `executeTool`/the model path validate this schema
// first (../core/schema-validation.ts enforces `integer`, `minimum`, `maximum`, and
// `additionalProperties: false`), so this is the direct-caller path: a host calling
// with `offset: -5` or `limit: 5000` gets the nearest legal page instead of a
// negative slice or a multi-megabyte payload. A non-number (a string `"3"` from a
// hand-built payload that skipped validation) falls back to the default rather than
// to `NaN`, which would poison `nextOffset`.
const pageCursorOf = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;

    const integer = Math.floor(value);

    if (integer < minimum) return minimum;
    if (integer > maximum) return maximum;

    return integer;
};

export const execute = (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error('toolList requires the live harness reference.');
    }

    // The whole registry, in insertion order — the order the model sees the tools in,
    // which is what makes `offset`/`nextOffset` a stable cursor across calls (the
    // registry only changes when a tool is registered or removed, never because this
    // tool was called).
    const entries: HarnessToolListEntry[] = harness.runtime.listTools();

    // NOTE the single-property rule (../core/tool.ts:40-73): this schema declares
    // THREE properties, so `context.parameters` is the whole argument object, not one
    // unwrapped value. A bare `{}` is a legal call and means "default page".
    const parameters = (context.parameters ?? {}) as Record<string, unknown>;

    const wantsDescription = parameters.fields !== 'name';
    const limit = pageCursorOf(parameters.limit, TOOL_LIST_DEFAULT_LIMIT, 1, TOOL_LIST_MAX_LIMIT);
    // `offset` may legitimately point past the end (a caller paging to exhaustion
    // asks for one page too many); the answer is an empty page, `hasMore: false`, and
    // no `nextOffset`, so the walk terminates instead of looping.
    const offset = pageCursorOf(parameters.offset, 0, 0, entries.length);

    const projection = (entry: HarnessToolListEntry): ToolListRow =>
        wantsDescription ? { name: entry.name, description: entry.description } : { name: entry.name };

    let rows: ToolListRow[] = entries.slice(offset, offset + limit).map(projection);
    // Only ever set true, and only when the BYTE CAP stopped the page. A caller that
    // sees a short page has to know which bound bit: a `limit`-short page means
    // "raise `limit`", a budget-short page means "raise `limit` changes nothing,
    // narrow `fields`" (../core/records.ts:3185-3190 states the same split).
    let budgetTruncated = false;

    // The whole result is re-assembled from the live `rows` on every attempt, so the
    // envelope can never disagree with the array it ships (the `assemble` pattern in
    // ../core/knowledge.ts:1762-1789). `hasMore` is computed against the FULL registry
    // length, and `nextOffset` is the index AFTER the last row actually carried —
    // which after a budget cut is not `offset + limit`, the mistake that would skip
    // rows.
    const assemble = (): ToolListResult => {
        const consumed = offset + rows.length;
        const hasMore = consumed < entries.length;
        const page: ToolListPage = { offset, limit, hasMore };

        if (hasMore) page.nextOffset = consumed;
        if (budgetTruncated) page.budgetTruncated = true;

        return { tools: rows, page };
    };

    let result = assemble();

    // Drop WHOLE trailing rows until the serialized result fits. Never a mid-document
    // cut: ../core/result-budget.ts:559-578 refuses (does not truncate) anything that
    // parses as JSON, so a page that crossed the cap would be discarded outright and
    // the model would see a refusal with no cursor to resume from.
    //
    // The currency is `modelPayloadBytes(JSON.stringify(result))` — the ESCAPED bytes
    // the provider bills, the same number `boundToolResult` gates on
    // (../core/result-budget.ts:557) and the same one the read tool charges its own
    // window with (../tools/files/read.tool.ts:1638). UTF-8 text bytes would under-count it.
    //
    // `rows.length > 1` keeps the first row of a non-empty page: one row is only a
    // few KiB, so this cannot blow the delivery cap, and it guarantees `nextOffset`
    // always advances (../core/records.ts:3138-3140, same rule for the same reason).
    //
    // `TOOL_LIST_PAGE_BUDGET_BYTES` (24,576) sits 8,192 bytes under the 32,768-byte
    // cap, which is the headroom that makes "under my budget" imply "under the
    // delivery cap" for the result as a whole, envelope included.
    while (rows.length > 1 && modelPayloadBytes(JSON.stringify(result)) > TOOL_LIST_PAGE_BUDGET_BYTES) {
        rows = rows.slice(0, -1);
        budgetTruncated = true;
        result = assemble();
    }

    return result;
};
