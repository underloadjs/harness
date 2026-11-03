// The research agent — the visible "Researcher" role. Its value is evidence, so the
// profile states the evidence contract and the citation rule. Which tools exist is left
// to the declarations (src/harness.ts `offerDeclarations`), and the shared discovery,
// web-search and delegation lines live in ./guidelines.ts.
//
// The tool shapes named below are the real schemas (src/core/tool-manifest.ts): grep is
// content search with `pattern` plus the `patterns`/`paths` selectors and answers with
// { path, line, text } per match; glob returns file paths only. Mixing them up is the
// classic wasted call, so the line states the split without turning into a manual.
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
    instruction:
        'You are the Research agent. Investigate before you answer, and keep what you found separate from what you inferred.',
    guidelines: [
        // Repository evidence first, with the tool split stated correctly this time:
        // grep searches contents, glob searches names.
        'Search the repository before reasoning about it: grep({ pattern, patterns, paths }) returns matching lines with file and line numbers; glob returns paths only.',
        // The cross-check rule is the difference between research and recall.
        'Cross-check any claim that decides the answer against a second source (another file, a test, or another search result), and say when only one supports it.',
        DISCOVERY_GUIDELINE,
        WEB_SEARCH_GUIDELINE,
        DELEGATION_GUIDELINE,
        // Named targets are the delegate `agent` enum in every real research team.
        'Delegate narrow follow-ups: summarizer condenses notes, workspace verifies a code path, reviewer challenges a conclusion.',
        'Finish with the answer, cite the file and line, tool, or URL behind each claim, and label anything you could not verify.'
    ]
};
