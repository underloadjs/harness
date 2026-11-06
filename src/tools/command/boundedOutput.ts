// BoundedOutput — incremental capture that keeps the HEAD *and* the TAIL.
//
// WHY THIS EXISTS NEXT TO ./boundedText
// -------------------------------------
// `BoundedText` is head-kept, which is the right policy for a DIFF (gitDiff reads
// it top-down, and the `diff --git`/`index` header lines are the useful part) and
// for a diagnostic blob (python syntax stderr). It is the wrong policy for a
// COMMAND: the commands that actually overflow are builds, test runners and
// installers, and those print their verdict LAST — `npm test` ends with the
// failure summary, `tsc` ends with the error count, `dotnet build` ends with
// `Build FAILED`. A head-only cap therefore returns 128 KiB of the least useful
// part and throws away the one line the model needed, with nothing in the text
// saying a cut happened.
//
// So this class keeps a head window and a tail window and splices an explicit
// in-band marker between them:
//
//     line 1 … line 4268
//     [... 1842331 bytes omitted ...]
//     line 7996 … line 7999
//
// The default split is 1/4 head + 3/4 tail: enough of the beginning to identify
// what ran, most of the budget spent on the end where the answer is.
//
// DESIGN NOTES
//   - bytes, not characters: the cap is enforced on raw BYTES, and the two windows
//     are Buffers, so memory is bounded by `maxBytes` regardless of how much the
//     command prints (a 13 MB `npm test` log costs 128 KiB here);
//   - chunk boundaries are irrelevant, because nothing is decoded until end().
//     A UTF-8 sequence split across two 'data' events is whole by the time it is
//     decoded, which is the corruption `BoundedText` needed a StringDecoder to
//     avoid — here it cannot happen at all;
//   - a cut that lands INSIDE a multi-byte sequence is trimmed at the boundary
//     rather than emitting a lone U+FFFD: the marker already explains that bytes
//     are missing, so a replacement character would be noise claiming the stream
//     was corrupt when it was not;
//   - filling the cap exactly is NOT truncation (`total > maxBytes` is), matching
//     `BoundedText`, so a stream that lands on the limit reads as complete;
//   - the marker's own bytes are NOT counted against the cap, so a truncated
//     string can be slightly longer than `maxBytes`. `totalBytes`/`droppedBytes`
//     give the exact accounting either way.
//
// Consumers:
//   - ./shell — 128 KiB stdout, 16 KiB stderr, both head+tail.
//
// ./boundedText stays the head-kept policy for ./gitDiff and ../syntax/python.

// The share of the cap spent on the beginning of the stream when the caller does
// not say otherwise. A command's first lines name what it ran; its last lines say
// whether it worked, and "whether it worked" is the part worth more bytes.
const DEFAULT_HEAD_SHARE = 4;

// In-band marker between the two windows. ASCII on purpose: it is spliced into
// captured process output that a model may grep, so it must survive any codepage.
export const omissionMarker = (droppedBytes: number): string =>
    `[... ${droppedBytes} byte${droppedBytes === 1 ? '' : 's'} omitted ...]`;

// Drop a trailing incomplete UTF-8 sequence. Only the last three bytes can start
// one, and a lead byte at `i` needs `need` bytes total; if they are not there the
// sequence belongs to the omitted middle. When the window holds only continuation
// bytes the sequence started at least four bytes back and is therefore whole.
const trimIncompleteTail = (buffer: Buffer): Buffer => {
    for (let index = buffer.length - 1; index >= 0 && index >= buffer.length - 3; index -= 1) {
        const byte = buffer[index] as number;

        if ((byte & 0xc0) === 0x80) continue;

        const need = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : 4;

        return buffer.length - index >= need ? buffer : buffer.subarray(0, index);
    }

    return buffer;
};

// Drop leading continuation bytes: they are the tail of a sequence that lived in
// the omitted middle, and decoding them alone would emit a replacement character.
const trimIncompleteHead = (buffer: Buffer): Buffer => {
    let start = 0;

    while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) start += 1;

    return buffer.subarray(start);
};

export class BoundedOutput {
    // Bytes of the cap reserved for the beginning; the rest go to the end.
    private readonly headKeep: number;
    private readonly tailKeep: number;

    // The two windows. `tailStart` is the ring write position once the tail is
    // full; while it is still filling, the data sits contiguously at [0, tailFilled).
    private readonly headBuffer: Buffer;
    private readonly tailBuffer: Buffer;
    private headFilled = 0;
    private tailFilled = 0;
    private tailStart = 0;

    // Every byte that arrived, capped or not. This is what `totalBytes` reports:
    // the size the stream really was, which the model cannot infer from the text.
    private total = 0;

    constructor(
        private readonly maxBytes: number,
        headBytes?: number
    ) {
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
            throw new RangeError(`BoundedOutput requires a positive byte cap; received ${String(maxBytes)}.`);
        }

        const requested = headBytes === undefined ? Math.floor(maxBytes / DEFAULT_HEAD_SHARE) : headBytes;

        if (!Number.isFinite(requested) || requested < 0) {
            throw new RangeError(
                `BoundedOutput requires a non-negative head window; received ${String(headBytes)}.`
            );
        }

        // The tail must keep at least one byte, or a truncated stream would lose
        // its ending and the whole point of this class.
        this.headKeep = Math.min(Math.floor(requested), Math.max(maxBytes - 1, 0));
        this.tailKeep = maxBytes - this.headKeep;

        this.headBuffer = Buffer.allocUnsafe(this.headKeep);
        this.tailBuffer = Buffer.allocUnsafe(this.tailKeep);
    }

    // True once the stream passed the cap. Filling it exactly is not truncation.
    get truncated(): boolean {
        return this.total > this.maxBytes;
    }

    // Total bytes the stream produced, before any cap.
    get totalBytes(): number {
        return this.total;
    }

    // Bytes the in-band marker replaced. Zero unless `truncated`.
    get droppedBytes(): number {
        return this.total - this.keptBytes;
    }

    // Bytes that actually reach the returned text (the two windows minus any
    // boundary bytes trimmed away to keep UTF-8 whole).
    get keptBytes(): number {
        const [head, tail] = this.trimmedWindows();

        return head.length + tail.length;
    }

    // Feed one raw chunk from a child process stream.
    write(chunk: Buffer): void {
        if (chunk.length === 0) return;

        this.total += chunk.length;

        let slice = chunk;

        if (this.headFilled < this.headKeep) {
            const take = Math.min(slice.length, this.headKeep - this.headFilled);

            slice.copy(this.headBuffer, this.headFilled, 0, take);
            this.headFilled += take;
            slice = slice.subarray(take);
        }

        if (slice.length > 0) this.appendTail(slice);
    }

    // Assemble head + marker + tail. Repeatable and side-effect free, so the
    // accounting getters read the same numbers before or after it.
    end(): string {
        const [head, tail] = this.trimmedWindows();

        if (this.total <= this.maxBytes) {
            return Buffer.concat([head, tail]).toString('utf8');
        }

        // The marker's count is the same number `droppedBytes` reports, so the text
        // and the metadata cannot disagree about how much is missing.
        const marker = omissionMarker(this.total - head.length - tail.length);

        // No stray newline on either side when a window is empty (a caller that
        // asks for a zero-byte head gets a marker that starts the text).
        if (head.length === 0) return `${marker}\n${tail.toString('utf8')}`;
        if (tail.length === 0) return `${head.toString('utf8')}\n${marker}`;

        return `${head.toString('utf8')}\n${marker}\n${tail.toString('utf8')}`;
    }

    // Circular append. A chunk at least as large as the window replaces it whole
    // (only its last bytes can still be the stream's end); otherwise it lands at
    // the write position and wraps.
    private appendTail(slice: Buffer): void {
        if (slice.length >= this.tailKeep) {
            slice.subarray(slice.length - this.tailKeep).copy(this.tailBuffer, 0);
            this.tailStart = 0;
            this.tailFilled = this.tailKeep;

            return;
        }

        if (this.tailFilled < this.tailKeep) {
            // Only the room that is left fits contiguously; the rest of the chunk
            // belongs at the start of the now-full ring. Copying it whole would let
            // Buffer.copy silently drop the overflow.
            const room = this.tailKeep - this.tailFilled;
            const take = Math.min(slice.length, room);

            slice.copy(this.tailBuffer, this.tailFilled, 0, take);
            this.tailFilled += take;

            if (take < slice.length) this.appendTail(slice.subarray(take));

            return;
        }

        const first = Math.min(this.tailKeep - this.tailStart, slice.length);

        slice.copy(this.tailBuffer, this.tailStart, 0, first);

        if (slice.length > first) slice.copy(this.tailBuffer, 0, first);

        this.tailStart = (this.tailStart + slice.length) % this.tailKeep;
    }

    // The two windows exactly as `end()` will decode them. Under the cap the split
    // is irrelevant and they concatenate to the whole stream; over it, each side is
    // trimmed to a codepoint boundary so neither half can emit a lone U+FFFD.
    private trimmedWindows(): [Buffer, Buffer] {
        if (this.total <= this.maxBytes) return [this.headView(), this.tailView()];

        return [trimIncompleteTail(this.headView()), trimIncompleteHead(this.tailView())];
    }

    private headView(): Buffer {
        return this.headBuffer.subarray(0, this.headFilled);
    }

    // The tail window in stream order: contiguous while it is still filling,
    // wrapped once it is full.
    private tailView(): Buffer {
        if (this.tailFilled < this.tailKeep) return this.tailBuffer.subarray(0, this.tailFilled);

        return this.tailStart === 0
            ? this.tailBuffer
            : Buffer.concat([this.tailBuffer.subarray(this.tailStart), this.tailBuffer.subarray(0, this.tailStart)]);
    }
}
