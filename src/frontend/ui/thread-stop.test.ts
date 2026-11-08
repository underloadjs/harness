// R1 — the per-thread Stop control: while a conversation (or one its Delete would
// cascade into) has live work, the action bar's ONE destructive button IS Stop.
//
// Pins (ui/turns.ts `isLiveThreadStatus`, `threadDeleteProtectionOf`,
// `createThreadActionBar`, `requestThreadStop`, `confirmThreadStop`):
//   - live work renders `Stop` (glyph `■`, `aria-label "Stop thread <NAME>"`, title
//     `Stop this thread`), never a disabled Delete with a "wait for it" hint;
//   - the class is ADDITIVE: `.thread-delete` is retained and `.thread-stop` is added, so
//     the bar keeps its children, in the same order, reachable by every selector
//     and stylesheet rule that already works (T4/R2 later added a third, permanent
//     `Resume` child between Delete and Transcript; the Stop morph still never changes the
//     destructive button's identity or its slot);
//   - one press sends exactly one `stopThread(sessionId, threadId)` and opens NOTHING —
//     no dialog, no two-press arming — on a proven desktop AND on every narrow/coarse
//     surface, because the delete-confirmation waiver (`requiresDeleteConfirmation`)
//     guards an irreversible removal, not a pause the server can resume;
//   - single flight: the control disables and relabels `Stopping…` while the promise is
//     pending, a press burst is one request, and a rejection is reported non-destructively
//     (no tile/focus/selection is lost) and the same control is pressable again;
//   - the control flips back to `Delete` from the ROSTER, not from a local flag: while the
//     roster still says live the button stays Stop, and once a newer frame reports the
//     conversation idle/terminal the same button performs today's delete flow unchanged;
//   - `'paused'` (compacting) counts as live work, and so does a running/paused DESCENDANT
//     the delete would cascade into — the stop is requested for the thread that was
//     pressed, and the server cascades;
//   - `origin: 'agent'` stays hidden (no Delete AND no Stop): it is internal plumbing, not
//     a conversation the reader can act on;
//   - an unwired host renders an honest disabled Stop with the reason, and a press does
//     nothing (exactly the rule the unwired Delete already follows).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-stop.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    DeleteThreadResult,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../../server/protocol';
import type { TurnBoard, TurnHandle } from './turns';
import { createTurnBoard, isLiveThreadStatus, threadDeleteProtectionOf } from './turns';
import { sessionThreadsOf, type SessionThreadEntry } from './threads';

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

// The roster's `status` field is a narrow union (`SessionThread.status`,
// server/protocol.ts:437; `SessionThreadEntry.status`, ui/threads.ts:65). `'paused'` is
// landing from the worker that owns that enum — it already exists as `HarnessThreadStatus`
// (src/types/index.ts:1915) — so BOTH fixtures below widen the status at the FIXTURE
// boundary only. The production rule is a string comparison (`isLiveThreadStatus`,
// ui/turns.ts), so every assertion here is correct before and after the union grows, and
// no test edit is needed when it does.
const threadWithStatus = (
    id: string,
    label: string,
    status: string,
    ownerThreadId?: string
): SessionThread =>
    threadOf({
        id,
        label,
        status: status as SessionThread['status'],
        ...(ownerThreadId === undefined ? {} : { ownerThreadId }),
        messages: []
    });

const entryOf = (
    id: string,
    label: string,
    status: string,
    ownerThreadId?: string
): SessionThreadEntry => ({
    id,
    agent: 'Researcher',
    origin: 'host',
    status: status as SessionThreadEntry['status'],
    sequence: 1,
    label,
    ...(ownerThreadId === undefined ? {} : { ownerThreadId })
});

// A host conversation with a live roster row and a still-live turn (what a reader sees
// mid-stream): the canonical Stop case.
const runningSnapshot = (): SessionSnapshot =>
    snapshotOf({
        threads: [threadOf({ id: 'thread-a', label: 'RR1', status: 'running', messages: [] })],
        turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a', status: 'running' })]
    });

// The frame the server publishes once the stop has landed: the SAME conversation, now
// terminal, with its turn settled. This is what flips the control back to Delete.
const settledSnapshot = (): SessionSnapshot =>
    snapshotOf({
        updatedAt: 11,
        threads: [threadOf({ id: 'thread-a', label: 'RR1', status: 'stopped', messages: [] })],
        turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a', status: 'cancelled' })]
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

// The ONE destructive control, in either of its two meanings.
const actionOf = (turn: TurnHandle): HTMLButtonElement => actionButton(barOf(turn), '.thread-delete');

const labelText = (button: HTMLButtonElement): string =>
    button.querySelector<HTMLElement>('.action-label')?.textContent ?? '';

const glyphText = (button: HTMLButtonElement): string =>
    button.querySelector<HTMLElement>('.action-glyph')?.textContent ?? '';

// Any confirmation layer (the shared dialog whose body carries the delete group). Stop
// must never produce one, so the check is content-based, exactly like the delete tests.
const deleteDialogs = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.dialog')).filter(
        (panel) => panel.querySelector('.thread-delete-confirm') !== null
    );

const confirmNothing = (): void => {
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
    expect(deleteDialogs()).toHaveLength(0);
};

// --- device stub ------------------------------------------------------------

const PHONE_QUERY = '(max-width: 860px)';
const FINE_QUERY = '(pointer: fine)';

type Device = { phone: boolean; fine: boolean };

// Same stub as thread-delete-confirmation.test.ts: this jsdom has no `matchMedia`, and the
// board samples both queries at CLICK time, so `stubDevice` picks which rule the press is
// judged by (`set` models a resize/rotation between presses).
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

type MountOptions = {
    // `false` wires NO stop transport at all (the "unwired host" branch).
    stopThread?: ((sessionId: string, threadId: string) => Promise<unknown>) | false;
    deleteThread?: (sessionId: string, threadId: string) => Promise<DeleteThreadResult>;
};

type Harness = {
    board: TurnBoard;
    handles: TurnHandle[];
    stopCalls: Array<[string, string]>;
    deleteCalls: Array<[string, string]>;
    // One resolver per pending STOP, in request order: a test keeps the cancel in flight
    // by simply not resolving it.
    pending: Array<(value: unknown) => void>;
};

// Mount a board with both destructive transports recorded, adopt every turn and expand the
// first one (expansion IS focus, and only an expanded tile shows its bar).
const mount = (snapshot: SessionSnapshot = runningSnapshot(), options: MountOptions = {}): Harness => {
    const stopCalls: Array<[string, string]> = [];
    const deleteCalls: Array<[string, string]> = [];
    const pending: Array<(value: unknown) => void> = [];

    const stopThread = options.stopThread;
    const board = createTurnBoard({
        ...(stopThread === false
            ? {}
            : {
                  stopThread:
                      stopThread ??
                      ((sessionId, threadId) => {
                          stopCalls.push([sessionId, threadId]);
                          return new Promise<unknown>((resolve) => pending.push(resolve));
                      })
              }),
        deleteThread:
            options.deleteThread ??
            ((sessionId, threadId) => {
                deleteCalls.push([sessionId, threadId]);
                return Promise.resolve<DeleteThreadResult>({
                    deleted: true,
                    session: snapshotOf({ updatedAt: 11 })
                });
            })
    });
    document.body.replaceChildren(board.element);

    board.bindSession(snapshot.id);
    board.setSessionSnapshot(snapshot);
    board.setThreads(sessionThreadsOf(snapshot));

    const handles = snapshot.turns.map((record) => board.adopt(record));
    const expanded = handles[0];
    if (expanded !== undefined) board.expand(expanded);

    return { board, handles, stopCalls, deleteCalls, pending };
};

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    // Dismiss whatever layer a passing or failing assertion left behind, so the dialog
    // module's layer stack and its reference-counted scroll lock start empty.
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe('the Stop control while work is live', () => {
    it('renders Stop for a running conversation instead of a disabled Delete', () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles } = mount();
        const button = actionOf(at(handles, 0));

        // ONE destructive control, unchanged anatomy: the Stop press keeps `.thread-delete`
        // (the modifier is additive) and every child stays in its original slot. T4/R2's
        // Resume lives BETWEEN them and is hidden here — a running thread is not `stopped` —
        // so the bar's DOM is three children while the reader still sees exactly two actions.
        expect([...barOf(at(handles, 0)).children].map((node) => node.className)).toEqual([
            'thread-delete thread-stop',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);
        expect(actionButton(barOf(at(handles, 0)), '.resume-open').hidden).toBe(true);
        expect(button.hidden).toBe(false);
        expect(button.classList.contains('thread-delete')).toBe(true);
        expect(button.classList.contains('thread-stop')).toBe(true);

        expect(labelText(button)).toBe('Stop');
        expect(glyphText(button)).toBe('■');
        expect(button.getAttribute('aria-label')).toBe('Stop thread RR1');
        // No confirmation wording anywhere: the title states the action, nothing else.
        expect(button.title).toBe('Stop this thread');
        // A wired host means a pressable control — R1's whole point.
        expect(button.disabled).toBe(false);

        // Reading the transcript of live work is unaffected by the swap.
        expect(actionButton(barOf(at(handles, 0)), '.transcript-open').disabled).toBe(false);
        expect(board.focusedThread()).toBe('thread-a');
    });

    it('sends exactly one stop on the first press on every surface, with no layer', async () => {
        // Proven desktop, phone, and the wide-but-coarse tablet: the delete waiver is
        // irrelevant here, so all three behave identically.
        for (const device of [
            { phone: false, fine: true },
            { phone: true, fine: false },
            { phone: true, fine: true }
        ]) {
            stubDevice(device);
            const { handles, stopCalls, deleteCalls } = mount();

            actionOf(at(handles, 0)).click();
            await flush();

            expect(stopCalls).toEqual([['s1', 'thread-a']]);
            // A stop must never fall through to the delete transport, and must never open
            // the confirmation dialog (not even on the surfaces that owe Delete one).
            expect(deleteCalls).toEqual([]);
            confirmNothing();
        }

        // And the UNKNOWN surface (no `matchMedia` at all — this jsdom) is covered too.
        vi.unstubAllGlobals();
        const unknown = mount();
        actionOf(at(unknown.handles, 0)).click();
        await flush();
        expect(unknown.stopCalls).toEqual([['s1', 'thread-a']]);
        confirmNothing();
    });

    it('follows the live work of a descendant the delete would cascade into', async () => {
        stubDevice({ phone: false, fine: true });
        // The PARENT is idle with a terminal turn; only its owned child is running, which
        // is exactly the subtree a DELETE would remove (ui/turns.ts `threadSubtreeIdsOf`).
        const snapshot = snapshotOf({
            threads: [
                threadOf({ id: 'thread-parent', label: 'RR1', messages: [] }),
                threadWithStatus('thread-child', 'RR2', 'running', 'thread-parent')
            ],
            turns: [turnOf({ id: 'turn-parent', index: 0, threadId: 'thread-parent', status: 'done' })]
        });
        const { handles, stopCalls } = mount(snapshot);
        const button = actionOf(at(handles, 0));

        expect(button.classList.contains('thread-stop')).toBe(true);
        expect(labelText(button)).toBe('Stop');
        expect(button.getAttribute('aria-label')).toBe('Stop thread RR1');
        expect(button.disabled).toBe(false);

        // The stop names the thread that was PRESSED; the server cascades to the subtree.
        button.click();
        await flush();
        expect(stopCalls).toEqual([['s1', 'thread-parent']]);
        confirmNothing();
    });

    it('treats a paused (compacting) conversation as live work', async () => {
        stubDevice({ phone: false, fine: true });
        // A terminal turn and a `paused` roster row: the status alone must be enough.
        const snapshot = snapshotOf({
            threads: [threadWithStatus('thread-paused', 'RR7', 'paused')],
            turns: [turnOf({ id: 'turn-paused', index: 0, threadId: 'thread-paused', status: 'done' })]
        });
        const { board, handles, stopCalls } = mount(snapshot);

        // The roster entry is installed DIRECTLY rather than folded through
        // `sessionThreadsOf`: the whitelist in ui/threads.ts is another worker's surface,
        // and this proof must pin the board's own rule, not that adapter's.
        board.setThreads([entryOf('thread-paused', 'RR7', 'paused')]);

        const button = actionOf(at(handles, 0));
        expect(button.classList.contains('thread-stop')).toBe(true);
        expect(labelText(button)).toBe('Stop');
        expect(button.disabled).toBe(false);

        button.click();
        await flush();
        expect(stopCalls).toEqual([['s1', 'thread-paused']]);
        confirmNothing();
    });

    it('hides the control entirely for an agent default conversation', () => {
        stubDevice({ phone: false, fine: true });
        const snapshot = snapshotOf({
            threads: [
                threadOf({
                    id: 'thread-agent',
                    origin: 'agent',
                    label: 'RR5',
                    status: 'running',
                    messages: []
                })
            ],
            turns: [turnOf({ id: 'turn-agent', index: 0, threadId: 'thread-agent', status: 'running' })]
        });
        const { board, handles, stopCalls, deleteCalls } = mount(snapshot);
        const button = actionOf(at(handles, 0));

        // R1 adds Stop to the bar; it does NOT make internal plumbing actionable.
        expect(button.hidden).toBe(true);
        expect(button.classList.contains('thread-stop')).toBe(false);
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-label')).toBe('Delete thread RR5');
        expect(button.title).toBe(
            'The default agent conversation cannot be deleted; reset the session instead.'
        );

        button.click();
        expect(stopCalls).toEqual([]);
        expect(deleteCalls).toEqual([]);
        confirmNothing();
        expect(board.focusedThread()).toBe('thread-agent');
    });

    it('states the missing transport instead of pretending the Stop is wired', () => {
        stubDevice({ phone: false, fine: true });
        const { handles, deleteCalls } = mount(runningSnapshot(), { stopThread: false });
        const button = actionOf(at(handles, 0));

        expect(button.classList.contains('thread-stop')).toBe(true);
        expect(labelText(button)).toBe('Stop');
        expect(button.getAttribute('aria-label')).toBe('Stop thread RR1');
        expect(button.disabled).toBe(true);
        expect(button.title).toBe('Thread stop is not wired in this host.');

        button.click();
        expect(deleteCalls).toEqual([]);
        confirmNothing();
    });
});

describe('stop in flight, and delete after it', () => {
    it('disables and relabels while the request is pending, and a press burst is one request', async () => {
        stubDevice({ phone: false, fine: true });
        const { handles, stopCalls, pending } = mount();
        const button = actionOf(at(handles, 0));

        button.click();
        button.click();
        button.click();
        await flush();

        expect(stopCalls).toEqual([['s1', 'thread-a']]);
        expect(pending).toHaveLength(1);
        expect(button.disabled).toBe(true);
        expect(labelText(button)).toBe('Stopping…');
        expect(glyphText(button)).toBe('■');
        expect(button.getAttribute('aria-label')).toBe('Stopping thread RR1');
        expect(button.title).toBe('Stopping this thread...');
        // Still one Stop control, never an extra button and never a dialog.
        expect(button.classList.contains('thread-stop')).toBe(true);
        confirmNothing();
    });

    it('stays Stop while the roster still reports live work, and re-arms pressable', async () => {
        stubDevice({ phone: false, fine: true });
        const { handles, stopCalls, pending } = mount();
        const button = actionOf(at(handles, 0));

        button.click();
        await flush();
        pending[0]?.({ cancelled: true });
        await flush();

        // The request finished but NO newer roster frame arrived, so the board has no
        // authority to call this conversation idle: it stays Stop and pressable.
        expect(button.disabled).toBe(false);
        expect(labelText(button)).toBe('Stop');
        expect(button.getAttribute('aria-label')).toBe('Stop thread RR1');

        button.click();
        await flush();
        expect(stopCalls).toEqual([
            ['s1', 'thread-a'],
            ['s1', 'thread-a']
        ]);
        confirmNothing();
    });

    it('becomes Delete again once the roster reports the conversation idle', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles, stopCalls, deleteCalls, pending } = mount();
        const button = actionOf(at(handles, 0));
        expect(labelText(button)).toBe('Stop');

        button.click();
        await flush();
        pending[0]?.({ cancelled: true });
        await flush();

        // The shell's reconcile, in the order `applyView` performs it: the settled RECORD
        // for the open tile first, then the newer authority (roster + rows) that repaints
        // every action bar.
        const settled = settledSnapshot();
        at(handles, 0).merge(at(settled.turns, 0));
        board.setSessionSnapshot(settled);
        board.setThreads(sessionThreadsOf(settled));
        await flush();

        expect(button.classList.contains('thread-stop')).toBe(false);
        expect(button.className).toBe('thread-delete');
        expect(labelText(button)).toBe('Delete');
        expect(glyphText(button)).toBe('X');
        expect(button.getAttribute('aria-label')).toBe('Delete thread RR1');
        expect(button.title).toBe('Delete this thread permanently');
        expect(button.disabled).toBe(false);

        // The delete flow is UNCHANGED: one press on a proven desktop, no dialog, and it
        // reaches the delete transport rather than the stop one.
        button.click();
        await flush();

        expect(deleteCalls).toEqual([['s1', 'thread-a']]);
        expect(stopCalls).toEqual([['s1', 'thread-a']]);
        confirmNothing();
    });

    it('reads Stop from live TILES too, and Delete again the moment they settle', async () => {
        stubDevice({ phone: false, fine: true });
        // The roster has already gone idle (the stop landed there) while the applied
        // snapshot and the open tile STILL claim live work: `deleteProtectionFor`'s
        // row/tile branches are what R1 reads, so the control must still be Stop — a
        // Delete now would 409 on work the last roster no longer even names.
        const snapshot = runningSnapshot();
        const { board, handles, stopCalls } = mount(snapshot);
        const button = actionOf(at(handles, 0));
        expect(labelText(button)).toBe('Stop');

        board.setThreads([entryOf('thread-a', 'RR1', 'idle')]);
        await flush();
        expect(button.classList.contains('thread-stop')).toBe(true);
        expect(labelText(button)).toBe('Stop');
        expect(button.getAttribute('aria-label')).toBe('Stop thread RR1');

        button.click();
        await flush();
        expect(stopCalls).toEqual([['s1', 'thread-a']]);
        confirmNothing();

        // The terminal record for the tile is enough: the control becomes Delete without
        // any new roster frame, because nothing in the projection claims work any more.
        at(handles, 0).merge(at(settledSnapshot().turns, 0));
        board.setSessionSnapshot(settledSnapshot());
        board.setThreads([entryOf('thread-a', 'RR1', 'idle')]);
        await flush();

        expect(button.classList.contains('thread-stop')).toBe(false);
        expect(labelText(button)).toBe('Delete');
        expect(button.getAttribute('aria-label')).toBe('Delete thread RR1');
        expect(button.title).toBe('Delete this thread permanently');
    });

    it('keeps the mobile delete confirmation for the stopped conversation', async () => {
        stubDevice({ phone: true, fine: false });
        const { board, handles, pending } = mount();
        const button = actionOf(at(handles, 0));

        button.click();
        await flush();
        pending[0]?.({ cancelled: true });
        await flush();

        const settled = settledSnapshot();
        at(handles, 0).merge(at(settled.turns, 0));
        board.setSessionSnapshot(settled);
        board.setThreads(sessionThreadsOf(settled));
        await flush();

        expect(labelText(button)).toBe('Delete');

        // T6/R5 survives R1: on a phone the DELETE still owes a confirmation, even though
        // the Stop that made it possible never asked for one.
        button.click();
        expect(deleteDialogs()).toHaveLength(1);
        expect(
            deleteDialogs()[0]?.querySelector<HTMLElement>('.thread-delete-confirm-body')
                ?.textContent
        ).toBe('Delete thread RR1 permanently? Its turns and transcript are removed.');

        actionButton(deleteDialogs()[0], '.thread-delete-confirm-delete').click();
        await flush();
        expect(deleteDialogs()).toHaveLength(0);
    });

    it('reports a failed stop without touching the conversation and re-arms the same control', async () => {
        stubDevice({ phone: true, fine: false });
        const attempts: Array<[string, string]> = [];
        const { board, handles, deleteCalls } = mount(runningSnapshot(), {
            stopThread: async (sessionId, threadId) => {
                attempts.push([sessionId, threadId]);
                throw new Error('Thread "thread-a" is already idle.');
            }
        });
        const button = actionOf(at(handles, 0));

        button.click();
        await flush();

        const notice = board.element.querySelector<HTMLElement>('.notice');
        expect(notice?.dataset.tone).toBe('error');
        expect(notice?.textContent).toBe(
            'stop thread: Thread "thread-a" is already idle.'
        );

        // Nothing was dropped and nothing was destroyed on the way: the tile, the focus and
        // a usable Stop all survive, and the delete transport never fired.
        expect(board.turns()).toHaveLength(1);
        expect(board.focusedThread()).toBe('thread-a');
        expect(deleteCalls).toEqual([]);
        confirmNothing();

        expect(button.disabled).toBe(false);
        expect(labelText(button)).toBe('Stop');
        expect(button.classList.contains('thread-stop')).toBe(true);

        // Recovery is not a special state: the next press stops again.
        button.click();
        await flush();
        expect(attempts).toEqual([
            ['s1', 'thread-a'],
            ['s1', 'thread-a']
        ]);
        confirmNothing();
    });

    it('drops an in-flight stop on a session switch rather than leaving the control disabled', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles, pending } = mount();
        const button = actionOf(at(handles, 0));

        button.click();
        await flush();
        expect(button.disabled).toBe(true);

        // The reader switches conversation while the POST is in flight. The abandoned
        // request belongs to `s1`, so it may not hold the SAME thread id disabled in `s2`
        // (thread ids are only unique per session).
        const second = snapshotOf({
            id: 's2',
            updatedAt: 12,
            threads: [threadOf({ id: 'thread-a', label: 'RR1', status: 'running', messages: [] })],
            turns: [turnOf({ id: 'turn-b', index: 0, threadId: 'thread-a', status: 'running' })]
        });
        board.bindSession('s2');
        board.setSessionSnapshot(second);
        board.setThreads(sessionThreadsOf(second));
        await flush();

        expect(button.disabled).toBe(false);
        expect(labelText(button)).toBe('Stop');

        // The late answer of the abandoned request is a repaint and nothing else: it cannot
        // re-disable the new session's control or open a layer.
        at(pending, 0)({ cancelled: true });
        await flush();
        expect(button.disabled).toBe(false);
        confirmNothing();
    });

    it('lets a cleared board stop the same thread again', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles, stopCalls, pending } = mount();
        actionOf(at(handles, 0)).click();
        await flush();
        expect(stopCalls).toEqual([['s1', 'thread-a']]);

        // A cleared projection drops the in-flight flag with it (the pending promise above
        // is deliberately left unresolved, like a request the tab navigated away from).
        board.clear();
        const again = runningSnapshot();
        board.setSessionSnapshot(again);
        board.setThreads(sessionThreadsOf(again));
        const turn = board.adopt(at(again.turns, 0));
        board.expand(turn);

        actionOf(turn).click();
        await flush();
        expect(stopCalls).toEqual([
            ['s1', 'thread-a'],
            ['s1', 'thread-a']
        ]);
        confirmNothing();
    });
});

describe('the live-work rule itself', () => {
    it('names running and paused as live and every settled status as not', () => {
        expect(isLiveThreadStatus('running')).toBe(true);
        expect(isLiveThreadStatus('paused')).toBe(true);
        expect(isLiveThreadStatus('idle')).toBe(false);
        expect(isLiveThreadStatus('stopped')).toBe(false);
        expect(isLiveThreadStatus('cancelled')).toBe(false);
        expect(isLiveThreadStatus('')).toBe(false);
    });

    it('protects a paused thread, and a parent whose child is paused', () => {
        const paused = entryOf('thread-paused', 'RR7', 'paused');
        expect(threadDeleteProtectionOf(paused, [paused], [])).toBe('active');

        const parent = entryOf('thread-parent', 'RR1', 'idle');
        const child = entryOf('thread-child', 'RR2', 'paused', 'thread-parent');
        expect(threadDeleteProtectionOf(parent, [parent, child], [])).toBe('active');
        expect(threadDeleteProtectionOf(child, [parent, child], [])).toBe('active');

        // A settled roster is NOT protected: that is the branch where the very same
        // control is a Delete again.
        const stopped = entryOf('thread-stopped', 'RR3', 'stopped');
        expect(threadDeleteProtectionOf(stopped, [stopped], [])).toBeUndefined();
    });
});
