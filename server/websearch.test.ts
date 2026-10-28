// Websearch over the real HTTP API.
//
// C1 fixes a specific gap: `GET /api/tools` must list webSearch even on a host
// with no provider key, `POST /api/tools/webSearch` must explain that honestly,
// and with EXA_API_KEY in the process environment the same endpoint must execute
// with the server-side key. Both cases run against a real server on an ephemeral
// port; the configured case intercepts only the outbound Exa request, so no
// network is touched and the exact credential header can be asserted.
//
// Environment values are stubbed per test, which also proves the catalogue is
// built when the server starts (after `.env` loading), not at module import.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBSEARCH_ENVIRONMENT, WEBSEARCH_UNCONFIGURED_HINT } from '../harnesses';
import { WEB_SEARCH_METADATA } from '../src/harness';
import { startHarnessServer } from './index';
import type { ToolCallResult, ToolIndex } from './protocol';

const CLIENT = { 'X-Harness-Client': 'ui' };

const toolsIndex = async (base: string): Promise<ToolIndex> => {
    const response = await fetch(`${base}/api/tools`, { headers: CLIENT });
    expect(response.status).toBe(200);
    return (await response.json()) as ToolIndex;
};

const callTool = async (base: string, name: string, parameters: unknown): Promise<ToolCallResult> => {
    const response = await fetch(`${base}/api/tools/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...CLIENT },
        body: JSON.stringify({ parameters })
    });

    // A tool failure is data on a 200, like every other direct call.
    expect(response.status).toBe(200);
    return (await response.json()) as ToolCallResult;
};

// `durationMs` is genuinely wall-clock; compare every other field exactly and
// assert the duration is a number instead of inventing a bound.
const withoutDuration = (result: ToolCallResult): Omit<ToolCallResult, 'durationMs'> => {
    expect(typeof result.durationMs).toBe('number');

    const { durationMs: _durationMs, ...payload } = result;
    return payload;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('webSearch catalogue', () => {
    it('lists webSearch as unconfigured and refuses a direct call without a key', async () => {
        // The runtime catalogue must read this at server start; a module-level
        // singleton built before these stubs would have seen the host env.
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        const server = await startHarnessServer({ port: 0, staticRoot: null });

        try {
            const index = await toolsIndex(server.url);
            const descriptor = index.tools.find((tool) => tool.name === 'webSearch');

            expect(descriptor).toEqual({
                name: 'webSearch',
                group: 'Web search',
                description: WEB_SEARCH_METADATA.description,
                tags: ['web', 'search', 'internet', 'news', 'research'],
                visibility: 'core',
                parameters: WEB_SEARCH_METADATA.parameters,
                availability: {
                    state: 'unconfigured',
                    environment: [...WEBSEARCH_ENVIRONMENT],
                    hint: WEBSEARCH_UNCONFIGURED_HINT
                }
            });

            const result = await callTool(server.url, 'webSearch', { query: 'anything' });

            expect(withoutDuration(result)).toEqual({
                ok: false,
                error: { message: WEBSEARCH_UNCONFIGURED_HINT }
            });
        } finally {
            await server.close();
        }
    });

    it('executes with the env key and never returns it in the catalogue or result', async () => {
        const KEY = 'test-exa-key';
        vi.stubEnv('EXA_API_KEY', KEY);
        vi.stubEnv('TAVILY_API_KEY', '');

        // Capture the real transport before stubbing: the test's own requests to
        // the harness server must still go through, while Exa is intercepted.
        const realFetch = globalThis.fetch;
        const outbound: { url: string; init: RequestInit }[] = [];

        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

            if (url === 'https://api.exa.ai/search') {
                outbound.push({ url, init: init ?? {} });

                return new Response(
                    JSON.stringify({
                        results: [
                            {
                                title: 'Harness result',
                                url: 'https://example.com/harness',
                                highlights: ['the harness loops tools'],
                                publishedDate: '2026-01-01'
                            }
                        ]
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }

            return realFetch(input, init);
        });

        const server = await startHarnessServer({ port: 0, staticRoot: null });

        try {
            // Fetch the raw body as text so the assertion covers the *entire*
            // payload: no field, nested or not, may contain the credential.
            const toolsResponse = await fetch(`${server.url}/api/tools`, { headers: CLIENT });
            const toolsBody = await toolsResponse.text();
            expect(toolsBody).not.toContain(KEY);

            const index = JSON.parse(toolsBody) as ToolIndex;
            const descriptor = index.tools.find((tool) => tool.name === 'webSearch');

            expect(descriptor?.availability).toEqual({
                state: 'available',
                environment: [...WEBSEARCH_ENVIRONMENT]
            });

            const result = await callTool(server.url, 'webSearch', {
                query: 'harness tool discovery',
                maxResults: 5
            });

            expect(withoutDuration(result)).toEqual({
                ok: true,
                result: {
                    provider: 'exa',
                    query: 'harness tool discovery',
                    maxResults: 5,
                    results: [
                        {
                            title: 'Harness result',
                            url: 'https://example.com/harness',
                            snippet: 'the harness loops tools',
                            published: '2026-01-01'
                        }
                    ]
                }
            });

            expect(JSON.stringify(result)).not.toContain(KEY);

            // Exactly one provider request, with the server-side key in a header
            // (never the URL or body) and the bounded adapter payload.
            expect(outbound).toHaveLength(1);
            expect(outbound[0].url).toBe('https://api.exa.ai/search');
            expect(outbound[0].init.method).toBe('POST');
            expect(outbound[0].init.headers).toEqual({
                'content-type': 'application/json',
                'x-api-key': KEY
            });
            expect(JSON.parse(String(outbound[0].init.body))).toEqual({
                query: 'harness tool discovery',
                type: 'auto',
                numResults: 5,
                contents: { highlights: true }
            });
        } finally {
            await server.close();
        }
    });
});
