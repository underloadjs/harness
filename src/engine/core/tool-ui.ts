// Declarative tool UI: the safe transport between a server-side tool and a client.
//
// WHY THIS EXISTS (R20.2)
// -----------------------
// A tool result is text for the model, but a client can render more than text. A
// tool may therefore return `toolUi(content, panels)`:
//
//     return toolUi({ iso, unix }, [
//         {
//             id: 'clock',
//             slot: 'right',
//             title: 'Current time',
//             blocks: [{ type: 'keyValue', items: [{ label: 'ISO', value: iso }] }]
//         }
//     ]);
//
// The envelope is internal. The harness unwraps it at the execution boundary
// (src/harness.ts `executeToolCall`):
//   - the model receives `serialize(content)` — byte-for-byte the value an
//     ordinary tool return would have produced;
//   - the `tool_result` event carries the panels on its optional `ui` field, and
//     the optimistic SSE/session record keeps them through the existing event
//     copies (server/sessions.ts copyEvent) without touching eventTimes;
//   - the manual server path (server/api.ts) unwraps to `ToolCallResult.result`
//     and adds the optional `panels` field.
//
// SAFETY
// ------
// Panels are pure data: no HTML, no URLs, no script, and no callbacks. This module
// additionally NORMALIZES AND BOUNDS everything, so a malformed or enormous
// payload from a tool cannot crash a client or explode a response:
//   - unknown block types and malformed panels/blocks are dropped;
//   - strings are truncated to a per-field bound;
//   - counts are capped (panels, blocks, table rows/columns, key/value items);
//   - the normalized list is dropped from the end until it fits a total byte cap.
// The same normalizer runs in `toolUi()` (fail safe at the tool) and in
// `toolUiOf()` (defence at the unwrapping boundary, where a hand-built object
// could bypass the helper).
//
// Cross-references:
//   - ../types              — ToolUiBlock / ToolUiPanel / ToolUiEnvelope
//   - ../harness.ts         — executeToolCall and executeTool unwrapping
//   - ../../server/api.ts   — manual ToolCallResult.result + panels
//   - ../../harnesses/tools.ts — timeNow, the shipped demonstration tool

import type { ToolUiBlock, ToolUiEnvelope, ToolUiPanel } from '../types';

// One table of bounds, exported so a client/documentation can quote the same
// numbers the server enforces. Deliberately generous for a real panel and small
// enough that a hostile tool cannot turn one result into a multi-megabyte frame.
export const TOOL_UI_LIMITS = {
    // A tool result is a summary, not a dashboard.
    panels: 32,
    blocksPerPanel: 64,
    // Table shape: 100 rows, 20 columns, each cell bounded on its own. A row's
    // width is fixed by its columns, so `rows` is always rectangular after
    // normalization.
    tableRows: 100,
    tableColumns: 20,
    keyValueItems: 100,
    // Text bounds in UTF-16 code units (slice lengths), which is what JSON and
    // the browser both use for a string.
    textLength: 16_000,
    cellLength: 2_000,
    labelLength: 200,
    titleLength: 200,
    idLength: 64,
    slotLength: 32,
    // Final guard on the serialized panel list. If the per-field caps still add
    // up to more than this (32 panels x 64 blocks), whole panels are dropped from
    // the end rather than sending a frame the client has to survive.
    totalBytes: 256 * 1024
} as const;

// The brand key. A plain string (not a Symbol) so two copies of this module in
// one process still agree on the shape, and so an own-property check is enough
// to tell an envelope from a tool's ordinary object result.
const TOOL_UI_BRAND = '__toolUi' as const;

// Coerce a bounded string. Non-strings are rejected (undefined) rather than
// stringified: a panel is presentation data, so an object/number cell is a bug
// the normalizer should drop, not a value it should invent text for.
const boundedString = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;

    return value.length > max ? value.slice(0, max) : value;
};

// Normalize one block, or drop it when it is not a recognized shape. Each case
// returns a fresh object so a caller cannot mutate state through the envelope.
const normalizeBlock = (value: unknown): ToolUiBlock | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

    const block = value as Record<string, unknown>;

    if (block.type === 'text') {
        const text = boundedString(block.text, TOOL_UI_LIMITS.textLength);
        return text === undefined ? undefined : { type: 'text', text };
    }

    if (block.type === 'table') {
        if (!Array.isArray(block.columns)) return undefined;

        // Columns define the row width. An empty table is meaningless, so a
        // column-less block is dropped instead of rendered as an empty box.
        const columns = block.columns
            .slice(0, TOOL_UI_LIMITS.tableColumns)
            .map((column) => (typeof column === 'string' ? column : ''));

        if (columns.length === 0) return undefined;

        const rows: string[][] = [];

        if (Array.isArray(block.rows)) {
            for (const entry of block.rows.slice(0, TOOL_UI_LIMITS.tableRows)) {
                if (!Array.isArray(entry)) continue;

                // Pad/truncate each row to the column width so the client never
                // has to defend against ragged rows. A non-string cell becomes
                // an empty cell rather than a stringified object.
                const row: string[] = [];
                for (let index = 0; index < columns.length; index++) {
                    const cell = entry[index];
                    row.push(typeof cell === 'string' ? cell.slice(0, TOOL_UI_LIMITS.cellLength) : '');
                }
                rows.push(row);
            }
        }

        return { type: 'table', columns, rows };
    }

    if (block.type === 'keyValue') {
        if (!Array.isArray(block.items)) return undefined;

        const items: { label: string; value: string }[] = [];

        for (const entry of block.items.slice(0, TOOL_UI_LIMITS.keyValueItems)) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;

            const item = entry as Record<string, unknown>;
            const label = boundedString(item.label, TOOL_UI_LIMITS.labelLength);
            const itemValue = boundedString(item.value, TOOL_UI_LIMITS.cellLength);

            // Both halves are required: half a pair is not a renderable row.
            if (label === undefined || itemValue === undefined) continue;

            items.push({ label, value: itemValue });
        }

        return { type: 'keyValue', items };
    }

    // Unknown block type (a future shape, or an injection attempt): drop it.
    return undefined;
};

// Normalize one panel. `id`, `slot`, and `title` are the identity/placement/
// heading a client needs; a panel missing one is dropped rather than rendered
// under a guess.
const normalizePanel = (value: unknown): ToolUiPanel | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

    const panel = value as Record<string, unknown>;
    const id = boundedString(panel.id, TOOL_UI_LIMITS.idLength);
    const slot = boundedString(panel.slot, TOOL_UI_LIMITS.slotLength);
    const title = boundedString(panel.title, TOOL_UI_LIMITS.titleLength);

    if (id === undefined || slot === undefined || title === undefined) return undefined;

    if (!Array.isArray(panel.blocks)) return undefined;

    const blocks: ToolUiBlock[] = [];

    for (const entry of panel.blocks.slice(0, TOOL_UI_LIMITS.blocksPerPanel)) {
        const block = normalizeBlock(entry);
        if (block !== undefined) blocks.push(block);
    }

    // A panel with nothing renderable is equivalent to no panel; keeping it
    // would make the client draw an empty frame.
    if (blocks.length === 0) return undefined;

    return { id, slot, title, blocks };
};

// Serialized size of the normalized list, used only for the total-byte guard.
// JSON is exactly what the SSE frame carries, so its length is the right metric.
const sizeOf = (panels: readonly ToolUiPanel[]): number => JSON.stringify(panels).length;

// Public normalizer used by both the helper and the unwrapper.
export const normalizeToolUiPanels = (value: unknown): ToolUiPanel[] => {
    if (!Array.isArray(value)) return [];

    const panels: ToolUiPanel[] = [];

    for (const entry of value.slice(0, TOOL_UI_LIMITS.panels)) {
        const panel = normalizePanel(entry);
        if (panel !== undefined) panels.push(panel);
    }

    // Total-size guard: drop whole panels from the end. A single panel can
    // exceed the cap only if the per-field bounds were raised, so the empty
    // result is the safe answer rather than a truncated block list.
    while (panels.length > 0 && sizeOf(panels) > TOOL_UI_LIMITS.totalBytes) {
        panels.pop();
    }

    return panels;
};

// Build the branded envelope a tool returns. The panels are normalized HERE as
// well as at the unwrapping boundary: a tool that passes a malformed shape gets a
// valid envelope with the bad parts dropped, never a client-side crash later.
export const toolUi = <TContent>(
    content: TContent,
    panels: readonly ToolUiPanel[]
): ToolUiEnvelope<TContent> => ({
    [TOOL_UI_BRAND]: normalizeToolUiPanels(panels),
    content
});

// What an unwrapper gets back: the ordinary content plus the normalized panels.
export type ToolUiExtraction<TContent = unknown> = {
    content: TContent;
    panels: ToolUiPanel[];
};

// Recognize and unwrap an envelope. Returns undefined for every ordinary tool
// value (including `null`, arrays, and objects that merely have a `content`
// field), which is what keeps standard tools byte-for-byte unaffected.
//
// The brand is read from the OWN property and the content is passed through
// untouched; panels are re-normalized because a hand-built object can bypass
// `toolUi()`.
export const toolUiOf = <TContent = unknown>(value: unknown): ToolUiExtraction<TContent> | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;

    if (!Object.prototype.hasOwnProperty.call(value, TOOL_UI_BRAND)) return undefined;

    const envelope = value as Record<string, unknown>;

    if (!Object.prototype.hasOwnProperty.call(envelope, 'content')) return undefined;

    return {
        content: envelope.content as TContent,
        panels: normalizeToolUiPanels(envelope[TOOL_UI_BRAND])
    };
};
