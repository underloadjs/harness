// `GET /v1/harness/harnesses/{harness_name}` and its instruction subroutes (T11 → T23 canonical).
//
// WHY THIS READ EXISTS ON THE CANONICAL CONTRACT
// A `GET /harnesses` page answers CARDS, and a card omits the per-agent instruction TEXT,
// the per-agent model map, and the resolved core-tool set (../shared/harness-api.ts:422
// `HarnessCard`). The configuration dialog needs one definition, on one explicit action,
// and the identified read (`HarnessDefinition`, ../shared/harness-api.ts:453) is the route
// that adds them — with the instruction SUMMARY (`HarnessInstructionSummaryEntry`, agent /
// source / overridden / chars) rather than the text, so the definition stays constant-size
// however long the prompts are. The text is one named subresource away:
//   GET /harnesses/{harness_name}/instructions            -> HarnessInstructionIndexResponse
//   GET /harnesses/{harness_name}/instructions/{agent_id} -> HarnessInstructionTextResponse
//
// THE DEGRADATION RULE, RE-DRAWN AGAINST THE SPEC
// The legacy client also swallowed a 405, because a gateway that had not mounted the GET
// answered one. The canonical router declares GET on this path template, and the spec is
// explicit that 405 means "a method this path does not accept" (harness.swagger.yaml:111),
// so a 405 here is a broken deployment, not "no extra information": it must stay loud.
// Only the 404 (unknown name) still degrades, because the caller keeps the definition it
// already had. Every other status stays an error.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts api-harness-read.test.ts

import type { HarnessDefinition, HarnessDefinitionResponse } from '../shared/harness-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHarness, getHarnessInstructionIndex, getHarnessInstructionText } from './api';

type Call = { method: string; url: string; body: string | undefined };

const calls: Call[] = [];

// A definition card plus the three fields only the identified read publishes.
const definition = (overrides: Partial<HarnessDefinition> = {}): HarnessDefinition => ({
    name: 'instruct',
    title: 'Instruct',
    description: 'A general instruction-following agent.',
    requires_endpoint: true,
    primary: 'instruct',
    subagents: [],
    agents: ['instruct'],
    tools: ['read'],
    builtin: true,
    definition_revision: 3,
    core_tools: ['toolRequest', 'tasks'],
    agent_models: { instruct: 'gpt-5' },
    instruction_summary: [{ agent: 'instruct', source: 'catalogue', overridden: false, chars: 28 }],
    ...overrides
}) as HarnessDefinition;

const serve = (handler: (url: string, init?: RequestInit) => Response): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            calls.push({ method: init?.method ?? 'GET', url, body: init?.body === undefined ? undefined : String(init.body) });

            return handler(url, init);
        })
    );
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    calls.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getHarness', () => {
    it('reads one definition by name, encoded, with no method and no body', async () => {
        const stored = definition();
        serve((url) => (url === '/v1/harness/harnesses/instruct' ? json({ harness: stored } satisfies HarnessDefinitionResponse) : json({})));

        expect(await getHarness('instruct')).toEqual(stored);
        expect(calls).toEqual([{ method: 'GET', url: '/v1/harness/harnesses/instruct', body: undefined }]);
    });

    it('encodes a name that contains a path separator', async () => {
        serve((url) =>
            url === '/v1/harness/harnesses/a%2Fb' ? json({ harness: definition({ name: 'a/b' }) }) : json({})
        );

        expect((await getHarness('a/b'))?.name).toBe('a/b');
        expect(calls.map((call) => call.url)).toEqual(['/v1/harness/harnesses/a%2Fb']);
    });

    it('reports no definition for an unknown harness, which is the same no-new-information answer', async () => {
        // The delete-style degradation the contract keeps: an unknown name is a 404, and
        // the caller keeps whatever definition it already had on screen.
        serve(() => json({ error: { message: 'Unknown harness "ghost".' } }, 404));

        expect(await getHarness('ghost')).toBeUndefined();
        expect(calls).toHaveLength(1);
    });

    it('treats a 200 that is not a definition document as no definition', async () => {
        // A proxy with no upstream can answer 200 with anything; the caller must not paint
        // a definition it did not get.
        serve(() => json({ ok: true }));

        expect(await getHarness('instruct')).toBeUndefined();
    });

    it('keeps a method the path does not declare a loud failure', async () => {
        // The legacy 405 swallow is gone: the canonical router mounts GET on this path, so
        // a 405 is a deployment that is not answering the contract at all.
        serve(() => json({ error: { message: 'Use PATCH or DELETE for /v1/harness/harnesses/instruct.' } }, 405));

        await expect(getHarness('instruct')).rejects.toThrow(
            'Use PATCH or DELETE for /v1/harness/harnesses/instruct.'
        );
    });

    it('keeps a real server failure loud', async () => {
        serve(() => json({ error: { message: 'The harness store is unavailable.' } }, 500));

        await expect(getHarness('instruct')).rejects.toThrow('The harness store is unavailable.');
    });

    it('publishes agent_colors for the colours the panes paint, and nothing for a definition that has none', async () => {
        // T4/R2: `agent_colors` is only ever on the IDENTIFIED read (a card omits it,
        // ../shared/harness-api.ts:422), and ./main.ts reads it through `descriptorOf` ->
        // `contract.ts agentColorsOf`. Both halves of that chain live here: the wire body the
        // route answers, and the row shape the panes actually render.
        const stored = definition({ agent_colors: { instruct: '#ff6600', summarizer: '#4ade80' } });

        serve((url) => (url === '/v1/harness/harnesses/instruct' ? json({ harness: stored }) : json({})));

        const fetched = await getHarness('instruct');

        expect(fetched?.agent_colors).toEqual({ instruct: '#ff6600', summarizer: '#4ade80' });

        const { descriptorOf } = await import('./api');
        const view = descriptorOf(fetched as HarnessDefinition);

        expect(view.agentColors).toEqual({ instruct: '#ff6600', summarizer: '#4ade80' });

        // An uncoloured definition keeps its pre-R2 shape: no key on the wire, no key on the
        // row — which is what lets `agentColorsOf` answer "nothing configured" truthfully.
        serve((url) => (url === '/v1/harness/harnesses/instruct' ? json({ harness: definition() }) : json({})));

        const uncoloured = await getHarness('instruct');

        expect(Object.prototype.hasOwnProperty.call(uncoloured ?? {}, 'agent_colors')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(descriptorOf(uncoloured as HarnessDefinition), 'agentColors')).toBe(
            false
        );
    });
});

describe('the instruction subroutes', () => {
    it('indexes every member with provenance and length, and no text', async () => {
        const index = {
            harness_name: 'instruct',
            total: 2,
            items: [
                { agent: 'instruct', source: 'catalogue', overridden: false, chars: 28 },
                { agent: 'helper', source: 'harness', overridden: true, chars: 140 }
            ]
        };

        serve((url) => (url === '/v1/harness/harnesses/instruct/instructions' ? json(index) : json({})));

        expect(await getHarnessInstructionIndex('instruct')).toEqual(index);
        expect(calls).toEqual([{ method: 'GET', url: '/v1/harness/harnesses/instruct/instructions', body: undefined }]);
    });

    it('reads ONE member\'s effective text by encoded agent id', async () => {
        const text = {
            harness_name: 'a/b',
            agent: 'in struct',
            source: 'harness',
            instruction: 'Lead with the answer.',
            guidelines: ['Be concise.'],
            chars: 21
        };

        serve((url) =>
            url === '/v1/harness/harnesses/a%2Fb/instructions/in%20struct' ? json(text) : json({})
        );

        expect(await getHarnessInstructionText('a/b', 'in struct')).toEqual(text);
        expect(calls.map((call) => call.url)).toEqual(['/v1/harness/harnesses/a%2Fb/instructions/in%20struct']);
    });

    it('refuses a member this definition does not have, in the server\'s own words', async () => {
        // Unlike the definition read, an instruction read is addressed explicitly by the
        // reader, so an unknown member is a failure to report, not a blank to paint.
        serve(() => json({ error: { message: 'Unknown agent "ghost".' } }, 404));

        await expect(getHarnessInstructionText('instruct', 'ghost')).rejects.toThrow('Unknown agent "ghost".');
    });
});
