// CLI slash-command dispatch (task C3).
//
// What this file pins — the REPL's command layer, with every effect injected:
//   - ordinary text is NOT a command: `runCliCommand` returns false and the host
//     sends it to the model (nothing is written, nothing is executed);
//   - `/help` prints the local table AND the live `harness.commands` registry, so
//     `/task`, `/websearch` and `/webfetch` are discoverable from the terminal;
//   - `/tools` and `/presets` delegate to the injected printers (the existing
//     catalogue output must not change), `/reset` resets and prints the preserved
//     `conversation reset` line, `/exit` + `/quit` call the injected exit — never
//     `process.exit`;
//   - every other `/name` goes to `harness.executeCommand` with the line VERBATIM
//     (argument case preserved; only the parser folds the command name), and the
//     result's `content` is written;
//   - `isError` results go to `writeError`, and a thrown `unknown command` is
//     REPORTED (with a `/help` hint) rather than allowed to kill the REPL.
//
// The expectations are the documented contract (src/server/cli/commands.ts header,
// src/core/command.ts, src/harness.commands.test.ts), not whatever the
// implementation happened to print.
//
// Run: npx vitest run src/server/cli/commands.test.ts

import { describe, expect, it, vi } from 'vitest';
import type { Harness, HarnessCommand, HarnessCommandResult } from '../../harness';
import { cliCommandHelp, isLocalCliCommand, runCliCommand } from './commands';
import type { CliCommandHost } from './commands';

// The five built-ins, reduced to the metadata `/help` renders (descriptions and
// usages quoted from the registry test at src/harness.commands.test.ts:483-492).
// `execute` is never reached: the dispatcher talks to `executeCommand` only, and
// the stub below records that call instead of building an agent or a transport.
const command = (name: string, description: string, usage?: string): HarnessCommand => ({
    name,
    description,
    ...(usage === undefined ? {} : { usage }),
    execute: () => ({ content: `${name} ran` })
});

const BUILT_INS: Record<string, HarnessCommand> = {
    help: command('help', 'List the commands in this harness.', '/help [command]'),
    task: command(
        'task',
        "Read and change this session's task list.",
        '/task [list | add <text> | complete <id> | reopen <id> | remove <id>...]'
    ),
    tools: command('tools', 'List the tools registered in this harness.', '/tools [filter]'),
    webfetch: command(
        'webfetch',
        "Fetch one http(s) page through this session's fetch tool.",
        '/webfetch <url>'
    ),
    websearch: command(
        'websearch',
        "Search the web with this session's configured search tool.",
        '/websearch <query>'
    )
};

// Exact `/help` text for the `BUILT_INS` registry above. The layout IS the
// contract: a fixed local table with descriptions starting in column 23, then
// `harness commands:` holding `formatCommandHelp` output indented by two spaces
// (its `usage:` rows therefore by four), ending in a newline like every other CLI
// write.
const EXPECTED_HELP = [
    'commands:',
    '  /help                list commands',
    '  /reset               clear the conversation',
    '  /tools               list the tool catalogue',
    '  /presets             list presets',
    '  /exit, /quit         quit',
    'harness commands:',
    '  /help  List the commands in this harness.',
    '    usage: /help [command]',
    "  /task  Read and change this session's task list.",
    '    usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>...]',
    '  /tools  List the tools registered in this harness.',
    '    usage: /tools [filter]',
    '  /webfetch  Fetch one http(s) page through this session\'s fetch tool.',
    '    usage: /webfetch <url>',
    '  /websearch  Search the web with this session\'s configured search tool.',
    '    usage: /websearch <query>',
    ''
].join('\n');

// A host with recorded effects. `executed` is the verbatim line handed to
// `harness.executeCommand`, which is what the case-preservation tests assert.
const createHost = (options: {
    commands?: Record<string, HarnessCommand>;
    result?: HarnessCommandResult;
    failWith?: unknown;
} = {}) => {
    const { commands = BUILT_INS, result = { content: 'ok' }, failWith } = options;

    const written: string[] = [];
    const errors: string[] = [];
    const executed: string[] = [];
    const calls = { tools: 0, presets: 0, reset: 0, exit: 0 };

    const executeCommand = vi.fn(async (input: string): Promise<HarnessCommandResult> => {
        executed.push(input);

        if (failWith !== undefined) throw failWith;

        return result;
    });

    // Only `commands` and `executeCommand` are ever read, so this stand-in is a
    // complete harness for the dispatcher (cast, not a partial type).
    const harness = { commands, executeCommand } as unknown as Harness;

    const host: CliCommandHost = {
        harness,
        presets: [],
        write: (text) => {
            written.push(text);
        },
        writeError: (text) => {
            errors.push(text);
        },
        reset: () => {
            calls.reset += 1;
        },
        exit: () => {
            calls.exit += 1;
        },
        printTools: () => {
            calls.tools += 1;
        },
        printPresets: () => {
            calls.presets += 1;
        }
    };

    return { host, written, errors, executed, calls, executeCommand };
};

describe('runCliCommand — prompts', () => {
    it('returns false and writes nothing for ordinary prompt text', async () => {
        const env = createHost();

        expect(await runCliCommand('summarise this file', env.host)).toBe(false);
        expect(env.written).toEqual([]);
        expect(env.errors).toEqual([]);
        expect(env.executed).toEqual([]);
        expect(env.calls).toEqual({ tools: 0, presets: 0, reset: 0, exit: 0 });
    });

    it('treats a slash that does not start the line as prompt text', async () => {
        const env = createHost();

        expect(await runCliCommand('see /help please', env.host)).toBe(false);
        expect(env.written).toEqual([]);
        expect(env.executed).toEqual([]);
    });

    it('returns false for an empty line so the host can ignore it', async () => {
        const env = createHost();

        expect(await runCliCommand('', env.host)).toBe(false);
        expect(env.written).toEqual([]);
    });
});

describe('runCliCommand — local commands', () => {
    it('/help lists the local commands and every harness command', async () => {
        const env = createHost();

        expect(await runCliCommand('/help', env.host)).toBe(true);
        // One write, the whole table, and nothing sent to the harness: `/help` is
        // answered locally even though the registry holds a `/help` built-in.
        expect(env.written).toEqual([EXPECTED_HELP]);
        expect(env.errors).toEqual([]);
        expect(env.executed).toEqual([]);

        for (const name of ['task', 'websearch', 'webfetch']) {
            expect(EXPECTED_HELP).toContain(`  /${name}  `);
        }
    });

    it('folds only the command name, so /HELP is still the local help', async () => {
        const env = createHost();

        expect(await runCliCommand('/HELP', env.host)).toBe(true);
        expect(env.written).toEqual([EXPECTED_HELP]);
        expect(env.executed).toEqual([]);
    });

    it('renders the live registry, so a newly registered command shows up', async () => {
        const env = createHost({
            commands: { ...BUILT_INS, zulu: command('zulu', 'Zulu command.', '/zulu') }
        });

        expect(await runCliCommand('/help', env.host)).toBe(true);
        // Sorted after /websearch, indented like the rest of the section.
        expect(env.written[0]).toContain(
            '  /zulu  Zulu command.\n    usage: /zulu\n'
        );
    });

    it('says so when the harness has no commands at all', async () => {
        const env = createHost({ commands: {} });

        expect(await runCliCommand('/help', env.host)).toBe(true);
        expect(env.written[0]).toContain('harness commands:\n  No commands are registered.\n');
    });

    it('/tools and /presets call the injected printers exactly once', async () => {
        const env = createHost();

        expect(await runCliCommand('/tools', env.host)).toBe(true);
        expect(await runCliCommand('/presets', env.host)).toBe(true);

        expect(env.calls).toEqual({ tools: 1, presets: 1, reset: 0, exit: 0 });
        // The printers own the output; the dispatcher writes nothing itself, and
        // the harness `/tools` built-in is never reached.
        expect(env.written).toEqual([]);
        expect(env.errors).toEqual([]);
        expect(env.executed).toEqual([]);
    });

    it('/reset resets the conversation and prints the preserved line', async () => {
        const env = createHost();

        expect(await runCliCommand('/reset', env.host)).toBe(true);
        expect(env.calls).toEqual({ tools: 0, presets: 0, reset: 1, exit: 0 });
        expect(env.written).toEqual(['conversation reset\n']);
        expect(env.errors).toEqual([]);
        expect(env.executed).toEqual([]);
    });

    it('/exit and /quit call the injected exit and nothing else', async () => {
        for (const line of ['/exit', '/quit', '/QUIT']) {
            const env = createHost();

            expect(await runCliCommand(line, env.host)).toBe(true);
            expect(env.calls).toEqual({ tools: 0, presets: 0, reset: 0, exit: 1 });
            expect(env.written).toEqual([]);
            expect(env.errors).toEqual([]);
            expect(env.executed).toEqual([]);
        }
    });
});

describe('runCliCommand — harness commands', () => {
    it('forwards /task add "Testing" verbatim and writes the returned content', async () => {
        const content = '#1 [ ] Testing\n1 total, 0 completed, 1 pending';
        const env = createHost({ result: { content } });

        expect(await runCliCommand('/task add "Testing"', env.host)).toBe(true);
        // The line is forwarded untouched: quoted argument, and the task text's
        // capital `T`. The old REPL lowercased the whole input.
        expect(env.executed).toEqual(['/task add "Testing"']);
        expect(env.written).toEqual([`${content}\n`]);
        expect(env.errors).toEqual([]);
    });

    it('/websearch Mixed Case Query preserves the argument case', async () => {
        const env = createHost({ result: { content: '1 result(s) via exa' } });

        expect(await runCliCommand('/websearch Mixed Case Query', env.host)).toBe(true);
        expect(env.executed).toEqual(['/websearch Mixed Case Query']);

        // The NAME is what the parser folds; an upper-case name still dispatches
        // (the harness lookup canonicalizes it), and the line is forwarded as typed.
        const upper = createHost({ result: { content: '1 result(s) via exa' } });

        expect(await runCliCommand('/WEBSEARCH Mixed Case Query', upper.host)).toBe(true);
        expect(upper.executed).toEqual(['/WEBSEARCH Mixed Case Query']);
    });

    it('sends an isError result to writeError, un-prefixed', async () => {
        const content =
            '/task: unknown action "bogus".\nusage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>...]';
        const env = createHost({ result: { content, isError: true } });

        expect(await runCliCommand('/task bogus', env.host)).toBe(true);
        // stdout stays clean: a usage mistake is a RESULT the harness already
        // describes, so it is printed verbatim on stderr.
        expect(env.written).toEqual([]);
        expect(env.errors).toEqual([`${content}\n`]);
    });

    it('prints nothing for a command that returns empty content', async () => {
        const env = createHost({ result: { content: '' } });

        expect(await runCliCommand('/task', env.host)).toBe(true);
        expect(env.written).toEqual([]);
        expect(env.errors).toEqual([]);
    });

    it('reports an unknown command without throwing, and points at /help', async () => {
        // The exact HarnessError text `harness.executeCommand` throws
        // (src/harness.ts:7206).
        const env = createHost({ failWith: new Error('unknown command: /nope') });

        expect(await runCliCommand('/nope', env.host)).toBe(true);
        expect(env.written).toEqual([]);
        expect(env.errors).toEqual([
            'unknown command: /nope\nhint: /help lists the commands this session can run\n'
        ]);
        expect(env.executed).toEqual(['/nope']);
    });

    it('keeps the REPL alive for a bare slash', async () => {
        const env = createHost({ failWith: new Error('unknown command: /') });

        expect(await runCliCommand('/', env.host)).toBe(true);
        expect(env.errors).toEqual([
            'unknown command: /\nhint: /help lists the commands this session can run\n'
        ]);
    });

    it('reports a command implementation that throws instead of crashing', async () => {
        const env = createHost({ failWith: new Error('provider exploded') });

        expect(await runCliCommand('/websearch anything', env.host)).toBe(true);
        expect(env.written).toEqual([]);
        expect(env.errors).toEqual(['command failed: provider exploded\n']);
    });
});

describe('cliCommandHelp', () => {
    it('is the same text /help prints, and ends in a newline', () => {
        const harness = { commands: BUILT_INS } as unknown as Harness;

        expect(cliCommandHelp(harness)).toBe(EXPECTED_HELP);
        expect(cliCommandHelp(harness).endsWith('\n')).toBe(true);
    });
});

describe('isLocalCliCommand', () => {
    it('names only the commands the terminal answers itself', () => {
        for (const line of ['/exit', '/quit', '/help', '/reset', '/tools', '/presets']) {
            expect(isLocalCliCommand(line)).toBe(true);
        }

        // Registry commands, unknown names, and non-commands are all false: a
        // host routes those to the harness or to the model.
        for (const line of ['/task add "Testing"', '/websearch', '/nope', '/', 'hello', 'see /help please', '']) {
            expect(isLocalCliCommand(line)).toBe(false);
        }
    });
});
