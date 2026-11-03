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

        // Descending `order` inside the 'threads' group (270/265/260), so a model
        // always sees the id source before the tools that address an id.
        writer.createThread('writer');
        await writer('read my thread');

        expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual([
            'toolRequest',
            'task',
            'threadList',
            'threadRead',
            'threadSend'
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
            // tool sees itself in the transcript it reads — and its `arguments`
            // contains the pattern, so that message matches the filter too.
            total: 4,
            matched: 2,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            // 10 characters of the seed message, plus the 22-character raw arguments
            // string of the threadRead call itself.
            bytes: 32,
            truncated: false,
            messages: [
                {
                    index: 0,
                    role: 'user',
                    content: 'start here',
                    contentLength: 10,
                    contentOffset: 0,
                    contentHasMore: false
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
                            arguments: '{"regex":"start here"}'
                        }
                    ]
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
            total: 4,
            matched: 4,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            // 15 + 30 + 22 + 20 content characters plus the 20-character tool-call
            // arguments string. Reasoning is opt-in, so it costs nothing here.
            bytes: 107,
            truncated: false,
            messages: [
                {
                    index: 0,
                    role: 'system',
                    content: 'You keep notes.',
                    contentLength: 15,
                    contentOffset: 0,
                    contentHasMore: false
                },
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
                    toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"report.md"}' }]
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

        // 15 + 30 + 22 + 20 content characters + 20 characters of tool-call
        // arguments = 107. `bytes` counts UTF-8 BYTES of the text the page returns,
        // which is the same unit the harness 64 KiB result cap measures.
        expect(page.bytes).toBe(107);
    });

    it('reports attachment descriptors and never the base64 payload', async () => {
        const { writer, target } = fixture();
        const page = pageOf(await writer.executeTool('threadRead', { thread: target.id }));
        const serialized = JSON.stringify(page);

        expect(page.messages[1].attachments).toEqual([ATTACHMENT_VIEW]);
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
                    toolCallId: 't1'
                }
            ]
        });

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
                    toolCalls: [{ id: 't1', name: 'read', arguments: '{"path":"report.md"}' }],
                    reasoning: 'The TODO list is the answer.'
                }
            ]
        });
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
            matched: 2,
            indices: [
                [0, 'system'],
                [1, 'user']
            ]
        });
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
        expect(pageOf(await writer.executeTool('threadRead', { thread: target.id })).matched).toBe(4);
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
