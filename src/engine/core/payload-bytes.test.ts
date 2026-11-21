// The two byte measures behind every model-facing budget (T3).
//
// WHY THIS FILE EXISTS. A declared budget is only worth the bytes it actually bounds,
// and a tool result does not reach the model as raw text: it becomes the `content` of
// a transcript message, and the transcript is SERIALIZED. The provider bills the
// serialized form, so a budget measured on the text's own bytes silently under-states
// every result that contains quotes, backslashes or newlines — the drift is
// per-result, permanent, and invisible (the ledger reported "within budget" the whole
// time). These tests pin the two measures separately so the budget can never be
// silently re-pointed at the cheaper one:
//
//   - `utf8ByteLength`    — what the TOOL's text costs. Used only for the numbers an
//                           envelope QUOTES ("cut 64071 of 300000 bytes") and for
//                           per-file sizes the caller can diff against the file.
//   - `modelPayloadBytes` — what the same text costs ONCE SERIALIZED into the request.
//                           This is the currency every budget is measured in.
//
// The oracle for `modelPayloadBytes` is the byte length of the string as JSON puts it
// on the wire, minus its two wrapping quotes. That identity is asserted for every
// escape class below, and the exact numbers are pinned next to it: an implementation
// that drifts on one class (a lone surrogate, a C1 control, a non-BMP pair) fails here
// rather than showing up as context drift in a live session.

import { describe, expect, it } from 'vitest';
// Imported from the module, not from `@underload/harness`: the published root barrel
// (`src/index.ts`) only re-exports what `src/harness.ts` names explicitly, and
// `modelPayloadBytes` is not in that list yet (reported as a one-line follow-up in
// harness.ts, which another worker owns). `src/core/index.ts` does export it.
import { modelPayloadBytes, utf8ByteLength } from './payload-bytes';

// The definition of the currency: bytes of the JSON string literal, quotes excluded.
// Pinning the oracle (rather than only the numbers) keeps a future rewrite honest.
const wireBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;

describe('utf8ByteLength', () => {
    it('counts UTF-8 bytes, never code units or code points', () => {
        // Exact per class: 1 byte ASCII, 2 bytes Latin-1 supplement, 3 bytes CJK,
        // 4 bytes for a surrogate PAIR, and control characters cost 1 (they are only
        // inflated by JSON escaping, which is the other measure's job).
        expect(utf8ByteLength('')).toBe(0);
        expect(utf8ByteLength('abc')).toBe(3);
        expect(utf8ByteLength('é')).toBe(2);
        expect(utf8ByteLength('世')).toBe(3);
        expect(utf8ByteLength('😀')).toBe(4);
        expect(utf8ByteLength('\n')).toBe(1);
        expect(utf8ByteLength('"')).toBe(1);
        expect(utf8ByteLength('\\')).toBe(1);
    });

    it('counts an unpaired surrogate as its CESU-8-style 3 bytes', () => {
        // A lone surrogate is not a character, and `Buffer.byteLength` encodes it as
        // U+FFFD-replacement would (3 bytes). Pinned so the difference against the
        // serialized measure below is visible rather than implied.
        expect(utf8ByteLength('\ud800')).toBe(3);
        expect(utf8ByteLength('a\ud800b\udc00c')).toBe(9);
    });

    it('is exact on a realistic mixed window', () => {
        const text = 'path/to/file.ts\nconst x = "a\\nb";\n';

        expect(utf8ByteLength(text)).toBe(34);
    });
});

describe('modelPayloadBytes', () => {
    it('equals the byte length of the serialized string for every escape class', () => {
        const corpus = [
            '',
            'hello world 123',
            '!@#$%^&*()[]{}<>/?:;,.=-+_~`|',
            'say "hi" and \'bye\'',
            'C:\\tmp\\n',
            'a\nb\r\nc\td',
            'a\u0007b\u0008c\u000cd',
            '\u0000\u0001\u001f x',
            `a${String.fromCharCode(0x7f)}b`,
            `${String.fromCharCode(0x80)}${String.fromCharCode(0x9f)}`,
            'é',
            '世界',
            'مرحبا שלום',
            '😀',
            '👨‍👩‍👧',
            '\ud800',
            '\udc00',
            'a\ud800b\udc00c',
            'a\u2028b\u2029c',
            'a\uFEFFb\u00A0c',
            'é̂᷄',
            'path/to/file.ts\nconst x = "a\\nb";\n'
        ];

        // The oracle, per class, exactly — not a range and not a sample.
        for (const value of corpus) {
            expect(modelPayloadBytes(value), JSON.stringify(value)).toBe(wireBytes(value));
        }
    });

    it('charges the escapes JSON actually produces, one class at a time', () => {
        // Exact numbers for each rule, so a change to one rule cannot hide behind a
        // matching oracle over a corpus that happens not to cover it.
        expect(modelPayloadBytes('')).toBe(0);
        expect(modelPayloadBytes('hello')).toBe(5);
        expect(modelPayloadBytes('say "hi" and \'bye\'')).toBe(20); // two `"` -> `\"`
        expect(modelPayloadBytes('C:\\tmp\\n')).toBe(10); // two `\` -> `\\`
        expect(modelPayloadBytes('a\nb\r\nc\td')).toBe(12); // \n \r \t are 2 bytes each
        expect(modelPayloadBytes('a\u0007b\u0008c\u000cd')).toBe(14); // \u0007, \b, \f
        expect(modelPayloadBytes('\u0000\u0001\u001f x')).toBe(20); // \u00XX = 6 bytes
    });

    it('does NOT inflate non-ASCII, which JSON leaves as it is', () => {
        // The over-counting trap: `é` is NOT serialized as `\u00e9`. If this ever
        // regresses to a per-character upper bound, every multibyte tool result is
        // charged 3x what it costs and the model loses real window.
        expect(modelPayloadBytes('é')).toBe(2);
        expect(modelPayloadBytes('世界')).toBe(6);
        expect(modelPayloadBytes('مرحبا שלום')).toBe(19);
        expect(modelPayloadBytes('😀')).toBe(4);
        expect(modelPayloadBytes('👨‍👩‍👧')).toBe(18);
        expect(modelPayloadBytes('a\u2028b\u2029c')).toBe(9);
        expect(modelPayloadBytes('a\uFEFFb\u00A0c')).toBe(8);
        expect(modelPayloadBytes(`${String.fromCharCode(0x80)}${String.fromCharCode(0x9f)}`)).toBe(4);
        expect(modelPayloadBytes(`a${String.fromCharCode(0x7f)}b`)).toBe(3);
    });

    it('charges a lone surrogate as the 6-byte escape it is written as', () => {
        // A lone surrogate cannot be encoded in UTF-8, so JSON writes `\ud800`: 6 wire
        // bytes for 3 counted by `utf8ByteLength`. Text chunks that are sliced without
        // respecting surrogate pairs (a mid-line cut, a truncated head preview) land
        // here, which is why the measure cannot assume a maximum of 4 bytes per unit.
        expect(modelPayloadBytes('\ud800')).toBe(6);
        expect(modelPayloadBytes('\udc00')).toBe(6);
        expect(modelPayloadBytes('a\ud800b\udc00c')).toBe(15);
    });

    it('is never below the raw byte length, and is above it exactly when escaping fires', () => {
        const plain = 'plain ascii only';
        const escaped = 'a "quoted" line\nand a backslash \\ here';

        expect(modelPayloadBytes(plain)).toBe(utf8ByteLength(plain));
        expect(modelPayloadBytes(escaped)).toBe(42);
        expect(utf8ByteLength(escaped)).toBe(38);
        expect(modelPayloadBytes('é'.repeat(200))).toBe(400);
        expect(utf8ByteLength('é'.repeat(200))).toBe(400);
    });

    it('is exact on the mixed content a real tool result carries', () => {
        // 5000 ascii + 500 quotes + 500 newlines + one of each multibyte class and a
        // lone surrogate: 6016 raw bytes reach the provider as 7024, i.e. a 1.167x
        // factor on ordinary content. This is the number a budget must be measured in.
        const text = `${'x'.repeat(5_000)}${'"'.repeat(500)}${'\n'.repeat(500)}é世界😀\ud800\u0000`;

        expect(utf8ByteLength(text)).toBe(6_016);
        expect(modelPayloadBytes(text)).toBe(7_024);
        expect(modelPayloadBytes(text)).toBe(wireBytes(text));
    });
});
