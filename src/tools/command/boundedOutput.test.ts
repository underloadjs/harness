// BoundedOutput — the head+tail capture behind ./shell.
//
// What this pins, exactly:
//   - under the cap the stream is returned whole, with no marker and no flags;
//   - filling the cap EXACTLY is not truncation, matching ./boundedText;
//   - over the cap BOTH ends survive: the first `headKeep` bytes and the last
//     `tailKeep` bytes, and the middle is gone;
//   - the in-band marker names the exact byte count `droppedBytes` reports, so the
//     text and the metadata cannot disagree;
//   - the tail is a ring, so a chunk larger than the window keeps its own END
//     (the regression this class exists for: a head-kept cap lost the verdict);
//   - bytes, not code units; a cut at a codepoint boundary trims rather than
//     emitting a lone U+FFFD on either side of the marker;
//   - a codepoint split across chunks is decoded whole, because nothing is decoded
//     until end();
//   - the head/tail split is configurable, and a bad cap or head window throws.

import { describe, expect, it } from 'vitest';
import { BoundedOutput, omissionMarker } from './boundedOutput';

// An explicit head/tail split, so the expected strings below are literal rather
// than derived from the default ratio.
const split = (maxBytes: number, headBytes: number): BoundedOutput => new BoundedOutput(maxBytes, headBytes);

describe('BoundedOutput', () => {
    it('returns a short stream whole with no marker', () => {
        const text = new BoundedOutput(16);

        text.write(Buffer.from('hello '));
        text.write(Buffer.from('world'));

        expect(text.end()).toBe('hello world');
        expect(text.truncated).toBe(false);
        expect(text.totalBytes).toBe(11);
        expect(text.droppedBytes).toBe(0);
    });

    it('does not flag an exactly-filled cap until more bytes arrive', () => {
        const text = new BoundedOutput(4);

        text.write(Buffer.from('abcd'));

        // Exactly at the cap: complete, not truncated — the same rule ./boundedText
        // follows, so a stream that lands on the limit reads as whole.
        expect(text.truncated).toBe(false);
        expect(text.end()).toBe('abcd');

        text.write(Buffer.from('e'));

        expect(text.truncated).toBe(true);
    });

    it('keeps both ends and marks the middle as omitted', () => {
        const text = split(8, 2);

        text.write(Buffer.from('0123456789AB'));

        // 12 bytes in, cap 8: 2 from the front, the LAST 6 from the back, 4 replaced.
        expect(text.end()).toBe(`01\n${omissionMarker(4)}\n6789AB`);
        expect(text.truncated).toBe(true);
        expect(text.totalBytes).toBe(12);
        expect(text.droppedBytes).toBe(4);
    });

    it('keeps the END of a single chunk larger than the whole cap', () => {
        // The defect this class fixes: a head-kept cap returned the first 128 KiB
        // of a build log and threw away the `BUILD FAILED` line at the end.
        const text = split(8, 2);

        text.write(Buffer.from(`${'a'.repeat(20)}AA`));

        expect(text.end().endsWith('AA')).toBe(true);
        expect(text.end().startsWith('aa')).toBe(true);
        expect(text.totalBytes).toBe(22);
        expect(text.droppedBytes).toBe(14);
    });

    it('keeps the END across many chunks, including one that wraps the ring', () => {
        const text = split(10, 2);

        for (const part of ['01', '23', '45', '67', '89', 'ab', 'cd']) text.write(Buffer.from(part));

        // 14 bytes: head "01", then the ring overwrites itself twice and the last
        // 8 bytes are still "6789abcd" in stream order.
        expect(text.end()).toBe(`01\n${omissionMarker(4)}\n6789abcd`);
    });

    it('splits the default cap 1/4 head and 3/4 tail', () => {
        const text = new BoundedOutput(16);

        text.write(Buffer.from('x'.repeat(100)));

        const [head, marker, tail] = text.end().split('\n');

        expect(head).toHaveLength(4);
        expect(tail).toHaveLength(12);
        expect(marker).toBe(omissionMarker(84));
    });

    it('caps bytes rather than code units', () => {
        // 'a' plus three 3-byte codepoints = 10 bytes against a 6-byte cap.
        const text = split(6, 2);

        text.write(Buffer.from('a\u20AC\u20AC\u20AC'));

        expect(text.totalBytes).toBe(10);
        expect(text.truncated).toBe(true);
    });

    it('trims a codepoint split by the head cut instead of emitting U+FFFD', () => {
        // Cap 6, head 3: the head window ends mid-sequence (E2), which belongs to
        // the omitted middle, so it is dropped rather than decoded as garbage.
        const text = split(6, 3);

        text.write(Buffer.from(`ab${'\u20AC'.repeat(3)}`));

        expect(text.end()).not.toContain('\uFFFD');
        expect(text.end().startsWith('ab')).toBe(true);
    });

    it('trims a codepoint split by the tail cut instead of emitting U+FFFD', () => {
        // Head 0, tail 6: a tail window that starts on continuation bytes would
        // decode them alone as a replacement character.
        const text = split(6, 0);

        text.write(Buffer.from('\u20AC'.repeat(4)));

        expect(text.end()).not.toContain('\uFFFD');
        expect(text.end().endsWith('\u20AC\u20AC')).toBe(true);
    });

    it('decodes a codepoint split across chunks whole', () => {
        const text = new BoundedOutput(16);

        // U+20AC EURO SIGN is E2 82 AC: the first chunk is an incomplete sequence,
        // and nothing is decoded until end(), so it cannot be mangled.
        text.write(Buffer.from([0xe2, 0x82]));
        text.write(Buffer.from([0xac]));

        expect(text.end()).toBe('\u20AC');
        expect(text.truncated).toBe(false);
    });

    it('ignores empty chunks', () => {
        const text = new BoundedOutput(4);

        text.write(Buffer.alloc(0));
        text.write(Buffer.from('abc'));

        expect(text.end()).toBe('abc');
        expect(text.truncated).toBe(false);
    });

    it('reports a zero-byte head window as a marker that starts the text', () => {
        const text = split(4, 0);

        text.write(Buffer.from('abcdefg'));

        expect(text.end()).toBe(`${omissionMarker(3)}\ndefg`);
    });

    it('is repeatable and side-effect free', () => {
        const text = split(8, 2);

        text.write(Buffer.from('0123456789AB'));

        const first = text.end();
        const [head, , tail] = first.split('\n');

        expect(text.end()).toBe(first);
        expect(text.droppedBytes).toBe(4);
        expect(text.keptBytes).toBe(Buffer.byteLength(head) + Buffer.byteLength(tail));
    });

    it('rejects a non-positive cap and a bad head window', () => {
        expect(() => new BoundedOutput(0)).toThrow(RangeError);
        expect(() => new BoundedOutput(-1)).toThrow(RangeError);
        expect(() => new BoundedOutput(Number.NaN)).toThrow(RangeError);
        expect(() => split(8, -1)).toThrow(RangeError);
        expect(() => split(8, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('never starves the tail, whatever head window is asked for', () => {
        // A head window at or past the cap would leave no room for the end, which
        // is the half this class exists to keep.
        const text = split(8, 99);

        text.write(Buffer.from('abcdefghij'));

        expect(text.end().endsWith('j')).toBe(true);
        expect(text.end().startsWith('abcdefg')).toBe(true);
    });

    it('names the omitted count in the marker', () => {
        expect(omissionMarker(1)).toBe('[... 1 byte omitted ...]');
        expect(omissionMarker(1842331)).toBe('[... 1842331 bytes omitted ...]');
    });
});
