// The lazy block-detail route and the raw `GET /harnesses/:name` read (T11).
//
// Two surfaces, one rule each, and both are about WHEN a browser is allowed to ask for text:
//
//   - `GET views/:id/turns/:tid/blocks/:bid` is the R8 answer to "what did this segment
//     actually contain". It is reached only from a segment click, so the assertion that
//     matters is the exact address and the envelope field the answer is read from
//     (`{ block }`, ../server/protocol.ts:712).
//   - `GET /harnesses/:name` exists because a `/views` frame OMITS
//     `harnessDefinition.agentInstructions` (../server/protocol.ts:655-663). The
//     configuration dialog reads it on an explicit open, and a gateway that has not mounted
//     the route (405) or has forgotten the harness (404) must degrade to "keep what you have"
//     rather than throw at the reader.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-api-blocks.test.ts api-harness-read.test.ts

import type { TurnBlockDetail } from '../server/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBlockDetail } from './view-api';

const T = 1_700_000_000_000;

type Call = { method: string; url: string; body: string; keepalive: boolean };

const calls: Call[] = [];

// A stub that THROWS for a route it does not declare, so a client that invents a second
// request (an eager bar fetch, a polling detail read) fails here instead of passing silently.
const serve = (routes: Record<string, unknown>, statuses: Record<string, number> = {}): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const url = String(input);

            calls.push({ method, url, body: String(init?.body ?? ''), keepalive: init?.keepalive === true });

            const key = `${method} ${url}`;
            const value = routes[key] ?? routes[url];

            if (value === undefined) throw new Error(`unexpected request: ${method} ${url}`);

            return new Response(JSON.stringify(value), {
                status: statuses[key] ?? 200,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );
};

const block: TurnBlockDetail = {
    kind: 'tool',
    id: '0-tool-7',
    turnId: 't 1',
    sectionId: 't1:0',
    name: 'read',
    chars: 54,
    argsChars: 28,
    resultChars: 26,
    inPrompt: true,
    state: 'ok',
    eventFrom: 7,
    eventTo: 9,
    at: T,
    endedAt: T + 800,
    sessionId: 's 1',
    args: '{"path":"notes.md","max":20}',
    result: 'the whole recorded file body'
};

beforeEach(() => {
    calls.length = 0;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getBlockDetail', () => {
    it('addresses ONE segment by its exact route and unwraps the block envelope', async () => {
        serve({ 'GET /api/views/s%201/turns/t%201/blocks/0-tool-7': { block } });

        expect(await getBlockDetail('s 1', 't 1', '0-tool-7')).toEqual(block);
        expect(calls).toEqual([{ method: 'GET', url: '/api/views/s%201/turns/t%201/blocks/0-tool-7', body: '', keepalive: false }]);
    });

    it('encodes a block id the way the step route does, because ids are user-visible data', async () => {
        serve({ 'GET /api/views/s1/turns/t1/blocks/0-system-instructions': { block: { ...block, kind: 'system', entries: ['Answer directly.'] } } });

        const detail = await getBlockDetail('s1', 't1', '0-system-instructions');

        expect(detail.entries).toEqual(['Answer directly.']);
        expect(calls.map((call) => call.url)).toEqual(['/api/views/s1/turns/t1/blocks/0-system-instructions']);
    });

    it('keeps an absent payload field absent instead of reading the error envelope', async () => {
        // 404 for a block the bar never minted (or one dropped with a failed attempt) is the
        // SERVER's honest answer; the caller renders the failure, so the transport must not
        // swallow it into a fake empty block.
        serve({ 'GET /api/views/s1/turns/t1/blocks/nope': { error: { message: 'Unknown block "nope".' } } }, { 'GET /api/views/s1/turns/t1/blocks/nope': 404 });

        await expect(getBlockDetail('s1', 't1', 'nope')).rejects.toThrow('Unknown block "nope".');
        expect(calls).toHaveLength(1);
    });

    it('asks once per click and never for the whole bar', async () => {
        serve({
            'GET /api/views/s1/turns/t1/blocks/0-tool-7': { block },
            'GET /api/views/s1/turns/t1/blocks/0-tool-9': { block: { ...block, id: '0-tool-9' } }
        });

        await getBlockDetail('s1', 't1', '0-tool-7');
        await getBlockDetail('s1', 't1', '0-tool-9');

        expect(calls.map((call) => call.url)).toEqual([
            '/api/views/s1/turns/t1/blocks/0-tool-7',
            '/api/views/s1/turns/t1/blocks/0-tool-9'
        ]);
    });
});
