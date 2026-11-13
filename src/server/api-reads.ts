// T13: the bounded read model behind the canonical REST surface.
//
// WHY THIS MODULE EXISTS
// ----------------------
// `SessionStore.get()/list()` answer the LEGACY aggregate: a `SessionSnapshot` deep-copies
// every recorded turn, its events, its transcripts, and the harness snapshot (`core`). On a
// server with six long sessions that is the ~50 MB boot cost this task removes. Every read
// here instead walks what the store already keeps incrementally:
//
//   - `session.turns`            (recorded turns; only COUNTS and the bounded projection)
//   - `session.projections`      (the per-turn display cache the recorder maintains, so a
//                                 row/display never costs an event fold)
//   - `session.harness.threads()`(thread RECORDS: identity/lifecycle, no transcript)
//   - `harness.toolSources()` /  `harness.runtime.listTools()` (live toolbox, metadata only)
//
// Nothing in this file calls `store.get()`, `store.list()`, `snapshot()`, or `copyTurns()`.
// A page of 25 turn rows costs 25 projector `summary()` calls against an already-folded
// cache, which is the whole point.
//
// NAMING (spec: src/shared/harness-api.ts header): REST resources/receipts/pages are
// snake_case; the display subtree and the domain payloads (TurnSection, ContextBlock,
// HarnessMessage, HarnessUsage, HarnessActionRequest, ToolMediaDescriptor, …) are verbatim
// camelCase aliases, so they are copied, never renamed.
//
// Cross-references:
//   - ../shared/harness-api.ts  — every DTO produced here (deep import: the shared barrel collides)
//   - ./api-events.ts           — revisions stamped into these projections
//   - ./api.ts                  — the dispatcher that calls these and owns the writes
//   - ./sessions.ts             — the live `Session` record this reads (`SessionRecord`)

import type {
    HarnessActionRequest,
    HarnessAttachment,
    HarnessErrorInfo,
    HarnessEvent,
    HarnessMessage,
    HarnessUsage,
    ToolVisibility
} from '../harness';
// The trusted agent catalogue profile (src/agents), distinct from the wire `AgentProfile`
// below: one is the shipped record, the other is what a client reads.
import type { AgentProfile as TrustedAgentProfile } from '../agents';
import type { TurnProjector } from '../shared/turn-display';
import type {
    AgentProfile,
    HarnessCard,
    HarnessInstructionSummaryEntry,
    HarnessDefinition,
    HarnessInstructionTextResponse,
    AgentSummary,
    ProviderDefaults,
    PendingAction,
    QueuedTask,
    RecordChangeRow,
    RecordEntryRow,
    RecordFieldDescriptor,
    RecordsDeltaResponse,
    RecordsSnapshotResponse,
    RuntimeSettings,
    SessionStatePatch,
    SessionAgentBinding,
    SessionDefinitionResource,
    SessionResource,
    SessionSummary,
    SessionToolDetail,
    SessionToolSourceResponse,
    SessionToolSummary,
    CommandDescriptor,
    ThreadResource,
    ThreadSummary,
    ToolCallResult,
    ToolDetail,
    ToolExecutionScope,
    ToolSummary,
    TranscriptMetadata,
    TranscriptSignal,
    TurnEventRow,
    TurnResource,
    TurnSummary as WireTurnSummary,
    UsageByThread,
    UsagePatch
} from '../shared/harness-api';
import type { AgentResultReference } from '../shared/agent-results';
import { HARNESS_SERVICE_LIMITS } from '../shared/harness-api';
// T4: the engine's own read model for the record store (`records()` / `recordsChanges()`),
// which is what the two projections below turn into wire rows. Domain types come from
// ../types, the same barrel ./sessions.ts reads, never from the runtime entry point.
import type { RecordEntry, RecordFieldDefinition, RecordStoreChange } from '../types';
import { previewText } from './turn-projector';
import type { SessionRecord, ThreadLaneInfo } from './sessions';
import type { CatalogueEntry, HarnessPreset } from './harnesses/types';
import type { ToolCatalogue } from './harnesses';
import { CORE_TOOL_NAMES } from './harnesses/toolbox';
// T19: the global agent overlay type (the one authority behind `has_global_override`,
// `instruction_source: 'global'`, and a roster row's provenance).
import type { AgentState } from './harnesses/agent-state';
import type { ServerRuntimeConfiguration } from './config';
import type { HarnessEventHub } from './api-events';

// ---------------------------------------------------------------------------
// Bounds (contract numbers, restated here so a preview length is one line away)
// ---------------------------------------------------------------------------

/** A queued task's row preview. A queue panel of 100 x 200k-char prompts must stay small. */
export const QUEUE_PREVIEW_CHARS = 160;

/** A roster row's transcript tail. The verbatim text is the transcript route's job. */
export const THREAD_PREVIEW_CHARS = 160;

/** `TurnResource.prompt` is the verbatim task text, which THAT route is allowed to carry. */
export const TURN_PROMPT_PREVIEW_CHARS = 320;

// The shipped harness-owned control tools (`toolRequest`, `tasks`, ...). This is the ONLY
// remaining use of that list on the read side, and it is a SESSION fact, not a global one:
// it decides which live registry entries a conversation can neither un-register nor switch
// off (./api.ts `setSessionToolEnabled` / `deleteSessionTool` read the row's `protected`
// field), and which entries have no standalone implementation (the execution gate below).
// The GLOBAL deployment switch (./tool-settings.ts) no longer consults it: every listed
// name is switchable there.

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type ReadContext = {
    hub: HarnessEventHub;
    catalogue: ToolCatalogue;
    /**
     * The harness-owned rows the GLOBAL Tools surface lists BEFORE the catalogue
     * (`./api.ts` `createCoreToolEntries()`, ./harnesses/core.ts). Session rows need them for
     * the same reason the global routes consult them (`coreEntries.find(name) ?? catalogue
     * .find(name)`): a name like `delegate` or `records` is a RUNTIME entry that
     * `createToolCatalogue()` does not carry, so a session row resolved against the catalogue
     * alone falls back to the "no entry" defaults (`group: 'Created tools'`,
     * `visibility: 'searchable'`, `session_bound: false`) and contradicts the global row for
     * the same name — the pane then shows one tool as two different tools.
     *
     * OPTIONAL for the same reason `agentState` is: a hand-built read context over the
     * projections may legitimately state only the catalogue, and an absent list means
     * "no harness-owned entries", which is exactly what every pre-R3 projection asserted.
     */
    coreEntries?: readonly CatalogueEntry[];
    /** Effective GLOBAL provider defaults (config layer), never a per-session merge. */
    defaults: { baseURL: string; model: string; apiKey: string };
    /** Deployment runtime facts (./config.ts), reported read-only on /config and a session. */
    runtime: ServerRuntimeConfiguration;
    /**
     * Session display titles. The durable session record has NO title field today
     * (persistence.ts is not this owner's), and `SessionSummary.title` /
     * `UpdateSessionRequest.title` are contract-visible, so the title lives in this
     * process-owned map. It is reported on every read that names a title, and the write
     * route documents that a restart drops it.
     */
    titles: Map<string, string>;
    /** The per-session lifetime budget for created tools (HARNESS_SERVICE_LIMITS.created_tools). */
    createdToolLimit: number;
    /**
     * The trusted agent catalogue profiles (the registry's read-only list). Instruction
     * PROVENANCE needs them: a definition stores only an OVERRIDE, so "how long is the text
     * this member actually runs" is answerable only by joining the override with the profile.
     *
     * T19: the GLOBAL agent-override layer travels beside it, because "which layer supplied
     * this text" is a question about the overlay, not about the merged profile. It is
     * OPTIONAL: a hand-built read context (a test over the projections) may legitimately
     * state only the catalogue, and an absent layer means "no global overrides" — exactly
     * what every pre-T19 projection asserted.
     */
    agentState?: AgentState;
    profiles: readonly TrustedAgentProfile[];
};

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Key-free endpoint view: the contract never leaks a credential, only its presence. */
export const providerDefaultsOf = (settings: { baseURL: string; model: string; apiKey?: string }): ProviderDefaults => ({
    base_url: settings.baseURL,
    model: settings.model,
    has_api_key: typeof settings.apiKey === 'string' && settings.apiKey.trim().length > 0
});

/** The read-only runtime block, projected snake_case from ./config.ts's deployment config. */
export const runtimeSettingsOf = (runtime: ServerRuntimeConfiguration): RuntimeSettings => ({
    thread_execution: runtime.threadExecution,
    worker_idle_ms: runtime.workerIdleMs,
    max_lane_workers: runtime.maxLaneWorkers,
    worker_handshake_ms: runtime.workerHandshakeMs,
    ...(runtime.workerEntry === undefined
        ? {}
        : { worker_entry_configured: runtime.workerEntry.trim().length > 0 })
});

/** Total pending work: the legacy queue plus every lane backlog (same rule as the store). */
const pendingCountOf = (record: SessionRecord): number => {
    let count = record.queue.length;

    for (const lane of record.lanes.values()) count += (lane as ThreadLaneInfo).queue.length;

    return count;
};

/** Host conversations only: an agent's default `agent:<name>` lane is internal plumbing. */
const hostThreads = (record: SessionRecord) =>
    record.harness.threads().filter((thread) => thread.origin === 'host');

/** The turn a conversation's run belongs to (the same join the store's roster uses). */
const owningTurnOf = (record: SessionRecord, threadId?: string) =>
    threadId === undefined
        ? undefined
        : record.turns.find((turn) => turn.threadId === threadId);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * One session row: metadata + counters. Reads `record.turns.length` for the count, which
 * is an array length, not a copy - that is the whole trick.
 */
export const sessionSummaryOf = (record: SessionRecord, context: ReadContext): SessionSummary => {
    // T16: the durable record field is the source; the process map is only a fallback for a host
    // that set a title through an older surface (and for a store built without persistence).
    const title = record.title ?? context.titles.get(record.id);

    return {
        id: record.id,
        ...(title === undefined ? {} : { title }),
        harness: record.preset.name,
        status: record.status,
        // `queue_depth` is emitted only when there IS pending work: an absent field means
        // "nothing queued", which is also what the spec's optional field means.
        ...(pendingCountOf(record) === 0 ? {} : { queue_depth: pendingCountOf(record) }),
        model: record.harness.agent.model(),
        created_at: record.createdAt,
        updated_at: record.updatedAt,
        ...(record.lastError === undefined ? {} : { last_error: record.lastError }),
        turn_count: record.turns.length,
        thread_count: hostThreads(record).length,
        revision: context.hub.getRevision('session', record.id)
    };
};

/**
 * The identified session read: a row plus the live model map, the key-free endpoint view,
 * the created-tool/pending-action counts, and where turns execute. The heavy children
 * (turns, threads, transcripts, definition, events) stay on their own routes.
 */
export const sessionResourceOf = (record: SessionRecord, context: ReadContext): SessionResource => ({
    ...sessionSummaryOf(record, context),
    definition_revision: context.hub.getRevision('definition', record.id),
    agent_models: agentModelsOf(record),
    endpoint: providerDefaultsOf(record.settings as { baseURL: string; model: string; apiKey?: string }),
    runtime_execution: context.runtime.threadExecution,
    pending_action_count: record.pendingActions.size,
    created_tool_count: createdToolNames(record).length,
    created_tool_limit: context.createdToolLimit,
    // T1.5's last mile (ADDITIVE, and ABSENT when empty): the plugin diagnostics this session
    // reported — a hook that threw or timed out, an unparseable decision, or a plugin's own
    // `policy` report — each naming its OWNING plugin. This is the surface that makes "the
    // compactor is broken" answerable from the identified session read instead of only from the
    // server's stderr. Emitted only when there IS a journal, so every pre-T4 row keeps its exact
    // key set (the `queue_depth` rule above, and `src/server/sessions.ts`
    // `Session.pluginDiagnostics` for the cap and the durability rule).
    //
    // Verbatim camelCase inside, like every other domain payload on this contract
    // (`HarnessMessage`, the display subtree): these are the library's diagnostic fields plus the
    // receive timestamp, copied so a consumer cannot mutate the stored journal.
    ...(record.pluginDiagnostics.length === 0
        ? {}
        : { plugin_diagnostics: record.pluginDiagnostics.map((entry) => ({ ...entry })) })
});

/** The live per-agent model map, read from the running brains (never a snapshot copy). */
export const agentModelsOf = (record: SessionRecord): Record<string, string> => {
    const models: Record<string, string> = {};

    for (const [name, brain] of Object.entries(record.harness.agents)) {
        models[name] = brain.model();
    }

    return models;
};

/**
 * Names this session CREATED, as opposed to the tools it was built or configured with.
 *
 * The domain already keeps this accounting, and it is the only honest source: the harness
 * snapshot records `createdTools` / `createdToolCount` for registrations that happened INSIDE
 * the session (model `toolCreate`/`toolRegistry` or a host/REST registration), while
 * `harness.toolSources()` also lists the shared/app tools the toolbox installs (some of them
 * lazily, on first use), which would make a fresh session look as if it had already spent its
 * creation allowance.
 *
 * The store's `core` field is the LAST COMMITTED snapshot, refreshed by the harness state
 * observer at every mutation boundary (a tool registration is one), so reading it costs
 * nothing and is the same figure persistence writes. A REST registration therefore shows up
 * in the receipt it returns, not one request later.
 */
export const createdToolNames = (record: SessionRecord): string[] =>
    (record.core.createdTools ?? []).map((created) => created.name);

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * A turn row for the paged conversation surface. Comes from the per-turn display cache
 * (`projector.summary()`), which the recorder already maintains, so building a page costs
 * no event fold and no `copyTurns`.
 *
 * The projector's row is the camelCase display model; the wire row is the same field names
 * (spec: the display subtree keeps camelCase) except the task text, which becomes the bounded
 * `promptPreview` + exact `promptChars` pair — for the row's own `prompt` AND for every
 * `steers[i]` entry (spec: `TurnSummary` and `DisplaySteerSummary` are both closed objects with
 * that pair, ./harness.swagger.yaml:6108 / :6075).
 */
export const turnRowOf = (projector: TurnProjector, turnId: string): WireTurnSummary => {
    const row = projector.summary() as unknown as Record<string, unknown>;
    const prompt = typeof row.prompt === 'string' ? row.prompt : '';

    const projected: Record<string, unknown> = { ...row };

    delete projected.prompt;
    projected.promptPreview = promptPreview(prompt);
    projected.promptChars = prompt.length;

    // The steer entries ride the same rename (see `steerRowOf`): the projector's row carries the
    // submit's verbatim text under `prompt`, the wire row carries `promptPreview` + `promptChars`.
    if (Array.isArray(projected.steers)) {
        projected.steers = (projected.steers as unknown[]).map((steer) =>
            steer === null || typeof steer !== 'object' ? steer : steerRowOf(steer as Record<string, unknown>)
        );
    }

    // `detail` is a projector-internal one-liner; keep it (the wire row allows it).
    return projected as unknown as WireTurnSummary & { id: string };
};

/**
 * One steer entry of the projector's row -> the WIRE `DisplaySteerSummary`.
 *
 * The contract (../shared/harness-api.ts:1718-1726, from ./harness.swagger.yaml:6075-6107) is a
 * CLOSED object whose text field is `promptPreview` beside the EXACT `promptChars`; it requires
 * `[at, promptPreview, promptChars]` and sends nothing outside that set. The projector instead
 * keeps the submit's verbatim text under `prompt` (./turn-projector.ts:2794-2808, whose member
 * type is the INTERNAL render model ../shared/turn-display.ts:281-296), so copying the row's steer
 * list verbatim shipped a field the spec forbids and omitted both fields the spec requires — a
 * consumer that followed the spec would have read `undefined`.
 *
 * This is the identical delta `turnRowOf` applies to the row's own prompt one line above, per
 * entry: same bound (`TURN_PROMPT_PREVIEW_CHARS`), same exact length. WIRE PROJECTION ONLY — the
 * projector, the audit record (`SessionSteerRecord`, ./protocol.ts:224-246) and every event/domain
 * shape keep `prompt`, and the client's render model keeps `prompt`
 * (../frontend/display-project.ts `projectSteers`).
 */
export const steerRowOf = (steer: Record<string, unknown>): Record<string, unknown> => {
    const text = typeof steer.prompt === 'string' ? steer.prompt : '';

    const projected: Record<string, unknown> = { ...steer };

    delete projected.prompt;
    projected.promptPreview = promptPreview(text);
    projected.promptChars = text.length;

    return projected;
};

/** A bounded preview of a task text, with the exact length reported separately. */
export const promptPreview = (prompt: string, limit = TURN_PROMPT_PREVIEW_CHARS): string =>
    prompt.length <= limit ? prompt : previewText(prompt, limit);

/**
 * The identified turn read: metadata plus COUNTS. `events`, `eventTimes`, `steerTexts`, and
 * attachment bytes are counted, never inlined; the verbatim prompt lives here because this
 * route is the one place the contract says the full task text is readable.
 */
export const turnResourceOf = (
    record: SessionRecord,
    turn: SessionRecord['turns'][number],
    context: ReadContext,
    opts: { verbatimPrompt?: boolean } = {}
): TurnResource => {
    const attachments = turn.attachments ?? [];
    const steers = turn.steers ?? [];
    const steerTexts = (turn as { steerTexts?: unknown[] }).steerTexts ?? [];
    const thread = turn.threadId === undefined ? undefined : record.harness.thread(turn.threadId);

    return {
        session_id: record.id,
        id: turn.id,
        index: turn.index,
        status: turn.status,
        prompt: opts.verbatimPrompt === false ? promptPreview(turn.prompt) : turn.prompt,
        ...(turn.threadId === undefined ? {} : { thread_id: turn.threadId }),
        ...(turn.threadLabel === undefined ? {} : { thread_label: turn.threadLabel }),
        ...(turn.startedAt === undefined ? {} : { started_at: turn.startedAt }),
        updated_at: turn.updatedAt,
        ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } }),
        ...(turnErrorOf(turn) === undefined ? {} : { error: turnErrorOf(turn)! }),
        ...(turn.references === undefined || turn.references.length === 0
            ? {}
            : { references: turn.references.map((reference) => ({ ...reference })) }),
        ...(attachments.length === 0
            ? {}
            : { attachments: attachments.map((attachment) => attachmentDescriptorOf(attachment)) }),
        event_count: turn.events.length,
        ...(turn.eventTimes === undefined ? {} : { event_time_count: turn.eventTimes.length }),
        attachment_count: attachments.length,
        steer_count: steers.length,
        ...(steerTexts.length === 0 ? {} : { steer_text_count: steerTexts.length }),
        ...(steers.length === 0
            ? {}
            : {
                  steers: steers.map((steer) => ({
                      ...(steer.id === undefined ? {} : { id: steer.id }),
                      at: steer.at,
                      prompt_preview: promptPreview(steer.prompt, QUEUE_PREVIEW_CHARS),
                      prompt_chars: steer.prompt.length,
                      // A steer delivered to the owning turn's own conversation is not
                      // restated (spec: only when it is NOT the owning thread).
                      ...(steer.threadId === undefined || steer.threadId === turn.threadId
                          ? {}
                          : { thread_id: steer.threadId }),
                      ...(steer.references === undefined || steer.references.length === 0
                          ? {}
                          : { references: steer.references.map((reference: AgentResultReference) => ({ ...reference })) })
                  }))
              }),
        revision: context.hub.getRevision('turn', turnKey(record.id, turn.id))
    };
};

/** The thread id a conversation-scoped revision key carries (`session:turn`). */
export const turnKey = (sessionId: string, turnId: string): string => `${sessionId}:${turnId}`;

/** The thread key half of a transcript/thread revision (`session:thread`). */
export const threadKey = (sessionId: string, threadId: string): string => `${sessionId}:${threadId}`;

/** The recorded failure of a turn, read off the LAST recorded `error` event, verbatim. */
const turnErrorOf = (turn: SessionRecord['turns'][number]): HarnessErrorInfo | undefined => {
    for (let index = turn.events.length - 1; index >= 0; index -= 1) {
        // Read through a loose shape: the recorded event union narrows `error` to the
        // variants that carry one, and this scan intentionally looks at every entry.
        const event = turn.events[index] as { type?: string; error?: unknown };

        if (event.type === 'error' && event.error !== undefined) {
            return event.error as HarnessErrorInfo;
        }
    }

    return undefined;
};

/** One attachment without its bytes (the chips a composer and a transcript render). */
export const attachmentDescriptorOf = (attachment: HarnessAttachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    marker: attachment.marker,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    has_bytes: typeof attachment.data === 'string' && attachment.data.length > 0
});

/**
 * A page of one turn's verbatim recorded events, paired with their recorded times.
 * `partial` is true while the turn still runs, which is what tells a client to keep
 * paging from `next_cursor` instead of treating the record as final.
 */
export const turnEventRowsOf = (
    turn: SessionRecord['turns'][number],
    offset: number,
    limit: number,
    typeFilter?: string
): { rows: TurnEventRow[]; total: number; partial: boolean } => {
    const times = turn.eventTimes ?? [];
    const rows: TurnEventRow[] = [];

    // The filter runs over the ORDINAL space, not the filtered array: a cursor addresses
    // recorded positions (spec: "an event or message ordinal"), so skipping non-matching
    // events must not shift what the next cursor means.
    let served = 0;
    let collected = 0;

    for (let index = 0; index < turn.events.length; index += 1) {
        const event = turn.events[index] as HarnessEvent;

        if (typeFilter !== undefined && event.type !== typeFilter) continue;

        if (served < offset) {
            served += 1;
            continue;
        }

        if (collected >= limit) break;

        const time = times[index];

        rows.push({
            index,
            ...(typeof time === 'number' && Number.isFinite(time) ? { at: time } : {}),
            event
        });

        served += 1;
        collected += 1;
    }

    const matchingTotal =
        typeFilter === undefined
            ? turn.events.length
            : turn.events.reduce((count, event) => (event.type === typeFilter ? count + 1 : count), 0);

    return {
        rows,
        total: matchingTotal,
        partial: turn.status === 'running' || turn.status === 'queued'
    };
};

// ---------------------------------------------------------------------------
// Threads (conversations)
// ---------------------------------------------------------------------------

/**
 * A roster row. Built from the harness thread RECORDS plus the store's labels, so no
 * transcript travels: `message_count`/`chars`/`preview` are the signals a client uses to
 * decide whether a transcript read is worth asking for.
 */
export const threadRowOf = (
    record: SessionRecord,
    thread: ReturnType<SessionRecord['harness']['threads']>[number],
    label: string | undefined,
    messages: HarnessMessage[] | undefined,
    opts: { withPreview?: boolean } = {}
): ThreadSummary => {
    const invalid = record.invalidThreads.get(thread.id);
    const unreadable = invalid !== undefined;
    const entries = messages ?? [];
    const preview = opts.withPreview === true ? lastEntryPreview(entries) : undefined;

    return {
        id: thread.id,
        agent: thread.agent,
        origin: thread.origin,
        status: thread.status,
        sequence: thread.sequence,
        ...(thread.ownerThreadId === undefined ? {} : { owner_thread_id: thread.ownerThreadId }),
        ...(label === undefined ? {} : { label }),
        transcript_state: unreadable ? 'unreadable' : 'ok',
        ...(unreadable ? { transcript_error: invalid.error } : {}),
        message_count: unreadable ? 0 : entries.length,
        ...(entries.length === 0 ? {} : { chars: entryChars(entries) }),
        has_transcript: unreadable ? false : entries.length > 0,
        ...(preview === undefined ? {} : { preview })
    };
};

/** A bounded tail of the last transcript entry (never the whole transcript). */
const lastEntryPreview = (messages: readonly HarnessMessage[]): string | undefined => {
    const last = messages[messages.length - 1];

    if (last === undefined) return undefined;

    const content = typeof last.content === 'string' ? last.content : '';

    if (content.length === 0) return undefined;

    return previewText(content, THREAD_PREVIEW_CHARS);
};

/** Summed content length of a transcript, reported as a size signal only. */
const entryChars = (messages: readonly HarnessMessage[]): number =>
    messages.reduce((total, entry) => total + (typeof entry.content === 'string' ? entry.content.length : 0), 0);

/** The full thread resource: a row plus the invocation roster and the reference graph. */
export const threadResourceOf = (
    record: SessionRecord,
    row: ThreadSummary,
    messages: readonly HarnessMessage[],
    context: ReadContext,
    opts: { transcriptBytes?: number; transcriptRevision?: number } = {}
): ThreadResource => {
    const turn = owningTurnOf(record, row.id);
    const invocationIds = uniqueInvocationIds(record, row.id, turn);

    return {
        ...row,
        session_id: record.id,
        ...(turn === undefined ? {} : { origin_turn_id: turn.id }),
        ...(turn === undefined ? {} : { origin_invocation_id: record.turnInvocations.get(turn.id) }),
        ...(latestInvocationId(record, row.id) === undefined
            ? {}
            : { invocation_id: latestInvocationId(record, row.id) }),
        invocation_ids: invocationIds,
        // The roster budget is the store's own cap on the persisted invocation map; a
        // longer history reports `true` so a client never reads a truncated list as total.
        invocation_ids_truncated: invocationIds.length >= MAX_ROSTER_INVOCATIONS,
        ...(turn?.references === undefined || turn.references.length === 0
            ? {}
            : { references: turn.references.map((reference) => ({ ...reference })) }),
        ...(connectedThreadsOf(record, row.id).length === 0
            ? {}
            : { connected_thread_ids: connectedThreadsOf(record, row.id) }),
        transcript_revision: context.hub.getRevision('transcript', threadKey(record.id, row.id)),
        ...(opts.transcriptBytes === undefined
            ? {}
            : { transcript_bytes: opts.transcriptBytes }),
        revision: context.hub.getRevision('thread', threadKey(record.id, row.id))
    };
};

/** Cap on the invocation ids one roster row reports (bounded wire, same rule as the store). */
export const MAX_ROSTER_INVOCATIONS = 64;

/** Every invocation id recorded in this conversation, oldest first, capped. */
const uniqueInvocationIds = (record: SessionRecord, threadId: string, turn: { id: string } | undefined): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const [invocationId, mapped] of record.invocationThreads) {
        if (mapped !== threadId) continue;
        if (seen.has(invocationId)) continue;

        seen.add(invocationId);
        ids.push(invocationId);

        if (ids.length >= MAX_ROSTER_INVOCATIONS) break;
    }

    return ids;
};

/** The most recent invocation observed in this conversation. */
const latestInvocationId = (record: SessionRecord, threadId: string): string | undefined => {
    let latest: string | undefined;

    for (const [invocationId, mapped] of record.invocationThreads) {
        if (mapped === threadId) latest = invocationId;
    }

    return latest;
};

/** Reference EDGES out of this conversation (a link, not ownership). */
const connectedThreadsOf = (record: SessionRecord, threadId: string): string[] => {
    const connected = new Set<string>();

    for (const turn of record.turns) {
        if (turn.threadId !== threadId) continue;

        for (const reference of turn.references ?? []) {
            if (reference.threadId === undefined || reference.threadId === threadId) continue;

            connected.add(reference.threadId);
        }
    }

    return [...connected].sort();
};

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/** The cheap head of one transcript: counts/size/validity, no content. */
export const transcriptMetadataOf = (
    record: SessionRecord,
    threadId: string,
    agent: string,
    messages: readonly HarnessMessage[],
    context: ReadContext
): TranscriptMetadata => {
    const invalid = record.invalidThreads.get(threadId);
    const roleCounts = { system: 0, user: 0, assistant: 0, tool: 0 };

    for (const entry of messages) {
        if (entry.role in roleCounts) {
            roleCounts[entry.role as keyof typeof roleCounts] += 1;
        }
    }

    const chars = entryChars(messages);

    return {
        session_id: record.id,
        thread_id: threadId,
        agent,
        transcript_state: invalid === undefined ? 'ok' : 'unreadable',
        message_count: messages.length,
        chars,
        // Serialized size signal: `chars` is what an editor shows, `bytes` what a client
        // would download. They differ only for non-ASCII content, which is honest.
        bytes: Buffer.byteLength(JSON.stringify(messages), 'utf8'),
        revision: context.hub.getRevision('transcript', threadKey(record.id, threadId)),
        role_counts: roleCounts,
        ...(invalid === undefined ? {} : { unreadable_reason: invalid.error, stored_type: storedTypeOf(invalid.messages) })
    };
};

/** The JSON type name of a stored unreadable value (the editor shows what it found). */
export const storedTypeOf = (value: unknown): 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';

    const type = typeof value;

    if (type === 'string' || type === 'number' || type === 'boolean') return type;

    return 'object';
};

/** Counts + state for the `transcript.updated` stream signal (never the bodies). */
export const transcriptSignalOf = (
    threadId: string,
    revision: number,
    messages: readonly HarnessMessage[],
    unreadable: boolean
): TranscriptSignal => ({
    thread_id: threadId,
    revision,
    message_count: messages.length,
    transcript_state: unreadable ? 'unreadable' : 'ok'
});

// ---------------------------------------------------------------------------
// Queue / actions / usage / commands
// ---------------------------------------------------------------------------

/**
 * Every pending task, in pump order (legacy queue first, then each lane's backlog, then
 * the active run of each lane): the same ordering the store's own snapshots use, built from
 * the queue arrays themselves so no turn is copied.
 */
export const queueRowsOf = (record: SessionRecord): QueuedTask[] => {
    const ordered: SessionRecord['queue'][number][] = [...record.queue];

    for (const lane of record.lanes.values()) ordered.push(...(lane as ThreadLaneInfo).queue);

    ordered.sort((left, right) => left.index - right.index);

    return ordered.map((turn, position) => {
        const attachments = turn.attachments ?? [];

        return {
            turn_id: turn.id,
            index: turn.index,
            position,
            status: turn.status,
            prompt_preview: promptPreview(turn.prompt, QUEUE_PREVIEW_CHARS),
            prompt_chars: turn.prompt.length,
            ...(turn.threadId === undefined ? {} : { thread_id: turn.threadId }),
            ...(turn.threadLabel === undefined ? {} : { thread_label: turn.threadLabel }),
            ...(turn.references === undefined || turn.references.length === 0
                ? {}
                : { reference_labels: turn.references.map((reference) => reference.label) }),
            ...(attachments.length === 0 ? {} : { attachment_count: attachments.length }),
            // A queued turn has no `startedAt` yet, and its `updatedAt` IS the instant the
            // server accepted it, which is the figure this field states.
            ...(turn.startedAt === undefined ? { accepted_at: turn.updatedAt } : { accepted_at: turn.startedAt })
        };
    });
};

/** The usage fold: server-summed per-turn tallies, honest about providers that report none. */
export const usageFoldOf = (record: SessionRecord, context: ReadContext) => {
    const totals: HarnessUsage = { input: 0, output: 0, total: 0 };
    const byThread = new Map<string, HarnessUsage>();
    let reported = 0;

    for (const turn of record.turns) {
        const usage = turn.usage;

        if (usage === undefined) continue;

        reported += 1;
        totals.input += usage.input ?? 0;
        totals.output += usage.output ?? 0;
        totals.total += usage.total ?? 0;

        if (turn.threadId === undefined) continue;

        const share = byThread.get(turn.threadId) ?? { input: 0, output: 0, total: 0 };

        share.input += usage.input ?? 0;
        share.output += usage.output ?? 0;
        share.total += usage.total ?? 0;
        byThread.set(turn.threadId, share);
    }

    const perThread: UsageByThread[] = [...byThread.entries()].map(([thread_id, usage]) => ({
        thread_id,
        usage
    }));

    return {
        session_id: record.id,
        turn_count: record.turns.length,
        reported_turns: reported,
        // Absent, not zero: "the provider never reported" is not "the session cost 0".
        ...(reported === 0 ? {} : { usage: totals }),
        by_thread: perThread,
        // The per-thread fold is bounded by the thread budget, so a session at the cap
        // says so instead of implying its roster is complete.
        truncated: byThread.size >= HARNESS_SERVICE_LIMITS.thread_records,
        revision: context.hub.getRevision('usage', record.id)
    };
};

/** The slash commands this session's live registry answers, projected for a composer. */
export const commandRowsOf = (record: SessionRecord): CommandDescriptor[] => {
    const registry = record.harness.commands as Record<string, { name: string; description: string; usage?: string }>;

    return Object.values(registry ?? {})
        .map((command) => ({
            name: command.name,
            invocation: `/${command.name}`,
            description: command.description,
            ...(command.usage === undefined ? {} : { usage: command.usage })
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
};

// ---------------------------------------------------------------------------
// Record store (the records/tasks panels' bootstrap and delta reads)
// ---------------------------------------------------------------------------

// T4 (data plane): the two projections behind
// `GET /v1/harness/sessions/{session_id}/records`. They are pure and live here rather
// than in ./api.ts because they are the ONLY place the engine's camelCase read model
// becomes the contract's snake_case wire rows — the same rule every other resource in
// this file follows (see the NAMING note at the top).
//
// WHY THE ENGINE'S `view()` AND NOT A `records list` CALL: a tool call answers the
// MODEL, so its output carries count facets, previews of `strings` fields, and a
// page cursor. A panel wants the declared field spec plus the rows, with no
// decoration; `view()` is that projection, built from the same entries, and it costs
// one synchronous read of state the engine already holds.

/** One declared field, projected for a renderer: the vocabulary a panel draws columns from. */
const recordFieldRowOf = (field: RecordFieldDefinition): RecordFieldDescriptor => ({
    key: field.key,
    type: field.type,
    // The engine treats an absent `required` as optional; the wire field is a plain
    // boolean, so a missing flag becomes `false` rather than an absent key.
    required: field.required === true,
    // Only an `enum` has a closed value set, and a panel needs it to build the filter
    // control. `readonly string[]` becomes a fresh mutable array: the engine's copy is
    // its own spec object and a response body must not hand out a live reference.
    ...(field.values === undefined || field.values.length === 0 ? {} : { values: [...field.values] })
});

// One stored entry, projected key by key in the COLLECTION's canonical order:
//   - `id` first, then the declared fields, then `rev`, then the attribution triple;
//   - a field the entry does not carry is ABSENT, never null — "not set" and "set to
//     nothing" are different facts for a renderer, and a `getOnly` field (a chapter
//     body) is excluded by the engine's list projection before it ever reaches here;
//   - an undeclared key is dropped, so a store edited by an older build cannot leak a
//     field the current collection spec does not describe.
const recordEntryRowOf = (fields: readonly RecordFieldDefinition[], entry: RecordEntry): RecordEntryRow => {
    const row: Record<string, unknown> = { id: entry.id };

    for (const field of fields) {
        if (entry[field.key] !== undefined) row[field.key] = entry[field.key];
    }

    // `rev` is the CAS token a guarded `records` write echoes as `expects: [{id, rev}]`.
    // It is NOT the stream revision and never a cursor for one.
    row.rev = entry.rev;

    // Attribution comes from the calling CONTEXT, never from tool arguments, and the
    // keys stay absent when the store has no such fact (an engine restored from a
    // snapshot written before attribution, or a caller with no agent identity).
    if (entry.updatedBy !== undefined) row.updated_by = entry.updatedBy;
    if (entry.updatedThreadId !== undefined) row.updated_thread_id = entry.updatedThreadId;
    if (entry.updatedAt !== undefined) row.updated_at = entry.updatedAt;

    return row as RecordEntryRow;
};

// One feed entry. `rev` inside it stays the COLLECTION's revision (Decision B's window),
// while `seq` is the store-wide position the client cursors on — the two are deliberately
// kept apart rather than flattened into one number, because a per-collection log is what a
// `records since:` read answers with.
const recordChangeRowOf = (change: RecordStoreChange): RecordChangeRow => ({
    seq: change.seq,
    collection: change.collection,
    rev: change.rev,
    id: change.id,
    op: change.op,
    ...(change.by === undefined ? {} : { by: change.by }),
    ...(change.threadId === undefined ? {} : { thread_id: change.threadId }),
    at: change.at,
    ...(change.fields === undefined ? {} : { fields: [...change.fields] }),
    ...(change.itemRev === undefined ? {} : { item_rev: change.itemRev })
});

/**
 * The bootstrap read: every collection, whole, plus the retained store-wide feed.
 *
 * `revision` is the caller's hub counter for the `records` resource, stamped so a client
 * can order this response against a `records.updated` frame it received at the same time
 * (a read at or above a frame's revision supersedes that frame — the stream contract's
 * staleness rule, identical to every other collection here).
 */
export const recordsSnapshotOf = (record: SessionRecord, revision: number): RecordsSnapshotResponse => {
    const view = record.harness.records();

    return {
        session_id: record.id,
        revision,
        store_rev: view.storeRev,
        collections_rev: view.collectionsRev,
        collections: view.collections.map((collection) => ({
            name: collection.name,
            store_rev: collection.storeRev,
            count: collection.count,
            fields: collection.fields.map(recordFieldRowOf),
            entries: collection.entries.map((entry) => recordEntryRowOf(collection.fields, entry))
        })),
        changes: view.changes.map(recordChangeRowOf)
    };
};

/**
 * The delta read: the feed after `since` and nothing else, plus the engine's honest
 * `reset` flag when that position has aged out of the retained window (or the store was
 * replaced by a reset/restore/restart). The flag is the engine's decision, never this
 * projection's — a client comparing two revision numbers cannot see a trimmed gap.
 */
export const recordsDeltaOf = (record: SessionRecord, since: number, revision: number): RecordsDeltaResponse => {
    const delta = record.harness.recordsChanges(since);

    return {
        session_id: record.id,
        revision,
        store_rev: delta.storeRev,
        collections_rev: delta.collectionsRev,
        changes: delta.changes.map(recordChangeRowOf),
        reset: delta.reset
    };
};

// ---------------------------------------------------------------------------
// Session toolbox
// ---------------------------------------------------------------------------

/**
 * Whether a name is one of the harness-owned control tools the runtime ships (`toolRequest`,
 * `tasks`, ...). SESSION semantics only, and today ONLY for the execution gate below: these
 * entries have no standalone implementation, so the session route is the one that can run
 * them. It is deliberately NOT the source of a session row's `protected` figure any more —
 * that is the kernel's own switchability answer, see `sessionToolRowsOf` — because the two
 * sets genuinely differ: `delegate` is refused by the kernel without being in this list, and
 * `syntax`/`files`/`shell` are in neither list and ARE switchable. The GLOBAL deployment
 * switch does not consult it either — every listed tool is switchable there
 * (./tool-settings.ts).
 */
const isCoreToolName = (name: string): boolean => CORE_TOOL_NAMES.includes(name);

/**
 * The catalogue entry one tool name resolves to, using the SAME lookup the global Tools
 * routes use (./api.ts resolves a name as `coreEntries.find(name) ?? catalogue.find(name)`).
 *
 * WHY THE HARNESS-OWNED HALF MATTERS: `createToolCatalogue()` carries the directly callable
 * tools, so a runtime name (`delegate`, `records`, `threadSend`, ...) is invisible to
 * `catalogue.find` and every row metadata field falls back to its "no entry" default —
 * `group: 'Created tools'`, `visibility: 'searchable'`, `session_bound: false`. That made the
 * session pane call `delegate` a created, searchable, non-session-bound tool while the global
 * Tools list called the same name a core, session-bound one. One resolver for both surfaces
 * is what keeps those two rows about one tool, and ./api.ts calls THIS function for its global
 * name lookups so the rule cannot be restated differently on either side.
 */
export const toolEntryOf = (name: string, context: ReadContext): CatalogueEntry | undefined =>
    context.coreEntries?.find((entry) => entry.name === name) ?? context.catalogue.find(name);

/**
 * Every live registry entry as a session row.
 *
 * The state a catalogue row CANNOT state comes from the running harness:
 *   - `declared`  - the frozen definition's `coreTools` carries the name, i.e. it is in
 *                   context on every request (NOT `definition.tools`, which is the larger set
 *                   this card REGISTERS and most of which still has to be discovered);
 *   - `enabled`   - the live enabled set (`harness.discoveredTools`);
 *   - `origin`    - `created` when a source revision is installed, `discovered` when the
 *                   enabled set contains a non-declared name, `catalogue` otherwise;
 *   - `protected` - the ONE figure this projection does not decide for itself: it is the
 *                   NEGATION of the kernel's own switchability predicate
 *                   (`harness.isToolSwitchable`, ../harness.ts `occupiesSearchableSlot`), the
 *                   same code path the enable/disable operations refuse with. A catalogue row
 *                   cannot state it and a server-side guess from `visibility` cannot either
 *                   (`toolCancel` is demoted to `visibility: 'searchable'` at registration yet
 *                   stays pending-only, so it is NOT switchable). Stating the kernel's answer
 *                   BEFORE the click is what lets the pane grey the row out instead of
 *                   answering a click with a refusal: the write routes' 403 and this field are
 *                   now the same fact, so no clickable row can be refused.
 *                   This is a per-conversation fact; the global Tools rows carry no such
 *                   field, because the deployment-wide switch applies to every name;
 *   - `source_*`  - the installed source revision, which is what makes the source route
 *                   worth calling.
 */
export const sessionToolRowsOf = (record: SessionRecord, context: ReadContext): SessionToolSummary[] => {
    const declared = new Set<string>(record.definition.coreTools ?? []);
    const enabled = new Set<string>(record.harness.discoveredTools ?? []);
    const sources = new Map(record.harness.toolSources().map((source) => [source.name, source]));
    // One rule decides `origin` and the budget, so a row and the page's budget can never
    // disagree about which revisions belong to this session.
    const created = new Set(createdToolNames(record));
    const live = liveToolNames(record);

    return live.map((name) => {
        const entry = toolEntryOf(name, context);
        const source = sources.get(name);
        const isDeclared = declared.has(name);
        const isEnabled = enabled.has(name);

        return {
            ...toolSummaryOf(entry, name, liveToolDescription(record, name)),
            session_id: record.id,
            declared: isDeclared,
            enabled: isEnabled,
            // `created` is what this session registered; `discovered` is an enabled name this
            // session did not declare (a `toolRequest` match, or the host's new-session toolbox
            // seed — same slot in the same capped set); `catalogue` is everything else.
            origin: created.has(name) ? 'created' : !isDeclared && isEnabled ? 'discovered' : 'catalogue',
            protected: !record.harness.isToolSwitchable(name),
            source_available: source !== undefined,
            ...(source === undefined ? {} : { source_revision: source.revision })
        };
    });
};

/** The live registry's names, in insertion order (the order the model sees them). */
const liveToolNames = (record: SessionRecord): string[] => {
    const listed = record.harness.runtime.listTools() as { name: string }[];

    return listed.map((entry) => entry.name);
};

/** The live description of one registry entry (a replaced implementation owns its text). */
const liveToolDescription = (record: SessionRecord, name: string): string | undefined => {
    const listed = record.harness.runtime.listTools() as { name: string; description?: string }[];
    const entry = listed.find((candidate) => candidate.name === name);

    return entry?.description;
};

/** One session tool's detail row: the summary plus the schema and the execution gate. */
export const sessionToolDetailOf = (
    record: SessionRecord,
    name: string,
    context: ReadContext
): SessionToolDetail => {
    const rows = sessionToolRowsOf(record, context);
    const row = rows.find((candidate) => candidate.name === name);

    // A name the live registry does not hold cannot be addressed by this route: every caller
    // answers 404 from the row list first (`./api.ts` `getSessionTool`, `patchSessionTool`,
    // `deleteSessionTool`), so the row below is a type-complete fallback, not a claim a client
    // ever sees. What it states must still be TRUE for the name, which is why `protected` is
    // the kernel's own answer rather than a literal: an unregistered name is by definition not
    // switchable (`../harness.ts` `occupiesSearchableSlot` reads the live registry), so a
    // fallback that said `protected: false` would contradict the row rule it stands in for
    // (`sessionToolRowsOf` above sets `protected = !isToolSwitchable(name)`).
    if (row === undefined) {
        return {
            ...toolSummaryOf(toolEntryOf(name, context), name),
            session_id: record.id,
            declared: false,
            enabled: false,
            origin: 'catalogue',
            protected: !record.harness.isToolSwitchable(name),
            source_available: false,
            execution: toolExecutionScopeOf(name)
        };
    }

    const details = toolDetailsOf(record, name);

    return {
        ...row,
        ...(details.parameters === undefined ? {} : { parameters: details.parameters }),
        execution: toolExecutionScopeOf(name)
    };
};

/** Per-tool metadata the live registry states for itself (schema/visibility/parameters). */
const toolDetailsOf = (
    record: SessionRecord,
    name: string
): { parameters?: Record<string, unknown>; visibility?: ToolVisibility } => {
    try {
        const details = record.harness.runtime.manageTool(undefined, {
            operation: 'details',
            name
        }) as { parameters?: Record<string, unknown>; visibility?: ToolVisibility } | undefined;

        return details ?? {};
    } catch {
        // A registry that predates `toolManage details` still answers the row; only the
        // schema is missing, and the catalogue projection below supplies it.
        return {};
    }
};

/** How one entry may be called over HTTP, stated rather than inferred by the client. */
export const toolExecutionScopeOf = (name: string): ToolExecutionScope => ({
    // THIS IS THE EXECUTION AXIS, and it is a DIFFERENT predicate from the row's `protected`
    // flag on the switch axis. `session_required` names the control-plane entries the runtime
    // ships that have NO standalone implementation (`CORE_TOOL_NAMES` = `toolRequest` and
    // `tasks`, ./harnesses/toolbox.ts:194-196), because only a live conversation can run them.
    // `protected` answers whether THIS conversation may switch the name at all, which is the
    // kernel's switchability rule and covers a far wider set — `read`, `write`, `edit`, `glob`,
    // `grep`, `delegate` and `toolCancel` are all protected (../harness.ts
    // `occupiesSearchableSlot`) while remaining callable through the session route, so they
    // stay `session_only` here. The two figures disagree ON PURPOSE; neither one may be derived
    // from the other (see the `isCoreToolName` note above and `sessionToolRowsOf`).
    scope: isCoreToolName(name) ? 'session_required' : 'session_only',
    // Manual execution is the documented session surface for every live entry.
    manual: true
});

/** The installed source revision of one session tool (the editor's payload). */
export const sessionToolSourceOf = (
    record: SessionRecord,
    name: string
): SessionToolSourceResponse | undefined => {
    const source = record.harness.toolSource(name);

    if (source === undefined) return undefined;

    return {
        session_id: record.id,
        name: source.name,
        revision: source.revision,
        ...(source.sourcePath === undefined ? {} : { source_path: source.sourcePath }),
        ...(source.moduleText === undefined ? {} : { module_text: source.moduleText }),
        ...(source.source === undefined ? {} : { source: source.source }),
        ...(source.dependencies.length === 0
            ? {}
            : { dependencies: source.dependencies.map((dependency) => ({ ...dependency })) })
    };
};

// ---------------------------------------------------------------------------
// Session agents
// ---------------------------------------------------------------------------

/**
 * The live roster: what the session was BUILT with (the frozen definition) joined with
 * what it RUNS now (the running brains). Instruction TEXT is absent - it is one named
 * subresource away - so a roster read is constant-size however long the prompts are.
 *
 * R6 adds the removal guard to the row: `deletable` is false while the member owns a host
 * conversation, because `DELETE /sessions/{id}/agents/{agent_id}` answers 409 on exactly that
 * condition (./sessions.ts `removeSessionAgent`). Stating it here is what lets a client disable
 * the button instead of discovering the rule with a failing call.
 *
 * R7 adds the session-defined members: a name in `preset.customAgents` was invented by THIS
 * conversation, so its text has no catalogue provenance — the row reports
 * `instruction_source: 'session'` for it and never asks the profile ladder about it.
 */
export const sessionAgentRowsOf = (record: SessionRecord, context: ReadContext): SessionAgentBinding[] => {
    const definition = record.definition;
    const members = [...definition.agents];
    const brains = record.harness.agents as Record<string, { model: () => string; instructions: readonly string[] }>;
    const overrides = record.preset.agentInstructions ?? {};

    // R6: the agents that own at least one independent conversation. One pass over the thread
    // records for the whole roster (the runtime's own `removeAgent` backstop checks the same
    // predicate per member, ./harness.ts), and `origin === 'host'` is the whole distinction: a
    // member's DEFAULT conversation (`agent:<name>`) travels with it and never blocks a removal.
    const threadUsers = new Set(
        record.harness
            .threads()
            .filter((thread) => thread.origin === 'host')
            .map((thread) => thread.agent)
    );

    // R7: the members this session invented (agent id → base instruction). Absent for every
    // harness definition and every session saved before R7, which is what keeps the existing
    // provenance ladder untouched for them.
    const customs = record.preset.customAgents ?? {};

    return members.map((name) => {
        const brain = brains[name];
        const inherited = definition.agentModels?.[name];
        const instructionText = (brain?.instructions ?? []).join('\n');
        const isCustom = Object.prototype.hasOwnProperty.call(customs, name);

        // A custom member's text can only have come from this conversation, so the ladder below
        // (harness override → global layer → shipped profile) is not asked: a custom name has no
        // profile, and `overridesOf`/`effective` would answer for a profile that does not exist.
        const source = isCustom
            ? 'session'
            : instructionSourceOf(name, overrides, record.preset.agentModels, context.agentState, instructionText);

        return {
            agent_id: name,
            profile: name,
            role: name === definition.primary ? 'primary' : 'subagent',
            // T27: the roster lists BOTH kinds of member, and the contract distinguishes them.
            // A member the harness definition shipped is `definition`; one bound into THIS
            // conversation by `POST /sessions/{id}/agents` is `session` — same trusted profile,
            // same live brain, but a binding this conversation made and may detach again. The
            // store keeps that provenance list on the record (durable, `sessionAgents`) rather
            // than inferring it from the preset, which a session-local override also mutates.
            origin: (record.sessionAgents ?? []).includes(name) ? 'session' : 'definition',
            model: brain?.model() ?? record.settings.model,
            inherited_model: inherited ?? record.settings.model,
            instruction_source: source,
            instruction_chars: instructionText.length,
            // R7: for a session-defined member the flag states the narrower truth: this
            // conversation re-wrote the agent's own base text (`PATCH …/instruction`). A profile
            // member keeps the pre-existing rule, which keys off the override source.
            ...(isCustom
                ? overrides[name] === undefined
                    ? {}
                    : { has_instruction_override: true }
                : source === 'harness' || source === 'session'
                    ? { has_instruction_override: true }
                    : {}),
            ...(brain === undefined ? {} : { guidelines_count: brain.instructions.length }),
            editable: true,
            // The entry agent cannot be detached: every session needs an entry point. R6: neither
            // can a member that still owns a conversation — its history would go with it.
            deletable: name !== definition.primary && !threadUsers.has(name),
            // A custom member always has a stated undo (`null` restores its stored base), and an
            // inherited member has one as soon as its text is not the plain shipped profile.
            restorable: isCustom ? true : source !== 'catalogue',
            ...(isAgentBusy(record, name) ? { busy: true } : {}),
            revision: context.hub.getRevision('session_agents', record.id)
        };
    });
};

/** Whether one member agent currently has a run in flight (a lane active turn names it). */
const isAgentBusy = (record: SessionRecord, agent: string): boolean => {
    for (const lane of record.lanes.values()) {
        const active = (lane as ThreadLaneInfo).active;

        if (active === undefined) continue;

        const thread = record.harness.thread((lane as ThreadLaneInfo).threadId);

        if (thread !== undefined && thread.agent === agent) return true;
    }

    return record.status === 'running' && record.harness.agent.name === agent;
};

/** Which layer supplies the text one member runs: the most specific override that exists. */
const instructionSourceOf = (
    agent: string,
    overrides: Record<string, string>,
    models?: Record<string, string>,
    state?: AgentState,
    liveText?: string
): 'catalogue' | 'global' | 'harness' | 'session' => {
    void models;

    // A per-HARNESS override is the more specific decision (it names this team), so it wins
    // over the deployment-wide layer; the layer is next, and only then the shipped profile.
    if (Object.prototype.hasOwnProperty.call(overrides, agent)) return 'harness';

    if (state === undefined) return 'catalogue';

    // T19: the global agent layer is a REAL source now (`PATCH /agents/:id`), so a roster row
    // says which text this member actually runs. Containment, not existence: a session created
    // BEFORE the operator edit runs the text its agents were seeded with, and calling that
    // "global" would credit a layer this conversation never ran on.
    const globalInstruction = state.overridesOf(agent).instruction;

    if (globalInstruction === undefined) return 'catalogue';

    if (liveText === undefined || liveText.length === 0 || liveText.includes(globalInstruction)) return 'global';

    return 'catalogue';
};

// ---------------------------------------------------------------------------
// Harness definitions and instructions
// ---------------------------------------------------------------------------

/** A definition card: identity, membership, declared tools, and the revision counter. */
export const harnessCardOf = (preset: HarnessPreset, hub: HarnessEventHub, tools: readonly string[]): HarnessCard => ({
    name: preset.name,
    title: preset.title,
    description: preset.description,
    requires_endpoint: preset.requiresEndpoint,
    primary: preset.primary,
    subagents: [...preset.subagents],
    agents: [...preset.agents],
    tools: [...tools],
    builtin: preset.builtin,
    definition_revision: hub.getRevision('definition', preset.name)
});

/**
 * The identified definition read: a card plus the per-agent model overrides, the resolved
 * core-tool set, and the instruction SUMMARY (provenance + length, never the text).
 */
export const harnessDefinitionOf = (
    preset: HarnessPreset,
    hub: HarnessEventHub,
    registeredTools: readonly string[],
    coreTools: readonly string[],
    summary: HarnessInstructionSummaryEntry[]
): HarnessDefinition => ({
    ...harnessCardOf(preset, hub, registeredTools),
    core_tools: [...coreTools],
    ...(Object.keys(preset.agentModels ?? {}).length === 0
        ? {}
        : { agent_models: { ...preset.agentModels } }),
    // R2: the per-agent display colors, emitted under the same non-empty rule as
    // `agent_models`, so an uncolored definition keeps its exact pre-R2 shape. This is
    // the field the UI paints swatches from (`HarnessDescriptor.agentColors` in the
    // internal model, `agent_colors` on the wire); a member it omits is uncolored and
    // the host applies its own derivation.
    ...(Object.keys(preset.agentColors ?? {}).length === 0
        ? {}
        : { agent_colors: { ...preset.agentColors } }),
    instruction_summary: summary
});

/**
 * One row per member with instruction provenance and length, no text.
 *
 * `source` is `harness` when THIS definition overrides the prompt, `global` when the
 * deployment-wide agent layer does (T19: `PATCH /agents/{id}` made that a real layer), and
 * `catalogue` when the trusted profile supplies it. The most specific layer wins, which is also
 * the order `./toolbox.ts` composes the prompt in, so a row cannot name a layer whose text the
 * next session will not actually run.
 */
export const instructionSummaryOf = (
    preset: HarnessPreset,
    profiles: readonly TrustedAgentProfile[],
    state?: AgentState
): HarnessInstructionSummaryEntry[] => {
    const overrides = preset.agentInstructions ?? {};

    return [...preset.agents].map((agent) => {
        const override = overrides[agent];
        const profile = profiles.find((candidate) => candidate.name === agent);
        const chars = typeof override === 'string' ? override.length : (profile?.instruction ?? '').length;
        const harnessOverride = typeof override === 'string';
        const globalOverride = !harnessOverride && state?.overridesOf(agent).instruction !== undefined;

        return {
            agent,
            source: harnessOverride ? 'harness' : globalOverride ? 'global' : 'catalogue',
            overridden: harnessOverride,
            chars
        };
    });
};

/** One member's effective instruction text plus its provenance and guideline rules. */
export const instructionTextOf = (
    preset: HarnessPreset,
    agent: string,
    profiles: readonly TrustedAgentProfile[],
    state?: AgentState
): HarnessInstructionTextResponse | undefined => {
    // A retired profile is absent from the selectable list but is still named by an existing
    // definition, so the shipped catalogue entry is the fallback for the text and guideline
    // rules that definition runs on.
    const profile = profiles.find((candidate) => candidate.name === agent) ?? state?.shipped(agent);
    const override = (preset.agentInstructions ?? {})[agent];

    if (profile === undefined && typeof override !== 'string') return undefined;

    const instruction = typeof override === 'string' ? override : profile?.instruction ?? '';
    const harnessOverride = typeof override === 'string';

    return {
        harness_name: preset.name,
        agent,
        source: harnessOverride
            ? 'harness'
            : state?.overridesOf(agent).instruction !== undefined
                ? 'global'
                : 'catalogue',
        instruction,
        guidelines: [...(profile?.guidelines ?? [])],
        chars: instruction.length
    };
};

// ---------------------------------------------------------------------------
// Catalogue rows (global tools and agents)
// ---------------------------------------------------------------------------

/**
 * A catalogue row. `session_bound` is the entry's own flag (the harness-owned control
 * tools have no standalone implementation), projected snake_case.
 *
 * R3 — `enablement` is the state a Tools pane switches on, and the CALLER decides it
 * because only the caller can see the live deployment:
 *   - `enabled` - the global switch (./tool-settings.ts `isEnabled`, read per row so a row
 *                 reflects a click that happened after this request started).
 * It DEFAULTS to "on" — the state of a deployment with no global store consulted, and what
 * a caller that does not care (a session row, which states its OWN `enabled` after this
 * spread) gets. There is no `protected` field on a catalogue row: the global switch applies
 * to EVERY listed entry, core tools included (R5), so a row has nothing to withhold.
 */
export const toolSummaryOf = (
    entry: CatalogueEntry | undefined,
    name: string,
    liveDescription?: string,
    enablement?: { enabled: boolean }
): ToolSummary => ({
    name,
    group: entry?.group ?? 'Created tools',
    description: liveDescription ?? entry?.description ?? '',
    tags: entry === undefined ? [] : [...entry.tags],
    visibility: entry?.visibility ?? 'searchable',
    ...(entry?.availability === undefined
        ? {}
        : {
              availability: {
                  state: entry.availability.state,
                  ...(entry.availability.environment === undefined
                      ? {}
                      : { environment: [...entry.availability.environment] }),
                  ...(entry.availability.hint === undefined ? {} : { hint: entry.availability.hint })
              }
          }),
    session_bound: entry?.sessionBound === true,
    enabled: enablement?.enabled ?? true
});

/** A catalogue entry plus the schema and the execution gate only the detail read carries. */
export const toolDetailOf = (
    entry: CatalogueEntry | undefined,
    name: string,
    enablement?: { enabled: boolean }
): ToolDetail => ({
    ...toolSummaryOf(entry, name, undefined, enablement),
    ...(entry?.parameters === undefined ? {} : { parameters: { ...entry.parameters } }),
    execution: {
        scope: entry?.sessionBound === true ? 'session_required' : 'global',
        // Only an entry with a real implementation can run standalone.
        manual: entry?.tool !== undefined
    }
});

/**
 * A trusted profile as a list row: identity plus whether anything overrides it.
 *
 * T19: `profile` is the EFFECTIVE profile (the harness registry hands the merged view to
 * every reader), and the two flags come from the global overlay itself — a stated field,
 * not a guess from the text. `has_instruction_override` is the instruction specifically,
 * because that is the field a prompt editor highlights; `has_global_override` is any stated
 * field, because that is what makes a "restore the shipped profile" affordance meaningful.
 */
export const agentSummaryOf = (
    profile: TrustedAgentProfile,
    state?: AgentState
): AgentSummary => {
    const overrides = state?.overridesOf(profile.name) ?? {};

    return {
        name: profile.name,
        title: profile.title,
        description: profile.description,
        has_instruction_override: overrides.instruction !== undefined,
        has_global_override: Object.keys(overrides).length > 0
    };
};

/**
 * The full trusted profile.
 *
 * T19: `instruction_source` says which layer the text the client is looking at came from —
 * `global` when the deployment's override layer states an instruction, `catalogue` when it
 * is the shipped profile's own text. `overridden_fields` names every field the global layer
 * currently replaces, so a UI can offer "restore" per field instead of overwriting the whole
 * profile with one PATCH. Both are stated from the overlay, never inferred from a string
 * comparison against the shipped text (an override that happens to equal the shipped value
 * is dropped by the layer, so an absent field genuinely means "catalogue").
 */
export const agentProfileOf = (
    profile: TrustedAgentProfile,
    hub: HarnessEventHub,
    referencedBy: readonly string[],
    state?: AgentState
): AgentProfile => {
    const overrides = state?.overridesOf(profile.name) ?? {};
    const overridden = (['title', 'description', 'instruction', 'guidelines'] as const).filter(
        (field) => overrides[field] !== undefined
    );

    return {
        name: profile.name,
        title: profile.title,
        description: profile.description,
        instruction: profile.instruction,
        guidelines: [...profile.guidelines],
        instruction_source: overrides.instruction === undefined ? 'catalogue' : 'global',
        ...(overridden.length === 0 ? {} : { overridden_fields: [...overridden] }),
        referenced_by: [...referencedBy],
        revision: hub.getRevision('agents', profile.name)
    };
};

/**
 * The frozen definition copy one session runs, with its source/current bookkeeping.
 *
 * The per-agent override maps it emits are the FROZEN ones, read off `record.definition`
 * (the `HarnessDescriptor` captured at creation): `agent_models` (R9) and `agent_colors`
 * (R2) appear only when the definition actually configured something, which is the same
 * non-empty rule `harnessDefinitionOf` and `describeHarness` follow. That is what lets the
 * saved-session UI paint the swatches this conversation was built with, rather than whatever
 * the live registry entry says after a later recolor.
 */
export const sessionDefinitionOf = (
    record: SessionRecord,
    context: ReadContext,
    source: { current: boolean }
): SessionDefinitionResource => {
    const definition = record.definition;

    // R7: the agents THIS session invented (name → base instruction). They are not catalogue
    // profiles, so the provenance ladder below cannot answer anything about them, and the frozen
    // `HarnessDescriptor` carries no field for them — the session's own preset copy is the only
    // authority. Reading it here is what keeps the summary honest (and keeps it from throwing) for
    // a roster that contains a member no profile defines.
    const customs = record.preset.customAgents ?? {};
    const sessionInstructions = record.preset.agentInstructions ?? {};
    const brains = record.harness.agents as Record<string, { instructions: readonly string[] }>;
    const definesCustomAgent = Object.keys(customs).length > 0;

    return {
        name: definition.name,
        title: definition.title,
        description: definition.description,
        requires_endpoint: definition.requiresEndpoint,
        primary: definition.primary,
        subagents: [...definition.subagents],
        agents: [...definition.agents],
        tools: [...definition.tools],
        builtin: definition.builtin,
        definition_revision: context.hub.getRevision('definition', record.id),
        ...(definition.coreTools === undefined ? {} : { core_tools: [...definition.coreTools] }),
        ...(definition.agentModels === undefined || Object.keys(definition.agentModels).length === 0
            ? {}
            : { agent_models: { ...definition.agentModels } }),
        // R2/R1: the frozen definition's per-agent display COLORS, emitted under the exact
        // non-empty rule `harnessDefinitionOf` above and `describeHarness` use, so a session
        // built from an uncolored definition keeps its pre-R2 wire shape (and a document
        // saved before colors existed restores with no key at all). `record.definition` is the
        // frozen `HarnessDescriptor`, whose `agentColors` map (./harnesses/descriptor.ts
        // `describeHarness`) is copied from the same preset map that colored the agents this
        // session was built with — so the swatch a saved-session UI reads here is byte-identical
        // to the one the live conversation paints. A member the map omits has NO configured
        // color, and the client applies its own derivation for it.
        ...(definition.agentColors === undefined || Object.keys(definition.agentColors).length === 0
            ? {}
            : { agent_colors: { ...definition.agentColors } }),
        ...(definition.agentInstructions === undefined && !definesCustomAgent
            ? {}
            : {
                  // T19: the provenance ladder matches ./toolbox.ts and the roster rows: a
                  // per-harness override first, then the global agent layer, then the shipped
                  // profile. `chars` is the length of the text the NEXT session on this
                  // definition runs, which is why it is taken from the effective profile rather
                  // than the catalogue constant.
                  instruction_summary: [...definition.agents].map((agent) => {
                      // R7: a session-defined member answers from THIS conversation, not from the
                      // ladder: `source: 'session'` states that the text is the agent's own base,
                      // `overridden` reports whether a later `PATCH …/instruction` re-wrote that
                      // base, and `chars` is the length of the text the live brain actually runs
                      // (falling back to the stored base when the roster exposes no brain). A
                      // custom name never resolves in `context.profiles`, so this branch also
                      // removes the `effectiveInstruction === undefined` hole the ladder below has
                      // for it.
                      if (Object.prototype.hasOwnProperty.call(customs, agent)) {
                          const live = brains[agent] === undefined
                              ? undefined
                              : brains[agent]!.instructions.join('\n');

                          return {
                              agent,
                              source: 'session',
                              overridden: Object.prototype.hasOwnProperty.call(sessionInstructions, agent),
                              chars: live === undefined ? (customs[agent] ?? '').length : live.length
                          };
                      }

                      const harnessOverride = Object.prototype.hasOwnProperty.call(
                          definition.agentInstructions ?? {},
                          agent
                      );
                      const globalInstruction = context.agentState?.overridesOf(agent).instruction;
                      const effectiveInstruction = context.profiles.find(
                          (profile) => profile.name === agent
                      )?.instruction;

                      return {
                          agent,
                          source: harnessOverride
                              ? 'harness'
                              : globalInstruction !== undefined
                                  ? 'global'
                                  : 'catalogue',
                          overridden: harnessOverride,
                          chars:
                              (definition.agentInstructions ?? {})[agent]?.length ??
                              (effectiveInstruction ?? '').length
                      };
                  })
              }),
        session_id: record.id,
        revision: context.hub.getRevision('definition', record.id),
        frozen_at: record.createdAt,
        source_revision: context.hub.getRevision('definition', definition.name),
        current_revision: context.hub.getRevision('definition', definition.name),
        current: source.current,
        ...(record.harness.discoveredTools.length === 0
            ? {}
            : { discovered_tools: [...record.harness.discoveredTools] })
    };
};

/** The session-visible failure envelope of a tool call, snake_case per the contract. */
export const toolCallFailure = (message: string, durationMs: number): ToolCallResult => ({
    ok: false,
    error: { message },
    duration_ms: durationMs
});

// ---------------------------------------------------------------------------
// Live stream bodies (T16)
//
// Each of these is the ONE small payload a stream update carries, rebuilt from the live
// record. Nothing here copies a turn, folds a projection, or builds a snapshot: a live update
// costs what it states. The key spelling matches the generated `WsUpdate*` payload field names.
// ---------------------------------------------------------------------------

/** The `session.updated` patch: metadata and counters, never turns/threads/transcripts. */
export const sessionStatePatchOf = (record: SessionRecord, context: ReadContext): SessionStatePatch => {
    const pending = pendingCountOf(record);

    return {
        id: record.id,
        ...(context.titles.get(record.id) === undefined ? {} : { title: context.titles.get(record.id)! }),
        status: record.status,
        ...(pending === 0 ? {} : { queue_depth: pending }),
        model: record.harness.agent.model(),
        agent_models: agentModelsOf(record),
        ...(record.lastError === undefined ? {} : { last_error: record.lastError }),
        revision: context.hub.getRevision('session', record.id)
    };
};

/** One live owner question as `action.opened` ships it (the recorded request plus the routing join). */
export const pendingActionRowOf = (
    record: SessionRecord,
    pending: { requestId: string; request: HarnessActionRequest; threadId?: string; agent: string; openedAt: number }
): PendingAction => {
    const turn =
        pending.threadId === undefined
            ? record.turns.find((entry) => entry.status === 'running')
            : [...record.turns].reverse().find((entry) => entry.threadId === pending.threadId);

    return {
        request: pending.request,
        turn_id: turn?.id ?? '',
        ...(pending.threadId === undefined ? {} : { thread_id: pending.threadId }),
        agent: pending.agent,
        received_at: pending.openedAt
    };
};

/** The server-summed token figures for one turn (`usage.updated`'s body). */
export const usagePatchOf = (
    record: SessionRecord,
    turnId: string,
    context: ReadContext,
    // The turn's display row, when the caller already has it cached (it carries the input
    // figures). Optional by design: reading a row is a cache read, never a fold.
    row?: { latestInput?: number }
): UsagePatch | undefined => {
    const turn = record.turns.find((entry) => entry.id === turnId);

    if (turn === undefined) return undefined;

    const usage = turn.usage;

    return {
        ...(turnId === undefined ? {} : { turn_id: turnId }),
        ...(usage === undefined ? {} : { usage: { ...usage } }),
        // `latest_input` is the figure a display ROW carries (`TurnSummary.latestInput`), so the
        // patch states it only when the caller hands that row in; `cached_input` is the provider's
        // own cache figure, present only when the provider reported one.
        ...(row?.latestInput === undefined ? {} : { latest_input: row.latestInput }),
        ...(usage?.cached === undefined ? {} : { cached_input: usage.cached }),
        revision: context.hub.getRevision('turn', turnKey(record.id, turnId))
    };
};
