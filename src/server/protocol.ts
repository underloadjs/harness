// The wire contract between the harness server and its clients.
//
// This file is imported by the browser UI **type-only**, so nothing here may have
// a runtime dependency that a browser cannot load. The server and CLI import the
// values they need from their own modules.

import type {
    HarnessActionAnswer,
    HarnessActionChoice,
    HarnessActionOption,
    HarnessActionRequest,
    HarnessAttachment,
    HarnessErrorInfo,
    HarnessEvent,
    HarnessMessage,
    HarnessUsage,
    ToolUiPanel
} from '../harness';
import type { RunnerSettings } from './harnesses/types';
import type { AgentResultReference } from '../shared/agent-results';

export type {
    HarnessActionAnswer,
    HarnessActionChoice,
    HarnessActionOption,
    HarnessActionRequest,
    HarnessAssistantMessage,
    HarnessAttachment,
    HarnessErrorInfo,
    HarnessEvent,
    HarnessMessage,
    HarnessStopReason,
    HarnessThread,
    HarnessThreadOrigin,
    HarnessThreadRecord,
    HarnessThreadStatus,
    HarnessToolCall,
    HarnessUsage,
    ToolUiBlock,
    ToolUiPanel
} from '../harness';
export type { RunnerSettings } from './harnesses/types';
export type { AgentResultReference, AgentResultBlock, AgentResultStatus } from '../shared/agent-results';

export type SessionStatus = 'idle' | 'running' | 'error';

// One task submitted to a session, as the server recorded it.
//
// The server owns this record: the UI never infers a turn from streamed events,
// because a browser reload loses the stream but must still render the same
// transcript. `index` is the position in the session (0-based, monotonic) and
// `events` holds every `HarnessEvent` observed while the turn ran — including
// events from subagents a delegation reached — in emission order.
//
// `startedAt`/`updatedAt` are epoch milliseconds from the server clock.
// `startedAt` never changes once the turn opens; `updatedAt` moves on every
// recorded event and again when the turn reaches a terminal status.
//
// QUEUED (R4): a task submitted through POST /sessions/:id/tasks exists as a turn
// immediately, but its status is 'queued' until the server pump starts executing
// it. A queued turn therefore has an id and an index (stable from the submit) and
// no `startedAt` yet; the server stamps `startedAt` when execution begins. The
// same turn id is reused for the queued, running, and terminal frames, so a client
// upserts by id instead of guessing which row a frame belongs to.
export type SessionTurnStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export type SessionTurn = {
    id: string;
    index: number;
    // The trimmed task text the harness received, not the raw request body.
    prompt: string;
    // R1-R6: the PERSISTENT runtime thread this turn executed in (a host thread
    // from `harness.createThread`, or a default `agent:<name>` conversation).
    // Stable for the turn's whole life, so a focused UI can group turns by
    // conversation. Omitted for a LEGACY `/messages` turn, which keeps the
    // response-owned fresh-block shape byte-identical.
    threadId?: string;
    // R8: the conversation's stable agent-prefixed display label (`RR2`, `IT1`).
    // It names the THREAD, not the invocation: every continuation turn of one
    // conversation repeats it, and a child conversation has its own. Omitted for a
    // legacy turn (and for a pre-R8 server), which the UI derives from the roster.
    // T14: it is drawn from the ONE per-code label sequence (a legacy `/messages`
    // block and a nested block draw from it too), and a restored turn's recorded
    // label is adopted before anything is allocated, so a surviving `RR3` stays
    // `RR3` and the next conversation is `RR4`.
    threadLabel?: string;
    // Result blocks this task was submitted with (R2). A block is referenced by
    // the turn that produced it plus its `threadId` (omitted for the turn's ROOT
    // invocation) and its compact conversation-scoped label. The server binds these
    // at
    // enqueue (rejecting unknown/already-failed targets), then expands each
    // referenced block's terminal `done` content into the run prompt AFTER that
    // block has completed. Omitted for a task that references nothing, so every
    // pre-reference record keeps its exact shape.
    references?: AgentResultReference[];
    // Composer attachments the user submitted with this turn (T3). Omitted for a
    // text-only turn, so every pre-attachment record and response keeps its exact
    // old shape. The server validates and deep-copies them before the turn exists,
    // persists them with the turn, and hands the same bytes to the harness call
    // (`HarnessRunOptions.attachments`). `data` is raw canonical base64.
    attachments?: HarnessAttachment[];
    status: SessionTurnStatus;
    // Absent while 'queued' (execution has not begun); always set once the turn
    // is 'running' or terminal. Optional so a queued record is a valid turn.
    startedAt?: number;
    updatedAt: number;
    events: HarnessEvent[];
    // Epoch milliseconds parallel to `events`: entry i is when events[i] was
    // recorded. Persisted with the turn so a reload can show per-step and
    // per-tool elapsed time without replaying the stream. Optional so an older
    // recorded turn (or a hand-built one) stays valid.
    eventTimes?: number[];
    // The turn's token tally, summed BY THE SERVER from every per-request `usage`
    // event the run reported (each agent's requests included, so a delegated
    // subagent is part of the same bill). Optional because providers, not this
    // server, decide whether usage exists at all: absent means "no request
    // reported any", which is not the same as a zero-spend turn.
    usage?: HarnessUsage;
    // Focused guidance that was STEERED into this turn's run instead of starting a
    // separate turn (R5). The runtime applies steered text at the next safe model
    // boundary and it appears in the conversation transcript, not as a recorded
    // event here; this is the server's audit record of what was sent, when, and
    // which result blocks it carried. Optional so every pre-steering turn keeps its
    // exact shape. Never contains attachments (those are never steered — see
    // SubmitTaskRequest.threadId).
    steers?: SessionSteerRecord[];
};

// One steered submit, recorded on the turn that owned the running thread.
export type SessionSteerRecord = {
    // Epoch milliseconds when the server accepted the guidance.
    at: number;
    // The user's raw (trimmed) text. The run prompt may also contain the composed
    // reference section; the audit keeps the user-facing original.
    prompt: string;
    // T12b: the persistent conversation the text was delivered to, present ONLY
    // when that is NOT the owning turn's own thread (steering a delegated child).
    // The owner is the parent turn, so without this a client would render the
    // child's user message as the parent's prompt.
    threadId?: string;
    // Result blocks whose completed content was injected into the steered text.
    references?: AgentResultReference[];
};

// One trusted agent, as the UI needs it to choose a primary/subagent. The text
// fields are trusted catalogue content (src/agents), never client input and never
// secret: `instruction` is the identity system message and `guidelines` are the
// rules appended to it at runtime.
export type AgentDescriptor = {
    name: string;
    title: string;
    description: string;
    instruction: string;
    guidelines: string[];
};

// What the UI needs to draw a preset card without importing the catalogue.
export type HarnessDescriptor = {
    name: string;
    title: string;
    description: string;
    requiresEndpoint: boolean;
    // The selected entry agent, and the exact allowlist the primary may delegate
    // to. `agents` is derived: [primary, ...subagents].
    primary: string;
    subagents: string[];
    agents: string[];
    tools: string[];
    // The core tools this card's runs will declare (R18): the four core file tools
    // (fileRead/fileWrite/fileEdit/fileGlob) when registered, the harness-owned
    // toolRequest/toolCreate/todoManage, agentDelegate when a subagent allowlist
    // exists, and webSearch when this host has a provider key. The UI core dropdown
    // renders this exact set, so it reflects runtime visibility rather than a
    // hard-coded harness list. fileList and the other presets stay searchable.
    coreTools?: string[];
    // Per-agent model overrides (R9): agent id → model id. PRESENT ONLY WHEN a
    // harness actually overrides something, so existing cards keep their exact
    // shape. A member absent from the map uses the session's model; the UI labels
    // that no-override choice with the resolved id (R18), never "inherit".
    agentModels?: Record<string, string>;
    // Shipped with the application vs created through POST /harnesses. Informational
    // only: every harness in the in-memory registry is an editable application copy
    // of a template or a client-created harness.
    builtin: boolean;
    // COMPATIBILITY ONLY (R20.1): always true. Every registry entry is editable —
    // the shipped templates are starting copies, and PATCH produces a new immutable
    // entry. Retained because existing clients read the field; a client must not
    // treat it as a category or hide an edit affordance when it is true.
    editable: boolean;
};

// Body of POST /harnesses. A client selects trusted agents; it cannot supply
// instruction text, a provider, a model, or a tool list. It CAN pick the model id
// each selected agent runs (`agentModels`, R9) — an id only, never a provider or
// credential, because those come from the session settings.
export type CreateHarnessRequest = {
    name: string;
    title?: string;
    description?: string;
    primary: string;
    subagents?: string[];
    agentModels?: Record<string, string>;
};

// Body of PATCH /harnesses/:name. `name` is immutable; an omitted field keeps its
// current value. Changing `primary` without `subagents` removes the new primary
// from the old allowlist.
//
// `agentModels`, when present, REPLACES the harness's override map: `{}` clears
// every per-agent model, and every key must name a member of the resulting harness
// (400 otherwise). An existing override for a member the same patch removes is
// dropped rather than rejected.
export type UpdateHarnessRequest = {
    title?: string;
    description?: string;
    primary?: string;
    subagents?: string[];
    agentModels?: Record<string, string>;
};

// Whether the server can actually run a listed tool. Omitted means "available":
// the field was added for credential-dependent tools (webSearch), so leaving it
// off keeps every existing entry byte-identical.
//
// `environment` names variables only — never values — and `hint` is a non-secret
// sentence the UI can print verbatim.
export type ToolAvailability = {
    state: 'available' | 'unconfigured';
    environment?: string[];
    hint?: string;
};

// What the UI needs to draw a direct-call tool without importing the tool object.
export type ToolDescriptor = {
    name: string;
    // Display group. 'Core tools' is the harness-owned set (R8), listed for review
    // and manual execution but only runnable inside a session.
    group: string;
    description: string;
    tags: string[];
    visibility: 'core' | 'searchable';
    parameters: Record<string, unknown>;
    availability?: ToolAvailability;
    // True for the harness-owned core tools (toolRequest, toolCreate, todoManage,
    // agentDelegate). They have no standalone implementation: a call must carry a
    // `sessionId` and executes through that session's harness. Omitted for every
    // directly callable entry, so existing descriptors keep their shape.
    sessionBound?: boolean;
};

// One PERSISTENT thread of a session, as the roster exposes it (R1-R6).
//
// A thread is one agent-owned conversation with a stable id and its own transcript
// while sharing the session's memory (tools, todos, record stores, discovery,
// creation budget). `origin: 'agent'` is the agent's DEFAULT conversation; `host`
// is an ADDITIONAL independent conversation (opened by the server for an unfocused
// submit, by the UI, or by a delegated child).
//
// The server roster is the join between the runtime record and the recorded turns:
//   - `invocationId` is the runtime's invocation identity for this thread's LATEST
//     run, which is what a `HarnessEvent.thread.id` in a child frame maps onto;
//   - `originTurnId` is the first SessionTurn that ran in this thread (omitted for
//     a runtime-created child thread, whose work is recorded inside its parent's
//     turn);
//   - `originInvocationId` is that first run's invocation id, so the persistent
//     record can be joined to the events of the turn that started it;
//   - `invocationIds` is the FULL invocation roster of the thread (oldest first),
//     so a client can join an invocation card even after the conversation advanced
//     past it — the single `invocationId`/`originInvocationId` slots cannot;
//   - `references` lists the result blocks this thread's turns consume (the "#"
//     links), deduplicated, so a client can draw the connection graph without
//     walking every turn;
//   - `connectedThreadIds` names the PERSISTENT threads those blocks belong to.
//     A connection is a REFERENCE EDGE, never ownership: stopping or deleting a
//     connected source thread does not abort or remove this conversation (only
//     `ownerThreadId`, set by the runtime for delegation lineage, does that).
export type SessionThread = {
    id: string;
    agent: string;
    origin: 'agent' | 'host';
    status: 'idle' | 'running' | 'stopped';
    // Creation order (monotonic per session; copied from the runtime record).
    sequence: number;
    // The persistent parent thread (a delegated child links to its caller).
    ownerThreadId?: string;
    label?: string;
    invocationId?: string;
    originTurnId?: string;
    originInvocationId?: string;
    // EVERY invocation id this server observed running in the thread, oldest first.
    // The single slot above names only the LATEST run, and `originInvocationId` only
    // the thread's FIRST turn — a delegated child has no turn of its own, so neither
    // names the invocation that created its card once the child is resumed. This is
    // the persisted invocation→thread map (src/server/sessions.ts `invocationThreads`)
    // projected per thread, so a client can join a HISTORICAL invocation card live and
    // after a fresh hydration without inferring it from task text. Values are unique
    // and belong to THIS thread only. Omitted when nothing was recorded (a legacy
    // document whose map is empty/absent).
    invocationIds?: string[];
    references?: AgentResultReference[];
    // Persistent threads referenced by this conversation's result links (a
    // reference EDGE, not ownership). Derived from the recorded turns and the
    // roster, so it needs no separate persistence.
    connectedThreadIds?: string[];
    // The thread's committed transcript (a detached copy). This is what lets a
    // focused UI render ONE conversation without filtering the whole turn list;
    // `turns` stays the legacy projection so an existing renderer still works.
    messages: HarnessMessage[];
};

// A conversation held by the server. `messages` is the entry agent's transcript.
//
// `turns` is the authoritative renderable record and is always present (an empty
// array for a new or reset session). It is the only source a client needs to draw
// the transcript after a reload: list() and get() both carry it, including a turn
// that is still running.
export type SessionSnapshot = {
    id: string;
    harness: string;
    status: SessionStatus;
    // Number of tasks waiting in the server queue (turns with status 'queued');
    // the active turn is NOT counted. Omitted when the queue is empty so every
    // pre-queue snapshot keeps its exact shape. A client can render "N waiting"
    // from this without walking `turns`.
    queueDepth?: number;
    // The entry agent's model, read live (it changes when PATCH /sessions/:id
    // retargets that agent), so a client never has to look it up in `agentModels`.
    model: string;
    // The model each agent in this session actually runs (R9), keyed by agent id.
    // Derived LIVE from the session's agents: an agent absent from the preset's
    // `agentModels` map appears here with the session's settings.model, and
    // PATCH /sessions/:id rewrites an entry in place (see UpdateSessionRequest),
    // so a reload can render every agent's model without knowing the creation
    // settings. `harnessDefinition.agentModels` below stays frozen at creation:
    // this map is what the session runs NOW, the definition is what it was built
    // with.
    agentModels?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
    messages: HarnessMessage[];
    turns: SessionTurn[];
    // R1-R6: the session's persistent threads. PRESENT ONLY when the session owns
    // at least one HOST thread, so a session that never opened one keeps its exact
    // pre-thread snapshot shape. The default `agent:<name>` conversations are
    // internal plumbing and deliberately omitted.
    threads?: SessionThread[];
    // Conversation-scoped label counters AT THE START of each turn, keyed by turn
    // id (see shared/agent-results.ts). A client that projects result-block labels
    // seeds its allocator from the entry, so deleting a thread (and its turns)
    // cannot RENUMBER the surviving blocks' labels. Omitted when no turn recorded
    // a seed (an empty or legacy session).
    labelSeeds?: Record<string, Record<string, number>>;
    // R6 tombstone: the HIGHEST label occurrence ever minted per two-letter code,
    // maintained across turn deletion. A retired label is never re-minted for
    // different content, even after every turn carrying it is deleted; the next
    // turn seeds from the larger of this and the surviving-turn prefix. Content is
    // never retained — only the counters. Omitted while no label was ever minted.
    //
    // T14: conversation labels (`session.threads[].label`) are minted from this
    // same per-code sequence, so the counters here also cover a conversation's
    // ordinal — a client seeding a block allocator from them never re-mints a name.
    labelHighWater?: Record<string, number>;
    // The configuration this session was built with, captured at creation. A
    // registry change (POST/PATCH) therefore cannot rewrite what an existing
    // session reports: the UI can always render the frozen agents/toolbox/card.
    harnessDefinition?: HarnessDescriptor;
    // The tools toolRequest had enabled when this snapshot was taken, in
    // discovery order. Read-only; reset() empties it. Optional so a client can
    // still read an older server's snapshot.
    discoveredTools?: string[];
    lastError?: string;
};

// Payload of GET /api/harnesses. Provider defaults come from the server
// environment; the API key itself is never sent, only whether one exists.
// `agents` is the trusted agent registry, so a client can offer primary/subagent
// choices without a second request. The list name stays `harnesses` (and the
// bootstrap list stays `presets`) for compatibility.
export type HarnessIndex = {
    harnesses: HarnessDescriptor[];
    defaults: {
        baseURL: string;
        model: string;
        hasApiKey: boolean;
    };
    agents: AgentDescriptor[];
};

// Payload of GET /api/tools.
export type ToolIndex = {
    tools: ToolDescriptor[];
};

// Payload of POST /api/models.
//
// The browser cannot call a provider directly: it does not hold the server key
// (and must not be handed it), and the harness server sends no CORS headers. So
// the client sends the endpoint settings it would use for a session and the
// server performs GET {baseURL}/models itself. The response carries ids only —
// never the key, and the key travels in the POST body (or a header on the
// outbound request), never in a query string.
export type ModelListRequest = {
    settings?: Partial<RunnerSettings>;
};

// Payload of a successful POST /api/models. `models` is the provider's `id`
// values in provider order, deduplicated; an empty array is a valid answer.
export type ModelIndex = {
    models: string[];
};

// One item in the POST /api/sessions/:id/messages SSE stream.
//
// Ordering contract:
//   - `turn` opens every run, before the first harness event, so the client can
//     create the turn row before appending anything to it;
//   - every `event` names the turn it belongs to, so a client that connected late
//     (or inferred nothing) still attributes deltas correctly;
//   - `snapshot` is the normal terminal frame; `failed` is the error terminal.
//     Both carry the complete turn list, so the final frame is self-sufficient.
//
// GET /api/sessions/:id/events reuses the SAME item shapes, but there `turn` is an
// UPSERT: the server sends it when a turn is queued, when it starts, and when it
// reaches a terminal status, always with the same id/index, so a client replaces
// by id. That stream opens with one `snapshot`, then turn/event frames, and closes
// with one `snapshot` once the queue drains (see src/server/sessions.ts watch()).
export type SessionStreamItem =
    | { type: 'turn'; turn: SessionTurn }
    // `at` is the epoch-ms time the server recorded this event, the same value
    // appended to the turn's `eventTimes` entry. Optional for compatibility with
    // an older server frame.
    //
    // `usage` is the turn's running token tally AFTER this event, as the server
    // summed it (see SessionTurn.usage). Present only once the turn has reported
    // one, and repeated on later frames so a client never has to accumulate
    // anything itself: the label it shows is the server's figure.
    | { type: 'event'; turnId: string; event: HarnessEvent; at?: number; usage?: HarnessUsage }
    | { type: 'snapshot'; session: SessionSnapshot }
    | { type: 'failed'; error: HarnessErrorInfo; session: SessionSnapshot };

export type CreateSessionRequest = {
    harness: string;
    settings?: Partial<RunnerSettings>;
};

// Body of PATCH /sessions/:id. The session's harness, settings, history, and
// frozen `harnessDefinition` are immutable; the ONE thing a client may change is
// which model an already-selected agent runs, so the next request of that agent
// targets the new model without rebuilding anything.
//
// `agentModels` maps agent id → model id and MERGES into the live map: an agent
// absent from the body keeps the model it currently runs (changing one dropdown
// must not reset its siblings). `{}` is rejected as a no-op. Every key must name a
// member of THIS session's harness and every value must be a non-empty model id
// (400 otherwise, with nothing applied). The change is accepted while the session
// is running: an in-flight request keeps the model it started with, and the
// assistant message it commits names that model. Only future requests use the new
// one. The response is the same `{ session }` envelope as GET /sessions/:id, with
// `model`/`agentModels` reflecting the change and `harnessDefinition` unchanged.
export type UpdateSessionRequest = {
    agentModels: Record<string, string>;
};

// Body of both submit routes. `input` is the user text (trimmed by the server);
// `attachments` are the composer clips referenced by their markers inside the
// text. The key is OMITTED by a text-only client, which keeps the legacy body
// byte-identical. Empty/whitespace input is accepted only when at least one
// attachment is present. The server re-validates every field (shared
// validateAttachments) BEFORE creating a turn, so malformed, oversized, or
// mismatched media answers 400/413/415 with nothing mutated.
//
// `/messages` (the response-owned legacy run) does NOT support result references:
// a `references` field or a typed `#LABEL` in `input` is rejected with 400 rather
// than silently running without the context. Use /tasks (SubmitTaskRequest).
export type SubmitMessageRequest = {
    input: string;
    attachments?: HarnessAttachment[];
};

// Body of POST /api/sessions/:id/tasks — the server-queued submit (R4).
//
// Same `{ input }` shape as the legacy /messages body; the difference is the
// response and who owns execution. /messages opens an SSE response and the run
// belongs to that response (a disconnect aborts it). /tasks answers 202
// `{ session, turn }` immediately and the server pump runs the task even if the
// browser is gone. Task text is trimmed and bounded exactly like /messages.
//
// `references` (R2) names prior blocks whose completed results this task wants as
// context. The UI sends `{turnId, threadId?, label}` entries; OMITTING the array
// keeps the legacy body byte-identical. Typed `#LABEL` tokens in `input` are also
// resolved server-side when the array is absent (or does not already cover that
// label), so a client without metadata still works. Malformed entries, unknown
// turns/labels, and already-failed/cancelled blocks are a 400 before a turn exists.
export type SubmitTaskRequest = SubmitMessageRequest & {
    references?: AgentResultReference[];
    // R1-R6: the persistent thread this input belongs to.
    //
    //   - ABSENT — a NEW standalone host thread is opened for the primary agent
    //     (owned by its default conversation), so unfocused input becomes its own
    //     conversation without touching any other. When the task references prior
    //     blocks, the new thread is CONNECTED to the referenced threads: the
    //     relation is persisted as the turn's `references` and the roster derives
    //     `connectedThreadIds` from them. It is a reference EDGE, never ownership —
    //     `ownerThreadId` stays reserved for the runtime's delegation lineage
    //     (see SessionThread.connectedThreadIds), so stopping or deleting a
    //     referenced source neither aborts nor purges this new conversation.
    //   - PRESENT and RUNNING — the text is STEERED into that conversation at its
    //     next safe model boundary; no new turn record is created and the response
    //     carries the owning turn (`steered: true`, `steeredThreadId`). `references`
    //     are expanded into the steered text exactly like a turn prompt — but only
    //     when every referenced block has already completed; a reference to a turn
    //     that is still queued/running cannot be expanded, so the submit is deferred
    //     as a QUEUED CONTINUATION instead (it expands at execution). A steered
    //     submit is audited on the owning turn (`steers`).
    //   - PRESENT, RUNNING, WITH ATTACHMENTS — attachments cannot be steered (the
    //     runtime's steering API carries text only), so the submit becomes a QUEUED
    //     CONTINUATION in that thread: it keeps its bytes and runs when the active
    //     turn finishes. The response is the normal accepted turn (no `steered`).
    //   - PRESENT and IDLE/STOPPED — a continuation turn starts in that thread
    //     (a stopped thread is revived by this explicit host action), preserving
    //     its transcript. Other threads keep running concurrently.
    //
    // Every new thread gets its OWN execution lane, so two unfocused submits run
    // concurrently (peak overlap), not through the legacy serialized backlog.
    //
    // Unknown/deleted thread ids are 404 before anything mutates.
    threadId?: string;
};

// Response body of POST /sessions/:id/tasks: the same `{ session, turn }` envelope
// as before, plus the steering marker. `steered: true` is present ONLY when the
// submit was folded into a RUNNING thread: `turn` is then the turn that owns that
// run (its events will contain the steered text), not a duplicate record.
// `steeredThreadId` disambiguates `turn` when the owning turn belongs to a parent
// conversation (a steered delegated child) — it always names the thread the text
// was delivered to. Attachments are never steered: such a submit becomes a queued
// continuation turn in that thread instead (it keeps `steered` absent).
export type SubmitTaskResult = {
    session: SessionSnapshot;
    turn: SessionTurn;
    steered?: true;
    steeredThreadId?: string;
};

// Response of POST /sessions/:id/threads/:threadId/cancel (R6 stop-one).
//
// `cancelled` is true when a live run was aborted or at least one queued turn of
// that thread was dropped; a thread that was merely marked stopped (idle, no work)
// answers false. `session` is the post-stop snapshot so a client can repaint
// without a second request.
export type CancelThreadResult = {
    cancelled: boolean;
    session: SessionSnapshot;
};

// Response of DELETE /sessions/:id/threads/:threadId (R6 delete).
//
// The thread, its descendants, every owning turn/result reference/transcript, and
// their persisted copies are removed; `session` is the post-delete snapshot. A
// running thread (or one with queued work) is rejected with 409 — stop it first —
// and the default `agent:<name>` conversation is not deletable (400; use reset).
export type DeleteThreadResult = {
    deleted: true;
    session: SessionSnapshot;
};

// Body of POST /api/sessions/:id/actions/:requestId/answer (N4).
//
// The client answers ONE pending owner question with exactly one of the frozen
// `HarnessActionChoice` shapes: `{ kind: 'option', optionId }` naming an option
// the model offered, or `{ kind: 'custom', text }` free text. The server validates
// the choice against the recorded request (unknown option ids and malformed bodies
// are 400), resolves that pending promise exactly once, and answers `{ ok: true }`.
// The runtime then emits `action_answer` before the tool result, so every client
// can clear its question card from events alone.
//
// Status contract: 400 malformed/unknown-option, 404 unknown session or request id,
// 409 already answered or expired (including every request restored from disk).
// Answering is ALLOWED while the session is busy — the run is awaiting this answer.
export type AnswerActionRequest = {
    choice: HarnessActionChoice;
};

// Successful answer response. Deliberately minimal: the authoritative record is the
// persisted `action_answer` event, not a second copy of the choice on this route.
export type AnswerActionResult = {
    ok: true;
};

// Body of POST /api/sessions/:id/cancel. Absent/`{}` keeps the legacy behaviour:
// cancel the ACTIVE run only, leaving queued tasks untouched. `all: true` is the
// UI Stop button: also drop every queued task (they stay in `turns` as cancelled
// records). The response stays `{ cancelled }` for both shapes.
export type CancelSessionRequest = {
    all?: boolean;
};

export type ToolCallRequest = {
    parameters?: unknown;
    // Which session runs the call (R8; live routing per the self-modifying-tools
    // R4). When present and non-empty, the call resolves through THAT session's
    // live harness registry: session-bound core tools (toolRegistry, toolRequest,
    // toolCreate, todoManage, agentDelegate, …), replaced preset/app tools, and
    // runtime-created names all execute there, so discovery, registration, todos,
    // and delegation affect the conversation the user is looking at. Omitted or
    // empty keeps the static direct runner for a directly callable catalogue tool
    // (one request shape for the UI); a `sessionBound` core tool then answers 400.
    //
    // 400 when a core call omits it; 404 when the session (or the tool inside that
    // session, e.g. agentDelegate without subagents) does not exist; 409 when the
    // session is busy (a run, a reset, or another manual call), so a manual
    // mutation cannot race an active operation.
    sessionId?: string;
};

export type ToolCallResult =
    | {
          ok: true;
          // The tool's ordinary result value, already unwrapped from a
          // `toolUi(content, panels)` envelope. Standard tools are unchanged.
          result: unknown;
          // Optional declarative panels the tool supplied with `toolUi()`
          // (R20.2). Presentation data only — no HTML, script, or actions — and
          // bounded by the server before it reaches a client. Omitted for every
          // ordinary tool so existing responses keep their exact shape.
          panels?: ToolUiPanel[];
          durationMs: number;
      }
    | { ok: false; error: HarnessErrorInfo; durationMs: number };

export type ApiErrorBody = {
    error: {
        message: string;
    };
};
