// core/agent.ts — user-message attachments (T3).
//
// Pinned contract:
//   - user(content) keeps the historical shape with NO `attachments` key;
//   - user(content, attachments) validates and appends detached copies;
//   - stream(input, { attachments }) carries them into the request transcript
//     and commits the same message to history;
//   - malformed attachments are rejected BEFORE mutation (user throws; stream
//     yields an error event and leaves history untouched);
//   - the transport receives copies, so it cannot mutate live history.

import { describe, expect, it } from 'vitest';
import { agent } from '@underload/harness';
import type {
    AgentStreamEvent,
    HarnessAttachment,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const PNG_DATA = base64(PNG_BYTES);

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

const done = (): HarnessStreamEvent => ({ type: 'done', stopReason: 'stop', toolCalls: [] });

const fakeStream = (
    seen: HarnessStreamRequest[],
    frames: HarnessStreamEvent[] = [{ type: 'text', delta: 'ok' }, done()]
): HarnessStream =>
    async function* stream(request) {
        seen.push(request);
        for (const frame of frames) {
            yield frame;
        }
    };

const collect = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];
    for await (const event of events) {
        collected.push(event);
    }
    return collected;
};

const expectedAttachment = image();

describe('agent user attachments', () => {
    it('validates and copies attachments seeded through configuration.messages', () => {
        const brain = agent({
            model: 'm',
            stream: fakeStream([]),
            messages: [{ role: 'user', content: 'seed [Image 1]', attachments: [image()] }]
        });

        expect(brain.messages).toEqual([
            { role: 'user', content: 'seed [Image 1]', attachments: [expectedAttachment] }
        ]);

        expect(() =>
            agent({
                model: 'm',
                stream: fakeStream([]),
                messages: [{ role: 'user', content: 'bad', attachments: [image({ size: 99 })] }]
            })
        ).toThrow('attachments[0].size is 99, but its data decodes to 12 bytes.');
    });

    it('keeps the committed transcript when reset revalidation fails', () => {
        // The caller owns `configuration.messages`; mutating it after
        // construction is the documented way a later reset can see a bad seed.
        const seedMessage = {
            role: 'user' as const,
            content: 'seed [Image 1]',
            attachments: [image()]
        };
        const brain = agent({ model: 'm', stream: fakeStream([]), messages: [seedMessage] });
        const committed = JSON.parse(JSON.stringify(brain.messages)) as HarnessMessage[];

        seedMessage.attachments[0].size = 99;

        expect(() => brain.reset()).toThrow(
            'attachments[0].size is 99, but its data decodes to 12 bytes.'
        );
        // Reset is transactional: the failed seed build never cleared history.
        expect(brain.messages).toEqual(committed);
    });

    it('keeps a text-only user message free of an attachments key', () => {
        const brain = agent({ model: 'm', stream: fakeStream([]) });

        brain.user('hello');

        expect(brain.messages).toStrictEqual([{ role: 'user', content: 'hello' }]);
    });

    it('appends validated attachments as a detached copy', () => {
        const brain = agent({ model: 'm', stream: fakeStream([]) });
        const input = image();

        brain.user('See [Image 1]', [input]);

        expect(brain.messages).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [expectedAttachment] }
        ]);

        const stored = brain.messages[0] as Extract<(typeof brain.messages)[number], { role: 'user' }>;
        expect(stored.attachments?.[0]).not.toBe(input);

        // Neither side aliases the other.
        input.name = 'renamed.png';
        expect(stored.attachments?.[0].name).toBe('pixel.png');
        stored.attachments![0].data = 'AAAA';
        expect(input.data).toBe(PNG_DATA);
    });

    it('rejects malformed attachments before appending', () => {
        const brain = agent({ model: 'm', stream: fakeStream([]) });

        expect(() => brain.user('See [Image 1]', [image({ size: 99 })])).toThrow(
            'attachments[0].size is 99, but its data decodes to 12 bytes.'
        );
        expect(brain.messages).toEqual([]);
    });

    it('streams attachments with the user message and commits them', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({ model: 'm', stream: fakeStream(seen) });

        const events = await collect(brain.stream('See [Image 1]', { attachments: [image()] }));

        expect(events).toEqual([
            { type: 'text', delta: 'ok' },
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: 'ok',
                    reasoning: '',
                    toolCalls: [],
                    model: 'm',
                    stopReason: 'stop',
                    usage: undefined
                }
            }
        ]);
        expect(seen[0].messages).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [expectedAttachment] }
        ]);
        expect(brain.messages).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [expectedAttachment] },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('keeps the text-only stream shape unchanged', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({ model: 'm', stream: fakeStream(seen) });

        await collect(brain.stream('plain'));

        expect(seen[0].messages).toStrictEqual([{ role: 'user', content: 'plain' }]);
        expect(brain.messages).toStrictEqual([
            { role: 'user', content: 'plain' },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('yields an error and leaves history untouched for malformed stream attachments', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({ model: 'm', stream: fakeStream(seen) });

        const events = await collect(brain.stream('bad', { attachments: [image({ size: 99 })] }));

        expect(events).toEqual([
            {
                type: 'error',
                error: { message: 'attachments[0].size is 99, but its data decodes to 12 bytes.' }
            }
        ]);
        expect(seen).toEqual([]);
        expect(brain.messages).toEqual([]);
    });

    it('gives the transport a copy it cannot use to mutate history', async () => {
        const seen: HarnessStreamRequest[] = [];
        const transport: HarnessStream = async function* stream(request) {
            seen.push(request);
            // A transport must never see a live array; mutate the copy it was
            // handed and prove history is unaffected below.
            const user = request.messages[0] as Extract<HarnessStreamRequest['messages'][number], { role: 'user' }>;
            user.attachments![0].data = 'AAAA';
            yield done();
        };
        const brain = agent({ model: 'm', stream: transport });

        await collect(brain.stream('See [Image 1]', { attachments: [image()] }));

        expect(seen[0].messages[0]).toEqual({
            role: 'user',
            content: 'See [Image 1]',
            attachments: [{ ...expectedAttachment, data: 'AAAA' }]
        });
        expect(brain.messages[0]).toEqual({
            role: 'user',
            content: 'See [Image 1]',
            attachments: [expectedAttachment]
        });
    });
});
