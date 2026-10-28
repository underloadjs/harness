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
// Cross-references:
//   - ../types.ts     — Agent, AgentConfiguration, AgentStreamEvent
//   - ../transport.ts — openAICompatible(), the default HarnessStream
//   - ../harness.ts   — the loop that drives turn() repeatedly

import { HarnessError, toErrorInfo } from '../util';
import { openAICompatible } from '../transport';
import type {
    Agent,
    AgentConfiguration,
    AgentStreamEvent,
    AgentStreamOptions,
    HarnessAssistantMessage,
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const agent = (configuration: AgentConfiguration): Agent => {
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
        messages.length = 0;
        for (const instruction of instructions) {
            messages.push({ role: 'system', content: instruction });
        }
        for (const message of configuration.messages ?? []) {
            messages.push({ ...message });
        }
    };

    seed();

    // Assigned below; the appending helpers close over it so they can chain.
    let self: Agent;

    const append = (role: 'system' | 'user' | 'assistant', content: string): Agent => {
        messages.push({ role, content });
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
        const transcript = messages.map((message) => ({ ...message }));

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

    // Low-level: one turn against the current history. Throws on failure.
    const turn = async function* (options?: AgentStreamOptions): AsyncGenerator<AgentStreamEvent> {
        yield* request(options);
    };

    // High-level: append a user message, then run one turn. Atomic on failure.
    const stream = async function* (
        input: string,
        options?: AgentStreamOptions
    ): AsyncGenerator<AgentStreamEvent> {
        const commitIndex = messages.length;
        messages.push({ role: 'user', content: input });

        try {
            yield* request(options);
        } catch (error) {
            messages.splice(commitIndex);
            yield { type: 'error', error: toErrorInfo(error) };
        }
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
        user: (content: string) => append('user', content),
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
        reset: seed
    };

    return self;
};
