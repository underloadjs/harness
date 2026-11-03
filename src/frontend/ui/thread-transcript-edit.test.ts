// C5 — editable thread transcript + the invalid-transcript state.
//
// What this file pins (the read-only document itself stays pinned by
// ui/thread-transcript.test.ts, which passes unchanged):
//   1. a VALID thread still opens the read-only document, and `Edit transcript` swaps
//      it for a `<textarea class="thread-transcript-editor">` holding EXACTLY the
//      pretty-printed editable value (the thread's `messages`) plus Save/Cancel/Copy;
//   2. a locally broken document shows `invalid JSON: <message>`, sends NO request, and
//      keeps the text and the editor;
//   3. a successful save sends the PARSED value, applies the returned session through
//      the board's snapshot path, and shows the transcript the answer carried;
//   4. a 200 whose `transcript.invalid` is set is a SUCCESS: the banner reads
//      `transcript unreadable: <error>`, the raw text stays exactly as sent, Save is
//      re-enabled and the dialog does not close;
//   5. a transport failure shows the server's own message, keeps the text and
//      re-enables Save;
//   6. a thread named in `session.invalidThreads` opens DIRECTLY in the editor (no
//      silent return) and the roster/focus panel/card state the unreadable transcript;
//   7. an unrelated snapshot frame NEVER replaces the textarea: the same node and the
//      reader's unsaved text survive a refresh, and an invalid state never closes it;
//   8. Copy in the editor writes the CURRENT textarea value, unsaved edits included.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-transcript-edit.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    HarnessMessage,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../../server/protocol';
import type { ThreadTranscriptPayload } from '../api';
import { sessionThreadsOf } from './threads';
import { createTurnBoard } from './turns';
import type { TurnBoard } from './turns';
import {
    closeThreadTranscript,
    openThreadTranscript,
    refreshOpenThreadTranscript
} from './thread-transcript';

const flush = (): Promise<void> => new Promise((next) => setTimeout(next, 0));

const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

const snapshotOf = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
    id: 's1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 10,
    messages: [],
    turns: [],
    threads: [],
    ...overrides
});

const threadOf = (overrides: Partial<SessionThread> & { id: string }): SessionThread => ({
    agent: 'Researcher',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    messages: [],
    ...overrides
});

const turnOf = (overrides: Partial<SessionTurn> & { id: string; index: number }): SessionTurn => ({
    prompt: 'go',
    status: 'done',
    startedAt: 1,
    updatedAt: 2,
    events: [],
    ...overrides
});

// The exact shape of `SessionSnapshot.invalidThreads` (C4, additive). The protocol
// type is not in this tree yet, so the fixtures carry the agreed record shape and the
// client reads it structurally (ui/threads.ts `invalidThreadsOf`).
type InvalidFixture = {
    id: string;
    label?: string;
    agent?: string;
    error: string;
    messages: unknown;
};

const withInvalid = (snapshot: SessionSnapshot, records: readonly InvalidFixture[]): SessionSnapshot =>
    ({ ...snapshot, invalidThreads: records }) as unknown as SessionSnapshot;

// Pretty JSON is the ONE definition of the editable document (the server's `raw` is
// the pretty JSON of the editable value), so the assertions name it exactly.
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const MESSAGES: HarnessMessage[] = [
    { role: 'system', content: 'child system instruction' },
    { role: 'user', content: 'child task' },
    { role: 'assistant', content: 'child answer' }
];

const childThread = threadOf({
    id: 'thread-child',
    agent: 'Helper',
    sequence: 2,
    label: 'RR2',
    messages: MESSAGES
});

const childTurn = turnOf({ id: 'turn-child', index: 0, threadId: 'thread-child' });

const childSnapshot = snapshotOf({ threads: [childThread], turns: [childTurn] });

// --- DOM helpers ------------------------------------------------------------

const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): TurnBoard => {
    const board = createTurnBoard(options);
    document.body.append(board.element);
    return board;
};

const useSnapshot = (board: TurnBoard, snapshot: SessionSnapshot): void => {
    board.bindSession(snapshot.id);
    board.setSessionSnapshot(snapshot);
    board.setThreads(sessionThreadsOf(snapshot));
};

const panelOf = (): HTMLElement => {
    const panel = document.querySelector<HTMLElement>('.dialog');
    if (panel === null) throw new Error('no transcript dialog');
    return panel;
};

const button = (root: ParentNode, selector: string): HTMLButtonElement => {
    const found = root.querySelector<HTMLButtonElement>(selector);
    if (found === null) throw new Error(`missing button ${selector}`);
    return found;
};

const editorOf = (root: ParentNode): HTMLTextAreaElement => {
    const found = root.querySelector<HTMLTextAreaElement>('.thread-transcript-editor');
    if (found === null) throw new Error('missing transcript editor');
    return found;
};

const errorOf = (root: ParentNode): HTMLElement => {
    const found = root.querySelector<HTMLElement>('.thread-transcript-error');
    if (found === null) throw new Error('missing transcript error area');
    return found;
};

const metaOf = (root: ParentNode): string =>
    root.querySelector<HTMLElement>('.thread-transcript-meta')?.textContent ?? '';

// Adopts and expands the child thread's turn, then presses its Transcript action —
// the only path a reader has to the dialog.
const openFromBoard = (board: TurnBoard): HTMLElement => {
    const turn = board.adopt(childTurn);
    board.expand(turn);
    const bar = turn.element.querySelector<HTMLElement>('.tile-transcript-action');
    if (bar === null) throw new Error('missing tile action bar');
    button(bar, '.transcript-open').click();

    return panelOf();
};

const typeInto = (editor: HTMLTextAreaElement, value: string): void => {
    editor.value = value;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
};

beforeEach(() => {
    setClipboard(undefined);
    document.body.replaceChildren();
});

afterEach(() => {
    setClipboard(undefined);
    document.body.replaceChildren();
});

// --- 1: the editor surface --------------------------------------------------

describe('transcript edit mode', () => {
    it('keeps the read-only document and swaps it for the exact editable JSON on Edit', () => {
        const board = mount();
        useSnapshot(board, childSnapshot);
        const panel = openFromBoard(board);

        // The default view is untouched: the lossless document, no editor, and the one
        // affordance that leaves it.
        expect(panel.querySelector('.thread-transcript-json')).not.toBeNull();
        expect(panel.querySelector('.thread-transcript-editor')).toBeNull();
        expect(metaOf(panel)).toBe('RR2 · Helper · idle · 1 turn · JSON snapshot');
        const edit = button(panel, '.thread-transcript-edit');
        expect(edit.textContent).toBe('Edit transcript');
        expect([...panel.querySelectorAll('.thread-transcript-actions > *')].map((node) => node.className)).toEqual([
            'thread-transcript-edit'
        ]);

        edit.click();

        // The editor holds ONLY the editable value (the thread's `messages`), pretty
        // printed — byte-identical to what the transcript route names `raw`.
        expect(editorOf(panel).value).toBe(pretty(MESSAGES));
        expect(panel.querySelector('.thread-transcript-json')).toBeNull();
        expect(metaOf(panel)).toBe('RR2 · Helper · idle · editing JSON');
        // No failure yet: the area is hidden, not removed, so the live region keeps
        // its announcement slot across attempts.
        expect(errorOf(panel).hidden).toBe(true);
        expect(errorOf(panel).textContent).toBe('');
        // The bar is exactly Save, Cancel, Copy in that order.
        expect([...panel.querySelectorAll('.thread-transcript-edit-actions > *')].map((node) => node.className)).toEqual(
            [
                'thread-transcript-save',
                'thread-transcript-cancel',
                'text-copy thread-transcript-copy'
            ]
        );
        expect(button(panel, '.thread-transcript-save').textContent).toBe('Save');
        expect(button(panel, '.thread-transcript-cancel').textContent).toBe('Cancel');
        expect(document.querySelectorAll('.dialog').length).toBe(1);

        // Cancel discards the draft and returns to the document.
        button(panel, '.thread-transcript-cancel').click();
        expect(panel.querySelector('.thread-transcript-editor')).toBeNull();
        expect(panel.querySelector('.thread-transcript-json')).not.toBeNull();
    });

    it('disables Save and says so when the host does not wire a save transport', () => {
        const board = mount();
        useSnapshot(board, childSnapshot);
        const panel = openFromBoard(board);
        button(panel, '.thread-transcript-edit').click();

        const save = button(panel, '.thread-transcript-save');
        expect(save.disabled).toBe(true);
        expect(save.title).toBe('Transcript saving is not wired in this host.');
    });
});

// --- 2/3/4/5: the save flow -------------------------------------------------

describe('saving the transcript', () => {
    const savedMessages: HarnessMessage[] = [{ role: 'user', content: 'repaired' }];

    const savedSnapshot = snapshotOf({
        updatedAt: 20,
        threads: [threadOf({ ...childThread, messages: savedMessages })],
        turns: [childTurn]
    });

    const payloadOf = (overrides: Partial<ThreadTranscriptPayload> = {}): ThreadTranscriptPayload => ({
        threadId: 'thread-child',
        agent: 'Helper',
        messages: savedMessages,
        raw: pretty(savedMessages),
        ...overrides
    });

    it('sends the parsed value, applies the returned session and shows the saved transcript', async () => {
        const calls: [string, string, unknown][] = [];
        const board = mount({
            saveThreadTranscript: async (sessionId, threadId, messages) => {
                calls.push([sessionId, threadId, messages]);
                // Exactly what main.ts `saveThreadTranscriptFor` does with the answer.
                board.setSessionSnapshot(savedSnapshot);
                board.setThreads(sessionThreadsOf(savedSnapshot));

                return payloadOf();
            }
        });
        useSnapshot(board, childSnapshot);
        const panel = openFromBoard(board);
        button(panel, '.thread-transcript-edit').click();

        const editor = editorOf(panel);
        typeInto(editor, pretty(savedMessages));

        const save = button(panel, '.thread-transcript-save');
        save.click();

        // Bound while in flight: the reader cannot stack a second PUT.
        expect(save.disabled).toBe(true);
        expect(save.title).toBe('Saving this transcript...');
        save.click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-child', savedMessages]]);
        // The editor (and its controls) are replaced by the saved document, so Save is
        // no longer on screen at all — re-enabled where the editor survives (below).
        expect(panel.querySelector('.thread-transcript-save')).toBeNull();

        // The PUT answer is the newest authority for the editable value.
        expect(panel.querySelector('.thread-transcript-editor')).toBeNull();
        expect(panel.querySelector<HTMLElement>('.thread-transcript-json')?.textContent).toBe(
            pretty(savedMessages)
        );
        expect(metaOf(panel)).toBe('RR2 · Helper · 1 message · saved transcript');

        // The applied snapshot then upgrades the view to the full lossless document
        // built from the SAVED messages — proof the session really landed.
        board.setSessionSnapshot(snapshotOf({ ...savedSnapshot, updatedAt: 21 }));
        const pre = panel.querySelector<HTMLElement>('.thread-transcript-json');
        const shown = JSON.parse(pre?.textContent ?? '{}') as {
            schema: string;
            thread: { messages: HarnessMessage[] };
            turns: { id: string }[];
        };
        expect(shown.schema).toBe('underload.harness.thread-transcript');
        expect(shown.thread.messages).toEqual(savedMessages);
        expect(shown.turns.map((turn) => turn.id)).toEqual(['turn-child']);
        expect(pre?.getAttribute('aria-label')).toBe('JSON transcript of thread RR2');
        expect(metaOf(panel)).toBe('RR2 · Helper · idle · 1 turn · JSON snapshot');
    });

    it('reports a local parse error without calling the API and keeps the text', async () => {
        const calls: unknown[] = [];
        const board = mount({
            saveThreadTranscript: async (_sessionId, _threadId, messages) => {
                calls.push(messages);

                return payloadOf();
            }
        });
        useSnapshot(board, childSnapshot);
        const panel = openFromBoard(board);
        button(panel, '.thread-transcript-edit').click();

        const editor = editorOf(panel);
        const broken = '[{"role": "user",,}]';
        typeInto(editor, broken);
        button(panel, '.thread-transcript-save').click();
        await flush();

        // The exact message the engine produces for this text (no fuzzy match): the
        // dialog prefixes it with `invalid JSON:` and passes the reason through.
        let expected = '';
        try {
            JSON.parse(broken);
        } catch (error) {
            expected = `invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
        }

        const error = errorOf(panel);
        expect(error.textContent).toBe(expected);
        expect(error.hidden).toBe(false);
        expect(error.dataset.tone).toBe('local');
        // Nothing left this page, and nothing was lost.
        expect(calls).toEqual([]);
        expect(editorOf(panel)).toBe(editor);
        expect(editor.value).toBe(broken);
        expect(panel.querySelector('.thread-transcript-json')).toBeNull();
    });

    it('keeps the raw text and shows the banner when the saved transcript is invalid', async () => {
        const calls: unknown[] = [];
        const board = mount({
            saveThreadTranscript: async (_sessionId, _threadId, messages) => {
                calls.push(messages);

                return payloadOf({
                    messages: [],
                    raw: pretty({ nope: true }),
                    invalid: { error: 'messages is not a harness transcript', messages: { nope: true } }
                });
            }
        });
        useSnapshot(board, childSnapshot);
        const panel = openFromBoard(board);
        button(panel, '.thread-transcript-edit').click();

        // A structurally impossible value is still valid JSON: the reader broke the
        // STRUCTURE, and the server accepted it anyway.
        const text = pretty({ nope: true });
        const editor = editorOf(panel);
        typeInto(editor, text);
        const save = button(panel, '.thread-transcript-save');
        save.click();
        await flush();

        expect(calls).toEqual([{ nope: true }]);
        // The write landed: a banner about the stored state, not a retryable failure.
        expect(errorOf(panel).textContent).toBe(
            'transcript unreadable: messages is not a harness transcript'
        );
        expect(errorOf(panel).dataset.tone).toBe('server');
        expect(errorOf(panel).hidden).toBe(false);
        // The dialog is NOT closed and the text is exactly what was sent.
        expect(document.querySelectorAll('.dialog').length).toBe(1);
        expect(editorOf(panel)).toBe(editor);
        expect(editor.value).toBe(text);
        expect(save.disabled).toBe(false);
    });

    it('shows the server error and keeps the text when the request fails', async () => {
        const board = mount({
            saveThreadTranscript: async () => {
                throw new Error('a running thread cannot have its transcript replaced');
            }
        });
        useSnapshot(board, childSnapshot);
        const panel = openFromBoard(board);
        button(panel, '.thread-transcript-edit').click();

        const text = pretty(MESSAGES);
        const editor = editorOf(panel);
        typeInto(editor, text);
        const save = button(panel, '.thread-transcript-save');
        save.click();
        await flush();

        expect(errorOf(panel).textContent).toBe(
            'a running thread cannot have its transcript replaced'
        );
        expect(errorOf(panel).dataset.tone).toBe('request');
        expect(editorOf(panel)).toBe(editor);
        expect(editor.value).toBe(text);
        expect(save.disabled).toBe(false);
        expect(panel.querySelector('.thread-transcript-json')).toBeNull();
    });

    it('clears the failure banner as soon as the reader edits again', async () => {
        const board = mount({
            saveThreadTranscript: async () => {
                throw new Error('provider unavailable');
            }
        });
        useSnapshot(board, childSnapshot);
        const panel = openFromBoard(board);
        button(panel, '.thread-transcript-edit').click();
        button(panel, '.thread-transcript-save').click();
        await flush();

        expect(errorOf(panel).textContent).toBe('provider unavailable');
        typeInto(editorOf(panel), '[]');
        expect(errorOf(panel).hidden).toBe(true);
        expect(errorOf(panel).textContent).toBe('');
    });
});

// --- 6: the unreadable transcript ------------------------------------------

describe('unreadable transcript', () => {
    const brokenRecord: InvalidFixture = {
        id: 'thread-broken',
        label: 'RR9',
        agent: 'Helper',
        error: 'messages is not an array of harness messages',
        messages: { nope: true }
    };

    const brokenSnapshot = withInvalid(snapshotOf({ threads: [childThread], turns: [childTurn] }), [
        brokenRecord
    ]);

    it('joins the invalid roster onto the thread entries without inventing messages', () => {
        const entries = sessionThreadsOf(brokenSnapshot);

        // The readable thread keeps its transcript; the unreadable conversation is
        // ADDED, so it can still be focused, deleted and repaired.
        expect(entries.map((entry) => entry.id)).toEqual(['thread-child', 'thread-broken']);
        expect(entries[0].invalid).toBeUndefined();
        expect(entries[1]).toEqual({
            id: 'thread-broken',
            agent: 'Helper',
            origin: 'host',
            status: 'idle',
            sequence: 2,
            label: 'RR9',
            invalid: {
                id: 'thread-broken',
                label: 'RR9',
                agent: 'Helper',
                error: brokenRecord.error,
                messages: { nope: true }
            }
        });
        // No `messages` are invented for a value that is not a transcript.
        expect(entries[1].messages).toBeUndefined();
        // A snapshot without the field is byte-identical to the pre-C5 roster.
        expect(sessionThreadsOf(childSnapshot)).toEqual(sessionThreadsOf(snapshotOf({ threads: [childThread] })));
    });

    it('marks the focus panel and opens the editor directly instead of returning silently', () => {
        const board = mount();
        useSnapshot(board, brokenSnapshot);

        expect(board.focusThread('thread-broken')).toBe(true);
        const panel = document.querySelector<HTMLElement>('.thread-focus-panel');
        if (panel === null) throw new Error('missing focus panel');
        expect(panel.dataset.invalid).toBe('true');
        expect(panel.querySelector('.thread-focus-invalid')?.textContent).toBe('transcript unreadable');
        expect(panel.querySelector('.thread-focus-invalid-note')?.textContent).toBe(
            'transcript unreadable: messages is not an array of harness messages. Use Transcript to edit the raw JSON.'
        );

        const bar = panel.querySelector<HTMLElement>(':scope > .thread-focus-actions');
        if (bar === null) throw new Error('missing focus action bar');
        const open = button(bar, '.transcript-open');
        expect(open.dataset.invalid).toBe('true');
        expect(open.getAttribute('aria-label')).toBe(
            'Open the unreadable transcript JSON of RR9 to repair it'
        );

        open.click();

        const transcript = panelOf();
        // Straight into the editor: there is no readable document to show, and the raw
        // stored value is exactly what the reader has to fix.
        expect(transcript.querySelector('.thread-transcript-json')).toBeNull();
        expect(editorOf(transcript).value).toBe(pretty({ nope: true }));
        expect(metaOf(transcript)).toBe('RR9 · Helper · unknown · editing JSON');
        const error = errorOf(transcript);
        expect(error.textContent).toBe(
            'transcript unreadable: messages is not an array of harness messages'
        );
        expect(error.dataset.tone).toBe('server');
        expect(error.hidden).toBe(false);
    });

    it('marks the conversation card and prefers the invalid state over the placeholder row', () => {
        // The shape where the server keeps the roster row AND names the thread
        // invalid: its `messages` is a placeholder, so the document would lie.
        const snapshot = withInvalid(snapshotOf({ threads: [childThread], turns: [childTurn] }), [
            {
                id: 'thread-child',
                label: 'RR2',
                agent: 'Helper',
                error: 'messages is not an array',
                messages: 'nope'
            }
        ]);
        const board = mount();
        board.bindSession(snapshot.id);
        board.setSessionSnapshot(snapshot);
        board.reconcile(snapshot.turns);
        board.setThreads(sessionThreadsOf(snapshot));

        const card = document.querySelector<HTMLElement>('.conversation[data-thread-id="thread-child"]');
        if (card === null) throw new Error('missing conversation card');
        expect(card.dataset.invalid).toBe('true');

        const turn = board.turns()[0];
        board.expand(turn);
        const bar = turn.element.querySelector<HTMLElement>('.tile-transcript-action');
        if (bar === null) throw new Error('missing tile action bar');
        button(bar, '.transcript-open').click();

        const panel = panelOf();
        expect(panel.querySelector('.thread-transcript-json')).toBeNull();
        // A scalar stored value still edits in its JSON spelling, so what the reader
        // sees is what Save would send back.
        expect(editorOf(panel).value).toBe('"nope"');
        expect(errorOf(panel).textContent).toBe('transcript unreadable: messages is not an array');
    });

    it('offers nothing for a thread the snapshot names neither way', () => {
        expect(openThreadTranscript(childSnapshot, 'missing')).toBeUndefined();
        expect(openThreadTranscript(withInvalid(childSnapshot, [brokenRecord]), 'missing')).toBeUndefined();
        expect(document.querySelector('.dialog')).toBeNull();
    });
});

// --- 7/8: refresh survival and the editor's Copy ----------------------------

describe('editor survival and copy', () => {
    const scope = {};

    it('keeps unsaved text and the same textarea across a snapshot refresh', () => {
        const handle = openThreadTranscript(childSnapshot, 'thread-child', scope, {
            onSave: async () => ({ threadId: 'thread-child', agent: 'Helper', messages: [], raw: '[]' })
        });
        if (handle === undefined) throw new Error('transcript did not open');

        button(handle.element, '.thread-transcript-edit').click();
        const editor = editorOf(handle.element);
        typeInto(editor, '["draft"]');

        // A newer authority of the SAME session (the ordinary snapshot/stream frame):
        // the identity follows it, the reader's text does not move.
        expect(
            refreshOpenThreadTranscript(
                snapshotOf({
                    updatedAt: 42,
                    status: 'error',
                    lastError: 'provider exploded',
                    threads: [threadOf({ ...childThread, status: 'stopped' })],
                    turns: [childTurn]
                }),
                scope
            )
        ).toBe('updated');

        expect(editorOf(handle.element)).toBe(editor);
        expect(editor.value).toBe('["draft"]');
        expect(metaOf(handle.element)).toBe('RR2 · Helper · stopped · editing JSON');
        expect(handle.element.querySelector('.thread-transcript-json')).toBeNull();
    });

    it('returns to the document when a refresh makes an unreadable transcript readable again', () => {
        const invalidSnapshot = withInvalid(childSnapshot, [
            { id: 'thread-child', error: 'messages is not an array', messages: { nope: true } }
        ]);
        const handle = openThreadTranscript(invalidSnapshot, 'thread-child', scope);
        if (handle === undefined) throw new Error('transcript did not open');

        // Opened in the editor, because the stored value cannot be read.
        expect(handle.element.querySelector('.thread-transcript-editor')).not.toBeNull();
        expect(handle.element.querySelector<HTMLElement>('.thread-transcript-error')?.hidden).toBe(false);

        expect(refreshOpenThreadTranscript(childSnapshot, scope)).toBe('updated');
        expect(handle.isOpen).toBe(true);
        // Nothing was typed, so the view returns to the lossless document and the
        // editor's error area leaves with it.
        expect(handle.element.querySelector('.thread-transcript-editor')).toBeNull();
        expect(handle.element.querySelector('.thread-transcript-json')).not.toBeNull();
        expect(handle.element.querySelector('.thread-transcript-error')).toBeNull();
    });

    it('never closes the dialog on a transient invalid state and keeps the draft', () => {
        const handle = openThreadTranscript(childSnapshot, 'thread-child', scope);
        if (handle === undefined) throw new Error('transcript did not open');

        button(handle.element, '.thread-transcript-edit').click();
        const editor = editorOf(handle.element);
        typeInto(editor, '["mid-repair"]');

        expect(
            refreshOpenThreadTranscript(
                withInvalid(childSnapshot, [
                    {
                        id: 'thread-child',
                        label: 'RR2',
                        agent: 'Helper',
                        error: 'messages is not an array',
                        messages: { nope: true }
                    }
                ]),
                scope
            )
        ).toBe('updated');

        expect(handle.isOpen).toBe(true);
        expect(editorOf(handle.element)).toBe(editor);
        expect(editor.value).toBe('["mid-repair"]');
        expect(errorOf(handle.element).textContent).toBe('transcript unreadable: messages is not an array');
        expect(errorOf(handle.element).dataset.tone).toBe('server');
    });

    it('moves an open document view to the editor when a refresh breaks the transcript', () => {
        const handle = openThreadTranscript(childSnapshot, 'thread-child', scope);
        if (handle === undefined) throw new Error('transcript did not open');

        // Reading the lossless document.
        expect(handle.element.querySelector('.thread-transcript-editor')).toBeNull();
        expect(handle.element.querySelector('.thread-transcript-json')).not.toBeNull();

        expect(
            refreshOpenThreadTranscript(
                withInvalid(childSnapshot, [
                    {
                        id: 'thread-child',
                        label: 'RR2',
                        agent: 'Helper',
                        error: 'messages is not an array',
                        messages: { nope: true }
                    }
                ]),
                scope
            )
        ).toBe('updated');

        // The document is gone, so the dialog shows the repair surface instead: same
        // dialog, raw value, and the unreadable banner.
        expect(handle.isOpen).toBe(true);
        expect(handle.element.querySelector('.thread-transcript-json')).toBeNull();
        expect(editorOf(handle.element).value).toBe(pretty({ nope: true }));
        expect(errorOf(handle.element).textContent).toBe('transcript unreadable: messages is not an array');
        expect(errorOf(handle.element).dataset.tone).toBe('server');
        expect(document.querySelectorAll('.dialog').length).toBe(1);
    });

    it('copies the editor text including unsaved edits', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        const handle = openThreadTranscript(childSnapshot, 'thread-child', scope);
        if (handle === undefined) throw new Error('transcript did not open');

        button(handle.element, '.thread-transcript-edit').click();
        const editor = editorOf(handle.element);
        typeInto(editor, '["unsaved"]');

        button(handle.element, '.thread-transcript-copy').click();
        await flush();

        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith('["unsaved"]');
    });

    it('closes only this board\'s transcript and drops the tracking', () => {
        const handle = openThreadTranscript(childSnapshot, 'thread-child', scope);
        if (handle === undefined) throw new Error('transcript did not open');

        expect(closeThreadTranscript(scope, ['thread-child'])).toBe(true);
        expect(handle.isOpen).toBe(false);
        // A late refresh for a closed dialog is ignored, never a reopen.
        expect(refreshOpenThreadTranscript(childSnapshot, scope)).toBe('ignored');
    });
});
