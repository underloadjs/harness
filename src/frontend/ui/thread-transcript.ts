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
// The dialog body is a `<pre>` containing `JSON.stringify(document, null, 2)`. The
// dialog's Copy source is a CLICK-TIME provider over the live panel (T1/R3), so there
// is no second serialization path and what the reader inspects is exactly what lands
// on the clipboard — before and after a refresh alike, and in either mode.
//
// EDITABLE (C5): the transcript is the user's own JSON, so the dialog also offers an
// edit mode. "Edit transcript" swaps the document for a `<textarea
// class="thread-transcript-editor">` holding ONLY the editable value (the thread's
// `messages`, pretty-printed — what `transcript.raw` names on the server), plus Save /
// Cancel / Copy and an inline `.thread-transcript-error` area. Above the field sits one
// muted line (`.thread-transcript-note`, `THREAD_TRANSCRIPT_SAVE_NOTE`) stating that a
// save replaces only these messages: the read-only document also carries turns, events
// and steers, which are session history this route never writes (C6). Save parses
// locally (`invalid JSON: …` keeps the text and the editor), then PUTs the parsed value
// through the host-provided transport; the host applies the returned session snapshot
// and the dialog repaints from the returned transcript. A structurally invalid value is
// a 200, not a failure: the write succeeded and the answer carries `transcript.invalid`,
// which becomes the banner while the text stays exactly as sent.
//
// UNREADABLE (C5): a thread named in `SessionSnapshot.invalidThreads` opens DIRECTLY
// in the editor with `transcript unreadable: <error>` and the raw stored value, because
// the only useful thing this surface can do then is let the reader fix it by hand. The
// text is that roster entry's `messages` VERBATIM (ui/threads.ts `invalidThreadsOf` →
// `invalidTranscriptRaw`), NEVER the placeholder the server installs in
// `threads[].messages` and in `transcript.messages` for the same thread (`[{ role:
// 'system', content: '[transcript unreadable: …]' }]`): the placeholder is what the
// MODEL is sent, and editing it would destroy the value the reader came to repair. A
// refresh into or out of that state never closes the dialog, and a refresh NEVER
// replaces the textarea's text — only an explicit Save, Cancel or a different thread
// does — so unrelated stream frames cannot destroy an in-progress repair.
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
//     SessionThread, SessionTurn) plus the additive C4 `invalidThreads` roster, read
//     structurally in ui/threads.ts (`invalidThreadsOf`)
//   - transcript routes: src/frontend/api.ts (`getThreadTranscript`,
//     `updateThreadTranscript`) and the save transport wired in main.ts
//   - board wiring/latest source: src/frontend/ui/turns.ts (setSessionSnapshot,
//     openTranscriptOf, action bars)
//   - shell source + delete API: src/frontend/main.ts
//   - shared modal / Copy: src/frontend/ui/dialog.ts
//   - styles: src/frontend/styles.css (`.thread-transcript-json`,
//     `.thread-transcript-editor`, `.thread-transcript-error`,
//     `.thread-transcript-note`, `.thread-transcript-actions`)
//
// The module is intentionally INTERNAL: it is not re-exported from
// src/frontend/index.ts. The board is its only production caller.

import { createTextCopyButton, openDialog } from './dialog';
import type { DialogHandle } from './dialog';
import type {
    HarnessEvent,
    SessionSnapshot,
    SessionSteerRecord,
    SessionThread,
    SessionTurn
} from '../../server/protocol';
import type { ThreadTranscriptPayload } from '../api';
import { UNKNOWN_THREAD_LABEL, invalidThreadsOf, threadNameOf, turnThreadIdOf } from './threads';
import type { InvalidThreadRecord, SessionThreadEntry } from './threads';

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

const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

// Pretty JSON of a stored value that is NOT a readable transcript. The editor must
// always hold something the reader can repair, and what Save sends back is exactly
// what is on screen, so even a scalar is written in its JSON spelling (`"text"`, not
// the bare word): the text in the box therefore always round-trips through
// `JSON.parse` to the same value. `undefined`/an unserializable value has no JSON
// spelling, and a server can only have persisted what JSON can carry, so the fallback
// is the document `null` rather than a fabricated transcript.
export const invalidTranscriptRaw = (messages: unknown): string => {
    try {
        const text = JSON.stringify(messages, null, 2);
        return typeof text === 'string' ? text : 'null';
    } catch {
        return 'null';
    }
};

// The editable document of a READABLE thread: its `messages`, pretty-printed. The
// server's `transcript.raw` is the same value (pretty JSON of the editable value), so
// a dialog opened from a snapshot and one opened from the transcript route show
// byte-identical text.
export const threadTranscriptEditorRaw = (thread: SessionThread | undefined): string =>
    invalidTranscriptRaw(thread?.messages ?? []);

// The C4 invalid roster entry for one thread, read STRUCTURALLY: the field is
// additive, so an older snapshot simply has none and every pre-C5 behaviour is
// byte-identical.
const invalidThreadOf = (
    snapshot: SessionSnapshot,
    threadId: string
): InvalidThreadRecord | undefined =>
    invalidThreadsOf(snapshot).find((record) => record.id === threadId);

// Header identity for either surface. The raw roster wins; a conversation named ONLY
// in `invalidThreads` has no `SessionThread`, so its server label is the next
// authority and `UNKNOWN_THREAD_LABEL` (ui/threads.ts) is the codebase's honest
// "no roster identity" token — never an invented ordinal.
type TranscriptIdentity = {
    threadId: string;
    name: string;
    agent: string;
    status: string;
};

const identityOf = (
    snapshot: SessionSnapshot,
    threadId: string,
    invalid?: InvalidThreadRecord
): TranscriptIdentity => {
    const thread = rawThreadsOf(snapshot).find((candidate) => candidate.id === threadId);
    if (thread !== undefined) {
        return { threadId, name: threadName(thread), agent: thread.agent, status: thread.status };
    }

    return {
        threadId,
        name: invalid?.label ?? UNKNOWN_THREAD_LABEL,
        agent: invalid?.agent ?? '',
        status: 'unknown'
    };
};

// Everything the editor surface renders: identity, the text to repair, and the
// server-side read failure that put it in that state (when there is one).
type EditorAuthority = TranscriptIdentity & { raw: string; error?: string };

const editorAuthorityOf = (
    snapshot: SessionSnapshot,
    threadId: string,
    invalid?: InvalidThreadRecord
): EditorAuthority => {
    const identity = identityOf(snapshot, threadId, invalid);

    if (invalid === undefined) {
        const thread = rawThreadsOf(snapshot).find((candidate) => candidate.id === threadId);
        return { ...identity, raw: threadTranscriptEditorRaw(thread) };
    }

    return { ...identity, raw: invalidTranscriptRaw(invalid.messages), error: invalid.error };
};

const dialogTitle = (identity: TranscriptIdentity): string =>
    `Transcript · ${identity.name} · ${identity.agent}`;

// The editor's header line: which conversation this text belongs to, whether it is
// live, and that what follows is EDITABLE (the document view says `JSON snapshot`).
const editorMeta = (identity: TranscriptIdentity): string =>
    `${identity.name} · ${identity.agent} · ${identity.status} · editing JSON`;

// C6: what Save actually writes. The read surface shows a whole conversation (thread +
// turns + related events + steers), but the PUT carries ONLY `messages`, so the editor
// states that in one line above the textarea. Without it a reader repairing an
// unreadable thread can reasonably fear the run history below is being replaced, and
// the transcript route's answer (`transcript.raw`) never says otherwise.
//
// A `<p>` in the dialog's document order (identity → error → note → field), muted and
// small in styles.css: it is disclosure, not a control. No id/aria wiring because the
// shared modal already reads the adopted content top-to-bottom, and a stacked second
// transcript would otherwise duplicate the id.
export const THREAD_TRANSCRIPT_SAVE_NOTE =
    'Save replaces only this thread\'s transcript messages. Turns and events are session history and are never changed.';

// The shared modal has NO actions API, so a dialog's own buttons live in the adopted
// content node — the same precedent as the board's delete-confirmation row
// (ui/turns.ts `createThreadActionBar`). `hidden` on the bar itself is never used
// here: both bars are always meaningful in the mode that renders them.
const transcriptActions = (className: string, ...buttons: HTMLElement[]): HTMLElement => {
    const bar = el('div', `thread-transcript-actions ${className}`);
    bar.setAttribute('role', 'group');
    bar.append(...buttons);
    return bar;
};

const actionButton = (className: string, label: string): HTMLButtonElement => {
    const button = el('button', className, label);
    button.type = 'button';
    return button;
};

// The read-only document + the affordance that leaves it. Never built from innerHTML:
// the payload carries model/tool text and must stay data, not markup.
const readContent = (input: {
    name: string;
    meta: string;
    json: string;
    onEdit?: () => void;
}): HTMLElement => {
    const host = el('div', 'thread-transcript');
    const meta = el('p', 'thread-transcript-meta', input.meta);

    const json = el('pre', 'thread-transcript-json');
    json.textContent = input.json;
    // Screen readers get the same disclosure that is copied; the <pre> is the
    // accessible reading surface for the document.
    json.setAttribute('aria-label', `JSON transcript of thread ${input.name}`);
    host.append(meta, json);

    if (input.onEdit !== undefined) {
        const edit = actionButton('thread-transcript-edit', 'Edit transcript');
        edit.title = 'Edit the transcript JSON of this thread';
        edit.addEventListener('click', input.onEdit);
        host.append(transcriptActions('thread-transcript-read-actions', edit));
    }

    return host;
};

// Render the exact document as inert text. `onEdit` adds the Edit affordance, so the
// dialog's read surface is one click away from the editor; omitted, the builder is the
// historical read-only surface (no dead control).
export const threadTranscriptContent = (
    transcript: ThreadTranscriptJson,
    onEdit?: () => void
): HTMLElement => {
    const name = threadName(transcript.thread);
    const turnCount = transcript.turns.length;

    return readContent({
        name,
        meta: `${name} · ${transcript.thread.agent} · ${transcript.thread.status} · ${
            turnCount === 1 ? '1 turn' : `${turnCount} turns`
        } · JSON snapshot`,
        json: serializeThreadTranscript(transcript),
        ...(onEdit === undefined ? {} : { onEdit })
    });
};

// The read surface built straight from a transcript-route answer (`PUT` result): the
// saved value and its message count. The next snapshot refresh replaces it with the
// full lossless document (turns, related events, limitations), so this view only
// lives between a save and the frame that re-reads the session.
type PayloadReadView = { name: string; agent: string; messages: number; raw: string };

const payloadReadContent = (view: PayloadReadView, onEdit: () => void): HTMLElement =>
    readContent({
        name: view.name,
        meta: `${view.name} · ${view.agent} · ${
            view.messages === 1 ? '1 message' : `${view.messages} messages`
        } · saved transcript`,
        json: view.raw,
        onEdit
    });

// The editable surface: identity line, error area (local parse/server failures AND
// the unreadable banner), the raw JSON textarea, and Save / Cancel / Copy.
//
// `state.text` is the ONLY source of the textarea's value, and it is written back into
// `state` on every input event, so a later repaint of this surface (never triggered
// by a snapshot frame) can restore exactly what the reader typed.
const editorContent = (state: TranscriptState): HTMLElement => {
    const authority = state.editor;

    const host = el('div', 'thread-transcript thread-transcript-editing');
    const meta = el('p', 'thread-transcript-meta', editorMeta(authority));

    const error = el('p', 'thread-transcript-error');
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');

    const editor = el('textarea', 'thread-transcript-editor');
    editor.value = state.text;
    // A sane default height for a browser that has not loaded the stylesheet (and for
    // jsdom, which has no layout at all); styles.css owns the real size.
    editor.rows = 24;
    // The text is JSON, not prose: no spellcheck waves, no capitalisation or
    // autocorrect rewriting a key or a string value on mobile.
    editor.spellcheck = false;
    editor.setAttribute('autocapitalize', 'off');
    editor.setAttribute('autocomplete', 'off');
    editor.setAttribute('autocorrect', 'off');
    editor.setAttribute('aria-label', `Editable JSON transcript of thread ${authority.name}`);
    editor.addEventListener('input', () => {
        state.text = editor.value;
        state.dirty = editor.value !== state.baseline;
        // Typing again means the reader is acting on the banner: it describes the
        // PREVIOUS attempt, so it must not keep claiming the current text is broken.
        if (state.localError !== undefined) {
            state.localError = undefined;
            paintEditorChrome(state);
        }
    });

    const save = actionButton('thread-transcript-save', 'Save');
    save.addEventListener('click', () => {
        void saveTranscript(state);
    });

    const cancel = actionButton('thread-transcript-cancel', 'Cancel');
    cancel.addEventListener('click', () => cancelEdit(state));

    // C6: one static disclosure line about what Save changes (see
    // `THREAD_TRANSCRIPT_SAVE_NOTE`). Built with the surface, never repainted: it does
    // not depend on state, so a refresh cannot desync it from the field below it.
    const note = el('p', 'thread-transcript-note', THREAD_TRANSCRIPT_SAVE_NOTE);

    // Copy uses the shell's shared control so the plain-HTTP LAN deployment (no
    // `navigator.clipboard`) still works: the clipboard fallback with its focus-trap
    // exemption is the part every hand-rolled copy button got wrong (ui/dialog.ts).
    const copy = createTextCopyButton({
        label: 'Copy the transcript JSON',
        text: () => editor.value,
        className: 'thread-transcript-copy'
    });
    copy.append(el('span', 'action-label', 'Copy'));

    host.append(
        meta,
        error,
        note,
        editor,
        transcriptActions('thread-transcript-edit-actions', save, cancel, copy)
    );

    // Paint the initial error/Save state directly: `state.handle` does not exist yet
    // (this runs while the dialog is being built), so the panel cannot be queried.
    const line = errorLineOf(state);
    error.textContent = line.text;
    error.hidden = line.text.length === 0;
    error.dataset.tone = line.tone;
    paintSaveButton(state, save);

    return host;
};

// Save's enabled state is one rule in two places (initial build + later repaints):
// unwired hosts say so instead of pretending the press does something, and an
// in-flight PUT cannot be pressed twice.
const paintSaveButton = (state: TranscriptState, button: HTMLButtonElement): void => {
    const wired = state.onSave !== undefined;
    button.disabled = !wired || state.pending;
    button.title = state.pending
        ? 'Saving this transcript...'
        : wired
          ? 'Save this JSON as the thread transcript'
          : 'Transcript saving is not wired in this host.';
};

// The single error line, in priority order and with its origin, so the reader always
// sees WHICH failure they are looking at:
//   `local`   — the browser refused the text; nothing left this page;
//   `request` — the server refused the write (409/404/400/500), with its own message;
//   `server`  — the write is fine, but the stored transcript cannot be read.
// The reader's own failure outranks the unreadable banner: it is the thing they must
// act on before anything else.
type ErrorLine = { text: string; tone: 'local' | 'request' | 'server' };

const errorLineOf = (state: TranscriptState): ErrorLine => {
    const local = state.localError;
    if (local !== undefined) return { text: local, tone: state.localErrorTone };

    const server = state.serverError;
    if (server === undefined) return { text: '', tone: 'server' };

    return { text: `transcript unreadable: ${server}`, tone: 'server' };
};

// Repaint what a refresh/save/can change WITHOUT rebuilding the editor: rebuilding
// replaces the textarea and with it the reader's caret and unsaved text, which is the
// property this dialog must keep across unrelated stream frames. Every node is read
// from THIS dialog's own panel, so a stacked second transcript cannot be repainted by
// the first one's late answer.
const paintEditorChrome = (state: TranscriptState): void => {
    // Only the EDIT surface has this chrome. After a successful save the panel already
    // holds the read view, whose own `.thread-transcript-meta` must keep the document
    // wording instead of being re-labelled by a late pending-state repaint.
    if (state.mode !== 'edit' || !state.handle.isOpen) return;

    const panel = state.handle.element;

    const meta = panel.querySelector<HTMLElement>('.thread-transcript-meta');
    if (meta !== null) meta.textContent = editorMeta(state.editor);

    const error = panel.querySelector<HTMLElement>('.thread-transcript-error');
    if (error !== null) {
        const line = errorLineOf(state);
        error.textContent = line.text;
        error.hidden = line.text.length === 0;
        error.dataset.tone = line.tone;
    }

    const save = panel.querySelector<HTMLButtonElement>('.thread-transcript-save');
    if (save !== null) paintSaveButton(state, save);
};

// T1/R3: the dialog's Copy SOURCE, resolved at CLICK time from the live panel. It
// always writes what the reader is looking at: the read-only document, or the
// editor's CURRENT text including unsaved edits. Querying the panel (instead of
// capturing one node) is what keeps the provider correct across a mode switch, where
// the content node is replaced but the header button is not.
//
// A missing/empty DOCUMENT surface throws, which the dialog reports as a failed copy
// rather than an empty success; an empty EDITOR is a legitimate state (the reader is
// mid-repair) and copies as such.
const transcriptCopySource = (state: TranscriptState): (() => string) => () => {
    const panel = state.handle.element;

    const editor = panel.querySelector<HTMLTextAreaElement>('.thread-transcript-editor');
    if (editor !== null) return editor.value;

    const surface = panel.querySelector<HTMLElement>('.thread-transcript-json');
    if (surface === null) {
        throw new Error('thread transcript content has no .thread-transcript-json surface');
    }

    const text = surface.textContent;
    if (typeof text !== 'string' || text.length === 0) {
        throw new Error('thread transcript surface holds no text');
    }

    return text;
};

// The single open transcript this UI owns. `scope` is the board identity from
// ui/turns.ts; `sessionId` guards a stale refresh that resolves after a session
// switch with a coincidentally equal thread id. The identity comparison is what makes
// a second transcript replace tracking without letting the first one's late async
// refresh write into the new dialog.
type TranscriptState = {
    threadId: string;
    sessionId: string;
    scope: object;
    handle: DialogHandle;
    mode: 'read' | 'edit';
    // Newest lossless document. Both leaving the editor (Cancel) and entering it
    // render from here, so a snapshot that arrived while the reader was typing cannot
    // be shown as an older document afterwards.
    document?: ThreadTranscriptJson;
    // Read view installed by a successful save, until a snapshot refresh upgrades it
    // to the full document above.
    payloadView?: PayloadReadView;
    // Newest editable authority (identity + raw + the server's read failure).
    editor: EditorAuthority;
    // `invalidThreads` / `transcript.invalid` error, shown as the unreadable banner.
    serverError?: string;
    // Failure of the LAST attempt (local parse error, transport error). Kept apart
    // from `serverError` so a frame that makes the transcript readable again can clear
    // the banner without hiding a message the reader has not acted on yet.
    localError?: string;
    // Which kind of failure `localError` is: `local` = the browser refused the text,
    // `request` = the server refused the write. The banner is the same line either
    // way, but the TONE tells the reader whether to fix the JSON or the situation.
    localErrorTone: 'local' | 'request';
    // The text in the textarea, and the value it was last set to PROGRAMMATICALLY.
    // `dirty` (the two differ) is exactly the unsaved work a refresh must not throw
    // away; only an explicit Save/Cancel or opening a different thread re-bases it.
    text: string;
    baseline: string;
    dirty: boolean;
    pending: boolean;
    // Host transport, already bound to this session + thread. Resolves with the
    // transcript answer; the host owns applying the returned session snapshot.
    onSave?: (messages: unknown) => Promise<ThreadTranscriptPayload>;
};

let activeTranscript: TranscriptState | undefined;

// Paints the read-only surface. Returns false when NOTHING readable is known (a
// transcript that is still unreadable and has never been saved), so a caller keeps the
// editor instead of replacing it with an empty document.
const paintRead = (state: TranscriptState): boolean => {
    const doc = state.document;
    const view = state.payloadView;
    if (doc === undefined && view === undefined) return false;

    state.mode = 'read';
    state.handle.update({
        title: dialogTitle(state.editor),
        content:
            doc !== undefined
                ? threadTranscriptContent(doc, () => enterEdit(state))
                : payloadReadContent(view as PayloadReadView, () => enterEdit(state))
    });

    return true;
};

// Entering the editor is an explicit navigation: the text starts from the newest
// authority (any earlier draft was either discarded by Cancel or committed by Save),
// and focus goes to the textarea the reader just asked for.
const enterEdit = (state: TranscriptState): void => {
    state.mode = 'edit';
    state.text = state.editor.raw;
    state.baseline = state.editor.raw;
    state.dirty = false;
    state.localError = undefined;

    state.handle.update({ title: dialogTitle(state.editor), content: editorContent(state) });
    state.handle.element
        .querySelector<HTMLTextAreaElement>('.thread-transcript-editor')
        ?.focus({ preventScroll: true });
};

// Cancel discards the draft and returns to the document the reader was reading. An
// unreadable transcript has no document to return to, so Cancel re-bases the editor to
// the server's raw value instead: that IS the explicit refresh the text is allowed to
// be replaced by.
const cancelEdit = (state: TranscriptState): void => {
    state.localError = undefined;
    state.dirty = false;
    if (paintRead(state)) return;

    state.text = state.editor.raw;
    state.baseline = state.editor.raw;
    state.handle.update({ title: dialogTitle(state.editor), content: editorContent(state) });
};

// The PUT answer is the newest authority for the editable value. The host has already
// applied `result.session` through its normal snapshot path; the dialog repaints from
// `result.transcript` and the resulting frame upgrades the view to the full document.
const applySavedPayload = (state: TranscriptState, payload: ThreadTranscriptPayload): void => {
    const invalid = payload.invalid;
    state.serverError = invalid?.error;
    // Whatever happened to the document, the text that was sent is now what the server
    // holds: the draft is re-based, so it is no longer "unsaved work".
    state.baseline = state.text;
    state.dirty = false;
    state.localError = undefined;

    if (invalid !== undefined) {
        // The write SUCCEEDED and the result is unreadable. Stay in the editor with
        // the text exactly as sent and say so: closing (or switching to a document
        // view built from a placeholder) would hide the break the reader caused.
        // `status` is unknown to the payload, so the identity keeps the last value
        // until the applied snapshot refreshes it.
        state.editor = { ...state.editor, raw: state.text, error: invalid.error };
        state.mode = 'edit';
        paintEditorChrome(state);
        return;
    }

    state.editor = {
        ...state.editor,
        agent: payload.agent,
        raw: typeof payload.raw === 'string' ? payload.raw : invalidTranscriptRaw(payload.messages)
    };
    // The saved value is now the newest readable authority. The stale lossless
    // document (built from the PRE-save messages) is dropped so the payload view is
    // what the reader sees; the snapshot the host just applied rebuilds the full
    // document immediately afterwards.
    state.document = undefined;
    state.payloadView = {
        name: state.editor.name,
        agent: payload.agent,
        messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
        raw: state.editor.raw
    };

    // Readable again: leave the editor for the saved document.
    if (!paintRead(state)) paintEditorChrome(state);
};

// Save: parse locally, then hand the parsed value to the host transport.
//
// Deterministic failure rules: a JSON the browser refuses never reaches the network
// and never loses the text; a server failure keeps the text and re-enables Save; and
// a 200 whose transcript is invalid is a SUCCESS (the write landed) shown as a banner,
// not an error to retry.
const saveTranscript = async (state: TranscriptState): Promise<void> => {
    if (state.pending || state.onSave === undefined) return;

    let parsed: unknown;
    try {
        parsed = JSON.parse(state.text);
    } catch (error) {
        state.localError = `invalid JSON: ${messageOf(error)}`;
        state.localErrorTone = 'local';
        paintEditorChrome(state);
        return;
    }

    const transport = state.onSave;
    state.pending = true;
    state.localError = undefined;
    paintEditorChrome(state);

    try {
        applySavedPayload(state, await transport(parsed));
    } catch (error) {
        // The host may already have applied a newer snapshot behind this failure; the
        // editor and its text survive so the reader can retry or cancel.
        state.localError = messageOf(error);
        state.localErrorTone = 'request';
        paintEditorChrome(state);
    } finally {
        state.pending = false;
        // A closed dialog has no Save button left to re-enable, and a read-mode panel
        // has no editor chrome to repaint; both are no-ops inside the painter.
        paintEditorChrome(state);
    }
};

// Open the shared modal with the complete JSON document, or with the editor when the
// transcript cannot be read. Undefined means the snapshot describes the requested
// thread NEITHER way, so the caller must not claim to have opened anything.
export const openThreadTranscript = (
    snapshot: SessionSnapshot,
    threadId: string,
    scope: object = {},
    options: {
        generatedAt?: number;
        // PUT transport, bound by the board to this session + thread (main.ts supplies
        // it). Omitted => Save is rendered disabled and explains why.
        onSave?: (messages: unknown) => Promise<ThreadTranscriptPayload>;
    } = {}
): DialogHandle | undefined => {
    const invalid = invalidThreadOf(snapshot, threadId);
    const transcript = buildThreadTranscriptJson(snapshot, threadId, options);

    // An unreadable transcript IS still a conversation the reader has to fix, so the
    // invalid record alone opens the dialog; only a thread the snapshot does not name
    // at all offers nothing.
    if (transcript === undefined && invalid === undefined) return undefined;

    const editor = editorAuthorityOf(snapshot, threadId, invalid);
    // An invalid transcript opens DIRECTLY in the editor: the document view would have
    // nothing to show, and repairing the JSON is the only useful action here.
    const mode: 'read' | 'edit' = transcript === undefined || invalid !== undefined ? 'edit' : 'read';

    const state: TranscriptState = {
        threadId,
        sessionId: snapshot.id,
        scope,
        // Assigned on the next statement. Every reader of this field is a click, a
        // refresh or a save continuation, so none can observe the placeholder.
        handle: undefined as unknown as DialogHandle,
        mode,
        // An INVALID transcript has no trustworthy document: the server's `thread`
        // row (and therefore the document) carries a placeholder for the unreadable
        // value, so the editor is the only honest surface while `invalid` stands.
        ...(transcript === undefined || invalid !== undefined ? {} : { document: transcript }),
        editor,
        ...(invalid === undefined ? {} : { serverError: invalid.error }),
        text: editor.raw,
        baseline: editor.raw,
        dirty: false,
        pending: false,
        localErrorTone: 'local',
        ...(options.onSave === undefined ? {} : { onSave: options.onSave })
    };

    const content =
        mode === 'edit'
            ? editorContent(state)
            : threadTranscriptContent(transcript as ThreadTranscriptJson, () => enterEdit(state));

    state.handle = openDialog({
        title: dialogTitle(editor),
        content,
        copy: transcriptCopySource(state),
        onClose: () => {
            if (activeTranscript === state) activeTranscript = undefined;
        }
    });

    if (mode === 'edit') {
        state.handle.element
            .querySelector<HTMLTextAreaElement>('.thread-transcript-editor')
            ?.focus({ preventScroll: true });
    }

    activeTranscript = state;
    return state.handle;
};

// Result of a refresh attempt. 'closed' is deliberately observable: the board
// reports that the thread vanished instead of leaving a stale dialog on screen. An
// INVALID transcript is never 'closed' — that is the transient break the editor is
// here to repair.
export type ThreadTranscriptRefresh = 'updated' | 'closed' | 'ignored';

// Refresh the open transcript from a newer authority of the SAME board/session.
// Only the tracked dialog is touched. A missing thread closes it; a different
// session id is ignored (the board closes/moves on session switches explicitly).
// While the editor is open its TEXT is never replaced: only the identity line, the
// banner and the Save affordance follow the newer snapshot.
export const refreshOpenThreadTranscript = (
    snapshot: SessionSnapshot,
    scope: object
): ThreadTranscriptRefresh => {
    const state = activeTranscript;
    if (state === undefined || state.scope !== scope || !state.handle.isOpen) return 'ignored';

    // A late GET for a session the reader already left must not rewrite the
    // dialog (thread ids are only unique per session).
    if (state.sessionId !== snapshot.id) return 'ignored';

    const invalid = invalidThreadOf(snapshot, state.threadId);
    const transcript = buildThreadTranscriptJson(snapshot, state.threadId);

    if (transcript === undefined && invalid === undefined) {
        state.handle.close();
        activeTranscript = undefined;
        return 'closed';
    }

    // Move the authorities for BOTH modes: a later Edit/Cancel/Save renders the newest
    // snapshot, never the one the dialog first opened with. While `invalid` stands the
    // lossless document is a PLACEHOLDER for the unreadable value, so it is dropped
    // rather than offered as a readable document on Cancel.
    state.editor = editorAuthorityOf(snapshot, state.threadId, invalid);
    state.serverError = invalid?.error;
    state.document = invalid === undefined ? transcript : undefined;

    if (state.mode === 'edit') {
        // Readable again and nothing was typed: the editor is holding no work, so
        // return to the lossless document. Anything else keeps the surface exactly as
        // the reader left it and only re-paints the chrome.
        if (invalid === undefined && !state.dirty && paintRead(state)) return 'updated';

        paintEditorChrome(state);
        return 'updated';
    }

    // The transcript broke while the reader was LOOKING at the document. There is no
    // readable document left to show, so the dialog moves to the editor holding the raw
    // value (and the banner) — a transient invalid state updates the surface, it never
    // closes the dialog on its own. Nothing was typed here, so re-basing the text is
    // not a loss.
    if (invalid !== undefined && state.payloadView === undefined) {
        enterEdit(state);
        return 'updated';
    }

    paintRead(state);
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
