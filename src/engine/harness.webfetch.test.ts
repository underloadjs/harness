// fetch inside a harness: conditional registration and provider shape.
//
// The factory's wire behaviour is covered in tools/webfetch/webfetch.test.ts.
// These tests pin the harness-level contract instead: whether the tool exists,
// when, and what a host's own `fetch` tool overrides. No host env and no
// network: keys are injected, fetch is a stub.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from './index';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest, WebFetchResult } from './index';

// Pass `seen` to record every request, which is how the discovery tests inspect
// what the model was offered on each turn.
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

// Registration tests never run the model, but an agent still needs a transport.
const idle = () => agent({ model: 'm', stream: scripted([answer('idle')]) });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('registration', () => {
    it('is off when the configuration does not opt in', () => {
        const writer = harness({ agents: { writer: idle() } });

        expect(writer.tools.fetch).toBeUndefined();
    });

    it('is off when explicitly false', () => {
        const writer = harness({ agents: { writer: idle() }, webfetch: false });

        expect(writer.tools.fetch).toBeUndefined();
    });

    it('registers keyless: unlike search, "no key" still means a runnable tool', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '');

        const writer = harness({ agents: { writer: idle() }, webfetch: true });

        expect(writer.tools.fetch).toBeDefined();
        // R9-R11: fetching is environment core, exactly like a configured search.
        expect(writer.tools.fetch.visibility).toBe('core');

        const properties = (writer.tools.fetch.parameters as { properties: Record<string, unknown> }).properties;
        // `query` (section selection) and `offset` (paging) are always offered: they
        // are arguments of the tool, not of a provider.
        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset']);
    });

    it('offers the exa provider when the process environment has a key', () => {
        vi.stubEnv('EXA_API_KEY', 'exa-secret-key');
        vi.stubEnv('LINKUP_API_KEY', '');

        const writer = harness({ agents: { writer: idle() }, webfetch: true });

        const properties = (writer.tools.fetch.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset', 'provider']);
    });

    it('offers a native/linkup choice from a Linkup key alone', () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', 'linkup-secret-key');

        const writer = harness({ agents: { writer: idle() }, webfetch: true });

        const properties = (
            writer.tools.fetch.parameters as { properties: Record<string, { enum?: string[] }> }
        ).properties;

        // Exa is absent: a keyless hosted provider is not offered, so the enum
        // carries only what this harness can actually call.
        expect(Object.keys(properties)).toEqual(['url', 'format', 'query', 'offset', 'provider']);
        expect(properties.provider.enum).toEqual(['native', 'linkup']);
        expect(writer.tools.fetch.description).toContain('linkup');
        expect(writer.tools.fetch.description).not.toContain('exa');
    });

    it('a configured tool named fetch wins over the field', async () => {
        const custom = tool({
            description: 'My own fetch.',
            tags: ['web'],
            execute: () => ({ content: 'mine' })
        });

        const writer = harness({
            agents: { writer: idle() },
            tools: { fetch: custom },
            webfetch: true
        });

        // Configured definitions are wrapped rather than mutating/sharing the
        // caller's Tool object; the configured description wins.
        expect(writer.tools.fetch).not.toBe(custom);
        expect(writer.tools.fetch.description).toBe('My own fetch.');
        await expect(writer.executeTool('fetch', {})).resolves.toEqual({ content: 'mine' });
    });

    it('is callable through the registry with an injected env', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response('<html><head><title>Doc</title></head><body><h1>Page</h1></body></html>', {
                    headers: { 'content-type': 'text/html' }
                })
            )
        );

        const writer = harness({
            agents: { writer: idle() },
            webfetch: { env: {} }
        });

        const result = (await writer.executeTool('fetch', {
            url: 'https://example.com'
        })) as {
            content: string;
            title?: string;
        };

        expect(result.title).toBe('Doc');
        expect(result.content).toBe('# Page');
    });
});
// Discovery behaviour for the keyless web rows, through the handle alone.
describe('webfetch discovery', () => {
    it('reports a declared web tool as already available instead of enabling it', async () => {
        vi.stubEnv('EXA_API_KEY', '');
        vi.stubEnv('TAVILY_API_KEY', '');
        vi.stubEnv('LINKUP_API_KEY', '');

        const seen: HarnessStreamRequest[] = [];

        // Keyless: search never registers, so only fetch is the declared web row. The
        // model still asks for the "fetch" capability by tag; the honest answer is
        // "you already have it", never an enablement, and nothing is recorded.
        const writer = harness({
            agents: {
                instruct: agent({
                    model: 'test/model',
                    stream: scripted(
                        [callTool('c1', 'toolRequest', '{"tags":["fetch"]}'), answer('done')],
                        seen
                    )
                })
            },
            entry: 'instruct',
            webfetch: true,
            websearch: true
        });

        expect(writer.tools.search).toBeUndefined();

        await writer('fetch a page');

        // A single-rank roster registers no delegate; fetch is still declared, keyless and unmoved.
        expect(declaredNames(seen[0])).toEqual([
            'toolRequest',
            'tasks',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            'fetch'
        ]);

        const result = JSON.parse((writer.agents.instruct.messages[2] as { content: string }).content);
        expect(result.enabled).toEqual([]);
        expect(result.tools).toEqual([]);
        expect(result.matched).toBe(0);
        expect(result.omitted).toBe(0);
        // Metadata-only report of the declared row, never an enablement: the card is
        // exactly the registered fetch definition.
        expect(result.alreadyAvailable).toEqual([
            {
                name: writer.tools.fetch.name,
                description: writer.tools.fetch.description,
                tags: [...writer.tools.fetch.tags]
            }
        ]);
        // Calling a declared tool never enters the discovery record.
        expect(writer.discoveredTools).toEqual([]);

        // The declarations are untouched by the query.
        expect(declaredNames(seen[1])).toEqual(declaredNames(seen[0]));
    });
});

// What the MODEL sees for the fetch fixes, as opposed to what the factory returns:
// the harness runs the tool, serializes the result into the transcript, and turns a
// thrown HarnessError into the tool error a turn receives. Issues 0014-0016 are all
// about information reaching the consumer, so the classification and the new result
// fields have to survive this layer, not just the tool.
describe('fetch error classes and query fields through the tool envelope', () => {
    // `dns: { off: true }` keeps these offline: no resolver call, and the transport
    // verdict comes only from the stubbed `fetch`.
    const webfetch = () =>
        harness({ agents: { writer: idle() }, webfetch: { env: {}, dns: { off: true } } });

    // The message a tool call surfaces, whether it succeeded or threw.
    const settled = async (name: string, args: Record<string, unknown>): Promise<string> =>
        webfetch()
            .executeTool(name, args)
            .then(() => '', (error: unknown) => (error as Error).message);

    const rejectingFetch = (code: string) =>
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw Object.assign(new Error('fetch failed'), {
                    cause: Object.assign(new Error(`connect ${code} 203.0.113.9:443`), { code })
                });
            })
        );

    it('keeps a DNS failure and a refused connection distinct through the envelope', async () => {
        rejectingFetch('ENOTFOUND');
        const dns = await settled('fetch', { url: 'https://nonexistent-host-xyz-abc.invalid/page' });

        rejectingFetch('ECONNREFUSED');
        const refused = await settled('fetch', { url: 'https://example.com/refused' });

        // Acceptance criterion 1 of issue 0015, at the layer a model reads: two
        // situations, two sentences, each naming its own retry verdict.
        expect(dns).toContain('fetch could not resolve this hostname');
        expect(dns).toContain('retrying will not help');
        expect(refused).toContain('fetch could not keep a connection to this host');
        expect(refused).toContain('a retry may help');
        expect(dns).not.toBe(refused);
        // Criterion 4: the raw errno and the host never ride into the transcript.
        expect(dns).not.toContain('ENOTFOUND');
        expect(refused).not.toContain('203.0.113.9');
    });

    it('reports the section cap as the cause of a truncated query answer', async () => {
        const sections = Array.from(
            { length: 24 },
            (_, index) =>
                `## Section ${String(index + 1).padStart(2, '0')}\n\nquantum entry ${String(index + 1).padStart(2, '0')}.`
        ).join('\n\n');

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(sections, { headers: { 'content-type': 'text/plain' } }))
        );

        const capped = (await webfetch().executeTool('fetch', {
            url: 'https://example.com/capped',
            query: 'quantum'
        })) as WebFetchResult;

        // Issue 0016 criterion 2, through the envelope: the cap is named, and no
        // resumable offset is promised for a cause paging cannot fix.
        expect(capped.truncated).toBe(true);
        expect(capped.stopReason).toBe('resultCap');
        expect(capped.matches).toBe(20);
        expect(capped.totalMatches).toBe(24);
        expect(capped.nextOffset).toBeUndefined();
    });

    it('keeps a budget-cut query answer resumable through the envelope', async () => {
        const page = Array.from(
            { length: 6 },
            (_, index) => {
                const label = String(index + 1).padStart(2, '0');

                return `## Section ${label}\n\nquantum ${'x'.repeat(15_000)} END-${label}`;
            }
        ).join('\n\n');

        vi.stubGlobal('fetch', vi.fn(async () => new Response(page, { headers: { 'content-type': 'text/plain' } })));

        const cut = (await webfetch().executeTool('fetch', {
            url: 'https://example.com/long',
            query: 'quantum'
        })) as WebFetchResult;

        // Issue 0016 criterion 1: the byte budget is named as the cause, and the
        // answer arrives with the offset that continues it.
        expect(cut.stopReason).toBe('contentBudget');
        expect(cut.truncated).toBe(true);
        expect(typeof cut.nextOffset).toBe('number');
        expect(cut.content).not.toContain('END-05');

        const resumed = (await webfetch().executeTool('fetch', {
            url: 'https://example.com/long',
            offset: cut.nextOffset as number
        })) as WebFetchResult;

        expect(resumed.offset).toBe(cut.nextOffset);
        expect(resumed.content).toContain('END-05');
    });
});
