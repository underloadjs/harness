// `GET /harnesses/:name` in the browser client (T11) — the read that fills the gap a compiled
// view leaves on purpose.
//
// A `/views` frame types `harnessDefinition` as a `HarnessDescriptor` but OMITS
// `agentInstructions` (../server/protocol.ts:655-663): instruction TEXT does not belong in
// every view frame. The configuration dialog therefore needs one definition, on one explicit
// action, and this file pins the two behaviours that make that safe:
//
//   - the exact route, method and encoding (names are user data);
//   - the DEGRADATION rule. A gateway that has not mounted the GET answers 405, and an
//     unknown name 404; both are "no extra information available", NOT a failure the reader
//     should see, because the caller keeps the instruction text it already had. Every other
//     status stays an error, so a server that is genuinely broken is still reported.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts api-harness-read.test.ts

import type { HarnessDescriptor } from '../server/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHarness } from './api';

type Call = { method: string; url: string; body: string | undefined };

const calls: Call[] = [];

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

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
        const stored = descriptor({ agentInstructions: { instruct: 'Lead with the answer.' } });
        serve((url) => (url === '/api/harnesses/instruct' ? json({ harness: stored }) : json({}) ));

        expect(await getHarness('instruct')).toEqual(stored);
        expect(calls).toEqual([{ method: 'GET', url: '/api/harnesses/instruct', body: undefined }]);
    });

    it('encodes a name that contains a path separator', async () => {
        serve((url) => (url === '/api/harnesses/a%2Fb' ? json({ harness: descriptor({ name: 'a/b' }) }) : json({})));

        expect((await getHarness('a/b'))?.name).toBe('a/b');
        expect(calls.map((call) => call.url)).toEqual(['/api/harnesses/a%2Fb']);
    });

    it('reports no definition rather than an error when the route is not mounted', async () => {
        // The documented standalone contract answers a method it does not mount with 405.
        serve(() => json({ error: { message: 'Use PATCH or DELETE for /api/harnesses/:name.' } }, 405));

        expect(await getHarness('instruct')).toBeUndefined();
        expect(calls).toHaveLength(1);
    });

    it('reports no definition for an unknown harness, which is the same no-new-information answer', async () => {
        serve(() => json({ error: { message: 'Unknown harness "ghost".' } }, 404));

        expect(await getHarness('ghost')).toBeUndefined();
    });

    it('treats a 200 that is not a harness document as no definition', async () => {
        // A proxy with no upstream can answer 200 with anything; the caller must not paint a
        // descriptor it did not get.
        serve(() => json({ ok: true }));

        expect(await getHarness('instruct')).toBeUndefined();
    });

    it('keeps a real server failure loud', async () => {
        serve(() => json({ error: { message: 'The harness store is unavailable.' } }, 500));

        await expect(getHarness('instruct')).rejects.toThrow('The harness store is unavailable.');
    });
});
