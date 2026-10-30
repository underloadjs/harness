// Independently compilable source entry for the `noteSearch` app tool.
//
// R2: imports only the shared `tool` helper. The local corpus is a file-local
// helper constant — "independent compilation" does not mean every tool must be a
// single file, but no other REGISTERED TOOL implementation is imported here.
//
// Deliberately offline so the research preset has a search that never depends on
// a provider key.

// `core` is the harness-internal live helper entry (see ./timeNow.ts): the source
// compiler treats it as framework, not as a second editable tool copy.
import { tool } from '../../../core';

// A tiny corpus so the researcher preset has something to search that is not the
// network. Each note is a fact about this package, which keeps the demo honest.
const NOTES: readonly { title: string; body: string }[] = [
    {
        title: 'The loop',
        body: 'harness() appends the user input, runs a turn, executes every tool the model asked for, appends each result, and re-requests until the model answers with text. An unknown tool, malformed JSON, or a throwing tool becomes a tool result the model can read and recover from.'
    },
    {
        title: 'The registry key is the identity',
        body: 'Agents and tools are keyed by name in the harness configuration. The key names the agent in progress events and is the wire name the model calls, so the definition never repeats its own name. The first agent key is the entry point.'
    },
    {
        title: 'Single-property rule',
        body: 'When a tool schema declares exactly one property, execute receives that property value instead of the wrapper object. That is why fileRead(["package.json"]) and a model call carrying { "paths": ["package.json"] } run the same code path.'
    },
    {
        title: 'Progress events',
        body: 'report.progress is awaited for every step and receives start, reasoning, text, tool_call, tool_result, done, and error events. Every event names its agent, so a multi-agent run stays readable in one stream.'
    }
];

// noteSearch — the local corpus.
const noteSearch = tool<string, { title: string; excerpt: string }[]>({
    description: 'Search a small local corpus of notes about the harness and return the matching entries.',
    tags: ['search', 'notes', 'knowledge'],
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Words to look for, e.g. "tool loop".' }
        },
        required: ['query'],
        additionalProperties: false
    },
    execute: ({ parameters: query }) => {
        const needle = query.trim().toLowerCase();

        return NOTES.filter((note) => {
            if (needle.length === 0) return true;
            return `${note.title} ${note.body}`.toLowerCase().indexOf(needle) >= 0;
        }).map((note) => ({ title: note.title, excerpt: note.body }));
    }
});

export { noteSearch };
export default noteSearch;
