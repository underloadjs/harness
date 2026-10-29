// Composer attachment helpers (R1 clip/attach UX).
//
// The textarea stays the single input: a pasted/chosen file is represented by a
// plain-text marker ("[Image 1]") inserted at the captured selection, while the
// bytes travel in the submit body's `attachments` array. This module owns every
// decision that can be pinned without a browser:
//
//   - marker placement/spacing (insert at selection, remove by first occurrence);
//   - deterministic per-kind numbering that survives removals within one draft;
//   - the pre-read budget gate (count / per-file / total bytes) and MIME-to-kind
//     classification;
//   - raw-base64 extraction from a FileReader data URL;
//   - the chip DOM (filename via textContent, optional safe image thumbnail).
//
// Contract sources (frozen, don't re-invent):
//   - ../../types/index.ts          — HarnessAttachment (single type owner)
//   - ../../shared/attachments.ts   — validateAttachments, limits, attachmentMarker
//
// Cross-references:
//   - ./main.ts                     — composer state machine that consumes these
//   - ./turns.ts                    — replay/history chips (same chip builder)
//   - ../../frontend/styles.css     — `.composer-attachments`, `.attachment-chip`

import type { HarnessAttachment } from '../../types';
import {
    attachmentMarker,
    MAX_ATTACHMENTS_PER_TURN,
    MAX_ATTACHMENT_BYTES,
    MAX_TOTAL_ATTACHMENT_BYTES,
    validateAttachments
} from '../../shared/attachments';

// The exact kinds the wire contract accepts. Kept as a local alias so callers do
// not need to reach into the type module for a union member.
export type AttachmentKind = HarnessAttachment['kind'];

// Per-kind draft counters. They only ever INCREASE within one draft: removing
// "[Image 1]" must not renumber "[Image 2]" (the user may have typed around the
// marker). A successful submission replaces the object with a fresh zeroed one.
export type AttachmentCounters = Record<AttachmentKind, number>;

// The only facts needed before a file is read. `File` itself is not accepted so
// the budget logic stays testable with plain objects.
export type AttachmentFileFacts = {
    name: string;
    mime: string;
    size: number;
};

// One accepted file and the kind/MIME the composer will send. The MIME is the
// normalized lowercase form shared/attachments.ts validates (parameters stripped).
export type PlannedAttachment = {
    kind: AttachmentKind;
    mime: string;
};

export type AttachmentBatchPlan =
    | { ok: true; entries: PlannedAttachment[] }
    | { ok: false; message: string };

// Visible kind labels. The same words the markers use, so a chip and its marker
// always agree (and the validator's grammar stays readable to the user).
const KIND_TEXT: Readonly<Record<AttachmentKind, string>> = {
    image: 'Image',
    video: 'Video',
    audio: 'Audio',
    pdf: 'PDF',
    file: 'File'
};

// MIME -> kind. Mirrors MIME_BY_KIND in ../../shared/attachments.ts; unknown MIMEs
// become generic `file` entries (representable, but the transport refuses them
// with an explicit unsupported error — the composer must not pretend otherwise).
const KIND_BY_MIME: Readonly<Record<string, AttachmentKind>> = {
    'image/png': 'image',
    'image/jpeg': 'image',
    'image/jpg': 'image',
    'image/webp': 'image',
    'image/gif': 'image',
    'video/mp4': 'video',
    'video/webm': 'video',
    'video/ogg': 'video',
    'video/quicktime': 'video',
    'audio/wav': 'audio',
    'audio/x-wav': 'audio',
    'audio/wave': 'audio',
    'audio/mpeg': 'audio',
    'audio/mp3': 'audio',
    'application/pdf': 'pdf'
};

// Only these image MIMEs may render a thumbnail. SVG is deliberately absent: an
// inline SVG is scriptable, so an uploaded one stays a filename chip instead.
const IMAGE_PREVIEW_MIMES: ReadonlySet<string> = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif'
]);

// A MIME without parameters, lowercased. An empty/odd `File.type` (some OS
// clipboards report "") falls back to the generic binary type rather than failing
// the validator on a technicality.
export const normalizeMime = (value: string): string => {
    const base = value.split(';')[0].trim().toLowerCase();
    const valid = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base);
    return valid ? base : 'application/octet-stream';
};

// Classify a file by its MIME. Signature verification still happens later in
// validateAttachments, so a mislabelled file is reported rather than sent.
export const attachmentKindOf = (mime: string): AttachmentKind =>
    KIND_BY_MIME[normalizeMime(mime)] ?? 'file';

// Extensions for the fallback filename. Only used when a File has no usable name
// (an OS clipboard can hand over an unnamed image), so the marker/chip still has a
// human-readable label instead of an empty string the validator would reject.
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'application/pdf': 'pdf'
};

// A visible filename only: path separators/control characters become "_" and the
// value is bounded to the validator's 200-char name budget. An empty result gets a
// deterministic kind/index name; the chip always has something to show.
export const attachmentFileName = (name: string, mime: string, fallbackIndex: number): string => {
    const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:]/g, '_').trim().slice(0, 200);
    if (cleaned.length > 0) return cleaned;

    const ext = EXTENSION_BY_MIME[normalizeMime(mime)] ?? 'bin';
    return `${attachmentKindOf(mime)}-${fallbackIndex}.${ext}`;
};

export const attachmentKindText = (kind: AttachmentKind): string => KIND_TEXT[kind];

// MiB is what the limits are written in, so errors quote the same units the
// constants are defined with. Integers keep the message stable ("4 MiB").
const formatMiB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(0)} MiB`;

// Validate a batch BEFORE any bytes are read. A batch is atomic at this stage:
// if one file is unacceptable, no marker is inserted and the draft is untouched.
//
// Checks, in the order that keeps the message actionable:
//   1. the per-turn count limit (existing + batch);
//   2. each file is non-empty and within the per-file limit;
//   3. the whole draft is within the per-turn total limit.
//
// Returns the planned kind/MIME per file in CLIPBOARD ORDER, which is the order
// the caller assigns markers and starts reads in.
export const planAttachmentBatch = (
    files: readonly AttachmentFileFacts[],
    existing: readonly { size: number }[]
): AttachmentBatchPlan => {
    if (files.length === 0) return { ok: false, message: 'No files were found to attach.' };

    if (existing.length + files.length > MAX_ATTACHMENTS_PER_TURN) {
        return {
            ok: false,
            message: `At most ${MAX_ATTACHMENTS_PER_TURN} files can be attached to one message (${existing.length} already attached).`
        };
    }

    let total = existing.reduce((sum, entry) => sum + entry.size, 0);

    for (const file of files) {
        if (!Number.isFinite(file.size) || file.size < 1) {
            return { ok: false, message: `"${file.name}" is empty.` };
        }

        if (file.size > MAX_ATTACHMENT_BYTES) {
            return {
                ok: false,
                message: `"${file.name}" is ${formatMiB(file.size)}, above the ${formatMiB(MAX_ATTACHMENT_BYTES)} per-file limit.`
            };
        }

        total += file.size;
    }

    if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
        return {
            ok: false,
            message: `The attached files total ${formatMiB(total)}, above the ${formatMiB(MAX_TOTAL_ATTACHMENT_BYTES)} per-message limit.`
        };
    }

    return {
        ok: true,
        entries: files.map((file) => {
            const mime = normalizeMime(file.mime);
            return { kind: attachmentKindOf(mime), mime };
        })
    };
};

export const createAttachmentCounters = (): AttachmentCounters => ({
    image: 0,
    video: 0,
    audio: 0,
    pdf: 0,
    file: 0
});

// Take the next marker for `kind`. Mutation is deliberate: the draft's counters
// are the source of monotonic numbering, and the helper keeps the increment and
// the grammar in one place (shared attachmentMarker).
export const nextAttachmentMarker = (counters: AttachmentCounters, kind: AttachmentKind): string => {
    counters[kind] += 1;
    return attachmentMarker(kind, counters[kind]);
};

export type TextSelection = { start: number; end: number };

// Insert markers at the CAPTURED selection. Callers capture `selectionStart`/
// `selectionEnd` at paste time and insert synchronously, so an asynchronous read
// can never move the insertion point (the marker is already in the text).
//
// Spacing: a single space is added on a side only when the adjacent character is
// non-whitespace. Typing "Check this image for me " then pasting at the end
// therefore yields "Check this image for me [Image 1]" (no doubled space), while
// pasting mid-word pads both sides. A non-empty selection is replaced, exactly
// like a normal paste.
export const insertAttachmentMarkers = (
    text: string,
    selection: TextSelection,
    markers: readonly string[]
): { text: string; caret: number } => {
    const length = text.length;
    const rawStart = Number.isFinite(selection.start) ? Math.trunc(selection.start) : length;
    const start = Math.min(Math.max(rawStart, 0), length);
    const rawEnd = Number.isFinite(selection.end) ? Math.trunc(selection.end) : start;
    const end = Math.min(Math.max(rawEnd, start), length);

    if (markers.length === 0) return { text, caret: end };

    const before = text.slice(0, start);
    const after = text.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    const block = `${lead}${markers.join(' ')}${trail}`;

    return { text: `${before}${block}${after}`, caret: start + block.length };
};

// Remove the FIRST occurrence of a marker (the chip -> marker association is
// first-match) and undo the spacing inserted around it, without touching any
// other character. A marker that is not in the text is a no-op (the user may have
// deleted it by hand; the chip is still removable).
export const removeAttachmentMarker = (text: string, marker: string): string => {
    const index = text.indexOf(marker);
    if (index < 0) return text;

    const before = text.slice(0, index);
    const after = text.slice(index + marker.length);
    const leftSpace = before.endsWith(' ');
    const rightSpace = after.startsWith(' ');

    // Both sides had whitespace: collapse the pair the marker separated.
    if (leftSpace && rightSpace) return `${before.slice(0, -1)}${after}`;

    // Marker sat at the start and the following space was the only separator.
    if (!leftSpace && rightSpace && before.length === 0) return after.slice(1);

    // Marker sat at the end; drop the lead space the insert added.
    if (leftSpace && after.length === 0) return before.slice(0, -1);

    return `${before}${after}`;
};

// Extract raw base64 from a FileReader data URL. `data` must be canonical base64
// without the `data:...;base64,` prefix (shared/attachments.ts contract).
export const base64OfDataUrl = (dataUrl: string): string => {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('The browser did not return readable file data.');

    if (!/;base64$/i.test(dataUrl.slice(0, comma))) {
        throw new Error('The browser did not return base64 file data.');
    }

    return dataUrl.slice(comma + 1);
};

// Read one File as raw base64. FileReader is used rather than Blob.arrayBuffer
// because it is available in every browser this bundle targets and in jsdom.
export const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise<string>((resolve, reject) => {
        if (typeof FileReader === 'undefined') {
            reject(new Error('This browser cannot read local files.'));
            return;
        }

        const reader = new FileReader();

        reader.onerror = () => {
            reject(reader.error ?? new Error(`Could not read "${file.name}".`));
        };

        reader.onload = () => {
            try {
                resolve(base64OfDataUrl(String(reader.result)));
            } catch (error) {
                reject(error);
            }
        };

        reader.readAsDataURL(file);
    });

// Build the wire record through the SHARED validator, which returns a detached,
// signature-checked copy. Doing it here means the draft only ever holds values the
// server would also accept; any mismatch (wrong magic bytes, base64 error) is
// reported as a read failure with the validator's precise message.
export const attachmentRecordOf = (input: HarnessAttachment): HarnessAttachment => {
    const [record] = validateAttachments([input]);
    return record;
};

// Safe image thumbnail URL for a draft. Only known raster image MIMEs get an
// object URL; everything else is a filename chip. A runtime without
// URL.createObjectURL (jsdom, exotic embed) simply renders no thumbnail.
export const attachmentPreviewUrl = (file: File, kind: AttachmentKind): string | undefined => {
    if (kind !== 'image' || !IMAGE_PREVIEW_MIMES.has(normalizeMime(file.type))) return undefined;
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined;

    try {
        return URL.createObjectURL(file);
    } catch {
        return undefined;
    }
};

// Revoke a preview URL exactly once. Callers invoke this on remove, on draft
// reset, and on teardown; a URL that was never created is a no-op.
export const releaseAttachmentPreview = (url?: string): void => {
    if (url === undefined || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;

    try {
        URL.revokeObjectURL(url);
    } catch {
        // Already revoked / not an object URL: nothing to clean up.
    }
};

// Data URL for a RECORDED attachment (history replay). Recent turns carry their
// bytes in the record, so no object URL is needed and nothing leaks; the base64
// never appears as visible text. Shape-checked to keep a malformed record from
// producing a broken (or scriptable) URL.
export const attachmentThumbnailUrl = (attachment: HarnessAttachment): string | undefined => {
    if (attachment.kind !== 'image' || !IMAGE_PREVIEW_MIMES.has(attachment.mime)) return undefined;
    if (typeof attachment.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.data)) return undefined;

    return `data:${attachment.mime};base64,${attachment.data}`;
};

// Files on a clipboard/drag payload, in deterministic order: DataTransfer.items
// first (spec order, the order the files were copied), then `files` for any entry
// the items list did not expose. Identity dedupe means a browser that reports the
// same File through both paths attaches it once.
export type ClipboardPayload = {
    items?: ArrayLike<{ kind?: string; getAsFile?: () => File | null } | null> | null;
    files?: ArrayLike<File> | null;
};

export const clipboardFilesOf = (data: ClipboardPayload | null | undefined): File[] => {
    if (data === null || data === undefined) return [];

    const files: File[] = [];
    const seen = new Set<File>();

    const push = (file: File | null | undefined): void => {
        if (file === null || file === undefined || typeof file !== 'object') return;
        if (seen.has(file)) return;

        seen.add(file);
        files.push(file);
    };

    if (data.items !== null && data.items !== undefined) {
        for (const item of Array.from(data.items)) {
            if (item === null || item === undefined) continue;
            if (item.kind !== 'file') continue;

            push(item.getAsFile?.() ?? null);
        }
    }

    if (data.files !== null && data.files !== undefined) {
        for (const file of Array.from(data.files)) push(file);
    }

    return files;
};

// Facts a chip needs. Deliberately no `data`: the chip never renders bytes, and
// a base64 string in a label/title would leak a payload into the DOM text.
export type AttachmentChipFacts = {
    kind: AttachmentKind;
    marker: string;
    name: string;
    mime: string;
    previewUrl?: string;
    // True while the file is being read; the chip is visible but not sendable.
    pending?: boolean;
};

// Build one chip. `name` and `marker` are written with textContent (never HTML),
// and the remove affordance is a SIBLING button inside a plain div — never a
// button nested in a button, which would be invalid and inaccessible.
export const attachmentChipElement = (
    facts: AttachmentChipFacts,
    options: { onRemove?: () => void } = {}
): HTMLElement => {
    const document = globalThis.document;

    const chip = document.createElement('div');
    chip.className = 'attachment-chip';
    chip.dataset.kind = facts.kind;
    chip.setAttribute('role', 'listitem');
    if (facts.pending === true) chip.dataset.state = 'reading';

    if (facts.previewUrl !== undefined) {
        const thumb = document.createElement('img');
        thumb.className = 'attachment-thumb';
        // Decorative: the filename next to it is the accessible identity.
        thumb.alt = '';
        thumb.src = facts.previewUrl;
        chip.append(thumb);
    }

    const text = document.createElement('span');
    text.className = 'attachment-text';

    const kind = document.createElement('span');
    kind.className = 'attachment-kind';
    kind.textContent = KIND_TEXT[facts.kind];

    const marker = document.createElement('span');
    marker.className = 'attachment-marker';
    marker.textContent = facts.marker;

    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = facts.name;

    text.append(kind, marker, name);
    chip.append(text);

    if (options.onRemove !== undefined) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-remove';
        remove.textContent = '×';
        // The accessible name names the file and its marker, so two same-named
        // attachments are still distinguishable.
        remove.setAttribute('aria-label', `Remove ${facts.name} (${facts.marker})`);
        // Removal stays available while reading: the read's completion is ignored
        // once the entry left the draft (see finishAttachmentRead in main.ts).
        remove.addEventListener('click', options.onRemove);
        chip.append(remove);
    }

    return chip;
};
