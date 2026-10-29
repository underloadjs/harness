// harness.ts — root attachment propagation (R2/R3).
//
// Pinned contract:
//   - HarnessRunOptions.attachments ride on the ROOT user message only;
//   - the root request transcript carries them and history retains them;
//   - delegated subagents never inherit the root's bytes;
//   - malformed attachments reject before any mutation or progress event;
//   - a run without attachments keeps the historical request shape.

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type {
    HarnessAttachment,
    HarnessEvent,
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

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const calls = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

// Replay a fixed list of turns; record every request the harness built.
const scripted = (turns: HarnessStreamEvent[][], seen: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen.push(request);
        const frames = turns[Math.min(index, turns.length - 1)];
        index++;
        for (const frame of frames) yield frame;
    };
};

describe('harness root attachments', () => {
    it('sends and commits attachments on the root user message', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({ model: 'm', stream: scripted([answer('ok')], seen) });
        const writer = harness({ agents: { writer: brain }, presets: false });

        const message = await writer('See [Image 1]', { attachments: [image()] });

        expect(message.content).toBe('ok');
        expect(seen[0].messages).toStrictEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] }
        ]);
        expect(brain.messages).toStrictEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('keeps the text-only request shape unchanged', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({ model: 'm', stream: scripted([answer('ok')], seen) });
        const writer = harness({ agents: { writer: brain }, presets: false });

        await writer('plain');

        expect(seen[0].messages).toStrictEqual([{ role: 'user', content: 'plain' }]);
    });

    it('does not attach root bytes to a delegated subagent prompt', async () => {
        const primarySeen: HarnessStreamRequest[] = [];
        const childSeen: HarnessStreamRequest[] = [];

        const writer = agent({
            model: 'parent',
            stream: scripted(
                [calls('d1', 'agentDelegate', '{"agent":"helper","input":"child prompt"}'), answer('parent done')],
                primarySeen
            )
        });
        const helper = agent({ model: 'child', stream: scripted([answer('child answer')], childSeen) });

        const app = harness({
            agents: { writer, helper },
            primary: 'writer',
            subagents: ['helper'],
            presets: false,
            tools: {}
        });

        await app('See [Image 1]', { attachments: [image()] });

        expect(primarySeen[0].messages).toStrictEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] }
        ]);
        expect(childSeen[0].messages).toStrictEqual([
            { role: 'user', content: 'child prompt' }
        ]);
    });

    it('rejects malformed attachments before mutating history or emitting events', async () => {
        const seen: HarnessStreamRequest[] = [];
        const events: HarnessEvent[] = [];
        const brain = agent({ model: 'm', stream: scripted([answer('never')], seen) });
        const writer = harness({
            agents: { writer: brain },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await expect(
            writer('bad', { attachments: [image({ size: 99 })] })
        ).rejects.toThrow('attachments[0].size is 99, but its data decodes to 12 bytes.');

        expect(seen).toEqual([]);
        expect(events).toEqual([]);
        expect(brain.messages).toEqual([]);
    });

    it('stores detached copies of the root attachments', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({ model: 'm', stream: scripted([answer('ok')], seen) });
        const writer = harness({ agents: { writer: brain }, presets: false });
        const input = image();

        await writer('See [Image 1]', { attachments: [input] });

        input.name = 'renamed.png';
        expect(brain.messages[0]).toStrictEqual({
            role: 'user',
            content: 'See [Image 1]',
            attachments: [image()]
        });
    });
});
