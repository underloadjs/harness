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
// to within the usual ~4-bytes-per-token rule of thumb — on a real corpus the residual
// is the tokenizer's own density, which is what the provider anchor below exists to
// cancel. A compaction plugin compares it against a user-set limit, where being a few
// percent off changes nothing; being 16% off in the UNDER direction, on the far side of
// the window, is the one failure mode that is not survivable (see "THE WIRE MEASURE").
//
// WHY NOT A REAL TOKENIZER
// ------------------------
// A tokenizer is model-specific and megabytes of data. The package prices a request with
// ONE rule of thumb and ONE implementation of it (`estimateTokensFromChars`), so the UI
// context bar, the trimmer's token floors, the `maxPromptTokens` guard in ../core/agent.ts
// and the compaction trigger cannot drift apart — and once a request has reported real
// `usage`, the turn tile shows the provider's own number (src/frontend/ui/turns.ts) and
// this file anchors on it, so a user reads the billed figure as soon as it exists.
//
// THE WIRE MEASURE — BYTES, NOT CHARACTERS (T5, 2026-11-17: the refusal)
// ----------------------------------------------------------------------
// The unit is the SERIALIZED-PAYLOAD BYTE, not the JavaScript character. A message
// field goes to the provider as a JSON string value, so what the provider tokenizes is
// the ESCAPED text: `"` and `\` double, every control character becomes `\u00XX`
// (6 bytes), and a non-ASCII character costs its UTF-8 width, not 1. The two numbers
// are equal for bare ASCII prose and diverge by the escape tax
// `core/payload-bytes.ts` measures (+1.08x multibyte, +1.50x escape-heavy).
//
// WHY THIS IS NOT A REFINEMENT BUT THE FIX. Measured on the session this change was
// asked for (`Temp/d1/report.md`, session 6a94b896, model `local/basalt`, root
// thread-1): the request at round 21 was billed 225,612 tokens while the harness
// believed 193,428, so the 200,000 compaction trigger fired one request late and the
// request AFTER it — the one carrying the compaction instruction — was the one the
// provider refused. On that corpus the per-entry byte/character tax is 1.195x at
// round 21 and 1.325x at round 14 (a single multibyte `read` result carries 1.786x:
// 111,369 characters, 198,854 payload bytes). Charging characters was charging a
// number the provider never billed, in the direction that hides the overflow.
//
// This changes published numbers by design: they were too low. Pure ASCII text
// without quotes, backslashes or control characters is unchanged byte for byte, which
// is why every ASCII pin in `context-estimate.test.ts` still passes untouched; the
// pins that move are the ones holding escaped or multibyte text, and they move UP.
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
//     counted by DEFAULT: providers charge media per image/per page, not per base64
//     character, so counting the data would overstate a transcript with one screenshot
//     by orders of magnitude. The bytes ARE available on request (see
//     "THE OPT-IN REQUEST WEIGHT" below), because a caller that is deciding whether a
//     request still FITS wants an upper bound rather than a billing figure.
//
// THE MIME FIELD IS READ AS `mime`, WITH A `mimeType` FALLBACK (T5, same session).
// The shipped shape is `HarnessAttachment.mime` (../types/index.ts:53); this file used
// to read `attachment.mimeType`, so the MIME term was silently `''` for EVERY real
// attachment while the module's own published contract claimed it was counted. `mime`
// wins and `mimeType` is the fallback for hosts that already hand in that spelling —
// one attachment contributes ONE mime term, never two.
//
// THE TOOL-CATALOGUE FLOOR IS ONLY COUNTABLE IF THE CALLER NAMES IT.
// Measured floor for that session's system prompt + tool catalogue: 31,229 tokens on a
// transcript the estimator scored at 464 (ratio 68.3), and 32,013-32,827 for its four
// children. The catalogue is not in the transcript, so `toolSchemaChars` (see the
// opt-in section) is the ONLY way an unanchored request can see it; the helper
// `toolSchemaPayloadBytes` exists so a caller can compute that figure in this file's
// currency without hand-rolling a serializer. A provider ANCHOR already carries the
// floor (its `usage.input` is the whole request), which is why round 2 onward of that
// session is anchored and correct, and round 1 — the one turn with no anchor — is not.
//
// THE OPT-IN REQUEST WEIGHT (2026-11-17, the compaction deadlock)
// ---------------------------------------------------------------
// `ContextEstimateOptions` adds the three things the default pass cannot see — the
// base64 an attachment actually puts in the body, the serialized TOOL SCHEMAS that ride
// in the same request, and a caller-supplied framing allowance. Every option defaults to
// OFF, so `estimateContextTokens(messages)` and `transcriptChars(messages)` keep their
// published shape and every pinned call site is unchanged in KIND — the only default
// change is the one above, characters to serialized payload bytes, and it is a fix rather
// than a tuning knob. Only a caller that passes the options sees the larger, conservative
// figure that also counts the catalogue and the media.
//
// It is deliberately an ALLOWANCE rather than a model: the honest statement is "these
// bytes are in the body", not "the tokenizer spends N tokens on them". A provider bills a
// 1 MB screenshot as a fixed band, not as 1.3 M base64 characters / 4, so the opt-in
// figure is an UPPER bound — which is exactly what a "will this request be refused?" check
// wants, and the wrong thing for a context bar a user reads. Hence: two answers, one
// function, and the caller states which question it is asking.
//
// With a provider ANCHOR the two halves of the allowance behave DIFFERENTLY, and the split is
// by behaviour rather than by option name. The CONSTANT half (`toolSchemaChars`,
// `requestOverheadChars`) is ignored on the anchored leg: `anchor.tokens` is the provider's own
// count of a whole request, so it already contains the schemas and the framing, and adding the
// same constant again on top of an anchor would bill it twice — the exact error the anchor exists
// to cancel. The VARIABLE half (`includeAttachmentBytes`) applies on BOTH legs, because media is
// appended text like any other entry: an anchored conversation that grew by a screenshot grew by
// its wire bytes, and a leg that ignored them would price a smaller quantity than the unanchored
// leg and than the compaction plugin that shrinks the same request. The consequence is that a
// media entry already inside the anchored request is priced twice (see "THE GROWTH MEASURE" in
// `estimateContextTokensHybrid`) — an over-count, in the UPPER-BOUND direction this option
// publishes — and a caller that wants it priced once records its anchor with the same option.
//
// WHAT IS COUNTED FOR THINKING, AND WHY THAT CHANGED
// ---------------------------------------------------
// An assistant entry's `reasoning` is counted UNLESS that entry carries
// `reasoningIncluded === false`. That flag is the whole rule, and it is the rule the projection
// already applies: `core/agent.ts` `withoutWithheldReasoning` DELETES the `reasoning` key from the
// request copy of a flagged entry, and `transport/openai.ts` emits `reasoning_content` for an entry
// only when the projected copy still has non-empty `reasoning`. So:
//
//   - a flagged entry's thinking is on disk and NOT on the wire  -> not counted;
//   - an unflagged entry's thinking is on the wire and billed    -> counted.
//
// This term used to be absent outright ("`reasoning` is retained for replay and is not resent"),
// which was true of the pre-trimmer harness and stopped being true the day the context trimmer grew
// a thinking axis. The cost of the stale rule was that EVERY thinking saving the trimmer writes read
// as zero — in `estimatedTokens`, in `currentEstimatedTokens()`, in the `maxPromptTokens` /
// `provider.contextWindow` guard and in the UI context bar. An operator turned the trimmer on, it
// worked, and not one number they could see moved.
//
// The flag is read here rather than filtering entries at the call sites because BOTH callers need
// the same rule and neither may be trusted to pre-filter: `transcriptChars` measures a PROJECTED
// request (a withheld entry has no `reasoning` key at all, so the term contributes 0 by itself),
// while `estimateContextTokens` is also handed CANONICAL entries by the trimmer's and compactor's
// `minTokens` floor, where the flag is the only thing that says whether the text travels.
//
// TOTALITY: nothing here throws. A hostile/restored message may carry a number, an
// object, or a Proxy as `content`; `bytesOf` measures each shape the way the serializer
// would send it and a stringify that fails (cycle, BigInt) contributes 0 rather than
// failing the turn.
//
// THE HYBRID ESTIMATE (T5.4)
// --------------------------
// `ceil(bytes / 4)` has a systematic error this file cannot see: the real prompt also
// carries the tool schemas, the message framing, and whatever the model's tokenizer
// actually does with code and CJK. The provider DOES know all of that and reports it
// as `usage.input` — one request too late to compact THAT request, but exactly on time
// to anchor the next one. So `estimateContextTokensHybrid` takes the last reported
// `input` for a prefix whose wire weight is known (`ContextTokenAnchor`, built by
// `anchorFromUsage`) and extrapolates only the DELTA:
//
//     estimate = max(ceil(bytes / 4),
//                    anchor.tokens + ceil(bytes-of-growth * (1 + margin) / 4))
//
// The anchor absorbs everything the heuristic cannot see; the cheap rule is still the
// only thing measuring the text that arrived since the last request. Cost: two numbers
// kept per run and one payload pass — no tokenizer, no second request.
//
// THE ANCHORED GROWTH MARGIN (T5, and the number that decides whether the trigger wins)
// -------------------------------------------------------------------------------------
// Serialized bytes are still not tokens. On the corpus above the growth between round 20
// and round 21 was 234,170 payload bytes and the provider billed 88,118 tokens for it —
// 2.66 payload bytes per token, denser than 4 because the payload is quote/backslash-
// heavy text, and JSON escapes tokenize as their own tokens. Anchored growth at
// bytes/4 therefore still under-read the round-21 body by a factor of 1.166
// (225,612 billed against the 193,428 the harness believed), and at a 200,000 trigger
// 1.166 is exactly the difference between firing at round 21 and refusing at round 22.
//
// So the growth term carries a margin: `ANCHOR_GROWTH_MARGIN`, the measured 1.166x
// residual, applied ONLY to text that arrived after the anchored request and ONLY on the
// anchored leg. It is not a fudge factor over the whole estimate: with it, the replay of
// all 21 measured rounds lands at mean signed error -331 tokens and worst +5,639 over /
// -19,857 under (before: mean -4,323, worst -32,215 under), and the trigger crosses
// 200,000 at round 21 — the request BEFORE the one that was refused. `ContextEstimateOptions
// .anchorGrowthMargin` re-tunes it per caller; a corrupt value falls back to the measured
// constant rather than to 0, because 0 is the value this session proved unsafe.
//
// THE LOW-SIDE CLAMP: the anchored answer also never drops below `ceil(bytes / 4) /
// ANCHOR_MINIMUM_RATIO` of the current request — the same 16-bytes-per-token boundary
// `anchorFromUsage` requires before it adopts an anchor at all, so no accepted anchor can
// price this request at a rate no real tokenizer runs. It is NOT pinned at the plain
// heuristic: that would re-impose the guess the anchor exists to replace, and a provider
// legitimately running sparser than 4 bytes/token (prose, repetitive text) would lose its
// own count. The under-count the refusal proved fatal is the OPPOSITE direction, and the
// margin above is what closes it. In the measured replay this clamp never binds.
//
// THE MONOTONICITY RULE, STATED BECAUSE A MOVING GOALPOST IS A POLICY BUG: inside one
// anchor window the number is monotonic in the amount of text (the delta term is, and
// the margin is a positive constant multiplier on it). It may step DOWN at exactly two
// moments, both attributable:
//   1. a new provider count replaces an extrapolation of the same prefix — a
//      correction of this file's own error, landing once per request;
//   2. the transcript itself shrank (a plugin withheld a unit, an `edit` rewrote one),
//      which reduces the delta term.
// It never changes because of a clock, a random choice, or a re-ordering, and a
// provider that reports nothing keeps the plain heuristic — so a conversation on a
// usage-blind provider behaves byte-identically to how it did before this existed.
//
// Cross-references:
//   - ./payload-bytes.ts           — `modelPayloadBytes` / `utf8ByteLength`, the currency this
//                                    file charges in, and the escape table it is verified against
//   - ../types                     — HarnessMessage, HarnessUsage, HarnessTurnBeforeContext.estimatedTokens,
//                                    and `HarnessAttachment.mime` (index.ts:53) — the field name
//                                    this file read wrong until T5
//   - ../plugin/hooks.ts           — the bus that hands the estimate to `turn.before`
//   - ../harness.ts                — the only production call sites (requestTurn: the anchor
//                                    capture on the request, the `usage` frame that commits it,
//                                    and both `turn.before` estimates)
//   - ../plugins/context-compaction.plugin.ts — `resolveContextTrigger`, the ceiling this
//                                    number is compared against, and the headroom buffer that
//                                    only binds when a model window is DECLARED
//   - Temp/d1/report.md            — the calibration evidence every constant in this file cites
//                                    (session 6a94b896, 21 measured `usage.input` rows)

import type { HarnessMessage, HarnessUsage } from '../types';
// The wire currency. `modelPayloadBytes` prices one string as the JSON string value the
// transport actually sends; `utf8ByteLength` prices an already-serialized document (a
// tool catalogue) without escaping it twice. See ./payload-bytes.ts for both, and the
// "THE WIRE MEASURE" header above for why the estimator charges them.
import { modelPayloadBytes, utf8ByteLength } from './payload-bytes';

// Bytes per token. The convention the whole product shares; see the header. The name
// keeps the word "chars" out of the public helpers for one reason: the divisor is the
// same rule of thumb, while the NUMERATOR is now the serialized payload weight.
const BYTES_PER_TOKEN = 4;

// Characters per token, spelled for the one PUBLIC helper that still receives raw
// characters (`estimateTokensFromChars`). Same number, and the two are only equal
// because the rule of thumb has no better answer for either unit.
const CHARS_PER_TOKEN = BYTES_PER_TOKEN;

// The same rule of thumb on its own, for a caller holding a CHARACTER count rather than a
// transcript. The context trimmer's thinking axis measures what one write removes in characters
// (`../plugins/context-trimmer.plugin.ts` `minThoughtChars`, `ThoughtCandidate.chars`) and its pass
// report has to name the token figure in the ONE convention the rest of the product shares — a
// second `ceil(n / 4)` written by hand in the plugin is a second formula that can drift. `0`, a
// negative and a non-finite input are all `0`.
//
// NOTE ON THE UNIT, because it is the one place this file still answers in raw characters: a
// withheld thinking entry's REAL saving is its payload bytes / 4, which is >= this figure for any
// text carrying escapes. The trimmer's per-thought saving is therefore a floor, never an
// overstatement of a saving, and no trigger is measured with it.
export const estimateTokensFromChars = (chars: number): number =>
    Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : 0;

// ---------------------------------------------------------------------------
// THE OPT-IN REQUEST WEIGHT (see the header section of the same name)
// ---------------------------------------------------------------------------

// One attachment's DECODED byte length, total over a hostile shape.
//
// `size` is the declared, validated byte length of `data` (../types, `HarnessAttachment`),
// so it is preferred; a restored or hand-built entry that carries only `data` is measured
// from the base64 (`ceil(len * 3 / 4)` is the decoded length it encodes). `0` for anything
// else, including an entry that is `null`, a string, or carries neither field.
export const estimateAttachmentBytes = (attachments: unknown): number => {
    if (!Array.isArray(attachments)) return 0;

    let bytes = 0;

    for (const attachment of attachments) {
        if (attachment === null || typeof attachment !== 'object') continue;

        const entry = attachment as { size?: unknown; data?: unknown };
        const size = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size > 0
            ? Math.floor(entry.size)
            : 0;

        if (size > 0) {
            bytes += size;
            continue;
        }

        if (typeof entry.data === 'string' && entry.data.length > 0) {
            bytes += Math.ceil((entry.data.length * 3) / 4);
        }
    }

    return bytes;
};

// The same bytes expressed as the WIRE BYTES they actually put in the request body: base64
// is 4 characters per 3 bytes, and base64 is pure ASCII, so the wire text and the wire byte
// count are the same number here — which is exactly why the attachment term needs no escaping
// pass. Counting the wire figure (rather than the decoded bytes) is the conservative half of
// the allowance — it is what the transport really serializes — and it keeps the allowance in
// the SAME currency as every other term in this file, so one `/ 4` still converts the whole
// request.
const attachmentWireBytes = (attachments: unknown): number => {
    if (!Array.isArray(attachments)) return 0;

    let bytes = 0;

    for (const attachment of attachments) {
        if (attachment === null || typeof attachment !== 'object') continue;

        const entry = attachment as { size?: unknown; data?: unknown };

        if (typeof entry.data === 'string' && entry.data.length > 0) {
            bytes += entry.data.length;
            continue;
        }

        const size = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size > 0
            ? Math.floor(entry.size)
            : 0;

        if (size > 0) bytes += Math.ceil((size * 4) / 3);
    }

    return bytes;
};

// The extra terms a caller may ask for. EVERY field is off unless asked for, and the
// default is the published heuristic — see the header section for why the conservative
// figure is opt-in rather than the new default.
//
// UNIT NOTE (T5): the two allowances below keep their published `…Chars` NAMES, and are
// charged in the same serialized-payload BYTES as the transcript. The two units are equal
// for the ASCII JSON they are computed from (schemas, framing keys), and
// `toolSchemaPayloadBytes` below removes even that ambiguity for the catalogue.
export type ContextEstimateOptions = {
    /**
     * Add the base64 an attachment puts in the body (per message, from `data`, or derived
     * from `size` when only the byte count survived). Off by default: a context BAR bills
     * media per image, while a "will this fit?" check wants the bytes.
     */
    includeAttachmentBytes?: boolean;
    /**
     * Serialized weight of the tool schemas that ride in the same request body
     * (`tools` / `tool_choice`). The estimator cannot see them at all — they are not in the
     * transcript — and a large registry is the one case where a transcript the estimate calls
     * small still gets a provider 400. Compute it with `toolSchemaPayloadBytes(tools)` rather
     * than by hand; a non-finite or negative allowance is 0.
     *
     * THIS IS THE 31,229-TOKEN FLOOR. Measured on session 6a94b896: a first request the
     * estimator scored 464 tokens was billed 31,693, entirely catalogue + system framing. An
     * unanchored request (turn 1, or a usage-blind provider) can only see that floor if the
     * caller passes this field; an anchored one already carries it inside `anchor.tokens`.
     */
    toolSchemaChars?: number;
    /**
     * A flat allowance for request framing: the JSON keys, roles, separators and per-message
     * envelope the provider tokenizes but this file never sees. A caller that knows its
     * transport's shape may supply a measured figure; a non-finite or negative one is 0.
     */
    requestOverheadChars?: number;
    /**
     * SAFETY MARGIN on the anchored GROWTH term only — see "THE ANCHORED GROWTH MARGIN" in
     * the header. `0` restores the pre-T5 behaviour of extrapolating growth at exactly
     * bytes/4; any value >= 0 is honoured. A non-finite or negative value is ignored in
     * favour of `ANCHOR_GROWTH_MARGIN`, because the measured refusal showed 0 to be the
     * unsafe value. This does NOT touch the unanchored leg, which stays the published figure.
     */
    anchorGrowthMargin?: number;
};

// One finite, non-negative allowance out of an optional field. `NaN`, `Infinity`, a
// negative and a string are all `0`, because an allowance that cannot be trusted must not
// silently change a number a policy is about to act on.
const allowanceOf = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

// The CONSTANT half of an options bag, in PAYLOAD BYTES: the serialized tool catalogue and the
// flat framing allowance. Both are per-REQUEST constants that the transcript pass can never
// show, and both are therefore already inside a provider anchor (`anchor.tokens` is the count of
// a whole request). `options === undefined` is exactly `0`, which is what keeps every legacy
// signature byte-identical.
const constantAllowanceBytes = (options: ContextEstimateOptions | undefined): number => {
    if (options === undefined) return 0;

    return allowanceOf(options.toolSchemaChars) + allowanceOf(options.requestOverheadChars);
};

// The VARIABLE half of an options bag, also in PAYLOAD BYTES: the base64 the attachments in
// THIS transcript put in the body. It is deliberately split from the constant half (X1,
// 2026-11-17 — the anchored-leg currency fix) because the two halves behave differently across
// a conversation: the catalogue is the SAME bytes in every request, while media is APPENDED, so
// the media term is growth. A leg that skips it under-reads the very term it is supposed to be
// measuring — see `estimateContextTokensHybrid`, where the anchored leg takes this half and
// ignores the constant half, and `../plugins/context-compaction.plugin.ts` `measureShrink`,
// which measures every request it shrinks WITH this half.
const variableAllowanceBytes = (
    messages: readonly HarnessMessage[] | undefined,
    options: ContextEstimateOptions | undefined
): number => {
    if (options === undefined || options.includeAttachmentBytes !== true) return 0;
    if (!Array.isArray(messages)) return 0;

    let bytes = 0;

    for (const message of messages) {
        if (message === null || typeof message !== 'object') continue;
        bytes += attachmentWireBytes((message as { attachments?: unknown }).attachments);
    }

    return bytes;
};

// The whole allowance of an options bag, in PAYLOAD BYTES, in the ONE place that reads it:
// constant framing plus per-message media. `options === undefined` (the default for every
// existing caller) is exactly `0`, which is what keeps the legacy signatures byte-identical.
const optionsBytes = (
    messages: readonly HarnessMessage[] | undefined,
    options: ContextEstimateOptions | undefined
): number => constantAllowanceBytes(options) + variableAllowanceBytes(messages, options);

// The serialized-payload weight of ONE message FIELD of unknown shape — the whole reason
// this file is a byte estimator rather than a character one.
//
//   - a string is a JSON string value on the wire, so it is priced by `modelPayloadBytes`
//     (escapes at their escaped width, non-ASCII at its UTF-8 width, lone surrogates at 6);
//   - a number / boolean / bigint is serialized as its own literal text, which is ASCII, so
//     its character length IS its byte count;
//   - anything else (an object or array `content`, the shape a hostile or restored entry can
//     carry) is a nested JSON DOCUMENT, already escaped by the serializer, so it is priced by
//     `utf8ByteLength` of its `JSON.stringify` text — running `modelPayloadBytes` over that
//     text would escape the escapes and double-charge `\n` as `\\n`.
//
// Total, like everything here: `undefined`/`null` are 0 (the transport omits them), and a
// cycle or throwing getter contributes 0 instead of failing the turn boundary.
const bytesOf = (value: unknown): number => {
    if (typeof value === 'string') return modelPayloadBytes(value);
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value).length;
    }

    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? 0 : utf8ByteLength(serialized);
    } catch {
        // A cycle or a throwing getter: the field is unmeasurable, not fatal.
        return 0;
    }
};

// The serialized weight of a whole serialized TOOL CATALOGUE, in this file's currency — the
// number to pass as `ContextEstimateOptions.toolSchemaChars`.
//
// WHY THIS HELPER EXISTS (T5). The catalogue is the largest constant in a request and the one
// thing the transcript can never show: 31,229 billed tokens on session 6a94b896's first round
// against a transcript estimated at 464, and 32,013-32,827 on its four children. A caller that
// wants that floor in the number has to serialize the definitions first, and hand-rolling the
// measure re-imports the exact escaping bug this file exists to stop: `modelPayloadBytes` prices
// a STRING VALUE, while `JSON.stringify(tools)` is already a document, so the catalogue is
// priced with `utf8ByteLength` of the serialized text.
//
// Total: a value that cannot be serialized, `undefined`, and a non-object are all 0 — an
// unknown catalogue must not silently move a trigger.
export const toolSchemaPayloadBytes = (tools: unknown): number => {
    if (tools === undefined || tools === null) return 0;

    try {
        const serialized = JSON.stringify(tools);
        return serialized === undefined ? 0 : utf8ByteLength(serialized);
    } catch {
        return 0;
    }
};

// The serialized-payload weight of ONE transcript entry.
//
// Every field below is priced the way the transport sends it (see `bytesOf`), which is the
// whole T5 change: a tool result carrying quotes, backslashes, newlines or CJK occupies MORE
// in the request body than it has JavaScript characters, and the provider bills the body. The
// measured tax on session 6a94b896 was 1.195x for the round-21 body, 1.325x for the round-14
// body, and 1.786x for one multibyte `read` result (111,369 characters, 198,854 payload bytes).
const messagePayloadBytes = (message: HarnessMessage): number => {
    let total = bytesOf(message.content);

    // Tool-call arguments are provider-visible text and the single largest payload a
    // turn can carry (a big file written through a tool call). `arguments` is a JSON
    // STRING on the wire, so its own quotes and backslashes are escaped a second time —
    // `bytesOf` prices it as a string value, which is exactly that.
    const calls = (message as { toolCalls?: unknown }).toolCalls;
    if (Array.isArray(calls)) {
        for (const call of calls) {
            if (call === null || typeof call !== 'object') continue;
            const entry = call as { name?: unknown; arguments?: unknown };
            total += bytesOf(entry.name) + bytesOf(entry.arguments);
        }
    }

    // Tool results carry their own name on the wire (pairing), and a `name` costs a
    // handful of characters per call — measured, not guessed.
    // The replayed thinking, per the header: on the wire unless this entry's own flag says it was
    // withheld. Read defensively like every other field here — a restored message may carry a number
    // or an object, and only a non-empty STRING is provider-visible text.
    const reasoning = (message as { reasoning?: unknown }).reasoning;
    if (
        typeof reasoning === 'string' &&
        reasoning.length > 0 &&
        (message as { reasoningIncluded?: unknown }).reasoningIncluded !== false
    ) {
        // `modelPayloadBytes`, not `length`: thinking on a reasoning model is prose full of
        // newlines and quotes, i.e. precisely the text whose wire width exceeds its length.
        total += modelPayloadBytes(reasoning);
    }

    const name = (message as { name?: unknown }).name;
    if (typeof name === 'string') total += modelPayloadBytes(name);

    const attachments = (message as { attachments?: unknown }).attachments;
    if (Array.isArray(attachments)) {
        for (const attachment of attachments) {
            if (attachment === null || typeof attachment !== 'object') continue;

            // THE MIME BUG (T5). The shipped shape is `HarnessAttachment.mime`
            // (../types/index.ts:53) and this used to read `mimeType`, so the term this file's
            // own published contract claims to count has been `''` for every attachment the
            // harness ever produced. `mime` wins whenever it is a non-empty string; `mimeType`
            // is the fallback for a host that already hands in that spelling (and for the
            // `mime: ''` a half-normalized record can carry). Exactly ONE term per attachment
            // either way — counting both would bill the same label twice.
            const entry = attachment as { name?: unknown; mime?: unknown; mimeType?: unknown };
            const mime =
                typeof entry.mime === 'string' && entry.mime.length > 0 ? entry.mime : entry.mimeType;

            total += bytesOf(entry.name) + bytesOf(mime);
        }
    }

    return total;
};

// The serialized-payload weight of a whole request — every message plus the leading
// instruction blocks. This is the SAME pass `estimateContextTokens` divides by 4,
// exposed because the hybrid anchor has to be recorded in the SAME currency or the delta
// term would compare bytes with inches.
//
// THE UNIT IS BYTES SINCE T5 (2026-11-17), and the name kept the word "chars" only so the
// published signature and the harness's `pendingRequestChars` / `ContextTokenAnchor.chars`
// fields stay source-compatible. A host that recorded an anchor under the old character
// measure and replays it against the new one UNDER-states `anchor.chars`, which inflates the
// growth term — the safe direction, never the one that hides an overflow.
//
// `instructions` accepts a string or an array of strings because an agent's
// `instructions` is an array (core/agent.ts) while a caller may hold one joined
// string; both mean the same thing here. Total, like the estimator: a hostile or
// restored shape contributes 0 rather than throwing.
export const transcriptChars = (
    messages: readonly HarnessMessage[] | undefined,
    instructions?: string | readonly string[],
    // The opt-in request weight (attachment bytes / tool schemas / framing). Omitted by
    // every existing caller, and `undefined` is exactly the old number.
    options?: ContextEstimateOptions
): number => {
    let bytes = 0;

    // The system/instruction blocks are JSON string values in the same body, so they are
    // escaped like every other string — a system prompt with `\n` separators is bigger on the
    // wire than in memory, and it is in EVERY request of the conversation.
    if (typeof instructions === 'string') bytes += modelPayloadBytes(instructions);
    else if (Array.isArray(instructions)) {
        for (const entry of instructions) bytes += bytesOf(entry);
    }

    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (message === null || typeof message !== 'object') continue;
            bytes += messagePayloadBytes(message);
        }
    }

    // The opt-in terms are added LAST so the per-message pass above stays the published
    // measure, byte for byte, for every caller that does not ask for them.
    return bytes + optionsBytes(messages, options);
};

// Estimated token count of a transcript, optionally plus leading instruction text.
// The ~4 bytes/token heuristic on its own — the number the UI context bar matches, and
// the signature every existing caller (and src/core/context-estimate.test.ts) pins.
//
// Empty input is exactly 0, so a caller can distinguish "nothing to send" from a
// rounding artifact.
//
// PUBLISHED FROM THE ROOT BARREL (issue 0004), so the contract a host may rely on is
// stated here rather than only in the header above: this is an ESTIMATE, derived as
// `ceil(bytes / 4)` over the SERIALIZED-PAYLOAD weight of exactly the text listed under
// WHAT IS COUNTED (message content, tool-call names and raw arguments, the instruction
// strings handed in, an attachment's name and MIME — read as `mime`, with a `mimeType`
// fallback — and a replayed assistant `reasoning` UNLESS that entry carries
// `reasoningIncluded: false`). Bytes means the bytes the JSON body carries, not the
// JavaScript characters: escapes at their escaped width, non-ASCII at its UTF-8 width
// (./payload-bytes.ts). By default this is never attachment BYTES, and never the tool
// schemas that ride in the same request body, which is why the prompt a provider really
// measures is still a little larger than this number — see `toolSchemaChars`. A
// provider's real count is not available before the request, so this costs nothing and
// answers before the round trip.
// It is total — nothing throws — and it is the very
// number `agent({ maxPromptTokens })` / `provider.contextWindow` measure a request
// against (see ../core/agent.ts), which is why a host that trims its own history and
// the package's own floor cannot disagree.
//
// THE EXCEPTION IS THE THIRD PARAMETER: pass `ContextEstimateOptions` and the three things
// the heuristic cannot see (attachment base64, serialized tool schemas, request framing) are
// added as a conservative allowance. Omitted — the default, and every existing call site —
// it is the published figure above and nothing else.
export const estimateContextTokens = (
    messages: readonly HarnessMessage[] | undefined,
    instructions?: string | readonly string[],
    options?: ContextEstimateOptions
): number =>
    // One rule, one implementation: `estimateTokensFromChars` is the shared `/ 4` and
    // `transcriptChars` is the shared weight pass, so the UI bar, the trimmer's floors and
    // this number cannot drift apart. `transcriptChars` returns PAYLOAD BYTES since T5; the
    // divisor is the same rule of thumb either way.
    estimateTokensFromChars(transcriptChars(messages, instructions, options));

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
//
// SINCE T5 that weight is the SERIALIZED-PAYLOAD BYTE count (the name is kept so the
// published field stays source-compatible). Both sides of the delta come from
// `transcriptChars`, so a run that records and reads within one process is consistent by
// construction; see `transcriptChars` for what a pre-T5 recorded value does.
//
// THE PRODUCER, stated because the whole anchored leg depends on it (X1, 2026-11-17). The only
// in-package writer is `../harness.ts` `pendingRequestChars`, set from
// `transcriptChars(requestTranscript, brain.instructions)` — the payload-BYTE weight of exactly
// the body that went out — and `estimateContextTokensHybrid` reads it against that same pass. A
// host that records a raw CHARACTER count here prices every later request BELOW what the provider
// bills, by the escape tax of the anchored prefix; that is the safe direction, and it is why the
// anchored leg prices growth in bytes instead of trusting the field's name (pinned in
// `context-estimate.test.ts`, "THE ANCHORED DELTA IS ONE CURRENCY").
//
// THE ONE ASYMMETRY A CALLER CAN CLOSE. The shipped producer records the body WITHOUT the
// attachment allowance, so an estimate that asks for `includeAttachmentBytes` counts the media
// that was already inside the anchored request a second time on the growth side (an over-count —
// the option publishes itself as an upper bound). A caller that wants the media priced exactly
// once records the base in the SAME currency:
// `anchorFromUsage(usage, transcriptChars(sent, instructions, { includeAttachmentBytes: true }))`.
export type ContextTokenAnchor = {
    /** `HarnessUsage.input`: prompt tokens for the request, INCLUDING a replayed cache prefix. */
    tokens: number;
    /** `transcriptChars()` of that request's transcript — serialized-payload BYTES. */
    chars: number;
};

// The LOW-side sanity floor, expressed as a multiple of the bytes/4 guess for the same
// text. The rule is deliberately asymmetric, because the two error directions are not
// equally dangerous:
//
//   - a count ABOVE the guess is expected and is the whole value of anchoring: the
//     provider is counting what this file cannot see at all — the tool schemas, the
//     message framing, a tokenizer that runs denser on code and CJK. Refusing those
//     would throw away the anchor in exactly the conversations that need one, so any
//     positive count is adopted. Measured: 31,693 billed against a 464 guess (68.3x) on
//     session 6a94b896 round 1, and adopting that number is what carries the 31,229-token
//     catalogue floor into every later round of that run.
//   - a count far BELOW the guess means the number is not the prompt size of THIS text
//     at all: a provider reporting only the uncached delta, a proxy zeroing a field it
//     does not parse, a wire field that arrived as something else. Anchoring on that
//     UNDER-states the context, which is the direction that lets a conversation run
//     into an oversized request — the failure this estimator exists to catch early.
//
// 1/4 of the guess means "at most 16 bytes per token", which is looser than any
// real tokenizer (sparse prose is ~6-8). Refusing is not a failure: the caller simply
// keeps the heuristic it has always used.
const ANCHOR_MINIMUM_RATIO = 4;

// The safety margin on the anchored GROWTH term, as a fraction of that growth.
//
// WHERE THE NUMBER COMES FROM, stated because a constant a policy acts on has to carry its
// evidence. On session 6a94b896 (`Temp/d1/report.md`), round 21: the provider billed 225,612
// tokens for a body the anchored bytes/4 estimate placed at 193,428 — a residual of
// 225,612 / 193,428 = 1.166. The serialized-payload weight fixes the ESCAPE half of that gap
// (the body's 539,258 characters really are 644,341 payload bytes), but the rest is tokenizer
// density, which no character or byte rule can see: the 234,170 payload bytes added between
// rounds 20 and 21 were billed at 88,118 tokens, i.e. 2.66 payload bytes per token, because
// escape-heavy JSON text tokenizes denser than prose.
//
// 0.166 is therefore the measured worst-case residual on a growth term, not a round number.
// Applied, the replay of all 21 measured rounds lands at mean signed error -331 tokens with a
// worst case of +5,639 over / -19,857 under (against -4,323 mean and -32,215 worst under
// before), and the 200,000 trigger crosses at round 21 — the request BEFORE the one the
// provider refused. `ContextEstimateOptions.anchorGrowthMargin` re-tunes it; `0` is the
// pre-T5 behaviour the same replay shows fires one request too late.
const ANCHOR_GROWTH_MARGIN = 0.166;

// The margin out of an options bag: honoured at 0 and above, and falling back to the
// measured constant when the value cannot be trusted (`NaN`, `Infinity`, a negative, a
// string). Falling back to the CONSTANT rather than to 0 is deliberate: 0 is the value the
// measured refusal proved unsafe, and an untrustworthy number must not silently move a
// trigger.
const anchorMarginOf = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : ANCHOR_GROWTH_MARGIN;

// Turns one reported `usage` block into an anchor for the request that produced it.
//
// `requestChars` MUST be the `transcriptChars()` of the transcript that was actually
// sent, measured BEFORE the response was appended (since T5 that is the payload-byte
// weight, and it is what `../harness.ts` `pendingRequestChars` already holds). Returns
// `undefined` (keep the heuristic) for a provider that reports nothing, reports a
// non-finite or non-positive `input`, or reports a count implausibly BELOW the bytes/4
// guess for that text — see `ANCHOR_MINIMUM_RATIO` for why the check is one-sided.
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
    const heuristic = Math.ceil(chars / BYTES_PER_TOKEN);

    // A zero-char prefix has no heuristic to be sane against — the reported count is
    // then the framing/tool-schema overhead the heuristic cannot see at all, which is
    // precisely the information worth keeping.
    if (heuristic > 0 && tokens * ANCHOR_MINIMUM_RATIO < heuristic) return undefined;

    return { tokens, chars };
};

// The hybrid estimate: `anchor`'s real count plus the text that arrived since, priced at
// bytes/4 and multiplied by the measured safety margin. With no anchor it is byte-for-byte
// the heuristic above, so a first turn, a usage-blind provider and a host that never wires
// the anchor all keep the published number.
//
// THE REQUIREMENT THIS MEETS (T5, after the refusal): once a provider has reported a real
// `usage.input` for a request whose content is a PREFIX of the one about to be sent, the
// answer is never below `anchor.tokens + ceil(serializedGrowth / 4)`. The margin is a
// non-negative multiplier on the same growth term, so the floor holds by construction for
// every margin >= 0 — and the replay in `context-estimate.test.ts` asserts it round by round
// against the 20 real usage rows, not just the one that failed.
//
// Why the delta term is the whole design: the error of the heuristic is dominated by what it
// cannot see at all (schemas, framing, the tokenizer's real rate), and that error is CONSTANT
// for a conversation whose prefix is unchanged. Anchoring cancels the constant; only the
// freshly-appended text is still guessed, and it is the smallest part of a long conversation.
export const estimateContextTokensHybrid = (
    messages: readonly HarnessMessage[] | undefined,
    instructions?: string | readonly string[],
    anchor?: ContextTokenAnchor,
    // The opt-in request weight. The split is by BEHAVIOUR ACROSS A CONVERSATION, not by option
    // name (X1, 2026-11-17). The CONSTANT allowances — `toolSchemaChars` and
    // `requestOverheadChars` — move ONLY the unanchored leg: `anchor.tokens` is the provider's own
    // count of a prefix of THIS request, so it already contains the schemas and the framing, and
    // adding them again on top of an anchor would bill the same constant twice (see "THE OPT-IN
    // REQUEST WEIGHT" in the header). The VARIABLE allowance — `includeAttachmentBytes`, the
    // base64 in the body — moves BOTH legs, because media is appended text: an anchored request
    // that grew by a screenshot grew by its wire bytes, and a leg that ignored them would price a
    // smaller quantity than the unanchored leg and than the compaction plugin that shrinks the
    // same request. The ONE other field the anchored leg reads is `anchorGrowthMargin`, which is
    // not an allowance — it re-tunes the growth term this function is built on.
    options?: ContextEstimateOptions
): number => {
    // ONE CURRENCY, BOTH LEGS (X1, 2026-11-17). Every quantity below is a SERIALIZED-PAYLOAD
    // BYTE figure from the same pass (`transcriptChars`), plus the allowance terms that are also
    // payload bytes. The split matters for the anchored leg: the CONSTANT half of the allowance
    // (catalogue, framing) is already inside `anchor.tokens`, while the VARIABLE half (the base64
    // of an attachment) is appended like any other text and is therefore growth — leaving it out
    // made the anchored leg price a different quantity than the unanchored leg, and a different
    // quantity than `../plugins/context-compaction.plugin.ts` `measureShrink` prices the same
    // request with. `weight` here and `ContextTokenAnchor.chars` (recorded by `anchorFromUsage`
    // from `../harness.ts` `pendingRequestChars`, which is the SAME `transcriptChars` call) are
    // byte-currency on both sides of the delta; a character base would inflate the growth term by
    // the whole escape tax of the anchored prefix, and the pinned case in this file's
    // "THE ANCHORED DELTA IS ONE CURRENCY" block is what proves the pair stays aligned on
    // escaped and multibyte text, which the ASCII-only calibration rows cannot see.
    const weight = transcriptChars(messages, instructions);
    const media = variableAllowanceBytes(messages, options);
    const allowance = constantAllowanceBytes(options) + media;

    if (anchor === undefined || !Number.isFinite(anchor.tokens) || anchor.tokens <= 0) {
        return Math.ceil((weight + allowance) / BYTES_PER_TOKEN);
    }

    const base = Number.isFinite(anchor.chars) && anchor.chars > 0 ? Math.floor(anchor.chars) : 0;

    // THE GROWTH MEASURE. `base` is the body of the anchored request as the harness recorded it,
    // i.e. WITHOUT the media term (the harness prices the media into `anchor.tokens` only). So a
    // media entry that was ALREADY in the anchored request is counted again on the growth side —
    // an over-count, and the deliberate direction: `includeAttachmentBytes` publishes itself as
    // an UPPER bound for a "will this request be refused?" check (see "THE OPT-IN REQUEST
    // WEIGHT" in the header), and the only other option is to under-read a body the provider
    // really did receive, which is the error direction the measured refusal proved fatal.
    const delta = weight + media - base;
    const margin = anchorMarginOf(options?.anchorGrowthMargin);

    // A NEGATIVE delta means the transcript is now SHORTER than the anchored prefix (a
    // withheld unit, an edited message). It is NOT growth, so the margin is not applied to it:
    // multiplying a negative would EXAGGERATE the shrink, and `Math.ceil` rounds a negative
    // toward zero, i.e. the shrink is discounted rather than exaggerated — the conservative
    // direction for a number a pruning policy measures its savings with.
    const growth = delta >= 0
        ? Math.ceil((delta * (1 + margin)) / BYTES_PER_TOKEN)
        : Math.ceil(delta / BYTES_PER_TOKEN);

    const anchored = Math.max(0, Math.trunc(anchor.tokens) + growth);

    // THE SANITY CLAMP, and why it sits at `plain / ANCHOR_MINIMUM_RATIO` rather than at the
    // plain heuristic: `anchorFromUsage` accepts an anchor only while it is not more than
    // ANCHOR_MINIMUM_RATIO (4x) below the byte/4 guess for the text it was measured over, so a
    // provider reporting only its uncached delta (or a proxy zeroing a field it does not parse)
    // never reaches this function at all — it is refused and the caller keeps the plain
    // estimate. What CAN still reach here is an accepted anchor that has since been outgrown:
    // the clamp keeps the answer above the same 16-bytes-per-token boundary the anchor was
    // admitted at, so no anchor can push the estimate below a rate no real tokenizer runs.
    //
    // It is deliberately NOT the plain heuristic itself. The T5 requirement is that the anchor
    // is AUTHORITATIVE — `lastBilledInput + measuredSerializedGrowth (+ margin)` — and a
    // provider legitimately running denser than 4 bytes/token bills ABOVE that line while a
    // provider running sparser (prose, repetitive text) legitimately bills below it: pinning the
    // floor at the plain figure would re-impose the heuristic the anchor exists to replace, and
    // it fails the published `harness.budget.test.ts` case "adopts an anchor BELOW the heuristic
    // when the text can support it" (4014 payload bytes, 900 billed, 904 expected — the 904 is
    // 900 plus the margined growth term, `ceil(12 * 1.166 / 4)`). In the measured
    // replay this clamp never binds: the anchored line is 205,755 at round 21 against a plain
    // weight of 161,086 (see the calibration block in the test file).
    return Math.max(Math.ceil(Math.ceil(weight / BYTES_PER_TOKEN) / ANCHOR_MINIMUM_RATIO), anchored);
};
