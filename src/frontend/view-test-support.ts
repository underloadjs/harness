// Test support for the DISPLAY wire (T5). Production code never imports this file.
//
// Why it exists
// -------------
// The shell's end-to-end tests (main.test.ts, session-pills, activity-main, thread-routing, …)
// declare their server as RAW `SessionSnapshot` fixtures with recorded `turns[].events`, because
// that is the most compact way to describe a conversation. The browser under test now receives
// COMPILED state instead (`SessionView`, `TurnDisplay`, `TurnDisplayOp`). This module is the
// bridge: it answers the `/views` routes from the same fixtures, compiling the answer exactly the
// way the server does.
//
// Why the compilation here is not a second opinion
// ------------------------------------------------
// The fold is not reimplemented. It is the SERVER'S OWN projector — `projectTurn`,
// `refoldTurn` and `createTurnProjector` from `src/server/turn-projector.ts`, the same code
// `SessionStore.restore()` and the recorder call (src/server/turn-projector.ts:10-15). A green
// shell test is therefore evidence about the real compiled state, not about a parallel
// implementation that happens to agree.
//
// The double lives in test support and is imported by no production module, so "the browser
// performs no compilation" stays provable by looking at production imports (the Vite entry is
// `main.ts`; `src/structure.test.ts` pins the client barrel). The op SEMANTICS the renderer must
// honor are pinned separately, by hand-written `TurnDisplayOp` fixtures in
// `ui/turns-compiled.test.ts` and `view-state.test.ts` written straight from
// `src/shared/turn-display.ts`, never through this module — so a bug in the projector cannot hide
// a bug in the renderer.
//
// What it provides
// ----------------
//   - `viewOf`         : a raw snapshot -> a complete `SessionView` (rows + trees + compact roster).
//   - `viewSummaryOf`  : the same without the trees (the `GET /views` row shape).
//   - `summaryOfTurn`  : one recorded turn -> its `TurnSummary` row.
//   - `toViewItem`     : one RAW stream frame -> the display-wire frame a browser receives, through
//                        a live projector held per observer connection.
//   - `withViewRoutes` : a stub-server adapter — a test's raw `/sessions` routes answer every
//                        `/views` route the client asks for, translated in both directions.
//   - `viewAwareFetch` : the same adapter for a test that stubs `fetch(input, init)` directly.

import type { AgentResultBlock, AgentResultTurn } from '../shared/agent-results';
import { listAgentResultBlocks } from '../shared/agent-results';
import type { DisplayProjectContext, TurnDisplay, TurnDisplayOp, TurnProjector, TurnSummary } from '../shared/turn-display';
import { createTurnProjector, projectTurn, DISPLAY_NO_TIMESTAMP } from '../server/turn-projector';
import {
    HARNESS_API_ROOT,
    HARNESS_PAGE_LIMIT,
    HARNESS_SERVICE_CAPABILITIES,
    HARNESS_SERVICE_LIMITS
} from '../shared/harness-api';
import { HARNESS_WS_STREAM_LIMITS } from '../shared/harness-stream';
import { configureHarnessStream, resetHarnessStream } from './stream';
import type { StreamSocket, StreamSocketFactory } from './stream';
import type {
    SessionInvalidThread,
    SessionSnapshot,
    SessionStreamItem,
    SessionThread,
    SessionThreadView,
    SessionTurn,
    SessionView,
    SessionViewStreamItem,
    SessionViewSummary
} from '../server/protocol';

// ---------------------------------------------------------------------------
// The fold context (the same seeding the store performs)
// ---------------------------------------------------------------------------

// `DisplayProjectContext` is everything the fold needs that is NOT inside one turn record. The
// server supplies it from the session (`SessionStore.projectionTurns`); the double derives it from
// the raw fixture, which is the same data:
//   - `primary`            : the entry agent, i.e. the only section with `role: 'primary'`.
//   - `labels`             : `SessionSnapshot.labelSeeds[turnId]`, so a deletion never renumbers
//                            a surviving block's label (protocol.ts:495).
//   - `blocksOf`           : the conversation's OWN block projection (`listAgentResultBlocks` over
//                            the recorded prefix, agent-results.ts:652), which is where
//                            `TurnSummary.blocks` gets `RR1`/`RR2` — one chained allocator, so the
//                            labels are conversation-scoped exactly as on the wire.
export const projectContextOf = (
    snapshot: SessionSnapshot,
    options: { primary?: string; expiredRequestIds?: ReadonlySet<string> } = {}
): DisplayProjectContext => {
    const primary =
        options.primary ??
        (snapshot.harnessDefinition as { primary?: string } | undefined)?.primary ??
        snapshot.harness;

    // Projected once per snapshot and filtered per turn, like the store's memoized prefix read.
    let blocks: AgentResultBlock[] | undefined;
    const blocksFor = (): AgentResultBlock[] => {
        if (blocks === undefined) {
            const turns = (Array.isArray(snapshot.turns) ? snapshot.turns : []) as unknown as AgentResultTurn[];
            blocks = listAgentResultBlocks(turns);
        }

        return blocks;
    };

    // Invocation id -> conversation display label (`DisplayProjectContext.threadLabels`,
    // turn-display.ts:628). On the server that map is persisted
    // (`HarnessSessionRecord.threadLabels`); a raw snapshot exposes the same facts through its
    // roster (`threads[].label` plus the invocation ids that conversation ran), which is exactly
    // what `turn-projector.ts:486` reads to label a nested child's flow.
    let labels: Map<string, string> | undefined;
    const threadLabels = (): Map<string, string> => {
        if (labels === undefined) {
            labels = new Map<string, string>();
            for (const thread of Array.isArray(snapshot.threads) ? (snapshot.threads as unknown as SessionThread[]) : []) {
                const name = typeof thread.label === 'string' && thread.label.length > 0 ? thread.label : undefined;
                if (name === undefined) continue;
                for (const id of [
                    thread.invocationId,
                    thread.originInvocationId,
                    ...(Array.isArray(thread.invocationIds) ? thread.invocationIds : [])
                ]) {
                    if (typeof id === 'string' && id.length > 0) labels.set(id, name);
                }
            }
        }

        return labels;
    };

    return {
        primary,
        ...(options.expiredRequestIds === undefined ? {} : { expiredRequestIds: options.expiredRequestIds }),
        blocksOf: (turn) => blocksFor().filter((block) => block.turnId === turn.id),
        // Only supplied when the fixture actually names a conversation, so a roster-less session
        // folds exactly as it did before the label map existed.
        ...(threadLabels().size === 0 ? {} : { threadLabels: threadLabels() })
    };
};

// A per-turn context: the fold reads `context.labels` for the turn it projects
// (`SessionSnapshot.labelSeeds[turnId]`, protocol.ts:495), so the context is rebuilt per turn
// rather than shared across the session.
const contextForTurn = (
    snapshot: SessionSnapshot,
    turn: SessionTurn,
    options: { primary?: string; expiredRequestIds?: ReadonlySet<string> } = {}
): DisplayProjectContext => {
    const context = projectContextOf(snapshot, options);
    const seeds = snapshot.labelSeeds as Record<string, Record<string, number>> | undefined;

    return {
        ...context,
        ...(seeds?.[turn.id] === undefined ? {} : { labels: seeds[turn.id] })
    };
};

// ---------------------------------------------------------------------------
// Raw snapshot -> compiled view
// ---------------------------------------------------------------------------

// The bounded transcript signal the compact roster publishes (`SessionThreadView`,
// protocol.ts:408): the roster keeps its identity fields verbatim and replaces `messages` — the
// single biggest payload class on the raw surface — with a count, a `hasTranscript` bit and a
// bounded preview. `/views` also OMITS `threads`, and this double does the same, so a test cannot
// accidentally pass on the raw roster.
const rosterOf = (snapshot: SessionSnapshot): SessionThreadView[] | undefined => {
    const threads = Array.isArray(snapshot.threads) ? (snapshot.threads as unknown as SessionThread[]) : undefined;
    if (threads === undefined || threads.length === 0) return undefined;

    return threads.map((thread) => {
        const messages = Array.isArray(thread.messages) ? thread.messages : [];
        const last = messages[messages.length - 1] as { content?: unknown } | undefined;
        const preview = typeof last?.content === 'string' ? last.content.slice(0, 200) : undefined;

        return {
            id: thread.id,
            agent: thread.agent,
            origin: thread.origin ?? 'host',
            status: thread.status ?? 'idle',
            sequence: thread.sequence,
            ...(thread.ownerThreadId === undefined ? {} : { ownerThreadId: thread.ownerThreadId }),
            ...(thread.label === undefined ? {} : { label: thread.label }),
            ...(thread.invocationId === undefined ? {} : { invocationId: thread.invocationId }),
            ...(thread.originTurnId === undefined ? {} : { originTurnId: thread.originTurnId }),
            ...(thread.originInvocationId === undefined ? {} : { originInvocationId: thread.originInvocationId }),
            ...(thread.invocationIds === undefined ? {} : { invocationIds: [...thread.invocationIds] }),
            ...(thread.references === undefined ? {} : { references: thread.references }),
            ...(thread.connectedThreadIds === undefined ? {} : { connectedThreadIds: [...thread.connectedThreadIds] }),
            messageCount: messages.length,
            ...(preview === undefined ? {} : { preview }),
            hasTranscript: messages.length > 0
        };
    });
};

// A complete `SessionView` for a raw snapshot: every recorded turn folded by the server's own
// `projectTurn`, keyed by turn id. `messages` (the entry agent's transcript) and the raw
// `turns[].events` are dropped, because the display contract has no place for them.
export const viewOf = (
    snapshot: SessionSnapshot,
    options: { primary?: string; expiredRequestIds?: ReadonlySet<string> } = {}
): SessionView => {
    const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
    const displays: Record<string, TurnDisplay> = {};
    const rows: TurnSummary[] = [];

    for (const turn of turns) {
        const projected = projectTurn(turn, contextForTurn(snapshot, turn, options));
        rows.push(projected.summary);
        displays[turn.id] = projected.display;
    }

    const roster = rosterOf(snapshot);
    const invalidThreads = Array.isArray(snapshot.invalidThreads)
        ? (snapshot.invalidThreads as SessionInvalidThread[])
        : undefined;

    const { turns: _turns, messages: _messages, threads: _threads, ...header } = snapshot as SessionSnapshot & {
        messages?: unknown;
    };

    return {
        ...header,
        turns: rows,
        displays,
        ...(roster === undefined ? {} : { threadViews: roster }),
        ...(invalidThreads === undefined || invalidThreads.length === 0 ? {} : { invalidThreads })
    } as SessionView;
};

// The compact counterpart of `SessionSnapshot` for a directory read (`SessionViewSummary`, i.e.
// `SessionView` without the node trees).
export const viewSummaryOf = (
    snapshot: SessionSnapshot,
    options?: { primary?: string; expiredRequestIds?: ReadonlySet<string> }
): SessionViewSummary => {
    const { displays: _displays, ...rest } = viewOf(snapshot, options);

    return rest;
};

// One recorded turn's compact row (the `turn` field of a submit answer).
export const summaryOfTurn = (
    snapshot: SessionSnapshot,
    turn: SessionTurn,
    options?: { primary?: string; expiredRequestIds?: ReadonlySet<string> }
): TurnSummary => projectTurn(turn, contextForTurn(snapshot, turn, options)).summary;

// A turn's compiled tree, straight from the fold — used by tests that assert the display state
// without going through a route.
export const displayOfTurn = (
    snapshot: SessionSnapshot,
    turnId: string,
    options?: { primary?: string; expiredRequestIds?: ReadonlySet<string> }
): TurnDisplay | undefined => {
    const turn = (snapshot.turns ?? []).find((candidate) => candidate.id === turnId);

    return turn === undefined ? undefined : projectTurn(turn, contextForTurn(snapshot, turn, options)).display;
};

// ---------------------------------------------------------------------------
// Raw stream frame -> display-wire frame
// ---------------------------------------------------------------------------

// One live fold per observed turn, holding the turn record the projector reads BY REFERENCE
// (`createTurnProjector`, turn-projector.ts:402 — the store mutates the same record, so does the
// double as frames arrive).
export type LiveFold = {
    record: SessionTurn;
    projector: TurnProjector;
};

// Terminal turn statuses — the same definition `src/server/sessions.ts:853` keeps local, and the
// gate `mirrorView` uses to choose between `settle` and a plain row upsert (sessions.ts:2835).
const isTerminalTurn = (status: SessionTurn['status']): boolean =>
    status === 'done' || status === 'error' || status === 'cancelled';

// The entry agent of a recorded turn when the caller gave no host snapshot: the agent of the first
// ROOT `start` (a root run's events carry no `thread`, types/index.ts:1659). Falls back to the
// first `start` of any kind, and to '' when the fixture has none — the fold then treats every
// section as nested, which is the honest reading of a turn with no root run.
const primaryOf = (turn: SessionTurn): string => {
    let root = '';
    let nested = '';

    for (const event of Array.isArray(turn.events) ? turn.events : []) {
        if (event.type !== 'start') continue;
        if (event.thread === undefined) {
            root = event.agent;
            break;
        }
        if (nested === '') nested = event.agent;
    }

    return root !== '' ? root : nested;
};

// Translate one RAW frame into the display-wire frame a browser receives.
//
//   - `snapshot`  -> `view`      (the atomic state at registration, self-sufficient);
//   - `turn`      -> `ops`       EXACTLY as `SessionStore.mirrorView` publishes them: a terminal
//                                 turn settles its rows (`settle`), any other status upserts the
//                                 compact row (`{op:'turn'}`) and leaves every section open
//                                 (sessions.ts:2832);
//   - `event`     -> `ops`       from the SAME `apply()` the recorder calls, so the ops are exactly
//                                 the ones that live stream would have sent;
//   - `failed`    -> `failed`    with the full `view` (the error terminal stays self-sufficient).
//
// `folds` carries the per-connection projectors, so a reconnect (a fresh map) starts a fresh op
// sequence — which is what makes the `view` frame's reconciliation observable in a test.
export const toViewItem = (
    item: SessionStreamItem,
    folds: Map<string, LiveFold>,
    snapshot?: SessionSnapshot,
    options: { primary?: string; expiredRequestIds?: ReadonlySet<string> } = {}
): SessionViewStreamItem => {
    const host = snapshot ?? undefined;

    if (item.type === 'snapshot') return { type: 'view', view: viewOf(item.session, options) };
    if (item.type === 'failed') return { type: 'failed', error: item.error, view: viewOf(item.session, options) };

    // The host snapshot supplies the label seeds and the block prefix. Without one (a test that
    // streams frames with no session context) the fold still runs; the entry agent is then derived
    // from the first threadless `start`, which is the root run's own identity (types/index.ts:1659
    // — a root run's events carry no `thread`).
    const contextOf = (turn: SessionTurn): DisplayProjectContext =>
        host === undefined
            ? { primary: options.primary ?? primaryOf(turn) }
            : contextForTurn(host, turn, options);

    if (item.type === 'turn') {
        const turn = item.turn;
        let fold = folds.get(turn.id);

        if (fold === undefined) {
            // A turn first seen on this connection: replay what is already recorded, then hold the
            // projector so later `event` frames continue from the cached state (`refoldTurn`, the
            // same entry `SessionStore.restore()` uses).
            fold = { record: turn, projector: createTurnProjector(turn, contextOf(turn)) };
            for (let index = 0; index < turn.events.length; index += 1) {
                const at = turn.eventTimes?.[index];
                fold.projector.apply(turn.events[index], typeof at === 'number' ? at : DISPLAY_NO_TIMESTAMP, index);
            }
            // `projectorFor` settles a record that is ALREADY terminal (sessions.ts:2546) so a
            // cold fold never leaves rows "streaming".
            if (isTerminalTurn(turn.status)) fold.projector.settle(turn.status, turn.updatedAt);
            folds.set(turn.id, fold);
        } else {
            // The record travels by reference, but a later frame may carry a NEWER revision of it
            // (status, usage, steers); adopt the revision and keep the fold.
            fold.record = turn;
        }

        // EXACTLY `SessionStore.mirrorView` (sessions.ts:2832-2839): only a TERMINAL turn calls
        // `settle`, because settling a `running` turn would close every section and gate off the
        // result-only frames that follow. Anything else upserts the row the projector computed —
        // one `{op:'turn'}` op.
        const ops: TurnDisplayOp[] = isTerminalTurn(turn.status)
            ? fold.projector.settle(turn.status, turn.updatedAt)
            : [{ op: 'turn', turnId: turn.id, summary: fold.projector.summary() }];

        return { type: 'ops', turnId: turn.id, at: turn.updatedAt, ops };
    }

    // An `event` frame needs a fold. A test that streams events before any `turn` frame gets one
    // seeded from the recorded turn in the host snapshot, so the ops are still addressed by the
    // node ids the cold fold would have minted.
    let fold = folds.get(item.turnId);
    if (fold === undefined) {
        const recorded = host?.turns?.find((candidate) => candidate.id === item.turnId);
        const record: SessionTurn =
            recorded ??
            ({
                id: item.turnId,
                index: 0,
                prompt: '',
                status: 'running',
                updatedAt: typeof item.at === 'number' ? item.at : DISPLAY_NO_TIMESTAMP,
                events: []
            } as SessionTurn);

        fold = { record, projector: createTurnProjector(record, contextOf(record)) };

        // The seeded record may already hold events (a connection that opens mid-turn): replay
        // them so the fold's tree matches the store's, exactly as `projectorFor` does.
        for (let index = 0; index < record.events.length; index += 1) {
            const at = record.eventTimes?.[index];
            fold.projector.apply(record.events[index], typeof at === 'number' ? at : DISPLAY_NO_TIMESTAMP, index);
        }
        if (isTerminalTurn(record.status)) fold.projector.settle(record.status, record.updatedAt);

        folds.set(item.turnId, fold);
    }

    const index = fold.record.events.length;
    const at = typeof item.at === 'number' ? item.at : DISPLAY_NO_TIMESTAMP;
    fold.record.events.push(item.event);
    const ops = fold.projector.apply(item.event, at, index);

    return { type: 'ops', turnId: item.turnId, at, ops };
};

// A convenience for tests that drive one connection from a list of raw frames.
export const viewItemsOf = (
    items: readonly SessionStreamItem[],
    snapshot?: SessionSnapshot,
    options?: { primary?: string; expiredRequestIds?: ReadonlySet<string> }
): SessionViewStreamItem[] => {
    const folds = new Map<string, LiveFold>();

    return items.map((item) => toViewItem(item, folds, snapshot, options));
};

// ---------------------------------------------------------------------------
// Stub-server route translation
// ---------------------------------------------------------------------------

// The shape both a test's own router and this adapter speak: the URL the browser asked for
// (`/api/views/s1` or an absolute origin), the method, and the parsed JSON body. Returning
// `undefined` means "this stub has no such route", which the client reads as a failure.
//
// `context.init` is the ORIGINAL `RequestInit` when the caller is a `fetch` stub: the adapter only
// rewrites the URL, and a stubbed server that inspects `keepalive`, `headers` or `signal` (the
// page-unload delete, the abortable observer) must still see them.
export type StubContext = { init?: RequestInit };

// A compiled row -> the wire row: `prompt` becomes the bounded `promptPreview`
// plus the exact `promptChars`, because a canonical row never carries the
// verbatim prompt (that is the identified turn read, shared/harness-api.ts
// `TurnSummary`). Both the page answers below and the stream double's
// `turn.upsert` payload use this one mapping.
export const wireRowOf = (summary: TurnSummary): Record<string, unknown> => {
    const { prompt, ...rest } = summary as TurnSummary & { prompt?: string };
    const text = typeof prompt === 'string' ? prompt : '';

    return { ...rest, promptPreview: text, promptChars: text.length };
};

// A raw snapshot -> the canonical `session.updated` patch (shared/harness-api.ts:2048
// `SessionStatePatch`): metadata only — a patch never carries rows, trees or messages.
const statePatchOf = (snapshot: SessionSnapshot): Record<string, unknown> => ({
    id: snapshot.id,
    status: snapshot.status,
    model: snapshot.model,
    revision: (snapshot as { revision?: number }).revision ?? 1,
    ...((snapshot as { queueDepth?: number }).queueDepth === undefined
        ? {}
        : { queue_depth: (snapshot as { queueDepth?: number }).queueDepth }),
    ...((snapshot as { lastError?: string }).lastError === undefined
        ? {}
        : { last_error: (snapshot as { lastError?: string }).lastError }),
    ...((snapshot as { agentModels?: Record<string, string> }).agentModels === undefined
        ? {}
        : { agent_models: (snapshot as { agentModels?: Record<string, string> }).agentModels })
});

export type StubHandler = (
    url: string,
    method?: string,
    body?: unknown,
    context?: StubContext
) => Response | undefined | Promise<Response | undefined>;

export type ViewRouteOptions = {
    // Mount prefix of the stubbed server (`/api` standalone, `/v1/harness` in the service mount).
    root?: string;
    // The raw snapshot the raw routes describe. Used to compose the lazy-detail and raw-export
    // answers and to seed a live fold that starts mid-turn. A getter lets a mutation's effect show.
    snapshot?: () => SessionSnapshot | undefined;
    // The entry agent for the fold, when a fixture's snapshot does not carry `harnessDefinition`.
    primary?: string;

};

// The one-line migration for a shell test's stub server.
//
// A test declares its routes the way it always did (`GET /api/sessions/s1` -> a raw
// `SessionSnapshot`, `POST .../tasks` -> a raw 202, an SSE body of `turn`/`event` frames). This
// adapter sits in FRONT of that handler: when the shell asks a `/views` route (its default path
// now), the request is rewritten to its raw twin, the test's own handler answers it, and the
// ANSWER is translated into the display contract — a `{session}` envelope becomes `{view}`, a
// `{sessions}` index becomes `{views}`, and a stream of raw frames becomes a stream of
// `view`/`ops` frames through the server's own projector.
//
// The direction matters: raw IN, compiled OUT. The code under test never sees a raw body on a
// `/views` route, so a green shell test is evidence about the compiled path — and, because the
// `/views` request must exist for the raw route to be reached at all, about the client asking for
// the display wire.
export const withViewRoutes = (inner: StubHandler, options: ViewRouteOptions = {}): StubHandler => {
    const root = options.root ?? HARNESS_API_ROOT;
    const jsonOf = (value: unknown, status = 200): Response =>
        new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

    const readJson = async (response: Response): Promise<Record<string, unknown> | undefined> => {
        try {
            return (await response.clone().json()) as Record<string, unknown>;
        } catch {
            return undefined;
        }
    };

    // The raw document the stubbed server describes. A test may name it explicitly (a getter, so a
    // mutation's effect is visible); otherwise it is read THROUGH THE TEST'S OWN ROUTE
    // (`GET {root}/sessions/:id`), which is the very same document. That is what lets the lazy
    // detail, the per-turn raw export and the transcript composition answer a test that never
    // declared those routes at all.
    const hostOf = async (sessionId: string): Promise<SessionSnapshot | undefined> => {
        const explicit = options.snapshot?.();
        if (explicit !== undefined) return explicit;

        // A GET carries no method in these stubs' convention (the client omits it), so the read is
        // made the same way: `undefined`, not `'GET'`.
        const response = await inner(`${root}/sessions/${encodeURIComponent(sessionId)}`, undefined, undefined);
        if (response === undefined) return undefined;
        const payload = (await readJson(response)) as { session?: SessionSnapshot } | undefined;

        return payload?.session;
    };

    // The most recent raw document this adapter has SEEN (a translated `{session}` answer, or a
    // `snapshot`/`failed` stream frame). A live fold needs the same `DisplayProjectContext` the
    // store supplies — the entry agent, the label seeds, the block prefix — and this document is
    // that context, without asking the stub for an extra request the browser never makes. The
    // shell always holds one before it opens an observer (the create/202 answer lands first), so a
    // stream that begins with a `turn`/`event` frame still folds with the right entry agent.
    let lastSeenSession: SessionSnapshot | undefined;

    // A raw JSON answer -> its display-wire counterpart. Only the two session-carrying envelopes
    // are rewritten; everything else (`{deleted}`, `{cancelled}`, `{ok}`, `{models}`, a tool
    // catalogue, a thread transcript) passes through untouched, in its original status.
    const translateJson = (payload: Record<string, unknown>, status: number): Response => {
        const translated: Record<string, unknown> = { ...payload };

        if (Array.isArray(payload.sessions)) {
            const listed = payload.sessions as SessionSnapshot[];
            translated.views = listed.map((session) => viewSummaryOf(session, { primary: options.primary }));
            delete translated.sessions;

            return jsonOf(translated, status);
        }

        if (payload.session === undefined) return jsonOf(payload, status);

        const session = payload.session as SessionSnapshot;
        lastSeenSession = session;
        translated.view = viewOf(session, { primary: options.primary });
        delete translated.session;

        // A submit/answer envelope carries the NEW turn record next to the session; on the display
        // wire that field is the turn's compact row (protocol.ts:705), folded with the same seeds
        // the store would use.
        if (payload.turn !== undefined) {
            translated.turn = summaryOfTurn(session, payload.turn as SessionTurn, { primary: options.primary });
        }

        return jsonOf(translated, status);
    };

    // A raw SSE body -> a display-wire SSE body, frame for frame, ASYNCHRONOUSLY.
    //
    // The transform is incremental on purpose: a test pushes frames into an open stream and asserts
    // what the browser painted BETWEEN pushes (an activity ring, streamed text, a drain frame).
    // Buffering the whole body first would deliver nothing until the source closes, silently
    // turning those tests into "never rendered".
    const translateStream = (response: Response, sessionId: string): Response => {
        const source = response.body;
        if (source === null) return response;

        // One fold per observer connection, like the store's own watcher subscription
        // (src/server/sessions.ts watch()); a reconnect therefore starts a fresh op sequence.
        const folds = new Map<string, LiveFold>();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let pending = '';

        // The snapshot a stream opens with seeds the per-turn folds, so an `event` frame that
        // arrives before any `turn` frame still produces real ops. Seeding order: the snapshot the
        // test named, the newest document this adapter has already translated, then — once, lazily —
        // the test's own session route. A fixture with none of those folds from the turn record's
        // root `start` (`primaryOf`), which is the honest reading of a stream that never names the
        // entry agent.
        let context: SessionSnapshot | undefined = options.snapshot?.() ?? lastSeenSession;
        let seeding: Promise<SessionSnapshot | undefined> | undefined;
        let seedTried = false;
        const seed = async (): Promise<SessionSnapshot | undefined> => {
            if (context !== undefined || seedTried) return context;
            seedTried = true;
            seeding ??= hostOf(sessionId);

            try {
                context = await seeding;
            } catch {
                // A strict stub throws for a route the browser never asks for; the fallback above
                // then decides the entry agent from the recorded events.
                context = undefined;
            }

            return context;
        };

        const dataOf = (block: string): string | undefined => {
            const data = block
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');

            return data.length > 0 ? data : undefined;
        };

        // ASYNC on purpose: the host document is what makes a live fold equal the server's, and
        // reading it is a route round trip. `TransformStream` awaits this callback, so frames stay
        // strictly in order and a test still asserts BETWEEN pushes.
        const translateFrame = async (block: string): Promise<string | undefined> => {
            const data = dataOf(block);
            if (data === undefined) return undefined;

            let raw: SessionStreamItem;
            try {
                raw = JSON.parse(data) as SessionStreamItem;
            } catch {
                return undefined;
            }

            if (raw.type === 'snapshot' || raw.type === 'failed') {
                context = raw.session;
                // A later observer connection (a reconnect) folds against the newest document the
                // stub has published, exactly as the store's watcher does.
                lastSeenSession = raw.session;
            }
            // A frame that opens a fold before any snapshot frame has arrived still needs the
            // entry agent, the label seeds and the block prefix the store supplies.
            else if (context === undefined) await seed();

            const item = toViewItem(raw, folds, context, { primary: options.primary });

            return `data: ${JSON.stringify(item)}\n\n`;
        };

        const body = source.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
                async transform(chunk, controller) {
                    pending += decoder.decode(chunk, { stream: true });

                    // A frame ends at the blank line; anything after the last one is still arriving.
                    const blocks = pending.split('\n\n');
                    pending = blocks.pop() ?? '';

                    for (const block of blocks) {
                        const frame = await translateFrame(block);
                        if (frame !== undefined) controller.enqueue(encoder.encode(frame));
                    }
                },
                async flush(controller) {
                    // A server that closes without a trailing blank line still gets its last frame.
                    pending += decoder.decode();
                    if (pending.trim().length === 0) return;

                    const frame = await translateFrame(pending);
                    if (frame !== undefined) controller.enqueue(encoder.encode(frame));
                }
                // No `cancel` handler: `pipeThrough` propagates a cancel to the source body, which
                // is exactly the "the browser stopped watching" behaviour a test expects.
            })
        );

        return new Response(body, { status: response.status, headers: { 'Content-Type': 'text/event-stream' } });
    };

    // `GET /views/:id/turns/:turnId/steps/:stepId` — the lazy detail answer, composed from the raw
    // session read the test already declares. `stepId` is the OPENING event's index
    // (turn-display.ts:298), so the pair is found by identity, never by position: the opening event
    // at that index plus the first later settle event that names it (`tool_result.callId` /
    // `action_answer.requestId`). `sectionId` comes from the compiled tree, which is the same
    // address the browser holds.
    const stepDetail = async (sessionId: string, turnId: string, stepId: string): Promise<Response> => {
        const host = await hostOf(sessionId);
        const turn = host?.turns?.find((candidate) => candidate.id === turnId);
        if (turn === undefined) return jsonOf({ error: { message: `Unknown turn ${turnId}` } }, 404);

        const index = Number(stepId);
        const opening = turn.events[index];
        if (opening === undefined) return jsonOf({ error: { message: `Unknown step ${stepId}` } }, 404);

        const times = Array.isArray(turn.eventTimes) ? turn.eventTimes : [];
        const at = (position: number): number | undefined =>
            typeof times[position] === 'number' ? (times[position] as number) : undefined;

        let resultIndex = -1;
        if (opening.type === 'tool_call') {
            resultIndex = turn.events.findIndex(
                (event, position) => position > index && event.type === 'tool_result' && event.callId === opening.call.id
            );
        } else if (opening.type === 'action_request') {
            resultIndex = turn.events.findIndex(
                (event, position) =>
                    position > index && event.type === 'action_answer' && event.requestId === opening.request.requestId
            );
        }

        const display = displayOfTurn(host ?? ({ turns: [turn] } as unknown as SessionSnapshot), turnId, {
            primary: options.primary
        });
        const section = display?.sections.find((candidate) =>
            candidate.nodes.some((node) => node.id === stepId && (node.kind === 'tool' || node.kind === 'action'))
        );

        return jsonOf({
            detail: {
                sessionId,
                turnId,
                stepId,
                // An addressable step always belongs to a section; the fallback keeps the shape
                // valid if a fixture's tree was never folded (a hand-written turn with no events).
                sectionId: section?.id ?? `${turnId}:0`,
                ...(opening.type === 'tool_call' && opening.call.id !== undefined ? { callId: opening.call.id } : {}),
                opening: { index, ...(at(index) === undefined ? {} : { at: at(index) as number }), event: opening },
                ...(resultIndex < 0
                    ? {}
                    : {
                          result: {
                              index: resultIndex,
                              ...(at(resultIndex) === undefined ? {} : { at: at(resultIndex) as number }),
                              event: turn.events[resultIndex]
                          }
                      })
            }
        });
    };

    // `GET /views/:id/turns/:turnId/blocks/:blockId` - the ONE context-bar segment detail (T11,
    // R8). Composed exactly the way `stepDetail` composes its pair, from the raw session read the
    // test already declares: the block is looked up in the COMPILED tree (the same address the
    // browser holds), and its bytes come from the recorded range the block names
    // (`eventFrom..eventTo`), which is what `SessionStore.blockDetail` concatenates on the server.
    // The metadata rides back embedded by value (../shared/turn-display.ts:494), so a test can
    // prove the segment the browser was given is the segment it gets the text of.
    const blockDetail = async (sessionId: string, turnId: string, blockId: string): Promise<Response> => {
        const host = await hostOf(sessionId);
        const turn = host?.turns?.find((candidate) => candidate.id === turnId);
        if (turn === undefined) return jsonOf({ error: { message: `Unknown turn ${turnId}` } }, 404);

        const display = displayOfTurn(host ?? ({ turns: [turn] } as unknown as SessionSnapshot), turnId, {
            primary: options.primary
        });
        const section = display?.sections.find((candidate) => (candidate.context ?? []).some((entry) => entry.id === blockId));
        const block = section?.context?.find((entry) => entry.id === blockId);

        if (block === undefined || section === undefined) return jsonOf({ error: { message: `Unknown block ${blockId}` } }, 404);

        const events = turn.events ?? [];
        const from = block.eventFrom ?? 0;
        const to = block.eventTo ?? Math.max(0, events.length - 1);
        const window = events.slice(from, to + 1);
        const detail: Record<string, unknown> = { ...block, sessionId };

        if (block.kind === 'tool') {
            const callEvent = window.find((event) => event.type === 'tool_call');
            const callId = callEvent?.type === 'tool_call' ? callEvent.call.id : undefined;

            if (callEvent !== undefined && callEvent.type === 'tool_call') detail.args = callEvent.call.arguments ?? '';

            const settled = window.find((event) => event.type === 'tool_result' && (callId === undefined || event.callId === callId));
            if (settled !== undefined && settled.type === 'tool_result') detail.result = settled.content;
        } else if (block.kind === 'system') {
            // The instruction entries the agent ACTUALLY ran with. A fixture with no recorded
            // source has none, and omitting the field is the honest answer (the server states the
            // absence the same way, ../shared/turn-display.ts:506).
            const sources = ((host as { turnInstructionSources?: { agent: string; instructions: readonly string[] }[] } | undefined)?.turnInstructionSources ?? []).filter(
                (source) => source.agent === section.agent
            );

            if (sources.length > 0) detail.entries = sources.flatMap((source) => [...source.instructions]);
        } else if (block.kind === 'user') {
            // `0-user-prompt` is the turn's own prompt; `0-user-s2` is that steer's recorded
            // submit (../shared/turn-display.ts:393).
            const suffix = block.id.split('-').pop() ?? '';
            const steer = /^\d+$/.test(suffix) ? turn.steers?.[Number(suffix)] : undefined;

            detail.text = steer?.prompt ?? turn.prompt;
        } else {
            const wanted = block.kind === 'reasoning' ? 'reasoning' : 'text';

            detail.text = window
                .filter((event) => event.type === wanted)
                .map((event) => (event.type === 'text' || event.type === 'reasoning' ? event.delta : ''))
                .join('');
        }

        return jsonOf({ block: detail });
    };

    // -----------------------------------------------------------------------
    // Canonical route adapter (T17)
    // -----------------------------------------------------------------------
    //
    // The same raw fixtures, answered on the canonical surface. Every envelope is
    // built to the generated contract's spelling (`../shared/harness-api.ts`), so a
    // shell test that passes through here is evidence about the REAL wire shape:
    // resources are snake_case, the display subtree stays camelCase, collections are
    // pages with `next_cursor`/`revision`, and every write answers a receipt rather
    // than a document. Nothing here hands the client a legacy `/views` document.
    const nowOf = (): number => Date.now();

    const pageOf = <T>(items: T[], revision = 1, nextCursor: string | null = null) => ({
        items,
        limit: HARNESS_PAGE_LIMIT.default,
        next_cursor: nextCursor,
        observed_at: nowOf(),
        revision
    });

    // A raw `SessionSnapshot` -> the canonical metadata row. Counters are computed
    // from the fixture (turn/thread counts), which is exactly what the contract's row
    // publishes INSTEAD of the children themselves.
    const sessionResourceOf = (snapshot: RawSnapshotEx): Record<string, unknown> => {
        const threads = Array.isArray(snapshot.threadViews)
            ? snapshot.threadViews
            : (snapshot.threads ?? []).map((thread) => ({ ...thread }));

        return {
            id: snapshot.id,
            ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
            harness: snapshot.harness,
            status: snapshot.status,
            ...(snapshot.queueDepth === undefined ? {} : { queue_depth: snapshot.queueDepth }),
            model: snapshot.model,
            created_at: snapshot.createdAt,
            updated_at: snapshot.updatedAt,
            ...(snapshot.lastError === undefined ? {} : { last_error: snapshot.lastError }),
            turn_count: (snapshot.turns ?? []).length,
            thread_count: threads.length,
            revision: snapshot.revision ?? 1,
            definition_revision: 1,
            agent_models: snapshot.agentModels ?? {},
            endpoint: { base_url: '', model: snapshot.model, has_api_key: false },
            runtime_execution: 'inline',
            pending_action_count: (snapshot as { actions?: unknown[] }).actions?.length ?? 0,
            created_tool_count: 0,
            created_tool_limit: HARNESS_SERVICE_LIMITS.created_tools
        };
    };

    // A compiled row -> the wire row: see the module-level `wireRowOf` (shared with the stream
    // double, whose `turn.upsert` payload is the same row).

    // A compact roster row -> the canonical `ThreadSummary`: transcript SIGNALS in
    // snake_case, never the committed messages.
    const threadSummaryOf = (row: Record<string, unknown>): Record<string, unknown> => ({        id: row.id,
        agent: row.agent,
        origin: row.origin ?? 'agent',
        status: row.status ?? 'idle',
        sequence: row.sequence ?? 0,
        ...(row.ownerThreadId === undefined ? {} : { owner_thread_id: row.ownerThreadId }),
        ...(row.label === undefined ? {} : { label: row.label }),
        transcript_state: row.transcriptState ?? row.transcript_state ?? 'ok',
        ...(row.transcriptError === undefined ? {} : { transcript_error: row.transcriptError }),
        message_count: row.messageCount ?? row.message_count ?? 0,
        ...(row.chars === undefined ? {} : { chars: row.chars }),
        has_transcript: row.hasTranscript ?? row.has_transcript ?? false,
        ...(row.preview === undefined ? {} : { preview: row.preview })
    });

    // ---- canonical adapter ----
    // The raw fixture read, widened structurally: the canonical server (T13) no longer
    // publishes `title`/`revision`/`threadViews` on `SessionSnapshot`, and a test
    // fixture may still carry them. Reading them as optionals keeps this double honest
    // about what the CURRENT snapshot type guarantees instead of leaning on a type that
    // is being rewritten underneath it.
    type RawSnapshotEx = SessionSnapshot & {
        title?: string;
        revision?: number;
        threadViews?: unknown[];
        actions?: unknown[];
        agentModels?: Record<string, string>;
        discoveredTools?: string[];
        invalidThreads?: unknown[];
    };

    const hostEx = async (sessionId: string): Promise<RawSnapshotEx | undefined> =>
        (await hostOf(sessionId)) as RawSnapshotEx | undefined;

    // ---- legacy fixture bodies (TEST FIXTURES ONLY, never a production alias) ----
    //
    // A pre-canonical stub answers ONE boot route with `{rootPath, presets, tools, agents,
    // defaults, sessions}` — the shape ~30 shell fixtures still declare. The canonical client
    // dials several routes and expects a `ServiceInfo`, a `GlobalConfigDocument` and a page
    // envelope on each (shared/harness-api.ts:339 ServiceInfo, :394 GlobalConfigDocument), so an
    // offered legacy body must be TRANSLATED, never handed over: production reads
    // `capabilities`/`limits`/`epoch` off a body that carries none and boots offline.
    //
    // Nothing here invents wire metadata the fixture does not carry. `capabilities`/`limits` are
    // SERVICE-declared constants (the same ones the synthesized root answer uses), and every
    // catalogue page is built from the fixture's own arrays.
    type LegacyBootstrap = {
        rootPath?: string;
        presets?: unknown[];
        tools?: unknown[];
        agents?: unknown[];
        sessions?: unknown[];
        defaults?: { baseURL?: string; model?: string; hasApiKey?: boolean; apiKey?: string };
    };

    // Detection is by SHAPE, not by url: a stub is free to answer the canonical route with the
    // legacy document (that is exactly what `{root: '/api'}` produces on the root read).
    const legacyOf = (payload: Record<string, unknown> | undefined): LegacyBootstrap | undefined => {
        if (payload === undefined) return undefined;
        const looksLegacy =
            ['rootPath', 'presets', 'defaults', 'sessions', 'agents', 'tools'].some((key) => payload[key] !== undefined) &&
            payload.api_root === undefined &&
            payload.capabilities === undefined;

        return looksLegacy ? (payload as LegacyBootstrap) : undefined;
    };

    const serviceInfoOf = (): Record<string, unknown> => ({
        api_root: HARNESS_API_ROOT,
        service: 'harness',
        api_version: 'v1',
        server_time: nowOf(),
        epoch: 'test-epoch',
        capabilities: HARNESS_SERVICE_CAPABILITIES,
        limits: HARNESS_SERVICE_LIMITS,
        links: {}
    });

    const configOf = (legacy: LegacyBootstrap): Record<string, unknown> => ({
        defaults: {
            base_url: String(legacy.defaults?.baseURL ?? ''),
            model: String(legacy.defaults?.model ?? ''),
            has_api_key: legacy.defaults?.hasApiKey === true || (legacy.defaults?.apiKey !== undefined && legacy.defaults?.apiKey !== '')
        },
        writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key'],
        revision: 1
    });

    // A catalogue page from a legacy body: the fixture's own array under its legacy key
    // (`presets` is the harness list, `tools`/`agents` carry their own names).
    const legacyItemsOf = (legacy: LegacyBootstrap, key: 'harnesses' | 'tools' | 'agents' | 'sessions'): unknown[] => {
        if (key === 'harnesses') return Array.isArray(legacy.presets) ? legacy.presets : [];
        if (key === 'sessions') return Array.isArray(legacy.sessions) ? legacy.sessions : [];

        return Array.isArray(legacy[key]) ? (legacy[key] as unknown[]) : [];
    };
    const canonicalRoutes = async (
        sub: string,
        method?: string,
        body?: unknown,
        context?: StubContext
    ): Promise<Response | undefined> => {
        const verb = (method ?? 'GET').toUpperCase();

        // These stubs' convention (see `hostOf` above): a GET is answered with the
        // method OMITTED, not the string `'GET'`; a fixture's router misses every read
        // otherwise, which would surface as an empty pane rather than a loud failure.
        const innerVerb = verb === 'GET' ? undefined : verb;

        // A composition read that the fixture does not declare is NOT an error: the
        // canonical boot asks for six documents (root, config, three catalogue pages,
        // the session page) and a shell fixture usually declares one or two of them.
        // The legacy `/views` branch had the same tolerance ("this stub has no such
        // route"), and a double that threw on an undeclared catalogue would fail every
        // shell test at boot with an offline pane instead of answering the read the
        // test actually cares about. Empty, not fatal.
        const safeInner = async (path: string, useVerb?: string): Promise<Response | undefined> => {
            try {
                const result = inner(path, useVerb, body, context);

                return result instanceof Promise ? await result : result;
            } catch {
                return undefined;
            }
        };

        // Offer the browser's ACTUAL url to the test's own handler first, exactly as
        // the `/views` branch does: a stub may declare the canonical route itself and
        // stay authoritative, and its request log must see what the client sent.
        const offer = async (): Promise<Response | undefined> => {
            try {
                const result = inner(`${root}${sub}`, innerVerb, body, context);

                return result instanceof Promise ? await result : result;
            } catch {
                return undefined;
            }
        };
        const bare = sub.split('?')[0];
        const query = new URLSearchParams(sub.includes('?') ? sub.slice(sub.indexOf('?') + 1) : '');
        const read = async (suffix: string): Promise<Record<string, unknown> | undefined> => {
            const resolved = await safeInner(`${root}/sessions/${suffix}`, innerVerb);
            if (resolved === undefined) return undefined;

            return readJson(resolved);
        };

        // The fixture's own boot document, read once and cached: the legacy shape carries the
        // catalogues, the provider defaults and the session list the canonical surface splits
        // across six routes. A stub that has no boot route answers `undefined`, which every caller
        // below treats as "no legacy source".
        let legacyBoot: LegacyBootstrap | undefined;
        let legacyTried = false;
        const legacyBootOf = async (): Promise<LegacyBootstrap | undefined> => {
            if (legacyTried) return legacyBoot;
            legacyTried = true;
            const response = await safeInner(root, undefined);
            legacyBoot = legacyOf(response === undefined ? undefined : await readJson(response));

            return legacyBoot;
        };

        // Boot: the service document, the global config, and one page per catalogue.
        // Each falls back to the test's own raw route, which is the same data.
        if (bare === '' || bare === '/') {
            const direct = await offer();
            if (direct !== undefined) {
                // A legacy boot body answered the root read: re-express it as ServiceInfo rather
                // than handing production a document with no `capabilities`/`limits`/`epoch`.
                const legacy = legacyOf(await readJson(direct));

                return legacy === undefined ? direct : jsonOf({ ...serviceInfoOf(), ...legacy }, direct.status);
            }

            return jsonOf(serviceInfoOf());
        }

        if (bare === '/health') {
            const direct = await offer();

            return direct ?? jsonOf({ ok: true, sessions: 0, epoch: 'test-epoch' });
        }

        if (bare === '/config') {
            const direct = await offer();
            if (direct !== undefined) {
                const legacy = legacyOf(await readJson(direct));
                if (legacy === undefined) return direct;
                // The legacy document's `defaults` ARE the config document's provider defaults.
                if (legacy.defaults !== undefined) return jsonOf(configOf(legacy));
            }

            const defaults = await (async (): Promise<LegacyBootstrap['defaults']> => {
                // `safeInner`, not `inner`: a strict stub THROWS for a route the browser never
                // asks for, and that is the same "no such route" signal `undefined` carries.
                const resolved = await safeInner(`${root}/harnesses`, innerVerb);
                const payload = resolved === undefined ? undefined : await readJson(resolved);
                const boot = legacyOf(payload);

                return boot?.defaults ?? (payload?.defaults as LegacyBootstrap['defaults']);
            })();

            return jsonOf({
                defaults: {
                    base_url: String(defaults?.baseURL ?? ''),
                    model: String(defaults?.model ?? ''),
                    has_api_key: defaults?.apiKey !== undefined && defaults?.apiKey !== ''
                },
                writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key'],
                revision: 1
            });
        }

        if (bare === '/harnesses' || bare === '/tools' || bare === '/agents') {
            const key = bare.slice(1) as 'harnesses' | 'tools' | 'agents';
            const direct = await offer();
            // A stub that declares the canonical page itself stays authoritative — unless its
            // answer is a legacy boot body, which is the same catalogue under its old keys.
            const directPayload = direct === undefined ? undefined : await readJson(direct);
            if (direct !== undefined && legacyOf(directPayload) === undefined) return direct;

            const source =
                directPayload !== undefined && legacyOf(directPayload) !== undefined
                    ? directPayload
                    : await (async (): Promise<Record<string, unknown> | undefined> => {
                          const raw = await safeInner(`${root}${bare}`, innerVerb);

                          return raw === undefined ? undefined : await readJson(raw);
                      })();

            const legacy = legacyOf(source);
            // Item source, in order of authority: the canonical page body the fixture declared,
            // the same catalogue under its legacy key, then the boot document.
            const items: unknown[] =
                legacy !== undefined
                    ? legacyItemsOf(legacy, key)
                    : Array.isArray(source?.[key])
                      ? (source?.[key] as Record<string, unknown>[])
                      : [];
            // Nothing declared this catalogue at all: the boot document is the same data.
            const resolvedItems =
                items.length > 0
                    ? items
                    : legacyItemsOf((await legacyBootOf()) ?? ({} as LegacyBootstrap), key);
            // Cards/rows/summaries in the contract's spelling: the fixture's fields
            // are camelCase, the wire's are snake_case for these resources.
            const mapped = resolvedItems.map((item) => {
                const entry = item as Record<string, unknown>;

                return key === 'harnesses'
                    ? {
                          ...entry,
                          requires_endpoint: entry.requiresEndpoint ?? false,
                          agents: Array.isArray(entry.agents)
                              ? entry.agents
                              : [entry.primary, ...(((entry.subagents as string[] | undefined) ?? []))],
                          definition_revision: 1,
                          agent_models: undefined,
                          agent_instructions: undefined
                      }
                    : key === 'tools'
                      ? { ...entry, session_bound: entry.sessionBound ?? false }
                      : {
                            ...entry,
                            has_instruction_override: entry.hasInstructionOverride ?? false,
                            has_global_override: entry.hasGlobalOverride ?? false
                        };
            });

            // Always a page, never `undefined`: `loadBootstrap` (api.ts:1299-1321) reads `.items`
            // off all four catalogues, and an unanswered route reaches `requestResource` as an
            // undefined Response (`api.ts:445` -> "Cannot read properties of undefined (reading
            // 'ok')"). An empty catalogue is the fixture's real meaning, so the double says that.
            return jsonOf(pageOf(mapped));
        }

        if (bare === '/sessions') {
            if (verb === 'POST') {
                const created = await inner(`${root}/sessions`, innerVerb, body, context);
                const resolved = created instanceof Promise ? await created : created;
                if (resolved === undefined) return undefined;
                const payload = await readJson(resolved);
                const session = payload?.session as SessionSnapshot | undefined;

                return session === undefined
                    ? jsonOf(payload ?? {}, resolved.status)
                    : jsonOf({ session: sessionResourceOf(session) }, resolved.status);
            }

            const direct = await offer();
            const directPayload = direct === undefined ? undefined : await readJson(direct);
            if (direct !== undefined && legacyOf(directPayload) === undefined) return direct;

            const listed =
                directPayload !== undefined
                    ? directPayload
                    : await (async (): Promise<Record<string, unknown> | undefined> => {
                          const raw = await safeInner(`${root}/sessions`, innerVerb);

                          return raw === undefined ? undefined : await readJson(raw);
                      })();

            const listedLegacy = legacyOf(listed);
            const sessions =
                listedLegacy !== undefined
                    ? (legacyItemsOf(listedLegacy, 'sessions') as SessionSnapshot[])
                    : Array.isArray(listed?.sessions)
                      ? (listed?.sessions as SessionSnapshot[])
                      : (legacyItemsOf((await legacyBootOf()) ?? ({} as LegacyBootstrap), 'sessions') as SessionSnapshot[]);

            return jsonOf(pageOf(sessions.map(sessionResourceOf), 1, null));
        }

        const sessionMatch = bare.match(/^\/sessions\/([^/]+)$/);
        if (sessionMatch) {
            const sessionId = decodeURIComponent(sessionMatch[1]);
            const host = await hostEx(sessionId);

            if (verb === 'DELETE') {
                const response = await inner(`${root}/sessions/${sessionId}`, innerVerb, body, context);

                return response instanceof Promise ? await response : response;
            }

            if (host === undefined) return jsonOf({ error: { message: `Unknown session ${sessionId}` } }, 404);

            // A PATCH answers the patched row, not a document.
            if (verb === 'PATCH') {
                const patched = await inner(`${root}/sessions/${sessionId}`, innerVerb, body, context);
                const resolved = patched instanceof Promise ? await patched : patched;
                if (resolved === undefined) return undefined;
                const payload = await readJson(resolved);
                const session = (payload?.session ?? payload?.view ?? host) as SessionSnapshot;

                return jsonOf({ session: sessionResourceOf(session) }, resolved.status);
            }

            const requested = await offer();

            return requested ?? jsonOf({ session: sessionResourceOf(host) });
        }

        const turnsMatch = bare.match(/^\/sessions\/([^/]+)\/turns$/);
        if (turnsMatch && verb === 'GET') {
            const sessionId = decodeURIComponent(turnsMatch[1]);
            const host = await hostEx(sessionId);
            if (host === undefined) return jsonOf({ error: { message: `Unknown session ${sessionId}` } }, 404);

            const compiled = viewOf(host, { primary: options.primary });
            const all = (compiled.turns ?? []).map(wireRowOf);

            // `order=desc` answers newest first (the tail a client follows) and
            // `next_cursor` walks OLDER, which is what "load older" is. A page with
            // no cursor param still returns the whole loaded window, as the contract
            // bounds it by `limit`.
            const limit = Math.max(1, Math.min(HARNESS_PAGE_LIMIT.max, Number(query.get('limit') ?? HARNESS_PAGE_LIMIT.default)));
            const descending = query.get('order') === 'desc';
            const ordered = descending ? [...all].reverse() : all;
            const cursor = query.get('cursor');
            const window = cursor === null || cursor === undefined ? ordered.slice(0, limit) : ordered.slice(limit, limit * 2);

            return jsonOf(pageOf(window, host.revision ?? 1, window.length >= limit ? 'older-cursor' : null));
        }

        const displayMatch = bare.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/display$/);
        if (displayMatch && verb === 'GET') {
            const direct = await offer();
            if (direct !== undefined) return direct;

            const sessionId = decodeURIComponent(displayMatch[1]);
            const turnId = decodeURIComponent(displayMatch[2]);
            const host = await hostEx(sessionId);
            const display = host === undefined ? undefined : displayOfTurn(host, turnId, { primary: options.primary });

            return display === undefined
                ? jsonOf({ error: { message: `Unknown turn ${turnId}` } }, 404)
                : jsonOf({ display: { ...display, revision: host?.revision ?? 1 } });
        }

        const stepMatch = bare.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/steps\/([^/]+)$/);
        if (stepMatch && verb === 'GET') {
            const direct = await offer();

            return direct ?? stepDetail(decodeURIComponent(stepMatch[1]), decodeURIComponent(stepMatch[2]), decodeURIComponent(stepMatch[3]));
        }

        const blockMatch = bare.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/blocks\/([^/]+)$/);
        if (blockMatch && verb === 'GET') {
            const direct = await offer();

            return direct ?? blockDetail(decodeURIComponent(blockMatch[1]), decodeURIComponent(blockMatch[2]), decodeURIComponent(blockMatch[3]));
        }

        const threadsMatch = bare.match(/^\/sessions\/([^/]+)\/threads$/);
        if (threadsMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(threadsMatch[1]));
            if (host === undefined) return jsonOf({ error: { message: 'Unknown session' } }, 404);

            const rows = (host.threadViews ?? host.threads ?? []) as unknown as Record<string, unknown>[];

            return jsonOf(pageOf(rows.map(threadSummaryOf), host.revision ?? 1));
        }

        const actionsMatch = bare.match(/^\/sessions\/([^/]+)\/actions$/);
        if (actionsMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(actionsMatch[1]));
            const actions = ((host as { actions?: unknown[] } | undefined)?.actions ?? []).map((action) => {
                const record = action as Record<string, unknown>;

                return {
                    request: record.request ?? record,
                    turn_id: record.turnId ?? record.turn_id ?? '',
                    ...(record.threadId === undefined ? {} : { thread_id: record.threadId }),
                    agent: record.agent ?? '',
                    received_at: record.receivedAt ?? record.received_at ?? nowOf()
                };
            });

            return jsonOf({
                session_id: decodeURIComponent(actionsMatch[1]),
                actions,
                revision: host?.revision ?? 1
            });
        }

        const answerMatch = bare.match(/^\/sessions\/([^/]+)\/actions\/([^/]+)\/answer$/);
        if (answerMatch && verb === 'POST') {
            const response = await inner(
                `${root}/sessions/${answerMatch[1]}/actions/${answerMatch[2]}/answer`, innerVerb, body,
                context
            );
            const resolved = response instanceof Promise ? await response : response;
            if (resolved === undefined) return undefined;
            const payload = await readJson(resolved);
            const requestId = payload?.requestId ?? payload?.request_id ?? decodeURIComponent(answerMatch[2]);

            return jsonOf({ ok: true, request_id: requestId, resolved_at: nowOf() }, resolved.status);
        }

        // A submit answers a RECEIPT: identity, placement, the moved revision and the
        // links. The test's raw 202 body ({ session, turn }) carries the same facts.
        const tasksMatch = bare.match(/^\/sessions\/([^/]+)\/tasks$/);
        if (tasksMatch && verb === 'POST') {
            const response = await inner(`${root}/sessions/${tasksMatch[1]}/tasks`, innerVerb, body, context);
            const resolved = response instanceof Promise ? await response : response;
            if (resolved === undefined) return undefined;
            const payload = await readJson(resolved);
            const turn = payload?.turn as SessionTurn | undefined;
            const session = (payload?.session ?? payload?.view) as SessionSnapshot | undefined;
            const request = (body ?? {}) as Record<string, unknown>;
            const steered = (payload?.steered ?? false) === true;

            return jsonOf(
                {
                    session_id: decodeURIComponent(tasksMatch[1]),
                    turn_id: turn?.id ?? payload?.turnId ?? '',
                    status: turn?.status ?? payload?.status ?? 'queued',
                    thread_id: turn?.threadId ?? (request.threadId as string | undefined) ?? '',
                    ...(steered ? { steered: true } : {}),
                    ...(payload?.steeredThreadId === undefined ? {} : { steered_thread_id: payload.steeredThreadId }),
                    ...(turn?.index === undefined ? {} : { queue_position: turn.index }),
                    session_revision: (session as RawSnapshotEx | undefined)?.revision ?? 1,
                    accepted_at: turn?.startedAt ?? nowOf(),
                    links: {
                        turn: `${HARNESS_API_ROOT}/sessions/${tasksMatch[1]}/turns/${turn?.id ?? ''}`,
                        turns: `${HARNESS_API_ROOT}/sessions/${tasksMatch[1]}/turns?limit=25`,
                        thread: `${HARNESS_API_ROOT}/sessions/${tasksMatch[1]}/threads/${turn?.threadId ?? ''}`,
                        stream: `${HARNESS_API_ROOT}/stream`
                    }
                },
                resolved.status
            );
        }

        const resetMatch = bare.match(/^\/sessions\/([^/]+)\/reset$/);
        if (resetMatch && verb === 'POST') {
            const host = await hostEx(decodeURIComponent(resetMatch[1]));

            return jsonOf({
                reset: true,
                session_id: decodeURIComponent(resetMatch[1]),
                discarded_turns: (host?.turns ?? []).length,
                discarded_threads: (host?.threadViews ?? host?.threads ?? []).length,
                dropped_queued_tasks: 0,
                revision: (host?.revision ?? 1) + 1
            });
        }

        const cancelMatch = bare.match(/^\/sessions\/([^/]+)\/cancel$/);
        if (cancelMatch && verb === 'POST') {
            const response = await inner(`${root}/sessions/${cancelMatch[1]}/cancel`, innerVerb, body, context);
            const resolved = response instanceof Promise ? await response : response;
            if (resolved === undefined) return undefined;
            const payload = await readJson(resolved);
            const host = await hostEx(decodeURIComponent(cancelMatch[1]));

            return jsonOf(
                {
                    cancelled: payload?.cancelled ?? true,
                    session_id: decodeURIComponent(cancelMatch[1]),
                    dropped_queued_tasks: payload?.droppedQueuedTasks ?? 0,
                    ...(payload?.activeTurnId === undefined ? {} : { active_turn_id: payload.activeTurnId }),
                    revision: host?.revision ?? 1
                },
                resolved.status
            );
        }

        const threadCancelMatch = bare.match(/^\/sessions\/([^/]+)\/threads\/([^/]+)\/cancel$/);
        if (threadCancelMatch && verb === 'POST') {
            const response = await inner(
                `${root}/sessions/${threadCancelMatch[1]}/threads/${threadCancelMatch[2]}/cancel`, innerVerb, body,
                context
            );

            if (response === undefined) return undefined;
            const resolved = response instanceof Promise ? await response : response;
            const payload = await readJson(resolved);

            return jsonOf(
                {
                    cancelled: payload?.cancelled ?? true,
                    thread_id: decodeURIComponent(threadCancelMatch[2]),
                    session_id: decodeURIComponent(threadCancelMatch[1]),
                    status: 'stopped',
                    dropped_queued_tasks: 0,
                    revision: (payload?.view as { revision?: number } | undefined)?.revision ?? 1
                },
                resolved.status
            );
        }

        const threadMatch = bare.match(/^\/sessions\/([^/]+)\/threads\/([^/]+)$/);
        if (threadMatch && verb === 'DELETE') {
            const response = await inner(
                `${root}/sessions/${threadMatch[1]}/threads/${threadMatch[2]}`, innerVerb, body,
                context
            );

            if (response === undefined) return undefined;
            const resolved = response instanceof Promise ? await response : response;
            const payload = await readJson(resolved);

            return jsonOf(
                {
                    deleted: true,
                    thread_id: decodeURIComponent(threadMatch[2]),
                    session_id: decodeURIComponent(threadMatch[1]),
                    removed_descendants: 0,
                    removed_turns: 0,
                    revision: (payload?.view as { revision?: number } | undefined)?.revision ?? 1
                },
                resolved.status
            );
        }

        const transcriptDocumentMatch = bare.match(/^\/sessions\/([^/]+)\/threads\/([^/]+)\/transcript\/document$/);
        if (transcriptDocumentMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(transcriptDocumentMatch[1]));
            const threadId = decodeURIComponent(transcriptDocumentMatch[2]);
            const threads = (host?.threads ?? []) as unknown as Record<string, unknown>[];
            const thread = threads.find((candidate) => candidate.id === threadId);
            const invalid = ((host?.invalidThreads ?? []) as unknown as Record<string, unknown>[]).find(
                (candidate) => candidate.id === threadId
            );

            if (invalid !== undefined) {
                return jsonOf({
                    session_id: decodeURIComponent(transcriptDocumentMatch[1]),
                    thread_id: threadId,
                    agent: String(invalid.agent ?? ''),
                    revision: 1,
                    transcript_state: 'unreadable',
                    document: JSON.stringify(invalid.messages ?? [], null, 2)
                });
            }

            return jsonOf({
                session_id: decodeURIComponent(transcriptDocumentMatch[1]),
                thread_id: threadId,
                agent: String(thread?.agent ?? ''),
                revision: 1,
                transcript_state: 'ok',
                document: JSON.stringify(thread?.messages ?? [], null, 2)
            });
        }

        const transcriptMatch = bare.match(/^\/sessions\/([^/]+)\/threads\/([^/]+)\/transcript$/);
        if (transcriptMatch) {
            if (verb === 'PUT') {
                const response = await inner(
                    `${root}/sessions/${transcriptMatch[1]}/threads/${transcriptMatch[2]}/transcript`, innerVerb, body,
                    context
                );
                if (response === undefined) return undefined;
                const resolved = response instanceof Promise ? await response : response;
                const payload = await readJson(resolved);
                const transcript = (payload?.transcript ?? {}) as Record<string, unknown>;

                return jsonOf(
                    {
                        session_id: decodeURIComponent(transcriptMatch[1]),
                        thread_id: decodeURIComponent(transcriptMatch[2]),
                        accepted_as: transcript.invalid === undefined ? 'transcript' : 'raw',
                        message_count: Array.isArray(transcript.messages) ? transcript.messages.length : 0,
                        revision: (payload?.view as { revision?: number } | undefined)?.revision ?? 2,
                        ...(transcript.invalid === undefined
                            ? {}
                            : { invalid: { error: String((transcript.invalid as { error?: unknown }).error ?? ''), stored_type: 'object' } }),
                        links: {
                            transcript: `${HARNESS_API_ROOT}/sessions/${transcriptMatch[1]}/threads/${transcriptMatch[2]}/transcript`,
                            document: `${HARNESS_API_ROOT}/sessions/${transcriptMatch[1]}/threads/${transcriptMatch[2]}/transcript/document`
                        }
                    },
                    resolved.status
                );
            }

            const host = await hostEx(decodeURIComponent(transcriptMatch[1]));
            const threadId = decodeURIComponent(transcriptMatch[2]);
            const threads = (host?.threads ?? []) as unknown as Record<string, unknown>[];
            const thread = threads.find((candidate) => candidate.id === threadId);
            const messages = (thread?.messages ?? []) as Record<string, unknown>[];

            return jsonOf({
                transcript: {
                    session_id: decodeURIComponent(transcriptMatch[1]),
                    thread_id: threadId,
                    agent: String(thread?.agent ?? ''),
                    transcript_state: 'ok',
                    message_count: messages.length,
                    chars: messages.reduce((total, entry) => total + String(entry.content ?? '').length, 0),
                    bytes: 0,
                    revision: 1,
                    role_counts: {
                        system: messages.filter((entry) => entry.role === 'system').length,
                        user: messages.filter((entry) => entry.role === 'user').length,
                        assistant: messages.filter((entry) => entry.role === 'assistant').length,
                        tool: messages.filter((entry) => entry.role === 'tool').length
                    }
                }
            });
        }

        const messagesMatch = bare.match(/^\/sessions\/([^/]+)\/threads\/([^/]+)\/transcript\/messages$/);
        if (messagesMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(messagesMatch[1]));
            const threads = (host?.threads ?? []) as unknown as Record<string, unknown>[];
            const thread = threads.find((candidate) => candidate.id === decodeURIComponent(messagesMatch[2]));
            const messages = (thread?.messages ?? []) as unknown as never[];

            return jsonOf({
                ...pageOf(messages, 1, null),
                thread_id: decodeURIComponent(messagesMatch[2]),
                agent: String(thread?.agent ?? ''),
                transcript_state: 'ok',
                total: messages.length
            });
        }

        const definitionMatch = bare.match(/^\/sessions\/([^/]+)\/definition$/);
        if (definitionMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(definitionMatch[1]));
            const definition = (host?.harnessDefinition ?? {}) as Record<string, unknown>;

            return jsonOf({
                definition: {
                    name: definition.name ?? host?.harness ?? '',
                    title: definition.title ?? '',
                    description: definition.description ?? '',
                    requires_endpoint: definition.requiresEndpoint ?? false,
                    primary: definition.primary ?? '',
                    subagents: definition.subagents ?? [],
                    agents: definition.agents ?? [],
                    tools: definition.tools ?? [],
                    builtin: definition.builtin ?? false,
                    definition_revision: 1,
                    session_id: host?.id ?? '',
                    revision: host?.revision ?? 1,
                    frozen_at: host?.createdAt ?? nowOf(),
                    source_revision: 1,
                    current_revision: 1,
                    current: true,
                    ...(host?.discoveredTools === undefined ? {} : { discovered_tools: host.discoveredTools }),
                    ...(definition.agentModels === undefined ? {} : { agent_models: definition.agentModels }),
                    ...(definition.agentInstructions === undefined ? {} : { agent_instructions: definition.agentInstructions })
                }
            });
        }

        const usageMatch = bare.match(/^\/sessions\/([^/]+)\/usage$/);
        if (usageMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(usageMatch[1]));

            return jsonOf({
                session_id: decodeURIComponent(usageMatch[1]),
                turn_count: (host?.turns ?? []).length,
                reported_turns: (host?.turns ?? []).filter((turn) => turn.usage !== undefined).length,
                by_thread: [],
                truncated: false,
                revision: host?.revision ?? 1
            });
        }

        const queueMatch = bare.match(/^\/sessions\/([^/]+)\/queue$/);
        if (queueMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(queueMatch[1]));
            const queued = (host?.turns ?? []).filter((turn) => turn.status === 'queued');

            return jsonOf(
                pageOf(
                    queued.map((turn, position) => ({
                        turn_id: turn.id,
                        index: turn.index,
                        position,
                        status: turn.status,
                        prompt_preview: (turn.prompt ?? '').slice(0, 280),
                        prompt_chars: (turn.prompt ?? '').length,
                        ...(turn.threadId === undefined ? {} : { thread_id: turn.threadId })
                    })),
                    host?.revision ?? 1
                )
            );
        }

        const commandsMatch = bare.match(/^\/sessions\/([^/]+)\/commands$/);
        if (commandsMatch && verb === 'GET') {
            const direct = await offer();

            return direct ?? jsonOf(pageOf([]));
        }

        const toolsExecMatch = bare.match(/^\/tools\/([^/]+)\/executions$/);
        if (toolsExecMatch && verb === 'POST') {
            return inner(`${root}/tools/${toolsExecMatch[1]}`, innerVerb, body, context) as Promise<Response> | Response;
        }

        const modelsMatch = bare === '/models';
        if (modelsMatch && verb === 'POST') {
            return inner(`${root}/models`, innerVerb, body, context) as Promise<Response> | Response;
        }

        // A route the adapter has no canonical answer for: pass the request to the
        // test's own handler so a strict stub reports it rather than guessing.
        return offer();
    };

    return async (url, method, body, context) => {
        const path = stripOrigin(url, root);

        // T17: the browser dials the canonical control plane. The canonical branch is
        // matched on BOTH the configured mount and the contract root, because a test
        // may declare its fixtures under `/api` while the client asks `/v1/harness`:
        // what matters is that the ANSWER is canonical, not which prefix the fixture
        // happened to use. Every canonical answer is composed from the SAME raw
        // snapshot through the SERVER's own projector, so a green shell test is still
        // evidence about real compiled state.
        const canonicalPath = path.startsWith(HARNESS_API_ROOT)
            ? path.slice(HARNESS_API_ROOT.length)
            : stripOrigin(url, HARNESS_API_ROOT).startsWith(HARNESS_API_ROOT)
              ? stripOrigin(url, HARNESS_API_ROOT).slice(HARNESS_API_ROOT.length)
              : String(url).includes(HARNESS_API_ROOT)
                // The mount IS the canonical root (a fixture that declares no `root`
                // option gets it by default), so `stripOrigin` already removed it and
                // the stripped path is the canonical route itself. Without this case
                // the canonical branch would only ever run for a NON-canonical
                // configured mount, and the migration would look like a no-op.
                ? stripOrigin(url, HARNESS_API_ROOT)
                : undefined;

        if (canonicalPath !== undefined) {
            return canonicalRoutes(canonicalPath, method, body, context);
        }

        if (!path.startsWith('/views')) return inner(url, method, body, context);

        const rest = path.slice('/views'.length);
        const call = async (rawUrl: string): Promise<Response | undefined> => {
            const result = inner(rawUrl, method, body, context);

            return result instanceof Promise ? await result : result;
        };
        const raw = (suffix: string): string => `${root}/sessions${suffix}`;

        // A composed route (the lazy step detail, the per-turn raw read, the transcript) offers
        // the URL the browser ACTUALLY asked for to the test's own handler first. Two reasons:
        // a stub may declare that route itself and stay authoritative, and a stub that keeps a
        // request log must see the request the client made — otherwise a test cannot prove the
        // lazy fetch happened on a click and on exactly one click. A strict stub THROWS for a
        // route it does not implement, which is the same "no such route" signal `undefined`
        // carries, so both fall through to the composition.
        const offer = async (): Promise<Response | undefined> => {
            try {
                return await call(url);
            } catch {
                return undefined;
            }
        };

        // Lazy detail: no raw twin (the raw surface has no step route).
        const stepMatch = rest.match(/^\/([^/]+)\/turns\/([^/]+)\/steps\/([^/]+)$/);
        if (stepMatch && (method === undefined || method === 'GET')) {
            const direct = await offer();

            return direct ?? stepDetail(
                decodeURIComponent(stepMatch[1]),
                decodeURIComponent(stepMatch[2]),
                decodeURIComponent(stepMatch[3])
            );
        }

        // Lazy detail for ONE context-bar segment (`GET .../turns/:turnId/blocks/:blockId`, T11/R8).
        // The same offer-first rule as the step route above: a stub that declares this route keeps
        // its own answer (and keeps its request log honest), and a strict stub that THROWS for a
        // route it does not implement falls through to the composition, which is what lets a shell
        // test prove the click costs exactly one fetch without hand-writing a detail body.
        const blockMatch = rest.match(/^\/([^/]+)\/turns\/([^/]+)\/blocks\/([^/]+)$/);
        if (blockMatch && (method === undefined || method === 'GET')) {
            const direct = await offer();

            return direct ?? blockDetail(
                decodeURIComponent(blockMatch[1]),
                decodeURIComponent(blockMatch[2]),
                decodeURIComponent(blockMatch[3])
            );
        }

        // The verbatim raw read (the transcript export) is the per-turn route below: the frozen
        // server has NO session-level `/views/:id/raw` (src/server/api.ts:1873 mounts only
        // `/views/:id/turns/:turnId/raw`), so a client must not expect one and this adapter does
        // not invent one.

        // A single recorded turn, verbatim (`GET .../turns/:turnId/raw`). Composed from the session
        // read because the raw surface has no per-turn route.
        const turnRawMatch = rest.match(/^\/([^/]+)\/turns\/([^/]+)\/raw$/);
        if (turnRawMatch && (method === undefined || method === 'GET')) {
            const direct = await offer();
            if (direct !== undefined) return direct;

            const sessionId = decodeURIComponent(turnRawMatch[1]);
            const turnId = decodeURIComponent(turnRawMatch[2]);
            const host = await hostOf(sessionId);
            const turn = host?.turns?.find((candidate) => candidate.id === turnId);

            return turn === undefined
                ? jsonOf({ error: { message: `Unknown turn ${turnId}` } }, 404)
                : jsonOf({ turn });
        }

        // The live observer: frames are translated, not merely re-enveloped. Both spellings are
        // accepted (`/views/:id/events` is the frozen route, protocol.ts:605).
        const eventsMatch = rest.match(/^\/([^/]+)\/(events|stream)$/);
        if (eventsMatch && (method === undefined || method === 'GET')) {
            const sessionId = decodeURIComponent(eventsMatch[1]);
            const response = await call(raw(`/${sessionId}/events`));

            if (response === undefined) return undefined;

            // The client parses THIS route as an event stream whatever the stub labelled it, so a
            // body is translated whenever it is not a JSON error answer (a 404 unknown session or a
            // 405 wrong method arrives as `{ error }`).
            if ((response.headers.get('content-type') ?? '').includes('application/json')) return response;

            return translateStream(response, sessionId);
        }

        // The lazy transcript read (R2): a test that declares the raw route keeps its own answer;
        // otherwise the transcript is COMPOSED from the raw session read the test already declares,
        // because that is the same document the raw route serves (`ThreadTranscriptResponse`,
        // protocol.ts:856). The alternative would be hand-writing a transcript body in every shell
        // test that only exercises a different control.
        const transcriptMatch = rest.match(/^\/([^/]+)\/threads\/([^/]+)\/transcript$/);
        if (transcriptMatch && (method === undefined || method === 'GET')) {
            const sessionId = decodeURIComponent(transcriptMatch[1]);
            const threadId = decodeURIComponent(transcriptMatch[2]);

            // A strict stub THROWS for a route it does not implement; that is the same "no such
            // route" signal `undefined` carries, and the composition below is the answer either way.
            let direct: Response | undefined;
            try {
                direct = await call(raw(rest));
            } catch {
                direct = undefined;
            }
            if (direct !== undefined) return direct;

            const payload = await hostOf(sessionId);
            const thread = payload?.threads?.find((candidate) => candidate.id === threadId);

            if (thread === undefined) return jsonOf({ error: { message: `Unknown thread ${threadId}` } }, 404);

            const broken = (payload?.invalidThreads ?? []).find((candidate) => candidate.id === threadId);
            const messages = Array.isArray(thread.messages) ? thread.messages : [];

            return jsonOf({
                threadId,
                agent: thread.agent,
                messages,
                raw: JSON.stringify(broken !== undefined ? broken.messages : messages, null, 2),
                ...(broken === undefined ? {} : { invalid: { error: broken.error, messages: broken.messages } })
            });
        }

        // The directory index.
        if (rest === '' || rest === '/') {
            const response = await call(raw(rest));
            if (response === undefined) return undefined;
            const payload = await readJson(response);

            return payload === undefined ? response : translateJson(payload, response.status);
        }

        // Everything else has a 1:1 raw twin under the same suffix (read, create, patch, reset,
        // cancel, thread stop/delete, action answer, transcript read/write).
        const response = await call(raw(rest));
        if (response === undefined) return undefined;

        if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) return response;
        const payload = await readJson(response);

        return payload === undefined ? response : translateJson(payload, response.status);
    };
};

// The same adapter for a test that stubs `fetch(input, init)` directly. The body is forwarded
// VERBATIM (a JSON string), because every shell stub parses `init.body` its own way; the adapter
// never needs to read it, it only rewrites the URL. A stub that answers `undefined` for a route it
// does not implement keeps that behaviour, so the "unexpected request" discipline survives.
export const viewAwareFetch = (
    rawFetch: (input: RequestInfo | URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>,
    options: ViewRouteOptions = {}
): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response | undefined>) => {
    const answer = withViewRoutes(
        // The adapter hands back the ORIGINAL init, so only the URL changes: `keepalive` (the
        // page-unload delete), `headers` (the SSE accept header) and `signal` (the abortable
        // observer) all still reach the stub exactly as the browser sent them.
        (url, method, body, context) =>
            rawFetch(
                url,
                context?.init === undefined
                    ? {
                          ...(method === undefined ? {} : { method }),
                          ...(typeof body === 'string' ? { body } : body === undefined || body === null ? {} : { body: JSON.stringify(body) })
                      }
                    : context.init
            ),
        options
    );

    return async (input, init) => {
        const response = answer(String(input), init?.method, init?.body ?? undefined, {
            ...(init === undefined ? {} : { init })
        });

        return response instanceof Promise ? await response : response;
    };
};

// `/api/views/s1?x=1` -> `/views/s1`. An absolute root (a static-host probe) is reduced to the
// same shape by matching the configured root prefix.
export const stripOrigin = (url: string, root = HARNESS_API_ROOT): string => {
    const withoutQuery = url.split('?')[0] ?? url;
    if (withoutQuery.startsWith(`${root}/`)) return withoutQuery.slice(root.length);

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutQuery)) {
        try {
            const parsed = new URL(withoutQuery);
            if (parsed.pathname.startsWith(`${root}/`)) return parsed.pathname.slice(root.length);
        } catch {
            // Not a URL this adapter can classify: leave it to the wrapped handler.
        }
    }

    return withoutQuery;
};


// ---------------------------------------------------------------------------
// The realtime double (T17, raw-frame bridge T25)
// ---------------------------------------------------------------------------
//
// The shell follows a conversation over ONE `harness.v1` WebSocket (./stream.ts), so a shell
// test needs a socket it can drive, exactly as it used to need an SSE body it could push frames
// into. This double is that socket: it records the `subscribe` frames the client sent, answers
// `welcome` + `subscription_state` automatically (the contract's registration anchor), and
// delivers updates into the subscription that owns them.
//
// There is NO SSE fallback in the client (stream.ts:40-43), so a test that wants live behavior
// installs this double BEFORE the shell opens a subscription; `installHarnessStream` wires it
// into the singleton the shell uses (./stream.ts `configureHarnessStream`) and resets that
// singleton first, because `harnessStream()` caches the client built from the FIRST configured
// factory (stream.ts:647-651) — without the reset, a second install in the same module graph
// would still speak through the previous test's socket.
//
// What it accepts (T25): a shell fixture declares its live traffic the way the RECORDED server
// does — raw `SessionStreamItem`s (`{type:'turn'}`, `{type:'event'}`, `{type:'snapshot'}`). The
// canonical wire does not carry those; it carries `update` frames whose payload is a projector
// product (shared/harness-stream.ts:513-570). The bridge is therefore `toViewItem`, the SERVER'S
// OWN projector (this module's header), so a frame the double delivers is byte-for-byte the frame
// the server would send for that recorded frame — never an invented one. A test may also push a
// canonical payload directly (`{kind:'display.ops', turn_id, ops}`) when it wants to name the
// frame itself.
//
// Raw frame -> canonical frames (exactly the server's framing):
//   `{type:'turn'}`    -> `turn.upsert` (the projector's `{op:'turn'}` row) + `display.ops` for
//                         any settle ops the terminal record produces
//   `{type:'event'}`   -> `display.ops` (the ops that event applied), chunked by
//                         `ops_per_update_frame`, plus a `turn.upsert` when the projector also
//                         re-published the row
//   `{type:'snapshot'}`/`{type:'failed'}` -> `session.updated` (the metadata patch) followed by
//                         one `turn.upsert` per row of the compiled view; trees are lazy reads,
//                         so no display subtree is claimed here
export type HarnessStreamOptions = {
    // The conversation this double serves; a `session`-scope subscribe naming another id is not
    // the target. Omit to deliver to the newest subscription whatever its scope.
    sessionId?: string;
    // The host document the live fold seeds from (same source `withViewRoutes` uses).
    snapshot?: () => SessionSnapshot | undefined;
    // The entry agent when the fixture's snapshot does not carry `harnessDefinition`.
    primary?: string;
};

export type StreamDouble = {
    // Every frame the client sent, parsed.
    sent: Record<string, unknown>[];
    // One entry per `subscribe`, in order, with the ids the client addressed.
    subscriptions: Record<string, unknown>[];
    // Deliver one payload/item, or an ARRAY of them, each as its own frame, with the next
    // sequence and a fresh cursor for the subscription that owns it.
    push(items: unknown | readonly unknown[]): boolean;
    // Stop delivering (the fixture's "stream ended"): the socket is left alone on purpose,
    // because closing it makes the client reconnect and re-dial the factory.
    close(): void;
    // Ask the client to reconnect (a dropped socket), keeping its resume state; the fold
    // restarts, exactly as a new observer connection does.
    drop(): void;
    // The client's own view of the connection (./stream.ts `status()`).
    status(): string;
    socket(): { closeCode?: number };
};

export const installHarnessStream = (options: HarnessStreamOptions = {}): StreamDouble => {
    const sent: Record<string, unknown>[] = [];
    const subscriptions: Record<string, unknown>[] = [];
    // Sequence is per subscription: two subscriptions on one connection never share a counter.
    const sequences = new Map<string, number>();
    let current: (StreamSocket & { closeCode?: number }) | undefined;
    let closed = false;

    // One fold per connection, like the store's own watcher subscription: a reconnect (or a
    // fresh install) starts a fresh op sequence rather than continuing a stale one.
    let folds = new Map<string, LiveFold>();

    // The snapshot the stream opens with seeds the folds, so an `event` frame that arrives
    // before any `turn` frame still produces real ops (same seeding as `withViewRoutes`).
    let context: SessionSnapshot | undefined = options.snapshot?.();

    // Frames pushed before the client has registered a subscription (the `subscribe` frame is
    // written on the socket, the handshake answers on a microtask) are queued, not dropped.
    const pending: Record<string, unknown>[] = [];

    const targetId = (): string | undefined => {
        for (let index = subscriptions.length - 1; index >= 0; index -= 1) {
            const sub = subscriptions[index] as { subscription_id?: string; scope?: string; session_id?: string };
            if (sub.scope !== 'session') continue;
            if (options.sessionId !== undefined && sub.session_id !== options.sessionId) continue;

            return sub.subscription_id;
        }

        const last = subscriptions[subscriptions.length - 1] as { subscription_id?: string } | undefined;

        return last?.subscription_id;
    };

    const frameOf = (subscriptionId: string, body: Record<string, unknown>): Record<string, unknown> => {
        const sequence = (sequences.get(subscriptionId) ?? 0) + 1;
        sequences.set(subscriptionId, sequence);

        return {
            type: 'update',
            subscription_id: subscriptionId,
            sequence,
            cursor: `cursor-${sequence}`,
            at: Date.now(),
            ...body
        };
    };

    const write = (body: Record<string, unknown>): boolean => {
        if (closed) return false;

        const subscriptionId = targetId();
        if (subscriptionId === undefined || current?.onmessage === undefined || current.onmessage === null) {
            pending.push(body);

            return false;
        }

        current.onmessage({ data: JSON.stringify(frameOf(subscriptionId, body)) });

        return true;
    };

    const flush = (): void => {
        if (targetId() === undefined || current?.onmessage == null) return;

        while (pending.length > 0) {
            const body = pending.shift() as Record<string, unknown>;
            const subscriptionId = targetId() as string;

            current.onmessage({ data: JSON.stringify(frameOf(subscriptionId, body)) });
        }
    };

    // A raw recorded frame -> the canonical `update` payloads it becomes on the wire.
    const updatesOf = (raw: SessionStreamItem): Record<string, unknown>[] => {
        if (raw.type === 'snapshot' || raw.type === 'failed') context = raw.session;

        const item = toViewItem(raw, folds, context, { primary: options.primary });
        const bodies: Record<string, unknown>[] = [];

        if (item.type === 'view' || item.type === 'failed') {
            if (context !== undefined) bodies.push({ kind: 'session.updated', session: statePatchOf(context) });

            for (const row of (item.view.turns ?? []) as unknown as TurnSummary[]) {
                bodies.push({ kind: 'turn.upsert', turn: wireRowOf(row) });
            }

            return bodies;
        }

        // The projector's row op rides `turn.upsert` (a whole row keyed by its own id); every
        // other op rides `display.ops` beside the turn it belongs to, bounded by the frame limit.
        for (const op of item.ops) {
            if ((op as { op?: string }).op === 'turn') {
                const summary = (op as { summary?: TurnSummary }).summary;
                if (summary !== undefined) bodies.push({ kind: 'turn.upsert', turn: wireRowOf(summary) });
            }
        }

        const ops = item.ops.filter((op) => (op as { op?: string }).op !== 'turn');
        const perFrame = HARNESS_WS_STREAM_LIMITS.ops_per_update_frame;
        for (let index = 0; index < ops.length; index += perFrame) {
            bodies.push({ kind: 'display.ops', turn_id: item.turnId, ops: ops.slice(index, index + perFrame) });
        }

        return bodies;
    };

    const factory: StreamSocketFactory = () => {
        const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as (() => void) | null,
            onclose: null as ((event: { code?: number }) => void) | null,
            send: (data: string) => {
                const frame = JSON.parse(data) as Record<string, unknown>;
                sent.push(frame);

                if (frame.type === 'subscribe') subscriptions.push(frame);
            },
            close: (code?: number) => {
                socket.closeCode = code;
            },
            closeCode: undefined as number | undefined
        };

        current = socket;
        socket.onmessage = (event) => {
            JSON.parse(String(event.data));
        };

        // Answer the handshake on the next microtask, so the caller's `subscribe`
        // has been registered before frames start arriving.
        queueMicrotask(() => {
            socket.onopen?.();
            socket.onmessage?.({
                data: JSON.stringify({
                    type: 'welcome',
                    protocol: 'harness.v1',
                    epoch: 'test-epoch',
                    at: Date.now(),
                    limits: { ...HARNESS_WS_STREAM_LIMITS }
                })
            });

            for (const sub of subscriptions) {
                socket.onmessage?.({
                    data: JSON.stringify({
                        type: 'subscription_state',
                        subscription_id: (sub as { subscription_id: string }).subscription_id,
                        scope: (sub as { scope: string }).scope,
                        epoch: 'test-epoch',
                        sequence: 0,
                        cursor: 'cursor-0',
                        revisions: [],
                        publishes: ['turn.upsert', 'display.ops', 'session.updated']
                    })
                });
            }

            flush();
        });

        return socket;
    };

    resetHarnessStream();
    configureHarnessStream({ socketFactory: factory });

    return {
        sent,
        subscriptions,
        push: (items) => {
            const list = Array.isArray(items) ? (items as unknown[]) : [items];
            let delivered = false;

            for (const entry of list) {
                const body = entry as Record<string, unknown>;
                // A canonical payload names its `kind`; anything else is a raw recorded frame
                // and goes through the server's projector first.
                const bodies = typeof body?.kind === 'string' ? [body] : updatesOf(body as SessionStreamItem);

                for (const framed of bodies) delivered = write(framed) || delivered;
            }

            return delivered;
        },
        close: () => {
            closed = true;
        },
        drop: () => {
            // A new connection folds from scratch, and the queue is re-anchored to the
            // subscription the client resumes.
            folds = new Map<string, LiveFold>();
            current?.onclose?.({ code: 1006 });
        },
        status: () => String((current === undefined ? 'idle' : 'open')),
        socket: () => ({ ...(current ?? {}) }) as { closeCode?: number }
    };
};
