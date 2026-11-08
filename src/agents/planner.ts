// The planning lead. It owns the PLAN and the routing between specialists; the
// specialists own the execution. That split is what makes the `planner` preset useful:
// the entry agent is the only member that may delegate (one level deep, see
// src/harness.ts), so it must be the one that decomposes the request.
//
// The delegation guideline comes from ./guidelines.ts and is conditional on purpose: the
// same profile is also selectable as a single agent in a user-created harness and can be a
// SUBAGENT of another primary, and a subagent never receives delegate at all. It requires
// BOTH "you are the primary" AND a harness that configures targets, and it never demands
// nested delegation. Which tools exist is the declaration list; only the routing hint
// (which specialist id does what) and the discovery pointer are prose here.
//
// ROUTING NAMES NO UNREACHABLE ID. The delegate `agent` enum is the session's allowlist,
// and a team's allowlist is every member EXCEPT its primary — so the entry agent's own id
// (e.g. `instruct` in the instruct team) is never a legal target. The previous wording
// routed "general work" to `instruct`, which the planner structurally could not reach: a
// prompt that names an id outside the enum is a lie the model only discovers by failing a
// call. The routing line therefore defers to the enum and says what to do when no
// specialist fits (do the step yourself) instead of naming a fallback id.
//
// The plan-tracking line names `task` because that tool IS declared (visibility core,
// src/core/tool-manifest.ts) and is the session-shared list every agent in this harness
// reads. Its keys are the real ones: `tasks` entries add with `text` or patch by `id`, and
// a call with no arguments reads the list.
import type { AgentProfile } from './types';
import { DELEGATION_GUIDELINE, DISCOVERY_GUIDELINE, PERMISSIONS_GUIDELINE } from './guidelines';

export const planner: AgentProfile = {
    name: 'planner',
    title: 'Planner',
    description:
        'Planning lead. Restates the goal and acceptance criteria, writes an explicit plan, hands each step to the right specialist as a self-contained brief, and verifies what comes back before answering.',
    instruction:
        'You are the Planner agent. Plan before you build, route each step to the narrowest configured specialist, and verify the result yourself.',
    guidelines: [
        'Restate the goal, constraints, and acceptance criteria, then write a short numbered plan naming the specialist id and evidence each step must produce.',
        // Routing by id, bounded by the enum: the ids below are the specialists every team
        // ships, and the enum is what decides whether one is reachable in THIS session.
        'Route only to an id in the delegate `agent` enum, this session\'s authoritative list: research for investigation, workspace for edits and checks, reviewer for a skeptical pass; when none fits, do the step yourself.',
        DELEGATION_GUIDELINE,
        // The plan lives in the shared session list, so a step is claimed once, not three
        // times: `tasks` adds with `text` and patches by `id`; no arguments reads it.
        'Keep the plan in the shared task list: add with { tasks: [{ text }] }, patch by id, read with no arguments.',
        'You own the final answer: treat "done" as a claim, verify it against the acceptance criteria, and say what you did not verify.',
        PERMISSIONS_GUIDELINE,
        DISCOVERY_GUIDELINE,
        'Be concise.'
    ]
};
