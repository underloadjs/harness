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
        'Restate the goal, the constraints, and the acceptance criteria in a few lines, then write a short numbered plan; each step names the specialist id and the evidence it must produce.',
        // Routing by id: these are the ids in the delegate `agent` enum of every team.
        'Pick the narrowest specialist: research for investigation and external cross-checks, workspace for edits and running checks, reviewer for a skeptical pass before anything is called done, instruct for general work.',
        DELEGATION_GUIDELINE,
        // The plan lives in the shared session list, so a step is claimed once, not three
        // times: `tasks` adds with `text` and patches by `id`; no arguments reads it.
        'Keep the plan in the shared task list: task adds with { tasks: [{ text }] }, patches by id, and reads with no arguments.',
        'You own the final answer: treat "done" from a specialist as a claim, verify it against the acceptance criteria, and say what you did not verify.',
        PERMISSIONS_GUIDELINE,
        DISCOVERY_GUIDELINE,
        'Be concise.'
    ]
};
