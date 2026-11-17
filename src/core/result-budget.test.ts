// The model-facing tool-result budget (R10, compaction T5.1/T5.2, sizing T3).
//
// The contract pinned here:
//   - the default budget is 8192 TOKENS of SERIALIZED payload (32 KiB) per result and
//     24576 tokens (96 KiB, three results) per TURN
//     (`createToolResultTurnBudget`), both derived from the shipped 200k-token window;
//   - a budget is measured with `modelPayloadBytes` — the bytes the text occupies ONCE
//     SERIALIZED into the model request — never with `utf8ByteLength`, which is only
//     what the envelope's note QUOTES. A result at or under the budget is returned
//     BYTE-EXACT (no marker, no re-encoding), which is what keeps every existing tool
//     result unchanged;
//   - an over-budget result becomes a small, VALID JSON envelope that names the
//     truncation, the original size, the applied budget, a HEAD preview (under the
//     historical `content` key), a TAIL preview, and a note saying how much was cut
//     and which call to re-run (T5.1);
//   - the DELIVERED payload never exceeds the applied budget, except at the documented
//     floor where the note alone is already the budget (see the sweep test);
//   - a multi-byte character and a surrogate pair are never split at either cut;
//   - the aggregate guard spills results, it never drops one, and it is
//     deterministic: the same committed total and the same input produce the same
//     bytes.
//
// Every expected value below is the exact string the module produces, derived from the
// split rule (3/4 head, 1/4 tail of the allowance, note recomputed per attempt so it
// can never claim a cut that did not happen) rather than a range check. The head/tail
// sizes are SMALLER than they were under the raw-byte measure for the same budget: the
// envelope is JSON, so its own quotes cost a byte each, and that cost is now charged to
// the budget that declared it instead of arriving as unbudgeted drift.

import { describe, expect, it } from 'vitest';
import {
    MODEL_TOOL_RESULT_BUDGET_BYTES,
    MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES,
    boundToolResult,
    createToolResultTurnBudget,
    utf8ByteLength
} from '@underload/harness';
// The two names this change ADDS to the public surface come from their own modules, not
// from the package barrel: `src/index.ts` re-exports only what `src/harness.ts` names
// explicitly, and that list does not mention them yet. The follow-up (a two-line edit in
// `src/harness.ts`, a file this worker does not own) is reported rather than made here.
import { modelPayloadBytes } from './payload-bytes';
import { toolResultBudgetsForContextTokens } from './result-budget';

// One envelope, parsed. The shape is a contract: a model may read it and a host may
// render it, so the key set is asserted, not assumed.
type Envelope = {
    truncated: boolean;
    originalBytes: number;
    budgetBytes: number;
    note: string;
    content: string;
    tail: string;
};

const envelopeOf = (content: string): Envelope => JSON.parse(content) as Envelope;

describe('boundToolResult', () => {
    it('budgets 8192 tokens of payload per result and returns a small result byte-exact', () => {
        // 32 KiB of SERIALIZED payload = 8192 tokens at the 4-bytes-per-token estimate.
        // The old 256 KiB was sized when the harness had no window to speak of; against
        // the shipped 200k-token window it let ONE result claim 26% of the context.
        // `read` budgets its own output at exactly this number and the two must agree,
        // or a full-budget read gets its continuation fields destroyed.
        expect(MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(32_768);
        expect(boundToolResult('hello')).toEqual({ content: 'hello', truncated: false, originalBytes: 5 });
        expect(boundToolResult('')).toEqual({ content: '', truncated: false, originalBytes: 0 });
        // A JSON result is not re-encoded: the exact same string comes back.
        expect(boundToolResult('{"a":1}')).toEqual({
            content: '{"a":1}',
            truncated: false,
            originalBytes: 7
        });
    });

    it('publishes the per-turn aggregate next to the per-result cap', () => {
        // 24576 tokens: three full-budget results. The relationship is the design, so it
        // is pinned as arithmetic — a turn of many big results cannot spend N x 32 KiB.
        expect(MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES).toBe(98_304);
        expect(MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES).toBe(MODEL_TOOL_RESULT_BUDGET_BYTES * 3);
    });

    it('sizes both budgets from the window, and never below the usable floor', () => {
        // T3. A host that configures a 32k or a 1M window gets the SAME shares (4.1% /
        // 12.3%) instead of inheriting a number sized for 200k. A window so small that
        // the share buys less than an envelope lands on the floor (4 KiB / 8 KiB), and a
        // corrupt window falls back to the shipped default rather than to a degenerate
        // budget. `0` is read as "use the default", the way a disabled aggregate is.
        expect(toolResultBudgetsForContextTokens()).toEqual({ perResultBytes: 32_768, perTurnBytes: 98_304 });
        expect(toolResultBudgetsForContextTokens(200_000)).toEqual({ perResultBytes: 32_768, perTurnBytes: 98_304 });
        expect(toolResultBudgetsForContextTokens(32_000)).toEqual({ perResultBytes: 5_242, perTurnBytes: 15_728 });
        expect(toolResultBudgetsForContextTokens(128_000)).toEqual({ perResultBytes: 20_971, perTurnBytes: 62_914 });
        expect(toolResultBudgetsForContextTokens(1_000_000)).toEqual({ perResultBytes: 163_840, perTurnBytes: 491_520 });
        expect(toolResultBudgetsForContextTokens(8_000)).toEqual({ perResultBytes: 4_096, perTurnBytes: 8_192 });
        for (const corrupt of [0, Number.NaN, -1, undefined as unknown as number]) {
            expect(toolResultBudgetsForContextTokens(corrupt)).toEqual({
                perResultBytes: 32_768,
                perTurnBytes: 98_304
            });
        }
    });

    it('leaves a result exactly at the budget untouched', () => {
        const exact = 'x'.repeat(100);

        expect(boundToolResult(exact, 100)).toEqual({ content: exact, truncated: false, originalBytes: 100 });

        // One byte over the budget IS truncated, so the boundary is inclusive.
        expect(boundToolResult('x'.repeat(101), 100).truncated).toBe(true);
    });

    it('wraps an over-budget result in an exact head/tail envelope that names the call', () => {
        // 400-byte PAYLOAD budget. The envelope's fixed overhead is ~237 serialized
        // bytes (13 JSON keys/punctuation plus the note, and its own quotes escape),
        // which leaves 163 bytes of preview: 66 of head and 23 of tail, the pair the
        // shrink loop settled on. Exact, not approximate: the same input always yields
        // this string, and the delivered payload lands exactly on the budget.
        const bounded = boundToolResult('y'.repeat(1000), 400, { source: { name: 'read', callId: 'c1' } });

        expect(bounded).toEqual({
            content:
                '{"truncated":true,"originalBytes":1000,"budgetBytes":400,' +
                '"note":"Cut 911 of 1000 bytes from the middle by a 400-byte cap; kept a 66-byte head and a 23-byte tail. The full text is not in this transcript: re-run tool \'read\' (call c1) with narrower arguments to fetch it.",' +
                `"content":"${'y'.repeat(66)}","tail":"${'y'.repeat(23)}"}`,
            truncated: true,
            originalBytes: 1000
        });

        // Still parseable JSON (the documented contract of a truncated result), and
        // the envelope itself never exceeds the budget it was cut to.
        expect(envelopeOf(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 1000,
            budgetBytes: 400,
            note: "Cut 911 of 1000 bytes from the middle by a 400-byte cap; kept a 66-byte head and a 23-byte tail. The full text is not in this transcript: re-run tool 'read' (call c1) with narrower arguments to fetch it.",
            content: 'y'.repeat(66),
            tail: 'y'.repeat(23)
        });
        // The budget bounds the DELIVERED bytes (400), not the text's own bytes (382):
        // the 18-byte difference is the envelope's own quotes, which the provider bills
        // and the old measure never charged to anything.
        expect(modelPayloadBytes(bounded.content)).toBe(400);
        expect(utf8ByteLength(bounded.content)).toBe(382);
    });

    it('degrades the re-fetch line when the caller cannot name the call', () => {
        // The manual tool route (src/server/api.ts) has no transcript and no call id,
        // so the note says only "the tool call" — and a longer note leaves a smaller
        // preview. Both halves are exact, and the ordering is the point: naming LESS
        // costs the caller MORE window.
        expect(envelopeOf(boundToolResult('y'.repeat(1000), 400).content)).toEqual({
            truncated: true,
            originalBytes: 1000,
            budgetBytes: 400,
            note: "Cut 911 of 1000 bytes from the middle by a 400-byte cap; kept a 66-byte head and a 23-byte tail. The full text is not in this transcript: re-run the tool call with narrower arguments to fetch it.",
            content: 'y'.repeat(66),
            tail: 'y'.repeat(23)
        });

        // A partial identity is still an identity: each form names what it knows, and a
        // shorter identity string buys 8 more head bytes and 2 more tail bytes.
        expect(envelopeOf(boundToolResult('y'.repeat(1000), 400, { source: { callId: 'c9' } }).content).note).toBe(
            "Cut 901 of 1000 bytes from the middle by a 400-byte cap; kept a 74-byte head and a 25-byte tail. The full text is not in this transcript: re-run the call c9 with narrower arguments to fetch it."
        );
        expect(envelopeOf(boundToolResult('y'.repeat(1000), 400, { source: { name: 'grep' } }).content).note).toBe(
            "Cut 901 of 1000 bytes from the middle by a 400-byte cap; kept a 74-byte head and a 25-byte tail. The full text is not in this transcript: re-run tool 'grep' with narrower arguments to fetch it."
        );
    });

    it('keeps both ends of a JSON document, so the cut is the only loss', () => {
        // The reason a head/tail split replaces the old mid-string cut. A large `read`
        // answer keeps its opening structure AND its trailing continuation fields
        // (`nextLine` here), which the prefix-only envelope used to destroy.
        const source = JSON.stringify({ files: [{ path: 'a.ts', content: 'q'.repeat(2_000) }], nextLine: 42 });
        const bounded = boundToolResult(source, 1_000, { source: { name: 'read', callId: 'r1' } });
        const envelope = envelopeOf(bounded.content);

        expect(bounded.originalBytes).toBe(utf8ByteLength(source));
        expect(envelope.content.startsWith('{"files":[{"path":"a.ts","content":"qq')).toBe(true);
        expect(envelope.tail.endsWith('],"nextLine":42}')).toBe(true);
        // The note is honest about both previews and about the size of the hole. The
        // previews are 50/16 bytes smaller than under the raw-byte measure because this
        // source is itself JSON: every quote in the head and tail preview is escaped a
        // SECOND time on the way into the request body, and that is the form billed.
        expect(envelope.note).toBe(
            "Cut 1464 of 2054 bytes from the middle by a 1000-byte cap; kept a 442-byte head and a 148-byte tail. The full text is not in this transcript: re-run tool 'read' (call r1) with narrower arguments to fetch it."
        );
        expect(modelPayloadBytes(bounded.content)).toBe(942);
        expect(utf8ByteLength(bounded.content)).toBe(900);
        expect(modelPayloadBytes(bounded.content)).toBeLessThanOrEqual(1_000);
    });

    it('caps a huge result at the default 8192-token budget with an exact preview pair', () => {
        const bounded = boundToolResult('z'.repeat(300_000), MODEL_TOOL_RESULT_BUDGET_BYTES, {
            source: { name: 'dump', callId: 'c1' }
        });

        expect(bounded.truncated).toBe(true);
        expect(bounded.originalBytes).toBe(300_000);
        // 32768 * 0.9 floored is the first candidate that fits: 29491 code units, split
        // 22118 head / 7373 tail, i.e. 270509 bytes of the middle gone. The delivered
        // payload is 29818 bytes, inside the 32768 it was given.
        expect(envelopeOf(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 300_000,
            budgetBytes: 32_768,
            note: "Cut 270509 of 300000 bytes from the middle by a 32768-byte cap; kept a 22118-byte head and a 7373-byte tail. The full text is not in this transcript: re-run tool 'dump' (call c1) with narrower arguments to fetch it.",
            content: 'z'.repeat(22_118),
            tail: 'z'.repeat(7_373)
        });
        expect(modelPayloadBytes(bounded.content)).toBe(29_818);
        expect(utf8ByteLength(bounded.content)).toBe(29_800);
    });

    it('leaves a full-budget read result untruncated', () => {
        // The regression this pins. `read` budgets its own output at exactly this
        // cap and measures it on the SERIALIZED form, so a read that fills its
        // budget must arrive here byte-exact. When both budgets were 64 KiB but
        // read measured RAW content, JSON escaping (2-15%) always pushed the result
        // over the cap, and the envelope destroyed the continuation fields.
        const content = JSON.stringify({
            files: [{ content: 'x'.repeat(MODEL_TOOL_RESULT_BUDGET_BYTES - 200) }],
            truncated: true
        });

        expect(utf8ByteLength(content)).toBeLessThanOrEqual(MODEL_TOOL_RESULT_BUDGET_BYTES);
        expect(boundToolResult(content)).toEqual({
            content,
            truncated: false,
            originalBytes: utf8ByteLength(content)
        });
    });

    it('spends a multibyte budget on the note before any preview', () => {
        // 200 é is 400 bytes of payload — JSON leaves non-ASCII as it is, so `é` costs
        // its 2 UTF-8 bytes and nothing more. Over a 300-byte payload budget the
        // envelope's own 299 serialized bytes (13 escaped quotes plus the note) leave
        // room for ZERO preview: under the raw-byte measure this same budget bought a
        // 6-character head, and the 18 bytes the measure ignored are exactly the
        // difference. Pinned so the floor is a stated outcome, not a surprise.
        const bounded = boundToolResult('é'.repeat(200), 300);

        expect(bounded).toEqual({
            content:
                '{"truncated":true,"originalBytes":400,"budgetBytes":300,' +
                '"note":"Cut 400 of 400 bytes from the middle by a 300-byte cap; kept a 0-byte head and a 0-byte tail. The full text is not in this transcript: re-run the tool call with narrower arguments to fetch it.",' +
                '"content":"","tail":""}',
            truncated: true,
            originalBytes: 400
        });
        expect(modelPayloadBytes(bounded.content)).toBe(299);
        expect(utf8ByteLength(bounded.content)).toBe(281);
    });

    it('never splits a multi-byte character or a surrogate pair at either cut', () => {
        // 50 U+1F600 (2 code units, 4 bytes each) + 400 ASCII + 50 more, over a 400-byte
        // payload budget. The previews are measured in BYTES by the note, and the
        // code-unit slices never land between the two units of one pair: both previews
        // are exact substrings of the source, so a model can trust them.
        const source = '😀'.repeat(50) + 'x'.repeat(400) + '😀'.repeat(50);
        const bounded = boundToolResult(source, 400);
        const envelope = envelopeOf(bounded.content);

        expect(envelope.content).toBe('😀'.repeat(16));
        expect(envelope.tail).toBe('😀'.repeat(6));
        expect(source.startsWith(envelope.content)).toBe(true);
        expect(source.endsWith(envelope.tail)).toBe(true);
        expect(envelope.note).toBe(
            "Cut 712 of 800 bytes from the middle by a 400-byte cap; kept a 64-byte head and a 24-byte tail. The full text is not in this transcript: re-run the tool call with narrower arguments to fetch it."
        );
        // A surrogate PAIR costs 4 payload bytes here, not 12: `JSON.stringify` only
        // escapes a LONE surrogate, and a preview that keeps pairs intact (as the trim
        // guarantees) pays nothing extra for them.
        expect(modelPayloadBytes(bounded.content)).toBe(389);
        expect(utf8ByteLength(bounded.content)).toBe(371);
    });

    it('never lets the delivered payload exceed the budget it was cut to', () => {
        // THE acceptance property for the size fix, checked across every escape class:
        // quotes (1 byte -> 2), backslashes, control characters (`\n` -> 2, NUL -> 6),
        // non-ASCII left alone by JSON, and lone surrogates (1 unit -> 6 bytes). The
        // delivered string is what the transcript carries, so a budget that reports
        // "within" while the wire carries more is the bug this whole change exists for.
        // The one documented exception is the floor: when the note alone is already the
        // budget, the preview is empty and the envelope is the floor size.
        const cases: Array<[string, string, number]> = [
            ['quotes x1000 @1000', '"'.repeat(1_000), 1_000],
            ['quotes x1000 @400', '"'.repeat(1_000), 400],
            ['backslash+LF @1200', `${'\\'.repeat(500)}${'\n'.repeat(500)}`, 1_200],
            ['lone surrogates @600', '\ud800'.repeat(400), 600],
            ['cjk x500 @2000', '世'.repeat(500), 2_000],
            ['mixed read window @2048', `${'x'.repeat(1_900)}\n"quoted"\n${'é'.repeat(40)}`, 2_048],
            ['emoji x100 @600', '😀'.repeat(100), 600]
        ];

        for (const [label, content, budget] of cases) {
            const bounded = boundToolResult(content, budget);
            const delivered = modelPayloadBytes(bounded.content);

            expect(delivered, `${label} fits the budget it was given`).toBeLessThanOrEqual(budget);
            expect(bounded.originalBytes, `${label} reports the text's own bytes`).toBe(utf8ByteLength(content));

            if (bounded.truncated) {
                const envelope = envelopeOf(bounded.content);
                // The previews are charged, not decorative: the pair plus the note is
                // the whole delivered payload, and the note's numbers agree with it.
                expect(
                    modelPayloadBytes(envelope.content) + modelPayloadBytes(envelope.tail),
                    `${label} previews are inside the allowance`
                ).toBeLessThanOrEqual(delivered);
                expect(envelope.note).toContain(`of ${utf8ByteLength(content)} bytes`);
            }
        }
    });

    it('returns a note-only envelope when the budget cannot hold the note and a preview', () => {
        // The documented extreme edge: a budget below the envelope's fixed overhead.
        // A truncation marker still beats silence, and the note stays exact.
        expect(boundToolResult('abc', 0)).toEqual({
            content:
                '{"truncated":true,"originalBytes":3,"budgetBytes":0,' +
                '"note":"Cut 3 of 3 bytes from the middle by a 0-byte cap; kept a 0-byte head and a 0-byte tail. The full text is not in this transcript: re-run the tool call with narrower arguments to fetch it.",' +
                '"content":"","tail":""}',
            truncated: true,
            originalBytes: 3
        });
    });

    it('measures bytes, not code units', () => {
        expect(utf8ByteLength('abc')).toBe(3);
        expect(utf8ByteLength('é')).toBe(2);
        expect(utf8ByteLength('😀')).toBe(4);
    });
});

describe('createToolResultTurnBudget', () => {
    it('starts an empty window on the published 24576-token aggregate', () => {
        const turn = createToolResultTurnBudget();

        expect(turn.aggregateBytes()).toBe(MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES);
        expect(turn.committedBytes()).toBe(0);
    });

    it('returns EXACTLY boundToolResult for every result inside the aggregate', () => {
        // The no-cost property: a turn under the aggregate must be byte-identical to
        // the per-result behaviour, or this change would have altered every normal
        // conversation. Same call identity on both sides, so the notes must match too.
        const content = 'q'.repeat(5_000);
        const options = { source: { name: 'echo', callId: 'e1' } };
        const turn = createToolResultTurnBudget(2048, 1024);

        expect(turn.commit(content, options)).toEqual(boundToolResult(content, 1024, options));
        // 968 raw / 986 delivered: the ledger books the second number, because that is
        // the number the next request carries.
        expect(turn.committedBytes()).toBe(986);
    });

    it('bounds the SUM of one turn and spills only what no longer fits', () => {
        // A 2048-byte window with a 1024-byte per-result cap, four deliveries.
        // a/b: capped by the PER-RESULT rule and still inside the aggregate.
        // c: 100 bytes, committed whole.
        // d: the window has 13 bytes left, so it spills to the 512-byte floor.
        const turn = createToolResultTurnBudget(2048, 1024);

        const a = turn.commit('a'.repeat(1500), { source: { name: 'alpha', callId: 'a1' } });
        // The per-result cut is UNCHANGED by the measure: the note quotes text bytes and
        // the cap was applied in payload bytes on both sides of the change.
        expect(envelopeOf(a.content).note).toBe(
            "Cut 830 of 1500 bytes from the middle by a 1024-byte cap; kept a 502-byte head and a 168-byte tail. The full text is not in this transcript: re-run tool 'alpha' (call a1) with narrower arguments to fetch it."
        );
        expect(turn.committedBytes()).toBe(986);

        const b = turn.commit('b'.repeat(1500), { source: { name: 'beta', callId: 'b2' } });
        expect(envelopeOf(b.content).budgetBytes).toBe(1024);
        expect(turn.committedBytes()).toBe(1971);

        const c = turn.commit('c'.repeat(100), { source: { name: 'gamma', callId: 'c3' } });
        expect(c).toEqual({ content: 'c'.repeat(100), truncated: false, originalBytes: 100 });
        expect(turn.committedBytes()).toBe(2071);

        const d = turn.commit('d'.repeat(1500), { source: { name: 'delta', callId: 'd4' } });
        const spilled = envelopeOf(d.content);
        expect(spilled.budgetBytes).toBe(512);
        expect(spilled.note).toBe(
            "Cut 1358 of 1500 bytes from the middle by a 512-byte budget set by this turn's 2048-byte per-turn cap; kept a 106-byte head and a 36-byte tail. The full text is not in this transcript: re-run tool 'delta' (call d4) with narrower arguments to fetch it."
        );
        // The spill is what fits; the window overshoots by less than one envelope,
        // which is the soft-bound rule stated in the module header.
        expect(modelPayloadBytes(d.content)).toBe(501);
        expect(utf8ByteLength(d.content)).toBe(483);
        expect(turn.committedBytes()).toBe(2572);
        expect(turn.committedBytes() - 2048).toBe(524);
    });

    it('never refuses a result, because pairing requires an answer for every call', () => {
        // Three full-size results fill the default window EXACTLY (3 x 32768 = 98304,
        // which is why the aggregate is 3x the cap), and the fourth is still delivered:
        // spilled to the 512-byte floor, never dropped.
        const turn = createToolResultTurnBudget();
        const full = 'r'.repeat(MODEL_TOOL_RESULT_BUDGET_BYTES);

        expect(turn.commit(full).truncated).toBe(false);
        expect(turn.commit(full).truncated).toBe(false);
        expect(turn.commit(full).truncated).toBe(false);
        expect(turn.committedBytes()).toBe(MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES);

        const fourth = turn.commit('t'.repeat(3_000), { source: { name: 'tail', callId: 't3' } });

        expect(fourth.truncated).toBe(true);
        expect(fourth.originalBytes).toBe(3_000);
        expect(envelopeOf(fourth.content).budgetBytes).toBe(512);
        expect(modelPayloadBytes(fourth.content)).toBe(501);
        expect(utf8ByteLength(fourth.content)).toBe(483);
        expect(envelopeOf(fourth.content).note).toBe(
            "Cut 2858 of 3000 bytes from the middle by a 512-byte budget set by this turn's 98304-byte per-turn cap; kept a 106-byte head and a 36-byte tail. The full text is not in this transcript: re-run tool 'tail' (call t3) with narrower arguments to fetch it."
        );
        // The window is over by one spilled envelope and nothing more.
        expect(turn.committedBytes()).toBe(98_805);
    });

    it('is deterministic: the same deliveries in the same order produce the same bytes', () => {
        const script = (turn: ReturnType<typeof createToolResultTurnBudget>): string[] =>
            ['a', 'b', 'c', 'd'].map((letter) =>
                turn.commit(letter.repeat(1500), { source: { name: letter, callId: letter } }).content
            );

        const first = script(createToolResultTurnBudget(2048, 1024));
        const second = script(createToolResultTurnBudget(2048, 1024));

        expect(first).toEqual(second);
    });

    it('reopens the window on reset, which is what a new model request does', () => {
        const turn = createToolResultTurnBudget(2048, 1024);

        turn.commit('a'.repeat(1500));
        expect(turn.committedBytes()).toBeGreaterThan(0);

        turn.reset();
        expect(turn.committedBytes()).toBe(0);

        // The same delivery that spilled-adjacent before is now inside a fresh window.
        expect(envelopeOf(turn.commit('a'.repeat(1500)).content).budgetBytes).toBe(1024);
    });

    it('disables only the aggregate guard for a corrupt or non-positive aggregate', () => {
        // A host that configures 0/NaN/undefined wants "no aggregate cap", not "no
        // tool results": the per-result cap still applies, unchanged.
        for (const aggregate of [0, Number.NaN, -1]) {
            const turn = createToolResultTurnBudget(aggregate, 1024);

            expect(turn.aggregateBytes()).toBe(0);

            const bounded = turn.commit('e'.repeat(1500));

            expect(envelopeOf(bounded.content).budgetBytes).toBe(1024);
            // 959 was the raw-byte figure; 977 is what the next request actually
            // carries, and it is the figure the (disabled) aggregate would have compared.
            expect(turn.committedBytes()).toBe(977);
        }
    });

    it('honours a caller-supplied per-result cap below the aggregate', () => {
        // A tool that budgets its own output (read, grep) passes its own cap; the
        // aggregate still applies on top of it.
        const turn = createToolResultTurnBudget(4_000, 10_000);
        const capped = turn.commit('k'.repeat(1_500), { budgetBytes: 700 });

        expect(envelopeOf(capped.content).budgetBytes).toBe(700);
        // 658 raw, 676 delivered. The caller asked for 700 PAYLOAD bytes and got 676;
        // under the old measure it would have asked for 700 raw and received a result
        // that arrived at up to ~742 (quote-heavy content is where the gap lived).
        expect(utf8ByteLength(capped.content)).toBe(658);
        expect(modelPayloadBytes(capped.content)).toBe(676);
        expect(turn.committedBytes()).toBe(676);
    });
});
