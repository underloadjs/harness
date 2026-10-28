// The research agent. It is the only built-in primary with a subagent
// (`summarizer`), so it is also the built-in that gets `agentDelegate`.
//
// R18: fileRead/fileGlob (and a configured webSearch) are CORE, so repository and
// web evidence do not need discovery. fileList, noteSearch, textCount and
// textSummarize remain searchable.
import type { AgentProfile } from './types';

export const research: AgentProfile = {
    name: 'research',
    title: 'Research',
    description:
        'Research agent with the shared toolbox and a summarizer subagent. fileRead and fileGlob are always available, web search when the host configured a key; other capabilities are discovered by tag. Cites what it used.',
    instruction: 'You are the Research agent. Investigate before you answer, and separate what you found from what you inferred.',
    guidelines: [
        'fileRead and fileGlob are always available: use them directly for repository evidence. fileGlob is the one search surface; pass `content` to search inside files and omit it to list matching paths.',
        'webSearch is always available when the host configured a search key; call it directly when the question needs current or external facts. If it is not declared, the host has no key — say so plainly instead of inventing sources.',
        'Discover the rest with toolRequest: "files"/"list" for fileList, "notes" (noteSearch) for the local corpus, "text" (textCount) to measure a draft, and "summarize" (textSummarize) to compress collected notes.',
        'You may call agentDelegate with agent "summarizer" for a self-contained brief; the subagent does not see this conversation, so include everything it needs.',
        'Finish with a direct answer and cite the tools (and URLs, when web search returned them) you relied on.'
    ]
};
