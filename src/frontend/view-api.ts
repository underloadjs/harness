// The browser's DISPLAY FACADE over the canonical control plane (T14).
//
// This is the only place the UI assembles a render document, and it is the module
// that owns the payload strategy. It speaks ONE wire — the generated contract in
// ../shared/harness-api.ts (`/v1/harness`, snake_case resources, camelCase display
// subtree) — and produces the windowed render model in ./view-model.ts. The
// legacy `/views` mirror, its SSE observer, and the raw `/api` aggregate are gone:
// nothing here re-creates a document the server stopped publishing, because
// synthesizing one would mean downloading every history again.
//
// WHAT ONE SESSION OPEN COSTS (all four reads in parallel, all bounded):
//
//   GET /sessions/{id}                       one metadata row          (~0.5 KB)
//   GET /sessions/{id}/turns?limit=25&order=desc   the newest 25 ROWS  (~bounded)
//   GET /sessions/{id}/threads?limit=25      one roster PAGE of SIGNALS
//   GET /sessions/{id}/actions               the owner questions still waiting
//
// plus display trees for the tail the reader actually sees (`visibleTurns`, capped
// at `MAX_VISIBLE_DISPLAYS_PER_OPEN`). Everything else is a user action:
//
//   older history        → `loadOlderTurns` with the page cursor the server issued
//   a turn's tree        → `readTurnDisplay` (tile expanded / scrolled into view)
//   a tool's payloads    → `readStepDetail` (one click, one pair of verbatim events)
//   a context segment    → `readBlockDetail` (one click, that segment's recorded text)
//   an attachment        → `readAttachmentBytes` (descriptor rides the row)
//   a transcript         → `readTranscript` / `readTranscriptMessages` (paged)
//   cost figures         → `readUsage` (details dialog only)
//   the frozen definition→ `readDefinition` (configuration panel only)
//   commands / queue     → `readCommands` / `readQueue` (composer `/`, queue panel)
//
// WRITES answer RECEIPTS, not documents. A submit is a `TaskReceipt`; a stop, a
// reset, a thread cancel/delete and a transcript save are minimal results carrying
// a `revision`. The shell therefore patches the ONE resource the write touched
// (the new row from the receipt, or the row the stream's `turn.upsert` delivers)
// instead of re-reading a whole view — and the stream (./stream.ts) is the update
// plane for everything else.
//
// The op adapter: the two facts the generated header calls a PROJECTION DELTA.
//   1. `TurnSummary` rows: the wire carries `promptPreview` + `promptChars`; the
//      projector's internal row carries `prompt`. The row keeps the preview under
//      BOTH spellings and sets `promptIsPreview`, so a renderer never mistakes a
//      bounded preview for the verbatim prompt. The verbatim text is
//      `api.getTurn` (turn metadata) or a context-block read for the user bubble.
//   2. `TurnDisplayOp`: the wire is ONE closed record with optional fields and
//      names the row payload `turn`; the projector's internal union names it
//      `summary` and requires the ids each member applies to. `projectOps` narrows
//      each record into the member its `op` names, filling `turnId` from the frame
//      and dropping an op whose target ids are missing — no unsafe cast that hides
//      a field the reducer would have needed.
import { HARNESS_ROUTES } from '../shared/harness-api';
import type {
    HarnessActionRequest,
    PendingAction,
    SessionResource,
    SessionUsageResponse,
    SessionDefinitionResource,
    SessionSummary,
    TaskReceipt,
    ThreadResource,
    ThreadSummary,
    TranscriptDocumentResponse,
    TranscriptMetadata,
    ContextBlock as WireContextBlock,
    DisplayNode as WireNode,
    DisplayStep as WireStep,
    DisplayTail as WireTail,
    HarnessPendingTool,
    TurnSection as WireTurnSection,
    TurnSummary as WireTurnSummary
} from '../shared/harness-api';
import type {
    TurnBlockDetail as InternalTurnBlockDetail,
    TurnDisplay,
    TurnDisplayOp,
    TurnStepDetail as InternalTurnStepDetail
} from '../shared/turn-display';
import { pendingSectionsOf, projectDisplay, projectNode, projectRow, projectSection, projectStep } from './display-project';
import {
    cancelSession,
    cancelSessionThread,
    createSession,
    deleteSession,
    deleteSessionOnUnload,
    deleteSessionThread,
    getBlockDetail,
    getSession,
    getSessionDefinition,
    getSessionUsage,
    getStepDetail,
    getTranscriptDocument,
    getTranscriptMetadata,
    getTurnDisplay,
    listPendingActions,
    listSessionCommands,
    listThreads,
    listQueue,
    listTranscriptMessages,
    listTurns,
    listTurnEvents,
    listSessions,
    putTranscriptDocument,
    getAttachment,
    getTurn,
    resetSession,
    submitTask,
    updateSession,
    apiUrl,
    type Page,
    type PageQuery
} from './api';
import type { InvalidThreadRow, RawTurnDocument, SessionView, ThreadRow, TurnRowView } from './view-model';

// Re-exported so the shell and the `ui/` renderers import the render model from the
// facade that produces it, and there is one place to look for its shape.
export type { InvalidThreadRow, RawTurnDocument, SessionView, SessionViewSummary, ThreadRow, ThreadTranscriptPayload, TurnRowView } from './view-model';

// The page sizes this UI asks for, each inside `HARNESS_PAGE_LIMIT` (default 25,
// max 100). They are deliberate: 25 rows is the conversation surface a reader can
// scan, and the roster/queue pages are sized the same so a page is one round trip.
export const TURNS_PAGE_LIMIT = 25;
export const ROSTER_PAGE_LIMIT = 25;

// How many display trees one session open may fetch. The rows arrive for 25
// turns; the trees arrive only for the tail the reader is looking at, so the
// default paint is `TURNS_PAGE_LIMIT` rows plus at most this many trees.
export const MAX_VISIBLE_DISPLAYS_PER_OPEN = 10;

// ---------------------------------------------------------------------------
// snake_case resource -> camelCase render model
// ---------------------------------------------------------------------------

// `SessionResource` renamed. The contract keeps resource fields snake_case and the
// display subtree camelCase, so this rename is the boundary — done once, here.
export const sessionViewOf = (session: SessionResource): SessionView => ({
    id: session.id,
    harness: session.harness,
    status: session.status,
    ...(session.queue_depth === undefined ? {} : { queueDepth: session.queue_depth }),
    model: session.model,
    ...(session.agent_models === undefined ? {} : { agentModels: { ...session.agent_models } }),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    ...(session.last_error === undefined ? {} : { lastError: session.last_error }),
    revision: session.revision,
    definitionRevision: session.definition_revision,
    endpoint: session.endpoint,
    runtimeExecution: session.runtime_execution,
    pendingActionCount: session.pending_action_count,
    createdToolCount: session.created_tool_count,
    createdToolLimit: session.created_tool_limit,
    // A metadata read answers a COUNT, never the list: `turns` starts empty and is
    // filled by the rows page, so nothing here can smuggle history back in.
    turnCount: session.turn_count,
    threadCount: session.thread_count,
    turns: [],
    displays: {}
});

// A roster row renamed. Both `ThreadSummary` (page row) and `ThreadResource`
// (identified read) satisfy this: the extra fields are copied only when present,
// so an identified read keeps its invocation roster and a page row stays cheap.
export const threadRowOf = (row: ThreadSummary | ThreadResource): ThreadRow => {
    const identified = row as Partial<ThreadResource>;

    return {
        id: row.id,
        agent: row.agent,
        origin: row.origin,
        status: row.status,
        sequence: row.sequence,
        ...(row.owner_thread_id === undefined ? {} : { ownerThreadId: row.owner_thread_id }),
        ...(row.label === undefined ? {} : { label: row.label }),
        transcriptState: row.transcript_state,
        ...(row.transcript_error === undefined ? {} : { transcriptError: row.transcript_error }),
        messageCount: row.message_count,
        ...(row.chars === undefined ? {} : { chars: row.chars }),
        hasTranscript: row.has_transcript,
        ...(row.preview === undefined ? {} : { preview: row.preview }),
        ...(identified.origin_turn_id === undefined ? {} : { originTurnId: identified.origin_turn_id }),
        ...(identified.origin_invocation_id === undefined ? {} : { originInvocationId: identified.origin_invocation_id }),
        ...(identified.invocation_id === undefined ? {} : { invocationId: identified.invocation_id }),
        ...(identified.invocation_ids === undefined ? {} : { invocationIds: identified.invocation_ids }),
        ...(identified.invocation_ids_truncated === undefined
            ? {}
            : { invocationIdsTruncated: identified.invocation_ids_truncated }),
        ...(identified.references === undefined ? {} : { references: identified.references as ThreadRow['references'] }),
        ...(identified.connected_thread_ids === undefined ? {} : { connectedThreadIds: identified.connected_thread_ids }),
        ...(identified.transcript_revision === undefined ? {} : { transcriptRevision: identified.transcript_revision }),
        ...(identified.transcript_bytes === undefined ? {} : { transcriptBytes: identified.transcript_bytes }),
        ...(identified.revision === undefined ? {} : { revision: identified.revision })
    };
};

// Unreadable transcripts are a PROPERTY OF THE ROW (`transcript_state` +
// `transcript_error`), so the invalid-thread list the dialogs render is derived
// from the roster rather than fetched as a second document. `messages` stays
// `undefined` until the editor reads that thread's document.
export const invalidThreadsOf = (rows: readonly ThreadRow[]): InvalidThreadRow[] =>
    rows
        .filter((row) => row.transcriptState === 'unreadable')
        .map((row) => ({
            id: row.id,
            agent: row.agent,
            ...(row.label === undefined ? {} : { label: row.label }),
            error: row.transcriptError ?? 'The stored transcript could not be read.',
            messages: undefined
        }));

// One turn ROW renamed and marked. A row page never carries the verbatim prompt,
// so `prompt` holds the preview and `promptIsPreview` says exactly that: a tile
// that wants the whole text reads the turn metadata route.
export const turnRowOf = (row: WireTurnSummary): TurnRowView => projectRow(row);

// A row ordered newest-first page reversed into recorded order: the board renders
// ascending, and the contract says `desc` cursors walk OLDER, which is what
// "load older" is. The window is therefore `[oldest … newest]` with the cursor
// pointing further back.
export const ascRows = (page: Page<WireTurnSummary>): TurnRowView[] =>
    [...page.items].reverse().map(projectRow);

// The optimistic row a submit paints before the server's `turn.upsert` lands. The
// receipt carries identity, status, placement and revisions — NOT a display row —
// so the only honest full row is one the STREAM delivers. Everything here is
// paint-only and flagged, and `view-state.ts`'s monotonic guard drops it the moment
// a stamped row for the same id arrives.
export const rowFromReceipt = (receipt: TaskReceipt, draft: string): TurnRowView => {
    const preview = draft.length > 280 ? `${draft.slice(0, 280)}…` : draft;

    return {
        id: receipt.turn_id,
        index: -1,
        prompt: draft,
        promptPreview: preview,
        promptChars: draft.length,
        promptIsPreview: draft.length > preview.length,
        status: receipt.status,
        state: receipt.status === 'queued' ? 'queued' : 'streaming',
        ...(receipt.thread_id === undefined || receipt.thread_id.length === 0
            ? {}
            : { threadId: receipt.thread_id }),
        updatedAt: receipt.accepted_at,
        sectionCount: 0,
        stepCount: 0,
        activeAgents: [],
        blocks: [],
        optimistic: true
    };
};

// ---------------------------------------------------------------------------
// Session open + paging
// ---------------------------------------------------------------------------

export type OpenSessionOptions = {
    // Rows to load on open (clamped into the contract's bounds by `pageParams`).
    limit?: number;
    // How many of the newest turns get a display tree immediately. Pass 0 to open a
    // conversation with rows only, which is what a background tab should do.
    visibleTurns?: number;
    // Load the roster/actions at all. A rail preview does not need either.
    includeRoster?: boolean;
    includeActions?: boolean;
};

// ONE conversation's window. Composition, not a document: four bounded reads in
// parallel, then the visible display trees, then the render model.
export const openSession = async (sessionId: string, options: OpenSessionOptions = {}): Promise<SessionView> => {
    const limit = options.limit ?? TURNS_PAGE_LIMIT;

    const [session, turnsPage, rosterPage, actions] = await Promise.all([
        getSession(sessionId),
        listTurns(sessionId, { limit, order: 'desc' }),
        options.includeRoster === false ? Promise.resolve(undefined) : listThreads(sessionId, { limit: ROSTER_PAGE_LIMIT }),
        options.includeActions === false ? Promise.resolve(undefined) : listPendingActions(sessionId).catch(() => undefined)
    ]);

    const view = sessionViewOf(session);

    view.turns = ascRows(turnsPage);
    view.olderCursor = turnsPage.nextCursor;
    view.turnsRevision = turnsPage.revision;

    if (rosterPage !== undefined) {
        const rows = rosterPage.items.map(threadRowOf);
        view.threadViews = rows;
        view.invalidThreads = invalidThreadsOf(rows);
    }

    if (actions !== undefined) view.actions = actions.actions;

    // Display trees for the visible tail, fetched concurrently because they are
    // independent identified reads. A failed tree is left ABSENT (the tile renders
    // from its row), never guessed at. `visibleTurns: 0` must fetch NOTHING — and
    // `slice(-0)` is `slice(0)`, i.e. every row, so the zero case is explicit.
    const visible = options.visibleTurns ?? MAX_VISIBLE_DISPLAYS_PER_OPEN;
    const bounded = Math.max(0, Math.min(visible, MAX_VISIBLE_DISPLAYS_PER_OPEN));
    const tail = bounded === 0 ? [] : view.turns.slice(-bounded);

    if (tail.length > 0) {
        const trees = await Promise.allSettled(
            tail.map((row) => getTurnDisplaySafely(sessionId, row.id))
        );

        trees.forEach((tree, index) => {
            if (tree.status === 'fulfilled' && tree.value !== undefined) view.displays[tail[index].id] = tree.value;
        });
    }

    return view;
};

// The tree route for one turn. Kept as a named export because ./main.ts calls it
// when the reader expands a tile or scrolls an unloaded row into view. The return
// is the PROJECTED tree (the render model), never the wire record.
export const readTurnDisplay = async (sessionId: string, turnId: string): Promise<TurnDisplay> =>
    projectDisplay(await getTurnDisplay(sessionId, turnId));

// Same read, non-throwing, for the batch above: a turn deleted between the row page
// and this read is simply not on screen.
const getTurnDisplaySafely = async (sessionId: string, turnId: string) => {
    try {
        return await readTurnDisplay(sessionId, turnId);
    } catch {
        return undefined;
    }
};

// The NEXT OLDER page, driven by the cursor the server issued. Nothing here is
// eager: the shell calls it when the reader presses "load older", and it fetches
// trees only for the rows that page just made visible.
export type OlderPage = {
    rows: TurnRowView[];
    displays: Record<string, TurnDisplay>;
    nextCursor: string | null;
    revision: number;
};

export const loadOlderTurns = async (
    sessionId: string,
    cursor: string | null | undefined,
    options: { limit?: number; visibleTurns?: number } = {}
): Promise<OlderPage> => {
    if (cursor === null || cursor === undefined || cursor.length === 0) {
        return { rows: [], displays: {}, nextCursor: null, revision: 0 };
    }

    const page = await listTurns(sessionId, {
        limit: options.limit ?? TURNS_PAGE_LIMIT,
        order: 'desc',
        cursor
    });

    const rows = ascRows(page);
    const displays: Record<string, TurnDisplay> = {};
    const visible = options.visibleTurns ?? rows.length;

    // A request for ZERO visible trees must fetch none. Note the `visible === 0`
    // guard: `rows.slice(-0)` is `rows.slice(0)`, i.e. every row, so the naive slice
    // would silently download a whole page of trees for a pane that is not showing
    // them yet (the exact mistake this payload strategy exists to prevent).
    const tail = visible === 0 ? [] : rows.slice(-Math.min(visible, MAX_VISIBLE_DISPLAYS_PER_OPEN));

    const trees = await Promise.allSettled(tail.map((row) => getTurnDisplaySafely(sessionId, row.id)));
    trees.forEach((tree, index) => {
        if (tree.status === 'fulfilled' && tree.value !== undefined) displays[tail[index].id] = tree.value;
    });

    return { rows, displays, nextCursor: page.nextCursor, revision: page.revision };
};

// Merges one page of older rows into the window WITHOUT re-fetching anything it
// already holds, and keeps `olderCursor` pointing at the next page. Order stays
// the server's recorded order; the client never re-sorts (a re-sort would move a
// turn the reader is looking at).
export const prependTurns = (view: SessionView, page: OlderPage): SessionView => {
    const known = new Set(view.turns.map((row) => row.id));
    const fresh = page.rows.filter((row) => !known.has(row.id));

    view.turns = [...fresh, ...view.turns];
    view.olderCursor = page.nextCursor;
    view.turnsRevision = page.revision;

    for (const [turnId, tree] of Object.entries(page.displays)) {
        if (view.displays[turnId] === undefined) view.displays[turnId] = tree;
    }

    return view;
};

// ---------------------------------------------------------------------------
// The op adapter (wire record -> projector union member)
// ---------------------------------------------------------------------------

// Narrows `display.ops` frames into the internal op union (see the PROJECTION
// DELTA note in the header). Every branch returns the member its `op` names, or
// `undefined` when the frame lacks an id that member requires — an op applied to
// the wrong target is worse than one that is skipped, and `view-state.ts` already
// treats an unknown target as a no-op.
export const projectOp = (
    op: TurnDisplayOp | (Partial<TurnDisplayOp> & { op: TurnDisplayOp['op'] }),
    frameTurnId?: string
): TurnDisplayOp | undefined => {
    const wire = op as Record<string, unknown>;
    const turnId = typeof wire.turnId === 'string' ? wire.turnId : frameTurnId ?? '';
    const sectionId = typeof wire.sectionId === 'string' ? wire.sectionId : undefined;

    switch (op.op) {
        case 'turn': {
            // The wire names the row payload `turn`; the projector union names it
            // `summary`. One rename, and the id comes from the row when the frame
            // omits it (the row id is inside the row by contract).
            const summary = (wire.turn ?? wire.summary) as WireTurnSummary | undefined;
            if (summary === undefined) return undefined;

            return { op: 'turn', turnId: turnId.length > 0 ? turnId : summary.id, summary: projectRow(summary) };
        }

        case 'section:open': {
            const section = wire.section as WireTurnSection | undefined;
            if (section === undefined || turnId.length === 0) return undefined;

            return { op: 'section:open', turnId, section: projectSection(section) };
        }

        case 'section:set': {
            if (sectionId === undefined || turnId.length === 0) return undefined;

            return {
                op: 'section:set',
                turnId,
                sectionId,
                patch: (wire.patch ?? {}) as Extract<TurnDisplayOp, { op: 'section:set' }>['patch']
            };
        }

        case 'section:remove':
        case 'attempt:commit':
            if (sectionId === undefined || turnId.length === 0) return undefined;

            return { op: op.op, turnId, sectionId } as TurnDisplayOp;

        case 'node:insert': {
            const node = wire.node as WireNode | undefined;
            if (node === undefined || sectionId === undefined || turnId.length === 0) return undefined;

            const projected = projectNode(node);
            if (projected === undefined) return undefined;

            return {
                op: 'node:insert',
                turnId,
                sectionId,
                node: projected,
                ...(typeof wire.index === 'number' ? { index: wire.index } : {})
            };
        }

        case 'node:append': {
            const nodeId = typeof wire.nodeId === 'string' ? wire.nodeId : undefined;
            if (nodeId === undefined || sectionId === undefined || typeof wire.delta !== 'string') return undefined;

            return { op: 'node:append', turnId, sectionId, nodeId, delta: wire.delta };
        }

        case 'node:set': {
            const nodeId = typeof wire.nodeId === 'string' ? wire.nodeId : undefined;
            if (nodeId === undefined || sectionId === undefined) return undefined;

            return {
                op: 'node:set',
                turnId,
                sectionId,
                nodeId,
                patch: (wire.patch ?? {}) as Extract<TurnDisplayOp, { op: 'node:set' }>['patch']
            };
        }

        case 'node:remove':
        case 'context:remove': {
            const target = wire.nodeId ?? wire.blockId;
            if (typeof target !== 'string' || sectionId === undefined) return undefined;

            return op.op === 'node:remove'
                ? { op: 'node:remove', turnId, sectionId, nodeId: target }
                : { op: 'context:remove', turnId, sectionId, blockId: String(target) };
        }

        case 'step:set': {
            const step = wire.step as WireStep | undefined;
            if (step === undefined || sectionId === undefined) return undefined;

            return { op: 'step:set', turnId, sectionId, step: projectStep(step, { turnId, sectionId }) };
        }

        case 'context:add': {
            const block = wire.block as Extract<TurnDisplayOp, { op: 'context:add' }>['block'] | undefined;
            if (block === undefined || sectionId === undefined) return undefined;

            return {
                op: 'context:add',
                turnId,
                sectionId,
                block,
                ...(typeof wire.index === 'number' ? { index: wire.index } : {})
            };
        }

        case 'context:set': {
            const blockId = typeof wire.blockId === 'string' ? wire.blockId : undefined;
            if (blockId === undefined || sectionId === undefined) return undefined;

            return {
                op: 'context:set',
                turnId,
                sectionId,
                blockId,
                patch: (wire.patch ?? {}) as Extract<TurnDisplayOp, { op: 'context:set' }>['patch']
            };
        }

        case 'tail:set': {
            const tail = wire.tail as Extract<TurnDisplayOp, { op: 'tail:set' }>['tail'] | undefined;
            if (tail === undefined || sectionId === undefined) return undefined;

            return { op: 'tail:set', turnId, sectionId, tail };
        }

        case 'tail:clear':
            if (sectionId === undefined) return undefined;

            return { op: 'tail:clear', turnId, sectionId };

        case 'pending:set':
            return {
                op: 'pending:set',
                turnId,
                ...(sectionId === undefined ? { sectionId: '' } : { sectionId }),
                ...(wire.pending === undefined ? {} : { pending: wire.pending as never })
            };

        case 'usage':
            // `sectionId` is the literal 'turn' for the tile-wide figures; a frame
            // that names neither is a turn figure, which is the contract's reading.
            return {
                op: 'usage',
                turnId,
                sectionId: sectionId ?? 'turn',
                ...(typeof wire.latestInput === 'number' ? { latestInput: wire.latestInput } : {}),
                ...(typeof wire.cachedInput === 'number' ? { cachedInput: wire.cachedInput } : {}),
                ...(wire.usage === undefined ? {} : { usage: wire.usage as never })
            };

        case 'attempt:discard': {
            const nodeIds = wire.nodeIds;
            if (!Array.isArray(nodeIds) || sectionId === undefined) return undefined;

            return { op: 'attempt:discard', turnId, sectionId, nodeIds: nodeIds as string[] };
        }

        default:
            return undefined;
    }
};

// One frame's array. `display.ops` frames name the turn beside the ops, so every
// op that omits `turnId` inherits it — the id never comes from arrival order.
export const projectOps = (ops: readonly TurnDisplayOp[] | undefined, frameTurnId?: string): TurnDisplayOp[] => {
    if (!Array.isArray(ops)) return [];

    return ops
        .map((op) => projectOp(op, frameTurnId))
        .filter((op): op is TurnDisplayOp => op !== undefined);
};

// ---------------------------------------------------------------------------
// Lazy identified reads
// ---------------------------------------------------------------------------

// Lazy identified detail. Both answers cross a nominal boundary: the generated
// contract describes `TurnStepDetail`/`TurnBlockDetail` with its own event and
// label spellings, and the render model consumes the projector's versions (see
// ./display-project.ts for the field-by-field rules). These two functions are that
// one boundary — a caller never casts the answer itself.
// ---------------------------------------------------------------------------
// The lazy display plane (T21)
// ---------------------------------------------------------------------------

// A display tree is the ONE per-turn payload the render model cannot derive from a
// row, so it is fetched on demand: the tile the reader expanded first, then the
// rows that are actually on screen as they scroll in. The loader below is the whole
// policy, and its four rules are the reason it exists:
//
//   1. BOUNDED CONCURRENCY (default 4). A 25-row window must not open 25 parallel
//      identified reads; the backlog drains in batches as each read settles.
//   2. DEDUPE + CACHE. A repaint, an ops frame and ten scroll events all re-ask for
//      the same rows, and each re-ask is free — without this, "lazy" degenerates
//      into a request storm worse than the whole-document read it replaced.
//   3. GENERATION GUARD. `invalidate()` runs when the reader switches conversation
//      or a newer document lands: an in-flight answer from a superseded generation
//      resolves to `undefined` and is never painted (the same race discipline the
//      shell already applies to snapshot reads).
//   4. FAILURE IS NOT RETRIED. A rejected read is remembered for the generation, so
//      a turn deleted mid-scroll costs one request, never a loop, and the tile keeps
//      rendering from its row: a row is never blank because a tree failed.
export type DisplayLoader = {
    load(turnId: string): Promise<TurnDisplay | undefined>;
    // Requests every still-unloaded id, starting at most `concurrency` reads. Order
    // is the caller's (newest-first for a tail, oldest-first after a prepend); the
    // queue never re-sorts, because the board's order is the server's.
    pump(turnIds: readonly string[]): string[];
    tracked(turnId: string): boolean;
    // Marks every held/in-flight tree stale and returns the new generation.
    invalidate(): number;
    // Forgets the cache without dropping the generation (a reset emptied the window).
    reset(): void;
    generation(): number;
};

export const createDisplayLoader = (
    sessionId: string,
    options: { concurrency?: number; fetch?: (sessionId: string, turnId: string) => Promise<TurnDisplay> } = {}
): DisplayLoader => {
    const limit = Math.max(1, options.concurrency ?? 4);
    const read = options.fetch ?? ((session, turn) => readTurnDisplay(session, turn));

    let generation = 0;
    // One map, three states: dedupe and the no-retry rule are the same lookup.
    const state = new Map<string, 'loading' | 'done' | 'failed'>();
    const waiters = new Map<string, Set<(tree: TurnDisplay | undefined) => void>>();
    const backlog: string[] = [];
    let inFlight = 0;

    const settle = (turnId: string, tree: TurnDisplay | undefined): void => {
        const waiting = waiters.get(turnId);
        if (waiting === undefined) return;

        waiters.delete(turnId);
        for (const resolve of waiting) resolve(tree);
    };

    const drain = (): void => {
        while (inFlight < limit && backlog.length > 0) {
            const turnId = backlog.shift() as string;
            if (state.has(turnId)) continue;

            start(turnId, generation);
        }
    };

    function start(turnId: string, owner: number): void {
        state.set(turnId, 'loading');
        inFlight += 1;

        read(sessionId, turnId).then(
            (tree) => {
                inFlight -= 1;

                if (owner !== generation) {
                    state.delete(turnId);
                    settle(turnId, undefined);
                    drain();

                    return;
                }

                state.set(turnId, 'done');
                settle(turnId, tree);
                drain();
            },
            () => {
                inFlight -= 1;

                if (owner !== generation) {
                    state.delete(turnId);
                    settle(turnId, undefined);
                    drain();

                    return;
                }

                state.set(turnId, 'failed');
                settle(turnId, undefined);
                drain();
            }
        );
    }

    return {
        load: async (turnId) => {
            const owner = generation;
            const known = state.get(turnId);

            // A settled turn needs nothing: the shell already holds its tree.
            if (known === 'done' || known === 'failed') return undefined;

            const result = new Promise<TurnDisplay | undefined>((resolve) => {
                const waiting = waiters.get(turnId) ?? new Set<(tree: TurnDisplay | undefined) => void>();
                waiting.add(resolve);
                waiters.set(turnId, waiting);

                if (known === 'loading') return;

                if (inFlight < limit) start(turnId, owner);
                else backlog.push(turnId);
            });

            return result;
        },

        pump: (turnIds) => {
            const started: string[] = [];

            for (const turnId of turnIds) {
                if (state.has(turnId) || backlog.includes(turnId)) continue;

                // `pump` reports the reads it ACTUALLY started; the rest are queued and
                // admitted one at a time as each read settles. Reporting a queued id as
                // started would hide the very fan-out the cap exists to prevent.
                if (inFlight < limit) {
                    started.push(turnId);
                    start(turnId, generation);
                } else {
                    backlog.push(turnId);
                }
            }

            return started;
        },

        tracked: (turnId) => state.has(turnId) || backlog.includes(turnId),

        invalidate: () => {
            generation += 1;
            state.clear();
            backlog.length = 0;

            // Every waiter of the dropped generation resolves rather than hangs; the
            // caller's repaint just finds no tree, which looks like "not asked yet".
            for (const [, waiting] of waiters) {
                for (const resolve of waiting) resolve(undefined);
            }

            waiters.clear();

            return generation;
        },

        reset: () => {
            state.clear();
            backlog.length = 0;
        },

        generation: () => generation
    };
};

// One tree plus the background calls it states per section, in ONE read. The render
// model has no `pending` field on a section (../shared/turn-display.ts keeps the
// live figure in `pending:set` ops, and ./view-state.ts stores it in a side map), so
// a COLD document must carry its pending tools out-of-band or the "N still running"
// affordance would silently vanish after a reload. `readTurnDisplay` alone cannot
// say that, because it returns the render model.
export const readTurnDisplayWithPending = async (
    sessionId: string,
    turnId: string
): Promise<{ display: TurnDisplay; pending: { sectionId: string; pending: HarnessPendingTool[] }[] }> => {
    const wire = await getTurnDisplay(sessionId, turnId);

    return { display: projectDisplay(wire), pending: pendingSectionsOf(wire) };
};

// ---------------------------------------------------------------------------
// Lazy identified detail (R2)
// ---------------------------------------------------------------------------

export const readStepDetail = async (
    sessionId: string,
    turnId: string,
    stepId: string
): Promise<InternalTurnStepDetail> =>
    // The bytes are the same record: `opening`/`result` are the verbatim recorded
    // event pair, whose wire form is a superset of the domain union's fields.
    (await getStepDetail(sessionId, turnId, stepId)) as unknown as InternalTurnStepDetail;

export const readBlockDetail = async (
    sessionId: string,
    turnId: string,
    blockId: string
): Promise<InternalTurnBlockDetail> => {
    const block = await getBlockDetail(sessionId, turnId, blockId);

    // Same rename the bar applies everywhere else: the wire's `label` is the render
    // model's `name`, and `inPrompt` is not published (see ./display-project.ts).
    return {
        ...block,
        name: block.label ?? block.kind,
        inPrompt: true
    } as InternalTurnBlockDetail;
};

// One attachment's bytes, on demand. The descriptor (id, kind, marker, name, mime,
// size, `has_bytes`) already rides the row, so a chip renders without this read.
export const readAttachmentBytes = (sessionId: string, turnId: string, attachmentId: string) =>
    getAttachment(sessionId, turnId, attachmentId);

// The verbatim prompt of one row: the identified turn read. A tile that shows a
// preview and a "show full" affordance uses this, and nothing on the render path
// calls it for every row.
export const readTurnPrompt = async (sessionId: string, turnId: string): Promise<string | undefined> => {
    const turn = await getTurn(sessionId, turnId);

    return typeof turn.prompt === 'string' ? turn.prompt : undefined;
};

// Frozen definition: the configuration panel's read, never the transcript path's.
export const readDefinition = (sessionId: string): Promise<SessionDefinitionResource> =>
    getSessionDefinition(sessionId);

// Cost: the details dialog's read. The session header no longer carries a usage
// figure at all, so a stale tab refreshes this rather than the whole document.
export const readUsage = (sessionId: string): Promise<SessionUsageResponse> => getSessionUsage(sessionId);

// Composer slash commands: fetched on the first `/`, paged, not at session open.
export const readCommands = (sessionId: string, query: PageQuery = {}) => listSessionCommands(sessionId, query);

// Queue panel: bounded previews plus exact lengths, so a panel of a hundred waiting
// tasks stays a small read.
export const readQueue = (sessionId: string, query: PageQuery = {}) => listQueue(sessionId, query);

// Owner questions: the one roster read that rides a session open, because an
// unanswered question gates the composer and the answer must go to the right turn.
export const readActions = (sessionId: string): Promise<PendingAction[]> =>
    listPendingActions(sessionId).then((body) => body.actions);

// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

// One page of the session directory. The rail renders rows (metadata + counters),
// so a hundred long conversations is a constant-size read; the shell pulls the next
// page when the reader scrolls, never all of them at boot.
export const listSessionPage = (query: PageQuery = {}): Promise<Page<SessionSummary>> => listSessions(query);

// Every directory page, used ONLY by the "all conversations" dialog when the reader
// opens it. Bounded per page, and it stops at the cursor the server says is the end.
export const listAllSessions = async (limit = 100): Promise<SessionSummary[]> => {
    const rows: SessionSummary[] = [];
    let cursor: string | null | undefined;

    do {
        const page = await listSessionPage({ limit, ...(cursor === null || cursor === undefined ? {} : { cursor }) });
        rows.push(...page.items);
        cursor = page.nextCursor;

        // A collection the size of the contract's own budget is the practical end;
        // without this a pathological cursor loop could run forever.
        if (rows.length >= 5_000) break;
    } while (cursor !== null && cursor !== undefined && cursor.length > 0);

    return rows;
};

// ---------------------------------------------------------------------------
// Conversations (create / patch / reset / stop / delete)
// ---------------------------------------------------------------------------

export type CreateSessionInput = {
    harness: string;
    title?: string;
    settings?: { base_url?: string; api_key?: string; model?: string };
};

// `POST /sessions` — the answer is a metadata row, so a fresh conversation costs a
// header, not a document.
export const createSessionView = async (input: CreateSessionInput): Promise<SessionView> => {
    const session = await createSession({
        harness: input.harness,
        ...(input.title === undefined || input.title.length === 0 ? {} : { title: input.title }),
        ...(input.settings === undefined ? {} : { settings: input.settings })
    });

    return sessionViewOf(session);
};

// `PATCH /sessions/{id}` — the live model map merges and the answer is the patched
// row, so a model edit repaints the header from its own receipt.
export const patchSessionView = async (
    sessionId: string,
    input: Parameters<typeof updateSession>[1]
): Promise<SessionView> => sessionViewOf(await updateSession(sessionId, input));

export const resetConversation = (sessionId: string) => resetSession(sessionId);

export const stopConversation = (sessionId: string, all = true) => cancelSession(sessionId, all);

export const removeConversation = (sessionId: string) => deleteSession(sessionId);

export const removeConversationOnUnload = (sessionId: string) => deleteSessionOnUnload(sessionId);

export const stopThread = (sessionId: string, threadId: string) => cancelSessionThread(sessionId, threadId);

export const removeThread = (sessionId: string, threadId: string) => deleteSessionThread(sessionId, threadId);

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export type SubmitInput = {
    input: string;
    attachments?: Parameters<typeof submitTask>[1]['attachments'];
    references?: Parameters<typeof submitTask>[1]['references'];
    threadId?: string;
};

// `POST /sessions/{id}/tasks` (202) — a receipt. The caller paints the queued row
// from `rowFromReceipt` and lets the stream's `turn.upsert` replace it, which is
// what keeps a submit from costing a document read.
export const submitConversationTask = (sessionId: string, submit: SubmitInput): Promise<TaskReceipt> =>
    submitTask(sessionId, submit);

// The link set the receipt publishes (`turn`, `turns`, `thread`, `stream`). They
// are contract paths already rooted at `/v1/harness`, so the shell can follow one
// verbatim (a "jump to the turn" affordance) without rebuilding a URL.
export const receiptLink = (receipt: TaskReceipt, which: keyof TaskReceipt['links']): string => receipt.links[which];

// ---------------------------------------------------------------------------
// Transcript (read paged, edit whole-document with a concurrency guard)
// ---------------------------------------------------------------------------

// The metadata head and the editable document, composed into the editor's payload.
// Two bounded reads (a metadata head and one JSON text) rather than a message walk,
// because editing replaces the document and must see the bytes exactly as stored.
export const readTranscript = async (sessionId: string, threadId: string): Promise<import('./view-model').ThreadTranscriptPayload> => {
    const [metadata, document] = await Promise.all([
        getTranscriptMetadata(sessionId, threadId).catch<TranscriptMetadata | undefined>(() => undefined),
        getTranscriptDocument(sessionId, threadId).catch<TranscriptDocumentResponse | undefined>(() => undefined)
    ]);

    const raw = document?.document ?? '[]';

    if (document === undefined) {
        return {
            threadId,
            agent: metadata?.agent ?? '',
            messages: [],
            raw: '[]',
            revision: metadata?.revision ?? 0,
            invalid: { error: 'The transcript could not be read.', raw: '[]' }
        };
    }

    const unreadable = document.transcript_state === 'unreadable';

    if (!unreadable) {
        try {
            return {
                threadId,
                agent: document.agent,
                messages: JSON.parse(document.document),
                raw: document.document,
                revision: document.revision
            };
        } catch {
            // A `ok` state whose document is not parseable is treated as unreadable
            // rather than thrown: the editor still shows the bytes it was given.
        }
    }

    return {
        threadId,
        agent: document.agent,
        messages: [],
        raw: document.document,
        revision: document.revision,
        invalid: {
            error: metadata?.unreadable_reason ?? 'The stored transcript is not a readable transcript.',
            raw: document.document,
            ...(metadata?.stored_type === undefined ? {} : { storedType: metadata.stored_type })
        }
    };
};

// The paged message read — the "read to display" twin, for a pane that shows
// entries without offering to rewrite the document.
export const readTranscriptMessages = (sessionId: string, threadId: string, query: PageQuery = {}) =>
    listTranscriptMessages(sessionId, threadId, query);

// The whole-document PUT, with the transcript's own revision as the guard. A
// refused write (`if_revision` stale) is a conflict the editor resolves by
// re-reading, never a silent overwrite of the other writer's draft.
export const writeTranscript = (sessionId: string, threadId: string, messages: unknown, ifRevision?: number) =>
    putTranscriptDocument(sessionId, threadId, messages, ifRevision);

// The raw JSON a transcript export quotes: metadata + verbatim events per named
// turn, each page bounded. Opt-in and explicit (the export dialog), and it composes
// the pages a document needs instead of asking the server for an aggregate it no
// longer publishes.
export const readRawTurns = async (
    sessionId: string,
    turnIds: readonly string[]
): Promise<RawTurnDocument[]> => {
    const unique = [...new Set(turnIds)];
    const documents: RawTurnDocument[] = [];

    // Sequential on purpose: one export open must not fan out a burst of requests,
    // and each turn's event pages are ordered by their own cursor.
    for (const turnId of unique) {
        try {
            const metadata = await getTurn(sessionId, turnId);

            // Collected by the ROW INDEX the contract stamps on every event page
            // (`TurnEventPage.items[].index` = the turn's own event index), so the
            // export quotes the recorded order regardless of how the pages arrive.
            // A Map keyed by index also dedupes: a cursor that overlaps a previous
            // page must not repeat an event in a document the reader copies verbatim.
            const rows = new Map<number, { event: unknown; at: number }>();

            let cursor: string | null | undefined;

            do {
                const page = await listTurnEvents(sessionId, turnId, {
                    limit: 100,
                    ...(cursor === null || cursor === undefined ? {} : { cursor })
                });

                for (const row of page.items) rows.set(row.index, { event: row.event, at: row.at ?? 0 });

                cursor = page.nextCursor;
            } while (cursor !== null && cursor !== undefined && cursor.length > 0);

            const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);

            documents.push({
                id: metadata.id,
                index: metadata.index,
                prompt: metadata.prompt ?? '',
                status: metadata.status,
                ...(metadata.threadId === undefined ? {} : { threadId: metadata.threadId }),
                ...(metadata.startedAt === undefined ? {} : { startedAt: metadata.startedAt }),
                updatedAt: metadata.updatedAt,
                ...(metadata.usage === undefined ? {} : { usage: metadata.usage }),
                events: ordered.map(([, row]) => row.event),
                eventTimes: ordered.map(([, row]) => row.at)
            });
        } catch {
            // A turn deleted between the compiled read and this export is simply
            // gone; the document reports what still exists.
        }
    }

    return documents;
};

// The URL of one attachment's bytes, for an `<img>`/`<video>` source that must be a
// plain URL rather than a fetch. Built from the same route builder as everything
// else, so a mount change moves it exactly once.
//
// Contract route: `/v1/harness/sessions/{session_id}/turns/{turn_id}/attachments/
// {attachment_id}` (../shared/harness-api.ts:191). A URL that skips the SESSION
// segment dials a path the router never mounted, so all three ids are required and
// each segment is encoded on its own.
export const attachmentUrl = (sessionId: string, turnId: string, attachmentId: string): string =>
    apiUrl(
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdAttachmentsByAttachmentId(
            encodeURIComponent(sessionId),
            encodeURIComponent(turnId),
            encodeURIComponent(attachmentId)
        )
    );

// The pending-action request one card answers, so the answer route gets both ids
// from the card that is on screen (never from "the last action seen").
export const actionRequestOf = (action: PendingAction): HarnessActionRequest => action.request;
