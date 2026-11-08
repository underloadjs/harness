// Shared types for @underload/harness.
//
// The split this file encodes:
//   - Agent  = the brain. Owns the model, the instruction, the message history,
//              and the transport call. Comparable to a `simpleClient` from
//              @agentic/harness. Usable on its own: `agent.stream()` is one turn,
//              and a caller who does not want a harness writes the loop by hand.
//   - Tool   = an action the model can request. It has no policy and no state;
//              the harness decides when to execute it and what to feed back.
//   - Harness = the execution loop. Owns the agents, the tool registry, and the
//              progress reporter. Calling it runs turns until the model stops
//              asking for tools.
//
// Cross-references:
//   - core/agent.ts  — the factory that produces Agent
//   - core/tool.ts   — the factory that produces Tool
//   - harness.ts     — the callable that produces Harness
//   - transport.ts   — the default OpenAI-compatible HarnessStream

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type HarnessRole = 'system' | 'user' | 'assistant' | 'tool';

// One composer attachment carried with a user message (T3 clip/attach feature).
//
// `data` is RAW canonical base64 of the file bytes — never a `data:` URL, a
// filesystem path, or an HTTP URL. `size` is the DECODED byte length and must
// agree with `data`. `marker` is the exact text label the composer inserted into
// the prompt (e.g. "[Image 1]"); the transport uses it to place the media part at
// the position the user referenced. Validation and limits live in
// shared/attachments.ts (validateAttachments); this type is the single shape
// owner for server, frontend, snapshot, and transport.
export type HarnessAttachment = {
    // Stable, opaque, unique within one turn (used by the client to update a
    // preview in place and by snapshots to round-trip).
    id: string;
    // What the attachment IS. `file` is representable in the transcript, and how
    // the transport treats it depends on the profile the list came from: an
    // UPLOAD `file` is refused with an explicit unsupported error (a browser may
    // not push an arbitrary binary into a request body), while a tool-media
    // `file` attached by `download` travels as the OpenAI-compatible file part
    // (`{ type: 'file', file: { filename, file_data } }`) — whether the provider
    // accepts that part is the provider's decision, answered with an explicit
    // error rather than a silent drop.
    kind: 'image' | 'video' | 'audio' | 'pdf' | 'file';
    // The text marker as it appears in the user prompt: "[Image 1]".
    marker: string;
    // Plain file name only (used as the provider's file filename). No paths/URLs.
    name: string;
    // Lowercase MIME type without parameters, e.g. "image/png" or "application/pdf".
    mime: string;
    // Decoded byte length of `data`.
    size: number;
    // Raw canonical base64 bytes (no prefix, no whitespace).
    data: string;
};

// The byte/count profile one attachment list is validated against.
//
// TWO profiles exist because the two sources of bytes have different trust and
// different transport paths, and they must not be conflated:
//
//   UPLOAD   — a browser composer / HTTP submit. Public input: bounded hard,
//              because the base64 arrives inside a JSON request body that the
//              server has to buffer (`MAX_SUBMIT_BODY_BYTES`).
//   DOWNLOAD — bytes this process fetched itself through the `download` tool.
//              Trusted-side, streamed and capped at the source, and it never
//              enters a submit body, so a single file may be five times larger.
//
// `shared/attachments.ts` owns the numbers and enforces them in one place; this
// is the shape owner so the validator, the harness, the snapshot reader, the
// branch materializer and the transport all quote the SAME profile type.
export type HarnessAttachmentLimits = {
    // Decoded byte ceiling for ONE attachment.
    perAttachmentBytes: number;
    // Decoded byte ceiling for one whole attachment list (one turn, or the one
    // synthetic user message the transport builds from a tool block).
    totalBytes: number;
    // How many entries one list may hold.
    count: number;
};

// The model-facing projection of tool media carried on a `tool` message. The
// bytes stay on the transcript (and in the snapshot), but NOT on a progress
// event: `sessions.copyEvent` JSON round-trips every event twice and turn
// records are persisted, so a 20 MiB download would become ~100 MB of
// serialized JSON per delivered call. A client renders this descriptor and
// reaches the bytes through the transcript when it needs them.
export type ToolMediaDescriptor = {
    id: string;
    kind: HarnessAttachment['kind'];
    name: string;
    mime: string;
    // Decoded byte length, always < the download profile's per-attachment cap.
    size: number;
};

// A tool invocation requested by the model. `arguments` stays a raw JSON string
// because that is what the wire protocol delivers, and because malformed JSON is
// the harness's problem to report back to the model rather than a parse crash.
//
// `id` must be unique across the whole CONVERSATION, not just the turn: the harness
// keys scheduled work and paired tool results by it. A turn that repeats an id, or
// reuses one already committed, is rejected before any call executes (the run rolls
// back) rather than letting one result silently alias another.
export type HarnessToolCall = {
    id: string;
    name: string;
    arguments: string;
};

// One transcript entry, in the shape the harness manipulates internally. The
// transport maps these onto the provider's wire format (see transport.ts).
//
// CONTEXT INCLUSION — the shared `included?: boolean` every variant carries.
// ---------------------------------------------------------------------------
// It is a PERSISTED, default-true flag that decides whether an entry reaches the
// MODEL, never whether it stays in the transcript. Context control therefore
// never deletes a turn: an entry can be disabled, edited or re-enabled, and the
// change is reversible because canonical history (`agent.messages`) is untouched
// — src/harness.ts `projectTranscript` filters a shallow copy, request-only.
//
// Rules that keep every pre-existing transcript, snapshot, branch record and
// provider request byte-identical:
//   - ABSENT means included; only the literal `false` excludes. Re-enabling an
//     entry DELETES the key, so `included: true` is never written anywhere.
//   - the transport field-selects per role (src/transport/openai.ts `wireMessage`),
//     so the flag can never reach a provider payload;
//   - snapshot restore (src/core/snapshot.ts `readHarnessMessages`) and branch
//     materialization (src/core/branch.ts `copyMessage`) whitelist keys per role,
//     so both list `included` explicitly or a flagged transcript fails to load.
//
// The exclusion UNIT is the whole tool-call block: an assistant message with
// non-empty `toolCalls` plus every `tool` message matching one of those call ids.
// If ANY member says `false` the ENTIRE unit is withheld — dropping a single
// result would leave a `tool_calls[]` entry with no answer (or an orphan result),
// which the strict pairing contract of an OpenAI-compatible transport rejects.
//
// HOST HYGIENE (context T6.1/T6.3) — the rule a host that stores its OWN copy of a
// transcript has to keep: because only `false` is storage, a persisted copy should
// OMIT the key rather than write `included: true`. The runtime does not reject a
// submitted `true`; every entry point that accepts whole messages (the agent seed,
// the transcript write/append, `restore`, a fork) silently normalizes it to the
// absent form, because rejecting would break a host that round-trips its own JSON.
// The one path that cannot be normalized is a DIRECT edit of the public mutable
// `agent.messages` (src/types/index.ts `HarnessStateChangeEvent` disclaims it: the
// observer cannot see it) — such a `true` is invisible to the model and to snapshots
// but stays visible to every read surface until the next copy, so never write it.
//
// STABLE ADDRESSING — the shared optional `messageId?: string` (context T1). A
// canonical entry the runtime created carries an id that names THIS turn, so a plugin
// can address it in a later round of the same conversation, after a restart, and
// across a `replaceHistory()` (which invalidates indices and message identities but
// re-reads the same ids). Rules that keep it an identity:
//   - minted EXACTLY ONCE, where a canonical message is created (core/agent.ts seed
//     and appends, src/harness.ts `insertToolMessage`), by core/message-id.ts;
//   - COPIED, never re-minted, by every copy path: a fork/branch carries its source's
//     ids (T1.4 — two objects, one identity, and lookup is scoped to one agent's
//     transcript), and a snapshot carries them back verbatim;
//   - a pre-id transcript (an older `state.json`, a host-pushed message) restores with
//     the key ABSENT on read and gets ids BACKFILLED by the snapshot reader
//     (core/snapshot.ts) — `restore -> snapshot` is idempotent;
//   - it NEVER reaches a provider request: `withIncluded` (core/agent.ts) strips it
//     from every projection copy, exactly as it strips the flag, so the request path
//     stays byte-identical and the transport's field selection is untouched.
//   - it IS visible to the host read surfaces — `threadMessages()`, the transcript
//     routes, `snapshot()` — because those report canonical state, and that is exactly
//     how an id survives a restart. A host that stores its own copy of a transcript
//     should carry the key back; dropping it only means the reader mints new ones.
export type HarnessMessage =
    | { role: 'system'; content: string; included?: boolean; messageId?: string }
    | {
          role: 'user';
          content: string;
          // Composer attachments referenced by `marker` inside `content`. Optional
          // and omitted for a text-only user message, so every pre-attachment
          // transcript (and snapshot) keeps its exact old shape.
          //
          // Validated and deep-copied before any append (core/agent.ts,
          // harness.ts, core/snapshot.ts) and mapped to provider parts by the
          // transport (transport/openai.ts).
          attachments?: HarnessAttachment[];
          // Withholds this entry from the model request (see the block comment on
          // the union). Absent means included; `false` is the only excluding value.
          included?: boolean;
          // Stable transcript address for THIS turn (see the block comment on the
          // union). Minted once by the runtime, copied by every copy path, and
          // stripped from every projection copy, so it is never a provider field.
          messageId?: string;
      }
    | {
          role: 'assistant';
          content: string;
          // Present only when the turn requested tools.
          toolCalls?: HarnessToolCall[];
          // Kept out of the wire payload; retained so a UI can replay a turn.
          reasoning?: string;
          // Withholds this entry from the model request (see the block comment on
          // the union). For a tool-call turn the flag covers the WHOLE unit: this
          // message, every matching result, and its pending placeholders.
          included?: boolean;
          // Stable transcript address for THIS turn (see the block comment on the
          // union), and therefore for the whole tool-call UNIT it opens: an id on the
          // assistant entry addresses its results too, through `setIncluded`'s unit
          // cascade.
          messageId?: string;
      }
    | {
          role: 'tool';
          content: string;
          toolCallId: string;
          name: string;
          // Media a tool produced OUT OF BAND (the `download` preset, via
          // `toolMedia()`). It is deliberately NOT part of `content`: the
          // model-facing 64 KiB result budget (core/result-budget.ts) bounds
          // serialized TEXT only, so a 20 MiB image can never be truncated or
          // reduced to a filename by it.
          //
          // A tool message stays a valid plain-text tool response on the wire.
          // The transport flushes these attachments as a clearly labelled
          // USER-role multimodal message AFTER the complete contiguous tool
          // block, which is what keeps strict tool-call pairing intact
          // (transport/openai.ts).
          //
          // The key is OMITTED when there is no media, so every medialess tool
          // result (and every pre-media transcript, snapshot, branch record and
          // test fixture) keeps its exact previous shape. Validated with the
          // DOWNLOAD profile at delivery (core/tool-media.ts), on restore
          // (core/snapshot.ts) and on fork (core/branch.ts).
          attachments?: HarnessAttachment[];
          // WHY this call ended — the SAME classification the progress event and the
          // `tool.after` hook carry (`HarnessToolOutcome` below), now persisted on the
          // transcript entry so it survives a restart, a snapshot, a fork and a
          // `threadRead`. Before it, the committed entry carried only the result TEXT, so
          // any rule of the form "this call failed" was forced to string-match English
          // prose the harness wrote — exactly what this union's own header forbids.
          //
          // Storage rule, the minimal-delta one `included` and `attachments` follow:
          // **only a NON-`completed` outcome is stored.** A completed result carries no key
          // at all, so every pre-outcome transcript, snapshot, branch record and test
          // fixture keeps its exact previous shape, and ABSENT reads as `completed`
          // (core/tool-outcome.ts `toolOutcomeOf` is the one place that says so). There is
          // deliberately NO migration bridge that re-derives an outcome from the failure
          // text: a pre-outcome transcript simply reads as `completed`, which is why a
          // prune policy must additionally require a SUPERSEDING later success and must
          // never touch a unit with no committed result
          // (docs/tasks/2026-11-09-progressive-compaction.md T0 Q3).
          //
          // It is also why `isError` stays DERIVED rather than stored beside it
          // (core/tool-outcome.ts `toolResultIsError`): the two can only disagree if a
          // writer keeps both.
          //
          // NOT model-facing: the transport field-selects the tool wire shape
          // (`role`/`tool_call_id`/`content`, transport/openai.ts), so a provider payload
          // is byte-identical with or without this key. A branch's request-only PENDING
          // PLACEHOLDER carries no outcome either — it is not a committed result, and the
          // placeholder text is structural, not a classification.
          outcome?: HarnessToolOutcome;
          // Withholds this RESULT from the model request. It is a UNIT member, not
          // a standalone choice: `false` on any result drops the assistant message
          // that asked for it, that result, and every other result of the same
          // call block (see the block comment on the union).
          included?: boolean;
          // Stable transcript address for THIS result (see the block comment on the
          // union). It is minted at insertion (src/harness.ts `insertToolMessage`), so
          // a result committed in one round is still addressable in the next.
          messageId?: string;
      };

// A finished assistant turn. This is the value the harness resolves to and the
// payload of the `done` event, so it carries everything a CLI wants to print.
export type HarnessAssistantMessage = {
    role: 'assistant';
    content: string;
    // Accumulated reasoning/thinking text. Always present; empty for
    // non-reasoning models.
    reasoning: string;
    // Tools the model asked for in this turn. Empty when it answered directly.
    toolCalls: HarnessToolCall[];
    // The model that produced this turn, captured at request time.
    model: string;
    stopReason: HarnessStopReason;
    // Undefined when the provider did not report usage for this request.
    usage?: HarnessUsage;
};

// Why generation ended. `tool_calls` means the model wants tools run and the
// turn is not finished; the other two are terminal.
export type HarnessStopReason = 'stop' | 'length' | 'tool_calls';

// One background tool call that is still running when a model request is made or
// a run pauses. This is the PUBLIC, wire-safe view of in-flight work: ids plus a
// monotonic elapsed time, never a promise, controller, or tool implementation.
//
// `elapsedMs` is measured from the moment the call was LAUNCHED (not from the
// model request), so a client can render "running for 12s" without keeping a
// clock of its own. The harness supplies it on `tool_result.pending`,
// `done.pending`, and the `wakeup` event.
export type HarnessPendingTool = {
    callId: string;
    name: string;
    elapsedMs: number;
};

// WHY a tool call ended. This is the structured replacement for reading the
// result text: a consumer must never decide "cancelled" vs "failed" vs "this tool
// does not exist" by matching strings.
//
//   completed — the tool ran and returned a value (success).
//   failed    — the tool ran and threw. An OPERATIONAL failure: the arguments were
//               acceptable and the implementation itself could not finish.
//   rejected  — the call never reached an implementation. An INVOCATION/DISPATCH
//               error the caller can fix: unregistered or not-yet-enabled name,
//               malformed/ schema-invalid arguments, wrong agent role.
//   cancelled — an EXPECTED CONTROL OUTCOME: `toolCancel` released the call before
//               it produced a value. Nothing failed; the caller asked for this.
//
// `completed` and `cancelled` are both healthy control outcomes; only `failed`
// says the tool broke, and only `rejected` says the call itself was wrong. The
// `tool_result` event's `isError` is always derived from this value
// (`isErrorOutcome` in core/tool-outcome.ts), so the two can never disagree.
//
// It is ALSO persisted (compaction T1): the committed `tool` transcript entry carries
// this value as its optional `outcome` key, so the classification survives a restart, a
// snapshot, a fork and a `threadRead` rather than existing only on the live event. Only a
// NON-`completed` outcome is stored — absent means `completed` — and the three rules
// (write/read/derive) live in core/tool-outcome.ts. See the field's own comment on the
// `tool` message variant above for the storage and migration contract.
export type HarnessToolOutcome = 'completed' | 'failed' | 'rejected' | 'cancelled';

// Token accounting, normalized from the provider's `usage` block.
export type HarnessUsage = {
    // Prompt/input tokens for the request, INCLUDING any replayed cache prefix.
    // That is the OpenAI-compatible `prompt_tokens` semantics: a request that
    // replays A+B and adds C reports A+B+C here.
    input: number;
    output: number;
    total: number;
    // How much of `input` the provider served from its prefix cache, when it says
    // so at all. OPTIONAL and never defaulted: "not reported" and "reported, 0
    // cached" are different facts, and a client that prints `(0)` for a provider
    // which never reports a cache figure would be inventing one. Readers must
    // treat undefined as unknown, not as zero.
    cached?: number;
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

// Model-request retry policy (R1). The agent is the SINGLE retry owner: one
// `stream()`/`turn()` may therefore call the transport more than once, and every
// retry re-sends ONLY this request (never a tool, never a whole run).
//
// Defaults (documented in README/knowledge): one initial attempt plus TEN retries
// with doubling waits of `1000 * 2 ** n` ms for n = 0..9 (1s, 2s, 4s ... 512s).
// A successful attempt ends the sequence immediately; when the last retry also
// fails, the original error of that final attempt is what the caller sees.
//
// `false` disables retries (one attempt, first failure wins). A host that wants
// a shorter/longer sequence supplies `maxRetries` / `baseDelayMs`. Values are
// validated at construction, like every other numeric bound.
export type HarnessRetryConfiguration =
    | false
    | {
          // Retries AFTER the initial attempt. 0 = one attempt, no retry.
          maxRetries?: number;
          // Wait before retry n (1-based) is `baseDelayMs * 2 ** (n - 1)`.
          baseDelayMs?: number;
      };

// One request sent to a model. The transcript is passed by value: transports
// never mutate agent history.
export type HarnessStreamRequest = {
    model: string;
    messages: HarnessMessage[];
    // Tool declarations for this request. Empty or absent when no tools are in
    // scope. Definitions, not implementations: a transport never executes.
    tools?: HarnessStreamTool[];
    // Forwarded to fetch/the SDK so a caller can cancel a running turn.
    signal?: AbortSignal;
};

// The tool declaration shape a transport needs. Deliberately narrower than
// `Tool`: a transport must not be able to call `execute`.
export type HarnessStreamTool = {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
};

// Low-level events yielded by a transport. Tool calls arrive on the terminal
// frame rather than as deltas: the harness only acts once the model has stopped
// generating, and partial arguments are not executable.
export type HarnessStreamEvent =
    | { type: 'text'; delta: string }
    | { type: 'reasoning'; delta: string }
    | {
          type: 'done';
          stopReason: HarnessStopReason;
          toolCalls: HarnessToolCall[];
          usage?: HarnessUsage;
      }
    | { type: 'error'; message: string };

// A transport is an async iterable of those events. Supplying one is how a
// caller swaps the wire protocol; the default is `openAICompatible()`.
export type HarnessStream = (request: HarnessStreamRequest) => AsyncIterable<HarnessStreamEvent>;

// Sampling knobs forwarded verbatim. Providers in this workspace are
// OpenAI-compatible, so these are the OpenAI field names.
export type HarnessSampling = {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
};

// Endpoint configuration for the built-in transport. Ignored when an explicit
// `stream` is supplied to the agent.
export type HarnessProviderConfiguration = {
    // Base URL without the /chat/completions suffix, e.g.
    // 'http://localhost:5500/providers/private/v1'.
    baseURL: string;
    // A static key, or a getter so rotating credentials stay live per request.
    apiKey?: string | (() => string);
    // Extra headers merged over the generated ones.
    headers?: Record<string, string>;
    // Sampling fields attached to every request built by this transport.
    sampling?: HarnessSampling;
};

// ---------------------------------------------------------------------------
// Agent (the brain)
// ---------------------------------------------------------------------------

// Everything needed to construct a brain. `name` is optional: inside a harness
// the registry key names the agent (see harness.ts), so `writer: agent({...})`
// is enough. Standalone agents keep the default label.
export type AgentConfiguration = {
    name?: string;
    // Model identifier, e.g. 'merge/ds4-flash'.
    model: string;
    // System instruction(s). A string or a list; each entry becomes its own
    // system message, in order, so persona + rules + format can compose.
    instruction?: string | string[];
    // Seed history. Instructions are prepended ahead of these.
    messages?: HarnessMessage[];
    // Endpoint config for the built-in transport.
    provider?: HarnessProviderConfiguration;
    // Explicit transport. Takes precedence over `provider`.
    stream?: HarnessStream;
    // Model-request retry policy (R1). Omit for the default: one initial attempt
    // plus ten retries with 1s..512s doubling waits. `false` = one attempt only.
    // Retries re-send ONLY the current model request; tools and the run are never
    // replayed.
    retry?: HarnessRetryConfiguration;
    // Display-only identity color (R2): a CSS hex color `#rgb`, `#rgba`,
    // `#rrggbb` or `#rrggbbaa`, case-insensitive. It NEVER reaches a model request
    // or a transcript — a host (the harness UI) paints a stable swatch from it
    // instead of deriving one from the agent's name. Surrounding whitespace is
    // trimmed; anything that is not a hex color is a construction error
    // (core/agent.ts `requireAgentColor`), so a typo fails at setup rather than
    // rendering an unstyled agent. A fork and a persistent thread inherit it: both
    // are the SAME identity, so they must keep the same swatch.
    color?: string;
};

// Overload-style accessor so `agent.model()` reads and `agent.model('x')`
// writes, mirroring simpleClient's model().
export type AgentModelAccessor = {
    (): string;
    (value: string): Agent;
};

export type AgentStreamOptions = {
    signal?: AbortSignal;
    // Attachments for the user message that stream(input, options) appends.
    // `turn()` ignores them: it never appends a user message. Validated before
    // the append (core/agent.ts), so malformed bytes never mutate history.
    //
    // The harness validates the root run's attachments once in harness.ts and
    // passes them through here; nested subagent runs never inherit them.
    attachments?: HarnessAttachment[];
    // Tool declarations forwarded with the request. Standalone callers pass these
    // and write the execution loop themselves; the harness supplies its whole
    // registry automatically.
    tools?: HarnessStreamTool[];
    // Provider-safe transcript projection (background tools). When present, this
    // REPLACES the agent's committed messages for THIS request only; the assistant
    // message still commits to the agent's canonical history. The harness uses it
    // to answer tool calls that are still running with placeholder results without
    // making those placeholders part of the transcript (and therefore without
    // persisting them or pairing them with a later real result).
    //
    // Standalone callers never need this: omit it and the request uses history.
    transcript?: HarnessMessage[];
    // Harness-internal commit guard. Invoked immediately before this turn's
    // assistant message is appended to the canonical history; throwing aborts the
    // turn with NO commit. The harness uses it to make cancellation preemptive: a
    // transport that ignores its abort signal may finish later, but a run that no
    // longer owns the actor (aborted/released) must not mutate the transcript a
    // later run is using.
    //
    // Standalone callers omit it; `agent.turn`/`agent.stream` keep their historical
    // behaviour.
    precommit?: () => void;
};

// Events yielded by Agent.stream / Agent.turn. `error` is yielded by stream()
// (which keeps history clean and lets a caller keep going); turn() throws
// instead, because the harness owns recovery there.
//
// `retry` (R1/R4) is emitted BETWEEN attempts of the same model request: the
// attempt that just failed is abandoned, and the request is re-sent after
// `delayMs`. Everything streamed since the previous `retry`/`done` boundary
// belongs to the FAILED attempt and must be discarded by a consumer that wants
// the final answer only (the harness/UI do exactly that); the committed history
// never contains it, because the agent only commits a successful attempt.
//
// The SUCCESS end of a request is the generator's RETURN value
// (`AgentRequestCommit`), never an event: the agent's event stream is unchanged,
// and the harness — the only layer that knows whether its own `done` will follow —
// decides whether that boundary becomes a visible `attempt_commit` event.
export type AgentStreamEvent =
    | { type: 'text'; delta: string }
    | { type: 'reasoning'; delta: string }
    | {
          type: 'retry';
          // The attempt that just failed (1-based).
          attempt: number;
          // Total attempts allowed (initial + retries). Attempt `maxAttempts`
          // failing is terminal: no further retry follows.
          maxAttempts: number;
          // Backoff before the next attempt, in milliseconds.
          delayMs: number;
          // The failed attempt's error, preserved verbatim.
          error: HarnessErrorInfo;
      }
    | { type: 'done'; message: HarnessAssistantMessage }
    | { type: 'error'; error: HarnessErrorInfo };

// The success boundary of one model request (R3). Yielded as the RETURN value of
// `Agent.turn`/`Agent.stream`, after the answer has been appended to history:
// everything streamed before it is committed and must never be discarded by a
// retry of a LATER request. `done` alone cannot carry that meaning because the
// harness emits `done` only for a tool-free response, so a completed tool round
// would otherwise have no marker at all.
export type AgentRequestCommit = {
    // The attempt that SUCCEEDED (1-based): the request's last one.
    attempt: number;
    // Total attempts the request was allowed.
    maxAttempts: number;
};

// Serialisable error shape. Events cross CLI/RPC boundaries, so failures travel
// as data rather than as Error instances.
export type HarnessErrorInfo = {
    message: string;
};

// The brain. Owns history; performs one request per turn().
export type Agent = {
    // Label for logging and reporting. A harness overwrites this with the
    // registry key when the agent is registered, so it always matches the name
    // used in `agents`.
    name: string;
    // Live transcript. Mutated by system()/user()/assistant()/stream()/turn().
    readonly messages: HarnessMessage[];
    // The system messages this agent was seeded with, for reset().
    readonly instructions: readonly string[];
    // Display-only identity color (R2), copied from `AgentConfiguration.color` and
    // present exactly when one was configured (never `undefined` on the object, so
    // `'color' in agent` is a reliable "explicitly configured" test for a host).
    // Read-only like `messages`/`instructions`: it belongs to the identity chosen at
    // setup, and a fork/thread clone carries the same value. Nothing in the runtime
    // or the transport reads it.
    //
    // Cross-reference: the server configures it per member through
    // `HarnessPreset.agentColors` (src/server/harnesses/types.ts), validates it in
    // registry.ts `normalizeAgentColors`, reports it on
    // `HarnessDescriptor.agentColors` / the contract's `agent_colors`
    // (src/server/protocol.ts, src/shared/harness-api.ts), and hands it here in
    // ./server/harnesses/toolbox.ts `agentConfigurationFromProfile`.
    readonly color?: string;
    // Read or write the active model.
    model: AgentModelAccessor;
    // Append a message and return the agent for chaining.
    system: (content: string) => Agent;
    // Append a user message. The optional attachments are validated and copied
    // before the append; omit them for the historical text-only call.
    user: (content: string, attachments?: HarnessAttachment[]) => Agent;
    assistant: (content: string, toolCalls?: HarnessToolCall[]) => Agent;
    // Append the input, then run one turn. Commits the turn atomically: on
    // failure history is truncated back to where it was.
    stream: (input: string, options?: AgentStreamOptions) => AsyncIterable<AgentStreamEvent>;
    // Run one turn against the current history, without appending a user
    // message. This is the primitive the harness loop re-requests with after a
    // tool result. Throws on failure. Its generator RETURNS an
    // `AgentRequestCommit` naming the attempt that succeeded (see that type), which
    // is the request's success boundary for a caller that needs one.
    turn: (options?: AgentStreamOptions) => AsyncGenerator<AgentStreamEvent, AgentRequestCommit | undefined>;
    // N3: create a PRIVATE branch that owns a detached copy of this agent's
    // entire committed history, model value, instructions and reset baseline.
    // It shares the transport (and therefore provider credentials / external
    // tool side effects), never a sandbox. Tool-call ids are remapped
    // deterministically and pending calls are paired with explicit non-success
    // placeholders; this agent's own transcript is never touched. `label` is
    // display metadata only. Branch identity/depth is available through the
    // internal `agentBranchOf` accessor (core/index), not on this public type.
    fork: (options?: { label?: string }) => Agent;
    // Restore history to the seeded instructions and reset the model. For a
    // fork this restores the branch's DETACHED baseline (its cloned history at
    // fork time), never the live source history.
    reset: () => void;
};

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

// Whether the model can see a tool before it searches for one.
//
// A large catalogue cannot be declared on every request — thousands of tools
// would flood the context window before the first prompt. So a request declares:
//   - every 'core' tool (keep that list tiny), and
//   - every 'searchable' tool that toolRequest has already enabled.
export type ToolVisibility = 'core' | 'searchable';

// One entry in a toolRequest result: enough for the model to decide whether to call
// it, without shipping the whole schema again.
export type ToolMatch = {
    name: string;
    description: string;
    tags: string[];
};

// The result of a LEGACY toolRequest-style search call, and the return value of the
// pure `searchTools()` helper. Shaped as data because it travels back to the model
// as a tool result.
//
// LEGACY ONLY (R7 cap, not the live toolRequest contract): this shape belongs to
// `searchTools()` and to hosts that still page tag-only discovery. The live
// `toolRequest` tool uses the uncapped `selectTools()` union and returns
// `{ enabled, tools, matched, omitted, ... }`; the harness's `maxEnabledTools`
// (default 32, core tools excluded) is what bounds it, not this cap.
//
// DISCOVERY CAP (R7): at most MAX_DISCOVERY_MATCHES (5) matches are returned and
// enabled per `searchTools` page. The cap is deliberately tight: five schemas is a
// focused shortlist a host can weigh, and it keeps one broad tag from re-flooding
// the context. Anything beyond that is reported as a COUNT only — `remaining` — so
// a caller refines its tags (or pages with `offset`) instead of receiving a list of
// names it cannot see.
export type ToolSearchResult = {
    // Tools the model can call from the next turn onward, best match first. At
    // most 5 entries on a legacy `searchTools` page (see MAX_DISCOVERY_MATCHES in
    // core/discovery.ts); a caller may pass a smaller `limit` but can never raise
    // the cap. The live toolRequest path is uncapped and bounded by
    // `maxEnabledTools` instead, so this field there holds the admitted subset.
    enabled: string[];
    // Metadata for the enabled tools, in the same order.
    tools: ToolMatch[];
    // How many additional tools matched the query but were excluded by the cap.
    // Always present (0 when every match fits). No names are exposed for the
    // excluded tail: tag refinement, not pagination, is the way to reach them.
    remaining: number;
    // Query tags that matched no tag, name, or description in the SEARCHABLE
    // catalogue and no tag or name among the core tools the caller already has
    // declared (see ToolSearchOptions.declared). A tag that only names an
    // already-available core tool is therefore NOT reported as unmatched, so the
    // model is never told a capability it can already call is absent.
    unmatchedTags?: string[];
    // Every tag in the searchable catalogue. Present only when nothing matched,
    // so the model can retry with real vocabulary instead of guessing.
    availableTags?: string[];
    // Where this page starts in the ranked match list. Present only for a LATER
    // page (progressive discovery, R12): repeating an identical query advances by
    // one capped page, and this field reports the position so the model can tell
    // a fresh shortlist from a continued one. Absent on the first page, so an
    // existing first-page result keeps its exact shape.
    offset?: number;
    // Retained for compatibility: true exactly when `remaining > 0`.
    truncated?: boolean;
    // Core tools the CALLER already has declared and that match the query — they
    // can be called directly right now. Reported, never enabled: they are already
    // in every request's declarations, so putting them in `enabled`/`tools` would
    // spend the discovery budget (MAX_DISCOVERY_MATCHES on the legacy page, the
    // harness's `maxEnabledTools` for toolRequest) and imply a new grant.
    //
    // Present only when at least one core tool matches, so an ordinary result keeps
    // its old exact shape. The harness supplies only the core tools VISIBLE to the
    // calling agent (delegate is excluded for subagents, toolCreate under the
    // 'primary' policy too), which is what keeps this list honest rather than a
    // registry dump.
    alreadyAvailable?: ToolMatch[];
};

// Optional context for `searchTools()`. Purely additive: a caller that omits it
// gets the pre-existing searchable-only ranking, byte for byte.
export type ToolSearchOptions = {
    // Core tools the caller considers already declared. Discovery never ranks them
    // as enable candidates; it scores their wire NAME and TAGS (never their
    // description, which mentions everyday words and would match almost anything)
    // and reports the hits as `alreadyAvailable`.
    declared?: readonly Tool[];
};

// A request to create a tool at runtime, either from the model-facing toolCreate
// tool or from the host through `harness.toolCreate()`.
//
// `source` is the BODY of an async function, compiled once at registration and
// executed only when the model (or host) calls the tool — registering a tool
// never runs its source. The body is handed `args` (the parameter value, following
// the same single-property rule as every other tool) and `context` (the
// ToolContext, including agent/agents/run inside a harness).
//
// SECURITY: compilation uses the host realm's Function constructor. A created tool
// has exactly the permissions of the process — the same trust model as `shell`
// in src/tools. There is NO sandbox and NO isolation; the only guarantees are
// bounded input validation, a bounded number of tools, and a compile error if the
// source does not parse.
export type ToolCreation = {
    // Wire name the model calls. Must match the registry-safe pattern in
    // src/core/tool-source.ts and is NOT reserved: an intentional replacement of
    // any name, including a harness-owned one, is published atomically.
    name: string;
    // Shown to the model and used by toolRequest matching.
    description: string;
    // Capability tags. Required: an untagged creation could never be discovered.
    tags: readonly string[];
    // Optional JSON Schema for the arguments.
    parameters?: Record<string, unknown>;
    // Legacy async function body, e.g. `return args.toUpperCase();`.
    // OPTIONAL when `moduleText` is present: source-registered tools persist their
    // full module revision instead.
    source?: string;
    // Full editable module source retained by a source registration so a snapshot
    // can recompile it. Mutually exclusive with `source`.
    moduleText?: string;
    // Package-relative or absolute entry path. When present on a snapshot record
    // restore re-reads the editable source (the record also carries moduleText as
    // a stable fallback for an edited/deleted file).
    sourcePath?: string;
    // Captured local helper modules for the module revision.
    dependencies?: readonly { path: string; text: string }[];
    // Optional visibility of the installed registration. Existing toolCreate
    // records omit it (searchable + enabled).
    visibility?: ToolVisibility;
};

// What a successful toolCreate call hands back to the model. Metadata only: the
// source is never echoed, so a creation round costs one short result.
export type ToolCreationResult = {
    name: string;
    description: string;
    tags: string[];
    parameters?: Record<string, unknown>;
    // A created tool is registered `searchable` and enabled at once, so the very
    // next turn can call it without a second toolRequest round.
    enabled: true;
};

// One captured local helper that belongs to an installed source revision.
export type HarnessToolSourceDependency = {
    path: string;
    text: string;
};

// Inspection view of the exact source revision behind a registered tool. `tools`
// registered from an already-constructed definition (configured tools/plugins)
// have no source entry and return undefined from `harness.toolSource()`.
export type HarnessToolSource = {
    name: string;
    // Content-addressed revision of the entry plus every captured local helper.
    revision: string;
    sourcePath?: string;
    moduleText?: string;
    dependencies: HarnessToolSourceDependency[];
    format: 'module' | 'function-body';
    source?: string;
    // The checks that were actually performed before publication. This is NOT a
    // claim of semantic type checking or behavioural correctness.
    checks: readonly string[];
};

// A candidate accepted by the kernel's single compile/load/validate/register
// operation. `sourcePath` and `moduleText` are module forms; `source` is the
// legacy async-body form. `definition` is accepted for host/plugin compatibility:
// those definitions are already constructed and are published through the SAME
// registry commit path (no source revision exists to inspect).
export type HarnessToolRegistrationCandidate = {
    name?: string;
    description?: string;
    tags?: readonly string[];
    parameters?: Record<string, unknown>;
    visibility?: ToolVisibility;
    source?: string;
    moduleText?: string;
    sourcePath?: string;
    dependencies?: readonly HarnessToolSourceDependency[];
};

// What a successful registration returns. It is metadata only: no function,
// schema body, or source text is echoed to the model.
export type HarnessToolRegistrationResult = {
    name: string;
    // The installed revision. A replacement changes this value.
    revision: string;
    // True when the name was not registered before this call.
    created: boolean;
    // True when an existing registration was atomically replaced.
    replaced: boolean;
    previousRevision?: string;
    sourcePath?: string;
    // The checks performed by the kernel for this revision.
    checks: readonly string[];
};

// toolList's model-facing row. Deliberately ONLY these two fields: listing must
// not imply enabled/callable state, and the model can use toolRequest for tags
// or toolManage for schema/source.
export type HarnessToolListEntry = {
    name: string;
    description: string;
};

// toolManage operations. Reads are always available; create/update/reload go
// through the same kernel as toolCreate/toolRegistry.
//
// T19 adds the three OPERATOR switches behind the REST session-tool routes
// (`enable`/`disable` = the discovery slot only, `remove` = unregister the whole
// registration). They are host-side operations: the model-facing `toolManage` schema
// (./core/metadata.ts) keeps its own narrower operation list, so a run cannot quietly
// unregister a tool the operator installed.
export type HarnessToolManageOperation =
    | 'list'
    | 'details'
    | 'source'
    | 'path'
    | 'create'
    | 'update'
    | 'reload'
    | 'enable'
    | 'disable'
    | 'remove';

export type HarnessToolManageParameters = {
    operation: HarnessToolManageOperation;
    name?: string;
    // Persistence mode for create/update. 'folder' (default) writes an editable
    // *.tool.ts entry inside a configured toolFolders root; 'runtime' keeps the
    // revision only in the registry/snapshot and never touches disk.
    persist?: 'folder' | 'runtime';
    // Explicit disk target. A write happens only when this is supplied AND the
    // path resolves inside one of the harness's configured toolFolders.
    path?: string;
    // Configured folder used to resolve a relative path (defaults to the first).
    folder?: string;
    moduleText?: string;
    // Legacy async function body; mutually exclusive with moduleText.
    source?: string;
    description?: string;
    tags?: readonly string[];
    parameters?: Record<string, unknown>;
    visibility?: ToolVisibility;
    dependencies?: readonly HarnessToolSourceDependency[];
};

// Harness-owned, stable tool memory. It survives implementation replacement and
// is shared by every agent/tool in this harness. It is intentionally NOT reset by
// a tool replacement; `reset()` is a session operation and leaves it intact so a
// replacement can keep its durable state. It is not persisted across processes
// (that is the existing snapshot contract, not this feature).
export type HarnessMemory = {
    // Direct key/value map for tool-owned state. Values may be any JS value.
    readonly data: Record<string, unknown>;
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    has: (key: string) => boolean;
    delete: (key: string) => boolean;
    keys: () => string[];
    clear: () => void;
};

// Live operations the standalone core-tool source entries delegate to. These are
// kernel/harness state operations (discovery, guarded creation, per-session record
// stores), not a restricted capability facade: every tool still receives the
// unrestricted `context.harness` reference above.
export type HarnessToolRuntime = {
    // toolRequest: select/enable catalogue matches with this harness's enabled-set
    // bound and caller-specific core view.
    requestTools: (
        caller: Agent | undefined,
        parameters:
            | { names?: unknown; regex?: unknown; tags?: unknown; limit?: unknown }
            | unknown,
        selfCallId?: string
    ) => unknown;
    // toolList: every live registry entry, in insertion order, name+description only.
    listTools: () => HarnessToolListEntry[];
    // toolManage: inspect/source/path plus validated create/update/reload through
    // the same kernel. The result is data only (no executable definitions).
    manageTool: (
        caller: Agent | undefined,
        parameters: HarnessToolManageParameters | unknown
    ) => unknown;
    // toolCreate: guarded model-facing creation (policy + lifetime budget) through
    // the same registration kernel. The HOST `createTool` path remains unguarded
    // by role policy.
    createToolForAgent: (caller: Agent | undefined, creation: ToolCreation) => ToolCreationResult;
    // agentManage/agentResult read the harness's bounded invocation registry
    // (completed answer values only, never transcripts).
    agentManage: () => unknown;
    agentResult: (parameters: Record<string, any>) => unknown;
    // delegate: one-level bounded delegation. `run` is the invocation-bound
    // harness runner from ToolContext (never a captured implementation).
    // `callerSignal` is the CALLING run's signal, so a child cancellation can be told
    // apart from a caller rollback (see harness.ts `delegateFor`).
    //
    // `parameters.timeoutMs` (policy 2026-11-09, thread-timeout task doc): OPTIONAL and
    // UNBOUNDED when omitted — the child runs to its own final answer and no clock ends
    // it. This host path is NOT schema-validated, so the delegate TOOL schema's
    // 1..3600000 range bounds a model argument only; a host may pass any finite bound
    // (including one above the ceiling) and it is honoured as given. Passing a
    // non-finite number is treated as "omitted".
    delegate: (
        caller: Agent | undefined,
        parameters: {
            agent?: string;
            input?: string;
            maxChars?: number;
            requireClarification?: boolean;
            timeoutMs?: number;
            scope?: { tools?: readonly string[] };
        },
        run: ToolContext['run'],
        runDepth: number | undefined,
        callerSignal?: AbortSignal,
        selfCallId?: string,
        selfScope?: string
    ) => Promise<HarnessDelegationResult>;
    // Conditional cross-thread chat / roster. Sender identity comes from the
    // runtime context, never from model arguments.
    threadSend: (
        caller: Agent | undefined,
        threadId: string | undefined,
        parameters: Record<string, unknown>
    ) => HarnessThreadMessageResult;
    threadList: (threadId: string | undefined) => HarnessThreadRoster;
    // Opt-in network tools. The per-harness provider closures (and therefore their
    // credentials) live in the harness; the independently compiled source entries
    // only delegate to these live operations. A source replacement that does not
    // use the configured provider can ignore them.
    search: (context: ToolContext) => Promise<unknown>;
    fetch: (context: ToolContext) => Promise<unknown>;
    // The unified session store (records-engine Decision A). Every record-tool
    // source entry — `records` itself plus the four wrappers `tasks`, `chapters`,
    // `profiles`, `locations` — ends with exactly this call, so the store lives in
    // ONE place (the harness's record engine) and, in worker mode, the write is
    // performed by the AUTHORITY on the canonical harness rather than on a lane
    // replica. `name` is the CALLING TOOL's wire name; the engine maps it to its
    // collection and to that wrapper's response shape. State stays harness-owned
    // and is cleared by reset().
    //
    // Why a routed runtime method rather than `context.callTool('records', …)`:
    // `lane-worker-loop.ts` throws for any `harness.runtime` key that is neither
    // routed to the authority nor declared local, so forgetting one registration
    // fails at worker startup instead of losing the write silently (F5).
    executeRecords: (name: RecordsToolName, context: ToolContext) => Promise<unknown>;
};

// Options for a nested/registered-tool invocation through `harness.callTool`.
// Everything omitted is inherited by `ToolContext.callTool` from the calling run.
export type HarnessToolCallOptions = {
    agent?: Agent;
    signal?: AbortSignal;
    threadId?: string;
    runDepth?: number;
};

// Who may create tools at runtime (R12). See HarnessConfiguration.toolCreation:
// 'all' (default, every agent), 'primary' (primary only; subagents neither see
// nor can call the tool), false (no model-facing toolCreate at all — the host
// `harness.toolCreate()` path remains available).
export type ToolCreationPolicy = 'all' | 'primary' | false;

// What a delegation hands back to the primary agent: the subagent's answer, not
// its transcript (history stays with the subagent).
//
// IDENTITY (T28). The result used to be `{ agent, content }`, which carried no way to
// correlate it with a thread or an invocation: a caller had to call `threadList` and
// match by agent name plus sequence order, which is ambiguous with two concurrent runs
// of the same agent. Every field below is the SAME identity `agentManage`/`agentResult`
// report, so one id works everywhere:
//   - `invocationId` — the `agentResult`/`agentManage` id for this run;
//   - `threadId`     — the persistent conversation it ran in (the address `threadSend`
//                      and `threadRead` take), absent only for an ephemeral branch;
//   - `status`       — the terminal state, so a caller never has to infer it;
//   - `durationMs`   — the measured span of the child run.
//
// BOUNDED CONTENT (T28). `content` is paged exactly like `agentResult`: `maxChars`
// (default 8000) caps one page, `contentLength` is the full length, and
// `truncated`/`nextOffset` say how to read the rest. A 58 KB answer therefore costs one
// page plus an explicit continuation instead of the whole payload in one tool result.
export type HarnessDelegationResult = {
    agent: string;
    // The answer page. Empty for a cancelled/failed child (see `error`).
    content: string;
    // Full answer length in characters, independent of the page returned.
    contentLength: number;
    // 0-based character offset this page starts at.
    offset: number;
    // The page bound that was applied.
    limit: number;
    // True when more of the answer remains after this page.
    truncated: boolean;
    // Where to continue; present exactly when `truncated` is true.
    nextOffset?: number;
    // The invocation identity, shared with agentManage/agentResult.
    invocationId: string;
    // The persistent conversation the child ran in. Absent for an ephemeral branch.
    threadId?: string;
    // Terminal state of the child run.
    status: HarnessInvocationStatus;
    // Measured span of the child run, in milliseconds.
    durationMs: number;
    // Failure/cancellation message. Present only when `status` is not 'completed'.
    error?: string;
    // What the child had already produced when it was cancelled or failed, so a
    // post-mortem does not require the (rolled-back) transcript. Present only for a
    // non-completed run that had said something substantive.
    partialContent?: string;
    // How many messages the child had appended when it was cancelled/failed. This is
    // the "how far did it get" number the transcript rollback used to erase.
    cancelledAtMessage?: number;
};

// Terminal (or in-flight) state of one agent invocation. The same vocabulary
// agentManage/agentResult report, exported so a host can switch on it.
export type HarnessInvocationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// ---------------------------------------------------------------------------
// actionRequest / threadFork / branches (N3)
// ---------------------------------------------------------------------------
//
// actionRequest lets a model stop and ask its OWNER a bounded question when the
// request is genuinely ambiguous. The model always supplies alternatives plus a
// recommended option; it can never force the owner to accept the recommendation
// (there is no silent fallback), and the owner may always answer with free text
// because `allowCustom` is a type-level `true`, not a model-controlled argument.
//
// threadFork copies an agent's ENTIRE committed history into a private branch so
// another thread can read that history independently and return one summary. A
// branch is not a sandbox: it shares the source agent's transport and the host's
// external tool side effects. It owns a detached transcript and reset baseline.
//
// Cross-references:
//   - ../core/action.ts   — strict runtime parsing for both wire shapes
//   - ../core/branch.ts   — fork identity, tool-id materializer, branch bounds
//   - ../core/agent.ts    — Agent.fork()
//   - ../core/metadata.ts — actionRequest / threadFork schemas
//   - ../harness.ts       — runtime that creates/records branches (later worker)

// One choice the model offers the owner. `id` is the stable value a reply names;
// `label` is what a UI shows. `description` is optional supporting detail.
export type HarnessActionOption = {
    id: string;
    label: string;
    description?: string;
};

// The model-facing request. `recommended` MUST be one of the option ids: the
// parser rejects an unknown id rather than silently falling back to options[0],
// so a UI can always highlight a real recommendation.
export type HarnessActionRequest = {
    // Generated by the runtime, never by the model.
    requestId: string;
    question: string;
    recommended: string;
    options: HarnessActionOption[];
    // Always true. Custom free-text answers are part of the contract, not a
    // switch the model may disable.
    allowCustom: true;
};

// The answer itself, as chosen by an owner (human/host) or the automatic owner
// fork. Either an option id or free text; never both.
export type HarnessActionChoice =
    | { kind: 'option'; optionId: string }
    | { kind: 'custom'; text: string };

// Recorded answer envelope. `source` says who answered; `branchId` is present
// only when an automatic owner fork answered.
export type HarnessActionAnswer = {
    requestId: string;
    choice: HarnessActionChoice;
    source: 'owner' | 'auto';
    branchId?: string;
};

// The tool result handed back to the requesting model. Option choices carry the
// resolved label/description so the model sees the human-visible wording even
// though it only sent an id.
export type HarnessActionResult = {
    requestId: string;
    answeredBy: 'owner' | 'auto';
    choice:
        | { kind: 'option'; optionId: string; label: string; description?: string }
        | { kind: 'custom'; text: string };
};

// What a host action handler sees. `agent`/`branchId`/`threadId`/`callId`
// identify the requester precisely; `request` is already parsed and validated.
export type HarnessActionRequestContext = {
    requestId: string;
    agent: string;
    branchId?: string;
    threadId?: string;
    callId: string;
    request: HarnessActionRequest;
};

// A host-supplied answerer. The signal aborts with the run; a handler that
// rejects fails the actionRequest call (the model receives the error).
export type HarnessActionHandler = (
    context: HarnessActionRequestContext,
    signal: AbortSignal
) => Promise<HarnessActionChoice>;

// What threadFork returns to the requesting thread: an identity plus the final
// summary content. The full transcript stays in `harness.branch(branchId)`.
export type HarnessForkResult = {
    branchId: string;
    threadId: string;
    content: string;
};

// The public, bounded description of one branch. `role` is the source agent's
// role in the harness, `tools` the wire names that branch could call. `forkDepth`
// counts ordinary forks (1 = a fork of a root); autoanswer branches inherit their
// source depth because they do not consume a general nesting level.
export type HarnessBranchSummary = {
    branchId: string;
    kind: 'fork' | 'autoanswer';
    agent: string;
    role: 'primary' | 'subagent';
    sourceBranchId?: string;
    // The INVOCATION identity of the requester (`HarnessThread.id`), i.e. the run
    // that asked for the fork/answer. Display/audit only.
    sourceThreadId?: string;
    // M2: the PERSISTENT conversation that owns this branch (a host thread id or
    // `agent:<name>`). Unlike `sourceThreadId` it is stable across resumptions,
    // and `deleteThread` purges every branch with this owner — including an
    // autoanswer branch and a nested fork (a branch run inherits its parent's
    // persistent owner).
    threadId?: string;
    callId?: string;
    requestId?: string;
    forkDepth: number;
    model: string;
    tools: string[];
};

// Lifecycle of one branch record. `running` is the only non-terminal state.
export type HarnessBranchStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// The terminal statuses a `branch_end` event may report.
export type HarnessBranchTerminalStatus = Exclude<HarnessBranchStatus, 'running'>;

// A branch record is a SUMMARY plus the branch's own committed transcript and
// the deterministic origin→branch tool-id mapping the materializer produced.
// It is runtime/session state, deliberately NOT part of snapshot v1.
export type HarnessBranchRecord = HarnessBranchSummary & {
    status: HarnessBranchStatus;
    // Deterministic provider-safe remap for every tool call in `messages`.
    // `origin` is the id in the source transcript; `branch` is the id this
    // branch uses. Empty for a branch with no tool calls.
    toolCallIds: Array<{ origin: string; branch: string }>;
    // The branch's entire committed transcript (cloned, remapped and with
    // pending calls paired by an explicit non-success placeholder). Never a
    // reference to the owner's live array.
    messages: HarnessMessage[];
    // Present when the branch finished normally.
    result?: { content: string; stopReason: HarnessStopReason };
    // Present when the branch failed or was cancelled.
    error?: HarnessErrorInfo;
};

// Fork/branch bounds. Every field is optional; the defaults are the frozen
// values in ../core/branch.ts (maxDepth 2, maxConcurrent 4, maxHistoryBytes
// 8 MiB, maxBranchRecords 64).
export type HarnessForkConfiguration = {
    enabled?: boolean;
    maxDepth?: number;
    maxConcurrent?: number;
    maxHistoryBytes?: number;
    maxBranchRecords?: number;
};

// Owner interaction. `actionRequest` installs the host answerer; `autoAnswer`
// lets an owner fork answer tool-free when no handler is available. Neither
// enables the tool by itself: the harness registers `actionRequest` only when
// interaction is configured.
export type HarnessInteractionConfiguration = {
    actionRequest?: HarnessActionHandler;
    autoAnswer?: boolean;
};

// ---------------------------------------------------------------------------
// Declarative tool UI panels (R20.2)
// ---------------------------------------------------------------------------
//
// A tool may return a `ToolUiEnvelope` (built with the `toolUi()` helper) to give
// the client a small, safe, declarative rendering of its result. The envelope is
// INTERNAL: the harness unwraps it, sends `content` to the model exactly as it
// would send any other tool value, and reports the panels on the optional
// `ui` field of the `tool_result` event / `ToolCallResult`. This keeps the model
// context identical to a plain return value.
//
// SECURITY: panels are DATA ONLY. There is no HTML, JavaScript, URL action, or
// callback in this shape, so a tool cannot inject executable content into the
// browser. The server normalizes and bounds every supplied panel (see
// src/core/tool-ui.ts) before it reaches a client.
//
// `slot` is an open string, not an enum: today the client mounts `right` next to
// the transcript and can treat `center`/`left` as additional placements, and a
// future host may add its own slot names without a schema change.
export type ToolUiBlock =
    | { type: 'text'; text: string }
    | { type: 'table'; columns: string[]; rows: string[][] }
    | { type: 'keyValue'; items: { label: string; value: string }[] };

export type ToolUiPanel = {
    // Stable within one tool result; lets a client update a panel in place.
    id: string;
    // Placement hint. Extensible: 'right' is the default mount point.
    slot: string;
    title: string;
    blocks: ToolUiBlock[];
};

// The branded value `toolUi(content, panels)` returns. The brand property is a
// plain string key so it survives module duplication and can be detected with an
// own-property check; `content` is the ordinary tool result the model sees.
export type ToolUiEnvelope<TContent = unknown> = {
    readonly __toolUi: ToolUiPanel[];
    readonly content: TContent;
};

// ---------------------------------------------------------------------------
// Tool media: the same branded-envelope idea (R20.2) for BYTES, not panels
// ---------------------------------------------------------------------------
//
// A tool that fetched real file data returns `toolMedia(result, attachments)`:
//
//     return toolMedia({ url, name, mime, bytes }, [attachment]);
//
// The envelope is INTERNAL, exactly like `toolUi()`. The harness unwraps it at
// the ONE place a result is committed (`deliverTask`) and then:
//   - the model-facing text is `serialize(result)` — byte-for-byte what an
//     ordinary return value would have produced, still capped by
//     `boundToolResult`, and NEVER carrying the bytes;
//   - the validated attachments are stored on the committed `tool` message
//     (`HarnessMessage` tool branch, `attachments`);
//   - the `tool_result` event reports `ToolMediaDescriptor[]` only (no base64);
//   - the transport turns them into a labelled user-role multimodal payload.
//
// COMPOSITION with `toolUi()` is order-independent: the harness unwraps media
// and panels in a loop, so `toolMedia(toolUi(content, panels), media)` and
// `toolUi(toolMedia(content, media), panels)` both yield the same
// `{ content, panels, media }` triple.
//
// SECURITY: the attachments are validated against the DOWNLOAD profile at both
// ends (fail-at-the-tool in `toolMedia()`, defence-at-the-boundary in
// `toolMediaOf()`, mirroring `toolUi()`/`toolUiOf()`). A hand-built or forged
// envelope with 500 MB of data is REJECTED, never spliced into history and
// never silently dropped — an oversized payload is an explicit tool failure the
// model can read.
export type ToolMediaEnvelope<TContent = unknown> = {
    readonly __toolMedia: HarnessAttachment[];
    readonly content: TContent;
};

// ---------------------------------------------------------------------------
// records — the ONE session store engine (records-engine.md, Decisions A-P)
// ---------------------------------------------------------------------------
//
// Everything the model stores about the session lives here: one store, one id
// counter, one entry shape, one set of race controls. `tasks`, `chapters`,
// `profiles` and `locations` are thin wrappers over it (Decision E: schema +
// collection mapping + response shape, no state and no logic of their own), and
// `records` is the low-level surface the model escalates to when a wrapper's
// schema refuses a request (Decision R4/R6).
//
// The rules the types below encode:
//   - ONE id space (F3): ids are globally unique ACROSS collections, drawn from
//     one monotonic counter, so a chapter id and a task id can never collide and
//     the first task is not necessarily "1";
//   - per-collection `storeRev` + per-collection FIFO change window (Decision B):
//     the disjoint-merge proof needs a gap-free window, which a shared log across
//     collections would break with unrelated writes;
//   - NO locks and NO claims (Decision P): every patch is accepted unless it is
//     stale, so an entry carries no `owner`, no `ownerThreadId` and no
//     `leaseUntil`. Attribution (`updatedBy`/`updatedThreadId`/`updatedAt`) is an
//     immutable fact and is never re-validated against the agent roster
//     (Decision L: "if Person A writes a memo and he dies, the memo was still
//     written by Person A");
//   - a stale rejection returns the CURRENT entry (R9), not just a sentence, so a
//     conflict costs one round trip;
//   - collections are declared in code and extensible by `define` (Decision C),
//     persist in the snapshot (Decision M), and are permanent once non-empty.
//
// Cross-references:
//   - ../core/records.ts        — the engine that reads and writes all of this
//   - ../core/{task,profile,chapter,location}.ts — the built-in collection specs
//   - ../tools/runtime/*.tool.ts — the five source entries (models + routing)
//   - ../core/snapshot.ts       — persists it as `snapshot.records`
//   - ../server/workers/lane-authority.ts — the routed write path in worker mode

// The value types a collection field may declare. `strings` is a bounded,
// trimmed, de-duplicated string array (the `traits` shape).
export type RecordFieldType = 'text' | 'boolean' | 'integer' | 'enum' | 'strings';

// One declared field. `key` order in a collection definition IS the canonical
// order: it decides the order of every emitted entry, every persisted entry (a
// store always serializes to the same byte size) and every `fields` array in the
// change log — which is what lets a caller compare change entries without
// sorting them (F9).
export type RecordFieldDefinition = {
    key: string;
    type: RecordFieldType;
    // True when an ADD must supply it (non-empty). A patch may still omit any
    // field, which leaves the stored value unchanged.
    required?: boolean;
    // `text` / `strings` element cap. Enforced engine-side so `records` and every
    // wrapper write are bounded, and mirrored in the wrapper's JSON Schema so a
    // model is refused before the call runs (Decision G).
    maxLength?: number;
    // `strings`: how many entries the array may carry.
    maxItems?: number;
    // `enum`: the closed value set. A typo cannot create a value the counts do
    // not know about.
    values?: readonly string[];
    // `integer`: the inclusive upper bound. Absent means "any safe integer".
    max?: number;
    // The value an ADD stores when the caller omits the field. Absent means the
    // field is optional and simply missing until written (chapters' `order`).
    default?: unknown;
    // True when the field is only ever returned by a single-entry `get`
    // (chapters' `content`): lists, pages and mutation results carry a
    // projection without it, so a long body cannot flood the context window.
    getOnly?: boolean;
    // `integer`: an ascending sort key for the collection's list order.
    sortable?: boolean;
    // Count facets derived from the whole store on every call:
    //   - `boolean` with `count: { key, complement }` → `{ [key]: n, [complement]: total-n }`
    //     (tasks' `completed` + `pending`);
    //   - `enum` with `count: true` → one count per declared value
    //     (chapters' `planned`/`draft`/`complete`).
    count?: { key: string; complement?: string } | true;
};

// How a wrapper reshapes the engine envelope into its own domain contract.
//   - 'batch'  — `tasks`: input IS the engine input and the answer is the engine
//     page under the collection's plural name (the historical task wire design);
//   - 'action' — `chapters`/`profiles`/`locations`: the model passes
//     `{ action, id, ...fields }` and gets back `{ <plural>, counts, page }` for a
//     list, `{ <singular>, counts }` for a mutation, `{ removed, counts }` for a
//     removal (the historical record-tool contract).
export type RecordWrapperStyle = 'batch' | 'action';

// One collection: the engine cannot infer any of this (F9), so it is declared.
export type RecordCollectionDefinition = {
    name: string;
    fields: readonly RecordFieldDefinition[];
    // Engine-owned store bound (Decision G / F13): an unbounded store is an
    // unbounded context risk, not a freedom.
    maxRecords: number;
    // Page budget, STRICTLY below the outer model-facing cap so an inner page can
    // never report `hasMore: false` while the outer envelope truncates (F13).
    responseBudgetBytes: number;
    // The wrapper that serves this collection, when it has one.
    wrapper?: { tool: string; plural: string; singular: string; style: RecordWrapperStyle };
};

// One stored record in any collection: identity + content revision + attribution,
// then the collection's declared fields. `rev` starts at 1 and increments ONLY
// when a declared field actually changes. There is no lock field — Decision P.
//
// The attribution triple is read from the ToolContext, never from tool arguments,
// so the model cannot forge who edited what. Keys stay ABSENT (never
// `undefined`-valued) when unknown, so an untouched store serializes byte-for-byte
// like the pre-T1 shape and the page budget measures the real payload.
export type RecordEntry = {
    id: string;
    rev: number;
    updatedBy?: string;
    updatedThreadId?: string;
    updatedAt?: string;
} & Record<string, unknown>;

// One compare-and-swap precondition: the revision the caller actually READ for
// that id. The engine rejects the WHOLE call when the stored rev differs, and the
// rejection carries the current entry (R9).
export type RecordExpect = {
    id: string;
    rev: number;
};

// The three recorded store events. `claim`/`release` are GONE (Decision P deleted
// the lock, so there is no ownership event to log and nothing to sweep when a
// thread dies).
export type RecordChangeOp = 'add' | 'update' | 'remove';

// One entry of a collection's bounded change window. `rev` is the STORE event
// revision after this change (per collection — Decision B), `itemRev` is the
// record's content revision. `fields` names which fields an `update` actually
// changed, in the collection's canonical order; that is what lets an opt-in
// disjoint merge PROVE the concurrent edit touched different fields.
export type RecordChange = {
    rev: number;
    id: string;
    op: RecordChangeOp;
    by?: string;
    threadId?: string;
    at: string;
    fields?: string[];
    itemRev?: number;
};

// One page cursor. Offset mode keeps `nextOffset`; keyset mode (`afterId`) echoes
// the cursor and answers with `nextAfterId`, because a numeric-id cursor survives
// another agent removing a record mid-walk while an index cannot.
export type RecordsPageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
    afterId?: string;
    nextAfterId?: string;
};

// Counts are always derived from the whole collection, never from the page: a
// caller listing page 2 must still see how many records exist in total. The facet
// keys come from the collection definition.
export type RecordCounts = Record<string, number>;

// THE engine result — ONE shape for every success (Decision D): the page, the
// counts, the cursor, the collection's store revision, and (when the call is a
// single-id read or a one-record mutation) `entry`. `removed` names the records
// this call deleted. The three change keys appear only when the call passed
// `since`. `storeRev` lets a caller poll `since: storeRev` next time and get only
// what it missed.
export type RecordsResult = {
    entries?: RecordEntry[];
    entry?: RecordEntry;
    removed?: RecordEntry[];
    counts: RecordCounts;
    page: RecordsPageInfo;
    storeRev: number;
    changes?: RecordChange[];
    changesHasMore?: boolean;
    changesTruncated?: boolean;
    // `define`/`drop` only: the collection this call registered or removed.
    collection?: string;
};

// The generic model-facing arguments for `records`. `collection` is a STRING, not
// an enum, on purpose (Decision C): an enum cannot grow at runtime, which
// forecloses `define`; so the engine validates the name against the registered set
// BEFORE dispatch and throws naming the defined collections. A typo must never
// resolve to a plausible-looking empty list — discovery fuzziness (../core/
// discovery.ts) applies to tool NAMES, never to parameter values, so nothing else
// in the system would rescue `collection: 'tsak'`.
export type RecordsParameters = {
    collection?: string;
    // Batch add/patch: an entry with no `id` adds, an entry with a known `id`
    // patches, and every field it omits keeps its stored value.
    entries?: Record<string, unknown>[];
    // Exact ids to delete.
    remove?: string[];
    // Exact ids to read (one → `entry`, several → `entries`).
    ids?: string[];
    expects?: RecordExpect[];
    since?: number;
    offset?: number;
    limit?: number;
    afterId?: string;
    mergeDisjoint?: boolean;
    // Registers a NEW collection (Decision C/M). A name that already exists is an
    // ERROR, never a silent merge.
    define?: {
        name: string;
        fields: RecordFieldDefinition[];
        maxRecords?: number;
    };
    // Drops the named collection — only when it is empty, and only if an agent
    // defined it (Decision M: dropping a non-empty collection would itself mutate
    // history).
    drop?: boolean;
};

// The five tool names the record engine serves: the engine surface plus its four
// wrappers. Names are the wire names, identical to the collection keys except
// `records` itself (Decisions I, J and K).
export const RECORDS_TOOL_NAMES = [
    'records',
    'tasks',
    'chapters',
    'profiles',
    'locations'
] as const;

export type RecordsToolName = (typeof RECORDS_TOOL_NAMES)[number];

// The built-in collection keys (Decision K: plural, identical to their wrapper's
// tool name).
export const RECORD_COLLECTION_NAMES = ['tasks', 'chapters', 'profiles', 'locations'] as const;

export type RecordCollectionName = (typeof RECORD_COLLECTION_NAMES)[number];

// One collection's restorable state (Decision M): the DEFINITION travels with the
// entries, so a collection an agent `define`d mid-session is rediscovered after a
// restart, and a restored definition is itself validated before anything mutates.
export type RecordCollectionState = {
    definition: RecordCollectionDefinition;
    items: RecordEntry[];
    storeRev: number;
    changes: RecordChange[];
};

// The whole store as one collection map (T3). This replaces the four separate
// `records.todos` / `records.profiles` / `records.chapters` / `records.locations`
// sections of snapshot v1 — one map, because one store owns one id counter (F3).
// Greenfield: nothing is in production, so v1 is not migrated (R5); the version
// constant in ../core/snapshot.ts says the shape changed.
export type RecordsStoreState = {
    // The GLOBAL id counter: monotonic across every collection for the life of the
    // harness, restarted at 1 by reset().
    nextId: number;
    collections: Record<string, RecordCollectionState>;
};

// The shared CRUD action set the 'action'-style wrappers accept. `add` creates,
// `list` reads a page, `get` reads one record (the only action that returns a
// `getOnly` field), `update` patches one (partial), `remove` deletes one.
export type RecordAction = 'add' | 'list' | 'get' | 'update' | 'remove';

// ---------------------------------------------------------------------------
// `tasks` — the core wrapper over the engine (Decision I keeps it core)
// ---------------------------------------------------------------------------
//
// The historical task wire design survives unchanged apart from Decision P: one
// call carries a partial patch (add/patch by entry, delete by id), ids are stable
// strings, every success answers with the same bounded page, and `claim`/`release`/
// `takeover`/`leaseMs` are gone.

// One stored task. `text` and `completed` are the collection's two declared
// fields, in that canonical order.
export type TaskItem = RecordEntry & {
    text: string;
    completed: boolean;
};

export type TaskExpect = RecordExpect;

// One entry of the model-facing `tasks` patch. A new task omits `id` and must
// carry `text`; an entry naming a known `id` patches that task and every field it
// omits keeps its stored value.
export type TaskInput = {
    id?: string;
    text?: string;
    completed?: boolean;
};

// The wrapper's arguments: the engine input minus `collection` (the wrapper names
// it) and minus the claim verbs (Decision P).
export type TaskParameters = {
    tasks?: TaskInput[];
    remove?: string[];
    expects?: TaskExpect[];
    since?: number;
    offset?: number;
    limit?: number;
    afterId?: string;
    mergeDisjoint?: boolean;
};

// Counts are derived on every call so the model does not have to list and count.
export type TaskCounts = {
    total: number;
    completed: number;
    pending: number;
};

export type TaskChangeOp = RecordChangeOp;
export type TaskChange = RecordChange;
export type TaskPageInfo = RecordsPageInfo;

// THE tasks result: the engine envelope under the collection's plural key. Every
// successful call returns exactly this shape — read, add, patch and removal alike
// — which is what makes "mutate and instantly return the list" one round trip and
// what removes the read-first dance `/task` used to pay for a rev token (F7).
export type TaskResult = Omit<RecordsResult, 'entries' | 'counts'> & {
    tasks: TaskItem[];
    counts: TaskCounts;
};

// The shared CRUD action set is declared above with the engine types.

// What a tool implementation is handed when the model calls it.
//
// The harness fields are optional because a tool can also be executed on its
// own: `read(['package.json'])` runs the same implementation with no agent, no
// registry, and no run(). A tool that needs them must check, and the presets in
// src/tools deliberately do not.
// T14/T15: whether a nested agent run may start in THIS harness instance.
//
//   - 'allow'  — the default, and the only value an inline harness ever holds: `delegate`,
//                `threadFork` and a tool's `context.run(...)` all start a child conversation
//                whose record and transcript live in the same harness that publishes them, and a
//                tool receives the strict-identical live `context.harness`;
//   - 'refuse' — armed ONCE, before the first turn, on EVERY lane WORKER REPLICA by
//                `src/server/workers/lane-worker-loop.ts` `refuseNestedRuns`. The arm is not a
//                preset option: it follows from the execution mode, and a replica whose build has
//                no nested-run seam FAULTS the handshake instead of quietly running children on a
//                private copy. A child started inside a lane is invisible to the canonical session
//                (its thread record and its transcript live only in that replica, and a lane
//                commit publishes only the target conversation's tail, its declared memory window
//                and its terminal result archives), so every nested-run door throws the named
//                `nested-run-unsupported` limitation BEFORE the child, its transcript or its
//                provider request exists. Explicit refusal, never a private child.
//
// The doors 'refuse' closes are refused at the SURFACES, not at a stack depth (T15): a refusing
// instance builds every tool context from `toolHandleView` (the callable, `sendThreadInput` and
// the sibling brains refuse whenever they are reached), `toolAgentsView`, and a guarded `run`
// closure, so storing one of those references and calling it after the tool's own invocation
// settled is refused exactly like calling it inside the body. `runAgent` still refuses a run
// nested inside another run or a branch, and the tool-body window remains as the backstop for a
// RAW handle a host-defined closure (no scanned source) captured in its own scope.
//
// The code and the refusal sentence live in src/core/nested-runs.ts; the doors live in
// src/harness.ts. Cross-references: ToolContext.nestedRuns, ToolContext.harness,
// Harness.nestedRuns, and src/server/workers/capability.ts (the hello report's door scan +
// limitation entries).
export type NestedRunPolicy = 'allow' | 'refuse';

export type ToolContext<TParameters = any> = {
    // The parameter value. For a schema with several properties this is the
    // parsed arguments object; for a schema with exactly one property it is that
    // property's value (see src/core/tool.ts).
    parameters: TParameters;
    // The agent that requested this call. Present only inside a harness.
    agent?: Agent;
    // Every agent in the harness, so a tool can reach a sibling brain.
    agents?: Readonly<Record<string, Agent>>;
    // Run a full turn (including tool execution) on a named agent. Present only
    // inside a harness.
    //
    // `options.signal` (T28) lets the CALLER bound the child independently of the
    // calling run: `delegate` uses it to enforce an EXPLICIT `timeoutMs` without
    // aborting its own tool call (which would discard the structured result it wants
    // to return). With no `timeoutMs` supplied the child is unbounded
    // (2026-11-09 policy) and this link exists only to carry the caller's abort.
    // Omitted, the child inherits the calling run's signal exactly as before.
    //
    // `options.tools` (T28) is an ALLOWLIST of wire names the child may see and call.
    // It is the scope a delegation needs: a pure-reasoning child gets no file or shell
    // tools, so a "planning" run cannot leave artifacts in the user's checkout. Omitted
    // means "no restriction" (the historical behaviour). `toolRequest` is exempt from
    // the allowlist (the scope escape hatch, delegate-stress finding 2), so a scoped
    // child can always name the capability it is missing.
    run?: (
        agentName: string,
        input: string,
        options?: { signal?: AbortSignal; tools?: readonly string[] }
    ) => Promise<HarnessAssistantMessage>;
    // The id of the tool call being executed (T28). Present for a model tool call
    // (the id the model wrote) and absent for a manual `executeTool` call, which has
    // no call id. A tool that inspects the pending board needs it to tell "work I
    // started" from "the call that is asking" — `toolRequest` uses it so its own
    // in-flight call does not make `toolCancel` look actionable.
    callId?: string;
    // The CALLING run's scheduler scope (T28). A tool-call id is unique only WITHIN
    // one run, so a child run records `parentScope` + `parentCallId` to be identified
    // unambiguously: two host parents that both call `delegate` with call id `c1` are
    // otherwise indistinguishable, and a delegation would report its sibling's
    // identity. Absent for a manual `executeTool` call, which has no run.
    runScope?: string;
    // Cancellation for the run that invoked this tool (R10), forwarded from
    // `HarnessRunOptions.signal`. Present for every HARNESS invocation (a direct
    // standalone call has none).
    //
    // BACKGROUND TOOLS (T3): this is a PER-CALL controller linked to the run's
    // signal, not the run signal itself. Aborting it cancels just this call (the
    // model's `toolCancel`), while a run-level abort still reaches every call.
    // The harness releases a cancelled call logically even if the implementation
    // ignores the signal; a late result is discarded.
    //
    // A tool SHOULD observe it (pass it to fetch/spawn, or call throwIfAborted()
    // between steps): the harness cannot preempt arbitrary JavaScript, so a tool
    // that ignores it keeps running to completion after a cancel. That is
    // deliberate — the harness never claims to have stopped side effects it does
    // not control.
    signal?: AbortSignal;
    // How deep the calling run is: 1 = a top-level run, 2 = a delegated/ctx.run
    // child. Present for every harness invocation. The model-facing delegate
    // tool uses it to keep delegation one level deep even when the primary agent
    // is itself being driven as somebody else's subagent.
    runDepth?: number;
    // The PERSISTENT thread this call belongs to (R2/R4). Set by the runtime from
    // RunState — never from tool arguments — so the sender identity of a
    // cross-thread message cannot be spoofed by the model. Absent for a manual
    // `executeTool` call, which runs as the primary agent outside any thread.
    threadId?: string;
    // The LIVE harness instance this call belongs to. On an INLINE harness this is the ORIGINAL
    // reference created at startup, never a clone, spread, serialized copy, or replacement
    // harness: a replacement tool therefore receives strict-identical harness identity to the tool
    // it replaced.
    //
    // T15 EXCEPTION (nested runs refused): while the instance's policy is 'refuse' — which only
    // ever happens on a lane worker replica (see `NestedRunPolicy`) — the reference is a stable
    // GUARDED VIEW over that same live handle, created once per instance (so every invocation on
    // the lane sees one identical object). Everything a lane toolbox actually needs passes through
    // untouched — `runtime.*` (the routed cross-thread and shared-state operations), `memory`,
    // `tools`, `commands`, `agent`, `executeTool`, `callTool`, `registerTool`, `threads()` /
    // `threadMessages()` reads and `nestedRuns()` — and the members that would START a conversation
    // on that replica (the callable itself, `sendThreadInput`, and the brains under `agents` /
    // `subagents` with their `turn()` / `stream()`) throw the named `nested-run-unsupported`
    // limitation WHENEVER they are reached, including from a callback the body kept after its own
    // call settled. The view is not a stub and not a snapshot: it is the live handle with those
    // doors closed, because a child conversation started on a lane is never published.
    harness?: Harness;
    // Invoke another REGISTERED tool through the live registry, preserving schema
    // validation, caller/thread identity, cancellation, and state-change
    // reporting. The definition is resolved at CALL time, so a later replacement
    // is observed rather than a fixed imported implementation. Available only
    // inside a harness invocation (it is bound to the current run/call context).
    callTool?: (name: string, parameters: unknown) => Promise<unknown>;
    // T14: the live NESTED-RUN policy of the harness running this call (see
    // `NestedRunPolicy`). Present whenever a harness runs the tool — a standalone
    // `tool()(args)` call has no harness, and therefore no nested-run question to
    // answer — and its value is this instance's policy at CALL time, never a
    // snapshot from construction.
    //
    // WHY A TOOL NEEDS IT: a lane worker refuses a nested run, so `run(...)` throws
    // rather than answering. A tool with a real LOCAL path (the shipped
    // `textSummarize` condenses the notes itself) should take that path on a lane
    // instead of turning an unsupported capability into a failed call. Check the
    // policy, or catch the named refusal — never assume `run` exists just because
    // this harness does.
    nestedRuns?: NestedRunPolicy;
};

// WHEN a finished call of this tool is allowed to start the next agent turn
// (T2/R3). The mode belongs to the RESOLVED definition, never to the wire name, so
// replacing a tool replaces its policy instead of inheriting one by name.
//
//   'sync'  — the completion joins its batch's SYNC GROUP: the run is re-entered only
//             once EVERY sync call launched from the same assistant message has
//             settled (success, failure, or cancellation). A message with one sync
//             call therefore waits for exactly that call before the next turn. The
//             implementation is STILL launched as background work (promise-backed,
//             cancelable, delivered through the agent mailbox); only the turn trigger
//             is grouped.
//   'async' — the completion triggers its own turn immediately, even while other
//             calls from the same message are still in flight. This is the historical
//             background-tool behaviour.
//
// EFFECTIVE DEFAULT: 'sync'. A tool that declares nothing is sync, and the shipped
// built-ins state their mode in their own `registration` literal so the policy
// survives scanning, the generated manifest, and source loading without ever being
// re-derived from a name.
export type ToolMode = 'sync' | 'async';

// A tool definition. `name` is optional: inside a harness the registry key names
// the tool, so `search: tool({...})` is enough.
export type ToolConfiguration<TParameters = any, TResult = any> = {
    name?: string;
    // WHEN a completion of this tool may start the next agent turn. Omitted means
    // 'sync' (see ToolMode): the call joins its message's sync group, and the run is
    // re-entered only once every sync call of that batch has settled. Declare 'async'
    // for a long-running tool whose outcome should re-prompt the model on its own.
    mode?: ToolMode;
    // Shown to the model. Required — an undescribed tool is an unusable tool.
    description: string;
    // Capability tags, used by tool discovery to find close matches. Required:
    // an untagged tool is invisible to toolRequest, so it could never be found.
    // Stored trimmed, lowercased, and deduplicated.
    tags: readonly string[];
    // 'core' tools are declared on every request; 'searchable' ones (the
    // default) stay hidden until toolRequest enables them.
    visibility?: ToolVisibility;
    // JSON Schema for the arguments. A TypeBox schema works as-is: TypeBox
    // output is plain JSON Schema.
    parameters?: Record<string, unknown>;
    // The implementation. Throwing is fine; the harness turns the error into a
    // tool result the model can read and recover from.
    execute: (context: ToolContext<TParameters>) => Promise<TResult> | TResult;
};

// A tool is an executable object: it can be called directly, or registered on a
// harness and called by the model. Both paths run the same implementation.
//
//     const read = tool<string[], FileReadResult>({...});
//     await read(['package.json']);        // direct, no harness
//     harness({ tools: { read } });        // the model calls it
export type Tool<TParameters = any, TResult = any> = {
    // Execute directly. The argument is the parameter value, exactly as
    // `execute` receives it.
    (parameters: TParameters): Promise<TResult>;
    // The wire name the model calls. A harness overwrites this with the
    // registry key when the tool is registered.
    name: string;
    description: string;
    // Normalized capability tags (trimmed, lowercased, deduplicated).
    tags: readonly string[];
    // Resolved visibility. A harness declares core tools plus enabled ones.
    visibility: ToolVisibility;
    // The DECLARED turn mode, copied from the configuration when one was given.
    // Absent means the harness applies the documented 'sync' default. The harness
    // never derives this from the wire name: a definition it did not register (a
    // replacement, a host tool, a model-created tool) carries only its own policy.
    mode?: ToolMode;
    parameters?: Record<string, unknown>;
    execute: (context: ToolContext<TParameters>) => Promise<TResult>;
};

// ---------------------------------------------------------------------------
// Web search (opt-in)
// ---------------------------------------------------------------------------
//
// One model-facing tool, `search`, backed by a hosted search API: Exa, Tavily
// or Linkup. The default provider is the first one that has a key in that
// preference order (exa > tavily > linkup), and `provider` overrides per call;
// the argument is only offered when more than one provider is configured. The
// keys are provider credentials, so they are resolved once at harness
// construction and never appear in a tool schema, argument, result, or progress
// event (W3).
//
// Cross-references:
//   - tools/websearch/index.ts  — createWebSearchTool, the per-harness factory
//   - harness.ts                — `websearch` configuration field wiring
export type WebsearchProvider = 'exa' | 'tavily' | 'linkup';

// A key, or a getter that reads it from a store when the harness is constructed.
// A getter is called once per harness construction and the captured key serves
// every search (no per-request rotation), so `process.env` is never read per call
// and two harnesses can hold different keys.
export type WebsearchCredential = string | (() => string | undefined);

export type WebsearchProviderConfiguration = {
    // Explicit override for this provider. When omitted the factory reads the
    // provider's environment variable (EXA_API_KEY / TAVILY_API_KEY /
    // LINKUP_API_KEY) instead.
    apiKey?: WebsearchCredential;
};

export type WebsearchConfiguration = {
    // Environment snapshot to read the three provider key variables from
    // (EXA_API_KEY / TAVILY_API_KEY / LINKUP_API_KEY). Tests and
    // deployments can inject one; the default is `process.env` (never a dotenv
    // autoload — the caller owns that).
    env?: Readonly<Record<string, string | undefined>>;
    // Explicit per-provider keys. A provider with no key (here or in `env`) is
    // simply absent: it is not registered and not offered to the model.
    exa?: WebsearchProviderConfiguration;
    tavily?: WebsearchProviderConfiguration;
    // Linkup (the third search provider). Same credential shape as `exa` /
    // `tavily`: an explicit string or getter, otherwise LINKUP_API_KEY from the
    // resolved environment. Resolution and provider ordering belong to
    // tools/websearch/index.ts.
    linkup?: WebsearchProviderConfiguration;
};

// The model-facing argument shape. `query` is the only required property; having
// more than one property keeps the object wrapper intact (see the single-property
// rule in core/tool.ts), and both optional fields are validated in execute.
export type WebSearchParameters = {
    query: string;
    // Requested result count. Defaults to 5 and is clamped to 1–20.
    maxResults?: number;
    // Which configured provider to use. Omitted = the first configured one
    // (Exa, then Tavily, then Linkup), so a single-key setup needs no decision.
    provider?: WebsearchProvider;
    // Domain scoping. Without these the only way to restrict a search is to
    // over-fetch and post-filter in the model's own context — the expensive way
    // to do what one request argument does server-side.
    includeDomains?: string[];
    excludeDomains?: string[];
    // ISO-8601 publication window, validated before the request is paid for.
    since?: string;
    until?: string;
    // Source category the provider may favour ("news", "company", "publication").
    category?: string;
    // "fast" asks for the provider's low-latency, lower-cost index mode; the
    // default "balanced" keeps the previous behaviour. A provider with no
    // equivalent simply ignores it.
    speed?: 'balanced' | 'fast';
};

// One normalized result. Every field is present (possibly empty) so the model
// sees a stable shape regardless of provider. `snippet` is the provider's
// highlight/content excerpt, truncated and treated as untrusted data.
export type WebSearchMatch = {
    title: string;
    url: string;
    snippet: string;
    // True when `snippet` was cut at the character bound rather than ending at the
    // source's own end. Present only when true. A cut snippet and a complete one
    // otherwise look identical, and the difference is whether to `fetch` the page.
    snippetTruncated?: boolean;
    // Provider-reported publication date, when it sends one.
    published?: string;
};

export type WebSearchResult = {
    provider: WebsearchProvider;
    query: string;
    // The count actually requested from the provider, after clamping.
    maxResults: number;
    results: WebSearchMatch[];
    // The filters that were applied, echoed back. An empty result set means
    // something different when a domain or date filter was in force, and without
    // this a model cannot tell "nothing exists" from "my filter excluded it".
    includeDomains?: string[];
    excludeDomains?: string[];
    since?: string;
    until?: string;
    category?: string;
    speed?: 'balanced' | 'fast';
};

// ---------------------------------------------------------------------------
// fetch — one model-facing page-fetch tool (W4).
//
// `native` is ALWAYS the default provider and needs no credential: it is a
// bounded GET with global `fetch`, a text-only content-type gate, and a
// dependency-free HTML-to-markdown/text conversion. `exa` and `linkup` are
// optional per-call providers, offered only when that provider's key exists
// (the same EXA_API_KEY / LINKUP_API_KEY search resolves) and named after
// Exa's /contents and Linkup's /v1/fetch endpoints. Tavily is search-only.
//
// Cross-references:
//   - tools/webfetch/index.ts  — createWebFetchTool, the per-harness factory
//   - harness.ts               — `webfetch` configuration field wiring
// ---------------------------------------------------------------------------
export type WebFetchProvider = 'native' | 'exa' | 'linkup';

export type WebFetchConfiguration = {
    // Environment snapshot to read EXA_API_KEY / LINKUP_API_KEY from. Tests and
    // deployments can inject one; the default is `process.env` (never a dotenv
    // autoload — the caller owns that). With no key at all the tool still
    // exists: `native` is the default provider and needs no credential.
    env?: Readonly<Record<string, string | undefined>>;
    // Explicit Exa key override (string or getter, resolved once at
    // construction). Omitting it entirely means "read the environment"; an
    // explicit blank value or a getter that yields nothing leaves `exa`
    // unoffered WITHOUT falling back to the environment.
    exa?: WebsearchProviderConfiguration;
    // Linkup key override for the `linkup` page-read provider (R1). Same
    // credential shape as `exa`: an explicit string or getter, otherwise
    // LINKUP_API_KEY from the resolved environment. A provider with no usable
    // key is absent: not offered in the schema and not callable. Resolution and
    // the wire adapter belong to tools/webfetch.
    linkup?: WebsearchProviderConfiguration;
    // Resolved-address SSRF gate (F5). By default the native provider resolves
    // the host and re-applies the private-address check to the ANSWER, which
    // closes the hole a URL-spelling check cannot: `169-254-169-254.nip.io` is a
    // public name whose A record is the cloud metadata IP.
    //   `lookup` — inject a resolver (tests, or a runtime without node:dns).
    //   `off: true` — skip the gate and keep spelling-only validation.
    // The gate is fail-open: a resolver that errors, hangs, or is unavailable
    // never turns into a "this URL is private" verdict.
    dns?: {
        lookup?: (hostname: string) => Promise<string[]>;
        off?: boolean;
    };
};

// The model-facing argument shape. `url` is the only required property; having
// more than one property keeps the object wrapper intact (see the single-property
// rule in core/tool.ts), and every optional field is validated in execute.
export type WebFetchParameters = {
    url: string;
    // Output format. Defaults to "markdown". A non-text content type is
    // REFUSED (that is the `download` tool's job); any other textual body is
    // returned as-is regardless of this field.
    format?: 'markdown' | 'text' | 'html';
    // Which provider to use. Omitted = "native"; "exa" and "linkup" are only
    // accepted (and only offered in the schema) when that provider's key is
    // configured.
    provider?: WebFetchProvider;
    // Optional section filter (the fetch+grep mode): a case-insensitive literal
    // phrase, matched against section headings and text — NOT a regular
    // expression, because the argument is a phrase a model types from memory and
    // an unescaped `(` must not become a syntax error. When it matches, only those
    // sections are returned instead of the whole document. It runs on converted
    // content, so it works for every provider, all of which answer with
    // heading-bearing text.
    query?: string;
    // Character offset to start reading at, for resuming a cut page with the
    // `nextOffset` the result reported. Clamped to the page rather than rejected:
    // reaching slightly past the end is a question with an answer, not an error.
    offset?: number;
};

export type WebFetchResult = {
    provider: WebFetchProvider;
    // The URL actually fetched, after redirects.
    url: string;
    // The response content-type header, verbatim (bounded).
    contentType: string;
    format: 'markdown' | 'text' | 'html';
    // Characters of `content` returned, after every bound.
    characters: number;
    // True when content was cut and MORE EXISTS: computed against the source, so
    // a page that ends exactly at a bound is not mistaken for a complete one.
    truncated: boolean;
    // The page content: converted text, untrusted data from the open web.
    content: string;
    // Page title when either source can provide one.
    title?: string;
    // Characters the page holds in total (before any bound). Lets a caller tell a
    // complete short page from a long one that was cut.
    pageCharacters?: number;
    // The offset this window ACTUALLY started at. Normally the argument; when the
    // argument was past the end of the page it is the clamped value, and
    // `offsetClamped` says so. Echoed so a caller paging a document always knows
    // where it is.
    offset?: number;
    // True only when the requested `offset` was past the end and had to be pulled
    // back. Without this, an overshoot looked identical to an empty page.
    offsetClamped?: boolean;
    // Character offset of the NEXT page of this page. Present only when
    // `truncated` is true, so resuming is a fact from the tool rather than a
    // guess about where the cut landed.
    nextOffset?: number;
    // Redirect hops followed, present only when the chain was not empty.
    redirects?: number;
    // Echoed back when the call used section selection, so a transcript reader
    // can tell a filtered answer from a whole page.
    query?: string;
    // Sections returned / sections the page has / sections that matched in total
    // (the last one exceeds `matches` when the block cap dropped some). Present
    // only in query mode.
    matches?: number;
    totalSections?: number;
    totalMatches?: number;
    // How a query answer was produced. 'heading' = the section filter worked as
    // documented. 'proximity' = the page has no heading structure, so the answer
    // is a text window around the first match rather than a section, and the
    // caller should not read it as a precise structural hit.
    matchMode?: 'heading' | 'proximity';
    // A plain-language pointer attached when a behaviour needs explaining: an
    // offset that was clamped, or a query that degraded to proximity. Cheap to
    // ignore, and cheaper than a wasted turn.
    note?: string;
};

// ---------------------------------------------------------------------------
// download — core file retrieval with multimodal hand-off (R3/R4)
//
// One model-facing tool, `download`. It fetches ANY http(s) resource as BYTES
// (images, PDFs, audio, video, archives, documents, binaries), refuses anything
// over its 20 MiB cap before the body is paid for, and returns the file through
// the `toolMedia()` envelope so the bytes reach the model as real multimodal
// input rather than as a filename inside truncated text.
//
// Cross-references:
//   - tools/webdownload/download.tool.ts — the preset entry (the implementation)
//   - core/tool-media.ts                 — the envelope + validation profiles
//   - shared/attachments.ts              — DOWNLOAD_ATTACHMENT_LIMITS (20 MiB)
//   - transport/openai.ts                — tool media -> labelled user parts
// ---------------------------------------------------------------------------
export type DownloadParameters = {
    // Absolute http(s) URL. Credentials in the URL (userinfo) are rejected, as
    // they are for `fetch`: they would put a secret on the wire.
    url: string;
    // Optional plain filename for the provider's file label. Sanitized either
    // way (no path separators, no drive colon, at most 200 characters), so a
    // model-supplied value can never smuggle a path.
    name?: string;
    // Optional destination for the saved copy, relative to the working directory.
    // Absolute paths and `..` are REFUSED rather than normalized: the tool
    // documents a session folder, and silently writing to /etc because a model
    // guessed an absolute path is worse than an error. Omitted = the default
    // .underload/downloads/ folder, where glob, grep and read can reach the file.
    path?: string;
};

// The MODEL-FACING summary. Deliberately small (a few hundred bytes): the file
// itself travels on the tool message's `attachments`, never inside this value,
// so the 64 KiB tool-result budget never touches it.
export type DownloadResult = {
    // The URL that was requested, normalized.
    url: string;
    // Where it actually landed after redirects.
    finalUrl: string;
    // The response content type, parameters stripped and lowercased (bounded).
    // Empty when the host sent no header — `application/octet-stream` is then
    // what the attachment carries.
    contentType: string;
    // How the bytes are represented to the model. `file` is the fallback for
    // every content type the known-media tables do not claim.
    kind: HarnessAttachment['kind'];
    // The sanitized filename the provider part labels the file with.
    name: string;
    // Bytes actually transferred (equals the stored attachment's `size`).
    bytes: number;
    // The server's declared `content-length` when it sent one. Present or
    // absent, and it is what distinguishes a pre-rejected oversize response
    // from one caught while streaming.
    declaredBytes?: number;
    // Constant: the file's bytes are attached out of band. It exists so a
    // transcript reader can never mistake this JSON for a filename-only answer.
    media: 'attached';
    // True when the bytes were also written to disk, so glob/grep/read can reach
    // the file. False on a host with no writable filesystem — the download itself
    // still succeeded and the bytes are still attached.
    saved?: boolean;
    // Where it was saved, RELATIVE to the working directory (what the file tools
    // resolve against). Present only when `saved` is true.
    path?: string;
    // Why the disk copy failed, when it did. A short reason, never a stack.
    saveError?: string;
    // Whether the saved copy is actually searchable by `grep` (text MIME and
    // within grep's own 1 MiB file limit). False means the file is addressable by
    // path but a grep over it returns nothing — the model should use `read` on a
    // text file or treat a media file as attached input instead.
    searchable?: boolean;
    // The id the attachment travels under on this tool message. The progress
    // event's `media` descriptor and the tool message agree on it; only the
    // transport may re-suffix it (deterministically) when one tool block
    // aggregates several downloads whose ids would otherwise collide.
    mediaId: string;
};

// ---------------------------------------------------------------------------
// Harness (the execution loop)
// ---------------------------------------------------------------------------

// Identity of ONE non-root invocation (T3 UI threads). A client groups every
// event of one subagent run into a row by `id`, indents it under `parentId`, and
// anchors it to the tool call that started it (`callId`).
//
// Contract (frozen additive shape):
//   - emitted for NON-ROOT runs only; a root run is the turn itself and its
//     events keep their historical shape (no `thread`);
//   - `id` is stable for the whole invocation and unique within the owning
//     SessionTurn (the run sequence is monotonic), so two sequential
//     delegations to the SAME agent get different ids;
//   - `parentId` is omitted for a direct child of the root and set to the
//     parent invocation's thread id for anything deeper;
//   - `callId` is the parent tool call that spawned this run;
//   - `input` (the child prompt, for a row title/body) appears on the `start`
//     event only; later events carry the identity fields alone.
export type HarnessThread = {
    id: string;
    parentId?: string;
    callId?: string;
    input?: string;
    // N3: what spawned this NON-ROOT invocation.
    //   - 'delegation' — an ordinary delegate / ctx.run child;
    //   - 'fork'       — a threadFork branch that reads the owner history;
    //   - 'autoanswer' — a tool-free owner fork answering an actionRequest.
    // Omitted for historical recorded turns (they predate this field) and may be
    // omitted by a hand-written reporter, so readers must not require it.
    kind?: 'delegation' | 'fork' | 'autoanswer';
    // Branch identity for a fork/autoanswer thread. Absent for a delegation
    // thread and for every pre-branch recorded event. This is the SAME id the
    // branch events and `harness.branch(id)` use; a thread does not invent a
    // second naming scheme.
    branchId?: string;
};

// ---------------------------------------------------------------------------
// Persistent agent threads (R2)
// ---------------------------------------------------------------------------
//
// TERMINOLOGY (R1). `HarnessThread` above is INVOCATION identity: one row per
// non-root RUN, and its id changes every time an agent is invoked. A
// `HarnessThreadRecord` is the PERSISTENT conversation that owns those runs:
//
//   harness   — provides callable agents (the execution loop);
//   session   — server-controlled shared memory (one harness + snapshot/restore);
//   thread    — a persistent, agent-owned conversation with its own transcript,
//               stable id, and independent execution slot.
//
// Every configured agent has a DEFAULT thread (`agent:<name>`) whose transcript
// is the registry Agent's `messages`; a ROOT delegation keeps writing there, so
// legacy behaviour is preserved. `createThread` opens an ADDITIONAL independent
// conversation (a fresh Agent instance) for the same agent, which is what makes
// same-agent concurrent threads real instead of serialized.
//
// R4: a delegation/ctx.run child OF A HOST THREAD is itself a NEW host thread
// (own transcript and id, `ownerThreadId` = the calling conversation) instead of
// the child agent's default conversation. Two parents that target the same child
// agent therefore get two separate child threads with no shared transcript, even
// when they run concurrently. Such a child is a normal host thread: it is
// listed, stopped, deleted, and persisted through the same APIs.
//
// The id is runtime-generated and opaque; it is stable for the thread's whole
// life (including across snapshot/restore) and never derived from model input.
export type HarnessThreadOrigin = 'agent' | 'host';

// 'running' means a run is active in this thread. 'stopped' means the host
// halted it: no new run is started for it and AGENTS may not post into it until a
// host resumes it through sendThreadInput (or deletes it).
//
// R2/R3 plugins: 'paused' is a THIRD, plugin-owned state. A lifecycle hook runs at
// a turn boundary (`turn.before`), so a plugin that needs the conversation to stop
// moving while it does work — compaction, a human gate, a budget park — marks the
// thread 'paused' and resumes it before the hook returns. The RUN itself keeps
// executing (the hook is awaited), so 'paused' is an OBSERVABLE pause at a turn
// boundary, not a suspension of the process. A plugin that pauses and never resumes
// leaves the thread parked: the run's finally-block only clears 'running', and the
// next explicit host `sendThreadInput` revives a parked conversation exactly like a
// stopped one — and an agent's `threadSend` lifts the park through that same
// `resumeThreadState` path before starting a turn in it (delegate-stress T3.2),
// which is the difference from `stopped`: a park is not the host's intent, so a
// message may clear it and a stop may not. 'paused' is NEVER persisted — snapshot()
// maps it to 'idle' (a parked thread has no live run after a restart), which is why
// HarnessThreadSnapshot keeps its narrower 'idle' | 'stopped' union.
export type HarnessThreadStatus = 'idle' | 'running' | 'paused' | 'stopped';

export type HarnessThreadRecord = {
    id: string;
    // The registry agent that owns this conversation. Threads never change owner.
    agent: string;
    // 'agent' = the agent's default conversation; 'host' = an extra thread opened
    // with `createThread`.
    origin: HarnessThreadOrigin;
    status: HarnessThreadStatus;
    // Monotonic per harness (creation order). Deliberately not a wall-clock time,
    // so ordering is deterministic in tests and after a restore.
    sequence: number;
    // The persistent parent thread that spawned/owned this one (a delegated child
    // links to its requester). Absent for a thread created at the top level.
    ownerThreadId?: string;
    // Display-only label from createThread. Grants no authority.
    label?: string;
    // Invocation id of the LATEST run in this thread, so a client can join the
    // persistent record to the `HarnessThread.id` carried by its events and to
    // `agentResult`. Absent until the thread has run once.
    invocationId?: string;
};

export type HarnessThreadCreateOptions = {
    // Optional display label (trimmed, max 120 characters).
    label?: string;
    // Persistent parent thread to link as the owner. Must already exist, and it
    // must be a HOST thread (`createThread`): an agent's default conversation is
    // implicit and is never persisted as a thread record, so it cannot be an
    // owner (the resulting snapshot could not be restored). The runtime derives
    // this link itself for delegated children; a host uses it to attach a thread
    // it opened on behalf of another conversation.
    ownerThreadId?: string;
};

// The answer to a steering attempt. Steering is only meaningful while a run is
// active: the text is queued and applied at the next safe model boundary (never
// inside an in-flight request), so `queued: false` explains why nothing happened.
export type HarnessThreadSteerReceipt = {
    threadId: string;
    queued: boolean;
    reason?: string;
};

// The result of the `threadList` tool (R4): the live conversations of THIS
// session, newest last (creation order). Ids are observed here, never invented;
// a deleted thread is absent by construction. `currentThreadId` is the caller's
// own persistent thread, supplied by the runtime (undefined for a manual
// executeTool call).
export type HarnessThreadRoster = {
    currentThreadId?: string;
    threads: HarnessThreadRecord[];
};

// The result of the `threadSend` tool (cross-thread chat, R4). The SENDER is
// derived from the calling run's identity by the runtime — the model cannot name
// itself — while `threadId` is the target conversation.
export type HarnessThreadMessageResult = {
    threadId: string;
    // STATE-AWARE delivery (delegate-stress T3.2/T3.6). `threadSend` used to report
    // the same bare word for a message that changed a live run and one that only
    // sat in a transcript, and that ambiguity is what the finding was built on; each
    // value below names one outcome, and each is reachable in
    // src/harness.thread-runtime.test.ts. A `stopped` target is neither: it throws.
    //
    // 'queued'  — the target was RUNNING. The message joins the live run's queue and
    //   is applied as a user message at its next safe model boundary (never inside
    //   the request already in flight). No new run was started.
    // 'started' — the target was DORMANT: `idle`, or `paused` by a plugin and resumed
    //   here. A run has been STARTED with the attributed message as its prompt. The
    //   receipt is non-blocking: it reports the start, not the answer, and the run
    //   may still fail afterwards (its failure is reported to the harness listeners
    //   and archived for `agentResult`, not to this sender).
    //
    // 'appended' is RETIRED: nothing is ever parked in a transcript without a run to
    // read it, which was the inert delivery this finding reported.
    delivered: 'queued' | 'started';
    // The agent name the runtime attributed the message to.
    sender: string;
    // The sender's persistent thread id, when the sender ran inside one.
    senderThreadId?: string;
};

// Every event variant carries the SAME optional field (spelled out per variant so
// `HarnessEvent` stays a plain discriminated union: `Extract<HarnessEvent, {type:
// 'x'}>` and `event.type` narrowing keep working for clients). Optional because
// root events and older recorded turns have none, and a hand-written reporter may
// omit it.
//
// Progress events. Every one names its agent so a multi-agent run stays readable
// in a single console stream. This is the whole reporting surface: a UI or a
// `console.log` sees exactly the steps below. `thread` is present only for
// NON-ROOT runs; see HarnessThread.
export type HarnessEvent =
    | { type: 'start'; agent: string; model: string; thread?: HarnessThread }
    | { type: 'text'; agent: string; delta: string; thread?: HarnessThread }
    | { type: 'reasoning'; agent: string; delta: string; thread?: HarnessThread }
    | { type: 'tool_call'; agent: string; call: HarnessToolCall; thread?: HarnessThread }
    // `callId` is the id of the tool_call this result answers. Optional so an
    // older recorded event (or a hand-written progress reporter) stays valid, and
    // so a same-name pairing in a UI can be exact instead of positional.
    | {
          type: 'tool_result';
          agent: string;
          name: string;
          callId?: string;
          content: string;
          // Derived projection of `outcome` for consumers that only need "is this
          // an error-shaped tool message". Always `outcome !== 'completed'`.
          isError: boolean;
          // Structured reason this call ended (HarnessToolOutcome). Optional so an
          // older recorded event — or a hand-written progress reporter — stays
          // valid; a reader then falls back to `isError` (error-shaped without a
          // classification reads as `failed`). Every result the runtime produces
          // carries it, which is what lets a UI show a cancelled call as
          // "cancelled" instead of "error".
          outcome?: HarnessToolOutcome;
          // Optional declarative panels a tool supplied with `toolUi()`. The
          // `content` above is always the underlying value, and the model never
          // sees this field: it is presentation data for the client only. Absent
          // for every ordinary tool, so recorded events keep their old shape.
          ui?: ToolUiPanel[];
          // Files a tool attached with `toolMedia()` (see ToolMediaEnvelope).
          // DESCRIPTORS ONLY — id/kind/name/mime/size, never the base64 —
          // because every event is JSON round-tripped and persisted through the
          // turn record (server/sessions.ts `copyEvent`), so multi-megabyte
          // payloads here would be paid once per delivered call. The bytes live
          // exactly once, on the committed `tool` message. Absent for every
          // medialess tool, so recorded events keep their old shape.
          media?: ToolMediaDescriptor[];
          // Wall-clock duration of the call, measured from launch to delivery.
          // Present for every EXECUTED call (including one that settled in the same
          // turn; an inline call is a real sub-millisecond measurement, not a
          // different kind of call). An immediate validation failure never reached
          // execution and has no duration; a control result such as toolCancel
          // reports its zero span explicitly.
          durationMs?: number;
          // Tool calls that were STILL RUNNING for this agent when this result was
          // delivered. Absent when none remain, so a run with no background work
          // keeps its historical event shape. Elapsed times let a UI show progress
          // without polling.
          pending?: HarnessPendingTool[];
          // Invocation identity of the (non-root) agent whose call this answers.
          thread?: HarnessThread;
      }
    // Per-request token accounting, emitted once for EVERY model request a run
    // makes - including the tool rounds, pauses with pending work, and wake-driven
    // turns that keep the loop going. `done` reports the response too, but it may be
    // a PAUSED response (`pending` non-empty) or be omitted for a superseded one, so
    // the usage events - not `done` - are the complete cost record. Absent entirely
    // when the provider reported no usage for that request (a gateway that sends no
    // `usage` block); a run may therefore report some requests and not others.
    | { type: 'usage'; agent: string; usage: HarnessUsage; thread?: HarnessThread }
    // A model response. `pending` non-empty means the run is NOT terminal: those
    // calls are still running, the harness stays open, and their completions will
    // drive further turns. Absent when the response has no background work left,
    // so an ordinary answer keeps its old shape and its old meaning.
    //
    // A response that is immediately superseded by a completion which arrived
    // while its request was in flight emits no `done` at all (it was an
    // intermediate turn, like a tool-call turn), so `done` always describes a
    // response the consumer is meant to see.
    | {
          type: 'done';
          agent: string;
          message: HarnessAssistantMessage;
          pending?: HarnessPendingTool[];
          thread?: HarnessThread;
      }
    // A model-request retry (R1/R4). The agent retried the CURRENT request after
    // `attempt` failed (any HTTP status, a provider error frame, a malformed/
    // truncated stream, or a thrown network/midstream error); `delayMs` is the
    // backoff that precedes attempt `attempt + 1`. `error` is the failed attempt's
    // own message, preserved.
    //
    // R3: the retried attempt is DISCARDED. Text/reasoning/tool calls streamed
    // between the previous boundary (`start`/`retry`/`done`) and this frame belong
    // to the FAILED attempt: a consumer must not render them as part of the answer,
    // and no tool from them is ever executed (the agent never commits a failed
    // attempt, so the harness never sees its tool calls). Absent for a request that
    // succeeded on its first attempt, so an ordinary run keeps its old event shape.
    | {
          type: 'retry';
          agent: string;
          attempt: number;
          maxAttempts: number;
          delayMs: number;
          error: HarnessErrorInfo;
          thread?: HarnessThread;
      }
    // One model request SUCCEEDED (R3). Everything streamed since the previous
    // boundary (`start`/`retry`/`attempt_commit`/`done`) for this agent is
    // committed and final: a later `retry` belongs to a NEWER request and must not
    // discard it.
    //
    // This frame exists because `done` cannot mark that boundary: the harness emits
    // `done` only for a tool-free response, so a completed tool-calling round is
    // committed with no `done` at all. A consumer that only saw `retry`/`done`
    // therefore could not tell a committed tool round from abandoned output and
    // deleted it on the next retry. Absent from older recordings, where consumers
    // keep their historical `done`-only boundary behaviour.
    | {
          type: 'attempt_commit';
          agent: string;
          attempt: number;
          maxAttempts: number;
          thread?: HarnessThread;
      }
    // Recurring heartbeat while background calls are pending (R4): the configured
    // wake interval (default 600000 ms = 10 minutes) has elapsed. The run is
    // re-requested with the current pending list, so the model can inspect
    // elapsed times and cancel a hung call through `toolCancel`. This is a
    // PROGRESS event, not a transcript entry.
    | {
          type: 'wakeup';
          agent: string;
          reason: 'pending-tools';
          pending: HarnessPendingTool[];
          thread?: HarnessThread;
      }
    // N3: the model asked its owner a bounded question. `callId` is the
    // actionRequest tool call; `request` is already parsed and bounds-checked.
    | {
          type: 'action_request';
          agent: string;
          callId: string;
          request: HarnessActionRequest;
          thread?: HarnessThread;
      }
    // N3: an answer was recorded (owner or automatic). Emitted for every
    // accepted answer, including a custom one, so a client can resolve the
    // pending card without polling.
    | {
          type: 'action_answer';
          agent: string;
          requestId: string;
          answer: HarnessActionAnswer;
          thread?: HarnessThread;
      }
    // N3: a fork/autoanswer branch started. `branch` is the summary a client can
    // use before the branch transcript exists.
    | {
          type: 'branch_start';
          agent: string;
          branch: HarnessBranchSummary;
          thread?: HarnessThread;
      }
    // N3: a branch reached a terminal state. `error` is present for a failed or
    // cancelled branch, and absent for a completed one.
    | {
          type: 'branch_end';
          agent: string;
          branchId: string;
          status: HarnessBranchTerminalStatus;
          error?: HarnessErrorInfo;
          thread?: HarnessThread;
      }
    | { type: 'error'; agent: string; error: HarnessErrorInfo; thread?: HarnessThread };

export type HarnessProgress = (event: HarnessEvent) => void | Promise<void>;

// Optional persistence observer (R3a/T3 addendum). It fires AFTER a mutation that
// the snapshot below would record — agent history, discovery, created tools, the
// session record stores, reset, and restore — so a server can save without waiting
// for session close. It is deliberately NOT a second event stream: there is no
// ordering contract, no payload of changed data, and no replay. A callback that
// throws is ignored (see harness.ts), so a failing persistence layer can never
// change harness behaviour or turn a completed tool call into a failure.
//
// `reason` is a coarse hint for coalescing/debouncing a save; the authoritative
// state is always `harness.snapshot()`. The callback may call snapshot()
// synchronously, INCLUDING during an active run: it runs immediately after the
// mutation, so completed store changes and their tool-result message are captured
// together (T16).
//
// Observable gaps a caller must handle itself:
//   - direct `agent.user()/.assistant()/.model()` calls outside harness methods;
//   - `agent.messages` mutated by a tool or host code directly;
//   - text/reasoning deltas that are not committed to agent.messages yet (they are
//     progress events, not snapshot state; snapshot() never includes partial text);
//   - any mutation made before the callback was configured (take a snapshot).
// These are documented rather than papered over, because the harness cannot
// intercept its own public objects without wrapping them.
export type HarnessStateChangeReason =
    | 'agent_message'
    | 'tool_execute'
    | 'tool_create'
    // R2 thread lifecycle (create/stop/delete/steer) — a persistence observer
    // must save the thread records, not just the transcripts.
    | 'thread'
    | 'reset'
    | 'restore';

export type HarnessStateChangeEvent = {
    type: 'state_change';
    reason: HarnessStateChangeReason;
    // The agent whose history changed, when the reason names one.
    agent?: string;
    // The tool whose execution/create caused the change, when applicable.
    tool?: string;
    // N3: the branch whose transcript changed, when the change belongs to a
    // fork/autoanswer branch rather than to a root agent.
    branchId?: string;
};

export type HarnessRunOptions = {
    // Cancellation for this run. Forwarded to every model request, into each
    // tool's `ToolContext.signal` (a per-call controller linked to this one), and
    // to every run it causes (ctx.run and delegate) so a cancel reaches
    // subagents too (R10).
    //
    // The harness checks it BEFORE each model turn and before each tool call, so
    // an aborted run starts no new side effects. Background calls in flight are
    // aborted through their controllers; a tool that ignores the signal may keep
    // running, but its late result is discarded. The run fails, every actor's
    // history is truncated back to where its call started, and the error
    // propagates.
    signal?: AbortSignal;
    // Attachments for the ROOT user prompt of this run (T3 composer). Validated
    // before any history mutation; malformed input rejects the run untouched.
    //
    // Only the root prompt receives them: delegated children and ctx.run start
    // from their own text prompt, so a root's bytes are never re-sent with an
    // unrelated subagent request. The user message keeps `marker` labels inside
    // `content`; the transport maps them to multimodal parts.
    attachments?: HarnessAttachment[];
};

// ---------------------------------------------------------------------------
// Persisted core state (R3a)
// ---------------------------------------------------------------------------
//
// `harness.snapshot()` returns this shape and `harness.restore(snapshot)` applies
// it to a fresh harness built from the SAME definition (same agents, tools,
// primary, subagents, and policy). It is deliberately DATA ONLY:
//   - no provider configuration, API key, header, or other credential;
//   - no functions (transports, tool implementations, plugins, progress hooks);
//   - no live execution state (run stack, abort signal, in-flight turns).
// Everything here survives JSON.stringify/JSON.parse unchanged, which is what a
// server needs to write it to disk under DATABASE_ROOT.
//
// snapshot() is safe to take during an active run (T16): the value reflects the
// committed transcript, discovery, created-tool sources, and store state at that
// synchronous instant. Partial text/reasoning deltas are not included until the
// assistant message commits.
//
// `version` gates the schema. restore() rejects any other version rather than
// guessing; a newer/older snapshot is a migration problem, not a silent drop.
//
// v2 is the records-engine shape change (T3): `records` went from four sibling stores
// (`todos`, `profiles`, `chapters`, `locations`, each with its own id counter) to ONE
// collection map with a single store-level counter and a persisted definition per
// collection (F3, Decision M). R5 says nothing is in production, so no v1 reader is
// kept: a v1 file is refused by the version gate instead of half-migrated.
export type HarnessSnapshotVersion = 2;

// One agent's resolvable state. `messages` is the ENTIRE transcript (seeded
// instructions plus turns and tool results), and `model` is the model accessor's
// current value, so a resumed agent sends the same request on its next turn.
// The registry key is the agent identity; no name is duplicated inside.
export type HarnessAgentSnapshot = {
    model: string;
    messages: HarnessMessage[];
};

// One TERMINAL agent result persisted by snapshot v1 (R3 durability). Active
// (`running`) invocations are deliberately omitted: they have no answer yet, and
// fabricating one would misrepresent an in-flight run. A result is immutable once
// terminal, so this record is the minimum needed to rebuild the agentResult
// registry: identity, ordering, and the completed answer (or failure message).
//
// `status` excludes 'running' by construction. `error` is required for a
// failed/cancelled record and forbidden for a completed one.
export type HarnessAgentResultSnapshot = {
    invocationId: string;
    // Run sequence (the harness's monotonic run id). Restored as a high-water
    // mark so a future run can never reuse a persisted invocation id.
    sequence: number;
    // Monotonic completion order across the harness. Restored so a later
    // completion sorts after every archived one and "latest finished" stays
    // correct.
    completedOrder: number;
    agent: string;
    role: 'primary' | 'subagent';
    kind: 'root' | 'delegation' | 'fork' | 'autoanswer';
    status: 'completed' | 'failed' | 'cancelled';
    // Completed answer text; empty for failed/cancelled.
    content: string;
    // Failure/cancellation message. Required for a non-completed result, never
    // present on a completed one.
    error?: string;
};

// T5 lane-worker seam: ONE terminal invocation the coordinator archives on behalf of a
// conversation that ran on another thread (see `harness.archiveInvocation`).
//
// Identity fields come from the CALLER because the run happened elsewhere; the harness
// never invents them here. `completedOrder` may be omitted (the harness then takes the
// next free order), and every supplied value is only ever RAISED, so a lane cannot move
// the completion high-water mark backwards and an archived result can never sort before
// a result the harness produced itself.
export type HarnessInvocationArchiveInput = {
    invocationId: string;
    sequence: number;
    agent: string;
    role: 'primary' | 'subagent';
    kind: 'root' | 'delegation' | 'fork' | 'autoanswer';
    status: 'completed' | 'failed' | 'cancelled';
    // Completed answer text. Ignored (forced empty) for a failed/cancelled record.
    content?: string;
    // Failure/cancellation message; defaulted when a non-completed status omits it.
    error?: string;
    // Authority-leased completion order. Omitted means "take the next one".
    completedOrder?: number;
    // The persistent conversation this invocation ran in, when one owns it.
    threadId?: string;
};

// T5 lane-worker seam: reserve identity high-water marks in one harness (see
// `harness.reserveIdentity`). Every supplied value only ever RAISES the matching counter,
// and the call returns the ACTUAL counters afterwards.
//
// This is how an authority-issued identity lease lands in a lane replica: a replica mints
// run and thread ids from its own counters, so without a reservation two replicas rebuilt
// from one snapshot would mint the same identity for different work.
export type HarnessIdentityReservation = {
    runSequence?: number;
    threadSequence?: number;
    threadIdSequence?: number;
    invocationCompletionSequence?: number;
};

// One HOST thread persisted by snapshot v1 (R2). The agent's DEFAULT thread is
// deliberately absent: its transcript is `agents.<name>.messages`, and its id is
// derived from the agent name (`agent:<name>`), so persisting it would duplicate
// state. Only threads opened with `createThread` carry their own transcript.
//
// `status` excludes 'running' by construction: a snapshot never claims that a run
// is live after a restart. 'stopped' is durable (a host stopped this conversation
// before the snapshot was written).
export type HarnessThreadSnapshot = {
    id: string;
    agent: string;
    status: 'idle' | 'stopped';
    sequence: number;
    ownerThreadId?: string;
    label?: string;
    invocationId?: string;
    // The thread's committed transcript. Required (a host thread's history lives
    // nowhere else), and restored into a fresh Agent seeded from the owner's
    // configuration.
    messages: HarnessMessage[];
};

// One progressive-discovery cursor (R12). `query` is the opaque normalized query
// key the harness already uses (JSON [tags, limit]); it is persisted verbatim so
// repeating a query after a restart continues the same tranche.
export type HarnessDiscoveryOffsetSnapshot = {
    query: string;
    offset: number;
};

// Everything a snapshot records. Creation ORDER is preserved in `createdTools`
// (registry order affects declarations), and ids remain stable because each
// record store carries its own nextId.
export type HarnessSnapshot = {
    version: HarnessSnapshotVersion;
    // Keyed by registry name. Every configured agent must appear (restore checks
    // both directions when the snapshot is applied).
    agents: Record<string, HarnessAgentSnapshot>;
    discovery: {
        // Enabled searchable tool names, newest selector match first, then retained
        // prior entries. Capped at maxEnabledTools by the harness; restore trims an
        // over-cap list from the end.
        enabled: string[];
        // Per-query offsets for progressive discovery; empty when no query has a
        // continued tail.
        offsets: HarnessDiscoveryOffsetSnapshot[];
    };
    // Tools created at runtime (host `createTool` or the model's toolCreate).
    // `source` is retained and RECOMPILED on restore through the existing
    // trusted-source path; restoring never executes it. Configured/preset tools
    // are owned by the harness definition and are not recorded here (they carry
    // function implementations that cannot be serialized).
    createdTools: ToolCreation[];
    // Lifetime creation budget already spent. Equals createdTools.length in a
    // snapshot this harness produced; restore validates it and refuses a count
    // the target's maxCreatedTools cannot hold.
    createdToolCount: number;
    // R3 durability: terminal agent results, bounded to AGENT_RESULT_RETENTION
    // (64). OPTIONAL on purpose: pre-feature snapshots have no field and restore
    // them with an empty registry, and a snapshot with no terminal results omits
    // the field so older fixtures/tests keep their exact shape. Running
    // invocations are omitted (never written as a partial/cancelled answer).
    agentResults?: HarnessAgentResultSnapshot[];
    // R2 persistent threads. OPTIONAL and OMITTED while this harness has only its
    // implicit per-agent default conversations, so pre-thread snapshots and every
    // fixture that never called createThread keep their exact prior shape.
    // Present (possibly empty, after every host thread was deleted) once the
    // harness has minted at least one host thread id, so `threadSequence` remains
    // a high-water mark and a restart cannot reuse a deleted thread's id.
    threads?: HarnessThreadSnapshot[];
    // High-water mark for generated host thread ids. Present together with
    // `threads`; restore validates it against the persisted records.
    threadSequence?: number;
    // The ONE session store (records-engine T3): a collection map with a global id
    // counter, replacing snapshot v1's four sibling sections (`records.todos`,
    // `records.profiles`, `records.chapters`, `records.locations`). Definitions
    // persist with their entries (Decision M) so a collection an agent `define`d is
    // rediscovered after a restart. The shape change is why
    // `HARNESS_SNAPSHOT_VERSION` moved: R5 states nothing is in production, so no v1
    // migration is written — a v1 file is refused by the version gate rather than
    // half-read.
    records: RecordsStoreState;
};

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
//
// A command is a NAMED, SERVER-SIDE operation a host invokes with a slash line
// (`/task add "testing"`), not a prompt for the model. The harness owns the
// registry so every front end (CLI, HTTP server, UI composer) executes the same
// implementation, and `executeCommand` never spends a model request.
//
// The parser and the built-in set live in core/command.ts and
// core/command-builtins.ts; this file only carries the wire types so a host can
// type its own contributions. Commands are NOT tools: a tool is declared to the
// model and schema-validated, a command is invoked by an operator and receives
// the raw tokenized line. A built-in may still call a tool internally through
// `context.harness.executeTool(...)` (that is how /task, /websearch and
// /webfetch work), which is why the tool names are quoted there rather than
// duplicated as a second source of truth.

// What a command implementation is handed. `name`/`args`/`rest` come from the
// shared parser (core/command.ts), so quoting and escaping behave identically
// for every command and every host.
export type HarnessCommandContext = {
    // The LIVE harness handle, so a command can read the registries and call
    // tools exactly like a host would (`harness.executeTool('task', {})`).
    harness: Harness;
    // Command name WITHOUT the leading slash, lowercased by the parser.
    name: string;
    // Tokenized arguments: whitespace-separated, quotes removed, escapes
    // resolved, case preserved. An explicit `""` is an empty argument.
    args: readonly string[];
    // Raw trimmed text after the command name (pre-tokenized). Commands that
    // take free-form text (/websearch) use this; commands with structured
    // arguments use `args`.
    rest: string;
    // The full original input line, verbatim, for echo/logging.
    input: string;
};

// What a command returns. `content` is always displayable text; `isError` marks
// a recoverable usage/provider failure so a host can style it without parsing
// prose; `data` carries the structured value for a host that wants it (a CLI
// ignores it, a UI may render a table).
export type HarnessCommandResult = {
    content: string;
    isError?: boolean;
    data?: unknown;
};

// One registered command. Names are validated against COMMAND_NAME_PATTERN in
// core/command.ts, so a registry key is always `/`-safe and lowercase.
export type HarnessCommand = {
    // Registry key: `/name` is what the parser resolves. Must match
    // /^[a-z][a-z0-9-]{0,31}$/.
    name: string;
    // One-line summary shown by /help and /help <name>.
    description: string;
    // Optional argument template shown by /help (e.g. '/task add <text>').
    usage?: string;
    // Runs the command. May be sync or async; a thrown error is not wrapped
    // into a result, so a recoverable failure should come back as
    // `{ content, isError: true }` instead.
    execute: (context: HarnessCommandContext) => Promise<HarnessCommandResult> | HarnessCommandResult;
};

// A command as declared in `HarnessConfiguration.commands` or added through a
// plugin. Same shape, optional `name` (the registry validates/fills it).
export type HarnessCommandConfiguration = Omit<HarnessCommand, 'name'> & { name?: string };

export type HarnessConfiguration = {
    // Every brain the harness can run, keyed by name. The FIRST entry is the
    // entry point unless `primary` names another one: `writer(...)` runs that
    // agent, and the rest are reachable from tools through `ctx.run(name, input)`
    // or the `delegate` tool the primary agent gets.
    agents: Record<string, Agent>;
    // Which agent the callable runs. Defaults to the first entry of `agents`, so
    // a single-agent config needs nothing. Must name a registered agent.
    primary?: string;
    // Agents the primary agent may delegate to. Defaults to every agent except
    // the primary. When the list is empty there is no delegation at all and the
    // `delegate` tool is not registered. Subagents never receive it, so
    // delegation is one level deep by construction.
    subagents?: readonly string[];

    // Maximum number of MODEL REQUESTS (turns) one agent run may make before the
    // harness treats it as a runaway loop: history is truncated back to the start
    // of the call and the harness throws. Defaults to 16, the library guard. Must
    // be a positive safe integer; validated at construction so a typo fails before
    // a long run. There is no "unlimited" value. The same bound applies to every run
    // in this harness (entry, ctx.run, and delegated subagents); each run gets its
    // own budget.
    //
    // With background tool calls this counts EVERY request, not just tool rounds:
    // a pause (`done` with pending work) and a wake-driven request each consume
    // one. A run that never answers and keeps spawning work is still bounded; on
    // exhaustion the pending work is aborted and the transcript rolled back rather
    // than left orphaned. The bundled application presets set 1000 for real work -
    // see harnesses/presets.ts.
    maxIterations?: number;

    // Who may create tools at runtime (R12). Defaults to 'all', the historical
    // behaviour:
    //   - 'all'     — every agent (primary and subagents) gets toolCreate;
    //   - 'primary' — only the primary agent gets it. The tool is not declared to
    //                 subagents and a guessed call is rejected, so a subagent can
    //                 neither see nor use creation;
    //   - false     — no model-facing toolCreate at all (a session without it
    //                 answers an honest "not registered" error). The HOST path
    //                 `harness.toolCreate()` still works: an operator action is
    //                 not a model privilege.
    // The lifetime creation budget (`maxCreatedTools`) still applies either way.
    toolCreation?: ToolCreationPolicy;

    // How often (milliseconds) a run with background tool calls emits a `wakeup`
    // and gets another model turn so it can inspect pending elapsed times and may
    // cancel a hung call (R4). Defaults to 600000 (10 minutes). Configurable so
    // tests need not wait ten minutes; must be a positive safe integer.
    //
    // R4 moved the timer out of the scheduler and into the shipped `async-ping`
    // plugin: this field is that plugin's `intervalMs` DEFAULT (seeded into the
    // plugin settings provider) and is also readable as `api.config.wakeIntervalMs`.
    // A `pluginSettings` provider that stores `async-ping.intervalMs` wins over it.
    // The ping still exists ONLY while calls are pending, and its timer is cleared
    // when the board drains.
    wakeIntervalMs?: number;

    // How many tools this harness instance may create over its LIFETIME.
    // Defaults to 32 (DEFAULT_CREATED_TOOLS_LIMIT in core/creation.ts).
    //
    // Lifetime, not per-turn: created tools stay registered after reset(), so
    // reset() does NOT restore this budget — restoring it would let a session
    // grow the registry without bound one reset at a time. Must be a positive
    // safe integer; validated at construction.
    maxCreatedTools?: number;

    // Every tool the harness can run. Keyed by the name the model calls. Only
    // `visibility: 'core'` tools are declared up front; the rest are found
    // through the built-in toolRequest tool and enabled for the next turn.
    tools?: Record<string, Tool>;
    // Independently compiled source entries, keyed by wire name. Semantics:
    //   - each value is a source path accepted by the kernel's shared compiler
    //     (package-source-relative, e.g. `server/tools/shared/foo.tool.ts`, or
    //     absolute);
    //   - registrations commit after the baseline core/preset set and BEFORE
    //     `tools` overrides, so a configured Tool of the same name wins;
    //   - the installed revision is inspectable through `harness.toolSource()`
    //     and is replaceable like every other registration.
    // This is the application/extracted-tool integration point: a host does not
    // need to prebuild a Tool or pass a definition through a fake compiler path.
    // Virtual dependencies are not expressible here (the path's real local
    // imports are captured); use `harness.registerTool({ moduleText, dependencies })`
    // for an in-memory revision.
    toolSources?: Record<string, string>;
    // Ordered external folders of editable `*.tool.ts` modules. Each entry is an
    // absolute path or a path relative to the process cwd; missing/non-directory
    // entries fail construction. Discovery is recursive and deterministic (folder
    // order, then relative path). Modules publish through the normal registration
    // kernel, so a later folder (and a later file within one folder) wins a name
    // collision. Loading/executing folder code is TRUSTED CODE with this process's
    // permissions - there is no sandbox.
    //
    // toolManage disk writes are fenced to these folders; no other path is writable.
    // Source compilation is Node-only, so a browser harness with toolFolders fails
    // with an actionable error instead of silently ignoring them.
    toolFolders?: string[];
    // Bound on how many SEARCHABLE tools this harness may have enabled at once.
    // Core tools are always declared and never count. Defaults to 32 (the previous
    // design capped one toolRequest call at 5 but accumulated without a global
    // bound; 32 keeps the catalogue from flooding context while allowing one query
    // to surface a useful set). Must be a positive safe integer. This is a bound on
    // the enabled set, NOT a cap on selectTools matches: toolRequest reports/omits
    // nothing artificially beyond this configured bound.
    maxEnabledTools?: number;
    // Preload the bundled preset catalogue (src/tools/) into the registry. True by
    // default: discovery exists so a large catalogue costs nothing until it is
    // asked for. Set false to start from `tools` alone. A configured tool wins on
    // a name collision.
    presets?: boolean;
    // Opt-in web search. `true` reads EXA_API_KEY / TAVILY_API_KEY /
    // LINKUP_API_KEY from this process's environment and registers one core
    // `search` tool (default provider follows the exa > tavily > linkup
    // preference order, `provider` overrides per call); an object does the same
    // with an injected env or explicit key overrides. Off when absent or false,
    // and absent when no key resolves — so a default harness never carries a
    // network tool it cannot use. Secrets stay in the constructed tool closure:
    // no schema value, argument, result, or event carries them. A configured
    // tool named `search` wins over this field.
    websearch?: boolean | WebsearchConfiguration;
    // Opt-in page fetch (W4). `true` (or a configuration object) registers the
    // `fetch` tool: a bounded, text-only native GET that needs no credential and
    // is ALWAYS the default, plus the hosted `exa` / `linkup` per-call providers
    // when EXA_API_KEY / LINKUP_API_KEY (or an explicit key) is available.
    // Unlike `websearch`, this tool is registered even with no key at all,
    // because its default provider is keyless. Off when absent or false. A
    // configured tool named `fetch` wins over this field.
    webfetch?: boolean | WebFetchConfiguration;
    // N3 fork/branch bounds and the threadFork capability. Omitted = threadFork
    // is not registered and no branch may be created. Values are validated at
    // construction against the frozen defaults in core/branch.ts.
    forks?: HarnessForkConfiguration;
    // N3 owner interaction. Omitted = actionRequest is not registered.
    interaction?: HarnessInteractionConfiguration;
    // Reporting hooks. `progress` is awaited for every step, so a slow UI can
    // pace the run, and a `console.log` can just print.
    report?: {
        progress?: HarnessProgress;
        // Persistence observer (R3a). Synchronous and advisory: it runs after a
        // snapshot-recorded mutation so a server can schedule a save. Errors
        // thrown by it are ignored. See HarnessStateChangeEvent for what it does
        // and does not cover.
        stateChange?: (event: HarnessStateChangeEvent) => void;
        // Plugin diagnostics (T1.5). Synchronous and advisory, exactly like
        // `stateChange`: errors thrown by it are ignored, and it can never fail a run.
        // This is the channel that makes a BROKEN plugin visible — before it existed,
        // a handler that threw, timed out, or returned an unparseable decision was
        // dropped silently, so "the plugin is broken" and "the plugin decided to do
        // nothing" looked identical from outside. See HarnessDiagnosticEvent.
        diagnostic?: (event: HarnessDiagnosticEvent) => void;
    };
    // Slash commands available through the harness command registry.
    // Registered AFTER the built-ins (/help, /tools, /task, /websearch,
    // /webfetch), so a name that collides with a built-in or repeats another
    // configured entry fails construction. A plugin (or
    // `harness.registerCommand`) runs later and therefore MAY replace a name.
    commands?: readonly HarnessCommandConfiguration[];
    // Optional programmatic extension point, retained from the plugin design.
    // Auto-discovered built-in plugins (src/plugins/**\/*.plugin.ts, see
    // src/plugin/manifest.ts) are applied FIRST, so a name listed here REPLACES the
    // built-in of that name instead of colliding with it.
    plugins?: readonly HarnessPlugin[];
    // Read-only view of the host's per-plugin settings (R2/R3 plugin settings UI).
    // The harness asks it for `<pluginName>.<key>` whenever a plugin reads
    // `api.settings.*`. Absent = an in-memory provider seeded from each plugin's
    // declared setting defaults, with `wakeIntervalMs` mapped onto the `async-ping`
    // plugin's `intervalMs` so the legacy configuration field keeps working.
    pluginSettings?: HarnessPluginSettingsProvider;
};

// The callable harness. `await writer('...')` runs the entry agent to
// completion, executing tools until the model answers with text.
export type Harness = {
    (input: string, options?: HarnessRunOptions): Promise<HarnessAssistantMessage>;
    // The entry agent's name (`primary`, or the first key of `agents`).
    readonly name: string;
    // The entry agent.
    readonly agent: Agent;
    // Every agent, keyed by the names given in configuration.
    readonly agents: Readonly<Record<string, Agent>>;
    // Agents the primary may delegate to, keyed by name. Empty when delegation is
    // not configured.
    readonly subagents: Readonly<Record<string, Agent>>;
    // The registered tools, keyed by the names the model calls. Includes the
    // built-in toolRequest, toolCreate, task, profileManage,
    // chapterManage, and locationManage entries, plus delegate when there
    // is at least one subagent.
    readonly tools: Readonly<Record<string, Tool>>;
    // Register a tool from source at runtime. This is the host-side path the
    // model-facing toolCreate tool uses: same validation, same registry, same
    // "searchable and enabled at once" behaviour. Throws HarnessError on invalid
    // or colliding input, so a host sees creation failures as exceptions.
    toolCreate: (configuration: ToolCreation) => Tool;
    // The ONE compile/load/validate/register operation. Startup registration,
    // toolRegistry, configured tools, and plugins all commit through this method
    // (startup may call the non-awaited kernel internally because toolRegistry
    // does not exist yet). A source candidate is captured and compiled
    // SYNCHRONOUSLY before the returned promise is created; that promise then
    // resolves with the already-published result. Publication is therefore a
    // completion barrier: a call submitted after this returns sees the new
    // definition, and overlapping registrations complete in submission (FIFO)
    // order because no compilation is deferred to a background task. Replacements
    // do not consume the new-tool budget.
    registerTool: (
        candidate: HarnessToolRegistrationCandidate
    ) => Promise<HarnessToolRegistrationResult>;
    // Inspect the captured source/revision of the installed registration. `undefined`
    // means the tool was registered from an already-constructed definition (no
    // editable source revision exists for it).
    toolSource: (name: string) => HarnessToolSource | undefined;
    // Every installed source revision, in registry insertion order.
    toolSources: () => HarnessToolSource[];
    // Invoke a registered tool through the live registry with the same schema
    // validation as the manual path. Used by tools to reach other tools without
    // importing/capturing a fixed implementation. Resolves the definition at call
    // time, preserves caller/thread/signal when supplied, and notifies persistence
    // observers exactly like executeTool.
    callTool: (
        name: string,
        parameters: unknown,
        options?: HarnessToolCallOptions
    ) => Promise<unknown>;
    // Stable harness-owned memory shared by every tool and agent. Replacing an
    // implementation does not reset it.
    readonly memory: HarnessMemory;
    // Live operations behind the standalone core-tool source entries. This is an
    // addition to (never a replacement for) the unrestricted harness reference.
    readonly runtime: HarnessToolRuntime;
    // Execute one registered tool by name, outside the model's discovery gate
    // (R8). This is the server/host path for an EXPLICIT user action — the CLI or
    // the UI's Tools tab — and it runs the SAME session-bound implementation the
    // model calls, so discovery, runtime creation, todos, and delegation all
    // mutate this harness exactly as they would during a run.
    //
    // `parameters` may be EITHER form (R11):
    //   - the value `execute` receives, i.e. already unwrapped by the
    //     single-property rule: `executeTool('read', ['package.json'])`;
    //   - the schema wrapper object, like the model sends:
    //     `executeTool('read', { paths: ['package.json'] })`.
    // Both are validated against the tool's JSON Schema and resolved to the same
    // value, so the legacy direct-call convention keeps working and a manual call
    // cannot smuggle arguments past the runtime check. A schema mismatch throws
    // HarnessError (no tool-result envelope: a host caller sees an exception).
    //
    // GATING: discovery gates the MODEL, not its operator. A searchable tool that
    // toolRequest has not enabled is still runnable here; the model remains
    // unable to call it. Reserved policy is NOT bypassed: `toolCreate` here goes
    // through the same validated registration path (budget, name rules,
    // collisions, compilation), and `delegate` still requires a harness that
    // actually registered it (no subagents means no delegate tool).
    //
    // Throws HarnessError when the name is not registered in this harness, or
    // whatever the implementation throws; unlike the model path there is no
    // tool-result envelope, because a host caller can see an exception. The return
    // value is the tool's raw result (UI panels are NOT unwrapped here — the caller
    // owns presentation), and it is NOT subject to the model-facing 64 KiB text
    // budget; a server that serializes it for a client should apply
    // `boundToolResult` (exported from the package root) itself.
    executeTool: (name: string, parameters: unknown) => Promise<unknown>;
    // The registered slash commands, keyed by name WITHOUT the leading slash
    // (so `commands.help` answers `/help`). Each read is a frozen defensive
    // copy of the live registry: mutating it never changes harness state, and
    // a command registered after this read still appears in the next one.
    readonly commands: Readonly<Record<string, HarnessCommand>>;
    // Execute one slash command line (e.g. `/task add "testing"`) in THIS
    // process. The model is never called and no progress event is emitted; a
    // built-in that calls a tool still fires the usual `stateChange`
    // ('tool_execute'), so a persistence layer sees the mutation.
    //
    // Throws HarnessError when the line is not a command (no leading "/") or
    // names an unknown command, and rethrows whatever the implementation
    // throws. A RECOVERABLE failure comes back as `{ content, isError: true }`
    // instead, which is what a host should print rather than catch.
    executeCommand: (input: string) => Promise<HarnessCommandResult>;
    // Register (or REPLACE) one command at runtime, mirroring `registerTool`
    // replace semantics: names are not reserved and a replacement costs
    // nothing. Validates the name and the definition, and throws HarnessError
    // without touching the registry when either is invalid.
    registerCommand: (command: HarnessCommandConfiguration) => HarnessCommand;
    // Names of the applied plugins, in order. Auto-discovered built-ins come first
    // (src/plugins/**\/*.plugin.ts); a `configuration.plugins` entry of the same name
    // replaces the built-in in place, so this list stays duplicate-free.
    readonly plugins: readonly string[];
    // R2/R3: the full declared description of every APPLIED plugin, in the same
    // order as `plugins`. This is what the server hands the UI's Plugins pane
    // (title, description, version, tags, hooks, settings) — data only, never a
    // function, so it is JSON-serializable as-is. A programmatic plugin without
    // `metadata` gets the synthesized `{ name, title: name, builtin: false }`.
    readonly pluginMetadata: readonly HarnessPluginMetadata[];
    // A complete, JSON-serializable core-state snapshot (R3a). See HarnessSnapshot
    // for what is and is not included. Safe to call DURING an active run (T16):
    // it synchronously captures the committed transcript, discovery, created-tool
    // sources, and store state, so a completed tool mutation is persistable before
    // the turn settles. Text/reasoning deltas not yet committed to messages are
    // not part of it.
    snapshot: () => HarnessSnapshot;
    // Apply a snapshot to this harness (R3a). Intended for a FRESH harness built
    // from the same definition. Validation is complete and up front: schema,
    // version, agent identity, discovery names, created-tool source compilation,
    // creation budget, and every record store. Nothing is mutated when validation
    // fails, and no created-tool source is executed (compilation only). Applying a
    // snapshot is idempotent: tools previously restored here are replaced, not
    // duplicated. Throws HarnessError while an agent run is in progress.
    restore: (snapshot: HarnessSnapshot) => void;
    // Teardown (T1.6, the missing counterpart of `harness.dispose` in the event
    // catalogue). Emits `harness.dispose` ONCE and clears every plugin subscription.
    //
    // It never aborts work: a run that is still going is a run the caller started, so
    // when one is live the event is DEFERRED to the boundary after the last run settles
    // — which is what "fires exactly once, after the last run of every thread" means.
    // The call itself is synchronous and idempotent; a second call does nothing, and a
    // harness that was disposed while a run was live still fires exactly once.
    //
    // Ordering is observable (F8): the emit happens on a settled boundary, never raced
    // against a run. A host that wants the runs GONE calls `stopAllThreads()` (the
    // server's session teardown does) and then `dispose()`.
    //
    // Deliberately NOT snapshot state: a dispose is a process fact. A restored harness
    // has a fresh bus with its plugins re-registered by construction, so snapshotting
    // "disposed" would describe a state the restore cannot reproduce.
    dispose: () => void;
    // Names of the searchable tools enabled right now: the newest toolRequest /
    // toolManage selection first, then retained prior entries, capped at
    // maxEnabledTools. Persists for the harness's lifetime (not just one call),
    // which is what lets a later turn call a tool discovered earlier. Copied on
    // read; `reset()` empties it.
    readonly discoveredTools: string[];
    // N3: every branch record this harness knows, newest last. Includes running
    // branches and the bounded newest terminal records (see
    // MAX_BRANCH_RECORDS / core/branch.ts). The returned array is a detached
    // copy: mutating it never changes harness state.
    branches: () => HarnessBranchRecord[];
    // N3: one branch record by id, or undefined. The returned record is a
    // detached copy, like `branches()`.
    branch: (id: string) => HarnessBranchRecord | undefined;

    // -------------------------------------------------------------------
    // R2 persistent agent threads
    // -------------------------------------------------------------------
    //
    // A thread is an agent-owned conversation with a stable id and its own
    // transcript. Every configured agent has a DEFAULT thread
    // (`agent:<name>`) whose transcript is that agent's registry history;
    // `createThread` opens an ADDITIONAL independent conversation backed by a
    // fresh Agent instance. All threads share this harness's tools, todo list,
    // record stores, discovery state, and creation budget — sharing the SESSION's
    // memory is the point of threads, while their conversations stay separate.
    //
    // Reads are detached copies. Writes are explicit:
    //   - createThread      — open a new (idle) conversation for an agent;
    //   - sendThreadInput   — run/resume one thread (serialized per thread,
    //                         concurrent across threads);
    //   - steerThread       — queue guidance for the NEXT safe model boundary of
    //                         a RUNNING thread;
    //   - stopThread / stopAllThreads — abort active work (and owner-linked
    //                         children) and mark the thread stopped;
    //   - deleteThread      — purge a terminal HOST thread, its transcript, and
    //                         its invocation/branch lookups. It never erases
    //                         information already copied into another history.
    //
    // R4: a delegation/ctx.run child OF A HOST THREAD is itself a NEW host thread
    // (own transcript/id, ownerThreadId = the caller), so two parents targeting
    // the same child agent never share a transcript and can run concurrently.
    // A root delegation keeps using the child agent's default conversation.
    //
    // Cross-thread chat is the conditional `threadSend` tool, paired with the
    // `threadList` roster so ids are OBSERVED rather than invented. The runtime
    // derives the sender identity from the calling run, so a model cannot
    // impersonate another agent. Both tools are registered on the first
    // createThread (or when a restore carries host threads).
    //
    // A host thread follows its owning agent's CURRENT model: `agent.model('…')`
    // applies to every live thread of that agent on its next run. A request in
    // flight keeps the model it started with.
    threads: () => HarnessThreadRecord[];
    thread: (id: string) => HarnessThreadRecord | undefined;
    // The thread's committed transcript, as a detached copy.
    threadMessages: (id: string) => HarnessMessage[];
    // C4: REPLACE one thread's committed transcript wholesale (the transcript
    // editor's write primitive). `messages` is validated with the same reader
    // `snapshot()`/`restore()` enforce, so a harness can never hold a transcript
    // its own snapshot would refuse.
    //
    //   - unknown/deleted `threadId`           → HarnessError;
    //   - a thread with live work              → HarnessError (replacing a
    //     transcript the run loop is reading would tear it; stop it first);
    //   - validation failure                   → HarnessError, NOTHING mutated.
    //
    // The live array is replaced IN PLACE (like `restore()`), because
    // `agent.messages` is exposed by reference; a later holder of that reference
    // must see the new transcript. A stopped thread is writable — the whole point
    // is letting an operator repair a broken conversation. A default
    // `agent:<name>` conversation is writable for the same reason: it is that
    // registry agent's transcript.
    //
    // Notifies `agent_message` (the existing reason; no new reason is added) and
    // emits NO progress event: this is a host edit, not model output.
    setThreadMessages: (threadId: string, messages: HarnessMessage[]) => void;
    // T5 lane-worker seam: APPEND the messages one lane committed at a known prefix.
    //
    // `fromLength` is the transcript length the lane observed; the canonical length must
    // match, otherwise the append is refused (nothing is overwritten, and the caller is
    // handed the canonical transcript length in the error). Unlike `setThreadMessages`
    // this does NOT refuse a thread whose record says 'running': in worker mode the run
    // lives on another thread and the local record is a mirror being caught up.
    //
    // Returns the detached canonical transcript. Notifies `agent_message`.
    appendThreadMessages: (
        threadId: string,
        messages: HarnessMessage[],
        fromLength: number
    ) => HarnessMessage[];
    // T4.1 lane-worker seam: REWRITE the committed PREFIX of one conversation in place — the
    // in-place companion of the append above, which can only ever extend a transcript.
    //
    // A lane's plugin writes an ALREADY-committed message without changing the length (the
    // `included` flag, or `edit` changing its text), so the append condition never fires for
    // it and the change used to die with the worker process. This is the targeted canonical
    // write the authority replays a `transcript:patch` op through: one call per committed
    // change, validating its own input, never a wholesale `restore()`.
    //
    // `messages` is the whole prefix — `messages.length` MUST equal `expectedLength`, the
    // committed length the lane holds — and it replaces `agent.messages[0..expectedLength]`
    // in place, leaving everything the conversation gained since that prefix untouched.
    //
    //   - unknown/deleted `threadId`                    → HarnessError;
    //   - a run attached IN THIS harness                → HarnessError (the authority's own run
    //     loop is reading this transcript; a lane's run living on another thread is NOT a
    //     refusal, exactly like the append above);
    //   - `messages.length !== expectedLength`, a negative or fractional length, canonical
    //     shorter than `expectedLength`                 → HarnessError, NOTHING mutated;
    //   - an entry that would change a committed position's `role`, or move its `messageId`
    //     when both sides carry one                      → HarnessError, NOTHING mutated.
    //     Role is what provider tool-call pairing and the exclusion unit resolve on, and a
    //     `messageId` is a turn's address (it is how `setIncluded` names an entry from another
    //     round), so neither may move under a text edit.
    //
    // The compare-and-set itself is the AUTHORITY's job (`src/server/workers/lane-authority.ts`
    // digests the prefix it is about to replace and refuses a stale one), because the digest
    // serializer is a worker-protocol concern and the core has no reason to own one.
    //
    // Returns the detached canonical transcript, and notifies `agent_message` — the only
    // durability mechanism a flag or text edit has (src/types/index.ts `setIncluded`).
    patchThreadMessages: (
        threadId: string,
        messages: HarnessMessage[],
        expectedLength: number
    ) => HarnessMessage[];
    // T5 lane-worker seam: mirror a lane conversation's roster state onto the canonical
    // record (status, and the invocation the roster joins a turn to). Refused when a run
    // is attached IN THIS harness, because that run owns its own status. Notifies `thread`.
    setThreadStatus: (
        threadId: string,
        status: HarnessThreadStatus,
        invocationId?: string
    ) => HarnessThreadRecord;
    // T5 lane-worker seam: archive ONE terminal invocation for a run that happened on a
    // lane worker, so `agentResult` / `agentManage` / the results view can address work the
    // session really did. Identity is the caller's (authority-leased); the completion and
    // run-sequence high-water marks are only ever RAISED. Throws for an unknown agent, a
    // blank invocation id, a non-positive sequence, or a 'running' status.
    archiveInvocation: (
        input: HarnessInvocationArchiveInput
    ) => { record: HarnessAgentResultSnapshot; replaced: boolean };
    // T5 lane-worker seam: RAISE this harness's identity counters so a replica cannot mint
    // an id the coordinator has already leased to somebody else. Supplied values never lower
    // a counter; the returned object is the actual state afterwards.
    reserveIdentity: (input: HarnessIdentityReservation) => HarnessIdentityReservation;
    // T14 lane-worker seam: read or arm this instance's NESTED-RUN policy (see
    // `NestedRunPolicy`, whose own comment states the whole rule).
    //
    //   - `harness.nestedRuns()` — the current policy;
    //   - `harness.nestedRuns('refuse')` — armed ONCE by a lane worker replica at hello,
    //     before its first turn (`src/server/workers/lane-worker-loop.ts` `refuseNestedRuns`),
    //     which is what makes every nested-run door throw the named `nested-run-unsupported`
    //     limitation instead of creating a child conversation this replica would keep to itself;
    //   - an unrecognised value THROWS (validated, never coerced), so a worker cannot believe it
    //     armed while the core still runs children privately.
    //
    // An inline harness never arms anything, so every door behaves exactly as it always did.
    // A tool body reads the same policy without touching the handle: `context.nestedRuns`.
    nestedRuns: (policy?: NestedRunPolicy) => NestedRunPolicy;
    // Open an independent conversation owned by `agent`. Throws for an unknown
    // agent or an invalid/blank label, and when an `ownerThreadId` names no
    // thread in this harness.
    createThread: (agent: string, options?: HarnessThreadCreateOptions) => HarnessThreadRecord;
    // Run one turn (including tool execution) in `threadId` and resolve to its
    // answer. Concurrent calls on the SAME thread queue in order — there is never
    // simultaneous execution inside one thread — while different threads run
    // concurrently. A stopped thread is revived by this explicit host action; a
    // deleted thread is an error.
    sendThreadInput: (
        threadId: string,
        input: string,
        options?: HarnessRunOptions
    ) => Promise<HarnessAssistantMessage>;
    // Queue text for the next safe model boundary of a RUNNING thread. Steering
    // never interrupts an in-flight request: the run appends it as a user message
    // before its next request, so the ordering inside the transcript is the
    // ordering of the returned receipts. Returns `queued: false` with a reason for
    // an idle or stopped thread.
    //
    // If that run then FAILS (transport error, iteration cap), the drained
    // steering is rolled back with the transcript and re-queued in its original
    // order, so the next host turn retries it deterministically. A stop discards
    // it instead (the host's stop wins).
    steerThread: (threadId: string, input: string) => HarnessThreadSteerReceipt;
    // Abort active work in this thread and everything it owns (child threads and
    // delegated runs), then mark it stopped. A stopped thread accepts no new run
    // from an agent (delegation/chat are refused) and NO ALREADY-QUEUED host turn
    // runs either: every turn submitted before the stop is rejected with
    // "was stopped while this turn was queued". Only a NEW sendThreadInput after
    // the stop revives the conversation. Returns true when an active run was
    // aborted.
    stopThread: (threadId: string, reason?: string) => boolean;
    // Stop every thread in this session (including already-queued work, which is
    // rejected rather than started). Returns the number of active runs aborted
    // (threads without active work are still marked stopped).
    stopAllThreads: (reason?: string) => number;
    // Permanently remove a terminal HOST thread: its record, transcript, owned
    // terminal children, and every invocation/branch lookup scoped to it. Throws
    // while the thread (or an owned child) is running, and for an agent's default
    // conversation (use reset() for session memory).
    deleteThread: (threadId: string) => void;
    // T27: agent-roster mutation for a host that changes WHICH brains a live session
    // uses — the server's session-scoped agent binding routes
    // (`POST`/`DELETE /sessions/{id}/agents`, `PATCH .../agents/{id}` with `instruction`).
    //
    // These exist because the alternative every caller had was a history reset: the only
    // wholesale text write the runtime offered was `setThreadMessages`, which replaces a
    // committed transcript to change a prompt, and rebuilding the harness loses the
    // conversation. Roster membership and the leading instruction block are separate
    // pieces of state from the transcript, so they are edited directly.
    //
    // SAFETY (all three): they mutate structure the run loop reads, so each one refuses
    // with `HarnessError` while ANY run is in flight (`activeRuns > 0`) — the same gate
    // `restore()` uses. A caller that needs "the change is real only if it is durable"
    // (the server store) additionally refuses a session with live lane work or queued
    // turns, and re-snapshots `core` afterwards; the runtime does not notify
    // `stateChange` for these, because a mid-run notification is exactly the case they
    // refuse and the host owns the commit.
    //
    //   - `addAgent(name, configuration, options?)` — build and register a NEW brain
    //     under `name`, give it its default `agent:<name>` conversation, and (unless
    //     `options.delegate === false`) put it in the primary's delegation allowlist,
    //     which also installs the `delegate` tool the first time the roster gains a
    //     subagent and re-projects its allowlist schema. Throws for a blank/unknown name
    //     shape, a name that is already registered, or a configuration with no model.
    addAgent: (
        name: string,
        configuration: AgentConfiguration,
        options?: { delegate?: boolean }
    ) => Agent;
    //   - `removeAgent(name)` — detach one registry agent: it leaves `agents`,
    //     `subagents`, and the delegation allowlist, and its DEFAULT conversation is
    //     dropped with it (a host thread owned by that agent is not). Throws for an
    //     unknown agent, for the primary (the entry point is not removable — that is a
    //     redefinition, not a binding change), while its default conversation has
    //     live or queued work, and while it still OWNS a host thread — the host deletes
    //     those conversations first, which is exactly the guard the server's session route
    //     states as a 409 before calling this (./server/sessions.ts `removeSessionAgent`,
    //     R6: a saved session's history is never removed behind the caller's back).
    //     Committed history in OTHER agents is never rewritten: a
    //     delegated answer already copied into the primary's transcript stays.
    removeAgent: (name: string) => void;
    //   - `setAgentInstruction(name, instruction)` — replace the agent's leading system
    //     block IN PLACE with one system message, and reseed its `instructions` baseline
    //     so a later `reset()` returns to the new prompt. The number of messages replaced
    //     is exactly the current instruction count (`agent.instructions.length`), which
    //     is how many leading system entries `agent()` seeded; everything after them —
    //     seeded context, turns, tool results — is untouched, and no transcript is ever
    //     rebuilt. Throws for an unknown agent or blank/non-string text.
    setAgentInstruction: (name: string, instruction: string) => void;
    // Reset to "start over": EVERY agent's conversation goes back to its seeded
    // instructions (R12 — a subagent kept its old transcript before this), tool
    // discovery is forgotten, and the session todo list and record stores are
    // cleared. Created tools stay registered (they are catalogue state) and are
    // simply no longer enabled; the creation budget is a lifetime budget and is
    // NOT restored by reset().
    reset: () => void;
};

// ---------------------------------------------------------------------------
// Plugin contract
// ---------------------------------------------------------------------------

// The lifecycle stage a plugin may hook. ONE flat union, ordered by where it sits
// in the harness's own timeline, because the manifest and the UI both need this list
// as DATA (`metadata.hooks` is what the Plugins pane renders) and a plugin author
// must be able to write a literal without importing a helper.
//
//   thread.*  — a conversation's identity changes. `created`/`deleted` bracket
//               createThread/deleteThread; `started`/`idle` bracket one RUN of a
//               thread; `paused`/`resumed` are the plugin-owned park/unpark at a
//               turn boundary (see HarnessThreadStatus).
//   run.*     — one agent run (a thread run, a delegated run, a fork). Emitted for
//               EVERY run, including nested ones, so a plugin can observe the whole
//               tree; `threadId` is absent for a branch run, which owns an
//               ephemeral transcript instead of a conversation.
//   turn.*    — one model request. `turn.before` is the ONLY hook whose return value
//               matters (it may replace the transcript the provider is about to see AND
//               return a `HarnessTurnDecision` for the run — continue/replace/pause/stop)
//               and the only one that carries control methods; that is what makes
//               context compaction and the per-agent context limit possible.
//   tool.*    — one tool call: `before` at launch, `after` when its result is
//               committed to the transcript.
//   async.*   — background tool work: `pending` when a call joins the board,
//               `drained` when an agent's board became empty (the replacement for
//               the hardcoded recurring wake).
//   host.*    — the host's own planes bridged into the bus (T1.7). Deliberately NOT
//               part of the `'*'` fan-out: see `HARNESS_WILDCARD_EXCLUDED_EVENTS`.
//   harness.dispose — the teardown point. `harness.dispose()` (the handle member,
//               T1.6) emits it exactly once, after the last run of every thread has
//               settled, and clears the bus right after; the server binds it to
//               session teardown (SessionStore.disposeSession). A plugin that only
//               needs "the harness is going away" subscribes HERE.
export type HarnessLifecycleEvent =
    | 'thread.created'
    | 'thread.started'
    | 'thread.paused'
    | 'thread.resumed'
    | 'thread.stopped'
    | 'thread.idle'
    | 'thread.deleted'
    | 'run.started'
    | 'run.finished'
    | 'run.failed'
    | 'turn.before'
    | 'turn.after'
    | 'tool.before'
    | 'tool.after'
    | 'async.pending'
    | 'async.drained'
    // T1.7: the persistence/state-change plane (`report.stateChange`) bridged into the
    // bus. Explicit-subscription ONLY and never delivered through `'*'`, because it
    // fires on every transcript/tool/thread mutation — far more often than any run
    // event — so a bridge that reached the default fan-out would put a handler on every
    // tool execution. A `'*'` subscriber that wants it asks for it by name.
    | 'host.state_change'
    | 'harness.dispose';

// The events a `'*'` subscription does NOT receive: `host.state_change` only. It is a
// host plane bridged for observers that opt in by name, not a run event, and the
// Plugins pane's live-vs-declared report is built from the SAME rule (the bus expands
// a wildcard into exactly the events it will be delivered — `createHookBus().live()`).
// The rule itself lives in src/plugin/hooks.ts (`WILDCARD_EXCLUDED`), because this file
// stays a types-only module (no runtime export goes through the declaration build).

// One declared setting of a plugin. `key` is the stable id the harness reads back
// through HarnessPluginSettingsProvider; `label`/`description` are for the UI. The
// numeric fields are UI hints (an editor must not offer a value outside min/max or
// off a step) and are NOT enforced at read time — a host may store anything.
export type HarnessPluginSettingType = 'number' | 'string' | 'boolean';

export type HarnessPluginSettingDescriptor = {
    key: string;
    label: string;
    type: HarnessPluginSettingType;
    // The value used when the host has nothing stored. Required: a plugin must have
    // an answer for a fresh session with no persisted settings.
    default: number | string | boolean;
    min?: number;
    max?: number;
    step?: number;
    description?: string;
};

// Static, JSON-shaped description of a plugin. Lives in the plugin file itself as a
// literal (`export const metadata = {...} satisfies HarnessPluginMetadata`) so the
// manifest generator can read it without executing the plugin's behaviour, and so
// the server can hand the whole catalogue to the UI as data.
export type HarnessPluginMetadata = {
    // Stable unique id — the key settings, hooks, and enable/disable state use.
    name: string;
    // Human display name for the Plugins pane.
    title: string;
    description?: string;
    version?: string;
    // Free-form categorisation for the UI (filters/search), never behaviour-bearing.
    tags?: readonly string[];
    // Which lifecycle stages this plugin subscribes to, for display. Informational:
    // the bus records what a setup() call ACTUALLY registered, and that is what
    // runs; this list is the declared contract shown to an operator.
    hooks?: readonly HarnessLifecycleEvent[];
    settings?: readonly HarnessPluginSettingDescriptor[];
    // True for a plugin shipped by the package (auto-scanned from src/plugins).
    // A programmatic `configuration.plugins` entry is never builtin.
    builtin?: boolean;
};

// A plugin is a named unit of behaviour applied during harness construction.
export type HarnessPlugin = {
    // Unique within one harness. Applied in array order.
    name: string;
    // Declared metadata. A discovered `*.plugin.ts` file always carries it; a
    // hand-written programmatic plugin may omit it, and the harness then synthesizes
    // `{ name, title: name, builtin: false }` so the UI list is always complete.
    metadata?: HarnessPluginMetadata;
    // Runs once, synchronously. Synchronous on purpose: harness() stays a plain
    // factory, so `const writer = harness({...})` needs no await.
    setup?: (api: HarnessPluginApi) => void;
};

// Host-side read model for plugin settings (R2/R3). The harness calls `get` with the
// OWNING plugin's name plus the key from its metadata; the host decides where the
// value came from (a server document, an env var, a CLI flag). Returning `undefined`
// means "nothing stored" and the plugin's declared default applies.
//
// Synchronous and total: it runs inside setup() and inside every turn, so a provider
// that throws is a host bug that fails the run (the harness does NOT swallow it —
// a wrong settings read must not be silently defaulted).
export type HarnessPluginSettingsProvider = {
    get(plugin: string, key: string): unknown;
    // Optional WRITE capability (T3.5). A provider that does not implement it is a pure
    // read model, and `api.settings.setOwn` refuses it with the stated "no writer"
    // answer instead of keeping a private copy the host would never see. A host that
    // DOES implement it receives an already-validated value: the plugin view checks the
    // descriptor and normalizes to the declared type before calling this, so a writer
    // never has to accept a numeric string for a `number` setting (src/plugin/settings.ts
    // `setOwnValue`, mirroring src/server/plugins.ts `checkValue`).
    set?(plugin: string, key: string, value: number | string | boolean): void;
};

// What one plugin's `api.settings` looks like. Every accessor coerces: a stored value
// of the wrong shape falls back to `fallback`, so a corrupt host document can never
// hand a plugin a NaN or the string "false".
export type HarnessPluginSettings = {
    // Raw stored value, `undefined` when nothing is set.
    get: (key: string) => unknown;
    // Declared default of `key` when the plugin declared one, otherwise `fallback`.
    number: (key: string, fallback?: number) => number;
    string: (key: string, fallback?: string) => string;
    boolean: (key: string, fallback?: boolean) => boolean;
    // Store one of THIS plugin's own settings (T3.5 — the only write this surface has).
    //
    // SCOPE: the view is built per plugin (src/plugin/host.ts), so `key` is always
    // namespaced by the plugin that owns the view — a plugin cannot read OR write
    // another plugin's namespace, and there is no `set(plugin, key)` spelling.
    //
    // VALIDATION: the same rules the server applies at its PATCH write edge
    // (src/server/plugins.ts, header "VALIDATION AT THE WRITE EDGE, COERCION AT THE
    // READ EDGE"), because a write must say what it means while a read stays
    // permissive: the key must be one this plugin DECLARES (an unknown key is refused
    // with the declared set named, never stored and then ignored), the value must match
    // the declared `type` — a number, or a numeric string, or the words 'true'/'false'
    // for a boolean, and a string ONLY for a `string` setting — and a number must be
    // finite and inside the published `min`/`max`. `step` stays a UI hint and is NOT
    // enforced, exactly as the descriptor comment says. The value is NORMALIZED to the
    // declared type before it is written, so a stored value is always JSON-shaped.
    //
    // DURABILITY: a write goes THROUGH the host's provider, never around it, and what
    // survives is whatever the provider does. Two answers, both stated rather than
    // discovered: (1) a harness built with no `configuration.pluginSettings` gets the
    // library's in-memory provider, so `setOwn` works for the lifetime of the process
    // and persists NOTHING — it is not in `snapshot()` and does not survive a restart;
    // (2) a host whose provider implements `get` only — which is the shipped server's
    // live provider, deliberately read-only so the store's own PATCH edge stays the
    // one that validates, bumps the revision and schedules the save — has NO writer, and
    // `setOwn` throws a `HarnessError` saying so rather than silently dropping the
    // write. Wiring a host store's write path is host work, not a library fallback.
    //
    // `null`/`undefined` are refused, not treated as "reset": a reset is the host's
    // documented PATCH semantic (an explicit `null` removes the override) and this
    // surface has no way to express "delete the key" without inventing a second rule.
    setOwn: (key: string, value: unknown) => void;
};

// The ONE payload shape per lifecycle event. Keyed by event so `api.on` is typed
// per-event without a single `any` at the public boundary: adding an event means
// adding one entry here, and every exhaustive consumer (the bus, the harness emit
// sites, the tests) fails to typecheck until it is filled in.
export type HarnessLifecyclePayloads = {
    'thread.created': HarnessThreadRecord;
    'thread.started': HarnessThreadRecord;
    'thread.paused': HarnessThreadRecord;
    'thread.resumed': HarnessThreadRecord;
    'thread.stopped': HarnessThreadRecord;
    'thread.idle': HarnessThreadRecord;
    // The record is gone by the time this fires (a delete already purged it), so the
    // payload is the identity the handler still needs.
    'thread.deleted': { threadId: string; agent: string };
    'run.started': HarnessRunLifecycleContext;
    'run.finished': HarnessRunLifecycleContext & { message: HarnessAssistantMessage };
    'run.failed': HarnessRunLifecycleContext & { error: HarnessErrorInfo };
    'turn.before': HarnessTurnBeforeContext;
    'turn.after': HarnessTurnAfterContext;
    'tool.before': HarnessToolLifecycleContext & { call: HarnessToolCall };
    'tool.after': HarnessToolLifecycleContext & {
        call: HarnessToolCall;
        callId: string;
        content: string;
        isError: boolean;
        outcome: HarnessToolOutcome;
        durationMs: number;
    };
    'async.pending': HarnessAsyncLifecycleContext;
    'async.drained': HarnessAsyncLifecycleContext;
    // T1.7 — the host's persistence/state-change plane, bridged verbatim. Same reason
    // union and same detail fields the `report.stateChange` observer gets, so a plugin
    // and a host see ONE vocabulary.
    'host.state_change': HarnessStateChangeEvent;
    'harness.dispose': Record<string, never>;
};

// ---------------------------------------------------------------------------
// Event bus v2 (T1): wildcard subscription
// ---------------------------------------------------------------------------

// What a `'*'` handler receives: ONE discriminated union, built by mapping the payload
// map, so `event` and `payload` narrow together (`if (context.event === 'turn.before')
// context.payload.estimatedTokens` typechecks) and no `any` appears at the boundary
// (open decision 6 — a plain `payload: unknown` would put the `any` back).
//
// Identity fields are NOT copied onto the envelope: every payload that has a thread or
// an agent already carries them (`HarnessRunLifecycleContext`, `HarnessThreadRecord`),
// so a second copy would be a value that can disagree with the payload.
export type HarnessWildcardEventContext = {
    [E in HarnessLifecycleEvent]: { event: E; payload: HarnessLifecyclePayloads[E] };
}[HarnessLifecycleEvent];

// A wildcard handler observes; it does not decide. Its result is always discarded,
// INCLUDING for a `turn.before` frame — an audit plugin that subscribed to everything
// must not silently rewrite one event's request because that event happens to have a
// result channel. Async is allowed (the bus awaits it, sequentially, fail-open).
export type HarnessWildcardHandler = (
    context: HarnessWildcardEventContext
) => void | Promise<void>;

// One dropped plugin handler, reported to the host (T1.5). JSON-shaped on purpose: the
// server can log it or show it in the Plugins pane without owning an Error graph. The
// three kinds are every way a handler can stop being useful WITHOUT failing the run —
// fail-open is the invariant, this is the visibility that makes it safe:
//   - `handler-threw`     — it threw or rejected; its result is discarded.
//   - `handler-timed-out` — it outlived its `timeoutMs` budget; its result (whenever it
//                         finally arrives) is discarded too.
//   - `invalid-decision`  — it returned a `decision` the contract cannot parse (T2.2
//                         rule 5); the rest of its result still applies.
//   - `policy`            — NOT a failure. A plugin's own decision report, authored through
//                         `api.report.diagnostic` (compaction T4.5). The three kinds above
//                         are produced by the FRAMEWORK about a plugin; this one is produced
//                         BY a plugin about what it did. It shares the channel because the
//                         channel is the answer to "what is this plugin doing that I cannot
//                         see", and an operator looking at one stream should not have to
//                         know which half of the harness wrote it.
export type HarnessDiagnosticEvent = {
    type: 'plugin_diagnostic';
    kind: 'handler-threw' | 'handler-timed-out' | 'invalid-decision' | 'policy';
    // The event whose handler failed, and the plugin that registered it (the bus's
    // `owner`, which is the plugin name; '' for a subscription with no owner).
    //
    // OPTIONAL for a `policy` report: a decision is not tied to one hook. The compactor
    // runs inside `turn.before` but reports WHICH UNITS IT WITHHELD, and naming the hook
    // would claim a failure that did not happen. Every framework diagnostic names its
    // event, so a consumer that only handles failures keeps reading this field.
    event?: HarnessLifecycleEvent;
    owner: string;
    // Human-readable, from the thrown value's message or the synthetic one the bus
    // builds for a timeout / unparseable decision. Never empty.
    message: string;
    // The structured form of a `policy` report (compaction T4.5: each withheld unit, its
    // estimated tokens, and the id of the unit that superseded it). Absent for a framework
    // failure, which has nothing to structure — `message` is the complete human view of the
    // fact either way, so a host that only prints text loses nothing.
    data?: Record<string, unknown>;
};

// What a plugin may author on the diagnostic channel (`api.report.diagnostic`). Deliberately
// narrow: the framework owns `type`, `owner` and (for a failure) `event`, so a plugin cannot
// forge a report about another plugin or about a hook it never ran.
export type HarnessPluginDiagnosticReport = {
    // Defaults to `'policy'`, the only authorable kind: a plugin reports DECISIONS, and a
    // failure it caused is already reported by the bus when the handler throws.
    kind?: 'policy';
    // Self-contained human-readable text. It has to survive being printed alone: a host
    // with no structured sink still sees which units left the context and why.
    message: string;
    // JSON-shaped payload (units, token counts, ids). Kept `unknown`-valued like every other
    // diagnostic surface: the plugin decides what an operator needs to see.
    data?: Record<string, unknown>;
    // Who authored the report. The plugin HOST stamps this with the plugin's own name
    // (`plugin/host.ts`), which is the one piece of context a scoped api cannot see; a
    // subscriber using the fallback api (a host hook, a test) may name itself, and an
    // unnamed report attributes to the framework.
    owner?: string;
};

// `run.*` / `turn.*` share this identity block. `threadId` is absent only for a
// branch run (fork/autoanswer), which has no persistent conversation of its own.
export type HarnessRunLifecycleContext = {
    // The persistent thread this run belongs to, when it has one.
    threadId?: string;
    // Display agent name (never the internal actor key), like every event frame.
    agent: string;
    // Delegation depth: 1 is a top-level run.
    depth: number;
    // The root prompt of this run.
    input: string;
};

// One entry of the CANONICAL transcript, as the `turn.before` context exposes it for
// context-inclusion control (Stage 1b of the context-control design).
//
// Unlike `messages`, this is the committed history ITSELF: an entry that is disabled
// is still listed here, because context control never DELETES a turn — it hides it
// from the model, reversibly. A plugin that only saw `messages` could not re-enable
// anything, since the entries it would need are exactly the ones the projection left
// out.
export interface HarnessContextEntry {
    // Index in the agent's canonical transcript at the moment THIS entry object was
    // built (the first `entries` access of one handler).
    // The index is a snapshot, so a handler that calls `replaceHistory()` invalidates
    // the indices (and the message identities) of every entry captured BEFORE that
    // call: `setIncluded` then refuses a stale entry loudly instead of writing to the
    // wrong turn. A plain numeric index is interpreted against the CURRENT transcript.
    readonly index: number;
    // The canonical message itself — read-only by contract. Mutating it directly
    // would bypass the key normalization and the persistence notification, so
    // inclusion changes go through `setIncluded`.
    readonly message: HarnessMessage;
    // THE DURABLE ADDRESS (context T1.5) — `message.messageId`, hoisted so a handler
    // can name this turn without holding the object. Unlike `index` and the message
    // identity, it survives `replaceHistory()`, a snapshot/restore, and a whole run:
    // `setIncluded(id, …)` in a LATER round re-resolves this same turn, and so does one
    // captured before a `replaceHistory()` that kept the entry.
    //
    // Present for every entry the runtime created, and for a branch's own framing too:
    // a materialized placeholder or incorporation boundary enters the branch transcript
    // without an id and is minted one when that transcript is seeded
    // (core/agent.ts `assignMessageId`). ABSENT only for a message that reached canonical
    // state with none — a hand-pushed `agent.messages` edit by a host or a tool — and an
    // entry must not grow a `messageId: undefined` key a `toStrictEqual` consumer would
    // have to special-case. Address those by entry.
    readonly messageId?: string;
    // EFFECTIVE unit inclusion: `false` when this entry, or ANY other member of its
    // unit, is disabled. A unit is a standalone message, or a whole tool-call block
    // (an assistant message with non-empty `toolCalls` plus every `tool` message in
    // the transcript answering one of those calls, contiguous or spliced in later) —
    // exactly the unit `projectTranscript` filters, so a hook never has to reason
    // about provider pairing itself.
    //
    // This is a LIVE view of canonical state, not a snapshot: `setIncluded` followed
    // by re-reading `entry.included` answers what the transcript says NOW, and a
    // later handler's `entries` reflect what an earlier hook already switched.
    readonly included: boolean;
}

// The patch `context.edit(entry, patch)` accepts (pipeline T3.1) — the CLOSED set of
// text fields a transcript entry may change, and nothing else.
//
// Both fields are optional so a caller names only what it means to change, and a field
// it does not name is left exactly as it was (`edit` never clears a field the patch is
// silent about). `reasoning` exists on the assistant variant only, and the runtime
// refuses it for any other role rather than writing a key the snapshot whitelist would
// then refuse to load.
//
// `unknown` at the edges: the type is the DECLARATION, the runtime is the authority. A
// JS caller may still hand back a parsed JSON object carrying `toolCalls` or a number
// for `content`, and both are refused before anything is written.
export type HarnessContextEditPatch = {
    // The entry's text — the model-facing content of every role.
    content?: string;
    // The assistant's thinking text (kept out of the provider payload).
    reasoning?: string;
};

// Everything `turn.before` hands a plugin: the exact request that is about to go out,
// a token estimate for the context limit, and the controls that make a hook able to
// ACT rather than only observe.
export type HarnessTurnBeforeContext = {
    // The conversation this run belongs to — for a BRANCH run (a fork or an
    // autoanswer) that is the conversation that SPAWNED it, so a branch and its root
    // report the SAME string here. That is the shipped meaning and it is deliberately
    // unchanged (src/plugins/context-compaction.plugin.ts keys its cooldown on it);
    // use `actorKey`/`branchId` below to tell the two rounds apart. A run with no
    // thread at all falls back to its scheduling key.
    threadId: string;
    agent: string;
    // 1-based model-turn counter within this run.
    iteration: number;
    // THE BRANCH DISCRIMINATOR (pipeline T3.4 / context T8) — the run's scheduling
    // identity, exposed rather than invented: this is the same key the scheduler and
    // the mailbox already isolate the run by (a registered agent's display name,
    // `thread:<id>` for a host thread, `branch:<id>` for a fork/autoanswer). It is
    // ALWAYS different between a root round and a branch round of one conversation,
    // which is exactly what `threadId` cannot promise.
    actorKey: string;
    // The branch's own id (`branch-<n>`, core/branch.ts `createBranchId`) — PRESENT
    // only when this run IS a branch, absent for every ordinary run. Same value the
    // state-change plane already reports (`HarnessStateChangeEvent.branchId`), so a
    // plugin and the host name a branch identically. A policy that must not prune a
    // transcript that is about to be incorporated into its owner checks THIS, not
    // `threadId`.
    branchId?: string;
    // The PROJECTED transcript (committed history plus a placeholder for every
    // still-running tool call, with every disabled unit already filtered out) — the
    // array the provider was about to receive WHEN THIS HANDLER WAS ENTERED. It is a
    // plain value and stays stable for the whole handler, which is the contract
    // src/harness.plugin.test.ts pins ("the hook sees exactly the projected transcript
    // … before any rewrite"). It does NOT move when this handler writes: for the list
    // as it is NOW, read `currentMessages()`.
    messages: readonly HarnessMessage[];
    // The same projection evaluated AT ACCESS TIME: equal to `messages` until somebody
    // writes (a `setIncluded` flag change, an explicit `setTranscript`, or
    // `replaceHistory`, from THIS handler or from an earlier one in the round) and
    // afterwards the list the provider will actually receive, unless a later write
    // changes it again. After the round its value is frozen to what the round decided.
    //
    // `messages` answers "what am I being asked about", `currentMessages()` answers
    // "what will the model see if I stop writing now". They are the SAME array object
    // while nothing has been written, so an observing handler pays nothing for the
    // distinction, and at most one re-projection per write is ever paid.
    currentMessages: () => readonly HarnessMessage[];
    // The SAME estimate `estimatedTokens` carries, re-evaluated against
    // `currentMessages()` — the projection as it is NOW. Entry-time and live views, one
    // pair: `estimatedTokens` answers "how big was the context I was asked about",
    // `currentEstimatedTokens()` answers "how big will it be if I stop writing now", so
    // a compactor can measure what ITS OWN prune just saved inside the same handler
    // (context T5). Frozen to the round's decision after the round, exactly like
    // `currentMessages()`, and counted by the same estimator over the same leading
    // instruction blocks, so the two numbers agree whenever nothing has been written.
    currentEstimatedTokens: () => number;
    // The FULL canonical transcript, in canonical order, INCLUDING disabled entries
    // (see `HarnessContextEntry`). Read this to decide what to drop; act through
    // `setIncluded`. Built on FIRST ACCESS and cached for that handler (repeat reads
    // return the same array, and its entries stay usable for `setIncluded`), and built
    // anew for EVERY handler, so a second hook sees the state the first one left.
    readonly entries: readonly HarnessContextEntry[];
    // Switch one transcript entry — or, when it belongs to a tool-call block, the
    // WHOLE block — off or on for the model. `false` stores `included: false`;
    // `true` REMOVES the key, because only `false` is ever stored (an unflagged
    // transcript stays byte-identical, and re-enabling is the exact inverse of
    // disabling). Targeting any member of a unit addresses every member of it, so a
    // request never ends up with a half-answered `tool_calls[]` or an orphan result.
    //
    // THE SAME REQUEST SEEPS IT: after the hook round, a run whose inclusion state
    // changed is re-projected before the provider call, unless a handler supplied an
    // explicit transcript (`setTranscript` or a returned `{ transcript }`), which
    // always wins. `currentMessages()` reports that re-projection from the moment the
    // write lands.
    //
    // PERSISTENCE — PRECISE SCOPE. The write lands on canonical state and is reported
    // as an `agent_message` transcript change, exactly like `postThreadMessage` and
    // `writeThreadTranscript`. That notification is the ONLY durability mechanism, and
    // it buys: later turns of the same conversation, `snapshot()`/`restore()`, and any
    // store that persists on that notification (the server's `state.json`) — in BOTH
    // execution lanes. Under `threadExecution: 'worker'` a lane used to owe the authority
    // only APPENDED SLICES, so an in-place flag change on an already-committed message
    // died with the worker process (finding F6); it now pushes that change too, as a
    // `transcript:patch` operation (pipeline T4.1, src/server/workers/lane-commit.ts): the
    // whole committed prefix, compare-and-set against the digest this lane adopted, which
    // the authority replays on the canonical harness through `patchThreadMessages` — the
    // same targeted-seam family as the append — and reports as the same `agent_message`
    // change, which is what puts it in `state.json`. A flag a plugin writes in worker mode
    // is therefore restart-durable. What the CAS costs: if canonical rewrote that prefix
    // first, the patch is REFUSED whole, the lane re-reads canonical, and this round's
    // write is dropped — the policy that made it runs again on the next `turn.before`,
    // because a whole-prefix digest cannot name which entries it disagreed about. A
    // branch run (a fork or an autoanswer, which owns an ephemeral
    // transcript) applies the flags to that copy — its own request is still filtered —
    // but has no conversation to persist them into and reports no change.
    //
    // `included` must be a boolean, strictly: `'yes'`, `1`, `0`, `null` and `undefined`
    // are refused rather than coerced, because coercing them silently inverts the
    // caller's intent (a truthy string used to RE-ENABLE). The value is checked after
    // the target and before anything is written, so a rejected call never leaves a
    // half-applied unit.
    //
    // TARGETS — three, and the first two are the shipped ones, unchanged:
    //   - an ENTRY from this round (`context.entries[i]`) — resolved by message
    //     identity against the live transcript, so it stays usable when the transcript
    //     merely GREW and is refused when the list was replaced;
    //   - a NUMBER — the index, interpreted against the CURRENT transcript;
    //   - a `messageId` STRING (context T1.5) — the durable address, looked up by id in
    //     this agent's transcript, so it resolves in a LATER round of the same
    //     conversation, after `restore()`, and even after a `replaceHistory()` that kept
    //     the entry. It names the SAME UNIT, so the cascade rule is identical. An id
    //     that is no longer in the transcript is refused like a stale entry, with the
    //     cure named. A fork's round resolves the ids its source carries, because a fork
    //     COPIES ids (T1.4) — lookup is always scoped to the one transcript this run
    //     owns, so an id repeating in another conversation is not a conflict.
    //
    // Throws a `HarnessError` for an index outside the transcript (the message names
    // the live bounds), a non-integer index, a non-boolean `included`, an empty
    // `messageId`, an entry that is not this turn's entry (including one made stale by
    // `replaceHistory`), or a `messageId` that no longer names a transcript entry.
    setIncluded: (target: HarnessContextEntry | number | string, included: unknown) => void;
    // Edit the TEXT of one canonical transcript entry in place (pipeline T3). The other
    // half of R4 — "switch inclusion, edit an entry within its role's rules, and
    // nothing else": history is never deleted (T3.3), so the only mutation besides a
    // flag is a text change.
    //
    // WHAT A PATCH MAY NAME (role-safe by construction, T3.1):
    //   - `content`   — every role. For `system`/`user`/`assistant` this is the text the
    //     model reads. For a `tool` RESULT it is the answer text, and it is the ONLY
    //     thing editable there: `toolCallId` and `name` are the PAIRING KEYS the unit
    //     resolver and the transport both trust (src/harness.ts `transcriptUnits`,
    //     src/transport/openai.ts `wireMessage`), so a patch that touches them is
    //     refused rather than re-paired.
    //   - `reasoning` — `assistant` only. It is the model's own thinking text; the
    //     transport keeps it out of the wire payload, so editing it changes what a
    //     snapshot and a UI replay carry WITHOUT changing what the next request says.
    //
    // WHAT IS REFUSED: any other key (`role`, `toolCalls`, `toolCallId`, `name`,
    // `attachments`) and `included`. A structural edit could change `toolCalls`
    // MEMBERSHIP, which would split an assistant block from its results — the exact bug
    // the exclusion unit exists to prevent (R2) — and attachments are validated bytes,
    // not text. `included` is refused here because it is a different axis with a
    // different rule (it cascades to the whole unit): use `setIncluded`. An empty patch
    // is refused too, because "I edited nothing" is nearly always a typo in the key.
    //
    // ALL-OR-NOTHING, like `setIncluded` (T3.2): the entry is resolved and the patch is
    // validated BEFORE a single field is written, so a rejected call leaves the
    // transcript byte-identical. A legal one writes IN PLACE on the canonical message
    // (identity and transcript positions preserved, which is what the running turn's
    // `resultInsertIndex` still depends on), marks the round's projection cache dirty so
    // THE SAME REQUEST carries the new text, and reports one `agent_message` transcript
    // change — the same notification, and therefore the same durability, a flag write
    // has: later turns, `snapshot()`/`restore()`, a store that persists on that
    // notification, and a fork or branch materialization that copies the text. A branch
    // run edits its own EPHEMERAL copy and reports nothing, exactly like `setIncluded`.
    //
    // THE SAME WORKER-LANE RULE APPLIES, because it is the same CLASS of write: under
    // `threadExecution: 'worker'` an in-place change to an already-committed message — a
    // flag or text — is pushed to the authority as one `transcript:patch` operation over the
    // committed prefix (pipeline T4.1), so an edit lands on canonical state, is reported
    // there, and survives a server restart exactly like an inline edit does. The refusal
    // rule is shared too: when canonical rewrote that prefix first, this round's edit is
    // dropped in favour of the writer that landed, and the policy re-derives it on the next
    // `turn.before` round.
    //
    // NO NEW MESSAGE FIELD IS INTRODUCED, which is the persistence rule that matters
    // (T3.6): the snapshot reader and the branch copier whitelist keys per role
    // (src/core/snapshot.ts, src/core/branch.ts), and `content`/`reasoning` are already
    // listed for the roles that carry them, so an edited transcript loads unchanged. A
    // future per-message field would have to be added to every one of those lists or the
    // flagged/edited transcript would stop restoring.
    //
    // Throws a `HarnessError` for a patch that is not an object, a key the role cannot
    // edit, a non-string value, a foreign entry, or an entry made stale by
    // `replaceHistory()`.
    edit: (entry: HarnessContextEntry, patch: HarnessContextEditPatch) => void;
    // Rough size of `messages` in tokens (core/context-estimate.ts). Good enough for
    // a limit check. Since compaction T5.4 it is HALF provider-exact: once this run has
    // a request that reported `usage`, the prefix is the provider's own `input` count
    // and only the text appended since that request is extrapolated at ~4 chars/token;
    // before the first report (and on a usage-blind provider) it is the same chars/4
    // estimate the UI context bar uses. It still never depends on a tokenizer the
    // harness does not own.
    //
    // ENTRY-TIME, DELIBERATELY (context T5). This is a plain value, not a getter: it is
    // the size of the projection THIS HANDLER WAS ENTERED WITH — the same list
    // `messages` shows — and it does NOT move when this handler writes a flag or edits an
    // entry. That is a shipped choice with a stated reason (src/harness.ts `context`):
    // `context-compaction` compares this number against its limit and its cooldown map,
    // and a mid-handler write changing it underneath those checks would let a compaction
    // trigger on a transcript it never measured. To see what your own write just saved,
    // call `currentEstimatedTokens()`.
    estimatedTokens: number;
    // The run's cancellation signal.
    signal: AbortSignal;
    // The api of the plugin being invoked, so a hook can create threads, register
    // tools, read its own settings, etc.
    api: HarnessPluginApi;
    // Replace the transcript for THIS request only (compaction's main move). Does
    // NOT touch committed history: the next turn projects the real transcript again
    // unless every turn rewrites it. Last non-empty value written wins.
    setTranscript: (messages: readonly HarnessMessage[]) => void;
    // Rewrite the thread's COMMITTED transcript through the existing
    // `setThreadMessages` path (validated, notifies `agent_message`). Use when the
    // history itself is too big, not just this request. Throws for a transcript the
    // snapshot reader would refuse.
    replaceHistory: (messages: readonly HarnessMessage[]) => void;
    // Park this conversation at the turn boundary: sets the thread record to
    // 'paused' and emits `thread.paused`. Await it — the run continues immediately
    // afterwards, so a plugin that wants a real pause awaits the work that unblocks
    // it and then calls resume().
    pause: () => Promise<void>;
    // Undo pause(): the record returns to 'running' when a run is still attached
    // (the normal case), to 'idle' otherwise, and emits `thread.resumed`.
    resume: () => Promise<void>;
};

// The assistant turn that was just committed. `message` is the value the provider
// returned; history already contains it.
export type HarnessTurnAfterContext = HarnessRunLifecycleContext & {
    iteration: number;
    message: HarnessAssistantMessage;
};

// `tool.before` / `tool.after` share this identity block.
export type HarnessToolLifecycleContext = HarnessRunLifecycleContext & {
    // Tool name, for filtering/labels (the call's own `name` may differ in casing).
    name: string;
};

// Background tool work for `async.pending` / `async.drained`. `pending` is the
// agent's board AFTER the transition the event reports, so `drained` carries an
// empty list and `pending` carries at least one entry.
//
// `agent` is the SCHEDULER identity, not the display name: the registered agent's
// name, or `thread:<id>` for a host thread. It is the key `api.async.pending()`,
// `api.async.wake()` and the `async-ping` plugin's per-agent timer all use, so the
// two events must report the same value for the same board or a drain cannot clear
// the timer that the launch armed.
export type HarnessAsyncLifecycleContext = {
    agent: string;
    pending: readonly HarnessPendingTool[];
};

// ---------------------------------------------------------------------------
// Turn decision pipeline (T2)
// ---------------------------------------------------------------------------

// What a `turn.before` handler may DECIDE about the run, not only rewrite. One
// boundary, four closed outcomes (T2.1 — `respond`/`retry` stay deferred: both change
// what the terminal `done` frame and the run record mean, and neither has a consumer):
//
//   - `continue` — the default: send what this round resolved and keep running. Saying
//     it out loud is how a later plugin CLEARS an earlier plugin's `pause`/`stop`
//     (precedence is last-wins by priority then registration order, T2.2 rule 4).
//   - `replace` — send `transcript` instead. Identical to the shipped `{ transcript }`
//     sugar below; it exists so one returned object can carry BOTH the request and a
//     decision about the run.
//   - `pause`  — park the CONVERSATION (the roster goes 'paused', exactly what
//     `context.pause()` does) and still send this request. A pause is a roster signal
//     for the host and other plugins, not a control-flow break: `resume()` returns it.
//   - `stop`   — end the RUN without pretending an answer exists (open decision 2):
//     the run's own abort path is taken, so the invocation records as `cancelled` and a
//     conversation reports `stopped`, `run.failed` (not `run.finished`) fires, and
//     `reason` is what the caller and `agentResult` see. Nothing this run appended
//     survives — the same rollback the `maxIterations` guard uses, so an orphan
//     assistant message is impossible.
//
// A malformed decision (unknown `action`, a `replace` with no usable transcript) is
// ignored AND reported through `report.diagnostic` (fail-open, T2.2 rule 5) — it can
// never throw into the run.
export type HarnessTurnDecision =
    | { action: 'continue' }
    | { action: 'replace'; transcript: readonly HarnessMessage[] }
    | { action: 'pause'; reason?: string }
    | { action: 'stop'; reason?: string };

// What a `turn.before` handler may return: `{ transcript }` is merged as an override of
// the request's message list, `{ decision }` is the run-level decision above, and both
// may ride in one object. `{ transcript }` alone stays the shipped sugar for
// `{ decision: { action: 'replace', ... } }` — it is a published contract and keeps
// working. Every other event ignores results.
export type HarnessHookResult = {
    transcript?: readonly HarnessMessage[];
    decision?: HarnessTurnDecision;
} | void;

// Result type per event. Only `turn.before` can contribute one.
export type HarnessLifecycleResult<E extends HarnessLifecycleEvent> =
    E extends 'turn.before' ? HarnessHookResult : void;

// Handler per event. May be async: the bus awaits handlers sequentially, so hook
// order is deterministic even when a hook does I/O (a settings read, a summarizer).
export type HarnessLifecycleHandler<E extends HarnessLifecycleEvent> = (
    payload: HarnessLifecyclePayloads[E]
) => HarnessLifecycleResult<E> | Promise<HarnessLifecycleResult<E>>;

// Per-subscription options (T1.3 / T1.4). Both optional, both default to today's
// behaviour, so an existing plugin changes nothing by not passing them.
export type HarnessHookOptions = {
    // Dispatch rank WITHIN one event: higher runs first, default 0, and STABLE within a
    // priority (registration order breaks ties). It reorders nothing ACROSS events —
    // the run's own sequence is what orders events, and a priority cannot move a
    // `tool.before` handler in front of the `turn.before` that precedes it.
    priority?: number;
    // Per-handler budget in ms. Fail-OPEN by design: a handler that outlives it is
    // dropped and reported (`report.diagnostic`), never allowed to hold the turn open.
    // Only an ASYNC handler can hit it — the timer is armed at the moment a handler
    // returns a thenable, so a synchronous handler costs no timer at all. A dropped
    // handler's late result is ignored, and a side effect it already made (a flag
    // write, say) stays made: a budget bounds the WAIT, not the damage.
    timeoutMs?: number;
};

// The subscription call, overloaded so `'*'` does NOT widen `E`: an overload keeps
// `on('turn.before', …)` payload-typed exactly as before, while a widened `E | '*'`
// would collapse the per-event typing of every named subscription (open decision 6).
// The bus uses the same shape with its own extra registration fields.
export type HarnessHookSubscribe<Options> = {
    <E extends HarnessLifecycleEvent>(
        event: E,
        handler: HarnessLifecycleHandler<E>,
        options?: Options
    ): () => void;
    (event: '*', handler: HarnessWildcardHandler, options?: Options): () => void;
};

// What a plugin is handed at setup time.
export type HarnessPluginApi = {
    // The live agent registry, including the entry agent.
    agents: Record<string, Agent>;
    // The live tool registry.
    tools: Record<string, Tool>;
    // Create and register another brain under `name`.
    createAgent: (name: string, configuration: AgentConfiguration) => Agent;
    // Register another tool under `name`.
    addTool: (name: string, definition: ToolConfiguration) => Tool;
    // Register another slash command under `name` (the leading "/" is
    // optional and stripped). Plugins apply AFTER the built-ins and
    // `configuration.commands`, so this REPLACES an existing name — the same
    // override semantics `addTool` has — which is how a plugin swaps a
    // built-in out. Throws HarnessError for an invalid name or definition.
    addCommand: (name: string, definition: Omit<HarnessCommand, 'name'>) => HarnessCommand;

    // Subscribe to one lifecycle stage — or to ALL of them with `'*'` (T1.1).
    //
    // Named: registration order is execution order (within one priority — see the
    // `priority` option), and the returned function unsubscribes (idempotent). A handler
    // that throws is skipped and the run continues (fail-open); a `turn.before` handler
    // that returns `{ transcript }` overrides the request (last non-empty wins) and one
    // that returns `{ decision }` decides what happens to the run.
    //
    // `'*'`: one handler for every event, delivered `{ event, payload }` narrowed
    // together — for an audit or telemetry plugin that must not enumerate the catalogue.
    // Two honest limits: `host.state_change` is NOT part of the fan-out (subscribe to it
    // by name if you want it; it fires on every mutation), and a wildcard handler's
    // result is always DISCARDED, including on a `turn.before` frame. A wildcard counts
    // in `live()` as the events it will actually receive, so the Plugins pane keeps
    // telling the truth about it.
    on: HarnessHookSubscribe<HarnessHookOptions>;

    // This plugin's settings, scoped to its own name and backed by
    // `configuration.pluginSettings` (or the declared defaults when absent).
    settings: HarnessPluginSettings;

    // Harness control (R3: "a plugin can trigger anything within the server").
    // Every operation is the SAME handle method a host calls, so a plugin cannot
    // reach a private path with different rules.
    threads: {
        // Live conversations (detached copies, creation order).
        list: () => readonly HarnessThreadRecord[];
        // Open an independent conversation (throws for an unknown agent).
        create: (agent: string, options?: HarnessThreadCreateOptions) => HarnessThreadRecord;
        // Purge a terminal host thread (throws while it has live work). `delete` is the
        // spelled-out contract name; `remove` is an ALIAS for the same operation, kept
        // because `delete` reads awkwardly as a property to some callers and the plugin
        // surface is easier to adopt when either spelling works.
        delete: (threadId: string) => void;
        remove: (threadId: string) => void;
        // Abort live work and mark it stopped. True when a run was aborted.
        stop: (threadId: string, reason?: string) => boolean;
        // Run one turn in a conversation and resolve to its answer.
        send: (
            threadId: string,
            input: string,
            options?: HarnessRunOptions
        ) => Promise<HarnessAssistantMessage>;
        // Queue guidance for the next safe boundary of a running thread.
        steer: (threadId: string, text: string) => HarnessThreadSteerReceipt;
        // The conversation's committed transcript (detached copy).
        messages: (threadId: string) => HarnessMessage[];
        // Wholesale transcript replacement (the compaction write primitive).
        replaceMessages: (threadId: string, messages: readonly HarnessMessage[]) => void;
        // Move the roster state of a conversation that is NOT running here.
        setStatus: (threadId: string, status: HarnessThreadStatus) => HarnessThreadRecord;
    };

    // The harness's persisted state, read-only (T3.5). This is the SAME value the host's
    // `harness.snapshot()` returns and `harness.restore()` accepts — one vocabulary, no
    // private view — and it carries the whole document (agents and their transcripts,
    // discovery state, created tools, thread records, the record stores), so a plugin
    // that wants to know what a store would save asks the host's own question.
    //
    // Safe MID-RUN: like the host's, it is a synchronous read at the instant it is
    // called and records only COMMITTED state — partial provider text is a progress
    // event, never snapshot state, and branch transcripts are ephemeral and excluded.
    // A branch run therefore snapshots the persistent harness, not its own copy.
    //
    // READ-ONLY BY CONTRACT, and honest about what that means (T3.6): this hands out a
    // detached document, so mutating the returned object changes nothing — the way to
    // change persisted state is a write the harness reports (`edit`, `setIncluded`,
    // `replaceHistory`, `replaceMessages`), not an edit of a copy. There is no
    // `api.restore`: a restore replaces the registries under a running harness and is
    // refused while any run is live, which is a host decision, not a plugin's.
    snapshot: () => HarnessSnapshot;

    // Plugin diagnostics (compaction T4.5) — the plugin's own voice on the SAME advisory
    // channel the framework uses for handler failures (`harness({ report.diagnostic })`).
    // Before it existed, a policy that DID something was as invisible as one that did
    // nothing: the compactor could withhold a dozen units and the operator had no way to
    // tell "compacted well" from "compacted wrongly and the agent is now lost".
    //
    // `diagnostic` is synchronous, never awaited, and cannot fail a run — a missing reporter
    // is a silent no-op, exactly like `report.stateChange`, and an error thrown by the sink is
    // swallowed by the harness rather than reaching the plugin that only tried to talk.
    report: {
        diagnostic: (report: HarnessPluginDiagnosticReport) => void;
    };

    // Progressive-discovery gate. Both REFUSE a core declaration (it is always in
    // context, so switching it would be a lie), exactly like `toolManage`'s
    // enable/disable operations do. `enableTool` may evict an over-cap name.
    enableTool: (name: string) => void;
    disableTool: (name: string) => void;
    // Names searchable RIGHT NOW, newest first (a detached copy).
    enabledTools: () => readonly string[];

    // Background tool work. `pending` is the wire view of the board; `wake` emits the
    // background wake for an agent (or for every agent with pending work when called
    // with no argument), which is what lets a plugin replace the heartbeat with its own
    // policy. R4: the shipped `async-ping` plugin is that policy — the scheduler no
    // longer arms any timer, so this accessor is the ONLY way a wake is produced.
    async: {
        pending: (agent?: string) => readonly HarnessPendingTool[];
        wake: (agent?: string) => void;
    };

    // Read-only configuration the plugin needs to honour legacy fields.
    // `wakeIntervalMs` is the effective background-work heartbeat resolved from
    // `harness({ wakeIntervalMs })` (default 600000), so the `async-ping` plugin can
    // keep the documented `wakeIntervalMs` behaviour through its own setting.
    config: { readonly wakeIntervalMs: number };
};
