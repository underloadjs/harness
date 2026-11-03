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
//   1. `role`   — drops whole messages;
//   2. `regex`  — keeps a message when ANY of its searchable fields match;
//   3. `offset`/`limit` — pages the FILTERED list (`matched` is its length);
//   4. `contentOffset`/`contentLimit` — pages one message's text.
// `message` bypasses 2-4 entirely: it addresses one raw transcript index.
//
// REGEX SCOPE (what "this message matches" means, documented for the model):
// the pattern is tested against each message's `content`, plus assistant
// `reasoning`, plus every tool call's `name` and raw JSON `arguments`, plus a tool
// message's `name`. Fields are tested SEPARATELY (never concatenated), so a
// pattern cannot match across two fields by accident.
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

// Flags accepted by the `/pattern/flags` delimited form. Anything else is left to
// `new RegExp`, which is what actually rejects an unknown or duplicated flag.
const DELIMITED_FLAGS = /^[dgimsuvy]*$/;

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

// One tool call, with its raw JSON `arguments` string paged like any other text.
export type ThreadReadToolCall = {
    id: string;
    name: string;
    arguments: string;
    // Present only when `arguments` was cut (by `contentLimit` or by the page
    // budget); `argumentsLength` is then the FULL length of the raw string.
    argumentsTruncated?: boolean;
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
    // Messages in the thread, before any filter.
    total: number;
    // Messages left after `role` + `regex`. In `message` mode this is 1, because
    // the selected message IS the whole result set.
    matched: number;
    // Position into the matched list (in `message` mode: the selected index).
    offset: number;
    limit: number;
    // True when more MATCHED messages exist past this page — because `limit` cut
    // the page, or because the page budget dropped messages off the end of it.
    hasMore: boolean;
    // Pass back as `offset` to continue.
    nextOffset?: number;
    // The text budget this page was built under, and the bytes it used.
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

// The searchable fields of one message, in a fixed order. Kept SEPARATE per field
// on purpose: a pattern like `foo\nbar` must not match by straddling the seam
// between a message's content and its reasoning.
const fieldsOf = (message: HarnessMessage): string[] => {
    const fields: string[] = [message.content ?? ''];

    if (message.role === 'assistant') {
        if (typeof message.reasoning === 'string' && message.reasoning.length > 0) {
            fields.push(message.reasoning);
        }

        for (const call of message.toolCalls ?? []) {
            fields.push(call.name ?? '');
            fields.push(call.arguments ?? '');
        }
    }

    if (message.role === 'tool' && typeof message.name === 'string') {
        fields.push(message.name);
    }

    return fields;
};

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

// Read one thread transcript. `record` supplies the identity block, `messages` is
// the detached transcript the entry fetched, and `parameters` are the raw tool
// arguments (everything optional, defaults applied here).
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
    const regex = stringOf(parameters, 'regex');
    const flags = stringOf(parameters, 'flags', true);
    const budget = THREAD_READ_CONTENT_BUDGET_BYTES;
    const total = messages.length;

    // --- selection ---------------------------------------------------------
    // `message` addresses one RAW transcript index and bypasses the filters and
    // the list pagination; it is still budgeted like any other page (one message,
    // so the budget only ever cuts inside it).
    const selected = parameters['message'];
    let page: number[];
    let matched: number;
    let offset: number;
    let remainingList = 0;

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

        // Candidates that survive the role filter, in transcript order.
        const candidates: number[] = [];

        for (let index = 0; index < total; index += 1) {
            if (role === undefined || messages[index].role === role) candidates.push(index);
        }

        let kept = candidates;

        if (regex !== undefined) {
            // Flatten the searchable fields, remembering which message owns each,
            // so ONE realm crossing decides the whole filter. Ascending candidate
            // order means the first hit of a message is also its lowest index.
            const fields: string[] = [];
            const owners: number[] = [];

            for (const index of candidates) {
                for (const field of fieldsOf(messages[index])) {
                    fields.push(field);
                    owners.push(index);
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

            let previous = -1;

            for (const hit of hits) {
                const owner = owners[hit];

                if (owner !== previous) {
                    kept.push(owner);
                    previous = owner;
                }
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

        // 3. tool calls — kept in full structurally; only `arguments` is paged,
        //    because a model needs the call id/name pairing even when the payload
        //    is too large for this page.
        if (message.role === 'assistant') {
            const toolCalls = message.toolCalls;

            if (toolCalls !== undefined && toolCalls.length > 0) {
                view.toolCalls = toolCalls.map((call) => {
                    const raw = call.arguments ?? '';
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
