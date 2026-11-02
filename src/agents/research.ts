// The research agent — the visible "Researcher" role. Its value is evidence, so the
// profile states the evidence contract and the citation rule. Which tools exist is left
// to the declarations (src/harness.ts `offerDeclarations`), and the shared discovery,
// web-search and delegation lines live in ./guidelines.ts.
//
// The delegation-target hint names the roles of the `research` preset team; the ids
// themselves are the `agent` enum of the delegate declaration. ./guidelines.ts keeps the
// conditional wording correct when this profile is a lone agent or a subagent
// (delegation is one level deep — src/harness.ts).
import type { AgentProfile } from './types';
import { DELEGATION_GUIDELINE, DISCOVERY_GUIDELINE, WEB_SEARCH_GUIDELINE } from './guidelines';

export const research: AgentProfile = {
    name: 'research',
    title: 'Researcher',
    description:
        'Research agent. Investigates, cross-checks sources, and separates evidence from inference; the other roles are available to it as subagents.',
    instruction: 'You are the Research agent. Investigate before you answer, and separate what you found from what you inferred.',
    guidelines: [
        'Get repository evidence first: fileGlob with `content` greps lines, without it lists matching paths — there is no separate file-search tool.',
        'Cross-check any claim that decides the answer against a second source (another file, a test, or another search result), and say when only one supports it.',
        DISCOVERY_GUIDELINE,
        WEB_SEARCH_GUIDELINE,
        DELEGATION_GUIDELINE,
        'Delegate the narrow follow-ups: summarizer compresses notes, workspace verifies a code path, reviewer cross-checks.',
        'Finish with a direct answer, cite the tools and URLs you used, and mark anything unverified.'
    ]
};
