// The browser client for the harness server.
//
// The UI has no harness code of its own. It creates a session, submits tasks, and
// renders the SSE stream the server sends back. Every endpoint lives under
// `/api`; in development Vite mounts the same handler, and in production the
// harness server serves both this bundle and the API.

import type {
    HarnessIndex,
    ModelIndex,
    RunnerSettings,
    SessionSnapshot,
    SessionStreamItem,
    ToolCallResult,
    ToolIndex
} from '../../server/protocol';

// Same-origin by default. `VITE_HARNESS_API` overrides the path prefix (for a
// reverse proxy that mounts the API somewhere other than `/api`); the server
// sends no CORS headers, so a cross-origin URL will not work.
const API_BASE = (import.meta.env.VITE_HARNESS_API ?? '/api').replace(/\/+$/, '');

const url = (path: string): string => `${API_BASE}${path}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (typeof body.error?.message === 'string') return body.error.message;
    } catch {
        // Not JSON, or the body was already consumed.
    }

    return `HTTP ${response.status} ${response.statusText}`.trim();
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let response: Response;

    try {
        response = await fetch(url(path), {
            ...init,
            headers: {
                'Content-Type': 'application/json',
                'X-Harness-Client': 'ui',
                ...(init?.headers ?? {})
            }
        });
    } catch (error) {
        // An aborted request is a deliberate cancellation (a superseded model
        // lookup), not an unreachable server; keep the original reason.
        if (init?.signal?.aborted) throw error;
        throw new Error(`The harness server is unreachable: ${messageOf(error)}`);
    }

    if (!response.ok) {
        throw new Error(await readError(response));
    }

    return (await response.json()) as T;
};

export const listHarnesses = (): Promise<HarnessIndex> => request<HarnessIndex>('/harnesses');

export const listTools = (): Promise<ToolIndex> => request<ToolIndex>('/tools');

// The provider catalogue, fetched by the harness server.
//
// Only the endpoint settings travel: the browser must never ask for the server
// key back, and it must not learn whether one is configured beyond what
// /api/harnesses already advertises. The key is posted (never appended to the
// URL) so a configured server key can still be used when the field is blank.
// `signal` lets the UI abandon a superseded request when the base URL changes.
export const listProviderModels = async (
    settings: Pick<RunnerSettings, 'baseURL' | 'apiKey'>,
    signal?: AbortSignal
): Promise<string[]> => {
    const body = await request<ModelIndex>('/models', {
        method: 'POST',
        body: JSON.stringify({ settings: { baseURL: settings.baseURL, apiKey: settings.apiKey } }),
        signal
    });

    return body.models;
};

export const createSession = async (harness: string, settings: RunnerSettings): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>('/sessions', {
        method: 'POST',
        body: JSON.stringify({ harness, settings })
    });

    return body.session;
};

export const getSession = async (id: string): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}`);
    return body.session;
};

export const resetSession = async (id: string): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}/reset`, {
        method: 'POST'
    });

    return body.session;
};

export const deleteSession = async (id: string): Promise<void> => {
    await request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

export const cancelSession = async (id: string): Promise<boolean> => {
    const body = await request<{ cancelled: boolean }>(`/sessions/${encodeURIComponent(id)}/cancel`, {
        method: 'POST'
    });

    return body.cancelled;
};

export const callTool = (name: string, parameters: unknown): Promise<ToolCallResult> =>
    request<ToolCallResult>(`/tools/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify({ parameters })
    });

// Read a `text/event-stream` body and hand every `data:` payload to the caller.
// The server sends one JSON `SessionStreamItem` per frame, so a frame never
// contains a literal newline.
export const submitMessage = async (
    id: string,
    input: string,
    onItem: (item: SessionStreamItem) => void,
    signal: AbortSignal
): Promise<SessionSnapshot> => {
    let response: Response;

    try {
        response = await fetch(url(`/sessions/${encodeURIComponent(id)}/messages`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ input }),
            signal
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`The harness server is unreachable: ${messageOf(error)}`);
    }

    if (!response.ok) {
        throw new Error(await readError(response));
    }

    if (response.body === null) {
        throw new Error('The harness server returned an empty stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let snapshot: SessionSnapshot | undefined;

    const handle = (block: string): void => {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

        if (data.length === 0) return;

        let item: SessionStreamItem;
        try {
            item = JSON.parse(data) as SessionStreamItem;
        } catch {
            return;
        }

        if (item.type === 'snapshot' || item.type === 'failed') snapshot = item.session;
        onItem(item);
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (block.trim().length > 0) handle(block);
        }
    }

    if (buffer.trim().length > 0) handle(buffer);

    if (snapshot === undefined) {
        throw new Error('The harness stream ended without a terminal frame.');
    }

    return snapshot;
};
