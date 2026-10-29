// core/snapshot.ts — attachment retention (R3).
//
// Pinned contract:
//   - snapshot() emits user attachments as JSON data exactly as committed;
//   - restore() re-validates them through the shared validator, deep-copies
//     them, and rejects a corrupt file before touching any state;
//   - a pre-attachment snapshot (role+content only) still restores unchanged.

import { describe, expect, it } from 'vitest';
import { HarnessError, agent, harness } from '@underload/harness';
import type {
    HarnessAttachment,
    HarnessMessage,
    HarnessSnapshot,
    HarnessStream,
    HarnessStreamEvent
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

// The scripted stream never runs in these tests; snapshot/restore do not call it.
const stream: HarnessStream = async function* (): AsyncGenerator<HarnessStreamEvent> {
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

const session = (messages?: HarnessMessage[]) =>
    harness({
        agents: {
            writer: agent({ model: 'm', messages, stream })
        },
        presets: false
    });

describe('snapshot attachments', () => {
    it('records user attachments exactly', () => {
        const writer = session([{ role: 'user', content: 'See [Image 1]', attachments: [image()] }]);

        const snapshot = writer.snapshot();

        expect(snapshot.agents.writer.messages).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] }
        ]);
    });

    it('keeps a text-only user message free of an attachments key', () => {
        const writer = session([{ role: 'user', content: 'plain' }]);

        expect(writer.snapshot().agents.writer.messages).toStrictEqual([
            { role: 'user', content: 'plain' }
        ]);
    });

    it('restores attachments as detached copies', () => {
        const source = session([{ role: 'user', content: 'See [Image 1]', attachments: [image()] }]);
        const snapshot = source.snapshot();
        const target = session();

        target.restore(snapshot);

        expect(target.agent.messages).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] }
        ]);

        // The restored transcript must not alias the snapshot value.
        const restored = target.agent.messages[0] as Extract<HarnessMessage, { role: 'user' }>;
        const snapshotUser = snapshot.agents.writer.messages[0] as Extract<
            HarnessMessage,
            { role: 'user' }
        >;
        expect(restored.attachments?.[0]).not.toBe(snapshotUser.attachments?.[0]);

        restored.attachments![0].data = 'AAAA';
        expect(source.snapshot().agents.writer.messages).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] }
        ]);
    });

    it('round-trips through JSON without loss', () => {
        const source = session([{ role: 'user', content: 'See [Image 1]', attachments: [image()] }]);
        const target = session();

        target.restore(JSON.parse(JSON.stringify(source.snapshot())) as HarnessSnapshot);

        expect(target.snapshot()).toEqual(source.snapshot());
    });

    it('restores a legacy snapshot that has no attachments field', () => {
        const source = session([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'plain' }
        ]);
        const legacy = JSON.parse(JSON.stringify(source.snapshot())) as HarnessSnapshot;
        const target = session();

        target.restore(legacy);

        expect(target.agent.messages).toStrictEqual([
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'plain' }
        ]);
    });

    it('rejects malformed attachment data before mutating the target', () => {
        const source = session([{ role: 'user', content: 'See [Image 1]', attachments: [image()] }]);
        const corrupt = JSON.parse(JSON.stringify(source.snapshot())) as HarnessSnapshot;
        const corruptUser = corrupt.agents.writer.messages[0] as Extract<HarnessMessage, { role: 'user' }>;
        corruptUser.attachments![0].size = 99;

        const target = session();

        expect(() => target.restore(corrupt)).toThrow(HarnessError);
        expect(() => target.restore(corrupt)).toThrow(
            'attachments[0].size is 99, but its data decodes to 12 bytes.'
        );
        expect(target.agent.messages).toEqual([]);
    });
});
