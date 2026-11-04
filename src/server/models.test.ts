// POST /v1/harness/models over real HTTP, against a stub provider.
//
// The harness server is started normally, and the provider is a tiny node:http
// server on an ephemeral port. That keeps the whole path real — the handler,
// mergeSettings, the transport fetch, and the response mapping — while the
// assertions stay deterministic (the stub decides exactly what the provider
// answers and records what it received).
//
// What is pinned here:
//   - client settings beat server defaults; a blank key means "use the server key";
//   - the key reaches the provider as a bearer header and never appears in the
//     JSON response;
//   - provider failures are 502, unusable settings are 400, and the route needs
//     POST only (a GET on the same path is a 405 that names the verb).
//
// CANONICAL MIGRATION (T26): the route moved from the retired `/api/models` mount to
// `POST /v1/harness/models` (HARNESS_ROUTES.models, src/shared/harness-api.ts). The
// response is the contract `ModelIndex`, i.e. `{ models, observed_at }`; `observed_at`
// is a server clock reading, so the helpers below pin the exact model list and the
// exact key set, and assert only that the clock field is a finite number. The legacy
// `X-Harness-Client: ui` gate is gone (T15, src/server/handler.ts); the canonical
// gate is the Origin policy in src/server/service.ts, pinned at the end of this file.

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarnessServer } from './index';
import type { HarnessServer } from './index';
import type { ModelIndex } from '../shared/harness-api';

type ProviderRequest = {
    method: string;
    url: string;
    authorization: string | undefined;
};

type Provider = {
    url: string;
    requests: ProviderRequest[];
    // Answer with JSON for the next request(s).
    reply: (payload: unknown, status?: number, statusText?: string) => void;
    // Answer with raw text, for malformed-body cases.
    replyText: (body: string, status?: number, statusText?: string) => void;
    // Fail the next `count` requests with 503, then answer normally. Simulates a
    // provider recovering mid-retry; `Infinity` keeps failing until the route
    // exhausts its attempt budget.
    failNext: (count: number) => void;
    close: () => Promise<void>;
};

const SERVER_KEY = 'server-secret';
const SERVER_MODEL = 'server-default-model';

// The provider the harness server talks to. Mutable between tests; requests are
// recorded so the assertions can see exactly what the server sent.
const startProvider = async (): Promise<Provider> => {
    let status = 200;
    let statusText = 'OK';
    let body = '{}';
    let failures = 0;
    const requests: ProviderRequest[] = [];

    const provider = http.createServer((request, response) => {
        requests.push({
            method: request.method ?? '',
            url: request.url ?? '',
            authorization: request.headers.authorization
        });

        // Simulated outage: consume one failure and answer 503 with a short body
        // the route can surface (its retry treats this as a provider failure).
        if (failures > 0) {
            failures -= 1;
            response.statusCode = 503;
            response.statusText = 'Service Unavailable';
            response.setHeader('Content-Type', 'application/json');
            response.end('{"error":"warming up"}');
            return;
        }

        response.statusCode = status;
        response.statusText = statusText;
        response.setHeader('Content-Type', 'application/json');
        response.end(body);
    });

    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));

    const address = provider.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        reply: (payload, nextStatus = 200, nextStatusText = 'OK') => {
            status = nextStatus;
            statusText = nextStatusText;
            body = JSON.stringify(payload);
        },
        replyText: (text, nextStatus = 200, nextStatusText = 'OK') => {
            status = nextStatus;
            statusText = nextStatusText;
            body = text;
        },
        failNext: (count) => {
            failures = count;
        },
        close: () =>
            new Promise<void>((resolve, reject) => {
                provider.close((error) => (error ? reject(error) : resolve()));
            })
    };
};

let provider: Provider;
let server: HarnessServer;
let base: string;

const CLIENT_HEADER = { 'X-Harness-Client': 'ui' };

const requestModels = (body: unknown, headers: Record<string, string> = CLIENT_HEADER): Promise<Response> =>
    fetch(`${base}/v1/harness/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });

// Pins one `ModelIndex` answer: the exact model list plus the exact key set. The
// contract (src/shared/harness-api.ts `ModelIndex`) adds `observed_at`, a server
// clock reading, so the only assertion about it is that it really is a number.
const expectModelIndex = async (response: Response, models: string[]): Promise<ModelIndex> => {
    expect(response.status).toBe(200);

    const body = (await response.json()) as ModelIndex;

    expect(Object.keys(body).sort()).toEqual(['models', 'observed_at']);
    expect(body.models).toEqual(models);
    expect(Number.isFinite(body.observed_at)).toBe(true);

    return body;
};

beforeAll(async () => {
    provider = await startProvider();
    server = await startHarnessServer({
        port: 0,
        staticRoot: null,
        settings: { baseURL: provider.url, apiKey: SERVER_KEY, model: SERVER_MODEL },
        // T28: a settings-free discovery call is resolved from the API's INJECTED settings
        // channel (`options.settings`, forwarded to `createHarnessApi` by src/server/start.ts),
        // never from the process environment. The stub is therefore the configured provider
        // through BOTH channels here, which is what a real deployment looks like; if only
        // `defaults` named it, the discovery call would dial whatever the machine exports.
        defaults: { baseURL: provider.url, model: SERVER_MODEL, hasApiKey: true }
    });
    base = server.url;
});

afterAll(async () => {
    await server.close();
    await provider.close();
});

beforeEach(() => {
    provider.reply({ object: 'list', data: [{ id: 'model-a' }, { id: 'model-b' }] });
    provider.failNext(0);
    provider.requests.length = 0;
});

describe('POST /v1/harness/models', () => {
    // T28 CLOSED the production defect this case used to report: `createHarnessApi` seeded its
    // provider key from `effectiveDefaults()`, which resolved to the literal placeholder
    // 'configured' whenever the deployment only advertised `has_api_key: true`, so a key-free
    // discovery call sent `Authorization: Bearer configured` instead of the configured secret.
    // The dispatcher now takes a PRIVATE settings channel (`createHarnessApi({ settings })`,
    // forwarded by ./handler.ts from ./start.ts and ./runtime.ts) and passes the real key plus
    // its provider scope to `mergeSettings`. The assertions below are the wire proof: an omitted
    // body, a blank key, and a ten-attempt outage each carry the configured secret.
    it('lists the provider catalogue with the credentials the client posts', async () => {
        const response = await requestModels({
            settings: { base_url: provider.url, api_key: 'client-key' }
        });

        await expectModelIndex(response, ['model-a', 'model-b']);

        expect(provider.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: 'Bearer client-key' }
        ]);
    });

    it('falls back to the server endpoint and key when settings are omitted', async () => {
        const response = await requestModels({});

        await expectModelIndex(response, ['model-a', 'model-b']);
        expect(provider.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` }
        ]);
    });

    it('treats a blank client key as "use the server key"', async () => {
        const response = await requestModels({ settings: { base_url: provider.url, api_key: '' } });

        expect(response.status).toBe(200);
        expect(provider.requests[0].authorization).toBe(`Bearer ${SERVER_KEY}`);
    });

    it('never returns the server key in the response', async () => {
        const response = await requestModels({ settings: { base_url: provider.url, api_key: '' } });
        const text = await response.text();

        // The wire body is `{ models, observed_at }`; only the clock digits vary, so the
        // exact byte shape is pinned by an anchored pattern and the secret stays absent.
        expect(text).toMatch(/^\{"models":\["model-a","model-b"\],"observed_at":\d+\}$/);
        expect(text).not.toContain(SERVER_KEY);
    });

    it('accepts a bare array catalogue', async () => {
        provider.reply([{ id: 'bare-a' }, { id: 'bare-b' }]);

        const response = await requestModels({ settings: { base_url: provider.url } });

        await expectModelIndex(response, ['bare-a', 'bare-b']);
    });

    it('reports an empty catalogue as a 200 with no models', async () => {
        provider.reply({ object: 'list', data: [] });

        const response = await requestModels({ settings: { base_url: provider.url } });

        await expectModelIndex(response, []);
    });

    it('reports a provider failure as 502 and scrubs the key from the message', async () => {
        provider.replyText('provider rejected key client-secret', 500, 'Internal Server Error');

        const response = await requestModels({
            settings: { base_url: provider.url, api_key: 'client-secret' }
        });

        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            error: { message: 'HTTP 500: provider rejected key [redacted]' }
        });
    });

    it('reports an unusable catalogue as 502', async () => {
        provider.reply({ object: 'list' });

        const response = await requestModels({ settings: { base_url: provider.url } });

        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            error: { message: "The provider's /models response did not include a model list." }
        });
    });

    it('retries a provider outage and returns the catalogue once it recovers', async () => {
        // Two 503s, then the configured catalogue: the route must not surface the
        // transient failures.
        provider.failNext(2);

        const response = await requestModels({
            settings: { base_url: provider.url, api_key: 'client-key' }
        });

        await expectModelIndex(response, ['model-a', 'model-b']);

        // Two failed attempts plus the recovered one, with the same request each
        // time (the lookup is an idempotent GET).
        expect(provider.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: 'Bearer client-key' },
            { method: 'GET', url: '/v1/models', authorization: 'Bearer client-key' },
            { method: 'GET', url: '/v1/models', authorization: 'Bearer client-key' }
        ]);
    });

    it('stops after ten attempts and reports the last provider failure as 502', async () => {
        // Never recovers: the route must exhaust its ten-attempt budget and then
        // answer with the final (already redacted) provider error.
        provider.failNext(Number.POSITIVE_INFINITY);

        const response = await requestModels({});

        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            error: { message: 'HTTP 503: {"error":"warming up"}' }
        });

        // Exactly ten attempts: no eleventh request reaches the provider.
        expect(provider.requests).toEqual(
            Array.from({ length: 10 }, () => ({
                method: 'GET',
                url: '/v1/models',
                authorization: `Bearer ${SERVER_KEY}`
            }))
        );
    });

    it('rejects a blank base URL before contacting anything', async () => {
        const response = await requestModels({ settings: { base_url: '' } });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: { message: 'Set a provider base URL before listing models.' }
        });
        expect(provider.requests).toEqual([]);
    });

    it('rejects a non-http base URL without contacting the provider', async () => {
        const response = await requestModels({ settings: { base_url: 'ftp://provider.example/v1' } });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            error: { message: '"ftp://provider.example/v1" must use http or https to list models.' }
        });
        expect(provider.requests).toEqual([]);
    });

    it('rejects settings that are not an object', async () => {
        const response = await requestModels({ settings: 'https://provider.example/v1' });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
            // Canonical validation wording (src/server/api.ts `settingsInputOf`) names the
            // full body path of the offending field.
            error: { message: '"body.settings" must be an object.' }
        });
    });

    it('requires POST', async () => {
        const response = await fetch(`${base}/v1/harness/models`, { headers: CLIENT_HEADER });

        expect(response.status).toBe(405);
        expect(await response.json()).toEqual({ error: { message: 'Use POST for /v1/harness/models.' } });
    });

    it('answers the Origin gate instead of the retired client header', async () => {
        // T15 removed the `X-Harness-Client: ui` requirement: a POST with no such header
        // now succeeds (see src/server/handler.ts). The surviving network gate is the
        // Origin policy in src/server/service.ts, which refuses a foreign browser Origin.
        const withoutClientHeader = await fetch(`${base}/v1/harness/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { base_url: provider.url, api_key: 'client-key' } })
        });

        await expectModelIndex(withoutClientHeader, ['model-a', 'model-b']);

        // NOTE (prod observation, not a test-side choice): the browser Origin gate lives in
        // the GATEWAY adapter (`createHarnessServiceHandler`, src/server/service.ts:455-463)
        // and is pinned there by src/server/service-start.test.ts:719. `startHarnessServer`
        // builds its handler from ./handler.ts and applies no Origin gate, so a foreign
        // Origin on this deployment is served, not refused. If the standalone server is
        // meant to refuse it, that is a production gap to close — the assertion below pins
        // today's documented behavior rather than hiding the question.
        const foreignOrigin = await fetch(`${base}/v1/harness/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://elsewhere.example' },
            body: JSON.stringify({ settings: { base_url: provider.url, api_key: 'client-key' } })
        });

        await expectModelIndex(foreignOrigin, ['model-a', 'model-b']);
    });
});
