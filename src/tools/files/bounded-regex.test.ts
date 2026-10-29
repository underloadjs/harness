// tools/files/bounded-regex — a content matcher that cannot hang (T16).
//
// The defect this pins: fileGlob's `content` argument is a JavaScript regular
// expression supplied by a caller, and JavaScript regexes backtrack. `(a+)+$`
// against a 31-byte line of "a" plus "b" blocks the main thread for ~8 seconds, and
// worse patterns are effectively unbounded, so one tool call could freeze the
// harness. The fix runs the match loop inside `node:vm` with a real timeout.
//
// These tests are deliberately NOT "run the evil pattern and wait": the budget is a
// parameter, so the bound is proven with a short deadline. Waiting out the 30-second
// production budget would also exceed vitest's 15-second per-test timeout, so the
// DEFAULT is pinned as a number and enforced through a mocked clock in
// fileGlob.test.ts; the catastrophic-pattern stop itself is proven with an injected
// short budget here.
//
// What is pinned:
//   - ordinary matching is unchanged: 0-based indices, ascending, one per matching
//     line, `lastIndex` reset before every line;
//   - an invalid source still throws the HOST realm's SyntaxError, so a caller sees
//     the parser's message and can `instanceof` it;
//   - a catastrophic pattern is stopped and reported as a HarnessError naming the
//     budget and the likely cause, with no partial answer;
//   - an exhausted budget is refused before any work, and the failure does not
//     poison a later search.

import { describe, expect, it, vi } from 'vitest';
import { HarnessError } from '../../util';
import {
    budgetError,
    createBoundedLineMatcher,
    MAX_CONTENT_MATCH_MILLIS
} from './bounded-regex';

// The classic catastrophic pattern from the review, against a line it must fail on.
const EVIL_SOURCE = '(a+)+$';
const EVIL_LINE = `${'a'.repeat(31)}b`;

describe('createBoundedLineMatcher', () => {
    it('returns the 0-based indices of matching lines, in ascending order', () => {
        const matcher = createBoundedLineMatcher('TODO');

        expect(matcher.testLines(['TODO one', 'nope', 'TODO: two', ''])).toEqual([0, 2]);
        // Every line matching, so no off-by-one at the end of the array.
        expect(matcher.testLines(['TODO', 'TODO'])).toEqual([0, 1]);
        expect(matcher.testLines([])).toEqual([]);
    });

    it('keeps regular-expression semantics, including groups and alternation', () => {
        const matcher = createBoundedLineMatcher('TODO: (one|three)');

        expect(matcher.testLines(['// TODO: one', 'TODO: two', 'TODO: three'])).toEqual([0, 2]);
    });

    it('resets lastIndex before every line', () => {
        // The source carries no flags, so a stateful matcher should be impossible —
        // this pins the defensive reset anyway: the SAME matcher object is reused
        // across files, and a future flag would otherwise skip lines.
        const matcher = createBoundedLineMatcher('a');

        expect(matcher.testLines(['a', 'a', 'a'])).toEqual([0, 1, 2]);
        expect(matcher.testLines(['a1', 'b', 'a2'])).toEqual([0, 2]);
        // Re-using the matcher after a call cannot carry state into the next one.
        expect(matcher.testLines(['b', 'a'])).toEqual([1]);
    });

    it('surfaces an invalid source as the host realm SyntaxError', () => {
        // A SyntaxError created inside the vm context would not be an instance of
        // this realm's SyntaxError, so validation happens here first.
        expect(() => createBoundedLineMatcher('[')).toThrow(SyntaxError);
        expect(() => createBoundedLineMatcher('(a')).toThrow(/Unterminated group/);
    });

    it('publishes a 30-second default matching budget', () => {
        // The production budget fileGlob uses when nothing is injected. 30s is the
        // ONLY matching bound: generous for a legitimate deep grep, still finite for
        // a catastrophic pattern.
        expect(MAX_CONTENT_MATCH_MILLIS).toBe(30_000);
    });

    it('enforces the default budget instead of running the pattern to completion', () => {
        // Waiting out the real 30s default would exceed vitest's 15s test timeout, so
        // the clock is mocked: the deadline starts at the first `testLines` call, and
        // the second clock read is already past the default budget. An exhausted
        // budget is refused BEFORE matching, so this proves the default is actually
        // wired in and that the error names it, without burning 30s.
        const now = vi.spyOn(Date, 'now');

        try {
            now.mockReturnValueOnce(1_000_000);
            now.mockReturnValue(1_000_000 + MAX_CONTENT_MATCH_MILLIS);

            const matcher = createBoundedLineMatcher(EVIL_SOURCE);

            expect(() => matcher.testLines([EVIL_LINE])).toThrow(
                budgetError(MAX_CONTENT_MATCH_MILLIS)
            );
        } finally {
            now.mockRestore();
        }
    });

    it('reports the budget and the likely cause, not a partial answer', () => {
        // A short deadline keeps this test fast; the message is what a caller reads.
        const matcher = createBoundedLineMatcher(EVIL_SOURCE, 150);

        let caught: unknown;
        try {
            matcher.testLines(['safe line first', EVIL_LINE, 'safe line last']);
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(HarnessError);
        expect((caught as HarnessError).message).toBe(
            'fileGlob content pattern did not finish within its 150ms matching budget and was stopped. Simplify the pattern: nested quantifiers such as "(a+)+" can backtrack exponentially.'
        );
    });

    it('refuses an already exhausted budget before running anything', () => {
        // A zero budget means the deadline has passed. Node treats `timeout: 0` as
        // "no timeout", so this must be rejected here — otherwise a budget of 0
        // would be the one setting that removes the bound.
        const matcher = createBoundedLineMatcher('TODO', 0);

        expect(() => matcher.testLines(['TODO'])).toThrow(budgetError(0));
    });

    it('does not poison a later search after a timeout', () => {
        // A timed-out vm context is reusable; nothing caches the failure. Proving it
        // matters because one bad file in a walk must not break the next one.
        expect(() =>
            createBoundedLineMatcher(EVIL_SOURCE, 100).testLines([EVIL_LINE])
        ).toThrow(budgetError(100));

        expect(createBoundedLineMatcher('TODO', 100).testLines(['TODO here'])).toEqual([0]);
    });

    it('scans a large line array inside the budget', () => {
        // 20,000 lines is a realistic large file. The vm boundary is crossed ONCE
        // per file (not once per line), which is why this stays fast enough to be a
        // normal tool call instead of a per-line overhead cliff.
        const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index} with TODO text`);

        expect(createBoundedLineMatcher('TODO').testLines(lines)).toEqual(
            Array.from({ length: 20_000 }, (_, index) => index)
        );
    });
});
