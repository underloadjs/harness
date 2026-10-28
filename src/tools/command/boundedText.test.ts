// BoundedText — the shared capped UTF-8 capture behind commandRun, gitDiff, and
// the Python syntax checker.
//
// What this pins, exactly:
//   - the cap is enforced on BYTES, not UTF-16 code units;
//   - a codepoint split across chunks is decoded once the rest arrives (no
//     per-chunk `toString` corruption);
//   - filling the cap exactly is NOT truncation, but any byte after it is;
//   - a cut inside a multi-byte sequence flushes one U+FFFD at end();
//   - chunks after the cap are dropped, so the string never grows past it.

import { describe, expect, it } from 'vitest';
import { BoundedText, COMMAND_STDERR_MAX_BYTES, COMMAND_STDOUT_MAX_BYTES } from './boundedText';

describe('BoundedText', () => {
    it('captures small buffers exactly', () => {
        const text = new BoundedText(16);

        text.write(Buffer.from('hello '));
        text.write(Buffer.from('world'));

        expect(text.end()).toBe('hello world');
        expect(text.truncated).toBe(false);
    });

    it('decodes a codepoint split across chunks', () => {
        const text = new BoundedText(16);

        // U+20AC EURO SIGN is E2 82 AC: the first chunk is an incomplete sequence.
        text.write(Buffer.from([0xe2, 0x82]));
        text.write(Buffer.from([0xac]));

        expect(text.end()).toBe('€');
        expect(text.truncated).toBe(false);
    });

    it('keeps the head and flags a single chunk larger than the cap', () => {
        const text = new BoundedText(4);

        text.write(Buffer.from('abcde'));

        expect(text.end()).toBe('abcd');
        expect(text.truncated).toBe(true);
    });

    it('keeps the head across chunks that cross the cap', () => {
        const text = new BoundedText(4);

        text.write(Buffer.from('ab'));
        text.write(Buffer.from('cde'));
        text.write(Buffer.from('fgh'));

        expect(text.end()).toBe('abcd');
        expect(text.truncated).toBe(true);
    });

    it('does not flag an exactly-filled cap until more bytes arrive', () => {
        const text = new BoundedText(4);

        text.write(Buffer.from('abcd'));

        // Exactly at the cap: complete, not truncated.
        expect(text.truncated).toBe(false);

        text.write(Buffer.from('e'));

        expect(text.end()).toBe('abcd');
        expect(text.truncated).toBe(true);
    });

    it('ignores empty chunks after the cap without flagging truncation', () => {
        const text = new BoundedText(1);

        text.write(Buffer.from('a'));
        text.write(Buffer.alloc(0));

        expect(text.end()).toBe('a');
        expect(text.truncated).toBe(false);
    });

    it('caps bytes rather than code units', () => {
        // Two 'é' (two bytes each); a two-byte cap keeps exactly one of them.
        const text = new BoundedText(2);

        text.write(Buffer.from('éé'));

        expect(text.end()).toBe('é');
        expect(text.truncated).toBe(true);
    });

    it('flushes one replacement character when the cut splits a codepoint', () => {
        const text = new BoundedText(2);

        text.write(Buffer.from('€'));

        expect(text.end()).toBe('\uFFFD');
        expect(text.truncated).toBe(true);
    });

    it('rejects a non-positive cap', () => {
        expect(() => new BoundedText(0)).toThrow(RangeError);
        expect(() => new BoundedText(-1)).toThrow(RangeError);
        expect(() => new BoundedText(Number.NaN)).toThrow(RangeError);
    });

    it('exposes the command-tool caps', () => {
        expect(COMMAND_STDOUT_MAX_BYTES).toBe(128 * 1024);
        expect(COMMAND_STDERR_MAX_BYTES).toBe(16 * 1024);
    });
});
