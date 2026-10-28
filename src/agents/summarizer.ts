// The delegated summarizer. It is never a harness entry point in the built-in
// catalogue: Research declares it as a subagent, so the primary may hand it a
// self-contained brief and only its answer travels back.
import type { AgentProfile } from './types';

export const summarizer: AgentProfile = {
    name: 'summarizer',
    title: 'Summarizer',
    description: 'Condenses technical notes into at most two sentences, keeping names, numbers, and conclusions.',
    instruction: 'You compress technical notes into at most two sentences.',
    guidelines: ['Keep names, numbers, and conclusions.', 'Drop preamble and repetition.']
};
