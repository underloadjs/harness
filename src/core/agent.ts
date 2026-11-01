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
// doubling wait of `baseDelayMs * 2 ** (n - 1)` (default 1s, 2s, ... 512s).
// Success ends the sequence; when the final retry fails, the ORIGINAL error of
// that attempt is rethrown/yielded unchanged, so a caller keeps the real cause.
// Cancellation is never an error to retry: an aborted signal (in flight or
// during a backoff wait) ends the request immediately.
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

import { HarnessError, toErrorInfo } from '../util';
import { openAICompatible } from '../transport';
import { validateAttachments } from '../shared/attachments';
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
import type {
    Agent,
    AgentConfiguration,
    AgentRequestCommit,
    AgentStreamEvent,
    AgentStreamOptions,
    HarnessAssistantMessage,
    HarnessAttachment,
    HarnessMessage,
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

// Resolve the transport once, at construction. An explicit `stream` wins;
// otherwise the provider block is wrapped in the built-in transport. Failing
// here (rather than at the first prompt) means a misconfigured agent is caught
// where it was created.
const resolveStream = (configuration: AgentConfiguration): HarnessStream => {
    if (configuration.stream) {
        return configuration.stream;
    }

    if (!configuration.provider?.baseURL) {
        throw new HarnessError(
            `Agent "${configuration.name ?? 'agent'}" has no transport: provide either \`stream\` or \`provider.baseURL\`.`
        );
    }

    return openAICompatible(configuration.provider);
};

// Deep-copy one baseline message for a fork's reset seed. A fork must be able to
// reset repeatedly, so the baseline is cloned on EVERY seed rather than handed
// out as a shared array. Attachments are re-validated by the shared gate (which
// also returns detached copies); tool calls are copied one by one.
const copyBaselineMessage = (message: HarnessMessage): HarnessMessage => {
    switch (message.role) {
        case 'user':
            return message.attachments !== undefined
                ? {
                      role: 'user',
                      content: message.content,
                      attachments: validateAttachments(message.attachments)
                  }
                : { role: 'user', content: message.content };

        case 'assistant':
            return {
                role: 'assistant',
                content: message.content,
                ...(message.toolCalls !== undefined
                    ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
                    : {}),
                ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {})
            };

        default:
            return { ...message };
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

// The wait before retry `attempt` (1-based): 1000, 2000, 4000 ... by default.
const retryDelayOf = (policy: RetryPolicy, attempt: number): number =>
    policy.baseDelayMs * 2 ** (attempt - 1);

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

    const transport = resolveStream(configuration);
    const instructions = normalizeInstructions(configuration.instruction);

    // The model is mutable: a caller can switch models mid-conversation without
    // rebuilding the agent (and losing its history). A change applies to the NEXT
    // request: a request already streaming keeps the model it started with, and
    // the assistant message it commits names that model (requestModel below).
    let model = configuration.model;

    // History starts as instructions + seed messages. Every mutation below goes
    // through this one array, so plugins and callers observe a single source of
    // truth.
    const messages: HarnessMessage[] = [];

    const seed = (): void => {
        // Build the fully validated next transcript FIRST and replace the live
        // array only once every seed message passed. reset() calls this on an
        // already-committed conversation, so a bad seeded attachment (the caller
        // may have mutated `configuration.messages` after construction) must
        // throw WITHOUT erasing the transcript the session is using.
        const next: HarnessMessage[] = [];

        // FORK BASELINE: a branch starts from its cloned source transcript, not
        // from instructions + configuration.messages (the source's history
        // already contains those). Reset re-clones it, so a branch never shares
        // mutable state with its source or with a previous reset.
        if (baseline !== undefined) {
            for (const message of baseline) {
                next.push(copyBaselineMessage(message));
            }

            messages.length = 0;
            for (const message of next) messages.push(message);
            return;
        }

        for (const instruction of instructions) {
            next.push({ role: 'system', content: instruction });
        }

        for (const message of configuration.messages ?? []) {
            // Seeded user messages may carry attachments too. Validate and copy
            // them now, so a bad seed fails construction instead of reaching a
            // transport (and so the configuration's array is never aliased by
            // live history). Text-only seeds keep their exact old shape.
            if (message.role === 'user' && message.attachments !== undefined) {
                next.push({
                    ...message,
                    attachments: validateAttachments(message.attachments)
                });
                continue;
            }

            next.push({ ...message });
        }

        // Commit point: everything above succeeded.
        messages.length = 0;
        for (const message of next) messages.push(message);
    };

    seed();

    // The retry policy for this agent, resolved once (see resolveRetryPolicy).
    const retryPolicy = resolveRetryPolicy(configuration.retry);
    // Total attempts = the initial one plus its retries. `maxAttempts` is what the
    // `retry` event reports so a consumer can render "2 of 11" without guessing.
    const maxAttempts = retryPolicy.maxRetries + 1;

    // Assigned below; the appending helpers close over it so they can chain.
    let self: Agent;

    const append = (role: 'system' | 'user' | 'assistant', content: string): Agent => {
        messages.push({ role, content });
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

        messages.push(
            validated.length > 0
                ? { role: 'user', content, attachments: validated }
                : { role: 'user', content }
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
        // that governs the message list itself).
        const transcript = source.map((message) =>
            message.role === 'user' && message.attachments !== undefined
                ? {
                      ...message,
                      attachments: message.attachments.map((attachment) => ({ ...attachment }))
                  }
                : { ...message }
        );

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
                            failure = new HarnessError(event.message);
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

                        case 'error':
                            // Error frames are terminal FOR THIS ATTEMPT: they surface
                            // as a thrown error so the retry loop above can decide
                            // whether to re-send the request. The frame's message is
                            // the original, useful error text and is preserved
                            // verbatim.
                            throw new HarnessError(event.message);

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
        const attemptWithRetries = async function* (): AsyncGenerator<
            AgentStreamEvent,
            { outcome: AttemptOutcome; attempt: number }
        > {
            for (let attempt = 1; ; attempt++) {
                // ABORT BOUNDARY (R2): never start another attempt for a cancelled
                // request, and never wait out a backoff for one.
                throwIfAborted(options?.signal);

                try {
                    return { outcome: yield* attemptRequest(), attempt };
                } catch (error) {
                    // Cancellation is not an error to retry: the run stopped.
                    if (isAbortError(error, options?.signal)) throw error;

                    // Out of retries: the last attempt's own error is the answer.
                    if (attempt >= maxAttempts) throw error;

                    const delayMs = retryDelayOf(retryPolicy, attempt);

                    // Tell the consumer this attempt failed and what comes next. The
                    // event precedes the wait, so a UI can show the backoff while it
                    // happens; the message is the failed attempt's error, and every
                    // delta streamed since the previous boundary belongs to that
                    // failed attempt (consumers discard them).
                    yield {
                        type: 'retry',
                        attempt,
                        maxAttempts,
                        delayMs,
                        error: toErrorInfo(error)
                    };

                    // Waits abort-immediately; the timer and listener are cleaned up
                    // inside `waitForRetry`.
                    await waitForRetry(delayMs, options?.signal);
                }
            }
        };

        const { outcome, attempt: committedAttempt } = yield* attemptWithRetries();

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
            usage: outcome.usage
        };

        // Commit to history. reasoning is kept for replay/UI but never sent back
        // to the model, so it is not part of the wire payload.
        messages.push({
            role: 'assistant',
            content: outcome.content,
            ...(outcome.toolCalls.length > 0 ? { toolCalls: outcome.toolCalls } : {}),
            ...(outcome.reasoning ? { reasoning: outcome.reasoning } : {})
        });

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
        messages.push(
            attachments.length > 0
                ? { role: 'user', content: input, attachments }
                : { role: 'user', content: input }
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
            maxHistoryBytes: options.maxHistoryBytes
        });

        // The child shares the resolved transport (so provider credentials and
        // external side effects are shared, not sandboxed). Its instructions are
        // the source's snapshot, while its seed/baseline is the cloned transcript.
        // The retry policy is inherited too: a branch makes the same kind of model
        // calls, so it must not silently fall back to a different retry budget.
        const child = createAgent(
            {
                name: self.name,
                model,
                instruction: [...instructions],
                stream: transport,
                retry: retryPolicy
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

        model: ((value?: string) => {
            if (value === undefined) return model;
            model = value;
            return self;
        }) as Agent['model'],

        system: (content: string) => append('system', content),
        user: (content: string, attachments?: HarnessAttachment[]) => appendUser(content, attachments),
        assistant: (content: string, toolCalls?: HarnessToolCall[]) => {
            messages.push({
                role: 'assistant',
                content,
                ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {})
            });
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

    // Persistent-thread factory (R2). A thread is an INDEPENDENT conversation of
    // the same brain: same instructions, seed messages, and resolved transport.
    // The model here is only the STARTING value: the runtime re-reads the OWNING
    // agent's current model at every run start and syncs the thread's Agent to it
    // (harness.ts, the `origin === 'host'` sync before a run), so
    // `agent.model('…')` reaches every live conversation of that agent on its next
    // run. A request already in flight keeps the model it started with, because
    // that run captured `requestModel` above.
    //
    // The transcript is seeded from instructions + `configuration.messages` (the
    // pre-call seed history), NOT from the live source history: a new thread is a
    // new conversation, while the source's own conversation stays the default
    // thread (`agent:<name>`, see core/thread.ts).
    registerAgentThreader(self, () =>
        createAgent({
            // The harness rewrites `name` to the registry key after construction,
            // so the LIVE name (not the original configuration value, which may be
            // undefined) is what keeps events, invocation records, and the
            // `agentResult` lookup on the same identity.
            name: self.name,
            model,
            instruction: [...instructions],
            ...(configuration.messages === undefined ? {} : { messages: configuration.messages }),
            stream: transport,
            // A thread is another conversation of the SAME brain, so it inherits the
            // retry policy (R1) rather than reverting to the default budget.
            retry: retryPolicy
        })
    );

    return self;
};

// Public factory. The optional baseline stays internal (see createAgent above),
// so the exported function keeps the historical one-argument contract.
export const agent = (configuration: AgentConfiguration): Agent => createAgent(configuration);
