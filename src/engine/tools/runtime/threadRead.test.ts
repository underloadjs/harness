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
    threadReadMatchBudgetError
} from './threadRead';

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
        // Half the harness result cap (core/result-budget.ts, 64 KiB), which is the
        // whole point of the smaller number.
        expect(THREAD_READ_CONTENT_BUDGET_BYTES).toBe(65_536 / 2);
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
            // 21 + 11 + 20 + 22 characters of content. The system seed costs nothing
            // (it is not returned) and the tool-call arguments cost nothing either
            // (reference mode quotes no text); attachments are not text, so 0 too.
            bytes: 74,
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

        // I2 is literally a byte fix: the seed was charged to EVERY page. 74 → 90 is
        // its 16 characters, and `matched` (the filtered count) gains it as well,
        // while `total` stays 5 either way.
        expect({ without: without.bytes, withSeed: withSeed.bytes }).toEqual({
            without: 74,
            withSeed: 90
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
        // charge it against the byte budget either. The 11 bytes are its content alone
        // — the reference tool-call row quotes no text, so it costs nothing either.
        const [message] = readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).messages;

        expect('reasoning' in message).toBe(false);
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).bytes).toBe(11);
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
            bytes: 20,
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
            bytes: 5,
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
            bytes: 10
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
    it('shows a reference by default, costing no bytes', () => {
        const [message] = readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).messages;

        // { id, name, argumentsLength } and nothing else: the payload is named and
        // sized, never quoted.
        expect(message.toolCalls).toEqual([TOOL_CALL_REF]);
        expect('arguments' in message.toolCalls![0]).toBe(false);
        // No truncation flag either — nothing was CUT, the text was omitted by policy,
        // and the absent `arguments` key is what says so.
        expect('argumentsTruncated' in message.toolCalls![0]).toBe(false);
        // 11 bytes: the content alone. This is the page that used to cost 31.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).bytes).toBe(11);
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

        // 10 content + 20 arguments = 30, against the 11 the reference costs.
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2, toolArgs: 'full' }).bytes).toBe(31);
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
            // 20000 + 10: the payload contributes nothing.
            bytes: 20_010,
            truncated: false,
            hasMore: false,
            indices: [0, 1]
        });

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
            // The budget is exactly full: 20000 content + 12768 arguments.
            bytes: 32_768,
            truncated: true,
            // The second message is gone, whole — which is what `hasMore` is for.
            hasMore: true,
            nextOffset: 1,
            indices: [0],
            argumentsRow: [
                {
                    id: 'c1',
                    name: 'write',
                    arguments: 'p'.repeat(12_768),
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
        expect(result.bytes).toBe(18);

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
        expect(result.bytes).toBe(4);
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
            bytes: 32768,
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
            content: 'b'.repeat(12_768),
            contentLength: 20_000,
            contentOffset: 0,
            contentHasMore: true,
            nextContentOffset: 12_768
        });
    });

    it('keeps the serialized page under the harness 64 KiB result cap', () => {
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'x'.repeat(30_000) },
            { role: 'assistant', content: 'y'.repeat(30_000) }
        ];

        const result = readThreadTranscript(PLAIN_RECORD, messages, { limit: 10, contentLimit: 32_000 });
        const serialized = new TextEncoder().encode(JSON.stringify(result)).length;

        // The whole point of the 32 KiB internal budget: the harness cap never
        // replaces this structured result with its truncation envelope.
        expect(serialized).toBeLessThan(65_536);
        expect(result.truncated).toBe(true);
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
