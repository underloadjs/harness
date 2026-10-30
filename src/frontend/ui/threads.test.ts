// Persistent runtime threads (R2/R5/R6/R7): roster reading, submit routing and the
// thread strip.
//
// These pin the contract the composer and the shell depend on:
//   - the roster is read STRUCTURALLY and additively (a legacy snapshot has none);
//   - focus decides the target: continue an idle/stopped thread, steer a running one,
//     and with NO focus a submit opens a NEW thread (connected when the draft carries
//     `#` references);
//   - the far-right `x` STOPS a running thread but only DELETES an idle/stopped one,
//     and that delete needs a second click.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/threads.test.ts

import {
    THREAD_DELETE_CONFIRM_MS,
    createThreadStrip,
    resolveSubmitTarget,
    sessionThreadsOf,
    submitTargetLabel,
    threadLabelOf,
    threadNameOf,
    threadTitleOf,
    turnThreadIdOf
} from './threads';
import type { SessionThreadEntry } from './threads';

const rosterEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'writer',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

describe('sessionThreadsOf', () => {
    it('returns no threads for a legacy snapshot or a non-object', () => {
        expect(sessionThreadsOf(undefined)).toEqual([]);
        expect(sessionThreadsOf(null)).toEqual([]);
        expect(sessionThreadsOf({ id: 'session-1' })).toEqual([]);
        // A present but non-array field is malformed server data, not a roster.
        expect(sessionThreadsOf({ threads: { id: 'thread-1' } })).toEqual([]);
    });

    it('normalizes the roster, drops malformed entries and sorts by sequence', () => {
        const session = {
            threads: [
                {
                    id: 'thread-2',
                    agent: 'research',
                    origin: 'host',
                    status: 'stopped',
                    sequence: 2,
                    label: 'second'
                },
                { id: 'thread-1', agent: 'writer', origin: 'host', status: 'running', sequence: 1 },
                // Malformed: no id, no agent, non-object, and a duplicate id.
                { agent: 'writer', status: 'running', sequence: 0 },
                { id: 'thread-x', status: 'running', sequence: 0 },
                'thread-y',
                { id: 'thread-1', agent: 'writer', status: 'idle', sequence: 9 }
            ]
        };

        expect(sessionThreadsOf(session)).toEqual([
            // R8: an unlabeled legacy row derives its agent-prefixed name (WR1),
            // never the generic global creation ordinal.
            { id: 'thread-1', agent: 'writer', origin: 'host', status: 'running', sequence: 1, label: 'WR1' },
            {
                id: 'thread-2',
                agent: 'research',
                origin: 'host',
                status: 'stopped',
                sequence: 2,
                label: 'second'
            }
        ]);
    });

    it('defaults an unknown status to idle and keeps optional identity fields', () => {
        const threads = sessionThreadsOf({
            threads: [
                {
                    id: 'thread-3',
                    agent: 'research',
                    origin: 'host',
                    status: 'paused',
                    sequence: 3,
                    ownerThreadId: 'thread-1',
                    invocationId: 'thread-invocation-7',
                    originTurnId: 'turn-4',
                    originInvocationId: 'thread-invocation-7',
                    references: [{ turnId: 'turn-2', label: 'WR1' }]
                }
            ]
        });

        expect(threads).toEqual([
            {
                id: 'thread-3',
                agent: 'research',
                origin: 'host',
                status: 'idle',
                sequence: 3,
                label: 'RH1',
                ownerThreadId: 'thread-1',
                invocationId: 'thread-invocation-7',
                originTurnId: 'turn-4',
                originInvocationId: 'thread-invocation-7'
            }
        ]);
    });

    it('marks an agent DEFAULT conversation and keeps its transcript', () => {
        const threads = sessionThreadsOf({
            threads: [
                {
                    id: 'agent:writer',
                    agent: 'writer',
                    origin: 'agent',
                    status: 'idle',
                    sequence: 1,
                    messages: [{ role: 'assistant', content: 'hi' }]
                }
            ]
        });

        expect(threads).toEqual([
            {
                id: 'agent:writer',
                agent: 'writer',
                origin: 'agent',
                status: 'idle',
                sequence: 1,
                label: 'WR1',
                messages: [{ role: 'assistant', content: 'hi' }]
            }
        ]);
    });
});

describe('turnThreadIdOf', () => {
    it('reads the additive per-turn thread id', () => {
        expect(turnThreadIdOf({ id: 'turn-1' })).toBeUndefined();
        expect(turnThreadIdOf({ id: 'turn-1', threadId: 'thread-2' })).toBe('thread-2');
        // Blank / non-string values are not an identity.
        expect(turnThreadIdOf({ threadId: '   ' })).toBeUndefined();
        expect(turnThreadIdOf({ threadId: 7 })).toBeUndefined();
        expect(turnThreadIdOf(null)).toBeUndefined();
    });
});

describe('thread labels', () => {
    it('prefers the server label and otherwise uses an agent-prefixed fallback', () => {
        expect(threadNameOf({ sequence: 2, agent: 'writer', label: 'Planner' })).toBe('Planner');
        // R8: never the generic global `T<sequence>` wrapper.
        expect(threadNameOf({ sequence: 2, agent: 'writer' })).toBe('WR2');
        // Whitespace is not a label.
        expect(threadNameOf({ sequence: 4, agent: 'writer', label: '   ' })).toBe('WR4');
    });

    it('resolves ONE canonical label from the roster, never digits from the id', () => {
        const roster: SessionThreadEntry[] = [
            rosterEntry({ id: 'thread-3', sequence: 3, label: 'Research', agent: 'research' }),
            // Same trailing digit, different conversation: the label/sequence decides.
            rosterEntry({ id: 'conv/3', sequence: 7 })
        ];

        expect(threadLabelOf('thread-3', roster)).toBe('Research');
        expect(threadLabelOf('conv/3', roster)).toBe('WR7');
        // Unknown ids are explicit, and two long non-numeric ids do NOT collide on a
        // truncated token.
        expect(threadLabelOf('invocation-alpha', roster)).toBe('T?');
        expect(threadLabelOf('invocation-beta', roster)).toBe('T?');
        expect(threadLabelOf(undefined, roster)).toBeUndefined();
    });

    it('includes the agent in the badge title so same-agent threads differ (S6)', () => {
        const roster: SessionThreadEntry[] = [
            rosterEntry({ id: 'thread-1', sequence: 1, label: 'Writing', agent: 'writer' })
        ];

        expect(threadTitleOf('thread-1', roster)).toBe('Thread Writing · writer · idle');
        expect(threadTitleOf('thread-9', roster)).toBe('Thread thread-9');
        expect(threadTitleOf(undefined, roster)).toBeUndefined();
    });
});

describe('resolveSubmitTarget', () => {
    const threads: SessionThreadEntry[] = [
        rosterEntry({ id: 'thread-1', sequence: 1, label: 'Writing' }),
        rosterEntry({ id: 'thread-2', sequence: 2, status: 'running' }),
        rosterEntry({ id: 'thread-3', sequence: 3, status: 'stopped' })
    ];

    it('opens a new standalone thread when nothing is focused and nothing is referenced', () => {
        expect(resolveSubmitTarget({ threads })).toEqual({ mode: 'new' });
        expect(resolveSubmitTarget({ threads, references: 0 })).toEqual({ mode: 'new' });
    });

    it('opens a CONNECTED new thread when the draft carries references and nothing is focused', () => {
        expect(resolveSubmitTarget({ threads, references: 2 })).toEqual({ mode: 'connected' });
    });

    it('continues an idle or stopped focused thread in the same conversation', () => {
        expect(resolveSubmitTarget({ focus: 'thread-1', threads })).toEqual({
            mode: 'continue',
            threadId: 'thread-1',
            name: 'Writing'
        });
        expect(resolveSubmitTarget({ focus: 'thread-3', threads })).toEqual({
            mode: 'continue',
            threadId: 'thread-3',
            name: 'WR3'
        });
    });

    it('steers a running focused thread and ignores references for the target', () => {
        expect(resolveSubmitTarget({ focus: 'thread-2', threads, references: 3 })).toEqual({
            mode: 'steer',
            threadId: 'thread-2',
            name: 'WR2'
        });
    });

    it('continues a focused thread the roster has not reported yet', () => {
        // The id came from a turn record of this session, so it is authoritative
        // even without a roster row (a legacy snapshot omits the roster entirely).
        expect(resolveSubmitTarget({ focus: 'thread-9', threads: [] })).toEqual({
            mode: 'continue',
            threadId: 'thread-9'
        });
    });

    it('treats a blank focus as unfocused', () => {
        expect(resolveSubmitTarget({ focus: '  ', threads, references: 1 })).toEqual({ mode: 'connected' });
        expect(resolveSubmitTarget({ focus: '', threads })).toEqual({ mode: 'new' });
    });

    it('keeps a text-only running focus a plain steer', () => {
        // Zero/omitted counters must NOT mark the target queued: the server really
        // folds this text into the running thread.
        expect(resolveSubmitTarget({ focus: 'thread-2', threads, attachments: 0, unfinishedReferences: 0 })).toEqual({
            mode: 'steer',
            threadId: 'thread-2',
            name: 'WR2'
        });
    });

    it('marks a running focus queued when the draft carries attachments', () => {
        // The steering API is text-only, so the server accepts the bytes as a queued
        // continuation in the SAME thread: the id never moves.
        expect(resolveSubmitTarget({ focus: 'thread-2', threads, attachments: 1 })).toEqual({
            mode: 'steer',
            threadId: 'thread-2',
            name: 'WR2',
            queued: true
        });
    });

    it('marks a running focus queued when a referenced result is unfinished', () => {
        // A queued/running target has no result block to expand, so the submit is
        // queued as a continuation rather than steered without its context.
        expect(resolveSubmitTarget({ focus: 'thread-2', threads, unfinishedReferences: 1 })).toEqual({
            mode: 'steer',
            threadId: 'thread-2',
            name: 'WR2',
            queued: true
        });
    });

    it('does not mark an idle/stopped focus queued (continuing is already deferred)', () => {
        // Attachments on a non-running thread are offered as a continuation turn by
        // contract (no steering involved), so the qualifier must stay absent.
        expect(resolveSubmitTarget({ focus: 'thread-1', threads, attachments: 2 })).toEqual({
            mode: 'continue',
            threadId: 'thread-1',
            name: 'Writing'
        });
    });
});

describe('submitTargetLabel', () => {
    it('names every routing decision', () => {
        expect(submitTargetLabel({ mode: 'new' })).toBe('New thread');
        expect(submitTargetLabel({ mode: 'connected' })).toBe('New connected thread');
        expect(submitTargetLabel({ mode: 'continue', threadId: 't', name: 'Writing' })).toBe('Continuing Writing');
        expect(submitTargetLabel({ mode: 'steer', threadId: 't', name: 'T2' })).toBe('Steering T2');
        // A focused thread without a roster name still reads as a target.
        expect(submitTargetLabel({ mode: 'steer', threadId: 't' })).toBe('Steering thread');
    });

    it('never promises steering for a target the server will queue', () => {
        // A queued continuation keeps the same thread id but runs after the active
        // turn, so the label states the deferral instead of "Steering".
        expect(submitTargetLabel({ mode: 'steer', threadId: 't', name: 'T2', queued: true })).toBe('Queued in T2');
        expect(submitTargetLabel({ mode: 'steer', threadId: 't', queued: true })).toBe('Queued in thread');
        // `queued` is inert for every other mode.
        expect(submitTargetLabel({ mode: 'continue', threadId: 't', name: 'Writing', queued: true })).toBe(
            'Continuing Writing'
        );
        expect(submitTargetLabel({ mode: 'new', queued: true })).toBe('New thread');
    });
});

describe('createThreadStrip', () => {
    const mount = () => {
        const calls: string[] = [];
        const strip = createThreadStrip({
            onFocus: (threadId) => calls.push(`focus:${threadId}`),
            onUnfocus: () => calls.push('unfocus'),
            onStop: (threadId) => calls.push(`stop:${threadId}`),
            onDelete: (threadId) => calls.push(`delete:${threadId}`)
        });
        document.body.replaceChildren(strip.element);
        return { strip, calls };
    };

    const rows = (strip: ReturnType<typeof createThreadStrip>): HTMLElement[] => [
        ...strip.element.querySelectorAll<HTMLElement>('.thread-strip-row')
    ];

    it('stays hidden with no roster and no focus', () => {
        const { strip } = mount();

        strip.render([]);

        expect(strip.element.hidden).toBe(true);
        expect(rows(strip)).toEqual([]);
    });

    it('renders one row per persistent thread and marks exactly the focused one', () => {
        const { strip } = mount();

        strip.render(
            [
                rosterEntry({ id: 'thread-1', sequence: 1, label: 'Writing', status: 'stopped' }),
                rosterEntry({ id: 'thread-2', sequence: 2, status: 'running' })
            ],
            'thread-2'
        );

        expect(strip.element.hidden).toBe(false);
        expect(rows(strip).map((row) => row.dataset.threadId)).toEqual(['thread-1', 'thread-2']);
        expect(rows(strip).map((row) => row.dataset.status)).toEqual(['stopped', 'running']);

        const [first, second] = rows(strip);
        expect(first.classList.contains('is-focused')).toBe(false);
        expect(second.classList.contains('is-focused')).toBe(true);

        const focusButtons = [...strip.element.querySelectorAll<HTMLButtonElement>('.thread-strip-focus')];
        expect(focusButtons.map((button) => button.textContent)).toEqual([
            'writerWritingstopped',
            'writerWR2running'
        ]);
        expect(focusButtons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
        expect(focusButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
            'Focus thread Writing of writer (stopped)',
            'Focus thread WR2 of writer (running)'
        ]);

        // The far-right action is STOP for the running thread and DELETE otherwise.
        const actions = [...strip.element.querySelectorAll<HTMLButtonElement>('.thread-strip-action')];
        expect(actions.map((button) => button.dataset.action)).toEqual(['delete', 'stop']);
        expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
            'Delete thread Writing of writer',
            'Stop thread WR2 of writer'
        ]);
    });

    it('focuses a thread by clicking its row label', () => {
        const { strip, calls } = mount();
        strip.render([rosterEntry({ id: 'thread-1', sequence: 1 })]);

        strip.element.querySelector<HTMLButtonElement>('.thread-strip-focus')?.click();

        expect(calls).toEqual(['focus:thread-1']);
    });

    it('stops a running thread once and disables the action until a repaint', () => {
        const { strip, calls } = mount();
        strip.render([rosterEntry({ id: 'thread-2', sequence: 2, status: 'running' })]);

        const action = () => strip.element.querySelector<HTMLButtonElement>('.thread-strip-action');
        expect(action()?.disabled).toBe(false);
        action()?.click();

        expect(calls).toEqual(['stop:thread-2']);
        // The repaint marks the row pending: the action is disabled until the
        // authoritative snapshot shows the thread stopped (or a failure resyncs).
        expect(action()?.disabled).toBe(true);
        // The click is single-flight: a second one must not send another cancel.
        action()?.click();
        expect(calls).toEqual(['stop:thread-2']);
    });

    it('deletes a stopped thread only after a confirming second click', () => {
        vi.useFakeTimers();
        try {
            const { strip, calls } = mount();
            strip.render([rosterEntry({ id: 'thread-3', sequence: 3, status: 'stopped' })]);

            const action = () => strip.element.querySelector<HTMLButtonElement>('.thread-strip-action');
            action()?.click();

            // Armed, not deleted: the label asks for confirmation.
            expect(calls).toEqual([]);
            expect(strip.armed()).toBe('thread-3');
            expect(action()?.getAttribute('aria-label')).toBe('Confirm delete thread WR3 of writer');
            expect(action()?.classList.contains('is-confirm')).toBe(true);

            action()?.click();
            expect(calls).toEqual(['delete:thread-3']);
            expect(strip.armed()).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('disarms a pending delete after the confirmation window', () => {
        vi.useFakeTimers();
        try {
            const { strip, calls } = mount();
            strip.render([rosterEntry({ id: 'thread-3', sequence: 3 })]);

            strip.element.querySelector<HTMLButtonElement>('.thread-strip-action')?.click();
            expect(strip.armed()).toBe('thread-3');

            vi.advanceTimersByTime(THREAD_DELETE_CONFIRM_MS);

            expect(strip.armed()).toBeUndefined();
            expect(
                strip.element.querySelector<HTMLButtonElement>('.thread-strip-action')?.getAttribute('aria-label')
            ).toBe('Delete thread WR3 of writer');
            // The disarmed click did NOT delete anything.
            expect(calls).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('offers the explicit unfocus control only while something is focused', () => {
        const { strip, calls } = mount();
        const threads = [rosterEntry({ id: 'thread-1', sequence: 1 })];

        strip.render(threads);
        expect(strip.element.querySelector('.thread-strip-unfocus')).toBeNull();

        strip.render(threads, 'thread-1');
        const unfocus = strip.element.querySelector<HTMLButtonElement>('.thread-strip-unfocus');
        expect(unfocus?.textContent).toBe('New thread');
        expect(unfocus?.getAttribute('aria-label')).toBe(
            'Unfocus the current thread and start new messages in a new thread'
        );
        unfocus?.click();
        expect(calls).toEqual(['unfocus']);
    });

    it('stays visible with the unfocus control when the focused conversation is not in the roster', () => {
        // A default agent conversation has a runtime id but no HOST roster row.
        const { strip } = mount();

        strip.render([], 'agent:writer');

        expect(strip.element.hidden).toBe(false);
        expect(rows(strip)).toEqual([]);
        expect(strip.element.querySelector('.thread-strip-unfocus')).not.toBeNull();
    });

    it('drops an armed delete whose thread left the roster', () => {
        vi.useFakeTimers();
        try {
            const { strip } = mount();
            strip.render([rosterEntry({ id: 'thread-3', sequence: 3 })]);
            strip.element.querySelector<HTMLButtonElement>('.thread-strip-action')?.click();
            expect(strip.armed()).toBe('thread-3');

            strip.render([]);

            expect(strip.armed()).toBeUndefined();
            expect(strip.element.hidden).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the keyboard on the SAME semantic control across a repaint (S4)', () => {
        const { strip } = mount();
        const roster = [
            rosterEntry({ id: 'thread-1', sequence: 1 }),
            rosterEntry({ id: 'thread-2', sequence: 2, status: 'running' })
        ];
        strip.render(roster, 'thread-1');

        const stop = () => strip.element.querySelector<HTMLButtonElement>('[data-thread-id="thread-2"] .thread-strip-action');
        stop()?.focus();
        expect(document.activeElement).toBe(stop());

        // An authoritative snapshot repaints every row.
        strip.render(roster, 'thread-1');
        expect(document.activeElement).not.toBe(document.body);
        expect(document.activeElement).toBe(stop());
        expect(stop()?.getAttribute('aria-label')).toBe('Stop thread WR2 of writer');
    });

    it('keeps the armed delete and its focus across a repaint (S4)', () => {
        vi.useFakeTimers();
        try {
            const { strip } = mount();
            const roster = [rosterEntry({ id: 'thread-3', sequence: 3 })];
            strip.render(roster);

            const arm = strip.element.querySelector<HTMLButtonElement>('.thread-strip-action');
            arm?.focus();
            arm?.click();
            expect(strip.armed()).toBe('thread-3');
            // The arming repaint moved focus onto the rebuilt confirm button.
            expect(document.activeElement?.getAttribute('aria-label')).toBe('Confirm delete thread WR3 of writer');

            const confirm = strip.element.querySelector<HTMLButtonElement>('.thread-strip-action');
            confirm?.focus();
            strip.render(roster);

            expect(strip.armed()).toBe('thread-3');
            expect(strip.element.querySelector('.thread-strip-action')?.getAttribute('aria-label')).toBe(
                'Confirm delete thread WR3 of writer'
            );
            expect(document.activeElement).toBe(strip.element.querySelector('.thread-strip-action'));
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the unfocus control OUTSIDE the list so the content model is valid (S5)', () => {
        const { strip } = mount();
        strip.render([rosterEntry({ id: 'thread-1', sequence: 1 })], 'thread-1');

        const list = strip.element.querySelector('ul');
        expect([...(list?.children ?? [])].map((node) => node.tagName)).toEqual(['LI']);
        const footer = strip.element.querySelector('.thread-strip-footer');
        expect(footer?.parentElement).toBe(strip.element);
        expect(footer?.querySelector('.thread-strip-unfocus')).not.toBeNull();
    });

    it('never offers stop/delete for an agent DEFAULT conversation (S6)', () => {
        const { strip } = mount();

        strip.render([
            rosterEntry({ id: 'thread-1', sequence: 1, status: 'running' }),
            rosterEntry({ id: 'agent:writer', sequence: 2, origin: 'agent', status: 'idle' })
        ]);

        expect(rows(strip).map((row) => row.dataset.threadId)).toEqual(['thread-1']);
        expect(strip.element.querySelectorAll('.thread-strip-action')).toHaveLength(1);
        expect(
            strip.element.querySelector('.thread-strip-row[data-thread-id="thread-1"] .thread-strip-action')?.getAttribute('aria-label')
        ).toBe('Stop thread WR1 of writer');
    });

    it('destroy clears the rows and hides the strip', () => {
        const { strip } = mount();
        strip.render([rosterEntry({ id: 'thread-1', sequence: 1 })], 'thread-1');

        strip.destroy();

        expect(strip.element.hidden).toBe(true);
        expect(rows(strip)).toEqual([]);
        expect(strip.armed()).toBeUndefined();
    });
});
