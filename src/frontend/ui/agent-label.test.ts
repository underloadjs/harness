// Compact agent labels (R2/R3).
//
// The label is part of the visible UI contract — a header reads `RH1`, not a raw
// agent id — so every value here is asserted exactly: the first/last letters, the
// per-agent occurrence, and the behaviour across normalisation and reset.

import { createAgentLabels } from './agent-label';

describe('createAgentLabels', () => {
    it('uses the uppercase first and last letter plus a 1-based occurrence', () => {
        const labels = createAgentLabels();

        expect(labels.next('research')).toBe('RH1');
        expect(labels.next('research')).toBe('RH2');
        expect(labels.next('workspace')).toBe('WE1');
        expect(labels.next('reviewer')).toBe('RR1');
        expect(labels.next('instruct')).toBe('IT1');
        expect(labels.next('summarizer')).toBe('SR1');
    });

    it('keeps one occurrence sequence per normalised agent', () => {
        const labels = createAgentLabels();

        // Identity normalisation is shared with the colour (`agentKeyOf`): case and
        // surrounding whitespace never mint a second sequence.
        expect(labels.next('Helper')).toBe('HR1');
        expect(labels.next(' helper ')).toBe('HR2');
        expect(labels.next('HELPER')).toBe('HR3');
        // A different agent starts its own sequence.
        expect(labels.next('deeper')).toBe('DR1');
    });

    it('skips punctuation and falls back for an unnamed agent', () => {
        const labels = createAgentLabels();

        // Non-alphanumeric glyphs are skipped, so the code stays two characters.
        expect(labels.next('research-2')).toBe('R21');
        // A one-character id yields the same letter twice (first AND last).
        expect(labels.next('a')).toBe('AA1');
        // No letters/digits at all: the neutral code, still counted apart.
        expect(labels.next('')).toBe('AG1');
        expect(labels.next(undefined)).toBe('AG2');
        expect(labels.next('???')).toBe('AG3');
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
