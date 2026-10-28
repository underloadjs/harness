// websearch inside a harness: conditional registration, discovery, credentials.
//
// The factory's wire behaviour is covered in tools/websearch/websearch.test.ts.
// These tests pin the harness-level contract instead: whether the tool exists,
// which key it uses, when it is declared, and that nothing secret reaches the
// transcript or the progress stream. No host env and no network: keys are stubbed
// or injected, fetch is a stub.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent, WebsearchResult } from '@underload/harness';

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

const discoveryAndSearch = (): HarnessStreamEvent[][] => [
    callTool('c0', 'getTools', '{"tags":["web","search"]}'),
    callTool('c1', 'websearch', '{"query":"harness","maxResults":2}'),
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

        expect(writer.tools.websearch).toBeUndefined();
    });

    it('is off when explicitly false', () => {
        const writer = harness({
            agents: { writer: idle() },
            websearch: false
        });

        expect(writer.tools.websearch).toBeUndefined();
    });

    it('is not registered when opted in but no key is available', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');

        const writer = harness({
            agents: { writer: idle() },
            websearch: true
        });

        expect(writer.tools.websearch).toBeUndefined();
    });

    it('registers a searchable tool from process.env when opted in with true', () => {
        vi.stubEnv('EXA_API_KEY', 'exa-secret-key');
        vi.stubEnv('TAVILY_API_KEY', '');

        const writer = harness({
            agents: { writer: idle() },
            websearch: true
        });

        // Searchable, not core: the model still has to discover it, so an opt-in
        // harness does not grow the always-declared context.
        expect(writer.tools.websearch).toBeDefined();
        expect(writer.tools.websearch.visibility).toBe('searchable');
        expect(writer.tools.websearch.tags).toEqual(['web', 'search', 'internet', 'news', 'research']);
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
        ).toThrow('Websearch provider "exa" apiKey must be a string or a function returning one.');
    });

    it('lets a configured tool named websearch win', () => {
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
            tools: { websearch: custom },
            websearch: { env: { EXA_API_KEY: 'exa-secret-key' } }
        });

        expect(writer.tools.websearch).toBe(custom);
    });
});

describe('discovery and execution', () => {
    it('is enabled by getTools and returns the normalized result', async () => {
        const fetchMock = stubFetch();
        const events: string[] = [];

        const entry = agent({
            model: 'm',
            stream: scripted(discoveryAndSearch())
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

        // user -> getTools call -> result -> websearch call -> result -> answer
        const resultMessage = entry.messages[4] as { role: string; content: string };
        expect(resultMessage.role).toBe('tool');

        const expected: WebsearchResult = {
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
        // declared (getTools enabled it), so the declaration text is in history.
        const transcript = JSON.stringify(entry.messages);
        expect(transcript).not.toContain('exa-secret-key');
        expect(transcript).not.toContain('EXA_API_KEY');
        expect(events.join('\n')).not.toContain('exa-secret-key');
        expect(events.join('\n')).not.toContain('EXA_API_KEY');
    });

    it('uses each harness\'s own credential', async () => {
        const fetchMock = stubFetch();

        const first = harness({
            agents: { writer: agent({ model: 'm', stream: scripted(discoveryAndSearch()) }) },
            presets: false,
            websearch: { env: { EXA_API_KEY: 'first-exa-key' } }
        });

        const second = harness({
            agents: { writer: agent({ model: 'm', stream: scripted(discoveryAndSearch()) }) },
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
        expect(JSON.stringify(first.tools.websearch.parameters)).not.toContain('tavily');
        expect(JSON.stringify(second.tools.websearch.parameters)).not.toContain('exa');
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
                callTool('c0', 'getTools', '{"tags":["web","search"]}'),
                callTool('c1', 'websearch', '{"query":"harness"}'),
                answer('done')
            ])
        });

        const writer = harness({
            agents: { writer: entry },
            tools: { websearch: custom },
            presets: false,
            websearch: { env: { EXA_API_KEY: 'exa-secret-key' } }
        });

        await writer('search');

        expect(fetchMock).not.toHaveBeenCalled();
        expect((entry.messages[4] as { content: string }).content).toBe('custom result');
    });
});
