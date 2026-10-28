// Harness-level tools.
//
// These are ordinary `tool()` definitions, now executed by the server instead of
// being stubbed in a browser. They are deliberately dependency-free so the
// catalogue stays useful without an endpoint, and they show the discovery flow:
// every one is searchable, so a model must call toolRequest before it can use one.
//
// NAMING (T14): `<namespace><action>` — timeNow, textCount, diceRoll, noteSearch,
// textSummarize, testFlaky. The old names (clock, wordCount, roll, searchNotes,
// summarize, flaky) are gone with no aliases; a second name for one tool would make
// discovery ambiguous.

import { tool, toolUi } from '../src/harness';
import type { Tool, ToolUiEnvelope } from '../src/harness';

// Demo-tool bounds (R8). These are validation limits, not knobs: the demo tools
// exist to be predictable examples, so an out-of-range argument is rejected with a
// readable error instead of silently clamped into a different answer.
//
//   - timezone is a LABEL only (it does not change the clock), capped at 64 chars
//     so a model cannot turn the demo panel into an arbitrary text sink;
//   - dice sides are a whole number 2..1000, default 6 (the same default the
//     schema advertises);
//   - notes handed to the summarizer are capped at 20k characters, with the
//     truncation stated in both the delegated prompt and the returned summary.
const MAX_TIMEZONE_CHARS = 64;
const DEFAULT_DICE_SIDES = 6;
const MIN_DICE_SIDES = 2;
const MAX_DICE_SIDES = 1_000;
const MAX_SUMMARIZE_NOTES = 20_000;

// Shown in the summary and in the delegated prompt whenever the notes were cut, so
// the model (and the user reading the panel) can tell a short answer from a
// truncated input. Fixed text: it names the bound, never the content.
const NOTES_TRUNCATED = `[notes truncated to ${MAX_SUMMARIZE_NOTES} characters]`;

// timeNow — the current time. The timezone argument is only a label for the answer.
//
// R20.2 DEMONSTRATION: this is the shipped example of a declarative panel. It
// returns `toolUi(content, panels)` so:
//   - the MODEL still receives exactly the JSON of `{ timezone, iso, unix }`
//     (the harness serializes `content` only — see src/harness.ts);
//   - a chat client gets one `right`-slot key/value panel on the tool_result;
//   - the manual/direct server call unwraps to the same `{ timezone, iso, unix }`
//     result object (server/api.ts) with an optional `panels` field.
// A caller that invokes the tool callable directly now receives the branded
// envelope, which is why `toolUiOf()` is exported for host code too. Keep the
// content shape unchanged: the scripted demo and the API contract depend on it.
const timeNow = tool<string | undefined, ToolUiEnvelope<{ timezone: string; iso: string; unix: number }>>({
    description:
        'Read the current time. Returns an ISO 8601 timestamp and the Unix time in seconds. The timezone argument is only a label for the answer.',
    tags: ['time', 'clock', 'date'],
    parameters: {
        type: 'object',
        properties: {
            timezone: {
                type: 'string',
                // The label is echoed into a panel block, so it is bounded here and
                // validated again for direct callers (who skip JSON Schema).
                maxLength: MAX_TIMEZONE_CHARS,
                description: 'Label for the timezone being asked about, e.g. "UTC".'
            }
        },
        required: ['timezone'],
        additionalProperties: false
    },
    execute: ({ parameters: timezone }) => {
        // `?? 'UTC'` keeps the documented default for a direct call that omits the
        // label. Any present label must be a bounded, non-blank string: a non-string
        // (direct callers bypass the schema) or an oversized one is refused rather
        // than coerced into the panel.
        const label = timezone ?? 'UTC';

        if (typeof label !== 'string' || label.trim().length === 0 || label.length > MAX_TIMEZONE_CHARS) {
            throw new Error(`timeNow timezone must be a non-empty string of at most ${MAX_TIMEZONE_CHARS} characters.`);
        }

        const now = new Date();
        const content = {
            timezone: label,
            iso: now.toISOString(),
            unix: Math.floor(now.getTime() / 1000)
        };

        return toolUi(content, [
            {
                id: 'timeNow',
                // 'right' is the default mount point; slot names are open strings.
                slot: 'right',
                title: 'Current time',
                blocks: [
                    {
                        type: 'keyValue',
                        items: [
                            { label: 'Timezone', value: content.timezone },
                            { label: 'ISO 8601', value: content.iso },
                            { label: 'Unix', value: String(content.unix) }
                        ]
                    },
                    { type: 'text', text: 'Read from the server clock at execution time.' }
                ]
            }
        ]);
    }
});

// textCount — words and characters, so a model can check a length claim.
//
// Character count is UTF-16 code units (`String.prototype.length`), i.e. the unit
// JavaScript strings use. An astral character such as an emoji counts as two.
// Switching to code points would change existing answers, so the unit is
// documented in the description and parameter text instead.
const textCount = tool<string, { words: number; characters: number }>({
    description:
        'Count the words and characters in a text. Useful before claiming a length. Characters are UTF-16 code units (JavaScript string length), so characters outside the basic plane, such as many emoji, count as two.',
    tags: ['text', 'words', 'count'],
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Text to measure. Characters are counted in UTF-16 code units.' }
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

// diceRoll — a fair die, so the random path is exercised without a network call.
//
// The schema and the implementation now state the same default (6) and the same
// domain (a whole number of faces, 2..1000). The old code silently clamped any
// input (`Math.max(2, Math.floor(sides))`) and advertised a default while marking
// the argument required, so `{}` and a negative number both returned a die that
// did not match what was asked for.
const diceRoll = tool<number | undefined, { sides: number; value: number }>({
    description: `Roll a fair die and return the value. Sides must be a whole number from ${MIN_DICE_SIDES} to ${MAX_DICE_SIDES}; defaults to ${DEFAULT_DICE_SIDES} sides.`,
    tags: ['random', 'dice', 'chance'],
    parameters: {
        type: 'object',
        properties: {
            sides: {
                type: 'integer',
                minimum: MIN_DICE_SIDES,
                maximum: MAX_DICE_SIDES,
                default: DEFAULT_DICE_SIDES,
                description: `Number of faces on the die, a whole number from ${MIN_DICE_SIDES} to ${MAX_DICE_SIDES}. Defaults to ${DEFAULT_DICE_SIDES}.`
            }
        },
        // Optional: the default is part of the documented contract, so the schema
        // must not claim the argument is required.
        required: [],
        additionalProperties: false
    },
    execute: ({ parameters: sides }) => {
        // Single-property rule: `sides` is the number itself, or undefined.
        const faces = sides ?? DEFAULT_DICE_SIDES;

        if (
            typeof faces !== 'number' ||
            !Number.isFinite(faces) ||
            !Number.isInteger(faces) ||
            faces < MIN_DICE_SIDES ||
            faces > MAX_DICE_SIDES
        ) {
            throw new Error(`diceRoll sides must be a whole number from ${MIN_DICE_SIDES} to ${MAX_DICE_SIDES}.`);
        }

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
        body: 'When a tool schema declares exactly one property, execute receives that property value instead of the wrapper object. That is why fileRead(["package.json"]) and a model call carrying { "paths": ["package.json"] } run the same code path.'
    },
    {
        title: 'Progress events',
        body: 'report.progress is awaited for every step and receives start, reasoning, text, tool_call, tool_result, done, and error events. Every event names its agent, so a multi-agent run stays readable in one stream.'
    }
];

// noteSearch — the local corpus. Deliberately offline so the research preset has
// a search that never depends on a provider key.
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

// textSummarize — the tool-side half of a multi-agent run: `run(name, input)` is
// only present inside a harness. Research configures a `summarizer` subagent so
// this tool delegates to it; every other live harness shares the same tool but has
// no such agent, so it condenses locally (see `condense` above). A direct server
// call has neither `run` nor `agents`, and gets the same local fallback.
const textSummarize = tool<string, string>({
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

// Deliberately unreliable: fails twice, succeeds on the third call. It exists so
// the recoverable-failure path is visible — the harness feeds the error back as a
// tool result and the model gets another turn. The harness id stays `flaky`; only
// the TOOL is testFlaky.
//
// State is per AGENT, not per process (R8): the old module-level counter made two
// sessions share one attempt count, so session A's failures could "heal" session
// B's first call. The harness passes the requesting `agent` in the tool context
// (src/types ToolContext, populated at harness.ts:~655), and each session builds
// its own Agent objects, so a WeakMap keyed by that object is session isolation
// with automatic garbage collection.
//
// A direct `testFlaky()` call has no agent; that path keeps one explicit fallback
// counter. It is deliberately not a factory: the preset/toolbox registry shares
// this singleton on purpose, and the WeakMap is what makes sharing safe.
const flakyAttempts = new WeakMap<object, number>();
let directFlakyAttempts = 0;

// Count one attempt for this caller: the agent object inside a harness, or the
// single module fallback for a direct call (and for any future context that does
// not carry an agent).
const nextFlakyAttempt = (agent: unknown): number => {
    const key = agent !== null && (typeof agent === 'object' || typeof agent === 'function') ? agent : undefined;

    if (key === undefined) {
        directFlakyAttempts += 1;
        return directFlakyAttempts;
    }

    const attempt = (flakyAttempts.get(key) ?? 0) + 1;
    flakyAttempts.set(key, attempt);
    return attempt;
};

const testFlaky = tool<Record<string, never>, string>({
    description:
        'A deliberately unreliable tool. It throws on the first two calls of every three. Call it again after a failure; the error is returned to you as a tool result.',
    tags: ['reliability', 'retry', 'testing'],
    parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
    },
    execute: ({ agent }) => {
        const attempt = nextFlakyAttempt(agent);

        if (attempt % 3 !== 0) {
            throw new Error(`Temporary failure (attempt ${attempt}). Retry the same call.`);
        }

        return `Success on attempt ${attempt}.`;
    }
});

// The harness-level catalogue, keyed by the name the model calls. Package presets
// live in `src/tools`; these are the extras that need no Node built-ins.
export const harnessTools = {
    timeNow,
    textCount,
    diceRoll,
    noteSearch,
    textSummarize,
    testFlaky
} satisfies Readonly<Record<string, Tool>>;
