// Default transport: an OpenAI-compatible /chat/completions stream over fetch.
//
// This is the only piece of the package that knows about HTTP or the provider
// wire format. The harness never imports it directly — an agent resolves either
// an explicit `stream` or a `provider` block into one of these, so swapping the
// protocol is a one-line change at the call site.
//
// Why fetch and not an SDK:
//   - the package has no runtime dependencies and must stay that way to be
//     publishable on its own;
//   - every endpoint this workspace targets speaks the OpenAI chat completions
//     dialect, so the SDK buys nothing over ~150 lines of SSE handling;
//   - `fetch` is global from Node 18, and package.json already declares
//     engines.node >=18.
//
// Request shape follows the proven pattern in
// packages/underload/service/src/providers/fetch-client.ts: `{ model, stream,
// messages }` with an Authorization bearer token. `stream_options` is
// deliberately NOT sent — several gateways this workspace talks to reject
// unknown request fields. Usage is captured when a provider reports it anyway.
//
// Tool calls: the provider streams `tool_calls` as indexed fragments whose
// `function.arguments` arrive as partial JSON. They are accumulated here and
// reported once on the terminal frame, because partial arguments are not
// executable and the model has not stopped generating yet.
//
// Cross-references:
//   - ../types        — HarnessMessage, HarnessStreamEvent, HarnessToolCall
//   - ../core/agent   — the only caller of a HarnessStream
//   - ./index.ts      — the transport barrel

import { toErrorInfo } from '../util';
import type {
    HarnessMessage,
    HarnessProviderConfiguration,
    HarnessSampling,
    HarnessStopReason,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamTool,
    HarnessToolCall,
    HarnessUsage
} from '../types';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

// Map an internal transcript entry onto the provider payload. The internal shape
// is uniform (strings, explicit tool ids); the wire shape is not.
const wireMessage = (message: HarnessMessage): Record<string, unknown> => {
    switch (message.role) {
        case 'assistant': {
            const wire: Record<string, unknown> = {
                role: 'assistant',
                content: message.content
            };

            if (message.toolCalls && message.toolCalls.length > 0) {
                wire.tool_calls = message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments }
                }));
            }

            // `reasoning` is intentionally dropped: it is local replay data and
            // several providers reject unknown message fields.
            return wire;
        }

        case 'tool':
            return {
                role: 'tool',
                tool_call_id: message.toolCallId,
                content: message.content
            };

        default:
            return { role: message.role, content: message.content };
    }
};

// The tool declaration sent so the model knows what it can call.
const wireTool = (entry: HarnessStreamTool) => ({
    type: 'function',
    function: {
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters ?? { type: 'object', properties: {} }
    }
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

// Extract the payload from one SSE line. Returns undefined for anything that is
// not a data frame (blank lines, `event:`, `id:`, `:` comments), because
// production streams interleave them freely.
const dataPayload = (line: string): string | undefined => {
    // Lines are split on \n, so drop the \r of a CRLF pair.
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return undefined;
    return trimmed.slice(5).trim();
};

// Turn a response body into the sequence of `data:` payloads it carries.
// Stops when the provider sends the [DONE] sentinel.
async function* dataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Keep the trailing partial line for the next read.
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                const payload = dataPayload(line);
                if (payload === undefined) continue;
                if (payload === '[DONE]') return;
                yield payload;
            }
        }

        // Flush a final line that arrived without a trailing newline.
        const trailing = dataPayload(buffer);
        if (trailing !== undefined && trailing !== '[DONE]') yield trailing;
    } finally {
        // Consumers stop early on [DONE]; cancel so the socket is not held open.
        await reader.cancel().catch(() => {});
    }
}

// ---------------------------------------------------------------------------
// Chunk parsing
// ---------------------------------------------------------------------------

// Sampling fields may be absent entirely; build only the keys that exist so the
// request body stays minimal.
const samplingBody = (sampling: HarnessSampling | undefined): Record<string, number> => {
    if (!sampling) return {};

    const body: Record<string, number> = {};
    for (const [key, value] of Object.entries(sampling)) {
        if (typeof value === 'number') body[key] = value;
    }
    return body;
};

// Map the provider's finish_reason onto our stop reasons. `tool_calls` is
// distinct because it means the turn is not finished.
const stopReasonOf = (finishReason: unknown): HarnessStopReason => {
    if (finishReason === 'length') return 'length';
    if (finishReason === 'tool_calls') return 'tool_calls';
    return 'stop';
};

// Normalize the OpenAI usage block. `total_tokens` is not always present on
// gateways that do report the halves, so fall back to their sum.
const usageOf = (usage: unknown): HarnessUsage | undefined => {
    if (!usage || typeof usage !== 'object') return undefined;

    const raw = usage as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    const input = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0;
    const output = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0;
    const total = typeof raw.total_tokens === 'number' ? raw.total_tokens : input + output;

    return { input, output, total };
};

// One partially received tool call, keyed by its stream index.
type PendingToolCall = {
    id: string;
    name: string;
    arguments: string;
};

// Merge one `delta.tool_calls[]` fragment into the accumulator. The provider
// sends `id` and `function.name` once and `function.arguments` in pieces.
const mergeToolCallDelta = (pending: Map<number, PendingToolCall>, fragment: any): void => {
    if (!fragment || typeof fragment !== 'object') return;

    const index = typeof fragment.index === 'number' ? fragment.index : 0;
    const entry = pending.get(index) ?? { id: '', name: '', arguments: '' };

    if (typeof fragment.id === 'string' && fragment.id.length > 0) {
        entry.id = fragment.id;
    }

    const name = fragment.function?.name;
    if (typeof name === 'string' && name.length > 0) {
        entry.name += name;
    }

    const args = fragment.function?.arguments;
    if (typeof args === 'string') {
        entry.arguments += args;
    }

    pending.set(index, entry);
};

// Flush the accumulator in stream-index order, which is the order the model
// emitted the calls in.
const finishToolCalls = (pending: Map<number, PendingToolCall>): HarnessToolCall[] => {
    if (pending.size === 0) return [];

    return [...pending.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments }));
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export const openAICompatible = (configuration: HarnessProviderConfiguration): HarnessStream => {
    const { baseURL, apiKey, headers, sampling } = configuration;

    // Normalize the base URL once so callers may pass either form.
    const url = `${baseURL.replace(/\/+$/, '')}/chat/completions`;

    // Resolve the key per request: a getter may rotate credentials between turns.
    const resolveKey = (): string | undefined => (typeof apiKey === 'function' ? apiKey() : apiKey);

    return async function* stream(request): AsyncGenerator<HarnessStreamEvent> {
        const key = resolveKey();
        const toolList = (request.tools ?? []).map(wireTool);

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(key ? { authorization: `Bearer ${key}` } : {}),
                    ...headers
                },
                body: JSON.stringify({
                    model: request.model,
                    stream: true,
                    messages: request.messages.map(wireMessage),
                    ...(toolList.length > 0 ? { tools: toolList } : {}),
                    ...samplingBody(sampling)
                }),
                signal: request.signal
            });
        } catch (error) {
            // Abort and DNS/connection failures both land here.
            yield { type: 'error', message: `Request to ${url} failed: ${toErrorInfo(error).message}` };
            return;
        }

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            yield { type: 'error', message: `HTTP ${response.status}: ${detail || response.statusText}` };
            return;
        }

        if (!response.body) {
            yield { type: 'error', message: `HTTP ${response.status}: response body is empty` };
            return;
        }

        let finishReason: unknown = null;
        let usage: HarnessUsage | undefined;
        const pendingToolCalls = new Map<number, PendingToolCall>();

        for await (const frame of dataFrames(response.body)) {
            let chunk: any;
            try {
                chunk = JSON.parse(frame);
            } catch {
                // A malformed frame is a provider/proxy bug. Surfacing it beats
                // silently emitting half a response.
                yield { type: 'error', message: `Malformed stream frame: ${frame.slice(0, 200)}` };
                return;
            }

            // Gateways occasionally attach a provider error to an otherwise 200
            // stream instead of failing the request.
            if (chunk.error) {
                yield { type: 'error', message: chunk.error.message ?? 'Provider reported an error' };
                return;
            }

            const choice = chunk.choices?.[0];
            const delta = choice?.delta;

            // `reasoning_content` is the DeepSeek-compatible field; `reasoning`
            // is what several gateways normalize it to.
            const reasoning = delta?.reasoning_content ?? delta?.reasoning;
            if (typeof reasoning === 'string' && reasoning.length > 0) {
                yield { type: 'reasoning', delta: reasoning };
            }

            if (typeof delta?.content === 'string' && delta.content.length > 0) {
                yield { type: 'text', delta: delta.content };
            }

            if (Array.isArray(delta?.tool_calls)) {
                for (const fragment of delta.tool_calls) {
                    mergeToolCallDelta(pendingToolCalls, fragment);
                }
            }

            if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
            }

            // Some providers send usage on its own final chunk (choices: []).
            if (chunk.usage) {
                usage = usageOf(chunk.usage);
            }
        }

        const toolCalls = finishToolCalls(pendingToolCalls);

        // A provider that reports tool calls without a finish_reason still
        // requested tools; treat that as a tool turn rather than a stop.
        const stopReason = stopReasonOf(toolCalls.length > 0 && !finishReason ? 'tool_calls' : finishReason);

        yield { type: 'done', stopReason, toolCalls, usage };
    };
};
