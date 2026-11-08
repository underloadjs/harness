// The persisted tool outcome — progressive-compaction T1 (F2 of that entry).
//
// WHY THIS EXISTS
// ---------------
// A tool call's classification is computed ONCE per delivery (`src/harness.ts`
// `deliverTask`/`immediateResult`), projected onto `isError`, put on the progress event
// and on the `tool.after` hook payload — and then thrown away: the committed transcript
// entry carried only `{ role, content, toolCallId, name, attachments? }`. So after a
// restart, or inside a snapshot, a fork or a `threadRead`, the outcome is gone and the
// only remaining signal is English prose produced at the delivery site
// ("Tool \"x\" failed: …"). A policy that reads that prose is string-matching text it did
// not write, which the classification's own contract forbids
// (`HarnessToolOutcome` in ../types).
//
// THE THREE RULES, IN ONE PLACE
// -----------------------------
//   1. WRITE — `storedOutcomeEntry`: only a NON-`completed` outcome is ever stored, as the
//      spread form a message literal wants. Absent is the only spelling of "completed",
//      exactly as absent is the only spelling of "included" (core/agent.ts `withIncluded`)
//      and as the media key is omitted when a tool attached nothing. That is what keeps
//      every pre-existing transcript, snapshot fixture and branch record byte-identical
//      (T1.1).
//   2. READ — `toolOutcomeOf`: absent means `completed`. It is the only reading that keeps
//      every existing fixture valid, and it is a DELIBERATE migration decision rather than
//      a bridge: nothing string-matches the failure prose to reconstruct an outcome for a
//      pre-outcome transcript (T1.5). A consequence a policy must respect: such a
//      transcript, and a branch pending placeholder, both read as `completed`, which is
//      why the pruning rule requires a SUPERSEDING later success and never touches a unit
//      with no committed result (docs/tasks/2026-11-09-progressive-compaction.md T0 Q3).
//   3. DERIVE — `isErrorOutcome` (from a classification) and `toolResultIsError` (from a
//      committed entry). `isError` is never stored alongside the outcome: the two can
//      disagree only if they are kept twice (../types `HarnessToolOutcome` says they can
//      never), so these are the single projections from one to the other.
//
// `isToolOutcome`/`TOOL_OUTCOMES` are the validation half of the same contract, used by the
// two untrusted-input readers below so a mistyped value is REFUSED rather than read as
// "completed" and hide a failure.
//
// WHAT IS NOT DECIDED HERE: which unit may be pruned, and when. That is the policy
// (T3/T4 of the same entry), and it consumes these helpers rather than re-deriving anything
// from message text.
//
// Cross-references:
//   - ../types/index.ts            HarnessToolOutcome (the union) and the `tool` message variant
//   - ./agent.ts                   copyBaselineMessage — a fork carries the key (never re-decides it)
//   - ./snapshot.ts                applyOutcome — the persisted allowlist + the read rule
//   - ./branch.ts                  copyOutcome — the same rule for branch materialization
//   - ../harness.ts                insertToolMessage — the one canonical writer

import type { HarnessToolOutcome } from '../types';

// Every value the union admits, in the order the refusal messages list them. One table so
// a validation message and the type cannot drift apart.
export const TOOL_OUTCOMES: readonly HarnessToolOutcome[] = [
    'completed',
    'failed',
    'rejected',
    'cancelled'
];

// Narrow an untrusted value (a restored document, a branch record, a transcript PUT) to
// the union. Callers REFUSE what this rejects rather than coercing: a mistyped outcome
// must not silently read as "completed" and hide a failure.
export const isToolOutcome = (value: unknown): value is HarnessToolOutcome =>
    typeof value === 'string' && (TOOL_OUTCOMES as readonly string[]).includes(value);

// Rule 1 — the storage form, in the spread form a message literal wants:
//     { role: 'tool', …, …storedOutcomeEntry(outcome) }
// `completed`, and "nothing was classified", both map to NO KEY, so a completed result is
// byte-identical to what the runtime wrote before this field existed (T1.1). Every writer
// uses this one helper — src/harness.ts (the canonical transcript), core/agent.ts (a fork
// baseline) — so the omission decision cannot be spelled three ways. The caller passes the
// outcome its delivery computed; nothing here re-reads the result text to decide.
export const storedOutcomeEntry = (
    outcome: HarnessToolOutcome | undefined
): { outcome: HarnessToolOutcome } | Record<string, never> =>
    // `completed` and `undefined` are the two spellings of "healthy"; anything else is the
    // value itself, verbatim (never re-decided, so a caller cannot quietly promote one).
    outcome === undefined || outcome === 'completed'
        ? {}
        : { outcome };

// Rule 2 — the read form. Absent (a pre-outcome transcript, a completed result, or a
// placeholder that was never a delivery) answers `completed`. Two placeholder families share
// that spelling and neither is a classification: a branch's request-only pending entry
// (./branch.ts `flushPending`), and the interrupted-call repair a server commits when a
// process died mid-call ("no result was committed", ../server/persistence.ts
// `INTERRUPTED_TOOL_RESULT_TEXT`). Both read healthy, which a policy must be able to live
// with — see the header's rule-2 note and T0 Q3 of the task entry.
export const toolOutcomeOf = (message: {
    outcome?: HarnessToolOutcome;
}): HarnessToolOutcome => message.outcome ?? 'completed';

// Rule 3 — the derived boolean, from either shape: the classification the delivery
// computed, or the committed entry it was written onto. `isError` is never stored beside
// the outcome, so this is the only projection from one to the other.
export const isErrorOutcome = (outcome: HarnessToolOutcome): boolean => outcome !== 'completed';

export const toolResultIsError = (message: { outcome?: HarnessToolOutcome }): boolean =>
    isErrorOutcome(toolOutcomeOf(message));
