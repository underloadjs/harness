// T4/R2, widened by T10 (revision 2) — the per-thread RESUME control: a run whose answer never
// arrived is not a run that finished, and while that is true the reader can put the SAME
// conversation back to work with one button, next to Transcript.
//
// Pins (ui/turns.ts `threadResumabilityOf`, `isStoppedThreadStatus`, `requestThreadResume`,
// `confirmThreadResume`, `createThreadActionBar` and the styles.css rules it depends on):
//   - visibility is the SERVER's answer read from BOTH signals the board holds: the roster
//     status AND the conversation's NEWEST known row. `error`/`cancelled` paint the control (a
//     stop, a run the provider killed, or the row a server restart left on an `idle`
//     conversation — the case that offered only Delete + Transcript before); `done` hides it
//     (the answer was reached, so this route would only refuse the press); `queued`/`running`
//     hide it (work is in flight); and `running`/`paused` hide it whatever the rows say. With NO
//     row for the conversation on this surface the v1 roster rule stands (`status ===
//     'stopped'`), which is what keeps the roster-only focus panel and a nested child card
//     working;
//   - the row that decides is the one with the highest `index`, never the last row of the list,
//     and another conversation's rows never decide it (pinned with an interleaved ledger);
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
//   - the control retires from what the SERVER last said, never from a local flag: while the
//     roster and the rows still describe a halted conversation whose answer never arrived it
//     stays visible, and a press after a newer frame says otherwise sends nothing — the guard
//     re-reads BOTH the roster and the rows at press time, exactly like the Delete↔Stop click
//     path does;
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
import { createTurnBoard, threadResumabilityOf } from './turns';
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

// The one shape every status test below needs: ONE conversation whose roster status is
// `status` and whose only row has status `turnStatus`. Revision 2 made the PAIR the question —
// the v1 helper pinned the roster alone and let the row default to `done`, which is exactly the
// combination the widened gate now (correctly) refuses to paint.
//
// The roster's `status` is a narrow union (`SessionThread.status`, server/protocol.ts;
// `SessionThreadEntry.status`, ui/threads.ts). `'paused'` reaches the board as a string
// through `isLiveThreadStatus`, so the fixture widens at the BOUNDARY only and every
// assertion here is correct before and after the union grows.
const snapshotWith = (
    status: string,
    turnStatus: SessionTurn['status'] = 'cancelled'
): SessionSnapshot =>
    snapshotOf({
        threads: [
            threadOf({
                id: 'thread-a',
                label: 'RR1',
                status: status as SessionThread['status'],
                messages: [{ role: 'user', content: 'question' }]
            })
        ],
        turns: [turnOf({ id: 'turn-a', index: 0, threadId: 'thread-a', status: turnStatus })]
    });

// The canonical case: a conversation the host halted, with its turn settled at `cancelled`
// (the answer was never reached) and the turn row STILL on screen — the state in which the
// request asks for a resume button.
const stoppedSnapshot = (): SessionSnapshot => snapshotWith('stopped');

// REV2: the state the reported screenshot showed — nothing was ever stopped, the run simply
// died (a provider failure, or the row a server restart marked interrupted). The conversation
// is `idle` because that is the ONLY status the runtime persists besides `stopped`, so the
// roster alone could never paint the control here.
const interruptedSnapshot = (): SessionSnapshot => snapshotWith('idle', 'error');

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

describe('the Resume control while the conversation has an answer that never arrived', () => {
    it('is painted for exactly the conversations whose answer was never reached', () => {
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

        // THE WHOLE GATE, as a figure rather than as a re-derived rule (`true` = the control is
        // painted). Rev2's change is the `idle` row: a conversation the host never stopped is
        // resumable when its newest row says the answer never arrived, and the sharp edge of the
        // v1 rule — `stopped` plus a `done` newest row, a stop made AFTER the answer — is now
        // hidden instead of offering a button the server only refuses.
        const painted: Record<string, Record<string, boolean>> = {
            stopped: { cancelled: true, error: true, done: false, queued: false, running: false },
            idle: { cancelled: true, error: true, done: false, queued: false, running: false },
            running: { cancelled: false, error: false, done: false, queued: false, running: false },
            paused: { cancelled: false, error: false, done: false, queued: false, running: false }
        };

        for (const status of ['stopped', 'idle', 'running', 'paused'] as const) {
            for (const turnStatus of ['cancelled', 'error', 'done', 'queued', 'running'] as const) {
                const { handles } = mount(snapshotWith(status, turnStatus));
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
                expect([status, turnStatus, button.hidden]).toEqual([
                    status,
                    turnStatus,
                    !painted[status]![turnStatus]
                ]);
                expect(labelText(button)).toBe('Resume');
                expect(glyphText(button)).toBe('▶');
                expect(button.getAttribute('aria-label')).toBe('Resume thread RR1');
            }
        }
    });

    it('is the SAME predicate the DOM paints, read as a pure figure', () => {
        // `threadResumabilityOf` is what `sync` calls and what the press-time guard calls; this
        // pins the figure directly, so a change to either call site cannot drift from the rule.
        const rows = (status: SessionTurn['status'], index = 0): SessionTurn[] => [
            turnOf({ id: `turn-${index}`, index, threadId: 'thread-a', status })
        ];

        expect(
            (
                [
                    ['stopped', rows('cancelled'), true],
                    ['stopped', rows('error'), true],
                    ['idle', rows('error'), true],
                    ['idle', rows('cancelled'), true],
                    ['idle', rows('done'), false],
                    ['stopped', rows('done'), false],
                    ['idle', rows('queued'), false],
                    ['idle', rows('running'), false],
                    // Live work owns the Stop control, whatever the rows say.
                    ['running', rows('error'), false],
                    ['running', rows('done'), false],
                    ['paused', rows('error'), false],
                    // `index` decides which row is newest, never the order they arrive in.
                    ['idle', [turnOf({ id: 'turn-old', index: 0, threadId: 'thread-a', status: 'error' }), turnOf({ id: 'turn-new', index: 1, threadId: 'thread-a', status: 'done' })], false],
                    ['idle', [turnOf({ id: 'turn-new', index: 1, threadId: 'thread-a', status: 'done' }), turnOf({ id: 'turn-old', index: 0, threadId: 'thread-a', status: 'error' })], false],
                    ['idle', [turnOf({ id: 'turn-old', index: 0, threadId: 'thread-a', status: 'done' }), turnOf({ id: 'turn-new', index: 1, threadId: 'thread-a', status: 'error' })], true],
                    // Another conversation's failure is never THIS conversation's business.
                    ['idle', [turnOf({ id: 'turn-b', index: 0, threadId: 'thread-b', status: 'error' })], false],
                    // No row for this conversation: the roster is the whole authority (v1).
                    ['stopped', [], true],
                    ['idle', [], false]
                ] as const
            ).map(([status, known, expected]) => [status, known.map((row) => row.status).join('+'), expected, threadResumabilityOf({ id: 'thread-a', status }, known)])
        ).toEqual([
            ['stopped', 'cancelled', true, true],
            ['stopped', 'error', true, true],
            ['idle', 'error', true, true],
            ['idle', 'cancelled', true, true],
            ['idle', 'done', false, false],
            ['stopped', 'done', false, false],
            ['idle', 'queued', false, false],
            ['idle', 'running', false, false],
            ['running', 'error', false, false],
            ['running', 'done', false, false],
            ['paused', 'error', false, false],
            ['idle', 'error+done', false, false],
            ['idle', 'done+error', false, false],
            ['idle', 'done+error', true, true],
            ['idle', 'error', false, false],
            ['stopped', '', true, true],
            ['idle', '', false, false]
        ]);
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

    // REV2 (R1/R2): the case the request is actually about. Nothing was stopped here — the run
    // died on the provider, or a server restart marked it interrupted — and the conversation is
    // `idle`, which the v1 rule treated as "nothing to resume". The row says otherwise.
    it('paints the control for an `idle` conversation whose row ended in error, and resumes it with one press', async () => {
        stubDevice({ phone: false, fine: true });
        const { handles, resumeCalls, pending } = mount(interruptedSnapshot());
        const button = resumeOf(at(handles, 0));

        expect(button.hidden).toBe(false);
        expect(button.disabled).toBe(false);
        expect(labelText(button)).toBe('Resume');
        expect(glyphText(button)).toBe('▶');

        button.click();
        await flush();

        expect(resumeCalls).toEqual([['s1', 'thread-a']]);
        expect(pending).toHaveLength(1);
        confirmNothing();
    });

    // REV2: the ROWS are enough to retire the control — no roster frame has to arrive. The
    // requeued row comes back as `running` on the stream before the roster is re-read, and a
    // control that stayed painted through that window would be offering a second replay of work
    // that is already in flight.
    it('retires the control as soon as the row says work is in flight, with no roster change', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles } = mount(interruptedSnapshot());
        const button = resumeOf(at(handles, 0));

        expect(button.hidden).toBe(false);

        // The roster is byte-for-byte the same `idle` row; only the ledger moved.
        const runningAgain = snapshotWith('idle', 'running');
        runningAgain.updatedAt = 11;

        board.setSessionSnapshot(runningAgain);
        await flush();

        expect(button.hidden).toBe(true);
        expect(button.disabled).toBe(false);

        // And it stays hidden when that run answers: the stop-after-answer case is the same
        // figure, read from the row instead of guessed from the roster.
        const answered = snapshotWith('idle', 'done');
        answered.updatedAt = 12;

        board.setSessionSnapshot(answered);
        await flush();

        expect(button.hidden).toBe(true);
    });

    // REV2: the guard re-reads the ROWS at press time too, exactly like the roster. A frame that
    // lands the answer between the repaint and the click must not send a request the server will
    // only refuse.
    it('sends nothing when a newer row lands the answer between the repaint and the press', async () => {
        stubDevice({ phone: false, fine: true });
        const { board, handles, resumeCalls } = mount(interruptedSnapshot());
        const button = resumeOf(at(handles, 0));
        expect(button.hidden).toBe(false);

        const answered = snapshotWith('idle', 'done');
        answered.updatedAt = 12;

        board.setSessionSnapshot(answered);
        board.setThreads(sessionThreadsOf(answered));
        await flush();

        button.click();
        await flush();

        expect(resumeCalls).toEqual([]);
        expect(button.hidden).toBe(true);
        confirmNothing();
    });

    // REV2: the roster-only fallback, pinned from BOTH sides. A conversation whose rows this
    // surface never received is judged by the roster alone — so the roster-only focus panel keeps
    // working exactly as before — and an `idle` conversation with nothing known about its runs
    // still offers nothing, because inventing a resume from `idle` is what the v1 rule refused.
    it('falls back to the roster alone when no row for the conversation is known', async () => {
        stubDevice({ phone: false, fine: true });

        // `idle` and no rows: hidden (the v1 answer, retained).
        const blind = snapshotOf({
            threads: [threadOf({ id: 'thread-roster', label: 'RR8', status: 'idle', messages: [] })]
        });
        const blindBoard = mount(blind);
        expect(blindBoard.board.focusThread('thread-roster')).toBe(true);
        const blindPanel = document.querySelector<HTMLElement>('.thread-focus-panel');
        if (blindPanel === null) throw new Error('missing roster focus panel');
        expect(actionButton(barOf(blindPanel), '.resume-open').hidden).toBe(true);

        // `stopped` and no rows: painted, and one press resumes it.
        const halted = snapshotOf({
            threads: [threadOf({ id: 'thread-roster', label: 'RR8', status: 'stopped', messages: [] })]
        });
        const haltedBoard = mount(halted);
        expect(haltedBoard.board.focusThread('thread-roster')).toBe(true);
        const haltedPanel = document.querySelector<HTMLElement>('.thread-focus-panel');
        if (haltedPanel === null) throw new Error('missing roster focus panel');
        const haltedResume = actionButton(barOf(haltedPanel), '.resume-open');
        expect(haltedResume.hidden).toBe(false);

        haltedResume.click();
        await flush();

        expect(haltedBoard.resumeCalls).toEqual([['s1', 'thread-roster']]);
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
