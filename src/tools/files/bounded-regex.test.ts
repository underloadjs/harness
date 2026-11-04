// tools/files/bounded-regex — a content matcher that cannot hang (T16), and a budget
// that charges MATCHING only (the defect this revision fixes).
//
// The defect this file's SECOND half pins: the budget used to be an absolute deadline
// taken from the first batch, so every millisecond the CALLER spent walking the tree and
// reading files between batches consumed it. A literal pattern over a slow tree therefore
// failed with "simplify the pattern: nested quantifiers can backtrack" — a false failure
// with a wrong diagnosis, and one that passed on a rerun. The budget is now the SUM OF
// MEASURED BATCH DURATIONS, so:
//
//   - time that passes BETWEEN batches is free (the regression test below jumps a full
//     ten minutes per gap and still succeeds — the old implementation died on the second
//     batch);
//   - time spent INSIDE a batch is charged, so a catastrophic pattern is still stopped;
//   - the two failure kinds are reported by two different messages, and this module
//     reports only the pattern one (a large tree is grep's search budget, see
//     ./grep.tool.ts).
//
// What else is pinned:
//   - ordinary matching is unchanged: 0-based indices, ascending, one per matching
//     line, `lastIndex` reset before every line;
//   - an invalid source still throws the HOST realm's SyntaxError, so a caller sees
//     the parser's message and can `instanceof` it;
//   - `flags` is validated against the JavaScript flag letters, and `(?i)foo` — the
//     ripgrep spelling — is rejected as the JavaScript "Invalid group" it is, which is
//     why the option exists;
//   - `maxMatches` stops the in-context loop early, and `countLines` counts without
//     materializing indices;
//   - an exhausted budget is refused before any work, and the failure does not poison a
//     later search.
//
// The budget is a parameter, so every bound here is proven with a short deadline. The
// production default is pinned as a number and exercised through grep.test.ts.

import { describe, expect, it } from 'vitest';
import { HarnessError } from '../../util';
import {
    ALLOWED_MATCH_FLAGS,
    createBoundedLineMatcher,
    isPatternBudgetError,
    MAX_CONTENT_MATCH_MILLIS,
    patternBudgetError
} from './bounded-regex';

// The classic catastrophic pattern from the review, against a line it must fail on.
const EVIL_SOURCE = '(a+)+$';
const EVIL_LINE = `${'a'.repeat(31)}b`;

// Replace the monotonic clock with a scripted sequence of readings (the last value
// repeats once the list is exhausted) and hand back a restorer. `performance.now` is
// what ./bounded-regex measures with, and a batch reads it exactly TWICE — before and
// after `runInContext` — so a script of pairs says precisely which interval is charged.
// This is the only way to prove the accounting without waiting out a real budget.
const scriptClock = (values: number[]): (() => void) => {
    let index = 0;

    const original = performance.now;
    performance.now = (): number => values[Math.min(index++, values.length - 1)];

    return () => {
        performance.now = original;
    };
};

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
        // The source carries no flags by default, so a stateful matcher should be
        // impossible — this pins the defensive reset anyway: the SAME matcher object is
        // reused across files, and a `g` flag (now reachable through `flags`) would
        // otherwise skip lines.
        const matcher = createBoundedLineMatcher('a');

        expect(matcher.testLines(['a', 'a', 'a'])).toEqual([0, 1, 2]);
        expect(matcher.testLines(['a1', 'b', 'a2'])).toEqual([0, 2]);
        // Re-using the matcher after a call cannot carry state into the next one.
        expect(matcher.testLines(['b', 'a'])).toEqual([1]);
    });

    it('applies flags, and a g flag cannot change which lines match', () => {
        // `flags` exists because `(?i)foo` is a JavaScript "Invalid group": a caller
        // trained on ripgrep has no other way to ask for case-insensitive matching.
        expect(createBoundedLineMatcher('todo').testLines(['TODO one'])).toEqual([]);
        expect(createBoundedLineMatcher('todo', undefined, 'i').testLines(['TODO one'])).toEqual([0]);

        // `g` is accepted but must not shift the verdict: lastIndex is reset per line.
        expect(createBoundedLineMatcher('a', undefined, 'g').testLines(['a', 'a', 'a'])).toEqual([
            0,
            1,
            2
        ]);

        // `m` changes the meaning of ^ and $, which is the point of exposing it.
        expect(createBoundedLineMatcher('^b$', undefined, 'm').testLines(['a\nb'])).toEqual([0]);
        expect(createBoundedLineMatcher('^b$').testLines(['a\nb'])).toEqual([]);
    });

    it('rejects an unknown flag by naming the allowed set', () => {
        // `new RegExp('a', 'x')` blames "Invalid flags" without naming the argument, and
        // `(?i)` blames "Invalid group" without naming the option. Both send a caller the
        // wrong way, so the letters are validated here.
        expect(() => createBoundedLineMatcher('a', undefined, 'q')).toThrow(
            'grep flags accepts only the JavaScript flag letters "dgimsuyv" ("i" for case-insensitive is the usual one); got "q".'
        );

        // Every published letter is accepted, so the message and the set cannot drift.
        for (const flag of ALLOWED_MATCH_FLAGS) {
            expect(() => createBoundedLineMatcher('a', undefined, flag)).not.toThrow();
        }
    });

    it('surfaces an invalid source as the host realm SyntaxError', () => {
        // A SyntaxError created inside the vm context would not be an instance of
        // this realm's SyntaxError, so validation happens here first.
        expect(() => createBoundedLineMatcher('[')).toThrow(SyntaxError);
        expect(() => createBoundedLineMatcher('(a')).toThrow(/Unterminated group/);

        // The ripgrep flag spelling, and the message that tells the caller why.
        expect(() => createBoundedLineMatcher('(?i)foo')).toThrow(SyntaxError);
        expect(() => createBoundedLineMatcher('(?i)foo')).toThrow(/Invalid group/);
    });

    it('publishes a 30-second default matching budget', () => {
        // The production budget grep uses when nothing is injected. 30s is the only
        // bound on REGEX EXECUTION: generous for a legitimate deep grep, still finite
        // for a catastrophic pattern. The wall clock of a whole search is bounded
        // separately, and differently, by grep.
        expect(MAX_CONTENT_MATCH_MILLIS).toBe(30_000);
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
        expect(isPatternBudgetError(caught)).toBe(true);
        expect((caught as HarnessError).message).toBe(
            'grep pattern did not finish within its 150ms matching budget and was stopped. Only regex execution is charged against this budget, so the pattern is the problem here and not the size of the tree: simplify it — nested quantifiers such as "(a+)+" can backtrack exponentially.'
        );
    });

    it('does not blame the pattern for time that passes between batches', () => {
        // THE DEFECT-1 REGRESSION. Each pair of readings is identical (the batch itself
        // costs nothing) while the GAP between batches jumps a full ten minutes, which is
        // what a slow walk plus slow reads look like from inside the matcher. An absolute
        // deadline — the previous implementation — died on the second batch and blamed
        // the pattern; a measured budget charges nothing for the gap, so all four run.
        const restore = scriptClock([
            0, 0, // batch 1: 0ms of matching
            600_001, 600_001, // batch 2
            1_200_002, 1_200_002, // batch 3
            1_800_003, 1_800_003 // batch 4
        ]);

        try {
            const matcher = createBoundedLineMatcher('TODO', 1_000);

            expect(matcher.testLines(['TODO one'])).toEqual([0]);
            expect(matcher.testLines(['nope'])).toEqual([]);
            expect(matcher.testLines(['TODO two'])).toEqual([0]);
            expect(matcher.testLines(['TODO three'])).toEqual([0]);
            // Three hours of wall clock, none of it charged.
            expect(matcher.elapsed()).toBe(0);
        } finally {
            restore();
        }
    });

    it('charges the measured duration of each batch, and stops when the sum exceeds the budget', () => {
        // The other half of the same fix: the gap is free, but a batch is not. Each batch
        // measures 100ms here, so a 200ms budget survives two batches and refuses the
        // third — the bound is still a real bound, just an honest one.
        const restore = scriptClock([0, 100, 200, 300, 400, 500]);

        try {
            const matcher = createBoundedLineMatcher('TODO', 200);

            expect(matcher.testLines(['TODO one'])).toEqual([0]);
            expect(matcher.elapsed()).toBe(100);
            expect(matcher.testLines(['TODO two'])).toEqual([0]);
            expect(matcher.elapsed()).toBe(200);

            expect(() => matcher.testLines(['TODO three'])).toThrow(patternBudgetError(200));
        } finally {
            restore();
        }
    });

    it('charges a timed-out batch, so the bound cannot be escaped by failing repeatedly', () => {
        // The `finally` clause charges whether the batch succeeded, was cut short, or
        // failed for another reason. If a failed batch were free, a pattern that times
        // out on every file would consume nothing and a search could run forever while
        // claiming to be bounded. The clock is scripted so the charge is exact; the
        // pattern really does time out (a 40ms ceiling on a catastrophic backtrack).
        const restore = scriptClock([1_000, 1_040, 2_000, 2_040]);

        try {
            const matcher = createBoundedLineMatcher(EVIL_SOURCE, 100);

            expect(() => matcher.testLines([EVIL_LINE])).toThrow(patternBudgetError(100));
            expect(matcher.elapsed()).toBe(40);

            // The next batch is charged too, so the accumulated cost keeps climbing
            // towards the ceiling instead of resetting on every failure.
            expect(() => matcher.testLines([EVIL_LINE])).toThrow(patternBudgetError(100));
            expect(matcher.elapsed()).toBe(80);
        } finally {
            restore();
        }
    });

    it('reports elapsed matching time, which is what lets a caller separate the two causes', () => {
        // `elapsed()` is the evidence grep quotes in its search-budget note: 30s of wall
        // clock with 900ms of matching means the TREE cost the time.
        const matcher = createBoundedLineMatcher('TODO');

        expect(matcher.elapsed()).toBe(0);
        matcher.testLines(['TODO one']);
        expect(matcher.elapsed()).toBeGreaterThanOrEqual(0);
        expect(matcher.elapsed()).toBeLessThan(MAX_CONTENT_MATCH_MILLIS);
    });

    it('refuses an already exhausted budget before running anything', () => {
        // A zero budget means the deadline has passed. Node treats `timeout: 0` as
        // "no timeout", so this must be rejected here — otherwise a budget of 0
        // would be the one setting that removes the bound.
        const matcher = createBoundedLineMatcher('TODO', 0);

        expect(() => matcher.testLines(['TODO'])).toThrow(patternBudgetError(0));
    });

    it('does not poison a later search after a timeout', () => {
        // A timed-out vm context is reusable; nothing caches the failure. Proving it
        // matters because one bad file in a walk must not break the next one.
        expect(() =>
            createBoundedLineMatcher(EVIL_SOURCE, 100).testLines([EVIL_LINE])
        ).toThrow(patternBudgetError(100));

        expect(createBoundedLineMatcher('TODO', 100).testLines(['TODO here'])).toEqual([0]);
    });

    it('stops collecting at maxMatches, which is what makes a files-mode scan cheap', () => {
        // 10,000 matching lines, one index wanted. Materializing all of them used to be
        // the cost of asking "does this file match?" — and grep asks that question for
        // every file once its window is full.
        const lines = Array.from({ length: 10_000 }, (_unused, index) => `line ${index} TODO`);
        const matcher = createBoundedLineMatcher('TODO');

        expect(matcher.testLines(lines, 1)).toEqual([0]);
        expect(matcher.testLines(lines, 3)).toEqual([0, 1, 2]);
        // Asking for more than exist returns what exists, so `length >= want` cannot be
        // mistaken for "there is more".
        expect(matcher.testLines(['TODO'], 5)).toEqual([0]);
        // A non-positive limit is "no limit", not "collect nothing": the script tests the
        // limit AFTER pushing, so a raw 0 would have returned one index while claiming to
        // want none. Normalizing keeps `length >= want` (how grep proves truncation) from
        // ever being satisfied by a limit the caller did not mean.
        expect(createBoundedLineMatcher('TODO').testLines(['TODO a', 'TODO b'], 0)).toEqual([0, 1]);
        expect(createBoundedLineMatcher('TODO').testLines(['TODO a', 'TODO b'], -1)).toEqual([0, 1]);
    });

    it('counts matching lines without materializing the indices', () => {
        const lines = Array.from({ length: 5_000 }, (_unused, index) =>
            index % 2 === 0 ? `line ${index} TODO` : `line ${index}`
        );
        const matcher = createBoundedLineMatcher('TODO');

        expect(matcher.countLines(lines)).toBe(2_500);
        expect(matcher.countLines(['nope'])).toBe(0);
        expect(matcher.countLines([])).toBe(0);
        // Counting is charged to the same budget, so `count` output cannot escape the
        // bound that `content` output is under.
        expect(() => createBoundedLineMatcher(EVIL_SOURCE, 100).countLines([EVIL_LINE])).toThrow(
            patternBudgetError(100)
        );
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
