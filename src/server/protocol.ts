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
    ToolMediaDescriptor,
    ToolUiPanel
} from '../harness';
import type { RunnerSettings } from './harnesses/types';
import type { AgentResultReference } from '../shared/agent-results';
// The display contract is imported (not just re-exported) because the view
// envelopes below embed its shapes. `import type` only: this file stays free of any
// runtime dependency, and `../shared/turn-display.ts` never imports this file back,
// so the dependency direction is one-way with no cycle at any level.
import type { TurnBlockDetail, TurnDisplay, TurnDisplayOp, TurnStepDetail, TurnSummary } from '../shared/turn-display';

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
    ToolMediaDescriptor,
    ToolUiBlock,
    ToolUiPanel
} from '../harness';
export type { RunnerSettings } from './harnesses/types';
export type { AgentResultReference, AgentResultBlock, AgentResultStatus } from '../shared/agent-results';

// The server-compiled DISPLAY contract (R1/R3). Types only, on purpose: the bounds
// constants (`DISPLAY_PREVIEW_CHARS`, ...) stay importable from
// `../shared/turn-display` directly — re-exporting VALUES here would give this file
// a runtime dependency, and a browser loads it type-only (see the header comment).
//
// Why the turn-level shapes live in `shared/` while the SESSION-level envelopes
// live below: `shared/turn-display.ts` must not import this file (one-way rule), so
// anything that names `SessionThread`/`HarnessDescriptor`/`SessionSteerRecord` is
// declared here instead.
export type {
    ContextBlock,
    ContextBlockKind,
    ContextBlockPatch,
    DisplayActionOption,
    DisplayActionSummary,
    DisplayAttachmentSummary,
    DisplayBlockSummary,
    DisplayMediaSummary,
    DisplayNode,
    DisplayNodePatch,
    DisplayNoticeNode,
    DisplayNoticeTone,
    DisplayPanelBlockSummary,
    DisplayPanelSummary,
    DisplayProjectContext,
    DisplayRole,
    DisplayStep,
    DisplayStepDetailRef,
    DisplaySteerSummary,
    DisplayTextNode,
    DisplayReasoningNode,
    DisplayedTurn,
    DisplayTurnInput,
    SectionDisplayState,
    StepDisplayState,
    TurnBlockDetail,
    TurnDisplay,
    TurnDisplayOp,
    TurnDisplayState,
    TurnInstructionSource,
    TurnProjector,
    TurnRecordStatus,
    TurnSection,
    TurnSectionPatch,
    TurnStepDetail,
    TurnSummary
} from '../shared/turn-display';

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
    // T14 (ADDITIVE): the durable TEXT ARCHIVE of this turn's steered submits.
    //
    // `steers` above is the operational AUDIT ring: the store keeps the last 64 (see
    // ./sessions.ts `MAX_STEER_RECORDS`, and ./persistence.ts enforces the same bound when
    // it reads a document), and the compact row publishes that ring. That bound is about
    // the size of the audit and the wire, NOT about how much of the conversation the UI may
    // show: every submit the context bar drew must stay clickable, and a 65th steer used to
    // silently strand its own segment — the bar still showed it, while its detail had
    // nothing to return. This archive keeps the exact submitted text of EVERY submit the
    // server accepted, keyed by the submit's own `id`, so a segment resolves now, after a
    // restart, and after the ring has moved on.
    //
    // T15: the list is UNBOUNDED on purpose. A submit the server accepted is the user's own
    // data, so nothing is discarded to keep a document small; the count is already limited at
    // the source (guidance is only accepted while a thread runs, and ./sessions.ts
    // `validateInput` caps every submit at `MAX_INPUT_LENGTH` characters), exactly as
    // `events` above is unbounded for the same reason. The reader therefore validates every
    // entry and refuses no length (./persistence.ts `readSteerTexts`).
    //
    // Deliberately NOT part of the default wire: the bar is metadata (`ContextBlock`), the
    // row carries the bounded audit ring, and the archived text is read only by the one
    // lazy route a click costs (./sessions.ts `blockDetail`). Optional and additive: a
    // document written before this build has no archive, and the fold/lookup fall back to
    // whatever the surviving ring still holds rather than inventing text.
    steerTexts?: SessionSteerText[];
};

// One archived steered submit: identity, timing, destination and the EXACT text the user
// submitted (the same `prompt` bytes the audit ring keeps, kept for every submit instead of
// only the last 64). `references` is intentionally absent: the archive exists to answer a
// click with text, and the audit ring stays the place the bound blocks are recorded.
export type SessionSteerText = {
    // The submit's durable identity (`SessionSteerRecord.id`): the context bar keys its
    // segment from it, which is what makes an archived entry resolvable after the ring
    // truncates the audit entry it came from.
    id: string;
    at: number;
    prompt: string;
    threadId?: string;
};

// One steered submit, recorded on the turn that owned the running thread.
export type SessionSteerRecord = {
    // T13: the submit's OWN durable identity, minted once by the server when the steer is
    // accepted (the same `randomUUID()` pattern as a session/turn/action id). It exists
    // because the two figures a display segment used to key off — `at` and the text
    // length — are not unique: two guidance submits recorded in the same millisecond with
    // the same length would otherwise collapse into ONE context-bar segment, and trimming
    // the bounded `steers` ring could renumber a survivor. Optional and additive: a record
    // written before this build simply has no id, and the fold falls back to the
    // deterministic occurrence key for it (./turn-projector.ts `steerBlockKeysOf`).
    id?: string;
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
    // (read/write/edit/glob/grep) when registered, the harness-owned
    // toolRequest/toolCreate/task, delegate when a subagent allowlist
    // exists, and search when this host has a provider key. The UI core dropdown
    // renders this exact set, so it reflects runtime visibility rather than a
    // hard-coded harness list. files and the other presets stay searchable.
    coreTools?: string[];
    // Per-agent model overrides (R9): agent id → model id. PRESENT ONLY WHEN a
    // harness actually overrides something, so existing cards keep their exact
    // shape. A member absent from the map uses the session's model; the UI labels
    // that no-override choice with the resolved id (R18), never "inherit".
    agentModels?: Record<string, string>;
    // Per-agent INSTRUCTION overrides (T3 editable configuration): agent id →
    // instruction text. PRESENT ONLY WHEN the harness actually overrides something,
    // so every existing card keeps its exact shape. Like `agentModels` it is the
    // OVERRIDE map, not the effective text: an agent it omits runs the trusted
    // catalogue instruction from `GET /agents`. Since T6 the stored value IS the agent's
    // COMPLETE prompt — the operator edits one box holding the full effective text — so
    // `GET /agents`'s `guidelines` are the default for an un-overridden member and are
    // never appended below an override. It still never rewrites the trusted profile.
    agentInstructions?: Record<string, string>;
    // Per-agent identity COLORS (R2): agent id → CSS hex color (`#rgb`, `#rgba`,
    // `#rrggbb`, `#rrggbbaa`, either case). PRESENT ONLY WHEN the harness configures at
    // least one, so every existing card keeps its exact shape. Like the two maps above
    // it is the OVERRIDE map, not a resolved palette: a member it omits has no
    // configured color, and the host falls back to its own derivation. Display-only —
    // it never shapes a prompt or a request — and it is the value the library stores on
    // `Agent.color` for that member, so the swatch a card paints and the swatch a
    // session's agents carry are the same bytes.
    agentColors?: Record<string, string>;
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

// Body of POST /harnesses. A client selects trusted agents; it cannot supply a
// provider, a model, or a tool list. It CAN pick the model id each selected agent
// runs (`agentModels`, R9) — an id only, never a provider or credential, because
// those come from the session settings — it CAN record a per-agent instruction
// override (`agentInstructions`, T3), which the registry validates against the
// final member set and the server applies when it builds the agent, and it CAN
// record a per-agent display color (`agentColors`, R2), a validated CSS hex color
// the registry applies the same way and projects onto the descriptor.
export type CreateHarnessRequest = {
    name: string;
    title?: string;
    description?: string;
    primary: string;
    subagents?: string[];
    agentModels?: Record<string, string>;
    agentInstructions?: Record<string, string>;
    agentColors?: Record<string, string>;
};

// Body of PATCH /harnesses/:name. `name` is immutable; an omitted field keeps its
// current value. Changing `primary` without `subagents` removes the new primary
// from the old allowlist.
//
// `agentModels`, when present, REPLACES the harness's override map: `{}` clears
// every per-agent model, and every key must name a member of the resulting harness
// (400 otherwise). An existing override for a member the same patch removes is
// dropped rather than rejected.
//
// `agentInstructions` follows the SAME replace/key-membership rules (T3): `{}`
// clears every instruction override so every member runs its trusted catalogue
// instruction again, a value must be non-empty bounded text, and an omitted key
// means "no override for that agent". A saved override never mutates the trusted
// profile; it is stored on the harness and projected back on `HarnessDescriptor`.
//
// `agentColors` follows the same rules for display metadata (R2): `{}` clears every
// color so every member falls back to the host's own swatch, and a value must be a
// CSS hex color.
export type UpdateHarnessRequest = {
    title?: string;
    description?: string;
    primary?: string;
    subagents?: string[];
    agentModels?: Record<string, string>;
    agentInstructions?: Record<string, string>;
    agentColors?: Record<string, string>;
};

// Response of DELETE /harnesses/:name (T5).
//
// Removes the harness from the catalogue — a shipped built-in exactly like a
// user-created one. Deliberately minimal, like the other destructive routes: the
// authoritative record is the database (the entry is gone, and a built-in's name is
// kept in `deleted` so a restart does not re-ship it), not a second copy of the
// harness on this route. The UI already holds the list it needs to repaint.
//
// Status contract: 200 `{ deleted: true }`; 404 for an unknown name AND for a name
// that is already deleted (a repeat delete did not remove anything). Existing
// sessions are untouched — each one runs, and a saved one restores from, the
// definition it captured — so deleting a harness with live or saved conversations is
// not an error.
export type DeleteHarnessResult = {
    deleted: true;
};

// Whether the server can actually run a listed tool. Omitted means "available":
// the field was added for credential-dependent tools (search), so leaving it
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
    // True for the harness-owned core tools (toolRequest, toolCreate, task,
    // delegate). They have no standalone implementation: a call must carry a
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
    // 'paused' is the plugin-owned park at a turn boundary (types/index.ts
    // `HarnessThreadStatus`); the server only mirrors what the runtime reports.
    status: 'idle' | 'running' | 'paused' | 'stopped';
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

// A conversation as the COMPACT surface sees it (R1). The field set is exactly
// `SessionThread` minus `messages`, plus a bounded transcript signal: the roster's
// `messages` are the committed harness transcript (every tool result verbatim, up to
// 64 KiB each), which is the payload class the view wire removes. A client that needs
// the transcript text reads
// `GET {mount}/views/:id/threads/:threadId/transcript` (the same `ThreadTranscriptResponse`
// the editor already uses), and `hasTranscript`/`messageCount` say whether it is worth
// asking. Identity fields keep their `SessionThread` names and meanings verbatim, so a
// renderer maps them without translation.
//
// T4 addition (additive, reported): `SessionView.threads` stays as declared for raw
// consumers, but the `/views` responses populate `threadViews` and OMIT `threads`.
export type SessionThreadView = {
    id: string;
    agent: string;
    origin: 'agent' | 'host';
    // Same four states as `SessionThread.status` (the compact surface must not invent
    // a narrower one, or a paused conversation would render as `undefined`).
    status: 'idle' | 'running' | 'paused' | 'stopped';
    sequence: number;
    ownerThreadId?: string;
    label?: string;
    invocationId?: string;
    originTurnId?: string;
    originInvocationId?: string;
    invocationIds?: string[];
    references?: AgentResultReference[];
    connectedThreadIds?: string[];
    // How many transcript entries the conversation holds (never their content).
    messageCount: number;
    // Bounded last-message preview, so a roster-only child still shows something.
    preview?: string;
    // True when a transcript read would return anything.
    hasTranscript: boolean;
};

// C4: one conversation whose stored transcript this build could NOT read.
//
// A transcript is fully user-editable JSON, so it can be broken by hand. One
// unreadable thread must never cost the user the whole session: the thread keeps
// its identity with a valid placeholder transcript (so the model path and the
// roster still work), and the value exactly as stored is preserved here so the
// visualiser can show it and let the operator fix it.
//
//   - `error`    is the validation message (`readHarnessMessages`) that refused
//     the stored value;
//   - `messages` is the RAW stored value, opaque and unmodified — deliberately
//     not `HarnessMessage[]`, because it is precisely what is not one;
//   - `label`/`agent` come from the thread record and are best-effort (a
//     hand-edited record may omit them).
export type SessionInvalidThread = {
    id: string;
    label?: string;
    agent?: string;
    error: string;
    messages: unknown;
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
    // C4 (ADDITIVE): conversations whose stored transcript could not be read.
    // Present ONLY when at least one thread is unreadable, so every existing
    // snapshot keeps its exact shape. Sorted by thread id for determinism. The
    // matching `threads[]` entry still exists and carries a valid placeholder
    // transcript; this list is where the raw, broken value lives so a client can
    // show it and edit it back into something readable.
    invalidThreads?: SessionInvalidThread[];
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

// ---------------------------------------------------------------------------
// The display wire (R1/R3/R4) — a SECOND surface, never a mutation of the raw one
// ---------------------------------------------------------------------------
//
// Everything above (`SessionSnapshot.turns[].events`, `SessionStreamItem`) is the
// RAW contract and stays byte-identical: the CLI folds `HarnessEvent`s in process
// (src/server/cli/index.ts:426 -> cli/render.ts), `api.test.ts`/`sessions.test.ts`
// assert those shapes, and an embedder may depend on them. The types below are the
// browser's surface, reached only under `/views`, so "the default traffic contains
// no raw steps" is enforceable by route rather than by discipline.
//
// Routes (mount-relative, identical on the standalone `/api` mount and the service
// `/v1/harness` mount — both adapters call the same dispatcher, src/server/api.ts:962):
//
//   GET  views                                                        -> SessionViewIndex
//   GET  views/:sessionId                                             -> { view: SessionView }
//   GET  views/:sessionId/events         SSE `data: <SessionViewStreamItem>\n\n`
//   POST views/:sessionId/tasks          202                          -> SubmitTaskViewResult
//   GET  views/:sessionId/turns/:turnId/steps/:stepId                -> { detail: TurnStepDetail }
//   GET  views/:sessionId/turns/:turnId/blocks/:blockId              -> { block: TurnBlockDetail }
//   GET  views/:sessionId/turns/:turnId/raw                          -> { turn: SessionTurn }
//
// The last three are the ONLY places recorded bytes reach a browser beyond the compact
// row, and only on an explicit user action (open a tool's details / click one context
// segment / copy a transcript). `:stepId` is the
// opening event's index (see `DisplayStepDetailRef`), so the request resolves the
// recorded request AND its recorded response together. `:blockId` addresses ONE segment
// of the turn's context bar (`TurnSection.context`, shared/turn-display.ts); it answers
// with that block's exact recorded TEXT for ANY kind — prompt, instructions, reasoning,
// an earlier answer, or a tool call — which is how "click a segment, get the exact
// detail" (R8) works without ever putting that text on the default wire (R1/R3). The
// `/raw` route exists for
// the transcript copy/export surface, which quotes whole recorded turns
// (src/frontend/ui/thread-transcript.ts:296); nothing in the normal render path uses it.

// The complete compiled state of one conversation: the same session header a
// snapshot reports, plus compact rows and their display trees, and NO event list
// anywhere. `threads`/`invalidThreads` are reused verbatim because they already
// carry no events (see `SessionThread`, line 362).
export type SessionView = {
    id: string;
    harness: string;
    status: SessionStatus;
    // Same rule as `SessionSnapshot.queueDepth` (line 432): omitted when empty.
    queueDepth?: number;
    model: string;
    agentModels?: Record<string, string>;
    createdAt: number;
    updatedAt: number;
    lastError?: string;
    threads?: SessionThread[];
    // T4 (additive): the compact roster the `/views` responses actually send. The raw
    // `threads` roster above is left for a consumer that explicitly wants the
    // transcript-bearing roster; `/views` omits it (see `SessionThreadView`).
    threadViews?: SessionThreadView[];
    invalidThreads?: SessionInvalidThread[];
    // Counters only (see `SessionSnapshot.labelSeeds`/`labelHighWater`, lines
    // 466-476). A client never mints a label from these any more — the server owns
    // `TurnSummary.blocks` — but they stay so the raw and display surfaces agree.
    labelSeeds?: Record<string, Record<string, number>>;
    labelHighWater?: Record<string, number>;
    // T9 (wire rule, no shape change): a `/views` response STILL types this as
    // `HarnessDescriptor`, but the server OMITS `agentInstructions` from the copy it
    // sends. That map is per-agent instruction TEXT (see
    // `HarnessDescriptor.agentInstructions`, lines 236-243), and forwarding it would
    // leak the system prompt of every member into every view frame — exactly the
    // payload class R1/R3 removes. A browser that wants the effective instruction text asks
    // for one block: `GET views/:id/turns/:tid/blocks/:blockId` of kind `system`. Nothing
    // else about the descriptor changes, so the model/member/promotion reads keep working.
    harnessDefinition?: HarnessDescriptor;
    discoveredTools?: string[];
    // Compact rows, in recorded order (the raw `turns` list is absent by contract).
    turns: TurnSummary[];
    // Display trees keyed by turn id. Present ONLY for turns named in `turns`; a
    // turn with no live work still has an entry (its sections are the transcript).
    //
    // T9: this is where the ONE context bar lives — `TurnSection.context` per section,
    // metadata only, so the frame stays bounded however long the conversation is. Text
    // in these trees is bounded too, except the two designated full payloads (the row's
    // `prompt`, and each section's current answer named by `answerNodeId`); a superseded
    // answer and every reasoning node arrive as a preview plus the exact `chars`
    // (`DisplayTextNode`/`DisplayReasoningNode`). `SessionViewSummary` (below) omits the
    // whole map, so a session LIST carries rows without bars — fetch the view of the
    // session whose bar you are looking at.
    displays: Record<string, TurnDisplay>;
};

// One session WITHOUT the node trees: the rail/list document. This is the shape
// that makes `GET views` cheap for a session list, which today ships every session's
// every event (`SessionStore.list()`, src/server/sessions.ts:2324).
export type SessionViewSummary = Omit<SessionView, 'displays'>;

// Body of GET /api/views.
export type SessionViewIndex = {
    views: SessionViewSummary[];
};

// Body of GET /api/views/:id.
export type SessionViewResponse = {
    view: SessionView;
};

// Body of GET /api/views/:id/turns/:turnId/steps/:stepId.
export type SessionStepDetailResponse = {
    detail: TurnStepDetail;
};

// Body of GET /api/views/:id/turns/:turnId/blocks/:blockId (T9, R8).
//
// One segment of the context bar answered EXACTLY: the block's own metadata plus its
// recorded text (`TurnBlockDetail`). Served from the durable record — the turn's
// recorded events for the block's `eventFrom..eventTo` range, its `prompt`/`steers`, or
// the turn's persisted instruction sources — so it answers identically live, after a
// restart, and for a session folded from a legacy checkpoint that has no journal.
//
// 404 for an unknown session/turn/blockId (a block the bar never minted, or one dropped
// with a discarded attempt), and 400 for a blank id. The turn and the block identity are
// echoed inside `block`, so a late answer can be matched to the segment that asked for
// it.
export type SessionBlockDetailResponse = {
    block: TurnBlockDetail;
};

// Body of GET /api/views/:id/turns/:turnId/raw — the verbatim recorded turn
// (`copyTurn`, src/server/sessions.ts:705), events and eventTimes included.
export type SessionTurnRawResponse = {
    turn: SessionTurn;
};

// One item of GET /api/views/:id/events.
//
// Ordering contract, mirroring `SessionStreamItem` above so a client keeps one
// mental model:
//   - the stream OPENS with one `view` (the atomic state at registration, exactly
//     like `SessionStore.watch()`, src/server/sessions.ts:3965);
//   - `ops` frames follow, at most one per recorded harness event, each naming its
//     turn. A frame is applied by node/step id, never by arrival position;
//   - the stream CLOSES with one `view` once the queue drains, and that frame is
//     self-sufficient: it reconciles any op this connection missed (the same
//     recovery role the terminal `snapshot` plays on the raw stream);
//   - `failed` is the error terminal and still carries the full `view`.
//
// A `turn` upsert rides inside `ops` as `{ op: 'turn' }` (queued -> running ->
// terminal transitions), so a client has exactly one place to patch a row.
export type SessionViewStreamItem =
    | { type: 'view'; view: SessionView }
    | { type: 'ops'; turnId: string; at: number; ops: TurnDisplayOp[] }
    | { type: 'failed'; error: HarnessErrorInfo; view: SessionView };

// Response of POST /api/views/:id/tasks — the browser submit. Same semantics as
// `SubmitTaskResult` (line 771) with the raw session/turn replaced by their display
// counterparts, so a submit repaints the board without ever pulling events.
//
// `steered`/`steeredThreadId` keep their exact meaning from `SubmitTaskResult`:
// present only when the input folded into a running conversation, and `turn` is then
// the OWNING turn's summary.
export type SubmitTaskViewResult = {
    view: SessionView;
    turn: TurnSummary;
    steered?: true;
    steeredThreadId?: string;
};

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

// Body of PUT /sessions/:id/threads/:threadId/transcript (C4).
//
// `messages` is DELIBERATELY `unknown`: the transcript is fully user-modifiable
// JSON, and a structurally broken value is a SUCCESSFUL write (200), not a 400.
// Only an absent `messages` property (a malformed HTTP/JSON body) is a 400.
export type UpdateThreadTranscriptRequest = {
    messages: unknown;
};

// One thread's transcript as the editor sees it (C4).
//
//   - `messages` is the LIVE harness transcript the model will be sent. For an
//     unreadable thread that is the placeholder, never the broken value;
//   - `raw` is the pretty-printed JSON the editor edits. For an unreadable thread
//     that is the raw stored value verbatim, so the operator can see and fix what
//     was actually saved;
//   - `invalid` is present ONLY when the transcript cannot be read, carrying the
//     reason plus the same raw value (a client can render either without parsing).
export type ThreadTranscriptResponse = {
    threadId: string;
    agent: string;
    messages: HarnessMessage[];
    raw: string;
    invalid?: { error: string; messages: unknown };
};

// Response of PUT /sessions/:id/threads/:threadId/transcript (C4).
//
// A broken submission is ACCEPTED: the raw value is persisted, the thread's live
// transcript becomes a valid placeholder, and `transcript.invalid` explains why.
// `session` is the post-write snapshot (it carries `invalidThreads`), so a client
// repaints the whole visualiser from one response.
export type UpdateThreadTranscriptResult = {
    session: SessionSnapshot;
    transcript: ThreadTranscriptResponse;
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
    // toolCreate, task, delegate, …), replaced preset/app tools, and
    // runtime-created names all execute there, so discovery, registration, todos,
    // and delegation affect the conversation the user is looking at. Omitted or
    // empty keeps the static direct runner for a directly callable catalogue tool
    // (one request shape for the UI); a `sessionBound` core tool then answers 400.
    //
    // 400 when a core call omits it; 404 when the session (or the tool inside that
    // session, e.g. delegate without subagents) does not exist; 409 when the
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
          // (R20.2). Presentation data only - no HTML, script, or actions - and
          // bounded by the server before it reaches a client. Omitted for every
          // ordinary tool so existing responses keep their exact shape.
          panels?: ToolUiPanel[];
          // Optional file media the tool supplied with `toolMedia()` (R3/R4,
          // the `download` preset). DESCRIPTORS ONLY - id/kind/name/mime/size -
          // never the base64, which stays in the process that fetched the file
          // (a manual catalogue call has no transcript to attach it to). Omitted
          // for every medialess tool, so existing responses are unchanged.
          media?: ToolMediaDescriptor[];
          durationMs: number;
      }
    | { ok: false; error: HarnessErrorInfo; durationMs: number };

export type ApiErrorBody = {
    error: {
        message: string;
    };
};
