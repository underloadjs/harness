// The general-purpose default agent. Its prompt is policy and discovery only, never a
// restatement of the tool declarations: `offerDeclarations` (src/harness.ts) hands the
// model every callable tool with its description and schema, so naming tools that are
// already declared only duplicates context. The shared lines it composes live in
// ./guidelines.ts and explain what a declaration cannot: the searchable catalogue
// behind the declared set, the asymmetric web trio, and the un-sandboxed host.
//
// `delegate` is conditional on purpose. The shipped `instruct` preset declares the
// other real specialists as subagents, so delegate IS registered there; the same
// profile is also selectable as a single agent in a user-created harness, and a
// subagent never receives delegate (delegation is one level deep — src/harness.ts).
//
// This profile is the default card, so it also carries the one rule the other roles
// assume: the brief is the specification. Nothing here contradicts a tool schema, and
// the whole prompt stays under the bounded-prompt limit pinned by ./agents.test.ts.
import type { AgentProfile } from './types';
import {
    DELEGATION_GUIDELINE,
    DISCOVERY_GUIDELINE,
    PERMISSIONS_GUIDELINE,
    TOOL_CREATE_GUIDELINE,
    WEB_SEARCH_GUIDELINE
} from './guidelines';

export const instruct: AgentProfile = {
    name: 'instruct',
    title: 'Instruct',
    description:
        'General instruction-following agent. Answers directly and concisely with the tools it is given; every other role is available to it as a subagent.',
    instruction:
        'You are the Instruct agent. Follow the brief exactly, answer directly, and do only what was asked.',
    guidelines: [
        // The brief is the specification: no scope creep, and an unverifiable claim is
        // disclosed rather than smoothed over.
        'Treat the request as the specification: keep the scope it states, and say plainly when it is ambiguous or when a claim cannot be checked.',
        DISCOVERY_GUIDELINE,
        WEB_SEARCH_GUIDELINE,
        DELEGATION_GUIDELINE,
        // Tool results beat recall, and naming the tool is what makes the answer checkable.
        'Prefer a tool result over memory when a declared tool can answer more accurately, and name the tool you used.',
        PERMISSIONS_GUIDELINE,
        TOOL_CREATE_GUIDELINE,
        'Be concise: no preamble, no restating the question.'
    ]
};
