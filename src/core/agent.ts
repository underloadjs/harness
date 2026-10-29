// agent() — the brain.
//
// Responsibilities are deliberately narrow. An agent owns:
//   1. the model name,
//   2. the seeded system instruction(s),
//   3. the message history,
//   4. exactly one transport call per turn().
//
// It owns no policy: no tool execution, no retries beyond the transport's, no
// compaction, no planning. That line is what keeps a brain reusable. The same
// agent can be driven by a writer harness, a research harness, or a test.
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
import type {
    Agent,
    AgentConfiguration,
    AgentStreamEvent,
    AgentStreamOptions,
    HarnessAssistantMessage,
    HarnessAttachment,
    HarnessMessage,
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
    const request = async function* (options: AgentStreamOptions | undefined): AsyncGenerator<AgentStreamEvent> {
        let content = '';
        let reasoning = '';
        let stopReason: HarnessStopReason = 'stop';
        let toolCalls: HarnessToolCall[] = [];
        let usage: HarnessAssistantMessage['usage'];

        // Capture the model for THIS request. The accessor is mutable (a session
        // can retarget an agent mid-conversation, see server/sessions.ts
        // setAgentModels), so reading it again at the end would let a change that
        // arrives while the transport is streaming relabel a message the OLD model
        // actually produced. One snapshot keeps the request, the transport payload,
        // and the committed attribution identical.
        const requestModel = model;

        // Copy the transcript: a transport must never see a live array it could
        // mutate, and later appends must not appear mid-request.
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

        for await (const event of transport({
            model: requestModel,
            messages: transcript,
            tools: options?.tools,
            signal: options?.signal
        })) {
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
                    // Error frames are terminal: abort the turn.
                    throw new HarnessError(event.message);

                case 'done':
                    stopReason = event.stopReason;
                    toolCalls = event.toolCalls;
                    usage = event.usage;
                    break;
            }
        }

        // Pre-commit guard (harness ownership/cancellation). This is the ONLY
        // synchronous mutation point of a turn, so a caller that lost ownership
        // while the transport was in flight can stop here without a partial
        // commit. A throw propagates exactly like a transport error; stream()
        // rolls its own user message back.
        options?.precommit?.();

        const message: HarnessAssistantMessage = {
            role: 'assistant',
            content,
            reasoning,
            toolCalls,
            // The captured request model, not the live accessor: attribution must
            // describe the request that ran (see requestModel above).
            model: requestModel,
            stopReason,
            usage
        };

        // Commit to history. reasoning is kept for replay/UI but never sent back
        // to the model, so it is not part of the wire payload.
        messages.push({
            role: 'assistant',
            content,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            ...(reasoning ? { reasoning } : {})
        });

        yield { type: 'done', message };
    };

    // Low-level: one turn against the current history. Throws on failure. The
    // `transcript` option is the harness's provider-safe projection; standalone
    // callers omit it and the committed history is used.
    const turn = async function* (options?: AgentStreamOptions): AsyncGenerator<AgentStreamEvent> {
        yield* request(options);
    };

    // High-level: append a user message, then run one turn. Atomic on failure.
    const stream = async function* (
        input: string,
        options?: AgentStreamOptions
    ): AsyncGenerator<AgentStreamEvent> {
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
            yield* request(options);
        } catch (error) {
            messages.splice(commitIndex);
            yield { type: 'error', error: toErrorInfo(error) };
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
        const child = createAgent(
            {
                name: self.name,
                model,
                instruction: [...instructions],
                stream: transport
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

    return self;
};

// Public factory. The optional baseline stays internal (see createAgent above),
// so the exported function keeps the historical one-argument contract.
export const agent = (configuration: AgentConfiguration): Agent => createAgent(configuration);
