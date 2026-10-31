// Thread transcript dialog (R7/R8).
//
// R7 replaces the old plain-text preview with ONE lossless JSON document of the
// conversation the server actually recorded. The authoritative source is the
// session snapshot (`GET /sessions/:id` / every terminal stream frame):
//
//   - `thread`  = the EXACT `SessionThread` object from `SessionSnapshot.threads`,
//                 including its raw `messages` (system prompts, attachments and
//                 tool results included) and every additive roster field;
//   - `turns`   = every raw `SessionTurn` whose `threadId` names this thread. A
//                 failed turn is NOT filtered out: its prompt, status, events,
//                 `eventTimes`, `usage`, `references` and `steers` are copied
//                 exactly as the server stored them;
//   - `relatedEvents` = invocation events that belong to this thread (or its
//                 delegated subtree) but were RECORDED INSIDE ANOTHER TURN. A
//                 delegated child has no `SessionTurn` of its own; its work lives
//                 in the owning parent's turn. Each entry carries provenance
//                 (`turnId`, `turnIndex`, `eventIndex`, `eventTime`) plus the
//                 invocation/thread identity that attributed it;
//   - `relatedSteers` = raw `SessionSteerRecord`s aimed at this thread/subtree but
//                 stored on another turn (`steer.threadId`), with turn/index
//                 provenance. Owned turns keep their own `steers` untouched.
//
// HONESTY: the harness records progress events, not raw provider traffic. There
// is no HTTP request/response body log, header log, retry log or token-by-token
// wire capture anywhere in the server, so this module NEVER fabricates one. The
// document's `limitations` array states exactly what is missing, and
// `session.lastError` is nested under `session` because it is a session-scoped
// field (it may describe a failure that did not run in this thread at all).
//
// The dialog body is a `<pre>` containing `JSON.stringify(document, null, 2)`,
// and the dialog's Copy source is the SAME string. There is no second
// serialization path, so what the reader inspects is exactly what is copied.
//
// Freshness: the board opens from its latest applied snapshot and (when the shell
// wires it) issues ONE `getSession` on the explicit open. Streamed events never
// trigger a read. A refresh that resolves after the dialog closed, after another
// transcript was opened, or after the session changed is ignored; a refresh whose
// snapshot no longer contains the thread CLOSES the dialog instead of continuing
// to label stale content as the thread's transcript.
//
// Cross-references:
//   - snapshot/roster contract: src/server/protocol.ts (SessionSnapshot,
//     SessionThread, SessionTurn)
//   - board wiring/latest source: src/frontend/ui/turns.ts (setSessionSnapshot,
//     openTranscriptOf, action bars)
//   - shell source + delete API: src/frontend/main.ts
//   - shared modal / Copy: src/frontend/ui/dialog.ts
//   - styles: src/frontend/styles.css (`.thread-transcript-json`)
//
// The module is intentionally INTERNAL: it is not re-exported from
// src/frontend/index.ts. The board is its only production caller.

import { openDialog } from './dialog';
import type { DialogHandle } from './dialog';
import type {
    HarnessEvent,
    SessionSnapshot,
    SessionSteerRecord,
    SessionThread,
    SessionTurn
} from '../../server/protocol';
import { threadNameOf, turnThreadIdOf } from './threads';
import type { SessionThreadEntry } from './threads';

// One invocation event found in a turn owned by ANOTHER thread. `threadId` is the
// persistent conversation the invocation was attributed to (absent when the event
// chain names a descendant invocation the roster does not describe yet); `relation`
// makes the target/descendant distinction explicit instead of positional.
export type ThreadTranscriptRelatedEvent = {
    threadId?: string;
    invocationId: string;
    relation: 'target' | 'descendant';
    // Provenance of the record, so a reader can locate the event in the same raw
    // turn list. `eventTime` is the parallel `eventTimes[eventIndex]` entry when the
    // server recorded one; absent for a legacy turn.
    turnId: string;
    turnIndex: number;
    eventIndex: number;
    eventTime?: number;
    event: HarnessEvent;
};

// The exact JSON document rendered and copied by the dialog. Nothing here is a
// summary: `thread` and every entry of `turns`/`relatedEvents.event` are the raw
// server objects, so a later field addition survives without a UI change.
// One steer audit record that belongs to a related conversation but was recorded
// on a turn owned by ANOTHER thread (a delegated child's steer lives on the parent
// turn that owned the running lane). The raw `steer` is copied verbatim so `at`,
// `prompt`, `references` and any additive field survive; provenance names the
// owning turn and the record index.
export type ThreadTranscriptRelatedSteer = {
    threadId: string;
    turnId: string;
    turnIndex: number;
    steerIndex: number;
    steer: SessionSteerRecord;
};

export type ThreadTranscriptJson = {
    schema: 'underload.harness.thread-transcript';
    version: 1;
    generatedAt: number;
    // Deliberately a SUBSET of SessionSnapshot: only fields that describe this
    // inspection snapshot. `lastError` is included when present, but stays nested
    // under `session` to keep its scope unambiguous.
    session: {
        id: string;
        harness: string;
        status: SessionSnapshot['status'];
        updatedAt: number;
        lastError?: string;
    };
    thread: SessionThread;
    turns: SessionTurn[];
    relatedEvents: ThreadTranscriptRelatedEvent[];
    relatedSteers: ThreadTranscriptRelatedSteer[];
    limitations: string[];
};

// Why the JSON cannot be mistaken for a complete API trace. Kept in the document
// (not the UI chrome) so a copied payload carries the disclosure with it.
export const THREAD_TRANSCRIPT_LIMITATIONS: readonly string[] = [
    'No raw provider HTTP request/response bodies, headers, retries or network logs are recorded by this harness; only the events and usage values in this document exist.',
    'messages is the thread\'s committed transcript; while a thread is running, its newest messages may not be committed yet.',
    'session.lastError is session-scoped and may describe a failure that did not run in this thread.'
];

const isObjectLike = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

// The raw roster is server data. A malformed entry is ignored rather than
// rendered as a fake thread; the dialog then reports that the thread is absent.
const rawThreadsOf = (snapshot: SessionSnapshot): SessionThread[] => {
    const value = (snapshot as { threads?: unknown }).threads;
    if (!Array.isArray(value)) return [];

    return value.filter(
        (entry): entry is SessionThread =>
            isObjectLike(entry) && typeof entry.id === 'string' && typeof entry.agent === 'string'
    );
};

// Display name for a raw thread. `threadNameOf` consumes only label/agent/
// sequence, which are identical on the raw and normalized shapes.
const threadName = (thread: SessionThread): string =>
    threadNameOf(thread as unknown as SessionThreadEntry);

// Every invocation id the roster knows for one thread: the full historical map
// plus both single slots (a server that predates `invocationIds` still names its
// latest/origin runs). Deduplicated in first-seen order.
const invocationIdsOf = (thread: SessionThread): string[] => {
    const ids: string[] = [];
    const push = (value: unknown): void => {
        if (typeof value !== 'string' || value.length === 0 || ids.includes(value)) return;
        ids.push(value);
    };

    push(thread.invocationId);
    push(thread.originInvocationId);
    if (Array.isArray(thread.invocationIds)) for (const id of thread.invocationIds) push(id);

    return ids;
};

const eventThreadOf = (event: HarnessEvent): { id: string; parentId?: string } | undefined => {
    const source = event as { thread?: unknown };
    if (!isObjectLike(source.thread)) return undefined;

    const id = source.thread.id;
    if (typeof id !== 'string' || id.length === 0) return undefined;

    const parentId = source.thread.parentId;
    return {
        id,
        ...(typeof parentId === 'string' && parentId.length > 0 ? { parentId } : {})
    };
};

// Build the persistent-thread subtree rooted at `threadId` using the roster's
// `ownerThreadId` links. BFS with a seen-set makes a corrupt/cyclic chain
// terminate and never attributes a sibling conversation as a descendant.
const relatedThreadsOf = (
    threads: readonly SessionThread[],
    threadId: string
): Map<string, 'target' | 'descendant'> => {
    const related = new Map<string, 'target' | 'descendant'>([[threadId, 'target']]);
    const queue: string[] = [threadId];

    while (queue.length > 0) {
        const owner = queue.shift() as string;
        for (const candidate of threads) {
            if (candidate.ownerThreadId !== owner || related.has(candidate.id)) continue;

            related.set(candidate.id, 'descendant');
            queue.push(candidate.id);
        }
    }

    return related;
};

// The full JSON document for ONE persistent thread, or undefined when the
// snapshot does not describe that thread. Pure: no DOM, no network, no clock
// except the explicit `generatedAt` (tests pass a fixed value; the UI lets it
// default to the open/refresh time).
export const buildThreadTranscriptJson = (
    snapshot: SessionSnapshot,
    threadId: string,
    options: { generatedAt?: number } = {}
): ThreadTranscriptJson | undefined => {
    const threads = rawThreadsOf(snapshot);
    const thread = threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) return undefined;

    const allTurns = Array.isArray(snapshot.turns) ? snapshot.turns : [];

    // Owned history: the raw turns whose stable thread identity is this one. No
    // status filter: a failed/cancelled turn is exactly the history the reader is
    // inspecting, and its rolled-back `messages` are still represented by the raw
    // `thread.messages` of the committed thread.
    const turns = allTurns.filter((turn) => turnThreadIdOf(turn) === threadId);

    // Persistent threads in this thread's delegation subtree (roster links).
    const relatedThreads = relatedThreadsOf(threads, threadId);

    // invocation -> attributed persistent thread. Roster-provided mappings come
    // first so an exact persistent identity wins over a parent-chain inference.
    const invocationThreads = new Map<string, string>();
    for (const [relatedId] of relatedThreads) {
        const relatedThread = threads.find((candidate) => candidate.id === relatedId);
        if (relatedThread === undefined) continue;
        for (const invocationId of invocationIdsOf(relatedThread)) {
            if (!invocationThreads.has(invocationId)) invocationThreads.set(invocationId, relatedId);
        }
    }

    // Related events are scanned ONLY in turns owned by a different thread: the
    // target's own turns already contain their events verbatim in `turns`. Events
    // are attributed by (1) the roster's invocation map, or (2) a `thread.parentId`
    // chain that reaches an already-attributed invocation (descendants recorded
    // without their own roster entry).
    const attributed = new Map(invocationThreads);
    const relatedEvents: ThreadTranscriptRelatedEvent[] = [];

    for (const turn of allTurns) {
        if (turnThreadIdOf(turn) === threadId) continue;

        const events = Array.isArray(turn.events) ? turn.events : [];
        const times = Array.isArray(turn.eventTimes) ? turn.eventTimes : [];

        for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
            const event = events[eventIndex];
            const identity = eventThreadOf(event);
            if (identity === undefined) continue;

            let attributedThread = attributed.get(identity.id);
            if (attributedThread === undefined && identity.parentId !== undefined) {
                // Descendants by parentId: the parent chain is the runtime's
                // authoritative invocation lineage, independent of roster timing.
                const parentThread = attributed.get(identity.parentId);
                if (parentThread !== undefined) {
                    attributedThread = parentThread;
                    attributed.set(identity.id, parentThread);
                }
            }
            if (attributedThread === undefined) continue;

            const eventTime = times[eventIndex];
            relatedEvents.push({
                threadId: attributedThread,
                invocationId: identity.id,
                relation: attributedThread === threadId ? 'target' : 'descendant',
                turnId: turn.id,
                turnIndex: turn.index,
                eventIndex,
                ...(typeof eventTime === 'number' && Number.isFinite(eventTime) ? { eventTime } : {}),
                event
            });
        }
    }

    // Related STEERS are audit records, not progress events. `SessionSteerRecord`
    // lives on the turn that owned the running lane; `threadId` names the
    // conversation the guidance was actually delivered to. A child/descendant's
    // steer therefore sits on the parent's turn. Include exactly the records whose
    // target is this thread or a roster descendant, with turn provenance; a steer
    // aimed at a sibling (or one with no threadId, which belongs to its owner turn)
    // stays out. Owned turns above retain their own `steers` unchanged.
    const relatedSteers: ThreadTranscriptRelatedSteer[] = [];
    for (const turn of allTurns) {
        if (turnThreadIdOf(turn) === threadId) continue;

        const steers = Array.isArray(turn.steers) ? turn.steers : [];
        for (let steerIndex = 0; steerIndex < steers.length; steerIndex += 1) {
            const steer = steers[steerIndex];
            if (!isObjectLike(steer) || typeof steer.threadId !== 'string') continue;
            if (!relatedThreads.has(steer.threadId)) continue;

            relatedSteers.push({
                threadId: steer.threadId,
                turnId: turn.id,
                turnIndex: turn.index,
                steerIndex,
                steer: steer as unknown as SessionSteerRecord
            });
        }
    }

    const lastError = typeof snapshot.lastError === 'string' ? snapshot.lastError : undefined;

    return {
        schema: 'underload.harness.thread-transcript',
        version: 1,
        generatedAt:
            typeof options.generatedAt === 'number' && Number.isFinite(options.generatedAt)
                ? options.generatedAt
                : Date.now(),
        session: {
            id: snapshot.id,
            harness: snapshot.harness,
            status: snapshot.status,
            updatedAt: snapshot.updatedAt,
            ...(lastError === undefined ? {} : { lastError })
        },
        thread,
        turns,
        relatedEvents,
        relatedSteers,
        limitations: [...THREAD_TRANSCRIPT_LIMITATIONS]
    };
};

// Pretty JSON is the ONE wire between the dialog body and its Copy source.
export const serializeThreadTranscript = (transcript: ThreadTranscriptJson): string =>
    JSON.stringify(transcript, null, 2);

// Convenience for callers that only need the copied text. Undefined preserves the
// board's existing honesty rule: a missing thread offers no dialog at all.
export const threadTranscriptCopyText = (
    snapshot: SessionSnapshot,
    threadId: string,
    options: { generatedAt?: number } = {}
): string | undefined => {
    const transcript = buildThreadTranscriptJson(snapshot, threadId, options);
    return transcript === undefined ? undefined : serializeThreadTranscript(transcript);
};

// --- DOM --------------------------------------------------------------------

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

// Render the exact document as inert text. Never build this from innerHTML: the
// payload carries model/tool text and must stay data, not markup.
export const threadTranscriptContent = (transcript: ThreadTranscriptJson): HTMLElement => {
    const host = el('div', 'thread-transcript');
    const turnCount = transcript.turns.length;
    const meta = el(
        'p',
        'thread-transcript-meta',
        `${threadName(transcript.thread)} · ${transcript.thread.agent} · ${transcript.thread.status} · ${
            turnCount === 1 ? '1 turn' : `${turnCount} turns`
        } · JSON snapshot`
    );
    const json = el('pre', 'thread-transcript-json');
    json.textContent = serializeThreadTranscript(transcript);
    // Screen readers get the same disclosure that is copied; the <pre> is the
    // accessible reading surface for the document.
    json.setAttribute('aria-label', `JSON transcript of thread ${threadName(transcript.thread)}`);
    host.append(meta, json);
    return host;
};

// The single open transcript this UI owns. `scope` is the board identity from
// ui/turns.ts; `sessionId` guards a stale refresh that resolves after a session
// switch with a coincidentally equal thread id. The handle comparison is what
// makes a second transcript replace tracking without letting the first one's
// late async refresh write into the new dialog.
type ActiveTranscript = {
    threadId: string;
    sessionId: string;
    scope: object;
    handle: DialogHandle;
};

let activeTranscript: ActiveTranscript | undefined;

// Open the shared modal with the complete JSON document. Undefined means the
// snapshot does not describe the requested thread, so the caller must not claim
// to have opened anything.
export const openThreadTranscript = (
    snapshot: SessionSnapshot,
    threadId: string,
    scope: object = {},
    options: { generatedAt?: number } = {}
): DialogHandle | undefined => {
    const transcript = buildThreadTranscriptJson(snapshot, threadId, options);
    if (transcript === undefined) return undefined;

    const copy = serializeThreadTranscript(transcript);
    const handle: DialogHandle = openDialog({
        title: `Transcript · ${threadName(transcript.thread)} · ${transcript.thread.agent}`,
        content: threadTranscriptContent(transcript),
        copy,
        onClose: () => {
            if (activeTranscript?.handle === handle) activeTranscript = undefined;
        }
    });
    activeTranscript = { threadId, sessionId: snapshot.id, scope, handle };
    return handle;
};

// Result of a refresh attempt. 'closed' is deliberately observable: the board
// reports that the thread vanished instead of leaving a stale dialog on screen.
export type ThreadTranscriptRefresh = 'updated' | 'closed' | 'ignored';

// Refresh the open transcript from a newer authority of the SAME board/session.
// Only the tracked dialog is touched. A missing thread closes it; a different
// session id is ignored (the board closes/moves on session switches explicitly).
export const refreshOpenThreadTranscript = (
    snapshot: SessionSnapshot,
    scope: object
): ThreadTranscriptRefresh => {
    if (
        activeTranscript === undefined ||
        activeTranscript.scope !== scope ||
        !activeTranscript.handle.isOpen
    ) {
        return 'ignored';
    }

    // A late GET for a session the reader already left must not rewrite the
    // dialog (thread ids are only unique per session).
    if (activeTranscript.sessionId !== snapshot.id) return 'ignored';

    const transcript = buildThreadTranscriptJson(snapshot, activeTranscript.threadId);
    if (transcript === undefined) {
        activeTranscript.handle.close();
        activeTranscript = undefined;
        return 'closed';
    }

    activeTranscript.handle.update({
        title: `Transcript · ${threadName(transcript.thread)} · ${transcript.thread.agent}`,
        content: threadTranscriptContent(transcript),
        copy: serializeThreadTranscript(transcript)
    });
    return 'updated';
};

// Close the tracked transcript when it belongs to this scope (and, optionally,
// one of the doomed thread ids). `undefined` ids means "close any transcript of
// this board", used by the session switch/teardown path.
export const closeThreadTranscript = (
    scope: object,
    threadIds?: readonly string[]
): boolean => {
    if (activeTranscript === undefined || activeTranscript.scope !== scope) return false;
    if (threadIds !== undefined && !threadIds.includes(activeTranscript.threadId)) return false;

    activeTranscript.handle.close();
    activeTranscript = undefined;
    return true;
};
