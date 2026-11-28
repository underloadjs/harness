// @underload/harness tools/runtime/threadRead — the pure transcript reader behind
// the `threadRead` tool entry.
//
// WHY THIS IS A SEPARATE, NON-ENTRY MODULE
// ----------------------------------------
// A runtime tool entry is compiled from its OWN file at registration time
// (src/core/tool-source.ts walks literal local imports, so `./threadRead` travels
// with the entry as one captured source revision — the same shape as
// `tools/files/grep.tool.ts` + `./bounded-regex`). Keeping the reading, filtering,
// paging and budget accounting here means the entry stays a thin identity/schema
// shell, and this half stays testable without a harness. The file is deliberately
// NOT named `*.tool.ts`: `src/core/tool-scan.ts` scans entries only, so a helper
// adds no catalogue row and needs no manifest/registration edit.
//
// WHAT IT READS (contract)
// ------------------------
// One thread's COMMITTED transcript, as the harness exposes it
// (`Harness.threadMessages`, src/types/index.ts `HarnessMessage`): a flat `content`
// string per message, plus optional `toolCalls` (assistant), `reasoning`
// (assistant), `attachments` (user/tool) and `toolCallId`/`name` (tool). Message
// `index` is always the position in the FULL transcript, so an index reported here
// can be re-read exactly with `message`.
//
// FILTERING ORDER (fixed, and what `matched` means):
//   0. `includeSystem` (default FALSE, I1/I2) — drops the system seed whole before
//      anything else, so it is absent from pages AND from regex matching;
//   1. `role`   — drops whole messages;
//   2. `regex`  — keeps a message when ANY of its SEARCHABLE fields match (see
//      `regexFields` below) and records WHICH of them hit as `matchedFields`;
//   3. `offset`/`limit` — pages the FILTERED list (`matched` is its length);
//   4. `contentOffset`/`contentLimit` — pages one message's text.
// `message` bypasses 0-4 entirely: it addresses one raw transcript index, so index 0
// is still readable with `includeSystem` off, and no `matchedFields` is computed.
//
// WHAT THE FILTERS DELIBERATELY DO NOT RELABEL (pinned by tests):
// `total` always counts the UNFILTERED transcript and `index` always NUMBERS the
// unfiltered transcript, so a dropped system seed moves neither — an index reported
// here can still be re-read exactly with `message`. Only `matched` describes the
// filtered candidate list, and `offset`/`nextOffset` address that same candidate list
// (as they always did), so continuing a page never depends on what was filtered out.
//
// REGEX SCOPE (what "this message matches" means, documented for the model):
// by default the pattern is tested against each message's `content`, plus assistant
// `reasoning`, plus every tool call's `name` and raw JSON `arguments`, plus a tool
// message's `name`. `regexFields` (I4) narrows that SET OF SEARCHED FIELDS without
// touching what a page DISPLAYS — display stays governed by `role`,
// `includeReasoning` and `toolArgs`, independently. The vocabulary is exactly
// `content` / `reasoning` / `toolArguments` / `toolName`, where `toolName` covers both
// an assistant tool call's `name` and a tool message's `name`. Matching always reads
// the RAW arguments, even when `toolArgs: "reference"` omits them from the page.
// Fields are tested SEPARATELY (never concatenated), so a pattern cannot match across
// two fields by accident. Every returned message then names its hit fields in
// `matchedFields`, including a hit that lives in a field the page does not show —
// which is what turns the SELF-MATCH wart (the model's own tool-call arguments contain
// the pattern it just sent) from a mystery message into a reportable fact.
//
// REGEX SAFETY (why node:vm):
// the pattern is model-supplied and JavaScript regexes backtrack — `(a+)+$` against
// 31 bytes costs ~8s — so matching runs inside a `node:vm` context with a real
// deadline, exactly like `tools/files/bounded-regex.ts` (T16). That matcher could
// not be reused directly because it compiles with NO flags while `threadRead`
// documents `flags`, and its error text names `grep`. The technique is identical:
// one precompiled `vm.Script` loops over every field inside the context, so the
// realm boundary is crossed ONCE per read, and the deadline is cumulative across
// the whole transcript. An exhausted budget throws a HarnessError naming the tool
// and the likely cause instead of returning a silently partial answer.
//
// RESULT BUDGET (R3, restated 2026-11-13, currency corrected 2026-11-28 and ENFORCED the
// same day — the F8 fix this reader owed when the files-preset tools were fixed):
// the harness caps any model-facing tool result at
// `MODEL_TOOL_RESULT_BUDGET_BYTES` of SERIALIZED text — escaped payload bytes of
// the whole JSON document (core/result-budget.ts, core/payload-bytes.ts). The
// "256 KiB" and "64 KiB" this header used to quote were earlier values of that
// constant; the constant is the contract, so the number is not repeated here. A
// page of 20 × 4000 characters would still be a wall of text the envelope has to
// police, so this reader applies its OWN budget of the SAME size to the page it
// returns — and that budget is now spent in the cap's currency, not next to it:
//   - `threadReadResultOverhead` measures the result's own scaffolding (the thread
//     identity block priced from the record, every counter, the flags, the empty
//     `messages` array) OUT of the budget, and `threadReadPageAllowance` is what the
//     page's text may then spend;
//   - every message receipt, tool-call receipt, attachment descriptor and displayed
//     character is charged in `modelPayloadBytes` — the escaped measure the cap uses —
//     and the byte cap is applied AFTER the character caps, with the same measure, so
//     no field can overrun the room it was granted;
//   - the guarantee: a page this reader returns is DELIVERED, never refused by the
//     envelope, whatever its text contains (CJK, quotes, backslashes, control bytes).
//     The old UTF-8 accounting could not promise that: escaping adds up to six bytes
//     per character AFTER the budget was already spent, and the receipts and
//     descriptors around the text were counted as free.
// The budget is still what keeps the answer structured — it is reported as
// `contentBudget`, and this reader states exactly what was cut: per-message
// `contentHasMore`/`nextContentOffset`, `argumentsTruncated`,
// `reasoningTruncated`, plus top-level `truncated`/`hasMore`/`nextOffset`. The SIZE is
// a literal because a runtime entry (and the helper it captures) must not value-import
// the `../../core` BARREL — that closes a cycle through core/metadata.ts. The byte
// MEASURE is imported from core/payload-bytes.ts, which imports nothing and therefore
// cannot close one.
//
// TOOL-CALL ARGUMENTS (I3):
// a tool call's raw JSON `arguments` is the largest text a transcript page carries,
// and reading ONE'S OWN thread re-bills the very arguments the caller just sent. The
// default display is therefore a REFERENCE — `{ id, name, argumentsLength }`: no
// arguments TEXT (the receipt itself and its two identity strings still cost bytes, which
// the shell pass charges — F8 removed the old "a reference is free" claim); `toolArgs:
// "full"` opts back into the paged text.
// Because nothing is CUT in reference mode, `argumentsTruncated` is deliberately not
// reported there: the absent `arguments` key is the signal, and `argumentsLength` is
// the exact raw length the follow-up `full` read pages from. `tool`-role message
// BODIES are unaffected — they are the results a model actually needs to re-read.
//
// ATTACHMENTS: descriptors only (`id`, `kind`, `name`, `mime`, `size`). The base64
// `data` never enters a tool result: a 20 MiB image would eat the budget and tell
// the model nothing.
//
// Cross-references:
//   - ./threadRead.tool.ts            — the scanned entry (identity + schema + fetch)
//   - ../files/bounded-regex.ts       — the node:vm timeout technique this mirrors
//   - ../../harness.ts `resultPageOf` (~2620) — the surrogate-pair-safe slicing rule
//   - ../../core/result-budget.ts     — the model-facing delivery cap this is sized
//                                        against (equal to it today, not under it)
//   - ../../types `HarnessMessage` / `HarnessThreadRecord` — the shapes read here
//   - ./threadList.tool.ts            — where a model observes the thread ids

import { createContext, Script } from 'node:vm';
import { HarnessError } from '../../util';
import type { HarnessAttachment, HarnessMessage, HarnessThreadRecord } from '../../types';
// F8 — THE byte measure, from the one module that owns it, so this reader budgets in
// exactly the currency `boundToolResult` enforces (core/result-budget.ts). This import
// is NOT the cycle the header warns about: that cycle closes through the ../../core
// BARREL (core/index.ts -> core/metadata.ts -> the entry -> the barrel). ./payload-bytes
// has ZERO imports of its own, so `threadRead -> payload-bytes` is a leaf edge and cannot
// close any cycle. Budget the SIZE as a literal; never duplicate the MEASURE.
import { modelPayloadBytes } from '../../core/payload-bytes';

// ---------------------------------------------------------------------------
// Bounds. The SIZES are inlined literals (see the header for why this module may not
// value-import the ../../core barrel for them); the entry's JSON schema states the
// same numbers. The byte CURRENCY is imported (see above), which is the whole point of
// the accounting below: a page is now cut by the bytes the provider is billed, not by
// the bytes of the text before it was serialized.
// ---------------------------------------------------------------------------

// The delivery budget one `threadRead` page may consume, in the SAME currency the
// harness cap is enforced in: ESCAPED payload bytes of the WHOLE serialized result
// (`MODEL_TOOL_RESULT_BUDGET_BYTES`, ../../core/result-budget.ts — this literal is that
// constant's value, which the runtime-boundary rule above forbids importing).
//
// The guarantee, as of the F8 fix (the currency was UTF-8 TEXT bytes before, and this
// budget was "a fraction of the cap" in even older drafts — both claims are gone):
//   a page this reader returns is NEVER refused by `boundToolResult`, because
//   `threadReadResultOverhead` measures the result's own scaffolding (identity block,
//   counters, flags, one message shell) out of this budget first, and every byte the
//   page then spends — every message receipt, tool-call receipt, attachment descriptor
//   and displayed character — is charged in `modelPayloadBytes`, the escaped measure the
//   cap uses. What remains of the budget is the TEXT allowance (`threadReadPageAllowance`).
//
// Within that allowance the reader still answers with its own structured pagination
// metadata rather than leaving the envelope to truncate a wall of text — the reason the
// budget exists at all. `contentBudget` in the result reports THIS number (the cap the
// whole document is measured against) and `bytes` reports what the page charged against
// it, both in this currency.
export const THREAD_READ_CONTENT_BUDGET_BYTES = 32 * 1024;

// Messages per page (default and hard maximum).
export const THREAD_READ_DEFAULT_LIMIT = 20;
export const THREAD_READ_MAX_LIMIT = 100;

// Characters of one field per page (default and hard maximum). 32000 keeps a
// single message inside the byte budget too.
export const THREAD_READ_DEFAULT_CONTENT_LIMIT = 4000;
export const THREAD_READ_MAX_CONTENT_LIMIT = 32_000;

// Total matching time one `threadRead` regex may spend, in milliseconds. Same
// ceiling as grep's content matcher: generous for a legitimate scan of a long
// transcript, still finite for a catastrophic pattern. A test injects a shorter
// budget rather than waiting this out (vitest's per-test timeout is 15s).
export const MAX_THREAD_MATCH_MILLIS = 30_000;

// The roles `role` may filter to; mirrors `HarnessMessage`'s four variants.
const ROLES = ['system', 'user', 'assistant', 'tool'] as const;
type ThreadReadRole = (typeof ROLES)[number];

// How a tool call's raw JSON `arguments` is DISPLAYED (I3). `reference` is the default
// — the payload is named and sized, not quoted. The entry's `toolArgs` schema enum
// lists the same two words.
const TOOL_ARGS_MODES = ['full', 'reference'] as const;
type ThreadReadToolArgsMode = (typeof TOOL_ARGS_MODES)[number];

// THE SEARCHABLE-FIELD VOCABULARY (I4), in the order `matchedFields` reports it. One
// array is the single source of truth for three things: the `regexFields` parameter
// (default = all four, which is the pre-I4 behavior), which fields `fieldsOf` actually
// hands the matcher, and the names `matchedFields` returns. Keeping the field KIND
// alongside each field is what lets the matcher's field INDEX be translated back into
// a name with no second pass. The entry's `regexFields` schema enum repeats the words.
export const THREAD_READ_MATCH_FIELDS = ['content', 'reasoning', 'toolArguments', 'toolName'] as const;
export type ThreadReadMatchField = (typeof THREAD_READ_MATCH_FIELDS)[number];

// Flags accepted by the `/pattern/flags` delimited form. Anything else is left to
// `new RegExp`, which is what actually rejects an unknown or duplicated flag.
const DELIMITED_FLAGS = /^[dgimsuvy]*$/;

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

// One tool call. What its raw JSON `arguments` string costs the page depends on
// `toolArgs` (I3): by default a REFERENCE row, in `full` mode the paged text.
export type ThreadReadToolCall = {
    id: string;
    name: string;
    // The raw arguments text — present ONLY in `toolArgs: "full"` mode, where it is
    // paged like any other text. In the default `reference` mode the key is ABSENT:
    // the payload is named and sized, not quoted, and costs no bytes.
    arguments?: string;
    // `full` mode only, and only when `arguments` was cut (by `contentLimit` or by
    // the page budget); `argumentsLength` is then the FULL length of the raw string.
    // `reference` mode reports no truncation flag at all, because nothing was cut —
    // the text was omitted by policy, and the absent `arguments` key says so.
    argumentsTruncated?: boolean;
    // FULL length of the raw arguments string. Always present in `reference` mode (it
    // is the whole payload of a reference), and in `full` mode only alongside a cut.
    argumentsLength?: number;
};

// One attachment, WITHOUT its base64 bytes.
export type ThreadReadAttachment = {
    id: string;
    kind: HarnessAttachment['kind'];
    name: string;
    mime: string;
    // Decoded byte length, as the transcript already records it.
    size: number;
};

// One transcript entry, paged. `index` is the position in the FULL transcript.
export type ThreadReadMessage = {
    index: number;
    role: ThreadReadRole;
    content: string;
    // Full length of `content`, so the caller knows how much is off-page.
    contentLength: number;
    // The offset actually applied (a requested offset that lands inside a
    // surrogate pair moves back one unit, so it can be one lower than requested).
    contentOffset: number;
    // True when `content` continues past what is returned here.
    contentHasMore: boolean;
    // Pass back as `contentOffset` to continue this message's text.
    nextContentOffset?: number;
    // Assistant tool calls, when the message has them.
    toolCalls?: ThreadReadToolCall[];
    // Assistant reasoning, only when `includeReasoning` is true.
    reasoning?: string;
    reasoningTruncated?: boolean;
    reasoningLength?: number;
    // Tool results only: the call this message answers.
    name?: string;
    toolCallId?: string;
    // Descriptors only, never bytes.
    attachments?: ThreadReadAttachment[];
    // I4 — WHICH searchable fields the `regex` hit, named with the `regexFields`
    // vocabulary and emitted in that vocabulary's canonical order. Reported for every
    // returned message WHENEVER `regex` is given, including a hit that lives in a
    // field this page never displays: `reasoning` with `includeReasoning: false`,
    // `toolArguments` in `reference` mode, or a `toolName` the page does not echo.
    // That is what makes a self-match legible instead of mysterious. Absent when
    // `regex` is omitted, and in `message` mode, which bypasses the regex entirely.
    matchedFields?: ThreadReadMatchField[];
};

export type ThreadReadResult = {
    thread: {
        id: string;
        agent: string;
        origin: HarnessThreadRecord['origin'];
        status: HarnessThreadRecord['status'];
        sequence: number;
        ownerThreadId?: string;
        label?: string;
    };
    // Messages in the thread, before ANY filter. Dropping the system seed does not
    // change this number, and neither does it renumber `index` — both address the
    // full transcript, so an index read here is still re-readable with `message`.
    total: number;
    // Messages left after `includeSystem` + `role` + `regex`. In `message` mode this
    // is 1, because the selected message IS the whole result set.
    matched: number;
    // Position into the matched (filtered) list — `offset`/`nextOffset` address that
    // list, exactly as they always did, regardless of what the filters removed. In
    // `message` mode: the selected raw transcript index.
    offset: number;
    limit: number;
    // True when more MATCHED messages exist past this page — because `limit` cut
    // the page, or because the page budget dropped messages off the end of it.
    hasMore: boolean;
    // Pass back as `offset` to continue.
    nextOffset?: number;
    // The delivery budget the WHOLE serialized result is measured against — the cap,
    // exactly as grep.tool.ts, glob.tool.ts and files.tool.ts report it. `bytes` is what
    // this page CHARGED against it in the same escaped currency: every receipt shell
    // (message, tool call, attachment descriptor — a `reference` call is smaller than a
    // `full` one but never free) plus every displayed character (F8). The text allowance
    // the cut actually enforced is `threadReadPageAllowance(record)`, and `bytes` never
    // exceeds it, which is what makes the page deliverable.
    contentBudget: number;
    bytes: number;
    // True when the page BUDGET cut text or dropped messages (a `contentLimit`
    // cut alone is reported per message, not here).
    truncated: boolean;
    messages: ThreadReadMessage[];
};

// Test seam: `matchBudgetMs` shortens the regex deadline so a catastrophic pattern
// can be proven bounded without waiting 30s (same idiom as bounded-regex.test.ts).
export type ThreadReadOptions = {
    matchBudgetMs?: number;
};

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

// F8 — THE page's byte currency. `modelPayloadBytes` (imported at the top) is the
// escaped width a string occupies inside the serialized result, i.e. exactly what the
// delivery cap counts. The UTF-8 measure this file used to keep (`byteLengthOf`, now
// gone) under-counted every quote, backslash, newline and control byte — a control byte
// is SIX escaped bytes — which is how a page that "fit" its own budget came back REFUSED
// by the envelope. There is deliberately no UTF-8 measure left here to reach back for.
//
// The `- 2` is NOT slop: a string inside a JSON document is escaped TWICE before it is
// billed — once by the document's own serialization, and again by the serialization of
// that document into `HarnessMessage.content` — so the measure must run on the
// `JSON.stringify` form to see the second layer (`\"` becoming `\\\"` is where a
// quote-heavy transcript escapes a raw-byte budget). `modelPayloadBytes(JSON.stringify(v))`
// is that double-escaped width INCLUDING the value's two framing quotes; the shells in
// `THREAD_READ_WIRE_SHELLS` already price those quotes (they carry the empty-value `""`),
// so the charge for the CONTENT is that measure minus 2. This is the same arithmetic as
// `contentWireBytes` in ../files/files.tool.ts:458 — one measure, two call sites.
const contentWireBytes = (value: string): number => modelPayloadBytes(JSON.stringify(value)) - 2;

// The cost of one JSON document AS IT APPEARS inside the serialized result: its
// `JSON.stringify` form, escaped. It over-counts by the two quotes of the string literal
// the enclosing document adds (that framing is the enclosing key's cost, per
// core/payload-bytes.ts) — over-reserving is the only safe direction for a budget.
const documentWireBytes = (value: unknown): number => modelPayloadBytes(JSON.stringify(value));

// Every numeric field of a receipt is priced at the widest value it can print, so the
// measured shells below are UPPER bounds rather than averages. A count cannot exceed
// `Number.MAX_SAFE_INTEGER`, so this is a ceiling, not a guess.
const MAX_FIELD_VALUE = Number.MAX_SAFE_INTEGER;

// THE MEASURED SCAFFOLDING (F8). Each constant is the serialized cost of one receipt
// shape with its text fields EMPTY — the part that exists whatever the text turns out to
// be. Text is charged separately (`contentWireBytes`), so nothing is counted twice, and
// the page's allowance is the cap minus `threadReadResultOverhead`. Exported as one
// frozen record so tests and docs quote the numbers the implementation charges instead of
// re-measuring them — the same convention as the files tools' exported allowances.
export const THREAD_READ_WIRE_SHELLS: Readonly<{
    message: number;
    matchFields: number;
    attachments: number;
    attachmentItem: number;
    toolCalls: number;
    toolCallFull: number;
    toolCallReference: number;
    reasoning: number;
    toolIdentity: number;
}> = Object.freeze({
    // One message receipt: the always-present keys, the four counters at their ceiling,
    // `contentHasMore` true, and `nextContentOffset` present (the widest case, since the
    // key is absent when the text ran out on its own).
    message: documentWireBytes({
        index: MAX_FIELD_VALUE,
        role: 'assistant',            // the widest of the four roles
        content: '',
        contentLength: MAX_FIELD_VALUE,
        contentOffset: MAX_FIELD_VALUE,
        contentHasMore: true,
        nextContentOffset: MAX_FIELD_VALUE
    }),
    // `matchedFields` worst case: every name in the searchable-field vocabulary, which is
    // what a `regex` hit in all four fields prints. Charged only when `regex` is given,
    // because the key is absent otherwise (and in `message` mode).
    matchFields: documentWireBytes({ matchedFields: [...THREAD_READ_MATCH_FIELDS] }),
    attachments: documentWireBytes({ attachments: [] }),
    // One attachment descriptor. `kind` is an empty string here: the value comes from a
    // closed five-member union (src/engine/types/index.ts:47, longest 5 characters) and is
    // charged per item, so the shell does not have to assume the widest one.
    attachmentItem: documentWireBytes({ id: '', kind: '', name: '', mime: '', size: MAX_FIELD_VALUE }) + 1,
    toolCalls: documentWireBytes({ toolCalls: [] }),
    // `toolArgs: "full"` — the widest call receipt (arguments present and flagged).
    toolCallFull: documentWireBytes({
        id: '',
        name: '',
        arguments: '',
        argumentsTruncated: true,
        argumentsLength: MAX_FIELD_VALUE
    }) + 1,
    // `toolArgs: "reference"` (the default) — the smaller receipt, priced separately
    // because reference mode is what most pages carry and charging it the `full` shape
    // would tax every call by the cost of a text field it never displays.
    toolCallReference: documentWireBytes({ id: '', name: '', argumentsLength: MAX_FIELD_VALUE }) + 1,
    reasoning: documentWireBytes({
        reasoning: '',
        reasoningTruncated: true,
        reasoningLength: MAX_FIELD_VALUE
    }),
    // `tool`-role identity: the two small strings a tool result message always names.
    toolIdentity: documentWireBytes({ name: '', toolCallId: '' })
});

// The measured cost of the result ENVELOPE carrying no messages: the thread identity
// block priced from the ACTUAL record (its id/agent/origin/status/sequence and the
// optional `ownerThreadId`/`label` are in the delivered document, so they are real
// bytes of this call), every counter at its ceiling, `hasMore`/`truncated` true, and an
// empty `messages` array. threadRead has no prose field — errors THROW outside the
// delivered JSON and `contentBudget`/`bytes` are numbers — so nothing else needs a
// reserve. Exported because the allowance, the starvation refusal and the tests all quote
// the same measurement.
export const threadReadResultOverhead = (record: HarnessThreadRecord): number =>
    documentWireBytes({
        thread: {
            id: record.id,
            agent: record.agent,
            origin: record.origin,
            status: record.status,
            sequence: MAX_FIELD_VALUE,
            ...(record.ownerThreadId === undefined ? {} : { ownerThreadId: record.ownerThreadId }),
            ...(record.label === undefined ? {} : { label: record.label })
        },
        total: MAX_FIELD_VALUE,
        matched: MAX_FIELD_VALUE,
        offset: MAX_FIELD_VALUE,
        limit: MAX_FIELD_VALUE,
        hasMore: true,
        nextOffset: MAX_FIELD_VALUE,
        contentBudget: MAX_FIELD_VALUE,
        bytes: MAX_FIELD_VALUE,
        truncated: true,
        messages: []
    });

// What the TEXT of a page may spend: the delivery budget minus the envelope's own
// scaffolding. Every message shell is charged from here inside the reader, so a page at
// this ceiling is inside the cap `boundToolResult` enforces — which is the guarantee this
// reader did not have before F8 (it counted raw UTF-8 and reserved nothing).
export const threadReadPageAllowance = (record: HarnessThreadRecord): number =>
    Math.max(0, THREAD_READ_CONTENT_BUDGET_BYTES - threadReadResultOverhead(record));

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

// A slice that never splits a surrogate pair, mirroring `resultPageOf` in
// src/harness.ts (~2612-2656): an offset landing on the low half of a pair moves
// back one unit, and an end that would separate a pair moves back one unit. ASCII
// results are unchanged byte for byte.
const sliceSafe = (
    text: string,
    requestedOffset: number,
    requestedLimit: number
): { text: string; offset: number; end: number; hasMore: boolean } => {
    const total = text.length;
    let start = Math.min(Math.max(0, requestedOffset), total);

    if (
        start > 0 &&
        start < total &&
        isLowSurrogate(text.charCodeAt(start)) &&
        isHighSurrogate(text.charCodeAt(start - 1))
    ) {
        start -= 1;
    }

    let end = Math.min(start + Math.max(0, requestedLimit), total);

    if (
        end > start &&
        end < total &&
        isHighSurrogate(text.charCodeAt(end - 1)) &&
        isLowSurrogate(text.charCodeAt(end))
    ) {
        end -= 1;
    }

    return { text: text.slice(start, end), offset: start, end, hasMore: end < total };
};

// F8 — the page budget is a BYTE budget in the delivery currency, while `contentLimit`
// is a CHARACTER budget, so the two caps have to be applied in order: characters first
// (`sliceSafe`, the parameter's own contract), then bytes here. The cut is measured with
// `modelPayloadBytes` itself rather than a duplicated escape table, so the reader cannot
// drift from the cap it is sizing against.
//
// Why a ratio guess and not a unit walk: the escaped width of a slice is O(n) to measure
// and the fields here are up to 32 000 characters, so walking unit-by-unit from 0 would
// re-measure the whole prefix per unit. Scaling the length by the escaped/raw ratio lands
// within the escaping spread of the tail, and the loop below trims from there — a handful
// of units for ordinary text, never a pass over the whole field.
const fitWithinPayload = (text: string, limitBytes: number): string => {
    if (limitBytes <= 0) return '';

    const total = contentWireBytes(text);

    if (total <= limitBytes) return text;

    let end = Math.max(0, Math.min(text.length, Math.floor((text.length * limitBytes) / total)));

    while (end > 0 && contentWireBytes(text.slice(0, end)) > limitBytes) end -= 1;

    // A slice must never end on the HIGH half of a surrogate pair: `JSON.stringify`
    // writes the orphan as a six-byte `\udXXX` escape, which both changes the measure the
    // cut is being made against and corrupts the text the model gets back.
    if (
        end > 0 &&
        end < text.length &&
        isHighSurrogate(text.charCodeAt(end - 1)) &&
        isLowSurrogate(text.charCodeAt(end))
    ) {
        end -= 1;
    }

    return text.slice(0, end);
};

// ---------------------------------------------------------------------------
// Parameter normalization
// ---------------------------------------------------------------------------
// The entry's JSON schema already constrains every argument, and the harness
// rejects a mismatch BEFORE `execute` runs. These checks exist for the direct
// path (a host calling `readThreadTranscript` itself, and this module's tests),
// where no schema stands in front: an invalid value is a clear HarnessError,
// never a silently coerced default.

const stringOf = (
    parameters: Record<string, unknown>,
    key: string,
    allowEmpty = false
): string | undefined => {
    const value = parameters[key];

    if (value === undefined || value === null) return undefined;

    if (typeof value !== 'string') {
        throw new HarnessError(`threadRead "${key}" must be a string.`);
    }

    if (!allowEmpty && value.length === 0) {
        throw new HarnessError(`threadRead "${key}" must not be empty.`);
    }

    return value;
};

const integerOf = (
    parameters: Record<string, unknown>,
    key: string,
    minimum: number,
    maximum: number,
    fallback: number
): number => {
    const value = parameters[key];

    if (value === undefined || value === null) return fallback;

    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
        throw new HarnessError(
            `threadRead "${key}" must be an integer between ${minimum} and ${maximum}; received ${JSON.stringify(value)}.`
        );
    }

    return value;
};

const booleanOf = (
    parameters: Record<string, unknown>,
    key: string,
    fallback: boolean
): boolean => {
    const value = parameters[key];

    if (value === undefined || value === null) return fallback;

    if (typeof value !== 'boolean') {
        throw new HarnessError(`threadRead "${key}" must be a boolean.`);
    }

    return value;
};

const roleOf = (parameters: Record<string, unknown>): ThreadReadRole | undefined => {
    const value = parameters['role'];

    if (value === undefined || value === null) return undefined;

    if (typeof value !== 'string' || !(ROLES as readonly string[]).includes(value)) {
        throw new HarnessError(
            `threadRead "role" must be one of ${ROLES.map((role) => JSON.stringify(role)).join(', ')}; received ${JSON.stringify(value)}.`
        );
    }

    return value as ThreadReadRole;
};

// `toolArgs` (I3) — how much of a tool call's raw JSON `arguments` the PAGE displays.
// The default is `reference`, i.e. the arguments text is replaced by its length, which
// is the fix for a read of one's own thread re-billing the arguments the caller just
// sent. It never affects what `regex` SEARCHES (that is always the raw text).
const toolArgsOf = (parameters: Record<string, unknown>): ThreadReadToolArgsMode => {
    const value = parameters['toolArgs'];

    if (value === undefined || value === null) return 'reference';

    if (typeof value !== 'string' || !(TOOL_ARGS_MODES as readonly string[]).includes(value)) {
        throw new HarnessError(
            `threadRead "toolArgs" must be one of ${TOOL_ARGS_MODES.map((mode) => JSON.stringify(mode)).join(', ')}; received ${JSON.stringify(value)}.`
        );
    }

    return value as ThreadReadToolArgsMode;
};

// `regexFields` (I4) — which of the four searchable field kinds `regex` tests. An
// omitted parameter means ALL FOUR: that is the pre-I4 behavior, and the pinned tests
// rely on it. The selection restricts MATCHING only; what a page displays is governed
// by `role` / `includeReasoning` / `toolArgs` independently.
//
// The result is deduplicated and emitted in the canonical `THREAD_READ_MATCH_FIELDS`
// order, so neither the matcher's field layout nor the reported `matchedFields` order
// depends on how the caller spelled the list.
//
// An EMPTY selection is refused rather than treated as "search nothing": silently
// returning `matched: 0` for every pattern would also skip pattern validation, which
// is the one thing a caller never expects from a malformed regex.
const regexFieldsOf = (parameters: Record<string, unknown>): ThreadReadMatchField[] => {
    const value = parameters['regexFields'];

    if (value === undefined || value === null) return [...THREAD_READ_MATCH_FIELDS];

    if (!Array.isArray(value)) {
        throw new HarnessError(
            `threadRead "regexFields" must be an array of ${THREAD_READ_MATCH_FIELDS.map((field) => JSON.stringify(field)).join(', ')}; received ${JSON.stringify(value)}.`
        );
    }

    const picked = new Set<ThreadReadMatchField>();

    for (const entry of value) {
        if (typeof entry !== 'string' || !(THREAD_READ_MATCH_FIELDS as readonly string[]).includes(entry)) {
            throw new HarnessError(
                `threadRead "regexFields" must name one of ${THREAD_READ_MATCH_FIELDS.map((field) => JSON.stringify(field)).join(', ')}; received ${JSON.stringify(entry)}.`
            );
        }

        picked.add(entry as ThreadReadMatchField);
    }

    if (picked.size === 0) {
        throw new HarnessError('threadRead "regexFields" must name at least one field.');
    }

    return THREAD_READ_MATCH_FIELDS.filter((field) => picked.has(field));
};

// ---------------------------------------------------------------------------
// Pattern handling
// ---------------------------------------------------------------------------

// Split a caller-supplied pattern into source + flags.
//
// Two accepted spellings (both documented on the tool):
//   - bare source with the optional `flags` parameter: `thread.*` + `i`;
//   - the delimited literal form `/pattern/flags`, which a model writes from
//     habit. The delimited flags WIN when both are given, so the answer never
//     depends on an invisible merge.
//
// The delimited form is only recognised when the text after the final `/` is made
// of regex flag characters, which keeps a genuine pattern that merely CONTAINS a
// slash working: `thread/1` and even a lone `/` stay literal sources.
export const parseThreadPattern = (
    regex: string,
    flags?: string
): { source: string; flags: string } => {
    const supplied = typeof flags === 'string' ? flags : '';

    if (regex.startsWith('/')) {
        const end = regex.lastIndexOf('/');

        if (end > 0) {
            const tail = regex.slice(end + 1);

            if (DELIMITED_FLAGS.test(tail)) {
                return { source: regex.slice(1, end), flags: tail.length > 0 ? tail : supplied };
            }
        }
    }

    return { source: regex, flags: supplied };
};

// The error a caller sees when the pattern ran out of matching time. Exported so a
// test asserts the exact wording instead of duplicating it.
export const threadReadMatchBudgetError = (budgetMs: number): HarnessError =>
    new HarnessError(
        `threadRead "regex" did not finish within its ${budgetMs}ms matching budget and was stopped. Simplify the pattern: nested quantifiers such as "(a+)+" can backtrack exponentially.`
    );

// One precompiled loop, reading `source`, `flags` and `fields` from the context,
// so the realm boundary is crossed once per read instead of once per field.
const MATCH_SCRIPT = new Script(`(function () {
    var matcher = new RegExp(source, flags);
    var matched = [];
    for (var index = 0; index < fields.length; index++) {
        matcher.lastIndex = 0;
        if (matcher.test(fields[index])) matched.push(index);
    }
    return matched;
})()`);

// V8 reports the deadline through a stable code; the message is checked too because
// a future Node may set only that (see tools/files/bounded-regex.ts).
const isTimeoutError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;

    const candidate = error as { code?: unknown; message?: unknown };

    return (
        candidate.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
        (typeof candidate.message === 'string' && candidate.message.includes('Script execution timed out'))
    );
};

// Validate and compile the pattern once, then answer "which fields match".
//
// `new RegExp(source, flags)` runs in the HOST realm first, purely to validate: a
// bad pattern or a bad flag set must come back as this realm's SyntaxError with the
// parser's own message (a sandbox-realm SyntaxError would not be `instanceof` the
// host's), and `threadRead` must report it as its own clear error rather than an
// interpreter detail. The compiled object is discarded — the context compiles its
// own copy under the timeout.
const matchingFieldsOf = (
    source: string,
    flags: string,
    fields: readonly string[],
    budgetMs: number
): number[] => {
    try {
        new RegExp(source, flags);
    } catch (error) {
        throw new HarnessError(
            `threadRead "regex" is not a valid JavaScript regular expression: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    if (fields.length === 0) return [];

    const context = createContext({ source, flags, fields: [] as readonly string[] });
    const deadline = Date.now() + budgetMs;
    const remaining = deadline - Date.now();

    // A timeout of 0 means "no timeout" to Node, so an exhausted budget must be
    // refused here rather than handed over as `{ timeout: 0 }`.
    if (remaining <= 0) throw threadReadMatchBudgetError(budgetMs);

    context.fields = fields;

    try {
        return MATCH_SCRIPT.runInContext(context, {
            // Ceil so a fractional millisecond is never truncated to 0.
            timeout: Math.ceil(remaining)
        }) as number[];
    } catch (error) {
        if (isTimeoutError(error)) throw threadReadMatchBudgetError(budgetMs);

        // Anything else (a broken realm, an out-of-memory line set) is not ours to
        // reinterpret.
        throw error;
    }
};

// The searchable fields of one message, in a fixed order, RESTRICTED to the field
// kinds `regexFields` selected. Each entry carries its KIND so the owners walk can
// report `matchedFields` out of the SAME realm crossing that decided the filter — no
// second pass over the transcript.
//
// Fields are kept SEPARATE per field on purpose: a pattern like `foo\nbar` must not
// match by straddling the seam between a message's content and its reasoning.
//
// `toolName` deliberately covers BOTH sides of a call: an assistant tool call's `name`
// and a tool message's `name`. They are the same question ("which tool is this message
// about"), so one vocabulary word selects both, and a caller who wants only one side
// still has `role` to narrow with.
const fieldsOf = (
    message: HarnessMessage,
    selected: ReadonlySet<ThreadReadMatchField>
): { kind: ThreadReadMatchField; text: string }[] => {
    const fields: { kind: ThreadReadMatchField; text: string }[] = [];

    if (selected.has('content')) fields.push({ kind: 'content', text: message.content ?? '' });

    if (message.role === 'assistant') {
        if (
            selected.has('reasoning') &&
            typeof message.reasoning === 'string' &&
            message.reasoning.length > 0
        ) {
            fields.push({ kind: 'reasoning', text: message.reasoning });
        }

        for (const call of message.toolCalls ?? []) {
            // Name and arguments stay TWO fields: a pattern aimed at a path must not
            // hit the tool name by accident, or the other way round.
            if (selected.has('toolName')) fields.push({ kind: 'toolName', text: call.name ?? '' });
            if (selected.has('toolArguments')) {
                fields.push({ kind: 'toolArguments', text: call.arguments ?? '' });
            }
        }
    }

    if (message.role === 'tool' && selected.has('toolName') && typeof message.name === 'string') {
        fields.push({ kind: 'toolName', text: message.name });
    }

    return fields;
};

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

// Read one thread transcript. `record` supplies the identity block, `messages` is
// the detached transcript the entry fetched, and `parameters` are the raw tool
// arguments (everything optional, defaults applied here):
//   thread         — not read here; the entry resolves the id and fetches the transcript
//   message        — one RAW transcript index; bypasses every filter and list paging
//   role           — one of ROLES, or undefined for every role
//   includeSystem  — default FALSE; keep the system seed in pages and in matching
//   regex/flags    — pattern (bare or /pattern/flags) plus optional flags
//   regexFields    — which of the four searchable kinds to search; default all four
//   offset/limit   — page the FILTERED candidate list (default 20, max 100)
//   contentOffset/contentLimit — page one message's text (default 4000, max 32000)
//   includeReasoning — default false; assistant reasoning is DISPLAYED on request
//   toolArgs       — default "reference"; how a tool call's arguments are DISPLAYED
// The three DISPLAY controls (`role`, `includeReasoning`, `toolArgs`) and the two
// MATCHING controls (`regex`, `regexFields`) stay independent by design: narrowing
// what a page shows must never change which messages qualify.
export const readThreadTranscript = (
    record: HarnessThreadRecord,
    messages: readonly HarnessMessage[],
    parameters: Record<string, unknown>,
    options?: ThreadReadOptions
): ThreadReadResult => {
    const role = roleOf(parameters);
    const contentOffset = integerOf(parameters, 'contentOffset', 0, Number.MAX_SAFE_INTEGER, 0);
    const contentLimit = integerOf(
        parameters,
        'contentLimit',
        1,
        THREAD_READ_MAX_CONTENT_LIMIT,
        THREAD_READ_DEFAULT_CONTENT_LIMIT
    );
    const limit = integerOf(
        parameters,
        'limit',
        1,
        THREAD_READ_MAX_LIMIT,
        THREAD_READ_DEFAULT_LIMIT
    );
    const includeReasoning = booleanOf(parameters, 'includeReasoning', false);
    // I1/I2 — the system seed used to be returned by EVERY page and re-charged against
    // the page budget on EVERY page of a long read, which is pure overhead for a model
    // that already knows its own instructions. It is now opt-in. `message` mode still
    // reads index 0 regardless, because that mode addresses a raw transcript position.
    const includeSystem = booleanOf(parameters, 'includeSystem', false);
    // I3 — how much of a tool call's raw JSON `arguments` the page DISPLAYS. Matching
    // reads the raw text whichever way this is set.
    const toolArgs = toolArgsOf(parameters);
    // I4 — which fields `regex` SEARCHES. Display is unaffected.
    const regexFields = regexFieldsOf(parameters);
    // A Set, built once per read, so the per-message field walk is O(1) per kind.
    const searchable = new Set(regexFields);
    const regex = stringOf(parameters, 'regex');
    const flags = stringOf(parameters, 'flags', true);
    // F8 — the page's TEXT allowance is the delivery budget minus this result's own
    // measured scaffolding (`threadReadResultOverhead`), and every byte the page then
    // spends is charged in the same escaped currency the harness cap uses. A page that
    // fills this allowance is therefore inside the cap `boundToolResult` enforces instead
    // of merely inside a budget counted in a currency the cap does not measure. The cap
    // itself is still what `contentBudget` reports.
    const overhead = threadReadResultOverhead(record);
    const budget = threadReadPageAllowance(record);

    // A thread whose identity block alone leaves less than one message shell cannot be
    // delivered at all — the result would be refused whatever the reader put in it — so it
    // is REFUSED here, naming the three numbers, rather than answering with an empty page
    // that reads like "this thread has nothing to show". In practice only a thread whose
    // stored `label`/identity fields run to tens of kilobytes gets here.
    if (budget < THREAD_READ_WIRE_SHELLS.message) {
        throw new HarnessError(
            `threadRead cannot deliver a page for thread "${record.id}": the thread's identity block and this result's counters cost ${overhead} payload bytes, leaving ${budget} of the ${THREAD_READ_CONTENT_BUDGET_BYTES}-byte delivery budget — less than the ${THREAD_READ_WIRE_SHELLS.message}-byte shell one message receipt costs, so no message could be returned. Shorten the thread's stored label, or read a narrower thread.`
        );
    }
    const total = messages.length;

    // --- selection ---------------------------------------------------------
    // `message` addresses one RAW transcript index and bypasses the filters and
    // the list pagination; it is still budgeted like any other page (one message,
    // so the budget only ever cuts inside it). Because the regex never runs in this
    // mode, no `matchedFields` exists to report either.
    const selected = parameters['message'];
    let page: number[];
    let matched: number;
    let offset: number;
    let remainingList = 0;

    // I4 — which SEARCHABLE field kinds each returned message hit, keyed by raw
    // transcript index (NOT by position, so `message` mode and a filtered-out system
    // message simply have no entry). Only ever populated in the regex branch.
    const fieldHitsByIndex = new Map<number, ThreadReadMatchField[]>();

    if (selected !== undefined && selected !== null) {
        const index = integerOf(parameters, 'message', 0, Number.MAX_SAFE_INTEGER, 0);

        if (index >= total) {
            throw new HarnessError(
                `threadRead "message" ${index} is out of range: thread "${record.id}" has ${total} message${total === 1 ? '' : 's'}.`
            );
        }

        page = [index];
        matched = 1;
        offset = index;
    } else {
        const listed = integerOf(parameters, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);

        // Candidates that survive the role filter, in transcript order. An excluded
        // system message never enters this list, so it is absent from the page AND
        // from the regex haystack (I1/I2) — one decision, not two, and `index` still
        // numbers the FULL transcript because the list stores raw positions.
        //
        // Precedence is deliberately mechanical: with `includeSystem` left at its
        // default, `role: "system"` yields an EMPTY page rather than implying the
        // opt-in. Reading the seed takes `includeSystem: true` (or `message: 0`),
        // which keeps "system messages are off unless asked for" true in every path.
        const candidates: number[] = [];

        for (let index = 0; index < total; index += 1) {
            if (!includeSystem && messages[index].role === 'system') continue;
            if (role === undefined || messages[index].role === role) candidates.push(index);
        }

        let kept = candidates;

        if (regex !== undefined) {
            // Flatten the searchable fields, remembering which message owns each and
            // which FIELD KIND each one is, so ONE realm crossing decides the filter
            // AND the per-message `matchedFields` report. Ascending candidate order
            // means the fields of one message are contiguous and the first hit of a
            // message is also its lowest index, which is what the dedupe below relies
            // on. Deselected kinds are never pushed, so restricting `regexFields` also
            // shortens the haystack the matcher walks.
            const fields: string[] = [];
            const owners: number[] = [];
            const kinds: ThreadReadMatchField[] = [];

            for (const index of candidates) {
                for (const field of fieldsOf(messages[index], searchable)) {
                    fields.push(field.text);
                    owners.push(index);
                    kinds.push(field.kind);
                }
            }

            const compiled = parseThreadPattern(regex, flags);
            const hits = matchingFieldsOf(
                compiled.source,
                compiled.flags,
                fields,
                options?.matchBudgetMs ?? MAX_THREAD_MATCH_MILLIS
            );

            kept = [];
            // One Set per kept message, parallel to `kept`: a message can carry
            // several tool calls, so the same kind can hit more than once, and a Set
            // keeps the reported names unique.
            const hitsOfMessage: Set<ThreadReadMatchField>[] = [];

            let previous = -1;

            for (const hit of hits) {
                const owner = owners[hit];

                if (owner !== previous) {
                    kept.push(owner);
                    hitsOfMessage.push(new Set([kinds[hit]]));
                    previous = owner;
                } else {
                    hitsOfMessage[hitsOfMessage.length - 1].add(kinds[hit]);
                }
            }

            // Canonical order (the `THREAD_READ_MATCH_FIELDS` vocabulary order) rather
            // than hit order, so a caller can compare `matchedFields` against a fixed
            // expectation regardless of which field the matcher reached first.
            for (let position = 0; position < kept.length; position += 1) {
                const hit = hitsOfMessage[position];

                fieldHitsByIndex.set(
                    kept[position],
                    THREAD_READ_MATCH_FIELDS.filter((field) => hit.has(field))
                );
            }
        }

        matched = kept.length;
        // An offset past the end of the list is an empty page, not an error: the
        // caller can read `matched` and step back.
        offset = Math.min(listed, kept.length);
        page = kept.slice(offset, offset + limit);
        remainingList = kept.length;
    }

    // --- paging + budgeting ------------------------------------------------
    let used = 0;
    let truncated = false;
    const views: ThreadReadMessage[] = [];

    for (const index of page) {
        // The union's four discriminants are exactly `ThreadReadRole`, so the role
        // is reported without a cast; every role-specific field below is reached by
        // narrowing on that discriminant instead of casting the message.
        const message = messages[index];
        const content = message.content ?? '';

        // F8 — a message costs its RECEIPT SHELL before any text is cut. A shell is the
        // JSON that exists whatever the text turns out to be: keys, flags, counters and the
        // quotes around an empty text field, measured in `THREAD_READ_WIRE_SHELLS`. The old
        // accounting charged none of it (it counted displayed characters only) and called
        // attachment descriptors and tool-call receipts free, which is the same under-count
        // that let a page "inside its own budget" come back refused.
        const attachments =
            message.role === 'user' || message.role === 'tool' ? message.attachments : undefined;
        const toolCalls = message.role === 'assistant' ? message.toolCalls : undefined;
        const reasonText =
            includeReasoning && message.role === 'assistant' ? message.reasoning : undefined;

        let shell = THREAD_READ_WIRE_SHELLS.message;

        // `matchedFields` is priced at its widest (all four field names) and only when a
        // `regex` was given, because the key is absent with no regex and in `message` mode.
        if (regex !== undefined) shell += THREAD_READ_WIRE_SHELLS.matchFields;
        if (typeof reasonText === 'string') shell += THREAD_READ_WIRE_SHELLS.reasoning;

        if (attachments !== undefined && attachments.length > 0) {
            shell += attachments.reduce(
                (total, attachment) =>
                    total +
                    THREAD_READ_WIRE_SHELLS.attachmentItem +
                    contentWireBytes(attachment.id) +
                    contentWireBytes(attachment.kind) +
                    contentWireBytes(attachment.name) +
                    contentWireBytes(attachment.mime),
                THREAD_READ_WIRE_SHELLS.attachments
            );
        }

        if (toolCalls !== undefined && toolCalls.length > 0) {
            // Reference mode still emits `{ id, name, argumentsLength }`, so it costs a
            // receipt — the smaller one — and the two identity strings cost their escaped
            // bytes either way. The `arguments` TEXT is charged where it is displayed.
            const callShell =
                toolArgs === 'full'
                    ? THREAD_READ_WIRE_SHELLS.toolCallFull
                    : THREAD_READ_WIRE_SHELLS.toolCallReference;

            shell += toolCalls.reduce(
                (total, call) =>
                    total + callShell + contentWireBytes(call.id) + contentWireBytes(call.name),
                THREAD_READ_WIRE_SHELLS.toolCalls
            );
        }

        if (message.role === 'tool') {
            shell +=
                THREAD_READ_WIRE_SHELLS.toolIdentity +
                contentWireBytes(message.name) +
                contentWireBytes(message.toolCallId);
        }

        // Nothing left for this message's own scaffolding, so nothing is left for any later
        // message either: the budget drops them whole and `hasMore`/`nextOffset` tell the
        // caller where to continue. (This subsumes the old `used >= budget` test: a shell is
        // never zero bytes.)
        if (used + shell > budget) {
            truncated = true;
            break;
        }

        used += shell;

        // Required fields first, then the optional ones by narrowing below.
        const view: ThreadReadMessage = {
            index,
            role: message.role,
            content: '',
            contentLength: 0,
            contentOffset: 0,
            contentHasMore: false
        };

        // 1. content — paged by `contentOffset` and capped by `contentLimit`, BOTH of which
        //    are character bounds (the parameter's published contract), and then capped by
        //    the delivery budget, which is a byte bound in the escaped currency. The two
        //    caps are applied in that order, and the byte cap is what keeps the serialized
        //    result inside the harness cap (F8) — the old code spent `room` bytes as if they
        //    were characters, which let one page emit up to 6x the bytes it was granted.
        const room = budget - used;
        const byChars = sliceSafe(content, contentOffset, contentLimit);
        const budgetCut = contentWireBytes(byChars.text) > room;
        const text = budgetCut ? fitWithinPayload(byChars.text, room) : byChars.text;

        view.content = text;
        view.contentLength = content.length;
        view.contentOffset = byChars.offset;
        // More content exists when EITHER cap stopped short of the end of the text: a
        // `contentLimit` cut the caller can re-page, or the budget's own cut.
        view.contentHasMore = byChars.hasMore || budgetCut;

        if (view.contentHasMore) {
            // The resume offset addresses the ORIGINAL string, and the byte cap can only
            // have removed a SUFFIX of the char slice, so the end of the text the caller
            // actually received is the offset to hand back (pair-safe on both cuts).
            view.nextContentOffset = byChars.offset + text.length;

            // Only the BUDGET's cut belongs to the top-level `truncated`; a `contentLimit`
            // cut is reported per message, exactly as it always was.
            if (budgetCut) truncated = true;
        }

        used += contentWireBytes(text);

        // 2. attachments — descriptors only (the base64 `data` never travels), but they are
        //    NOT free: F8 charges each one its shell plus the escaped bytes of its
        //    id/kind/name/mime in the shell pass above. Only `user` and `tool` messages can
        //    carry them (src/engine/types/index.ts `HarnessMessage`).
        if (attachments !== undefined && attachments.length > 0) {
            view.attachments = attachments.map((attachment) => ({
                id: attachment.id,
                kind: attachment.kind,
                name: attachment.name,
                mime: attachment.mime,
                size: attachment.size
            }));
        }

        // 3. tool calls — kept structurally in full either way (a model needs the
        //    call id/name pairing to act on a call), but the raw JSON `arguments`
        //    payload is DISPLAYED two ways (I3):
        //      `reference` (default): { id, name, argumentsLength } — no arguments TEXT,
        //        and NO truncation flag, because nothing was cut; the caller asks for the
        //        text with `toolArgs: "full"` and pages it from there. The receipt and the
        //        two identity strings still cost bytes, charged in the shell pass (F8);
        //      `full`: the arguments string, capped by `contentLimit` (characters) and then
        //        by the remaining delivery budget (escaped bytes), flagged when either cut.
        //    `regex` SEARCHES the raw arguments regardless of either mode.
        if (toolCalls !== undefined && toolCalls.length > 0) {
            view.toolCalls = toolCalls.map((call) => {
                const raw = call.arguments ?? '';

                if (toolArgs === 'reference') {
                    return { id: call.id, name: call.name, argumentsLength: raw.length };
                }

                const callRoom = Math.max(0, budget - used);
                const byCallChars = sliceSafe(raw, 0, contentLimit);
                const callCut = contentWireBytes(byCallChars.text) > callRoom;
                const callText = callCut ? fitWithinPayload(byCallChars.text, callRoom) : byCallChars.text;
                const entry: ThreadReadToolCall = {
                    id: call.id,
                    name: call.name,
                    arguments: callText
                };

                used += contentWireBytes(callText);

                if (byCallChars.hasMore || callCut) {
                    entry.argumentsTruncated = true;
                    entry.argumentsLength = raw.length;

                    // Only the budget's cut belongs to the top-level `truncated`.
                    if (callCut) truncated = true;
                }

                return entry;
            });
        }

        // 4. reasoning — opt-in, capped by `contentLimit` like the rest, reported
        //    with a truncation flag rather than an offset (it is not the text the
        //    model is usually navigating). `reasonText` already carries the
        //    `includeReasoning` + assistant-role decision the shell pass charged.
        if (typeof reasonText === 'string') {
            const reasoningRoom = Math.max(0, budget - used);
            const byReasonChars = sliceSafe(reasonText, 0, contentLimit);
            const reasoningCut = contentWireBytes(byReasonChars.text) > reasoningRoom;
            const reasoningText = reasoningCut
                ? fitWithinPayload(byReasonChars.text, reasoningRoom)
                : byReasonChars.text;

            view.reasoning = reasoningText;
            used += contentWireBytes(reasoningText);

            if (byReasonChars.hasMore || reasoningCut) {
                view.reasoningTruncated = true;
                view.reasoningLength = reasonText.length;

                if (reasoningCut) truncated = true;
            }
        }

        // 5. tool identity — small, never paged, and charged in the shell pass above
        //    (`THREAD_READ_WIRE_SHELLS.toolIdentity` plus both escaped strings).
        if (message.role === 'tool') {
            view.name = message.name;
            view.toolCallId = message.toolCallId;
        }

        // 6. matchedFields (I4) — WHICH searchable fields the `regex` hit, reported
        //    even when the hit lives in a field this page never displays (reasoning
        //    under `includeReasoning: false`, arguments in `reference` mode, a tool
        //    name the page does not echo). Absent when `regex` was not given, and in
        //    `message` mode, which skips the matcher entirely.
        const hits = fieldHitsByIndex.get(index);

        if (hits !== undefined) view.matchedFields = hits;

        views.push(view);
    }

    // A `message` read is exactly one message, so it never has a next list page;
    // otherwise more matched messages exist whenever the budget or the limit cut
    // the page short.
    const hasMore = selected !== undefined && selected !== null
        ? false
        : offset + views.length < remainingList;

    return {
        thread: {
            id: record.id,
            agent: record.agent,
            origin: record.origin,
            status: record.status,
            sequence: record.sequence,
            ...(record.ownerThreadId === undefined ? {} : { ownerThreadId: record.ownerThreadId }),
            ...(record.label === undefined ? {} : { label: record.label })
        },
        total,
        matched,
        offset,
        limit: selected !== undefined && selected !== null ? 1 : limit,
        hasMore,
        ...(hasMore ? { nextOffset: offset + views.length } : {}),
        // `contentBudget` reports the CAP the WHOLE serialized result is measured against
        // (the delivery budget, same convention as grep/glob/files), and `bytes` reports
        // what this page CHARGED against it in that same currency — envelope shells excepted,
        // since the caller cannot re-measure the identity block it was handed. The text
        // allowance the cut actually enforced is `bytes <= threadReadPageAllowance(record)`.
        contentBudget: THREAD_READ_CONTENT_BUDGET_BYTES,
        bytes: used,
        truncated,
        messages: views
    };
};
