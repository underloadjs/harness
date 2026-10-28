// syntaxCheck — parse without executing, for JavaScript and Python (R2).
//
// What this pins, exactly:
//   - the boolean verdicts for both languages (true valid, false invalid);
//   - Python is checked by a real interpreter through an ASYNC API: checkPython
//     returns a Promise, not a synchronous spawnSync result;
//   - a missing interpreter is a SETUP error (HarnessError), never `false` — a
//     model must be able to tell "your code is wrong" from "the checker is not
//     installed";
//   - an already-aborted signal cancels a Python check before any child starts;
//   - an unknown language is rejected rather than guessed.
//
// The setup-error case isolates the interpreter lookup by clearing PATH and
// re-importing the python module (its probe cache is module-local), then restores
// PATH. The verdict cases need a Python 3 interpreter on PATH, exactly like the
// preset tests.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { syntaxCheck } from './syntaxCheck';
import { checkJavaScript } from './javascript';
import { checkPython, PYTHON_CHECK_SCRIPT, PYTHON_CHECK_TIMEOUT_MS } from './python';
import { HarnessError } from '../../util';

const ORIGINAL_PATH = process.env.PATH;

// Locate the interpreter the same way python.ts does, for the exit-code protocol
// test below (which drives the helper script directly so invalid UTF-8 bytes can
// be fed to it — a string argument cannot carry them).
const findInterpreter = (): string => {
    for (const candidate of ['python3', 'python']) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });

        if (!probe.error && probe.status === 0) return candidate;
    }

    throw new Error('syntaxCheck tests require a Python 3 interpreter on PATH.');
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

describe('syntaxCheck', () => {
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

    it('returns exact JavaScript verdicts', async () => {
        await expect(
            syntaxCheck({ code: 'const a = 1; function f() { return a + 1; }', language: 'javascript' })
        ).resolves.toBe(true);
        await expect(syntaxCheck({ code: 'const = ;', language: 'javascript' })).resolves.toBe(false);
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
        await expect(
            syntaxCheck({ code: 'x = 1\nprint(x)', language: 'python' })
        ).resolves.toBe(true);
        await expect(
            syntaxCheck({ code: 'if True print(1)', language: 'python' })
        ).resolves.toBe(false);
    });

    it('checks non-ASCII Python source without a locale decode failure', async () => {
        // Windows pipes decode with the locale codec (cp1252) by default, so these
        // valid sources used to come back as `false`. stdin is now decoded as
        // UTF-8 explicitly, independent of the host locale.
        await expect(checkPython('x = "😁"\n')).resolves.toBe(true);
        await expect(checkPython('x = "café"\n')).resolves.toBe(true);
        await expect(checkPython('# 😁\nx = 1\n')).resolves.toBe(true);
        await expect(syntaxCheck({ code: 'x = "😁"\n', language: 'python' })).resolves.toBe(true);
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
        await expect(
            checkPython('x = 1', aborted)
        ).rejects.toThrow(new HarnessError('syntaxCheck Python check was cancelled before it started.'));
    });

    it('rejects an unsupported language instead of returning a verdict', async () => {
        await expect(
            syntaxCheck({ code: 'puts 1', language: 'ruby' as never })
        ).rejects.toThrow(
            new HarnessError(
                'syntaxCheck requires language to be "javascript" or "python"; received "ruby".'
            )
        );
    });

    it('checks JavaScript without loading a process', () => {
        // The JavaScript half is pure: no child process, no PATH dependency.
        expect(checkJavaScript('const a = 1;')).toBe(true);
        expect(checkJavaScript('const = ;')).toBe(false);
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
                    'syntaxCheck requires a Python 3 interpreter on PATH (tried: python3, python).'
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
