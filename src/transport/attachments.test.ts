// transport/openai.ts — attachment mapping.
//
// Pinned contract (frozen shapes):
//   - a text-only user message keeps `{ role, content: string }`;
//   - markers are retained as text labels immediately before their part, with
//     the surrounding prompt text preserved in order;
//   - attachments without a marker are appended at the end;
//   - a duplicated marker is rejected before fetch;
//   - image/png -> image_url data URL; pdf -> file.file_data data URL;
//     audio -> input_audio (raw base64 + wav|mp3);
//   - video -> video_url ONLY when the actual request host is openrouter.ai;
//   - `file` and unavailable video are explicit unsupported errors before fetch,
//     never a stringified binary.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAICompatible } from '@underload/harness';
import type { HarnessAttachment, HarnessStreamEvent } from '@underload/harness';

const sseBody = (frames: string[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const frame of frames) {
                controller.enqueue(encoder.encode(frame));
            }
            controller.close();
        }
    });
};

const collect = async (events: AsyncIterable<HarnessStreamEvent>): Promise<HarnessStreamEvent[]> => {
    const collected: HarnessStreamEvent[] = [];
    for await (const event of events) {
        collected.push(event);
    }
    return collected;
};

const stubFetch = (frames: string[] = ['data: [DONE]\n\n']) => {
    const fetchMock = vi.fn(async () => new Response(sseBody(frames), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

const bodyOf = (fetchMock: ReturnType<typeof stubFetch>): any =>
    JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

afterEach(() => {
    vi.unstubAllGlobals();
});

const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');
const ascii = (text: string): number[] => text.split('').map((character) => character.charCodeAt(0));

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const PDF_BYTES = ascii('%PDF-1.4\n');
const WAV_BYTES = [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVE')];
const MP3_BYTES = [...ascii('ID3'), 0x04, 0, 0, 0, 0, 0, 0];
const MP4_BYTES = [0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('isom')];

const PNG_DATA = base64(PNG_BYTES);
const PDF_DATA = base64(PDF_BYTES);
const WAV_DATA = base64(WAV_BYTES);
const MP3_DATA = base64(MP3_BYTES);
const MP4_DATA = base64(MP4_BYTES);

const image = (overrides: Partial<HarnessAttachment> = {}): HarnessAttachment => ({
    id: 'img-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    size: PNG_BYTES.length,
    data: PNG_DATA,
    ...overrides
});

const pdf = (): HarnessAttachment => ({
    id: 'pdf-1',
    kind: 'pdf',
    marker: '[PDF 1]',
    name: 'paper.pdf',
    mime: 'application/pdf',
    size: PDF_BYTES.length,
    data: PDF_DATA
});

const wav = (): HarnessAttachment => ({
    id: 'aud-1',
    kind: 'audio',
    marker: '[Audio 1]',
    name: 'take.wav',
    mime: 'audio/wav',
    size: WAV_BYTES.length,
    data: WAV_DATA
});

const mp3 = (): HarnessAttachment => ({
    id: 'aud-2',
    kind: 'audio',
    marker: '[Audio 2]',
    name: 'take.mp3',
    mime: 'audio/mpeg',
    size: MP3_BYTES.length,
    data: MP3_DATA
});

const video = (): HarnessAttachment => ({
    id: 'vid-1',
    kind: 'video',
    marker: '[Video 1]',
    name: 'clip.mp4',
    mime: 'video/mp4',
    size: MP4_BYTES.length,
    data: MP4_DATA
});

const streamFor = (baseURL: string) => openAICompatible({ baseURL });

describe('openAICompatible attachments', () => {
    it('maps an image at its marker, keeping surrounding text and the label', async () => {
        const fetchMock = stubFetch();

        const events = await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [
                    { role: 'user', content: 'Look at [Image 1] now', attachments: [image()] }
                ]
            })
        );

        expect(events).toEqual([{ type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }]);
        expect(bodyOf(fetchMock).messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Look at ' },
                    { type: 'text', text: '[Image 1]' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_DATA}` } },
                    { type: 'text', text: ' now' }
                ]
            }
        ]);
    });

    it('keeps the historical text-only user shape exactly', async () => {
        const fetchMock = stubFetch();

        await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [{ role: 'user', content: 'plain prompt' }]
            })
        );

        expect(bodyOf(fetchMock).messages).toEqual([{ role: 'user', content: 'plain prompt' }]);
    });

    it('orders parts by marker position, not attachment array order', async () => {
        const fetchMock = stubFetch();

        await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [
                    {
                        role: 'user',
                        content: '[PDF 1] and [Audio 1]',
                        attachments: [wav(), pdf()]
                    }
                ]
            })
        );

        expect(bodyOf(fetchMock).messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: '[PDF 1]' },
                    {
                        type: 'file',
                        file: {
                            filename: 'paper.pdf',
                            file_data: `data:application/pdf;base64,${PDF_DATA}`
                        }
                    },
                    { type: 'text', text: ' and ' },
                    { type: 'text', text: '[Audio 1]' },
                    { type: 'input_audio', input_audio: { data: WAV_DATA, format: 'wav' } }
                ]
            }
        ]);
    });

    it('maps mp3 audio to the mp3 input_audio format', async () => {
        const fetchMock = stubFetch();

        await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [{ role: 'user', content: '[Audio 2]', attachments: [mp3()] }]
            })
        );

        expect(bodyOf(fetchMock).messages[0].content).toEqual([
            { type: 'text', text: '[Audio 2]' },
            { type: 'input_audio', input_audio: { data: MP3_DATA, format: 'mp3' } }
        ]);
    });

    it('appends an attachment whose marker is absent', async () => {
        const fetchMock = stubFetch();

        await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [{ role: 'user', content: 'summary only', attachments: [image()] }]
            })
        );

        expect(bodyOf(fetchMock).messages[0].content).toEqual([
            { type: 'text', text: 'summary only' },
            { type: 'text', text: '[Image 1]' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_DATA}` } }
        ]);
    });

    it('rejects a duplicated attached marker before fetch', async () => {
        const fetchMock = stubFetch();

        const events = await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [
                    {
                        role: 'user',
                        content: '[Image 1] and again [Image 1]',
                        attachments: [image()]
                    }
                ]
            })
        );

        expect(events).toEqual([
            {
                type: 'error',
                message: 'The marker "[Image 1]" appears more than once in the user prompt.'
            }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects video off OpenRouter before fetch', async () => {
        const fetchMock = stubFetch();

        const events = await collect(
            streamFor('http://localhost:5500/providers/private/v1')({
                model: 'm',
                messages: [{ role: 'user', content: '[Video 1]', attachments: [video()] }]
            })
        );

        expect(events).toEqual([
            {
                type: 'error',
                message:
                    'Attachments of kind "video" are only supported by OpenRouter (request host openrouter.ai).'
            }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends a video_url part when the actual host is openrouter.ai', async () => {
        const fetchMock = stubFetch();

        await collect(
            streamFor('https://openrouter.ai/api/v1')({
                model: 'm',
                messages: [{ role: 'user', content: '[Video 1]', attachments: [video()] }]
            })
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(bodyOf(fetchMock).messages[0].content).toEqual([
            { type: 'text', text: '[Video 1]' },
            { type: 'video_url', video_url: { url: `data:video/mp4;base64,${MP4_DATA}` } }
        ]);
    });

    it('rejects an unknown file kind with an explicit unsupported error', async () => {
        const fetchMock = stubFetch();

        const unknown: HarnessAttachment = {
            id: 'file-1',
            kind: 'file',
            marker: '[File 1]',
            name: 'archive.zip',
            mime: 'application/zip',
            size: 4,
            data: base64([0x50, 0x4b, 0x03, 0x04])
        };

        const events = await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [{ role: 'user', content: '[File 1]', attachments: [unknown] }]
            })
        );

        expect(events).toEqual([
            {
                type: 'error',
                message:
                    'Attachments of kind "file" (application/zip) are not supported by this transport; send the content as text instead.'
            }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('re-validates attachments at the wire boundary before fetch', async () => {
        const fetchMock = stubFetch();

        const events = await collect(
            streamFor('http://x/v1')({
                model: 'm',
                messages: [
                    {
                        role: 'user',
                        content: '[Image 1]',
                        // Deliberately malformed: the transport is callable directly.
                        attachments: [image({ size: 99 })]
                    }
                ]
            })
        );

        expect(events).toEqual([
            { type: 'error', message: 'attachments[0].size is 99, but its data decodes to 12 bytes.' }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
