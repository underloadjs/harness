// Rough context sizing (src/core/context-estimate.ts).
//
// The estimator's ONLY contract is: `ceil(characters / 4)`, the same convention the UI
// context bar uses (src/frontend/ui/turns.ts). Every assertion below is an exact number
// derived by hand from the input, because a compaction limit is a USER-VISIBLE setting:
// if the formula drifts, 100000 stops meaning what the operator typed.
//
// Also pinned: what is deliberately NOT counted (attachment BYTES, assistant
// `reasoning`) and the totality rule — a hostile/restored message shape must not throw
// in the middle of a turn boundary.

import { describe, expect, it } from 'vitest';
import { estimateContextTokens } from './context-estimate';
import type { HarnessMessage } from '../types';

describe('estimateContextTokens', () => {
    it('is exactly zero for nothing to send', () => {
        expect(estimateContextTokens([])).toBe(0);
        // A missing transcript is a caller bug, and the estimator is total anyway.
        expect(estimateContextTokens(undefined)).toBe(0);
        expect(estimateContextTokens([], [])).toBe(0);
    });

    it('counts plain text at four characters per token, rounding up', () => {
        // 40 chars -> 10 tokens exactly.
        const forty = 'x'.repeat(40);
        expect(estimateContextTokens([{ role: 'user', content: forty }])).toBe(10);

        // 387 chars -> ceil(96.75) = 97, the same boundary the frontend test pins.
        const odd = 'x'.repeat(387);
        expect(estimateContextTokens([{ role: 'user', content: odd }])).toBe(97);

        // 1 char still costs one token (ceil(0.25)), so a non-empty transcript is
        // never measured as zero.
        expect(estimateContextTokens([{ role: 'user', content: 'x' }])).toBe(1);
    });

    it('sums every message, including the system block', () => {
        const messages: HarnessMessage[] = [
            { role: 'system', content: 'a'.repeat(100) },
            { role: 'user', content: 'b'.repeat(60) },
            { role: 'assistant', content: 'c'.repeat(40) },
            { role: 'tool', toolCallId: 'c1', name: 'read', content: 'd'.repeat(100) }
        ];

        // 300 chars + the tool message's own `name` (4) = 304 -> 76 tokens.
        expect(estimateContextTokens(messages)).toBe(76);
    });

    it('counts an assistant turn\'s tool-call names and raw arguments', () => {
        // The provider receives the call id text inside the message payload, and the
        // arguments are the single biggest thing a turn can carry.
        const messages: HarnessMessage[] = [
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"a.ts","content":"hello"}' }]
            }
        ];

        // name 'write' (5) + arguments (33 chars) = 38 -> 10 tokens.
        expect(estimateContextTokens(messages)).toBe(10);
    });

    it('adds leading instruction text', () => {
        // Array form (what `agent.instructions` actually is).
        expect(estimateContextTokens([], ['a'.repeat(80), 'b'.repeat(20)])).toBe(25);
        // Joined-string form.
        expect(estimateContextTokens([], 'a'.repeat(100))).toBe(25);
        // Both halves together: 100 + 100 -> 50.
        expect(estimateContextTokens([{ role: 'user', content: 'x'.repeat(100) }], 'i'.repeat(100))).toBe(50);
    });

    it('counts an attachment name and mime type, but never its bytes', () => {
        const withMedia: HarnessMessage[] = [
            {
                role: 'user',
                content: 'look',
                attachments: [
                    {
                        id: 'att-1',
                        kind: 'image',
                        name: 'diagram.png',
                        mimeType: 'image/png',
                        bytes: 20 * 1024 * 1024,
                        // A 20 MiB file base64-encoded is ~27M characters. Counting them
                        // would make one screenshot look like a 6.7M-token context.
                        data: 'A'.repeat(1000)
                    } as never
                ]
            }
        ];

        // 'look' (4) + 'diagram.png' (11) + 'image/png' (9) = 24 -> 6 tokens.
        expect(estimateContextTokens(withMedia)).toBe(6);
    });

    it('does not count retained assistant reasoning (it is never re-sent)', () => {
        const bare: HarnessMessage[] = [{ role: 'assistant', content: 'answer' }];
        const reasoned: HarnessMessage[] = [
            { role: 'assistant', content: 'answer', reasoning: 'x'.repeat(400) }
        ];

        expect(estimateContextTokens(bare)).toBe(estimateContextTokens(reasoned));
    });

    it('is total for hostile or restored message shapes', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        const hostile = [
            // A number/boolean content is counted as its text, like a provider would.
            { role: 'user', content: 12345 as never },
            { role: 'user', content: cyclic as never },
            { role: 'user', content: null as never },
            // A non-object entry in the array is skipped, not thrown on.
            'nonsense' as never
        ];

        // '12345' is the only measurable text: 5 chars -> 2 tokens.
        expect(estimateContextTokens(hostile)).toBe(2);
    });
});
