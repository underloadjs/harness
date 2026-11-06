// boundToolResult — the global model-facing tool-result budget (R10).
//
// The contract pinned here:
//   - the default budget is 256 KiB of UTF-8;
//   - a result at or under the budget is returned BYTE-EXACT (no marker, no
//     re-encoding), which is what keeps every existing tool result unchanged;
//   - an over-budget result becomes a small, VALID JSON envelope that names the
//     truncation, the original size, the applied budget, and as much of the
//     beginning as fits;
//   - a multi-byte character is never split in half.

import { describe, expect, it } from 'vitest';
import { MODEL_TOOL_RESULT_BUDGET_BYTES, boundToolResult, utf8ByteLength } from '@underload/harness';

describe('boundToolResult', () => {
    it('budgets 256 KiB by default and returns a small result byte-exact', () => {
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

    it('leaves a result exactly at the budget untouched', () => {
        const exact = 'x'.repeat(100);

        expect(boundToolResult(exact, 100)).toEqual({ content: exact, truncated: false, originalBytes: 100 });

        // One byte over the budget IS truncated, so the boundary is inclusive.
        expect(boundToolResult('x'.repeat(101), 100).truncated).toBe(true);
    });

    it('wraps an over-budget result in an exact, valid truncation envelope', () => {
        const bounded = boundToolResult('y'.repeat(1000), 200);

        // The envelope's fixed overhead is 70 bytes, so a 200-byte budget keeps
        // 130 characters. Exact, not approximate: the same input always yields
        // this string.
        expect(bounded).toEqual({
            content: `{"truncated":true,"originalBytes":1000,"budgetBytes":200,"content":"${'y'.repeat(130)}"}`,
            truncated: true,
            originalBytes: 1000
        });

        // Valid JSON, so a model (or a client) can parse the marker.
        expect(JSON.parse(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 1000,
            budgetBytes: 200,
            content: 'y'.repeat(130)
        });
    });

    it('caps a huge result at the default 256 KiB', () => {
        const bounded = boundToolResult('z'.repeat(300_000));

        expect(bounded.truncated).toBe(true);
        expect(bounded.originalBytes).toBe(300_000);
        // 262144 * 0.9 floored is the first prefix that fits under the cap.
        expect(JSON.parse(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 300_000,
            budgetBytes: 262_144,
            content: 'z'.repeat(235_929)
        });
        expect(utf8ByteLength(bounded.content)).toBe(236_004);
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

    it('never splits a multi-byte character', () => {
        const bounded = boundToolResult('é'.repeat(100), 120);

        // 100 é is 200 bytes: over the 120-byte budget. 25 characters fit
        // (69-byte overhead + 50 bytes), and no lone surrogate/partial UTF-8
        // sequence is emitted.
        expect(JSON.parse(bounded.content)).toEqual({
            truncated: true,
            originalBytes: 200,
            budgetBytes: 120,
            content: 'é'.repeat(25)
        });
        expect(utf8ByteLength(bounded.content)).toBe(119);
    });

    it('measures bytes, not code units', () => {
        expect(utf8ByteLength('abc')).toBe(3);
        expect(utf8ByteLength('é')).toBe(2);
        expect(utf8ByteLength('😀')).toBe(4);
    });
});
