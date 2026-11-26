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
// INCLUSION IS PER ENTRY (R8). `false` withholds THE ENTRY IT CARRIES — never a group of
// them. For a tool-call turn that means the assistant entry carrying `toolCalls` and each
// `tool` result answering one of its calls are THREE separate switches, and a policy may
// withhold the request while the answer keeps riding (the context trimmer's "truncate tool
// request" option is exactly that). The cost is stated rather than hidden: a result whose
// request entry is withheld travels as an ownerless tool message, which is what a hand-edited
// or restored transcript already produced and what an OpenAI-compatible transport accepts
// (src/transport/openai.ts `wireMessage` field-selects a `tool` message and validates no
// pairing). The projection keeps every EMITTED `tool_calls[]` fully answered by switching a
// withheld result's slot for a request-only placeholder, so a strict provider is never handed
// a half-answered block. A caller that wants a whole exchange out of the context — the
// old unit behaviour — writes every member itself; src/core/context-pruning.ts `groupUnits`
// is where that grouping lives now.
//
// THE SECOND AXIS — `reasoningIncluded?: boolean`, the assistant variant only (trimmer
// uplift T6). It follows the SAME storage rules as `included` (absent = included, only
// `false` is stored, re-enabling deletes the key) and the same whitelisting duty in
// snapshot/branch, but it does NOT exclude the entry: the entry still travels, and the
// projection resolves the flag by OMITTING `reasoning` from that entry's request copy.
// There is no unit cascade (thinking belongs to one entry) and no new transport field
// (the absence of `reasoning` IS the signal). See the field's own comment below and
// `HarnessTurnBeforeContext.setReasoningIncluded`.
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
//   - a pre-id transcript (one written before ids existed, a host-pushed message) restores with
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
          // Withholds THIS entry from the model request (see the block comment on
          // the union). For a tool-call turn that is the request entry only: the results
          // answering these calls carry their own flag and keep riding unless they say
          // otherwise, and an answered call whose result is withheld keeps its slot with a
          // request-only `withheld` placeholder so the emitted block stays pairable.
          included?: boolean;
          // THE SECOND AXIS (trimmer uplift T6): withhold this entry's THINKING from the
          // model request while the entry itself still travels. Same storage convention as
          // `included` — absent means included, `false` is the only excluding value, and
          // re-enabling DELETES the key — because the overwhelming majority of entries never
          // carry it and every pre-flag transcript must keep restoring byte-for-byte.
          //
          // It is an ASSISTANT-only field, and there is deliberately NO key on the other
          // roles: `reasoning` itself exists only here, so a flag beside it can too.
          //
          // RESOLVED OUT OF THE PROJECTION (this is what makes it different from
          // `included`). An entry flagged `false` is still EMITTED in the request — same
          // position, same `content`, same `toolCalls`, so provider pairing is untouched —
          // but its projection copy OMITS `reasoning` ENTIRELY, and no request object ever
          // carries the flag key. The transport therefore needs no new field: the wire signal
          // for "this backend does not get the thinking back" is the ABSENCE of `reasoning`
          // on a projected entry (T8 keys the transport's echo off exactly that).
          // core/agent.ts `withIncluded` + `withoutWithheldReasoning` are the two functions
          // that own those rules, and src/harness.ts `projectTranscript` is where they run.
          //
          // Canonical state, seeds, branch/fork records and snapshots DO carry the key, so
          // the decision survives a restart, a snapshot round-trip, a fork and a worker-lane
          // `transcript:patch` (core/snapshot.ts and core/branch.ts whitelist it beside
          // `included`).
          reasoningIncluded?: boolean;
          // Stable transcript address for THIS turn (see the block comment on the
          // union). It addresses this entry and nothing else: `setIncluded(id, …)` switches
          // the request entry, and the results answering its calls have ids of their own
          // (minted by src/harness.ts `insertToolMessage`) to be addressed separately.
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
          // Withholds THIS RESULT from the model request (R8). It is an entry-level
          // switch, not a statement about the block: the assistant entry that asked for this
          // call keeps travelling, and so do the sibling results. What the projection emits
          // in this call's place is a request-only `withheld` placeholder, so an emitted
          // `tool_calls[]` entry is never left without an answer (see the block comment on
          // the union).
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
    // (issue 0001) Only present for an agent built with `structured: schema`: the
    // answer parsed and VALIDATED against that schema (core/agent.ts
    // `requireStructuredAnswer`). The key is absent — never `undefined` — for every
    // other agent, so an existing consumer that compares this message key-by-key
    // sees exactly what it saw before. A turn whose answer failed the schema commits
    // NOTHING and fails with a typed error instead, so a value here is always a
    // value that passed.
    structured?: unknown;
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

// ---------------------------------------------------------------------------
// Tool-call composition progress (T2, the stalled-delegation visibility fix)
// ---------------------------------------------------------------------------
//
// THE PROBLEM THIS EXISTS FOR: a live session streamed its last `text` delta and
// then produced ZERO frames for 62 s while the model composed a four-call
// `delegate` block, after which the user aborted. Nothing in the stack could tell
// "the model is writing tool arguments" from "the request is dead", because
// tool-call fragments are merged into an accumulator with no yield
// (./transport/openai.ts) and `tool_call` events exist only AFTER the terminal
// frame. The relay leg in front of this workspace makes it worse: it withholds the
// WHOLE tool region and flushes one final SSE frame, so the harness may receive no
// data frames at all mid-block — which is why this signal is driven by what the
// harness actually sees and may legitimately be absent.
//
// ONE VOCABULARY FOR EVERY PLANE (stream, agent, harness event, display field):
//   'tool-composition' — the model is composing tool-call arguments RIGHT NOW.
//   'idle'             — nothing is in flight. The transport never emits it (its
//                        `done`/`error` frame IS the settle); only the display
//                        projection writes it, when an attempt boundary or a
//                        terminal frame clears a stale live line.
export type HarnessProgressPhase = 'tool-composition' | 'idle';

// One progress sample. DELIBERATELY AGGREGATE: slots opened and total argument
// characters, never the argument TEXT. The text is up to several kilobytes per
// block, it is model-private content the operator does not need to see a
// heartbeat of, and every harness event is journalled verbatim (server/sessions.ts
// `copyEvent`), so carrying it would multiply the turn record by the throttle rate.
// Counters answer the only question the outage raised — "is it alive, and how far
// along?" — in a fixed number of bytes.
export type HarnessToolCallProgress = {
    phase: HarnessProgressPhase;
    // Tool-call SLOTS the provider has opened in this attempt, i.e. distinct
    // `delta.tool_calls[].index` values seen so far. This is "N parallel calls are
    // being composed", the exact shape of the delegation case.
    toolCallSlots: number;
    // Total argument characters accumulated across those slots.
    argumentChars: number;
};

// Low-level events yielded by a transport. Tool calls arrive on the terminal
// frame rather than as deltas: the harness only acts once the model has stopped
// generating, and partial arguments are not executable.
//
// `progress` does NOT change that rule — it is a projection-only, INFORMATIONAL
// signal about the SAME accumulation, throttled by the transport, and no consumer
// may act on it. It never becomes a message and never affects commit semantics
// (./core/agent.ts, ./harness.ts).
export type HarnessStreamEvent =
    | { type: 'text'; delta: string }
    | { type: 'reasoning'; delta: string }
    | ({ type: 'progress' } & HarnessToolCallProgress)
    | {
          type: 'done';
          stopReason: HarnessStopReason;
          toolCalls: HarnessToolCall[];
          usage?: HarnessUsage;
      }
    // (issue 0004) `code` is a transport's MACHINE NAME for a failure a caller has
    // to act on rather than read. One value ships today — `context-overflow`, the
    // built-in transport's classification of a provider "input too long" answer —
    // and it follows the `HarnessError` code convention (util/errors.ts): the code
    // is also the FIRST TOKEN of `message`, so a model, an event consumer and a log
    // line all quote one identifiable name.
    //
    // It is optional and ABSENT for every unclassified failure, so a frame that has
    // always been `{ type: 'error', message }` keeps exactly that shape, and a
    // custom transport is free never to set it. `agent()` reads it for one decision
    // only: a frame carrying `context-overflow` is not retried (an oversized retry
    // of an oversized request is the same rejection, paid for again).
    // `details` is the transport's STRUCTURED half of the same failure (T6): the
    // redacted dial target, the failure class, the bound that expired. It is
    // optional and ABSENT for every historical frame, and `agent()` carries it onto
    // the `HarnessError` it throws, which is how a provider failure reaches the
    // `retry` event with a machine-readable endpoint instead of prose to parse.
    | { type: 'error'; message: string; code?: string; details?: unknown };

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

// ---------------------------------------------------------------------------
// Request-body extension (issue 0001)
// ---------------------------------------------------------------------------

// A host-supplied extension of the outbound chat-completion body: the ONLY way to
// reach a field the built-in transport does not model (`stream_options`, `seed`,
// `stop`, `top_k`, `parallel_tool_calls`, `tool_choice`,
// `max_completion_tokens`, a provider-specific switch) without replacing the whole
// transport.
//
// Rules the transport enforces (see ../transport/openai.ts: `serializedExtraBody`
// for the value gate, `transportBody` for the merge order):
//   - merged FIRST, so `model`, `stream`, `messages`, `tools`, the sampling fields
//     and `responseFormat` always win — an extension can add fields, never hijack
//     the request shape;
//   - the plain-object form is validated (JSON-serializable, no `undefined`/
//     function/symbol values, no cycles, ≤ MAX_EXTRA_BODY_BYTES) at TRANSPORT
//     CONSTRUCTION, so a bad value fails where it was written, exactly like
//     `resolveStream` in ../core/agent.ts does for a missing transport;
//   - the function form is called ONCE PER REQUEST, after the model, transcript and
//     tool declarations are resolved, so a host can key the extension off
//     `request.tools` or `request.signal`. Its result is validated with the same
//     rules; a rejected result is an `error` frame (the transport never throws).
export type HarnessExtraBody =
    | Record<string, unknown>
    | ((request: HarnessStreamRequest) => Record<string, unknown>);

// The `json_schema` shape: a named schema the provider must produce. `name` and
// `strict` follow the OpenAI `response_format.json_schema` contract (the name is
// what the gateway validates, so the transport checks it before sending).
export type HarnessJsonSchemaFormat = {
    jsonSchema: {
        // Provider-side identifier for the schema. OpenAI-compatible gateways
        // require `[a-zA-Z0-9_-]{1,64}`.
        name: string;
        // The schema itself, sent verbatim under `json_schema.schema`.
        schema: Record<string, unknown>;
        // Provider-enforced strict mode (every property required, additional
        // properties disallowed). Omit to leave the decision to the provider.
        strict?: boolean;
    };
};

// The response shape to require from the model. Maps onto `response_format`:
//   'text'          -> { type: 'text' }
//   'json'          -> { type: 'json_object' }
//   { jsonSchema }  -> { type: 'json_schema', json_schema: { name, schema, strict? } }
//
// This is configuration for the TRANSPORT (what goes on the wire). The agent-level
// `structured` setting reuses it and additionally validates the reply — a provider
// that ignores `response_format` still cannot hand back a value that fails the
// schema (see AgentConfiguration.structured).
export type HarnessResponseFormat = 'text' | 'json' | HarnessJsonSchemaFormat;

// The body the built-in transport assembles for one request, BEFORE a `buildBody`
// override sees it. `messages` are already wire-mapped (attachments expanded, tool
// calls paired), so an override works on provider-shaped data, not on harness
// records. Sampling fields and any `extraBody`/`responseFormat` contribution are
// already merged in, which is what makes `buildBody` an ADJUSTMENT rather than a
// re-implementation.
export type HarnessTransportBody = {
    model: string;
    stream: boolean;
    messages: Array<Record<string, unknown>>;
    // Present only when the request declares tools.
    tools?: Array<Record<string, unknown>>;
    // Sampling fields, `extraBody` keys, `response_format` and any other
    // provider-shaped field land here.
    [field: string]: unknown;
};

// Options for `openAICompatible` (issue 0001, (C)). The built-in transport already
// owns message mapping, attachment parts, video policy, aborting, error scrubbing
// and SSE chunk parsing; `buildBody` is the one seam a host with a non-OpenAI
// dialect needs, so it does not have to fork the module to change the body.
export type HarnessTransportOptions = {
    // Receives the default body and the resolved request, and returns the body to
    // serialize. It may add, rename or drop fields; it must return a plain
    // JSON-serializable object. Called once per request, and never on a request
    // whose transcript failed to map (that already ends in an `error` frame).
    buildBody?: (body: HarnessTransportBody, request: HarnessStreamRequest) => Record<string, unknown>;
};

// Endpoint configuration for the built-in transport. Ignored when an explicit
// `stream` is supplied to the agent.
export type HarnessProviderConfiguration = {
    // Base URL without the /chat/completions suffix, e.g.
    // 'http://localhost:8800/providers/private/v1'.
    baseURL: string;
    // A static key, or a getter so rotating credentials stay live per request.
    apiKey?: string | (() => string);
    // Extra headers merged over the generated ones.
    headers?: Record<string, string>;
    // Sampling fields attached to every request built by this transport.
    sampling?: HarnessSampling;
    // (issue 0001) Extra outbound request-body fields — the escape hatch for
    // `stream_options.include_usage`, `seed`, `stop`, `tool_choice`, and every
    // other provider field this type does not model. Merged FIRST, so the
    // first-class fields above (and `model`/`stream`/`messages`/`tools`) always
    // win. Validated at transport construction, not at the first prompt.
    extraBody?: HarnessExtraBody;
    // (issue 0001) Require a response shape: 'text', 'json' (json_object), or a
    // named `jsonSchema`. Serialized as `response_format`, and it beats whatever
    // `extraBody` puts under that key — a first-class setting wins over the
    // escape hatch.
    responseFormat?: HarnessResponseFormat;
    // (issue 0004) The model's input window in tokens: what this endpoint can be
    // SENT, i.e. the floor below `HarnessSampling.max_tokens` (which caps the
    // ANSWER). Set it and `agent()` refuses a request whose estimate exceeds it,
    // BEFORE the request leaves — a typed `context-overflow` failure, never
    // retried (see AgentConfiguration.maxPromptTokens for the same floor spelled
    // per agent, and for which of the two wins).
    //
    // What it is measured against: `estimateContextTokens` (core/context-estimate
    // .ts, published from the root barrel), i.e. `ceil(chars / 4)` over the
    // transcript about to be sent — the same convention as the UI context bar and
    // the `context-compaction` plugin's `contextLimit`. It is an ESTIMATE, not a
    // provider count, and it deliberately ignores attachment bytes AND the
    // request's tool schemas: both cost real tokens on the wire, so the prompt the
    // provider measures is a little larger than the number this floor compares.
    //
    // Enforced by `agent()`, not by the transport, so the same floor applies to a
    // custom `stream` too, and only the agent can keep the failure out of the retry
    // ladder. A host that calls `openAICompatible()` directly has no guard: it
    // measures with `estimateContextTokens()` itself. This is a FLOOR (a request
    // that cannot fit is a bug), not a compaction policy — replacement policy
    // lives on the plugin bus at `turn.before`.
    //
    // A positive safe integer, validated when the transport-bearing agent is
    // constructed, so a typo fails where it was written.
    contextWindow?: number;
    // ---------------------------------------------------------------------------
    // (T6) Provider TIME bounds, in milliseconds. Each one resolves
    // `this field` -> the named environment variable -> the shipped default, and
    // `0` turns that single bound off (the pre-T6 "wait forever" behaviour, kept
    // reachable for a provider that is legitimately slower than a default). They
    // exist because before T6 NOTHING bounded the outbound provider call: a gateway
    // that accepted the TCP connection and then said nothing kept the turn `running`
    // forever, and an SSE body that opened and stopped delivering was never noticed.
    // Bounds, defaults, and the operator variables are owned by
    // ../transport/provider-timeouts.ts (5 min / 5 min / 2 min by default).
    //
    // All three are validated at TRANSPORT construction, so a typo fails on the line
    // it was written rather than on the first provider hiccup.
    // ---------------------------------------------------------------------------
    // Bound on `fetch` resolving with a response HEAD (5 min default,
    // `HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS`). Cleared the moment the head
    // arrives, so it can never cut off a stream that is delivering.
    responseHeadTimeoutMs?: number;
    // Bound on the FIRST streamed frame after the head (5 min default,
    // `HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS`). Generous on purpose: a
    // large-context thinking model is legitimately silent before its first delta.
    firstTokenTimeoutMs?: number;
    // Bound BETWEEN consecutive reads of an open body (2 min default,
    // `HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS`). A streaming provider emits deltas
    // sub-second apart, so a two-minute gap means the upstream died silently.
    streamChunkTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Agent (the brain)
// ---------------------------------------------------------------------------

// ONE PRESET PREFIX TURN (U6) — the CLOSED, text-only spelling of a turn of preset agentic
// history, i.e. of a `AgentConfiguration.prefix` entry and of `Harness.setAgentPrefix`'s input.
//
// WHY A SEPARATE TYPE WHEN `prefix` ALREADY HAS ONE. `prefix` is the wider engine field: a seed
// entry may carry attachments (a user turn with an image) because the seed loop validates and
// copies them (./core/agent.ts). The SURFACE that edits a prefix — the harness wire contract
// (`HarnessPrefixTurn` in src/engine/shared/harness-api.ts, the `agent_prefixes` map of a harness
// definition, and a session's prefix override) — is deliberately text-only: a dialog edits role +
// content, never an attachment or a tool call. Spelling that as its own type is what lets the wire
// refuse a `tool` role or a `toolCall` key INSTEAD of silently dropping it.
//
// ONE VOCABULARY, NOT TWO: the generated contract re-exports THIS type (see the `ALIASES` map in
// scripts/generate-harness-contract.ts), so the wire name and the engine name are one definition
// and a rename on either side fails the assignability probe in
// src/engine/shared/harness-api.test.ts rather than drifting quietly.
//
// IT IS A DISCRIMINATED UNION (one member per role), and that shape is load-bearing twice over:
//   - it is assignable BOTH ways to `Extract<HarnessMessage, { role: 'system' | 'user' |
//     'assistant' }>` — the member for a role carries no key that variant lacks, and the variant
//     carries no REQUIRED key this member lacks — which is what lets a `HarnessPrefixTurn[]` go
//     straight into `AgentConfiguration.prefix` with no cast or conversion pass; a single object
//     with `role: 'system' | 'user' | 'assistant'` would NOT be, because a union-valued tag does
//     not select a member of a discriminated union;
//   - a `tool` turn is unrepresentable by construction, exactly as on `prefix`: a tool message is
//     the answer to an assistant `tool_calls` block a prefix never carries, so an unpaired result
//     would reach a provider as an orphan.
export type HarnessPrefixTurn =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string };

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
    // Preset agentic HISTORY — prior memory and scripted turns a spawn must start
    // with (a previous session's dialogue, a few worked examples, a recalled scene).
    // `instruction` can only say "you are X"; this says "this has already happened".
    //
    // ORDER, exactly, on every fresh seed and on every `reset()` (core/agent.ts
    // `seed`): every `instruction` system message, then `prefix`, then `messages`,
    // then whatever the conversation adds. `prefix` is the older memory, so it
    // always comes first when both are set, and legacy `messages` keeps the exact
    // position existing callers already get — nothing is deprecated and using both
    // is not an error.
    //
    // ROLES: `system | user | assistant` only. A `tool` turn is an answer to an
    // assistant `tool_calls` block this field never carries, so an unpaired result
    // would reach a provider as an orphan; the type refuses it instead of adding a
    // runtime validation rule.
    //
    // HYGIENE: identical to `messages`, because both feed one seed loop — the
    // `included` normalization, the detached copy, seeded-attachment validation and
    // runtime `messageId` minting. A caller-supplied id is dropped and re-minted, and
    // live history never aliases the caller's array or objects.
    //
    // LIFECYCLE: a new host THREAD reseeds it (same brain, new conversation), while a
    // FORK does not inject it again — a branch starts from its source's materialized
    // transcript, which already contains these turns.
    //
    // EDITABLE (U6): `Harness.setAgentPrefix(name, turns)` replaces this band of an ALREADY
    // RUNNING agent — the transcript entries seeded from it, its reset baseline, and what a
    // future host thread of that agent seeds — while the harness is idle. The turns that route
    // accepts are the narrower `HarnessPrefixTurn` (role + content only), so the wire surface
    // cannot express an attachment or a tool call even though this field can.
    prefix?: Extract<HarnessMessage, { role: 'system' | 'user' | 'assistant' }>[];
    // Seed history. Instructions and `prefix` are prepended ahead of these.
    messages?: HarnessMessage[];
    // Endpoint config for the built-in transport.
    provider?: HarnessProviderConfiguration;
    // Explicit transport. Takes precedence over `provider`.
    stream?: HarnessStream;
    // (issue 0001) Structured output: a JSON Schema this agent's ANSWER must
    // satisfy, meaning "send the schema AND hand me a validated value".
    //
    //   - on the wire it is the `response_format` of every request this agent makes
    //     (injected into the built-in transport through `provider.responseFormat`),
    //     unless the host already set `provider.responseFormat` explicitly — that
    //     explicit value wins on the wire, and `structured` still gates the reply;
    //   - the reply is parsed and validated with the same runtime gate a created
    //     tool's arguments pass (`validateSchemaValue`), and the schema itself is
    //     gated at construction with `checkToolSchemaComplexity` /
    //     `MAX_CREATED_SCHEMA_*`, so a hostile schema is rejected where the agent is
    //     built, not on the wire;
    //   - an answer that is not valid JSON, or not valid against the schema, is an
    //     explicit typed failure (`structured-output-invalid`) with NO commit to
    //     history. It is deliberately NOT a transport retry: the provider answered,
    //     so re-sending the same request would cost a request for the same shape of
    //     failure (retry belongs to the host, above the agent).
    //   - a turn that stops for tool calls, or one truncated with
    //     `stopReason: 'length'`, is not judged against the schema: the first has no
    //     answer yet, and the second is a truncation problem, not a format problem.
    //
    // With an explicit `stream` (a custom transport) the schema cannot reach the
    // wire — the agent has no way to describe the field to someone else's protocol —
    // so `structured` is validation-only there, and `provider` is ignored as it
    // always is.
    structured?: Record<string, unknown>;
    // Model-request retry policy (R1). Omit for the default: one initial attempt
    // plus ten retries with doubling waits (1s, 2s, ... 32s, then a 60 s ceiling for the
    // rest). `false` = one attempt only, for EVERY failure class — the short
    // `provider-connection` (3 attempts) and `provider-timeout` (4 attempts) ladders the
    // built-in transport triggers own their own counts and ignore a NON-ZERO
    // `maxRetries`, but zero means "never re-send" for them too. Retries re-send ONLY the
    // current model request; tools and the run are never replayed.
    retry?: HarnessRetryConfiguration;
    // (issue 0004) The pre-request context floor for this agent, in tokens: the
    // largest estimate this agent is allowed to SEND. Before a request leaves,
    // `agent()` measures the transcript about to go out with `estimateContextTokens`
    // (`ceil(chars / 4)`, published from the root barrel; transcript text only — the
    // request's tool schemas are not counted) and, when it exceeds this number,
    // fails with a typed `context-overflow` — no fetch, no retry, and the
    // message names BOTH numbers (the estimate and the window), with the pair also
    // on `HarnessError.details` as `{ estimatedTokens, contextWindow, model, agent }`
    // for a caller that has to recover.
    //
    //   - it is the same floor as `HarnessProviderConfiguration.contextWindow`,
    //     spelled per agent; when both are set THIS one wins, because an agent is
    //     the narrower scope (one brain on a shared endpoint can aim lower than the
    //     endpoint's window);
    //   - it is checked AFTER any `turn.before` replacement, so a compaction plugin
    //     gets its chance to shrink the transcript first — the floor only refuses
    //     what is still too big after policy ran;
    //   - it is a refusal, not a policy: no truncation, no summarisation, and the
    //     transcript is never trimmed to fit (`agent()` still owns no compaction).
    //     A fork and a persistent thread inherit it — both are the same brain.
    //
    // A positive safe integer, validated at construction like every other numeric
    // bound, so a typo fails where it was written rather than on the first prompt.
    maxPromptTokens?: number;
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
    // (T2) The transport's tool-call composition heartbeat, forwarded verbatim and
    // ATTEMPT-SCOPED: `progress` is never accumulated into `content`/`reasoning` and
    // is never part of a commit, so when the agent discards a failed attempt there is
    // nothing to roll back — the next attempt re-creates the transport accumulator
    // and the counters restart on their own. A consumer that does not know this
    // variant ignores it.
    | ({ type: 'progress' } & HarnessToolCallProgress)
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
          // (T6) What the transport diagnosed. Present only for a classified provider
          // failure (`provider-timeout` / `provider-connection`), and `maxAttempts`
          // below is then that CLASS's attempt count, which is not the agent's.
          provider?: HarnessProviderAttemptDiagnostics;
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
//
// `code` is the machine name of the failure class (`context-overflow`,
// `provider-timeout`, `stale-record`, …), present exactly when the throwing
// `HarnessError` carried one — `util/errors.ts` `toErrorInfo` has emitted it beside
// the message for a long time; the TYPE only ever declared `message`, which is why
// every consumer that wanted the class read it defensively or re-derived it from the
// prose with a regex. Naming it here is what lets `src/frontend/provider-diagnostics.ts`
// and the session layer branch on a field.
//
// `provider` is the transport's diagnosis of the FAILED ATTEMPT that ended the run —
// the same `HarnessProviderAttemptDiagnostics` block the `retry` event carries — and it
// is present only when the transport diagnosed one. Before this, those fields existed
// ONLY on `retry`, so a failure that was terminal BY DESIGN (a provider timeout that
// never got a retry frame, or a ladder that ended with no further retry emitted) had no
// machine-readable shape at all and the UI reconstructed class, endpoint and bound from
// the sentence. Absent for every unclassified failure, so a historical record and an
// ordinary run keep the `{ message, code? }` payload they always had.
export type HarnessErrorInfo = {
    message: string;
    code?: string;
    provider?: HarnessProviderAttemptDiagnostics;
};

// (T6) What the transport knows about ONE failed provider attempt that a UI cannot
// recover from prose. Emitted on the `retry` event as `provider`, and — since
// 2026-11-17 — on a terminal `error` event as `error.provider` (the diagnosis of the
// attempt that ended the run), and absent for every failure the transport did not
// classify (an HTTP 4xx body, a malformed frame), so an ordinary run keeps the shape it
// always had.
//
// `errorClass` is the transport's machine class — `provider-timeout` (a bound expired),
// `provider-connection` (nothing answered the dial), `provider-rejected` (a deterministic
// refusal), `provider-aborted` (a cancel reported by the provider, not by our signal) or
// the DIAGNOSTICS-ONLY `provider-transit` (the bytes died in transit and there is no
// retry code to publish — a gateway error frame with an unknown/absent code, or a body
// that closed without reporting a completion). For a coded failure it is the same value
// as `error.code`, spelled here so a consumer reads the diagnostics block as one unit;
// `provider-transit` deliberately has no `code`, because a code promises a retry policy
// and that class keeps the generic one. `url` is the DIALLED endpoint, already redacted:
// origin and path with no userinfo, query or fragment, so an API key can never be printed
// by a status bar that renders it.
export type HarnessProviderAttemptDiagnostics = {
    errorClass: string;
    url: string;
    // The effective port of the dial (the explicit port, else the scheme default).
    port?: number;
    // For `provider-timeout`: which bound expired. `stream-chunk` also covers a gateway
    // that REPORTED a timeout on an open stream (`transport/provider-timeouts.ts`
    // `providerWireFailureOf`), where no local bound expired at all.
    phase?: 'response-head' | 'first-token' | 'stream-chunk';
    // For `provider-timeout`: the bound that expired, in milliseconds. Absent when the
    // provider REPORTED the timeout — the number is the gateway's, and inventing one
    // here would be the UI quoting a bound that never existed.
    timeoutMs?: number;
    // For `provider-connection`: the errno the platform reported, when it named one.
    errno?: string;
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

// T11 (RR4 loop): ONE honest denial in a scoped run's toolRequest result.
//
// A delegation `scope.tools` is a hard allowlist, and the SAME predicate that hides a
// tool from the run's declarations and refuses its launch (`isToolInScope` in
// src/harness.ts) also decides this entry. Before T11 discovery ignored the scope and
// reported such a match under `enabled` — the model called the tool, hit the launch-gate
// refusal, re-requested, and livelocked (observed live: 135 round-trips, 5.6k→152k
// tokens). The entry is pure data so it survives JSON delivery:
//   - `name`   — the exact wire name that was requested,
//   - `reason` — why it is denied, the allowed list, and an explicit statement that
//                re-requesting will not change the answer (so the model adapts instead
//                of looping),
//   - `allowed`— the run's scope exactly as the delegation stated it (the same list the
//                launch-gate refusal names; `toolRequest` itself is always callable via
//                the escape hatch and needs no entry here).
export type ToolRequestForbidden = {
    name: string;
    reason: string;
    allowed: string[];
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
    // calling agent (delegate is omitted for an agent with no lower-ranked peer,
    // toolCreate under a rank-limited policy too), which is what keeps this list honest
    // registry dump.
    alreadyAvailable?: ToolMatch[];
    // T11 (RR4 loop): matches the CALLER'S RUN cannot use because its delegation scope
    // (`delegate`'s `scope.tools`) excludes them — for both halves of the answer: a
    // searchable match that would have been enabled, and a core match that would have
    // been reported as `alreadyAvailable`. A forbidden name is NEVER added to
    // `enabled`/`tools` and never touches the session-wide enabled set, so discovery
    // can no longer promise a capability the launch gate will refuse.
    //
    // Present only in a SCOPED run and only when at least one match is denied, so an
    // unscoped result keeps its pre-T11 shape byte for byte.
    forbidden?: ToolRequestForbidden[];
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

// Inspection view of the exact source revision behind a registered tool. A tool
// registered from an already-constructed definition has no source entry and returns
// undefined from `harness.toolSource()` — UNLESS the caller attached the source it
// was compiled from (issue 0003): `tools: { name: { tool, source } }` and
// `registerTool({ definition, moduleText })` both publish a real revision for a
// prebuilt definition, because the kernel derives it from the captured bytes without
// re-evaluating the module.
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

// The captured bytes a prebuilt definition can be installed WITH, so a shared tool
// catalogue keeps the inspect/revision/source surface (issue 0003). This is DATA
// only: the harness never re-evaluates it, so a module's top-level code does not run
// again per instance, and its syntax is transpile-checked. Deriving the record needs
// the Node source compiler (`supportsToolCompilation`); on a browser build a source
// attachment registers the definition with no source record, exactly like a bare
// prebuilt tool.
//
// The revision here is the same one `compileToolSourceModule` reported for the same
// bytes, so a catalogue compiled once and shared N times stays inspectable, and a
// replacement under the same name still changes it.
export type HarnessToolSourceAttachment = {
    // The exact entry bytes the definition was compiled from.
    moduleText?: string;
    // Or an editable entry path, resolved like `toolSources`.
    sourcePath?: string;
    // Captured local helpers for a `moduleText` revision, addressed by the exact
    // specifier the entry imports.
    dependencies?: readonly HarnessToolSourceDependency[];
};

// One entry of `configuration.tools`: either a prebuilt definition, or a definition
// plus the source revision it came from. A host that compiles its user tools once
// (issue 0002) keeps one `Record<string, Tool | { tool, source }>` and passes the
// SAME object to every harness it constructs.
export type HarnessConfiguredTool = Tool | { tool: Tool; source: HarnessToolSourceAttachment };

// A candidate accepted by the kernel's single compile/load/validate/register
// operation. `sourcePath` and `moduleText` are module forms; `source` is the
// legacy async-body form. `definition` is accepted for host/plugin compatibility:
// those definitions are already constructed and are published through the SAME
// registry commit path. With no source bytes attached a definition has no source
// revision to inspect; with `moduleText`/`sourcePath` supplied it keeps one, derived
// from those bytes without re-evaluating the module (issue 0003).
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
    // An already-constructed definition. It is published as-is (never cloned), so
    // what the host built is what the registry holds.
    definition?: Tool;
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
// What one `threadDelete` released (B5, 2026-11-13; extended 2026-11-14 for the stress
// report's #6).
//
// `deleted` is the id the CALLER named — a refusal throws, so reaching a receipt at all
// means the conversation went. `removedThreadIds` is every conversation that actually
// went, the cascade included: deletion owns the descendants of the thread it deletes, and
// a caller that just released a fan-out child needs to see the settled grandchildren leave
// with it rather than infer the state change from a roster that got shorter.
//
// `removedInvocationIds` and `removedBranchIds` are the other half of the same fact, added
// because deleting a conversation silently SHRINKS the agent-result registry: `agentManage`
// drops an invocation and `agentResult(id)` starts throwing with no indication why. The
// purge already knew exactly which records and branch lookups it was dropping — it simply
// threw those sets away — so the receipt now reports them. Both are ALWAYS present and
// empty when nothing went: "purged nothing" and "did not say" are different answers, and a
// caller that is auditing a reaping loop must be able to tell them apart. This is a report,
// not a durability change: nothing is moved out of the registry, and a released
// conversation's results stay released.
export type HarnessThreadDeleteResult = {
    deleted: string;
    removedThreadIds: string[];
    removedInvocationIds: string[];
    removedBranchIds: string[];
};

export type HarnessToolRuntime = {
    // toolRequest: select/enable catalogue matches with this harness's enabled-set
    // bound and caller-specific core view.
    //
    // T11 (RR4 loop): `scope` is the CALLING RUN's tool allowlist (a delegation's
    // `scope.tools`, carried on ToolContext.toolScope). When present, matches outside
    // it are reported under `forbidden` instead of `enabled`, and nothing about them
    // is written to the session-wide enabled set. Omitted means the historical
    // unrestricted run — the result shape is unchanged byte for byte.
    requestTools: (
        caller: Agent | undefined,
        parameters:
            | { names?: unknown; regex?: unknown; tags?: unknown; limit?: unknown }
            | unknown,
        selfCallId?: string,
        scope?: readonly string[]
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
            // I5 (2026-11-13): OPTIONAL per-child turn bound (model rounds). Like
            // `timeoutMs`, this host path is NOT schema-validated: the delegate TOOL's
            // 1..64 range bounds a model argument, while a host may name any finite count.
            // It can only LOWER the harness-wide `maxIterations`, and an omitted or
            // non-finite value means "inherit that bound".
            maxTurns?: number;
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
    // B5 (2026-11-13): the model-facing release of one finished conversation.
    //
    // `callerThreadId` is the CALLER's persistent thread, supplied by the runtime from the
    // calling run and never by a model argument. It is what scopes the delete: absent means
    // the host view (a manual `executeTool`, a plugin outside any conversation) and may
    // release any terminal conversation; present means the caller only owns its own
    // DESCENDANTS, and its current thread, an ancestor, a sibling, and another agent's
    // default conversation are all refused with the reason.
    //
    // Refusals throw (running target, running descendant, this agent's default
    // conversation, and an unknown or already-deleted id). The cascade is `deleteThread`'s,
    // shared with the host path, so both doors release exactly the same set — and the
    // receipt reports it (see HarnessThreadDeleteResult).
    threadDelete: (
        callerThreadId: string | undefined,
        threadId: string
    ) => HarnessThreadDeleteResult;
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
    // T11: the tool allowlist to carry into the call's ToolContext (the run scope a
    // nested `context.callTool` inherits, or an explicit host bound). `toolRequest`
    // reads it from the context; absent means unrestricted.
    toolScope?: readonly string[];
};

// ---------------------------------------------------------------------------
// Agent ranking — THE delegation vocabulary (rank model, 2026-11-18)
// ---------------------------------------------------------------------------
// THE MODEL IN ONE PARAGRAPH
// --------------------------
// Every agent a harness runs holds exactly ONE rank. `'A'` is the highest and
// `'Z'` the lowest; a real roster never gets past `'C'` or `'D'`. Ranks replace
// the old `primary`/`subagent`/`secondary` wording entirely — there is NO
// singleton "primary agent" any more: a harness may hold any number of Rank A
// agents, and what an agent may DO is a function of its rank and nothing else.
//
//   - TOOLS ARE NEVER RANK-GATED. Every agent has access to every registered
//     tool; the only gates left are discovery, the per-run `scope.tools`
//     allowlist, the session's withheld set, the global (provider) disable and
//     the enabled-tool cap. Rank never removes a tool from an agent.
//   - DELEGATION IS RANK-GATED, strictly downward: an agent may delegate only to
//     a registered agent whose rank is STRICTLY LOWER than its own. A Rank A
//     agent delegates to "Rank B and below"; A→A and B→B are refused, and so is
//     every upward target. Chains are therefore bounded by the number of DISTINCT
//     configured ranks (A→B→C needs three), and the kernel caps nesting at that
//     count, hard-capped at 26.
//   - THREADS ARE NOT RANK-GATED. Threading is parallel work by the SAME agent,
//     not delegation to another one, so `createThread`/`api.threads.*` and the
//     lineage rules never consult rank. A thread, branch, fork, or restored
//     conversation only PROPAGATES the source agent's rank downward.
//
// WHY A 26-MEMBER UNION INSTEAD OF A NUMBER
// -----------------------------------------
// The rank letter is what a MODEL reads (tool descriptions, agent listings, error
// messages), it is what a config author writes (`ranks: { reviewer: 'B' }`), and
// it is what a persisted record stores. A closed letter union gives all three the
// same spelling and makes an out-of-range rank a compile error at the boundary
// that invents one; `rankIndexOf` is the single place the ordering is defined.
export type AgentRank =
    | 'A'
    | 'B'
    | 'C'
    | 'D'
    | 'E'
    | 'F'
    | 'G'
    | 'H'
    | 'I'
    | 'J'
    | 'K'
    | 'L'
    | 'M'
    | 'N'
    | 'O'
    | 'P'
    | 'Q'
    | 'R'
    | 'S'
    | 'T'
    | 'U'
    | 'V'
    | 'W'
    | 'X'
    | 'Y'
    | 'Z';

// The union as DATA, highest rank first. Every consumer that has to ENUMERATE
// ranks (a validator, a config resolver computing "one rank below", a UI drawing
// a rank column) reads this table rather than re-listing letters, so the ordering
// below is the ONE ordering in the package.
export const AGENT_RANKS: readonly AgentRank[] = [
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'I',
    'J',
    'K',
    'L',
    'M',
    'N',
    'O',
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z'
];

// The ordinal of a rank: 0 = 'A' (highest), 25 = 'Z' (lowest). A LARGER index is
// a LOWER rank, which is the direction every comparison in the kernel uses.
export const rankIndexOf = (rank: AgentRank): number => AGENT_RANKS.indexOf(rank);

// THE delegation predicate, in the direction a caller asks it: may `candidate`
// receive a delegation FROM `caller`? True only when `candidate` is STRICTLY
// lower-ranked, so `isLowerRank('A', 'A')` and `isLowerRank('A', 'B')` are both
// false. Kept as a named predicate rather than an inline index comparison because
// the strictness is the rule: a same-rank peer is not a subordinate.
export const isLowerRank = (candidate: AgentRank, caller: AgentRank): boolean =>
    rankIndexOf(candidate) > rankIndexOf(caller);

// The UNTRUSTED-INPUT guard for a rank: config (`HarnessConfiguration.ranks`), a
// snapshot document, a wire body, or a tool argument. `AGENT_RANKS` is a `readonly
// AgentRank[]`, so `includes` cannot be called with an `unknown` — this is the one
// place that narrowing happens, and every boundary validator routes through it
// instead of re-spelling the letter set.
export const isAgentRank = (value: unknown): value is AgentRank =>
    typeof value === 'string' && (AGENT_RANKS as readonly string[]).includes(value);

// Who may create tools at runtime (R12). See HarnessConfiguration.toolCreation:
// 'all' (default, every agent), a rank LETTER (that rank and every rank toward A
// may create — `'A'` is the faithful replacement for the removed `'primary'`, and
// an agent of a lower rank neither sees nor can call the tool), or false (no
// model-facing toolCreate at all — the host `harness.toolCreate()` path remains
// available).
export type ToolCreationPolicy = 'all' | false | AgentRank;

// issue 0032 (2026-11-26) — WHAT A STOPPED RUN'S LEDGER ROW SAYS ABOUT ITS TOOL CALLS.
//
// THE GAP THIS CLOSES. A run that was cancelled or failed left an account of what it SAID
// (`partialContent`) and how far it got (`cancelledAtMessage`), and nothing of what it DID:
// its tool calls were rolled out of the transcript, and the row had no tally, so a post-mortem
// reading only `agentResult`/`agentManage` could not tell "fifty useful lookups" from "retried
// one doomed call fifty times". This is the bounded tally that answers it.
//
// THREE PROPERTIES, each of which is an acceptance criterion in the issue:
//   * SEPARATE from `partialContent` — 0020's leak boundary says the surviving TEXT field is
//     the run's last committed assistant text and never a tool RESULT body. This field keeps
//     that: it carries counts and tool NAMES (already public through the tool catalogue), and
//     no body, no argument, no system-instruction text.
//   * BOUNDED by construction — two fixed-width counts plus at most `TOOL_ACTIVITY_NAME_CAP`
//     (8, ./core/agent-limits.ts) `byName` entries, each name itself capped at 64 characters by
//     the tool-name rule. `truncated: true` is the cap saying "the list closed here", never
//     "the run stopped here"; AC2's whole point is that a cut list must not read as a complete one.
//   * ABSENT rather than zero-shaped — a run that registered no invocation reports NO field,
//     so "did nothing" and "reported nothing" stay distinguishable (0029's no-invented-identity
//     rule, 0032's AC6). Absence is also what keeps a `completed` row byte-identical to what it
//     was before the field existed, and therefore keeps `restore -> snapshot` idempotent.
//
// WHERE IT APPEARS. Only on the two unfinished-run surfaces that already carry
// `partialContent`: `delegate`'s envelope and `agentResult`'s cancelled/failed shape, plus the
// durable row (`HarnessAgentResultSnapshot`) and the lane archive seam that persists it. It
// never enters a message, so provider pairing, `threadRead` and every continuation path are
// untouched (AC5).
export type HarnessToolActivity = {
    // Tool invocations this run REGISTERED — calls that became scheduled work. A call refused
    // before it started (unknown tool, malformed arguments, out of scope) answers inline and is
    // not counted, which is what makes "it never got to call anything" reportable.
    calls: number;
    // Of those, how many reached a terminal task state and had their outcome handled (a result
    // delivered, an error delivered, or a release/cancellation recorded). A call still in flight
    // when the run was stopped — or released by the abandon sweep that never notifies — is
    // counted here, so `calls - settled` is the number of rounds the stop caught mid-flight.
    settled: number;
    // The `TOOL_ACTIVITY_NAME_CAP` busiest names, ordered by `calls` descending with the name
    // ascending as the tie-break, so the list is deterministic across runs and processes.
    // Present whenever the tally itself is present (a run with at least one call always earns a
    // breakdown — the NAME is the answer to the question this field exists for), capped as
    // above, and omitted only in the degenerate case where the projection had no name data at
    // all. Absence therefore never means "one tool": it means "nothing to break down".
    byName?: Array<{ name: string; calls: number }>;
    // True when the cap closed `byName` — i.e. the run used MORE distinct names than the cap
    // lists, so the list below is a top-N, not an inventory. It says nothing about the run ending.
    truncated: boolean;
};

// What a delegation hands back to its caller: the child agent's answer, not its
// transcript (history stays with the child).
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
    //
    // B2 (2026-11-13): OPTIONAL, and absent in exactly one situation — the child run
    // finished but produced NO ledger entry to point at, because its record went with a
    // thread the caller (or a cascade) deleted mid-run, or the bounded invocation ledger
    // evicted it. The field used to be `''` in that case: an address that addressed
    // nothing, next to a `status` of `'completed'` that no record supported. Absent is the
    // honest answer, and a caller that wants the answer anyway still has `content`, the
    // paging fields, and `durationMs` (this delegation's own measurement).
    invocationId?: string;
    // The persistent conversation the child ran in. Absent for an ephemeral branch.
    threadId?: string;
    // Terminal state of the child run. Absent for the same reason `invocationId` is: it is
    // read FROM the ledger record, and this result never invents one.
    status?: HarnessInvocationStatus;
    // Measured span of the child run, in milliseconds.
    durationMs: number;
    // Failure/cancellation message. Present only when `status` is not 'completed'.
    error?: string;
    // What the child had already produced when it was cancelled or failed, so a
    // post-mortem does not require the (rolled-back) transcript. Present only for a
    // non-completed run that had said something substantive.
    //
    // "Already produced" INCLUDES the answer that was still STREAMING (issue 0020,
    // AC1): a run buffers the text deltas of the model request it has open, so a child
    // cut off between "the model has begun answering" and "the answer is committed"
    // reports that sentence rather than nothing. The buffer is owned by the request in
    // flight — it is reset for every new request and for a `retry`, whose failed
    // attempt the agent discards — so this field never mixes in an earlier turn's
    // prose, a tool's output, or the delegation input. When nothing was in flight the
    // last COMMITTED assistant text is reported, which is what this field always meant.
    //
    // DURABILITY (issue 0033): this text is stored state, not a live projection — the
    // terminal record keeps it and `snapshot()` writes it, so the same invocation is
    // still readable with the same partial after `restore()` and across a server
    // restart. What NEVER survived a restart, before or after that fix, is the rest of
    // the run: its transcript (rolled back) and its tool calls and tool bodies (never
    // retained) are gone for good — 0020's leak boundary and 0032. Since 0032 the CALLS
    // themselves are no longer entirely gone: the bounded `toolActivity` tally below says
    // how many ran and which names, and it stays a tally — no call's arguments, no call's
    // result body, none of the prose those bodies carried.
    partialContent?: string;
    // How many messages the child had appended when it was cancelled/failed. This is
    // the "how far did it get" number the transcript rollback used to erase.
    cancelledAtMessage?: number;
    // issue 0032 (2026-11-26) — WHAT THE STOPPED RUN DID, beside what it said. The bounded
    // tally of its tool calls (`HarnessToolActivity`), emitted on the same non-completed runs
    // that carry `partialContent` and ABSENT (never `{ calls: 0 }`) for a run that registered
    // no invocation at all. Read it as counts and names only: it is the sibling that 0020's
    // leak boundary allows, because a tool NAME is public vocabulary while a tool RESULT body
    // is exactly what that boundary keeps out.
    toolActivity?: HarnessToolActivity;
    // D2 (2026-11-14, issues 0021/0019) — the CALL was released by `toolCancel` while the
    // child's terminal record was still readable. Present (true) on exactly one door: the
    // delivered tool message of a cancelled delegation. It separates "the caller let go of the
    // call" from "the child did not finish", which `status` alone cannot say — a child that
    // answered a moment after the release reports `status: 'completed'` next to this marker.
    // Every other door omits it, so its absence never means "not cancelled".
    callCancelled?: boolean;
    // F8 (2026-11-25, delegate-diagnostics) — DISPATCH NOTES: how this delegation was SET UP,
    // never what the child did.
    //
    // WHY IT EXISTS. A `scope.tools` entry that no tool in this harness answers to has always
    // granted nothing, and that is correct: `isToolInScope` (../harness.ts) is name-equality
    // against the registered definitions, so a misspelled name matches no definition, the
    // declaration filter simply never shows it, and the child gets the documented `forbidden`
    // answer when it asks for it. What was missing is the CALLER'S half of the same fact — the
    // typo vanished silently, so "the child could not use `red`" read like a capability the
    // child lacked rather than a name the caller mistyped. This field is the honest, additive
    // channel for that: the grant semantics and the child's disclosure are untouched, and an
    // unrecognised name is still just not granted.
    //
    // ABSENT means "nothing to add", never "checked and clean". Only the doors that dispatch
    // the child raise it (the live `delegate` result, and the `toolCancel` delivery of that
    // same call through its trace); the reprint doors rebuild the envelope from the child's
    // ledger record, which holds no scope, so they omit the key exactly as they omit `error`
    // for a completed child.
    notes?: string[];
};

// Terminal (or in-flight) state of one agent invocation. The same vocabulary
// agentManage/agentResult report, exported so a host can switch on it.
//
// DEFECT M1 (2026-11-17) — THE KEYS THAT SIT BESIDE `'running'`. Neither door publishes a
// typed envelope (`HarnessToolRuntime.agentManage: () => unknown` and
// `HarnessToolRuntime.agentResult: (parameters) => unknown`, in this file above), so this is
// the documented shape at the shared vocabulary both
// of them report from. A row whose `status` is `'running'` carries, and only then:
//   - `startedAt` — epoch milliseconds, stamped on the ledger by `registerInvocation` from
//     `RunState.startedAt`, so it names the instant the run began, not the instant it was read;
//   - `ageMs` — `max(0, now - startedAt)` computed at READ time, so a poller can tell a run
//     that just started from one that has claimed `running` for an hour. `delegate` has no
//     wall-clock bound by default (`DELEGATE_TIMEOUT_MS === +Infinity`) and retention never
//     evicts a running row, so age is the only liveness-adjacent fact available at any
//     boundary: in lane/worker mode the canonical harness never sees the worker's live runs.
// Every NON-running envelope — `completed`, `failed`, `cancelled`, and `agentResult`'s
// `status: 'empty'` — keeps its exact pre-M1 key set, and a row written by `archiveInvocation`
// or by snapshot restore has no start stamp at all (both are terminal by construction), so the
// pair is absent rather than `0` there.
//
// DEFECT B1 (2026-11-26) — THE KEYS THAT SIT BESIDE A PAGED BODY. Documented here for the same
// reason the pair above is: neither door publishes a typed envelope, so the shape of what
// `agentResult`'s paging branches return lives in this comment (src/engine/harness.ts, the
// completed branch and the failed/cancelled `partialContent` branch of `agentResultFor`). A
// body-bearing envelope always carries `content`, `contentLength`, `offset`, `limit` and
// `hasMore`, plus `nextOffset` while more remains. TWO further keys are MAY-BE-ABSENT, arrive
// together or not at all, and appear on a `completed` page and on a `failed`/`cancelled`
// `partialContent` page alike:
//   - `offsetClamped: true` — the `offset` the caller asked for EXCEEDED `contentLength`, so the
//     page starts at the end instead; `offset` echoes the position actually used, and an empty
//     `content` then means "you are at the end", not "this answer has no tail";
//   - `note` — one sentence naming the offset the page really starts at, in the same words
//     `fetch` uses for the identical clamp (`src/engine/tools/webfetch/index.ts:874`), so the two
//     paging tools explain one situation with one vocabulary.
// ABSENT means "no clamp happened", and it is deliberately the common case: an in-range offset
// never carries the flag — the surrogate-pair repair in `resultPageOf` can pull an in-range start
// back one unit, and a flag computed from `offset !== requested` would report that as an
// overshoot — and `offset === contentLength` is not an overshoot either, which is `fetch`'s own
// rule (`startOffset !== invocation.offset`). The keys are additive, so every pre-existing
// envelope keeps its exact key set; the `running` and `status: 'empty'` envelopes never carry
// them, because neither takes a window.
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

// The public, bounded description of one branch. `rank` is the source agent's
// RANK in the harness (a branch inherits its source's rank — see
// ../harness.ts `rankOf`), `tools` the wire names that branch could call. `forkDepth`
// counts ordinary forks (1 = a fork of a root); autoanswer branches inherit their
// source depth because they do not consume a general nesting level.
export type HarnessBranchSummary = {
    branchId: string;
    kind: 'fork' | 'autoanswer';
    agent: string;
    rank: AgentRank;
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
// Tool text: the same branded-envelope idea, for a MODEL PROJECTION
// ---------------------------------------------------------------------------
//
// A tool whose structured result is expensive to hand to the model verbatim
// returns `toolText(result, prose)`: the prose is what lands in the transcript,
// while `result` stays the value the server response, a UI, and a programmatic
// caller consume. `read` is the shipped user — its 256 KiB `content` string costs
// the caller's context window 2% to 15% more once JSON-escaped, plus the
// metadata of every entry, in the very budget the tool exists to protect.
//
// The unwrap is the same single boundary as the other two brands (see
// `core/tool-text.ts`): the transcript takes `text`, everything else takes
// `content`, and a tool that never calls `toolText()` is byte-for-byte unaffected.
export type ToolTextEnvelope<TContent = unknown> = {
    readonly __toolText: string;
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

// ---------------------------------------------------------------------------
// R2a/R3a — the store's OBSERVATION plane (records panel / tasks panel)
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. Everything above describes ONE collection: its `storeRev` and its
// own gap-free change window. A live panel is not one collection — it shows tasks AND
// chapters AND whatever an agent `define`s, and it needs (a) to be woken when any of
// them moves and (b) a cursor that survives a collection being added under it. That is
// a STORE-level view, and the engine is the only place that can mint it honestly, so
// these types describe the read side of the engine's store-wide feed.
//
// THE RULES:
//   - the feed is RUNTIME state (like `storeRevHighWater`), never persisted: the
//     snapshot's exact key sets (`nextId`, `collections`) do not change, and a feed
//     entry survives no restart — a client whose `since` predates the retained window
//     gets `reset: true` and re-bootstraps from the snapshot;
//   - `seq` is store-wide and monotonic ACROSS collections (one watermark for the
//     whole engine), while `rev` inside an entry stays the collection's own revision.
//     A client cursors on `seq`; the CAS token a `records` write sends is `rev`, and
//     the two are never interchangeable;
//   - the feed is FIFO-bounded by `RECORD_MAX_CHANGES` (200), the same bound the
//     per-collection windows use, so a chatty agent cannot grow this map without
//     bound;
//   - `collectionsRev` counts changes to the registered COLLECTION SET (`define`,
//     `drop`, `reset`, `restore`). It is deliberately SEPARATE from `storeRev`: adding
//     a collection mints no record event, so a delta would otherwise report a
//     watermark advance with nothing to apply. A client that sees `collectionsRev`
//     move re-reads the snapshot — that is the whole rule, and it keeps `reset`
//     meaning exactly one thing (my `since` is no longer answerable).
//
// Cross-references:
//   - ../core/records.ts    — the feed writer (`pushChange`) and the two readers
//   - ../harness.ts         — `records()` / `recordsChanges()` / `onRecordsChange()`
//   - ../server/sessions.ts — the `records.updated` stream signal
//   - ../server/api.ts      — `GET /v1/harness/sessions/{id}/records`

// One entry of the store-wide feed: the collection's change entry (`rev` is THAT
// collection's revision, as in `RecordChange`) plus the store-wide position and the
// collection it belongs to. A detached copy on every read.
export type RecordStoreChange = RecordChange & {
    seq: number;
    collection: string;
};

// What kind of store mutation a notification describes. `mutate` is the record-level
// case (patches/removals/additions of one call); `define`/`drop` are the collection-set
// cases; `reset`/`restore` replace the whole store at once, which is why they carry no
// `changes` — a client re-reads the snapshot for those.
export type RecordStoreChangeReason = 'mutate' | 'define' | 'drop' | 'reset' | 'restore';

// What the engine announces to its owner after every state-changing call. ONE
// notification per call, emitted synchronously AFTER the call committed (a rejected
// call announces nothing at all), so a 40-record batch is one signal rather than 40.
export type RecordStoreNotification = {
    // The store-wide feed watermark after this call — the value a client passes back
    // as `?since=`. 0 after a `reset`, because a reset is a clean start.
    storeRev: number;
    // Bumps only when the registered collection set moved (define/drop/reset/restore).
    collectionsRev: number;
    // Collections whose RECORDS this call created, changed, or removed, in feed order.
    // Empty for a collection-set or wholesale change, whose `reason` says what happened.
    affectedCollections: string[];
    // The feed entries this call appended (oldest first). Empty for define/drop and
    // for reset/restore, which append no record events.
    changes: RecordStoreChange[];
    reason: RecordStoreChangeReason;
};

// One collection in the store-level read model. `entries` is the whole collection
// (bounded by its own `maxRecords`) in canonical order, projected EXACTLY like a list
// page — `getOnly` fields such as a chapter body are absent, not emptied — because a
// panel list is a list, and one body is still one `get` away.
export type RecordStoreCollection = {
    name: string;
    fields: readonly RecordFieldDefinition[];
    // This collection's own revision watermark (the CAS/log domain).
    storeRev: number;
    count: number;
    entries: RecordEntry[];
};

// `records()` — the bounded snapshot a client bootstraps from.
export type RecordStoreView = {
    storeRev: number;
    collectionsRev: number;
    collections: RecordStoreCollection[];
    // The retained store-wide feed, oldest first.
    changes: RecordStoreChange[];
    // 0011 — the FLOOR of that retained feed: the store revision the oldest returned
    // event carries. A client that bootstraps here and then polls
    // `recordsChanges(lastRev)` needs the number to know whether its first `since` can be
    // answered at all — but NOT from this envelope. The key is declared and never populated
    // here: the engine's `view()` (src/core/records.ts) returns `storeRev`, `collectionsRev`,
    // `collections` and `changes` and nothing else, `Harness.records` (below) is a
    // pass-through of that call, and the REST projection (src/server/api-reads.ts
    // `recordsSnapshotOf`) maps no floor either, so a reader must treat it as ABSENT on this
    // surface. Where the engine DOES emit it: `project()` (src/core/records.ts) sets it on
    // every per-collection result — that is `RecordsResult.oldestAvailableRev?` below — and
    // `toWrapperResult()` re-spells it onto a wrapper envelope ONLY beside `changes`;
    // `changesSince()` (src/core/records.ts) sets it on every store-wide delta — that is
    // `RecordStoreDelta.oldestAvailableRev?` below. Optional because the engine's own `view()`
    // object omits the key — declaring it required would not compile — so nothing here may be
    // read as a promise that a `records()` response carries it.
    oldestAvailableRev?: number;
};

// `recordsChanges(since)` — the delta a client applies on top of its last read.
// `reset` is true when `since` is no longer answerable from the retained window: the
// caller must re-bootstrap from `records()`. `changes` still carries what IS retained,
// so a host can serve both the honest flag and the partial feed in one read.
export type RecordStoreDelta = {
    storeRev: number;
    collectionsRev: number;
    changes: RecordStoreChange[];
    reset: boolean;
    // 0011 — where to RESUME after a `reset`. `reset` alone says a gap happened; this is
    // the floor of the window the response does hold, so a poller picks the feed back up
    // at a revision instead of guessing between 0 (re-reading everything) and `storeRev`
    // (skipping what is still retained). The engine emits it on every delta
    // (src/core/records.ts `changesSince()`); a projection from an older host may omit it.
    oldestAvailableRev?: number;
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
    // M10 — present ONLY when the collection's `responseBudgetBytes` stopped this page
    // before `limit` did. Without it a budget-cut page and a limit-cut page are
    // indistinguishable, and the two call for different fixes.
    budgetTruncated?: boolean;
    // F7-4 — the DELIVERY-CAP marker, additive and present only on a page the harness cap
    // trimmed. `budgetTruncated` says a byte bound cut this page; this says WHICH one:
    // 32,768 payload bytes (`MODEL_TOOL_RESULT_BUDGET_BYTES`, core/result-budget.ts:231),
    // the most one tool result can be delivered at, rather than the collection's own
    // `responseBudgetBytes`. It is the fact a caller acts on: a page carrying it will not
    // get bigger by raising the collection's budget — only by asking for fewer rows
    // (`limit`), a narrower read, or a smaller record.
    deliveryBudgetBytes?: number;
};

// Counts are always derived from the whole collection, never from the page: a
// caller listing page 2 must still see how many records exist in total. The facet
// keys come from the collection definition.
export type RecordCounts = Record<string, number>;

// THE engine result — ONE shape for every success (Decision D): the page, the
// counts, the cursor, the collection's store revision, and (when the call is a
// single-id read or a one-record mutation) `entry`. `removed` names the records
// this call deleted. The four change keys appear only when the call passed
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
    // 0008 — the ids a batch MINTED, in mint order, and the ids it REALLY changed (a
    // no-op patch counts as nothing here, exactly as it counts as nothing for `entry`
    // and in the change log), in caller order. 0012 relaxed the gate: each key is
    // present whenever ITS OWN LIST IS NON-EMPTY, at any count, and independently of
    // the other two. Before that, a batch of one add plus one patch answered with
    // NEITHER list — `entry` needs exactly one affected record, so two ruled it out,
    // and each list was still under its "more than one" bar — which is the case that
    // left a caller unable to confirm its own write. Before 0008 there were no id
    // lists at all, so a multi-record batch capped by `limit` answered with a survivor
    // page and nothing that named what it had just written.
    //
    // The engine has emitted both since 0008 (src/core/records.ts `executeCollection`,
    // mirrored by the tasks wrapper at `toWrapperResult`); they lived in the engine's own
    // `RecordsResultAdditions` until this declaration, which is what lets a typed
    // consumer read them off the published result.
    addedIds?: string[];
    changedIds?: string[];
    // 0012 — the ids whose PATCH WAS A NO-OP: the entry named the record and wrote
    // nothing, either because every field it named already held that value or because it
    // named no field at all. Such a call is a SUCCESS with no rev bump and no change
    // event, so before this key a caller could not tell "my patch landed" from "my patch
    // changed nothing" without re-reading `rev`. Present whenever the list is non-empty,
    // on the same never-count-dependent rule as the two above, and disjoint from them:
    // an id is in `changedIds` or in `noopIds`, never both.
    noopIds?: string[];
    // R-0012 — the RESPONSE-BUDGET flag for the whole envelope, not for one key.
    // `page.budgetTruncated` says the PAGE was cut; it cannot say anything about the write
    // echoes beside it, and through an action wrapper there is no page in the answer at
    // all. So this key means one thing across every shape: `responseBudgetBytes` withheld
    // something from this response — a record body the caller asked for (a write echo
    // slimmed to `{ id, rev }`, an `ids` read's rows cut short) or the projected page. A
    // body is ABSENT when it is withheld, never emptied, so this is the key that tells a
    // caller its content is still stored rather than gone. It is absent unless true, and
    // the change feed is NOT covered by it: a feed cut says so with `changesHasMore` and
    // `droppedEvents`, and it carries no record body to lose.
    budgetTruncated?: boolean;
    // F7-4 — the DELIVERY-CAP sibling of the flag above, present only on an answer the
    // harness cap trimmed (see `RecordsPageInfo.deliveryBudgetBytes`). The two carry the
    // same number for the same reason: an action-wrapper mutation has no `page` beside it,
    // and a caller that cannot see WHICH bound fired cannot tell "raise my collection's
    // `responseBudgetBytes`" (works for a budget cut, useless for a cap cut) from "ask for
    // less per call" (the only fix for a cap cut).
    deliveryBudgetBytes?: number;
    // F7-4 — the last-resort degradation, keyed by record id: the FIELD KEYS this response
    // withheld from that record so the answer would fit the delivery cap at all. One record
    // can be bigger than 32,768 bytes by construction (`RECORD_MAX_FIELDS` 16 x
    // `RECORD_MAX_TEXT` 4,000 chars), and a record delivered with its leading fields beats
    // a record discarded. The keys are absent from the delivered entry, never emptied — the
    // `copyEntry` rule for anything the engine does not show — and this ledger is what stops
    // an absent field reading as a cleared one.
    fieldsWithheld?: Record<string, string[]>;
    // R-0013 — what the caller SENT and the record did not keep, per field: field key →
    // number of `strings` ENTRIES dropped by normalization (duplicates, and entries that
    // trim onto an earlier one). The engine used to answer an accepted write with the
    // shorter array and nothing else, so a caller that sent five traits to a `maxItems: 3`
    // field learned it lost two only by diffing the echo — and could not tell "the engine
    // dropped them" from "my own code never sent them". This is the receipt for a write
    // that SUCCEEDED; a field whose entry count is refused outright is a `field-too-many-
    // items` error, and over-long entries and out-of-range numbers were never dropped at
    // all. Present only when a write that really stored dropped something: a no-op patch
    // contributes nothing, because it stored nothing.
    droppedEntries?: Record<string, number>;
    // 0011 — the floor of THIS collection's retained change window: the oldest revision
    // `changes` can still show. It rides the feed, so it appears when `since` asked for
    // changes (and on a plain read of one collection, which reports its own window).
    // `changesTruncated`/`changesHasMore` tell a poller it lost events; this tells it
    // where it can resume.
    oldestAvailableRev?: number;
    // 0012 — HOW MANY events between `since` and `oldestAvailableRev` are gone for good
    // (`max(0, oldestAvailableRev - since - 1)`), so a reader can report "100 events
    // behind, resuming at 101" without knowing the 200-event window out of band. Present
    // ONLY beside `changes` — outside a feed there is no gap to size — and it is the
    // disclosure that stands in for a separate truncation field: `droppedEvents` plus
    // `oldestAvailableRev` answers both halves of "what did I lose, and where do I pick
    // up". Note `changesHasMore` is a different flag (the page was cut by the entry cap
    // or the byte budget, which loses nothing) and `changesTruncated` is the boolean form
    // of this one. The store-wide plane (`RecordStoreDelta`) keeps its boolean `reset`
    // and does not carry this key.
    droppedEvents?: number;
    // R6/T6.1 — `describe: true`, and since 0012 also `define`: the collection's OWN
    // definition, verbatim from the stored spec (fields with `key`, `type`, `required`,
    // `maxLength`, `maxItems`, `values`, `max`, `default`, `getOnly`, `sortable`, `count`,
    // plus `maxRecords` and `responseBudgetBytes`). The read surface had no way to ask
    // what a collection accepts, which cost a live session four failed `define` calls
    // discovering the accepted `count` shapes. On a `define` answer it is the spec the
    // engine ACCEPTED — the validated spec, with the engine defaults the caller omitted
    // filled in — so the caps a collection was just born with are readable at birth.
    definition?: RecordCollectionDefinition;
    // 0012 — `drop` only: the marker that the collection is gone. `drop` used to answer
    // with an empty page plus the name, byte-identical to a read of an EMPTY collection,
    // so the result alone could not distinguish "dropped" from "still there, empty".
    // Always `true` on success; the refusals (permanent collection, non-empty) throw.
    dropped?: true;
    // R6/T6.2 — a `records` call with NO `collection` only: every registered collection
    // name, sorted. The name list used to be reachable only by TRIGGERING the
    // `unknown-collection` refusal.
    collections?: string[];
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
    // R7/T7.1 — an equality filter for a LIST read: `{ field: value }`, AND across the
    // keys, applied BEFORE ordering and paging so the page cursors and (when present)
    // the counts describe the matching records. Values are scalars — `text`, `integer`,
    // `enum` (one of its declared values) or `boolean` — and may name a `getOnly` field,
    // which a page otherwise withholds. Mutually exclusive with `since`, because the
    // change feed is the unfiltered log of the whole collection.
    where?: Record<string, string | number | boolean>;
    // R6/T6.1 — reads the collection's own definition back, on its own (no batch).
    describe?: boolean;
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
    // R7/T7.1 — TYPE PARITY with the tool schema: `tasks.tool.ts:133` declares `where`, and
    // `toWrapperInput` forwards it (`records.ts:3129`) exactly like `RecordsParameters.where`
    // (`:1509`). Same engine control, same value type — an equality filter for a LIST read,
    // AND across the keys, applied before ordering and paging.
    where?: Record<string, string | number | boolean>;
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
//
// R1 + its T1.1 extension are why `removed` is RE-declared here instead of inherited.
// The ENGINE answers a removal with `removed?: RecordEntry[]` (`RecordsResult`, above),
// but the `batch` wrapper's projection (`toWrapperResult`, src/core/records.ts:3222-3261)
// mirrors `entry` and emits the deleted record SINGULAR, and only when exactly ONE
// record was deleted (`result.removed?.length === 1`, src/core/records.ts:3261). A
// multi-record removal through `tasks` therefore carries NO `removed` key at all, and a
// single removal carries one record — never an array. Omitting the inherited key is what
// makes the declared type match what the tool actually returns; the array stays on
// `RecordsResult`, because the un-wrapped `records` surface answers with it verbatim.
export type TaskResult = Omit<RecordsResult, 'entries' | 'counts' | 'removed'> & {
    tasks: TaskItem[];
    counts: TaskCounts;
    // The one record this call deleted; absent on every other answer, including a
    // removal of two or more records (the singular/conditional rule above).
    removed?: TaskItem;
    // M3 — the ids deleted when a call removed TWO OR MORE records. `removed` stays
    // single-typed (one record, never an array) and this stays array-typed, so a caller
    // branches on which KEY is present rather than on a union. Absent at one deletion,
    // where `removed` already names the record and its body.
    removedIds?: string[];
    // INHERITED from `RecordsResult` through the `Omit`, but worth spelling out because
    // the `batch` wrapper projects these five itself (`toWrapperResult`,
    // src/core/records.ts:3711-3745) rather than passing the engine result through:
    //   - `addedIds` / `changedIds` ride through UNCHANGED (0008) — a
    //     `tasks {"tasks":[a,b], "limit":1}` answer names the ids it minted instead of
    //     only a survivor page. Since 0012 the engine emits each list whenever it is
    //     NON-EMPTY, at any count, so a batch of one add plus one patch names BOTH ids
    //     (it used to name neither: `entry` needs exactly one affected record and each
    //     list had its own "more than one" bar);
    //   - `noopIds` (0012) rides through the same way, and the wrapper has to re-spell it
    //     explicitly or `tasks` swallows it — this branch rebuilds the envelope key by
    //     key. It names every task whose patch wrote nothing, so `tasks
    //     {"tasks":[{ id, text }], ...}` that re-sent the stored text says so instead of
    //     looking like a write;
    //   - `oldestAvailableRev` (0011) and `droppedEvents` (0012) are copied ONLY when the
    //     response carries `changes`, because both are statements ABOUT THE FEED and a
    //     wrapper read has no feed. A truncated feed without them says "you lost events"
    //     and nothing about where to resume or how many were lost.
};

// The shared CRUD action set is declared above with the engine types.

// ---------------------------------------------------------------------------
// knowledge — the CROSS-SESSION article store (T4)
// ---------------------------------------------------------------------------
//
// A knowledge article is the record shape the session outlives: a title, tags, and an
// ORDERED array of paragraphs, each separately addressable and separately versioned.
// `records` (above) owns one session and dies with it; the knowledge engine owns the
// same class of data and is persisted as JSON files by ../server/knowledge-file-store.ts,
// so a future `knowledge` wrapper is to this engine what `tasks` is to `records`: a thin
// domain shell over one engine, and nothing else needs to learn the storage rules again.
//
// THE RULES THIS SHAPE CARRIES (implemented in ../core/knowledge.ts, which owns the
// prose; these declarations only state what the engine is allowed to say):
//   - ids are uuid v4, minted by the engine (`node:crypto` `randomUUID()`). There is no
//     monotonic counter and nothing to persist beside the articles, because a uuid is
//     unique without coordination — which is the whole reason a knowledge article can
//     live in its own file. `KNOWLEDGE_UUID_PATTERN` is the one validator.
//   - TWO revisions per article, and both are CAS tokens. `KnowledgeArticle.rev` moves
//     when ANYTHING in the article moves (title, tags, order, a paragraph added or
//     removed, a paragraph body); `KnowledgeParagraph.rev` moves ONLY when that
//     paragraph's text, tags or refs really change — the records rule (records.ts:1910),
//     restated at paragraph grain so a caller can guard one paragraph instead of the
//     article.
//   - `expects` is the only conflict control (records' Decision P, carried over
//     verbatim): no locks, no leases, no claims. A stale token refuses the WHOLE
//     operation and the refusal carries the current article (records' R9), because one
//     round trip to discover a conflict is a round trip a wrapper has to pay for.
//   - `refs` point at a whole article (`paragraphId` absent) or at one paragraph in one
//     article, self-article or across. They are validated when WRITTEN and never
//     cascaded: removing a target leaves the reference in place and makes it DANGLING,
//     which the engine reports as a read-side projection (`danglingRefs`) rather than
//     rewriting history — a dangling ref is a fact about the reader's store, not a
//     corruption of the writer's.
//   - optional keys stay ABSENT, never `undefined`-valued (the records convention,
//     records.ts:304-308): the persisted JSON and the byte budget both measure the real
//     serialized shape, and a key present with `undefined` breaks a deep-equal that
//     should have matched.
//
// Cross-references:
//   - ../core/knowledge.ts               — the engine: bounds, codes, verbs, budget, feed
//   - ../server/knowledge-file-store.ts  — the JSON file layer that subscribes to `onStoreChange`
//   - ../core/records.ts                 — the in-memory pattern this mirrors
//   - ../core/result-budget.ts           — MODEL_TOOL_RESULT_BUDGET_BYTES, the outer cap

// One paragraph→paragraph (or paragraph→article) link. `articleId` is required because
// a reference must be resolvable without knowing where the READER is; `paragraphId`
// absent means the link targets the article as a whole (a "see also", not a quote).
export interface KnowledgeReference {
    articleId: string;
    /** Absent ⇒ the reference points at the whole article. */
    paragraphId?: string;
    /** Free-text reason for the link. */
    note?: string;
}

// One paragraph: the addressable unit of knowledge. `rev` is a CAS token in its own
// right (see the header), and `refs` is the paragraph's own link list — article tags
// are the article's, paragraph tags are per-paragraph.
export interface KnowledgeParagraph {
    id: string;                                        // uuid v4, engine-assigned
    text: string;
    /** Bumped only when `text` or `refs` actually changes; mirrors RecordEntry.rev. */
    rev: number;
    createdAt: string;                                 // ISO-8601
    updatedAt: string;                                 // ISO-8601
    /** Optional paragraph-level tags; article tags are the article's own. */
    tags?: string[];
    refs?: KnowledgeReference[];
}

// One article: the unit of persistence (one article = one JSON file, owned by the file
// layer) and the unit the CAS token is minted for.
export interface KnowledgeArticle {
    id: string;                                        // uuid v4
    title: string;
    createdAt: string;
    updatedAt: string;
    tags: string[];
    /** Ordered content array: index 0 first. Entries are KnowledgeParagraph. */
    content: KnowledgeParagraph[];
    rev: number;
    // THE CANONICAL HARNESS THAT CREATED THIS ARTICLE (T6) — provenance for owner-based
    // cleanup, never model input. The engine stamps it from `ToolContext.harness.knowledgeOwner`
    // (`../core/knowledge.ts` `createArticle`), a field the host sets from the canonical preset
    // name (`./server/sessions.ts` `buildHarness`). It is absent for every article created
    // outside a harness (a library consumer, a direct engine call) and for every article
    // written before this field existed; absent therefore means UNOWNED and deployment-wide,
    // which is why a harness deletion must leave those articles alone.
    //
    // No knowledge operation accepts it: `create`/`modify` key readers refuse `harness` by
    // name (the strict `OPERATION_KEYS` sets), so a model can neither forge an owner nor move
    // an existing article to another one. An update retains the value because `modify` edits a
    // `copyArticle` clone, which carries it.
    harness?: string;
}

// One compare-and-swap precondition, ARTICLE grain (a paragraph-level guard is expressed
// through the article token: a paragraph edit always moves the article rev too).
export interface KnowledgeExpect { id: string; rev: number }   // article id → article rev

// One paragraph as a CALLER describes it. A bare string is the common case (text only);
// the object form carries the paragraph's own tags and links. `id` may be pinned when
// the caller needs a stable handle (a recipe step that quotes it back); the engine
// refuses a pin that is not a uuid or is already taken.
export type KnowledgeContentInput = string | {
    text?: string;
    tags?: string[];
    refs?: KnowledgeReference[];
    /** Caller may pin an id (must be a uuid and must be unused); otherwise assigned. */
    id?: string;
};

// The whole engine surface in one discriminated union — the shape the `knowledge` tool
// forwards verbatim. NOTE the deliberate name collision a caller must not trip on: a
// `list` operation's free-text filter is keyed `search`, while `search` is also a VERB.
// `list` with no `search` term is an unfiltered listing; `search` requires the term.
export type KnowledgeOperation =
    | { verb: 'list';   search?: string; tag?: string[]; limit?: number; offset?: number }
    | { verb: 'search'; query: string; tag?: string[]; limit?: number; offset?: number }
    | { verb: 'read';   id: string; paragraphs?: string[]; from?: number; limit?: number; outline?: boolean }
    | { verb: 'create'; title: string; tags?: string[]; content?: KnowledgeContentInput[] }
    | { verb: 'modify'; id: string; title?: string; addTags?: string[]; removeTags?: string[];
        addContent?: KnowledgeContentInput[];
        setParagraphs?: { id: string; text?: string; tags?: string[]; refs?: KnowledgeReference[] }[];
        moveParagraphs?: { id: string; before?: string }[];
        removeParagraphs?: string[];
        expects?: KnowledgeExpect[] }
    | { verb: 'remove'; id: string; expects?: KnowledgeExpect[] };

// The verb list, derived from the union so a refusal and a test enumerate the SAME set
// the type carries (`KnowledgeOperation['verb']` cannot drift from the values array).
export const KNOWLEDGE_OPERATION_VERBS = [
    'list',
    'search',
    'read',
    'create',
    'modify',
    'remove'
] as const;

// ---------------------------------------------------------------------------
// The engine's read projections
// ---------------------------------------------------------------------------
//
// `list`/`search` deliberately ship NO paragraph bodies: the drill-in loop the tool
// describes (list → read outline → read paragraphs → modify) only works if the cheap
// step stays cheap, and 100 article bodies in one page is the flood the byte budget
// exists to prevent.

// The article metadata every read and every page echoes, including the CAS token.
export type KnowledgeArticleMeta = {
    id: string;
    title: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
    rev: number;
    // The article's owner, when it has one (see `KnowledgeArticle.harness`). It is a read-only
    // PROVENANCE projection: it rides the list/search/read RESULT rows (the machine view), so a
    // host can tell which harness contributed an article, and it is still never accepted on the
    // way in. The knowledge tool's model-facing prose projection keeps its own whitelist and does
    // not echo this field. Absent for unowned articles, so every pre-T6 row keeps its exact shape.
    harness?: string;
};

// What a page row is: metadata + the paragraph count, so the caller can size the drill
// in without paying for it.
export type KnowledgeArticleSummary = KnowledgeArticleMeta & {
    paragraphCount: number;
};

// One `read { outline: true }` row: everything about a paragraph EXCEPT its text, plus
// `chars` so the caller can pick the paragraph worth reading. `chars` counts UTF-16 code
// units (`String.prototype.length`), not bytes and not graphemes — it is a size hint for
// a caller choosing a window, and the byte budget is measured separately.
export type KnowledgeOutlineEntry = {
    id: string;
    rev: number;
    updatedAt: string;
    chars: number;
    tags?: string[];
    refs?: KnowledgeReference[];
};

// One page cursor, in the same shape the records pages use (offset mode only: knowledge
// ranking is by relevance, so a keyset cursor over a score is meaningless).
// `budgetTruncated` is records' M10 flag restated: without it a budget-cut page and a
// limit-cut page are indistinguishable, and the two call for different fixes.
export type KnowledgePageInfo = {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
    budgetTruncated?: boolean;
};

// `list` — a page of summaries. `counts.total` is the size of the whole MATCHED set
// (never the page), the records F9 rule: paging must not hide how much is out there.
export type KnowledgePageResult = {
    articles: KnowledgeArticleSummary[];
    counts: { total: number };
    page: KnowledgePageInfo;
};

// `search` — the same page, plus WHICH lane answered. Title hits short-circuit the
// paragraph-text scan (see the `search` section of ../core/knowledge.ts), so a caller
// that asked a question and got only title matches knows the text of every article was
// never consulted for that term; `matchedIn` is the honest statement, not a guess.
export type KnowledgeSearchResult = KnowledgePageResult & {
    matchedIn: 'title' | 'text';
};

// `read` — always the article metadata (and `rev`, the token the next write needs), then
// one of: whole `paragraphs`, a windowed `paragraphs`, a selected `paragraphs`, or an
// `outline` instead of any text.
//
// THE WINDOW KEYS, stated because two similar numbers invite a misread:
//   - `paragraphCount` is ALWAYS present and is the article's TOTAL paragraph count;
//   - `totalParagraphs` is present ONLY when the response is a subset (a `from`/`limit`
//     window, a `paragraphs` selection, or a byte-budget cut) and repeats that total in
//     the shape a paging loop reads;
//   - `truncated` is present ONLY when the response IS a subset, and is the caller's
//     signal to ask for more;
//   - `from`/`limit` are present ONLY when the response is an ordered range, i.e. for a
//     window or for a budget cut that left a prefix (a `paragraphs` SELECTION is a set
//     of ids, not a range, so it reports `truncated` without inventing an offset);
//   - `budgetTruncated` says the engine's own byte cap — not the caller's arguments —
//     made the response a subset.
// `danglingRefs` lists reference targets named by paragraphs in THIS response that no
// longer resolve (a removed article or paragraph). Sorted ascending, deduped. It is a
// projection: the stored `refs` array is left exactly as written.
export type KnowledgeReadResult = KnowledgeArticleMeta & {
    paragraphCount: number;
    paragraphs?: KnowledgeParagraph[];
    outline?: KnowledgeOutlineEntry[];
    from?: number;
    limit?: number;
    totalParagraphs?: number;
    truncated?: boolean;
    budgetTruncated?: boolean;
    danglingRefs?: string[];
};

// `create` — the committed article (bodies included: the caller just wrote them and the
// next write needs the fresh `rev`) and the paragraph ids the engine minted, in the
// order they were appended. A pinned id is in `createdIds` too: it names what the call
// produced, not what the call invented.
export type KnowledgeCreateResult = {
    article: KnowledgeArticle;
    createdIds: string[];
};

// `modify` — one key per KIND of change, present whenever that kind happened at all
// (records' 0012 rule: a caller branches on which KEY is present, never on a count).
//   - `changedIds`  — paragraphs whose `rev` actually bumped (text/tags/refs changed);
//   - `noopIds`     — paragraphs `setParagraphs` named and rewrote nothing;
//   - `movedIds`    — paragraphs whose ORDER moved (order is not content: no paragraph
//                     `rev` bump, so this is the only place the move is visible);
//   - `createdIds`  — paragraphs appended by `addContent`;
//   - `removedIds`  — paragraphs removed;
//   - `articleFields` — `title` and/or `tags` when an article-level field really moved;
//   - `noop`        — nothing at all changed, so the store, the article `rev`,
//                     `updatedAt` and the store feed are all untouched.
export type KnowledgeModifyResult = {
    article: KnowledgeArticle;
    createdIds?: string[];
    changedIds?: string[];
    noopIds?: string[];
    movedIds?: string[];
    removedIds?: string[];
    articleFields?: string[];
    noop: boolean;
    danglingRefs?: string[];
};

// `remove` — the deleted article as a summary (bodies gone; what the caller keeps as its index),
// plus `danglingRefs`: EVERY unresolvable reference target in the WHOLE store — standing links
// (`danglingAcrossStore`, `src/core/knowledge.ts:1543-1548` → `:2375`), so a survey, not a diff.
export type KnowledgeRemoveResult = {
    removed: KnowledgeArticleSummary;
    danglingRefs: string[];
};

// Every success shape, as a union and as a verb-indexed lookup so `execute` can answer a
// literal operation with its own result type instead of a union the caller must narrow.
export type KnowledgeResult =
    | KnowledgePageResult
    | KnowledgeSearchResult
    | KnowledgeReadResult
    | KnowledgeCreateResult
    | KnowledgeModifyResult
    | KnowledgeRemoveResult;

export type KnowledgeResultFor<TOperation extends KnowledgeOperation> = TOperation extends {
    verb: 'list';
}
    ? KnowledgePageResult
    : TOperation extends { verb: 'search' }
      ? KnowledgeSearchResult
      : TOperation extends { verb: 'read' }
        ? KnowledgeReadResult
        : TOperation extends { verb: 'create' }
          ? KnowledgeCreateResult
          : TOperation extends { verb: 'modify' }
            ? KnowledgeModifyResult
            : KnowledgeRemoveResult;

// The two verbs the engine also exposes as direct calls (`search(op)` / `read(op)`) —
// the operation union minus its discriminant, so a host never writes `verb` twice.
export type KnowledgeSearchParams = Omit<Extract<KnowledgeOperation, { verb: 'search' }>, 'verb'>;
export type KnowledgeReadParams = Omit<Extract<KnowledgeOperation, { verb: 'read' }>, 'verb'>;

// ---------------------------------------------------------------------------
// The store feed and the persistence seam
// ---------------------------------------------------------------------------
//
// WHY A CALLBACK AND NOT AN EMITTER — the records R2a reasoning, unchanged: one Set, no
// event names, the unsubscribe is the returned closure, and an engine with no subscriber
// builds nothing. The file layer is the only consumer that exists today, and what it
// needs is exactly one signal per COMMITTED operation: which article ids moved, which
// ones are gone (its files must be deleted, not rewritten empty), and the watermark to
// stamp its commit with.

// What kind of store change a notification describes. `reset`/`restore` replace the
// whole store at once, which is why the file layer treats them as "rewrite everything"
// rather than as a delta.
export type KnowledgeStoreChangeReason = 'create' | 'modify' | 'remove' | 'reset' | 'restore';

export type KnowledgeStoreNotification = {
    // The store watermark after this call: +1 per COMMITTED operation, and the number
    // the file layer compares against its last commit to decide whether a flush is due.
    // It is part of `KnowledgeStoreState`, so it survives a restart and never reads as
    // "behind" the files it just stamped.
    storeRev: number;
    reason: KnowledgeStoreChangeReason;
    // Article ids this call created or changed, in apply order. For `restore` that is
    // every article in the restored store; for `reset` it is none.
    affectedArticles: string[];
    // Article ids that no longer exist — the ids whose FILES must be deleted. For
    // `restore` these are the ids the live store held that the restored state lacks,
    // and for `reset` every id the live store held.
    removedArticles: string[];
};

// The whole store as one restorable value (the records `RecordsStoreState` role): a JSON
// value, because the file layer serializes it, and the exact input
// `readKnowledgeStoreState` accepts. `articles` is in CREATION order — the order a
// resumed session pages in before any ranking is applied — and every paragraph id in it
// is unique across the WHOLE state, which is what makes a `refs` target resolvable by id.
export type KnowledgeStoreState = {
    storeRev: number;
    articles: KnowledgeArticle[];
};

// The engine's options. `now` makes every date deterministic in a test (and is the only
// way to pin an `updatedAt` ordering exactly); `ids` makes uuids deterministic, which is
// the other half of a byte-budget assertion — an id is 36 characters either way, but a
// fixed one lets a test name the JSON it expects instead of sorting random keys. Both are
// engine-wide seams, validated on use: a clock that returns a non-finite number, or a
// source that returns a non-uuid, is a caller error (EKNOWLEDGE_INPUT / EKNOWLEDGE_ID),
// never a silently forged timestamp or a stored id the reader cannot re-parse.
export type KnowledgeEngineOptions = {
    now?: () => number;
    ids?: () => string;
};

// What `createKnowledgeEngine()` returns: the routed verb surface plus the persistence
// and observation hooks. `execute` is SYNCHRONOUS — the engine never awaits anything, and
// the file layer is a subscriber rather than a dependency — so `await`-ing it in an async
// tool is harmless but never required. Every success answers with a DETACHED copy: a
// caller that mutates a result cannot reach into the live store, which is the records
// copy-on-the-way-out rule (records.ts:299) restated.
export type KnowledgeEngine = {
    /** Route one operation; unknown keys and unknown verbs are refusals, not coercion. */
    execute: <TOperation extends KnowledgeOperation>(
        operation: TOperation,
        context?: ToolContext
    ) => KnowledgeResultFor<TOperation>;
    /** Every article as a summary, in the same order `list` answers with (newest change first). */
    articles: () => KnowledgeArticleSummary[];
    /** `search` without the `verb` key. */
    search: (operation: KnowledgeSearchParams) => KnowledgeSearchResult;
    /** `read` without the `verb` key. */
    read: (operation: KnowledgeReadParams) => KnowledgeReadResult;
    /**
     * Subscribe to committed store mutations. The listener runs SYNCHRONOUSLY inside the
     * mutating call, after the store is consistent; a listener that throws is IGNORED,
     * because the write already happened and a dead persistence layer must not fail a
     * model's tool call. One notification per COMMITTED operation: a rejected call and a
     * call that changed nothing announce nothing. Returns the unsubscribe function.
     */
    onStoreChange: (listener: (notification: KnowledgeStoreNotification) => void) => () => void;
    /** The whole store, detached, as the JSON value the file layer writes. */
    snapshot: () => KnowledgeStoreState;
    /** Validate-then-swap: a rejected restore leaves the live store exactly as it was. */
    restore: (state: unknown) => void;
    /** Clean start: no articles, watermark 0, and one `reset` notification. */
    reset: () => void;
};

// ---------------------------------------------------------------------------
// T7 — THE KNOWLEDGE SEAM (configuration input and the `Harness.knowledge` handle)
// ---------------------------------------------------------------------------
//
// WHAT THIS UNION IS FOR. `../core/knowledge.ts` is the engine (in-memory, sync, never
// learns where its bytes live) and `../server/knowledge-file-store.ts` is the durable
// SUBSCRIBER that keeps those bytes at `<databaseRoot>/harness/knowledge/`. A host hands
// `harness()` one of the two through `HarnessConfiguration.knowledge`, and the SAME object
// is what `Harness.knowledge` hands back to tools and hosts. This type declares NO new
// behaviour — it is the structural contract both halves already satisfy, in the layer that
// owns the `Harness` types, so `src/types` stays the leaf it always is (it never imports
// `../server`, exactly like `HarnessConfiguration.toolSettings` above reaches for
// `HarnessToolSettingsProvider` rather than for the server's settings store).
//
// WHY A STORE AND A BARE ENGINE ARE BOTH ACCEPTED — and how a caller tells them apart.
// A store-shaped member is DURABLE: `commit`/`flush`/`dispose` exist, and `directory` names
// the tree the bytes land in. A bare engine (what `harness({})` builds for itself, and what
// a server hands a build BEFORE its store has loaded) is EPHEMERAL: those members are
// absent, and nothing the model writes survives a restart. Presence is the only durability
// signal, and it is exact: `harness()` never invents a no-op `flush`, so a tool can say
// "this deployment has no knowledge store" instead of silently claiming durability.
//
// WHY THE VERB RETURNS ARE `unknown`. `KnowledgeCommitReport`/`KnowledgeDirectoryIndex` are
// declared in the SERVER layer (../server/knowledge-file-store.ts:367 and :329). Naming them
// here would make `src/types` import `src/server`, which every other type in this file
// avoids on purpose; a caller that wants the report shape imports it from
// `@underload/harness/server` (the Node barrel) and reads it off the store it loaded itself.
export type HarnessKnowledgeStore = {
    /** Absolute resolved DATABASE root (the value `knowledgeDirectoryOf` takes). */
    readonly root: string;
    /** `<root>/harness/knowledge` — the directory THIS store owns, outside every session. */
    readonly directory: string;
    /** The shared in-memory engine this store keeps durable. */
    readonly engine: KnowledgeEngine;
    /** The last index this store wrote (the concrete shape is `KnowledgeDirectoryIndex`). */
    readIndex?: () => unknown;
    /** Commit what is due. The concrete report is `KnowledgeCommitReport`. */
    commit?: (options?: { force?: boolean }) => Promise<unknown>;
    /** The awaitable durability barrier — the member that says "this knowledge is durable". */
    flush?: () => Promise<unknown>;
    /** Flush, stop the trailing timer, and unsubscribe from the engine. */
    dispose?: () => Promise<unknown>;
};

// What `HarnessConfiguration.knowledge` accepts and `Harness.knowledge` reports: the
// DURABLE store a server owns, or a bare (ephemeral) engine.
export type HarnessKnowledge = KnowledgeEngine | HarnessKnowledgeStore;

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

// D1 (2026-11-14, issue 0029, closed)
// -----------------------------------------------------------------------------------------
// An OUT-carrier the caller of `context.run` hands down with the call and the runtime fills
// IN from the child run itself: the invocation identity, and the terminal status, of exactly
// the run this call started.
//
// WHY IT EXISTS. A `delegate` envelope reports `invocationId`, `threadId` and `status`, and
// the runtime used to REDISCOVER them after the child resolved by searching the ledger for
// "the record for that agent that matches my spawning call id", falling back to "the newest
// record that did not exist when I dispatched". A tool-call id is unique only WITHIN one run,
// and a second run of the same agent can start concurrently (a host thread queues behind
// itself, not behind the agent's default conversation), so both rules can name ANOTHER run:
// the caller then reports an identity it did not run and a status it never observed. The
// child run is the only component that knows its own identity by VALUE, so it writes it here
// and the caller reads it back — the lookup becomes a verification step, and an identity that
// cannot be verified against the ledger is omitted rather than invented (the rule
// src/harness.agent-results.test.ts pins).
//
// Written by the runtime only, never by a tool: a host that omits the field keeps the
// historical behaviour untouched, and a tool that passes an object gets it filled before the
// child's first provider request (`invocationId`/`threadId`) and again on the terminal commit
// (`status`). Keys stay ABSENT until they are known — an empty string here would read like an
// address, which is precisely the fabrication this removes.
export type HarnessRunIdentity = {
    // The child's own invocation id — the same value `agentResult`/`agentManage` report, i.e.
    // `RunState.thread.id` when the run is addressable by conversation, else its run sequence.
    invocationId?: string;
    // The persistent conversation the child runs in. Absent for a parentless/nested manual
    // child (which binds no thread) and for an ephemeral branch.
    threadId?: string;
    // Terminal status the run itself reached: written when the run commits its terminal ledger
    // entry, so a caller that sees it knows the record was settled (not merely awaited).
    status?: HarnessInvocationStatus;
};

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
    // `identity` (D1, 2026-11-14) is an OUT-carrier, not an input: `delegate` passes an empty
    // object and the runtime fills it in with the identity of THE RUN THIS CALL STARTED —
    // `invocationId`/`threadId` before the child's first request, `status` on its terminal
    // commit. That is what lets a delegation report its child's identity BY VALUE instead of
    // re-discovering it from the invocation ledger, where a concurrent run of the same agent
    // can be mistaken for it (see HarnessRunIdentity). Omitted, the run behaves exactly as
    // before and nothing is written.
    run?: (
        agentName: string,
        input: string,
        options?: {
            signal?: AbortSignal;
            tools?: readonly string[];
            maxTurns?: number;
            identity?: HarnessRunIdentity;
        }
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
    // T11 (RR4 loop): the tool ALLOWLIST of the run executing this call (a delegation's
    // `scope.tools`, T28). Absent means the run is unrestricted. `toolRequest` reads
    // this so a scoped child gets an honest `forbidden` answer for a capability its
    // scope excludes, instead of an `enabled` claim the launch gate then refuses — the
    // contradiction that livelocked RR4 for 135 round-trips. The same `isToolInScope`
    // predicate (src/harness.ts) decides declarations, launch refusals, and this
    // field, so the three can never disagree again.
    toolScope?: readonly string[];
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
    // child, 3 = a grandchild, and so on. Present for every harness invocation. The
    // kernel caps it at the number of DISTINCT configured ranks (A→B→C needs three,
    // because delegation is strictly downward), and the delegate RULE is a rank
    // comparison, not a depth test: depth is the ledger the cap is enforced against.
    runDepth?: number;
    // The PERSISTENT thread this call belongs to (R2/R4). Set by the runtime from
    // RunState — never from tool arguments — so the sender identity of a
    // cross-thread message cannot be spoofed by the model. Absent for a manual
    // `executeTool` call, which runs outside any thread and names no caller agent.
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
    // `agents` brains with their `turn()` / `stream()`) throw the named `nested-run-unsupported`
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
    // IGNORED when `query` is set: section selection runs on the whole converted
    // page, so there is no window to start partway through (issue 0016 documents
    // the rule where the caller will read it — the `offset` parameter schema).
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
    // guess about where the cut landed. In query mode it appears only for the
    // byte-budget cause (see `stopReason`) — the section cap has no page position
    // that reaches what it withheld — and `offset` is ignored while `query` is
    // set, so resuming a query answer means re-fetching without `query`.
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
    // WHICH bound closed a query answer. `truncated` alone conflated two causes
    // with opposite remedies (issue 0016), so the cause is reported in the same
    // vocabulary as FileGlobStopReason / FileGrepStopReason (glob.tool.ts:140,
    // grep.tool.ts:250): 'contentBudget' = the serialized-result byte budget cut
    // the answer, and `nextOffset` is resumable; 'resultCap' = MAX_QUERY_BLOCKS
    // withheld matching sections, which paging cannot reach, so the caller narrows
    // the query instead. Absent when nothing was withheld.
    stopReason?: 'contentBudget' | 'resultCap';
    // A plain-language pointer attached when a behaviour needs explaining:
    //   - an `offset` past the end that was clamped (`offsetClamped` carries the fact;
    //     the note names the page length so the caller can tell "fully read" from
    //     "empty"),
    //   - a `query` on a headingless page that degraded to a proximity window
    //     (`matchMode: 'proximity'` carries the fact; the note says the excerpt is not
    //     a section),
    //   - math markup the native conversion FLATTENED — 'Math markup flattened; use
    //     format="html" for exact values.' (`src/tools/webfetch/native.ts`,
    //     `MATH_FLATTENED_NOTE`). This one is lossy in a way the other two are not: the
    //     values are still on the page, but the conversion wrote what TeX/MathML looked
    //     like rather than what they said, so an exact formula needs `format: 'html'`.
    // `note` holds ONE sentence, so when a window note (the clamp or the proximity
    // degradation) and the math note would both apply, the window note wins — it
    // explains the excerpt the caller is holding (src/tools/webfetch/index.ts:52-61).
    // A refusal is one of these instead: `note` never carries an error, which
    // `errorKind`/`retryable` and the thrown `HarnessError` own. Cheap to ignore, and
    // cheaper than a wasted turn.
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
//     delegations to the SAME agent get different ids — WITHIN ONE PROCESS. The
//     counter restarts with the process (and a lane worker has its own), which is
//     what `epoch` below exists to make visible (T-W8);
//   - `parentId` is omitted for a direct child of the root and set to the
//     parent invocation's thread id for anything deeper;
//   - `callId` is the parent tool call that spawned this run;
//   - `input` (the child prompt, for a row title/body) appears on the `start`
//     event only; later events carry the identity fields alone;
//   - `epoch` (T-W8) names the PROCESS that minted `id` and rides every frame of
//     the run, `start` included; it is OPTIONAL, because every turn recorded
//     before 2026-11-17 has none and a reader must never require one.
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
    // T-W8 (2026-11-17) — the per-process EPOCH that minted `id`
    // (`HARNESS_PROCESS_EPOCH`, ../core/agent-limits.ts), stamped at the same site
    // (`../harness.ts` `run.thread` / `threadIdentity` / `branchThreadOf`).
    //
    // WHY IT EXISTS: `id` is the runtime's INVOCATION counter, and that counter is per
    // process — a restarted harness begins it again, and a lane worker mints from its own
    // (../harness.ts:8235 `reserveIdentity` only ever RAISES the mark it leases). So the same
    // `id` names a DIFFERENT run after a restart, and when the spawn `callId` is recycled as
    // well the recorded frames hold nothing that separates the two runs (the residual case
    // F5 reported at ../server/turn-projector.ts `route`). The epoch is that discriminator:
    // equal ids with different epochs are two runs, always.
    //
    // OPTIONAL BY CONTRACT, and it stays that way: every turn recorded before this change
    // carries no epoch, so a reader must treat an absent field as "this producer said nothing"
    // and fall back to the shape / post-terminal-`start` rules, never as a mismatch. It is a
    // PAYLOAD-level field — the journal persists event records verbatim (./journal.ts only
    // requires `event.type`) and the store's `copyEvent` is a JSON round trip, so no line
    // schema and no snapshot version moved.
    epoch?: string;
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

// WHY A RUN reached a terminal state WITHOUT concluding — the machine-readable answer to
// "why did this stop early", carried by the two records that outlive the run:
// `HarnessThreadRecord.stopReason` (the conversation's last run) and
// `HarnessAgentResultSnapshot.stopReason` (that run's own durable ledger row).
//
// NOT the model-level `HarnessStopReason` ('stop' | 'length' | 'tool_calls', :344 above),
// which says why ONE provider request generated no more tokens. The two vocabularies are
// orthogonal and never substitute for each other: a provider `length` inside a run that
// then completed normally produces NO run-stop reason, and a run killed before its first
// request has a run-stop reason with no provider stop reason at all.
//
// The set is CLOSED: every member names a cause this harness can actually reach, so a
// consumer can branch on it without a fallback arm. Two tempting members are deliberately
// NOT here — an out-of-memory kill (a process-level event no run observes) and a context
// overflow (the compactor handles that INSIDE the run; if it cannot, the provider reports
// `api-error`). Add a member only with a producer that emits it.
export type HarnessRunStopReason =
    // The CALLER of a delegated conversation released its own tool call (`toolCancel`):
    // the child was abandoned mid-run while the parent moved on. `callCancelled: true`
    // marks the same event on the delegate's tool envelope, so the release never reads as
    // the child finishing on its own.
    | 'caller-released'
    // An operator or host stopped the thread (the stop family on the harness facade, and
    // the server's stop route): the run ended by external intent, not by failure.
    | 'user-stopped'
    // The run outlived the wall-clock bound its host set for it.
    | 'timeout'
    // The run reached the maximum number of model turns one invocation may take.
    | 'turn-cap'
    // The run's budget (tokens / cost / steps) was spent before it concluded.
    | 'budget-exhausted'
    // The provider failed a request and that failure was terminal for the run.
    | 'api-error'
    // The provider kept failing and the retry policy ran out of attempts. Distinct from
    // `api-error` because retries WERE available and every one of them failed, which is a
    // fact a caller can act on (retry elsewhere) that a first-attempt failure is not.
    | 'retries-exhausted'
    // The run died on a NETWORK / provider-transit failure, and the harness can NAME that
    // class from a structured field rather than from the error's prose. Emitted by
    // `classifyRunStopReason` (src/harness.ts) when the failure that ended the run is a
    // `provider-timeout` (a bound expired, or the provider reported a timeout on the
    // stream), a `provider-connection` (nothing answered the dial), or a CODELESS
    // provider-transit failure whose retry ladder was exhausted — a gateway error frame
    // with an unknown/absent code, or a body that closed mid-answer, each diagnosed by the
    // transport as `provider-transit`.
    //
    // WHY IT EXISTS SEPARATELY FROM `retries-exhausted`: the session layer has to answer
    // "is this conversation interrupted because the endpoint is unhealthy, or because the
    // request itself was refused?" in order to count consecutive network failures against
    // a threshold and auto-recover the thread. `retries-exhausted` says attempts ran out
    // (a refusal, a 5xx body, a malformed frame all get there too) and `api-error` says
    // even less; neither can be branched on safely. Same run, same records, one more
    // honest field.
    //
    // The restart policy is UNCHANGED by this member: a run that stops this way is still
    // marked interrupted and never replayed automatically — the difference is only that a
    // caller can now tell WHY without parsing the message.
    | 'provider-network'
    // The conversation that started this run went away (its thread was deleted or its own
    // run ended first), so the child had nobody left to answer.
    | 'parent-closed'
    // A plugin parked the conversation at a turn boundary (`turn.before`, the 'paused'
    // status documented on `HarnessThreadStatus` just below) and the run ended while it was
    // parked — the run-stop half of the park, which is why `parked` is NOT itself a thread
    // status (the status note below says where that prose came from).
    | 'plugin-parked';

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
// stopped one. A model-driven `threadSend`/`steer` does NOT — it QUEUES into the park
// (context T8), because the holder parked for ITS OWN next turn and a message that only
// arrives must not steal it. Context T11 (D1) narrows who may lift it at all: a park
// taken by a `turn.before` payload belongs to THAT plugin, and only the same plugin's
// payload pair — or an ownerless lift (a host `sendThreadInput`, or `api.threads.resume`)
// — frees it, so a second plugin's `pause()`/`resume()` wrapper in the same round can
// neither steal the park nor strand it. That is the difference from `stopped`: a park is
// not the host's intent, so its holder (or the host) may clear it and a stop may not.
// 'paused' is NEVER persisted — snapshot()
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
    // WHY this thread's LAST run ended short of its conclusion; see
    // `HarnessRunStopReason` above for the closed vocabulary and each member's cause.
    //
    // PRESENT EXACTLY WHEN that run stopped early, and the thread MUST clear it when it
    // starts a fresh turn: the reason belongs to the run that ended, not to the
    // conversation, so a stale one tells every later reader (the session tooling, the
    // server, a restored host) that current work is still doomed by the previous run.
    //
    // PRESENCE IS KEYED TO THE EXIT, NOT TO THE STATUS. An interrupted run normally comes to
    // rest at 'idle' — a timeout, an exhausted provider, an exhausted turn cap all do — and the
    // cause still has to be readable afterwards, so `status: 'idle'` with a `stopReason` is the
    // NORMAL shape of "this conversation was cut short and is waiting for its next turn", not a
    // contradiction. Nothing may infer a halt from the marker alone: the readers that refuse a
    // conversation gate on `status` first (the `threadSend` resumption rule additionally requires
    // 'stopped' and a cause outside the host-owned set). The two fields were always orthogonal,
    // and `HarnessThreadSnapshot.stopReason` below documents that for the durable half.
    //
    // Absent means "this thread has never run" or "its last run concluded" — the two are
    // told apart by `invocationId` and `status`, never by a second marker here. It is
    // DURABLE (it rides `HarnessThreadSnapshot.stopReason` below): the one fact a cancelled
    // run must not lose across a restart is WHY it stopped, because the alternative is a
    // consumer string-matching the cancellation text.
    stopReason?: HarnessRunStopReason;
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
    // W19 (2026-11-17) — the PROCESS that minted `invocationId`, and therefore the RUN that id names
    // (`../shared/run-identity.ts`; the value is `../core/agent-limits.ts` `HARNESS_PROCESS_EPOCH` of
    // the process that wrote it, the same one `HarnessThread.epoch` rides on that run's frames).
    //
    // WHY IT EXISTS. `invocationId` alone cannot say which run it names — the counter restarts with
    // the process — and this record is the store's ONLY witness for a delegated child's conversation
    // (`../server/sessions.ts noteInvocationThread` scans it, because no frame carries a CONVERSATION
    // id). A record restored from a dead process therefore used to bind a NEW epoch-keyed join to the
    // DEAD conversation that last wrote the id. With the epoch here, a restored record and a fresh run
    // that disagree about the process can be told apart, and the stale slot stops winning.
    //
    // IT TRAVELS WITH `invocationId`, NEVER AHEAD OF IT. Both writers set the pair in the same
    // statement (`src/harness.ts`: the run-start stamp, and `setThreadStatus` when it is handed an
    // invocation id), so an epoch can never describe an id it did not mint. Absent means either "this
    // conversation has never run" (no `invocationId` either) or "the id was written by a build that
    // predates this field" — a restored pre-change record — and a reader must treat that as "the
    // producer said nothing", never as a mismatch (the `isRunEpochMismatch` rule).
    //
    // ADDITIVE: `HarnessThreadSnapshot.epoch` below is optional, so a pre-change document validates,
    // restores with its exact prior meaning, and keeps restoring under the bare id.
    //
    // W22 (2026-11-17) REVERSES THE NEXT SENTENCE OF THE ORIGINAL NOTE — say it precisely, because the
    // reversal is a DECISION and not an oversight. It used to read "It is NOT a wire field: no
    // `SessionThread` / roster row reports it, so nothing a client reads changes", and that was already only
    // true of the TYPE: `../server/sessions.ts` `threadRoster` spreads the record, so the token reached the
    // roster JSON undeclared. The host/UI roster plane now DECLARES it — `SessionThread.epoch` /
    // `SessionThreadView.epoch` (../server/protocol.ts) and `ThreadSummary.epoch`
    // (../../harness-server.swagger.yaml -> ../shared/harness-api.ts) — because the client transcript join
    // (../frontend/ui/thread-transcript.ts) cannot resolve a contested recycled invocation id between two
    // otherwise-identical claimants without it (W19's residual, pinned as F3 and D2).
    //
    // W26 (2026-11-17) WIDENED THAT DECLARED PLANE ONE STEP FURTHER, and the enumeration above is incomplete
    // without it: the epoch alone is a process with no id beside it on the REST/WS roster PAGE. `ThreadSummary`
    // now declares the ID half too — `invocation_id` (the latest run) and `invocation_ids` (every run recorded
    // for this conversation, bare, capped at 64) beside `epoch` — produced by `../server/api-reads.ts`
    // `threadRowOf` / `rosterInvocationIdsOf` and carried on `thread.upsert` frames by the same shape
    // (../shared/harness-stream.ts `WsUpdateThreadUpsert.thread`). The store planes already named the ids
    // (`SessionThread.invocationIds` / `SessionThreadView.invocationIds`), which is exactly why the join worked
    // on one read and not another before W26. This is a widening of the SAME plane W22 declared, not a third
    // one: the values stay BARE (never `id\0epoch`), the pair is still one fact, and `epoch` still travels with
    // `invocation_id` and never ahead of it.
    //
    // What the reversal did NOT widen: the MODEL-facing page still strips the key
    // (../harness.ts `modelThreadRosterOf`, so the `threadList` contract the model reads is byte-identical
    // and the model is never handed a token its own schema has no parameter for), the turn/display plane
    // never carries it (`TurnSection`/`TurnSummary`, ../server/turn-projector.ts), and no wire field carries
    // the COMPOSITE — every reported id stays bare, and `../shared/run-identity.ts` `invocationIdOfRunKey`
    // remains the only strip.
    //
    // THIS IS NOT THE FORBIDDEN DOCUMENT EPOCH. `../core/agent-limits.ts` states that `snapshot()` /
    // `restore()` carry NO epoch of their own, and that rule still holds: nothing here claims an epoch
    // for the document or for the replica reading it (a restored replica is a NEW minting context). The
    // value below names the process that minted the id sitting in the SAME row — a fact about that row's
    // history, which is exactly the fact a reader cannot re-derive after a restart.
    epoch?: string;
    // DISPLAY LANE — this conversation's CURRENT lane, the number a run's recorded
    // events are stamped with (../server/protocol.ts `SessionTurnEvent.lane`, and
    // ../shared/turn-display.ts `ContextBlock.lane` inherits it).
    //
    // It is PURE UI METADATA and never model-facing: no projection of it reaches a
    // `HarnessMessage`, so the transcript the provider sees is unchanged. The context
    // bar renders one stacked row per lane, so a conversation whose lane moved (a
    // summarize compaction) paints its pre- and post-compaction segments as two rows.
    //
    //   - ABSENT means lane 0, and a write of 0 normalizes to absent (a snapshot this
    //     harness produced therefore keeps its exact pre-lane shape);
    //   - when present it is an integer >= 0, and only the SERVER mints a new one
    //     (`api.threads.setContextLane`) — a renderer groups rows by it, never invents one;
    //   - it is DURABLE (persisted on the thread record, so a restart continues the same
    //     lane), which is why a host thread carries it in `HarnessThreadSnapshot` below.
    //
    // NAMING: `contextLane` is the DISPLAY lane. The execution-lane vocabulary
    // (`ThreadLane`, `laneOf`, `pumpLane`, `max_lane_workers`, `src/server/workers/lane-*`)
    // means worker concurrency and is a different thing entirely.
    contextLane?: number;
    // SOFT DELETE — the conversation was deleted by its user and is INACTIVE: its record
    // and its transcript survive instead of being destroyed. An inactive thread is
    // EXCLUDED from the session tooling's discovery (`threadList`/`threads()`/`thread()`
    // stop naming it, so the model can no longer address it) while it stays READABLE by id
    // and stays a durable row of the snapshot. `shell`/`bash` — or any host that reads the
    // persistence directory directly — still finds it, and a restore brings it back exactly
    // as it was left.
    //
    // Nothing here destroys it. The only spelling of "permanently gone" stays what it has
    // always been: the SESSION itself is deleted, and its snapshot goes with it.
    //
    // REACTIVATION is a HOST act, and there is exactly one door: `sendThreadInput`. A caller that
    // already holds the id and is typing INTO the conversation is the actor the soft delete
    // reserves the revival to, so that call clears the pair and starts a turn in the retained
    // transcript (the server's `executeTurn` clears its own retention ledger alongside it, in the
    // same turn). Agent-facing doors keep refusing an inactive target — `threadSend` and
    // `steerThread` — because a model cannot address a conversation its roster no longer names,
    // and an answer that quietly un-deleted a conversation would be the one surprise a soft
    // delete must not produce.
    //
    // Only the literal `true` is ever stored, so ABSENT means active. That is the same
    // additive-when-absent discipline as `contextLane` above and `discovery.withheld` in
    // `HarnessSnapshot`: a thread created before this field, and every snapshot written
    // before it, keeps its exact prior shape, which is why `HARNESS_SNAPSHOT_VERSION` did
    // not move. A reactivation DELETES the key rather than writing `false` (the reader
    // tolerates a `false` by normalizing it away — ./core/snapshot.ts `readThreads`).
    inactive?: true;
    // When the thread was marked inactive, in epoch milliseconds (`Date.now()` at the
    // transition), so a host can render "deleted 3 days ago" and an operator can audit a
    // restore. Purely metadata: ordering of inactive rows uses `sequence`, never this
    // wall-clock value, so a restored session stays deterministic.
    //
    // The reader validates it INDEPENDENTLY of `inactive` (a document may keep it as
    // history after a reactivation — ./core/snapshot.ts documents why nothing is required to
    // pair here); the writer owns when the key is omitted.
    inactiveAt?: number;
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
    // THE ROWS THE CALLER MAY ACT ON — the ids `threadSend` and `threadDelete` accept from
    // this caller (its thread family: own thread, ancestors, descendants, the defaults of
    // the agents it spans, and a default's transient reply target while a run is attached).
    // Present for a caller WITH a thread, ABSENT for a threadless one (a host, a manual
    // `executeTool`), for which every row is actable and the list would only restate `threads`.
    // `threads` itself is SESSION-WIDE: a read reaches any conversation in the session, so a
    // row absent from `actOn` is still readable with `threadRead`.
    actOn?: string[];
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
    // value below names ONE operation, and each is reachable in
    // src/harness.thread-runtime.test.ts.
    //
    // THREE operations, and the target's state is the only thing that decides which one
    // happened. A caller must never have to guess between them from the receipt's other
    // fields, and the runtime must never report one while performing another:
    //
    // 'queued'  — STEERING. The target was RUNNING. The message joins the live run's queue
    //   and is applied as a user message at its next safe model boundary (never inside
    //   the request already in flight). No new run was started.
    // 'started' — CONTINUE. The target was DORMANT: `idle`. A run has been STARTED with the
    //   attributed message as its prompt. (A `paused` target never reaches this value: the
    //   `paused` branch of `postThreadMessage` queues the text and leaves the park in place, so
    //   that send reports 'queued' — only a HOST `sendThreadInput` lifts a park.)
    //   WHAT THIS VALUE DOES NOT CLAIM (corrected 2026-11-15, independent review of IT19): it is
    //   NOT a statement that the transcript was never interrupted. `resumableStop` reads the
    //   RECORD's status, and an interrupted run normally comes to rest at `idle` with its turns
    //   retained — the ordinary end of a `timeout`, an exhausted provider, or a child abandoned by
    //   its parent's `toolCancel`. A send that continues such a conversation is dormant by this
    //   door's test and therefore answers `started`. Nothing is lost by that: the cause stays
    //   readable on the row as `stopReason` (`HarnessThreadSnapshot.stopReason`), so a `started`
    //   send over an interrupted transcript is not a lost signal — `delivered` names the operation
    //   this door performed, and the record is where the interruption is read.
    //   The receipt is non-blocking: it reports the start, not the answer, and the run
    //   may still fail afterwards (its failure is reported to the harness listeners
    //   and archived for `agentResult`, not to this sender).
    // 'resumed' — RESUME. The target was `stopped` WITH ITS WORK STILL IN HAND: its run had been
    //   interrupted (cancelled, stopped, or abandoned) and its transcript was RETAINED, so the
    //   message continues that conversation instead of opening a new one. The key is exactly that
    //   pair and nothing else — `status === 'stopped'` AND a resummable `stopReason`
    //   (`isResumableStopReason`, src/harness.ts:721, over the set at `:710-718`); an `idle` row carrying the same cause
    //   answers `started`, not `resumed`. Distinguishing the two is the whole point of the third
    //   value: a cancelled thread that answers as if nothing had happened hides the interruption
    //   from the sender, while a fresh conversation on an idle thread must not look like a rescue.
    //   The retained transcript is the precondition — a stopped target with nothing to continue
    //   keeps refusing the send, as it always has.
    //
    // 'appended' is RETIRED: nothing is ever parked in a transcript without a run to
    // read it, which was the inert delivery this finding reported.
    delivered: 'queued' | 'started' | 'resumed';
    // The agent name the runtime attributed the message to.
    sender: string;
    // The sender's persistent thread id, when the sender ran inside one.
    senderThreadId?: string;
    // C1 (2026-11-13): an optional pointer at the conversation the caller PROBABLY meant.
    //
    // `agent:<name>` reads like "the conversation this agent is having", but in a session
    // that delegates, the agent's live work is a child thread and the default conversation
    // is a standing second brain. A message addressed to the default still goes to the
    // default (the receipt's `threadId` is the truth, and `delivered` describes what
    // happened there); the note names the running sibling so the caller can address IT
    // instead of waiting for an answer that will come from a different conversation.
    //
    // It appears only for a default-conversation target that has a running thread of the
    // same agent, and it never changes where the message went.
    //
    // T5/#2 (2026-11-14, stress report): the thread it names must be one the CALLER can
    // address. The scan runs across the whole session, so a bare "newest running sibling"
    // could point a scoped caller at a thread outside its family — and the send/read doors
    // refuse everything outside the family, which made the advice a promise the next call
    // would break. Candidates are filtered through the caller's family, so no addressable
    // conversation in flight means no `note` at all. The wording is unchanged.
    note?: string;
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
          // (T6) Forwards the agent-level diagnostics of the same kind (redacted
          // endpoint + failure class), and is absent for an unclassified failure — so
          // the UI can name the provider and port that is blocking a thread instead
          // of showing a spinner.
          provider?: HarnessProviderAttemptDiagnostics;
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
    // (T2) Tool-call composition heartbeat — the SAME precedent as `wakeup` above:
    // a PROGRESS event, never a transcript entry. It exists because a model
    // composing a large parallel tool block (the four-call `delegate` that read as
    // a 62 s hang) emits NO text frames and no `tool_call` until the round
    // completes, and a relay that buffers the whole tool region can withhold even
    // the fragments. Counters only — slots opened and accumulated argument
    // characters, NEVER argument text — so one frame costs a fixed number of bytes
    // in the journal.
    //
    // CONTRACT FOR READERS: informational only. Nothing may end, time out or
    // reorder a run because of it (no external clock ends a run), it must never
    // become a message, and a consumer that does not know the `type` skips it
    // without touching anything else. It is journalled in recorded order, so it
    // sits BETWEEN the `text` deltas of its attempt and BEFORE the `tool_call`
    // frames the terminal round produces.
    | ({ type: 'progress'; agent: string; thread?: HarnessThread } & HarnessToolCallProgress)
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
// it to a fresh harness built from the SAME definition (same agents, tools, entry
// agent, ranks, and policy). It is deliberately DATA ONLY:
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
//
// V3 (the rank model, 2026-11-18) is a VOCABULARY change, and the same posture applies.
// The invocation ledger rows this document persists renamed `role: 'primary' | 'subagent'`
// to `rank: AgentRank`, and the roster it restores is configured by `entry`/`ranks` rather
// than `primary`/`subagents`. A v2 document is therefore REFUSED by the version gate rather
// than translated: reading `role: 'primary'` as `rank: 'A'` would be a guess about how that
// deployment ranked its agents (v2 could hold several 'primary'-shaped rows only because the
// old kernel forbade them, and a v3 harness can hold many Rank A rows), and the repo precedent
// for a vocabulary break is "refuse, don't half-migrate" — the same call the v1 gate above
// records, and the reason ./core/snapshot.ts keeps ONE accepted version.
export type HarnessSnapshotVersion = 3;

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
    rank: AgentRank;
    kind: 'root' | 'delegation' | 'fork' | 'autoanswer';
    status: 'completed' | 'failed' | 'cancelled';
    // Completed answer text; empty for failed/cancelled. An unfinished run's text is
    // NOT stored here — it is `partialContent` below, so this field and that one carry
    // one answer string between them, never two (issue 0033).
    content: string;
    // Failure/cancellation message. Required for a non-completed result, never
    // present on a completed one.
    error?: string;
    // Issue 0033 (2026-11-14): the run's FORENSIC PARTIAL — the last assistant TEXT it
    // had committed when it was cancelled or failed. The live envelope for an
    // unfinished run has always reported this text (the `agentResult` reader pages it
    // into `content` and emits it whole as `partialContent`, src/harness.ts:4144 and
    // :4171-4173; `delegateFor` does the same at :4282-4303), but the field was
    // RUNTIME-ONLY: the snapshot projection wrote `content` (empty for a non-completed
    // run) and `restore()` rebuilt without the partial, so after a restart the durable
    // ledger answered the very same invocationId with `content: ""` and no
    // `partialContent` key at all. The caller had been shown an answer that a restart
    // then took back. This is the durability half of that envelope.
    //
    // SIZE — no new bound, and here is why that is safe rather than careless: the pair
    // is mutually exclusive by construction. `finishInvocation` (src/harness.ts:3866-3890)
    // writes `content` for a COMPLETED run and `partialContent` for every other terminal
    // state, never both, and `archiveInvocation` (:7194) keeps the same rule. So the
    // archive's answer-text footprint is unchanged — AT MOST ONE answer string per
    // record — while the record count stays bounded by AGENT_RESULT_RETENTION (64,
    // src/core/agent-limits.ts:25, enforced on both the runtime ledger and this array by
    // `readAgentResults`). `content` is already stored in full and paged on READ
    // (AGENT_RESULT_PAGE_CHARS), never truncated on write, and this field follows that
    // precedent rather than inventing one.
    //
    // Present only for a non-completed run that had said something substantive; ABSENT
    // (never empty) otherwise, exactly like both emission sites. "Said something"
    // covers the answer the run was still STREAMING when it was cut off, not only text
    // it had committed (issue 0020, AC1) — the capture point is `runAgentCore`'s
    // cancellation catch, which reads the per-request buffer first and the committed
    // transcript second, so the fresher evidence wins. NEVER widened to tool calls or tool
    // RESULT BODIES: what a rolled-back run deliberately does not retain is the individual
    // calls and the text their results carried (0020's leak boundary) — that is exactly why
    // this field stayed text-only. What IS retained on a stopped run is the BOUNDED
    // `toolActivity` tally below (`calls`, `settled`, and up to `TOOL_ACTIVITY_NAME_CAP` tool
    // names, 0032); counts and names clear that boundary, result bodies do not.
    partialContent?: string;
    // How many messages that run had committed when it stopped. Optional for the same
    // reason as `partialContent`, and absent on a completed record: an envelope that
    // reports a partial but not the position it was reached at is only half an answer,
    // so the pair travels together (issue 0033). Counts committed messages; it is NOT a
    // measure of progress (0022).
    cancelledAtMessage?: number;
    // issue 0032 (2026-11-26) — the fourth forensic member of a run that did not finish. The
    // bounded tally of its tool calls (`HarnessToolActivity`: two counts, a capped per-name
    // breakdown, and the flag that says when the cap closed the list), written on the SAME
    // non-completed rows that carry `partialContent` and ABSENT — never `{ calls: 0 }` — when the
    // run registered no invocation (0032's AC6, the same no-invented-identity rule as 0029).
    //
    // WHY IT IS ALLOWED BESIDE A LEAK BOUNDARY THAT FORBIDS TOOL BODIES. 0020's AC3 keeps
    // `partialContent` a text field precisely because a tool RESULT body is what that boundary
    // excludes, and this field never carries one: two integers, and tool NAMES, which are already
    // public through the tool catalogue and the `toolRequest` vocabulary. That is also why it is a
    // SEPARATE field rather than a wider `partialContent` — 0032 weighed "widen the text field"
    // and rejected it for exactly this reason.
    //
    // BOUNDED, so the retention argument above still holds. At most `TOOL_ACTIVITY_NAME_CAP`
    // (8, src/core/agent-limits.ts) entries whose names are themselves capped at 64 characters by
    // the tool-name rule, so a row grows by a fixed amount, never by a transcript.
    //
    // ABSENT ON A `completed` ROW, on pain of an unrestorable document: `../core/snapshot.ts`
    // refuses a completed row that carries the key (the `stopReason` precedent beside it), because
    // the next projection would drop the key and `restore -> snapshot` would stop being
    // idempotent. The writer drops it there for the same reason `error` is dropped.
    toolActivity?: HarnessToolActivity;
    // WHY the run reached a non-concluded terminal state (../core/snapshot.ts refuses a
    // value outside `HarnessRunStopReason`; the live half is
    // `HarnessThreadRecord.stopReason`). The forensic trio's last member (and the tally above is
    // 0032's fourth member, counted alongside it rather than replacing it):
    // `partialContent` says what it SAID, `cancelledAtMessage` says HOW FAR it got, and this
    // says WHY it stopped — which until now survived only as English prose in `error`, so a
    // caller could not tell "the parent released the call" from "the provider ran out of
    // retries" without string-matching a message it did not write.
    //
    // OPTIONAL and additive: a pre-feature row has no key and restores with its exact prior
    // meaning, so the schema version did not move (this file's header, and the
    // `partialContent`/`cancelledAtMessage` note on `HarnessSnapshot.agentResults`).
    //
    // It is meaningful only for a NON-completed status, exactly like `error` and the
    // forensic pair: a completed run concluded, so it has no stop reason to record, and the
    // writer omits the key there for the same reason it drops `error` on a completed row.
    stopReason?: HarnessRunStopReason;
    // Issue 0033 / 0024 (2026-11-14): the PERSISTENT conversation this invocation ran in, when
    // one owns it. The field has always existed on the in-memory record (harness.ts
    // `AgentInvocationRecord.threadId`), on the lane archive payload, and on
    // `HarnessInvocationArchiveInput`, and `purgeThread`'s delete cascade is a predicate on
    // exactly it — but the SNAPSHOT never carried it, so the owner was the one fact a restart
    // could not survive: a conversation deleted after a reload lost its archived results to the
    // cascade while the same delete before the reload removed them. This closes the
    // type/validator disagreement the issue records: `readAgentResults` now accepts and validates
    // the key (src/core/snapshot.ts) instead of refusing a row that carries it.
    //
    // Optional because a run CAN resolve no conversation at all: `runThreadId` (src/harness.ts
    // :12277) leaves the field off for an ephemeral branch whose parent had none and for a brain
    // outside the registry. It is NOT off for an ordinary root run — that one belongs to the
    // agent's default conversation, so the row names `agent:<name>` and the cascade still matches
    // it after a reload. ABSENT means "no owner", never "unknown owner", and an empty string is
    // rejected at the load boundary. Legal on a completed result, unlike the forensic pair: a
    // finished turn still belongs to its thread.
    threadId?: string;
    // W19 (2026-11-17) — THE LEDGER GENERATION this row belongs to: the process epoch that minted
    // `invocationId` (`../core/agent-limits.ts` `HARNESS_PROCESS_EPOCH`, the same value
    // `HarnessThread.epoch` rides on a frame). It is a bare epoch STRING, never the composite run
    // key, and it is the only fact that tells two rows with the SAME `invocationId` apart: the id is a
    // per-process counter, so after a restart one document can legitimately hold `15` twice, once per
    // process, and neither row is the other's replacement.
    //
    // WHY IT IS PERSISTED AT ALL: `restore()` re-keyed every row by the bare id, so the first restart
    // after this fix kept both rows in memory (different run keys) while the SECOND restart collapsed
    // them again — the durable ledger would re-lose the older archive on the next save/load cycle.
    // Writing the epoch here is what makes the repair survive more than one generation.
    //
    // OPTIONAL AND ADDITIVE, AND THE ONLY THING THAT DECIDES THE RESTORE KEY: a row written before
    // this field has no epoch, restores under its BARE id exactly as it does today (no re-keying, no
    // migration, no version bump — the discipline stated in this file's header), and it keeps
    // resolving by that bare key for every later reader, because the read order is always "the
    // current process's run, then the bare id". `../core/snapshot.ts` accepts and validates the key
    // (it must, or a row carrying it would refuse to load) and moves the duplicate-id check onto the
    // RUN rather than the id — the same rule stated by the writer and by the reader, so a document
    // cannot claim one run twice.
    epoch?: string;
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
    rank: AgentRank;
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
    // Review finding #5 / issues 0020 + 0033 (2026-11-14): the FORENSIC PARTIAL of a run that did
    // not finish, and how far it got. The lane replica already holds both — `finishInvocation`
    // records them on the terminal transition (src/harness.ts:3886-3893, the streamed-text capture
    // at :11927-11938) and the snapshot projection writes them (:12810-12813) — but until now the
    // archive seam named neither, so `archiveInvocation` forced `content: ''` and the canonical
    // reader was told a cancelled lane child said nothing. WITHOUT any restart involved: the loss
    // is in this payload, not in persistence.
    //
    // Same rules as the persisted row (../core/snapshot.ts:242-298), because the record written
    // here IS the row the next snapshot writes:
    //   * ABSENT (never empty) unless the run said something substantive — a present
    //     `partialContent` always means "it did say something", which is what keeps the reader's
    //     `min: 1` bound meaningful;
    //   * a malformed value is REFUSED, not coerced (src/harness.ts validates it before anything
    //     moves, so a bad send cannot corrupt live canonical state);
    //   * DROPPED on a `completed` status, exactly like `error` — mutual exclusion with `content`,
    //     so a completed row never carries the pair and stays reloadable.
    partialContent?: string;
    // How many messages that run had COMMITTED when it stopped (an integer >= 0; NOT a measure of
    // progress — issue 0022). Travels with `partialContent`.
    cancelledAtMessage?: number;
    // issue 0032 (2026-11-26): the bounded tool-activity tally of a run that did not finish, on
    // identical terms to the pair above — OPTIONAL so an older send stays valid, VALIDATED (not
    // coerced) against the snapshot reader's own bounds by `../core/snapshot-validation.ts`
    // `readSnapshotToolActivity` (a wrong shape, an over-cap `byName`, a blank or over-long name,
    // or a non-integer count is REFUSED at the seam), and DROPPED on a `completed` status, because
    // ../core/snapshot.ts refuses to READ a completed row that carries the key. Without this link
    // the tally would exist in inline deployments only: the lane replica produces it in its own
    // `finishInvocation`, and 0032's own third pass is what recorded that an archive payload which
    // names a field's absence is how a forensic field dies quietly.
    //
    // It also JOINS `archiveDigestOf` (../server/workers/lane-commit.ts), for the reason that file
    // states for the pair: the skip test that decides whether a writer sends the op at all is
    // taken over that projection, so a canonical row moving from no-tally to tally must be visible
    // to it — a field in the payload but not in the digest is an op the lane skips forever.
    toolActivity?: HarnessToolActivity;
    // IT19 (R3/R5): WHY a non-concluded lane run stopped, in the machine-readable vocabulary
    // (the closed `HarnessRunStopReason` union; the row it produces is
    // `HarnessAgentResultSnapshot.stopReason`). A lane child is interrupted by causes the
    // coordinator never sees — its lease was revoked, its parent released the call, its provider
    // ran out of retries — and until now the archive carried only the English sentence in
    // `error`, so the canonical ledger could not tell those apart without string-matching.
    //
    // OPTIONAL and additive, and REFUSED (not dropped) when it is outside the union: this call's
    // return value is what the lane commits, so a name neither side recognises would become a row
    // the next snapshot cannot persist. Like `error` and the pair above, it is DROPPED on a
    // `completed` status — mutual exclusion, so a row that later completes never keeps a cause
    // that no longer describes it (src/harness.ts validates and applies both rules).
    stopReason?: HarnessRunStopReason;
    // W19 (2026-11-17): the process epoch that MINTED `invocationId`, so the canonical ledger can key
    // the row by its RUN (`../shared/run-identity.ts`). Two facts make the seam need it: a lane worker
    // mints ids from its OWN counter (`reserveIdentity` only raises a leased mark) while the parent
    // process keeps minting from its own, so a lane row and a coordinator row can name the same bare
    // id for two different runs — exactly as two process generations can.
    //
    // ABSENT means "name the CURRENT process's ledger generation", which is today's behaviour byte for
    // byte: a lane row and a coordinator row OF ONE GENERATION still address the same slot, so no
    // existing same-process pairing starts holding two rows where it had one. A caller that knows the
    // minting epoch (a lane replaying a leased id) may name it, and the value round-trips into the
    // persisted row (`HarnessAgentResultSnapshot.epoch`) so a restart rebuilds the same key.
    epoch?: string;
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
    // W19 (2026-11-17): the process epoch that minted `invocationId` (see
    // `HarnessThreadRecord.epoch` above — the live half, and the reason the pair exists). OPTIONAL and
    // additive: a document written before this field validates and restores with its exact prior
    // meaning, so `version` stays 2 (the discipline stated in this file's header and on
    // `HarnessSnapshot.agentResults`).
    //
    // It is written under the SAME condition as `invocationId` itself — present only when the record
    // names an invocation that has already reached a terminal state — because an epoch without an id
    // would describe no run, and a restored record whose id was dropped must not keep an epoch that
    // outlives it. `../core/snapshot.ts` validates it as a non-empty string.
    epoch?: string;
    // The conversation's DISPLAY LANE (see `HarnessThreadRecord.contextLane`). Optional
    // and additive: a document written before lanes exist has no key and restores to lane
    // 0, and a lane of 0 is never written, so every pre-lane record keeps its exact shape.
    // Only a HOST thread carries it — a default `agent:<name>` conversation is implicit
    // and is not persisted at all, exactly like its owner link (L2).
    contextLane?: number;
    // Why the thread's LAST run stopped short of its conclusion (the union declared above
    // in this file; the live half is `HarnessThreadRecord.stopReason`). OPTIONAL
    // and additive, so a document written before this field — and every existing fixture —
    // validates and restores with its exact prior meaning, and `version` stays 2 (the
    // discipline documented in this file's header and on `HarnessSnapshot.agentResults`).
    //
    // It says NOTHING about `status`: the two are orthogonal. A thread restored as 'idle'
    // can carry a stop reason (its run was interrupted, then a restart left it idle), and a
    // 'stopped' one can carry none (a pre-feature document, or a host stop that recorded no
    // reason). `status` stays the narrow 'idle' | 'stopped' pair — the machine-readable WHY
    // lives here, not in a widened status.
    stopReason?: HarnessRunStopReason;
    // The SOFT-DELETE marker (see `HarnessThreadRecord.inactive`). Durable on purpose: a
    // deleted conversation that vanished from the document would be destroyed by the next
    // save, which is exactly what the soft delete exists to prevent — the row stays, the
    // session tooling just stops discovering it.
    //
    // Only `true` is ever written; a `false` on disk is accepted and normalized to the
    // absent form by the reader (the `HarnessMessage.included` rule), so a host that
    // round-trips its own JSON stays byte-stable across `restore -> snapshot`.
    inactive?: true;
    // When it was marked inactive, epoch milliseconds (see
    // `HarnessThreadRecord.inactiveAt`). Validated as an integer >= 0 by
    // ./core/snapshot.ts `readThreads`, and NOT required to travel with `inactive`.
    inactiveAt?: number;
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
        // THE CONVERSATION'S SWITCHES: the names its user has switched off for its agents
        // (../types `Harness.withheldTools` is the live view). OPTIONAL and omitted while
        // empty, so a file written before the feature — and every existing fixture — restores
        // exactly as before with NOTHING switched off; that additive-when-absent shape is why
        // `HARNESS_SNAPSHOT_VERSION` did not move.
        //
        // It carries core and pending-only names too, which `enabled` can never represent:
        // such a name holds no cap slot, so a restart that restored only `enabled` would hand
        // every one of them back ON. Restore applies this list LENIENTLY — a name the rebuilt
        // harness does not register is dropped, never thrown, unlike an unknown `enabled` name
        // (./harness.ts restore, and ../server/restore-enabled-tool-prune.test.ts's header for
        // what strictness costs here) — and a name that appears in BOTH lists is treated as
        // switched off, because that is the only reading of a user's decision that survives a
        // stale `enabled` entry.
        withheld?: string[];
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
    //
    // Additive and OPTIONAL the same way are the two forensic fields of an unfinished
    // run (`partialContent`, `cancelledAtMessage` — see HarnessAgentResultSnapshot):
    // written only when the record actually holds them, read as "nothing recorded"
    // when absent, so every pre-0033 file restores with its exact prior meaning and
    // the schema version did not move.
    agentResults?: HarnessAgentResultSnapshot[];
    // R2 persistent threads. OPTIONAL and OMITTED while this harness has only its
    // implicit per-agent default conversations, so pre-thread snapshots and every
    // fixture that never called createThread keep their exact prior shape.
    // Present (possibly empty, after every host thread was deleted) once the
    // harness has minted at least one host thread id, so `threadSequence` remains
    // a high-water mark and a restart cannot reuse a deleted thread's id.
    //
    // Additive and OPTIONAL in the same way are the three keys of a thread that stopped
    // early or was soft-deleted (`stopReason`, `inactive`, `inactiveAt` — see
    // HarnessThreadSnapshot): written only when the row actually carries them, read as
    // "nothing recorded" when absent, so every pre-feature file keeps its exact prior
    // meaning and the version stays 2.
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
    // Every brain the harness can run, keyed by name. The FIRST entry is the entry
    // point unless `entry` names another one: `writer(...)` runs that agent, and any
    // other agent is reachable through `ctx.run(name, input)`, a thread, or the
    // `delegate` tool an agent with a lower-ranked peer gets.
    agents: Record<string, Agent>;
    // Which agent the callable runs; `harness.name`/`harness.agent` are THIS agent while it stays
    // registered. Defaults to the first entry of `agents`, and must name a registered agent. Once
    // `removeAgent` detaches it, those two readers follow the EFFECTIVE entry — the first
    // currently-registered agent, the same default just stated — and only a roster `removeAgent`
    // emptied keeps this name. (Renamed `primary`: routing, not rank — an entry can be Rank A or C.)
    entry?: string;
    // THE ROSTER RANKS, keyed by agent name (see ./AgentRank for the model). A rank
    // here wins over the defaults below; an agent that is NOT listed takes one rank
    // BELOW the lowest rank explicitly configured anywhere in this map, clamped at
    // 'Z'. Resolution, in order:
    //
    //   1. `ranks` absent ENTIRELY — the entry agent is Rank A and every other agent
    //      is Rank B. That is exactly the default the old `primary` + implicit
    //      `subagents` pair produced, so an existing single-team harness keeps its
    //      behaviour with no config change;
    //   2. `ranks` present — every listed name must be a registered agent (an unknown
    //      key is refused at construction, never silently ignored), and every agent
    //      the map omits gets `one below the lowest listed rank`;
    //   3. an agent added at runtime (`harness.addAgent`, a plugin's `createAgent`)
    //      with no explicit rank gets the same "one below the lowest explicitly
    //      configured rank" value, and an explicit `rank` option is validated the same
    //      way a configured one is.
    //
    // ANY NUMBER OF AGENTS MAY SHARE A RANK — two Rank A agents are ordinary, and
    // neither can delegate to the other. What the distinct-rank COUNT decides is the
    // nesting bound: a chain of runs may be at most as deep as the number of distinct
    // ranks in the roster (hard-capped at 26), because delegation is strictly
    // downward, so A→B→C needs three distinct ranks.
    ranks?: Partial<Record<string, AgentRank>>;

    // Maximum number of MODEL REQUESTS (turns) one agent run may make before the
    // harness treats it as a runaway loop: history is truncated back to the start
    // of the call and the harness throws. This is an OPTIONAL safeguard, and it is
    // OFF by default — unset means no limit, and `Number.POSITIVE_INFINITY` states
    // the same thing explicitly. A finite value must be a positive safe integer;
    // both are validated at construction so a typo fails before a long run.
    //
    // The bound is harness-wide and per run: it applies to every run in this
    // harness (entry, ctx.run, and every delegated child), and each run gets its own
    // count.
    //
    // With background tool calls this counts EVERY request, not just tool rounds:
    // a pause (`done` with pending work) and a wake-driven request each consume
    // one. On exhaustion the pending work is aborted and the transcript rolled
    // back rather than left orphaned. The bundled application presets set no limit
    // either (see harnesses/presets.ts) — every tool keeps its own timeout, and a
    // host that wants a hard stop opts in here.
    maxIterations?: number;

    // B1 (2026-11-13): the DEFAULT wall clock for a `threadFork` branch when the caller
    // does not name one. `harness.thread.forkThread()`, `api.threads.fork()` and
    // `runtime.threadFork` all resolve through it; the `threadFork` TOOL passes its own
    // schema value, so this option is the host's backstop for every other fork door.
    //
    // Unset means NO LIMIT (FORK_TIMEOUT_MS in ./core/agent-limits.ts), the same policy the
    // delegate default follows: a branch ends on its own answer, every tool it calls keeps
    // its own wall clock, and `maxIterations`/`maxTurns` are the count bounds. A finite
    // value arms a timer, so this is the option a host sets when it wants a stuck branch to
    // release its concurrency slot by itself instead of waiting for `toolCancel`.
    threadForkTimeoutMs?: number;

    // Who may create tools at runtime (R12). Defaults to 'all':
    //   - 'all'  — every agent gets toolCreate, whatever its rank;
    //   - a rank LETTER ('A'..'Z') — that rank and every rank TOWARD A may create, so
    //     `toolCreation: 'A'` is the faithful replacement for the removed 'primary'
    //     policy: the tool is neither DECLARED to a lower-ranked agent nor callable by
    //     one that guesses the name;
    //   - false  — no model-facing toolCreate at all (a session without it answers an
    //     honest "not registered" error). The HOST path `harness.toolCreate()` still
    //     works: an operator action is not a model privilege.
    // This is the ONLY rank-based capability gate left: tools themselves are never
    // rank-gated, and every agent has access to every registered tool.
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
    //
    // PER INSTANCE, NOT GLOBAL (issue 0003): the counter belongs to ONE harness, so
    // a host that constructs one harness per conversation gets a fresh budget every
    // time. The number is the guard that stops ONE runaway session growing its own
    // registry; it bounds nothing across instances and is deliberately not a
    // process-wide limit (a shared registry would break the isolation snapshot and
    // restore rely on). A host that needs a real bound on how many USER tools exist
    // keeps its own catalogue — compile once with `compileToolSourceModule`, share
    // one `Record<string, HarnessConfiguredTool>` into every instance — because a
    // configured/catalogue tool is catalogue state, never a creation, and so never
    // spends this budget.
    maxCreatedTools?: number;

    // Every tool the harness can run. Keyed by the name the model calls. Only
    // `visibility: 'core'` tools are declared up front; the rest are found
    // through the built-in toolRequest tool and enabled for the next turn.
    //
    // A value is either a prebuilt `Tool` or `{ tool, source }`, where `source`
    // carries the bytes the definition was compiled from (issue 0003). That second
    // shape is the shared-catalogue path: compile the host's user tools ONCE with
    // `compileToolSourceModule`, keep one `Record<string, …>`, and pass the same
    // object to every harness instance — each instance still reports a real
    // `toolSource()` revision and source text for it, and the module's top-level
    // code is not evaluated again per instance.
    tools?: Record<string, HarnessConfiguredTool>;
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
    // START WITH THE WHOLE SWITCHABLE TOOLBOX ON (server-toolbox default, R1).
    //
    // OFF unless `true`: a library consumer's harness starts with an EMPTY enabled set
    // exactly as before, and `toolRequest` stays the only way a searchable name gets
    // switched on. One server deployment asks for the opposite posture — a brand-new
    // conversation should not have to spend a discovery round trip to reach `shell` — and
    // that is what this flag is: an opt-in SEED, not a policy change.
    //
    // WHAT IT DOES, precisely, at the end of startup (after every registration the
    // configuration and the plugins made, BEFORE the handle exists): it runs ONE
    // `enableTools` pass over the registered names, and that pass is the SAME code path an
    // ordinary `toolRequest` match goes through — so the kernel's own switchability rule
    // (`occupiesSearchableSlot`: live, not `visibility: 'core'`, not pending-only) decides
    // which names qualify, a name the host's GLOBAL tool provider has disabled is skipped
    // (seeding a disabled name would spend a cap slot on a tool the operator switched off),
    // and `maxEnabledTools` still bounds the result: an over-cap catalogue keeps the first
    // `maxEnabledTools` names in registration order and leaves the rest off, reported by
    // the rows rather than thrown.
    //
    // WHAT IT DOES NOT DO: it never enables a core declaration (those are always in context
    // and spend no slot), it emits no `stateChange` (construction is not a mutation the host
    // has to persist separately — the server snapshots the harness after creation anyway),
    // it is NOT snapshot state (a restore re-applies the persisted `discovery.enabled`, so an
    // existing session keeps exactly the enabled set it committed), and `reset()` still
    // empties the enabled set: a cleared conversation is a different event from a new one.
    enableAllTools?: boolean;
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
    // THE BUILT-IN PLUGIN SET, made explicit so a HOST can state "none" (R-boot).
    //
    // Absent is the library default and changes nothing: the generated manifest
    // (`BUILTIN_PLUGINS`) is applied first, exactly as before. `[]` opts out of every
    // auto-discovered plugin, which is the only way `plugins: []` can mean "no plugins":
    // without this field an empty host list still leaves the three shipped plugins
    // loaded. `src/server/harnesses/toolbox.ts` passes `[]` here whenever a server boot
    // has supplied the complete plugin set (its `HarnessPresetReport.plugins` member),
    // so the server's boot contract never regains implicit built-ins the host omitted.
    //
    // It stays a LIBRARY field (not a server-only flag) because it is the plugin host's
    // own `builtins` seam exposed at the public configuration edge
    // (src/plugin/host.ts `resolvePluginList`); no default changes for any consumer that
    // does not set it.
    builtinPlugins?: readonly HarnessPlugin[];
    // Read-only view of the host's per-plugin settings (R2/R3 plugin settings UI).
    // The harness asks it for `<pluginName>.<key>` whenever a plugin reads
    // `api.settings.*`. Absent = an in-memory provider seeded from each plugin's
    // declared setting defaults, with `wakeIntervalMs` mapped onto the `async-ping`
    // plugin's `intervalMs` so the legacy configuration field keeps working.
    pluginSettings?: HarnessPluginSettingsProvider;
    // The host's GLOBAL tool switch (R3): one live provider over the tool names this
    // deployment has disabled for every session. Presence means the harness consults it
    // at the three tool-availability decisions (declarations, the launch gate, and
    // `toolRequest`'s forbidden report); absence means nothing is disabled globally,
    // which is the historical behaviour. It COMPOSES with the two per-run gates that
    // already exist — a delegation's `scope.tools` allowlist and this harness's own
    // session-wide enabled set — and changes neither.
    //
    // A DISABLED TOOL STAYS REGISTERED. Discovery can still list it, a host can still
    // execute it through `harness.executeTool`, and re-enabling costs nothing; only a
    // model's view of it (declared / callable / promiseable) changes. The switch applies to
    // EVERY name, the core control plane included (the server has no protected-name
    // exception), so hiding `toolRequest` from a conversation is an operator decision the
    // host writes exactly like any other.
    toolSettings?: HarnessToolSettingsProvider;
    // THE cross-session knowledge base (T7). Absent (every library consumer, `harness({})`)
    // means the harness builds its OWN in-memory engine, so `harness({}).knowledge` always
    // answers and the knowledge tool never has to specialise an unconfigured host — and never
    // claims durability it does not have, because an ephemeral member carries no
    // `commit`/`flush`/`dispose` (see `HarnessKnowledge`).
    //
    // A HOST hands in the durable half it owns: `loadKnowledgeFileStore({ root })`
    // (../server/knowledge-file-store.ts) returns a store over
    // `<databaseRoot>/harness/knowledge/`, and the SAME instance goes to EVERY harness THIS
    // process builds — in-process sessions and threads alike — because knowledge is
    // deployment-scoped, not session-scoped. (A lane WORKER replica is the one exception: a live
    // object cannot cross `worker_threads`, so it runs on its own engine until a per-worker store
    // is plumbed — the same limit `pluginSettings`/`toolSettings` document.) That sharing is also
    // what makes two sessions of one server read and write one article set.
    //
    // KNOWLEDGE IS NEVER SESSION STATE, and this is the field that says so:
    //   - `snapshot()`/`restore()` never carry it (a per-session snapshot of a global base
    //     would make one session's restart overwrite another's articles);
    //   - `reset()` never clears it (a reset starts a new CONVERSATION; the base outlives it,
    //     exactly as it outlives the session's `sessions/<id>/` directory);
    //   - disposing one harness never disposes a host-provided store — the process owner
    //     that loaded it disposes it exactly once (../server/start.ts `close()`).
    // A bare `KnowledgeEngine` is the other accepted form: a host that has the engine but not
    // yet the store (../server/runtime.ts builds the engine synchronously and awaits the load
    // after it) hands the engine over, and the store adopts it when it lands, so no article
    // written in that window is lost.
    knowledge?: HarnessKnowledge;
    // THE CANONICAL HARNESS NAME THIS BUILD ATTRIBUTES NEW ARTICLES TO (T6). A TRUSTED host
    // field, never model input: `../core/knowledge.ts` reads it from
    // `ToolContext.harness.knowledgeOwner` and stamps it on `create` only, so deleting the
    // harness can later remove exactly the articles it contributed.
    //
    // The server sets it to the frozen preset's canonical name in
    // ../server/sessions.ts `buildHarness`, which is also the identity the HTTP deletion guard
    // counts sessions by, so the two sides of the cleanup rule cannot disagree. A library
    // consumer leaves it unset and its articles stay unowned — the deliberate "no harness
    // identity, no attribution" rule. Absent (or blank) means unowned, never "owned by ''".
    //
    // It is NOT part of the knowledge base itself: the article field remains
    // `KnowledgeArticle.harness`, which survives copy/snapshot/persistence and is what the
    // cleanup filters on. This member is only the carrier that tells the engine who is writing.
    knowledgeOwner?: string;
};

// The callable harness. `await writer('...')` runs the entry agent to
// completion, executing tools until the model answers with text.
export type Harness = {
    (input: string, options?: HarnessRunOptions): Promise<HarnessAssistantMessage>;
    // The entry agent's name: `entry` while registered, else the first registered one (`effectiveEntryName`).
    readonly name: string;
    // The entry agent: `entry`'s brain while registered, else the first registered one (`effectiveEntryAgent`).
    readonly agent: Agent;
    // Every agent, keyed by the names given in configuration.
    readonly agents: Readonly<Record<string, Agent>>;
    // THE RESOLVED ROSTER RANKS, keyed by agent name, complete: every registered
    // agent has an entry, whether its rank came from `HarnessConfiguration.ranks`, a
    // runtime `addAgent({ rank })`, or the documented default. Frozen defensive copy,
    // so a caller cannot rewrite the roster's ranking through the handle (a plugin
    // that wants to change a rank calls `addAgent`/`removeAgent`, or the harness's own
    // reconfiguration door). Replaces the old `subagents` allowlist, which is now
    // DERIVED: who may delegate to whom follows from these ranks and nothing else.
    readonly ranks: Readonly<Record<string, AgentRank>>;
    // The registered tools, keyed by the names the model calls. Includes the
    // built-in toolRequest, toolCreate, task, profileManage,
    // chapterManage, and locationManage entries, plus delegate when at least one
    // agent of this harness has a strictly-lower-ranked peer.
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
    //
    // A `definition` candidate is the shared-catalogue form (issue 0003): the
    // prebuilt definition is published as-is, and a `moduleText`/`sourcePath`
    // supplied alongside it becomes the installed source revision — derived from
    // those bytes WITHOUT re-evaluating the module, so a tool compiled once can serve
    // many instances and each one still answers `toolSource()`/`toolSources()`.
    registerTool: (
        candidate: HarnessToolRegistrationCandidate
    ) => Promise<HarnessToolRegistrationResult>;
    // Inspect the captured source/revision of the installed registration. `undefined`
    // means the tool was registered from an already-constructed definition with no
    // source bytes attached, so no editable source revision exists for it. A
    // definition registered WITH its source (a configured `{ tool, source }` entry or
    // `registerTool({ definition, moduleText })`) does report one.
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
    // THE knowledge base this harness writes through (T7) — always present, never `undefined`.
    //
    // WHAT IT IS. The object the host handed `HarnessConfiguration.knowledge`, passed through
    // by reference (no wrapper, so identity is the proof of sharing: two sessions of one
    // server hold the SAME store, and one session's article is the other's to read). With no
    // configuration it is the engine `harness()` built for itself — see
    // `HarnessConfiguration.knowledge` for the two accepted forms and for why presence of
    // `flush` is the durability signal.
    //
    // WHO USES IT. The `knowledge` tool through `context.harness.knowledge` (a lane WORKER
    // replica gets its own until a per-worker store is plumbed — a live object cannot cross
    // `worker_threads`, the same rule `pluginSettings`/`toolSettings` document), and any host
    // or wrapper tool that wants the base behind it: a future `recipes` tool composes over
    // this engine exactly as `tasks` composes over the record engine
    // (`Harness.runtime.executeRecords`), rather than inventing its own store.
    //
    // IT IS READ-ONLY AND IT IS NOT SESSION STATE. The member is a getter, so nothing can be
    // assigned through the handle; `reset()`, `snapshot()` and `restore()` deliberately leave
    // it alone, and a session deletion never touches the store's directory.
    readonly knowledge: HarnessKnowledge;
    // THE CANONICAL HARNESS NAME THIS BUILD STAMPS ON NEW KNOWLEDGE ARTICLES (T6), or absent
    // for a harness the host did not attribute (every library consumer and `harness({})`).
    //
    // A getter with no setter, exactly like `knowledge`: the value is the TRUSTED identity the
    // host supplied through `HarnessConfiguration.knowledgeOwner`, not state a caller may move.
    // `../core/knowledge.ts` reads it off `ToolContext.harness` on `create` only — never from an
    // operation field — so a model cannot set or rewrite an article's owner. The frozen value
    // also survives `reset()` (only the conversation restarts), which is right: the same
    // harness handle continues to own what it creates.
    readonly knowledgeOwner?: string;
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
    // actually registered it (no lower-ranked peer means no delegate tool).
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
    // THE CONVERSATION'S TOOL SWITCHES — the names the user of THIS session has switched
    // off for its agents (`HarnessConfiguration`'s tool panel, `toolManage enable|disable`,
    // the plugin seam, or a restored `snapshot.discovery.withheld`). Sorted and copied on
    // every read, so a host can render or diff it without owning the live Set.
    //
    // WHY THIS IS A SEAM AT ALL: it is the only place the switch of a `visibility: 'core'`
    // or pending-only name exists. Such a name never holds a cap slot, so `discoveredTools`
    // cannot mention it and an over-cap snapshot cannot lose it — before this, the ONLY
    // answer the kernel had for those names was "always in context, cannot be switched".
    //
    // WHAT ONE NAME IN THIS LIST MEANS, precisely (and what it does not):
    //   - the model never SEES it: the declaration boundary skips it, `toolRequest` does not
    //     list it at all (not as `forbidden` — simply absent, so a search cannot resurrect
    //     it), and the launch gate refuses it even for a core or pending-only control;
    //   - it is PER-SESSION and live: the reads are per model turn and per launch, so
    //     switching a name while a thread is running lands on that thread's NEXT request,
    //     with no rebuild and no cap change;
    //   - it does NOT stop the operator's doors. `executeTool` (the REST/manual execution
    //     routes) and `context.callTool` (a running tool calling another tool) keep reaching
    //     any registered name, withheld or not — the switch is for the agents and threads of
    //     this conversation, never for the tool implementation itself.
    //
    // Independent of `discoveredTools` by construction: a name appears in both lists only in
    // a hand-edited snapshot, and `restore` resolves that in favour of the switch. `reset()`
    // clears it — a new conversation starts with everything on.
    readonly withheldTools: readonly string[];
    // Whether THIS harness's kernel would let a caller move one name in or out of the
    // SEARCHABLE CAP SET — the cap-slot predicate (`occupiesSearchableSlot`) behind
    // `setActiveTools`, `enableTools`, the snapshot's `discovery.enabled` list, and restore:
    // a name qualifies only while it resolves to a live definition that is NOT
    // `visibility: 'core'` and NOT pending-only.
    //
    // WHY THIS IS A HOST SEAM: `discoveredTools` says which names are ON; it cannot say
    // which names MAY hold a slot. A host that re-derives that rule from catalogue metadata
    // gets it wrong in both directions — `toolCancel` is demoted to `visibility:
    // 'searchable'` at registration yet stays pending-only (so it has no slot to move), while
    // a searchable preset row such as `shell` looks core-adjacent but genuinely holds one.
    // Reading the kernel's own answer is the only version that cannot drift.
    //
    // WHAT IT NO LONGER CLAIMS: it is NOT "may this name be switched at all", and it was
    // never the predicate the switch operations refuse with. Since the session switch
    // (`withheldTools` above), `toolManage enable|disable`, the plugin seam, and the
    // operator route accept EVERY registered name, and a core/pending-only name's switch
    // lives only in the withheld set. A host that treats `false` as "not switchable" today
    // hides the one control the user most wants to switch off; a host that wants "is this
    // row cap-managed?" (a `protected` row figure) still reads exactly this.
    //
    // `false` therefore means "no searchable cap slot for this name": an unregistered name,
    // a core declaration, and a pending-only runtime control. The switch itself refuses only
    // a blank name and an unregistered one; it never refuses these three for being core.
    isToolSwitchable: (name: string) => boolean;
    // Re-runs the `enableAllTools` seed pass on a LIVE harness: one `enableTools` pass over
    // every registered name this harness can switch, minus the names the host's global tool
    // provider denies AND minus the names this conversation has switched off
    // (`withheldTools` — the seed is an auto-enable path, so it never overwrites a user's
    // switch), capped at `maxEnabledTools` in registration order (the construction seed,
    // `src/harness.ts` `seedSwitchableTools`, verbatim — same selection, same cap, same order).
    //
    // ONLY FOR A SEEDED HARNESS: the pass belongs to `enableAllTools`, so a handle built WITHOUT
    // it has no seed to re-run and this is a no-op. That gate is what lets a host call it
    // unconditionally: the enabled set a RESET conversation starts with then equals the set a NEW
    // conversation of the same session starts with — a full toolbox, or the same empty one.
    //
    // WHY THIS IS A HOST SEAM: the construction seed is not snapshot state and `reset()` empties
    // the enabled set, so a host whose "new conversation" operation is a RESET (the shipped
    // server's session reset) has no way to hand a fresh conversation the toolbox a fresh
    // CREATE gets. Doing it from outside means looping the per-name switch, which inserts
    // newest-first and therefore keeps a DIFFERENT set than the seed once the cap binds; only
    // the kernel can re-run its own pass.
    //
    // CONSEQUENCE FOR A HOST THAT PERSISTS SESSIONS: the gate reads `HarnessConfiguration`, which
    // belongs to the harness built IN THIS PROCESS. A session created before a restart is built
    // again on the restore path, so a host that wants `reset` to answer the same toolbox after a
    // restart has to ask for the seed on THAT build too. The shipped store does
    // (`src/server/sessions.ts` `create` for a create, `restoreSession` for a restore) and it is
    // safe there: `restore()` replaces the enabled set from the persisted snapshot afterwards
    // (`src/harness.ts` `restore`), so the seed refills nothing until a reset asks for it. Built
    // unseeded, this seam is a no-op on a restored session and its reset silently answers an
    // empty toolbox while the same session, reset in its own process, answers a full one.
    //
    // OPTIONAL on purpose: it is an additive seam, and a handle a host assembled by hand (a
    // fixture, a library wrapper) may not carry it. Callers guard with `?.` and fall back to the
    // pre-existing behaviour (an empty set after a reset). It reports one `state_change` when the
    // set moves, like any other enabled-set mutation, and nothing when it does not.
    enableAllSwitchableTools?: () => void;
    // N3: every branch record this harness knows, newest last. Includes running
    // branches and the bounded newest terminal records (see
    // MAX_BRANCH_RECORDS / core/branch.ts). The returned array is a detached
    // copy: mutating it never changes harness state.
    branches: () => HarnessBranchRecord[];
    // N3: one branch record by id, or undefined. The returned record is a
    // detached copy, like `branches()`.
    branch: (id: string) => HarnessBranchRecord | undefined;

    // -------------------------------------------------------------------
    // R2a/R3a — the record store's OBSERVATION plane (live records/tasks panels)
    // -------------------------------------------------------------------
    //
    // The record tools write through `runtime.executeRecords`; a HOST (the server
    // store, and through it the stream hub) watches the same store through these three
    // doors. They are on the handle, not on `runtime`, because `runtime` is the
    // tool-visible surface a lane worker RPCs (./server/workers/capability.ts
    // classifies every key of it) and an observer seam is host-only: a lane's write is
    // answered by the authority ON THE CANONICAL harness, so the canonical harness's
    // engine is the one that announces it — once per write, never per replica.
    //
    // Nothing here writes, and every read is detached. A store-level notification
    // describes ONE committed tool call (`changes` carries the feed entries it
    // appended), and a rejected call announces nothing, so a live panel never renders a
    // write the model was refused.
    records: () => RecordStoreView;
    recordsChanges: (since: number) => RecordStoreDelta;
    onRecordsChange: (listener: (notification: RecordStoreNotification) => void) => () => void;

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
    // B1/B4 (2026-11-13): both reads accept the CALLER's persistent thread id as an
    // optional second argument (`threadRead.tool.ts` passes `context.threadId`), and a
    // finished fork's `branch-N` resolves through the branch ledger instead of throwing.
    //
    // SINCE 2026-11-15 THE CALLER NO LONGER GATES A READ. Both seams answer any
    // conversation in the session, because `agentManage`/`agentResult` were never
    // lineage-gated: a caller could already read a sibling's finished RESULT but not the
    // transcript that produced it, which made a "review the IT14 thread" brief
    // unanswerable. The lineage rule still owns the WRITE doors (`threadSend`,
    // `threadDelete`), and `threadList` states that set as `actOn`.
    //
    // Both also accept an ADDRESS, id or label alike (see `threadAddressOf`), and the
    // second argument still names the caller for branch resolution and for any future
    // per-conversation rule. Omitted, both behave exactly as they always did — the host
    // view, and `undefined` for an address nobody has.
    threads: () => HarnessThreadRecord[];
    thread: (id: string, callerThreadId?: string) => HarnessThreadRecord | undefined;
    // The thread's committed transcript, as a detached copy.
    threadMessages: (id: string, callerThreadId?: string) => HarnessMessage[];
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
    //     Role is what provider tool-call pairing and the entry join resolve on, and a
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
    // The session label (`IT14`) stamped onto the canonical record, so the roster row and a
    // snapshot carry the name the server minted and a thread tool can resolve it as an ADDRESS
    // (see core/thread.ts `resolveThreadAddressOf`). `undefined` clears it. Refused for a
    // conversation this harness does not have; NOTIFIES `thread`, like the write above.
    setThreadLabel: (threadId: string, label: string | undefined) => HarnessThreadRecord;
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
    // concurrently. This explicit host action is the ONE revival door: it lifts a
    // `stopped` conversation, a park a plugin never resumed, AND the soft-delete
    // marker of a conversation the user deleted (`inactive`/`inactiveAt` come off the
    // record, the roster names it again, and the turn runs on the retained transcript).
    // An AGENT cannot do any of that — `threadSend`/`steerThread` refuse a stopped,
    // parked-into, or inactive target.
    sendThreadInput: (
        threadId: string,
        input: string,
        options?: HarnessRunOptions
    ) => Promise<HarnessAssistantMessage>;
    // Queue text for the next safe model boundary of a RUNNING thread. Steering
    // never interrupts an in-flight request: the run appends it as a user message
    // before its next request, so the ordering inside the transcript is the
    // ordering of the returned receipts. A thread a PLUGIN parked (`paused`, T8) also
    // accepts the text — it queues, and the park is left intact. Returns
    // `queued: false` with a reason for an idle or stopped thread.
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
    deleteThread: (threadId: string) => HarnessThreadDeleteResult;
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
    //     under `name`, give it its default `agent:<name>` conversation, and give it a
    //     RANK: `options.rank` when supplied (validated exactly like a configured rank),
    //     otherwise the documented default of one rank below the lowest explicitly
    //     configured rank. A rank strictly below at least one existing agent makes it a
    //     delegate target, which also installs the `delegate` tool the first time the
    //     roster gains a delegable pair; `options.delegate === false` keeps the agent
    //     reachable (threads, `ctx.run`) without making it a delegation target. Throws
    //     for a blank/unknown name shape, a name that is already registered, a
    //     configuration with no model, or an `options.rank` that is not a rank letter.
    addAgent: (
        name: string,
        configuration: AgentConfiguration,
        options?: { delegate?: boolean; rank?: AgentRank }
    ) => Agent;
    //   - `removeAgent(name)` — detach one registry agent: it leaves `agents` and
    //     `ranks`, and its DEFAULT conversation is
    //     dropped with it (a host thread owned by that agent is not). Throws for an
    //     unknown agent, for the entry agent (the entry point is not removable — that is a
    //     redefinition, not a binding change), while its default conversation has
    //     live or queued work, and while it still OWNS a host thread — the host deletes
    //     those conversations first, which is exactly the guard the server's session route
    //     states as a 409 before calling this (./server/sessions.ts `removeSessionAgent`,
    //     R6: a saved session's history is never removed behind the caller's back).
    //     Committed history in OTHER agents is never rewritten: a
    //     delegated answer already copied into the caller's transcript stays.
    removeAgent: (name: string) => void;
    //   - `setAgentRank(name, rank)` — replace one registered member's AUTHORITY in
    //     place, without rebuilding its brain or touching any conversation. The rank
    //     map is live state (`rankOf`, `delegableNamesFor`, the per-turn projection), so
    //     this recomputes the distinct-rank bounds and re-syncs the installed
    //     `delegate` declaration exactly like `addAgent`/`removeAgent`. Throws for an
    //     unknown agent, a bad rank letter, or while any run is in flight — the same
    //     structural gate the other roster writes use.
    setAgentRank: (name: string, rank: AgentRank) => void;
    //   - `setAgentInstruction(name, instruction)` — replace the agent's leading system
    //     block IN PLACE with one system message, and reseed its `instructions` baseline
    //     so a later `reset()` returns to the new prompt. The number of messages replaced
    //     is exactly the current instruction count (`agent.instructions.length`), which
    //     is how many leading system entries `agent()` seeded; everything after them —
    //     seeded context, turns, tool results — is untouched, and no transcript is ever
    //     rebuilt. Throws for an unknown agent or blank/non-string text.
    setAgentInstruction: (name: string, instruction: string) => void;
    //   - `setAgentPrefix(name, prefix)` — replace the SEEDED PREFIX BAND of one registered
    //     member IN PLACE: the run of transcript entries that `agent()` seeded from
    //     `AgentConfiguration.prefix` (immediately after the instruction block, before any legacy
    //     seed history and before every accumulated turn), plus the baseline that band is reseeded
    //     from. `prefix` is an ARRAY of closed role/content turns (`HarnessPrefixTurn`) — no
    //     `null`, because "inherit" is a SERVER-layer question (`GET …/agents/{id}/prefix` reports
    //     the source, and a session write resolves inheritance before calling this) and the runtime
    //     has nothing to inherit FROM. `[]` is the explicit removal: the band is deleted and the
    //     member reseeds without preset history.
    //
    //     WHAT IS PRESERVED: every accumulated conversation turn (the whole transcript after the
    //     band), the legacy `AgentConfiguration.messages` seed entries, the instruction block, the
    //     brain's model/transport, and every OTHER member. Nothing is rebuilt, so a prefix edit
    //     costs a conversation nothing — the same property `setAgentInstruction` has.
    //
    //     WHAT MOVES: the construction/reset baseline, so `reset()` returns to the new band, and
    //     the thread factory, so a NEW host thread of this agent seeds the new band. Existing
    //     separate host threads are NOT rewritten — each is its own transcript, and the same
    //     limitation is documented for `setAgentInstruction` ("one override moves only this
    //     member's leading block"); and a FORK gets no band of its own, because a branch starts
    //     from its source's materialized transcript, which already carries these turns.
    //
    //     REFUSALS, all `HarnessError` with nothing changed: an unknown agent; a run in flight
    //     (the same roster-idle gate as the other three writes); a turn that is not a
    //     role/content text turn (`system | user | assistant`, string `content`, no tool role, no
    //     tool call, no unknown key); and a transcript whose band is no longer where the seed put
    //     it — a compactor or a host edit removed or moved one of those entries, so the band is
    //     noncontiguous or overwritten and splicing here would rewrite unrelated history. The
    //     guard is the same shape as the instruction write's "no longer starts with its seeded
    //     instruction block" check.
    //
    //     HYGIENE, identical to the seed loop: the caller's array and objects are never adopted —
    //     each turn is copied, a caller-supplied `messageId` is dropped, and the new entries are
    //     minted transcript-scoped ids the same way `agent()` mints them, so a prefix edit cannot
    //     collide with an id an accumulated turn already owns.
    setAgentPrefix: (name: string, prefix: readonly HarnessPrefixTurn[]) => void;
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
    // THE GROUP THIS ROW BELONGS TO (2026-11-13 settings-UI grouping, R1). Presentational
    // metadata ONLY: validation, defaults, the PATCH edge and persistence never consult it. `id`
    // is the stable machine id a renderer orders and identifies a section by; `title` is the
    // heading text it prints verbatim. Absent means "no section" — the row renders in the flat
    // top-level run exactly as it did before this field existed, so every plugin that does not
    // declare it is unaffected.
    group?: { id: string; title: string };
    // THE BOOLEAN SETTING THAT GATES THIS ONE (same R1). When present, the renderer hides this row
    // while that parent checkbox is off and shows it, indented under the parent, when it is on —
    // which is how a dependent numeric field stops reading as a standalone option. Absent means
    // "always visible", the behaviour every existing plugin relies on. Not enforced server-side:
    // the plugin owns the pairing, and a parent key that names no boolean is simply a row the
    // renderer cannot gate.
    parentKey?: string;
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
    // The system prompt this plugin sends to the model, shown READ-ONLY in the plugin
    // details panel (2026-11-12 operator request). Display-only metadata: it never
    // shapes behaviour, and a plugin that never prompts simply omits it, so every
    // other plugin's row stays exactly as it was. In the plugin file it is a plain
    // literal, NOT a reference to that plugin's own prompt constant: the constant is
    // declared after `metadata`, so a reference would read a temporal dead zone, and a
    // test pins the two copies byte-exact. The wire spelling is snake_case
    // (`system_prompt`, src/harness-server.swagger.yaml `PluginSummary`); this internal
    // name stays camelCase like every other field here (src/server/api.ts `pluginRowOf`
    // is the one place that maps the two).
    systemPrompt?: string;
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

// Host-side read model for the GLOBAL tool switch (R3). The deployment keeps one set of
// tool NAMES that are switched off for every session; everything else is enabled unless
// listed, so the set is a delta and a harness built without a provider behaves exactly as
// it did before this field existed.
//
// LIVE BY REFERENCE, exactly like `HarnessPluginSettingsProvider`: `harness()` stores the
// object, never a copy of its contents, and the three places that decide tool availability
// (the declaration filter, the launch gate, and `toolRequest`'s forbidden report — all in
// src/harness.ts) call it per decision. An operator's
// `PATCH /v1/harness/tools/{tool_id}` therefore changes what an ALREADY RUNNING session
// declares on its next request, with no rebuild and no re-registration.
//
// Read-only by contract: the write edge is the server's (src/server/tool-settings.ts),
// which owns validation, protection, and durability. Synchronous and total; a provider
// that throws fails the read, the same rule the plugin provider follows — a wrong answer
// about which tools exist must not be silently swallowed inside a turn.
export type HarnessToolSettingsProvider = {
    isToolDisabled(name: string): boolean;
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
    // THIS ENTRY's inclusion, live (R8): `false` exactly when this entry carries the flag,
    // and nothing else. It says NOTHING about the rest of the tool-call block — an assistant
    // request entry and the results answering it are separate switches, each with its own
    // entry, which is what lets a policy drop an old tool request and keep its answer. A
    // caller that wants the whole exchange withheld reads the members it cares about (a
    // grouping is available at src/core/context-pruning.ts `groupUnits`) and writes each one.
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
    // still-running tool call, with every disabled entry already filtered out) — the
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
    // Switch ONE canonical transcript entry off or on for the model (R8). `false` stores
    // `included: false`;
    // `true` REMOVES the key, because only `false` is ever stored (an unflagged
    // transcript stays byte-identical, and re-enabling is the exact inverse of
    // disabling). The write never fans out: targeting the assistant entry of a tool-call
    // block withholds that REQUEST, and the results answering it keep riding (as ownerless
    // entries — see `HarnessMessage` above), while targeting one result withholds only that
    // result and leaves its call's slot to the request-only `withheld` placeholder. Nothing
    // in the projection can therefore hand a strict provider a half-answered
    // `tool_calls[]`; what it CAN hand it is a result whose request left — that is the
    // feature, and it is what the context trimmer's request truncation asks for.
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
    // store that persists on that notification (the server's shard store — for a
    // conversation, its `sessions/<id>/threads/<threadId>.json`) — in BOTH
    // execution lanes. Under `threadExecution: 'worker'` a lane used to owe the authority
    // only APPENDED SLICES, so an in-place flag change on an already-committed message
    // died with the worker process (finding F6); it now pushes that change too, as a
    // `transcript:patch` operation (pipeline T4.1, src/server/workers/lane-commit.ts): the
    // whole committed prefix, compare-and-set against the digest this lane adopted, which
    // the authority replays on the canonical harness through `patchThreadMessages` — the
    // same targeted-seam family as the append — and reports as the same `agent_message`
    // change, which is what puts it in that conversation's transcript shard. A flag a
    // plugin writes in worker mode
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
    // half-applied write.
    //
    // TARGETS — three, and the first two are the shipped ones, unchanged:
    //   - an ENTRY from this round (`context.entries[i]`) — resolved by message
    //     identity against the live transcript, so it stays usable when the transcript
    //     merely GREW and is refused when the list was replaced;
    //   - a NUMBER — the index, interpreted against the CURRENT transcript;
    //   - a `messageId` STRING (context T1.5) — the durable address, looked up by id in
    //     this agent's transcript, so it resolves in a LATER round of the same
    //     conversation, after `restore()`, and even after a `replaceHistory()` that kept
    //     the entry. It names the SAME ENTRY in a later round as it did in this one (R8:
    //     `setIncluded` writes one entry, never a unit), so an id-based pass is idempotent
    //     across rounds. An id
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
    // THE SECOND AXIS (trimmer uplift T6) — withhold one assistant entry's THINKING while the
    // entry itself keeps travelling. Same primitive shape as `setIncluded` on purpose: the same
    // three targets, the same strict-boolean check before any write, the same in-place write on
    // the canonical message, the same projection-cache invalidation so the change lands on THIS
    // request, and the same single `agent_message` transcript change — which is still the only
    // durability mechanism there is.
    //
    // WHAT IT CHANGES, AND WHAT IT DOES NOT. The entry is NOT excluded: it stays in the request,
    // in the same position, with its `content` and `toolCalls` intact, so provider pairing rules
    // (`src/transport/openai.ts`) are untouched and `pairIssues`-style oracles cannot see this
    // flag at all. What leaves is the thinking: the projection RESOLVES the flag OUT, so the
    // emitted copy of a flagged entry OMITS the `reasoning` key entirely and no request object
    // ever carries `reasoningIncluded` (core/agent.ts `withIncluded` keeps the copy flag-free and
    // `withoutWithheldReasoning` performs the omission, both run by `src/harness.ts`
    // `projectTranscript`). The transport therefore needs no new field — the ABSENCE of
    // `reasoning` on a projected entry is the wire signal, and the transport's echo decision
    // keys off exactly that presence check.
    //
    // NO UNIT CASCADE on either axis (R8 made `setIncluded` per-entry too, so the two
    // controls now differ only in what they change, not in what they address). Thinking
    // belongs to exactly ONE message: targeting the assistant entry of a tool-call block
    // does not touch its results, and no result can carry this flag.
    //
    // ASSISTANT ENTRIES ONLY. A non-assistant target is refused the way `edit` refuses
    // `reasoning` on a non-assistant entry: there is no thinking there to withhold.
    //
    // `false` stores `reasoningIncluded: false`; `true` REMOVES the key, because only `false` is
    // ever stored (an unflagged transcript stays byte-identical, and re-enabling is the exact
    // inverse of withholding). A plugin pass that is withhold-only never writes `true` — the
    // `true` side exists for the operator and the host API.
    //
    // CANONICAL STATE CARRIES IT. Canonical entries, seeds, branch/fork records and snapshots
    // keep the key, so the decision survives a restart, a `snapshot()`/`restore()` round-trip, a
    // fork, and a worker-lane `transcript:patch` (core/snapshot.ts and core/branch.ts whitelist it
    // beside `included`; the lane's CAS refusal is the shared "refuse whole, re-derive next turn"
    // rule — see `setIncluded` above). A branch run applies it to its own EPHEMERAL copy, its
    // request is still resolved, and it reports no change.
    //
    // Throws a `HarnessError` for an index outside the transcript, a non-integer index, a
    // non-boolean `reasoningIncluded`, an empty `messageId`, an entry that is not this turn's
    // entry (including one made stale by `replaceHistory()`), a `messageId` that no longer names a
    // transcript entry, or a target whose role is not `assistant`.
    setReasoningIncluded: (
        target: HarnessContextEntry | number | string,
        included: unknown
    ) => void;
    // Edit the TEXT of one canonical transcript entry in place (pipeline T3). The other
    // half of R4 — "switch inclusion, edit an entry within its role's rules, and
    // nothing else": history is never deleted (T3.3), so the only mutation besides a
    // flag is a text change.
    //
    // WHAT A PATCH MAY NAME (role-safe by construction, T3.1):
    //   - `content`   — every role. For `system`/`user`/`assistant` this is the text the
    //     model reads. For a `tool` RESULT it is the answer text, and it is the ONLY
    //     thing editable there: `toolCallId` and `name` are the PAIRING KEYS the projection
    //     and the transport both trust (src/harness.ts `projectTranscript`,
    //     src/transport/openai.ts `wireMessage`), so a patch that touches them is
    //     refused rather than re-paired.
    //   - `reasoning` — `assistant` only. It is the model's own thinking text; the
    //     transport keeps it out of the wire payload, so editing it changes what a
    //     snapshot and a UI replay carry WITHOUT changing what the next request says.
    //
    // WHAT IS REFUSED: any other key (`role`, `toolCalls`, `toolCallId`, `name`,
    // `attachments`) and `included`. A structural edit could change `toolCalls`
    // MEMBERSHIP, which would leave results pointing at a call that is no longer
    // there — the pairing every provider checks. `included` is refused here because it is
    // a different axis with a different rule (it switches one entry in and out of the
    // request rather than re-wording it): use `setIncluded`. An empty patch
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
    //
    // OWNED PARK (context T11/D1). The park is attributed to THIS plugin, so `resume()`
    // below is the pair that lifts it and another plugin's `resume()` in the SAME
    // `turn.before` round cannot. Parking a conversation somebody else already parked
    // is a no-op that does NOT transfer ownership — the first holder keeps it.
    pause: () => Promise<void>;
    // Undo pause(): the record returns to 'running' when a run is still attached
    // (the normal case), to 'idle' otherwise, and emits `thread.resumed`.
    //
    // A no-op when the conversation is not parked at all, and (context T11/D1) a no-op
    // when it is parked BY ANOTHER PLUGIN — the wrapper a later pass runs around its own
    // work cannot strand or steal the holder's park. `api.threads.resume` and a host
    // `sendThreadInput` stay ownerless and still lift a park taken here.
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
        // Park a conversation at a turn boundary (T8 — the compaction contract). This
        // is the plugin-facing form of the `turn.before` payload's `pause()`: the
        // roster goes 'paused' and `thread.paused` fires; a thread already parked is
        // an untouched no-op that still returns the record. Throws for an unknown
        // thread, and refuses a `stopped` one (the host owns stopping and reviving).
        // While a thread is parked, `send`/`steer` QUEUE into it and never lift the
        // park, so the holder keeps sole control of when the conversation moves.
        //
        // OWNERLESS (context T11/D1): a park taken HERE names no holder, so this member
        // and `resume` below are the escape-hatch spelling of the pair.
        pause: (threadId: string) => HarnessThreadRecord;
        // Undo `pause` (T8). The roster returns to 'running' when a run is still
        // attached (the normal case, because the run is inside the hook that parked
        // it) or to 'idle' when the park outlived its run, and `thread.resumed` fires.
        // Anything that is not parked — including a `stopped` conversation, which only
        // a host `sendThreadInput` revives — is an untouched no-op that returns the
        // record. Queued messages are NOT drained here; the next boundary is.
        //
        // OWNERLESS (context T11/D1): unlike the `turn.before` payload's `resume()`, this
        // lift is not restricted to the plugin that parked the thread — it also frees a
        // park that payload's `pause()` owns, which is what stops a stranded park from
        // hiding a conversation from its host.
        resume: (threadId: string) => HarnessThreadRecord;
        // SET this conversation's DISPLAY LANE (the counter every event it records from
        // now on is stamped with — see `HarnessThreadRecord.contextLane`). Pure UI
        // metadata: the lane never reaches a `HarnessMessage`, so what the model is sent
        // does not change; only the context bar's stacked rows do.
        //
        // SYNCHRONOUS and immediately visible, like `setStatus`: the write lands on the
        // live record before this returns, so an event the run records a microsecond later
        // already carries the new lane (which is what lets one turn's bar show two rows),
        // and the state-change notification is what makes the thread snapshot persist it.
        //
        //   - unknown/deleted `threadId`  → throws (the same message every other member gives);
        //   - `lane` must be an integer >= 0 — NaN, a float, a negative, or a non-number
        //     throws a TypeError and mutates NOTHING, because a lane a renderer cannot sort
        //     is worse than no lane at all.
        //
        // Returns the updated DETACHED record copy (like `setStatus`), so the caller can
        // see what changed without holding the live record.
        setContextLane: (threadId: string, lane: number) => HarnessThreadRecord;
        // READ the current display lane. `0` when the conversation has never had one set
        // (absent means lane 0, and a reader never synthesizes a different number).
        // Throws for an unknown thread, like every other member.
        getContextLane: (threadId: string) => number;
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

    // Progressive-discovery gate, and the SAME session switch `toolManage enable|disable`
    // performs — one kernel, no weaker plugin path. Both refuse only a blank name and an
    // unregistered one: a `visibility: 'core'` declaration and a pending-only runtime control
    // are switchable now (they used to be refused, on the reasoning that switching one could
    // only be a no-op — true while a switch meant "move a cap slot", no longer true now that
    // the switch is recorded per conversation). For those names the operation touches the
    // conversation's withheld set and NO cap slot; for a searchable name it additionally moves
    // the capped set. `enableTool` may therefore still evict an over-cap name.
    //
    // What a plugin CANNOT do with this, on purpose: gate the manual/nested doors. A tool it
    // switches off is hidden from the agents of this conversation, while `harness.executeTool`
    // and `context.callTool` keep reaching it.
    enableTool: (name: string) => void;
    disableTool: (name: string) => void;
    // Names searchable RIGHT NOW, newest first (a detached copy). NOT the whole story about
    // what a plugin switched off: a core or pending-only name holds no slot, so it appears in
    // neither this list nor in its absence — ask the harness handle's `withheldTools` for that.
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
