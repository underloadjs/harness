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
//   - a result that exceeds the budget becomes a SMALL, VALID JSON envelope
//     that names the truncation, the original size, the applied budget, a
//     head preview, a tail preview, and a plain-language note saying what is
//     missing and how to fetch it again. A truncated JSON-ish result is
//     therefore still parseable JSON instead of a half-written document;
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
//   3. The aggregate guard SHRINKS results, it never drops one. A provider
//      request must answer every `tool_calls[]` entry (core/../types pairing), so
//      the last delivery of an over-budget turn still pays its envelope
//      overhead: the per-turn total is a soft bound, exceeded by at most one
//      envelope (~a few hundred bytes) per result past the line.
//
// Cross-references:
//   - ../harness.ts    — applies the per-turn ledger to every tool result and tool error
//   - ./tool-ui.ts     — the separate panel bounds
//   - ../types         — the tool_result event whose `content` is this text

// The default budget: 256 KiB of UTF-8 bytes per model-facing tool result or
// tool error. 256 KiB is roughly 64k tokens of English prose.
//
// It is 4x the previous 64 KiB for one specific reason: `read` budgets its own
// output at the same order of magnitude, and the two numbers MUST agree. When
// both were 64 KiB, a read that exactly filled its content budget was always
// over this wire cap (JSON escaping adds 2-15%), so the harness cut the result
// mid-string and replaced the whole object with its envelope — destroying the
// `nextLine`/`nextColumn` fields an agent needs in order to continue. `read`
// now measures its own budget on the serialized form and reports `wireBytes`,
// and this cap is set to match, so a full-budget read survives intact.
//
// The honest cost of raising it used to be: "the cap is PER RESULT and there is
// no aggregate guard, so N parallel tool calls can now commit up to N x 256 KiB
// in one turn." That is what `MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES` below
// closes; a single result is still bounded separately, which is what protects
// the session from the one-unbounded-output-kills-the-context-window failure
// this module exists for.
export const MODEL_TOOL_RESULT_BUDGET_BYTES = 256 * 1024;

// The aggregate sibling of the cap above (compaction T5.2): the most TOTAL
// tool-result text one turn may commit, summed over every call the model asked
// for in one assistant message.
//
// It is 2x the per-result cap on purpose. One full-budget `read` (256 KiB) plus
// one more large result still fit UNCHANGED — the case the 256 KiB number was
// raised for — while a turn that fires eight big reads, a build-log dump and a
// web page can no longer spend 2 MiB of the window in one round. In token
// terms 512 KiB is ~128k tokens of prose: more than any realistic context
// window can give a single turn, so tripping it is always the right thing to
// do, and a conversation that trips it on every turn is one the compaction
// plugin (../plugins/context-compaction.plugin.ts) is going to have to prune
// anyway.
export const MODEL_TOOL_RESULTS_PER_TURN_BUDGET_BYTES = 512 * 1024;

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
export type BoundedToolResult = {
    content: string;
    truncated: boolean;
    originalBytes: number;
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

// The honest line: what was dropped, which cap did it, and where the rest is.
// Numbers only — no prose that could drift with a locale — because a model
// parses this and a test asserts it byte for byte.
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
const boundWithReason = (
    content: string,
    budgetBytes: number,
    reason: SpillReason,
    aggregateBytes?: number,
    source?: ToolResultSource
): BoundedToolResult => {
    const originalBytes = utf8ByteLength(content);

    // Small outputs are EXACT: no re-encoding, no normalization, no marker.
    if (originalBytes <= budgetBytes) return { content, truncated: false, originalBytes };

    // One code unit can never encode to less than one byte, so a code-unit slice
    // of `budgetBytes` is an upper bound on a preview pair that fits. JSON
    // escaping of the previews only makes the envelope longer, hence the shrink
    // loops below.
    let keep = Math.min(content.length, budgetBytes);
    let bounded = envelope(content, keep, originalBytes, budgetBytes, reason, aggregateBytes, source);

    // Geometric shrink, then exact shrink: at most O(log n) + a few iterations,
    // and it terminates because every step strictly reduces `keep`.
    while (utf8ByteLength(bounded) > budgetBytes && keep > 0) {
        keep = Math.floor(keep * 0.9);
        bounded = envelope(content, keep, originalBytes, budgetBytes, reason, aggregateBytes, source);
    }

    while (utf8ByteLength(bounded) > budgetBytes && keep > 0) {
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
    /** Bytes committed into this turn so far (envelope included, UTF-8). */
    committedBytes(): number;
    /** The aggregate this ledger enforces (`0` = no aggregate guard). */
    aggregateBytes(): number;
    /** Start the next turn's tally. A model request is the boundary. */
    reset(): void;
    /**
     * Bound ONE result for this turn and record what it cost. Apply the
     * per-result cap first (T5.1) and only then the aggregate headroom, so a
     * result that fits both is byte-identical to `boundToolResult`'s output.
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
            const size = utf8ByteLength(capped.content);

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
            committed += utf8ByteLength(spilled.content);

            return spilled;
        }
    };
};
