// shared/attachments.ts — the single attachment validator.
//
// Pinned contract:
//   - undefined -> [] (text-only turns are unchanged);
//   - valid entries become DETACHED copies (never the caller's objects);
//   - every limit and grammar is enforced exactly: count, per-file bytes,
//     total bytes, id/marker uniqueness, marker grammar, MIME/kind agreement,
//     canonical base64, decoded size agreement, and magic signatures;
//   - paths and URLs are not representable;
//   - an unknown `file` kind is representable but never transportable (the
//     transport test owns that refusal).
//
// Fixtures below are real magic-byte prefixes, base64-encoded once so each test
// asserts the validator's exact returned value rather than a fuzzy shape.

import { describe, expect, it } from 'vitest';
import {
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_TURN,
    MAX_SUBMIT_BODY_BYTES,
    MAX_TOTAL_ATTACHMENT_BYTES,
    attachmentMarker,
    validateAttachments
} from '@underload/harness/shared';
import type { HarnessAttachment } from '@underload/harness';

const base64 = (bytes: readonly number[]): string => Buffer.from(bytes).toString('base64');
const ascii = (text: string): number[] => text.split('').map((character) => character.charCodeAt(0));

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46];
const GIF_BYTES = [...ascii('GIF89a'), 0, 0, 0, 0];
const WEBP_BYTES = [...ascii('RIFF'), 0x0c, 0, 0, 0, ...ascii('WEBP')];
const PDF_BYTES = ascii('%PDF-1.4\n');
const WAV_BYTES = [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVE')];
const MP3_BYTES = [...ascii('ID3'), 0x04, 0, 0, 0, 0, 0, 0];
const MP4_BYTES = [0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('isom')];
const WEBM_BYTES = [0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0];
const OGG_BYTES = [...ascii('OggS'), 0, 0, 0, 0];

const PNG_DATA = base64(PNG_BYTES);
const JPEG_DATA = base64(JPEG_BYTES);
const PDF_DATA = base64(PDF_BYTES);
const WAV_DATA = base64(WAV_BYTES);
const MP3_DATA = base64(MP3_BYTES);
const MP4_DATA = base64(MP4_BYTES);
const WEBM_DATA = base64(WEBM_BYTES);
const OGG_DATA = base64(OGG_BYTES);
const GIF_DATA = base64(GIF_BYTES);
const WEBP_DATA = base64(WEBP_BYTES);

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

describe('constants', () => {
    it('exposes the frozen limits', () => {
        expect(MAX_ATTACHMENTS_PER_TURN).toBe(4);
        expect(MAX_ATTACHMENT_BYTES).toBe(4 * 1024 * 1024);
        expect(MAX_TOTAL_ATTACHMENT_BYTES).toBe(8 * 1024 * 1024);
        expect(MAX_SUBMIT_BODY_BYTES).toBe(16 * 1024 * 1024);
    });
});

describe('attachmentMarker', () => {
    it('builds the exact grammar per kind', () => {
        expect(attachmentMarker('image', 1)).toBe('[Image 1]');
        expect(attachmentMarker('video', 2)).toBe('[Video 2]');
        expect(attachmentMarker('audio', 3)).toBe('[Audio 3]');
        expect(attachmentMarker('pdf', 4)).toBe('[PDF 4]');
        expect(attachmentMarker('file', 5)).toBe('[File 5]');
    });

    it('allows the PDF/File alias only for pdf', () => {
        expect(attachmentMarker('pdf', 2, 'File')).toBe('[File 2]');
        expect(() => attachmentMarker('image', 1, 'PDF')).toThrow(
            'Attachment marker label "PDF" is not valid for kind "image".'
        );
    });

    it('rejects a non-positive index', () => {
        expect(() => attachmentMarker('image', 0)).toThrow(
            'Attachment marker index must be a positive safe integer; received 0.'
        );
    });
});

describe('validateAttachments', () => {
    it('returns [] for undefined, the text-only call', () => {
        expect(validateAttachments(undefined)).toEqual([]);
    });

    it('accepts an empty list', () => {
        expect(validateAttachments([])).toEqual([]);
    });

    it('accepts each supported kind and returns detached copies', () => {
        const entries: HarnessAttachment[] = [
            image(),
            image({ id: 'img-2', marker: '[Image 2]', name: 'photo.jpg', mime: 'image/jpeg', size: JPEG_BYTES.length, data: JPEG_DATA }),
            image({ id: 'img-3', marker: '[Image 3]', name: 'anim.gif', mime: 'image/gif', size: GIF_BYTES.length, data: GIF_DATA }),
            image({ id: 'img-4', marker: '[Image 4]', name: 'shot.webp', mime: 'image/webp', size: WEBP_BYTES.length, data: WEBP_DATA })
        ];
        const result = validateAttachments(entries);

        expect(result).toEqual(entries);
        expect(result[0]).not.toBe(entries[0]);
    });

    it('accepts video, audio, pdf, and unknown file kinds', () => {
        const media: HarnessAttachment[] = [
            image({ id: 'v1', kind: 'video', marker: '[Video 1]', name: 'clip.mp4', mime: 'video/mp4', size: MP4_BYTES.length, data: MP4_DATA }),
            image({ id: 'v2', kind: 'video', marker: '[Video 2]', name: 'clip.webm', mime: 'video/webm', size: WEBM_BYTES.length, data: WEBM_DATA }),
            image({ id: 'v3', kind: 'video', marker: '[Video 3]', name: 'clip.ogv', mime: 'video/ogg', size: OGG_BYTES.length, data: OGG_DATA }),
            image({ id: 'a1', kind: 'audio', marker: '[Audio 1]', name: 'take.wav', mime: 'audio/wav', size: WAV_BYTES.length, data: WAV_DATA })
        ];
        const documents: HarnessAttachment[] = [
            image({ id: 'a2', kind: 'audio', marker: '[Audio 2]', name: 'take.mp3', mime: 'audio/mpeg', size: MP3_BYTES.length, data: MP3_DATA }),
            image({ id: 'p1', kind: 'pdf', marker: '[PDF 1]', name: 'paper.pdf', mime: 'application/pdf', size: PDF_BYTES.length, data: PDF_DATA }),
            image({ id: 'p2', kind: 'pdf', marker: '[File 1]', name: 'paper2.pdf', mime: 'application/pdf', size: PDF_BYTES.length, data: PDF_DATA }),
            image({ id: 'f1', kind: 'file', marker: '[File 2]', name: 'archive.zip', mime: 'application/zip', size: 4, data: base64([0x50, 0x4b, 0x03, 0x04]) })
        ];

        expect(validateAttachments(media)).toEqual(media);
        expect(validateAttachments(documents)).toEqual(documents);
    });

    it('rejects a non-array value', () => {
        expect(() => validateAttachments('nope')).toThrow('attachments must be an array.');
        expect(() => validateAttachments(null)).toThrow('attachments must be an array.');
    });

    it('rejects more than the per-turn count', () => {
        const entries = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 1 }, (_, index) =>
            image({ id: `id-${index}`, marker: `[Image ${index + 1}]` })
        );

        expect(() => validateAttachments(entries)).toThrow(
            'attachments may contain at most 4 entries; received 5.'
        );
    });

    it('rejects duplicate ids and duplicate markers', () => {
        expect(() => validateAttachments([image(), image({ marker: '[Image 2]' })])).toThrow(
            'attachments contain the duplicate id "img-1".'
        );

        expect(() => validateAttachments([image(), image({ id: 'img-2' })])).toThrow(
            'attachments contain the duplicate marker "[Image 1]".'
        );
    });

    it('rejects a missing field and an unknown field', () => {
        const missing = { ...image() } as Record<string, unknown>;
        delete missing.data;

        expect(() => validateAttachments([missing])).toThrow(
            'attachments[0] is missing the field "data".'
        );
        expect(() => validateAttachments([{ ...image(), extra: true }])).toThrow(
            'attachments[0] has an unknown field "extra".'
        );
    });

    it('rejects a non-object entry', () => {
        expect(() => validateAttachments([null])).toThrow('attachments[0] must be an object.');
        expect(() => validateAttachments([[]])).toThrow('attachments[0] must be an object.');
    });

    it('rejects ids and names that could be paths or URLs', () => {
        expect(() => validateAttachments([image({ id: 'bad id' })])).toThrow(
            'attachments[0].id must be a non-empty printable id of at most 100 characters.'
        );
        expect(() => validateAttachments([image({ name: 'C:\\tmp\\pixel.png' })])).toThrow(
            'attachments[0].name must be a plain file name (no path separators or URL scheme).'
        );
        expect(() => validateAttachments([image({ name: 'https://example.com/pixel.png' })])).toThrow(
            'attachments[0].name must be a plain file name (no path separators or URL scheme).'
        );
    });

    it('rejects an unknown kind and a marker/kind mismatch', () => {
        expect(() => validateAttachments([{ ...image(), kind: 'document' }])).toThrow(
            'attachments[0].kind must be one of: image, video, audio, pdf, file.'
        );
        expect(() => validateAttachments([image({ marker: '[Video 1]' })])).toThrow(
            'attachments[0].marker "[Video 1]" does not match kind "image".'
        );
        expect(() => validateAttachments([image({ marker: 'Image 1' })])).toThrow(
            'attachments[0].marker must match the pattern "[Image 1]" (also Video, Audio, PDF, File).'
        );
    });

    it('rejects a MIME/kind mismatch and a MIME with parameters', () => {
        expect(() => validateAttachments([image({ mime: 'application/pdf' })])).toThrow(
            'attachments[0].mime "application/pdf" is not valid for kind "image".'
        );
        expect(() => validateAttachments([image({ mime: 'image/png;charset=utf-8' })])).toThrow(
            'attachments[0].mime must be a lowercase MIME type without parameters.'
        );
    });

    it('rejects non-canonical base64', () => {
        const canonical = 'attachments[0].data must be canonical base64 (no data: prefix or whitespace).';

        expect(() => validateAttachments([image({ data: `data:image/png;base64,${PNG_DATA}`, size: PNG_BYTES.length })])).toThrow(canonical);
        expect(() => validateAttachments([image({ data: `${PNG_DATA.slice(0, 4)} ${PNG_DATA.slice(4)}`, size: PNG_BYTES.length })])).toThrow(canonical);
        expect(() =>
            validateAttachments([
                image({
                    kind: 'file',
                    marker: '[File 1]',
                    name: 'archive.zip',
                    mime: 'application/zip',
                    data: 'AA-A',
                    size: 3
                })
            ])
        ).toThrow(canonical);
        expect(() => validateAttachments([image({ data: 'A', size: 1 })])).toThrow(canonical);
        expect(() => validateAttachments([image({ data: '', size: 1 })])).toThrow(
            'attachments[0].data must be non-empty raw base64 text.'
        );
    });

    // A decoder ignores the unused low bits of the final data character, so
    // 'AB==' and 'AAB=' decode exactly like 'AA==' and 'AAA='. Canonical-only
    // means rejecting them: one payload must have one encoding (snapshots,
    // dedupe, and equality all rely on that).
    it('accepts canonical padded tails', () => {
        const oneByte = image({
            kind: 'file',
            marker: '[File 1]',
            name: 'one.bin',
            mime: 'application/octet-stream',
            data: 'AA==',
            size: 1
        });
        const twoBytes = image({
            kind: 'file',
            marker: '[File 1]',
            name: 'two.bin',
            mime: 'application/octet-stream',
            data: 'AAA=',
            size: 2
        });

        expect(validateAttachments([oneByte])).toEqual([oneByte]);
        expect(validateAttachments([twoBytes])).toEqual([twoBytes]);
    });

    it('rejects non-zero discarded tail bits', () => {
        const canonical = 'attachments[0].data must be canonical base64 (no data: prefix or whitespace).';
        const paddedOneByte = (data: string) =>
            image({
                kind: 'file',
                marker: '[File 1]',
                name: 'one.bin',
                mime: 'application/octet-stream',
                data,
                size: 1
            });
        const paddedTwoBytes = (data: string) =>
            image({
                kind: 'file',
                marker: '[File 1]',
                name: 'two.bin',
                mime: 'application/octet-stream',
                data,
                size: 2
            });

        expect(() => validateAttachments([paddedOneByte('AB==')])).toThrow(canonical);
        expect(() => validateAttachments([paddedTwoBytes('AAB=')])).toThrow(canonical);
    });

    // Hostile lengths are rejected before any regex/echo, so the error is a
    // short fixed message rather than a copy of the payload.
    it('bounds MIME and marker lengths before echoing them', () => {
        const longMime = `application/x-${'a'.repeat(50_000)}`;
        const longMarker = `[Image ${'1'.repeat(50_000)}]`;

        expect(() =>
            validateAttachments([
                image({
                    kind: 'file',
                    marker: '[File 1]',
                    name: 'long.bin',
                    mime: longMime,
                    data: 'AA==',
                    size: 1
                })
            ])
        ).toThrow('attachments[0].mime must be at most 128 characters.');

        expect(() => validateAttachments([image({ marker: longMarker })])).toThrow(
            'attachments[0].marker must be at most 32 characters.'
        );
    });

    it('rejects a marker index beyond a safe integer', () => {
        expect(() =>
            validateAttachments([image({ marker: '[Image 99999999999999999999]' })])
        ).toThrow('attachments[0].marker index is too large.');
    });

    it('rejects a size that disagrees with the decoded bytes', () => {
        expect(() => validateAttachments([image({ size: 99 })])).toThrow(
            'attachments[0].size is 99, but its data decodes to 12 bytes.'
        );
    });

    it('rejects a magic-signature mismatch', () => {
        expect(() => validateAttachments([image({ data: JPEG_DATA, size: JPEG_BYTES.length })])).toThrow(
            'attachments[0].data does not match its declared MIME "image/png" (magic signature mismatch).'
        );
        expect(() =>
            validateAttachments([
                image({ id: 'w', kind: 'audio', marker: '[Audio 1]', name: 'take.wav', mime: 'audio/wav', data: base64(ascii('notawav')), size: ascii('notawav').length })
            ])
        ).toThrow('attachments[0].data does not match its declared MIME "audio/wav" (magic signature mismatch).');
    });

    it('rejects one attachment above the per-file byte limit', () => {
        // Canonical base64 of zero bytes: padding-free groups decode 3 bytes per
        // 4 characters, so this is the smallest string that exceeds the limit.
        const decoded = Math.ceil((MAX_ATTACHMENT_BYTES + 1) / 3) * 3;
        const data = 'A'.repeat((decoded / 3) * 4);

        expect(() => validateAttachments([image({ data, size: decoded })])).toThrow(
            `attachments[0].data is ${decoded} bytes, above the ${MAX_ATTACHMENT_BYTES}-byte attachment limit.`
        );
    });

    it('rejects a turn above the total byte limit', () => {
        // Three ~3 MiB images: each is legal, the sum is not.
        const chunkBytes = 3 * 1024 * 1024;
        const prefix = Buffer.from(PNG_BYTES);
        const payload = Buffer.concat([prefix, Buffer.alloc(chunkBytes - prefix.length)]);
        const data = payload.toString('base64');
        const size = payload.length;
        const entries = [1, 2, 3].map((index) =>
            image({ id: `img-${index}`, marker: `[Image ${index}]`, data, size })
        );

        expect(() => validateAttachments(entries)).toThrow(
            `attachments total ${size * 3} bytes, above the ${MAX_TOTAL_ATTACHMENT_BYTES}-byte per-turn limit.`
        );
    });
});
