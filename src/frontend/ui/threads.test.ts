// Persistent runtime threads (R2/R5/R6/R7/R8) — the pure UI layer of
// src/frontend/ui/threads.ts.
//
// These pin the contract the composer, the transcript board and the shell depend on:
//   - the roster is read STRUCTURALLY and additively (a legacy snapshot has none, so
//     `sessionThreadsOf` yields [] and `turnThreadIdOf` yields undefined);
//   - the submit-routing DECISION is a pure function: focus decides the target —
//     continue an idle/stopped thread, steer a running one (queued when it cannot be
//     steered) — and with NO focus a submit opens a NEW thread (connected when the
//     draft carries `#` references);
//   - display labels are canonical: one agent-prefixed name per conversation, the
//     same string on the tile badge and on a `#` reference, never parsed from ids.
//
// The compact `.thread-strip` DOM band was REMOVED from the module (it duplicated the
// transcript's own `.tile-thread` badge), so nothing here mounts or queries DOM:
// every assertion below is on a plain return value.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/threads.test.ts

import {
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

    // R3: the roster's historical invocation list is the authoritative join for a
    // card whose original invocation id the single slots no longer name. It is read
    // defensively (non-strings and blanks dropped, duplicates collapsed, oldest first)
    // and OMITTED when nothing usable remains, so the board can tell "not sent" from
    // "this thread ran nothing".
    it('reads the historical invocation list defensively', () => {
        const threads = sessionThreadsOf({
            threads: [
                {
                    id: 'thread-5',
                    agent: 'research',
                    origin: 'host',
                    status: 'idle',
                    sequence: 1,
                    invocationId: 'inv-9',
                    invocationIds: ['inv-7', '', '  ', 'inv-9', 'inv-7', 42, null]
                },
                // Absent, empty and non-array values all mean "the server sent none".
                { id: 'thread-6', agent: 'research', origin: 'host', status: 'idle', sequence: 2 },
                { id: 'thread-7', agent: 'research', origin: 'host', status: 'idle', sequence: 3, invocationIds: [] },
                {
                    id: 'thread-8',
                    agent: 'research',
                    origin: 'host',
                    status: 'idle',
                    sequence: 4,
                    invocationIds: 'inv-1'
                }
            ]
        });

        expect(threads.map((entry) => [entry.id, entry.invocationIds])).toEqual([
            ['thread-5', ['inv-7', 'inv-9']],
            ['thread-6', undefined],
            ['thread-7', undefined],
            ['thread-8', undefined]
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
