// The live toolbox path opts into both web rows.
//
// `createToolboxHarness` is what a real session uses (presets, user-created
// harnesses, createProfiledHarness). This suite keeps that server-side wiring in the
// server tree; the engine's own fetch contract lives in
// `../../engine/harness.webfetch.test.ts`.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../../engine/index';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '../../engine/index';
import { createToolboxHarness } from './toolbox';

const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* (request): AsyncIterable<HarnessStreamEvent> {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('live toolbox harness', () => {
    it('declares the web core pair on the first request and runs fetch with no discovery round', async () => {
        vi.stubEnv('EXA_API_KEY', 'configured-exa-key');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response('<html><head><title>Doc</title></head><body><h1>Page</h1></body></html>', {
                    headers: { 'content-type': 'text/html' }
                })
            )
        );

        const seen: HarnessStreamRequest[] = [];

        // An entry agent + one junior mirrors a real preset's shape (a roster that spans two
        // ranks is what makes delegate part of the core declarations). Turn 1 calls fetch
        // directly; turn 2 opens the two searchable rows; turn 3 answers.
        const writer = createToolboxHarness(
            {
                agents: {
                    instruct: agent({
                        model: 'test/model',
                        stream: scripted(
                            [
                                callTool('c1', 'fetch', '{"url":"https://example.com"}'),
                                callTool('c2', 'toolRequest', '{"names":["download","syntax"]}'),
                                answer('done')
                            ],
                            seen
                        )
                    }),
                    research: agent({ model: 'test/model', stream: scripted([answer('idle')]) })
                },
                entry: 'instruct',
                ranks: { instruct: 'A', research: 'B' }
            },
            { baseURL: 'http://provider.test/v1', apiKey: '', model: 'test-model' },
            async () => undefined
        );

        // Registration is unchanged by visibility: the toolbox table, then the web
        // providers, then the harness-owned rows in kernel registration order.
        expect(Object.keys(writer.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'records',

            'tasks',
            'profiles',
            'chapters',
            'locations',
            'knowledge',
            'agentManage',
            'agentResult',
            'delegate',
            'threadFork',
            'sleep',
            'toolCancel',
            'syntax',
            'read',
            'write',
            'edit',
            'files',
            'glob',
            'grep',
            'shell',
            'gitDiff',
            'download',
            'timeNow',
            'textCount',
            'diceRoll',
            'noteSearch',
            'textSummarize',
            'search',
            'fetch'
        ]);
        expect(writer.tools.fetch.visibility).toBe('core');
        expect(writer.tools.search.visibility).toBe('core');

        const message = await writer('fetch a page');
        expect(message.content).toBe('done');

        // THE declaration assertion, end to end: the first request the model saw
        // carries the harness-owned pair, the team's delegate, the five core file
        // presets, and the two environment rows. `download`, the eleven demoted
        // runtime rows, and every other preset are absent.
        expect(declaredNames(seen[0])).toEqual([
            'toolRequest',
            'tasks',
            'delegate',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            'search',
            'fetch'
        ]);

        // The model called a declared tool: the native provider ran on the stub, and
        // the WebFetchResult envelope came back verbatim.
        expect(JSON.parse((writer.agents.instruct.messages[2] as { content: string }).content)).toEqual({
            provider: 'native',
            // The native provider reports the URL it actually fetched, which is the
            // WHATWG-normalized form of what the model passed.
            url: 'https://example.com/',
            contentType: 'text/html',
            format: 'markdown',
            characters: 6,
            truncated: false,
            // Always present now: a caller must be able to tell a complete page from
            // a cut one, and where the next window starts.
            offset: 0,
            pageCharacters: 6,
            content: '# Page',
            title: 'Doc'
        });

        // Nothing was discovered by calling a core tool, so the second request carries
        // the same declarations - fetch exactly once.
        expect(declaredNames(seen[1])).toEqual(declaredNames(seen[0]));

        // The searchable rows now open through toolRequest: `download` plus one
        // specialized row, reported as enabled (not already-available).
        expect(
            JSON.parse((writer.agents.instruct.messages[4] as { content: string }).content)
        ).toMatchObject({
            enabled: ['download', 'syntax'],
            matched: 2,
            omitted: 0
        });

        // And they are available on the very next model turn, after the core set, in
        // the order the query named them.
        expect(declaredNames(seen[2])).toEqual([
            ...declaredNames(seen[0]),
            'download',
            'syntax'
        ]);
        expect(writer.discoveredTools).toEqual(['download', 'syntax']);
    });
});
