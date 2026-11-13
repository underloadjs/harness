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

// ---------------------------------------------------------------------------
// Run bounds a MODEL may set (2026-11-13, findings B5/C1 + the fork-timeout half
// of the 2026-11-09 time policy applied to `threadFork`).
//
// Same pattern as everything above: these are the canonical numbers behind the
// prose, and the entries RESTATE them as literals because a runtime entry keeps
// zero captured local dependencies and must not value-import ../core (that closes
// a cycle through ./metadata.ts). The pin step keeps the two equal.
// ---------------------------------------------------------------------------

// The ONE ceiling every model-settable wall-clock bound shares: `delegate`'s
// `timeoutMs` and `threadFork`'s `timeoutMs` both accept 1..3600000 ms (one hour).
// It bounds what a MODEL may ask for only — the host paths (`runtime.delegate`,
// harness config) are not schema-validated and may pass any finite bound, and the
// ABSENCE of a bound is `DELEGATE_TIMEOUT_MS` / `FORK_TIMEOUT_MS` above, not this
// number. The entries inline `3600000`; a pin must assert equality with this
// constant so the two ceilings cannot drift apart when one entry is retuned.
export const MODEL_TIMEOUT_MAX_MS = 3600000;

// What `threadFork` resolves to when the caller omits `timeoutMs`. "No limit" is
// spelled as one readable fact (the same choice `DELEGATE_TIMEOUT_MS` made), and the
// fork timer is armed only when the resolved value is finite. A branch that runs
// unbounded still ends on its own answer, and every tool it calls keeps its own
// wall clock, so dropping the bound does not open a hang.
export const FORK_TIMEOUT_MS = Number.POSITIVE_INFINITY;

// The ceiling on the OPTIONAL `maxTurns` a caller may set on `delegate`: the number
// of model turns (tool rounds) a delegated child may take before it has to answer.
// Omitting `maxTurns` leaves the harness-wide count bound (`maxIterations` in
// ../harness.ts — unarmed unless a host names one) in charge, so this ceiling only
// ever LOWERS what one child may do, never raises the session limit. The delegate
// entry inlines `64`.
export const DELEGATE_MAX_TURNS_MAX = 64;
