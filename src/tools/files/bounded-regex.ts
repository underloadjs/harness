// @underload/harness tools/files/bounded-regex — a content matcher that cannot hang.
//
// WHY THIS EXISTS (T16)
// ---------------------
// fileGlob's content mode takes a JavaScript regular-expression SOURCE from the
// caller and runs it against every line of every matching file. JavaScript regexes
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
// SEMANTICS (unchanged from the previous in-realm matcher)
// -------------------------------------------------------
//   - the source is compiled with `new RegExp(source)` — no flags;
//   - every line is tested with `lastIndex = 0` first, so a stateful pattern
//     cannot skip lines;
//   - results are 0-based line indices, in ascending order, one per matching line.
// An invalid source is compiled in the MAIN realm first, so the caller still gets
// the parser's own `SyntaxError` (a sandbox-realm SyntaxError would not be an
// instance of the host's SyntaxError).
//
// BUDGET
// ------
// Matching is cumulative across the whole search: the deadline starts at the first
// match and every file's batch gets the remaining time. Exceeding it throws a clear
// HarnessError naming the budget and the usual cause (nested quantifiers), instead of
// returning a partial, silently wrong answer. Walking the tree to find candidates is
// deliberately NOT part of the budget: a slow walk is not an expensive pattern.
//
// Cross-references:
//   - ./fileGlob — content mode, the only caller
//   - ../catalogue — the model-facing description of the same limit

import { createContext, Script } from 'node:vm';
import { HarnessError } from '../../util';

// Total matching time one content search may spend, in milliseconds. A generous
// 30s ceiling keeps a legitimate grep of a very large tree from failing (100,000
// lines of ordinary text take ~50ms) while a catastrophic pattern is still stopped
// before it can look like a hang. This is the ONLY time bound on content matching:
// there is deliberately no second, overall request timeout.
export const MAX_CONTENT_MATCH_MILLIS = 30_000;

// The body of the in-context loop. Compiled ONCE at module load; `source` and
// `lines` are read from the context on every run, so there is no per-line or
// per-file parse cost.
const MATCH_SCRIPT = new Script(`(function () {
    var matcher = new RegExp(source);
    var matched = [];
    for (var index = 0; index < lines.length; index++) {
        matcher.lastIndex = 0;
        if (matcher.test(lines[index])) matched.push(index);
    }
    return matched;
})()`);

// A line matcher bound to one pattern and one cumulative deadline.
export type BoundedLineMatcher = {
    // 0-based indices of the matching lines, ascending.
    testLines: (lines: readonly string[]) => number[];
};

// The error a caller sees when the pattern ran out of budget. Exported so a test
// can assert the exact message without duplicating it.
export const budgetError = (budgetMs: number): HarnessError =>
    new HarnessError(
        `fileGlob content pattern did not finish within its ${budgetMs}ms matching budget and was stopped. Simplify the pattern: nested quantifiers such as "(a+)+" can backtrack exponentially.`
    );

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

// Build the matcher for one content search.
//
// `budgetMs` is a parameter rather than a constant so a test can prove the bound
// with a short deadline instead of waiting out the production budget.
export const createBoundedLineMatcher = (
    source: string,
    budgetMs: number = MAX_CONTENT_MATCH_MILLIS
): BoundedLineMatcher => {
    // Compile in the host realm purely to validate: this is what keeps an invalid
    // pattern a host-realm SyntaxError with the parser's own message. The compiled
    // object is discarded — the sandbox compiles its own copy.
    new RegExp(source);

    const context = createContext({ source, lines: [] as readonly string[] });

    // The deadline starts on the FIRST match, not when the matcher is built: walking
    // a large tree to find candidate files is not part of the matching budget, and
    // charging it would turn a slow walk into a misleading "pattern too expensive".
    let deadline: number | undefined;

    return {
        testLines: (lines) => {
            if (deadline === undefined) deadline = Date.now() + budgetMs;

            const remaining = deadline - Date.now();

            // A timeout of 0 means "no timeout" to Node, so an exhausted budget must
            // be refused here rather than handed over as `{ timeout: 0 }`.
            if (remaining <= 0) throw budgetError(budgetMs);

            context.lines = lines;

            try {
                return MATCH_SCRIPT.runInContext(context, {
                    // Ceil so a fractional millisecond is never truncated to 0.
                    timeout: Math.ceil(remaining)
                }) as number[];
            } catch (error) {
                // The pattern itself backtracked past the deadline: report the
                // budget, not V8's generic timeout text.
                if (isTimeoutError(error)) throw budgetError(budgetMs);

                // Anything else (a huge line set exhausting memory, a broken realm)
                // is not ours to reinterpret.
                throw error;
            }
        }
    };
};
