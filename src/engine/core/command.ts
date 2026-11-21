// Slash-command parsing — the ONE tokenizer every command surface shares.
//
// WHY A SEPARATE MODULE
// --------------------
// A slash line arrives from a CLI, from the HTTP server, or from the UI composer.
// If each of those split the line its own way, the same input would mean different
// things in different places, and a command could never be re-run by hand with
// confidence. So the harness owns the grammar (core/command.ts) and every host
// calls it. The result is the only thing a command implementation ever sees.
//
// This module is deliberately PURE: it knows nothing about the harness, the model,
// or a transport. It turns text into structure and validates a name. That is what
// makes it testable in isolation, and what keeps the browser build free of any
// Node-only import (../harness.ts owns the registry itself).
//
// WHAT A COMMAND IS NOT
// --------------------
// A command is an OPERATOR action, not a prompt. It is never sent to the model and
// it is not schema-validated like a tool call; the tokenized line is the contract.
// A built-in may still call a tool internally (`harness.executeTool('task', {})`),
// which is how /task, /websearch and /webfetch reuse the real implementations.
//
// Cross-references:
//   - ../types            — HarnessCommand, HarnessCommandContext, HarnessCommandResult
//   - ./command-builtins  — the built-in set registered by harness()
//   - ../harness.ts       — the registry, executeCommand(), plugin addCommand()

import { HarnessError } from '../util';
import type { HarnessCommand } from '../types';

// Registry-key grammar. The pattern IS the rule (checked at registration and by
// tests): one lowercase letter, then up to 31 lowercase letters, digits, or "-".
// "-" rather than "_" matches the package's tool/agent naming freedom while the
// strict lowercase set keeps ONE canonical spelling per name: `/Task` and `/task`
// cannot both exist and disagree about which is right.
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

// One parsed slash line. `name` is the lookup key, `args` is the structured
// argument list, `rest` is the verbatim (trimmed) tail for free-form commands,
// and `input` keeps the original line for echoing/logging.
export type ParsedCommand = {
    name: string;
    args: readonly string[];
    rest: string;
    input: string;
};

// Case/shape canonicalization used by BOTH registration and lookup, so a caller
// may write `/Task`, `task`, or `TASK` anywhere and still hit one entry. Never
// throws: an invalid result simply fails the lookup (or, at registration, the
// pattern check in validateCommandName).
export const normalizeCommandName = (name: string): string =>
    String(name ?? '')
        .trim()
        .replace(/^\//, '')
        .trim()
        .toLowerCase();

// Validate a name for REGISTRATION. The registry key must already be canonical,
// otherwise `commands` would carry two spellings of one command and a frozen
// record could not be compared. Trims whitespace and an optional leading slash
// first so `'/Task '` registers as `task` instead of failing on cosmetics.
export const validateCommandName = (name: string): string => {
    const normalized = normalizeCommandName(name);

    if (!COMMAND_NAME_PATTERN.test(normalized)) {
        throw new HarnessError(
            `Command name "${String(name)}" is not valid: use 1-32 characters starting with a lowercase letter, and only lowercase letters, digits, or "-".`
        );
    }

    return normalized;
};

// Split the tail of a slash line into arguments.
//
// Rules (the shell-ish minimum, and the whole contract):
//   - whitespace separates tokens;
//   - `"..."` and `'...'` group text, so `/task add "fix: the build"` is ONE
//     argument even though it contains a space;
//   - `\` escapes the next character INSIDE and outside quotes, so a literal
//     quote or backslash is reachable (`/task add say \"hi\"`);
//   - an explicit `""` is an empty argument, NOT a missing one — a command that
//     takes a value must be able to tell "the operator passed nothing" from
//     "the operator passed an empty string";
//   - an UNMATCHED quote consumes the rest of the input rather than throwing:
//     the operator is mid-edit in a REPL, and a parse exception there is worse
//     than one long argument;
//   - argument CASE is preserved (only the command name is folded), because task
//     text and search queries are data the model and the user must see verbatim.
//
// A trailing `\` with nothing to escape keeps the backslash itself: dropping it
// would silently change the token the operator typed.
const tokenize = (text: string): string[] => {
    const tokens: string[] = [];
    let token = '';
    // Tracks "a token has started" separately from `token.length`, which is how
    // an empty quoted token survives: `""` starts a token and ends it empty.
    let started = false;
    let quote: string | undefined;
    let index = 0;

    while (index < text.length) {
        const character = text[index] as string;

        // Escape: consume the next character literally, whatever it is (including
        // a space or a quote). Inside a quoted group the group stays open.
        if (character === '\\') {
            const next = text[index + 1];

            if (next === undefined) {
                token += character;
                index += 1;
            } else {
                token += next;
                index += 2;
            }

            started = true;
            continue;
        }

        if (quote !== undefined) {
            if (character === quote) quote = undefined;
            else token += character;
            index += 1;
            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
            started = true;
            index += 1;
            continue;
        }

        if (/\s/.test(character)) {
            if (started) {
                tokens.push(token);
                token = '';
                started = false;
            }

            index += 1;
            continue;
        }

        token += character;
        started = true;
        index += 1;
    }

    // An unterminated quote falls out here with everything it consumed.
    if (started) tokens.push(token);

    return tokens;
};

// Parse one slash line.
//
// Returns `undefined` when the line is NOT a command (the trimmed text does not
// start with "/"), which is how a host decides "send this to the model" instead
// of "run this here". A bare "/" is a command-shaped line with an EMPTY name: the
// caller's lookup misses and it reports an unknown command, which is a better
// answer than pretending the operator never typed a slash.
//
// The name is the first whitespace-delimited run after the slash, lowercased and
// stripped of its slash. It is NOT unquoted or escape-resolved: only the
// arguments are, because a name has to be spellable without quoting.
export const parseCommandLine = (input: string): ParsedCommand | undefined => {
    if (typeof input !== 'string') return undefined;

    const trimmed = input.trim();

    if (!trimmed.startsWith('/')) return undefined;

    const body = trimmed.slice(1);
    const match = /^[^\s]*/.exec(body);
    const rawName = match?.[0] ?? '';
    const rest = body.slice(rawName.length).trim();

    return {
        name: rawName.toLowerCase(),
        args: tokenize(rest),
        rest,
        input
    };
};

// Render the command inventory for /help.
//
// STABLE on purpose: keys are sorted with the default (code-unit) comparator and
// the layout is fixed, so /help output is diffable in a test and a host can print
// it without post-processing. Each entry is `/<name>  <description>`, with an
// indented `usage: ` line after it when the command declares one.
export const formatCommandHelp = (
    commands: Readonly<Record<string, HarnessCommand>>
): string => {
    const names = Object.keys(commands ?? {}).sort();

    if (names.length === 0) return 'No commands are registered.';

    const lines: string[] = [];

    for (const name of names) {
        const command = commands[name] as HarnessCommand;
        lines.push(`/${name}  ${command.description}`);

        if (command.usage !== undefined) {
            lines.push(`  usage: ${command.usage}`);
        }
    }

    return lines.join('\n');
};
