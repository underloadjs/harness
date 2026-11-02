// syntax — parse without executing, for every language this package has a parser for.
//
// This file is the renamed half of `syntaxCheck` (R1/R3). What it pins:
//   - the tool is named `syntax` and its schema keeps `{ code, language } -> boolean`;
//   - `language` is a validated FREE string (no schema `enum`), so an unsupported
//     name is an ERROR that lists the supported set — never a `true`/`false` verdict
//     the model can act on;
//   - the supported set is javascript (+ js/ecmascript), typescript (+ ts), tsx, jsx,
//     json, python (+ py/python3/py3); names are trimmed, casefolded and may carry a
//     leading dot, so ".TS" and " ts " resolve the same as "typescript";
//   - exact verdicts per language, including the deliberate limits: JavaScript is a
//     CLASSIC script (import/export and top-level await parse false), the TypeScript
//     family reports SYNTAX diagnostics only (a type error is still true), JSX needs
//     the tsx/jsx dialect, and JSON is strict RFC 8259 (comments/trailing commas are
//     false) while a leading BOM is ignored;
//   - Python runs through an ASYNC, bounded child process; a missing interpreter, a
//     cancelled check and a non-string `code` are errors, never `false`;
//   - the exported language table, the runtime error text and the published schema
//     description all agree, so the docs cannot drift from the parser set.
//
// The setup-error case isolates the interpreter lookup by clearing PATH and
// re-importing the python module (its probe cache is module-local), then restores
// PATH. The Python verdict cases need a Python 3 interpreter on PATH, exactly like
// the preset tests.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
    SYNTAX_LANGUAGES,
    SYNTAX_LANGUAGE_SUMMARY,
    SYNTAX_METADATA,
    syntax
} from './syntax.tool';
import { checkJavaScript } from './javascript';
import { checkTypeScript } from './typescript';
import { checkJson } from './json';
import { checkPython, PYTHON_CHECK_SCRIPT, PYTHON_CHECK_TIMEOUT_MS } from './python';
import { HarnessError } from '../../util';

const ORIGINAL_PATH = process.env.PATH;

// The exact text a caller sees for a language with no parser here. Written out (not
// interpolated from SYNTAX_LANGUAGE_SUMMARY) so a change to the support list has to be
// a deliberate edit in two places: the table and this published message.
const UNSUPPORTED_MESSAGE = (received: string): string =>
    `syntax supports ${SYNTAX_LANGUAGE_SUMMARY}; received "${received}". A language outside that list has no parser here, so it is reported as an error rather than answered with a syntax verdict.`;

// Locate the interpreter the same way python.ts does, for the exit-code protocol
// test below (which drives the helper script directly so invalid UTF-8 bytes can
// be fed to it — a string argument cannot carry them).
const findInterpreter = (): string => {
    for (const candidate of ['python3', 'python']) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });

        if (!probe.error && probe.status === 0) return candidate;
    }

    throw new Error('syntax tests require a Python 3 interpreter on PATH.');
};

// Run the helper script with raw stdin bytes and return its exit code.
const scriptExitCode = (stdin: Buffer): Promise<number> =>
    new Promise<number>((resolve, reject) => {
        const child = spawn(findInterpreter(), ['-X', 'utf8', '-c', PYTHON_CHECK_SCRIPT], {
            stdio: ['pipe', 'ignore', 'ignore']
        });

        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? -1));
        child.stdin?.end(stdin);
    });

describe('syntax', () => {
    let aborted: AbortSignal;

    beforeAll(() => {
        // A signal that was cancelled before the call: no interpreter should run.
        const controller = new AbortController();
        controller.abort();
        aborted = controller.signal;
    });

    afterAll(() => {
        // The setup-error test rewrites PATH; restore it for other files.
        process.env.PATH = ORIGINAL_PATH;
    });

    it('publishes the renamed tool with the unchanged two-property contract', () => {
        // R1: the wire name is `syntax`; the historical TS type names survive, and
        // nothing here still carries the old name.
        expect(SYNTAX_METADATA.name).toBe('syntax');
        expect(syntax.name).toBe('syntax');

        // R3: the contract stays `{ code, language } -> boolean`. Two properties, so
        // execute receives the whole object; `language` has NO enum, because the
        // contract is "unsupported name -> error", not "unsupported name -> schema
        // rejection".
        expect(SYNTAX_METADATA.parameters).toEqual({
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Source code to check.' },
                language: {
                    type: 'string',
                    minLength: 1,
                    description:
                        'Language to parse the snippet as. Parsers exist for javascript (js), typescript (ts), tsx, jsx, json, python (py, python3); an alias is matched case-insensitively and a leading dot is allowed. Any other name is an error.'
                }
            },
            required: ['code', 'language'],
            additionalProperties: false
        });

        // Registration is unchanged by the rename: same searchable slot and order, so
        // discovery order does not move.
        expect(SYNTAX_METADATA.visibility).toBeUndefined();
    });

    it('keeps one language table for the tool, its errors and its documentation', () => {
        // The single source of truth a model reads is the description; the runtime
        // error and the alias table are derived from the same list. Asserting the
        // three agree is what stops docs and parsers drifting apart (R4).
        expect(SYNTAX_LANGUAGES).toEqual(['javascript', 'typescript', 'tsx', 'jsx', 'json', 'python']);
        expect(SYNTAX_LANGUAGE_SUMMARY).toBe(
            'javascript (js), typescript (ts), tsx, jsx, json, python (py, python3)'
        );

        for (const language of SYNTAX_LANGUAGES) {
            expect(SYNTAX_METADATA.description).toContain(`"${language}"`);
        }

        // The Python half used to be the only interpreter-backed language; the docs
        // still have to say the interpreter is required.
        expect(SYNTAX_METADATA.description).toContain('CPython 3');
    });

    it('returns exact JavaScript verdicts', async () => {
        await expect(
            syntax({ code: 'const a = 1; function f() { return a + 1; }', language: 'javascript' })
        ).resolves.toBe(true);
        await expect(syntax({ code: 'const = ;', language: 'javascript' })).resolves.toBe(false);
    });

    it('parses JavaScript as a classic script only', async () => {
        // Unchanged by the rename: node:vm compiles a Script, so module syntax and
        // top-level await are parse errors here. A caller who means "a module" uses
        // typescript, which accepts them.
        await expect(
            syntax({ code: "import fs from 'node:fs';\nexport const a = fs;", language: 'javascript' })
        ).resolves.toBe(false);
        await expect(syntax({ code: 'await fetch("x");', language: 'javascript' })).resolves.toBe(false);
    });

    it('parses TypeScript syntax without type checking', async () => {
        await expect(
            syntax({
                code: 'const a: number = 1; function f(x: number): number { return x + a; }',
                language: 'typescript'
            })
        ).resolves.toBe(true);

        // Modules and enums parse (unlike the classic-script JavaScript half).
        await expect(
            syntax({
                code: "import * as fs from 'node:fs';\nexport const a: number = 1;",
                language: 'typescript'
            })
        ).resolves.toBe(true);
        await expect(
            syntax({ code: 'enum E { A, B }\nconst e: E = E.A;', language: 'typescript' })
        ).resolves.toBe(true);

        await expect(syntax({ code: 'const = ;', language: 'typescript' })).resolves.toBe(false);

        // A TYPE error is not a syntax error: transpileModule reports syntax
        // diagnostics only, so this is true by contract, not by accident.
        await expect(
            syntax({ code: 'const x: number = "s";', language: 'typescript' })
        ).resolves.toBe(true);
    });

    it('parses JSX only in the tsx and jsx dialects', async () => {
        // The dialect is chosen by the language NAME, because that is how the compiler
        // picks a ScriptKind. `<div/>` in .ts is a type assertion with no expression.
        await expect(
            syntax({ code: 'const el = <div className="x" />;', language: 'typescript' })
        ).resolves.toBe(false);
        await expect(
            syntax({ code: 'const el = <div className="x" />;', language: 'tsx' })
        ).resolves.toBe(true);
        await expect(
            syntax({ code: 'const el: number = <div>{1}</div>;', language: 'tsx' })
        ).resolves.toBe(true);
        await expect(
            syntax({ code: 'export const El = () => <div>hi</div>;', language: 'jsx' })
        ).resolves.toBe(true);
        await expect(
            syntax({ code: 'const el = <div>;', language: 'tsx' })
        ).resolves.toBe(false);

        // .jsx has no TypeScript grammar, so an annotation is a parse error there.
        await expect(
            syntax({ code: 'const x: number = 1;', language: 'jsx' })
        ).resolves.toBe(false);
    });

    it('validates JSON strictly and ignores one leading byte-order mark', async () => {
        await expect(syntax({ code: '{"a":1,"b":[1,2,3]}', language: 'json' })).resolves.toBe(true);
        await expect(syntax({ code: '[1, 2, 3]', language: 'json' })).resolves.toBe(true);

        // JSONC conveniences and multi-value documents are verdicts, not errors.
        await expect(syntax({ code: '{ /*c*/ "a": 1 }', language: 'json' })).resolves.toBe(false);
        await expect(syntax({ code: "{'a': 1}", language: 'json' })).resolves.toBe(false);
        await expect(syntax({ code: '{"a":1,}', language: 'json' })).resolves.toBe(false);
        await expect(syntax({ code: '{"a":1} {"b":2}', language: 'json' })).resolves.toBe(false);

        // One leading BOM is allowed (the ts/tsx/jsx half ignores it too).
        await expect(syntax({ code: '\uFEFF{"a":1}', language: 'json' })).resolves.toBe(true);
    });

    it('returns exact Python verdicts through an async checker', async () => {
        // Async API: the old spawnSync path returned a bare boolean and blocked
        // the event loop for the whole interpreter run.
        const pending = checkPython('def f(x):\n    return x + 1');

        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).resolves.toBe(true);

        await expect(checkPython('def f(x) return x')).resolves.toBe(false);
    });

    it('checks Python through the tool with the same boolean contract', async () => {
        await expect(syntax({ code: 'x = 1\nprint(x)', language: 'python' })).resolves.toBe(true);
        await expect(syntax({ code: 'if True print(1)', language: 'python' })).resolves.toBe(false);
    });

    it('checks non-ASCII Python source without a locale decode failure', async () => {
        // Windows pipes decode with the locale codec (cp1252) by default, so these
        // valid sources used to come back as `false`. stdin is now decoded as
        // UTF-8 explicitly, independent of the host locale.
        await expect(checkPython('x = "😁"\n')).resolves.toBe(true);
        await expect(checkPython('x = "café"\n')).resolves.toBe(true);
        await expect(checkPython('# 😁\nx = 1\n')).resolves.toBe(true);
        await expect(syntax({ code: 'x = "😁"\n', language: 'python' })).resolves.toBe(true);
    });

    it('classifies only a compile SyntaxError as false (exit-code protocol)', async () => {
        // The helper script is the verdict boundary: 0 valid, 1 SyntaxError, 2 any
        // other failure. Invalid UTF-8 can only be fed as raw bytes, so this drives
        // the script directly rather than checkPython (which takes a string).
        expect(await scriptExitCode(Buffer.from('x = 1\n', 'utf8'))).toBe(0);
        expect(await scriptExitCode(Buffer.from('x = "😁"\n', 'utf8'))).toBe(0);
        expect(await scriptExitCode(Buffer.from('def f(x) return x\n', 'utf8'))).toBe(1);
        // 0xFF is not a valid UTF-8 start byte: a decode failure, not a verdict.
        expect(await scriptExitCode(Buffer.from([0xff, 0xfe]))).toBe(2);
    });

    it('cancels a Python check when the signal is already aborted', async () => {
        await expect(checkPython('x = 1', aborted)).rejects.toThrow(
            new HarnessError('syntax Python check was cancelled before it started.')
        );
    });

    it('accepts every documented alias, trimmed and case-folded', async () => {
        // R3: `language` is a NAME and callers spell names loosely. Each of these
        // resolves to a real parser, and the verdict is the parser's own.
        const moduleSource = "import fs from 'node:fs';\nexport const a = fs;";

        await expect(syntax({ code: 'const a = 1;', language: 'JS' })).resolves.toBe(true);
        await expect(syntax({ code: 'const a = 1;', language: ' ecmascript ' })).resolves.toBe(true);
        await expect(syntax({ code: moduleSource, language: 'TS' })).resolves.toBe(true);
        await expect(syntax({ code: moduleSource, language: '.ts' })).resolves.toBe(true);
        await expect(syntax({ code: moduleSource, language: 'TypeScript' })).resolves.toBe(true);
        await expect(syntax({ code: 'const el = <div />;', language: '.TSX' })).resolves.toBe(true);
        await expect(syntax({ code: 'x = 1', language: 'py' })).resolves.toBe(true);
        await expect(syntax({ code: 'x = 1', language: 'python3' })).resolves.toBe(true);
        await expect(syntax({ code: 'x = 1', language: 'PY3' })).resolves.toBe(true);
    });

    it('rejects an unsupported language with the supported set instead of a verdict', async () => {
        // R3: "never false validity" — a language with no parser here must not be
        // answered with true OR false, so both become an error naming the table.
        await expect(syntax({ code: 'puts 1', language: 'ruby' })).rejects.toThrow(
            new HarnessError(UNSUPPORTED_MESSAGE('ruby'))
        );
        await expect(syntax({ code: 'package main', language: 'go' })).rejects.toThrow(
            UNSUPPORTED_MESSAGE('go')
        );

        // A whitespace-padded unsupported name is still unsupported: normalization is
        // for spelling, not for inventing parsers. The message echoes what the caller
        // actually SENT (raw), so padding shows up in the echo.
        await expect(syntax({ code: 'x = 1', language: '  Rust  ' })).rejects.toThrow(
            UNSUPPORTED_MESSAGE('  Rust  ')
        );

        // No language at all is the same caller mistake.
        await expect(
            syntax({ code: 'x = 1', language: undefined as never })
        ).rejects.toThrow(UNSUPPORTED_MESSAGE('undefined'));
        await expect(syntax({ code: 'x = 1' } as never)).rejects.toThrow(
            UNSUPPORTED_MESSAGE('undefined')
        );
    });

    it('rejects a non-string code instead of reporting a verdict', async () => {
        // Without this, `code: 7` would reach node:vm and come back as a misleading
        // `false` about source text that was never source text.
        await expect(syntax({ code: 7 as never, language: 'javascript' })).rejects.toThrow(
            new HarnessError('syntax code must be a string; received "7".')
        );
        await expect(
            syntax({ code: undefined as never, language: 'json' })
        ).rejects.toThrow('syntax code must be a string; received "undefined".');
    });

    it('checks JavaScript without loading a process', () => {
        // The JavaScript half is pure: no child process, no PATH dependency.
        expect(checkJavaScript('const a = 1;')).toBe(true);
        expect(checkJavaScript('const = ;')).toBe(false);
    });

    it('exposes the language halves as directly callable parsers', async () => {
        // Each checker is its own module so the dispatch can lazy-load it; a test can
        // therefore pin the dialect switch without going through the tool.
        expect(checkJson('{"a":1}')).toBe(true);
        await expect(checkTypeScript('const a: number = 1;', 'typescript')).resolves.toBe(true);
        await expect(checkTypeScript('const el = <div />;', 'tsx')).resolves.toBe(true);
        await expect(checkTypeScript('const el = <div />;', 'typescript')).resolves.toBe(false);
    });

    it('reports a missing Python interpreter as a setup error, not false', async () => {
        // Clear PATH so neither candidate resolves, and reset the module graph so
        // python.ts probes again instead of reusing its cached interpreter.
        process.env.PATH = '';

        try {
            vi.resetModules();
            const fresh = await import('./python');

            await expect(fresh.checkPython('x = 1')).rejects.toThrow(
                new HarnessError(
                    'syntax requires a Python 3 interpreter on PATH (tried: python3, python).'
                )
            );
        } finally {
            process.env.PATH = ORIGINAL_PATH;
        }
    });

    it('exposes a bounded Python check timeout', () => {
        expect(PYTHON_CHECK_TIMEOUT_MS).toBe(10_000);
    });
});
