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
    HarnessToolCall,
    HarnessUsage,
    ToolUiBlock,
    ToolUiPanel
} from '../harness';
export type { RunnerSettings } from './harnesses/types';

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
export type SubmitTaskRequest = SubmitMessageRequest;

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
    // Which session also runs the call (R8). REQUIRED for `sessionBound` core
    // tools (toolRequest, toolCreate, todoManage, agentDelegate): they execute inside
    // that session's harness so discovery, runtime creation, todos, and delegation
    // affect the conversation the user is looking at. Accepted but ignored for a
    // directly callable catalogue tool, which keeps one request shape for the UI.
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
