// Built-in command lookups (core/command-builtins.ts) — the registry surface /help
// reads, exercised WITHOUT a harness.
//
// WHY THIS FILE EXISTS (C8-m2)
// ----------------------------
// `/help <name>` resolved the name with a plain bracket read
// (`context.harness.commands[name]`), and `handle.commands` is an ordinary object, so
// the read walks the PROTOTYPE CHAIN. `/help constructor` therefore "found" Object's
// constructor and printed a command entry nobody registered; `/help __proto__` found
// `Object.prototype`. The dispatcher (`handle.executeCommand`, src/harness.ts line
// 7251) already guards this with `hasOwnProperty`, and COMMAND_NAME_PATTERN allows
// every lowercase prototype member (`constructor`, `toString`, `valueOf`), so the
// collision is reachable by typing one word.
//
// The contract pinned here is the one the rest of the command layer already documents:
// an unknown name is an ANSWER (`usageError`), never an exception and never an entry
// (src/core/command-builtins.ts lines 412-425, asserted verbatim for `/help zzz` in
// ../harness.commands.test.ts line 504).
//
// Cross-references:
//   - ./command-builtins.ts   — `createBuiltinCommands()` and `helpCommand`
//   - ./command.ts            — `formatCommandHelp` / `normalizeCommandName`
//   - ../harness.ts:7251      — the own-key lookup this brings /help in line with

import { describe, expect, it } from 'vitest';
import type { Harness, HarnessCommand, HarnessCommandContext, HarnessCommandResult } from '../types';
import { createBuiltinCommands } from './command-builtins';
import { formatCommandHelp } from './command';

const command = (name: string, description: string, usage: string): HarnessCommand => ({
    name,
    description,
    usage,
    execute: () => ({ content: name })
});

// The live registry shape: `handle.commands` copies AND freezes per read (see
// knowledge.md's command-registry notes), so the object /help sees is a frozen plain
// object — prototype chain included.
const registryOf = (entries: HarnessCommand[]): Record<string, HarnessCommand> =>
    Object.freeze(
        entries.reduce<Record<string, HarnessCommand>>((copy, entry) => {
            copy[entry.name] = entry;

            return copy;
        }, {})
    );

// Run `/help [target]` through the real built-in implementation.
const help = async (
    commands: HarnessCommand[],
    target?: string
): Promise<HarnessCommandResult> => {
    const [helpCommand] = createBuiltinCommands().filter((entry) => entry.name === 'help');
    const context = {
        harness: { commands: registryOf(commands) } as unknown as Harness,
        name: 'help',
        args: target === undefined ? [] : [target],
        rest: target === undefined ? '' : target,
        input: target === undefined ? '/help' : `/help ${target}`
    } satisfies HarnessCommandContext;

    return helpCommand.execute(context) as HarnessCommandResult;
};

const REGISTRY = [
    command('help', 'List the commands in this harness, or show one command.', '/help [command]'),
    command('task', 'Read and change this session\'s task list.', '/task <action> [args]')
];

describe('/help <name> lookup (C8-m2)', () => {
    it('lists the whole registry for a bare /help', async () => {
        expect(await help(REGISTRY)).toEqual({ content: formatCommandHelp(registryOf(REGISTRY)) });
    });

    it('shows a registered command, own-key hit unchanged', async () => {
        const [task] = REGISTRY.filter((entry) => entry.name === 'task');

        expect(await help(REGISTRY, 'task')).toEqual({ content: formatCommandHelp({ task }) });
        // Case and the optional slash are folded before the lookup, exactly as the
        // dispatcher does them.
        expect(await help(REGISTRY, '/TASK')).toEqual({ content: formatCommandHelp({ task }) });
    });

    it('answers an unknown name with the usage error other unknown targets get', async () => {
        expect(await help(REGISTRY, 'zzz')).toEqual({
            content: '/help: unknown command "/zzz".\nusage: /help [command]',
            isError: true
        });
    });

    it('does not invent an entry for an inherited Object member', async () => {
        // Every one of these is a real own property of `Object.prototype`, so a
        // bracket read returned a value and /help printed a plausible entry. The
        // reported name is the NORMALIZED one (parser folds case), so each expected
        // text is spelled out rather than derived from the loop variable.
        expect(await help(REGISTRY, 'constructor')).toEqual({
            content: '/help: unknown command "/constructor".\nusage: /help [command]',
            isError: true
        });
        expect(await help(REGISTRY, 'toString')).toEqual({
            content: '/help: unknown command "/tostring".\nusage: /help [command]',
            isError: true
        });
        expect(await help(REGISTRY, 'valueOf')).toEqual({
            content: '/help: unknown command "/valueof".\nusage: /help [command]',
            isError: true
        });
        expect(await help(REGISTRY, 'hasOwnProperty')).toEqual({
            content: '/help: unknown command "/hasownproperty".\nusage: /help [command]',
            isError: true
        });
    });

    it('does not invent an entry for the __proto__ accessor either', async () => {
        // `__proto__` is an ACCESSOR on Object.prototype, so the bracket read handed
        // back the prototype object itself.
        expect(await help(REGISTRY, '__proto__')).toEqual({
            content: '/help: unknown command "/__proto__".\nusage: /help [command]',
            isError: true
        });
    });

    it('still answers a known command when the registry also shadows a member name', async () => {
        // A host MAY register `/constructor` (the pattern allows it); then the
        // own-key hit is the operator's command, not the prototype's.
        const registered = command('constructor', 'Build something.', '/constructor <n>');

        expect(await help([...REGISTRY, registered], 'constructor')).toEqual({
            content: formatCommandHelp({ constructor: registered })
        });
    });
});
