// The playground's harness presets.
//
// Each preset is a *factory*, not a harness: a harness bakes its transport in at
// construction, so changing the endpoint (base URL, key, model) means building a
// new one. The playground rebuilds lazily, on the next run, and keeps the last
// conversation on screen.
//
// The preset name is the harness's entry-agent name, because the registry key is
// the identity — the same rule a consumer sees in `harness({ agents: { writer } })`.
//
// Two kinds of preset:
//   - offline — `demo` uses a scripted transport, so the deployed GitHub Pages
//     build is fully interactive with no endpoint at all;
//   - live — everything else talks to an OpenAI-compatible endpoint through the
//     package's default transport, configured from the playground settings.

import { agent, harness, tool } from '@underload/harness';
import type {
    Harness,
    HarnessProgress,
    HarnessStream,
    HarnessStreamEvent
} from '@underload/harness';

export type PlaygroundSettings = {
    baseURL: string;
    apiKey: string;
    model: string;
};

export type HarnessPreset = {
    // Harness name, which is also the entry agent's name.
    name: string;
    // Human title shown in the sidebar.
    title: string;
    description: string;
    // Live presets need a base URL; the offline demo does not.
    requiresEndpoint: boolean;
    // Declared for display only — the harness registry is the source of truth.
    agents: readonly string[];
    tools: readonly string[];
    create: (settings: PlaygroundSettings, progress: HarnessProgress) => Harness;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const providerOf = (settings: PlaygroundSettings) => ({
    baseURL: settings.baseURL.trim(),
    // An empty key is omitted rather than sent as `Bearer `.
    apiKey: settings.apiKey.trim().length === 0 ? undefined : settings.apiKey,
    sampling: { temperature: 0.3 }
});

// ---------------------------------------------------------------------------
// Browser-safe tools
// ---------------------------------------------------------------------------
//
// The package's preset tools (readFile, runCommand, …) need Node built-ins, so
// they cannot run in a browser. These playground tools are the same `tool()`
// shape with implementations that work anywhere.

const clock = tool<string | undefined, { timezone: string; iso: string; unix: number }>({
    description:
        'Read the current time. Returns an ISO 8601 timestamp and the Unix time in seconds. The timezone argument is only a label for the answer.',
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

// The tool-side half of a multi-agent run: `run(name, input)` is only present
// inside a harness, so a direct call falls back to returning the notes untouched.
const summarize = tool<string, string>({
    description:
        'Hand the collected notes to the summarizer agent and return its summary. Use this once you have notes worth compressing.',
    parameters: {
        type: 'object',
        properties: {
            notes: { type: 'string', description: 'The notes, as text, to summarise.' }
        },
        required: ['notes'],
        additionalProperties: false
    },
    execute: async ({ parameters: notes, run }) => {
        if (!run) return notes;

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

// ---------------------------------------------------------------------------
// Offline demo transport
// ---------------------------------------------------------------------------

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('The run was aborted.'));
            return;
        }

        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new Error('The run was aborted.'));
        };

        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        signal?.addEventListener('abort', onAbort, { once: true });
    });

// Stream a string in small chunks so the UI shows the same event shape a real
// provider produces: many deltas, then one terminal frame.
async function* speak(
    text: string,
    type: 'text' | 'reasoning',
    signal?: AbortSignal
): AsyncGenerator<HarnessStreamEvent> {
    for (const piece of text.split(/(\s+)/)) {
        if (piece.length === 0) continue;

        await sleep(16, signal);
        yield { type, delta: piece };
    }
}

const DEMO_REASONING =
    'No endpoint is attached to this preset, so the transport is scripted. ' +
    'I should call the clock tool once to show a tool round, then answer in text.';

const DEMO_PREAMBLE = 'Checking the time with the clock tool, then I will explain what just happened.';

// The scripted transport. It reads the request to decide which round it is in:
// the harness appends a `tool` message before re-requesting, so a transcript that
// ends in a tool result means the tool round is over.
const scriptedDemo = (): HarnessStream =>
    async function* (request): AsyncGenerator<HarnessStreamEvent> {
        const last = request.messages[request.messages.length - 1];

        if (last !== undefined && last.role === 'tool') {
            const text =
                `The clock tool returned ${last.content}. ` +
                'That is the whole loop: the harness ran the tool, appended its result, and re-requested ' +
                'until the model answered with text. Switch to a live preset and set an endpoint to try ' +
                'this against a real model.';

            yield* speak(text, 'text', request.signal);
            yield {
                type: 'done',
                stopReason: 'stop',
                toolCalls: [],
                usage: { input: 96, output: 64, total: 160 }
            };
            return;
        }

        yield* speak(DEMO_REASONING, 'reasoning', request.signal);
        yield* speak(DEMO_PREAMBLE, 'text', request.signal);
        yield {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'call_clock_1', name: 'clock', arguments: '{"timezone":"UTC"}' }],
            usage: { input: 48, output: 22, total: 70 }
        };
    };

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const demo: HarnessPreset = {
    name: 'demo',
    title: 'Scripted demo',
    description:
        'Runs a scripted transport with a reasoning stream, one tool call, and a final answer. No endpoint needed, so this is the preset to try first.',
    requiresEndpoint: false,
    agents: ['demo'],
    tools: ['clock'],
    create: (settings, progress) =>
        harness({
            agents: {
                demo: agent({
                    model: settings.model.trim().length > 0 ? settings.model : 'scripted/demo',
                    instruction:
                        'You are the offline demo agent. The transport is scripted; nothing is sent to a model.',
                    stream: scriptedDemo()
                })
            },
            tools: { clock },
            report: { progress }
        })
};

const writer: HarnessPreset = {
    name: 'writer',
    title: 'Writer',
    description: 'A single agent with no tools. The shortest path through the harness: one turn, one reply.',
    requiresEndpoint: true,
    agents: ['writer'],
    tools: [],
    create: (settings, progress) =>
        harness({
            agents: {
                writer: agent({
                    model: settings.model,
                    instruction: 'You are a concise writer. Answer in prose, in a few sentences. Do not use tools.',
                    provider: providerOf(settings)
                })
            },
            report: { progress }
        })
};

const assistant: HarnessPreset = {
    name: 'assistant',
    title: 'Tool user',
    description: 'One agent with three browser-safe tools: clock, wordCount, and roll. Watch the tool round trip.',
    requiresEndpoint: true,
    agents: ['assistant'],
    tools: ['clock', 'wordCount', 'roll'],
    create: (settings, progress) =>
        harness({
            agents: {
                assistant: agent({
                    model: settings.model,
                    instruction:
                        'You are a helpful assistant. Prefer the available tools over memory whenever a tool can answer more accurately. Keep answers brief and mention which tool you used.',
                    provider: providerOf(settings)
                })
            },
            tools: { clock, wordCount, roll },
            report: { progress }
        })
};

const researcher: HarnessPreset = {
    name: 'researcher',
    title: 'Researcher + summarizer',
    description:
        'Two agents. The entry agent searches local notes and delegates to the summarizer through the tool context, so one run shows two agent streams.',
    requiresEndpoint: true,
    agents: ['researcher', 'summarizer'],
    tools: ['searchNotes', 'summarize'],
    create: (settings, progress) =>
        harness({
            agents: {
                researcher: agent({
                    model: settings.model,
                    instruction:
                        'You are a researcher. Use searchNotes to look up facts about the harness, then call summarize with the notes you collected. Finish by restating the summary in your own words.',
                    provider: providerOf(settings)
                }),
                summarizer: agent({
                    model: settings.model,
                    instruction: 'You compress technical notes into at most two sentences. No preamble.',
                    provider: providerOf(settings)
                })
            },
            tools: { searchNotes, summarize },
            report: { progress }
        })
};

const failure: HarnessPreset = {
    name: 'flaky',
    title: 'Recoverable failures',
    description:
        'A tool that throws on two out of every three calls. The harness turns each error into a tool result, so the model can retry instead of the run dying.',
    requiresEndpoint: true,
    agents: ['flaky'],
    tools: ['flaky'],
    create: (settings, progress) =>
        harness({
            agents: {
                flaky: agent({
                    model: settings.model,
                    instruction:
                        'You are testing tool reliability. Call the flaky tool. If it fails, call it again with no arguments until it succeeds, then report the number of attempts.',
                    provider: providerOf(settings)
                })
            },
            tools: { flaky },
            report: { progress }
        })
};

export const presets: readonly HarnessPreset[] = [demo, writer, assistant, researcher, failure];
