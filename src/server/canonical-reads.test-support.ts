// TEST SUPPORT (not production, not collected by vitest: the file name ends in
// `.test-support.ts`, while `src/**/*.{test,spec}.{ts,tsx}` is the include pattern in
// ./vitest.config.ts).
//
// WHY THIS EXISTS
// The canonical surface (src/server/api.ts + the generated contract
// ../shared/harness-api.ts) never answers with a fat aggregate any more: a submit is a
// 202 `TaskReceipt`, a session list is a `SessionSummaryPage`, a conversation list is a
// `TurnSummaryPage` of bounded previews, and the heavy children (display tree, one step,
// one context block, one attachment, the verbatim events) are each exactly one named read
// away. A regression test that used to read one snapshot now has to COMPOSE those reads,
// and doing that inline in fourteen test files re-decides the same route strings, the same
// cursor plumbing and the same non-2xx failure message fourteen times.
//
// This module owns that composition. It is assertion-neutral: every helper returns the
// contract DTO it read, so the test file still decides what is expected and stays
// deterministic (exact values, exact key sets). It never invents a compatibility shape and
// never falls back to the internal store oracle — the store stays reachable directly in a
// test that wants it (`runtime.store.getView(...)`).
//
// MOUNT IS NEVER GUESSED HERE: the caller passes a `call` bound to one mount, so the same
// helpers serve the in-process `runtime.api(...)` tests and the real-HTTP tests.

import { HARNESS_PATH_TEMPLATES, HARNESS_ROUTES } from '../shared/harness-api';
import type {
    AttachmentResponse,
    HarnessEvent,
    TaskReceipt,
    ThreadSummary,
    ThreadSummaryPage,
    TranscriptDocumentResponse,
    TranscriptMetadata,
    TranscriptMetadataResponse,
    TranscriptMessagePage,
    TranscriptWriteReceipt,
    TurnBlockDetail,
    TurnDisplay,
    TurnEventPage,
    TurnResource,
    TurnStepDetail,
    TurnSummary,
    TurnSummaryPage
} from '../shared/harness-api';
import type { HarnessApiRequest, HarnessApiResult } from './api';

/** Anything whose answer is a canonical `HarnessApiResult`, i.e. one API call. */
export type CanonicalCall = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    pathname: string,
    body?: unknown
) => Promise<HarnessApiResult>;

/** The method position of `CanonicalCall`, reused by the helpers below. */
export type CanonicalMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * Binds one in-process dispatcher (`runtime.api`, or the result of `createHarnessApi`) to a
 * mount, producing the `CanonicalCall` every helper below consumes.
 *
 * WHY THE QUERY SPLIT LIVES HERE: the helpers compose a cursor/limit onto the PATH with
 * `?`, which is how a real HTTP request addresses a page. The dispatcher itself matches on a
 * BARE pathname and reads paging out of `searchParams` (./api.ts `relativeSegments` +
 * `queryOf`), so a test driving `runtime.api` directly must move the query across before the
 * call. Doing it in the binding keeps each test file's transport one line and stops fourteen
 * copies of the same `indexOf('?')` from disagreeing.
 */
export const bindApiCall = (
    api: (request: HarnessApiRequest) => Promise<HarnessApiResult>,
    mount: string
): CanonicalCall => {
    const call: CanonicalCall = (method, pathname, body) => {
        const mark = pathname.indexOf('?');
        const path = mark === -1 ? pathname : pathname.slice(0, mark);
        const search = mark === -1 ? undefined : pathname.slice(mark + 1);

        return api({
            method,
            pathname: path,
            ...(search === undefined ? {} : { searchParams: search }),
            mount,
            readBody: async <T>() => (body === undefined ? ({} as T) : (body as T))
        });
    };

    return call;
};

/** The canonical root every helper builds paths under (asserted, not assumed). */
export const CANONICAL_MOUNT = HARNESS_API_ROOT_ALIAS();

function HARNESS_API_ROOT_ALIAS(): string {
    // Indirection keeps the single source of truth: the contract's own root constant.
    return HARNESS_PATH_TEMPLATES.root;
}

/**
 * Perform one read and return its body, asserting the expected success status up front.
 * `expectStatus` is required on purpose: a helper call that forgot what it should get
 * cannot quietly pass.
 */
export const readOk = async <T>(
    call: CanonicalCall,
    method: CanonicalMethod,
    pathname: string,
    expectStatus: number,
    body?: unknown
): Promise<T> => {
    const result = await call(method, pathname, body);

    if (result.kind !== 'json') {
        throw new Error(`${method} ${pathname} answered "${result.kind}", expected JSON`);
    }

    if (result.status !== expectStatus) {
        const detail = JSON.stringify(result.body);

        throw new Error(`${method} ${pathname} answered ${result.status} (want ${expectStatus}): ${detail}`);
    }

    return result.body as T;
};

// ---------------------------------------------------------------------------
// Session / task entry points
// ---------------------------------------------------------------------------

/** `POST /v1/harness/sessions/{id}/tasks` -> 202 `TaskReceipt`. */
export const submitTask = (
    call: CanonicalCall,
    sessionId: string,
    request: { input: string; attachments?: unknown[]; references?: unknown[]; thread_id?: string }
): Promise<TaskReceipt> =>
    readOk<TaskReceipt>(call, 'POST', HARNESS_ROUTES.sessionsBySessionIdTasks(sessionId), 202, request);

/** `GET /v1/harness/sessions/{id}/turns` -> one page of bounded turn rows. */
export const listTurns = (
    call: CanonicalCall,
    sessionId: string,
    options: { limit?: number; cursor?: string } = {}
): Promise<TurnSummaryPage> =>
    readOk<TurnSummaryPage>(
        call,
        'GET',
        withQuery(HARNESS_ROUTES.sessionsBySessionIdTurns(sessionId), {
            limit: options.limit,
            cursor: options.cursor
        }),
        200
    );

/**
 * Every turn row of a session, following `next_cursor` until the collection is exhausted.
 * This is the composed replacement for the old "one snapshot, every turn" read: the rows
 * come in contract pages, in order, and the loop asserts the page it got each time.
 */
export const allTurns = async (call: CanonicalCall, sessionId: string, limit = 100): Promise<TurnSummary[]> => {
    const rows: TurnSummary[] = [];
    let cursor: string | null | undefined;
    let pages = 0;

    for (;;) {
        const page = await listTurns(call, sessionId, { limit, cursor: cursor ?? undefined });

        pages += 1;
        rows.push(...page.items);

        if (page.next_cursor === null) return rows;

        // A repeated cursor would spin forever: fail instead of looping.
        if (page.next_cursor === cursor) throw new Error(`turn paging on ${sessionId} repeated cursor ${cursor}`);
        cursor = page.next_cursor;

        if (pages > 50) throw new Error(`turn paging on ${sessionId} exceeded 50 pages`);
    }
};

/** `GET /v1/harness/sessions/{id}/turns/{turnId}` -> durable turn metadata (verbatim prompt, counts). */
export const readTurn = (call: CanonicalCall, sessionId: string, turnId: string): Promise<TurnResource> =>
    readOk<{ turn: TurnResource }>(call, 'GET', HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(sessionId, turnId), 200)
        .then((body) => body.turn);

/** `GET .../turns/{turnId}/display` -> the compiled display tree for one turn. */
export const readDisplay = (call: CanonicalCall, sessionId: string, turnId: string): Promise<TurnDisplay> =>
    readOk<{ display: TurnDisplay }>(
        call,
        'GET',
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdDisplay(sessionId, turnId),
        200
    ).then((body) => body.display);

/**
 * `GET .../turns/{turnId}/events` -> the verbatim recorded events, paired with their
 * recorded times. Composition of every page is opt-in via `allTurnEvents`, because a long
 * run is exactly the case the route exists to bound.
 */
export const readTurnEvents = (
    call: CanonicalCall,
    sessionId: string,
    turnId: string,
    options: { limit?: number; cursor?: string } = {}
): Promise<TurnEventPage> =>
    readOk<TurnEventPage>(
        call,
        'GET',
        withQuery(HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdEvents(sessionId, turnId), {
            limit: options.limit,
            cursor: options.cursor
        }),
        200
    );

/** Every recorded event of one turn, oldest first, following `next_cursor`. */
export const allTurnEvents = async (
    call: CanonicalCall,
    sessionId: string,
    turnId: string,
    limit = 100
): Promise<TurnEventPage['items']> => {
    const rows: TurnEventPage['items'] = [];
    let cursor: string | null | undefined;

    for (;;) {
        const page = await readTurnEvents(call, sessionId, turnId, { limit, cursor: cursor ?? undefined });

        rows.push(...page.items);

        if (page.next_cursor === null) return rows;
        if (page.next_cursor === cursor) throw new Error(`event paging on ${turnId} repeated cursor ${cursor}`);
        cursor = page.next_cursor;
    }
};

/** The event types of one turn, in recorded order — the ordering assertions live in tests. */
export const turnEventTypes = async (call: CanonicalCall, sessionId: string, turnId: string): Promise<string[]> =>
    (await allTurnEvents(call, sessionId, turnId)).map((row) => row.event.type);

/** `GET .../turns/{turnId}/steps/{stepId}` -> the verbatim opening/result event pair. */
export const readStepDetail = (call: CanonicalCall, sessionId: string, turnId: string, stepId: string): Promise<TurnStepDetail> =>
    readOk<{ detail: TurnStepDetail }>(
        call,
        'GET',
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdStepsByStepId(sessionId, turnId, stepId),
        200
    ).then((body) => body.detail);

/** `GET .../turns/{turnId}/blocks/{blockId}` -> one context segment with its recorded text. */
export const readBlockDetail = (call: CanonicalCall, sessionId: string, turnId: string, blockId: string): Promise<TurnBlockDetail> =>
    readOk<{ block: TurnBlockDetail }>(
        call,
        'GET',
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdBlocksByBlockId(sessionId, turnId, blockId),
        200
    ).then((body) => body.block);

// ---------------------------------------------------------------------------
// Threads and transcripts
// ---------------------------------------------------------------------------

/** `GET /v1/harness/sessions/{id}/threads` -> the roster rows (no committed transcript). */
export const listThreads = (call: CanonicalCall, sessionId: string): Promise<ThreadSummary[]> =>
    readOk<ThreadSummaryPage>(call, 'GET', HARNESS_ROUTES.sessionsBySessionIdThreads(sessionId), 200).then(
        (page) => page.items
    );

/** `GET .../threads/{threadId}/transcript/messages` -> one paged slice of the transcript. */
export const readTranscriptMessages = (
    call: CanonicalCall,
    sessionId: string,
    threadId: string,
    options: { limit?: number; cursor?: string; role?: string } = {}
): Promise<TranscriptMessagePage> =>
    readOk<TranscriptMessagePage>(
        call,
        'GET',
        withQuery(HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptMessages(sessionId, threadId), {
            limit: options.limit,
            cursor: options.cursor,
            role: options.role
        }),
        200
    );

/** `GET .../threads/{threadId}/transcript` -> the cheap head (counts/size/validity, no content). */
export const readTranscriptMetadata = (
    call: CanonicalCall,
    sessionId: string,
    threadId: string
): Promise<TranscriptMetadata> =>
    readOk<TranscriptMetadataResponse>(
        call,
        'GET',
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(sessionId, threadId),
        200
    ).then((body) => body.transcript);

/** `GET .../threads/{threadId}/transcript/document` -> the whole transcript as one JSON TEXT. */
export const readTranscriptDocument = (
    call: CanonicalCall,
    sessionId: string,
    threadId: string
): Promise<TranscriptDocumentResponse> =>
    readOk<TranscriptDocumentResponse>(
        call,
        'GET',
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptDocument(sessionId, threadId),
        200
    );

/**
 * `PUT .../threads/{threadId}/transcript` -> the write receipt.
 *
 * `messages` is deliberately `unknown` (the transcript is fully user-editable JSON and a
 * structurally broken value is a SUCCESSFUL write), and `if_revision` is the contract's one
 * optimistic lock — omitted unless the caller supplies it, so a plain write is not a 409.
 */
export const putTranscript = (
    call: CanonicalCall,
    sessionId: string,
    threadId: string,
    messages: unknown,
    ifRevision?: number
): Promise<TranscriptWriteReceipt> =>
    readOk<TranscriptWriteReceipt>(
        call,
        'PUT',
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(sessionId, threadId),
        200,
        ifRevision === undefined ? { messages } : { messages, if_revision: ifRevision }
    );

/** `GET .../turns/{turnId}/attachments/{attachmentId}` -> that attachment's recorded bytes. */
export const readTurnAttachment = (
    call: CanonicalCall,
    sessionId: string,
    turnId: string,
    attachmentId: string
): Promise<AttachmentResponse['attachment']> =>
    readOk<AttachmentResponse>(
        call,
        'GET',
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdAttachmentsByAttachmentId(sessionId, turnId, attachmentId),
        200
    ).then((body) => body.attachment);

// ---------------------------------------------------------------------------
// Deterministic waiting
// ---------------------------------------------------------------------------

/**
 * Poll one canonical read until the submitted turn leaves the running states.
 *
 * The old tests leaned on the submit's own SSE body ending, which meant "the run is over"
 * was observable from the response. The canonical submit is 202 + receipt and the stream is
 * a separate WebSocket subscription, so a test that is not about realtime proves completion
 * the way any REST client does: by re-reading the turn. `pollMs` is fixed, and the helper
 * fails with the last observed record rather than timing out quietly.
 */
export const waitForTurnStatus = async (
    call: CanonicalCall,
    sessionId: string,
    turnId: string,
    wanted: TurnResource['status'][],
    attempts = 400,
    pollMs = 5
): Promise<TurnResource> => {
    let last: TurnResource | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        last = await readTurn(call, sessionId, turnId);
        if (wanted.includes(last.status)) return last;
        await sleep(pollMs);
    }

    throw new Error(
        `turn ${turnId} never reached ${wanted.join('|')} (last: ${JSON.stringify(last?.status)} ${JSON.stringify(last?.error ?? '')})`
    );
};

/** `setTimeout` without importing a timer helper, so the wait is a plain macrotask. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Appends only the parameters that are actually present, keeping the URL byte-exact. */
const withQuery = (pathname: string, params: Record<string, string | number | undefined>): string => {
    const search = Object.entries(params)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');

    return search.length === 0 ? pathname : `${pathname}?${search}`;
};

/** Re-exported so a test can name the frame type without importing the contract twice. */
export type { HarnessEvent };

