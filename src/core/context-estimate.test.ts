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
//
// The second half of the file pins the T5.4 hybrid: `transcriptChars` (the character
// weight the estimator divides by 4), `anchorFromUsage` (the one-sided sanity rule for a
// provider-reported prefix), and `estimateContextTokensHybrid` (anchor + chars/4 over the
// delta, with the exact numbers derived by hand).

import { describe, expect, it } from 'vitest';
import {
    anchorFromUsage,
    estimateContextTokens,
    estimateContextTokensHybrid,
    transcriptChars
} from './context-estimate';
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

// ---------------------------------------------------------------------------
// T5.4 — the character weight, the provider anchor, and the hybrid estimate
// ---------------------------------------------------------------------------

describe('transcriptChars', () => {
    it('is the exact character weight the estimator divides by 4', () => {
        const messages: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];

        // 400 + the 40-character instruction block.
        expect(transcriptChars(messages, 'i'.repeat(40))).toBe(440);
        // The estimator is this number divided by 4, ceiling — one contract, two views.
        expect(estimateContextTokens(messages, 'i'.repeat(40))).toBe(Math.ceil(440 / 4));

        // Nothing to send is exactly 0, in every spelling.
        expect(transcriptChars([])).toBe(0);
        expect(transcriptChars(undefined)).toBe(0);
        expect(transcriptChars([], [])).toBe(0);
    });

    it('counts the same fields as the estimator, including tool calls and names', () => {
        // The anchor is recorded in THIS unit, so the two views must agree exactly or
        // the delta term would compare a provider count against a different measure.
        const messages: HarnessMessage[] = [
            { role: 'system', content: 'a'.repeat(100) },
            { role: 'user', content: 'b'.repeat(60) },
            { role: 'assistant', content: 'c'.repeat(40) },
            { role: 'tool', toolCallId: 'c1', name: 'read', content: 'd'.repeat(100) }
        ];

        // 300 + the tool message's own `name` (4).
        expect(transcriptChars(messages)).toBe(304);

        const calls: HarnessMessage[] = [
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'call-1', name: 'write', arguments: '{"path":"a.ts","content":"hello"}' }]
            }
        ];

        // name (5) + raw arguments (33); the call ID is not counted, by design.
        expect(transcriptChars(calls)).toBe(38);
    });
});

describe('anchorFromUsage', () => {
    it('pairs a reported prompt size with the prefix it was measured over', () => {
        expect(anchorFromUsage({ input: 1_000, output: 10, total: 1_010 }, 3_980)).toEqual({
            tokens: 1_000,
            chars: 3_980
        });

        // A fractional char count is floored, never rounded up: the anchor must not
        // claim more measured text than there was.
        expect(anchorFromUsage({ input: 1_000, output: 10, total: 1_010 }, 3_980.7)).toEqual({
            tokens: 1_000,
            chars: 3_980
        });
    });

    it('refuses a request with no usable count', () => {
        expect(anchorFromUsage(undefined, 4_000)).toBeUndefined();
        expect(anchorFromUsage({ input: 0, output: 0, total: 0 }, 4_000)).toBeUndefined();
        expect(anchorFromUsage({ input: Number.NaN, output: 0, total: 0 }, 4_000)).toBeUndefined();
        expect(anchorFromUsage({ input: -5, output: 0, total: 0 }, 4_000)).toBeUndefined();
        // A provider that never reports usage keeps the plain heuristic; that is the
        // byte-for-byte pre-T5.4 behaviour, not a fallback to invent a number.
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(400) }], undefined, undefined)).toBe(100);
    });

    it('refuses a count implausibly BELOW the text, and adopts one above it', () => {
        // 4000 chars -> a heuristic of 1000 tokens. The floor is 1/4 of that: 250.
        expect(anchorFromUsage({ input: 250, output: 0, total: 250 }, 4_000)).toEqual({ tokens: 250, chars: 4_000 });
        expect(anchorFromUsage({ input: 249, output: 0, total: 249 }, 4_000)).toBeUndefined();

        // A provider reporting 100x the heuristic is the POINT of anchoring: the tool
        // schemas and message framing are not in `chars` at all, and refusing that
        // number would throw away the only real measurement available.
        expect(anchorFromUsage({ input: 100_000, output: 0, total: 100_000 }, 4_000)).toEqual({
            tokens: 100_000,
            chars: 4_000
        });
    });

    it('keeps a reported count for an empty measured prefix', () => {
        // The framing/schema overhead case: nothing countable in the transcript, and
        // the provider still charged 512 tokens for the request.
        expect(anchorFromUsage({ input: 512, output: 0, total: 512 }, 0)).toEqual({ tokens: 512, chars: 0 });
        expect(anchorFromUsage({ input: 512, output: 0, total: 512 }, -50)).toEqual({ tokens: 512, chars: 0 });
    });
});

describe('estimateContextTokensHybrid', () => {
    it('is the plain heuristic when there is no anchor', () => {
        const messages: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];

        expect(estimateContextTokensHybrid(messages, 'i'.repeat(40))).toBe(110);
        expect(estimateContextTokensHybrid(messages, 'i'.repeat(40), undefined)).toBe(
            estimateContextTokens(messages, 'i'.repeat(40))
        );
    });

    it('extrapolates only the text that arrived after the anchored request', () => {
        const anchor = { tokens: 1_000, chars: 3_980 };

        // Exactly the anchored prefix: the provider's own number, unchanged.
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(3_980) }], '', anchor)).toBe(1_000);

        // +60 characters -> +15 tokens.
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(4_000) }], 'i'.repeat(40), anchor)).toBe(
            1_015
        );

        // Why this is the whole feature: 40 400 chars of transcript measured as
        // 40 000 by the anchored prefix, so the estimate is 25 000 + 100 = 25 100
        // while the pure heuristic would still say ceil(40 400 / 4) = 10 100.
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(40_400) }], undefined, {
            tokens: 25_000,
            chars: 40_000
        })).toBe(25_100);
        expect(estimateContextTokens([{ role: 'user', content: 'x'.repeat(40_400) }])).toBe(10_100);
    });

    it('follows the stated rule when the transcript is now SHORTER than the anchor', () => {
        // A withheld unit or an edited message reduces the delta term; the removed text
        // is discounted at the same 4 chars/token, rounding a negative toward zero.
        const anchor = { tokens: 1_000, chars: 3_980 };

        // 440 chars: 1000 + ceil((440 - 3980) / 4) = 1000 - 885.
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(400) }], 'i'.repeat(40), anchor)).toBe(115);

        // Clamped at zero: an anchor can never produce a negative context.
        expect(estimateContextTokensHybrid([{ role: 'user', content: '' }], undefined, { tokens: 10, chars: 4_000 })).toBe(0);
    });

    it('is monotonic inside one anchor window', () => {
        // The estimator's stability contract, restated for the hybrid: appending text
        // never lowers the number. The only ways it moves DOWN are the two stated in
        // the module header — a new provider count, or a transcript that shrank.
        const anchor = { tokens: 1_000, chars: 400 };
        const at = (chars: number): number =>
            estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(chars) }], undefined, anchor);

        expect([at(400), at(401), at(404), at(408)]).toEqual([1_000, 1_001, 1_001, 1_002]);
    });

    it('falls back to the heuristic for a hostile anchor instead of throwing', () => {
        const messages: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];

        expect(estimateContextTokensHybrid(messages, undefined, { tokens: Number.NaN, chars: 100 })).toBe(100);
        expect(estimateContextTokensHybrid(messages, undefined, { tokens: 0, chars: 100 })).toBe(100);
        expect(estimateContextTokensHybrid(messages, undefined, { tokens: -5, chars: 100 })).toBe(100);

        // An unusable `chars` is read as "no measured prefix", which is what an
        // empty-prefix anchor means: the whole transcript is delta.
        expect(estimateContextTokensHybrid(messages, undefined, { tokens: 1_000, chars: Number.NaN })).toBe(1_100);
    });

    it('treats an empty-prefix anchor as framing overhead on top of the text', () => {
        // 512 tokens reported for an uncountable prefix + 40 chars of new text.
        expect(
            estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(40) }], undefined, {
                tokens: 512,
                chars: 0
            })
        ).toBe(522);
    });
});
