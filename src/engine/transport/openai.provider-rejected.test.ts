// transport/openai.ts — a deterministic HTTP refusal is CLASSIFIED (T8, AC3).
//
// Pinned contract (the pre-T8 behaviour was the defect, so these expectations come from
// the required behaviour):
//   - 400 / 401 / 403 / 404 yield ONE terminal frame that carries the machine code
//     `provider-rejected` and QUOTES THE STATUS, because `agent()` decides the retry
//     policy on the code (core/agent.ts) while the message is the half that reaches the
//     model, a log line and an event consumer. Before T8 these frames carried no code,
//     so a REVOKED KEY walked the whole 1 + 10-attempt ladder (~17 min) and read exactly
//     like a hang (AC3);
//   - 408, 429 and 5xx keep the historical codeless frame byte-for-byte — TIME, not the
//     request, is what fixes those, so they keep the transient ladder. The cut-off is
//     argued in transport/provider-timeouts.ts `isTerminalProviderStatus`;
//   - a 400 whose body says the request is too large stays `context-overflow` (issue
//     0004): that classifier runs first, and T8 did not absorb it;
//   - the frame redacts the API key out of the provider's own echo.
//
// Run: yarn vitest run src/transport/openai.provider-rejected.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_REJECTED_CODE, openAICompatible } from '../index';
import type { HarnessStreamEvent } from '../index';

const BASE_URL = 'http://localhost:8800/providers/private/v1';
const CHAT_URL = 'http://localhost:8800/providers/private/v1/chat/completions';

const request = {
    model: 'local/basalt',
    messages: [{ role: 'user' as const, content: 'Write' }]
};

afterEach(() => {
    vi.unstubAllGlobals();
});

const streamOnce = async (): Promise<HarnessStreamEvent[]> => {
    const stream = openAICompatible({ baseURL: BASE_URL });
    const collected: HarnessStreamEvent[] = [];

    for await (const event of stream(request)) collected.push(event);

    return collected;
};

const refuse = (status: number, statusText: string, body: string): void => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, statusText })));
};

// The exact sentence T8 produces: code, the redacted dial target, the STATUS, why no
// retry follows, the fix that applies to that status, then the provider's own line.
const refused = (status: number, advice: string, said: string): string =>
    `provider-rejected: the provider answered ${CHAT_URL} with HTTP ${status} and refused the request, ` +
    'so re-sending the same bytes would be refused again — this turn failed after one attempt ' +
    `instead of waiting out the retry ladder.${advice} The provider said: "${said}"`;

describe('a deterministic refusal is classified as `provider-rejected` (T8, AC3)', () => {
    it('names a refused credential (401) with the status and the fix, in one frame', async () => {
        refuse(401, 'Unauthorized', 'nope');

        const collected = await streamOnce();

        // ONE frame, and it carries the code: the terminal decision `agent()` acts on.
        expect(collected).toStrictEqual([
            {
                type: 'error',
                code: PROVIDER_REJECTED_CODE,
                message: refused(
                    401,
                    ' The credential was refused: check the API key this provider was configured with.',
                    'nope'
                )
            }
        ]);
    });

    it('names a forbidden route (403) and a missing model (404) as refusals', async () => {
        refuse(403, 'Forbidden', 'model not allowed');

        expect(await streamOnce()).toStrictEqual([
            {
                type: 'error',
                code: PROVIDER_REJECTED_CODE,
                message: refused(
                    403,
                    ' The credential is not allowed on this endpoint or model: check what it is entitled to.',
                    'model not allowed'
                )
            }
        ]);

        refuse(404, 'Not Found', 'model local/basalt not found');

        expect(await streamOnce()).toStrictEqual([
            {
                type: 'error',
                code: PROVIDER_REJECTED_CODE,
                message: refused(
                    404,
                    ' The model or route does not exist here: check the model id and the configured base path.',
                    'model local/basalt not found'
                )
            }
        ]);
    });

    it('classifies a refused request shape (400) as a refusal, and leaves a 400 overflow alone', async () => {
        // A plain 400 (an out-of-range argument) is about the request, so it is terminal.
        refuse(400, 'Bad Request', 'Invalid value for max_tokens: expected integer');

        expect(await streamOnce()).toStrictEqual([
            {
                type: 'error',
                code: PROVIDER_REJECTED_CODE,
                message: refused(
                    400,
                    ' The provider refused this request shape, so check the request rather than the endpoint.',
                    'Invalid value for max_tokens: expected integer'
                )
            }
        ]);

        // A 400 that says the request is TOO LARGE still belongs to issue 0004's
        // classifier, which runs first — T8 must not swallow the overflow advice.
        refuse(400, 'Bad Request', 'This request exceeds the maximum context length of 8192 tokens');

        const [overflow] = await streamOnce();

        expect(overflow).toMatchObject({ type: 'error', code: 'context-overflow' });
    });

    it('keeps 408, 429 and 5xx on the historical codeless frame so the ladder still applies', async () => {
        // The cut-off, pinned from the other side: a refusal TIME can fix is NOT
        // reclassified, and neither is any other status.
        const transient: [number, string, string][] = [
            [408, 'Request Timeout', 'too slow'],
            [429, 'Too Many Requests', 'slow down'],
            [500, 'Internal Server Error', 'boom'],
            [503, 'Service Unavailable', 'upstream unavailable'],
            [409, 'Conflict', 'busy'],
            [402, 'Payment Required', 'no credit']
        ];

        for (const [status, statusText, body] of transient) {
            refuse(status, statusText, body);

            // Exactly the pre-T8 frame: no `code`, no `details`, the historical wording.
            expect(await streamOnce()).toStrictEqual([{ type: 'error', message: `HTTP ${status}: ${body}` }]);
        }
    });

    it('redacts the configured key out of a provider that echoes it back', async () => {
        const KEY = 'sk-secret-value-1234567890';

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(`invalid api key: ${KEY}`, { status: 401, statusText: 'Unauthorized' }))
        );

        const stream = openAICompatible({ baseURL: BASE_URL, apiKey: KEY });
        const collected: HarnessStreamEvent[] = [];

        for await (const event of stream(request)) collected.push(event);

        expect(String((collected[0] as { message: string }).message)).not.toContain(KEY);
        expect(String((collected[0] as { message: string }).message)).toContain('[redacted]');
    });
});
