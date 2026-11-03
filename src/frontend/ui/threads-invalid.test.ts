// C6 — the C4 invalid-transcript roster is read defensively and survives verbatim.
//
// `SessionSnapshot.invalidThreads` (src/server/protocol.ts `SessionInvalidThread`) is
// the ONLY place the raw, unreadable transcript value lives: the matching
// `threads[].messages` row holds the server's placeholder. So two properties are load
// bearing for the repair surface, and nothing between the wire and the UI may break
// either one:
//
//   1. each entry's `messages` reaches the client EXACTLY as stored — an opaque JSON
//      value (an object, a scalar, an array of half-valid messages), never narrowed,
//      never re-validated as `HarnessMessage[]`;
//   2. one malformed entry costs only itself: an entry with no usable id is dropped and
//      the valid neighbours stay, because hiding a broken conversation is what makes it
//      unfixable.
//
// These are the rules `main.ts#applySnapshot` relies on when it stores the answer as
// `{ ...session, turns, threads }` with no snapshot whitelist (see the pass-through
// note in contract.ts). The shell-level round trip is pinned in
// `src/frontend/snapshot-invalid-threads-main.test.ts`.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/threads-invalid.test.ts

import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, SessionThread } from '../../server/protocol';
import { invalidThreadsOf, sessionThreadsOf } from './threads';

const snapshotOf = (overrides: Record<string, unknown> = {}): SessionSnapshot =>
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

const threadOf = (overrides: Partial<SessionThread> & { id: string }): SessionThread => ({
    agent: 'instruct',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    messages: [],
    ...overrides
});

// The wire is JSON: every fixture here is taken through a real round trip first, so a
// normalizer that dropped an unknown key would fail this file, not only the shell test.
const overTheWire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// What the server installs in `threads[].messages` for an unreadable thread
// (src/server/sessions.ts `unreadableTranscript`). Kept here to prove the roster reader
// never confuses it with the value the user has to fix.
const PLACEHOLDER = [{ role: 'system', content: '[transcript unreadable: messages is not an array]' }];

// A value no `HarnessMessage[]` reader can accept, with nesting the client must not
// flatten or re-shape.
const RAW_BROKEN = {
    messages: [{ role: 'user', text: 'hand typed' }],
    note: 'edited by hand',
    count: 3
};

describe('invalidThreadsOf', () => {
    it('keeps a valid entry and its raw messages verbatim across a JSON round trip', () => {
        const snapshot = overTheWire(
            snapshotOf({
                invalidThreads: [
                    {
                        id: 'thread-a',
                        label: 'IN1',
                        agent: 'instruct',
                        error: 'messages is not an array',
                        messages: RAW_BROKEN
                    }
                ]
            })
        );

        expect(invalidThreadsOf(snapshot)).toEqual([
            {
                id: 'thread-a',
                label: 'IN1',
                agent: 'instruct',
                error: 'messages is not an array',
                messages: RAW_BROKEN
            }
        ]);
        // Structural equality against the value the server wrote: nothing re-parses,
        // narrows or re-orders it on the way through the roster reader.
        expect(invalidThreadsOf(snapshot)[0].messages).toEqual(RAW_BROKEN);
    });

    it('keeps every shape a broken transcript really can have', () => {
        // The server persists whatever JSON the editor sent, so an unreadable value is
        // routinely an array of half-valid messages, a bare string, or a number.
        const snapshot = snapshotOf({
            invalidThreads: [
                { id: 'a', error: 'role must be "user"', messages: [{ role: 'tool', content: 'x' }] },
                { id: 'b', error: 'not an array', messages: 'nope' },
                { id: 'c', error: 'not an array', messages: 7 },
                { id: 'd', error: 'not an array', messages: null }
            ]
        });

        expect(invalidThreadsOf(snapshot).map((record) => [record.id, record.messages])).toEqual([
            ['a', [{ role: 'tool', content: 'x' }]],
            ['b', 'nope'],
            ['c', 7],
            ['d', null]
        ]);
        // Absent optionals are omitted, never fabricated as empty strings.
        expect(invalidThreadsOf(snapshot)[1].label).toBeUndefined();
        expect(invalidThreadsOf(snapshot)[1].agent).toBeUndefined();
    });

    it('drops a malformed entry and keeps its valid neighbours', () => {
        const snapshot = snapshotOf({
            invalidThreads: [
                'a bare string is not a conversation',
                null,
                { error: 'no id, so nothing can join it', messages: RAW_BROKEN },
                { id: '   ', error: 'blank id', messages: RAW_BROKEN },
                { id: 'thread-a', label: 'IN1', agent: 'instruct', error: 'bad', messages: RAW_BROKEN },
                // The same id twice (a server bug): first entry wins, no duplicate row.
                { id: 'thread-a', error: 'duplicate', messages: 'second' }
            ]
        });

        expect(invalidThreadsOf(snapshot)).toEqual([
            { id: 'thread-a', label: 'IN1', agent: 'instruct', error: 'bad', messages: RAW_BROKEN }
        ]);
    });

    it('falls back to a stated reason when the entry has no usable error text', () => {
        const [record] = invalidThreadsOf(
            snapshotOf({ invalidThreads: [{ id: 'thread-a', error: 7, messages: [] }] })
        );

        expect(record.error).toBe('the stored transcript could not be read');
        // An empty transcript value is still the value the reader has to fix.
        expect(record.messages).toEqual([]);
    });

    it('reads a missing or malformed roster as "no unreadable thread"', () => {
        // An older server has no C4 field at all — that is byte-identical to none.
        expect(invalidThreadsOf(snapshotOf())).toEqual([]);
        expect(invalidThreadsOf(snapshotOf({ invalidThreads: null }))).toEqual([]);
        expect(invalidThreadsOf(snapshotOf({ invalidThreads: {} }))).toEqual([]);
        expect(invalidThreadsOf(undefined)).toEqual([]);
        expect(invalidThreadsOf('snapshot')).toEqual([]);
    });
});

describe('sessionThreadsOf and the invalid roster', () => {
    it('joins the record onto the roster row without touching either transcript', () => {
        const snapshot = overTheWire(
            snapshotOf({
                threads: [threadOf({ id: 'thread-a', label: 'IN1', messages: PLACEHOLDER as never })],
                invalidThreads: [
                    { id: 'thread-a', label: 'IN1', agent: 'instruct', error: 'messages is not an array', messages: RAW_BROKEN }
                ]
            })
        );

        const [entry] = sessionThreadsOf(snapshot);

        expect(entry.id).toBe('thread-a');
        expect(entry.invalid).toEqual({
            id: 'thread-a',
            label: 'IN1',
            agent: 'instruct',
            error: 'messages is not an array',
            messages: RAW_BROKEN
        });
        // The placeholder stays on the row: it is what the MODEL is sent. The raw value
        // is only ever reachable through `invalid`, which is what the editor reads.
        expect(entry.messages).toEqual(PLACEHOLDER);
    });

    it('synthesizes a row for a conversation the roster lost, and ignores a nameless entry', () => {
        const snapshot = snapshotOf({
            threads: [threadOf({ id: 'thread-a' })],
            invalidThreads: [
                { id: 'thread-gone', label: 'IN9', agent: 'instruct', error: 'not an array', messages: 'nope' },
                { error: 'not an array', messages: 'nope' }
            ]
        });

        expect(sessionThreadsOf(snapshot).map((entry) => entry.id)).toEqual(['thread-a', 'thread-gone']);
        expect(sessionThreadsOf(snapshot)[1].invalid?.messages).toBe('nope');
        expect(sessionThreadsOf(snapshot)[1].label).toBe('IN9');
    });

    it('leaves a healthy roster byte-identical to the pre-C4 shape', () => {
        const healthy = snapshotOf({ threads: [threadOf({ id: 'thread-a' })] });
        const withEmptyRoster = overTheWire(
            snapshotOf({ threads: [threadOf({ id: 'thread-a' })], invalidThreads: [] })
        );

        expect(sessionThreadsOf(withEmptyRoster)).toEqual(sessionThreadsOf(healthy));
    });
});
