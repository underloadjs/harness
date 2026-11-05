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

// The four harness-owned control tools plus `delegate`/`threadSend` are the entries a
// session can never un-register or switch off; `CORE_TOOL_NAMES` is the shipped set.
const isProtectedToolName = (name: string): boolean => CORE_TOOL_NAMES.includes(name);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type ReadContext = {
    hub: HarnessEventHub;
    catalogue: ToolCatalogue;
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
    created_tool_limit: context.createdToolLimit
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
// Session toolbox
// ---------------------------------------------------------------------------

/**
 * Every live registry entry as a session row.
 *
 * The state a catalogue row CANNOT state comes from the running harness:
 *   - `declared`  - the frozen definition registers the name (always in context);
 *   - `enabled`   - the live enabled set (`harness.discoveredTools`);
 *   - `origin`    - `created` when a source revision is installed, `discovered` when the
 *                   enabled set contains a non-declared name, `catalogue` otherwise;
 *   - `protected` - a harness-owned control tool (toolRegistry/toolRequest/toolCreate/
 *                   task/delegate/threadSend), which a session can neither drop nor switch
 *                   off, so the write routes refuse it with 403;
 *   - `source_*`  - the installed source revision, which is what makes the source route
 *                   worth calling.
 */
export const sessionToolRowsOf = (record: SessionRecord, context: ReadContext): SessionToolSummary[] => {
    const declared = new Set<string>(record.definition.tools);
    const enabled = new Set<string>(record.harness.discoveredTools ?? []);
    const sources = new Map(record.harness.toolSources().map((source) => [source.name, source]));
    // One rule decides `origin` and the budget, so a row and the page's budget can never
    // disagree about which revisions belong to this session.
    const created = new Set(createdToolNames(record));
    const live = liveToolNames(record);

    return live.map((name) => {
        const entry = context.catalogue.find(name);
        const source = sources.get(name);
        const isDeclared = declared.has(name);
        const isEnabled = enabled.has(name);

        return {
            ...toolSummaryOf(entry, name, liveToolDescription(record, name)),
            session_id: record.id,
            declared: isDeclared,
            enabled: isEnabled,
            // `created` is what this session registered; `discovered` is a catalogue tool the
            // run enabled through `toolRequest`; `catalogue` is everything else.
            origin: created.has(name) ? 'created' : !isDeclared && isEnabled ? 'discovered' : 'catalogue',
            protected: isProtectedToolName(name) || isDeclared,
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

    // A name the live registry does not hold cannot be addressed by this route (the caller
    // answers 404 first), so the row below is a type-complete fallback, not a claim: every
    // session-scoped fact it states is "no", and the execution gate is still the truth for
    // the name.
    if (row === undefined) {
        return {
            ...toolSummaryOf(context.catalogue.find(name), name),
            session_id: record.id,
            declared: false,
            enabled: false,
            origin: 'catalogue',
            protected: false,
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
    scope: isProtectedToolName(name) ? 'session_required' : 'session_only',
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
 */
export const sessionAgentRowsOf = (record: SessionRecord, context: ReadContext): SessionAgentBinding[] => {
    const definition = record.definition;
    const members = [...definition.agents];
    const brains = record.harness.agents as Record<string, { model: () => string; instructions: readonly string[] }>;
    const overrides = record.preset.agentInstructions ?? {};

    return members.map((name) => {
        const brain = brains[name];
        const inherited = definition.agentModels?.[name];
        const instructionText = (brain?.instructions ?? []).join('\n');
        const source = instructionSourceOf(name, overrides, record.preset.agentModels, context.agentState, instructionText);

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
            ...(source === 'harness' || source === 'session' ? { has_instruction_override: true } : {}),
            ...(brain === undefined ? {} : { guidelines_count: brain.instructions.length }),
            editable: true,
            // The entry agent cannot be detached: every session needs an entry point.
            deletable: name !== definition.primary,
            restorable: source !== 'catalogue',
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
 */
export const toolSummaryOf = (
    entry: CatalogueEntry | undefined,
    name: string,
    liveDescription?: string
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
    session_bound: entry?.sessionBound === true
});

/** A catalogue entry plus the schema and the execution gate only the detail read carries. */
export const toolDetailOf = (entry: CatalogueEntry | undefined, name: string): ToolDetail => ({
    ...toolSummaryOf(entry, name),
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

/** The frozen definition copy one session runs, with its source/current bookkeeping. */
export const sessionDefinitionOf = (
    record: SessionRecord,
    context: ReadContext,
    source: { current: boolean }
): SessionDefinitionResource => {
    const definition = record.definition;

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
        ...(definition.agentInstructions === undefined
            ? {}
            : {
                  // T19: the provenance ladder matches ./toolbox.ts and the roster rows: a
                  // per-harness override first, then the global agent layer, then the shipped
                  // profile. `chars` is the length of the text the NEXT session on this
                  // definition runs, which is why it is taken from the effective profile rather
                  // than the catalogue constant.
                  instruction_summary: [...definition.agents].map((agent) => {
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
