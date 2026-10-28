// Harness-level tools.
//
// These are ordinary `tool()` definitions, now executed by the server instead of
// being stubbed in a browser. They are deliberately dependency-free so the
// catalogue stays useful without an endpoint, and they show the discovery flow:
// every one is searchable, so a model must call getTools before it can use one.

import { tool } from '../src/harness';
import type { Tool } from '../src/harness';

const clock = tool<string | undefined, { timezone: string; iso: string; unix: number }>({
    description:
        'Read the current time. Returns an ISO 8601 timestamp and the Unix time in seconds. The timezone argument is only a label for the answer.',
    tags: ['time', 'clock', 'date'],
    parameters: {
        type: 'object',
        properties: {
            timezone: { type: 'string', description: 'Label for the timezone being asked about, e.g. "UTC".' }
        },
        required: ['timezone'],
        additionalProperties: false
    },
    execute: ({ parameters: timezone }) => {
        const now = new Date();

        return {
            timezone: timezone ?? 'UTC',
            iso: now.toISOString(),
            unix: Math.floor(now.getTime() / 1000)
        };
    }
});

const wordCount = tool<string, { words: number; characters: number }>({
    description: 'Count the words and characters in a text. Useful before claiming a length.',
    tags: ['text', 'words', 'count'],
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Text to measure.' }
        },
        required: ['text'],
        additionalProperties: false
    },
    execute: ({ parameters: text }) => {
        const trimmed = text.trim();

        return {
            words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
            characters: text.length
        };
    }
});

const roll = tool<number | undefined, { sides: number; value: number }>({
    description: 'Roll a fair die and return the value. Defaults to six sides.',
    tags: ['random', 'dice', 'chance'],
    parameters: {
        type: 'object',
        properties: {
            sides: { type: 'number', description: 'Number of faces on the die, e.g. 6.' }
        },
        required: ['sides'],
        additionalProperties: false
    },
    execute: ({ parameters: sides }) => {
        const faces = Math.max(2, Math.floor(sides ?? 6));

        return { sides: faces, value: 1 + Math.floor(Math.random() * faces) };
    }
});

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
        body: 'When a tool schema declares exactly one property, execute receives that property value instead of the wrapper object. That is why pythonSyntax("print(1)") and a model call carrying { "code": "print(1)" } run the same code path.'
    },
    {
        title: 'Progress events',
        body: 'report.progress is awaited for every step and receives start, reasoning, text, tool_call, tool_result, done, and error events. Every event names its agent, so a multi-agent run stays readable in one stream.'
    }
];

const searchNotes = tool<string, { title: string; excerpt: string }[]>({
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

// Deterministic local condensation: the first two sentences, whitespace
// collapsed. Used when there is no `summarizer` agent to hand the notes to —
// which is the normal case for Instruct/Workspace, whose agent configuration has
// no subagents. One shared toolbox means this tool must work in every live
// harness, so the fallback is a real summary rather than a silent no-op.
const condense = (notes: string): string => {
    const cleaned = notes.trim().replace(/\s+/g, ' ');

    if (cleaned.length === 0) return '';

    return cleaned
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => sentence.length > 0)
        .slice(0, 2)
        .join(' ');
};

// The tool-side half of a multi-agent run: `run(name, input)` is only present
// inside a harness. Research configures a `summarizer` subagent so this tool
// delegates to it; every other live harness shares the same tool but has no such
// agent, so it condenses locally (see `condense` above). A direct server call has
// neither `run` nor `agents`, and gets the same local fallback.
const summarize = tool<string, string>({
    description:
        'Summarise collected notes in at most two sentences. When the harness configures a summarizer subagent this hands the notes to it; otherwise it condenses them locally.',
    tags: ['summarize', 'text', 'agents'],
    parameters: {
        type: 'object',
        properties: {
            notes: { type: 'string', description: 'The notes, as text, to summarise.' }
        },
        required: ['notes'],
        additionalProperties: false
    },
    execute: async ({ parameters: notes, run, agents }) => {
        // `agents` is the harness registry; a missing `summarizer` key is the
        // documented agent-configuration difference, not an error.
        const summarizer = agents?.summarizer;

        if (!run || summarizer === undefined) return condense(notes);

        const message = await run('summarizer', `Summarise these notes in at most two sentences:\n\n${notes}`);
        return message.content;
    }
});

// Deliberately unreliable: fails twice, succeeds on the third call. It exists so
// the recoverable-failure path is visible — the harness feeds the error back as a
// tool result and the model gets another turn.
let flakyAttempts = 0;

const flaky = tool<Record<string, never>, string>({
    description:
        'A deliberately unreliable tool. It throws on the first two calls of every three. Call it again after a failure; the error is returned to you as a tool result.',
    tags: ['reliability', 'retry', 'testing'],
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    },
    execute: () => {
        flakyAttempts += 1;

        if (flakyAttempts % 3 !== 0) {
            throw new Error(`Temporary failure (attempt ${flakyAttempts}). Retry the same call.`);
        }

        return `Success on attempt ${flakyAttempts}.`;
    }
});

// The harness-level catalogue, keyed by the name the model calls. Package presets
// live in `src/tools`; these are the extras that need no Node built-ins.
export const harnessTools = {
    clock,
    wordCount,
    roll,
    searchNotes,
    summarize,
    flaky
} satisfies Readonly<Record<string, Tool>>;
