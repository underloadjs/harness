// Credential containment: the server key must not follow a client-chosen base URL.
//
// Both HTTP paths that merge client settings — POST /api/models and POST
// /api/sessions — go through `mergeSettings` (server/config.ts). These tests drive
// the real standalone server against two loopback stub providers so the assertion
// is on the WIRE (the `authorization` header the provider actually received), not
// on an internal settings object.
//
// Matrix pinned here:
//   - omitted/blank key + configured provider (trailing slash variant) → server key;
//   - omitted/blank key + same origin but different base path        → no key;
//   - omitted/blank key + foreign provider (models and sessions)     → no key;
//   - explicit client key + foreign provider                         → client key;
//   - server configured with no key                                  → no key anywhere.
//
// No external network: providers are node:http servers on 127.0.0.1:0, and the
// `writer` preset identifier is used on purpose: it is a legacy alias that now
// resolves to `instruct`, so this also proves an old client name still creates a
// canonical session.

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarnessServer } from './index';
import type { HarnessServer } from './index';
import type { ModelIndex, SessionSnapshot } from './protocol';

const SERVER_KEY = 'server-secret';
const MODEL = 'credential-test-model';
const CLIENT_HEADER = { 'X-Harness-Client': 'ui' };

type ProviderRequest = {
    method: string;
    url: string;
    authorization: string | undefined;
};

type Provider = {
    // `http://127.0.0.1:<port>` — tests append `/v1` (the base path).
    origin: string;
    requests: ProviderRequest[];
    close: () => Promise<void>;
};

// A stub provider that records exactly what it received. `/models` answers a
// one-model catalogue; anything else (the chat transport) answers 500, which is
// enough: the request header is recorded before the failure, and the harness
// turns the failure into a `failed` frame.
const startProvider = async (): Promise<Provider> => {
    const requests: ProviderRequest[] = [];

    const server = http.createServer((request, response) => {
        requests.push({
            method: request.method ?? '',
            url: request.url ?? '',
            authorization: request.headers.authorization
        });

        response.setHeader('Content-Type', 'application/json');

        if ((request.url ?? '').endsWith('/models')) {
            response.statusCode = 200;
            response.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model' }] }));
            return;
        }

        response.statusCode = 500;
        response.end(JSON.stringify({ error: 'provider unavailable' }));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return {
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };
};

let authoritative: Provider;
let foreign: Provider;
let server: HarnessServer;
let base: string;

beforeAll(async () => {
    authoritative = await startProvider();
    foreign = await startProvider();

    server = await startHarnessServer({
        port: 0,
        staticRoot: null,
        // The configured provider owns the server key.
        settings: { baseURL: `${authoritative.origin}/v1`, apiKey: SERVER_KEY, model: MODEL },
        defaults: { baseURL: `${authoritative.origin}/v1`, model: MODEL, hasApiKey: true }
    });
    base = server.url;
});

afterAll(async () => {
    await server.close();
    await authoritative.close();
    await foreign.close();
});

beforeEach(() => {
    authoritative.requests.length = 0;
    foreign.requests.length = 0;
});

const post = (pathname: string, body: unknown): Promise<Response> =>
    fetch(`${base}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...CLIENT_HEADER },
        body: JSON.stringify(body)
    });

const requestModels = async (settings?: unknown): Promise<ModelIndex> => {
    const response = await post('/api/models', settings === undefined ? {} : { settings });
    expect(response.status).toBe(200);
    return (await response.json()) as ModelIndex;
};

// Create a preset session (through the legacy `writer` alias), submit one task,
// and fully drain the SSE stream so the run finishes before assertions. The
// terminal frame is always `failed` here because the stub answers 500; only the
// recorded request matters.
const runWriter = async (settings: unknown): Promise<void> => {
    const created = await post('/api/sessions', { harness: 'writer', settings });
    expect(created.status).toBe(201);
    const session = (await created.json() as { session: SessionSnapshot }).session;

    const stream = await post(`/api/sessions/${session.id}/messages`, { input: 'hello' });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(await stream.text()).toContain('"type":"failed"');
};

describe('server credential containment', () => {
    it('sends the server key only to the configured provider origin and base path', async () => {
        // No client settings at all: the server's own endpoint + key.
        expect(await requestModels()).toEqual({ models: ['stub-model'] });
        expect(authoritative.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` }
        ]);
        expect(foreign.requests).toEqual([]);

        // Same provider, trailing slash, blank key: still the configured provider.
        expect(await requestModels({ baseURL: `${authoritative.origin}/v1/`, apiKey: '' })).toEqual({
            models: ['stub-model']
        });
        expect(authoritative.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` },
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` }
        ]);

        // Same origin, DIFFERENT base path: not the configured provider endpoint.
        expect(await requestModels({ baseURL: `${authoritative.origin}/v2`, apiKey: '' })).toEqual({
            models: ['stub-model']
        });
        expect(authoritative.requests.at(-1)).toEqual({
            method: 'GET',
            url: '/v2/models',
            authorization: undefined
        });

        // Foreign provider, blank key: the server key must not travel.
        expect(await requestModels({ baseURL: `${foreign.origin}/v1`, apiKey: '' })).toEqual({
            models: ['stub-model']
        });
        expect(foreign.requests).toEqual([{ method: 'GET', url: '/v1/models', authorization: undefined }]);
    });

    it('uses an explicit client key against a foreign provider and never the server key', async () => {
        expect(await requestModels({ baseURL: `${foreign.origin}/v1`, apiKey: 'client-key' })).toEqual({
            models: ['stub-model']
        });

        expect(foreign.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: 'Bearer client-key' }
        ]);
        expect(authoritative.requests).toEqual([]);
    });

    it('applies the same rule to session creation and the run it makes', async () => {
        // Foreign provider, blank key: unauthenticated session, not a leaked key.
        await runWriter({ baseURL: `${foreign.origin}/v1`, apiKey: '' });
        expect(foreign.requests).toEqual([
            { method: 'POST', url: '/v1/chat/completions', authorization: undefined }
        ]);
        expect(authoritative.requests).toEqual([]);

        // Foreign provider, explicit key: the session uses the client's key.
        foreign.requests.length = 0;
        await runWriter({ baseURL: `${foreign.origin}/v1`, apiKey: 'client-key' });
        expect(foreign.requests).toEqual([
            { method: 'POST', url: '/v1/chat/completions', authorization: 'Bearer client-key' }
        ]);
        expect(authoritative.requests).toEqual([]);

        // Configured provider (trailing slash variant), blank key: server key.
        foreign.requests.length = 0;
        authoritative.requests.length = 0;
        await runWriter({ baseURL: `${authoritative.origin}/v1/`, apiKey: '' });
        expect(authoritative.requests).toEqual([
            { method: 'POST', url: '/v1/chat/completions', authorization: `Bearer ${SERVER_KEY}` }
        ]);
        expect(foreign.requests).toEqual([]);
    });

    it('sends no authorization header when the server has no key', async () => {
        const keyless = await startHarnessServer({
            port: 0,
            staticRoot: null,
            settings: { baseURL: `${authoritative.origin}/v1`, apiKey: '', model: MODEL },
            defaults: { baseURL: `${authoritative.origin}/v1`, model: MODEL, hasApiKey: false }
        });

        try {
            const response = await fetch(`${keyless.url}/api/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...CLIENT_HEADER },
                body: JSON.stringify({})
            });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ models: ['stub-model'] });
            expect(authoritative.requests).toEqual([
                { method: 'GET', url: '/v1/models', authorization: undefined }
            ]);
        } finally {
            await keyless.close();
        }
    });
});
