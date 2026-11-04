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
    ContextBlock,
    ContextBlockPatch,
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
// The document OWNS its own copy of an inserted node.
//
// Two consumers read one ops frame: this reducer mutates the cached display, and the tile
// renderer replays the SAME array (`view-api.ts` -> `applyOpsToDisplay` then
// `TurnBoard.applyViewOps`, with the identical `ops`). Storing the caller's node object means a
// later op in that array rewrites an earlier one: `node:append` does `node.text += delta` on the
// node the `node:insert` op carries, so by the time the tile reaches the insert its `text` is
// already advanced, and the insert paint plus the append paint print the delta twice. That is
// the shape an R23 tail frame always has — a streamed answer arrives as
// `node:insert {text:''}` + `node:append {delta}` — so the alias is not hypothetical.
//
// A shallow copy is the whole fix. Every field a later op writes on a stored node is a scalar
// (`text`, `chars`, `committed`, `redacted`, `unredacted`, `share`), and a step's or action's
// payload is REPLACED whole by `step:set` rather than mutated in place.
const insertNode = (section: TurnSection, node: DisplayNode, index: number | undefined): void => {
    const nodes = nodesOf(section);
    const owned = { ...node };

    if (index === undefined || index < 0 || index >= nodes.length) {
        nodes.push(owned);
        return;
    }

    nodes.splice(index, 0, owned);
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

// The section's own share of the turn's ONE context bar. `context:add` on a section whose
// `context` is ABSENT (a pre-T9 tree the projector started appending to) defines the array:
// from that frame on the server IS authoritative for this bar.
const ensureContext = (section: TurnSection): ContextBlock[] => {
    if (!Array.isArray(section.context)) section.context = [];

    return section.context;
};

// Apply ONE op to one turn's display tree, in place. Returns true when the op found
// its target (a false return means the frame named a turn/section this client does
// not hold, i.e. the terminal `view` frame must reconcile it).
//
// Rules come straight from turn-display.ts:521 and are NOT re-derived here:
//   - `step:set` REPLACES the step object (no field merge);
//   - `section:set` patches only the fields it names;
//   - `section:remove` detaches a section the server discards (a never-adopted
//     delegation placeholder, turn-projector.ts:503);
//   - text content moves only through `node:append`, except a notice's line, which
//     `node:set {text}` rewrites in place (turn-display.ts:380);
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

            // T13 (contract decision): the exact length must converge on BOTH paths, so
            // an UNREDACTED prose node keeps `chars` equal to the bytes the server sent.
            // This is not a measurement of a bounded preview: `DisplayTextNode.chars` /
            // `DisplayReasoningNode.chars` (../shared/turn-display.ts:659, 684) state that
            // an un-redacted node's `text` IS its complete recorded text, so the delta
            // stream is the authoritative source for the figure. The moment a `node:set`
            // patch marks the node `redacted`, that equality ends and only the SERVER's
            // `chars` figure is kept (see `node:set` below).
            if (node.redacted !== true) node.chars = node.text.length;

            return true;
        }

        case 'node:set': {
            const node = findNode(display, op.sectionId, op.nodeId);
            if (node === undefined) return false;

            if (op.patch.committed !== undefined && node.kind === 'text') node.committed = op.patch.committed;
            if (op.patch.share !== undefined && node.kind === 'reasoning') node.share = op.patch.share;
            // T13 (contract decision): `text` is an ADDRESSED, SERVER-STATED replacement for
            // the node it names, and it applies to every text-carrying kind — not only the
            // T4 notice line. The projector sends it three ways: a per-section status line
            // rewritten in place (turn-display.ts:712-725), a think window's bounded preview
            // at the moment the wire stops carrying its bytes (../server/turn-projector.ts
            // `case 'reasoning'`), and a superseded answer's preview at redaction
            // (`redactSuperseded`). The cold `display()` carries the SAME value, so applying
            // it here is what makes a live tree equal a reloaded one; skipping it left the
            // live think chip EMPTY and kept a superseded answer expanded. This is still no
            // client-side compilation: the server named the node, the field and the bytes.
            if (
                op.patch.text !== undefined &&
                (node.kind === 'notice' || node.kind === 'text' || node.kind === 'reasoning')
            )
                node.text = op.patch.text;

            // T9 additions, applied verbatim (turn-display.ts:692-698). `chars` keeps
            // arriving while a bounded node's TEXT has stopped moving (the wire caps it at
            // `DISPLAY_NODE_PREVIEW_CHARS`), so the think chip's figure stays exact after
            // the stream stopped carrying bytes. `redacted` arrives in the SAME patch that
            // swaps a superseded answer for its preview, which is how redaction is STATED
            // rather than inferred from a length comparison.
            //
            // T23 (R23) adds the mirror image: `unredacted` states that the node the
            // projector just re-designated as its section's tail carries its WHOLE text
            // again (a discarded attempt removed the block that superseded it). Dropping
            // the marker here is what keeps a live tree byte-equal to the cold document,
            // which carries the same node with no marker at all.
            if (node.kind === 'text' || node.kind === 'reasoning') {
                if (op.patch.chars !== undefined) node.chars = op.patch.chars;
                if (op.patch.redacted === true) node.redacted = true;
                if (op.patch.unredacted === true) delete node.redacted;
            }

            return true;
        }

        case 'section:remove': {
            // Exactly the mirror of `section:open` (turn-display.ts:530): a delegation
            // placeholder row that never ran is dropped by id. The pending snapshot the
            // `pending:set` ops parked beside the document goes with it, because it is
            // addressed by turn + section and would otherwise be unreachable.
            const index = sectionsOf(display).findIndex((section) => section.id === op.sectionId);
            if (index < 0) return false;

            display.sections.splice(index, 1);
            pending.delete(pendingKeyOf(turnId, op.sectionId));

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

        // --- context bar (T9 wire, T11 renderer) --------------------------
        //
        // A context block is addressed by `blockId` inside one section, exactly like a
        // node inside a section. Same three rules as the node ops, no new machinery:
        //   - `context:add` is IDEMPOTENT by id (a reconnect replaying a frame must not
        //     mint a second segment and double the bar's characters);
        //   - `context:set` patches ONLY the fields it names, and every count is a full
        //     replacement, never a delta (turn-display.ts:478);
        //   - identity (`id`/`kind`/`turnId`/`sectionId`/`eventFrom`) never changes in
        //     place, so there is nothing to reconcile here when they differ.
        case 'context:add': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            const blocks = ensureContext(section);
            const index = blocks.findIndex((block) => block.id === op.block.id);

            if (index >= 0) {
                // A re-delivered add replaces the segment in place rather than appending
                // a duplicate: the id is the identity (see `node:insert` above).
                blocks[index] = op.block;

                return true;
            }

            if (op.index === undefined || op.index < 0 || op.index > blocks.length) blocks.push(op.block);
            else blocks.splice(op.index, 0, op.block);

            return true;
        }

        case 'context:set': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            const block = ensureContext(section).find((candidate) => candidate.id === op.blockId);
            if (block === undefined) return false;

            const patch = op.patch;
            if (patch.name !== undefined) block.name = patch.name;
            if (patch.state !== undefined) block.state = patch.state;
            if (patch.chars !== undefined) block.chars = patch.chars;
            if (patch.argsChars !== undefined) block.argsChars = patch.argsChars;
            if (patch.resultChars !== undefined) block.resultChars = patch.resultChars;
            if (patch.inPrompt !== undefined) block.inPrompt = patch.inPrompt;
            if (patch.at !== undefined) block.at = patch.at;
            if (patch.endedAt !== undefined) block.endedAt = patch.endedAt;
            if (patch.eventTo !== undefined) block.eventTo = patch.eventTo;

            // `durationMs` is the measured span the projector stamps beside `at`/`endedAt`.
            // Read structurally so this reducer is correct before AND after the shared
            // type carries the field, and never re-derives a span the server did not send.
            const measured = (patch as ContextBlockPatch & { durationMs?: number }).durationMs;
            if (measured !== undefined) (block as ContextBlock & { durationMs?: number }).durationMs = measured;

            return true;
        }

        case 'context:remove': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            // ABSENT context means this client never received a bar for the section, which
            // is not the same as an empty one: the frame names a block that cannot be
            // there, so the honest answer is "not found" and the terminal `view` frame
            // reconciles.
            const blocks = Array.isArray(section.context) ? section.context : undefined;
            if (blocks === undefined) return false;

            const index = blocks.findIndex((block) => block.id === op.blockId);
            if (index < 0) return false;

            blocks.splice(index, 1);

            return true;
        }

        // --- the ONE current tail block (T23 wire, R23) -------------------
        //
        // The descriptor is a whole replacement, never a merge (turn-display.ts:1096): the
        // pointer, the exact figure and the tool payload move together, so a section can
        // never hold the designation of one block and the payload of another. `tail:clear`
        // is the server stating "this section displays no block" — deliberately different
        // from a document in which the field is absent, which means a producer that said
        // nothing at all (the same absent-vs-empty rule `section.context` follows).
        case 'tail:set': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            section.tail = op.tail;

            return true;
        }

        case 'tail:clear': {
            const section = findSection(display, op.sectionId);
            if (section === undefined) return false;

            // Clearing a designation this client never received is still the server's
            // answer for the section (it has nothing to display), so the state is applied
            // and reported — unlike a `context:remove` for a segment that cannot exist.
            if (section.tail !== undefined) delete section.tail;

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
//
// MONOTONIC per id (the same N2 rule `applyView` implements for `instance.records`,
// main.ts:6789): a row stamped strictly BEFORE the row this document already holds is
// a late answer — the 202 body of a submit captured before the observer delivered a
// newer revision — and it is authoritative for NOTHING. Applying it would regress the
// tile (a `queued` row painted over a `streaming` one), so it is dropped. An EQUAL
// stamp still applies: the server bumps `updatedAt` on every state change, so equal is
// the same moment, not an older one.
export const upsertSummary = (view: SessionView | SessionViewSummary, summary: TurnSummary): void => {
    const rows = summariesOf(view as SessionView);
    const index = rows.findIndex((row) => row.id === summary.id);

    if (index >= 0 && isNewerSummary(rows[index] as TurnSummary, summary)) return;

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

// True when `known` was stamped strictly after `incoming`, i.e. `incoming` is a late
// revision of the same turn. A row without a usable stamp on either side is applied
// (never blocked), because the server always stamps and an absent figure means this
// client cannot compare, not that the row is old.
export const isNewerSummary = (known: TurnSummary | undefined, incoming: TurnSummary): boolean => {
    if (known === undefined) return false;

    const knownAt = known.updatedAt;

    return (
        typeof knownAt === 'number' &&
        Number.isFinite(knownAt) &&
        typeof incoming.updatedAt === 'number' &&
        Number.isFinite(incoming.updatedAt) &&
        knownAt > incoming.updatedAt
    );
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
// Live activity from an ops frame (the display-wire replacement for
// `ui/activity.ts`'s event reducer)
// ---------------------------------------------------------------------------

// Which agents are working BETWEEN row upserts.
//
// `activeAgentsOf` answers that from the DOCUMENT (a hydration, a poll, a drain frame). A
// live connection only receives ops, and the projector's ops carry exactly the same
// transitions the raw reducer reads off events:
//   - `section:open` / a `section:set` to `open|streaming`  ← a `start` (ui/activity.ts:60);
//   - a `section:set` to `done|error|cancelled`             ← a child's `done`/`error` (l:78-118);
//   - an `error`-tone notice node                            ← the root's `error` event, which
//     closes THAT agent without closing the turn (the root section's state belongs to the
//     turn, turn-projector.ts:1330);
//   - a `retry`/`wake` notice                                ← `retry`/`wakeup` (l:73, l:53);
//   - `node:insert`/`node:append`/`step:set`/`pending:set`/`usage`/`attempt:commit`
//                                                            ← text, reasoning, tool frames,
//      a usage report and a committed request (l:61-75).
//
// Nothing here re-derives a meaning from content: every rule is triggered by an ADDRESSED
// mutation the server already decided. The set is the caller's live set (mutated in
// place, one per instance) and the caller replaces it wholesale on a whole-document
// frame, because the document is then authoritative.
//
// Additions are gated on the turn still RUNNING (the same status guard
// `activityOfTurns` applies): a settled turn must never animate old work. Removals are
// unconditional — a `done` for one agent of a turn this client stopped tracking still
// has to take its ring off.
const TERMINAL_SECTION_STATES: readonly string[] = ['done', 'error', 'cancelled'];

export const applyOpsToActivity = (
    active: Set<string>,
    view: SessionView | undefined,
    turnId: string,
    ops: readonly TurnDisplayOp[]
): void => {
    if (view === undefined) return;

    const display = displayOf(view, turnId);
    const row = summariesOf(view).find((summary) => summary.id === turnId);

    // `running` tracks THIS frame's knowledge: the pre-state row, advanced by any `turn`
    // op the frame carries, so a frame that settles the turn removes the rings it names
    // instead of adding them back from its own section ops.
    let running = row !== undefined && row.status === 'running';

    // The agent a section id names, from the tree as it stands BEFORE the frame (which is
    // what the caller passes): the only case that needs it after the mutation is
    // `section:remove`, where the tree no longer holds the section.
    const agentOf = (sectionId: string): string | undefined =>
        sectionsOf(display).find((section) => section.id === sectionId)?.agent;

    for (const op of ops) {
        switch (op.op) {
            case 'turn': {
                if (op.summary.status === 'running') {
                    running = true;
                    for (const name of op.summary.activeAgents) {
                        if (typeof name === 'string' && name.length > 0) active.add(name);
                    }
                    break;
                }

                // The turn ended: every agent it was holding is idle, and a row that
                // settled reports `activeAgents: []` (turn-projector.ts:1717), so the
                // removal below is the server's own figure, not an inference.
                for (const name of row?.activeAgents ?? []) active.delete(name);
                for (const section of sectionsOf(display)) active.delete(section.agent);
                running = false;
                break;
            }

            case 'section:open': {
                if (TERMINAL_SECTION_STATES.includes(op.section.state)) {
                    active.delete(op.section.agent);
                    break;
                }
                if (running) active.add(op.section.agent);
                break;
            }

            case 'section:set': {
                const agent = agentOf(op.sectionId);
                if (agent === undefined) break;

                if (op.patch.state === undefined) break;
                if (TERMINAL_SECTION_STATES.includes(op.patch.state)) active.delete(agent);
                else if (running) active.add(agent);
                break;
            }

            case 'section:remove': {
                const agent = agentOf(op.sectionId);
                if (agent !== undefined) active.delete(agent);
                break;
            }

            case 'node:insert': {
                const agent = agentOf(op.sectionId);

                // A notice is the server's own wording of a lifecycle line: only the
                // `error` tone closes an agent, and a `retry`/`wake` line re-opens it (the
                // exact pair the raw reducer forms from `error`/`retry`/`wakeup` events).
                // T16 (R16a): the fold no longer MINTS a `retry` notice — a retried request
                // keeps this agent lit through `section:open`/`node:*`/`step:set` alone, and
                // `attempt:discard` is deliberately neutral below. The branch stays so a
                // document from an older fold still resolves the same way.
                if (op.node.kind === 'notice') {
                    if (op.node.tone === 'error') {
                        if (agent !== undefined) active.delete(agent);
                        break;
                    }

                    if (agent !== undefined && running) active.add(agent);
                    break;
                }

                // Prose, a think chip, a tool row and an owner question are all mid-run
                // work of the invocation that produced them.
                if (agent !== undefined && running) active.add(agent);
                break;
            }

            case 'node:append':
            case 'step:set':
            case 'pending:set':
            case 'attempt:commit': {
                const agent = agentOf(op.sectionId);
                if (agent !== undefined && running) active.add(agent);
                break;
            }

            case 'usage': {
                if (op.sectionId === 'turn') break;
                const agent = agentOf(op.sectionId);
                if (agent !== undefined && running) active.add(agent);
                break;
            }

            // `node:set`, `node:remove` and `attempt:discard` change content, not who is
            // working; the raw reducer ignores their events for the same reason. So do the
            // `context:*` ops (T11): a bar segment is metadata about text that already
            // moved activity through its own `node:insert`/`step:set`/`turn` frame.
            default:
                break;
        }
    }
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
