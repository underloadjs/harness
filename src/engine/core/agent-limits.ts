// Agent inspection (R3). These bounds are the declared contract AND the runtime
// values (the harness imports them), so the descriptions cannot advertise a
// preview/page size the implementation does not use.
//
//   - PREVIEW: how many characters of each completed answer agentManage shows;
//   - LIST_PER_AGENT: how many recent invocations per agent agentManage lists;
//   - RETENTION: how many completed invocation results the harness keeps
//     (active runs are always retained regardless of this cap);
//   - PAGE / PAGE_MAX: the default and maximum characters agentResult returns
//     per page. The page cap is deliberately a small fraction of the serialized
//     tool-result delivery bound (`MODEL_TOOL_RESULT_BUDGET_BYTES`,
//     ./result-budget.ts) even with JSON escaping, so a long result is paged
//     explicitly instead of being silently truncated by boundToolResult. The
//     number is stated HERE rather than spelled out in prose, because every
//     earlier draft of this line quoted a fixed figure ("64 KiB", then "256 KiB")
//     that drifted the moment the constant moved; the constant is the contract.
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

// issue 0032 (2026-11-26) — THE BOUND ON `toolActivity.byName`.
//
// WHAT IT BOUNDS. A stopped run's ledger row now carries a tool-activity tally
// (`../types` `HarnessToolActivity`): two counts plus a per-name breakdown. The counts are
// fixed-width, so the only unbounded axis is the list of names — one entry per DISTINCT tool
// the run called, and a tool-heavy child can touch many. This constant is that ceiling: the
// projection keeps the `TOOL_ACTIVITY_NAME_CAP` busiest names (ordered by count, name as
// tie-break) and sets `truncated: true` when the cap closed the list, so a caller is never
// left to read a full-looking list that was silently cut.
//
// WHY EIGHT. The row is bounded by `AGENT_RESULT_RETENTION` (64 rows) and this is the one
// variable-length payload on it, so the ceiling is deliberately the size of a screenful of
// names — enough to answer "which tool was it hammering" (the question 0032's fleet operator
// asks) and small enough that 64 rows times 8 names stays a rounding error next to one
// `partialContent` string. Each name is itself capped at 64 characters by the tool-name rule
// (`../harness.ts`, the name validation message), so the payload is bounded on BOTH axes by
// construction — 8 x 64 characters plus two integers — and needs no separate byte cap.
//
// SAME DISCIPLINE AS THE NUMBERS ABOVE: the `delegate`/`agentResult` descriptions name this
// bound as a LITERAL (a runtime entry may not value-import ../core — see the T13 note at the
// top of this file), and `./metadata.ownership.test.ts` pins the literal against this constant.
export const TOOL_ACTIVITY_NAME_CAP = 8;

// C0 (2026-11-27, the mid-run-report defect) — THE BOUND ON A RUN'S ANSWER-CANDIDATE LIST.
//
// WHAT IT BOUNDS. A run now keeps the list of its own SUBSTANTIVE tool-free `stop` turns — the
// turns that read like an answer but were not the run's last message (the investigator's 8,117-char
// report, followed by housekeeping and a 1,099-char cleanup note, is the incident). The ledger row
// carries that list so `agentResult` can page any of those turns by `invocationId`, and the snapshot
// persists it, so an UNBOUNDED list would be an unbounded payload on a row bounded only by
// `AGENT_RESULT_RETENTION` — the same mistake `TOOL_ACTIVITY_NAME_CAP` exists to prevent.
//
// WHY FOUR. The defect is about the report the agent wrote near the END of its run, so the ceiling
// is a window over the tail, not an inventory: the last FOUR substantive turns cover "the report,
// plus the few turns of cleanup that displaced it" with room to spare, and a run that wrote eleven
// reports is a transcript question (`threadRead`), not a ledger question. Four rows x the cap below
// is the worst case one row can add to the ledger — and see the byte argument on `toolActivity`
// beside it for the discipline: bound the list, then bound each entry.
export const AGENT_ANSWER_CANDIDATE_CAP = 4;

// The per-candidate CONTENT ceiling, in characters.
//
// WHY 32000 AND WHY IT IS ALIGNED WITH `threadRead`: `THREAD_READ_MAX_CONTENT_LIMIT`
// (../tools/runtime/threadRead.ts:129) is 32000 characters precisely because that is the largest
// single message a threadRead page can carry inside its 32 KiB text budget. The candidate cap takes
// the SAME number so the two doors agree about "one whole message": a report `threadRead` can hand
// back in one field, `agentResult` can hand back in one candidate. Anything longer is cut and says
// so with `truncated: true`, which is what keeps the ledger row's footprint finite (4 x 32000
// characters worst case per row) while a genuinely long report stays readable in full from the
// transcript at `answerMessageIndex`.
export const AGENT_ANSWER_CANDIDATE_CHARS = 32_000;

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

// The ceiling on the OPTIONAL `maxTurns` a caller may set on `delegate`: how many
// MODEL REQUESTS a delegated child may make. Stress report #7 (2026-11-14) corrected
// the gloss this comment used to carry ("model turns (tool rounds)"): the gate in
// ../harness.ts is `run.iteration >= turnLimit` checked BEFORE the increment, so the
// cap is a count of model requests and the child's ANSWER must be one of them —
// `maxTurns: N` therefore permits at most N-1 tool rounds, and `maxTurns: 1` only
// suits a child that answers without calling a tool.
// Omitting `maxTurns` leaves the harness-wide count bound (`maxIterations` in
// ../harness.ts — unarmed unless a host names one) in charge, so this ceiling only
// ever LOWERS what one child may do, never raises the session limit. The delegate
// entry inlines `64`.
export const DELEGATE_MAX_TURNS_MAX = 64;

// ---------------------------------------------------------------------------
// Provider connection failures (T6, 2026-11-16).
//
// `../core/agent.ts` is the ONE retry owner for model calls, and until T6 it had
// exactly ONE policy: one initial attempt plus `maxRetries` (default 10) with waits
// of 1 s, 2 s, 4 s ... 512 s. A REFUSED CONNECTION — the single most common reason a
// thread "runs forever", because the configured provider is simply not listening on
// the port the harness dials — went through that policy like any transient blip, so
// the user watched a spinner for 1+2+4+...+512 = 1023 s (~17.05 min) before an error
// named the endpoint. A dial that reached nobody is a CONFIGURATION condition, not a
// transient one: a minute of patience is proportionate, eight minutes of backoff is
// not, and the answer the user needs is "nothing is listening on 8800".
//
// (2026-11-17) That 1023 s figure is now HISTORY for EVERY class, not just the dead
// dial: the transient ladder's waits are capped by `RETRY_MAX_DELAY_MS` below, so the
// same exhausted ladder costs at most 1+2+4+8+16+32+60+60+60+60 = 303 s (~5.05 min) of
// pure waiting. The attempt COUNT is untouched — a host that configured `maxRetries: 10`
// still gets eleven chances — only the last four sleeps got shorter.
//
// So this class gets its own short, capped ladder: 1 initial attempt plus 2 retries,
// with waits of 250 ms and 500 ms. The waiting totals 750 ms, so the whole failure is
// bounded by 750 ms plus the three dial attempts themselves — under a second for a
// localhost refusal, and bounded by 3x the platform dial timeout for a slow name
// resolution. Then it fails TERMINALLY with a frame that names the dialled host:port.
//
// The numbers live here (the declared contract AND the runtime values, the rule the
// rest of this file follows) rather than in `../transport`, because the transport
// classifies WHAT failed and only the retry owner decides HOW OFTEN it is retried.
// ---------------------------------------------------------------------------

// Retries AFTER the initial attempt for a `provider-connection` failure.
export const PROVIDER_CONNECTION_MAX_RETRIES = 2;

// The base of that ladder's doubling waits: 250 ms, then 500 ms. Single-digit
// seconds by design — long enough to outlast a restarting provider process, short
// enough that the terminal answer arrives in seconds.
export const PROVIDER_CONNECTION_RETRY_BASE_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// The ceiling on EVERY ladder, and the timeout ladder (2026-11-17, the
// unrecoverable-timeout report).
//
// THE UNBOUNDED DOUBLING IS THE DEFECT. `retryDelayOf` used to be exactly
// `baseDelayMs * 2 ** (attempt - 1)`, with no cap and no wall clock, so an exhausted
// transient ladder slept 1 s … 512 s and waited 1023 s (~17 min) before the operator
// saw anything — the journal of run a4a6f913 shows `delayMs` climbing to 512000 and a
// 513815 ms gap between two events. A backoff that long cannot be "patience": nobody
// retries a rate limit that was already gone seventeen minutes ago, and a wedged
// gateway is not un-wedged by the seventh sleep. So every ladder now has a hard
// per-delay ceiling; the COUNT of attempts is whatever the policy says.
//
// 60 s is the ceiling for the generic transient ladder because that is the order of
// magnitude a real `Retry-After` / provider-restart wait is, and because the ladder
// still totals ~5 min for the default eleven attempts — enough to ride out a rolling
// deployment, short enough that a dead endpoint answers in a coffee break, not an
// afternoon.
//
// NO JITTER, DELIBERATELY. A jittered backoff spreads a thundering herd across many
// clients; a harness run is ONE client re-sending ONE request, and an unpredictable
// `delayMs` makes the published retry frame — and every test that pins it — a guess.
// A host that wants jitter has a `retry.baseDelayMs` it can vary per agent.
// ---------------------------------------------------------------------------

// The hard ceiling on ONE wait of the generic transient ladder, whatever the doubling
// would produce. `retry.maxRetries` and `retry.baseDelayMs` are still honoured; only
// the exponential tail is flattened.
export const RETRY_MAX_DELAY_MS = 60_000;

// ---------------------------------------------------------------------------
// The `provider-timeout` ladder (2026-11-17).
//
// A missed provider time bound used to be TERMINAL on the attempt that tripped it: one
// request, no `retry` frame, and a conversation permanently marked interrupted because
// a gateway went silent 120 s into a stream. That is the "who thread stopped without
// retry" report, and the fix is not the unbounded generic ladder — re-sending into a
// slow provider must not buy seventeen more minutes. It is its own SHORT, CAPPED ladder:
//
//   1 initial attempt + 3 retries  = 4 attempts. "At least several" from the report,
//                                    and the same 4-chance shape the connection class
//                                    already ships (1 + 2 for a dead dial, which is
//                                    cheaper because nothing is even listening).
//   2 s, 4 s, 8 s                  = 14 s of waiting in total. A wedged gateway clears
//                                    on the scale of seconds (a queue drains, a model
//                                    finishes loading), and each attempt may itself run
//                                    for minutes, so the waits stay small.
//   30 s per-delay ceiling          = the same flattening as `RETRY_MAX_DELAY_MS`,
//                                    sized lower because this ladder has fewer attempts
//                                    to spend and each attempt is already slow. It only
//                                    bites if a host widens the ladder past 4 attempts.
//   900 000 ms ladder deadline     = the wall clock over the WHOLE sequence, measured
//                                    from the first attempt, INCLUDING the time each
//                                    attempt consumed. It is sized from the shipped
//                                    defaults: four attempts at the 120 s stream bound
//                                    plus 14 s of backoff is ~494 s, so the default
//                                    configuration still gets all four tries. What it
//                                    refuses is the pathological shape — a host that
//                                    raised `HARNESS_PROVIDER_*_TIMEOUT_MS` to minutes,
//                                    or set a bound so large that each "timeout" is
//                                    itself an afternoon — where "retry several times"
//                                    would otherwise mean "hang for an hour".
//
// `retry.maxRetries` does NOT stretch this ladder (the same rule the connection class
// follows): widening the transient ladder says "my provider blips", not "give a
// provider that already missed a five-minute bound eleven chances".
// ---------------------------------------------------------------------------

// Retries AFTER the initial attempt for a `provider-timeout` failure.
export const PROVIDER_TIMEOUT_MAX_RETRIES = 3;

// The base of that ladder's doubling waits: 2 s, then 4 s, then 8 s.
export const PROVIDER_TIMEOUT_RETRY_BASE_DELAY_MS = 2_000;

// The hard ceiling on ONE wait of that ladder.
export const PROVIDER_TIMEOUT_RETRY_MAX_DELAY_MS = 30_000;

// The wall clock the whole `provider-timeout` sequence may consume, from the start of
// its first attempt. Once the NEXT wait would cross it, the ladder stops and the last
// attempt's own error is the answer.
export const PROVIDER_TIMEOUT_RETRY_DEADLINE_MS = 900_000;

// ---------------------------------------------------------------------------
// Run identity: the per-process EPOCH (T-W8, 2026-11-17).
//
// THE DEFECT this closes (F5's residual, reported at
// ../server/turn-projector.ts `route`): a run's journal identity is the runtime
// INVOCATION id — `runSequence` counted up per harness (../harness.ts:8263, `const id =
// ++runSequence` at :13659, stamped as `run.thread` at :13748/:13753/:13759). A restarted
// process starts that counter again, and a lane WORKER mints from its own counter
// (../harness.ts:8235, `reserveIdentity` only ever RAISES it at :8239), so the same
// `thread.id` names a different run after a restart. The turn projector already splits on
// the frame's identity SHAPE and on a post-terminal `start` (../server/turn-projector.ts
// `isRunBoundary`), but two runs of the same shape whose spawn `callId` is ALSO recycled
// are unseparable from the recorded lines: verified across all 160 081 lines of the live
// store's `events.jsonl`, the persisted frames carry no restart discriminator at all.
//
// THE RULE: stamp the id with the identity of the PROCESS that minted it. Two frames agree
// on a run only while they agree on the epoch; different epochs mean two runs, whatever
// their ids say. Same `thread.id`, same `callId`, different epoch ⇒ a new section.
//
// Why a PROCESS and not a harness instance: the restart is the event this must detect, and
// one process hosts one counter universe per harness — so the process is the boundary where
// ids can be recycled. It also separates a LANE WORKER from its parent process for free: a
// lane is a real `node:worker_threads` worker with its own module registry (../server/
// workers/lane-host.ts), so the lane's run ids carry the LANE's epoch, never the
// coordinator's. `snapshot()`/`restore()` deliberately do NOT carry the epoch — a restored
// replica is a NEW minting context, which is exactly the case the discriminator must catch.
//
// Format and mint follow the in-repo precedent `HARNESS_RUNTIME_EPOCH` (../server/
// api-events.ts), which now ALIASES this constant: one opaque per-process string, minted
// once at module load, shared by the REST cursors/headers and the run identity, so a frame
// and a cursor naming the same epoch name the same process. It lives HERE (a dependency-free
// leaf both the runtime and the server may value-import) rather than in the runtime file
// because ../harness.ts may not import the server tree, and it stays OPTIONAL on the wire: a
// document written before this change carries no epoch, and a reader must never require one.
// ---------------------------------------------------------------------------

// A runtime without `crypto.getRandomValues` (an old node, a stripped worker) still needs an
// epoch, so fall back to `Math.random`. Uniqueness PER PROCESS is the only requirement, and
// the process is the epoch's whole universe.
const randomEpochSuffix = (): string => {
    const randomSource = globalThis.crypto;

    if (randomSource !== undefined && typeof randomSource.getRandomValues === 'function') {
        const bytes = new Uint8Array(6);

        randomSource.getRandomValues(bytes);

        return [...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('');
    }

    return Math.random().toString(36).slice(2, 14).padEnd(12, '0');
};

/**
 * The one epoch of THIS process: minted at module load, never re-minted, and stamped onto
 * every run's thread identity (`HarnessThread.epoch`) so a restarted process can never be
 * mistaken for the run that used to hold an id. Opaque — the only legal question about it is
 * "is this the same epoch as that one?".
 */
export const HARNESS_PROCESS_EPOCH: string = `${Date.now().toString(36)}-${randomEpochSuffix()}`;
