// @underload/harness tools/files/bounded-regex — a content matcher that cannot hang.
//
// WHY THIS EXISTS (T16)
// ---------------------
// grep takes a JavaScript regular-expression SOURCE from the caller and runs it
// against every line of every matching file. JavaScript regexes
// backtrack, so a pattern like `(a+)+$` against a 31-byte line blocks the whole
// process for ~8 seconds — and worse patterns are effectively unbounded. A tool
// call must never be able to freeze the harness, so the matching itself is run
// inside `node:vm` with a real timeout.
//
// WHY node:vm (and what it does and does not buy)
// -----------------------------------------------
// V8 checks an interrupt flag during regex execution, so `runInContext(..., {
// timeout })` genuinely aborts a catastrophic backtrack and throws
// ERR_SCRIPT_EXECUTION_TIMEOUT. This is a TIMEOUT, not a sandbox: the script only
// sees the source string and the line array, but vm is not a security boundary and
// is not used as one here. It is the only way to bound a regex with Node built-ins
// and no dependency.
//
// COST (why lines are batched)
// ----------------------------
// Crossing the realm boundary costs ~0.4ms per call, which would be 8s for a
// 20,000-line file if it were done per line. Instead ONE precompiled `vm.Script`
// loops over a whole file's lines inside the context, so the per-line cost is the
// same as `RegExp.prototype.test` in the main realm (20,000 lines ≈ 18ms) and the
// boundary is crossed once per file. The context is created once per content
// search, not per line and not per file.
//
// SEMANTICS
// ---------
//   - the source is compiled with `new RegExp(source, flags)`; `flags` is a caller
//     option (grep exposes it) and defaults to "" — no flags, as before;
//   - every line is tested with `lastIndex = 0` first, so a stateful pattern
//     cannot skip lines and a `g` flag cannot change which lines match;
//   - `testLines` returns 0-based line indices, ascending, one per matching line;
//   - `countLines` returns how many lines match, without materializing the indices
//     (grep's `count` output needs the number, not the list).
// An invalid source is compiled in the MAIN realm first, so the caller still gets
// the parser's own `SyntaxError` (a sandbox-realm SyntaxError would not be an
// instance of the host's SyntaxError).
//
// `maxMatches` (why the loop can stop early)
// ------------------------------------------
// A file with 10,000 matching lines used to materialize all 10,000 indices even
// when the caller's cap was already full — the array was then discarded one entry
// at a time. The caller now says how many indices it can still use and the loop
// stops there. A name survey (`output: 'files'`) passes 1, so the first matching
// line ends the file's work: that is the difference between scanning every line of
// every file and answering "does this file contain it?".
//
// BUDGET (the part that was wrong before)
// ---------------------------------------
// The budget is a MATCHING budget, and it is charged only for matching. The earlier
// implementation set an absolute deadline at the first batch and handed the
// remaining time to every later one, so wall-clock time spent walking the tree and
// reading files between batches consumed it. The consequence was a false failure
// with a wrong diagnosis: a literal that cannot backtrack was reported as "the
// pattern did not finish, simplify it", because the 30s had gone into I/O.
//
// What is charged now is the sum of the durations `runInContext` actually took
// (`elapsed()`), so:
//   - a slow filesystem or a huge tree cannot exhaust a cheap pattern's budget;
//   - a catastrophic pattern still stops inside the budget however fast the I/O is;
//   - each batch gets `budget - spent` as its own timeout, so total matching time
//     stays bounded by `budgetMs` exactly as before.
//
// Two DIFFERENT failures, two DIFFERENT messages. This module reports only
// "the pattern is too expensive" (`patternBudgetError`), because only matching time
// can charge this budget. A search that is merely LARGE — too much I/O — is bounded
// by grep's own wall-clock search budget (./grep.tool.ts `MAX_SEARCH_MILLIS`) and
// comes back as a PARTIAL RESULT naming that reason, not as an error about the
// pattern.
//
// Concurrency note: grep overlaps its file READS (./search.ts `mapConcurrent`) but a
// matcher call is synchronous from `context.lines = lines` through `runInContext`, so
// two in-flight files can never interleave inside the sandbox or corrupt `spent`.
//
// Cross-references:
//   - ./grep.tool.ts — the only caller
//   - ../catalogue — the model-facing description of the same limit

import { createContext, Script } from 'node:vm';
import { HarnessError } from '../../util';

// Total MATCHING time one content search may spend, in milliseconds. A generous
// 30s ceiling keeps a legitimate grep of a very large tree from failing (100,000
// lines of ordinary text take ~50ms) while a catastrophic pattern is still stopped
// before it can look like a hang. This is the ONLY bound on regex execution; the
// walk and the reads are bounded separately, by grep's own search budget.
export const MAX_CONTENT_MATCH_MILLIS = 30_000;

// Flags a caller may ask for. They are the JavaScript flag letters, and the set is
// closed on purpose: an unknown letter would reach `new RegExp` and throw a bare V8
// message about a flag, which names neither the argument nor what is allowed. `g`
// is accepted but cannot change which lines match, because `lastIndex` is reset
// before every line.
export const ALLOWED_MATCH_FLAGS = 'dgimsuyv';

// The body of the in-context match loop. Compiled ONCE at module load; `source`, `flags`,
// `lines` and `stopAt` are read from the context on every run, so there is no per-line or
// per-file parse cost. `stopAt` is the caller's `maxMatches` translated into the script's
// own sentinel (-1 means "no limit"), which keeps a `0` — "stop after the first match" —
// distinguishable from "no limit" without a second variable.
const MATCH_SCRIPT = new Script(`(function () {
    var matcher = new RegExp(source, flags);
    var matched = [];
    for (var index = 0; index < lines.length; index++) {
        matcher.lastIndex = 0;
        if (matcher.test(lines[index])) {
            matched.push(index);
            if (stopAt >= 0 && matched.length >= stopAt) break;
        }
    }
    return matched;
})()`);

// The same loop, counting instead of collecting. `count` output asks "how many lines
// match?", and materializing 100,000 indices to sum them is pure allocation.
const COUNT_SCRIPT = new Script(`(function () {
    var matcher = new RegExp(source, flags);
    var count = 0;
    for (var index = 0; index < lines.length; index++) {
        matcher.lastIndex = 0;
        if (matcher.test(lines[index])) count++;
    }
    return count;
})()`);

// A line matcher bound to one pattern, one flag set, and one cumulative MATCHING
// budget (matching time only — never I/O).
export type BoundedLineMatcher = {
    // 0-based indices of the matching lines, ascending. At most `maxMatches` of them,
    // and then only a PREFIX of the file's matches — the caller decides what that
    // means for its own result (grep never needs more than its remaining window).
    // A missing or non-positive `maxMatches` means "no limit".
    testLines: (lines: readonly string[], maxMatches?: number) => number[];
    // How many lines match, scanning the whole array.
    countLines: (lines: readonly string[]) => number;
    // Matching time actually consumed so far, in milliseconds. Exposed so the caller
    // can tell "this pattern is expensive" from "this tree is big", and so a partial
    // answer can name the bound it hit.
    elapsed: () => number;
};

// The error a caller sees when PATTERN EXECUTION ran out of budget. Exported so a
// test can assert the exact message without duplicating it. The message can afford to
// blame the pattern, because under measured accounting only regex execution charges
// this budget.
export const patternBudgetError = (budgetMs: number): HarnessError =>
    new HarnessError(
        `grep pattern did not finish within its ${budgetMs}ms matching budget and was stopped. Only regex execution is charged against this budget, so the pattern is the problem here and not the size of the tree: simplify it — nested quantifiers such as "(a+)+" can backtrack exponentially.`
    );

// Whether an unknown error IS that failure. Exported so the caller can add the one
// piece of context this module cannot know — which file it was working on — without
// matching on a message string it does not own.
export const isPatternBudgetError = (error: unknown): boolean =>
    error instanceof HarnessError && error.message.startsWith('grep pattern did not finish within its ');

// V8 reports the timeout through a stable code; the message is also checked because
// a future Node may change which of the two it sets.
const isTimeoutError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;

    const candidate = error as { code?: unknown; message?: unknown };

    return (
        candidate.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
        (typeof candidate.message === 'string' && candidate.message.includes('Script execution timed out'))
    );
};

// Monotonic milliseconds. `performance.now()` rather than `Date.now()`: batches are
// sub-millisecond, and a wall clock that steps backwards (an NTP correction) would
// otherwise hand the accumulator a negative duration.
const now = (): number =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

// Build the matcher for one content search.
//
// `budgetMs` is a parameter rather than a constant so a test can prove the bound
// with a short deadline instead of waiting out the production budget.
export const createBoundedLineMatcher = (
    source: string,
    budgetMs: number = MAX_CONTENT_MATCH_MILLIS,
    flags = ''
): BoundedLineMatcher => {
    // Validate the flag set BEFORE compiling: `new RegExp('a', 'x')` throws a V8
    // message about an invalid flag that names neither the argument nor the allowed
    // letters — and `(?i)foo`, the ripgrep spelling a caller reaches for first, is a
    // JavaScript "Invalid group".
    for (const flag of flags) {
        if (!ALLOWED_MATCH_FLAGS.includes(flag)) {
            throw new HarnessError(
                `grep flags accepts only the JavaScript flag letters "${ALLOWED_MATCH_FLAGS}" ("i" for case-insensitive is the usual one); got "${flag}".`
            );
        }
    }

    // Compile in the host realm purely to validate: this is what keeps an invalid
    // pattern a host-realm SyntaxError with the parser's own message. The compiled
    // object is discarded — the sandbox compiles its own copy.
    new RegExp(source, flags);

    const context = createContext({
        source,
        flags,
        lines: [] as readonly string[],
        stopAt: -1
    });

    // Cumulative MATCHING time, in milliseconds. Deliberately not a deadline: the
    // time between batches (walking, reading) must not be charged here, or a big tree
    // would be reported as an expensive pattern.
    let spent = 0;

    // One batch, one charge. `script` differs between the two verdicts; everything
    // about the budget is shared, so `countLines` cannot escape the bound.
    const run = (script: Script, lines: readonly string[], maxMatches?: number): number[] | number => {
        const remaining = budgetMs - spent;

        // A timeout of 0 means "no timeout" to Node, so an exhausted budget must be
        // refused here rather than handed over as `{ timeout: 0 }`.
        if (remaining <= 0) throw patternBudgetError(budgetMs);

        context.lines = lines;
        // The contract is "at most `maxMatches` indices", and only a POSITIVE number is
        // meaningful: the script pushes before it tests the limit, so a 0 would collect
        // one index and stop — the same as 1 — while a negative would mean "no limit".
        // Every caller passes `skip + window + 1` (always >= 1) or 1, so this normalizes a
        // degenerate request rather than changing a real one, and it keeps the sentinel
        // (-1 = no limit) from being reachable by accident.
        context.stopAt = typeof maxMatches === 'number' && maxMatches > 0 ? maxMatches : -1;

        const startedAt = now();

        try {
            return script.runInContext(context, {
                // Ceil so a fractional millisecond is never truncated to 0.
                timeout: Math.ceil(remaining)
            }) as number[] | number;
        } catch (error) {
            // The pattern itself backtracked past the deadline: report the budget,
            // not V8's generic timeout text.
            if (isTimeoutError(error)) throw patternBudgetError(budgetMs);

            // Anything else (a huge line set exhausting memory, a broken realm) is
            // not ours to reinterpret.
            throw error;
        } finally {
            // Charged whether the batch succeeded, was cut short by the timeout, or
            // failed for another reason: each of them consumed matching time, and a
            // failing batch must not be free or the bound would be escapable by
            // repeating it.
            spent += now() - startedAt;
        }
    };

    return {
        testLines: (lines, maxMatches) => run(MATCH_SCRIPT, lines, maxMatches) as number[],
        countLines: (lines) => run(COUNT_SCRIPT, lines) as number,
        elapsed: () => spent
    };
};
