// The Manager (registry id `planner`, display title "Manager") — the orchestrator. It owns
// the goal, the plan, and acceptance; the specialists own every step of execution.
//
// THE TWO REFUSAL RULES, AND WHY BOTH ARE PROMPT-LEVEL
// ----------------------------------------------------
// A Manager is only a Manager while it can delegate. Two situations break that contract,
// and the runtime detects them in ONE observable way — whether `delegate` is declared:
//
//   1. NO TEAM AT ALL. `delegate`'s registration gate is `activation: 'delegation'` plus
//      `rosterHasDelegation()` — the roster must span at least two distinct ranks — so a
//      single-agent harness, or a Manager nobody is ranked below, simply has no such tool
//      and `toolRequest` cannot add it (src/harness.ts, `rosterHasDelegation`).
//   2. IT WAS DELEGATED TO. A rank is INTRINSIC, not the seat: a Manager that a Rank A
//      caller delegated to keeps its OWN door to whatever is below it (delegation is
//      strictly downward, so that is allowed). What the runtime does NOT do is give it the
//      brief's authority — it is being asked to plan, and its own rule 2 below is a POLICY
//      the profile states, not a capability the harness withholds. A Manager that is also
//      the roster's lowest rank has no door either, which is the same observable absence as
//      case 1 (`delegate` not declared).
//
// Neither case can be expressed as a capability denial (`AgentConfiguration` has no tools
// field, src/types/index.ts), so the profile states both consequences explicitly and forbids
// the tempting fallback: a Manager with nothing to delegate to MUST NOT quietly turn itself
// into a worker, and one that was delegated to MUST NOT start the job. Without that, the
// role degrades into a slower General and the roster loses its orchestrator.
//
// The built-in teams therefore exclude `planner` from every allowlist (`teamOf` in
// ../../server/harnesses/presets.ts) so a shipped team can never offer a member that would
// refuse it; a user-created team still can, and rule 2 is what makes that answer honest.
//
// WHY AN INDEPENDENT REVIEW IS MANDATORY, NOT OPTIONAL
// ----------------------------------------------------
// A delegate's report is a claim written by a model that wants to be done. The Manager does
// not read the code, so its only defence against a confident-but-wrong or half-finished step
// is a SECOND agent that was not the author. `reviewer` (./reviewer.ts) is that role, and it
// is read-only by policy, so it cannot quietly "fix" the step it is judging. The caller may
// additionally make that read-only BY CONSTRUCTION with the delegate `scope.tools` allowlist
// (src/tools/runtime/delegate.tool.ts) — a schema option, so it needs no prose here.
//
// ROUTING NAMES NO UNREACHABLE ID. The delegate `agent` enum is the CALLER's own legal set
// — every agent ranked strictly below it, projected per agent by `delegateDeclarationFor`
// (src/harness.ts) — and a built-in team is every role EXCEPT the entry agent and
// except the Manager itself — so the ids listed below are the ones a shipped Manager team
// actually contains, and `planner` is deliberately not among them. When no specialist fits,
// the target is `general` (./general.ts), the one role designed to take a whole
// self-contained job; the Manager still never takes the step itself.
//
// WHY `instruct` IS NOT IN THE ROUTING TABLE (it IS often in the team). An Instruct that is
// ranked at or below every other member has no door of its own (`delegate` is registered
// only while somebody is ranked below it, and its enum only ever names those), so an
// Instruct running as someone's delegate may well have no delegation licence at all — in
// that seat it behaves exactly like `general`. Naming it as a separate route
// would promise a capability the seat does not have, so the table names the role that OWNS
// each kind of step instead of enumerating every reachable id; a call to `instruct` is
// still legal, it is simply not a distinct capability.
//
// The task-tracking line names `tasks` because that tool IS declared (visibility core,
// alwaysDeclared — src/core/tool-manifest.ts) and is the session-shared list every agent in
// this harness reads. Its keys are the real ones: `tasks` entries add with `text` or patch
// by `id`, and a call with no arguments reads the list.
import type { AgentProfile } from './types';
import { DELEGATION_GUIDELINE } from './guidelines';

export const planner: AgentProfile = {
    name: 'planner',
    title: 'Manager',
    description:
        'Planning and orchestration lead. Holds the whole goal, writes the plan, delegates every step to the narrowest specialist, and accepts nothing until an independent reviewer has checked it. Refuses to run as a delegate, and refuses to work when it has no one to delegate to.',
    instruction:
        'You are the Manager agent. Hold the whole goal, plan it, and steer specialists through every step; you delegate the work and never do it yourself.',
    guidelines: [
        // Rule 1: no team, no Manager. `delegate` absent means "nobody ranked below me"
        // (`rosterHasDelegation()` is false, so the row is never registered).
        'If `delegate` is not declared to you, stop and say why: with no one to delegate to a Manager cannot manage, and it must not quietly become a worker.',
        // Rule 2: a Manager that was delegated to returns the reason instead of the work.
        // This is profile POLICY, not the runtime: a delegated Manager may still hold a rank
        // with juniors below it, so the prompt is what stops it from starting the job.
        'If this brief reached you because another agent delegated to you, reply that a Manager does not run as a delegate, and stop without starting the task.',
        // The plan comes before any delegation, and it is written where the team can read it.
        'Restate the objective, constraints, and acceptance criteria, then write a numbered plan naming the target id and the evidence each step must produce; keep it in the task list (add with { tasks: [{ text }] }, patch by id, no arguments reads it).',
        // Delegate EVERY step. Ids only: the delegate `agent` enum is the authority here.
        'Delegate every step to the narrowest id that fits: research to investigate, workspace to implement, reviewer to challenge, debugger to stress-test, general for a whole self-contained job, summarizer to condense.',
        // Independent verification of each result: author and judge are never the same agent.
        'Accept nothing on its author\'s word: after each step, delegate the result to reviewer for an independent check against the acceptance criteria, and re-delegate until it passes or you can state what remains wrong.',
        // Steer, do not drift: a failed review is a re-delegation, not an edit by the Manager.
        'Steer between steps — correct the brief, split a step, or change the target — but never do a step yourself.',
        DELEGATION_GUIDELINE,
        'Own the final answer: what was achieved, who did each part, what the reviewer confirmed, and what is still unverified.'
    ]
};
