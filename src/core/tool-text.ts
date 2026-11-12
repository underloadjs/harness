// toolText — one tool's MODEL-PROJECTION seam: the prose a tool wants in the
// transcript, kept separate from the structured value everything else consumes.
//
// WHY THIS EXISTS
// ---------------
// A tool result is TEXT on the wire, and the harness derives that text by
// serializing the tool's return value (`serialize` in ../harness.ts). For most
// tools that is the cheapest honest rendering available. For a tool that returns
// a LARGE body of text inside a structured envelope it is not: `read` returns up
// to 256 KiB of file text in `files[].content`, and serializing it
//   - escapes every newline, quote, backslash and control character (measured on
//     this package's own source: +2.1%, and +15.2% on quote-heavy code), and
//   - pays the metadata of every entry in the same budget the content lives in.
// Both costs are charged against the CALLER'S CONTEXT WINDOW, which is the one
// budget `read` exists to protect.
//
// The fix is the same safe seam `toolUi()` and `toolMedia()` established: return
// a branded envelope, and let the harness peel it at the ONE place a result is
// committed (`deliverTask` in ../harness.ts):
//   - the transcript text becomes `text` — byte-for-byte what a tool returning a
//     plain string would have produced, still capped by `boundToolResult`;
//   - `content` stays the tool's ACTUAL result: the server's manual-execute
//     response (`boundToolValue`) and every programmatic caller still receive the
//     structured value, not the prose;
//   - an ordinary tool that never calls `toolText()` is unaffected at every
//     boundary, byte-for-byte, because `toolTextOf()` returns `undefined` for it.
//
// WHY A SEPARATE BRAND INSTEAD OF "JUST RETURN A STRING"
// -----------------------------------------------------
// Returning prose would fix the model's copy by DESTROYING the machine's one:
// `Tool.execute` has a single return value, so a string leaves nothing for the
// API response, a UI card, or a caller that threads `nextByte` through a paging
// loop. The brand is what lets ONE implementation serve both consumers.
//
// VALIDATION: like the other two brands, both ends check. `toolText()` rejects a
// non-string projection at the tool (a typo must not silently become `[object
// Object]` in the transcript) and `toolTextOf()` re-checks at the boundary,
// because a hand-built envelope can forge the key. A forged envelope is
// REJECTED, never silently dropped — prose the model never sees would be a quiet
// omission of the tool's result.
//
// COMPOSITION is order-independent: `unwrapToolResult()` peels whichever brand it
// finds until the plain content remains, so `toolText(toolMedia(...))` and
// `toolMedia(toolText(...))` both yield the same triple.
//
// Cross-references:
//   - ./tool-media.ts           — the media brand + `unwrapToolResult()`
//   - ./tool-ui.ts              — the panel brand this composes with
//   - ../harness.ts             — deliverTask (the only transcript unwrap)
//   - ../server/api.ts          — the manual execute path, which keeps `content`
//   - ../types/index.ts         — ToolTextEnvelope

import { HarnessError } from '../util';
import type { ToolTextEnvelope } from '../types';

// The brand key. A plain own-property string, exactly like `__toolMedia` and
// `__toolUi`, so two copies of this module in one process still agree on the
// shape and an own-property check is enough to tell an envelope from an
// ordinary result.
const TOOL_TEXT_BRAND = '__toolText' as const;

// Build the branded envelope. The content is the tool's real result and travels
// untouched; `text` is the rendering the MODEL receives.
export const toolText = <TContent>(content: TContent, text: string): ToolTextEnvelope<TContent> => {
    if (typeof text !== 'string') {
        throw new HarnessError(
            `toolText expects a string projection; received ${typeof text === 'object' && text === null ? 'null' : typeof text}.`
        );
    }

    return { [TOOL_TEXT_BRAND]: text, content };
};

// What an unwrap gets back: the ordinary content plus the declared prose.
export type ToolTextExtraction<TContent = unknown> = {
    content: TContent;
    text: string;
};

// Recognize and unwrap a text envelope. Returns `undefined` for every ordinary
// tool value (including `null`, arrays, and objects that merely have a `content`
// field), which is what keeps every standard tool unaffected at the delivery
// boundary.
export const toolTextOf = <TContent = unknown>(
    value: unknown
): ToolTextExtraction<TContent> | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;

    if (!Object.prototype.hasOwnProperty.call(value, TOOL_TEXT_BRAND)) return undefined;

    const envelope = value as Record<string, unknown>;

    // Same rule as `toolMediaOf`/`toolUiOf`: a forged brand with no content is not
    // an envelope, so the value travels untouched rather than vanishing.
    if (!Object.prototype.hasOwnProperty.call(envelope, 'content')) return undefined;

    if (typeof envelope[TOOL_TEXT_BRAND] !== 'string') {
        throw new HarnessError(
            `toolText projection must be a string; received ${
                typeof envelope[TOOL_TEXT_BRAND] === 'object' && envelope[TOOL_TEXT_BRAND] === null
                    ? 'null'
                    : typeof envelope[TOOL_TEXT_BRAND]
            }.`
        );
    }

    return { content: envelope.content as TContent, text: envelope[TOOL_TEXT_BRAND] as string };
};
