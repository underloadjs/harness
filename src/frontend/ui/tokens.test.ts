// formatTokens tests: the turn header's token tally.
//
// Two intentionally different scopes (R1/R2): the primary is the LATEST model
// request's input/context size, the bracket is the total cached input sent across
// the whole turn. `output` is never passed here, so it can never appear.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import { formatTokens } from './tokens';

describe('formatTokens', () => {
    it('renders an empty string for an absent tally', () => {
        // Undefined is "no request reported usage", which the tile renders by
        // hiding the span — never as a fabricated zero.
        expect(formatTokens(undefined)).toBe('');
        // A cache figure without an input cannot be displayed either.
        expect(formatTokens(undefined, 140)).toBe('');
    });

    it('renders the latest request input alone when no cache figure was reported', () => {
        // Without a cache figure the bracket is unknown, so it is omitted rather
        // than invented as "(0)".
        expect(formatTokens(122111)).toBe('122,111');
    });

    it('uses the latest request input (not the sum) with the cumulative cache', () => {
        // Fixture: request 1 { input 100, cached 40, output 7 }, request 2
        // { input 150, cached 100, output 9 }. The row must read 150 (140):
        //   NOT 250 (140) — that sums the re-sent transcript inputs;
        //   NOT 110 (140) — that subtracts the cache from the latest context.
        // Output (7 + 9) is never part of either number.
        expect(formatTokens(150, 140)).toBe('150 (140)');
    });

    it('allows the cumulative cache to exceed the latest request context', () => {
        // Different scopes: many tool rounds can replay more cached tokens than
        // the latest request's whole context. This is not an error state.
        expect(formatTokens(150, 1_000)).toBe('150 (1,000)');
    });

    it('renders a reported zero cache figure, because zero is not absent', () => {
        // `cached: 0` is a real answer ("nothing served from cache"); dropping the
        // bracket would misreport it as "not reported".
        expect(formatTokens(150, 0)).toBe('150 (0)');
    });

    it('groups thousands with en-US separators', () => {
        expect(formatTokens(1234567)).toBe('1,234,567');
        expect(formatTokens(1234567, 7654321)).toBe('1,234,567 (7,654,321)');
    });

    it('clamps negative counts instead of rendering them', () => {
        // The display never claims negative spend; a malformed/legacy tally is
        // clamped per figure (the scopes are independent, so no cross-clamp).
        expect(formatTokens(-10, -20)).toBe('0 (0)');
    });

    it('truncates fractional counts instead of rounding them', () => {
        // A provider that reports a fraction (or a hand-built tally) must not
        // round up past the real spend.
        expect(formatTokens(150.9, 140.7)).toBe('150 (140)');
    });
});
