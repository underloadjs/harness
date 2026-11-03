// Server-only turn projector (R1/R3/R4).
//
// This is the fold the browser used to do. It turns ONE turn's recorded
// `HarnessEvent` stream into (a) a compact `TurnDisplay` tree, (b) a compact
// `TurnSummary` row, and (c) the `TurnDisplayOp`s that keep a live renderer in step.
// It is DOM-free, and it lives in `src/server` deliberately: the browser imports the
// TYPES from `../shared/turn-display.ts` and never this runtime, so a page pull adds
// no fold code and no module cycles.
//
// THE ONE RULE — live and replay are the same code path. The cold fold
// `projectTurn()` (restore, and every `getView`) is literally
// `createTurnProjector()` + `apply()` per recorded event + `settle()`. The recorder
// calls the identical `apply()` once per stored event (./sessions.ts:4217), so a
// reload paints exactly what the stream painted, and the compiled state is a CACHE
// the store updates as it goes — never a computation per request.
//
// Behavioural source of truth (each handler cites what it reproduces):
//   - ../frontend/ui/turns.ts:3969-4095  routing: explicit `thread` metadata is
//                                        authoritative; a conversation-root record
//                                        (no parent/call/kind/branch) is the TURN'S
//                                        OWN run, not a child; legacy events route to
//                                        the entry agent's root, else to the single
//                                        started non-terminal section for that agent,
//                                        else to an `inline:<agent>` section
//   - ../frontend/ui/turns.ts:4760-4910  pairing: `callId` is authoritative, the
//                                        name+oldest fallback is ONLY for a frame
//                                        with no id, a result for an already-settled
//                                        id is a duplicate and renders nothing, and a
//                                        result with no matching call is still shown
//   - ../frontend/ui/turns.ts:4496-4623  attempt windows: a `retry` discards exactly
//                                        the nodes, cards and delegation placeholders
//                                        THIS attempt created (a sibling's stay), and
//                                        `attempt_commit`/`done` close the window
//                                        without discarding and detach the writers
//   - ../frontend/ui/turns.ts:4262-4328  pending snapshot rules (an ABSENT `pending`
//                                        array is not a drain signal) plus the exact
//                                        retry / wakeup / pending line texts
//   - ../frontend/ui/turns.ts:5154-5186  the parent's tool_result is the authoritative
//                                        completion of the child its call spawned
//   - ../frontend/ui/time.ts:19 and ./cli/render.ts:83  `formatDuration`
//   - ../frontend/ui/markdown.ts:474     `plainPreview`
//   - ../frontend/ui/references.ts:44    `isReferenceableBlock`
//   - ./sessions.ts:679                  a restored action request is EXPIRED
//
// What this file never does: it never edits the raw record (`turn.events` stays the
// authority and the lazy detail route serves those bytes verbatim), it never invents
// a value for an absent optional field, and it never renders a steer (steers are not
// events — `TurnSummary.steers` carries the destination section id, which is what the
// board consumes today via `turns.ts:390 tryRenderSteer`).

import type { HarnessEvent, HarnessPendingTool, HarnessToolOutcome } from '../harness';
import type { AgentResultBlock } from '../shared/agent-results';
import {
    DISPLAY_ARGS_PREVIEW_CHARS,
    DISPLAY_ATTACHMENT_INLINE_CHARS,
    DISPLAY_BLOCK_PREVIEW_CHARS,
    DISPLAY_ERROR_CHARS,
    DISPLAY_MEDIA_PER_STEP,
    DISPLAY_NOTICE_CHARS,
    DISPLAY_PANEL_PREVIEW_CHARS,
    DISPLAY_PANEL_TITLE_CHARS,
    DISPLAY_PANELS_PER_STEP,
    DISPLAY_PREVIEW_CHARS
} from '../shared/turn-display';
import type {
    DisplayActionSummary,
    DisplayMediaSummary,
    DisplayNode,
    DisplayPanelBlockSummary,
    DisplayPanelSummary,
    DisplayProjectContext,
    DisplayRole,
    DisplayStep,
    DisplayedTurn,
    SectionDisplayState,
    StepDisplayState,
    TurnDisplay,
    TurnDisplayOp,
    TurnProjector,
    TurnRecordStatus,
    TurnSection,
    TurnSectionPatch,
    TurnSummary
} from '../shared/turn-display';
import type { SessionTurn } from './protocol';

// The turn's own root flow. INTERNAL key only: a section's wire identity is always
// its minted `${turnId}:${ordinal}` id, which is why a delegation placeholder can
// keep its id when a child `start` later adopts it. The browser had to re-key the
// row for that same moment (turns.ts:3960); the display model never does, so an
// expanded/anchored row cannot be lost mid-run.
const ROOT_KEY = 'root';

// A section's mutable status line ("pending · read 1.2s"). Stable per section, not
// derived from an event index, because it is one line that keeps being rewritten.
const PENDING_NODE_ID = 'pending';

const inlineKey = (agent: string): string => `inline:${agent}`;

// ---------------------------------------------------------------------------
// Text bounds shared with the renderer (mirrors, each cited)
// ---------------------------------------------------------------------------

/** Mirror of `formatDuration` (../frontend/ui/time.ts:19, copied by the CLI at
 *  ./cli/render.ts:83). The notice TEXT is composed here now, so all three surfaces
 *  keep one rule or a reader sees two different durations for one call. */
export const formatDuration = (milliseconds: number): string => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';

    const rounded = Math.round(milliseconds);
    if (rounded < 1000) return `${rounded}ms`;
    if (rounded < 60_000) return `${(rounded / 1000).toFixed(1)}s`;

    const seconds = Math.floor(rounded / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

/** Mirror of `plainPreview` (../frontend/ui/markdown.ts:474). Copied rather than
 *  imported because that module is frontend-owned; the rule itself is pure regex. */
export const previewText = (text: string, limit: number): string => {
    const source = typeof text === 'string' ? text : '';
    const flattened = source
        .replace(/```[^\n]*\n?/g, ' ')
        .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/`/g, '')
        .replace(/[*_~>#]+/g, ' ')
        .replace(/\|/g, ' ')
        .replace(/^\s*[-=]{3,}\s*$/gm, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+([.,!?;:])/g, '$1')
        .trim();

    if (flattened.length <= limit) return flattened;

    return `${flattened.slice(0, Math.max(0, limit - 1)).trimEnd()}\u2026`;
};

// `arguments` is the raw provider JSON string (types/index.ts:100-111) and stays
// unparsed for display: malformed JSON is the model's problem, not the preview's.
const previewArguments = (raw: unknown): string =>
    previewText(typeof raw === 'string' ? raw.replace(/\s*\n\s*/g, ' ') : '', DISPLAY_ARGS_PREVIEW_CHARS);

const outcomeState = (outcome: HarnessToolOutcome): StepDisplayState =>
    outcome === 'completed' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'error';

// `isError` is the boolean projection of `outcome` (types/index.ts:1816-1825), so a
// frame that predates `outcome` still reads correctly.
const outcomeOfResult = (event: HarnessEvent): HarnessToolOutcome => {
    if (event.type !== 'tool_result') return 'completed';

    const outcome = event.outcome;

    if (outcome === 'completed' || outcome === 'failed' || outcome === 'rejected' || outcome === 'cancelled') return outcome;

    return event.isError ? 'failed' : 'completed';
};

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// A `pending` array only counts when every entry is usable — the same validator the
// browser applies (../frontend/contract.ts:651). An ABSENT array is a different
// answer, and the caller must keep that distinction.
const pendingOf = (value: unknown): HarnessPendingTool[] | undefined => {
    if (!Array.isArray(value)) return undefined;

    const clean: HarnessPendingTool[] = [];

    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue;

        const candidate = entry as { callId?: unknown; name?: unknown; elapsedMs?: unknown };
        if (typeof candidate.callId !== 'string' || candidate.callId.length === 0) continue;
        if (typeof candidate.name !== 'string' || candidate.name.length === 0) continue;
        if (!finiteNumber(candidate.elapsedMs) || candidate.elapsedMs < 0) continue;

        clean.push({ callId: candidate.callId, name: candidate.name, elapsedMs: candidate.elapsedMs });
    }

    return clean;
};

// The delegation placeholder the tile mints when it SEES a `delegate` call
// (turns.ts:4807): the child row must exist before its `start`, keyed by the
// spawning call id. Same tolerant parse; a malformed argument blob simply yields no
// placeholder rather than a phantom row.
const delegateOf = (raw: unknown): { agent: string; input?: string } | undefined => {
    if (typeof raw !== 'string' || raw.length === 0) return undefined;

    try {
        const parsed = JSON.parse(raw) as { agent?: unknown; input?: unknown };

        if (typeof parsed.agent !== 'string' || parsed.agent.length === 0) return undefined;

        return { agent: parsed.agent, ...(typeof parsed.input === 'string' ? { input: parsed.input } : {}) };
    } catch {
        return undefined;
    }
};

// ---------------------------------------------------------------------------
// Bounded panel/media summaries (T3 qualification: never the unbounded originals)
// ---------------------------------------------------------------------------
//
// One result may legitimately carry 32 panels x 64 blocks and up to 256 KiB of cell
// text (core/tool-ui.ts:51-73). Forwarding that per step is the payload this whole
// change exists to remove, so the compact wire carries identity + counts + a first
// line, and says how much it left behind. Nothing is silently dropped: `truncated`
// and `totalPanels` point the renderer at the detail request, which answers with the
// verbatim event (and therefore the verbatim panels).

const panelSummaryOf = (panel: unknown, totalPanels: number): DisplayPanelSummary => {
    const source = (panel ?? {}) as { id?: unknown; slot?: unknown; title?: unknown; blocks?: unknown };
    const blocks = Array.isArray(source.blocks) ? source.blocks : [];
    const summaries: DisplayPanelBlockSummary[] = [];
    let preview: string | undefined;
    let truncated = false;

    for (const raw of blocks) {
        const block = (raw ?? {}) as Record<string, unknown>;

        if (block.type === 'text') {
            const text = typeof block.text === 'string' ? block.text : '';
            summaries.push({ type: 'text', length: text.length });
            truncated = truncated || text.length > DISPLAY_PANEL_PREVIEW_CHARS;
            preview ??= previewText(text, DISPLAY_PANEL_PREVIEW_CHARS);
            continue;
        }

        if (block.type === 'table') {
            const columns = Array.isArray(block.columns) ? (block.columns as unknown[]) : [];
            const rows = Array.isArray(block.rows) ? (block.rows as unknown[]) : [];
            summaries.push({ type: 'table', rows: rows.length, columns: columns.length });
            // Cell TEXT is the bulk of a panel, so it is detail-only by construction.
            truncated = true;
            const first = Array.isArray(rows[0]) ? (rows[0] as unknown[]) : [];
            preview ??= previewText(
                `${columns.map((cell) => String(cell ?? '')).join(' ')} \u00b7 ${first.map((cell) => String(cell ?? '')).join(' ')}`,
                DISPLAY_PANEL_PREVIEW_CHARS
            );
            continue;
        }

        if (block.type === 'keyValue') {
            const items = Array.isArray(block.items) ? (block.items as { label?: unknown; value?: unknown }[]) : [];
            summaries.push({ type: 'keyValue', items: items.length });
            truncated = true;
            preview ??= previewText(
                items
                    .slice(0, 2)
                    .map((item) => `${String(item?.label ?? '')} ${String(item?.value ?? '')}`)
                    .join(' \u00b7 '),
                DISPLAY_PANEL_PREVIEW_CHARS
            );
        }
    }

    const title = typeof source.title === 'string' ? source.title : '';

    return {
        id: typeof source.id === 'string' ? source.id.slice(0, 64) : '',
        // `slot` is an OPEN string by contract, with 'right' the default mount
        // (types/index.ts:1005-1017).
        slot: typeof source.slot === 'string' && source.slot.length > 0 ? source.slot.slice(0, 32) : 'right',
        title: previewText(title, DISPLAY_PANEL_TITLE_CHARS),
        blocks: summaries,
        ...(preview === undefined || preview.length === 0 ? {} : { preview }),
        truncated,
        totalPanels
    };
};

const summarizePanels = (ui: unknown): { panels?: DisplayPanelSummary[] } => {
    if (!Array.isArray(ui) || ui.length === 0) return {};

    const panels = ui.slice(0, DISPLAY_PANELS_PER_STEP).map((panel) => panelSummaryOf(panel, ui.length));

    if (ui.length > panels.length) {
        // Extra panels exist: mark the FIRST summary truncated too, so a renderer
        // offers the detail without needing a second signal.
        panels[panels.length - 1] = { ...panels[panels.length - 1], truncated: true };
    }

    return { panels };
};

const summarizeMedia = (media: unknown): { media?: DisplayMediaSummary[] } => {
    if (!Array.isArray(media) || media.length === 0) return {};

    const clean = (media as unknown[])
        .map((entry) => (entry ?? {}) as { id?: unknown; kind?: unknown; name?: unknown; mime?: unknown; size?: unknown })
        .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0)
        .filter((entry) => entry.kind === 'image' || entry.kind === 'video' || entry.kind === 'audio' || entry.kind === 'pdf' || entry.kind === 'file')
        .filter((entry) => typeof entry.name === 'string' && typeof entry.mime === 'string' && finiteNumber(entry.size))
        .slice(0, DISPLAY_MEDIA_PER_STEP)
        .map(
            (entry): DisplayMediaSummary => ({
                id: entry.id as string,
                kind: entry.kind as DisplayMediaSummary['kind'],
                name: entry.name as string,
                mime: entry.mime as string,
                size: entry.size as number
            })
        );

    return clean.length === 0 ? {} : { media: clean };
};

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

// Everything the CURRENT (uncommitted) model request produced. A `retry` removes
// exactly these ids (turns.ts:4496), which is why the client needs no attempt-window
// concept of its own.
type AttemptWindow = {
    nodeIds: string[];
    stepIds: string[];
    // Placeholder rows this attempt minted. A failed attempt never executed its
    // calls, so its child row goes with it — and only its own (F2).
    sectionKeys: string[];
    // Call ids this attempt opened, so a discard un-pairs them WITHOUT marking them
    // settled: a retried request may legally re-issue the same id (turns.ts:4521).
    callIds: string[];
};

type SectionRecord = {
    section: TurnSection;
    key: string;
    ordinal: number;
    agent: string;
    attempt?: AttemptWindow;
    // The live stream writers. Closing one detaches the pointer; the node stays.
    text?: DisplayNode & { kind: 'text' };
    reasoning?: DisplayNode & { kind: 'reasoning' };
    // This invocation's authoritative pending snapshot (turns.ts:4287).
    pendingCalls: Map<string, HarnessPendingTool>;
    started: boolean;
    terminal: boolean;
    placeholder: boolean;
    // The spawning call id of a delegation placeholder. Kept so a removal (a failed
    // attempt, or a turn that ended before the child ran) un-registers the join, and
    // so ADOPTION keeps the call -> child mapping alive: the parent's `tool_result`
    // still has to settle the child after the adoption (turns.ts:5154).
    spawnCallId?: string;
    latestInput?: number;
    cachedInput?: number;
    cachedReported: boolean;
};

// A step plus its detail addressing, kept together so the op stream and the lazy
// detail route can never disagree about which event opened and which settled it.
type StepRecord = {
    step: DisplayStep;
    sectionKey: string;
    openingIndex: number;
    resultIndex?: number;
};

const sectionStateOf = (status: TurnRecordStatus): SectionDisplayState =>
    status === 'done'
        ? 'done'
        : status === 'error'
          ? 'error'
          : status === 'cancelled'
            ? 'cancelled'
            : status === 'running'
              ? 'streaming'
              : 'open';

const abandonedStateOf = (status: TurnRecordStatus): StepDisplayState => (status === 'cancelled' ? 'cancelled' : 'error');

const TURN_STATE_OF: Record<TurnRecordStatus, 'queued' | 'streaming' | 'done' | 'error' | 'cancelled'> = {
    queued: 'queued',
    running: 'streaming',
    done: 'done',
    error: 'error',
    cancelled: 'cancelled'
};

const isTerminalStatus = (status: TurnRecordStatus): boolean => status === 'done' || status === 'error' || status === 'cancelled';

// Duplicate-result suppression is scoped to the INVOCATION. Call ids are unique per
// conversation (types/index.ts:104), and a delegated child may legally reuse the id
// its parent used for the delegation — a turn-wide "already settled" set would then
// drop the parent's real result.
const settleKey = (sectionKey: string, callId: string): string => `${sectionKey}\u0000${callId}`;

const copyValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const textOf = (value: unknown, limit: number): string => previewText(typeof value === 'string' ? value : '', limit);

const messageOf = (value: unknown): string => {
    const error = (value ?? {}) as { message?: unknown };

    return typeof error.message === 'string' ? error.message : '';
};

/**
 * Incremental fold for ONE live turn.
 *
 * `turn` is held BY REFERENCE on purpose: the store mutates `status`, `updatedAt`,
 * `steers` and `usage` on that same record, and the row must reflect the server's
 * truth without a second call. `apply()` itself is still a pure event -> ops map for
 * the node tree.
 */
export const createTurnProjector = (turn: SessionTurn, context: DisplayProjectContext): TurnProjector => {
    const sections: SectionRecord[] = [];
    const byKey = new Map<string, SectionRecord>();
    const byInvocation = new Map<string, SectionRecord>();
    const byCall = new Map<string, SectionRecord>();
    const byBranch = new Map<string, SectionRecord>();

    // Open calls in call order. The pairing search prefers the RESULT's own section
    // and only then falls back turn-wide, so a `call_1` id reused by a nested
    // invocation of the SAME turn cannot settle the root's call of the same name —
    // the scoping the T3 contract requires of the detail route.
    const openCalls: StepRecord[] = [];
    const settledCalls = new Set<string>();
    const steps = new Map<string, StepRecord>();
    const actionSteps = new Map<string, StepRecord>();

    let sectionOrdinal = 0;
    let stepCount = 0;
    let turnLatestInput: number | undefined;
    let lastError: string | undefined;
    let settledStatus: TurnRecordStatus | undefined;
    let settledAt: number | undefined;

    // Memoization: `listViews()`/`getView()` ask for the same row on every render,
    // and rebuilding it walks the tree and re-projects blocks. The stamp covers
    // every input the row derives from.
    let summaryStamp = '';
    let summaryCache: TurnSummary | undefined;
    let blocksCache: AgentResultBlock[] = [];
    let blocksStamp = '';

    const invalidate = (): void => {
        summaryCache = undefined;
    };

    // -----------------------------------------------------------------------
    // Sections
    // -----------------------------------------------------------------------

    const newSection = (key: string, agent: string, parentKey: string | undefined, placeholder: boolean): SectionRecord => {
        const parent = parentKey === undefined ? undefined : byKey.get(parentKey);
        const ordinal = sectionOrdinal++;
        const role: DisplayRole =
            parent === undefined && key === ROOT_KEY ? (agent === context.primary ? 'primary' : 'subagent') : 'subagent';

        const record: SectionRecord = {
            key,
            ordinal,
            agent,
            placeholder,
            started: !placeholder,
            terminal: false,
            pendingCalls: new Map(),
            cachedReported: false,
            section: {
                id: `${turn.id}:${ordinal}`,
                ...(parent === undefined ? {} : { parentSectionId: parent.section.id }),
                role,
                agent,
                // Labels arrive with the store's block projection / thread join; an
                // adopted child patches its own conversation label (R8/T14).
                agentLabel: key === ROOT_KEY ? turn.threadLabel ?? '' : '',
                ...(turn.threadId === undefined ? {} : { threadId: key === ROOT_KEY ? turn.threadId : undefined }),
                nodes: [],
                state: 'open'
            }
        };

        // `threadId: undefined` must not become an own-key with an undefined value
        // (the whole codebase omits absent fields so old shapes stay byte-identical).
        if (record.section.threadId === undefined) delete record.section.threadId;

        sections.push(record);
        byKey.set(key, record);

        return record;
    };

    const conversationLabelOf = (invocationId: string | undefined): string | undefined =>
        invocationId === undefined ? undefined : context.threadLabels?.get(invocationId);

    const openSection = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        ops.push({ op: 'section:open', turnId: turn.id, section: { ...copyValue(record.section), nodes: [] } });
        invalidate();
    };

    const patchSection = (record: SectionRecord, patch: TurnSectionPatch, ops: TurnDisplayOp[]): void => {
        const meaningful = Object.keys(patch).length > 0;

        if (!meaningful) return;

        Object.assign(record.section, patch);
        ops.push({ op: 'section:set', turnId: turn.id, sectionId: record.section.id, patch: copyValue(patch) });
        invalidate();
    };

    const removeSection = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        byKey.delete(record.key);
        if (record.spawnCallId !== undefined && byCall.get(record.spawnCallId) === record) byCall.delete(record.spawnCallId);
        if (record.section.invocationId !== undefined) byInvocation.delete(record.section.invocationId);
        if (record.section.branchId !== undefined) byBranch.delete(record.section.branchId);

        const index = sections.indexOf(record);
        if (index >= 0) sections.splice(index, 1);

        for (const step of [...steps.values()]) {
            if (step.sectionKey !== record.key) continue;
            steps.delete(step.step.id);
        }

        for (let position = openCalls.length - 1; position >= 0; position -= 1) {
            if (openCalls[position].sectionKey === record.key) openCalls.splice(position, 1);
        }

        ops.push({ op: 'section:remove', turnId: turn.id, sectionId: record.section.id });
        invalidate();
    };

    const rootSection = (agent: string): SectionRecord => {
        const existing = byKey.get(ROOT_KEY);
        if (existing !== undefined) return existing;

        const record = newSection(ROOT_KEY, agent, undefined, false);

        return record;
    };

    // A thread record with no parent, no spawning call, no kind and no branch is the
    // turn's OWN conversation (turns.ts:4063 — the same discriminator
    // ../shared/agent-results.ts uses), never an agent-spawned child.
    const isConversationRoot = (meta: NonNullable<HarnessEvent['thread']>): boolean =>
        meta.parentId === undefined && meta.callId === undefined && meta.kind === undefined && meta.branchId === undefined;

    const adoptPlaceholder = (record: SectionRecord, meta: NonNullable<HarnessEvent['thread']>, ops: TurnDisplayOp[]): void => {
        byKey.delete(record.key);
        record.key = meta.id;
        byKey.set(meta.id, record);
        // The spawn join STAYS: the parent's `tool_result` for this call settles the
        // child after the adoption too (turns.ts:5154).
        record.placeholder = false;
        record.started = true;

        if (!record.terminal) record.section.state = 'streaming';
        record.section.invocationId = meta.id;
        if (meta.branchId !== undefined) record.section.branchId = meta.branchId;
        byInvocation.set(meta.id, record);

        const label = conversationLabelOf(meta.id);

        patchSection(
            record,
            {
                invocationId: meta.id,
                ...(meta.branchId === undefined ? {} : { branchId: meta.branchId }),
                ...(record.terminal ? {} : { state: 'streaming' }),
                ...(label === undefined ? {} : { agentLabel: label, threadLabel: label })
            },
            ops
        );
    };

    const createChild = (
        meta: NonNullable<HarnessEvent['thread']>,
        agent: string,
        ops: TurnDisplayOp[],
        options: { state?: SectionDisplayState; branchId?: string; model?: string; role?: DisplayRole; threadId?: string } = {}
    ): SectionRecord => {
        const record = newSection(meta.id, agent, meta.parentId, false);

        byInvocation.set(meta.id, record);
        if (meta.callId !== undefined) byCall.set(meta.callId, record);
        if (meta.branchId !== undefined) byBranch.set(meta.branchId, record);
        if (options.branchId !== undefined) byBranch.set(options.branchId, record);

        const label = conversationLabelOf(meta.id);

        record.section.role = options.role ?? 'subagent';
        record.section.invocationId = meta.id;
        record.section.branchId = options.branchId ?? meta.branchId;
        record.section.model = options.model;
        record.section.threadId = options.threadId;
        record.section.agentLabel = label ?? '';
        record.section.threadLabel = label;
        record.section.state = options.state ?? 'streaming';

        openSection(record, ops);

        return record;
    };

    // A threadless stream from a non-entry agent still needs a flow of its own
    // (turns.ts:4039) so its prose and calls are not dropped.
    const inlineSection = (agent: string, ops: TurnDisplayOp[]): SectionRecord => {
        const key = inlineKey(agent);
        const existing = byKey.get(key);
        if (existing !== undefined) return existing;

        const record = newSection(key, agent, undefined, false);
        record.section.role = agent === context.primary ? 'primary' : 'subagent';

        openSection(record, ops);

        return record;
    };

    const queuedPlaceholder = (agent: string): SectionRecord | undefined =>
        sections.find((record) => record.placeholder && record.agent === agent);

    const route = (event: HarnessEvent, ops: TurnDisplayOp[]): SectionRecord => {
        const meta = event.thread;

        if (meta !== undefined) {
            const known = byInvocation.get(meta.id) ?? byKey.get(meta.id);
            if (known !== undefined) return known;

            if (isConversationRoot(meta)) {
                const root = byKey.get(ROOT_KEY);

                if (root === undefined) {
                    const created = rootSection(event.agent);

                    created.section.invocationId = meta.id;
                    created.section.agentLabel = turn.threadLabel ?? conversationLabelOf(meta.id) ?? '';
                    created.section.threadLabel = conversationLabelOf(meta.id) ?? turn.threadLabel;
                    created.section.threadId = turn.threadId;
                    byInvocation.set(meta.id, created);
                    openSection(created, ops);

                    return created;
                }

                // Same agent, no parent: another frame of the host-thread run.
                if (root.agent === event.agent) {
                    if (root.section.invocationId === undefined) {
                        root.section.invocationId = meta.id;
                        byInvocation.set(meta.id, root);
                        patchSection(root, { invocationId: meta.id }, ops);
                    }

                    return root;
                }
            }

            if (meta.callId !== undefined) {
                const placeholder = byCall.get(meta.callId);

                if (placeholder !== undefined && placeholder.placeholder) {
                    adoptPlaceholder(placeholder, meta, ops);

                    return placeholder;
                }
            }

            return createChild(meta, event.agent, ops);
        }

        const root = byKey.get(ROOT_KEY);
        if (root !== undefined && root.agent === event.agent) return root;

        // A threadless stream from the ENTRY agent is the turn's own root flow: the
        // tile seeds the root section exactly this way (turns.ts:4045-4054, where
        // `inlineEntry` falls back to `ROOT_KEY`). Without this, a legacy run would
        // render into an `inline:<agent>` section and lose the conversation label the
        // root row owns.
        if (root === undefined && event.agent === context.primary) {
            const created = rootSection(event.agent);

            openSection(created, ops);

            return created;
        }

        if (event.type === 'start') {
            const placeholder = queuedPlaceholder(event.agent);

            if (placeholder !== undefined) {
                placeholder.placeholder = false;
                placeholder.started = true;
                placeholder.section.state = 'streaming';
                patchSection(placeholder, { state: 'streaming' }, ops);

                return placeholder;
            }

            return inlineSection(event.agent, ops);
        }

        // The runtime serializes one invocation per agent, so a single started,
        // non-terminal section for that agent is unambiguous. Anything else (none, or
        // more than one) keeps the flat inline section rather than guessing
        // (turns.ts:4027-4040).
        let candidate: SectionRecord | undefined;
        let matches = 0;

        for (const record of sections) {
            if (record.key === ROOT_KEY || record.placeholder) continue;
            if (record.agent !== event.agent || !record.started || record.terminal) continue;
            candidate = record;
            matches += 1;
        }

        if (matches === 1 && candidate !== undefined) return candidate;

        return inlineSection(event.agent, ops);
    };

    // -----------------------------------------------------------------------
    // Attempt windows
    // -----------------------------------------------------------------------

    const beginAttempt = (record: SectionRecord): AttemptWindow => {
        record.attempt ??= { nodeIds: [], stepIds: [], sectionKeys: [], callIds: [] };

        return record.attempt;
    };

    // Closing a writer detaches the node: the next request streams into nodes of its
    // OWN, or a retry could not remove the failed half without also removing the
    // committed half (the fusion defect turns.ts:4599 documents).
    const closeWriters = (record: SectionRecord): void => {
        record.text = undefined;
        record.reasoning = undefined;
    };

    const commitAttempt = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const window = record.attempt;

        closeWriters(record);

        if (window === undefined) return;

        for (const nodeId of window.nodeIds) {
            const node = record.section.nodes.find((entry) => entry.id === nodeId);

            if (node === undefined) continue;
            // Only PROSE has a committed flag: a think chip's content is final once
            // the request committed, and a step/notice is not discardable here.
            if (node.kind !== 'text') continue;

            node.committed = true;
            ops.push({ op: 'node:set', turnId: turn.id, sectionId: record.section.id, nodeId, patch: { committed: true } });
        }

        // The copy target is the LAST committed prose node of this attempt (a pointer,
        // so the prose is carried once rather than duplicated).
        for (let position = record.section.nodes.length - 1; position >= 0; position -= 1) {
            const node = record.section.nodes[position];

            if (node.kind === 'text' && node.text.length > 0) {
                patchSection(record, { answerNodeId: node.id }, ops);
                break;
            }
        }

        record.attempt = undefined;
        ops.push({ op: 'attempt:commit', turnId: turn.id, sectionId: record.section.id });
        invalidate();
    };

    const discardAttempt = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const window = record.attempt;

        closeWriters(record);

        if (window === undefined) return;

        for (const callId of window.callIds) {
            const index = openCalls.findIndex((entry) => entry.step.callId === callId && entry.sectionKey === record.key);
            if (index >= 0) openCalls.splice(index, 1);
        }

        for (const nodeId of window.nodeIds) steps.delete(nodeId);

        record.section.nodes = record.section.nodes.filter((node) => !window.nodeIds.includes(node.id));
        stepCount = Math.max(0, stepCount - window.stepIds.length);

        // A call of a FAILED attempt never executed, so its id is deliberately NOT
        // marked settled (turns.ts:4521).
        for (const key of window.sectionKeys) {
            const placeholder = byKey.get(key);

            if (placeholder === undefined || !placeholder.placeholder) continue;
            removeSection(placeholder, ops);
        }

        record.attempt = undefined;
        ops.push({ op: 'attempt:discard', turnId: turn.id, sectionId: record.section.id, nodeIds: [...window.nodeIds] });
        invalidate();
    };

    // -----------------------------------------------------------------------
    // The pending status line (one mutable node per section)
    // -----------------------------------------------------------------------

    const pendingLineText = (record: SectionRecord): string | undefined => {
        if (record.pendingCalls.size === 0) return undefined;

        // Exact existing tile text (turns.ts:4271, pinned by tests).
        return `pending \u00b7 ${[...record.pendingCalls.values()]
            .map((tool) => `${tool.name} ${formatDuration(tool.elapsedMs)}`)
            .join(' \u00b7 ')}`;
    };

    const syncPendingLine = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const text = pendingLineText(record);
        const existing = record.section.nodes.find((node) => node.id === PENDING_NODE_ID);

        if (text === undefined) {
            if (existing === undefined) return;

            record.section.nodes = record.section.nodes.filter((node) => node.id !== PENDING_NODE_ID);
            ops.push({ op: 'node:remove', turnId: turn.id, sectionId: record.section.id, nodeId: PENDING_NODE_ID });

            return;
        }

        if (existing === undefined) {
            const node: DisplayNode = { kind: 'notice', id: PENDING_NODE_ID, tone: 'info', text };
            record.section.nodes.push(node);
            ops.push({ op: 'node:insert', turnId: turn.id, sectionId: record.section.id, node });

            return;
        }

        if (existing.kind !== 'notice' || existing.text === text) return;

        existing.text = text;
        ops.push({ op: 'node:set', turnId: turn.id, sectionId: record.section.id, nodeId: PENDING_NODE_ID, patch: { text } });
    };

    // A PRESENT array replaces this agent's snapshot; an absent one must not be read
    // as "drained" (turns.ts:5142). Both the DATA op (`pending:set`, the frozen
    // contract frame) and the composed status line are emitted: a renderer that draws
    // its own rows gets the array, and a renderer that prints verbatim gets the text.
    const paintPending = (
        record: SectionRecord,
        pending: HarnessPendingTool[] | undefined,
        ops: TurnDisplayOp[]
    ): void => {
        if (pending === undefined) return;

        record.pendingCalls.clear();
        for (const tool of pending) record.pendingCalls.set(tool.callId, tool);

        ops.push({
            op: 'pending:set',
            turnId: turn.id,
            sectionId: record.section.id,
            pending: pending.map((tool) => ({ ...tool }))
        });
        syncPendingLine(record, ops);
    };

    const prunePending = (record: SectionRecord, callId: string | undefined, ops: TurnDisplayOp[]): void => {
        if (callId === undefined) return;
        if (!record.pendingCalls.delete(callId)) return;

        ops.push({
            op: 'pending:set',
            turnId: turn.id,
            sectionId: record.section.id,
            pending: [...record.pendingCalls.values()].map((tool) => ({ ...tool }))
        });
        syncPendingLine(record, ops);
    };

    // -----------------------------------------------------------------------
    // Node / step emission
    // -----------------------------------------------------------------------

    const insertNode = (record: SectionRecord, node: DisplayNode, ops: TurnDisplayOp[], attemptOwned: boolean): void => {
        record.section.nodes.push(node);
        ops.push({ op: 'node:insert', turnId: turn.id, sectionId: record.section.id, node: copyValue(node) });

        const window = attemptOwned ? record.attempt : undefined;

        if (window !== undefined) {
            window.nodeIds.push(node.id);
            if (node.kind === 'tool' || node.kind === 'action') window.stepIds.push(node.id);
        }

        invalidate();
    };

    // `attemptOwned` decides whether a later `retry` may remove this step. A tool
    // call is attempt output (turns.ts:4789), a result-only legacy card joins an
    // open window (turns.ts:4902), and an actionRequest card is NOT (turns.ts:4382
    // appends it outside the attempt tracking) — a retry must not eat a live question.
    const pushStep = (
        record: SectionRecord,
        step: DisplayStep,
        index: number,
        ops: TurnDisplayOp[],
        attemptOwned: boolean
    ): StepRecord => {
        const entry: StepRecord = { step, sectionKey: record.key, openingIndex: index };

        steps.set(step.id, entry);
        record.section.nodes.push(step);
        ops.push({ op: 'step:set', turnId: turn.id, sectionId: record.section.id, step: copyValue(step) });
        stepCount += 1;

        const window = attemptOwned ? record.attempt : undefined;

        if (window !== undefined) {
            window.nodeIds.push(step.id);
            window.stepIds.push(step.id);
        }

        invalidate();

        return entry;
    };

    const setStep = (entry: StepRecord, patch: Partial<DisplayStep>, ops: TurnDisplayOp[]): void => {
        Object.assign(entry.step, patch);

        const owner = sections.find((record) => record.key === entry.sectionKey);
        if (owner === undefined) return;

        ops.push({ op: 'step:set', turnId: turn.id, sectionId: owner.section.id, step: copyValue(entry.step) });
        invalidate();
    };

    const noticeNode = (
        record: SectionRecord,
        tone: 'retry' | 'wake' | 'error' | 'steer' | 'answer' | 'info',
        text: string,
        id: string,
        at: number | undefined,
        stepId: string | undefined,
        ops: TurnDisplayOp[]
    ): void => {
        insertNode(
            record,
            {
                kind: 'notice',
                id,
                tone,
                text: previewText(text, DISPLAY_NOTICE_CHARS),
                ...(at === undefined || at <= 0 ? {} : { at }),
                ...(stepId === undefined ? {} : { stepId })
            },
            ops,
            false
        );
    };

    // -----------------------------------------------------------------------
    // apply(): one recorded event -> ops
    // -----------------------------------------------------------------------

    const apply = (event: HarnessEvent, at: number, index: number): TurnDisplayOp[] => {
        const ops: TurnDisplayOp[] = [];

        if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return ops;

        // A cold fold of a legacy record has no `eventTimes`; the contract keeps
        // `at: number`, so 0 is the documented "no timestamp" sentinel and NO timing
        // is written anywhere (the tile must not invent a duration).
        const stamp = finiteNumber(at) && at > 0 ? at : undefined;
        const record = route(event, ops);

        switch (event.type) {
            case 'start': {
                if (record.key === ROOT_KEY) {
                    record.agent = event.agent;
                    record.section.agent = event.agent;
                }

                record.started = true;
                if (record.section.agentLabel.length === 0) {
                    const label = conversationLabelOf(record.section.invocationId);

                    record.section.agentLabel = label ?? (record.key === ROOT_KEY ? turn.threadLabel ?? '' : '');
                    if (record.section.agentLabel.length > 0 && record.key === ROOT_KEY) {
                        record.section.threadLabel = record.section.agentLabel;
                    }
                }

                patchSection(
                    record,
                    {
                        model: typeof event.model === 'string' ? event.model : undefined,
                        role: record.key === ROOT_KEY ? (event.agent === context.primary ? 'primary' : 'subagent') : record.section.role,
                        agentLabel: record.section.agentLabel,
                        ...(record.section.threadLabel === undefined ? {} : { threadLabel: record.section.threadLabel }),
                        ...(record.terminal ? {} : { state: 'streaming' }),
                        ...(record.section.agentLabel.length === 0 || record.key !== ROOT_KEY
                            ? {}
                            : { threadId: record.section.threadId ?? turn.threadId })
                    },
                    ops
                );
                break;
            }

            case 'text': {
                if (typeof event.delta !== 'string' || event.delta.length === 0) break;

                beginAttempt(record);

                if (record.text === undefined) {
                    record.text = { kind: 'text', id: `n${index}`, text: '', committed: false };
                    insertNode(record, record.text, ops, true);
                }

                record.text.text += event.delta;
                ops.push({ op: 'node:append', turnId: turn.id, sectionId: record.section.id, nodeId: record.text.id, delta: event.delta });
                invalidate();
                break;
            }

            case 'reasoning': {
                if (typeof event.delta !== 'string' || event.delta.length === 0) break;

                beginAttempt(record);

                if (record.reasoning === undefined) {
                    record.reasoning = { kind: 'reasoning', id: `n${index}`, text: '' };
                    insertNode(record, record.reasoning, ops, true);
                }

                record.reasoning.text += event.delta;
                ops.push({ op: 'node:append', turnId: turn.id, sectionId: record.section.id, nodeId: record.reasoning.id, delta: event.delta });
                applyShares(record, ops);
                invalidate();
                break;
            }

            case 'tool_call': {
                const window = beginAttempt(record);
                const callId = typeof event.call?.id === 'string' && event.call.id.length > 0 ? event.call.id : undefined;
                const name = typeof event.call?.name === 'string' ? event.call.name : '';
                const rawArgs = typeof event.call?.arguments === 'string' ? event.call.arguments : '';

                // Text before a call is finished text: close the writer so the call is
                // a node of its own and post-tool prose starts a fresh block.
                closeWriters(record);

                const step: DisplayStep = {
                    kind: 'tool',
                    id: String(index),
                    turnId: turn.id,
                    sectionId: record.section.id,
                    ...(callId === undefined ? {} : { callId }),
                    name,
                    argsPreview: previewArguments(rawArgs),
                    state: 'running',
                    ...(stamp === undefined ? {} : { startedAt: stamp }),
                    detail: {
                        stepId: String(index),
                        hasResult: false,
                        truncated: rawArgs.length > DISPLAY_ARGS_PREVIEW_CHARS
                    }
                };

                const entry = pushStep(record, step, index, ops, true);

                if (callId !== undefined) {
                    openCalls.push(entry);
                    window.callIds.push(callId);
                }

                if (name === 'delegate' && callId !== undefined) {
                    const delegate = delegateOf(rawArgs);

                    if (delegate !== undefined) {
                        const key = `call:${callId}`;

                        if (!byKey.has(key)) {
                            const placeholder = newSection(key, delegate.agent, record.key, true);

                            byCall.set(callId, placeholder);
                            placeholder.spawnCallId = callId;
                            placeholder.section.role = 'subagent';
                            openSection(placeholder, ops);
                            window.sectionKeys.push(key);
                        }
                    }
                }

                invalidate();
                break;
            }

            case 'tool_result': {
                const callId = typeof event.callId === 'string' && event.callId.length > 0 ? event.callId : undefined;
                const outcome = outcomeOfResult(event);
                const state = outcomeState(outcome);

                // A result for a call THIS INVOCATION already settled is a duplicate/
                // late frame: one call, one row, no overwrite (turns.ts:4849). Scoped
                // per invocation so a child's id cannot mask its parent's result.
                if (callId !== undefined && settledCalls.has(settleKey(record.key, callId))) break;

                const findOpen = (): StepRecord | undefined => {
                    if (callId !== undefined) {
                        const local = openCalls.findIndex(
                            (candidate) => candidate.step.callId === callId && candidate.sectionKey === record.key
                        );
                        const any = local >= 0 ? local : openCalls.findIndex((candidate) => candidate.step.callId === callId);

                        return any >= 0 ? openCalls[any] : undefined;
                    }

                    const local = openCalls.findIndex(
                        (candidate) => candidate.step.name === event.name && candidate.sectionKey === record.key
                    );
                    const any = local >= 0 ? local : openCalls.findIndex((candidate) => candidate.step.name === event.name);

                    return any >= 0 ? openCalls[any] : undefined;
                };

                const entry = findOpen();
                const content = typeof event.content === 'string' ? event.content : '';

                if (entry !== undefined) {
                    openCalls.splice(openCalls.indexOf(entry), 1);
                    // Marked against the STEP's own invocation, which is the identity a
                    // later duplicate for the same call would have to match.
                    if (callId !== undefined) settledCalls.add(settleKey(entry.sectionKey, callId));

                    entry.resultIndex = index;
                    const duration = finiteNumber(event.durationMs) ? event.durationMs : undefined;
                    const panels = summarizePanels(event.ui);
                    const media = summarizeMedia(event.media);

                    setStep(
                        entry,
                        {
                            state,
                            outcome,
                            preview: previewText(content, DISPLAY_PREVIEW_CHARS),
                            ...(duration === undefined ? {} : { durationMs: duration }),
                            ...(stamp === undefined ? {} : { endedAt: stamp }),
                            ...panels,
                            ...media,
                            detail: {
                                ...entry.step.detail,
                                resultStepId: String(index),
                                hasResult: true,
                                truncated: entry.step.detail.truncated || content.length > DISPLAY_PREVIEW_CHARS
                            }
                        },
                        ops
                    );

                    const pending = pendingOf(event.pending);

                    if (pending !== undefined) paintPending(record, pending, ops);
                    else prunePending(record, entry.step.callId ?? callId, ops);
                } else if (settledStatus === undefined) {
                    // The gate is the PROJECTOR's settled flag, never `turn.status`:
                    // a cold fold replays the events of an ALREADY-terminal record,
                    // while the live run was not terminal when those same events
                    // arrived. Reading the record here would make replay disagree with
                    // live, which is the one rule this file exists to keep.
                    //
                    // A genuine result-only frame (a protocol that reports results
                    // without calls, or a missed `tool_call`): show it rather than
                    // dropping information (turns.ts:4891). The RESULT event is this
                    // step's own opening, so detail answering it alone is exact.
                    if (callId !== undefined) settledCalls.add(settleKey(record.key, callId));

                    const step: DisplayStep = {
                        kind: 'tool',
                        id: String(index),
                        turnId: turn.id,
                        sectionId: record.section.id,
                        ...(callId === undefined ? {} : { callId }),
                        name: typeof event.name === 'string' ? event.name : '',
                        preview: previewText(content, DISPLAY_PREVIEW_CHARS),
                        state,
                        outcome,
                        ...(finiteNumber(event.durationMs) ? { durationMs: event.durationMs } : {}),
                        ...(stamp === undefined ? {} : { startedAt: stamp, endedAt: stamp }),
                        ...stepAttachmentsOf(event),
                        detail: { stepId: String(index), hasResult: false, truncated: content.length > DISPLAY_PREVIEW_CHARS }
                    };

                    pushStep(record, step, index, ops, true);
                }

                // The parent's result for the SPAWNING call is the authoritative
                // completion of that child invocation (turns.ts:5154): by call id,
                // so same-agent siblings settle the right row. A CANCELLED call is a
                // control outcome, never an error.
                if (callId !== undefined) {
                    const child = byCall.get(callId);

                    if (child !== undefined && child !== record && !child.terminal) {
                        child.terminal = true;
                        patchSection(
                            child,
                            {
                                state: outcome === 'completed' ? 'done' : outcome === 'cancelled' ? 'cancelled' : 'error',
                                ...(stamp === undefined ? {} : { endedAt: stamp })
                            },
                            ops
                        );
                    }
                }

                invalidate();
                break;
            }

            case 'usage': {
                const usage = event.usage ?? ({} as { input?: number; cached?: number });

                record.latestInput = finiteNumber(usage.input) ? usage.input : record.latestInput;
                turnLatestInput = record.latestInput;

                if (finiteNumber(usage.cached)) {
                    record.cachedReported = true;
                    record.cachedInput = (record.cachedInput ?? 0) + usage.cached;
                }

                ops.push({
                    op: 'usage',
                    turnId: turn.id,
                    sectionId: record.section.id,
                    ...(record.latestInput === undefined ? {} : { latestInput: record.latestInput }),
                    ...(record.cachedReported ? { cachedInput: record.cachedInput ?? 0 } : {})
                });
                ops.push({
                    op: 'usage',
                    turnId: turn.id,
                    sectionId: 'turn',
                    ...(turnLatestInput === undefined ? {} : { latestInput: turnLatestInput }),
                    ...(turn.usage === undefined ? {} : { usage: copyValue(turn.usage) })
                });

                applyShares(record, ops);
                invalidate();
                break;
            }

            case 'done': {
                const pending = pendingOf(event.pending);

                if (pending !== undefined) paintPending(record, pending, ops);

                commitAttempt(record, ops);

                // `done` closes one AGENT turn, not the user's turn: the root keeps
                // streaming until the turn settles (turns.ts:5241), and a response
                // still waiting on background calls has not finished at all.
                const finished = pending === undefined || pending.length === 0;

                if (record.key !== ROOT_KEY && finished) {
                    record.terminal = true;
                    patchSection(record, { state: 'done', ...(stamp === undefined ? {} : { endedAt: stamp }) }, ops);
                }

                const model = (event.message as { model?: unknown } | undefined)?.model;

                if (record.section.model === undefined && typeof model === 'string') {
                    patchSection(record, { model }, ops);
                }

                invalidate();
                break;
            }

            case 'retry': {
                discardAttempt(record, ops);

                noticeNode(
                    record,
                    'retry',
                    // Exact existing tile text (turns.ts:4644).
                    `attempt ${event.attempt} of ${event.maxAttempts} failed \u00b7 retrying in ${formatDuration(event.delayMs)} \u00b7 ${messageOf(event.error)}`,
                    `n${index}`,
                    stamp,
                    undefined,
                    ops
                );

                invalidate();
                break;
            }

            case 'attempt_commit': {
                commitAttempt(record, ops);
                break;
            }

            case 'wakeup': {
                const pending = pendingOf(event.pending);

                // A wakeup without a usable pending list is malformed: the tile
                // renders nothing and leaves the last snapshot alone (turns.ts:5034).
                if (pending === undefined) break;

                closeWriters(record);
                noticeNode(
                    record,
                    'wake',
                    // Exact existing tile text (turns.ts:4322).
                    pending.length === 0
                        ? 'pending tools finished \u00b7 continuing'
                        : `${pending.length} tool${pending.length === 1 ? '' : 's'} still running \u00b7 continuing`,
                    `n${index}`,
                    stamp,
                    undefined,
                    ops
                );
                paintPending(record, pending, ops);
                invalidate();
                break;
            }

            case 'error': {
                const message = messageOf(event.error);

                closeWriters(record);
                lastError = previewText(message, DISPLAY_ERROR_CHARS);
                noticeNode(record, 'error', message, `n${index}`, stamp, undefined, ops);

                // A child that reported its own failure is terminal; the root's state
                // belongs to the turn (turns.ts:5294).
                if (record.key !== ROOT_KEY) {
                    record.terminal = true;
                    patchSection(record, { state: 'error', ...(stamp === undefined ? {} : { endedAt: stamp }) }, ops);
                }

                invalidate();
                break;
            }

            case 'action_request': {
                const request = event.request;

                if (request === undefined || typeof request.requestId !== 'string' || request.requestId.length === 0) break;
                if (actionSteps.has(request.requestId)) break;

                const options = (Array.isArray(request.options) ? request.options : [])
                    .filter((option) => typeof option?.id === 'string' && typeof option?.label === 'string')
                    .map((option) => ({
                        id: option.id,
                        label: previewText(option.label, DISPLAY_NOTICE_CHARS),
                        ...(typeof option.description === 'string' && option.description.length > 0
                            ? { description: previewText(option.description, DISPLAY_NOTICE_CHARS) }
                            : {})
                    }));

                const step: DisplayStep = {
                    kind: 'action',
                    id: String(index),
                    turnId: turn.id,
                    sectionId: record.section.id,
                    ...(typeof event.callId === 'string' && event.callId.length > 0 ? { callId: event.callId } : {}),
                    name: textOf(request.question, DISPLAY_PREVIEW_CHARS),
                    state: 'running',
                    ...(stamp === undefined ? {} : { startedAt: stamp }),
                    action: {
                        requestId: request.requestId,
                        question: textOf(request.question, DISPLAY_NOTICE_CHARS),
                        options,
                        ...(typeof request.recommended === 'string' && request.recommended.length > 0
                            ? { recommended: request.recommended }
                            : {}),
                        allowCustom: true,
                        // The SERVER knows what is answerable: a restored request is
                        // expired from the start (sessions.ts:679).
                        expired: context.expiredRequestIds?.has(request.requestId) === true
                    },
                    detail: { stepId: String(index), hasResult: false, truncated: false }
                };

                const entry = pushStep(record, step, index, ops, false);

                actionSteps.set(request.requestId, entry);
                invalidate();
                break;
            }

            case 'action_answer': {
                const answer = event.answer;
                const requestId = typeof answer?.requestId === 'string' ? answer.requestId : '';
                const entry = actionSteps.get(requestId);

                if (entry === undefined) break;

                entry.resultIndex = index;

                const choiceText =
                    answer.choice.kind === 'option' ? optionLabel(entry.step.action, answer.choice.optionId) : answer.choice.text;

                setStep(
                    entry,
                    {
                        state: 'ok',
                        ...(stamp === undefined ? {} : { endedAt: stamp }),
                        action: {
                            ...(entry.step.action as DisplayActionSummary),
                            answered: { choice: copyValue(answer.choice), source: answer.source, ...(stamp === undefined ? {} : { at: stamp }) },
                            expired: false
                        },
                        detail: { ...entry.step.detail, resultStepId: String(index), hasResult: true }
                    },
                    ops
                );

                noticeNode(
                    sectionOfEntry(entry) ?? record,
                    'answer',
                    `answered \u00b7 ${choiceText}`,
                    `n${index}`,
                    stamp,
                    entry.step.id,
                    ops
                );
                invalidate();
                break;
            }

            case 'branch_start': {
                const branch = event.branch;

                if (branch === undefined || typeof branch.branchId !== 'string' || branch.branchId.length === 0) break;

                const existing = byBranch.get(branch.branchId) ?? byKey.get(branch.branchId);

                if (existing !== undefined) {
                    existing.placeholder = false;
                    existing.started = true;
                    patchSection(
                        existing,
                        {
                            ...(existing.terminal ? {} : { state: 'streaming' }),
                            ...(typeof branch.model === 'string' ? { model: branch.model } : {}),
                            ...(branch.threadId === undefined ? {} : { threadId: branch.threadId })
                        },
                        ops
                    );
                    break;
                }

                // The branch row is keyed by the BRANCH id (turns.ts:5337), nested
                // under its requester when the summary names one.
                const meta = {
                    id: branch.branchId,
                    ...(branch.sourceThreadId === undefined ? {} : { parentId: branch.sourceThreadId }),
                    ...(branch.callId === undefined ? {} : { callId: branch.callId }),
                    branchId: branch.branchId,
                    kind: branch.kind
                } as NonNullable<HarnessEvent['thread']>;

                createChild(meta, branch.agent, ops, {
                    role: branch.sourceThreadId === undefined && branch.role === 'primary' ? 'primary' : 'subagent',
                    branchId: branch.branchId,
                    model: typeof branch.model === 'string' ? branch.model : undefined,
                    threadId: typeof branch.threadId === 'string' ? branch.threadId : undefined,
                    state: 'streaming'
                });

                invalidate();
                break;
            }

            case 'branch_end': {
                const target = byBranch.get(event.branchId) ?? byKey.get(event.branchId);

                if (target === undefined) break;

                target.terminal = true;
                patchSection(
                    target,
                    {
                        state: event.status === 'completed' ? 'done' : event.status === 'cancelled' ? 'cancelled' : 'error',
                        ...(stamp === undefined ? {} : { endedAt: stamp })
                    },
                    ops
                );

                if (event.error !== undefined) {
                    noticeNode(target, 'error', messageOf(event.error), `n${index}`, stamp, undefined, ops);
                }

                invalidate();
                break;
            }

            default:
                // An unknown or future event type is recorded (the raw record stays
                // complete) and renders nothing, exactly like the tile's default case.
                break;
        }

        return ops;
    };

    // Panels/media of a RESULT-ONLY legacy frame: the same bounded summaries, computed
    // by one helper so the settled and result-only tool paths cannot drift.
    const stepAttachmentsOf = (event: HarnessEvent): { panels?: DisplayPanelSummary[]; media?: DisplayMediaSummary[] } => ({
        ...summarizePanels((event as { ui?: unknown }).ui),
        ...summarizeMedia((event as { media?: unknown }).media)
    });

    const sectionOfEntry = (entry: StepRecord): SectionRecord | undefined =>
        sections.find((record) => record.key === entry.sectionKey);

    const optionLabel = (action: DisplayActionSummary | undefined, optionId: string | undefined): string => {
        if (action === undefined || optionId === undefined) return optionId ?? '';

        const found = action.options.find((option) => option.id === optionId);

        return found === undefined ? optionId : found.label;
    };

    // Think-chip shares re-measure whenever the denominator moves (turns.ts:5210):
    // computed once, here, so a stale percentage cannot disagree with the tally two
    // lines above it.
    const applyShares = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const base = turn.usage?.input ?? turnLatestInput ?? 0;

        if (base <= 0) return;

        for (const node of record.section.nodes) {
            if (node.kind !== 'reasoning') continue;

            const share = Math.round((node.text.length / base) * 100);
            if (node.share === share) continue;

            node.share = share;
            ops.push({ op: 'node:set', turnId: turn.id, sectionId: record.section.id, nodeId: node.id, patch: { share } });
        }
    };

    // The store owns labels (it holds the seeds and the thread join), so blocks come
    // from a callback and ride their own stamp.
    const blocksForTurn = (): AgentResultBlock[] => {
        const stamp = `${turn.status}:${turn.updatedAt}:${turn.events.length}`;

        if (blocksStamp === stamp) return blocksCache;

        blocksCache = context.blocksOf === undefined ? [] : [...context.blocksOf(turn)];
        blocksStamp = stamp;

        return blocksCache;
    };

    // -----------------------------------------------------------------------
    // settle(): the turn reached a terminal status (a lifecycle edge, not an event)
    // -----------------------------------------------------------------------

    const settle = (status: TurnRecordStatus, at: number): TurnDisplayOp[] => {
        const ops: TurnDisplayOp[] = [];

        settledStatus = status;
        settledAt = finiteNumber(at) && at > 0 ? at : undefined;

        for (const record of sections) {
            if (record.terminal) continue;

            record.terminal = true;
            // A placeholder row that was never adopted describes a delegation that
            // never ran; dropping it is exact, and it is why `section:remove` exists.
            if (record.placeholder && record.section.nodes.length === 0 && record.section.invocationId === undefined) {
                removeSection(record, ops);

                continue;
            }

            patchSection(record, { state: sectionStateOf(status), ...(settledAt === undefined ? {} : { endedAt: settledAt }) }, ops);
        }

        for (const entry of [...steps.values()]) {
            if (entry.step.state !== 'running') continue;

            const owner = sectionOfEntry(entry);
            if (owner === undefined) continue;

            const patch: Partial<DisplayStep> = {
                state: abandonedStateOf(status),
                ...(settledAt === undefined ? {} : { endedAt: settledAt }),
                ...(entry.step.preview === undefined || entry.step.preview.length === 0
                    ? {
                          preview: previewText(
                              status === 'cancelled'
                                  ? 'the turn was cancelled before this call returned'
                                  : 'the turn ended before this call returned',
                              DISPLAY_PREVIEW_CHARS
                          )
                      }
                    : {}),
                ...(entry.step.kind === 'action' && entry.step.action !== undefined
                    ? { action: { ...entry.step.action, expired: true } }
                    : {})
            };

            Object.assign(entry.step, patch);
            ops.push({ op: 'step:set', turnId: turn.id, sectionId: owner.section.id, step: copyValue(entry.step) });
        }

        // Nothing is pending once the turn ended, and the line must not linger.
        for (const record of sections) {
            record.pendingCalls.clear();
            syncPendingLine(record, ops);
        }

        openCalls.length = 0;
        invalidate();
        ops.push({ op: 'turn', turnId: turn.id, summary: summary() });

        return ops;
    };

    // -----------------------------------------------------------------------
    // Reads — always detached, so a watcher cannot mutate server state through a
    // frame (the same rule `copyTurn`/`publish` enforce for the raw surface)
    // -----------------------------------------------------------------------

    const display = (): TurnDisplay => ({
        turnId: turn.id,
        sections: sections.map((record) => copyValue(record.section))
    });

    const attachmentSummaries = () =>
        (turn.attachments ?? []).map((attachment) => {
            const inlinable =
                attachment.kind === 'image' &&
                typeof attachment.data === 'string' &&
                attachment.data.length > 0 &&
                attachment.data.length <= DISPLAY_ATTACHMENT_INLINE_CHARS;

            return {
                id: attachment.id,
                marker: attachment.marker,
                name: attachment.name,
                kind: attachment.kind,
                mime: attachment.mime,
                size: attachment.size,
                ...(inlinable ? { data: attachment.data } : {}),
                hasBytes: typeof attachment.data === 'string' ? attachment.data.length > 0 : false
            };
        });

    const steerSummaries = () =>
        (turn.steers ?? []).map((steer) => {
            // The board needs a steer's DESTINATION; today it resolves that by
            // walking invocations (turns.ts:390). One lookup here, on the wire.
            const target =
                steer.threadId === undefined ? undefined : sections.find((record) => record.section.threadId === steer.threadId);

            return {
                at: steer.at,
                prompt: steer.prompt,
                ...(target === undefined ? {} : { sectionId: target.section.id }),
                ...(steer.threadId === undefined ? {} : { threadId: steer.threadId }),
                ...(steer.references === undefined
                    ? {}
                    : { references: steer.references.map((reference) => ({ ...reference })) })
            };
        });

    const blockSummaries = (): TurnSummary['blocks'] =>
        blocksForTurn().map((block) => ({
            turnId: turn.id,
            ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
            label: block.label,
            agent: block.agent,
            status: block.status,
            ...(block.content === undefined || block.content.length === 0
                ? {}
                : { preview: previewText(block.content, DISPLAY_BLOCK_PREVIEW_CHARS) }),
            // `isReferenceableBlock` (../frontend/ui/references.ts:44): a failed or
            // cancelled block has no usable result.
            referenceable: block.status === 'done' || block.status === 'running' || block.status === 'queued'
        }));

    const summaryOf = (): TurnSummary => {
        const status = settledStatus ?? turn.status;
        const terminal = isTerminalStatus(status);
        const active: string[] = [];

        for (const record of sections) {
            if (record.terminal || record.placeholder || !record.started) continue;
            if (!active.includes(record.agent)) active.push(record.agent);
        }

        const rootModel = byKey.get(ROOT_KEY)?.section.model;
        // The settled status line: a recorded failure text wins, a DONE turn shows the
        // model that answered (the tile's `merge(turn, model)` detail line), and a
        // cancelled turn with no message shows NOTHING rather than the model of a run
        // that never answered.
        const detail = lastError ?? (status === 'done' ? rootModel : undefined);
        const attachments = attachmentSummaries();
        const steers = steerSummaries();
        const visibleSections = sections.filter((record) => !record.placeholder).length;

        return {
            id: turn.id,
            index: turn.index,
            prompt: turn.prompt,
            status,
            state: TURN_STATE_OF[status],
            ...(turn.threadId === undefined ? {} : { threadId: turn.threadId }),
            ...(turn.threadLabel === undefined ? {} : { threadLabel: turn.threadLabel }),
            ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
            updatedAt: turn.updatedAt,
            ...(turn.usage === undefined ? {} : { usage: copyValue(turn.usage) }),
            ...(turnLatestInput === undefined ? {} : { latestInput: turnLatestInput }),
            ...(turn.usage?.cached === undefined ? {} : { cachedInput: turn.usage.cached }),
            ...(detail === undefined || detail.length === 0 ? {} : { detail }),
            sectionCount: visibleSections,
            stepCount,
            activeAgents: terminal ? [] : active,
            ...(attachments.length === 0 ? {} : { attachments }),
            ...(turn.references === undefined || turn.references.length === 0
                ? {}
                : { references: turn.references.map((reference) => ({ ...reference })) }),
            ...(steers.length === 0 ? {} : { steers }),
            blocks: blockSummaries()
        };
    };

    const summary = (): TurnSummary => {
        const stamp = [
            turn.status,
            turn.updatedAt,
            turn.events.length,
            sectionOrdinal,
            stepCount,
            settledStatus ?? '',
            settledAt ?? '',
            turn.threadLabel ?? '',
            turn.usage?.total ?? ''
        ].join(':');

        if (summaryCache !== undefined && summaryStamp === stamp) return summaryCache;

        summaryCache = summaryOf();
        summaryStamp = stamp;

        return summaryCache;
    };

    return { turnId: () => turn.id, apply, settle, summary, display };
};

/**
 * Replay a recorded turn into a LIVE projector: the same fold as `projectTurn`, but
 * the caller keeps the projector so later events of a still-running turn continue
 * from the cached state instead of re-folding. Restore uses this for every turn it
 * loads, which is what makes the compiled memory warm at startup rather than built
 * per request (R4).
 */
export const refoldTurn = (turn: SessionTurn, context: DisplayProjectContext): TurnProjector => {
    const projector = createTurnProjector(turn, context);

    for (let index = 0; index < turn.events.length; index += 1) {
        const event = turn.events[index];
        const at = turn.eventTimes?.[index];

        projector.apply(event, finiteNumber(at) ? at : DISPLAY_NO_TIMESTAMP, index);
    }

    if (isTerminalStatus(turn.status)) {
        projector.settle(turn.status, turn.updatedAt);
    }

    return projector;
};

/**
 * Cold fold: the complete display state of one recorded turn, in one pass. Restore
 * and every view read go through this, so the browser folds nothing and a restart
 * rebuilds the cache instead of computing per request.
 *
 * `at` for a record WITHOUT `eventTimes` is `DISPLAY_NO_TIMESTAMP` (0), which the
 * projector reads as "no timing known" and never paints a duration from — the
 * recorded-replay rule the tile already honors (turns.ts:4778).
 */
export const projectTurn = (turn: SessionTurn, context: DisplayProjectContext): DisplayedTurn => {
    const projector = refoldTurn(turn, context);

    return { summary: projector.summary(), display: projector.display() };
};

// Sentinel `at` for a fold that has no timestamp for an event. Exported so the
// store's recorder and the tests agree on what "unknown" means.
export const DISPLAY_NO_TIMESTAMP = 0;
