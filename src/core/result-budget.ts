// Model-facing tool-result budget (R10).
//
// Every tool result and every tool ERROR the harness feeds back to the model is
// TEXT on the wire. A single tool can return — or throw — something enormous:
// `fileRead` of a 20 MB log, a command that dumps a build log into a failure
// message, a web page pasted into a search snippet. That text is then replayed
// on EVERY subsequent request of the conversation, so one unbounded result can
// exceed the model's context window and end the session with a transport error
// the model can never recover from.
//
// This module is the single global cap for that surface:
//
//   - small results pass through EXACTLY unchanged (byte for byte): every
//     existing tool result a model or a test has ever seen keeps its shape;
//   - a result that exceeds the budget becomes a SMALL, VALID JSON envelope
//     that names the truncation, the original size, the applied budget, and as
//     much of the beginning as fits. A truncated JSON-ish result is therefore
//     still parseable JSON instead of a half-written document;
//   - the cap is applied to serialized TEXT, so it covers ordinary values, plain
//     prose, and error messages with one rule.
//
// Two honest limitations, stated here because the cap is easy to oversell:
//
//   1. It is a POST-SERIALIZATION cap. The tool's value and its JSON string are
//      fully allocated before this runs, so the cap bounds the conversation's
//      token cost, NOT the process's peak memory. A tool that wants to avoid
//      allocating gigabytes must bound its own work (fileRead's content budget
//      does exactly that).
//   2. It only bounds the MODEL-facing text. Declarative UI panels travel on a
//      separate `ui` field and are bounded by core/tool-ui.ts instead; the two
//      limits are deliberately independent.
//
// Cross-references:
//   - ../harness.ts    — applies the cap to every tool result and tool error
//   - ./tool-ui.ts     — the separate panel bounds
//   - ../types        — the tool_result event whose `content` is this text

// The default budget: 64 KiB of UTF-8 bytes per model-facing tool result or
// tool error. 64 KiB is roughly 16k tokens of English prose — large enough for
// any honest tool result (fileRead's own content budget is the same size) and
// small enough that a handful of them still fit a context window.
export const MODEL_TOOL_RESULT_BUDGET_BYTES = 64 * 1024;

// Keys of the truncation envelope. They are stable because a model may parse a
// truncated result and a test asserts the exact shape.
const TRUNCATED_KEY = 'truncated';
const ORIGINAL_BYTES_KEY = 'originalBytes';
const BUDGET_BYTES_KEY = 'budgetBytes';
const CONTENT_KEY = 'content';

// The result of applying the budget. `content` is what goes on the wire;
// `truncated` and `originalBytes` let a caller (the server, a test) report that
// a cap was applied without re-measuring the string.
export type BoundedToolResult = {
    content: string;
    truncated: boolean;
    originalBytes: number;
};

// UTF-8 byte length. The budget is expressed in bytes because the wire cost of a
// transcript is bytes, not code points — one emoji is four of them. `TextEncoder`
// is a standard global in Node and in every browser this package runs in; the
// fallback keeps a hostile/older runtime from throwing and over-counts instead of
// under-counting (`length` <= bytes is the wrong direction, so we take the max).
const encoder = typeof TextEncoder === 'undefined' ? undefined : new TextEncoder();

export const utf8ByteLength = (value: string): number => {
    if (encoder) return encoder.encode(value).length;
    return Math.max(value.length, 0);
};

// Drop a trailing lone high surrogate. Slicing by code unit can split a
// surrogate pair; leaving half of one in the envelope would make JSON.stringify
// emit a `\ud800` escape, which is valid JSON but not the text the tool produced.
const trimBrokenSurrogate = (value: string): string => {
    if (value.length === 0) return value;
    const last = value.charCodeAt(value.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
};

// The envelope itself. Keeping the prefix inside `content` means the model can
// still read the beginning of the result while seeing exactly how much was lost.
const envelope = (prefix: string, originalBytes: number, budgetBytes: number): string =>
    JSON.stringify({
        [TRUNCATED_KEY]: true,
        [ORIGINAL_BYTES_KEY]: originalBytes,
        [BUDGET_BYTES_KEY]: budgetBytes,
        [CONTENT_KEY]: prefix
    });

// Apply the budget to one serialized tool result or tool error.
//
// Deterministic: the same input and budget always produce the same envelope. A
// result at or under the budget is returned unchanged (the common case, and the
// one every existing test pins).
export const boundToolResult = (
    content: string,
    budgetBytes: number = MODEL_TOOL_RESULT_BUDGET_BYTES
): BoundedToolResult => {
    const originalBytes = utf8ByteLength(content);

    // Small outputs are EXACT: no re-encoding, no normalization, no marker.
    if (originalBytes <= budgetBytes) return { content, truncated: false, originalBytes };

    // One code unit can never encode to less than one byte, so a code-unit slice
    // of `budgetBytes` is an upper bound on a prefix that fits. JSON escaping of
    // the prefix only makes the envelope longer, hence the shrink loops below.
    let keep = Math.min(content.length, budgetBytes);
    let bounded = envelope(trimBrokenSurrogate(content.slice(0, keep)), originalBytes, budgetBytes);

    // Geometric shrink, then exact shrink: at most O(log n) + a few iterations,
    // and it terminates because every step strictly reduces `keep`.
    while (utf8ByteLength(bounded) > budgetBytes && keep > 0) {
        keep = Math.floor(keep * 0.9);
        bounded = envelope(trimBrokenSurrogate(content.slice(0, keep)), originalBytes, budgetBytes);
    }

    while (utf8ByteLength(bounded) > budgetBytes && keep > 0) {
        keep -= 1;
        bounded = envelope(trimBrokenSurrogate(content.slice(0, keep)), originalBytes, budgetBytes);
    }

    // Extreme edge: the budget is smaller than the envelope's fixed overhead
    // (~60 bytes). Return the marker anyway — a truncated marker is more useful
    // to the model than silence, and the documented budgets are kilobytes.
    return { content: bounded, truncated: true, originalBytes };
};
