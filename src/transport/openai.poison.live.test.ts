// Live check (not part of the committed suite): the exact transcript shape that
// killed thread IT3 — an assistant tool call whose `arguments` were cut off by the
// output-token ceiling — replayed through the REAL transport against the running
// local provider. Before the wire guard this request answered
// `500 {"error":"Internal Server Error"}`; the transport now repairs `arguments`
// at the wire boundary while the transcript keeps the raw text.
import { describe, expect, it } from 'vitest';
import { openAICompatible } from '@underload/harness';
import type { HarnessMessage, HarnessStreamEvent } from '@underload/harness';

const BASE_URL = 'http://localhost:5500/providers/private/v1';
const MODEL = 'local/basalt';

// This is the only test in the package that talks to a real server, and the point
// of it is the SERVER's behaviour (a stubbed transport cannot 500 on us). Skip
// when nothing is listening so the suite stays runnable offline; run it against a
// live endpoint to confirm the wire guard actually clears the failure.
const providerUp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 })
})
    .then((response) => response.ok)
    .catch(() => false);

// The 32,450-character unterminated string from journal line 86565, verbatim shape.
const POISON = '{"command":"echo ' + '0123456789'.repeat(3244);

describe.skipIf(!providerUp)('live provider: replaying a truncated tool call', () => {
    it('does not 500 when the history carries the poison arguments', async () => {
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'Reply with exactly OK.' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call_poison', name: 'shell', arguments: POISON }]
            },
            {
                role: 'tool',
                toolCallId: 'call_poison',
                name: 'shell',
                content: 'Tool "shell" received malformed JSON arguments: Unterminated string.'
            },
            { role: 'user', content: 'Reply with exactly OK.' }
        ];

        const events: HarnessStreamEvent[] = [];
        const stream = openAICompatible({ baseURL: BASE_URL, apiKey: 'test' });

        for await (const event of stream({ model: MODEL, messages })) {
            events.push(event);
        }

        const terminal = events.at(-1);

        // The transcript still holds the broken text: the guard is wire-only.
        expect((messages[1] as { toolCalls: [{ arguments: string }] }).toolCalls[0].arguments).toBe(
            POISON
        );

        // And the provider answered instead of failing the whole request.
        expect(terminal?.type).toBe('done');
    }, 60_000);
});
