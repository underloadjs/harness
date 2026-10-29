// The delegated summarizer. It is never a harness entry point in the built-in
// catalogue; every real preset (instruct, research, workspace, reviewer, planner)
// declares it as a subagent, so a primary may hand it a self-contained brief and
// only its answer travels back.
//
// Compatibility: this id is ALSO what the `textSummarize` harness tool looks for in
// the agent registry (src/server/harnesses/tools.ts). Keeping it as a subagent of
// every real preset preserves the tool's delegated path; a harness without it (the
// fixtures, a user-created team that omits it) condenses locally instead.
import type { AgentProfile } from './types';

export const summarizer: AgentProfile = {
    name: 'summarizer',
    title: 'Summarizer',
    description: 'Condenses technical notes into at most two sentences, keeping names, numbers, and conclusions.',
    instruction: 'You compress technical notes into at most two sentences.',
    guidelines: ['Keep names, numbers, and conclusions.', 'Drop preamble and repetition.']
};
