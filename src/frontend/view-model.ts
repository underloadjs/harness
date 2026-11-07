// The frontend's OWN render model for one conversation (T14).
//
// Why this file exists: the shell, ./view-state.ts, ./view-api.ts and every `ui/`
// renderer are written against a single camelCase "session view" document. That
// document used to BE the server's `/views` payload (`SessionView` in
// ../server/protocol.ts). The canonical contract (/v1/harness,
// ../shared/harness-api.ts) does not publish that document any more — it publishes
// a metadata row, a page of turn rows, a page of thread rows, a receipt per write,
// and ONE display tree per turn — so the browser now COMPOSES the render model from
// those bounded reads (./view-api.ts) and keeps it WINDOWED.
//
// What "windowed" means concretely, and it is the reason a 6-session deployment
// stopped costing ~50 MB:
//   - `turns` holds the loaded page window (the newest 25 by default, extended
//     older-only through the cursor the user asked for). It is never "all turns".
//   - `displays` holds a display tree ONLY for a turn this client is actually
//     showing (the tail that painted, a tile the reader expanded, a page the reader
//     scrolled to). A turn named in `turns` with no entry here is a row the reader
//     has not opened, which is a normal state and every consumer must tolerate it.
//   - `usage`, `definition`, `queue`, `actions`, `commands`, transcripts and
//     attachment bytes are each a separate lazy read; only `actions` rides session
//     open, because an unanswered question blocks the composer.
//
// Field spelling stays camelCase because these are the shapes the PROJECTOR emits
// (../shared/turn-display.ts owns `TurnSummary`/`TurnDisplay`/`TurnSection`), and
// the generated contract keeps the display subtree camelCase on purpose. The
// snake_case resource rows are converted here, once, at the boundary.
import type { PendingAction, SessionTurnStatus } from '../shared/harness-api';
import type { TurnDisplay, TurnSummary } from '../shared/turn-display';

// A conversation as the roster shows it: identity, ownership, lifecycle, and
// transcript SIGNALS. This is `ThreadSummary`/`ThreadResource` with the contract's
// snake_case renamed to the spelling the renderers already use, plus the two
// roster-only fields (`invocationIds`, `references`) the identified read adds.
export type ThreadRow = {
    id: string;
    agent: string;
    origin: 'agent' | 'host';
    // R2/R3 ripple: the contract now carries 'paused' (a plugin parked the
    // conversation at a turn boundary). A row must be able to state it, or the mapper
    // would have to invent a value for a real server state.
    status: 'idle' | 'running' | 'paused' | 'stopped';
    sequence: number;
    ownerThreadId?: string;
    label?: string;
    // Transcript signals, never message bodies: a 256-conversation roster stays a
    // bounded read because the committed transcript lives on its own routes.
    transcriptState: 'ok' | 'unreadable';
    transcriptError?: string;
    messageCount: number;
    chars?: number;
    hasTranscript: boolean;
    preview?: string;
    // Present only on a row composed from the identified thread read (`/threads/{id}`).
    originTurnId?: string;
    originInvocationId?: string;
    invocationId?: string;
    invocationIds?: string[];
    invocationIdsTruncated?: boolean;
    references?: ThreadResourceReferences;
    connectedThreadIds?: string[];
    transcriptRevision?: number;
    transcriptBytes?: number;
    revision?: number;
};

// Structural alias so this module does not import the whole domain type for one
// optional array; `AgentResultReference` is the element type the projector emits.
type ThreadResourceReferences = { turnId: string; threadId?: string; label: string; [key: string]: unknown }[];

// One conversation whose stored transcript this build could not read. Derived from
// a roster row whose `transcript_state` is `unreadable`: the canonical contract
// states that condition PER ROW (`ThreadSummary.transcript_state` +
// `transcript_error`) instead of carrying a separate invalid-thread list, so the
// frontend keeps the list as a projection of the roster. `raw` is filled by the
// document read when the editor opens this thread, not by the roster.
export type InvalidThreadRow = {
    id: string;
    label?: string;
    agent?: string;
    error: string;
    messages: unknown;
};

// The windowed document the shell draws. The root fields are `SessionResource`
// renamed; the heavy members are the loaded windows described in the header.
export type SessionView = {
    id: string;
    harness: string;
    status: 'idle' | 'running' | 'error';
    // Omitted when the queue is empty (the server's rule), so "N waiting" is a
    // figure, never a walk.
    queueDepth?: number;
    model: string;
    // The live per-agent model map (PATCH merges into it).
    agentModels?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
    lastError?: string;
    // The resource revision this document was assembled at. Every window inside it
    // keeps its own counter (`turnsRevision`, `threadsRevision`, per-row
    // `revision`), and a stream frame is compared against the matching one — never
    // across kinds or epochs.
    revision?: number;
    definitionRevision?: number;
    // Counters the header reports so a panel can gate a read it has not made yet
    // (`GET /sessions/{id}` publishes them precisely so a client knows whether a
    // subresource is worth asking for).
    turnCount?: number;
    threadCount?: number;
    pendingActionCount?: number;
    createdToolCount?: number;
    createdToolLimit?: number;
    endpoint?: { base_url: string; model: string; has_api_key: boolean };
    runtimeExecution?: 'inline' | 'worker';
    // The toolbox names this conversation discovered, from the frozen definition read
    // (SessionDefinitionResource.discovered_tools). Lazy: the tools panel fills it, the
    // transcript path never asks for it.
    discoveredTools?: string[];
    threadViews?: ThreadRow[];
    invalidThreads?: InvalidThreadRow[];
    // Loaded turn window, in recorded (ascending) order.
    turns: TurnSummary[];
    // Paging state of that window: `olderCursor` is the cursor for the NEXT OLDER
    // page (null = the beginning is already loaded), `turnsRevision` is the
    // collection revision the page was assembled at.
    olderCursor?: string | null;
    turnsRevision?: number;
    // Display trees for the turns this client is showing. Absent key = not loaded.
    displays: Record<string, TurnDisplay>;
    // Owner questions still waiting (they gate the composer, so they ride the open).
    actions?: PendingAction[];
};

export type SessionViewSummary = Omit<SessionView, 'displays'>;

// The row shape this frontend puts on the wire for a turn. `prompt` stays because
// the projector emits it, but a ROW page never carries the verbatim prompt any
// more: it carries `promptPreview` + `promptChars`, and `promptIsPreview` records
// which of the two this row holds. The verbatim text is one identified read away
// (`api.getTurn`) or a context-block read for the user bubble.
export type TurnRowView = TurnSummary & {
    promptPreview?: string;
    promptChars?: number;
    promptIsPreview?: boolean;
    // True for a row this client minted from a submit receipt before the server's
    // `turn.upsert` frame landed. It is paint-only: the authoritative row replaces
    // it, and nothing may treat it as recorded state.
    optimistic?: boolean;
};

// One entry of a thread's transcript, as the editor and the roster reader see it.
// Composed from `GET .../transcript` (metadata) + `GET .../transcript/document`
// (the whole JSON text), because the contract keeps "read to display" (paged
// messages) and "read to edit" (the document) as different operations.
export type ThreadTranscriptPayload = {
    threadId: string;
    agent: string;
    // The parsed value when it IS a transcript; the placeholder the server installed
    // when it is not. The value to EDIT is always `raw`.
    messages: unknown;
    raw: string;
    revision: number;
    // Present when the stored value is not a readable transcript: the validator's
    // message plus the JSON text exactly as stored.
    invalid?: { error: string; raw: string; storedType?: string };
};

// The composed raw document for the copy/export surface. Opt-in and paged: the
// events arrive page by page, so exporting a turn that ran for an hour is a series
// of bounded reads rather than one multi-megabyte answer.
export type RawTurnDocument = {
    id: string;
    index: number;
    prompt: string;
    status: SessionTurnStatus;
    threadId?: string;
    startedAt?: number;
    updatedAt: number;
    usage?: TurnRowUsage;
    events: unknown[];
    eventTimes: number[];
};

// Structural alias for the optional usage tally on a recorded turn.
type TurnRowUsage = { [key: string]: unknown };
