// The ONE byte measure every model-facing budget has to use (T3).
//
// WHY THIS EXISTS
// ---------------
// A budget is only a budget if it counts the thing the provider charges for. Two
// different counts exist for the same tool result, and the harness was enforcing the
// cheaper one:
//
//   - the TEXT's own UTF-8 bytes (`utf8ByteLength`);
//   - the bytes that string occupies INSIDE the request body, i.e. after JSON
//     escaping (`modelPayloadBytes`).
//
// A tool result becomes `HarnessMessage.content`, and `content` is serialized as a
// JSON string, so the second number is the one that is billed. They differ by the
// escapes JSON adds: `"` and `\` double, every control character becomes `\u00XX`
// (6 bytes), and a lone surrogate becomes `\udXXX` (6 bytes). Measured on the run
// this module was added for: a 245,616-byte `read` transcript message reached the
// wire at 257,074 bytes (+4.6%), and a quote/backslash-heavy file cost +4.8%. A cap
// measured on the first number therefore overshot the wire by exactly that much,
// which is the gap this file closes.
//
// WHY NOT `Buffer.byteLength(JSON.stringify(value)) - 2`
// ------------------------------------------------------
// It is exactly right and it allocates a second copy of a string that is already
// megabytes large, per result, per budget check, inside a shrink loop. This walk is
// the same arithmetic `JSON.stringify` performs (verified byte-for-byte against it in
// `payload-bytes.test.ts`, including lone surrogates, which ES2019 stringify escapes
// rather than emitting raw), for one pass and zero allocation.
//
// WHAT IS DELIBERATELY NOT COUNTED
// --------------------------------
// The two DELIMITING QUOTES of the JSON string literal. They are framing the
// enclosing key pays, not payload; every budget in this package is a payload
// figure, and mixing a constant +2 into one measure and not the next is how these
// numbers drift apart.
//
// Cross-references:
//   - ./result-budget.ts     — the per-result and per-turn caps that measure with this
//   - ../tools/files/read.tool.ts — the tool that budgets its own output in the same
//     escaped currency (`contentWireBytes`, the per-character twin of this function)
//   - ../transport/openai.ts — the serializer that produces the bytes measured here

// UTF-8 byte length. Budgets are expressed in BYTES because the cost of a transcript
// is bytes, not code points — one emoji is four of them. `TextEncoder` is a standard
// global in Node and in every browser this package runs in; the fallback over-counts
// rather than under-counts (`length` <= bytes is the wrong direction).
const encoder = typeof TextEncoder === 'undefined' ? undefined : new TextEncoder();

export const utf8ByteLength = (value: string): number => {
    if (encoder) return encoder.encode(value).length;

    return Math.max(value.length, 0);
};

// The bytes `value` occupies as a JSON string value: its UTF-8 bytes, with every
// character `JSON.stringify` escapes counted at the escaped width.
//
// It walks CODE UNITS, not code points, because that is the only way a lone
// surrogate (which has no UTF-8 encoding of its own) is priced correctly: ES2019
// `JSON.stringify` renders it as a six-byte `\udXXX` literal, and anything less
// would under-count a payload the harness is about to truncate.
//
// The table is the same one ../tools/files/read.tool.ts charges its own content
// budget with (`escapedCharBytes`), so a tool that bounds its output in this currency
// and a harness that enforces a cap in this currency are measuring one number:
//   `"` and `\`      -> 2   (\" \\)
//   \b \f \n \r \t   -> 2   (\b \f \n \r \t)
//   other < 0x20     -> 6   (\u00XX)
//   lone surrogate   -> 6   (\udXXX, per code unit)
//   everything else  -> its UTF-8 length (U+2028/U+2029 included: stringify leaves
//                       them literal, so charging them their raw length is exact)
export const modelPayloadBytes = (value: string): number => {
    let bytes = 0;

    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);

        // The two characters that need a backslash in every JSON string, plus the
        // five control characters that have a one-character escape.
        if (code === 0x22 || code === 0x5c) {
            bytes += 2;
            continue;
        }

        if (code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
            bytes += 2;
            continue;
        }

        if (code < 0x20) {
            bytes += 6;
            continue;
        }

        // Non-ASCII: decide by the code-unit range, resolving one surrogate pair at a
        // time so a 4-byte astral character is charged 4 and not 3 + 6.
        if (code < 0x80) {
            bytes += 1;
            continue;
        }

        if (code < 0x800) {
            bytes += 2;
            continue;
        }

        if (code >= 0xd800 && code <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;

            if (next >= 0xdc00 && next <= 0xdfff) {
                // A well-formed pair encodes to exactly 4 UTF-8 bytes, and JSON
                // leaves the pair literal.
                bytes += 4;
                index += 1;
                continue;
            }

            bytes += 6;
            continue;
        }

        if (code >= 0xdc00 && code <= 0xdfff) {
            // A lone LOW surrogate: also `\udXXX`.
            bytes += 6;
            continue;
        }

        bytes += 3;
    }

    return bytes;
};
