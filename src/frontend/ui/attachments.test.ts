// Composer attachment helpers (T5 clip/attach) — pure behavior.
//
// These pin the parts that must be deterministic without a browser: marker
// placement/spacing, first-match removal, per-kind numbering, the pre-read budget
// gate, MIME classification, base64 extraction, clipboard ordering, and the chip
// DOM contract (filename as text, no nested buttons).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/attachments.test.ts

import { expect, it } from 'vitest';
import {
    attachmentChipElement,
    attachmentFileName,
    attachmentKindOf,
    attachmentKindText,
    attachmentThumbnailUrl,
    attachmentPreviewUrl,
    base64OfDataUrl,
    clipboardFilesOf,
    createAttachmentCounters,
    insertAttachmentMarkers,
    nextAttachmentMarker,
    normalizeMime,
    planAttachmentBatch,
    releaseAttachmentPreview,
    removeAttachmentMarker
} from './attachments';

// Canonical base64 of the 12-byte PNG header used by the validator's signature
// check (89 50 4E 47 0D 0A 1A 0A 00 00 00 00).
const PNG_BASE64 = 'iVBORw0KGgoAAAAA';

it('normalizes MIME parameters and classifies known media, leaving the rest generic', () => {
    expect(normalizeMime('Image/PNG; charset=binary')).toBe('image/png');
    expect(normalizeMime(' application/pdf ')).toBe('application/pdf');
    expect(normalizeMime('')).toBe('application/octet-stream');
    expect(normalizeMime('not a mime')).toBe('application/octet-stream');

    expect(attachmentKindOf('image/png')).toBe('image');
    expect(attachmentKindOf('image/gif')).toBe('image');
    expect(attachmentKindOf('video/mp4')).toBe('video');
    expect(attachmentKindOf('video/quicktime')).toBe('video');
    expect(attachmentKindOf('audio/mpeg')).toBe('audio');
    expect(attachmentKindOf('application/pdf')).toBe('pdf');
    // Unknown (and deliberately unserializable-as-media) kinds stay representable
    // generic files; the transport refuses them later with an explicit error.
    expect(attachmentKindOf('image/svg+xml')).toBe('file');
    expect(attachmentKindOf('text/plain')).toBe('file');
    expect(attachmentKindOf('application/octet-stream')).toBe('file');

    expect(attachmentKindText('image')).toBe('Image');
    expect(attachmentKindText('video')).toBe('Video');
    expect(attachmentKindText('audio')).toBe('Audio');
    expect(attachmentKindText('pdf')).toBe('PDF');
    expect(attachmentKindText('file')).toBe('File');
});

it('keeps a usable visible filename for clipboard files with no name', () => {
    // Normal names pass through untouched.
    expect(attachmentFileName('shot.png', 'image/png', 1)).toBe('shot.png');
    // Path separators/colons are not representable: they become "_" rather than
    // failing the validator at read time.
    expect(attachmentFileName('C:\\tmp\\a:b.png', 'image/png', 1)).toBe('C__tmp_a_b.png');
    // An unnamed OS clipboard image gets a deterministic kind/index label.
    expect(attachmentFileName('', 'image/png', 3)).toBe('image-3.png');
    expect(attachmentFileName('   ', 'application/pdf', 2)).toBe('pdf-2.pdf');
    expect(attachmentFileName('', 'application/octet-stream', 4)).toBe('file-4.bin');
    // Bounded to the validator's 200-character name budget.
    expect(attachmentFileName('a'.repeat(250), 'image/png', 1)).toHaveLength(200);
});

it('inserts a marker at the caret with spacing only beside non-whitespace', () => {
    // The requested flow: type "Check this image for me " (trailing space), paste
    // an image -> the marker lands at the end with no doubled space.
    expect(insertAttachmentMarkers('Check this image for me ', { start: 24, end: 24 }, ['[Image 1]'])).toEqual({
        text: 'Check this image for me [Image 1]',
        caret: 33
    });

    // Mid-word: both sides are non-whitespace, so both sides get one space.
    expect(insertAttachmentMarkers('foobar', { start: 3, end: 3 }, ['[Image 1]'])).toEqual({
        text: 'foo [Image 1] bar',
        caret: 14
    });

    // A non-empty selection is replaced, exactly like a normal paste.
    expect(insertAttachmentMarkers('hello world', { start: 0, end: 5 }, ['[PDF 1]'])).toEqual({
        text: '[PDF 1] world',
        caret: 7
    });

    // Empty draft: the marker is the whole prompt (attachment-only turns).
    expect(insertAttachmentMarkers('', { start: 0, end: 0 }, ['[Image 1]'])).toEqual({
        text: '[Image 1]',
        caret: 9
    });

    // Several files in one paste stay in clipboard order, joined by one space.
    expect(insertAttachmentMarkers('x ', { start: 2, end: 2 }, ['[Image 1]', '[Video 1]'])).toEqual({
        text: 'x [Image 1] [Video 1]',
        caret: 21
    });

    // Out-of-range selections are clamped, never trusted blindly.
    expect(insertAttachmentMarkers('abc', { start: 99, end: 99 }, ['[File 1]'])).toEqual({
        text: 'abc [File 1]',
        caret: 12
    });

    // No markers is a no-op that still reports the (clamped) caret.
    expect(insertAttachmentMarkers('abc', { start: 1, end: 2 }, [])).toEqual({ text: 'abc', caret: 2 });
});

it('removes the FIRST marker and only the spacing it introduced', () => {
    expect(removeAttachmentMarker('Check this image for me [Image 1]', '[Image 1]')).toBe(
        'Check this image for me'
    );
    expect(removeAttachmentMarker('foo [Image 1] bar', '[Image 1]')).toBe('foo bar');
    expect(removeAttachmentMarker('[Image 1] text', '[Image 1]')).toBe('text');
    expect(removeAttachmentMarker('text [Video 1]', '[Video 1]')).toBe('text');
    expect(removeAttachmentMarker('[Image 1]', '[Image 1]')).toBe('');
    // A marker the user deleted by hand is a no-op (the chip is still removable).
    expect(removeAttachmentMarker('nothing here', '[Image 1]')).toBe('nothing here');

    // FIRST occurrence only: user-typed duplicates keep their other reference.
    expect(removeAttachmentMarker('a [Image 1] b [Image 1] c', '[Image 1]')).toBe('a b [Image 1] c');
});

it('numbers per kind monotonically and never renumbers after a removal', () => {
    const counters = createAttachmentCounters();

    expect(nextAttachmentMarker(counters, 'image')).toBe('[Image 1]');
    expect(nextAttachmentMarker(counters, 'image')).toBe('[Image 2]');
    expect(nextAttachmentMarker(counters, 'video')).toBe('[Video 1]');

    // Removal does not touch counters: the next image is 3, not a reused 1.
    expect(nextAttachmentMarker(counters, 'image')).toBe('[Image 3]');
    expect(nextAttachmentMarker(counters, 'pdf')).toBe('[PDF 1]');
    expect(nextAttachmentMarker(counters, 'audio')).toBe('[Audio 1]');
    expect(nextAttachmentMarker(counters, 'file')).toBe('[File 1]');
    expect(counters).toEqual({ image: 3, video: 1, audio: 1, pdf: 1, file: 1 });

    // A successful submission replaces the object with a fresh zeroed one.
    expect(createAttachmentCounters()).toEqual({ image: 0, video: 0, audio: 0, pdf: 0, file: 0 });
});

it('gates a batch atomically on count, per-file bytes and total bytes', () => {
    expect(planAttachmentBatch([], [])).toEqual({ ok: false, message: 'No files were found to attach.' });

    expect(
        planAttachmentBatch(
            [
                { name: 'a.png', mime: 'image/png', size: 10 },
                { name: 'b.mp4', mime: 'video/mp4', size: 20 },
                { name: 'c.pdf', mime: 'application/pdf', size: 30 }
            ],
            []
        )
    ).toEqual({
        ok: true,
        entries: [
            { kind: 'image', mime: 'image/png' },
            { kind: 'video', mime: 'video/mp4' },
            { kind: 'pdf', mime: 'application/pdf' }
        ]
    });

    // Five in one batch: rejected before any read, with the actionable count.
    const five = Array.from({ length: 5 }, (_, index) => ({
        name: `f${index}.bin`,
        mime: 'application/octet-stream',
        size: 1
    }));
    expect(planAttachmentBatch(five, [])).toEqual({
        ok: false,
        message: 'At most 4 files can be attached to one message (0 already attached).'
    });

    expect(planAttachmentBatch([{ name: 'f.bin', mime: '', size: 1 }], [{ size: 1 }, { size: 1 }, { size: 1 }, { size: 1 }])).toEqual({
        ok: false,
        message: 'At most 4 files can be attached to one message (4 already attached).'
    });

    expect(planAttachmentBatch([{ name: 'empty.png', mime: 'image/png', size: 0 }], [])).toEqual({
        ok: false,
        message: '"empty.png" is empty.'
    });

    // 4 MiB + 1 byte: the first byte over the per-file limit.
    expect(planAttachmentBatch([{ name: 'big.png', mime: 'image/png', size: 4 * 1024 * 1024 + 1 }], [])).toEqual({
        ok: false,
        message: '"big.png" is 4 MiB, above the 4 MiB per-file limit.'
    });

    // Three 3 MiB files are individually legal but total 9 MiB.
    expect(
        planAttachmentBatch(
            [
                { name: 'a.png', mime: 'image/png', size: 3 * 1024 * 1024 },
                { name: 'b.png', mime: 'image/png', size: 3 * 1024 * 1024 },
                { name: 'c.png', mime: 'image/png', size: 3 * 1024 * 1024 }
            ],
            []
        )
    ).toEqual({
        ok: false,
        message: 'The attached files total 9 MiB, above the 8 MiB per-message limit.'
    });

    // Existing draft bytes count toward the total as well.
    expect(
        planAttachmentBatch([{ name: 'b.png', mime: 'image/png', size: 3 * 1024 * 1024 }], [
            { size: 4 * 1024 * 1024 },
            { size: 2 * 1024 * 1024 }
        ])
    ).toEqual({
        ok: false,
        message: 'The attached files total 9 MiB, above the 8 MiB per-message limit.'
    });
});

it('extracts raw base64 from a FileReader data URL and rejects anything else', () => {
    expect(base64OfDataUrl('data:image/png;base64,AAAA')).toBe('AAAA');
    expect(base64OfDataUrl('data:application/pdf;base64,JVBERi0=')).toBe('JVBERi0=');
    expect(() => base64OfDataUrl('data:image/png,notbase64')).toThrow(
        'The browser did not return base64 file data.'
    );
    expect(() => base64OfDataUrl('AAAA')).toThrow('The browser did not return readable file data.');
});

it('takes clipboard files in items order and attaches each one exactly once', () => {
    const first = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' });
    const second = new File([new Uint8Array([2])], 'b.mp4', { type: 'video/mp4' });
    const textItem = { kind: 'string', getAsFile: () => null };

    const files = clipboardFilesOf({
        items: [
            { kind: 'file', getAsFile: () => first },
            textItem,
            { kind: 'file', getAsFile: () => second }
        ],
        // Browsers commonly expose the same Files here too; identity dedupe keeps
        // the batch at two.
        files: [first, second]
    });

    expect(files.map((file) => file.name)).toEqual(['a.png', 'b.mp4']);

    // A plain text clipboard has no files: the paste handler must leave it alone.
    expect(clipboardFilesOf({ items: [textItem], files: [] })).toEqual([]);
    expect(clipboardFilesOf(null)).toEqual([]);

    // A browser that only fills `files` (older engines) still works.
    expect(clipboardFilesOf({ files: [second] }).map((file) => file.name)).toEqual(['b.mp4']);
});

it('dedupes one clipboard entry across representations without dropping distinct files', () => {
    const stamp = 1_700_000_000_000;
    const make = (name: string, type: string): File =>
        new File([new Uint8Array([1, 2, 3])], name, { type, lastModified: stamp });

    // Chromium shape: `getAsFile()` and `files[i]` are DIFFERENT File objects for
    // the same clipboard entry (a fresh wrapper per access). Identity dedupe
    // attached one pasted image twice.
    const fromItem = make('image.png', 'image/png');
    const fromFiles = make('image.png', 'image/png');
    expect(fromItem).not.toBe(fromFiles);

    expect(
        clipboardFilesOf({
            items: [{ kind: 'file', getAsFile: () => fromItem }],
            files: [fromFiles]
        }).map((file) => file.name)
    ).toEqual(['image.png']);

    // Two genuinely distinct files that happen to share every fact still survive:
    // the item budget is a multiset, not a set.
    expect(
        clipboardFilesOf({
            items: [
                { kind: 'file', getAsFile: () => make('same.png', 'image/png') },
                { kind: 'file', getAsFile: () => make('same.png', 'image/png') }
            ],
            files: [make('same.png', 'image/png'), make('same.png', 'image/png')]
        }).map((file) => file.name)
    ).toEqual(['same.png', 'same.png']);

    // A `files` entry no item represents is a real additional file.
    expect(
        clipboardFilesOf({
            items: [{ kind: 'file', getAsFile: () => fromItem }],
            files: [fromFiles, make('notes.txt', 'text/plain')]
        }).map((file) => file.name)
    ).toEqual(['image.png', 'notes.txt']);

    // The dedupe scope is ONE clipboard payload: two paste gestures of the same
    // image are two intentional attachments.
    const payload = (): File[] =>
        clipboardFilesOf({
            items: [{ kind: 'file', getAsFile: () => make('image.png', 'image/png') }],
            files: [make('image.png', 'image/png')]
        });
    expect(payload().map((file) => file.name)).toEqual(['image.png']);
    expect(payload().map((file) => file.name)).toEqual(['image.png']);
});

it('collapses one clipboard entry whose representations disagree on lastModified', () => {
    // Chromium synthesizes 0 for an item copy and reports the real timestamp for the
    // `files` copy. A timestamp in the key made the budget miss and attached the
    // image twice; the key is name+MIME+size only.
    const synthesized = new File([new Uint8Array([1, 2, 3])], 'image.png', {
        type: 'image/png',
        lastModified: 0
    });
    const stamped = new File([new Uint8Array([1, 2, 3])], 'image.png', {
        type: 'image/png',
        lastModified: 1_700_000_000_000
    });

    expect(synthesized.lastModified).toBe(0);
    expect(stamped.lastModified).toBe(1_700_000_000_000);
    expect(
        clipboardFilesOf({
            items: [{ kind: 'file', getAsFile: () => synthesized }],
            files: [stamped]
        }).map((file) => file.name)
    ).toEqual(['image.png']);

    // Distinct entries that share every kept fact (and differ only in timestamps)
    // are still two attachments: the budget counts the item occurrences.
    expect(
        clipboardFilesOf({
            items: [
                { kind: 'file', getAsFile: () => new File([new Uint8Array([1])], 'copy.png', { type: 'image/png', lastModified: 1 }) },
                { kind: 'file', getAsFile: () => new File([new Uint8Array([1])], 'copy.png', { type: 'image/png', lastModified: 1 }) }
            ],
            files: [
                new File([new Uint8Array([1])], 'copy.png', { type: 'image/png', lastModified: 2 }),
                new File([new Uint8Array([1])], 'copy.png', { type: 'image/png', lastModified: 2 })
            ]
        }).map((file) => file.name)
    ).toEqual(['copy.png', 'copy.png']);

    // A same-named file with a different size stays a distinct attachment.
    expect(
        clipboardFilesOf({
            items: [{ kind: 'file', getAsFile: () => synthesized }],
            files: [stamped, new File([new Uint8Array([1, 2, 3, 4])], 'image.png', { type: 'image/png' })]
        }).map((file) => file.size)
    ).toEqual([3, 4]);
});

it('builds a chip whose visible label is the filename and whose remove control is not nested', () => {
    const removals: string[] = [];
    const chip = attachmentChipElement(
        { kind: 'pdf', marker: '[PDF 1]', name: 'report.pdf', mime: 'application/pdf' },
        { onRemove: () => removals.push('removed') }
    );

    expect(chip.tagName).toBe('DIV');
    expect(chip.className).toBe('attachment-chip');
    expect(chip.dataset.kind).toBe('pdf');
    expect(chip.getAttribute('role')).toBe('listitem');
    expect(chip.querySelector('.attachment-kind')?.textContent).toBe('PDF');
    expect(chip.querySelector('.attachment-marker')?.textContent).toBe('[PDF 1]');
    expect(chip.querySelector('.attachment-name')?.textContent).toBe('report.pdf');
    // No thumbnail for a document; the chip stays a filename/type badge.
    expect(chip.querySelector('img')).toBeNull();

    const remove = chip.querySelector<HTMLButtonElement>('.attachment-remove');
    expect(remove?.tagName).toBe('BUTTON');
    expect(remove?.type).toBe('button');
    expect(remove?.getAttribute('aria-label')).toBe('Remove report.pdf ([PDF 1])');
    // The chip itself is never a button, so no interactive element is nested.
    expect(chip.querySelector('button button')).toBeNull();
    expect(chip.querySelector('button')?.parentElement).toBe(chip);

    remove?.click();
    expect(removals).toEqual(['removed']);
});

it('marks a reading chip pending while keeping its remove control usable', () => {
    let removed = 0;
    const chip = attachmentChipElement(
        { kind: 'image', marker: '[Image 1]', name: 'shot.png', mime: 'image/png', pending: true },
        { onRemove: () => (removed += 1) }    );

    expect(chip.dataset.state).toBe('reading');
    const remove = chip.querySelector<HTMLButtonElement>('.attachment-remove');
    expect(remove?.disabled).toBe(false);
    // Cancelling a slow read must not leave dead UI: the click still fires.
    remove?.click();
    expect(removed).toBe(1);

    // jsdom implements URL.createObjectURL for Blobs, so the thumbnail exists and
    // is revoked on demand; a PDF never gets one.
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' });
    const preview = attachmentPreviewUrl(file, 'image');
    expect(preview?.startsWith('blob:')).toBe(true);
    releaseAttachmentPreview(preview);
    expect(attachmentPreviewUrl(file, 'pdf')).toBeUndefined();
});

it('builds a data-URL thumbnail only for recorded raster images', () => {
    const image = {
        id: 'a1',
        kind: 'image' as const,
        marker: '[Image 1]',
        name: 'shot.png',
        mime: 'image/png',
        size: 12,
        data: PNG_BASE64
    };
    expect(attachmentThumbnailUrl(image)).toBe(`data:image/png;base64,${PNG_BASE64}`);

    // PDF and generic files never render bytes as a thumbnail.
    expect(attachmentThumbnailUrl({ ...image, kind: 'pdf', marker: '[PDF 1]', mime: 'application/pdf' })).toBeUndefined();
    expect(attachmentThumbnailUrl({ ...image, kind: 'file', marker: '[File 1]', mime: 'text/plain' })).toBeUndefined();
    // SVG is scriptable and deliberately excluded.
    expect(attachmentThumbnailUrl({ ...image, mime: 'image/svg+xml' })).toBeUndefined();
    // A non-base64 payload never becomes an attribute.
    expect(attachmentThumbnailUrl({ ...image, data: 'not base64!' })).toBeUndefined();
});
