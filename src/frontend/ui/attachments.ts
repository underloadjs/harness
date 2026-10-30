// Composer attachment helpers (R1 clip/attach).
//
// The composer's contentEditable field (ui/editor.ts) is the single input: a
// pasted/chosen file is represented by an atomic inline chip whose serialized text
// is the plain marker ("[Image 1]"), while the bytes travel in the submit body's
// `attachments` array. This module owns every decision that can be pinned without
// a browser:
//
//   - marker placement/spacing rules (insertAttachmentMarkers/removeAttachmentMarker
//     are reused by ui/editor.ts for the DOM chip insertion/removal);
//   - deterministic per-kind numbering that survives removals within one draft;
//   - the pre-read budget gate (count / per-file / total bytes) and MIME-to-kind
//     classification;
//   - raw-base64 extraction from a FileReader data URL;
//   - the history chip DOM (filename via textContent, optional safe image thumbnail);
//   - inline transcript chips placed over exact prompt markers (R10) and their
//     replacement rules, so the attachment is NOT repeated in a second row.
//
// Contract sources (frozen, don't re-invent):
//   - ../../types/index.ts          — HarnessAttachment (single type owner)
//   - ../../shared/attachments.ts   — validateAttachments, limits, attachmentMarker
//
// Cross-references:
//   - ./main.ts                     — composer state machine that consumes these
//   - ./editor.ts                   — inline atomic chips (draft attachments)
//   - ./turns.ts                    — replay/history chips (same chip builder)
//   - ./preview.ts                  — the dialog an inline chip opens
//   - ../../frontend/styles.css     — `.composer-chip`, `.attachment-chip`, `.attachment-inline`

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
// the items list did not expose.
//
// DEDUPE IS BY CLIPBOARD ENTRY, NOT BY OBJECT IDENTITY. A browser is free to hand
// out a FRESH File object every time the payload is read (Chromium does exactly
// that: `items[i].getAsFile()` and `files[i]` are different objects wrapping the
// same clipboard entry). Identity dedupe therefore attached ONE pasted image
// twice - two chips, "[Image 1] [Image 2]" and two payload records.
//
// The rule that keeps distinct files while removing the duplicate:
//   - every `items` entry is kept (that list is the authoritative clipboard order);
//   - a `files` entry is skipped only while an UNMATCHED item with the same facts
//     (name, MIME, size) is still available, and consumes it.
// The count is a multiset budget, so copying two genuinely distinct files that
// happen to share those facts yields two attachments, not one.
//
// `lastModified` is deliberately NOT part of the key: the two representations of one
// clipboard entry do not always agree on it (Chromium reports 0 for a synthesized
// item and a real timestamp for the `files` copy), and a timestamp mismatch made the
// budget miss - re-attaching one image twice. A timestamp cannot tell two distinct
// clipboard files apart anyway (a copy keeps the same mtime), while the multiset
// budget already preserves genuinely distinct entries.
export type ClipboardPayload = {
    items?: ArrayLike<{ kind?: string; getAsFile?: () => File | null } | null> | null;
    files?: ArrayLike<File> | null;
};

// Identity of one clipboard entry, readable from both representations. `size`
// separates same-named files and `type` keeps a browser-converted representation
// (e.g. image/png vs image/bmp) from being merged with the original.
const clipboardFileKey = (file: File): string =>
    [file.name, file.type, String(file.size)].join('\u0000');

export const clipboardFilesOf = (data: ClipboardPayload | null | undefined): File[] => {
    if (data === null || data === undefined) return [];

    const files: File[] = [];
    const seen = new Set<File>();

    const push = (file: File | null | undefined): void => {
        if (file === null || file === undefined || typeof file !== 'object') return;
        // The same object twice is still one clipboard entry.
        if (seen.has(file)) return;

        seen.add(file);
        files.push(file);
    };

    // Multiset of the item entries' facts: each `files` entry may only consume one
    // matching item before it counts as an additional, distinct file.
    const itemBudget = new Map<string, number>();

    if (data.items !== null && data.items !== undefined) {
        for (const item of Array.from(data.items)) {
            if (item === null || item === undefined) continue;
            if (item.kind !== 'file') continue;

            const file = item.getAsFile?.() ?? null;
            push(file);

            if (file !== null && file !== undefined && typeof file === 'object') {
                const key = clipboardFileKey(file);
                itemBudget.set(key, (itemBudget.get(key) ?? 0) + 1);
            }
        }
    }

    if (data.files !== null && data.files !== undefined) {
        for (const file of Array.from(data.files)) {
            if (file === null || file === undefined || typeof file !== 'object') continue;

            const key = clipboardFileKey(file);
            const remaining = itemBudget.get(key) ?? 0;

            if (remaining > 0) {
                // The same clipboard entry, handed over as a second representation.
                itemBudget.set(key, remaining - 1);
                continue;
            }

            push(file);
        }
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

// Shared inner content for every chip variant. Split out so the static history
// chip (div/listitem) and the interactive inline chip (button) cannot drift in
// class names or in what they write: `name`/`marker`/`kind` always use
// textContent, so no payload-derived string can ever be parsed as HTML.
const attachmentChipContent = (facts: AttachmentChipFacts): DocumentFragment => {
    const document = globalThis.document;
    const fragment = document.createDocumentFragment();

    if (facts.previewUrl !== undefined) {
        const thumb = document.createElement('img');
        thumb.className = 'attachment-thumb';
        // Decorative: the filename next to it is the accessible identity.
        thumb.alt = '';
        thumb.src = facts.previewUrl;
        fragment.append(thumb);
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
    fragment.append(text);
    return fragment;
};

// Build one static chip (composer strip / legacy list). `name` and `marker` are
// written with textContent (never HTML), and the remove affordance is a SIBLING
// button inside a plain div — never a button nested in a button, which would be
// invalid and inaccessible.
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

    chip.append(attachmentChipContent(facts));

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

// ---------------------------------------------------------------------------
// Inline transcript chips (R10)
// ---------------------------------------------------------------------------
//
// A recorded turn's attachments are NOT a second list under the prompt: the
// marker the user typed ("[Image 1]") is the attachment. This builder returns a
// REAL <button>, so it is keyboard-activatable by default (Enter/Space) and has
// an accessible name; clicking it is what opens the preview dialog.
//
// It reuses the `.attachment-chip` visual vocabulary and adds `.attachment-inline`
// for the compact in-flow sizing. The payload is never rendered: only filename,
// marker, kind and a safe raster thumbnail (attachmentThumbnailUrl refuses SVG
// and any non-image MIME) reach the DOM.

export type InlineAttachmentChipOptions = {
    // Invoked on click/Enter/Space. The recorded attachment is passed through, so
    // the caller can open the preview without re-reading the DOM.
    onOpen?: (attachment: HarnessAttachment) => void;
};

export const attachmentInlineChipElement = (
    attachment: HarnessAttachment,
    options: InlineAttachmentChipOptions = {}
): HTMLButtonElement => {
    const document = globalThis.document;
    const preview = attachmentThumbnailUrl(attachment);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'attachment-chip attachment-inline';
    chip.dataset.kind = attachment.kind;
    chip.dataset.marker = attachment.marker;
    chip.setAttribute('aria-haspopup', 'dialog');
    // The accessible name uses the same facts a sighted reader sees. Marker is
    // included so two same-named files stay distinguishable.
    chip.setAttribute('aria-label', `Open ${attachment.name} (${attachment.marker})`);
    chip.title = attachment.name;

    chip.append(
        attachmentChipContent({
            kind: attachment.kind,
            marker: attachment.marker,
            name: attachment.name,
            mime: attachment.mime,
            ...(preview === undefined ? {} : { previewUrl: preview })
        })
    );

    if (options.onOpen !== undefined) {
        const open = options.onOpen;
        chip.addEventListener('click', () => open(attachment));
    }

    return chip;
};

// Elements whose text must never be turned into an attachment chip: code is the
// user showing a marker literally, links/buttons already own activation, and an
// existing chip must not be replaced twice on a re-render.
const ATTACHMENT_CHIP_BLOCKED = 'pre, code, a, button, .attachment-chip, .file-link';

// Text nodes under `root`, in document order. Collected eagerly because inserting
// a chip splits the very node being visited.
const textNodesWithin = (root: HTMLElement): Text[] => {
    const document = root.ownerDocument;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        nodes.push(node as Text);
    }

    return nodes;
};

// Find the first text node holding `marker` exactly as a substring, outside the
// blocked containers above.
const markerTextNode = (root: HTMLElement, marker: string): Text | undefined => {
    for (const node of textNodesWithin(root)) {
        if (!node.data.includes(marker)) continue;

        const parent = node.parentElement;
        if (parent !== null && parent.closest(ATTACHMENT_CHIP_BLOCKED) !== null) continue;
        return node;
    }

    return undefined;
};

// Replace an exact marker inside one text node with `chip`, preserving the text
// before and after it. `splitText` keeps every character, so a marker in the
// middle of a sentence becomes a chip inside that sentence rather than a
// separate row.
const replaceMarkerInText = (node: Text, marker: string, chip: HTMLElement): void => {
    const index = node.data.indexOf(marker);
    if (index < 0) return;

    // The returned node starts at the marker; the original keeps the prefix.
    const target = node.splitText(index);
    if (target.data.length > marker.length) target.splitText(marker.length);

    target.parentNode?.replaceChild(chip, target);
};

export type AttachmentChipPlacement = {
    // Markers found in the rendered prompt and replaced in place.
    matched: number;
    // Attachments whose marker was not present; appended at the end of the prompt.
    appended: number;
};

// Apply recorded attachments to an ALREADY-SANITIZED prompt element. This is a
// post-sanitization DOM transform only: the marker is matched as plain text, and
// the chip is built with createElement/textContent. No HTML string is ever
// injected, so the sanitizer's guarantees still hold.
//
// Matching is by exact marker, once per attachment. An unmatched attachment is
// appended at the end of the prompt instead of a separate list, so the transcript
// never shows the same file twice.
export const applyAttachmentChips = (
    root: HTMLElement,
    attachments: readonly HarnessAttachment[],
    options: InlineAttachmentChipOptions = {}
): AttachmentChipPlacement => {
    let matched = 0;
    let appended = 0;

    for (const attachment of attachments) {
        const chip = attachmentInlineChipElement(attachment, options);
        const node = markerTextNode(root, attachment.marker);

        if (node === undefined) {
            root.append(chip);
            appended += 1;
            continue;
        }

        replaceMarkerInText(node, attachment.marker, chip);
        matched += 1;
    }

    return { matched, appended };
};
