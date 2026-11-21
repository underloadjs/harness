// core/tool-outcome.ts — the three rules behind the persisted tool outcome
// (progressive-compaction T1). The runtime wires them in at four sites
// (src/harness.ts writes, core/agent.ts copies a fork baseline, core/snapshot.ts and
// core/branch.ts read untrusted documents); this file pins the rules THEMSELVES, so a
// later site cannot quietly re-spell them.
//
// Pinned contract:
//   - `TOOL_OUTCOMES` is exactly the union in ../types, in the order a refusal message
//     lists it (a validation string a test quotes, so the order is part of the contract);
//   - WRITE omits `completed` AND an unclassified delivery, and copies every other value
//     verbatim — never re-decided from result text;
//   - READ answers `completed` for an absent key, which is what keeps every pre-outcome
//     transcript, snapshot fixture and branch record valid with no migration (T1.5);
//   - DERIVE: `isError` is `outcome !== 'completed'`, from the classification or from the
//     committed entry, and is never a second stored field;
//   - the serialized form is byte-exact, including KEY ORDER (a snapshot is JSON, and the
//     order is the one the type declares: after `name`, before `included`/`messageId`).

import { describe, expect, it } from 'vitest';
import {
    TOOL_OUTCOMES,
    isErrorOutcome,
    isToolOutcome,
    storedOutcomeEntry,
    toolOutcomeOf,
    toolResultIsError
} from './tool-outcome';
import type { HarnessMessage, HarnessToolOutcome } from '../types';

const NON_COMPLETED: HarnessToolOutcome[] = ['failed', 'rejected', 'cancelled'];

describe('tool outcome vocabulary', () => {
    it('pins the union exactly, in the order a refusal message lists it', () => {
        expect(TOOL_OUTCOMES).toEqual(['completed', 'failed', 'rejected', 'cancelled']);
    });

    it('narrows only the four members, and refuses everything else', () => {
        for (const outcome of TOOL_OUTCOMES) {
            expect(isToolOutcome(outcome)).toBe(true);
        }

        // A mistyped classification is REFUSED by both readers rather than read as
        // `completed`, so these are the shapes that must not pass.
        expect(isToolOutcome('fail')).toBe(false);
        expect(isToolOutcome('Failed')).toBe(false);
        expect(isToolOutcome('')).toBe(false);
        expect(isToolOutcome(undefined)).toBe(false);
        expect(isToolOutcome(null)).toBe(false);
        expect(isToolOutcome(0)).toBe(false);
        expect(isToolOutcome(true)).toBe(false);
        expect(isToolOutcome({ outcome: 'failed' })).toBe(false);
        expect(isToolOutcome(['failed'])).toBe(false);
    });
});

describe('storedOutcomeEntry — the write rule', () => {
    it('omits the key for `completed` and for an unclassified delivery', () => {
        // `completed` and `undefined` are the two spellings of "healthy", and both mean NO
        // key. This is the property every pre-existing transcript assertion depends on.
        expect(storedOutcomeEntry('completed')).toEqual({});
        expect(storedOutcomeEntry(undefined)).toEqual({});
        expect(Object.keys(storedOutcomeEntry('completed'))).toEqual([]);
        expect(Object.keys(storedOutcomeEntry(undefined))).toEqual([]);
    });

    it('stores every non-completed outcome verbatim', () => {
        expect(storedOutcomeEntry('failed')).toEqual({ outcome: 'failed' });
        expect(storedOutcomeEntry('rejected')).toEqual({ outcome: 'rejected' });
        expect(storedOutcomeEntry('cancelled')).toEqual({ outcome: 'cancelled' });
    });

    it('produces the byte-exact transcript entry, with the key after `name`', () => {
        const base = { role: 'tool', content: 'r', toolCallId: 'c1', name: 'read' };

        // The pre-T1 shape, byte for byte, for a healthy delivery.
        expect(JSON.stringify({ ...base, ...storedOutcomeEntry('completed') })).toBe(
            '{"role":"tool","content":"r","toolCallId":"c1","name":"read"}'
        );
        expect(JSON.stringify({ ...base, ...storedOutcomeEntry(undefined) })).toBe(
            '{"role":"tool","content":"r","toolCallId":"c1","name":"read"}'
        );

        // One key, in the position the type declares, for each failure shape.
        expect(JSON.stringify({ ...base, ...storedOutcomeEntry('failed') })).toBe(
            '{"role":"tool","content":"r","toolCallId":"c1","name":"read","outcome":"failed"}'
        );
        expect(JSON.stringify({ ...base, ...storedOutcomeEntry('cancelled') })).toBe(
            '{"role":"tool","content":"r","toolCallId":"c1","name":"read","outcome":"cancelled"}'
        );
    });
});

describe('toolOutcomeOf / isErrorOutcome / toolResultIsError — the read and derive rules', () => {
    it('reads an absent outcome as completed', () => {
        // A pre-outcome transcript, a completed result, and a branch's pending placeholder
        // are all the same shape here: no key.
        const preOutcome = {
            role: 'tool',
            content: 'Tool "read" failed: kaput',
            toolCallId: 'c1',
            name: 'read'
        } as Extract<HarnessMessage, { role: 'tool' }>;

        expect('outcome' in preOutcome).toBe(false);
        expect(toolOutcomeOf(preOutcome)).toBe('completed');
        // The prose says "failed"; the stored fact says healthy. There is deliberately no
        // bridge that reconciles the two (T1.5), which is why a prune policy needs a
        // superseding later success and never touches an uncommitted unit (T0 Q3).
        expect(preOutcome.content).toContain('failed');
        expect(toolResultIsError(preOutcome)).toBe(false);
    });

    it('reads a stored outcome verbatim', () => {
        for (const outcome of NON_COMPLETED) {
            expect(toolOutcomeOf({ outcome })).toBe(outcome);
        }

        // An explicit `completed` reads as itself; both readers normalize it to ABSENT
        // before it can reach canonical state, so it never persists.
        expect(toolOutcomeOf({ outcome: 'completed' })).toBe('completed');
    });

    it('derives isError from the classification and from the entry alike', () => {
        expect(isErrorOutcome('completed')).toBe(false);
        expect(NON_COMPLETED.map(isErrorOutcome)).toEqual([true, true, true]);

        expect(toolResultIsError({})).toBe(false);
        expect(toolResultIsError({ outcome: 'completed' })).toBe(false);
        expect(NON_COMPLETED.map((outcome) => toolResultIsError({ outcome }))).toEqual([
            true,
            true,
            true
        ]);

        // The single property that makes drift impossible: the projection of the STORED form
        // equals the projection of the classification for every value, including the one
        // that stores nothing.
        for (const outcome of TOOL_OUTCOMES) {
            const stored = storedOutcomeEntry(outcome) as { outcome?: HarnessToolOutcome };
            expect(toolResultIsError(stored)).toBe(isErrorOutcome(outcome));
        }
    });
});
