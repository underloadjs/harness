// fetch — the tool factory, key resolution, the native conversion, and the two
// hosted contents adapters.
//
// Everything here is offline and deterministic: the environment is injected
// (`env`), fetch is a stub (`vi.stubGlobal`), and no host key or network is
// read. The tests pin the exact wire request for each hosted provider, the byte
// and character bounds of the native GET, and the exact converted output,
// because all of it is a contract a model depends on and silent drift is
// expensive.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFetchTool, WEB_FETCH_METADATA } from '@underload/harness';
import type { Tool, WebFetchParameters, WebFetchResult } from '@underload/harness';
// The native page budget lives here (1 MiB); the hosted providers answer
// through ../websearch/request's own JSON budget (512 KiB). Importing both under
// distinct names pins the fact that they are two different policies.
import { MAX_RESPONSE_BYTES as PROVIDER_MAX_RESPONSE_BYTES } from '../websearch/request';
import {
    BROWSER_USER_AGENT,
    FETCH_TIMEOUT_MS,
    HONEST_USER_AGENT,
    MAX_CONTENT_CHARS,
    MAX_RESPONSE_BYTES,
    MAX_RESULT_BYTES,
    MAX_RESULT_CONTENT_BYTES,
    binaryExtension,
    charsetFrom,
    isPrivateHost,
    safeFetchUrl
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

// `dns: { off: true }` keeps this suite offline and deterministic: the resolved-
// address SSRF gate (F5) is ON by default in production and would otherwise make
// a real DNS query per native test. The gate itself is tested separately below
// with an INJECTED resolver, so nothing about its behaviour goes unverified.
const keyless = () => createWebFetchTool({ env: {}, dns: { off: true } });
const withExa = () => createWebFetchTool({ env: { EXA_API_KEY: 'exa-secret-key' }, dns: { off: true } });
const withLinkup = () =>
    createWebFetchTool({ env: { LINKUP_API_KEY: 'linkup-secret-key' }, dns: { off: true } });

// Both hosted keys, so a test can prove `native` is still the default and that
// the enum lists every provider this harness can call.
const withHosted = () =>
    createWebFetchTool({ env: { EXA_API_KEY: 'exa-secret-key', LINKUP_API_KEY: 'linkup-secret-key' } });

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        }
    });
};

// A pull-driven, endless stream: every `pull` enqueues exactly one `size`-byte
// chunk, so a test counts how many chunks the tool actually consumed. The
// highWaterMark of 0 means the stream never prefetches ahead of a read, which
// turns "did not consume further after crossing the budget" into an exact number
// instead of a range check.
const countedStream = (
    size: number,
    counters: { produced: number; cancelled: boolean }
): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                counters.produced += 1;
                controller.enqueue(new Uint8Array(size));
            },
            cancel() {
                counters.cancelled = true;
            }
        },
        { highWaterMark: 0 }
    );

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('factory and schema', () => {
    it('always returns a tool: native needs no credential', () => {
        const definition = keyless();

        expect(definition).toBeDefined();
        expect(definition.name).toBe('fetch');
        // R9-R11: `fetch` is environment core, like a configured `search`. It stays
        // activation-gated (no `webfetch` opt-in means no tool at all), but a harness
        // that registers it declares it on every request.
        expect(definition.visibility).toBe('core');
        expect(definition.tags).toEqual(['web', 'fetch', 'internet', 'read', 'url', 'research']);
    });

    it('publishes static native metadata for the not-yet-enabled listing', () => {
        // The server catalogue (src/server/harnesses/webfetch.ts) lists `fetch`
        // before any host opts in, and it copies this object. Pinning it to the
        // keyless factory shape means "listed" can never drift from "callable".
        const definition = keyless();

        expect(WEB_FETCH_METADATA.name).toBe('fetch');
        expect(WEB_FETCH_METADATA.visibility).toBe('core');
        expect(WEB_FETCH_METADATA.description).toBe(definition.description);
        expect(WEB_FETCH_METADATA.tags).toEqual(definition.tags);
        expect(WEB_FETCH_METADATA.parameters).toEqual(definition.parameters);
        expect(
            Object.keys((WEB_FETCH_METADATA.parameters as { properties: Record<string, unknown> }).properties)
        ).toEqual(['url', 'format', 'query', 'offset']);
    });

    it('offers no provider property without a key', () => {
        const definition = keyless();
        const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;

        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset']);
        expect(definition.description).not.toContain('exa');
        expect(definition.description).not.toContain('linkup');
    });

    it('describes the byte bound and points at a download tool for the rest', () => {
        // Both sentences are one policy: a body that is too big or too binary to
        // read is a download, and the model has to be told where to go instead of
        // retrying the fetch.
        const definition = keyless();

        expect(definition.description).toContain(`bounded to ${MAX_RESPONSE_BYTES} bytes of body`);
        expect(definition.description).toContain(`${MAX_CONTENT_CHARS} characters`);
        expect(definition.description).toContain('A non-text content type is rejected');
        expect(definition.description).toContain('use the `download` tool instead');
        // Raised 10x from 100 KiB. The byte cap was acting as a content cap: it
        // refused pages whose converted text fitted the character bound easily
        // (measured: 5 of the top 10 results of a real search were unreadable
        // purely on raw HTML size — GitHub, a docs site, arxiv, and Wikipedia).
        expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
        // Raised 10x from 24,000 characters.
        expect(MAX_CONTENT_CHARS).toBe(240_000);
    });

    it('keeps one result inside the harness model-facing cap', async () => {
        // The harness caps every tool result at 64 KiB and replaces an over-budget
        // value with a generic envelope that drops url/title/truncated/nextOffset.
        // fetch bounds itself to that cap so it keeps its own shape and stays
        // resumable; MAX_CONTENT_CHARS is the per-PAGE bound, reached by paging.
        expect(MAX_RESULT_BYTES).toBe(64 * 1024);
        expect(MAX_RESULT_CONTENT_BYTES).toBeLessThan(MAX_CONTENT_CHARS);

        stubFetch(() =>
            response('x'.repeat(MAX_RESULT_CONTENT_BYTES + 10), { headers: { 'content-type': 'text/plain' } })
        );

        const result = await call(keyless(), { url: 'https://example.com/long' });

        expect(result.characters).toBe(MAX_RESULT_CONTENT_BYTES);
        expect(result.truncated).toBe(true);
        expect(result.nextOffset).toBe(MAX_RESULT_CONTENT_BYTES);
        expect(result.pageCharacters).toBe(MAX_RESULT_CONTENT_BYTES + 10);
    });

    it('resumes a cut page from the offset it reported', async () => {
        const page = 'x'.repeat(MAX_RESULT_CONTENT_BYTES) + 'TAILCONTENT';

        stubFetch(() => response(page, { headers: { 'content-type': 'text/plain' } }));

        const first = await call(keyless(), { url: 'https://example.com/page' });

        expect(first.truncated).toBe(true);
        expect(first.nextOffset).toBe(MAX_RESULT_CONTENT_BYTES);

        const second = await call(keyless(), { url: 'https://example.com/page', offset: first.nextOffset });

        expect(second.content).toBe('TAILCONTENT');
        expect(second.offset).toBe(MAX_RESULT_CONTENT_BYTES);
        expect(second.truncated).toBe(false);
        expect(second.nextOffset).toBeUndefined();
    });

    it('reports truncation from the source, not from the slice (off-by-one)', async () => {
        // A page ending exactly at the bound is complete; one cut at the bound is
        // not. Both return the same character count, so only the source length
        // distinguishes them.
        stubFetch(() =>
            response('y'.repeat(MAX_RESULT_CONTENT_BYTES), { headers: { 'content-type': 'text/plain' } })
        );

        const whole = await call(keyless(), { url: 'https://example.com/whole' });

        expect(whole.characters).toBe(MAX_RESULT_CONTENT_BYTES);
        expect(whole.truncated).toBe(false);
        expect(whole.nextOffset).toBeUndefined();
    });

    it('offers the provider choice when an Exa key exists', () => {
        const definition = withExa();
        const properties = (definition.parameters as { properties: Record<string, { enum?: string[] }> }).properties;

        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset', 'provider']);
        expect(properties.provider.enum).toEqual(['native', 'exa']);
        expect(definition.description).toContain('exa');
    });

    it('offers a native/linkup choice when only Linkup has a key', () => {
        const definition = withLinkup();
        const properties = (definition.parameters as { properties: Record<string, { enum?: string[] }> }).properties;

        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset', 'provider']);
        expect(properties.provider.enum).toEqual(['native', 'linkup']);
        expect(definition.description).toContain('linkup');
        expect(definition.description).not.toContain('exa');
    });

    it('lists every configured hosted provider, native first', () => {
        const definition = withHosted();
        const properties = (definition.parameters as { properties: Record<string, { enum?: string[] }> }).properties;

        expect(properties.provider.enum).toEqual(['native', 'exa', 'linkup']);
        expect(definition.description).toContain('provider "exa"');
        expect(definition.description).toContain('provider "linkup"');
    });

    it('names the provider that has a key and stays silent about the one that does not', () => {
        const exaOnly = withExa().description;
        const linkupOnly = withLinkup().description;

        // A keyless hosted provider must not appear in the description at all:
        // advertising it would invite a call this harness cannot make.
        expect(exaOnly).not.toContain('linkup');
        expect(linkupOnly).not.toContain('provider "exa"');
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

        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset']);
    });

    it('treats an explicit blank linkup key as "off" as well', () => {
        const definition = createWebFetchTool({
            env: { LINKUP_API_KEY: 'env-linkup-key' },
            linkup: { apiKey: '' }
        });
        const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;

        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset']);
        expect(definition.description).not.toContain('linkup');
    });

    it('calls a linkup key getter once, at construction', async () => {
        let calls = 0;

        const definition = createWebFetchTool({
            env: {},
            linkup: {
                apiKey: () => {
                    calls += 1;

                    return 'linkup-secret-key';
                }
            }
        });

        stubFetch(() =>
            response(JSON.stringify({ markdown: '# Page' }), { headers: { 'content-type': 'application/json' } })
        );

        await call(definition, { url: 'https://example.com', provider: 'linkup' });
        await call(definition, { url: 'https://example.com', provider: 'linkup' });

        expect(calls).toBe(1);
    });

    it('rejects an explicit linkup value that is not a string or getter', () => {
        expect(() => createWebFetchTool({ linkup: { apiKey: 42 as never } })).toThrow(
            'fetch provider "linkup" apiKey must be a string or a function returning one.'
        );
    });

    it('rejects a throwing linkup getter without echoing its error', () => {
        expect(() =>
            createWebFetchTool({
                linkup: {
                    apiKey: () => {
                        throw new Error('vault unavailable: lk-live-should-not-leak');
                    }
                }
            })
        ).toThrow('fetch provider "linkup" apiKey getter failed.');
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

    it('lists the alternatives when the asked-for provider has no key', async () => {
        // A named provider the harness cannot run is refused with the exact list
        // the model may choose from, so the next turn can correct itself.
        await expect(call(withLinkup(), { url: 'https://example.com', provider: 'exa' })).rejects.toThrow(
            'fetch provider "exa" is not configured. Configured: native, linkup.'
        );

        await expect(call(withExa(), { url: 'https://example.com', provider: 'linkup' })).rejects.toThrow(
            'fetch provider "linkup" is not configured. Configured: native, exa.'
        );

        await expect(call(withHosted(), { url: 'https://example.com', provider: 'serper' as never })).rejects.toThrow(
            'fetch provider "serper" is not configured. Configured: native, exa, linkup.'
        );
    });

    it('accepts a bare URL string from a direct caller', async () => {
        stubFetch(() => html('hello'));

        const result = await call(keyless(), 'https://example.com');

        expect(result.provider).toBe('native');
        expect(result.content).toBe('hello');
    });
});

describe('native provider', () => {
    it('stays the default even when both hosted providers are configured', async () => {
        const fetchMock = stubFetch(() => html('<p>direct</p>'));

        const result = await call(withHosted(), { url: 'https://example.com/page' });

        expect(result.provider).toBe('native');
        // One request, to the page itself: a configured crawler key must never
        // turn into a silent paid upgrade.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/page');
    });

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

        await expect(call(keyless(), { url: 'https://example.com' })).rejects.toThrow('fetch failed (HTTP 500).');
    });

    it('refuses every non-text content type instead of returning mojibake', async () => {
        const cases: Array<{ mime: string; message: string }> = [
            { mime: 'image/png', message: 'fetch does not support this content type (image/png): use the `download` tool' },
            { mime: 'application/pdf', message: 'fetch does not support this content type (application/pdf): use the `download` tool' },
            {
                mime: 'application/octet-stream',
                message: 'fetch does not support this content type (application/octet-stream): use the `download` tool'
            },
            { mime: 'audio/mpeg', message: 'fetch does not support this content type (audio/mpeg): use the `download` tool' },
            { mime: 'video/mp4', message: 'fetch does not support this content type (video/mp4): use the `download` tool' }
        ];

        for (const { mime, message } of cases) {
            const counters = { produced: 0, cancelled: false };

            stubFetch(
                () =>
                    response(countedStream(1024, counters), {
                        headers: { 'content-type': `${mime}; charset=utf-8` }
                    })
            );

            await expect(call(keyless(), { url: 'https://example.com/file' })).rejects.toThrow(message);

            // The gate runs before the body is read: the type is decided from the
            // header, so the bytes are released rather than downloaded.
            expect(counters).toEqual({ produced: 0, cancelled: true });
        }
    });

    it('accepts a text-bearing type the browser would download', async () => {
        // svg+xml is text and often carries readable content, so the gate keeps it.
        stubFetch(() => response('<svg><text>readable</text></svg>', { headers: { 'content-type': 'image/svg+xml' } }));

        const result = await call(keyless(), { url: 'https://example.com/diagram.svg' });

        expect(result.contentType).toBe('image/svg+xml');
        expect(result.content).toBe('<svg><text>readable</text></svg>');
    });

    it('rejects an advertised Content-Length over the cap before reading the body', async () => {
        const counters = { produced: 0, cancelled: false };

        stubFetch(
            () =>
                response(countedStream(64 * 1024, counters), {
                    headers: { 'content-type': 'text/plain', 'content-length': String(MAX_RESPONSE_BYTES + 1) }
                })
        );

        await expect(call(keyless(), { url: 'https://example.com/big' })).rejects.toThrow(
            `fetch received a response larger than ${MAX_RESPONSE_BYTES} bytes.`
        );

        // Nothing was downloaded: the advertised size alone is the rejection, and
        // cancelling releases the connection instead of streaming a page we throw
        // away.
        expect(counters).toEqual({ produced: 0, cancelled: true });
    });

    it('stops a streamed response at the byte budget and cancels the reader', async () => {
        const counters = { produced: 0, cancelled: false };

        // No content-length header at all, so only the per-chunk counter can catch
        // this. Chunks are 64 KiB, so 17 of them (1,114,112 bytes) cross the 1 MiB
        // budget, and the network does not guarantee any particular chunk size.
        stubFetch(
            async () =>
                new Response(countedStream(64 * 1024, counters), {
                    status: 200,
                    headers: { 'content-type': 'text/plain' }
                })
        );

        await expect(call(keyless(), { url: 'https://example.com/big' })).rejects.toThrow(
            `fetch received a response larger than ${MAX_RESPONSE_BYTES} bytes.`
        );

        // The reader was cancelled: the host must not keep sending after the cap.
        expect(counters.cancelled).toBe(true);
        // And it stopped with the chunk that crossed the budget — no further chunk
        // is consumed on the way to the error.
        expect(counters.produced).toBe(17);
    });

    it('accepts a body that is exactly at the byte budget', async () => {
        // The bound rejects strictly larger, never equal: two chunks summing to
        // exactly MAX_RESPONSE_BYTES must both be delivered. (The old test carried
        // character assertions under a byte-budget name, so the byte boundary
        // itself was never pinned; the content bound is pinned separately below.)
        const first = 'a'.repeat(512 * 1024);
        const second = 'b'.repeat(MAX_RESPONSE_BYTES - first.length);

        stubFetch(() => response(streamOf([first, second]), { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com/exact' });

        // Accepted, not rejected — and the result is still bounded by the harness
        // cap, with the rest of the page reachable by offset.
        expect(result.truncated).toBe(true);
        expect(result.characters).toBe(MAX_RESULT_CONTENT_BYTES);
        expect(result.pageCharacters).toBe(MAX_RESPONSE_BYTES);
        // The first 512 KiB of the body is all 'a', so the first result window is
        // all 'a' too; the rest of the megabyte is reachable by offset.
        expect(result.content).toBe('a'.repeat(MAX_RESULT_CONTENT_BYTES));
    });

    it('bounds the returned content and flags truncation', async () => {
        stubFetch(() => response('x'.repeat(MAX_CONTENT_CHARS + 500), { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com' });

        expect(result.truncated).toBe(true);
        expect(result.characters).toBe(MAX_RESULT_CONTENT_BYTES);
        expect(result.content).toHaveLength(MAX_RESULT_CONTENT_BYTES);
        // The page is bigger than one result, and the tool says so.
        expect(result.pageCharacters).toBe(MAX_CONTENT_CHARS + 500);
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

        await expect(pending).rejects.toThrow(`fetch timed out after ${FETCH_TIMEOUT_MS} ms.`);

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

describe('linkup provider', () => {
    const markdown = '# Rendered\n\nLinkup gives markdown.';

    const jsonBody = (payload: unknown): Response =>
        response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });

    it('posts the documented request with the key in a header', async () => {
        const fetchMock = stubFetch(() => jsonBody({ markdown, favicon: 'https://example.com/favicon.ico' }));

        const result = await call(withLinkup(), { url: 'https://example.com/page', provider: 'linkup' });

        const [url, init] = fetchMock.mock.calls[0];

        expect(url).toBe('https://api.linkup.so/v1/fetch');
        expect(init.method).toBe('POST');
        expect(init.redirect).toBe('error');
        expect(init.headers).toMatchObject({
            'content-type': 'application/json',
            authorization: 'Bearer linkup-secret-key'
        });
        expect(JSON.parse(String(init.body))).toEqual({ url: 'https://example.com/page' });

        // The whole result, exactly: Linkup renders markdown and sends no title,
        // so `title` is absent and the content type is the converted document.
        // `offset`/`pageCharacters` are always present: a caller must be able to
        // tell a complete page from a cut one without inferring it from the size.
        expect(result).toEqual({
            provider: 'linkup',
            url: 'https://example.com/page',
            contentType: 'text/markdown',
            format: 'markdown',
            characters: markdown.length,
            truncated: false,
            content: markdown,
            offset: 0,
            pageCharacters: markdown.length
        });
    });

    it('refuses an empty markdown answer', async () => {
        stubFetch(() => jsonBody({ markdown: '   ', favicon: 'https://example.com/favicon.ico' }));

        await expect(call(withLinkup(), { url: 'https://example.com/page', provider: 'linkup' })).rejects.toThrow(
            'Linkup could not fetch that page.'
        );
    });

    it('refuses a payload that is not an object', async () => {
        stubFetch(() => jsonBody([]));

        await expect(call(withLinkup(), { url: 'https://example.com/page', provider: 'linkup' })).rejects.toThrow(
            'Linkup fetch returned an unexpected response.'
        );
    });

    it('maps a rejected key and a network failure with the shared sentences', async () => {
        // A provider body is never echoed: this one even contains the key.
        stubFetch(() => response('{"error":"unauthorized","key":"linkup-secret-key"}', { status: 401 }));

        await expect(call(withLinkup(), { url: 'https://example.com/page', provider: 'linkup' })).rejects.toThrow(
            'Linkup search rejected the API key (HTTP 401). Check the configured key and account.'
        );

        stubFetch(async () => {
            throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.linkup.so');
        });

        await expect(call(withLinkup(), { url: 'https://example.com/page', provider: 'linkup' })).rejects.toThrow(
            'Linkup search could not be reached (network error).'
        );
    });

    it('keeps the hosted provider byte budget at 512 KiB', async () => {
        // The hosted adapters answer through ../websearch/request's JSON budget,
        // which the native page bound deliberately did not change.
        expect(PROVIDER_MAX_RESPONSE_BYTES).toBe(512 * 1024);

        stubFetch(() =>
            response('{}', { headers: { 'content-length': String(PROVIDER_MAX_RESPONSE_BYTES + 1) } })
        );

        await expect(call(withLinkup(), { url: 'https://example.com/page', provider: 'linkup' })).rejects.toThrow(
            `Linkup search returned a response larger than ${PROVIDER_MAX_RESPONSE_BYTES} bytes.`
        );
    });

    it('redacts every hosted key and applies the character bound locally', async () => {
        // Linkup has no server-side character knob (unlike Exa's
        // `text.maxCharacters`), so ./index's slice is the only bound here.
        stubFetch(() =>
            jsonBody({ markdown: `exa-secret-key then linkup-secret-key ${'x'.repeat(MAX_CONTENT_CHARS)}` })
        );

        const result = await call(withHosted(), { url: 'https://example.com/page', provider: 'linkup' });

        const prefix = '[redacted] then [redacted] ';

        expect(result.truncated).toBe(true);
        // One RESULT is capped by the harness model-facing budget, not by
        // MAX_CONTENT_CHARS: the page is bounded at 240,000 characters and reached
        // by paging with `offset`, while a single return stays inside 64 KiB so the
        // harness never replaces this tool's envelope with its generic one.
        expect(result.characters).toBe(MAX_RESULT_CONTENT_BYTES);
        expect(result.content).toBe(prefix + 'x'.repeat(MAX_RESULT_CONTENT_BYTES - prefix.length));
        expect(result.pageCharacters).toBe(MAX_CONTENT_CHARS + prefix.length);
        expect(result.nextOffset).toBe(MAX_RESULT_CONTENT_BYTES);
    });

});

describe('fetch: content shape and safety (defect fixes)', () => {
    it('refuses a binary extension before any transfer, pointing at download', async () => {
        // `fetch` is the structured-content path; a file is `download`'s job. The
        // refusal is on the URL, so no request is made at all.
        let requests = 0;

        stubFetch(() => {
            requests += 1;

            return response('<p>should never be read</p>');
        });

        for (const url of [
            'https://example.com/a.png',
            'https://example.com/b.PDF',
            'https://example.com/c.zip',
            'https://example.com/d.mp4'
        ]) {
            await expect(call(keyless(), { url })).rejects.toThrow(/use the `download` tool for binary content/);
        }

        expect(requests).toBe(0);

        // Text extensions and extensionless pages still fetch.
        stubFetch(() => response('<p>fine</p>'));
        for (const url of ['https://example.com/a.md', 'https://example.com/b.svg', 'https://example.com/page']) {
            const result = await call(keyless(), { url });
            expect(result.url).toBe(url);
        }
    });

    it('refuses a private or loopback target instead of reading the host', async () => {
        // Measured on the old implementation: a local server on 127.0.0.1 answered
        // a fetch and returned its own 404, which is both an internal read and a
        // port-open oracle.
        for (const url of [
            'http://127.0.0.1:8765/x',
            'http://localhost/x',
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.5/x',
            'http://[::1]/x'
        ]) {
            await expect(call(keyless(), { url })).rejects.toThrow(/not a public absolute http\(s\) address/);
        }

        expect(isPrivateHost('127.0.0.1')).toBe(true);
        expect(isPrivateHost('192.168.1.1')).toBe(true);
        expect(isPrivateHost('::1')).toBe(true);
        expect(isPrivateHost('example.com')).toBe(false);
        expect(isPrivateHost('93.184.216.34')).toBe(false);
        expect(safeFetchUrl('http://127.0.0.1/')).toBeUndefined();
        expect(safeFetchUrl('https://example.com/')).toBe('https://example.com/');
    });

    it('blocks a public name that RESOLVES to a private address', async () => {
        // The hole: `isPrivateHost` checks the spelling of the authority, so a
        // public-looking name whose A record is the metadata IP got through. Verified
        // by lookup in this session — 169-254-169-254.nip.io answers 169.254.169.254,
        // and the literal form was refused while the name was not refused at all.
        const fetchMock = stubFetch(() => html('<p>metadata</p>'));
        const tool = createWebFetchTool({
            env: {},
            dns: { lookup: async () => ['169.254.169.254'] }
        });

        await expect(call(tool, { url: 'http://169-254-169-254.nip.io/latest/meta-data/' })).rejects.toThrow(
            /resolves to a non-public address/
        );

        // Blocked before the connection: no request was ever made.
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('allows a name that resolves to a public address', async () => {
        stubFetch(() => html('<p>fine</p>'));
        const tool = createWebFetchTool({ env: {}, dns: { lookup: async () => ['93.184.216.34'] } });

        const result = await call(tool, { url: 'https://example.com/page' });

        expect(result.content).toContain('fine');
    });

    it('fails open when the resolver errors, rather than calling a good URL private', async () => {
        stubFetch(() => html('<p>served</p>'));
        const tool = createWebFetchTool({
            env: {},
            dns: { lookup: async () => { throw new Error('SERVFAIL'); } }
        });

        const result = await call(tool, { url: 'https://example.com/page' });

        expect(result.content).toContain('served');
    });

    it('re-validates the host of a redirect, not just its spelling', async () => {
        stubFetch((url) =>
            url.includes('jump')
                ? response(null, { status: 302, headers: { location: 'http://evil.nip.io/' } })
                : html('<p>should not be read</p>')
        );
        const tool = createWebFetchTool({
            env: {},
            dns: { lookup: async (host: string) => (host === 'evil.nip.io' ? ['127.0.0.1'] : ['93.184.216.34']) }
        });

        await expect(call(tool, { url: 'https://public.example/jump' })).rejects.toThrow(
            /refused a redirect to a non-public address.*127\.0\.0\.1/s
        );
    });

    it('refuses a redirect that lands on a private address', async () => {
        stubFetch(() =>
            response(null, {
                status: 302,
                headers: { location: 'http://127.0.0.1/internal' }
            })
        );

        await expect(call(keyless(), { url: 'https://example.com/jump' })).rejects.toThrow(
            /refused a redirect to a non-public address/
        );
    });

    it('follows a redirect to a public host and reports the hop', async () => {
        let hop = 0;

        stubFetch(() => {
            hop += 1;

            return hop === 1
                ? response(null, { status: 301, headers: { location: 'https://final.example/moved' } })
                : response('<p>moved content</p>', { url: 'https://final.example/moved' });
        });

        const result = await call(keyless(), { url: 'https://example.com/moved' });

        expect(result.url).toBe('https://final.example/moved');
        expect(result.redirects).toBe(1);
        expect(result.content).toContain('moved content');
    });

    it('decodes a declared charset instead of assuming UTF-8', async () => {
        // 0xe9 is e-acute in windows-1252. The old decoder was always UTF-8, so
        // this byte came back as U+FFFD.
        const cp1252 = new Uint8Array([0x3c, 0x68, 0x31, 0x3e, 0x43, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x68, 0x31, 0x3e]);

        stubFetch(() => new Response(cp1252, { status: 200, headers: { 'content-type': 'text/html; charset=windows-1252' } }));

        const result = await call(keyless(), { url: 'https://example.com/latin' });

        // The h1 became a markdown heading, and the 0xe9 decoded to e-acute rather
        // than to the replacement character UTF-8 decoding produced.
        expect(result.content).toBe('# Caf\u00e9');
        expect(charsetFrom('text/html; charset=windows-1252')).toBe('windows-1252');
        expect(charsetFrom('text/html; charset="utf-8"')).toBe('utf-8');
        expect(charsetFrom('text/html')).toBeUndefined();
        // An unrecognised label must not lose the page.
        expect(charsetFrom('text/html; charset=totally-made-up')).toBe('totally-made-up');
    });

    it('strips highlighter markup inside code fences', async () => {
        // Measured on a real docs page: every fence came back as
        // `<code><span class="line"><span style="color:#79B8FF">cd</span>...`,
        // ~200 characters of styling noise per line of actual code.
        stubFetch(() =>
            html(
                '<pre><code class="language-ts"><span class="line"><span style="color:#79B8FF">cd</span> scripts</span></code></pre>'
            )
        );

        const result = await call(keyless(), { url: 'https://example.com/code' });

        expect(result.content).toContain('cd scripts');
        expect(result.content).not.toContain('<span');
        expect(result.content).not.toContain('style=');
    });

    it('keeps an unescaped comparison inside a code fence intact', async () => {
        // The narrow strip list exists for exactly this: a blanket tag strip would
        // eat `<b && c>` from `if (a<b && c>d)`.
        stubFetch(() => html('<pre><code>if (a&lt;b &amp;&amp; c&gt;d) {}</code></pre>'));

        const result = await call(keyless(), { url: 'https://example.com/compare' });

        expect(result.content).toContain('if (a<b && c>d) {}');
    });

    it('returns only matching sections when query is given', async () => {
        stubFetch(() =>
            html(
                '<h1>Manual</h1><p>Intro prose.</p>' +
                    '<h2>Installation</h2><p>Run npm install.</p>' +
                    '<h2>Usage</h2><p>Call the tool.</p>' +
                    '<h2>Security</h2><p>Rotate the token.</p>'
            )
        );

        const result = await call(keyless(), { url: 'https://example.com/manual', query: 'install' });

        expect(result.query).toBe('install');
        expect(result.matches).toBe(1);
        expect(result.totalSections).toBe(4);
        expect(result.content).toContain('Run npm install.');
        expect(result.content).not.toContain('Rotate the token.');
        expect(result.content).toContain('## Installation');
    });

    it('reports no match instead of silently returning the whole page', async () => {
        stubFetch(() => html('<h2>Usage</h2><p>Call the tool.</p>'));

        await expect(call(keyless(), { url: 'https://example.com/manual', query: 'zzz-nothing' })).rejects.toThrow(
            /found no section matching/
        );
    });

    it('treats query as a literal phrase, not a regular expression', async () => {
        // An unescaped `(` from a model must not become a syntax error.
        stubFetch(() => html('<h2>Notes (draft)</h2><p>Body.</p>'));

        const result = await call(keyless(), { url: 'https://example.com/n', query: 'Notes (draft)' });

        expect(result.matches).toBe(1);
    });

    it('reports an out-of-range offset as a clamp, not as an empty page', async () => {
        // The defect: offset 40,000 into an 18,000-character page returned
        // content:"" with truncated:false, which is byte-for-byte the shape of "this
        // page has no content". A caller that overshot abandoned a readable page.
        const page = 'x'.repeat(2_000);
        stubFetch(() => response(page, { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com/short', offset: 40_000 });

        expect(result.content).toBe('');
        expect(result.offsetClamped).toBe(true);
        expect(result.truncated).toBe(false);
        // The echoed offset is the one actually used, so paging stays coherent.
        expect(result.offset).toBe(2_000);
        expect(result.pageCharacters).toBe(2_000);
        expect(result.note).toContain('past the end');
    });

    it('leaves offsetClamped absent when the offset is in range', async () => {
        stubFetch(() => response('x'.repeat(2_000), { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com/ok', offset: 10 });

        expect(result.offset).toBe(10);
        expect(result.offsetClamped).toBeUndefined();
        expect(result.note).toBeUndefined();
    });

    it('answers a query on a heading-less page with a window, not the whole document', async () => {
        // The defect: a plain-text page converts to ONE section, so "return the
        // matching sections" returned the entire document while still reporting
        // matches:1 — full price, no narrowing, and nothing telling the caller.
        const filler = (seed: string, times: number): string =>
            Array.from({ length: times }, (_, index) => `${seed}-${index} ${'lorem ipsum dolor sit amet'.repeat(3)}`).join('\n');

        const page = `${filler('a', 400)}\n13.1.1. If-Match\n${filler('b', 400)}`;
        stubFetch(() => response(page, { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com/rfc', query: 'If-Match' });

        expect(result.matchMode).toBe('proximity');
        expect(result.content).toContain('If-Match');
        // The whole point: a window, not the document.
        expect(result.characters).toBeLessThan(10_000);
        expect(result.pageCharacters).toBe(page.length);
        expect(result.note).toContain('no heading structure');
    });

    it('labels a heading-bearing query answer as heading mode', async () => {
        stubFetch(() =>
            html(
                '<h2>Installation</h2><p>Run npm install.</p>' +
                    '<h2>Usage</h2><p>Call the tool.</p>' +
                    '<h2>Security</h2><p>Rotate the token.</p>'
            )
        );

        const result = await call(keyless(), { url: 'https://example.com/manual', query: 'install' });

        expect(result.matchMode).toBe('heading');
        expect(result.note).toBeUndefined();
    });

    it('drops navigation and aside chrome but keeps the article body', async () => {
        // Measured on real pages: a language switcher and a sidebar menu ate roughly
        // a third of the returned budget before the lead paragraph appeared.
        stubFetch(() =>
            html(
                '<nav><a href="/a">Аԥсшәа</a><a href="/b">Afrikaans</a></nav>' +
                    '<aside class="sidebar">Contents 1 Overview 2 History</aside>' +
                    '<article><h1>Wikipedia</h1><p>The free encyclopedia.</p></article>' +
                    '<footer>Privacy policy · About</footer>'
            )
        );

        const result = await call(keyless(), { url: 'https://example.org/wiki' });

        expect(result.content).toContain('The free encyclopedia.');
        expect(result.content).not.toContain('Afrikaans');
        expect(result.content).not.toContain('Contents 1 Overview');
        // header/footer are deliberately kept: on article and docs pages a <header>
        // carries the page heading, and losing real content to save a line is a bad
        // trade. Pinning that here so a later "prune more" change is a decision, not
        // an accident.
        expect(result.content).toContain('Privacy policy');
    });

    it('leaves chrome markup intact when the caller asked for raw html', async () => {
        stubFetch(() => html('<nav><a href="/a">Menu</a></nav><p>Body.</p>'));

        const result = await call(keyless(), { url: 'https://example.org/raw', format: 'html' });

        expect(result.content).toContain('<nav>');
        expect(result.content).toContain('Menu');
    });

    it('rejects an unknown argument rather than ignoring it', async () => {
        // The schema says additionalProperties:false and core/schema-validation.ts
        // enforces that on the model path, so a hallucinated argument must fail.
        const { resolveToolParameters } = await import('@underload/harness');
        const definition = withHosted();

        expect(() =>
            resolveToolParameters(
                definition.parameters as Record<string, unknown>,
                { url: 'https://example.com/', bogus: 1 },
                'model'
            )
        ).toThrow(/must not include the additional property "bogus"/);
    });
});
