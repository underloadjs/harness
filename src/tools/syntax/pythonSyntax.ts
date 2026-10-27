// pythonSyntax — parse a Python snippet without running it.
//
// Pipes the source to `compile()` through the interpreter, which also only parses.
// Requires a Python 3 interpreter on PATH; the lookup is cached after the first
// call.
//
// Executable on its own and registerable on a harness:
//
//     await pythonSyntax('def f():\n    pass');      // true
//     harness({ tools: { pythonSyntax } });

import { spawnSync } from 'node:child_process';
import { tool } from '../../core';
import { HarnessError } from '../../util';
import { PRESET_TOOLS } from '../catalogue';

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

// Metadata (name, description, tags, schema) lives in ../catalogue so the preset
// can be enumerated without importing this module — and so text can't drift.
export const pythonSyntax = tool<string, boolean>({
    ...PRESET_TOOLS.pythonSyntax,
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
