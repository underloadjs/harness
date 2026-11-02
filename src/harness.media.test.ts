// harness.ts — tool media through the whole run (R3/R4).
//
// Pinned contract:
//   - a tool that returns `toolMedia(summary, attachments)` commits a NORMAL
//     text tool message PLUS an `attachments` payload; the 64 KiB result
//     budget never sees the bytes, so a 20 MiB file is not reduced to a name;
//   - the `tool_result` event reports DESCRIPTORS only (no base64), and a
//     medialess result keeps the exact historical 4-key message and event;
//   - media is stored on the tool message, and the OpenAI-compatible transport
//     replays it as a clearly labelled USER payload after the complete tool
//     block (strict pairing, including parallel calls);
//   - snapshots round-trip the media with detached copies;
//   - a forged or oversized envelope is an explicit FAILED call, never a
//     silent omission.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MODEL_TOOL_RESULT_BUDGET_BYTES,
    agent,
    harness,
    tool,
    toolMedia,
    unwrapToolResult
} from '@underload/harness';
import type {
    HarnessAttachment,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamRequest,
    ToolMediaEnvelope
} from '@underload/harness';

const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
const PNG_DATA = base64(PNG_BYTES);
const ZIP_BYTES = [0x50, 0x4b, 0x03, 0x04];
const ZIP_DATA = base64(ZIP_BYTES);

// `overrides` lets one fixture describe several files (the T8/F2 five-call case
// needs a distinct name per call while keeping the same bytes, id and marker).
const imageMedia = (overrides: Partial<HarnessAttachment> = {}): HarnessAttachment => ({
    id: 'dl-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    size: PNG_BYTES.length,
    data: PNG_DATA,
    ...overrides
});

const zipMedia = (): HarnessAttachment => ({
    id: 'dl-1',
    kind: 'file',
    marker: '[File 1]',
    name: 'archive.zip',
    mime: 'application/zip',
    size: ZIP_BYTES.length,
    data: ZIP_DATA
});

const PNG_SUMMARY = { kind: 'image', name: 'pixel.png', bytes: 12, media: 'attached' };
const ZIP_SUMMARY = { kind: 'file', name: 'archive.zip', bytes: 4, media: 'attached' };

// Two tools: one returns media, one is an ordinary text result. Their committed
// shapes must differ exactly in the `attachments` key.
//
// `grab` declares exactly ONE property, so the single-property rule (see
// core/tool.ts) hands `execute` the property VALUE: 'zip' selects the generic
// file, anything else the PNG.
const grab = tool<string, ToolMediaEnvelope<typeof PNG_SUMMARY>>({
    name: 'grab',
    description: 'Attach one file to the model.',
    tags: ['test', 'media'],
    visibility: 'core',
    parameters: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
    execute: ({ parameters }) =>
        toolMedia(parameters === 'zip' ? ZIP_SUMMARY : PNG_SUMMARY, [parameters === 'zip' ? zipMedia() : imageMedia()])
});

const plain = tool<{ note?: string }, { echo: string }>({
    name: 'plain',
    description: 'A normal text result.',
    tags: ['test'],
    visibility: 'core',
    parameters: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
    execute: () => ({ echo: 'ok' })
});

const forged = tool<Record<string, never>, unknown>({
    name: 'forged',
    description: 'Returns a hand-built envelope above the download cap.',
    tags: ['test'],
    visibility: 'core',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({
        // A replaced/host tool can forge the brand; the boundary must reject it.
        __toolMedia: [{ ...imageMedia(), data: 'AA==', size: 1, mime: 'application/octet-stream', kind: 'file', marker: '[File 1]', name: 'x.bin' },
            { ...imageMedia(), data: 'AA==', size: 1, mime: 'application/octet-stream', kind: 'file', marker: '[File 2]', name: 'y.bin' },
            { ...imageMedia(), data: 'AA==', size: 1, mime: 'application/octet-stream', kind: 'file', marker: '[File 3]', name: 'z.bin' },
            { ...imageMedia(), data: 'AA==', size: 1, mime: 'application/octet-stream', kind: 'file', marker: '[File 4]', name: 'w.bin' },
            { ...imageMedia(), data: 'AA==', size: 1, mime: 'application/octet-stream', kind: 'file', marker: '[File 5]', name: 'v.bin' }],
        content: PNG_SUMMARY
    })
});

// Replay a fixed list of turns and record every request the harness built
// (same shape as the other harness tests).
const scripted = (turns: any[][], seen: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(request) {
        seen.push(request);
        const frames = turns[Math.min(index, turns.length - 1)];
        index += 1;
        for (const frame of frames) yield frame;
    };
};

const callTurn = (calls: Array<{ id: string; name: string; args: string }>): any[] => [
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.args }))
    }
];

const finalTurn = (text: string): any[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

afterEach(() => {
    vi.unstubAllGlobals();
});

const toolMessages = (messages: readonly HarnessMessage[]): Extract<HarnessMessage, { role: 'tool' }>[] =>
    messages.filter((message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool');

describe('harness tool media', () => {
    it('commits a text tool message plus the validated attachment', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({ model: 'm', stream: scripted([callTurn([{ id: 'c1', name: 'grab', args: '{}' }]), finalTurn('done')], seen) });
        const writer = harness({ agents: { writer: brain }, presets: false, tools: { grab, plain } });

        await writer('grab the file');

        const [committed] = toolMessages(brain.messages);

        expect(committed).toEqual({
            role: 'tool',
            content: JSON.stringify(PNG_SUMMARY),
            toolCallId: 'c1',
            name: 'grab',
            attachments: [imageMedia()]
        });

        // The bytes are OUT of the model-facing text: nothing was truncated and
        // the summary stays far under the 64 KiB budget.
        expect(committed.content).not.toContain(PNG_DATA);
        expect(committed.content.length).toBeLessThan(MODEL_TOOL_RESULT_BUDGET_BYTES);

        // The media rides on the transcript, so the NEXT request carries it.
        expect(seen[1].messages).toEqual([
            { role: 'user', content: 'grab the file' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'grab', arguments: '{}' }]
            },
            {
                role: 'tool',
                content: JSON.stringify(PNG_SUMMARY),
                toolCallId: 'c1',
                name: 'grab',
                attachments: [imageMedia()]
            }
        ]);

        // ...and the request copy is detached from the committed transcript:
        // mutating the copy the transport was handed must not reach history.
        const requestMedia = (seen[1].messages[2] as Extract<HarnessMessage, { role: 'tool' }>).attachments;

        expect(requestMedia).toBeDefined();
        requestMedia![0].name = 'mutated.png';

        expect(requestMedia![0].name).toBe('mutated.png');
        expect(toolMessages(brain.messages)[0].attachments?.[0].name).toBe('pixel.png');
    });

    it('reports descriptors on the event and keeps a medialess result unchanged', async () => {
        const brain = agent({
            model: 'm',
            stream: scripted(
                [
                    callTurn([
                        { id: 'c1', name: 'grab', args: '{"file":"zip"}' },
                        { id: 'c2', name: 'plain', args: '{}' }
                    ]),
                    finalTurn('done')
                ],
                []
            )
        });

        const events: HarnessEvent[] = [];
        const writer = harness({
            agents: { writer: brain },
            presets: false,
            tools: { grab, plain },
            report: { progress: (event) => events.push(event) }
        });

        await writer('two calls');

        const results = events.filter((event) => event.type === 'tool_result') as Extract<
            HarnessEvent,
            { type: 'tool_result' }
        >[];

        expect(results).toHaveLength(2);

        const mediaEvent = results.find((event) => event.name === 'grab') as Extract<HarnessEvent, { type: 'tool_result' }>;
        const plainEvent = results.find((event) => event.name === 'plain') as Extract<HarnessEvent, { type: 'tool_result' }>;

        expect(mediaEvent.media).toEqual([
            { id: 'dl-1', kind: 'file', name: 'archive.zip', mime: 'application/zip', size: 4 }
        ]);
        // No raw media on ANY event: the whole progress frame stays small.
        expect(JSON.stringify(mediaEvent)).not.toContain(ZIP_DATA);
        expect(mediaEvent.outcome).toBe('completed');
        expect(mediaEvent.isError).toBe(false);

        expect(plainEvent.media).toBeUndefined();
        expect(plainEvent.content).toBe(JSON.stringify({ echo: 'ok' }));

        // The medialess call keeps its exact historical 4-key message.
        const [zipMessage, plainMessage] = toolMessages(brain.messages);
        expect(plainMessage).toEqual({ role: 'tool', content: '{"echo":"ok"}', toolCallId: 'c2', name: 'plain' });
        expect(Object.keys(plainMessage)).toEqual(['role', 'content', 'toolCallId', 'name']);
        expect(zipMessage.attachments).toEqual([zipMedia()]);
    });

    it('expands the media on the wire AFTER the complete tool block (parallel calls)', async () => {
        // A real OpenAI-compatible transport, so the provider payload ordering is
        // verified end to end and not only at the transcript level.
        const chatBodies: string[] = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init?: RequestInit) => {
                if (String(url).endsWith('/chat/completions')) {
                    chatBodies.push(String(init?.body ?? ''));

                    const isFirst = chatBodies.length === 1;

                    const payload =
                        isFirst === true
                            ? [
                                  {
                                      choices: [
                                          {
                                              delta: {
                                                  tool_calls: [
                                                      { index: 0, id: 'c1', function: { name: 'grab', arguments: '{}' } },
                                                      { index: 1, id: 'c2', function: { name: 'grab', arguments: '{"file":"zip"}' } }
                                                  ]
                                              },
                                              finish_reason: 'tool_calls'
                                          }
                                      ]
                                  }
                              ]
                            : [{ choices: [{ delta: { content: 'both shown' }, finish_reason: 'stop' }] }];

                    const sse = `${payload.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;

                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                controller.enqueue(new TextEncoder().encode(sse));
                                controller.close();
                            }
                        }),
                        { status: 200 }
                    );
                }

                // Any other URL is this tool's own file request.
                const headers = new Headers();
                const isZip = String(url).includes('zip');
                headers.set('content-type', isZip ? 'application/zip' : 'image/png');

                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(isZip ? Uint8Array.from(ZIP_BYTES) : Uint8Array.from(PNG_BYTES));
                            controller.close();
                        }
                    }),
                    { status: 200, headers }
                );
            })
        );

        // `wireGrab` plays the download preset's part: the single-property rule
        // hands execute the selector string, and the URL decides the bytes.
        const wireGrab = tool<string, unknown>({
            name: 'grab',
            description: 'Fetch one file and attach it.',
            tags: ['test', 'media'],
            visibility: 'core',
            parameters: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
            execute: async ({ parameters }) => {
                const isZip = parameters === 'zip';
                const response = await fetch(isZip ? 'https://files.test/archive.zip' : 'https://files.test/pixel.png');
                const bytes = new Uint8Array(await response.arrayBuffer());
                const mime = String(response.headers.get('content-type'));

                return toolMedia({ url: 'https://files.test/x', bytes: bytes.byteLength, media: 'attached' }, [
                    {
                        id: 'dl-1',
                        kind: isZip ? 'file' : 'image',
                        marker: isZip ? '[File 1]' : '[Image 1]',
                        name: isZip ? 'archive.zip' : 'pixel.png',
                        mime,
                        size: bytes.byteLength,
                        data: base64(Array.from(bytes))
                    }
                ]);
            }
        });

        // Route the model through the REAL transport against the stub above.
        const model = agent({ model: 'm', provider: { baseURL: 'http://chat.test/v1' } });

        const writer = harness({ agents: { writer: model }, presets: false, tools: { grab: wireGrab } });

        await writer('show both');

        // The recorded body is the provider request, so `messages` is the wire
        // transcript: exactly what a gateway would see for this turn.
        const secondRequest = (JSON.parse(chatBodies[1]) as { messages: Array<Record<string, any>> }).messages;

        // Provider order: the assistant's two calls are answered first, and only
        // then does ONE labelled user payload carry both files.
        expect(secondRequest.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);

        const mediaPayload = secondRequest[4].content as Array<Record<string, any>>;

        expect(mediaPayload.map((part) => part.type)).toEqual(['text', 'text', 'image_url', 'text', 'text', 'file']);
        expect(mediaPayload[2].image_url.url).toBe(`data:image/png;base64,${PNG_DATA}`);
        expect(mediaPayload[5].file).toEqual({
            filename: 'archive.zip',
            file_data: `data:application/zip;base64,${ZIP_DATA}`
        });
        expect(String(mediaPayload[0].text)).toContain(
            'File 1 from tool "grab" (call c1) is pixel.png, image/png, 12 bytes'
        );
        expect(String(mediaPayload[3].text)).toContain(
            'File 2 from tool "grab" (call c2) is archive.zip, application/zip, 4 bytes'
        );
    });

    // T8/F2, end to end (harness + real transport): FIVE parallel media calls must
    // produce a fully paired block followed by TWO media payloads. Before the fix
    // the fifth file made the whole transcript permanently invalid, because one
    // synthetic user message was validated against the profile's 4-entry count.
    it('expands five parallel media calls into two payloads after the complete tool block', async () => {
        const chatBodies: string[] = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init?: RequestInit) => {
                chatBodies.push(String(init?.body ?? ''));

                const payload =
                    chatBodies.length === 1
                        ? [
                              {
                                  choices: [
                                      {
                                          delta: {
                                              tool_calls: [1, 2, 3, 4, 5].map((index) => ({
                                                  index: index - 1,
                                                  id: `c${String(index)}`,
                                                  function: {
                                                      name: 'grab',
                                                      arguments: JSON.stringify({ file: String(index) })
                                                  }
                                              }))
                                          },
                                          finish_reason: 'tool_calls'
                                      }
                                  ]
                              }
                          ]
                        : [{ choices: [{ delta: { content: 'all five' }, finish_reason: 'stop' }] }];

                const sse = `${payload.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`;

                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode(sse));
                            controller.close();
                        }
                    }),
                    { status: 200 }
                );
            })
        );

        // Every call attaches the SAME kind under the SAME tool-side id `dl-1`,
        // which is exactly the situation the transport must resolve: unique ids and
        // markers per wire payload, grouped to the profile's bounds.
        const fiveGrab = tool<string, unknown>({
            name: 'grab',
            description: 'Attach one file.',
            tags: ['test', 'media'],
            visibility: 'core',
            parameters: { type: 'object', properties: { file: { type: 'string' } }, additionalProperties: false },
            execute: async ({ parameters }) =>
                toolMedia({ file: parameters }, [imageMedia({ name: `file-${String(parameters)}.png` })])
        });

        const model = agent({ model: 'm', provider: { baseURL: 'http://chat.test/v1' } });
        const writer = harness({ agents: { writer: model }, presets: false, tools: { grab: fiveGrab } });

        const result = await writer('show five');
        expect(result.content).toBe('all five');

        const messages = (JSON.parse(chatBodies[1]) as { messages: Array<Record<string, any>> }).messages;

        // Strict pairing: user, assistant(5 calls), FIVE tool answers, and only
        // then the two consecutive media payloads — never a synthetic user inside
        // the tool block.
        expect(
            messages.map((message) => (typeof message.content === 'string' ? message.role : `${message.role}:parts`))
        ).toEqual([
            'user',
            'assistant',
            'tool',
            'tool',
            'tool',
            'tool',
            'tool',
            'user:parts',
            'user:parts'
        ]);
        expect(messages[1].tool_calls.map((call: Record<string, any>) => call.id)).toEqual([
            'c1',
            'c2',
            'c3',
            'c4',
            'c5'
        ]);
        expect(messages.slice(2, 7).map((message) => message.tool_call_id)).toEqual([
            'c1',
            'c2',
            'c3',
            'c4',
            'c5'
        ]);

        // Payload 1 carries files 1-4, payload 2 carries file 5, and the marker
        // numbering continues across the split so every file stays citable.
        const markersIn = (index: number): string[] =>
            (messages[index].content as Array<Record<string, any>>)
                .filter((part) => part.type === 'text' && String(part.text).startsWith('['))
                .map((part) => String(part.text));

        expect(markersIn(7)).toEqual(['[Image 1]', '[Image 2]', '[Image 3]', '[Image 4]']);
        expect(markersIn(8)).toEqual(['[Image 5]']);

        const firstText = (messages[7].content as Array<Record<string, any>>)[0].text as string;
        const secondText = (messages[8].content as Array<Record<string, any>>)[0].text as string;

        expect(firstText).toContain('(part 1 of 2)');
        expect(firstText).toContain('File 1 from tool "grab" (call c1) is file-1.png');
        expect(secondText).toContain('(part 2 of 2)');
        expect(secondText).toContain('File 5 from tool "grab" (call c5) is file-5.png');

        // The image parts still travel: five attachments, four then one.
        expect((messages[7].content as Array<Record<string, any>>).filter((part) => part.type === 'image_url')).toHaveLength(4);
        expect((messages[8].content as Array<Record<string, any>>).filter((part) => part.type === 'image_url')).toHaveLength(1);
    });

    it('round-trips media through a snapshot with detached copies', async () => {
        const brain = agent({
            model: 'm',
            stream: scripted([callTurn([{ id: 'c1', name: 'grab', args: '{}' }]), finalTurn('done')], [])
        });
        const writer = harness({ agents: { writer: brain }, presets: false, tools: { grab } });

        await writer('grab');

        // The snapshot document carries the media, and `restore` re-validates it
        // through the shared reader (readHarnessSnapshot) on the way back in.
        const snapshot = JSON.parse(JSON.stringify(writer.snapshot()));

        expect(toolMessages(snapshot.agents.writer.messages)[0].attachments).toEqual([imageMedia()]);

        // Corrupting the stored bytes without their declared size must fail the
        // restore loudly — a resumed session cannot replay garbage to the model.
        const corrupted = JSON.parse(JSON.stringify(snapshot));
        corrupted.agents.writer.messages[2].attachments[0].data = 'AAAA';

        expect(() => writer.restore(corrupted)).toThrow(/size is 12, but its data decodes to 3 bytes/);

        // A valid document round-trips, and the caller's document was never
        // aliased into the live transcript.
        snapshot.agents.writer.messages[2].attachments[0].name = 'renamed.png';
        expect(toolMessages(brain.messages)[0].attachments?.[0].name).toBe('pixel.png');

        writer.restore(snapshot);

        expect(toolMessages(brain.messages)[0].attachments?.[0].name).toBe('renamed.png');

        // A medialess transcript still serializes without the key at all.
        const plainBrain = agent({
            model: 'm',
            stream: scripted([callTurn([{ id: 'p1', name: 'plain', args: '{}' }]), finalTurn('ok')], [])
        });
        const plainWriter = harness({ agents: { writer: plainBrain }, presets: false, tools: { plain } });

        await plainWriter('just text');

        const plainMessage = toolMessages(plainWriter.snapshot().agents.writer.messages)[0];

        expect(Object.keys(plainMessage)).toEqual(['role', 'content', 'toolCallId', 'name']);
        expect(JSON.stringify(plainMessage)).not.toContain('attachments');
    });

    it('fails a forged envelope explicitly instead of dropping the media', async () => {
        const brain = agent({
            model: 'm',
            stream: scripted([callTurn([{ id: 'f1', name: 'forged', args: '{}' }]), finalTurn('done')], [])
        });
        const writer = harness({ agents: { writer: brain }, presets: false, tools: { forged } });

        await writer('forge it');

        const [committed] = toolMessages(brain.messages);

        expect(committed.content).toContain('completed but its result could not be serialized');
        expect(committed.content).toContain('attachments may contain at most 4 entries; received 5');
        expect(committed.attachments).toBeUndefined();
    });

    it('registers the download preset as a demand-discovered tool by default', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({
            model: 'm',
            stream: async function* (request) {
                seen.push(request);
                yield { type: 'text', delta: 'ready' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
            }
        });

        // Default presets: the entry must appear with the other core tools, in
        // registration order (after `glob`/`grep`, before the web providers).
        const writer = harness({ agents: { writer: brain } });

        await writer('hello');

        const declared = seen[0].tools?.map((entry) => entry.name) ?? [];

        // R9-R11: `download` is searchable, so the last declarations of the first
        // request are the core file presets. Registration order is unchanged (the
        // download row still sits at order 235, after gitDiff), it is simply not
        // part of the declared set.
        expect(declared.slice(-3)).toEqual(['edit', 'glob', 'grep']);
        expect(writer.tools.download).toBeDefined();
        expect(writer.tools.download.visibility).toBe('searchable');
    });

    it('keeps unwrapToolResult the single unwrap for both brands', () => {
        const unwrapped = unwrapToolResult(toolMedia(PNG_SUMMARY, [imageMedia()]));

        expect(unwrapped.content).toEqual(PNG_SUMMARY);
        expect(unwrapped.media).toEqual([imageMedia()]);
        expect(unwrapped.panels).toBeUndefined();
    });
});
