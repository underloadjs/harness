// CLI slash-command dispatch — the REPL half of the shared command layer.
//
// WHY A MODULE
// ------------
// `./index.ts` IS the process: it calls `loadEnvironmentFile()` and `await main()`
// at import time, so a test cannot import it to pin what a typed line does (the
// same reason the argument parser lives in ./options.ts). Everything here is free
// of readline, stdout, and process state: the REPL injects a `CliCommandHost` of
// effects and gets back "was this line a command?".
//
// WHY IT EXISTS AT ALL
// --------------------
// The old REPL hard-coded an `if` chain over a LOWERCASED copy of the whole input,
// which meant (a) a task text or search query lost the case the operator typed,
// and (b) every harness command (`/task`, `/websearch`, `/webfetch`, plus anything
// a preset or plugin registers) was invisible from the terminal. Now the CLI and
// the HTTP server resolve a line through the SAME parser and the SAME registry:
// `parseCommandLine` (core/command.ts) decides command-vs-prompt, and
// `harness.executeCommand` runs it against this process's live session.
//
// SHADOWING — intentional, and why the order matters
// --------------------------------------------------
// The local set is checked FIRST, so `/help` and `/tools` answer from the CLI even
// though the harness registers built-ins with those names: a terminal operator
// wants the tool CATALOGUE (grouped, with the availability hints, rebuilt after
// `.env` is read — ./index.ts printTools) and the REPL's own command list, not the
// session-scoped view. Both names still appear under `harness commands:` in /help,
// because that section is `harness.commands` rendered verbatim; hiding entries
// would make /help disagree with what the registry actually reports.
//
// WHAT A COMMAND IS NOT
// --------------------
// A command never reaches the model and never emits a progress event
// (./harness.ts executeCommand), so dispatching one costs no turn. It is also
// serialized by the REPL: ./index.ts drops extra lines while a line is in flight,
// so a command and a prompt run never overlap.
//
// Cross-references:
//   - ../../core/command.ts      — parseCommandLine / formatCommandHelp (the grammar)
//   - ../../harness.ts           — handle.commands / handle.executeCommand (the registry)
//   - ./index.ts                 — the readline host that calls runCliCommand
//   - ./options.ts               — the same "extract pure logic from index.ts" precedent
//   - ../harnesses/types.ts      — HarnessPreset, the catalogue type `presets` holds

import { formatCommandHelp, parseCommandLine } from '../../harness';
import type { Harness, HarnessCommandResult } from '../../harness';
import type { HarnessPreset } from '../harnesses/types';

// Everything the dispatcher touches in the outside world, injected so the REPL
// stays testable from a plain object (and so this module never calls
// `process.exit`, which would kill the caller's loop).
export type CliCommandHost = {
    // The session the operator is talking to. Only `commands` (for /help) and
    // `executeCommand` (for everything else) are read here; the run loop, the
    // abort controller, and the renderer all stay in ./index.ts.
    harness: Harness;
    // The preset catalogue the injected printers were built from. The dispatcher
    // never reads it — `printPresets` owns the existing output format — but it is
    // part of the host so a caller (or a test) can pin the exact list the REPL
    // prints without reaching for the module-level catalogue.
    presets: readonly HarnessPreset[];
    // Ordinary command output. The REPL routes this to stdout, or to stderr in
    // `--json` mode where stdout carries the event stream.
    write: (text: string) => void;
    // Failures a terminal user must see separately: usage errors, an
    // unconfigured tool, an unknown command.
    writeError: (text: string) => void;
    // Clears the conversation (every agent plus the entry harness).
    reset: () => void;
    // Quits the REPL. Injected precisely so this module cannot exit the process.
    exit: () => void;
    // The existing catalogue printers; their output format is unchanged.
    printTools: () => void;
    printPresets: () => void;
};

// The commands the terminal answers itself, before the harness registry is
// consulted. `/exit` and `/quit` both quit because the pre-registry REPL took both.
const LOCAL_COMMANDS = ['exit', 'quit', 'help', 'reset', 'tools', 'presets'] as const;

// Case-folded lookup of one input line's command name, using the shared parser
// (so `/HELP` and `/help` are one command here exactly as they are server-side).
const isLocalCommandName = (name: string | undefined): boolean =>
    name !== undefined && (LOCAL_COMMANDS as readonly string[]).includes(name);

// Public predicate: is this input line a command the CLI handles locally? A host
// uses it to ROUTE without executing — the REPL sends every line that is not a
// command to the model, and `harness.commands` answers the rest.
export const isLocalCliCommand = (input: string): boolean =>
    isLocalCommandName(parseCommandLine(input)?.name);

// Column the local descriptions start in, so /help is a fixed, diffable table.
// 20 chars of name column keeps the longest entry (`/exit, /quit`, 12 chars) and
// the harness section visually separate without wrapping in an 80-column shell.
const LOCAL_HELP_COLUMN = 20;

// The local command table. Fixed by hand (not derived from the registry) because
// these commands exist with no harness at all, and `/help` and `/tools` shadow
// same-named built-ins — printing the registry's prose here would describe the
// command the operator is NOT getting.
const LOCAL_COMMAND_HELP: readonly (readonly [string, string])[] = [
    ['/help', 'list commands'],
    ['/reset', 'clear the conversation'],
    ['/tools', 'list the tool catalogue'],
    ['/presets', 'list presets'],
    ['/exit, /quit', 'quit']
];

// Full /help text for the REPL: its own commands, then the live harness registry.
//
// `formatCommandHelp` (core/command.ts) is already sorted and stable, so the
// harness section is diffable in a test and follows a runtime `registerCommand`
// or a plugin override automatically. Every line is indented two spaces to nest
// it under `harness commands:`, which also indents its `usage:` rows to four.
// The trailing empty element makes the returned text end in "\n", matching every
// other CLI write.
export const cliCommandHelp = (harness: Harness): string => {
    const harnessLines = formatCommandHelp(harness.commands)
        .split('\n')
        .map((line) => `  ${line}`);

    return [
        'commands:',
        ...LOCAL_COMMAND_HELP.map(
            ([names, description]) => `  ${names.padEnd(LOCAL_HELP_COLUMN)} ${description}`
        ),
        'harness commands:',
        ...harnessLines,
        ''
    ].join('\n');
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One command result → at most one write.
//
// `isError` is the harness's own "recoverable failure" flag (core/command-builtins
// .ts): a usage mistake or an unconfigured tool comes back as a RESULT, not a
// throw, and a host styles it. The text already names the command
// (`/task: unknown action "bogus".`), so it is printed verbatim on stderr rather
// than re-prefixed — the terminal, the server, and the UI then show one message.
// An empty content prints nothing instead of a stray blank line.
const writeResult = (host: CliCommandHost, result: HarnessCommandResult): void => {
    if (result.content.length === 0) return;

    if (result.isError === true) host.writeError(`${result.content}\n`);
    else host.write(`${result.content}\n`);
};

// Dispatch one typed line.
//
// Returns `true` when the line was command-shaped (leading "/") and therefore
// handled — including the failure paths, which report instead of throwing.
// Returns `false` for ordinary text, and the caller sends that to the model.
//
// CASE CONTRACT: the line is forwarded to `executeCommand` verbatim
// (`parsed.input` is the original string). Only the parser folds the command
// NAME, so `/websearch Mixed Case Query` searches for exactly what was typed;
// the old REPL's whole-input `toLowerCase()` is gone.
export const runCliCommand = async (input: string, host: CliCommandHost): Promise<boolean> => {
    const parsed = parseCommandLine(input);

    // Not command-shaped: a prompt, not a command.
    if (parsed === undefined) return false;

    // Local commands first (see the SHADOWING note at the top of this file).
    if (isLocalCommandName(parsed.name)) {
        switch (parsed.name) {
            case 'exit':
            case 'quit':
                // The host owns how the session ends (readline.close(), and the
                // drain loop that waits for an in-flight run).
                host.exit();
                break;

            case 'help':
                // Both sections, so one /help answers "what can I type here".
                host.write(cliCommandHelp(host.harness));
                break;

            case 'reset':
                host.reset();
                // Wording preserved from the pre-registry REPL.
                host.write('conversation reset\n');
                break;

            case 'tools':
                // The direct-call catalogue, with the `.env`-aware availability
                // hints; deliberately not `harness.executeCommand('/tools')`.
                host.printTools();
                break;

            case 'presets':
                host.printPresets();
                break;
        }

        return true;
    }

    // Everything else is the harness registry's: built-ins, preset commands, and
    // plugin additions all resolve to one implementation per name.
    try {
        writeResult(host, await host.harness.executeCommand(parsed.input));
    } catch (error) {
        const message = messageOf(error);

        // `executeCommand` throws HarnessError for an unregistered name
        // (`unknown command: /nope`, and `unknown command: /` for a bare slash).
        // That is an operator typo, not a crash: the REPL survives, and the hint
        // points at the listing. A command implementation that throws lands here
        // too, prefixed so the operator can tell the two apart.
        if (message.includes('unknown command')) {
            host.writeError(`${message}\nhint: /help lists the commands this session can run\n`);
        } else {
            host.writeError(`command failed: ${message}\n`);
        }
    }

    return true;
};
