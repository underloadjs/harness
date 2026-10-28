// Python half of syntaxCheck — parse a snippet without running it.
//
// Pipes the source to `compile()` through the interpreter, which also only parses.
// Requires a Python 3 interpreter on PATH; the lookup is cached after the first
// call. Loaded through `import()` by ./syntaxCheck only when the caller asks for
// language "python", so a JavaScript check never pays for node:child_process.
//
// Cross-references:
//   - ./syntaxCheck   — the public tool and its language dispatch
//   - ../catalogue    — metadata (name, description, tags, schema)

import { spawnSync } from 'node:child_process';
import { HarnessError } from '../../util';

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

// A missing interpreter is a setup problem, not a syntax verdict. Throwing keeps
// "false" meaning "your code is wrong"; the harness turns this into a readable
// tool result the model can recover from.
export const checkPython = (code: string): boolean => {
    const interpreter = findPython();

    if (!interpreter) {
        throw new HarnessError(
            'syntaxCheck requires a Python 3 interpreter on PATH (tried: python3, python).'
        );
    }

    const result = spawnSync(interpreter, ['-c', PYTHON_CHECK_SCRIPT], {
        input: code,
        encoding: 'utf8'
    });

    return result.status === 0;
};
