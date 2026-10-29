// ContentEditable composer primitives (T5 R1).
//
// These tests pin the DOM decisions that main.ts relies on, without booting the
// shell: plain-text serialization of chips/newlines, capture-and-insert spacing,
// HTML-safe paste, the textarea-compatible accessors, atomic attachment removal
// and the snapshot/restore path that keeps reference metadata.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/editor.test.ts

import { beforeEach, expect, it } from 'vitest';
import {
    editorChips,
    editorCollapseChipGap,
    editorDeleteChips,
    editorInsertChips,
    editorInsertPlainText,
    editorRemoveAttachment,
    editorRestore,
    editorSelection,
    editorSetSelection,
    editorSetText,
    editorSnapshot,
    editorText,
    installEditorAccessors
} from './editor';

let root: HTMLDivElement;

beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.setAttribute('contenteditable', 'true');
    document.body.append(root);
    installEditorAccessors(root);
});

it('serializes text, chips, <br> and block wrappers without HTML', () => {
    root.append(document.createTextNode('plain '));
    const chip = document.createElement('span');
    chip.setAttribute('data-chip', 'file');
    chip.setAttribute('data-chip-label', '@src/a.ts');
    chip.textContent = '@src/a.ts';
    root.append(chip);
    root.append(document.createElement('br'));
    root.append(document.createTextNode('tail'));

    expect(editorText(root)).toBe('plain @src/a.ts\ntail');
    expect(editorChips(root)).toEqual([
        {
            kind: 'file',
            id: '',
            label: '@src/a.ts',
            dataset: { chip: 'file', chipLabel: '@src/a.ts' }
        }
    ]);

    // Chrome-style line wrappers add exactly one newline before each block.
    const wrapped = document.createElement('div');
    wrapped.innerHTML = 'one<div>two</div>';
    expect(editorText(wrapped)).toBe('one\ntwo');
});

it('inserts atomic markers at the captured selection with the marker grammar spacing', () => {
    editorSetText(root, 'Check this image for me ');

    const first = editorInsertChips(root, { start: 24, end: 24 }, [
        { kind: 'attachment', id: 'attach-1', label: '[Image 1]' }
    ]);

    // Trailing whitespace means no doubled space; the caret sits after the marker.
    expect(first).toEqual({ text: 'Check this image for me [Image 1]', caret: 33 });
    expect(editorText(root)).toBe('Check this image for me [Image 1]');
    expect(editorSelection(root)).toEqual({ start: 33, end: 33 });
    expect(editorChips(root).map((chip) => [chip.kind, chip.id, chip.label])).toEqual([
        ['attachment', 'attach-1', '[Image 1]']
    ]);

    // Mid-word insertion pads BOTH sides and reports the exact serialized draft.
    editorSetText(root, 'ab');
    const middle = editorInsertChips(root, { start: 1, end: 1 }, [
        { kind: 'file', id: 'main.ts', label: '@main.ts' }
    ]);
    expect(middle).toEqual({ text: 'a @main.ts b', caret: 11 });
    expect(editorText(root)).toBe('a @main.ts b');
});

it('replaces a non-empty selection and keeps chip order', () => {
    editorSetText(root, 'two ');

    const result = editorInsertChips(root, { start: 3, end: 4 }, [
        { kind: 'attachment', id: 'a1', label: '[Image 1]' },
        { kind: 'attachment', id: 'a2', label: '[Image 2]' }
    ]);

    // The trailing space was selected away, so the inserted block has no lead pad
    // and no trailing character to separate; the chips are one space apart.
    expect(result).toEqual({ text: 'two [Image 1] [Image 2]', caret: 23 });
    expect(editorChips(root).map((chip) => chip.label)).toEqual(['[Image 1]', '[Image 2]']);
});

it('pastes plain text only: CRLF normalized, no HTML is parsed', () => {
    editorSetText(root, 'hello');
    editorSetSelection(root, { start: 5, end: 5 });

    const result = editorInsertPlainText(root, { start: 5, end: 5 }, '<b>a</b>\r\nline2\u0000');

    expect(result).toEqual({ text: 'hello<b>a</b>\nline2', caret: 19 });
    expect(editorText(root)).toBe('hello<b>a</b>\nline2');
    // The clipboard markup never became elements.
    expect(root.querySelector('b')).toBeNull();
});

it('keeps value and selection accessors in the textarea contract', () => {
    let inputEvents = 0;
    root.addEventListener('input', () => {
        inputEvents += 1;
    });

    const textarea = root as HTMLDivElement & {
        value: string;
        selectionStart: number;
        selectionEnd: number;
        setSelectionRange: (start: number, end?: number) => void;
    };

    textarea.value = 'abc';
    expect(inputEvents).toBe(1);
    expect(textarea.value).toBe('abc');
    expect(textarea.selectionStart).toBe(3);
    expect(textarea.selectionEnd).toBe(3);

    textarea.setSelectionRange(1, 2);
    expect(editorSelection(root)).toEqual({ start: 1, end: 2 });
});

it('removes one attachment chip and undoes its separator spacing', () => {
    editorSetText(root, 'one ');
    editorInsertChips(root, { start: 4, end: 4 }, [
        { kind: 'attachment', id: 'a1', label: '[Image 1]' }
    ]);
    expect(editorText(root)).toBe('one [Image 1]');

    editorRemoveAttachment(root, 'a1', '[Image 1]');
    expect(editorText(root)).toBe('one');
    expect(editorChips(root)).toEqual([]);

    // Mid-text chip: the pair of separators collapses to one space.
    editorSetText(root, 'a b');
    editorInsertChips(root, { start: 2, end: 2 }, [
        { kind: 'attachment', id: 'a2', label: '[Image 2]' }
    ]);
    expect(editorText(root)).toBe('a [Image 2] b');
    editorRemoveAttachment(root, 'a2', '[Image 2]');
    expect(editorText(root)).toBe('a b');
});

it('restores a snapshot with exact chip metadata', () => {
    editorSetText(root, 'see ');
    editorInsertChips(root, { start: 4, end: 4 }, [
        {
            kind: 'reference',
            id: 'reference:t2::IT1',
            label: '#IT1',
            data: { referenceTurn: 't2', referenceLabel: 'IT1' }
        }
    ]);

    const snapshot = editorSnapshot(root);
    editorSetText(root, '');

    editorRestore(root, snapshot);
    expect(editorText(root)).toBe('see #IT1');
    expect(editorChips(root)[0]?.dataset).toEqual({
        chip: 'reference',
        chipId: 'reference:t2::IT1',
        chipLabel: '#IT1',
        referenceTurn: 't2',
        referenceLabel: 'IT1'
    });
    expect(editorSelection(root)).toEqual({ start: 8, end: 8 });
});

// --- atomic deletion of inline chips (R5) ------------------------------------
//
// The chip is a `contenteditable=false` island, and browsers do not reliably
// delete it with the native Backspace/Delete key. These pin the editor-owned
// keystroke: the chip AND its marker separator disappear, the caret lands where
// the token began, and ordinary text editing is untouched.

it('backspaces an attachment chip immediately after the caret and its separator', () => {
    editorSetText(root, 'Check this image for me ');
    editorInsertChips(root, { start: 24, end: 24 }, [
        { kind: 'attachment', id: 'a1', label: '[Image 1]' }
    ]);
    expect(editorText(root)).toBe('Check this image for me [Image 1]');

    expect(editorDeleteChips(root, 'backward')).toEqual({ ids: ['a1'], caret: 23 });
    expect(editorText(root)).toBe('Check this image for me');
    expect(editorChips(root)).toEqual([]);
    expect(editorSelection(root)).toEqual({ start: 23, end: 23 });

    // Nothing is left at the boundary: the native key keeps its normal meaning.
    expect(editorDeleteChips(root, 'backward')).toBeUndefined();
});

it('deletes the chip before the caret and collapses the separator pair', () => {
    editorSetText(root, 'a b');
    editorInsertChips(root, { start: 2, end: 2 }, [
        { kind: 'attachment', id: 'a2', label: '[Image 2]' }
    ]);
    expect(editorText(root)).toBe('a [Image 2] b');

    // Caret BEFORE the chip: Delete consumes it (forward).
    editorSetSelection(root, { start: 2, end: 2 });
    expect(editorDeleteChips(root, 'forward')).toEqual({ ids: ['a2'], caret: 2 });
    expect(editorText(root)).toBe('a b');
    expect(editorChips(root)).toEqual([]);
    expect(editorSelection(root)).toEqual({ start: 2, end: 2 });
});

it('sees a chip through empty and zero-width text nodes at the caret', () => {
    editorSetText(root, 'one ');
    editorInsertChips(root, { start: 4, end: 4 }, [
        { kind: 'attachment', id: 'z1', label: '[Image 1]' }
    ]);
    // Browsers leave empty text nodes behind, and some editors inject a zero-width
    // space to keep a caret observable. Neither may hide the chip.
    root.append(document.createTextNode(''));
    root.append(document.createTextNode('\u200b'));

    editorSetSelection(root, { start: 13, end: 13 });
    expect(editorDeleteChips(root, 'backward')).toEqual({ ids: ['z1'], caret: 3 });
    // The invisible character leaves with the chip; the serialized draft stays clean.
    expect(editorText(root)).toBe('one');
    expect(root.querySelector('[data-chip]')).toBeNull();
});

it('treats NBSP as a real character: the space is deleted before the chip', () => {
    editorSetText(root, 'a ');
    editorInsertChips(root, { start: 2, end: 2 }, [
        { kind: 'attachment', id: 'a3', label: '[Image 3]' }
    ]);
    // The browser stores the leading space as NBSP; it is a visible space, not an
    // invisible artifact.
    root.append(document.createTextNode('\u00a0b'));
    expect(editorText(root)).toBe('a [Image 3] b');

    // Caret after the NBSP: the preceding character is a space, so native editing
    // owns this keystroke (it deletes that space first).
    editorSetSelection(root, { start: 12, end: 12 });
    expect(editorDeleteChips(root, 'backward')).toBeUndefined();

    // Caret immediately after the chip: the chip goes together with the separator
    // AFTER it (the NBSP), so the caret stays exactly where the token stood.
    editorSetSelection(root, { start: 11, end: 11 });
    expect(editorDeleteChips(root, 'backward')).toEqual({ ids: ['a3'], caret: 2 });
    expect(editorText(root)).toBe('a b');
    expect(editorSelection(root)).toEqual({ start: 2, end: 2 });
});

it('deletes a chip covered by a non-empty selection', () => {
    editorSetText(root, 'a b');
    editorInsertChips(root, { start: 2, end: 2 }, [
        { kind: 'attachment', id: 'a4', label: '[Image 4]' }
    ]);
    expect(editorText(root)).toBe('a [Image 4] b');

    // The selection spans exactly the chip (text offsets keep atoms whole).
    editorSetSelection(root, { start: 2, end: 11 });
    expect(editorDeleteChips(root, 'backward')).toEqual({ ids: ['a4'], caret: 2 });
    expect(editorText(root)).toBe('a b');
    expect(editorChips(root)).toEqual([]);
    expect(editorSelection(root)).toEqual({ start: 2, end: 2 });
});

it('leaves ordinary text editing to the browser', () => {
    editorSetText(root, 'hello');

    editorSetSelection(root, { start: 3, end: 3 });
    expect(editorDeleteChips(root, 'backward')).toBeUndefined();
    expect(editorDeleteChips(root, 'forward')).toBeUndefined();

    // A plain-text selection deletes natively too (no chip to synchronize).
    editorSetSelection(root, { start: 1, end: 4 });
    expect(editorDeleteChips(root, 'forward')).toBeUndefined();
    expect(editorText(root)).toBe('hello');
});

it('keeps file and reference chips atomic on the same keystroke', () => {
    editorSetText(root, 'see ');
    editorInsertChips(root, { start: 4, end: 4 }, [
        { kind: 'file', id: 'file:src/a.ts', label: '@src/a.ts' }
    ]);
    expect(editorText(root)).toBe('see @src/a.ts');

    expect(editorDeleteChips(root, 'backward')).toEqual({
        ids: ['file:src/a.ts'],
        caret: 3
    });
    expect(editorText(root)).toBe('see');
    expect(editorChips(root)).toEqual([]);
});

it('collapses a deleted chip gap across empty text-node artifacts', () => {
    const before = document.createTextNode('a ');
    const firstArtifact = document.createTextNode('');
    const secondArtifact = document.createTextNode('');
    const after = document.createTextNode(' b');
    root.replaceChildren(before, firstArtifact, secondArtifact, after);

    // The MutationRecord points at the empty artifacts, not at the real neighbours.
    editorCollapseChipGap(firstArtifact, secondArtifact);

    expect(before.data).toBe('a');
    expect(after.data).toBe(' b');
    expect(editorText(root)).toBe('a b');
});
