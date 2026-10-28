// BoundedText — incremental UTF-8 capture with a hard BYTE cap.
//
// Why a class instead of `text += chunk.toString()`:
//   - a Buffer chunk is not a character-aligned slice, so `toString('utf8')` per
//     chunk corrupts any multi-byte codepoint that straddles two chunks. A
//     StringDecoder holds the partial sequence until the next chunk (or end())
//     completes it;
//   - a command can emit unbounded output; appending forever would burn memory
//     for a string no model can read. The cap is enforced on the BYTES actually
//     captured, and the tail is dropped (head-kept), so whole early lines survive.
//
// Truncation edge: when the cap falls inside a multi-byte sequence, the kept bytes
// are an incomplete sequence and end() flushes one U+FFFD replacement character.
// The captured text can therefore be one character longer than the byte cap.
//
// Consumers:
//   - ./commandRun   — 128 KiB stdout, 16 KiB stderr
//   - ./gitDiff      — 128 KiB stdout, 16 KiB stderr
//   - ../syntax/python — 8 KiB stderr diagnostics

import { StringDecoder } from 'node:string_decoder';

// Shared output caps for the command tools. 128 KiB is far more than a model can
// use in one turn; 16 KiB keeps a wall of diagnostics from dominating the result.
export const COMMAND_STDOUT_MAX_BYTES = 128 * 1024;
export const COMMAND_STDERR_MAX_BYTES = 16 * 1024;

export class BoundedText {
    // Decodes complete UTF-8 sequences only; holds an incomplete tail between
    // writes so a chunk boundary never becomes a replacement character.
    private readonly decoder = new StringDecoder('utf8');

    // Captured output so far, and how many bytes it came from.
    private text = '';
    private captured = 0;

    // True once a chunk was cut at the cap (or any byte arrived after it was
    // full). Never reset: truncation is a fact about the stream.
    private truncatedFlag = false;

    // True once the cap has been reached; later chunks are dropped unread so the
    // string cannot grow past the cap. Kept separate from `truncatedFlag` because
    // filling the cap exactly is not truncation.
    private full = false;

    constructor(private readonly maxBytes: number) {
        // A non-positive or non-finite cap would make every stream look truncated
        // and no output captureable; callers pass a positive constant.
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            throw new RangeError(`BoundedText requires a positive byte cap; received ${String(maxBytes)}.`);
        }
    }

    get truncated(): boolean {
        return this.truncatedFlag;
    }

    // Feed one raw chunk from a child process stream.
    write(chunk: Buffer): void {
        if (this.full) {
            // The cap was reached earlier. Any further byte is beyond it, so the
            // stream is truncated even though nothing is appended.
            if (chunk.length > 0) this.truncatedFlag = true;
            return;
        }

        const remaining = this.maxBytes - this.captured;

        if (chunk.length > remaining) {
            // Keep the head of the chunk, drop the rest.
            this.truncatedFlag = true;

            if (remaining > 0) {
                this.decode(chunk.subarray(0, remaining));
            }

            this.full = true;
            return;
        }

        this.decode(chunk);

        // Landing exactly on the cap is not truncation yet; the next write marks
        // it if more bytes follow.
        if (this.captured >= this.maxBytes) this.full = true;
    }

    // Finish decoding and return the captured text. Call exactly once, from the
    // stream's close handler, so a held partial sequence is flushed.
    end(): string {
        const tail = this.decoder.end();

        if (tail.length > 0) this.text += tail;

        return this.text;
    }

    private decode(slice: Buffer): void {
        this.captured += slice.length;
        this.text += this.decoder.write(slice);
    }
}
