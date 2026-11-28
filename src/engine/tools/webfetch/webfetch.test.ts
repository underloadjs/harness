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
import { createWebFetchTool, WEB_FETCH_METADATA } from '../../index';
import type { Tool, WebFetchParameters, WebFetchResult } from '../../index';
// The delivery contract is core's, so the fit is tested against the SAME helpers
// the delivery site uses: `boundToolResult` is what actually decides whether a
// result reaches the transcript, and `modelPayloadBytes` is the currency it counts
// (escaped JSON bytes, not UTF-8 text bytes — see core/payload-bytes.ts). Tests are
// allowed to import values from core; the compiled tool entry may not (its result is
// captured with the dependency closed).
import { MODEL_TOOL_RESULT_BUDGET_BYTES, boundToolResult, modelPayloadBytes } from '../../core';
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
    MAX_TITLE_CHARS,
    MAX_URL_CHARS,
    RESULT_FIT_SAFETY_BYTES,
    RESULT_OVERHEAD_BYTES,
    binaryExtension,
    charsetFrom,
    isPrivateHost,
    resolvePublicHost,
    safeFetchUrl,
    transportFailureMessage
} from './request';
// The two measuring helpers and the two proximity sentences, pinned from the module
// that owns them (the tools directory is internal — none of this reaches the package
// surface). The helpers must agree with core's table byte for byte (F1), and the
// sentences are exact model-facing text (F9), so both belong in an assertion.
import {
    CONTENT_QUOTES_BYTES,
    PROXIMITY_NOTE_CUT,
    PROXIMITY_NOTE_WHOLE,
    jsonTextBytes,
    resultStringBytes,
} from './index';
// The window bound (F3): the excerpt may never exceed the window plus the two
// bounded line-snaps.
import { PROXIMITY_LINE_SNAP_CHARS, PROXIMITY_WINDOW_CHARS } from './sections';

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

// The tool's own parameter contract accepts a bare URL string as well as the object
// (`readInvocation`, ./index.ts:273-279 — "direct callers may pass the bare URL"), and
// one test below pins that shorthand. `Tool<P, R>`'s CALL signature (types/index.ts
// :3513) declares only `(parameters: P)`, so the union has to be narrowed at the call
// site; the cast states the gap rather than hiding a wrong assumption.
const call = async (
    definition: Tool<WebFetchParameters, WebFetchResult>,
    parameters: WebFetchParameters | string
): Promise<WebFetchResult> =>
    (await definition(parameters as WebFetchParameters)) as WebFetchResult;

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

// `headers` belongs to this init type as much as it belongs to `response`'s: callers
// below add a content type on top of the html default, and without the field the
// spread had no type to spread (the package tsconfig excludes `**/*.test.ts`, so only
// an explicit `tsc -p` over the suites can see either of these two errors).
const html = (
    markup: string,
    init?: { status?: number; headers?: Record<string, string>; url?: string }
): Response =>
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
        // The harness caps every tool result at the model-facing budget — 32 KiB of
        // ESCAPED payload bytes — and for a JSON document it does not shrink the
        // value, it REFUSES the whole thing (`reason: 'oversized-json'`) and the call
        // is reported as failed, which drops the url/title/truncated/nextOffset a
        // model needs in order to resume (core/result-budget.ts:642-745). fetch sizes
        // itself to that cap in the cap's own currency so it keeps its own shape and
        // stays resumable; MAX_CONTENT_CHARS is the per-PAGE bound, reached by paging.
        expect(MAX_RESULT_BYTES).toBe(MODEL_TOOL_RESULT_BUDGET_BYTES);
        expect(MAX_RESULT_BYTES).toBe(32 * 1024);
        expect(MAX_RESULT_CONTENT_BYTES).toBe(MAX_RESULT_BYTES - RESULT_OVERHEAD_BYTES);
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
        // One RESULT is capped by the harness model-facing budget (32 KiB of escaped
        // payload), not by MAX_CONTENT_CHARS: the page is bounded at 240,000 characters
        // and reached by paging with `offset`, while a single return stays inside the
        // cap so the harness never REFUSES the call outright (for a JSON document an
        // over-budget result is discarded whole, not wrapped in another envelope).
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
            'http://[::1]/x',
            // The top of the CGNAT block, as a raw quad and as a mapped literal: before the
            // /10 fix both were fetched, and the second is the same address written twice.
            'http://100.127.255.255/x',
            'http://[::ffff:100.127.0.1]/x'
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
        // Six sections of ~7,000 characters each: the joined answer is ~42,239
        // characters (each block is its 23-24-character line label plus its 7,015-character
        // body), so the content budget cuts it inside section 05. (The budget is
        // 30,720 ESCAPED bytes, not 30,720 characters, so the cut lands at 29,184
        // characters — see the size-currency expectations below.) Every section ends
        // with its own marker, so "resumed correctly" is a fact rather than a claim.
        const page = Array.from(
            { length: 6 },
            (_, index) => {
                const label = String(index + 1).padStart(2, '0');

                return `## Section ${label}\n\nquantum ${'x'.repeat(7_000)} END-${label}`;
            }
        ).join('\n\n');

        stubFetch(plainPage(page));

        const result = await call(keyless(), { url: 'https://example.com/long', query: 'quantum' });

        // Acceptance criterion 1: a budget cut says so, and it is resumable.
        expect(result.stopReason).toBe('contentBudget');
        expect(result.truncated).toBe(true);
        expect(result.matches).toBe(6);
        expect(result.totalMatches).toBe(6);
        // Exact: the answer's newlines cost one escaped byte each, so the FIRST
        // candidate (the whole 30,720-byte budget) overshoots and one 5 % step fires:
        // 30,720 − floor(30,720 × 0.05) = 29,184 characters. Pinning the figure rather
        // than `MAX_RESULT_CONTENT_BYTES` is the point — characters and bytes are
        // different units (F13), and this is the tool's own arithmetic.
        expect(result.characters).toBe(29_184);
        // The cut landed inside section 05: 04 came through whole, 05 did not.
        expect(result.content).toContain('END-04');
        expect(result.content).not.toContain('END-05');

        const nextOffset = result.nextOffset as number;

        // The offset is the exact continuation. From the fixture: each page block is
        // 7,030 characters (13-character heading, blank line, 7,015-character text)
        // joined by "\n\n", so section 05 starts at 28,128 and its text at 28,143;
        // 939 of those characters are the 15 the heading and blank line occupy plus the
        // 924 the answer delivered of the body.
        expect(nextOffset).toBe(28_128 + 939);
        expect(page.indexOf('## Section 05')).toBe(28_128);
        // Which is also, character for character, where the answer stopped.
        expect(page.slice(nextOffset - 24, nextOffset)).toBe(result.content.slice(-24));

        // And re-fetching at that offset (WITHOUT `query`, which ignores `offset`)
        // returns the matching content the cut answer never delivered.
        const resumed = await call(keyless(), { url: 'https://example.com/long', offset: nextOffset });

        expect(resumed.offset).toBe(nextOffset);
        expect(resumed.content.startsWith(page.slice(nextOffset, nextOffset + 40))).toBe(true);
        expect(resumed.content).toContain('END-05');
        expect(resumed.content).toContain('END-06');
        // The whole remainder fits in one window, so the resume is not itself cut.
        expect(resumed.characters).toBe(13_123);
        expect(resumed.truncated).toBe(false);
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
        // The other 300 occurrences are counted and reported, but they are NOT a
        // withheld part of the answer: the window itself arrived whole, and the
        // `MAX_QUERY_BLOCKS` section cap this cause names never applied (F4). Claiming
        // `resultCap` here told the caller its answer had been trimmed when it had not.
        const page = `${'alpha needle beta '.repeat(300)}\ngamma needle delta`;

        stubFetch(plainPage(page));

        const result = await call(keyless(), { url: 'https://example.com/flat', query: 'needle' });

        expect(result.matchMode).toBe('proximity');
        expect(result.matches).toBe(1);
        expect(result.totalMatches).toBe(301);
        // The window is what it is: whole, with no cause and nothing to resume.
        expect(result.truncated).toBe(false);
        expect(result.stopReason).toBeUndefined();
        expect(result.nextOffset).toBeUndefined();
        // Exact sentence, from the module that owns it (F9): it no longer advises
        // `offset`, which `query` ignores, and it says plainly that there is no
        // `nextOffset` to pass back.
        expect(result.note).toBe(PROXIMITY_NOTE_WHOLE);
        expect(result.note).not.toContain('Use `offset` to read further');
        // The 301 occurrences do not become a cause, and they do not become a page:
        // a `query` answer never carries an `offset`, cut or whole.
        expect(result.offset).toBeUndefined();
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

// ---------------------------------------------------------------------------
// F1 — the one bound that decides whether the result ARRIVES
// ---------------------------------------------------------------------------
//
// The delivery site measures `JSON.stringify(result)` with `modelPayloadBytes`
// (core/payload-bytes.ts) — ESCAPED bytes, not UTF-8 text bytes — and for a JSON
// document it does not shrink an over-budget value: it refuses the whole thing and
// the call is reported as failed (core/result-budget.ts:690 `boundWithReason`,
// `reason: 'oversized-json'`, reached from :789 `boundToolResult`). A character-count
// fit therefore shipped "30,720
// characters" and lost the entire answer — url, title, contentType and the
// `nextOffset` a resume needs — on exactly the pages whose text escapes widest.
//
// These tests call the tool and measure the result with core's OWN helpers, so the
// contract under test is delivery, not an internal constant.
describe('fetch: one result inside the cap, counted in the cap\'s currency', () => {
    // Measures a delivered result exactly as the delivery site does. It takes the
    // serialized value rather than a WebFetchResult because one case below measures the
    // shape the OLD fit produced, which is no longer a type this tool returns.
    // (The local `response`/`html` helpers above carry two type errors that
    // `check-package-types.ts` cannot see: the package tsconfig excludes
    // `**/*.test.ts`. They predate this pass, and `yarn tsc -p` over the two webfetch
    // suites reports exactly those two and nothing else added by it.)
    const measure = (result: unknown) => {
        const json = JSON.stringify(result);

        return {
            payload: modelPayloadBytes(json),
            // `undefined` means the result reaches the transcript; anything else is
            // the refusal that turns a successful fetch into a failed call.
            rejected: boundToolResult(json, MODEL_TOOL_RESULT_BUDGET_BYTES, {
                source: { name: 'fetch' }
            }).rejected,
        };
    };

    // The widest field envelope the result can carry: a url at MAX_URL_CHARS, a
    // title at MAX_TITLE_CHARS, and a declared content type. Every one of them is
    // inside the same envelope as `content`, which is the point of F1.
    const longUrl = `https://example.com/${'a'.repeat(MAX_URL_CHARS - 20)}`;
    const wideTitle = '中'.repeat(MAX_TITLE_CHARS);
    const wideHtml = (body: string) =>
        `<!doctype html><html><head><title>${wideTitle}</title></head><body>${body}</body></html>`;

    const stubWideHtml = (body: string) =>
        stubFetch(() =>
            response(wideHtml(body), { headers: { 'content-type': 'text/html; charset=utf-8' } })
        );

    it('ships the widest ASCII result at the exact budget its own fields leave', async () => {
        // 'x' has no escape cost, so the delivered count IS the budget the fields
        // leave: the cap minus the measured envelope of the skeleton, minus the
        // safety allowance. Pinned exactly, because the envelope is fixed here (the
        // url and title are fixed above) and the arithmetic is the tool's.
        expect(longUrl.length).toBe(MAX_URL_CHARS);
        stubWideHtml('x'.repeat(MAX_RESULT_CONTENT_BYTES));

        const result = await call(keyless(), { url: longUrl, format: 'text' });
        const { payload, rejected } = measure(result);

        // The envelope this result carries — a 2,048-character url, a 300-character CJK
        // title (900 bytes, because core charges the UTF-8 width of a non-ASCII
        // character), the content type, the keys, and the 4 bytes of `content` quotes —
        // is 3,183 bytes. 'x' costs one escaped byte each, so the fit ships exactly
        // 32,768 − 3,183 − 64 = 29,521 of it, and the document lands on the ceiling the
        // module promises.
        expect(result.title).toBe(wideTitle);
        expect(result.characters).toBe(29_521);
        expect(result.content).toBe('x'.repeat(29_521));
        expect(result.nextOffset).toBe(29_521);
        expect(result.truncated).toBe(true);
        expect(rejected).toBeUndefined();
        // The guarantee the fit documents: the whole result stays this far inside the
        // cap, whatever the fields cost.
        expect(payload).toBeLessThanOrEqual(MAX_RESULT_BYTES - RESULT_FIT_SAFETY_BYTES);
        expect(payload).toBe(32_703);
    });

    it('shrinks text that escapes wider than it is, instead of shipping a refusal', async () => {
        // Each case is the SAME 30,720 characters of page text, in shapes whose
        // escaped widths differ by more than 7x. A character-count fit would ship all
        // four at the full 30,720; only the first one delivers.
        // The delivered counts are the fit's own arithmetic, not the page length: the
        // first candidate is the byte budget, and while the escaped form is over it the
        // loop steps back 5 % at a time (./index, `fitResult`). With the same envelope as
        // the test above the budget starts at 29,521 bytes, and each shape stops at the
        // first candidate whose ESCAPED cost fits: 7,028 / 4,211 / 9,557 / 14,402
        // characters. Every one is a fraction of the 30,720 a character-count fit would
        // ship, and that gap is the defect: the pages that lose the most text are the
        // ones the old arithmetic refused outright.
        const cases: Array<[string, string, number]> = [
            ['quotes and backslashes', '\\"'.repeat(MAX_RESULT_CONTENT_BYTES / 2), 7_028],
            ['control characters', '\u0001'.repeat(MAX_RESULT_CONTENT_BYTES), 4_211],
            ['CJK', '中'.repeat(MAX_RESULT_CONTENT_BYTES), 9_557],
            ['astral pairs', '\ud83c\udf89'.repeat(MAX_RESULT_CONTENT_BYTES / 2), 14_402],
        ];

        for (const [label, body, expectedCharacters] of cases) {
            stubWideHtml(body);

            const result = await call(keyless(), { url: longUrl, format: 'text' });
            const { payload, rejected } = measure(result);

            expect([label, result.characters]).toEqual([label, expectedCharacters]);
            // The text really was cut — these pages are the ones the old fit lost.
            expect([label, result.content.length]).toEqual([label, expectedCharacters]);
            expect([label, result.truncated]).toEqual([label, true]);
            expect([label, rejected]).toEqual([label, undefined]);
            expect([label, payload <= MAX_RESULT_BYTES - RESULT_FIT_SAFETY_BYTES]).toEqual([label, true]);
        }
    });

    it('loses the whole result when the fit counts characters and the cap counts bytes', async () => {
        // The failure mode F1 fixes, pinned as a fact: one result at the old ceiling,
        // with the same fields as above, measured by the helper that decides delivery.
        const naive = {
            url: longUrl,
            contentType: 'text/html',
            title: wideTitle,
            characters: MAX_RESULT_CONTENT_BYTES,
            truncated: true,
            nextOffset: MAX_RESULT_CONTENT_BYTES,
            content: '中'.repeat(MAX_RESULT_CONTENT_BYTES),
        };

        expect(measure(naive).rejected?.reason).toBe('oversized-json');
    });

    it('counts bytes in exactly the currency core counts them in', async () => {
        // The local table must agree with core's, byte for byte, in both directions:
        // the raw JSON text (what the cap measures) and a string nested inside that
        // text (what the content budget measures). A silent drift here re-opens F1.
        expect(MAX_RESULT_BYTES).toBe(MODEL_TOOL_RESULT_BUDGET_BYTES);

        const samples = [
            '',
            'plain ascii',
            '"quote" \\ backslash',
            'tab\tnl\ncr\rbs\bff\f',
            '\u0001\u001f',
            'café 中文 \ud83c\udf89',
            '\ud83d',
            '<h1>&amp;</h1>',
        ];

        for (const sample of samples) {
            const jsonText = JSON.stringify(sample);

            expect([sample, jsonTextBytes(jsonText)]).toEqual([sample, modelPayloadBytes(jsonText)]);
            // The nested measure costs the same text less the value's own quotes: the
            // 4 bytes that sit inside the priced envelope (`CONTENT_QUOTES_BYTES`),
            // which is why the budget is the cap minus the WHOLE envelope.
            expect(CONTENT_QUOTES_BYTES).toBe(jsonTextBytes('""'));
            expect([sample, resultStringBytes(sample)]).toEqual([sample, modelPayloadBytes(jsonText) - CONTENT_QUOTES_BYTES]);
        }
    });

    it('prices the envelope and the content so the two add up to the document', () => {
        // The budget formula is only honest because escaping is per-character and
        // context-free: the cost of the document with `content` in it is the cost of the
        // priced skeleton PLUS the cost of the content in the nested currency, with no
        // interaction between the two. Pinned across the shapes that escape widest — an
        // interaction there would turn the guarantee back into "close enough", which is
        // how the 3-byte gap that this test closes got away in the first place.
        const fields = {
            provider: 'native',
            url: longUrl,
            contentType: 'text/html; charset=utf-8',
            format: 'text',
            characters: MAX_RESULT_CONTENT_BYTES,
            truncated: false,
            nextOffset: MAX_RESULT_CONTENT_BYTES,
        };

        const contents = [
            'x'.repeat(1_000),
            '\\"'.repeat(500),
            '\u0001'.repeat(300),
            '中'.repeat(400),
            '\ud83c\udf89'.repeat(300),
            'a\n"b\\c\u0001d',
        ];

        for (const content of contents) {
            const envelope = jsonTextBytes(JSON.stringify({ ...fields, content: '' }));
            const whole = jsonTextBytes(JSON.stringify({ ...fields, content }));

            expect([content.slice(0, 6), whole]).toEqual([
                content.slice(0, 6),
                envelope + resultStringBytes(content),
            ]);
        }
    });
});

// ---------------------------------------------------------------------------
// F3 — the proximity window stays a window
// ---------------------------------------------------------------------------
describe('fetch: a proximity window is bounded even on a page with no newlines', () => {
    // A heading-less answer is ONE window around the first match. Both edges used to
    // snap to a line boundary without limit, and the close edge fell through to the
    // end of the document whenever no newline followed it — so on a page that is one
    // long line (minified HTML, pasted plain text, a CSV with its CRLFs converted
    // away) the "window" was the rest of the document: the exact cost the mode exists
    // to avoid.
    const flat = `${'A'.repeat(40_000)}needle at the middle${'B'.repeat(40_000)}`;

    it('cuts the window at its bound instead of at the end of the line', async () => {
        stubFetch(
            () => response(flat, { headers: { 'content-type': 'text/plain' } })
        );

        const result = await call(keyless(), { url: 'https://example.com/flat', query: 'needle' });

        // Exact: the label line, then the window — 3,000 characters of context on each
        // side of the match, no more. Before the fix this answer was ~43,000 characters.
        expect(result.content).toBe(
            `## (no heading) [line 1]\n${'A'.repeat(3_000)}needle at the middle${'B'.repeat(2_980)}`
        );
        expect(result.characters).toBe(25 + PROXIMITY_WINDOW_CHARS);
        expect(result.truncated).toBe(false);
        // The documented ceiling: the window plus one bounded snap on each edge.
        expect(result.characters).toBeLessThanOrEqual(
            25 + PROXIMITY_WINDOW_CHARS + 2 * PROXIMITY_LINE_SNAP_CHARS
        );
    });

    it('still snaps to line boundaries where the boundary is close', async () => {
        // The other half of the rule: snapping is a readability feature and must
        // survive, so a page of short lines still opens and closes on whole lines.
        const lines = `${'A'.repeat(50)}\n`.repeat(1_000) + 'needle here\n' + `${'B'.repeat(50)}\n`.repeat(1_000);

        stubFetch(() => response(lines, { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com/lines', query: 'needle' });

        expect(result.characters).toBe(6_057);
        expect(result.content.split('\n')[1]).toBe('A'.repeat(50));
        expect(result.content.endsWith('B'.repeat(50))).toBe(true);
        expect(result.characters).toBeLessThanOrEqual(
            25 + PROXIMITY_WINDOW_CHARS + 2 * PROXIMITY_LINE_SNAP_CHARS
        );
    });
});

// ---------------------------------------------------------------------------
// F9 — what a proximity answer promises
// ---------------------------------------------------------------------------
describe('fetch: a proximity note only promises what the tool can honour', () => {
    it('points at the reported nextOffset when the window really was cut', async () => {
        // A 6,000-character window of control characters escapes to ~36,000 bytes, so
        // the result budget cuts it and a resume pointer exists. The sentence that
        // names that pointer must be the one that ships — and it has to say which
        // argument to drop, because `offset` does nothing while `query` is set.
        // (The url is fixed because the delivered count depends on the result
        // envelope: these figures are the fit's arithmetic, not a bound.)
        const page = `${'\u0001'.repeat(40_000)}needle${'\u0001'.repeat(40_000)}`;

        stubFetch(() => response(page, { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com/dense', query: 'needle' });

        expect(result.note).toBe(PROXIMITY_NOTE_CUT);
        expect(result.stopReason).toBe('contentBudget');
        expect(result.truncated).toBe(true);
        expect(result.characters).toBe(4_210);
        expect(result.nextOffset).toBe(41_185);
        // The pointer is the exact continuation, character for character.
        expect(page.slice((result.nextOffset as number) - 10, result.nextOffset as number)).toBe(
            result.content.slice(-10)
        );
        // The cut window still delivers: the whole result stays inside the cap.
        expect(modelPayloadBytes(JSON.stringify(result))).toBeLessThanOrEqual(
            MAX_RESULT_BYTES - RESULT_FIT_SAFETY_BYTES
        );

        // And following it — WITHOUT `query`, which is the whole advice — reads on.
        stubFetch(() => response(page, { headers: { 'content-type': 'text/plain' } }));

        const resumed = await call(keyless(), { url: 'https://example.com/dense', offset: result.nextOffset });

        expect(resumed.offset).toBe(41_185);
        expect(resumed.characters).toBe(4_384);
        expect(resumed.content.startsWith(page.slice(41_185, 41_225))).toBe(true);
        // A plain windowed read is not a proximity answer, so it carries no such note.
        expect(resumed.note).toBeUndefined();
    });

    it('promises no resume when the window arrived whole', async () => {
        // The pair of the case above: the same mode with nothing withheld. The old
        // sentence told every headingless caller to "Use `offset` to read further",
        // which is an instruction this tool ignores while `query` is set — a model
        // that followed it re-fetched and got the identical window.
        const page = `${'alpha needle beta '.repeat(300)}\ngamma needle delta`;

        stubFetch(() => response(page, { headers: { 'content-type': 'text/plain' } }));

        const result = await call(keyless(), { url: 'https://example.com/flat', query: 'needle' });

        expect(result.note).toBe(PROXIMITY_NOTE_WHOLE);
        expect(result.note).not.toContain('Use `offset` to read further');
        expect(result.note).toContain('No "nextOffset" is reported');
        expect(result.nextOffset).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// F10 — the caller's signal stops the transfer on every provider
// ---------------------------------------------------------------------------
describe('fetch: the caller signal cancels the request in flight', () => {
    // `ToolContext.signal` (types/index.ts:3381) says a tool SHOULD observe it. The
    // GET is the only part of this tool with a side effect worth stopping, and
    // rethrowing the caller's own reason (rather than one of this tool's sentences)
    // is what lets the harness report `cancelled` instead of `failed`.
    const reason = new Error('cancelled by toolCancel');

    // A stub that behaves like a real transport: it rejects with the abort reason
    // when the request's own signal fires, and never resolves otherwise.
    const stubHang = () =>
        stubFetch((_url, init) => {
            const signal = init.signal as AbortSignal;

            return new Promise<Response>((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason ?? reason);
                else signal.addEventListener('abort', () => reject(signal.reason ?? reason), { once: true });
            });
        });

    it('rethrows the caller reason for a native GET', async () => {
        stubHang();

        const controller = new AbortController();
        const pending = keyless().execute({
            parameters: { url: 'https://example.com/slow' },
            signal: controller.signal
        });

        pending.catch(() => undefined);
        controller.abort(reason);

        await expect(pending).rejects.toBe(reason);
    });

    it('rethrows the caller reason when the abort lands while the body is arriving', async () => {
        // The phase that used to be rewritten: a cancellation mid-stream is caught by
        // the body reader, and a body read error would otherwise become "could not
        // read the response body." — a failure, not a cancellation.
        let pullCount = 0;
        let body: ReadableStreamDefaultController<Uint8Array> | undefined;
        // The CALLER's controller — the one handed to `execute`. The stream below
        // aborts it from its third pull, so the cancellation lands while a read is in
        // flight, which is the phase that used to be rewritten.
        const caller = new AbortController();

        stubFetch((_url, init) => {
            const signal = init.signal as AbortSignal;

            const stream = new ReadableStream<Uint8Array>(
                {
                    start(streamController) {
                        body = streamController;
                    },
                    pull(streamController) {
                        pullCount += 1;

                        if (pullCount === 3) {
                            // Two whole chunks delivered, and the third is where the
                            // caller pulls the plug. Nothing is enqueued: the abort below
                            // errors this stream, exactly as a real transport would.
                            caller.abort(reason);

                            return;
                        }

                        streamController.enqueue(new Uint8Array(1024));
                    }
                },
                { highWaterMark: 0 }
            );

            // A real transport errors the body when its signal fires; the stub does the
            // same, which is what puts the throw inside `readBody`. `signal.reason` is
            // the caller's reason because `requestPage` folds one into the other.
            signal.addEventListener('abort', () => body?.error(signal.reason ?? reason), { once: true });

            return Promise.resolve(
                new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } })
            );
        });

        const pending = keyless().execute({
            parameters: { url: 'https://example.com/stream' },
            signal: caller.signal
        });

        await expect(pending).rejects.toBe(reason);
        // Proof the request really got into the body before being cut: exactly two
        // chunks were delivered, and the third pull is where the abort fired.
        expect(pullCount).toBe(3);
    });

    it('rethrows the caller reason when the signal is already aborted', async () => {
        // A listener added to an aborted signal never fires, so the abort has to be
        // forwarded by hand or the call would wait for the timeout.
        stubHang();

        const controller = new AbortController();
        controller.abort(reason);

        await expect(
            keyless().execute({
                parameters: { url: 'https://example.com/too-late' },
                signal: controller.signal
            })
        ).rejects.toBe(reason);
    });

    it('cancels a hosted exa call with the caller reason', async () => {
        stubHang();

        const controller = new AbortController();
        const pending = withExa().execute({
            parameters: { url: 'https://example.com/slow', provider: 'exa' },
            signal: controller.signal
        });

        pending.catch(() => undefined);
        controller.abort(reason);

        // The reason reaches the caller through ./exa, which hands the signal to
        // requestSearch as `callerSignal` (websearch/request.ts maps an aborted caller
        // signal back to its reason rather than to a provider error).
        await expect(pending).rejects.toBe(reason);
    });

    it('cancels a hosted linkup call with the caller reason', async () => {
        stubHang();

        const controller = new AbortController();
        const pending = withLinkup().execute({
            parameters: { url: 'https://example.com/slow', provider: 'linkup' },
            signal: controller.signal
        });

        pending.catch(() => undefined);
        controller.abort(reason);

        await expect(pending).rejects.toBe(reason);
    });
});

// ---------------------------------------------------------------------------
// F13 / F16 — the description states the bounds the tool actually enforces
// ---------------------------------------------------------------------------
describe('fetch: the description matches the enforced bounds', () => {
    it('names the byte cap it enforces, and the unit difference it depends on', () => {
        const definition = keyless();

        // The figures a model reads must be the figures the code enforces: the byte
        // cap is 1 MiB (not 100 KiB) and the page ceiling is 240,000 characters (not
        // 100,000), and the content bound is quoted in the unit it is actually
        // measured in — escaped bytes, not characters.
        expect(definition.description).toContain(`bounded to ${MAX_RESPONSE_BYTES} bytes of body`);
        expect(definition.description).toContain(`${MAX_CONTENT_CHARS} characters`);
        expect(definition.description).toContain(`${MAX_RESULT_CONTENT_BYTES} escaped bytes`);
        expect(definition.description).toContain('DIFFERENT UNITS');
        expect(definition.description).not.toContain('100 KiB');
        expect(definition.description).not.toContain('100,000 characters');
        // And it names the one case the SSRF wording used to overstate: the resolved
        // address gate only runs where names can actually be resolved.
        expect(definition.description).toContain('whenever names can be resolved here');
    });
});



// ---------------------------------------------------------------------------
// SSRF address forms — every notation of a private address is refused
// ---------------------------------------------------------------------------
//
// `isPrivateHost` is the ONLY SSRF protection in force when no resolver is wired
// (`dns: { off: true }`, a browser/bun runtime, and the whole offline suite), so a
// gate that reads only dotted quads and compressed IPv6 text is a gate you walk past
// by writing the same address differently. Measured before this pass:
//   - `http://[2001::200:0:ff00:fffe]/` (Teredo, client 127.0.0.1) reached the
//     network — `new URL` leaves that text alone, so the gate never saw `127.0.0.1`;
//   - the uncompressed IPv6 spellings (`64:ff9b:0:0:0:0:7f00:1`,
//     `0:0:0:0:0:ffff:7f00:1`) answered "public" from the helper, which is also what
//     an injected resolver's answer is checked with;
//   - `http://[2002:7f00:1::]/` (6to4, tunnel endpoint 127.0.0.1) and
//     `http://[2002:a9fe:a9fe::]/` (6to4, tunnel endpoint 169.254.169.254) reached the
//     network in every spelling tried, and an injected lookup ANSWERING a 6to4 loopback
//     was waved through by the second gate as well;
//   - a single-label decimal was answered "public" by the helper too, although
//     `new URL()` itself rewrites `http://2130706433/` to `127.0.0.1` — the URL path
//     was covered by the parser, the helper surface was not.
//
// The oracle for "which address is this really?" is the platform's own host parser, so
// each row below pins BOTH facts: what `new URL()` says the host is, and what the gate
// answers about it. That is what makes a wrong decode visible rather than merely green.
describe('fetch: the address-form gate refuses every notation of a private address', () => {
    // [notation, host text, the address the platform parser says it is]
    const privateIPv4Forms: Array<[string, string, string]> = [
        ['decimal single', '2130706433', '127.0.0.1'],
        ['decimal single, second loopback', '2130706434', '127.0.0.2'],
        ['hex single', '0x7f000001', '127.0.0.1'],
        ['octal single', '017700000001', '127.0.0.1'],
        ['a.b shorthand', '127.1', '127.0.0.1'],
        ['a.b.c shorthand', '127.0.1', '127.0.0.1'],
        ['hex label, decimal tail', '0x7f.1', '127.0.0.1'],
        ['octal label, decimal tail', '0177.1', '127.0.0.1'],
        ['every label hex', '0x7f.0x0.0x0.0x1', '127.0.0.1'],
        ['root label', '127.0.0.1.', '127.0.0.1'],
        ['decimal 10.0.0.1', '167772161', '10.0.0.1'],
        ['decimal metadata ip', '2852039166', '169.254.169.254'],
        ['decimal 172.16.0.1', '2886729729', '172.16.0.1'],
        ['decimal 192.168.1.1', '3232235777', '192.168.1.1'],
        ['decimal 100.64.0.1 (cgnat)', '1681915905', '100.64.0.1'],
        // CGNAT is `100.64.0.0/10`, so the TOP of the block is 100.127.255.255 — a notation the
        // old `startsWith('100.64.')` test answered public, in every spelling. Pinned as a
        // notation row because the platform parser, not the reader, decides it is an address.
        ['decimal 100.127.255.255 (cgnat /10 top edge)', '1686110207', '100.127.255.255'],
        ['a.b.c shorthand 192.0.0.1', '192.0.1', '192.0.0.1'],
    ];

    it('refuses every inet_aton notation of a private address', async () => {
        for (const [notation, host, address] of privateIPv4Forms) {
            // The platform parser is the ground truth for the address; the gate must
            // refuse THAT address, not a guess at the notation.
            expect([notation, new URL(`http://${host}/`).hostname]).toEqual([notation, address]);
            expect([notation, isPrivateHost(host)]).toEqual([notation, true]);
            // The dotted twin is refused by the same rule (./request's `privateIPv4`),
            // which is the whole point of decoding rather than pattern-matching.
            expect([notation, isPrivateHost(address)]).toEqual([notation, true]);
        }

        // And the fetch path refuses them end to end: no request is made for a target
        // the gate can name.
        const fetchMock = stubFetch(() => response('<p>internal</p>'));

        for (const host of ['2130706433', '0x7f000001', '017700000001', '127.1', '2852039166']) {
            expect([host, safeFetchUrl(`http://${host}/`)]).toEqual([host, undefined]);
            await expect(call(keyless(), { url: `http://${host}/` })).rejects.toThrow(
                /not a public absolute http\(s\) address/
            );
        }

        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('still fetches every notation of a public address', async () => {
        // The false-positive guard, which is the part a deny-list widening gets wrong:
        // `134744072` is 8.8.8.8, and an early version of the decoder produced
        // `0.0.0.8` for it (a `256 ** shift` where the shift is in bits), i.e. a public
        // page refused as loopback. Pinned against the parser, not against the reader.
        const publicIPv4Forms: Array<[string, string, string]> = [
            ['decimal single', '134744072', '8.8.8.8'],
            ['hex single', '0x8080808', '8.8.8.8'],
            ['a.b shorthand fills from the right', '172.20', '172.0.0.20'],
            ['a.b.c shorthand', '8.8.1', '8.8.0.1'],
            ['max single', '4294967295', '255.255.255.255'],
            ['public dotted', '93.184.216.34', '93.184.216.34'],
        ];

        stubFetch(() => response('<p>public</p>', { url: 'http://example.com/' }));

        for (const [notation, host, address] of publicIPv4Forms) {
            expect([notation, new URL(`http://${host}/`).hostname]).toEqual([notation, address]);
            expect([notation, isPrivateHost(host)]).toEqual([notation, false]);
            expect([notation, safeFetchUrl(`http://${host}/`) !== undefined]).toEqual([notation, true]);
        }

        // `172.20` is the row worth reading twice: the shorthand puts the last number in
        // the LOW bytes, so it is 172.0.0.20 (public) and not 172.20.0.0 (private). The
        // decode follows the parser, which is also what the connection follows.
        expect(isPrivateHost('172.20.0.0')).toBe(true);

        // A number too big to be an address is a name, not an address: the URL itself is
        // unparseable, so the tool refuses it for that reason rather than as private.
        expect(isPrivateHost('4294967296')).toBe(false);
        expect(safeFetchUrl('http://4294967296/')).toBeUndefined();

        // Names that merely contain digits stay names.
        for (const name of ['example.com', '1a2b.example', '169-254-169-254.nip.io', '1.2.3.4.example']) {
            expect([name, isPrivateHost(name)]).toEqual([name, false]);
        }
    });

    it('refuses an IPv4 embedded in IPv6 text, in either spelling', () => {
        // The prefix rules could only see the COMPRESSED spelling, and `new URL`
        // compresses what it parses — so the forms that matter are the ones that reach
        // the helper or an injected resolver's answer as text: an AAAA record written
        // longhand, or a host the caller hands to the gate directly.
        const embedded: Array<[string, string, string]> = [
            ['mapped compressed', '::ffff:7f00:1', '127.0.0.1'],
            ['mapped uncompressed', '0:0:0:0:0:ffff:7f00:1', '127.0.0.1'],
            ['mapped uncompressed, dotted tail', '0:0:0:0:0:ffff:127.0.0.1', '127.0.0.1'],
            ['mapped, inet_aton tail', '::ffff:0x7f.1', '127.0.0.1'],
            ['compatible', '::7f00:1', '127.0.0.1'],
            ['compatible uncompressed', '0:0:0:0:0:0:7f00:1', '127.0.0.1'],
            ['translated (64:ff9b::/96)', '64:ff9b::7f00:1', '127.0.0.1'],
            ['translated, uncompressed', '64:ff9b:0:0:0:0:7f00:1', '127.0.0.1'],
            ['translated, metadata ip', '64:ff9b::a9fe:a9fe', '169.254.169.254'],
            ['translated, metadata uncompressed', '64:ff9b:0:0:0:0:a9fe:a9fe', '169.254.169.254'],
            // CGNAT in a mapped literal, in BOTH spellings of the tail. The dotted-tail text is
            // the row that used to be answered public: that branch tested the prefix table
            // directly and CGNAT lived only in `privateIPv4`, so `::ffff:100.64.0.1` was public
            // while `100.64.0.1` was refused. The compressed-hex twin went through the decode
            // and was always refused — this is the divergence, and the twin is the proof.
            ['mapped cgnat /16, dotted tail', '::ffff:100.64.0.1', '100.64.0.1'],
            ['mapped cgnat /10 edge, dotted tail', '::ffff:100.127.0.1', '100.127.0.1'],
            ['mapped cgnat /10 edge, compressed groups', '::ffff:647f:1', '100.127.0.1'],
        ];

        for (const [form, text, address] of embedded) {
            expect([form, isPrivateHost(text)]).toEqual([form, true]);
            expect([form, isPrivateHost(address)]).toEqual([form, true]);
            // Every one is refused on the URL path too — by the decode once `new URL()`
            // has compressed the text, by the pre-existing blanket rules this pass kept,
            // or (the `inet_aton` tail inside an IPv6 literal) because the platform
            // parser refuses that spelling outright.
            expect([form, safeFetchUrl(`http://[${text}]/`)]).toEqual([form, undefined]);
        }
    });

    it('refuses a Teredo address whose tunnel endpoint is private', () => {
        // RFC 4380:4 stores the client's IPv4 BITWISE INVERTED in the low 32 bits of a
        // `2001::/32` address, so `ff00:fffe` is 127.0.0.1 and `5601:5601` is
        // 169.254.169.254 — the text never contains the private address, which is
        // exactly why the old prefix rules could not see it. This is the one class that
        // bypassed the gate THROUGH a URL: `new URL('http://[2001::200:0:ff00:fffe]/')`
        // hands the gate that text unchanged.
        const teredo: Array<[string, string]> = [
            ['client 127.0.0.1, compressed', '2001::200:0:ff00:fffe'],
            ['client 127.0.0.1, uncompressed', '2001:0:0:0:200:0:ff00:fffe'],
            ['client 127.0.0.1, compat mode (not inverted)', '2001::200:0:7f00:1'],
            ['client 169.254.169.254', '2001::200:0:5601:5601'],
            // The relay field (the 32 bits above the client's) is inverted too: this one
            // names 10.255.255.255, a private next hop for the tunnel.
            ['relay 10.255.255.255', '2001:0:f5ff:ffff:200:0:f7f7:f7f7'],
        ];

        for (const [form, text] of teredo) {
            expect([form, isPrivateHost(text)]).toEqual([form, true]);
            expect([form, safeFetchUrl(`http://[${text}]/`)]).toEqual([form, undefined]);
        }

        // The public half of the same range stays fetchable, so the rule is a decode and
        // not a block on `2001::/32`. The first row is the address from RFC 4380's own
        // example: client 192.0.2.45, relay 190.201.28.135, both public.
        const publicTeredo: Array<[string, string]> = [
            ['rfc 4380 example', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
            ['client 1.1.1.1', '2001::200:0:fefe:fefe'],
            ['client 8.8.8.8', '2001::200:0:f7f7:f7f7'],
        ];

        for (const [form, text] of publicTeredo) {
            expect([form, isPrivateHost(text)]).toEqual([form, false]);
            expect([form, safeFetchUrl(`http://[${text}]/`) !== undefined]).toEqual([form, true]);
        }

        // The documentation range and an ordinary public v6 address are untouched.
        expect(isPrivateHost('2001:db8::1')).toBe(false);
        expect(isPrivateHost('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    });

    it('refuses a 6to4 address whose tunnel endpoint is private', () => {
        // RFC 3056 §5.1 / RFC 4291 §2.5.7: a `2002::/16` address carries the tunnel's
        // IPv4 in BITS 16-47 — the second and third groups, written as-is — so the text
        // `2002:7f00:1::` is a route to 127.0.0.1 and `2002:a9fe:a9fe::` is a route to
        // the metadata address. Unlike the mapped forms this is not only an encoding: a
        // packet is ENCAPSULATED toward that IPv4, which is why RFC 3964 §3.1/§3.2 tells
        // a 6to4 router and a 6to4 relay to "disallow traffic that has private, broadcast
        // or certain specific reserved IPv4 addresses in tunnels, or the matching 6to4
        // prefixes". Measured before the branch: every row below passed the gate and
        // reached the network (`Temp/t1-webfetch/probe14.ts`, `probe14-before.out`).
        //
        // Each row pins the parser hostname too, because the longhand and zero-padded
        // spellings are only reachable if `new URL()` accepts them — and it answers them
        // all with the compressed text, so the decode is what does the work.
        const sixToFour: Array<[string, string, string, string]> = [
            ['client 127.0.0.1, compressed', '2002:7f00:1::', '[2002:7f00:1::]', '127.0.0.1'],
            ['client 127.0.0.1, longhand', '2002:7f00:1:0:0:0:0:0', '[2002:7f00:1::]', '127.0.0.1'],
            ['client 127.0.0.1, uppercase', '2002:7F00:1::', '[2002:7f00:1::]', '127.0.0.1'],
            ['client 127.0.0.1, zero-padded groups', '2002:7f00:0001:0:0:0:0:0', '[2002:7f00:1::]', '127.0.0.1'],
            // The trailing groups belong to the tunnel's IPv6 side; the embedded IPv4 is
            // still groups 2-3, so a v6 tail must not shift the decode.
            ['client 127.0.0.1, with a v6 tail', '2002:7f00:1:2:3:4:5:6', '[2002:7f00:1:2:3:4:5:6]', '127.0.0.1'],
            ['client 127.0.0.1, trailing host', '2002:7f00:1::1', '[2002:7f00:1::1]', '127.0.0.1'],
            ['metadata ip, compressed', '2002:a9fe:a9fe::', '[2002:a9fe:a9fe::]', '169.254.169.254'],
            ['metadata ip, longhand', '2002:a9fe:a9fe:0:0:0:0:0', '[2002:a9fe:a9fe::]', '169.254.169.254'],
            ['10.0.0.1, zero-padded', '2002:0a00:0001::', '[2002:a00:1::]', '10.0.0.1'],
            ['10.0.0.1, compressed', '2002:a00:1::', '[2002:a00:1::]', '10.0.0.1'],
            ['172.16.0.1', '2002:ac10:0001::', '[2002:ac10:1::]', '172.16.0.1'],
            ['192.168.1.1', '2002:c0a8:0101::', '[2002:c0a8:101::]', '192.168.1.1'],
            ['100.64.0.1 (cgnat)', '2002:6440:0001::', '[2002:6440:1::]', '100.64.0.1'],
            // The TOP of the CGNAT block: the tunnel endpoint `100.127.0.1` is inside
            // `100.64.0.0/10`, and until this pass a 6to4 address pointed at it was fetched
            // while one pointed at `100.64.0.1` was refused — one /10, two verdicts.
            ['100.127.0.1 (cgnat /10 edge)', '2002:647f:0001::', '[2002:647f:1::]', '100.127.0.1'],
        ];

        for (const [form, text, hostname, twin] of sixToFour) {
            // The platform parser is the ground truth for the address text, and the gate
            // must answer about THAT address — the private twin — not about the prefix.
            expect([form, new URL(`http://[${text}]/`).hostname]).toEqual([form, hostname]);
            expect([form, isPrivateHost(text)]).toEqual([form, true]);
            // Twin parity: the same refusal the dotted quad gets, from the same predicate.
            expect([form, isPrivateHost(twin)]).toEqual([form, true]);
            expect([form, safeFetchUrl(`http://[${text}]/`)]).toEqual([form, undefined]);
        }

        // Public pins, so the branch is a decode and not a block on `2002::/16`: the
        // compressed, zero-padded and longhand spellings of a public endpoint all stay
        // fetchable, with the normalized URL the tool would actually request. The first
        // two rows are the same address written three ways.
        const publicSixToFour: Array<[string, string, string, string, string]> = [
            ['8.8.8.8, zero-padded', '2002:0808:0808::', '[2002:808:808::]', 'http://[2002:808:808::]/', '8.8.8.8'],
            ['8.8.8.8, compressed', '2002:808:808::', '[2002:808:808::]', 'http://[2002:808:808::]/', '8.8.8.8'],
            ['8.8.8.8, longhand', '2002:0808:0808:0:0:0:0:0', '[2002:808:808::]', 'http://[2002:808:808::]/', '8.8.8.8'],
            ['8.8.8.8, trailing host', '2002:808:808::1', '[2002:808:808::1]', 'http://[2002:808:808::1]/', '8.8.8.8'],
            ['example.com 93.104.216.34', '2002:5d68:d822::', '[2002:5d68:d822::]', 'http://[2002:5d68:d822::]/', '93.104.216.34'],
            ['1.1.1.1', '2002:0101:0101::', '[2002:101:101::]', 'http://[2002:101:101::]/', '1.1.1.1'],
            // The 6to4 anycast RELAY, `2002:c058:6301::` = 192.88.99.1 (RFC 3068). It is
            // the address a public relay answers with, and 192.88.99.0/24 is provider-
            // assigned and routable (RFC 7535 §4), so it is not in any private range and
            // the decode leaves it alone — pinning it is what keeps a future "link-local"
            // tidy-up from blocking the whole class by accident.
            ['anycast relay 192.88.99.1', '2002:c058:6301::', '[2002:c058:6301::]', 'http://[2002:c058:6301::]/', '192.88.99.1'],
        ];

        for (const [form, text, hostname, href, twin] of publicSixToFour) {
            expect([form, new URL(`http://[${text}]/`).hostname]).toEqual([form, hostname]);
            expect([form, isPrivateHost(text)]).toEqual([form, false]);
            expect([form, isPrivateHost(twin)]).toEqual([form, false]);
            expect([form, safeFetchUrl(`http://[${text}]/`)]).toEqual([form, href]);
        }

        // DECIDED AGAINST, pinned so the omission stays a decision: prefixes whose low
        // groups LOOK like a private IPv4 but where no specification puts one. RFC 4843 §2
        // builds an ORCHID by prepending "the 28-bit ORCHID prefix" to a 100-bit hash, and
        // the registered prefixes are `2001:20::/28` (RFC 7194) and ORCHIDv2 `2001:30::/28`
        // (RFC 7360); the 6VTEL `2620::/27` bit position could not be cited from a reachable
        // source in this pass (RFC 3964, the document that discusses embedded-address
        // refusal, is 6to4's analysis and never mentions `2620`). All three texts DO reach
        // the network — the class is real, only the decoded address is missing — so adding
        // them later is one additive branch, not a rewrite.
        const notDecoded: Array<[string, string]> = [
            ['2001:10::/28 with a 127-ish tail', '2001:10::7f00:1'],
            ['6vtel legacy block', '2620::7f00:1'],
            ['6vtel autoconfigured block', '2620:1000:7f00:1::'],
        ];

        for (const [form, text] of notDecoded) {
            expect([form, new URL(`http://[${text}]/`).hostname]).toEqual([form, `[${text.toLowerCase()}]`]);
            expect([form, isPrivateHost(text)]).toEqual([form, false]);
            expect([form, safeFetchUrl(`http://[${text}]/`) !== undefined]).toEqual([form, true]);
        }
    });

    it('keeps the refusals that were already wider than the ranges', () => {
        // The hardening is ADDITIVE: nothing that used to be blocked is released, even
        // where the old rules over-block. The `::` prefix alternative refuses every
        // compressed address in that family, so a PUBLIC compressed mapped address is
        // refused while its uncompressed twin is answered honestly — an asymmetry in
        // TEXT handling, and the safe direction for a deny list.
        expect(isPrivateHost('::ffff:5d68:d822')).toBe(true); // 93.104.216.34, public
        expect(isPrivateHost('0:0:0:0:0:ffff:5d68:d822')).toBe(false);
        // `64:ff9b::` is refused as a family, not as /96, so a public translated address
        // is refused compressed and allowed longhand, for the same reason.
        expect(isPrivateHost('64:ff9b::5d68:d822')).toBe(true);
        expect(isPrivateHost('64:ff9b:0:0:0:0:5d68:d822')).toBe(false);
        // THE OTHER DIRECTION OF THAT ASYMMETRY, and the guard the mapped-tail fix needs:
        // `::ffff:8.8.8.8` is a PUBLIC dotted tail, and the shortcut branch now answers it
        // through `privateIPv4` — the same predicate its twin `8.8.8.8` is answered by — so
        // the change is consistency, not another widening. The URL path still refuses it,
        // because `new URL()` compresses the host to `[::ffff:808:808]`, which the blanket `::`
        // prefix above catches: text and URL diverge in the SAFE direction, exactly as the
        // two rows above show.
        expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false);
        expect(isPrivateHost('8.8.8.8')).toBe(false);
        expect(safeFetchUrl('http://[::ffff:8.8.8.8]/')).toBeUndefined();
        // What `new URL()` does to each text decides which verdict a fetch gets, and both
        // directions are refused on the URL path.
        expect(safeFetchUrl('http://[::ffff:5d68:d822]/')).toBeUndefined();
        expect(safeFetchUrl('http://[64:ff9b:0:0:0:0:5d68:d822]/')).toBeUndefined();

        // CGNAT (RFC 6598) is `100.64.0.0/10` — the SECOND octet 64-127, not the /16 the
        // `startsWith('100.64.')` test this replaced could see. Both edges of the block are
        // pinned, and both edges of the address space just outside it, so a future edit that
        // "tidies the range into a prefix" fails here instead of silently narrowing a /10 back
        // to a /16 (or widening it to a /8). Every row is a measurement, not an inference.
        for (const host of ['100.64.0.0', '100.64.0.1', '100.127.0.1', '100.127.255.255']) {
            expect([host, isPrivateHost(host)]).toEqual([host, true]);
        }

        for (const host of ['100.63.255.255', '100.128.0.0', '101.0.0.1', '99.255.255.255']) {
            expect([host, isPrivateHost(host)]).toEqual([host, false]);
        }

        // The addresses the gate does NOT refuse, and does not claim to (see the `download`
        // description): multicast, class E, limited broadcast and RFC 5737 documentation space
        // are all unreachable from here rather than internal, so naming them "reserved" in a
        // description was the overstatement — refusing them would be a behaviour change this
        // pass deliberately did not make.
        for (const host of ['224.0.0.1', '240.0.0.1', '255.255.255.255', '192.0.2.1']) {
            expect([host, isPrivateHost(host)]).toEqual([host, false]);
        }

        // The pre-existing verdicts, unchanged.
        for (const host of ['127.0.0.1', '192.168.1.1', '10.0.0.5', '::1', 'fe80::1', 'fd12:3456::1', 'localhost']) {
            expect([host, isPrivateHost(host)]).toEqual([host, true]);
        }

        for (const host of ['example.com', '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
            expect([host, isPrivateHost(host)]).toEqual([host, false]);
        }
    });

    it('never asks a resolver about an address form', async () => {
        // `resolvePublicHost` used to recognize only a dotted quad or a colon, so a
        // decimal literal went to DNS as if it were a name — a query that cannot change
        // the verdict, because the address is already in the text.
        const asked: string[] = [];
        const resolver = async (host: string) => {
            asked.push(host);

            return ['93.184.216.34'];
        };

        for (const host of [
            '2130706433',
            '0x7f000001',
            '127.1',
            '134744072',
            '8.8.8.8',
            '2001::200:0:ff00:fffe',
            // The 6to4 pair: an address form never goes to DNS, whether the embedded
            // endpoint is private or public — the address is already in the text.
            '2002:7f00:1::',
            '2002:0808:0808::',
        ]) {
            const verdict = await resolvePublicHost(host, resolver);

            expect([host, verdict.blocked]).toEqual([host, isPrivateHost(host)]);
        }

        expect(asked).toEqual([]);

        expect((await resolvePublicHost('example.com', resolver)).blocked).toBe(false);
        // A name is still a name: exactly one query.
        expect(asked).toEqual(['example.com']);
    });

    it('refuses a resolver answer written in a form the old gate missed', async () => {
        // The second gate checks the ANSWER text, so the decoder matters there as much
        // as on the URL: an injected lookup that answers with a longhand mapped address
        // or a Teredo address used to be waved through as public.
        const answers: Array<[string, string]> = [
            ['mapped longhand', '0:0:0:0:0:ffff:7f00:1'],
            ['teredo client 127.0.0.1', '2001::200:0:ff00:fffe'],
            ['translated metadata longhand', '64:ff9b:0:0:0:0:a9fe:a9fe'],
            ['decimal loopback', '2130706433'],
            // A resolver answering with a 6to4 address: the tunnel endpoint is the host
            // the request would reach, so the answer is refused pre-connection.
            ['6to4 loopback', '2002:7f00:1::'],
            ['6to4 metadata ip', '2002:a9fe:a9fe::'],
            // A CGNAT answer spelled as a mapped literal: gate 2 reads the ANSWER text, and
            // until the mapped shortcut shared `privateIPv4`, that text was public while the
            // same address as a dotted quad was refused.
            ['mapped cgnat, dotted tail', '::ffff:100.127.0.1'],
            ['cgnat /10 edge, raw quad', '100.127.255.255'],
        ];

        for (const [form, address] of answers) {
            const fetchMock = stubFetch(() => response('<p>should not be read</p>'));
            const tool = createWebFetchTool({ env: {}, dns: { lookup: async () => [address] } });

            await expect(call(tool, { url: 'https://public.example/page' })).rejects.toThrow(
                /resolves to a non-public address/
            );
            // Blocked before the connection, and the reported address is the one asked.
            expect([form, fetchMock.mock.calls.length]).toEqual([form, 0]);
        }
    });
});
