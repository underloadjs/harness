// T6/R5 — responsive thread Delete: ONE press on a proven desktop, a shared dialog
// everywhere else.
//
// Pins (ui/turns.ts `requiresDeleteConfirmation`, `requestThreadDelete`,
// `openThreadDeleteConfirmation`, `closeThreadDeleteConfirmation`):
//   - the waiver is a PROOF, not a default: an immediate Delete needs the viewport to be
//     positively wide (`(max-width: 860px)` does NOT match — the shell's own layout
//     breakpoint, main.ts `phoneMedia` / ui/composer.ts `COMPOSER_MOBILE_WIDTH`) AND the
//     primary pointer to be positively fine (`(pointer: fine)`, main.ts
//     `finePointerMedia`). Narrow, coarse, `none`, a throwing `matchMedia` and an absent
//     `matchMedia` (this jsdom) all keep the confirmation;
//   - both queries are sampled at CLICK time, so resizing or rotating between presses
//     changes the answer without any re-import;
//   - a desktop press sends exactly one callback and opens NO layer;
//   - any other press sends NOTHING and opens the shared `openDialog` layer (ui/dialog
//     .ts) with the exact warning sentence, a `Delete thread` action and a `Cancel`
//     action — and no inline row anywhere in the bar;
//   - Cancel, Escape, the backdrop and the header close all mean "no": no request, the
//     layer is gone, and focus returns to the Delete control that was pressed;
//   - one pending confirmation per conversation: a second press for the SAME thread does
//     not stack a second dialog, and a press for a DIFFERENT conversation replaces the
//     layer instead of stacking it;
//   - everything that already protected the request survives the move: default/active
//     protection never opens a dialog, an unwired host never opens one, an in-flight
//     thread never starts a second request, and a failed DELETE leaves the conversation
//     intact and retryable;
//   - a session switch or a cleared board dismisses the layer instead of leaving a dialog
//     that names a conversation this board no longer shows.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-delete-confirmation.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    DeleteThreadResult,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../../server/protocol';
import type { TurnBoard, TurnHandle } from './turns';
import { createTurnBoard, requiresDeleteConfirmation } from './turns';
import { sessionThreadsOf } from './threads';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Exact indexed access: a missing fixture item is a hard error, never a silently
// `undefined` handle that a later assertion would shrug off.
const at = <T>(items: readonly T[], index: number): T => {
    const item = items[index];
    if (item === undefined) throw new Error(`missing item at index ${index}`);
    return item;
};

// --- fixtures ---------------------------------------------------------------

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

// One deletable host conversation plus its turn, in the shape the board's own delete
// protection reads (idle roster row, terminal turn).
const targetSnapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    snapshotOf({
        threads: [threadOf({ id: 'thread-a', label: 'RR1', messages: [] })],
        turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a' })],
        ...overrides
    });

// --- DOM helpers ------------------------------------------------------------

const actionButton = (root: ParentNode, selector: string): HTMLButtonElement => {
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (button === null) throw new Error(`missing button ${selector}`);
    return button;
};

// T26 anatomy: a tile is exactly `select → bar → body`, so the bar is a scoped child.
const barOf = (turn: TurnHandle): HTMLElement => {
    const bar = turn.element.querySelector<HTMLElement>(':scope > .tile-transcript-action');
    if (bar === null) throw new Error('missing thread action bar');
    return bar;
};

const deleteOf = (turn: TurnHandle): HTMLButtonElement =>
    actionButton(barOf(turn), '.thread-delete');

// The confirmation is the shared dialog layer (ui/dialog.ts). Selection is by CONTENT,
// so a transcript layer stacked underneath can never be mistaken for it.
const deleteDialogs = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.dialog')).filter(
        (panel) => panel.querySelector('.thread-delete-confirm') !== null
    );

const deleteDialog = (): HTMLElement => {
    const open = deleteDialogs();
    if (open.length !== 1) throw new Error(`expected one delete dialog, found ${open.length}`);
    return open[0];
};

const dialogTitle = (panel: ParentNode): string =>
    panel.querySelector<HTMLElement>('.dialog-title')?.textContent ?? '';

const dialogWarning = (panel: ParentNode): string =>
    panel.querySelector<HTMLElement>('.thread-delete-confirm-body')?.textContent ?? '';

// The confirmation's own buttons, in DOM order. The shell's `×` lives in `.dialog-head`,
// so `.dialog-body button` is exactly the two actions.
const dialogActions = (panel: ParentNode): string[] =>
    Array.from(panel.querySelectorAll<HTMLButtonElement>('.dialog-body button')).map(
        (button) => button.textContent ?? ''
    );

// A browser dispatches a key on the focused node and lets it bubble to the document,
// which is where the dialog's capture-phase listener lives (ui/dialog.test.ts).
const pressKey = (target: Element, key: string): void => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

const overlayOf = (panel: HTMLElement): HTMLElement => {
    const overlay = panel.parentElement;
    if (!(overlay instanceof HTMLElement)) throw new Error('dialog panel has no overlay');
    return overlay;
};

// --- device stub ------------------------------------------------------------

const PHONE_QUERY = '(max-width: 860px)';
const FINE_QUERY = '(pointer: fine)';

type Device = { phone: boolean; fine: boolean };

// This repo's jsdom has NO `window.matchMedia` at all (jsdom 29 — verified), which is the
// policy's UNKNOWN branch, so every unstubbed test here runs as "must confirm". A test
// that wants a specific device stubs the two queries the board samples. `matches` is
// resolved per `matchMedia` CALL from live state, so `set()` models a resize/rotation
// between presses without re-importing anything.
const stubDevice = (device: Device): { set: (next: Partial<Device>) => void } => {
    const state: Device = { ...device };

    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => ({
            media: query,
            matches: query === PHONE_QUERY ? state.phone : query === FINE_QUERY ? state.fine : false,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            onchange: null
        }))
    );

    return { set: (next: Partial<Device>) => Object.assign(state, next) };
};

// --- board harness ----------------------------------------------------------

type Harness = {
    board: TurnBoard;
    // One handle per snapshot turn, in recorded order (the tiles a reader sees).
    handles: TurnHandle[];
    calls: Array<[string, string]>;
    // One resolver per request, in request order: a test keeps the DELETE in flight by
    // simply not resolving it.
    pending: Array<(value: DeleteThreadResult) => void>;
};

// Mount a board with `deleteThread` wired to a recording transport, adopt every turn and
// expand the first one (expansion IS focus, and only an expanded tile shows its bar).
const mount = (
    snapshot: SessionSnapshot = targetSnapshot(),
    deleteThread?: (sessionId: string, threadId: string) => Promise<DeleteThreadResult>
): Harness => {
    const calls: Array<[string, string]> = [];
    const pending: Array<(value: DeleteThreadResult) => void> = [];

    const board = createTurnBoard({
        deleteThread:
            deleteThread ??
            ((sessionId, threadId) =>
                new Promise<DeleteThreadResult>((resolve) => {
                    calls.push([sessionId, threadId]);
                    pending.push(resolve);
                }))
    });
    document.body.replaceChildren(board.element);

    board.bindSession(snapshot.id);
    board.setSessionSnapshot(snapshot);
    board.setThreads(sessionThreadsOf(snapshot));

    const handles = snapshot.turns.map((record) => board.adopt(record));
    const expanded = handles[0];
    if (expanded !== undefined) board.expand(expanded);

    return { board, handles, calls, pending };
};

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    // Dismiss whatever layer a passing or failing assertion left behind: the dialog
    // module's layer stack and its reference-counted scroll lock must start empty.
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe('delete confirmation policy', () => {
    it('keeps the confirmation on every surface the page cannot prove is a desktop', () => {
        // No `matchMedia` at all (this jsdom, old engines, embedded shells): UNKNOWN.
        expect(requiresDeleteConfirmation()).toBe(true);

        // Wide viewport, NOT a fine pointer: a tablet at 1280px, or `(pointer: none)`
        // (keyboard-only / assistive tech) — asking the question positively is what keeps
        // both of these on the confirmation side.
        stubDevice({ phone: false, fine: false });
        expect(requiresDeleteConfirmation()).toBe(true);

        // Narrow viewport WITH a fine pointer: a desktop window dragged under 860px.
        stubDevice({ phone: true, fine: true });
        expect(requiresDeleteConfirmation()).toBe(true);

        // A `matchMedia` that answers without a boolean `matches` answered nothing.
        vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: 'no' })));
        expect(requiresDeleteConfirmation()).toBe(true);
    });

    it('waives the confirmation only for a proven wide fine-pointer desktop', () => {
        stubDevice({ phone: false, fine: true });
        expect(requiresDeleteConfirmation()).toBe(false);
    });

    it('treats a throwing matchMedia as unknown rather than as licence to delete', () => {
        vi.stubGlobal(
            'matchMedia',
            vi.fn(() => {
                throw new Error('stubbed failure');
            })
        );

        expect(requiresDeleteConfirmation()).toBe(true);
    });
});

describe('desktop thread Delete', () => {
    it('sends exactly one callback on the first press and opens no layer', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles, calls } = mount();
        const turn = at(handles, 0);

        deleteOf(turn).click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
        // The bar carries no inline confirmation row either: its children are exactly its
        // two actions, and nothing else in the document holds that class.
        expect([...barOf(turn).children].map((node) => node.className)).toEqual([
            'thread-delete',
            'transcript-open action-transcript'
        ]);
        expect(document.querySelectorAll('.thread-delete-confirm')).toHaveLength(0);
        // The conversation is still on screen while the request runs (the shell's
        // snapshot answer is what removes it).
        expect(board.turns()).toHaveLength(1);
    });

    it('sends no second request while the first is still in flight', async () => {
        stubDevice({ phone: false, fine: true });
        const { calls, handles, pending } = mount();
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        deleteButton.click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        expect(pending).toHaveLength(1);
        expect(deleteDialogs()).toHaveLength(0);

        // The bar states the live request instead of offering another destructive press.
        expect(deleteButton.disabled).toBe(true);
        expect(deleteButton.title).toBe('Deleting this thread...');

        pending[0]?.({ deleted: true, session: snapshotOf({ updatedAt: 11 }) });
        await flush();

        expect(calls).toHaveLength(1);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
    });

    it('keeps the thread and re-arms the same one-press rule after a failed request', async () => {
        stubDevice({ phone: false, fine: true });
        // The transport records the attempt and then refuses, exactly like the server's
        // 409 for live work: the board must keep everything and stay retryable.
        const attempts: Array<[string, string]> = [];
        const { board, handles } = mount(targetSnapshot(), async (sessionId, threadId) => {
            attempts.push([sessionId, threadId]);
            throw new Error('Thread "thread-a" still has live work.');
        });
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        await flush();

        const notice = board.element.querySelector<HTMLElement>('.notice');
        expect(notice?.dataset.tone).toBe('error');
        expect(notice?.textContent).toBe(
            'delete thread: Thread "thread-a" still has live work.'
        );
        // Nothing was dropped: the conversation, its focus and a usable control survive.
        expect(board.turns()).toHaveLength(1);
        expect(board.focusedThread()).toBe('thread-a');
        expect(deleteButton.disabled).toBe(false);
        expect(deleteDialogs()).toHaveLength(0);

        // Recovery is not a special state: the next desktop press deletes on its own.
        deleteButton.click();
        await flush();

        expect(attempts).toEqual([
            ['s1', 'thread-a'],
            ['s1', 'thread-a']
        ]);
        expect(document.querySelectorAll('.thread-delete-confirm')).toHaveLength(0);
    });
});

describe('mobile thread Delete', () => {
    it('sends nothing on the first press and opens the shared confirmation dialog', () => {
        stubDevice({ phone: true, fine: false });
        const { calls, handles } = mount();
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();

        expect(calls).toEqual([]);

        const panel = deleteDialog();
        expect(panel.getAttribute('role')).toBe('dialog');
        expect(panel.getAttribute('aria-modal')).toBe('true');
        expect(dialogTitle(panel)).toBe('Delete thread');
        expect(dialogWarning(panel)).toBe(
            'Delete thread RR1 permanently? Its turns and transcript are removed.'
        );
        expect(dialogActions(panel)).toEqual(['Delete thread', 'Cancel']);
        expect(
            panel.querySelector<HTMLElement>('.thread-delete-confirm')?.getAttribute('aria-label')
        ).toBe('Confirm deleting thread RR1');

        // The bar gained no inline row: the confirmation lives only inside the layer.
        expect(document.querySelectorAll('.tile-transcript-action .thread-delete-confirm')).toHaveLength(0);
    });

    it('sends exactly one request when the dialog is confirmed', async () => {
        stubDevice({ phone: true, fine: false });
        const { calls, handles, pending } = mount();
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        const confirm = actionButton(deleteDialog(), '.thread-delete-confirm-delete');
        confirm.click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        // The layer is spent: the dialog is gone, and the bar reports the live request.
        expect(deleteDialogs()).toHaveLength(0);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(deleteButton.disabled).toBe(true);

        // A synthetic press on the discarded body (jsdom reaches detached nodes a real
        // pointer cannot) cannot fire a second request, and the disabled bar cannot open
        // another dialog while the DELETE is in flight.
        confirm.click();
        deleteButton.click();
        await flush();

        expect(calls).toHaveLength(1);
        expect(deleteDialogs()).toHaveLength(0);

        pending[0]?.({ deleted: true, session: snapshotOf({ updatedAt: 11 }) });
        await flush();
        expect(calls).toHaveLength(1);
    });

    it('sends nothing and restores focus on Cancel', () => {
        stubDevice({ phone: true, fine: false });
        const { calls, handles } = mount();
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        actionButton(deleteDialog(), '.thread-delete-confirm-cancel').click();

        expect(calls).toEqual([]);
        expect(deleteDialogs()).toHaveLength(0);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(document.activeElement).toBe(deleteButton);

        // And the surface is usable again: the next press arms a fresh confirmation.
        deleteButton.click();
        expect(deleteDialogs()).toHaveLength(1);
        expect(calls).toEqual([]);
    });

    it('sends nothing on Escape, the backdrop or the header close', () => {
        stubDevice({ phone: true, fine: false });
        const { calls, handles } = mount();
        const deleteButton = deleteOf(at(handles, 0));

        for (const dismiss of ['escape', 'backdrop', 'header'] as const) {
            deleteButton.click();
            const panel = deleteDialog();

            if (dismiss === 'escape') pressKey(panel, 'Escape');
            else if (dismiss === 'backdrop') overlayOf(panel).click();
            else actionButton(panel, '.dialog-close').click();

            expect(calls).toEqual([]);
            expect(deleteDialogs()).toHaveLength(0);
            expect(document.querySelector('.dialog-overlay')).toBeNull();
            // Every dismissal lands back on the control the reader pressed.
            expect(document.activeElement).toBe(deleteButton);
        }
    });

    it('keeps one pending confirmation per conversation however often it is pressed', () => {
        stubDevice({ phone: true, fine: false });
        const { calls, handles } = mount();
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        deleteButton.click();
        actionButton(barOf(at(handles, 0)), '.thread-delete').click();

        expect(deleteDialogs()).toHaveLength(1);
        expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(1);

        actionButton(deleteDialog(), '.thread-delete-confirm-delete').click();
        expect(calls).toEqual([['s1', 'thread-a']]);
    });

    it('replaces the layer when a different conversation is pressed', async () => {
        stubDevice({ phone: true, fine: false });
        const { calls, handles } = mount(
            targetSnapshot({
                threads: [
                    threadOf({ id: 'thread-a', label: 'RR1', messages: [] }),
                    threadOf({ id: 'thread-b', label: 'RR2', messages: [] })
                ],
                turns: [
                    turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a' }),
                    turnOf({ id: 'turn-b', index: 1, threadId: 'thread-b' })
                ]
            })
        );
        const first = at(handles, 0);
        const second = at(handles, 1);

        deleteOf(first).click();
        expect(dialogWarning(deleteDialog())).toBe(
            'Delete thread RR1 permanently? Its turns and transcript are removed.'
        );

        // The second conversation replaces the confirmation instead of stacking an
        // identical modal on top of it.
        deleteOf(second).click();

        expect(deleteDialogs()).toHaveLength(1);
        expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(1);
        expect(dialogWarning(deleteDialog())).toBe(
            'Delete thread RR2 permanently? Its turns and transcript are removed.'
        );

        actionButton(deleteDialog(), '.thread-delete-confirm-delete').click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-b']]);
        expect(deleteDialogs()).toHaveLength(0);
    });

    it('never opens a dialog for a protected or unwired conversation', () => {
        stubDevice({ phone: true, fine: false });

        // Live work: the control stays visible but disabled, and a press cannot arm a
        // dialog that could only ever fail.
        const running = mount(
            targetSnapshot({
                threads: [threadOf({ id: 'thread-running', label: 'RR6', status: 'running', messages: [] })],
                turns: [
                    turnOf({ id: 'turn-running', index: 0, threadId: 'thread-running', status: 'running' })
                ]
            })
        );
        const runningDelete = deleteOf(at(running.handles, 0));
        expect(runningDelete.disabled).toBe(true);
        expect(runningDelete.title).toBe(
            'Stop the active or queued work in this thread before deleting it.'
        );
        runningDelete.click();
        expect(running.calls).toEqual([]);
        expect(deleteDialogs()).toHaveLength(0);

        // The agent's default conversation hides the control; it cannot be confirmed.
        const agent = mount(
            targetSnapshot({
                threads: [threadOf({ id: 'thread-agent', origin: 'agent', label: 'RR5', messages: [] })],
                turns: [turnOf({ id: 'turn-agent', index: 0, threadId: 'thread-agent' })]
            })
        );
        const agentDelete = deleteOf(at(agent.handles, 0));
        expect(agentDelete.hidden).toBe(true);
        agentDelete.click();
        expect(agent.calls).toEqual([]);
        expect(deleteDialogs()).toHaveLength(0);

        // No transport at all: an honest disabled control, never a dead-end dialog.
        const unwired = createTurnBoard();
        document.body.replaceChildren(unwired.element);
        const unwiredSnapshot = targetSnapshot();
        unwired.bindSession(unwiredSnapshot.id);
        unwired.setSessionSnapshot(unwiredSnapshot);
        unwired.setThreads(sessionThreadsOf(unwiredSnapshot));
        const unwiredTurn = unwired.adopt(at(unwiredSnapshot.turns, 0));
        unwired.expand(unwiredTurn);

        const unwiredDelete = deleteOf(unwiredTurn);
        expect(unwiredDelete.disabled).toBe(true);
        expect(unwiredDelete.title).toBe('Thread deletion is not wired in this host.');
        unwiredDelete.click();
        expect(unwired.focusedThread()).toBe('thread-a');
        expect(deleteDialogs()).toHaveLength(0);
    });

    it('dismisses the layer on a session switch and on a cleared board', () => {
        stubDevice({ phone: true, fine: false });

        const switched = mount();
        const switchedDelete = deleteOf(at(switched.handles, 0));
        switchedDelete.click();
        expect(deleteDialogs()).toHaveLength(1);

        switched.board.bindSession('s2');
        expect(deleteDialogs()).toHaveLength(0);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(switched.calls).toEqual([]);

        const cleared = mount();
        deleteOf(at(cleared.handles, 0)).click();
        expect(deleteDialogs()).toHaveLength(1);

        cleared.board.clear();
        expect(deleteDialogs()).toHaveLength(0);
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        expect(cleared.calls).toEqual([]);
    });
});

describe('the device between presses', () => {
    it('follows the surface as it changes rather than the one seen at import', async () => {
        // A phone press first: nothing is sent, the confirmation arms.
        const device = stubDevice({ phone: true, fine: false });
        const { calls, handles } = mount();
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        expect(calls).toEqual([]);
        expect(deleteDialogs()).toHaveLength(1);

        // The reader cancels, rotates to landscape and picks up a trackpad.
        actionButton(deleteDialog(), '.thread-delete-confirm-cancel').click();
        device.set({ phone: false, fine: true });

        deleteButton.click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        expect(deleteDialogs()).toHaveLength(0);

        // And the other way round: a coarse press after that owes a dialog again.
        device.set({ phone: false, fine: false });
        const second = mount();
        deleteOf(at(second.handles, 0)).click();

        expect(second.calls).toEqual([]);
        expect(deleteDialogs()).toHaveLength(1);
    });
});
