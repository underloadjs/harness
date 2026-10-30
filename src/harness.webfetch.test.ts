// webFetch inside a harness: conditional registration and provider shape.
//
// The factory's wire behaviour is covered in tools/webfetch/webfetch.test.ts.
// These tests pin the harness-level contract instead: whether the tool exists,
// when, and what a host's own `webFetch` tool overrides. No host env and no
// network: keys are injected, fetch is a stub.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent } from '@underload/harness';

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

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// Registration tests never run the model, but an agent still needs a transport.
const idle = () => agent({ model: 'm', stream: scripted([answer('idle')]) });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('registration', () => {
    it('is off when the configuration does not opt in', () => {
        const writer = harness({ agents: { writer: idle() } });

        expect(writer.tools.webFetch).toBeUndefined();
    });

    it('is off when explicitly false', () => {
        const writer = harness({ agents: { writer: idle() }, webfetch: false });

        expect(writer.tools.webFetch).toBeUndefined();
    });

    it('registers keyless: unlike webSearch, "no key" still means a runnable tool', () => {
        vi.stubEnv('EXA_API_KEY', '');

        const writer = harness({ agents: { writer: idle() }, webfetch: true });

        expect(writer.tools.webFetch).toBeDefined();
        // W4: fetching stays discovery-eligible; core is reserved for search.
        expect(writer.tools.webFetch.visibility).toBe('searchable');

        const properties = (writer.tools.webFetch.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual(['url', 'format']);
    });

    it('offers the exa provider when the process environment has a key', () => {
        vi.stubEnv('EXA_API_KEY', 'exa-secret-key');

        const writer = harness({ agents: { writer: idle() }, webfetch: true });

        const properties = (writer.tools.webFetch.parameters as { properties: Record<string, unknown> }).properties;
        expect(Object.keys(properties)).toEqual(['url', 'format', 'provider']);
    });

    it('a configured tool named webFetch wins over the field', () => {
        const custom = tool({
            description: 'My own fetch.',
            tags: ['web'],
            execute: () => ({ content: 'mine' })
        });

        const writer = harness({
            agents: { writer: idle() },
            tools: { webFetch: custom },
            webfetch: true
        });

        expect(writer.tools.webFetch).toBe(custom);
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

        const result = (await writer.tools.webFetch({ url: 'https://example.com' })) as {
            content: string;
            title?: string;
        };

        expect(result.title).toBe('Doc');
        expect(result.content).toBe('# Page');
    });
});
