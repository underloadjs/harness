// Websearch over the real HTTP API.
//
// C1 fixes a specific gap: the tool catalogue must list search even on a host
// with no provider key, a direct execution must explain that honestly,
// and with EXA_API_KEY in the process environment the same endpoint must execute
// with the server-side key. Both cases run against a real server on an ephemeral
// port; the configured case intercepts only the outbound Exa request, so no
// network is touched and the exact credential header can be asserted.
//
// A third case covers a Linkup-only host: the provider preference (Exa first)
// must never turn into an Exa requirement, so the same endpoint executes through
// Linkup's endpoint with the Linkup key in the header only.
//
// Environment values are stubbed per test, which also proves the catalogue is
// built when the server starts (after `.env` loading), not at module import.
//
// ---------------------------------------------------------------------------
// CANONICAL SURFACE (the `/api` mount is gone — T13 removed the second mount)
//
// One root only: `STANDALONE_MOUNT = HARNESS_API_ROOT = '/v1/harness'`
// (./api.ts:282, and dispatch refuses any other mount with a 404 that NAMES the
// root, ./api.ts:3928). Routes and payload shapes come from the generated
// contract (../shared/harness-api.ts), so the three reads this file needs are:
//   - `GET  {root}/tools`                     -> `ToolSummaryPage`
//       `{ limit, next_cursor, observed_at, revision, items }` (./api-paging.ts:142,
//       handler ./api.ts:1791). A row is a `ToolSummary` (./api-reads.ts:1091):
//       identity + availability + `session_bound`, and the argument schema does NOT
//       ride a row.
//   - `GET  {root}/tools/{name}`              -> `{ tool: ToolDetail }`
//       the row PLUS `parameters` and `execution` (./api-reads.ts:1116, ./api.ts:1821).
//       That identified read is where the schema assertions live now.
//   - `POST {root}/tools/{name}/executions`   -> `ToolCallResult`
//       body `{ parameters }`; both outcomes are 200 and the duration field is the
//       contract's snake_case `duration_ms` (./api.ts:1835, :591, ./api-reads.ts:1253).
//
// The legacy `X-Harness-Client: ui` header gate was retired with the old mount
// (./handler.ts:8-13): the Origin policy is the boundary, and a Node `fetch` sends
// no Origin, so these requests carry no client header.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEBSEARCH_ENVIRONMENT, WEBSEARCH_UNCONFIGURED_HINT } from './harnesses';
import { WEB_SEARCH_METADATA } from '../harness';
import { startHarnessServer } from './index';
import type { ToolCallResult, ToolDetailResponse, ToolSummaryPage } from '../shared/harness-api';

// The one canonical API root (see the header above).
const API = '/v1/harness';

// Catalogue pages are bounded (default 25, cap 100 — ./api-paging.ts), and core entries
// are concatenated BEFORE the deployment catalogue (./api.ts:750). Asking for the cap
// keeps `search` — a core entry — on the first page no matter how many created tools the
// host carries, which is what "the catalogue lists search" has to mean.
const toolsPage = async (base: string): Promise<ToolSummaryPage> => {
    const response = await fetch(`${base}${API}/tools?limit=100`);
    expect(response.status).toBe(200);
    return (await response.json()) as ToolSummaryPage;
};

// The identified read is the only one that carries the argument schema.
const toolDetail = async (base: string, name: string): Promise<ToolDetailResponse> => {
    const response = await fetch(`${base}${API}/tools/${name}`);
    expect(response.status).toBe(200);
    return (await response.json()) as ToolDetailResponse;
};

const callTool = async (base: string, name: string, parameters: unknown): Promise<ToolCallResult> => {
    const response = await fetch(`${base}${API}/tools/${name}/executions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parameters })
    });

    // A tool failure is data on a 200, like every other execution (./api.ts:1863).
    expect(response.status).toBe(200);
    return (await response.json()) as ToolCallResult;
};

// `duration_ms` is genuinely wall-clock; compare every other field exactly and
// assert the duration is a number instead of inventing a bound.
const withoutDuration = (result: ToolCallResult): Omit<ToolCallResult, 'duration_ms'> => {
    expect(typeof result.duration_ms).toBe('number');

    const { duration_ms: _durationMs, ...payload } = result;
    return payload;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('search catalogue', () => {
    it('lists search as unconfigured and refuses a direct call without a key', async () => {
        // The runtime catalogue must read this at server start; a module-level
        // singleton built before these stubs would have seen the host env.
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '');

        const server = await startHarnessServer({ port: 0, staticRoot: null });

        try {
            // A catalogue ROW: identity plus the honest availability block. `parameters`
            // is not on a row (./api-reads.ts:1091), so the schema check reads the detail
            // route below instead.
            const page = await toolsPage(server.url);
            const row = page.items.find((tool) => tool.name === 'search');

            expect(row).toEqual({
                name: 'search',
                group: 'Web search',
                description: WEB_SEARCH_METADATA.description,
                tags: ['web', 'search', 'internet', 'news', 'research'],
                visibility: 'core',
                availability: {
                    state: 'unconfigured',
                    environment: [...WEBSEARCH_ENVIRONMENT],
                    hint: WEBSEARCH_UNCONFIGURED_HINT
                },
                session_bound: false
            });

            // The identified read is the same row PLUS the schema and the execution gate.
            // `manual: false` is the honest answer for a listed-but-keyless tool: the
            // entry has no implementation to run (./api.ts:1860).
            const detail = await toolDetail(server.url, 'search');

            expect(detail.tool).toEqual({
                name: 'search',
                group: 'Web search',
                description: WEB_SEARCH_METADATA.description,
                tags: ['web', 'search', 'internet', 'news', 'research'],
                visibility: 'core',
                availability: {
                    state: 'unconfigured',
                    environment: [...WEBSEARCH_ENVIRONMENT],
                    hint: WEBSEARCH_UNCONFIGURED_HINT
                },
                session_bound: false,
                parameters: WEB_SEARCH_METADATA.parameters,
                execution: { scope: 'global', manual: false }
            });

            const result = await callTool(server.url, 'search', { query: 'anything' });

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
        vi.stubEnv('LINKUP_API_KEY', '');

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
            const toolsResponse = await fetch(`${server.url}${API}/tools?limit=100`);
            const toolsBody = await toolsResponse.text();
            expect(toolsBody).not.toContain(KEY);

            const page = JSON.parse(toolsBody) as ToolSummaryPage;
            const row = page.items.find((tool) => tool.name === 'search');

            expect(row?.availability).toEqual({
                state: 'available',
                environment: [...WEBSEARCH_ENVIRONMENT]
            });

            const result = await callTool(server.url, 'search', {
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

    // A host whose only credential is a Linkup key gets the identical catalogue
    // behaviour: search is available, the key never crosses the wire to the
    // client, and one outbound request uses Linkup's endpoint and body.
    it('executes through Linkup when only LINKUP_API_KEY is set', async () => {
        const KEY = 'test-linkup-key';
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', KEY);

        const realFetch = globalThis.fetch;
        const outbound: { url: string; init: RequestInit }[] = [];

        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

            if (url === 'https://api.linkup.so/v1/search') {
                outbound.push({ url, init: init ?? {} });

                return new Response(
                    JSON.stringify({
                        results: [
                            {
                                type: 'text',
                                name: 'Linkup result',
                                url: 'https://example.com/linkup',
                                content: 'linkup answers with excerpts',
                                favicon: 'https://example.com/favicon.ico'
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
            const toolsResponse = await fetch(`${server.url}${API}/tools?limit=100`);
            const toolsBody = await toolsResponse.text();
            expect(toolsBody).not.toContain(KEY);

            const page = JSON.parse(toolsBody) as ToolSummaryPage;
            const row = page.items.find((tool) => tool.name === 'search');

            expect(row?.availability).toEqual({
                state: 'available',
                environment: [...WEBSEARCH_ENVIRONMENT]
            });

            // Exactly one configured provider, so no `provider` argument is offered. The
            // schema is on the identified read, never on a catalogue row.
            const detail = await toolDetail(server.url, 'search');

            expect(Object.keys((detail.tool.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
                'query',
                'maxResults'
            ]);
            // A configured entry has a real implementation, so the gate says it can run.
            expect(detail.tool.execution).toEqual({ scope: 'global', manual: true });

            const result = await callTool(server.url, 'search', { query: 'harness', maxResults: 3 });

            expect(withoutDuration(result)).toEqual({
                ok: true,
                result: {
                    provider: 'linkup',
                    query: 'harness',
                    maxResults: 3,
                    results: [
                        {
                            title: 'Linkup result',
                            url: 'https://example.com/linkup',
                            snippet: 'linkup answers with excerpts'
                        }
                    ]
                }
            });

            expect(JSON.stringify(result)).not.toContain(KEY);

            expect(outbound).toHaveLength(1);
            expect(outbound[0].url).toBe('https://api.linkup.so/v1/search');
            expect(outbound[0].init.method).toBe('POST');
            expect(outbound[0].init.headers).toEqual({
                'content-type': 'application/json',
                authorization: `Bearer ${KEY}`
            });
            expect(JSON.parse(String(outbound[0].init.body))).toEqual({
                q: 'harness',
                depth: 'fast',
                outputType: 'searchResults',
                maxResults: 3
            });
        } finally {
            await server.close();
        }
    });
});
