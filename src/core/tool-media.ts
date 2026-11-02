// Declarative tool MEDIA: the same safe seam as `toolUi()`, for file BYTES.
//
// WHY THIS EXISTS
// ---------------
// A tool result is TEXT for the model, and the model-facing result budget
// (core/result-budget.ts, 64 KiB) bounds that text. A tool that fetched a real
// file (the `download` preset) therefore cannot carry the file inside its
// result: a 20 MiB image would be truncated into a JSON envelope and the model
// would get a filename instead of the pixels.
//
// The answer is the SAME mechanism R20.2 established for UI panels: return a
// branded envelope. The harness unwraps it at the one place a result is
// committed (`deliverTask` in ../harness.ts):
//   - the model text is `serialize(content)` — byte-for-byte what an ordinary
//     return value would have produced, still capped by `boundToolResult`;
//   - the validated attachments are stored on the committed `tool` message
//     (`HarnessMessage` tool branch, `attachments`), which is what makes them
//     survive history, snapshot restore and forks;
//   - the `tool_result` event reports `ToolMediaDescriptor[]` ONLY (never
//     base64) because events are JSON round-tripped and persisted per turn;
//   - the transport expands them into a clearly labelled USER-role multimodal
//     payload AFTER the complete contiguous tool block, so strict provider
//     tool-call pairing is never broken.
//
// VALIDATION: two ends, one profile (mirrors toolUi's normalise-here-and-there)
//   - `toolMedia()` validates at the tool, so a bad byte payload fails the call
//     loudly with a readable message the model can act on;
//   - `toolMediaOf()` re-validates at the unwrap boundary, because a
//     hand-built or replaced tool can forge the brand. An invalid envelope is
//     REJECTED (throw), never silently dropped: "your 500 MB file was
//     downloaded but the model never saw it" would be a silent omission.
//
// COMPOSITION with `toolUi()` is order-independent: `unwrapToolResult()` peels
// whichever brand it finds until the plain content remains, so
// `toolMedia(toolUi(content, panels), media)` and
// `toolUi(toolMedia(content, media), panels)` both produce the same triple.
//
// Cross-references:
//   - ../types                — ToolMediaEnvelope / ToolMediaDescriptor
//   - ../shared/attachments.ts— DOWNLOAD_ATTACHMENT_LIMITS (20 MiB) + validator
//   - ./tool-ui.ts            — the panel brand this composes with
//   - ../harness.ts           — deliverTask / insertToolMessage (the only unwrap)
//   - ../transport/openai.ts  — tool media -> labelled user-role parts
//   - ../server/api.ts        — the manual executeTool path unwraps identically

import { HarnessError } from '../util';
import { DOWNLOAD_ATTACHMENT_LIMITS, validateAttachments } from '../shared/attachments';
import type {
    HarnessAttachment,
    HarnessAttachmentLimits,
    ToolMediaDescriptor,
    ToolMediaEnvelope,
    ToolUiPanel
} from '../types';
import { toolUiOf } from './tool-ui';

// The brand key. A plain own-property string, exactly like `__toolUi`, so two
// copies of this module in one process still agree on the shape and an
// own-property check is enough to tell an envelope from an ordinary result.
const TOOL_MEDIA_BRAND = '__toolMedia' as const;

// Validate attachments and re-brand a rejection so the message says WHICH
// surface refused the bytes. The shared validator's own text is preserved
// verbatim after the prefix (it already names the exact field and bound), so a
// model reading `Tool "download" failed: ...` can tell a size breach from a
// signature mismatch from a bad filename. Returning (rather than assigning in a
// try block) keeps the value provably defined for every caller.
const validateMedia = (
    value: unknown,
    limits: HarnessAttachmentLimits
): HarnessAttachment[] => {
    try {
        return validateAttachments(value, limits);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new HarnessError(`Cannot attach tool media: ${detail}`);
    }
};

// Build the branded envelope a tool returns. The attachments are validated
// HERE (fail at the tool) and again at the unwrap boundary (defence), so the
// bytes that reach a transcript were never the caller's live objects:
// `validateAttachments` returns detached copies.
export const toolMedia = <TContent>(
    content: TContent,
    attachments: readonly HarnessAttachment[],
    limits: HarnessAttachmentLimits = DOWNLOAD_ATTACHMENT_LIMITS
): ToolMediaEnvelope<TContent> => ({
    [TOOL_MEDIA_BRAND]: validateMedia(attachments, limits),
    content
});

// What an unwrap gets back: the ordinary content plus the validated media.
export type ToolMediaExtraction<TContent = unknown> = {
    content: TContent;
    media: HarnessAttachment[];
};

// Recognize and unwrap a media envelope. Returns `undefined` for every
// ordinary tool value (including `null`, arrays, and objects that merely have a
// `content` field), which is what keeps every standard tool byte-for-byte
// unaffected at the delivery boundary.
export const toolMediaOf = <TContent = unknown>(
    value: unknown,
    limits: HarnessAttachmentLimits = DOWNLOAD_ATTACHMENT_LIMITS
): ToolMediaExtraction<TContent> | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;

    if (!Object.prototype.hasOwnProperty.call(value, TOOL_MEDIA_BRAND)) return undefined;

    const envelope = value as Record<string, unknown>;

    // Same rule as `toolUiOf`: a forged brand with no content is not an
    // envelope, so the value travels untouched rather than vanishing.
    if (!Object.prototype.hasOwnProperty.call(envelope, 'content')) return undefined;

    // A forged or hand-built envelope is REJECTED, never silently dropped: an
    // oversized payload the model never sees would be a silent omission.
    return { content: envelope.content as TContent, media: validateMedia(envelope[TOOL_MEDIA_BRAND], limits) };
};

// The event/catalogue projection of media: identity and size, never the bytes.
// Declared once here so the progress event (harness.ts) and the manual API
// result (server/api.ts) cannot invent two different shapes for the same fact.
export const toolMediaDescriptors = (media: readonly HarnessAttachment[]): ToolMediaDescriptor[] =>
    media.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size
    }));

// The fully unwrapped form of a tool's return value. A field is ABSENT (not
// empty) when that brand was never used, which is exactly how the delivery
// boundary distinguishes "an ordinary tool" from "a tool that supplied (empty)
// panels or media" — a toolUi envelope whose panels were all unrenderable
// still reports `panels: []`, exactly as before this module existed.
export type ToolResultExtraction<TContent = unknown> = {
    content: TContent;
    panels?: ToolUiPanel[];
    media?: HarnessAttachment[];
};

// Peel BOTH brands, in whatever order they are nested, until the plain content
// remains. Looping (rather than assuming an order) is what makes
// `toolMedia(toolUi(...))` and `toolUi(toolMedia(...))` behave identically, and
// it terminates because every step replaces the value with that envelope's own
// `content`, which cannot be the same object (a self-referential envelope
// would have been rejected by JSON serialization at the tool boundary).
export const unwrapToolResult = <TContent = unknown>(
    value: unknown,
    limits: HarnessAttachmentLimits = DOWNLOAD_ATTACHMENT_LIMITS
): ToolResultExtraction<TContent> => {
    let content: unknown = value;
    let panels: ToolUiPanel[] | undefined;
    let media: HarnessAttachment[] | undefined;

    for (;;) {
        const extractedMedia = media === undefined ? toolMediaOf(content, limits) : undefined;

        if (extractedMedia !== undefined) {
            media = extractedMedia.media;
            content = extractedMedia.content;
            continue;
        }

        const extractedUi = panels === undefined ? toolUiOf(content) : undefined;

        if (extractedUi !== undefined) {
            panels = extractedUi.panels;
            content = extractedUi.content;
            continue;
        }

        break;
    }

    return {
        content: content as TContent,
        ...(panels === undefined ? {} : { panels }),
        ...(media === undefined ? {} : { media })
    };
};
