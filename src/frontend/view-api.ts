// The browser client for the DISPLAY surface (`/views`), the frontend's default wire.
//
// Why this is a separate client from ./api.ts (R1/R3):
//   - `api.ts` speaks the RAW contract (`SessionSnapshot` with `turns[].events`,
//     `SessionStreamItem` with one frame per `HarnessEvent`). That contract stays
//     byte-identical for the CLI and for embedders (src/server/protocol.ts:556), so
//     the browser gets its own surface instead of the raw one being narrowed.
//   - The display surface is defined by the frozen contract in
//     src/shared/turn-display.ts (compiled view state + bounded previews + lazy
//     detail) and src/server/protocol.ts:587-672 (`SessionView`,
//     `SessionViewStreamItem`, `SubmitTaskViewResult`). This module is the ONLY
//     place a browser may request it, which is what makes "the default traffic
//     carries no raw steps" enforceable by route.
//
// Routes (mount-relative; identical under the standalone `/api` mount and the
// service `/v1/harness` mount, because both adapters call one dispatcher —
// api.ts:962 comment in the protocol header):
//
//   GET    views                                             -> SessionViewIndex
//   POST   views                                             -> { view }                    (create)
//   GET    views/:id                                         -> { view }
//   PATCH  views/:id                                         -> { view }                    (agentModels)
//   POST   views/:id/reset                                   -> { view }
//   DELETE views/:id                                         -> { deleted }
//   POST   views/:id/cancel                                  -> { cancelled }
//   GET    views/:id/events            SSE SessionViewStreamItem
//   POST   views/:id/tasks             202                   -> SubmitTaskViewResult
//   POST   views/:id/actions/:requestId/answer               -> { ok }
//   GET    views/:id/threads/:threadId/transcript            -> { transcript }
//   PUT    views/:id/threads/:threadId/transcript            -> { view, transcript }
//   POST   views/:id/threads/:threadId/cancel                -> { cancelled, view }
//   DELETE views/:id/threads/:threadId                       -> { deleted, view }
//   GET    views/:id/turns/:turnId/steps/:stepId             -> { detail }                  (lazy, exact)
//   GET    views/:id/turns/:turnId/raw                       -> { turn }                    (export only)
//
// The last two are the ONLY routes that move a recorded `HarnessEvent` into this
// browser, and each one is reached from an explicit user action (open a tool's
// details, copy/export a transcript). The mutations that the raw surface answers
// with a `SessionSnapshot` are mirrored here to answer with a `SessionView`, so a
// default-path round trip (create / reset / stop / delete / patch / transcript
// save) never carries an event list either.
//
// Transport is shared with ./api.ts (`request`, `apiUrl`, `readEventStream`): one
// root resolution, one trust rule, one error shape, so a `/views` failure reads
// exactly like any other harness failure in the UI.

import type {
    HarnessActionChoice,
    HarnessAttachment
} from '../types';
import type {
    // C4 transcript documents (same aliases the raw client re-exports).
    ThreadTranscriptResponse,
    UpdateThreadTranscriptRequest,
    UpdateSessionRequest
} from '../server/protocol';
import type {
    SessionSnapshot,
    SessionStatus,
    SessionThread,
    SessionTurn,
    SessionView,
    SessionViewStreamItem,
    SessionViewSummary,
    SubmitTaskViewResult,
    TurnStepDetail
} from '../server/protocol';
import { apiUrl, readEventStream, readStreamError, request } from './api';
import type { HarnessTurnReference } from './ui/references';

// ---------------------------------------------------------------------------
// Mirrored envelopes (mutations)
// ---------------------------------------------------------------------------
//
// The frozen protocol declares the raw mutation answers (`CancelThreadResult`,
// `DeleteThreadResult`, `UpdateThreadTranscriptResult`) with a `SessionSnapshot`
// payload. The display mirrors are declared HERE, not in ../server/protocol.ts,
// because that file is the server's contract and the server worker owns it; the
// browser only needs the shape it reads. Every field the raw envelope carries
// survives, with `session` replaced by `view` — so no reconciliation logic has to
// change shape between the two surfaces.

/** POST `/views` — create a conversation; the compact counterpart of `POST /sessions`. */
export type CreateViewResult = {
    view: SessionView;
};

/** POST `/views/:id/threads/:threadId/cancel` — mirror of `CancelThreadResult`. */
export type CancelThreadViewResult = {
    cancelled: boolean;
    view: SessionView;
};

/** DELETE `/views/:id/threads/:threadId` — mirror of `DeleteThreadResult`. */
export type DeleteThreadViewResult = {
    deleted: true;
    view: SessionView;
};

/** PUT `/views/:id/threads/:threadId/transcript` — mirror of `UpdateThreadTranscriptResult`. */
export type UpdateThreadTranscriptViewResult = {
    view: SessionView;
    transcript: ThreadTranscriptResponse;
};

/** Body of `POST /views/:id/tasks`; identical to the raw `SubmitTaskRequest` body. */
export type SubmitViewTaskRequest = {
    input: string;
    attachments?: HarnessAttachment[];
    references?: readonly HarnessTurnReference[];
    threadId?: string;
};

// ---------------------------------------------------------------------------
// Directory + single view
// ---------------------------------------------------------------------------

// `GET views` — one row per conversation, NO node trees (`SessionViewSummary` is
// `Omit<SessionView, 'displays'>`). This is what the session rail and the bootstrap
// replacement read; the raw equivalent (`GET /sessions`) ships every session's every
// recorded event, which is the payload this surface exists to remove.
export const listViews = async (): Promise<SessionViewSummary[]> => {
    const body = await request<{ views: SessionViewSummary[] }>('/views');

    return Array.isArray(body.views) ? body.views : [];
};

// `GET views/:id` — one conversation's compiled state: header fields, compact rows
// and display trees, and no event list anywhere (see `SessionView`, protocol.ts:587).
export const getView = async (id: string): Promise<SessionView> => {
    const body = await request<{ view: SessionView }>(`/views/${encodeURIComponent(id)}`);

    return body.view;
};

// `POST views` — create a conversation (R1: the answer is a VIEW, so the first
// submit of a brand-new chat costs the same bytes as a session header).
export const createView = async (
    harness: string,
    settings: unknown
): Promise<SessionView> => {
    const body = await request<CreateViewResult>('/views', {
        method: 'POST',
        body: JSON.stringify({ harness, settings })
    });

    return body.view;
};

// `PATCH views/:id` — change which model an agent runs. Same body and same merge
// semantics as the raw `PATCH /sessions/:id` (protocol.ts:693); the answer is the
// view, so a model edit repaints without pulling events.
export const updateView = async (id: string, input: UpdateSessionRequest): Promise<SessionView> => {
    const body = await request<{ view: SessionView }>(`/views/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input)
    });

    return body.view;
};

// `POST views/:id/reset` — clear the conversation's history.
export const resetView = async (id: string): Promise<SessionView> => {
    const body = await request<{ view: SessionView }>(`/views/${encodeURIComponent(id)}/reset`, {
        method: 'POST'
    });

    return body.view;
};

// `DELETE views/:id` — permanent removal. The answer is `{ deleted }`, exactly like
// the raw route: a delete needs no snapshot because the caller's next directory read
// (or the local tombstone) is the state.
export const deleteView = async (id: string): Promise<void> => {
    await request<{ deleted: boolean }>(`/views/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

// Keepalive variant for the unload path (same rule as api.ts `deleteSessionOnUnload`:
// best effort, never depended upon).
export const deleteViewOnUnload = async (id: string): Promise<void> => {
    await request<{ deleted: boolean }>(`/views/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        keepalive: true
    });
};

// `POST views/:id/cancel` — session-wide stop. `{ all: true }` drains the queue;
// the field is omitted for the legacy active-run-only cancel so the body a server
// sees is byte-identical to the raw surface's.
export const cancelView = async (id: string, all = false): Promise<boolean> => {
    const body = await request<{ cancelled: boolean }>(`/views/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        ...(all ? { body: JSON.stringify({ all: true }) } : {})
    });

    return body.cancelled;
};

// `POST views/:id/threads/:threadId/cancel` — stop ONE persistent thread.
export const cancelViewThread = async (
    id: string,
    threadId: string
): Promise<CancelThreadViewResult> =>
    request<CancelThreadViewResult>(
        `/views/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/cancel`,
        { method: 'POST' }
    );

// `DELETE views/:id/threads/:threadId` — permanently remove one stopped/idle thread.
// The answer carries the post-delete VIEW, so focus/reference cleanup reconciles from
// it exactly like the raw `DeleteThreadResult` reconciliation does today.
export const deleteViewThread = async (
    id: string,
    threadId: string
): Promise<DeleteThreadViewResult> =>
    request<DeleteThreadViewResult>(
        `/views/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}`,
        { method: 'DELETE' }
    );

// `POST views/:id/actions/:requestId/answer` — answer one owner question (N3).
// Same statuses as the raw route (400 unknown option, 404 unknown request, 409
// already answered/expired); only the route family differs.
export const answerViewAction = async (
    sessionId: string,
    requestId: string,
    choice: HarnessActionChoice
): Promise<boolean> => {
    const body = await request<{ ok: boolean }>(
        `/views/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(requestId)}/answer`,
        { method: 'POST', body: JSON.stringify({ choice }) }
    );

    if (body.ok !== true) throw new Error('The harness server did not accept the answer.');

    return true;
};

// ---------------------------------------------------------------------------
// Transcript (C4/C5) — a transcript document is NOT an event list
// ---------------------------------------------------------------------------

export type ThreadTranscriptViewPayload = ThreadTranscriptResponse;

// `GET views/:id/threads/:threadId/transcript`.
export const getThreadTranscript = async (
    sessionId: string,
    threadId: string
): Promise<ThreadTranscriptViewPayload> => {
    const body = await request<{ transcript: ThreadTranscriptViewPayload }>(
        `/views/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}/transcript`
    );

    return body.transcript;
};

// `PUT views/:id/threads/:threadId/transcript` — replace the transcript. The body is
// verbatim (`{ messages: unknown }`) so a value the user broke is still a 200 the
// dialog renders as a banner, exactly as on the raw route.
export const updateThreadTranscript = async (
    sessionId: string,
    threadId: string,
    messages: unknown
): Promise<UpdateThreadTranscriptViewResult> => {
    const body: UpdateThreadTranscriptRequest = { messages };

    return request<UpdateThreadTranscriptViewResult>(
        `/views/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}/transcript`,
        { method: 'PUT', body: JSON.stringify(body) }
    );
};

// ---------------------------------------------------------------------------
// Submit + observation
// ---------------------------------------------------------------------------

// `POST views/:id/tasks` (202). Same body rules as the raw submit (threadId absent =
// open a new standalone thread; `references` omitted when empty so a plain typed
// `#LABEL` keeps the legacy shape), and the answer is `SubmitTaskViewResult`:
// `{ view, turn: TurnSummary, steered?, steeredThreadId? }`. A submit therefore
// repaints the board without downloading a single recorded event.
export const submitViewTask = async (
    id: string,
    input: string,
    attachments?: readonly HarnessAttachment[],
    references?: readonly HarnessTurnReference[],
    threadId?: string
): Promise<SubmitTaskViewResult> => {
    const body: Record<string, unknown> = { input };

    if (threadId !== undefined && threadId.length > 0) body.threadId = threadId;
    if (attachments !== undefined && attachments.length > 0) body.attachments = attachments;
    if (references !== undefined && references.length > 0) {
        // Copy each entry to a plain wire object: an undefined `threadId` is the
        // "root block" signal and must be absent, and no draft-only field may leak.
        body.references = references.map((reference) => ({
            turnId: reference.turnId,
            ...(reference.threadId === undefined ? {} : { threadId: reference.threadId }),
            label: reference.label
        }));
    }

    return request<SubmitTaskViewResult>(`/views/${encodeURIComponent(id)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body)
    });
};

// `GET views/:id/events` — the display observer (R1/R3).
//
// Frame contract (protocol.ts:640): opens with one `view`, continues with `ops`
// frames addressed by node/step id, closes with one self-sufficient `view` once the
// queue drains, and `failed` is the error terminal that still carries a `view`. The
// caller therefore never folds an event, and a missed op is reconciled by the frame
// that ends the stream.
//
// Aborting `signal` only unsubscribes: execution is server-owned (same rule as
// api.ts `observeSession`), so switching a view never stops a task.
export const observeView = async (
    id: string,
    onItem: (item: SessionViewStreamItem) => void,
    signal: AbortSignal
): Promise<void> => {
    let response: Response;

    try {
        response = await fetch(apiUrl(`/views/${encodeURIComponent(id)}/events`), {
            headers: { Accept: 'text/event-stream', 'X-Harness-Client': 'ui' },
            signal
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(
            `The harness server is unreachable: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (!response.ok) throw new Error(await readStreamError(response));
    if (response.body === null) throw new Error('The harness server returned an empty event stream.');

    await readEventStream<SessionViewStreamItem>(response.body, onItem);
};

// ---------------------------------------------------------------------------
// Lazy exact detail (R2)
// ---------------------------------------------------------------------------

// `GET views/:id/turns/:turnId/steps/:stepId` — the ONE on-click request for a tool
// call. `stepId` is `DisplayStep.id` (the opening event's index), and the answer is
// the recorded OPENING event plus its recorded RESULT event verbatim
// (`TurnStepDetail`, src/shared/turn-display.ts:554) — nothing truncated, nothing
// re-projected, exact pair, once. Absent `result` is the honest "still running /
// never settled" answer, never a synthesized one.
export const getStepDetail = async (
    sessionId: string,
    turnId: string,
    stepId: string
): Promise<TurnStepDetail> => {
    const body = await request<{ detail: TurnStepDetail }>(
        `/views/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/steps/${encodeURIComponent(stepId)}`
    );

    return body.detail;
};

// `GET views/:id/turns/:turnId/raw` — the verbatim recorded turn (events +
// eventTimes). Reached ONLY from an explicit copy/export action (the JSON transcript
// in ui/thread-transcript.ts), never from a render path.
export const getTurnRaw = async (sessionId: string, turnId: string): Promise<SessionTurn> => {
    const body = await request<{ turn: SessionTurn }>(
        `/views/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/raw`
    );

    return body.turn;
};

// Reads every recorded turn a thread's JSON transcript needs (its own turns plus the
// foreign turns that carry events attributed to its delegation subtree). Explicit
// action only, and bounded to those turns instead of the whole session.
//
// The attribution inputs are COMPILED (`TurnSummary.threadId` and
// `TurnSection.invocationId`), so no event is read to decide what to fetch: the
// roster names a thread's invocations, and the display trees name which turns ran
// them. A thread with no turns yields `[]` (a roster-only conversation has no run
// history to export).
export const getThreadTurnsRaw = async (
    sessionId: string,
    view: SessionView,
    turnIds: readonly string[]
): Promise<SessionTurn[]> => {
    const unique = [...new Set(turnIds)];
    const turns: SessionTurn[] = [];

    // Sequential on purpose: one transcript open must not fan out a burst of
    // requests against the server, and the frames are already ordered.
    for (const turnId of unique) {
        try {
            turns.push(await getTurnRaw(sessionId, turnId));
        } catch {
            // A turn deleted between the compiled read and this export is simply
            // gone; the transcript documents what still exists rather than failing
            // the whole copy.
        }
    }

    return turns;
};

// A session-level raw read, for the ONE surface that quotes recorded events (the
// thread transcript / JSON export). Explicit user action only.
//
// Preferred route: `GET views/:id/raw` -> the verbatim recorded document, one
// request. When a server has not (yet) mounted that route, the same document is
// COMPOSED from the frozen per-turn route: the caller passes the turn ids the
// transcript actually needs (./view-state.ts `transcriptTurnIdsOf` derives them from
// COMPILED rows and section invocations, so no event is read to decide what to
// fetch), and each named turn is fetched verbatim. Composition therefore stays
// bounded to the turns that matter instead of pulling every event of every
// conversation, which is what made the raw `GET /sessions/:id` answer enormous.
// Omit `turnIds` to compose every turn of the session.
export const getRawSession = async (
    sessionId: string,
    turnIds?: readonly string[]
): Promise<SessionSnapshot> => {
    let session: SessionSnapshot | undefined;

    try {
        // The answer is accepted in EITHER shape: the bare document, or the `{session}` envelope
        // the raw read uses on the `/sessions` surface (protocol.ts:458). A server is free to mount
        // this route either way, and a client that guesses one shape loses the transcript on the
        // other — which is exactly the failure this normalizer exists to prevent.
        const payload = await request<SessionSnapshot & { session?: SessionSnapshot }>(
            `/views/${encodeURIComponent(sessionId)}/raw`
        );
        const candidate = payload?.session ?? payload;
        session = typeof candidate?.id === 'string' ? candidate : undefined;
    } catch {
        // Not mounted, or the route itself answered an error: compose below from the
        // frozen per-turn contract, which the browser can always rely on.
    }

    // A session-level answer already satisfies an unfiltered request.
    if (session !== undefined && (turnIds === undefined || turnIds.length === 0)) return session;

    const view = await getView(sessionId);
    const rows = Array.isArray(view.turns) ? view.turns : [];
    const ids =
        turnIds !== undefined && turnIds.length > 0
            ? turnIds
            : rows.map((summary) => (summary as { id: string }).id);

    const turns = await getThreadTurnsRaw(sessionId, view, ids);

    // The named-turns variant keeps every header field of the answer this browser
    // already renders (roster, harness definition, invalid threads) and swaps in the
    // recorded turns the export quotes. `messages` is the entry agent's transcript,
    // which the view does not ship, so an empty array is the honest answer.
    if (session !== undefined) return { ...session, turns };

    return {
        ...(view as unknown as Omit<SessionSnapshot, 'turns' | 'messages'>),
        messages: [],
        turns
    } as SessionSnapshot;
};
