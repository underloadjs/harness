// The model-facing tool-result budget (R10, compaction T5.1/T5.2).
//
// The contract pinned here:
//   - the default budget is 256 KiB of UTF-8 per result, and 512 KiB of UTF-8 per
//     TURN (`createToolResultTurnBudget`);
//   - a result at or under the budget is returned BYTE-EXACT (no marker, no
//     re-encoding), which is what keeps every existing tool result unchanged;
//   - an over-budget result becomes a small, VALID JSON envelope that names the
//     truncation, the original size, the applied budget, a HEAD preview (under the
//     historical `content` key), a TAIL preview, and a note saying how much was cut
//     and which call to re-run (T5.1);
//   - a multi-byte character and a surrogate pair are never split at either cut;
//   - the aggregate guard spills results, it never drops one, and it is
//     deterministic: the same committed total and the same input produce the same
//     bytes.
//
// Every expected value below is the exact string the module produces, derived from
// the split rule (3/4 head, 1/4 tail of the allowance, note recomputed per attempt so
// it can never claim a cut that did not happen) rather than a range check.

import { describe, expect, it } from 'vitest';
import {
    MODEL_TOOL_RESULT_BUDGET_BYTES,
    MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES,
    boundToolResult,
    createToolResultTurnBudget,
    utf8ByteLength
} from '@underload/harness';

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
    it('budgets 256 KiB per result and returns a small result byte-exact', () => {
        // 256 KiB, not 64: read's own budget is DERIVED from this number and the two
        // must agree, or a full-budget read gets its continuation fields destroyed.
        expect(MODEL_TOOL_RESULT_BUDGET_BYTES).toBe(262_144);
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
        // T5.2. 2x the per-result cap: one full-budget read plus one more large
        // result still fit UNCHANGED, while a turn of many big results cannot spend
        // N x 256 KiB. The relationship is the design, so it is pinned as arithmetic.
        expect(MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES).toBe(524_288);
        expect(MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES).toBe(MODEL_TOOL_RESULT_BUDGET_BYTES * 2);
    });

    it('leaves a result exactly at the budget untouched', () => {
        const exact = 'x'.repeat(100);

        expect(boundToolResult(exact, 100)).toEqual({ content: exact, truncated: false, originalBytes: 100 });

        // One byte over the budget IS truncated, so the boundary is inclusive.
        expect(boundToolResult('x'.repeat(101), 100).truncated).toBe(true);
    });

    it('wraps an over-budget result in an exact head/tail envelope that names the call', () => {
        // 400-byte budget, 219 bytes of envelope overhead (13 JSON keys/punctuation +
        // the note), leaving 180 code units: floor(180 * 3/4) = 135 -> trimmed to the
        // 74 that actually fit, and the 25-unit tail is what the shrink loop settled
        // on. Exact, not approximate: the same input always yields this string.
        const bounded = boundToolResult('y'.repeat(1000), 400, { source: { name: 'read', callId: 'c1' } });

        expect(bounded).toEqual({
            content:
                '{"truncated":true,"originalBytes":1000,"budgetBytes":400,' +
                '"note":"Cut 901 of 1000 bytes from the middle by a 400-byte cap; kept a 74-byte head and a 25-byte tail. The full text is not in this transcript: re-run tool \'read\' (call c1) with narrower arguments to fetch it.",' +
                `"content":"${'y'.repeat(74)}","tail":"${'y'.repeat(25)}"}`,
            truncated: true,
            originalBytes: 1000
        });

        // Still parseable JSON (the documented contract of a truncated result), and
        // the envelope itself never exceeds the budget it was cut to.
        expect(envelopeOf(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 1000,
            budgetBytes: 400,
            note: "Cut 901 of 1000 bytes from the middle by a 400-byte cap; kept a 74-byte head and a 25-byte tail. The full text is not in this transcript: re-run tool 'read' (call c1) with narrower arguments to fetch it.",
            content: 'y'.repeat(74),
            tail: 'y'.repeat(25)
        });
        expect(utf8ByteLength(bounded.content)).toBe(392);
    });

    it('degrades the re-fetch line when the caller cannot name the call', () => {
        // The manual tool route (src/server/api.ts) has no transcript and no call id,
        // so the note says only "the tool call" — and the shorter note leaves a bigger
        // preview: 82 + 28 instead of 74 + 25. Both halves are exact.
        expect(envelopeOf(boundToolResult('y'.repeat(1000), 400).content)).toEqual({
            truncated: true,
            originalBytes: 1000,
            budgetBytes: 400,
            note: "Cut 890 of 1000 bytes from the middle by a 400-byte cap; kept a 82-byte head and a 28-byte tail. The full text is not in this transcript: re-run the tool call with narrower arguments to fetch it.",
            content: 'y'.repeat(82),
            tail: 'y'.repeat(28)
        });

        // A partial identity is still an identity: each form names what it knows.
        expect(envelopeOf(boundToolResult('y'.repeat(1000), 400, { source: { callId: 'c9' } }).content).note).toBe(
            "Cut 890 of 1000 bytes from the middle by a 400-byte cap; kept a 82-byte head and a 28-byte tail. The full text is not in this transcript: re-run the call c9 with narrower arguments to fetch it."
        );
        expect(envelopeOf(boundToolResult('y'.repeat(1000), 400, { source: { name: 'grep' } }).content).note).toBe(
            "Cut 890 of 1000 bytes from the middle by a 400-byte cap; kept a 82-byte head and a 28-byte tail. The full text is not in this transcript: re-run tool 'grep' with narrower arguments to fetch it."
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
        // The note is honest about both previews and about the size of the hole.
        expect(envelope.note).toBe(
            "Cut 1398 of 2054 bytes from the middle by a 1000-byte cap; kept a 492-byte head and a 164-byte tail. The full text is not in this transcript: re-run tool 'read' (call r1) with narrower arguments to fetch it."
        );
        expect(utf8ByteLength(bounded.content)).toBe(966);
        expect(utf8ByteLength(bounded.content)).toBeLessThanOrEqual(1_000);
    });

    it('caps a huge result at the default 256 KiB with an exact preview pair', () => {
        const bounded = boundToolResult('z'.repeat(300_000), MODEL_TOOL_RESULT_BUDGET_BYTES, {
            source: { name: 'dump', callId: 'c1' }
        });

        expect(bounded.truncated).toBe(true);
        expect(bounded.originalBytes).toBe(300_000);
        // 262144 * 0.9 floored is the first candidate that fits: 235 929 code units,
        // split 176 946 head / 58 983 tail, i.e. 64 071 bytes of the middle gone.
        expect(envelopeOf(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 300_000,
            budgetBytes: 262_144,
            note: "Cut 64071 of 300000 bytes from the middle by a 262144-byte cap; kept a 176946-byte head and a 58983-byte tail. The full text is not in this transcript: re-run tool 'dump' (call c1) with narrower arguments to fetch it.",
            content: 'z'.repeat(176_946),
            tail: 'z'.repeat(58_983)
        });
        expect(utf8ByteLength(bounded.content)).toBe(236_241);
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

    it('never splits a multi-byte character at either cut', () => {
        // 200 é is 400 bytes over a 300-byte budget. The previews are measured in
        // BYTES by the note, and the code-unit slices never land between the two
        // bytes of one character.
        const bounded = boundToolResult('é'.repeat(200), 300);

        expect(envelopeOf(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 400,
            budgetBytes: 300,
            note: "Cut 382 of 400 bytes from the middle by a 300-byte cap; kept a 12-byte head and a 6-byte tail. The full text is not in this transcript: re-run the tool call with narrower arguments to fetch it.",
            content: 'é'.repeat(6),
            tail: 'é'.repeat(3)
        });
        expect(utf8ByteLength(bounded.content)).toBe(300);
    });

    it('drops a split surrogate pair from the head AND from the tail', () => {
        // Slicing 100 code points of U+1F600 (2 code units each) can leave a lone
        // high surrogate at the end of the head and a lone low surrogate at the start
        // of the tail. Both are trimmed, so the previews stay exact substrings.
        const source = '😀'.repeat(50) + 'x'.repeat(400) + '😀'.repeat(50);
        const bounded = boundToolResult(source, 400);
        const envelope = envelopeOf(bounded.content);

        expect(envelope.content).toBe('😀'.repeat(21));
        expect(envelope.tail).toBe('😀'.repeat(7));
        expect(source.startsWith(envelope.content)).toBe(true);
        expect(source.endsWith(envelope.tail)).toBe(true);
        expect(utf8ByteLength(bounded.content)).toBe(395);
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
    it('starts an empty window on the published 512 KiB aggregate', () => {
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
        expect(turn.committedBytes()).toBe(968);
    });

    it('bounds the SUM of one turn and spills only what no longer fits', () => {
        // A 2048-byte window with a 1024-byte per-result cap, four deliveries.
        // a/b: capped by the PER-RESULT rule and still inside the aggregate.
        // c: 100 bytes, committed whole.
        // d: the window has 13 bytes left, so it spills to the 512-byte floor.
        const turn = createToolResultTurnBudget(2048, 1024);

        const a = turn.commit('a'.repeat(1500), { source: { name: 'alpha', callId: 'a1' } });
        expect(envelopeOf(a.content).note).toBe(
            "Cut 830 of 1500 bytes from the middle by a 1024-byte cap; kept a 502-byte head and a 168-byte tail. The full text is not in this transcript: re-run tool 'alpha' (call a1) with narrower arguments to fetch it."
        );
        expect(turn.committedBytes()).toBe(968);

        const b = turn.commit('b'.repeat(1500), { source: { name: 'beta', callId: 'b2' } });
        expect(envelopeOf(b.content).budgetBytes).toBe(1024);
        expect(turn.committedBytes()).toBe(1935);

        const c = turn.commit('c'.repeat(100), { source: { name: 'gamma', callId: 'c3' } });
        expect(c).toEqual({ content: 'c'.repeat(100), truncated: false, originalBytes: 100 });
        expect(turn.committedBytes()).toBe(2035);

        const d = turn.commit('d'.repeat(1500), { source: { name: 'delta', callId: 'd4' } });
        const spilled = envelopeOf(d.content);
        expect(spilled.budgetBytes).toBe(512);
        expect(spilled.note).toBe(
            "Cut 1342 of 1500 bytes from the middle by a 512-byte budget set by this turn's 2048-byte per-turn cap; kept a 118-byte head and a 40-byte tail. The full text is not in this transcript: re-run tool 'delta' (call d4) with narrower arguments to fetch it."
        );
        // The spill is what fits; the window overshoots by less than one envelope,
        // which is the soft-bound rule stated in the module header.
        expect(utf8ByteLength(d.content)).toBe(499);
        expect(turn.committedBytes()).toBe(2534);
        expect(turn.committedBytes() - 2048).toBeLessThan(600);
    });

    it('never refuses a result, because pairing requires an answer for every call', () => {
        // Three full-size results in one default-sized window: two fit whole, and the
        // third is still delivered — spilled, never dropped.
        const turn = createToolResultTurnBudget();
        const full = 'r'.repeat(MODEL_TOOL_RESULT_BUDGET_BYTES);

        expect(turn.commit(full).truncated).toBe(false);
        expect(turn.commit(full).truncated).toBe(false);
        expect(turn.committedBytes()).toBe(MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES);

        const third = turn.commit('t'.repeat(3_000), { source: { name: 'tail', callId: 't3' } });

        expect(third.truncated).toBe(true);
        expect(third.originalBytes).toBe(3_000);
        expect(envelopeOf(third.content).budgetBytes).toBe(512);
        expect(utf8ByteLength(third.content)).toBe(500);
        // The window is over by one envelope and nothing more.
        expect(turn.committedBytes()).toBe(524_788);
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
            expect(turn.committedBytes()).toBe(959);
        }
    });

    it('honours a caller-supplied per-result cap below the aggregate', () => {
        // A tool that budgets its own output (read, grep) passes its own cap; the
        // aggregate still applies on top of it.
        const turn = createToolResultTurnBudget(4_000, 10_000);
        const capped = turn.commit('k'.repeat(1_500), { budgetBytes: 700 });

        expect(envelopeOf(capped.content).budgetBytes).toBe(700);
        expect(utf8ByteLength(capped.content)).toBeLessThanOrEqual(700);
        expect(turn.committedBytes()).toBe(658);
    });
});
