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
import { validateAttachments } from '../shared/attachments';
import type {
    HarnessAttachment,
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

// `data:` URL for a binary attachment (images and the OpenRouter video part).
const dataUrlOf = (attachment: HarnessAttachment): string =>
    `data:${attachment.mime};base64,${attachment.data}`;

// OpenAI's input_audio format is an enum of two: wav and mp3. The MIME already
// passed validation, so this is only a name normalization.
const audioFormatOf = (mime: string): 'wav' | 'mp3' =>
    mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave' ? 'wav' : 'mp3';

// Map ONE attachment onto the provider part documented for its kind:
//   image -> image_url (data URL)   [OpenAI image inputs]
//   pdf   -> file (file_data data URL) [OpenAI file inputs]
//   audio -> input_audio (raw base64 + wav|mp3) [OpenAI audio inputs]
//   video -> video_url (data URL)   [OpenRouter multimodal videos ONLY]
// Anything else is an explicit unsupported error, never a stringified binary.
//
// Sources (authoritative for these shapes):
//   https://developers.openai.com/api/docs/guides/file-inputs?api-mode=chat
//   https://openrouter.ai/docs/guides/overview/multimodal/videos
const attachmentPart = (attachment: HarnessAttachment, allowVideo: boolean): Record<string, unknown> => {
    switch (attachment.kind) {
        case 'image':
            return { type: 'image_url', image_url: { url: dataUrlOf(attachment) } };

        case 'pdf':
            return {
                type: 'file',
                file: { filename: attachment.name, file_data: dataUrlOf(attachment) }
            };

        case 'audio':
            return {
                type: 'input_audio',
                input_audio: { data: attachment.data, format: audioFormatOf(attachment.mime) }
            };

        case 'video':
            // Video is an OpenRouter extension, not an OpenAI chat field. The
            // decision is made on the ACTUAL request hostname, so a custom
            // gateway that proxies OpenAI is never sent an unsupported part.
            if (!allowVideo) {
                throw new Error(
                    `Attachments of kind "video" are only supported by OpenRouter (request host openrouter.ai).`
                );
            }

            return { type: 'video_url', video_url: { url: dataUrlOf(attachment) } };

        default:
            // `kind: 'file'` (and any future unknown kind). Representable, but
            // the chat-completions transport has no documented part for it.
            throw new Error(
                `Attachments of kind "file" (${attachment.mime}) are not supported by this transport; send the content as text instead.`
            );
    }
};

// Build the user message content. A text-only message keeps the historical
// `{ role, content: string }` shape EXACTLY.
//
// With attachments, the prompt is split around each attachment's marker:
//   text before marker | marker label | media part | ... | trailing text
// Markers keep their literal text so the model sees the label the user typed.
// Attachments whose marker never appears are appended at the end (label+part).
// A marker that appears twice is ambiguous and is rejected.
const wireUserMessage = (
    message: Extract<HarnessMessage, { role: 'user' }>,
    allowVideo: boolean
): Record<string, unknown> => {
    if (message.attachments === undefined || message.attachments.length === 0) {
        return { role: 'user', content: message.content };
    }

    // Re-validate at the wire boundary: a transport can be called directly, and
    // a hand-built HarnessMessage may not have gone through the agent/harness.
    const attachments = validateAttachments(message.attachments);
    const positions: Array<{ attachment: HarnessAttachment; index: number }> = [];

    for (const attachment of attachments) {
        const first = message.content.indexOf(attachment.marker);

        if (first < 0) continue;

        if (message.content.indexOf(attachment.marker, first + attachment.marker.length) >= 0) {
            throw new Error(`The marker "${attachment.marker}" appears more than once in the user prompt.`);
        }

        positions.push({ attachment, index: first });
    }

    positions.sort((left, right) => left.index - right.index);

    const parts: Array<Record<string, unknown>> = [];
    const placed = new Set<string>();
    let cursor = 0;

    for (const { attachment, index } of positions) {
        const before = message.content.slice(cursor, index);
        if (before.length > 0) parts.push({ type: 'text', text: before });

        // The label stays immediately before the media part.
        parts.push({ type: 'text', text: attachment.marker });
        parts.push(attachmentPart(attachment, allowVideo));

        placed.add(attachment.id);
        cursor = index + attachment.marker.length;
    }

    const trailing = message.content.slice(cursor);
    if (trailing.length > 0) parts.push({ type: 'text', text: trailing });

    // Attachments the prompt never referenced still travel: append them at the
    // end, each with its own label, in attachment order.
    for (const attachment of attachments) {
        if (placed.has(attachment.id)) continue;
        parts.push({ type: 'text', text: attachment.marker });
        parts.push(attachmentPart(attachment, allowVideo));
    }

    return { role: 'user', content: parts };
};

// Whether this request is going to OpenRouter itself, which is the only host
// that accepts the `video_url` part.
const allowsVideoFor = (url: string): boolean => {
    try {
        return new URL(url).hostname === 'openrouter.ai';
    } catch {
        // A malformed base URL fails at fetch anyway; do not enable an extension
        // for it.
        return false;
    }
};

// Map an internal transcript entry onto the provider payload. The internal shape
// is uniform (strings, explicit tool ids); the wire shape is not.
const wireMessage = (message: HarnessMessage, allowVideo: boolean): Record<string, unknown> => {
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

        case 'system':
            return { role: 'system', content: message.content };

        default:
            // Remaining branch is 'user'. A text-only user message keeps the
            // plain string content; attachments become multimodal parts.
            return wireUserMessage(message, allowVideo);
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
//
// Cached input: providers publish the replayed prefix under different keys, and
// all of them describe the SAME request shape (A+B sent, C new → cached = A+B).
//   - `prompt_tokens_details.cached_tokens` — OpenAI-compatible standard, and the
//     exact shape this workspace's Lightning adapter emits
//     (packages/agentic/provider/src/lightning/lightning-client.ts:276).
//   - `prompt_cache_hit_tokens` — DeepSeek-compatible gateways.
// A provider that publishes neither yields `cached: undefined`, never 0: unknown
// is not the same fact as "nothing was cached".
const cachedOf = (raw: Record<string, unknown>): number | undefined => {
    const details = raw.prompt_tokens_details;

    if (details !== null && typeof details === 'object') {
        const cached = (details as { cached_tokens?: unknown }).cached_tokens;
        if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) return cached;
    }

    const hit = raw.prompt_cache_hit_tokens;
    if (typeof hit === 'number' && Number.isFinite(hit) && hit >= 0) return hit;

    return undefined;
};

const usageOf = (usage: unknown): HarnessUsage | undefined => {
    if (!usage || typeof usage !== 'object') return undefined;

    const raw = usage as {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
        prompt_tokens_details?: unknown;
        prompt_cache_hit_tokens?: unknown;
    };
    const input = typeof raw.prompt_tokens === 'number' ? raw.prompt_tokens : 0;
    const output = typeof raw.completion_tokens === 'number' ? raw.completion_tokens : 0;
    const total = typeof raw.total_tokens === 'number' ? raw.total_tokens : input + output;

    // The cached part is a subset of the input, so a gateway reporting more
    // cached than prompt tokens is contradicting its own block. Clamping keeps a
    // display honest ("never more cached than sent") instead of rendering
    // `(200)` beside an input of 100.
    const cached = cachedOf(raw as Record<string, unknown>);

    return {
        input,
        output,
        total,
        ...(cached === undefined ? {} : { cached: Math.min(cached, input) })
    };
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
        const allowVideo = allowsVideoFor(url);

        // Build the wire transcript BEFORE fetch: an unsupported attachment
        // (video off OpenRouter, any `file` kind, malformed stored bytes) must
        // fail honestly without sending the request or stringifying binary into
        // text. Mapping errors surface as an error frame.
        let messages: Array<Record<string, unknown>>;
        try {
            messages = request.messages.map((message) => wireMessage(message, allowVideo));
        } catch (error) {
            yield { type: 'error', message: toErrorInfo(error).message };
            return;
        }

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
                    messages,
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
