// search inside a harness: conditional registration, discovery, credentials.
//
// The factory's wire behaviour is covered in tools/websearch/websearch.test.ts.
// These tests pin the harness-level contract instead: whether the tool exists,
// which key it uses, when it is declared, and that nothing secret reaches the
// transcript or the progress stream. No host env and no network: keys are stubbed
// or injected, fetch is a stub.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent, WebSearchResult } from '@underload/harness';

const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;
    return async function* (): AsyncIterable<HarnessStreamEvent> {
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// Registration tests never run the model, but an agent still needs a transport.
// One scripted answer is enough, and it keeps these tests offline.
const idle = () => agent({ model: 'm', stream: scripted([answer('idle')]) });

// R18: a configured search is core, so there is no discovery round: the model
// calls it directly on the first turn.
const searchOnly = (): HarnessStreamEvent[][] => [
    callTool('c1', 'search', '{"query":"harness","maxResults":2}'),
    answer('found it')
];

const exaPayload = {
    results: [
        {
            title: 'Harness result',
            url: 'https://example.com/harness',
            highlights: ['the harness loops tools'],
            publishedDate: '2026-01-01'
        }
    ]
};

// Linkup's own row shape: `name` is the title, `content` the excerpt, and the
// `type`/`favicon` fields the tool has no place for.
const linkupPayload = {
    results: [
        {
            type: 'text',
            name: 'Harness result',
            url: 'https://example.com/harness',
            content: 'the harness loops tools',
            favicon: 'https://example.com/favicon.ico'
        }
    ]
};

const stubFetch = (body: unknown = exaPayload) => {
    const mock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
        async () =>
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
    );

    vi.stubGlobal('fetch', mock);
    return mock;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('registration', () => {
    it('is off when the configuration does not opt in', () => {
        const writer = harness({ agents: { writer: idle() } });

        expect(writer.tools.search).toBeUndefined();
    });

    it('is off when explicitly false', () => {
        const writer = harness({
            agents: { writer: idle() },
            websearch: false
        });

        expect(writer.tools.search).toBeUndefined();
    });

    it('is not registered when opted in but no key is available', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '');

        const writer = harness({
            agents: { writer: idle() },
            websearch: true
        });

        expect(writer.tools.search).toBeUndefined();
    });

    it('registers a core tool from process.env when opted in with true', () => {
        vi.stubEnv('EXA_API_KEY', 'exa-secret-key');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '');

        const writer = harness({
            agents: { writer: idle() },
            websearch: true
        });

        // R18: configured search is core, so it is declared without a discovery
        // round. Registration itself is still key-gated (tested above).
        expect(writer.tools.search).toBeDefined();
        expect(writer.tools.search.visibility).toBe('core');
        expect(writer.tools.search.tags).toEqual(['web', 'search', 'internet', 'news', 'research']);
    });

    it('does not touch the network at construction', () => {
        const fetchMock = stubFetch();

        harness({
            agents: { writer: idle() },
            websearch: { env: { EXA_API_KEY: 'exa-secret-key' } }
        });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports an invalid explicit key at construction', () => {
        expect(() =>
            harness({
                agents: { writer: idle() },
                websearch: { exa: { apiKey: 42 as never } }
            })
        ).toThrow('search provider "exa" apiKey must be a string or a function returning one.');
    });

    it('lets a configured tool named search win', async () => {
        const custom = tool<{ query: string }, string>({
            description: 'A caller-provided search tool.',
            tags: ['web', 'search'],
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false
            },
            execute: () => 'custom result'
        });

        const writer = harness({
            agents: { writer: idle() },
            tools: { search: custom },
            websearch: { env: { EXA_API_KEY: 'exa-secret-key' } }
        });

        expect(writer.tools.search).not.toBe(custom);
        expect(writer.tools.search.description).toBe(custom.description);
        await expect(writer.executeTool('search', { query: 'custom' })).resolves.toBe(
            'custom result'
        );
    });
});

describe('execution', () => {
    it('is declared directly and returns the normalized result', async () => {
        const fetchMock = stubFetch();
        const events: string[] = [];

        const entry = agent({
            model: 'm',
            stream: scripted(searchOnly())
        });

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            websearch: { env: { EXA_API_KEY: 'exa-secret-key' } },
            report: {
                progress: (event) => {
                    events.push(JSON.stringify(event));
                }
            }
        });

        await writer('search the web');

        // Exact wire request: the key is a header, the body is the provider contract.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.exa.ai/search');
        expect(init.headers).toEqual({
            'content-type': 'application/json',
            'x-api-key': 'exa-secret-key'
        });
        expect(JSON.parse(String(init.body))).toEqual({
            query: 'harness',
            type: 'auto',
            numResults: 2,
            contents: { highlights: true }
        });

        // user -> search call -> result -> answer
        const resultMessage = entry.messages[2] as { role: string; content: string };
        expect(resultMessage.role).toBe('tool');

        const expected: WebSearchResult = {
            provider: 'exa',
            query: 'harness',
            maxResults: 2,
            results: [
                {
                    title: 'Harness result',
                    url: 'https://example.com/harness',
                    snippet: 'the harness loops tools',
                    published: '2026-01-01'
                }
            ]
        };

        expect(JSON.parse(resultMessage.content)).toEqual(expected);

        // Nothing secret in the transcript or the progress stream. The tool is
        // declared (core), so the declaration text is in history.
        const transcript = JSON.stringify(entry.messages);
        expect(transcript).not.toContain('exa-secret-key');
        expect(transcript).not.toContain('EXA_API_KEY');
        expect(events.join('\n')).not.toContain('exa-secret-key');
        expect(events.join('\n')).not.toContain('EXA_API_KEY');
    });

    it('searches through Linkup when Linkup is the only configured key', async () => {
        const fetchMock = stubFetch(linkupPayload);

        const entry = agent({ model: 'm', stream: scripted(searchOnly()) });

        const writer = harness({
            agents: { writer: entry },
            presets: false,
            websearch: { env: { LINKUP_API_KEY: 'linkup-secret-key' } }
        });

        // A single configured provider is not a choice: no `provider` argument is
        // offered, so the model cannot spend a turn naming the only legal value.
        const properties = (writer.tools.search.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual(['query', 'maxResults']);

        await writer('search the web');

        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.linkup.so/v1/search');
        expect(init.headers).toEqual({
            'content-type': 'application/json',
            authorization: 'Bearer linkup-secret-key'
        });
        expect(JSON.parse(String(init.body))).toEqual({
            q: 'harness',
            depth: 'fast',
            outputType: 'searchResults',
            maxResults: 2
        });

        // The provider answer is normalized into the same result shape Exa and
        // Tavily produce: `name` -> title, `content` -> snippet, no date.
        const resultMessage = entry.messages[2] as { role: string; content: string };
        expect(resultMessage.role).toBe('tool');
        expect(JSON.parse(resultMessage.content)).toEqual({
            provider: 'linkup',
            query: 'harness',
            maxResults: 2,
            results: [
                {
                    title: 'Harness result',
                    url: 'https://example.com/harness',
                    snippet: 'the harness loops tools'
                }
            ]
        });

        expect(JSON.stringify(entry.messages)).not.toContain('linkup-secret-key');
    });

    it('uses each harness\'s own credential', async () => {
        const fetchMock = stubFetch();

        const first = harness({
            agents: { writer: agent({ model: 'm', stream: scripted(searchOnly()) }) },
            presets: false,
            websearch: { env: { EXA_API_KEY: 'first-exa-key' } }
        });

        const second = harness({
            agents: { writer: agent({ model: 'm', stream: scripted(searchOnly()) }) },
            presets: false,
            websearch: { env: { TAVILY_API_KEY: 'second-tavily-key' } }
        });

        await first('one');
        await second('two');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toBe('https://api.exa.ai/search');
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'first-exa-key' });
        expect(fetchMock.mock.calls[1][0]).toBe('https://api.tavily.com/search');
        expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
            authorization: 'Bearer second-tavily-key'
        });

        // Neither harness advertises the other's provider.
        expect(JSON.stringify(first.tools.search.parameters)).not.toContain('tavily');
        expect(JSON.stringify(second.tools.search.parameters)).not.toContain('exa');
    });

    it('routes a model call to the custom override, not the network', async () => {
        const fetchMock = stubFetch();

        const custom = tool<{ query: string }, string>({
            description: 'A caller-provided search tool.',
            tags: ['web', 'search'],
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false
            },
            execute: () => 'custom result'
        });

        const entry = agent({
            model: 'm',
            stream: scripted([
                callTool('c0', 'toolRequest', '{"tags":["web","search"]}'),
                callTool('c1', 'search', '{"query":"harness"}'),
                answer('done')
            ])
        });

        const writer = harness({
            agents: { writer: entry },
            tools: { search: custom },
            presets: false,
            websearch: { env: { EXA_API_KEY: 'exa-secret-key' } }
        });

        await writer('search');

        expect(fetchMock).not.toHaveBeenCalled();
        expect((entry.messages[4] as { content: string }).content).toBe('custom result');
    });
});
