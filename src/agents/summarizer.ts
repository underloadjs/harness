// The delegated summarizer. It is never a harness entry point in the built-in
// catalogue; every real preset (instruct, research, workspace, reviewer, planner) puts it in
// its `ranks` map at `TEAM_RANK` ('B', src/server/harnesses/presets.ts) — strictly below the
// `ENTRY_RANK` ('A') agent that owns the card — so that entry agent may delegate it a
// self-contained brief and only its answer travels back. The retired "subagent" spelling named
// exactly this position on the rank ladder.
//
// Compatibility: this id is ALSO what the `textSummarize` harness tool looks for in
// the agent registry (src/server/harnesses/tools.ts). Keeping it ranked below every real
// preset's entry agent preserves the tool's delegated path; a harness without it (the
// fixtures, a user-created team that omits it) condenses locally instead.
import type { AgentProfile } from './types';

export const summarizer: AgentProfile = {
    name: 'summarizer',
    title: 'Summarizer',
    description: 'Condenses technical notes into at most two sentences, keeping names, numbers, and conclusions.',
    instruction: 'You compress technical notes into at most two sentences.',
    guidelines: ['Keep names, numbers, and conclusions.', 'Drop preamble and repetition.']
};
