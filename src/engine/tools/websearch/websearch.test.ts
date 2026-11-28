// websearch — the tool factory, key resolution, and every provider adapter.
//
// Everything here is offline and deterministic: the environment is injected
// (`env`), fetch is a stub (`vi.stubGlobal`), and no host key or network is read.
// The tests pin the exact wire request (URL, header, JSON body) and the exact
// normalized result, because the contract with three third-party providers is
// exactly where silent drift is expensive.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_TOOL_RESULT_BUDGET_BYTES, boundToolResult, modelPayloadBytes } from '../../core';
import { createWebSearchTool } from '../../index';
import type { Tool, WebsearchConfiguration, WebSearchParameters, WebSearchResult } from '../../index';
import {
    fitRowsToResultBudget,
    MAX_PUBLISHED_CHARS,
    MAX_RESPONSE_BYTES,
    MAX_RESULTS_LIMIT,
    MAX_SEARCH_RESULT_BYTES,
    MAX_SNIPPET_CHARS,
    MAX_TITLE_CHARS,
    MAX_URL_CHARS,
    SEARCH_TIMEOUT_MS
} from './request';

// A configured tool must exist: a test that accidentally has no key should fail
// here rather than skip an assertion.
const configured = (
    env: Record<string, string | undefined>,
    toolConfiguration: Omit<WebsearchConfiguration, 'env'> = {}
): Tool<WebSearchParameters, WebSearchResult> => {
    const definition = createWebSearchTool({ env, ...toolConfiguration });

    if (!definition) throw new Error('Expected a configured search tool.');

    return definition;
};

// The one delivery check that matters for a tool result: the harness caps a result at
// `MODEL_TOOL_RESULT_BUDGET_BYTES` of JSON-escaped payload and REFUSES an oversized
// JSON document outright (no envelope, no slice, the call reported as failed). Every
// "this shape is delivered" assertion below goes through THIS call, so the tool is
// measured by the same helper the harness measures it with (T2/F2), and a change to
// either side shows up here rather than in a live run.
const deliverable = (result: unknown): ReturnType<typeof boundToolResult> =>
    boundToolResult(JSON.stringify(result), MODEL_TOOL_RESULT_BUDGET_BYTES, { source: { name: 'search' } });

const json = (body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response =>
    new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
    });

const stubFetch = (response: Response | ((url: string, init: RequestInit) => Promise<Response>)) => {
    const mock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
        typeof response === 'function' ? response : async () => response.clone()
    );

    vi.stubGlobal('fetch', mock);
    return mock;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('key resolution', () => {
    it('registers nothing without a key', () => {
        expect(createWebSearchTool({ env: {} })).toBeUndefined();
        expect(
            createWebSearchTool({ env: { EXA_API_KEY: '   ', TAVILY_API_KEY: '', LINKUP_API_KEY: '  ' } })
        ).toBeUndefined();
    });

    it('offers only the provider that has a key', () => {
        const exa = configured({ EXA_API_KEY: 'exa-secret-key' });

        expect(exa.name).toBe('search');
        // R18: a configured search tool is core — declared, never discovered.
        expect(exa.visibility).toBe('core');
        expect(exa.tags).toEqual(['web', 'search', 'internet', 'news', 'research']);

        // No provider property at all: one legal value is not a choice. The
        // provider filters ARE offered — they are not provider-specific arguments,
        // they are the scoping every adapter maps onto its own wire fields.
        const properties = (exa.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual([
            'query',
            'maxResults',
            'includeDomains',
            'excludeDomains',
            'since',
            'until',
            'category',
            'speed'
        ]);
        expect(exa.description).toContain('Exa');
        expect(exa.description).not.toContain('Tavily');
    });

    it('prefers Exa when both are configured and offers the override', () => {
        const both = configured({ EXA_API_KEY: 'exa-secret-key', TAVILY_API_KEY: 'tavily-secret-key' });
        const properties = (both.parameters as { properties: Record<string, { enum?: string[] }> }).properties;

        expect(properties.provider.enum).toEqual(['exa', 'tavily']);
        expect(both.description).toContain('Exa or Tavily');
    });

    it('offers only Linkup when LINKUP_API_KEY is the single key', () => {
        const linkup = configured({ LINKUP_API_KEY: 'linkup-secret-key' });

        // One configured provider is not a choice, so the schema carries no
        // `provider` property at all.
        const properties = (linkup.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual([
            'query',
            'maxResults',
            'includeDomains',
            'excludeDomains',
            'since',
            'until',
            'category',
            'speed'
        ]);

        // The description names only the provider this harness can call.
        expect(linkup.description).toContain('Search the web with Linkup');
        expect(linkup.description).not.toContain('Exa');
        expect(linkup.description).not.toContain('Tavily');
    });

    it('keeps Exa first and lists every configured provider', () => {
        const all = configured({
            EXA_API_KEY: 'exa-secret-key',
            TAVILY_API_KEY: 'tavily-secret-key',
            LINKUP_API_KEY: 'linkup-secret-key'
        });
        const properties = (all.parameters as { properties: Record<string, { enum?: string[] }> }).properties;

        // The schema order is the preference order, and appending Linkup never
        // reorders the providers an existing host already offers.
        expect(properties.provider.enum).toEqual(['exa', 'tavily', 'linkup']);
        expect(all.description).toContain('Exa, Tavily or Linkup');
    });

    it('prefers Exa over Linkup when only those two are configured', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ EXA_API_KEY: 'exa-secret-key', LINKUP_API_KEY: 'linkup-secret-key' });

        const result = await tool({ query: 'q' });

        expect(result.provider).toBe('exa');
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.exa.ai/search');
    });

    it('lets an explicit linkup key override the environment', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ LINKUP_API_KEY: 'env-linkup-key' }, { linkup: { apiKey: 'explicit-linkup-key' } });

        await tool({ query: 'anything' });

        expect(fetchMock.mock.calls[0][0]).toBe('https://api.linkup.so/v1/search');
        expect(fetchMock.mock.calls[0][1].headers).toEqual({
            'content-type': 'application/json',
            authorization: 'Bearer explicit-linkup-key'
        });
    });

    it('treats an explicit blank linkup key as "off", not as a fallback to env', () => {
        expect(
            createWebSearchTool({ env: { LINKUP_API_KEY: 'env-linkup-key' }, linkup: { apiKey: '' } })
        ).toBeUndefined();
    });

    it('lets an explicit key override the environment', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ EXA_API_KEY: 'env-exa-key' }, { exa: { apiKey: 'explicit-exa-key' } });

        await tool({ query: 'anything' });

        expect(fetchMock.mock.calls[0][1].headers).toEqual({
            'content-type': 'application/json',
            'x-api-key': 'explicit-exa-key'
        });
    });

    it('treats an explicit blank key as "off", not as a fallback to env', () => {
        expect(createWebSearchTool({ env: { EXA_API_KEY: 'env-exa-key' }, exa: { apiKey: '' } })).toBeUndefined();
    });

    it('calls a key getter once, at construction', async () => {
        let calls = 0;
        const fetchMock = stubFetch(json({ results: [] }));

        const tool = configured(
            {},
            {
                exa: {
                    apiKey: () => {
                        calls += 1;
                        return 'getter-exa-key';
                    }
                }
            }
        );

        expect(calls).toBe(1);
        await tool({ query: 'anything' });
        expect(calls).toBe(1);
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'getter-exa-key' });
    });

    it('rejects an explicit value that is not a string or getter', () => {
        expect(() => createWebSearchTool({ exa: { apiKey: 42 as never } })).toThrow(
            'search provider "exa" apiKey must be a string or a function returning one.'
        );
    });

    it('rejects a throwing getter without echoing its error', () => {
        expect(() =>
            createWebSearchTool({
                exa: {
                    apiKey: () => {
                        throw new Error('vault unavailable: sk-live-should-not-leak');
                    }
                }
            })
        ).toThrow('search provider "exa" apiKey getter failed.');
    });

    it('keeps keys out of the schema, description, and tags', () => {
        const tool = configured({
            EXA_API_KEY: 'exa-secret-key',
            TAVILY_API_KEY: 'tavily-secret-key',
            LINKUP_API_KEY: 'linkup-secret-key'
        });
        const metadata = JSON.stringify({
            description: tool.description,
            parameters: tool.parameters,
            tags: tool.tags,
            name: tool.name
        });

        expect(metadata).not.toContain('exa-secret-key');
        expect(metadata).not.toContain('tavily-secret-key');
        expect(metadata).not.toContain('linkup-secret-key');
        expect(metadata).not.toContain('EXA_API_KEY');
        expect(metadata).not.toContain('TAVILY_API_KEY');
        expect(metadata).not.toContain('LINKUP_API_KEY');
    });
});

describe('Exa request and normalization', () => {
    it('sends the documented request exactly', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'harness tools' });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe('https://api.exa.ai/search');
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('error');
        expect(init.headers).toEqual({
            'content-type': 'application/json',
            'x-api-key': 'exa-secret-key'
        });
        expect(JSON.parse(String(init.body))).toEqual({
            query: 'harness tools',
            type: 'auto',
            numResults: 5,
            contents: { highlights: true }
        });
    });

    it('normalizes results with joined highlights and a publication date', async () => {
        stubFetch(
            json({
                results: [
                    {
                        title: '  First   result ',
                        url: 'https://example.com/a',
                        highlights: ['one', 'two'],
                        publishedDate: '2026-01-02'
                    },
                    {
                        title: 'Second',
                        url: 'https://example.com/b',
                        highlights: []
                    }
                ]
            })
        );

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' });

        expect(result).toEqual({
            provider: 'exa',
            query: 'q',
            maxResults: 5,
            results: [
                {
                    title: 'First result',
                    url: 'https://example.com/a',
                    snippet: 'one two',
                    published: '2026-01-02'
                },
                {
                    title: 'Second',
                    url: 'https://example.com/b',
                    snippet: ''
                }
            ]
        });
    });

    it('drops rows without an http(s) URL and falls back to the URL as a title', async () => {
        stubFetch(
            json({
                results: [
                    { title: 'JS', url: 'javascript:alert(1)', highlights: ['x'] },
                    { title: 'Relative', url: '/somewhere', highlights: ['x'] },
                    { title: '', url: 'https://example.com/kept', highlights: ['x'] }
                ]
            })
        );

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' });

        expect(result.results).toEqual([
            { title: 'https://example.com/kept', url: 'https://example.com/kept', snippet: 'x' }
        ]);
    });

    it('redacts every configured key, including the other provider key', async () => {
        stubFetch(
            json({
                results: [
                    {
                        title: 'leak exa-secret-key',
                        url: 'https://example.com/exa-secret-key',
                        highlights: ['body exa-secret-key and tavily-secret-key'],
                        publishedDate: '2026-01-02'
                    }
                ]
            })
        );

        const result = await configured({
            EXA_API_KEY: 'exa-secret-key',
            TAVILY_API_KEY: 'tavily-secret-key'
        })({ query: 'q' });

        expect(result).toEqual({
            provider: 'exa',
            query: 'q',
            maxResults: 5,
            results: [
                {
                    title: 'leak [redacted]',
                    url: 'https://example.com/[redacted]',
                    snippet: 'body [redacted] and [redacted]',
                    published: '2026-01-02'
                }
            ]
        });

        expect(JSON.stringify(result)).not.toContain('exa-secret-key');
        expect(JSON.stringify(result)).not.toContain('tavily-secret-key');
    });

    it('redacts short configured keys instead of skipping them', async () => {
        stubFetch(
            json({
                results: [
                    {
                        title: 'keys k1 and t2',
                        url: 'https://example.com/k1?ref=t2',
                        highlights: ['k1 then t2'],
                        publishedDate: 'k1'
                    }
                ]
            })
        );

        const result = await configured({
            EXA_API_KEY: 'k1',
            TAVILY_API_KEY: 't2'
        })({ query: 'q' });

        // Both keys are shorter than any real provider credential. They must still
        // be replaced everywhere: a configured secret has no minimum length.
        expect(result).toEqual({
            provider: 'exa',
            query: 'q',
            maxResults: 5,
            results: [
                {
                    title: 'keys [redacted] and [redacted]',
                    url: 'https://example.com/[redacted]?ref=[redacted]',
                    snippet: '[redacted] then [redacted]',
                    published: '[redacted]'
                }
            ]
        });
    });
});

describe('Tavily request and normalization', () => {
    it('sends the documented request exactly', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        await configured({ TAVILY_API_KEY: 'tavily-secret-key' })({ query: 'harness tools', maxResults: 3 });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe('https://api.tavily.com/search');
        expect(init.headers).toEqual({
            'content-type': 'application/json',
            authorization: 'Bearer tavily-secret-key'
        });
        expect(JSON.parse(String(init.body))).toEqual({
            query: 'harness tools',
            max_results: 3,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false
        });
    });

    it('normalizes content and ignores score', async () => {
        stubFetch(
            json({
                results: [
                    {
                        title: 'Tavily result',
                        url: 'https://example.com/t',
                        content: '  a   snippet ',
                        score: 0.99,
                        published_date: '2026-03-04'
                    }
                ]
            })
        );

        const result = await configured({ TAVILY_API_KEY: 'tavily-secret-key' })({ query: 'q', maxResults: 1 });

        expect(result).toEqual({
            provider: 'tavily',
            query: 'q',
            maxResults: 1,
            results: [
                {
                    title: 'Tavily result',
                    url: 'https://example.com/t',
                    snippet: 'a snippet',
                    published: '2026-03-04'
                }
            ]
        });
    });

    it('honours an explicit provider override', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ EXA_API_KEY: 'exa-secret-key', TAVILY_API_KEY: 'tavily-secret-key' });

        await tool({ query: 'q', provider: 'tavily' });

        expect(fetchMock.mock.calls[0][0]).toBe('https://api.tavily.com/search');
    });
});

describe('Linkup request and normalization', () => {
    it('sends the documented request exactly', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        await configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'harness tools', maxResults: 3 });

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe('https://api.linkup.so/v1/search');
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('error');
        expect(init.headers).toEqual({
            'content-type': 'application/json',
            authorization: 'Bearer linkup-secret-key'
        });
        // `q` (not `query`), the cheap `fast` depth, and the structured result
        // type instead of Linkup's composed answer: pinned exactly, because the
        // provider default would otherwise be free to change underneath us.
        expect(JSON.parse(String(init.body))).toEqual({
            q: 'harness tools',
            depth: 'fast',
            outputType: 'searchResults',
            maxResults: 3
        });
    });

    it('maps name to title and content to snippet, and ignores type and favicon', async () => {
        stubFetch(
            json({
                results: [
                    {
                        type: 'text',
                        name: '  First   result ',
                        url: 'https://example.com/a',
                        content: '  a   snippet ',
                        favicon: 'https://example.com/favicon.ico'
                    },
                    { type: 'text', name: 'Second', url: 'https://example.com/b', content: '' }
                ]
            })
        );

        const result = await configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'q' });

        // Linkup sends no publication date, so `published` is absent rather than
        // an empty string: the shape stays the one every provider normalizes into.
        expect(result).toEqual({
            provider: 'linkup',
            query: 'q',
            maxResults: 5,
            results: [
                { title: 'First result', url: 'https://example.com/a', snippet: 'a snippet' },
                { title: 'Second', url: 'https://example.com/b', snippet: '' }
            ]
        });
    });

    it('drops rows without an http(s) URL and falls back to the URL as a title', async () => {
        stubFetch(
            json({
                results: [
                    { type: 'text', name: 'JS', url: 'javascript:alert(1)', content: 'x' },
                    { type: 'text', name: 'Relative', url: '/somewhere', content: 'x' },
                    { type: 'text', name: '', url: 'https://example.com/kept', content: 'x' }
                ]
            })
        );

        const result = await configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'q' });

        expect(result.results).toEqual([
            { title: 'https://example.com/kept', url: 'https://example.com/kept', snippet: 'x' }
        ]);
    });

    it('redacts every configured key, including the other provider keys', async () => {
        stubFetch(
            json({
                results: [
                    {
                        type: 'text',
                        name: 'leak linkup-secret-key',
                        url: 'https://example.com/linkup-secret-key',
                        content: 'body exa-secret-key and tavily-secret-key'
                    }
                ]
            })
        );

        const result = await configured({
            EXA_API_KEY: 'exa-secret-key',
            TAVILY_API_KEY: 'tavily-secret-key',
            LINKUP_API_KEY: 'linkup-secret-key'
        })({ query: 'q', provider: 'linkup' });

        expect(result).toEqual({
            provider: 'linkup',
            query: 'q',
            maxResults: 5,
            results: [
                {
                    title: 'leak [redacted]',
                    url: 'https://example.com/[redacted]',
                    snippet: 'body [redacted] and [redacted]'
                }
            ]
        });

        expect(JSON.stringify(result)).not.toContain('linkup-secret-key');
        expect(JSON.stringify(result)).not.toContain('exa-secret-key');
    });

    it('clamps the requested count into the provider body', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ LINKUP_API_KEY: 'linkup-secret-key' });

        expect((await tool({ query: 'q', maxResults: 500 })).maxResults).toBe(MAX_RESULTS_LIMIT);
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).maxResults).toBe(MAX_RESULTS_LIMIT);
    });

    it('maps auth, rate-limit, and server statuses without echoing the body', async () => {
        const cases: Array<{ status: number; message: string }> = [
            {
                status: 401,
                message: 'Linkup search rejected the API key (HTTP 401). Check the configured key and account.'
            },
            {
                status: 403,
                message: 'Linkup search rejected the API key (HTTP 403). Check the configured key and account.'
            },
            { status: 429, message: 'Linkup search is rate limited (HTTP 429). Try again later.' },
            { status: 500, message: 'Linkup search failed (HTTP 500).' }
        ];

        for (const { status, message } of cases) {
            stubFetch(new Response(`provider body with linkup-secret-key (${status})`, { status }));

            await expect(configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'q' })).rejects.toThrow(
                message
            );
        }
    });

    it('reports non-JSON and a missing results list', async () => {
        stubFetch(new Response('<html>not json</html>', { status: 200 }));

        await expect(configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'q' })).rejects.toThrow(
            'Linkup search returned a response that is not JSON.'
        );

        stubFetch(json({ ok: true }));

        await expect(configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'q' })).rejects.toThrow(
            'Linkup search returned a response without a "results" list.'
        );
    });

    it('reports a network failure as one fixed sentence', async () => {
        stubFetch(async () => {
            throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.linkup.so');
        });

        await expect(configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'q' })).rejects.toThrow(
            'Linkup search could not be reached (network error).'
        );
    });

    it('keeps the provider byte budget at 512 KiB, separate from the native fetch bound', async () => {
        // The search/provider TRANSFER cap is deliberately untouched by the fetch
        // tool's page budget (`MAX_RESPONSE_BYTES` in ../webfetch/request.ts, 1 MiB).
        // Pinning the constant here turns an accidental "consolidation" of the two
        // into a test failure. F15: the number this cap used to be compared against
        // in the comments (100 KiB) went stale when the fetch budget moved to 1 MiB;
        // the number that actually has to be read with it is the DELIVERABLE one
        // below, and the 16x ratio between them is the point.
        expect(MAX_RESPONSE_BYTES).toBe(512 * 1024);
        expect(MAX_SEARCH_RESULT_BYTES).toBe(32 * 1024);
        // The transfer cap is 16x the deliverable size: reading a provider answer is
        // not the same as being able to put it in front of a model.
        expect(MAX_RESPONSE_BYTES).toBe(16 * MAX_SEARCH_RESULT_BYTES);

        stubFetch(
            new Response('{}', {
                status: 200,
                headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
            })
        );

        await expect(configured({ LINKUP_API_KEY: 'linkup-secret-key' })({ query: 'q' })).rejects.toThrow(
            `Linkup search returned a response larger than ${MAX_RESPONSE_BYTES} bytes.`
        );
    });
});

describe('bounds', () => {
    it('clamps maxResults to 1–20 and reports the value actually requested', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        expect((await tool({ query: 'q', maxResults: 500 })).maxResults).toBe(MAX_RESULTS_LIMIT);
        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).numResults).toBe(MAX_RESULTS_LIMIT);

        expect((await tool({ query: 'q', maxResults: 0 })).maxResults).toBe(1);
        expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).numResults).toBe(1);

        expect((await tool({ query: 'q', maxResults: 2.9 })).maxResults).toBe(2);
        expect(JSON.parse(String(fetchMock.mock.calls[2][1].body)).numResults).toBe(2);
    });

    it('truncates titles and snippets and never exceeds the requested count', async () => {
        const many = Array.from({ length: 25 }, (_, index) => ({
            title: `${'t'.repeat(MAX_TITLE_CHARS + 50)}-${index}`,
            url: `https://example.com/${index}`,
            highlights: ['s'.repeat(MAX_SNIPPET_CHARS + 500)]
        }));

        stubFetch(json({ results: many }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 20 });

        expect(result.results).toHaveLength(20);
        expect(result.results[0].title).toHaveLength(MAX_TITLE_CHARS);
        expect(result.results[0].snippet).toHaveLength(MAX_SNIPPET_CHARS);
    });

    it('flags a snippet that was cut at the bound', async () => {
        // A cut snippet and a complete snippet were indistinguishable, and the
        // difference is exactly whether the caller should go and fetch the page.
        stubFetch(
            json({
                results: [
                    { title: 'long', url: 'https://example.com/a', highlights: ['s'.repeat(MAX_SNIPPET_CHARS + 500)] },
                    { title: 'short', url: 'https://example.com/b', highlights: ['whole thing'] }
                ]
            })
        );

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' });

        expect(result.results[0].snippetTruncated).toBe(true);
        // Absent, not false: an uncut result keeps its exact previous shape.
        expect(result.results[1].snippetTruncated).toBeUndefined();
    });

    it('rejects a malformed domain entry by name instead of taking a provider 400', async () => {
        // The provider answers a bad entry with a bare "HTTP 400" that names no
        // field, because the body is deliberately never surfaced (it can echo the
        // key). Validate locally and point at the entry.
        let requests = 0;
        stubFetch(async () => {
            requests += 1;
            return json({ results: [] });
        });
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(tool({ query: 'q', includeDomains: ['not a domain!!'] })).rejects.toThrow(
            /entry "not a domain!!" is not a domain/
        );
        expect(requests).toBe(0);

        // What the provider documents as valid must still pass: hostname, path
        // prefix, wildcard subdomain, and a scheme the caller left on by habit.
        await tool({ query: 'q', includeDomains: ['example.com', 'example.com/docs', '*.example.com'] });
        expect(requests).toBe(1);
    });

    it('redacts before truncation so no key prefix survives the boundary', async () => {
        // Each value is only a few characters shorter than its bound, so the
        // credential straddles the cut. Redacting after truncation (the old order)
        // left its first characters visible.
        const titlePrefix = 't'.repeat(MAX_TITLE_CHARS - 2);
        const snippetPrefix = 's'.repeat(MAX_SNIPPET_CHARS - 5);
        const publishedPrefix = 'd'.repeat(MAX_PUBLISHED_CHARS - 4);

        stubFetch(
            json({
                results: [
                    {
                        title: `${titlePrefix}exa-secret-key`,
                        url: 'https://example.com/page',
                        highlights: [`${snippetPrefix}exa-secret-key`],
                        publishedDate: `${publishedPrefix}exa-secret-key`
                    }
                ]
            })
        );

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' });

        // Exact expected strings: the redaction marker may itself be cut, but no
        // character of the key is present.
        expect(result.results).toEqual([
            {
                title: `${titlePrefix}[r`,
                url: 'https://example.com/page',
                snippet: `${snippetPrefix}[reda`,
                // This snippet straddles the bound by construction, so the new
                // truncation flag is expected here; the assertion below is the one
                // that matters for this test — no key characters survive the cut.
                snippetTruncated: true,
                published: `${publishedPrefix}[red`
            }
        ]);
        expect(JSON.stringify(result)).not.toContain('exa-secret-key');
    });

    it('drops URLs over the cap, URLs with userinfo, and URLs redaction pushes over the cap', async () => {
        // 'https://example.com/' is exactly 20 characters, so these are the exact
        // 2,048 and 2,049 boundaries.
        const atCap = `https://example.com/${'a'.repeat(MAX_URL_CHARS - 20)}`;
        const overCap = `${atCap}a`;
        // The key fits inside the cap raw, but redaction expands it by 8 characters
        // (2 -> 10), so the safe URL would exceed the cap: drop, do not truncate.
        const keyExpanded = `https://example.com/${'a'.repeat(MAX_URL_CHARS - 20 - 2)}k1`;

        stubFetch(
            json({
                results: [
                    { title: 'kept', url: atCap, highlights: ['x'] },
                    { title: 'too long', url: overCap, highlights: ['x'] },
                    { title: 'userinfo', url: 'https://user:pass@example.com/x', highlights: ['x'] },
                    { title: 'expanded', url: keyExpanded, highlights: ['x'] }
                ]
            })
        );

        const result = await configured({ EXA_API_KEY: 'k1' })({ query: 'q' });

        expect(result.results).toEqual([{ title: 'kept', url: atCap, snippet: 'x' }]);
    });
});

describe('validation', () => {
    it('rejects a blank or non-string query', async () => {
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(tool({ query: '   ' })).rejects.toThrow('search requires a non-empty query string.');
        await expect(tool({ query: 42 as never })).rejects.toThrow('search requires a non-empty query string.');
    });

    it('accepts a bare query string from a direct caller', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' }) as unknown as (
            parameters: string
        ) => Promise<WebSearchResult>;

        await tool('bare');

        expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).query).toBe('bare');
    });

    it('rejects a non-numeric result count', async () => {
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(tool({ query: 'q', maxResults: 'ten' as never })).rejects.toThrow(
            'search maxResults must be a number between 1 and 20.'
        );
    });

    it('rejects a provider that is not configured', async () => {
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(tool({ query: 'q', provider: 'tavily' })).rejects.toThrow(
            'search provider "tavily" is not configured. Configured: exa.'
        );
    });

    it('names the configured alternatives when Linkup is missing or another provider is', async () => {
        // Linkup is a real provider, so the refusal has to name it in the same
        // vocabulary and list what this harness can call.
        const onlyExa = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(onlyExa({ query: 'q', provider: 'linkup' })).rejects.toThrow(
            'search provider "linkup" is not configured. Configured: exa.'
        );

        const exaAndLinkup = configured({ EXA_API_KEY: 'exa-secret-key', LINKUP_API_KEY: 'linkup-secret-key' });

        await expect(exaAndLinkup({ query: 'q', provider: 'tavily' })).rejects.toThrow(
            'search provider "tavily" is not configured. Configured: exa, linkup.'
        );
    });
});

describe('failures', () => {
    it('maps auth, quota, rate-limit, and server statuses without echoing the body', async () => {
        const cases: Array<{ status: number; message: string }> = [
            {
                status: 401,
                message: 'Exa search rejected the API key (HTTP 401). Check the configured key and account.'
            },
            {
                status: 402,
                message: 'Exa search reports no remaining credits or quota (HTTP 402). Check the provider account.'
            },
            { status: 429, message: 'Exa search is rate limited (HTTP 429). Try again later.' },
            { status: 500, message: 'Exa search failed (HTTP 500).' }
        ];

        for (const { status, message } of cases) {
            stubFetch(new Response(`provider body with exa-secret-key (${status})`, { status }));

            const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

            await expect(tool({ query: 'q' })).rejects.toThrow(message);
        }
    });

    it('maps Tavily quota codes', async () => {
        stubFetch(new Response('quota', { status: 432 }));

        await expect(configured({ TAVILY_API_KEY: 'tavily-secret-key' })({ query: 'q' })).rejects.toThrow(
            'Tavily search reports no remaining credits or quota (HTTP 432). Check the provider account.'
        );
    });

    it('reports non-JSON and shapeless bodies', async () => {
        stubFetch(new Response('<html>not json</html>', { status: 200 }));

        await expect(configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' })).rejects.toThrow(
            'Exa search returned a response that is not JSON.'
        );

        stubFetch(json({ ok: true }));

        await expect(configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' })).rejects.toThrow(
            'Exa search returned a response without a "results" list.'
        );
    });

    it('reports a network failure as one fixed sentence', async () => {
        stubFetch(async () => {
            throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.exa.ai');
        });

        await expect(configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' })).rejects.toThrow(
            'Exa search could not be reached (network error).'
        );
    });

    it('rejects an oversized declared response before reading it', async () => {
        stubFetch(
            new Response('{}', {
                status: 200,
                headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) }
            })
        );

        await expect(configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' })).rejects.toThrow(
            `Exa search returned a response larger than ${MAX_RESPONSE_BYTES} bytes.`
        );
    });

    it('stops a streamed response at the byte budget without a content-length header', async () => {
        let cancelled = false;

        // Two chunks: exactly the budget, then one byte over. There is no
        // content-length, so only the per-chunk counter can catch this.
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
                controller.enqueue(new Uint8Array(1));
            },
            cancel() {
                cancelled = true;
            }
        });

        stubFetch(async () => new Response(stream, { status: 200 }));

        await expect(configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' })).rejects.toThrow(
            `Exa search returned a response larger than ${MAX_RESPONSE_BYTES} bytes.`
        );

        // The reader was cancelled: a provider must not keep sending after the cap.
        expect(cancelled).toBe(true);
    });

    it('aborts after the 15 s budget and clears the timer', async () => {
        vi.useFakeTimers();

        stubFetch(
            async (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    });
                })
        );

        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });
        const failure = tool({ query: 'q' }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS);

        // Awaited, not fire-and-forget: an unawaited `.resolves` assertion is only
        // passing because vitest auto-awaits hanging assertions today, and it fails
        // outright on the next major.
        await expect(failure).resolves.toMatchObject({
            message: `Exa search timed out after ${SEARCH_TIMEOUT_MS} ms.`
        });

        // The finally block cleared the controller's timer.
        expect(vi.getTimerCount()).toBe(0);
    });
});

// The filters are the reason a search tool is cheaper than a search plus a
// post-filter in the model's context, so both halves are pinned: what goes on
// the wire, and what comes back to the caller.
describe('provider filters', () => {
    const rows = json({
        results: [{ title: 'A', url: 'https://example.com/a', highlights: ['one'] }]
    });

    // Runs a call that must be refused and hands back the WHOLE message, so the
    // combination assertions below can pin "names the category, the filter and
    // what to drop" exactly instead of matching a fragment of it.
    const refusalMessage = async (parameters: WebSearchParameters): Promise<string> => {
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        try {
            await tool(parameters);
        } catch (error) {
            return (error as Error).message;
        }

        throw new Error(`Expected a refusal for ${JSON.stringify(parameters)}.`);
    };

    it('sends the domain, date and category filters Exa documents', async () => {
        const fetchMock = stubFetch(rows);
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await tool({
            query: 'q',
            includeDomains: ['https://docs.example.com/', 'A.com'],
            excludeDomains: ['forum.example'],
            since: '2026-01-01',
            until: '2026-06-30',
            category: 'News'
        });

        const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;

        // Normalized: scheme stripped, trailing slash dropped, case folded.
        expect(body.includeDomains).toEqual(['docs.example.com', 'a.com']);
        expect(body.excludeDomains).toEqual(['forum.example']);
        expect(body.startPublishedDate).toBe('2026-01-01');
        expect(body.endPublishedDate).toBe('2026-06-30');
        expect(body.category).toBe('news');
        // Balanced is the default and keeps Exa's own mode.
        expect(body.type).toBe('auto');
    });

    it('sends no filter keys at all when none were asked for', async () => {
        // An absent key and an empty array are different requests to a provider,
        // so the adapter must omit rather than send blanks.
        const fetchMock = stubFetch(rows);
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await tool({ query: 'q' });

        const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;

        expect(Object.keys(body)).toEqual(['query', 'type', 'numResults', 'contents']);
    });

    it('maps speed to Exa lite mode', async () => {
        const fetchMock = stubFetch(rows);
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        const result = await tool({ query: 'q', speed: 'fast' });

        const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;
        expect(body.type).toBe('lite');
        // The applied filter is echoed so an empty result set is interpretable.
        expect(result.speed).toBe('fast');
    });

    it('maps the filters onto Tavily field names', async () => {
        const fetchMock = stubFetch(
            json({ results: [{ title: 'A', url: 'https://example.com/a', content: 'one' }] })
        );
        const tool = configured({ TAVILY_API_KEY: 'tavily-secret-key' });

        await tool({ query: 'q', includeDomains: ['example.com'], since: '2026-01-01' });

        const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;

        expect(body.include_domains).toEqual(['example.com']);
        expect(body.start_date).toBe('2026-01-01');
        expect(body.includeDomains).toBeUndefined();
    });

    it('rejects a malformed filter before paying for the request', async () => {
        // A 400 from the provider would arrive as an opaque "Exa search failed";
        // validating here names the argument instead.
        let requests = 0;

        stubFetch(async () => {
            requests += 1;

            return rows;
        });

        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(tool({ query: 'q', since: 'last tuesday' })).rejects.toThrow(/ISO-8601 date/);
        await expect(tool({ query: 'q', since: '2026-06-01', until: '2026-01-01' })).rejects.toThrow(
            /must not be earlier than/
        );
        await expect(tool({ query: 'q', includeDomains: [] })).rejects.toThrow(/array of 1-20 domains/);
        // `speed: 'turbo'` is DELIBERATELY not a valid value (the parameter union is
        // `balanced | fast`) — the `as never` keeps the intentional invalidity the
        // validator is being pinned against, same spelling as the `maxResults: 'ten'`
        // case above.
        await expect(tool({ query: 'q', speed: 'turbo' as never })).rejects.toThrow(/"balanced" or "fast"/);
        expect(requests).toBe(0);
    });

    it('refuses a category the provider cannot combine with a filter, before paying for the request', async () => {
        // The description already names these pairs; accepting them locally
        // spent a provider round trip and came back as the opaque
        // "Exa search failed (HTTP 400).", which names neither the field nor the
        // fix because the response body is never surfaced (it can echo the key).
        let requests = 0;

        stubFetch(async () => {
            requests += 1;

            return rows.clone();
        });

        const peopleDate =
            'search category "people" does not support date filters. Drop "since"/"until", or use another category.';
        const companyDate =
            'search category "company" does not support date filters. Drop "since"/"until", or use another category.';

        // Both date filters are covered on purpose: pinning only `since` leaves
        // the defect half-fixed.
        expect(await refusalMessage({ query: 'q', category: 'people', since: '2026-01-01' })).toBe(peopleDate);
        expect(await refusalMessage({ query: 'q', category: 'people', until: '2026-06-30' })).toBe(peopleDate);
        expect(await refusalMessage({ query: 'q', category: 'company', since: '2026-01-01' })).toBe(companyDate);
        expect(await refusalMessage({ query: 'q', category: 'company', until: '2026-06-30' })).toBe(companyDate);
        expect(await refusalMessage({ query: 'q', category: 'people', excludeDomains: ['forum.example'] })).toBe(
            'search category "people" does not support "excludeDomains". Drop the category or the domain filter.'
        );
        // readCategory case-folds, so the guard fires whatever casing the caller sent.
        expect(await refusalMessage({ query: 'q', category: 'People', since: '2026-01-01' })).toBe(peopleDate);

        // The local guarantee, proven rather than assumed: the provider never saw
        // any of the six calls above.
        expect(requests).toBe(0);
    });

    it('keeps a precise field error ahead of a combination error', async () => {
        // Every call below is also a `people` + filter combination, so only these
        // calls can show that the per-field validators still run first — the
        // ordering the fix depends on, including `excludeDomains: []` keeping its
        // own error instead of reaching the combination check as a defined filter.
        let requests = 0;

        stubFetch(async () => {
            requests += 1;

            return rows.clone();
        });

        expect(await refusalMessage({ query: 'q', category: 'people', excludeDomains: [] })).toBe(
            'search excludeDomains must be an array of 1-20 domains.'
        );
        expect(await refusalMessage({ query: 'q', category: 'people', since: 'last tuesday' })).toBe(
            'search since must be an ISO-8601 date, for example "2026-01-01".'
        );
        expect(
            await refusalMessage({ query: 'q', category: 'people', since: '2026-06-01', until: '2026-01-01' })
        ).toBe('search "until" must not be earlier than "since".');
        // Deliberate invalid value again (see the `speed: 'turbo' as never` above): this
        // case proves the PER-FIELD error wins over the combination error, so the value
        // must be invalid on its own terms while the call stays otherwise well-formed.
        expect(await refusalMessage({ query: 'q', category: 'people', speed: 'turbo' as never })).toBe(
            'search speed must be "balanced" or "fast".'
        );
        expect(requests).toBe(0);
    });

    it('still accepts the category and filter pairs the provider accepts', async () => {
        // Guards against over-rejection. These four pairs were verified working
        // against the live provider, so each must still resolve — and still send
        // its filter, since silently dropping the filter was the rejected
        // alternative (it returns results the caller believes are filtered).
        const fetchMock = stubFetch(rows);
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        const people = await tool({ query: 'q', category: 'people' });
        const company = await tool({ query: 'q', category: 'company' });
        const companyDomains = await tool({ query: 'q', category: 'company', excludeDomains: ['forum.example'] });
        const newsSince = await tool({ query: 'q', category: 'news', since: '2026-01-01' });

        expect(people.category).toBe('people');
        expect(people.since).toBeUndefined();
        expect(company.category).toBe('company');
        expect(companyDomains.category).toBe('company');
        expect(companyDomains.excludeDomains).toEqual(['forum.example']);
        expect(newsSince.category).toBe('news');
        expect(newsSince.since).toBe('2026-01-01');

        const bodies = fetchMock.mock.calls.map(
            (call) => JSON.parse(String(call[1].body)) as Record<string, unknown>
        );

        expect(bodies.map((body) => body.category)).toEqual(['people', 'company', 'company', 'news']);
        expect(bodies.map((body) => body.excludeDomains)).toEqual([
            undefined,
            undefined,
            ['forum.example'],
            undefined
        ]);
        expect(bodies.map((body) => body.startPublishedDate)).toEqual([
            undefined,
            undefined,
            undefined,
            '2026-01-01'
        ]);
    });

    it('echoes the applied filters in the result', async () => {
        stubFetch(rows);
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        const result = await tool({ query: 'q', includeDomains: ['example.com'], category: 'news' });

        expect(result.includeDomains).toEqual(['example.com']);
        expect(result.category).toBe('news');
        // Filters that were not used stay absent, so the result does not grow.
        expect(result.since).toBeUndefined();
        expect(result.speed).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// F2 — the delivery fit
// ---------------------------------------------------------------------------
//
// The harness caps ONE tool result at `MODEL_TOOL_RESULT_BUDGET_BYTES` (32,768) of
// JSON-escaped payload, and an oversized JSON DOCUMENT is REFUSED, not cut: core/result-
// budget.ts `boundToolResult` answers `rejected: { reason: 'oversized-json' }` and
// harness.ts reports the call as failed. `search` bounded only what it READ (512 KiB),
// never what it delivered, so every shape the per-row caps allow could lose the whole
// answer. These tests go through the harness's own helper (`boundToolResult`), not a
// byte total, because the contract is "the harness cannot refuse this".
describe('delivery fit (F2)', () => {
    // ~1,000-character URLs behind 1,000-character snippets: measured 41,650 payload
    // bytes with all 20 rows present.
    const fatUrl = (index: number): string => `https://example.com/${'u'.repeat(970)}${index}`;

    const fatRows = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
            title: `Title${index}`,
            url: fatUrl(index),
            highlights: ['x'.repeat(MAX_SNIPPET_CHARS)]
        }));

    // The normalized form of those rows. A row that survives the fit is byte-for-byte
    // what normalization produced, which is what makes the equality below exact.
    const fatMatches = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
            title: `Title${index}`,
            url: fatUrl(index),
            snippet: 'x'.repeat(MAX_SNIPPET_CHARS)
        }));

    it('delivers twenty 1,000-character rows instead of losing them to a refusal', async () => {
        stubFetch(json({ results: fatRows(20) }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 20 });

        // The pre-fit shape IS the defect, proven rather than asserted as a number:
        // the same fields with every row present are refused outright.
        expect(
            boundToolResult(
                JSON.stringify({ provider: 'exa', query: 'q', maxResults: 20, results: fatMatches(20) }),
                MODEL_TOOL_RESULT_BUDGET_BYTES,
                { source: { name: 'search' } }
            ).rejected?.reason
        ).toBe('oversized-json');

        // What the caller gets instead: the provider's PREFIX, flagged, deliverable.
        expect(deliverable(result).rejected).toBeUndefined();
        expect(result.results).toEqual(fatMatches(15));
        expect(result.resultsTruncated).toBe(true);
        expect(result.note).toBe(
            '5 of 20 result rows were omitted to fit the 32768-byte result budget. Narrow the query or lower maxResults for more per-row detail.'
        );
        // `droppedResults` is the OTHER cause (unusable provider rows, F5). A size
        // trim must never set it: conflating the two would hide junk rows behind a
        // truncation flag and vice versa.
        expect(result.droppedResults).toBeUndefined();
    });

    it('delivers the worst-case shape: 300-character titles, 2,048-character URLs, 1,000-character snippets', async () => {
        // Every per-row cap at once — 300-char title, 2,048-char URL, 1,000-char
        // snippet — the shape measured at 67,970 payload bytes before the fit.
        const worstUrl = (index: number): string => `https://example.com/${'u'.repeat(2_020)}${index}`;
        const worstTitle = (index: number): string => `${'T'.repeat(290)}${index}`;

        stubFetch(
            json({
                results: Array.from({ length: 20 }, (_, index) => ({
                    title: worstTitle(index),
                    url: worstUrl(index),
                    highlights: ['x'.repeat(MAX_SNIPPET_CHARS)]
                }))
            })
        );

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 20 });

        expect(
            boundToolResult(
                JSON.stringify({
                    provider: 'exa',
                    query: 'q',
                    maxResults: 20,
                    results: Array.from({ length: 20 }, (_, index) => ({
                        title: worstTitle(index),
                        url: worstUrl(index),
                        snippet: 'x'.repeat(MAX_SNIPPET_CHARS)
                    }))
                }),
                MODEL_TOOL_RESULT_BUDGET_BYTES,
                { source: { name: 'search' } }
            ).rejected?.reason
        ).toBe('oversized-json');

        expect(deliverable(result).rejected).toBeUndefined();
        expect(result.results).toEqual(
            Array.from({ length: 9 }, (_, index) => ({
                title: worstTitle(index),
                url: worstUrl(index),
                snippet: 'x'.repeat(MAX_SNIPPET_CHARS)
            }))
        );
        expect(result.resultsTruncated).toBe(true);
        expect(result.note).toBe(
            '11 of 20 result rows were omitted to fit the 32768-byte result budget. Narrow the query or lower maxResults for more per-row detail.'
        );
    });

    it('leaves a default result whole, with no fit fields at all', async () => {
        stubFetch(json({ results: fatRows(5) }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q' });

        // Absent, not false/0: the shape a caller saw before this bound existed is the
        // shape it sees for any result that fits.
        expect(result.results).toHaveLength(5);
        expect(result.resultsTruncated).toBeUndefined();
        expect(result.droppedResults).toBeUndefined();
        expect(result.note).toBeUndefined();
        expect(deliverable(result).rejected).toBeUndefined();
        expect(deliverable(result).truncated).toBe(false);
    });

    it('drops rows WHOLE so a redacted credential is never split by the trim', async () => {
        // The redaction-order property (redact-then-bound) has to survive the fit. It
        // does, structurally: the fit runs last, on already-redacted fields, and it
        // removes whole rows. Every row below carries the configured key in BOTH the
        // URL and the snippet, and the list is over budget, so rows must go.
        const keyUrl = (index: number): string =>
            `https://example.com/${'u'.repeat(960)}exa-secret-key${index}`;

        stubFetch(
            json({
                results: Array.from({ length: 20 }, (_, index) => ({
                    title: `Row ${index}`,
                    url: keyUrl(index),
                    // 500 + 14 + 486 = 1,000 characters raw, so the key sits inside
                    // the snippet bound rather than at its edge.
                    highlights: [`${'x'.repeat(500)}exa-secret-key${'y'.repeat(486)}`]
                }))
            })
        );

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 20 });

        expect(result.results).toEqual(
            Array.from({ length: 15 }, (_, index) => ({
                title: `Row ${index}`,
                url: `https://example.com/${'u'.repeat(960)}[redacted]${index}`,
                snippet: `${'x'.repeat(500)}[redacted]${'y'.repeat(486)}`
            }))
        );

        const text = JSON.stringify(result);
        expect(text).not.toContain('exa-secret-key');
        // Two COMPLETE markers per surviving row. A marker cut at a boundary
        // (`[redac`) would not split on the full marker, so this exact count is the
        // proof that no row was half-delivered.
        expect(text.split('[redacted]')).toHaveLength(31);
        expect(deliverable(result).rejected).toBeUndefined();
        expect(result.resultsTruncated).toBe(true);
    });

    it('keeps the size trim and the unusable-row count as separate facts', async () => {
        stubFetch(
            json({
                results: [
                    ...Array.from({ length: 5 }, (_, index) => ({
                        title: `junk${index}`,
                        url: 'javascript:alert(1)',
                        highlights: ['junk']
                    })),
                    ...fatRows(20)
                ]
            })
        );

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 20 });

        expect(result.droppedResults).toBe(5);
        expect(result.resultsTruncated).toBe(true);
        expect(result.results).toEqual(fatMatches(15));
        // The "provider returned unusable rows" sentence is for an EMPTY result; here
        // the caller still got 15 rows, so only the size note is stated.
        expect(result.note).toBe(
            '5 of 20 result rows were omitted to fit the 32768-byte result budget. Narrow the query or lower maxResults for more per-row detail.'
        );
    });

    it('keeps the echoed filters after trimming', async () => {
        stubFetch(json({ results: fatRows(20) }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({
            query: 'q',
            maxResults: 20,
            includeDomains: ['example.com'],
            speed: 'fast'
        });

        // `render` spreads the ORIGINAL result, so an echoed filter is still there —
        // and its bytes were part of every measurement the trim made.
        expect(result.includeDomains).toEqual(['example.com']);
        expect(result.speed).toBe('fast');
        expect(result.results).toHaveLength(15);
        expect(deliverable(result).rejected).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// F5 — unusable provider rows no longer consume the requested slots
// ---------------------------------------------------------------------------
describe('unusable provider rows (F5)', () => {
    const good = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
            title: `good${index}`,
            url: `https://example.com/good${index}`,
            highlights: ['good']
        }));

    const goodMatches = (count: number, offset = 0) =>
        Array.from({ length: count }, (_, index) => ({
            title: `good${index + offset}`,
            url: `https://example.com/good${index + offset}`,
            snippet: 'good'
        }));

    // Half the junk has a non-http URL, half has none at all: both are "the provider
    // sent a row this tool cannot show".
    const junk = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
            title: `bad${index}`,
            url: index % 2 === 0 ? `ftp://example.com/${index}` : undefined,
            highlights: ['bad']
        }));

    it('fills the request past five invalid rows instead of returning nothing', async () => {
        // The measured shape that used to answer `results: []`: five unusable rows
        // ahead of fifteen good ones, with `maxResults: 5`.
        stubFetch(json({ results: [...junk(5), ...good(15)] }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 5 });

        expect(result.results).toEqual(goodMatches(5));
        expect(result.droppedResults).toBe(5);
        expect(result.note).toBeUndefined();
    });

    it('fills the request past four rows with no url at all', async () => {
        stubFetch(json({ results: [...junk(4), ...good(6)] }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 4 });

        expect(result.results).toEqual(goodMatches(4));
        expect(result.droppedResults).toBe(4);
    });

    it('returns one valid row where it used to return one after four bad rows', async () => {
        stubFetch(json({ results: [...junk(4), ...good(15)] }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 5 });

        // Before: 1 row. The old slice took the first 5 provider rows, of which 4 were
        // junk. Now: 5 valid rows, and the junk is counted rather than invisible.
        expect(result.results).toEqual(goodMatches(5));
        expect(result.droppedResults).toBe(4);
    });

    it('returns all fifteen valid rows when the request leaves room for them', async () => {
        stubFetch(json({ results: [...junk(5), ...good(15)] }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 20 });

        expect(result.results).toEqual(goodMatches(15));
        expect(result.droppedResults).toBe(5);
    });

    it('counts only the rows it examined, not the ones it did not need', async () => {
        // The loop stops at `maxResults` VALID rows. Rows behind that line were not
        // rejected — they were not requested — so they must not inflate the count.
        stubFetch(json({ results: [...junk(1), ...good(10)] }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 2 });

        expect(result.results).toEqual(goodMatches(2));
        expect(result.droppedResults).toBe(1);
    });

    it('says so when every row the provider sent was unusable', async () => {
        stubFetch(json({ results: junk(3) }));

        const result = await configured({ EXA_API_KEY: 'exa-secret-key' })({ query: 'q', maxResults: 5 });

        expect(result.results).toEqual([]);
        expect(result.droppedResults).toBe(3);
        // The whole point of the count: an empty result after a provider answered is a
        // different situation from an empty index, and the caller can only act on the
        // difference if the result states it.
        expect(result.note).toBe(
            'Exa returned 3 result rows with no usable http(s) URL, so none of them could be shown. The provider did answer: the query is not necessarily at fault.'
        );
    });
});

// ---------------------------------------------------------------------------
// F11 — the category combination rules belong to the provider that has them
// ---------------------------------------------------------------------------
describe('provider-gated category rules (F11)', () => {
    it('accepts a category alongside a date filter on the provider that has no category field', async () => {
        const fetchMock = stubFetch(
            json({ results: [{ title: 'A', url: 'https://example.com/a', content: 'one' }] })
        );
        const tool = configured({ TAVILY_API_KEY: 'tavily-secret-key' });

        const result = await tool({ query: 'q', category: 'company', since: '2026-01-01' });

        const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as Record<string, unknown>;

        // Tavily honours the date window and has no category field, so the filter that
        // works is sent and the one that does not exist is dropped.
        expect(body.start_date).toBe('2026-01-01');
        expect('category' in body).toBe(false);
        // The argument is echoed as the one the CALLER asked for.
        expect(result.category).toBe('company');
    });

    it('gates on the resolved provider, not on what the harness can reach', async () => {
        const fetchMock = stubFetch(json({ results: [] }));
        const tool = configured({ EXA_API_KEY: 'exa-secret-key', TAVILY_API_KEY: 'tavily-secret-key' });

        // One harness, two providers, opposite answers — the rule follows the provider
        // this call actually resolves to.
        await expect(
            tool({ query: 'q', provider: 'tavily', category: 'company', since: '2026-01-01' })
        ).resolves.toMatchObject({ provider: 'tavily' });

        await expect(
            tool({ query: 'q', provider: 'exa', category: 'company', since: '2026-01-01' })
        ).rejects.toThrow(
            'search category "company" does not support date filters. Drop "since"/"until", or use another category.'
        );

        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['https://api.tavily.com/search']);
    });

    it('accepts the people combinations on Linkup, which receives none of those filters', async () => {
        const fetchMock = stubFetch(
            json({ results: [{ type: 'text', name: 'A', url: 'https://example.com/a', content: 'one' }] })
        );
        const tool = configured({ LINKUP_API_KEY: 'linkup-secret-key' });

        const result = await tool({
            query: 'q',
            category: 'people',
            since: '2026-01-01',
            excludeDomains: ['forum.example']
        });

        // Linkup's endpoint takes no category, no date window and no domain filter, so
        // refusing this call would reject arguments the provider never saw.
        expect(Object.keys(JSON.parse(String(fetchMock.mock.calls[0][1].body)))).toEqual([
            'q',
            'depth',
            'outputType',
            'maxResults'
        ]);
        expect(result.category).toBe('people');
    });

    it('states the category warning only for a provider that enforces it', () => {
        const exaOnly = configured({ EXA_API_KEY: 'exa-secret-key' });
        const tavilyOnly = configured({ TAVILY_API_KEY: 'tavily-secret-key' });

        expect(JSON.stringify(exaOnly.parameters)).toContain('do not support date filters');
        expect(JSON.stringify(tavilyOnly.parameters)).not.toContain('date filters');
    });
});

// ---------------------------------------------------------------------------
// F10 — the caller's cancellation signal reaches the provider request
// ---------------------------------------------------------------------------
describe('caller cancellation (F10)', () => {
    // A stub with real transport behaviour: it waits, and rejects with an AbortError
    // only when the signal it was handed fires. A stub that ignored `init.signal`
    // would pass this suite while the tool still could not be cancelled.
    //
    // `inFlight` settles when the provider request is ENTERED. Waiting on it is what
    // makes the abort land mid-request: the tool's own controller is created after a
    // couple of microtasks (`await import()` for the adapter), so aborting the caller
    // signal on the next line would cancel before the request existed, and the case
    // under test would be "already cancelled" instead of "cancelled in flight".
    const hangingFetch = (): { fetchMock: ReturnType<typeof stubFetch>; inFlight: Promise<void> } => {
        let enter: () => void = () => {
            // Replaced below; a no-op so the promise is only ever settled by a request.
        };

        const inFlight = new Promise<void>((resolve) => {
            enter = resolve;
        });

        const fetchMock = stubFetch(
            (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    const abort = (): void => {
                        const error = new Error('The operation was aborted.');
                        error.name = 'AbortError';
                        reject(error);
                    };

                    // A signal that had already fired when `fetch` was entered never
                    // dispatches another event, so it rejects on the spot — which is
                    // also what a real transport does.
                    if (init.signal?.aborted === true) abort();
                    else init.signal?.addEventListener('abort', abort);

                    enter();
                })
        );

        return { fetchMock, inFlight };
    };

    it('stops an in-flight search when the caller signal aborts', async () => {
        const { fetchMock, inFlight } = hangingFetch();
        const controller = new AbortController();
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        const pending = tool.execute({ parameters: { query: 'q' }, signal: controller.signal });

        // The request is in flight before the cancel lands.
        await inFlight;
        const reason = new Error('toolCancel: search stopped by the host');
        controller.abort(reason);

        // The caller's OWN reason comes back, not "Exa search could not be reached
        // (network error)." — the harness classifies a cancellation as cancelled, and a
        // provider-shaped message would blame the wrong party.
        await expect(pending).rejects.toBe(reason);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('aborts the request before the network when the signal has already fired', async () => {
        const abortedBeforeFetch: boolean[] = [];

        stubFetch(async (_url, init) => {
            abortedBeforeFetch.push(init.signal?.aborted === true);

            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            throw error;
        });

        const controller = new AbortController();
        controller.abort(new Error('already cancelled'));
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(
            tool.execute({ parameters: { query: 'q' }, signal: controller.signal })
        ).rejects.toThrow('already cancelled');

        // The linked controller was already aborted at the moment `fetch` was entered,
        // so nothing is paid for on a cancelled call.
        expect(abortedBeforeFetch).toEqual([true]);
    });

    it('still reports its own timeout when the caller signal never fires', async () => {
        // The reason the deadline keeps its own flag: with a caller signal linked in,
        // `controller.signal.aborted` is true for BOTH causes, and only the flag can
        // tell a timeout from a cancellation.
        vi.useFakeTimers();
        const { inFlight } = hangingFetch();

        const controller = new AbortController();
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        const failure = tool
            .execute({ parameters: { query: 'q' }, signal: controller.signal })
            .catch((error: unknown) => error);

        await inFlight;
        await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS);

        await expect(failure).resolves.toMatchObject({
            message: `Exa search timed out after ${SEARCH_TIMEOUT_MS} ms.`
        });
        expect(controller.signal.aborted).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// F2 — the last-resort clip, pinned at the helper level
// ---------------------------------------------------------------------------
//
// The clip branch is UNREACHABLE through the tool at today's per-row caps: one row can
// hold at most 300 + 2,048 + 1,000 characters (~3.4 KB of escaped payload), so the
// row-drop loop always finds a fitting prefix first. It is pinned here, where the
// budget is a parameter, because the property it exists for — "never emit a result the
// harness would refuse" — is the one that must survive a future per-row cap change.
describe('the last-resort snippet clip (F2)', () => {
    type Row = { title: string; url: string; snippet: string; snippetTruncated?: boolean };

    const measure = (candidate: readonly Row[]): number => modelPayloadBytes(JSON.stringify(candidate));

    it('keeps the largest snippet prefix that fits, counted in escaped bytes', () => {
        const rows: Row[] = [
            { title: 'A', url: 'https://example.com/a', snippet: 'x'.repeat(1_000) },
            { title: 'B', url: 'https://example.com/b', snippet: 'y'.repeat(1_000) }
        ];

        // One row's skeleton (title + URL + empty snippet, array brackets included) is
        // 70 payload bytes and `snippetTruncated` costs 26 more, so a budget of 500
        // over the skeleton buys exactly 474 characters. The bisection measures the row
        // WITH the flag; without that it would land 26 bytes over and drop the row.
        const skeleton = measure([{ ...rows[0], snippet: '' }]);
        const flagBytes = measure([{ ...rows[0], snippet: '', snippetTruncated: true }]) - skeleton;

        expect(skeleton).toBe(70);
        expect(flagBytes).toBe(26);

        const fitted = fitRowsToResultBudget(rows, measure, skeleton + 500);

        expect(fitted).toEqual({
            rows: [
                {
                    title: 'A',
                    url: 'https://example.com/a',
                    snippet: 'x'.repeat(474),
                    snippetTruncated: true
                }
            ],
            truncated: true,
            clipped: true
        });
        // Exactly the budget, and one character more would exceed it: the clip is the
        // largest fitting prefix, not a guess.
        expect(measure(fitted.rows)).toBe(skeleton + 500);
        expect(measure([{ ...fitted.rows[0], snippet: `${fitted.rows[0].snippet}x` }])).toBe(
            skeleton + 501
        );
    });

    it('never cuts between the halves of an emoji pair', () => {
        const rows: Row[] = [
            {
                title: 'A',
                url: 'https://example.com/a',
                snippet: `${'a'.repeat(499)}\u{1F44D}${'z'.repeat(1_000)}`
            }
        ];

        const skeleton = measure([{ ...rows[0], snippet: '' }]);

        expect(skeleton).toBe(70);

        // 526 bytes over the skeleton fits 499 'a' characters plus the 26-byte flag
        // (595 of 596) but not the pair, which costs 4 bytes on top of the 499. The raw
        // 500-unit cut would land between the halves, so the prefix comes back 499 long.
        const fitted = fitRowsToResultBudget(rows, measure, skeleton + 526);

        expect(fitted.rows).toEqual([
            {
                title: 'A',
                url: 'https://example.com/a',
                snippet: 'a'.repeat(499),
                snippetTruncated: true
            }
        ]);
        expect(measure(fitted.rows)).toBe(595);
    });

    it('drops the row when its title and URL alone are over budget', () => {
        const rows: Row[] = [
            { title: 'T'.repeat(300), url: 'https://example.com/a', snippet: 'x'.repeat(100) }
        ];

        const skeleton = measure([{ ...rows[0], snippet: '' }]);

        expect(skeleton).toBe(369);

        // An empty excerpt cannot help: everything that remains is over budget, and an
        // empty result beats a result the harness refuses.
        expect(fitRowsToResultBudget(rows, measure, skeleton - 1)).toEqual({
            rows: [],
            truncated: true,
            clipped: true
        });
    });

    it('leaves a fitting list untouched', () => {
        const rows: Row[] = [{ title: 'A', url: 'https://example.com/a', snippet: 'short' }];

        expect(fitRowsToResultBudget(rows, measure, MAX_SEARCH_RESULT_BYTES)).toEqual({
            rows: [{ title: 'A', url: 'https://example.com/a', snippet: 'short' }],
            truncated: false,
            clipped: false
        });
    });
});
