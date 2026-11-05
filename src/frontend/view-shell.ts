// The shell's existing vocabulary, bound to the canonical contract (T14).
//
// ./main.ts and the `ui/` renderers were written against a small set of display
// operations: "open this conversation", "list the directory", "watch this
// conversation", "answer this question", "submit this task". Those NAMES stay,
// because they are the shell's own language and renaming them would be churn with
// no payload benefit. What changed underneath every one of them is the WIRE: each
// function below is a composition of canonical `/v1/harness` reads and receipts,
// and none of them can produce a document the contract no longer publishes.
//
// The one function worth reading carefully is `observeView`: it used to open an SSE
// request per session and receive whole `view` documents. It now registers a scoped
// subscription on the ONE shared `harness.v1` socket (./stream.ts) and translates
// bounded frames into the same callback vocabulary — a `turn.upsert` becomes one
// row op, a `display.ops` becomes projected ops, and an invalidation or a gap
// becomes a re-read of the LOADED WINDOW, never a history snapshot. Aborting it
// unsubscribes; it never cancels a task (rule 7 of ./stream.ts).
import { HARNESS_ROUTES } from '../shared/harness-api';
import type {
    ActionChoiceInput,
    PendingAction,
    RunnerSettingsInput,
    SessionSummary,
    TaskReceipt
} from '../shared/harness-api';
import type { HarnessActionChoice } from '../types';
// The shell's OWN provider record (camelCase). Type-only import, the same convention
// ./main.ts:96-109 already follows for `../server/protocol`.
import type { RunnerSettings } from '../server/protocol';
import type { TurnDisplay, TurnDisplayOp, TurnSummary } from '../shared/turn-display';
import {
    answerAction,
    apiUrl,
    getSession,
    listSessions,
    listTurns,
    putTranscriptDocument
} from './api';
import { projectDisplay, projectRow, projectStep } from './display-project';
import {
    ascRows,
    createDisplayLoader,
    createSessionView,
    invalidThreadsOf,
    loadOlderTurns,
    openSession,
    prependTurns,
    patchSessionView,
    projectOps,
    readActions,
    readBlockDetail,
    sessionPatchViewOf,
    readRawTurns,
    readStepDetail,
    readTranscript,
    removeConversation,
    removeConversationOnUnload,
    removeThread,
    resetConversation,
    rowFromReceipt,
    // T38: THE directory row normalizer (./view-api.ts:159). `listViews` and the boot
    // document's embedded page both map through it, so a row is one camelCase record.
    sessionRowOf,
    stopConversation,
    stopThread,
    submitConversationTask,
    threadRowOf,
    type CreateSessionInput,
    type DisplayLoader,
    type SessionView,
    type SubmitInput,
    type TurnRowView
} from './view-api';
import { harnessStream } from './stream';
import type { StreamSubscription } from './stream';
import type {
    WsResyncRequired,
    WsUpdate,
    WsUpdateDisplayOps,
    WsUpdateSession,
    WsUpdateTurnUpsert
} from '../shared/harness-stream';
import type { ThreadTranscriptPayload } from './view-model';


// ---------------------------------------------------------------------------
// Directory
// ---------------------------------------------------------------------------

// `GET /sessions?limit=25` mapped into the rail's row shape. The rail renders
// metadata + counters, which is exactly what a session ROW is; it never needs turns
// or display trees, so the directory is a constant-size read per page. One mapper with
// the boot document's embedded page (`sessionRowOf`, ./view-api.ts:159) — both sources of
// the directory therefore produce the same camelCase record, and neither is cast.
export const listViews = async (): Promise<SessionView[]> => {
    const page = await listSessions();

    return page.items.map(sessionRowOf);
};


// ---------------------------------------------------------------------------
// Open / create / patch
// ---------------------------------------------------------------------------

// Opening a conversation is the windowed composition in `openSession`: metadata +
// the newest 25 rows + one roster page + the pending questions, and display trees
// only for the tail that paints.
export const getView = (sessionId: string): Promise<SessionView> => openSession(sessionId);

// Total camelCase → snake_case mapping of the provider settings block. Every field is
// sent even when blank: `api_key: ''` is what the server already accepts as "no key"
// (../server/api.ts:553-556), and an omitted `model` is what makes the SERVER fall back
// to its advertised default (main.ts:438-450), so a blank string keeps the current
// behaviour rather than silently changing it.
const settingsInputOf = (settings: RunnerSettings): RunnerSettingsInput => ({
    base_url: settings.baseURL,
    api_key: settings.apiKey,
    model: settings.model
});

// `POST /sessions` — the settings the shell edits in its own camelCase record
// (`RunnerSettings`, ../server/harnesses/types.ts:18-22: `baseURL`/`apiKey`/`model`)
// while the contract's create body is snake_case (`RunnerSettingsInput`,
// ../shared/harness-api.ts:369-373). The server REJECTS any other spelling with 400:
// `requireKnownFields` (../server/api.ts:504-510) runs over the `settings` allow-list
// `base_url, api_key, model` (../server/api.ts:544) before a session is created, so a
// camelCase body fails the FIRST submit of every new conversation with
// `Unknown field 'baseURL'. Allowed fields: base_url, api_key, model.`
//
// This is the one rename, exactly like `updateView`'s `agentModels → agent_models`
// (:145-154) and `choiceInputOf`'s `optionId → option_id` (:199): no renderer or call
// site in ./main.ts has to know which plane the wire is on.
//
// WHY THE PARAMETER IS THE DOMAIN RECORD AND NOT THE WIRE TYPE: `RunnerSettingsInput`
// is all-optional, i.e. a TypeScript WEAK TYPE, and a non-literal argument skips the
// excess-property check. That is why main.ts:9540 and main.ts:5137 could hand the
// camelCase record straight through this signature and still compile. `RunnerSettings`
// requires all three fields, so the wrong plane's record is now a COMPILE error
// (missing `baseURL`/`apiKey`) instead of a runtime task failure — the same reasoning
// recorded at main.ts:6474-6487 for the `agent_models` bug.
export const createView = (harness: string, settings?: RunnerSettings): Promise<SessionView> =>
    createSessionView({ harness, ...(settings === undefined ? {} : { settings: settingsInputOf(settings) }) });

// The shell patches the live model map in camelCase (`agentModels`, its own render
// spelling). The contract's field is `agent_models`; this is the one rename.
export const updateView = async (
    sessionId: string,
    input: { agentModels?: Record<string, string>; title?: string | null }
): Promise<SessionView> =>
    patchSessionView(sessionId, {
        ...(input.agentModels === undefined ? {} : { agent_models: input.agentModels }),
        ...(input.title === undefined ? {} : { title: input.title })
    });

export const resetView = async (sessionId: string): Promise<SessionView> => {
    // A reset discards everything the window holds, so the honest post-write
    // document is a fresh window — one metadata read plus an empty rows page, which
    // the receipt's revision already proves is current.
    await resetConversation(sessionId);

    return openSession(sessionId, { visibleTurns: 0, includeActions: true });
};

export const cancelView = (sessionId: string, all = true): Promise<boolean> =>
    stopConversation(sessionId, all).then((result) => result.cancelled);

export const deleteView = (sessionId: string): Promise<void> => removeConversation(sessionId).then(() => undefined);

export const deleteViewOnUnload = (sessionId: string): Promise<void> =>
    removeConversationOnUnload(sessionId).then(() => undefined);

// A thread stop/delete answers a receipt naming what moved. The shell reconciles by
// re-reading the roster and the rows it shows, which is bounded; it does not
// re-download the conversation's history to learn a card disappeared.
export const cancelViewThread = async (sessionId: string, threadId: string): Promise<{ cancelled: boolean; view: SessionView }> => {
    const result = await stopThread(sessionId, threadId);

    return { cancelled: result.cancelled, view: await refreshRoster(sessionId) };
};

export const deleteViewThread = async (sessionId: string, threadId: string): Promise<{ deleted: true; view: SessionView }> => {
    await removeThread(sessionId, threadId);

    return { deleted: true, view: await refreshRoster(sessionId) };
};

// Roster + rows + actions, without display trees: the cheapest document that is
// still complete for a mutation that changes which cards exist.
const refreshRoster = (sessionId: string): Promise<SessionView> => openSession(sessionId, { visibleTurns: 0 });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// The composer answers with either an option id or free text. `HarnessActionChoice`
// is the domain spelling (`{ kind: 'option', optionId }` / `{ kind: 'custom', text }`);
// the contract's request spelling is snake_case (`option_id`). One mapping, here,
// so no renderer ever has to know which plane it is on.
export const choiceInputOf = (choice: HarnessActionChoice): ActionChoiceInput =>
    choice.kind === 'option' ? { kind: 'option', option_id: choice.optionId } : { kind: 'custom', text: choice.text };

export const answerViewAction = (
    sessionId: string,
    requestId: string,
    choice: HarnessActionChoice
): Promise<boolean> => answerAction(sessionId, requestId, choiceInputOf(choice));

// The pending questions, in the shape the cards render (the contract's
// `PendingAction` already carries the recorded request plus its routing fields).
export const pendingActionsOf = (sessionId: string): Promise<PendingAction[]> => readActions(sessionId);

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

// The 202 answer is a RECEIPT and NOTHING ELSE: identity, placement, the moved session
// revision and the queue position (../shared/harness-api.ts `TaskReceipt`). It used to be
// dressed up as a document, which cost a second full round trip per task and let a
// whole-document apply erase the rows, the model map and the frozen team the receipt does
// not carry. `turn` is the paint-only row `rowFromReceipt` builds — the stream's
// `turn.upsert` is what replaces it — and the session-level figures travel through the
// shell's own in-place patch (./main.ts `applyReceiptRow`).
export type SubmitTaskViewResult = {
    turn: TurnRowView;
    steered?: true;
    steeredThreadId?: string;
    receipt: TaskReceipt;
};

export const submitViewTask = async (
    sessionId: string,
    input: string,
    attachments?: SubmitInput['attachments'],
    references?: SubmitInput['references'],
    threadId?: string
): Promise<SubmitTaskViewResult> => {
    const receipt = await submitConversationTask(sessionId, {
        input,
        ...(attachments === undefined ? {} : { attachments }),
        ...(references === undefined ? {} : { references }),
        ...(threadId === undefined ? {} : { threadId })
    });

    return {
        turn: rowFromReceipt(receipt, input),
        ...(receipt.steered === true ? { steered: true } : {}),
        ...(receipt.steered_thread_id === undefined ? {} : { steeredThreadId: receipt.steered_thread_id }),
        receipt
    };
};

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export const getThreadTranscript = (sessionId: string, threadId: string): Promise<ThreadTranscriptPayload> =>
    readTranscript(sessionId, threadId);

// The whole-document PUT with the editor's revision guard. The receipt states what
// was accepted (`transcript` or `raw`), the new revision, and — when the user's
// JSON is structurally broken — the validator's message. No view document travels
// with a transcript save any more.
export const updateThreadTranscript = async (
    sessionId: string,
    threadId: string,
    messages: unknown,
    ifRevision?: number
): Promise<{ receipt: Awaited<ReturnType<typeof putTranscriptDocument>>; transcript: ThreadTranscriptPayload }> => {
    const receipt = await putTranscriptDocument(sessionId, threadId, messages, ifRevision);

    return { receipt, transcript: await readTranscript(sessionId, threadId) };
};

// ---------------------------------------------------------------------------
// The display plane (T21 items 1-2): the shell's lazy-tree + load-older policy
// ---------------------------------------------------------------------------

// One conversation's "which trees does the reader need" engine. It is a separate
// helper rather than inline shell code for two reasons: the policy is the part a
// test must pin (concurrency, dedupe, stale-cancel, prepend-then-pump), and every
// caller that shows rows — open, ops frame, scroll, expand, older page — must use
// the SAME queue instead of each starting its own fetch-all.
//
// The rules it enforces, in order:
//   - a row with a tree is never re-requested (cache), a row whose tree failed is
//     never re-requested in this generation (no loop on a deleted turn);
//   - at most `concurrency` (default 4) reads are in flight, so a 25-row window
//     drains in bounded batches and never fans out 25 requests;
//   - rows are requested NEWEST FIRST, because that is what the reader sees first;
//   - `invalidate()` runs whenever the document being painted is a different
//     conversation or a newer generation of the same one: an answer that arrives
//     after that belongs to nothing and is discarded, never painted;
//   - `loadOlder()` is the ONLY way history grows, and it walks the cursor the
//     server issued — no page is fetched that the reader did not ask for.
export type DisplayPlane = {
    // Pumps every row that still needs a tree. Returns the ids it started.
    // `turnIds` (T24) narrows the request to the rows the READER can actually see:
    // pass the on-screen/expanded ids and every other row stays unloaded until it is
    // scrolled to. Omit it to pump the whole loaded window (a pane with no viewport
    // filter), which is the pre-T24 behaviour and stays the default.
    ensureVisible(turnIds?: readonly string[]): string[];
    // Walks one older page. Resolves false at the beginning of history (no cursor)
    // or when a stale guard rejected the answer.
    loadOlder(): Promise<boolean>;
    // True while an older page is in flight (the button is disabled, not hidden).
    loadingOlder(): boolean;
    // False when the whole window is loaded (hide the affordance, do not offer it).
    hasOlder(): boolean;
    // The conversation switched / a newer document replaced the window.
    invalidate(): void;
    // A reset or delete emptied the rows: forget the cache, keep the generation.
    reset(): void;
    // The turn the reader is looking at (expanded tile), for a focused subscription.
    focusedTurn(): string | undefined;
    setFocusedTurn(turnId: string | undefined): void;
};

export type DisplayPlaneOptions = {
    // The conversation this plane is showing right now. Read per call, because the
    // shell reuses one pane across selections and a captured id would paint another
    // session's tree onto these rows.
    sessionId: () => string;
    // The live document, or undefined while none is open.
    document: () => SessionView | undefined;
    // Repaint after a tree landed or an older page was prepended. The board keeps
    // its own expansion state, so a repaint does not collapse what the reader opened.
    repaint: () => void;
    concurrency?: number;
    // Overridable for tests; defaults to the canonical per-turn tree read.
    fetch?: (sessionId: string, turnId: string) => Promise<TurnDisplay>;
};

export const createDisplayPlane = (options: DisplayPlaneOptions): DisplayPlane => {
    let loader = createDisplayLoader(options.sessionId(), {
        concurrency: options.concurrency,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch })
    });

    let sessionOfLoader = options.sessionId();
    let loadingOlderPage = false;
    let focused: string | undefined;

    const syncLoader = (): DisplayLoader => {
        const current = options.sessionId();

        // A selection change is a new generation: the in-flight trees of the
        // conversation the reader left must not land on these rows.
        if (current !== sessionOfLoader) {
            sessionOfLoader = current;
            loader = createDisplayLoader(current, {
                concurrency: options.concurrency,
                ...(options.fetch === undefined ? {} : { fetch: options.fetch })
            });
        }

        return loader;
    };

    // Named so `loadOlder` can re-enter the pump after a prepend (an arrow object
    // literal has no `this`, and a second queue would break the concurrency cap).
    const plane: DisplayPlane = {
        ensureVisible: (turnIds) => {
            const document = options.document();
            if (document === undefined) return [];

            const active = syncLoader();

            // T24: the caller names the rows it can see, so a 25-row window that is
            // scrolled to the tail costs 3 reads, not 25. `undefined` keeps the old
            // "everything loaded" policy. Ids the document does not hold are ignored
            // (a stale scroll event cannot request a row that is not on screen).
            const only = turnIds === undefined ? undefined : new Set(turnIds);
            const missing = document.turns
                // Newest first: the tail is what the reader sees without scrolling.
                .filter((row) => document.displays[row.id] === undefined && !active.tracked(row.id))
                .filter((row) => only === undefined || only.has(row.id))
                .reverse()
                .map((row) => row.id);

            if (missing.length === 0) return [];

            const generation = active.generation();

            for (const turnId of missing) {
                void active.load(turnId).then((tree) => {
                    const live = options.document();

                    // Stale guard: superseded generation, or a window that has since
                    // moved past this row. Either way the answer applies to nothing.
                    if (tree === undefined || live === undefined || active.generation() !== generation) return;
                    if (live.turns.every((row) => row.id !== turnId)) return;

                    live.displays[turnId] = tree;
                    options.repaint();

                    // One arrival exposes nothing new, but a repaint that adopted a
                    // tree is cheap and keeps the queue's batching visible.
                });
            }

            return active.pump(missing);
        },

        loadOlder: async () => {
            const document = options.document();
            const cursor = document?.olderCursor;

            if (document === undefined || loadingOlderPage) return false;
            if (cursor === null || cursor === undefined || cursor.length === 0) return false;

            const sessionId = document.id;
            loadingOlderPage = true;

            try {
                const page = await loadOlderTurns(sessionId, cursor, { visibleTurns: 0 });

                // Stale guard: the reader switched conversation while this page was
                // in flight, so its rows belong to a window nobody is looking at.
                if (options.sessionId() !== sessionId || options.document()?.id !== sessionId) return false;

                prependTurns(document, page);
                options.repaint();
                plane.ensureVisible();
                // same bounded queue (item 1 — older rows must not stay blank).
                plane.ensureVisible();

                return true;
            } finally {
                loadingOlderPage = false;
            }
        },

        loadingOlder: () => loadingOlderPage,

        hasOlder: () => {
            const cursor = options.document()?.olderCursor;

            return cursor !== undefined && cursor !== null && cursor.length > 0;
        },

        invalidate: () => {
            loader.invalidate();
        },

        reset: () => {
            loader.reset();
        },

        focusedTurn: () => focused,

        setFocusedTurn: (turnId) => {
            focused = turnId;
        }
    };

    return plane;
};

// ---------------------------------------------------------------------------
// Observation (the WebSocket plane)
// ---------------------------------------------------------------------------

// The frame vocabulary the shell already handles. `view` is a WINDOWED document (a
// resync re-read, never a snapshot), `ops` is one projected frame, and `header` is a
// SESSION-LEVEL patch — status, queue depth, model map, last error, pending actions —
// over the document the instance already renders.
//
// T44: `header` is deliberately NOT a `view`. A `SessionResource` carries counters and no
// rows, and a document applied by the shell is AUTHORITATIVE for rows (`applyView` rebuilds
// the record cache from `session.turns` and tombstones every id it no longer names), so a
// metadata-only read published as a document wiped a running board. `session.updated`
// carries no rows by contract (../shared/harness-api.ts `SessionStatePatch`: "No turns,
// threads, transcripts, events, or definition data"), so nothing may treat it as one.
export type ViewStreamItem =
    | { type: 'view'; view: SessionView }
    | { type: 'header'; view: SessionView }
    | { type: 'ops'; turnId: string; at: number; ops: TurnDisplayOp[] }
    | { type: 'failed'; error: { message: string }; view: SessionView };

export type ObserveOptions = {
    // Ask the server to pace this subscription (`pace: 'ack'`), which is what a
    // background tab should do so its replay buffer stays bounded.
    pace?: 'ordered' | 'ack';
    // Opt in to the verbatim `run.event` frames (the raw-transcript pane only).
    events?: boolean;
};

// One subscription on the shared socket for one conversation.
//
// Frame → callback mapping (each is a bounded payload by contract):
//   `turn.upsert`        → one `ops` frame carrying the `{op:'turn'}` row patch
//   `display.ops`        → one `ops` frame with the ops projected through
//                          ./display-project.ts (never handed over raw)
//   `turn.removed`       → a window re-read: a row the client held is gone, and the
//                          rows page is the cheapest truth
//   `session.updated`    → a `header` item (session facts onto the live document) —
//                          NEVER a `view`: a patch carries no rows, and a `view` is
//                          authoritative for them (T44)
//   `thread.upsert`/
//    `thread.removed`    → a roster re-read
//   `action.opened`/
//    `action.closed`     → an actions re-read (a question gates the composer)
//   `resync_required` /
//   a detected gap       → a re-read of the loaded window, per the resources the
//                          frame names
//
// A frame naming a turn this client is not showing is ignored by the reducers
// downstream (./view-state.ts drops an op whose turn it never adopted), which is
// what makes one session subscription cheap for several panes.
export const observeView = async (
    sessionId: string,
    onItem: (item: ViewStreamItem) => void,
    signal: AbortSignal,
    options: ObserveOptions = {}
): Promise<void> => {
    const client = harnessStream();

    // A host with no WebSocket at all stays correct: the caller's bounded-poll path
    // is the degraded observation, and this promise resolves immediately instead of
    // opening an SSE fallback the contract removed.
    if (client.status() === 'closed' && typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
        return;
    }

    let sub: StreamSubscription | undefined;
    let settle: () => void = () => undefined;

    const done = new Promise<void>((resolve) => {
        settle = resolve;
    });

    const reRead = async (): Promise<void> => {
        try {
            onItem({ type: 'view', view: await openSession(sessionId, { visibleTurns: 0 }) });
        } catch {
            // A failed re-read is an observation problem, not a task failure; the
            // next frame or the caller's poll path recovers it.
        }
    };

    const applyUpdate = (update: WsUpdate): void => {
        if (update.kind === 'turn.upsert') {
            const frame = update as WsUpdateTurnUpsert;
            const row = projectRow(frame.turn);

            onItem({ type: 'ops', turnId: row.id, at: frame.at, ops: [{ op: 'turn', turnId: row.id, summary: row }] });

            return;
        }

        if (update.kind === 'display.ops') {
            const frame = update as WsUpdateDisplayOps;
            const ops = projectOps(frame.ops as TurnDisplayOp[], frame.turn_id);

            if (ops.length > 0) onItem({ type: 'ops', turnId: frame.turn_id, at: frame.at, ops });

            return;
        }

        if (update.kind === 'session.updated') {
            // The frame's OWN payload is the metadata patch (../shared/harness-api.ts
            // `SessionStatePatch`: status, queue depth, the live model map, the last error).
            // Renaming it into the render model is the whole job, so this is painted directly:
            // a re-read of `GET /sessions/:id` costs a request the frame did not ask for and,
            // when that route is refused or answers an older document, drops the frame — which
            // left a streamed failure with no session note and a drained queue with a stale one.
            //
            // Rows and trees are untouched by a header patch, so this is a `header` item and
            // NOT a document: the instance keeps the rows it already holds and takes only the
            // session-level facts (T44 — a `{...view, turns: []}` document emptied the board
            // mid-run, because `applyView` rebuilds the records from `session.turns`).
            onItem({ type: 'header', view: sessionPatchViewOf((update as WsUpdateSession).session) });

            return;
        }

        if (update.kind === 'turn.removed' || update.kind === 'thread.upsert' || update.kind === 'thread.removed') {
            void reRead();

            return;
        }

        if (update.kind === 'action.opened' || update.kind === 'action.closed') {
            void readActions(sessionId)
                .then((actions) => {
                    // T44: a pending-action list is a session-level fact, not a document —
                    // the same zero-row wipe the `session.updated` document caused.
                    onItem({ type: 'header', view: { ...sessionStub(sessionId), actions } });
                })
                .catch(() => undefined);

            return;
        }

        // `usage.updated`, `transcript.updated`, `*.registry_updated`,
        // `catalogue.updated`, `config.updated`: a pane that is showing the affected
        // resource re-reads it itself (./main.ts and the panels own those reads), so
        // the observer forwards nothing. Message bodies never ride the stream.
    };

    sub = client.subscribe({
        scope: 'session',
        sessionId,
        ...(options.pace === undefined ? {} : { pace: options.pace }),
        ...(options.events === true ? { filters: { events: true } } : {}),
        onState: () => {
            // The baseline is the anchor, not a document: the shell already opened
            // the window over REST, so nothing is fetched on registration.
        },
        onUpdate: applyUpdate,
        onResync: (frame: WsResyncRequired) => {
            // Re-read ONLY what the frame names, as bounded pages. With no resource
            // list (a client-detected gap) the loaded window is the thing to refresh.
            void reRead();
            void frame;
        },
        onError: () => {
            // A refused subscription is reported once and the caller's bounded polling
            // takes over; it never cancels the run.
            settle();
        }
    });

    // T50: an UNDELIVERABLE connection settles here, so the caller's bounded-read path starts
    // instead of freezing on the last painted document. `stream.ts:459-467` reports `closed`
    // when the client has no transport to dial (no socket factory: a bare host, a blocked
    // upgrade, a page that tore the plane down), and `subscribe` dials synchronously, so this
    // is the only state that can tell the caller "nothing will ever arrive on this
    // subscription". The early return above (:485) is the same answer for a host with no
    // `WebSocket` constructor at all; a client that has the constructor and no transport still
    // has to be answered, which is what this closes. `unsubscribe` keeps the client's
    // subscription set clean; a closed client has no socket to write the goodbye to.
    if (client.status() === 'closed') {
        sub.unsubscribe();
        settle();

        return done;
    }

    if (signal.aborted) {
        sub.unsubscribe();
        settle();

        return done;
    }

    signal.addEventListener(
        'abort',
        () => {
            // Unsubscribe only. Execution is server-owned, so switching a view,
            // closing a tab or losing the socket never stops a task.
            sub?.unsubscribe();
            settle();
        },
        { once: true }
    );

    return done;
};

// ---------------------------------------------------------------------------
// The focused turn (the ONLY scope that publishes `display.ops`)
// ---------------------------------------------------------------------------

// T24: the per-turn op stream is addressed, not broadcast. The contract's scope
// table (../shared/harness-stream.ts:201 and harness.swagger.yaml:2429) states which
// kinds each scope publishes: `session` covers session/turn/action/usage/thread/
// registry/run kinds and `turn` publishes `display.ops`, `usage.updated` and
// `turn.upsert`. A text delta is a `display.ops` frame, so a shell that subscribes
// ONLY at session level sees rows appear but never their streamed flow — which is
// exactly the blank-transcript defect this subscription closes.
//
// One subscription per EXPANDED tile, therefore: the flow a reader is looking at is
// the flow worth streaming. Rows that are merely on screen get their tree from the
// display plane's bounded read (./view-api.ts `createDisplayLoader`), and the
// session subscription above keeps the rows themselves live.
export type ObserveTurnOptions = {
    // A detected gap or a server `resync_required` on THIS subscription. The turn's
    // own tree is the recovery payload, so the shell re-reads it (bounded, one call);
    // forwarding a whole window re-read here would repeat what `observeView` already
    // does for the session scope.
    onResync?: (turnId: string) => void;
};

export const observeTurn = async (
    sessionId: string,
    turnId: string,
    onItem: (item: ViewStreamItem) => void,
    signal: AbortSignal,
    options: ObserveTurnOptions = {}
): Promise<void> => {
    const client = harnessStream();

    // Same degradation as `observeView`: no socket in this host means no live flow,
    // and the caller's bounded reads/poll path stay correct.
    if (client.status() === 'closed' && typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
        return;
    }

    let settle: () => void = () => undefined;

    const done = new Promise<void>((resolve) => {
        settle = resolve;
    });

    const sub = client.subscribe({
        scope: 'turn',
        sessionId,
        turnId,
        onUpdate: (update: WsUpdate) => {
            // `display.ops` and `turn.upsert` only. Every other kind is already
            // delivered on the session subscription, and applying it twice would
            // double-patch the store.
            if (update.kind === 'display.ops') {
                const frame = update as WsUpdateDisplayOps;
                const ops = projectOps(frame.ops as TurnDisplayOp[], frame.turn_id);

                if (ops.length > 0) onItem({ type: 'ops', turnId: frame.turn_id, at: frame.at, ops });

                return;
            }

            if (update.kind === 'turn.upsert') {
                const frame = update as WsUpdateTurnUpsert;
                const row = projectRow(frame.turn);

                onItem({ type: 'ops', turnId: row.id, at: frame.at, ops: [{ op: 'turn', turnId: row.id, summary: row }] });
            }
        },
        onResync: () => {
            options.onResync?.(turnId);
        },
        onError: () => {
            // A refused/failed turn subscription costs the reader its live flow and
            // nothing else; the session plane still carries the rows.
            settle();
        }
    });

    if (signal.aborted) {
        sub.unsubscribe();
        settle();

        return done;
    }

    signal.addEventListener(
        'abort',
        () => {
            // Leaving a tile closes its flow only: never cancels a task.
            sub.unsubscribe();
            settle();
        },
        { once: true }
    );

    return done;
};

// A minimal header stub for a frame that only changes the pending-action list. It is
// applied as a `header` patch (T44), so the rows this client already holds survive it —
// a card answer repaints without a rows read, and without a rows wipe.
const sessionStub = (sessionId: string): SessionView => ({
    id: sessionId,
    harness: '',
    status: 'idle',
    model: '',
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    displays: {},
    olderCursor: null
});

// ---------------------------------------------------------------------------
// Raw export (opt-in, paged)
// ---------------------------------------------------------------------------

// The composed document the JSON transcript quotes: the session header, the rows
// (metadata + verbatim prompt for the named turns) and each turn's verbatim recorded
// events, every one from its own bounded page. Explicit user action only (the export
// dialog), never a render path — and it composes pages instead of asking the server
// for an aggregate it no longer publishes.
//
// The return is typed as the shell's existing snapshot parameter
// (`ui/thread-transcript.ts` quotes `SessionSnapshot`), assembled from canonical
// reads. The cast at the end is nominal only: every field the builder needs is
// composed above, and the remaining protocol fields (`threads[].messages`) are the
// transcript documents, which the caller reads through this same function.
export const getRawSession = async (
    sessionId: string,
    turnIds?: readonly string[]
): Promise<import('../server/protocol').SessionSnapshot> => {
    const [session, page, roster] = await Promise.all([
        getSession(sessionId),
        turnIds === undefined || turnIds.length === 0
            ? listTurns(sessionId, { limit: 100, order: 'desc' })
            : Promise.resolve(undefined),
        import('./api').then((api) => api.listThreads(sessionId, { limit: 100 }))
    ]);

    const rows = page === undefined ? [] : ascRows(page);
    const ids = turnIds === undefined || turnIds.length === 0 ? rows.map((row) => row.id) : [...new Set(turnIds)];

    // The transcript DOCUMENTS ride the same read, because the dialog this document feeds
    // renders `threads[].messages` (ui/thread-transcript.ts `buildThreadTranscriptJson`) and
    // the roster row carries only transcript SIGNALS. Bounded by the roster page it walks,
    // concurrent because the documents are independent identified reads, and failure-tolerant:
    // a thread whose document is unreadable keeps its roster row (and the `invalidThreads`
    // marker the roster already states) rather than failing the whole export.
    const [rawTurns, documents] = await Promise.all([
        readRawTurns(sessionId, ids),
        Promise.allSettled(roster.items.map((row) => readTranscript(sessionId, row.id)))
    ]);

    // A thread id -> the transcript payload read for it. Kept whole (not just `messages`)
    // because an UNREADABLE transcript carries its stored bytes in `invalid.raw`, and the
    // editor quotes those verbatim — the roster row alone states only the verdict.
    const transcripts = new Map<string, Awaited<ReturnType<typeof readTranscript>>>();
    documents.forEach((result, index) => {
        if (result.status === 'fulfilled') transcripts.set(roster.items[index].id, result.value);
    });

    // The stored value behind an unreadable transcript, parsed back out of the document text so
    // the editor shows the JSON the server kept rather than the placeholder roster row.
    const storedValueOf = (threadId: string): unknown => {
        const raw = transcripts.get(threadId)?.invalid?.raw;

        if (raw === undefined) return undefined;

        try {
            return JSON.parse(raw);
        } catch {
            // A non-JSON document (the server accepted it as raw data) is quoted as its text.
            return raw;
        }
    };

    const rosterRows = roster.items.map(threadRowOf);

    return {
        id: session.id,
        harness: session.harness,
        status: session.status,
        model: session.model,
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        ...(session.agent_models === undefined ? {} : { agentModels: { ...session.agent_models } }),
        ...(session.last_error === undefined ? {} : { lastError: session.last_error }),
        turns: rawTurns as unknown as import('../server/protocol').SessionTurn[],
        threads: roster.items.map((row) => ({
            ...threadRowOf(row),
            // The transcript's committed messages, read above through `readTranscript` per
            // thread: the document belongs on the thread the dialog is about to open, and the
            // roster row alone carries only its signals.
            messages: transcripts.get(row.id)?.messages ?? []
        })) as unknown as import('../server/protocol').SessionThread[],
        threadViews: rosterRows as unknown as import('../server/protocol').SessionThreadView[],
        // The break, with its bytes: `invalidThreadsOf` derives the verdict from the roster row,
        // and the document read supplies the value the editor quotes (`messages`).
        invalidThreads: invalidThreadsOf(rosterRows).map((entry) => ({
            ...entry,
            messages: storedValueOf(entry.id)
        })) as unknown as import('../server/protocol').SessionInvalidThread[]
    } as unknown as import('../server/protocol').SessionSnapshot;
};

// ---------------------------------------------------------------------------
// Lazy detail re-exports (unchanged semantics, canonical routes)
// ---------------------------------------------------------------------------

export const getStepDetail = readStepDetail;
export const getBlockDetail = readBlockDetail;

// The stream URL the socket dials, re-exported for the diagnostics pane.
export const streamUrl = (): string => apiUrl(HARNESS_ROUTES.stream());

// The display helpers the shell's paging seam uses.
export { loadOlderTurns, projectDisplay, projectStep };
