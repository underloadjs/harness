// Syntax tools: parse a snippet without running it.
//
// Both return a boolean, which is the whole point of the preset family — a tool
// defines its own result type, and a syntax check's answer is yes or no.
//
// Neither tool executes user code:
//   - javascriptSyntax compiles with node:vm's Script, which parses and never
//     evaluates. Classic scripts only: import/export and top-level await are
//     module syntax and will report false.
//   - pythonSyntax pipes the source to `compile()` through the interpreter,
//     which also parses without evaluating. Requires a Python 3 interpreter on
//     PATH; the lookup is cached after the first call.
//
// Both are executable on their own and registerable on a harness:
//
//     await javascriptSyntax('const a = 1;');        // true
//     harness({ tools: { javascriptSyntax } });

import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { tool } from '../core';
import { HarnessError } from '../util';

// ---------------------------------------------------------------------------
// JavaScript / classic script syntax
// ---------------------------------------------------------------------------

export const javascriptSyntax = tool<string, boolean>({
    name: 'javascriptSyntax',
    description:
        'Check whether a JavaScript snippet parses as a classic script. Returns true when the syntax is valid, false otherwise. Does not execute the code, and does not support ES module syntax (import/export) or top-level await.',
    parameters: {
        type: 'object',
        properties: {
            code: { type: 'string', description: 'JavaScript source to check.' }
        },
        required: ['code'],
        additionalProperties: false
    },
    execute: ({ parameters: code }) => {
        try {
            // Compiling (not running) is the cheapest honest syntax check: it
            // parses exactly what V8 would parse.
            new Script(code);
            return true;
        } catch {
            return false;
        }
    }
});

// ---------------------------------------------------------------------------
// Python syntax
// ---------------------------------------------------------------------------

// Interpreter candidates, in preference order. `python3` is the POSIX name;
// `python` is the Windows one. The Windows Store `python3` shim exists but exits
// non-zero, so the probe checks the exit status, not just that spawn succeeded.
const PYTHON_CANDIDATES = ['python3', 'python'] as const;

// Parses only: `compile()` turns source into a code object without running it.
// Reading from stdin keeps the code out of the command line, where quoting and
// argument-length limits would otherwise bite.
const PYTHON_CHECK_SCRIPT = [
    'import sys',
    'source = sys.stdin.read()',
    'compile(source, "<harness>", "exec")'
].join('\n');

// undefined = not probed yet; null = probed and absent.
let pythonInterpreter: string | null | undefined;

const findPython = (): string | null => {
    if (pythonInterpreter !== undefined) return pythonInterpreter;

    pythonInterpreter = null;
    for (const candidate of PYTHON_CANDIDATES) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
        if (!probe.error && probe.status === 0) {
            pythonInterpreter = candidate;
            break;
        }
    }

    return pythonInterpreter;
};

export const pythonSyntax = tool<string, boolean>({
    name: 'pythonSyntax',
    description:
        'Check whether a Python snippet parses. Returns true when the syntax is valid, false otherwise. Does not execute the code.',
    parameters: {
        type: 'object',
        properties: {
            code: { type: 'string', description: 'Python source to check.' }
        },
        required: ['code'],
        additionalProperties: false
    },
    execute: ({ parameters: code }) => {
        const interpreter = findPython();

        // A missing interpreter is a setup problem, not a syntax verdict.
        // Throwing keeps "false" meaning "your code is wrong".
        if (!interpreter) {
            throw new HarnessError(
                'pythonSyntax requires a Python 3 interpreter on PATH (tried: python3, python).'
            );
        }

        const result = spawnSync(interpreter, ['-c', PYTHON_CHECK_SCRIPT], {
            input: code,
            encoding: 'utf8'
        });

        return result.status === 0;
    }
});
