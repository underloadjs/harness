// core/tool-media.ts — the branded byte envelope a tool returns (R3/R4).
//
// Pinned contract:
//   - an ordinary value unwraps to `{ content }` and NOTHING else (every
//     standard tool stays byte-for-byte stable at the delivery boundary);
//   - `toolMedia()` validates with the 20 MiB DOWNLOAD profile and returns
//     detached copies;
//   - an invalid envelope is REJECTED with a `Cannot attach tool media:` prefix
//     (never a silent drop), including one built by hand;
//   - the event projection is id/kind/name/mime/size only — no base64;
//   - `unwrapToolResult` peels media and panels in either nesting order.

import { describe, expect, it } from 'vitest';
import { toolMedia, toolMediaDescriptors, toolMediaOf, toolUi, unwrapToolResult } from '@underload/harness';
// The profiles are the shared validator's own surface (`@underload/harness/shared`
// is how every other attachment test reaches them).
import { DOWNLOAD_ATTACHMENT_LIMITS, MAX_DOWNLOAD_ATTACHMENT_BYTES } from '@underload/harness/shared';
import type { HarnessAttachment, ToolUiPanel } from '@underload/harness';

const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
const PNG_DATA = base64(PNG_BYTES);

const image = (overrides: Partial<HarnessAttachment> = {}): HarnessAttachment => ({
    id: 'dl-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'pixel.png',
    mime: 'image/png',
    size: PNG_BYTES.length,
    data: PNG_DATA,
    ...overrides
});

const panel: ToolUiPanel = {
    id: 'p1',
    slot: 'right',
    title: 'Panel',
    blocks: [{ type: 'text', text: 'body' }]
};

describe('toolMedia', () => {
    it('quotes one shared download profile', () => {
        expect(MAX_DOWNLOAD_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
        expect(DOWNLOAD_ATTACHMENT_LIMITS).toEqual({
            perAttachmentBytes: 20 * 1024 * 1024,
            totalBytes: 83886080,
            count: 4
        });
    });

    it('returns the branded envelope with the content untouched', () => {
        const envelope = toolMedia({ ok: true }, [image()]);

        expect(envelope).toEqual({
            __toolMedia: [image()],
            content: { ok: true }
        });
    });

    it('detaches the attachments it was handed', () => {
        const source = image();
        const envelope = toolMedia({ ok: true }, [source]);

        source.name = 'mutated.png';

        expect(envelope.__toolMedia[0].name).toBe('pixel.png');
        expect(envelope.__toolMedia[0]).not.toBe(source);
    });

    it('accepts a file above the 4 MiB upload cap', () => {
        const bytes = Buffer.alloc(5 * 1024 * 1024, 0x21);
        const big: HarnessAttachment = {
            id: 'dl-1',
            kind: 'file',
            marker: '[File 1]',
            name: 'big.bin',
            mime: 'application/octet-stream',
            size: bytes.byteLength,
            data: bytes.toString('base64')
        };

        const envelope = toolMedia({ bytes: big.size }, [big]);

        expect(envelope.__toolMedia[0].size).toBe(5242880);
        expect(envelope.__toolMedia[0].data.length).toBe(6990508);
    });

    it('rejects a file above 20 MiB against RAW bytes', () => {
        const bytes = Buffer.alloc(MAX_DOWNLOAD_ATTACHMENT_BYTES + 1, 0x21);

        expect(() =>
            toolMedia({ ok: true }, [
                {
                    id: 'dl-1',
                    kind: 'file',
                    marker: '[File 1]',
                    name: 'huge.bin',
                    mime: 'application/octet-stream',
                    size: bytes.byteLength,
                    data: bytes.toString('base64')
                }
            ])
        ).toThrow(
            'Cannot attach tool media: attachments[0].data is 20971521 bytes, above the 20971520-byte attachment limit.'
        );
    });

    it('rejects a size that disagrees with the bytes', () => {
        expect(() => toolMedia({ ok: true }, [image({ size: PNG_BYTES.length + 1 })])).toThrow(
            'Cannot attach tool media: attachments[0].size is 13, but its data decodes to 12 bytes.'
        );
    });

    it('rejects a known kind whose bytes do not match the MIME', () => {
        expect(() =>
            toolMedia({ ok: true }, [image({ data: base64([1, 2, 3, 4]), size: 4 })])
        ).toThrow(
            'Cannot attach tool media: attachments[0].data does not match its declared MIME "image/png" (magic signature mismatch).'
        );
    });

    it('keeps an empty media list legal (the caller then commits no attachments)', () => {
        expect(toolMedia({ ok: true }, [])).toEqual({ __toolMedia: [], content: { ok: true } });
    });
});

describe('toolMediaOf', () => {
    it('returns undefined for every ordinary value', () => {
        for (const value of ['text', 42, null, undefined, { content: 'x' }, [{ a: 1 }]]) {
            expect(toolMediaOf(value)).toBeUndefined();
        }
    });

    it('treats a brand without content as no envelope', () => {
        expect(toolMediaOf({ __toolMedia: [image()] })).toBeUndefined();
    });

    it('unwraps a hand-built envelope after re-validating it', () => {
        const forged = { __toolMedia: [image()], content: { ok: true } };

        expect(toolMediaOf(forged)).toEqual({ content: { ok: true }, media: [image()] });
    });

    it('rejects a forged oversized envelope instead of dropping it', () => {
        const bytes = Buffer.alloc(MAX_DOWNLOAD_ATTACHMENT_BYTES + 2, 7);
        const forged = {
            __toolMedia: [
                {
                    id: 'dl-1',
                    kind: 'file',
                    marker: '[File 1]',
                    name: 'huge.bin',
                    mime: 'application/octet-stream',
                    size: bytes.byteLength,
                    data: bytes.toString('base64')
                }
            ],
            content: { ok: true }
        };

        expect(() => toolMediaOf(forged)).toThrow(
            'Cannot attach tool media: attachments[0].data is 20971522 bytes, above the 20971520-byte attachment limit.'
        );
    });

    it('rejects more than four attachments in one list', () => {
        const five = [1, 2, 3, 4, 5].map((index) =>
            image({ id: `dl-${String(index)}`, marker: `[Image ${String(index)}]` })
        );

        expect(() => toolMediaOf({ __toolMedia: five, content: {} })).toThrow(
            'Cannot attach tool media: attachments may contain at most 4 entries; received 5.'
        );
    });
});

describe('toolMediaDescriptors', () => {
    it('projects identity and size only, never the bytes', () => {
        expect(toolMediaDescriptors([image()])).toEqual([
            { id: 'dl-1', kind: 'image', name: 'pixel.png', mime: 'image/png', size: 12 }
        ]);

        expect(JSON.stringify(toolMediaDescriptors([image()]))).not.toContain(PNG_DATA);
    });
});

describe('unwrapToolResult', () => {
    it('leaves a plain value alone and reports neither brand', () => {
        expect(unwrapToolResult({ a: 1 })).toEqual({ content: { a: 1 } });
    });

    it('unwraps a toolUi envelope with media absent', () => {
        expect(unwrapToolResult(toolUi({ a: 1 }, [panel]))).toEqual({
            content: { a: 1 },
            panels: [panel]
        });
    });

    it('unwraps media with panels absent', () => {
        expect(unwrapToolResult(toolMedia({ a: 1 }, [image()]))).toEqual({
            content: { a: 1 },
            media: [image()]
        });
    });

    it('peels both brands in either nesting order', () => {
        const expected = { content: { a: 1 }, panels: [panel], media: [image()] };

        expect(unwrapToolResult(toolMedia(toolUi({ a: 1 }, [panel]), [image()]))).toEqual(expected);
        expect(unwrapToolResult(toolUi(toolMedia({ a: 1 }, [image()]), [panel]))).toEqual(expected);
    });

    it('keeps an unrenderable panel list as an empty array (not absent)', () => {
        const unwrapped = unwrapToolResult(toolUi({ a: 1 }, [{ id: '', slot: '', title: '', blocks: [] }]));

        expect(unwrapped.panels).toEqual([]);
        expect(Object.prototype.hasOwnProperty.call(unwrapped, 'media')).toBe(false);
    });
});
