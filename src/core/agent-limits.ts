// Agent inspection (R3). These bounds are the declared contract AND the runtime
// values (the harness imports them), so the descriptions cannot advertise a
// preview/page size the implementation does not use.
//
//   - PREVIEW: how many characters of each completed answer agentManage shows;
//   - LIST_PER_AGENT: how many recent invocations per agent agentManage lists;
//   - RETENTION: how many completed invocation results the harness keeps
//     (active runs are always retained regardless of this cap);
//   - PAGE / PAGE_MAX: the default and maximum characters agentResult returns
//     per page. The page cap is deliberately far below the 64 KiB serialized
//     tool-result bound even with JSON escaping, so a long result is paged
//     explicitly instead of being silently truncated by boundToolResult.
//
// T13 note: agentManage.tool.ts / agentResult.tool.ts write these same numbers as
// LITERALS inside their schemas. A runtime entry must keep zero captured local
// dependencies and must not value-import ../core (that closes a cycle through
// ./metadata.ts), so it cannot import this leaf. core/metadata.ownership.test.ts
// asserts the literals equal these constants — change both together.
export const AGENT_MANAGE_PREVIEW_CHARS = 200;

export const AGENT_MANAGE_LIST_PER_AGENT = 5;

export const AGENT_RESULT_RETENTION = 64;

export const AGENT_RESULT_PAGE_CHARS = 4000;

export const AGENT_RESULT_PAGE_MAX_CHARS = 8000;

// T28 (ORIGINAL wording, kept auditable): "the wall-clock bound a delegation applies
// to its CHILD when the caller does not pass `timeoutMs`. Before this, a child that
// ran `sleep 600` sat `running` indefinitely and the only recovery was `toolCancel`
// — which then destroyed the transcript. Five minutes is long enough for a real
// research or edit run and short enough that a frozen child cannot hold a session
// open forever." The finite default it describes was `300_000`.
//
// CORRECTED 2026-11-09 (docs/tasks/2026-11-09-thread-timeout-policy.md, R1/R2/R5):
// the DEFAULT is now "no limit". A delegated thread runs to its own final answer and
// nothing external ends it on a clock; `timeoutMs` survives as an OPTIONAL,
// caller-set bound, so this constant is what "the caller set nothing" resolves to.
// The name and its re-exports are kept on purpose — one readable fact ("the default
// is infinity") rather than an absent fallback — and `delegateFor` arms its timer
// only when the resolved value is finite.
//
// What still bounds a run, so dropping the finite default did not open a hole:
//   - every TOOL keeps its own wall-clock bound (shell, grep, webfetch, …) — the
//     primary defence, and the reason an unbounded thread cannot hang forever on I/O;
//   - `maxIterations` (an OPTIONAL COUNT bound, `DEFAULT_MAX_ITERATIONS` in ../harness.ts —
//     no limit unless a host names one) ends
//     a run that keeps requesting, abandoning pending work;
//   - a `turn.before` plugin's `stop` decision (`HarnessTurnDecision`) ends the run
//     through its own abort path — a policy assertion at a turn boundary, not a clock;
//   - the liveness wake (`DEFAULT_WAKE_INTERVAL_MS`, the `async-ping` plugin) plus an
//     explicit `toolCancel` are how a stuck child is abandoned;
//   - the depth and size bounds (`MAX_RUN_DEPTH`, record caps) are untouched.
//
// The delegate entry inlines the ceiling it advertises to the model as a LITERAL (a
// runtime entry must keep zero captured local dependencies), so
// core/metadata.ownership.test.ts pins both this value and that literal — the pin is
// what keeps the prose and the runtime on the same number.
export const DELEGATE_TIMEOUT_MS = Number.POSITIVE_INFINITY;
