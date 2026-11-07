// Rough context sizing (R2/R3 plugin support).
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
// Cross-references:
//   - ../types                     — HarnessMessage, HarnessTurnBeforeContext.estimatedTokens
//   - ../plugin/hooks.ts           — the bus that hands the estimate to `turn.before`
//   - ../harness.ts                — the only production call site (requestTurn)

import type { HarnessMessage } from '../types';

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

// Estimated token count of a transcript, optionally plus leading instruction text.
// `instructions` accepts a string or an array of strings because an agent's
// `instructions` is an array (core/agent.ts) while a caller may hold one joined
// string; both mean the same thing here.
//
// Empty input is exactly 0, so a caller can distinguish "nothing to send" from a
// rounding artifact.
export const estimateContextTokens = (
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

    // Ceiling, matching the frontend's context-bar formula exactly.
    return Math.ceil(chars / CHARS_PER_TOKEN);
};
