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
    resumeThread,
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
    // T3: the per-thread transcript plane (./view-api.ts `createThreadTranscriptLoader`)
    // and the roster row a `thread.upsert` frame patches in place.
    type ThreadRow,
    type TurnRowView
} from './view-api';
import { harnessStream } from './stream';
import type { StreamSubscription } from './stream';
import type {
    WsResyncRequired,
    WsUpdate,
    WsUpdateDisplayOps,
    WsUpdateSession,
    WsUpdateThreadUpsert,
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
// the newest 25 rows + one roster page + the pending questions.
//
// R2 (the display-read flood): `visibleTurns: 0`, so a document read fetches ROWS ONLY
// and NO display tree. This function is the document read of EVERY re-read path — the
// 1 s bounded poll (`main.ts` `pollSession`), `resyncSession`, the shell's session open,
// the transcript/save freshness reads — and it used to re-download the newest
// `MAX_VISIBLE_DISPLAYS_PER_OPEN` trees on each call: a steady-state poll therefore
// issued one identical `GET .../turns/:id/display` per painted turn per second, which is
// the log flood this fix removes. The per-instance display loader
// (`createDisplayPlane` below, driven by the pane's `reveal()` → `ensureVisible`) is now
// the SOLE display fetcher: it is capped at 4 concurrent reads, deduped per turn id,
// generation-guarded and never retried, and it only asks for rows the reader can SEE.
// Same `visibleTurns: 0` the stream's own window re-read already passes (:582).
export const getView = (sessionId: string): Promise<SessionView> =>
    openSession(sessionId, { visibleTurns: 0 });

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

// T4/R2: the resume half of the same pair. A stopped conversation answers a `TaskReceipt`
// for its continuation task, and the receipt deliberately carries NO document — the
// stream's `turn.upsert` frame is what paints the new turn. The shell still re-reads the
// cheap roster: that is the frame which moves the thread out of `stopped`, i.e. the one
// thing that honestly retires the Resume control (ui/turns.ts reads visibility from the
// roster, never from a local flag).
export const resumeViewThread = async (
    sessionId: string,
    threadId: string
): Promise<{ receipt: TaskReceipt; view: SessionView }> => {
    const receipt = await resumeThread(sessionId, threadId);

    return { receipt, view: await refreshRoster(sessionId) };
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
    // R2/R4: the loader's cache stamp. The document install (`main.ts` `applyView`) records
    // it next to the trees it carries across, and refuses to carry anything once it moved:
    // `invalidate()` is exactly the signal that the cached trees are untrustworthy (a dropped
    // socket), and the next reveal() must re-read them instead of trusting a stale tree.
    generation(): number;
    // R2/R4: un-marks ONE turn so the next `ensureVisible` reads its tree again. The document
    // install calls this for a row whose record moved since the tree was painted (a running
    // turn advancing, a settle, a cancel) — that is the poll path's display update channel,
    // and without it a rows-only document would leave a live tile frozen on its old text.
    forget(turnId: string): void;
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

        // R2/R4: the cache stamp of the loader that currently owns this conversation. Read
        // WITHOUT the session-sync side effect (`loader`, not `syncLoader()`): the stamp is
        // refreshed on every document install, and the swap itself stays where it always was
        // (the first `ensureVisible` of the new conversation), so asking a question can never
        // drop an in-flight tree.
        generation: () => loader.generation(),

        forget: (turnId) => {
            syncLoader().forget(turnId);
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
    // T3: ONE roster row moved (`thread.upsert` carries a whole `ThreadSummary`,
    // ../shared/harness-stream.ts:619-627), so the row is patched in place. Before this a
    // thread frame triggered a full `openSession` re-read — every thread's roster row, the
    // whole rows page and the pending-action list — for information the frame already
    // carried, and that re-read ran on the hot path of every running conversation.
    //
    // T3b (R4): the frame's OWN stamp travels with the row. A patch is applied to a live
    // document, and a replay (a resumed stream after an outage, a re-registered baseline
    // inside a retained replay window) can deliver an OLDER row than the document a
    // `pollSession`/`resyncSession` re-read already installed — so the caller needs the
    // server's `at` (and the resume `cursor`) to refuse a stale patch, exactly as
    // `applyView` refuses a stale document.
    | { type: 'thread'; threadId: string; row: ThreadRow; at: number; cursor: string }
    | { type: 'failed'; error: { message: string }; view: SessionView };

export type ObserveOptions = {
    // Ask the server to pace this subscription (`pace: 'ack'`), which is what a
    // background tab should do so its replay buffer stays bounded.
    pace?: 'ordered' | 'ack';
    // Opt in to the verbatim `run.event` frames (the raw-transcript pane only).
    events?: boolean;
    // T3: the observation lost its position — a dropped connection, a detected gap, a
    // server `resync_required`, or a re-registration whose replay window had expired.
    // The re-read below restores the ROWS; this callback is where the caller drops the
    // render state a re-read cannot reach (the cached display trees and the per-thread
    // transcripts, which stay 'done' in their loaders otherwise).
    onRecover?: (reason: 'dropped' | 'resync' | 'stale_baseline') => void;
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
//   `thread.upsert`      → a `thread` item: ONE roster row patched in place (T3 — the
//                          frame carries the whole row, so a roster re-read was a cost
//                          the frame did not ask for)
//   `turn.removed`/
//    `thread.removed`    → a window re-read: the frames are pure invalidation, and the
//                          re-read is the one path that reconciles rows, roster and
//                          tombstones (see the note in `applyUpdate`)
//   `action.opened`/
//    `action.closed`     → an actions re-read (a question gates the composer)
//   `resync_required` /
//   a detected gap /
//   a DROPPED CONNECTION → a re-read of the loaded window, plus `onRecover` for the
//                          render state a document cannot repair (T3: the client now
//                          reports a drop to every subscription, and a re-registered
//                          baseline without `replayed_frames` reconciles on its own)
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

    // T3: has this registration been ANCHORED by a baseline yet? The first
    // `subscription_state` is the anchor of the document the shell already read over REST
    // (the pre-existing rule below). A SECOND one on the same registration can only mean
    // the client re-dialled — `stream.ts`'s `onopen` flushes every registration — and the
    // broker then answers one of two things: `replayed_frames > 0` (the parked replay
    // window was still there, so the frames missed during the outage arrived as `update`
    // frames and the pane applied them), or a FRESH baseline with no counter at all,
    // because an expired window is not a `resync_required` — it is a quiet restart
    // (../server/stream/broker.ts:749-768). In that second case every frame this pane
    // missed is gone forever and the client had no way to know: THAT is the stale-state
    // bug the reconciliation below closes.
    let anchored = false;

    // T3: a LOST position. Set by every resync path (a dropped connection, a gap, a server
    // `resync_required`) and consumed by the next baseline, because only the baseline can
    // say which kind of loss this was: a resumed one replays the missing frames (nothing to
    // re-read), a fresh one means they are gone (re-read). The flag also makes the pair
    // idempotent — a connection that answers the same registration twice reconciles ONCE.
    let pendingBaseline = false;

    // The reconciliation the re-read alone cannot do: the render state a document does NOT
    // carry. The cached display trees and the cached per-thread transcripts stay 'done' in
    // their loaders otherwise, so a turn that was mid-flight across an outage would keep a
    // stale tree forever; the caller drops them from here.
    const recover = (reason: 'dropped' | 'resync' | 'stale_baseline'): void => {
        options.onRecover?.(reason);
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

        if (update.kind === 'thread.upsert') {
            // T3: the frame carries the WHOLE roster row (`ThreadSummary`, and a
            // `ThreadResource` satisfies the same mapper), so the patch is one row — the
            // card header, its status word, its preview and its counts. A full
            // `openSession` here re-read the rows page, the roster page and the pending
            // actions for a fact the frame already stated, and it ran on the hot path of
            // every running conversation (one frame per thread status change).
            const frame = update as WsUpdateThreadUpsert;

            // The frame's stamp rides along: `at` is the server's own clock for the
            // mutation, and `cursor` is this subscription's resume position at that
            // instant — the pair the caller needs to refuse a replayed older row.
            onItem({
                type: 'thread',
                threadId: frame.thread.id,
                row: threadRowOf(frame.thread),
                at: frame.at,
                cursor: frame.cursor
            });

            return;
        }

        // T3 (decision, recorded for review): `turn.removed` and `thread.removed` stay on
        // the window re-read. Both frames are PURE INVALIDATION — one id, no body
        // (../shared/harness-stream.ts:543/633) — and the reconciliation they need is the
        // one `applyView` owns: tombstone learning, the record-cache rebuild, the roster
        // rows that no longer name the conversation, and the descendants a thread delete
        // cascades into. A targeted per-thread read would be a SECOND authority path
        // running next to that guard, and removals are rare (a delete, not a frame storm),
        // so the honest bounded recovery stays the loaded-window re-read.
        if (update.kind === 'turn.removed' || update.kind === 'thread.removed') {
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
        //
        // T9 (R7) records the ONE case that is not merely "not forwarded" but never
        // delivered here at all: `transcript.updated` is a THREAD-scope kind
        // (../server/stream/protocol.ts:73-86, and the broker refuses it for any other
        // scope via `isKindPublishedTo`, ../server/stream/broker.ts:487). The pane that
        // consumes it is the followed thread's own subscription (`observeThread`
        // `onTranscript` below), and that is where ./main.ts now arms the lane repaint.
    };

    sub = client.subscribe({
        scope: 'session',
        sessionId,
        ...(options.pace === undefined ? {} : { pace: options.pace }),
        ...(options.events === true ? { filters: { events: true } } : {}),
        onState: (state) => {
            if (!anchored) {
                anchored = true;
                pendingBaseline = false;

                // The baseline is the anchor, not a document: the shell already opened
                // the window over REST, so nothing is fetched on registration.
                return;
            }

            // A re-registration. Frames were replayed ⇒ the pane has been applying them
            // through `onUpdate`, and this baseline is simply the new anchor; nothing to
            // fetch. Frames were NOT replayed AND the position was lost ⇒ the server
            // restarted this subscription at its own current position, so the outage's
            // worth of mutations never arrived and the document on screen is exactly as
            // stale as if the socket had closed quietly. Re-read, and drop the render state
            // a document cannot repair.
            if ((state.replayed_frames ?? 0) > 0) {
                pendingBaseline = false;

                return;
            }

            if (!pendingBaseline) return;

            pendingBaseline = false;
            recover('stale_baseline');
            void reRead();
        },
        onUpdate: applyUpdate,
        onResync: (frame: WsResyncRequired) => {
            // T3: `stream.ts` now routes a DROPPED CONNECTION here too (a synthetic
            // `frames_dropped` carrying no resource list), which is the only way a pane
            // learns the socket died — before this, `onclose` re-dialled in silence and
            // every pane kept its pre-drop document.
            //
            // A SYNTHETIC frame (a drop, or a sequence gap this client detected) means the
            // position is lost and the client is ALREADY re-registering the subscription
            // (./stream.ts `reregister`), so the next baseline is what says whether the
            // missing frames were replayed. Re-reading at this instant would race that
            // answer — and against a server whose REST answer is captured before the
            // frames land, a document applied here deletes rows the frames already
            // delivered (the N2/T44 hazard this file keeps re-learning). So the window
            // re-read waits for the baseline, and only the part that cannot be wrong runs
            // now: the render state the flow no longer backs is dropped.
            //
            // A SERVER frame with named resources is an instruction to re-read those
            // resources, and it is re-read immediately — nothing is in flight to wait for.
            pendingBaseline = true;

            if (frame.reason === 'frames_dropped' && frame.resources.length === 0) {
                recover('dropped');

                return;
            }

            recover('resync');
            void reRead();
        },
        onError: () => {
            // A refused subscription is reported once and the caller's bounded polling
            // takes over; it never cancels the run.
            //
            // T3: and it releases the registration on the way out. The client keeps
            // re-sending every entry in its subscription map on each `onopen`, so a
            // settled observer that never unsubscribed was re-registered on every
            // reconnect FOREVER — against the 64-subscriptions-per-connection budget
            // (../server/stream/broker.ts:708, close 4401) and the 32 messages/second
            // reconnect burst limit (../server/stream/connection.ts:305, close 4429).
            // Those leaked registrations are a direct cause of the "random drops" this
            // task reports: the reconnect storm closes its own socket.
            sub?.unsubscribe();
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

    // T3: same registration rule as `observeView` above. A second baseline without
    // `replayed_frames` means the replay window expired during the outage, so the tile's
    // tree is missing the flow it would have streamed; the turn's own tree re-read (the
    // `onResync` recovery below) is the bounded repair.
    let anchored = false;
    let pendingBaseline = false;

    const sub = client.subscribe({
        scope: 'turn',
        sessionId,
        turnId,
        onState: (state) => {
            if (!anchored) {
                anchored = true;
                pendingBaseline = false;

                return;
            }

            if ((state.replayed_frames ?? 0) > 0) {
                pendingBaseline = false;

                return;
            }

            if (!pendingBaseline) return;

            pendingBaseline = false;
            options.onResync?.(turnId);
        },
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
            // T3: a lost position (including the drop notification ./stream.ts now sends).
            // The tile's own tree is the recovery payload, so the caller re-reads exactly
            // that — bounded, one call, never a window re-read.
            pendingBaseline = true;
            options.onResync?.(turnId);
        },
        onError: () => {
            // A refused/failed turn subscription costs the reader its live flow and
            // nothing else; the session plane still carries the rows. T3: release the
            // registration first — it would otherwise be re-sent on every reconnect
            // (the leak `observeView` documents above).
            sub.unsubscribe();
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
};// ---------------------------------------------------------------------------
// The followed thread (T3: live observation is per-thread, and ONLY for a thread the
// reader opened)
// ---------------------------------------------------------------------------

// A thread card the reader expanded, and the conversation they are looking at, are the
// two surfaces whose content cannot be reconstructed from the session subscription: the
// committed transcript document (the session scope publishes `transcript.updated` as
// counts only — message bodies never ride the wire, ../shared/harness-stream.ts:648-656)
// and the row's own live state. This subscription is therefore registered when a thread
// becomes EXPANDED or VIEWED and released when it collapses, which is what the request
// asks for: "expanding a thread re-establishes the socket for that thread; collapsing it
// means no longer following it".
//
// What the scope carries (../shared/harness-stream.ts:72-89 — the thread scope publishes
// `transcript.updated` and `thread.upsert`, and NOTHING else):
//   `thread.upsert`      → the whole roster row → `onThread` (one card repaints)
//   `transcript.updated` → the transcript moved → `onTranscript` (re-read THAT document,
//                          bounded to one thread: this is the frame the all-threads
//                          fan-out used to pay for on every open). T9 (R7): ./main.ts also
//                          arms ONE coalesced display re-read there, so a host transcript
//                          write dims and un-dims the lane segments whose `included` stamp the
//                          write moved — the flags have no frame of their own
//                          (../harness.ts `setIncluded` → the store's silent
//                          `noteStateChange`, src/server/sessions.ts:3307). The pass is not
//                          scoped to this thread: scoping would skip any row whose `threadId`
//                          the wire never stated, and under-dimming a lane the reader is
//                          looking at is the failure that must not happen.
//   a drop, a gap, a refused cursor, or a re-registration with an expired replay window
//                        → `onResync` (the caller re-reads what it is showing)
//
// `display.ops` deliberately does NOT ride this scope — the streamed token flow stays on
// the ONE expanded tile's `turn` subscription above, which is the difference between
// streaming a conversation and streaming a roster.
//
// The budget is honest: a session's roster page is 25 rows (./view-api.ts
// `ROSTER_PAGE_LIMIT`) and only the expanded/focused ones are ever followed, against the
// contract's 64 subscriptions per connection — and there is still exactly ONE socket for
// the whole page (./stream.ts).
export type ObserveThreadOptions = {
    // The roster row moved. The frame carries the whole row, so this is a patch, not a
    // read. `at`/`cursor` are the frame's OWN stamp (T3b): the caller refuses a patch older
    // than the row it already holds, the same strictly-older rule `applyView` applies to a
    // document.
    onThread?: (threadId: string, row: ThreadRow, stamp: { at: number; cursor: string }) => void;
    // The thread's transcript document changed (counts + revision; the bodies are the
    // caller's own read).
    onTranscript?: (threadId: string) => void;
    // This thread's live position is gone: re-read what this surface is showing.
    onResync?: (threadId: string) => void;
    // A protocol error naming this subscription (an unknown thread id, most often).
    onError?: (message: string) => void;
    pace?: 'ordered' | 'ack';
};

export const observeThread = async (
    sessionId: string,
    threadId: string,
    signal: AbortSignal,
    options: ObserveThreadOptions = {}
): Promise<void> => {
    const client = harnessStream();

    // Same degradation as the other two observers: no socket in this host means no live
    // thread flow, and the caller's bounded reads stay correct.
    if (client.status() === 'closed' && typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'function') {
        return;
    }

    let settle: () => void = () => undefined;

    const done = new Promise<void>((resolve) => {
        settle = resolve;
    });

    // T3: a second `subscription_state` for the SAME registration means the client
    // re-dialled; without `replayed_frames` the server restarted the subscription, so the
    // frames this pane missed during the outage are gone (see `observeView`).
    let anchored = false;
    let pendingBaseline = false;

    const sub = client.subscribe({
        scope: 'thread',
        sessionId,
        threadId,
        ...(options.pace === undefined ? {} : { pace: options.pace }),
        onState: (state) => {
            if (!anchored) {
                anchored = true;
                pendingBaseline = false;

                return;
            }

            if ((state.replayed_frames ?? 0) > 0) {
                pendingBaseline = false;

                return;
            }

            if (!pendingBaseline) return;

            pendingBaseline = false;
            options.onResync?.(threadId);
        },
        onUpdate: (update: WsUpdate) => {
            if (update.kind === 'thread.upsert') {
                const frame = update as WsUpdateThreadUpsert;

                options.onThread?.(threadId, threadRowOf(frame.thread), {
                    at: frame.at,
                    cursor: frame.cursor
                });

                return;
            }

            if (update.kind === 'transcript.updated') {
                // The subscription is addressed to ONE thread, so the signal belongs to it
                // even though `TranscriptSignal` names no thread id of its own.
                options.onTranscript?.(threadId);

                return;
            }
        },
        onResync: () => {
            // T3 (R2/R4): this thread's live position is gone — a drop, a gap, or a
            // refused cursor. The caller re-reads the ONE document this surface shows, so
            // an expanded card converges on the current state without a page refresh.
            pendingBaseline = true;
            options.onResync?.(threadId);
        },
        onError: (error) => {
            // T3: unsubscribe BEFORE settling. Every settled-but-unreleased registration
            // is replayed by `onopen` on the next connection, and the connection budget
            // (64 subs, a 32 msg/s resume burst) is what closes the socket next time —
            // the leak that made drops look random.
            sub.unsubscribe();
            options.onError?.(error.message);
            settle();
        }
    });

    // An undeliverable plane settles immediately, exactly as `observeView` does: the
    // caller's bounded read is the degraded observation, never a hung promise.
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
            // R3: collapsing a thread releases its live position — an unsubscribe only,
            // never a cancel (execution is server-owned).
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
    turnIds?: readonly string[],
    // T3b (owner decision on the R1/T3 trade): which transcript DOCUMENTS this read
    // composes.
    //
    //   OMITTED  -> EVERY roster thread, in roster order. This is the lossless-export
    //              contract (`ui/thread-transcript.test.ts` pins a document whose thread
    //              rows carry their committed `messages`, and the editor quotes the stored
    //              bytes of an unreadable one), and it is what an EXPLICIT export pays: a
    //              reader who asks for the document gets the whole document, including the
    //              conversations this page never opened.
    //   GIVEN    -> exactly those ids (intersected with the roster, so a stale id costs no
    //              request). This is the bounded form the shell uses when it needs ONE
    //              conversation's bytes without re-reading the roster.
    //
    // The reason the parameter exists at all: the same composition sat on the LOAD and
    // every viewing path, where 2 identified reads per roster row (50 for a full page)
    // bought bytes no collapsed card renders. The fan-out is therefore not removed from
    // the export — it is removed from everything that is not an export (./main.ts: a load
    // reads no transcript, an expanded thread reads its own).
    threadIds?: readonly string[]
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

    // The documents the export quotes: every roster row when the caller asked for the
    // whole (lossless) document, or exactly the named ids when it asked for a bounded one.
    // Concurrent because the documents are independent identified reads, and
    // failure-tolerant — a thread whose document is unreadable keeps its roster row (and
    // the `invalidThreads` marker the roster already states) rather than failing the whole
    // export.
    const wanted = threadIds === undefined ? null : new Set(threadIds);
    const targets =
        wanted === null
            ? roster.items.map((row) => row.id)
            : roster.items.filter((row) => wanted.has(row.id)).map((row) => row.id);
    const [rawTurns, documents] = await Promise.all([
        readRawTurns(sessionId, ids),
        Promise.allSettled(targets.map((threadId) => readTranscript(sessionId, threadId)))
    ]);

    // A thread id -> the transcript payload read for it. Kept whole (not just `messages`)
    // because an UNREADABLE transcript carries its stored bytes in `invalid.raw`, and the
    // editor quotes those verbatim — the roster row alone states only the verdict.
    const transcripts = new Map<string, Awaited<ReturnType<typeof readTranscript>>>();
    documents.forEach((result, index) => {
        if (result.status === 'fulfilled') transcripts.set(targets[index] as string, result.value);
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

// T3: the per-thread transcript queue (./view-api.ts `createThreadTranscriptLoader`) is
// re-exported here so the shell wires every lazy read through THIS module, exactly like
// the two detail reads above: one place owns "what does the UI ask the server for".
export { createThreadTranscriptLoader } from './view-api';
export type { ThreadTranscriptLoader } from './view-api';

// The stream URL the socket dials, re-exported for the diagnostics pane.
export const streamUrl = (): string => apiUrl(HARNESS_ROUTES.stream());

// The display helpers the shell's paging seam uses.
export { loadOlderTurns, projectDisplay, projectStep };
