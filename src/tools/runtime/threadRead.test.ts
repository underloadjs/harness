// tools/runtime/threadRead.test.ts — the pure transcript reader behind `threadRead`.
//
// What is pinned here (the helper's whole contract; the harness side lives in
// src/harness.thread-read.test.ts):
//   - the published bounds, so the entry's JSON schema and this module cannot
//     drift apart;
//   - pattern parsing: bare source + `flags`, `/pattern/flags`, and the documented
//     rule that a delimited pattern's flags win;
//   - regex SCOPE: content, assistant reasoning, tool-call name/arguments and a
//     tool message's name — with each FIELD tested separately, so a pattern cannot
//     match across a field seam by accident;
//   - filtering + pagination semantics: `matched` is the filtered count,
//     `offset`/`limit` page the filtered list, `nextOffset` continues it;
//   - text paging: `contentOffset`/`contentLimit` with `contentHasMore` and
//     `nextContentOffset`, never splitting a surrogate pair;
//   - the 32 KiB page budget: which message got cut, `truncated`, and how the
//     caller continues;
//   - attachments as DESCRIPTORS only (no base64 anywhere in the result);
//   - honest errors: malformed pattern, bad flags, out-of-range `message`, and a
//     pattern stopped by its matching budget (node:vm deadline, same technique as
//     tools/files/bounded-regex.ts).
//
// Deterministic throughout: every assertion is an exact value or an exact object,
// never a range or a smoke test. The budget is proven with an INJECTED short
// deadline rather than by waiting out the 30s default (vitest gives 15s).

import { describe, expect, it } from 'vitest';
import { HarnessError } from '../../util';
import type { HarnessMessage, HarnessThreadRecord } from '../../types';
import {
    MAX_THREAD_MATCH_MILLIS,
    parseThreadPattern,
    readThreadTranscript,
    THREAD_READ_CONTENT_BUDGET_BYTES,
    THREAD_READ_DEFAULT_CONTENT_LIMIT,
    THREAD_READ_DEFAULT_LIMIT,
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
    it('returns the whole transcript with defaults, every field exact', () => {
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
            matched: 5,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            // 16 + 21 + 11 + 20 + 22 characters of content, plus the 20-character
            // tool-call arguments string. Attachments are not text, so they cost 0.
            bytes: 110,
            truncated: false,
            messages: [
                {
                    index: 0,
                    role: 'system',
                    content: 'You are careful.',
                    contentLength: 16,
                    contentOffset: 0,
                    contentHasMore: false
                },
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
                    toolCalls: [TOOL_CALL]
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
        // charge it against the byte budget either.
        const [message] = readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).messages;

        expect('reasoning' in message).toBe(false);
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 2 }).bytes).toBe(31);
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
            toolCalls: [TOOL_CALL],
            reasoning: 'The TODO list matters.'
        });

        // `contentLimit` caps reasoning the same way it caps content: separate
        // truncation flags, and the full length for the caller to page from.
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
            toolCalls: [
                {
                    id: 'c1',
                    name: 'read',
                    arguments: '{"path":"r',
                    argumentsTruncated: true,
                    argumentsLength: 20
                }
            ],
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
});

describe('readThreadTranscript — regex filtering', () => {
    it('matches message content', () => {
        expect(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'careful' })).toMatchObject({
            matched: 1,
            total: 5
        });
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'careful' }))).toEqual([0]);
    });

    it('matches assistant reasoning, which the page itself does not return', () => {
        // Only message 2's REASONING mentions TODO in a way the content does not, so
        // this proves reasoning is searchable while still being opt-in for output.
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'list matters' }))).toEqual([2]);
    });

    it('matches tool-call names and raw arguments', () => {
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '/report/' }))).toEqual([1, 2]);
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: 'report\\.md' }))).toEqual([2]);
    });

    it('matches a tool message by the tool it answers', () => {
        // `^read$` only hits when the tool NAME is its own searchable field: the
        // message content here never equals "read" on its own.
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { regex: '^read$' }))).toEqual([2, 3]);
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
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, { role: 'system' }))).toEqual([0]);
    });

    it('returns every message when nothing filters', () => {
        expect(indicesOf(readThreadTranscript(PLAIN_RECORD, MESSAGES, {}))).toEqual([0, 1, 2, 3, 4]);
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

        expect({ total: result.total, matched: result.matched, offset: result.offset, messages: result.messages }).toEqual({
            total: 5,
            matched: 5,
            offset: 5,
            messages: []
        });
        expect(result.hasMore).toBe(false);
        expect('nextOffset' in result).toBe(false);
    });
});

describe('readThreadTranscript — text paging', () => {
    it('cuts each message at contentLimit and reports where to continue', () => {
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, { contentLimit: 9, limit: 2 });

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
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, {});
        const serialized = JSON.stringify(result);

        expect(result.messages[1].attachments).toEqual([ATTACHMENT]);
        // `data` is the base64 payload itself; neither the value nor the key may
        // reach a model-facing result.
        expect(serialized.includes('AAECAwQ=')).toBe(false);
        expect(serialized.includes('"data"')).toBe(false);
        expect(serialized.includes('Image 1')).toBe(false);
    });

    it('omits the attachments key for a message that has none', () => {
        const result = readThreadTranscript(PLAIN_RECORD, MESSAGES, {});

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
        expect(() => readThreadTranscript(PLAIN_RECORD, MESSAGES, { message: 'x' })).toThrow(
            'threadRead "message" must be an integer between 0 and 9007199254740991; received "x".'
        );
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
