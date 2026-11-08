// T4/R2 — the per-thread RESUME control: a thread the HOST halted is not a thread that
// answered, and while that is true the reader can put the SAME conversation back to work
// with one button, next to Transcript.
//
// Pins (ui/turns.ts `isStoppedThreadStatus`, `requestThreadResume`, `confirmThreadResume`,
// `createThreadActionBar` and the styles.css rules it depends on):
//   - visibility is the ROSTER's answer and nothing else: `status === 'stopped'` shows the
//     control, and `idle` / `running` / `paused` do not. `idle` in particular is live-but-
//     not-working, so "not running" would be the WRONG predicate — only a server-halted
//     conversation has an unreached answer to continue;
//   - the element is a PERMANENT bar child (like Delete and Transcript) whose `hidden`
//     `sync` toggles, in the DOM order `[Delete, Resume, Transcript]` — "next to
//     Transcript", with Transcript still rightmost — and that shared component is what
//     gives the control to all three surfaces (the expanded tile footer, a nested child
//     card and the roster-only focus panel) for free. Each is pinned below;
//   - one press sends exactly one `resumeThread(sessionId, threadId)` and opens NOTHING:
//     resuing is not irreversible, so `requiresDeleteConfirmation` does not apply, the same
//     rule R1 established for Stop;
//   - single flight: the control disables and relabels `Resuming…` while the promise is
//     pending, a press burst is one request, and a rejection is reported through the board's
//     error notice (no silent failure) with the same control pressable again;
//   - the control retires from the ROSTER, not from a local flag: while the roster still
//     says `stopped` it stays visible, and a press after a newer frame says otherwise sends
//     nothing (the guard re-reads the roster at press time, exactly like the Delete↔Stop
//     click path does);
//   - a delete in flight owns the conversation, so Resume is disabled for its duration and
//     the reason is stated; an unwired host renders an honest disabled Resume with the
//     missing-transport reason and a press does nothing;
//   - the copy pair is `Resume` / `▶` (`.action-label` + `.action-glyph`), the play
//     triangle being the character the composer's send button already uses — this package
//     has no icon library. The mobile glyph swap is a DESCENDANT rule of the bar, so the
//     third control inherits `▶` with no resume-specific selector; and every STATE rule it
//     needs is a SHARED list with its two siblings — sizing, `:focus-visible`, and the
//     `:disabled` dim (a disabled Resume that stayed full-opacity with a live-looking pointer
//     next to two dimmed buttons would misreport the affordance in exactly the state where
//     the press cannot do anything). The stylesheet contract below pins all of it, because
//     jsdom computes no layout.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-resume.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
    DeleteThreadResult,
    HarnessEvent,
    SessionSnapshot,
    SessionThread,
    SessionTurn
} from '../../server/protocol';
import type { TurnBoard, TurnHandle } from './turns';
import { createTurnBoard } from './turns';
import { sessionThreadsOf, type SessionThreadEntry } from './threads';

const flush = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

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

// The roster's `status` is a narrow union (`SessionThread.status`, server/protocol.ts;
// `SessionThreadEntry.status`, ui/threads.ts). `'paused'` reaches the board as a string
// through `isLiveThreadStatus`, so the fixture widens at the BOUNDARY only and every
// assertion here is correct before and after the union grows.
const snapshotWithStatus = (status: string): SessionSnapshot =>
    snapshotOf({
        threads: [
            threadOf({
                id: 'thread-a',
                label: 'RR1',
                status: status as SessionThread['status'],
                messages: [{ role: 'user', content: 'question' }]
            })
        ],
        turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a' })]
    });

// The canonical case: a conversation the host halted, with its turn settled at `cancelled`
// (the answer was never reached) and the turn row STILL on screen — the state in which the
// request asks for a resume button.
const stoppedSnapshot = (): SessionSnapshot => snapshotWithStatus('stopped');

// The frame that arrives once the resume lands: the SAME conversation, running again. This
// is what retires the control, and it arrives from the roster, never from the press.
const resumedSnapshot = (): SessionSnapshot =>
    snapshotOf({
        updatedAt: 11,
        threads: [
            threadOf({
                id: 'thread-a',
                label: 'RR1',
                status: 'running',
                messages: [{ role: 'user', content: 'question' }]
            })
        ],
        turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a', status: 'running' })]
    });

// The `TaskReceipt` the resume route answers with (../shared/harness-api.ts). The board
// never reads it — the stream paints the continuation — so the fake resolves with the real
// shape and the test pins only that the promise was awaited.
const receiptOf = (turnId: string): Record<string, unknown> => ({
    task_id: `task-${turnId}`,
    turn_id: turnId,
    session_id: 's1',
    status: 'queued',
    position: 0,
    revision: 11,
    links: { session: '/v1/harness/sessions/s1', turn: `/v1/harness/sessions/s1/turns/${turnId}` }
});

// A delegated child invocation inside the parent turn's events, plus the roster entry that
// joins it to a PERSISTENT conversation. This is the fixture that puts a NESTED card (and
// therefore a second action bar) on screen; the same three events are what
// ui/thread-collapse-toggle.test.ts mounts a child row with.
const withThread = (
    event: Record<string, unknown>,
    thread: Record<string, unknown>
): HarnessEvent => ({ ...event, thread } as unknown as HarnessEvent);

const delegateCall = (agent: string, input: string, id: string): HarnessEvent =>
    ({
        type: 'tool_call',
        agent: 'Researcher',
        call: { id, name: 'delegate', arguments: JSON.stringify({ agent, input }) }
    }) as unknown as HarnessEvent;

const nestedEvents = (): HarnessEvent[] => [
    { type: 'start', agent: 'Researcher', model: 'm1' } as HarnessEvent,
    delegateCall('Helper', 'child task', 'd1'),
    withThread({ type: 'start', agent: 'Helper', model: 'h1' }, {
        id: 'inv-child',
        callId: 'd1',
        input: 'child task'
    })
];

// Parent + child + a roster-only conversation, ALL `stopped`: the three bar surfaces.
const nestedSnapshot = (): SessionSnapshot =>
    snapshotOf({
        threads: [
            threadOf({
                id: 'thread-a',
                label: 'RR1',
                sequence: 1,
                status: 'stopped',
                invocationIds: ['inv-parent'],
                messages: [{ role: 'user', content: 'question' }]
            }),
            threadOf({
                id: 'thread-child',
                agent: 'Helper',
                label: 'RR2',
                sequence: 2,
                origin: 'host',
                status: 'stopped',
                ownerThreadId: 'thread-a',
                invocationId: 'inv-child',
                invocationIds: ['inv-child'],
                messages: [{ role: 'user', content: 'child task' }]
            })
        ],
        turns: [
            turnOf({
                id: 'turn-a',
                index: 0,
                threadId: 'thread-a',
                status: 'cancelled',
                events: nestedEvents()
            })
        ]
    });

// A conversation the display wire has NO turn row for: the roster-only focus panel.
const rosterOnlySnapshot = (): SessionSnapshot =>
    snapshotOf({
        threads: [
            threadOf({
                id: 'thread-roster',
                label: 'RR8',
                status: 'stopped',
                messages: [
                    { role: 'system', content: 'instruction' },
                    { role: 'user', content: 'roster question' },
                    { role: 'assistant', content: 'roster answer' }
                ]
            })
        ]
    });

// --- DOM helpers ------------------------------------------------------------

const actionButton = (root: ParentNode, selector: string): HTMLButtonElement => {
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (button === null) throw new Error(`missing button ${selector}`);
    return button;
};

// T26 anatomy: a tile is exactly `select → bar → body`, so the bar is a scoped child.
const barOf = (surface: ParentNode): HTMLElement => {
    const bar = surface.querySelector<HTMLElement>(
        ':scope > .tile-transcript-action, :scope > .thread-transcript-action, :scope > .thread-focus-actions'
    );
    if (bar === null) throw new Error('missing thread action bar');
    return bar;
};

const resumeOf = (turn: TurnHandle): HTMLButtonElement =>
    actionButton(barOf(turn.element), '.resume-open');

const labelText = (button: HTMLButtonElement): string =>
    button.querySelector<HTMLElement>('.action-label')?.textContent ?? '';

const glyphText = (button: HTMLButtonElement): string =>
    button.querySelector<HTMLElement>('.action-glyph')?.textContent ?? '';

// No layer of any kind may appear on a Resume press (the Stop tests' `confirmNothing`).
const confirmNothing = (): void => {
    expect(document.querySelectorAll('.dialog-overlay')).toHaveLength(0);
    expect(
        Array.from(document.querySelectorAll<HTMLElement>('.dialog')).filter(
            (panel) => panel.querySelector('.thread-delete-confirm') !== null
        )
    ).toHaveLength(0);
};

// --- device stub ------------------------------------------------------------

const PHONE_QUERY = '(max-width: 860px)';
const FINE_QUERY = '(pointer: fine)';

type Device = { phone: boolean; fine: boolean };

// Same stub as ui/thread-stop.test.ts: this jsdom has no `matchMedia`, and the board
// samples both queries at CLICK time, so `stubDevice` picks which rule the press is judged
// by. A proven desktop is what makes a DELETE go out unasked — the only path that can put a
// delete in flight while Resume is being watched.
const stubDevice = (device: Device): void => {
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
};

// --- board harness ----------------------------------------------------------

type MountOptions = {
    // `false` wires NO resume transport at all (the "unwired host" branch).
    resumeThread?: ((sessionId: string, threadId: string) => Promise<unknown>) | false;
    stopThread?: (sessionId: string, threadId: string) => Promise<unknown>;
    deleteThread?: ((sessionId: string, threadId: string) => Promise<DeleteThreadResult>) | false;
};

type Harness = {
    board: TurnBoard;
    handles: TurnHandle[];
    resumeCalls: Array<[string, string]>;
    deleteCalls: Array<[string, string]>;
    // One resolver per pending RESUME, in request order: a test keeps the POST in flight by
    // simply not resolving it.
    pending: Array<(value: unknown) => void>;
};

// Mount a board with the resume transport recorded, adopt every turn and expand the first
// one (expansion IS focus, and only an expanded tile shows its bar).
const mount = (
    snapshot: SessionSnapshot = stoppedSnapshot(),
    options: MountOptions = {}
): Harness => {
    const resumeCalls: Array<[string, string]> = [];
    const deleteCalls: Array<[string, string]> = [];
    const pending: Array<(value: unknown) => void> = [];

    const resumeThread = options.resumeThread;
    const deleteThread = options.deleteThread;
    const board = createTurnBoard({
        ...(resumeThread === false
            ? {}
            : {
                  resumeThread:
                      resumeThread ??
                      ((sessionId, threadId) => {
                          resumeCalls.push([sessionId, threadId]);
                          return new Promise<unknown>((resolve) => pending.push(resolve));
                      })
              }),
        ...(options.stopThread === undefined
            ? { stopThread: async () => ({ cancelled: true }) }
            : { stopThread: options.stopThread }),
        ...(deleteThread === false
            ? {}
            : {
                  deleteThread:
                      deleteThread ??
                      ((sessionId, threadId) => {
                          deleteCalls.push([sessionId, threadId]);
                          return Promise.resolve<DeleteThreadResult>({
                              deleted: true,
                              session: snapshotOf({ updatedAt: 11 })
                          });
                      })
              })
    });
    document.body.replaceChildren(board.element);

    board.bindSession(snapshot.id);
    board.setSessionSnapshot(snapshot);
    board.setThreads(sessionThreadsOf(snapshot));

    const handles = snapshot.turns.map((record) => board.adopt(record));
    const expanded = handles[0];
    if (expanded !== undefined) board.expand(expanded);

    return { board, handles, resumeCalls, deleteCalls, pending };
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

describe('the Resume control while the roster says the conversation is stopped', () => {
    it('is painted for a `stopped` thread and hidden for every other status', () => {
        // Identity-normalized child order: the destructive slot ADDS `.thread-stop` while
        // work is live, so raw class names would fight the R1 morph. What is pinned here is
        // that the bar holds exactly three buttons, in the order `[Delete, Resume,
        // Transcript]`, whatever state each of them is in.
        const barOrder = (bar: ParentNode): string[] =>
            [...bar.children].map((node) => {
                const button = node as HTMLButtonElement;
                if (button.classList.contains('thread-delete')) return 'delete';
                if (button.classList.contains('resume-open')) return 'resume';
                if (button.classList.contains('transcript-open')) return 'transcript';
                throw new Error(`unexpected bar child: ${button.className}`);
            });

        // `idle` is the sharp edge: live-but-not-working has an ANSWERED question, not a
        // halted one, so it must NOT offer a resume. `running`/`paused` already have Stop.
        for (const status of ['stopped', 'idle', 'running', 'paused'] as const) {
            const { handles } = mount(snapshotWithStatus(status));
            const button = resumeOf(at(handles, 0));

            // The element is ALWAYS there, and always the MIDDLE child between Delete and
            // Transcript — `hidden` is the only suppression path (no rebuild, no reflow).
            expect(button.className).toBe('resume-open action-resume');
            expect(button.type).toBe('button');
            expect(barOrder(barOf(at(handles, 0).element))).toEqual([
                'delete',
                'resume',
                'transcript'
            ]);
            expect(button.hidden).toBe(status !== 'stopped');
            expect(labelText(button)).toBe('Resume');
            expect(glyphText(button)).toBe('▶');
            expect(button.getAttribute('aria-label')).toBe('Resume thread RR1');
        }
    });

    it('names the action, the thread and the play glyph it paints on a phone', () => {
        const { handles } = mount();
        const button = resumeOf(at(handles, 0));

        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(false);
        // Desktop copy and the mobile glyph, in ONE node pair — the same anatomy as
        // `Delete`/`X` and `Transcript`/`{}`, and what the bar's descendant CSS rule swaps.
        expect(labelText(button)).toBe('Resume');
        expect(glyphText(button)).toBe('▶');
        expect(button.getAttribute('aria-label')).toBe('Resume thread RR1');
        expect(button.title).toBe('Resume this stopped thread');

        // Reading the transcript of a stopped conversation is untouched by the new control,
        // and the destructive slot is still Delete (a stopped thread IS deletable).
        const bar = barOf(at(handles, 0).element);
        expect(labelText(actionButton(bar, '.transcript-open'))).toBe('Transcript');
        expect(actionButton(bar, '.thread-delete').className).toBe('thread-delete');
        expect(labelText(actionButton(bar, '.thread-delete'))).toBe('Delete');
    });

    it('resumes with ONE press and the ids of the bound session and the thread, opening nothing', async () => {
        stubDevice({ phone: true, fine: false });
        const { handles, resumeCalls, pending } = mount();
        const button = resumeOf(at(handles, 0));

        button.click();
        await flush();

        // Exact transport call: the bound session id plus THIS thread, once, and no
        // confirmation layer on a coarse/narrow surface either — resuming is not
        // irreversible, so `requiresDeleteConfirmation` does not apply.
        expect(resumeCalls).toEqual([['s1', 'thread-a']]);
        expect(pending).toHaveLength(1);
        confirmNothing();
    });

    it('disables and relabels while the request is pending, and a press burst is one request', async () => {
        stubDevice({ phone: false, fine: true });
        const { handles, resumeCalls, pending } = mount();
        const button = resumeOf(at(handles, 0));

        button.click();
        button.click();
        button.click();
        await flush();

        expect(resumeCalls).toEqual([['s1', 'thread-a']]);
        expect(pending).toHaveLength(1);
        expect(button.disabled).toBe(true);
        expect(labelText(button)).toBe('Resuming…');
        expect(glyphText(button)).toBe('▶');
        expect(button.getAttribute('aria-label')).toBe('Resuming thread RR1');
        expect(button.title).toBe('Resuming this thread...');
        // Still ONE Resume control, never a second button and never a dialog.
        expect(barOf(at(handles, 0).element).querySelectorAll('.resume-open')).toHaveLength(1);
        confirmNothing();
    });

    it('retires the control from the ROSTER, not from the press', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles, resumeCalls, pending } = mount();
        const button = resumeOf(at(handles, 0));

        button.click();
        await flush();
        pending[0]?.(receiptOf('turn-b'));
        await flush();

        // The request finished but NO newer roster frame arrived, so the board has no
        // authority to call this conversation running again: the control stays visible and
        // pressable rather than hiding optimistically and having to undo it on a rejection.
        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(false);
        expect(labelText(button)).toBe('Resume');

        // The frame the shell applies when the resume lands: `applyView` pushes the newer
        // roster, and THAT is what hides the control.
        const settled = resumedSnapshot();
        at(handles, 0).merge(at(settled.turns, 0));
        board.setSessionSnapshot(settled);
        board.setThreads(sessionThreadsOf(settled));
        await flush();

        expect(button.hidden).toBe(true);
        expect(barOf(at(handles, 0).element).querySelectorAll('.resume-open')).toHaveLength(1);

        // A press of the still-mounted (unpainted) control sends nothing: the guard re-reads
        // the CURRENT roster instead of trusting the copy painted at the last sync.
        button.click();
        await flush();
        expect(resumeCalls).toEqual([['s1', 'thread-a']]);
    });

    it('reports a failed resume and re-arms the same control without touching the conversation', async () => {
        stubDevice({ phone: false, fine: true });
        const attempts: Array<[string, string]> = [];
        const { board, handles } = mount(stoppedSnapshot(), {
            resumeThread: async (sessionId, threadId) => {
                attempts.push([sessionId, threadId]);
                throw new Error('HTTP 409 Thread "thread-a" has already reached its answer.');
            }
        });
        const button = resumeOf(at(handles, 0));

        button.click();
        await flush();

        // The board's own error notice, verbatim — no silent failure.
        const notice = board.element.querySelector<HTMLElement>('.notice');
        expect(notice?.dataset.tone).toBe('error');
        expect(notice?.textContent).toBe(
            'resume thread: HTTP 409 Thread "thread-a" has already reached its answer.'
        );

        // Nothing was dropped on the way: the tile, the focus and a usable Resume all
        // survive, and the destructive transports never fired.
        expect(board.turns()).toHaveLength(1);
        expect(board.focusedThread()).toBe('thread-a');
        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(false);
        expect(labelText(button)).toBe('Resume');
        confirmNothing();

        // Recovery is not a special state: the next press resumes again.
        button.click();
        await flush();
        expect(attempts).toEqual([
            ['s1', 'thread-a'],
            ['s1', 'thread-a']
        ]);
    });

    it('sends nothing when a newer roster frame says the thread is no longer stopped', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles, resumeCalls } = mount();
        const button = resumeOf(at(handles, 0));
        expect(button.hidden).toBe(false);

        // The repaint races the click: a snapshot frame settles the conversation, and the
        // press-time guard (not the painted copy) is what decides whether a request leaves.
        const settled = resumedSnapshot();
        board.setSessionSnapshot(settled);
        board.setThreads(sessionThreadsOf(settled));
        await flush();

        button.click();
        await flush();

        expect(button.hidden).toBe(true);
        expect(resumeCalls).toEqual([]);
        confirmNothing();
    });

    it('states the delete that owns the conversation instead of resuming behind it', async () => {
        stubDevice({ phone: false, fine: true });
        let resolveDelete: ((value: DeleteThreadResult) => void) | undefined;
        const { handles, resumeCalls } = mount(stoppedSnapshot(), {
            deleteThread: (sessionId, threadId) =>
                new Promise<DeleteThreadResult>((resolve) => {
                    resolveDelete = resolve;
                })
        });
        const button = resumeOf(at(handles, 0));
        expect(button.disabled).toBe(false);

        actionButton(barOf(at(handles, 0).element), '.thread-delete').click();
        await flush();

        // A DELETE in flight owns the conversation; a resume pressed behind it would put back
        // to work a thread the server is about to remove.
        expect(button.disabled).toBe(true);
        expect(button.title).toBe('Deleting this thread...');
        expect(button.hidden).toBe(false);

        resolveDelete?.({ deleted: true, session: snapshotOf({ updatedAt: 11 }) });
        await flush();

        // The delete answered with a roster that no longer names the thread, so its bar is
        // gone with it — and no resume request was ever smuggled out.
        expect(resumeCalls).toEqual([]);
    });

    it('renders an honest disabled Resume in an unwired host, and a press does nothing', async () => {
        stubDevice({ phone: false, fine: true });
        const { handles, resumeCalls } = mount(stoppedSnapshot(), { resumeThread: false });
        const button = resumeOf(at(handles, 0));

        // Visible (the conversation really is stopped) but not pretending: the reason names
        // the missing transport, exactly like an unwired Delete or Stop.
        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(true);
        expect(labelText(button)).toBe('Resume');
        expect(glyphText(button)).toBe('▶');
        expect(button.getAttribute('aria-label')).toBe('Resume thread RR1');
        expect(button.title).toBe('Thread resume is not wired in this host.');

        button.click();
        await flush();

        expect(resumeCalls).toEqual([]);
        confirmNothing();
    });
});

describe('the Resume control on every action-bar surface', () => {
    it('rides the nested child card and the roster-only focus panel with the same rules', async () => {
        stubDevice({ phone: false, fine: true });

        // Surface 1 — the EXPANDED TILE FOOTER (turns.ts `createThreadActionBar` call site
        // in the turn tile). Already the case every test above mounts; re-pinned here so the
        // three-surface claim is proven in one place.
        const tile = mount(nestedSnapshot());
        const tileBar = barOf(at(tile.handles, 0).element);
        expect([...tileBar.children].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);
        const tileResume = actionButton(tileBar, '.resume-open');
        expect(tileResume.hidden).toBe(false);
        expect(tileResume.getAttribute('aria-label')).toBe('Resume thread RR1');

        // Surface 2 — the NESTED CHILD CARD inside that tile (`createThreadActionBar` call
        // site in the thread entry). The shared component means the delegated conversation
        // gets the SAME third child, named by its OWN conversation code.
        expect(tile.board.focusThread('thread-child')).toBe(true);
        const childRow = at(tile.handles, 0).element.parentElement?.querySelector<HTMLElement>(
            '.thread-row[data-persistent-thread="thread-child"]'
        );
        if (childRow === null || childRow === undefined) throw new Error('missing nested child row');
        const childBar = childRow.querySelector<HTMLElement>(
            ':scope > .thread-tile > .thread-transcript-action'
        );
        if (childBar === null) throw new Error('missing nested child action bar');
        expect(childBar.hidden).toBe(false);
        expect([...childBar.children].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript'
        ]);
        const childResume = actionButton(childBar, '.resume-open');
        expect(childResume.hidden).toBe(false);
        expect(childResume.getAttribute('aria-label')).toBe('Resume thread RR2');

        // Surface 3 — the ROSTER-ONLY FOCUS PANEL (`createThreadActionBar` call site in the
        // panel). A conversation with no turn row of its own is a stopped conversation like
        // any other, so the control rides its bar too — with the panel-specific transcript
        // class the other two surfaces do not carry.
        const roster = mount(rosterOnlySnapshot());
        expect(roster.board.focusThread('thread-roster')).toBe(true);
        const panel = document.querySelector<HTMLElement>('.thread-focus-panel');
        if (panel === null) throw new Error('missing roster focus panel');
        const panelBar = barOf(panel);
        expect([...panelBar.children].map((node) => node.className)).toEqual([
            'thread-delete',
            'resume-open action-resume',
            'transcript-open action-transcript thread-focus-transcript'
        ]);
        const panelResume = actionButton(panelBar, '.resume-open');
        expect(panelResume.hidden).toBe(false);
        expect(panelResume.getAttribute('aria-label')).toBe('Resume thread RR8');

        // One press on the panel's control names the roster-only conversation, in the bound
        // session — the same transport the tile and the child card use.
        panelResume.click();
        await flush();
        expect(roster.resumeCalls).toEqual([['s1', 'thread-roster']]);
        confirmNothing();
    });
});

describe('the Resume control in the stylesheet contract', () => {
    // jsdom computes no layout, so the CSS facts are asserted against the stylesheet SOURCE
    // — the same approach ui/thread-transcript.test.ts and ui/thread-collapse-toggle.test.ts
    // use for the bar's own rules.
    const stylesheetPath = ['src/frontend/styles.css', 'src/styles.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));
    if (stylesheetPath === undefined) throw new Error('styles.css not found');
    const css = readFileSync(stylesheetPath, 'utf8').replace(/\r\n/g, '\n');

    // Exact rule body of the FIRST rule whose selector starts a line, so a prefixed variant
    // can never answer instead (the helper ui/thread-transcript.test.ts pins with).
    const blockOf = (selector: string): string => {
        const found = css.indexOf(selector);
        if (found < 0) throw new Error(`missing selector ${selector}`);
        return css.slice(css.indexOf('{', found) + 1, css.indexOf('}', found));
    };

    it('sizes, focuses and dims the third action with the SAME rules as the other two', () => {
        // ONE shared sizing rule lists all three buttons: a copy per control is what drifts
        // out of step, and this is the rule the request's "shared button sizing selector" is.
        const sizing = css.match(
            /\.transcript-open,\n\.resume-open,\n\.thread-delete \{([^}]*)\}/
        )?.[1];
        expect(sizing).toBeDefined();
        expect(sizing).toContain('padding: 4px 10px;');
        expect(sizing).toContain('border: 1px solid var(--border-strong);');
        expect(sizing).toContain('font: 500 11.5px/1.4 var(--sans);');
        expect(sizing).toContain('cursor: pointer;');

        // The focus ring covers the new control too, in the same list as its two siblings
        // (the list continues into the confirmation buttons, so only the three action
        // entries are pinned here).
        expect(css).toMatch(
            /\.transcript-open:focus-visible,\n\.resume-open:focus-visible,\n\.thread-delete:focus-visible,/
        );

        // T6 correction: the SHARED disabled dim lists the third control as well, in the same
        // slot order as the sizing/focus rules above. A disabled Resume — an unwired host, a
        // resume already in flight, or a delete that owns the conversation — must therefore
        // read exactly like a disabled sibling (`not-allowed` cursor, dimmed). Left out, the
        // bar showed a full-opacity, pointer-cursored Resume next to two dimmed buttons: an
        // affordance lie in the one state where the press cannot do anything.
        const disabled = blockOf('\n.transcript-open:disabled,');
        expect(disabled).toBe('\n    cursor: not-allowed;\n    opacity: 0.55;\n');
        expect(css).toMatch(
            /\.transcript-open:disabled,\n\.resume-open:disabled,\n\.thread-delete:disabled,\n\.thread-delete-confirm-delete:disabled \{/
        );
    });

    it('groups Resume and Transcript at the right edge, Transcript rightmost', () => {
        // DOM order `[Delete, Resume, Transcript]` + the auto margin ON Resume is what puts
        // the pair flush right: everything before it is pushed left, and Transcript simply
        // follows Resume at the bar's end.
        expect(blockOf('\n.resume-open {')).toBe('\n    margin-left: auto;\n');

        // A `hidden` Resume contributes no margin at all (the global
        // `[hidden] { display: none !important }` rule), so the trailing button takes the
        // flush-right slot back — an ordinary running thread still ends with Transcript at
        // the right edge, and an undeletable default conversation (Delete hidden as well)
        // never slides it into the destructive action's place.
        expect(blockOf('\n.resume-open[hidden] + .transcript-open {')).toBe(
            '\n    margin-left: auto;\n'
        );

        // The bar is still a `flex-wrap: wrap` row with `gap`, and no two-ended
        // `justify-content` anywhere: the grouping is the auto margin's job alone.
        const barStart = css.indexOf(
            ':is(.tile-transcript-action, .thread-transcript-action, .thread-focus-actions) {'
        );
        expect(barStart).toBeGreaterThan(-1);
        const barBlock = css.slice(barStart, css.indexOf('}', barStart));
        expect(barBlock).toContain('display: flex');
        expect(barBlock).toContain('gap: 8px');
        expect(barBlock).not.toContain('justify-content');
    });

    it('swaps the Resume label for its play glyph on a phone, with no resume-specific rule', () => {
        // The narrow-surface swap is ONE pair of DESCENDANT rules over the three bars, so the
        // third control inherits `▶` from the same mechanism that gives a phone `X` and `{}`.
        expect(css).toMatch(
            /@media \(max-width: 600px\) \{[\s\S]*?:is\(\.tile-transcript-action, \.thread-transcript-action, \.thread-focus-actions\) \.action-label \{\s*display: none;\s*\}/
        );
        expect(css).toMatch(
            /@media \(max-width: 600px\) \{[\s\S]*?:is\(\.tile-transcript-action, \.thread-transcript-action, \.thread-focus-actions\) \.action-glyph \{\s*display: inline;\s*\}/
        );

        // Pinned as the ONLY label/glyph overrides in the file: nothing else can hide a
        // desktop label or fake a second mobile rule that drifts from the first.
        const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
        expect(rules.match(/:is\([^)]*\) \.action-label \{/g)).toEqual([
            ':is(.tile-transcript-action, .thread-transcript-action, .thread-focus-actions) .action-label {'
        ]);
        expect(rules.match(/:is\([^)]*\) \.action-glyph \{/g)).toEqual([
            ':is(.tile-transcript-action, .thread-transcript-action, .thread-focus-actions) .action-glyph {'
        ]);

        // Every selector the stylesheet (comments stripped) uses to name the third control, in
        // file order: exactly the three SHARED state lists it joins as a sibling entry —
        // sizing, `:focus-visible`, `:disabled` — plus the only two rules of its own, the
        // right-edge auto margin and the hidden-state hand-back to Transcript. Nothing here
        // restates a shared rule for Resume, which is what keeps a phone's `▶`, its focus ring
        // and its dimmed state from drifting away from Delete's and Transcript's.
        expect(rules.split('\n').filter((line) => line.includes('.resume-open'))).toEqual([
            '.resume-open,',
            '.resume-open {',
            '.resume-open[hidden] + .transcript-open {',
            '.resume-open:focus-visible,',
            '.resume-open:disabled,'
        ]);

        // Desktop default: the glyph node exists but is not painted — the accessible name
        // comes from `aria-label`, never from CSS.
        expect(blockOf('\n.action-glyph {')).toContain('display: none');
    });
});
