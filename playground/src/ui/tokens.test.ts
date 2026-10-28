// formatTokens tests: the turn header's token tally.
//
// The label mirrors the gateway log line (`122,111 (100,301)`): the cumulative
// INPUT count, with the cached (replayed) part in brackets only when the provider
// actually reported a cache figure. Absent usage renders '' because the caller
// hides the label — a provider that reports nothing must not print "0".
//
// Run: npx vitest run --config playground/vitest.config.ts
import type { HarnessUsage } from '../../../server/protocol';
import { formatTokens } from './tokens';

describe('formatTokens', () => {
    it('renders an empty string for an absent tally', () => {
        // Undefined is "no request reported usage", which the tile renders by
        // hiding the span — never as a fabricated zero.
        expect(formatTokens(undefined)).toBe('');
    });

    it('renders the input count alone when no cache figure was reported', () => {
        const usage: HarnessUsage = { input: 122111, output: 0, total: 0 };

        expect(formatTokens(usage)).toBe('122,111');
    });

    it('renders the cached part in brackets when the provider reported it', () => {
        const usage: HarnessUsage = { input: 122111, output: 0, total: 0, cached: 100301 };

        expect(formatTokens(usage)).toBe('122,111 (100,301)');
    });

    it('renders a reported zero cache figure, because zero is not absent', () => {
        // `cached: 0` is a real answer from the provider ("nothing served from
        // cache"); dropping the bracket would misreport it as "not reported".
        const usage: HarnessUsage = { input: 122111, output: 0, total: 0, cached: 0 };

        expect(formatTokens(usage)).toBe('122,111 (0)');
    });

    it('groups thousands with en-US separators', () => {
        const usage: HarnessUsage = { input: 1234567, output: 0, total: 0 };

        expect(formatTokens(usage)).toBe('1,234,567');
        expect(formatTokens({ input: 1234567, output: 0, total: 0, cached: 7654321 })).toBe(
            '1,234,567 (7,654,321)'
        );
    });

    it('truncates fractional counts instead of rounding them', () => {
        // Both counts go through Math.trunc: a provider that reports a fraction
        // (or a hand-built tally) must not round up past the real spend.
        const usage: HarnessUsage = { input: 122111.9, output: 0, total: 0, cached: 100301.7 };

        expect(formatTokens(usage)).toBe('122,111 (100,301)');
    });
});
