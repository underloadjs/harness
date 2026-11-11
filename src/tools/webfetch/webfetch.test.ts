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
    MAX_QUERY_BLOCKS,
    MAX_RESPONSE_BYTES,
    MAX_RESULT_BYTES,
    MAX_RESULT_CONTENT_BYTES,
    binaryExtension,
    charsetFrom,
    isPrivateHost,
    safeFetchUrl,
    transportFailureMessage
} from './request';

// The oversized-response sentence, pinned WHOLE. The two existing oversize tests
// asserted only the first clause, which let the ADVICE drift back to remedies that
// cannot work in the state that triggers this error (issue 0014: `query` selects
// sections of the converted document, so it never runs when a content-length
// rejection fires before a byte is read, and `grep` skips files larger than the
// 1 MiB that caused the error — silently, with `matches: []`).
const OVERSIZED_MESSAGE =
    `fetch received a response larger than ${MAX_RESPONSE_BYTES} bytes. Try the plain-text or raw source form of the page if the host offers one (.txt, a "?action=raw" / print view) — that is the only remedy that reduces the transferred body; "query" and "format" cannot help, because they apply after this size check. Or use the \`download\` tool to save the bytes and read them with \`read\` (\`grep\` skips files over 1 MiB).`;
// The native module's own entry, imported directly (not through the lazy
// `import()` ./index uses) so the math-flattening fact the conversion reports
// can be pinned without depending on the envelope that turns it into a `note`.
import { MATH_FLATTENED_NOTE, fetchNative } from './native';

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

        // The WHOLE sentence, not just the first clause (issue 0014). The advice is
        // the part that drifted: pinning only "…larger than N bytes." left the remedy
        // list free to name `query` (which cannot run in this state) and `grep` (which
        // skips files above the very size that caused the error).
        const message = await call(keyless(), { url: 'https://example.com/big' }).then(
            () => undefined,
            (error: unknown) => (error as Error).message
        );

        expect(message).toBe(OVERSIZED_MESSAGE);

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

// Issue 0012 — the converter used to delete `<sup>`/`<sub>` with their text, so
// `10<sup>12</sup>` reached the model as "1012" and the NIST Planck constant as
// "x 10-34 J s" (a subtraction, wrong by 34 orders of magnitude), and the same
// byte-level tag boundary let Parsoid's `data-mw='{…}'` — a quoted attribute
// value containing a literal `>` — spill `{{rp|…}}` and `{{cite journal |…}}`
// into the middle of an article. Every fixture here is a crafted page, so the
// mechanism is pinned offline; the live-page counts in the issue doc are history.
describe('fetch: math markup and attribute metadata (issue 0012)', () => {
    it('converts superscripts and subscripts into markers instead of joining them to the base', async () => {
        stubFetch(() =>
            html(
                '<article><p>agrees with experiment to within 1 part in 10<sup id="mwZA">12</sup>, ' +
                    'and H<sub>n</sub>O is water.</p></article>'
            )
        );

        const result = await call(keyless(), { url: 'https://example.com/qm' });

        // Exact, not "contains a caret": the whole point is that the digits of the
        // exponent no longer run into the base.
        expect(result.content).toBe('agrees with experiment to within 1 part in 10^12, and H_nO is water.');
        expect(result.content).not.toContain('1012');
        expect(result.content).not.toContain('HnO');
    });

    it('keeps the same markers in text output', async () => {
        // `format=text` used to be no help at all: its own catch-all deleted the
        // tag exactly like markdown's, one space apart, so the sentence came back
        // as "1 part in 10 12".
        stubFetch(() =>
            html(
                '<article><p>agrees with experiment to within 1 part in 10<sup id="mwZA">12</sup>, ' +
                    'and H<sub>n</sub>O is water.</p></article>'
            )
        );

        const result = await call(keyless(), { url: 'https://example.com/qm', format: 'text' });

        expect(result.content).toBe('agrees with experiment to within 1 part in 10^12, and H_nO is water.');
        expect(result.content).not.toContain('10 12');
    });

    it('does not read a NIST-style exponent as a subtraction', async () => {
        // Source HTML is `10<sup>-34</sup>`; the minus sign must land after the
        // marker, where it is unambiguously an exponent, not glued to the mantissa.
        stubFetch(() => html('<p>&#8463; = 1.054 571 817&hellip; x 10<sup>-34</sup> J s</p>'));

        const markdown = await call(keyless(), { url: 'https://physics.example.gov/cgi-bin/cuu/Value?hbar' });

        expect(markdown.content).toBe('\u210f = 1.054 571 817… x 10^-34 J s');
        expect(markdown.content).not.toContain('10-34');

        stubFetch(() => html('<p>&#8463; = 1.054 571 817&hellip; x 10<sup>-34</sup> J s</p>'));

        const text = await call(keyless(), {
            url: 'https://physics.example.gov/cgi-bin/cuu/Value?hbar',
            format: 'text'
        });

        expect(text.content).toBe('\u210f = 1.054 571 817… x 10^-34 J s');
        expect(text.content).not.toContain('10-34');
    });

    it('returns math and metadata markup verbatim when the caller asked for html', async () => {
        // `format=html` is the lossless escape hatch the note points at, so it has
        // to keep the marker AND the round-trip metadata the other formats drop.
        const markup =
            '<html><body><p>1 part in 10<sup id="mwZA">12</sup> and ' +
            '<span data-mw=\'{"a":"x>y"}\'>kept</span>.</p></body></html>';

        stubFetch(() => html(markup));

        const result = await call(keyless(), { url: 'https://example.com/raw', format: 'html' });

        expect(result.content).toBe(markup);
        expect(result.content).toContain('10<sup id="mwZA">12</sup>');
        expect(result.content).toContain('data-mw=\'{"a":"x>y"}\'');
    });

    it('reports math as flattened exactly when math markup was flattened', async () => {
        // The disclosure is the part that protects a model that never notices, so
        // it must fire for every carrier — <sup>, <sub>, <math>/MathML — in either
        // format, and must stay silent for a page that has none.
        stubFetch(() => html('<p>within 1 part in 10<sup>12</sup></p>'));
        expect((await fetchNative('https://example.com/sup', 'markdown')).converted.mathFlattened).toBe(true);

        stubFetch(() => html('<p>H<sub>n</sub>O</p>'));
        expect((await fetchNative('https://example.com/sub', 'text')).converted.mathFlattened).toBe(true);

        stubFetch(() => html('<p><math><mrow><mfrac><mi>\u210F</mi><mn>2</mn></mfrac></mrow></math></p>'));
        expect((await fetchNative('https://example.com/math', 'markdown')).converted.mathFlattened).toBe(true);

        // "1012 kelvin" is a real number in prose, not flattened math: the note for
        // it would train a model to ignore the note.
        stubFetch(() => html('<p>a star of 1012 kelvin, no markup here.</p>'));
        expect((await fetchNative('https://example.com/plain', 'markdown')).converted.mathFlattened).toBe(false);
        expect((await fetchNative('https://example.com/plain', 'text')).converted.mathFlattened).toBe(false);

        // Nothing was converted on the other two paths, so nothing was flattened.
        stubFetch(() => html('<p>within 1 part in 10<sup>12</sup></p>'));
        expect((await fetchNative('https://example.com/html', 'html')).converted.mathFlattened).toBe(false);

        stubFetch(() => response('{"value":"10^-34"}', { headers: { 'content-type': 'application/json' } }));
        expect((await fetchNative('https://example.com/json', 'markdown')).converted.mathFlattened).toBe(false);
    });

    it('names the flattening and the format=html remedy in the disclosure it hands ./index', () => {
        // ./index owns the envelope prose, so the wording is pinned here: it must
        // say what happened and how to get the exact values back.
        expect(MATH_FLATTENED_NOTE).toBe('Math markup flattened; use format="html" for exact values.');
        expect(MATH_FLATTENED_NOTE).toContain('flattened');
        expect(MATH_FLATTENED_NOTE).toContain('format="html"');
    });

    it('does not report a code sample that mentions <sup> as flattened math', async () => {
        // A <pre> is code and comes back as written: the escaped form stays literal
        // text and the raw wrapper tags are stripped by PRE_WRAPPER_TAGS. Flagging
        // that would put a math note on any page with a highlighted snippet.
        stubFetch(() =>
            html('<pre>if (a&lt;b) log(10&lt;sup&gt;12&lt;/sup&gt;)\nif (x<sup>2</sup>) y;</pre><p>prose after the sample.</p>')
        );

        const { converted } = await fetchNative('https://example.com/code', 'markdown');

        expect(converted.mathFlattened).toBe(false);
        expect(converted.content).toContain('```\nif (a<b) log(10<sup>12</sup>)\nif (x2) y;\n```');
        expect(converted.content).toContain('prose after the sample.');
    });

    it('keeps Parsoid data-mw metadata out of mid-prose markdown', async () => {
        // The Wikipedia shape, in miniature: the round-trip JSON sits on the ref
        // <sup> and on the <li>, and it contains a literal `>` inside the quoted
        // value. A boundary that ends the tag at that `>` emits everything after it
        // — `}}'>`, `{{rp|…}}`, `"i":0`, `{{cite journal |…}}` — as article text.
        const article =
            '<article><h1>Quantum mechanics</h1>' +
            '<p>The electron is<sup about="#mwa2" class="mw-ref-link-indicator" ' +
            `data-mw='{"tag":"ref","attrs":{"title":"The Physics of Atoms"},"body":{"mt":"{{rp|100\u2013105 >x}}"}},"i":0}'>` +
            '[1]</sup> stable.</p>' +
            '<h2>Philosophical implications</h2>' +
            '<ol class="references"><li id="cite_note-1" about="#cite_note-1" ' +
            `data-mw='{"name":"Foo","template":{"1":{"value":{"mt":"{{cite journal |title=Quantum decoherence |doi>10.1234}}"}}},"i":0}'>` +
            '^ "Foo".</li></ol></article>';

        stubFetch(() => html(article));

        const markdown = await call(keyless(), { url: 'https://en.wikipedia.org/wiki/Quantum_mechanics' });

        expect(markdown.content).not.toContain('{{rp|');
        expect(markdown.content).not.toContain('{{cite journal');
        expect(markdown.content).not.toContain('"i":0');
        // The tell-tale fragment of a mis-split tag: the tail of the attribute.
        expect(markdown.content).not.toContain("'>");
        // And the reader keeps what was actually on the page.
        expect(markdown.content).toContain('# Quantum mechanics');
        expect(markdown.content).toContain('The electron is^[1] stable.');
        expect(markdown.content).toContain('- ^ "Foo".');

        stubFetch(() => html(article));

        const text = await call(keyless(), { url: 'https://en.wikipedia.org/wiki/Quantum_mechanics', format: 'text' });

        expect(text.content).not.toContain('{{rp|');
        expect(text.content).not.toContain('{{cite journal');
        expect(text.content).not.toContain('"i":0');
        expect(text.content).toContain('The electron is^[1] stable.');
    });

    it('treats a `>` inside any quoted attribute value as inside the tag', async () => {
        // The mechanism, with no MediaWiki involved: `data-mw` is only the most
        // common carrier. The naive boundary `<[^>]*>` returned `see b">only this
        // text` for this exact page.
        stubFetch(() => html('<p>see <span class="tip" title="a>b">only this</span> text</p>'));

        const markdown = await call(keyless(), { url: 'https://example.com/attr' });

        expect(markdown.content).toBe('see only this text');

        stubFetch(() => html('<p>see <span class="tip" title="a>b">only this</span> text</p>'));

        const text = await call(keyless(), { url: 'https://example.com/attr', format: 'text' });

        expect(text.content).toBe('see only this text');
    });

    // --- Envelope level (issue 0012: criterion 1 as the issue now numbers it,
    // criterion 3 as originally filed) ----------------------------------------
    // Everything above pins the converter. The consumer is the model, and the
    // model only sees the RESULT, so the disclosure has to survive the hand-off
    // through ./index. These call the tool entry point and assert `result.note`.
    it('discloses the flattening on the result in markdown and in text', async () => {
        // The whole gap: the converter said "flattened", the envelope dropped it.
        // Both lossy formats must carry the sentence, verbatim — a paraphrase
        // invented in ./index would drift from the module that knows the loss.
        stubFetch(() => html('<p>within 1 part in 10<sup id="mwZA">12</sup></p>'));

        const markdown = await call(keyless(), { url: 'https://example.com/qm' });

        // The marker did the rescue; the note reports the loss the marker cannot
        // rescue (MathML still flattens), and proves the flag was actually set.
        expect(markdown.content).toBe('within 1 part in 10^12');
        expect(markdown.note).toBe(MATH_FLATTENED_NOTE);

        stubFetch(() => html('<p>within 1 part in 10<sup id="mwZA">12</sup></p>'));

        const text = await call(keyless(), { url: 'https://example.com/qm', format: 'text' });

        expect(text.content).toBe('within 1 part in 10^12');
        expect(text.note).toBe(MATH_FLATTENED_NOTE);
    });

    it('leaves the disclosure off the result when nothing was flattened', async () => {
        // A note on a page that lost nothing trains a model to ignore the note.
        // Three silent paths: prose that only LOOKS like a flattened exponent,
        // `format=html` (the verbatim body the note points at), and a non-HTML
        // body, which is passed through without any conversion at all.
        stubFetch(() => html('<p>a star of 1012 kelvin, no markup here.</p>'));

        const plain = await call(keyless(), { url: 'https://example.com/plain' });

        expect(plain.content).toBe('a star of 1012 kelvin, no markup here.');
        expect(plain.note).toBeUndefined();

        const markup = '<html><body><p>within 1 part in 10<sup>12</sup></p></body></html>';

        stubFetch(() => html(markup));

        const raw = await call(keyless(), { url: 'https://example.com/raw', format: 'html' });

        expect(raw.content).toBe(markup);
        expect(raw.note).toBeUndefined();

        stubFetch(() =>
            response('{"unit":"J s","value":"1.054571817e-34"}', { headers: { 'content-type': 'application/json' } })
        );

        const json = await call(keyless(), { url: 'https://example.com/api/value' });

        expect(json.content).toBe('{"unit":"J s","value":"1.054571817e-34"}');
        expect(json.note).toBeUndefined();
    });

    it('discloses the flattening on a query answer as well as on a window', async () => {
        // Section selection is its own return path, and it converts the same page,
        // so it loses the same math. A caller that paid only for the sections would
        // otherwise cite `10-34` with no warning at all. Three headings, because a
        // document with two or fewer sections is answered by the proximity fallback
        // instead (sections.ts:52, FLAT_DOCUMENT_SECTIONS).
        stubFetch(() =>
            html(
                '<article><h1>Planck constant</h1><p>The value is 1.054 571 817 x 10<sup>-34</sup> J s.</p>' +
                    '<h2>History</h2><p>Max Planck, 1900.</p>' +
                    '<h2>Related constants</h2><p>The reduced constant is &#8463; = h / 2&#960;.</p></article>'
            )
        );

        const result = await call(keyless(), { url: 'https://example.com/qm', query: 'Planck' });

        expect(result.matchMode).toBe('heading');
        expect(result.content).toContain('10^-34');
        expect(result.note).toBe(MATH_FLATTENED_NOTE);
    });

    it('keeps the clamp note when a clamped offset lands on flattened math', async () => {
        // Acceptance criterion 2. `note` is ONE field, so when two disclosures
        // compete the one that explains the window the caller is holding wins —
        // here, the clamp. Overwriting is fine; dropping the clamp would send the
        // caller paging for a page it has already read to the end.
        stubFetch(() => html('<p>within 1 part in 10<sup>12</sup></p>'));

        // First: the same page with no offset, which pins that the math note WOULD
        // have been set. Without this the precedence claim could pass on a fixture
        // whose flag was simply never raised.
        const unclamped = await call(keyless(), { url: 'https://example.com/qm' });

        expect(unclamped.note).toBe(MATH_FLATTENED_NOTE);

        stubFetch(() => html('<p>within 1 part in 10<sup>12</sup></p>'));

        const clamped = await call(keyless(), { url: 'https://example.com/qm', offset: 40_000 });

        expect(clamped.content).toBe('');
        expect(clamped.offsetClamped).toBe(true);
        expect(clamped.note).toContain('past the end');
        expect(clamped.note).not.toBe(MATH_FLATTENED_NOTE);
    });

    it('keeps the proximity note when a headingless query lands on flattened math', async () => {
        // The other half of criterion 2, on the query return path: the proximity
        // note explains why the caller got an excerpt instead of a section, which
        // is the fact it needs in order to page correctly.
        const page = `<p>${'filler prose. '.repeat(500)}needle: 1 part in 10<sup>12</sup></p>`;

        stubFetch(() => html(page));

        // Same page, no `query`: the math note is what a plain read gets.
        const windowed = await call(keyless(), { url: 'https://example.com/rfc' });

        expect(windowed.content).toContain('needle: 1 part in 10^12');
        expect(windowed.note).toBe(MATH_FLATTENED_NOTE);

        stubFetch(() => html(page));

        const proximity = await call(keyless(), { url: 'https://example.com/rfc', query: 'needle' });

        expect(proximity.matchMode).toBe('proximity');
        expect(proximity.note).toContain('no heading structure');
        expect(proximity.note).not.toBe(MATH_FLATTENED_NOTE);
    });
});

// Shared helper for the issue-0014/0015/0016 blocks below: the message a call
// rejected with, so an error sentence can be pinned exactly rather than matched
// by fragment.
const failureMessage = async (parameters: WebFetchParameters): Promise<string> => {
    try {
        await call(keyless(), parameters);
    } catch (error) {
        return (error as Error).message;
    }

    throw new Error(`expected fetch to reject for ${JSON.stringify(parameters)}`);
};

// A transport rejection shaped the way undici rejects: a `fetch failed` error with
// the system error hanging off `cause`. Fabricated, so none of these tests needs
// the network or a live host.
const transportRejection = (cause: unknown): Error =>
    Object.assign(new Error('fetch failed'), { cause });

// One errno-shaped error, optionally carrying the HTML body a hostile transport
// might echo back, to prove the sanitizer still keeps page content out.
const causeWithCode = (code: string, message = `connect ${code} 203.0.113.9:443`): Error =>
    Object.assign(new Error(message), { code });

describe('fetch: the oversized-response remedy list (issue 0014)', () => {
    it('names only remedies that can work in the state that triggers the size error', async () => {
        const counters = { produced: 0, cancelled: false };

        stubFetch(
            () =>
                response(countedStream(64 * 1024, counters), {
                    headers: { 'content-type': 'text/plain', 'content-length': String(MAX_RESPONSE_BYTES + 1) }
                })
        );

        const message = await failureMessage({ url: 'https://example.com/big' });

        expect(message).toBe(OVERSIZED_MESSAGE);
        // Acceptance criterion 1 and 2, stated as facts a rewrite has to keep:
        // `query` is gone from the remedy list, and the downloaded file is handed to
        // `read`, with `grep`'s 1 MiB skip called out instead of recommended.
        expect(message).toContain('read them with `read`');
        expect(message).toContain('(`grep` skips files over 1 MiB)');
        expect(message).not.toContain('ask for fewer characters with "query"');
        expect(message).not.toContain('read them with grep and read');
    });

    it('rejects an oversized page identically with and without query, because query never runs', async () => {
        // The measurement behind the rewrite: selection runs on CONVERTED content
        // (./sections.ts:6-7) while this rejection fires from the content-length
        // pre-check (./request.ts:700-707) before a byte is read, so the remedy the
        // old message offered could not change the outcome.
        const counters = { produced: 0, cancelled: false };

        stubFetch(
            () =>
                response(countedStream(64 * 1024, counters), {
                    headers: { 'content-type': 'text/plain', 'content-length': String(MAX_RESPONSE_BYTES + 1) }
                })
        );

        const withoutQuery = await failureMessage({ url: 'https://example.com/big' });
        const withQuery = await failureMessage({ url: 'https://example.com/big', query: 'field name' });

        expect(withQuery).toBe(OVERSIZED_MESSAGE);
        expect(withQuery).toBe(withoutQuery);
    });
});

describe('fetch: transport failure classes (issue 0015)', () => {
    // One sentence per class, pinned whole. Each states whether retrying is
    // plausible, which is the decision the class exists to inform.
    const DNS_MESSAGE =
        'fetch could not resolve this hostname (DNS found no address for it). Check the URL — the host was never reached, so retrying will not help.';
    const CONNECTION_MESSAGE =
        'fetch could not keep a connection to this host (refused or reset). The host was reached, so a retry may help; "provider": "exa" fetches through a different client and may work where the direct GET does not.';
    const TLS_MESSAGE =
        'fetch could not complete the TLS handshake with this host (certificate or protocol error). Retrying will not help: the same handshake fails; "provider": "exa" connects separately and may work.';
    const UNCLASSIFIED_MESSAGE =
        'fetch could not be reached (network error). The cause is not one this tool can classify, so a retry may help; "provider": "exa" fetches through a different client.';

    it('maps every documented cause code to its class', () => {
        // The table directly, including the codes the tool-level tests below do not
        // exercise. `transportFailureMessage` reads only the code — never the
        // message, never the stack.
        expect(transportFailureMessage(transportRejection(causeWithCode('ENOTFOUND')))).toBe(DNS_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('EAI_AGAIN')))).toBe(DNS_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('ECONNREFUSED')))).toBe(CONNECTION_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('ECONNRESET')))).toBe(CONNECTION_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('EPIPE')))).toBe(CONNECTION_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('ERR_TLS_CERT_ALTNAME_INVALID')))).toBe(TLS_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('DEPTH_ZERO_SELF_SIGNED_CERT')))).toBe(TLS_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('CERT_HAS_EXPIRED')))).toBe(TLS_MESSAGE);
        // The prefix rules cover the long tail of handshake codes.
        expect(transportFailureMessage(transportRejection(causeWithCode('ERR_SSL_WRONG_VERSION')))).toBe(TLS_MESSAGE);
        expect(transportFailureMessage(transportRejection(causeWithCode('EPROTO')))).toBe(TLS_MESSAGE);
        // A dual-stack (happy-eyeballs) failure nests its codes one level deeper,
        // and a body-stream failure carries the code on the error itself.
        expect(
            transportFailureMessage(transportRejection({ errors: [causeWithCode('ENOTFOUND'), causeWithCode('ECONNREFUSED')] }))
        ).toBe(DNS_MESSAGE);
        expect(transportFailureMessage(causeWithCode('ECONNRESET'))).toBe(CONNECTION_MESSAGE);
        // Anything unrecognised — including no error at all — keeps the historical
        // sentence rather than guessing a class.
        expect(transportFailureMessage(new Error('no code, no cause'))).toBe(UNCLASSIFIED_MESSAGE);
        expect(transportFailureMessage(undefined)).toBe(UNCLASSIFIED_MESSAGE);
    });

    it('gives a name that does not resolve its own sentence, and says retrying will not help', async () => {
        stubFetch(() => {
            throw transportRejection(causeWithCode('ENOTFOUND'));
        });

        const message = await failureMessage({ url: 'https://example.com/typo-does-not-exist' });

        expect(message).toBe(DNS_MESSAGE);
        expect(message).toContain('retrying will not help');
    });

    it('gives a host that refuses the connection its own sentence, and says a retry may help', async () => {
        stubFetch(() => {
            throw transportRejection(causeWithCode('ECONNREFUSED'));
        });

        const refused = await failureMessage({ url: 'https://example.com/refused' });

        stubFetch(() => {
            throw transportRejection(causeWithCode('ECONNRESET'));
        });

        const reset = await failureMessage({ url: 'https://example.com/reset' });

        expect(refused).toBe(CONNECTION_MESSAGE);
        expect(reset).toBe(CONNECTION_MESSAGE);
        expect(refused).toContain('a retry may help');
        // Acceptance criterion 1: the two situations are no longer one sentence.
        expect(refused).not.toBe(DNS_MESSAGE);
    });

    it('names the verified provider fallback in the reachable-but-failing case', async () => {
        // The proposal's step 2: `provider: "exa"` is named where it was measured to
        // work (it reached httpbin.org/html on 2026-11-10 where the GET failed 5/5),
        // and not named in the DNS class, where a different client changes nothing.
        stubFetch(() => {
            throw transportRejection(causeWithCode('ECONNRESET'));
        });

        const connection = await failureMessage({ url: 'https://example.com/reset' });

        stubFetch(() => {
            throw transportRejection(causeWithCode('EAI_AGAIN'));
        });

        const dns = await failureMessage({ url: 'https://example.com/again' });

        expect(connection).toContain('"provider": "exa"');
        expect(dns).toBe(DNS_MESSAGE);
        expect(dns).not.toContain('exa');
    });

    it('classifies a reset that lands mid-body, not only one on the request', async () => {
        // The body stream fails with the bare errno, the way a real reset does: the
        // `cause.code` shape is not the only one reachable, and the httpbin case in
        // the issue is exactly this one.
        const reset = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('# Page\n\nbody'));
                controller.error(causeWithCode('ECONNRESET'));
            }
        });

        stubFetch(() => response(reset, { headers: { 'content-type': 'text/plain' } }));

        await expect(call(keyless(), { url: 'https://example.com/mid-body' })).rejects.toThrow(
            CONNECTION_MESSAGE
        );
    });

    it('reports a failed TLS handshake as its own class', async () => {
        stubFetch(() => {
            throw transportRejection(causeWithCode('ERR_TLS_CERT_ALTNAME_INVALID'));
        });

        const message = await failureMessage({ url: 'https://example.com/bad-cert' });

        expect(message).toBe(TLS_MESSAGE);
        expect(message).toContain('Retrying will not help');
    });

    it('keeps the historical sentence for a cause it cannot classify', async () => {
        stubFetch(() => {
            throw new TypeError('fetch failed');
        });

        const message = await failureMessage({ url: 'https://example.com/unknown' });

        expect(message).toBe(UNCLASSIFIED_MESSAGE);
        // A caller that matched the old string still recognizes the failure.
        expect(message.startsWith('fetch could not be reached (network error).')).toBe(true);
    });

    it('leaks no page body and no stack into a transport message', async () => {
        // Acceptance criterion 4: classification names a class. The raw error text —
        // here an HTML error page and a stack-shaped tail — stays out of the
        // transcript, exactly as the sanitization rule in ./request.ts:37-40 requires.
        const body = '<html><head>502 Bad Gateway</head></html>';
        const cause = causeWithCode('ECONNRESET', `connect ECONNRESET 203.0.113.9:443\n${body}\n at Socket.onclose (node:internal)`);

        stubFetch(() => {
            throw transportRejection(cause);
        });

        const message = await failureMessage({ url: 'https://example.com/noisy' });

        expect(message).toBe(CONNECTION_MESSAGE);
        expect(message).not.toContain('502 Bad Gateway');
        expect(message).not.toContain('203.0.113.9');
        expect(message).not.toContain('node:internal');
    });

    it('still reports the timeout sentence when an aborted request also carries a cause', async () => {
        // The abort check stays the FIRST discriminator: a timeout that also happens
        // to surface an errno must not be reclassified as a transport failure, and
        // the timeout sentence itself is unchanged (issue 0015 criterion 3).
        vi.useFakeTimers();

        stubFetch((_url, init) => {
            const signal = (init as RequestInit).signal as AbortSignal;

            return new Promise<Response>((_, reject) => {
                signal.addEventListener('abort', () => {
                    reject(transportRejection(causeWithCode('ECONNRESET')));
                });
            });
        });

        const pending = call(keyless(), { url: 'https://example.com/slow' });
        pending.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);

        await expect(pending).rejects.toThrow(`fetch timed out after ${FETCH_TIMEOUT_MS} ms.`);

        vi.useRealTimers();
    });
});

describe('fetch: query-mode truncation causes and ordering (issue 0016)', () => {
    // The synthetic heading label of each returned section, in the order the answer
    // delivered them. Only lines shaped `[line N]` count, because a section's own
    // markdown heading appears verbatim in its text right below the label.
    const returnedHeadings = (result: WebFetchResult): string[] =>
        result.content
            .split('\n')
            .filter((line) => /^## .+ \[line \d+\]$/.test(line))
            .map((line) => line.slice(3, line.indexOf(' [line')));

    // `count` sections of identical length: one hit each in equal-length blocks means
    // equal density, so these cases isolate the CAP from the ranking.
    const equalSections = (count: number): string =>
        Array.from(
            { length: count },
            (_, index) =>
                `## Section ${String(index + 1).padStart(2, '0')}\n\nquantum entry ${String(index + 1).padStart(2, '0')}.`
        ).join('\n\n');

    const plainPage = (body: string) => () => response(body, { headers: { 'content-type': 'text/plain' } });

    it('names the section cap as the cause when MAX_QUERY_BLOCKS closes the answer', async () => {
        stubFetch(plainPage(equalSections(24)));

        const result = await call(keyless(), { url: 'https://example.com/capped', query: 'quantum' });

        // The cap the description promises, pinned as a number before it is used.
        expect(MAX_QUERY_BLOCKS).toBe(20);
        expect(result.matches).toBe(20);
        expect(result.totalMatches).toBe(24);
        expect(result.totalSections).toBe(24);
        expect(result.truncated).toBe(true);
        // Acceptance criterion 2: the cap is named as the cause, distinctly from a
        // byte-budget cut, and no resumable offset is promised — the withheld
        // sections are not one page away, because selection ran on the whole page.
        expect(result.stopReason).toBe('resultCap');
        expect(result.nextOffset).toBeUndefined();
        expect(result.offset).toBeUndefined();
        // Exact survivors: equal densities keep document order, so sections 01-20.
        expect(returnedHeadings(result)).toEqual(
            Array.from({ length: 20 }, (_, index) => `Section ${String(index + 1).padStart(2, '0')}`)
        );
        expect(result.content).not.toContain('## Section 21 [line');
    });

    it('reports no cause and no nextOffset when the query answer was whole', async () => {
        stubFetch(plainPage(equalSections(3)));

        const result = await call(keyless(), { url: 'https://example.com/whole', query: 'quantum' });

        expect(result.matches).toBe(3);
        expect(result.totalMatches).toBe(3);
        expect(result.truncated).toBe(false);
        expect(result.stopReason).toBeUndefined();
        expect(result.nextOffset).toBeUndefined();
    });

    it('reports a resumable nextOffset when the byte budget cuts the answer', async () => {
        // Six sections of ~15,000 characters each: the joined answer is 90,331
        // characters, so the content byte budget (MAX_RESULT_CONTENT_BYTES, 63,488)
        // cuts it inside section 05. Every section ends with its own marker, so
        // "resumed correctly" is a fact rather than a claim.
        const page = Array.from(
            { length: 6 },
            (_, index) => {
                const label = String(index + 1).padStart(2, '0');

                return `## Section ${label}\n\nquantum ${'x'.repeat(15_000)} END-${label}`;
            }
        ).join('\n\n');

        stubFetch(plainPage(page));

        const result = await call(keyless(), { url: 'https://example.com/long', query: 'quantum' });

        // Acceptance criterion 1: a budget cut says so, and it is resumable.
        expect(result.stopReason).toBe('contentBudget');
        expect(result.truncated).toBe(true);
        expect(result.matches).toBe(6);
        expect(result.totalMatches).toBe(6);
        // Exact: an all-ASCII answer lands precisely on the byte budget.
        expect(result.characters).toBe(MAX_RESULT_CONTENT_BYTES);
        // The cut landed inside section 05: 04 came through whole, 05 did not.
        expect(result.content).toContain('END-04');
        expect(result.content).not.toContain('END-05');

        const nextOffset = result.nextOffset as number;

        // The offset is the exact continuation. Layout arithmetic, from the fixture:
        // each section block occupies 4 lines, so the heading labels are 1, 5, 9, 13,
        // 17, 21 — 23-character labels for sections 01-03 (one digit) and 24 for the
        // rest; every section text is 15,030 characters; blocks are joined by "\n\n".
        // That puts section 05's text at 60,245 in the joined answer, and the budget
        // keeps 63,488 - 60,245 = 3,243 characters of it.
        expect(nextOffset).toBe(page.indexOf('## Section 05') + 3_243);
        // Which is also, character for character, where the answer stopped.
        expect(page.slice(nextOffset - 24, nextOffset)).toBe(result.content.slice(-24));

        // And re-fetching at that offset (WITHOUT `query`, which ignores `offset`)
        // returns the matching content the cut answer never delivered.
        const resumed = await call(keyless(), { url: 'https://example.com/long', offset: nextOffset });

        expect(resumed.offset).toBe(nextOffset);
        expect(resumed.content.startsWith(page.slice(nextOffset, nextOffset + 40))).toBe(true);
        expect(resumed.content).toContain('END-05');
        expect(resumed.content).toContain('END-06');
    });

    it('orders a query answer by hits per character instead of by document position', async () => {
        // Acceptance criterion 4: one hit in each of three sections, so LENGTH alone
        // decides the ranking — the shortest first, the 2,000-character References
        // block last. The measured motivation in the issue: on a long article the
        // `## References` section took ~75% of one answer because length, not
        // relevance, was buying its slot.
        const page = [
            '## Intro', '', `quantum ${'a'.repeat(300)}`, '',
            '## References', '', `quantum ${'b'.repeat(2000)}`, '',
            '## Details', '', `quantum ${'c'.repeat(60)}`, ''
        ].join('\n');

        stubFetch(plainPage(page));

        const result = await call(keyless(), { url: 'https://example.com/density', query: 'quantum' });

        expect(returnedHeadings(result)).toEqual(['Details', 'Intro', 'References']);
        // Deprioritized, never excluded: a section that matches is still returned.
        expect(result.matches).toBe(3);
        expect(result.totalMatches).toBe(3);
        expect(result.truncated).toBe(false);
    });

    it('lets the dense sections survive the cap and drops the longest match', async () => {
        // One 6,000-character wall FIRST in the document, twenty small sections after
        // it. Document order put the wall in the answer; density puts it last, so the
        // cap drops it and keeps all twenty small sections.
        const small = (index: number): string => `## Small ${String(index).padStart(2, '0')}\n\nquantum entry.`;

        const page = [
            `## Wall\n\nquantum ${'w'.repeat(6_000)}`,
            ...Array.from({ length: 20 }, (_, index) => small(index))
        ].join('\n\n');

        stubFetch(plainPage(page));

        const result = await call(keyless(), { url: 'https://example.com/wall', query: 'quantum' });

        expect(result.totalMatches).toBe(21);
        expect(result.matches).toBe(20);
        expect(result.stopReason).toBe('resultCap');
        expect(returnedHeadings(result)).toEqual(
            Array.from({ length: 20 }, (_, index) => `Small ${String(index).padStart(2, '0')}`)
        );
        expect(result.content).not.toContain('## Wall [line');
    });

    it('ignores offset when query is set, exactly as the parameter description says', async () => {
        const page = ['## Installation', '', 'Run npm install.', '', '## Usage', '', 'Call the tool.'].join('\n');

        stubFetch(plainPage(page));

        const withoutOffset = await call(keyless(), { url: 'https://example.com/manual', query: 'install' });
        const withOffset = await call(keyless(), {
            url: 'https://example.com/manual',
            query: 'install',
            offset: 12
        });

        // Section selection runs on the whole converted page, so there is no window
        // for `offset` to move: the answer is identical, and no `offset` is echoed as
        // if the argument had been applied.
        expect(withOffset).toEqual(withoutOffset);
        expect(withOffset.offset).toBeUndefined();
        expect(withOffset.content).toContain('Run npm install.');
    });

    it('reports the withheld occurrences of a proximity answer without promising a resume', async () => {
        // A heading-less page answers with one window around the FIRST occurrence.
        // The other 300 occurrences are the withheld matches, and paging the page
        // cannot recover them as a section — so the cause is named and no `nextOffset`
        // is offered.
        const page = `${'alpha needle beta '.repeat(300)}\ngamma needle delta`;

        stubFetch(plainPage(page));

        const result = await call(keyless(), { url: 'https://example.com/flat', query: 'needle' });

        expect(result.matchMode).toBe('proximity');
        expect(result.matches).toBe(1);
        expect(result.totalMatches).toBe(301);
        expect(result.truncated).toBe(true);
        expect(result.stopReason).toBe('resultCap');
        expect(result.nextOffset).toBeUndefined();
        expect(result.note).toContain('no heading structure');
    });

    it('states the offset/query rule where the caller reads it', () => {
        // Acceptance criterion 3: the rule used to exist only in source.
        const properties = (
            keyless().parameters as unknown as { properties: Record<string, { description: string }> }
        ).properties;

        expect(properties.offset.description).toContain('IGNORED when "query" is set');
        expect(properties.offset.description).toContain('"stopReason": "resultCap"');
        expect(properties.query.description).toContain('Up to 20 sections.');
    });
});
