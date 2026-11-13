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
// RESULT BUDGET (R3):
// the harness caps any model-facing tool result at 64 KiB of serialized text
// (core/result-budget.ts, MODEL_TOOL_RESULT_BUDGET_BYTES). A page of 20 × 4000
// characters would blow past that and come back as an opaque truncation envelope,
// so this reader applies its OWN, smaller 32 KiB budget to the text it returns
// (`contentBudget`) and reports exactly what was cut: per-message
// `contentHasMore`/`nextContentOffset`, `argumentsTruncated`,
// `reasoningTruncated`, plus top-level `truncated`/`hasMore`/`nextOffset`. The
// number is a literal because a runtime entry (and the helper it captures) must
// not value-import `../../core` — that closes a cycle through core/metadata.ts.
//
// TOOL-CALL ARGUMENTS (I3):
// a tool call's raw JSON `arguments` is the largest text a transcript page carries,
// and reading ONE'S OWN thread re-bills the very arguments the caller just sent. The
// default display is therefore a REFERENCE — `{ id, name, argumentsLength }`, no
// arguments text and no byte cost; `toolArgs: "full"` opts back into the paged text.
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
//   - ../../core/result-budget.ts     — the 64 KiB model-facing cap this stays under
//   - ../../types `HarnessMessage` / `HarnessThreadRecord` — the shapes read here
//   - ./threadList.tool.ts            — where a model observes the thread ids

import { createContext, Script } from 'node:vm';
import { HarnessError } from '../../util';
import type { HarnessAttachment, HarnessMessage, HarnessThreadRecord } from '../../types';

// ---------------------------------------------------------------------------
// Bounds. Inlined literals (see the header for why this module may not reach
// into ../../core for them); the entry's JSON schema states the same numbers.
// ---------------------------------------------------------------------------

// UTF-8 bytes of returned TEXT one `threadRead` page may carry. Half the harness
// result cap, which leaves room for the envelope, per-field JSON overhead and any
// escaping inflation, so the model always gets the structured pagination metadata
// instead of a truncated-JSON wrapper.
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
    // The text budget this page was built under, and the bytes it used. A tool call
    // displayed as a `reference` contributes nothing to `bytes`: only text does.
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

// UTF-8 byte length. Copied from core/result-budget.ts, which documents why bytes
// (not code units) are the right unit; the fallback over-counts never under-counts.
const encoder = typeof TextEncoder === 'undefined' ? undefined : new TextEncoder();

const byteLengthOf = (value: string): number =>
    encoder === undefined ? Math.max(value.length, 0) : encoder.encode(value).length;

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
    const budget = THREAD_READ_CONTENT_BUDGET_BYTES;
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
        // Nothing left for this message or any later one: the budget drops them
        // whole, and `hasMore`/`nextOffset` tell the caller where to continue.
        if (used >= budget) {
            truncated = true;
            break;
        }

        // The union's four discriminants are exactly `ThreadReadRole`, so the role
        // is reported without a cast; every role-specific field below is reached by
        // narrowing on that discriminant instead of casting the message.
        const message = messages[index];
        const content = message.content ?? '';
        // Required fields first, then the optional ones by narrowing below.
        const view: ThreadReadMessage = {
            index,
            role: message.role,
            content: '',
            contentLength: 0,
            contentOffset: 0,
            contentHasMore: false
        };

        // 1. content — paged by `contentOffset`, capped by `contentLimit`, then by
        //    whatever the page budget still allows.
        const room = budget - used;
        const take = Math.min(contentLimit, room);
        const contentPage = sliceSafe(content, contentOffset, take);

        view.content = contentPage.text;
        view.contentLength = content.length;
        view.contentOffset = contentPage.offset;
        view.contentHasMore = contentPage.hasMore;

        if (contentPage.hasMore) {
            view.nextContentOffset = contentPage.end;

            // `take` was below `contentLimit`, so the cut is the budget's doing.
            if (take < contentLimit) truncated = true;
        }

        used += byteLengthOf(contentPage.text);

        // 2. attachments — descriptors, no bytes, no budget cost. Only `user` and
        //    `tool` messages can carry them (src/types/index.ts `HarnessMessage`).
        if (message.role === 'user' || message.role === 'tool') {
            const attachments = message.attachments;

            if (attachments !== undefined && attachments.length > 0) {
                view.attachments = attachments.map((attachment) => ({
                    id: attachment.id,
                    kind: attachment.kind,
                    name: attachment.name,
                    mime: attachment.mime,
                    size: attachment.size
                }));
            }
        }

        // 3. tool calls — kept structurally in full either way (a model needs the
        //    call id/name pairing to act on a call), but the raw JSON `arguments`
        //    payload is DISPLAYED two ways (I3):
        //      `reference` (default): { id, name, argumentsLength } — no text, no byte
        //        cost, and NO truncation flag, because nothing was cut; the caller
        //        asks for the text with `toolArgs: "full"` and pages it from there;
        //      `full`: the arguments string, paged by `contentLimit` and then by the
        //    remaining page budget, flagged when either cut it.
        //    `regex` SEARCHES the raw arguments regardless of either mode.
        if (message.role === 'assistant') {
            const toolCalls = message.toolCalls;

            if (toolCalls !== undefined && toolCalls.length > 0) {
                view.toolCalls = toolCalls.map((call) => {
                    const raw = call.arguments ?? '';

                    if (toolArgs === 'reference') {
                        return { id: call.id, name: call.name, argumentsLength: raw.length };
                    }

                    const callRoom = Math.max(0, budget - used);
                    const callTake = Math.min(contentLimit, callRoom);
                    const callPage = sliceSafe(raw, 0, callTake);
                    const entry: ThreadReadToolCall = {
                        id: call.id,
                        name: call.name,
                        arguments: callPage.text
                    };

                    used += byteLengthOf(callPage.text);

                    if (callPage.hasMore) {
                        entry.argumentsTruncated = true;
                        entry.argumentsLength = raw.length;

                        // `callTake` was below `contentLimit`, so the budget did it.
                        if (callTake < contentLimit) truncated = true;
                    }

                    return entry;
                });
            }
        }

        // 4. reasoning — opt-in, capped by `contentLimit` like the rest, reported
        //    with a truncation flag rather than an offset (it is not the text the
        //    model is usually navigating).
        if (includeReasoning && message.role === 'assistant' && typeof message.reasoning === 'string') {
            const reasoning = message.reasoning;
            const reasoningRoom = Math.max(0, budget - used);
            const reasoningTake = Math.min(contentLimit, reasoningRoom);
            const reasoningPage = sliceSafe(reasoning, 0, reasoningTake);

            view.reasoning = reasoningPage.text;
            used += byteLengthOf(reasoningPage.text);

            if (reasoningPage.hasMore) {
                view.reasoningTruncated = true;
                view.reasoningLength = reasoning.length;

                if (reasoningTake < contentLimit) truncated = true;
            }
        }

        // 5. tool identity — small, never paged.
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
        contentBudget: budget,
        bytes: used,
        truncated,
        messages: views
    };
};
