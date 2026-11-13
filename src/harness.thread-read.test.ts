// threadRead through the REAL harness: registration, availability to every agent,
// runtime-supplied thread identity, and transcript reading of live conversations.
//
// This file imports only `@underload/harness` (no source internals, no mocks of the
// harness) so everything below is what a model and a host actually observe:
//
//   R1  `threadRead` is discovered from its own entry and registered with the rest
//       of the 'threads' trio on the FIRST thread â€” a harness with one conversation
//       per agent still never pays for it, and no configuration can turn it off.
//   R1  It is `visibility: 'core'` and it is DECLARED to every agent in the session,
//       including an agent that is not the primary, so availability never depends on
//       who created the thread.
//   R2  The default `agent:<name>` conversation and an independent host thread are
//       both readable; the calling run's own thread comes from the runtime, so a
//       model that passes no `thread` reads the conversation it is in.
//   R3  Attachment bytes never reach the result, and the 64 KiB model-facing result
//       cap is never what truncates a page â€” the tool's own budget reports the cut.
//   R4  An unknown or deleted thread id and a malformed pattern come back as honest
//       errors, and a manual host call has no thread to default to.
//   R5  The DEFAULT page is the cheap one, and every part of that is visible through
//       the real tool and the real schema: no system seed (`includeSystem`, opt-in),
//       tool calls as { id, name, argumentsLength } REFERENCES rather than quoted
//       payloads (`toolArgs: "full"` opts in), and a `matchedFields` report on every
//       regex hit — including a hit in a field the page does not display, which is how
//       a model can tell a real finding from its own tool-call arguments echoing the
//       pattern back at it.
//
// Clock policy: no fake timers; every transport is scripted, so every assertion is
// an exact value.

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type {
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// Replay scripted frames, one list per request; the last list repeats.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

const brain = (stream: HarnessStream): ReturnType<typeof agent> =>
    agent({ model: 'merge/ds4-flash', stream });

// The tool result, as the model receives it (JSON text on the wire).
type Page = {
    thread: {
        id: string;
        agent: string;
        origin: string;
        status: string;
        sequence: number;
        ownerThreadId?: string;
        label?: string;
    };
    total: number;
    matched: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset?: number;
    contentBudget: number;
    bytes: number;
    truncated: boolean;
    messages: Record<string, any>[];
};

// The tool result as an object. `harness.executeTool` hands back the tool's own
// value, while a transcript tool message carries its JSON text, so both shapes are
// accepted here rather than at every call site.
const pageOf = (value: unknown): Page =>
    typeof value === 'string' ? (JSON.parse(value) as Page) : (value as Page);

// A transcript attachment the shared validator accepts: `data` must agree with the
// declared MIME and with `size` (src/shared/attachments.ts), which is what
// `setThreadMessages` enforces before the tool can ever read it.
const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const PNG_DATA = base64(PNG_BYTES);

const ATTACHMENT_ROW = {
    id: 'a1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    size: PNG_BYTES.length,
    data: PNG_DATA
};

// The same row as `threadRead` must report it: descriptors only.
const ATTACHMENT_VIEW = {
    id: 'a1',
    kind: 'image',
    name: 'pixel.png',
    mime: 'image/png',
    size: 12
};

// The committed content of one message, for reading a tool result out of a
// transcript after a scripted turn.
const toolResultOf = (messages: HarnessMessage[], name: string): string => {
    const entry = messages.find(
        (message) => message.role === 'tool' && (message as { name?: string }).name === name
    ) as { content: string } | undefined;

    expect(entry).toBeDefined();
    return entry!.content;
};

describe('threadRead registration (R1)', () => {
    it('appears only after the session owns a thread, and stays registered', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        // No thread yet: the whole conditional trio is absent, so an ordinary
        // single-conversation session pays no context for it.
        expect(writer.tools.threadRead).toBeUndefined();
        expect(writer.tools.threadList).toBeUndefined();

        const thread = writer.createThread('writer');

        expect(writer.tools.threadRead).toBeDefined();
        expect(writer.tools.threadRead.name).toBe('threadRead');
        expect(writer.tools.threadRead.visibility).toBe('core');

        // Deleting the thread does not unregister the tool: it is catalogue state,
        // exactly like threadSend/threadList.
        writer.deleteThread(thread.id);
        expect(writer.tools.threadRead).toBeDefined();
    });

    it('declares the roster, the reader, and the sender in that order', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')], seen)) },
            presets: false
        });

        // Descending `order` inside the 'threads' group (270/265/260/255), so a model
        // always sees the id source before the tools that address an id — and the
        // release door (threadDelete, 255) last, because it is meaningless before the
        // roster has been read.
        writer.createThread('writer');
        await writer('read my thread');

        expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual([
            'toolRequest',
            'tasks',
            'threadList',
            'threadRead',
            'threadSend',
            'threadDelete'
        ]);
    });

    it('is available to an agent that is not the primary and did not create the thread', async () => {
        const leadSeen: HarnessStreamRequest[] = [];
        const workerSeen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: {
                lead: brain(scripted([answer('lead done')], leadSeen)),
                worker: brain(scripted([answer('worker done')], workerSeen))
            },
            presets: false
        });

        // The PRIMARY opens the thread; the worker merely owns a conversation.
        const workerThread = writer.createThread('worker');
        await writer.sendThreadInput(workerThread.id, 'read your own thread');

        expect(workerSeen).toHaveLength(1);
        expect(workerSeen[0]!.tools?.map((tool) => tool.name)).toContain('threadRead');

        // The lead never created or ran a thread of its own, and still has it.
        await writer('anything');
        expect(leadSeen[0]!.tools?.map((tool) => tool.name)).toContain('threadRead');
    });
});

describe('threadRead through a model tool call (R2)', () => {
    it('reads the calling run\'s own thread when the model passes no id', async () => {
        const seen: HarnessStreamRequest[] = [];
        let requests = 0;
        const stream: HarnessStream = async function* (request) {
            seen.push(request);
            requests += 1;

            if (requests === 1) {
                // No `thread`: the runtime supplies the calling conversation.
                for (const frame of callTool('c1', 'threadRead', JSON.stringify({ regex: 'start here' }))) {
                    yield frame;
                }
                return;
            }

            yield* answer('read it back');
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');

        writer.setThreadMessages(thread.id, [
            { role: 'user', content: 'start here' },
            { role: 'assistant', content: 'noted' }
        ]);

        const result = await writer.sendThreadInput(thread.id, 'look back');

        expect(result.content).toBe('read it back');

        // The result is the LIVE record of this run's conversation: a host thread,
        // owned by this agent, and 'running' because the read happened mid-run.
        expect(pageOf(toolResultOf(writer.threadMessages(thread.id), 'threadRead'))).toEqual({
            thread: {
                id: thread.id,
                agent: 'writer',
                origin: 'host',
                status: 'running',
                sequence: thread.sequence
            },
            // [user seed, assistant seed, user turn, assistant tool-call turn]. The
            // assistant turn carrying this very call is already committed, so the
            // tool sees itself in the transcript it reads — and its raw `arguments`
            // contains the pattern, so that message matches the filter too. `matchedFields`
            // is what makes that SELF-MATCH readable: the row shows no arguments text
            // at all (reference mode is the default), and the hit list says plainly that
            // the match lives in `toolArguments`, not in anything the model can see.
            total: 4,
            matched: 2,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            // 10 characters of the seed message. The 22-character raw arguments string of
            // the threadRead call itself is SEARCHED but not returned, so it costs nothing.
            bytes: 10,
            truncated: false,
            messages: [
                {
                    index: 0,
                    role: 'user',
                    content: 'start here',
                    contentLength: 10,
                    contentOffset: 0,
                    contentHasMore: false,
                    matchedFields: ['content']
                },
                {
                    index: 3,
                    role: 'assistant',
                    content: '',
                    contentLength: 0,
                    contentOffset: 0,
                    contentHasMore: false,
                    toolCalls: [
                        {
                            id: 'c1',
                            name: 'threadRead',
                            argumentsLength: 22
                        }
                    ],
                    matchedFields: ['toolArguments']
                }
            ]
        });
    });

    it('turns a malformed pattern into a tool result the model can act on', async () => {
        let requests = 0;
        const stream: HarnessStream = async function* () {
            requests += 1;

            if (requests === 1) {
                for (const frame of callTool('c1', 'threadRead', JSON.stringify({ regex: '[' }))) {
                    yield frame;
                }
                return;
            }

            yield* answer('fixed it');
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const thread = writer.createThread('writer');

        writer.setThreadMessages(thread.id, [{ role: 'user', content: 'anything' }]);
        expect((await writer.sendThreadInput(thread.id, 'read')).content).toBe('fixed it');

        expect(toolResultOf(writer.threadMessages(thread.id), 'threadRead')).toContain(
            'threadRead "regex" is not a valid JavaScript regular expression:'
        );
    });
});

describe('threadRead as a host-callable tool (R2/R3/R4)', () => {
    // One harness with a primary and a second configured agent, plus an
    // independent thread of the second agent, seeded with a full transcript.
    const fixture = () => {
        const writer = harness({
            agents: {
                lead: brain(scripted([answer('lead')])),
                worker: brain(scripted([answer('worker')]))
            },
            presets: false
        });

        const target = writer.createThread('worker', { label: 'Notes' });

        writer.setThreadMessages(target.id, [
            { role: 'system', content: 'You keep notes.' },
            {
                role: 'user',
                content: 'Summarise the report [Image 1]',
                attachments: [ATTACHMENT_ROW]
            },
            {
                role: 'assistant',
                content: 'Two TODO items remain.',
                reasoning: 'The TODO list is the answer.',
                toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"report.md"}' }]
            },
            { role: 'tool', content: 'TODO: two open items', toolCallId: 't1', name: 'read' }
        ]);

        // A thread exists, so the trio is registered for this session.
        expect(writer.tools.threadRead).toBeDefined();

        return { writer, target };
    };

    it('reads a complete transcript page in transcript order', async () => {
        const { writer, target } = fixture();
        const page = pageOf(await writer.executeTool('threadRead', { thread: target.id }));

        expect(page).toEqual({
            thread: {
                id: target.id,
                agent: 'worker',
                origin: 'host',
                status: 'idle',
                sequence: target.sequence,
                label: 'Notes'
            },
            // `total` still counts all four committed messages, but the system seed is
            // off by default, so the PAGE starts at index 1 and `matched` is 3. Index
            // numbering is untouched: index 2 is the assistant turn either way.
            total: 4,
            matched: 3,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            // 30 + 22 + 20 content characters. The seed costs nothing (not returned)
            // and the tool-call arguments cost nothing (reference mode quotes no text).
            bytes: 72,
            truncated: false,
            messages: [
                {
                    index: 1,
                    role: 'user',
                    content: 'Summarise the report [Image 1]',
                    contentLength: 30,
                    contentOffset: 0,
                    contentHasMore: false,
                    attachments: [ATTACHMENT_VIEW]
                },
                {
                    index: 2,
                    role: 'assistant',
                    content: 'Two TODO items remain.',
                    contentLength: 22,
                    contentOffset: 0,
                    contentHasMore: false,
                    // A reference, not a quotation: the payload is named by length.
                    toolCalls: [{ id: 't1', name: 'read', argumentsLength: 20 }]
                },
                {
                    index: 3,
                    role: 'tool',
                    content: 'TODO: two open items',
                    contentLength: 20,
                    contentOffset: 0,
                    contentHasMore: false,
                    name: 'read',
                    toolCallId: 't1'
                }
            ]
        });

        // 30 + 22 + 20 content characters = 72. `bytes` counts UTF-8 BYTES of the text
        // the page returns, which is the same unit the harness 64 KiB result cap measures.
        expect(page.bytes).toBe(72);

        // The opt-in is a schema-accepted parameter, and it restores exactly what the
        // default withholds: index 0 on the page, `matched` 4, and the seed's own 15
        // bytes charged to the page (72 + 15).
        const seeded = pageOf(
            await writer.executeTool('threadRead', { thread: target.id, includeSystem: true })
        );

        expect({
            total: seeded.total,
            matched: seeded.matched,
            bytes: seeded.bytes,
            indices: seeded.messages.map((message) => message.index)
        }).toEqual({ total: 4, matched: 4, bytes: 87, indices: [0, 1, 2, 3] });
        expect(seeded.messages[0]).toEqual({
            index: 0,
            role: 'system',
            content: 'You keep notes.',
            contentLength: 15,
            contentOffset: 0,
            contentHasMore: false
        });

        // `toolArgs: "full"` is the other half of the same contract: the payload comes
        // back quoted, and the page pays 20 bytes for it.
        const quoted = pageOf(
            await writer.executeTool('threadRead', { thread: target.id, toolArgs: 'full' })
        );

        expect(quoted.messages[1].toolCalls).toEqual([
            { id: 't1', name: 'read', arguments: '{"path":"report.md"}' }
        ]);
        expect(quoted.bytes).toBe(92);
    });

    it('reports attachment descriptors and never the base64 payload', async () => {
        const { writer, target } = fixture();
        const page = pageOf(await writer.executeTool('threadRead', { thread: target.id }));
        const serialized = JSON.stringify(page);

        // Index 0, NOT 1: `includeSystem` defaults to false, so the seeded system
        // preamble is off the page and the user turn that carries the attachment is the
        // first row a caller reads. `index` still addresses the FULL transcript, which
        // is why that field stays 1.
        expect(page.messages[0].attachments).toEqual([ATTACHMENT_VIEW]);
        expect(page.messages[0].index).toBe(1);
        // `PNG_DATA` is the whole `data` value: one character of it in the result
        // would fail this. The marker stays inside `content`, where it already is.
        expect(serialized.includes(PNG_DATA)).toBe(false);
        expect(serialized.includes('"data"')).toBe(false);
        expect(serialized.includes('"marker"')).toBe(false);
    });

    it('filters with regex and role, and pages the filtered list', async () => {
        const { writer, target } = fixture();

        // 'TODO' hits the assistant reasoning of index 2 and the content of index 3.
        const first = pageOf(
            await writer.executeTool('threadRead', { thread: target.id, regex: 'TODO', limit: 1 })
        );

        expect({
            total: first.total,
            matched: first.matched,
            offset: first.offset,
            hasMore: first.hasMore,
            nextOffset: first.nextOffset,
            indices: first.messages.map((message) => message.index)
        }).toEqual({ total: 4, matched: 2, offset: 0, hasMore: true, nextOffset: 1, indices: [2] });

        const second = pageOf(
            await writer.executeTool('threadRead', {
                thread: target.id,
                regex: '/todo/i',
                limit: 1,
                offset: 1
            })
        );

        expect({
            matched: second.matched,
            offset: second.offset,
            hasMore: second.hasMore,
            messages: second.messages
        }).toEqual({
            matched: 2,
            offset: 1,
            hasMore: false,
            messages: [
                {
                    index: 3,
                    role: 'tool',
                    content: 'TODO: two open items',
                    contentLength: 20,
                    contentOffset: 0,
                    contentHasMore: false,
                    name: 'read',
                    toolCallId: 't1',
                    // The report of WHY this row is on the page: the other hit (index 2)
                    // came from reasoning this page never shows, and this one came from
                    // the visible content.
                    matchedFields: ['content']
                }
            ]
        });

        // `regexFields` narrows the SEARCH, and the harness schema accepts the array.
        // 'list is the answer' exists ONLY in index 2's reasoning, which the page never
        // displays (`includeReasoning` is false) — so the default search finds it and
        // says where, while a content-only search finds nothing at all.
        const hidden = pageOf(
            await writer.executeTool('threadRead', { thread: target.id, regex: 'list is the answer' })
        );

        expect({
            total: hidden.total,
            matched: hidden.matched,
            bytes: hidden.bytes,
            messages: hidden.messages
        }).toEqual({
            total: 4,
            matched: 1,
            bytes: 22,
            messages: [
                {
                    index: 2,
                    role: 'assistant',
                    content: 'Two TODO items remain.',
                    contentLength: 22,
                    contentOffset: 0,
                    contentHasMore: false,
                    toolCalls: [{ id: 't1', name: 'read', argumentsLength: 20 }],
                    matchedFields: ['reasoning']
                }
            ]
        });
        // The page carries no reasoning of its own, and never claimed to: the hit report
        // is what connects the row to the pattern.
        expect('reasoning' in hidden.messages[0]).toBe(false);

        const contentOnly = pageOf(
            await writer.executeTool('threadRead', {
                thread: target.id,
                regex: 'list is the answer',
                regexFields: ['content']
            })
        );

        expect({
            total: contentOnly.total,
            matched: contentOnly.matched,
            bytes: contentOnly.bytes,
            messages: contentOnly.messages
        }).toEqual({ total: 4, matched: 0, bytes: 0, messages: [] });

        // An invented field name dies in schema validation, before the tool runs.
        await expect(
            writer.executeTool('threadRead', { thread: target.id, regex: 'TODO', regexFields: ['thoughts'] })
        ).rejects.toThrow(/regexFields/);

        // A role filter is a whole-message cut, applied before the regex.
        const users = pageOf(
            await writer.executeTool('threadRead', { thread: target.id, role: 'user' })
        );

        expect({
            matched: users.matched,
            indices: users.messages.map((message) => message.index)
        }).toEqual({ matched: 1, indices: [1] });
    });

    it('reads one message by index, with reasoning only when asked', async () => {
        const { writer, target } = fixture();
        const page = pageOf(
            await writer.executeTool('threadRead', {
                thread: target.id,
                message: 2,
                includeReasoning: true
            })
        );

        expect({ total: page.total, matched: page.matched, offset: page.offset, messages: page.messages }).toEqual({
            total: 4,
            matched: 1,
            offset: 2,
            messages: [
                {
                    index: 2,
                    role: 'assistant',
                    content: 'Two TODO items remain.',
                    contentLength: 22,
                    contentOffset: 0,
                    contentHasMore: false,
                    // Even a single-message read shows a reference by default; the
                    // caller asks for the payload explicitly with `toolArgs: "full"`.
                    toolCalls: [{ id: 't1', name: 'read', argumentsLength: 20 }],
                    reasoning: 'The TODO list is the answer.'
                }
            ]
        });

        // ... and the payload itself is one parameter away, untruncated at the default
        // `contentLimit`, so a follow-up read costs one call and no paging.
        const quoted = pageOf(
            await writer.executeTool('threadRead', {
                thread: target.id,
                message: 2,
                toolArgs: 'full'
            })
        );

        expect(quoted.messages[0].toolCalls).toEqual([
            { id: 't1', name: 'read', arguments: '{"path":"report.md"}' }
        ]);
    });

    it('pages one long message without splitting a surrogate pair and stays under the result cap', async () => {
        const { writer, target } = fixture();

        // 40000 units: 39980 'n' characters, then 10 astral-plane glyphs (2 units
        // each, so the pairs occupy units 39980-39999).
        const emoji = '\u{1F600}'.repeat(10);
        const messages = writer.threadMessages(target.id);

        writer.setThreadMessages(target.id, [
            ...messages,
            { role: 'user', content: `${'n'.repeat(39_980)}${emoji}` }
        ]);

        const page = pageOf(
            await writer.executeTool('threadRead', {
                thread: target.id,
                message: 4,
                contentOffset: 39_981,
                contentLimit: 5
            })
        );

        // The requested offset lands on the LOW half of the first pair, so the window
        // starts one unit earlier; its 5-unit end would cut the second pair, so it
        // steps back too. The result is two whole glyphs and nothing split.
        expect(page.messages[0]).toEqual({
            index: 4,
            role: 'user',
            content: emoji.slice(0, 4),
            contentLength: 40_000,
            contentOffset: 39_980,
            contentHasMore: true,
            nextContentOffset: 39_984
        });

        // The full-message read (contentLimit at its 32000 maximum) is still a valid,
        // parseable result under the harness 64 KiB cap, with the cut reported rather
        // than silently applied.
        const full = pageOf(
            await writer.executeTool('threadRead', {
                thread: target.id,
                message: 4,
                contentLimit: 32_000
            })
        );
        const serializedBytes = new TextEncoder().encode(JSON.stringify(full)).length;

        expect(full.messages[0].content.length).toBe(32_000);
        expect(full.messages[0].contentHasMore).toBe(true);
        expect(full.messages[0].nextContentOffset).toBe(32_000);
        expect(full.truncated).toBe(false);
        expect(serializedBytes).toBeLessThan(65_536);
    });

    it('reads an agent default conversation by its agent:<name> id', async () => {
        const { writer } = fixture();

        writer.setThreadMessages('agent:lead', [
            { role: 'system', content: 'Lead instructions.' },
            { role: 'user', content: 'plan it' }
        ]);

        const page = pageOf(await writer.executeTool('threadRead', { thread: 'agent:lead' }));

        expect({
            thread: page.thread,
            total: page.total,
            matched: page.matched,
            indices: page.messages.map((message) => [message.index, message.role])
        }).toEqual({
            thread: {
                id: 'agent:lead',
                agent: 'lead',
                origin: 'agent',
                status: 'idle',
                sequence: 1
            },
            total: 2,
            // The agent default conversation opens with its system instructions, and
            // those are off by default now: `total` still reports both messages, the
            // page starts at the user turn. `includeSystem: true` puts the seed back.
            matched: 1,
            indices: [[1, 'user']]
        });

        expect(
            pageOf(
                await writer.executeTool('threadRead', { thread: 'agent:lead', includeSystem: true })
            ).messages.map((message) => [message.index, message.role])
        ).toEqual([
            [0, 'system'],
            [1, 'user']
        ]);
    });

    it('rejects an unknown thread and a deleted thread alike', async () => {
        const { writer, target } = fixture();

        await expect(
            writer.executeTool('threadRead', { thread: 'thread-99' })
        ).rejects.toThrow(
            'Thread "thread-99" is not available in this harness; it was never created, or it was deleted.'
        );

        writer.deleteThread(target.id);

        await expect(writer.executeTool('threadRead', { thread: target.id })).rejects.toThrow(
            `Thread "${target.id}" is not available in this harness; it was never created, or it was deleted.`
        );
    });

    it('has no honest default for a manual host call, and says so', async () => {
        const { writer, target } = fixture();

        // `executeTool` runs outside any run, so `context.threadId` is absent and a
        // missing `thread` cannot be guessed.
        await expect(writer.executeTool('threadRead', {})).rejects.toThrow(
            'threadRead needs a thread: pass "thread" (see threadList), or call it from inside a conversation.'
        );

        // An empty string is not an id either.
        await expect(writer.executeTool('threadRead', { thread: '   ' })).rejects.toThrow(
            'threadRead needs a thread: pass "thread" (see threadList), or call it from inside a conversation.'
        );

        // The same call WITH an id works, which is what makes the error actionable.
        // `matched` is 3, not 4: the seed is filtered out of the candidate list.
        expect(pageOf(await writer.executeTool('threadRead', { thread: target.id })).matched).toBe(3);
    });

    it('rejects arguments outside the schema before the tool runs', async () => {
        const { writer, target } = fixture();

        await expect(
            writer.executeTool('threadRead', { thread: target.id, limit: 0 })
        ).rejects.toThrow(/limit/);

        await expect(
            writer.executeTool('threadRead', { thread: target.id, message: -1 })
        ).rejects.toThrow(/message/);

        await expect(
            writer.executeTool('threadRead', { thread: target.id, nope: true })
        ).rejects.toThrow(/nope/);
    });
});

// ---------------------------------------------------------------------------
// B1 (2026-11-13) — A BRANCH ID IS A threadRead ADDRESS
// ---------------------------------------------------------------------------
//
// `threadFork` hands back `{ branchId, threadId, content }` where both ids are the same
// generated `branch-N`, so the transcript it produced has to stay readable through the
// ordinary reader after the branch settles. The fork suite pins that end-to-end from a
// LINEAGE caller; this pins the same door from the reader's own file, because the shape
// a caller sees here is the read tool's contract, not the fork's: a synthesized thread
// record (`origin: 'host'`, `status: 'idle'` once finished), the branch's committed
// transcript addressed by the branch id, and the same default page rules a live
// conversation gets — notably `toolArgs: "reference"`, so the fork call that created
// the branch arrives as `{ id, name, argumentsLength }` instead of a quoted payload.
describe('threadRead addresses a finished fork by its branch id (B1)', () => {
    it('reads the branch transcript through the same tool and the same defaults', async () => {
        // One transport, three requests, in this exact order: the origin asks for a
        // fork, the branch answers, the origin closes on the delivery. An async fork
        // parks its origin, so `scripted`'s request-index replay IS the schedule.
        const writer = harness({
            agents: {
                writer: brain(
                    scripted([
                        callTool('f1', 'threadFork', '{"input":"inspect the notes"}'),
                        answer('two TODOs remain'),
                        answer('forked')
                    ])
                )
            },
            presets: false
        });
        const origin = writer.createThread('writer', { label: 'Origin' });
        await writer.sendThreadInput(origin.id, 'start');

        // The ledger holds exactly one branch, and its id is the address the origin got.
        expect(writer.branches().map((record) => [record.branchId, record.status])).toEqual([
            ['branch-1', 'completed']
        ]);

        const page = pageOf(await writer.executeTool('threadRead', { thread: 'branch-1' }));

        // The thread half is the SYNTHESIZED record (there is no thread state behind a
        // branch): host origin, idle because the branch is finished, and the branch id
        // as both `id` and the handle a caller would page by.
        expect({
            id: page.thread.id,
            agent: page.thread.agent,
            origin: page.thread.origin,
            status: page.thread.status
        }).toEqual({ id: 'branch-1', agent: 'writer', origin: 'host', status: 'idle' });

        // The branch's committed transcript, through the DEFAULT page. What that page is
        // made of: the fork call the branch was created from (as a `threadFork`
        // REFERENCE with `argumentsLength`, never the quoted argument payload), the
        // pending tool row the origin left behind, the branch's own input, and its
        // answer last. `total` counts the same transcript the page returns, because a
        // host thread of a `presets: false` agent carries no system row to hide — so the
        // indices here run 0..4 and `includeSystem` has nothing to filter. The point of
        // the assertion is that a branch page is addressed and shaped like any live
        // conversation's, not that it is empty.
        expect({
            total: page.total,
            roles: page.messages.map((message) => message.role),
            indices: page.messages.map((message) => message.index),
            toolCalls: page.messages.map((message) => message.toolCalls),
            last: page.messages[page.messages.length - 1]
        }).toEqual({
            total: 5,
            roles: ['user', 'assistant', 'tool', 'user', 'assistant'],
            indices: [0, 1, 2, 3, 4],
            toolCalls: [
                undefined,
                [{ id: 'call_branch-1_1', name: 'threadFork', argumentsLength: 29 }],
                undefined,
                undefined,
                undefined
            ],
            last: {
                index: 4,
                role: 'assistant',
                content: 'two TODOs remain',
                contentLength: 16,
                contentOffset: 0,
                contentHasMore: false
            }
        });
    });
});
