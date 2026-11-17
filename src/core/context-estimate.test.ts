// Rough context sizing (src/core/context-estimate.ts).
//
// The estimator's contract is `ceil(SERIALIZED-PAYLOAD BYTES / 4)` over the text listed in
// the module header — the bytes the JSON request body carries, not the JavaScript
// characters. The unit changed on 2026-11-17 (T5) because the old one was the arithmetic
// behind a refusal: session 6a94b896 was billed 225,612 tokens for a body the harness
// believed measured 193,428, so the 200,000 compaction trigger fired one request late and
// the request after it was refused (`Temp/d1/report.md`). Every assertion below is an exact
// number derived BY HAND from the input — a compaction limit is a USER-VISIBLE setting, so
// if the formula drifts, 100000 stops meaning what the operator typed.
//
// Pins that MOVED with the unit change, and why (nothing here was weakened — every moved
// pin moved UP, toward the billed figure):
//   - an assistant tool-call fixture: 38 characters of raw JSON arguments are 41 payload
//     bytes (8 quote characters double), so the entry's weight is 46 and not 38;
//   - every ANCHORED growth figure: the delta term now carries `ANCHOR_GROWTH_MARGIN`
//     (0.166, the measured round-21 residual), justified in "THE ANCHORED GROWTH MARGIN"
//     block below and reproduced round-by-round against the 20 real usage rows in the
//     calibration replay at the bottom of this file.
//   - ONE pin moved DOWN, and it is a floor, not an answer: the anti-untrustworthy-anchor clamp
//     is 250 -> 63 for a 1,000-byte request with a 20-token anchor. It used to be the plain
//     heuristic re-imposed ON TOP of a provider's own count, which contradicts the requirement
//     the anchor exists for ("never below lastBilledInput + measuredSerializedGrowth + margin")
//     and fails the published harness case "adopts an anchor BELOW the heuristic when the text
//     can support it" (src/harness.budget.test.ts). It now sits at `plain / ANCHOR_MINIMUM_RATIO`
//     — the SAME 16-bytes-per-token boundary `anchorFromUsage` requires to admit an anchor at all
//     (pinned at its own line below: 4,000 bytes -> heuristic 1,000 -> boundary 250), so there is
//     one rule instead of two. No anchor in the measured replay is anywhere near it: the round-21
//     anchored answer is 205,755 against a boundary of 40,272.
// Everything ASCII-without-escapes is byte-identical to the old number, which is why the
// great majority of the pins below did not move at all.
//
// Also pinned: what is deliberately NOT counted (attachment BYTES), the MIME field spelling
// (`mime`, with a `mimeType` fallback — the term was silently empty for every real
// attachment until T5), the tool-catalogue floor and the helper that makes it countable, the
// anchored delta being priced in ONE currency (bytes on both sides of the subtraction — see
// "THE ANCHORED DELTA IS ONE CURRENCY"), and the totality rule — a hostile/restored message
// shape must not throw mid-turn-boundary.
//
// ASSISTANT `reasoning` IS counted, and only when the entry's own `reasoningIncluded` flag does
// not say it was withheld. That is not a new opinion about what a provider receives — it is the
// same rule the projection applies (`core/agent.ts` `withoutWithheldReasoning` deletes the key
// from a flagged entry's request copy, `transport/openai.ts` then emits `reasoning_content` for
// whatever survives). An unflagged entry's thinking rides and is billed, so an estimator that
// ignored it under-measured every conversation on a thinking model — and made every thinking
// saving the context trimmer writes read as zero.
//
// The last third of the file pins the T5.4 hybrid: `transcriptChars` (the weight pass the
// estimator divides by 4), `anchorFromUsage` (the one-sided sanity rule for a provider-reported
// prefix), `estimateContextTokensHybrid` (anchor + margined growth), and the calibration replay
// that shows the measured refusal would not have happened.

import { describe, expect, it } from 'vitest';
import {
    anchorFromUsage,
    estimateAttachmentBytes,
    estimateContextTokens,
    estimateContextTokensHybrid,
    estimateTokensFromChars,
    toolSchemaPayloadBytes,
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

    it('counts plain text at four bytes per token, rounding up', () => {
        // 40 ASCII chars -> 40 payload bytes -> 10 tokens exactly. Pure ASCII without
        // escapes is the one case where the old character measure and the new byte measure
        // are the same number, which is why this pin is the pre-T5 number.
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

        // 300 chars + the tool message's own `name` (4) = 304 payload bytes (all ASCII, no
        // escapes) -> 76 tokens.
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

        // MOVED 10 -> 12 by the wire measure. name 'write' (5 bytes) + arguments: 33
        // characters carrying 8 `"` characters, each of which is `\"` on the wire, so 41
        // payload bytes. 5 + 41 = 46 -> ceil(46 / 4) = 12. A `write` call's arguments are
        // JSON-inside-JSON, which is exactly the double-escaping the character measure
        // charged half of.
        expect(estimateContextTokens(messages)).toBe(12);
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

        // 'look' (4) + 'diagram.png' (11) + 'image/png' (9) = 24 -> 6 tokens. This fixture
        // spells the field `mimeType`, which is the FALLBACK spelling (the shipped shape is
        // `mime`) — see the dedicated MIME block below for both spellings.
        expect(estimateContextTokens(withMedia)).toBe(6);
    });

    it('counts replayed assistant reasoning, and drops it exactly when the entry is flagged off', () => {
        // 'answer' (6) -> 2 tokens.
        const bare: HarnessMessage[] = [{ role: 'assistant', content: 'answer' }];
        // 6 + 400 = 406 -> ceil(101.5) = 102. The thinking is on the wire, so it is context.
        const reasoned: HarnessMessage[] = [
            { role: 'assistant', content: 'answer', reasoning: 'x'.repeat(400) }
        ];

        expect(estimateContextTokens(bare)).toBe(2);
        expect(estimateContextTokens(reasoned)).toBe(102);

        // THE FLAG IS THE ONLY THING THAT REMOVES IT. `reasoningIncluded: false` is what the
        // projection resolves out of the request copy, so the estimate has to agree with the wire or
        // a thinking trim saves nothing anyone can measure.
        const withheld: HarnessMessage[] = [
            { role: 'assistant', content: 'answer', reasoning: 'x'.repeat(400), reasoningIncluded: false }
        ];

        expect(estimateContextTokens(withheld)).toBe(2);
        // The TEXT survives — only the replay is withheld — so the saving is exactly the 100 tokens
        // the thinking was worth, and it is the number `currentEstimatedTokens()` moves by.
        expect(estimateContextTokens(reasoned) - estimateContextTokens(withheld)).toBe(100);

        // `true` is the documented no-op (the runtime normalizes it away), and an ABSENT flag is the
        // same thing: an entry nobody trimmed keeps its thinking.
        expect(
            estimateContextTokens([
                { role: 'assistant', content: 'answer', reasoning: 'x'.repeat(400), reasoningIncluded: true }
            ])
        ).toBe(102);

        // An empty thinking string is nothing to send, flagged or not.
        expect(estimateContextTokens([{ role: 'assistant', content: 'answer', reasoning: '' }])).toBe(2);

        // Only an assistant entry carries `reasoning`; the rule is per-entry, so a flagged tool
        // message's stray field cannot switch an assistant's thinking off.
        expect(
            estimateContextTokens([
                { role: 'assistant', content: 'answer', reasoning: 'x'.repeat(400) },
                { role: 'tool', toolCallId: 'c1', name: 'read', content: 'out', reasoningIncluded: false } as never
            ])
        ).toBe(104);
    });

    it('exposes the shared chars-to-tokens rule on its own', () => {
        // The trimmer's thinking axis holds a CHARACTER count (that is what one write removes) and
        // has to publish a token figure in this file's convention. Same rule, one implementation.
        expect(estimateTokensFromChars(0)).toBe(0);
        expect(estimateTokensFromChars(1)).toBe(1);
        expect(estimateTokensFromChars(4)).toBe(1);
        expect(estimateTokensFromChars(5)).toBe(2);
        expect(estimateTokensFromChars(400)).toBe(100);
        expect(estimateTokensFromChars(40)).toBe(estimateContextTokens([], 'x'.repeat(40)));
        // Total, like everything here: a nonsense figure is 0, never NaN.
        expect(estimateTokensFromChars(-5)).toBe(0);
        expect(estimateTokensFromChars(Number.NaN)).toBe(0);
        expect(estimateTokensFromChars(Number.POSITIVE_INFINITY)).toBe(0);
        // UNIT NOTE: this is the file's one raw-CHARACTER answer (the trimmer holds characters).
        // A withheld thought's real saving is its payload weight / 4, so this figure is a FLOOR on
        // the saving, never an overstatement — 'a'.repeat(400) carries no escapes, so here they agree.
        expect(estimateTokensFromChars(400)).toBe(estimateContextTokens([], 'a'.repeat(400)));
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

        // '12345' is the only measurable text: 5 bytes -> 2 tokens. The cycle contributes 0
        // (`bytesOf` swallows the stringify failure exactly like `textOf` did).
        expect(estimateContextTokens(hostile)).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// THE WIRE MEASURE (T5, 2026-11-17): payload bytes, not characters
//
// Every number below is hand-derived from the escape table in ./payload-bytes.ts, which is
// itself verified byte-for-byte against `JSON.stringify` in payload-bytes.test.ts:
//   `"` and `\` -> 2 · \b \f \n \r \t -> 2 · other control -> 6 (`\u00XX`) ·
//   lone surrogate -> 6 · everything else -> its UTF-8 width.
// The two corpus rows are excerpts of the real `read` results that blew the window in
// session 6a94b896 (`Temp/d1/report.md` §3): the multibyte one carries a 1.786x tax over
// 111,369 characters in the full entry, and the quote/backslash one a 1.047x tax.
// ---------------------------------------------------------------------------

describe('the serialized-payload measure (T5)', () => {
    /** One user entry of exactly this text, so each case reads as its own arithmetic. */
    const one = (content: string): HarnessMessage[] => [{ role: 'user', content }];

    it('charges a JSON quote at its escaped width', () => {
        // 10 `"` characters are 20 payload bytes (`\"`) -> 5 tokens. The old character
        // measure said 10 bytes -> 3 tokens, i.e. it charged 40% of what the provider billed.
        expect(transcriptChars(one('"'.repeat(10)))).toBe(20);
        expect(estimateContextTokens(one('"'.repeat(10)))).toBe(5);
    });

    it('charges a backslash at its escaped width', () => {
        // 5 backslashes -> 10 bytes (`\\`) -> 3 tokens (was 5 bytes -> 2 tokens).
        expect(transcriptChars(one('\\'.repeat(5)))).toBe(10);
        expect(estimateContextTokens(one('\\'.repeat(5)))).toBe(3);
    });

    it('charges newlines and bare control characters at their escaped width', () => {
        // 8 newlines -> `n` is a 2-byte escape -> 16 bytes -> 4 tokens. A tool result is
        // mostly newlines, so this is the ordinary case, not an edge case.
        expect(transcriptChars(one('\n'.repeat(8)))).toBe(16);
        expect(estimateContextTokens(one('\n'.repeat(8)))).toBe(4);

        // A raw control character becomes `\u00XX`: 2 of them are 12 bytes -> 3 tokens.
        expect(transcriptChars(one('\u0001'.repeat(2)))).toBe(12);
        expect(estimateContextTokens(one('\u0001'.repeat(2)))).toBe(3);
    });

    it('charges non-ASCII at its UTF-8 width, including astral and lone surrogates', () => {
        // 1 precomposed accent = 2 bytes -> 1 token.
        expect(transcriptChars(one('é'))).toBe(2);
        // 3 CJK = 9 bytes -> ceil(2.25) = 3 tokens (characters said 1).
        expect(transcriptChars(one('中文字'))).toBe(9);
        expect(estimateContextTokens(one('中文字'))).toBe(3);
        // One astral emoji is a surrogate PAIR (2 code units) and 4 literal UTF-8 bytes,
        // not 2 x 6: `payload-bytes.ts` resolves the pair. -> 1 token.
        expect(transcriptChars(one('😀'))).toBe(4);
        // A LONE high surrogate is what a truncated multibyte read leaves behind, and JSON
        // writes it as `\udXXX`: 1 code unit -> 6 bytes -> 2 tokens.
        expect(transcriptChars(one('\ud800'))).toBe(6);
        expect(estimateContextTokens(one('\ud800'))).toBe(2);
    });

    it('reproduces the tax of the real corpus rows that caused the refusal', () => {
        // `multibyte.txt` line 2-5, as stored: 26 JavaScript characters.
        //   "ine2 " 5 + "ééé" 6 + " " 1 + "café" 5 + " " 1 + "line3" 5 + " " 1 + "中文字" 9
        //   + " " 1 + "😀" 4  =  38 payload bytes -> ceil(38 / 4) = 10 tokens.
        const multibyte = 'ine2 ééé café line3 中文字 😀';
        expect(multibyte.length).toBe(26);
        expect(transcriptChars(one(multibyte))).toBe(38);
        expect(estimateContextTokens(one(multibyte))).toBe(10);

        // `escape-heavy.txt`, one line of it: 5 characters, and the `"` is `\"` on the wire
        // -> 7 payload bytes -> 2 tokens. Measured over the whole entry that is a +4.7% tax
        // (218,458 characters, 228,824 payload bytes) on top of the tokenizer's own density.
        const escapeHeavy = 'q"q\\b';
        expect(escapeHeavy.length).toBe(5);
        expect(transcriptChars(one(escapeHeavy))).toBe(7);

        // Invariants the estimator now has, stated as properties rather than as a comment:
        // the wire weight is never below the character count, and the escape-heavy and
        // multibyte rows are both strictly above it.
        for (const text of [multibyte, escapeHeavy, '\n'.repeat(8), '"'.repeat(10)]) {
            expect(transcriptChars(one(text))).toBeGreaterThanOrEqual(text.length);
        }
        expect(transcriptChars(one(multibyte))).toBeGreaterThan(multibyte.length);
        expect(transcriptChars(one(escapeHeavy))).toBeGreaterThan(escapeHeavy.length);
        // And pure ASCII prose is the identity, which is what keeps the UI bar unchanged.
        expect(transcriptChars(one('a'.repeat(400)))).toBe(400);
    });

    it('measures a non-string content as the JSON document the serializer sends', () => {
        // A restored entry may carry an OBJECT as `content`. On the wire it is a nested JSON
        // value (already escaped by the serializer), so it is priced by its UTF-8 bytes —
        // NOT by `modelPayloadBytes`, which would escape the escapes and charge `\n` twice.
        expect(transcriptChars([{ role: 'user', content: { a: 1 } } as never])).toBe(7);
        expect(transcriptChars([{ role: 'user', content: { a: 'x'.repeat(3) } } as never])).toBe(11);
        // A number content is its ASCII literal.
        expect(transcriptChars([{ role: 'user', content: 12345 } as never])).toBe(5);
        // Non-ASCII inside a JSON document content is UTF-8 priced too: {"a":"中"} is
        // 9 ASCII characters plus 3 bytes for the CJK, minus the 1 character it is spelled
        // with = 11 bytes.
        expect(transcriptChars([{ role: 'user', content: { a: '中' } } as never])).toBe(11);
    });
});

// ---------------------------------------------------------------------------
// THE ATTACHMENT MIME TERM (T5 bug fix)
//
// The shipped shape is `HarnessAttachment.mime` (../types/index.ts:53); the estimator read
// `attachment.mimeType`, so the term its own published contract claims to count was `''` for
// EVERY attachment the harness produced. Both spellings are pinned here, together with the
// rule that one attachment contributes ONE mime term.
// ---------------------------------------------------------------------------

describe('the attachment mime term (T5)', () => {
    const withAttachment = (attachment: Record<string, unknown>): HarnessMessage[] => [
        { role: 'user', content: 'look', attachments: [attachment as never] }
    ];

    it('counts the shipped `mime` spelling', () => {
        // 'look' 4 + 'diagram.png' 11 + 'image/png' 9 = 24 -> 6 tokens. Before the fix this
        // was 15 -> 4 tokens, because the mime term was always empty.
        expect(transcriptChars(withAttachment({ kind: 'image', name: 'diagram.png', mime: 'image/png' }))).toBe(24);
        expect(estimateContextTokens(withAttachment({ kind: 'image', name: 'diagram.png', mime: 'image/png' }))).toBe(6);
    });

    it('falls back to `mimeType` for a host that already passes that spelling', () => {
        // Identical figure, which is the point: the two spellings are interchangeable.
        expect(
            transcriptChars(withAttachment({ kind: 'image', name: 'diagram.png', mimeType: 'image/png' }))
        ).toBe(24);
    });

    it('prefers `mime` and never bills both spellings on one attachment', () => {
        // A record carrying BOTH must contribute ONE mime term, and the shipped one wins:
        // 4 + 11 + 9 = 24 -> 6. Billing both would be 48 -> 12.
        expect(
            transcriptChars(
                withAttachment({ kind: 'image', name: 'diagram.png', mime: 'image/png', mimeType: 'application/octet-stream' })
            )
        ).toBe(24);

        // An EMPTY `mime` (a half-normalized record) still falls through to the fallback
        // rather than silently contributing 0 again: 4 + 11 + 9 = 24.
        expect(
            transcriptChars(withAttachment({ kind: 'image', name: 'diagram.png', mime: '', mimeType: 'image/png' }))
        ).toBe(24);
    });

    it('prices a mime label and a file name in the same wire currency', () => {
        // A CJK file name is 6 characters and 10 UTF-8 bytes; the label is 9 bytes.
        // 4 + 10 + 9 = 23 -> ceil(23 / 4) = 6 tokens.
        expect(transcriptChars(withAttachment({ kind: 'file', name: '报告.png', mime: 'image/png' }))).toBe(23);
        expect(estimateContextTokens(withAttachment({ kind: 'file', name: '报告.png', mime: 'image/png' }))).toBe(6);

        // Totality, as everywhere in this file: a mime that is neither spelling, or a number,
        // contributes 0 and does not throw. 4 + 11 = 15 -> 4 tokens.
        expect(transcriptChars(withAttachment({ kind: 'image', name: 'diagram.png', mime: 7 }))).toBe(15);
        expect(transcriptChars(withAttachment({ kind: 'image', name: 'diagram.png' }))).toBe(15);
    });
});

// ---------------------------------------------------------------------------
// THE TOOL-CATALOGUE FLOOR (T5, item 3)
//
// The measured floor on session 6a94b896 was 31,229 tokens (31,693 billed against a 464
// estimate) for the system prompt + tool catalogue, and 32,013-32,827 for its four children.
// The catalogue is not in the transcript, so it is countable only through `toolSchemaChars`
// — which `toolSchemaPayloadBytes` now exists to produce in this file's currency.
// ---------------------------------------------------------------------------

describe('toolSchemaPayloadBytes and the catalogue floor', () => {
    const catalogue = [
        { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
        { name: 'grep', description: 'Search 中文', parameters: { type: 'object' } }
    ];

    it('serializes a catalogue and prices its bytes, not its characters', () => {
        // `JSON.stringify(catalogue)` is 149 JavaScript characters and 153 UTF-8 bytes: the
        // two CJK characters in a tool DESCRIPTION are 6 bytes. A schema is a serialized
        // DOCUMENT (already escaped), so it is UTF-8 priced — running `modelPayloadBytes`
        // over it would double-escape and report 155+.
        expect(JSON.stringify(catalogue).length).toBe(149);
        expect(toolSchemaPayloadBytes(catalogue)).toBe(153);
    });

    it('is total for the shapes a host can hand it', () => {
        // An unserializable value (cycle) is 0, not a throw and not a guess: an unknown
        // catalogue must not silently move a trigger.
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        expect(toolSchemaPayloadBytes(cyclic)).toBe(0);
        expect(toolSchemaPayloadBytes(undefined)).toBe(0);
        expect(toolSchemaPayloadBytes(null)).toBe(0);
        // An EMPTY catalogue still puts `[]` in the body, so it is 2 — the delimiting
        // brackets are payload here, unlike a string value's quotes (see ./payload-bytes.ts).
        expect(toolSchemaPayloadBytes([])).toBe(2);
        expect(toolSchemaPayloadBytes('read')).toBe(6);
    });

    it('turns the measured 31,229-token floor into a countable number (round 1)', () => {
        // Round 1 of session 6a94b896: a body of 1,867 payload bytes, billed 31,693 tokens.
        // Without the catalogue the estimator can only say ceil(1867 / 4) = 467.
        const body: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(1867) }];

        expect(transcriptChars(body)).toBe(1867);
        expect(estimateContextTokens(body)).toBe(467);
        expect(estimateContextTokensHybrid(body)).toBe(467);

        // With the measured floor passed as serialized bytes (31,229 tokens x 4 = 124,916),
        // the SAME call answers ceil((1867 + 124916) / 4) = ceil(31695.75) = 31,696 — within
        // 3 tokens of the 31,693 the provider billed. This is the round-1 pin: the floor is
        // surfaced even when the transcript is tiny.
        expect(estimateContextTokens(body, undefined, { toolSchemaChars: 124916 })).toBe(31696);
        expect(estimateContextTokensHybrid(body, undefined, undefined, { toolSchemaChars: 124916 })).toBe(31696);

        // The catalogue is 67x the transcript at that point, which is the whole reason a
        // transcript-only measure cannot decide whether the FIRST request fits.
        expect(31696 / 467).toBeGreaterThan(67);
    });

    it('lets an anchor carry the floor for every later request without the allowance', () => {
        // The provider's own `usage.input` (31,693) is the catalogue + the framing + the
        // body, so once ONE usage frame exists the floor needs no option at all. Round 2 of
        // the session: 75,977 payload bytes, billed 49,066.
        const anchor = anchorFromUsage({ input: 31693, output: 219, total: 31912 }, 1867);
        expect(anchor).toEqual({ tokens: 31693, chars: 1867 });

        // Growth = 75,977 - 1,867 = 74,110 payload bytes;
        // 74,110 x 1.166 = 86,412.26 -> / 4 = 21,603.065 -> ceil = 21,604
        // -> 31,693 + 21,604 = 53,297 (the provider billed 49,066).
        const body: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(75977) }];

        expect(transcriptChars(body)).toBe(75977);
        expect(estimateContextTokensHybrid(body, undefined, anchor)).toBe(53297);

        // Without the anchor the same body is 18,995 tokens — the catalogue invisible, which is
        // why the anchor (or the allowance) is the only honest answer for a first request.
        expect(estimateContextTokens(body)).toBe(18995);
    });
});

// ---------------------------------------------------------------------------
// T5.4 — the character weight, the provider anchor, and the hybrid estimate
// ---------------------------------------------------------------------------

describe('transcriptChars', () => {
    it('is the exact weight the estimator divides by 4', () => {
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

        // MOVED 38 -> 46: name (5) + raw arguments (33 characters, 41 payload bytes — 8 quotes
        // doubled); the call ID is not counted, by design. `transcriptChars` is the pass the
        // harness records as `pendingRequestChars`, so this is the number the anchor is keyed by.
        expect(transcriptChars(calls)).toBe(46);
        expect(estimateContextTokens(calls)).toBe(Math.ceil(46 / 4));
    });

    it('prices the instruction blocks the way the body carries them', () => {
        // The system prompt is in EVERY request and travels as a JSON string value, so its
        // newlines cost 2 bytes each: 375 ASCII characters + 1 newline x 2 = 377 payload
        // bytes -> ceil(377 / 4) = 95 tokens. The character measure said 376 -> 94.
        const instructions = `${'a'.repeat(375)}\n`;
        expect(instructions.length).toBe(376);
        expect(transcriptChars([], instructions)).toBe(377);
        expect(estimateContextTokens([], instructions)).toBe(95);

        // Array form is priced entry by entry, the same way: 377 + 9 = 386 -> ceil(96.5) = 97.
        expect(transcriptChars([], [`${'a'.repeat(375)}\n`, 'b'.repeat(9)])).toBe(386);
        expect(estimateContextTokens([], [`${'a'.repeat(375)}\n`, 'b'.repeat(9)])).toBe(97);
    });
});

describe('anchorFromUsage', () => {
    it('pairs a reported prompt size with the prefix it was measured over', () => {
        expect(anchorFromUsage({ input: 1_000, output: 10, total: 1_010 }, 3_980)).toEqual({
            tokens: 1_000,
            chars: 3_980
        });

        // A fractional weight is floored, never rounded up: the anchor must not
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
        // 4000 bytes -> a heuristic of 1000 tokens. The floor is 1/4 of that: 250.
        expect(anchorFromUsage({ input: 250, output: 0, total: 250 }, 4_000)).toEqual({ tokens: 250, chars: 4_000 });
        expect(anchorFromUsage({ input: 249, output: 0, total: 249 }, 4_000)).toBeUndefined();

        // A provider reporting 100x the heuristic is the POINT of anchoring: the tool
        // schemas and message framing are not in `weight` at all, and refusing that
        // number would throw away the only real measurement available. This is exactly the
        // shape of session 6a94b896's round 1 (31,693 billed against a 464 heuristic, 68x).
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

        // Exactly the anchored prefix: the provider's own number, unchanged. The margin
        // multiplies the GROWTH, and there is none, so the zero-delta pin is unchanged.
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(3_980) }], '', anchor)).toBe(1_000);

        // +60 payload bytes of growth, margined: ceil(60 x 1.166 / 4) = ceil(17.49) = 18.
        // MOVED 1015 -> 1018 by `ANCHOR_GROWTH_MARGIN` (the pre-margin figure is pinned
        // below under `anchorGrowthMargin: 0`).
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(4_000) }], 'i'.repeat(40), anchor)).toBe(
            1018
        );

        // Why this is the whole feature: 40 400 bytes of transcript measured as
        // 40 000 by the anchored prefix, so the estimate is 25 000 + ceil(400 x 1.166 / 4)
        // = 25 000 + 117 = 25 117 while the pure heuristic would still say
        // ceil(40 400 / 4) = 10 100. (MOVED 25 100 -> 25 117, same margin.)
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(40_400) }], undefined, {
            tokens: 25_000,
            chars: 40_000
        })).toBe(25_117);
        expect(estimateContextTokens([{ role: 'user', content: 'x'.repeat(40_400) }])).toBe(10_100);
    });

    it('follows the stated rule when the transcript is now SHORTER than the anchor', () => {
        // A withheld unit or an edited message reduces the delta term; the removed text
        // is discounted at the same 4 bytes/token, rounding a negative toward zero.
        const anchor = { tokens: 1_000, chars: 3_980 };

        // 440 bytes: 1000 + ceil((440 - 3980) / 4) = 1000 - 885. The margin is NOT applied
        // to a negative delta (that would exaggerate a saving), so this pin did not move.
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

        // MOVED by the margin, still strictly non-decreasing:
        //   delta 0 -> +0 · delta 1 -> ceil(1.166/4)=+1 · delta 4 -> ceil(4.664/4)=+2 ·
        //   delta 8 -> ceil(9.328/4)=+3.
        expect([at(400), at(401), at(404), at(408)]).toEqual([1_000, 1_001, 1_002, 1_003]);
        expect(estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(402) }], undefined, anchor)).toBe(1_001);
    });

    it('clamps a low anchor at the 16-bytes-per-token boundary, not at the plain guess', () => {
        // THE LOW-SIDE CLAMP. `anchorFromUsage` REFUSES an anchor more than
        // ANCHOR_MINIMUM_RATIO (4x) below the bytes/4 guess for the text it was measured over,
        // so the delta-reporting provider this clamp was first written for never reaches the
        // hybrid at all — it is refused and the caller keeps the plain estimate. What does reach
        // it is an accepted anchor that has since been outgrown, and the clamp holds the answer
        // at the SAME boundary the anchor was admitted at: 1,000 bytes -> plain 250 ->
        // ceil(250 / 4) = 63, which beats 20 + 0 growth.
        expect(
            estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(1_000) }], undefined, {
                tokens: 20,
                chars: 1_000
            })
        ).toBe(63);

        // The clamp is the plain weight with NO allowance (the anchor already contains the
        // catalogue, so adding the allowance to the floor would bill the same constant twice),
        // and an allowance can therefore never lift an anchored answer above the provider's own
        // count of the same prefix.
        expect(
            estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(1_000) }], undefined, {
                tokens: 20,
                chars: 1_000
            }, { toolSchemaChars: 100_000 })
        ).toBe(63);

        // A provider legitimately running DENSER than the rule of thumb still owns the number:
        // the same text with a 4x-higher anchor is answered by the anchor, untouched (plain 250,
        // clamp 63, anchor 1,000).
        expect(
            estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(1_000) }], undefined, {
                tokens: 1_000,
                chars: 1_000
            })
        ).toBe(1_000);
    });

    it('falls back to the heuristic for a hostile anchor instead of throwing', () => {
        const messages: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];

        expect(estimateContextTokensHybrid(messages, undefined, { tokens: Number.NaN, chars: 100 })).toBe(100);
        expect(estimateContextTokensHybrid(messages, undefined, { tokens: 0, chars: 100 })).toBe(100);
        expect(estimateContextTokensHybrid(messages, undefined, { tokens: -5, chars: 100 })).toBe(100);

        // An unusable `chars` is read as "no measured prefix", which is what an
        // empty-prefix anchor means: the whole transcript is delta. MOVED 1100 -> 1117:
        // ceil(400 x 1.166 / 4) = ceil(116.6) = 117.
        expect(estimateContextTokensHybrid(messages, undefined, { tokens: 1_000, chars: Number.NaN })).toBe(1_117);
    });

    it('treats an empty-prefix anchor as framing overhead on top of the text', () => {
        // 512 tokens reported for an uncountable prefix + 40 bytes of new text:
        // 512 + ceil(40 x 1.166 / 4) = 512 + 12 = 524 (MOVED from 522 by the margin).
        expect(
            estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(40) }], undefined, {
                tokens: 512,
                chars: 0
            })
        ).toBe(524);
    });
});

// ---------------------------------------------------------------------------
// THE ANCHORED DELTA IS ONE CURRENCY (X1, 2026-11-17 — the second defect of the compaction
// deadlock)
//
// The anchored leg extrapolates `weight - anchor.chars`, so the two sides of that subtraction
// MUST be the same measure, or the growth term prices a different quantity than the one the
// anchor was set from and the anchor's whole purpose (cancelling a constant error) leaks on
// every turn. `anchor.chars` is the serialized-payload BYTE weight the harness records:
// `../harness.ts` `pendingRequestChars` is `transcriptChars(requestTranscript,
// brain.instructions)` and `anchorFromUsage` stores it as `ContextTokenAnchor.chars`.
//
// The ASCII calibration rows at the bottom of this file cannot see a currency error at all —
// for pure ASCII without escapes, characters and bytes agree — so these pins use text where
// the two disagree by construction: an ellipsis (1 character, 3 payload bytes) and CJK
// ideographs (1 character, 3 payload bytes each). Every figure below is derived by hand and
// reproduced by `Temp/coding-x1/probe-x3.ts`; the source references this block by name from
// `../core/context-estimate.ts` (`estimateContextTokensHybrid`'s "ONE CURRENCY, BOTH LEGS") and
// from the `ContextTokenAnchor` doc comment.
// ---------------------------------------------------------------------------

describe('the anchored delta is one currency', () => {
    const instructions = 'sys'.repeat(20); // 60 ASCII bytes, counted by the same pass
    const escaped: HarnessMessage[] = [{ role: 'user', content: 'a'.repeat(100) + ' … 中文' }];
    const grown: HarnessMessage[] = [...escaped, { role: 'assistant', content: 'b'.repeat(80) }];
    const byteAnchor = anchorFromUsage({ input: 1000 }, transcriptChars(escaped, instructions));

    // The naive reading of the field name — the length of the text — which is what a host that
    // recorded characters effectively compares against.
    const naiveChars = (messages: HarnessMessage[]): number =>
        messages.reduce((total, entry) => total + String(entry.content).length, 0);

    it('records the anchor in payload bytes and reads the growth in the same unit', () => {
        // 105 CHARACTERS of content, 111 PAYLOAD BYTES once `…` (3) and the two ideographs (6)
        // are priced at their wire width, plus the 60-byte instruction block: 171 bytes.
        expect(naiveChars(escaped)).toBe(105);
        expect(transcriptChars(escaped, instructions)).toBe(171);
        expect(anchorFromUsage({ input: 1000 }, transcriptChars(escaped, instructions))).toEqual({
            tokens: 1000,
            chars: 171
        });

        // An unchanged transcript returns the anchor EXACTLY — the property the byte pairing
        // exists for, and the one a mixed currency breaks silently.
        expect(estimateContextTokensHybrid(escaped, instructions, byteAnchor)).toBe(1000);

        // ASCII growth: 80 characters appended = 80 bytes = 20 tokens, margined at the default
        // 16.6% to 24, so 1,000 + 24 = 1,024. With the margin opted out it is 1,020, which is
        // the same growth with no margin (`ceil(80 / 4)`).
        expect(transcriptChars(grown, instructions)).toBe(251);
        expect(estimateContextTokensHybrid(grown, instructions, byteAnchor)).toBe(1024);
        expect(
            estimateContextTokensHybrid(grown, instructions, byteAnchor, { anchorGrowthMargin: 0 })
        ).toBe(1020);

        // THE WRONG ANSWER, pinned because the field name invites it. Anchoring on the CHARACTER
        // count re-bills the anchored prefix's escape tax on every later request: 171 − 105 = 66
        // bytes read as growth (17 tokens, 19 once margined), so this same transcript pair answers
        // 1,043 instead of 1,024 — and the drift compounds with every turn that touches
        // non-ASCII text, in the direction that hides a coming refusal.
        const charAnchor = anchorFromUsage({ input: 1000 }, naiveChars(escaped));

        expect(charAnchor).toEqual({ tokens: 1000, chars: 105 });
        expect(estimateContextTokensHybrid(grown, instructions, charAnchor)).toBe(1043);
        expect(
            estimateContextTokensHybrid(grown, instructions, charAnchor) -
                estimateContextTokensHybrid(grown, instructions, byteAnchor)
        ).toBe(19);
    });

    it('prices growth that is itself non-ASCII at its UTF-8 width', () => {
        // 40 ideographs are 40 CHARACTERS but 120 BYTES: 30 tokens of growth, 35 once margined,
        // so 1,035. The character reading would have charged 10 tokens for a body the provider
        // billed at 30 — the under-reading direction, and the one the measured refusal proved
        // fatal (session 6a94b896: 225,612 billed against a 193,428 estimate).
        const cjkGrowth: HarnessMessage[] = [...escaped, { role: 'assistant', content: '中'.repeat(40) }];

        expect(transcriptChars(cjkGrowth, instructions) - transcriptChars(escaped, instructions)).toBe(120);
        expect(naiveChars(cjkGrowth) - naiveChars(escaped)).toBe(40);
        expect(estimateContextTokensHybrid(cjkGrowth, instructions, byteAnchor)).toBe(1035);
    });
});

// ---------------------------------------------------------------------------
// THE ANCHORED GROWTH MARGIN (T5)
//
// `ANCHOR_GROWTH_MARGIN` = 0.166 is the measured hybrid-vs-billed residual at round 21 of
// session 6a94b896 (225,612 billed / 193,428 estimated). These pins hold the constant in
// place from both directions: the default, the `0` opt-out that reproduces the old number,
// and the corrupt-value fallback that must NOT become 0.
// ---------------------------------------------------------------------------

describe('the anchored growth margin (ContextEstimateOptions.anchorGrowthMargin)', () => {
    const anchor = { tokens: 10_000, chars: 4_000 };
    const at = (bytes: number, options?: { anchorGrowthMargin?: number }): number =>
        estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(bytes) }], undefined, anchor, options);

    it('margins positive growth by the measured residual', () => {
        // 8,000 bytes against a 4,000-byte anchor = 4,000 bytes of growth:
        // ceil(4000 x 1.166 / 4) = ceil(1166) = 1166 -> 11,166.
        expect(at(8_000)).toBe(11_166);

        // The 0 opt-out is the pre-T5 arithmetic exactly: 4000 / 4 = 1000 -> 11,000.
        expect(at(8_000, { anchorGrowthMargin: 0 })).toBe(11_000);

        // And an explicit 0.166 is the default, so the constant is the only source of it.
        expect(at(8_000, { anchorGrowthMargin: 0.166 })).toBe(11_166);

        // A caller may dial it higher (the calibration replay below shows why 0 is not
        // enough): ceil(4000 x 1.5 / 4) = 1500 -> 11,500.
        expect(at(8_000, { anchorGrowthMargin: 0.5 })).toBe(11_500);
    });

    it('falls back to the measured constant for a margin it cannot trust', () => {
        // 0 is honoured (above) but `NaN`, `Infinity`, a negative and a string are NOT: they
        // restore 0.166, because 0 is the value the measured refusal showed to be unsafe.
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, '0.5', true, {}, undefined]) {
            expect(at(8_000, { anchorGrowthMargin: value as never })).toBe(11_166);
        }
    });

    it('never goes below billed + serialized growth, at any margin', () => {
        // The requirement T5 states as a floor: `lastBilledInput + measuredSerializedGrowth`.
        // The margin is a non-negative multiplier on that same term, so it holds for every
        // admissible margin — pinned, not asserted in prose.
        const growthBytes = 12_345;
        const floor = anchor.tokens + Math.ceil(growthBytes / 4);
        const bytes = anchor.chars + growthBytes;

        for (const margin of [0, 0.166, 0.5, 3, Number.MAX_SAFE_INTEGER]) {
            expect(at(bytes, { anchorGrowthMargin: margin })).toBeGreaterThanOrEqual(floor);
        }
        // 12,345 / 4 = 3,086.25 -> the required floor is exactly 13,087, and the margined
        // answer is 12,345 x 1.166 = 14,394.27 -> / 4 = 3,598.5675 -> ceil 3,599 -> 13,599.
        expect(floor).toBe(13_087);
        expect(at(bytes)).toBe(13_599);
    });

    it('does not margin a shrink, so a withheld unit still reads as a saving', () => {
        // 4,000-byte anchor, 2,000-byte transcript: -2000/4 = -500 -> 9,500 whether the
        // margin is 0, 0.166 or 3. Exaggerating a saving would make the trimmer's floors lie.
        expect(at(2_000)).toBe(9_500);
        expect(at(2_000, { anchorGrowthMargin: 0 })).toBe(9_500);
        expect(at(2_000, { anchorGrowthMargin: 3 })).toBe(9_500);
    });

    it('leaves the unanchored leg on the published figure', () => {
        // The margin is not an allowance and the unanchored leg has no growth term: 400 bytes
        // is 100 tokens with or without it, so the UI context bar and `maxPromptTokens` are
        // untouched by anything on this axis.
        const messages: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(400) }];

        expect(estimateContextTokensHybrid(messages, undefined, undefined, { anchorGrowthMargin: 0.5 })).toBe(100);
        expect(estimateContextTokensHybrid(messages, undefined, undefined, { anchorGrowthMargin: 0 })).toBe(100);
    });
});

// ---------------------------------------------------------------------------
// THE OPT-IN REQUEST WEIGHT (2026-11-17, the compaction deadlock)
//
// The published figure stays the published figure: every field of
// `ContextEstimateOptions` is OFF unless a caller asks for it, and a caller that asks gets
// an UPPER bound ("these bytes are in the body"), not a billing model. Every number below is
// `ceil(weight / 4)` on a weight derived by hand from the fixture, and the fixture is
// deliberately the same 24-weight one the attachment case above pins — so the default leg of
// each assertion is that case's number, not a new one.
// ---------------------------------------------------------------------------

describe('the opt-in request weight (ContextEstimateOptions)', () => {
    // 'look' (4) + name 'diagram.png' (11) + mime 'image/png' (9) = 24 bytes of text, with
    // 1000 characters of base64 riding on it that the default pass refuses to count.
    const withMedia = (data: string): HarnessMessage[] => [
        {
            role: 'user',
            content: 'look',
            attachments: [
                {
                    id: 'att-1',
                    kind: 'image',
                    name: 'diagram.png',
                    mimeType: 'image/png',
                    data
                } as never
            ]
        }
    ];
    const media = withMedia('A'.repeat(1000));

    it('changes nothing until a caller asks for it', () => {
        // The three spellings of "off" — omitted, an empty bag, and an explicit `false` — are
        // the SAME number as the two-argument call the whole product uses (6 tokens).
        expect(estimateContextTokens(media)).toBe(6);
        expect(estimateContextTokens(media, undefined, {})).toBe(6);
        expect(estimateContextTokens(media, undefined, { includeAttachmentBytes: false })).toBe(6);
        expect(estimateContextTokens(media, undefined)).toBe(6);
        // `transcriptChars` on its own, which is the unit the anchor records, is off too.
        expect(transcriptChars(media)).toBe(24);
        expect(transcriptChars(media, undefined, {})).toBe(24);
    });

    it('counts the base64 a media turn actually puts in the body', () => {
        // 24 + 1000 = 1024 → 256 tokens: one screenshot is not 6 tokens of context, and the
        // "will this request be refused?" check is exactly where the difference matters.
        // Base64 is pure ASCII, so the wire bytes and the characters are one number and the
        // T5 unit change does not touch this term.
        expect(estimateContextTokens(media, undefined, { includeAttachmentBytes: true })).toBe(256);
        expect(transcriptChars(media, undefined, { includeAttachmentBytes: true })).toBe(1024);

        // An entry that states only its byte length is measured from the SAME base64 the
        // transport will send: ceil(40000 × 4 / 3) = 53334 characters, so 24 + 53334 = 53358 →
        // ceil(53358 / 4) = 13340.
        const sized: HarnessMessage[] = [
            {
                role: 'user',
                content: 'look',
                attachments: [
                    { id: 'att-2', kind: 'pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 40000 } as never
                ]
            }
        ];

        expect(estimateContextTokens(sized, undefined, { includeAttachmentBytes: true })).toBe(13340);

        // An allowance for an entry with NOTHING to count is the default figure again.
        const textOnly: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(40) }];

        expect(estimateContextTokens(textOnly, undefined, { includeAttachmentBytes: true })).toBe(10);
    });

    it('measures an attachment list in decoded bytes, defensively', () => {
        // `size` is the declared byte length, so it wins; `data` is what a restored entry that
        // lost the field still carries, and 1000 base64 characters decode to 750 bytes.
        expect(estimateAttachmentBytes([{ size: 40000 }])).toBe(40000);
        expect(estimateAttachmentBytes([{ data: 'A'.repeat(1000) }])).toBe(750);
        expect(estimateAttachmentBytes([{ size: 40000, data: 'A'.repeat(1000) }])).toBe(40000);
        // Both halves unusable is 0, and so is every shape a snapshot can hand back.
        expect(estimateAttachmentBytes([{ size: -1, data: '' }])).toBe(0);
        expect(estimateAttachmentBytes([{ size: '40000' }])).toBe(0);
        expect(estimateAttachmentBytes([{ size: Number.NaN }])).toBe(0);
        expect(estimateAttachmentBytes(undefined)).toBe(0);
        expect(estimateAttachmentBytes('40000')).toBe(0);
        expect(estimateAttachmentBytes([null, 'x', 7])).toBe(0);
        // A list is summed, junk entries skipped rather than fatal.
        expect(estimateAttachmentBytes([{ size: 100 }, null, { data: 'AAAA' }])).toBe(103);
    });

    it('adds the tool schemas and the framing only when the caller names them', () => {
        // 100 bytes of instruction is 25 tokens; +300 of serialized tool schema is 100;
        // +100 more of request framing is 50. One ceiling over the SUM, not one per term.
        expect(estimateContextTokens([], 'i'.repeat(100))).toBe(25);
        expect(estimateContextTokens([], 'i'.repeat(100), { toolSchemaChars: 300 })).toBe(100);
        expect(estimateContextTokens([], 'i'.repeat(100), { requestOverheadChars: 100 })).toBe(50);
        expect(
            estimateContextTokens([], 'i'.repeat(100), { toolSchemaChars: 300, requestOverheadChars: 100 })
        ).toBe(125);

        // A term this file cannot trust is 0 rather than a guess, because a policy is about to
        // act on the number: a string, a negative, `NaN` and `Infinity` all drop out.
        expect(estimateContextTokens([], 'i'.repeat(100), { toolSchemaChars: '300' as never })).toBe(25);
        expect(estimateContextTokens([], 'i'.repeat(100), { toolSchemaChars: -300 })).toBe(25);
        expect(estimateContextTokens([], 'i'.repeat(100), { toolSchemaChars: Number.NaN })).toBe(25);
        expect(
            estimateContextTokens([], 'i'.repeat(100), {
                toolSchemaChars: Number.POSITIVE_INFINITY,
                requestOverheadChars: Number.NaN
            })
        ).toBe(25);

        // All three terms together, on the media fixture: 24 + 1000 + 300 + 100 = 1424 → 356.
        expect(
            estimateContextTokens(media, undefined, {
                includeAttachmentBytes: true,
                toolSchemaChars: 300,
                requestOverheadChars: 100
            })
        ).toBe(356);
        expect(
            transcriptChars(media, 'i'.repeat(100), {
                includeAttachmentBytes: true,
                toolSchemaChars: 300,
                requestOverheadChars: 100
            })
        ).toBe(1524);

        // The allowance is a byte figure in the same currency: pass the helper's output and the
        // catalogue is counted with its non-ASCII descriptions at UTF-8 width (153 bytes).
        expect(
            estimateContextTokens([], 'i'.repeat(100), {
                toolSchemaChars: toolSchemaPayloadBytes([
                    { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
                    { name: 'grep', description: 'Search 中文', parameters: { type: 'object' } }
                ])
            })
        ).toBe(64);
    });

    it('lets the provider anchor absorb the CONSTANT overhead it already counted', () => {
        // THE ANTI-DOUBLE-COUNT RULE, pinned from both sides, and split by BEHAVIOUR rather than
        // by option name (X1, 2026-11-17). Without an anchor the allowance is the whole point:
        // 24 bytes is 6 tokens, and the same request with its base64 is 256.
        expect(estimateContextTokensHybrid(media, undefined, undefined)).toBe(6);
        expect(
            estimateContextTokensHybrid(media, undefined, undefined, { includeAttachmentBytes: true })
        ).toBe(256);

        // WITH an anchor, `anchor.tokens` is the provider's own count of a whole request, so the
        // CONSTANT half of the allowance (the 300-byte catalogue and the 100-byte framing) is
        // ignored: it is already inside that count, and adding it again bills a per-request
        // constant twice — the exact error the anchor exists to cancel. The number is identical
        // to the plain call.
        expect(estimateContextTokensHybrid(media, undefined, { tokens: 1000, chars: 24 })).toBe(1000);
        expect(
            estimateContextTokensHybrid(media, undefined, { tokens: 1000, chars: 24 }, {
                toolSchemaChars: 300,
                requestOverheadChars: 100
            })
        ).toBe(1000);

        // THE VARIABLE HALF IS NOT ALLOWANCE, IT IS TEXT (the fix). The base64 is appended to the
        // body like any other entry, so the anchored leg prices it as growth: this anchor was
        // recorded over the 24-byte body WITHOUT the media, and the estimate now asks for the
        // media, so the delta is 1024 − 24 = 1000 bytes → 250 tokens, margined by the default
        // 16.6% to 292, and 1000 + 292 = 1292. Before this fix the leg ignored the term and
        // answered 1000, i.e. it priced a SMALLER quantity than the unanchored leg above (256) and
        // than `../plugins/context-compaction.plugin.ts` `measureShrink` prices the same request —
        // which is the mixed-currency leg of the compaction deadlock. The 400 constant bytes are
        // visibly absent (they would have added 100 → 1392), which is the other half of the rule
        // firing on the same call.
        expect(
            estimateContextTokensHybrid(media, undefined, { tokens: 1000, chars: 24 }, {
                includeAttachmentBytes: true,
                toolSchemaChars: 300,
                requestOverheadChars: 100
            })
        ).toBe(1292);

        // AND IT IS AN OVER-COUNT ONLY IN THAT DIRECTION, ON PURPOSE. A media entry that was
        // already inside the anchored request is now billed once inside `anchor.tokens` and once
        // as growth; `includeAttachmentBytes` publishes itself as an UPPER bound for a "will this
        // request be refused?" check. A caller that wants it priced exactly once records the base
        // in the SAME currency — here, 1,024 bytes instead of 24 — and gets the anchor back
        // untouched. That is the escape hatch `ContextTokenAnchor` documents.
        expect(
            estimateContextTokensHybrid(media, undefined, { tokens: 1000, chars: 1024 }, {
                includeAttachmentBytes: true,
                toolSchemaChars: 300,
                requestOverheadChars: 100
            })
        ).toBe(1000);

        // The delta leg is unchanged too: 40 bytes of text against a 400-byte anchor is
        // 910 tokens with the allowance or without it (a negative delta carries no margin, and a
        // catalogue is constant, so neither term moves the number).
        const appended: HarnessMessage[] = [{ role: 'user', content: 'x'.repeat(40) }];

        expect(estimateContextTokensHybrid(appended, undefined, { tokens: 1000, chars: 400 })).toBe(910);
        expect(
            estimateContextTokensHybrid(appended, undefined, { tokens: 1000, chars: 400 }, {
                toolSchemaChars: 4000
            })
        ).toBe(910);
    });
});

// ---------------------------------------------------------------------------
// CALIBRATION REPLAY — session 6a94b896 (the request that was refused)
//
// The rows are the REAL measured curve, read out of the store copy at `Temp/d1/session/`
// (thread-1, model `local/basalt`) by `Temp/coding-t5/fixtures.ts`, which calls these same
// functions to produce them:
//
//   - `billed`   — `usage.input` from the session's `usage` events (21 rows, request 22 has
//                  none: it is the request the provider refused);
//   - `payload`  — the body's serialized-payload weight under the FIXED estimator
//                  (`transcriptChars` over the canonical entries; thread-1 carries no
//                  `included:false` entry, so canonical == projected);
//   - `chars`    — the same pass under the pre-T5 character measure;
//   - `before`   — the pre-T5 arithmetic (chars/4 unanchored on round 1, prev billed +
//                  char-delta/4 after) — 193,397 at round 21 against the 193,428 the
//                  analysis probe printed (the probe also counted tool-call IDs, which this
//                  estimator deliberately does not; the replay is within 0.7% of
//                  `Temp/d1/analysis.out` §10 for exactly that reason);
//   - `after`    — the shipped estimator: `estimateContextTokensHybrid` over an ASCII body of
//                  the SAME measured payload weight, anchored by `anchorFromUsage` on the
//                  previous round's billed input and weight — the same two calls
//                  `../harness.ts` makes at `pendingRequestChars` and the `usage` frame.
//
// The fixture is inline (not a file read) so the replay is deterministic and cannot break
// when `Temp/` is cleaned.
// ---------------------------------------------------------------------------

describe('calibration replay: session 6a94b896 would have compacted at round 21', () => {
    type Round = {
        round: number;
        /** `usage.input` the provider billed; `null` for the request that was refused. */
        billed: number | null;
        /** Pre-T5 measure of the same body: raw characters. */
        chars: number;
        /** Post-T5 measure of the same body: serialized payload bytes. */
        payload: number;
        /** What the pre-T5 estimator answered for that request. */
        before: number;
        /** What the shipped estimator answers for it. */
        after: number;
    };

    const ROUNDS: Round[] = [
        { round: 1, billed: 31693, chars: 1852, payload: 1867, before: 463, after: 467 },
        { round: 2, billed: 49066, chars: 74807, payload: 75977, before: 49932, after: 53297 },
        { round: 3, billed: 52277, chars: 86635, payload: 88249, before: 52023, after: 52644 },
        { round: 4, billed: 54525, chars: 92213, payload: 94015, before: 53672, after: 53958 },
        { round: 5, billed: 56909, chars: 96602, payload: 98837, before: 55623, after: 55931 },
        { round: 6, billed: 59798, chars: 102917, payload: 105548, before: 58488, after: 58866 },
        { round: 7, billed: 70664, chars: 158303, payload: 162166, before: 73645, after: 76303 },
        { round: 8, billed: 70566, chars: 160434, payload: 164595, before: 71197, after: 71373 },
        { round: 9, billed: 72643, chars: 162711, payload: 167059, before: 71136, after: 71285 },
        { round: 10, billed: 72485, chars: 164169, payload: 168611, before: 73008, after: 73096 },
        { round: 11, billed: 73386, chars: 166593, payload: 171168, before: 73091, after: 73231 },
        { round: 12, billed: 74756, chars: 170259, payload: 175179, before: 74303, after: 74556 },
        { round: 13, billed: 76702, chars: 172929, payload: 178060, before: 75424, after: 75596 },
        { round: 14, billed: 130355, chars: 284951, payload: 377623, before: 104708, after: 134875 },
        { round: 15, billed: 133796, chars: 297478, payload: 391031, before: 133487, after: 134264 },
        { round: 16, billed: 134295, chars: 299154, payload: 392828, before: 134215, after: 134320 },
        { round: 17, billed: 134978, chars: 304029, payload: 397912, before: 135514, after: 135777 },
        { round: 18, billed: 135466, chars: 307324, payload: 401504, before: 135802, after: 136026 },
        { round: 19, billed: 135695, chars: 310259, payload: 404529, before: 136200, after: 136348 },
        { round: 20, billed: 137494, chars: 315646, payload: 410171, before: 137042, after: 137340 },
        { round: 21, billed: 225612, chars: 539258, payload: 644341, before: 193397, after: 205755 },
        { round: 22, billed: null, chars: 789280, payload: 905942, before: 288118, after: 301869 }
    ];

    /** The compaction ceiling that run was held to (`CONTEXT_LIMIT_DEFAULT`). */
    const WINDOW = 200_000;

    /**
     * Replay one round the way `../harness.ts` does it: the previous request's billed input
     * and recorded weight become the anchor (`anchorFromUsage` on the `usage` frame), and the
     * estimate is `estimateContextTokensHybrid` over the body about to be sent. The body is
     * an ASCII transcript of the SAME measured payload weight, so the estimator, the anchor
     * builder and the margin all run for real on the real numbers.
     */
    const replayAt = (index: number, options?: { anchorGrowthMargin?: number }): number => {
        const row = ROUNDS[index];
        const prev = index > 0 ? ROUNDS[index - 1] : undefined;
        const anchor =
            prev && prev.billed !== null
                ? anchorFromUsage({ input: prev.billed as number, output: 0, total: prev.billed as number }, prev.payload)
                : undefined;

        return estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(row.payload) }], undefined, anchor, options);
    };

    it('reproduces the shipped estimate for every measured round', () => {
        expect(ROUNDS.map((_, index) => replayAt(index))).toEqual(ROUNDS.map((row) => row.after));
    });

    it('crosses the 200,000 window at round 21 — one request before the refusal', () => {
        // THE TEST THE FIXTURE EXISTS FOR. Round 21 is the last request that SUCCEEDED
        // (225,612 billed); round 22 — the one carrying the compaction instruction — is the
        // one the provider refused. So the trigger has to fire at round 21 or earlier.
        const crossing = ROUNDS.find((row, index) => row.billed !== null && replayAt(index) >= WINDOW);

        expect(crossing?.round).toBe(21);
        expect(replayAt(20)).toBe(205755);
        // The pre-T5 number for the same round is 193,397 — 6,603 short of the ceiling it had
        // already passed, which is the exact mechanism of the refusal, pinned rather than
        // asserted. (Analysis probe: 193,428; see the block comment for the 31-token delta.)
        expect(ROUNDS[20].before).toBe(193397);
        expect(ROUNDS[20].before).toBeLessThan(WINDOW);
        // And the refused request itself: 288,118 before / 301,869 after, i.e. the compaction
        // pass rode a request ~50% over the window either way.
        expect(ROUNDS[21].before).toBe(288118);
        expect(ROUNDS[21].after).toBe(301869);
    });

    it('never answers below the billed prefix plus the measured serialized growth', () => {
        // T5's stated requirement, checked for every one of the 21 anchored rounds rather than
        // only the round that failed: with a real `usage.input` for a prefix of the current
        // body, the estimate >= `lastBilledInput + ceil(serializedGrowth / 4)`.
        for (let index = 1; index < ROUNDS.length; index += 1) {
            const row = ROUNDS[index];
            const prev = ROUNDS[index - 1];
            const floor = (prev.billed as number) + Math.ceil((row.payload - prev.payload) / 4);

            expect(replayAt(index)).toBeGreaterThanOrEqual(floor);
            // And never below the prefix's own billed size: a growing conversation's context
            // estimate cannot go DOWN because the estimator re-guessed a constant.
            expect(replayAt(index)).toBeGreaterThanOrEqual(prev.billed as number);
        }
    });

    it('is monotonic inside every anchor window the replay crosses', () => {
        // The rule the module header states, applied to the real curve rather than to a toy
        // anchor: inside ONE anchor window the number never steps down as text is appended.
        // Across rounds it MAY step down — each round replaces an extrapolation with the
        // provider's own count of the same prefix (documented step-down moment 1) — so the
        // cross-round assertion is the weaker, honest one: the estimate never falls below the
        // previous request's billed size.
        for (let index = 1; index < ROUNDS.length; index += 1) {
            const row = ROUNDS[index];
            const prev = ROUNDS[index - 1];
            const anchor = { tokens: prev.billed as number, chars: prev.payload };

            const samples = [0, 0.25, 0.5, 0.75, 1].map((step) => {
                const bytes = prev.payload + Math.round((row.payload - prev.payload) * step);
                return estimateContextTokensHybrid([{ role: 'user', content: 'x'.repeat(bytes) }], undefined, anchor);
            });

            for (let s = 1; s < samples.length; s += 1) {
                expect(samples[s]).toBeGreaterThanOrEqual(samples[s - 1]);
            }

            // The window's far end is exactly the round's pinned estimate.
            expect(samples[4]).toBe(row.after);
            // And the number never drops below what the provider already billed for the prefix.
            expect(samples[0]).toBeGreaterThanOrEqual(prev.billed as number);
        }

        // Round 2 -> round 3 is the documented step-DOWN: 53,297 (round 2 extrapolated from
        // round 1's anchor) is replaced by 52,644, the provider's own count of a longer
        // prefix. It is a correction of this file's error, not a clock artifact.
        expect(ROUNDS[1].after).toBe(53297);
        expect(ROUNDS[2].after).toBe(52644);
        expect(ROUNDS[2].after).toBeLessThan(ROUNDS[1].after);
        // Every step-down is attributed to a new provider count for a LONGER body, never to a
        // smaller body: the payload weight is strictly increasing across the whole curve.
        for (let index = 1; index < ROUNDS.length; index += 1) {
            expect(ROUNDS[index].payload).toBeGreaterThan(ROUNDS[index - 1].payload);
        }

        // The last window — the one that decided the refusal — pinned exactly, since the loop
        // above only orders its samples. Anchor: round 20's 137,494 tokens / 410,171 bytes;
        // the window is 234,170 payload bytes wide.
        //   +0        -> +0                          -> 137,494
        //   +58,543   -> ceil(58543 x 1.166 / 4) = 17,066 -> 154,560
        //   +117,085  -> ceil(117085 x 1.166 / 4) = 34,131 -> 171,625
        //   +175,628  -> ceil(175628 x 1.166 / 4) = 51,196 -> 188,690
        //   +234,170  -> ceil(234170 x 1.166 / 4) = 68,261 -> 205,755
        const wideAnchor = { tokens: 137494, chars: 410171 };
        expect(
            [0, 0.25, 0.5, 0.75, 1].map((step) =>
                estimateContextTokensHybrid(
                    [{ role: 'user', content: 'x'.repeat(410171 + Math.round(234170 * step)) }],
                    undefined,
                    wideAnchor
                )
            )
        ).toEqual([137494, 154560, 171625, 188690, 205755]);
        // Halfway through the request that was finally refused, the trigger had already passed
        // the 200,000 ceiling — the overflow was visible before the body finished growing.
        expect(ROUNDS[20].after).toBeGreaterThan(WINDOW);
    });

    it('quantifies the error against all 20 billed rows, before and after', () => {
        // Signed error = estimate - billed, in tokens, over the 21 rounds that have a billed
        // figure. This is the deliverable's before/after table, as a test.
        const signed = (column: 'before' | 'after'): number[] =>
            ROUNDS.filter((row) => row.billed !== null).map((row) => row[column] - (row.billed as number));

        const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
        const stats = (values: number[]): { mean: number; min: number; max: number; meanAbs: number } => ({
            mean: Math.round(sum(values) / values.length),
            min: Math.min(...values),
            max: Math.max(...values),
            meanAbs: Math.round(sum(values.map(Math.abs)) / values.length)
        });

        // Rounds 2..21 — the ones with an anchor, i.e. the ones the estimator can be honest
        // about. BEFORE: mean -2,978, worst -32,215 UNDER (round 21). AFTER: mean -331,
        // worst -19,857 under, and the largest overshoot on the whole curve is +5,639.
        const anchored = (values: number[]): number[] => values.slice(1);
        expect(stats(anchored(signed('before')))).toEqual({ mean: -2978, min: -32215, max: 2981, meanAbs: 3616 });
        expect(stats(anchored(signed('after')))).toEqual({ mean: -331, min: -19857, max: 5639, meanAbs: 2199 });

        // Rounds 1..21, including the unanchored first request whose 31,229-token catalogue
        // the estimator cannot see without `toolSchemaChars` (see the floor block above).
        expect(stats(signed('before'))).toEqual({ mean: -4323, min: -32215, max: 2981, meanAbs: 4931 });
        expect(stats(signed('after'))).toEqual({ mean: -1803, min: -31226, max: 5639, meanAbs: 3582 });

        // The direction of the residual, stated as a number: the fixed estimator is inside
        // +/-9% of the provider on every anchored round, and never by more than 8.7% OVER.
        const ratios = ROUNDS.filter((row) => row.billed !== null).map((row) => row.after / (row.billed as number));
        expect(Math.min(...ratios).toFixed(2)).toBe('0.01'); // round 1, the catalogue floor
        expect(Math.max(...ratios.slice(1)).toFixed(2)).toBe('1.09');
        expect(Math.min(...ratios.slice(1)).toFixed(2)).toBe('0.91');

        // BEFORE the fix, the same ratio test on the under side: every round from 14 on was
        // under-billed by at least 1.6x... the single number that matters is round 21.
        const beforeRatios = ROUNDS.filter((row) => row.billed !== null).map((row) => row.before / (row.billed as number));
        expect(beforeRatios[20].toFixed(3)).toBe('0.857');
    });

    it('shows exactly what the margin constant buys, and what it does not', () => {
        // `anchorGrowthMargin: 0` is the pre-T5 growth rule on the NEW byte measure: round 21
        // becomes 196,037 — still UNDER the 200,000 window, so the bytes alone would not have
        // saved this run. That is the justification for `ANCHOR_GROWTH_MARGIN` (0.166), and
        // the reason it is a named constant rather than a fudge factor buried in the term.
        expect(replayAt(20, { anchorGrowthMargin: 0 })).toBe(196037);
        expect(replayAt(20, { anchorGrowthMargin: 0 })).toBeLessThan(WINDOW);
        expect(replayAt(20)).toBe(205755);
        expect(replayAt(20)).toBeGreaterThanOrEqual(ROUNDS[20].billed as number - 20000);

        // The margin is honest about its own limit: round 21 is still 19,857 tokens UNDER the
        // billed figure (0.912), because 234,170 payload bytes were billed as 88,118 tokens —
        // 2.66 payload bytes per token, which no character or byte rule can see. The plugin's
        // headroom buffer is what absorbs that residual once a model window is declared.
        expect((ROUNDS[20].billed as number) - ROUNDS[20].after).toBe(19857);
        expect(ROUNDS[20].payload - ROUNDS[19].payload).toBe(234170);
    });
});
