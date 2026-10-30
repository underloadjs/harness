// Attachment preview dialog (R10/R11).
//
// Clicking an inline transcript attachment chip opens ONE reusable modal
// (ui/dialog.ts). This module builds that content from a recorded
// `HarnessAttachment`; it never renders the base64 payload and never creates a
// scriptable media source.
//
// SAFE SOURCES
// ------------
//   - Images: `attachmentThumbnailUrl` only (ui/attachments.ts). It accepts the
//     raster MIME allow-list and canonical base64, so SVG/HTML (scriptable) and
//     malformed data never become an <img> source.
//   - Everything else: metadata only (kind, name, MIME, decoded size) plus an
//     optional download through a Blob. The payload stays out of the DOM text.
//   - The download path is best-effort: a runtime without Blob/atob/object URLs
//     gets a disabled control with a short explanation instead of an error.
//
// ASYNC/CLOSE
// -----------
// Building the preview is synchronous for recorded attachments (the bytes travel
// with the record), so there is no late-result race here. The download revokes its
// object URL on the next tick. A caller that closes the dialog immediately is
// safe: the dialog owns the DOM and removes it.
//
// FOCUS
// -----
// No focus destination is forced. ui/dialog.ts captures the chip that was focused
// at open time and restores it on close; it never falls back to the composer.
//
// Cross-references:
//   - chip builder: ./attachments.ts (`attachmentInlineChipElement`)
//   - modal shell: ./dialog.ts (styles: ./dialog.css, imported by styles.css)
//   - attachment type/validation: ../../types, ../../shared/attachments
//   - styles: src/frontend/styles.css (`.preview-*`)

import type { HarnessAttachment } from '../../types';
import { attachmentKindText, attachmentThumbnailUrl } from './attachments';
import { openDialog } from './dialog';
import type { DialogHandle } from './dialog';

export type AttachmentPreviewOptions = {
    // Explicit focus destination for ui/dialog.ts. Undefined keeps the dialog's
    // default (restore whatever was focused at open time).
    returnFocus?: HTMLElement | null;
};// Human-readable size, in the units the attachment limits use. Integer KiB/MiB
// keeps the metadata stable across browsers.
const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    if (bytes < 1024) return `${Math.trunc(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

// Decode canonical base64 to bytes for a Blob. Validation already happened in
// shared/attachments.ts; this is only a transport convenience, so a runtime
// without `atob` simply cannot offer the download.
const bytesOfBase64 = (data: string): Uint8Array | undefined => {
    if (typeof atob !== 'function') return undefined;

    try {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        return bytes;
    } catch {
        return undefined;
    }
};

// True when this runtime can hand a Blob to the user as a download. A file with
// no representable bytes keeps its metadata and loses only the button.
const canDownload = (attachment: HarnessAttachment): boolean =>
    typeof Blob === 'function' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    bytesOfBase64(attachment.data) !== undefined;

// Start the download and release the object URL on the next tick. The anchor is
// never inserted into the document; `download` names the file exactly as the
// attachment record did (plain name, already validated).
const downloadAttachment = (attachment: HarnessAttachment): void => {
    const bytes = bytesOfBase64(attachment.data);
    if (bytes === undefined) return;

    // Copy the exact view into a plain ArrayBuffer: BlobPart rejects the shared
    // ArrayBufferLike type, and this also detaches the Blob from any later reuse.
    const payload = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(payload).set(bytes);

    const url = URL.createObjectURL(new Blob([payload], { type: attachment.mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = attachment.name;
    anchor.rel = 'noopener';
    anchor.click();

    // Revoking synchronously can abort the download in some browsers; one tick is
    // enough for the click to be consumed and keeps the URL from leaking.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

// Metadata list. Defined as <dl> so assistive technology reads label/value pairs;
// every value is textContent.
const metadataList = (attachment: HarnessAttachment): HTMLElement => {
    const list = document.createElement('dl');
    list.className = 'preview-meta preview-facts';

    const row = (label: string, value: string): void => {
        const term = document.createElement('dt');
        term.textContent = label;
        const detail = document.createElement('dd');
        detail.textContent = value;
        list.append(term, detail);
    };

    row('File', attachment.name);
    row('Kind', attachmentKindText(attachment.kind));
    row('MIME', attachment.mime);
    row('Size', formatBytes(attachment.size));
    return list;
};

// One action button. Real button, keyboard-activatable, labelled by its text.
const downloadButton = (attachment: HarnessAttachment): HTMLButtonElement | undefined => {
    if (!canDownload(attachment)) return undefined;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preview-download';
    button.textContent = 'Download';
    button.setAttribute('aria-label', `Download ${attachment.name}`);
    button.addEventListener('click', () => downloadAttachment(attachment));
    return button;
};

// Build the dialog content. The image branch renders a fitted full preview; every
// other kind exposes safe metadata (and a download where supported) rather than
// activating a PDF/audio/video viewer with an untrusted data URL.
export const attachmentPreviewContent = (attachment: HarnessAttachment): HTMLElement => {
    const host = document.createElement('div');
    host.className = 'preview preview-attachment';
    host.dataset.kind = attachment.kind;

    const image = attachmentThumbnailUrl(attachment);
    if (image !== undefined) {
        const figure = document.createElement('figure');
        figure.className = 'preview-image';
        const img = document.createElement('img');
        img.alt = attachment.name;
        img.src = image;
        // No referrer/tracking channel; the record is local data already.
        img.referrerPolicy = 'no-referrer';
        figure.append(img, metadataList(attachment));
        host.append(figure);
    } else {
        host.append(metadataList(attachment));
        // Explicit note for an image kind that cannot be shown safely (e.g. a MIME
        // that is not on the raster allow-list). No broken <img> is left behind.
        if (attachment.kind === 'image') {
            const note = document.createElement('p');
            note.className = 'preview-note';
            note.textContent = 'This image type is not previewed inline for safety.';
            host.append(note);
        }
    }

    const download = downloadButton(attachment);
    if (download !== undefined) {
        const actions = document.createElement('div');
        actions.className = 'preview-actions';
        actions.append(download);
        host.append(actions);
    } else {
        const note = document.createElement('p');
        note.className = 'preview-note';
        note.textContent = 'This browser cannot offer a download for this attachment.';
        host.append(note);
    }

    return host;
};

// Open the attachment preview. `title` is the plain filename (textContent inside
// ui/dialog.ts), never the marker/payload.
export const openAttachmentDialog = (
    attachment: HarnessAttachment,
    options: AttachmentPreviewOptions = {}
): DialogHandle =>
    openDialog({
        title: attachment.name,
        content: attachmentPreviewContent(attachment),
        ...(options.returnFocus === undefined ? {} : { returnFocus: options.returnFocus })
    });

// ---------------------------------------------------------------------------
// Markdown images (transcript `![alt](src)`)
// ---------------------------------------------------------------------------
//
// Clicking an image in the transcript opens the same modal instead of navigating.
// The source was already sanitized by markdown.ts; this module re-checks it anyway
// before putting it in a dialog, so a caller that builds DOM by hand cannot turn
// `javascript:` or `data:image/svg+xml` into an active preview.

// Safe image sources: http(s), same-origin/relative paths, and base64 raster data
// URLs. SVG/HTML data URLs and every non-http scheme are refused.
export const safeImageSource = (raw: string): string | undefined => {
    const value = raw.trim();
    if (value.length === 0) return undefined;
    if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;

    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
        if (/^https?:/i.test(value)) return value;
        if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) return value;
        return undefined;
    }

    // Protocol-relative is still an image load, never script; relative paths are
    // resolved by the browser against the page URL.
    return value;
};

export type ImagePreviewOptions = {
    alt?: string;
    returnFocus?: HTMLElement | null;
};

// Content for a full image preview. The image is a CLONE in the caller, so the
// dialog never steals the transcript's node; this builder makes its own element.
export const imagePreviewContent = (source: string, alt = ''): HTMLElement => {
    const host = document.createElement('div');
    host.className = 'preview preview-image-only';

    const safe = safeImageSource(source);
    if (safe === undefined) {
        const error = document.createElement('div');
        error.className = 'preview-error';
        error.textContent = 'This image source is not safe to preview.';
        host.append(error);
        return host;
    }

    const figure = document.createElement('figure');
    figure.className = 'preview-image';
    const img = document.createElement('img');
    img.src = safe;
    img.alt = alt;
    img.referrerPolicy = 'no-referrer';
    figure.append(img);
    host.append(figure);
    return host;
};

// Open a transcript image in the shared dialog. The title is the alt text, or a
// neutral word when the image is decorative.
export const openImageDialog = (source: string, options: ImagePreviewOptions = {}): DialogHandle =>
    openDialog({
        title: (options.alt ?? '').trim().length > 0 ? (options.alt ?? '').trim() : 'Image',
        content: imagePreviewContent(source, options.alt ?? ''),
        ...(options.returnFocus === undefined ? {} : { returnFocus: options.returnFocus })
    });

export type ImageLinkOptions = {
    // Called on click/Enter/Space with the image source and alt text.
    open: (source: string, alt: string) => void;
};

// Wrap each Markdown image in a real <button> (keyboard-activatable, announced as
// a dialog trigger). Images already inside a link/button are left alone, and the
// image element itself is reused so lazy loading/no-referrer attributes survive.
export const enhanceImages = (root: ParentNode, options: ImageLinkOptions): number => {
    let count = 0;

    for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
        if (image.closest('button, a, .image-link') !== null) continue;

        const source = image.getAttribute('src') ?? '';
        if (safeImageSource(source) === undefined) continue;

        const alt = image.getAttribute('alt') ?? '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'image-link';
        button.setAttribute('aria-haspopup', 'dialog');
        button.setAttribute('aria-label', alt.length > 0 ? `Open image: ${alt}` : 'Open image');
        button.title = alt.length > 0 ? alt : 'Open image';
        button.addEventListener('click', () => options.open(source, alt));

        image.replaceWith(button);
        button.append(image);
        count += 1;
    }

    return count;
};
