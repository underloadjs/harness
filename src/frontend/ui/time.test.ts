// Exact duration formatting and safe span arithmetic.
//
// These are the values every elapsed label prints, so they are asserted exactly:
// no ranges, no "contains", and no invented value when a span is unknown.

import { elapsedBetween, formatDuration, formatElapsed } from './time';

describe('formatDuration', () => {
    it('renders milliseconds below one second', () => {
        expect(formatDuration(0)).toBe('0ms');
        expect(formatDuration(1)).toBe('1ms');
        expect(formatDuration(999)).toBe('999ms');
    });

    it('renders tenths of a second below one minute', () => {
        expect(formatDuration(1000)).toBe('1.0s');
        expect(formatDuration(1550)).toBe('1.6s');
        expect(formatDuration(59_949)).toBe('59.9s');
    });

    it('renders minutes plus zero-padded seconds from one minute up, with no gap', () => {
        // R4: compact `4m12s` — no space between the minute and second parts, and
        // the seconds keep their zero padding (and sub-minute tenths) intact.
        expect(formatDuration(60_000)).toBe('1m00s');
        expect(formatDuration(65_400)).toBe('1m05s');
        expect(formatDuration(252_000)).toBe('4m12s');
        expect(formatDuration(3_600_000)).toBe('60m00s');
    });

    it('returns an empty label for invalid or negative spans', () => {
        expect(formatDuration(-1)).toBe('');
        expect(formatDuration(Number.NaN)).toBe('');
        expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('');
    });
});

describe('elapsedBetween', () => {
    it('subtracts finite epoch stamps', () => {
        expect(elapsedBetween(1000, 3500)).toBe(2500);
        expect(elapsedBetween(1000, 1000)).toBe(0);
    });

    it('returns undefined instead of NaN for missing or backwards stamps', () => {
        expect(elapsedBetween(undefined, 3500)).toBeUndefined();
        expect(elapsedBetween(1000, undefined)).toBeUndefined();
        expect(elapsedBetween(Number.NaN, 3500)).toBeUndefined();
        expect(elapsedBetween(3500, 1000)).toBeUndefined();
        expect(elapsedBetween('1000', 3500)).toBeUndefined();
    });
});

describe('formatElapsed', () => {
    it('formats a valid span and hides an invalid one', () => {
        expect(formatElapsed(1000, 3500)).toBe('2.5s');
        expect(formatElapsed(undefined, 3500)).toBeUndefined();
        expect(formatElapsed(3500, 1000)).toBeUndefined();
    });
});
