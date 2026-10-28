// websearch — the tool factory, key resolution, and both adapters.
//
// Everything here is offline and deterministic: the environment is injected
// (`env`), fetch is a stub (`vi.stubGlobal`), and no host key or network is read.
// The tests pin the exact wire request (URL, header, JSON body) and the exact
// normalized result, because the contract with two third-party providers is
// exactly where silent drift is expensive.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebSearchTool } from '@underload/harness';
import type { Tool, WebsearchConfiguration, WebSearchParameters, WebSearchResult } from '@underload/harness';
import {
    MAX_PUBLISHED_CHARS,
    MAX_RESPONSE_BYTES,
    MAX_RESULTS_LIMIT,
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

    if (!definition) throw new Error('Expected a configured webSearch tool.');

    return definition;
};

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
        expect(createWebSearchTool({ env: { EXA_API_KEY: '   ', TAVILY_API_KEY: '' } })).toBeUndefined();
    });

    it('offers only the provider that has a key', () => {
        const exa = configured({ EXA_API_KEY: 'exa-secret-key' });

        expect(exa.name).toBe('webSearch');
        // R18: a configured search tool is core — declared, never discovered.
        expect(exa.visibility).toBe('core');
        expect(exa.tags).toEqual(['web', 'search', 'internet', 'news', 'research']);

        // No provider property at all: one legal value is not a choice.
        const properties = (exa.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual(['query', 'maxResults']);
        expect(exa.description).toContain('Exa');
        expect(exa.description).not.toContain('Tavily');
    });

    it('prefers Exa when both are configured and offers the override', () => {
        const both = configured({ EXA_API_KEY: 'exa-secret-key', TAVILY_API_KEY: 'tavily-secret-key' });
        const properties = (both.parameters as { properties: Record<string, { enum?: string[] }> }).properties;

        expect(properties.provider.enum).toEqual(['exa', 'tavily']);
        expect(both.description).toContain('Exa or Tavily');
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
            'webSearch provider "exa" apiKey must be a string or a function returning one.'
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
        ).toThrow('webSearch provider "exa" apiKey getter failed.');
    });

    it('keeps keys out of the schema, description, and tags', () => {
        const tool = configured({ EXA_API_KEY: 'exa-secret-key', TAVILY_API_KEY: 'tavily-secret-key' });
        const metadata = JSON.stringify({
            description: tool.description,
            parameters: tool.parameters,
            tags: tool.tags,
            name: tool.name
        });

        expect(metadata).not.toContain('exa-secret-key');
        expect(metadata).not.toContain('tavily-secret-key');
        expect(metadata).not.toContain('EXA_API_KEY');
        expect(metadata).not.toContain('TAVILY_API_KEY');
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

        await expect(tool({ query: '   ' })).rejects.toThrow('webSearch requires a non-empty query string.');
        await expect(tool({ query: 42 as never })).rejects.toThrow('webSearch requires a non-empty query string.');
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
            'webSearch maxResults must be a number between 1 and 20.'
        );
    });

    it('rejects a provider that is not configured', async () => {
        const tool = configured({ EXA_API_KEY: 'exa-secret-key' });

        await expect(tool({ query: 'q', provider: 'tavily' })).rejects.toThrow(
            'webSearch provider "tavily" is not configured. Configured: exa.'
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

        expect(failure).resolves.toMatchObject({
            message: `Exa search timed out after ${SEARCH_TIMEOUT_MS} ms.`
        });
        await failure;

        // The finally block cleared the controller's timer.
        expect(vi.getTimerCount()).toBe(0);
    });
});
