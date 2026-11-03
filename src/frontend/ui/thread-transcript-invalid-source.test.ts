// C6 — the editor's source of truth for an UNREADABLE transcript is the raw value.
//
// The server keeps TWO copies of a broken thread's transcript, and only one of them is
// the thing the reader came to fix:
//
//   - `SessionSnapshot.threads[].messages` and `transcript.messages`
//       the PLACEHOLDER the store installs so the session stays runnable and the model
//       path keeps working: `[{ role: 'system', content: '[transcript unreadable: …]' }]`
//       (src/server/sessions.ts `unreadableTranscript`);
//   - `SessionSnapshot.invalidThreads[].messages` / `transcript.invalid.messages`
//       the operator's value EXACTLY as stored, opaque, whatever made it unreadable
//       (src/server/protocol.ts `SessionInvalidThread`).
//
// If the dialog edited the first, opening an unreadable transcript would silently
// discard the user's JSON and Save would write the placeholder back as a "repair". This
// file pins the second — on both paths a reader reaches the dialog through: the direct
// `openThreadTranscript` call and the board's tile action (ui/turns.ts
// `openTranscriptOf`), whose freshness `getSession` refresh must also keep the raw text.
//
// It also pins the C6 scope line the editor states above the field: a save replaces
// ONLY these messages, while the read-only document shows turns, events and steers that
// belong to session history.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-transcript-invalid-source.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HarnessMessage, SessionSnapshot, SessionThread, SessionTurn } from '../../server/protocol';
import { sessionThreadsOf } from './threads';
import { createTurnBoard } from './turns';
import type { TurnBoard } from './turns';
import { openThreadTranscript, THREAD_TRANSCRIPT_SAVE_NOTE } from './thread-transcript';

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

// The exact placeholder the store mints (sessions.ts lines 568-572), kept here as the
// literal string so a placeholder leaking into the editor cannot match by accident.
const ERROR = 'thread "thread-a" messages[1].role must be "user" | "assistant" | "system" | "tool"';
const PLACEHOLDER: HarnessMessage[] = [
    { role: 'system', content: `[transcript unreadable: ${ERROR}]` }
];

// The stored value that produced that refusal: one good turn and one hand typo. This is
// the text that must be on screen, because it is the only copy left.
const RAW = [
    { role: 'user', content: 'keep me' },
    { role: 'robot', content: 'the typo the reader has to fix' }
];

const snapshotWithInvalid = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
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
    }) as unknown as SessionSnapshot;

// The server's real shape for an unreadable thread: the roster row SURVIVES (with the
// placeholder) and the same id is named in `invalidThreads`.
const brokenSnapshot = (): SessionSnapshot =>
    snapshotWithInvalid({
        threads: [
            {
                id: 'thread-a',
                agent: 'instruct',
                origin: 'host',
                status: 'idle',
                sequence: 1,
                label: 'IN1',
                messages: PLACEHOLDER
            } as unknown as SessionThread
        ],
        turns: [
            {
                id: 'turn-a',
                index: 0,
                prompt: 'keep me',
                threadId: 'thread-a',
                status: 'done',
                startedAt: 1,
                updatedAt: 2,
                events: []
            } as unknown as SessionTurn
        ],
        invalidThreads: [{ id: 'thread-a', label: 'IN1', agent: 'instruct', error: ERROR, messages: RAW }]
    });

const readableSnapshot = (): SessionSnapshot =>
    snapshotWithInvalid({
        threads: [
            {
                id: 'thread-b',
                agent: 'instruct',
                origin: 'host',
                status: 'idle',
                sequence: 2,
                label: 'IN2',
                messages: [{ role: 'user', content: 'plain' }]
            } as unknown as SessionThread
        ],
        turns: [
            {
                id: 'turn-b',
                index: 0,
                prompt: 'plain',
                threadId: 'thread-b',
                status: 'done',
                startedAt: 1,
                updatedAt: 2,
                events: []
            } as unknown as SessionTurn
        ]
    });

const panelOf = (): HTMLElement => {
    const panel = document.querySelector<HTMLElement>('.dialog');
    if (panel === null) throw new Error('no transcript dialog');
    return panel;
};

const editorOf = (root: ParentNode): HTMLTextAreaElement => {
    const found = root.querySelector<HTMLTextAreaElement>('.thread-transcript-editor');
    if (found === null) throw new Error('missing transcript editor');
    return found;
};

const button = (root: ParentNode, selector: string): HTMLButtonElement => {
    const found = root.querySelector<HTMLButtonElement>(selector);
    if (found === null) throw new Error(`missing button ${selector}`);
    return found;
};

// The board path: adopt the record, expand it, press the tile's Transcript action.
const openFromBoard = (snapshot: SessionSnapshot, threadId: string): HTMLElement => {
    const board: TurnBoard = createTurnBoard({ empty: document.createElement('div') });
    document.body.append(board.element);
    board.bindSession(snapshot.id);
    board.setSessionSnapshot(snapshot);
    board.reconcile(snapshot.turns);
    board.setThreads(sessionThreadsOf(snapshot));

    const card = document.querySelector<HTMLElement>(`.conversation[data-thread-id="${threadId}"]`);
    if (card === null) throw new Error(`missing conversation card for ${threadId}`);
    expect(card.dataset.invalid).toBe('true');

    const [turn] = board.turns();
    board.expand(turn);
    const bar = turn.element.querySelector<HTMLElement>('.tile-transcript-action');
    if (bar === null) throw new Error('missing tile action bar');
    button(bar, '.transcript-open').click();

    return panelOf();
};

beforeEach(() => {
    document.body.replaceChildren();
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('the unreadable editor holds the raw stored value', () => {
    it('opens directly in the editor with the operator JSON, never the placeholder', () => {
        const snapshot = brokenSnapshot();
        const handle = openThreadTranscript(snapshot, 'thread-a', {});
        if (handle === undefined) throw new Error('the unreadable transcript did not open');

        const panel = handle.element;
        // There is no readable document for an unreadable thread, so the editor IS the
        // surface (a `<pre>` here would render the placeholder and lie).
        expect(panel.querySelector('.thread-transcript-json')).toBeNull();

        const editor = editorOf(panel);
        expect(editor.value).toBe(pretty(RAW));
        expect(editor.value).toContain('keep me');
        expect(editor.value).toContain('robot');
        // The placeholder text appears ONLY in the banner's error, never in the field.
        expect(editor.value).not.toContain('[transcript unreadable');

        expect(panel.querySelector<HTMLElement>('.thread-transcript-error')?.textContent).toBe(
            `transcript unreadable: ${ERROR}`
        );

        handle.close();
    });

    it('keeps the raw value through the board action and its getSession refresh', () => {
        const snapshot = brokenSnapshot();
        const panel = openFromBoard(snapshot, 'thread-a');

        // The board's own snapshot source (which the shell replaces with the GET answer)
        // carries the same roster, so the field is unchanged by the refresh.
        expect(editorOf(panel).value).toBe(pretty(RAW));
        expect(panel.querySelector('.thread-transcript-json')).toBeNull();
        expect(panel.querySelector<HTMLElement>('.thread-transcript-error')?.textContent).toBe(
            `transcript unreadable: ${ERROR}`
        );
        // What Save would send is exactly what is on screen: the parsed raw value.
        expect(JSON.parse(editorOf(panel).value)).toEqual(RAW);

        panel.querySelector<HTMLElement>('.dialog-close')?.click();
    });

    it('a save that stays unreadable keeps the submitted text rather than the new placeholder', async () => {
        const snapshot = brokenSnapshot();
        const edited = pretty([{ role: 'user', content: 'keep me' }, { role: 'assistant' }]);
        const sent: unknown[] = [];
        // The host transport resolves with the TRANSCRIPT DOCUMENT, not the route's
        // `{ session, transcript }` envelope: `main.ts#saveThreadTranscriptFor` unwraps
        // it after applying `session` (api.ts `updateThreadTranscript` returns both).
        const handle = openThreadTranscript(snapshot, 'thread-a', {}, {
            onSave: async (messages: unknown) => {
                sent.push(messages);

                return {
                    // The server's real answer for a still-broken write: the placeholder
                    // is now the live transcript, and `invalid` carries what was sent.
                    threadId: 'thread-a',
                    agent: 'instruct',
                    messages: PLACEHOLDER,
                    raw: edited,
                    invalid: { error: 'messages[1] must have content', messages: JSON.parse(edited) }
                };
            }
        });
        if (handle === undefined) throw new Error('the unreadable transcript did not open');

        const editor = editorOf(handle.element);
        editor.value = edited;
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        button(handle.element, '.thread-transcript-save').click();

        // Let the awaited transport resolve, then assert the painted state.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Exactly the parsed raw value leaves the dialog.
        expect(sent).toEqual([JSON.parse(edited)]);
        expect(editorOf(handle.element).value).toBe(edited);
        expect(handle.element.querySelector<HTMLElement>('.thread-transcript-error')?.textContent).toBe(
            'transcript unreadable: messages[1] must have content'
        );
        // The placeholder never becomes the editor's text, and the read document (which
        // would show the placeholder row) is not offered either.
        expect(handle.element.querySelector('.thread-transcript-json')).toBeNull();
        expect(editorOf(handle.element).value).not.toContain('[transcript unreadable');

        handle.close();
    });
});

describe('the edit-mode scope note', () => {
    it('states that only the transcript messages are saved, in every edit surface', () => {
        // The invalid thread opens in the editor directly.
        const unreadable = openThreadTranscript(brokenSnapshot(), 'thread-a', {});
        expect(
            unreadable?.element.querySelector<HTMLElement>('.thread-transcript-note')?.textContent
        ).toBe(THREAD_TRANSCRIPT_SAVE_NOTE);
        unreadable?.close();

        // A readable thread reaches the same editor through the Edit control, and the
        // note repeats there: the document it came from shows turns and events, and a
        // save changes none of them.
        const readable = openThreadTranscript(readableSnapshot(), 'thread-b', {});
        expect(readable?.element.querySelector('.thread-transcript-note')).toBeNull();
        button(readable?.element as ParentNode, '.thread-transcript-edit').click();

        const panel = panelOf();
        expect(panel.querySelector('.thread-transcript-editor')).not.toBeNull();
        expect(panel.querySelector<HTMLElement>('.thread-transcript-note')?.textContent).toBe(
            'Save replaces only this thread\'s transcript messages. Turns and events are session history and are never changed.'
        );

        // The note is disclosure in its own element: it never contaminates the copied
        // document or the value Save parses.
        expect(editorOf(panel).value).toBe(pretty([{ role: 'user', content: 'plain' }]));
        readable?.close();
    });
});
