// ContentEditable composer editor primitives (T5 R1/R2).
//
// The composer used to be a <textarea>: plain text plus "[Image 1]" markers. R1
// replaces it with ONE contentEditable surface where attachments, @ file mentions
// and # block references are ATOMIC inline chips (contenteditable=false spans), so
// the caret moves over a chip as one character and backspace deletes the whole
// token. The serialized text stays exactly the old marker grammar:
//
//   - attachment chip  -> its marker "[Image 1]" / "[Video 2]" / ... (byte payload
//     still travels separately in `attachments`; see ui/attachments.ts)
//   - file mention     -> "@src/frontend/main.ts"
//   - block reference  -> "#IT1"
//
// This module owns every DOM decision that can be pinned without a browser:
//   - plain-text serialization of mixed text nodes / chips / <br> / block wrappers;
//   - offset <-> DOM range conversion (so `insertAttachmentMarkers`'s plain-text
//     spacing rules still apply to a chip insertion at the captured selection);
//   - atomic chip creation and removal (including the spacing undo);
//   - HTML-safe plain-text paste;
//   - HTML-safe accessors (`value`, `selectionStart`, `selectionEnd`,
//     `setSelectionRange`) so callers/tests that treated the field as a textarea
//     keep one deterministic contract.
//
// The markup is built with raw DOM APIs (not React/styledComponent) because the
// browser mutates contentEditable children itself; styling lives in styles.css
// (`.composer-chip`).
//
// Cross-references:
//   - ui/attachments.ts  — attchment planning (insertAttachmentMarkers spacing)
//   - main.ts            — composer wiring, popup, lookup, submit
//   - ui/references.ts   — # / @ pure logic and metadata

import { insertAttachmentMarkers, removeAttachmentMarker } from './attachments';
import type { TextSelection } from './attachments';

// One atomic inline chip. `kind` is stored as `data-chip`; `id` is the stable
// identity for removal/state; `label` is BOTH the visible text and the serialized
// token (the prompt and the payload can therefore never drift).
export type InlineChip = {
    kind: 'attachment' | 'file' | 'reference';
    id: string;
    label: string;
    // Optional raster thumbnail (draft attachments). It is decorative; the label
    // stays the serialized token and the accessible name.
    previewUrl?: string;
    // Extra data-* facts (attachment kind, reference turn/thread/label). Keys are
    // already the dataset names without the `data-` prefix and are written only
    // when the value is a non-empty string.
    data?: Record<string, string | undefined>;
};

// Facts read back off a chip. Reference chips are what keeps the exact server
// turn/thread binding through a clear/restore or a queued submit.
export type EditorChip = {
    kind: InlineChip['kind'];
    id: string;
    label: string;
    dataset: Record<string, string | undefined>;
};

export const ATTACHMENT_CHIP_KIND = 'attachment';
export const FILE_CHIP_KIND = 'file';
export const REFERENCE_CHIP_KIND = 'reference';

// --- plain-text serialization ------------------------------------------------

type EditorPart =
    | { type: 'text'; node: Text; text: string; start: number; end: number }
    | { type: 'chip'; node: HTMLElement; text: string; start: number; end: number }
    | { type: 'break'; node: HTMLElement; text: '\n'; start: number; end: number }
    // Newline that a block wrapper implies (Chrome wraps each line in a <div>).
    // It has no text node; it maps to the wrapper's start position.
    | { type: 'virtual'; node: HTMLElement; text: '\n'; start: number; end: number };

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE']);

// Read a chip back off a DOM node. Only the three known kinds are chips; any
// unknown `data-chip` value is treated as ordinary content and walked normally.
export const readEditorChip = (node: Node): EditorChip | null => {
    if (!(node instanceof HTMLElement)) return null;

    const kind = node.getAttribute('data-chip');
    if (kind !== ATTACHMENT_CHIP_KIND && kind !== FILE_CHIP_KIND && kind !== REFERENCE_CHIP_KIND) return null;

    const data: Record<string, string | undefined> = {};
    for (const name of Object.keys(node.dataset)) data[name] = node.dataset[name];

    return {
        kind,
        id: node.dataset.chipId ?? '',
        label: node.dataset.chipLabel ?? node.textContent ?? '',
        dataset: data
    };
};

// Serialize the editor into its plain-text value. This is the ONLY definition of
// the value grammar: text nodes verbatim, chips as their label, <br> as "\n", and
// one "\n" before every block-level wrapper that follows content (matching the
// React UniversalTextBox behavior the harness mirrors).
//
// A non-breaking space is normalized to a regular space: browsers inject &nbsp;
// for a trailing space, and the server-side marker grammar (and the attachment
// tests) are written in ordinary spaces.
const editorParts = (root: HTMLElement): { parts: EditorPart[]; text: string } => {
    const parts: EditorPart[] = [];
    let offset = 0;

    const push = (part: Omit<EditorPart, 'start' | 'end'>): void => {
        const start = offset;
        offset += part.text.length;
        parts.push({ ...part, start, end: offset } as EditorPart);
    };

    const lastIsNewline = (): boolean => {
        const last = parts[parts.length - 1];
        return last === undefined ? true : last.text.endsWith('\n');
    };

    const walk = (container: Node): void => {
        for (const child of Array.from(container.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) {
                const text = (child as Text).data.replace(/\u00a0/g, ' ');
                push({ type: 'text', node: child as Text, text });
                continue;
            }

            if (!(child instanceof HTMLElement)) continue;

            const chip = readEditorChip(child);
            if (chip !== null) {
                push({ type: 'chip', node: child, text: chip.label });
                continue;
            }

            if (child.tagName === 'BR') {
                push({ type: 'break', node: child, text: '\n' });
                continue;
            }

            if (BLOCK_TAGS.has(child.tagName)) {
                // Chrome wraps every line in a <div>; without this boundary the
                // serialized prompt would be one long line.
                if (!lastIsNewline()) push({ type: 'virtual', node: child, text: '\n' });
                walk(child);
                continue;
            }

            walk(child);
        }
    };

    walk(root);

    return { parts, text: parts.map((part) => part.text).join('') };
};

export const editorText = (root: HTMLElement): string => editorParts(root).text;

// Replace the whole editor with plain text. Used by the value accessor (tests and
// draft restore), never by typing. Newlines stay in one text node and render
// because `.composer-input` is `white-space: pre-wrap`.
export const editorSetText = (root: HTMLElement, text: string): void => {
    root.replaceChildren(document.createTextNode(text.replace(/\u00a0/g, ' ')));
};

// Chip descriptors in document order (x removal/state updates and refs capture).
export const editorChips = (root: HTMLElement): EditorChip[] =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-chip]'))
        .map((node) => readEditorChip(node))
        .filter((chip): chip is EditorChip => chip !== null);

export const editorAttachmentChips = (root: HTMLElement): EditorChip[] =>
    editorChips(root).filter((chip) => chip.kind === ATTACHMENT_CHIP_KIND);

// --- offset <-> DOM range ----------------------------------------------------

// A caret point as a text offset within `editorText(root)`.
export type EditorSelection = TextSelection;

// Stored selection used when the real DOM selection is not inside the editor
// (unfocused field, jsdom). The accessors below keep this in sync so a caller can
// set a value + selection and paste exactly like the old textarea.
const selectionKey = Symbol('harness-editor-selection');

type EditorElement = HTMLElement & {
    [selectionKey]?: EditorSelection;
};

const storedSelection = (root: HTMLElement): EditorSelection => {
    const value = (root as EditorElement)[selectionKey];
    return value === undefined ? { start: 0, end: 0 } : value;
};

const storeSelection = (root: HTMLElement, selection: EditorSelection): void => {
    (root as EditorElement)[selectionKey] = selection;
};

const clampOffset = (value: number, length: number): number => {
    const raw = Number.isFinite(value) ? Math.trunc(value) : length;
    return Math.min(Math.max(raw, 0), length);
};

// Resolve a plain-text offset to a DOM point. Boundaries prefer the EARLIER part
// for a start and the LATER part for an end, which is what makes a chip never
// split in half.
const pointAt = (parts: readonly EditorPart[], offset: number, bias: 'start' | 'end'): { node: Node; offset: number } => {
    const length = parts.length === 0 ? 0 : parts[parts.length - 1]!.end;
    const target = clampOffset(offset, length);
    if (parts.length === 0) return { node: parts.length === 0 ? document.createTextNode('') : parts[0]!.node, offset: 0 };

    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;

        if (target < part.end || (target === part.end && (bias === 'end' || index === parts.length - 1))) {
            const local = Math.max(0, Math.min(target - part.start, part.text.length));

            if (part.type === 'text') return { node: part.node, offset: local };
            if (part.type === 'chip') {
                const parent = part.node.parentNode ?? part.node;
                const position = Array.from(parent.childNodes).indexOf(part.node);
                return { node: parent, offset: position + (local > 0 || bias === 'end' ? 1 : 0) };
            }
            if (part.type === 'break') {
                const parent = part.node.parentNode ?? part.node;
                const position = Array.from(parent.childNodes).indexOf(part.node);
                return { node: parent, offset: position + (bias === 'end' ? 1 : 0) };
            }

            // Virtual newline: the block wrapper's start is the caret position.
            return { node: part.node, offset: 0 };
        }
    }

    const last = parts[parts.length - 1]!;
    if (last.type === 'text') return { node: last.node, offset: last.text.length };
    if (last.type === 'chip') {
        const parent = last.node.parentNode ?? last.node;
        return { node: parent, offset: Array.from(parent.childNodes).indexOf(last.node) + 1 };
    }

    return { node: last.node.parentNode ?? last.node, offset: last.node.parentNode === null ? 0 : 0 };
};

const rangeOf = (parts: readonly EditorPart[], selection: EditorSelection, root?: HTMLElement): Range => {
    const range = document.createRange();

    // An empty editor has no parts to map; collapse at the root so an insertion
    // still has a valid range.
    if (parts.length === 0) {
        if (root !== undefined) range.selectNodeContents(root);
        range.collapse(true);
        return range;
    }

    const start = pointAt(parts, selection.start, 'start');
    const end = pointAt(parts, selection.end, 'end');
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
};

// Find an attachment chip without relying on CSS.escape (absent in jsdom and in
// older engines): ids are generated by main.ts (`attach-1`), so a scan is cheap.
const attachmentChipById = (root: HTMLElement, id: string): HTMLElement | null =>
    (
        Array.from(root.querySelectorAll<HTMLElement>(`[data-chip="${ATTACHMENT_CHIP_KIND}"]`)) as HTMLElement[]
    ).find((node) => node.dataset.chipId === id) ?? null;

// Text offset of one DOM point. Used to read the caret after the browser moved it.
const offsetOfPoint = (parts: readonly EditorPart[], node: Node, offset: number): number => {
    for (const part of parts) {
        if (part.type === 'text' && part.node === node) {
            return part.start + Math.max(0, Math.min(offset, part.text.length));
        }

        if (part.type === 'chip') {
            if (part.node === node) return part.start;
            if (part.node.parentNode === node) {
                const position = Array.from(part.node.parentNode.childNodes).indexOf(part.node);
                if (position < offset) return part.end;
                if (position === offset) {
                    // A point just before this chip: if it is the first part at
                    // this offset, prefer the chip's start; otherwise its end.
                    return part.start;
                }
            }
        }

        if ((part.type === 'break' || part.type === 'virtual') && part.node === node) return part.start;
    }

    return parts.length === 0 ? 0 : parts[parts.length - 1]!.end;
};

const domSelection = (root: HTMLElement): EditorSelection | undefined => {
    const selection = typeof window === 'undefined' ? null : window.getSelection();
    if (selection === null || selection.rangeCount === 0) return undefined;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return undefined;

    const { parts } = editorParts(root);
    return {
        start: offsetOfPoint(parts, range.startContainer, range.startOffset),
        end: offsetOfPoint(parts, range.endContainer, range.endOffset)
    };
};

// Current selection: the live DOM selection when the caret is in the editor, else
// the stored one (the field is unfocused or not yet laid out, e.g. jsdom).
export const editorSelection = (root: HTMLElement): EditorSelection => {
    const live = domSelection(root);
    if (live !== undefined) {
        storeSelection(root, live);
        return live;
    }

    return storedSelection(root);
};

// Move the caret/selection. The stored value is always updated; the DOM selection
// is also moved when this document supports it.
export const editorSetSelection = (root: HTMLElement, selection: EditorSelection): void => {
    const length = editorText(root).length;
    const start = clampOffset(selection.start, length);
    const end = Math.max(start, clampOffset(selection.end, length));
    storeSelection(root, { start, end });

    const selectionObject = typeof window === 'undefined' ? null : window.getSelection();
    if (selectionObject === null) return;

    try {
        const { parts } = editorParts(root);
        const range = rangeOf(parts, { start, end }, root);
        selectionObject.removeAllRanges();
        selectionObject.addRange(range);
    } catch {
        // A detached/unsupported selection implementation only means the DOM
        // caret could not be moved; `selectionStart`/`selectionEnd` stay correct.
    }
};

// --- chip creation -----------------------------------------------------------

const createChipElement = (chip: InlineChip): HTMLElement => {
    const element = document.createElement('span');
    element.className = `composer-chip composer-chip-${chip.kind}`;
    element.setAttribute('data-chip', chip.kind);
    element.setAttribute('data-chip-id', chip.id);
    element.setAttribute('data-chip-label', chip.label);
    // contenteditable=false makes the browser treat the span as one character:
    // arrow keys step over it and Backspace/Delete remove it whole.
    element.setAttribute('contenteditable', 'false');
    element.setAttribute('role', chip.kind === ATTACHMENT_CHIP_KIND ? 'group' : 'img');
    element.setAttribute('aria-label', chip.label);

    if (chip.previewUrl !== undefined) {
        const thumb = document.createElement('img');
        thumb.className = 'composer-chip-thumb';
        thumb.alt = '';
        thumb.src = chip.previewUrl;
        element.append(thumb);
    }

    // Attachment chips carry a real remove button (the old strip's affordance), so
    // removing a pending/ready file never depends on the reader discovering
    // Backspace. The button lives INSIDE the non-editable chip: it cannot be typed
    // into and the chip still serializes as its label.
    if (chip.kind === ATTACHMENT_CHIP_KIND) {
        const text = document.createElement('span');
        text.className = 'composer-chip-text';
        text.textContent = chip.label;
        element.append(text);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'composer-chip-remove';
        remove.dataset.chipRemove = chip.id;
        remove.setAttribute('aria-label', `Remove ${chip.data?.attachmentName ?? chip.label}`);
        remove.textContent = '×';
        element.append(remove);
    } else {
        element.textContent = chip.label;
    }

    if (chip.data !== undefined) {
        for (const [name, value] of Object.entries(chip.data)) {
            if (value === undefined || value.length === 0) continue;
            element.dataset[name] = value;
        }
    }

    return element;
};

// Insert atomic chips at the CAPTURED selection, using the exact spacing rules of
// ui/attachments.ts `insertAttachmentMarkers` (one space only where the adjacent
// character is non-whitespace; a non-empty selection is replaced). The returned
// `text`/`caret` are the serialized draft and caret offset, so callers that used
// the old textarea contract can keep asserting the same values.
export const editorInsertChips = (
    root: HTMLElement,
    selection: EditorSelection,
    chips: readonly InlineChip[]
): { text: string; caret: number } => {
    const { parts, text } = editorParts(root);

    if (chips.length === 0) {
        editorSetSelection(root, selection);
        return { text, caret: selection.end };
    }

    const planned = insertAttachmentMarkers(
        text,
        selection,
        chips.map((chip) => chip.label)
    );

    const start = clampOffset(selection.start, text.length);
    const end = Math.max(start, clampOffset(selection.end, text.length));
    const before = text.slice(0, start);
    const after = text.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';

    const range = rangeOf(parts, { start, end }, root);
    range.deleteContents();

    const fragment = document.createDocumentFragment();
    if (lead.length > 0) fragment.append(document.createTextNode(lead));
    chips.forEach((chip, index) => {
        if (index > 0) fragment.append(document.createTextNode(' '));
        fragment.append(createChipElement(chip));
    });
    if (trail.length > 0) fragment.append(document.createTextNode(trail));

    range.insertNode(fragment);
    editorSetSelection(root, { start: planned.caret, end: planned.caret });

    return { text: planned.text, caret: planned.caret };
};

// Insert plain text (the HTML-safe paste path). CRLF is normalized and NUL is
// dropped; nothing from the clipboard's HTML flavor is parsed, so pasted markup
// can never create elements, scripts or chips.
export const editorInsertPlainText = (
    root: HTMLElement,
    selection: EditorSelection,
    value: string
): { text: string; caret: number } => {
    const paste = value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
    const { parts, text } = editorParts(root);
    const start = clampOffset(selection.start, text.length);
    const end = Math.max(start, clampOffset(selection.end, text.length));

    const range = rangeOf(parts, { start, end }, root);
    range.deleteContents();
    const node = document.createTextNode(paste);
    range.insertNode(node);

    const caret = start + paste.length;
    editorSetSelection(root, { start: caret, end: caret });

    return { text: `${text.slice(0, start)}${paste}${text.slice(end)}`, caret };
};

// --- attachment chip lifecycle ----------------------------------------------

const trimAdjacentSpace = (chip: HTMLElement): void => {
    const previous = chip.previousSibling;
    const next = chip.nextSibling;
    const previousText = previous !== null && previous.nodeType === Node.TEXT_NODE ? (previous as Text) : undefined;
    const nextText = next !== null && next.nodeType === Node.TEXT_NODE ? (next as Text) : undefined;
    const leftSpace = previousText !== undefined && previousText.data.endsWith(' ');
    const rightSpace = nextText !== undefined && nextText.data.startsWith(' ');

    // Mirrors removeAttachmentMarker: collapse the separator pair, and undo the
    // single lead/trail space the insert added at either edge.
    if (leftSpace && rightSpace && previousText !== undefined && nextText !== undefined) {
        previousText.data = previousText.data.slice(0, -1);
        return;
    }
    if (!leftSpace && rightSpace && previousText === undefined && nextText !== undefined) {
        nextText.data = nextText.data.slice(1);
        return;
    }
    if (leftSpace && previousText !== undefined && afterIsEmpty(chip)) {
        previousText.data = previousText.data.slice(0, -1);
    }
};

const afterIsEmpty = (chip: HTMLElement): boolean => {
    const next = chip.nextSibling;
    if (next === null) return true;
    if (next.nodeType === Node.TEXT_NODE) return (next as Text).data.length === 0;
    return false;
};

// Remove one attachment chip by id and undo its spacing. When the chip is already
// gone (the user backspaced it), fall back to removing the first plain-text marker
// occurrence so the draft cannot keep a reference without bytes.
export const editorRemoveAttachment = (root: HTMLElement, id: string, marker: string): void => {
    const chip = attachmentChipById(root, id);

    if (chip === null) {
        const next = removeAttachmentMarker(editorText(root), marker);
        if (next !== editorText(root)) editorSetText(root, next);
        return;
    }

    trimAdjacentSpace(chip);
    chip.remove();
};

// Paint the reading/ready state on a chip without touching its text or the draft.
export const editorSetAttachmentState = (root: HTMLElement, id: string, state?: 'reading'): void => {
    const chip = attachmentChipById(root, id);
    if (chip === null) return;

    if (state === undefined) delete chip.dataset.state;
    else chip.dataset.state = state;
};

// --- textarea-compatible accessors ------------------------------------------

// Install the HTML-safe accessors the composer (and its tests) use:
//   value            getter serializes, setter replaces the content and emits input
//   selectionStart   current caret/collapsed selection start
//   selectionEnd     current selection end
//   setSelectionRange(start, end)  move the caret/selection
//
// This is NOT pretending the field is a textarea: it keeps the old draft contract
// (`insertAttachmentMarkers` offsets) available to one surface while chips keep
// their atomic DOM identity.
export const installEditorAccessors = (root: HTMLElement): void => {
    Object.defineProperties(root, {
        value: {
            configurable: true,
            enumerable: false,
            get: () => editorText(root),
            set: (next: string) => {
                editorSetText(root, String(next ?? ''));
                const length = editorText(root).length;
                editorSetSelection(root, { start: length, end: length });
                root.dispatchEvent(new Event('input', { bubbles: true }));
            }
        },
        selectionStart: {
            configurable: true,
            enumerable: false,
            get: () => editorSelection(root).start
        },
        selectionEnd: {
            configurable: true,
            enumerable: false,
            get: () => editorSelection(root).end
        },
        setSelectionRange: {
            configurable: true,
            enumerable: false,
            value: (start: number, end?: number) => {
                editorSetSelection(root, { start, end: end ?? start });
            }
        }
    });
};

// Capture/restore the editor's child nodes for a failed submit. A clone keeps the
// exact chip data (attachment bytes live in main.ts's draft; reference chips keep
// their turn/thread binding), which is what "retain exact binding through clear
// and restore" requires.
export const editorSnapshot = (root: HTMLElement): Node[] =>
    Array.from(root.childNodes).map((node) => node.cloneNode(true));

export const editorRestore = (root: HTMLElement, nodes: readonly Node[]): void => {
    root.replaceChildren(...nodes.map((node) => node.cloneNode(true)));
    const length = editorText(root).length;
    editorSetSelection(root, { start: length, end: length });
};

// Undo the spacing an atomically deleted chip left behind. Called by the
// MutationObserver in main.ts (Backspace/Delete/cut removes the chip inside the
// browser's editing machinery, not in our handlers):
//   - two spaces around the gap collapse to one;
//   - a chip at the start/end keeps the single original separator only.
export const editorCollapseChipGap = (
    previous: Node | null,
    next: Node | null
): void => {
    const previousText = previous !== null && previous.nodeType === Node.TEXT_NODE ? (previous as Text) : undefined;
    const nextText = next !== null && next.nodeType === Node.TEXT_NODE ? (next as Text) : undefined;

    if (previousText === undefined && nextText !== undefined) {
        nextText.data = nextText.data.replace(/^ +/, '');
        return;
    }

    if (previousText !== undefined && nextText === undefined) {
        previousText.data = previousText.data.replace(/ +$/, '');
        return;
    }

    if (previousText !== undefined && nextText !== undefined) {
        if (previousText.data.endsWith(' ') && nextText.data.startsWith(' ')) {
            previousText.data = previousText.data.slice(0, -1);
        }
    }
};


