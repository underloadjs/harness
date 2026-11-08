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

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

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

        expect(withoutIds(snapshot.agents.writer.messages)).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] }
        ]);
    });

    it('keeps a text-only user message free of an attachments key', () => {
        const writer = session([{ role: 'user', content: 'plain' }]);

        expect(withoutIds(writer.snapshot().agents.writer.messages)).toStrictEqual([
            { role: 'user', content: 'plain' }
        ]);
    });

    it('restores attachments as detached copies', () => {
        const source = session([{ role: 'user', content: 'See [Image 1]', attachments: [image()] }]);
        const snapshot = source.snapshot();
        const target = session();

        target.restore(snapshot);

        expect(withoutIds(target.agent.messages)).toEqual([
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
        expect(withoutIds(source.snapshot().agents.writer.messages)).toEqual([
            { role: 'user', content: 'See [Image 1]', attachments: [image()] }
        ]);
    });

    // R3/R4: the same reader/writer pair also carries TOOL media (the `download`
    // hand-off). A pre-media snapshot has no `attachments` key on a tool message
    // and must keep restoring byte-for-byte; a media-bearing one must round-trip
    // with detached copies and the DOWNLOAD profile.
    it('records tool download media exactly and restores it detached', () => {
        const attachment = image({ id: 'dl-1', name: 'pixel.png' });
        const writer = session([
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'download', arguments: '{}' }]
            },
            { role: 'tool', content: '{"media":"attached"}', toolCallId: 'c1', name: 'download', attachments: [attachment] }
        ]);

        const snapshot = writer.snapshot();

        expect(withoutIds(snapshot.agents.writer.messages[1])).toEqual({
            role: 'tool',
            content: '{"media":"attached"}',
            toolCallId: 'c1',
            name: 'download',
            attachments: [attachment]
        });

        const target = session();
        target.restore(snapshot);

        const restored = target.agent.messages[1] as Extract<HarnessMessage, { role: 'tool' }>;
        expect(restored.attachments).toEqual([attachment]);
        expect(restored.attachments?.[0]).not.toBe(attachment);

        restored.attachments![0].data = 'AAAA';
        expect(withoutIds(writer.snapshot().agents.writer.messages[1])).toEqual({
            role: 'tool',
            content: '{"media":"attached"}',
            toolCallId: 'c1',
            name: 'download',
            attachments: [attachment]
        });
    });

    it('keeps a medialess tool message free of an attachments key', () => {
        const writer = session([
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
            { role: 'tool', content: 'text', toolCallId: 'c1', name: 'read' }
        ]);

        expect(withoutIds(writer.snapshot().agents.writer.messages[1])).toStrictEqual({
            role: 'tool',
            content: 'text',
            toolCallId: 'c1',
            name: 'read'
        });
        expect(JSON.stringify(writer.snapshot())).not.toContain('attachments');
    });

    it('measures a tool attachment against the download profile, not the upload one', () => {
        const fiveMeb = Buffer.alloc(5 * 1024 * 1024, 0x21);
        const media: HarnessAttachment = {
            id: 'dl-1',
            kind: 'file',
            marker: '[File 1]',
            name: 'payload.bin',
            mime: 'application/octet-stream',
            size: fiveMeb.byteLength,
            data: fiveMeb.toString('base64')
        };

        // Legal on a tool message: 5 MiB is below 20 MiB and above the 4 MiB
        // upload cap, which is exactly the split the two profiles encode.
        const writer = session([
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'download', arguments: '{}' }] },
            { role: 'tool', content: '{}', toolCallId: 'c1', name: 'download', attachments: [media] }
        ]);

        const target = session();
        target.restore(writer.snapshot());
        expect((target.agent.messages[1] as Extract<HarnessMessage, { role: 'tool' }>).attachments?.[0].size).toBe(
            5242880
        );

        // The identical bytes are still refused as a user upload.
        expect(() =>
            session([{ role: 'user', content: 'see [File 1]', attachments: [media] }]).snapshot()
        ).toThrow('attachments[0].data exceeds the 4194304-byte attachment limit.');
    });

    it('refuses a stored tool attachment whose bytes contradict its declared size', () => {
        const writer = session([
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'download', arguments: '{}' }] },
            {
                role: 'tool',
                content: '{}',
                toolCallId: 'c1',
                name: 'download',
                attachments: [image({ id: 'dl-1' })]
            }
        ]);

        // Corrupt the DOCUMENT the way a hand-edited or truncated state file
        // would: the restore reader must fail loudly with the message that names
        // the exact record, rather than resuming a transcript whose bytes lie
        // about their size.
        const corrupted = writer.snapshot();
        (corrupted.agents.writer.messages[1] as Extract<HarnessMessage, { role: 'tool' }>).attachments![0].size = 99;

        expect(() => session().restore(corrupted)).toThrow(
            'snapshot.agents["writer"].messages[1].attachments attachments[0].size is 99, but its data decodes to 12 bytes.'
        );

        // Seeding a transcript with the same broken payload fails the same way,
        // so a bad media record can never enter history at all.
        expect(() =>
            session([
                {
                    role: 'tool',
                    content: '{}',
                    toolCallId: 'c1',
                    name: 'download',
                    attachments: [image({ id: 'dl-1', size: 99 })]
                }
            ])
        ).toThrow('attachments[0].size is 99, but its data decodes to 12 bytes.');
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

        expect(withoutIds(target.agent.messages)).toStrictEqual([
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
