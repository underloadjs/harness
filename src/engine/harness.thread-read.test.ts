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
//       including an agent that is not the entry agent, so availability never depends on
//       who created the thread.
//   R2  The default `agent:<name>` conversation and an independent host thread are
//       both readable; the calling run's own thread comes from the runtime, so a
//       model that passes no `thread` reads the conversation it is in.
//   R3  Attachment BYTES never reach the result — only their descriptors, which ARE
//       charged — and the reader's own 32 KiB budget is spent in the same escaped
//       payload currency as the model-facing result cap (F8), so the result cap is
//       never what truncates a page — the tool's own budget reports the cut.
//   R4  An unknown thread id and a malformed pattern come back as honest errors, a manual
//       host call has no thread to default to, and a SOFT-DELETED thread is not an error for
//       the doors a soft delete keeps: the host view and the releasing lineage read it through
//       this tool, byte-identical to the live page (R1, 2026-11-27 — see the released-thread
//       block below).
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
import { agent, harness } from './index';
// F8: the byte pins in this suite are derived with the cap's own payload measure and the
// reader's exported receipt shells, so a change to either moves the pins and the contract
// together.
import { modelPayloadBytes } from './core/payload-bytes';
import { THREAD_READ_WIRE_SHELLS } from './tools/runtime/threadRead';
import type {
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';

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

// F8 — the page's `bytes` is charged in the harness DELIVERY currency: escaped payload
// bytes (core/payload-bytes.ts), with every receipt paying its measured shell
// (`THREAD_READ_WIRE_SHELLS`, the same constants the reader charges with). Rather than
// freeze a hand-typed total per fixture, these integration pins RECOMPUTE the charge from
// the rows the live page actually returned — an independent recomputation of the tool's own
// accounting, not a restatement of it. The byte-for-byte values of those shells are pinned
// against fixed fixtures in tools/runtime/threadRead.test.ts; what this suite proves is that
// a page produced through the real harness obeys the same arithmetic.
const wire = (value: string): number => modelPayloadBytes(JSON.stringify(value)) - 2;
const SHELLS = THREAD_READ_WIRE_SHELLS;

const receiptCharge = (message: Record<string, any>): number => {
    let bytes = SHELLS.message + wire(String(message.content ?? ''));

    // A `regex` page prices the widest `matchedFields` list on every row it returns; the key
    // is present exactly when the regex ran (threadRead.ts, shell pass).
    if (message.matchedFields !== undefined) bytes += SHELLS.matchFields;
    if (typeof message.reasoning === 'string') bytes += SHELLS.reasoning + wire(message.reasoning);

    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        bytes += message.attachments.reduce(
            (total: number, item: Record<string, any>) =>
                total +
                SHELLS.attachmentItem +
                wire(item.id) +
                wire(item.kind) +
                wire(item.name) +
                wire(item.mime),
            SHELLS.attachments
        );
    }

    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
        bytes += message.toolCalls.reduce((total: number, call: Record<string, any>) => {
            // A call that DISPLAYS its `arguments` pays the wider shell and the text;
            // `reference` mode pays the smaller shell and no text (F8 — a reference is
            // cheaper, it is not free).
            const shell =
                typeof call.arguments === 'string' ? SHELLS.toolCallFull : SHELLS.toolCallReference;

            let item = shell + wire(call.id) + wire(call.name);

            if (typeof call.arguments === 'string') item += wire(call.arguments);

            return total + item;
        }, SHELLS.toolCalls);
    }

    if (message.role === 'tool') {
        bytes += SHELLS.toolIdentity + wire(String(message.name ?? '')) + wire(String(message.toolCallId ?? ''));
    }

    return bytes;
};

const chargeOfRows = (rows: Record<string, any>[]): number =>
    rows.reduce((total, message) => total + receiptCharge(message), 0);

const chargeOf = (page: Page): number => chargeOfRows(page.messages);

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

    it('is available to an agent that is not the entry agent and did not create the thread', async () => {
        const leadSeen: HarnessStreamRequest[] = [];
        const workerSeen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: {
                lead: brain(scripted([answer('lead done')], leadSeen)),
                worker: brain(scripted([answer('worker done')], workerSeen))
            },
            presets: false
        });

        // The ENTRY AGENT opens the thread; the worker merely owns a conversation.
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
        const toolPage = pageOf(toolResultOf(writer.threadMessages(thread.id), 'threadRead'));

        expect(toolPage).toEqual({
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
            // F8: 10 characters of the seed message, charged as the delivery cap measures
            // them — that row's shell plus its escaped text. The 22-character raw arguments
            // string of the threadRead call itself is SEARCHED but not displayed, so only
            // the (smaller) reference call shell around it costs anything.
            bytes: chargeOf(toolPage),
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
    // One harness with the entry agent and a second configured agent, plus an
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
            // F8: the page's charge in the delivery currency — every row's measured shell
            // (the seed contributes nothing because it is not returned) plus the escaped
            // width of the displayed text. A `reference` tool call pays its smaller shell and
            // no arguments text; the attachment descriptor pays for its four strings.
            bytes: chargeOf(page),
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

        // The same charge, restated on its own so the currency claim is asserted, not just
        // implied by the object above: `bytes` is the page's cost in the unit the harness cap
        // counts (escaped payload bytes, core/payload-bytes.ts), receipts included — and the
        // page as a whole therefore fits the cap without the envelope ever cutting it.
        expect(page.bytes).toBe(chargeOf(page));

        // The opt-in is a schema-accepted parameter, and it restores exactly what the
        // default withholds: index 0 on the page, `matched` 4, and the seed's own cost
        // charged to the page — its shell plus its text, which is the whole delta (F8).
        const seeded = pageOf(
            await writer.executeTool('threadRead', { thread: target.id, includeSystem: true })
        );

        expect({
            total: seeded.total,
            matched: seeded.matched,
            bytes: seeded.bytes,
            indices: seeded.messages.map((message) => message.index)
        }).toEqual({ total: 4, matched: 4, bytes: chargeOf(seeded), indices: [0, 1, 2, 3] });
        expect(seeded.bytes - page.bytes).toBe(SHELLS.message + wire('You keep notes.'));
        expect(seeded.messages[0]).toEqual({
            index: 0,
            role: 'system',
            content: 'You keep notes.',
            contentLength: 15,
            contentOffset: 0,
            contentHasMore: false
        });

        // `toolArgs: "full"` is the other half of the same contract: the payload comes back
        // quoted, and the page pays the wider call shell PLUS the arguments text — measured
        // against the reference page above, so the delta is exactly the payload and nothing
        // else moved (F8 keeps the reference mode's saving honest by pricing both shells).
        const quoted = pageOf(
            await writer.executeTool('threadRead', { thread: target.id, toolArgs: 'full' })
        );

        expect(quoted.messages[1].toolCalls).toEqual([
            { id: 't1', name: 'read', arguments: '{"path":"report.md"}' }
        ]);
        expect(quoted.bytes - page.bytes).toBe(
            SHELLS.toolCallFull - SHELLS.toolCallReference + wire('{"path":"report.md"}')
        );
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
            // F8: the row's measured shell plus its escaped text — recomputed from the row
            // the page returned, which is what makes this an accounting check rather than a
            // character count.
            bytes: chargeOf(hidden),
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

    it('rejects an unknown thread, and answers a released one for the host view', async () => {
        const { writer, target } = fixture();

        await expect(
            writer.executeTool('threadRead', { thread: 'thread-99' })
        ).rejects.toThrow(
            'Thread "thread-99" is not available in this harness; it was never created, or it was deleted.'
        );

        // A RELEASED THREAD IS NOT THE SAME FACT AS A MISTYPED ID (IT19 R2, and R1
        // 2026-11-27 for the door). `executeTool` carries no caller thread, so this is the host
        // view, and the host view of a soft delete has always been the retained transcript —
        // `threadMessages(target.id)` answers it, `threadDelete`'s receipt promises it, and this
        // entry's own description promises the lineage read. Until R1 the tool contradicted all
        // three by consulting the DISCOVERY record (`harness.thread()`, which voids every
        // `inactive` row) and answering with the sentence above. The read is byte-identical to
        // the live one, because a release is a roster change and never a transcript edit: 4 rows,
        // and 3 after the system seed is dropped by the default `includeSystem: false`.
        const live = pageOf(await writer.executeTool('threadRead', { thread: target.id }));

        writer.deleteThread(target.id);

        const released = pageOf(await writer.executeTool('threadRead', { thread: target.id }));

        expect(released).toEqual(live);
        expect(released.total).toBe(4);
        expect(released.matched).toBe(3);
        // Discovery still excludes it — the two rules stay separable, which is the whole point of
        // the record door having its own seam (`harness.threadReadRecord`) next to `thread()`.
        expect(writer.thread(target.id)).toBeUndefined();
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
describe('threadRead of a released conversation follows the read door (R1, 2026-11-27)', () => {
    // WHY THIS BLOCK EXISTS. A soft delete leaves the row and its transcript (`inactive`), and
    // `threadMessages` is the readability half: the host view and the LINEAGE that released the
    // conversation are served, a stranger gets the named refusal. F1 (2026-11-27) moved that
    // admission test onto the transcript seam, and the tool kept its own gate on `harness.thread()`
    // — a DISCOVERY door that voids every `inactive` row — so BOTH reads below used to be refused
    // by the tool with "it was never created, or it was deleted" after the seam had already
    // admitted them. Everything here is asserted THROUGH THE TOOL (`threadRead` as a model call,
    // or `executeTool` as the host door), which is the surface the earlier suite never touched:
    // `harness.branch-writes.test.ts` pins the seam, and only a tool call can show that the door
    // and the seam now make ONE decision.
    //
    // The turn script is a FUNCTION of the released conversation's id, because that id is minted
    // by `createThread` and the model has to name it as a tool argument.
    const releasedFixture = (turnsFor: (childId: string) => HarnessStreamEvent[][]) => {
        let requests = 0;
        let turns: HarnessStreamEvent[][] = [[]];

        const stream: HarnessStream = async function* () {
            const frames = turns[Math.min(requests, turns.length - 1)] ?? [];
            requests += 1;

            for (const frame of frames) yield frame;
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const parent = writer.createThread('writer', { label: 'Releaser' });
        const child = writer.createThread('writer', {
            label: 'Released',
            ownerThreadId: parent.id
        });

        turns = turnsFor(child.id);

        writer.setThreadMessages(child.id, [
            { role: 'user', content: 'the task worth keeping' },
            { role: 'assistant', content: 'the answer worth keeping' }
        ]);

        return { writer, parent, child };
    };

    // The exact page `threadRead` answers for the two-message transcript above. It is written
    // out once and asserted twice — before and after the release — because that equality IS the
    // finding: the rows, the identity block and every bound are the same bytes, and a soft delete
    // is a roster fact, not a transcript edit. `status` stays 'idle' on the record, and the page
    // has no `inactive` key to leak the difference; the doors that must REFUSE a released
    // conversation (`threadSend`, `threadDelete`) refuse it by name.
    const releasedPage = (thread: { id: string; label?: string; sequence: number }, ownerThreadId: string) => {
        // The two rows, named so the byte figure below can be DERIVED from them (F8: every
        // row pays its measured shell plus its escaped text) instead of being typed as a
        // character count that no longer matches any measure the harness uses.
        const rows = [
            {
                index: 0,
                role: 'user',
                content: 'the task worth keeping',
                contentLength: 22,
                contentOffset: 0,
                contentHasMore: false
            },
            {
                index: 1,
                role: 'assistant',
                content: 'the answer worth keeping',
                contentLength: 24,
                contentOffset: 0,
                contentHasMore: false
            }
        ];

        return {
            thread: {
                id: thread.id,
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: thread.sequence,
                ownerThreadId,
                label: thread.label
            },
            // No filter, no paging, and nothing cut — the only thing this page pays is its
            // two receipts, in the delivery currency.
            total: 2,
            matched: 2,
            offset: 0,
            limit: 20,
            hasMore: false,
            contentBudget: 32768,
            bytes: chargeOfRows(rows),
            truncated: false,
            messages: rows
        };
    };

    it('serves the retained rows to the lineage that released it, through the tool', async () => {
        const { writer, parent, child } = releasedFixture((childId) => [
            callTool('c1', 'threadRead', JSON.stringify({ thread: childId })),
            answer('read it once'),
            callTool('c2', 'threadRead', JSON.stringify({ thread: childId })),
            answer('read it twice')
        ]);

        // The SAME tool call, twice: once while the conversation is live (the baseline the old
        // record gate also served, so an ACTIVE read is provably unchanged), and once after the
        // release, from the conversation that owns it.
        await writer.sendThreadInput(parent.id, 'read the child');
        const before = pageOf(toolResultOf(writer.threadMessages(parent.id), 'threadRead'));

        expect(writer.deleteThread(child.id)).toEqual({
            deleted: child.id,
            removedThreadIds: [child.id],
            removedInvocationIds: [],
            removedBranchIds: []
        });

        await writer.sendThreadInput(parent.id, 'read it again');
        const after = pageOf(toolResultOf(writer.threadMessages(parent.id), 'threadRead'));

        expect(before).toEqual(releasedPage(child, parent.id));
        expect(after).toEqual(releasedPage(child, parent.id));
        expect(after).toEqual(before);

        // The rows the refusal sentence points at are the rows the page carries, and the address
        // is the one `threadList` no longer lists.
        expect(after.messages.map((message) => message.content)).toEqual([
            'the task worth keeping',
            'the answer worth keeping'
        ]);
    });

    it('answers a released conversation for a host read by id, through the same tool', async () => {
        const { writer, parent, child } = releasedFixture(() => [answer('unused')]);

        writer.deleteThread(child.id);

        // `executeTool` runs with no `context.threadId`, which the seams read as the HOST view —
        // the server's transcript reader, the surface the refusal sentence itself promises
        // ("a host can always read it by id"). The door used to contradict that promise.
        expect(pageOf(await writer.executeTool('threadRead', { thread: child.id }))).toEqual(
            releasedPage(child, parent.id)
        );

        // Discovery is untouched by any of this: the row is still off the roster, off
        // `threads()` and off the record door `thread()`, which is the rule that made the old
        // gate look right.
        expect(writer.thread(child.id)).toBeUndefined();
        expect(writer.threads().map((thread) => thread.id)).not.toContain(child.id);
    });

    it('still refuses a stranger through the tool, with the seam sentence', async () => {
        let releasedId = 'thread-unknown';
        let requests = 0;

        // Two conversations with no lineage between them: the released child belongs to `owner`,
        // and the caller is a sibling the release never touched. The scripted transport is
        // per-AGENT, so the caller's turn is routed by the prompt it was sent — the same
        // two-sided routing ./harness.branch-writes.test.ts uses.
        const stream: HarnessStream = async function* (request) {
            const isCaller = request.messages.some(
                (message) => message.role === 'user' && message.content === 'read the released thread'
            );

            if (!isCaller) {
                yield* answer('say it once');
                return;
            }

            const frames =
                requests === 0
                    ? callTool('c1', 'threadRead', JSON.stringify({ thread: releasedId }))
                    : answer('refused');

            requests += 1;

            for (const frame of frames) yield frame;
        };

        const writer = harness({ agents: { writer: brain(stream) }, presets: false });
        const owner = writer.createThread('writer', { label: 'Owner' });
        const released = writer.createThread('writer', {
            label: 'Released',
            ownerThreadId: owner.id
        });
        const stranger = writer.createThread('writer', { label: 'Stranger' });

        releasedId = released.id;

        writer.setThreadMessages(released.id, [
            { role: 'user', content: 'the task worth keeping' },
            { role: 'assistant', content: 'the answer worth keeping' }
        ]);

        await writer.sendThreadInput(released.id, 'say it once');
        writer.deleteThread(released.id);

        await writer.sendThreadInput(stranger.id, 'read the released thread');

        // The whole tool result is the engine's sentence, byte for byte, under the `Tool "…"
        // failed:` head the harness writes when a thrown refusal becomes a transcript row
        // (`deliverTask`'s failure arm — the same reason ../server/harness.it19-retention.test.ts
        // asserts this row with `toContain`): the seam's words reach the model UNCHANGED, because
        // the tool no longer gets a chance to answer the same fact with the not-found head.
        expect(toolResultOf(writer.threadMessages(stranger.id), 'threadRead')).toBe(
            `Tool "threadRead" failed: Thread "${released.id}" is inactive (deleted); its transcript is retained, but it is no longer part of this ` +
                "session's roster, and it is not in your lineage, so threadRead cannot answer it from a conversation " +
                '(see threadList). The conversation that released it — and any conversation in that lineage — still ' +
                'can, and a host can always read it by id.'
        );
    });

    it('refuses an id that was never created, from a conversation and from the host alike', async () => {
        const { writer } = releasedFixture(() => [answer('unused')]);

        // The release narrowed nothing about a mistyped id: an address nobody has keeps the
        // canonical one sentence (issue 0034's one sentence, three doors), whether the caller
        // stands in a conversation or not. `executeTool` has no caller thread, so the host form
        // is the same call.
        await expect(writer.executeTool('threadRead', { thread: 'thread-404' })).rejects.toThrow(
            'Thread "thread-404" is not available in this harness; it was never created, or it was deleted.'
        );
    });
});

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
