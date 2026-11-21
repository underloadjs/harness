/**
 * Contract tests for the IT19 R1 retention repair (core/transcript-repair.ts).
 *
 * These pin the four invariants the retained-turn fix rests on: (a) a synthesized result lands in
 * the position a real result would have — directly after its assistant turn's existing results,
 * including for the SECOND assistant turn in the run, where a naive append would drop it behind a
 * later `user` message; (b) the repair never touches anything outside the run's own range, so a
 * call still genuinely in flight in another subsystem is not silently answered; (c) an entry
 * carries the TOOL NAME of the call it stands in for, because the caller builds the replacement
 * message from the entry alone and must not re-scan an array whose indices are moving; and (d) the
 * two producers' SENTENCES stay distinct and honest — the live path says "cancelled or interrupted"
 * and never claims a server restart, and `isInterruptedToolResult` recognises both regardless.
 */

import { describe, expect, it } from 'vitest';

import {
    findInterruptedToolCalls,
    isInterruptedToolResult,
    repairInterruptedToolCalls,
    SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT,
} from './transcript-repair';
import type { HarnessMessage } from '../types';

/** Minimal assistant turn that requested `ids`, all naming the same tool. */
const assistant = (content: string, ids: string[] = [], name = 'shell'): HarnessMessage => ({
    role: 'assistant',
    content,
    ...(ids.length ? { toolCalls: ids.map((id) => ({ id, name, arguments: '{}' })) } : {}),
});

/** Minimal tool result answering `callId`. */
const result = (callId: string, content = 'ok'): HarnessMessage => ({ role: 'tool', content, toolCallId: callId, name: 'shell' });

/**
 * The shape the repair WRITES — content is fixed by the module, and the caller supplies the id and
 * the tool name FROM THE ENTRY (mirroring `insertToolMessage`, harness.ts, which records
 * `name: call.name` on a real result). Taking the whole entry rather than the id is what makes the
 * `callName` contract observable here.
 */
const synthesized = (entry: { callId: string; callName: string }): HarnessMessage => ({
    role: 'tool',
    content: SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT,
    toolCallId: entry.callId,
    name: entry.callName,
});

describe('core/transcript-repair', () => {
    it('synthesizes one result per unanswered call, directly after the assistant turn', () => {
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'run it' },
            assistant('working', ['call_1', 'call_2']),
            result('call_1'),
        ];

        const repaired = repairInterruptedToolCalls(messages, 1, synthesized);

        // call_2 was the only dangling one, and its result belongs at index 3 (after call_1's).
        // The entry names the tool the call asked for, so the caller never re-scans for it.
        expect(repaired).toEqual([
            {
                callId: 'call_2',
                callName: 'shell',
                assistantIndex: 1,
                insertAt: 3,
                index: 3,
                message: synthesized({ callId: 'call_2', callName: 'shell' }),
            },
        ]);
        expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
        expect(messages[3]).toEqual({
            role: 'tool',
            content: SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT,
            toolCallId: 'call_2',
            name: 'shell',
        });
    });

    it('keeps pairable order across two assistant turns, each naming its own tool', () => {
        // Turn 1 asked for two `shell` calls and answered neither; turn 2 (after the user spoke
        // again) asked for one `read` call and answered none either. Two different tools in one run
        // is the case a hardcoded name would pass by accident.
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'first' },
            assistant('one', ['a1', 'a2']),
            { role: 'user', content: 'second' },
            assistant('two', ['b1'], 'read'),
        ];

        repairInterruptedToolCalls(messages, 1, synthesized);

        // Each synthesized result sits beside its own assistant turn — never appended at the end,
        // which would leave `user(second)` between a call and its answer and break pairing.
        expect(messages).toEqual([
            { role: 'user', content: 'first' },
            assistant('one', ['a1', 'a2']),
            synthesized({ callId: 'a1', callName: 'shell' }),
            synthesized({ callId: 'a2', callName: 'shell' }),
            { role: 'user', content: 'second' },
            assistant('two', ['b1'], 'read'),
            synthesized({ callId: 'b1', callName: 'read' }),
        ]);
    });

    it('never repairs a dangling call outside the run range, and never duplicates an answered one', () => {
        const messages: HarnessMessage[] = [
            // Parked by another subsystem BEFORE this run's root message (index 2): out of scope.
            assistant('older', ['parked']),
            { role: 'user', content: 'older turn' },
            assistant('mine', ['call_1']),
            // Answered later than the call, still inside the window: must not be duplicated.
            result('call_1'),
        ];

        // Un-scanned from the top, the parked call IS reportable — with the position a result would
        // have needed (index 1, before the `user` message that followed the call).
        expect(findInterruptedToolCalls(messages, 0)).toEqual([
            { callId: 'parked', callName: 'shell', assistantIndex: 0, insertAt: 1 },
        ]);
        // Inside the run's own range there is nothing to repair, so the array is untouched.
        expect(findInterruptedToolCalls(messages, 2)).toEqual([]);
        expect(repairInterruptedToolCalls(messages, 2, synthesized)).toEqual([]);
        expect(messages.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant', 'tool']);
    });

    it('reports an empty tool name for a malformed call instead of inventing one', () => {
        // A live transcript can carry a call with no name (the id is what pairing uses). The repair
        // reports the same empty string the live write path records, and still answers the call.
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'run it' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: undefined as unknown as string, arguments: '{}' }] },
        ];

        expect(findInterruptedToolCalls(messages, 1)).toEqual([
            { callId: 'call_1', callName: '', assistantIndex: 1, insertAt: 2 },
        ]);
    });

    it('recognizes both interrupted-result markers and nothing else', () => {
        // The byte-exact sentence the server's crash repair writes. The engine module
        // duplicates it by value (it may not import the server tree), and the server-side
        // parity pin in src/server/transcript-marker.test.ts keeps the two in step.
        const persistenceText =
            'The server restarted before this tool call completed. The call was interrupted and has NOT been executed since; no result is available.';
        const persistenceMarker: HarnessMessage = {
            role: 'tool',
            content: persistenceText,
            toolCallId: 'call_1',
            name: 'shell',
        };
        expect(isInterruptedToolResult(synthesized({ callId: 'call_1', callName: 'shell' }))).toBe(true);
        expect(isInterruptedToolResult(persistenceMarker)).toBe(true);
        expect(isInterruptedToolResult(result('call_1', 'real output'))).toBe(false);
        expect(isInterruptedToolResult({ role: 'assistant', content: SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT })).toBe(false);
        expect(isInterruptedToolResult({ role: 'assistant', content: persistenceText })).toBe(false);
        expect(isInterruptedToolResult(undefined)).toBe(false);
        // The two markers stay DISTINCT sentences (live cancellation vs server crash — file header of
        // transcript-repair.ts). A shared sentence would let a crash row claim "re-issue the call"
        // and a cancellation row claim "the server restarted", and the owed-account upgrade could no
        // longer tell an interrupted call from a crash-orphaned one.
        expect(persistenceText).not.toBe(SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT);
        // THE HONEST-MARKER RULE (IT19 R1). This module writes the LIVE marker only, and the live path
        // never claims a SERVER restart: what it stands in for is a `toolCancel`, a user stop, a
        // caller release or a provider fault inside a session that is still up and answering. The
        // sentence used to be byte-identical to the persistence one, which made every cancelled call
        // report a restart that never happened. "cancelled or interrupted" is the substring other
        // suites assert, so it is pinned here as well, and "server restarted" stays the exclusive
        // property of the crash sentence.
        expect(SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT).toContain('cancelled or interrupted');
        expect(SYNTHESIZED_INTERRUPTED_TOOL_RESULT_TEXT.toLowerCase()).not.toContain('server restarted');
        expect(persistenceText.toLowerCase()).toContain('server restarted');
    });

    it('answers a call that was answered non-contiguously, once, wherever its result sits', () => {
        // `call_1`'s real result is THREE rows away — separated by a `user` message, so the
        // contiguous-result walk below the assistant turn never sees it. Deciding "answered" from
        // that block alone would fabricate a second result for one call id, which is precisely the
        // shape a provider request schema rejects (persistence.ts:1685-1702 states the same rule for
        // the crash pass — collect the answered ids across the whole transcript first).
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'run it' },
            assistant('working', ['call_1', 'call_2']),
            { role: 'user', content: 'a message landed in between' },
            result('call_1', 'the real answer'),
            // `call_3` is answered before the run range even starts — out of order, still answered.
        ];

        expect(findInterruptedToolCalls(messages, 1)).toEqual([
            // Only the genuinely unanswered call is reported, and it belongs directly after the
            // existing block (index 2), not at the end of the array.
            { callId: 'call_2', callName: 'shell', assistantIndex: 1, insertAt: 2 },
        ]);

        repairInterruptedToolCalls(messages, 1, synthesized);

        expect(messages).toEqual([
            { role: 'user', content: 'run it' },
            assistant('working', ['call_1', 'call_2']),
            synthesized({ callId: 'call_2', callName: 'shell' }),
            { role: 'user', content: 'a message landed in between' },
            result('call_1', 'the real answer'),
        ]);
    });

    it('is idempotent: a second pass over a repaired transcript adds nothing', () => {
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'first' },
            assistant('one', ['a1', 'a2']),
            result('a1'),
            { role: 'user', content: 'second' },
            assistant('two', ['b1'], 'read'),
        ];

        const before = repairInterruptedToolCalls(messages, 1, synthesized);

        expect(before.map((entry) => entry.callId)).toEqual(['a2', 'b1']);

        const after = repairInterruptedToolCalls(messages, 1, synthesized);

        // Every call now has exactly one result, so the scan reports nothing and the array is not
        // grown. This is what makes `restore -> repair -> restore` byte-stable.
        expect(after).toEqual([]);
        expect(messages).toEqual([
            { role: 'user', content: 'first' },
            assistant('one', ['a1', 'a2']),
            result('a1'),
            synthesized({ callId: 'a2', callName: 'shell' }),
            { role: 'user', content: 'second' },
            assistant('two', ['b1'], 'read'),
            synthesized({ callId: 'b1', callName: 'read' }),
        ]);
        expect(findInterruptedToolCalls(messages, 0)).toEqual([]);
    });
});
