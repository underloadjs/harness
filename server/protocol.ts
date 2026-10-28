// The wire contract between the harness server and its clients.
//
// This file is imported by the browser UI **type-only**, so nothing here may have
// a runtime dependency that a browser cannot load. The server and CLI import the
// values they need from their own modules.

import type { HarnessErrorInfo, HarnessEvent, HarnessMessage } from '../src/harness';
import type { RunnerSettings } from '../harnesses/types';

export type {
    HarnessAssistantMessage,
    HarnessErrorInfo,
    HarnessEvent,
    HarnessMessage,
    HarnessStopReason,
    HarnessToolCall,
    HarnessUsage
} from '../src/harness';
export type { RunnerSettings } from '../harnesses/types';

export type SessionStatus = 'idle' | 'running' | 'error';

// One task submitted to a session, as the server recorded it.
//
// The server owns this record: the UI never infers a turn from streamed events,
// because a browser reload loses the stream but must still render the same
// transcript. `index` is the position in the session (0-based, monotonic) and
// `events` holds every `HarnessEvent` observed while the turn ran — including
// events from subagents a delegation reached — in emission order.
//
// `startedAt`/`updatedAt` are epoch milliseconds from the server clock.
// `startedAt` never changes once the turn opens; `updatedAt` moves on every
// recorded event and again when the turn reaches a terminal status.
export type SessionTurnStatus = 'running' | 'done' | 'error' | 'cancelled';

export type SessionTurn = {
    id: string;
    index: number;
    // The trimmed task text the harness received, not the raw request body.
    prompt: string;
    status: SessionTurnStatus;
    startedAt: number;
    updatedAt: number;
    events: HarnessEvent[];
};

// What the UI needs to draw a preset card without importing the catalogue.
export type HarnessDescriptor = {
    name: string;
    title: string;
    description: string;
    requiresEndpoint: boolean;
    agents: string[];
    tools: string[];
    // The harness-owned core tools this card's runs will declare: getTools,
    // createTool, and todoTools for every harness, plus delegate when the preset
    // declares subagents. Optional so a client can still render an older server's
    // descriptor; when present the UI has no hardcoded core-tool label.
    coreTools?: string[];
};

// Whether the server can actually run a listed tool. Omitted means "available":
// the field was added for credential-dependent tools (websearch), so leaving it
// off keeps every existing entry byte-identical.
//
// `environment` names variables only — never values — and `hint` is a non-secret
// sentence the UI can print verbatim.
export type ToolAvailability = {
    state: 'available' | 'unconfigured';
    environment?: string[];
    hint?: string;
};

// What the UI needs to draw a direct-call tool without importing the tool object.
export type ToolDescriptor = {
    name: string;
    group: string;
    description: string;
    tags: string[];
    visibility: 'core' | 'searchable';
    parameters: Record<string, unknown>;
    availability?: ToolAvailability;
};

// A conversation held by the server. `messages` is the entry agent's transcript.
//
// `turns` is the authoritative renderable record and is always present (an empty
// array for a new or reset session). It is the only source a client needs to draw
// the transcript after a reload: list() and get() both carry it, including a turn
// that is still running.
export type SessionSnapshot = {
    id: string;
    harness: string;
    status: SessionStatus;
    model: string;
    createdAt: number;
    updatedAt: number;
    messages: HarnessMessage[];
    turns: SessionTurn[];
    lastError?: string;
};

// Payload of GET /api/harnesses. Provider defaults come from the server
// environment; the API key itself is never sent, only whether one exists.
export type HarnessIndex = {
    harnesses: HarnessDescriptor[];
    defaults: {
        baseURL: string;
        model: string;
        hasApiKey: boolean;
    };
};

// Payload of GET /api/tools.
export type ToolIndex = {
    tools: ToolDescriptor[];
};

// Payload of POST /api/models.
//
// The browser cannot call a provider directly: it does not hold the server key
// (and must not be handed it), and the harness server sends no CORS headers. So
// the client sends the endpoint settings it would use for a session and the
// server performs GET {baseURL}/models itself. The response carries ids only —
// never the key, and the key travels in the POST body (or a header on the
// outbound request), never in a query string.
export type ModelListRequest = {
    settings?: Partial<RunnerSettings>;
};

// Payload of a successful POST /api/models. `models` is the provider's `id`
// values in provider order, deduplicated; an empty array is a valid answer.
export type ModelIndex = {
    models: string[];
};

// One item in the POST /api/sessions/:id/messages SSE stream.
//
// Ordering contract:
//   - `turn` opens every run, before the first harness event, so the client can
//     create the turn row before appending anything to it;
//   - every `event` names the turn it belongs to, so a client that connected late
//     (or inferred nothing) still attributes deltas correctly;
//   - `snapshot` is the normal terminal frame; `failed` is the error terminal.
//     Both carry the complete turn list, so the final frame is self-sufficient.
export type SessionStreamItem =
    | { type: 'turn'; turn: SessionTurn }
    | { type: 'event'; turnId: string; event: HarnessEvent }
    | { type: 'snapshot'; session: SessionSnapshot }
    | { type: 'failed'; error: HarnessErrorInfo; session: SessionSnapshot };

export type CreateSessionRequest = {
    harness: string;
    settings?: Partial<RunnerSettings>;
};

export type SubmitMessageRequest = {
    input: string;
};

export type ToolCallRequest = {
    parameters?: unknown;
};

export type ToolCallResult =
    | { ok: true; result: unknown; durationMs: number }
    | { ok: false; error: HarnessErrorInfo; durationMs: number };

export type ApiErrorBody = {
    error: {
        message: string;
    };
};
