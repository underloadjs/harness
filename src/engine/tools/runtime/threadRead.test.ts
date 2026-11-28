// tools/runtime/threadRead.test.ts — the pure transcript reader behind `threadRead`.
//
// What is pinned here (the helper's whole contract; the harness side lives in
// src/harness.thread-read.test.ts):
//   - the published bounds, so the entry's JSON schema and this module cannot
//     drift apart, plus the searchable-field vocabulary (`THREAD_READ_MATCH_FIELDS`)
//     that `regexFields` and `matchedFields` share;
//   - pattern parsing: bare source + `flags`, `/pattern/flags`, and the documented
//     rule that a delimited pattern's flags win;
//   - regex SCOPE: content, assistant reasoning, tool-call name/arguments and a
//     tool message's name — with each FIELD tested separately, so a pattern cannot
//     match across a field seam by accident; `regexFields` narrows WHICH of those
//     fields are searched (default all four) and `matchedFields` reports which ones
//     hit, INCLUDING a hit in a field the page does not display (I4);
//   - the system seed is OFF by default (I1/I2): absent from pages, absent from the
//     regex haystack, opt-in restores both (and its byte cost), while `message: 0`
//     still reads it because that mode addresses a raw transcript index;
//   - tool-call DISPLAY modes (I3): `reference` (default) emits
//     { id, name, argumentsLength } and costs no bytes, `full` emits the paged
//     arguments text exactly as it always was — and `regex` searches the RAW
//     arguments in either mode;
//   - filtering + pagination semantics: `matched` is the filtered count,
//     `offset`/`limit` page the filtered list, `nextOffset` continues it, while
//     `total` and every `index` keep addressing the FULL transcript;
//   - text paging: `contentOffset`/`contentLimit` with `contentHasMore` and
//     `nextContentOffset`, never splitting a surrogate pair;
//   - the 32 KiB page budget: which message got cut, `truncated`, and how the
//     caller continues;
//   - attachments as DESCRIPTORS only (no base64 anywhere in the result);
//   - honest errors: malformed pattern, bad flags, out-of-range `message`, every
//     new parameter, and a pattern stopped by its matching budget (node:vm deadline,
//     same technique as tools/files/bounded-regex.ts).
//
// Deterministic throughout: every assertion is an exact value or an exact object,
// never a range or a smoke test. The budget is proven with an INJECTED short
// deadline rather than by waiting out the 30s default (vitest gives 15s).

import { describe, expect, it } from 'vitest';
import { HarnessError } from '../../util';
import type { HarnessMessage, HarnessThreadRecord } from '../../types';
// The searchable-field vocabulary type, imported as a TYPE so this file keeps the
// same shape as the module it pins (the helper is a value import; the vocabulary word
// list is asserted through `THREAD_READ_MATCH_FIELDS` below).
import type { ThreadReadMatchField } from './threadRead';
import {
    MAX_THREAD_MATCH_MILLIS,
    parseThreadPattern,
    readThreadTranscript,
    THREAD_READ_CONTENT_BUDGET_BYTES,
    THREAD_READ_DEFAULT_CONTENT_LIMIT,
    THREAD_READ_DEFAULT_LIMIT,
    THREAD_READ_MATCH_FIELDS,
    THREAD_READ_MAX_CONTENT_LIMIT,
    THREAD_READ_MAX_LIMIT,
    THREAD_READ_WIRE_SHELLS,
    threadReadMatchBudgetError,
    threadReadPageAllowance,
    threadReadResultOverhead
} from './threadRead';
// F8: the byte pins below are derived with the harness's own payload measure, so a change
// to the escape table moves the pins and the cap together. Tests are not bound by the
// runtime-entry rule that keeps the SIZE a literal in the module under test.
import { modelPayloadBytes } from '../../core/payload-bytes';
// The delivery cap and the bounder that enforces it: the regression test in the page-budget
// suite hands a finished page to `boundToolResult` and demands it be DELIVERED, which is the
// guarantee this reader's budget exists to provide.
import { boundToolResult, MODEL_TOOL_RESULT_BUDGET_BYTES } from '../../core';

// One host thread, with the label the projection is expected to echo.
const RECORD: HarnessThreadRecord = {
    id: 'thread-1',
    agent: 'writer',
    origin: 'host',
    status: 'idle',
    sequence: 2,
    label: 'Research'
};

// The same record without optional fields, so the ABSENT keys are pinned too.
const PLAIN_RECORD: HarnessThreadRecord = {
    id: 'thread-1',
    agent: 'writer',
    origin: 'host',
    status: 'idle',
    sequence: 2
};

// A delegated child: the owner link must appear in the identity block.
const CHILD_RECORD: HarnessThreadRecord = {
    ...PLAIN_RECORD,
    origin: 'host',
    ownerThreadId: 'agent:writer'
};

// A five-message transcript that exercises every message shape at once:
// system seed, user message WITH an attachment, assistant turn with reasoning and
// a tool call, the tool result, and a final assistant answer.
const MESSAGES: HarnessMessage[] = [
    { role: 'system', content: 'You are careful.' },
    {
        role: 'user',
        content: 'Summarise the report.',
        attachments: [
            {
                id: 'a1',
                kind: 'image',
                marker: '[Image 1]',
                name: 'chart.png',
                mime: 'image/png',
                size: 2048,
                data: 'AAECAwQ='
            }
        ]
    },
    {
        role: 'assistant',
        content: 'Reading it.',
        reasoning: 'The TODO list matters.',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"report.md"}' }]
    },
    { role: 'tool', content: 'TODO: two open items', toolCallId: 'c1', name: 'read' },
    { role: 'assistant', content: 'Two TODO items remain.' }
];

// The attachment row every assertion reuses: descriptors only, `data` gone.
const ATTACHMENT = {
    id: 'a1',
    kind: 'image',
    name: 'chart.png',
    mime: 'image/png',
    size: 2048
} as const;

// The assistant tool-call row every assertion reuses.
const TOOL_CALL = {
    id: 'c1',
    name: 'read',
    arguments: '{"path":"report.md"}'
} as const;

// The SAME call as the default `toolArgs: "reference"` page must show it: the payload
// named by length, its text absent, and no truncation flag (nothing was cut).
const TOOL_CALL_REF = {
    id: 'c1',
    name: 'read',
    argumentsLength: 20
} as const;

const indicesOf = (result: { messages: { index: number }[] }): number[] =>
    result.messages.map((message) => message.index);

// F8 — the page's `bytes` is charged in the DELIVERY currency, so every byte pin in this
// file is DERIVED from the numbers the reader charges with (the exported
// `THREAD_READ_WIRE_SHELLS`) plus the escaped width of each displayed string, instead of a
// hand-typed total the reader could drift from. The shells are the receipts' own scaffolding
// (keys, flags, counters and the quotes around an empty text field); `wire` is the escaped
// width the harness cap counts — the TWO escaping layers a value passes through before it is
// billed, minus the two framing quotes a shell already prices, exactly as
// `contentWireBytes` does in threadRead.ts. Tests import the same payload measure the
// cap uses (core/payload-bytes.ts) rather than restating it.
// ---------------------------------------------------------------------------
const wire = (value: string): number => modelPayloadBytes(JSON.stringify(value)) - 2;
const SHELLS = THREAD_READ_WIRE_SHELLS;

// One message receipt, described the way the page shows it. `toolArgsMode` selects the
// tool-call shell (`reference` is the default, and is the smaller one because no arguments
// TEXT is displayed); `matchedFields` marks a `regex` page, which prices the widest hit
// list; `toolIdentity` is a `tool`-role message's two identity strings.
type ReceiptSpec = {
    content: string;
    attachments?: readonly { id: string; kind: string; name: string; mime: string }[];
    toolCalls?: readonly { id: string; name: string; arguments?: string }[];
    toolArgsMode?: 'full' | 'reference';
    reasoning?: string;
    matchedFields?: boolean;
    toolIdentity?: { name: string; toolCallId: string };
};

const receiptBytes = (spec: ReceiptSpec): number => {
    let bytes = SHELLS.message + wire(spec.content);

    if (spec.matchedFields === true) bytes += SHELLS.matchFields;
    if (spec.reasoning !== undefined) bytes += SHELLS.reasoning + wire(spec.reasoning);

    if (spec.attachments !== undefined && spec.attachments.length > 0) {
        bytes += spec.attachments.reduce(
            (total, attachment) =>
                total +
                SHELLS.attachmentItem +
                wire(attachment.id) +
                wire(attachment.kind) +
                wire(attachment.name) +
                wire(attachment.mime),
            SHELLS.attachments
        );
    }

    if (spec.toolCalls !== undefined && spec.toolCalls.length > 0) {
        const callShell =
            spec.toolArgsMode === 'full' ? SHELLS.toolCallFull : SHELLS.toolCallReference;

        // The `toolCalls` KEY is priced once per message, the item shells once per call —
        // exactly the shape the reader charges (threadRead.ts, shell pass).
        bytes += SHELLS.toolCalls + spec.toolCalls.reduce((total, call) => {
            let item = callShell + wire(call.id) + wire(call.name);

            // Only `full` mode displays the arguments text, and only `full` pays for it.
            if (spec.toolArgsMode === 'full') item += wire(call.arguments ?? '');

            return total + item;
        }, 0);
    }

    if (spec.toolIdentity !== undefined) {
        bytes +=
            SHELLS.toolIdentity + wire(spec.toolIdentity.name) + wire(spec.toolIdentity.toolCallId);
    }

    return bytes;
};

const pageBytes = (...receipts: ReceiptSpec[]): number =>
    receipts.reduce((total, receipt) => total + receiptBytes(receipt), 0);

// The no-argument read of `MESSAGES` as a receipt list: the system seed is absent (it is
// not returned), message 1 carries the attachment, message 2 the tool call in `reference`
// mode (no arguments TEXT, so no charge for one), message 3 is a `tool` result with its
// identity strings, message 4 is plain. Several tests assert this page's byte total, so it
// is stated once.
const DEFAULT_PAGE: ReceiptSpec[] = [
    { content: 'Summarise the report.', attachments: [ATTACHMENT] },
    { content: 'Reading it.', toolCalls: [TOOL_CALL], toolArgsMode: 'reference' },
    { content: 'TODO: two open items', toolIdentity: { name: 'read', toolCallId: 'c1' } },
    { content: 'Two TODO items remain.' }
];

// The system seed as a receipt — opt it in and the page pays its shell and its text.
const SEED_RECEIPT: ReceiptSpec = { content: 'You are careful.' };

// Message 2 as a receipt, which is the page `message: 2` answers with, with or without the
// reasoning the message carries.
const ASSISTANT_RECEIPT: ReceiptSpec = {
    content: 'Reading it.',
    toolCalls: [TOOL_CALL],
    toolArgsMode: 'reference'
};

// The same message in `toolArgs: "full"` mode: the bigger call shell, plus the arguments
// text quoted in full (it fits `contentLimit`, so nothing is cut).
const ASSISTANT_FULL_RECEIPT: ReceiptSpec = {
    content: 'Reading it.',
    toolCalls: [TOOL_CALL],
    toolArgsMode: 'full'
};

describe('published bounds', () => {
    it('keeps the page, text and matching numbers the entry schema quotes', () => {
        // threadRead.tool.ts repeats these as JSON Schema literals (a runtime entry
        // may not value-import ../../core), so the equality lives here.
        expect(THREAD_READ_CONTENT_BUDGET_BYTES).toBe(32 * 1024);
        expect(THREAD_READ_DEFAULT_LIMIT).toBe(20);
        expect(THREAD_READ_MAX_LIMIT).toBe(100);
        expect(THREAD_READ_DEFAULT_CONTENT_LIMIT).toBe(4000);
        expect(THREAD_READ_MAX_CONTENT_LIMIT).toBe(32_000);
        expect(MAX_THREAD_MATCH_MILLIS).toBe(30_000);
        // F8: this budget IS the harness delivery cap, measured in the cap's own escaped
        // currency — not "half the 64 KiB cap", which is what this pin used to assert (both
        // that sentence and that cap are history: core/result-budget.ts is 32,768 escaped
        // payload bytes of the WHOLE result, and the reader reserves its own scaffolding
        // against it). Equality with the imported constant is the pin, so the two numbers
        // can never drift apart silently again.
        expect(THREAD_READ_CONTENT_BUDGET_BYTES).toBe(MODEL_TOOL_RESULT_BUDGET_BYTES);
    });

    it('publishes the searchable-field vocabulary in its canonical order', () => {
        // One vocabulary drives `regexFields` (the entry's enum repeats these four
        // words, in this order) and the `matchedFields` report. Reordering this array
        // would silently reorder every reported hit list, so it is pinned exactly.
        expect(THREAD_READ_MATCH_FIELDS).toEqual(['content', 'reasoning', 'toolArguments', 'toolName']);
    });
});

describe('parseThreadPattern', () => {
    it('passes a bare source through with the supplied flags', () => {
        expect(parseThreadPattern('thread.*')).toEqual({ source: 'thread.*', flags: '' });
        expect(parseThreadPattern('TODO', 'i')).toEqual({ source: 'TODO', flags: 'i' });
    });

    it('recognises the /pattern/flags spelling', () => {
        expect(parseThreadPattern('/TODO/')).toEqual({ source: 'TODO', flags: '' });
        expect(parseThreadPattern('/TODO/i')).toEqual({ source: 'TODO', flags: 'i' });
        expect(parseThreadPattern('/a\\/b/i')).toEqual({ source: 'a\\/b', flags: 'i' });
        // An empty delimited pattern is the empty source, not a parse failure.
        expect(parseThreadPattern('//')).toEqual({ source: '', flags: '' });
    });

    it('lets the delimited flags win over the flags parameter', () => {
        expect(parseThreadPattern('/TODO/i', 'g')).toEqual({ source: 'TODO', flags: 'i' });
        // No flags inside the literal, so the parameter is the only source of them.
        expect(parseThreadPattern('/TODO/', 'i')).toEqual({ source: 'TODO', flags: 'i' });
    });

    it('keeps a source that merely contains a slash literal', () => {
        // The tail after the final slash is not made of flag characters, so this is
        // a plain source — which is what `thread/1` and a lone `/` have to stay.
        expect(parseThreadPattern('thread/1')).toEqual({ source: 'thread/1', flags: '' });
        expect(parseThreadPattern('/a/b/x')).toEqual({ source: '/a/b/x', flags: '' });
        expect(parseThreadPattern('/')).toEqual({ source: '/', flags: '' });
    });
});

describe('readThreadTranscript — full read', () => {
    it('returns the first page with defaults, every field exact', () => {
        // The defaults now are `includeSystem: false` and `toolArgs: "reference"`, so
        // a no-argument read of this transcript starts at index 1 and never quotes the
        // tool-call payload. `total` still counts all five messages and `index` still
        // numbers the FULL transcript — the filters relabel nothing.
        expect(readThreadTranscript(RECORD, MESSAGES, {})).toEqual({
            thread: {
                id: 'thread-1',
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: 2,
                label: 'Research'
            },
            total: 5,
            matched: 4,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            // F8: every returned receipt pays its measured shell, the attachment descriptor
            // pays for its id/kind/name/mime, and the `reference` tool-call row pays its own
            // (smaller) shell while still quoting no arguments TEXT. The system seed costs
            // nothing because it is not returned at all. Derived from the exported shells —
            // see the helper block above — rather than typed as a total.
            bytes: pageBytes(...DEFAULT_PAGE),
            truncated: false,
            messages: [
                {
                    index: 1,
                    role: 'user',
                    content: 'Summarise the report.',
                    contentLength: 21,
                    contentOffset: 0,
                    contentHasMore: false,
                    attachments: [ATTACHMENT]
                },
                {
                    index: 2,
                    role: 'assistant',
                    content: 'Reading it.',
                    contentLength: 11,
                    contentOffset: 0,
                    contentHasMore: false,
                    toolCalls: [TOOL_CALL_REF]
                },
                {
                    index: 3,
                    role: 'tool',
                    content: 'TODO: two open items',
                    contentLength: 20,
                    contentOffset: 0,
                    contentHasMore: false,
                    name: 'read',
                    toolCallId: 'c1'
                },
                {
                    index: 4,
                    role: 'assistant',
                    content: 'Two TODO items remain.',
                    contentLength: 22,
                    contentOffset: 0,
                    contentHasMore: false
                }
            ]
        });
    });

    it('keeps the system seed out of the page, and puts it back on request', () => {
        const without = readThreadTranscript(RECORD, MESSAGES, {});
        const withSeed = readThreadTranscript(RECORD, MESSAGES, { includeSystem: true });

        // The seed is a whole-message exclusion, not a renumbering: opting in adds
        // index 0 and changes nothing else about the addresses.
        expect(without.messages.map((message) => message.index)).toEqual([1, 2, 3, 4]);
        expect(withSeed.messages.map((message) => message.index)).toEqual([0, 1, 2, 3, 4]);
        expect(withSeed.messages[0]).toEqual({
            index: 0,
            role: 'system',
            content: 'You are careful.',
            contentLength: 16,
            contentOffset: 0,
            contentHasMore: false
        });

        // I2 is literally a byte fix: the seed was charged to EVERY page. Under F8 its cost
        // is a whole receipt — its shell plus its 16 characters — which is what this
        // comparison measures. `matched` (the filtered count) gains it as well, while
        // `total` stays 5 either way.
        expect({ without: without.bytes, withSeed: withSeed.bytes }).toEqual({
            without: pageBytes(...DEFAULT_PAGE),
            withSeed: pageBytes(SEED_RECEIPT, ...DEFAULT_PAGE)
        });
        expect({
            withoutTotal: without.total,
            withoutMatched: without.matched,
            seedTotal: withSeed.total,
            seedMatched: withSeed.matched
        }).toEqual({ withoutTotal: 5, withoutMatched: 4, seedTotal: 5, seedMatched: 5 });
    });

    it('omits the optional identity keys the record does not carry', () => {
        const thread = readThreadTranscript(PLAIN_RECORD, MESSAGES, {}).thread;

        expect(thread).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 2
        });
        expect('label' in thread).toBe(false);
        expect('ownerThreadId' in thread).toBe(false);
    });

    it('reports the owner link of a delegated child thread', () => {
        expect(readThreadTranscript(CHILD_RECORD, [], {}).thread).toEqual({
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'idle',
            sequence: 2,
            ownerThreadId: 'agent:writer'
        });
    });

    it('answers an empty thread as an empty page, not an error', () => {
        expect(readThreadTranscript(PLAIN_RECORD, [], { role: 'assistant' })).toEqual({
            thread: {
                id: 'thread-1',
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: 2
            },
            total: 0,
            matched: 0,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            bytes: 0,
            truncated: false,
            messages: []
        });
    });

    it('never reports reasoning unless it is asked for', () => {
        // Message 2 HAS reasoning; the default page must not carry it, and must not
        // charge it against the byte budget either. What the page DOES charge is its own
        // receipt: shell + the 11 characters + the `reference` call row (F8 — a reference
        // costs its receipt, just not the arguments text).
        const [message] = readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).messages;

        expect('reasoning' in message).toBe(false);
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).bytes).toBe(
            receiptBytes(ASSISTANT_RECEIPT)
        );
    });

    it('includes reasoning when asked, and flags a cut one', () => {
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                message: 2,
                includeReasoning: true
            }).messages[0]
        ).toEqual({
            index: 2,
            role: 'assistant',
            content: 'Reading it.',
            contentLength: 11,
            contentOffset: 0,
            contentHasMore: false,
            toolCalls: [TOOL_CALL_REF],
            reasoning: 'The TODO list matters.'
        });

        // `contentLimit` caps reasoning the same way it caps content: separate
        // truncation flags, and the full length for the caller to page from. The
        // tool-call row stays a REFERENCE here — `contentLimit` bounds the text a mode
        // actually returns, and reference mode returns none of it.
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                message: 2,
                includeReasoning: true,
                contentLimit: 10
            }).messages[0]
        ).toEqual({
            index: 2,
            role: 'assistant',
            content: 'Reading it',
            contentLength: 11,
            contentOffset: 0,
            contentHasMore: true,
            nextContentOffset: 10,
            toolCalls: [TOOL_CALL_REF],
            reasoning: 'The TODO l',
            reasoningTruncated: true,
            reasoningLength: 22
        });
    });
});

describe('readThreadTranscript — single message', () => {
    it('reads one raw transcript index and bypasses the filters', () => {
        // `role: user` would have dropped this tool message, and `limit` would have
        // moved the window: `message` ignores both, and `matched` is the one message.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 3, role: 'user', limit: 1 })).toEqual({
            thread: {
                id: 'thread-1',
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: 2
            },
            total: 5,
            matched: 1,
            offset: 3,
            limit: 1,
            hasMore: false,
            contentBudget: 32768,
            // The tool result's receipt: its shell, its 20 characters, and the `name` /
            // `toolCallId` identity strings the page quotes (F8 prices those too).
            bytes: receiptBytes({
                content: 'TODO: two open items',
                toolIdentity: { name: 'read', toolCallId: 'c1' }
            }),
            truncated: false,
            messages: [
                {
                    index: 3,
                    role: 'tool',
                    content: 'TODO: two open items',
                    contentLength: 20,
                    contentOffset: 0,
                    contentHasMore: false,
                    name: 'read',
                    toolCallId: 'c1'
                }
            ]
        });
    });

    it('still pages that message content with contentOffset and contentLimit', () => {
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                message: 1,
                contentOffset: 10,
                contentLimit: 5
            })
        ).toEqual({
            thread: {
                id: 'thread-1',
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: 2
            },
            total: 5,
            matched: 1,
            offset: 1,
            limit: 1,
            hasMore: false,
            contentBudget: 32768,
            // Five displayed characters, plus the receipt this page returns — and the
            // attachment row of that same message, which the page still shows and F8
            // therefore charges (the old accounting priced it at zero).
            bytes: receiptBytes({ content: 'the r', attachments: [ATTACHMENT] }),
            truncated: false,
            messages: [
                {
                    index: 1,
                    role: 'user',
                    content: 'the r',
                    contentLength: 21,
                    contentOffset: 10,
                    contentHasMore: true,
                    nextContentOffset: 15,
                    attachments: [ATTACHMENT]
                }
            ]
        });
    });

    it('rejects an index past the end of the transcript', () => {
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 9 })).toThrow(
            'threadRead "message" 9 is out of range: thread "thread-1" has 5 messages.'
        );
        // Index 4 is the last valid one, so the boundary itself is not an error.
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 4 }))).toEqual([4]);
        expect(() => readThreadTranscript(PLAIN_RECORD, [], { message: 0 })).toThrow(
            'threadRead "message" 0 is out of range: thread "thread-1" has 0 messages.'
        );
    });

    it('still reads the system seed, and computes no matchedFields', () => {
        // `message` addresses a RAW transcript position, so it bypasses `includeSystem`
        // exactly as it bypasses `role` — index 0 is reachable without the opt-in.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 0 }).messages[0]).toEqual({
            index: 0,
            role: 'system',
            content: 'You are careful.',
            contentLength: 16,
            contentOffset: 0,
            contentHasMore: false
        });

        // Same bypass for `regex`: the matcher never runs in this mode, so there is no
        // hit list to report and the key stays absent rather than an empty array.
        const [hit] = readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2, regex: 'TODO' }).messages;

        expect('matchedFields' in hit).toBe(false);
        expect(hit.matchedFields).toBeUndefined();

        // Without a regex the key is absent too, on a page that DOES filter.
        const [plain] = readThreadTranscript(PLAIN_RECORD, MESSAGES, {}).messages;

        expect('matchedFields' in plain).toBe(false);
    });
});

describe('readThreadTranscript — regex filtering', () => {
    it('matches message content', () => {
        // 'careful' lives ONLY in the system seed. With `includeSystem` at its default
        // that message is not merely hidden from the page — it never enters the regex
        // haystack either (I1/I2), so the whole read is empty.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'careful' })).toMatchObject({
            matched: 0,
            total: 5
        });
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'careful' }))).toEqual([]);

        // The opt-in restores it as a candidate, and the hit list names the field.
        const seeded = readThreadTranscript(PLAIN_RECORD, MESSAGES, {
            regex: 'careful',
            includeSystem: true
        });

        expect({ total: seeded.total, matched: seeded.matched, indices: indicesOf(seeded) }).toEqual({
            total: 5,
            matched: 1,
            indices: [0]
        });
        expect(seeded.messages[0].matchedFields).toEqual(['content']);
    });

    it('matches assistant reasoning, which the page itself does not return', () => {
        // Only message 2's REASONING mentions TODO in a way the content does not, so
        // this proves reasoning is searchable while still being opt-in for output.
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'list matters' });

        expect(indicesOf(result)).toEqual([2]);
        // I4 is what makes that answer explainable: the page shows no reasoning at all
        // (`includeReasoning` defaults to false), and the row still says why it is here.
        expect(result.messages[0].matchedFields).toEqual(['reasoning']);
        expect('reasoning' in result.messages[0]).toBe(false);
    });

    it('matches tool-call names and raw arguments', () => {
        const report = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '/report/' });

        expect(indicesOf(report)).toEqual([1, 2]);
        // One pattern, two different fields: the user message hits on its content and
        // the assistant turn hits on a payload the page does not quote (reference mode
        // is a DISPLAY choice; matching still reads the raw arguments — I3/I4).
        expect(report.messages.map((message) => message.matchedFields)).toEqual([
            ['content'],
            ['toolArguments']
        ]);

        const file = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'report\\.md' });

        expect(indicesOf(file)).toEqual([2]);
        expect(file.messages[0].matchedFields).toEqual(['toolArguments']);
    });

    it('matches a tool message by the tool it answers', () => {
        // `^read$` only hits when the tool NAME is its own searchable field: the
        // message content here never equals "read" on its own.
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '^read$' });

        expect(indicesOf(result)).toEqual([2, 3]);
        // `toolName` covers both sides of the call: the assistant's call name (index 2,
        // where the row itself shows `name: "read"` nowhere) and the tool result's name.
        expect(result.messages.map((message) => message.matchedFields)).toEqual([
            ['toolName'],
            ['toolName']
        ]);
    });

    it('never matches across a field boundary', () => {
        // 'it.' ends the content and 'The TODO' begins the reasoning. A concatenated
        // haystack would match this pattern; separate fields must not.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'it\\. The TODO' })).toEqual({
            thread: {
                id: 'thread-1',
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: 2
            },
            total: 5,
            matched: 0,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            bytes: 0,
            truncated: false,
            messages: []
        });
    });

    it('is case-sensitive until flags say otherwise', () => {
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'REPORT' }))).toEqual([]);
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'REPORT', flags: 'i' }))).toEqual([1, 2]);
    });

    it('honours flags carried by the delimited spelling', () => {
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '/report/i' }))).toEqual([1, 2]);
    });

    it('applies the role filter and the regex together', () => {
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { role: 'assistant' }))).toEqual([2, 4]);
        expect(
            indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { role: 'assistant', regex: 'Reading' }))
        ).toEqual([2]);
        // A role that would have matched is still required to match the regex.
        expect(
            indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { role: 'tool', regex: 'Reading' }))
        ).toEqual([]);
        // `role: "system"` does NOT imply the includeSystem opt-in: the seed is off
        // until it is asked for, so this is an honest empty page rather than a page
        // that contradicts the default.
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { role: 'system' }))).toEqual([]);
        expect(
            indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { role: 'system', includeSystem: true }))
        ).toEqual([0]);
    });

    it('returns every NON-SYSTEM message when nothing filters', () => {
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, {}))).toEqual([1, 2, 3, 4]);
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { includeSystem: true }))).toEqual([
            0, 1, 2, 3, 4
        ]);
    });
});

describe('readThreadTranscript — regexFields and matchedFields (I4)', () => {
    // The default is the pre-I4 behavior: every searchable field is searched. These
    // four patterns each hit EXACTLY ONE field, so they pin the default selection and
    // the vocabulary at the same time.
    const ONE_FIELD_PATTERNS: [string, ThreadReadMatchField][] = [
        ['Summarise', ['content']],
        ['list matters', ['reasoning']],
        ['report\\.md', ['toolArguments']],
        ['^read$', ['toolName']]
    ];

    it('searches all four fields by default', () => {
        for (const [pattern, expected] of ONE_FIELD_PATTERNS) {
            const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: pattern });

            expect({ pattern, matchedFields: result.messages[0].matchedFields }).toEqual({
                pattern,
                matchedFields: expected
            });
        }
    });

    it('restricts MATCHING when a selection is given', () => {
        // 'report.md' exists ONLY inside the tool call's raw arguments. Searching
        // content alone therefore finds nothing at all — the message is not reported
        // with a hidden reason, it is genuinely not a match.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'report\\.md', regexFields: ['content'] })).toEqual({
            thread: {
                id: 'thread-1',
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: 2
            },
            total: 5,
            matched: 0,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            bytes: 0,
            truncated: false,
            messages: []
        });

        // Each single-field selection finds exactly what its field holds, and nothing
        // else. `toolName` is the one word for both sides of a call, so it keeps both
        // the assistant's call name and the tool result's name.
        expect(
            indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'report\\.md', regexFields: ['toolArguments'] }))
        ).toEqual([2]);
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'TODO', regexFields: ['reasoning'] }))).toEqual([2]);
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '^read$', regexFields: ['toolName'] }))).toEqual([2, 3]);
        expect(
            indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'TODO', regexFields: ['reasoning', 'content'] }))
        ).toEqual([2, 3, 4]);
    });

    it('never lets the selection change what the page displays', () => {
        // 'report' is in the user content (index 1) AND in the arguments (index 2).
        // Searching content alone drops index 2 from the RESULT SET; the row that does
        // survive keeps every field the other filters allow (its attachment view).
        const restricted = readThreadTranscript(PLAIN_RECORD, MESSAGES, {
            regex: 'report',
            regexFields: ['content']
        });

        expect(indicesOf(restricted)).toEqual([1]);
        expect(restricted.messages[0].attachments).toEqual([ATTACHMENT]);
        expect(restricted.messages[0].matchedFields).toEqual(['content']);

        // Adding the arguments field back adds the message back — the same call with a
        // wider SEARCH, not a wider display.
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                regex: 'report',
                regexFields: ['content', 'toolArguments']
            }).messages.map((message) => message.matchedFields)
        ).toEqual([['content'], ['toolArguments']]);
    });

    it('reports every field a message hit, in canonical order', () => {
        // `.` hits every non-empty field of every candidate: this pins both the
        // multi-kind report and the canonical ordering (vocabulary order, NOT the order
        // the matcher happened to reach the fields in).
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '.' }).messages.map((message) => ({
                index: message.index,
                matchedFields: message.matchedFields
            }))
        ).toEqual([
            { index: 1, matchedFields: ['content'] },
            { index: 2, matchedFields: ['content', 'reasoning', 'toolArguments', 'toolName'] },
            { index: 3, matchedFields: ['content', 'toolName'] },
            { index: 4, matchedFields: ['content'] }
        ]);

        // A caller that spells the selection in the opposite order gets the SAME
        // canonical hit list back — duplicates included — so `matchedFields` can be
        // compared against a fixed value instead of a set.
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                regex: '.',
                regexFields: ['toolName', 'content', 'toolArguments', 'reasoning', 'content']
            }).messages.map((message) => message.matchedFields)
        ).toEqual([
            ['content'],
            ['content', 'reasoning', 'toolArguments', 'toolName'],
            ['content', 'toolName'],
            ['content']
        ]);
    });

    it('names a hit the page cannot show', () => {
        // THE point of I4. With the display defaults (no reasoning, reference tool
        // calls), three of the four field kinds are invisible on the page — yet every
        // row still states which one matched.
        const rows = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '.' }).messages;

        expect(rows.map((row) => ('reasoning' in row))).toEqual([false, false, false, false]);
        expect(rows.map((row) => ('arguments' in (row.toolCalls ?? [{}])[0]))).toEqual([
            false,
            false,
            false,
            false
        ]);
        expect(rows[1].matchedFields).toEqual(['content', 'reasoning', 'toolArguments', 'toolName']);

        // `includeReasoning: true` changes what the row CARRIES, and nothing about what
        // it reports as matched.
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'list matters', includeReasoning: true }).messages[0]
                .matchedFields
        ).toEqual(['reasoning']);
    });

    it('makes the SELF-MATCH visible, and removable', () => {
        // A model reading its own thread sees the assistant turn that carries THIS very
        // call: its raw arguments contain the pattern it just sent, so the turn matches
        // even though the page shows no text of its own. Before I4 that row looked like
        // a bug (empty content, unexplained match).
        const self: HarnessMessage[] = [
            { role: 'user', content: 'start here' },
            { role: 'assistant', content: 'seeded' },
            { role: 'user', content: 'look back' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'threadRead', arguments: '{"regex":"start here"}' }]
            }
        ];

        const every = readThreadTranscript(PLAIN_RECORD, self, { regex: 'start here' });

        expect({ total: every.total, matched: every.matched, bytes: every.bytes }).toEqual({
            total: 4,
            matched: 2,
            // F8: both hits pay their receipt shells, and a `regex` page pays the
            // `matchedFields` list too (priced at its widest). The self-matched row still
            // contributes no TEXT — its content is empty and reference mode quotes no
            // arguments — which is the point the assertions below keep proving.
            bytes: pageBytes(
                { content: 'start here', matchedFields: true },
                {
                    content: '',
                    toolCalls: [{ id: 'c1', name: 'threadRead' }],
                    toolArgsMode: 'reference',
                    matchedFields: true
                }
            )
        });
        expect(every.messages.map((message) => ({ index: message.index, matchedFields: message.matchedFields }))).toEqual([
            { index: 0, matchedFields: ['content'] },
            { index: 3, matchedFields: ['toolArguments'] }
        ]);
        // The self-matched row quotes no arguments text at all — only the report proves
        // why it is here.
        expect(every.messages[1].content).toBe('');
        expect(every.messages[1].toolCalls).toEqual([{ id: 'c1', name: 'threadRead', argumentsLength: 22 }]);

        // `regexFields` is the actionable escape hatch: search content only and the
        // self-match is gone, with no pattern gymnastics.
        const contentOnly = readThreadTranscript(PLAIN_RECORD, self, {
            regex: 'start here',
            regexFields: ['content']
        });

        expect({ matched: contentOnly.matched, indices: indicesOf(contentOnly) }).toEqual({
            matched: 1,
            indices: [0]
        });
    });
});

describe('readThreadTranscript — toolArgs display modes (I3)', () => {
    it('shows a reference by default, costing no arguments text', () => {
        const [message] = readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).messages;

        // { id, name, argumentsLength } and nothing else: the payload is named and
        // sized, never quoted.
        expect(message.toolCalls).toEqual([TOOL_CALL_REF]);
        expect('arguments' in message.toolCalls![0]).toBe(false);
        // No truncation flag either — nothing was CUT, the text was omitted by policy,
        // and the absent `arguments` key is what says so.
        expect('argumentsTruncated' in message.toolCalls![0]).toBe(false);
        // The page costs its receipt and the smaller call shell, but NOT the 20 characters
        // of payload the `full` page below quotes — that saving is the whole point of the
        // mode, and F8 kept it while pricing the receipt the old comment called free.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).bytes).toBe(
            receiptBytes(ASSISTANT_RECEIPT)
        );
    });

    it('returns the paged arguments text in full mode, exactly as before', () => {
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2, toolArgs: 'full' }).messages[0].toolCalls
        ).toEqual([TOOL_CALL]);

        // `contentLimit` pages the payload and flags the cut, with the FULL raw length
        // for the caller to judge what is missing (today's behavior, unchanged).
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                message: 2,
                toolArgs: 'full',
                contentLimit: 10
            }).messages[0].toolCalls
        ).toEqual([
            {
                id: 'c1',
                name: 'read',
                arguments: '{"path":"r',
                argumentsTruncated: true,
                argumentsLength: 20
            }
        ]);

        // The same page in `full` mode: the bigger call shell plus the 20 quoted arguments
        // characters, against the reference page above — the difference IS the payload.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2, toolArgs: 'full' }).bytes).toBe(
            receiptBytes(ASSISTANT_FULL_RECEIPT)
        );
    });

    it('searches the raw arguments whichever mode is display', () => {
        // `"path"` exists only inside the raw JSON arguments, so a hit here can only
        // come from the raw text — while the row itself still shows no arguments.
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '"path"' });

        expect(indicesOf(result)).toEqual([2]);
        expect(result.messages[0].matchedFields).toEqual(['toolArguments']);
        expect(result.messages[0].toolCalls).toEqual([TOOL_CALL_REF]);

        const full = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '"path"', toolArgs: 'full' });

        expect(indicesOf(full)).toEqual([2]);
        expect(full.messages[0].matchedFields).toEqual(['toolArguments']);
        expect(full.messages[0].toolCalls).toEqual([TOOL_CALL]);
    });

    it('keeps a message on the page that full mode cannot afford', () => {
        // The efficiency claim, proven as a byte fact. One big payload plus one short
        // follow-up, under a contentLimit that lets either mode quote everything.
        const messages: HarnessMessage[] = [
            {
                role: 'assistant',
                content: 'a'.repeat(20_000),
                toolCalls: [{ id: 'c1', name: 'write', arguments: 'p'.repeat(20_000) }]
            },
            { role: 'user', content: 'qqqqqqqqqq' }
        ];

        const reference = readThreadTranscript(PLAIN_RECORD, messages, { limit: 5, contentLimit: 32_000 });

        expect({
            matched: reference.matched,
            bytes: reference.bytes,
            truncated: reference.truncated,
            hasMore: reference.hasMore,
            indices: indicesOf(reference)
        }).toEqual({
            matched: 2,
            // The 20 000-character payload contributes NOTHING in reference mode — that
            // saving is the point of the mode, and F8 kept it. What the page does pay is
            // both receipts and the follow-up's 10 characters.
            bytes: pageBytes(
                {
                    content: 'a'.repeat(20_000),
                    toolCalls: [{ id: 'c1', name: 'write' }],
                    toolArgsMode: 'reference'
                },
                { content: 'qqqqqqqqqq' }
            ),
            truncated: false,
            hasMore: false,
            indices: [0, 1]
        });

        // F8 — the cut the `full` page enforces is the ALLOWANCE (`threadReadPageAllowance`:
        // the delivery budget minus this result's own measured scaffolding), not the raw
        // 32 768 cap. The arguments text gets whatever the allowance still has once this
        // message's receipt is paid — its shell, the `full` call shell, the two identity
        // strings and its 20 000 characters. `p` costs one payload byte each, but every
        // string value also carries `wire('')` = 2 bytes of double-escaped framing quotes,
        // so the affordable character count is the room minus that fixed pair.
        const fullAllowance = threadReadPageAllowance(PLAIN_RECORD);
        const fullArguments = 'p'.repeat(
            fullAllowance -
                (SHELLS.message +
                    wire('a'.repeat(20_000)) +
                    SHELLS.toolCalls +
                    SHELLS.toolCallFull +
                    wire('c1') +
                    wire('write')) -
                wire('')
        );

        const full = readThreadTranscript(PLAIN_RECORD, messages, {
            limit: 5,
            contentLimit: 32_000,
            toolArgs: 'full'
        });

        expect({
            matched: full.matched,
            bytes: full.bytes,
            truncated: full.truncated,
            hasMore: full.hasMore,
            nextOffset: full.nextOffset,
            indices: indicesOf(full),
            argumentsRow: full.messages[0].toolCalls
        }).toEqual({
            matched: 2,
            // The allowance is exactly full, and the WHOLE serialized result — envelope
            // scaffolding included — still fits the cap that is what the harness enforces.
            bytes: fullAllowance,
            truncated: true,
            // The second message is gone, whole: its receipt alone would not fit. That is
            // what `hasMore` is for.
            hasMore: true,
            nextOffset: 1,
            indices: [0],
            argumentsRow: [
                {
                    id: 'c1',
                    name: 'write',
                    arguments: fullArguments,
                    argumentsTruncated: true,
                    argumentsLength: 20_000
                }
            ]
        });
    });
});

describe('readThreadTranscript — pagination', () => {
    it('pages the FILTERED list and reports nextOffset', () => {
        const first = readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'TODO', limit: 2 });

        expect({
            matched: first.matched,
            offset: first.offset,
            limit: first.limit,
            hasMore: first.hasMore,
            nextOffset: first.nextOffset,
            indices: indicesOf(first)
        }).toEqual({
            matched: 3,
            offset: 0,
            limit: 2,
            hasMore: true,
            nextOffset: 2,
            indices: [2, 3]
        });

        // Feeding nextOffset back as offset lands on the remaining match exactly.
        const second = readThreadTranscript(PLAIN_RECORD, MESSAGES, {
            regex: 'TODO',
            limit: 2,
            offset: first.nextOffset!
        });

        expect({
            matched: second.matched,
            offset: second.offset,
            hasMore: second.hasMore,
            nextOffset: second.nextOffset,
            indices: indicesOf(second)
        }).toEqual({ matched: 3, offset: 2, hasMore: false, nextOffset: undefined, indices: [4] });
    });

    it('clamps an offset past the end of the filtered list', () => {
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { offset: 9 });

        // The candidate list is four messages long now (the seed is filtered out), so
        // the clamp lands on 4 — but `total` still says 5, because the FILTER never
        // changes what the transcript IS.
        expect({ total: result.total, matched: result.matched, offset: result.offset, messages: result.messages }).toEqual({
            total: 5,
            matched: 4,
            offset: 4,
            messages: []
        });
        expect(result.hasMore).toBe(false);
        expect('nextOffset' in result).toBe(false);
    });

    it('pages by CANDIDATE position while `index` numbers the full transcript', () => {
        // The decision I1/I2 had to make: an offset addresses the filtered list (as it
        // always has), it does not index raw messages. So the seed shifts the WINDOW,
        // never the ADDRESS, and `nextOffset` stays a legal continuation.
        const first = readThreadTranscript(PLAIN_RECORD, MESSAGES, { limit: 2 });

        expect({
            matched: first.matched,
            offset: first.offset,
            hasMore: first.hasMore,
            nextOffset: first.nextOffset,
            indices: indicesOf(first)
        }).toEqual({ matched: 4, offset: 0, hasMore: true, nextOffset: 2, indices: [1, 2] });

        const second = readThreadTranscript(PLAIN_RECORD, MESSAGES, { limit: 2, offset: first.nextOffset! });

        expect({
            matched: second.matched,
            offset: second.offset,
            hasMore: second.hasMore,
            nextOffset: second.nextOffset,
            indices: indicesOf(second)
        }).toEqual({ matched: 4, offset: 2, hasMore: false, nextOffset: undefined, indices: [3, 4] });

        // With the seed opted in, the same offsets walk one position further, and the
        // message AT each reported index is unchanged: index 2 is the assistant turn
        // whichever way the page was assembled.
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { limit: 2, includeSystem: true }))).toEqual([0, 1]);
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }))).toEqual([2]);
    });
});

describe('readThreadTranscript — text paging', () => {
    it('cuts each message at contentLimit and reports where to continue', () => {
        // `includeSystem: true` so the page still starts at index 0: this test is about
        // text paging, and the seed filter is pinned in its own tests above.
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, {
            contentLimit: 9,
            limit: 2,
            includeSystem: true
        });

        expect(result.messages).toEqual([
            {
                index: 0,
                role: 'system',
                content: 'You are c',
                contentLength: 16,
                contentOffset: 0,
                contentHasMore: true,
                nextContentOffset: 9
            },
            {
                index: 1,
                role: 'user',
                content: 'Summarise',
                contentLength: 21,
                contentOffset: 0,
                contentHasMore: true,
                nextContentOffset: 9,
                attachments: [ATTACHMENT]
            }
        ]);

        // A `contentLimit` cut is NOT a budget cut: `truncated` stays false.
        expect(result.truncated).toBe(false);
        // Both pages' receipts, with the 9+9 displayed characters (F8 — the old pin was the
        // character count alone, and the attachment row this page shows was free).
        expect(result.bytes).toBe(
            pageBytes(
                { content: 'You are c' },
                { content: 'Summarise', attachments: [ATTACHMENT] }
            )
        );

        // Continuing from nextContentOffset returns the rest, with no further flag
        // once the end is reached.
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                message: 0,
                contentOffset: 9,
                contentLimit: 9
            }).messages[0]
        ).toEqual({
            index: 0,
            role: 'system',
            content: 'areful.',
            contentLength: 16,
            contentOffset: 9,
            contentHasMore: false
        });
    });

    it('pages a tool-call arguments string without losing the call', () => {
        // `contentLimit` bounds the payload only when it is DISPLAYED, so paging it is
        // a `toolArgs: "full"` concern (the reference row is pinned in its own tests).
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                message: 2,
                contentLimit: 5,
                toolArgs: 'full'
            }).messages[0]
        ).toEqual({
            index: 2,
            role: 'assistant',
            content: 'Readi',
            contentLength: 11,
            contentOffset: 0,
            contentHasMore: true,
            nextContentOffset: 5,
            toolCalls: [
                {
                    id: 'c1',
                    name: 'read',
                    arguments: '{"pat',
                    argumentsTruncated: true,
                    argumentsLength: 20
                }
            ]
        });

        // Same call at the default: the content still pages, and the payload collapses
        // to a reference whose length is the full raw length, not the window.
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2, contentLimit: 5 }).messages[0]
        ).toEqual({
            index: 2,
            role: 'assistant',
            content: 'Readi',
            contentLength: 11,
            contentOffset: 0,
            contentHasMore: true,
            nextContentOffset: 5,
            toolCalls: [TOOL_CALL_REF]
        });
    });

    it('does not split a surrogate pair at the end of a slice', () => {
        // 'ab😀cd': units 2-3 are one pair, so a 3-unit window gives up its second
        // unit instead of returning half an emoji.
        const emoji = 'ab\u{1F600}cd';
        const messages: HarnessMessage[] = [{ role: 'user', content: emoji }];
        const result = readThreadTranscript(PLAIN_RECORD, messages, { contentLimit: 3 });

        expect(result.messages[0]).toEqual({
            index: 0,
            role: 'user',
            content: 'ab',
            contentLength: 6,
            contentOffset: 0,
            contentHasMore: true,
            nextContentOffset: 2
        });
        // The page is still valid JSON with no lone surrogate anywhere.
        expect(JSON.parse(JSON.stringify(result.messages[0])).content).toBe('ab');
    });

    it('does not split a surrogate pair at the start of a slice', () => {
        const emoji = 'ab\u{1F600}cd';
        const messages: HarnessMessage[] = [{ role: 'user', content: emoji }];
        const result = readThreadTranscript(PLAIN_RECORD, messages, {
            contentOffset: 3,
            contentLimit: 2
        });

        // The requested offset 3 is the LOW half, so the window starts one unit
        // earlier and returns the whole glyph (4 UTF-8 bytes, hence bytes 4).
        expect(result.messages[0]).toEqual({
            index: 0,
            role: 'user',
            content: emoji.slice(2, 4),
            contentLength: 6,
            contentOffset: 2,
            contentHasMore: true,
            nextContentOffset: 4
        });
        // F8 prices the page as the delivery cap measures it: the receipt shell plus the
        // glyph's four UTF-8 bytes. A SPLIT pair would cost six escaped bytes (`\udXXX`),
        // which is one of the reasons the pair rule above exists.
        expect(result.bytes).toBe(receiptBytes({ content: emoji.slice(2, 4) }));
    });

    it('answers an offset past the end of the content as empty text', () => {
        expect(
            readThreadTranscript(PLAIN_RECORD, MESSAGES, {
                message: 0,
                contentOffset: 99,
                contentLimit: 10
            }).messages[0]
        ).toEqual({
            index: 0,
            role: 'system',
            content: '',
            contentLength: 16,
            contentOffset: 16,
            contentHasMore: false
        });
    });
});

describe('readThreadTranscript — page budget', () => {
    it('cuts the second message and drops the third when the page is full', () => {
        const big = (character: string): HarnessMessage => ({
            role: 'user',
            content: character.repeat(20_000)
        });
        const messages: HarnessMessage[] = [big('a'), big('b'), big('c')];

        // F8 — the page fills the ALLOWANCE, not the raw cap. The allowance is the delivery
        // budget minus this result's own measured scaffolding, and that reservation is
        // exactly what keeps the serialized document inside the cap the harness enforces.
        const allowance = threadReadPageAllowance(PLAIN_RECORD);
        // The second message's text gets whatever the allowance still has once BOTH receipts
        // are paid — the first message's shell plus its 20 000 characters (charged WITH the
        // two bytes of double-escaped framing quotes every string value costs), and this
        // message's own shell. `b` costs one payload byte each, so the affordable count is
        // the remaining room minus that fixed framing pair; derived, not typed.
        const secondText = 'b'.repeat(
            allowance - (SHELLS.message + wire('a'.repeat(20_000))) - SHELLS.message - wire('')
        );

        const result = readThreadTranscript(PLAIN_RECORD, messages, { limit: 3, contentLimit: 32_000 });

        expect({
            total: result.total,
            matched: result.matched,
            offset: result.offset,
            limit: result.limit,
            hasMore: result.hasMore,
            nextOffset: result.nextOffset,
            contentBudget: result.contentBudget,
            bytes: result.bytes,
            truncated: result.truncated,
            indices: indicesOf(result)
        }).toEqual({
            total: 3,
            matched: 3,
            offset: 0,
            limit: 3,
            // Only two messages fit: the list is not finished, so `hasMore` is the
            // signal to keep reading even though `limit` was honoured.
            hasMore: true,
            nextOffset: 2,
            contentBudget: 32768,
            // The allowance, spent to the byte (`a` and `b` are one escaped byte each).
            bytes: allowance,
            truncated: true,
            indices: [0, 1]
        });

        expect(result.messages[0]).toEqual({
            index: 0,
            role: 'user',
            content: 'a'.repeat(20_000),
            contentLength: 20_000,
            contentOffset: 0,
            contentHasMore: false
        });
        expect(result.messages[1]).toEqual({
            index: 1,
            role: 'user',
            content: secondText,
            contentLength: 20_000,
            contentOffset: 0,
            contentHasMore: true,
            nextContentOffset: secondText.length
        });
    });

    it('delivers an escaping-heavy page at its ceiling instead of being refused', () => {
        // F8's regression. The old account charged UTF-8 TEXT bytes and reserved nothing for
        // the envelope, so a page of escaping-heavy text reached the wire LARGER than the
        // budget it had already "spent", and `boundToolResult` refused the WHOLE result — the
        // model received the envelope's truncation stub instead of this structured page.
        // A quote and a backslash are two escaped bytes each, so this fixture costs exactly
        // four escaped bytes per two characters: the cut is the budget's, and the arithmetic
        // below is exact rather than approximate.
        const unit = '"\\';
        const content = unit.repeat(15_000);

        // The per-character charge, measured with the cap's own measure instead of asserted:
        // a quote costs FOUR payload bytes, because the document escapes it as `\"` and the
        // payload escapes THAT again. `wire('')` = 2 is the fixed cost of the value's framing
        // quotes, which the message shell prices once.
        const charCharge = wire('"') - wire('');
        const room = threadReadPageAllowance(PLAIN_RECORD) - SHELLS.message;
        // The cut is greedy by CODE UNIT (a slice must never split a surrogate pair), so the
        // ceiling is the largest whole number of characters the room affords — here that
        // lands mid-unit, which is exactly what "the budget cut it, not the fixture" proves.
        const expectedText = content.slice(0, Math.floor((room - wire('')) / charCharge));

        const messages: HarnessMessage[] = [
            { role: 'user', content },
            { role: 'assistant', content }
        ];

        const result = readThreadTranscript(PLAIN_RECORD, messages, { limit: 10, contentLimit: 32_000 });

        expect(result.messages[0].content).toBe(expectedText);
        expect(result.messages.length).toBe(1);
        expect(result.messages[0].contentHasMore).toBe(true);
        expect(result.truncated).toBe(true);
        expect(result.hasMore).toBe(true);
        expect(result.bytes).toBe(SHELLS.message + wire(expectedText));
        // "At its ceiling" stated exactly: what the allowance leaves unspent is the arithmetic
        // remainder of the room after the last whole character, so no larger page was
        // deliverable in this currency (and it is smaller than one character's charge).
        expect(threadReadPageAllowance(PLAIN_RECORD) - result.bytes).toBe(room - wire(expectedText));

        // And the fact the whole budget exists to guarantee: the serialized result fits the
        // cap the harness enforces, so it is DELIVERED — not refused, not re-cut.
        const bounded = boundToolResult(JSON.stringify(result), MODEL_TOOL_RESULT_BUDGET_BYTES, {
            source: { name: 'threadRead' }
        });

        expect(bounded.rejected).toBeUndefined();
        expect(bounded.truncated).toBe(false);
        expect(JSON.parse(bounded.content)).toEqual(result);
    });

    it('refuses a thread whose own identity block leaves no room for a receipt', () => {
        // The one case the allowance cannot page around: the identity block is not text the
        // reader can cut, so when it eats the budget the call says so instead of answering
        // with an empty page that reads like an empty thread.
        const huge: HarnessThreadRecord = { ...PLAIN_RECORD, label: 'L'.repeat(THREAD_READ_CONTENT_BUDGET_BYTES) };

        expect(() => readThreadTranscript(huge, MESSAGES, {})).toThrow(HarnessError);

        // The refusal names the three numbers the caller needs, and the overhead it measures
        // is the one the allowance arithmetic uses.
        const message = ((): string => {
            try {
                readThreadTranscript(huge, MESSAGES, {});
            } catch (error) {
                return (error as Error).message;
            }

            return '';
        })();

        expect(message).toContain(`cost ${threadReadResultOverhead(huge)} payload bytes`);
        expect(message).toContain(`leaving 0 of the ${THREAD_READ_CONTENT_BUDGET_BYTES}-byte delivery budget`);
        expect(threadReadPageAllowance(huge)).toBe(0);
    });
});

describe('readThreadTranscript — attachments', () => {
    it('reports descriptors and never the base64 bytes', () => {
        // `includeSystem: true` keeps the pinned message positions (1 is the user
        // message, 3 is the tool result) — the seed filter is pinned elsewhere.
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { includeSystem: true });
        const serialized = JSON.stringify(result);

        expect(result.messages[1].attachments).toEqual([ATTACHMENT]);
        // `data` is the base64 payload itself; neither the value nor the key may
        // reach a model-facing result.
        expect(serialized.includes('AAECAwQ=')).toBe(false);
        expect(serialized.includes('"data"')).toBe(false);
        expect(serialized.includes('Image 1')).toBe(false);
    });

    it('omits the attachments key for a message that has none', () => {
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { includeSystem: true });

        expect('attachments' in result.messages[0]).toBe(false);
        expect('attachments' in result.messages[3]).toBe(false);
    });
});

describe('readThreadTranscript — errors', () => {
    it('reports a malformed pattern as its own clear error', () => {
        let caught: unknown;

        try {
            readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '[' });
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(HarnessError);
        expect((caught as HarnessError).message).toContain(
            'threadRead "regex" is not a valid JavaScript regular expression:'
        );
        expect((caught as HarnessError).message).toContain('Unterminated character class');
    });

    it('reports flags the engine rejects the same way', () => {
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'a', flags: 'z' })).toThrow(
            /threadRead "regex" is not a valid JavaScript regular expression: Invalid flags/
        );
    });

    it('refuses an empty pattern instead of matching everything', () => {
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '' })).toThrow(
            'threadRead "regex" must not be empty.'
        );
    });

    it('validates every argument it receives', () => {
        // The schema gates a harness call, but the helper is callable directly.
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { role: 'agent' })).toThrow(
            'threadRead "role" must be one of "system", "user", "assistant", "tool"; received "agent".'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { limit: 0 })).toThrow(
            'threadRead "limit" must be an integer between 1 and 100; received 0.'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { limit: 101 })).toThrow(
            'threadRead "limit" must be an integer between 1 and 100; received 101.'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { contentLimit: 40_000 })).toThrow(
            'threadRead "contentLimit" must be an integer between 1 and 32000; received 40000.'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { offset: 1.5 })).toThrow(
            'threadRead "offset" must be an integer between 0 and 9007199254740991; received 1.5.'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { includeReasoning: 'yes' })).toThrow(
            'threadRead "includeReasoning" must be a boolean.'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { includeSystem: 'yes' })).toThrow(
            'threadRead "includeSystem" must be a boolean.'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 'x' })).toThrow(
            'threadRead "message" must be an integer between 0 and 9007199254740991; received "x".'
        );
    });

    it('refuses a display mode or field selection it does not implement', () => {
        // Same posture as `role`: the entry's schema gates a harness call, but the
        // helper is callable directly, and an unknown value must never be coerced.
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { toolArgs: 'brief' })).toThrow(
            'threadRead "toolArgs" must be one of "full", "reference"; received "brief".'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { regexFields: 'content' })).toThrow(
            'threadRead "regexFields" must be an array of "content", "reasoning", "toolArguments", "toolName"; received "content".'
        );
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { regexFields: ['author'] })).toThrow(
            'threadRead "regexFields" must name one of "content", "reasoning", "toolArguments", "toolName"; received "author".'
        );

        // An empty selection is refused rather than silently meaning "search nothing":
        // with no fields the matcher is skipped entirely, so a caller that also handed
        // over a malformed pattern would get `matched: 0` instead of its error.
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { regexFields: [] })).toThrow(
            'threadRead "regexFields" must name at least one field.'
        );

        // The selection is validated even when no `regex` was given, because every
        // argument a caller actually sent is checked on every path.
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { regexFields: ['nope'] })).toThrow(
            'threadRead "regexFields" must name one of "content", "reasoning", "toolArguments", "toolName"; received "nope".'
        );

        // Duplicates are a caller inefficiency, not an error, and they cannot reorder
        // the canonical hit list.
        expect(
            indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'TODO', regexFields: ['content', 'content'] }))
        ).toEqual([3, 4]);
    });

    it('stops a catastrophic pattern at its matching budget', () => {
        // The classic exponential case: `(a+)+$` against 31 'a' then a 'b'. The
        // budget is INJECTED, so this proves the bound without waiting 30s.
        const messages: HarnessMessage[] = [{ role: 'user', content: `${'a'.repeat(31)}b` }];

        expect(() =>
            readThreadTranscript(PLAIN_RECORD, messages, { regex: '(a+)+$' }, { matchBudgetMs: 150 })
        ).toThrow(threadReadMatchBudgetError(150));
    });

    it('does not let a stopped pattern poison the next read', () => {
        const evil: HarnessMessage[] = [{ role: 'user', content: `${'a'.repeat(31)}b` }];
        const failure = threadReadMatchBudgetError(100);

        expect(() =>
            readThreadTranscript(PLAIN_RECORD, evil, { regex: '(a+)+$' }, { matchBudgetMs: 100 })
        ).toThrow(failure);

        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'TODO' }))).toEqual([2, 3, 4]);
    });

    it('publishes the budget error text a caller reads', () => {
        expect(threadReadMatchBudgetError(150).message).toBe(
            'threadRead "regex" did not finish within its 150ms matching budget and was stopped. Simplify the pattern: nested quantifiers such as "(a+)+" can backtrack exponentially.'
        );
    });
});
