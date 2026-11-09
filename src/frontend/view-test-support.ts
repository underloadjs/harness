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
import { configureHarnessStream, harnessStream, resetHarnessStream } from './stream';
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

    // Invocation id -> the PERSISTENT conversation that ran it (`DisplayProjectContext
    // .invocationThreadIds`, turn-display.ts:1257). On the server this is the store's LIVE map
    // (`sessions.ts:3674` hands `session.invocationThreads` to the fold); a raw fixture states
    // the same fact through its roster's invocation slots (`invocationId` /
    // `originInvocationId` / the historical `invocationIds`).
    //
    // This is the join the child-conversation surface is built from: the projector stamps
    // `TurnSection.threadId` from it (turn-projector.ts:735, 810, 850), and the board claims a
    // delegated card's persistent identity from that field (./ui/turns.ts `paintCompiledSection`
    // → `persistentIdOf`). Without it a child section arrives with no persistent identity, the
    // board's roster claim has nothing to match (the roster PAGE carries identity fields only on
    // the thread resource route, ../server/api-reads.ts:497-531), and `data-persistent-thread`
    // never appears — so a child conversation cannot be opened, steered, or followed.
    //
    // First claim wins, mirroring the board's uniqueness rule: an invocation id a fixture
    // attributes to two conversations is ambiguous, and a wrong merge is worse than no merge.
    let joins: Map<string, string> | undefined;
    const invocationThreadIds = (): Map<string, string> => {
        if (joins === undefined) {
            joins = new Map<string, string>();
            for (const thread of Array.isArray(snapshot.threads) ? (snapshot.threads as unknown as SessionThread[]) : []) {
                for (const id of [
                    thread.invocationId,
                    thread.originInvocationId,
                    ...(Array.isArray(thread.invocationIds) ? thread.invocationIds : [])
                ]) {
                    if (typeof id !== 'string' || id.length === 0) continue;
                    if (!joins.has(id)) joins.set(id, thread.id);
                }
            }
        }

        return joins;
    };

    return {
        primary,
        ...(options.expiredRequestIds === undefined ? {} : { expiredRequestIds: options.expiredRequestIds }),
        blocksOf: (turn) => blocksFor().filter((block) => block.turnId === turn.id),
        // Only supplied when the fixture actually names a conversation, so a roster-less session
        // folds exactly as it did before the label map existed.
        ...(threadLabels().size === 0 ? {} : { threadLabels: threadLabels() }),
        ...(invocationThreadIds().size === 0 ? {} : { invocationThreadIds: invocationThreadIds() })
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
//
// The SAME rename applies to every `steers[i]` entry, because the double must speak the
// contract, not the projector's internal spelling: shared/harness-api.ts:1718-1726
// `DisplaySteerSummary` (src/server/harness.swagger.yaml:6075-6107) is closed and requires
// `promptPreview` + `promptChars` there too. The server serializer is
// ../server/api-reads.ts `turnRowOf` / `steerRowOf`, and this mirrors it field for field.
// A fixture's steer text is far below the server's 320-char bound, so no truncation shows up
// here; the pair's SHAPE (which is what a spec-following client reads) is identical.
export const wireRowOf = (summary: TurnSummary): Record<string, unknown> => {
    const { prompt, steers, ...rest } = summary as TurnSummary & { prompt?: string; steers?: readonly { prompt?: string }[] };
    const text = typeof prompt === 'string' ? prompt : '';

    return {
        ...rest,
        // `steers` is absent (not empty) on a row with no submits, which is what the projector
        // already emits and what the closed wire object allows.
        ...(steers === undefined ? {} : { steers: steers.map(wireSteerRowOf) }),
        promptPreview: text,
        promptChars: text.length
    };
};

// One steer entry of a compiled row -> the wire entry: mirrors ../server/api-reads.ts
// `steerRowOf` — drop `prompt`, state `promptPreview` + `promptChars`.
const wireSteerRowOf = (steer: { prompt?: string } & Record<string, unknown>): Record<string, unknown> => {
    const { prompt, ...rest } = steer;
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
// The fixture-document epoch. Every stream frame the realtime double delivers moves the
// document the canonical compositions are derived from, so the double bumps this counter and
// `withViewRoutes` drops its read memo on the next request. Without the signal, a memo that
// exists to stop one OPEN from re-reading its own document six times would also serve a
// document that a pushed frame has already replaced.
//
// T50: the counter lives on `globalThis`, NOT in a module-level `let`. A shell test installs the
// double through a DYNAMIC import (the rule `main.test.ts:227` states: `vi.resetModules()` clears
// the registry, so the double must configure the SAME `./stream` instance the shell dials) while
// its fetch stub keeps the STATICALLY imported adapter. Two instances of this module therefore
// mean two independent counters, and a frame pushed on one never invalidated the other's read
// memo: the shell re-read the document the pushed frame had already replaced, so a delete the
// server performed (`turn.removed` -> window re-read) was invisible. A well-known global key is
// the only place the two instances can agree.
const EPOCH_KEY = '__underloadHarnessFixtureEpoch';
// The global slot itself, read through `unknown` because `typeof globalThis` has no index
// signature (the key is a fixture marker, not a declared global).
const epochHost = (): Record<string, number> => globalThis as unknown as Record<string, number>;
const currentEpoch = (): number => epochHost()[EPOCH_KEY] ?? 0;
// Exported for a fixture that moves the record its own routes serve WITHOUT going through a
// write or a pushed frame (a polled refresh, a server-side progress step): the composition memo
// below exists to stop ONE open re-reading its own document six times, so a document that moves
// between reads must say so, or the next canonical read is served the previous answer.
export const bumpFixtureEpoch = (): void => {
    epochHost()[EPOCH_KEY] = currentEpoch() + 1;
};

export const withViewRoutes = (inner: StubHandler, options: ViewRouteOptions = {}): StubHandler => {
    const root = options.root ?? HARNESS_API_ROOT;
    // The epoch this adapter last served. Compared on every request; a difference means a
    // mutation happened OUTSIDE the request stream (a pushed live frame), and the memo goes.
    let seenEpoch = currentEpoch();
    const jsonOf = (value: unknown, status = 200): Response =>
        new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

    const readJson = async (response: Response): Promise<Record<string, unknown> | undefined> => {
        try {
            return (await response.clone().json()) as Record<string, unknown>;
        } catch {
            return undefined;
        }
    };

    // A mutation branch composes a canonical RESULT envelope (a receipt, `{cancelled}`, `{deleted}`)
    // out of the fixture's raw answer. That is only correct for an answer that SUCCEEDED: the
    // canonical server reports a refused write as an `ErrorBody` with its own status
    // (../shared/harness-api.ts), and `api.ts#readError` turns `error.message` into the sentence the
    // tile shows. Re-composing an error body into a receipt-shaped payload at HTTP 500 silently
    // replaced the server's reason with `HTTP 500`, so every "the submit was rejected" rule read a
    // different message than the one the shell must surface. Truth passes through untouched.
    const failureOf = (response: Response, payload: Record<string, unknown> | undefined): boolean =>
        response.status >= 400 || (payload !== undefined && payload.error !== undefined && payload.error !== null);

    // ---- the fixture-document memo ----------------------------------------------------
    //
    // ONE raw `GET {root}/sessions/:id` is the single document every canonical composition is
    // derived from: the metadata row, the row page, the roster, the actions, a display tree and
    // both lazy details all read it. Calling the stub once per composition made one session OPEN
    // hit the fixture six times — exactly the request storm the shell's own "one read per open"
    // counts (`expect(gets).toBe(1)`, main.test.ts:2864) — and let one open read two different
    // versions of a document a mutation moved in between.
    //
    // The memo stores the ANSWERED BODY (status + parsed JSON) per GET path. A miss is stored too,
    // because `offer()` probes several spellings of the same route and a strict stub throws for a
    // route the browser never asks for; re-probing that path must not add another hit to the
    // fixture's request log. Any WRITE clears the memo BEFORE it is dispatched: a POST/PATCH/PUT/
    // DELETE answer may move the document the next composition reads.
    type FixtureAnswer = { status: number; payload: Record<string, unknown> | undefined; missing: boolean; error?: unknown };
    let getMemo = new Map<string, Promise<FixtureAnswer>>();
    const clearGetMemo = (): void => {
        getMemo = new Map();
    };

    // The one fixture call behind every memoized read. A MISS is remembered too, because
    // `offer()` probes several spellings of the same route and a strict stub throws for a route
    // the browser never asks for; re-probing that path must not add another hit to the stub's
    // request log. The thrown error is kept so the caller sees the stub's own sentence.
    const answerOf = async (path: string): Promise<FixtureAnswer> => {
        try {
            const result = inner(path, undefined, undefined, undefined);
            const resolved = result instanceof Promise ? await result : result;

            if (resolved === undefined) return { status: 0, payload: undefined, missing: true };

            return { status: resolved.status, payload: await readJson(resolved), missing: false };
        } catch (error) {
            return { status: 0, payload: undefined, missing: true, error };
        }
    };

    // The memoized twin of `inner(path, undefined)` for a COMPOSITION READ, storing the
    // PROMISE: `openSession` dials its metadata, row page, roster and actions reads
    // CONCURRENTLY, so a value memo would still let all four see an empty cache and hit the
    // stub four times for one document. Sharing the in-flight promise is what makes one open
    // cost one raw read.
    const fixtureGet = async (path: string): Promise<Response | undefined> => {
        let pending = getMemo.get(path);

        if (pending === undefined) {
            pending = answerOf(path);
            getMemo.set(path, pending);
        }

        const answer = await pending;

        // The stub's OWN error is re-thrown so a strict fixture's "unexpected request" sentence
        // still reaches the client, exactly as `inner` delivered it. A route the stub simply does
        // not declare answers `undefined` — it does not throw — because the DELETE branch below
        // reads the host document first, and a fixture that declares only the DELETE verb on that
        // path must still get its delete dispatched.
        if (answer.error !== undefined) throw answer.error;
        if (answer.missing) return undefined;

        return jsonOf(answer.payload ?? {}, answer.status);
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
        // made the same way — and through the memo, because every composition below needs this same
        // document and the fixture must see it fetched ONCE per open.
        const response = await fixtureGet(`${root}/sessions/${encodeURIComponent(sessionId)}`);
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

    // A transcript WRITE is remembered so the follow-up reads answer the bytes the server now
    // holds. The canonical PUT answers a `TranscriptWriteReceipt` and nothing else
    // (../shared/harness-api.ts:1552), so the shell re-reads `GET .../transcript` and
    // `.../transcript/document` after saving (./view-shell.ts `updateThreadTranscript`).
    // Recomposing those reads from the fixture's UNCHANGED host document answered the pre-save
    // value — "save, then re-read" degraded into "save, then forget" — so the stored text and the
    // validator's verdict live here until the fixture's own document moves past them.
    // Key: `{sessionId}|{threadId}`.
    const writtenTranscripts = new Map<
        string,
        {
            agent: string;
            document: string;
            state: 'ok' | 'unreadable';
            error?: string;
            storedType?: string;
            revision: number;
        }
    >();

    // The stored JSON TEXT the write left behind, in the server's own spelling: the fixture names
    // it `raw` (the bytes), else it is the accepted `messages`, else the invalid value it quotes.
    const writtenDocumentOf = (transcript: Record<string, unknown>): string => {
        if (typeof transcript.raw === 'string') return transcript.raw;
        const invalid = transcript.invalid as { messages?: unknown } | undefined;

        return JSON.stringify(invalid !== undefined ? invalid.messages ?? [] : transcript.messages ?? [], null, 2);
    };

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

    // A `{session}` envelope is RAW (pre-canonical) when its payload is a `SessionSnapshot`:
    // the raw document stamps camelCase fields (`createdAt`, `lastError`, `agentModels`) and
    // carries its children inline (`turns`), while a canonical `SessionResource` names them
    // snake_case (`created_at`, `last_error`, `agent_models`) and publishes COUNTERS
    // (`turn_count`) instead of children. Detection is by FIELD NAME, never by url root, so a
    // fixture that declares the canonical route itself keeps its own body.
    const isRawSessionEnvelope = (payload: Record<string, unknown> | undefined): boolean => {
        const session = payload?.session;
        if (typeof session !== 'object' || session === null) return false;
        const row = session as Record<string, unknown>;

        return row.created_at === undefined && (row.createdAt !== undefined || Array.isArray(row.turns));
    };

    // The unreadable-transcript record a fixture keeps beside its roster. The raw surface stores
    // broken threads in a SEPARATE array (`invalidThreads`), while the canonical roster states the
    // verdict ON the row (`transcript_state` + `transcript_error`), which is the only spelling
    // `view-api.ts#invalidThreadsOf` can derive the board's marker from.
    const invalidThreadOf = (
        host: RawSnapshotEx | undefined,
        threadId: string
    ): Record<string, unknown> | undefined =>
        ((host?.invalidThreads ?? []) as unknown as Record<string, unknown>[]).find(
            (candidate) => candidate.id === threadId
        );

    // A stored JSON text parsed for the count/role figures a metadata head publishes. A broken
    // value is DATA (`transcript_state: unreadable`), never a parse failure out of this double.
    const safeParse = (text: string): unknown => {
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    };

    const roleCountsOf = (messages: readonly Record<string, unknown>[]): Record<string, number> => ({
        system: messages.filter((entry) => entry.role === 'system').length,
        user: messages.filter((entry) => entry.role === 'user').length,
        assistant: messages.filter((entry) => entry.role === 'assistant').length,
        tool: messages.filter((entry) => entry.role === 'tool').length
    });

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

    // T32: one definition is asked from the fixture at most once per adapter, and the
    // instruction subresources are composed from that same answer.
    //
    // WHY THIS IS NOT A LIE ABOUT THE CLIENT: `GET /harnesses/:name`, `GET .../instructions`
    // and `GET .../instructions/:agent` are three canonical routes over ONE source document.
    // Serving each from a fresh fixture read would put three requests in a strict stub's log
    // for what the browser dialled once, and `agent-instructions-lazy-main.test.ts` counts
    // them to prove the shell asks exactly one definition read per dialog open. The entry is
    // dropped by any write under `/harnesses`, so a fixture that mutates its own definition
    // (the harness PATCH handlers do exactly that) is re-read on the next answer.
    const definitionCache = new Map<string, Record<string, unknown>>();

    // T7b (R5/R6/R7): the session roster this double serves.
    //
    // WHY A STORE IS NEEDED: a shell fixture declares ONE raw record per conversation (the
    // `{session}` body behind `GET {root}/sessions/:id`), and the members a conversation binds or
    // invents for itself live in state that record has never carried (`record.definition.agents`
    // growing, `record.preset.customAgents`, `record.sessionAgents`, src/server/sessions.ts
    // :5038-5091). A test that POSTs a member and then re-reads the definition or the roster must
    // be answered with the NEW team, or the double would confirm the write with one route and deny
    // it with the next. So each conversation gets a small overlay here — additions, removals,
    // per-agent instruction overrides and per-agent models — and every session-agent route, plus
    // the frozen-definition read, composes from it.
    //
    // A fixture that declares one of these routes itself never touches this store (offer-first,
    // the adapter's standing rule), so a test stays free to stage its own roster or its own 409.
    type SessionAgentEntry = {
        name: string;
        profile: string;
        // 'bound' = a trusted catalogue profile this conversation joined (its own shipped text);
        // 'custom' = an agent the reader invented, whose whole prompt is the sentence it was
        // created with (../shared/harness-api.ts:982-1000).
        kind: 'bound' | 'custom';
        model?: string;
        instruction?: string;
    };

    type SessionAgentOverlay = {
        added: SessionAgentEntry[];
        removed: string[];
        // One agent's session-level prompt. A key that is DELETED is the contract's `null` patch:
        // the agent inherits again (../shared/harness-api.ts:1002-1011).
        instructions: Record<string, string>;
        models: Record<string, string>;
    };

    const sessionAgentWrites = new Map<string, SessionAgentOverlay>();

    const sessionAgentOverlayOf = (id: string): SessionAgentOverlay => {
        const known = sessionAgentWrites.get(id);

        if (known !== undefined) return known;

        const created: SessionAgentOverlay = { added: [], removed: [], instructions: {}, models: {} };
        sessionAgentWrites.set(id, created);

        return created;
    };

    // The roster one conversation reports: its frozen definition's team, minus anything it
    // detached, plus anything it bound or invented — in the server's own order (definition members
    // first, this session's additions after, see src/server/api-session-agents.test.ts:687-691).
    const sessionMembersOf = (definition: Record<string, unknown>, overlay: SessionAgentOverlay): string[] => {
        const listed = Array.isArray(definition.agents)
            ? (definition.agents as string[])
            : [String(definition.primary ?? ''), ...((definition.subagents as string[] | undefined) ?? [])];
        const names: string[] = [];

        for (const name of [...listed, ...overlay.added.map((entry) => entry.name)]) {
            if (typeof name !== 'string' || name.length === 0) continue;
            if (overlay.removed.includes(name)) continue;
            if (!names.includes(name)) names.push(name);
        }

        return names;
    };

    // The prompt the SERVER composes for a profile nobody overrode: the identity sentence plus one
    // `Guidelines:` block of `- ` bullets (src/agents/index.ts:148 `agentInstruction`), which is
    // the exact text a live brain reports on `GET .../agents/:agent/instruction`. Kept in step with
    // ./ui/agents.ts `agentDefaultInstructionOf`, because the dialog box and the double's answer
    // have to agree or a session test cannot tell "the shell showed the live text" apart from
    // "the shell composed a fallback itself".
    const sessionAgentPromptOf = (identity: string, guidelines: readonly string[]): string => {
        const base = identity.trim();
        const rules = guidelines.map((line) => line.trim()).filter((line) => line.length > 0);

        if (rules.length === 0) return base;

        return `${base}\n\nGuidelines:\n${rules.map((line) => `- ${line}`).join('\n')}`;
    };

    // One roster row. The shell reads `agent_id` here and the text from the subresource, so the
    // length/guideline figures stay an honest approximation of metadata this double does not
    // author — while the fields a CLIENT actually branches on (`role`, `origin`, `deletable`)
    // carry the server's real conditions (src/server/api-reads.ts:969-1014).
    const sessionBindingOf = (
        host: Record<string, unknown>,
        overlay: SessionAgentOverlay,
        name: string,
        definition: Record<string, unknown>
    ): Record<string, unknown> => {
        const primary = String(definition.primary ?? '');
        const threadUsers = new Set(
            ((host.threads ?? []) as Record<string, unknown>[])
                .filter((thread) => thread.origin === 'host')
                .map((thread) => String(thread.agent ?? ''))
        );
        const added = overlay.added.find((entry) => entry.name === name);
        const frozenModels = (definition.agentModels ?? definition.agent_models ?? {}) as Record<string, string>;
        const liveModels = (host.agentModels ?? {}) as Record<string, string>;
        const sessionModel = String(host.model ?? '');
        const override = overlay.instructions[name];
        const custom = added?.kind === 'custom';
        const stored = (definition.agentInstructions ?? definition.agent_instructions ?? {}) as Record<
            string,
            string
        >;

        return {
            agent_id: name,
            profile: added?.profile ?? name,
            role: name === primary ? 'primary' : 'subagent',
            origin: added !== undefined ? 'session' : 'definition',
            // The live brain's model first (this conversation's choice), then the creation
            // baseline, then the session settings model (`inherited_model`, the field that exists
            // to state that difference).
            model: overlay.models[name] ?? liveModels[name] ?? frozenModels[name] ?? sessionModel,
            inherited_model: frozenModels[name] ?? sessionModel,
            // Provenance, in the server's order: an invented name has no profile to inherit from,
            // so its text can only have come from this conversation
            // (src/server/api-reads.ts:973-980).
            instruction_source: custom
                ? 'session'
                : override !== undefined || typeof stored[name] === 'string'
                  ? 'harness'
                  : 'catalogue',
            instruction_chars: (override ?? added?.instruction ?? stored[name] ?? '').length,
            ...(override !== undefined || (custom && added?.instruction !== undefined)
                ? { has_instruction_override: true }
                : {}),
            editable: true,
            // R6: the entry point and any member that still owns a conversation cannot detach.
            deletable: name !== primary && !threadUsers.has(name),
            restorable: true,
            revision: host.revision ?? 1
        };
    };

    // The binding PATCH body, applied to the overlay with the contract's three states: an omitted
    // field is no change, a string REPLACES the whole field, an explicit `null` clears this
    // session's override (../shared/harness-api.ts:1002-1011).
    const applySessionAgentPatch = (overlay: SessionAgentOverlay, agent: string, body: unknown): void => {
        const input = (typeof body === 'string' ? JSON.parse(body) : (body ?? {})) as Record<string, unknown>;

        if (input.instruction === null) delete overlay.instructions[agent];
        else if (typeof input.instruction === 'string') overlay.instructions[agent] = input.instruction;

        if (input.model === null) delete overlay.models[agent];
        else if (typeof input.model === 'string' && input.model.trim().length > 0) {
            overlay.models[agent] = input.model.trim();
        }
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
                // A composition read carries no method: serve it from the fixture memo so six
                // canonical compositions of one document cost one fixture read (see `fixtureGet`).
                if (useVerb === undefined) return await fixtureGet(path);

                const result = inner(path, useVerb, body, context);

                return result instanceof Promise ? await result : result;
            } catch {
                return undefined;
            }
        };

        // A COMPOSITION read is a read: it carries no method, no body and no original
        // `RequestInit`. `hostOf` above follows the same convention, and the difference is
        // not cosmetic — a stub logs `init?.method`, so forwarding the caller's init would
        // record this helper's boot/definition read as a repeat of the write that triggered
        // it (a harness PATCH answering `{harness}` then counting twice in a request log that
        // is the whole point of several shell tests).
        const innerGet = async (path: string): Promise<Response | undefined> => {
            try {
                const result = inner(path, undefined, undefined);

                return result instanceof Promise ? await result : result;
            } catch {
                return undefined;
            }
        };

        // Offer the browser's ACTUAL url to the test's own handler first, exactly as
        // the `/views` branch does: a stub may declare the canonical route itself and
        // stay authoritative, and its request log must see what the client sent.
        //
        // T44: `sub` now carries the client's query string (the parser above needs it to
        // honour `order`/`limit`/`cursor`). Two attempts, in order of authority: the FULL url
        // for a fixture that answers a query, then the bare PATH for the far more common fixture
        // that matches exact pathnames (`url === '/api/sessions/s1/turns'`). Without the second
        // attempt every fixture-declared canonical page would silently stop answering and fall
        // through to the composition, which is a different (if equivalent) document.
        const offer = async (): Promise<Response | undefined> => {
            for (const attempt of sub === bare ? [sub] : [sub, bare]) {
                try {
                    const resolved =
                        innerVerb === undefined
                            ? await fixtureGet(`${root}${attempt}`)
                            : await (async () => {
                                  const result = inner(`${root}${attempt}`, innerVerb, body, context);

                                  return result instanceof Promise ? await result : result;
                              })();

                    if (resolved !== undefined) return resolved;
                } catch {
                    // A strict stub throws for a route it does not implement: that is the same
                    // "no such route" signal `undefined` carries, so try the next spelling.
                }
            }

            return undefined;
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
            const response = await innerGet(root);
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

            // T46: the fallback is the fixture's own BOOT document, read through the adapter's
            // cached `legacyBootOf` — the same source the catalogue branch above falls back to.
            // The old fallback asked `{root}/harnesses`, which answers a HARNESS LIST with no
            // `defaults` key at all, so a fixture that authored its provider defaults in the boot
            // document got `base_url: ''` / `model: ''` back, and every endpoint/model assertion
            // measured the fixture instead of the client.
            const boot = await legacyBootOf();

            if (boot?.defaults !== undefined) return jsonOf(configOf(boot));

            const defaults = await (async (): Promise<LegacyBootstrap['defaults']> => {
                // `safeInner`, not `inner`: a strict stub THROWS for a route the browser never
                // asks for, and that is the same "no such route" signal `undefined` carries.
                const resolved = await safeInner(`${root}/harnesses`, innerVerb);
                const payload = resolved === undefined ? undefined : await readJson(resolved);
                const listed = legacyOf(payload);

                return listed?.defaults ?? (payload?.defaults as LegacyBootstrap['defaults']);
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
                          // T32: a contract CARD omits `agent_models` and the instruction
                          // fields (../shared/harness-api.ts:418-433), so a fixture row that
                          // does not state them is answered as a real card would answer:
                          // absent, and the client has to ask the identified read. A row that
                          // DOES state them (an unredacted server, which is what most shell
                          // fixtures model) keeps them, because dropping them would make the
                          // double claim something the source it was given never said.
                          ...(entry.agent_models === undefined && entry.agentModels === undefined
                              ? {}
                              : { agent_models: entry.agent_models ?? entry.agentModels }),
                          ...(entry.agent_instructions === undefined && entry.agentInstructions === undefined
                              ? {}
                              : { agent_instructions: entry.agent_instructions ?? entry.agentInstructions }),
                          // T4: the same passthrough rule for the identity-colour map
                          // (`agent_colors`, ../shared/harness-api.ts:459). A real definition CARD omits that
                          // field, so a fixture that states no colours is answered as a real card answers:
                          // absent. A fixture that DOES state them models an unredacted server, and dropping
                          // them would make the double deny the client a field its own source named.
                          ...(entry.agent_colors === undefined && entry.agentColors === undefined
                              ? {}
                              : { agent_colors: entry.agent_colors ?? entry.agentColors })
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

        // -------------------------------------------------------------------
        // T32: the identified definition read and the instruction subresources.
        //
        // The configuration dialog asks for ONE definition (`getHarness`, api.ts:639) when it
        // opens, and one TEXT read per member the summary flags as overridden
        // (`getHarnessInstructionText`, api.ts:689). A shell fixture declares the legacy
        // surface instead: a boot document whose `presets` rows carry `agentModels`,
        // `agentInstructions` and `coreTools` in camelCase, all of it in one payload. The
        // canonical wire splits that into a card, an identified read (`HarnessDefinition`:
        // `core_tools` + `agent_models` + `instruction_summary`, NEVER the text,
        // shared/harness-api.ts:449-460) and a per-member text subresource
        // (`HarnessInstructionTextResponse`, shared/harness-api.ts:530). Same raw-IN /
        // compiled-OUT rule as the catalogue pages above: production only ever sees the
        // contract shape, the fixture only ever writes its own.
        //
        // Offer-first, as everywhere in this adapter: a fixture that declares the route itself
        // (canonical or its legacy twin at `${root}/harnesses/:name`) stays authoritative and
        // its request log still sees what the browser dialled — which is what lets a shell
        // test count exactly one definition read per dialog open.

        // The trusted profile library (`agents`) as the instruction rows need it: the layer
        // under a harness override, and the source of `guidelines`.
        const trustedProfilesOf = async (): Promise<Record<string, Record<string, unknown>>> => {
            const profiles: Record<string, Record<string, unknown>> = {};

            for (const item of legacyItemsOf((await legacyBootOf()) ?? ({} as LegacyBootstrap), 'agents')) {
                const entry = item as Record<string, unknown>;
                if (typeof entry.name === 'string') profiles[entry.name] = entry;
            }

            return profiles;
        };

        // The stored per-agent instruction OVERRIDES of one definition, in either spelling.
        // `agentInstructions` is the fixture's camelCase word, `agent_instructions` the
        // contract's; a fixture that answers the identified read itself may use either.
        const storedInstructionsRaw = (definition: Record<string, unknown>): Record<string, string> => {
            const map = definition.agent_instructions ?? definition.agentInstructions;

            return map !== undefined && typeof map === 'object' ? (map as Record<string, string>) : {};
        };

        // The members one definition runs, in the contract's order (primary first).
        const membersRaw = (definition: Record<string, unknown>): string[] => {
            if (Array.isArray(definition.agents)) return definition.agents as string[];

            const primary = typeof definition.primary === 'string' ? definition.primary : '';
            const subagents = Array.isArray(definition.subagents) ? (definition.subagents as string[]) : [];

            return [primary, ...subagents.filter((name) => name !== primary)];
        };

        // One instruction row: provenance and length, no text. `harness` is the layer this
        // definition supplies; anything else falls through to the trusted profile
        // (src/server/api-reads.ts:1028-1048 composes the same order for the real server).
        const instructionRowOf = async (definition: Record<string, unknown>, agent: string) => {
            const override = storedInstructionsRaw(definition)[agent];
            const harnessOverride = typeof override === 'string';
            const profile = (await trustedProfilesOf())[agent];
            const text = harnessOverride ? override : String(profile?.instruction ?? '');

            return {
                agent,
                source: harnessOverride ? 'harness' : 'catalogue',
                overridden: harnessOverride,
                chars: text.length
            };
        };

        // T7b (R6): ONE member's EFFECTIVE prompt in THIS conversation — the same ladder
        // src/server/api.ts:2770-2835 climbs: this session's override, then the definition's
        // stored text, then the profile's shipped prompt composed with its guidelines (the live
        // brain's own system message). Answering with the identity ALONE would make the double
        // claim a shorter prompt than the one the agent runs, and the shell's one instruction box
        // would look like it had appended the guideline layer itself.
        const sessionInstructionTextOf = async (
            overlay: SessionAgentOverlay,
            agent: string,
            definition: Record<string, unknown>
        ): Promise<{ instruction: string; guidelines: string[]; source: string }> => {
            const added = overlay.added.find((entry) => entry.name === agent);
            const override = overlay.instructions[agent];

            // A session-defined agent has no profile and therefore no guideline layer: the text
            // this conversation gave it IS the whole prompt.
            if (added !== undefined && added.kind === 'custom') {
                return {
                    instruction: override ?? added.instruction ?? `You are the ${agent} agent.`,
                    guidelines: [],
                    source: 'session'
                };
            }

            if (override !== undefined) return { instruction: override, guidelines: [], source: 'harness' };

            const stored = storedInstructionsRaw(definition)[agent];

            if (typeof stored === 'string' && stored.trim().length > 0) {
                return { instruction: stored, guidelines: [], source: 'harness' };
            }

            const profile = (await trustedProfilesOf())[agent];
            const guidelines = Array.isArray(profile?.guidelines) ? (profile.guidelines as string[]) : [];

            return {
                instruction: sessionAgentPromptOf(String(profile?.instruction ?? ''), guidelines),
                guidelines,
                source: 'catalogue'
            };
        };

        // The definition this stub describes, in the fixture's own spelling: the route the
        // fixture declares wins, then the boot document's `presets` row (the same data).
        const readFixtureDefinition = async (name: string): Promise<Record<string, unknown> | undefined> => {
            const direct = await innerGet(`${root}/harnesses/${encodeURIComponent(name)}`);
            const payload = direct === undefined ? undefined : await readJson(direct);
            const declared = payload?.harness ?? payload?.definition;

            if (declared !== undefined && typeof declared === 'object') return declared as Record<string, unknown>;

            return (
                legacyItemsOf((await legacyBootOf()) ?? ({} as LegacyBootstrap), 'harnesses') as Record<string, unknown>[]
            ).find((candidate) => candidate.name === name);
        };

        // The identified read is the ONE place the fixture is asked: a client read refreshes
        // the cache, so a second dialog open really does re-dial the route (the freshness rule
        // `agent-instructions-lazy-main.test.ts` pins), while the instruction subresources
        // composed underneath it answer from that same document instead of doubling the
        // fixture's request log for one browser action.
        const legacyDefinitionOf = async (
            name: string,
            refresh = false
        ): Promise<Record<string, unknown> | undefined> => {
            if (!refresh) {
                const cached = definitionCache.get(name);

                if (cached !== undefined) return cached;
            }

            const resolved = await readFixtureDefinition(name);

            if (resolved !== undefined) definitionCache.set(name, resolved);

            return resolved;
        };

        // A definition in either spelling -> the contract's IDENTIFIED read: card fields, the
        // resolved core-tool set, the model map, and the instruction summary. Instruction
        // TEXT is deliberately not here; a fixture that states it is answered by the
        // subresource below, which is where the contract puts it.
        const harnessDefinitionResourceOf = async (
            definition: Record<string, unknown>
        ): Promise<Record<string, unknown>> => {
            const models = definition.agent_models ?? definition.agentModels;
            // T4: the per-agent identity colours, in either spelling (a fixture writes camelCase,
            // the contract reads snake_case).
            const colors = definition.agent_colors ?? definition.agentColors;
            const coreTools = definition.core_tools ?? definition.coreTools;
            const members = membersRaw(definition);

            return {
                name: String(definition.name ?? ''),
                title: String(definition.title ?? ''),
                description: String(definition.description ?? ''),
                requires_endpoint: definition.requires_endpoint ?? definition.requiresEndpoint ?? false,
                primary: String(definition.primary ?? ''),
                subagents: Array.isArray(definition.subagents) ? definition.subagents : members.slice(1),
                agents: members,
                tools: Array.isArray(definition.tools) ? definition.tools : [],
                builtin: definition.builtin ?? false,
                definition_revision: definition.definition_revision ?? definition.definitionRevision ?? 1,
                ...(coreTools === undefined ? {} : { core_tools: coreTools }),
                ...(models === undefined || typeof models !== 'object' ? {} : { agent_models: models }),
                ...(colors === undefined || typeof colors !== 'object' ? {} : { agent_colors: colors }),
                instruction_summary: await Promise.all(members.map((agent) => instructionRowOf(definition, agent)))
            };
        };

        // `String.match` answers `null` (not `undefined`) for a miss, so every branch below
        // tests the match for truthiness; a `!== undefined` guard would dereference `null[1]`.
        const harnessMatch = bare.match(/^\/harnesses\/([^/]+)$/);

        if (harnessMatch !== null) {
            const name = decodeURIComponent(harnessMatch[1]);

            // A write stays the fixture's: it owns what the patch did. TWO translations happen
            // around it, both directions of the same rule the rest of this adapter follows:
            //   REQUEST  production now sends the contract's spelling (`agent_models`,
            //            `agent_instructions`, ../shared/harness-api.ts:488-499). A shell
            //            fixture declares the legacy surface and asserts camelCase, so the
            //            body is re-expressed in the fixture's own words before it is offered —
            //            and the ORIGINAL `RequestInit` is replaced, because these stubs read
            //            `init.body` rather than the parsed argument.
            //   ANSWER   the fixture's `{harness}` is handed back as the contract's identified
            //            read, because production reads `agent_models` off it (`descriptorOf`,
            //            api.ts:1203) and a camelCase body would silently drop the map the
            //            reader just saved.
            // A fixture with no such route stays a hard miss (`undefined`), so an unimplemented
            // write still fails loudly rather than inventing a confirmed state.
            if (verb === 'PATCH') {
                // The write moved the definition, so the cached copy (and anything composed
                // from it) is dropped BEFORE the answer is built: the next read must see the
                // fixture's new state, not the pre-write one.
                definitionCache.delete(name);

                const canonical = (typeof body === 'string'
                    ? JSON.parse(body)
                    : (body ?? {})) as Record<string, unknown>;
                const legacy: Record<string, unknown> = { ...canonical };

                if (legacy.agent_models !== undefined) legacy.agentModels = legacy.agent_models;
                if (legacy.agent_instructions !== undefined) legacy.agentInstructions = legacy.agent_instructions;
                if (legacy.agent_colors !== undefined) legacy.agentColors = legacy.agent_colors;
                delete legacy.agent_models;
                delete legacy.agent_instructions;
                delete legacy.agent_colors;

                const rawInit = context?.init ?? { method: 'PATCH' };
                const response = await inner(`${root}/harnesses/${encodeURIComponent(name)}`, innerVerb, legacy, {
                    init: { ...rawInit, method: 'PATCH', body: JSON.stringify(legacy) }
                });

                if (response === undefined) return undefined;

                const resolved = response instanceof Promise ? await response : response;
                const payload = await readJson(resolved);

                if (payload?.harness === undefined || payload.error !== undefined) return resolved;

                return jsonOf(
                    { harness: await harnessDefinitionResourceOf(payload.harness as Record<string, unknown>) },
                    resolved.status
                );
            }

            if (verb !== 'GET') {
                // A DELETE removes the definition; the cache must not keep serving it.
                definitionCache.delete(name);

                return offer();
            }

            const definition = await legacyDefinitionOf(name, true);

            if (definition === undefined) return jsonOf({ error: { message: `Unknown harness ${name}` } }, 404);

            return jsonOf({ harness: await harnessDefinitionResourceOf(definition) });
        }

        // The instruction INDEX: one row per member, provenance and length, no text, not paged
        // (shared/harness-api.ts:520). Composed from the same definition the dialog's read
        // answers, so a fixture that only declares `/harnesses/:name` still feeds a faithful
        // index — which is what tells the client WHICH text reads are worth making.
        const instructionsMatch = bare.match(/^\/harnesses\/([^/]+)\/instructions$/);

        if (instructionsMatch && verb === 'GET') {
            const name = decodeURIComponent(instructionsMatch[1]);
            const direct = await offer();

            if (direct !== undefined) return direct;

            const definition = await legacyDefinitionOf(name);

            if (definition === undefined) return jsonOf({ error: { message: `Unknown harness ${name}` } }, 404);

            const items = await Promise.all(membersRaw(definition).map((agent) => instructionRowOf(definition, agent)));

            return jsonOf({ harness_name: name, total: items.length, items });
        }

        // ONE member's effective text, with its provenance (shared/harness-api.ts:530). The
        // layer order is the server's: this definition's override first, else the trusted
        // profile's prompt (src/server/toolbox.ts composes the prompt the same way).
        const instructionTextMatch = bare.match(/^\/harnesses\/([^/]+)\/instructions\/([^/]+)$/);

        if (instructionTextMatch && verb === 'GET') {
            const name = decodeURIComponent(instructionTextMatch[1]);
            const agent = decodeURIComponent(instructionTextMatch[2]);
            const direct = await offer();

            if (direct !== undefined) return direct;

            const definition = await legacyDefinitionOf(name);

            if (definition === undefined) return jsonOf({ error: { message: `Unknown harness ${name}` } }, 404);

            const row = await instructionRowOf(definition, agent);
            const override = storedInstructionsRaw(definition)[agent];
            const profile = (await trustedProfilesOf())[agent];
            const instruction = typeof override === 'string' ? override : String(profile?.instruction ?? '');

            return jsonOf({
                harness_name: name,
                agent,
                source: row.source,
                instruction,
                guidelines: Array.isArray(profile?.guidelines) ? profile.guidelines : [],
                chars: instruction.length
            });
        }

        if (bare === '/sessions') {
            if (verb === 'POST') {
                const created = await inner(`${root}/sessions`, innerVerb, body, context);
                const resolved = created instanceof Promise ? await created : created;
                if (resolved === undefined) return undefined;
                const payload = await readJson(resolved);
                if (failureOf(resolved, payload)) return resolved;
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

            // T52: a DELETE is dispatched BEFORE this adapter reads the host document. The
            // branch only forwards the request to the fixture's own route and passes its answer
            // through, so no document is needed here — and a strict shell fixture that declares
            // ONLY `DELETE {root}/sessions/:id` (main.test.ts:3871) throws for the probe read,
            // which replaced an accepted delete with "the harness server is unreachable" and left
            // the pill on screen. The real server answers a delete without any prior GET.
            if (verb === 'DELETE') {
                const response = await inner(`${root}/sessions/${sessionId}`, innerVerb, body, context);

                return response instanceof Promise ? await response : response;
            }

            const host = await hostEx(sessionId);

            if (host === undefined) return jsonOf({ error: { message: `Unknown session ${sessionId}` } }, 404);

            // A PATCH answers the patched row, not a document.
            if (verb === 'PATCH') {
                const patched = await inner(`${root}/sessions/${sessionId}`, innerVerb, body, context);
                const resolved = patched instanceof Promise ? await patched : patched;
                if (resolved === undefined) return undefined;
                const payload = await readJson(resolved);

                // T46: a REJECTED patch answers an ErrorBody with its own status (a bad agent
                // key in `agent_models`, a model the catalogue does not offer, a 500). Composing
                // a row from the fixture's UNCHANGED host document turned that into a 200
                // `{session}`, so the client painted the pre-patch state as if the write landed
                // and the "keep the last server-confirmed selection" rule could never fire. The
                // failure passes through with its status and its body. An explicit `error: null`
                // on a 200 is a SUCCESS body that says "no failure", so only a stated error (or
                // an error status) is passed through.
                if (resolved.status >= 400 || (payload?.error !== undefined && payload.error !== null)) return resolved;

                const session = (payload?.session ?? payload?.view ?? host) as SessionSnapshot;

                return jsonOf({ session: sessionResourceOf(session) }, resolved.status);
            }

            // A fixture that declares the canonical read itself stays authoritative. `offer()`
            // also reaches the fixture's LEGACY twin (`GET {root}/sessions/:id`), whose body is a
            // raw `SessionSnapshot`: camelCase (`createdAt`/`lastError`/`queueDepth`/`turnCount`
            // by children) where the canonical row is snake_case with counters. Handing that body
            // over verbatim gave the client a row with `last_error`, `queue_depth`, `agent_models`
            // and `turn_count` all undefined, so the session note fell back to `'session error'`,
            // the model selects painted nothing and every queue tally read as zero. A RAW envelope
            // is therefore COMPOSED through `sessionResourceOf`, keeping the fixture's own status so
            // a 404/500 answer still arrives as an error.
            const requested = await offer();

            if (requested !== undefined) {
                const payload = await readJson(requested);

                if (!isRawSessionEnvelope(payload) || requested.status >= 400 || payload?.error !== undefined)
                    return requested;

                return jsonOf({ session: sessionResourceOf(payload?.session as RawSnapshotEx) }, requested.status);
            }

            return jsonOf({ session: sessionResourceOf(host) });
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

        // `GET {root}/sessions/:id/turns/:turnId` — the identified turn read: metadata plus
        // COUNTS and the VERBATIM prompt (../shared/harness-api.ts `TurnResource`, composed by
        // the server at ../server/api-reads.ts:297-351). The JSON transcript is the only client
        // of this route (`view-api.ts readRawTurns`), and the contract spells the three figures
        // the export needs `thread_id`/`started_at`/`updated_at` — the double states exactly the
        // server's spelling, so a shell fixture cannot pass on a shape the wire never sends.
        const turnMatch = bare.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)$/);
        if (turnMatch && verb === 'GET') {
            const direct = await offer();
            if (direct !== undefined) return direct;

            const sessionId = decodeURIComponent(turnMatch[1]);
            const turnId = decodeURIComponent(turnMatch[2]);
            const host = await hostEx(sessionId);
            const turn = host?.turns?.find((candidate) => candidate.id === turnId);

            if (turn === undefined) return jsonOf({ error: { message: `Unknown turn ${turnId}` } }, 404);

            const attachments = Array.isArray((turn as { attachments?: unknown[] }).attachments)
                ? ((turn as { attachments: unknown[] }).attachments.length)
                : 0;
            const steers = Array.isArray(turn.steers) ? turn.steers : [];

            return jsonOf({
                turn: {
                    session_id: sessionId,
                    id: turn.id,
                    index: turn.index,
                    status: turn.status,
                    prompt: turn.prompt,
                    ...(turn.threadId === undefined ? {} : { thread_id: turn.threadId }),
                    ...(((turn as { threadLabel?: string }).threadLabel) === undefined
                        ? {}
                        : { thread_label: (turn as { threadLabel?: string }).threadLabel }),
                    ...(turn.startedAt === undefined ? {} : { started_at: turn.startedAt }),
                    updated_at: turn.updatedAt,
                    ...(turn.usage === undefined ? {} : { usage: turn.usage }),
                    ...(attachments === 0 ? {} : { attachment_count: attachments }),
                    event_count: (Array.isArray(turn.events) ? turn.events : []).length,
                    steer_count: steers.length,
                    revision: host?.revision ?? 1
                }
            });
        }

        // `GET {root}/sessions/:id/turns/:turnId/events` — one turn's verbatim recorded events,
        // paired with their recorded times and paged (`TurnEventPage`,
        // ../shared/harness-api.ts:1652-1660; the server's own framing in
        // ../server/api-reads.ts). The cursor is this double's own convention — the index of the
        // first event the next page owes — because `readRawTurns` walks `next_cursor` until it is
        // empty and a fixture page of recorded events is bounded by the fixture's own array.
        const turnEventsMatch = bare.match(/^\/sessions\/([^/]+)\/turns\/([^/]+)\/events$/);
        if (turnEventsMatch && verb === 'GET') {
            const direct = await offer();
            if (direct !== undefined) return direct;

            const sessionId = decodeURIComponent(turnEventsMatch[1]);
            const turnId = decodeURIComponent(turnEventsMatch[2]);
            const host = await hostEx(sessionId);
            const turn = host?.turns?.find((candidate) => candidate.id === turnId);

            if (turn === undefined) return jsonOf({ error: { message: `Unknown turn ${turnId}` } }, 404);

            const events = Array.isArray(turn.events) ? turn.events : [];
            const times = Array.isArray(turn.eventTimes) ? turn.eventTimes : [];
            const limit = Math.max(
                1,
                Math.min(HARNESS_PAGE_LIMIT.max, Number(query.get('limit') ?? HARNESS_PAGE_LIMIT.default))
            );
            const offset = Math.max(0, Number.isFinite(Number(query.get('cursor'))) ? Number(query.get('cursor')) : 0);
            const window = events.slice(offset, offset + limit);
            const next = offset + window.length < events.length ? String(offset + window.length) : null;

            return jsonOf({
                limit,
                next_cursor: next,
                observed_at: nowOf(),
                revision: host?.revision ?? 1,
                turn_id: turnId,
                total_events: events.length,
                partial: false,
                items: window.map((event, index) => ({
                    index: offset + index,
                    ...(typeof times[offset + index] === 'number' ? { at: times[offset + index] as number } : {}),
                    event
                }))
            });
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

            // T48: the raw surface keeps a broken transcript in `invalidThreads`, OUTSIDE the
            // roster; the canonical roster states it ON the row. A thread the fixture calls
            // unreadable therefore joins the page with its signals (`transcript_state` +
            // `transcript_error`), which is what `view-api.ts#invalidThreadsOf` derives the
            // board's marker from — and when the roster ALREADY names that thread, the invalid
            // record's verdict wins, because a broken document is the server's statement about
            // that exact conversation.
            const broken = (host.invalidThreads ?? []) as unknown as Record<string, unknown>[];

            const page = [
                ...rows.map((row) => {
                    const invalid = broken.find((entry) => entry.id === row.id);

                    return invalid === undefined
                        ? row
                        : {
                              ...row,
                              transcriptState: 'unreadable',
                              transcriptError: invalid.error ?? 'The stored transcript could not be read.'
                          };
                }),
                ...broken
                    .filter((entry) => !rows.some((row) => row.id === entry.id))
                    .map((entry) => ({
                        id: entry.id,
                        agent: entry.agent ?? '',
                        origin: entry.origin ?? 'agent',
                        status: entry.status ?? 'idle',
                        sequence: entry.sequence ?? 0,
                        ...(entry.label === undefined ? {} : { label: entry.label }),
                        transcriptState: 'unreadable',
                        transcriptError: entry.error ?? 'The stored transcript could not be read.',
                        messageCount: 0,
                        hasTranscript: true
                    }))
            ];

            return jsonOf(pageOf(page.map(threadSummaryOf), host.revision ?? 1));
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
            // A rejected submit answers an ErrorBody; the receipt composition below would turn it
            // into a 202-shaped payload with an empty `turn_id`.
            if (failureOf(resolved, payload)) return resolved;
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
            if (failureOf(resolved, payload)) return resolved;
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
            const sessionId = decodeURIComponent(transcriptDocumentMatch[1]);
            const threadId = decodeURIComponent(transcriptDocumentMatch[2]);

            // The bytes a save just stored outrank the fixture's host document, which is the same
            // record from BEFORE the write (see `writtenTranscripts`).
            const written = writtenTranscripts.get(`${sessionId}|${threadId}`);

            if (written !== undefined) {
                return jsonOf({
                    session_id: sessionId,
                    thread_id: threadId,
                    agent: written.agent,
                    revision: written.revision,
                    transcript_state: written.state,
                    document: written.document
                });
            }

            const host = await hostEx(sessionId);
            const threads = (host?.threads ?? []) as unknown as Record<string, unknown>[];
            const thread = threads.find((candidate) => candidate.id === threadId);
            const invalid = invalidThreadOf(host, threadId);

            if (invalid !== undefined) {
                return jsonOf({
                    session_id: sessionId,
                    thread_id: threadId,
                    agent: String(invalid.agent ?? thread?.agent ?? ''),
                    revision: 1,
                    transcript_state: 'unreadable',
                    document: JSON.stringify(invalid.messages ?? [], null, 2)
                });
            }

            return jsonOf({
                session_id: sessionId,
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
                // A refused write (409 running thread, 404 unknown thread, 400 missing body) is an
                // ErrorBody the editor quotes verbatim, never a receipt.
                if (failureOf(resolved, payload)) return resolved;
                const transcript = (payload?.transcript ?? {}) as Record<string, unknown>;
                const invalid = transcript.invalid as { error?: unknown; messages?: unknown } | undefined;
                const sessionId = decodeURIComponent(transcriptMatch[1]);
                const threadId = decodeURIComponent(transcriptMatch[2]);
                const revision = (payload?.view as { revision?: number } | undefined)?.revision ?? 2;

                // Remember exactly what the server now holds, so the document/metadata/messages
                // reads the shell issues next answer the SAVED bytes (see `writtenTranscripts`).
                writtenTranscripts.set(`${sessionId}|${threadId}`, {
                    agent: String(transcript.agent ?? ''),
                    document: writtenDocumentOf(transcript),
                    state: invalid === undefined ? 'ok' : 'unreadable',
                    ...(invalid === undefined ? {} : { error: String(invalid.error ?? '') }),
                    revision
                });

                return jsonOf(
                    {
                        session_id: sessionId,
                        thread_id: threadId,
                        accepted_as: invalid === undefined ? 'transcript' : 'raw',
                        message_count: Array.isArray(transcript.messages) ? transcript.messages.length : 0,
                        revision,
                        ...(invalid === undefined
                            ? {}
                            : { invalid: { error: String(invalid.error ?? ''), stored_type: 'object' } }),
                        links: {
                            transcript: `${HARNESS_API_ROOT}/sessions/${sessionId}/threads/${threadId}/transcript`,
                            document: `${HARNESS_API_ROOT}/sessions/${sessionId}/threads/${threadId}/transcript/document`
                        }
                    },
                    resolved.status
                );
            }

            const sessionId = decodeURIComponent(transcriptMatch[1]);
            const threadId = decodeURIComponent(transcriptMatch[2]);
            const written = writtenTranscripts.get(`${sessionId}|${threadId}`);
            const host = await hostEx(sessionId);
            const threads = (host?.threads ?? []) as unknown as Record<string, unknown>[];
            const thread = threads.find((candidate) => candidate.id === threadId);
            const invalidRow = invalidThreadOf(host, threadId);

            // The metadata HEAD states the verdict the document read confirms: an unreadable
            // transcript carries the validator's message (`unreadable_reason`) and the type it found,
            // because `readTranscript` composes the editor's error line from THIS record
            // (./view-api.ts:1042). Answering `ok` for a thread the roster already calls unreadable
            // made the dialog invent a generic sentence instead of the server's.
            if (written !== undefined) {
                const parsed = safeParse(written.document);
                const messages = (Array.isArray(parsed) ? parsed : []) as Record<string, unknown>[];

                return jsonOf({
                    transcript: {
                        session_id: sessionId,
                        thread_id: threadId,
                        agent: written.agent || String(thread?.agent ?? ''),
                        transcript_state: written.state,
                        message_count: messages.length,
                        chars: written.document.length,
                        bytes: written.document.length,
                        revision: written.revision,
                        role_counts: roleCountsOf(messages),
                        ...(written.error === undefined ? {} : { unreadable_reason: written.error }),
                        ...(written.state === 'ok' ? {} : { stored_type: written.storedType ?? 'object' })
                    }
                });
            }

            const messages = (thread?.messages ?? []) as Record<string, unknown>[];

            return jsonOf({
                transcript: {
                    session_id: sessionId,
                    thread_id: threadId,
                    agent: String(thread?.agent ?? invalidRow?.agent ?? ''),
                    transcript_state: invalidRow === undefined ? 'ok' : 'unreadable',
                    message_count: messages.length,
                    chars: messages.reduce((total, entry) => total + String(entry.content ?? '').length, 0),
                    bytes: 0,
                    revision: 1,
                    role_counts: roleCountsOf(messages),
                    ...(invalidRow === undefined
                        ? {}
                        : { unreadable_reason: String(invalidRow.error ?? ''), stored_type: 'object' })
                }
            });
        }

        const messagesMatch = bare.match(/^\/sessions\/([^/]+)\/threads\/([^/]+)\/transcript\/messages$/);
        if (messagesMatch && verb === 'GET') {
            const sessionId = decodeURIComponent(messagesMatch[1]);
            const threadId = decodeURIComponent(messagesMatch[2]);
            const written = writtenTranscripts.get(`${sessionId}|${threadId}`);

            if (written !== undefined) {
                const parsed = safeParse(written.document);
                const messages = (Array.isArray(parsed) ? parsed : []) as never[];

                return jsonOf({
                    ...pageOf(messages, written.revision, null),
                    thread_id: threadId,
                    agent: written.agent,
                    transcript_state: written.state,
                    total: messages.length
                });
            }

            const host = await hostEx(sessionId);
            const threads = (host?.threads ?? []) as unknown as Record<string, unknown>[];
            const thread = threads.find((candidate) => candidate.id === threadId);
            const messages = (thread?.messages ?? []) as unknown as never[];

            return jsonOf({
                ...pageOf(messages, 1, null),
                thread_id: threadId,
                agent: String(thread?.agent ?? ''),
                transcript_state: invalidThreadOf(host, threadId) === undefined ? 'ok' : 'unreadable',
                total: messages.length
            });
        }

        const definitionMatch = bare.match(/^\/sessions\/([^/]+)\/definition$/);
        if (definitionMatch && verb === 'GET') {
            const host = await hostEx(decodeURIComponent(definitionMatch[1]));

            // T46: a record that never captured a frozen definition has NO definition to
            // serve, so the answer is the contract's ErrorBody with its status — NOT a body
            // fabricated from `host.harness`. Inventing `name: host.harness` here made every
            // legacy record look reopenable, which hid the client's own (correct) refusal to
            // describe a team it never had; `harness-delete-main.test.ts` pins that refusal.
            if (host?.harnessDefinition === undefined) {
                return jsonOf({ error: { message: `Session ${decodeURIComponent(definitionMatch[1])} has no frozen definition` } }, 404);
            }

            const definition = (host?.harnessDefinition ?? {}) as Record<string, unknown>;

            // T7b (R5/R7): the roster a conversation builds for ITSELF is part of its own frozen
            // definition on the real server — `addSessionAgent` appends the name to
            // `record.definition.agents` and a detach removes it again (src/server/sessions.ts
            // :5048-5091; src/server/api-session-agents.test.ts:341/663 pins the read). So the
            // double answers with the same fold: whatever this conversation bound or invented is
            // listed, whatever it detached is gone. Without it, the shell would POST a member and
            // the next definition read would deny that the team ever changed.
            const rosterId = decodeURIComponent(definitionMatch[1]);
            const overlay = sessionAgentOverlayOf(rosterId);
            const members = sessionMembersOf(definition, overlay);
            const primary = String(definition.primary ?? members[0] ?? '');
            const frozenModels = definition.agentModels ?? definition.agent_models;
            const frozenInstructions = storedInstructionsRaw(definition);
            const foldedModels: Record<string, string> = {
                ...(frozenModels !== undefined && typeof frozenModels === 'object'
                    ? (frozenModels as Record<string, string>)
                    : {}),
                ...overlay.models
            };
            const foldedInstructions: Record<string, string> = { ...frozenInstructions };

            for (const entry of overlay.added) {
                // A session-defined member's whole prompt is the sentence it was created with, or
                // this conversation's rewrite of it (src/server/api.ts:2788-2807) — the definition
                // read names the member, so it states the member's text too.
                const text = overlay.instructions[entry.name] ?? entry.instruction;

                if (typeof text === 'string' && text.trim().length > 0) foldedInstructions[entry.name] = text;
            }

            return jsonOf({
                definition: {
                    name: definition.name ?? host?.harness ?? '',
                    title: definition.title ?? '',
                    description: definition.description ?? '',
                    requires_endpoint: definition.requiresEndpoint ?? false,
                    primary,
                    subagents: members.filter((name) => name !== primary),
                    agents: members,
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
                    ...(Object.keys(foldedModels).length === 0 ? {} : { agent_models: foldedModels }),
                    ...(Object.keys(foldedInstructions).length === 0 ? {} : { agent_instructions: foldedInstructions }),
                    // T4: the identity-colour map rides the same re-expression. Without it a fixture that
                    // colours its FROZEN definition would answer this route with the team but never the
                    // colours, and a shell test could not tell that apart from a server that stored none.
                    ...(definition.agentColors === undefined && definition.agent_colors === undefined
                        ? {}
                        : { agent_colors: definition.agent_colors ?? definition.agentColors })
                }
            });
        }

        // -------------------------------------------------------------------
        // T7b (R5/R6/R7): the session roster and its per-agent instruction subresource.
        //
        // `GET /sessions/{id}/agents` states the live roster WITHOUT any prompt
        // (../shared/harness-api.ts:938-972); the instruction subresource states ONE member's
        // COMPLETE text (../shared/harness-api.ts:1028-1039); create answers one binding and a
        // delete answers a receipt — NONE of them states the whole team. That is why the shell
        // re-reads the definition after a roster write (./main.ts `refreshSessionDefinition`),
        // and why every route here composes from ONE per-conversation overlay
        // (`sessionAgentWrites`, declared with `definitionCache`): an added member appears in the
        // roster, in the definition and in its own instruction read, and a removed one vanishes
        // from all three.
        //
        // The refusals are the SERVER's, answered rather than invented per test: a member that
        // owns a HOST conversation cannot be detached (409 naming the ids, nothing moves) and the
        // primary never can at all (src/server/sessions.ts:5052-5074).
        //
        // Offer-first as everywhere in this adapter: a fixture that declares one of these routes
        // itself stays authoritative — its own status and body — which is how a test stages a
        // refusal the composed answer would never produce.
        const agentsListMatch = bare.match(/^\/sessions\/([^/]+)\/agents$/);

        if (agentsListMatch !== null) {
            const sessionId = decodeURIComponent(agentsListMatch[1]);
            const direct = await offer();

            if (direct !== undefined) return direct;

            const host = await hostEx(sessionId);

            if (host === undefined) return jsonOf({ error: { message: `Unknown session ${sessionId}` } }, 404);

            const definition = (host.harnessDefinition ?? {}) as Record<string, unknown>;
            const overlay = sessionAgentOverlayOf(sessionId);

            if (verb === 'POST') {
                const input = (typeof body === 'string' ? JSON.parse(body) : (body ?? {})) as Record<
                    string,
                    unknown
                >;
                const name = String(input.name ?? '').trim();

                if (name.length === 0) return jsonOf({ error: { message: 'A session agent needs a name.' } }, 400);

                if (sessionMembersOf(definition, overlay).includes(name)) {
                    return jsonOf(
                        { error: { message: `Agent "${name}" is already a member of session "${sessionId}".` } },
                        409
                    );
                }

                // A name the trusted catalogue carries BINDS that profile (its own shipped text,
                // with `model`/`instruction` as this session's overrides); any other name CREATES a
                // session-defined agent whose whole prompt is the `instruction` supplied, falling
                // back to the deterministic identity sentence the store mints for its own agent
                // (src/server/sessions.ts `addSessionAgent`, pinned by
                // src/server/api-session-agents.test.ts:671-691).
                const known = (await trustedProfilesOf())[name] !== undefined;

                overlay.added.push({
                    name,
                    profile: String(input.profile ?? name),
                    kind: known ? 'bound' : 'custom',
                    ...(typeof input.model === 'string' && input.model.trim().length > 0
                        ? { model: input.model.trim() }
                        : {}),
                    ...(typeof input.instruction === 'string' && input.instruction.trim().length > 0
                        ? { instruction: input.instruction }
                        : {})
                });

                // The create's instruction is ALSO this session's stored text for the member: a
                // bound profile gets it as a `preset.agentInstructions` entry (`instruction_source:
                // 'harness'`, src/server/api-session-agents.test.ts:226), and a session-defined one
                // gets it as its base (`customAgents`, src/server/sessions.ts). Recording it the
                // same way here is what lets a later `null` patch restore it.
                if (typeof input.instruction === 'string' && input.instruction.trim().length > 0) {
                    overlay.instructions[name] = input.instruction;
                }

                return jsonOf({ agent: sessionBindingOf(host, overlay, name, definition) }, 201);
            }

            if (verb !== 'GET') {
                return jsonOf({ error: { message: `Unsupported ${verb} /sessions/:id/agents` } }, 405);
            }

            const roster = sessionMembersOf(definition, overlay);

            return jsonOf({
                session_id: sessionId,
                total: roster.length,
                agents: roster.map((name) => sessionBindingOf(host, overlay, name, definition)),
                revision: host.revision ?? 1
            });
        }

        const sessionAgentInstructionMatch = bare.match(/^\/sessions\/([^/]+)\/agents\/([^/]+)\/instruction$/);

        if (sessionAgentInstructionMatch !== null) {
            const sessionId = decodeURIComponent(sessionAgentInstructionMatch[1]);
            const agent = decodeURIComponent(sessionAgentInstructionMatch[2]);
            const direct = await offer();

            if (direct !== undefined) return direct;

            const host = await hostEx(sessionId);

            if (host === undefined) return jsonOf({ error: { message: `Unknown session ${sessionId}` } }, 404);

            const definition = (host.harnessDefinition ?? {}) as Record<string, unknown>;
            const overlay = sessionAgentOverlayOf(sessionId);

            if (!sessionMembersOf(definition, overlay).includes(agent)) {
                return jsonOf(
                    { error: { message: `Agent "${agent}" is not a member of session "${sessionId}".` } },
                    404
                );
            }

            // `PATCH .../instruction` writes the SAME field the binding patch writes, with the
            // contract's three states: omitted = no change, a string REPLACES the whole prompt, an
            // explicit `null` restores what the binding inherits
            // (../shared/harness-api.ts:1002-1011). The answer is the read re-run, which is what
            // src/server/api.ts:2752-2768 does.
            if (verb === 'PATCH') {
                applySessionAgentPatch(overlay, agent, body);
            } else if (verb !== 'GET') {
                return jsonOf(
                    { error: { message: `Unsupported ${verb} /sessions/:id/agents/:agent/instruction` } },
                    405
                );
            }

            const text = await sessionInstructionTextOf(overlay, agent, definition);

            return jsonOf({
                session_id: sessionId,
                agent_id: agent,
                source: text.source,
                instruction: text.instruction,
                guidelines: text.guidelines,
                chars: text.instruction.length
            });
        }

        const sessionAgentMatch = bare.match(/^\/sessions\/([^/]+)\/agents\/([^/]+)$/);

        if (sessionAgentMatch !== null) {
            const sessionId = decodeURIComponent(sessionAgentMatch[1]);
            const agent = decodeURIComponent(sessionAgentMatch[2]);
            const direct = await offer();

            if (direct !== undefined) return direct;

            const host = await hostEx(sessionId);

            if (host === undefined) return jsonOf({ error: { message: `Unknown session ${sessionId}` } }, 404);

            const definition = (host.harnessDefinition ?? {}) as Record<string, unknown>;
            const overlay = sessionAgentOverlayOf(sessionId);
            const primary = String(definition.primary ?? '');

            if (!sessionMembersOf(definition, overlay).includes(agent)) {
                return jsonOf(
                    { error: { message: `Agent "${agent}" is not a member of session "${sessionId}".` } },
                    404
                );
            }

            if (verb === 'DELETE') {
                // The server's own refusals, in its own order (src/server/sessions.ts:5052-5074).
                if (agent === primary) {
                    return jsonOf(
                        {
                            error: {
                                message: `Agent "${agent}" is the primary agent of session "${sessionId}" and cannot be detached; every session needs an entry point.`
                            }
                        },
                        409
                    );
                }

                const owned = ((host.threads ?? []) as Record<string, unknown>[]).filter(
                    (thread) => thread.origin === 'host' && String(thread.agent ?? '') === agent
                );

                if (owned.length > 0) {
                    const ids = owned.map((thread) => `"${String(thread.id ?? '')}"`).join(', ');

                    return jsonOf(
                        {
                            error: {
                                message: `Agent "${agent}" still owns ${owned.length} conversation${
                                    owned.length === 1 ? '' : 's'
                                } in session "${sessionId}": ${ids}. Delete those threads before removing the agent.`
                            }
                        },
                        409
                    );
                }

                overlay.removed.push(agent);
                overlay.added = overlay.added.filter((entry) => entry.name !== agent);
                delete overlay.instructions[agent];
                delete overlay.models[agent];

                // A receipt, not the roster: the contract states what detached and leaves the
                // bounded roster read to the client (../shared/harness-api.ts:1013-1026).
                return jsonOf({
                    deleted: true,
                    agent_id: agent,
                    session_id: sessionId,
                    detached_threads: 0,
                    revision: host.revision ?? 1
                });
            }

            if (verb === 'PATCH') {
                applySessionAgentPatch(overlay, agent, body);

                return jsonOf({ agent: sessionBindingOf(host, overlay, agent, definition) });
            }

            if (verb === 'GET') return jsonOf({ agent: sessionBindingOf(host, overlay, agent, definition) });

            return jsonOf({ error: { message: `Unsupported ${verb} /sessions/:id/agents/:agent` } }, 405);
        }

        // The server-computed usage fold. Composed from the same host document as every other
        // canonical answer — with ONE difference: a fixture that declares this route stays
        // authoritative, because the fold's whole point is the figures IT chooses to report
        // (`usage` is absent when no turn reported a tally, ../shared/harness-api.ts:1358-1368,
        // and a composed answer cannot state that fact on the fixture's behalf). This is the
        // adapter's standing offer-first rule (see the lazy step/block detail above), applied to
        // the one route whose payload a shell test has to author.
        const usageMatch = bare.match(/^\/sessions\/([^/]+)\/usage$/);
        if (usageMatch && verb === 'GET') {
            const direct = await offer();

            if (direct !== undefined) return direct;

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

        // One catalogue entry's IDENTIFIED read. The list projects identity, group, tags and
        // availability, and the argument JSON Schema lives only here
        // (../shared/harness-api.ts:636-648) — which is why the tools runner must be able to ask
        // for it: without this route the runner sees a page of schema-less entries, every
        // argument template collapses to `{}` and no preset can be derived. The fixture keeps the
        // schema on its catalogue rows (core and discovered alike), so the detail is the same
        // entry re-expressed in the contract's spelling, never invented metadata.
        const toolDetailMatch = bare.match(/^\/tools\/([^/]+)$/);
        if (toolDetailMatch && verb === 'GET') {
            const name = decodeURIComponent(toolDetailMatch[1]);
            const direct = await offer();
            const directPayload = direct === undefined ? undefined : await readJson(direct);
            const declared = (directPayload?.tool ?? directPayload?.entry) as Record<string, unknown> | undefined;

            const entry: Record<string, unknown> | undefined =
                declared ??
                ((legacyItemsOf((await legacyBootOf()) ?? ({} as LegacyBootstrap), 'tools') as unknown as Record<
                    string,
                    unknown
                >[]).find((candidate) => candidate.name === name));

            if (entry === undefined) return jsonOf({ error: { message: `Unknown tool ${name}` } }, 404);

            return jsonOf({
                tool: {
                    ...entry,
                    session_bound: entry.session_bound ?? entry.sessionBound ?? false,
                    execution: entry.execution ?? { scope: 'global', manual: true }
                }
            });
        }

        // A manual tool execution, on EITHER canonical route, re-expressed as the raw twin these
        // fixtures declare (`POST {root}/tools/{id}` with `{parameters}`, plus `sessionId` for a
        // session call):
        //   POST /tools/{id}/executions                  deployment catalogue (api.ts:725)
        //   POST /sessions/{sid}/tools/{id}/executions   that session's registry (api.ts:734)
        // Both answers are the closed `ToolCallResult` (../shared/harness-api.ts:707-730), whose
        // duration figure is `duration_ms`; a fixture written against the raw surface names it
        // `durationMs`, and passing that through left the response label reading
        // "response · undefinedms". A refusal (409 mid-run, 404 unknown tool) is an ErrorBody with
        // its own status and passes through untouched, because that is what the runner quotes.
        const sessionToolExecMatch = bare.match(/^\/sessions\/([^/]+)\/tools\/([^/]+)\/executions$/);
        const globalToolExecMatch = bare.match(/^\/tools\/([^/]+)\/executions$/);
        // `null`, not `undefined`, is what a failed `match` returns; both are normalized here so
        // the branch below can ask a single question ("is this a session call?") of a single
        // value.
        const sessionExec = sessionToolExecMatch ?? undefined;
        const execName = sessionExec?.[2] ?? globalToolExecMatch?.[1];

        if (execName !== undefined && verb === 'POST') {
            // The body reaches this double as the raw `RequestInit.body` STRING (see
            // `viewAwareFetch`), so it is parsed before the argument value is lifted out of it.
            const canonical = typeof body === 'string' ? safeParse(body) : body;
            const parameters = (canonical as { parameters?: unknown } | undefined)?.parameters;
            // The session is IN the canonical path, and the raw twin takes it in the body. That
            // body is composed here, so the original `RequestInit` (whose body carries only
            // `parameters`) is replaced rather than forwarded.
            const rawBody = sessionExec === undefined ? { parameters } : { parameters, sessionId: decodeURIComponent(sessionExec[1]) };

            const response =
                sessionExec === undefined
                    ? await inner(`${root}/tools/${execName}`, innerVerb, body, context)
                    : await inner(`${root}/tools/${execName}`, innerVerb, rawBody, undefined);
            const resolved = response instanceof Promise ? await response : response;
            if (resolved === undefined) return undefined;
            const payload = await readJson(resolved);
            if (failureOf(resolved, payload)) return resolved;

            const duration = payload?.duration_ms ?? payload?.durationMs;

            return jsonOf(
                {
                    ok: payload?.ok ?? true,
                    ...(payload?.result === undefined ? {} : { result: payload.result }),
                    ...(payload?.panels === undefined ? {} : { panels: payload.panels }),
                    ...(payload?.media === undefined ? {} : { media: payload.media }),
                    ...(payload?.error === undefined ? {} : { error: payload.error }),
                    ...(duration === undefined ? {} : { duration_ms: duration })
                },
                resolved.status
            );
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
        // A pushed live frame bumps the epoch (see `bumpFixtureEpoch`): the document every
        // composition reads has moved, so the cached answers are dropped before the client's
        // next request is served.
        if (seenEpoch !== currentEpoch()) {
            seenEpoch = currentEpoch();
            clearGetMemo();
        }

        // A WRITE moves the document the next composition reads, so the fixture memo is dropped
        // before the request is dispatched: the submit's row page, the PATCH's metadata row and
        // the transcript PUT's document must all be re-read from the stub, never served stale.
        if (method !== undefined && method !== 'GET' && method !== 'HEAD') clearGetMemo();

        const path = stripOrigin(url, root);

        // T44 (fixture root cause): the canonical branch dispatches a ROUTE, and `canonicalRoutes`
        // reads `limit`/`order`/`cursor` off the path's query (`bare`/`query` below). `stripOrigin`
        // returns a PATHNAME only, so every canonical page read answered the default `order=asc`
        // at the default limit — `view-api.ascRows` then reversed an already-ascending list, the
        // board rendered newest-last, and `olderCursor` pointed at the wrong end. The query is
        // re-attached HERE, to the canonical path only: the legacy `/views` branch and the
        // fixture's own raw router keep matching the query-less pathname they always matched.
        const search = searchOf(url);

        // T17: the browser dials the canonical control plane. The canonical branch is
        // matched on BOTH the configured mount and the contract root, because a test
        // may declare its fixtures under `/api` while the client asks `/v1/harness`:
        // what matters is that the ANSWER is canonical, not which prefix the fixture
        // happened to use. Every canonical answer is composed from the SAME raw
        // snapshot through the SERVER's own projector, so a green shell test is still
        // evidence about real compiled state.
        const canonicalPath = path.startsWith(HARNESS_API_ROOT)
            ? `${path.slice(HARNESS_API_ROOT.length)}${search}`
            : stripOrigin(url, HARNESS_API_ROOT).startsWith(HARNESS_API_ROOT)
              ? `${stripOrigin(url, HARNESS_API_ROOT).slice(HARNESS_API_ROOT.length)}${search}`
              : String(url).includes(HARNESS_API_ROOT)
                // The mount IS the canonical root (a fixture that declares no `root`
                // option gets it by default), so `stripOrigin` already removed it and
                // the stripped path is the canonical route itself. Without this case
                // the canonical branch would only ever run for a NON-canonical
                // configured mount, and the migration would look like a no-op.
                ? `${stripOrigin(url, HARNESS_API_ROOT)}${search}`
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

// The query string of a request url, exactly as the client dialled it (`?limit=25&order=desc`).
// T44: `stripOrigin` below reduces a url to a PATHNAME, which is what its prefix comparisons and
// the legacy `/views` branch need; the canonical branch is a ROUTE PARSER that pages by
// `limit`/`order`/`cursor`, so it needs this half of the url back. An absolute url is read
// through `URL` so a query after the origin is found; anything unparsable has none.
const searchOf = (url: string): string => {
    const value = String(url);
    const direct = value.indexOf('?');

    if (direct >= 0) return value.slice(direct);

    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        try {
            return new URL(value).search;
        } catch {
            return '';
        }
    }

    return '';
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
//   `{type:'snapshot'}`/`{type:'failed'}` -> `session.updated` (the metadata patch), one
//                         `turn.removed`/`thread.removed` per row/conversation this document
//                         no longer names (a server-side delete the client must LEARN), then
//                         one `turn.upsert` per row of the compiled view; trees are lazy reads,
//                         so no display subtree is claimed here
export type HarnessStreamOptions = {
    // The conversation this double serves; a `session`-scope subscribe naming another id is not
    // the target. Omit to deliver to the newest subscription whatever its scope.
    sessionId?: string;
    // The host document the live fold seeds from (same source `withViewRoutes` uses).
    snapshot?: () => SessionSnapshot | undefined;
    // The LIVE record per conversation, read at frame time. A `snapshot` frame is the record
    // the REST routes must now serve, so a fixture that mutates its own store keeps the wire
    // and the re-read a `turn.removed`/`thread.removed` triggers in agreement; this getter is
    // also what the FIRST snapshot frame of a conversation is diffed against, because the
    // client read that record when it opened the conversation.
    record?: (sessionId: string) => SessionSnapshot | undefined;
    // The entry agent when the fixture's snapshot does not carry `harnessDefinition`.
    primary?: string;
    // T44: drive the CLIENT's reconnect/heartbeat timers deterministically (the same hook
    // ./stream.ts `schedule` gives a direct `createHarnessStream`). Without it a reconnect
    // test waits on real 500ms+ backoff with a random jitter, which turns an assertion into
    // a flake; the fixture captures the callback so the test fires it when it is ready.
    schedule?: (fn: () => void, ms: number) => () => void;
};

export type StreamDouble = {
    // Every frame the client sent, parsed.
    sent: Record<string, unknown>[];
    // One entry per `subscribe`, in order, with the ids the client addressed.
    subscriptions: Record<string, unknown>[];
    // Deliver one payload/item, or an ARRAY of them, each as its own frame, with the next
    // sequence and a fresh cursor for the subscription that owns it.
    push(items: unknown | readonly unknown[]): boolean;
    // End the stream: no more frames are delivered AND the socket closes (1000), so the client's
    // reconnect path runs exactly as it does against a server that ended this subscription.
    close(): void;
    // Ask the client to reconnect (a dropped socket: close 1006), keeping its resume state; the
    // fold restarts on the new connection, exactly as a new observer connection does, and pushes
    // are deliverable again once the client has re-subscribed.
    drop(): void;
    // The client's own view of the connection (./stream.ts `status()`: `connecting` / `open` /
    // `reconnecting` / `closed`), which is the only honest way to assert a disconnect happened.
    status(): string;
    socket(): { closeCode?: number };
};

// One `onclose` per connection, whatever closes it: both the fixture (`close()`/`drop()`) and the
// CLIENT (`socket.close(...)` — the heartbeat loss at ./stream.ts:331, a client `refresh` at :620,
// a manual `close()` at :598) close the same connection, and a real transport reports it exactly
// once. T44: this is the dispatch that lets a fixture drive reconnect and resync for real.
const fireClose = (
    socket: { onclose?: ((event: { code?: number }) => void) | null; closeFired?: boolean; closeCode?: number } | undefined,
    code: number
): void => {
    if (socket === undefined || socket.closeFired === true) return;

    socket.closeFired = true;
    // The code that ended the connection, whether the fixture closed it (`close`/`drop`) or the
    // client did (`socket.close(code)`) — a test asserts it.
    if (socket.closeCode === undefined) socket.closeCode = code;
    socket.onclose?.({ code });
};

export const installHarnessStream = (options: HarnessStreamOptions = {}): StreamDouble => {
    const sent: Record<string, unknown>[] = [];
    const subscriptions: Record<string, unknown>[] = [];
    // Sequence is per subscription: two subscriptions on one connection never share a counter.
    const sequences = new Map<string, number>();
    let current: (StreamSocket & { closeCode?: number; closeFired?: boolean }) | undefined;
    let closed = false;

    // One fold per connection, like the store's own watcher subscription: a reconnect (or a
    // fresh install) starts a fresh op sequence rather than continuing a stale one.
    let folds = new Map<string, LiveFold>();

    // The snapshot the stream opens with seeds the folds, so an `event` frame that arrives
    // before any `turn` frame still produces real ops (same seeding as `withViewRoutes`).
    let context: SessionSnapshot | undefined = options.snapshot?.();
    // The last document the wire described, per conversation id. A double serves whichever
    // session the client is watching, so the removal diff below is keyed, not global.
    const delivered = new Map<string, SessionSnapshot>();

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

    // T44: the connection that is DELIVERABLE right now. A socket whose `onclose` has fired is
    // gone — the client has already detached it (./stream.ts:532) and will not read another frame
    // off it — so a push in that window is queued for the reconnect instead of thrown away.
    const live = (): (StreamSocket & { closeCode?: number; closeFired?: boolean }) | undefined =>
        current === undefined || current.closeFired === true ? undefined : current;

    // T44: the subscription a frame belongs to, chosen the way the SERVER chooses it.
    // The scope table (../shared/harness-stream.ts:201) publishes `display.ops` on the `turn`
    // scope ONLY, so a fixture that pushes a flow frame has to address the turn subscription
    // that names that turn — a session subscription that happens to exist must not absorb it.
    // With no such subscription the frame still goes to the session scope: a test that never
    // opened the turn gets the same tolerant behaviour as a browser whose tile is closed,
    // and `frameOf` keeps the sequence counter of whichever subscription answers.
    const targetIdFor = (body: Record<string, unknown>): string | undefined => {
        if (body.kind === 'display.ops') {
            const turnId = body.turn_id;

            for (let index = subscriptions.length - 1; index >= 0; index -= 1) {
                const sub = subscriptions[index] as { subscription_id?: string; scope?: string; turn_id?: string };
                if (sub.scope !== 'turn') continue;
                if (turnId !== undefined && sub.turn_id !== turnId) continue;

                return sub.subscription_id;
            }
        }

        return targetId();
    };

    const write = (body: Record<string, unknown>): boolean => {
        if (closed) return false;

        const subscriptionId = targetIdFor(body);
        const socket = live();

        if (subscriptionId === undefined || socket?.onmessage === undefined || socket.onmessage === null) {
            pending.push(body);

            return false;
        }

        socket.onmessage({ data: JSON.stringify(frameOf(subscriptionId, body)) });

        return true;
    };

    const flush = (): void => {
        if (live()?.onmessage == null) return;

        while (pending.length > 0) {
            const body = pending.shift() as Record<string, unknown>;
            const subscriptionId = targetIdFor(body);

            if (subscriptionId === undefined) {
                // Still no subscription to answer it: keep it queued for the next handshake.
                pending.unshift(body);

                return;
            }

            live()?.onmessage?.({ data: JSON.stringify(frameOf(subscriptionId, body)) });
        }
    };

    // Ids the frame BEFORE this one carried and the new document no longer names, in the
    // previous frame's order (the server's delete fan-out is ordered too, so a fixture that
    // dropped two rows must publish them the same way twice).
    const droppedIdsOf = (
        previous: SessionSnapshot | undefined,
        next: SessionSnapshot | undefined,
        key: 'turns' | 'threads'
    ): string[] => {
        if (previous === undefined || next === undefined) return [];

        const alive = new Set<string>();
        for (const row of ((next[key] ?? []) as readonly { id?: string }[])) {
            if (typeof row.id === 'string') alive.add(row.id);
        }

        return [
            ...new Set(
                ((previous[key] ?? []) as readonly { id?: string }[])
                    .map((row) => row.id)
                    .filter((id): id is string => typeof id === 'string' && !alive.has(id))
            )
        ];
    };

    // A raw recorded frame -> the canonical `update` payloads it becomes on the wire.
    const updatesOf = (raw: SessionStreamItem): Record<string, unknown>[] => {
        // A `snapshot`/`failed` frame REPLACES the document it describes, and a row or
        // conversation the new document no longer names was deleted SERVER-SIDE (another tab,
        // or the API). The wire says so with `turn.removed`/`thread.removed` (../shared/
        // harness-stream.ts `WsUpdateTurnRemoved`/`WsUpdateThreadRemoved` — PURE invalidation,
        // one id, no body), which is the only thing that makes ./view-shell.ts:544 answer with
        // its window re-read. Without these bodies a fixture could never teach the client a
        // deletion it did not perform itself.
        //
        // The document to diff against is the one the wire described LAST for THAT conversation
        // (`delivered`), so a fixture that drives two sessions never invents removals by
        // comparing one session's roster with the other's. With nothing delivered yet, the
        // fixture's own record getter (`options.record`) is the document the client read at
        // open time, which is what the server's first snapshot frame is compared against.
        const replaces = raw.type === 'snapshot' || raw.type === 'failed';
        const recordId = replaces ? (raw as { session?: { id?: string } }).session?.id : undefined;
        const previous =
            (recordId === undefined ? undefined : delivered.get(recordId)) ??
            (recordId !== undefined && context?.id === recordId ? context : undefined) ??
            (recordId === undefined ? undefined : options.record?.(recordId));

        if (raw.type === 'snapshot' || raw.type === 'failed') {
            context = raw.session;
            if (recordId !== undefined) delivered.set(recordId, raw.session);
        }

        const item = toViewItem(raw, folds, context, { primary: options.primary });
        const bodies: Record<string, unknown>[] = [];

        if (item.type === 'view' || item.type === 'failed') {
            if (context !== undefined) bodies.push({ kind: 'session.updated', session: statePatchOf(context) });

            // Removals ride the SAME frame ordering the server uses: the header patch first,
            // then one pure-invalidation body per id this document no longer names, before the
            // surviving rows are re-published. `targetIdFor` sends all of them to the session
            // subscription, which is the only scope whose table (../server/stream/protocol.ts:74)
            // lists `turn.removed` and `thread.removed`.
            for (const turnId of droppedIdsOf(previous, context, 'turns')) {
                bodies.push({ kind: 'turn.removed', turn_id: turnId });
            }

            for (const threadId of droppedIdsOf(previous, context, 'threads')) {
                bodies.push({ kind: 'thread.removed', thread_id: threadId });
            }

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
        // T44: a fresh connection restarts the SEQUENCE SPACE, exactly as the real server does —
        // the `subscription_state` baseline this factory answers below is `sequence: 0`, and
        // ./stream.ts resets its gap bookkeeping on close (stream.ts:543) so a reconnect that
        // continued the old counter would read as a hundred dropped frames and force a resync.
        sequences.clear();

        // T3b: whether THIS connection has completed its handshake. A subscribe that
        // arrives before `onopen` is queued by the client and answered by the flush below;
        // one that arrives after it is answered inside `send`.
        let opened = false;

        const socket = {
            onopen: null as (() => void) | null,
            onmessage: null as ((event: { data: unknown }) => void) | null,
            onerror: null as (() => void) | null,
            onclose: null as ((event: { code?: number }) => void) | null,
            send: (data: string) => {
                const frame = JSON.parse(data) as Record<string, unknown>;
                sent.push(frame);

                if (frame.type === 'subscribe') {
                    subscriptions.push(frame);

                    // T3b: a real server answers EVERY subscribe with its
                    // `subscription_state` baseline — including one that arrives after the
                    // handshake, which is the ordinary case for a pane that mounts (or a
                    // thread the reader expands) on an already-open connection. The
                    // open-time flush below only covers the ones queued before `onopen`;
                    // without this answer the client never records the registration as
                    // ACKNOWLEDGED (`registered`, ./stream.ts:232) and a later collapse
                    // has nothing to release, so the goodbye this fixture used to observe
                    // silently disappeared.
                    if (opened && !socket.closeFired)
                        socket.onmessage?.({
                            data: JSON.stringify({
                                type: 'subscription_state',
                                subscription_id: (frame as { subscription_id: string }).subscription_id,
                                scope: (frame as { scope: string }).scope,
                                epoch: 'test-epoch',
                                sequence: 0,
                                cursor: 'cursor-0',
                                revisions: [],
                                publishes: ['turn.upsert', 'display.ops', 'session.updated']
                            })
                        });
                }
            },
            close: (code?: number) => {
                socket.closeCode = code;
                // T44: a real socket does not close silently. The peer's close fires `onclose`,
                // and ./stream.ts:528 is the ONLY thing that drives the reconnect/resync path
                // (heartbeat loss at stream.ts:331 and a client `refresh` at :620 both close THIS
                // way). Recording the code alone left the client believing it was still `open`,
                // so a disconnect/reconnect test could never observe the re-dial.
                fireClose(socket, code ?? 1000);
            },
            closeCode: undefined as number | undefined,
            // One `onclose` per connection, whatever closes it (the fixture or the client).
            closeFired: false
        };

        current = socket;
        socket.onmessage = (event) => {
            JSON.parse(String(event.data));
        };

        // Answer the handshake on the next microtask, so the caller's `subscribe`
        // has been registered before frames start arriving.
        queueMicrotask(() => {
            // T3b: snapshot the queue BEFORE the handshake flush so a registration is
            // answered exactly ONCE — the ones queued before `onopen` here, and every
            // subscribe that arrives afterwards inside `send` (the client flushes its
            // queue synchronously from `onopen`).
            const preOpen = [...subscriptions];

            opened = true;
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

            for (const sub of preOpen) {
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
    configureHarnessStream({
        socketFactory: factory,
        ...(options.schedule === undefined ? {} : { schedule: options.schedule })
    });

    return {
        sent,
        subscriptions,
        push: (items) => {
            // A pushed frame means the fixture's document MOVED (its handlers fold the frame into
            // the record every canonical composition reads), so any raw answer cached for a read
            // that starts now is stale: drop the memo before the client reacts to this frame.
            bumpFixtureEpoch();

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
            // T44: "the stream ended" is a CLOSED connection, not a silent one. The fixture stops
            // delivering (`closed` below, so a late `push` is a no-op instead of a surprise) AND the
            // socket closes for real, which is what makes the client's own reconnect/resync path
            // observable — exactly what the real server does when a session subscription ends.
            closed = true;
            fireClose(current, 1000);
        },
        drop: () => {
            // A dropped socket: the client re-dials, so this connection is over and the NEXT one
            // delivers again (`closed = false`; a fixture that wants permanent silence calls
            // `close()`). A new connection folds from scratch, and the queue is re-anchored to the
            // subscription the client resumes.
            folds = new Map<string, LiveFold>();
            closed = false;
            fireClose(current, 1006);
        },
        // T44: report the CLIENT's connection state, not the double's bookkeeping. A test that
        // drives a disconnect has to be able to see the shell notice it (`./stream.ts status()`
        // is `connecting` / `open` / `reconnecting` / `closed`), which the old
        // `current === undefined ? 'idle' : 'open'` could never show.
        status: () => harnessStream().status(),
        socket: () => ({ ...(current ?? {}) }) as { closeCode?: number }
    };
};
