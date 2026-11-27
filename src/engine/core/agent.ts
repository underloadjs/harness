// agent() — the brain.
//
// Responsibilities are deliberately narrow. An agent owns:
//   1. the model name,
//   2. the seeded system instruction(s),
//   3. the message history,
//   4. the model-request retry sequence for one turn().
//
// It owns no other policy: no tool execution, no compaction, no planning. That
// line is what keeps a brain reusable. The same agent can be driven by a writer
// harness, a research harness, or a test.
//
// ONE FLOOR IS NOT POLICY (issue 0004). When `maxPromptTokens` /
// `provider.contextWindow` is set, the agent measures the transcript it is about to
// send with the published estimator (`core/context-estimate.ts`) and REFUSES one that
// is too big — a typed, non-retried `context-overflow` before the request leaves. It
// still never trims, truncates or summarises: replacement policy stays on the plugin
// bus (`turn.before`), and the floor only catches what is still too big after policy
// has run. With no window configured, nothing here changes.
//
// RETRY OWNERSHIP (R1). The agent is the ONE retry owner for model calls, at the
// generic `request` boundary below. That placement is deliberate:
//   - it covers EVERY transport (the built-in `openAICompatible`, a custom
//     `stream`, a test double), because retrying lives above the transport;
//   - it covers every failure shape the transport can produce: a returned
//     `error` frame (any HTTP status, a provider error attached to a 200 stream,
//     a malformed frame), a thrown network error, and a stream that throws
//     mid-flight;
//   - it retries ONLY the current model request. Tools, tool results and the
//     rest of the run are never replayed: those live above this boundary in
//     harness.ts, which never sees a retry as a new turn.
//
// Policy: one initial attempt plus `maxRetries` (default 10) retries, with a
// doubling wait of `min(baseDelayMs * 2 ** (n - 1), RETRY_MAX_DELAY_MS)` (default
// 1s, 2s, ... 32s, then 60s for the rest of the ladder). The cap is not decoration
// (2026-11-17, the unrecoverable-timeout report): uncapped doubling made an exhausted
// ladder cost 1023 s (~17 min) of pure sleeping, which nobody reads as patience.
// Two failure classes own their OWN short ladders — `provider-connection` (3 attempts,
// 250 ms/500 ms) and `provider-timeout` (4 attempts, 2 s/4 s/8 s, capped at 30 s and
// bounded by a 900 s wall clock) — and ignore a NON-ZERO `maxRetries`, because widening
// the transient ladder says "my provider blips", not "dial my dead port eleven times".
// `maxRetries: 0` is the exception and the rule: it is a hard opt-out for every class,
// so `retry: false` still means exactly one attempt (../types/index.ts documents it).
// Success ends the sequence; when the final retry fails, the ORIGINAL error of
// that attempt is rethrown/yielded unchanged, so a caller keeps the real cause.
// Cancellation is never an error to retry: an aborted signal (in flight or
// during a backoff wait) ends the request immediately. A context overflow is never
// retried either (issue 0004): the guard above refuses an oversized transcript
// before the first attempt, and a provider's own 400/413 "input too long" — the
// `context-overflow` code the built-in transport puts on its frame — ends the
// sequence on the attempt that produced it, because re-sending the same oversized
// bytes answers the same way eleven times.
//
// Standalone use is real, and it is the reason the two methods are split:
//
//     const brain = agent({ model, provider });
//     for await (const event of brain.stream('hello')) { ... }   // one turn
//
// That is a whole turn. A caller who wants tool calling writes the loop by hand:
// push a user message, call turn(), inspect message.toolCalls, append tool
// results, call turn() again. Harness does exactly that, automatically.
//
// History contract:
//   - stream() commits the turn atomically: it appends the user message, then
//     the assistant message. On failure it truncates back to where it started,
//     so a failed prompt is never replayed on the next attempt.
//   - turn() does NOT append a user message, and does NOT roll back. It is the
//     primitive the harness re-requests with; recovery belongs to the caller.
//   - stream() yields failures as `error` events (long-running CLIs must
//     survive). turn() throws them (the harness owns recovery there).
//
// N3: Agent.fork() delegates to core/branch.ts. A fork is a DETACHED transcript
// clone (remapped tool ids, pending-call placeholders) with a detached reset
// baseline; it shares the transport, never a sandbox.
//
// Cross-references:
//   - ../types.ts     — Agent, AgentConfiguration, AgentStreamEvent
//   - ../transport.ts — openAICompatible(), the default HarnessStream
//   - ./branch.ts     — fork identity, materialization, bounds
//   - ../harness.ts   — the loop that drives turn() repeatedly

import { HarnessError, isInstanceOf, toErrorInfo } from '../util';
// `MAX_RESPONSE_SCHEMA_NAME_CHARS` is the gateway-side name rule the transport
// enforces; `structured` derives its `json_schema.name` under that same cap.
// `CONTEXT_OVERFLOW_CODE` (issue 0004) is the ONE name for "the prompt does not
// fit": the transport raises it for a provider 400/413 size rejection, and the
// pre-request guard below raises the same code before a request leaves, so a host
// classifies both with one switch and the retry rule has one owner.
import {
    CONTEXT_OVERFLOW_CODE,
    MAX_RESPONSE_SCHEMA_NAME_CHARS,
    openAICompatible,
    // (T6) The provider failure CLASSES the transport names, so the retry policy
    // below switches on a machine code exactly like `context-overflow` does — never on
    // English. `provider-connection` gets the short ladder from ./agent-limits.ts;
    // `provider-timeout` used to be terminal and now gets its own bounded one (see
    // `PROVIDER_TIMEOUT_MAX_ATTEMPTS` below).
    // (T8, AC3) `provider-rejected` is the third class: a deterministic HTTP refusal
    // (400/401/403/404) is terminal for the same reason a missed bound is — the next
    // attempt re-sends the request the provider already refused.
    // (2026-11-17) `provider-aborted` is the fourth: the gateway's own in-stream
    // `aborted` answer, i.e. a cancel that did NOT come from our signal. Re-sending a
    // request the caller no longer wants is wrong, so it is terminal like a refusal.
    // `provider-timeout` is the one class in this group that IS retried now — its own
    // bounded ladder, below.
    PROVIDER_ABORTED_CODE,
    PROVIDER_CONNECTION_CODE,
    PROVIDER_REJECTED_CODE,
    PROVIDER_TIMEOUT_CODE,
    // The one shape-checking reader of the transport's structured `details`, shared with
    // ../harness.ts so a `retry` frame and the terminal `error` record publish the same
    // diagnostics block from the same rules.
    providerDiagnosticsOf
} from '../transport';
// The ladder each provider failure class gets, kept in the same leaf as every other run
// bound (the declared contract AND the runtime values).
import {
    PROVIDER_CONNECTION_MAX_RETRIES,
    PROVIDER_CONNECTION_RETRY_BASE_DELAY_MS,
    PROVIDER_TIMEOUT_MAX_RETRIES,
    PROVIDER_TIMEOUT_RETRY_BASE_DELAY_MS,
    PROVIDER_TIMEOUT_RETRY_DEADLINE_MS,
    PROVIDER_TIMEOUT_RETRY_MAX_DELAY_MS,
    RETRY_MAX_DELAY_MS
} from './agent-limits';
import { DOWNLOAD_ATTACHMENT_LIMITS, validateAttachments } from '../shared/attachments';
import {
    agentBranchOf,
    assertForkDepth,
    createBranchId,
    materializeBranchHistory,
    normalizeForkAgentOptions,
    registerAgentBranch,
    registerAgentForker
} from './branch';
import type { NormalizedForkAgentOptions } from './branch';
import { registerAgentThreader } from './thread';
// Stable transcript addresses (context T1). A leaf module (types only), so importing it
// here adds no cycle to the branch/thread registry chain above.
import { assignMessageId } from './message-id';
// (issue 0004) The pre-request floor measures with the SAME estimator the UI context
// bar and the `context-compaction` plugin use (`ceil(chars / 4)`, dependency-free,
// total). A leaf module — types only — so it adds no cycle, and it is the published
// root-barrel helper a host uses to make its own decision before calling in.
import { estimateContextTokens } from './context-estimate';
// (issue 0001 B) Structured output reuses the SAME runtime gate a created tool's schema
// and arguments pass, rather than a second JSON-Schema implementation:
// `checkToolSchemaComplexity` bounds the schema at construction and
// `validateSchemaValue` judges the answer. Also a leaf chain (util + result-budget +
// tool), so this import adds no cycle.
import {
    MAX_CREATED_SCHEMA_BYTES,
    MAX_CREATED_SCHEMA_DEPTH,
    MAX_CREATED_SCHEMA_NODES,
    checkToolSchemaComplexity,
    validateSchemaValue
} from './schema-validation';
// The outcome storage rule (compaction T1) for the fork baseline below. Leaf module,
// type-only imports — no cycle risk with ./branch or ./message-id.
import { storedOutcomeEntry } from './tool-outcome';
import type {
    Agent,
    AgentConfiguration,
    AgentRequestCommit,
    AgentStreamEvent,
    AgentStreamOptions,
    HarnessAssistantMessage,
    HarnessAttachment,
    HarnessMessage,
    HarnessPrefixTurn,
    HarnessRetryConfiguration,
    HarnessStopReason,
    HarnessStream,
    HarnessToolCall
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalize the instruction field into an ordered list. One field accepts both
// a string and a list so the configuration stays flat.
const normalizeInstructions = (instruction: string | string[] | undefined): string[] => {
    if (instruction === undefined) return [];
    if (typeof instruction === 'string') return [instruction];
    return [...instruction];
};

// ONE SEEDED PREFIX ENTRY (U6). The exact element type of `AgentConfiguration.prefix`
// (`system | user | assistant`, the roles a preset history may hold), named once so the seed
// bookkeeping, the writer, and the read accessor below all speak the same type instead of
// re-spelling the `Extract` twice more.
type PrefixSeedMessage = Extract<HarnessMessage, { role: 'system' | 'user' | 'assistant' }>;

// The roles a prefix turn may hold — the SAME set the `HarnessPrefixTurn` type and
// `AgentConfiguration.prefix` admit, stated as a value so a runtime caller (a host, a test, a
// deserialized document) that slipped past the type gets a refusal rather than an orphaned turn
// reaching a provider. A `tool` turn is deliberately absent: it answers an assistant
// `tool_calls` block a prefix never carries.
const PREFIX_TURN_ROLES: readonly PrefixSeedMessage['role'][] = ['system', 'user', 'assistant'];

// One DETACHED, TEXT-ONLY copy of a submitted prefix turn (U6 writer input).
//
// Refuse, don't coerce, and mirror the seed loop's hygiene exactly:
//   - the role must be one of the three preset-history roles (a `tool` turn, a missing role, or
//     a number is a refusal naming the position — silent coercion would put an unpaired tool
//     result in front of a model);
//   - `content` must be a string, and it is copied VERBATIM (no trim): a preset history line is
//     the author's text, and the server's contract keeps content byte-for-byte too, so trimming
//     here would make a write and a re-read disagree;
//   - every OTHER key is dropped rather than carried — an id, an `included` flag, an
//     `attachments` array or a `toolCalls` block is not part of the closed turn, and the entry
//     the transcript ends up with is `{ role, content }` plus a minted id. This is the same
//     "a caller's object is never adopted" rule `withIncluded` applies to a seed entry, and it
//     is what makes a caller reusing one object across two agents harmless.
const copyPrefixTurn = (turn: unknown, owner: string, index: number): PrefixSeedMessage => {
    if (typeof turn !== 'object' || turn === null || Array.isArray(turn)) {
        throw new HarnessError(
            `Agent "${owner}" prefix turn ${String(index)} must be an object with a "role" and "content" string.`
        );
    }

    const candidate = turn as { role?: unknown; content?: unknown };

    if (typeof candidate.role !== 'string' || !PREFIX_TURN_ROLES.includes(candidate.role as PrefixSeedMessage['role'])) {
        throw new HarnessError(
            `Agent "${owner}" prefix turn ${String(index)} must have role "system", "user", or "assistant"; a tool turn belongs to a conversation, not to a preset history.`
        );
    }

    if (typeof candidate.content !== 'string') {
        throw new HarnessError(
            `Agent "${owner}" prefix turn ${String(index)} needs a string "content".`
        );
    }

    return { role: candidate.role, content: candidate.content } as PrefixSeedMessage;
};

// Whether a transcript entry is STILL the seeded prefix entry the band record names (U6 guard).
//
// Role + content, not object identity, and that choice is deliberate: a snapshot round-trip
// (`harness.restore`) replaces every transcript entry with a copy that carries the same bytes,
// so an identity-only check would refuse a perfectly good prefix write after any restore. A
// band that was COMPACTED, truncated, or overwritten in place still fails, because the entry at
// that position then says something else (or nothing) — which is the case the guard exists for:
// splicing there would rewrite accumulated conversation history the caller never named. This is
// the prefix counterpart of `setAgentInstruction`'s "no longer starts with its seeded
// instruction block" check (../harness.ts), made content-based because a prefix band, unlike an
// instruction block, is not identifiable by role alone.
const samePrefixTurn = (entry: HarnessMessage | undefined, seeded: PrefixSeedMessage): boolean =>
    entry !== undefined && entry.role === seeded.role && entry.content === seeded.content;

// Accepted identity-color spelling (R2): a CSS hex color, 3/4/6/8 digits, either
// case. Nothing else: a named color (`red`), an `rgb()`/`hsl()` function, or an
// emoji is a different rendering contract per host, while a hex literal is paintable
// by every host and is what the server echoes on `HarnessDescriptor.agentColors` and
// constrains in the HTTP contract (`harness-server.swagger.yaml` `agent_colors.pattern`).
//
// MIRRORING: the registry keeps its own copy of this expression
// (src/server/harnesses/registry.ts `AGENT_COLOR_PATTERN`) only so its rejection can
// be a 400 naming the agent; the two spellings are pinned to the SAME accepted and
// rejected sample set by src/server/harnesses/registry.test.ts, which feeds every
// value through BOTH `agent()` and `registry.create()`. A value that survives
// construction is therefore always a value a UI can paint, and a value the HTTP edge
// accepts is always one `agent()` will not reject.
const AGENT_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Validate the optional display color at construction. Trimmed first (a pasted value
// often carries padding), then matched; the stored value keeps the author's casing,
// because casing is presentation, not identity. `undefined` means "not configured"
// and stays ABSENT on the agent (never `color: undefined`), so a host can test
// `agent.color !== undefined` and fall back to its own derivation. An empty or
// whitespace-only string is rejected rather than treated as absent, exactly like a
// blank model id elsewhere: clearing means omitting the key.
const requireAgentColor = (name: string, value: unknown): string | undefined => {
    if (value === undefined) return undefined;

    const color = typeof value === 'string' ? value.trim() : value;

    if (typeof color !== 'string' || !AGENT_COLOR_PATTERN.test(color)) {
        throw new HarnessError(
            `Agent "${name}" has an invalid \`color\`: ${JSON.stringify(value)}. Use a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa).`
        );
    }

    return color;
};

// ---------------------------------------------------------------------------
// Structured output (issue 0001 B)
// ---------------------------------------------------------------------------

// Machine codes for the two structured-output rejections (records-engine Decision O,
// see ../util/errors.ts): a host that has to tell "my schema is wrong" from "the
// model answered something else" switches on the code instead of parsing prose, and
// `HarnessError` mirrors it into `error.name`.
//
// Not promoted to the package root on purpose: the codes are stable strings a host
// quotes (documented in README), and a root export would suggest a recovery API that
// does not exist — the answer to both is "fix the schema" or "re-ask".
export const STRUCTURED_SCHEMA_INVALID_CODE = 'structured-schema-invalid';
export const STRUCTURED_OUTPUT_INVALID_CODE = 'structured-output-invalid';

// How much of an unusable answer is quoted back in the failure message. A model that
// ignores the format can emit megabytes, and an error message is not a transcript.
const STRUCTURED_PREVIEW_CHARS = 160;

const previewOf = (content: string): string => {
    const flat = content.replace(/\s+/g, ' ').trim();

    if (flat.length <= STRUCTURED_PREVIEW_CHARS) return flat;

    return `${flat.slice(0, STRUCTURED_PREVIEW_CHARS)}…`;
};

// Gate the `structured` schema at CONSTRUCTION, with the exact bounds a model-created
// tool's schema must pass (`checkToolSchemaComplexity` with the `MAX_CREATED_SCHEMA_*`
// defaults). Two reasons, both already true of created tools: a schema this layer
// walks on every answer must not be unbounded, and a schema the runtime gate cannot
// express would silently validate everything (`validateSchemaValue` ignores keywords it
// does not model, so an unsupported shape is a contract the host believes in but never
// gets). `undefined` means "not configured" and stays absent.
const requireStructuredSchema = (name: string, schema: unknown): Record<string, unknown> | undefined => {
    if (schema === undefined) return undefined;

    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        throw new HarnessError(
            `Agent "${name}" has an invalid \`structured\` schema: ${JSON.stringify(schema)}. ` +
                'Pass a JSON Schema object, e.g. { type: "object", properties: { ... }, required: [ ... ] }.',
            { code: STRUCTURED_SCHEMA_INVALID_CODE }
        );
    }

    const check = checkToolSchemaComplexity(schema);

    if (!check.valid) {
        // `checkToolSchemaComplexity` returns fragments meant to follow "must not"
        // ("have more than 256 schema nodes"), the same shape ./creation.ts composes
        // for a created tool, so both surfaces read identically.
        throw new HarnessError(
            `Agent "${name}" \`structured\` schema must not ${check.message}. The same bounds apply to a ` +
                `created tool schema (depth ${MAX_CREATED_SCHEMA_DEPTH}, ${MAX_CREATED_SCHEMA_NODES} nodes, ` +
                `${MAX_CREATED_SCHEMA_BYTES} bytes).`,
            { code: STRUCTURED_SCHEMA_INVALID_CODE }
        );
    }

    return schema as Record<string, unknown>;
};

// The `json_schema.name` a gateway accepts (`[a-zA-Z0-9_-]{1,64}`, enforced by the
// transport at construction). An agent name is free text — a harness may key one with
// dots, spaces or non-ASCII labels — so it is reduced to accepted characters and
// truncated, falling back to a stable literal when nothing survives.
const structuredSchemaNameOf = (name: string | undefined): string => {
    const slug = (name ?? '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, MAX_RESPONSE_SCHEMA_NAME_CHARS);

    return slug.length > 0 ? slug : 'structured';
};

// Judge a finished answer against the schema. Returns the parsed value or throws a
// typed failure — it never returns a stand-in, because "the model answered something
// else" is a fact the caller must see, not a `{}`.
//
// JSON parsing is STRICT (no code-fence stripping, no first-brace sniffing): the whole
// point of a response format is a result the host parses without heuristics, so a
// fenced answer is a provider that ignored the request and must fail loudly rather
// than be rescued by a guess.
const structuredAnswerOf = (name: string, schema: Record<string, unknown>, content: string): unknown => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(content);
    } catch (error) {
        throw new HarnessError(
            `Agent "${name}" was asked for a schema-shaped answer and returned text that is not JSON` +
                `${content.length > 0 ? `: "${previewOf(content)}"` : ' (an empty answer)'}.` +
                ` The provider reported: ${toErrorInfo(error).message}`,
            { code: STRUCTURED_OUTPUT_INVALID_CODE, cause: error }
        );
    }

    const check = validateSchemaValue(schema, parsed);

    if (!check.valid) {
        throw new HarnessError(
            `Agent "${name}" returned an answer that does not match its \`structured\` schema: ${check.message} ` +
                `(answer: "${previewOf(content)}")`,
            { code: STRUCTURED_OUTPUT_INVALID_CODE }
        );
    }

    return parsed;
};

// Resolve the transport once, at construction. An explicit `stream` wins;
// otherwise the provider block is wrapped in the built-in transport. Failing
// here (rather than at the first prompt) means a misconfigured agent is caught
// where it was created.
const resolveStream = (configuration: AgentConfiguration, structured: Record<string, unknown> | undefined): HarnessStream => {
    if (configuration.stream) {
        // A host-supplied transport owns its own wire format, so `structured` cannot
        // reach the request body — it stays validation-only there (documented on
        // AgentConfiguration.structured). The agent still refuses an answer that
        // breaks the schema, which is the half a custom transport cannot do for it.
        return configuration.stream;
    }

    if (!configuration.provider?.baseURL) {
        throw new HarnessError(
            `Agent "${configuration.name ?? 'agent'}" has no transport: provide either \`stream\` or \`provider.baseURL\`.`
        );
    }

    // `structured` reaches the wire through the SAME provider-level seam issue 0001
    // added (`provider.responseFormat`), so the agent invents no second request field
    // and a host that already chose a `responseFormat` keeps its own: the explicit
    // provider value wins on the wire, and `structured` still gates the reply.
    if (structured === undefined || configuration.provider.responseFormat !== undefined) {
        return openAICompatible(configuration.provider);
    }

    return openAICompatible({
        ...configuration.provider,
        responseFormat: {
            jsonSchema: { name: structuredSchemaNameOf(configuration.name), schema: structured }
        }
    });
};

// The ONE normalization point for the context-inclusion flag (`HarnessMessage.included`)
// AND for the message id (`HarnessMessage.messageId`) — together: the copy that makes a
// message REQUEST-SAFE.
//
// The invariant this enforces everywhere a message is COPIED into a transcript or
// handed to a consumer: `included` is present ONLY when it is exactly `false`.
// "Included" is spelled by the key being ABSENT, so a host-seeded or legacy
// `included: true` is dropped here rather than riding through canonical state into
// every later projection, request object, and provider payload a custom transport
// builds. `false` is preserved verbatim, and every other key keeps the order the
// caller used (the rest pattern strips `included`, and the override re-adds it in
// place when it was already there).
//
// `messageId` is stripped for the same reason in the OTHER direction (context T1): the
// id is an address in CANONICAL state, never a model-facing field, so a projection copy
// carries neither key and a request object stays exactly what it was before either
// feature existed. That is also why an id is NEVER minted here — this is the copy path,
// and re-minting on a copy is what would stop the id being an identity. Every canonical
// creation point adds an id explicitly, through core/message-id.ts `assignMessageId`,
// either by minting (`seed()`, the appends, the assistant commit) or by carrying the
// source's (the fork baseline below, a branch record, a restored transcript).
//
// `outcome` (compaction T1) is deliberately NOT stripped. It rides into the projection so
// a `turn.before` plugin or a projected-copy reader can see WHY a call ended without
// parsing English prose, and it costs the model nothing: every transport field-selects the
// tool wire shape (`role`/`tool_call_id`/`content`, transport/openai.ts), so a provider
// payload is byte-identical with or without the key.
//
// The input object is never mutated — a new object is always returned, so a caller
// may keep or reuse its own object. The same rule is applied to untyped records by
// core/snapshot.ts (`applyIncluded`/`applyReasoningIncluded`) and core/branch.ts
// (`copyIncluded`/`copyReasoningIncluded`); this is its typed-message form, used by
// `seed()` (caller-supplied history entering canonical state) and by the harness's
// model-facing projection.
//
// `reasoningIncluded` (trimmer uplift T6) is the SECOND flag and follows the SAME rule,
// with one difference that matters to this function: an entry flagged ONLY on thinking is
// still EMITTED, so the request path strips that flag key too — see
// `withoutWithheldReasoning` directly below, which the projection runs on top of this copy.
// Here the rule is only "present ONLY when exactly `false`", so a host-seeded
// `reasoningIncluded: true` is normalized away like `included: true`, and a flagged entry
// re-emits the key so a seed, a fork baseline or a branch record keeps the decision.
export const withIncluded = (message: HarnessMessage): HarnessMessage => {
    // Neither flag says "withheld", so BOTH flag keys and the id are read off in one pass;
    // the surviving keys keep the order the caller used and the result can never alias the
    // caller's object. The cast is only about the union: `reasoningIncluded` exists on the
    // assistant variant, and the other variants simply have nothing to strip.
    // Narrowed through the role because the field exists on the assistant variant only — the
    // other variants have no thinking to withhold, so their answer is always "not flagged".
    const thinkingWithheld =
        message.role === 'assistant' && message.reasoningIncluded === false;

    if (message.included !== false && !thinkingWithheld) {
        const {
            included: _omitted,
            messageId: _omittedId,
            reasoningIncluded: _omittedThinking,
            ...rest
        } = message as HarnessMessage & { reasoningIncluded?: boolean };

        return rest as HarnessMessage;
    }

    // At least one flag is exactly `false`: strip ONLY the id and leave the flags where they
    // already were, so the key order of the copy is bit-for-bit what it was before the second
    // flag existed (the historical rule: the flags are the last keys of a flagged message).
    const { messageId: _omittedId, ...rest } = message;

    return rest as HarnessMessage;
};

// THE REQUEST-PATH HALF OF THE SECOND FLAG (trimmer uplift T6).
//
// An entry whose thinking is withheld is still SENT: same position, same `content`, same
// `toolCalls`, so nothing about provider pairing changes. What the flag resolves OUT is the
// thinking text itself — a projection copy of a flagged entry carries NO `reasoning` key, and
// NO request object ever carries `reasoningIncluded`. That absence is the wire signal the
// transport's echo decision reads (there is deliberately no new transport field), and it is why
// this function exists beside `withIncluded` rather than inside it: the flagged case of
// `withIncluded` is the canonical-re-emission case (seed, fork baseline, branch record), where
// the key MUST survive, while the projection case must lose both the text and the key.
//
// Unflagged entries (and every non-assistant entry) are returned UNCHANGED, same reference, so
// the default projection path allocates exactly what it allocated before this flag existed.
export const withoutWithheldReasoning = (message: HarnessMessage): HarnessMessage => {
    if (message.role !== 'assistant' || message.reasoningIncluded !== false) return message;

    // Both keys go: the text because the flag says the model must not get it, the flag because
    // a request object is flag-free data (`HarnessStream` consumers, transport/openai.ts).
    const { reasoning: _omittedReasoning, reasoningIncluded: _omittedFlag, ...rest } = message;

    return rest as HarnessMessage;
};

// A branch that forgot the flag would put a turn the user disabled straight back in
// front of the model on every branch request, so EVERY case below hands its copy to
// `withIncluded`: the source flag is re-emitted only when it is exactly `false`, and
// an `included: true` (or `included: undefined`) key never reaches a branch record.

// Deep-copy one baseline message for a fork's reset seed. A fork must be able to
// reset repeatedly, so the baseline is cloned on EVERY seed rather than handed
// out as a shared array. Attachments are re-validated by the shared gate (which
// also returns detached copies); tool calls are copied one by one.
//
// TOOL media uses the SAME rule with the DOWNLOAD profile: a branch that shares
// the source's attachment ARRAY would let a later mutation of one transcript
// reach the other. The attachment objects are copied shallowly on purpose —
// `data` is an immutable string, so detaching costs a pointer rather than a
// second 20 MiB allocation.
const copyBaselineMessage = (message: HarnessMessage): HarnessMessage => {
    switch (message.role) {
        case 'user':
            return withIncluded(
                message.attachments !== undefined
                    ? {
                          role: 'user',
                          content: message.content,
                          attachments: validateAttachments(message.attachments),
                          included: message.included
                      }
                    : { role: 'user', content: message.content, included: message.included }
            );

        case 'tool':
            return withIncluded(
                message.attachments !== undefined
                    ? {
                          role: 'tool',
                          content: message.content,
                          toolCallId: message.toolCallId,
                          name: message.name,
                          // Re-validated with the profile the bytes were produced
                          // under, so a corrupted tool message cannot survive a
                          // fork/reset boundary quietly.
                          attachments: validateAttachments(message.attachments, DOWNLOAD_ATTACHMENT_LIMITS),
                          // Compaction T1 — a fork/reset baseline carries the recorded
                          // outcome verbatim (never re-read from `content`), and carries
                          // NO key for a completed result, so the baseline of a
                          // pre-outcome transcript is byte-identical. core/tool-outcome.ts
                          // `storedOutcomeEntry` owns the omit rule; key order matches the
                          // canonical writer (src/harness.ts insertToolMessage).
                          ...storedOutcomeEntry(message.outcome),
                          included: message.included
                      }
                    : {
                          role: 'tool',
                          content: message.content,
                          toolCallId: message.toolCallId,
                          name: message.name,
                          ...storedOutcomeEntry(message.outcome),
                          included: message.included
                      }
            );

        case 'assistant':
            return withIncluded({
                role: 'assistant',
                content: message.content,
                ...(message.toolCalls !== undefined
                    ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
                    : {}),
                ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
                included: message.included,
                // Trimmer uplift T6 — a fork of a conversation whose thinking was withheld must
                // keep it withheld: a branch that dropped this key would put the reasoning of an
                // older turn straight back in front of the model on every branch request. Passed
                // like `included` above, so `withIncluded` keeps ONLY the exact `false` spelling
                // and an unflagged baseline grows no key.
                reasoningIncluded: message.reasoningIncluded
            });

        default:
            // A `system` entry: `withIncluded` already returns a detached copy, so
            // no extra spread is needed here.
            return withIncluded(message);
    }
};

// ---------------------------------------------------------------------------
// Retry policy (R1)
// ---------------------------------------------------------------------------

// One initial attempt plus TEN retries. The count and the base wait are the
// documented defaults (README "Retries", knowledge.md "agent").
const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;

// The retry sequence for one agent. Resolved ONCE at construction so a bad
// configuration fails where the agent was created, not on the first provider
// hiccup (the same rule the transport's own resolution follows).
type RetryPolicy = {
    // Retries AFTER the initial attempt. 0 means one attempt only.
    maxRetries: number;
    // Wait before retry n (1-based) is `baseDelayMs * 2 ** (n - 1)`.
    baseDelayMs: number;
};

const resolveRetryPolicy = (configuration: HarnessRetryConfiguration | undefined): RetryPolicy => {
    // `false` is the explicit opt-out: exactly one attempt, first failure wins.
    if (configuration === false) return { maxRetries: 0, baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS };

    const maxRetries = configuration?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = configuration?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
        throw new HarnessError(
            `retry.maxRetries must be a non-negative safe integer; received ${String(maxRetries)}.`
        );
    }

    if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1) {
        throw new HarnessError(
            `retry.baseDelayMs must be a positive safe integer; received ${String(baseDelayMs)}.`
        );
    }

    return { maxRetries, baseDelayMs };
};

// The wait before retry `attempt` (1-based): 1000, 2000, 4000 ... 32000, then 60000 for
// every later retry. The ceiling is what `RETRY_MAX_DELAY_MS` is for (../core/agent-limits.ts):
// the doubling decides how FAST the waits grow, the ceiling decides how LONG the run may
// sleep for one of them. An uncapped ladder slept 512 s on its last wait and 1023 s in
// total — longer than most provider outages — so the tail is now flat and the published
// `delayMs` stays honest (no jitter: a host that wants it varies `retry.baseDelayMs`).
const retryDelayOf = (policy: RetryPolicy, attempt: number): number =>
    Math.min(policy.baseDelayMs * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);

// ---------------------------------------------------------------------------
// Provider failure classes (T6)
// ---------------------------------------------------------------------------

// Total attempts for the connection ladder (the initial one plus its 2 retries).
// `retry.maxRetries` does NOT stretch it: a host widening the transient ladder is
// saying "my provider blips", not "my provider is down", and a dial that reached
// nobody still deserves the fast terminal answer.
const PROVIDER_CONNECTION_MAX_ATTEMPTS = PROVIDER_CONNECTION_MAX_RETRIES + 1;

// The wait before retry `attempt` (1-based) of the connection ladder: 250, 500.
const providerConnectionDelayOf = (attempt: number): number =>
    PROVIDER_CONNECTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);

// Total attempts for the provider-timeout ladder (the initial one plus its 3 retries).
// Like the connection ladder, `retry.maxRetries` does NOT stretch it: widening the
// transient ladder says "my provider blips", not "give a provider that already missed a
// five-minute bound eleven more chances". The whole shape (4 attempts, 2 s/4 s/8 s, a
// 30 s per-delay ceiling, a 900 s ladder deadline) is justified in ../core/agent-limits.ts.
const PROVIDER_TIMEOUT_MAX_ATTEMPTS = PROVIDER_TIMEOUT_MAX_RETRIES + 1;

// The wait before retry `attempt` (1-based) of the timeout ladder: 2000, 4000, 8000 by
// default, never above `PROVIDER_TIMEOUT_RETRY_MAX_DELAY_MS`.
//
// `retry.baseDelayMs` RAISES this ladder's base but never lowers it: a host that
// configured 20 s waits for its transient failures means "my provider needs longer
// between dials", and that intent applies a fortiori to a provider that just missed a
// time bound — while the ceiling still flattens the tail, so a 20 s base yields
// 20 s, 30 s, 30 s and not 20 s, 40 s, 80 s. The shipped default (1 s) is below the
// ladder's own 2 s floor, so the documented 2 s / 4 s / 8 s ladder is what runs unless a
// host asks for more.
const providerTimeoutDelayOf = (policy: RetryPolicy, attempt: number): number =>
    Math.min(
        Math.max(policy.baseDelayMs, PROVIDER_TIMEOUT_RETRY_BASE_DELAY_MS) * 2 ** (attempt - 1),
        PROVIDER_TIMEOUT_RETRY_MAX_DELAY_MS
    );

// The wall clock ONE `provider-timeout` ladder may consume. Captured at the top of
// `attemptWithRetries` (the first attempt's start) and compared against
// `PROVIDER_TIMEOUT_RETRY_DEADLINE_MS` before another attempt is scheduled. It bounds
// the PROVIDER's time too, not just our sleeps, because that is the number the operator
// experiences: four dials into a gateway whose bound is minutes must not become an hour.
//
// `Date.now()` rather than an injected clock: the ladder is the only consumer, the value
// only ever gates a decision (it is never published), and every test that drives it runs
// under faked timers, which move `Date.now()` with the same clock as the backoff timers.
const providerTimeoutDeadlineOf = (): number => Date.now() + PROVIDER_TIMEOUT_RETRY_DEADLINE_MS;

// ---------------------------------------------------------------------------
// The ONE overflow question the retry loop asks
// ---------------------------------------------------------------------------

// Is this thrown failure a context-length refusal? `context-overflow` is the machine
// name for it, and it is terminal for EVERY caller of this file, so the answer lives in
// one predicate instead of beside one `catch`.
//
// TWO SOURCES, in that order, and both are structured — nothing here matches prose:
//   1. `error.code` — what the built-in transport puts on the frame
//      (transport/openai.ts for a 400/413 response, and, since 2026-11-17,
//      transport/provider-timeouts.ts `providerWireFailureOf` for a size refusal
//      relayed on a gateway's SSE error frame, which is how the reported failure
//      actually arrived), and what this file's own pre-request floor throws.
//   2. `details.errorClass` — read through `providerDiagnosticsOf`, the same shape-
//      checking reader ../harness.ts trusts for the terminal record. A HOST transport is
//      allowed to classify without setting a `code` (the built-in one does exactly that
//      for `provider-transit`), and a frame it diagnosed as a context overflow must not
//      walk the ladder either. Checking the diagnostics block keeps "what the UI renders"
//      and "what the retry owner trusts" one answer, which is the rule
//      transport/provider-timeouts.ts states for diagnostics generally.
//
// WHY THE ANSWER IS TERMINAL AND NOT A ONE-ATTEMPT LADDER. "Compact and retry" is the
// right recovery, and it is NOT expressible here: this loop re-sends the SAME bytes, so a
// second attempt is the same oversized request and the same refusal — the ladder cannot
// change the one input the refusal is about. The transcript has to shrink first, and
// shrinking it is policy ABOVE an agent request (the `turn.before` hook and the shipped
// context-compaction plugin, which replace the transcript and re-ask). A bounded retry
// inside this loop would therefore be a paid re-send that cannot succeed, which is exactly
// the defect the sibling classes were carved out to stop. So the class keeps ZERO retries
// — no named cap constant, because a cap of zero is this predicate, not a ladder the
// `retry` policy could stretch.
const isContextOverflowFailure = (error: unknown): boolean => {
    if (isInstanceOf(error, HarnessError) && error.code === CONTEXT_OVERFLOW_CODE) return true;

    return providerDiagnosticsOf(error)?.errorClass === CONTEXT_OVERFLOW_CODE;
};

// ---------------------------------------------------------------------------
// The operator's retry line (2026-11-24, the per-attempt provider trace)
// ---------------------------------------------------------------------------

// ONE LINE PER RETRIED ATTEMPT, from the only layer that knows the LADDER. The transport
// prints the wire-fact pair around every request (`provider attempt:` before the dial,
// `provider attempt failed:` on the way out — ../transport/openai.ts, "Operator log"), and
// those are the ONLY lines for a failure this file never re-sends: a terminal class, a
// one-attempt run, `retry: false`. What only the retry owner has is the count and the wait,
// and without them an operator watching `attempt 1..11 of 11 failed` cannot tell a provider
// that died eleven times from a request that was refused eleven times.
//
// COMPLEMENTARY, NOT DOUBLED. The transport line for this same attempt already named the
// model, the redacted dial target and the class one line earlier in the same stream, so this
// line contributes the attempt number, the class total and the delay. It REPEATS the model on
// purpose — that is the fact the reported incident was missing, the published `retry` event
// has no model field (../types/index.ts `HarnessProviderAttemptDiagnostics`, frozen: a new
// field cascades into a forked type copy and a Rust port), and a UI tile renders THIS line's
// vocabulary, so the model has to be greppable on it. It does NOT repeat the URL: that is the
// transport line's job, and copying it here would be the same sentence twice.
//
// `console.error`, `[harness]`-prefixed, ungated: this package has no debug sink to route an
// operator line to, and nothing resembling a verbosity level to gate behind (its `HARNESS_*`
// variables are provider timeouts, worker limits and filesystem paths —
// ../transport/provider-timeouts.ts and ../../../server/config.ts — not log tiers), so the
// alternative would be inventing a deployment contract for one line per retried attempt. The
// precedent — including the stated rationale ("this package has no debug sink to route one
// to") — is the store's stderr note at ../../../server/workers/lane-host.ts:1104-1131.

// The model id for the log line, printed WITHOUT ever throwing. `model` is an
// `AgentModelAccessor`, and the reported incident was a request the provider answered
// `Model 'undefined' not found`, so a non-string model must still NAME itself on the line
// rather than take the retry loop down: a bare interpolation THROWS on a Symbol, and `String`
// itself refuses an object with no usable `toString` (a null-prototype object).
const logModelFieldOf = (model: unknown): string => {
    try {
        return typeof model === 'string' ? model : String(model);
    } catch {
        return '<unprintable>';
    }
};

// The line itself, never fatal: a host that replaced `console`, or a lane worker whose stdio
// closed mid-ladder, must not turn a retry into a failure because a log line threw.
const providerRetryLog = (input: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    model: unknown;
    failureClass: string | undefined;
}): void => {
    try {
        console.error(
            `[harness] provider attempt ${input.attempt} of ${input.maxAttempts} failed, retrying in ${input.delayMs}ms: ` +
                `model=${logModelFieldOf(input.model)} · class=${logModelFieldOf(input.failureClass ?? 'unclassified')}`
        );
    } catch {
        // Logging never changes control flow.
    }
};

// ---------------------------------------------------------------------------
// Pre-request context floor (issue 0004)
// ---------------------------------------------------------------------------

// The resolved floor for one agent, in tokens: `undefined` means "no guard", which is
// today's behaviour byte-for-byte. Resolved and validated HERE — at construction —
// because a bad number is a configuration mistake and must fail on the line it was
// written, the rule `resolveRetryPolicy` and `requireAgentColor` above follow.
//
// Both spellings are validated even when one is shadowed by the other, so a typo in
// the losing field is still a construction failure rather than a silently dead setting.
//
// Precedence: `maxPromptTokens` (agent scope) beats `provider.contextWindow`
// (endpoint scope) — one brain on a shared endpoint may aim lower than the window, and
// the narrower scope is the one its author is reading.
//
// `provider.contextWindow` is read even when an explicit `stream` owns the wire (the
// provider block is ignored for the REQUEST in that case, as documented). That is
// deliberate: the floor is not a wire field, it is a decision this agent makes about
// its own transcript, so a host on a custom transport gets the same guard.
const requireContextWindow = (configuration: AgentConfiguration): number | undefined => {
    const agentWindow = configuration.maxPromptTokens;
    const providerWindow = configuration.provider?.contextWindow;

    for (const [field, value] of [
        ['maxPromptTokens', agentWindow],
        ['provider.contextWindow', providerWindow]
    ] as const) {
        if (value === undefined) continue;

        if (!Number.isSafeInteger(value) || value < 1) {
            throw new HarnessError(
                `${field} must be a positive safe integer of tokens; received ${String(value)}. ` +
                    `It is compared against the transcript estimate from core/context-estimate.ts.`
            );
        }
    }

    return agentWindow ?? providerWindow;
};

// What ONE attempt accumulated. Declared outside the factory because both the
// attempt generator and the retry wrapper return it.
type AttemptOutcome = {
    content: string;
    reasoning: string;
    stopReason: HarnessStopReason;
    toolCalls: HarnessToolCall[];
    usage: HarnessAssistantMessage['usage'];
};

// Abort check for a request (R2). The caller's own reason is thrown, exactly like
// the harness's `throwIfAborted`, so a cancelled run keeps its identity.
const throwIfAborted = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) {
        throw signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
    }
};

// An abort is a CONTROL OUTCOME, never a failure to retry (R1/R2). The reason the
// signal carries is the caller's own value, so it is what ends the request; only
// the "is this an abort" decision is made here.
const isAbortError = (error: unknown, signal: AbortSignal | undefined): boolean => {
    // A signal that fired is authoritative even when the transport threw a
    // wrapper error (`AbortError` vs. a provider's own "request aborted" text).
    if (signal?.aborted === true) return true;

    try {
        if (error instanceof Error && error.name === 'AbortError') return true;
    } catch {
        // A hostile thrown value may make `instanceof` throw; it is not an abort.
        return false;
    }

    return false;
};

// Sleep for `ms`, but settle IMMEDIATELY when `signal` aborts (R2).
//
// Cleanup rules:
//   - the timer is cleared on abort, so a cancelled request never waits out a
//     backoff. The harness aborts a run's signal on cancellation, so this is the
//     path every cancelled run takes;
//   - the listener is removed on both paths (settle and abort), so no listener
//     leaks into a later run.
//
// A caller that walks away from the stream WITHOUT aborting cannot be detected from
// inside a generator suspended on this wait, which is why the harness always owns a
// signal: cancellation is the supported way to abandon a request.
const waitForRetry = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        // Already cancelled: no timer is created at all.
        if (signal?.aborted === true) {
            reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
            return;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;

        const onAbort = (): void => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            reject(signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        };

        timer = setTimeout(() => {
            timer = undefined;
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        signal?.addEventListener('abort', onAbort, { once: true });
    });

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// `baseline` is an INTERNAL seed used only by Agent.fork(): when present, the
// branch's initial transcript and reset baseline are the materialized clone,
// while `instructions` stays the source's instruction snapshot. The public
// `agent()` wrapper below never exposes it.
const createAgent = (
    configuration: AgentConfiguration,
    baseline?: readonly HarnessMessage[]
): Agent => {
    if (!configuration.model) {
        throw new HarnessError('An agent requires a model.');
    }

    // Identity color (R2) is validated with the other setup fields, before the
    // transport is resolved, so a typo is a construction failure at the point of
    // configuration rather than a broken swatch later. It is display-only: it
    // never enters a request, a transcript, or a snapshot.
    const color = requireAgentColor(configuration.name ?? 'agent', configuration.color);

    // Structured output (issue 0001 B). The schema is gated HERE, before the transport
    // exists, for the same reason the color is: a schema the runtime gate cannot bound
    // (or cannot express) is a configuration mistake, and it must fail on the line it
    // was written instead of on the first answer. `structured` then does two things:
    //   - it rides into the built-in transport as `provider.responseFormat` (see
    //     `resolveStream`), and
    //   - it becomes the acceptance test every answer of this agent must pass (see
    //     `request`).
    const structured = requireStructuredSchema(
        configuration.name ?? 'agent',
        configuration.structured
    );

    // Context floor (issue 0004). Resolved with the other setup fields, before the
    // transport exists, so a bad window is a construction failure on the line it was
    // written. `undefined` means no guard, and every request path below is then
    // byte-for-byte what it was before this setting existed.
    const contextWindow = requireContextWindow(configuration);

    const transport = resolveStream(configuration, structured);
    const instructions = normalizeInstructions(configuration.instruction);

    // The model is mutable: a caller can switch models mid-conversation without
    // rebuilding the agent (and losing its history). A change applies to the NEXT
    // request: a request already streaming keeps the model it started with, and
    // the assistant message it commits names that model (requestModel below).
    let model = configuration.model;

    // History starts as instructions + seed history (`prefix`, then `messages`).
    // Every mutation below goes through this one array, so plugins and callers
    // observe a single source of truth.
    const messages: HarnessMessage[] = [];

    // THE LIVE PREFIX SEED (U6 — `Harness.setAgentPrefix`).
    //
    // `prefixOverride` replaces the seed source for the WHOLE life of this brain: `seed()` reads
    // through it, so a prefix write moves the CURRENT transcript band, the `reset()` baseline, and
    // the configuration a NEW host thread is built from (see `registerAgentThreader` below) in one
    // place, and does it without giving the public `Agent`/`AgentConfiguration` shape a mutable
    // field the host could scribble on.
    //
    // `undefined` means "no write happened", which keeps the historical behaviour byte-for-byte:
    // `seed()` re-reads `configuration.prefix` on every call, so a caller that mutates its own
    // configuration array between turns still gets the new seed (a documented property of `reset()`
    // — see the note in `seed`). An EXPLICIT `[]` is different and meaningful: it is the
    // removal (`setAgentPrefix(name, [])`), and it must beat a non-empty `configuration.prefix`,
    // which is why the sentinel is `undefined` and not an empty array.
    let prefixOverride: readonly PrefixSeedMessage[] | undefined;

    // The transcript entries the LAST seed pushed from the prefix source, IN ORDER, kept by
    // reference. This is what makes the band addressable: `writeAgentPrefix` replaces exactly
    // these entries and refuses (rather than splicing unrelated history) when the transcript no
    // longer holds them where the seed put them. Empty for a fork, whose transcript IS its own
    // baseline and therefore has no mutable seed band (see the fork branch of `seed`).
    let seededPrefix: PrefixSeedMessage[] = [];

    // The seed source, resolved on EVERY call so an un-written agent keeps reading the caller's
    // live configuration object.
    const prefixSourceOf = (): readonly PrefixSeedMessage[] =>
        prefixOverride === undefined ? (configuration.prefix ?? []) : prefixOverride;

    const seed = (): void => {
        // Build the fully validated next transcript FIRST and replace the live
        // array only once every seed message passed. reset() calls this on an
        // already-committed conversation, so a bad seeded attachment (the caller
        // may have mutated `configuration.prefix` or `configuration.messages`
        // after construction) must throw WITHOUT erasing the transcript the
        // session is using.
        const next: HarnessMessage[] = [];

        // FORK BASELINE: a branch starts from its cloned source transcript, not
        // from instructions + prefix + configuration.messages (the source's history
        // already contains those). Reset re-clones it, so a branch never shares
        // mutable state with its source or with a previous reset.
        if (baseline !== undefined) {
            for (const message of baseline) {
                // T1.4 — a fork COPIES ids: the clone below carries the source entry's
                // `messageId` rather than minting a new one, so `setIncluded(id)` means
                // the same turn on the fork and on its owner. Two objects, one
                // identity; every lookup is scoped to the transcript this agent owns.
                next.push(assignMessageId(copyBaselineMessage(message), next, message.messageId));
            }

            messages.length = 0;
            for (const message of next) messages.push(message);

            // A branch has NO mutable prefix band: its transcript is its own baseline and already
            // contains the source's preset turns (`forkFrom` deliberately does not forward
            // `prefix`, and `writeAgentPrefix` refuses a branch for exactly this reason). Clearing
            // the record here also makes a later `reset()` of a fork re-derive the empty band.
            seededPrefix = [];

            return;
        }

        for (const instruction of instructions) {
            // An instruction block is a canonical message like any other, so it is
            // addressable too: `setIncluded('msg-1')` disabling a system instruction
            // from the model is a real thing a compactor does.
            next.push(assignMessageId({ role: 'system', content: instruction }, next));
        }

        // ONE loop for BOTH seed-history fields, so `prefix` (preset agentic history)
        // and legacy `messages` get byte-identical hygiene below: the `included`
        // normalization, the detached copy, seeded-attachment validation and id
        // minting. Two copies of this body is how one field would silently drift from
        // the other.
        //
        // ORDER is the published contract: instructions, then `prefix`, then
        // `messages`. The spread copies the caller's ARRAY only (its entries are still
        // the caller's objects); each entry is detached again by `withIncluded`, so
        // live history never aliases a caller object, while a reset still re-reads
        // whatever the caller has since written into either array.
        //
        // U6: the prefix source is resolved ONCE, into `prefixTurns`, and its length is kept.
        // That count is the ONLY way the band record below can tell a seeded prefix entry from a
        // legacy `messages` entry: both run through the same loop, and after the commit the two
        // kinds are indistinguishable by shape (a prefix turn and a seed-history turn are the same
        // role/content message).
        const prefixTurns = prefixSourceOf();
        const prefixCount = prefixTurns.length;

        for (const message of [...prefixTurns, ...(configuration.messages ?? [])]) {
            // Every seed entry passes through `withIncluded`, which is where a
            // host-supplied `included: true` (or `included: undefined`) stops being
            // a canonical key: absent is the only spelling of "included", so no
            // later copy, projection or request object has to defend against it.
            //
            // The same call strips any id the caller put on a seed message, and the
            // transcript mints its own (T1.2). That is deliberate: seeded history
            // enters as a NEW conversation, and honouring a caller's ids would let two
            // seed entries carry the same one — an ambiguity nothing downstream could
            // report. Copy paths (the fork baseline above, a restore, a branch) are the
            // ones that carry an existing id, and only they.
            //
            // Seeded user messages may carry attachments too. Validate and copy
            // them now, so a bad seed fails construction instead of reaching a
            // transport (and so the configuration's array is never aliased by
            // live history). Text-only seeds keep their exact old shape.
            if (message.role === 'user' && message.attachments !== undefined) {
                next.push(
                    assignMessageId(
                        withIncluded({
                            ...message,
                            attachments: validateAttachments(message.attachments)
                        }),
                        next
                    )
                );
                continue;
            }

            // A seeded TOOL message may carry download media. Same rule as the
            // user branch above, with the download profile: validate and detach
            // before the live array is replaced, so a bad seed fails construction
            // and history never aliases the caller's objects.
            if (message.role === 'tool' && message.attachments !== undefined) {
                next.push(
                    assignMessageId(
                        withIncluded({
                            ...message,
                            attachments: validateAttachments(message.attachments, DOWNLOAD_ATTACHMENT_LIMITS)
                        }),
                        next
                    )
                );
                continue;
            }

            next.push(assignMessageId(withIncluded(message), next));
        }

        // Commit point: everything above succeeded.
        messages.length = 0;
        for (const message of next) messages.push(message);

        // THE MUTABLE PREFIX BAND (U6). Record which entries THIS seed pushed from the prefix
        // source, so `writeAgentPrefix` can replace exactly them: the instructions occupy
        // `[0, instructions.length)` and the prefix follows immediately, so the band is
        // `[instructions.length, instructions.length + prefixCount)`. These are the live objects
        // the transcript now holds (the same references `agent.messages` exposes), which is what
        // lets the guard below distinguish "this entry is still the seeded one" from "a compactor
        // replaced it". The slice can only hold prefix-source entries — a legacy
        // `configuration.messages` entry, which may carry a `tool` role, starts at
        // `instructions.length + prefixCount` — so narrowing it to `PrefixSeedMessage[]` is the
        // order the seed itself established, not an assumption.
        seededPrefix = next.slice(instructions.length, instructions.length + prefixCount) as PrefixSeedMessage[];
    };

    seed();

    // -----------------------------------------------------------------------
    // THE PREFIX BAND SEAM (U6) — `Harness.setAgentPrefix` / the server's prefix read
    // -----------------------------------------------------------------------
    //
    // WHAT THIS IS. The one place that can move a brain's SEEDED PREFIX BAND: the run of
    // transcript entries `seed()` pushed from the prefix source, sitting between the instruction
    // block and the legacy `configuration.messages` seed (and therefore before every turn the
    // conversation has accumulated). A host that edits preset history wants three things at once
    // and none of them is reachable through the public `Agent` surface:
    //   1. the CURRENT transcript's band replaced, in place, with every accumulated turn kept by
    //      reference (no rebuild, so no lost conversation);
    //   2. the RESET baseline replaced, so `reset()` returns to the new band;
    //   3. the THREAD factory replaced, so the next host thread of this agent seeds the new band.
    // All three fall out of writing `prefixOverride` once, because `seed()` and the thread factory
    // both read the source through `prefixSourceOf`.
    //
    // WHY A WEAKMAP AND NOT A FIELD. The registered pair below is reached from the exported
    // `writeAgentPrefix`/`agentPrefixOf` helpers by object identity, so the PUBLIC `Agent` type
    // gains no mutable configuration field a host could scribble on outside the guards here (the
    // same seam style as `registerAgentForker`/`registerAgentThreader`, and the reason
    // `setAgentInstruction` had to reach into `agent.instructions` as a widened local).
    const writePrefix = (turns: readonly HarnessPrefixTurn[]): void => {
        // The runtime check behind the declared `readonly HarnessPrefixTurn[]`: `setAgentPrefix`
        // has no `null` spelling (the SERVER resolves inheritance before calling it, and the
        // runtime has nothing to inherit from), so anything that is not an array is a caller
        // mistake and `[]` is the one that means "remove the band".
        if (!Array.isArray(turns)) {
            throw new HarnessError(
                `Agent "${self.name}" needs an ARRAY of prefix turns. Send [] to remove the seeded band.`
            );
        }

        // A FORK HAS NO BAND TO REWRITE (see the fork branch of `seed`, and `forkFrom`, which
        // deliberately does not forward `prefix`). Its transcript IS the baseline — the source's
        // preset turns are already in it — so giving a branch a second mutable seed band would
        // put those turns in front of the branch twice. Roster writes address the registered
        // brain, never a branch object, so this refusal is the backstop rather than the ordinary
        // path; it exists so a caller that grabs a branch handle gets a sentence instead of a
        // double injection.
        if (baseline !== undefined) {
            throw new HarnessError(
                `Agent "${self.name}" is a forked conversation: its transcript is its own baseline, so it has no seeded prefix band to rewrite.`
            );
        }

        // STEP 1 — validate and detach the submitted turns BEFORE anything moves. A bad role, a
        // non-string content, or a non-object answers with the position that is wrong and leaves
        // the transcript exactly as it was (the same "build the next value first, commit last"
        // discipline `seed()` applies to a bad seeded attachment).
        const band: PrefixSeedMessage[] = [];

        for (const [index, turn] of turns.entries()) band.push(copyPrefixTurn(turn, self.name, index));

        // STEP 2 — prove the band the last seed created is still the band the transcript holds.
        // `instructions.length` is the live band start, so this stays correct after
        // `setAgentInstruction` changed the instruction block above it. A missing, moved, or
        // rewritten entry is a refusal: splicing at a shifted position would rewrite an
        // accumulated turn the caller never named.
        const start = instructions.length;

        for (let index = 0; index < seededPrefix.length; index += 1) {
            if (!samePrefixTurn(messages[start + index], seededPrefix[index] as PrefixSeedMessage)) {
                throw new HarnessError(
                    `Agent "${self.name}" no longer carries its seeded prefix band at position ${String(index)}; refusing to splice unrelated history.`
                );
            }
        }

        // STEP 3 — replace exactly the band, in place. `messages` is the live array the handle
        // hands out, so a server holding `agent.messages` sees the new state immediately, and
        // every entry from `start + seededPrefix.length` onward — the legacy seed history and
        // every committed turn — keeps its object identity untouched.
        messages.splice(start, seededPrefix.length, ...band);

        // Mint one id per new entry, against the LIVE transcript and in order: each scan sees the
        // id the previous iteration wrote, so the band takes the ids above everything the
        // conversation already owns. This is the same reserve-from-max rule every canonical
        // creation point uses (core/message-id.ts) and the reason a caller-supplied id, dropped
        // by `copyPrefixTurn`, can never collide with a committed turn.
        for (let offset = 0; offset < band.length; offset += 1) {
            messages[start + offset] = assignMessageId(
                messages[start + offset] as HarnessMessage,
                messages
            );
        }

        // STEP 4 — the new BASELINE. `prefixOverride` is what `seed()` (a `reset()`) and
        // `registerAgentThreader` (a NEW host thread) read from now on, so the write survives
        // both. It holds the id-free copies, and that is deliberate: a later seed mints its own
        // ids for the band exactly like the construction seed did, and the reset transcript
        // numbers can never be stale copies of the ones the replaced band had.
        prefixOverride = band;
        seededPrefix = messages.slice(start, start + band.length) as PrefixSeedMessage[];
    };

    // The CURRENT band, in the closed wire shape. Role + content only: a seeded entry that
    // carries an attachment (the wider `AgentConfiguration.prefix` allows one) is reported as its
    // text, because the surface this read serves — a prefix editor — edits text and would
    // otherwise round-trip a field it cannot write. An empty array is the honest answer for a
    // member with no prefix and for a fork, whose turns are conversation history rather than a
    // seed band.
    const readPrefix = (): HarnessPrefixTurn[] =>
        seededPrefix.map((entry) => ({ role: entry.role, content: entry.content }));

    // The retry policy for this agent, resolved once (see resolveRetryPolicy).
    const retryPolicy = resolveRetryPolicy(configuration.retry);
    // Total attempts = the initial one plus its retries. `maxAttempts` is what the
    // `retry` event reports so a consumer can render "2 of 11" without guessing.
    const maxAttempts = retryPolicy.maxRetries + 1;

    // Assigned below; the appending helpers close over it so they can chain.
    let self: Agent;

    const append = (role: 'system' | 'user' | 'assistant', content: string): Agent => {
        // T1.2 — a canonical creation point. The id is minted against `messages` AS IT
        // IS BEFORE THE PUSH (the call argument is evaluated first), which is what makes
        // one id per transcript sequence impossible to repeat.
        messages.push(assignMessageId({ role, content }, messages));
        return self;
    };

    // User append with optional attachments. Validation is the FIRST thing that
    // happens, so a malformed attachment can never leave a half-validated user
    // message in history. `validateAttachments` returns detached copies, so the
    // caller's array/objects cannot be mutated into (or out of) the transcript.
    //
    // The `attachments` key is omitted for a text-only message: that keeps every
    // pre-attachment transcript and snapshot byte-identical.
    const appendUser = (content: string, attachments?: HarnessAttachment[]): Agent => {
        const validated = validateAttachments(attachments);

        // T1.2 — this is the append `runAgentCore` uses for a run's root user message,
        // so the prompt a `turn.before` handler sees next round is addressable by id
        // (core/message-id.ts; see `append` above for the minting rule).
        messages.push(
            assignMessageId(
                validated.length > 0
                    ? { role: 'user', content, attachments: validated }
                    : { role: 'user', content },
                messages
            )
        );

        return self;
    };

    // One transport call against the current history. Shared by both turn() and
    // stream() so there is exactly one place that knows how a turn is built.
    //
    // RETRY STRUCTURE (R1/R3). `request` owns the retry loop; `attemptRequest`
    // owns ONE attempt. Everything an attempt accumulates (content, reasoning,
    // tool calls, usage) lives INSIDE `attemptRequest`, so a failed attempt's
    // partial output can never leak into the committed message or into the next
    // attempt. Only the model request is re-sent: nothing above this boundary
    // (tools, tool results, run state) is touched, and the harness sees one
    // turn() no matter how many transport calls it took.
    const request = async function* (options: AgentStreamOptions | undefined): AsyncGenerator<
        AgentStreamEvent,
        AgentRequestCommit
    > {
        // Capture the model for THIS request. The accessor is mutable (a session
        // can retarget an agent mid-conversation, see server/sessions.ts
        // setAgentModels), so reading it again at the end would let a change that
        // arrives while the transport is streaming relabel a message the OLD model
        // actually produced. One snapshot keeps the request, the transport payload,
        // and the committed attribution identical. A retry re-sends the SAME model:
        // it is the same request, not a new one.
        const requestModel = model;

        // Copy the transcript ONCE: every attempt of this request sends exactly the
        // same payload. A transport must never see a live array it could mutate, and
        // later appends must not appear mid-request.
        //
        // A `transcript` override (background tools) replaces the COMMITTED
        // history for this request only. It is already a projection the harness
        // built; copying again keeps the transport from mutating the projection
        // the harness may reuse. The assistant message still commits below to the
        // canonical `messages` array, never to the projection.
        const source = options?.transcript ?? messages;
        // Copy the transcript shallowly, and COPY an attachment array so the
        // transport never receives a live array it could mutate (the same rule
        // that governs the message list itself). Both attachment-carrying roles
        // are detached: a user's composer upload AND a tool message's download
        // media. The attachment objects are copied, not their `data` strings, so
        // a 20 MiB file costs a pointer per request rather than a re-allocation.
        const transcript = source.map((message) => {
            if (message.role === 'user' && message.attachments !== undefined) {
                return {
                    ...message,
                    attachments: message.attachments.map((attachment) => ({ ...attachment }))
                };
            }

            if (message.role === 'tool' && message.attachments !== undefined) {
                return {
                    ...message,
                    attachments: message.attachments.map((attachment) => ({ ...attachment }))
                };
            }

            return { ...message };
        });

        // CONTEXT FLOOR (issue 0004). Measured on the exact array the transport is
        // about to receive — the harness's projection when one was handed in, so a
        // `turn.before` compaction pass has ALREADY had its chance to shrink the
        // transcript, and this only refuses what is still too big after policy ran —
        // and with the published estimator, i.e. the same
        // `ceil(serialized-payload bytes / 4)` the UI context bar and the compaction
        // plugin use.
        //
        // What the floor therefore cannot see is the SAME list the estimator cannot
        // see: the serialized tool schemas, the message framing, and attachment bytes.
        // A request with a huge tool registry can still reach a provider 400, which is
        // why (3) classifies the provider's answer under this very code rather than
        // pretending the estimate is exact. The provider-anchored hybrid
        // (`estimateContextTokensHybrid`) DOES absorb that overhead, but it needs a
        // previous `usage` report to anchor on, so it cannot guard a first request.
        //
        // Why the throw sits OUTSIDE `attemptWithRetries` (like the abort boundary
        // below it, and for the same reason): an oversized transcript is a bug in
        // what is being sent, not a transient provider failure. Re-sending the same
        // bytes through the whole backoff ladder answers the same way eleven times,
        // so the retry layer must not own this decision at all.
        //
        // What the caller gets: `turn()` throws the coded error; `stream()` yields its
        // usual `error` event (with `code` on the payload via `toErrorInfo`) and rolls
        // the user message back, so nothing was appended, nothing was fetched, and the
        // next request starts from the same clean history. `details` carries the pair
        // for a host that has to recover, per the `HarnessError` convention.
        if (contextWindow !== undefined) {
            const estimatedTokens = estimateContextTokens(transcript);

            if (estimatedTokens > contextWindow) {
                throw new HarnessError(
                    `${CONTEXT_OVERFLOW_CODE}: agent "${self.name}" would send an estimated ` +
                        `${estimatedTokens} tokens against a ${contextWindow}-token window, so the ` +
                        `request was not sent and is not retried. The estimate is ceil(payload bytes / 4) ` +
                        `over the transcript about to be sent (core/context-estimate.ts), counting each ` +
                        `field as the request serializes it — the same number the UI context bar shows; ` +
                        `attachment bytes and the request's tool schemas are not counted. Send less — a ` +
                        `turn.before handler may replace the transcript, and the shipped ` +
                        `context-compaction plugin owns that policy — ` +
                        `or raise maxPromptTokens / provider.contextWindow.`,
                    {
                        code: CONTEXT_OVERFLOW_CODE,
                        details: {
                            estimatedTokens,
                            contextWindow,
                            model: requestModel,
                            agent: self.name
                        }
                    }
                );
            }
        }

        // One attempt. Its accumulators are local, so a throw discards them.
        //
        // COMPLETION IS TERMINAL FOR OUTPUT (F3). A transport `done` frame is the
        // model's whole answer: from that moment nothing else is rendered or
        // accumulated, and a THROW from the stream afterwards (a provider wrapper
        // rejecting from its own cleanup) is swallowed instead of reaching the retry
        // loop. A retry there would re-send a request whose answer the UI has already
        // committed, so both answers would render.
        //
        // The ONE thing still observed after `done` is an explicit `error` FRAME: that
        // is the transport DECLARING the generation failed (the pre-existing contract,
        // see harness.retry "never executes a tool call from a failed attempt"). It
        // still fails the attempt, because committing it would launch tool calls the
        // provider never completed. A throw is not that signal: it is cleanup noise.
        //
        // The iterator is driven by hand (not `for await`) because this attempt owns
        // when it stops and must own the `return()` that unwinds it.
        const attemptRequest = async function* (): AsyncGenerator<AgentStreamEvent, AttemptOutcome> {
            let content = '';
            let reasoning = '';
            let stopReason: HarnessStopReason = 'stop';
            let toolCalls: HarnessToolCall[] = [];
            let usage: HarnessAssistantMessage['usage'];
            // A transport that ends WITHOUT a terminal `done` frame (a socket that
            // closed mid-stream) has not completed the request: committing that as an
            // empty answer would silently swallow the failure. It is reported like any
            // other model-call failure, so the retry loop re-sends the request (R1).
            let completed = false;
            // The attempt's own failure, captured instead of thrown straight out of
            // the loop so cleanup can run first without ever masking it.
            let failure: unknown;
            let failed = false;

            const iterator = transport({
                model: requestModel,
                messages: transcript,
                tools: options?.tools,
                signal: options?.signal
            })[Symbol.asyncIterator]();

            try {
                while (true) {
                    const next = await iterator.next();
                    // The transport returned without a `done` frame: leave the loop
                    // and report the truncated stream below.
                    if (next.done === true) break;

                    const event = next.value;

                    // Post-completion: see the header comment. Nothing is yielded,
                    // accumulated or attributed any more.
                    if (completed) {
                        if (event.type === 'error') {
                            failed = true;
                            // (issue 0004) The frame's machine code rides along, so a
                            // transport-declared overflow is still a `context-overflow`
                            // failure here rather than an anonymous one — the retry
                            // ladder below reads the code, not the prose.
                            // (T6) `details` rides along for the same reason `code`
                            // does: it is the transport's structured diagnosis, and the
                            // retry event below publishes it.
                            failure = new HarnessError(event.message, {
                                code: event.code,
                                details: event.details
                            });
                        }
                        continue;
                    }

                    switch (event.type) {
                        case 'text':
                            content += event.delta;
                            yield { type: 'text', delta: event.delta };
                            break;

                        case 'reasoning':
                            reasoning += event.delta;
                            yield { type: 'reasoning', delta: event.delta };
                            break;

                        // (T2) The transport's tool-call composition heartbeat, forwarded
                        // as an EVENT and nothing else: it is not accumulated into
                        // `content`/`reasoning`, not attached to the committed message, and
                        // not part of any commit decision, so the invariant "partial
                        // arguments are never executed" is untouched — the calls still
                        // arrive only on the terminal frame.
                        //
                        // ATTEMPT SCOPING needs no work here and that is the point: the
                        // retry loop re-CREATES the transport iterator for the next attempt
                        // (a fresh `stream(...)` call above), and the transport's throttle
                        // clock and counters live in THAT generator's closure. So when a
                        // `retry` discards everything streamed since the last attempt
                        // boundary, the progress state is discarded with it by construction —
                        // nothing stale can leak into the next attempt.
                        //
                        // A frame that arrives AFTER `completed` (a chatty provider that
                        // keeps streaming past its own `finish_reason`) is dropped by the
                        // post-completion guard above, exactly like a late text delta.
                        case 'progress':
                            yield {
                                type: 'progress',
                                phase: event.phase,
                                toolCallSlots: event.toolCallSlots,
                                argumentChars: event.argumentChars
                            };
                            break;

                        case 'error':
                            // Error frames are terminal FOR THIS ATTEMPT: they surface
                            // as a thrown error so the retry loop above can decide
                            // whether to re-send the request. The frame's message is
                            // the original, useful error text and is preserved
                            // verbatim.
                            //
                            // (issue 0004) A frame that carries a machine `code` keeps
                            // it on the thrown error — that is how a provider-side
                            // `context-overflow` reaches the retry decision below
                            // without anyone matching English prose. A frame without a
                            // code throws exactly the codeless `HarnessError` it threw
                            // before, so `error.name` and every existing payload are
                            // unchanged.
                            throw new HarnessError(event.message, { code: event.code, details: event.details });

                        case 'done':
                            stopReason = event.stopReason;
                            toolCalls = event.toolCalls;
                            usage = event.usage;
                            completed = true;
                            break;
                    }
                }
            } catch (error) {
                // A throw AFTER completion is cleanup noise, never a failed request
                // (F3). Before completion it is the attempt's real failure.
                if (!completed) {
                    failed = true;
                    failure = error;
                }
            }

            // Unwind the transport exactly once. Its `return()` may itself throw (a
            // provider wrapper that rejects from its own finally); that must not
            // turn a completed answer into a retried request, and must not replace
            // the attempt's real error when the attempt failed.
            try {
                await iterator.return?.(undefined);
            } catch {
                // Deliberately ignored: see above.
            }

            if (failed) throw failure;

            if (!completed) {
                throw new HarnessError(
                    `The model stream ended without a completion frame${content.length > 0 ? ' after partial output' : ''}.`
                );
            }

            return { content, reasoning, stopReason, toolCalls, usage };
        };

        // Retry sequence: attempt 1, then `maxRetries` further attempts. Returns the
        // FIRST successful attempt's outcome plus the attempt index that produced it
        // (reported by the success boundary below); a final failure rethrows the
        // original error of the last attempt (R1: useful original error, not a
        // wrapper).
        //
        // ONE DEADLINE PER REQUEST, CAPTURED BEFORE THE FIRST DIAL (2026-11-17). It is
        // taken here rather than per attempt on purpose: the `provider-timeout` ladder
        // bounds the WAIT THE CALLER EXPERIENCES for one model request — every attempt's
        // provider time plus our backoffs — and a budget re-read per attempt would never
        // expire. A later request in the same run (the next turn) owns a fresh budget.
        const attemptWithRetries = async function* (): AsyncGenerator<
            AgentStreamEvent,
            { outcome: AttemptOutcome; attempt: number }
        > {
            const timeoutDeadlineAt = providerTimeoutDeadlineOf();

            for (let attempt = 1; ; attempt++) {
                // ABORT BOUNDARY (R2): never start another attempt for a cancelled
                // request, and never wait out a backoff for one.
                throwIfAborted(options?.signal);

                try {
                    return { outcome: yield* attemptRequest(), attempt };
                } catch (error) {
                    // Cancellation is not an error to retry: the run stopped.
                    if (isAbortError(error, options?.signal)) throw error;

                    // AN OVERFLOW IS NOT A TRANSIENT FAILURE EITHER (issue 0004). A
                    // request the provider rejected for being too long re-sends the
                    // same oversized bytes and answers the same way, so the backoff
                    // ladder buys nothing — the code the transport put on the frame is
                    // what ends the sequence here, on the FIRST attempt, with the
                    // ORIGINAL error rethrown unchanged. Classified by
                    // `isContextOverflowFailure` above (a machine code, or the
                    // transport's structured diagnostics); nothing here matches on
                    // prose. The agent's own pre-request refusal never reaches this
                    // branch at all — it throws before the loop starts.
                    //
                    // (2026-11-17, the provider-transit context-limit report) The class
                    // now also covers a refusal the transport found on a GATEWAY SSE
                    // FRAME, not on a response status: a gateway that commits
                    // `200 OK` + `text/event-stream` before generating can only report
                    // its upstream's "prompt is too long" mid-stream, and until the
                    // shared matcher was wired into `providerWireFailureOf` that frame
                    // reached THIS catch codeless and burned all eleven attempts
                    // (`attempt 1..11 of 11 failed`, ~3 minutes) on bytes that cannot
                    // change. The retry math is the whole fix here: ONE attempt, the
                    // same error, no `retry` event.
                    //
                    // WHAT THE CALLER GETS (the signal the compaction policy consumes,
                    // in order of proximity):
                    //   1. `turn()` REJECTS with this same `HarnessError` — `code ===
                    //      CONTEXT_OVERFLOW_CODE`, `name` set to it by the class itself
                    //      (../util/errors.ts), and `details` whatever the transport
                    //      published (`errorClass`/`url`/`port` for a wire frame);
                    //   2. `stream()` yields `{ type: 'error', error: toErrorInfo(error) }`
                    //      — i.e. `{ message, code: 'context-overflow' }` — below, at the
                    //      `catch` of `stream()`;
                    //   3. ../harness.ts turns the same thrown error into the run's
                    //      terminal record and emits the `run.failed` hook as
                    //      `{ ...runLifecycleContext(run), error: toErrorInfo(error) }`,
                    //      so a plugin branch is `payload.error.code === 'context-overflow'`;
                    //   4. `classifyRunStopReason` (../harness.ts) reads that same code and
                    //      reports `api-error` (or `retries-exhausted`, if the run had
                    //      already spent a `retry` frame on an earlier turn) — NOT
                    //      `provider-network`: a refusal is not a network death, and the
                    //      auto-resume streak built on `provider-network` must not fire on
                    //      deterministic bytes. Before the in-stream arm existed this frame
                    //      was codeless + `provider-transit`, so it stopped as
                    //      `provider-network`; that change of stop reason is deliberate.
                    if (isContextOverflowFailure(error)) throw error;

                    const code = isInstanceOf(error, HarnessError) ? error.code : undefined;

                    // A DETERMINISTIC REFUSAL IS NOT A TRANSIENT FAILURE EITHER (T8,
                    // AC3). `provider-rejected` is the transport's name for an HTTP
                    // 400/401/403/404 answer (transport/openai.ts): the provider is up
                    // and refused THESE BYTES — a bad key, a wrong model id, a refused
                    // argument. Only the request can change, so the ladder cannot help;
                    // before this, that frame carried no code and spent the full
                    // 1 + 10-attempt ladder (~17 min) looking exactly like a hang. 408,
                    // 429 and 5xx are NOT in that class (time, not the request fixes
                    // them) and keep the ladder, as does every codeless frame — so an
                    // unclassified 4xx or a scripted provider error is still retried
                    // exactly as src/core/agent.retry.test.ts pins it.
                    //
                    // A PROVIDER-REPORTED CANCEL IS IN THE SAME FAMILY (2026-11-17).
                    // `provider-aborted` is the gateway's own in-stream `aborted` answer
                    // (transport/openai.ts `providerWireFailureOf`): the request was
                    // cancelled before it completed, so re-sending it buys an answer
                    // nobody is waiting for. A LOCAL stop never lands here — the
                    // `isAbortError` short-circuit above already caught it, so a user
                    // stop keeps its historical identity and this branch only ever sees
                    // a cancel that came from the provider side.
                    if (code === PROVIDER_REJECTED_CODE || code === PROVIDER_ABORTED_CODE) throw error;

                    // A DEAD DIAL IS NOT A TRANSIENT FAILURE EITHER (T6, AC2). A refused
                    // connection, an unresolvable host, or a reset before the first byte
                    // means nothing answered the port — a configuration condition, not a
                    // blip. It gets the short, capped ladder from ./agent-limits.ts
                    // (1 + 2 retries, 250 ms and 500 ms, 750 ms of waiting in total)
                    // instead of the 1 s -> 512 s one, then fails terminally with a
                    // message that names the dialled host:port. 17.05 minutes became
                    // under a second for a localhost refusal.
                    //
                    // A TIMEOUT IS NOT TERMINAL EITHER (T6, AC1 — as corrected by the
                    // unrecoverable-timeout report, 2026-11-17). It used to join the two
                    // terminal classes above: one attempt, zero `retry` frames, and a
                    // conversation marked interrupted forever because a gateway went
                    // silent 120 s into a stream. The reasoning behind that ("a provider
                    // that missed a five-minute bound is not repaired by an instant
                    // re-send") was right about the LADDER and wrong about the
                    // CONCLUSION — what it rules out is the 1 s -> 512 s transient
                    // ladder, not retrying. A wedged gateway usually un-wedges, so the
                    // class now gets its own short, bounded one:
                    //
                    //   4 attempts (1 + 3), waits 2 s / 4 s / 8 s capped at 30 s, and a
                    //   900 s wall-clock deadline over the whole sequence, INCLUDING the
                    //   provider time each attempt spent. Worst case with the shipped
                    //   defaults: 4 × the 120 s stream bound + 14 s of backoff ≈ 494 s.
                    //   `provider.*TimeoutMs` = 0 remains the escape hatch for a
                    //   legitimately slower provider: with no bound there is no
                    //   `provider-timeout` and no ladder at all.
                    //
                    // WHY THE DEADLINE AND NOT JUST AN ATTEMPT COUNT: the count bounds
                    // HOW MANY times a pathological endpoint is dialled, the deadline
                    // bounds HOW LONG the caller waits. A host that raised the bounds to
                    // minutes (or a gateway whose own upstream takes ten minutes) is the
                    // case only the deadline catches — four dials of ten minutes each
                    // would otherwise be an hour of spinner.
                    const connection = code === PROVIDER_CONNECTION_CODE;
                    const timeout = code === PROVIDER_TIMEOUT_CODE;

                    // `retry: false` / `retry.maxRetries: 0` IS A HARD OPT-OUT, for every
                    // class (2026-11-17). The two class ladders deliberately ignore a
                    // NON-ZERO `maxRetries` — widening the transient ladder says "my provider
                    // blips", not "dial my dead port eleven times" — but ZERO is a different
                    // statement: the published contract (../types/index.ts, `retry`: "`false` =
                    // one attempt only") promises a caller that it will not see a second
                    // request at all. A host passes it exactly when a re-send is unwanted
                    // rather than merely bounded: the server's scripted fixtures, a caller
                    // driving a non-idempotent endpoint, or a test that wants the failure on
                    // its own clock instead of the backoff's. Without this gate a
                    // `provider-timeout` spent 4 dials and 14 s under `retry: false`.
                    if (retryPolicy.maxRetries === 0) throw error;

                    const attemptsForClass = connection
                        ? PROVIDER_CONNECTION_MAX_ATTEMPTS
                        : timeout
                          ? PROVIDER_TIMEOUT_MAX_ATTEMPTS
                          : maxAttempts;

                    // Out of retries for THIS class: the last attempt's own error is the answer.
                    if (attempt >= attemptsForClass) throw error;

                    const delayMs = connection
                        ? providerConnectionDelayOf(attempt)
                        : timeout
                          ? providerTimeoutDelayOf(retryPolicy, attempt)
                          : retryDelayOf(retryPolicy, attempt);

                    // THE TIMEOUT LADDER'S DEADLINE. Checked BEFORE the frame is emitted
                    // and before the wait starts, so a ladder that has run out of wall
                    // clock neither promises a retry nor sleeps for it: the caller gets
                    // the last attempt's own error, exactly like an exhausted attempt
                    // budget. Only the timeout class is deadline-bounded — the connection
                    // ladder totals 750 ms of waiting, and the transient ladder is
                    // bounded by its own attempt count times the 60 s ceiling.
                    if (timeout && Date.now() + delayMs > timeoutDeadlineAt) throw error;

                    // Tell the consumer this attempt failed and what comes next. The
                    // event precedes the wait, so a UI can show the backoff while it
                    // happens; the message is the failed attempt's error, and every
                    // delta streamed since the previous boundary belongs to that
                    // failed attempt (consumers discard them).
                    // (T6, AC6) `provider` is the structured diagnostic the UI needs to
                    // say WHICH provider and port is blocking, and how long the next
                    // wait is. Absent for an unclassified failure, so every existing
                    // consumer sees the event shape it always saw. `maxAttempts` is the
                    // CLASS's total, so a connection retry honestly reports "1 of 3".
                    const provider = providerDiagnosticsOf(error);

                    // THE OPERATOR'S LINE FOR THIS ATTEMPT — the attempt number, the class
                    // total and the delay, which nothing else prints, plus the model id the
                    // event below cannot carry (see the "operator's retry line" section above
                    // for why this complements the transport's `provider attempt failed:` line
                    // instead of repeating it). The class is read from the SAME two sources the
                    // ladder above acted on — the frame's machine `code`, else the diagnostics'
                    // `errorClass` — so the line names exactly what the retry decision was made
                    // from, and prints `unclassified` honestly for a frame that named nothing.
                    providerRetryLog({
                        attempt,
                        maxAttempts: attemptsForClass,
                        delayMs,
                        // The request's own snapshot, the same value handed to the transport on
                        // every attempt: a mid-run `agent.model` change must not relabel the
                        // attempt that already failed.
                        model: requestModel,
                        failureClass: code ?? provider?.errorClass
                    });

                    yield {
                        type: 'retry',
                        attempt,
                        maxAttempts: attemptsForClass,
                        delayMs,
                        error: toErrorInfo(error),
                        ...(provider === undefined ? {} : { provider })
                    };

                    // Waits abort-immediately; the timer and listener are cleaned up
                    // inside `waitForRetry`.
                    await waitForRetry(delayMs, options?.signal);
                }
            }
        };

        const { outcome, attempt: committedAttempt } = yield* attemptWithRetries();

        // STRUCTURED GATE (issue 0001 B) — runs AFTER the retry loop and BEFORE the
        // commit, and that placement is the whole design:
        //
        //   - NOT a transport retry. The provider answered successfully; re-sending the
        //     identical request into the R1 sequence would burn a request (and an
        //     exponential backoff) on a failure shape that will almost certainly
        //     repeat. The host decides what to do — it is one `turn()` away, above the
        //     agent, and it may re-ask with different instructions. A schema failure is
        //     therefore exactly ONE transport call, whatever `retry` says.
        //   - BEFORE `precommit` and before `messages.push`, so an invalid answer leaves
        //     NO trace in history: `stream()` rolls its user message back like any other
        //     failure, and `turn()` commits nothing. A later request can never replay a
        //     turn the schema rejected.
        //   - The answer is streamed as text while it arrives, so a consumer sees the
        //     deltas of a rejected attempt (the same contract a failed attempt already
        //     has) and then the `error` event / throw that voids them.
        //
        // Two answers are NOT judged, and both exclusions are load-bearing:
        //   - `stopReason: 'tool_calls'` — the turn has no answer yet; the schema applies
        //     to the final message, and a tool round that fails later still fails here.
        //   - `stopReason: 'length'` — a truncated answer is a DIFFERENT problem than a
        //     malformed one (the generation was cut, the model never had the chance to
        //     close its JSON). Reporting it as a schema failure would send a host off to
        //     fix its schema when the fix is more output tokens, so the caller keeps the
        //     distinguishable `stopReason: 'length'` and simply gets no `structured`
        //     value on the message.
        let structuredValue: unknown;

        if (structured !== undefined && outcome.toolCalls.length === 0 && outcome.stopReason !== 'length') {
            structuredValue = structuredAnswerOf(
                configuration.name ?? 'agent',
                structured,
                outcome.content
            );
        }

        // Pre-commit guard (harness ownership/cancellation). This is the ONLY
        // synchronous mutation point of a turn, so a caller that lost ownership
        // while the transport was in flight can stop here without a partial
        // commit. A throw propagates exactly like a transport error; stream()
        // rolls its own user message back. It is deliberately OUTSIDE the retry
        // loop: lost ownership is not a model-call error and must never be
        // retried.
        options?.precommit?.();

        const message: HarnessAssistantMessage = {
            role: 'assistant',
            content: outcome.content,
            reasoning: outcome.reasoning,
            toolCalls: outcome.toolCalls,
            // The captured request model, not the live accessor: attribution must
            // describe the request that ran (see requestModel above).
            model: requestModel,
            stopReason: outcome.stopReason,
            usage: outcome.usage,
            // Written ONLY when a value passed the gate — never `structured:
            // undefined` — so every consumer that compares this message key-by-key
            // still sees exactly the shape it saw before issue 0001.
            ...(structuredValue !== undefined ? { structured: structuredValue } : {})
        };

        // Commit to history. reasoning is kept for replay/UI but never sent back
        // to the model, so it is not part of the wire payload.
        //
        // T1.2 — THE assistant commit, the third canonical creation point (with
        // `seed()` and src/harness.ts `insertToolMessage`). It is minted here, once, and
        // the id is NOT copied onto the `done` payload below: that payload is a result
        // value, not a transcript entry, and giving it an id would invite a second id
        // for one turn.
        messages.push(
            assignMessageId(
                {
                    role: 'assistant',
                    content: outcome.content,
                    ...(outcome.toolCalls.length > 0 ? { toolCalls: outcome.toolCalls } : {}),
                    ...(outcome.reasoning ? { reasoning: outcome.reasoning } : {})
                },
                messages
            )
        );

        // SUCCESS BOUNDARY (R3/F1). Everything this request streamed is now
        // committed, so it can never be discarded by a retry of a LATER request.
        //
        // Reported as the generator's RETURN value, not as an event: the harness
        // decides whether the boundary is visible (it forwards `attempt_commit` only
        // when its own `done` will not follow, i.e. a tool-calling round), and every
        // existing AgentStreamEvent sequence stays byte-identical.
        yield { type: 'done', message };

        return { attempt: committedAttempt, maxAttempts };
    };

    // Low-level: one turn against the current history. Throws on failure. The
    // `transcript` option is the harness's provider-safe projection; standalone
    // callers omit it and the committed history is used. `return yield*` forwards
    // `request`'s return value (the success boundary) to the caller.
    const turn = async function* (
        options?: AgentStreamOptions
    ): AsyncGenerator<AgentStreamEvent, AgentRequestCommit> {
        return yield* request(options);
    };

    // High-level: append a user message, then run one turn. Atomic on failure.
    // Returns the same success boundary as `turn` for a caller that needs it; the
    // `Agent.stream` TYPE stays a plain AsyncIterable, so nothing that consumes
    // events observes the change.
    const stream = async function* (
        input: string,
        options?: AgentStreamOptions
    ): AsyncGenerator<AgentStreamEvent, AgentRequestCommit | undefined> {
        // Validate before mutating: a malformed attachment yields an `error`
        // event (stream never throws) and leaves history exactly as it was.
        let attachments: HarnessAttachment[];
        try {
            attachments = validateAttachments(options?.attachments);
        } catch (error) {
            yield { type: 'error', error: toErrorInfo(error) };
            return;
        }

        const commitIndex = messages.length;
        // T1.2 — the standalone `agent.stream(input)` append, the same creation rule as
        // `appendUser` above (this factory is what a caller that never touches the
        // harness uses, and its transcript is addressable the same way).
        messages.push(
            assignMessageId(
                attachments.length > 0
                    ? { role: 'user', content: input, attachments }
                    : { role: 'user', content: input },
                messages
            )
        );

        try {
            return yield* request(options);
        } catch (error) {
            messages.splice(commitIndex);
            yield { type: 'error', error: toErrorInfo(error) };
            return undefined;
        }
    };

    // N3 branch creation. Everything is resolved BEFORE the clone so a bad
    // option (depth, label, byte cap) never produces a half-built branch.
    //
    // Depth: an ordinary fork consumes one level; an autoanswer fork does not
    // (it inherits the source depth) because it is a tool-free, single-iteration
    // owner read. Both still consume a runtime concurrency slot, which the
    // harness enforces.
    //
    // History: the materializer remaps every tool id and pairs pending calls
    // with an explicit non-success placeholder. The live `messages` array is
    // only READ here; the source transcript is never mutated.
    const forkFrom = (options: NormalizedForkAgentOptions): Agent => {
        const parent = agentBranchOf(self);
        const parentDepth = parent?.forkDepth ?? 0;
        const depth =
            options.kind === 'autoanswer'
                ? parentDepth
                : assertForkDepth(parentDepth + 1, options.maxDepth);

            const branchId = createBranchId();
        const materialized = materializeBranchHistory({
            messages,
            branchId,
            reason: options.reason,
            maxHistoryBytes: options.maxHistoryBytes,
            // M5 (2026-11-27) — the runtime names the call it is executing on every fork it starts
            // (`launchThreadFork` and the actionRequest autoanswer both pass `callId`), so the branch's
            // own creating call is seeded with the self-describing marker rather than the non-success
            // placeholder. For an autoanswer branch this id belongs to the REQUESTER's transcript, not to
            // the owner transcript materialized here, so it matches nothing and every pending call keeps
            // its placeholder — the runtime replaces this seed with `incorporateBranchHistory` anyway,
            // which names no self call at all. A plain `Agent.fork()` names no id and is unchanged.
            ...(options.callId !== undefined ? { selfCallId: options.callId } : {})
        });

        // The child shares the resolved transport (so provider credentials and
        // external side effects are shared, not sandboxed). Its instructions are
        // the source's snapshot, while its seed/baseline is the cloned transcript.
        // `prefix` is deliberately NOT forwarded beside those instructions: the
        // baseline already contains the source's preset history, so re-seeding it
        // would put those turns in front of the branch twice.
        // The retry policy is inherited too: a branch makes the same kind of model
        // calls, so it must not silently fall back to a different retry budget.
        const child = createAgent(
            {
                name: self.name,
                model,
                instruction: [...instructions],
                stream: transport,
                retry: retryPolicy,
                // (issue 0001 B) The same answer contract, for the same reason the
                // retry policy is inherited: the wire field already rides in the
                // SHARED transport, but the acceptance gate is per-agent
                // configuration, so a branch that silently dropped it would commit
                // answers its source would have refused.
                ...(structured === undefined ? {} : { structured }),
                // (issue 0004) The same context floor, re-spelled as `maxPromptTokens`
                // because a fork carries the shared TRANSPORT and no provider block: a
                // branch that silently dropped the window would send what its source
                // refuses to send.
                ...(contextWindow === undefined ? {} : { maxPromptTokens: contextWindow }),
                // R2: the branch is the SAME identity as its source (same name, same
                // instructions, same transport), so it carries the same swatch. A host
                // that colored the source must not see a colorless child.
                ...(self.color === undefined ? {} : { color: self.color })
            },
            materialized.messages
        );

        registerAgentBranch(child, {
            branchId,
            kind: options.kind,
            forkDepth: depth,
            model,
            // Keep the remap with the branch identity: the runtime needs it to
            // fill HarnessBranchRecord.toolCallIds without re-materializing.
            toolCallIds: materialized.toolCallIds,
            ...(options.label !== undefined ? { label: options.label } : {}),
            ...(options.sourceBranchId !== undefined
                ? { sourceBranchId: options.sourceBranchId }
                : {}),
            ...(options.sourceThreadId !== undefined
                ? { sourceThreadId: options.sourceThreadId }
                : {}),
            ...(options.callId !== undefined ? { callId: options.callId } : {}),
            ...(options.requestId !== undefined ? { requestId: options.requestId } : {})
        });

        return child;
    };

    self = {
        // A harness replaces this with its registry key; standalone callers use
        // the label for logging.
        name: configuration.name ?? 'agent',

        messages,
        instructions,

        // Identity color (R2), present only when configured — see the `Agent.color`
        // contract in ../types/index.ts. `self.color` is what the fork and thread
        // factories below re-read, so a harness that rewrote `name` (the registry key
        // rule, src/harness.ts) still hands the same swatch to every branch.
        ...(color === undefined ? {} : { color }),

        model: ((value?: string) => {
            if (value === undefined) return model;
            model = value;
            return self;
        }) as Agent['model'],

        system: (content: string) => append('system', content),
        user: (content: string, attachments?: HarnessAttachment[]) => appendUser(content, attachments),
        assistant: (content: string, toolCalls?: HarnessToolCall[]) => {
            // T1.2 — a host-committed assistant turn is canonical state like a committed
            // model turn, so it is minted the same way (see the commit in `request`).
            messages.push(
                assignMessageId(
                    {
                        role: 'assistant',
                        content,
                        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {})
                    },
                    messages
                )
            );
            return self;
        },

        stream,
        turn,
        // Public branch entry point: display label only. Runtime autoanswer goes
        // through `forkAgent` (core/branch), which supplies kind/request identity.
        fork: (options?: { label?: string }) =>
            forkFrom(normalizeForkAgentOptions(options)),
        reset: seed
    };

    // Let the runtime create an AUTOANSWER owner fork through the same closure.
    // The registry is a WeakMap, so this adds no field to the public Agent shape.
    registerAgentForker(self, (options) => forkFrom(options));

    // The prefix-band seam (U6). Same WeakMap discipline as the forker above: `writeAgentPrefix`
    // and `agentPrefixOf` (bottom of this module) reach these two closures by object identity, so
    // `Harness.setAgentPrefix` can rewrite the transcript band, the reset baseline, and the thread
    // seed from one guarded place without the public `Agent` type carrying mutable configuration.
    registerAgentPrefix(self, { write: writePrefix, read: readPrefix });

    // Persistent-thread factory (R2). A thread is an INDEPENDENT conversation of
    // the same brain: same instructions, seed messages, and resolved transport.
    // The model here is only the STARTING value: the runtime re-reads the OWNING
    // agent's current model at every run start and syncs the thread's Agent to it
    // (harness.ts, the `origin === 'host'` sync before a run), so
    // `agent.model('…')` reaches every live conversation of that agent on its next
    // run. A request already in flight keeps the model it started with, because
    // that run captured `requestModel` above.
    //
    // The transcript is seeded from instructions + `configuration.prefix` +
    // `configuration.messages` (the pre-call seed history), NOT from the live source
    // history: a new thread is a new conversation, while the source's own conversation
    // stays the default thread (`agent:<name>`, see core/thread.ts).
    registerAgentThreader(self, () => {
        // U6 — THE PREFIX A NEW THREAD SEEDS. `prefixOverride` (what the last
        // `setAgentPrefix` wrote) wins over `configuration.prefix`; falling back to the
        // configuration is what keeps an agent nobody ever edited seeding exactly what it
        // seeded before this seam existed, and the empty/absent test preserves the historical
        // "omit the key" spelling (`prefixSourceOf` would answer `[]` where the configuration
        // held no key at all, and `[]` and absent are the same seed but not the same object).
        // The array is copied so the thread's agent never shares the source brain's seed array.
        const threadPrefix = prefixOverride ?? configuration.prefix;

        return createAgent({
            // The harness rewrites `name` to the registry key after construction,
            // so the LIVE name (not the original configuration value, which may be
            // undefined) is what keeps events, invocation records, and the
            // `agentResult` lookup on the same identity.
            name: self.name,
            model,
            instruction: [...instructions],
            // Preset agentic history is forwarded beside `messages`, with the same
            // omit-the-key-when-unset discipline: a thread is a NEW conversation of
            // this brain, so it reseeds the memory the source was spawned with. A fork
            // needs no such forwarding — it starts from the materialized transcript,
            // which already carries these turns (see `forkFrom`).
            ...(threadPrefix === undefined || threadPrefix.length === 0
                ? {}
                : { prefix: [...threadPrefix] }),
            ...(configuration.messages === undefined ? {} : { messages: configuration.messages }),
            stream: transport,
            // A thread is another conversation of the SAME brain, so it inherits the
            // retry policy (R1) rather than reverting to the default budget.
            retry: retryPolicy,
            // (issue 0001 B) A thread answers like its owning agent: the schema is
            // already in the shared transport, and this carries the gate.
            ...(structured === undefined ? {} : { structured }),
            // (issue 0004) And the same context floor — a thread is another
            // conversation of the SAME brain, so it must not be the one path allowed
            // to send an oversized request. Re-spelled as `maxPromptTokens` because
            // the thread shares the resolved transport, not the provider block.
            ...(contextWindow === undefined ? {} : { maxPromptTokens: contextWindow }),
            // R2: and the same identity color, for the same reason — the UI paints one
            // swatch per agent, and a thread is that agent's conversation, not a new agent.
            ...(self.color === undefined ? {} : { color: self.color })
        });
    });

    return self;
};

// ---------------------------------------------------------------------------
// The prefix-band seam (U6)
// ---------------------------------------------------------------------------
//
// One WeakMap from a public `Agent` to the two closures that can read and rewrite its SEEDED
// PREFIX BAND, plus the two internal helpers the runtime calls. This is the same seam style as
// `registerAgentForker` (./branch.ts) and `registerAgentThreader` (./thread.ts): the capability
// lives with the brain that owns the transcript, and the public `Agent` type stays a read/append
// surface with no mutable configuration field.
//
// WHY THE READ IS HERE TOO. `Harness.setAgentPrefix` is a write, but the server's
// `GET …/agents/{agent_id}/prefix` needs the value the member ACTUALLY runs, and after a live
// prefix write the stored maps (harness definition, session override) and the transcript agree
// only if the read comes from the brain. Returning it from the same bookkeeping the writer uses
// is what makes a write and a read of the same band impossible to disagree with.
type AgentPrefixAccess = {
    // Replace the band (see `writePrefix` inside `createAgent` for the full contract).
    write: (turns: readonly HarnessPrefixTurn[]) => void;
    // The band's current text turns, in order, in the closed `HarnessPrefixTurn` shape.
    read: () => HarnessPrefixTurn[];
};

const agentPrefixAccesses = new WeakMap<Agent, AgentPrefixAccess>();

// Registers one brain's seam. Internal to this module: `createAgent` is the only caller, and a
// brain it did not build simply has no entry (both helpers below answer that honestly).
const registerAgentPrefix = (brain: Agent, access: AgentPrefixAccess): void => {
    agentPrefixAccesses.set(brain, access);
};

// THE WRITE BEHIND `Harness.setAgentPrefix` (../harness.ts). Throws when the brain was not built
// by `agent()` (a host-supplied stub carries no seed bookkeeping to rewrite) rather than
// half-applying the change.
export const writeAgentPrefix = (brain: Agent, turns: readonly HarnessPrefixTurn[]): void => {
    const access = agentPrefixAccesses.get(brain);

    if (access === undefined) {
        throw new HarnessError(
            `Agent "${brain.name}" was not built by \`agent()\`, so it has no seeded prefix band to rewrite.`
        );
    }

    access.write(turns);
};

// THE READ BEHIND THE SERVER'S PREFIX ROUTE (src/server/api.ts `getSessionAgentPrefix`).
// An agent with no seam entry and a fork both answer `[]`, which is the truth for both: neither
// carries a seeded prefix band. Never throws, so a read surface can call it for every roster
// member without probing which kind of brain it got.
export const agentPrefixOf = (brain: Agent): HarnessPrefixTurn[] => {
    const access = agentPrefixAccesses.get(brain);

    return access === undefined ? [] : access.read();
};

// Public factory. The optional baseline stays internal (see createAgent above),
// so the exported function keeps the historical one-argument contract.
export const agent = (configuration: AgentConfiguration): Agent => createAgent(configuration);
