// Rough context sizing (R2/R3 plugin support), and the hybrid estimate that
// anchors it on real provider usage (compaction T5.4).
//
// WHY THIS EXISTS
// ---------------
// A per-agent context limit has to be checked somewhere, and the only place that can
// do it cheaply is the harness, at the turn boundary, over the transcript it already
// projected. A provider's real token count is not available before the request, and
// after the request it is too late to compact this turn. So the number here is an
// ESTIMATE with one contract: it is stable, monotonic in the amount of text, and good
// to within the usual ~4 characters/token rule of thumb. A compaction plugin compares
// it against a user-set limit, where being 5% off changes nothing.
//
// WHY NOT A REAL TOKENIZER
// ------------------------
// A tokenizer is model-specific and megabytes of data. The frontend already uses
// `ceil(chars / 4)` for the context bar (src/frontend/ui/turns.ts), so this helper
// keeps the SAME convention: a limit configured against the UI's bar and the plugin's
// check agree with each other, which they would not with two different formulas.
//
// WHAT IS COUNTED
// ---------------
//   - every message's `content` text;
//   - an assistant turn's tool-call NAMES and raw `arguments` JSON (the provider does
//     receive them, and a large tool argument is exactly the case that blows a context);
//   - leading instruction strings passed in `instructions` (an agent's system blocks
//     are not part of `agent.messages` projections in every path, so the caller can
//     add them explicitly);
//   - an attachment's NAME and MIME type as text only. Its BYTES are deliberately not
//     counted: providers charge media per image/per page, not per base64 character, so
//     counting the data would overstate a transcript with one screenshot by orders of
//     magnitude.
//
// WHAT IS NEVER COUNTED: `reasoning`. It is retained for replay (types/index.ts) and
// is not resent to the provider.
//
// TOTALITY: nothing here throws. A hostile/restored message may carry a number, an
// object, or a Proxy as `content`; `textOf` stringifies defensively and a stringify
// that fails (cycle, BigInt) contributes 0 rather than failing the turn.
//
// THE HYBRID ESTIMATE (T5.4)
// --------------------------
// `ceil(chars / 4)` has a systematic error this file cannot see: the real prompt also
// carries the tool schemas, the message framing, and whatever the model's tokenizer
// actually does with code and CJK. The provider DOES know all of that and reports it
// as `usage.input` — one request too late to compact THAT request, but exactly on time
// to anchor the next one. So `estimateContextTokensHybrid` takes the last reported
// `input` for a prefix whose character weight is known (`ContextTokenAnchor`, built by
// `anchorFromUsage`) and extrapolates only the DELTA at chars/4:
//
//     estimate = anchor.tokens + ceil((chars - anchor.chars) / 4)
//
// The anchor absorbs everything the heuristic cannot see; the cheap rule is still the
// only thing measuring the text that arrived since the last request. Cost: two numbers
// kept per run and one character pass — no tokenizer, no second request.
//
// THE MONOTONICITY RULE, STATED BECAUSE A MOVING GOALPOST IS A POLICY BUG: inside one
// anchor window the number is monotonic in the amount of text (the delta term is).
// It may step DOWN at exactly two moments, both attributable:
//   1. a new provider count replaces an extrapolation of the same prefix — a
//      correction of this file's own error, landing once per request;
//   2. the transcript itself shrank (a plugin withheld a unit, an `edit` rewrote one),
//      which reduces the delta term.
// It never changes because of a clock, a random choice, or a re-ordering, and a
// provider that reports nothing keeps the plain heuristic — so a conversation on a
// usage-blind provider behaves byte-identically to how it did before this existed.
//
// Cross-references:
//   - ../types                     — HarnessMessage, HarnessUsage, HarnessTurnBeforeContext.estimatedTokens
//   - ../plugin/hooks.ts           — the bus that hands the estimate to `turn.before`
//   - ../harness.ts                — the only production call sites (requestTurn: the anchor
//                                    capture on the request, the `usage` frame that commits it,
//                                    and both `turn.before` estimates)

import type { HarnessMessage, HarnessUsage } from '../types';

// Characters per token. The convention the whole product shares; see the header.
const CHARS_PER_TOKEN = 4;

// Defensive stringification of one unknown field. Numbers and booleans are counted as
// their literal text (a provider serializes them the same way); anything else goes
// through a total JSON pass, falling back to `String()` semantics only when the value
// is a primitive that cannot be cycled.
const textOf = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    try {
        return JSON.stringify(value) ?? '';
    } catch {
        // A cycle or a throwing getter: the field is unmeasurable, not fatal.
        return '';
    }
};

// The character weight of ONE transcript entry.
const messageChars = (message: HarnessMessage): number => {
    let total = textOf(message.content).length;

    // Tool-call arguments are provider-visible text and the single largest payload a
    // turn can carry (a big file written through a tool call).
    const calls = (message as { toolCalls?: unknown }).toolCalls;
    if (Array.isArray(calls)) {
        for (const call of calls) {
            if (call === null || typeof call !== 'object') continue;
            const entry = call as { name?: unknown; arguments?: unknown };
            total += textOf(entry.name).length + textOf(entry.arguments).length;
        }
    }

    // Tool results carry their own name on the wire (pairing), and a `name` costs a
    // handful of characters per call — measured, not guessed.
    const name = (message as { name?: unknown }).name;
    if (typeof name === 'string') total += name.length;

    const attachments = (message as { attachments?: unknown }).attachments;
    if (Array.isArray(attachments)) {
        for (const attachment of attachments) {
            if (attachment === null || typeof attachment !== 'object') continue;
            const entry = attachment as { name?: unknown; mimeType?: unknown };
            total += textOf(entry.name).length + textOf(entry.mimeType).length;
        }
    }

    return total;
};

// The character weight of a whole request — every message plus the leading
// instruction blocks. This is the SAME pass `estimateContextTokens` divides by 4,
// exposed because the hybrid anchor has to be recorded in the SAME unit or the delta
// term would compare bytes with inches.
//
// `instructions` accepts a string or an array of strings because an agent's
// `instructions` is an array (core/agent.ts) while a caller may hold one joined
// string; both mean the same thing here. Total, like the estimator: a hostile or
// restored shape contributes 0 rather than throwing.
export const transcriptChars = (
    messages: readonly HarnessMessage[] | undefined,
    instructions?: string | readonly string[]
): number => {
    let chars = 0;

    if (typeof instructions === 'string') chars += instructions.length;
    else if (Array.isArray(instructions)) {
        for (const entry of instructions) chars += textOf(entry).length;
    }

    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (message === null || typeof message !== 'object') continue;
            chars += messageChars(message);
        }
    }

    return chars;
};

// Estimated token count of a transcript, optionally plus leading instruction text.
// The ~4 chars/token heuristic on its own — the number the UI context bar matches, and
// the signature every existing caller (and src/core/context-estimate.test.ts) pins.
//
// Empty input is exactly 0, so a caller can distinguish "nothing to send" from a
// rounding artifact.
export const estimateContextTokens = (
    messages: readonly HarnessMessage[] | undefined,
    instructions?: string | readonly string[]
): number => Math.ceil(transcriptChars(messages, instructions) / CHARS_PER_TOKEN);

// ---------------------------------------------------------------------------
// T5.4 — the provider-anchored half
// ---------------------------------------------------------------------------

// A provider-reported token count for a KNOWN prefix of this conversation.
//
// `chars` is `transcriptChars()` of exactly the transcript that was sent with the
// request `tokens` reports — instructions included, because that is the same measure
// the later estimate takes. The pair is the whole value: an anchor without its prefix
// weight cannot be extrapolated from, and a prefix weight without a reported count is
// just the heuristic again.
export type ContextTokenAnchor = {
    /** `HarnessUsage.input`: prompt tokens for the request, INCLUDING a replayed cache prefix. */
    tokens: number;
    /** `transcriptChars()` of that request's transcript. */
    chars: number;
};

// The LOW-side sanity floor, expressed as a multiple of the chars/4 guess for the same
// text. The rule is deliberately asymmetric, because the two error directions are not
// equally dangerous:
//
//   - a count ABOVE the guess is expected and is the whole value of anchoring: the
//     provider is counting what this file cannot see at all — the tool schemas, the
//     message framing, a tokenizer that runs denser on code and CJK. Refusing those
//     would throw away the anchor in exactly the conversations that need one, so any
//     positive count is adopted.
//   - a count far BELOW the guess means the number is not the prompt size of THIS text
//     at all: a provider reporting only the uncached delta, a proxy zeroing a field it
//     does not parse, a wire field that arrived as something else. Anchoring on that
//     UNDER-states the context, which is the direction that lets a conversation run
//     into an oversized request — the failure this estimator exists to catch early.
//
// 1/4 of the guess means "at most 16 characters per token", which is looser than any
// real tokenizer (sparse prose is ~6-8). Refusing is not a failure: the caller simply
// keeps the heuristic it has always used.
const ANCHOR_MINIMUM_RATIO = 4;

// Turns one reported `usage` block into an anchor for the request that produced it.
//
// `requestChars` MUST be the `transcriptChars()` of the transcript that was actually
// sent, measured BEFORE the response was appended. Returns `undefined` (keep the
// heuristic) for a provider that reports nothing, reports a non-finite or non-positive
// `input`, or reports a count implausibly BELOW the chars/4 guess for that text — see
// `ANCHOR_MINIMUM_RATIO` for why the check is one-sided.
//
// `cached` is deliberately NOT used: it says how much of `input` the provider served
// from its prefix cache, not how large the prompt was, and `HarnessUsage`'s own
// contract is that an absent `cached` means "unknown", not zero (../types).
export const anchorFromUsage = (
    usage: HarnessUsage | undefined,
    requestChars: number
): ContextTokenAnchor | undefined => {
    const tokens = usage?.input;

    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return undefined;

    const chars = Number.isFinite(requestChars) && requestChars > 0 ? Math.floor(requestChars) : 0;
    const heuristic = Math.ceil(chars / CHARS_PER_TOKEN);

    // A zero-char prefix has no heuristic to be sane against — the reported count is
    // then the framing/tool-schema overhead the heuristic cannot see at all, which is
    // precisely the information worth keeping.
    if (heuristic > 0 && tokens * ANCHOR_MINIMUM_RATIO < heuristic) return undefined;

    return { tokens, chars };
};

// The hybrid estimate: `anchor`'s real count plus chars/4 over the text that arrived
// since. With no anchor it is byte-for-byte the heuristic above, so a first turn, a
// usage-blind provider and a host that never wires the anchor all keep the old number.
//
// Why the delta term is the whole design (and the doc's "extrapolate the delta with
// chars/4"): the error of the heuristic is dominated by what it cannot see at all
// (schemas, framing, the tokenizer's real rate), and that error is CONSTANT for a
// conversation whose prefix is unchanged. Anchoring cancels the constant; only the
// freshly-appended text is still guessed, and it is the smallest part of a long
// conversation.
export const estimateContextTokensHybrid = (
    messages: readonly HarnessMessage[] | undefined,
    instructions?: string | readonly string[],
    anchor?: ContextTokenAnchor
): number => {
    const chars = transcriptChars(messages, instructions);

    if (anchor === undefined || !Number.isFinite(anchor.tokens) || anchor.tokens <= 0) {
        return Math.ceil(chars / CHARS_PER_TOKEN);
    }

    const base = Number.isFinite(anchor.chars) && anchor.chars > 0 ? anchor.chars : 0;

    // Negative delta = the transcript is now SHORTER than the anchored prefix (a
    // withheld unit, an edited message). `Math.ceil` rounds a negative toward zero,
    // i.e. the shrink is discounted rather than exaggerated — the conservative
    // direction for a number a pruning policy measures its savings with.
    return Math.max(0, Math.trunc(anchor.tokens) + Math.ceil((chars - base) / CHARS_PER_TOKEN));
};
