// R3 — thread Delete is ONE press on EVERY surface: the confirmation is gone.
//
// The file keeps its T6/R5 name because it is the retargeted version of that suite: what
// it used to pin (a wide fine-pointer desktop deletes on one press while every other
// surface owes a shared confirmation DIALOG) no longer exists. It now pins the
// replacement rule in ui/turns.ts (`requestThreadDelete`, `performThreadDelete`):
//
//   - one press on the Delete control performs the delete. No confirmation dialog, no
//     two-press arming, no media/pointer branch — a phone deletes exactly as a desktop
//     does. The device matrix is swept below (wide/narrow x fine/coarse/none, plus an
//     absent, a throwing and an untyped `matchMedia`): EVERY cell sends the same single
//     request and creates no dialog element at any point;
//   - the board never asks the device anything on the way to the DELETE, which is the
//     structural form of "no media/pointer-dependent branching";
//   - the destructive control still means Stop while the conversation (or a descendant its
//     delete would cascade into) has live work (R3b): that press rides the stop transport
//     and the delete transport never fires;
//   - the protections that were never about the dialog survive: an `origin: 'agent'`
//     conversation hides the control, an unwired host keeps it disabled and sends nothing,
//     a request in flight is single-flight (a press burst is one request), and a failed
//     DELETE drops nothing — the tile, the focus and a usable control survive and the next
//     press simply tries again;
//   - a board owns no layer at all, so a session switch or a cleared board can leave no
//     stale dialog behind.
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
import { createTurnBoard } from './turns';
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

// R3: a Delete press must create NO layer of any kind. Counting every dialog panel —
// rather than filtering on the content class the removed confirmation used to carry — is
// the strongest form of the assertion: it also catches a second transcript or any other
// surface the board might have grown.
const noLayer = (): void => {
    expect(document.querySelectorAll('.dialog')).toHaveLength(0);
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
};

// --- device stub ------------------------------------------------------------

const PHONE_QUERY = '(max-width: 860px)';
const FINE_QUERY = '(pointer: fine)';

// The two answers the removed policy used to branch on, for each surface worth naming.
// `Record<string, boolean>` because the board queries by an arbitrary string.
const DEVICE_ANSWERS: Record<
    'desktop' | 'tablet' | 'narrow-window' | 'phone',
    Record<string, boolean>
> = {
    // Wide viewport, fine pointer: the one cell that used to delete unasked.
    desktop: { [PHONE_QUERY]: false, [FINE_QUERY]: true },
    // Wide viewport, coarse pointer: a tablet, or `(pointer: none)` keyboard-only input.
    tablet: { [PHONE_QUERY]: false, [FINE_QUERY]: false },
    // Narrow viewport, fine pointer: a desktop window dragged under the breakpoint.
    'narrow-window': { [PHONE_QUERY]: true, [FINE_QUERY]: true },
    // Narrow viewport, coarse pointer: THE phone case this request is about.
    phone: { [PHONE_QUERY]: true, [FINE_QUERY]: false }
};

// `absent` is this jsdom (no `matchMedia` natively — old engines and embedded shells
// behave the same), `throws` is a hostile implementation and `untyped` is a list that
// never answers with a boolean. All three used to be UNKNOWN and owed a confirmation.
type Device = keyof typeof DEVICE_ANSWERS | 'absent' | 'throws' | 'untyped';

// Installs the surface's `matchMedia` and records EVERY query asked of it, so a test can
// prove the board no longer asks. `queries` is shared with the harness.
const installDevice = (device: Device, queries: string[]): void => {
    if (device === 'absent') return;

    if (device === 'throws') {
        vi.stubGlobal(
            'matchMedia',
            vi.fn((query: string) => {
                queries.push(query);
                throw new Error('stubbed failure');
            })
        );
        return;
    }

    const answers = device === 'untyped' ? undefined : DEVICE_ANSWERS[device];
    vi.stubGlobal(
        'matchMedia',
        vi.fn((query: string) => {
            queries.push(query);

            return {
                media: query,
                matches: answers === undefined ? 'no' : answers[query] ?? false,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                onchange: null
            };
        })
    );
};

// --- board harness ----------------------------------------------------------

type Harness = {
    board: TurnBoard;
    // One handle per snapshot turn, in recorded order (the tiles a reader sees).
    handles: TurnHandle[];
    calls: Array<[string, string]>;
    // Every `matchMedia` query the board asked about while handling the press. R3 asks
    // about NONE of them: the device is no longer part of the decision.
    queries: string[];
    // One resolver per request, in request order: a test keeps the DELETE in flight by
    // simply not resolving it.
    pending: Array<(value: DeleteThreadResult) => void>;
};

type MountOptions = {
    snapshot?: SessionSnapshot;
    // The surface the press happens on. Defaults to the phone, the surface that used to
    // behave differently.
    device?: Device;
    // A failing transport (the server's 409 for live work) is what the retry test needs.
    deleteThread?: (sessionId: string, threadId: string) => Promise<DeleteThreadResult>;
    stopThread?: (sessionId: string, threadId: string) => Promise<unknown>;
};

// Mount a board with recording transports, adopt every turn and expand the first one
// (expansion IS focus, and only an expanded tile shows its bar).
const mount = (options: MountOptions = {}): Harness => {
    const snapshot = options.snapshot ?? targetSnapshot();
    const calls: Array<[string, string]> = [];
    const queries: string[] = [];
    const pending: Array<(value: DeleteThreadResult) => void> = [];

    installDevice(options.device ?? 'phone', queries);

    const board = createTurnBoard({
        ...(options.deleteThread === undefined
            ? {
                  deleteThread: (sessionId: string, threadId: string) =>
                      new Promise<DeleteThreadResult>((resolve) => {
                          calls.push([sessionId, threadId]);
                          pending.push(resolve);
                      })
              }
            : { deleteThread: options.deleteThread }),
        ...(options.stopThread === undefined ? {} : { stopThread: options.stopThread })
    });
    document.body.replaceChildren(board.element);

    board.bindSession(snapshot.id);
    board.setSessionSnapshot(snapshot);
    board.setThreads(sessionThreadsOf(snapshot));

    const handles = snapshot.turns.map((record) => board.adopt(record));
    const expanded = handles[0];
    if (expanded !== undefined) board.expand(expanded);

    return { board, handles, calls, queries, pending };
};

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    // The dialog module keeps a module-level layer stack and a reference-counted scroll
    // lock; whatever a passing or failing assertion left behind must not leak into the
    // next test's `.dialog` count.
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

describe('one press deletes, on every surface', () => {
    it('sends exactly one request on the first press of a proven desktop and opens no layer', async () => {
        const { board, calls, handles } = mount({ device: 'desktop' });
        const turn = at(handles, 0);

        deleteOf(turn).click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        noLayer();
        // The bar carries no inline confirmation row either: its children are its permanent
        // actions in DOM order — Delete, the T4/R2 Resume slot (hidden, this thread is not
        // `stopped`) and Transcript.
        expect([...barOf(turn).children].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);
        // The conversation is still on screen while the request runs (the shell's snapshot
        // answer is what removes it).
        expect(board.turns()).toHaveLength(1);
    });

    it('sends exactly one request on the first press of a phone and opens no layer', async () => {
        // THE regression this request is about: a narrow viewport with a coarse pointer used
        // to send NOTHING and open a dialog. It is now the same press as the desktop cell.
        const { board, calls, handles } = mount({ device: 'phone' });
        const turn = at(handles, 0);

        deleteOf(turn).click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        noLayer();
        expect([...barOf(turn).children].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);
        expect(board.turns()).toHaveLength(1);
    });

    it('answers every device cell with the same single request and no dialog element', async () => {
        // The full matrix the removed policy used to branch on, swept as one contract. The
        // assertions carry the cell label so a failing cell names itself.
        const cells: Device[] = ['desktop', 'tablet', 'narrow-window', 'phone', 'absent', 'throws', 'untyped'];

        for (const cell of cells) {
            document.body.innerHTML = '';
            vi.unstubAllGlobals();

            const { calls, handles } = mount({ device: cell });
            deleteOf(at(handles, 0)).click();
            await flush();

            expect({ cell, calls }).toEqual({ cell, calls: [['s1', 'thread-a']] });
            expect({ cell, dialogs: document.querySelectorAll('.dialog').length }).toEqual({
                cell,
                dialogs: 0
            });
        }
    });

    it('never consults the device while deciding the press', async () => {
        // The structural form of "no media/pointer-dependent branching": the board asks
        // `matchMedia` NOTHING on the way to the DELETE.
        const { calls, handles, queries } = mount({ device: 'desktop' });

        deleteOf(at(handles, 0)).click();
        await flush();

        expect(queries).toEqual([]);
        expect(calls).toEqual([['s1', 'thread-a']]);
    });

    it('follows neither a resize nor a rotation between presses', async () => {
        // A device changing underneath the reader used to flip the rule mid-session; the
        // phone press and the desktop press are now one and the same press.
        const phone = mount({ device: 'phone' });
        deleteOf(at(phone.handles, 0)).click();
        await flush();

        document.body.innerHTML = '';
        vi.unstubAllGlobals();
        const desktop = mount({ device: 'desktop' });
        deleteOf(at(desktop.handles, 0)).click();
        await flush();

        expect(phone.calls).toEqual([['s1', 'thread-a']]);
        expect(desktop.calls).toEqual([['s1', 'thread-a']]);
        noLayer();
    });
});

describe('what still protects the conversation', () => {
    it('sends no second request while the first is still in flight', async () => {
        const { calls, handles, pending } = mount({ device: 'phone' });
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        deleteButton.click();
        deleteButton.click();
        await flush();

        expect(calls).toEqual([['s1', 'thread-a']]);
        expect(pending).toHaveLength(1);
        noLayer();

        // The bar states the live request instead of offering another destructive press.
        expect(deleteButton.disabled).toBe(true);
        expect(deleteButton.title).toBe('Deleting this thread...');

        pending[0]?.({ deleted: true, session: snapshotOf({ updatedAt: 11 }) });
        await flush();

        expect(calls).toHaveLength(1);
        noLayer();
    });

    it('keeps the thread and re-arms the same one-press rule after a failed request', async () => {
        // The transport records the attempt and then refuses, exactly like the server's 409
        // for live work: the board must keep everything and stay retryable.
        const attempts: Array<[string, string]> = [];
        const { board, handles } = mount({
            device: 'phone',
            deleteThread: async (sessionId, threadId) => {
                attempts.push([sessionId, threadId]);
                throw new Error('Thread "thread-a" still has live work.');
            }
        });
        const deleteButton = deleteOf(at(handles, 0));

        deleteButton.click();
        await flush();

        const notice = board.element.querySelector<HTMLElement>('.notice');
        expect(notice?.dataset.tone).toBe('error');
        expect(notice?.textContent).toBe('delete thread: Thread "thread-a" still has live work.');
        // Nothing was dropped: the conversation, its focus and a usable control survive,
        // and no layer was opened at any point.
        expect(board.turns()).toHaveLength(1);
        expect(board.focusedThread()).toBe('thread-a');
        expect(deleteButton.disabled).toBe(false);
        noLayer();

        // Recovery is not a special state: the next press deletes on its own again.
        deleteButton.click();
        await flush();

        expect(attempts).toEqual([
            ['s1', 'thread-a'],
            ['s1', 'thread-a']
        ]);
        noLayer();
    });

    it('is the Stop control while the conversation has live work, and never deletes (R3b)', async () => {
        const stopCalls: Array<[string, string]> = [];
        const { board, calls, handles } = mount({
            device: 'phone',
            snapshot: targetSnapshot({
                threads: [
                    threadOf({ id: 'thread-running', label: 'RR6', status: 'running', messages: [] })
                ],
                turns: [
                    turnOf({
                        id: 'turn-running',
                        index: 0,
                        threadId: 'thread-running',
                        status: 'running'
                    })
                ]
            }),
            stopThread: async (sessionId, threadId) => {
                stopCalls.push([sessionId, threadId]);
                return { cancelled: true };
            }
        });
        const button = deleteOf(at(handles, 0));

        // The SAME control, one meaning at a time: live work makes it Stop.
        expect(button.classList.contains('thread-delete')).toBe(true);
        expect(button.classList.contains('thread-stop')).toBe(true);
        expect(button.querySelector('.action-label')?.textContent).toBe('Stop');
        expect(button.getAttribute('aria-label')).toBe('Stop thread RR6');
        expect(button.disabled).toBe(false);

        button.click();
        await flush();

        // One cancel for the pressed thread, no DELETE, and nothing stacked. The roster
        // still says the work is live, so the control is still a Stop afterwards.
        expect(stopCalls).toEqual([['s1', 'thread-running']]);
        expect(calls).toEqual([]);
        noLayer();
        expect(button.querySelector('.action-label')?.textContent).toBe('Stop');
        expect(board.turns()).toHaveLength(1);
    });

    it('sends nothing for an agent conversation or an unwired host', () => {
        // The agent's default conversation hides the control; there is nothing to press.
        const agent = mount({
            device: 'phone',
            snapshot: targetSnapshot({
                threads: [
                    threadOf({ id: 'thread-agent', origin: 'agent', label: 'RR5', messages: [] })
                ],
                turns: [turnOf({ id: 'turn-agent', index: 0, threadId: 'thread-agent' })]
            })
        });
        const agentDelete = deleteOf(at(agent.handles, 0));
        expect(agentDelete.hidden).toBe(true);
        agentDelete.click();
        expect(agent.calls).toEqual([]);
        noLayer();

        // No transport at all: an honest disabled control, and a press cannot fire a
        // doomed request.
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
        noLayer();
    });

    it('owns no layer, so a session switch and a cleared board leave nothing behind', async () => {
        const switched = mount({ device: 'desktop' });
        deleteOf(at(switched.handles, 0)).click();
        expect(switched.calls).toEqual([['s1', 'thread-a']]);

        // The request is in flight (the transport never resolves) when the reader switches.
        switched.board.bindSession('s2');
        await flush();
        noLayer();

        document.body.innerHTML = '';
        vi.unstubAllGlobals();
        const cleared = mount({ device: 'desktop' });
        deleteOf(at(cleared.handles, 0)).click();
        cleared.board.clear();
        await flush();

        expect(cleared.calls).toEqual([['s1', 'thread-a']]);
        noLayer();
    });
});
