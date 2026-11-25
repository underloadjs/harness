// toolManage — canonical `*.tool.ts` management entry.
//
// All mutation (create/update/reload) is delegated to the harness runtime, which
// calls the SAME acceptTool/prepareToolCandidate kernel as toolCreate and
// toolRegistry. This module owns only the model-facing contract; it never writes a
// file or publishes a definition itself.
import type { CoreToolMetadata } from '../../core';
import { modelPayloadBytes } from '../../core';
import type { HarnessToolManageParameters, ToolContext } from '../../types';

// Active management surface: inspect source/path, create/update folder entries,
// and reload an installed revision. All mutation still goes through the same
// acceptTool kernel as toolCreate/toolRegistry.
export const TOOL_MANAGE_NAME = 'toolManage';

// ---------------------------------------------------------------------------
// The `list` page (defect F2, 2026-11-25)
// ---------------------------------------------------------------------------
//
// `operation: "list"` used to answer with EVERY row of `toolDetailsFor`
// (../../harness.ts:3263, reached from the un-paged list at :3567), and a details row
// carries the tool's whole `parameters` JSON Schema on top of its description. Measured
// on this repo's real registry as it stood at F2 (26 rows): the payload serialized at
// 131,925 payload bytes — 134,218 once the paging wording below is in the rows it lists —
// i.e. rows averaging 5,162 bytes, against MODEL_TOOL_RESULT_BUDGET_BYTES = 32,768
// (../../core/result-budget.ts:231) — so `boundToolResult`'s JSON rule
// (../../core/result-budget.ts:557-578) discarded the whole answer
// (`rejected: oversized-json`, :576). It was strictly larger than the un-paged `toolList`
// it was proposed as a workaround for, which is why it needs the same treatment. The
// shipped catalogue is 33 entries today: the same measurement now gives rows averaging
// 4,668 payload bytes and a largest row of 21,986 (`records`, whose `parameters` schema is
// 14,933 of that) — two thirds of THIS page budget in a single row, which is why the
// loop below can stop at one row and the five-row default is a budget decision, not a
// courtesy.
//
// Only `list` pages. `details`/`source`/`path` answer about ONE tool and the
// mutations return their own receipts, so paging them would move a shape a caller
// already parses for no benefit. `offset`/`limit` are therefore accepted by the
// schema (otherwise `additionalProperties: false` rejects a `{operation:"list",
// limit:5}` call) and applied to `list` only.
//
// SAME LITERAL DISCIPLINE as ./toolList.tool.ts's `TOOL_LIST_*` constants: the budget is a module-local
// number strictly under the 32,768-byte delivery cap (the 24 KiB margin
// ../core/knowledge.ts:211 keeps), and the schema below states the bounds as literals
// because the manifest generator reads this file through the TypeScript AST
// (../../scripts/generate-tool-manifest.ts → ../core/tool-scan.ts), it never
// evaluates an identifier.
export const TOOL_MANAGE_LIST_DEFAULT_LIMIT = 5;
export const TOOL_MANAGE_LIST_MAX_LIMIT = 100;
export const TOOL_MANAGE_LIST_PAGE_BUDGET_BYTES = 24 * 1024;

// The page envelope, identical in shape to ./toolList.tool.ts's and to
// ../core/records.ts:3525-3541: `offset` is the index this page ACTUALLY starts at
// (the requested cursor, clamped to the registry length when it points past the end),
// `limit` echoes the (clamped) page size, `hasMore` counts against the FULL registry,
// `nextOffset` is where to resume, and `budgetTruncated` appears only when the byte
// cap ended the page rather than `limit`.
export type ToolManageListPage = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
    budgetTruncated?: boolean;
};

export type ToolManageListResult = { tools: Record<string, unknown>[]; page: ToolManageListPage };

// Management/inspection. Read operations (list/details/source/path) are always
// available. Mutations (create/update/reload) compile through the same kernel as
// toolCreate/toolRegistry: a candidate is prepared before publication, so a
// failed edit leaves the previous registration untouched.
//
// Persistence default (T13/T12 cross-contract): `create` and `update` PERSIST by
// default. A create without `path` derives a safe `<name>.tool.ts` filename in the
// LAST configured toolFolders entry; an update without `path` rewrites the tool's
// owning source path. `persist: "runtime"` is the explicit opt-out: it keeps the
// candidate in the registry only and cannot be combined with `path`/`folder`. The
// schema below is the model-facing contract the runtime implements (harness.ts
// `persistentTargetFor` / `persistAndRegister`); keep the default and the enum in
// step with that lifecycle.
export const TOOL_MANAGE_METADATA: CoreToolMetadata = {
    name: TOOL_MANAGE_NAME,
    description:
        'Inspect and edit registered tools. `list` returns registry metadata a PAGE at a time - at most `limit` rows (default 5, 1-100) starting at `offset` (default 0), and each page is byte-budgeted, so it can be shorter than `limit`: `page.hasMore` and `page.nextOffset` say where to resume and `page.budgetTruncated: true` says the byte cap rather than `limit` ended it - one call never returns the whole registry, because a details row carries the tool\'s full `parameters` schema. `details` inspects one tool, `source` returns its captured module text and local dependencies, `path` resolves a tool source path or a candidate path inside the configured toolFolders, `create` and `update` register a module and, by default, persist it: `create` writes a safe `<name>.tool.ts` filename in the LAST configured toolFolders entry, and `update` rewrites the tool\'s owning source path (an explicit `path` overrides either). Set `persist: "runtime"` to opt out of disk writes explicitly; that mode keeps the module in this session\'s registry only and cannot be combined with `path` or `folder`. `reload` recompiles the installed source revision. Every mutation is validated and published atomically through the same kernel as toolCreate/toolRegistry; a failed compile leaves the previous tool registered. Loaded tool code runs with this process\'s full permissions - there is no sandbox.',
    tags: ['tools', 'manage', 'source', 'edit', 'reload'],
    // R9-R11 demand discovery: searchable, so the model finds it through toolRequest
    // and enables it for this session instead of seeing it declared on every request.
    // Registration itself is unchanged (the entry still joins the harness registry),
    // so toolRequest always has something to surface.
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            operation: {
                type: 'string',
                enum: ['list', 'details', 'source', 'path', 'create', 'update', 'reload'],
                description: 'What to do.'
            },
            name: {
                type: 'string',
                description: 'Registered tool name (details/source/path/reload, optional expected name on create/update).'
            },
            path: {
                type: 'string',
                description:
                    'Explicit *.tool.ts file path, absolute or relative to `folder`. Overrides the default create filename or the update owning path; not allowed with persist "runtime".'
            },
            folder: {
                type: 'string',
                description:
                    'Configured toolFolders entry that a relative `path` resolves against; requires `path`. A pathless create targets the LAST configured entry.'
            },
            persist: {
                type: 'string',
                enum: ['folder', 'runtime'],
                default: 'folder',
                description:
                    'Where create/update persist the module. "folder" (default) writes it to disk: a safe `<name>.tool.ts` in the last configured toolFolders entry for create, or the owning source path for update. "runtime" explicitly keeps it in this session\'s registry only and cannot be combined with `path` or `folder`.'
            },
            moduleText: {
                type: 'string',
                description: 'Full TypeScript/JavaScript module text for create/update/reload when not reading a path.'
            },
            source: {
                type: 'string',
                description: 'Legacy async function-body form for create/update (mutually exclusive with moduleText).'
            },
            description: {
                type: 'string',
                description: 'Optional metadata override installed with the candidate.'
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tag override installed with the candidate.'
            },
            parameters: {
                type: 'object',
                description: 'Optional JSON Schema override installed with the candidate.'
            },
            visibility: {
                type: 'string',
                enum: ['core', 'searchable'],
                description: 'Optional visibility override for the installed candidate.'
            },
            dependencies: {
                type: 'array',
                description:
                    'Optional captured local helper modules for moduleText: [{ path, text }].',
                items: {
                    type: 'object',
                    properties: {
                        path: { type: 'string' },
                        text: { type: 'string' }
                    },
                    required: ['path', 'text'],
                    additionalProperties: false
                }
            },
            // Paging for `operation: "list"` ONLY (see the header above). They are
            // declared, not merely tolerated, because `additionalProperties: false`
            // means an undeclared `limit` is a schema error rather than an ignored key.
            offset: {
                type: 'integer',
                minimum: 0,
                description:
                    'Zero-based row of the `list` page to start from (default 0). Pass `page.nextOffset` back for the next page; ignored by every other operation.'
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                description:
                    'Rows in the `list` page, 1-100 (default 5). Each details row carries the tool\'s full schema, so a page is also byte-budgeted and can carry fewer rows: `page.budgetTruncated` says when it did. Ignored by every other operation.'
            }
        },
        required: ['operation'],
        additionalProperties: false
    }
};

export const metadata = TOOL_MANAGE_METADATA;
// Harness registration policy (T19 / R9). A SEPARATE literal from `metadata`:
// these fields are harness bookkeeping, not part of the Tool wire contract, so
// they never reach the schema a model sees. `../../core/tool-discovery.ts` READS
// this literal through the TypeScript AST (it never executes the module), so the
// activation/order/flags here are what actually drive registration.
export const registration = {
    group: 'runtime',
    activation: 'always',
    order: 40,
    sessionBound: true,
    alwaysDeclared: false,
    listed: true
} as const;

// Same clamping contract as ./toolList.tool.ts's `pageCursorOf`: the schema gates the
// model path (../core/schema-validation.ts enforces `integer`, `minimum`, `maximum`),
// so this is the direct-caller path — a host calling with `offset: -5` or
// `limit: 5000` gets the nearest legal page instead of a negative slice, and a
// non-number falls back to the default rather than to `NaN` (which would poison
// `nextOffset` and stall a paging loop).
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
        throw new Error('toolManage requires the live harness reference.');
    }

    // The runtime stays the richer host surface it always was (`enable`/`disable`/
    // `remove` are operator-only operations ../harness.ts:3510-3525 answers, and the
    // lane RPC calls `manageTool` directly, ../../server/workers/lane-authority.ts).
    // The raw parameters go through UNchanged, including `offset`/`limit`: the runtime
    // `list` branch reads `operation` only, so the paging keys are inert there, and
    // the page is cut below, in the model-facing layer.
    const values = context.parameters ?? { operation: 'list' };
    const parameters = values as HarnessToolManageParameters;
    const result = harness.runtime.manageTool(context.agent, parameters);

    // Everything except `list` keeps its existing shape exactly: `details`, `source`,
    // `path`, `create`, `update`, `reload` and the operator operations are untouched,
    // and a runtime refusal (anything that is not the `{ tools: [...] }` envelope) is
    // forwarded as-is rather than paged.
    if (parameters.operation !== 'list') return result;

    const listed = result as { tools?: unknown };

    if (listed === null || typeof listed !== 'object' || !Array.isArray(listed.tools)) return result;

    const rows0 = listed.tools as Record<string, unknown>[];
    const limit = pageCursorOf(
        values.limit,
        TOOL_MANAGE_LIST_DEFAULT_LIMIT,
        1,
        TOOL_MANAGE_LIST_MAX_LIMIT
    );
    const offset = pageCursorOf(values.offset, 0, 0, rows0.length);

    let rows = rows0.slice(offset, offset + limit);
    let budgetTruncated = false;

    // Re-assembled from the live `rows` on every attempt, so the envelope can never
    // disagree with the array it ships (the `assemble` pattern in
    // ../core/knowledge.ts:1762-1789). `hasMore` counts against the FULL registry, and
    // `nextOffset` is the index after the last row actually carried — after a budget
    // cut that is not `offset + limit`, and inventing `offset + limit` here is the
    // mistake that silently skips rows.
    const assemble = (): ToolManageListResult => {
        const consumed = offset + rows.length;
        const hasMore = consumed < rows0.length;
        const page: ToolManageListPage = { offset, limit, hasMore };

        if (hasMore) page.nextOffset = consumed;
        if (budgetTruncated) page.budgetTruncated = true;

        return { tools: rows, page };
    };

    let paged = assemble();

    // Drop WHOLE trailing rows, never a mid-document cut: ../core/result-budget.ts:559-578
    // refuses a JSON document it cannot fit rather than truncating it, so a page that
    // crossed the cap would be discarded and the model would get a refusal with no
    // cursor. Measured in `modelPayloadBytes` — the escaped bytes the provider bills
    // and the number `boundToolResult` gates on (../core/result-budget.ts:557).
    //
    // `rows.length > 1` keeps the first row of a non-empty page so `nextOffset` always
    // advances. Measured on the shipped 33-entry catalogue, one details row averages 4,668
    // payload bytes and the largest is 21,986 (`records`), so a page can legitimately stop at
    // ONE row inside this 24 KiB budget — and a page of one is still a page a caller can page
    // FROM (../core/records.ts:615, `fitRowsToBudget` admits its first row at :627 — same rule).
    while (rows.length > 1 && modelPayloadBytes(JSON.stringify(paged)) > TOOL_MANAGE_LIST_PAGE_BUDGET_BYTES) {
        rows = rows.slice(0, -1);
        budgetTruncated = true;
        paged = assemble();
    }

    return paged;
};
