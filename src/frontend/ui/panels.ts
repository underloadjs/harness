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
// THE EXTENSION SEAM (T5/R1)
// --------------------------
// This module no longer decides alone what a panel looks like, or what else may sit
// in a host. Two registries in ../extensions take over, and BOTH are inert until
// somebody registers something:
//
//   - a PANEL KIND (../extensions/panel-kinds.ts) may draw a typed panel with its own
//     card. `apply` asks the registry first and falls back to `renderPanel` below for
//     an unkinded panel, an unknown kind, or a renderer that declined or threw. A kind
//     is registered by shipped code, so the trust boundary is unchanged: a tool still
//     contributes data, never markup.
//   - SHELL PANELS (../extensions/shell-panels.ts, mounted by ../extensions/runtime.ts)
//     are long-lived views the app registers into a slot. A host receives them as an
//     ordered node list through `setExtensions` and composes them around the tool
//     cards, so `apply`, `ids`, `clear` and the empty-host behaviour keep their exact
//     current meaning — the note under the scratch heading still counts TOOL panels.
//     Extension nodes are placed by identity, never rebuilt by a tool repaint, so a
//     live panel keeps its scroll position and focus while the board re-paints.
//
// Cross-references:
//   - src/frontend/main.ts — owns per-instance panel state and the hosts
//   - src/frontend/extensions/ — the kind registry, shell panels, the mount engine
//   - src/frontend/ui/turns.ts — renders the tool cards the panels accompany
//   - src/frontend/styles.css — `.panel-host`, `.panel`, `.panel-table`

import type { SessionTurn, ToolUiBlock, ToolUiPanel } from '../../server/protocol';
import type { DisplayPanelSummary } from '../../shared/turn-display';
// The kind registry: the only extension module this file needs at RUNTIME. It is a
// one-way edge (`../extensions/panel-kinds.ts` imports only TYPES from here), so the
// two modules can be reasoned about — and tested — separately, and neither can pull
// the other into a cycle.
import { applyPanelCardData, isPanelKindRegistered, renderPanelOfKind } from '../extensions/panel-kinds';

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

// One block a registered KIND owns. The sanitizer above knows three shapes; a typed
// panel carries its own (a task row, a diff hunk), and dropping it would erase the
// payload the renderer exists to draw. So for a panel whose kind this build CAN
// render, an unknown-typed block is kept STRUCTURALLY: the `type` name is bounded and
// the object is otherwise passed through untouched.
//
// This does not widen the security model. The shape was chosen by the author of the
// registered renderer, who is shipped code, and the renderer receives the same object
// the tool returned — data, never markup.
const asOpaqueBlock = (value: unknown): ToolUiBlock | undefined => {
    if (value === null || typeof value !== 'object') return undefined;

    const type = asText((value as { type?: unknown }).type, PANEL_LIMITS.idLength);
    if (type.length === 0) return undefined;

    return { ...(value as Record<string, unknown>), type } as unknown as ToolUiBlock;
};

// One panel. Unknown slot, missing id, or a non-object is not a panel: return
// undefined and let the caller skip it. An EMPTY `blocks` array stays valid — it
// is the removal signal handled by `applyPanels`.
//
// The return type narrows `slot` to a mounted PanelSlot: the wire type allows any
// string (the backend contract calls slots extensible), and this app only draws
// the ones it mounts.
//
// `kind` — the optional wire field a later task adds — is carried through when
// present, and `options.renderable` (does a registered renderer own this kind?)
// decides whether unknown blocks survive. An unknown kind therefore degrades into
// today's card exactly as an unkinded panel does.
export const sanitizePanel = (
    value: unknown,
    options?: { renderable?: boolean }
): (ToolUiPanel & { slot: PanelSlot; kind?: string }) | undefined => {
    if (value === null || typeof value !== 'object') return undefined;

    const record = value as {
        id?: unknown;
        slot?: unknown;
        title?: unknown;
        blocks?: unknown;
        kind?: unknown;
    };

    // Bind the slot to a local before the guard: TypeScript does not narrow a
    // mutable property through a type-predicate call, and the local keeps the
    // returned object's `slot` typed as PanelSlot. A documented alias ('right')
    // resolves to its mounted host instead of being dropped.
    const slot = resolveSlot(record.slot);
    if (slot === undefined) return undefined;

    const id = asText(record.id, PANEL_LIMITS.idLength);
    if (id.length === 0) return undefined;

    // An absent kind stays absent: a card built from an unkinded panel must be
    // byte-identical to the card this app has always drawn.
    const kind = asText(record.kind, PANEL_LIMITS.idLength);
    const renderable = options?.renderable === true && kind.length > 0;

    const blocks: ToolUiBlock[] = [];
    if (Array.isArray(record.blocks)) {
        for (const raw of record.blocks.slice(0, PANEL_LIMITS.blocksPerPanel)) {
            const block = sanitizeBlock(raw) ?? (renderable ? asOpaqueBlock(raw) : undefined);
            if (block !== undefined) blocks.push(block);
        }
    }

    return {
        id,
        slot,
        title: asText(record.title, PANEL_LIMITS.titleLength),
        blocks,
        ...(kind.length === 0 ? {} : { kind })
    };
};

// A wire list (`ui`/`panels`). Anything that is not an array yields no panels;
// the list itself is bounded so one message cannot contribute thousands.
//
// The renderability question (does some registered kind own these blocks?) is
// answered HERE, per panel, because `isPanelKindRegistered` is the registry's own
// verdict and every caller of this function must therefore agree with it.
export const sanitizePanels = (value: unknown): (ToolUiPanel & { slot: PanelSlot; kind?: string })[] => {
    if (!Array.isArray(value)) return [];

    const panels: (ToolUiPanel & { slot: PanelSlot; kind?: string })[] = [];
    for (const raw of value.slice(0, PANEL_LIMITS.panelsPerMessage)) {
        const named = raw !== null && typeof raw === 'object' ? (raw as { kind?: unknown }).kind : undefined;
        const panel = sanitizePanel(raw, { renderable: isPanelKindRegistered(named) });
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
    panel: ToolUiPanel & { slot: PanelSlot; kind?: string };
    // The kind this entry routes to, when the wire named one. `panel.kind` is the
    // wire field itself; a caller that resolves the name elsewhere (a summary
    // projection, a locally-built entry) may attach it here instead —
    // ../extensions/panel-kinds.ts `panelKindOf` reads both.
    kind?: string;
    // Display-wire expansion (T5 R1/R2): a compact summary card carries the action
    // that replaces itself with the FULL panel document (one step-detail request,
    // owned by the shell). A full panel — a manual tool result, or a summary already
    // expanded — has no action, because there is nothing left to load; a card never
    // claims a payload it does not show.
    detail?: { open: () => void; label?: string };
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
        // mounted slot here. The kind rides along on the ENTRY as well as the panel
        // so a renderer (and `applyPanelCardData`) can route without re-reading the
        // wire shape; an unkinded panel sets neither, exactly as before.
        target.set(key, {
            key,
            slot: panel.slot,
            panel,
            ...(panel.kind === undefined ? {} : { kind: panel.kind })
        });
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
// Display-wire summaries (T5: R1/R3)
// ---------------------------------------------------------------------------
//
// The compact view never ships a `ToolUiPanel`: the server ships a bounded
// `DisplayPanelSummary` (identity, slot, title, block SHAPES, one preview line,
// and the `truncated`/`totalPanels` figures that say what it left out —
// src/shared/turn-display.ts:179). Those summaries become ordinary panel data
// here, so one host, one renderer and one upsert rule serve both surfaces, and
// the reader can always tell a summary from a payload because the card says so.
//
// Expansion is the shell's job: the card carries a `detail.open` action, and the
// shell answers it with the step-detail route (./view-api.ts `getStepDetail`),
// whose FULL panels then upsert over the summary under the SAME key.
//
// `PanelSummarySource` is structural on purpose: ./view-state.ts produces these
// entries (`panelEntriesOf`), and this module stays free of that import so the
// two can be tested — and reasoned about — independently.

export type PanelSummarySource = {
    turnId: string;
    sectionId: string;
    stepId: string;
    /** The contributing tool: the upsert scope, exactly as in `applyPanels`. */
    tool: string;
    panel: DisplayPanelSummary;
};

// One block summary -> a human-readable shape line. Counts only, never content:
// the content is what the expand action fetches.
const blockShapeOf = (block: DisplayPanelSummary['blocks'][number]): string => {
    if (block.type === 'text') return `${block.length.toLocaleString()} characters`;
    if (block.type === 'table') return `${block.rows} rows · ${block.columns} columns`;

    return `${block.items} items`;
};

// A summary -> the panel data this host draws. Returns undefined for a panel that
// names an unmounted slot (the same rule that drops unknown slots on the raw
// surface: a tool cannot invent a location).
export const panelOfSummary = (
    summary: DisplayPanelSummary
): (ToolUiPanel & { slot: PanelSlot; note?: string }) | undefined => {
    const slot = resolveSlot(summary.slot);
    if (slot === undefined) return undefined;

    const id = asText(summary.id, PANEL_LIMITS.idLength);
    if (id.length === 0) return undefined;

    const blocks: ToolUiBlock[] = [];

    // The bounded first line is the only readable content the compact wire ships —
    // and it is enough to recognise the card without a request (turn-display.ts:116).
    if (summary.preview !== undefined && summary.preview.length > 0)
        blocks.push({ type: 'text', text: asText(summary.preview, PANEL_LIMITS.textLength) });

    // Block shapes, as a key/value list: a reader sees WHAT the panel holds (a
    // 12-row table, 30 fields) without the browser holding any of it.
    const items = summary.blocks
        .slice(0, PANEL_LIMITS.keyValueItems)
        .map((block) => ({ label: block.type, value: blockShapeOf(block) }));
    if (items.length > 0) blocks.push({ type: 'keyValue', items });

    // The honest footer: this is a summary, what it trimmed, and how many panels the
    // result actually carries. `truncated` is the server's flag, so the card never
    // guesses whether more exists. It is a NOTE, not a panel block: the card's block list
    // stays exactly the panel's own content (a tool's `ui` blocks on the raw surface), and
    // the disclosure is chrome the renderer draws once, below them.
    const notes: string[] = [];
    if (summary.truncated) notes.push('content trimmed');
    else notes.push('preview only');
    if (summary.totalPanels > 1) notes.push(`${summary.totalPanels} panels in this result`);

    return {
        id,
        slot,
        title: asText(summary.title, PANEL_LIMITS.titleLength),
        blocks,
        note: `compact view · ${notes.join(' · ')}`
    };
};

// Summary entries -> the panel map, upserted under the same scoped key the raw
// aggregation uses, so a full panel that arrives later (or a manual tool result)
// replaces its summary rather than sitting beside it.
export const mediaOfSummaries = (
    entries: readonly PanelSummarySource[],
    open?: (entry: PanelSummarySource) => void
): Map<string, PanelMedia> => {
    const media = new Map<string, PanelMedia>();

    for (const entry of entries) {
        const panel = panelOfSummary(entry.panel);
        if (panel === undefined) continue;

        const key = panelKeyOf(entry.tool, panel);
        media.set(key, {
            key,
            slot: panel.slot,
            panel,
            ...(open === undefined
                ? {}
                : { detail: { open: () => open(entry), label: 'Open the full panel' } })
        });
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

// The card this module draws when NO registered kind owns the panel. Everything
// below is built with `createElement`/`textContent` — the data-only rule of this
// file — and the dataset contract lives in
// ../extensions/panel-kinds.ts `applyPanelCardData` so a kind's card and
// this one can never disagree (the acceptance tests select on those attributes).
const renderPanel = (slot: PanelSlot, media: PanelMedia): HTMLElement => {
    const card = el('article', 'panel');

    // `data-panel-id` / `-slot` / `-state` / `-tool`, plus `-kind` ONLY for a panel
    // that names a kind. An unkinded card is byte-identical to the card this app has
    // always drawn.
    applyPanelCardData(card, slot, media);

    // The title is a heading for scanning; an untitled panel still shows its id so
    // the card is identifiable rather than anonymous.
    card.append(el('h3', 'panel-title', media.panel.title.length > 0 ? media.panel.title : media.panel.id));

    const body = el('div', 'panel-blocks');
    for (const block of media.panel.blocks) body.append(renderBlock(block));
    card.append(body);

    // Display-wire disclosure (T5): a summary card says what it left out, as a NOTE below the
    // panel's own blocks. `PanelMedia.panel` is a `ToolUiPanel` on the raw surface and a summary
    // projection here, so the note rides as an optional field rather than a fake block.
    const note = (media.panel as { note?: string }).note;
    if (note !== undefined && note.length > 0) {
        const footer = el('p', 'panel-note', note);
        footer.title = 'This card is the compact view. Use Open the full panel for the recorded content.';
        card.append(footer);
    }

    // R1/R2: a summary card says what it left out and how to get it. The control is
    // a real button (keyboard, and the shell's focus restoration), and the request
    // belongs to the shell — this module owns no transport, exactly like the file
    // preview reader it shares the host rail with.
    if (media.detail !== undefined) {
        const actions = el('div', 'panel-actions');
        const button = el('button', 'button small panel-expand');
        button.type = 'button';
        button.textContent = media.detail.label ?? 'Open the full panel';
        button.addEventListener('click', () => media.detail?.open());
        actions.append(button);
        card.append(actions);
    }

    return card;
};

// The ONE place a host decides how a media entry becomes a node (T5/R1). The kind
// registry answers first; `undefined` means it does not own this panel — unkinded,
// unknown kind, or a renderer that declined or threw — and the data-only renderer
// above draws it. Both paths produce the same dataset contract, so nothing down the
// line (CSS, the acceptance selectors, the scratch note) can tell them apart.
const renderPanelCard = (slot: PanelSlot, media: PanelMedia): HTMLElement =>
    renderPanelOfKind(slot, media) ?? renderPanel(slot, media);

// The extension seam of a host: the nodes ../extensions/runtime.ts mounts for this
// slot, in draw order, split by which side of the tool cards they belong on.
export type PanelHostExtensions = {
    before?: readonly HTMLElement[];
    after?: readonly HTMLElement[];
};

export type PanelHost = {
    element: HTMLElement;
    slot: PanelSlot;
    // Replace the host's contents with the panels addressed to its slot. Panels
    // for other slots are ignored, so one instance-level list can feed every host.
    apply: (media: readonly PanelMedia[]) => number;
    // Drops the TOOL panels only. Extension content is owned by the runtime and
    // leaves through `setExtensions`, never as collateral of a panel clear.
    clear: () => void;
    // Raw panel ids currently drawn, in order — used by tests and status text.
    // Extension content is NOT in here, which is what keeps the scratch note counting
    // tool panels after a plugin mounts a live view into the same host.
    ids: () => string[];
    // T5/R1: replaces the extension-owned nodes around the tool cards. Idempotent,
    // and a no-op against an empty registry (the pre-extension behaviour).
    setExtensions: (extensions: PanelHostExtensions) => void;
    // The `data-panel-extension` ids currently placed, in draw order.
    extensionIds: () => string[];
};

// A host is a dumb display: it holds no panel history of its own. `main.ts` keeps
// per-instance state and calls `apply` with the current list, which is what makes
// a recompute after reload/poll/session-switch idempotent. It hands extension nodes
// to `setExtensions` and keeps no opinion about them either.
export const createPanelHost = (slot: PanelSlot): PanelHost => {
    const element = el('div', 'panel-host');
    element.dataset.slot = slot;
    // Empty hosts take no space and are not announced.
    element.hidden = true;
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-label', `Tool panels (${slot})`);

    // The tool cards, in draw order. Rebuilt by every `apply`, exactly as before.
    const current: HTMLElement[] = [];
    // The extension-owned nodes, in draw order, owned by the runtime.
    let extensionBefore: readonly HTMLElement[] = [];
    let extensionAfter: readonly HTMLElement[] = [];

    // What the children of this element should be, top to bottom.
    const composed = (): HTMLElement[] => [...extensionBefore, ...current, ...extensionAfter];

    // Reconciles the DOM in place: drop what is gone, place what belongs here, and
    // never touch a child that is already where it belongs. `replaceChildren` reaches
    // the same end state for tool cards, but it MOVES every node it is handed — and a
    // live extension element that is moved loses its scroll position and its focus,
    // which a stream-driven tool repaint must not cost the reader. With no extension
    // nodes this is the same list of operations the old call produced.
    const reconcile = (nodes: readonly HTMLElement[]): void => {
        const keep = new Set<unknown>(nodes);

        for (const child of [...element.children])
            if (!keep.has(child)) element.removeChild(child);

        for (let index = 0; index < nodes.length; index += 1) {
            const node = nodes[index];
            if (element.children[index] === node) continue;
            element.insertBefore(node, element.children[index] ?? null);
        }

        // Empty hosts take no space and are not announced — the rule that keeps an
        // unused location from adding chrome.
        element.hidden = nodes.length === 0;
    };

    const clear = (): void => {
        current.length = 0;
        reconcile(composed());
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

        for (const entry of byKey.values()) current.push(renderPanelCard(slot, entry));

        reconcile(composed());

        return current.length;
    };

    const setExtensions = (extensions: PanelHostExtensions): void => {
        extensionBefore = [...(extensions.before ?? [])];
        extensionAfter = [...(extensions.after ?? [])];

        reconcile(composed());
    };

    return {
        element,
        slot,
        apply,
        clear,
        ids: () => current.map((card) => card.dataset.panelId ?? ''),
        setExtensions,
        extensionIds: () =>
            [...extensionBefore, ...extensionAfter].map((node) => node.dataset.panelExtension ?? '')
    };
};
