// The harness CLI.
//
// This is the primary way to run a preset: one process, one conversation, no UI
// and no HTTP. The server (`--serve`) is an optional skin over the same catalogue
// and the same harness loop.
//
//   harness "summarise this"          one task as the live Instruct role, exit
//   harness                           interactive Instruct session (TTY)
//   echo "a task" | harness           one task from stdin
//   harness --preset planner          a different real role
//   harness --preset demo             offline scripted fixture (no endpoint)
//   harness --preset instruct --json  newline-delimited events
//   harness --serve                   API + built UI on http://127.0.0.1:5181
//
// With no `--preset`, the default is the real Instruct role, not the demo: a
// scripted answer is useful only as an explicit offline demonstration. There is
// no silent demo fallback when a provider is unreachable; a live role reports
// the run failure instead.

import { createInterface } from 'node:readline';
import { createToolCatalogue, findPreset, presets } from '../harnesses';
import type { HarnessPreset, RunnerSettings } from '../harnesses/types';
import { loadConfiguration } from '../config';
import { loadEnvironmentFile } from '../environment';
import { startHarnessServer } from '../index';
import type { Harness, HarnessInteractionConfiguration } from '../../harness';
import { createRenderer } from './render';
import type { Renderer } from './render';
import { DEFAULT_CLI_PRESET, parseCliOptions } from './options';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// N4 owner interaction for the CLI. There is no prompt UI here, so the model may
// still ASK (the tool is declared) but every root question is answered with a
// readable error instead of silently accepting the recommendation. The runtime's
// child/fork path keeps its own auto-answer behaviour, which is why
// `autoAnswer` is left at its default. No answer is ever fabricated.
const CLI_INTERACTION: HarnessInteractionConfiguration = {
    actionRequest: async () => {
        throw new Error(
            'The CLI has no owner UI to answer an actionRequest. Decide safely from the available context instead; the recommended option is never selected automatically.'
        );
    }
};

const printUsage = (): void => {
    console.log(`@underload/harness — CLI agent harness

Usage:
  harness [options] [task]
  harness --serve [options]

With a task, runs it once and exits. With no task on a TTY, starts an interactive
session. With no task and piped stdin, reads the task from stdin.

Options:
  -p, --preset <name>    Harness preset to run (default: ${DEFAULT_CLI_PRESET})
                         Use --preset demo for the offline scripted fixture.
  -m, --model <model>    Model for live presets
  -b, --base-url <url>   OpenAI-compatible base URL
  -k, --api-key <key>    Provider key (default: HARNESS_API_KEY)
  -l, --list             List harness presets
      --tools            List callable tools
      --json             Print progress events as one JSON object per line
      --serve            Start the HTTP server (and built UI when present)
      --port <port>      Server port (default: 5181)
      --host <host>      Server host (default: 127.0.0.1)
      --no-color         Disable ANSI colour
  -h, --help             Show this help

Environment:
  HARNESS_BASE_URL, HARNESS_API_KEY, HARNESS_MODEL
  EXA_API_KEY, TAVILY_API_KEY   web search for live presets (opt-in, per key)
`);
};

const printPresets = (): void => {
    for (const preset of presets) {
        const mode = preset.requiresEndpoint ? 'live' : 'offline';
        console.log(`${preset.name.padEnd(12)} ${mode.padEnd(8)} ${preset.title}`);
        console.log(`  ${preset.description}`);
    }
};

// Built per call, after `loadEnvironmentFile()` (bottom of this file), so a search
// key from `.env` is visible. Never a module-level snapshot: that would capture
// the environment before the file is read.
const printTools = (): void => {
    const catalogue = createToolCatalogue();
    let group = '';

    for (const entry of catalogue.entries) {
        if (entry.group !== group) {
            group = entry.group;
            console.log(`\n${group}`);
        }

        // The columns match the old output exactly. An unconfigured entry appends
        // the hint instead of pretending the tool is callable, and the hint names
        // environment variables only (never a value).
        const availability =
            entry.availability?.state === 'unconfigured'
                ? `  [unconfigured — ${entry.availability.hint ?? 'set a provider key and restart'}]`
                : '';

        console.log(
            `  ${entry.name.padEnd(20)} ${entry.visibility.padEnd(11)} ${entry.tags.join(', ').padEnd(30)} ${entry.description}${availability}`
        );
    }
};

const readStdin = async (): Promise<string> => {
    process.stdin.setEncoding('utf8');
    let data = '';

    for await (const chunk of process.stdin) {
        data += chunk;
    }

    return data;
};

type Settings = RunnerSettings;

const settingsFrom = (values: {
    model?: string;
    'base-url'?: string;
    'api-key'?: string;
}): Settings => {
    const configured = loadConfiguration().settings;

    return {
        baseURL: values['base-url'] ?? configured.baseURL,
        apiKey: values['api-key'] ?? configured.apiKey,
        model: values.model ?? configured.model
    };
};

const resetHarness = (harness: Harness): void => {
    // `harness.reset()` resets the entry agent and discovery. A CLI session is the
    // whole conversation, so sibling agents are reset too.
    for (const agent of Object.values(harness.agents)) {
        agent.reset();
    }
    harness.reset();
};

const runPrompt = async (
    harness: Harness,
    input: string,
    renderer: Renderer,
    json: boolean,
    controller: AbortController
): Promise<void> => {
    try {
        await harness(input, { signal: controller.signal });
    } catch (error) {
        const message = messageOf(error);

        if (controller.signal.aborted) {
            if (!json) process.stderr.write('cancelled\n');
            return;
        }

        if (json) {
            process.stdout.write(`${JSON.stringify({ type: 'run_error', error: { message } })}\n`);
        } else {
            process.stderr.write(`run failed: ${message}\n`);
        }

        process.exitCode = 1;
    }
};

const interactive = async (
    preset: HarnessPreset,
    settings: Settings,
    renderer: Renderer,
    json: boolean
): Promise<void> => {
    const harness = preset.create(settings, renderer, { interaction: CLI_INTERACTION });
    const output = json ? process.stderr : process.stdout;

    output.write(`\n${preset.title} (${preset.name})\n`);
    output.write(
        preset.requiresEndpoint
            ? `model ${settings.model} · ${settings.baseURL}\n`
            : `model ${settings.model} · scripted transport\n`
    );
    output.write('commands: /help /reset /tools /presets /exit\n\n');

    const readline = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: json ? '' : '› '
    });

    let controller: AbortController | undefined;
    let running = false;
    let closed = false;

    readline.on('SIGINT', () => {
        if (controller !== undefined) {
            controller.abort();
            return;
        }

        closed = true;
        readline.close();
    });

    readline.on('close', () => {
        closed = true;
    });

    const handle = async (raw: string): Promise<void> => {
        const input = raw.trim();
        if (input.length === 0) return;

        if (input.startsWith('/')) {
            const command = input.toLowerCase();

            if (command === '/exit' || command === '/quit') {
                closed = true;
                readline.close();
                return;
            }

            if (command === '/help') {
                output.write('commands: /reset clears the conversation, /tools lists tools, /presets lists presets, /exit quits\n');
                return;
            }

            if (command === '/reset') {
                resetHarness(harness);
                output.write('conversation reset\n');
                return;
            }

            if (command === '/tools') {
                printTools();
                return;
            }

            if (command === '/presets') {
                printPresets();
                return;
            }

            output.write(`unknown command: ${input}\n`);
            return;
        }

        running = true;
        controller = new AbortController();
        readline.pause();

        try {
            await runPrompt(harness, input, renderer, json, controller);
        } finally {
            running = false;
            controller = undefined;

            if (!closed) {
                readline.resume();
                readline.prompt();
            }
        }
    };

    readline.on('line', (line) => {
        if (running) return;
        void handle(line);
    });

    readline.prompt();

    await new Promise<void>((resolve) => {
        readline.once('close', resolve);
    });

    // A line handler can still be in flight when the user quits.
    while (running) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

const oneShot = async (
    preset: HarnessPreset,
    settings: Settings,
    renderer: Renderer,
    input: string,
    json: boolean
): Promise<void> => {
    const harness = preset.create(settings, renderer, { interaction: CLI_INTERACTION });
    const controller = new AbortController();

    process.once('SIGINT', () => controller.abort());

    await runPrompt(harness, input, renderer, json, controller);
};

const main = async (): Promise<void> => {
    let parsed;

    try {
        parsed = parseCliOptions();
    } catch (error) {
        process.stderr.write(`${messageOf(error)}\n\n`);
        printUsage();
        process.exitCode = 1;
        return;
    }

    const { values, positionals } = parsed;

    if (values.help) {
        printUsage();
        return;
    }

    if (values.list) {
        printPresets();
        return;
    }

    if (values.tools) {
        printTools();
        return;
    }

    const settings = settingsFrom(values);

    if (values.serve) {
        const port = values.port === undefined ? undefined : Number(values.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
            process.stderr.write(`invalid port: ${values.port}\n`);
            process.exitCode = 1;
            return;
        }

        const server = await startHarnessServer({
            port,
            host: values.host,
            settings,
            defaults: {
                baseURL: settings.baseURL,
                model: settings.model,
                hasApiKey: settings.apiKey.trim().length > 0
            }
        });

        console.log(`Harness server listening at ${server.url}`);
        console.log(`  API  ${server.url}/api`);
        console.log(`  UI   ${server.url}`);
        console.log('Ctrl+C to stop.');

        const shutdown = (): void => {
            void server.close().then(
                () => process.exit(0),
                () => process.exit(1)
            );
        };

        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return;
    }

    const preset = findPreset(values.preset);

    if (preset === undefined) {
        process.stderr.write(`unknown harness preset: ${values.preset}\n`);
        process.stderr.write(`available: ${presets.map((entry) => entry.name).join(', ')}\n`);
        process.exitCode = 1;
        return;
    }

    if (preset.requiresEndpoint && settings.baseURL.trim().length === 0) {
        process.stderr.write(`harness "${preset.name}" needs a provider base URL.\n`);
        process.stderr.write('Set --base-url or HARNESS_BASE_URL, or run the offline fixture with --preset demo.\n');
        process.exitCode = 1;
        return;
    }

    const json = values.json;
    const renderer = createRenderer({ json, color: !values['no-color'] && process.stdout.isTTY === true });

    const prompt = positionals.join(' ').trim();

    if (prompt.length > 0) {
        await oneShot(preset, settings, renderer, prompt, json);
        return;
    }

    if (process.stdin.isTTY) {
        await interactive(preset, settings, renderer, json);
        return;
    }

    const piped = (await readStdin()).trim();

    if (piped.length === 0) {
        printUsage();
        process.exitCode = 1;
        return;
    }

    await oneShot(preset, settings, renderer, piped, json);
};

// Load the package-root `.env` before `main()` can read HARNESS_* in
// `settingsFrom` or construct a preset that captures EXA_/TAVILY_API_KEY.
loadEnvironmentFile();

await main();
