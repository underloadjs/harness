// transport/models.ts — the provider catalogue lookup.
//
// `fetch` is stubbed, so these tests pin the exact request (URL, headers, method)
// and every response shape without any network. The server-side integration is
// covered separately in server/models.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { listModels, ModelListError } from './models';

// Every call must receive a fresh Response: a body can only be read once.
const json = (payload: unknown, init?: ResponseInit): Response =>
    new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init
    });

const stubFetch = (respond: () => Response | Promise<Response>) => {
    const fetchMock = vi.fn(async () => respond());
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

const requestOf = (
    fetchMock: ReturnType<typeof stubFetch>
): { url: string; init: RequestInit } => {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return { url, init };
};

// Capture the rejection so the assertions can be exact about kind and message.
const failureOf = async (promise: Promise<unknown>): Promise<ModelListError> => {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(ModelListError);
        return error as ModelListError;
    }

    throw new Error('Expected listModels to reject.');
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('listModels', () => {
    it('GETs the normalized /models URL with the bearer key and provider order preserved', async () => {
        const fetchMock = stubFetch(() =>
            json({ object: 'list', data: [{ id: 'model-b', owned_by: 'x' }, { id: 'model-a' }] })
        );

        const ids = await listModels({
            baseURL: '  https://provider.example/v1///  ',
            apiKey: 'secret-key',
            headers: { 'x-extra': 'yes' }
        });

        expect(ids).toEqual(['model-b', 'model-a']);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const { url, init } = requestOf(fetchMock);
        expect(url).toBe('https://provider.example/v1/models');
        expect(init.method).toBe('GET');
        expect(init.headers).toEqual({
            accept: 'application/json',
            authorization: 'Bearer secret-key',
            'x-extra': 'yes'
        });
        // The key lives in the header only.
        expect(url).not.toContain('secret-key');
    });

    it('normalizes a base URL with no path and with a root path', async () => {
        const fetchMock = stubFetch(() => json({ data: [] }));

        expect(await listModels({ baseURL: 'http://provider.example' })).toEqual([]);
        expect(requestOf(fetchMock).url).toBe('http://provider.example/models');

        expect(await listModels({ baseURL: 'http://provider.example/' })).toEqual([]);
        const second = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(second[0]).toBe('http://provider.example/models');
    });

    it('omits the authorization header when no key is configured', async () => {
        const fetchMock = stubFetch(() => json({ data: [{ id: 'm' }] }));

        expect(await listModels({ baseURL: 'http://x/v1' })).toEqual(['m']);
        expect(requestOf(fetchMock).init.headers).toEqual({ accept: 'application/json' });
    });

    it('resolves a getter api key per call', async () => {
        const fetchMock = stubFetch(() => json({ data: [] }));

        let key = 'first';
        const configuration = { baseURL: 'http://x/v1', apiKey: () => key };

        await listModels(configuration);
        key = 'second';
        await listModels(configuration);

        const headers = fetchMock.mock.calls.map(
            ([, init]) => (init as RequestInit).headers as Record<string, string>
        );
        expect(headers[0].authorization).toBe('Bearer first');
        expect(headers[1].authorization).toBe('Bearer second');
    });

    it('accepts a bare array and drops blank, duplicated, and non-string ids', async () => {
        stubFetch(() => json([{ id: 'a' }, 'b', { id: 'a' }, { id: '  c  ' }, { id: 7 }, { object: 'model' }, { id: '' }]));

        expect(await listModels({ baseURL: 'http://x/v1' })).toEqual(['a', 'b', 'c']);
    });

    it('returns an empty list for a valid but empty catalogue', async () => {
        stubFetch(() => json({ object: 'list', data: [] }));
        expect(await listModels({ baseURL: 'http://x/v1' })).toEqual([]);
    });

    it('reports a non-2xx answer with its body as an HTTP error', async () => {
        stubFetch(() => new Response('upstream unavailable', { status: 503, statusText: 'Service Unavailable' }));

        const error = await failureOf(listModels({ baseURL: 'https://provider.example/v1', apiKey: 'k' }));

        expect(error.kind).toBe('response');
        expect(error.message).toBe('HTTP 503: upstream unavailable');
    });

    it('redacts the key when a provider echoes it in an error body', async () => {
        stubFetch(
            () => new Response('invalid api key client-secret', { status: 401, statusText: 'Unauthorized' })
        );

        const error = await failureOf(listModels({ baseURL: 'https://provider.example/v1', apiKey: 'client-secret' }));

        expect(error.kind).toBe('response');
        expect(error.message).toBe('HTTP 401: invalid api key [redacted]');
    });

    it('reports a response without a data list', async () => {
        stubFetch(() => json({ object: 'list' }));

        const error = await failureOf(listModels({ baseURL: 'http://x/v1' }));

        expect(error.kind).toBe('response');
        expect(error.message).toBe("The provider's /models response did not include a model list.");
    });

    it('reports a body that is not JSON', async () => {
        stubFetch(() => new Response('not json', { status: 200 }));

        const error = await failureOf(listModels({ baseURL: 'http://x/v1' }));

        expect(error.kind).toBe('response');
        expect(error.message.startsWith('The provider returned a model list that is not JSON:')).toBe(true);
    });

    it('rejects a blank base URL without making a request', async () => {
        const fetchMock = stubFetch(() => json({ data: [] }));

        const error = await failureOf(listModels({ baseURL: '   ' }));

        expect(error.kind).toBe('configuration');
        expect(error.message).toBe('A provider base URL is required to list models.');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a relative base URL without making a request', async () => {
        const fetchMock = stubFetch(() => json({ data: [] }));

        const error = await failureOf(listModels({ baseURL: 'provider.example/v1' }));

        expect(error.kind).toBe('configuration');
        expect(error.message).toBe('"provider.example/v1" is not an absolute URL.');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a non-http scheme without making a request', async () => {
        const fetchMock = stubFetch(() => json({ data: [] }));

        const error = await failureOf(listModels({ baseURL: 'ftp://provider.example/v1' }));

        expect(error.kind).toBe('configuration');
        expect(error.message).toBe('"ftp://provider.example/v1" must use http or https to list models.');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a connection failure without quoting credentials or the query string', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('ECONNREFUSED');
            })
        );

        const error = await failureOf(
            listModels({
                baseURL: 'https://user:url-secret@provider.example/v1?token=query-secret',
                apiKey: 'client-secret'
            })
        );

        expect(error.kind).toBe('request');
        expect(error.message).toBe('Request to https://provider.example/v1/models failed: ECONNREFUSED');
    });

    it('forwards the caller signal', async () => {
        const fetchMock = stubFetch(() => json({ data: [] }));
        const controller = new AbortController();

        await listModels({ baseURL: 'http://x/v1', signal: controller.signal });

        expect(requestOf(fetchMock).init.signal).toBe(controller.signal);
    });
});
