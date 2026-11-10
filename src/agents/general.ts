// The DEFAULT agent — "General". Same toolbox as every live role, one difference that
// is a hard rule rather than a preference: it works alone.
//
// WHY IT HAS NO SUBAGENTS AT ALL (not just "prefers not to")
// ----------------------------------------------------------
// The `general` harness preset is built with `subagents: []`
// (../../server/harnesses/presets.ts). `delegate`'s registration gate is
// `activation: 'subagents'` (../../tools/runtime/delegate.tool.ts), and the runtime
// refuses the row outright when the allowlist is empty (src/harness.ts:1101-1103 —
// "No allowlist means nowhere to delegate: the tool would only fail"). So `delegate` is
// never REGISTERED here, never declared, and `toolRequest` cannot enable it either —
// discovery only surfaces searchable rows, and delegate stays core-when-registered.
// The prompt therefore states the rule the runtime already enforces, and adds the one
// thing it does not: an agent CAN still hand a step away without `delegate`, through
// `threadFork` (searchable; activation 'forks', which resolveForks enables by default —
// src/harness.ts:928-1108) or `threadSend` (core, lazily registered once the host has any
// second thread — src/harness.ts:1109-1113 + :4756). A server session DOES open
// conversations, so "the default agent works alone" needs both named: no delegate, no
// fork, no posting the step into another thread.
//
// WHY IT STILL CARRIES THE FULL DISCOVERY/WEB/PERMISSION BLOCK
// ------------------------------------------------------------
// Being alone changes WHO does the work, not WHAT the toolbox looks like: the same
// searchable catalogue, the same key-conditional `search`, the same unsandboxed host.
// A lone agent needs the discovery line MORE than a team member, because the step it
// cannot do with a declared tool it must unlock itself rather than hand over.
//
// `TOOL_CREATE_GUIDELINE` is deliberately absent: this profile is the default card and
// must stay inside the test-only prompt budget (./agents.test.ts), and
// the discovery line already tells it how to reach a missing capability. Authoring a new
// tool is the debugger's job (./debugger.ts), not the default agent's.
//
// Cross-references:
//   - ./instruct.ts  — the same role PLUS context-burning delegation; this profile is
//                      what `instruct` was before the roster split them
//   - ./planner.ts   — the Manager, which delegates EVERY step and never works alone
//   - ./guidelines.ts — the shared policy lines composed below
import type { AgentProfile } from './types';
import {
    DISCOVERY_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    WEB_SEARCH_GUIDELINE
} from './guidelines';

export const general: AgentProfile = {
    name: 'general',
    title: 'General',
    description:
        'The default general-purpose agent. It does the whole task itself, start to finish: this harness configures no subagents, so delegate is not even registered and it never splits work out.',
    instruction:
        'You are the General agent, the default. Do every step of the task yourself, in this conversation, and never hand work to another agent.',
    guidelines: [
        // The brief is the specification — the rule every other role assumes.
        'Treat the brief as the specification: do exactly what it asks, keep the scope it states, and say plainly when it is ambiguous or when a claim cannot be checked.',
        // The one rule unique to this profile: alone by contract, including the two ways a
        // lone agent could still hand work away — a forked branch, or posting the step into
        // another conversation thread the host happens to have open.
        'You work alone: no subagent exists here, so a step you cannot do is a step to unlock with toolRequest, never a step to pass on. Do not spawn a branch with threadFork, and do not hand the step to another conversation with threadSend.',
        DISCOVERY_GUIDELINE,
        WEB_SEARCH_GUIDELINE,
        // Tool results beat recall, and naming the tool is what makes the answer checkable.
        'Prefer a tool result over memory when a declared tool can answer more accurately, and name the tool you used.',
        PERMISSIONS_GUIDELINE,
        'Be concise: no preamble, no restating the question.'
    ]
};
