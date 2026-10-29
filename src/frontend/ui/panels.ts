// Declarative tool-contributed panels: one renderer, several named hosts (R21.3).
//
// The fixed backend contract (T21) lets a tool contribute *data* instead of
// markup. A tool returns `panels?: ToolUiPanel[]` (manual call) or emits
// `HarnessEvent.tool_result.ui?: ToolUiPanel[]` (inside a run), and this module
// draws that data into the app's existing named locations:
//
//   - `scratch` — the primary host: the right rail's scratch board, above sessions;
//   - `center`  — above the turn tiles, so a tool can show a live summary next to
//                 the conversation that produced it;
//   - `left`    — the left rail, below the harness list and above the endpoint.
//
// Unobtrusive by construction: a host hides itself while it has no panels, so a
// harness or tool that contributes nothing does not add empty chrome.
//
// RENDERING IS DATA-ONLY. Every node below is built with `createElement` and
// `textContent`; this module never assigns `innerHTML`, never evaluates a string,
// and never accepts HTML, script, or an element from a tool. A model that returns
// `<img onerror=…>` produces literal text, not markup. That is the whole security
// model: there is no sanitizer because there is no markup path.
//
// IDENTITY AND REPLACEMENT
// ------------------------
// Panels are upserted by a key scoped to the tool that contributed them:
//
//     key = `${toolName}\u001f${panel.id}`
//
// so two unrelated tools may each publish an `id: 'status'` panel without one
// replacing the other (an unscoped id would collide). Upsert is stable: replacing
// an existing key keeps its position; a NEW key appends. A VALID panel with an
// empty `blocks` array is the documented removal signal: it deletes that key
// instead of rendering an empty card. History aggregation (`mediaOfTurns`) uses
// exactly the same rule, so a replay after a reload, a poll, or a session switch
// settles on the same picture as the live stream.
//
// Everything that comes off the wire is validated and clamped. Unknown slots are dropped
// whole; unknown block types are dropped individually; counts, ids, titles,
// text, cells and rows are bounded so a hostile or buggy tool cannot build a
// multi-megabyte DOM or claim a location this app does not declare.
//
// Cross-references:
//   - src/frontend/main.ts — owns per-instance panel state and the hosts
//   - src/frontend/ui/turns.ts — renders the tool cards the panels accompany
//   - src/frontend/styles.css — `.panel-host`, `.panel`, `.panel-table`

import type { SessionTurn, ToolUiBlock, ToolUiPanel } from '../../server/protocol';

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------
//
// The canonical declarations live in `src/types` and `src/server/protocol.ts`
// re-exports them (T21 backend contract), so this module imports the real types
// rather than mirroring them. The import is type-only: nothing here reaches the
// server bundle.

// ---------------------------------------------------------------------------
// Named hosts and limits
// ---------------------------------------------------------------------------

// The slots this app mounts. A panel naming anything else is skipped: a tool
// cannot invent a location, it can only use the ones the shell declares.
//
// `scratch` is the PRIMARY host (the right rail's board). `center` (above the
// turn grid) and `left` (below the harness list, above the endpoint) are the two
// additional unobtrusive locations.
export const PANEL_SLOTS = ['scratch', 'center', 'left'] as const;
export type PanelSlot = (typeof PANEL_SLOTS)[number];

// Compatibility aliases for a slot name this app mounts under another name. The
// backend contract documents 'right' as the default mount point, so a tool written
// against that spelling lands on the scratch board instead of being dropped.
export const PANEL_SLOT_ALIASES: Readonly<Record<string, PanelSlot>> = { right: 'scratch' };

export const resolveSlot = (value: unknown): PanelSlot | undefined => {
    if (typeof value !== 'string') return undefined;
    if ((PANEL_SLOTS as readonly string[]).includes(value)) return value as PanelSlot;
    return PANEL_SLOT_ALIASES[value];
};

export const isPanelSlot = (value: unknown): value is PanelSlot => resolveSlot(value) !== undefined;

// Bounds applied to every value that crosses the wire. They are deliberately
// generous for real use and small enough that a malformed payload cannot wedge
// the rail. Every boundary is pinned by ui/panels.test.ts.
export const PANEL_LIMITS = {
    // Panels one host renders. Extra keys stay in instance state but are not drawn.
    panelsPerSlot: 6,
    // Blocks one panel may contribute; the rest are dropped.
    blocksPerPanel: 12,
    textLength: 2000,
    titleLength: 120,
    idLength: 64,
    columns: 8,
    rows: 50,
    cellLength: 200,
    keyValueItems: 30,
    keyValueLabelLength: 80,
    keyValueValueLength: 500,
    // A single event/result may not contribute an unbounded list either.
    panelsPerMessage: 6
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const asText = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.slice(0, max) : '';

// One table cell. Non-strings are dropped (rendered as '' when padding a short
// row) rather than stringified: a tool that sent an object should get a blank
// cell, not "[object Object]" on screen.
const asCell = (value: unknown): string =>
    typeof value === 'string' ? value.slice(0, PANEL_LIMITS.cellLength) : '';

// A table is normalized to a rectangle: rows shorter than `columns` are padded
// with '', longer rows are truncated. That keeps the header and body aligned
// without trusting the producer.
const sanitizeTable = (value: {
    columns: unknown;
    rows: unknown;
}): ToolUiBlock | undefined => {
    const columns = Array.isArray(value.columns)
        ? value.columns
              .slice(0, PANEL_LIMITS.columns)
              .map((column) => asText(column, PANEL_LIMITS.cellLength))
        : [];

    // No columns means there is nothing to head the table with; skip the block.
    if (columns.length === 0) return undefined;

    const rows = Array.isArray(value.rows)
        ? value.rows.slice(0, PANEL_LIMITS.rows).map((row) => {
              const cells = Array.isArray(row) ? row : [];
              return columns.map((_column, index) => asCell(cells[index]));
          })
        : [];

    return { type: 'table', columns, rows };
};

// A key/value list. Items without a label string are dropped: a value with no
// name cannot be read, and inventing a label would misrepresent the tool.
const sanitizeKeyValue = (value: { items: unknown }): ToolUiBlock | undefined => {
    if (!Array.isArray(value.items)) return undefined;

    const items: { label: string; value: string }[] = [];
    for (const raw of value.items.slice(0, PANEL_LIMITS.keyValueItems)) {
        if (raw === null || typeof raw !== 'object') continue;

        const label = asText((raw as { label?: unknown }).label, PANEL_LIMITS.keyValueLabelLength);
        if (label.length === 0) continue;

        items.push({
            label,
            value: asText((raw as { value?: unknown }).value, PANEL_LIMITS.keyValueValueLength)
        });
    }

    return items.length === 0 ? undefined : { type: 'keyValue', items };
};

// One block. Unknown types and malformed shapes return undefined so the caller
// can drop just that block and keep the rest of the panel.
export const sanitizeBlock = (value: unknown): ToolUiBlock | undefined => {
    if (value === null || typeof value !== 'object') return undefined;

    const type = (value as { type?: unknown }).type;

    if (type === 'text') {
        return { type: 'text', text: asText((value as { text?: unknown }).text, PANEL_LIMITS.textLength) };
    }

    if (type === 'table') {
        return sanitizeTable(value as { columns: unknown; rows: unknown });
    }

    if (type === 'keyValue') {
        return sanitizeKeyValue(value as { items: unknown });
    }

    return undefined;
};

// One panel. Unknown slot, missing id, or a non-object is not a panel: return
// undefined and let the caller skip it. An EMPTY `blocks` array stays valid — it
// is the removal signal handled by `applyPanels`.
//
// The return type narrows `slot` to a mounted PanelSlot: the wire type allows any
// string (the backend contract calls slots extensible), and this app only draws
// the ones it mounts.
export const sanitizePanel = (value: unknown): (ToolUiPanel & { slot: PanelSlot }) | undefined => {
    if (value === null || typeof value !== 'object') return undefined;

    const record = value as { id?: unknown; slot?: unknown; title?: unknown; blocks?: unknown };

    // Bind the slot to a local before the guard: TypeScript does not narrow a
    // mutable property through a type-predicate call, and the local keeps the
    // returned object's `slot` typed as PanelSlot. A documented alias ('right')
    // resolves to its mounted host instead of being dropped.
    const slot = resolveSlot(record.slot);
    if (slot === undefined) return undefined;

    const id = asText(record.id, PANEL_LIMITS.idLength);
    if (id.length === 0) return undefined;

    const blocks: ToolUiBlock[] = [];
    if (Array.isArray(record.blocks)) {
        for (const raw of record.blocks.slice(0, PANEL_LIMITS.blocksPerPanel)) {
            const block = sanitizeBlock(raw);
            if (block !== undefined) blocks.push(block);
        }
    }

    return {
        id,
        slot,
        title: asText(record.title, PANEL_LIMITS.titleLength),
        blocks
    };
};

// A wire list (`ui`/`panels`). Anything that is not an array yields no panels;
// the list itself is bounded so one message cannot contribute thousands.
export const sanitizePanels = (value: unknown): (ToolUiPanel & { slot: PanelSlot })[] => {
    if (!Array.isArray(value)) return [];

    const panels: (ToolUiPanel & { slot: PanelSlot })[] = [];
    for (const raw of value.slice(0, PANEL_LIMITS.panelsPerMessage)) {
        const panel = sanitizePanel(raw);
        if (panel !== undefined) panels.push(panel);
    }

    return panels;
};

// ---------------------------------------------------------------------------
// Aggregation: stable upsert per slot, scoped to the contributing tool
// ---------------------------------------------------------------------------

export type PanelMedia = {
    // `${toolName}\u001f${panel.id}` — see the header for why this is scoped.
    key: string;
    slot: PanelSlot;
    panel: ToolUiPanel & { slot: PanelSlot };
};

export const panelKeyOf = (toolName: string, panel: Pick<ToolUiPanel, 'id'>): string =>
    `${toolName}\u001f${panel.id}`;

// Upsert one message's panels into `target`, which preserves insertion order.
// Returns the number of applied entries (including removals) so a caller can
// repaint only when something actually changed.
//
// A panel with no blocks REMOVES the key: this is the documented way for a tool
// to retract a card it published earlier. The removal only affects panels from
// the same tool (the key is scoped), never an unrelated tool's panel.
export const applyPanels = (
    target: Map<string, PanelMedia>,
    toolName: string,
    value: unknown
): number => {
    const panels = sanitizePanels(value);
    let changes = 0;

    for (const panel of panels) {
        const key = panelKeyOf(toolName, panel);

        if (panel.blocks.length === 0) {
            if (target.delete(key)) changes += 1;
            continue;
        }

        // `sanitizePanel` already resolved the slot (aliases included), so it is a
        // mounted slot here.
        target.set(key, { key, slot: panel.slot, panel });
        changes += 1;
    }

    return changes;
};

// Panels recorded in a server snapshot. Replaying `tool_result.ui` is what makes
// a reload, a poll, a session switch and a terminal snapshot agree: the server's
// turn list is authoritative and no browser-side panel history is needed.
//
// Events are validated structurally: an older server sends no `ui` (safe), and a
// hand-built/legacy turn may miss `events` entirely.
export const mediaOfTurns = (turns: readonly SessionTurn[]): Map<string, PanelMedia> => {
    const media = new Map<string, PanelMedia>();
    if (!Array.isArray(turns)) return media;

    for (const turn of turns) {
        if (turn === null || typeof turn !== 'object') continue;

        const events = Array.isArray(turn.events) ? turn.events : [];
        for (const event of events) {
            if (event === null || typeof event !== 'object' || event.type !== 'tool_result') continue;

            const name =
                typeof (event as { name?: unknown }).name === 'string' &&
                (event as { name: string }).name.length > 0
                    ? (event as { name: string }).name
                    : 'unknown';

            applyPanels(media, name, (event as { ui?: unknown }).ui);
        }
    }

    return media;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

// One block → one node. `data-block` lets the styling and the tests name the
// kind without inspecting internals.
const renderBlock = (block: ToolUiBlock): HTMLElement => {
    if (block.type === 'text') {
        // Literal text: a `<script>`/`<img onerror>` string is shown, not run.
        return el('p', 'panel-text', block.text);
    }

    if (block.type === 'table') {
        const wrap = el('div', 'panel-table-wrap');
        const table = el('table', 'panel-table');

        const head = el('thead');
        const headRow = el('tr');
        for (const column of block.columns) {
            const cell = el('th', undefined, column);
            cell.scope = 'col';
            headRow.append(cell);
        }
        head.append(headRow);

        const body = el('tbody');
        for (const row of block.rows) {
            const tr = el('tr');
            // Cells are already normalized to `columns.length` by sanitizeTable.
            for (const value of row) tr.append(el('td', undefined, value));
            body.append(tr);
        }

        table.append(head, body);
        wrap.append(table);
        wrap.dataset.block = 'table';
        return wrap;
    }

    const list = el('dl', 'panel-kv');
    for (const item of block.items) {
        list.append(el('dt', 'panel-kv-label', item.label), el('dd', 'panel-kv-value', item.value));
    }
    list.dataset.block = 'keyValue';
    return list;
};

const renderPanel = (slot: PanelSlot, media: PanelMedia): HTMLElement => {
    const card = el('article', 'panel');
    card.dataset.panelId = media.panel.id;
    card.dataset.panelSlot = slot;
    // Attribution for styling/diagnostics. A hand-built media entry may have a key
    // without the separator; then the whole key is the best name available.
    const separator = media.key.indexOf('\u001f');
    card.dataset.panelTool = separator >= 0 ? media.key.slice(0, separator) : media.key;

    // The title is a heading for scanning; an untitled panel still shows its id so
    // the card is identifiable rather than anonymous.
    card.append(el('h3', 'panel-title', media.panel.title.length > 0 ? media.panel.title : media.panel.id));

    const body = el('div', 'panel-blocks');
    for (const block of media.panel.blocks) body.append(renderBlock(block));
    card.append(body);

    return card;
};

export type PanelHost = {
    element: HTMLElement;
    slot: PanelSlot;
    // Replace the host's contents with the panels addressed to its slot. Panels
    // for other slots are ignored, so one instance-level list can feed every host.
    apply: (media: readonly PanelMedia[]) => number;
    clear: () => void;
    // Raw panel ids currently drawn, in order — used by tests and status text.
    ids: () => string[];
};

// A host is a dumb display: it holds no panel history of its own. `main.ts` keeps
// per-instance state and calls `apply` with the current list, which is what makes
// a recompute after reload/poll/session-switch idempotent.
export const createPanelHost = (slot: PanelSlot): PanelHost => {
    const element = el('div', 'panel-host');
    element.dataset.slot = slot;
    // Empty hosts take no space and are not announced.
    element.hidden = true;
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-label', `Tool panels (${slot})`);

    const current: HTMLElement[] = [];

    const clear = (): void => {
        current.length = 0;
        element.replaceChildren();
        element.hidden = true;
    };

    const apply = (media: readonly PanelMedia[]): number => {
        // Deduplicate by key while preserving first position: a list built from a
        // Map is already unique, but a caller may pass a plain array (tests, future
        // sources) and must still get stable replacement.
        const byKey = new Map<string, PanelMedia>();
        for (const entry of media) {
            if (entry.slot !== slot) continue;
            if (entry.panel.blocks.length === 0) continue;
            if (byKey.size >= PANEL_LIMITS.panelsPerSlot && !byKey.has(entry.key)) continue;
            byKey.set(entry.key, entry);
        }

        current.length = 0;
        const nodes: HTMLElement[] = [];

        for (const entry of byKey.values()) {
            const card = renderPanel(slot, entry);
            current.push(card);
            nodes.push(card);
        }

        element.replaceChildren(...nodes);
        element.hidden = nodes.length === 0;
        return nodes.length;
    };

    return {
        element,
        slot,
        apply,
        clear,
        ids: () => current.map((card) => card.dataset.panelId ?? '')
    };
};
