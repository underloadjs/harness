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

// What the UI needs to draw a preset card without importing the catalogue.
export type HarnessDescriptor = {
    name: string;
    title: string;
    description: string;
    requiresEndpoint: boolean;
    agents: string[];
    tools: string[];
};

// What the UI needs to draw a direct-call tool without importing the tool object.
export type ToolDescriptor = {
    name: string;
    group: string;
    description: string;
    tags: string[];
    visibility: 'core' | 'searchable';
    parameters: Record<string, unknown>;
};

// A conversation held by the server. `messages` is the entry agent's transcript.
export type SessionSnapshot = {
    id: string;
    harness: string;
    status: SessionStatus;
    model: string;
    createdAt: number;
    updatedAt: number;
    messages: HarnessMessage[];
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
export type SessionStreamItem =
    | { type: 'event'; event: HarnessEvent }
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
