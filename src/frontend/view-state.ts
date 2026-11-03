// The browser-side DISPLAY STATE: one place that understands a `SessionView` and the
// `TurnDisplayOp` stream that mutates it (R1/R3).
//
// What this module is NOT: it is not a projector. Nothing here reads a
// `HarnessEvent`, folds a stream, matches a call by name, or decides what anything
// MEANS. The server decided all of that (src/shared/turn-display.ts) and addressed
// the answer by id; this module applies those addresses and answers questions about
// the result. That asymmetry is the whole point of the split: the only "compilation"
// left in the browser is `id -> node`, which is a lookup, not an inference.
//
// Two consumers, one semantics:
//   - ui/turns.ts keeps a `TurnDisplay` mirror per rendered turn and paints DOM per
//     op (`applyOpsToDisplay` is the state half of that same op);
//   - main.ts reads the derived selectors below for the rail, the activity rings,
//     the scratch board, the composer's `#` popup and the submit/stop gating — every
//     one of those used to scan `turn.events`.
//
// Every helper is total and defensive against unknown ids: an op that names a turn
// or section this client never adopted is DROPPED, never guessed at (the terminal
// `view` frame reconciles anything missed, protocol.ts:648).
//
// Cross-references:
//   - src/shared/turn-display.ts   — the shapes (`TurnDisplay`, `TurnDisplayOp`,
//                                    `TurnSummary`, `DisplayStep`, `DisplayPanelSummary`)
//   - src/server/protocol.ts:587   — `SessionView` / `SessionViewStreamItem`
//   - ./view-api.ts                — the routes that produce them
//   - ui/turns.ts                  — the DOM renderer for these states
//   - ui/panels.ts                 — compact panel cards built from `DisplayPanelSummary`
//   - ui/activity.ts               — `applyActivity` (raw path, kept for compatibility)

import type {
    DisplayBlockSummary,
    DisplayNode,
    DisplayPanelSummary,
    DisplayStep,
    TurnDisplay,
    TurnDisplayOp,
    TurnSection,
    TurnSummary
} from '../shared/turn-display';
import type { HarnessPendingTool } from './contract';
import type {
    SessionThread,
    SessionView,
    SessionViewStreamItem,
    SessionViewSummary,
    SubmitTaskViewResult
} from '../server/protocol';

// ---------------------------------------------------------------------------
// Read helpers (every access to the compiled document goes through one of these)
// ---------------------------------------------------------------------------

/** Compact rows of a view, in recorded order. Never an event list. */
export const summariesOf = (view: SessionView | SessionViewSummary | undefined): TurnSummary[] =>
    view !== undefined && Array.isArray(view.turns) ? view.turns : [];

/** The display tree of one turn, or undefined when the view omits it. */
export const displayOf = (
    view: SessionView | undefined,
    turnId: string
): TurnDisplay | undefined => {
    if (view === undefined || view.displays === null || typeof view.displays !== 'object')
        return undefined;

    return (view.displays as Record<string, TurnDisplay>)[turnId];
};

/** Every turn id the view names, in recorded order. */
export const turnIdsOf = (view: SessionView | SessionViewSummary | undefined): string[] =>
    summariesOf(view).map((summary) => summary.id);

/** Sections of one turn (root first, nested in allocation order — the server's order). */
export const sectionsOf = (display: TurnDisplay | undefined): TurnSection[] =>
    display !== undefined && Array.isArray(display.sections) ? display.sections : [];

/** Nodes of one section, in display order. */
export const nodesOf = (section: TurnSection | undefined): DisplayNode[] =>
    section !== undefined && Array.isArray(section.nodes) ? section.nodes : [];

/** Every step (tool call / owner question) of one turn, section order then node order. */
export const stepsOf = (display: TurnDisplay | undefined): DisplayStep[] => {
    const steps: DisplayStep[] = [];

    for (const section of sectionsOf(display)) {
        for (const node of nodesOf(section)) {
            if (node.kind === 'tool' || node.kind === 'action') steps.push(node);
        }
    }

    return steps;
};

// ---------------------------------------------------------------------------
// Derived state (the questions the shell asks a compiled view)
// ---------------------------------------------------------------------------

// Is there work the server has not finished? A running/queued ROW, an explicit
// `queueDepth`, or a running session status — the same three signals the raw path
// read off `SessionSnapshot`, now read off `TurnSummary` so no event is touched.
export const isPendingView = (view: SessionView | SessionViewSummary | undefined): boolean => {
    if (view === undefined) return false;

    const depth = (view as { queueDepth?: unknown }).queueDepth;
    if (typeof depth === 'number' && Number.isFinite(depth) && depth > 0) return true;
    if (view.status === 'running') return true;

    return summariesOf(view).some((summary) => summary.status === 'running' || summary.status === 'queued');
};

// Which agents have live work, from COMPILED state only.
//
// Two sources, unioned, because each covers a case the other misses:
//   - `TurnSummary.activeAgents` is the server's own figure for the turn (the
//     replacement for walking every event, ui/activity.ts:129);
//   - a section that is `open`/`streaming` is an invocation still working, which an
//     op stream advances (`section:set`) faster than a whole `turn` upsert arrives.
// A settled turn contributes nothing: replaying a completed transcript must never
// animate old work (the rule ui/activity.ts pins).
export const activeAgentsOf = (view: SessionView | undefined): Set<string> => {
    const active = new Set<string>();
    if (view === undefined) return active;

    for (const summary of summariesOf(view)) {
        if (summary.status !== 'running') continue;

        for (const name of summary.activeAgents) {
            if (typeof name === 'string' && name.length > 0) active.add(name);
        }

        for (const section of sectionsOf(displayOf(view, summary.id))) {
            if (section.state === 'open' || section.state === 'streaming') {
                if (section.agent.length > 0) active.add(section.agent);
            }
        }
    }

    return active;
};

// The composer's `#` popup source: every referenceable block, oldest turn first.
// `DisplayBlockSummary` carries label/agent/status/preview WITHOUT the block's full
// text, so the popup offers and labels a reference without ever holding 100 KB of
// prose (that is why `TurnHandle.blocks()` folded events before this existed).
export const blocksOf = (view: SessionView | SessionViewSummary | undefined): DisplayBlockSummary[] => {
    const blocks: DisplayBlockSummary[] = [];

    for (const summary of summariesOf(view)) {
        if (!Array.isArray(summary.blocks)) continue;
        for (const block of summary.blocks) blocks.push(block);
    }

    return blocks;
};

// One panel as the scratch board sees it, addressed by the step that contributed it
// (a click therefore knows exactly which detail route can expand it).
export type PanelSummaryEntry = {
    turnId: string;
    turnIndex: number;
    sectionId: string;
    stepId: string;
    /** The tool that contributed the panel — the upsert scope (ui/panels.ts:243). */
    tool: string;
    panel: DisplayPanelSummary;
};

// Tool-contributed panels, collected from the compiled trees in the same upsert
// order the raw aggregation used (`${tool}\u001f${panel.id}`, first writer wins,
// a later panel with the same key REPLACES it). Panels are bounded summaries:
// full cells/rows live on the step's detail route.
export const panelEntriesOf = (view: SessionView | undefined): PanelSummaryEntry[] => {
    const order: string[] = [];
    const byKey = new Map<string, PanelSummaryEntry>();

    for (const summary of summariesOf(view)) {
        const display = displayOf(view, summary.id);
        if (display === undefined) continue;

        for (const section of sectionsOf(display)) {
            for (const step of nodesOf(section)) {
                if (step.kind !== 'tool' || !Array.isArray(step.panels)) continue;

                for (const panel of step.panels) {
                    const key = `${step.name}${panel.id}`;
                    const entry: PanelSummaryEntry = {
                        turnId: summary.id,
                        turnIndex: summary.index,
                        sectionId: section.id,
                        stepId: step.id,
                        tool: step.name,
                        panel
                    };

                    if (!byKey.has(key)) order.push(key);
                    byKey.set(key, entry);
                }
            }
        }
    }

    return order.map((key) => byKey.get(key) as PanelSummaryEntry);
};

// Every step the view currently holds, for the same reason `records` existed on the
// raw path: a later route (detail fetch, copy) needs id → step without a re-scan.
export const stepIndex = (
    view: SessionView | undefined
): Map<string, { turnId: string; sectionId: string; step: DisplayStep }> => {
    const index = new Map<string, { turnId: string; sectionId: string; step: DisplayStep }>();

    for (const summary of summariesOf(view)) {
        const display = displayOf(view, summary.id);
        if (display === undefined) continue;

        for (const section of sectionsOf(display)) {
            for (const node of nodesOf(section)) {
                if (node.kind !== 'tool' && node.kind !== 'action') continue;
                index.set(`${summary.id}:${node.id}`, { turnId: summary.id, sectionId: section.id, step: node });
            }
        }
    }

    return index;
};

// ---------------------------------------------------------------------------
// Raw-export scoping (the only place a browser asks for recorded events)
// ---------------------------------------------------------------------------

// Which recorded turns a thread's JSON transcript needs.
//
// The document quotes the thread's OWN turns plus the events of OTHER turns that
// belong to that thread's delegation subtree (ui/thread-transcript.ts:293). The
// selection inputs are all compiled: the roster names a thread's invocations
// (`invocationId`/`originInvocationId`/`invocationIds`), and a display section names
// its `invocationId`. So the browser can decide precisely which turns to `…/raw`
// without reading a single event.
// A roster row, read structurally so BOTH spellings the server publishes satisfy it: the raw
// `SessionThread` (protocol.ts:362, carries `messages`) and the display wire's compact
// `SessionView.threadViews` row (`SessionThreadView`, protocol.ts:408, carries the transcript
// SIGNAL instead). Nothing here needs more than the identity fields.
type RosterIdentity = {
    id: string;
    ownerThreadId?: string;
    invocationId?: string;
    originInvocationId?: string;
    invocationIds?: readonly string[];
};

export const transcriptTurnIdsOf = (
    view: SessionView | undefined,
    threadId: string,
    roster: readonly RosterIdentity[] = []
): string[] => {
    // 1. the subtree: the target thread plus every thread it owns.
    const doomed = new Set<string>([threadId]);
    for (let cursor = 0; cursor < [...doomed].length; cursor += 1) {
        const owner = [...doomed][cursor];
        for (const entry of roster) {
            if (entry.ownerThreadId === owner && !doomed.has(entry.id)) doomed.add(entry.id);
        }
    }

    // 2. every invocation id that belongs to that subtree (the join the roster owns).
    const invocations = new Set<string>();
    for (const entry of roster) {
        if (!doomed.has(entry.id)) continue;
        if (entry.invocationId !== undefined) invocations.add(entry.invocationId);
        if (entry.originInvocationId !== undefined) invocations.add(entry.originInvocationId);
        for (const id of entry.invocationIds ?? []) invocations.add(id);
    }

    const ids: string[] = [];

    for (const summary of summariesOf(view)) {
        if (summary.threadId !== undefined && doomed.has(summary.threadId)) {
            ids.push(summary.id);
            continue;
        }

        // 3. a foreign turn whose tree ran one of those invocations contributes
        //    related events to the document, so its record must be readable.
        const sections = sectionsOf(displayOf(view, summary.id));
        if (sections.some((section) => section.invocationId !== undefined && invocations.has(section.invocationId as string)))
            ids.push(summary.id);
    }

    return ids;
};

// ---------------------------------------------------------------------------
// The op reducer (state half of the ops renderer)
// ---------------------------------------------------------------------------

// Where the server's per-section pending snapshot lives locally. `TurnSection` has
// no such field (the wire carries it in `pending:set`), and the display document is
// the server's shape — so this map sits BESIDE it instead of inventing a field.
export type PendingSections = Map<string, HarnessPendingTool[]>;

export const pendingKeyOf = (turnId: string, sectionId: string): string => `${turnId}${sectionId}`;

// One section's compiled steps/nodes addressed by id. The renderer and the reducer
// both need it, and it is the ONLY way either of them finds a node: never position,
// never name, never arrival order (the invariant at turn-display.ts:36).
export const findNode = (display: TurnDisplay | undefined, sectionId: string, nodeId: string): DisplayNode | undefined => {
    const section = sectionsOf(display).find((candidate) => candidate.id === sectionId);
    if (section === undefined) return undefined;

    return nodesOf(section).find((node) => node.id === nodeId);
};

const findSection = (display: TurnDisplay | undefined, sectionId: string): TurnSection | undefined =>
    sectionsOf(display).find((candidate) => candidate.id === sectionId);

// Insert a fresh node, honoring an explicit `index` (out-of-order recovery only).
const insertNode = (section: TurnSection, node: DisplayNode, index: number | undefined): void => {
    const nodes = nodesOf(section);

    if (index === undefined || index < 0 || index >= nodes.length) {
        nodes.push(node);
        return;
    }

    nodes.splice(index, 0, node);
};

// Detach a node by id. An emptied `.tool-group` equivalent (nothing to do here —
// the DOM renderer owns that cleanup) is why this is state-only.
const removeNode = (section: TurnSection, nodeId: string): boolean => {
    const nodes = nodesOf(section);
    const index = nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) return false;

    nodes.splice(index, 1);
    return true;
};

// Apply ONE op to one turn's display tree, in place. Returns true when the op found
// its target (a false return means the frame named a turn/section this client does
// not hold, i.e. the terminal `view` frame must reconcile it).
//
// Rules come straight from turn-display.ts:521 and are NOT re-derived here:
//   - `step:set` REPLACES the step object (no field merge);
//   - `section:set` patches only the fields it names;
//   - text content moves only through `node:append`;
//   - `attempt:discard` names the exact nodes to drop;
//   - `attempt:commit` closes the window, so every uncommitted prose/reasoning node
//     of that section becomes committed (the flag is display-only — the server sends
//     explicit removes — but a reloaded client still styles the window correctly).
export const applyOpToDisplay = (
    display: TurnDisplay,
    turnId: string,
    op: TurnDisplayOp,
    pending: PendingSections
): boolean => {
    switch (op.op) {
        case 'turn':
            // The summary upsert lives on the view, not the tree (see `applyOp`);
            // the display has nothing to change.
            return true;

        case 'section:open': {
            if (display.turnId !== turnId) return false;
            if (findSection(display, op.section.id) !== undefined) return true;

            display.sections.push(op.section);
            const ordinal = Number(op.section.id.split(':').pop());
            if (Number.isFinite(ordinal)) {
                display.lastSectionOrdinal = Math.max(display.lastSectionOrdinal ?? 0, ordinal);
            }

            return true;
        }

        case 'section:set': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            // `patch` fields are optional-by-contract: absent means unchanged.
            const patch = op.patch;
            if (patch.state !== undefined) section.state = patch.state;
            if (patch.role !== undefined) section.role = patch.role;
            if (patch.model !== undefined) section.model = patch.model;
            if (patch.agentLabel !== undefined) section.agentLabel = patch.agentLabel;
            if (patch.invocationId !== undefined) section.invocationId = patch.invocationId;
            if (patch.threadId !== undefined) section.threadId = patch.threadId;
            if (patch.threadLabel !== undefined) section.threadLabel = patch.threadLabel;
            if (patch.branchId !== undefined) section.branchId = patch.branchId;
            if (patch.startedAt !== undefined) section.startedAt = patch.startedAt;
            if (patch.endedAt !== undefined) section.endedAt = patch.endedAt;
            if (patch.latestInput !== undefined) section.latestInput = patch.latestInput;
            if (patch.cachedInput !== undefined) section.cachedInput = patch.cachedInput;
            if (patch.answerNodeId !== undefined) section.answerNodeId = patch.answerNodeId;

            return true;
        }

        case 'node:insert': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;
            // A re-delivered insert (a reconnect replaying a frame) must not mint a
            // duplicate node: the id is the identity.
            if (nodesOf(section).some((node) => node.id === op.node.id)) return true;

            insertNode(section, op.node, op.index);
            return true;
        }

        case 'node:append': {
            const node = findNode(display, op.sectionId, op.nodeId);
            if (node === undefined || (node.kind !== 'text' && node.kind !== 'reasoning')) return false;

            node.text += op.delta;
            return true;
        }

        case 'node:set': {
            const node = findNode(display, op.sectionId, op.nodeId);
            if (node === undefined) return false;

            if (op.patch.committed !== undefined && node.kind === 'text') node.committed = op.patch.committed;
            if (op.patch.share !== undefined && node.kind === 'reasoning') node.share = op.patch.share;

            return true;
        }

        case 'node:remove': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            return removeNode(section, op.nodeId);
        }

        case 'step:set': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            const nodes = nodesOf(section);
            const index = nodes.findIndex((node) => node.id === op.step.id);

            // "A `step:set` for a step that is not yet present" follows an
            // `node:insert`; if the insert was missed, appending is the recovery that
            // keeps the tree equal to the server's rather than dropping a settled
            // step forever.
            if (index < 0) {
                nodes.push(op.step);
                return true;
            }

            nodes[index] = op.step;
            return true;
        }

        case 'pending:set': {
            const key = pendingKeyOf(turnId, op.sectionId);
            if (op.pending === undefined) pending.delete(key);
            else pending.set(key, op.pending);

            return findSection(display, op.sectionId) !== undefined;
        }

        case 'usage': {
            // `sectionId === 'turn'` is the turn-wide line (the tile); anything else
            // is that invocation's own block.
            if (op.sectionId === 'turn') return true;

            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            if (op.latestInput !== undefined) section.latestInput = op.latestInput;
            if (op.cachedInput !== undefined) section.cachedInput = op.cachedInput;

            return true;
        }

        case 'attempt:commit': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            for (const node of nodesOf(section)) {
                if (node.kind === 'text' && !node.committed) node.committed = true;
            }

            return true;
        }

        case 'attempt:discard': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            for (const nodeId of op.nodeIds) removeNode(section, nodeId);

            return true;
        }

        // Unreachable while the union stays exhaustive; a server that gains an op
        // kind must not make this renderer claim it applied something.
        default:
            return false;
    }
};

// Apply a whole frame's ops to one turn's tree. Missing trees are tolerated: an
// `ops` frame for an unknown turn is a no-op (the terminal `view` frame reconciles).
export const applyOpsToDisplay = (
    view: SessionView,
    turnId: string,
    ops: readonly TurnDisplayOp[],
    pending: PendingSections
): void => {
    const display = displayOf(view, turnId);
    if (display === undefined) return;

    for (const op of ops) void applyOpToDisplay(display, turnId, op, pending);
};

// Upsert one summary into the view's row list: replace in place by id (order is the
// server's recorded order, never re-sorted locally), append when new.
export const upsertSummary = (view: SessionView | SessionViewSummary, summary: TurnSummary): void => {
    const rows = summariesOf(view as SessionView);
    const index = rows.findIndex((row) => row.id === summary.id);

    if (index < 0) rows.push(summary);
    else rows[index] = summary;

    // Keep `displays` self-consistent: `SessionView.displays` is documented as
    // present ONLY for turns named in `turns`.
    if ('displays' in view && view.displays !== null && typeof view.displays === 'object') {
        const displays = view.displays as Record<string, TurnDisplay>;
        for (const turnId of Object.keys(displays)) {
            if (rows.some((row) => row.id === turnId)) continue;
            delete displays[turnId];
        }
    }
};

// Apply one `turn` upsert op to the view document (the row half; the tree half is a
// no-op, see `applyOpToDisplay`).
export const applyOpToView = (view: SessionView, op: TurnDisplayOp, pending: PendingSections): void => {
    if (op.op === 'turn') upsertSummary(view, op.summary);
    else if (op.op === 'usage' && op.sectionId === 'turn') {
        const summary = summariesOf(view).find((row) => row.id === op.turnId);
        if (summary === undefined) return;

        if (op.usage !== undefined) summary.usage = op.usage;
        if (op.latestInput !== undefined) summary.latestInput = op.latestInput;
        if (op.cachedInput !== undefined) summary.cachedInput = op.cachedInput;
    } else applyOpsToDisplay(view, op.turnId, [op], pending);
};

// ---------------------------------------------------------------------------
// The store the shell holds
// ---------------------------------------------------------------------------

export type ViewStateChange = {
    // What this frame touched, so the board repaints exactly those turns. A `view`
    // frame names every turn (it is self-sufficient by contract).
    kind: 'view' | 'ops' | 'failed' | 'ignored';
    turnIds: string[];
    view?: SessionView;
    ops?: readonly TurnDisplayOp[];
};

export type ViewStateStore = {
    // The live document (mutable). Undefined until the first frame.
    view: () => SessionView | undefined;
    // Adopt a whole `view` document (open frame, drain frame, a GET answer, the 202
    // answer). Returns the stored document.
    setView: (view: SessionView) => SessionView;
    // Apply one stream frame.
    applyItem: (item: SessionViewStreamItem) => ViewStateChange;
    // Apply one ops frame.
    applyOps: (turnId: string, ops: readonly TurnDisplayOp[]) => void;
    // The server's last pending snapshot for one section (undefined = "this frame
    // says nothing", an empty array = "nothing is running").
    pendingOf: (turnId: string, sectionId: string) => HarnessPendingTool[] | undefined;
    // Drop everything (session switch / teardown).
    reset: () => void;
};

// One observer connection's compiled state. The store owns the document AND the
// per-section pending snapshots; it never copies a row out of them, so a selector
// reading `store.view()` and the board reading its mirror can never disagree.
export const createViewStateStore = (): ViewStateStore => {
    let current: SessionView | undefined;
    const pending: PendingSections = new Map();

    const setView = (view: SessionView): SessionView => {
        current = view;

        // A whole-document frame is authoritative for the pending snapshots too: they
        // arrive only through ops, so a fresh view replaces whatever a partial
        // connection had accumulated.
        pending.clear();

        return view;
    };

    const applyOps = (turnId: string, ops: readonly TurnDisplayOp[]): void => {
        if (current === undefined) return;

        for (const op of ops) applyOpToView(current, op, pending);
        void turnId;
    };

    const applyItem = (item: SessionViewStreamItem): ViewStateChange => {
        if (item === null || typeof item !== 'object') return { kind: 'ignored', turnIds: [] };

        if (item.type === 'view') {
            setView(item.view);

            return { kind: 'view', turnIds: turnIdsOf(item.view), view: item.view };
        }

        if (item.type === 'ops') {
            applyOps(item.turnId, item.ops);

            return { kind: 'ops', turnIds: [item.turnId], ...(item.ops === undefined ? {} : { ops: item.ops }) };
        }

        if (item.type === 'failed') {
            // The error terminal still carries the full view (protocol.ts:658).
            setView(item.view);

            return { kind: 'failed', turnIds: turnIdsOf(item.view), view: item.view };
        }

        return { kind: 'ignored', turnIds: [] };
    };

    return {
        view: () => current,
        setView,
        applyItem,
        applyOps,
        pendingOf: (turnId, sectionId) => pending.get(pendingKeyOf(turnId, sectionId)),
        reset: () => {
            current = undefined;
            pending.clear();
        }
    };
};

// The view a submit answer carries (`view` + the accepted/owning `turn`). Exposed as
// a helper so the shell reads the answer through the same upsert rule as a frame.
export const applySubmitViewResult = (store: ViewStateStore, result: SubmitTaskViewResult): SessionView | undefined => {
    if (result === null || typeof result !== 'object' || result.view === undefined) return undefined;

    store.setView(result.view);

    return store.view();
};
