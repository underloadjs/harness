// Model-facing tool-result budget (R10) — per result AND per turn.
//
// Every tool result and every tool ERROR the harness feeds back to the model is
// TEXT on the wire. A single tool can return — or throw — something enormous:
// `read` of a 20 MB log, a command that dumps a build log into a failure
// message, a web page pasted into a search snippet. That text is then replayed
// on EVERY subsequent request of the conversation, so one unbounded result can
// exceed the model's context window and end the session with a transport error
// the model can never recover from.
//
// This module is the single global cap for that surface:
//
//   - small results pass through EXACTLY unchanged (byte for byte): every
//     existing tool result a model or a test has ever seen keeps its shape;
//   - a NON-JSON result (prose, a log, a build output) that exceeds the budget becomes
//     a SMALL, VALID JSON envelope that names the truncation, the original size, the
//     applied budget, a head preview, a tail preview, and a plain-language note saying
//     what is missing and how to fetch it again — a head/tail envelope is honest for
//     text, because both previews are still the tool's own characters;
//   - a result that IS a JSON document and exceeds the budget is REFUSED, not cut
//     (F-CUTTER, see the section below): the delivery is the short refusal sentence and
//     the outcome is a failed tool result, because a middle-cut JSON document is not
//     JSON and no preview recovers the fields that fell in the hole;
//   - the cap is applied to serialized TEXT, so it covers ordinary values, plain
//     prose, and error messages with one rule;
//   - the per-result cap is joined by an AGGREGATE per-turn cap
//     (`MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES`, applied through
//     `createToolResultTurnBudget` at the delivery sites in ../harness.ts), so
//     N parallel tool calls can no longer commit N x 256 KiB in one turn.
//
// WHY THE ENVELOPE SPILLS A HEAD AND A TAIL INSTEAD OF CUTTING MID-STRING
// -----------------------------------------------------------------------
// A prefix-only cut is the least useful thing a bound can do with a large
// result: the beginning of a log is its header and the interesting part is at
// the end (the error, the summary, the closing brace). The envelope therefore
// keeps ~3/4 of the allowance from the start and ~1/4 from the end and says
// exactly how many bytes sit between them. `content` stays the HEAD preview
// (the key a model and every existing consumer already reads), `tail` is the
// new key, and `note` is the "where is the rest" line — the honest answer being
// that the full text is NOT in this transcript any more, so the only way back
// is to re-run the call, which is the "re-fetchable" condition the compaction
// policy in ../docs/tasks/2026-11-09-progressive-compaction.md F5 depends on.
//
// WHY A JSON DOCUMENT IS REFUSED RATHER THAN CUT (F-CUTTER, 2026-11-25)
// ---------------------------------------------------------------------
// The head/tail envelope is honest for TEXT and dishonest for a STRUCTURE. A cut log
// page still shows the log; a cut JSON document shows nothing a consumer can use,
// because the preview pair is two halves of one value and the hole in the middle has
// no cursor pointing at it. A probe (`Temp/fix-cutter/repro.ts`, run against the
// shipped cutter before this change) delivered a 71,142-byte record page as
// `content` = 19,905 bytes ending "Unterminated string in JSON at position 19905" and
// `tail` = 6,636 bytes starting with a run of `k`s: `JSON.parse` fails on BOTH
// previews, `isError` was false, and the 44,601 bytes in the hole — whichever records
// and fields they were — were gone without a marker. That is the finding this rule
// closes: the model is handed two slices of a document, believes it received a result,
// and cannot tell which ids it never saw.
//
// So the decision is made ONCE, in `boundWithReason`, on the one question that can be
// answered without guessing: does this text parse as a JSON document? If it does, the
// result is REFUSED — the model gets the short refusal sentence (`refusalMessage`) and
// the delivery is classified `failed`, which is the only outcome that already carries
// an error to a model, a UI and a retry. If it does not parse, nothing about the
// existing envelope changes.
//
// Two consequences, stated rather than discovered later:
//   1. A tool whose own output cap is ABOVE this cap (grep budgets 64 KiB of match
//      text, `FILE_GREP_CONTENT_BUDGET`) can now be refused where it used to be cut.
//      That is the same information — the page did not fit — delivered honestly; the
//      fix for the tool is to page (or to raise the harness cap), not to be handed a
//      half-document.
//   2. Refusal is only sound because the result is DELIVERED as an error rather than
//      dropped: the provider still gets an answer for the call (the pairing rule in
//      `ToolResultTurnBudget`), the refusal names the call and the narrowing that fits,
//      and the ledger charges the refusal, not the discarded document, so one oversized
//      result cannot spend a turn's whole aggregate.
//
// Two honest limitations, stated here because the cap is easy to oversell:
//
//   1. It is a POST-SERIALIZATION cap. The tool's value and its JSON string are
//      fully allocated before this runs, so the cap bounds the conversation's
//      token cost, NOT the process's peak memory. A tool that wants to avoid
//      allocating gigabytes must bound its own work (read's content budget
//      does exactly that).
//   2. It only bounds the MODEL-facing text. Declarative UI panels travel on a
//      separate `ui` field and are bounded by core/tool-ui.ts instead; the two
//      limits are deliberately independent.
//   3. The aggregate guard SHRINKS results, it never drops one — with the JSON rule
//      above, it never withholds an ANSWER either: a JSON document it cannot fit is
//      answered by the refusal sentence, and that sentence is what gets booked. A
//      provider request must answer every `tool_calls[]` entry (core/../types pairing),
//      so the last delivery of an over-budget turn still pays its envelope
//      overhead: the per-turn total is a soft bound, exceeded by at most one
//      envelope (~a few hundred bytes) per result past the line.
//   4. It bounds one RESULT and one TURN, not the conversation. Nothing in this
//      module can: the transcript replays every past result on every later
//      request, so N turns of a budget-sized result cost N x the budget however
//      carefully each turn was bounded. That is what the context trimmer and the
//      compaction plugin own; the numbers below only have to be small enough that
//      a handful of turns does not spend the window (see the token sizing).
//
// WHAT T3 CHANGED, AND WHY (2026-11-17)
// -------------------------------------
// A context-explosion post-mortem (session `6a94b896-…`) measured 843,987 bytes of
// `tool`-role messages in a root thread — 88.9% of the conversation, 73.4% of it a
// single tool — with three messages of 257,074 / 228,928 / 198,958 bytes. Every one
// of those messages was INSIDE the cap that was supposed to stop it, and the fix had
// to be made in the two places the cap was wrong rather than in the tool:
//
//   1. The cap was measured on the wrong number. `boundToolResult` compared
//      `utf8ByteLength(content)` — the text's own bytes — against the budget, while
//      the number the provider bills is that text after JSON escaping, because a
//      tool result becomes `HarnessMessage.content` and `content` is serialized as a
//      JSON string. The gap is the escape table in ./payload-bytes.ts: measured on
//      this very failure, +11,458 bytes (+4.7%) on a big `read` message and +10,458
//      (+4.8%) on an escape-heavy one, up to 6x per character for control bytes. A
//      "262144-byte" cap therefore authorized ~274 KB of body. The cap is now
//      measured with `modelPayloadBytes` — the final serialized payload — so the
//      declared budget and the billed bytes are the same number.
//   2. The cap was 2022-sized. 256 KiB per result is ~64k tokens and 512 KiB per
//      turn ~128k tokens, against a shipped context limit of 200,000 tokens
//      (`CONTEXT_LIMIT_DEFAULT`, ../plugins/context-compaction.plugin.ts). A single
//      tool result was allowed a third of the window, so three ordinary turns of one
//      result each ended the session without any cap ever firing. The defaults are
//      now stated in TOKENS and derived from that limit (see `MODEL_TOKEN_BYTES` and
//      `toolResultBudgetsForContextTokens`), and they stay per-call parameters, so an
//      operator with a bigger window raises the fraction, not a magic byte count.
//
// One thing the post-mortem did NOT turn out to be, recorded because the hypothesis
// cost someone a detour: the "357x / 2287x escaping multiplication" was not escaping.
// `read` answers a BATCH of paths in one message, and the byte figure the tool prints
// is PER ENTRY (`returned 87 bytes` was one of 27 windows). One level of JSON escaping
// on those inputs costs 1.08x (multibyte) to 1.5x (quote/backslash-heavy), and the
// whole message measured 1.01x-1.08x of the bytes the tool emitted. The mass was
// simply N windows times a per-window allowance, under an aggregate cap nobody could
// see in the transcript. `read` now charges its model projection in this module's
// currency and prints the aggregate it spent (see its `batchSummary`), so the mass is
// both bounded and visible.
//
// Cross-references:
//   - ../harness.ts    — applies the per-turn ledger to every tool result and tool error
//   - ./payload-bytes.ts — the byte measures this module enforces with
//   - ./tool-ui.ts     — the separate panel bounds
//   - ../types         — the tool_result event whose `content` is this text

// The two byte measures, from the one module that owns them:
//   - `utf8ByteLength`    — the TEXT's own cost. Used for the numbers the envelope's
//     note quotes ("cut 64071 of 300000 bytes"), because those describe the tool's
//     text, and for nothing that gates a cut.
//   - `modelPayloadBytes` — the cost of that text once it is serialized into the
//     request body. THIS is the budget currency (T3, see the header): the cap and the
//     shrink loops below compare against it, so `content` never exceeds the budget the
//     caller declared no matter how much escaping the payload needs.
// `utf8ByteLength` is re-exported from here because it always was this module's
// public measure (./command-builtins.ts and ./index.ts import it by name).
import { modelPayloadBytes, utf8ByteLength } from './payload-bytes';

export { modelPayloadBytes, utf8ByteLength };

// The convention every model-facing byte budget in this package converts with. The
// whole codebase sizes context as `ceil(chars / 4)` (see ./context-estimate.ts:24-28
// and ../frontend/ui/turns.ts), so 4 BYTES is one token wherever a byte figure has to
// become a token figure. Written down once so the two conventions cannot drift.
export const MODEL_TOKEN_BYTES = 4;

// The context window the shipped defaults are sized against. It MIRRORS
// `CONTEXT_LIMIT_DEFAULT` in ../plugins/context-compaction.plugin.ts (200000), and it
// is a literal rather than an import on purpose: core/ may not depend on the plugin
// tree, and a plugin default is an operator setting, not a kernel fact. If that
// default moves, the two numbers have to move together — `result-budget.test.ts`
// pins this one so the drift is loud.
export const DEFAULT_MODEL_CONTEXT_TOKENS = 200_000;

// The token figures are the decision; every byte number in this module is derived
// from them. The per-turn number is a whole multiple of the per-result number on
// purpose, so "how many full results fit in one turn?" has one answer for every
// window: `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_TOKENS / MODEL_TOOL_RESULT_BUDGET_TOKENS`
// = 3.
//
// These are the T3 numbers. The defaults before it (256 KiB and 512 KiB) were written
// when "a big context" meant 8k-32k tokens and were never re-derived against the
// 200,000-token window this harness ships with: they allowed one result a third of the
// window and one turn two thirds of it. The module's own comment conceded the
// aggregate was unreachable — "512 KiB is ~128k tokens of prose: more than any
// realistic context window can give a single turn" — and that is an argument for
// lowering it, not for keeping it.
//
//   - ~4% of the window for one result: 8,192 tokens. A `read` window, a grep body, a
//     build-log tail. Big enough to answer a question about a file, small enough that
//     a result which does fit is a result the model can still act on the same turn.
//   - ~12% for one turn: 24,576 tokens, i.e. three full results. A turn is what the
//     model pays for a round trip, and a parallel block of tool calls is exactly the
//     shape that used to commit N x 256 KiB in one step.
export const MODEL_TOOL_RESULT_BUDGET_TOKENS = 8_192;
export const MODEL_TOOL_RESULTS_PER_TURN_BUDGET_TOKENS = 24_576;

// The same two decisions expressed as RATIOS of the shipped window, so
// `toolResultBudgetsForContextTokens` sizes a different window by the same rule and
// cannot drift from the defaults: applied to `DEFAULT_MODEL_CONTEXT_TOKENS` it returns
// the byte constants below exactly (0.04096 ~= 4%, 0.12288 ~= 12%).
export const MODEL_TOOL_RESULT_BUDGET_SHARE = MODEL_TOOL_RESULT_BUDGET_TOKENS / DEFAULT_MODEL_CONTEXT_TOKENS;
export const MODEL_TOOL_RESULTS_PER_TURN_BUDGET_SHARE = MODEL_TOOL_RESULTS_PER_TURN_BUDGET_TOKENS / DEFAULT_MODEL_CONTEXT_TOKENS;

// The smallest budgets the sizing will hand out, whatever the window: a caller sizing
// against a 2,000-token window would otherwise get an 80-byte per-result budget, below
// the spill envelope's own overhead (~250 bytes), which means an envelope that cannot
// contain its own note. Both floors sit above `SPILL_MIN_BUDGET_BYTES`, so a bounded
// result always keeps a head, a tail and a note.
const RESULT_BUDGET_MIN_BYTES = 4 * 1024;
const TURN_BUDGET_MIN_BYTES = 8 * 1024;

// One result's budget, in the units the cap is enforced in: the model-facing
// (JSON-escaped) bytes of the text that becomes `HarnessMessage.content`.
//
// 32 KiB is ~8k tokens of prose and 4% of the shipped 200k window. The number is
// DERIVED below from the token figures rather than written out, because the token
// figure is the decision and the byte figure is its consequence.
//
// It is 8x SMALLER than the number it replaces, and the two consequences have to be
// read together:
//   - a tool result that used to arrive whole is now envelope-cut at 32 KiB, which is
//     the whole point — a 250 KB result that "arrives whole" is a result the model
//     cannot afford to have read;
//   - `read` caps its own output at this number (see FILE_READ_WIRE_BUDGET in
//     ../tools/files/read.tool.ts), so a full-budget read still survives the harness
//     envelope byte for byte, which is the property that number exists to keep.
//
// KEEP THIS IN SYNC with `tool_result_bytes` in ../shared/harness-api.ts, the number
// the HTTP boot document publishes: the manual tool route bounds its response with
// `boundToolResult(text)` at THIS default and `src/server/api.test.ts` asserts the two
// are equal, so raising one without the other makes the published contract lie.
export const MODEL_TOOL_RESULT_BUDGET_BYTES =
    MODEL_TOOL_RESULT_BUDGET_TOKENS * MODEL_TOKEN_BYTES;

// The aggregate sibling of the cap above (compaction T5.2): the most TOTAL
// tool-result payload one turn may commit, summed over every call the model asked
// for in one assistant message.
//
// 96 KiB is ~24k tokens and 12% of the shipped window: three full results. Two
// numbers used to be needed to explain why 512 KiB was right ("one full-budget read
// plus one more large result still fits UNCHANGED"); with a per-result budget of
// 32 KiB the same sentence is "three results", and the arithmetic fits in a turn.
export const MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES =
    MODEL_TOOL_RESULTS_PER_TURN_BUDGET_TOKENS * MODEL_TOKEN_BYTES;

// The two budgets for a window the operator configured differently, sized from the
// same shares the shipped defaults use. A host whose model has a 32k window gets
// 1.3k/3.9k-token budgets instead of inheriting a number sized for 200k, and a host
// with a 1M window is not punished for it.
//
// `contextTokens` is the window in TOKENS (the unit `contextLimit` is set in). A
// non-finite or non-positive value falls back to the shipped default rather than
// returning a degenerate budget: callers pass an operator number here, and an
// operator who typed `0` means "use the default", the same reading
// `createToolResultTurnBudget` gives a disabled aggregate.
export const toolResultBudgetsForContextTokens = (
    contextTokens: number = DEFAULT_MODEL_CONTEXT_TOKENS
): { perResultBytes: number; perTurnBytes: number } => {
    const tokens = Number.isFinite(contextTokens) && contextTokens > 0 ? contextTokens : DEFAULT_MODEL_CONTEXT_TOKENS;

    const perResult = Math.max(RESULT_BUDGET_MIN_BYTES, Math.floor(tokens * MODEL_TOKEN_BYTES * MODEL_TOOL_RESULT_BUDGET_SHARE));
    const perTurn = Math.max(TURN_BUDGET_MIN_BYTES, Math.floor(tokens * MODEL_TOKEN_BYTES * MODEL_TOOL_RESULTS_PER_TURN_BUDGET_SHARE));

    // The per-turn aggregate must always be able to hold at least one full result,
    // or the ledger would spill a result that fits on its own — a budget the model
    // cannot satisfy by behaving better.
    return { perResultBytes: perResult, perTurnBytes: Math.max(perTurn, perResult) };
};

// The floor for an aggregate spill (see `ToolResultTurnBudget`). Once a turn's
// aggregate headroom is down to a handful of bytes, spilling to exactly that
// many produces an envelope whose OWN overhead no longer fits, i.e. a cut that
// saves nothing. So a spilled result never gets a budget smaller than this:
// it is comfortably above the envelope's fixed overhead (~250 bytes), which
// leaves room for at least a few characters of the head preview plus the note.
const SPILL_MIN_BUDGET_BYTES = 512;

// Head/tail split of the preview allowance. Three quarters of the surviving
// budget goes to the beginning because that is where a structured result keeps
// its keys and a log keeps its identification; the remaining quarter goes to
// the end because that is where an error, a summary or a closing brace lives.
const HEAD_PREVIEW_RATIO = 3;
const TAIL_PREVIEW_RATIO = 1;

// Keys of the truncation envelope. They are stable because a model may parse a
// truncated result and a test asserts the exact shape. `content` is the HEAD
// preview: the key predates the head/tail split and every existing consumer
// reads the beginning of the result from it, so renaming it would break a
// documented contract for a cosmetic gain.
const TRUNCATED_KEY = 'truncated';
const ORIGINAL_BYTES_KEY = 'originalBytes';
const BUDGET_BYTES_KEY = 'budgetBytes';
const NOTE_KEY = 'note';
const CONTENT_KEY = 'content';
const TAIL_KEY = 'tail';

// The result of applying the budget. `content` is what goes on the wire;
// `truncated` and `originalBytes` let a caller (the server, a test) report that
// a cap was applied without re-measuring the string.
//
// `originalBytes` is UTF-8 bytes of the TEXT (the figure the envelope's note quotes
// and the figure `src/server/api.test.ts` pins). The budget it was compared against is
// NOT in that unit: it counts serialized payload bytes, so the two numbers answering
// "how big was it" and "how big is allowed" are deliberately different — see the note
// on `spillNote` and the T3 section of this file's header.
//
// `rejected` (F-CUTTER) is the discriminator for the OTHER outcome: the content was a
// JSON document too large to deliver, so `content` is the refusal sentence, `truncated`
// is FALSE (nothing was cut — the document was dropped whole), and `rejected` carries
// the sizes and the message. A caller that only reads `content` delivers the honest
// sentence by accident; a caller that can change an outcome (`../harness.ts`,
// `src/server/api.ts`) branches on this field.
export type BoundedToolResult = {
    content: string;
    truncated: boolean;
    originalBytes: number;
    rejected?: ToolResultRejection;
};

// Why a result was refused rather than bounded, and everything a caller needs to say
// so: the two sizes (text bytes vs the payload budget that was applied) and the exact
// sentence that is being delivered, so a host does not re-derive it and drift.
export type ToolResultRejection = {
    reason: 'oversized-json';
    originalBytes: number;
    budgetBytes: number;
    message: string;
};

// Which call produced a result, so the envelope can name what to re-run. The
// harness knows both at every delivery site; other callers (the manual tool
// route) may know neither, and the note degrades to "re-run the call". BOTH fields
// are optional on purpose: a caller that holds only an id or only a name still gets a
// useful address, and `sourcePhrase` renders whichever half exists rather than making
// a partial identity a type error at the call site.
export type ToolResultSource = {
    name?: string;
    callId?: string;
};

export type ToolResultBoundOptions = {
    /** Names the producing call in the envelope's `note` (T5.1). */
    source?: ToolResultSource;
};

// Why a result was cut. Internal to this module: it only selects the wording of
// the note, so the two different caps that can bound one result are never
// confused by the model that reads the envelope.
type SpillReason = 'cap' | 'aggregate';

// Drop a trailing lone high surrogate. Slicing by code unit can split a
// surrogate pair; leaving half of one in the envelope would make JSON.stringify
// emit a `\ud800` escape, which is valid JSON but not the text the tool produced.
const trimBrokenSurrogate = (value: string): string => {
    if (value.length === 0) return value;
    const last = value.charCodeAt(value.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
};

// The mirror image, for the TAIL preview: a slice taken from the end can start
// on the low half of a surrogate pair.
const trimBrokenLeadSurrogate = (value: string): string => {
    if (value.length === 0) return value;
    const first = value.charCodeAt(0);
    return first >= 0xdc00 && first <= 0xdfff ? value.slice(1) : value;
};

// The address the model can act on. Naming the tool and the call id is the
// whole point of T5.1: an envelope that says "600 KB were omitted" without
// saying how to get them back is a worse version of the cut it replaces.
const sourcePhrase = (source?: ToolResultSource): string => {
    const name = typeof source?.name === 'string' && source.name.length > 0 ? source.name : undefined;
    const callId = typeof source?.callId === 'string' && source.callId.length > 0 ? source.callId : undefined;

    if (name === undefined && callId === undefined) return 'the tool call';
    if (name === undefined) return `the call ${String(callId)}`;
    if (callId === undefined) return `tool '${name}'`;

    return `tool '${name}' (call ${callId})`;
};

// The JSON question, answered once per over-budget result (F-CUTTER).
//
// WHY THE CHEAP PRE-FILTER. Parsing is the only reliable test — `JSON.parse` is the
// definition of "is a JSON document" — but an over-budget result is often megabytes of
// build log, and a prose log never parses: its first non-whitespace character cannot
// begin a JSON value. Testing that character first keeps the parse off every prose and
// log delivery, and it is only a PRE-filter: whatever survives it still has to parse,
// so a brace inside a prose sentence cannot buy a false refusal. JSON's own whitespace
// set (space, tab, CR, LF) is skipped by code-point, not by `trimStart`, so a
// megabyte-scale string is scanned without allocating a copy of itself.
const isJsonWhitespace = (code: number): boolean =>
    code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

// The characters that can BEGIN a JSON value: `{` object, `[` array, `"` string, `-` or a
// digit for a number, and the first letter of the three literals (`true`, `false`, `null`).
const startsJsonValue = (first: string): boolean =>
    first === '{' ||
    first === '[' ||
    first === '"' ||
    first === '-' ||
    first === 't' ||
    first === 'f' ||
    first === 'n' ||
    (first >= '0' && first <= '9');

const isJsonDocument = (content: string): boolean => {
    let start = 0;

    while (start < content.length && isJsonWhitespace(content.charCodeAt(start))) start += 1;
    if (start >= content.length) return false;
    if (!startsJsonValue(content.charAt(start))) return false;

    try {
        JSON.parse(content);
        return true;
    } catch {
        // The overwhelmingly common case for real payloads: a document the parser gave
        // up on. Not a signal of anything wrong, so no rethrow and no log.
        return false;
    }
};

// The refusal sentence (F-CUTTER). Same discipline as `spillNote`: exact numbers, no
// locale-dependent prose, and the address the model can act on. It has to carry four
// things, because it is the only thing the model will ever learn about this call:
//   - that the result is GONE rather than shortened, so the model does not read a
//     missing field as an empty one;
//   - both sizes, so the model can pick an argument set that fits;
//   - the narrowing that fits (limit / ids / fields), which is the actionable half;
//   - the write-safety warning, because a discarded RESULT does not undo a completed
//     WRITE — the tool may have committed the change and only its receipt is missing.
//
// Units follow `spillNote`: `originalBytes` is UTF-8 bytes of the tool's text,
// `budgetBytes` is the payload budget that was applied (the aggregate case says so out
// loud, the way the spill note does, so a turn-level squeeze is not read as a second
// per-result cap the operator never set).
const refusalMessage = (
    originalBytes: number,
    budgetBytes: number,
    reason: SpillReason,
    aggregateBytes: number | undefined,
    source: ToolResultSource | undefined
): string => {
    const cap =
        reason === 'aggregate' && aggregateBytes !== undefined
            ? `against the ${budgetBytes} bytes this turn had left of its ${aggregateBytes}-byte per-turn cap`
            : `against a ${budgetBytes}-byte budget`;

    return (
        `Tool result too large to deliver: ${originalBytes} bytes ${cap}. The result was discarded, not truncated: ` +
        `no part of it reached this transcript. Re-run ${sourcePhrase(source)} with narrower arguments ` +
        '(smaller limit, fewer ids, narrower fields) to fetch it. If this call could have written anything, that write ' +
        'may already be applied — re-read before retrying.'
    );
};

// The honest line: what was dropped, which cap did it, and where the rest is.
// Numbers only — no prose that could drift with a locale — because a model
// parses this and a test asserts it byte for byte.
//
// THE UNITS, stated because a byte figure that means two things means nothing: the
// three numbers this line quotes (`omittedBytes`, `originalBytes`, and the two
// preview sizes) are UTF-8 BYTES OF THE TOOL'S TEXT — that is what a reader is
// reasoning about when it asks "how much of the file did I not get". The
// `${budgetBytes}` figure beside them is a PAYLOAD budget, i.e. the escaped bytes the
// model is charged (T3). They differ by the escape factor, and the envelope's JSON
// number `budgetBytes` is machine-readable for exactly that reason: a client asserts
// on it (`src/server/api.test.ts`) and does not read it as prose.
const spillNote = (
    originalBytes: number,
    budgetBytes: number,
    headBytes: number,
    tailBytes: number,
    omittedBytes: number,
    reason: SpillReason,
    aggregateBytes: number | undefined,
    source: ToolResultSource | undefined
): string => {
    // `budgetBytes` for an aggregate spill is the HEADROOM the turn's ledger handed
    // out, so the note attributes it to the per-turn cap rather than to a second
    // per-result limit an operator never configured.
    const cap =
        reason === 'aggregate' && aggregateBytes !== undefined
            ? `by a ${budgetBytes}-byte budget set by this turn's ${aggregateBytes}-byte per-turn cap`
            : `by a ${budgetBytes}-byte cap`;

    return (
        `Cut ${omittedBytes} of ${originalBytes} bytes from the middle ${cap}; kept a ${headBytes}-byte head ` +
        `and a ${tailBytes}-byte tail. The full text is not in this transcript: re-run ${sourcePhrase(source)} ` +
        'with narrower arguments to fetch it.'
    );
};

// Builds the envelope for one candidate preview length `keep` (code units kept,
// split head/tail). Recomputing the note each time is what keeps the byte loop
// below honest: the note quotes the byte counts of the previews, so it changes
// with `keep` and can never claim a cut that did not happen.
const envelope = (
    content: string,
    keep: number,
    originalBytes: number,
    budgetBytes: number,
    reason: SpillReason,
    aggregateBytes: number | undefined,
    source: ToolResultSource | undefined
): string => {
    const total = Math.max(0, Math.min(keep, content.length));
    const headKeep = Math.floor((total * HEAD_PREVIEW_RATIO) / (HEAD_PREVIEW_RATIO + TAIL_PREVIEW_RATIO));
    const tailKeep = total - headKeep;

    const head = trimBrokenSurrogate(content.slice(0, headKeep));
    const tail = tailKeep > 0 ? trimBrokenLeadSurrogate(content.slice(content.length - tailKeep)) : '';

    const headBytes = utf8ByteLength(head);
    const tailBytes = utf8ByteLength(tail);
    // A multi-byte character trimmed at a boundary, or an extreme budget, can
    // make this momentarily zero; `Math.max` keeps the note from going negative.
    const omittedBytes = Math.max(0, originalBytes - headBytes - tailBytes);

    return JSON.stringify({
        [TRUNCATED_KEY]: true,
        [ORIGINAL_BYTES_KEY]: originalBytes,
        [BUDGET_BYTES_KEY]: budgetBytes,
        [NOTE_KEY]: spillNote(originalBytes, budgetBytes, headBytes, tailBytes, omittedBytes, reason, aggregateBytes, source),
        [CONTENT_KEY]: head,
        [TAIL_KEY]: tail
    });
};

// Shared implementation behind `boundToolResult` and the per-turn ledger.
//
// THE CURRENCY (T3): `budgetBytes` is a PAYLOAD budget. Every comparison below — the
// early return, both shrink loops, and the ledger's tally — is against
// `modelPayloadBytes`, the number of bytes this text occupies once it is serialized
// into the model request, because that is the number the provider bills and the only
// one a declared budget can honestly bound. `utf8ByteLength` is still what the note
// QUOTES (a model reading "cut 64071 of 300000 bytes" is reading about the tool's
// text, not about a JSON encoding it never sees), which is why both measures appear
// here and only one of them gates anything.
//
// This is ALSO the single decision point for the JSON refusal (F-CUTTER): the per-result
// cap and the aggregate spill both come through here, so there is no path that can hand
// a middle-cut JSON document to the model.
const boundWithReason = (
    content: string,
    budgetBytes: number,
    reason: SpillReason,
    aggregateBytes?: number,
    source?: ToolResultSource
): BoundedToolResult => {
    const originalBytes = utf8ByteLength(content);

    // Small outputs are EXACT: no re-encoding, no normalization, no marker. The test
    // is the payload measure, so a 640-byte quote-heavy window that escapes to 962
    // bytes is now compared as 962 against the budget — the direction that was
    // previously 357 bytes of unbudgeted drift per such result.
    if (modelPayloadBytes(content) <= budgetBytes) return { content, truncated: false, originalBytes };

    // THE JSON RULE (F-CUTTER) — the single decision point for the whole surface. A
    // document that parses is a STRUCTURE, and a structure cut in the middle is not
    // that structure: the head ends inside a value, the tail starts inside one, and
    // whichever keys fell into the hole are simply absent from a message that still
    // reads like an answer (the probe in this file's header records both previews
    // failing `JSON.parse`, at isError false). So the document is refused rather than
    // sliced, and the caller — `../harness.ts` (delivery becomes a failed tool result)
    // or `src/server/api.ts` (the route answers `ok: false`) — reports it. Everything
    // that does NOT parse keeps the head/tail envelope exactly as before, because for
    // prose both previews are real content.
    if (isJsonDocument(content)) {
        const message = refusalMessage(originalBytes, budgetBytes, reason, aggregateBytes, source);

        return {
            content: message,
            truncated: false,
            originalBytes,
            rejected: { reason: 'oversized-json', originalBytes, budgetBytes, message }
        };
    }

    // One code unit can never encode to less than one byte — after escaping either:
    // the widest escape JSON produces (`\u00XX`, `\udXXX`) is 6 bytes and the
    // narrowest real character is 1 — so a code-unit slice of `budgetBytes` is still
    // an upper bound on a preview pair that fits. Escaping of the previews only makes
    // the envelope longer, hence the shrink loops below.
    let keep = Math.min(content.length, budgetBytes);
    let bounded = envelope(content, keep, originalBytes, budgetBytes, reason, aggregateBytes, source);

    // Geometric shrink, then exact shrink: at most O(log n) + a few iterations,
    // and it terminates because every step strictly reduces `keep`. Both measure the
    // ENVELOPE as it will be serialized: the envelope is itself JSON text, so its own
    // quotes are escaped on the wire, and a quote inside a PREVIEW has already been
    // escaped once by `JSON.stringify` building the envelope — `"x"` becomes `\"x\"`
    // here and `\\\"x\\\"` in the request body, four bytes for one byte of the tool's
    // text. Measuring the final string is the only way to know which of the two the
    // caller is paying, and it is never an under-count.
    while (modelPayloadBytes(bounded) > budgetBytes && keep > 0) {
        keep = Math.floor(keep * 0.9);
        bounded = envelope(content, keep, originalBytes, budgetBytes, reason, aggregateBytes, source);
    }

    while (modelPayloadBytes(bounded) > budgetBytes && keep > 0) {
        keep -= 1;
        bounded = envelope(content, keep, originalBytes, budgetBytes, reason, aggregateBytes, source);
    }

    // Extreme edge: the budget is smaller than the envelope's fixed overhead
    // (~250 bytes, most of it the note). Return the marker anyway — a truncated
    // marker is more useful to the model than silence, and the documented
    // budgets are kilobytes.
    return { content: bounded, truncated: true, originalBytes };
};

// Apply the budget to one serialized tool result or tool error.
//
// Deterministic: the same input and budget always produce the same envelope. A
// result at or under the budget is returned unchanged (the common case, and the
// one every existing test pins).
//
// `options.source` (T5.1) only changes the wording of the note, never the size
// rule, so a caller that cannot name the producing call gets the same cut with
// a less specific line.
//
// Over budget there are two outcomes, and `rejected` says which one happened
// (F-CUTTER): a JSON document is refused (`truncated: false`, `rejected` set,
// `content` the refusal sentence) and anything else is cut into the head/tail
// envelope (`truncated: true`, `rejected` absent).
export const boundToolResult = (
    content: string,
    budgetBytes: number = MODEL_TOOL_RESULT_BUDGET_BYTES,
    options: ToolResultBoundOptions = {}
): BoundedToolResult => boundWithReason(content, budgetBytes, 'cap', undefined, options.source);

// ---------------------------------------------------------------------------
// T5.2 — the aggregate per-turn budget
// ---------------------------------------------------------------------------

// One turn's running tally of committed tool-result bytes.
//
// WHY A LEDGER RATHER THAN A BATCH SCAN: results are committed one at a time as
// their calls settle (`deliverTask`/`immediateResult` in ../harness.ts), and a
// provider request must contain an answer for EVERY call of the block, so a
// result can never be refused outright and an already-committed message is
// never rewritten behind an event that was already reported. The one rule that
// satisfies both is headroom: the first results of a turn keep their per-result
// size, and once the turn's aggregate is spent each later result is spilled
// through the SAME T5.1 envelope, at a budget equal to what is left.
//
// DETERMINISM: the decision is a pure function of the bytes already committed
// and this result's bytes, in arrival order — no clock, no size heuristics over
// sibling results. The order IS deterministic for the case this guard exists
// for: the sync calls of one assistant message are delivered through the run's
// mailbox in the order the model listed them. Independently async calls can
// settle in either order, and then which one keeps its size is which one
// settled first — bounded, stated, and never a correctness problem because
// every result still arrives, just possibly spilled.
export type ToolResultTurnBudget = {
    /**
     * Model-facing bytes committed into this turn so far (envelope included), counted
     * with `modelPayloadBytes` — the same currency `aggregateBytes()` is declared in
     * (T3). Counting the turn in text bytes while capping each result in payload bytes
     * would let the tally under-report what the request actually carries by the escape
     * factor of every result in it.
     */
    committedBytes(): number;
    /** The aggregate this ledger enforces (`0` = no aggregate guard). */
    aggregateBytes(): number;
    /** Start the next turn's tally. A model request is the boundary. */
    reset(): void;
    /**
     * Bound ONE result for this turn and record what it cost. Apply the
     * per-result cap first (T5.1) and only then the aggregate headroom, so a
     * result that fits both is byte-identical to `boundToolResult`'s output.
     *
     * A result `boundToolResult` REFUSES — an oversized JSON document, F-CUTTER —
     * comes back as the refusal, and the ledger books the REFUSAL's bytes, never the
     * discarded document's. A refusal never takes an aggregate spill: the document is
     * already gone, and re-cutting the sentence that says so would bury it.
     */
    commit(
        content: string,
        options?: ToolResultBoundOptions & { budgetBytes?: number }
    ): BoundedToolResult;
};

// Builds a turn ledger. A non-finite or non-positive `aggregateBytes` disables
// the aggregate guard entirely (the ledger still applies the per-result cap),
// which is the honest reading of a corrupt or deliberately-disabled setting.
export const createToolResultTurnBudget = (
    aggregateBytes: number = MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES,
    perResultBytes: number = MODEL_TOOL_RESULT_BUDGET_BYTES
): ToolResultTurnBudget => {
    const aggregate = Number.isFinite(aggregateBytes) && aggregateBytes > 0 ? aggregateBytes : 0;
    const perResult = Number.isFinite(perResultBytes) && perResultBytes > 0 ? perResultBytes : MODEL_TOOL_RESULT_BUDGET_BYTES;
    let committed = 0;

    return {
        committedBytes: (): number => committed,
        aggregateBytes: (): number => aggregate,
        reset: (): void => {
            committed = 0;
        },
        commit: (content, options = {}): BoundedToolResult => {
            // A caller may ask for a SMALLER per-result cap than the global one
            // (a tool that budgets its own output); the aggregate always applies.
            const requested =
                Number.isFinite(options.budgetBytes) && Number(options.budgetBytes) > 0
                    ? Number(options.budgetBytes)
                    : perResult;

            const capped = boundWithReason(content, requested, 'cap', undefined, options.source);
            // T3: the turn is tallied in the same payload bytes the aggregate is
            // declared in. `utf8ByteLength` here under-reported a quote-heavy turn by
            // ~5% per result, which is how a turn of "512 KiB" reached ~540 KiB of
            // body without ever looking over budget.
            const size = modelPayloadBytes(capped.content);

            // A REFUSAL is never spilled (F-CUTTER). The document is already gone and
            // the sentence that replaced it IS the delivery; re-cutting that sentence to
            // whatever headroom the turn had left would trade an actionable error for an
            // envelope about an envelope. It is booked at its own size, so an oversized
            // JSON result costs the turn a few hundred bytes instead of its whole
            // (discarded) body — soft-bound past the line like every other delivery.
            if (capped.rejected !== undefined) {
                committed += size;

                return capped;
            }

            if (aggregate === 0 || committed + size <= aggregate) {
                committed += size;

                return capped;
            }

            // The turn's remaining headroom, floored so the envelope still fits
            // inside it (limitation 3 above: this is a soft bound, and the only
            // alternative to overshooting is dropping a result, which pairing
            // forbids).
            const remaining = Math.max(0, aggregate - committed);
            const spillBudget = Math.min(requested, Math.max(SPILL_MIN_BUDGET_BYTES, remaining));

            // Nothing left to gain: the per-result cap is already the tighter
            // bound, so keep the capped form rather than a pointless re-cut.
            if (spillBudget >= requested) {
                committed += size;

                return capped;
            }

            const spilled = boundWithReason(content, spillBudget, 'aggregate', aggregate, options.source);
            // A JSON document that fits the PER-RESULT cap but not this turn's headroom
            // is refused here rather than spilled (the rule lives in `boundWithReason`,
            // which is why one decision covers both caps), and what gets booked is the
            // short refusal — never the document that did not fit.
            // Same currency as `size` above (T3).
            committed += modelPayloadBytes(spilled.content);

            return spilled;
        }
    };
};
