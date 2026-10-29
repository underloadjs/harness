// Compact agent labels (R2/R3).
//
// The allocator now lives in `shared/agent-results.ts` (single owner); this file
// pins the FRONTEND import path and the shared rules:
//   - uppercase first + last ASCII LETTER (digits/punctuation ignored), fallback AG;
//   - counters are keyed by the two-letter CODE, so different ids with the same
//     code share one sequence instead of colliding;
//   - reset re-numbers a rebuilt turn; separate allocators are independent.

import { createAgentLabels } from './agent-label';

describe('createAgentLabels', () => {
    it('uses the uppercase first and last ASCII letter plus a 1-based occurrence', () => {
        const labels = createAgentLabels();

        expect(labels.next('research')).toBe('RH1');
        expect(labels.next('research')).toBe('RH2');
        expect(labels.next('workspace')).toBe('WE1');
        expect(labels.next('reviewer')).toBe('RR1');
        expect(labels.next('instruct')).toBe('IT1');
        expect(labels.next('summarizer')).toBe('SR1');
    });

    it('normalises identity before allocating', () => {
        const labels = createAgentLabels();

        expect(labels.next('Helper')).toBe('HR1');
        expect(labels.next(' helper ')).toBe('HR2');
        expect(labels.next('HELPER')).toBe('HR3');
        expect(labels.next('deeper')).toBe('DR1');
    });

    it('ignores digits and non-ASCII glyphs, falling back to AG', () => {
        const labels = createAgentLabels();

        // `research-2` -> letters only -> RH; the digit is not part of the code.
        expect(labels.next('research-2')).toBe('RH1');
        // A one-letter id yields the same letter twice.
        expect(labels.next('a')).toBe('AA1');
        // No ASCII letters at all: one shared neutral sequence.
        expect(labels.next('')).toBe('AG1');
        expect(labels.next(undefined)).toBe('AG2');
        expect(labels.next('???')).toBe('AG3');
        expect(labels.next('研究员')).toBe('AG4');
        expect(labels.next('123')).toBe('AG5');
    });

    it('counts per two-letter code so colliding ids cannot mint duplicate labels', () => {
        const labels = createAgentLabels();

        expect(labels.next('research')).toBe('RH1');
        // Same first+last letters, different agent: same code sequence.
        expect(labels.next('rhesearch')).toBe('RH2');
        expect(labels.next('research')).toBe('RH3');

        expect(labels.next('reviewer')).toBe('RR1');
        expect(labels.next('reader')).toBe('RR2');
    });

    it('resets every occurrence so a rebuilt projection re-numbers from 1', () => {
        const labels = createAgentLabels();

        expect(labels.next('research')).toBe('RH1');
        expect(labels.next('research')).toBe('RH2');

        labels.reset();

        expect(labels.next('research')).toBe('RH1');
    });

    it('keeps separate turns independent', () => {
        const first = createAgentLabels();
        const second = createAgentLabels();

        expect(first.next('research')).toBe('RH1');
        expect(first.next('research')).toBe('RH2');
        expect(second.next('research')).toBe('RH1');
    });
});
