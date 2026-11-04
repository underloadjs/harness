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
    const root = options.root ?? '/api';
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

    return async (url, method, body, context) => {
        const path = stripOrigin(url, root);
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
export const stripOrigin = (url: string, root = '/api'): string => {
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
