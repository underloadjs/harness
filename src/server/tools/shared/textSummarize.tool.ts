// Independently compilable source entry for the `textSummarize` app tool.
//
// T25 MOVE: moved from `server/harnesses/tool-sources/textSummarize.ts` into the
// dedicated server tools folder (`server/tools`) and renamed to the discovery
// contract (`*.tool.ts`). `condense` is a file-local helper, so this entry stays
// independently compilable while keeping its only non-harness logic beside the
// tool that uses it.
//
// Tool-to-tool/harness access goes through the live execution context (`run` and
// `agents`) rather than importing another registered tool: a replacement of the
// summarizer agent or of a delegated tool is therefore observed, not captured.
//
// Cross-references:
//   - ../harnesses/tools.ts — discovers this folder, builds the lazy proxy
//   - ../harnesses/presets.ts — presets configure the summarizer agent this delegates to
//   - ../../core            — `tool` (mapped to the LIVE module by the compiler)

// `core` is the harness-internal live helper entry (see ./timeNow.tool.ts): the
// source compiler treats it as framework, not as a second editable tool copy.
import { tool } from '../../../core';

// Notes handed to the summarizer are capped at 20k characters, with the truncation
// stated in both the delegated prompt and the returned summary. Must equal the
// bound quoted in `metadata.description` (a literal, so the scanner can read it).
const MAX_SUMMARIZE_NOTES = 20_000;

// Shown in the summary and in the delegated prompt whenever the notes were cut, so
// the model (and the user reading the panel) can tell a short answer from a
// truncated input. Fixed text: it names the bound, never the content.
const NOTES_TRUNCATED = `[notes truncated to ${MAX_SUMMARIZE_NOTES} characters]`;

// Deterministic local condensation: the first two sentences, whitespace
// collapsed. Used when there is no `summarizer` agent to hand the notes to — the
// normal case for the fixtures and for any user-created team that omits it. The
// real presets do configure a summarizer (T3), but they share this toolbox, so
// the fallback must still be a real summary rather than a silent no-op.
const condense = (notes: string): string => {
    const cleaned = notes.trim().replace(/\s+/g, ' ');

    if (cleaned.length === 0) return '';

    return cleaned
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => sentence.length > 0)
        .slice(0, 2)
        .join(' ');
};

// Declarative half (T19/R9): pure literal, read by the AST scanner.
export const metadata = {
    name: 'textSummarize',
    description:
        'Summarise collected notes in at most two sentences. When the harness configures a summarizer subagent this hands the notes to it; otherwise it condenses them locally.',
    tags: ['summarize', 'text', 'condense'],
    parameters: {
        type: 'object',
        properties: {
            notes: { type: 'string', description: 'The notes, as text, to summarise.' }
        },
        required: ['notes'],
        additionalProperties: false
    }
};

// Harness policy. Order 1040 is last in the shared folder, matching the historical
// shared-toolbox order (timeNow, textCount, diceRoll, noteSearch, textSummarize).
export const registration = {
    group: 'external',
    activation: 'always',
    order: 1040,
    listed: true
} as const;

// textSummarize — the tool-side half of a multi-agent run: `run(name, input)` is
// only present inside a harness. The real presets configure a `summarizer`
// subagent, so this tool delegates to it; any other harness shares the same tool
// but has no such agent, so it condenses locally (see `condense` above). A direct
// server call has neither `run` nor `agents`, and gets the same local fallback.
//
// T3: the tags deliberately do NOT include "agents". Every real preset now has
// subagents, so an "agents"-tagged condenser made `toolRequest({ tags: ["agents"] })`
// look like a delegation discovery result even though the tool only summarises.
const textSummarize = tool<string, string>({
    ...metadata,
    execute: async ({ parameters: notes, run, agents }) => {
        // `agents` is the harness registry; a missing `summarizer` key is the
        // documented agent-configuration difference, not an error.
        const summarizer = agents?.summarizer;

        // Bound what reaches a subagent (or the local condenser): a model-supplied
        // note block is otherwise an unbounded prompt. The cut is STATED in the
        // prompt, not silent, so a summarizer never reports a false "complete".
        const truncated = typeof notes === 'string' && notes.length > MAX_SUMMARIZE_NOTES;
        const boundedNotes = truncated ? notes.slice(0, MAX_SUMMARIZE_NOTES) : notes;
        const truncationNote = truncated ? `\n\n${NOTES_TRUNCATED}` : '';

        const summary =
            !run || summarizer === undefined
                ? condense(boundedNotes)
                : (
                      await run(
                          'summarizer',
                          `Summarise these notes in at most two sentences:\n\n${boundedNotes}${truncationNote}`
                      )
                  ).content;

        // The result carries the same truncation marker as the prompt: the caller
        // must be able to tell why a summary of a long document is incomplete.
        return `${summary}${truncationNote}`;
    }
});

export { textSummarize };
export default textSummarize;
