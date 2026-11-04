// Credential containment: the server key must not follow a client-chosen base URL.
//
// Both HTTP paths that merge client settings — POST /api/models and POST
// /api/sessions — go through `mergeSettings` (src/server/config.ts). These tests drive
// the real standalone server against two loopback stub providers so the assertion
// is on the WIRE (the `authorization` header the provider actually received), not
// on an internal settings object.
//
// Matrix pinned here:
//   - omitted/blank key + configured provider (trailing slash variant) → server key;
//   - omitted/blank key + same origin but different base path        → no key;
//   - omitted/blank key + foreign provider (models and sessions)     → no key;
//   - explicit client key + foreign provider                         → client key;
//   - server configured with no key                                  → no key anywhere;
//   - T28: a `/config` base_url patch                                 → the server key stays
//     scoped to the provider it was configured for (a patched host is dialed unauthenticated,
//     and the original provider is authenticated again when the default moves back).
//
// No external network: providers are node:http servers on 127.0.0.1:0, and the
// `writer` preset identifier is used on purpose: it is a legacy alias that now
// resolves to `instruct`, so this also proves an old client name still creates a
// canonical session.

import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startHarnessServer } from './index';
import type { HarnessServer } from './index';
// Canonical network vocabulary (T26): every DTO here comes from the generated contract,
// not from the internal `protocol.ts` legacy models.
import type {
    GlobalConfigDocument,
    ModelIndex,
    SessionResource,
    SessionTurnStatus,
    TaskReceipt,
    TurnEventPage,
    TurnResource,
    TurnResponse
} from '../shared/harness-api';

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
// one-model catalogue; anything else (the chat transport) answers a MINIMAL VALID
// SSE completion.
//
// WHY A SUCCESSFUL STREAM: the agent retries a failed model request (R1) with real
// doubling backoff, so a 500 here would make this credential test wait out the
// entire retry sequence. The subject of this file is the `authorization` header on
// the wire, so the stub completes on the first attempt and the assertion stays
// about the recorded request.
const startProvider = async (): Promise<Provider> => {
    const requests: ProviderRequest[] = [];

    const server = http.createServer((request, response) => {
        requests.push({
            method: request.method ?? '',
            url: request.url ?? '',
            authorization: request.headers.authorization
        });

        if ((request.url ?? '').endsWith('/models')) {
            response.setHeader('Content-Type', 'application/json');
            response.statusCode = 200;
            response.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model' }] }));
            return;
        }

        response.setHeader('Content-Type', 'text/event-stream');
        response.statusCode = 200;
        response.end(
            `data: ${JSON.stringify({
                choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }]
            })}\n\ndata: [DONE]\n\n`
        );
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

const get = (pathname: string): Promise<Response> =>
    fetch(`${base}${pathname}`, { headers: CLIENT_HEADER });

// One global settings write (`PATCH /v1/harness/config`), used by the T28 case below to move
// the deployment default and issue/clear a process-only credential over HTTP — the same path
// an operator uses. The response is the written document, so the caller can also pin that no
// key is ever echoed back.
const patchConfig = (settings: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/v1/harness/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...CLIENT_HEADER },
        body: JSON.stringify({ settings })
    });

// Canonical discovery read (`POST /v1/harness/models`). The contract answer is
// `ModelIndex` = `{ models, observed_at }`; the credential rule this file pins is about
// what reaches the PROVIDER, so the helper returns the model list and pins the clock
// field separately.
const requestModels = async (settings?: unknown): Promise<string[]> => {
    const response = await post('/v1/harness/models', settings === undefined ? {} : { settings });
    expect(response.status).toBe(200);

    const body = (await response.json()) as ModelIndex;

    expect(Number.isFinite(body.observed_at)).toBe(true);
    return body.models;
};

// Poll one canonical read until the submitted turn reaches a terminal status. The
// canonical surface has no response-owned SSE body (T13/T17), so completion is observed
// through `GET /v1/harness/sessions/{id}/turns/{turn_id}`.
const waitForTurn = async (sessionId: string, turnId: string, expected: SessionTurnStatus): Promise<TurnResource> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
        const response = await get(`/v1/harness/sessions/${sessionId}/turns/${turnId}`);
        expect(response.status).toBe(200);

        const turn = ((await response.json()) as TurnResponse).turn;

        if (turn.status === expected) return turn;
        if (turn.status === 'error' || turn.status === 'cancelled') {
            throw new Error(`turn ${turnId} ended as ${turn.status}: ${JSON.stringify(turn.error)}`);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    throw new Error(`turn ${turnId} never reached ${expected}`);
};

// Create a preset session and run one task through the canonical submit:
// `POST /v1/harness/sessions` then `POST .../tasks` -> 202 receipt, then a bounded wait
// on the turn read. The stub provider completes on the first attempt, so the recorded
// provider request (and the turn's terminal status) is what matters here.
const runWriter = async (settings: unknown): Promise<void> => {
    const created = await post('/v1/harness/sessions', { harness: 'writer', settings });
    expect(created.status).toBe(201);
    const session = (await created.json() as { session: SessionResource }).session;

    const accepted = await post(`/v1/harness/sessions/${session.id}/tasks`, { input: 'hello' });
    expect(accepted.status).toBe(202);

    const receipt = (await accepted.json()) as TaskReceipt;

    expect(receipt.session_id).toBe(session.id);
    expect(typeof receipt.turn_id).toBe('string');
    expect(receipt.links.turn).toBe(`/v1/harness/sessions/${session.id}/turns/${receipt.turn_id}`);

    const finished = await waitForTurn(session.id, receipt.turn_id, 'done');

    // The recorded events are readable through the canonical paged route, which is how a
    // client sees the run without owning a stream.
    const events = await get(`/v1/harness/sessions/${session.id}/turns/${receipt.turn_id}/events`);
    expect(events.status).toBe(200);

    const page = (await events.json()) as TurnEventPage;

    expect(page.turn_id).toBe(receipt.turn_id);
    expect(page.partial).toBe(false);
    expect(page.total_events).toBe(finished.event_count);
    expect(page.items.length).toBe(page.total_events);
    expect(page.items.at(-1)!.event.type).toBe('done');
};

describe('server credential containment', () => {
    it('sends the server key only to the configured provider origin and base path', async () => {
        // No client settings at all: the server's own endpoint + key.
        expect(await requestModels()).toEqual(['stub-model']);
        expect(authoritative.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` }
        ]);
        expect(foreign.requests).toEqual([]);

        // Same provider, trailing slash, blank key: still the configured provider.
        expect(await requestModels({ base_url: `${authoritative.origin}/v1/`, api_key: '' })).toEqual(['stub-model']);
        expect(authoritative.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` },
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` }
        ]);

        // Same origin, DIFFERENT base path: not the configured provider endpoint.
        expect(await requestModels({ base_url: `${authoritative.origin}/v2`, api_key: '' })).toEqual(['stub-model']);
        expect(authoritative.requests.at(-1)).toEqual({
            method: 'GET',
            url: '/v2/models',
            authorization: undefined
        });

        // Foreign provider, blank key: the server key must not travel.
        expect(await requestModels({ base_url: `${foreign.origin}/v1`, api_key: '' })).toEqual(['stub-model']);
        expect(foreign.requests).toEqual([{ method: 'GET', url: '/v1/models', authorization: undefined }]);
    });

    it('uses an explicit client key against a foreign provider and never the server key', async () => {
        expect(await requestModels({ base_url: `${foreign.origin}/v1`, api_key: 'client-key' })).toEqual(['stub-model']);

        expect(foreign.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: 'Bearer client-key' }
        ]);
        expect(authoritative.requests).toEqual([]);
    });

    it('applies the same rule to session creation and the run it makes', async () => {
        // Foreign provider, blank key: unauthenticated session, not a leaked key.
        await runWriter({ base_url: `${foreign.origin}/v1`, api_key: '' });
        expect(foreign.requests).toEqual([
            { method: 'POST', url: '/v1/chat/completions', authorization: undefined }
        ]);
        expect(authoritative.requests).toEqual([]);

        // Foreign provider, explicit key: the session uses the client's key.
        foreign.requests.length = 0;
        await runWriter({ base_url: `${foreign.origin}/v1`, api_key: 'client-key' });
        expect(foreign.requests).toEqual([
            { method: 'POST', url: '/v1/chat/completions', authorization: 'Bearer client-key' }
        ]);
        expect(authoritative.requests).toEqual([]);

        // Configured provider (trailing slash variant), blank key: server key.
        foreign.requests.length = 0;
        authoritative.requests.length = 0;
        await runWriter({ base_url: `${authoritative.origin}/v1/`, api_key: '' });
        expect(authoritative.requests).toEqual([
            { method: 'POST', url: '/v1/chat/completions', authorization: `Bearer ${SERVER_KEY}` }
        ]);
        expect(foreign.requests).toEqual([]);
    });

    // T28 regression: a `PATCH /config base_url` moves the DEFAULT ENDPOINT, not whose secret
    // it is. The injected key belongs to the provider it was configured for (origin + base
    // path), so discovery must dial a patched foreign host unauthenticated, and dial the
    // original provider authenticated again once the default moves back.
    it('keeps the server key scoped to its own provider across a base-URL patch', async () => {
        // The ONE request this file's cases ever let reach the foreign provider in this test:
        // a body-less discovery while the default points there. Asserting the exact recorded
        // list at every step is what proves the patched host is never given the key afterwards.
        const foreignUnauthenticated = [{ method: 'GET', url: '/v1/models', authorization: undefined }];

        // Point the deployment default at the foreign provider, in this process only.
        const patched = await patchConfig({ base_url: `${foreign.origin}/v1` });
        const doc = (await patched.json()) as GlobalConfigDocument;

        expect(patched.status).toBe(200);
        // Key-free by contract, and the endpoint really did move.
        expect(Object.keys(doc.defaults).sort()).toEqual(['base_url', 'has_api_key', 'model']);
        expect(doc.defaults.base_url).toBe(`${foreign.origin}/v1`);

        // A body-less discovery call now dials the patched host — with no credential, because
        // that host never issued one.
        expect(await requestModels()).toEqual(['stub-model']);
        expect(foreign.requests).toEqual(foreignUnauthenticated);
        expect(authoritative.requests).toEqual([]);

        // Back to the provider the key belongs to: the same key is used again, and the foreign
        // host receives nothing further (its list still holds only the one call above).
        const restored = await patchConfig({ base_url: `${authoritative.origin}/v1/` });

        expect(restored.status).toBe(200);
        expect(await requestModels()).toEqual(['stub-model']);
        expect(authoritative.requests).toEqual([
            { method: 'GET', url: '/v1/models', authorization: `Bearer ${SERVER_KEY}` }
        ]);
        expect(foreign.requests).toEqual(foreignUnauthenticated);

        // Clearing the key in-process sends nothing anywhere, even to the key's own provider,
        // and the advertisement follows the credential rather than the boot-time claim.
        const cleared = await patchConfig({ api_key: '' });
        const clearedDoc = (await cleared.json()) as GlobalConfigDocument;

        expect(clearedDoc.defaults.has_api_key).toBe(false);
        expect(await requestModels()).toEqual(['stub-model']);
        expect(authoritative.requests.at(-1)).toEqual({
            method: 'GET',
            url: '/v1/models',
            authorization: undefined
        });
        expect(foreign.requests).toEqual(foreignUnauthenticated);

        // Reset to the shipped credential (the deployment's own key), so a later case in this
        // file still sees the configured provider authenticated.
        const reset = await patchConfig({ api_key: null });
        const resetDoc = (await reset.json()) as GlobalConfigDocument;

        expect(resetDoc.defaults.has_api_key).toBe(true);
        expect(await requestModels()).toEqual(['stub-model']);
        expect(authoritative.requests.at(-1)).toEqual({
            method: 'GET',
            url: '/v1/models',
            authorization: `Bearer ${SERVER_KEY}`
        });
        expect(foreign.requests).toEqual(foreignUnauthenticated);
    });

    it('sends no authorization header when the server has no key', async () => {
        const keyless = await startHarnessServer({
            port: 0,
            staticRoot: null,
            settings: { baseURL: `${authoritative.origin}/v1`, apiKey: '', model: MODEL },
            defaults: { baseURL: `${authoritative.origin}/v1`, model: MODEL, hasApiKey: false }
        });

        try {
            const response = await fetch(`${keyless.url}/v1/harness/models`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...CLIENT_HEADER },
                body: JSON.stringify({})
            });

            expect(response.status).toBe(200);

            const body = (await response.json()) as ModelIndex;

            expect(Object.keys(body).sort()).toEqual(['models', 'observed_at']);
            expect(body.models).toEqual(['stub-model']);
            expect(Number.isFinite(body.observed_at)).toBe(true);
            expect(authoritative.requests).toEqual([
                { method: 'GET', url: '/v1/models', authorization: undefined }
            ]);
        } finally {
            await keyless.close();
        }
    });
});
