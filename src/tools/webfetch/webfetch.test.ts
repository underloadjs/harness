// webFetch — the tool factory, key resolution, the native conversion, and the
// Exa contents adapter.
//
// Everything here is offline and deterministic: the environment is injected
// (`env`), fetch is a stub (`vi.stubGlobal`), and no host key or network is
// read. The tests pin the exact wire request for the Exa provider and the exact
// converted output for the native provider, because both are contracts a model
// depends on and silent drift is expensive.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFetchTool } from '@underload/harness';
import type { Tool, WebFetchParameters, WebFetchResult } from '@underload/harness';
import {
    BROWSER_USER_AGENT,
    FETCH_TIMEOUT_MS,
    HONEST_USER_AGENT,
    MAX_CONTENT_CHARS,
    MAX_RESPONSE_BYTES
} from './request';

const call = async (
    definition: Tool<WebFetchParameters, WebFetchResult>,
    parameters: WebFetchParameters | string
): Promise<WebFetchResult> => (await definition(parameters)) as WebFetchResult;

const response = (
    body: BodyInit | null,
    init?: { status?: number; headers?: Record<string, string>; url?: string }
): Response => {
    const created = new Response(body, {
        status: init?.status ?? 200,
        headers: init?.headers ?? {}
    });

    // `Response.url` is read-only and empty for a constructed Response, so the
    // redirect-reporting path is pinned by overriding the accessor.
    if (init?.url !== undefined) {
        Object.defineProperty(created, 'url', { value: init.url });
    }

    return created;
};

const html = (markup: string, init?: { status?: number; url?: string }): Response =>
    response(markup, {
        ...init,
        headers: { 'content-type': 'text/html; charset=utf-8', ...(init?.headers ?? {}) }
    });

const stubFetch = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const mock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
        async (url, init) => await respond(url, init)
    );

    vi.stubGlobal('fetch', mock);
    return mock;
};

const keyless = () => createWebFetchTool({ env: {} });
const withExa = () => createWebFetchTool({ env: { EXA_API_KEY: 'exa-secret-key' } });

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        }
    });
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('factory and schema', () => {
    it('always returns a tool: native needs no credential', () => {
        const definition = keyless();

        expect(definition).toBeDefined();
        expect(definition.name).toBe('webFetch');
        // Discovery-eligible: fetching is the step after searching.
        expect(definition.visibility).toBe('searchable');
        expect(definition.tags).toEqual(['web', 'fetch', 'internet', 'read', 'url', 'research']);
    });

    it('offers no provider property without a key', () => {
        const definition = keyless();
        const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;

        expect(Object.keys(properties)).toEqual(['url', 'format']);
        expect(definition.description).not.toContain('exa');
    });

    it('offers the provider choice when an Exa key exists', () => {
        const definition = withExa();
        const properties = (definition.parameters as { properties: Record<string, { enum?: string[] }> }).properties;

        expect(Object.keys(properties)).toEqual(['url', 'format', 'provider']);
        expect(properties.provider.enum).toEqual(['native', 'exa']);
        expect(definition.description).toContain('exa');
    });

    it('reads EXA_API_KEY from the injected env only, never per call', async () => {
        const getter = vi.fn(() => 'exa-secret-key');
        const definition = createWebFetchTool({ env: {}, exa: { apiKey: getter } });

        stubFetch(() => response(JSON.stringify({ results: [{ title: 't', url: 'https://example.com', text: 'body' }] }), { headers: { 'content-type': 'application/json' } }));

        await call(definition, { url: 'https://example.com', provider: 'exa' });
        await call(definition, { url: 'https://example.com', provider: 'exa' });

        expect(getter).toHaveBeenCalledTimes(1);
    });

    it('treats an explicit blank key as "off", not as a fallback to env', () => {
        const definition = createWebFetchTool({ env: { EXA_API_KEY: 'env-exa-key' }, exa: { apiKey: '' } });
        const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;

        expect(Object.keys(properties)).toEqual(['url', 'format']);
    });
});

describe('argument validation', () => {
    it('rejects non-http schemes, relative URLs, and userinfo', async () => {
        for (const url of ['javascript:alert(1)', '/relative/path', 'https://user:pass@example.com/', 'ftp://example.com', '']) {
            await expect(call(keyless(), { url })).rejects.toThrow(/absolute http\(s\) URL/);
        }
    });

    it('rejects an unknown format and an unconfigured provider', async () => {
        await expect(call(keyless(), { url: 'https://example.com', format: 'pdf' as 'html' })).rejects.toThrow(/format/);
        await expect(call(keyless(), { url: 'https://example.com', provider: 'exa' })).rejects.toThrow(/"exa" is not configured/);
    });

    it('accepts a bare URL string from a direct caller', async () => {
        stubFetch(() => html('hello'));

        const result = await call(keyless(), 'https://example.com');

        expect(result.provider).toBe('native');
        expect(result.content).toBe('hello');
    });
});

describe('native provider', () => {
    it('sends a negotiating GET and reports the redirected URL', async () => {
        const fetchMock = stubFetch(() => html('<p>hi</p>', { url: 'https://example.com/final' }));

        const result = await call(keyless(), { url: 'https://example.com/start' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://example.com/start');
        expect(init.method).toBe('GET');
        const headers = init.headers as Record<string, string>;
        expect(headers['user-agent']).toBe(BROWSER_USER_AGENT);
        expect(headers.accept).toContain('text/markdown;q=1.0');
        expect(result.url).toBe('https://example.com/final');
        expect(result.contentType).toBe('text/html; charset=utf-8');
    });

    it('converts HTML to markdown', async () => {
        stubFetch(() =>
            html(`<!DOCTYPE html>
                <html><head>
                    <title>My &amp; Page</title>
                    <style>body { color: red }</style>
                    <script>var x = "<hidden>";</script>
                </head>
                <body>
                    <h1>Heading</h1>
                    <p>Some <strong>bold</strong> and <em>italic</em> and <code>a &lt; b</code> text.</p>
                    <p>Link to <a href="https://example.org/guide">the guide</a>.</p>
                    <ul><li>First</li><li>Second</li></ul>
                    <blockquote>Quoted words</blockquote>
                    <pre>const a = 1;
if (a &lt; 2) log(a);</pre>
                    <img src="/pic.png" alt="a pic">
                    <!-- a comment -->
                    <hr>
                    <p>Done.</p>
                </body></html>`)
        );

        const result = await call(keyless(), { url: 'https://example.com' });

        expect(result.title).toBe('My & Page');
        expect(result.content).toContain('# Heading');
        expect(result.content).toContain('**bold**');
        expect(result.content).toContain('*italic*');
        expect(result.content).toContain('`a < b`');
        expect(result.content).toContain('[the guide](https://example.org/guide)');
        expect(result.content).toContain('- First');
        expect(result.content).toContain('- Second');
        expect(result.content).toContain('> Quoted words');
        expect(result.content).toContain('```\nconst a = 1;\nif (a < 2) log(a);\n```');
        expect(result.content).toContain('![image](/pic.png)');
        expect(result.content).toContain('---');
        expect(result.content).not.toContain('color: red');
        expect(result.content).not.toContain('<hidden>');
        expect(result.content).not.toContain('a comment');
    });

    it('extracts plain text without markdown syntax', async () => {
        stubFetch(() =>
            html('<h1>Title</h1><p><a href="https://example.org">click here</a> &mdash; now</p><script>x()</script>')
        );

        const result = await call(keyless(), { url: 'https://example.com', format: 'text' });

        expect(result.content).toContain('Title');
        expect(result.content).toContain('click here — now');
        expect(result.content).not.toContain('[');
        expect(result.content).not.toContain('x()');
    });

    it('returns raw HTML when asked for html', async () => {
        const markup = '<html><head><title>T</title></head><body><p>raw <b>markup</b></p></body></html>';
        stubFetch(() => html(markup));

        const result = await call(keyless(), { url: 'https://example.com', format: 'html' });

        expect(result.content).toBe(markup);
        expect(result.title).toBe('T');
    });

    it('passes a non-HTML body through untouched', async () => {
        stubFetch(() => response('{"ok":true}', { headers: { 'content-type': 'application/json' } }));

        const result = await call(keyless(), { url: 'https://example.com/data.json' });

        expect(result.content).toBe('{"ok":true}');
        expect(result.contentType).toBe('application/json');
    });

    it('retries once with the honest user agent on a Cloudflare challenge', async () => {
        let attempts = 0;
        const fetchMock = stubFetch(() => {
            attempts += 1;

            return attempts === 1
                ? response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } })
                : html('<p>passed</p>');
        });

        const result = await call(keyless(), { url: 'https://example.com' });

        expect(result.content).toBe('passed');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
        expect(headers['user-agent']).toBe(HONEST_USER_AGENT);
    });

    it('reports a failing status without echoing the page body', async () => {
        stubFetch(() => response('<html>Big secret page text</html>', { status: 500, headers: { 'content-type': 'text/html' } }));

        await expect(call(keyless(), { url: 'https://example.com' })).rejects.toThrow('webFetch failed (HTTP 500).');
    });

    it('rejects binary content types', async () => {
        stubFetch(() => response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));

        await expect(call(keyless(), { url: 'https://example.com/cat.png' })).rejects.toThrow(/content type \(image\/png\)/);
    });

    it('enforces the byte bound while streaming', async () => {
        const chunk = 'a'.repeat(100 * 1024);
        stubFetch(() => response(streamOf(Array.from({ length: 6 }, () => chunk)), { headers: { 'content-type': 'text/plain' } }));

        await expect(call(keyless(), { url: 'https://example.com/big' })).rejects.toThrow(
            `webFetch received a response larger than ${MAX_RESPONSE_BYTES} bytes.`
        );
    });

    it('bounds the returned content and flags truncation', async () => {
        stubFetch(() => response('x'.repeat(MAX_CONTENT_CHARS + 500), { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com' });

        expect(result.truncated).toBe(true);
        expect(result.characters).toBe(MAX_CONTENT_CHARS);
        expect(result.content).toHaveLength(MAX_CONTENT_CHARS);
    });

    it('times out with one fixed sentence', async () => {
        vi.useFakeTimers();

        stubFetch(
            (_url, init) =>
                new Promise<Response>((_, reject) => {
                    const signal = (init as RequestInit).signal as AbortSignal;
                    signal.addEventListener('abort', () => reject(new Error('AbortError')));
                })
        );

        const pending = call(keyless(), { url: 'https://example.com' });
        // Attach a keeper so the rejection that lands during the timer advance
        // is already handled when the assertion awaits it.
        pending.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);

        await expect(pending).rejects.toThrow(`webFetch timed out after ${FETCH_TIMEOUT_MS} ms.`);

        vi.useRealTimers();
    });
});

describe('exa provider', () => {
    const contentsPayload = {
        results: [{ title: 'Exa Title', url: 'https://example.com/page', text: 'Rendered markdown body' }],
        statuses: [{ id: 'https://example.com/page', status: 'success', source: 'crawled' }]
    };

    it('posts the bounded contents request with the key in a header', async () => {
        const fetchMock = stubFetch(() => response(JSON.stringify(contentsPayload), { headers: { 'content-type': 'application/json' } }));

        const result = await call(withExa(), { url: 'https://example.com/page', provider: 'exa' });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.exa.ai/contents');
        expect(init.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'exa-secret-key' });
        expect(JSON.parse(String(init.body))).toEqual({
            urls: ['https://example.com/page'],
            text: { maxCharacters: MAX_CONTENT_CHARS }
        });

        expect(result.provider).toBe('exa');
        expect(result.content).toBe('Rendered markdown body');
        expect(result.title).toBe('Exa Title');
    });

    it('surfaces a per-URL failure status tag', async () => {
        stubFetch(() =>
            response(
                JSON.stringify({
                    results: [{ title: 'x', url: 'https://example.com/page' }],
                    statuses: [{ id: 'https://example.com/page', status: 'error', error: { tag: 'LIVECRAWL_REQUIRED' } }]
                }),
                { headers: { 'content-type': 'application/json' } }
            )
        );

        await expect(call(withExa(), { url: 'https://example.com/page', provider: 'exa' })).rejects.toThrow(
            'Exa could not fetch that page (LIVECRAWL_REQUIRED).'
        );
    });

    it('redacts the configured key from page content', async () => {
        stubFetch(() =>
            response('the key is exa-secret-key inside the page', { headers: { 'content-type': 'text/plain' } })
        );

        const result = await call(withExa(), { url: 'https://example.com' });

        expect(result.content).toBe('the key is [redacted] inside the page');
    });
});
