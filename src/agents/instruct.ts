// The general-purpose default agent. Its guidelines are policy and discovery, never
// a restatement of the tool declarations: `offerDeclarations` (src/harness.ts) hands
// the model every callable tool with its description and schema, so naming tools
// that are already declared only duplicates context. The shared lines it composes
// live in ./guidelines.ts and explain what a declaration cannot: the searchable
// catalogue behind the declared set, a keyless host, and the un-sandboxed host.
//
// `delegate` is conditional on purpose. The shipped `instruct` preset declares the
// other real specialists as subagents, so delegate IS registered there; the same
// profile is also selectable as a single agent in a user-created harness, and a
// subagent never receives delegate (delegation is one level deep — src/harness.ts).
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
    instruction: 'You are the Instruct agent. Answer the request directly and keep the answer focused.',
    guidelines: [
        DISCOVERY_GUIDELINE,
        WEB_SEARCH_GUIDELINE,
        DELEGATION_GUIDELINE,
        'Prefer a tool over memory when a tool can answer more accurately, and name the tool you used.',
        PERMISSIONS_GUIDELINE,
        TOOL_CREATE_GUIDELINE,
        'Be concise.'
    ]
};
