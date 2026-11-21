// Slash-command parsing (core/command.ts) — the grammar every host shares.
//
// What is pinned here, all of it derived from the documented rules (not from
// whatever the implementation happened to print):
//   - a line is a command ONLY when the trimmed text starts with "/";
//   - the name is the first run after the slash, lowercased and slash-stripped,
//     and argument CASE is preserved (only the name is folded);
//   - quotes group text, backslash escapes the next character inside and outside
//     quotes, an explicit `""` is an empty ARGUMENT, and an unmatched quote
//     consumes to end of input instead of throwing;
//   - COMMAND_NAME_PATTERN / validateCommandName are the single name rule, and
//     formatCommandHelp is sorted and stable.
//
// Cross-references:
//   - ./command.ts             — the implementation
//   - ../harness.commands.test.ts — the registry + built-ins on a real harness

import { describe, expect, it } from 'vitest';
import {
    COMMAND_NAME_PATTERN,
    formatCommandHelp,
    normalizeCommandName,
    parseCommandLine,
    validateCommandName
} from './command';
import type { HarnessCommand } from '../types';

// One parsed line as the parser documents it. `input` is the ORIGINAL string,
// verbatim, so a host can echo exactly what the operator typed.
const parsed = (
    name: string,
    args: readonly string[],
    rest: string,
    input: string
) => ({ name, args, rest, input });

const command = (name: string, description: string, usage?: string): HarnessCommand => ({
    name,
    description,
    ...(usage === undefined ? {} : { usage }),
    execute: () => ({ content: name })
});

describe('parseCommandLine', () => {
    it('returns undefined for anything that is not a slash line', () => {
        expect(parseCommandLine('')).toBeUndefined();
        expect(parseCommandLine('   ')).toBeUndefined();
        expect(parseCommandLine('hello')).toBeUndefined();
        // A backslash is not a command sigil, and a slash must be FIRST (after
        // trimming) — `/a/b` is one command named `a` with no args only when the
        // leading char is the slash; a trailing/mid slash stays inside the text.
        expect(parseCommandLine('\\task add')).toBeUndefined();
        expect(parseCommandLine('see /help please')).toBeUndefined();
    });

    it('extracts the name, lowercases it, and strips the leading slash', () => {
        expect(parseCommandLine('/help')).toEqual(parsed('help', [], '', '/help'));
        expect(parseCommandLine('/TASK')).toEqual(parsed('task', [], '', '/TASK'));
        expect(parseCommandLine('/Web-Search x')).toEqual(
            parsed('web-search', ['x'], 'x', '/Web-Search x')
        );
    });

    it('keeps the original line in `input` and the trimmed tail in `rest`', () => {
        const line = '   /tools   web  ';

        expect(parseCommandLine(line)).toEqual(parsed('tools', ['web'], 'web', line));
        // `rest` is the raw (trimmed) tail BEFORE tokenizing: free-form commands
        // (/websearch) need the operator's own quoting back.
        expect(parseCommandLine('/websearch "exact phrase"')).toEqual(
            parsed('websearch', ['exact phrase'], '"exact phrase"', '/websearch "exact phrase"')
        );
    });

    it('treats a bare slash as a command with an empty name', () => {
        // The lookup misses and the host reports "unknown command", which beats
        // pretending the operator never typed a slash at all.
        expect(parseCommandLine('/')).toEqual(parsed('', [], '', '/'));
        expect(parseCommandLine('  /  ')).toEqual(parsed('', [], '', '  /  '));
    });

    it('groups arguments with double and single quotes, preserving inner spacing', () => {
        expect(parseCommandLine('/task add "testing"')).toEqual(
            parsed('task', ['add', 'testing'], 'add "testing"', '/task add "testing"')
        );
        expect(parseCommandLine('/task add "a  b" \'c  d\'')).toEqual(
            parsed('task', ['add', 'a  b', 'c  d'], 'add "a  b" \'c  d\'', '/task add "a  b" \'c  d\'')
        );
    });

    it('resolves backslash escapes inside and outside quotes', () => {
        // An escaped space is data, not a separator.
        expect(parseCommandLine('/task add a\\ b')).toEqual(
            parsed('task', ['add', 'a b'], 'add a\\ b', '/task add a\\ b')
        );
        // An escaped quote is a literal quote character, and the group (if any)
        // stays open.
        expect(parseCommandLine('/x say \\"hi\\"')).toEqual(
            parsed('x', ['say', '"hi"'], 'say \\"hi\\"', '/x say \\"hi\\"')
        );
        expect(parseCommandLine('/x "a\\"b"')).toEqual(parsed('x', ['a"b'], '"a\\"b"', '/x "a\\"b"'));
        // An escaped backslash yields one backslash; a trailing backslash has
        // nothing to escape, so it survives rather than vanishing.
        expect(parseCommandLine('/x a\\\\b')).toEqual(parsed('x', ['a\\b'], 'a\\\\b', '/x a\\\\b'));
        expect(parseCommandLine('/x a\\')).toEqual(parsed('x', ['a\\'], 'a\\', '/x a\\'));
    });

    it('keeps an explicit empty quoted argument distinct from no argument', () => {
        expect(parseCommandLine('/x')).toEqual(parsed('x', [], '', '/x'));
        expect(parseCommandLine('/x ""')).toEqual(parsed('x', [''], '""', '/x ""'));
        expect(parseCommandLine('/x "" y')).toEqual(parsed('x', ['', 'y'], '"" y', '/x "" y'));
        expect(parseCommandLine('/x ""\t""')).toEqual(parsed('x', ['', ''], '""\t""', '/x ""\t""'));
    });

    it('consumes to end of input on an unmatched quote instead of throwing', () => {
        expect(parseCommandLine('/x "abc def')).toEqual(parsed('x', ['abc def'], '"abc def', '/x "abc def'));
        expect(parseCommandLine('/x \'abc')).toEqual(parsed('x', ['abc'], "'abc", '/x \'abc'));
    });

    it('separates on any whitespace and preserves argument case', () => {
        // A tab and a newline are separators like a space; only a QUOTED run keeps
        // its inner whitespace, and no argument is case-folded.
        expect(parseCommandLine('/task\tadd\n  Fix THE "Build NOW"')).toEqual(
            parsed(
                'task',
                ['add', 'Fix', 'THE', 'Build NOW'],
                'add\n  Fix THE "Build NOW"',
                '/task\tadd\n  Fix THE "Build NOW"'
            )
        );
    });
});

describe('command names', () => {
    it('COMMAND_NAME_PATTERN is one lowercase letter then letters, digits, or "-" up to 32 total', () => {
        expect(COMMAND_NAME_PATTERN.source).toBe('^[a-z][a-z0-9-]{0,31}$');
        expect(COMMAND_NAME_PATTERN.test('a')).toBe(true);
        expect(COMMAND_NAME_PATTERN.test('a-b')).toBe(true);
        expect(COMMAND_NAME_PATTERN.test('a--b')).toBe(true);
        expect(COMMAND_NAME_PATTERN.test('a1')).toBe(true);
        expect(COMMAND_NAME_PATTERN.test('a'.repeat(32))).toBe(true);
        expect(COMMAND_NAME_PATTERN.test('a'.repeat(33))).toBe(false);
        expect(COMMAND_NAME_PATTERN.test('')).toBe(false);
        expect(COMMAND_NAME_PATTERN.test('A')).toBe(false);
        expect(COMMAND_NAME_PATTERN.test('9x')).toBe(false);
        expect(COMMAND_NAME_PATTERN.test('-x')).toBe(false);
        expect(COMMAND_NAME_PATTERN.test('x_y')).toBe(false);
        expect(COMMAND_NAME_PATTERN.test('x y')).toBe(false);
    });

    it('normalizeCommandName canonicalizes without throwing', () => {
        expect(normalizeCommandName('/Task ')).toBe('task');
        expect(normalizeCommandName('TASK')).toBe('task');
        expect(normalizeCommandName('/')).toBe('');
        expect(normalizeCommandName('x_y')).toBe('x_y');
    });

    it('validateCommandName trims, strips the slash, lowercases, and validates', () => {
        expect(validateCommandName('task')).toBe('task');
        expect(validateCommandName('/Task ')).toBe('task');
        expect(validateCommandName('  WEB-Search  ')).toBe('web-search');
        expect(validateCommandName('a'.repeat(32))).toBe('a'.repeat(32));
    });

    it('validateCommandName rejects a name outside the pattern with the rule in the message', () => {
        const rule =
            'Command name "Bad Name!" is not valid: use 1-32 characters starting with a lowercase letter, and only lowercase letters, digits, or "-".';

        expect(() => validateCommandName('Bad Name!')).toThrow(rule);
        expect(() => validateCommandName('')).toThrow(
            'Command name "" is not valid: use 1-32 characters starting with a lowercase letter, and only lowercase letters, digits, or "-".'
        );
        expect(() => validateCommandName('/')).toThrow(rule.replace('Bad Name!', '/'));
        expect(() => validateCommandName('x_y')).toThrow(rule.replace('Bad Name!', 'x_y'));
        expect(() => validateCommandName('9x')).toThrow(rule.replace('Bad Name!', '9x'));
        expect(() => validateCommandName('a'.repeat(33))).toThrow(
            `Command name "${'a'.repeat(33)}" is not valid: use 1-32 characters starting with a lowercase letter, and only lowercase letters, digits, or "-".`
        );
    });
});

describe('formatCommandHelp', () => {
    it('lists sorted entries as `/<name>  <description>` with an indented usage line', () => {
        expect(
            formatCommandHelp({
                zulu: command('zulu', 'Last alphabetically.'),
                alpha: command('alpha', 'First.', '/alpha <x>'),
                mid: command('mid', 'In the middle.')
            })
        ).toBe(
            '/alpha  First.\n  usage: /alpha <x>\n/mid  In the middle.\n/zulu  Last alphabetically.'
        );
    });

    it('omits the usage line when the command declares none', () => {
        expect(formatCommandHelp({ solo: command('solo', 'Alone.') })).toBe('/solo  Alone.');
    });

    it('says so when nothing is registered', () => {
        expect(formatCommandHelp({})).toBe('No commands are registered.');
    });

    it('is stable for the same keys in any insertion order', () => {
        const left = { b: command('b', 'B.'), a: command('a', 'A.') };
        const right = { a: command('a', 'A.'), b: command('b', 'B.') };

        expect(formatCommandHelp(left)).toBe(formatCommandHelp(right));
        expect(formatCommandHelp(left)).toBe('/a  A.\n/b  B.');
    });
});
